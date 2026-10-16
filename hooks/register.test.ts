import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { sceneCells } from './compositor'
import { litWindows } from './layout'
import { WINDOWS } from './world'

test('TodoWrite puts done/total and percent on the status line', async ($, on) => {
  const clock = mock.clock(on)
  const lines: Array<string | undefined> = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { oldTodos: [], newTodos: [] },
  }))

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'a', status: 'completed', activeForm: 'A' },
      { content: 'b', status: 'in_progress', activeForm: 'B' },
    ],
  })

  expect(lines).toContain('tasks 1/2 · 50%')
})

test('TaskCreate then TaskUpdate completed gives 100%', async ($, on) => {
  const clock = mock.clock(on)
  const lines: Array<string | undefined> = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'TaskCreate' }, () => ({
    result: { task: { id: '1', subject: 'x' } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, () => ({
    result: { success: true, taskId: '1', updatedFields: ['status'] },
  }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  expect(lines).toContain('tasks 0/1 · 0%')
  expect(lines).toContain('tasks 1/1 · 100%')
})

test('the pane shows the progress header and the in-progress item', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { oldTodos: [], newTodos: [] },
  }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'first', status: 'completed', activeForm: 'F' },
      { content: 'second', status: 'in_progress', activeForm: 'S' },
    ],
  })

  const ui = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: {
      title: 'Task progress',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
    } as never,
    requestId: 'task-progress',
  })

  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 tasks/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /second/ })).toBeDefined()
  await ui.unmount()
})

test('the pane header shows elapsed time and an estimate', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { oldTodos: [], newTodos: [] },
  }))
  const todos = (done: number) => [
    { content: 'a', status: done > 0 ? 'completed' : 'in_progress', activeForm: 'A' },
    { content: 'b', status: 'pending', activeForm: 'B' },
  ] as const

  await $.tool.call({ tool: 'TodoWrite', todos: [...todos(0)] })
  await clock.advance(10 * 60_000)
  await $.tool.call({ tool: 'TodoWrite', todos: [...todos(1)] })

  const ui = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: {
      title: 'Task progress',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
    } as never,
    requestId: 'task-progress',
  })

  expect(await ui.find({ type: 'Text', text: /^10m · ~10m left$/ })).toBeDefined()
  await ui.unmount()
})

test('the progress tool fills the list and answers the model', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const lines: Array<string | undefined> = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })

  const ran = await $.tool.call({
    tool: 'mcp__task-progress__progress',
    tasks: [
      { subject: 'a', status: 'completed' },
      { subject: 'b', status: 'in_progress' },
      { subject: 'c', status: 'pending' },
    ],
  } as never)

  expect(lines).toContain('tasks 1/3 · 33%')
  // the engine validates a tool's result as string | array | undefined
  expect(ran.result).toBe('Progress updated: 1/3 done')
})

test('the progress tool refuses a malformed list', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))

  const ran = await $.tool.call({
    tool: 'mcp__task-progress__progress',
    tasks: [{ subject: 'a', status: 'bogus' }],
  } as never)

  expect(JSON.stringify(ran)).toContain('tasks must be an array')
})

const PANE_PROPS = { title: 'Task progress', isFocused: true, placement: 'dock' } as const
const HALF_DONE = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'in_progress', activeForm: 'B' },
] as const
const ALL_COMPLETED = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'completed', activeForm: 'B' },
] as const

test('the pane draws the citadel and lights windows as tasks finish', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  const ui = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })
  const cells = async () => (await ui.find({ type: 'Raster' }))?.props.cells
  expect(await cells()).toBe(sceneCells(96, 0, 16, 0))

  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })
  await ui.redraw()
  expect(await cells()).toBe(sceneCells(96, 0, 16, litWindows(1, 2, WINDOWS.length)))

  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_COMPLETED] })
  await ui.redraw()
  expect(await cells()).toBe(sceneCells(96, 0, 16, WINDOWS.length))

  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'c', status: 'pending', activeForm: 'C' }] })
  await ui.redraw()
  expect(await cells()).toBe(sceneCells(96, 0, 16, 0))
  await ui.unmount()
})

test('a narrow pane crops the scene around the centre, a short one crops its top', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const narrow = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 71, scroll: { bodyRows: 35 } } as never,
    requestId: 'task-progress',
  })
  expect((await narrow.find({ type: 'Raster' }))?.props.cells).toBe(sceneCells(69, 0, 16, 0))
  await narrow.unmount()

  const short = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 24 } } as never,
    requestId: 'task-progress',
  })
  expect((await short.find({ type: 'Raster' }))?.props.cells).toBe(sceneCells(96, 7, 9, 0))
  await short.unmount()
})

test('a pane that reports no height counts as 40 rows, and only a terminal gets the scene', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const terminal = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98 } as never,
    requestId: 'task-progress',
  })
  expect((await terminal.find({ type: 'Raster' }))?.props.cells).toBe(sceneCells(96, 0, 16, 0))
  await terminal.unmount()

  const desktop = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'desktop',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })
  expect(await desktop.find({ type: 'Raster' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
  await desktop.unmount()
})

test('a pane too small for the scene shows the text layout alone', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })
  for (const props of [
    { bodyColumns: 98, scroll: { bodyRows: 22 } },
    { bodyColumns: 17, scroll: { bodyRows: 40 } },
  ]) {
    const ui = await $.ui.mount({
      plugin: 'task-progress',
      surface: 'terminal',
      component: 'Pane',
      props: { ...PANE_PROPS, ...props } as never,
      requestId: 'task-progress',
    })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1\/2 tasks/ })).toBeDefined()
    await ui.unmount()
  }
})

const SUBAGENT = 'agent-1'
const STALE_CALLS = 10
const PROGRESS = 'mcp__task-progress__progress'

const mountPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })

test('the system prompt tells the model to keep the progress list current', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const input = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [PROGRESS], outputStyle: null, traits: [] }
  const { sections } = await $.prompt.compose(input as never)
  expect(sections[0]?.id).toBe('intro')
  const section = sections.find(s => s.id === 'task-progress:usage')
  expect(section).toBeDefined()
  expect(section?.scope).toBe('session')
  expect(section?.text.includes(PROGRESS)).toBe(true)
  expect(section?.text.includes('never merge')).toBe(true)
  expect(section?.text.includes('never rename')).toBe(true)
})

test('a subagent never rewrites the pane list', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  const ui = await mountPane($)

  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE], agentId: SUBAGENT } as never)
  const ack = await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'x', status: 'pending' }], agentId: SUBAGENT } as never)
  expect(typeof ack.result).toBe('string')
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()

  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })
  expect(await ui.find({ type: 'Text', text: /1\/2 tasks/ })).toBeDefined()
  await ui.unmount()
})

test('the pane warns when many tool calls pass without a progress update', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  const ui = await mountPane($)
  const reads = async (count: number, agentId?: string) => {
    for (let i = 0; i < count; i += 1) await $.tool.call({ tool: 'Read', file_path: '/x', agentId } as never)
  }
  const warning = () => ui.find({ type: 'Text', text: /no update for/ })
  const plan = (statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
    $.tool.call({ tool: PROGRESS, tasks: statuses.map((status, i) => ({ subject: `t${i}`, status })) } as never)

  await plan(['in_progress', 'pending'])
  await reads(STALE_CALLS - 1)
  expect(await warning()).toBeUndefined()
  await reads(1)
  expect(await ui.find({ type: 'Text', text: /no update for 10 tool calls/ })).toBeDefined()

  await plan(['completed', 'in_progress'])
  expect(await warning()).toBeUndefined()

  await reads(STALE_CALLS + 2, SUBAGENT)
  expect(await warning()).toBeUndefined()

  await plan(['completed', 'completed'])
  await reads(STALE_CALLS + 2)
  expect(await warning()).toBeUndefined()
  await ui.unmount()
})

const HOME = '/home/me'
const ROOT = `${HOME}/.claude`
const SELF = 'me-1'

type Disk = { files: Map<string, string>; mtimes: Map<string, number>; removed: string[]; played: string[][]; chmods: string[][]; sessionId: string; isChmodBroken: boolean; isBroken: boolean; put: (path: string, text: string, mtimeMs?: number) => void }

const NOW = 1_700_000_000_000
const POLL_MS = 3000

/** The world beneath the plugin for the multi-session feature: an environment, a session id, a small disk of text files. */
function mockDisk(on: On, env: Record<string, string> = { HOME }): Disk {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const disk: Disk = {
    files,
    mtimes,
    removed: [],
    played: [],
    chmods: [],
    sessionId: SELF,
    isChmodBroken: false,
    isBroken: false,
    put: (path, text, mtimeMs = NOW) => {
      files.set(path, text)
      mtimes.set(path, mtimeMs)
    },
  }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: disk.sessionId }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.write', (_$, e) => {
    disk.put(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: text }
  })
  on('fs.list', (_$, e) => {
    if (disk.isBroken) throw new Error('EIO')
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = [...files.keys()].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
    // A hook that throws reaches the plugin as "no implementation" (the text is lost), so a missing directory is an empty list here.

    return { value: names.map(path => ({ name: path.slice(dir.length), kind: 'file' as const, size: 0, mtimeMs: mtimes.get(path) ?? 0, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') {
      const path = e.argv.at(-1) ?? ''
      disk.removed.push(path)
      files.delete(path)
    } else if (e.argv[0] === 'chmod') {
      disk.chmods.push([...e.argv])
      if (disk.isChmodBroken) throw new Error('operation not permitted')
    } else {
      disk.played.push([...e.argv])
    }

    return { value: OK_RUN }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))

  return disk
}

const boot = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const OWN_FILE = `${ROOT}/task-progress/${SELF}.json`

test('a list change publishes this session\'s progress as a small file of its own', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))

  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })

  const record = JSON.parse(disk.files.get(OWN_FILE) ?? '{}')
  expect(record).toEqual({ v: 1, sessionId: SELF, done: 1, total: 2, current: 'b', updatedAt: 1_700_000_000_000 })
})

test('the progress tool publishes too, and CLAUDE_CONFIG_DIR moves the files', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on, { HOME, CLAUDE_CONFIG_DIR: '/cfg' })

  await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'x', status: 'pending' }] } as never)

  expect(disk.files.has(`/cfg/task-progress/${SELF}.json`)).toBe(true)
  expect(disk.files.has(OWN_FILE)).toBe(false)
})

test('a failing disk never breaks the tool result', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: SELF }))
  on('fs.write', () => {
    throw new Error('read-only file system')
  })

  const ran = await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'x', status: 'pending' }] } as never)

  expect(ran.result).toBe('Progress updated: 0/1 done')
})

test('the session start publishes an empty record so the session shows up', async ($, on) => {
  mock.clock(on, { now: NOW })
  const disk = mockDisk(on)

  await boot($)

  const record = JSON.parse(disk.files.get(OWN_FILE) ?? '{}')
  expect(record.total).toBe(0)
  expect(record.sessionId).toBe(SELF)
})

test('the session end removes the record of the session that ended', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  const disk = mockDisk(on)

  await $.session.end({ reason: 'other', sessionId: 'old-7', resume: {} } as never)

  expect(disk.removed).toEqual([`${ROOT}/task-progress/old-7.json`])
})

test('the progress directory is made private once, and a failing chmod breaks nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const disk = mockDisk(on)
  disk.isChmodBroken = true
  const call = (subject: string) => $.tool.call({ tool: PROGRESS, tasks: [{ subject, status: 'pending' }] } as never)

  const first = await call('x')
  const second = await call('y')

  expect(disk.chmods).toEqual([['chmod', '700', `${ROOT}/task-progress`]])
  expect(first.result).toBe('Progress updated: 0/1 done')
  expect(second.result).toBe('Progress updated: 0/1 done')
  expect(disk.played).toEqual([])
})

test('after /clear the session id changes and the next poll publishes the list under the new id', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  await boot($)
  await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'a', status: 'completed' }, { subject: 'b', status: 'in_progress' }] } as never)
  expect(disk.files.has(`${ROOT}/task-progress/me-2.json`)).toBe(false)

  disk.sessionId = 'me-2'
  await clock.advance(POLL_MS)

  const record = JSON.parse(disk.files.get(`${ROOT}/task-progress/me-2.json`) ?? '{}')
  expect(record).toMatchObject({ sessionId: 'me-2', done: 1, total: 2, current: 'b' })
})

const MIN = 60_000
const DAY = 24 * 60 * MIN

const registryFile = (over: Record<string, unknown>): string =>
  JSON.stringify({ pid: 100, sessionId: 'x', name: 'x', kind: 'interactive', status: 'busy', statusUpdatedAt: NOW, startedAt: NOW - MIN, ...over })
const recordFile = (over: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, sessionId: 'x', done: 1, total: 4, current: 'working', updatedAt: NOW, ...over })

/** Two other sessions: `alpha` has waited 4 minutes and made 2 of 5, `beta` is busy with no mod installed. */
function putOthers(disk: Disk): void {
  disk.put(`${ROOT}/sessions/1.json`, registryFile({ pid: 1, sessionId: SELF, name: 'me' }))
  disk.put(`${ROOT}/sessions/2.json`, registryFile({ pid: 2, sessionId: 'a-2', name: 'alpha', status: 'idle', statusUpdatedAt: NOW - 4 * MIN }))
  disk.put(`${ROOT}/sessions/3.json`, registryFile({ pid: 3, sessionId: 'b-3', name: 'beta', status: 'busy' }))
  disk.put(`${ROOT}/task-progress/a-2.json`, recordFile({ sessionId: 'a-2', done: 2, total: 5, current: 'reviewing' }))
}

const mountOverview = ($: Engine) =>
  $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })

test('the pane lists the other sessions: who waits, how far each got, what a busy one does', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chờ bạn 4m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\bme\b/ })).toBeUndefined()
  await ui.unmount()
})

test('a session that ends disappears at the next poll, and with no others there is no block', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()

  disk.files.delete(`${ROOT}/sessions/2.json`)
  disk.files.delete(`${ROOT}/sessions/3.json`)
  await clock.advance(POLL_MS)

  expect(await ui.find({ type: 'Text', text: /alpha|beta/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /chờ bạn/ })).toBeUndefined()
  await ui.unmount()
})

test('a record of a dead session is removed after a day, a younger one and a live one are kept', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  disk.put(`${ROOT}/task-progress/old-9.json`, recordFile({ sessionId: 'old-9' }), NOW - 2 * DAY)
  disk.put(`${ROOT}/task-progress/new-8.json`, recordFile({ sessionId: 'new-8' }), NOW - 5 * MIN)
  await boot($)
  await clock.settle()

  expect(disk.removed).toEqual([`${ROOT}/task-progress/old-9.json`])
})

test('valid sessions still show among junk files, a junk record counts as state only', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const disk = mockDisk(on)
  disk.put(`${ROOT}/sessions/1.json`, '{"pid":')
  disk.put(`${ROOT}/sessions/2.json`, 'not json at all')
  disk.put(`${ROOT}/sessions/3.json`, registryFile({ pid: 3, sessionId: 'b-3', name: 'beta', status: 'busy' }))
  disk.put(`${ROOT}/task-progress/b-3.json`, '[]')
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\d\/\d/ })).toBeUndefined()
  await ui.unmount()
})

test('a broken disk at a poll keeps the rows already shown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()

  disk.isBroken = true
  await clock.advance(POLL_MS)

  expect(await ui.find({ type: 'Text', text: /alpha/ })).toBeDefined()
  await ui.unmount()
})

test('no record is removed from a capped or partly unreadable registry', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const capped = mockDisk(on)
  for (let i = 0; i < 13; i += 1) capped.put(`${ROOT}/sessions/${i}.json`, registryFile({ pid: 100 + i, sessionId: `s-${i}`, name: `sess${i}` }))
  capped.put(`${ROOT}/task-progress/s-12.json`, recordFile({ sessionId: 's-12' }), NOW - 2 * DAY)
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /\+7 more/ })).toBeDefined()
  expect(capped.removed).toEqual([])
  await ui.unmount()
})

test('a junk registry file stops the pruning of old records', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const disk = mockDisk(on)
  disk.put(`${ROOT}/sessions/1.json`, 'not json at all')
  disk.put(`${ROOT}/task-progress/old-9.json`, recordFile({ sessionId: 'old-9' }), NOW - 2 * DAY)
  disk.put(`${ROOT}/sessions/3.json`, registryFile({ pid: 3, sessionId: 'b-3', name: 'beta', status: 'busy' }))
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
  expect(disk.removed).toEqual([])
  await ui.unmount()
})

test('at most 5 old records are removed per poll, the rest at the next one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  for (let i = 0; i < 8; i += 1) disk.put(`${ROOT}/task-progress/old-${i}.json`, recordFile({ sessionId: `old-${i}` }), NOW - 2 * DAY)
  await boot($)
  await clock.settle()
  expect(disk.removed.length).toBe(5)

  await clock.advance(POLL_MS)
  expect(disk.removed.length).toBe(8)
})

test('without a progress directory the sessions still show, with state only', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  disk.put(`${ROOT}/sessions/3.json`, registryFile({ pid: 3, sessionId: 'b-3', name: 'beta', status: 'busy' }))
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\d\/\d/ })).toBeUndefined()
  await ui.unmount()
})

test('only 12 sessions are read and 5 shown, the rest are counted', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const disk = mockDisk(on)
  for (let i = 0; i < 15; i += 1) disk.put(`${ROOT}/sessions/${i}.json`, registryFile({ pid: 100 + i, sessionId: `s-${i}`, name: `sess${i}` }))
  await boot($)
  const ui = await mountOverview($)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /\+7 more/ })).toBeDefined()
  await ui.unmount()
})

const setStatus = (disk: Disk, name: string, status: string): void =>
  disk.put(`${ROOT}/sessions/2.json`, registryFile({ pid: 2, sessionId: 'a-2', name, status, statusUpdatedAt: NOW }))

test('a session that goes from busy to idle raises one toast, the first poll none', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const disk = mockDisk(on)
  setStatus(disk, 'alpha', 'idle')
  await boot($)
  await clock.settle()
  expect(toasts).toEqual([])

  setStatus(disk, 'alpha', 'busy')
  await clock.advance(POLL_MS)
  expect(toasts).toEqual([])

  setStatus(disk, 'alpha', 'idle')
  await clock.advance(POLL_MS)
  expect(toasts).toEqual(['◆ alpha waiting for you'])

  await clock.advance(POLL_MS * 3)
  expect(toasts.length).toBe(1)
  expect(disk.played).toEqual([])
})

test('the jingle also plays for a waiting session when the option is on', { options: { isWaitSoundOn: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const disk = mockDisk(on)
  setStatus(disk, 'alpha', 'busy')
  await boot($)
  await clock.settle()
  expect(disk.played).toEqual([])

  setStatus(disk, 'alpha', 'idle')
  await clock.advance(POLL_MS)
  await clock.settle()

  expect(disk.played.length).toBe(1)
})

test('a toast that fails never breaks the poll: the jingle still plays', { options: { isWaitSoundOn: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => {
    throw new Error('no surface')
  })
  const disk = mockDisk(on)
  setStatus(disk, 'alpha', 'busy')
  await boot($)
  await clock.settle()
  setStatus(disk, 'alpha', 'idle')
  await clock.advance(POLL_MS)
  await clock.settle()
  const ui = await mountOverview($)

  expect(await ui.find({ type: 'Text', text: /chờ bạn/ })).toBeDefined()
  expect(disk.played.length).toBe(1)
  await ui.unmount()
})

test('the tell command sends the message to the one session that matches', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const sent: Array<{ to: string; text: string }> = []
  on('session.send', (_$, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  await clock.settle()

  const ran = await $.command.run({ command: 'task-progress-tell', args: 'alp please review the diff' } as never)

  expect(sent).toEqual([{ to: 'a-2', text: 'please review the diff' }])
  expect(ran.text).toBe('Sent to alpha.')
})

test('the tell command explains itself when it cannot send', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: false, reason: 'the recipient is gone' }))
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  await clock.settle()
  const tell = async (args: string) => (await $.command.run({ command: 'task-progress-tell', args } as never)).text

  expect(await tell('')).toBe('Usage: /task-progress-tell <session name> <message>')
  expect(await tell('alpha')).toBe('Usage: /task-progress-tell <session name> <message>')
  expect(await tell('zzz hello')).toBe('no session starts with "zzz"')
  expect(await tell('alpha hello')).toBe('Not delivered to alpha: the recipient is gone')
})

test('the tell command reports a send that throws', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('session.send', () => {
    throw new Error('socket closed')
  })
  const disk = mockDisk(on)
  putOthers(disk)
  await boot($)
  await clock.settle()

  const ran = await $.command.run({ command: 'task-progress-tell', args: 'alpha hello' } as never)

  expect(ran.text).toMatch(/^Not delivered to alpha:/)
})

/** The jingle starts unawaited (it must not hold up the tool result): let it run before asserting. */
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  for (let i = 0; i < 20; i += 1) await clock.advance(0)
}

const OK_RUN = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

const ALL_DONE = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'completed', activeForm: 'B' },
] as const
const NOT_DONE = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'in_progress', activeForm: 'B' },
] as const

test('the jingle plays once when every task is done, falling back past a missing player', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const played: string[][] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('process.run', (_$, e) => {
    played.push([...e.argv])
    if (e.argv[0] === 'afplay') throw new Error('not installed')

    return { value: OK_RUN }
  })

  await $.tool.call({ tool: 'TodoWrite', todos: [...NOT_DONE] })
  await settle(clock)
  expect(played).toHaveLength(0)

  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_DONE] })
  await settle(clock)
  expect(played.map(argv => argv[0])).toEqual(['afplay', 'pw-play'])
  expect(played[1]?.at(-1)).toMatch(/sounds\/done\.wav$/)

  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_DONE] })
  await settle(clock)
  expect(played).toHaveLength(2)

  await $.tool.call({ tool: 'TodoWrite', todos: [...NOT_DONE] })
  await settle(clock)
  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_DONE] })
  await settle(clock)
  expect(played).toHaveLength(4)
})

test('no sound when the option is off', { options: { isSoundOn: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  let calls = 0
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('process.run', () => {
    calls += 1

    return { value: OK_RUN }
  })

  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_DONE] })
  await settle(clock)
  expect(calls).toBe(0)
})

test('own sound file is played when set', { options: { soundFile: '/home/me/song.mp3' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const files: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  on('process.run', (_$, e) => {
    files.push(e.argv.at(-1) ?? '')

    return { value: OK_RUN }
  })

  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_DONE] })
  await settle(clock)
  expect(files).toEqual(['/home/me/song.mp3'])
})
