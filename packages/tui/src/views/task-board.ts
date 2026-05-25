import blessed from 'blessed'
import type { Widgets } from 'blessed'
import type { TrackerState, Subtask, Milestone, SubtaskStatus } from '../types.js'
import type { Store } from '../store.js'
import { statusColor, statusIcon } from '../theme.js'

const COLUMNS = [
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'review', label: 'REVIEW' },
  { id: 'done', label: 'DONE' },
  { id: 'blocked', label: 'BLOCKED' },
]

const STATUS_CYCLE: Record<string, SubtaskStatus> = {
  todo: 'in_progress',
  in_progress: 'review',
  review: 'done',
  done: 'todo',
}

function nextTaskId(milestone: Milestone): string {
  const prefix = milestone.id + '_'
  let max = 0
  for (const t of milestone.subtasks || []) {
    const match = t.id.match(new RegExp(`^${milestone.id}_(\\d+)$`))
    if (match) {
      const n = parseInt(match[1], 10)
      if (n > max) max = n
    }
  }
  return prefix + String(max + 1).padStart(3, '0')
}

export function createTaskBoard(
  screen: Widgets.Screen,
  state: TrackerState | null,
  _milestoneIdx: number,
): Widgets.BoxElement {
  const box = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    right: 0,
    bottom: 1,
    keys: true,
    vi: true,
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    style: { bg: '#1a1a2e', fg: '#e0e0e0' },
  })

  let selectedIdx = 0

  function render(s: TrackerState | null) {
    if (!s) {
      box.setContent('{center}{red-fg}No data{/}{/}')
      return
    }

    const allMilestones = [...s.milestones.active, ...s.milestones.backlog]
    if (allMilestones.length === 0) {
      box.setContent('{center}No milestones{/}')
      return
    }

    const current = allMilestones[Math.min(_milestoneIdx, allMilestones.length - 1)]
    const subtasks = current.subtasks || []

    if (selectedIdx >= subtasks.length) selectedIdx = subtasks.length - 1

    const lines: string[] = []

    lines.push('{center}{bold}{#e2b714-fg}═══ TASK BOARD ═══{/}{/}{/}')
    lines.push('')

    const indicator = allMilestones.length > 1 ? ` [${_milestoneIdx + 1}/${allMilestones.length}] ` : ' '
    const key = current.is_key_milestone ? ' ★' : ''
    lines.push(
      `{bold}${current.title}${key}{/}${indicator}{muted}(${current.id}) — ${current.domain} — ${current.phase}{/}`,
    )
    lines.push('')

    const done = subtasks.filter((t) => t.status === 'done').length
    const total = subtasks.length
    lines.push(
      `Progress: ${done}/${total} {muted}│ [ ] navigate  [s] cycle status  [b] block  [Space] select  [a] add task{/}`,
    )
    lines.push('─'.repeat(80))

    if (subtasks.length === 0) {
      lines.push('{muted}  No tasks in this milestone{/}')
      box.setContent(lines.join('\n'))
      return
    }

    let globalIdx = 0
    for (const col of COLUMNS) {
      const tasks = subtasks.filter((t) => t.status === col.id)
      if (tasks.length === 0) continue

      const color = statusColor(col.id)
      lines.push(`{bold}{${color}-fg}${col.label} (${tasks.length}){/}{/}`)

      for (const t of tasks) {
        const icon = statusIcon(t.status)
        const pri = t.priority && t.priority.startsWith('P') ? ` {bold}{${color}-fg}[${t.priority}]{/}{/}` : ''
        const assignee = t.assignee ? ` {muted}→ ${t.assignee}{/}` : ''
        const marker = globalIdx === selectedIdx ? ' {#e2b714-fg}◄{/}' : ''
        lines.push(`  {${color}-fg}${icon}{/} {bold}${t.id}{/}${pri} ${t.label}${assignee}${marker}`)
        globalIdx++
      }
      lines.push('')
    }

    box.setContent(lines.join('\n'))
  }

  function cycleStatus(store: Store) {
    if (!store.state) return
    const allMilestones = [...store.state.milestones.active, ...store.state.milestones.backlog]
    if (allMilestones.length === 0) return
    const current = allMilestones[Math.min(_milestoneIdx, allMilestones.length - 1)]
    const subtasks = current.subtasks || []
    const task = subtasks[selectedIdx]
    if (!task) return
    const next = STATUS_CYCLE[task.status]
    if (next) task.status = next
    store.saveToDisk()
    render(store.state)
  }

  function toggleBlock(store: Store) {
    if (!store.state) return
    const allMilestones = [...store.state.milestones.active, ...store.state.milestones.backlog]
    if (allMilestones.length === 0) return
    const current = allMilestones[Math.min(_milestoneIdx, allMilestones.length - 1)]
    const subtasks = current.subtasks || []
    const task = subtasks[selectedIdx]
    if (!task) return
    if (task.status === 'blocked') {
      task.status = task.assignee ? 'in_progress' : 'todo'
      task.blocked_by = null
      task.blocked_reason = null
    } else {
      task.status = 'blocked'
      task.blocked_reason = 'Manually blocked'
    }
    store.saveToDisk()
    render(store.state)
  }

  function selectNext(store: Store) {
    if (!store.state) return
    const allMilestones = [...store.state.milestones.active, ...store.state.milestones.backlog]
    if (allMilestones.length === 0) return
    const current = allMilestones[Math.min(_milestoneIdx, allMilestones.length - 1)]
    const subtasks = current.subtasks || []
    if (subtasks.length === 0) return
    selectedIdx = (selectedIdx + 1) % subtasks.length
    render(store.state)
  }

  function addTask(parentScreen: Widgets.Screen, store: Store) {
    if (!store.state) return
    const allMilestones = [...store.state.milestones.active, ...store.state.milestones.backlog]
    if (allMilestones.length === 0) return
    const current = allMilestones[Math.min(_milestoneIdx, allMilestones.length - 1)]

    const form = blessed.form({
      parent: parentScreen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 10,
      keys: true,
      vi: true,
      border: { type: 'line', fg: '#e2b714' } as any,
      style: { bg: '#1a1a2e', fg: '#e0e0e0' },
      content: '{bold}Add New Task{/}',
      tags: true,
      shadow: true,
    } as any)

    const labelInput = blessed.textbox({
      parent: form,
      top: 2,
      left: 2,
      width: 44,
      height: 1,
      inputOnFocus: true,
      style: { bg: '#16213e', fg: '#e0e0e0' },
      content: '',
      placeholder: 'Task label...',
    })

    const priorityInput = blessed.textbox({
      parent: form,
      top: 4,
      left: 2,
      width: 20,
      height: 1,
      inputOnFocus: true,
      style: { bg: '#16213e', fg: '#e0e0e0' },
      content: 'P2',
      placeholder: 'Priority: P1, P2, or P3',
    })

    const submitBtn = blessed.button({
      parent: form,
      top: 6,
      left: 2,
      width: 12,
      height: 1,
      content: '{bold}Add{/}',
      tags: true,
      style: { bg: '#0f3460', fg: '#e2b714', focus: { bg: '#e2b714', fg: '#000' } },
    })
    const cancelBtn = blessed.button({
      parent: form,
      top: 6,
      left: 16,
      width: 12,
      height: 1,
      content: '{bold}Cancel{/}',
      tags: true,
      style: { bg: '#0f3460', fg: '#e0e0e0', focus: { bg: '#e0e0e0', fg: '#000' } },
    })

    labelInput.focus()
    parentScreen.render()

    function closeForm() {
      form.detach()
      parentScreen.render()
      box.focus()
    }

    submitBtn.on('press', () => {
      const label = labelInput.value || labelInput.content
      const priority = (priorityInput.value || priorityInput.content || 'P2').toUpperCase()
      if (!label || label.trim() === '') return
      const id = nextTaskId(current)
      const newTask: Subtask = {
        id,
        label: label.trim(),
        status: 'todo',
        assignee: null,
        blocked_by: null,
        blocked_reason: null,
        completed_at: null,
        completed_by: null,
        priority,
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
      }
      current.subtasks.push(newTask)
      store.saveToDisk()
      closeForm()
      render(store.state)
    })

    cancelBtn.on('press', closeForm)

    form.key(['escape'], closeForm)
  }

  render(state)
  ;(box as any)._render = render
  ;(box as any)._cycleStatus = cycleStatus
  ;(box as any)._toggleBlock = toggleBlock
  ;(box as any)._selectNext = selectNext
  ;(box as any)._addTask = addTask
  return box
}
