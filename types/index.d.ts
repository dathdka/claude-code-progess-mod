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

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { todos: Item[]; tasks: Item[]; startedAt: number; finishedAt: number; idleCalls: number; sessions: SessionRow[] }
  }
}
