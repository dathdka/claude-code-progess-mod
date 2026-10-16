import type { Phase, Plan, PlanState, PlanTask, TrackedPlan } from '../types'

/** A plan file larger than this is not read. */
export const MAX_BYTES = 1_000_000
const MAX_TASKS = 500
const MAX_PHASES = 12
const NAME_MAX = 60
/** At most this many plan files are tracked; a new one beyond it drops the one touched longest ago. */
export const MAX_PLANS = 10
/** A line is cut here before it is matched: names are cut to 60, and the regexes backtrack on long whitespace runs. */
const LINE_MAX = 512
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const BOX = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s*(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const PLAN_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'MultiEdit']

const clean = (text: string): string => text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)

const toTask = (name: string, done: number, total: number): PlanTask => {
  const match = /^task\s+(\d+)\b/i.exec(name)

  return { name, number: match?.[1] === undefined ? null : Number(match[1]), done, total, isDone: total > 0 && done === total }
}

/**
 * The phases and tasks of a Markdown plan, or undefined when it has no task. A task is a `###` heading with checkboxes under it;
 * a phase is the `##` heading above its tasks (a horizontal rule ends that section, so tasks after one belong to a phase named
 * after the plan); boxes directly under a `##` heading are one-line tasks. Boxes in code fences are ignored.
 */
export function parsePlan(text: string, fileName: string): Plan | undefined {
  let title = ''
  let section: string | undefined
  let phase: Phase | undefined
  let open: { name: string; done: number; total: number } | undefined
  let taskCount = 0
  let fence: { char: string; length: number } | undefined
  let titlePhase: Phase | undefined
  const phases: Phase[] = []

  const phaseFor = (): Phase | undefined => {
    if (phase !== undefined) return phase
    if (section === undefined && titlePhase !== undefined) return (phase = titlePhase)
    if (phases.length >= MAX_PHASES) return undefined
    phase = { name: section ?? (clean(title) || fileName), tasks: [] }
    if (section === undefined) titlePhase = phase
    phases.push(phase)

    return phase
  }
  const add = (name: string, done: number, total: number): void => {
    if (taskCount >= MAX_TASKS) return
    const target = phaseFor()
    if (target === undefined) return
    target.tasks.push(toTask(name, done, total))
    taskCount += 1
  }
  const flush = (): void => {
    if (open !== undefined && open.total > 0) add(open.name, open.done, open.total)
    open = undefined
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.length > LINE_MAX ? raw.slice(0, LINE_MAX) : raw
    const fenced = FENCE.exec(line)
    if (fence !== undefined) {
      const run = fenced?.[1] ?? ''
      if (run[0] === fence.char && run.length >= fence.length && (fenced?.[2] ?? '').trim() === '') fence = undefined
      continue
    }
    if (fenced !== null) {
      fence = { char: fenced[1]?.[0] ?? '`', length: fenced[1]?.length ?? 3 }
      continue
    }
    if (RULE.test(line)) {
      flush()
      if (section !== undefined) phase = undefined
      section = undefined
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = heading[1]?.length ?? 0
      const name = clean(heading[2] ?? '')
      if (level <= 3) flush()
      if (level === 1) {
        title = title === '' ? name : title
        section = undefined
        phase = undefined
      } else if (level === 2) {
        section = name
        phase = undefined
      } else if (level === 3) open = { name, done: 0, total: 0 }
      continue
    }
    const box = BOX.exec(line)
    if (box === null) continue
    const isChecked = box[1] !== ' '
    if (open !== undefined) {
      open.total += 1
      if (isChecked) open.done += 1
    } else if (section !== undefined) add(clean(box[2] ?? ''), isChecked ? 1 : 0, 1)
  }
  flush()
  const kept = phases.filter(p => p.tasks.length > 0)

  return kept.length === 0 ? undefined : { title: clean(title) || fileName, phases: kept }
}

/** The task numbers of completed todo labels starting `Task N`. */
const labelNumbers = (completedLabels: readonly string[]): number[] =>
  completedLabels.flatMap(label => {
    const match = /^\s*Task\s*(\d+)\b/i.exec(label)

    return match?.[1] === undefined ? [] : [Number(match[1])]
  })

/** Marks as done the tasks whose number appears in a completed todo label starting `Task N`, or in `extra` (a ledger's numbers). */
export function applyDone(plan: Plan, completedLabels: readonly string[], extra: readonly number[] = []): Plan {
  const numbers = new Set([...labelNumbers(completedLabels), ...extra])
  if (numbers.size === 0) return plan

  return {
    ...plan,
    phases: plan.phases.map(p => ({ ...p, tasks: p.tasks.map(t => (t.number !== null && numbers.has(t.number) ? { ...t, isDone: true } : t)) })),
  }
}

export const phaseDoneCount = (phase: Phase): number => phase.tasks.filter(t => t.isDone).length

/** The first phase with an unfinished task; the last phase when everything is done. */
export function currentPhase(plan: Plan): number {
  const index = plan.phases.findIndex(p => p.tasks.some(t => !t.isDone))

  return index === -1 ? plan.phases.length - 1 : index
}

/** An absolute `.md` path without control characters. */
export const isCleanPlanPath = (path: string): boolean => path.startsWith('/') && path.endsWith('.md') && !HAS_CONTROL_CHARS.test(path)

/** The plan file a tool call names: an absolute `.md` path with a `plan` or `plans` directory, read, edited or written. */
export function planPathOf(tool: string, input: Record<string, unknown>): string | undefined {
  const path = input.file_path
  if (!PLAN_TOOLS.includes(tool) || typeof path !== 'string') return undefined
  if (!isCleanPlanPath(path)) return undefined

  return /\/plans?\//.test(path) ? path : undefined
}

/**
 * The list with each plan's own ledger numbers applied, and the completed `Task N` todo labels applied to the plan touched most
 * recently only (a tie goes to the later one), before the plans are merged: `Task N` numbers repeat across plans, and the todo list
 * belongs to the plan being worked on, while a ledger belongs to its plan.
 */
export function applyDoneRecent(tracked: readonly TrackedPlan[], completedLabels: readonly string[]): TrackedPlan[] {
  const recent = tracked.reduce((best, t, i) => ((t.lastTouchedAt ?? 0) >= (tracked[best]?.lastTouchedAt ?? 0) ? i : best), 0)

  return tracked.map((t, i) => (t.plan === null ? t : { ...t, plan: applyDone(t.plan, i === recent ? completedLabels : [], doneOf(t)) }))
}

/** The tracked plans of a plan state; none for a state of another shape (an earlier load's single-plan state survives a reload). */
export const plansOf = (state: unknown): TrackedPlan[] => {
  const plans = (state as { plans?: unknown } | null)?.plans

  return Array.isArray(plans) ? (plans as TrackedPlan[]) : []
}

/** The plan state after a qualifying touch of `path` at `now`; a state of another shape counts as none. */
export function touchPlanState(state: PlanState | null, path: string, now: number): PlanState {
  const isPinned = Array.isArray((state as { plans?: unknown } | null)?.plans) && state?.isPinned === true

  return { plans: trackPlan(plansOf(state), path, isPinned, now), isPinned }
}

/** Whether the focus must return to the current phase: a plan left the list or the merged plan has fewer phases. */
export function shouldResetFocus(before: readonly TrackedPlan[], after: readonly TrackedPlan[]): boolean {
  const count = (list: readonly TrackedPlan[]) => mergePlans(list)?.phases.length ?? 0

  return before.some(b => !after.some(a => a.path === b.path)) || count(after) < count(before)
}

/** The list with `plan` as the last parse of `path`. */
export const withParsed = (tracked: readonly TrackedPlan[], path: string, plan: Plan): TrackedPlan[] => tracked.map(t => (t.path === path ? { ...t, plan } : t))

/**
 * The list after a touch of `path` at `now`: a tracked path is dated again in place, a new one is added at the end and, beyond
 * MAX_PLANS, the plan touched least recently goes (a tie: the first in order). A pinned list takes no new path.
 */
export function trackPlan(list: TrackedPlan[], path: string, isPinned: boolean, now: number): TrackedPlan[] {
  if (list.some(t => t.path === path)) return list.map(t => (t.path === path ? { ...t, lastTouchedAt: now } : t))
  if (isPinned) return list
  if (list.length < MAX_PLANS) return [...list, { path, plan: null, lastTouchedAt: now, done: [] }]
  const oldest = list.reduce((best, t, i) => ((t.lastTouchedAt ?? 0) < (list[best]?.lastTouchedAt ?? 0) ? i : best), 0)

  return [...list.filter((_, i) => i !== oldest), { path, plan: null, lastTouchedAt: now, done: [] }]
}

/** The phases a plan adds to the merged plan: its only phase named by its title, or each phase as `<title>: <phase>`. */
const mergedPhases = (plan: Plan): Phase[] =>
  plan.phases.length === 1 ? plan.phases.map(p => ({ ...p, name: plan.title })) : plan.phases.map(p => ({ ...p, name: clean(`${plan.title}: ${p.name}`) }))

const parsedPlans = (tracked: readonly TrackedPlan[]): Plan[] => tracked.flatMap(t => (t.plan === null ? [] : [t.plan]))

/**
 * One plan of every tracked plan that has parsed, in list order; null when none has. The only parsed plan is shown as it is (no
 * `<title>: ` prefix, which would repeat the header); two or more are merged under the title `N plans`.
 */
export function mergePlans(tracked: readonly TrackedPlan[]): Plan | null {
  const plans = parsedPlans(tracked)
  if (plans.length <= 1) return plans[0] ?? null

  return { title: `${plans.length} plans`, phases: plans.flatMap(mergedPhases) }
}

/** Per tracked path: its phase names at the last look, and the keys `${path}#${index}:${name}` of its phases complete by then. */
export type Announced = { shapes: ReadonlyMap<string, string>; keys: ReadonlySet<string> }
export const NO_ANNOUNCED: Announced = { shapes: new Map(), keys: new Set() }
export type FreshPhase = { index: number; name: string; total: number }

/**
 * The phases that have just become complete, by merged number and name, and what to remember. A plan seen for the first time or
 * whose phase names changed is a silent baseline for its own phases; a path no longer tracked is forgotten.
 */
export function freshPhases(prev: Announced, tracked: readonly TrackedPlan[]): { fresh: FreshPhase[]; next: Announced } {
  const shapes = new Map<string, string>()
  const keys = new Set<string>()
  const fresh: FreshPhase[] = []
  const isMerged = parsedPlans(tracked).length > 1
  let offset = 0
  for (const { path, plan } of tracked) {
    const old = [...prev.keys].filter(k => k.startsWith(`${path}#`))
    const shape = plan?.phases.map(p => p.name).join('\n')
    if (plan === null || shape === undefined) {
      if (prev.shapes.has(path)) shapes.set(path, prev.shapes.get(path) ?? '')
      for (const k of old) keys.add(k)
      continue
    }
    const isBaseline = prev.shapes.get(path) !== shape
    shapes.set(path, shape)
    if (!isBaseline) for (const k of old) keys.add(k)
    const names = isMerged ? mergedPhases(plan) : plan.phases
    plan.phases.forEach((p, i) => {
      if (!p.tasks.every(t => t.isDone)) return
      const key = `${path}#${i}:${p.name}`
      if (!isBaseline && !keys.has(key)) fresh.push({ index: offset + i, name: names[i]?.name ?? p.name, total: p.tasks.length })
      keys.add(key)
    })
    offset += plan.phases.length
  }

  return { fresh, next: { shapes, keys } }
}

const PLANS_DIR = '/docs/superpowers/plans/'
const LEDGER_DONE = /^\s*Task\s+(\d+)\s*:\s*complete\b/i
/** The first line the subagent-driven-development skill writes in a ledger: `# SDD ledger — plan: <path>`. */
const LEDGER_HEADER = /^#\s*SDD ledger\s*[—-]+\s*plan:\s*(.+?)\s*$/

/** A task's ledger numbers; none when a saved state holds something else. */
const doneOf = (t: TrackedPlan | undefined): number[] => (Array.isArray(t?.done) ? t.done : [])

/** The subagent-driven-development ledger of a plan at `<root>/docs/superpowers/plans/<name>.md`: `<root>/.superpowers/sdd/<name>/progress.md`. */
export function ledgerPathFor(planPath: string): string | undefined {
  const at = planPath.lastIndexOf(PLANS_DIR)
  if (at === -1 || !planPath.endsWith('.md') || /\/\.\.?(\/|$)/.test(planPath)) return undefined
  const name = planPath.slice(planPath.lastIndexOf('/') + 1, -'.md'.length)
  if (name === '' || name === '.' || name === '..') return undefined

  return `${planPath.slice(0, at)}/.superpowers/sdd/${name}/progress.md`
}

/** Whether a ledger's first line is the skill's header naming this plan, by its absolute path or a path relative to its root. */
function isLedgerOf(firstLine: string, planPath: string): boolean {
  const named = LEDGER_HEADER.exec(firstLine.slice(0, LINE_MAX))?.[1]

  return named !== undefined && (named === planPath || planPath.endsWith(`/${named}`))
}

/**
 * The task numbers a ledger reports complete (`Task 3: complete (commits …)`), once each; fix rounds and other lines do not count.
 * A ledger whose first line is not the header naming `planPath` reports none.
 */
export function ledgerDone(text: string, planPath: string): number[] {
  const lines = text.slice(0, MAX_BYTES).split('\n')
  if (!isLedgerOf(lines[0] ?? '', planPath)) return []
  const numbers = new Set<number>()
  for (const raw of lines.slice(1)) {
    const match = LEDGER_DONE.exec(raw.length > LINE_MAX ? raw.slice(0, LINE_MAX) : raw)
    if (match?.[1] !== undefined) numbers.add(Number(match[1]))
  }

  return [...numbers]
}

/** The state with a ledger's numbers added to its plan's (never forgetting one); the same state when nothing is new or the plan is no longer tracked. */
export function withLedgerState(state: PlanState | null, path: string, done: readonly number[]): PlanState | null {
  const entry = plansOf(state).find(t => t.path === path)
  const old = doneOf(entry)
  if (state === null || entry === undefined || done.every(n => old.includes(n))) return state

  return { ...state, plans: plansOf(state).map(t => (t.path === path ? { ...t, done: [...new Set([...old, ...done])] } : t)) }
}
