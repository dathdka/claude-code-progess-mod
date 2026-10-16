# task-progress

Claude Code mod: a pane that tracks the session's todo/task list with a progress bar and percent done. Also puts `tasks x/y · %` on the status line. Slash commands: `/task-progress` and `/task-progress-tell`.

## How it gets its data

- Claude's `TodoWrite` and `TaskCreate`/`TaskUpdate`/`TaskList` calls are picked up automatically.
- The mod also registers its own tool, `mcp__task-progress__progress`, so the pane works in sessions without those tools. The model sends the full list `{ tasks: [{ subject, status }] }` at the start of multi-step work and again when a step starts or finishes.

The pane shows done/total, percent, elapsed time and an ETA, under a pixel-art citadel scene (an Erdtree at sunset behind a great citadel). The citadel has 16 windows, all dark at rest; they light up as tasks finish and all glow when the list is done. The scene is 96 columns x 16 rows, cropped around the centre in narrower panes and from the top in shorter ones; a pane that is too small shows the text layout alone.

The scene is generated: `python3 tools/gen-world.py [--preview out.png]` rewrites `hooks/world.ts` (needs Python 3 and Pillow).

## Keeping the list current

The model has to call `progress` itself, so the mod nudges it four ways:

- A system-prompt section tells the model to send the full list before work of 2+ steps and to update it whenever a step starts or finishes.
- After 10 tool calls of the main session without a list update, while a task is `in_progress`, the pane shows `⚠ no update for N tool calls`.
- At the same moments (10, 20, 30… calls) the tool result also carries a short reminder only the model reads, asking it to call `progress` with the full list.
- Calls made by subagents never change the pane list (they get an acknowledgement and nothing else).

## Other sessions

Every session with the mod publishes its progress to `~/.claude/task-progress/<sessionId>.json` (or under `$CLAUDE_CONFIG_DIR`), and each pane reads Claude Code's own session list plus those files every 3 seconds. Under the timing line it shows up to 5 other sessions, one row each:

```
◆ Sync giá AI   ▰▰▰▰▱▱ 3/5   chờ bạn 4m
▶ vntrip-25     ▰▰▱▱▱▱ 2/6   Write the compositor
· docs          ▰▰▰▰▰▰ 3/3   xong
```

`◆` is a session that is idle and not finished (work left, or no task list yet), `▶` is busy, and `·` is anything else: a finished idle session (`xong`) or a status the mod does not know (shown as `<status> <age>`). A session without the mod shows its state only. Past 5 rows the pane adds `+N more`. When a session goes from busy to idle a toast says so; option `isWaitSoundOn` (default off) also plays the jingle. Message a session with `/task-progress-tell <name prefix> <message>`: the first word is matched as a prefix of the session name or id (an exact name wins; an ambiguous prefix lists the candidates with their id), and the rest is the message. Files of ended sessions are removed when they end, and files left by crashed ones after a day.

## Live strip

Under the timing line the pane shows up to five lines about the running session:

```
ctx ▰▰▰▰▰▱▱▱ 62%   5h ▰▰▱▱ 31%   7d ▰▱▱▱ 9%
▶ Edit register.tsx 4s   +1 agent
⎇ core-inventory-service  dev-dat-rate-sheet  ●1
⎇ admin-v3  dev-dat-rate-sheet-duplicate-fixes  ●8 ↑2
```

- **Gauges:** context fill and the 5-hour and 7-day quota windows, read from the session usage every 5 seconds. A figure at 80% or more turns red; a quota window that high also shows when it resets (`↻2h10m`). A window with no reading is left out; if reads keep failing the line goes after 30 seconds.
- **Doing:** the main session's oldest running tool call (with its time once it passes 2 seconds), or the last call for a minute after it ends; `+N agents` counts subagents seen in the last 15 seconds. The progress and list tools are never shown.
- **Repositories:** one line per repository the session or a subagent has edited with `Edit`, `Write`, `NotebookEdit` or `MultiEdit` (shell commands do not count): the repository's name, its branch, `●N` changed files (tracked changes and untracked files), `✓` when clean, `↑a`/`↓b` against its upstream. Up to 3 repositories show; from 4 on, 2 show and `+N repos` counts the rest. Status is read every 10 seconds with `git --no-optional-locks status`, so it never takes the lock your own git commands need; at most 6 repositories are tracked.
- **Toasts:** `ctx 82% · consider /compact` once per crossing of 80% (re-armed below 70%), and `5h limit 91% · resets in 40m` once per window at 90%. Option `isContextWarningOn` (default on) turns both off.

A pane too short for the whole strip drops lines from the bottom and always keeps one task row.

## Plan view

For a run that follows a long Markdown plan, the pane can show the plan instead of the todo list. A `[ Plan ]` button appears under the progress bar once the session reads, edits or writes a `.md` file in a `plan` or `plans` directory, or after `/task-progress-plan <absolute path to a .md file>`. Every such file the main session touches is tracked (in order of first touch, at most 10, the one touched least recently dropped first) and becomes a phase of one merged plan: a plan with one phase shows as one phase named after it, a plan with several `##` phases adds them as `<plan title>: <phase>` (only when two or more plans have been read; one plan shows its phases as written); the header names the plan, or `N plans`. `/task-progress-plan <path>` replaces the list with that one file and pins it (touches add nothing until `/task-progress-plan off`, which clears the list). A completed `Task N` todo entry marks `Task N` only in the plan the session touched most recently, since numbers repeat across plans. Click it, or Tab to it and press Enter; hotkeys are not used.

```
Big plan   41/75  ▰▰▰▰▰▱▱▱
① Base        ✔ 15/15
② Gauges      ✔ 15/15
③ Hook & git  ▶ 11/15 ▰▰▰▰▰▰▰▱
④ Centre      ○  0/15
⑤ Helper      ○  0/15
③ Hook & git  [ ‹ ] [ › ]
✔ 9 done
✔ Task 10: Hook activity
▶ Task 11: Doing line  0/3
○ Task 12: Git
… +3
```

- **How the file is read:** a `###` heading with checkboxes under it is a task (done when all its boxes are ticked); a `##` heading with tasks beneath it is a phase; a `---` line ends a `##` section, so tasks after it (as in the plans under `docs/superpowers/plans/`) form one phase named after the plan; boxes directly under a `##` heading are one-line tasks; code fences are ignored. Limits: 1,000,000 characters, 500 tasks, 12 phases; names are cut to 60 characters.
- **Done also when** the session's todo list has a completed entry starting with `Task N` for the task `### Task N: …` (todo entries count for the plan touched most recently only), or when the plan's subagent-driven ledger reports it: for a plan at `<root>/docs/superpowers/plans/<name>.md`, the file `<root>/.superpowers/sdd/<name>/progress.md` with a line `Task N: complete …` (fix-round lines do not count). The ledger is read with the plan, every 5 seconds; tasks it reported stay done after it is removed. The system prompt also asks the model to tick the boxes of the plan it follows.
- **Focus:** the pane opens the phase being worked on (the first with an unfinished task). `‹` and `›` move one phase and stop at the ends; a minute after the last press the focus returns by itself. Finished tasks before the current one collapse into `✔ N done`.
- **Refresh:** every tracked file is read every 5 seconds and when the session touches it. A file that cannot be read keeps its last plan.
- **Toast:** `Phase ③ Hook & git done (15/15)`, once per phase; phases already complete when a plan is first read are not announced.

## Completion sound

When every task in the list is completed, a short jingle plays once (`sounds/done.wav`). It uses the first player that works: `afplay` (macOS), then `pw-play`, `paplay`, `aplay`, `ffplay`. Options (`/config` or `pluginConfigs`):

- `isSoundOn` (default on)
- `soundFile`: absolute path to your own audio file instead of the bundled jingle
- `maxSeconds` (default 12, 1-120): a longer clip is cut after this many seconds

## Run from this folder

```
claude --plugin-dir ~/claude-mods/task-progress
```

## Install

```
/plugin install task-progress --marketplace dathdka/claude-code-progess-mod
```
