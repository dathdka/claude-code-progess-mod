import type { Repo, RepoStatus } from '../types'
import { truncate } from './style'

/** Repositories tracked at once; the least recently edited one is dropped for a seventh. */
export const MAX_TRACKED = 6
/** Up to this many repositories are shown; from one more on, two are shown and the rest counted. */
export const MAX_SHOWN = 3
const SHOWN_WHEN_MORE = 2
/** A repository whose status fails this many polls in a row is dropped. */
export const MAX_FAILURES = 3
const CACHE_MAX = 200
const MIN_BRANCH = 4
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

export type RootCache = ReadonlyMap<string, string>

/** The branch, changed-file count and distance from the upstream out of `git status --porcelain -b`. */
export function parseStatus(stdout: string): RepoStatus | undefined {
  const lines = stdout.split('\n').filter(line => line !== '')
  const head = lines[0]
  if (head === undefined || !head.startsWith('## ')) return undefined
  const changed = lines.length - 1
  const text = head.slice(3)
  let branch: string
  let ahead = 0
  let behind = 0
  if (text.startsWith('HEAD (no branch)')) branch = '(detached)'
  else if (text.startsWith('No commits yet on ')) branch = text.slice('No commits yet on '.length)
  else if (text.startsWith('Initial commit on ')) branch = text.slice('Initial commit on '.length)
  else {
    const track = /\[([^\]]*)\]\s*$/.exec(text)
    branch = (track === null ? text : text.slice(0, track.index)).trim().split('...')[0] ?? ''
    ahead = Number(/ahead (\d+)/.exec(track?.[1] ?? '')?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(track?.[1] ?? '')?.[1] ?? 0)
  }
  branch = branch.replace(CONTROL_CHARS, ' ').trim()

  return branch === '' ? undefined : { branch, changed, ahead, behind }
}

/** The repository was just edited: it goes to the front with its failures cleared and its last reading kept. */
export function touchRepo(repos: readonly Repo[], root: string, now: number): Repo[] {
  const previous = repos.find(r => r.root === root)
  const entry: Repo = { root, touchedAt: now, status: previous?.status, failures: 0 }

  return [entry, ...repos.filter(r => r.root !== root)].slice(0, MAX_TRACKED)
}

/** One poll's outcome for a repository: a status replaces the last one, `skip` keeps it, `fail` counts toward dropping it. */
export function applyReading(repos: readonly Repo[], root: string, reading: RepoStatus | 'skip' | 'fail'): Repo[] {
  return repos.flatMap(repo => {
    if (repo.root !== root || reading === 'skip') return [repo]
    if (reading === 'fail') return repo.failures + 1 >= MAX_FAILURES ? [] : [{ ...repo, failures: repo.failures + 1 }]

    return [{ ...repo, status: reading, failures: 0 }]
  })
}

/** The repositories to draw: only those already read; with more than three, two are drawn and the rest counted. */
export function visibleRepos(repos: readonly Repo[]): { shown: Repo[]; more: number } {
  const ready = repos.filter(repo => repo.status !== undefined)
  if (ready.length <= MAX_SHOWN) return { shown: ready, more: 0 }

  return { shown: ready.slice(0, SHOWN_WHEN_MORE), more: ready.length - SHOWN_WHEN_MORE }
}

export const repoName = (root: string): string => root.slice(root.lastIndexOf('/') + 1) || root

const cutMiddle = (text: string, width: number): string => {
  if (text.length <= width) return text
  if (width <= 1) return '…'
  const keep = width - 1
  const tail = Math.floor(keep / 2)

  return `${text.slice(0, Math.ceil(keep / 2))}…${tail > 0 ? text.slice(-tail) : ''}`
}

/** The pieces of one repository line, `⎇ name  branch  detail`, fitted to `width`: the branch is cut in the middle first, the name only as a last resort. */
export function repoLine(name: string, status: RepoStatus, width: number): { name: string; branch: string; detail: string } {
  const detail = [status.changed === 0 ? '✓' : `●${status.changed}`, status.ahead > 0 ? `↑${status.ahead}` : '', status.behind > 0 ? `↓${status.behind}` : '']
    .filter(part => part !== '')
    .join(' ')
  const frame = '⎇ '.length + '  '.length + '  '.length + detail.length
  let room = width - frame - name.length
  let shownName = name
  if (room < MIN_BRANCH) {
    shownName = truncate(name, Math.max(1, name.length + room - MIN_BRANCH))
    room = MIN_BRANCH
  }

  return { name: shownName, branch: cutMiddle(status.branch, room), detail }
}

/** Remembers a directory's repository root; the oldest entries beyond 200 are forgotten. */
export function cacheRoot(cache: RootCache, dir: string, root: string): RootCache {
  const next = new Map([...cache].filter(([key]) => key !== dir))
  next.set(dir, root)

  return new Map([...next].slice(-CACHE_MAX))
}
