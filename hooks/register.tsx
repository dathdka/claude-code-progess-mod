import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, GaugeState, Item, PlanState, PlanView, Repo, SessionRow, TaskStatus, TrackedPlan } from '../types'
import { sceneCells } from './compositor'
import { isOk, mark, parseProgressInput, present, summarize, withReminder } from './helpers'
import { EMPTY_ACTIVITY, begin, callLabel, describeDoing, end, touchedDirectory } from './activity'
import { CARD_PADDING, DEFAULT_COLUMNS, DEFAULT_SOUND_SECONDS, GAUGE_STALE_MS, GIT_POLL_MS, LIST_TOOLS, MAX_SOUND_SECONDS, MIN_SOUND_SECONDS, PLAN_MS, POLL_MS, PROGRESS_TOOL, STALE_CALLS, TELL_USAGE, USAGE_MS, USAGE_PROMPT } from './constants'
import { contextAlarm, formatGauges, freshLimitAlerts, limitName, resetText } from './gauges'
import { CHROME_ROWS, DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout, stripRoom } from './layout'
import { describeRow, layoutRow, newlyWaiting, parseTell, resolveTarget, visibleRows } from './overview'
import { MAX_BYTES, NO_ANNOUNCED, applyDoneRecent, currentPhase, freshPhases, isCleanPlanPath, mergePlans, parsePlan, phaseDoneCount, planPathOf, plansOf, shouldResetFocus, touchPlanState, withLedgerState, withParsed } from './plan'
import type { Announced } from './plan'
import { MAX_LIST_ROWS, phaseLines, phaseNumber, shownFocus, taskLines, toneColor } from './planview'
import type { PlanLine } from './planview'
import { isAllDone, timingText } from './progress'
import { applyReading, cacheRoot, repoLine, repoName, touchRepo, visibleRepos } from './repos'
import type { RootCache } from './repos'
import { playDone, soundPath } from './sound'
import { COLORS, barParts, truncate } from './style'
import { hasSessionIdChanged, pollSessions, publishProgress, removeRecord, resetSyncState } from './sync'
import { findRoot, logOnce, readLedger, readStatus, readUsage, resetWatchState } from './watch'
import { WINDOWS } from './world'

const PANE = 'task-progress'
/** The focus header row besides the phase number and name: a space, a space, `[ ‹ ]`, a space and `[ › ]`. */
const FOCUS_ROW_FIXED = 1 + 1 + 5 + 1 + 5

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
/** The text last parsed for each tracked plan file, so an unchanged file is not parsed again. */
let planTexts: ReadonlyMap<string, string> = new Map()
let isReadingPlan = false
/** The tracked plans at the end of the last read: when one left the list or the phases shrank, a kept focus index would point into another plan. */
let seenPlans: readonly TrackedPlan[] = []
/** A refresh was asked for while a read was running: the read runs once more. */
let isPlanDirty = false
/** Per tracked plan, its phase names and the phases complete at the last read (a phase is news only when it newly joins them). */
let announced: Announced = NO_ANNOUNCED

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [] as Item[])
const startedAt = atom({ plugin: 'task-progress', key: 'startedAt' } as const, 0)
const finishedAt = atom({ plugin: 'task-progress', key: 'finishedAt' } as const, 0)
const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as Item[])
const idleCalls = atom({ plugin: 'task-progress', key: 'idleCalls' } as const, 0)
const sessions = atom({ plugin: 'task-progress', key: 'sessions' } as const, [] as SessionRow[])
const activity = atom({ plugin: 'task-progress', key: 'activity' } as const, EMPTY_ACTIVITY as Activity)
const repos = atom({ plugin: 'task-progress', key: 'repos' } as const, [] as Repo[])
const gauges = atom({ plugin: 'task-progress', key: 'gauges' } as const, null as GaugeState | null)
const planAtom = atom({ plugin: 'task-progress', key: 'plan' } as const, null as PlanState | null)
const viewAtom = atom({ plugin: 'task-progress', key: 'planView' } as const, { view: 'todo', focus: null, pressedAt: 0 } as PlanView)

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

/** A main-session result at every 10th call without a list update while a task is in progress carries a reminder for the model. */
async function remind<T extends { context?: readonly string[] }>($: EngineInterface, ran: T, counted: number): Promise<T> {
  try {
    return withReminder(ran, counted, [...(await read($, todos)), ...(await read($, tasks))])
  } catch {
    return ran // a reminder must never reach the tool call
  }
}

/** A main-session call that is not a list update: one more call without a progress update; the count this call made (0 on a failure), so two calls at once never both see the reminder threshold. */
async function countCall($: EngineInterface): Promise<number> {
  let counted = 0
  try {
    await update($, idleCalls, n => (counted = n + 1))
  } catch {
    // bookkeeping must never reach the tool call
  }

  return counted
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
    // a subagent's reads must not switch the plan the main pane follows
    if (e.agentId === undefined) void notePlan($, e.tool, e as unknown as Record<string, unknown>)
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

/** The tracked plans with the todo list's completed `Task N` entries applied to the one touched last (before any merge, see applyDoneRecent). */
async function appliedPlans($: EngineInterface): Promise<TrackedPlan[]> {
  const items = [...(await read($, todos)), ...(await read($, tasks))]

  return applyDoneRecent(plansOf(await read($, planAtom)), items.filter(i => i.status === 'completed').map(i => i.label))
}

/** One read of one tracked plan file; a failed read, a file too large, or one without tasks keeps that plan's last parse. */
async function readOnePlan($: EngineInterface, path: string): Promise<void> {
  const text = await $.fs.read(path)
  if (typeof text !== 'string' || text.length > MAX_BYTES) return
  const entry = plansOf(await read($, planAtom)).find(t => t.path === path)
  // the plan left the list while the file was read (the text is discarded), or it is unchanged since its last parse
  if (entry === undefined || (entry.plan !== null && planTexts.get(path) === text)) return
  planTexts = new Map([...planTexts, [path, text]])
  const parsed = parsePlan(text, path.slice(path.lastIndexOf('/') + 1))
  if (parsed !== undefined) await update($, planAtom, s => (s === null ? s : { ...s, plans: withParsed(plansOf(s), path, parsed) }))
}

/** Every tracked plan file and its ledger are read, each failure kept to its own file. */
async function readPlansOnce($: EngineInterface): Promise<void> {
  const paths = plansOf(await read($, planAtom)).map(t => t.path)
  planTexts = new Map([...planTexts].filter(([path]) => paths.includes(path)))
  for (const path of paths) {
    await readOnePlan($, path).catch(error => logOnce($, 'could not read a plan file', error))
    const done = await readLedger($, path)
    if (done !== undefined) await update($, planAtom, s => withLedgerState(s, path, done))
  }
}

/** The tracked plan files are read; a request made during a read makes it run once more, so none is dropped. */
async function refreshPlan($: EngineInterface): Promise<void> {
  if (isReadingPlan) {
    isPlanDirty = true
    return
  }
  isReadingPlan = true
  try {
    do {
      isPlanDirty = false
      await readPlansOnce($)
    } while (isPlanDirty)
    const plans = plansOf(await read($, planAtom))
    if (shouldResetFocus(seenPlans, plans)) await update($, viewAtom, (v): PlanView => ({ ...v, focus: null }))
    seenPlans = plans
    await announcePhases($)
  } catch (error) {
    await logOnce($, 'could not read the plan file', error)
  } finally {
    isReadingPlan = false
  }
}

/** Raises one toast per phase that has just become complete; a plan's first read, or a change in its phase names, only sets its baseline. */
async function announcePhases($: EngineInterface): Promise<void> {
  try {
    const applied = await appliedPlans($) // `announced` is read after the last await: overlapping callers never announce twice
    const { fresh, next } = freshPhases(announced, applied)
    announced = next
    for (const phase of fresh) {
      try {
        $.ui.toast(`Phase ${phaseNumber(phase.index)} ${phase.name} done (${phase.total}/${phase.total})`)
      } catch {
        // a toast is a side effect: it must never throw into the session
      }
    }
  } catch {
    // announcing is a side effect: it must never reach the session
  }
}

/** `/task-progress-plan <absolute .md path>` follows only that plan file and pins it, `off` stops following plans. */
async function setPlan($: EngineInterface, args: string): Promise<string> {
  const path = args.trim()
  if (path === 'off') {
    await update($, planAtom, () => null)
    await update($, viewAtom, (v): PlanView => ({ ...v, view: 'todo' }))
    planTexts = new Map()
    announced = NO_ANNOUNCED // the next read of a plan is a silent baseline again

    return 'Plan tracking stopped.'
  }
  if (!path.startsWith('/')) return 'Usage: /task-progress-plan <absolute path to a .md plan> | off (the path must be absolute)'
  if (!isCleanPlanPath(path)) return 'The plan must be a Markdown file (.md) whose path has no control characters.'
  planTexts = new Map()
  const now = await $.clock.now()
  await update($, planAtom, () => ({ plans: [{ path, plan: null, lastTouchedAt: now, done: [] }], isPinned: true }))
  await refreshPlan($)

  return `Following ${path}.`
}

/** The Todo/Plan button: the pane switches to the other view. */
async function toggleView($: EngineInterface): Promise<void> {
  try {
    await update($, viewAtom, (v): PlanView => ({ ...v, view: v.view === 'plan' ? 'todo' : 'plan' }))
  } catch {
    // a button is a side effect: it must never throw into the pane
  }
}

/** The ‹ › buttons: the focus moves one phase (inside the update, so quick presses add up), and the move is dated so it returns to the current phase later. */
async function moveFocus($: EngineInterface, step: number): Promise<void> {
  try {
    const plan = mergePlans(await appliedPlans($))
    if (plan === null) return
    const now = await $.clock.now()
    const count = plan.phases.length
    const current = currentPhase(plan)
    await update($, viewAtom, (v): PlanView => {
      const from = shownFocus(v.focus, v.pressedAt, now, current, count)

      return { ...v, focus: Math.min(count - 1, Math.max(0, from + step)), pressedAt: now }
    })
  } catch {
    // a button is a side effect: it must never throw into the pane
  }
}

/** A tool call touched `path`: when it names a plan file the session also follows it (unless the user pinned one) and reads it at once. */
async function notePlan($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<void> {
  try {
    const path = planPathOf(tool, input)
    if (path === undefined) return
    // appended inside the update, so two touches in a row both land
    const now = await $.clock.now()
    await update($, planAtom, s => touchPlanState(s, path, now))
    if (plansOf(await read($, planAtom)).some(t => t.path === path)) await refreshPlan($)
  } catch {
    // following a plan is a side effect: it must never reach the tool call
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
  await announcePhases($)
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
  planTexts = new Map()
  seenPlans = []
  isReadingPlan = false
  isPlanDirty = false
  announced = NO_ANNOUNCED
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
    await $.command.register({
      name: 'task-progress-plan',
      description: 'Follow a Markdown plan file in the pane: /task-progress-plan <absolute path> | off',
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
    $.clock.every(PLAN_MS, () => {
      void refreshPlan($)
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

  // Counts and records what runs (the stale-list counter and the activity share this one hook: two unmatched hooks are refused). It returns what the tool returns (with a stale-list reminder for the model at every 10th main-session call) and has no `.catch`: a catch handler would
  // call `next` again and run a tool twice when the tool itself throws.
  on('tool.call', async ($, e, next) => {
    if (LIST_TOOLS.includes(e.tool)) return next(e)
    const counted = e.agentId === undefined ? await countCall($) : 0
    callSeq += 1
    const id = `${runId}-${callSeq}`
    await beginCall($, e, id)
    try {
      const ran = await next(e)
      await endCall($, e, id, isOk(ran))

      return e.agentId === undefined && isOk(ran) ? await remind($, ran, counted) : ran
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

  on('command.run', { command: 'task-progress-plan' }, async ($, e) => ({ text: await setPlan($, e.args) })).catch((_$, e, next) => next(e))

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
    const { Box, Button, Text } = ui
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
    const plan = mergePlans(await appliedPlans($))
    const view = await read($, viewAtom)
    const isPlanView = plan !== null && view.view === 'plan'
    const planTasks = plan === null ? 0 : plan.phases.reduce((sum, p) => sum + p.tasks.length, 0)
    const planDone = plan === null ? 0 : plan.phases.reduce((sum, p) => sum + phaseDoneCount(p), 0)
    const planPercent = planTasks === 0 ? 0 : Math.round((planDone / planTasks) * 100)

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
    const strip = wanted.slice(0, stripRoom(bodyRows, layout?.rows ?? 0, blockRows + (plan === null ? 0 : 1), wanted.length))
    const stripBlock = <Box flexDirection="column">{strip}</Box>
    const room = Math.max(1, bodyRows - CHROME_ROWS - (layout?.rows ?? 0) - blockRows - strip.length - (plan === null ? 0 : 1))
    const shownItems = [
      ...items.filter(i => i.status === 'in_progress'),
      ...items.filter(i => i.status !== 'in_progress'),
    ].slice(0, room)
    const barPercent = isPlanView ? planPercent : percent
    const { filled, rest } = barParts(barPercent, inner)
    const barAccent = barPercent === 100 ? COLORS.success : COLORS.accent
    const accent = percent === 100 ? COLORS.success : COLORS.accent
    const height = e.viewport?.rows === undefined ? undefined : Math.max(1, e.viewport.rows - 1)

    const drawLine = (line: PlanLine) => (
      <Text bold={line.isBold} color={toneColor(line.tone)}>
        {line.text}
      </Text>
    )
    const toggleRow =
      plan === null ? null : (
        <Box>
          <Button key="plan-toggle" label={isPlanView ? 'Todo' : 'Plan'} onPress={() => toggleView($)} />
        </Box>
      )
    const current = plan === null ? 0 : currentPhase(plan)
    const focus = plan === null ? 0 : shownFocus(view.focus, view.pressedAt, now, current, plan.phases.length)
    // drawn: padding (2) + bar (1) + toggle row (1) + scene + sessions + strip; the header and the focus header are taken from this room
    const planRoom = Math.max(1, bodyRows - 4 - (layout?.rows ?? 0) - blockRows - strip.length)
    const listRows = plan === null ? 0 : Math.max(1, Math.min(MAX_LIST_ROWS, plan.phases.length, planRoom - 5))
    const headerPrefix = `${planPercent}%  ${planDone}/${planTasks} · `
    // one phase named like the plan: the header and the phase row show the name already
    const isTitlePhase = plan !== null && plan.phases.length === 1 && plan.phases[0]?.name === plan.title
    const planBlock =
      plan === null ? null : (
        <Box flexDirection="column">
          <Text>
            <Text bold color={barAccent}>
              {planPercent}%
            </Text>
            <Text color={COLORS.muted}>
              {'  '}
              {planDone}/{planTasks} · {truncate(plan.title, Math.max(1, inner - headerPrefix.length))}
            </Text>
          </Text>
          {stripBlock}
          {sessionBlock}
          {phaseLines(plan, focus, current, listRows, inner).map(drawLine)}
          <Box>
            <Text color={COLORS.accent}>
              {phaseNumber(focus)}
              {isTitlePhase ? '' : ` ${truncate(plan.phases[focus]?.name ?? '', Math.max(1, inner - phaseNumber(focus).length - FOCUS_ROW_FIXED))}`}{' '}
            </Text>
            <Button key="plan-prev" label="‹" onPress={() => moveFocus($, -1)} />
            <Text> </Text>
            <Button key="plan-next" label="›" onPress={() => moveFocus($, 1)} />
          </Box>
          {taskLines(plan, focus, Math.max(1, planRoom - 2 - listRows), inner).map(drawLine)}
        </Box>
      )

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
          <Text color={barAccent}>{filled}</Text>
          <Text color={COLORS.track}>{rest}</Text>
        </Text>
        {toggleRow}
        {isPlanView ? planBlock : total === 0 ? (
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
