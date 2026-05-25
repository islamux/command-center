import type { TrackerState, Agent, Subtask, ServiceResult } from 'command-center-shared'
import { fail } from './tracker.service.js'

export type AgentPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'DISPATCH' | 'APPROVE' | 'ADMIN'
export type AgentStatus = 'active' | 'idle' | 'busy' | 'stalled' | 'offline'

export const AGENT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000
export const AGENT_MAX_CONCURRENT = 3

export interface AgentDispatchResult {
  ok: boolean
  agent_id: string | null
  task_id: string | null
  error?: string
  message?: string
}

export function getAgent(state: TrackerState, agentId: string): Agent | undefined {
  return state.agents?.find((a) => a.id === agentId)
}

export function getAvailableAgents(state: TrackerState): Agent[] {
  if (!state.agents) return []
  return state.agents.filter((a) => a.status !== 'offline' && a.status !== 'stalled')
}

export function findBestAgent(state: TrackerState, task: Subtask): Agent | null {
  if (!state.agents) return null

  if (task.agent_target) {
    const target = state.agents.find((a) => a.id === task.agent_target)
    if (target && target.status !== 'offline' && target.status !== 'stalled') {
      return target
    }
  }

  const candidates = getAvailableAgents(state)
  if (candidates.length === 0) return null

  const busyCount: Record<string, number> = {}
  for (const m of [...state.milestones.active, ...state.milestones.backlog]) {
    for (const t of m.subtasks) {
      if (t.status === 'in_progress' && t.assignee) {
        busyCount[t.assignee] = (busyCount[t.assignee] || 0) + 1
      }
    }
  }

  const available = candidates.filter((a) => (busyCount[a.id] || 0) < AGENT_MAX_CONCURRENT)
  if (available.length === 0) return null

  return available.sort((a, b) => {
    const aBusy = busyCount[a.id] || 0
    const bBusy = busyCount[b.id] || 0
    return aBusy - bBusy
  })[0]
}

export function dispatchTask(state: TrackerState, taskId: string, agentId?: string): AgentDispatchResult {
  const agentIdToUse = agentId || 'orchestrator'
  const agent = getAgent(state, agentIdToUse)

  if (!agent) {
    return { ok: false, agent_id: agentIdToUse, task_id: taskId, error: `Agent not found: ${agentIdToUse}` }
  }

  if (!checkPermission(agent, 'EXECUTE')) {
    return {
      ok: false,
      agent_id: agentIdToUse,
      task_id: taskId,
      error: `Agent ${agentIdToUse} lacks EXECUTE permission`,
    }
  }

  if (agent.status === 'offline') {
    return { ok: false, agent_id: agentIdToUse, task_id: taskId, error: `Agent ${agentIdToUse} is offline` }
  }

  const busyCount = getAgentBusyCount(state, agentIdToUse)
  if (busyCount >= AGENT_MAX_CONCURRENT) {
    return {
      ok: false,
      agent_id: agentIdToUse,
      task_id: taskId,
      error: `Agent ${agentIdToUse} is at max capacity (${AGENT_MAX_CONCURRENT})`,
    }
  }

  return {
    ok: true,
    agent_id: agentIdToUse,
    task_id: taskId,
    message: `Task dispatched to ${agent.name} (${agentIdToUse})`,
  }
}

export function checkPermission(agent: Agent, required: AgentPermission): boolean {
  if (agent.permissions.includes('ADMIN')) return true
  return agent.permissions.includes(required)
}

export function getAgentBusyCount(state: TrackerState, agentId: string): number {
  let count = 0
  for (const m of [...state.milestones.active, ...state.milestones.backlog]) {
    for (const t of m.subtasks) {
      if (t.status === 'in_progress' && t.assignee === agentId) {
        count++
      }
    }
  }
  return count
}

export function updateHeartbeat(state: TrackerState, agentId: string): void {
  const agent = getAgent(state, agentId)
  if (!agent) return
  agent.last_action_at = new Date().toISOString()
  agent.status = 'active'
}

export function checkAgentHeartbeats(state: TrackerState): { stalled: string[]; active: number } {
  if (!state.agents) return { stalled: [], active: 0 }
  const now = Date.now()
  const stalled: string[] = []
  let active = 0

  for (const agent of state.agents) {
    if (!agent.last_action_at) {
      continue
    }
    const lastSeen = new Date(agent.last_action_at).getTime()
    const elapsed = now - lastSeen
    if (elapsed > AGENT_HEARTBEAT_TIMEOUT_MS && agent.status === 'active') {
      agent.status = 'stalled'
      stalled.push(agent.id)
    } else if (agent.status === 'active') {
      active++
    }
  }

  return { stalled, active }
}

export function enforceAgentPermission(
  state: TrackerState,
  agentId: string,
  required: AgentPermission,
): ServiceResult | null {
  const agent = getAgent(state, agentId)
  if (!agent) {
    return fail(`Agent not found: ${agentId}`)
  }
  if (!checkPermission(agent, required)) {
    return fail(`Agent \`${agentId}\` lacks ${required} permission (has: ${agent.permissions.join(', ')})`)
  }
  return null
}
