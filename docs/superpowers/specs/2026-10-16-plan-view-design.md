# Plan view: phases of a long-running plan — design

Status: approved 2026-10-16; implemented as v0.9.0. Builds on Pillar 1 (the strip, v0.8.0) and the pane layout; independent of P2/P4. Requested by the user: a button to see the plan of a session that runs a long plan split into phases, "like the todo list but for a longer run"; the user prefers **focusing on one phase at a time** (example size: 5 phases of 15 tasks).

## Purpose

The todo list shows the model's current steps. A long run has a plan above it: phases, each with many tasks. The pane should show where the run is in that plan without needing 75 rows: all phases as one line each, and only the phase being worked on opened up.

Assumptions (correct me): the plan is a Markdown file on this machine, like those in `docs/superpowers/plans/`; one tracked plan per session; read-only (the mod never edits the plan); other sessions' plans are out of scope for now.

## What the spike established (throwaway mod, deleted)

- In the user's terminal pane a `Button` is pressed by a **mouse click** and by **Tab to it then Enter**. A `hotkey` does **not** work there, so no feature relies on one.
- `ui.press` is matched with `{ plugin, element }`; `e.element` is the Button's `key`.
- `tool.call` carries `file_path` for Read, Edit and Write (Pillar 1 spike), which is how the session's plan file is recognised.
- Not verified: how long a Button stays focused after a press (assumed: until the pane re-renders).

## Scope

In: finding and reading the plan file, parsing phases and tasks, a plan view in the pane with phase focus, buttons to switch view and phase, a phase-complete toast, a command to pick a plan by hand, tests.
Out: editing the plan, plans in other formats than Markdown with headings and checkboxes, showing other sessions' plans, plan history, scene changes.

## Design

### Which plan

The tracked plan is the Markdown file the session last read, edited or wrote whose path is absolute, ends in `.md`, and has a directory named `plan` or `plans` in it. Later touches of another such file replace it. `/task-progress-plan <absolute path>` sets it by hand (a pinned file wins over later touches of other files, until `off` or the end of the session); `/task-progress-plan off` stops tracking. Nothing is tracked until a file qualifies; with no plan the view buttons do not appear.

### The file format understood

A plan is Markdown. Parsing is by headings and checkboxes only:

- **Task:** a `###` heading that has at least one checkbox line (`- [ ]` or `- [x]`) before the next heading of its level or above. Its progress is the checked boxes over all boxes under it. A task with all boxes checked is done. The name is the heading text.
- **Phase:** the nearest `##` heading above the task that has tasks beneath it. A `##` section with no tasks beneath it (`Global Constraints`, `Review Focus`) is not a phase. Tasks with no such `##` above them (as in the plans written so far, where tasks follow a `---` after `## Review Focus`) belong to one phase named after the plan's title (the `#` heading).
- **Rule:** a horizontal rule (`---`) ends the current `##` section, so tasks after one belong to the phase named after the plan (our plans put `---` between `## Review Focus` and the first task and between tasks); that phase persists across further rules.
- **Flat phase:** a `##` heading with checkboxes directly under it and no `###`: each checkbox line is a task of one line (done when checked).
- A plan title is the first `#` heading; without one, the file name.

Limits: file at most 1 MiB, at most 500 tasks and 12 phases read; names cut to 60 characters and stripped of control characters; a file that has no task at all gives no plan.

### A task counts as done

By either signal (the first that holds):
1. all its checkboxes are checked; or
2. the session's own progress list (`progress` tool or `TodoWrite`) has a completed entry whose label starts with `Task <N>` or `Task <N>:` where `<N>` is the number in the heading `Task <N>`.

The second signal exists because plans executed so far leave their boxes unchecked and track progress in the todo list under `Task N: …` labels. The system-prompt section of the mod also gains one sentence asking the model to tick `- [x]` in the plan file as it finishes each step of a plan it follows.

The current task is the first task in plan order that is not done; its phase is the current phase.

### Refresh

The tracked file is read when it is first tracked, every 5 seconds while tracked, and whenever the session writes it (a tool call on it finishing). A read that fails keeps the last plan. The text is parsed again only when it changed.

### The plan view

A button row under the progress bar shows `[ Plan ]` (in todo view) or `[ Todo ]` (in plan view), only when a plan is tracked. The view is a per-session choice, todo by default.

```
Plan: live-gauges   41/75  ▰▰▰▰▰▱▱▱
① Nền tảng       ✔ 15/15
② Gauges         ✔ 15/15
③ Hook & git     ▶ 11/15  ▰▰▰▰▰▰▰▱
④ Trung tâm      ○  0/15
⑤ Trợ lý AI      ○  0/15
──────────────────────────
③ Hook & git      [ ‹ ]  [ › ]
✔ 9 done
✔ 10 Hook activity
▶ 11 Dòng đang làm gì
○ 12 Git theo repo
○ 13 Dòng nhánh
… +2
```

- **Phase list:** one line per phase: number, name, state mark (`✔` all done, `▶` current phase, `○` otherwise), done/total tasks, and a 8-cell bar for the focused and the current phase only. With more phases than fit, the list scrolls to keep the focused phase visible.
- **Focused phase:** its name between the two buttons, then its tasks. Tasks done before the current one collapse into `✔ N done` plus the one most recently done; the current task is marked `▶`; then the next tasks until the rows run out, then `… +N`. In a phase that is not the current one, the first tasks of the phase show from the top, with done ones collapsed the same way.
- **Buttons:** `‹` and `›` move the focus one phase (stopping at the ends); they are pressed by click or by Tab and Enter. A press sets the focus and the time of the press. Sixty seconds after the last press the focus returns to the current phase by itself; while no press has happened the focus is the current phase.
- Overall `done/total` counts tasks; the bar is over all tasks.

The scene, the sessions block and the Pillar 1 strip are unchanged and keep their rows; the plan view takes the rows the task list took. The scene's windows keep following the todo list (open question 1).

### Toast

When a phase goes from not complete to complete, a toast `Phase ③ Hook & git done (15/15)`, once per phase per tracked plan, never for phases already complete when the plan is first read. Sent in a `try`/`catch` that swallows its own errors.

### Units

- `plan.ts` (pure): `parsePlan(text, fileName) -> Plan | undefined`, `applyDone(plan, labels) -> Plan` (signal 2), `currentPhase(plan) -> number`, `planPathOf(tool, input) -> string | undefined`.
- `planview.ts` (pure): `phaseRows(plan, focus, rows)` and `taskRows(plan, focus, rows)`, giving the lines as plain data (mark, text, tone).
- `register.tsx` (wiring): atoms `plan` (the parsed plan and its path), `planView` (view and focus and press time); the `tool.call` hook gains the plan-path capture; a 5 s read; `ui.press` hook for the three button keys; the command; layout rows.
- Types in `types/index.d.ts`: `Plan`, `Phase`, `PlanTask`, `PlanView`.

## Budgets and limits

- A read and parse of a 500-task file under 5 ms; a tick under 100 ms.
- The plan view uses no more rows than the task list it replaces; phase list at most 8 rows, the focused phase at least 3.
- No new colour pairs (text only).

## Error handling

A missing, unreadable, oversized or malformed file keeps the last plan and logs once to the debug channel; with no plan yet, nothing shows. A path from a tool input must be absolute, clean of control characters and end in `.md`. The read goes through `$.fs.read`, never a shell. Nothing here throws into the session, a tool call or the render hook.

## Testing

- `plan.test.ts`: our own plan layout (tasks under `###` with no `##`), a plan with `## Phase` sections of `###` tasks, flat checkbox phases, sections without tasks ignored, nested bullets and code fences containing `- [ ]` (not counted: boxes inside a fence are skipped), a file with no task, CRLF line endings, names cut and cleaned, limits (500 tasks, 12 phases), signal 2 (`Task 4: …` completed marks `### Task 4: …` done; a different number does not), current task and phase.
- `planview.test.ts`: the phase list and focused phase for 5×15 at several row budgets; collapse of done tasks; `… +N`; focus at the first and last phase; the list scrolling with more than 8 phases; a plan that is fully done.
- `register.test.ts`: the plan path is captured from Read, Edit and Write on a `plans/` file and ignored elsewhere; the buttons appear only with a plan; pressing `Plan` and `Todo` switches the view; `‹` `›` move and stop at the ends; the focus returns after 60 s; the file is re-read every 5 s and on a write; a failing read keeps the plan; the phase toast fires once and not for already complete phases; the command sets and clears the plan; the view fits a short pane.
- Existing tests stay green.

## Success criteria

1. After the session opens a plan file, the `[ Plan ]` button appears within 5 s; a click or Tab and Enter switches to the plan view.
2. In a 5×15 plan the view shows all five phases and the focused phase's current task without scrolling, in a pane of 35 rows.
3. Finishing a task (ticking its boxes, or completing its `Task N` entry in the todo list) updates the view within 5 s; finishing a phase raises one toast.
4. `‹` and `›` browse the phases, and the focus returns to the current phase on its own.
5. A missing or broken file never disturbs the session.

## Open questions

1. Should the scene's windows follow the plan's overall progress while a plan is tracked? Proposed: no, they keep following the todo list for now (one rule to explain); it is a one-line change later.
2. Phase names are the `##` headings as written (for example `Phase 3: Hook & git`); the circled numbers come from their order. Proposed: keep the heading text and show the number from order only when the heading has none.

## Amendment 1 (2026-10-16, after the first look in a real pane): every plan of the session is a phase

Seen: a session that ran four plans (citadel, session overview, live gauges, plan view) showed one phase, the last plan read, because the view followed a single file and our plans have no `##` phases. The user chose to make **each plan file the session touched a phase**.

- **Tracked set:** the session's tracked plans are an ordered list of absolute paths, in order of first touch (a Read, Edit or Write by the main session on a qualifying `.md`, as before; subagents never add one). At most 10 are kept; a new one beyond that drops the plan touched least recently (display order stays the order of first touch). A touch of an already tracked plan changes nothing in the order.
- **Pin:** `/task-progress-plan <path>` replaces the list with that one path and pins it (touches no longer add plans); `/task-progress-plan off` clears the list and the pin.
- **Merged plan:** the view draws one merged plan: for each tracked plan that has parsed, its phases in order. When only one plan has parsed, it is drawn unchanged (its own title, its phase names as written). From two parsed plans on, a plan with a single phase contributes that phase named by its title and a plan with several phases contributes them named `<title>: <phase>` (cut to 60). The header title is the plan's title when one plan has parsed, else `N plans` (counting parsed plans). Everything else (done signals, current phase, focus, buttons, windows of rows) works on the merged plan unchanged.
- **Refresh:** every tracked file is read every 5 seconds (a failed or junk read keeps that plan's last parse) and a tracked file the session writes is read at once.
- **Toast:** announcement is per tracked plan: a plan seen for the first time, or whose phase names changed, is a silent baseline for its own phases; others announce as before. Keys include the path.
- **Headings:** with a single phase whose name equals the title, the focus header row does not repeat the name.
- **Todo `Task N` signal:** completed `Task N` labels apply only to the tracked plan touched most recently (a tie goes to the later one in the list), since `Task N` numbers repeat across plans.

## Amendment 2 (2026-10-16): the ledger as a third done-signal, and a reminder for the model

- **Third signal:** a plan at `<root>/docs/superpowers/plans/<name>.md` is also marked done task by task from the subagent-driven ledger `<root>/.superpowers/sdd/<name>/progress.md`: a line starting `Task N: complete` marks `Task N` of that plan (and only that plan) done. It is read with the plan on the same 5 second cadence; a missing ledger is normal; numbers once seen stay done after the ledger is removed. Toasts and baselines treat it like the other signals.
- **Reminder for the model** (not specific to plans): when the pane would show `⚠ no update for N tool calls` (a task in progress and 10 main-session calls without a list update), the result of that tool call also carries a reminder in its `context` field, which only the model reads; again at 20, 30, and so on. A subagent's calls neither count nor get it.
