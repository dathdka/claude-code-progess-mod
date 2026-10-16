/** Tool calls without a list update after which the pane warns that it may be stale. */
export const STALE_CALLS = 10
/** How often the other sessions are read. */
export const POLL_MS = 3000
/** How often the session usage is read. */
export const USAGE_MS = 5000
/** How often the tracked repositories are read. */
export const GIT_POLL_MS = 10_000
/** How often the tracked plan file is read. */
export const PLAN_MS = 5000
/** Gauges older than this are hidden when reads keep failing. */
export const GAUGE_STALE_MS = 30_000

/** The tool the pane registers for the model's task list. */
export const PROGRESS_TOOL = 'mcp__task-progress__progress'
export const CARD_PADDING = 1
export const DEFAULT_COLUMNS = 24
export const DEFAULT_SOUND_SECONDS = 12
export const MIN_SOUND_SECONDS = 1
export const MAX_SOUND_SECONDS = 120
export const TELL_USAGE = 'Usage: /task-progress-tell <session name> <message>'
/** The tools that update the list: they reset the stale counter instead of counting. */
export const LIST_TOOLS: readonly string[] = [PROGRESS_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']
export const USAGE_PROMPT = `The user watches a live task-progress pane fed by the ${PROGRESS_TOOL} tool. For any work of 2 or more steps, call it first with the full ordered list, then call it again every time a step starts (in_progress) or finishes (completed) and whenever the plan changes, also in the middle of long runs of tool calls. Keep exactly one task in_progress. Keep every task as its own entry for the whole job: never merge finished tasks into one line and never rename them; a finished task stays in the list as completed, and each call changes statuses only, adding tasks at the end or in place. Never leave the list stale: when the work is done, mark every task completed. When you follow a plan file, tick its - [x] boxes as you finish each step, so the pane's plan view stays current.`
