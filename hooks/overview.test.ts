import { expect, test } from 'claude-code/testing'

import type { SessionRow } from '../types'
import { MAX_ROWS, buildRows, describeRow, layoutRow, newlyWaiting, parseTell, resolveTarget, visibleRows } from './overview'
import type { ProgressRecord, RegistryEntry } from './share'

const MIN = 60_000

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  sessionId: 'a',
  pid: 1,
  name: 'alpha',
  kind: 'interactive',
  status: 'busy',
  statusSince: 0,
  startedAt: 0,
  ...over,
})
const record = (over: Partial<ProgressRecord>): ProgressRecord => ({
  v: 1,
  sessionId: 'a',
  done: 1,
  total: 3,
  current: 'doing it',
  updatedAt: 0,
  ...over,
})
const row = (over: Partial<SessionRow>): SessionRow => ({
  sessionId: 'a',
  name: 'alpha',
  status: 'busy',
  state: 'busy',
  statusSince: 0,
  startedAt: 0,
  hasProgress: true,
  done: 1,
  total: 3,
  current: 'doing it',
  ...over,
})

test('rows join the registry with the progress record by session id', () => {
  const [one] = buildRows('me', [entry({ sessionId: 'a' })], [record({ sessionId: 'a', done: 2, total: 5, current: 'x' })])
  expect(one).toEqual(row({ done: 2, total: 5, current: 'x' }))
})

test('a session without a record shows state only', () => {
  const [one] = buildRows('me', [entry({})], [])
  expect(one?.hasProgress).toBe(false)
  expect(one?.total).toBe(0)
})

test('the own session and sessions that are not interactive are left out', () => {
  const rows = buildRows('me', [entry({ sessionId: 'me' }), entry({ sessionId: 'b', kind: 'headless' }), entry({ sessionId: 'c' })], [])
  expect(rows.map(r => r.sessionId)).toEqual(['c'])
})

test('idle means waiting for you, busy is busy, any other word is other', () => {
  const rows = buildRows('me', [entry({ sessionId: 'i', status: 'idle' }), entry({ sessionId: 'b', status: 'busy' }), entry({ sessionId: 'x', status: 'dreaming' })], [])
  const states = Object.fromEntries(rows.map(r => [r.sessionId, r.state]))
  expect(states).toEqual({ i: 'waiting', b: 'busy', x: 'other' })
})

test('an idle session whose tasks are all done is quiet, not waiting', () => {
  const [one] = buildRows('me', [entry({ status: 'idle' })], [record({ done: 3, total: 3 })])
  expect(one?.state).toBe('other')
  const [empty] = buildRows('me', [entry({ status: 'idle' })], [record({ done: 0, total: 0 })])
  expect(empty?.state).toBe('waiting')
})

test('waiting sessions come first, longest wait first, then busy newest first, then the rest by name', () => {
  const rows = buildRows(
    'me',
    [
      entry({ sessionId: 'b1', status: 'busy', startedAt: 100 }),
      entry({ sessionId: 'w2', status: 'idle', statusSince: 900 }),
      entry({ sessionId: 'o2', status: 'zzz', name: 'zeta' }),
      entry({ sessionId: 'b2', status: 'busy', startedAt: 500 }),
      entry({ sessionId: 'w1', status: 'idle', statusSince: 100 }),
      entry({ sessionId: 'o1', status: 'zzz', name: 'beta' }),
    ],
    [],
  )
  expect(rows.map(r => r.sessionId)).toEqual(['w1', 'w2', 'b2', 'b1', 'o1', 'o2'])
})

test('a session without a name is shown by the start of its id', () => {
  const [one] = buildRows('me', [entry({ sessionId: '12345678-aaaa', name: '' })], [])
  expect(one?.name).toBe('12345678')
})

test('at most five rows are shown and the rest are counted', () => {
  const many = Array.from({ length: 8 }, (_, i) => row({ sessionId: `s${i}` }))
  const { shown, more } = visibleRows(many)
  expect(shown.length).toBe(MAX_ROWS)
  expect(more).toBe(3)
  expect(visibleRows(many.slice(0, 2))).toEqual({ shown: many.slice(0, 2), more: 0 })
  expect(visibleRows([])).toEqual({ shown: [], more: 0 })
})

test('a waiting row says how long, a busy row says what it does', () => {
  const waiting = describeRow(row({ state: 'waiting', status: 'idle', statusSince: 10 * MIN }), 14 * MIN)
  expect(waiting).toEqual({ mark: '◆', name: 'alpha', progress: '▰▰▱▱▱▱ 1/3', detail: 'chờ bạn 4m' })
  const busy = describeRow(row({}), 0)
  expect(busy.mark).toBe('▶')
  expect(busy.detail).toBe('doing it')
  expect(describeRow(row({ current: '' }), 0).detail).toBe('busy')
})

test('a finished idle session reads xong; an unknown status shows its word and age', () => {
  const finished = describeRow(row({ state: 'other', status: 'idle', done: 3, total: 3, statusSince: 0 }), 0)
  expect(finished.detail).toBe('xong')
  expect(finished.progress).toBe('▰▰▰▰▰▰ 3/3')
  const odd = describeRow(row({ state: 'other', status: 'dreaming', statusSince: 5 * MIN, hasProgress: false, total: 0, done: 0 }), 8 * MIN)
  expect(odd.mark).toBe('·')
  expect(odd.detail).toBe('dreaming 3m')
  expect(odd.progress).toBe('')
})

test('a session with a record but no tasks says so', () => {
  expect(describeRow(row({ done: 0, total: 0 }), 0).progress).toBe('no tasks')
})

test('only a session that went from busy to idle is newly waiting, never on the first poll', () => {
  const now = [row({ sessionId: 'a', state: 'waiting', status: 'idle' }), row({ sessionId: 'b', state: 'waiting', status: 'idle' }), row({ sessionId: 'c', state: 'busy' })]
  expect(newlyWaiting(undefined, now)).toEqual([])
  const before = new Map([['a', 'busy'], ['b', 'idle'], ['c', 'busy']])
  expect(newlyWaiting(before, now).map(r => r.sessionId)).toEqual(['a'])
  expect(newlyWaiting(new Map(), now)).toEqual([])
})

test('a row is laid out in aligned columns and the detail is cut to the width', () => {
  const text = { mark: '◆', name: 'alpha', progress: '▰▰▱▱▱▱ 2/5', detail: 'chờ bạn 4m' }
  expect(layoutRow(text, 60)).toEqual({ head: '◆ alpha         ', progress: '▰▰▱▱▱▱ 2/5  ', detail: 'chờ bạn 4m' })
  expect(layoutRow(text, 40).detail).toBe('chờ bạn 4m')
  expect(layoutRow(text, 36).detail).toBe('chờ b…')
  expect(layoutRow(text, 10).detail).toBe('')
  expect(layoutRow({ ...text, name: 'a-very-long-session-name' }, 60).head.length).toBe(16)
})

test('a tell command is a name prefix, then the message', () => {
  expect(parseTell('alpha hello there')).toEqual({ query: 'alpha', text: 'hello there' })
  expect(parseTell('  alpha   spaced  out ')).toEqual({ query: 'alpha', text: 'spaced  out' })
  expect(parseTell('alpha')).toBeUndefined()
  expect(parseTell('   ')).toBeUndefined()
  expect(parseTell('')).toBeUndefined()
})

test('a name prefix picks exactly one session, ignoring case', () => {
  const rows = [row({ sessionId: 'aaaa1111-x', name: 'Sync giá AI' }), row({ sessionId: 'bbbb2222-y', name: 'syntax' }), row({ sessionId: 'cccc3333-z', name: 'docs' })]
  expect(resolveTarget(rows, 'DOC')).toEqual({ row: rows[2] })
  expect(resolveTarget(rows, 'sync')).toEqual({ row: rows[0] })
  expect(resolveTarget(rows, 'sy')).toEqual({ error: '"sy" matches: Sync giá AI (aaaa1111), syntax (bbbb2222)' })
  expect(resolveTarget(rows, 'zzz')).toEqual({ error: 'no session starts with "zzz"' })
})

test('an id prefix works too, and an exact name wins over longer ones', () => {
  const rows = [row({ sessionId: 'abc123', name: 'docs' }), row({ sessionId: 'def456', name: 'docs-old' })]
  expect(resolveTarget(rows, 'abc')).toEqual({ row: rows[0] })
  expect(resolveTarget(rows, 'docs')).toEqual({ row: rows[0] })
})

test('two sessions with the same name are told apart by their id prefix', () => {
  const rows = [row({ sessionId: 'aaaa1111-x', name: 'docs' }), row({ sessionId: 'bbbb2222-y', name: 'docs' })]
  expect(resolveTarget(rows, 'docs')).toEqual({ error: '"docs" matches: docs (aaaa1111), docs (bbbb2222)' })
  expect(resolveTarget(rows, 'aaaa')).toEqual({ row: rows[0] })
  expect(resolveTarget(rows, 'bbbb2222')).toEqual({ row: rows[1] })
})
