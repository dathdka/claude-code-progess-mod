import { expect, test } from 'claude-code/testing'

import type { Plan, TrackedPlan } from '../types'
import { MAX_PLANS, NO_ANNOUNCED, applyDone, applyDoneRecent, currentPhase, freshPhases, ledgerDone, ledgerPathFor, mergePlans, parsePlan, phaseDoneCount, planPathOf, plansOf, shouldResetFocus, touchPlanState, trackPlan, withLedgerState, withParsed } from './plan'

const OURS = `# Live Gauges Implementation Plan

## Global Constraints

- a line

## Review Focus

1. an item

---

### Task 1: Gauges (pure)

- [x] **Step 1: write** it
- [x] **Step 2: run**

### Task 2: Activity

- [ ] **Step 1: write**
- [x] **Step 2: run**

### Task 3: Repos

- [ ] **Step 1: write**
`

const PHASED = `# Big plan

## Phase 1: Base
### Task 1: A
- [x] a
### Task 2: B
- [x] b

## Phase 2: Next
### Task 3: C
- [ ] c1
- [ ] c2

## Notes
nothing to tick here
`

test('our plans read as one phase named after the plan, tasks counted by their boxes', () => {
  const plan = parsePlan(OURS, 'p.md')
  expect(plan?.title).toBe('Live Gauges Implementation Plan')
  expect(plan?.phases.length).toBe(1)
  expect(plan?.phases[0]?.name).toBe('Live Gauges Implementation Plan')
  expect(plan?.phases[0]?.tasks.map(t => [t.name, t.number, t.done, t.total, t.isDone])).toEqual([
    ['Task 1: Gauges (pure)', 1, 2, 2, true],
    ['Task 2: Activity', 2, 1, 2, false],
    ['Task 3: Repos', 3, 0, 1, false],
  ])
})

test('## sections with tasks are phases, a ## section without any is not', () => {
  const plan = parsePlan(PHASED, 'p.md')
  expect(plan?.phases.map(p => [p.name, p.tasks.length])).toEqual([['Phase 1: Base', 2], ['Phase 2: Next', 1]])
  expect(phaseDoneCount(plan?.phases[0] as never)).toBe(2)
})

test('boxes directly under a ## heading are one-line tasks of that phase', () => {
  const plan = parsePlan('# T\n\n## Phase A\n- [x] one\n- [ ] two\n', 'p.md')
  expect(plan?.phases[0]?.tasks.map(t => [t.name, t.isDone])).toEqual([['one', true], ['two', false]])
})

test('a horizontal rule ends the ## section, so the tasks after it are not that section\'s phase', () => {
  const plan = parsePlan('# T\n\n## Review Focus\ntext\n\n---\n\n### Task 1: X\n- [ ] a\n', 'p.md')
  expect(plan?.phases.map(p => p.name)).toEqual(['T'])
})

test('boxes inside a code fence and headings inside one are ignored', () => {
  const text = '# T\n### Task 1: X\n- [ ] real\n```md\n### Task 2: fake\n- [ ] fake\n```\n- [x] real too\n'
  const plan = parsePlan(text, 'p.md')
  expect(plan?.phases[0]?.tasks.map(t => [t.name, t.done, t.total])).toEqual([['Task 1: X', 1, 2]])
})

test('CRLF files, nested bullets and numbered boxes parse the same', () => {
  const text = '# T\r\n### Task 1: X\r\n- [ ] a\r\n  - [x] nested\r\n1. [x] numbered\r\n'
  expect(parsePlan(text, 'p.md')?.phases[0]?.tasks[0]).toMatchObject({ done: 2, total: 3 })
})

test('a ### heading without boxes is not a task, a file without tasks gives no plan', () => {
  expect(parsePlan('# T\n### Files\ntext\n', 'p.md')).toBeUndefined()
  expect(parsePlan('', 'p.md')).toBeUndefined()
  expect(parsePlan('just words\n', 'p.md')).toBeUndefined()
})

test('the title falls back to the file name, names are cleaned and cut', () => {
  const long = `### Task 1: ${'x'.repeat(100)}\u001b[31m\n- [ ] a\n`
  const plan = parsePlan(long, 'demo.md')
  expect(plan?.title).toBe('demo.md')
  expect(plan?.phases[0]?.tasks[0]?.name.length).toBe(60)
  expect(parsePlan('### Task 1: a\u001b[31mb\n- [ ] a\n', 'p.md')?.phases[0]?.tasks[0]?.name).toBe('Task 1: a [31mb')
})

test('at most 500 tasks and 12 phases are read', () => {
  const tasks = Array.from({ length: 600 }, (_, i) => `### Task ${i + 1}: t\n- [ ] a\n`).join('')
  expect(parsePlan(`# T\n${tasks}`, 'p.md')?.phases[0]?.tasks.length).toBe(500)
  const phases = Array.from({ length: 20 }, (_, i) => `## P${i}\n### Task ${i}: t\n- [ ] a\n`).join('')
  expect(parsePlan(`# T\n${phases}`, 'p.md')?.phases.length).toBe(12)
})

test('a completed todo "Task N" marks the task with that number done, other numbers and words do not', () => {
  const plan = parsePlan(OURS, 'p.md') as NonNullable<ReturnType<typeof parsePlan>>
  const applied = applyDone(plan, ['Task 2: Activity thuần', 'Task 12: other', 'Review'])
  expect(applied.phases[0]?.tasks.map(t => t.isDone)).toEqual([true, true, false])
  expect(applyDone(plan, ['Task 3 xong']).phases[0]?.tasks.map(t => t.isDone)).toEqual([true, false, true])
  expect(applyDone(plan, [])).toBe(plan)
})

test('the current phase is the first with an unfinished task, the last one when all are done', () => {
  const plan = parsePlan(PHASED, 'p.md') as NonNullable<ReturnType<typeof parsePlan>>
  expect(currentPhase(plan)).toBe(1)
  expect(currentPhase(applyDone(plan, ['Task 3']))).toBe(1)
  const done = parsePlan('# T\n## A\n- [x] a\n## B\n- [x] b\n', 'p.md') as NonNullable<ReturnType<typeof parsePlan>>
  expect(currentPhase(done)).toBe(1)
})

test('only Read, Edit, Write and MultiEdit on an absolute .md path under a plan or plans directory name a plan', () => {
  const at = (tool: string, file_path: unknown) => planPathOf(tool, { file_path })
  expect(at('Read', '/w/docs/superpowers/plans/x.md')).toBe('/w/docs/superpowers/plans/x.md')
  expect(at('Edit', '/w/plan/x.md')).toBe('/w/plan/x.md')
  expect(at('Write', '/w/plans/sub/x.md')).toBe('/w/plans/sub/x.md')
  expect(at('MultiEdit', '/w/plans/x.md')).toBe('/w/plans/x.md')
  expect(at('Bash', '/w/plans/x.md')).toBeUndefined()
  expect(at('Read', '/w/docs/x.md')).toBeUndefined()
  expect(at('Read', '/w/plans/x.txt')).toBeUndefined()
  expect(at('Read', 'plans/x.md')).toBeUndefined()
  expect(at('Read', '/w/plans/\u0000x.md')).toBeUndefined()
  expect(at('Read', 42)).toBeUndefined()
  expect(at('Read', '/w/myplans/x.md')).toBeUndefined()
})

test('--- between tasks keeps one title phase, and ends a ## phase', () => {
  const dashed = parsePlan('# T\n\n---\n\n### Task 1: A\n- [ ] a\n\n---\n\n### Task 2: B\n- [ ] b\n', 'p.md')
  expect(dashed?.phases.map(p => [p.name, p.tasks.length])).toEqual([['T', 2]])
  const mixed = parsePlan('# T\n## Phase A\n### Task 1: A\n- [ ] a\n\n---\n\n### Task 2: B\n- [ ] b\n\n---\n\n### Task 3: C\n- [ ] c\n', 'p.md')
  expect(mixed?.phases.map(p => [p.name, p.tasks.length])).toEqual([['Phase A', 1], ['T', 2]])
})

test('a trailing # without a space stays in the name, a closing sequence is cut', () => {
  expect(parsePlan('### Task 1: C#\n- [ ] a\n', 'p.md')?.phases[0]?.tasks[0]?.name).toBe('Task 1: C#')
  expect(parsePlan('### Task 1: C ##\n- [ ] a\n', 'p.md')?.phases[0]?.tasks[0]?.name).toBe('Task 1: C')
})

test('fences close only on a bare run at least as long as the opener', () => {
  const js = '### Task 1: X\n```js\n- [ ] fake\n```\n- [ ] real\n'
  expect(parsePlan(js, 'p.md')?.phases[0]?.tasks[0]).toMatchObject({ done: 0, total: 1 })
  const long = '### Task 1: X\n````md\n```\n- [ ] fake\n```\n````\n- [ ] real\n'
  expect(parsePlan(long, 'p.md')?.phases[0]?.tasks[0]).toMatchObject({ done: 0, total: 1 })
})

test('a heading, box or rule line with a very long run of spaces parses fast', () => {
  const spaces = ' '.repeat(100_000)
  const text = `# a${spaces}b\n\n## P\n### Task 1: t\n- [ ] x\n-${spaces}b\n- [ ]${spaces}c\n${'- '.repeat(1)}${spaces}-${spaces}-x\n`
  const started = Date.now()
  const plan = parsePlan(text, 'f.md')

  expect(Date.now() - started).toBeLessThan(100)
  expect(plan?.phases[0]?.tasks[0]?.total).toBeGreaterThan(0)
})

const parsed = (text: string): Plan => parsePlan(text, 'p.md') as Plan
const single = (title: string, done = false): Plan => parsed(`# ${title}\n### Task 1: a\n- [${done ? 'x' : ' '}] a\n`)
const at = (path: string, plan: Plan | null, lastTouchedAt = 0, done: number[] = []): TrackedPlan => ({ path, plan, lastTouchedAt, done })

test('mergePlans: no parsed plan gives null, one plan keeps its title, several are counted', () => {
  expect(mergePlans([])).toBeNull()
  expect(mergePlans([at('/a.md', null)])).toBeNull()
  expect(mergePlans([at('/a.md', single('Alpha')), at('/b.md', null)])?.title).toBe('Alpha')
  expect(mergePlans([at('/a.md', single('Alpha')), at('/b.md', single('Beta'))])?.title).toBe('2 plans')
})

test('mergePlans: a single-phase plan is one phase named by its title, a phased plan gives <title>: <phase> cut to 60', () => {
  const merged = mergePlans([at('/a.md', single('Alpha')), at('/b.md', parsed(PHASED)), at('/c.md', single('Gamma'))])
  expect(merged?.phases.map(p => [p.name, p.tasks.length])).toEqual([
    ['Alpha', 1],
    ['Big plan: Phase 1: Base', 2],
    ['Big plan: Phase 2: Next', 1],
    ['Gamma', 1],
  ])
  const long = mergePlans([at('/l.md', parsed(`# ${'T'.repeat(50)}\n## ${'P'.repeat(30)}\n- [ ] a\n## Q\n- [ ] b\n`)), at('/s.md', single('S'))])
  expect(long?.phases[0]?.name).toBe(`${'T'.repeat(50)}: ${'P'.repeat(8)}`)
  expect(long?.phases[0]?.name.length).toBe(60)
})

test('trackPlan appends a new path, keeps the order but dates a repeat, adds nothing when pinned, and keeps at most 10', () => {
  const one = trackPlan([], '/a.md', false, 1)
  expect(one).toEqual([at('/a.md', null, 1)])
  const two = trackPlan(one, '/b.md', false, 2)
  expect(two.map(t => t.path)).toEqual(['/a.md', '/b.md'])
  expect(trackPlan(two, '/a.md', false, 3)).toEqual([at('/a.md', null, 3), at('/b.md', null, 2)])
  expect(trackPlan(two, '/c.md', true, 3)).toBe(two)
  let list: TrackedPlan[] = []
  for (let i = 0; i <= MAX_PLANS; i += 1) list = trackPlan(list, `/${i}.md`, false, 5)
  expect(MAX_PLANS).toBe(10)
  // equal touch times: the first in order goes
  expect(list.map(t => t.path)).toEqual(Array.from({ length: 10 }, (_, i) => `/${i + 1}.md`))
})

test('beyond 10 plans the one touched least recently is dropped, the display order stays the order of first touch', () => {
  let list: TrackedPlan[] = []
  for (let i = 0; i < MAX_PLANS; i += 1) list = trackPlan(list, `/${i}.md`, false, i)
  list = trackPlan(list, '/0.md', false, 100)
  list = trackPlan(list, '/new.md', false, 101)
  expect(list.map(t => t.path)).toEqual(['/0.md', ...Array.from({ length: 8 }, (_, i) => `/${i + 2}.md`), '/new.md'])
})

test('plansOf reads the list of a state of any shape, an old single-plan state reads as no plans', () => {
  expect(plansOf(null)).toEqual([])
  expect(plansOf({ path: '/w/plans/a.md', plan: null, isPinned: true })).toEqual([])
  expect(plansOf({ plans: [at('/a.md', null)], isPinned: false })).toEqual([at('/a.md', null)])
})

test('touchPlanState adds to a state of the old shape as if it were empty, and keeps a pin', () => {
  const old = { path: '/w/plans/a.md', plan: null, isPinned: true } as never
  expect(touchPlanState(old, '/w/plans/b.md', 7)).toEqual({ plans: [at('/w/plans/b.md', null, 7)], isPinned: false })
  expect(touchPlanState(null, '/b.md', 7)).toEqual({ plans: [at('/b.md', null, 7)], isPinned: false })
  const pinned = { plans: [at('/a.md', null)], isPinned: true }
  expect(touchPlanState(pinned, '/b.md', 7)).toEqual(pinned)
})

test('the focus is reset when a plan leaves the list or the merged phases shrink, not when one is added or reparsed alike', () => {
  const a = at('/a.md', parsed(PHASED))
  const b = at('/b.md', single('Beta'))
  expect(shouldResetFocus([a, b], [b])).toBe(true)
  expect(shouldResetFocus([a], [at('/a.md', single('Alpha'))])).toBe(true)
  expect(shouldResetFocus([a], [a, b])).toBe(false)
  expect(shouldResetFocus([a, b], [a, at('/b.md', single('Beta', true))])).toBe(false)
  expect(shouldResetFocus([], [])).toBe(false)
})

test('freshPhases: a plan seen first or reshaped is a silent baseline, a phase newly complete is news once, with its merged number and name', () => {
  const first = freshPhases(NO_ANNOUNCED, [at('/a.md', single('Alpha')), at('/b.md', single('Beta'))])
  expect(first.fresh).toEqual([])
  const done = freshPhases(first.next, [at('/a.md', single('Alpha')), at('/b.md', single('Beta', true))])
  expect(done.fresh).toEqual([{ index: 1, name: 'Beta', total: 1 }])
  expect(freshPhases(done.next, [at('/a.md', single('Alpha')), at('/b.md', single('Beta', true))]).fresh).toEqual([])
  const added = freshPhases(done.next, [at('/a.md', single('Alpha')), at('/b.md', single('Beta', true)), at('/c.md', single('Gamma', true))])
  expect(added.fresh).toEqual([])
  const renamed = freshPhases(added.next, [at('/a.md', single('Alpha2', true)), at('/b.md', single('Beta', true)), at('/c.md', single('Gamma', true))])
  expect(renamed.fresh).toEqual([])
})

test('freshPhases: one plan renamed is a baseline for its own phases only, another plan completing in the same look is news', () => {
  const seen = freshPhases(NO_ANNOUNCED, [at('/a.md', single('Alpha')), at('/b.md', single('Beta'))])
  const both = freshPhases(seen.next, [at('/a.md', single('Alpha2', true)), at('/b.md', single('Beta', true))])
  expect(both.fresh).toEqual([{ index: 1, name: 'Beta', total: 1 }])
})

test('freshPhases forgets a plan that left the list, so it is a baseline when it comes back', () => {
  const seen = freshPhases(NO_ANNOUNCED, [at('/a.md', single('Alpha'))])
  const gone = freshPhases(seen.next, [at('/b.md', single('Beta'))])
  expect([...gone.next.shapes.keys()]).toEqual(['/b.md'])
  expect(freshPhases(gone.next, [at('/b.md', single('Beta')), at('/a.md', single('Alpha', true))]).fresh).toEqual([])
})

test('completed "Task N" labels mark only the plan touched most recently (numbers repeat across plans)', () => {
  const recentLast = mergePlans(applyDoneRecent([at('/a.md', parsed(OURS), 1), at('/b.md', parsed(PHASED), 2), at('/c.md', null, 0)], ['Task 3: x']))
  expect(recentLast?.phases[0]?.tasks[2]?.isDone).toBe(false)
  expect(recentLast?.phases[2]?.tasks[0]?.isDone).toBe(true)
  const recentFirst = mergePlans(applyDoneRecent([at('/a.md', parsed(OURS), 3), at('/b.md', parsed(PHASED), 2)], ['Task 3: x']))
  expect(recentFirst?.phases[0]?.tasks[2]?.isDone).toBe(true)
  expect(recentFirst?.phases[2]?.tasks[0]?.isDone).toBe(false)
  // a tie goes to the later plan in the list
  const tie = mergePlans(applyDoneRecent([at('/a.md', parsed(OURS), 2), at('/b.md', parsed(PHASED), 2)], ['Task 3: x']))
  expect(tie?.phases[0]?.tasks[2]?.isDone).toBe(false)
  expect(tie?.phases[2]?.tasks[0]?.isDone).toBe(true)
})

test('withParsed replaces the parse of one path only', () => {
  const list = [at('/a.md', null), at('/b.md', null)]
  expect(withParsed(list, '/b.md', single('Beta'))).toEqual([at('/a.md', null), at('/b.md', single('Beta'))])
})

test('mergePlans: the only parsed plan is shown as it is, unprefixed; two parsed plans are prefixed', () => {
  const phased = parsed(PHASED)
  expect(mergePlans([at('/b.md', phased), at('/x.md', null)])).toBe(phased)
  expect(mergePlans([at('/a.md', single('Alpha'))])?.phases.map(p => p.name)).toEqual(['Alpha'])
  expect(mergePlans([at('/b.md', phased), at('/a.md', single('Alpha'))])?.phases.map(p => p.name)).toEqual([
    'Big plan: Phase 1: Base',
    'Big plan: Phase 2: Next',
    'Alpha',
  ])
})

test('freshPhases names a fresh phase as the view does: unprefixed for one plan, prefixed for several', () => {
  const half = parsed('# P\n## A\n- [x] a\n## B\n- [ ] b\n')
  const full = parsed('# P\n## A\n- [x] a\n## B\n- [x] b\n')
  const seen = freshPhases(NO_ANNOUNCED, [at('/p.md', half)])
  expect(freshPhases(seen.next, [at('/p.md', full)]).fresh).toEqual([{ index: 1, name: 'B', total: 1 }])
  const two = freshPhases(NO_ANNOUNCED, [at('/p.md', half), at('/a.md', single('Alpha'))])
  expect(freshPhases(two.next, [at('/p.md', full), at('/a.md', single('Alpha'))]).fresh).toEqual([{ index: 1, name: 'P: B', total: 1 }])
})

test('ledgerPathFor: a plan under docs/superpowers/plans has its ledger under .superpowers/sdd/<name>, other plans have none', () => {
  expect(ledgerPathFor('/w/repo/docs/superpowers/plans/2026-10-16-plan-view.md')).toBe('/w/repo/.superpowers/sdd/2026-10-16-plan-view/progress.md')
  expect(ledgerPathFor('/w/docs/superpowers/plans/v0.9.1.notes.md')).toBe('/w/.superpowers/sdd/v0.9.1.notes/progress.md')
  expect(ledgerPathFor('/w/docs/plans/x.md')).toBeUndefined()
  expect(ledgerPathFor('/w/superpowers/plans/x.md')).toBeUndefined()
})

const X_PLAN = '/repo/docs/superpowers/plans/x.md'

test('ledgerDone reads "Task N: complete" lines only: fix rounds, other words and junk do not count', () => {
  const text = [
    '# SDD ledger — plan: docs/superpowers/plans/x.md',
    'Task 1: complete (commits abc123)',
    '  task 3 : Complete',
    'Task 2: fix round 1 (reviewer)',
    'Task 4: completed later',
    'Task 5: in progress',
    'Plan B Task 6: complete',
    '- Task 7: complete',
    'Task 1: complete again',
    '\u0000\u0001 junk',
  ].join('\n')
  expect(ledgerDone(text, X_PLAN)).toEqual([1, 3])
  expect(ledgerDone('', X_PLAN)).toEqual([])
})

test('ledgerDone stays fast on very long lines and huge files', () => {
  const spaces = ' '.repeat(200_000)
  const started = Date.now()
  // the header line is cut to 512 characters first: the run of spaces is trimmed and the plan still matches
  const done = ledgerDone(`# SDD ledger — plan: ${X_PLAN}${spaces}x\nTask 2: complete\n`, X_PLAN)
  expect(Date.now() - started).toBeLessThan(100)
  expect(done).toEqual([2])
  const fast = Date.now()
  expect(ledgerDone(`# SDD ledger — plan: ${X_PLAN}\nTask${spaces}1${spaces}:${spaces}x\nTask 2: complete\n${'Task 9: complete\n'.repeat(80_000)}`, X_PLAN)).toEqual([2, 9])
  expect(Date.now() - fast).toBeLessThan(100)
})

test('withLedgerState adds the ledger numbers to the plan they belong to, never forgets, and ignores a path no longer tracked', () => {
  const state = { plans: [at('/a.md', null, 0, [1]), at('/b.md', null)], isPinned: false }
  const next = withLedgerState(state, '/a.md', [2])
  expect(next?.plans).toEqual([at('/a.md', null, 0, [1, 2]), at('/b.md', null)])
  expect(withLedgerState(next, '/a.md', [])).toBe(next)
  expect(withLedgerState(next, '/a.md', [2, 1])).toBe(next)
  expect(withLedgerState(next, '/gone.md', [5])).toBe(next)
  expect(withLedgerState(null, '/a.md', [5])).toBeNull()
})

test('a plan\'s ledger numbers mark its own tasks, and todo labels still only the plan touched last', () => {
  const plans = [at('/a.md', parsed(OURS), 1, [3]), at('/b.md', parsed(PHASED), 2)]
  const merged = mergePlans(applyDoneRecent(plans, ['Task 2: x']))
  expect(merged?.phases[0]?.tasks.map(t => t.isDone)).toEqual([true, false, true])
  expect(merged?.phases[2]?.tasks[0]?.isDone).toBe(false)
  const noTodos = mergePlans(applyDoneRecent([at('/b.md', parsed(PHASED), 2, [3])], []))
  expect(noTodos?.phases[1]?.tasks[0]?.isDone).toBe(true)
})

test('a ledger counts only when its first line names this plan, by absolute or relative path', () => {
  const body = '\nTask 1: complete\nTask 2: complete (commits a)\n'
  expect(ledgerDone(`# SDD ledger — plan: docs/superpowers/plans/x.md${body}`, X_PLAN)).toEqual([1, 2])
  expect(ledgerDone(`# SDD ledger — plan: ${X_PLAN}${body}`, X_PLAN)).toEqual([1, 2])
  expect(ledgerDone(`#SDD ledger - plan:  ${X_PLAN}  ${body}`, X_PLAN)).toEqual([1, 2])
  expect(ledgerDone(`# SDD ledger — plan: docs/superpowers/plans/x.md\r${body.replace(/\n/g, '\r\n')}`, X_PLAN)).toEqual([1, 2])
  expect(ledgerDone(`# SDD ledger — plan: docs/superpowers/plans/y.md${body}`, X_PLAN)).toEqual([])
  expect(ledgerDone(`# SDD ledger — plan: /other/docs/superpowers/plans/x.md${body}`, X_PLAN)).toEqual([])
  expect(ledgerDone(`# SDD ledger — plan: s/x.md${body}`, X_PLAN)).toEqual([])
  expect(ledgerDone(body.trimStart(), X_PLAN)).toEqual([])
  expect(ledgerDone(`\n# SDD ledger — plan: ${X_PLAN}${body}`, X_PLAN)).toEqual([])
})

test('ledgerPathFor refuses an empty, . or .. name and paths with . or .. segments', () => {
  expect(ledgerPathFor('/w/docs/superpowers/plans/.md')).toBeUndefined()
  expect(ledgerPathFor('/w/docs/superpowers/plans/..md')).toBeUndefined()
  expect(ledgerPathFor('/w/docs/superpowers/plans/...md')).toBeUndefined()
  expect(ledgerPathFor('/w/../docs/superpowers/plans/x.md')).toBeUndefined()
  expect(ledgerPathFor('/w/./docs/superpowers/plans/x.md')).toBeUndefined()
  expect(ledgerPathFor('/w/docs/superpowers/plans/a..b.md')).toBe('/w/.superpowers/sdd/a..b/progress.md')
})

test('a saved plan whose done numbers are not a list counts as none', () => {
  const bad = { ...at('/a.md', parsed(OURS)), done: 'x' as never }
  expect(mergePlans(applyDoneRecent([bad, at('/b.md', null, 9)], []))?.phases[0]?.tasks.map(t => t.isDone)).toEqual([true, false, false])
  const state = { plans: [bad], isPinned: false }
  expect(withLedgerState(state, '/a.md', [2])?.plans[0]?.done).toEqual([2])
})
