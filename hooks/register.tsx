import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, TaskStatus } from '../types'
import {
  FRAME_MS,
  MAX_COLUMNS,
  MIN_COLUMNS,
  STAGE_ROWS,
  frameKey,
  isAllDone,
  modeOf,
  stageCells,
} from './stage'
import { timingText } from './progress'
import { COLORS, barParts, truncate } from './style'

const PANE = 'task-progress'
const PROGRESS_TOOL = 'mcp__task-progress__progress'
const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']
const CARD_PADDING = 1
const DEFAULT_COLUMNS = 24

let isBusy = false
let isDone = false
let tick = 0
let lastKey = ''
let columns = DEFAULT_COLUMNS

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [] as Item[])
const startedAt = atom({ plugin: 'task-progress', key: 'startedAt' } as const, 0)
const finishedAt = atom({ plugin: 'task-progress', key: 'finishedAt' } as const, 0)
const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as Item[])

const summarize = (items: Item[]) => {
  const done = items.filter(i => i.status === 'completed').length
  const percent = items.length === 0 ? 0 : Math.round((done / items.length) * 100)

  return { done, total: items.length, percent }
}

function parseProgressInput(raw: unknown): Item[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const items: Item[] = []
  for (const [index, entry] of raw.entries()) {
    const subject = (entry as { subject?: unknown } | null)?.subject
    const status = (entry as { status?: unknown } | null)?.status
    if (typeof subject !== 'string' || !STATUSES.includes(status as TaskStatus)) return undefined
    items.push({ id: String(index), label: subject, status: status as TaskStatus })
  }

  return items
}

const mark = (status: TaskStatus) =>
  status === 'completed' ? '✔' : status === 'in_progress' ? '▶' : '○'

const isOk = (ran: { deny?: string; isError?: boolean }) =>
  ran.deny === undefined && ran.isError !== true

async function refreshStatus($: EngineInterface) {
  const list = [...(await read($, todos)), ...(await read($, tasks))]
  const { done, total, percent } = summarize(list)
  isDone = isAllDone(list)
  const now = await $.clock.now()
  if (total === 0) {
    await update($, startedAt, () => 0)
    await update($, finishedAt, () => 0)
  } else {
    await update($, startedAt, prev => prev || now)
    await update($, finishedAt, prev => (done === total ? prev || now : 0))
  }
  $.ui.status(total === 0 ? undefined : `tasks ${done}/${total} · ${percent}%`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-progress',
      description: 'Show the task progress pane (todo/task list, percent done)',
    })
    void $.ui.open({ id: PANE, title: 'Task progress' })
    await $.tool.register({
      name: 'progress',
      description:
        'Shows the task list and progress in the user\'s task-progress pane. For any work of 2+ steps, call this first with the full ordered list, then again whenever a step starts (in_progress) or finishes (completed). Each call replaces the whole list. Keep exactly one task in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['subject', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })
    $.clock.every(FRAME_MS, () => {
      tick += 1
      const mode = modeOf(isBusy, isDone)
      const key = frameKey(mode, tick, columns)
      if (key === lastKey) return
      lastKey = key
      void $.ui.blit({
        requestId: PANE,
        key: 'stage',
        columns,
        cells: stageCells(mode, tick, columns),
      })
    })

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) isBusy = true

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isBusy = false

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'task-progress' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Task progress' })

    return { text: 'Task progress pane opened.' }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const items = parseProgressInput(e.tasks)
    if (items === undefined) {
      return { deny: 'tasks must be an array of { subject, status: pending | in_progress | completed }' }
    }
    await update($, todos, () => items)
    await refreshStatus($)
    const { done, total } = summarize(items)

    return { result: `Progress updated: ${done}/${total} done` }
  }).catch((_$, e, next) => next(e))

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
    const items = [...(await read($, todos)), ...(await read($, tasks))]
    const { done, total, percent } = summarize(items)
    const now = await $.clock.now()
    const started = await read($, startedAt)
    const finished = await read($, finishedAt)
    const elapsed = started === 0 ? 0 : (finished || now) - started
    const timing = timingText(elapsed, done, total, finished !== 0)

    const inner = Math.min(
      MAX_COLUMNS,
      Math.max(MIN_COLUMNS, (e.props.bodyColumns ?? DEFAULT_COLUMNS + 2 * CARD_PADDING) - 2 * CARD_PADDING),
    )
    columns = inner
    isDone = isAllDone(items)
    const mode = modeOf(isBusy, isDone)
    const hasStage = e.surface === 'terminal' && 'Raster' in ui && (e.viewport?.rows ?? 99) >= STAGE_ROWS + 8
    const stage = hasStage ? (
      <ui.Raster key="stage" columns={inner} rows={STAGE_ROWS} cells={stageCells(mode, tick, inner)} />
    ) : null

    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7 - (hasStage ? STAGE_ROWS : 0))
    const shownItems = [
      ...items.filter(i => i.status === 'in_progress'),
      ...items.filter(i => i.status !== 'in_progress'),
    ].slice(0, room)
    const { filled, rest } = barParts(percent, inner)
    const accent = percent === 100 ? COLORS.success : COLORS.accent
    const height = e.viewport?.rows === undefined ? undefined : Math.max(1, e.viewport.rows - 1)

    return (
      <Box
        flexDirection="column"
        paddingX={CARD_PADDING}
        paddingY={CARD_PADDING}
        backgroundColor={COLORS.card}
        height={height}
      >
        {stage}
        <Text>
          <Text color={accent}>{filled}</Text>
          <Text color={COLORS.track}>{rest}</Text>
        </Text>
        {total === 0 ? (
          <Text color={COLORS.muted}>No tasks yet. They appear when Claude plans work.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text bold color={accent}>
                {percent}%
              </Text>
              <Text color={COLORS.muted}>
                {'  '}
                {done}/{total} tasks
              </Text>
            </Text>
            {timing !== '' && <Text color={COLORS.muted}>{timing}</Text>}
            <Text> </Text>
            {shownItems.map(i => (
              <Text>
                <Text color={i.status === 'completed' ? COLORS.success : COLORS.muted}>
                  {mark(i.status)}{' '}
                </Text>
                <Text
                  bold={i.status === 'in_progress'}
                  color={
                    i.status === 'in_progress'
                      ? COLORS.active
                      : i.status === 'completed'
                        ? COLORS.doneText
                        : COLORS.text
                  }
                >
                  {truncate(i.label, inner - 2)}
                </Text>
              </Text>
            ))}
            {items.length > shownItems.length && (
              <Text color={COLORS.muted}>… +{items.length - shownItems.length} more</Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
