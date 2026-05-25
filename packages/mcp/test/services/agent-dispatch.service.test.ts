import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TrackerState, Agent, Subtask } from 'command-center-shared'

vi.mock('../../src/services/tracker.service.js', () => ({
  fail: vi.fn((error: string) => ({ ok: false, error })),
}))

import {
  getAgent,
  getAvailableAgents,
  findBestAgent,
  dispatchTask,
  checkPermission,
  getAgentBusyCount,
  updateHeartbeat,
  checkAgentHeartbeats,
  AGENT_HEARTBEAT_TIMEOUT_MS,
  enforceAgentPermission,
} from '../../src/services/agent-dispatch.service.js'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    type: 'sub-agent',
    color: '#000',
    status: 'active',
    permissions: ['READ', 'EXECUTE'],
    last_action_at: new Date().toISOString(),
    session_action_count: 0,
    ...overrides,
  }
}

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 't_001',
    label: 'test',
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
  }
}

function makeState(overrides: Partial<TrackerState> = {}): TrackerState {
  return {
    project: {
      name: 'test',
      start_date: '',
      target_date: '',
      current_week: 1,
      schedule_status: 'on_track',
      overall_progress: 0,
    },
    milestones: { active: [], backlog: [], completed: [] },
    ...overrides,
  } as TrackerState
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getAgent', () => {
  it('finds an agent by ID', () => {
    const agent = makeAgent({ id: 'foo' })
    const state = makeState({ agents: [agent] })
    expect(getAgent(state, 'foo')?.id).toBe('foo')
  })

  it('returns undefined when not found', () => {
    expect(getAgent(makeState(), 'nope')).toBeUndefined()
  })

  it('returns undefined when agents array is undefined', () => {
    expect(getAgent(makeState(), 'foo')).toBeUndefined()
  })
})

describe('getAvailableAgents', () => {
  it('filters out offline and stalled agents', () => {
    const state = makeState({
      agents: [
        makeAgent({ id: 'a', status: 'active' }),
        makeAgent({ id: 'b', status: 'idle' }),
        makeAgent({ id: 'c', status: 'offline' }),
        makeAgent({ id: 'd', status: 'stalled' }),
      ],
    })
    const available = getAvailableAgents(state)
    expect(available).toHaveLength(2)
    expect(available.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('returns empty array when agents is undefined', () => {
    expect(getAvailableAgents(makeState())).toEqual([])
  })
})

describe('findBestAgent', () => {
  it('returns target agent when agent_target is set and available', () => {
    const target = makeAgent({ id: 'target' })
    const task = makeSubtask({ agent_target: 'target' })
    const state = makeState({ agents: [makeAgent({ id: 'other' }), target] })

    expect(findBestAgent(state, task)?.id).toBe('target')
  })

  it('returns null when target agent is offline', () => {
    const target = makeAgent({ id: 'target', status: 'offline' })
    const task = makeSubtask({ agent_target: 'target' })
    const state = makeState({ agents: [target] })

    expect(findBestAgent(state, task)).toBeNull()
  })

  it('returns least busy available agent', () => {
    const busyAgent = makeAgent({ id: 'busy' })
    const freeAgent = makeAgent({ id: 'free' })
    const state = makeState({
      agents: [busyAgent, freeAgent],
      milestones: {
        active: [
          {
            id: 'm1',
            title: 'M1',
            domain: 'dev',
            week: 1,
            phase: '',
            planned_start: null,
            planned_end: null,
            actual_start: null,
            actual_end: null,
            drift_days: 0,
            is_key_milestone: false,
            key_milestone_label: null,
            subtasks: [
              makeSubtask({ id: 't1', status: 'in_progress', assignee: 'busy' }),
              makeSubtask({ id: 't2', status: 'in_progress', assignee: 'busy' }),
              makeSubtask({ id: 't3', status: 'in_progress', assignee: 'busy' }),
              makeSubtask({ id: 't4', status: 'todo', assignee: null }),
            ],
            dependencies: [],
            notes: [],
          },
        ],
        backlog: [],
        completed: [],
      },
    })

    const best = findBestAgent(state, makeSubtask())
    expect(best?.id).toBe('free')
  })

  it('returns null when no agents exist', () => {
    expect(findBestAgent(makeState(), makeSubtask())).toBeNull()
  })

  it('returns null when all agents are at max capacity', () => {
    const agents = Array.from({ length: 2 }, (_, i) => makeAgent({ id: `agent-${i}` }))
    const subtasks = Array.from({ length: 6 }, (_, i) =>
      makeSubtask({ id: `t${i}`, status: 'in_progress', assignee: i < 3 ? 'agent-0' : 'agent-1' }),
    )
    const state = makeState({
      agents,
      milestones: {
        active: [
          {
            id: 'm1',
            title: 'M1',
            domain: 'dev',
            week: 1,
            phase: '',
            planned_start: null,
            planned_end: null,
            actual_start: null,
            actual_end: null,
            drift_days: 0,
            is_key_milestone: false,
            key_milestone_label: null,
            subtasks,
            dependencies: [],
            notes: [],
          },
        ],
        backlog: [],
        completed: [],
      },
    })

    expect(findBestAgent(state, makeSubtask())).toBeNull()
  })
})

describe('dispatchTask', () => {
  it('dispatches to a valid agent', () => {
    const agent = makeAgent()
    const state = makeState({ agents: [agent] })

    const result = dispatchTask(state, 't_001', 'agent-1')

    expect(result.ok).toBe(true)
    expect(result.agent_id).toBe('agent-1')
  })

  it('uses orchestrator as default agent', () => {
    const agent = makeAgent({ id: 'orchestrator', permissions: ['ADMIN'] })
    const state = makeState({ agents: [agent] })

    const result = dispatchTask(state, 't_001')

    expect(result.ok).toBe(true)
    expect(result.agent_id).toBe('orchestrator')
  })

  it('fails when agent not found', () => {
    const result = dispatchTask(makeState(), 't_001', 'nobody')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('fails when agent lacks EXECUTE permission', () => {
    const agent = makeAgent({ permissions: ['READ'] })
    const state = makeState({ agents: [agent] })

    const result = dispatchTask(state, 't_001', 'agent-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('lacks EXECUTE permission')
  })

  it('fails when agent is offline', () => {
    const agent = makeAgent({ status: 'offline' })
    const state = makeState({ agents: [agent] })

    const result = dispatchTask(state, 't_001', 'agent-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('is offline')
  })

  it('fails when agent is at max capacity', () => {
    const agent = makeAgent()
    const subtasks = Array.from({ length: 3 }, (_, i) =>
      makeSubtask({ id: `t${i}`, status: 'in_progress', assignee: 'agent-1' }),
    )
    const state = makeState({
      agents: [agent],
      milestones: {
        active: [
          {
            id: 'm1',
            title: 'M1',
            domain: 'dev',
            week: 1,
            phase: '',
            planned_start: null,
            planned_end: null,
            actual_start: null,
            actual_end: null,
            drift_days: 0,
            is_key_milestone: false,
            key_milestone_label: null,
            subtasks,
            dependencies: [],
            notes: [],
          },
        ],
        backlog: [],
        completed: [],
      },
    })

    const result = dispatchTask(state, 't_001', 'agent-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('max capacity')
  })
})

describe('checkPermission', () => {
  it('allows ADMIN to do anything', () => {
    const agent = makeAgent({ permissions: ['ADMIN'] })
    expect(checkPermission(agent, 'EXECUTE')).toBe(true)
    expect(checkPermission(agent, 'APPROVE')).toBe(true)
    expect(checkPermission(agent, 'DISPATCH')).toBe(true)
  })

  it('checks specific permission', () => {
    const agent = makeAgent({ permissions: ['READ', 'WRITE'] })
    expect(checkPermission(agent, 'READ')).toBe(true)
    expect(checkPermission(agent, 'WRITE')).toBe(true)
    expect(checkPermission(agent, 'EXECUTE')).toBe(false)
  })
})

describe('getAgentBusyCount', () => {
  it('counts in_progress tasks assigned to agent', () => {
    const state = makeState({
      milestones: {
        active: [
          {
            id: 'm1',
            title: 'M1',
            domain: 'dev',
            week: 1,
            phase: '',
            planned_start: null,
            planned_end: null,
            actual_start: null,
            actual_end: null,
            drift_days: 0,
            is_key_milestone: false,
            key_milestone_label: null,
            subtasks: [
              makeSubtask({ id: 't1', status: 'in_progress', assignee: 'agent-1' }),
              makeSubtask({ id: 't2', status: 'in_progress', assignee: 'agent-1' }),
              makeSubtask({ id: 't3', status: 'todo', assignee: null }),
              makeSubtask({ id: 't4', status: 'in_progress', assignee: 'other' }),
            ],
            dependencies: [],
            notes: [],
          },
        ],
        backlog: [],
        completed: [],
      },
    })

    expect(getAgentBusyCount(state, 'agent-1')).toBe(2)
  })

  it('returns 0 when no tasks match', () => {
    expect(getAgentBusyCount(makeState(), 'agent-1')).toBe(0)
  })
})

describe('updateHeartbeat', () => {
  it('updates agent timestamp and sets status to active', () => {
    const agent = makeAgent({ last_action_at: '2020-01-01T00:00:00.000Z', status: 'idle' })
    const state = makeState({ agents: [agent] })

    const before = Date.now()
    updateHeartbeat(state, 'agent-1')
    const after = Date.now()

    const ts = new Date(agent.last_action_at!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
    expect(agent.status).toBe('active')
  })

  it('does nothing for unknown agent', () => {
    expect(() => updateHeartbeat(makeState(), 'nobody')).not.toThrow()
  })
})

describe('checkAgentHeartbeats', () => {
  it('marks agents as stalled when heartbeat exceeds timeout', () => {
    const old = new Date(Date.now() - AGENT_HEARTBEAT_TIMEOUT_MS - 1000).toISOString()
    const agent = makeAgent({ id: 'stalled-agent', last_action_at: old, status: 'active' })
    const fresh = makeAgent({ id: 'fresh-agent', last_action_at: new Date().toISOString(), status: 'active' })
    const state = makeState({ agents: [agent, fresh] })

    const result = checkAgentHeartbeats(state)

    expect(result.stalled).toEqual(['stalled-agent'])
    expect(result.active).toBe(1)
    expect(agent.status).toBe('stalled')
    expect(fresh.status).toBe('active')
  })

  it('skips agents with no last_action_at', () => {
    const agent = makeAgent({ last_action_at: null, status: 'idle' })
    const state = makeState({ agents: [agent] })

    const result = checkAgentHeartbeats(state)
    expect(result.stalled).toEqual([])
    expect(result.active).toBe(0)
  })

  it('handles undefined agents gracefully', () => {
    const result = checkAgentHeartbeats(makeState())
    expect(result).toEqual({ stalled: [], active: 0 })
  })
})

describe('enforceAgentPermission', () => {
  it('returns null when permission check passes', () => {
    const agent = makeAgent({ permissions: ['ADMIN'] })
    const state = makeState({ agents: [agent] })
    expect(enforceAgentPermission(state, 'agent-1', 'EXECUTE')).toBeNull()
  })

  it('returns fail when agent not found', () => {
    const result = enforceAgentPermission(makeState(), 'nobody', 'READ')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not found') })
  })

  it('returns fail when agent lacks permission', () => {
    const agent = makeAgent({ permissions: ['READ'] })
    const state = makeState({ agents: [agent] })
    const result = enforceAgentPermission(state, 'agent-1', 'EXECUTE')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('lacks EXECUTE permission') })
  })
})
