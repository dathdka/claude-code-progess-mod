import type { Plan } from '../types'
import { phaseDoneCount } from './plan'
import { COLORS, truncate } from './style'

export type Tone = 'text' | 'muted' | 'success' | 'active' | 'accent'
export type PlanLine = { text: string; tone: Tone; isBold: boolean }

export const toneColor = (tone: Tone): string =>
  tone === 'success' ? COLORS.success : tone === 'active' ? COLORS.active : tone === 'accent' ? COLORS.accent : tone === 'muted' ? COLORS.muted : COLORS.text

/** The focus returns to the current phase this long after the last button press. */
export const FOCUS_RETURN_MS = 60_000
/** The phase list never takes more rows than this. */
export const MAX_LIST_ROWS = 8
const BAR_CELLS = 8
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫'
const MIN_NAME = 4

export const phaseNumber = (index: number): string => CIRCLED[index] ?? String(index + 1)

const bar = (done: number, total: number): string => {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS)

  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_CELLS - filled)}`
}

/** The phase the pane shows: the user's focus for a minute after a press (kept inside the plan), else the current phase. */
export function shownFocus(focus: number | null, pressedAt: number, now: number, current: number, count: number): number {
  const last = Math.max(0, count - 1)
  const base = focus !== null && now - pressedAt <= FOCUS_RETURN_MS ? focus : current

  return Math.min(last, Math.max(0, base))
}

/** One line per phase, scrolled so the focused phase shows; the focused and the current phase also get a bar. */
export function phaseLines(plan: Plan, focus: number, current: number, maxRows: number, width: number): PlanLine[] {
  const count = plan.phases.length
  const rows = Math.max(1, Math.min(maxRows, MAX_LIST_ROWS, count))
  const start = count <= rows ? 0 : Math.min(count - rows, Math.max(0, focus - Math.floor(rows / 2)))
  const shown = plan.phases.slice(start, start + rows).map((phase, offset) => {
    const index = start + offset
    const done = phaseDoneCount(phase)
    const total = phase.tasks.length
    const mark = done === total ? '✔' : index === current ? '▶' : '○'
    const withBar = index === focus || index === current
    const tail = ` ${mark} ${done}/${total}${withBar ? ` ${bar(done, total)}` : ''}`

    return { index, phase, mark, tail, done, total }
  })
  // the number and a space: two columns from the 13th phase on (several plans merged)
  const number = 1 + Math.max(...shown.map(s => phaseNumber(s.index).length))
  const room = Math.max(MIN_NAME, width - number - Math.max(...shown.map(s => s.tail.length)))
  const pad = Math.min(room, Math.max(...shown.map(s => s.phase.name.length)))

  return shown.map(s => {
    const name = truncate(s.phase.name, room).padEnd(pad)
    const tone: Tone = s.index === focus ? 'accent' : s.mark === '✔' ? 'success' : s.mark === '▶' ? 'active' : 'muted'

    return { text: `${phaseNumber(s.index)} ${name}${s.tail}`, tone, isBold: s.index === focus }
  })
}

/**
 * The tasks of one phase in `maxRows` rows: finished tasks before the current one collapse into `✔ N done` plus the last
 * finished one, the current task is marked, the next ones follow, and `… +N` counts the rest. A tiny budget drops the head first.
 */
export function taskLines(plan: Plan, focus: number, maxRows: number, width: number): PlanLine[] {
  const tasks = plan.phases[focus]?.tasks ?? []
  const rows = Math.max(1, maxRows)
  const room = Math.max(1, width - 2)
  const index = tasks.findIndex(t => !t.isDone)
  if (index === -1) return [{ text: `✔ all ${tasks.length} done`, tone: 'success', isBold: false }]

  const line = (mark: string, name: string, tone: Tone, isBold = false, extra = ''): PlanLine => ({
    text: `${mark} ${truncate(name, Math.max(1, room - extra.length))}${extra}`,
    tone,
    isBold,
  })
  const head: PlanLine[] = []
  if (index >= 2) head.push({ text: `✔ ${index - 1} done`, tone: 'muted', isBold: false })
  const before = tasks[index - 1]
  if (before !== undefined) head.push(line('✔', before.name, 'success'))
  const current = tasks[index]
  if (current === undefined) return head
  head.push(line('▶', current.name, 'active', true, current.total > 1 ? `  ${current.done}/${current.total}` : ''))
  if (head.length >= rows) return head.slice(head.length - rows)

  const rest = tasks.slice(index + 1)
  const remaining = rows - head.length
  const items = (list: typeof rest): PlanLine[] => list.map(t => (t.isDone ? line('✔', t.name, 'success') : line('○', t.name, 'text')))
  if (rest.length <= remaining) return [...head, ...items(rest)]

  return [...head, ...items(rest.slice(0, remaining - 1)), { text: `… +${rest.length - (remaining - 1)}`, tone: 'muted', isBold: false }]
}
