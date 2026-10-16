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

const lineLength = (segments: readonly Segment[]): number => segments.reduce((sum, segment) => sum + segment.text.length, 0)

function buildGauges(readings: Readings, now: number, limits: readonly Limit[], isResetShown: boolean): Segment[] {
  const out: Segment[] = []
  const add = (label: string, percent: number, cells: number, reset: string | undefined): void => {
    if (out.length > 0) out.push({ text: '   ', tone: 'muted' })
    out.push({ text: `${label} `, tone: 'muted' }, { text: `${bar(percent, cells)} ${percent}%`, tone: percent >= WARN_PERCENT ? 'warn' : 'text' })
    if (reset !== undefined) out.push({ text: ` ↻${reset}`, tone: 'muted' })
  }
  if (readings.context !== undefined) add('ctx', readings.context, CONTEXT_CELLS, undefined)
  for (const limit of limits) {
    add(limitName(limit.kind), limit.percent, LIMIT_CELLS, isResetShown && limit.percent >= WARN_PERCENT ? resetText(limit.resetsAt, now) : undefined)
  }

  return out
}

/**
 * The gauges line as coloured pieces, or undefined when there is nothing to show. A line wider than `width`
 * gives up its reset times first, then the 7d window, then the 5h one; the context figure stays.
 */
export function formatGauges(readings: Readings, now: number, width = Number.POSITIVE_INFINITY): Segment[] | undefined {
  const tries = [
    buildGauges(readings, now, readings.limits, true),
    buildGauges(readings, now, readings.limits, false),
    buildGauges(readings, now, readings.limits.slice(0, 1), false),
    buildGauges(readings, now, [], false),
  ]
  const fitting = tries.find(segments => lineLength(segments) <= width) ?? tries[3] ?? []
  const line = fitting.length > 0 ? fitting : (tries.find(segments => segments.length > 0) ?? [])

  return line.length === 0 ? undefined : line
}

/** One alarm per crossing of 80%: fires when armed and at or above it, re-arms below 70%, nothing in between. */
export function contextAlarm(isArmed: boolean, percent: number | undefined): { isArmed: boolean; shouldFire: boolean } {
  if (percent === undefined) return { isArmed, shouldFire: false }
  if (isArmed && percent >= WARN_PERCENT) return { isArmed: false, shouldFire: true }
  if (!isArmed && percent < REARM_PERCENT) return { isArmed: true, shouldFire: false }

  return { isArmed, shouldFire: false }
}

/** A reset time this much later than the announced one is a new window; less is the same window as reported with jitter. */
const NEW_WINDOW_MS = 10 * MS_PER_MINUTE
const NO_RESET = -1

/**
 * The limits at or above 90% not yet announced for their current window, and the announced map to keep (one entry per kind:
 * the reset time announced, or -1 when none was reported). A limit that falls below 90% is forgotten, so it can announce again.
 */
export function freshLimitAlerts(announced: ReadonlyMap<string, number>, limits: readonly Limit[]): { fresh: Limit[]; announced: ReadonlyMap<string, number> } {
  const next = new Map(announced)
  const fresh: Limit[] = []
  for (const limit of limits) {
    if (limit.percent < LIMIT_TOAST_PERCENT) {
      next.delete(limit.kind)
      continue
    }
    const parsed = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
    const reset = Number.isNaN(parsed) ? NO_RESET : parsed
    const before = next.get(limit.kind)
    if (before === undefined || (reset !== NO_RESET && reset > before + NEW_WINDOW_MS)) {
      fresh.push(limit)
      next.set(limit.kind, reset)
    }
  }

  return { fresh, announced: next }
}
