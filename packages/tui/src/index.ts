import blessed from 'blessed'
import type { Widgets } from 'blessed'
import { Store } from './store.js'
import { createTabBar } from './components/tab-bar.js'
import { createStatusBar } from './components/status-bar.js'
import { createSwimLane } from './views/swim-lane.js'
import { createTaskBoard } from './views/task-board.js'
import { createAgentHub } from './views/agent-hub.js'
import { createCalendar } from './views/calendar.js'
import chokidar from 'chokidar'
import { getTrackerPath } from './config.js'

let activeTab = 0
let milestoneIdx = 0
let isDark = true
let currentView: Widgets.BoxElement | null = null

const screen = blessed.screen({
  smartCSR: true,
  title: 'Command Center',
  fullUnicode: true,
})

screen.key(['q', 'C-c'], () => {
  process.exit(0)
})

screen.key(['1', '2', '3', '4'], (_ch: any, key: any) => {
  const tab = parseInt(key.ch, 10) - 1
  if (tab !== activeTab) {
    activeTab = tab
    renderAll()
  }
})

screen.key(['[', ']'], (_ch: any, key: any) => {
  if (!store.state) return
  const all = [...store.state.milestones.active, ...store.state.milestones.backlog]
  if (all.length === 0) return
  if (key.ch === '[') {
    milestoneIdx = (milestoneIdx - 1 + all.length) % all.length
  } else {
    milestoneIdx = (milestoneIdx + 1) % all.length
  }
  renderAll()
})

screen.key(['r'], () => {
  store.loadFromDisk()
  renderAll()
})

screen.key(['t'], () => {
  isDark = !isDark
  const bg = isDark ? '#1a1a2e' : '#fafafa'
  const fg = isDark ? '#e0e0e0' : '#1a1a2e'
  ;(screen as any).style = { bg, fg }
  if (currentView) {
    ;(currentView as any).style = { bg, fg }
  }
  screen.render()
})

screen.key(['?'], () => {
  const helpText = [
    '{bold}Keyboard Shortcuts{/}',
    '',
    '  {bold}1-4{/}    Switch tabs: Swim Lane, Task Board, Agent Hub, Calendar',
    '  {bold}[{/} / {bold}]{/}    Cycle through milestones (previous/next)',
    '  {bold}r{/}     Reload tracker data from disk',
    '  {bold}t{/}     Toggle dark/light theme',
    '  {bold}?{/}     Show this help dialog',
    '  {bold}q{/}     Quit',
    '',
    '{bold}Task Board (Tab 2){/}',
    '  {bold}Space{/}  Select next task',
    '  {bold}s{/}     Cycle status: todo → in_progress → review → done → todo',
    '  {bold}b{/}     Block/unblock selected task',
    '  {bold}a{/}     Create a new task',
    '',
    '{bold}Swim Lane (Tab 1){/}',
    '  {bold}e{/}     Edit milestone dates/drift',
    '',
    'Press {bold}ESC{/} or {bold}Enter{/} to close.',
  ].join('\n')

  const helpBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 56,
    height: 26,
    content: helpText,
    tags: true,
    border: { type: 'line', fg: '#e2b714' } as any,
    style: { bg: '#1a1a2e', fg: '#e0e0e0', border: { fg: '#e2b714' } } as any,
    keys: true,
    vi: true,
    shadow: true,
  } as any)

  helpBox.focus()
  screen.render()

  helpBox.key(['escape', 'return', 'q', '?'], () => {
    helpBox.detach()
    screen.render()
    currentView?.focus()
  })
})

screen.key(['s'], () => {
  if (activeTab !== 1) return
  const boardView = currentView as any
  if (boardView?._cycleStatus) {
    boardView._cycleStatus(store)
  }
})

screen.key(['b'], () => {
  if (activeTab !== 1) return
  const boardView = currentView as any
  if (boardView?._toggleBlock) {
    boardView._toggleBlock(store)
  }
})

screen.key(['space'], (_ch: any, _key: any) => {
  if (activeTab !== 1) return
  const boardView = currentView as any
  if (boardView?._selectNext) {
    boardView._selectNext(store)
  }
})

screen.key(['a'], () => {
  if (activeTab !== 1) return
  const boardView = currentView as any
  if (boardView?._addTask) {
    boardView._addTask(screen, store)
  }
})

screen.key(['e'], () => {
  if (activeTab !== 0) return
  const swimView = currentView as any
  if (swimView?._editMilestone) {
    swimView._editMilestone(screen, store)
  }
})

function showErrorScreen(message: string) {
  const errorBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 60,
    height: 8,
    content: `{center}{red-fg}ERROR{/}{/}\n\n${message}\n\n{center}Press {bold}r{/} to retry or {bold}q{/} to quit.{/}`,
    tags: true,
    border: { type: 'line', fg: 'red' } as any,
    style: { bg: '#1a1a2e', fg: '#e0e0e0' },
  } as any)
  errorBox.focus()
  screen.render()

  screen.key(['r'], () => {
    store.loadFromDisk()
    if (store.state) {
      errorBox.detach()
      renderAll()
    } else {
      errorBox.setContent(
        `{center}{red-fg}ERROR{/}{/}\n\n${store.loadError}\n\n{center}Press {bold}r{/} to retry or {bold}q{/} to quit.{/}`,
      )
      screen.render()
    }
  })
}

let tabBar: Widgets.BoxElement | null = null
let statusBar: Widgets.BoxElement | null = null
let lastTab = -1
let lastMilestoneIdx = -1

function renderAll(fullRebuild = false) {
  const s = store.state

  if (!s) {
    if (currentView) {
      screen.remove(currentView)
      currentView.destroy()
      currentView = null
    }
    showErrorScreen(store.loadError || 'Unknown error loading tracker data.')
    return
  }

  const milestoneChanged = milestoneIdx !== lastMilestoneIdx
  const needsRebuild = fullRebuild || activeTab !== lastTab || milestoneChanged

  if (needsRebuild) {
    lastTab = activeTab
    lastMilestoneIdx = milestoneIdx
    if (currentView) {
      screen.remove(currentView)
      currentView.destroy()
      currentView = null
    }
    switch (activeTab) {
      case 0:
        currentView = createSwimLane(screen, s, milestoneIdx)
        break
      case 1:
        currentView = createTaskBoard(screen, s, milestoneIdx)
        break
      case 2:
        currentView = createAgentHub(screen, s)
        break
      case 3:
        currentView = createCalendar(screen, s)
        break
    }
    if (tabBar) {
      screen.remove(tabBar)
      tabBar.destroy()
    }
    if (statusBar) {
      screen.remove(statusBar)
      statusBar.destroy()
    }
    tabBar = createTabBar(screen, activeTab, () => {})
    statusBar = createStatusBar(screen, s, store)
  } else {
    const renderFn = (currentView as any)?._render
    if (renderFn) renderFn(s)
    const statusRenderFn = (statusBar as any)?._render
    if (statusRenderFn) statusRenderFn(s)
  }

  currentView?.focus()
  screen.render()
}

const store = new Store()

try {
  const trackerPath = getTrackerPath()
  chokidar.watch(trackerPath, { ignoreInitial: true }).on('change', () => {
    if (store.loadFromDisk()) {
      renderAll()
    }
  })
} catch {
  /* no watch */
}

if (!store.state) {
  showErrorScreen(store.loadError || 'Could not load tracker data.')
} else {
  renderAll()
}
screen.render()
