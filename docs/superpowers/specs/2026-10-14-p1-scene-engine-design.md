# P1: Citadel scene (static backdrop + compositor + pane layout) — design

Status: draft for review (rev 2, 2026-10-15). Part 1 of 4 of the task-progress redesign (see "Decomposition").

## Purpose

Replace the singer portrait with a dark-fantasy scene that shows, at a glance and with almost no text, the state of **this** session. The user wants it beautiful enough to raise their drive to work, humorous and rewarding. Themes they like: games, dark fantasy, film, music, ancient architecture (Elden Ring cited).

Terminal: VTE 0.76 (Terminator), `DejaVu Sans Mono` (block glyphs yes, braille no), truecolor, pane about 69 to 96 columns wide.

## Decisions already made (from the spike, v1 to v18)

- **Render mode: half-block `▀`, 1x2 px per cell.** A cell is about 1:2.2, so a half-block pixel is square. Quadrants stretch the art; braille needs a glyph the font lacks and blows the colour budget. Both dropped.
- **Scene: 96x32 px = 96 columns x 16 rows**, authored natively at that size. Downsampling a larger piece lost the subject; at this size only bold silhouettes with strong value contrast work.
- **Subject: an Elden-Ring-style citadel (needle towers, great hall, colonnade, ruined wall) under a dominant, glowing Erdtree** at sunset; golden sky, ochre path, a "site of grace" light at the left.
- **Static for now.** No scrolling camera, no hero, no monsters, no skyline of day towers. The user shelved animation until they bring reference material. Hero, monster, skyline and director code stay in the throwaway spike only.
- **Original art.** The scene is procedural code (`tools/gen-world.py`, Python + Pillow, committed output) and is not derived pixel-for-pixel from the user's reference image.

## Scope

In: generated background, compositor, pane layout (scene on top, info zone below), fallback for narrow or short panes, generator tool, preview tool, bench, tests.
Out (later): characters and event-driven motion (P1b, when references arrive), persistent ledger and the citadel growing over days (P2), other sessions (P3), productivity metrics (P4). The completion sound, `progress` tool, status line and task list from 0.5.1 stay as they are.

## Decomposition

| # | Project | Depends on |
|---|---|---|
| P1 | Citadel scene (this spec) | none |
| P1b | Characters and motion (deferred) | P1, user references |
| P2 | Accumulation: ledger, stones placed, tiers, streak, badges | P1 |
| P3 | Multi-session overview: registry reader, per-session rows, waiting beacons | P1 (layout); P2 optional |
| P4 | Productivity metrics (waiting debt, daily goal) | P2/P3 |

Priority set by the user: P3 first among the later projects.

## Architecture

- `world.ts` (generated): palette, 96x32 px background as palette indices for 8 phases (phase 0 is the still frame; the others carry sky rays and embers for P1b), the 16 window rectangles and the palette index of a lit window. The windows are baked dark. Produced by `tools/gen-world.py` (`--preview out.png` also writes a 10x PNG for review).
- `compositor.ts`: `sceneCells(columns, firstRow, rows, lit, phase = 0) -> string` (base64 cells). Centre-crops the world to `columns`, paints the first `lit` windows lit, encodes half-block cells with a per-cell string cache. Pure and deterministic. Lights, sprite layers and dots come back with P1b, not before.
- `layout.ts`: pure. `sceneLayout(innerColumns, bodyRows)` decides the scene size or none; `litWindows(done, total, windows)` maps task progress to lit windows.
- `register.tsx`: wiring only. Reads pane size and task list, calls `sceneLayout` and `sceneCells`, draws the info zone, falls back to text. No timer and no `$.ui.blit`: the scene is static and drawn by the render hook, which re-runs when the task list changes.

Unchanged from 0.5.1: `progress.ts`, `sound.ts`, `style.ts`, the tool and hooks that keep the task list. Removed: `stage.ts`, `singer.ts` and their tests.

## Pane layout and fallback

- Scene width = `min(96, innerColumns)` (the pane's body minus the card padding); when narrower than 96 the scene is **cropped around the centre** (the Erdtree and citadel stay in view).
- Scene height = `min(16, bodyRows - 15)` rows, so the info zone always keeps at least 15 rows (7 of chrome and 8 for tasks). When short, the **top** rows are cropped (bottom-anchored: citadel and path stay). A pane that leaves fewer than 8 scene rows, or is narrower than 16 columns, shows no scene and the 0.5.1 text layout. A pane that does not report its height counts as 40 rows.
- Below the scene: the info zone as in 0.5.1 (bar, percent, timing, task list). Today's stones and session lines belong to P2 and P3.

## What the static scene tells you

**Lit windows in the citadel are the tasks.** The citadel has 16 windows, all dark at rest. With `done` of `total` tasks finished, `floor(16 * done / total)` windows are lit, all 16 only when every task is done; no tasks means none lit. The info zone still carries the exact numbers.

## Budgets and limits

- Colour pairs: the engine paints at most 1024 distinct (fg, bg) pairs exactly. v18 uses about 185 background pairs, so about 700 remain for P1b/P2. Hard cap 900.
- Speed: 3 ms per render (spike measured about 1 ms with quadrants; half-block is cheaper). A test times it; the scene is drawn only when the pane renders, not per frame.
- Module size: background strings are small at 96x32, accepted.

## Error handling

Nothing in the scene path can throw: `sceneCells` is pure over fixed data and its arguments are bounded by `sceneLayout`, so there is no scene-specific error handling (a try/catch here would be untestable dead code). An unknown pane height counts as 40 rows; a pane that is too small or not a terminal shows the text layout.

## Testing

- `world.test.ts`: dimensions, 8 phases, every character is a valid palette index, 16 windows inside the world.
- `compositor.test.ts`: output length is columns x rows x 12 bytes; only `▀` and space appear; a centre crop equals the matching slice of the full scene; a row crop equals the matching rows; lit windows paint exactly the first `lit` windows; the pair count over all phases and lit counts stays within budget; render time stays within budget.
- `layout.test.ts`: scene size at 96, 69, 40 and 16 columns and at 40, 23, 22 rows; none below the minimums; `litWindows` is monotonic, full only when done, none for an empty list.
- `register.test.ts`: the pane draws a scene whose lit windows follow the task list, and none in a pane too small.
- Existing 0.5.1 tests stay green, except the singing-stage tests, which go with the singer.
- Human check: `python3 tools/gen-world.py --preview out.png` renders the scene for review.

## Success criteria

1. Pair count at most 900 and at most 3 ms per render (both tested).
2. Layout, fallback and window lighting verified by tests.
3. The user approves the preview PNG and the look in their own pane.

## Open questions

1. Visual balance: the Erdtree now dominates; keep, or shrink it and sharpen the citadel? Known flaws to fix: a pale glow blob right of the trunk reads as a moon, trunk and canopy are both brown, lit edges look speckled.
2. The 8 phases ship in `world.ts` but P1 draws phase 0 only; the rest wait for P1b.
3. Singer portrait: retired here. Bring it back later as an optional "bard"?
