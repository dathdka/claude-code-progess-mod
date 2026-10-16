import { expect, test } from 'claude-code/testing'

import { STALE_RUNNING_MS, EMPTY_ACTIVITY, agentCount, begin, callLabel, describeDoing, end, touchedDirectory } from './activity'

const T0 = 1_700_000_000_000
const SECOND = 1000
const call = (id: string, label: string, agentId?: string) => ({ id, label, agentId })

test('a call is labelled by its tool and its target', () => {
  expect(callLabel('Edit', { file_path: '/a/b/register.tsx' })).toBe('Edit register.tsx')
  expect(callLabel('Bash', { command: 'git   status\n--short' })).toBe('Bash git status --short')
  expect(callLabel('Bash', { command: 'x'.repeat(50) })).toBe(`Bash ${'x'.repeat(30)}`)
  expect(callLabel('Grep', { pattern: 'TODO' })).toBe('Grep TODO')
  expect(callLabel('Agent', { description: 'Review the diff' })).toBe('Agent Review the diff')
  expect(callLabel('mcp__plugin_x_github__create_issue', { title: 'x' })).toBe('create_issue')
  expect(callLabel('Read', { file_path: '/a/\u001b[31mred' })).toBe('Read [31mred')
  expect(callLabel('Bash', {})).toBe('Bash')
})

test('nothing running and nothing seen gives no line', () => {
  expect(describeDoing(EMPTY_ACTIVITY, T0)).toBeUndefined()
})

test('the oldest running main call is shown, with its time once it runs past 2 seconds', () => {
  let state = begin(EMPTY_ACTIVITY, call('1', 'Edit register.tsx'), T0)
  state = begin(state, call('2', 'Bash ls'), T0 + SECOND)
  expect(describeDoing(state, T0 + SECOND)).toEqual({ text: '▶ Edit register.tsx', isRunning: true, agents: '' })
  expect(describeDoing(state, T0 + 2 * SECOND)?.text).toBe('▶ Edit register.tsx')
  expect(describeDoing(state, T0 + 2500)?.text).toBe('▶ Edit register.tsx 2s')
  expect(describeDoing(state, T0 + 65 * SECOND)?.text).toBe('▶ Edit register.tsx 1m05s')
})

test('after a call ends the line reads as the last call for a minute, then goes', () => {
  const state = end(begin(EMPTY_ACTIVITY, call('1', 'Edit register.tsx'), T0), '1', T0 + 3 * SECOND)
  expect(describeDoing(state, T0 + 15 * SECOND)).toEqual({ text: '· Edit register.tsx 12s ago', isRunning: false, agents: '' })
  expect(describeDoing(state, T0 + 3 * SECOND + 60 * SECOND)?.text).toBe('· Edit register.tsx 1m00s ago')
  expect(describeDoing(state, T0 + 3 * SECOND + 61 * SECOND)).toBeUndefined()
})

test('ending a call that is not running changes nothing', () => {
  const state = begin(EMPTY_ACTIVITY, call('1', 'Bash ls'), T0)
  expect(end(state, 'nope', T0 + SECOND)).toBe(state)
})

test('subagents are counted by distinct id and never become the main line', () => {
  let state = begin(EMPTY_ACTIVITY, call('1', 'Read a.ts', 'ag1'), T0)
  state = begin(state, call('2', 'Bash ls', 'ag1'), T0)
  state = begin(state, call('3', 'Read b.ts', 'ag2'), T0)
  expect(agentCount(state, T0)).toBe(2)
  expect(describeDoing(state, T0)).toEqual({ text: '·', isRunning: false, agents: '+2 agents' })
  expect(describeDoing(begin(EMPTY_ACTIVITY, call('1', 'Read a.ts', 'ag1'), T0), T0)?.agents).toBe('+1 agent')
})

test('a subagent stays counted for 15 seconds after its last call, or while one of its calls runs', () => {
  const finished = end(begin(EMPTY_ACTIVITY, call('1', 'Read a.ts', 'ag1'), T0), '1', T0 + SECOND)
  expect(agentCount(finished, T0 + 16 * SECOND)).toBe(1)
  expect(agentCount(finished, T0 + 17 * SECOND)).toBe(0)
  const running = begin(EMPTY_ACTIVITY, call('1', 'Bash sleep', 'ag1'), T0)
  expect(agentCount(running, T0 + 600 * SECOND)).toBe(1)
})

test('the main line and the agent count show together', () => {
  const state = begin(begin(EMPTY_ACTIVITY, call('1', 'Agent review', undefined), T0), call('2', 'Read a.ts', 'ag1'), T0)
  expect(describeDoing(state, T0)).toEqual({ text: '▶ Agent review', isRunning: true, agents: '+1 agent' })
})

test('only Edit, Write, NotebookEdit and MultiEdit on an absolute path touch a directory', () => {
  expect(touchedDirectory('Edit', { file_path: '/work/svc/src/a.ts' })).toBe('/work/svc/src')
  expect(touchedDirectory('Write', { file_path: '/work/svc/my file.ts' })).toBe('/work/svc')
  expect(touchedDirectory('NotebookEdit', { notebook_path: '/work/n/a.ipynb' })).toBe('/work/n')
  expect(touchedDirectory('MultiEdit', { file_path: '/a.ts' })).toBe('/')
  expect(touchedDirectory('Read', { file_path: '/work/svc/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Bash', { command: 'sed -i x /work/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: 'src/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: '/work/\u0000/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: '/work/\nx/a.ts' })).toBeUndefined()
  expect(touchedDirectory('Edit', {})).toBeUndefined()
  expect(touchedDirectory('Edit', { file_path: 42 })).toBeUndefined()
})

test('a call that has been "running" for over ten minutes is a leftover and is ignored', () => {
  const state = begin(begin(EMPTY_ACTIVITY, call('1', 'Bash npm test'), T0), call('2', 'Edit a.ts'), T0 + STALE_RUNNING_MS)
  expect(describeDoing(state, T0 + STALE_RUNNING_MS + 1)?.text).toBe('▶ Edit a.ts')
  expect(describeDoing(begin(EMPTY_ACTIVITY, call('1', 'Bash x', 'ag1'), T0), T0 + STALE_RUNNING_MS + 1)).toBeUndefined()
})
