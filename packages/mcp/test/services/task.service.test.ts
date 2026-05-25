import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceResult } from 'command-center-shared'

const mockTracker = vi.hoisted(() => ({
  readTracker: vi.fn(),
  writeTracker: vi.fn(),
  findTask: vi.fn(),
  touchAgent: vi.fn(),
  pushLog: vi.fn(),
  autoUnblockDependents: vi.fn(() => []),
  countRevisions: vi.fn(() => 0),
  ok: vi.fn((data: string) => ({ ok: true, data }) as ServiceResult),
  fail: vi.fn((error: string) => ({ ok: false, error }) as ServiceResult),
}))

vi.mock('../../src/services/tracker.service.js', () => mockTracker)

import {
  startTask,
  completeTask,
  approveTask,
  rejectTask,
  resetTask,
  blockTask,
  unblockTask,
  updateTask,
  logAction,
  enrichTask,
} from '../../src/services/task.service.js'

function makeMockTask(overrides = {}) {
  return {
    id: 't_001',
    label: 'Test Task',
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

function makeMockMilestone(overrides = {}) {
  return {
    id: 'm_test',
    title: 'Test Milestone',
    domain: 'dev',
    week: 1,
    phase: 'Foundation',
    planned_start: null,
    planned_end: null,
    actual_start: null,
    actual_end: null,
    drift_days: 0,
    is_key_milestone: false,
    key_milestone_label: null,
    subtasks: [],
    dependencies: [],
    notes: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startTask', () => {
  it('starts a task and assigns it', () => {
    const task = makeMockTask()
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = startTask('t_001')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('in_progress')
    expect(task.assignee).toBe('orchestrator')
    expect(mockTracker.touchAgent).toHaveBeenCalled()
    expect(mockTracker.pushLog).toHaveBeenCalled()
    expect(mockTracker.writeTracker).toHaveBeenCalledWith(expect.anything(), 'start_task')
  })

  it('sets actual_start on milestone if not already set', () => {
    const task = makeMockTask()
    const milestone = makeMockMilestone({ actual_start: null })
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    startTask('t_001')

    expect(milestone.actual_start).toBeTruthy()
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = startTask('nonexistent')
    expect(result.ok).toBe(false)
  })

  it('uses provided agentId', () => {
    const task = makeMockTask()
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    startTask('t_001', 'explorer')

    expect(task.assignee).toBe('explorer')
  })
})

describe('completeTask', () => {
  it('moves task to review status', () => {
    const task = makeMockTask({ status: 'in_progress', assignee: 'explorer' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = completeTask('t_001', 'all done')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('review')
    expect(mockTracker.writeTracker).toHaveBeenCalledWith(expect.anything(), 'complete_task')
  })

  it('uses subtask assignee when no agentId given', () => {
    const task = makeMockTask({ assignee: 'explorer' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    completeTask('t_001', 'done')

    expect(mockTracker.touchAgent).toHaveBeenCalledWith(expect.anything(), 'explorer')
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)
    mockTracker.readTracker.mockReturnValue({})

    const result = completeTask('nonexistent', 'done')
    expect(result.ok).toBe(false)
  })
})

describe('approveTask', () => {
  it('approves a task in review status', () => {
    const task = makeMockTask({ status: 'review' })
    const milestone = makeMockMilestone({ subtasks: [task] })
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = approveTask('t_001', 'looks good')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('done')
    expect(task.completed_at).toBeTruthy()
    expect(task.completed_by).toBe('orchestrator')
  })

  it('rejects task not in review', () => {
    const task = makeMockTask({ status: 'todo' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })

    const result = approveTask('t_001')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not in review')
  })

  it('sets milestone actual_end when all tasks are done', () => {
    const doneTask = makeMockTask({ id: 't_done', status: 'done' })
    const task = makeMockTask({ id: 't_001', status: 'review' })
    const milestone = makeMockMilestone({ subtasks: [doneTask, task], actual_end: null })
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    approveTask('t_001')

    expect(milestone.actual_end).toBeTruthy()
  })

  it('does not set milestone actual_end when some tasks remain', () => {
    const task = makeMockTask({ id: 't_001', status: 'review' })
    const otherTask = makeMockTask({ id: 't_002', status: 'todo' })
    const milestone = makeMockMilestone({ subtasks: [task, otherTask] })
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    approveTask('t_001')

    expect(milestone.actual_end).toBeNull()
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = approveTask('nonexistent')
    expect(result.ok).toBe(false)
  })
})

describe('rejectTask', () => {
  it('rejects a task in review and moves back to in_progress', () => {
    const task = makeMockTask({ status: 'review' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})
    mockTracker.countRevisions.mockReturnValue(0)

    const result = rejectTask('t_001', 'needs work')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('in_progress')
    expect(result.data).toContain('revision #1')
  })

  it('rejects task not in review', () => {
    const task = makeMockTask({ status: 'done' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = rejectTask('t_001', 'too late')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not in review')
  })

  it('increments revision count', () => {
    const task = makeMockTask({ status: 'review' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})
    mockTracker.countRevisions.mockReturnValue(2)

    const result = rejectTask('t_001', 'fix again')

    expect(result.data).toContain('revision #3')
  })
})

describe('resetTask', () => {
  it('resets task to todo and clears fields', () => {
    const task = makeMockTask({
      status: 'in_progress',
      assignee: 'explorer',
      completed_at: '2026-01-01',
      completed_by: 'orch',
      blocked_by: 'other',
      blocked_reason: 'waiting',
      last_run_id: 'run_123',
    })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = resetTask('t_001')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('todo')
    expect(task.assignee).toBeNull()
    expect(task.completed_at).toBeNull()
    expect(task.completed_by).toBeNull()
    expect(task.blocked_by).toBeNull()
    expect(task.blocked_reason).toBeNull()
    expect(task.last_run_id).toBeNull()
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = resetTask('nonexistent')
    expect(result.ok).toBe(false)
  })
})

describe('blockTask', () => {
  it('sets task status to blocked with reason', () => {
    const task = makeMockTask({ status: 'in_progress' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = blockTask('t_001', 'waiting for dependency')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('blocked')
    expect(task.blocked_reason).toBe('waiting for dependency')
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = blockTask('nonexistent', 'reason')
    expect(result.ok).toBe(false)
  })
})

describe('unblockTask', () => {
  it('unblocks a blocked task', () => {
    const task = makeMockTask({
      status: 'blocked',
      assignee: 'explorer',
      blocked_by: 'other',
      blocked_reason: 'waiting',
    })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = unblockTask('t_001', 'resolved')

    expect(result.ok).toBe(true)
    expect(task.status).toBe('in_progress')
    expect(task.blocked_by).toBeNull()
    expect(task.blocked_reason).toBeNull()
  })

  it('unblocks blocked task with no assignee to todo', () => {
    const task = makeMockTask({
      status: 'blocked',
      assignee: null,
      blocked_by: 'other',
      blocked_reason: 'waiting',
    })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    unblockTask('t_001', 'resolved')

    expect(task.status).toBe('todo')
  })

  it('rejects unblocking non-blocked task', () => {
    const task = makeMockTask({ status: 'done' })
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = unblockTask('t_001')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not blocked')
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = unblockTask('nonexistent')
    expect(result.ok).toBe(false)
  })
})

describe('updateTask', () => {
  it('updates task fields', () => {
    const task = makeMockTask()
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = updateTask('t_001', {
      priority: 'P1',
      assignee: 'explorer',
      execution_mode: 'agent',
      notes: 'some notes',
    })

    expect(result.ok).toBe(true)
    expect(task.priority).toBe('P1')
    expect(task.assignee).toBe('explorer')
    expect(task.execution_mode).toBe('agent')
    expect(task.notes).toBe('some notes')
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = updateTask('nonexistent', { priority: 'P1' })
    expect(result.ok).toBe(false)
  })
})

describe('logAction', () => {
  it('logs an action to the tracker', () => {
    mockTracker.readTracker.mockReturnValue({})

    const result = logAction('t_001', 'custom_action', 'did something', 'orch', ['custom'])

    expect(result.ok).toBe(true)
    expect(mockTracker.pushLog).toHaveBeenCalledWith(expect.anything(), {
      agent_id: 'orch',
      action: 'custom_action',
      target_type: 'task',
      target_id: 't_001',
      description: 'did something',
      tags: ['custom'],
    })
    expect(mockTracker.writeTracker).toHaveBeenCalledWith(expect.anything(), 'log_action')
  })
})

describe('enrichTask', () => {
  it('enriches a task with metadata fields', () => {
    const task = makeMockTask()
    const milestone = makeMockMilestone()
    mockTracker.findTask.mockReturnValue({ subtask: task, milestone })
    mockTracker.readTracker.mockReturnValue({})

    const result = enrichTask('t_001', {
      prompt: 'do the thing',
      builder_prompt: 'build it',
      acceptance_criteria: ['works'],
      constraints: ['fast'],
      context_files: ['src/file.ts'],
      reference_docs: ['doc.md'],
    })

    expect(result.ok).toBe(true)
    expect(task.prompt).toBe('do the thing')
    expect(task.builder_prompt).toBe('build it')
    expect(task.acceptance_criteria).toEqual(['works'])
    expect(task.constraints).toEqual(['fast'])
    expect(task.context_files).toEqual(['src/file.ts'])
    expect(task.reference_docs).toEqual(['doc.md'])
  })

  it('returns fail when task not found', () => {
    mockTracker.findTask.mockReturnValue(null)

    const result = enrichTask('nonexistent', { prompt: 'do it' })
    expect(result.ok).toBe(false)
  })
})
