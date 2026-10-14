import { expect, mock, test } from 'claude-code/testing'

import { stageCells } from './stage'

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

test('the stage sings while a turn runs and rests when it ends', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: 'done' }))

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
  const cells = async () => (await ui.find({ type: 'Raster' }))?.props.cells
  expect(await cells()).toBe(stageCells('idle', 0, 70))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await ui.redraw()
  expect(await cells()).toBe(stageCells('sing', 0, 70))

  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await ui.redraw()
  expect(await cells()).toBe(stageCells('idle', 0, 70))
  await ui.unmount()
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
