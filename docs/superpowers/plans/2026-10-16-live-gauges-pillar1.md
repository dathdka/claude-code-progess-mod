# Live Gauges (Pillar 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strip of up to five lines under the pane's timing line: context and quota gauges, what the session is doing, and the branch of every repository the session has edited.

**Architecture:** Three pure modules (`gauges.ts`, `activity.ts`, `repos.ts`) hold all logic and are unit-tested alone. `watch.ts` holds the three impure reads (usage, `git rev-parse`, `git status`) as top-level functions taking `$`. `register.tsx` wires them: three `$.state` atoms, a global `tool.call` hook that records activity and touched repositories, two timers, a context toast, and the strip drawn in the pane. The state types live in `types/index.d.ts`.

**Tech Stack:** TypeScript on the Claude Code mod API (`claude-code`, `claude-code/testing`), `claude plugin test`, `claude plugin validate`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-pillar1-live-gauges-design.md` (approved 2026-10-16; Task 7 records three small refinements the plan makes to it).

## Global Constraints

- Work in `~/claude-mods/task-progress`. Source style: no semicolons, single quotes, 2-space indent, `const` arrows for helpers, `/** … */` on exported functions, as in the existing hooks.
- **Do not commit and do not push.** The user commits on request. Each task ends by running the tests, not by committing.
- Type-check with `tsc -p /tmp/task-progress-tsconfig.json` (no output means clean). The `tsc` binary is `/home/vntrip/Documents/vntrip/admin-v3/node_modules/.bin/tsc`. **Never run tsc with `--noEmit false`** (it writes stray `.js` files into `hooks/`).
- Run tests with `claude plugin test .` from the repo root; validate with `claude plugin validate .` (warnings are fine, errors are not). The validator accepts `$` only in calls to functions declared at the top of the file or imported from the module's own files, never to closures inside `register`.
- Notification and side-effect paths (toasts, git, usage reads) must swallow and log their own errors and never throw into the session, the tool call or the render hook (project CLAUDE.md).
- The `tool.call` hook added in Task 5 must return `next(e)`'s result unchanged and add no latency beyond one function call. Do not add `.catch` to it: a `.catch((_$, e, next) => next(e))` would run the tool a second time when the tool itself throws.
- Processes are started with an argument array, never a shell. Directory arguments passed to git must start with `/`.
- Strings that come from tool input or from git are stripped of control characters before they are drawn.
- Existing tests (87 at the start) must stay green after every task. `hooks/register.tsx` must stay under 800 lines.
- Exact numbers: context warning at 80%, re-arm below 70%, limit toast at 90%; usage read every 5000 ms; git poll every 10000 ms with a 3000 ms limit per process; at most 6 tracked repositories; stale gauges hidden after 30000 ms of failed reads; subagent window 15000 ms; last call shown 60000 ms; elapsed time shown after 2000 ms; target cut at 30 characters.

## Review Focus

The spec implies these inputs, which no single task's happy-path tests would catch. Each has a test in the task that owns the code:

1. **A tool that throws or is denied** must not leave a ghost `▶` line, must not change the call's result, and must not run twice (Task 5).
2. **Odd paths:** relative path, path with spaces, control characters, a file in a not-yet-existing directory, a file outside any repository (Tasks 2, 6).
3. **Git trouble:** git missing or failing, not a repository, truncated output, a repository that fails three polls in a row (Task 6).
4. **Junk usage:** missing `context`, NaN, unknown limit kinds, a usage read that throws (Tasks 1, 4).
5. **Alert storms:** a context figure oscillating around 80% must toast once per crossing, not per poll (Tasks 1, 4).
6. **Small panes:** the strip must never push the scene out or leave no task row (Task 4).

---

### Task 1: Gauges (pure) and strip room

**Files:**
- Create: `hooks/gauges.ts`
- Create: `hooks/gauges.test.ts`
- Modify: `hooks/layout.ts` (add `CHROME_ROWS`, `stripRoom`)
- Modify: `hooks/layout.test.ts`
- Modify: `types/index.d.ts` (gauge types)

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 4 uses all of these):
  - types `Limit`, `Readings`, `GaugeState` from `../types`
  - `gauges.ts`: `readingsFromUsage(usage: unknown): Readings`, `formatGauges(readings: Readings, now: number): Segment[] | undefined` with `type Segment = { text: string; tone: 'text' | 'muted' | 'warn' }`, `resetText(resetsAt: string | undefined, now: number): string | undefined`, `limitName(kind: Limit['kind']): string`, `contextAlarm(isArmed: boolean, percent: number | undefined): { isArmed: boolean; shouldFire: boolean }`, `freshLimitAlerts(announced: ReadonlySet<string>, limits: readonly Limit[]): { fresh: Limit[]; announced: ReadonlySet<string> }`
  - `layout.ts`: `CHROME_ROWS = 7`, `stripRoom(bodyRows: number, sceneRows: number, blockRows: number, wanted: number): number`

- [x] **Step 1: Add the types.** In `types/index.d.ts`, after the `SessionRow` type and before `declare module`, add:

```ts
/** One quota window as the session usage reports it. */
export type Limit = { kind: 'five_hour' | 'seven_day'; percent: number; resetsAt: string | undefined }
/** What the gauges line shows: the context fill and the quota windows, each 0 to 100. */
export type Readings = { context: number | undefined; limits: Limit[] }
/** The last good usage reading and when it was taken, ms since epoch. */
export type GaugeState = { readings: Readings; at: number }
```

- [x] **Step 2: Write the failing tests.** Create `hooks/gauges.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { contextAlarm, formatGauges, freshLimitAlerts, limitName, readingsFromUsage, resetText } from './gauges'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const text = (segments: ReturnType<typeof formatGauges>): string => (segments ?? []).map(s => s.text).join('')

test('context comes from percent, else from tokens over window, rounded and clamped', () => {
  expect(readingsFromUsage({ context: { tokens: 1, window: 1, percent: 62.4 }, rateLimits: [] }).context).toBe(62)
  expect(readingsFromUsage({ context: { tokens: 250, window: 1000 }, rateLimits: [] }).context).toBe(25)
  expect(readingsFromUsage({ context: { percent: 140 }, rateLimits: [] }).context).toBe(100)
  expect(readingsFromUsage({ context: { percent: -3 }, rateLimits: [] }).context).toBe(0)
  expect(readingsFromUsage({ context: { tokens: 5, window: 0 }, rateLimits: [] }).context).toBeUndefined()
  expect(readingsFromUsage({ context: {}, rateLimits: [] }).context).toBeUndefined()
})

test('junk usage gives no readings and never throws', () => {
  for (const junk of [undefined, null, 5, 'x', [], {}, { context: 'x', rateLimits: 'y' }, { context: { percent: Number.NaN }, rateLimits: [null, 3, {}] }]) {
    expect(readingsFromUsage(junk)).toEqual({ context: undefined, limits: [] })
  }
})

test('only five_hour and seven_day limits are kept, once each, in that order', () => {
  const usage = {
    context: {},
    rateLimits: [
      { kind: 'seven_day', percentUsed: 9 },
      { kind: 'spend_limit', percentUsed: 50 },
      { kind: 'five_hour', percentUsed: 31.6, resetsAt: '2026-10-16T03:10:00.000Z' },
      { kind: 'five_hour', percentUsed: 99 },
      { kind: 'seven_day', percentUsed: 'many' },
    ],
  }
  expect(readingsFromUsage(usage).limits).toEqual([
    { kind: 'five_hour', percent: 32, resetsAt: '2026-10-16T03:10:00.000Z' },
    { kind: 'seven_day', percent: 9, resetsAt: undefined },
  ])
})

test('the gauges line shows a bar and a figure for each reading', () => {
  const readings = { context: 62, limits: [{ kind: 'five_hour' as const, percent: 31, resetsAt: undefined }, { kind: 'seven_day' as const, percent: 9, resetsAt: undefined }] }
  expect(text(formatGauges(readings, NOW))).toBe('ctx ▰▰▰▰▰▱▱▱ 62%   5h ▰▱▱▱ 31%   7d ▱▱▱▱ 9%')
  expect(text(formatGauges({ context: undefined, limits: readings.limits }, NOW))).toBe('5h ▰▱▱▱ 31%   7d ▱▱▱▱ 9%')
  expect(text(formatGauges({ context: 100, limits: [] }, NOW))).toBe('ctx ▰▰▰▰▰▰▰▰ 100%')
})

test('no reading at all gives no line', () => {
  expect(formatGauges({ context: undefined, limits: [] }, NOW)).toBeUndefined()
})

test('a figure at 80% or more takes the warning tone, a limit also shows when it resets', () => {
  const tone = (percent: number) => formatGauges({ context: percent, limits: [] }, NOW)?.at(-1)?.tone
  expect(tone(79)).toBe('text')
  expect(tone(80)).toBe('warn')

  const resetsAt = new Date(NOW + 130 * MINUTE).toISOString()
  const hot = formatGauges({ context: undefined, limits: [{ kind: 'five_hour', percent: 85, resetsAt }] }, NOW)
  expect(text(hot)).toBe('5h ▰▰▰▱ 85% ↻2h10m')
  const cool = formatGauges({ context: undefined, limits: [{ kind: 'five_hour', percent: 79, resetsAt }] }, NOW)
  expect(text(cool)).toBe('5h ▰▰▰▱ 79%')
})

test('reset text counts up to whole minutes and ignores a missing, junk or past time', () => {
  expect(resetText(new Date(NOW + 40 * MINUTE).toISOString(), NOW)).toBe('40m')
  expect(resetText(new Date(NOW + 40 * MINUTE + 1).toISOString(), NOW)).toBe('41m')
  expect(resetText(new Date(NOW + 60 * MINUTE).toISOString(), NOW)).toBe('1h00m')
  expect(resetText(new Date(NOW + 130 * MINUTE).toISOString(), NOW)).toBe('2h10m')
  expect(resetText(undefined, NOW)).toBeUndefined()
  expect(resetText('soon', NOW)).toBeUndefined()
  expect(resetText(new Date(NOW - MINUTE).toISOString(), NOW)).toBeUndefined()
})

test('the limit names are 5h and 7d', () => {
  expect(limitName('five_hour')).toBe('5h')
  expect(limitName('seven_day')).toBe('7d')
})

test('the context alarm fires once per crossing of 80% and re-arms only below 70%', () => {
  let armed = true
  const feed = (percent: number | undefined): boolean => {
    const next = contextAlarm(armed, percent)
    armed = next.isArmed

    return next.shouldFire
  }
  expect([62, 79, 80, 85, 75, 72, 81, 69, 80].map(feed)).toEqual([false, false, true, false, false, false, false, false, true])
  expect(feed(undefined)).toBe(false)
})

test('a limit alert fires once per window at 90% or more, and again for the next window', () => {
  const window1 = { kind: 'five_hour' as const, percent: 91, resetsAt: 'A' }
  const first = freshLimitAlerts(new Set(), [window1, { kind: 'seven_day', percent: 40, resetsAt: 'B' }])
  expect(first.fresh).toEqual([window1])
  expect(freshLimitAlerts(first.announced, [window1]).fresh).toEqual([])
  const window2 = { ...window1, resetsAt: 'C' }
  expect(freshLimitAlerts(first.announced, [window2]).fresh).toEqual([window2])
  expect(freshLimitAlerts(new Set(), [{ ...window1, percent: 89 }]).fresh).toEqual([])
})
```

Append to `hooks/layout.test.ts` (and add `stripRoom` to its import):

```ts
test('the strip gets the rows left after the chrome, scene, sessions block and one task row', () => {
  expect(stripRoom(40, 16, 0, 5)).toBe(5)
  expect(stripRoom(40, 16, 5, 5)).toBe(5)
  expect(stripRoom(24, 9, 0, 5)).toBe(5)
  expect(stripRoom(12, 0, 0, 5)).toBe(4)
  expect(stripRoom(10, 0, 0, 5)).toBe(2)
  expect(stripRoom(8, 0, 3, 5)).toBe(0)
  expect(stripRoom(40, 16, 0, 2)).toBe(2)
  expect(stripRoom(40, 16, 0, 0)).toBe(0)
})
```

- [x] **Step 3: Run the tests to see them fail.** Run: `claude plugin test . 2>&1 | tail -15`. Expected: failures about missing `./gauges` and `stripRoom`.

- [x] **Step 4: Implement `hooks/gauges.ts`:**

```ts
import type { Limit, Readings } from '../types'

export type Segment = { text: string; tone: 'text' | 'muted' | 'warn' }

/** Percent at which a figure turns to the warning tone and the context toast fires. */
export const WARN_PERCENT = 80
/** The context alarm re-arms once the fill falls below this. */
export const REARM_PERCENT = 70
/** A quota window at or above this raises one toast per window. */
export const LIMIT_TOAST_PERCENT = 90
const CONTEXT_CELLS = 8
const LIMIT_CELLS = 4
const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60
const KINDS: ReadonlyArray<Limit['kind']> = ['five_hour', 'seven_day']
const NAMES: Readonly<Record<Limit['kind'], string>> = { five_hour: '5h', seven_day: '7d' }

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (value: number): number => Math.min(100, Math.max(0, Math.round(value)))
const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const limitName = (kind: Limit['kind']): string => NAMES[kind]

/** The gauges from `$.session.usage()`'s answer; anything that is not a number in the expected place is left out. */
export function readingsFromUsage(usage: unknown): Readings {
  const root = asObject(usage)
  const context = asObject(root.context)
  let fill: number | undefined
  if (isNumber(context.percent)) fill = clamp(context.percent)
  else if (isNumber(context.tokens) && isNumber(context.window) && context.window > 0) {
    fill = clamp((context.tokens / context.window) * 100)
  }
  const limits: Limit[] = []
  for (const kind of KINDS) {
    const entry = Array.isArray(root.rateLimits) ? root.rateLimits.map(asObject).find(e => e.kind === kind) : undefined
    if (entry === undefined || !isNumber(entry.percentUsed)) continue
    limits.push({ kind, percent: clamp(entry.percentUsed), resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : undefined })
  }

  return { context: fill, limits }
}

/** Time until `resetsAt`, rounded up to whole minutes: `40m`, `2h10m`; undefined when missing, junk or past. */
export function resetText(resetsAt: string | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return undefined
  const minutes = Math.ceil((at - now) / MS_PER_MINUTE)
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`

  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h${String(minutes % MINUTES_PER_HOUR).padStart(2, '0')}m`
}

const bar = (percent: number, cells: number): string => {
  const filled = Math.round((percent / 100) * cells)

  return `${'▰'.repeat(filled)}${'▱'.repeat(cells - filled)}`
}

/** The gauges line as coloured pieces, or undefined when there is nothing to show. */
export function formatGauges(readings: Readings, now: number): Segment[] | undefined {
  const out: Segment[] = []
  const add = (label: string, percent: number, cells: number, reset: string | undefined): void => {
    if (out.length > 0) out.push({ text: '   ', tone: 'muted' })
    out.push({ text: `${label} `, tone: 'muted' }, { text: `${bar(percent, cells)} ${percent}%`, tone: percent >= WARN_PERCENT ? 'warn' : 'text' })
    if (reset !== undefined) out.push({ text: ` ↻${reset}`, tone: 'muted' })
  }
  if (readings.context !== undefined) add('ctx', readings.context, CONTEXT_CELLS, undefined)
  for (const limit of readings.limits) {
    add(limitName(limit.kind), limit.percent, LIMIT_CELLS, limit.percent >= WARN_PERCENT ? resetText(limit.resetsAt, now) : undefined)
  }

  return out.length === 0 ? undefined : out
}

/** One alarm per crossing of 80%: fires when armed and at or above it, re-arms below 70%, nothing in between. */
export function contextAlarm(isArmed: boolean, percent: number | undefined): { isArmed: boolean; shouldFire: boolean } {
  if (percent === undefined) return { isArmed, shouldFire: false }
  if (isArmed && percent >= WARN_PERCENT) return { isArmed: false, shouldFire: true }
  if (!isArmed && percent < REARM_PERCENT) return { isArmed: true, shouldFire: false }

  return { isArmed, shouldFire: false }
}

/** The limits at or above 90% not yet announced for their current window, and the announced set to keep. */
export function freshLimitAlerts(announced: ReadonlySet<string>, limits: readonly Limit[]): { fresh: Limit[]; announced: ReadonlySet<string> } {
  const key = (limit: Limit): string => `${limit.kind}@${limit.resetsAt ?? ''}`
  const fresh = limits.filter(limit => limit.percent >= LIMIT_TOAST_PERCENT && !announced.has(key(limit)))

  return { fresh, announced: new Set([...announced, ...fresh.map(key)]) }
}
```

- [x] **Step 5: Implement `stripRoom` in `hooks/layout.ts`.** After `DEFAULT_BODY_ROWS` add `/** Rows of the pane that are neither scene, strip, sessions block nor tasks: padding, bar, header lines, spacer. */ export const CHROME_ROWS = 7`, and at the end of the file:

```ts
/** Strip lines that fit: what is left after the chrome, scene and sessions block, keeping one task row. Lines beyond drop from the bottom. */
export function stripRoom(bodyRows: number, sceneRows: number, blockRows: number, wanted: number): number {
  return Math.max(0, Math.min(wanted, bodyRows - CHROME_ROWS - sceneRows - blockRows - 1))
}
```

- [x] **Step 6: Run the tests.** Run: `claude plugin test . 2>&1 | tail -6` — expected all pass (87 + the new ones, 0 fail). Run: `/home/vntrip/Documents/vntrip/admin-v3/node_modules/.bin/tsc -p /tmp/task-progress-tsconfig.json` — expected no output.

---

### Task 2: Activity (pure)

**Files:**
- Create: `hooks/activity.ts`
- Create: `hooks/activity.test.ts`
- Modify: `types/index.d.ts` (activity types)

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 5 and 6 use all of these):
  - types `RunningCall`, `Activity` from `../types`
  - `EMPTY_ACTIVITY: Activity`
  - `callLabel(tool: string, input: Record<string, unknown>): string`
  - `begin(state: Activity, call: { id: string; label: string; agentId: string | undefined }, now: number): Activity`
  - `end(state: Activity, id: string, now: number): Activity`
  - `agentCount(state: Activity, now: number): number`
  - `describeDoing(state: Activity, now: number): { text: string; isRunning: boolean; agents: string } | undefined`
  - `touchedDirectory(tool: string, input: Record<string, unknown>): string | undefined`

- [x] **Step 1: Add the types** to `types/index.d.ts` (before `declare module`):

```ts
/** A tool call of this session or one of its subagents that has started and not yet finished. */
export type RunningCall = { id: string; label: string; agentId: string | undefined; startedAt: number }
/** What the session is doing: calls in flight, the last main-session call, and when each subagent was last seen. */
export type Activity = {
  running: RunningCall[]
  last: { label: string; endedAt: number } | undefined
  agents: Record<string, number>
}
```

- [x] **Step 2: Write the failing tests.** Create `hooks/activity.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { EMPTY_ACTIVITY, agentCount, begin, callLabel, describeDoing, end, touchedDirectory } from './activity'

const T0 = 1_700_000_000_000
const SECOND = 1000
const call = (id: string, label: string, agentId?: string) => ({ id, label, agentId })

test('a call is labelled by its tool and its target', () => {
  expect(callLabel('Edit', { file_path: '/a/b/register.tsx' })).toBe('Edit register.tsx')
  expect(callLabel('Bash', { command: 'git   status\n--short' })).toBe('Bash git status --short')
  expect(callLabel('Bash', { command: 'x'.repeat(50) })).toBe(`Bash ${'x'.repeat(30)}`)
  expect(callLabel('Grep', { pattern: 'TODO' })).toBe('Grep TODO')
  expect(callLabel('Agent', { description: 'Review the diff' })).toBe('Agent Review the diff')
  expect(callLabel('mcp__plugin_x_github__create_issue', { title: 'x' })).toBe('create_issue')
  expect(callLabel('Read', { file_path: '/a/\u001b[31mred' })).toBe('Read [31mred')
  expect(callLabel('Bash', {})).toBe('Bash')
})

test('nothing running and nothing seen gives no line', () => {
  expect(describeDoing(EMPTY_ACTIVITY, T0)).toBeUndefined()
})

test('the oldest running main call is shown, with its time once it runs past 2 seconds', () => {
  let state = begin(EMPTY_ACTIVITY, call('1', 'Edit register.tsx'), T0)
  state = begin(state, call('2', 'Bash ls'), T0 + SECOND)
  expect(describeDoing(state, T0 + SECOND)).toEqual({ text: '▶ Edit register.tsx', isRunning: true, agents: '' })
  expect(describeDoing(state, T0 + 2 * SECOND)?.text).toBe('▶ Edit register.tsx')
  expect(describeDoing(state, T0 + 2500)?.text).toBe('▶ Edit register.tsx 2s')
  expect(describeDoing(state, T0 + 65 * SECOND)?.text).toBe('▶ Edit register.tsx 1m05s')
})

test('after a call ends the line reads as the last call for a minute, then goes', () => {
  const state = end(begin(EMPTY_ACTIVITY, call('1', 'Edit register.tsx'), T0), '1', T0 + 3 * SECOND)
  expect(describeDoing(state, T0 + 15 * SECOND)).toEqual({ text: '· Edit register.tsx 12s ago', isRunning: false, agents: '' })
  expect(describeDoing(state, T0 + 3 * SECOND + 60 * SECOND)?.text).toBe('· Edit register.tsx 1m00s ago')
  expect(describeDoing(state, T0 + 3 * SECOND + 61 * SECOND)).toBeUndefined()
})

test('ending a call that is not running changes nothing', () => {
  const state = begin(EMPTY_ACTIVITY, call('1', 'Bash ls'), T0)
  expect(end(state, 'nope', T0 + SECOND)).toBe(state)
})

test('subagents are counted by distinct id and never become the main line', () => {
  let state = begin(EMPTY_ACTIVITY, call('1', 'Read a.ts', 'ag1'), T0)
  state = begin(state, call('2', 'Bash ls', 'ag1'), T0)
  state = begin(state, call('3', 'Read b.ts', 'ag2'), T0)
  expect(agentCount(state, T0)).toBe(2)
  expect(describeDoing(state, T0)).toEqual({ text: '·', isRunning: false, agents: '+2 agents' })
  expect(describeDoing(begin(EMPTY_ACTIVITY, call('1', 'Read a.ts', 'ag1'), T0), T0)?.agents).toBe('+1 agent')
})

test('a subagent stays counted for 15 seconds after its last call, or while one of its calls runs', () => {
  const finished = end(begin(EMPTY_ACTIVITY, call('1', 'Read a.ts', 'ag1'), T0), '1', T0 + SECOND)
  expect(agentCount(finished, T0 + 16 * SECOND)).toBe(1)
  expect(agentCount(finished, T0 + 17 * SECOND)).toBe(0)
  const running = begin(EMPTY_ACTIVITY, call('1', 'Bash sleep', 'ag1'), T0)
  expect(agentCount(running, T0 + 600 * SECOND)).toBe(1)
})

test('the main line and the agent count show together', () => {
  const state = begin(begin(EMPTY_ACTIVITY, call('1', 'Agent review', undefined), T0), call('2', 'Read a.ts', 'ag1'), T0)
  expect(describeDoing(state, T0)).toEqual({ text: '▶ Agent review', isRunning: true, agents: '+1 agent' })
})

test('only Edit, Write, NotebookEdit and MultiEdit on an absolute path touch a directory', () => {
  expect(touchedDirectory('Edit', { file_path: '/work/svc/src/a.ts' })).toBe('/work/svc/src')
  expect(touchedDirectory('Write', { file_path: '/work/svc/my file.ts' })).toBe('/work/svc')
  expect(touchedDirectory('NotebookEdit', { notebook_path: '/work/n/a.ipynb' })).toBe('/work/n')
  expect(touchedDirectory('MultiEdit', { file_path: '/a.ts' })).toBe('/')
  expect(touchedDirectory('Read', { file_path: '/work/svc/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Bash', { command: 'sed -i x /work/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: 'src/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: '/work/\u0000/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: '/work/\nx/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', {})).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: 42 })).toBeUndefined()
})
```

- [x] **Step 3: Run to see them fail.** Run: `claude plugin test . 2>&1 | tail -8` — expected: missing `./activity`.

- [x] **Step 4: Implement `hooks/activity.ts`:**

```ts
import type { Activity } from '../types'

/** A subagent counts for this long after its last call. */
export const AGENT_WINDOW_MS = 15_000
/** The last main-session call is shown for this long after it ends. */
export const LAST_CALL_MS = 60_000
/** A running call shows its elapsed time once it passes this. */
export const SLOW_MS = 2000
/** A call's target (file, command, pattern) is cut to this many characters. */
export const TARGET_MAX = 30
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f  ]/g
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f  ]/

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
  for (const call of state.running) if (call.agentId !== undefined) ids.add(call.agentId)

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
  const main = state.running.find(r => r.agentId === undefined)
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
```

Note on the test `callLabel('Read', { file_path: '/a/\u001b[31mred' })`: the base name is `\u001b[31mred`, the escape becomes a space and is trimmed, giving `[31mred`.

- [x] **Step 5: Run the tests and tsc.** `claude plugin test . 2>&1 | tail -6` all pass, 0 fail; `tsc -p /tmp/task-progress-tsconfig.json` no output.

---

### Task 3: Repositories (pure)

**Files:**
- Create: `hooks/repos.ts`
- Create: `hooks/repos.test.ts`
- Modify: `types/index.d.ts` (repo types)

**Interfaces:**
- Consumes: `truncate` from `./style`.
- Produces (Task 6 uses all):
  - types `RepoStatus`, `Repo` from `../types`
  - `parseStatus(stdout: string): RepoStatus | undefined`
  - `touchRepo(repos: readonly Repo[], root: string, now: number): Repo[]`
  - `applyReading(repos: readonly Repo[], root: string, reading: RepoStatus | 'skip' | 'fail'): Repo[]`
  - `visibleRepos(repos: readonly Repo[]): { shown: Repo[]; more: number }`
  - `repoName(root: string): string`
  - `repoLine(name: string, status: RepoStatus, width: number): { name: string; branch: string; detail: string }`
  - `type RootCache = ReadonlyMap<string, string>`, `cacheRoot(cache: RootCache, dir: string, root: string): RootCache`
  - constants `MAX_TRACKED = 6`, `MAX_FAILURES = 3`

- [x] **Step 1: Add the types** to `types/index.d.ts`:

```ts
/** A repository's branch, changed files (tracked changes plus untracked files) and distance from its upstream. */
export type RepoStatus = { branch: string; changed: number; ahead: number; behind: number }
/** A repository the session has edited: its root, when it was last edited, its last good reading, and failed polls in a row. */
export type Repo = { root: string; touchedAt: number; status: RepoStatus | undefined; failures: number }
```

- [x] **Step 2: Write the failing tests.** Create `hooks/repos.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import type { Repo } from '../types'
import { MAX_FAILURES, MAX_TRACKED, applyReading, cacheRoot, parseStatus, repoLine, repoName, touchRepo, visibleRepos } from './repos'

const status = (changed = 0, branch = 'main') => ({ branch, changed, ahead: 0, behind: 0 })
const repo = (root: string, touchedAt = 1): Repo => ({ root, touchedAt, status: status(), failures: 0 })
const unread = (root: string): Repo => ({ root, touchedAt: 1, status: undefined, failures: 0 })

test('status output gives branch, changed files and distance from the upstream', () => {
  expect(parseStatus('## dev-x...origin/dev-x [ahead 2, behind 1]\n M a.ts\n?? b.ts\n')).toEqual({ branch: 'dev-x', changed: 2, ahead: 2, behind: 1 })
  expect(parseStatus('## dev-x...origin/dev-x [ahead 3]\n')).toEqual({ branch: 'dev-x', changed: 0, ahead: 3, behind: 0 })
  expect(parseStatus('## dev-x...origin/dev-x [behind 4]\n')).toEqual({ branch: 'dev-x', changed: 0, ahead: 0, behind: 4 })
  expect(parseStatus('## dev-x...origin/dev-x [gone]\n')).toEqual({ branch: 'dev-x', changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus('## main\n')).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus('## feat/a-b...origin/feat/a-b\nA  x\nD  y\n')).toEqual({ branch: 'feat/a-b', changed: 2, ahead: 0, behind: 0 })
})

test('an unborn or detached branch has a readable name', () => {
  expect(parseStatus('## No commits yet on main\n?? a\n')).toEqual({ branch: 'main', changed: 1, ahead: 0, behind: 0 })
  expect(parseStatus('## Initial commit on main\n')).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus('## HEAD (no branch)\n M a\n')).toEqual({ branch: '(detached)', changed: 1, ahead: 0, behind: 0 })
})

test('output that is not a status gives nothing', () => {
  expect(parseStatus('')).toBeUndefined()
  expect(parseStatus('fatal: not a git repository\n')).toBeUndefined()
  expect(parseStatus('## \n')).toBeUndefined()
})

test('a touched repository moves to the front, a new one is added, six at most are tracked', () => {
  let repos: Repo[] = []
  for (let i = 0; i < MAX_TRACKED + 2; i += 1) repos = touchRepo(repos, `/w/r${i}`, i)
  expect(repos.map(r => r.root)).toEqual(['/w/r7', '/w/r6', '/w/r5', '/w/r4', '/w/r3', '/w/r2'])
  repos = touchRepo(repos, '/w/r3', 100)
  expect(repos.map(r => r.root)).toEqual(['/w/r3', '/w/r7', '/w/r6', '/w/r5', '/w/r4', '/w/r2'])
  expect(repos[0]?.touchedAt).toBe(100)
})

test('touching a repository keeps its last reading and clears its failures', () => {
  const failing: Repo = { root: '/w/a', touchedAt: 1, status: status(3), failures: 2 }
  expect(touchRepo([failing], '/w/a', 9)).toEqual([{ root: '/w/a', touchedAt: 9, status: status(3), failures: 0 }])
})

test('a good reading is stored, a skipped one changes nothing, three failures in a row drop the repository', () => {
  let repos = [unread('/w/a'), repo('/w/b')]
  repos = applyReading(repos, '/w/a', status(4, 'dev'))
  expect(repos[0]?.status).toEqual(status(4, 'dev'))
  expect(applyReading(repos, '/w/a', 'skip')).toEqual(repos)
  for (let i = 1; i < MAX_FAILURES; i += 1) repos = applyReading(repos, '/w/a', 'fail')
  expect(repos.map(r => r.root)).toEqual(['/w/a', '/w/b'])
  expect(repos[0]?.failures).toBe(MAX_FAILURES - 1)
  repos = applyReading(repos, '/w/a', 'fail')
  expect(repos.map(r => r.root)).toEqual(['/w/b'])
  expect(applyReading(applyReading(repos, '/w/b', 'fail'), '/w/b', status(1))[0]?.failures).toBe(0)
})

test('up to three repositories are shown, from four on two are shown and the rest counted', () => {
  const at = (n: number) => Array.from({ length: n }, (_, i) => repo(`/w/r${i}`))
  expect(visibleRepos(at(0))).toEqual({ shown: [], more: 0 })
  expect(visibleRepos(at(3)).shown.length).toBe(3)
  expect(visibleRepos(at(3)).more).toBe(0)
  expect(visibleRepos(at(4)).shown.map(r => r.root)).toEqual(['/w/r0', '/w/r1'])
  expect(visibleRepos(at(4)).more).toBe(2)
  expect(visibleRepos(at(6)).more).toBe(4)
})

test('a repository without a first reading is not shown or counted', () => {
  expect(visibleRepos([unread('/w/a'), repo('/w/b')])).toEqual({ shown: [repo('/w/b')], more: 0 })
})

test('the repository name is the last part of its root', () => {
  expect(repoName('/home/me/work/core-inventory-service')).toBe('core-inventory-service')
  expect(repoName('/')).toBe('/')
})

test('a repository line shows the changed count, a tick for a clean one, and the distance from the upstream', () => {
  expect(repoLine('admin-v3', { branch: 'dev', changed: 8, ahead: 2, behind: 0 }, 80)).toEqual({ name: 'admin-v3', branch: 'dev', detail: '●8 ↑2' })
  expect(repoLine('admin-v3', { branch: 'dev', changed: 0, ahead: 0, behind: 1 }, 80).detail).toBe('✓ ↓1')
  expect(repoLine('a', { branch: 'dev', changed: 1, ahead: 1, behind: 1 }, 80).detail).toBe('●1 ↑1 ↓1')
})

test('a long branch is cut in the middle, never the repository name', () => {
  const long = 'dev-dat-rate-sheet-duplicate-fixes-and-more'
  const line = repoLine('admin-v3', { branch: long, changed: 8, ahead: 0, behind: 0 }, 40)
  expect(line.name).toBe('admin-v3')
  expect(line.branch.includes('…')).toBe(true)
  expect(line.branch.startsWith('dev-')).toBe(true)
  expect(line.branch.endsWith('more')).toBe(true)
  expect(`⎇ ${line.name}  ${line.branch}  ${line.detail}`.length <= 40).toBe(true)
})

test('only when the name alone leaves no room is the name cut', () => {
  const line = repoLine('a-very-long-repository-name-indeed', { branch: 'dev-branch', changed: 3, ahead: 0, behind: 0 }, 30)
  expect(line.name.endsWith('…')).toBe(true)
  expect(`⎇ ${line.name}  ${line.branch}  ${line.detail}`.length <= 30).toBe(true)
})

test('the root cache keeps the newest 200 directories', () => {
  let cache = cacheRoot(new Map(), '/w/a/src', '/w/a')
  expect(cache.get('/w/a/src')).toBe('/w/a')
  for (let i = 0; i < 205; i += 1) cache = cacheRoot(cache, `/d/${i}`, `/r/${i}`)
  expect(cache.size).toBe(200)
  expect(cache.has('/w/a/src')).toBe(false)
  expect(cache.get('/d/204')).toBe('/r/204')
  expect(cacheRoot(cache, '/d/204', '/r/x').size).toBe(200)
})
```

- [x] **Step 3: Run to see them fail.** `claude plugin test . 2>&1 | tail -8` — expected: missing `./repos`.

- [x] **Step 4: Implement `hooks/repos.ts`:**

```ts
import type { Repo, RepoStatus } from '../types'
import { truncate } from './style'

/** Repositories tracked at once; the least recently edited one is dropped for a seventh. */
export const MAX_TRACKED = 6
/** Up to this many repositories are shown; from one more on, two are shown and the rest counted. */
export const MAX_SHOWN = 3
const SHOWN_WHEN_MORE = 2
/** A repository whose status fails this many polls in a row is dropped. */
export const MAX_FAILURES = 3
const CACHE_MAX = 200
const MIN_BRANCH = 4
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f  ]/g

export type RootCache = ReadonlyMap<string, string>

/** The branch, changed-file count and distance from the upstream out of `git status --porcelain -b`. */
export function parseStatus(stdout: string): RepoStatus | undefined {
  const lines = stdout.split('\n').filter(line => line !== '')
  const head = lines[0]
  if (head === undefined || !head.startsWith('## ')) return undefined
  const changed = lines.length - 1
  const text = head.slice(3)
  let branch: string
  let ahead = 0
  let behind = 0
  if (text.startsWith('HEAD (no branch)')) branch = '(detached)'
  else if (text.startsWith('No commits yet on ')) branch = text.slice('No commits yet on '.length)
  else if (text.startsWith('Initial commit on ')) branch = text.slice('Initial commit on '.length)
  else {
    const track = /\[([^\]]*)\]\s*$/.exec(text)
    branch = (track === null ? text : text.slice(0, track.index)).trim().split('...')[0] ?? ''
    ahead = Number(/ahead (\d+)/.exec(track?.[1] ?? '')?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(track?.[1] ?? '')?.[1] ?? 0)
  }
  branch = branch.replace(CONTROL_CHARS, ' ').trim()

  return branch === '' ? undefined : { branch, changed, ahead, behind }
}

/** The repository was just edited: it goes to the front with its failures cleared and its last reading kept. */
export function touchRepo(repos: readonly Repo[], root: string, now: number): Repo[] {
  const previous = repos.find(r => r.root === root)
  const entry: Repo = { root, touchedAt: now, status: previous?.status, failures: 0 }

  return [entry, ...repos.filter(r => r.root !== root)].slice(0, MAX_TRACKED)
}

/** One poll's outcome for a repository: a status replaces the last one, `skip` keeps it, `fail` counts toward dropping it. */
export function applyReading(repos: readonly Repo[], root: string, reading: RepoStatus | 'skip' | 'fail'): Repo[] {
  return repos.flatMap(repo => {
    if (repo.root !== root || reading === 'skip') return [repo]
    if (reading === 'fail') return repo.failures + 1 >= MAX_FAILURES ? [] : [{ ...repo, failures: repo.failures + 1 }]

    return [{ ...repo, status: reading, failures: 0 }]
  })
}

/** The repositories to draw: only those already read; with more than three, two are drawn and the rest counted. */
export function visibleRepos(repos: readonly Repo[]): { shown: Repo[]; more: number } {
  const ready = repos.filter(repo => repo.status !== undefined)
  if (ready.length <= MAX_SHOWN) return { shown: ready, more: 0 }

  return { shown: ready.slice(0, SHOWN_WHEN_MORE), more: ready.length - SHOWN_WHEN_MORE }
}

export const repoName = (root: string): string => root.slice(root.lastIndexOf('/') + 1) || root

const cutMiddle = (text: string, width: number): string => {
  if (text.length <= width) return text
  if (width <= 1) return '…'
  const keep = width - 1
  const tail = Math.floor(keep / 2)

  return `${text.slice(0, Math.ceil(keep / 2))}…${tail > 0 ? text.slice(-tail) : ''}`
}

/** The pieces of one repository line, `⎇ name  branch  detail`, fitted to `width`: the branch is cut in the middle first, the name only as a last resort. */
export function repoLine(name: string, status: RepoStatus, width: number): { name: string; branch: string; detail: string } {
  const detail = [status.changed === 0 ? '✓' : `●${status.changed}`, status.ahead > 0 ? `↑${status.ahead}` : '', status.behind > 0 ? `↓${status.behind}` : '']
    .filter(part => part !== '')
    .join(' ')
  const frame = '⎇ '.length + '  '.length + '  '.length + detail.length
  let room = width - frame - name.length
  let shownName = name
  if (room < MIN_BRANCH) {
    shownName = truncate(name, Math.max(1, name.length + room - MIN_BRANCH))
    room = MIN_BRANCH
  }

  return { name: shownName, branch: cutMiddle(status.branch, room), detail }
}

/** Remembers a directory's repository root; the oldest entries beyond 200 are forgotten. */
export function cacheRoot(cache: RootCache, dir: string, root: string): RootCache {
  const next = new Map([...cache].filter(([key]) => key !== dir))
  next.set(dir, root)

  return new Map([...next].slice(-CACHE_MAX))
}
```

- [x] **Step 5: Run the tests and tsc.** `claude plugin test . 2>&1 | tail -6` all pass; tsc no output. If a `repoLine` width assertion fails, check the arithmetic of `frame` (two for `⎇ `, two for each `  ` separator, plus the detail) against the test, not the other way round.

---

### Task 4: Watch module, gauges line, usage timer, toast, strip layout

**Files:**
- Create: `hooks/watch.ts`
- Modify: `hooks/register.tsx`
- Modify: `hooks/register.test.ts` (append tests)
- Modify: `types/index.d.ts` (`PluginState`)
- Modify: `.claude-plugin/plugin.json` (option `isContextWarningOn`)

**Interfaces:**
- Consumes: Task 1's `readingsFromUsage`, `formatGauges`, `resetText`, `limitName`, `contextAlarm`, `freshLimitAlerts`, `stripRoom`, `CHROME_ROWS`; types `GaugeState`, `Readings`.
- Produces (Tasks 5 and 6 build on these):
  - `watch.ts`: `readUsage($): Promise<Readings | undefined>`, `resetWatchState(): void`, and the shared `logOnce($, key, error)` (Task 6 adds `findRoot` and `readStatus` to this file)
  - in `register.tsx`: the `gauges` atom, helper `present<T>(list): T[]`, the line `const strip = present([gaugeLine])` and the placement of `<Box flexDirection="column">{strip}</Box>` in both branches of the pane (Tasks 5 and 6 extend the array), `stripRows` used by `room`

- [x] **Step 1: Write the failing tests.** Append to `hooks/register.test.ts` (it already imports `expect, mock, test`, `On` and `Engine`; reuse `mockDisk`, `boot`, `mountPane`, `NOW`, `POLL_MS`):

```ts
const USAGE_MS = 5000
const MINUTE = 60_000

const gaugeUsage = (context: number, five = 31, resetsAt?: string) => ({
  startedAt: NOW,
  context: { tokens: context * 10_000, window: 1_000_000, percent: context },
  rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt }, { kind: 'seven_day', percentUsed: 9 }],
  cost: { usd: 0.1 },
})

/** `session.usage` answers with `current.value`; undefined makes it fail like a broken engine would. */
function mockUsage(on: On, current: { value: unknown }): void {
  on('session.usage', () => {
    if (current.value === undefined) throw new Error('no usage')

    return { value: current.value }
  })
}

test('the strip shows the context and both quota windows from the session usage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(62) })
  await boot($)
  await clock.settle()
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /31%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /7d/ })).toBeDefined()
  await ui.unmount()
})

test('without a usage reading the pane has no gauges line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  await boot($)
  await clock.settle()
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('a failing usage read keeps the gauges for 30 seconds, then hides them', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  const usage: { value: unknown } = { value: gaugeUsage(62) }
  mockUsage(on, usage)
  await boot($)
  await clock.settle()
  usage.value = undefined

  await clock.advance(25_000)
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(10_000)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeUndefined()
  await ui.unmount()
})

test('the context toast fires once per crossing of 80% and again after a dip below 70%', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mockDisk(on)
  const usage: { value: unknown } = { value: gaugeUsage(62) }
  mockUsage(on, usage)
  await boot($)
  await clock.settle()
  for (const percent of [82, 85, 75, 65, 81]) {
    usage.value = gaugeUsage(percent)
    await clock.advance(USAGE_MS)
  }

  expect(toasts).toEqual(['ctx 82% · consider /compact', 'ctx 81% · consider /compact'])
})

test('a quota window at 90% toasts once per window, with its reset time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mockDisk(on)
  const usage: { value: unknown } = { value: gaugeUsage(10, 91, new Date(NOW + 40 * MINUTE).toISOString()) }
  mockUsage(on, usage)
  await boot($)
  await clock.settle()
  await clock.advance(USAGE_MS)
  expect(toasts).toEqual(['5h limit 91% · resets in 40m'])

  usage.value = gaugeUsage(10, 92, new Date(NOW + 300 * MINUTE).toISOString())
  await clock.advance(USAGE_MS)
  expect(toasts).toEqual(['5h limit 91% · resets in 40m', '5h limit 92% · resets in 5h00m'])
})

test('the toasts can be turned off', { options: { isContextWarningOn: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(95, 95) })
  await boot($)
  await clock.settle()
  await clock.advance(USAGE_MS * 2)

  expect(toasts).toEqual([])
})

test('a toast that fails never breaks the usage read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => {
    throw new Error('no terminal')
  })
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(95) })
  await boot($)
  await clock.settle()
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /95%/ })).toBeDefined()
  await ui.unmount()
})

test('a short pane drops strip lines from the bottom but keeps a task row', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(62) })
  await boot($)
  await clock.settle()
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'only task', status: 'in_progress', activeForm: 'O' }] })
  const ui = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 8 } } as never,
    requestId: 'task-progress',
  })

  expect(await ui.find({ type: 'Text', text: /only task/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})
```

- [x] **Step 2: Run to see them fail.** `claude plugin test . 2>&1 | grep -E "fail|pass$" | tail -12` — expected: the new tests fail (no `ctx` text), the old ones pass.

- [x] **Step 3: Add the state type and the option.** In `types/index.d.ts`, change the `PluginState` line to also hold `gauges: GaugeState | undefined`. In `.claude-plugin/plugin.json` add to `userConfig` (after `isWaitSoundOn`):

```json
    "isContextWarningOn": {
      "type": "boolean",
      "title": "Warn when the context or a quota window is nearly full",
      "description": "A toast when the context passes 80% (once per crossing) and when the 5h or 7d quota passes 90% (once per window).",
      "default": true
    }
```

- [x] **Step 4: Create `hooks/watch.ts`:**

```ts
import type { EngineInterface } from 'claude-code'

import type { Readings } from '../types'
import { readingsFromUsage } from './gauges'

/** Failures already told to the debug channel, by kind: each kind is logged once. */
const logged = new Set<string>()

/** Module state starts fresh with every registration. */
export function resetWatchState(): void {
  logged.clear()
}

/** A failure of this feature is logged once per kind to the debug channel and never reaches the session. */
export async function logOnce($: EngineInterface, kind: string, error: unknown): Promise<void> {
  if (logged.has(kind)) return
  logged.add(kind)
  try {
    await $.ui.log(`task-progress: ${kind}: ${String(error)}`, { to: 'debug' })
  } catch {
    // nothing left to tell
  }
}

/** The gauges from the session usage, or undefined when the read failed. */
export async function readUsage($: EngineInterface): Promise<Readings | undefined> {
  try {
    return readingsFromUsage(await $.session.usage())
  } catch (error) {
    await logOnce($, 'could not read the session usage', error)

    return undefined
  }
}
```

- [x] **Step 5: Wire `hooks/register.tsx`.**
  1. Imports. Add after the `./compositor` import: `import { contextAlarm, formatGauges, freshLimitAlerts, limitName, resetText } from './gauges'`. Change the `./layout` import to `import { CHROME_ROWS, DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout, stripRoom } from './layout'`. Add `import { readUsage, resetWatchState } from './watch'` after the `./sync` import. Change the types import to `import type { GaugeState, Item, SessionRow, TaskStatus } from '../types'`.
  2. Constants, after `POLL_MS`:

```ts
/** How often the session usage is read. */
const USAGE_MS = 5000
/** Gauges older than this are hidden when reads keep failing. */
const GAUGE_STALE_MS = 30_000
```

  3. Module state, after `let hasChimed = false`:

```ts
let isContextWarningOn = true
/** Whether the next crossing of 80% raises the context toast. */
let isContextArmed = true
let announcedLimits: ReadonlySet<string> = new Set()
let isReadingUsage = false
```

  4. Atom, after the `sessions` atom: `const gauges = atom({ plugin: 'task-progress', key: 'gauges' } as const, undefined as GaugeState | undefined)`.
  5. A helper after `isOk`:

```ts
/** The elements that are there, without the nulls left by a line with nothing to show. */
function present<T>(list: ReadonlyArray<T | null>): T[] {
  return list.filter((entry): entry is T => entry !== null)
}
```

  6. The refresh, after `refreshSessions`:

```ts
/** One read of the session usage: updates the gauges, keeps the last ones for 30 s when it fails, and raises the toasts. */
async function refreshGauges($: EngineInterface): Promise<void> {
  if (isReadingUsage) return
  isReadingUsage = true
  try {
    const now = await $.clock.now()
    const readings = await readUsage($)
    if (readings === undefined) {
      await update($, gauges, prev => (prev !== undefined && now - prev.at > GAUGE_STALE_MS ? undefined : prev))

      return
    }
    await update($, gauges, () => ({ readings, at: now }))
    if (!isContextWarningOn) return
    const alarm = contextAlarm(isContextArmed, readings.context)
    isContextArmed = alarm.isArmed
    const alerts = freshLimitAlerts(announcedLimits, readings.limits)
    announcedLimits = alerts.announced
    const messages = [
      ...(alarm.shouldFire ? [`ctx ${readings.context}% · consider /compact`] : []),
      ...alerts.fresh.map(limit => {
        const left = resetText(limit.resetsAt, now)

        return `${limitName(limit.kind)} limit ${limit.percent}%${left === undefined ? '' : ` · resets in ${left}`}`
      }),
    ]
    for (const message of messages) {
      try {
        $.ui.toast(message)
      } catch {
        // a toast is a side effect: it must never throw into the session
      }
    }
  } finally {
    isReadingUsage = false
  }
}
```

  7. In `register`: after `isWaitSoundOn = …` add `isContextWarningOn = options.isContextWarningOn !== false`; after `previousStatus = undefined` add `isContextArmed = true`, `announcedLimits = new Set()`, `isReadingUsage = false`, `resetWatchState()`. In `session.start`, after `await refreshSessions($)` add `await refreshGauges($)` and, after the existing `$.clock.every(POLL_MS, …)`, add:

```ts
    $.clock.every(USAGE_MS, () => {
      void refreshGauges($)
    })
```

  8. In the `ui.render` hook. After `const blockRows = …` add:

```ts
    const gaugeState = await read($, gauges)
    const gaugeSegments = gaugeState === undefined ? undefined : formatGauges(gaugeState.readings, now)
```

  Replace the line `const room = Math.max(1, bodyRows - 7 - (layout?.rows ?? 0) - blockRows)` by the following block (the gauge line must be built after `Text` exists; it is, `Box, Text` are destructured at the top of the hook):

```ts
    const gaugeLine =
      gaugeSegments === undefined ? null : (
        <Text>
          {gaugeSegments.map(segment => (
            <Text color={segment.tone === 'warn' ? COLORS.warn : segment.tone === 'muted' ? COLORS.muted : COLORS.text}>{segment.text}</Text>
          ))}
        </Text>
      )
    const wanted = present([gaugeLine])
    const strip = wanted.slice(0, stripRoom(bodyRows, layout?.rows ?? 0, blockRows, wanted.length))
    const stripBlock = <Box flexDirection="column">{strip}</Box>
    const room = Math.max(1, bodyRows - CHROME_ROWS - (layout?.rows ?? 0) - blockRows - strip.length)
```

  Place `{stripBlock}` in the pane: in the `total === 0` branch, between the `No tasks yet` `<Text>` and `{sessionBlock}`; in the other branch, between the `{isStale && …}` line and `{sessionBlock}`.

- [x] **Step 6: Run everything.** `claude plugin test . 2>&1 | tail -6` all pass, 0 fail; `tsc -p /tmp/task-progress-tsconfig.json` no output; `claude plugin validate . 2>&1 | tail -6` passes (warnings fine). If the validator rejects a call, the cause is a `$` passed somewhere that is not a top-level function: move that code into a top-level function.

---

### Task 5: Activity hook and the doing line

**Files:**
- Modify: `hooks/register.tsx`
- Modify: `hooks/register.test.ts` (append)
- Modify: `types/index.d.ts` (`PluginState` gets `activity: Activity`)

**Interfaces:**
- Consumes: Task 2's `EMPTY_ACTIVITY`, `begin`, `end`, `callLabel`, `describeDoing`; Task 4's `present`, `strip`, `stripBlock`, `isOk`, `LIST_TOOLS`.
- Produces for Task 6: `endCall($, e, id, isSuccess)` where Task 6 adds the repository tracking inside it; the `doingLine` element in the `present([…])` array.

- [x] **Step 1: Write the failing tests.** Append to `hooks/register.test.ts`:

```ts
const activitySetup = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  await boot($)
  await clock.settle()

  return clock
}

test('while a tool runs the pane names it, afterwards it reads as the last call', async ($, on) => {
  await activitySetup($, on)
  let ui = await mountPane($)
  let whileRunning: unknown
  on('tool.call', { tool: 'Edit' }, async () => {
    whileRunning = await ui.find({ type: 'Text', text: /▶ Edit register\.tsx/ })

    return { result: 'ok' }
  })

  await $.tool.call({ tool: 'Edit', file_path: '/x/register.tsx', old_string: 'a', new_string: 'b' } as never)

  expect(whileRunning).toBeDefined()
  await ui.unmount()
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /· Edit register\.tsx 0s ago/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeUndefined()
  await ui.unmount()
})

test('the list tools never show as activity', async ($, on) => {
  await activitySetup($, on)
  await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'a', status: 'in_progress' }] } as never)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /progress/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent call counts as an agent and never as the main line', async ($, on) => {
  const clock = await activitySetup($, on)
  const ui = await mountPane($)
  let seen: unknown
  on('tool.call', { tool: 'Read' }, async () => {
    seen = await ui.find({ type: 'Text', text: /\+1 agent/ })

    return { result: 'ok' }
  })

  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts', agentId: SUBAGENT } as never)
  expect(seen).toBeDefined()
  await ui.unmount()

  let again = await mountPane($)
  expect(await again.find({ type: 'Text', text: /\+1 agent/ })).toBeDefined()
  expect(await again.find({ type: 'Text', text: /Read a\.ts/ })).toBeUndefined()
  await again.unmount()

  await clock.advance(20_000)
  again = await mountPane($)
  expect(await again.find({ type: 'Text', text: /agent/ })).toBeUndefined()
  await again.unmount()
})

test('the hook leaves the result alone, and a tool that throws leaves no running line and is not run twice', async ($, on) => {
  await activitySetup($, on)
  let runs = 0
  on('tool.call', { tool: 'Bash' }, () => {
    runs += 1
    throw new Error('boom')
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: 'same' }))

  expect(await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' } as never)).toEqual({ result: 'same' })
  let failed = false
  try {
    await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  } catch {
    failed = true
  }
  const ui = await mountPane($)

  expect(failed).toBe(true)
  expect(runs).toBe(1)
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeUndefined()
  await ui.unmount()
})
```

- [x] **Step 2: Run to see them fail.** `claude plugin test . 2>&1 | grep -E "fail" | tail -8` — the first three new tests fail (if `$.tool.call` wraps the tool's answer in more fields than `{ result }`, compare the `result` field in the fourth test and in the git-missing test of Task 6, not the whole value; likewise if `ui.find` inside a core hook needs `await clock.settle()` first, add it); the fourth may pass already for the `Read` result and fail for nothing else — that is fine, it is a guard.

- [x] **Step 3: Wire `hooks/register.tsx`.**
  1. Imports: add `import { EMPTY_ACTIVITY, begin, callLabel, describeDoing, end } from './activity'`; the types import becomes `import type { Activity, GaugeState, Item, SessionRow, TaskStatus } from '../types'` (keep alphabetical order as the file does).
  2. Atom, after `gauges`: `const activity = atom({ plugin: 'task-progress', key: 'activity' } as const, EMPTY_ACTIVITY as Activity)`.
  3. Module counter, after `isReadingUsage`: `let callSeq = 0`, and reset it with the others in `register` (`callSeq = 0`).
  4. Bookkeeping functions, after `refreshGauges` (top-level; both swallow their own errors, nothing here may reach the tool call):

```ts
/** A call starts: remember it so the pane can name it. */
async function beginCall($: EngineInterface, e: { tool: string; agentId?: string }, id: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const label = callLabel(e.tool, e as unknown as Record<string, unknown>)
    await update($, activity, a => begin(a, { id, label, agentId: e.agentId }, now))
  } catch {
    // bookkeeping must never reach the tool call
  }
}

/** A call ended, with or without success. */
async function endCall($: EngineInterface, e: { tool: string; agentId?: string }, id: string, isSuccess: boolean): Promise<void> {
  try {
    const now = await $.clock.now()
    await update($, activity, a => end(a, id, now))
  } catch {
    // bookkeeping must never reach the tool call
  }
}
```

  `isSuccess` and `e` are unused until Task 6; keep them in the signature (Task 6 uses both) and make sure tsc has no unused-parameter error (the tsconfig does not enable `noUnusedParameters`; if it fails, prefix with `_` and rename in Task 6).
  5. The hook. Add it right after the existing stale-counter `on('tool.call', …)` hook. No `.catch` (see Global Constraints):

```ts
  // Records what runs. It returns exactly what the tool returns and has no `.catch`: a catch handler would
  // call `next` again and run a tool twice when the tool itself throws.
  on('tool.call', async ($, e, next) => {
    if (LIST_TOOLS.includes(e.tool)) return next(e)
    callSeq += 1
    const id = `call-${callSeq}`
    await beginCall($, e, id)
    try {
      const ran = await next(e)
      await endCall($, e, id, isOk(ran))

      return ran
    } catch (error) {
      await endCall($, e, id, false)
      throw error
    }
  })
```

  6. In `ui.render`, after `gaugeSegments`: `const doing = describeDoing(await read($, activity), now)`. After `gaugeLine` add:

```ts
    const agentRoom = doing === undefined || doing.agents === '' ? 0 : doing.agents.length + 1
    const doingLine =
      doing === undefined ? null : (
        <Text>
          <Text color={doing.isRunning ? COLORS.active : COLORS.muted}>{truncate(doing.text, Math.max(1, inner - agentRoom))}</Text>
          {doing.agents !== '' && <Text color={COLORS.accent}> {doing.agents}</Text>}
        </Text>
      )
```

  and change `present([gaugeLine])` to `present([gaugeLine, doingLine])`.

- [x] **Step 4: Run everything.** Tests all pass, tsc clean, validate passes. The validator may warn "gating hook without .catch: tool.call"; that warning is expected and intended.

---

### Task 6: Repositories: git reads, tracking, repository lines

**Files:**
- Modify: `hooks/watch.ts` (add `findRoot`, `readStatus`)
- Modify: `hooks/register.tsx`
- Modify: `hooks/register.test.ts` (extend `mockDisk`, append tests)
- Modify: `types/index.d.ts` (`PluginState` gets `repos: Repo[]`)

**Interfaces:**
- Consumes: Task 3's `parseStatus` (inside `watch.ts`), `touchRepo`, `applyReading`, `visibleRepos`, `repoName`, `repoLine`, `cacheRoot`, `RootCache`; Task 2's `touchedDirectory`; Task 5's `endCall`.
- Produces: the finished strip: `repoLines` in the `present([…])` array.

- [x] **Step 1: Extend `mockDisk` and write the failing tests.** In `hooks/register.test.ts`, give the `Disk` type two more fields — `git: string[][]` and `gitReply: (argv: readonly string[]) => { exitCode: number; stdout: string; isStdoutTruncated?: boolean }` — initialise them in `mockDisk` (`git: []`, and a default `gitReply` that answers `exitCode: 128, stdout: ''`), and in its `process.run` handler add, before the final `else`, a branch:

```ts
    } else if (e.argv[0] === 'git') {
      disk.git.push([...e.argv])
      const reply = disk.gitReply(e.argv)

      return { value: { ...OK_RUN, ...reply } }
```

  (Return exactly as the other branches do: the handler's last statement `return { value: OK_RUN }` stays for the remaining branches. `OK_RUN` is defined further down the file at module level, which is fine because it is only read when a process runs.) Then append:

```ts
/** A git world: each directory prefix maps to a repository root, each root to its `status -b` text. */
function gitWorld(disk: Disk, roots: Record<string, string>, statuses: Record<string, string>) {
  disk.gitReply = argv => {
    if (argv.includes('rev-parse')) {
      const dir = argv[2] ?? ''
      const root = Object.keys(roots).find(prefix => dir === prefix || dir.startsWith(`${prefix}/`))

      return root === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `${root}\n` }
    }
    const root = argv[argv.indexOf('-C') + 1] ?? ''

    return { exitCode: 0, stdout: statuses[root] ?? '' }
  }
}

const edit = ($: Engine, path: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', agentId } as never)

async function repoSetup($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  const disk = mockDisk(on)
  await boot($)
  await clock.settle()

  return { clock, disk }
}

const GIT_POLL_MS = 10_000

test('editing a file in a repository shows its branch, changed files and distance from the upstream', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## dev-x...origin/dev-x [ahead 2]\n M a.ts\n?? b.ts\n' })

  await edit($, '/w/svc-a/src/x.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /dev-x/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑2/ })).toBeDefined()
  expect(disk.git).toEqual([
    ['git', '-C', '/w/svc-a/src', 'rev-parse', '--show-toplevel'],
    ['git', '--no-optional-locks', '-C', '/w/svc-a', 'status', '--porcelain', '-b'],
  ])
  await ui.unmount()
})

test('a clean repository shows a tick', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main...origin/main\n' })
  await edit($, '/w/svc-a/a.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
  await ui.unmount()
})

test('reads, shell commands, relative paths and files outside any repository start no repository tracking', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n' })

  await $.tool.call({ tool: 'Read', file_path: '/w/svc-a/a.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'sed -i x /w/svc-a/a.ts' } as never)
  await edit($, 'src/relative.ts')
  expect(disk.git).toEqual([])

  await edit($, '/tmp/elsewhere/x.ts')
  const ui = await mountPane($)
  expect(disk.git.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent edit counts, a second edit in the same directory resolves the root once', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })

  await edit($, '/w/svc-a/src/a.ts', SUBAGENT)
  await edit($, '/w/svc-a/src/b.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  expect(disk.git.filter(argv => argv.includes('rev-parse')).length).toBe(1)
  await ui.unmount()
})

test('a second repository adds a line, four make two lines and a count', async ($, on) => {
  const { disk } = await repoSetup($, on)
  const roots = Object.fromEntries(['a', 'b', 'c', 'd'].map(n => [`/w/svc-${n}`, `/w/svc-${n}`]))
  gitWorld(disk, roots, Object.fromEntries(Object.keys(roots).map(root => [root, '## main\n M x\n'])))

  await edit($, '/w/svc-a/x.ts')
  await edit($, '/w/svc-b/x.ts')
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-b/ })).toBeDefined()
  await ui.unmount()

  await edit($, '/w/svc-c/x.ts')
  await edit($, '/w/svc-d/x.ts')
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-c/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\+2 repos/ })).toBeDefined()
  await ui.unmount()
})

test('the status is read again every 10 seconds', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  const statuses: Record<string, string> = { '/w/svc-a': '## main\n M a\n' }
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, statuses)
  await edit($, '/w/svc-a/a.ts')

  statuses['/w/svc-a'] = '## main\n M a\n M b\n M c\n'
  await clock.advance(GIT_POLL_MS)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /●3/ })).toBeDefined()
  await ui.unmount()
})

test('a truncated status is skipped and the last reading stays', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })
  await edit($, '/w/svc-a/a.ts')
  const reply = disk.gitReply
  disk.gitReply = argv => (argv.includes('status') ? { exitCode: 0, stdout: '## main\n', isStdoutTruncated: true } : reply(argv))
  await clock.advance(GIT_POLL_MS)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /●1/ })).toBeDefined()
  await ui.unmount()
})

test('a repository whose status fails three polls in a row is dropped, a failure in between is forgiven', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })
  await edit($, '/w/svc-a/a.ts')
  const good = disk.gitReply
  disk.gitReply = argv => (argv.includes('status') ? { exitCode: 128, stdout: '' } : good(argv))

  await clock.advance(GIT_POLL_MS * 2)
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  await ui.unmount()

  disk.gitReply = good
  await clock.advance(GIT_POLL_MS)
  disk.gitReply = argv => (argv.includes('status') ? { exitCode: 128, stdout: '' } : good(argv))
  await clock.advance(GIT_POLL_MS * 2)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(GIT_POLL_MS)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeUndefined()
  await ui.unmount()
})

test('git failing or missing never breaks the edit, and a failed root lookup is retried at the next edit', async ($, on) => {
  const { disk } = await repoSetup($, on)
  disk.gitReply = () => {
    throw new Error('spawn git ENOENT')
  }

  expect(await edit($, '/w/svc-a/a.ts')).toEqual({ result: 'ok' })
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })
  await edit($, '/w/svc-a/a.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  await ui.unmount()
})

test('a failing Edit does not make its directory a touched repository', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'nope', isError: true }))
  const disk = mockDisk(on)
  await boot($)
  await clock.settle()
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n' })
  await edit($, '/w/svc-a/a.ts')

  expect(disk.git).toEqual([])
})
```

- [x] **Step 2: Run to see them fail.** `claude plugin test . 2>&1 | grep -E "fail" | tail -12` — the new tests fail; the earlier ones still pass.

- [x] **Step 3: Add the git reads to `hooks/watch.ts`:**

```ts
import { parseStatus } from './repos'
import type { RepoStatus } from '../types'

const GIT_TIMEOUT_MS = 3000

/** The repository root that holds `dir`, or undefined when it is not in one, git is missing, or the path is not absolute. */
export async function findRoot($: EngineInterface, dir: string): Promise<string | undefined> {
  if (!dir.startsWith('/')) return undefined
  try {
    const ran = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
    const root = ran.stdout.trim()

    return ran.exitCode === 0 && root.startsWith('/') ? root : undefined
  } catch (error) {
    await logOnce($, 'could not run git', error)

    return undefined
  }
}

/**
 * One repository's status: the reading, `skip` for output cut short (keep the last reading), `fail` otherwise.
 * `--no-optional-locks` keeps this poll from taking the index lock the user's own git commands need.
 */
export async function readStatus($: EngineInterface, root: string): Promise<RepoStatus | 'skip' | 'fail'> {
  try {
    const ran = await $.process.run(['git', '--no-optional-locks', '-C', root, 'status', '--porcelain', '-b'], { timeoutMs: GIT_TIMEOUT_MS })
    if (ran.exitCode !== 0) return 'fail'
    if (ran.isStdoutTruncated) return 'skip'

    return parseStatus(ran.stdout) ?? 'fail'
  } catch (error) {
    await logOnce($, 'could not read a repository status', error)

    return 'fail'
  }
}
```

  Merge the new imports with the existing import block at the top of the file (one `import type` for `Readings` and `RepoStatus`, one `./repos` import).

- [x] **Step 4: Wire `hooks/register.tsx`.**
  1. Imports: `import { touchedDirectory } from './activity'` joins the existing activity import; add `import { applyReading, cacheRoot, repoLine, repoName, touchRepo, visibleRepos } from './repos'` and `import type { RootCache } from './repos'`; `import { findRoot, readStatus, readUsage, resetWatchState } from './watch'`; the types import gains `Repo`.
  2. Constant: `const GIT_POLL_MS = 10_000`. Module state after `callSeq`: `let roots: RootCache = new Map()` and `let isPollingRepos = false`; reset both in `register` (`roots = new Map()`, `isPollingRepos = false`).
  3. Atom: `const repos = atom({ plugin: 'task-progress', key: 'repos' } as const, [] as Repo[])`.
  4. Functions, after `endCall`:

```ts
/** One repository's status is read and stored. */
async function refreshRepo($: EngineInterface, root: string): Promise<void> {
  const reading = await readStatus($, root)
  await update($, repos, list => applyReading(list, root, reading))
}

/** The session edited a file in `dir`: its repository is tracked, and read at once when it is new. */
async function trackTouch($: EngineInterface, dir: string): Promise<void> {
  try {
    let root = roots.get(dir)
    if (root === undefined) {
      root = await findRoot($, dir)
      if (root === undefined) return
      roots = cacheRoot(roots, dir, root)
    }
    const now = await $.clock.now()
    const isNew = !(await read($, repos)).some(r => r.root === root)
    await update($, repos, list => touchRepo(list, root, now))
    if (isNew) await refreshRepo($, root)
  } catch {
    // tracking is a side effect: it must never reach the tool call
  }
}

/** Every tracked repository is read again, one after another; a poll still running is not doubled. */
async function pollRepos($: EngineInterface): Promise<void> {
  if (isPollingRepos) return
  isPollingRepos = true
  try {
    for (const repo of await read($, repos)) await refreshRepo($, repo.root)
  } catch {
    // a poll is a side effect: it must never reach the session
  } finally {
    isPollingRepos = false
  }
}
```

  5. In `endCall`, inside the `try`, after the `update($, activity, …)` line add:

```ts
    if (!isSuccess) return
    const dir = touchedDirectory(e.tool, e as unknown as Record<string, unknown>)
    if (dir !== undefined) await trackTouch($, dir)
```

  6. In `session.start`, after the usage timer add:

```ts
    $.clock.every(GIT_POLL_MS, () => {
      void pollRepos($)
    })
```

  7. In `ui.render`, after the `doing` line: `const shownRepos = visibleRepos(await read($, repos))`. After `doingLine` add:

```ts
    const repoLines = shownRepos.shown.map(repo => {
      const parts = repoLine(repoName(repo.root), repo.status as NonNullable<Repo['status']>, inner)

      return (
        <Text>
          <Text color={COLORS.muted}>⎇ </Text>
          <Text color={COLORS.text}>{parts.name}</Text>
          <Text color={COLORS.accent}>{`  ${parts.branch}`}</Text>
          <Text color={(repo.status?.changed ?? 0) > 0 ? COLORS.active : COLORS.success}>{`  ${parts.detail}`}</Text>
        </Text>
      )
    })
    const moreLine = shownRepos.more > 0 ? <Text color={COLORS.muted}>+{shownRepos.more} repos</Text> : null
```

  and change `present([gaugeLine, doingLine])` to `present([gaugeLine, doingLine, ...repoLines, moreLine])`.

- [x] **Step 5: Run everything.** `claude plugin test . 2>&1 | tail -6` all pass, 0 fail; tsc clean; `claude plugin validate .` passes. Check `wc -l hooks/register.tsx` is under 800.

---

### Task 7: Docs, version, spec refinements, loaded copy

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json` (version), `docs/superpowers/specs/2026-10-16-pillar1-live-gauges-design.md`

**Interfaces:** consumes the finished feature; produces the release state `0.8.0`, still uncommitted.

- [x] **Step 1: README.** Add a section `## Live strip` after "Other sessions": what the three lines show (gauges with bars and the 80% tone; the doing line with `+N agents`; one line per repository the session edited, `●N` changed files incl. untracked, `✓` when clean, `↑`/`↓` distance from the upstream, `+N repos` beyond three), what counts as touching a repository (Edit, Write, NotebookEdit, MultiEdit, by the session or a subagent; not Bash), how often it refreshes (usage 5 s, git 10 s, `--no-optional-locks`), the two toasts and the `isContextWarningOn` option, and that a pane too short drops lines from the bottom. Also add `isContextWarningOn` to the options list if the README has one. Keep it to what the code does.

- [x] **Step 2: Version.** `.claude-plugin/plugin.json`: `"version": "0.8.0"`.

- [x] **Step 3: Spec refinements.** In the spec, make these three edits so it matches the code: (a) in "The strip", item 3: replace "at most 3, then `+N repos` if there are more" with "up to 3; from 4 on, 2 are shown and `+N repos` counts the rest, so the strip stays at 5 lines at most", and add "a clean repository shows `✓` instead of `●0`"; (b) in "Units" for `repos.ts` and in "Data flow": replace "least-recently-used cache of at most 200 entries" with "bounded cache of the 200 newest directories, successes only (a failed lookup is retried at the next edit)"; (c) change the Status line to "approved 2026-10-16; implemented as v0.8.0".

- [x] **Step 4: Full check.** Run `claude plugin test . 2>&1 | tail -4`, `tsc -p /tmp/task-progress-tsconfig.json`, `claude plugin validate . 2>&1 | tail -4`, `find hooks -name '*.js'` (must print nothing).

- [x] **Step 5: Real-process check.** Create a scratch git repository and a headless run that edits a file in it, with the mod loaded, and confirm the mod does not break the run and exits promptly:

```bash
S=/tmp/claude-1000/-home-vntrip-Documents-vntrip/4c2555ac-2f03-450a-8d3e-1fa42f1adde7/scratchpad/pillar1-live
rm -rf $S && mkdir -p $S/svc && cd $S/svc && git init -q && echo a > a.txt && git add a.txt && git -c user.email=a@b -c user.name=n commit -qm init
echo "Edit a.txt: replace a with b, then run Bash: sleep 12, then say done." | timeout 120 claude -p --plugin-dir ~/claude-mods/task-progress --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Bash" 2>&1 | tail -3
```

  Expected: `done`, and the run ends without hanging. The strip itself is drawn only in a terminal pane, so it is checked by the user in step 7.

- [x] **Step 6: Sync the loaded copy.** `rsync -a --delete --exclude .git --exclude node_modules --exclude docs --exclude tools ~/claude-mods/task-progress/ ~/.claude/dev-mods/4c2555ac-2f03-450a-8d3e-1fa42f1adde7/task-progress/` (the loaded copy hot-reloads when the turn ends).

- [x] **Step 7: Hand over.** Report to the user: what to look at in the real pane (gauges match `/status`; the doing line during a long tool; edit a file in a service repo and see its branch line within 10 s; a second repo adds a line; no lag on `git commit` in a tracked repo), and that nothing is committed.
