import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let tmpDir: string
let handleTool: (name: string, args: Record<string, any>) => Promise<any>
let trackerFile: string

function createTracker(overrides: Record<string, any> = {}) {
  const data = {
    project: {
      name: 'Integration Test',
      start_date: '2026-01-01',
      target_date: '2026-06-30',
      current_week: 1,
      schedule_status: 'on_track',
      overall_progress: 0,
    },
    dashboard: {
      current_focus: 'Testing',
      active_milestone: 'm_integration',
      next_priority: 'Integration testing',
      blockers: 'None',
      health: 'Good',
    },
    milestones: {
      active: [
        {
          id: 'm_integration',
          title: 'Integration Milestone',
          domain: 'test',
          week: 1,
          phase: 'Testing',
          planned_start: '2026-01-01',
          planned_end: '2026-01-07',
          actual_start: null,
          actual_end: null,
          drift_days: 0,
          is_key_milestone: false,
          key_milestone_label: null,
          subtasks: [
            {
              id: 'm_integration_001',
              label: 'First task',
              status: 'todo',
              assignee: null,
              blocked_by: null,
              blocked_reason: null,
              completed_at: null,
              completed_by: null,
              priority: 'P1',
              notes: null,
              prompt: 'Do the first thing',
              context_files: [],
              reference_docs: [],
              acceptance_criteria: ['it works'],
              constraints: [],
              agent_target: null,
              execution_mode: 'human',
              depends_on: [],
              last_run_id: null,
              builder_prompt: null,
            },
            {
              id: 'm_integration_002',
              label: 'Second task',
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
              execution_mode: 'agent',
              depends_on: ['m_integration_001'],
              last_run_id: null,
              builder_prompt: null,
            },
          ],
          dependencies: [],
          notes: [],
        },
      ],
      backlog: [],
      completed: [],
    },
    agents: [
      {
        id: 'orchestrator',
        name: 'Orchestrator',
        type: 'orchestrator',
        color: '#FF6B6B',
        status: 'active',
        permissions: ['READ', 'WRITE', 'ADMIN'],
        last_action_at: null,
        session_action_count: 0,
      },
    ],
    agent_log: [],
    history_log: [],
    _schema_version: 1,
    ...overrides,
  }

  fs.writeFileSync(trackerFile, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function readRaw(): string {
  return fs.readFileSync(trackerFile, 'utf-8')
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-int-test-'))
  trackerFile = path.join(tmpDir, 'project-tracker.json')
  process.env.PROJECT_ROOT = tmpDir
  createTracker()

  const tools = await import('../src/tools.js')
  handleTool = tools.handleTool
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('handleTool', () => {
  describe('read tools', () => {
    it('get_project_status returns formatted status', async () => {
      createTracker()
      const result = await handleTool('get_project_status', {})
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Integration Test')
      expect(result.content[0].text).toContain('Current Week')
    })

    it('get_task_context returns full context', async () => {
      createTracker()
      const result = await handleTool('get_task_context', {
        task_id: 'm_integration_001',
      })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('First task')
      expect(result.content[0].text).toContain('Do the first thing')
    })

    it('get_task_context returns error for unknown task', async () => {
      const result = await handleTool('get_task_context', {
        task_id: 'nonexistent',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    })

    it('get_task_summary returns slim context', async () => {
      createTracker()
      const result = await handleTool('get_task_summary', {
        task_id: 'm_integration_001',
      })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('First task')
    })

    it('get_milestone_overview returns milestone details', async () => {
      createTracker()
      const result = await handleTool('get_milestone_overview', {
        milestone_id: 'm_integration',
      })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Integration Milestone')
    })

    it('list_tasks returns grouped tasks', async () => {
      createTracker()
      const result = await handleTool('list_tasks', {})
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('First task')
    })

    it('list_agents returns registered agents', async () => {
      createTracker()
      const result = await handleTool('list_agents', {})
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('Orchestrator')
    })
  })

  describe('write tools — task lifecycle', () => {
    it('start_task changes status to in_progress', async () => {
      createTracker()
      const result = await handleTool('start_task', {
        task_id: 'm_integration_001',
      })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('started')

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('in_progress')
    })

    it('start_task sets actual_start on milestone', async () => {
      createTracker()
      await handleTool('start_task', { task_id: 'm_integration_001' })
      const raw = JSON.parse(readRaw())
      expect(raw.milestones.active[0].actual_start).toBeTruthy()
    })

    it('complete_task moves to review', async () => {
      createTracker()
      await handleTool('start_task', { task_id: 'm_integration_001' })
      const result = await handleTool('complete_task', {
        task_id: 'm_integration_001',
        summary: 'all done',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('review')
    })

    it('approve_task marks done with completed_at', async () => {
      createTracker()
      await handleTool('start_task', { task_id: 'm_integration_001' })
      await handleTool('complete_task', { task_id: 'm_integration_001', summary: 'done' })
      const result = await handleTool('approve_task', {
        task_id: 'm_integration_001',
        feedback: 'looks good',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('done')
      expect(task.completed_at).toBeTruthy()
      expect(task.completed_by).toBe('orchestrator')
    })

    it('reject_task sends back to in_progress', async () => {
      createTracker()
      await handleTool('start_task', { task_id: 'm_integration_001' })
      await handleTool('complete_task', { task_id: 'm_integration_001', summary: 'done' })
      const result = await handleTool('reject_task', {
        task_id: 'm_integration_001',
        feedback: 'needs work',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('in_progress')
    })

    it('reset_task clears fields', async () => {
      createTracker()
      await handleTool('start_task', { task_id: 'm_integration_001' })
      const result = await handleTool('reset_task', { task_id: 'm_integration_001' })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('todo')
    })

    it('block_task sets blocked status', async () => {
      createTracker()
      const result = await handleTool('block_task', {
        task_id: 'm_integration_001',
        reason: 'blocked',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('blocked')
      expect(task.blocked_reason).toBe('blocked')
    })

    it('unblock_task restores task', async () => {
      createTracker()
      await handleTool('block_task', { task_id: 'm_integration_001', reason: 'blocked' })
      const result = await handleTool('unblock_task', {
        task_id: 'm_integration_001',
        resolution: 'resolved',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.status).toBe('todo')
    })

    it('update_task modifies fields', async () => {
      createTracker()
      const result = await handleTool('update_task', {
        task_id: 'm_integration_001',
        priority: 'P1',
        assignee: 'tester',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.priority).toBe('P1')
      expect(task.assignee).toBe('tester')
    })
  })

  describe('write tools — milestones', () => {
    it('add_milestone_note appends note', async () => {
      createTracker()
      const result = await handleTool('add_milestone_note', {
        milestone_id: 'm_integration',
        note: 'important note',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      expect(raw.milestones.active[0].notes).toContain('important note')
    })

    it('set_milestone_dates updates actual_end', async () => {
      createTracker()
      const result = await handleTool('set_milestone_dates', {
        milestone_id: 'm_integration',
        actual_end: '2026-01-10',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      expect(raw.milestones.active[0].actual_end).toBe('2026-01-10')
    })

    it('set_milestone_dates computes drift', async () => {
      createTracker()
      await handleTool('set_milestone_dates', {
        milestone_id: 'm_integration',
        actual_end: '2026-01-10',
      })

      const raw = JSON.parse(readRaw())
      expect(raw.milestones.active[0].drift_days).toBe(3)
    })

    it('update_drift modifies drift days', async () => {
      createTracker()
      const result = await handleTool('update_drift', {
        milestone_id: 'm_integration',
        drift_days: 3,
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      expect(raw.milestones.active[0].drift_days).toBe(3)
    })

    it('create_milestone adds to backlog', async () => {
      createTracker()
      const result = await handleTool('create_milestone', {
        id: 'm_new',
        title: 'New Milestone',
        domain: 'test',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      expect(raw.milestones.backlog.find((m: any) => m.id === 'm_new')).toBeTruthy()
    })

    it('add_milestone_task adds task', async () => {
      createTracker()
      const result = await handleTool('add_milestone_task', {
        milestone_id: 'm_integration',
        label: 'New Task',
        priority: 'P1',
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.label === 'New Task')
      expect(task).toBeTruthy()
      expect(task.id).toMatch(/^m_integration_/)
    })

    it('activate_milestone moves from backlog to active', async () => {
      createTracker()
      await handleTool('create_milestone', { id: 'm_activate', title: 'To Activate', domain: 'test' })
      const result = await handleTool('activate_milestone', { milestone_id: 'm_activate' })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      expect(raw.milestones.active.find((m: any) => m.id === 'm_activate')).toBeTruthy()
      expect(raw.milestones.backlog.find((m: any) => m.id === 'm_activate')).toBeFalsy()
    })

    it('enrich_task adds metadata', async () => {
      createTracker()
      const result = await handleTool('enrich_task', {
        task_id: 'm_integration_001',
        prompt: 'new prompt',
        acceptance_criteria: ['criterion A', 'criterion B'],
      })
      expect(result.isError).toBeFalsy()

      const raw = JSON.parse(readRaw())
      const task = raw.milestones.active[0].subtasks.find((t: any) => t.id === 'm_integration_001')
      expect(task.prompt).toBe('new prompt')
      expect(task.acceptance_criteria).toEqual(['criterion A', 'criterion B'])
    })
  })

  describe('validation and error handling', () => {
    it('returns error for unknown tool', async () => {
      const result = await handleTool('nonexistent_tool', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown tool')
    })

    it('returns error for missing required args', async () => {
      const result = await handleTool('start_task', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Invalid args')
    })

    it('returns error for invalid arg types', async () => {
      const result = await handleTool('update_drift', {
        milestone_id: 'm_integration',
        drift_days: 'not_a_number',
      })
      expect(result.isError).toBe(true)
    })
  })
})
