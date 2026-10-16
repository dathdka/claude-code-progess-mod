import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, GaugeState, Item, Repo, SessionRow, TaskStatus } from '../types'
import { sceneCells } from './compositor'
import { EMPTY_ACTIVITY, begin, callLabel, describeDoing, end, touchedDirectory } from './activity'
import { contextAlarm, formatGauges, freshLimitAlerts, limitName, resetText } from './gauges'
import { CHROME_ROWS, DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout, stripRoom } from './layout'
import { describeRow, layoutRow, newlyWaiting, parseTell, resolveTarget, visibleRows } from './overview'
import { isAllDone, timingText } from './progress'
import { applyReading, cacheRoot, repoLine, repoName, touchRepo, visibleRepos } from './repos'
import type { RootCache } from './repos'
import { playerCommands, soundPath, wasCutByCap } from './sound'
import { COLORS, barParts, truncate } from './style'
import { hasSessionIdChanged, pollSessions, publishProgress, removeRecord, resetSyncState } from './sync'
import { findRoot, readStatus, readUsage, resetWatchState } from './watch'
import { WINDOWS } from './world'

const PANE = 'task-progress'
const PROGRESS_TOOL = 'mcp__task-progress__progress'
const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']
const CARD_PADDING = 1
const DEFAULT_COLUMNS = 24
const DEFAULT_SOUND_SECONDS = 12
const MIN_SOUND_SECONDS = 1
const MAX_SOUND_SECONDS = 120
/** Tool calls without a list update after which the pane warns that it may be stale. */
const STALE_CALLS = 10
/** How often the other sessions are read. */
const POLL_MS = 3000
/** How often the session usage is read. */
const USAGE_MS = 5000
/** How often the tracked repositories are read. */
const GIT_POLL_MS = 10_000
/** Gauges older than this are hidden when reads keep failing. */
const GAUGE_STALE_MS = 30_000
const TELL_USAGE = 'Usage: /task-progress-tell <session name> <message>'
/** The tools that update the list: they reset the stale counter instead of counting. */
const LIST_TOOLS: readonly string[] = [PROGRESS_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']
const USAGE_PROMPT = `The user watches a live task-progress pane fed by the ${PROGRESS_TOOL} tool. For any work of 2 or more steps, call it first with the full ordered list, then call it again every time a step starts (in_progress) or finishes (completed) and whenever the plan changes, also in the middle of long runs of tool calls. Keep exactly one task in_progress. Keep every task as its own entry for the whole job: never merge finished tasks into one line and never rename them; a finished task stays in the list as completed, and each call changes statuses only, adding tasks at the end or in place. Never leave the list stale: when the work is done, mark every task completed.`

let isSoundOn = true
let isWaitSoundOn = false
/** Status of each other session at the last poll; undefined until the first one, which raises no alert. */
let previousStatus: Map<string, string> | undefined
let customSound = ''
let soundMs = DEFAULT_SOUND_SECONDS * 1000
let hasChimed = false
let isContextWarningOn = true
/** Whether the next crossing of 80% raises the context toast. */
let isContextArmed = true
let announcedLimits: ReadonlyMap<string, number> = new Map()
let isReadingUsage = false
let callSeq = 0
/** Tells this load's call ids from those of an earlier load (a reload keeps the activity atom). */
let runId = ''
let roots: RootCache = new Map()
let isPollingRepos = false

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [] as Item[])
const startedAt = atom({ plugin: 'task-progress', key: 'startedAt' } as const, 0)
const finishedAt = atom({ plugin: 'task-progress', key: 'finishedAt' } as const, 0)
const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as Item[])
const idleCalls = atom({ plugin: 'task-progress', key: 'idleCalls' } as const, 0)
const sessions = atom({ plugin: 'task-progress', key: 'sessions' } as const, [] as SessionRow[])
const activity = atom({ plugin: 'task-progress', key: 'activity' } as const, EMPTY_ACTIVITY as Activity)
const repos = atom({ plugin: 'task-progress', key: 'repos' } as const, [] as Repo[])
const gauges = atom({ plugin: 'task-progress', key: 'gauges' } as const, null as GaugeState | null)

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

/** The elements that are there, without the nulls left by a line with nothing to show. */
function present<T>(list: ReadonlyArray<T | null>): T[] {
  return list.filter((entry): entry is T => entry !== null)
}

async function playDone($: EngineInterface, file: string, maxMs: number): Promise<void> {
  try {
    for (const argv of playerCommands(file)) {
      const started = await $.clock.now()
      try {
        const { exitCode } = await $.process.run(argv, { timeoutMs: maxMs })
        if (exitCode === 0) return
      } catch {
        // either this player is not installed, or the cap cut a long clip short
        if (wasCutByCap(started, await $.clock.now(), maxMs)) return
      }
    }
    $.ui.log('task-progress: no audio player could play the completion sound', { to: 'debug' })
  } catch {
    // a sound is a side effect: it must never throw into the session
  }
}

let isPolling = false

/** One read of the other sessions; a failed read keeps the rows already shown, a poll still running is not doubled. */
async function refreshSessions($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    if (await hasSessionIdChanged($)) await publishProgress($, [...(await read($, todos)), ...(await read($, tasks))])
    const rows = await pollSessions($)
    if (rows === undefined) return
    const fresh = newlyWaiting(previousStatus, rows)
    previousStatus = new Map(rows.map(r => [r.sessionId, r.status]))
    await update($, sessions, () => rows)
    if (fresh.length === 0) return
    try {
      $.ui.toast(`◆ ${fresh.map(r => r.name).join(', ')} waiting for you`)
    } catch {
      // a toast is a side effect: it must never throw into the session
    }
    if (isWaitSoundOn) void playDone($, soundPath($.plugin.root, customSound), soundMs)
  } finally {
    isPolling = false
  }
}

/** One read of the session usage: updates the gauges, keeps the last ones for 30 s when it fails, and raises the toasts. */
async function refreshGauges($: EngineInterface): Promise<void> {
  if (isReadingUsage) return
  isReadingUsage = true
  try {
    const now = await $.clock.now()
    const readings = await readUsage($)
    if (readings === undefined) {
      await update($, gauges, prev => (prev !== null && now - prev.at > GAUGE_STALE_MS ? null : prev))

      return
    }
    await update($, gauges, () => ({ readings, at: now }))
    if (!isContextWarningOn) return
    const alarm = contextAlarm(isContextArmed, readings.context)
    isContextArmed = alarm.isArmed
    const alerts = freshLimitAlerts(announcedLimits, readings.limits)
    announcedLimits = alerts.announced
    const messages = [
      ...(alarm.shouldFire ? [`ctx ${readings.context}% · consider /compact`] : []),
      ...alerts.fresh.map(limit => {
        const left = resetText(limit.resetsAt, now)

        return `${limitName(limit.kind)} limit ${limit.percent}%${left === undefined ? '' : ` · resets in ${left}`}`
      }),
    ]
    for (const message of messages) {
      try {
        $.ui.toast(message)
      } catch {
        // a toast is a side effect: it must never throw into the session
      }
    }
  } finally {
    isReadingUsage = false
  }
}

/** A main-session call that is not a list update: one more call without a progress update. */
async function countCall($: EngineInterface): Promise<void> {
  try {
    await update($, idleCalls, n => n + 1)
  } catch {
    // bookkeeping must never reach the tool call
  }
}

/** A call starts: remember it so the pane can name it. */
async function beginCall($: EngineInterface, e: { tool: string; agentId?: string }, id: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const label = callLabel(e.tool, e as unknown as Record<string, unknown>)
    await update($, activity, a => begin(a, { id, label, agentId: e.agentId }, now))
  } catch {
    // bookkeeping must never reach the tool call
  }
}

/** A call ended, with or without success. */
async function endCall($: EngineInterface, e: { tool: string; agentId?: string }, id: string, isSuccess: boolean): Promise<void> {
  try {
    const now = await $.clock.now()
    await update($, activity, a => end(a, id, now))
    if (!isSuccess) return
    const dir = touchedDirectory(e.tool, e as unknown as Record<string, unknown>)
    // not awaited: git must never delay the tool's result (trackTouch swallows its own errors)
    if (dir !== undefined) void trackTouch($, dir)
  } catch {
    // bookkeeping must never reach the tool call
  }
}

/** One repository's status is read and stored. */
async function refreshRepo($: EngineInterface, root: string): Promise<void> {
  const reading = await readStatus($, root)
  await update($, repos, list => applyReading(list, root, reading))
}

/** The session edited a file in `dir`: its repository is tracked, and read at once when it is new. */
async function trackTouch($: EngineInterface, dir: string): Promise<void> {
  try {
    let root = roots.get(dir)
    if (root === undefined) {
      root = await findRoot($, dir)
      if (root === undefined) return
      roots = cacheRoot(roots, dir, root)
    }
    const now = await $.clock.now()
    const isNew = !(await read($, repos)).some(r => r.root === root)
    await update($, repos, list => touchRepo(list, root, now))
    if (isNew) await refreshRepo($, root)
  } catch {
    // tracking is a side effect: it must never reach the tool call
  }
}

/** Every tracked repository is read again, one after another; a poll still running is not doubled. */
async function pollRepos($: EngineInterface): Promise<void> {
  if (isPollingRepos) return
  isPollingRepos = true
  try {
    for (const repo of await read($, repos)) await refreshRepo($, repo.root)
  } catch {
    // a poll is a side effect: it must never reach the session
  } finally {
    isPollingRepos = false
  }
}

async function refreshStatus($: EngineInterface) {
  const list = [...(await read($, todos)), ...(await read($, tasks))]
  const { done, total, percent } = summarize(list)
  const isDone = isAllDone(list)
  if (!isDone) hasChimed = false
  if (isDone && !hasChimed) {
    hasChimed = true
    if (isSoundOn) void playDone($, soundPath($.plugin.root, customSound), soundMs)
  }
  await update($, idleCalls, () => 0)
  const now = await $.clock.now()
  if (total === 0) {
    await update($, startedAt, () => 0)
    await update($, finishedAt, () => 0)
  } else {
    await update($, startedAt, prev => prev || now)
    await update($, finishedAt, prev => (done === total ? prev || now : 0))
  }
  $.ui.status(total === 0 ? undefined : `tasks ${done}/${total} · ${percent}%`)
  await publishProgress($, list)
}

export const register: Register = (on, options) => {
  isSoundOn = options.isSoundOn !== false
  isWaitSoundOn = options.isWaitSoundOn === true
  isContextWarningOn = options.isContextWarningOn !== false
  previousStatus = undefined
  isPolling = false
  isContextArmed = true
  announcedLimits = new Map()
  isReadingUsage = false
  callSeq = 0
  runId = Math.random().toString(36).slice(2, 8)
  roots = new Map()
  isPollingRepos = false
  resetWatchState()
  resetSyncState()
  customSound = typeof options.soundFile === 'string' ? options.soundFile : ''
  const seconds = typeof options.maxSeconds === 'number' ? options.maxSeconds : DEFAULT_SOUND_SECONDS
  soundMs = Math.min(MAX_SOUND_SECONDS, Math.max(MIN_SOUND_SECONDS, seconds)) * 1000

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
    await $.command.register({
      name: 'task-progress-tell',
      description: 'Send a message to another session: /task-progress-tell <session name> <message>',
    })
    await update($, activity, () => EMPTY_ACTIVITY)
    await publishProgress($, [...(await read($, todos)), ...(await read($, tasks))])
    await refreshSessions($)
    await refreshGauges($)
    $.clock.every(POLL_MS, () => {
      void refreshSessions($)
    })
    $.clock.every(USAGE_MS, () => {
      void refreshGauges($)
    })
    $.clock.every(GIT_POLL_MS, () => {
      void pollRepos($)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await removeRecord($, e.sessionId)

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'task-progress' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Task progress' })

    return { text: 'Task progress pane opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'task-progress:usage', text: USAGE_PROMPT, scope: 'session' as const }] }
  }).catch((_$, e, next) => next(e))

  // Counts and records what runs (the stale-list counter and the activity share this one hook: two unmatched hooks are refused). It returns exactly what the tool returns and has no `.catch`: a catch handler would
  // call `next` again and run a tool twice when the tool itself throws.
  on('tool.call', async ($, e, next) => {
    if (LIST_TOOLS.includes(e.tool)) return next(e)
    if (e.agentId === undefined) await countCall($)
    callSeq += 1
    const id = `${runId}-${callSeq}`
    await beginCall($, e, id)
    try {
      const ran = await next(e)
      await endCall($, e, id, isOk(ran))

      return ran
    } catch (error) {
      await endCall($, e, id, false)
      throw error
    }
  })

  on('command.run', { command: 'task-progress-tell' }, async ($, e) => {
    const tell = parseTell(e.args)
    if (tell === undefined) return { text: TELL_USAGE }
    const target = resolveTarget(await read($, sessions), tell.query)
    if ('error' in target) return { text: target.error }
    try {
      const sent = await $.session.send({ to: { sessionId: target.row.sessionId }, text: tell.text })

      return { text: sent.isDelivered ? `Sent to ${target.row.name}.` : `Not delivered to ${target.row.name}: ${sent.reason}` }
    } catch (error) {
      return { text: `Not delivered to ${target.row.name}: ${String(error)}` }
    }
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'Noted. The pane shows the main session list only.' }
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
    if (e.agentId !== undefined) return next(e)
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
    if (e.agentId !== undefined) return next(e)
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
    if (e.agentId !== undefined) return next(e)
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
    if (e.agentId !== undefined) return next(e)
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
    const idle = await read($, idleCalls)
    const isStale = idle >= STALE_CALLS && items.some(i => i.status === 'in_progress')
    const { shown, more } = visibleRows(await read($, sessions))
    const blockRows = shown.length + (more > 0 ? 1 : 0)

    const doing = describeDoing(await read($, activity), now)
    const shownRepos = visibleRepos(await read($, repos))
    const gaugeState = await read($, gauges)

    const available = Math.max(1, (e.props.bodyColumns ?? DEFAULT_COLUMNS + 2 * CARD_PADDING) - 2 * CARD_PADDING)
    const inner = Math.min(MAX_SCENE_COLUMNS, available)
    const gaugeSegments = gaugeState === null ? undefined : formatGauges(gaugeState.readings, now, inner)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? DEFAULT_BODY_ROWS
    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
    const layout = Raster === undefined ? undefined : sceneLayout(available, bodyRows)
    const scene =
      Raster === undefined || layout === undefined ? null : (
        <Raster
          key="scene"
          columns={layout.columns}
          rows={layout.rows}
          cells={sceneCells(layout.columns, layout.firstRow, layout.rows, litWindows(done, total, WINDOWS.length))}
        />
      )

    const sessionBlock = (
      <Box flexDirection="column">
        {shown.map(row => {
          const text = layoutRow(describeRow(row, now), inner)
          const tone = row.state === 'waiting' ? COLORS.accent : row.state === 'busy' ? COLORS.text : COLORS.muted

          return (
            <Text>
              <Text color={tone}>{text.head}</Text>
              <Text color={COLORS.muted}>{text.progress}</Text>
              <Text color={row.state === 'waiting' ? COLORS.accent : COLORS.muted}> {text.detail}</Text>
            </Text>
          )
        })}
        {more > 0 && <Text color={COLORS.muted}>+{more} more</Text>}
      </Box>
    )

    const gaugeLine =
      gaugeSegments === undefined ? null : (
        <Text>
          {gaugeSegments.map(segment => (
            <Text color={segment.tone === 'warn' ? COLORS.warn : segment.tone === 'muted' ? COLORS.muted : COLORS.text}>{segment.text}</Text>
          ))}
        </Text>
      )
    const agentRoom = doing === undefined || doing.agents === '' ? 0 : doing.agents.length + 1
    const doingLine =
      doing === undefined ? null : (
        <Text>
          <Text color={doing.isRunning ? COLORS.active : COLORS.muted}>{truncate(doing.text, Math.max(1, inner - agentRoom))}</Text>
          {doing.agents !== '' && <Text color={COLORS.accent}> {doing.agents}</Text>}
        </Text>
      )
    const repoLines = shownRepos.shown.map(repo => {
      const parts = repoLine(repoName(repo.root), repo.status as NonNullable<Repo['status']>, inner)

      return (
        <Text>
          <Text color={COLORS.muted}>⎇ </Text>
          <Text color={COLORS.text}>{parts.name}</Text>
          <Text color={COLORS.accent}>{`  ${parts.branch}`}</Text>
          <Text color={(repo.status?.changed ?? 0) > 0 ? COLORS.active : COLORS.success}>{`  ${parts.detail}`}</Text>
        </Text>
      )
    })
    const moreLine = shownRepos.more > 0 ? <Text color={COLORS.muted}>+{shownRepos.more} repos</Text> : null
    const wanted = present([gaugeLine, doingLine, ...repoLines, moreLine])
    const strip = wanted.slice(0, stripRoom(bodyRows, layout?.rows ?? 0, blockRows, wanted.length))
    const stripBlock = <Box flexDirection="column">{strip}</Box>
    const room = Math.max(1, bodyRows - CHROME_ROWS - (layout?.rows ?? 0) - blockRows - strip.length)
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
        {scene}
        <Text>
          <Text color={accent}>{filled}</Text>
          <Text color={COLORS.track}>{rest}</Text>
        </Text>
        {total === 0 ? (
          <Box flexDirection="column">
            <Text color={COLORS.muted}>No tasks yet. They appear when Claude plans work.</Text>
            {stripBlock}
            {sessionBlock}
          </Box>
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
            {isStale && <Text color={COLORS.warn}>⚠ no update for {idle} tool calls</Text>}
            {stripBlock}
            {sessionBlock}
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
