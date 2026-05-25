import blessed from 'blessed'
import type { Widgets } from 'blessed'
import type { TrackerState, Milestone } from '../types.js'
import type { Store } from '../store.js'

export function createSwimLane(
  screen: Widgets.Screen,
  state: TrackerState | null,
  milestoneIdx: number,
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

  ;(box as any)._milestoneIdx = milestoneIdx

  function render(s: TrackerState | null) {
    if (!s) {
      box.setContent('{center}{red-fg}No data{/}{/}')
      return
    }

    const completed = s.milestones.completed
    const lines: string[] = []

    lines.push('{center}{bold}{#e2b714-fg}═══ SWIM LANE ═══{/}{/}{/}')
    lines.push('')

    lines.push('{bold} ACTIVE MILESTONES{/}')
    lines.push('─'.repeat(70))
    for (const m of s.milestones.active) {
      const done = (m.subtasks || []).filter((t) => t.status === 'done').length
      const total = (m.subtasks || []).length
      const pct = total > 0 ? Math.round((done / total) * 100) : 0
      const bar = progressBar(pct, 20)
      const key = m.is_key_milestone ? ' ★' : ''
      lines.push(`  {bold}${m.title}{/} ${key} {muted}(${m.id}){/}`)
      lines.push(`  ${bar} ${pct}%  ${done}/${total} tasks  Phase: ${m.phase}  Domain: ${m.domain}`)
      if (m.planned_start) {
        lines.push(
          `  {muted}Planned: ${m.planned_start} → ${m.planned_end || '?'}{/}  ${m.actual_start ? `Actual: ${m.actual_start} → ${m.actual_end || '?'}` : ''}`,
        )
      }
      lines.push(`  {muted}Drift: ${m.drift_days}d  Notes: ${m.notes.length}{/}`)
      lines.push('')
    }

    if (s.milestones.active.length === 0) {
      lines.push('  {muted}(no active milestones){/}')
      lines.push('')
    }

    lines.push('{bold} BACKLOG{/}')
    lines.push('─'.repeat(70))
    for (const m of s.milestones.backlog) {
      const done = (m.subtasks || []).filter((t) => t.status === 'done').length
      const total = (m.subtasks || []).length
      const key = m.is_key_milestone ? ' ★' : ''
      lines.push(`  {muted}${m.title}${key} (${m.id}) — ${done}/${total} tasks — ${m.phase}{/}`)
    }
    if (s.milestones.backlog.length === 0) {
      lines.push('  {muted}(backlog empty){/}')
    }
    lines.push('')

    lines.push('{bold} COMPLETED{/}')
    lines.push('─'.repeat(70))
    for (const c of completed.slice(-5)) {
      lines.push(`  {green-fg}✓ ${c.title}{/} {muted}(${c.completed_at}){/}`)
    }
    if (completed.length > 5) {
      lines.push(`  {muted}... and ${completed.length - 5} more{/}`)
    }

    box.setContent(lines.join('\n'))
  }

  function editMilestone(parentScreen: Widgets.Screen, store: Store) {
    if (!store.state) return
    const all = [...store.state.milestones.active, ...store.state.milestones.backlog]
    if (all.length === 0) return
    const milestone = all[Math.min(milestoneIdx, all.length - 1)]

    const form = blessed.form({
      parent: parentScreen,
      top: 'center',
      left: 'center',
      width: 56,
      height: 14,
      keys: true,
      vi: true,
      border: { type: 'line', fg: '#e2b714' } as any,
      style: { bg: '#1a1a2e', fg: '#e0e0e0' },
      content: `{bold}Edit Milestone: ${milestone.title}{/}`,
      tags: true,
      shadow: true,
    } as any)

    let y = 2
    const plannedStart = blessed.textbox({
      parent: form,
      top: y,
      left: 2,
      width: 48,
      height: 1,
      inputOnFocus: true,
      style: { bg: '#16213e', fg: '#e0e0e0' },
      content: milestone.planned_start || '',
      placeholder: 'Planned start (YYYY-MM-DD)',
    })
    y += 2
    const plannedEnd = blessed.textbox({
      parent: form,
      top: y,
      left: 2,
      width: 48,
      height: 1,
      inputOnFocus: true,
      style: { bg: '#16213e', fg: '#e0e0e0' },
      content: milestone.planned_end || '',
      placeholder: 'Planned end (YYYY-MM-DD)',
    })
    y += 2
    const driftInput = blessed.textbox({
      parent: form,
      top: y,
      left: 2,
      width: 48,
      height: 1,
      inputOnFocus: true,
      style: { bg: '#16213e', fg: '#e0e0e0' },
      content: String(milestone.drift_days),
      placeholder: 'Drift days',
    })
    y += 2
    const saveBtn = blessed.button({
      parent: form,
      top: y,
      left: 2,
      width: 12,
      height: 1,
      content: '{bold}Save{/}',
      tags: true,
      style: { bg: '#0f3460', fg: '#e2b714', focus: { bg: '#e2b714', fg: '#000' } },
    })
    const cancelBtn = blessed.button({
      parent: form,
      top: y,
      left: 16,
      width: 12,
      height: 1,
      content: '{bold}Cancel{/}',
      tags: true,
      style: { bg: '#0f3460', fg: '#e0e0e0', focus: { bg: '#e0e0e0', fg: '#000' } },
    })

    plannedStart.focus()
    parentScreen.render()

    function closeForm() {
      form.detach()
      parentScreen.render()
      box.focus()
    }

    saveBtn.on('press', () => {
      const ps = plannedStart.value || plannedStart.content
      const pe = plannedEnd.value || plannedEnd.content
      const dr = parseInt(driftInput.value || driftInput.content, 10) || 0
      if (ps) milestone.planned_start = ps
      if (pe) milestone.planned_end = pe
      milestone.drift_days = dr
      store.saveToDisk()
      closeForm()
      render(store.state)
    })

    cancelBtn.on('press', closeForm)
    form.key(['escape'], closeForm)
  }

  render(state)
  ;(box as any)._render = render
  ;(box as any)._editMilestone = editMilestone
  return box
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  return `{green-fg}${'█'.repeat(filled)}{/}{#333355-fg}${'░'.repeat(empty)}{/}`
}
