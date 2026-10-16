import type { Item, TaskStatus } from '../types'
import { PROGRESS_TOOL, STALE_CALLS } from './constants'

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

export const summarize = (items: Item[]) => {
  const done = items.filter(i => i.status === 'completed').length
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100)

  return { done, total: items.length, percent }
}

export function parseProgressInput(raw: unknown): Item[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const items: Item[] = []
  for (const [index, entry] of raw.entries()) {
    const subject = (entry as { subject?: unknown } | null)?.subject
    const status = (entry as { status?: unknown } | null)?.status
    if (typeof subject !== 'string' || !STATUSES.includes(status as TaskStatus)) return undefined
    items.push({ id: String(index), label: subject, status: status as TaskStatus })
  }

  return items
}

export const mark = (status: TaskStatus) =>
  status === 'completed' ? '✔' : status === 'in_progress' ? '▶' : '○'

export const isOk = (ran: { deny?: string; isError?: boolean }) =>
  ran.deny === undefined && ran.isError !== true

/** The elements that are there, without the nulls left by a line with nothing to show. */
export function present<T>(list: ReadonlyArray<T | null>): T[] {
  return list.filter((entry): entry is T => entry !== null)
}

/** The note for the model at the 10th, 20th, 30th… call without a list update while a task is in progress; undefined otherwise. */
export function staleReminder(idle: number, hasInProgress: boolean): string | undefined {
  if (!hasInProgress || idle < STALE_CALLS || (idle - STALE_CALLS) % STALE_CALLS !== 0) return undefined

  return `task-progress: the pane's task list has not been updated for ${idle} tool calls while a task is in progress. Call ${PROGRESS_TOOL} now with the full list and the current status of every task (keep every task as its own entry).`
}

/** The result with the stale reminder added after any context it already carries; the same result when none is due. */
export function withReminder<T extends { context?: readonly string[] }>(ran: T, idle: number, items: readonly Item[]): T {
  const text = staleReminder(idle, items.some(i => i.status === 'in_progress'))

  return text === undefined ? ran : { ...ran, context: [...(ran.context ?? []), text] }
}
