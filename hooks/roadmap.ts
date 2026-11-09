import type { RoadmapPhase, RoadmapStatus } from '../types'
import { truncate } from './style'

/** The file looked for beside each tracked plan, and in the project's plans directory. */
export const ROADMAP_FILE = 'roadmap.md'
const PROJECT_PLANS = '/docs/superpowers/plans/'
/** Rows kept from the roadmap table; names are cut like plan names. */
const MAX_ROWS = 24
const NAME_MAX = 60
const LINE_MAX = 512
const BAR_CELLS = 8
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const FENCE = /^\s*(`{3,}|~{3,})/
const DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const STATUS_HEADER = /^(status|state)$/i
const DONE = /^(done|complete|completed|finished|shipped|✅|✔️?|x)$/i
const ACTIVE = /^(in[ _-]?progress|active|wip|doing|current|started|🚧|▶)$/i
const MARK: Record<RoadmapStatus, string> = { done: '✔', active: '▶', pending: '○' }

/** A cell's text without Markdown emphasis, code ticks or link targets. */
const cellText = (cell: string): string =>
  cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)

const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cellText)

const statusOf = (cell: string): RoadmapStatus => (DONE.test(cell) ? 'done' : ACTIVE.test(cell) ? 'active' : 'pending')

/**
 * The phases of the first Markdown table whose header has a `Status` (or `State`) column: the name from the first column, the
 * state from that one. Undefined when there is no such table. Tables in code fences are ignored.
 */
export function parseRoadmap(text: string): RoadmapPhase[] | undefined {
  const lines = text.split(/\r?\n/).map(l => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l))
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
    const column = cellsOf(line).findIndex(c => STATUS_HEADER.test(c))
    if (column <= 0) continue

    return tableRows(lines.slice(i + 2), column)
  }

  return undefined
}

/** The rows of a table body up to its first non-table line, at most MAX_ROWS, each named by its first cell. */
function tableRows(body: readonly string[], column: number): RoadmapPhase[] | undefined {
  const phases: RoadmapPhase[] = []
  for (const line of body) {
    if (!line.includes('|') || phases.length >= MAX_ROWS) break
    const cells = cellsOf(line)
    const name = cells[0] ?? ''
    if (name !== '') phases.push({ name, status: statusOf(cells[column] ?? '') })
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

/** The saved roadmap phases; none for a state of another shape (an earlier load may have saved something else). */
export const roadmapPhasesOf = (state: unknown): RoadmapPhase[] =>
  Array.isArray(state) ? (state as unknown[]).filter((p): p is RoadmapPhase => typeof (p as RoadmapPhase | null)?.name === 'string' && (p as RoadmapPhase).status in MARK) : []
