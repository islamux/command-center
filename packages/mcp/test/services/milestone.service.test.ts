import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceResult } from 'command-center-shared'

const mockTracker = vi.hoisted(() => ({
  readTracker: vi.fn(),
  writeTracker: vi.fn(),
  getMilestoneById: vi.fn(),
  touchAgent: vi.fn(),
  pushLog: vi.fn(),
  pushHistory: vi.fn(),
  generateTaskId: vi.fn(() => 'm_test_001'),
  ok: vi.fn((data: string) => ({ ok: true, data }) as ServiceResult),
  fail: vi.fn((error: string) => ({ ok: false, error }) as ServiceResult),
}))

vi.mock('../../src/services/tracker.service.js', () => mockTracker)

import {
  addMilestoneNote,
  setMilestoneDates,
  updateDrift,
  createMilestone,
  addMilestoneTask,
  activateMilestone,
  moveMilestoneToCompleted,
} from '../../src/services/milestone.service.js'

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

describe('addMilestoneNote', () => {
  it('adds a note to a milestone', () => {
    const milestone = makeMockMilestone({ notes: [] })
    mockTracker.getMilestoneById.mockReturnValue(milestone)
    mockTracker.readTracker.mockReturnValue({})

    const result = addMilestoneNote('m_test', 'important note')

    expect(result.ok).toBe(true)
    expect(milestone.notes).toContain('important note')
    expect(mockTracker.writeTracker).toHaveBeenCalled()
  })

  it('returns fail when milestone not found', () => {
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue({})

    const result = addMilestoneNote('nonexistent', 'note')
    expect(result.ok).toBe(false)
  })
})

describe('setMilestoneDates', () => {
  it('sets actual_start and actual_end dates', () => {
    const milestone = makeMockMilestone()
    mockTracker.getMilestoneById.mockReturnValue(milestone)
    mockTracker.readTracker.mockReturnValue({})

    const result = setMilestoneDates('m_test', {
      actual_start: '2026-01-01',
      actual_end: '2026-01-10',
    })

    expect(result.ok).toBe(true)
    expect(milestone.actual_start).toBe('2026-01-01')
    expect(milestone.actual_end).toBe('2026-01-10')
  })

  it('computes drift days when planned_end and actual_end are set', () => {
    const milestone = makeMockMilestone({
      planned_end: '2026-01-07',
    })
    mockTracker.getMilestoneById.mockReturnValue(milestone)
    mockTracker.readTracker.mockReturnValue({})

    setMilestoneDates('m_test', { actual_end: '2026-01-10' })

    expect(milestone.drift_days).toBe(3)
  })

  it('handles negative drift (ahead of schedule)', () => {
    const milestone = makeMockMilestone({
      planned_end: '2026-01-10',
    })
    mockTracker.getMilestoneById.mockReturnValue(milestone)
    mockTracker.readTracker.mockReturnValue({})

    setMilestoneDates('m_test', { actual_end: '2026-01-07' })

    expect(milestone.drift_days).toBe(-3)
  })

  it('returns fail when milestone not found', () => {
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue({})

    const result = setMilestoneDates('nonexistent', { actual_start: '2026-01-01' })
    expect(result.ok).toBe(false)
  })
})

describe('updateDrift', () => {
  it('updates drift days on a milestone', () => {
    const milestone = makeMockMilestone()
    mockTracker.getMilestoneById.mockReturnValue(milestone)
    mockTracker.readTracker.mockReturnValue({})

    const result = updateDrift('m_test', 5)

    expect(result.ok).toBe(true)
    expect(milestone.drift_days).toBe(5)
    expect(mockTracker.writeTracker).toHaveBeenCalled()
  })

  it('returns fail when milestone not found', () => {
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue({})

    const result = updateDrift('nonexistent', 3)
    expect(result.ok).toBe(false)
  })
})

describe('createMilestone', () => {
  it('creates a milestone in backlog by default', () => {
    const state = { milestones: { active: [], backlog: [] } }
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue(state)

    const result = createMilestone('m_new', 'New Milestone')

    expect(result.ok).toBe(true)
    expect(state.milestones.backlog).toHaveLength(1)
    expect(state.milestones.backlog[0].id).toBe('m_new')
    expect(state.milestones.backlog[0].title).toBe('New Milestone')
    expect(mockTracker.pushHistory).toHaveBeenCalled()
    expect(mockTracker.writeTracker).toHaveBeenCalled()
  })

  it('creates a milestone in active when options.active is true', () => {
    const state = { milestones: { active: [], backlog: [] } }
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue(state)

    createMilestone('m_active', 'Active MS', { active: true })

    expect(state.milestones.active).toHaveLength(1)
    expect(state.milestones.backlog).toHaveLength(0)
  })

  it('rejects duplicate milestone IDs', () => {
    const existingMilestone = makeMockMilestone()
    mockTracker.getMilestoneById.mockReturnValue(existingMilestone)
    mockTracker.readTracker.mockReturnValue({})

    const result = createMilestone('m_test', 'duplicate')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('already exists')
  })

  it('passes options to the new milestone', () => {
    const state = { milestones: { active: [], backlog: [] } }
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue(state)

    createMilestone('m_opts', 'With Options', {
      domain: 'quality',
      week: 2,
      phase: 'Test',
      planned_start: '2026-02-01',
      planned_end: '2026-02-07',
      is_key_milestone: true,
      key_milestone_label: 'Important',
    })

    const ms = state.milestones.backlog[0]
    expect(ms.domain).toBe('quality')
    expect(ms.week).toBe(2)
    expect(ms.phase).toBe('Test')
    expect(ms.planned_start).toBe('2026-02-01')
    expect(ms.planned_end).toBe('2026-02-07')
    expect(ms.is_key_milestone).toBe(true)
    expect(ms.key_milestone_label).toBe('Important')
  })
})

describe('addMilestoneTask', () => {
  it('adds a task to a milestone', () => {
    const milestone = makeMockMilestone({ subtasks: [] })
    mockTracker.getMilestoneById.mockReturnValue(milestone)
    mockTracker.readTracker.mockReturnValue({})

    const result = addMilestoneTask('m_test', 'New Task', {
      priority: 'P1',
    })

    expect(result.ok).toBe(true)
    expect(milestone.subtasks).toHaveLength(1)
    expect(milestone.subtasks[0].label).toBe('New Task')
    expect(milestone.subtasks[0].priority).toBe('P1')
    expect(milestone.subtasks[0].id).toBe('m_test_001')
    expect(mockTracker.writeTracker).toHaveBeenCalled()
  })

  it('returns fail when milestone not found', () => {
    mockTracker.getMilestoneById.mockReturnValue(undefined)
    mockTracker.readTracker.mockReturnValue({})

    const result = addMilestoneTask('nonexistent', 'Task')
    expect(result.ok).toBe(false)
  })
})

describe('activateMilestone', () => {
  it('moves a milestone from backlog to active', () => {
    const milestone = makeMockMilestone({ id: 'm_bg' })
    const state = {
      milestones: { active: [], backlog: [milestone] },
      dashboard: { active_milestone: '', next_priority: '' },
    }
    mockTracker.readTracker.mockReturnValue(state)

    const result = activateMilestone('m_bg')

    expect(result.ok).toBe(true)
    expect(state.milestones.active).toHaveLength(1)
    expect(state.milestones.backlog).toHaveLength(0)
    expect(state.milestones.active[0].id).toBe('m_bg')
    expect(state.dashboard.active_milestone).toBe('m_bg')
    expect(state.dashboard.next_priority).toBe('Test Milestone')
    expect(mockTracker.pushHistory).toHaveBeenCalled()
    expect(mockTracker.writeTracker).toHaveBeenCalled()
  })

  it('returns fail when milestone not in backlog', () => {
    const state = { milestones: { active: [], backlog: [] } }
    mockTracker.readTracker.mockReturnValue(state)

    const result = activateMilestone('nonexistent')
    expect(result.ok).toBe(false)
  })
})

describe('moveMilestoneToCompleted', () => {
  it('moves an active milestone to completed', () => {
    const milestone = makeMockMilestone({ id: 'm_active', subtasks: [] })
    const state = { milestones: { active: [milestone], backlog: [], completed: [] } }
    mockTracker.readTracker.mockReturnValue(state)

    const result = moveMilestoneToCompleted('m_active')

    expect(result.ok).toBe(true)
    expect(state.milestones.active).toHaveLength(0)
    expect(state.milestones.completed).toHaveLength(1)
    expect(state.milestones.completed[0].id).toBe('m_active')
    expect(state.milestones.completed[0].status).toBe('completed')
    expect(mockTracker.pushHistory).toHaveBeenCalled()
    expect(mockTracker.writeTracker).toHaveBeenCalled()
  })

  it('returns fail when milestone not in active', () => {
    const state = { milestones: { active: [], backlog: [], completed: [] } }
    mockTracker.readTracker.mockReturnValue(state)

    const result = moveMilestoneToCompleted('nonexistent')
    expect(result.ok).toBe(false)
  })
})
