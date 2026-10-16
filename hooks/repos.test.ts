import { expect, test } from 'claude-code/testing'

import type { Repo } from '../types'
import { MAX_FAILURES, MAX_TRACKED, applyReading, cacheRoot, parseStatus, repoLine, repoName, touchRepo, visibleRepos } from './repos'

const status = (changed = 0, branch = 'main') => ({ branch, changed, ahead: 0, behind: 0 })
const repo = (root: string, touchedAt = 1): Repo => ({ root, touchedAt, status: status(), failures: 0 })
const unread = (root: string): Repo => ({ root, touchedAt: 1, status: undefined, failures: 0 })

test('status output gives branch, changed files and distance from the upstream', () => {
  expect(parseStatus('## dev-x...origin/dev-x [ahead 2, behind 1]\n M a.ts\n?? b.ts\n')).toEqual({ branch: 'dev-x', changed: 2, ahead: 2, behind: 1 })
  expect(parseStatus('## dev-x...origin/dev-x [ahead 3]\n')).toEqual({ branch: 'dev-x', changed: 0, ahead: 3, behind: 0 })
  expect(parseStatus('## dev-x...origin/dev-x [behind 4]\n')).toEqual({ branch: 'dev-x', changed: 0, ahead: 0, behind: 4 })
  expect(parseStatus('## dev-x...origin/dev-x [gone]\n')).toEqual({ branch: 'dev-x', changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus('## main\n')).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus('## feat/a-b...origin/feat/a-b\nA  x\nD  y\n')).toEqual({ branch: 'feat/a-b', changed: 2, ahead: 0, behind: 0 })
})

test('an unborn or detached branch has a readable name', () => {
  expect(parseStatus('## No commits yet on main\n?? a\n')).toEqual({ branch: 'main', changed: 1, ahead: 0, behind: 0 })
  expect(parseStatus('## Initial commit on main\n')).toEqual({ branch: 'main', changed: 0, ahead: 0, behind: 0 })
  expect(parseStatus('## HEAD (no branch)\n M a\n')).toEqual({ branch: '(detached)', changed: 1, ahead: 0, behind: 0 })
})

test('output that is not a status gives nothing', () => {
  expect(parseStatus('')).toBeUndefined()
  expect(parseStatus('fatal: not a git repository\n')).toBeUndefined()
  expect(parseStatus('## \n')).toBeUndefined()
})

test('a touched repository moves to the front, a new one is added, six at most are tracked', () => {
  let repos: Repo[] = []
  for (let i = 0; i < MAX_TRACKED + 2; i += 1) repos = touchRepo(repos, `/w/r${i}`, i)
  expect(repos.map(r => r.root)).toEqual(['/w/r7', '/w/r6', '/w/r5', '/w/r4', '/w/r3', '/w/r2'])
  repos = touchRepo(repos, '/w/r3', 100)
  expect(repos.map(r => r.root)).toEqual(['/w/r3', '/w/r7', '/w/r6', '/w/r5', '/w/r4', '/w/r2'])
  expect(repos[0]?.touchedAt).toBe(100)
})

test('touching a repository keeps its last reading and clears its failures', () => {
  const failing: Repo = { root: '/w/a', touchedAt: 1, status: status(3), failures: 2 }
  expect(touchRepo([failing], '/w/a', 9)).toEqual([{ root: '/w/a', touchedAt: 9, status: status(3), failures: 0 }])
})

test('a good reading is stored, a skipped one changes nothing, three failures in a row drop the repository', () => {
  let repos = [unread('/w/a'), repo('/w/b')]
  repos = applyReading(repos, '/w/a', status(4, 'dev'))
  expect(repos[0]?.status).toEqual(status(4, 'dev'))
  expect(applyReading(repos, '/w/a', 'skip')).toEqual(repos)
  for (let i = 1; i < MAX_FAILURES; i += 1) repos = applyReading(repos, '/w/a', 'fail')
  expect(repos.map(r => r.root)).toEqual(['/w/a', '/w/b'])
  expect(repos[0]?.failures).toBe(MAX_FAILURES - 1)
  repos = applyReading(repos, '/w/a', 'fail')
  expect(repos.map(r => r.root)).toEqual(['/w/b'])
  expect(applyReading(applyReading(repos, '/w/b', 'fail'), '/w/b', status(1))[0]?.failures).toBe(0)
})

test('up to three repositories are shown, from four on two are shown and the rest counted', () => {
  const at = (n: number) => Array.from({ length: n }, (_, i) => repo(`/w/r${i}`))
  expect(visibleRepos(at(0))).toEqual({ shown: [], more: 0 })
  expect(visibleRepos(at(3)).shown.length).toBe(3)
  expect(visibleRepos(at(3)).more).toBe(0)
  expect(visibleRepos(at(4)).shown.map(r => r.root)).toEqual(['/w/r0', '/w/r1'])
  expect(visibleRepos(at(4)).more).toBe(2)
  expect(visibleRepos(at(6)).more).toBe(4)
})

test('a repository without a first reading is not shown or counted', () => {
  expect(visibleRepos([unread('/w/a'), repo('/w/b')])).toEqual({ shown: [repo('/w/b')], more: 0 })
})

test('the repository name is the last part of its root', () => {
  expect(repoName('/home/me/work/core-inventory-service')).toBe('core-inventory-service')
  expect(repoName('/')).toBe('/')
})

test('a repository line shows the changed count, a tick for a clean one, and the distance from the upstream', () => {
  expect(repoLine('admin-v3', { branch: 'dev', changed: 8, ahead: 2, behind: 0 }, 80)).toEqual({ name: 'admin-v3', branch: 'dev', detail: '●8 ↑2' })
  expect(repoLine('admin-v3', { branch: 'dev', changed: 0, ahead: 0, behind: 1 }, 80).detail).toBe('✓ ↓1')
  expect(repoLine('a', { branch: 'dev', changed: 1, ahead: 1, behind: 1 }, 80).detail).toBe('●1 ↑1 ↓1')
})

test('a long branch is cut in the middle, never the repository name', () => {
  const long = 'dev-dat-rate-sheet-duplicate-fixes-and-more'
  const line = repoLine('admin-v3', { branch: long, changed: 8, ahead: 0, behind: 0 }, 40)
  expect(line.name).toBe('admin-v3')
  expect(line.branch.includes('…')).toBe(true)
  expect(line.branch.startsWith('dev-')).toBe(true)
  expect(line.branch.endsWith('more')).toBe(true)
  expect(`⎇ ${line.name}  ${line.branch}  ${line.detail}`.length <= 40).toBe(true)
})

test('only when the name alone leaves no room is the name cut', () => {
  const line = repoLine('a-very-long-repository-name-indeed', { branch: 'dev-branch', changed: 3, ahead: 0, behind: 0 }, 30)
  expect(line.name.endsWith('…')).toBe(true)
  expect(`⎇ ${line.name}  ${line.branch}  ${line.detail}`.length <= 30).toBe(true)
})

test('the root cache keeps the newest 200 directories', () => {
  let cache = cacheRoot(new Map(), '/w/a/src', '/w/a')
  expect(cache.get('/w/a/src')).toBe('/w/a')
  for (let i = 0; i < 205; i += 1) cache = cacheRoot(cache, `/d/${i}`, `/r/${i}`)
  expect(cache.size).toBe(200)
  expect(cache.has('/w/a/src')).toBe(false)
  expect(cache.get('/d/204')).toBe('/r/204')
  expect(cacheRoot(cache, '/d/204', '/r/x').size).toBe(200)
})
