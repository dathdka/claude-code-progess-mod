# task-progress

Claude Code mod: a pane that tracks the session's todo/task list with a progress bar and percent done. Also puts `tasks x/y · %` on the status line. Slash command: `/task-progress`.

## How it gets its data

- Claude's `TodoWrite` and `TaskCreate`/`TaskUpdate`/`TaskList` calls are picked up automatically.
- The mod also registers its own tool, `mcp__task-progress__progress`, so the pane works in sessions without those tools. The model sends the full list `{ tasks: [{ subject, status }] }` at the start of multi-step work and again when a step starts or finishes.

The pane shows done/total, percent, elapsed time and an ETA, plus a pixel-art singer portrait that sings (mouth moves, notes float) while Claude Code is working and celebrates when all tasks are done.

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
