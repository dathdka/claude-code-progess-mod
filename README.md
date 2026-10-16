# task-progress

Claude Code mod: a pane that tracks the session's todo/task list with a progress bar and percent done. Also puts `tasks x/y · %` on the status line. Slash commands: `/task-progress` and `/task-progress-tell`.

## How it gets its data

- Claude's `TodoWrite` and `TaskCreate`/`TaskUpdate`/`TaskList` calls are picked up automatically.
- The mod also registers its own tool, `mcp__task-progress__progress`, so the pane works in sessions without those tools. The model sends the full list `{ tasks: [{ subject, status }] }` at the start of multi-step work and again when a step starts or finishes.

The pane shows done/total, percent, elapsed time and an ETA, under a pixel-art citadel scene (an Erdtree at sunset behind a great citadel). The citadel has 16 windows, all dark at rest; they light up as tasks finish and all glow when the list is done. The scene is 96 columns x 16 rows, cropped around the centre in narrower panes and from the top in shorter ones; a pane that is too small shows the text layout alone.

The scene is generated: `python3 tools/gen-world.py [--preview out.png]` rewrites `hooks/world.ts` (needs Python 3 and Pillow).

## Keeping the list current

The model has to call `progress` itself, so the mod nudges it three ways:

- A system-prompt section tells the model to send the full list before work of 2+ steps and to update it whenever a step starts or finishes.
- After 10 tool calls of the main session without a list update, while a task is `in_progress`, the pane shows `⚠ no update for N tool calls`.
- Calls made by subagents never change the pane list (they get an acknowledgement and nothing else).

## Other sessions

Every session with the mod publishes its progress to `~/.claude/task-progress/<sessionId>.json` (or under `$CLAUDE_CONFIG_DIR`), and each pane reads Claude Code's own session list plus those files every 3 seconds. Under the timing line it shows up to 5 other sessions, one row each:

```
◆ Sync giá AI   ▰▰▰▰▱▱ 3/5   chờ bạn 4m
▶ vntrip-25     ▰▰▱▱▱▱ 2/6   Write the compositor
· docs          ▰▰▰▰▰▰ 3/3   xong
```

`◆` is a session that is idle and not finished (work left, or no task list yet), `▶` is busy, and `·` is anything else: a finished idle session (`xong`) or a status the mod does not know (shown as `<status> <age>`). A session without the mod shows its state only. Past 5 rows the pane adds `+N more`. When a session goes from busy to idle a toast says so; option `isWaitSoundOn` (default off) also plays the jingle. Message a session with `/task-progress-tell <name prefix> <message>`: the first word is matched as a prefix of the session name or id (an exact name wins; an ambiguous prefix lists the candidates with their id), and the rest is the message. Files of ended sessions are removed when they end, and files left by crashed ones after a day.

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
