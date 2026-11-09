import { expect, test } from 'claude-code/testing'

import type { RoadmapPhase } from '../types'
import { parseRoadmap, roadmapLine, roadmapPaths, roadmapPhasesOf, roadmapProgress, roadmapRows } from './roadmap'

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

const phase = (name: string, status: RoadmapPhase['status'], goal = '', plans: string[] = []): RoadmapPhase => ({ name, status, goal, plans })

test('a roadmap table with a Status column gives each phase its state', () => {
  const phases = parseRoadmap(ROADMAP)
  expect(phases?.map(p => p.name)).toEqual(['P0', 'P1', 'P2a', 'P2b', 'P3', 'P4', 'Gate', 'P5', 'P6+'])
  expect(phases?.filter(p => p.status === 'done').length).toBe(2)
  expect(phases?.find(p => p.status === 'active')?.name).toBe('P2a')
})

test('statuses are read loosely and names lose their Markdown', () => {
  const text = `| **Stage** | State |\n|:--|--:|\n| [Alpha](a.md) | ✅ |\n| \`Beta\` | In Progress |\n| Gamma | Completed |\n| Delta | todo |\n| Eps | WIP |\n`
  expect(parseRoadmap(text)).toEqual([
    { name: 'Alpha', status: 'done', goal: '', plans: ['a.md'] },
    { name: 'Beta', status: 'active', goal: '', plans: [] },
    { name: 'Gamma', status: 'done', goal: '', plans: [] },
    { name: 'Delta', status: 'pending', goal: '', plans: [] },
    { name: 'Eps', status: 'active', goal: '', plans: [] },
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
  const next = [phase('A', 'done'), phase('B', 'pending')]
  expect(roadmapLine(next, 20).text).toBe('Roadmap 1/2  ✔A ○B')
  expect(roadmapLine(next, 12).text).toBe('Roadmap 1/2…')
  const all = [phase('A', 'done')]
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
  // a phase saved by 0.10.0 had no goal or plans
  expect(roadmapPhasesOf([{ name: 'A', status: 'done' }])).toEqual([phase('A', 'done')])
  expect(roadmapPhasesOf([{ name: 'A', status: 'nope' }])).toEqual([])
})

test('a long row still has its status read', () => {
  const text = `| Phase | Goal | Status |\n|---|---|---|\n| P0 | ${'g'.repeat(600)} | done |\n`
  expect(parseRoadmap(text)?.[0]?.status).toBe('done')
})

test('each phase keeps its goal (the Goal column, else the first other column) and the .md files its row links', () => {
  const phases = parseRoadmap(ROADMAP) ?? []
  expect(phases[0]).toEqual(phase('P0', 'done', 'Repo + harness', ['p0.md']))
  expect(phases[2]).toEqual(phase('P2a', 'active', 'Effect engine'))
  const plain = parseRoadmap('| Step | What | Status |\n|---|---|---|\n| A | [do it](x/y/2026-a.md) and more | done |\n')
  expect(plain).toEqual([phase('A', 'done', 'do it and more', ['2026-a.md'])])
})

const tracked = (path: string, done: number, total: number) => ({
  path,
  plan: { title: 't', phases: [{ name: 'p', tasks: Array.from({ length: total }, (_, i) => ({ name: `t${i}`, number: i + 1, done: 0, total: 1, isDone: i < done })) }] },
})

test('a phase takes the progress of the plans whose file name has its name as a word, or that its row links', () => {
  const phases = [phase('P0', 'done', '', ['p0-setup.md']), phase('P2a', 'active'), phase('P2b', 'pending'), phase('P6+', 'pending')]
  const plans = [tracked('/r/plans/p0-setup.md', 3, 3), tracked('/r/plans/2026-11-06-p2a-effect-engine.md', 13, 18), tracked('/r/plans/p2ab.md', 1, 2)]
  expect(roadmapProgress(phases, plans)).toEqual([{ done: 3, total: 3 }, { done: 13, total: 18 }, undefined, undefined])
  expect(roadmapProgress(phases, [{ path: '/r/plans/p2a.md', plan: null }])).toEqual([undefined, undefined, undefined, undefined])
})

test('the roadmap view lists every phase with its mark, aligned name, goal and plan progress', () => {
  const phases = [phase('P0', 'done', 'Repo'), phase('P2a', 'active', 'Effect engine and items'), phase('Gate', 'pending', 'Fun test')]
  const lines = roadmapRows(phases, [undefined, { done: 13, total: 18 }, undefined], 10, 40)
  expect(lines.map(l => l.text)).toEqual(['✔ P0    Repo', '▶ P2a   Effect engine and items  13/18', '○ Gate  Fun test'])
  expect(lines.map(l => l.tone)).toEqual(['success', 'active', 'muted'])
  expect(lines[1]?.isBold).toBe(true)
  const narrow = roadmapRows(phases, [undefined, { done: 13, total: 18 }, undefined], 10, 24)
  expect(narrow[1]?.text).toBe('▶ P2a   Effect e…  13/18')
  expect(narrow.every(l => l.text.length <= 24)).toBe(true)
})

test('a roadmap longer than the rows scrolls to keep the current phase and counts the rest', () => {
  const phases = Array.from({ length: 9 }, (_, i) => phase(`P${i}`, i < 5 ? 'done' : i === 5 ? 'active' : 'pending', 'g'))
  const texts = roadmapRows(phases, [], 5, 40).map(l => l.text)
  expect(texts).toEqual(['↑ 4', '✔ P4  g', '▶ P5  g', '○ P6  g', '… +2'])
  expect(roadmapRows(phases, [], 2, 40).map(l => l.text)).toEqual(['▶ P5  g', '○ P6  g'])
  expect(roadmapRows(phases, [], 9, 40).length).toBe(9)
  expect(roadmapRows(phases, [], 3, 40).map(l => l.text)).toEqual(['↑ 5', '▶ P5  g', '… +3'])
})
