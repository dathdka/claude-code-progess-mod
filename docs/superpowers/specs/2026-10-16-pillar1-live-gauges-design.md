# Pillar 1: Live gauges — design

Status: approved 2026-10-16; implemented as v0.8.0. Pillar 1 of the long-term roadmap approved 2026-10-16 (order: 1 live gauges → 2 command centre → 5 AI helper; the ledger and the living scene are parked). Builds on P1 (scene and pane layout) and P3 (sessions block); needs neither P2 nor P4.

## Purpose

The pane tells the user how many tasks are done but not what the session is doing right now, how close it is to running out of context or quota, or which repositories it has changed. The user works in a workspace of about 40 service repositories, so the third question matters most. Chosen by the user: a compact strip under the progress line, scene unchanged, three kinds of content: (1) context and quota, (2) what the session is doing, (3) the working branches of the repositories this session has touched. Test results and session cost were offered and not chosen.

Assumptions (correct me): everything is local; the strip is read-only; subagents work for the session, so their edits count as the session's.

## What the spike established (throwaway mod, deleted; run with `claude -p`)

- `$.session.usage()` takes about 1 ms and returns `context {tokens, window, percent}`, `rateLimits [{kind: 'five_hour' | 'seven_day', percentUsed, resetsAt}]` with real numbers on the user's plan, and `cost {usd}`.
- A global `tool.call` hook sees every call, including the mod's own `progress` tool. `e.file_path` (Read, Edit, Write), `e.command` (Bash) and `e.tool_use_id` are on the event. `e.agentId` is set only on a subagent's calls, one id per subagent. A synchronous `Agent` call lasts as long as the subagent runs; a background one returns at once.
- `$.process.run` returns `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`. `git rev-parse --show-toplevel` took about 4 ms and `git status --porcelain -b` about 14 ms, in the user's largest repositories.
- The validator accepts `$` only in calls to functions declared at the top of the file or imported from the module's own files, not to closures inside `register`.
- Not verified: how a permission prompt shows in the in-flight list (it is a tool call not yet started; assumed to appear when the call enters the hook).

## Scope

In: the strip, the three data sources, a context warning toast, tests.
Out: test results, cost, repositories this session has not touched, clicking or any control (Pillar 2), publishing the gauges to other sessions, history (parked ledger).

## Design

### The strip

Under the timing line and above the sessions block. Up to five lines, in this priority when space is short (the lower ones drop first):

```
ctx ▰▰▰▰▰▱▱▱ 62%   5h ▰▰▱▱ 31%   7d ▰▱▱▱ 9%
▶ Edit register.tsx        +1 agent
⎇ core-inventory-service  dev-dat-rate-sheet  ●1
⎇ admin-v3  dev-dat-rate-sheet-duplicate-fixes  ●8 ↑2
```

1. **Gauges.** `ctx` uses `context.percent` (else `tokens / window`). `5h` and `7d` use the two rate-limit kinds; a kind with no reading is omitted, and with no reading at all and no context figure the line is absent. A bar of 8 cells (ctx) or 4 cells (limits). At 80% or more the figure takes the warning colour; a limit at 80% or more also shows its reset as `↻2h10m` after the figure.
2. **Doing.** The oldest call of the main session still running, as `▶ <tool> <target>` where target is the file's base name, or the first 30 characters of a Bash command, or the tool name with an `mcp__<server>__` prefix removed. A call running more than 2 s shows its elapsed time. When nothing runs: `· <last tool and target> <age>` for up to 60 s, then the line is absent. `+N agent(s)` on the right counts distinct subagent ids seen in the last 15 s or with a call still running. The mod's own `progress` and the list tools are never shown.
3. **Repositories.** One line per repository this session has touched, most recently touched first, up to 3; from 4 on, 2 are shown and `+N repos` counts the rest, so the strip stays at 5 lines at most: the repository directory's name, its branch, `●N` changed files (tracked changes and untracked files, from `git status --porcelain`), `↑a` / `↓b` when ahead of or behind its upstream; a clean repository shows `✓` instead of `●0`. A detached head shows `(detached)`. A line that does not fit the width is cut in the middle of the branch name, never the repository name.

A repository is touched when the session or one of its subagents runs `Edit`, `Write` or `NotebookEdit` on a file whose directory lies inside it. Reads and Bash commands do not count (a command's effect cannot be read reliably from its text).

### Units

- `gauges.ts` (pure): `contextPercent(usage)`, `limitReadings(usage)`, `formatGauges(readings, width) -> line | undefined`, `crossedContextLimit(prev, next)` with the hysteresis below.
- `activity.ts` (pure reducer over events): `begin(id, tool, target, at)`, `end(id)`, `seenAgent(agentId, at)`, `describeDoing(state, now)`, `agentCount(state, now)`, `touchedDirectory(tool, input)`; targets are sanitised (control characters removed) before they are stored.
- `repos.ts` (pure): `parseStatus(stdout) -> { branch, changed, ahead, behind }` (handles `## branch...upstream [ahead 2, behind 1]`, `## No commits yet on x`, `## HEAD (no branch)`), `formatRepoLine(name, status, width)`, a bounded cache `directory -> root` of the 200 newest directories, successes only (a failed lookup is retried at the next edit).
- `watch.ts` (wiring, impure like `sync.ts`): publishes the three values into `$.state` atoms. Calls go through top-level functions that take `$`.
- `register.tsx`: a global `tool.call` hook that records begin/end and always returns `next(e)` unchanged, the timer, the strip, the toast, and layout use. `types/index.d.ts` gets the three new state values.

### Data flow

- **Activity.** In the `tool.call` hook: record `begin`, `try { return await next(e) } finally { end }`. The hook never alters the call or its result and never throws. It adds no tool latency beyond one function call. An `Edit`/`Write`/`NotebookEdit` with an absolute path queues that path's directory for resolution.
- **Usage.** `$.clock.every(5000)`: read `$.session.usage()` into an atom. A failed read keeps the last value for 30 s, then hides the gauges line.
- **Repositories.** On the first touch of a directory, resolve its root with `git -C <dir> rev-parse --show-toplevel` (skip a path that is relative or whose directory is missing, so a new file in a not yet existing directory is retried on the next touch). Track at most 6 repositories, dropping the least recently touched. Every 10 s, and once right after a repository is first tracked, run `git --no-optional-locks -C <root> status --porcelain -b` for each, one after another, with a 3 s time limit each. `--no-optional-locks` is required so the poll never takes the index lock the user's own git commands need. `isStdoutTruncated` makes that repository's reading skipped for the poll. A failing repository keeps its previous reading, and is dropped after three failures in a row.
- **Argument safety.** Processes are started with an argument array, never a shell. Directory arguments must start with `/`.

### Context warning

A toast `ctx 82% · consider /compact` when the context passes 80% upward, once per crossing; it re-arms when the figure falls below 70%. A toast `5h limit 91% · resets in 40m` when a limit passes 90%, once per reset time. Toasts are sent inside a `try`/`catch` that swallows its own errors. Option `isContextWarningOn` (default on) turns both off.

### Pane layout

The strip's lines are added to the rows the sessions block already borrows from the task list: `room = bodyRows − 7 − sceneRows − stripRows − blockRows`, at least 1. In a pane too small for the scene the strip still shows, gauges first. P1's rule that the info zone keeps at least 15 rows is unchanged. Colour pairs and the 3 ms scene budget are unaffected (the strip is text).

### Headless sessions

As with P3, a `claude -p` run starts the same timers. The strip costs one 1 ms call per 5 s and git only for repositories the run edited. A run that edits nothing starts no git process.

## Budgets and limits

- Per 10 s: at most 6 git processes, each under 50 ms in the spike's repositories. Per 5 s: one usage read.
- One tick must finish under 100 ms; the `tool.call` hook under 1 ms.
- The strip is at most 5 lines and at most the pane's width.

## Error handling

Every call in this feature is wrapped. A failed usage read, a failed git process, a malformed status or a throwing toast logs once to the debug channel and changes nothing else. No exception reaches the session, the tool call, or the render hook. Strings from tool inputs and git output are stripped of control characters before they are drawn.

## Testing

- `gauges.test.ts`: percent from `percent` or from `tokens/window`; missing kinds omitted; bar fill at 0, 62, 100; warning at 80; reset text; no data gives no line; hysteresis (80 up fires, 79 and 85 do not, below 70 re-arms, 80 fires again).
- `activity.test.ts`: oldest running call shown; elapsed time past 2 s; last-finished line for 60 s then absent; target forms (file, Bash command cut at 30, `mcp__x__tool` prefix); the progress and list tools are ignored; agent count by distinct id over 15 s and by running call; control characters removed; `touchedDirectory` for Edit, Write, NotebookEdit, and none for Read, Bash, relative paths.
- `repos.test.ts`: the status forms above, a count of tracked plus untracked files, a clean repository, a detached head; the cache returns and evicts; a line is cut inside the branch name only.
- `register.test.ts`: the strip is drawn from mocked usage, a tool call and a repository; the three lines drop from the bottom in a short pane; usage failure hides the gauges after 30 s; a git failure keeps the previous reading and drops after three; the toast fires once per crossing and not when the option is off; the `tool.call` hook returns the call's own result unchanged, also when the tool throws; a subagent call adds to the agent count and not to the main line; existing tests stay green.

## Success criteria

1. With a real session, the strip shows context and both limits within 5 s of opening the pane, matching `/status`.
2. While a long tool runs the strip names it; when a subagent runs it shows `+1 agent`.
3. After the session edits a file in a repository, that repository's line appears within 10 s with the right branch and changed-file count, and a second repository adds a second line.
4. The user's own `git commit` in a tracked repository is never blocked by the poll.
5. No exception reaches the session when usage fails, git is missing, or a path has odd characters.

## Open questions

1. Untracked files count toward `●N`. The alternative is tracked changes only (the spike's `search-engine-service` has stray untracked CSV files that would inflate it). Proposed: count them, since they are work in progress, and revisit if it feels noisy.
2. Up to 3 repository lines make the strip 5 lines high in the worst case. Proposed: accept, since the user asked for the working branches across services.
