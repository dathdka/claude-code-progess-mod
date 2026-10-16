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

type Disk = { files: Map<string, string>; mtimes: Map<string, number>; removed: string[]; played: string[][]; git: string[][]; gitGate: Promise<void> | undefined; gitReply: (argv: readonly string[]) => { exitCode: number; stdout: string; isStdoutTruncated?: boolean }; chmods: string[][]; sessionId: string; isChmodBroken: boolean; isBroken: boolean; put: (path: string, text: string, mtimeMs?: number) => void }

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
    git: [],
    gitGate: undefined,
    gitReply: () => ({ exitCode: 128, stdout: '' }),
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
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'rm') {
      const path = e.argv.at(-1) ?? ''
      disk.removed.push(path)
      files.delete(path)
    } else if (e.argv[0] === 'chmod') {
      disk.chmods.push([...e.argv])
      if (disk.isChmodBroken) throw new Error('operation not permitted')
    } else if (e.argv[0] === 'git') {
      disk.git.push([...e.argv])
      await disk.gitGate
      const reply = disk.gitReply(e.argv)

      return { value: { ...OK_RUN, ...reply } }
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

const USAGE_MS = 5000
const MINUTE = 60_000

const gaugeUsage = (context: number, five = 31, resetsAt?: string) => ({
  startedAt: NOW,
  context: { tokens: context * 10_000, window: 1_000_000, percent: context },
  rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt }, { kind: 'seven_day', percentUsed: 9 }],
  cost: { usd: 0.1 },
})

/** `session.usage` answers with `current.value`; undefined makes it fail like a broken engine would. */
function mockUsage(on: On, current: { value: unknown }): void {
  on('session.usage', () => {
    if (current.value === undefined) throw new Error('no usage')

    return { value: current.value as never }
  })
}

test('the strip shows the context and both quota windows from the session usage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(62) })
  await boot($)
  await clock.settle()
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /31%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /7d/ })).toBeDefined()
  await ui.unmount()
})

test('without a usage reading the pane has no gauges line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  await boot($)
  await clock.settle()
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('a failing usage read keeps the gauges for 30 seconds, then hides them', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  const usage: { value: unknown } = { value: gaugeUsage(62) }
  mockUsage(on, usage)
  await boot($)
  await clock.settle()
  usage.value = undefined

  await clock.advance(25_000)
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(10_000)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeUndefined()
  await ui.unmount()
})

test('the context toast fires once per crossing of 80% and again after a dip below 70%', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mockDisk(on)
  const usage: { value: unknown } = { value: gaugeUsage(62) }
  mockUsage(on, usage)
  await boot($)
  await clock.settle()
  for (const percent of [82, 85, 75, 65, 81]) {
    usage.value = gaugeUsage(percent)
    await clock.advance(USAGE_MS)
  }

  expect(toasts).toEqual(['ctx 82% · consider /compact', 'ctx 81% · consider /compact'])
})

test('a quota window at 90% toasts once per window, with its reset time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mockDisk(on)
  const usage: { value: unknown } = { value: gaugeUsage(10, 91, new Date(NOW + 40 * MINUTE).toISOString()) }
  mockUsage(on, usage)
  await boot($)
  await clock.settle()
  await clock.advance(USAGE_MS)
  expect(toasts).toEqual(['5h limit 91% · resets in 40m'])

  usage.value = gaugeUsage(10, 92, new Date(NOW + 300 * MINUTE).toISOString())
  await clock.advance(USAGE_MS)
  expect(toasts).toEqual(['5h limit 91% · resets in 40m', '5h limit 92% · resets in 5h00m'])
})

test('the toasts can be turned off', { options: { isContextWarningOn: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(95, 95) })
  await boot($)
  await clock.settle()
  await clock.advance(USAGE_MS * 2)

  expect(toasts).toEqual([])
})

test('a toast that fails never breaks the usage read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => {
    throw new Error('no terminal')
  })
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(95) })
  await boot($)
  await clock.settle()
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /95%/ })).toBeDefined()
  await ui.unmount()
})

test('a short pane drops strip lines from the bottom but keeps a task row', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  mockDisk(on)
  mockUsage(on, { value: gaugeUsage(62) })
  await boot($)
  await clock.settle()
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'only task', status: 'in_progress', activeForm: 'O' }] })
  const ui = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 8 } } as never,
    requestId: 'task-progress',
  })

  expect(await ui.find({ type: 'Text', text: /only task/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

const activitySetup = async ($: Engine, on: On) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  mockDisk(on)
  await boot($)
  await clock.settle()

  return clock
}

test('while a tool runs the pane names it, afterwards it reads as the last call', async ($, on) => {
  let ui: Awaited<ReturnType<typeof mountPane>> | undefined
  let whileRunning: unknown
  on('tool.call', { tool: 'Edit' }, async () => {
    whileRunning = await ui?.find({ type: 'Text', text: /▶ Edit register\.tsx/ })

    return { result: 'ok' }
  })
  await activitySetup($, on)
  ui = await mountPane($)

  await $.tool.call({ tool: 'Edit', file_path: '/x/register.tsx', old_string: 'a', new_string: 'b' } as never)

  expect(whileRunning).toBeDefined()
  await ui.unmount()
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /· Edit register\.tsx 0s ago/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeUndefined()
  await ui.unmount()
})

test('the list tools never show as activity', async ($, on) => {
  await activitySetup($, on)
  await $.tool.call({ tool: PROGRESS, tasks: [{ subject: 'a', status: 'in_progress' }] } as never)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /progress/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent call counts as an agent and never as the main line', async ($, on) => {
  let ui: Awaited<ReturnType<typeof mountPane>> | undefined
  let seen: unknown
  on('tool.call', { tool: 'Read' }, async () => {
    seen = await ui?.find({ type: 'Text', text: /\+1 agent/ })

    return { result: 'ok' }
  })
  const clock = await activitySetup($, on)
  ui = await mountPane($)

  await $.tool.call({ tool: 'Read', file_path: '/x/a.ts', agentId: SUBAGENT } as never)
  expect(seen).toBeDefined()
  await ui.unmount()

  let again = await mountPane($)
  expect(await again.find({ type: 'Text', text: /\+1 agent/ })).toBeDefined()
  expect(await again.find({ type: 'Text', text: /Read a\.ts/ })).toBeUndefined()
  await again.unmount()

  await clock.advance(20_000)
  again = await mountPane($)
  expect(await again.find({ type: 'Text', text: /agent/ })).toBeUndefined()
  await again.unmount()
})

test('the hook leaves the result alone, and a tool that throws leaves no running line and is not run twice', async ($, on) => {
  let runs = 0
  on('tool.call', { tool: 'Bash' }, () => {
    runs += 1
    throw new Error('boom')
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: 'same' }))
  await activitySetup($, on)

  expect(await $.tool.call({ tool: 'Read', file_path: '/x/a.ts' } as never)).toEqual({ result: 'same' })
  let failed = false
  try {
    await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  } catch {
    failed = true
  }
  const ui = await mountPane($)

  expect(failed).toBe(true)
  expect(runs).toBe(1)
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeUndefined()
  await ui.unmount()
})

/** A git world: each directory prefix maps to a repository root, each root to its `status -b` text. */
function gitWorld(disk: Disk, roots: Record<string, string>, statuses: Record<string, string>) {
  disk.gitReply = argv => {
    if (argv.includes('rev-parse')) {
      const dir = argv[2] ?? ''
      const root = Object.keys(roots).find(prefix => dir === prefix || dir.startsWith(`${prefix}/`))

      return root === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `${root}\n` }
    }
    const root = argv[argv.indexOf('-C') + 1] ?? ''

    return { exitCode: 0, stdout: statuses[root] ?? '' }
  }
}

/** The clock of the running repository test: repository tracking runs after the edit's result, so edits wait for it to settle. */
let repoClock: { settle: () => Promise<void> } | undefined

const edit = async ($: Engine, path: string, agentId?: string) => {
  const ran = await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', agentId } as never)
  await repoClock?.settle()

  return ran
}

async function repoSetup($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  const disk = mockDisk(on)
  await boot($)
  await clock.settle()
  repoClock = clock

  return { clock, disk }
}

const GIT_POLL_MS = 10_000

test('editing a file in a repository shows its branch, changed files and distance from the upstream', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## dev-x...origin/dev-x [ahead 2]\n M a.ts\n?? b.ts\n' })

  await edit($, '/w/svc-a/src/x.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /dev-x/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑2/ })).toBeDefined()
  expect(disk.git).toEqual([
    ['git', '-C', '/w/svc-a/src', 'rev-parse', '--show-toplevel'],
    ['git', '--no-optional-locks', '-C', '/w/svc-a', 'status', '--porcelain', '-b'],
  ])
  await ui.unmount()
})

test('a clean repository shows a tick', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main...origin/main\n' })
  await edit($, '/w/svc-a/a.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
  await ui.unmount()
})

test('reads, shell commands, relative paths and files outside any repository start no repository tracking', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n' })

  await $.tool.call({ tool: 'Read', file_path: '/w/svc-a/a.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'sed -i x /w/svc-a/a.ts' } as never)
  await edit($, 'src/relative.ts')
  expect(disk.git).toEqual([])

  await edit($, '/tmp/elsewhere/x.ts')
  const ui = await mountPane($)
  expect(disk.git.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /⎇/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent edit counts, a second edit in the same directory resolves the root once', async ($, on) => {
  const { disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })

  await edit($, '/w/svc-a/src/a.ts', SUBAGENT)
  await edit($, '/w/svc-a/src/b.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  expect(disk.git.filter(argv => argv.includes('rev-parse')).length).toBe(1)
  await ui.unmount()
})

test('a second repository adds a line, four make two lines and a count', async ($, on) => {
  const { disk } = await repoSetup($, on)
  const roots = Object.fromEntries(['a', 'b', 'c', 'd'].map(n => [`/w/svc-${n}`, `/w/svc-${n}`]))
  gitWorld(disk, roots, Object.fromEntries(Object.keys(roots).map(root => [root, '## main\n M x\n'])))

  await edit($, '/w/svc-a/x.ts')
  await edit($, '/w/svc-b/x.ts')
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-b/ })).toBeDefined()
  await ui.unmount()

  await edit($, '/w/svc-c/x.ts')
  await edit($, '/w/svc-d/x.ts')
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-c/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\+2 repos/ })).toBeDefined()
  await ui.unmount()
})

test('the status is read again every 10 seconds', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  const statuses: Record<string, string> = { '/w/svc-a': '## main\n M a\n' }
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, statuses)
  await edit($, '/w/svc-a/a.ts')

  statuses['/w/svc-a'] = '## main\n M a\n M b\n M c\n'
  await clock.advance(GIT_POLL_MS)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /●3/ })).toBeDefined()
  await ui.unmount()
})

test('a truncated status is skipped and the last reading stays', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })
  await edit($, '/w/svc-a/a.ts')
  const reply = disk.gitReply
  disk.gitReply = argv => (argv.includes('status') ? { exitCode: 0, stdout: '## main\n', isStdoutTruncated: true } : reply(argv))
  await clock.advance(GIT_POLL_MS)
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /●1/ })).toBeDefined()
  await ui.unmount()
})

test('a repository whose status fails three polls in a row is dropped, a failure in between is forgiven', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })
  await edit($, '/w/svc-a/a.ts')
  const good = disk.gitReply
  disk.gitReply = argv => (argv.includes('status') ? { exitCode: 128, stdout: '' } : good(argv))

  await clock.advance(GIT_POLL_MS * 2)
  let ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  await ui.unmount()

  disk.gitReply = good
  await clock.advance(GIT_POLL_MS)
  disk.gitReply = argv => (argv.includes('status') ? { exitCode: 128, stdout: '' } : good(argv))
  await clock.advance(GIT_POLL_MS * 2)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(GIT_POLL_MS)
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeUndefined()
  await ui.unmount()
})

test('git failing or missing never breaks the edit, and a failed root lookup is retried at the next edit', async ($, on) => {
  const { disk } = await repoSetup($, on)
  disk.gitReply = () => {
    throw new Error('spawn git ENOENT')
  }

  expect(await edit($, '/w/svc-a/a.ts')).toEqual({ result: 'ok' })
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n M a\n' })
  await edit($, '/w/svc-a/a.ts')
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: /svc-a/ })).toBeDefined()
  await ui.unmount()
})

test('a failing Edit does not make its directory a touched repository', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'nope', isError: true }))
  const disk = mockDisk(on)
  await boot($)
  await clock.settle()
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n' })
  await edit($, '/w/svc-a/a.ts')

  expect(disk.git).toEqual([])
})

test('a slow git never delays the result of an Edit', async ($, on) => {
  const { clock, disk } = await repoSetup($, on)
  repoClock = undefined
  gitWorld(disk, { '/w/svc-a': '/w/svc-a' }, { '/w/svc-a': '## main\n' })
  let release: () => void = () => undefined
  disk.gitGate = new Promise<void>(resolve => {
    release = resolve
  })
  let isDone = false
  const pending = $.tool.call({ tool: 'Edit', file_path: '/w/svc-a/a.ts', old_string: 'a', new_string: 'b' } as never).then(() => {
    isDone = true
  })
  await clock.settle()
  const wasDone = isDone
  release()
  await pending

  expect(wasDone).toBe(true)
})

const PLAN_PATH = '/w/docs/plans/demo.md'
const PLAN_TEXT = `# Demo plan

## Phase 1: Base
### Task 1: A
- [x] a1
- [x] a2
### Task 2: B
- [ ] b1

## Phase 2: Next
### Task 3: C
- [ ] c1
`

async function planSetup($: Engine, on: On, text = PLAN_TEXT) {
  const clock = mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Write' }, () => ({ result: 'ok' }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  const disk = mockDisk(on)
  disk.put(PLAN_PATH, text)
  await boot($)
  await clock.settle()

  return { clock, disk }
}

const readPlan = async ($: Engine, clock: { settle: () => Promise<void> }) => {
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH } as never)
  await clock.settle()
}

test('there is no plan button until the session touches a plan file', async ($, on) => {
  const { clock } = await planSetup($, on)
  await $.tool.call({ tool: 'Read', file_path: '/w/docs/notes.md' } as never)
  await clock.settle()
  let ui = await mountPane($)
  expect(await ui.find({ key: 'plan-toggle' })).toBeUndefined()
  await ui.unmount()

  await readPlan($, clock)
  ui = await mountPane($)
  expect(await ui.find({ key: 'plan-toggle' })).toBeDefined()
  await ui.unmount()
})

test('pressing Plan shows the phases and the focused phase, pressing Todo goes back', async ($, on) => {
  const { clock } = await planSetup($, on)
  await readPlan($, clock)
  const ui = await mountPane($)

  await ui.press({ key: 'plan-toggle' })
  expect(await ui.find({ type: 'Text', text: /Phase 1: Base/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Phase 2: Next/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Task 2: B/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeUndefined()

  await ui.press({ key: 'plan-toggle' })
  expect(await ui.find({ type: 'Text', text: /Phase 1: Base/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
  await ui.unmount()
})

test('a completed todo "Task N" marks the plan task done', async ($, on) => {
  const { clock } = await planSetup($, on)
  await readPlan($, clock)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Task 2: B', status: 'completed', activeForm: 'B' }] } as never)
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })

  expect(await ui.find({ type: 'Text', text: /① Phase 1: Base +✔ 2\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /② Phase 2: Next +▶ 0\/1/ })).toBeDefined()
  await ui.unmount()
})

test('the plan file is read again every 5 seconds and when the session writes it', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await readPlan($, clock)
  disk.put(PLAN_PATH, PLAN_TEXT.replace('- [ ] b1', '- [x] b1'))
  await clock.advance(5000)
  let ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })
  expect(await ui.find({ type: 'Text', text: /① Phase 1: Base +✔ 2\/2/ })).toBeDefined()
  await ui.unmount()

  disk.put(PLAN_PATH, PLAN_TEXT.replace('- [ ] c1', '- [x] c1'))
  await $.tool.call({ tool: 'Edit', file_path: PLAN_PATH, old_string: 'a', new_string: 'b' } as never)
  await clock.settle()
  ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /② Phase 2: Next +✔ 1\/1/ })).toBeDefined()
  await ui.unmount()
})

test('a plan file that vanishes or turns to junk keeps the last plan', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await readPlan($, clock)
  disk.files.delete(PLAN_PATH)
  await clock.advance(5000)
  disk.put(PLAN_PATH, 'no tasks here\n')
  await clock.advance(5000)
  let ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })
  expect(await ui.find({ type: 'Text', text: /Phase 1: Base/ })).toBeDefined()
  await ui.unmount()

  disk.put(PLAN_PATH, PLAN_TEXT.replace('- [ ] b1', '- [x] b1'))
  await clock.advance(5000)
  ui = await mountPane($)
  // the view stays on Plan across mounts
  expect(await ui.find({ type: 'Text', text: /① Phase 1: Base +✔ 2\/2/ })).toBeDefined()
  await ui.unmount()
})

const FIVE_PLAN = `# Five plan

${[1, 2, 3, 4, 5].map(n => `## Phase ${n}: P${n}\n### Task ${n}: t${n}\n- [ ] x${n}\n- [ ] y${n}\n`).join('\n')}`

const mountPlanPane = ($: Engine, bodyRows: number) =>
  $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows } } as never,
    requestId: 'task-progress',
  })

const textsOf = async (ui: Awaited<ReturnType<typeof mountPlanPane>>, text: RegExp) =>
  (await ui.findAll({ type: 'Text', text })).length

test('a short pane shows the plan view with its focus header and a task row at least', async ($, on) => {
  const { clock } = await planSetup($, on)
  await readPlan($, clock)
  const ui = await mountPlanPane($, 12)
  await ui.press({ key: 'plan-toggle' })

  expect(await ui.find({ type: 'Text', text: /Task 2: B/ })).toBeDefined()
  expect(await textsOf(ui, /^① Phase 1: Base +$/)).toBe(1)
  expect(await textsOf(ui, /^[①②] Phase [12]: /)).toBe(3)
  await ui.unmount()
})

test('a 35-row pane with a scene and a 3-line strip lists all five phases', async ($, on) => {
  const { clock, disk } = await planSetup($, on, FIVE_PLAN)
  gitWorld(disk, { '/w/svc-a': '/w/svc-a', '/w/svc-b': '/w/svc-b' }, { '/w/svc-a': '## main\n', '/w/svc-b': '## main\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/svc-a/a.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.settle()
  await $.tool.call({ tool: 'Edit', file_path: '/w/svc-b/a.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.settle()
  await readPlan($, clock)
  const ui = await mountPlanPane($, 35)
  await ui.press({ key: 'plan-toggle' })

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /svc-b/ })).toBeDefined()
  for (const n of [1, 2, 3, 4, 5]) expect(await ui.find({ type: 'Text', text: new RegExp(`Phase ${n}: P${n}`) })).toBeDefined()
  await ui.unmount()
})

test('the toggle label flips between Plan and Todo', async ($, on) => {
  const { clock } = await planSetup($, on)
  await readPlan($, clock)
  const ui = await mountPane($)
  expect((await ui.find({ key: 'plan-toggle' }))?.props.label).toBe('Plan')
  await ui.press({ key: 'plan-toggle' })
  expect((await ui.find({ key: 'plan-toggle' }))?.props.label).toBe('Todo')
  await ui.unmount()
})

test('the focus buttons move one phase per press and stay inside the plan', async ($, on) => {
  const { clock } = await planSetup($, on, FIVE_PLAN)
  await readPlan($, clock)
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })
  const header = (n: string) => textsOf(ui, new RegExp(`^${n} Phase ${'①②③④⑤'.indexOf(n) + 1}: P[0-9] +$`))

  await ui.press({ key: 'plan-next' })
  await ui.press({ key: 'plan-next' })
  expect(await header('③')).toBe(1)
  for (let i = 0; i < 6; i += 1) await ui.press({ key: 'plan-next' })
  expect(await header('⑤')).toBe(1)
  for (let i = 0; i < 8; i += 1) await ui.press({ key: 'plan-prev' })
  expect(await header('①')).toBe(1)
  await ui.unmount()
})

test('a Write on the plan file reads it again at once', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await readPlan($, clock)
  disk.put(PLAN_PATH, PLAN_TEXT.replace('- [ ] c1', '- [x] c1'))
  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: 'x' } as never)
  await clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })

  expect(await ui.find({ type: 'Text', text: /② Phase 2: Next +✔ 1\/1/ })).toBeDefined()
  await ui.unmount()
})

test('a second plan touched while the first is still being read is not dropped: both are tracked', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  disk.put('/w/docs/plans/other.md', PLAN_TEXT.replace('# Demo plan', '# Other plan'))
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH } as never)
  await $.tool.call({ tool: 'Read', file_path: '/w/docs/plans/other.md' } as never)
  await clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })

  expect(await ui.find({ type: 'Text', text: /^③ Other plan: Phase 1: Base/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^① Demo plan: Phase 1: Base/ })).toBeDefined()
  await ui.unmount()
})

const BIG_PLAN = (finished: number) =>
  `# Big\n\n${[1, 2, 3].map(p => `## Phase ${p}: P${p}\n${[1, 2, 3, 4].map(t => `### Task ${(p - 1) * 4 + t}: t\n- [${(p - 1) * 4 + t <= finished ? 'x' : ' '}] a\n`).join('')}\n`).join('')}`

test('a minute after the last arrow press the focus returns to the current phase', async ($, on) => {
  const { clock } = await planSetup($, on, BIG_PLAN(4))
  await readPlan($, clock)
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })
  const header = (n: string, p: number) => textsOf(ui, new RegExp(`^${n} Phase ${p}: P${p} +$`))

  expect(await header('②', 2)).toBe(1)
  await ui.press({ key: 'plan-next' })
  await ui.press({ key: 'plan-next' })
  await ui.press({ key: 'plan-next' })
  expect(await header('③', 3)).toBe(1)
  for (let i = 0; i < 4; i += 1) await ui.press({ key: 'plan-prev' })
  expect(await header('①', 1)).toBe(1)

  await clock.advance(61_000)
  await ui.unmount()
  const again = await mountPane($)
  expect(await textsOf(again, /^② Phase 2: P2 +$/)).toBe(1)
  await again.unmount()
})

test('a phase that becomes complete raises one toast, phases complete at the first read raise none', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const { clock, disk } = await planSetup($, on, BIG_PLAN(4))
  await readPlan($, clock)
  expect(toasts).toEqual([])

  disk.put(PLAN_PATH, BIG_PLAN(8))
  await clock.advance(5000)
  expect(toasts).toEqual(['Phase ② Phase 2: P2 done (4/4)'])
  await clock.advance(10_000)
  expect(toasts.length).toBe(1)

  const done = (n: number) => ({ content: `Task ${n}: x`, status: 'completed', activeForm: 'x' })
  await $.tool.call({ tool: 'TodoWrite', todos: [9, 10, 11, 12].map(done) } as never)
  await clock.settle()
  expect(toasts).toEqual(['Phase ② Phase 2: P2 done (4/4)', 'Phase ③ Phase 3: P3 done (4/4)'])
})

test('a toast that fails never breaks the plan read', async ($, on) => {
  let calls = 0
  on('ui.toast', () => {
    calls += 1
    throw new Error('no terminal')
  })
  const { clock, disk } = await planSetup($, on, BIG_PLAN(4))
  await readPlan($, clock)
  disk.put(PLAN_PATH, BIG_PLAN(8))
  await clock.advance(5000)
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })

  expect(calls).toBeGreaterThan(0)
  expect(await textsOf(ui, /P3/)).toBeGreaterThan(0)
  await ui.unmount()
})

const toastLog = (on: On) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return toasts
}

test('stopping the plan and following it again raises no toast for a phase finished meanwhile', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on, BIG_PLAN(4))
  const run = (args: string) => $.command.run({ command: 'task-progress-plan', args } as never)
  await run(PLAN_PATH)
  await clock.settle()
  await run('off')
  disk.put(PLAN_PATH, BIG_PLAN(8))
  await run(PLAN_PATH)
  await clock.advance(10_000)

  expect(toasts).toEqual([])
})

test('a phase that goes complete, incomplete, complete again raises one toast', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on, BIG_PLAN(4))
  await readPlan($, clock)
  disk.put(PLAN_PATH, BIG_PLAN(8))
  await clock.advance(5000)
  disk.put(PLAN_PATH, BIG_PLAN(7))
  await clock.advance(5000)
  disk.put(PLAN_PATH, BIG_PLAN(8))
  await clock.advance(5000)

  expect(toasts).toEqual(['Phase ② Phase 2: P2 done (4/4)'])
})

test('a phase inserted or renamed in the file raises no toast for phases that were already complete', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on, BIG_PLAN(8))
  await readPlan($, clock)
  disk.put(PLAN_PATH, BIG_PLAN(8).replace('## Phase 1: P1', '## Phase 0: Z\n### Task 99: z\n- [x] z\n\n## Phase 1: P1'))
  await clock.advance(5000)
  disk.put(PLAN_PATH, BIG_PLAN(8).replace('## Phase 1: P1', '## Phase 1: Renamed'))
  await clock.advance(5000)

  expect(toasts).toEqual([])
})

test('adding a second plan that is already complete raises no toast', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on, BIG_PLAN(4))
  disk.put('/w/docs/plans/two.md', BIG_PLAN(12))
  await readPlan($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/w/docs/plans/two.md' } as never)
  await clock.advance(10_000)

  expect(toasts).toEqual([])
})

test('the plan command pins a file, turns tracking off, and refuses a path that is not absolute, not Markdown or with control characters', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  disk.put('/w/other/plans/x.md', PLAN_TEXT.replace('# Demo plan', '# Other plan'))
  const run = async (args: string) => JSON.stringify(await $.command.run({ command: 'task-progress-plan', args } as never))
  expect(await run('docs/plan.md')).toContain('absolute')
  expect(await run('/w/notes.txt')).toContain('.md')
  expect(await run('/w/a\nb.md')).toContain('control')

  expect(await run(PLAN_PATH)).toContain('Following')
  await clock.settle()
  let ui = await mountPane($)
  expect(await ui.find({ key: 'plan-toggle' })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: 'Read', file_path: '/w/other/plans/x.md' } as never)
  await clock.settle()
  ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })
  expect(await textsOf(ui, /Phase 1: Base/)).toBeGreaterThan(0)
  expect(await textsOf(ui, /Other plan/)).toBe(0)
  await ui.unmount()

  expect(await run('off')).toContain('stopped')
  ui = await mountPane($)
  expect(await ui.find({ key: 'plan-toggle' })).toBeUndefined()
  await ui.unmount()
})

test('the system prompt asks the model to tick the boxes of the plan it follows', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const input = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [PROGRESS], outputStyle: null, traits: [] }
  const { sections } = await $.prompt.compose(input as never)

  expect(sections.find(s => s.id === 'task-progress:usage')?.text).toContain('tick')
})

test('a subagent that reads another plan file adds nothing to the main pane plans, the main session adds it', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  disk.put('/w/docs/plans/other.md', PLAN_TEXT.replace('# Demo plan', '# Other plan'))
  await readPlan($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/w/docs/plans/other.md', agentId: SUBAGENT } as never)
  await clock.settle()
  let ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })
  expect(await textsOf(ui, /Demo plan/)).toBeGreaterThan(0) // A
  expect(await textsOf(ui, /Other plan/)).toBe(0)
  await ui.unmount()

  await $.tool.call({ tool: 'Read', file_path: '/w/docs/plans/other.md' } as never)
  await clock.settle()
  ui = await mountPane($)
  expect(await textsOf(ui, /Other plan/)).toBeGreaterThan(0)
  expect(await textsOf(ui, /Demo plan/)).toBeGreaterThan(0)
  expect(await textsOf(ui, /^\d+%  \d+\/\d+ · 2 plans$/)).toBe(1)
  await ui.unmount()
})

test('the plan header and the focus header fit the inner width when the title and the phase name are long', async ($, on) => {
  const long = 'L'.repeat(60)
  // two phases, so the focus header shows the focused phase's name
  const text = `# ${long}\n\n## ${long}\n### Task 1: t\n- [x] a\n\n## ${long}2\n### Task 2: t\n- [x] b\n`
  const { clock } = await planSetup($, on, text)
  await readPlan($, clock)
  const width = 48 // bodyColumns 50 minus the padding
  const narrow = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 50, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })
  await narrow.press({ key: 'plan-toggle' })
  const focus = (await narrow.findAll({ type: 'Text', text: /^② L+…? $/ }))[0]
  const header = (await narrow.findAll({ type: 'Text', text: /\d+\/\d+ · L/ }))[0]
  // the buttons draw as `[ ‹ ]` and `[ › ]` (5 columns each) with one column between and one after the name
  expect(focus).toBeDefined()
  expect(header).toBeDefined()
  expect((focus?.text ?? '').length + 5 + 1 + 5).toBeLessThanOrEqual(width)
  expect((header?.text ?? '').length).toBeLessThanOrEqual(width)
  await narrow.unmount()
})

test('with a tracked plan the todo view still draws no more rows than the pane has', async ($, on) => {
  mockUsage(on, { value: gaugeUsage(62) })
  const { clock, disk } = await planSetup($, on)
  gitWorld(disk, { '/w/a': '/w/a', '/w/b': '/w/b', '/w/c': '/w/c' }, { '/w/a': '## main\n', '/w/b': '## main\n', '/w/c': '## main\n' })
  for (const r of ['a', 'b', 'c']) {
    await $.tool.call({ tool: 'Edit', file_path: `/w/${r}/a.ts`, old_string: 'a', new_string: 'b' } as never)
    await clock.settle()
  }
  await readPlan($, clock)
  await $.tool.call({ tool: 'TodoWrite', todos: [1, 2, 3, 4].map(n => ({ content: `todo ${n}`, status: 'pending', activeForm: 'x' })) } as never)
  await clock.settle()
  const ui = await mountPlanPane($, 12)
  const stripRows = (await ui.findAll({ type: 'Text', text: /^⎇/ })).length + ((await ui.find({ type: 'Text', text: /ctx/ })) === undefined ? 0 : 1)
  const taskRows = (await ui.findAll({ type: 'Text', text: /^todo \d/ })).length

  // 12 rows = 7 chrome + the toggle row + what the strip and the tasks may use (4), and one task row stays
  expect(taskRows).toBeGreaterThanOrEqual(1)
  expect(stripRows + taskRows).toBeLessThanOrEqual(4)
  await ui.unmount()
})

const SINGLE = (title: string, done = false) => `# ${title}\n\n### Task 1: a\n- [x] a\n### Task 2: b\n- [${done ? 'x' : ' '}] b\n`
const touchPlans = async ($: Engine, disk: Disk, clock: { settle: () => Promise<void> }, plans: Record<string, string>) => {
  for (const [name, text] of Object.entries(plans)) {
    disk.put(`/w/docs/plans/${name}.md`, text)
    await $.tool.call({ tool: 'Read', file_path: `/w/docs/plans/${name}.md` } as never)
    await clock.settle()
  }
}
const headerIs = async (ui: Awaited<ReturnType<typeof mountPane>>, title: string) => textsOf(ui, new RegExp(`^\\d+%  \\d+/\\d+ · ${title}$`))
const openPlanView = async ($: Engine) => {
  const ui = await mountPane($)
  await ui.press({ key: 'plan-toggle' })

  return ui
}

test('two plans touched by the main session are two phases under the header "2 plans", a third is added after them', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha'), beta: SINGLE('Beta') })
  let ui = await openPlanView($)
  expect(await headerIs(ui, '2 plans')).toBe(1)
  expect(await textsOf(ui, /^① Alpha +▶ 1\/2/)).toBe(1)
  expect(await textsOf(ui, /^② Beta +○ 1\/2/)).toBe(1)
  await ui.unmount()

  await touchPlans($, disk, clock, { gamma: SINGLE('Gamma'), alpha: SINGLE('Alpha') })
  ui = await mountPane($)
  expect(await headerIs(ui, '3 plans')).toBe(1)
  expect(await textsOf(ui, /^① Alpha +▶/)).toBe(1)
  expect(await textsOf(ui, /^③ Gamma +○/)).toBe(1)
  await ui.unmount()
})

test('at most 10 plans are tracked: an eleventh drops the one touched first', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  const names = 'abcdefghijk'.split('')
  await touchPlans($, disk, clock, Object.fromEntries(names.map(n => [n, SINGLE(`Plan ${n}`, n !== 'k')])))
  const ui = await openPlanView($)
  expect(await headerIs(ui, '10 plans')).toBe(1)
  for (let i = 0; i < 12; i += 1) await ui.press({ key: 'plan-prev' })
  expect(await textsOf(ui, /^① Plan b +$/)).toBe(1)
  await ui.unmount()
})

test('pinning a plan replaces the list, and later touches add nothing', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha'), beta: SINGLE('Beta') })
  disk.put('/w/docs/plans/gamma.md', SINGLE('Gamma'))
  await $.command.run({ command: 'task-progress-plan', args: '/w/docs/plans/gamma.md' } as never)
  await touchPlans($, disk, clock, { delta: SINGLE('Delta') })
  const ui = await openPlanView($)

  expect(await headerIs(ui, 'Gamma')).toBe(1)
  expect(await textsOf(ui, /Alpha|Beta|Delta|plans/)).toBe(0)
  await ui.unmount()
})

test('one plan that cannot be read keeps its last parse while another updates', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha'), beta: SINGLE('Beta') })
  disk.files.delete('/w/docs/plans/alpha.md')
  disk.put('/w/docs/plans/beta.md', SINGLE('Beta', true))
  await clock.advance(5000)
  const ui = await openPlanView($)

  expect(await textsOf(ui, /^① Alpha +▶ 1\/2/)).toBe(1)
  expect(await textsOf(ui, /^② Beta +✔ 2\/2/)).toBe(1)
  await ui.unmount()
})

test('a plan with several ## phases adds them as "<title>: <phase>" after a single-phase plan', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha') })
  await readPlan($, clock)
  const ui = await openPlanView($)

  expect(await textsOf(ui, /^① Alpha +▶/)).toBe(1)
  expect(await textsOf(ui, /^② Demo plan: Phase 1: Base +○/)).toBe(1)
  expect(await textsOf(ui, /^③ Demo plan: Phase 2: Next +○/)).toBe(1)
  await ui.unmount()
})

test('completing the phase of a second plan raises one toast, adding a plan that is already complete raises none', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha'), beta: SINGLE('Beta') })
  disk.put('/w/docs/plans/beta.md', SINGLE('Beta', true))
  await clock.advance(5000)
  await clock.advance(5000)
  expect(toasts).toEqual(['Phase ② Beta done (2/2)'])

  await touchPlans($, disk, clock, { gamma: SINGLE('Gamma', true) })
  await clock.advance(5000)
  expect(toasts).toEqual(['Phase ② Beta done (2/2)'])
})

test('completed todo "Task N" entries mark only the plan touched most recently, and toast only its phase', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha') })
  await clock.advance(10)
  await touchPlans($, disk, clock, { beta: SINGLE('Beta') })
  const done = (n: number) => ({ content: `Task ${n}: x`, status: 'completed', activeForm: 'x' })
  await $.tool.call({ tool: 'TodoWrite', todos: [1, 2, 3].map(done) } as never)
  await clock.settle()
  const ui = await openPlanView($)

  expect(await textsOf(ui, /^① Alpha +▶ 1\/2/)).toBe(1)
  expect(await textsOf(ui, /^② Beta +✔ 2\/2/)).toBe(1)
  expect(toasts).toEqual(['Phase ② Beta done (2/2)'])
  await ui.unmount()
})

test('with one single-phase plan the focus header does not repeat the name the header and the phase row show', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, { alpha: SINGLE('Alpha') })
  const ui = await openPlanView($)

  expect(await textsOf(ui, /^① +$/)).toBe(1)
  expect(await textsOf(ui, /^① Alpha +▶/)).toBe(1)
  expect(await ui.find({ key: 'plan-next' })).toBeDefined()
  await ui.unmount()
})

test('a todo update and a plan read that overlap announce a newly complete phase once', async ($, on) => {
  const toasts = toastLog(on)
  const { clock } = await planSetup($, on, BIG_PLAN(4))
  await readPlan($, clock)
  const done = (n: number) => ({ content: `Task ${n}: x`, status: 'completed', activeForm: 'x' })
  await Promise.all([$.tool.call({ tool: 'TodoWrite', todos: [5, 6, 7, 8].map(done) } as never), clock.advance(5000)])
  await clock.settle()

  expect(toasts).toEqual(['Phase ② Phase 2: P2 done (4/4)'])
})

test('one phased plan keeps its phase names, a second plan prefixes both plans\' phases with their titles', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await readPlan($, clock)
  let ui = await openPlanView($)
  expect(await headerIs(ui, 'Demo plan')).toBe(1)
  expect(await textsOf(ui, /^① Phase 1: Base +▶/)).toBe(1)
  expect(await textsOf(ui, /^② Phase 2: Next +○/)).toBe(1)
  await ui.unmount()

  await touchPlans($, disk, clock, { beta: SINGLE('Beta') })
  ui = await mountPane($)
  expect(await headerIs(ui, '2 plans')).toBe(1)
  expect(await textsOf(ui, /^① Demo plan: Phase 1: Base +▶/)).toBe(1)
  expect(await textsOf(ui, /^② Demo plan: Phase 2: Next +○/)).toBe(1)
  expect(await textsOf(ui, /^③ Beta +○/)).toBe(1)
  await ui.unmount()
})

test('a plan state of the old single-plan shape left by an earlier load does not block new plans', async ($, on) => {
  // the value an earlier load wrote stands until this load writes the atom (tests cannot write another load's state directly)
  let isWritten = false
  on('state.set', { plugin: 'task-progress', key: 'plan' } as never, async (_$, e, next) => {
    isWritten = true

    return next(e)
  })
  on('state.get', { plugin: 'task-progress', key: 'plan' } as never, async (_$, e, next) => {
    const held = await next(e)

    return isWritten ? held : { ...held, value: { ...held.value, value: { path: PLAN_PATH, plan: null, isPinned: false } } as never }
  })
  const { clock } = await planSetup($, on)
  await readPlan($, clock)
  const ui = await openPlanView($)

  expect(await textsOf(ui, /^① Phase 1: Base +▶/)).toBe(1)
  await ui.unmount()
})

test('beyond 10 plans the one touched least recently is dropped, not the one touched first', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  const names = 'abcdefghij'.split('')
  for (const n of names) {
    await touchPlans($, disk, clock, { [n]: SINGLE(`Plan ${n}`) })
    await clock.advance(10)
  }
  await touchPlans($, disk, clock, { a: SINGLE('Plan a') })
  await clock.advance(10)
  await touchPlans($, disk, clock, { k: SINGLE('Plan k') })
  const ui = await openPlanView($)

  expect(await headerIs(ui, '10 plans')).toBe(1)
  expect(await textsOf(ui, /^① Plan a +▶/)).toBe(1)
  expect(await textsOf(ui, /^② Plan c +○/)).toBe(1)
  await ui.unmount()
})

test('when a plan leaves the list the focus returns to the current phase, so it never lands in another plan', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  await touchPlans($, disk, clock, Object.fromEntries('abcdefghij'.split('').map(n => [n, SINGLE(`Plan ${n}`)])))
  const ui = await openPlanView($)
  for (let i = 0; i < 5; i += 1) await ui.press({ key: 'plan-next' })
  expect(await textsOf(ui, /^⑥ Plan f +$/)).toBe(1)
  await touchPlans($, disk, clock, { k: SINGLE('Plan k') })
  await ui.unmount()
  const again = await mountPane($)

  expect(await textsOf(again, /^① Plan b +$/)).toBe(1)
  await again.unmount()
})

test('two todo updates at once announce a newly complete phase once', async ($, on) => {
  const toasts = toastLog(on)
  const { clock } = await planSetup($, on, BIG_PLAN(4))
  await readPlan($, clock)
  const done = (n: number) => ({ content: `Task ${n}: x`, status: 'completed', activeForm: 'x' })
  const write = () => $.tool.call({ tool: 'TodoWrite', todos: [5, 6, 7, 8].map(done) } as never)
  await Promise.all([write(), write()])
  await clock.settle()

  expect(toasts).toEqual(['Phase ② Phase 2: P2 done (4/4)'])
})

const SDD_PLAN = (name: string) => `/w/docs/superpowers/plans/${name}.md`
const LEDGER = (name: string) => `/w/.superpowers/sdd/${name}/progress.md`
const LEDGER_HEAD = (name: string) => `# SDD ledger — plan: docs/superpowers/plans/${name}.md\n`
const readSddPlan = async ($: Engine, disk: Disk, clock: { settle: () => Promise<void> }, name: string, text: string) => {
  disk.put(SDD_PLAN(name), text)
  await $.tool.call({ tool: 'Read', file_path: SDD_PLAN(name) } as never)
  await clock.settle()
}

test('a subagent-driven ledger beside the plan marks its tasks done, and they stay done when the ledger goes', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on)
  disk.put(LEDGER('alpha'), `${LEDGER_HEAD('alpha')}Task 2: complete (commits abc)\nTask 1: fix round 1\n`)
  await readSddPlan($, disk, clock, 'alpha', SINGLE('Alpha'))
  let ui = await openPlanView($)
  expect(await textsOf(ui, /^① Alpha +✔ 2\/2/)).toBe(1)
  await ui.unmount()

  disk.files.delete(LEDGER('alpha'))
  await clock.advance(5000)
  ui = await mountPane($)
  expect(await textsOf(ui, /^① Alpha +✔ 2\/2/)).toBe(1)
  await ui.unmount()
  // complete at the first read: a silent baseline
  expect(toasts).toEqual([])
})

test('the ledger of one plan does not mark the tasks of another', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  disk.put(LEDGER('alpha'), `${LEDGER_HEAD('alpha')}Task 2: complete\n`)
  await readSddPlan($, disk, clock, 'alpha', SINGLE('Alpha'))
  await readSddPlan($, disk, clock, 'beta', SINGLE('Beta'))
  const ui = await openPlanView($)

  expect(await textsOf(ui, /^① Alpha +✔ 2\/2/)).toBe(1)
  expect(await textsOf(ui, /^② Beta +▶ 1\/2/)).toBe(1)
  await ui.unmount()
})

test('a phase completed through the ledger raises one toast', async ($, on) => {
  const toasts = toastLog(on)
  const { clock, disk } = await planSetup($, on)
  await readSddPlan($, disk, clock, 'alpha', SINGLE('Alpha'))
  await readSddPlan($, disk, clock, 'beta', SINGLE('Beta'))
  disk.put(LEDGER('beta'), `${LEDGER_HEAD('beta')}Task 2: complete\n`)
  await clock.advance(5000)
  await clock.advance(5000)

  expect(toasts).toEqual(['Phase ② Beta done (2/2)'])
})

const REMINDER = /^task-progress: the pane's task list has not been updated for (\d+) tool calls while a task is in progress\. Call mcp__task-progress__progress now/
const remindSetup = (on: On) => {
  mock.clock(on, { now: NOW })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'ok', ref: 7, context: ['core note'] }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'no' }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'boom', isError: true, text: 'boom' }) as never)
}
const contextsOf = async ($: Engine, count: number, agentId?: string) => {
  const seen: Array<readonly string[] | undefined> = []
  for (let i = 0; i < count; i += 1) seen.push(((await $.tool.call({ tool: 'Read', file_path: '/x', agentId } as never)) as { context?: readonly string[] }).context)

  return seen
}
const remindedAt = (seen: Array<readonly string[] | undefined>) => seen.flatMap((c, i) => ((c ?? []).some(t => REMINDER.test(t)) ? [i + 1] : []))
const progress = ($: Engine, statuses: Array<'pending' | 'in_progress' | 'completed'>) =>
  $.tool.call({ tool: PROGRESS, tasks: statuses.map((status, i) => ({ subject: `t${i}`, status })) } as never)

test('a stale list reminds the model at the 10th and 20th main-session call, keeping the result and its context', async ($, on) => {
  remindSetup(on)
  await progress($, ['in_progress', 'pending'])
  const seen = await contextsOf($, 20)

  expect(remindedAt(seen)).toEqual([10, 20])
  expect(seen[0]).toEqual(['core note'])
  expect(seen[9]?.[0]).toBe('core note')
  expect(seen[9]?.[1]).toMatch(/for 10 tool calls/)
  expect(seen[19]?.[1]).toMatch(/for 20 tool calls/)
  const tenth = await (async () => {
    await progress($, ['in_progress', 'pending'])
    await contextsOf($, 9)

    return $.tool.call({ tool: 'Read', file_path: '/x' } as never) as Promise<{ result?: unknown; ref?: number; context?: readonly string[] }>
  })()
  expect(tenth.result).toBe('ok')
  expect(tenth.ref).toBe(7)
  expect(tenth.context?.length).toBe(2)
})

test('a progress update resets the reminder count', async ($, on) => {
  remindSetup(on)
  await progress($, ['in_progress', 'pending'])
  await contextsOf($, 6)
  await progress($, ['completed', 'in_progress'])

  expect(remindedAt(await contextsOf($, 12))).toEqual([10])
})

test('a subagent\'s calls never get the reminder and never count, a session without a list or without a task in progress gets none', async ($, on) => {
  remindSetup(on)
  expect(remindedAt(await contextsOf($, 12))).toEqual([])
  await progress($, ['in_progress'])
  expect(remindedAt(await contextsOf($, 25, SUBAGENT))).toEqual([])
  expect(remindedAt(await contextsOf($, 10))).toEqual([10])
  await progress($, ['completed', 'pending'])
  expect(remindedAt(await contextsOf($, 12))).toEqual([])
})

test('a denied or failed call at the 10th is returned unchanged', async ($, on) => {
  remindSetup(on)
  await progress($, ['in_progress'])
  await contextsOf($, 9)
  const denied = (await $.tool.call({ tool: 'Bash', command: 'x' } as never)) as { deny?: string; context?: unknown }
  expect(denied.deny).toBe('no')
  expect(denied.context).toBeUndefined()

  await progress($, ['in_progress'])
  await contextsOf($, 9)
  const failed = (await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' } as never)) as { isError?: boolean; text?: string; context?: unknown }
  expect(failed.isError).toBe(true)
  expect(failed.text).toBe('boom')
  expect(failed.context).toBeUndefined()
})

test('a ledger without the header or naming another plan marks nothing and does not clear what was seen', async ($, on) => {
  const { clock, disk } = await planSetup($, on)
  disk.put(LEDGER('alpha'), 'Task 2: complete\n')
  await readSddPlan($, disk, clock, 'alpha', SINGLE('Alpha'))
  let ui = await openPlanView($)
  expect(await textsOf(ui, /^① Alpha +▶ 1\/2/)).toBe(1)
  await ui.unmount()

  disk.put(LEDGER('alpha'), `${LEDGER_HEAD('alpha')}Task 2: complete\n`)
  await clock.advance(5000)
  disk.put(LEDGER('alpha'), `${LEDGER_HEAD('beta')}Task 1: complete\n`)
  await clock.advance(5000)
  ui = await mountPane($)
  expect(await textsOf(ui, /^① Alpha +✔ 2\/2/)).toBe(1)
  await ui.unmount()
})

test('two main-session calls at once at the 10th count: only the call that counted 10 carries the reminder', async ($, on) => {
  remindSetup(on)
  await progress($, ['in_progress'])
  await contextsOf($, 8)
  const call = () => $.tool.call({ tool: 'Read', file_path: '/x' } as never) as Promise<{ context?: readonly string[] }>
  const both = await Promise.all([call(), call()])

  expect(remindedAt(both.map(r => r.context))).toHaveLength(1)
})
