import type { EngineInterface } from 'claude-code'

import type { Readings, RepoStatus } from '../types'
import { readingsFromUsage } from './gauges'
import { MAX_BYTES, ledgerDone, ledgerPathFor } from './plan'
import { parseStatus } from './repos'

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

/** The task numbers a plan's subagent-driven ledger reports complete; undefined without a ledger or when it cannot be read (a missing ledger is normal: never logged). */
export async function readLedger($: EngineInterface, planPath: string): Promise<number[] | undefined> {
  const path = ledgerPathFor(planPath)
  if (path === undefined) return undefined
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' && text.length <= MAX_BYTES ? ledgerDone(text, planPath) : undefined
  } catch {
    return undefined
  }
}
