# Session Overview (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each task-progress pane show the other Claude Code sessions on this machine (name, state, task progress, who is waiting for the user), alert when one starts waiting, and let the user message one.

**Architecture:** Every session publishes a small JSON record of its own task progress to `<claude config dir>/task-progress/<sessionId>.json`. Every 3 s each pane reads Claude Code's own session registry (`<config dir>/sessions/*.json`) plus those records, joins them by `sessionId` into rows (`overview.ts`, pure), keeps the rows in plugin state and draws a block under the timing line. `share.ts` (pure) defines and parses the two file formats; `sync.ts` is the only module that touches the file system and processes. `register.tsx` only wires them.

**Tech Stack:** TypeScript hooks module for the Claude Code plugin API (`claude plugin test`, `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-10-15-p3-session-overview-design.md` (rev 2, approved). Builds on P1 and the progress-reporting fixes, both already in the working tree.

## Global Constraints

- Repo is `~/claude-mods/task-progress`; every path is relative to it. Run commands from there.
- **Do not commit or push** unless the user explicitly asks. The plan has no commit steps on purpose.
- Run all tests with `claude plugin test .` (40 pass before this work, 78 after).
- Type-check with `tsc -p /tmp/task-progress-tsconfig.json` (no output means clean). Create that file once if it is missing, exactly as the P1 plan's Global Constraints describe (the `claude-code.d.ts` path comes from `find /tmp/claude-*/bundled-skills -name claude-code.d.ts | head -1`; the tsconfig sets `strict`, `noUncheckedIndexedAccess`, `jsx: react` with factory `h`, `types: []`, `noEmit: true`, and includes that file, `hooks/` and `types/`). `<path-to>/node_modules/.bin/tsc` is a suitable compiler. **Never run `tsc` with `--noEmit false`**: it writes `.js` files into `hooks/`.
- Validate with `claude plugin validate .` (expect `Validation passed with warnings`).
- Hooks module environment: ES modules, no Node, no DOM, imports without file extensions. The file API cannot delete: removal is `$.process.run(['rm', '-f', path])`. A `command.run` hook is cut at 10 s.
- Shared formats, verbatim from the spec: progress record `{ "v": 1, "sessionId", "done", "total", "current" (at most 60 characters), "updatedAt" }` in `<config dir>/task-progress/<sessionId>.json`, under 400 bytes; registry entry `<config dir>/sessions/<pid>.json` read for `sessionId`, `pid`, `name`, `kind`, `status`, `statusUpdatedAt`, `startedAt`. Config dir is `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`.
- Limits: poll every 3000 ms; at most 12 registry files read and the records of those sessions (24 reads); at most 5 rows shown, then `+N more`; a record of a dead session is removed once its file is older than 24 h.
- Row text, verbatim: marks `◆` waiting, `▶` busy, `·` other; `chờ bạn <age>`, `xong`, `no tasks`, `<status> <age>`; toast `◆ <names> waiting for you`; usage `Usage: /task-progress-tell <session name> <message>`.
- Every file system or process call of this feature is wrapped: failure is logged once to the debug channel and never reaches the session or the render hook.
- Tests that need the world beneath the plugin must register their `on(...)` hooks before the first `$` call.

## Review Focus

Inputs and conditions the spec implies but no task text spells out; each has a test in the task that owns the code.

1. After `/clear` the session id changes: the record of the id that ended is the one removed. Task 3, register test.
2. Half-written or foreign JSON in either directory is skipped, not fatal. Task 4, register test.
3. The first poll must not alert for sessions that were already idle. Task 5, register test.
4. `~/.claude/task-progress/` does not exist yet (first run), or `fs.list` fails: sessions still show with state only, or the old rows stay. Task 4, register tests.
5. More than 12 sessions: reads are capped and the pane shows 5 rows plus `+N more`. Task 4, register test.
6. A session named with spaces and diacritics (`Sync giá AI`) can be addressed by a prefix, and an ambiguous prefix names the candidates. Task 6, overview test.

## File Structure

| File | Responsibility |
|---|---|
| `types/index.d.ts` (modify) | `SessionRow`, `SessionState` types and the `sessions` state key |
| `hooks/share.ts` (new) | record and registry types, `progressRecord`, `parseRecord`, `parseRegistry` |
| `hooks/overview.ts` (new) | `buildRows`, `visibleRows`, `describeRow`, `layoutRow`, `newlyWaiting`, `parseTell`, `resolveTarget` |
| `hooks/sync.ts` (new) | the only file-system code: `configDir`, `publishProgress`, `removeRecord`, `pollSessions` |
| `hooks/register.tsx` (modify) | publishes on every list change, polls, draws the block, toast and jingle, `/task-progress-tell` |
| `hooks/register.test.ts` (modify) | a mock disk and the integration tests |
| `README.md`, `.claude-plugin/plugin.json` (modify) | docs, option `isWaitSoundOn`, version 0.7.0 |

---

### Task 1: Record and registry formats

**Files:**
- Create: `hooks/share.ts`
- Test: `hooks/share.test.ts`

**Interfaces:**
- Consumes: `Item` from `types/index.d.ts`, `truncate` from `hooks/style.ts`.
- Produces: `RECORD_VERSION = 1`, `CURRENT_MAX = 60`; `type ProgressRecord = { v: 1; sessionId: string; done: number; total: number; current: string; updatedAt: number }`; `type RegistryEntry = { sessionId: string; pid: number; name: string; kind: string; status: string; statusSince: number; startedAt: number }`; `progressRecord(sessionId: string, items: ReadonlyArray<Item>, now: number): ProgressRecord`; `parseRecord(raw: string): ProgressRecord | undefined`; `parseRegistry(raw: string): RegistryEntry | undefined`.

- [ ] **Step 1: Write the failing test**

Create `hooks/share.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { CURRENT_MAX, RECORD_VERSION, parseRecord, parseRegistry, progressRecord } from './share'

const ITEMS = [
  { id: '0', label: 'first', status: 'completed' },
  { id: '1', label: 'second', status: 'in_progress' },
  { id: '2', label: 'third', status: 'pending' },
] as const

test('a record counts done and total and names the task in progress', () => {
  expect(progressRecord('s1', ITEMS, 1000)).toEqual({
    v: RECORD_VERSION,
    sessionId: 's1',
    done: 1,
    total: 3,
    current: 'second',
    updatedAt: 1000,
  })
})

test('a record with no task in progress has an empty current, and a long label is cut', () => {
  expect(progressRecord('s1', [], 5)).toEqual({ v: 1, sessionId: 's1', done: 0, total: 0, current: '', updatedAt: 5 })
  const long = [{ id: '0', label: 'x'.repeat(200), status: 'in_progress' }] as const
  expect(progressRecord('s1', long, 5).current.length).toBe(CURRENT_MAX)
})

test('a record survives the round trip through JSON', () => {
  const record = progressRecord('s1', ITEMS, 1000)
  expect(parseRecord(JSON.stringify(record))).toEqual(record)
})

test('parseRecord refuses junk, other versions and wrong types', () => {
  const good = { v: 1, sessionId: 's1', done: 1, total: 2, current: '', updatedAt: 9 }
  expect(parseRecord('')).toBeUndefined()
  expect(parseRecord('{"v":1,"sessionId":"s1","done":1')).toBeUndefined()
  expect(parseRecord('[]')).toBeUndefined()
  expect(parseRecord('null')).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, v: 2 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, sessionId: '' }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, done: '1' }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, total: -1 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, current: 3 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify(good))).toEqual(good)
})

test('parseRegistry reads a session file and fills what is missing', () => {
  const text = JSON.stringify({
    pid: 42,
    sessionId: 'abc',
    name: 'Sync giá AI',
    kind: 'interactive',
    status: 'idle',
    statusUpdatedAt: 7000,
    startedAt: 1000,
    cwd: '/x',
  })
  expect(parseRegistry(text)).toEqual({
    sessionId: 'abc',
    pid: 42,
    name: 'Sync giá AI',
    kind: 'interactive',
    status: 'idle',
    statusSince: 7000,
    startedAt: 1000,
  })
  expect(parseRegistry('{"pid":1,"sessionId":"z"}')).toEqual({
    sessionId: 'z',
    pid: 1,
    name: '',
    kind: '',
    status: '',
    statusSince: 0,
    startedAt: 0,
  })
})

test('parseRegistry refuses junk and entries without an id or a pid', () => {
  expect(parseRegistry('nope')).toBeUndefined()
  expect(parseRegistry('{"pid":1}')).toBeUndefined()
  expect(parseRegistry('{"sessionId":"z"}')).toBeUndefined()
  expect(parseRegistry('{"sessionId":"z","pid":"1"}')).toBeUndefined()
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `claude plugin test .`
Expected: `hooks/share.test.ts: cannot import "./share"` as a failed file; the other 40 tests pass.

- [ ] **Step 3: Write the implementation**

Create `hooks/share.ts`:

```ts
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

/** A half-written or foreign file is not an error: it is simply not a record. */
export function parseRecord(raw: string): ProgressRecord | undefined {
  const o = parseObject(raw)
  if (o === undefined || o.v !== RECORD_VERSION) return undefined
  const { sessionId, done, total, current, updatedAt } = o
  if (typeof sessionId !== 'string' || sessionId === '' || typeof current !== 'string') return undefined
  if (!isCount(done) || !isCount(total) || !isCount(updatedAt)) return undefined

  return { v: RECORD_VERSION, sessionId, done, total, current: truncate(current, CURRENT_MAX), updatedAt }
}

export function parseRegistry(raw: string): RegistryEntry | undefined {
  const o = parseObject(raw)
  if (o === undefined || typeof o.sessionId !== 'string' || o.sessionId === '' || !isCount(o.pid)) return undefined

  return {
    sessionId: o.sessionId,
    pid: o.pid,
    name: text(o.name),
    kind: text(o.kind),
    status: text(o.status),
    statusSince: isCount(o.statusUpdatedAt) ? o.statusUpdatedAt : 0,
    startedAt: isCount(o.startedAt) ? o.startedAt : 0,
  }
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `claude plugin test .` → 46 pass, 0 fail. Run `tsc -p /tmp/task-progress-tsconfig.json` → no output.

---

### Task 2: Rows, ordering and row text

**Files:**
- Modify: `types/index.d.ts`
- Create: `hooks/overview.ts`
- Test: `hooks/overview.test.ts`

**Interfaces:**
- Consumes: `ProgressRecord`, `RegistryEntry` from `share.ts`; `formatDuration` from `progress.ts`; `truncate` from `style.ts`.
- Produces: `MAX_ROWS = 5`; `type RowText = { mark: string; name: string; progress: string; detail: string }`; `buildRows(selfId: string, entries: readonly RegistryEntry[], records: readonly ProgressRecord[]): SessionRow[]`; `visibleRows(rows: readonly SessionRow[]): { shown: SessionRow[]; more: number }`; `describeRow(row: SessionRow, now: number): RowText`; `layoutRow(text: RowText, width: number): { head: string; progress: string; detail: string }`; `newlyWaiting(before: ReadonlyMap<string, string> | undefined, rows: readonly SessionRow[]): SessionRow[]`. Types `SessionRow`, `SessionState` come from `types/index.d.ts`.

- [ ] **Step 1: Add the types**

Apply this diff to `types/index.d.ts` (two new types and the `sessions` state key):

```diff
@@ -1,8 +1,26 @@
 export type TaskStatus = 'pending' | 'in_progress' | 'completed'
 export type Item = { id: string; label: string; status: TaskStatus }
 
+/** What the pane knows about one other session: the registry's facts joined with its progress record. */
+export type SessionState = 'waiting' | 'busy' | 'other'
+export type SessionRow = {
+  sessionId: string
+  name: string
+  /** The registry's own word: `busy`, `idle` or anything else it may use. */
+  status: string
+  state: SessionState
+  /** When `status` last changed, ms since epoch; 0 when unknown. */
+  statusSince: number
+  startedAt: number
+  /** False for a session that publishes no progress (the mod is not installed there). */
+  hasProgress: boolean
+  done: number
+  total: number
+  current: string
+}
+
 declare module 'claude-code' {
   interface PluginState {
-    'task-progress': { todos: Item[]; tasks: Item[]; startedAt: number; finishedAt: number; idleCalls: number }
+    'task-progress': { todos: Item[]; tasks: Item[]; startedAt: number; finishedAt: number; idleCalls: number; sessions: SessionRow[] }
   }
 }
```

- [ ] **Step 2: Write the failing test**

Create `hooks/overview.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import type { SessionRow } from '../types'
import { MAX_ROWS, buildRows, describeRow, layoutRow, newlyWaiting, visibleRows } from './overview'
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
```

- [ ] **Step 3: Run it and see it fail**

Run: `claude plugin test .`
Expected: `hooks/overview.test.ts: cannot import "./overview"` as a failed file.

- [ ] **Step 4: Write the implementation**

Create `hooks/overview.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `claude plugin test .` → 59 pass, 0 fail. Run `tsc -p /tmp/task-progress-tsconfig.json` → no output.

---

### Task 3: Publish this session's progress, remove it at the end

**Files:**
- Create: `hooks/sync.ts`
- Modify: `hooks/register.tsx`, `hooks/register.test.ts`

**Interfaces:**
- Consumes: `progressRecord` from `share.ts`; `SessionEndInput.sessionId`.
- Produces (`sync.ts`): `configDir($: EngineInterface): Promise<string>`; `publishProgress($: EngineInterface, items: ReadonlyArray<Item>): Promise<void>`; `removeRecord($: EngineInterface, sessionId: string): Promise<void>`. Both writers swallow errors and log once to the debug channel.

- [ ] **Step 1: Add the mock disk and the failing tests**

In `hooks/register.test.ts`, add this line at the very top (above the existing first import):

```ts
import type { On } from 'claude-code'
```

Then insert the following block immediately above the comment `/** The jingle starts unawaited ...` (it builds a small in-memory disk beneath the plugin and is reused by Tasks 4 to 6):

```ts
const HOME = '/home/me'
const ROOT = `${HOME}/.claude`
const SELF = 'me-1'

type Disk = { files: Map<string, string>; mtimes: Map<string, number>; removed: string[]; played: string[][]; isBroken: boolean; put: (path: string, text: string, mtimeMs?: number) => void }

const NOW = 1_700_000_000_000
const POLL_MS = 3000

/** The world beneath the plugin for the multi-session feature: an environment, a session id, a small disk of text files. */
function mockDisk(on: On, env: Record<string, string> = { HOME }): Disk {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const disk: Disk = {
    files,
    mtimes,
    removed: [],
    played: [],
    isBroken: false,
    put: (path, text, mtimeMs = NOW) => {
      files.set(path, text)
      mtimes.set(path, mtimeMs)
    },
  }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: SELF }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.write', (_$, e) => {
    disk.put(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: text }
  })
  on('fs.list', (_$, e) => {
    if (disk.isBroken) throw new Error('EIO')
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = [...files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
    if (names.length === 0) throw new Error(`ENOENT ${e.path}`)

    return { value: names.map(path => ({ name: path.slice(dir.length), kind: 'file' as const, size: 0, mtimeMs: mtimes.get(path) ?? 0, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') {
      const path = e.argv.at(-1) ?? ''
      disk.removed.push(path)
      files.delete(path)
    } else {
      disk.played.push([...e.argv])
    }

    return { value: OK_RUN }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))

  return disk
}

const boot = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const OWN_FILE = `${ROOT}/task-progress/${SELF}.json`

test('a list change publishes this session\'s progress as a small file of its own', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))

  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })

  const record = JSON.parse(disk.files.get(OWN_FILE) ?? '{}')
  expect(record).toEqual({ v: 1, sessionId: SELF, done: 1, total: 2, current: 'b', updatedAt: 1_700_000_000_000 })
})

test('the progress tool publishes too, and CLAUDE_CONFIG_DIR moves the files', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on, { HOME, CLAUDE_CONFIG_DIR: '/cfg' })

  await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'x', status: 'pending' }] } as never)

  expect(disk.files.has(`/cfg/task-progress/${SELF}.json`)).toBe(true)
  expect(disk.files.has(OWN_FILE)).toBe(false)
})

test('a failing disk never breaks the tool result', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SELF }))
  on('fs.write', () => {
    throw new Error('read-only file system')
  })

  const ran = await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'x', status: 'pending' }] } as never)

  expect(ran.result).toBe('Progress updated: 0/1 done')
})

test('the session start publishes an empty record so the session shows up', async ($, on) => {
  mock.clock(on, { now: NOW })
  const disk = mockDisk(on)

  await boot($)

  const record = JSON.parse(disk.files.get(OWN_FILE) ?? '{}')
  expect(record.total).toBe(0)
  expect(record.sessionId).toBe(SELF)
})

test('the session end removes the record of the session that ended', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const disk = mockDisk(on)

  await $.session.end({ reason: 'other', sessionId: 'old-7', resume: {} } as never)

  expect(disk.removed).toEqual([`${ROOT}/task-progress/old-7.json`])
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `claude plugin test .`
Expected: four of the five new tests fail (nothing writes a record; `session.end` is not hooked); "a failing disk never breaks the tool result" already passes.

- [ ] **Step 3: Create `hooks/sync.ts`**

```ts
import type { EngineInterface } from 'claude-code'

import type { Item } from '../types'
import { progressRecord } from './share'

const PROGRESS_DIR = 'task-progress'
const RM_TIMEOUT_MS = 2000

let hasLogged = false

/** A sharing failure is logged once to the debug channel and never reaches the session. */
async function logOnce($: EngineInterface, what: string, error: unknown): Promise<void> {
  if (hasLogged) return
  hasLogged = true
  try {
    await $.ui.log(`task-progress: ${what}: ${String(error)}`, { to: 'debug' })
  } catch {
    // nothing left to tell
  }
}

/** Claude Code's configuration directory: where `sessions/` is and where the progress files go. */
export async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom !== undefined && custom !== '') return custom

  return `${(await $.env.get('HOME')) ?? ''}/.claude`
}

const recordPath = (root: string, sessionId: string): string => `${root}/${PROGRESS_DIR}/${sessionId}.json`

/** Writes this session's progress where the other sessions' panes look for it. */
export async function publishProgress($: EngineInterface, items: ReadonlyArray<Item>): Promise<void> {
  try {
    const id = await $.session.id()
    const root = await configDir($)
    await $.fs.write(recordPath(root, id), JSON.stringify(progressRecord(id, items, await $.clock.now())))
  } catch (error) {
    await logOnce($, 'could not publish progress', error)
  }
}

/** Removes a record, the own one when the session ends. The file API cannot delete, so `rm -f` does. */
export async function removeRecord($: EngineInterface, sessionId: string): Promise<void> {
  try {
    await $.process.run(['rm', '-f', recordPath(await configDir($), sessionId)], { timeoutMs: RM_TIMEOUT_MS })
  } catch (error) {
    await logOnce($, 'could not remove a progress file', error)
  }
}
```

- [ ] **Step 4: Wire it into `hooks/register.tsx`**

Apply this diff (it publishes after every list change and at session start, and removes the ended session's record):

```diff
@@ -7,6 +7,7 @@
 import { isAllDone, timingText } from './progress'
 import { playerCommands, soundPath, wasCutByCap } from './sound'
 import { COLORS, barParts, truncate } from './style'
+import { publishProgress, removeRecord } from './sync'
 import { WINDOWS } from './world'
 
 const PANE = 'task-progress'
@@ -97,6 +98,7 @@
     await update($, finishedAt, prev => (done === total ? prev || now : 0))
   }
   $.ui.status(total === 0 ? undefined : `tasks ${done}/${total} · ${percent}%`)
+  await publishProgress($, list)
 }
 
 export const register: Register = (on, options) => {
@@ -134,10 +136,17 @@
       },
       isDeferred: false,
     })
+    await publishProgress($, [...(await read($, todos)), ...(await read($, tasks))])
 
     return next(e)
   })
 
+  on('session.end', async ($, e, next) => {
+    await removeRecord($, e.sessionId)
+
+    return next(e)
+  }).catch((_$, e, next) => next(e))
+
   on('command.run', { command: 'task-progress' }, async $ => {
     await $.ui.open({ id: PANE, title: 'Task progress' })
 
```

- [ ] **Step 5: Run tests, type-check and validate**

Run: `claude plugin test .` → 64 pass, 0 fail. Run `tsc -p /tmp/task-progress-tsconfig.json` → no output. Run `claude plugin validate .` → `Validation passed with warnings`.

---

### Task 4: Read the other sessions and draw the block

**Files:**
- Modify: `hooks/sync.ts`, `hooks/register.tsx`, `hooks/register.test.ts`

**Interfaces:**
- Consumes: `buildRows`, `visibleRows`, `describeRow`, `layoutRow` from `overview.ts`; `parseRecord`, `parseRegistry` from `share.ts`.
- Produces: `pollSessions($: EngineInterface): Promise<SessionRow[] | undefined>` (undefined when the poll failed: the pane keeps its last rows). The pane draws, in both the empty and the non-empty branch, up to 5 rows of `<mark> <name 14> <progress 12> <detail>` and `+N more`; the task list's room shrinks by the rows the block takes.

- [ ] **Step 1: Add the failing tests**

In `hooks/register.test.ts`, insert this block immediately above the comment `/** The jingle starts unawaited ...` (below the Task 3 block):

```ts
const MIN = 60_000
const DAY = 24 * 60 * MIN

const registryFile = (over: Record<string, unknown>): string =>
  JSON.stringify({ pid: 100, sessionId: 'x', name: 'x', kind: 'interactive', status: 'busy', statusUpdatedAt: NOW, startedAt: NOW - MIN, ...over })
const recordFile = (over: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, sessionId: 'x', done: 1, total: 4, current: 'working', updatedAt: NOW, ...over })

/** Two other sessions: `alpha` has waited 4 minutes and made 2 of 5, `beta` is busy with no mod installed. */
function putOthers(disk: Disk): void {
  disk.put(`${ROOT}/sessions/1.json`, registryFile({ pid: 1, sessionId: SELF, name: 'me' }))
  disk.put(`${ROOT}/sessions/2.json`, registryFile({ pid: 2, sessionId: 'a-2', name: 'alpha', status: 'idle', statusUpdatedAt: NOW - 4 * MIN }))
  disk.put(`${ROOT}/sessions/3.json`, registryFile({ pid: 3, sessionId: 'b-3', name: 'beta', status: 'busy' }))
  disk.put(`${ROOT}/task-progress/a-2.json`, recordFile({ sessionId: 'a-2', done: 2, total: 5, current: 'reviewing' }))
}

const mountOverview = ($: Engine) =>
  $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })

test('the pane lists the other sessions: who waits, how far each got, what a busy one does', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chờ bạn 4m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\bme\b/ })).toBeUndefined()
  await ui.unmount()
})

test('a session that ends disappears at the next poll, and with no others there is no block', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()

  disk.files.delete(`${ROOT}/sessions/2.json`)
  disk.files.delete(`${ROOT}/sessions/3.json`)
  await clock.advance(POLL_MS)

  expect(await ui.find({ type: 'Text', text: /alpha|beta/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /chờ bạn/ })).toBeUndefined()
  await ui.unmount()
})

test('a record of a dead session is removed after a day, a younger one and a live one are kept', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  disk.put(`${ROOT}/task-progress/old-9.json`, recordFile({ sessionId: 'old-9' }), NOW - 2 * DAY)
  disk.put(`${ROOT}/task-progress/new-8.json`, recordFile({ sessionId: 'new-8' }), NOW - 5 * MIN)
  await boot($)
  await clock.settle()

  expect(disk.removed).toEqual([`${ROOT}/task-progress/old-9.json`])
})

test('junk files and a broken disk leave the pane working', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const disk = mockDisk(on)
  disk.put(`${ROOT}/sessions/1.json`, '{"pid":')
  disk.put(`${ROOT}/sessions/2.json`, 'not json at all')
  disk.put(`${ROOT}/task-progress/a-2.json`, '[]')
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
  await ui.unmount()

  disk.isBroken = true
  await clock.advance(POLL_MS)
  const again = await mountOverview($)
  expect(await again.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
  await again.unmount()
})

test('without a progress directory the sessions still show, with state only', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  disk.put(`${ROOT}/sessions/3.json`, registryFile({ pid: 3, sessionId: 'b-3', name: 'beta', status: 'busy' }))
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\d\/\d/ })).toBeUndefined()
  await ui.unmount()
})

test('only 12 sessions are read and 5 shown, the rest are counted', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  for (let i = 0; i < 15; i += 1) disk.put(`${ROOT}/sessions/${i}.json`, registryFile({ pid: 100 + i, sessionId: `s-${i}`, name: `sess${i}` }))
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /\+7 more/ })).toBeDefined()
  await ui.unmount()
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `claude plugin test .`
Expected: five of the new tests fail (no rows are drawn, nothing is pruned); "junk files and a broken disk leave the pane working" already passes.

- [ ] **Step 3: Extend `hooks/sync.ts`**

Apply this diff (imports, constants and `pollSessions`):

```diff
@@ -1,10 +1,16 @@
 import type { EngineInterface } from 'claude-code'
 
-import type { Item } from '../types'
-import { progressRecord } from './share'
+import type { Item, SessionRow } from '../types'
+import { buildRows } from './overview'
+import { parseRecord, parseRegistry, progressRecord } from './share'
+import type { ProgressRecord, RegistryEntry } from './share'
 
 const PROGRESS_DIR = 'task-progress'
+const SESSIONS_DIR = 'sessions'
 const RM_TIMEOUT_MS = 2000
+const MAX_SESSIONS = 12
+const STALE_RECORD_MS = 24 * 60 * 60 * 1000
+const EXTENSION = '.json'
 
 let hasLogged = false
 
@@ -48,3 +54,62 @@
     await logOnce($, 'could not remove a progress file', error)
   }
 }
+
+type Listed = { name: string; mtimeMs: number }
+
+/** The `.json` files of a directory; a directory that is not there is an empty one. */
+async function listJson($: EngineInterface, dir: string): Promise<Listed[]> {
+  try {
+    const entries = await $.fs.list(dir)
+
+    return entries.filter(f => f.kind === 'file' && f.name.endsWith(EXTENSION)).map(f => ({ name: f.name, mtimeMs: f.mtimeMs }))
+  } catch {
+    return []
+  }
+}
+
+async function readText($: EngineInterface, path: string): Promise<string | undefined> {
+  try {
+    const text = await $.fs.read(path)
+
+    return typeof text === 'string' ? text : undefined
+  } catch {
+    return undefined
+  }
+}
+
+/**
+ * The other sessions as rows, or undefined when this poll failed (the pane keeps the last rows).
+ * Reads at most 12 registry files and the records of those sessions; records of sessions that are gone are
+ * removed once a day old.
+ */
+export async function pollSessions($: EngineInterface): Promise<SessionRow[] | undefined> {
+  try {
+    const root = await configDir($)
+    const now = await $.clock.now()
+    const entries: RegistryEntry[] = []
+    for (const file of (await listJson($, `${root}/${SESSIONS_DIR}`)).slice(0, MAX_SESSIONS)) {
+      const text = await readText($, `${root}/${SESSIONS_DIR}/${file.name}`)
+      const entry = text === undefined ? undefined : parseRegistry(text)
+      if (entry !== undefined) entries.push(entry)
+    }
+    const alive = new Set(entries.map(e => e.sessionId))
+    const records: ProgressRecord[] = []
+    for (const file of await listJson($, `${root}/${PROGRESS_DIR}`)) {
+      const id = file.name.slice(0, -EXTENSION.length)
+      if (alive.has(id)) {
+        const text = await readText($, `${root}/${PROGRESS_DIR}/${file.name}`)
+        const record = text === undefined ? undefined : parseRecord(text)
+        if (record !== undefined && record.sessionId === id) records.push(record)
+      } else if (now - file.mtimeMs > STALE_RECORD_MS) {
+        await removeRecord($, id)
+      }
+    }
+
+    return buildRows(await $.session.id(), entries, records)
+  } catch (error) {
+    await logOnce($, 'could not read the other sessions', error)
+
+    return undefined
+  }
+}
```

- [ ] **Step 4: Extend `hooks/register.tsx`**

Apply this diff (the `sessions` atom, `refreshSessions`, the 3 s poll, and the block in the pane):

```diff
@@ -1,13 +1,14 @@
 import { atom, read, update } from 'claude-code'
 import type { EngineInterface, Register } from 'claude-code'
 
-import type { Item, TaskStatus } from '../types'
+import type { Item, SessionRow, TaskStatus } from '../types'
 import { sceneCells } from './compositor'
 import { DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout } from './layout'
+import { describeRow, layoutRow, visibleRows } from './overview'
 import { isAllDone, timingText } from './progress'
 import { playerCommands, soundPath, wasCutByCap } from './sound'
 import { COLORS, barParts, truncate } from './style'
-import { publishProgress, removeRecord } from './sync'
+import { pollSessions, publishProgress, removeRecord } from './sync'
 import { WINDOWS } from './world'
 
 const PANE = 'task-progress'
@@ -20,6 +21,8 @@
 const MAX_SOUND_SECONDS = 120
 /** Tool calls without a list update after which the pane warns that it may be stale. */
 const STALE_CALLS = 10
+/** How often the other sessions are read. */
+const POLL_MS = 3000
 /** The tools that update the list: they reset the stale counter instead of counting. */
 const LIST_TOOLS: readonly string[] = [PROGRESS_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']
 const USAGE_PROMPT = `The user watches a live task-progress pane fed by the ${PROGRESS_TOOL} tool. For any work of 2 or more steps, call it first with the full ordered list, then call it again every time a step starts (in_progress) or finishes (completed) and whenever the plan changes, also in the middle of long runs of tool calls. Keep exactly one task in_progress. Never leave the list stale: when the work is done, mark every task completed.`
@@ -34,6 +37,7 @@
 const finishedAt = atom({ plugin: 'task-progress', key: 'finishedAt' } as const, 0)
 const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as Item[])
 const idleCalls = atom({ plugin: 'task-progress', key: 'idleCalls' } as const, 0)
+const sessions = atom({ plugin: 'task-progress', key: 'sessions' } as const, [] as SessionRow[])
 
 const summarize = (items: Item[]) => {
   const done = items.filter(i => i.status === 'completed').length
@@ -79,6 +83,13 @@
   }
 }
 
+/** One read of the other sessions; a failed read keeps the rows already shown. */
+async function refreshSessions($: EngineInterface): Promise<void> {
+  const rows = await pollSessions($)
+  if (rows === undefined) return
+  await update($, sessions, () => rows)
+}
+
 async function refreshStatus($: EngineInterface) {
   const list = [...(await read($, todos)), ...(await read($, tasks))]
   const { done, total, percent } = summarize(list)
@@ -137,6 +148,10 @@
       isDeferred: false,
     })
     await publishProgress($, [...(await read($, todos)), ...(await read($, tasks))])
+    await refreshSessions($)
+    $.clock.every(POLL_MS, () => {
+      void refreshSessions($)
+    })
 
     return next(e)
   })
@@ -258,6 +273,8 @@
     const timing = timingText(elapsed, done, total, finished !== 0)
     const idle = await read($, idleCalls)
     const isStale = idle >= STALE_CALLS && items.some(i => i.status === 'in_progress')
+    const { shown, more } = visibleRows(await read($, sessions))
+    const blockRows = shown.length + (more > 0 ? 1 : 0)
 
     const available = Math.max(1, (e.props.bodyColumns ?? DEFAULT_COLUMNS + 2 * CARD_PADDING) - 2 * CARD_PADDING)
     const inner = Math.min(MAX_SCENE_COLUMNS, available)
@@ -274,7 +291,25 @@
         />
       )
 
-    const room = Math.max(1, bodyRows - 7 - (layout?.rows ?? 0))
+    const sessionBlock = (
+      <Box flexDirection="column">
+        {shown.map(row => {
+          const text = layoutRow(describeRow(row, now), inner)
+          const tone = row.state === 'waiting' ? COLORS.accent : row.state === 'busy' ? COLORS.text : COLORS.muted
+
+          return (
+            <Text>
+              <Text color={tone}>{text.head}</Text>
+              <Text color={COLORS.muted}>{text.progress}</Text>
+              <Text color={row.state === 'waiting' ? COLORS.accent : COLORS.muted}> {text.detail}</Text>
+            </Text>
+          )
+        })}
+        {more > 0 && <Text color={COLORS.muted}>+{more} more</Text>}
+      </Box>
+    )
+
+    const room = Math.max(1, bodyRows - 7 - (layout?.rows ?? 0) - blockRows)
     const shownItems = [
       ...items.filter(i => i.status === 'in_progress'),
       ...items.filter(i => i.status !== 'in_progress'),
@@ -297,7 +332,10 @@
           <Text color={COLORS.track}>{rest}</Text>
         </Text>
         {total === 0 ? (
-          <Text color={COLORS.muted}>No tasks yet. They appear when Claude plans work.</Text>
+          <Box flexDirection="column">
+            <Text color={COLORS.muted}>No tasks yet. They appear when Claude plans work.</Text>
+            {sessionBlock}
+          </Box>
         ) : (
           <Box flexDirection="column">
             <Text>
@@ -311,6 +349,7 @@
             </Text>
             {timing !== '' && <Text color={COLORS.muted}>{timing}</Text>}
             {isStale && <Text color={COLORS.warn}>⚠ no update for {idle} tool calls</Text>}
+            {sessionBlock}
             <Text> </Text>
             {shownItems.map(i => (
               <Text>
```

- [ ] **Step 5: Run tests, type-check and validate**

Run: `claude plugin test .` → 70 pass, 0 fail. Run `tsc -p /tmp/task-progress-tsconfig.json` → no output. Run `claude plugin validate .` → `Validation passed with warnings`.

---

### Task 5: Alert when another session starts waiting

**Files:**
- Modify: `hooks/register.tsx`, `hooks/register.test.ts`, `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: `newlyWaiting` from `overview.ts`; the existing `playDone`, `soundPath`, `soundMs`, `customSound` in `register.tsx`.
- Produces: option `isWaitSoundOn` (boolean, default false); a toast `◆ <names> waiting for you` when sessions go from `busy` to `idle`; none at the first poll.

- [ ] **Step 1: Add the failing tests**

In `hooks/register.test.ts`, insert this block immediately above the comment `/** The jingle starts unawaited ...` (below the Task 4 block):

```ts
const setStatus = (disk: Disk, name: string, status: string): void =>
  disk.put(`${ROOT}/sessions/2.json`, registryFile({ pid: 2, sessionId: 'a-2', name, status, statusUpdatedAt: NOW }))

test('a session that goes from busy to idle raises one toast, the first poll none', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const disk = mockDisk(on)
  setStatus(disk, 'alpha', 'idle')
  await boot($)
  await clock.settle()
  expect(toasts).toEqual([])

  setStatus(disk, 'alpha', 'busy')
  await clock.advance(POLL_MS)
  expect(toasts).toEqual([])

  setStatus(disk, 'alpha', 'idle')
  await clock.advance(POLL_MS)
  expect(toasts).toEqual(['◆ alpha waiting for you'])

  await clock.advance(POLL_MS * 3)
  expect(toasts.length).toBe(1)
  expect(disk.played).toEqual([])
})

test('the jingle also plays for a waiting session when the option is on', { options: { isWaitSoundOn: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const disk = mockDisk(on)
  setStatus(disk, 'alpha', 'busy')
  await boot($)
  await clock.settle()
  expect(disk.played).toEqual([])

  setStatus(disk, 'alpha', 'idle')
  await clock.advance(POLL_MS)
  await clock.settle()

  expect(disk.played.length).toBe(1)
})

test('a toast that fails never breaks the poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => {
    throw new Error('no surface')
  })
  const disk = mockDisk(on)
  setStatus(disk, 'alpha', 'busy')
  await boot($)
  await clock.settle()
  setStatus(disk, 'alpha', 'idle')
  await clock.advance(POLL_MS)
  const ui = await mountOverview($)

  expect(await ui.find({ type: 'Text', text: /chờ bạn/ })).toBeDefined()
  await ui.unmount()
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `claude plugin test .`
Expected: the toast test and the jingle test fail; "a toast that fails never breaks the poll" already passes.

- [ ] **Step 3: Edit `hooks/register.tsx` and `.claude-plugin/plugin.json`**

Apply this diff to `hooks/register.tsx`:

```diff
@@ -4,7 +4,7 @@
 import type { Item, SessionRow, TaskStatus } from '../types'
 import { sceneCells } from './compositor'
 import { DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout } from './layout'
-import { describeRow, layoutRow, visibleRows } from './overview'
+import { describeRow, layoutRow, newlyWaiting, visibleRows } from './overview'
 import { isAllDone, timingText } from './progress'
 import { playerCommands, soundPath, wasCutByCap } from './sound'
 import { COLORS, barParts, truncate } from './style'
@@ -28,6 +28,9 @@
 const USAGE_PROMPT = `The user watches a live task-progress pane fed by the ${PROGRESS_TOOL} tool. For any work of 2 or more steps, call it first with the full ordered list, then call it again every time a step starts (in_progress) or finishes (completed) and whenever the plan changes, also in the middle of long runs of tool calls. Keep exactly one task in_progress. Never leave the list stale: when the work is done, mark every task completed.`
 
 let isSoundOn = true
+let isWaitSoundOn = false
+/** Status of each other session at the last poll; undefined until the first one, which raises no alert. */
+let previousStatus: Map<string, string> | undefined
 let customSound = ''
 let soundMs = DEFAULT_SOUND_SECONDS * 1000
 let hasChimed = false
@@ -87,7 +90,16 @@
 async function refreshSessions($: EngineInterface): Promise<void> {
   const rows = await pollSessions($)
   if (rows === undefined) return
+  const fresh = newlyWaiting(previousStatus, rows)
+  previousStatus = new Map(rows.map(r => [r.sessionId, r.status]))
   await update($, sessions, () => rows)
+  if (fresh.length === 0) return
+  try {
+    $.ui.toast(`◆ ${fresh.map(r => r.name).join(', ')} waiting for you`)
+  } catch {
+    // a toast is a side effect: it must never throw into the session
+  }
+  if (isWaitSoundOn) void playDone($, soundPath($.plugin.root, customSound), soundMs)
 }
 
 async function refreshStatus($: EngineInterface) {
@@ -114,6 +126,7 @@
 
 export const register: Register = (on, options) => {
   isSoundOn = options.isSoundOn !== false
+  isWaitSoundOn = options.isWaitSoundOn === true
   customSound = typeof options.soundFile === 'string' ? options.soundFile : ''
   const seconds = typeof options.maxSeconds === 'number' ? options.maxSeconds : DEFAULT_SOUND_SECONDS
   soundMs = Math.min(MAX_SOUND_SECONDS, Math.max(MIN_SOUND_SECONDS, seconds)) * 1000
```

In `.claude-plugin/plugin.json`, add the option to `userConfig` after `maxSeconds`:

```diff
@@ -21,6 +21,12 @@
       "title": "Max sound length (seconds)",
       "description": "A longer clip is cut after this many seconds (1-120).",
       "default": 12
+    },
+    "isWaitSoundOn": {
+      "type": "boolean",
+      "title": "Play a sound when another session starts waiting for you",
+      "description": "Plays the same jingle once each time another session goes from busy to idle.",
+      "default": false
     }
   }
 }
```

- [ ] **Step 4: Run tests, type-check and validate**

Run: `claude plugin test .` → 73 pass, 0 fail. Run `tsc -p /tmp/task-progress-tsconfig.json` → no output. Run `claude plugin validate .` → `Validation passed with warnings`.

---

### Task 6: `/task-progress-tell`, docs and version

**Files:**
- Modify: `hooks/overview.ts`, `hooks/overview.test.ts`, `hooks/register.tsx`, `hooks/register.test.ts`, `README.md`, `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: `SessionRow` rows from the `sessions` atom; `$.session.send({ to: { sessionId }, text })`.
- Produces: `parseTell(args: string): { query: string; text: string } | undefined`; `resolveTarget(rows: readonly SessionRow[], query: string): { row: SessionRow } | { error: string }`; the command `/task-progress-tell <session name> <message>` answering `Sent to <name>.`, `Not delivered to <name>: <reason>`, the usage line, or the resolve error.

- [ ] **Step 1: Add the failing tests**

Append to `hooks/overview.test.ts`, and change its import line to also import `parseTell` and `resolveTarget` from `./overview`:

```ts

test('a tell command is a name prefix, then the message', () => {
  expect(parseTell('alpha hello there')).toEqual({ query: 'alpha', text: 'hello there' })
  expect(parseTell('  alpha   spaced  out ')).toEqual({ query: 'alpha', text: 'spaced  out' })
  expect(parseTell('alpha')).toBeUndefined()
  expect(parseTell('   ')).toBeUndefined()
  expect(parseTell('')).toBeUndefined()
})

test('a name prefix picks exactly one session, ignoring case', () => {
  const rows = [row({ sessionId: '1', name: 'Sync giá AI' }), row({ sessionId: '2', name: 'syntax' }), row({ sessionId: '3', name: 'docs' })]
  expect(resolveTarget(rows, 'DOC')).toEqual({ row: rows[2] })
  expect(resolveTarget(rows, 'sync')).toEqual({ row: rows[0] })
  expect(resolveTarget(rows, 'sy')).toEqual({ error: '"sy" matches: Sync giá AI, syntax' })
  expect(resolveTarget(rows, 'zzz')).toEqual({ error: 'no session starts with "zzz"' })
})

test('an id prefix works too, and an exact name wins over longer ones', () => {
  const rows = [row({ sessionId: 'abc123', name: 'docs' }), row({ sessionId: 'def456', name: 'docs-old' })]
  expect(resolveTarget(rows, 'abc')).toEqual({ row: rows[0] })
  expect(resolveTarget(rows, 'docs')).toEqual({ row: rows[0] })
})
```

In `hooks/register.test.ts`, insert this block immediately above the comment `/** The jingle starts unawaited ...` (below the Task 5 block):

```ts
test('the tell command sends the message to the one session that matches', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const sent: Array<{ to: string; text: string }> = []
  on('session.send', (_$, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  await clock.settle()

  const ran = await $.command.run({ command: 'task-progress-tell', args: 'alp please review the diff' } as never)

  expect(sent).toEqual([{ to: 'a-2', text: 'please review the diff' }])
  expect(ran.text).toBe('Sent to alpha.')
})

test('the tell command explains itself when it cannot send', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: false, reason: 'the recipient is gone' }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  await clock.settle()
  const tell = async (args: string) => (await $.command.run({ command: 'task-progress-tell', args } as never)).text

  expect(await tell('')).toBe('Usage: /task-progress-tell <session name> <message>')
  expect(await tell('alpha')).toBe('Usage: /task-progress-tell <session name> <message>')
  expect(await tell('zzz hello')).toBe('no session starts with "zzz"')
  expect(await tell('alpha hello')).toBe('Not delivered to alpha: the recipient is gone')
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `claude plugin test .`
Expected: the new overview tests and the two tell tests fail (the overview test file may fail to load for the missing exports).

- [ ] **Step 3: Implement**

Append to `hooks/overview.ts`:

```ts

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

  return { error: `"${query}" matches: ${matches.map(r => r.name).join(', ')}` }
}
```

Apply this diff to `hooks/register.tsx`:

```diff
@@ -4,7 +4,7 @@
 import type { Item, SessionRow, TaskStatus } from '../types'
 import { sceneCells } from './compositor'
 import { DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout } from './layout'
-import { describeRow, layoutRow, newlyWaiting, visibleRows } from './overview'
+import { describeRow, layoutRow, newlyWaiting, parseTell, resolveTarget, visibleRows } from './overview'
 import { isAllDone, timingText } from './progress'
 import { playerCommands, soundPath, wasCutByCap } from './sound'
 import { COLORS, barParts, truncate } from './style'
@@ -23,6 +23,7 @@
 const STALE_CALLS = 10
 /** How often the other sessions are read. */
 const POLL_MS = 3000
+const TELL_USAGE = 'Usage: /task-progress-tell <session name> <message>'
 /** The tools that update the list: they reset the stale counter instead of counting. */
 const LIST_TOOLS: readonly string[] = [PROGRESS_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']
 const USAGE_PROMPT = `The user watches a live task-progress pane fed by the ${PROGRESS_TOOL} tool. For any work of 2 or more steps, call it first with the full ordered list, then call it again every time a step starts (in_progress) or finishes (completed) and whenever the plan changes, also in the middle of long runs of tool calls. Keep exactly one task in_progress. Never leave the list stale: when the work is done, mark every task completed.`
@@ -136,6 +137,10 @@
       name: 'task-progress',
       description: 'Show the task progress pane (todo/task list, percent done)',
     })
+    await $.command.register({
+      name: 'task-progress-tell',
+      description: 'Send a message to another session: /task-progress-tell <session name> <message>',
+    })
     void $.ui.open({ id: PANE, title: 'Task progress' })
     await $.tool.register({
       name: 'progress',
@@ -193,6 +198,20 @@
     return isCounted ? update($, idleCalls, n => n + 1).then(() => next(e)) : next(e)
   }).catch((_$, e, next) => next(e))
 
+  on('command.run', { command: 'task-progress-tell' }, async ($, e) => {
+    const tell = parseTell(e.args)
+    if (tell === undefined) return { text: TELL_USAGE }
+    const target = resolveTarget(await read($, sessions), tell.query)
+    if ('error' in target) return { text: target.error }
+    try {
+      const sent = await $.session.send({ to: { sessionId: target.row.sessionId }, text: tell.text })
+
+      return { text: sent.isDelivered ? `Sent to ${target.row.name}.` : `Not delivered to ${target.row.name}: ${sent.reason}` }
+    } catch (error) {
+      return { text: `Not delivered to ${target.row.name}: ${String(error)}` }
+    }
+  }).catch((_$, e, next) => next(e))
+
   on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
     if (e.agentId !== undefined) return { result: 'Noted. The pane shows the main session list only.' }
     const items = parseProgressInput(e.tasks)
```

- [ ] **Step 4: Docs and version**

In `README.md`, insert this section above `## Completion sound`:

````md
## Other sessions

Every session with the mod publishes its progress to `~/.claude/task-progress/<sessionId>.json` (or under `$CLAUDE_CONFIG_DIR`), and each pane reads Claude Code's own session list plus those files every 3 seconds. Under the timing line it shows up to 5 other sessions, one row each:

```
◆ Sync giá AI   ▰▰▰▱▱▱ 3/5   chờ bạn 4m
▶ vntrip-25     ▰▰▱▱▱▱ 2/6   Write the compositor
·  docs         no tasks     idle 31m
```

`◆` is a session waiting for you (idle with work left), `▶` is busy. A session without the mod shows its state only. When a session goes from busy to idle a toast says so; option `isWaitSoundOn` (default off) also plays the jingle. Message a session with `/task-progress-tell <name prefix> <message>`. Files of ended sessions are removed when they end, and files left by crashed ones after a day.
````

In `.claude-plugin/plugin.json`, set `"version": "0.7.0"`.

- [ ] **Step 5: Run tests, type-check and validate**

Run: `claude plugin test .` → 78 pass, 0 fail. Run `tsc -p /tmp/task-progress-tsconfig.json` → no output. Run `claude plugin validate .` → `Validation passed with warnings`. Confirm no `.js` files appeared: `ls hooks | grep -c '\.js$'` → `0`.

---

### Task 7: Final check with two real sessions

**Files:** none.

- [ ] **Step 1: Full verification**

Run, from the repo: `claude plugin test .`, `tsc -p /tmp/task-progress-tsconfig.json`, `claude plugin validate .`
Expected: 78 pass 0 fail; no tsc output; validation passed with warnings.

- [ ] **Step 2: Sync the loaded copy**

Run: `LOADED=$(ls -d ~/.claude/dev-mods/*/task-progress | head -1)` (the folder the user's session hot-reloads; check it is the right one if several exist), then `rsync -a --delete --exclude .git --exclude docs --exclude .superpowers --exclude '.claude-plugin/types' ./ "$LOADED/"`. Then `diff -rq . "$LOADED" -x .git -x docs -x .superpowers -x types` shows no differences.

- [ ] **Step 3: Look at it with two real sessions**

Open a second interactive Claude Code session (any directory) with the mod loaded, give it a 4-step task list, and watch the first session's pane. Expected within about 3 s: a row for the second session with its name and `done/total`; when the second session finishes its turn the row turns `◆ … chờ bạn` and a toast appears; closing the second session removes the row within 3 s and its file `~/.claude/task-progress/<id>.json`. Then run `/task-progress-tell <name prefix> hello` and check the second session received it.

- [ ] **Step 4: User sign-off**

Report the result of step 3 to the user. Leave everything uncommitted until they ask for a commit.
