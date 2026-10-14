import { expect, mock, test } from 'claude-code/testing'

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

  expect(await ui.find({ type: 'Text', text: /1\/2 done · 50%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▶ second/ })).toBeDefined()
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

  expect(await ui.find({ type: 'Text', text: /1\/2 done · 50% · 10m · ~10m left/ })).toBeDefined()
  await ui.unmount()
})
