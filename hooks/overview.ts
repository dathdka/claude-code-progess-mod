import type { SessionRow, SessionState } from '../types'
import { formatDuration } from './progress'
import type { ProgressRecord, RegistryEntry } from './share'
import { truncate } from './style'

export const MAX_ROWS = 5
const INTERACTIVE = 'interactive'
const BAR_CELLS = 6
const ID_PREFIX = 8
const MARKS: Readonly<Record<SessionState, string>> = { waiting: '◆', busy: '▶', other: '·' }

export type RowText = { mark: string; name: string; progress: string; detail: string }

const isFinished = (done: number, total: number): boolean => total > 0 && done >= total

function stateOf(status: string, done: number, total: number): SessionState {
  if (status === 'busy') return 'busy'
  if (status === 'idle') return isFinished(done, total) ? 'other' : 'waiting'

  return 'other'
}

const RANK: Readonly<Record<SessionState, number>> = { waiting: 0, busy: 1, other: 2 }

function compare(a: SessionRow, b: SessionRow): number {
  if (a.state !== b.state) return RANK[a.state] - RANK[b.state]
  if (a.state === 'waiting') return a.statusSince - b.statusSince
  if (a.state === 'busy') return b.startedAt - a.startedAt

  return a.name.localeCompare(b.name)
}

/** The other interactive sessions, waiting ones first. The own session is the pane's main content, not a row. */
export function buildRows(selfId: string, entries: readonly RegistryEntry[], records: readonly ProgressRecord[]): SessionRow[] {
  const byId = new Map(records.map(r => [r.sessionId, r]))

  return entries
    .filter(e => e.sessionId !== selfId && e.kind === INTERACTIVE)
    .map(e => {
      const r = byId.get(e.sessionId)
      const done = r?.done ?? 0
      const total = r?.total ?? 0

      return {
        sessionId: e.sessionId,
        name: e.name === '' ? e.sessionId.slice(0, ID_PREFIX) : e.name,
        status: e.status,
        state: stateOf(e.status, done, total),
        statusSince: e.statusSince,
        startedAt: e.startedAt,
        hasProgress: r !== undefined,
        done,
        total,
        current: r?.current ?? '',
      }
    })
    .sort(compare)
}

export function visibleRows(rows: readonly SessionRow[]): { shown: SessionRow[]; more: number } {
  return { shown: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS) }
}

function miniBar(done: number, total: number): string {
  const filled = Math.min(BAR_CELLS, Math.round((done / total) * BAR_CELLS))

  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_CELLS - filled)}`
}

function detailOf(row: SessionRow, now: number): string {
  const age = row.statusSince > 0 ? ` ${formatDuration(now - row.statusSince)}` : ''
  if (row.state === 'waiting') return `chờ bạn${age}`
  if (row.state === 'busy') return row.current === '' ? 'busy' : row.current
  if (row.status === 'idle') return 'xong'

  return `${row.status === '' ? '?' : row.status}${age}`
}

export function describeRow(row: SessionRow, now: number): RowText {
  const progress = !row.hasProgress ? '' : row.total === 0 ? 'no tasks' : `${miniBar(row.done, row.total)} ${row.done}/${row.total}`

  return { mark: MARKS[row.state], name: row.name, progress, detail: detailOf(row, now) }
}

/** Sessions that were busy at the last poll and are idle now. The first poll (no `before`) is not news. */
export function newlyWaiting(before: ReadonlyMap<string, string> | undefined, rows: readonly SessionRow[]): SessionRow[] {
  if (before === undefined) return []

  return rows.filter(r => r.state === 'waiting' && before.get(r.sessionId) === 'busy')
}

const NAME_WIDTH = 14
const PROGRESS_WIDTH = 12

/** A row cut to fit `width` cells, in three columns the pane colours separately. */
export function layoutRow(text: RowText, width: number): { head: string; progress: string; detail: string } {
  const head = `${text.mark} ${truncate(text.name, NAME_WIDTH).padEnd(NAME_WIDTH)}`
  const progress = text.progress.padEnd(PROGRESS_WIDTH)
  const room = Math.max(0, width - head.length - PROGRESS_WIDTH - 2)

  return { head, progress, detail: truncate(text.detail, room) }
}

/** `/task-progress-tell <name> <text>`: the first word picks the session, the rest is the message. */
export function parseTell(args: string): { query: string; text: string } | undefined {
  const match = /^\s*(\S+)\s+(\S[\s\S]*?)\s*$/.exec(args)

  return match === null ? undefined : { query: match[1] ?? '', text: match[2] ?? '' }
}

/** One session whose name (or id) starts with `query`; an exact name wins over longer ones. */
export function resolveTarget(rows: readonly SessionRow[], query: string): { row: SessionRow } | { error: string } {
  const wanted = query.toLowerCase()
  const exact = rows.filter(r => r.name.toLowerCase() === wanted)
  if (exact.length === 1 && exact[0] !== undefined) return { row: exact[0] }
  const matches = rows.filter(r => r.name.toLowerCase().startsWith(wanted) || r.sessionId.toLowerCase().startsWith(wanted))
  if (matches.length === 1 && matches[0] !== undefined) return { row: matches[0] }
  if (matches.length === 0) return { error: `no session starts with "${query}"` }

  return { error: `"${query}" matches: ${matches.map(r => `${r.name} (${r.sessionId.slice(0, ID_PREFIX)})`).join(', ')}` }
}
