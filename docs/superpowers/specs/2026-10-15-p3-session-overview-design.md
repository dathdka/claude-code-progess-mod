# P3: Session overview — design

Status: approved by the user 2026-10-15; rev 2 settles the open questions and three implementation details (marked *rev 2*). Part 3 of 4 of the task-progress redesign; builds on P1 (the citadel scene and pane layout, implemented, uncommitted). P2 (ledger) is not required.

## Purpose

Each Claude Code session loads its own copy of the mod, so a pane today shows only its own task list. The user runs several sessions at once and wants, from any one pane, to see **what every other session is doing and which of them is waiting for them**, with almost no text.

Chosen by the user: for each other session show (1) state and name, (2) task progress, (3) a "waiting for you" alert, (4) a quick way to reach it.

Assumptions (correct me): everything is local to this machine and this user; sessions without the mod still appear, with state only; the pane stays the only surface; no backend.

## What the spike established (throwaway mod, deleted)

Run on two concurrent `claude -p` processes started 3 s apart, each writing its own record, waiting, then reading everyone's:

- `$.fs.write` to an absolute path outside the working directory works; `$.fs.list` and `$.fs.read` read `~/.claude/sessions/*.json` and the shared directory.
- Both a file and a `$.store` key written by one running session were visible to another running session. `$.store` is one JSON file (4 MiB cap) for the whole plugin, so concurrent writers share one file; it also kept dead sessions' keys.
- `$.process.run(['kill','-0',pid])` works.
- A `command.run` hook is cut at 10 s. Periodic work uses `$.clock.every`.
- `~/.claude/sessions/<pid>.json` exists only while the process runs (the spike's `-p` entries were gone after they exited). Fields used here: `sessionId`, `pid`, `name`, `cwd`, `kind`, `status` (`busy` or `idle` seen), `statusUpdatedAt`, `updatedAt`, `startedAt`.
- Not verified: what `$.session.send` shows the recipient and whether it can bring a terminal window forward (it cannot be assumed to).

## Scope

In: publishing own progress, reading all sessions, a "Sessions" block in the pane, the waiting alert, a command to message another session, cleanup, tests.
Out: P2 ledger, P4 metrics, focusing another terminal window, any network or cloud sync, history of finished sessions.

## Design

### Data

Two sources, joined by `sessionId`:

1. **Registry** (read only, owned by Claude Code): `~/.claude/sessions/<pid>.json` gives name, cwd, kind, status, `statusUpdatedAt`. Presence of the file means the session is alive.
2. **Progress file** (written by this mod): `~/.claude/task-progress/<sessionId>.json`, one writer per file:

```json
{ "v": 1, "sessionId": "…", "done": 3, "total": 5, "current": "Write the compositor", "updatedAt": 1792037591000 }
```

`current` is the label of the first `in_progress` task, cut to 60 characters; empty when none. A session without the mod has a registry entry and no progress file: it shows state only.

Why per-session files and not `$.store`: one writer per file cannot lose another session's data; the store is one shared file.

### Units

- `share.ts` (pure): `progressRecord(items, now) -> Record`, `parseRecord(text) -> Record | undefined` (rejects bad JSON, wrong `v`, non-numeric fields), `parseRegistry(text) -> RegistryEntry | undefined`.
- `overview.ts` (pure): `buildRows(self, entries, records, now) -> Row[]` joins the two sources, drops the own session and entries of another `kind` than `interactive`, orders and trims (below).
- `register.tsx` (wiring): publishes on every list change and at start, polls every 3 s with `$.clock.every`, keeps rows in a `$.state` atom so the pane redraws, removes the own file at `session.end`, draws the block.

### Publishing

`refreshStatus` already runs on every list change: it also writes the progress file with `$.fs.write` (failure is swallowed and logged once to the debug channel; the side effect must never throw into the session). A session that has no tasks writes `done: 0, total: 0`. At `session.end` the ending session's file is deleted, best effort. The file API cannot delete, so this and the cleanup below run `rm -f <file>` through `$.process.run` *(rev 2)*.

### Reading and cleanup

Every 3 s: list the registry directory and read at most 12 of its `*.json`, list the progress directory and read only the records of those live sessions (at most 24 reads in all), build rows. A progress file with no live registry entry is ignored and removed when its file's modification time (from the directory listing, no read needed) is older than 24 h, by whichever session sees it first; removing an already removed file is not an error *(rev 2)*. A registry entry left behind by a crash is shown until its file goes; no extra liveness check in P3.

Unreadable or half-written files are skipped for that poll (a write is not atomic) and retried at the next one.

### Rows and order

One row per other session. Order: sessions **waiting for you** first (status `idle`, longest wait first by `statusUpdatedAt`), then `busy` ones (most recently started first), then any other status. Shown up to 5 rows, then `+N more`. With no other session the block takes no rows.

Row content, left to right: state mark, name (cut), a 6-cell bar with `done/total`, then the current task or the wait time:

```
◆ Sync giá AI   ▰▰▰▱▱▱ 3/5   chờ bạn 4m
▶ vntrip-25     ▰▰▱▱▱▱ 2/6   Write the compositor
· docs          ▰▰▰▰▰▰ 3/3   xong
```

Marks: `◆` waiting for you (accent colour), `▶` busy, `·` other. A session whose progress file shows `done == total > 0` and is idle reads `xong` instead of a wait time.

### Pane layout

The block sits under the timing line and above the task list. P1's layout rule keeps at least 15 rows for the info zone; the block borrows from the task list's rows (`room = bodyRows − 7 − sceneRows − blockRows`, at least 1). In a pane too small for the scene the block still shows.

### Waiting alert

When another session changes from `busy` to `idle`, its row is highlighted and a toast says `◆ <name> waiting for you` (the status line is already taken by the task counts) *(rev 2)*. Option `isWaitSoundOn` (default off) plays the existing jingle once per transition, reusing `sound.ts`. No alert fires on the first poll (existing idle sessions are not news).

### Messaging another session

Command `/task-progress-tell <name-prefix> <text>`: resolves the prefix against the row names (unique match required, else an error text listing candidates) and calls `$.session.send({ to: { sessionId }, text })`. It does not focus a window. The recipient sees the text inside the engine's message envelope (to be confirmed with two interactive sessions at implementation time).

## Budgets and limits

- Poll: 2 directory listings and at most 24 file reads per 3 s; a tick must finish well under 100 ms.
- Progress file: under 400 bytes.
- No change to P1's budgets (colour pairs, render time).

## Error handling

Every filesystem call in this feature is wrapped: a failure skips the poll or the write, logs once to the debug channel, and never throws into the session or the render hook. A missing directory is created on the first write. A malformed record is ignored.

## Testing

- `share.test.ts`: round trip; rejects bad JSON, wrong version, wrong types; `current` cut at 60.
- `overview.test.ts`: join by `sessionId`; own session and non-interactive kinds dropped; order (waiting by longest wait, then busy, then other); trim to 5 with `+N more`; a session with no progress file; `done == total` idle reads `xong`; no other sessions gives no rows.
- `register.test.ts` (mocked `$.fs` through the test kit if available, else `$.fs` hooks): a list change writes the file; a registry entry plus a record draws a row; a busy to idle transition highlights and sets the status line once; first poll raises no alert; `session.end` deletes the own file; a failing `$.fs.write` does not break the tool result.
- Existing tests stay green.

## Success criteria

1. With two real sessions open, each pane shows the other with correct name, progress and state within 3 s.
2. A session finishing its turn is highlighted in the other pane and shows a growing wait time.
3. Closing a session removes its row within 3 s and its file within the next poll or by the 24 h rule.
4. No exception reaches the session when the directories are missing, unwritable or contain junk.

## Decisions on the open questions (user approved the proposed answers, rev 2)

1. An idle session whose tasks are all done is quiet: no alert, reads `xong`.
2. Unknown status words show as `·` with the raw word and its age.
3. Messaging goes through `$.session.send`; a different quick action can be added later.
4. A session's record is deleted when it ends; history belongs to P2.
