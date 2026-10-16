/** One fixed palette on a fixed dark card: legible whatever the terminal's own background is. */
export const COLORS = {
  card: '#14171c',
  text: '#c9d1d9',
  muted: '#8b949e',
  track: '#30363d',
  accent: '#79c0ff',
  success: '#7ee787',
  active: '#f2cc60',
  warn: '#ff7b72',
  doneText: '#6e7681',
} as const

export function truncate(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))

  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

export function barParts(percent: number, width: number): { filled: string; rest: string } {
  const count = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return { filled: '█'.repeat(count), rest: '░'.repeat(width - count) }
}
