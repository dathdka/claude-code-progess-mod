import type { Item } from '../types'
import { truncate } from './style'

export const RECORD_VERSION = 1
export const CURRENT_MAX = 60

/** What a session publishes about its own task list: one small JSON file per session. */
export type ProgressRecord = {
  v: typeof RECORD_VERSION
  sessionId: string
  done: number
  total: number
  current: string
  updatedAt: number
}

/** The facts the pane uses from Claude Code's own `~/.claude/sessions/<pid>.json`. */
export type RegistryEntry = {
  sessionId: string
  pid: number
  name: string
  kind: string
  status: string
  statusSince: number
  startedAt: number
}

export function progressRecord(sessionId: string, items: ReadonlyArray<Item>, now: number): ProgressRecord {
  const current = items.find(i => i.status === 'in_progress')?.label ?? ''

  return {
    v: RECORD_VERSION,
    sessionId,
    done: items.filter(i => i.status === 'completed').length,
    total: items.length,
    current: truncate(current, CURRENT_MAX),
    updatedAt: now,
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

/** Text from another session's file is drawn in this pane: a newline or an escape in it must not split a row. */
const plain = (value: string): string => value.replace(CONTROL_CHARS, ' ')

/** A half-written or foreign file is not an error: it is simply not a record. */
export function parseRecord(raw: string): ProgressRecord | undefined {
  const o = parseObject(raw)
  if (o === undefined || o.v !== RECORD_VERSION) return undefined
  const { sessionId, done, total, current, updatedAt } = o
  if (typeof sessionId !== 'string' || sessionId === '' || typeof current !== 'string') return undefined
  if (!isCount(done) || !isCount(total) || !isCount(updatedAt)) return undefined

  return { v: RECORD_VERSION, sessionId, done, total, current: truncate(plain(current), CURRENT_MAX), updatedAt }
}

export function parseRegistry(raw: string): RegistryEntry | undefined {
  const o = parseObject(raw)
  if (o === undefined || typeof o.sessionId !== 'string' || o.sessionId === '' || !isCount(o.pid)) return undefined

  return {
    sessionId: o.sessionId,
    pid: o.pid,
    name: plain(text(o.name)),
    kind: text(o.kind),
    status: plain(text(o.status)),
    statusSince: isCount(o.statusUpdatedAt) ? o.statusUpdatedAt : 0,
    startedAt: isCount(o.startedAt) ? o.startedAt : 0,
  }
}
