const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / SECOND))}s`
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`
  const hours = Math.floor(ms / HOUR)
  const minutes = Math.round((ms % HOUR) / MINUTE)

  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
}

/** Linear estimate: time per finished task times the tasks left; none until one is done. */
export function remainingMs(elapsedMs: number, done: number, total: number): number | undefined {
  if (done === 0 || done >= total) return undefined

  return (elapsedMs / done) * (total - done)
}

export function timingText(elapsedMs: number, done: number, total: number, isFinished: boolean): string {
  if (total === 0 || elapsedMs <= 0) return ''
  if (isFinished) return `${formatDuration(elapsedMs)} total`
  const left = remainingMs(elapsedMs, done, total)

  return left === undefined
    ? formatDuration(elapsedMs)
    : `${formatDuration(elapsedMs)} · ~${formatDuration(left)} left`
}
