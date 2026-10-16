import type { Activity } from '../types'

/** A subagent counts for this long after its last call. */
export const AGENT_WINDOW_MS = 15_000
/** The last main-session call is shown for this long after it ends. */
export const LAST_CALL_MS = 60_000
/** A running call shows its elapsed time once it passes this. */
export const SLOW_MS = 2000
/** A call's target (file, command, pattern) is cut to this many characters. */
export const TARGET_MAX = 30
/** A call still "running" after this long is a leftover (an interrupt or a reload lost its end) and is ignored. */
export const STALE_RUNNING_MS = 10 * 60 * 1000
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export const EMPTY_ACTIVITY: Activity = { running: [], last: undefined, agents: {} }

const plain = (value: string): string => value.replace(CONTROL_CHARS, ' ')
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const cut = (value: string): string => plain(value).replace(/\s+/g, ' ').trim().slice(0, TARGET_MAX)
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** The part of a call a person recognises: the file's name, the start of a command, a pattern, an agent's description. */
function callTarget(input: Record<string, unknown>): string {
  const path = text(input.file_path) ?? text(input.notebook_path)
  if (path !== undefined) return cut(baseName(path))

  return cut(text(input.command) ?? text(input.pattern) ?? text(input.description) ?? '')
}

/** `Edit register.tsx`, `Bash git status`; an MCP tool shows without its `mcp__<server>__` prefix. */
export function callLabel(tool: string, input: Record<string, unknown>): string {
  return `${plain(tool).replace(/^mcp__.+?__/, '')} ${callTarget(input)}`.trim()
}

const pruneAgents = (agents: Record<string, number>, now: number): Record<string, number> =>
  Object.fromEntries(Object.entries(agents).filter(([, seen]) => now - seen <= AGENT_WINDOW_MS))

/** A call starts: it is in flight, and a subagent's call also marks that subagent as seen. */
export function begin(state: Activity, call: { id: string; label: string; agentId: string | undefined }, now: number): Activity {
  const agents = call.agentId === undefined ? state.agents : { ...pruneAgents(state.agents, now), [call.agentId]: now }

  return { ...state, running: [...state.running, { ...call, startedAt: now }], agents }
}

/** A call ends: a main-session call becomes the last call, a subagent's marks the subagent as seen again. */
export function end(state: Activity, id: string, now: number): Activity {
  const call = state.running.find(r => r.id === id)
  if (call === undefined) return state
  const running = state.running.filter(r => r.id !== id)
  if (call.agentId === undefined) return { ...state, running, last: { label: call.label, endedAt: now } }

  return { ...state, running, agents: { ...pruneAgents(state.agents, now), [call.agentId]: now } }
}

/** Distinct subagents seen in the last 15 seconds or with a call still running. */
export function agentCount(state: Activity, now: number): number {
  const ids = new Set(Object.keys(pruneAgents(state.agents, now)))
  for (const call of state.running) if (call.agentId !== undefined && now - call.startedAt <= STALE_RUNNING_MS) ids.add(call.agentId)

  return ids.size
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / MS_PER_SECOND)
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`

  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}s`
}

/** The doing line: `▶ <call> [time]` while a main-session call runs, `· <last call> <age> ago` for a minute after, plus `+N agents`. */
export function describeDoing(state: Activity, now: number): { text: string; isRunning: boolean; agents: string } | undefined {
  const count = agentCount(state, now)
  const agents = count === 0 ? '' : `+${count} ${count === 1 ? 'agent' : 'agents'}`
  const main = state.running.find(r => r.agentId === undefined && now - r.startedAt <= STALE_RUNNING_MS)
  if (main !== undefined) {
    const ms = now - main.startedAt

    return { text: `▶ ${main.label}${ms > SLOW_MS ? ` ${elapsed(ms)}` : ''}`, isRunning: true, agents }
  }
  if (state.last !== undefined && now - state.last.endedAt <= LAST_CALL_MS) {
    return { text: `· ${state.last.label} ${elapsed(now - state.last.endedAt)} ago`, isRunning: false, agents }
  }

  return agents === '' ? undefined : { text: '·', isRunning: false, agents }
}

/** The directory of the file an Edit, Write, NotebookEdit or MultiEdit works on; undefined for any other call or a path that is not absolute and clean. */
export function touchedDirectory(tool: string, input: Record<string, unknown>): string | undefined {
  if (!EDIT_TOOLS.includes(tool)) return undefined
  const path = text(input.file_path) ?? text(input.notebook_path)
  if (path === undefined || !path.startsWith('/') || HAS_CONTROL_CHARS.test(path)) return undefined
  const slash = path.lastIndexOf('/')

  return slash <= 0 ? '/' : path.slice(0, slash)
}
