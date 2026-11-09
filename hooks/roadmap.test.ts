import { expect, test } from 'claude-code/testing'

import { parseRoadmap, roadmapLine, roadmapPaths, roadmapPhasesOf } from './roadmap'

const ROADMAP = `# Roadmap — Cursed Treasure

Index of phases.

| Phase | Goal | Done when | Depends on | Branch | Detailed plan | Status |
|---|---|---|---|---|---|---|
| P0 | Repo + harness | Clone, tests pass | — | \`phase/p0-repo-harness\` | [p0.md](p0.md) | done |
| P1 | Networked sandbox | Shove into a pit | P0 | \`phase/p1\` | [p1.md](p1.md) | done |
| P2a | Effect engine | Combo runs | P1 | \`phase/p2\` | written at P2a start | in_progress |
| P2b | Corruption | Demon hunts | P2a | \`phase/p2b\` | written at P2b start | not_started |
| P3 | Procgen | Pacing | P2b | — | — | not_started |
| P4 | Run rules | **First playable** | P3 | — | — | not_started |
| Gate | Fun test | Majority want more | P4 | — | \`docs/playtests/\` | not_started |
| P5 | Steam | Invite a friend | Gate | — | — | not_started |
| P6+ | Content | Per backlog | P5 | per feature | per feature | not_started |
`

test('a roadmap table with a Status column gives each phase its state', () => {
  const phases = parseRoadmap(ROADMAP)
  expect(phases?.map(p => p.name)).toEqual(['P0', 'P1', 'P2a', 'P2b', 'P3', 'P4', 'Gate', 'P5', 'P6+'])
  expect(phases?.filter(p => p.status === 'done').length).toBe(2)
  expect(phases?.find(p => p.status === 'active')?.name).toBe('P2a')
})

test('statuses are read loosely and names lose their Markdown', () => {
  const text = `| **Stage** | State |\n|:--|--:|\n| [Alpha](a.md) | ✅ |\n| \`Beta\` | In Progress |\n| Gamma | Completed |\n| Delta | todo |\n| Eps | WIP |\n`
  expect(parseRoadmap(text)).toEqual([
    { name: 'Alpha', status: 'done' },
    { name: 'Beta', status: 'active' },
    { name: 'Gamma', status: 'done' },
    { name: 'Delta', status: 'pending' },
    { name: 'Eps', status: 'active' },
  ])
})

test('a file without a status table, or a table only inside a code fence, is no roadmap', () => {
  expect(parseRoadmap('# Notes\n\n- [ ] a\n- [x] b\n')).toBeUndefined()
  expect(parseRoadmap('| Name | Goal |\n|---|---|\n| a | b |\n')).toBeUndefined()
  expect(parseRoadmap('```\n| Phase | Status |\n|---|---|\n| P0 | done |\n```\n')).toBeUndefined()
})

test('only the first status table counts and rows are capped', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| R${i} | done |`).join('\n')
  const text = `| Phase | Status |\n|---|---|\n${rows}\n\nprose\n\n| Phase | Status |\n|---|---|\n| X | done |\n`
  const phases = parseRoadmap(text)
  expect(phases?.length).toBe(24)
  expect(phases?.some(p => p.name === 'X')).toBe(false)
})

test('the line shows every phase when it fits, else the count and the current phase', () => {
  const phases = parseRoadmap(ROADMAP) ?? []
  expect(roadmapLine(phases, 96)).toEqual({ text: 'Roadmap 2/9  ✔P0 ✔P1 ▶P2a ○P2b ○P3 ○P4 ○Gate ○P5 ○P6+', isDone: false })
  expect(roadmapLine(phases, 30)).toEqual({ text: 'Roadmap 2/9 ▰▰▱▱▱▱▱▱ ▶ P2a', isDone: false })
  expect(roadmapLine(phases, 14).text.length <= 14).toBe(true)
})

test('without an active phase the next one shows, and a finished roadmap says so', () => {
  const next = [{ name: 'A', status: 'done' as const }, { name: 'B', status: 'pending' as const }]
  expect(roadmapLine(next, 20).text).toBe('Roadmap 1/2  ✔A ○B')
  expect(roadmapLine(next, 12).text).toBe('Roadmap 1/2…')
  const all = [{ name: 'A', status: 'done' as const }]
  expect(roadmapLine(all, 40)).toEqual({ text: 'Roadmap 1/1  ✔A', isDone: true })
})

test('the roadmap is looked for beside each tracked plan, most recent first, then in the project', () => {
  expect(roadmapPaths(['/r/docs/plans/a.md', '/x/plans/b.md', '/r/docs/plans/c.md'], '/r')).toEqual([
    '/r/docs/plans/roadmap.md',
    '/x/plans/roadmap.md',
    '/r/docs/superpowers/plans/roadmap.md',
  ])
  expect(roadmapPaths([], undefined)).toEqual([])
  expect(roadmapPaths([], 'relative')).toEqual([])
})

test('a saved roadmap of another shape reads as none', () => {
  expect(roadmapPhasesOf(null)).toEqual([])
  expect(roadmapPhasesOf({ phases: 1 })).toEqual([])
  expect(roadmapPhasesOf([{ name: 'A', status: 'done' }])).toEqual([{ name: 'A', status: 'done' }])
})
