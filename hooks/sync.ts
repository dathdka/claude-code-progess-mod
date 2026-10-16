import type { EngineInterface } from 'claude-code'

import type { Item, SessionRow } from '../types'
import { buildRows } from './overview'
import { parseRecord, parseRegistry, progressRecord } from './share'
import type { ProgressRecord, RegistryEntry } from './share'

const PROGRESS_DIR = 'task-progress'
const SESSIONS_DIR = 'sessions'
const RM_TIMEOUT_MS = 2000
const MAX_SESSIONS = 12
const STALE_RECORD_MS = 24 * 60 * 60 * 1000
const EXTENSION = '.json'
const MAX_REMOVALS_PER_POLL = 5
const MISSING_DIRECTORY = 'ENOENT'

let hasLogged = false
/** Whether the progress directory was already made private by this process. */
let isDirectorySecured = false
/** The session id of the record published last; undefined until something was published. */
let lastPublishedId: string | undefined

/** Module state starts fresh with every registration, like the state in register.tsx. */
export function resetSyncState(): void {
  isDirectorySecured = false
  lastPublishedId = undefined
}

/** True when the session id is no longer the one the last record was published under (after `/clear`). */
export async function hasSessionIdChanged($: EngineInterface): Promise<boolean> {
  try {
    return lastPublishedId !== undefined && (await $.session.id()) !== lastPublishedId
  } catch {
    return false
  }
}

/** A sharing failure is logged once to the debug channel and never reaches the session. */
async function logOnce($: EngineInterface, what: string, error: unknown): Promise<void> {
  if (hasLogged) return
  hasLogged = true
  try {
    await $.ui.log(`task-progress: ${what}: ${String(error)}`, { to: 'debug' })
  } catch {
    // nothing left to tell
  }
}

/** Claude Code's configuration directory: where `sessions/` is and where the progress files go. */
export async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom !== undefined && custom !== '') return custom

  return `${(await $.env.get('HOME')) ?? ''}/.claude`
}

const recordPath = (root: string, sessionId: string): string => `${root}/${PROGRESS_DIR}/${sessionId}.json`

/** Claude Code's own `sessions/` is 0700; the task titles published here get the same privacy, once per process. */
async function secureDirectory($: EngineInterface, dir: string): Promise<void> {
  if (isDirectorySecured) return
  isDirectorySecured = true
  try {
    await $.process.run(['chmod', '700', dir], { timeoutMs: RM_TIMEOUT_MS })
  } catch (error) {
    await logOnce($, 'could not make the progress directory private', error)
  }
}

/** Writes this session's progress where the other sessions' panes look for it. */
export async function publishProgress($: EngineInterface, items: ReadonlyArray<Item>): Promise<void> {
  try {
    const id = await $.session.id()
    lastPublishedId = id
    const root = await configDir($)
    await $.fs.write(recordPath(root, id), JSON.stringify(progressRecord(id, items, await $.clock.now())))
    await secureDirectory($, `${root}/${PROGRESS_DIR}`)
  } catch (error) {
    await logOnce($, 'could not publish progress', error)
  }
}

/** Removes a record, the own one when the session ends. The file API cannot delete, so `rm -f` does. */
export async function removeRecord($: EngineInterface, sessionId: string): Promise<void> {
  try {
    await $.process.run(['rm', '-f', recordPath(await configDir($), sessionId)], { timeoutMs: RM_TIMEOUT_MS })
  } catch (error) {
    await logOnce($, 'could not remove a progress file', error)
  }
}

type Listed = { name: string; mtimeMs: number }

/** The `.json` files of a directory; a directory that is not there is an empty one, any other failure is thrown. */
async function listJson($: EngineInterface, dir: string): Promise<Listed[]> {
  try {
    const entries = await $.fs.list(dir)

    return entries.filter(f => f.kind === 'file' && f.name.endsWith(EXTENSION)).map(f => ({ name: f.name, mtimeMs: f.mtimeMs }))
  } catch (error) {
    if (String(error).includes(MISSING_DIRECTORY)) return []
    throw error
  }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * The other sessions as rows, or undefined when this poll failed (the pane keeps the last rows).
 * Reads at most 12 registry files and the records of those sessions; records of sessions that are gone are
 * removed once a day old, at most 5 per poll, and only after a complete read of the registry (never from a
 * capped or partly unreadable one, which could mistake a live session's record for an orphan).
 */
export async function pollSessions($: EngineInterface): Promise<SessionRow[] | undefined> {
  try {
    const root = await configDir($)
    const now = await $.clock.now()
    const entries: RegistryEntry[] = []
    const listed = await listJson($, `${root}/${SESSIONS_DIR}`)
    for (const file of listed.slice(0, MAX_SESSIONS)) {
      const text = await readText($, `${root}/${SESSIONS_DIR}/${file.name}`)
      const entry = text === undefined ? undefined : parseRegistry(text)
      if (entry !== undefined) entries.push(entry)
    }
    const alive = new Set(entries.map(e => e.sessionId))
    const isRegistryComplete = listed.length <= MAX_SESSIONS && entries.length === listed.length
    let removals = 0
    const records: ProgressRecord[] = []
    for (const file of await listJson($, `${root}/${PROGRESS_DIR}`)) {
      const id = file.name.slice(0, -EXTENSION.length)
      if (alive.has(id)) {
        const text = await readText($, `${root}/${PROGRESS_DIR}/${file.name}`)
        const record = text === undefined ? undefined : parseRecord(text)
        if (record !== undefined && record.sessionId === id) records.push(record)
      } else if (isRegistryComplete && removals < MAX_REMOVALS_PER_POLL && now - file.mtimeMs > STALE_RECORD_MS) {
        removals += 1
        await removeRecord($, id)
      }
    }

    return buildRows(await $.session.id(), entries, records)
  } catch (error) {
    await logOnce($, 'could not read the other sessions', error)

    return undefined
  }
}
