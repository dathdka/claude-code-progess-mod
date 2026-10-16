export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Item = { id: string; label: string; status: TaskStatus }

/** What the pane knows about one other session: the registry's facts joined with its progress record. */
export type SessionState = 'waiting' | 'busy' | 'other'
export type SessionRow = {
  sessionId: string
  name: string
  /** The registry's own word: `busy`, `idle` or anything else it may use. */
  status: string
  state: SessionState
  /** When `status` last changed, ms since epoch; 0 when unknown. */
  statusSince: number
  startedAt: number
  /** False for a session that publishes no progress (the mod is not installed there). */
  hasProgress: boolean
  done: number
  total: number
  current: string
}

/** One quota window as the session usage reports it. */
export type Limit = { kind: 'five_hour' | 'seven_day'; percent: number; resetsAt: string | undefined }
/** What the gauges line shows: the context fill and the quota windows, each 0 to 100. */
export type Readings = { context: number | undefined; limits: Limit[] }
/** The last good usage reading and when it was taken, ms since epoch. */
export type GaugeState = { readings: Readings; at: number }

/** A tool call of this session or one of its subagents that has started and not yet finished. */
export type RunningCall = { id: string; label: string; agentId: string | undefined; startedAt: number }
/** What the session is doing: calls in flight, the last main-session call, and when each subagent was last seen. */
export type Activity = {
  running: RunningCall[]
  last: { label: string; endedAt: number } | undefined
  agents: Record<string, number>
}

/** A repository's branch, changed files (tracked changes plus untracked files) and distance from its upstream. */
export type RepoStatus = { branch: string; changed: number; ahead: number; behind: number }
/** A repository the session has edited: its root, when it was last edited, its last good reading, and failed polls in a row. */
export type Repo = { root: string; touchedAt: number; status: RepoStatus | undefined; failures: number }

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { todos: Item[]; tasks: Item[]; startedAt: number; finishedAt: number; idleCalls: number; sessions: SessionRow[]; gauges: GaugeState | null; activity: Activity; repos: Repo[] }
  }
}
