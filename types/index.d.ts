export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Item = { id: string; label: string; status: TaskStatus }

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { todos: Item[]; tasks: Item[] }
  }
}
