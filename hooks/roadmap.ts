import type { Plan, RoadmapPhase, RoadmapStatus } from '../types'
import { phaseDoneCount } from './plan'
import type { PlanLine, Tone } from './planview'
import { truncate } from './style'

/** The file looked for beside each tracked plan, and in the project's plans directory. */
export const ROADMAP_FILE = 'roadmap.md'
const PROJECT_PLANS = '/docs/superpowers/plans/'
/** Rows kept from the roadmap table; names are cut like plan names. */
const MAX_ROWS = 24
const NAME_MAX = 60
const GOAL_MAX = 200
/** Names wider than this are cut in the roadmap view, so the goals keep a column. */
const PAD_MAX = 8
const LINE_MAX = 512
/** A table row may be longer than a heading: the Status cell is often the last one. */
const ROW_MAX = 4096
const BAR_CELLS = 8
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const FENCE = /^\s*(`{3,}|~{3,})/
const DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const STATUS_HEADER = /^(status|state)$/i
const GOAL_HEADER = /^(goal|goals|description|summary|objective|scope)$/i
const MD_LINK = /\]\(([^)\s]+\.md)\)/g
const DONE = /^(done|complete|completed|finished|shipped|✅|✔️?|x)$/i
const ACTIVE = /^(in[ _-]?progress|active|wip|doing|current|started|🚧|▶)$/i
const MARK: Record<RoadmapStatus, string> = { done: '✔', active: '▶', pending: '○' }
const TONE: Record<RoadmapStatus, Tone> = { done: 'success', active: 'active', pending: 'muted' }

/** A cell's text without Markdown emphasis, code ticks or link targets. */
const cellText = (cell: string, max = NAME_MAX): string =>
  cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

const cellsOf = (line: string, max = NAME_MAX): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => cellText(c, max))

/** The file names of the Markdown files a row links to. */
const linksOf = (line: string): string[] => [...new Set([...line.matchAll(MD_LINK)].map(m => (m[1] ?? '').slice((m[1] ?? '').lastIndexOf('/') + 1)))]

const statusOf = (cell: string): RoadmapStatus => (DONE.test(cell) ? 'done' : ACTIVE.test(cell) ? 'active' : 'pending')

/**
 * The phases of the first Markdown table whose header has a `Status` (or `State`) column: the name from the first column, the
 * state from that one. Undefined when there is no such table. Tables in code fences are ignored.
 */
export function parseRoadmap(text: string): RoadmapPhase[] | undefined {
  const raw = text.split(/\r?\n/)
  const lines = raw.map(l => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l))
  let fence: string | undefined
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const run = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (run?.[0] === fence) fence = undefined
      continue
    }
    if (run !== undefined) {
      fence = run[0]
      continue
    }
    if (!line.includes('|') || !DELIMITER.test(lines[i + 1] ?? '')) continue
    const header = cellsOf(line)
    const column = header.findIndex(c => STATUS_HEADER.test(c))
    if (column <= 0) continue
    const named = header.findIndex(c => GOAL_HEADER.test(c))
    const goal = named > 0 ? named : column === 1 ? (header.length > 2 ? 2 : -1) : 1

    return tableRows(raw.slice(i + 2).map(l => l.slice(0, ROW_MAX)), column, goal)
  }

  return undefined
}

/** The rows of a table body up to its first non-table line, at most MAX_ROWS, each named by its first cell (`goal` -1: none). */
function tableRows(body: readonly string[], column: number, goal: number): RoadmapPhase[] | undefined {
  const phases: RoadmapPhase[] = []
  for (const line of body) {
    if (!line.includes('|') || phases.length >= MAX_ROWS) break
    const cells = cellsOf(line, GOAL_MAX)
    const name = (cells[0] ?? '').slice(0, NAME_MAX)
    if (name !== '') phases.push({ name, status: statusOf(cells[column] ?? ''), goal: goal === -1 ? '' : (cells[goal] ?? ''), plans: linksOf(line) })
  }

  return phases.length === 0 ? undefined : phases
}

/** Where a roadmap may be: beside each tracked plan (most recently touched first), then the project's plans directory. */
export function roadmapPaths(planPathsRecentFirst: readonly string[], cwd: string | undefined): string[] {
  const dirs = planPathsRecentFirst.map(p => p.slice(0, p.lastIndexOf('/') + 1))
  if (cwd !== undefined && cwd.startsWith('/')) dirs.push(`${cwd.replace(/\/$/, '')}${PROJECT_PLANS}`)

  return [...new Set(dirs.filter(d => d.startsWith('/')).map(d => `${d}${ROADMAP_FILE}`))]
}

/**
 * The pane's roadmap line: `Roadmap 2/9  ✔P0 ✔P1 ▶P2a ○P2b …` when every phase fits, else `Roadmap 2/9 ▰▰▱▱▱▱▱▱ ▶ P2a` (the
 * active phase, or the next one), cut to the width.
 */
export function roadmapLine(phases: readonly RoadmapPhase[], width: number): { text: string; isDone: boolean } {
  const done = phases.filter(p => p.status === 'done').length
  const isDone = phases.length > 0 && done === phases.length
  const head = `Roadmap ${done}/${phases.length}`
  const full = `${head}  ${phases.map(p => `${MARK[p.status]}${p.name}`).join(' ')}`
  if (full.length <= width) return { text: full, isDone }
  const filled = phases.length === 0 ? 0 : Math.round((done / phases.length) * BAR_CELLS)
  const focus = phases.find(p => p.status === 'active') ?? phases.find(p => p.status !== 'done')
  const tail = focus === undefined ? '✔' : `${MARK[focus.status]} ${focus.name}`

  return { text: truncate(`${head} ${'▰'.repeat(filled)}${'▱'.repeat(BAR_CELLS - filled)} ${tail}`, width), isDone }
}

/** The saved roadmap phases; none for a state of another shape, and a phase saved without goal or plans (0.10.0) gets empty ones. */
export const roadmapPhasesOf = (state: unknown): RoadmapPhase[] =>
  Array.isArray(state)
    ? (state as Array<Partial<RoadmapPhase> | null>).flatMap(p =>
        typeof p?.name === 'string' && typeof p.status === 'string' && p.status in MARK
          ? [{ name: p.name, status: p.status, goal: typeof p.goal === 'string' ? p.goal : '', plans: Array.isArray(p.plans) ? p.plans : [] }]
          : [],
      )
    : []

export type PhaseProgress = { done: number; total: number } | undefined

/** A phase name as a word of a file name: lower case, letters and digits only (`P2a` -> `p2a`). */
const wordOf = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')
const fileOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * Per phase, the tasks done and in all of the tracked plans that belong to it: a plan whose file name has the phase name as a word
 * (`2026-11-06-p2a-effect-engine.md` for `P2a`), or a plan its row links to. Undefined for a phase without a parsed plan.
 */
export function roadmapProgress(phases: readonly RoadmapPhase[], tracked: ReadonlyArray<{ path: string; plan: Plan | null }>): PhaseProgress[] {
  return phases.map(phase => {
    const word = wordOf(phase.name)
    const plans = tracked.filter(t => {
      const file = fileOf(t.path)
      return t.plan !== null && (phase.plans.includes(file) || (word !== '' && file.toLowerCase().replace(/\.md$/, '').split(/[^a-z0-9]+/).includes(word)))
    })
    if (plans.length === 0) return undefined
    const all = plans.flatMap(t => t.plan?.phases ?? [])

    return { done: all.reduce((sum, p) => sum + phaseDoneCount(p), 0), total: all.reduce((sum, p) => sum + p.tasks.length, 0) }
  })
}

/** The first and last phase shown in `rows` rows around `focus`, with room for a `↑ N` row above and a `… +N` row below. */
function windowOf(count: number, focus: number, rows: number): { start: number; end: number } {
  if (count <= rows) return { start: 0, end: count }
  if (rows < 3) {
    const start = Math.max(0, Math.min(focus, count - rows))
    return { start, end: start + rows }
  }
  const fits = (start: number) => count - start <= rows - (start > 0 ? 1 : 0)
  let start = Math.max(0, focus - 1)
  while (start > 0 && fits(start - 1)) start -= 1
  const room = rows - (start > 0 ? 1 : 0)
  if (count - start <= room) return { start, end: count }
  // one row goes to `… +N`: a window too small for the phase before the current one starts at the current one
  const body = room - 1
  if (focus >= start + body) start = Math.max(1, focus - body + 1)

  return { start, end: start + body }
}

/** The roadmap view: one row per phase (mark, name, goal, plan progress), scrolled to keep the current phase in `maxRows` rows. */
export function roadmapRows(phases: readonly RoadmapPhase[], progress: readonly PhaseProgress[], maxRows: number, width: number): PlanLine[] {
  const focus = Math.max(0, phases.findIndex(p => p.status === 'active') === -1 ? phases.findIndex(p => p.status !== 'done') : phases.findIndex(p => p.status === 'active'))
  const { start, end } = windowOf(phases.length, focus, Math.max(1, maxRows))
  const pad = Math.min(PAD_MAX, Math.max(...phases.map(p => p.name.length)))
  const rows = phases.slice(start, end).map((phase, offset): PlanLine => {
    const p = progress[start + offset]
    const tail = p === undefined ? '' : `  ${p.done}/${p.total}`
    const head = `${MARK[phase.status]} ${truncate(phase.name, pad).padEnd(pad)}`
    const room = width - head.length - 2 - tail.length
    const goal = phase.goal === '' || room < 2 ? '' : `  ${truncate(phase.goal, room)}`

    return { text: truncate(`${head}${goal}${tail}`.trimEnd(), width), tone: TONE[phase.status], isBold: phase.status === 'active' }
  })
  const above: PlanLine[] = start > 0 && maxRows >= 3 ? [{ text: `↑ ${start}`, tone: 'muted', isBold: false }] : []
  const below: PlanLine[] = end < phases.length && maxRows >= 3 ? [{ text: `… +${phases.length - end}`, tone: 'muted', isBold: false }] : []

  return [...above, ...rows, ...below]
}
