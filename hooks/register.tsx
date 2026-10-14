import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, TaskStatus } from '../types'
import {
  FRAME_MS,
  KNIGHT_COLUMNS,
  KNIGHT_ROWS,
  frameKey,
  knightCells,
  modeOf,
} from './knight'
import type { Mode } from './knight'

const PANE = 'task-progress'
const BAR_WIDTH = 24

let mode: Mode = 'idle'
let tick = 0
let lastKey = ''

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [] as Item[])
const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as Item[])

const summarize = (items: Item[]) => {
  const done = items.filter(i => i.status === 'completed').length
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100)

  return { done, total: items.length, percent }
}

const bar = (percent: number) => {
  const filled = Math.round((percent / 100) * BAR_WIDTH)

  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

const mark = (status: TaskStatus) =>
  status === 'completed' ? '✔' : status === 'in_progress' ? '▶' : '○'

const isOk = (ran: { deny?: string; isError?: boolean }) =>
  ran.deny === undefined && ran.isError !== true

async function refreshStatus($: EngineInterface) {
  const list = [...(await read($, todos)), ...(await read($, tasks))]
  const { done, total, percent } = summarize(list)
  mode = modeOf(list)
  $.ui.status(total === 0 ? undefined : `tasks ${done}/${total} · ${percent}%`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-progress',
      description: 'Show the task progress pane (todo/task list, percent done)',
    })
    void $.ui.open({ id: PANE, title: 'Task progress' })
    $.clock.every(FRAME_MS, () => {
      tick += 1
      const key = frameKey(mode, tick)
      if (key === lastKey) return
      lastKey = key
      void $.ui.blit({ requestId: PANE, key: 'knight', cells: knightCells(mode, tick) })
    })

    return next(e)
  })

  on('command.run', { command: 'task-progress' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Task progress' })

    return { text: 'Task progress pane opened.' }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran)) {
      const items: Item[] = e.todos.map((t, i) => ({
        id: String(i),
        label: t.content,
        status: t.status,
      }))
      await update($, todos, () => items)
      await refreshStatus($)
    }

    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran) && ran.result) {
      const id = (ran.result as { task: { id: string } }).task.id
      await update($, tasks, list => [
        ...list.filter(i => i.id !== id),
        { id, label: e.subject, status: 'pending' as const },
      ])
      await refreshStatus($)
    }

    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran)) {
      const newStatus: TaskStatus | undefined = e.status === 'deleted' ? undefined : e.status
      await update($, tasks, list =>
        e.status === 'deleted'
          ? list.filter(i => i.id !== e.taskId)
          : list.map(i =>
              i.id === e.taskId
                ? { ...i, label: e.subject ?? i.label, status: newStatus ?? i.status }
                : i,
            ),
      )
      await refreshStatus($)
    }

    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran) && ran.result) {
      const list = (ran.result as { tasks: Array<{ id: string; subject: string; status: TaskStatus }> }).tasks
      const snapshot: Item[] = list.map(t => ({
        id: t.id,
        label: t.subject,
        status: t.status,
      }))
      await update($, tasks, () => snapshot)
      await refreshStatus($)
    }

    return ran
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const knight =
      e.surface === 'terminal' && 'Raster' in ui ? (
        <ui.Raster
          key="knight"
          columns={KNIGHT_COLUMNS}
          rows={KNIGHT_ROWS}
          cells={knightCells(mode, tick)}
        />
      ) : null
    const items = [...(await read($, todos)), ...(await read($, tasks))]
    const { done, total, percent } = summarize(items)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6 - KNIGHT_ROWS)
    const active = items.filter(i => i.status === 'in_progress')
    const rest = items.filter(i => i.status !== 'in_progress')
    const shown = [...active, ...rest].slice(0, room)

    if (total === 0) {
      return (
        <Box flexDirection="column">
          {knight}
          <Text dimColor>No tasks yet. They appear when Claude plans work.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {knight}
        <Text bold>
          {done}/{total} done · {percent}%
        </Text>
        <Text color={percent === 100 ? 'green' : 'cyan'}>{bar(percent)}</Text>
        <Text> </Text>
        {shown.map(i => (
          <Text
            bold={i.status === 'in_progress'}
            color={i.status === 'in_progress' ? 'yellow' : undefined}
            dimColor={i.status === 'completed'}
          >
            {mark(i.status)} {i.label}
          </Text>
        ))}
        {items.length > shown.length && (
          <Text dimColor>… +{items.length - shown.length} more</Text>
        )}
      </Box>
    )
  })
}
