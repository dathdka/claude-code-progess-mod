import type { EngineInterface } from 'claude-code'

/** Players tried in order until one exits 0: macOS first, then the usual Linux ones. */
const PLAYERS: ReadonlyArray<readonly string[]> = [
  ['afplay'],
  ['pw-play'],
  ['paplay'],
  ['aplay', '-q'],
  ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet'],
]

export function playerCommands(file: string): string[][] {
  return PLAYERS.map(player => [...player, file])
}

/** The person's own file when it is an absolute path, else the clip shipped with the mod. */
export function soundPath(root: string, custom: unknown): string {
  const own = typeof custom === 'string' ? custom.trim() : ''

  return own.startsWith('/') ? own : `${root}/sounds/done.wav`
}

const CUT_SLACK_MS = 500

/** A player that failed only after running for (almost) the whole cap was cut off mid-clip, not missing. */
export function wasCutByCap(startedMs: number, endedMs: number, maxMs: number): boolean {
  return endedMs - startedMs >= maxMs - CUT_SLACK_MS
}

export async function playDone($: EngineInterface, file: string, maxMs: number): Promise<void> {
  try {
    for (const argv of playerCommands(file)) {
      const started = await $.clock.now()
      try {
        const { exitCode } = await $.process.run(argv, { timeoutMs: maxMs })
        if (exitCode === 0) return
      } catch {
        // either this player is not installed, or the cap cut a long clip short
        if (wasCutByCap(started, await $.clock.now(), maxMs)) return
      }
    }
    $.ui.log('task-progress: no audio player could play the completion sound', { to: 'debug' })
  } catch {
    // a sound is a side effect: it must never throw into the session
  }
}
