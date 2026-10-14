# task-progress

Claude Code mod: a pane that tracks the session's todo/task list with a progress bar and percent done. Also puts `tasks x/y · %` on the status line. Slash command: `/task-progress`.

## How it gets its data

- Claude's `TodoWrite` and `TaskCreate`/`TaskUpdate`/`TaskList` calls are picked up automatically.
- The mod also registers its own tool, `mcp__task-progress__progress`, so the pane works in sessions without those tools. The model sends the full list `{ tasks: [{ subject, status }] }` at the start of multi-step work and again when a step starts or finishes.

The pane shows done/total, percent, elapsed time and an ETA, plus a pixel knight that runs while a task is `in_progress`.

## Run from this folder

```
claude --plugin-dir ~/claude-mods/task-progress
```

## Install

```
/plugin install task-progress --marketplace dathdka/claude-code-progess-mod
```
