import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TrackerState, Milestone, Subtask, Agent, AgentLogEntry } from 'command-center-shared'

vi.mock('../../src/storage/tracker-file.js', () => ({
  readRaw: vi.fn(),
  writeAtomic: vi.fn(),
  withLock: vi.fn((fn: () => void) => fn()),
}))

vi.mock('../../src/storage/backup.js', () => ({
  createBackup: vi.fn(),
}))

vi.mock('../../src/storage/log-rotation.js', () => ({
  rotateAgentLog: vi.fn(() => ({ active: [], rotated: 0 })),
}))

vi.mock('../../src/services/migration.service.js', () => ({
  runMigrations: vi.fn((s: TrackerState) => s),
}))

import { readRaw, writeAtomic, withLock } from '../../src/storage/tracker-file.js'
import { createBackup } from '../../src/storage/backup.js'
import { rotateAgentLog } from '../../src/storage/log-rotation.js'
import { runMigrations } from '../../src/services/migration.service.js'

import {
  readTracker,
  writeTracker,
  computeScheduleStatus,
  computeOverallProgress,
  findTask,
  getMilestoneById,
  getActiveMilestoneById,
  touchAgent,
  pushLog,
  pushHistory,
  autoUnblockDependents,
  countRevisions,
  generateTaskId,
  ok,
  fail,
} from '../../src/services/tracker.service.js'

function makeState(overrides: Partial<TrackerState> = {}): TrackerState {
  return {
    project: {
      name: 'test',
      start_date: '2026-01-01',
      target_date: '2026-06-30',
      current_week: 1,
      schedule_status: 'on_track',
      overall_progress: 0,
    },
    milestones: {
      active: [],
      backlog: [],
      completed: [],
    },
    ...overrides,
  } as TrackerState
}

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 't_001',
    label: 'test task',
    status: 'todo',
    assignee: null,
    blocked_by: null,
    blocked_reason: null,
    completed_at: null,
    completed_by: null,
    priority: 'P2',
    notes: null,
    prompt: null,
    context_files: [],
    reference_docs: [],
    acceptance_criteria: [],
    constraints: [],
    agent_target: null,
    execution_mode: 'human',
    depends_on: [],
    last_run_id: null,
    builder_prompt: null,
    ...overrides,
  } as Subtask
}

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm_test',
    title: 'Test Milestone',
    domain: 'dev',
    week: 1,
    phase: 'Foundation',
    planned_start: '2026-01-01',
    planned_end: '2026-01-07',
    actual_start: null,
    actual_end: null,
    drift_days: 0,
    is_key_milestone: false,
    key_milestone_label: null,
    subtasks: [],
    dependencies: [],
    notes: [],
    ...overrides,
  } as Milestone
}

describe('readTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads, parses, validates, and migrates tracker state', () => {
    const state = makeState()
    vi.mocked(readRaw).mockReturnValue(JSON.stringify(state))

    const result = readTracker()

    expect(readRaw).toHaveBeenCalledOnce()
    expect(runMigrations).toHaveBeenCalledWith(result)
    expect(result.project.name).toBe('test')
  })

  it('throws on invalid JSON', () => {
    vi.mocked(readRaw).mockReturnValue('not json')
    expect(() => readTracker()).toThrow()
  })

  it('throws when schema validation fails', () => {
    vi.mocked(readRaw).mockReturnValue(JSON.stringify({ project: {} }))
    expect(() => readTracker()).toThrow()
  })
})

describe('writeTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes state with computed progress and status', () => {
    const state = makeState({
      milestones: {
        active: [
          makeMilestone({
            subtasks: [makeSubtask({ id: 'a', status: 'done' }), makeSubtask({ id: 'b', status: 'todo' })],
          }),
        ],
        backlog: [],
        completed: [],
      },
    })

    writeTracker(state)

    expect(withLock).toHaveBeenCalled()
    expect(createBackup).toHaveBeenCalledWith('write')
    expect(state.project.overall_progress).toBe(50)
    expect(state.project.schedule_status).toBe('on_track')
    expect(writeAtomic).toHaveBeenCalled()
  })

  it('rotates agent log when it exceeds 500 entries', () => {
    const logEntries = Array.from({ length: 501 }, (_, i) => ({
      id: `log_${i}`,
      agent_id: 'test',
      action: 'test',
      target_type: 'task',
      target_id: 't_001',
      description: 'test',
      timestamp: new Date().toISOString(),
      tags: [],
    })) as AgentLogEntry[]

    const state = makeState({ agent_log: logEntries })
    vi.mocked(rotateAgentLog).mockReturnValue({ active: [], rotated: 501 })

    writeTracker(state)

    expect(rotateAgentLog).toHaveBeenCalled()
  })
})

describe('computeScheduleStatus', () => {
  it('returns on_track when no milestones exist', () => {
    expect(computeScheduleStatus(makeState())).toBe('on_track')
  })

  it('returns behind when max drift > 3', () => {
    const state = makeState({
      milestones: {
        active: [makeMilestone({ drift_days: 5 })],
        backlog: [makeMilestone({ drift_days: 0 })],
        completed: [],
      },
    })
    expect(computeScheduleStatus(state)).toBe('behind')
  })

  it('returns ahead when min drift < -3', () => {
    const state = makeState({
      milestones: {
        active: [makeMilestone({ drift_days: -5 })],
        backlog: [],
        completed: [],
      },
    })
    expect(computeScheduleStatus(state)).toBe('ahead')
  })

  it('returns on_track when drift is within bounds', () => {
    const state = makeState({
      milestones: {
        active: [makeMilestone({ drift_days: 2 })],
        backlog: [makeMilestone({ drift_days: -2 })],
        completed: [],
      },
    })
    expect(computeScheduleStatus(state)).toBe('on_track')
  })
})

describe('computeOverallProgress', () => {
  it('returns 0 when no tasks exist', () => {
    expect(computeOverallProgress(makeState())).toBe(0)
  })

  it('returns 0 when milestone has no subtasks', () => {
    const state = makeState({
      milestones: {
        active: [makeMilestone()],
        backlog: [],
        completed: [],
      },
    })
    expect(computeOverallProgress(state)).toBe(0)
  })

  it('calculates correct percentage', () => {
    const state = makeState({
      milestones: {
        active: [
          makeMilestone({
            subtasks: [
              makeSubtask({ id: 'a', status: 'done' }),
              makeSubtask({ id: 'b', status: 'todo' }),
              makeSubtask({ id: 'c', status: 'in_progress' }),
              makeSubtask({ id: 'd', status: 'done' }),
            ],
          }),
        ],
        backlog: [],
        completed: [],
      },
    })
    expect(computeOverallProgress(state)).toBe(50)
  })

  it('includes backlog tasks in calculation', () => {
    const state = makeState({
      milestones: {
        active: [makeMilestone({ subtasks: [makeSubtask({ id: 'a', status: 'done' })] })],
        backlog: [makeMilestone({ subtasks: [makeSubtask({ id: 'b', status: 'todo' })] })],
        completed: [],
      },
    })
    expect(computeOverallProgress(state)).toBe(50)
  })

  it('returns 100 when all tasks are done', () => {
    const state = makeState({
      milestones: {
        active: [makeMilestone({ subtasks: [makeSubtask({ id: 'a', status: 'done' })] })],
        backlog: [],
        completed: [],
      },
    })
    expect(computeOverallProgress(state)).toBe(100)
  })
})

describe('findTask', () => {
  it('finds a task by ID in active milestones', () => {
    const task = makeSubtask({ id: 't_001' })
    const milestone = makeMilestone({ subtasks: [task] })
    const state = makeState({ milestones: { active: [milestone], backlog: [], completed: [] } })

    const result = findTask(state, 't_001')
    expect(result).not.toBeNull()
    expect(result!.subtask.id).toBe('t_001')
    expect(result!.milestone.id).toBe('m_test')
  })

  it('finds a task in backlog milestones', () => {
    const task = makeSubtask({ id: 't_002' })
    const milestone = makeMilestone({ subtasks: [task] })
    const state = makeState({ milestones: { active: [], backlog: [milestone], completed: [] } })

    const result = findTask(state, 't_002')
    expect(result).not.toBeNull()
    expect(result!.subtask.id).toBe('t_002')
  })

  it('returns null when task not found', () => {
    expect(findTask(makeState(), 'nonexistent')).toBeNull()
  })
})

describe('getMilestoneById', () => {
  it('finds milestone in active', () => {
    const ms = makeMilestone({ id: 'm1' })
    const state = makeState({ milestones: { active: [ms], backlog: [], completed: [] } })
    expect(getMilestoneById(state, 'm1')?.id).toBe('m1')
  })

  it('finds milestone in backlog', () => {
    const ms = makeMilestone({ id: 'm2' })
    const state = makeState({ milestones: { active: [], backlog: [ms], completed: [] } })
    expect(getMilestoneById(state, 'm2')?.id).toBe('m2')
  })

  it('returns undefined for unknown milestone', () => {
    expect(getMilestoneById(makeState(), 'unknown')).toBeUndefined()
  })
})

describe('getActiveMilestoneById', () => {
  it('finds milestone in active only', () => {
    const ms = makeMilestone({ id: 'm1' })
    const state = makeState({ milestones: { active: [ms], backlog: [], completed: [] } })
    expect(getActiveMilestoneById(state, 'm1')?.id).toBe('m1')
  })

  it('does not find milestone in backlog', () => {
    const ms = makeMilestone({ id: 'm2' })
    const state = makeState({ milestones: { active: [], backlog: [ms], completed: [] } })
    expect(getActiveMilestoneById(state, 'm2')).toBeUndefined()
  })
})

describe('touchAgent', () => {
  it('updates existing agent timestamp and count', () => {
    const agent: Agent = {
      id: 'test-agent',
      name: 'Test',
      type: 'orchestrator',
      color: '#000',
      status: 'idle',
      permissions: ['READ'],
      last_action_at: null,
      session_action_count: 0,
    }
    const state = makeState({ agents: [agent] })

    const before = Date.now()
    touchAgent(state, 'test-agent')
    const after = Date.now()

    const updated = state.agents![0]
    expect(updated.session_action_count).toBe(1)
    expect(updated.status).toBe('active')
    const ts = new Date(updated.last_action_at!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('defaults to orchestrator agent', () => {
    const agent: Agent = {
      id: 'orchestrator',
      name: 'Orch',
      type: 'orchestrator',
      color: '#000',
      status: 'active',
      permissions: ['ADMIN'],
      last_action_at: null,
      session_action_count: 5,
    }
    const state = makeState({ agents: [agent] })
    touchAgent(state)
    expect(state.agents![0].session_action_count).toBe(6)
  })

  it('creates agents array if missing', () => {
    const state = makeState()
    expect(state.agents).toBeUndefined()
    touchAgent(state)
    expect(state.agents).toEqual([])
  })

  it('does nothing if agent id not found', () => {
    const state = makeState({ agents: [] })
    touchAgent(state, 'nonexistent')
    expect(state.agents).toEqual([])
  })
})

describe('pushLog', () => {
  it('adds an entry to agent_log', () => {
    const state = makeState()
    pushLog(state, {
      agent_id: 'orch',
      action: 'test',
      target_type: 'task',
      target_id: 't_001',
      description: 'testing',
      tags: [],
    })

    expect(state.agent_log).toHaveLength(1)
    expect(state.agent_log![0].agent_id).toBe('orch')
    expect(state.agent_log![0].action).toBe('test')
    expect(state.agent_log![0].target_id).toBe('t_001')
    expect(state.agent_log![0].id).toMatch(/^log_/)
    expect(state.agent_log![0].timestamp).toBeDefined()
  })

  it('creates agent_log array if missing', () => {
    const state = makeState()
    expect(state.agent_log).toBeUndefined()
    pushLog(state, {
      agent_id: 'orch',
      action: 'test',
      target_type: 'task',
      target_id: 't_001',
      description: 'testing',
      tags: [],
    })
    expect(state.agent_log).toHaveLength(1)
  })

  it('appends to existing log', () => {
    const state = makeState({
      agent_log: [
        {
          id: 'existing',
          agent_id: 'a',
          action: 'prev',
          target_type: 'task',
          target_id: 't_001',
          description: 'old',
          timestamp: '2026-01-01T00:00:00.000Z',
          tags: [],
        },
      ],
    })
    pushLog(state, {
      agent_id: 'b',
      action: 'new',
      target_type: 'task',
      target_id: 't_002',
      description: 'new entry',
      tags: [],
    })
    expect(state.agent_log).toHaveLength(2)
  })
})

describe('pushHistory', () => {
  it("adds a history entry with today's date", () => {
    const state = makeState()
    pushHistory(state, { action: 'test action', agent: 'orch' })

    expect(state.history_log).toHaveLength(1)
    expect(state.history_log![0].action).toBe('test action')
    expect(state.history_log![0].date).toBe(new Date().toISOString().split('T')[0])
  })

  it('creates history_log array if missing', () => {
    const state = makeState()
    expect(state.history_log).toBeUndefined()
    pushHistory(state, { action: 'test', agent: 'orch' })
    expect(state.history_log).toHaveLength(1)
  })
})

describe('autoUnblockDependents', () => {
  it('unblocks tasks whose blocker was the completed task', () => {
    const completed = makeSubtask({ id: 't_completed', status: 'done' })
    const blocked = makeSubtask({
      id: 't_blocked',
      status: 'blocked',
      blocked_by: 't_completed',
      blocked_reason: 'waiting',
      depends_on: ['t_completed'],
    })
    const milestone = makeMilestone({ id: 'm1', subtasks: [completed, blocked] })
    const state = makeState({ milestones: { active: [milestone], backlog: [], completed: [] } })

    const unblocked = autoUnblockDependents(state, 't_completed')

    expect(unblocked).toHaveLength(1)
    expect(unblocked[0]).toBe('t_blocked')
    expect(blocked.status).toBe('todo')
    expect(blocked.blocked_by).toBeNull()
    expect(blocked.blocked_reason).toBeNull()
  })

  it('does not unblock if dependency not yet done', () => {
    const blocked = makeSubtask({
      id: 't_blocked',
      status: 'blocked',
      blocked_by: 't_completed',
      depends_on: ['t_completed', 't_other'],
    })
    const milestone = makeMilestone({ id: 'm1', subtasks: [blocked] })
    const state = makeState({ milestones: { active: [milestone], backlog: [], completed: [] } })

    const unblocked = autoUnblockDependents(state, 't_completed')

    expect(unblocked).toHaveLength(0)
    expect(blocked.status).toBe('blocked')
  })

  it('does not unblock tasks blocked by a different task', () => {
    const blocked = makeSubtask({
      id: 't_blocked',
      status: 'blocked',
      blocked_by: 't_other',
      depends_on: ['t_other'],
    })
    const milestone = makeMilestone({ id: 'm1', subtasks: [blocked] })
    const state = makeState({ milestones: { active: [milestone], backlog: [], completed: [] } })

    const unblocked = autoUnblockDependents(state, 't_completed')

    expect(unblocked).toHaveLength(0)
  })

  it('returns empty array when nothing is blocked', () => {
    const state = makeState()
    const unblocked = autoUnblockDependents(state, 't_completed')
    expect(unblocked).toEqual([])
  })
})

describe('countRevisions', () => {
  it('counts reject_task entries for a task ID', () => {
    const state = makeState({
      agent_log: [
        {
          id: '1',
          agent_id: 'a',
          action: 'reject_task',
          target_type: 'task',
          target_id: 't_001',
          description: '',
          timestamp: '',
          tags: [],
        },
        {
          id: '2',
          agent_id: 'a',
          action: 'reject_task',
          target_type: 'task',
          target_id: 't_001',
          description: '',
          timestamp: '',
          tags: [],
        },
        {
          id: '3',
          agent_id: 'a',
          action: 'reject_task',
          target_type: 'task',
          target_id: 't_002',
          description: '',
          timestamp: '',
          tags: [],
        },
        {
          id: '4',
          agent_id: 'a',
          action: 'start_task',
          target_type: 'task',
          target_id: 't_001',
          description: '',
          timestamp: '',
          tags: [],
        },
      ],
    })
    expect(countRevisions(state, 't_001')).toBe(2)
    expect(countRevisions(state, 't_002')).toBe(1)
    expect(countRevisions(state, 't_003')).toBe(0)
  })

  it('returns 0 when no agent_log exists', () => {
    expect(countRevisions(makeState(), 't_001')).toBe(0)
  })
})

describe('generateTaskId', () => {
  it('generates next sequential ID based on existing subtasks', () => {
    const milestone = makeMilestone({
      id: 'm_test',
      subtasks: [
        makeSubtask({ id: 'm_test_001' }),
        makeSubtask({ id: 'm_test_002' }),
        makeSubtask({ id: 'm_test_005' }),
      ],
    })
    expect(generateTaskId(milestone)).toBe('m_test_006')
  })

  it('starts at 001 when no subtasks exist', () => {
    const milestone = makeMilestone({ id: 'm_empty' })
    expect(generateTaskId(milestone)).toBe('m_empty_001')
  })

  it('handles non-numeric suffix gracefully', () => {
    const milestone = makeMilestone({
      id: 'm_test',
      subtasks: [makeSubtask({ id: 'm_test_abc' })],
    })
    expect(generateTaskId(milestone)).toBe('m_test_001')
  })
})

describe('ok / fail', () => {
  it('ok returns success result', () => {
    const result = ok('done')
    expect(result.ok).toBe(true)
    expect(result.data).toBe('done')
  })

  it('fail returns error result', () => {
    const result = fail('something broke')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('something broke')
  })
})
