# Citadel Scene (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the singer portrait in the task-progress pane with a static 96x16-cell citadel scene whose 16 windows light up as tasks finish.

**Architecture:** A Python generator writes the scene as palette-indexed pixel rows (`hooks/world.ts`). A pure compositor turns it into half-block Raster cells (centre-cropped to the pane width, bottom-anchored when the pane is short, first `n` windows lit). A pure layout module decides the scene size and how many windows to light. `register.tsx` only wires them into the pane's render hook; there is no timer and no `$.ui.blit`.

**Tech Stack:** TypeScript hooks module for the Claude Code plugin API (tests with `claude-code/testing`, run by `claude plugin test`), Python 3 + Pillow for the generator.

**Spec:** `docs/superpowers/specs/2026-10-14-p1-scene-engine-design.md` (rev 2, amended 2026-10-15; this plan implements it exactly).

## Global Constraints

- Repo is `~/claude-mods/task-progress`; every path below is relative to it. Run commands from there.
- **Do not commit or push** unless the user explicitly asks. The plan has no commit steps on purpose.
- Render mode is half-block only: glyphs `▀` (0x2580) and space (0x20), one square pixel per half cell, 1x2 px per cell. Every glyph is one printable width-1 BMP character.
- Scene is 96x32 px = at most 96 columns x 16 rows. Pane too small means no scene and the 0.5.1 text layout.
- Budgets: at most 900 distinct (fg, bg) colour pairs over every phase and lighting; at most 3 ms per render.
- The art is original procedural code (`tools/gen-world.py`). Do not add the user's reference image, or anything derived from it, to the repo.
- Hooks module environment: ES modules, no Node, no DOM, no `import()`; files imported without extensions as in the existing code; `noUncheckedIndexedAccess` is on.
- Keep functions under 50 lines and files under 800 lines; named constants, no magic numbers.
- Unchanged from 0.5.1: `progress.ts` timing helpers, `sound.ts`, `style.ts`, the tool and hooks that keep the task list, the status line, the completion sound.
- Run all tests with `claude plugin test .` (23 pass before this work).
- Type-check with a tsconfig kept outside the repo (the engine writes `.claude-plugin/types` only when it loads the mod). Create it once:

```bash
DTS=$(find /tmp/claude-*/bundled-skills -name claude-code.d.ts 2>/dev/null | head -1)
test -n "$DTS" || { echo "load the plugin-authoring skill first: it writes claude-code.d.ts"; false; }
cat > /tmp/task-progress-tsconfig.json <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$DTS", "$HOME/claude-mods/task-progress/hooks", "$HOME/claude-mods/task-progress/types"]
}
JSON
```

  Then run `tsc -p /tmp/task-progress-tsconfig.json` with TypeScript 5.4 or newer (`<path-to>/node_modules/.bin/tsc` is on this machine). No output means clean.

## Review Focus

Inputs and conditions the spec implies but does not spell out; each has a test in the task that owns the code.

1. A pane that does not report its height (the test harness mounts like this): the scene still draws, as if the height were 40 rows. Task 4, register test.
2. The task list is replaced after everything was done (a new plan starts): every window goes dark again. Task 4, register test.
3. A non-terminal surface (desktop): no Raster, no crash, the text still shows. Task 4, register test.
4. A pane exactly at the thresholds, 16 columns and 23 rows: the smallest scene draws, one less in either direction shows none. Task 2, layout test.
5. Long lists: 99 of 100 tasks done never lights all windows, and 200 tasks never lights more than 16. Task 2, layout test.

## File Structure

| File | Responsibility |
|---|---|
| `tools/gen-world.py` (new) | Draws the 96x32 scene for 8 phases, writes `hooks/world.ts`, optional `--preview` PNG |
| `hooks/world.ts` (new, generated) | Palette, background rows per phase, window rectangles, lit-window palette index |
| `hooks/layout.ts` (new) | `sceneLayout`, `litWindows`, size constants |
| `hooks/compositor.ts` (new) | `sceneCells`: world to base64 Raster cells |
| `hooks/progress.ts` (modify) | gains `isAllDone` (moved from `stage.ts`) |
| `hooks/register.tsx` (modify) | draws the scene instead of the stage, drops the timer and the turn hooks |
| `hooks/stage.ts`, `hooks/singer.ts` and `hooks/stage.test.ts` (delete) | the singer portrait |
| `README.md`, `.claude-plugin/plugin.json` (modify) | docs and version 0.6.0 |

---

### Task 1: Generated world

**Files:**
- Create: `tools/gen-world.py`
- Create (generated): `hooks/world.ts`
- Test: `hooks/world.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`hooks/world.ts`): `WORLD_W = 96`, `WORLD_H = 32`, `ALPHABET: string`, `PALETTE: readonly number[]` (0xRRGGBB), `WINDOW_ON: number` (palette index of a lit window), `WINDOWS: readonly (readonly [number, number, number, number])[]` (`[x0, y0, x1, y1)` pixel rectangles, 16 of them), `BG: readonly (readonly string[])[]` (8 phases x 32 rows x 96 characters, each character's position in `ALPHABET` is a palette index).

- [ ] **Step 1: Write the failing test**

Create `hooks/world.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { ALPHABET, BG, PALETTE, WINDOWS, WINDOW_ON, WORLD_H, WORLD_W } from './world'

test('the world is 96x32 px with 8 phases, every character a palette index', () => {
  expect(WORLD_W).toBe(96)
  expect(WORLD_H).toBe(32)
  expect(BG.length).toBe(8)
  for (const phase of BG) {
    expect(phase.length).toBe(WORLD_H)
    for (const row of phase) {
      expect(row.length).toBe(WORLD_W)
      for (const ch of row) {
        const index = ALPHABET.indexOf(ch)
        expect(index >= 0 && index < PALETTE.length).toBe(true)
      }
    }
  }
})

test('16 windows sit inside the world and a lit window has a palette colour', () => {
  expect(WINDOWS.length).toBe(16)
  for (const [x0, y0, x1, y1] of WINDOWS) {
    expect(x0 >= 0 && x0 < x1 && x1 <= WORLD_W).toBe(true)
    expect(y0 >= 0 && y0 < y1 && y1 <= WORLD_H).toBe(true)
  }
  expect(WINDOW_ON >= 0 && WINDOW_ON < PALETTE.length).toBe(true)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `claude plugin test .`
Expected: `hooks/world.test.ts: cannot import "./world"` reported as a failed file; the other 23 tests pass.

- [ ] **Step 3: Create the generator**

Create `tools/gen-world.py`:

```python
"""Generates hooks/world.ts: the citadel scene, authored natively at 96x32 px (original art, procedural).

    python3 tools/gen-world.py [--preview out.png]
"""
import math, os, sys
from PIL import Image

TAU = math.pi * 2
FRAMES = 8
def rgb(h): h = h.lstrip('#'); return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
BAYER = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]
def bay(x, y): return (BAYER[y % 4][x % 4] + 0.5) / 16.0
def hnoise(x, y, s=0):
    n = (int(x) * 374761393 + int(y) * 668265263 + s * 2147483647) & 0xffffffff
    n = (n ^ (n >> 13)) * 1274126177 & 0xffffffff
    return ((n ^ (n >> 16)) & 0xffff) / 65535.0
def vnoise(x, y, s=0):
    xi, yi = math.floor(x), math.floor(y); xf, yf = x - xi, y - yi
    xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf)
    a, b = hnoise(xi, yi, s), hnoise(xi + 1, yi, s)
    c, d = hnoise(xi, yi + 1, s), hnoise(xi + 1, yi + 1, s)
    return (a + (b - a) * xf) + ((c + (d - c) * xf) - (a + (b - a) * xf)) * yf

GRACE = [rgb('#7a5a24'), rgb('#e0b04a'), rgb('#fff0b0')]
LEAF = [rgb('#ffd16e'), rgb('#e8a848')]
def d2(a, b): return (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
def reduce_palette(frames, maxcolors):
    from collections import Counter
    cnt = Counter(c for g in frames for row in g for c in row)
    colors = list(cnt)
    while len(colors) > maxcolors:
        best = None
        for i in range(len(colors)):
            for j in range(i + 1, len(colors)):
                dd = d2(colors[i], colors[j]) * (min(cnt[colors[i]], cnt[colors[j]]) ** 0.35)
                if best is None or dd < best[0]: best = (dd, i, j)
        _, i, j = best
        a, b = colors[i], colors[j]
        keep, drop = (a, b) if cnt[a] >= cnt[b] else (b, a)
        cnt[keep] += cnt[drop]; colors.remove(drop)
    return colors


W, H = 96, 32
CX = 62.0
PAL_MAX = 40
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hooks', 'world.ts')
PREVIEW = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
SKYR = [rgb(c) for c in ('#140c18', '#241420', '#3d2326', '#63392a', '#9a5a30', '#cc8a3c', '#eab050', '#f8d078', '#fff0b0')]
CAN_DARK, CAN_MID, CAN_LEAF = rgb('#34201a'), rgb('#5a3c26'), rgb('#a4702f')
RIM_HI, RIM_LO = rgb('#f0b858'), rgb('#b4803c')
STONE_BACK, STONE, STONE_DEEP, STONE_LIT = rgb('#5a4a5a'), rgb('#1d2238'), rgb('#080a14'), rgb('#4b5478')
WIN_LIT, WIN_OFF = rgb('#ffe090'), rgb('#0b0f1d')

def gy(u): return 26.4 + 0.8 * math.sin(u * 0.12 + 0.4) + 0.5 * math.sin(u * 0.29)
def canopy_edge(u):
    dx = (u - CX) / 48.0
    if abs(dx) >= 1: return None
    return 10.5 * math.sqrt(1 - dx * dx) + (1.4 * math.sin(u * 0.33) + 1.0 * math.sin(u * 0.71 + 1)) * (1 - dx * dx) + (vnoise(u * 0.5, 0, 3) - 0.5) * 1.4

# citadel as hard-edged shapes (pixels); back layer = distant wall, front = dark silhouette
def spire(cx, yb, h, hw):
    return lambda u, v: yb - h <= v <= yb and abs(u - cx) <= hw * (1 - (yb - v) / h) ** 1.35
def rect(x0, x1, y0, y1): return lambda u, v: x0 <= u <= x1 and y0 <= v <= y1
def crenel(x0, x1, y):
    return lambda u, v: x0 <= u <= x1 and y - 1 <= v < y and int(u - x0) % 4 < 2
def jag(x0, x1, ytop, ybase, seed):
    return lambda u, v: x0 <= u <= x1 and ytop + 3.0 * hnoise(int(u - x0) // 2, 0, seed) <= v <= ybase
def beam(x0, y0, x1, y1, th=0.75):
    def f(u, v):
        dx, dy = x1 - x0, y1 - y0
        t = clamp(((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy))
        return math.hypot(u - (x0 + dx * t), v - (y0 + dy * t)) <= th
    return f
def colonnade(x0, x1, ytop, ybase):
    return lambda u, v: x0 <= u <= x1 and ((ybase - 3 <= v <= ybase) or (ytop <= v <= ytop + 1.2) or (ytop <= v <= ybase and int(u - x0) % 3 == 0))
FRONT = [
    rect(40, 45, 9, 27), spire(42.5, 9, 9, 3.4),                    # the great needle
    rect(33, 37, 12, 27), spire(35, 12, 8, 2.9),
    rect(48, 52, 13, 27), spire(50, 13, 7, 2.9),
    rect(55, 58, 15, 27), jag(55, 58, 14, 16, 2),                    # broken tower
    rect(78, 82, 17, 27), spire(80, 17, 5, 3.2),
    rect(31, 62, 20, 27), crenel(31, 62, 20),                         # great hall
    jag(62, 76, 21, 27, 5),                                           # ruined wall
    colonnade(6, 30, 19, 27),
    beam(46, 17, 57, 23), beam(46, 18, 57, 24), beam(33, 17, 26, 22), beam(33, 18, 26, 23),   # flying buttresses
    rect(38, 39, 17, 20), rect(53, 54, 17, 20),
]
BACK = [rect(0, 95, 22, 27), spire(6, 22, 6, 5), spire(90, 22, 7, 5), rect(2, 10, 17, 23), rect(86, 94, 16, 23), spire(6, 17, 6, 6), spire(90, 16, 6, 6), rect(14, 20, 19, 23), spire(17, 19, 4, 4.4)]
GATE = lambda u, v: abs(u - 47) <= 3.4 and v >= 22 and (v >= 24.4 or (u - 47) ** 2 + (v - 24.4) ** 2 <= 3.4 ** 2)
WINS = [(41.8, 11, 1, 3), (43.4, 15, 1, 3), (34.6, 14, 1, 3), (34.6, 18, 1, 2), (49.5, 15, 1, 3), (56, 18, 1, 3), (79.6, 19, 1, 3),
        (36, 22, 2, 3), (41, 22, 2, 3), (52, 22, 2, 3), (57, 22, 2, 3), (14, 20, 1, 2), (22, 21, 1, 2), (27, 21, 1, 2), (66, 24, 1, 2), (72, 24, 1, 2)]

def in_front(u, v): return any(s(u, v) for s in FRONT)
def in_back(u, v): return any(s(u, v) for s in BACK)

def draw(f):
    g = [[None] * W for _ in range(H)]
    ph = TAU * f / FRAMES
    for y in range(H):
        for x in range(W):
            u, v = x + 0.5, y + 0.5
            t = clamp(v / 25.0)
            glow = max(0.0, 1 - math.hypot((u - CX) / 50.0, (v - 17.0) / 19.0))
            th = math.atan2(u - CX, v - 7.0)
            ray = (math.sin(th * 8.0 - ph) + 1) / 2
            fall = clamp(1 - math.hypot(u - CX, v - 7.0) / 54.0)
            tt = clamp(t * 0.55 + 0.78 * glow ** 1.0 + (ray - 0.5) * 0.18 * fall)
            pos = tt * (len(SKYR) - 1); i = int(pos); fr = clamp((pos - i - 0.3) / 0.4)
            c = SKYR[min(len(SKYR) - 1, i + (1 if fr > bay(x, y) else 0))]
            # trunk behind the keep
            tcx = 64.0 + 1.2 * math.sin(v * 0.22); thw = 6.4 + max(0, v - 9) * 0.1 + max(0, v - 19) * 0.35
            if 7 <= v < 27 and abs(u - tcx) <= thw:
                q = (u - tcx) / thw
                streak = hnoise(int(u), int(v // 4), 5)
                if q < -0.68: c = RIM_HI if bay(x, y) < 0.8 else RIM_LO
                elif q < -0.4: c = RIM_LO if streak > 0.35 else CAN_LEAF
                elif q > 0.78: c = CAN_LEAF if bay(x, y) < 0.35 else CAN_MID
                else: c = CAN_MID if streak > 0.5 else CAN_DARK
            for lx0, ly0, lx1, ly1, lw in ((60, 12, 34, 5, 2.2), (68, 12, 92, 6, 2.2), (62, 10, 46, 3, 1.4), (66, 10, 80, 2, 1.4)):
                dx_, dy_ = lx1 - lx0, ly1 - ly0
                t_ = clamp(((u - lx0) * dx_ + (v - ly0) * dy_) / (dx_ * dx_ + dy_ * dy_))
                dd = math.hypot(u - (lx0 + dx_ * t_), v - (ly0 + dy_ * t_))
                if dd <= lw * (1 - 0.5 * t_): c = RIM_LO if v < ly0 + (ly1 - ly0) * t_ - 0.3 and bay(x, y) < 0.7 else CAN_DARK
            e = canopy_edge(u)
            if e is not None and v < e:
                clump = vnoise(u * 0.5, v * 0.7, 4)
                c = CAN_LEAF if clump > 0.72 else (CAN_MID if clump > 0.45 else CAN_DARK)
                if v > e - 3.0 and clump > 0.2: c = RIM_HI if bay(x, y) < 0.7 else RIM_LO
                elif hnoise(x, y, 8) > 0.93: c = RIM_HI
            if in_back(u, v): c = STONE_BACK
            if in_front(u, v): c = STONE
            if GATE(u, v): c = STONE_DEEP
            if in_front(u, v) or in_back(u, v):
                # cool lit edge toward the glow: pixel next to open sky on the top or on the side facing the centre
                lit_side = -1 if u > 62 else 1
                if in_front(u, v) and v < 25 and ((not in_front(u, v - 1) and bay(x, y) < 0.6) or (not in_front(u + lit_side, v) and bay(x, y) < 0.3)): c = STONE_LIT
            g[y][x] = c
    for wx, wy, ww, wh in WINS:
        for y in range(int(wy), int(wy + wh)):
            for x in range(int(wx), int(wx + ww)):
                if 0 <= x < W and 0 <= y < H: g[y][x] = WIN_OFF
    for i in range(26):   # embers around the trunk
        life = (hnoise(i, 3, 8) + f / 8.0 * (1 + i % 2)) % 1.0
        ux = 54 + hnoise(i, 4, 8) * 26 + math.sin(TAU * life + i) * 2.0
        yy = int(26 - life * 22); xx = int(ux)
        if 0 <= xx < W and 0 <= yy < H and not in_front(xx + .5, yy + .5) and not in_back(xx + .5, yy + .5) and g[yy][xx] not in (CAN_DARK, CAN_MID): g[yy][xx] = LEAF[i % 2]
    for y in range(H):   # path
        for x in range(W):
            u, v = x + 0.5, y + 0.5
            d = v - gy(u)
            if d < 0: continue
            if d < 0.9: c = rgb('#6a5030') if bay(x, y) < 0.8 else rgb('#4a3820')
            elif d < 3.8:
                n = vnoise(u * 0.6, v * 1.3, 2)
                c = (rgb('#7a5c34') if n > 0.58 else rgb('#5e4528')) if d < 2.8 else rgb('#3c2c1c')
                if 1.2 < d < 2.8 and hnoise(x, y, 4) > 0.9: c = rgb('#9a7a44')
            else: c = rgb('#1c140e') if hnoise(x // 2, y, 6) > 0.35 else rgb('#120d09')
            g[y][x] = c
    gx = 10; base = int(gy(gx) + 1)
    for k in range(5):
        yy = base - 1 - k
        if 0 <= yy < H and (k < 3 or (k + f) % 2 == 0): g[yy][gx] = GRACE[2] if k < 2 else GRACE[1]
    for dx in (-1, 0, 1): g[base][gx + dx] = GRACE[1] if (dx == 0 or f % 2 == 0) else GRACE[0]
    return g

frames = [draw(f) for f in range(FRAMES)]
pal = reduce_palette(frames, PAL_MAX)
palette = list(pal)
if WIN_LIT not in palette: palette.append(WIN_LIT)
WINDOW_ON = palette.index(WIN_LIT)
windows = [(int(wx), int(wy), int(wx + ww), int(wy + wh)) for wx, wy, ww, wh in WINS]
ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~!@#%^&*()=[]{}<>?,:;|+/$`'
assert len(palette) <= len(ALPHABET)
cache = {}
def idx(c):
    if c not in cache: cache[c] = min(range(len(pal)), key=lambda i: d2(pal[i], c))
    return cache[c]
bg = [[''.join(ALPHABET[idx(c)] for c in row) for row in g] for g in frames]
out = "// Generated by tools/gen-world.py, do not edit. Original art authored natively at %dx%d px, %d phases (phase 0 is the still frame).\n" % (W, H, FRAMES)
out += "export const WORLD_W = %d\nexport const WORLD_H = %d\n" % (W, H)
out += "export const ALPHABET = '%s'\n" % ALPHABET
out += "export const PALETTE: readonly number[] = [%s]\n" % ','.join(str((c[0] << 16) | (c[1] << 8) | c[2]) for c in palette)
out += "/** Palette index of a lit window. */\nexport const WINDOW_ON = %d\n" % WINDOW_ON
out += "/** Window rectangles [x0, y0, x1, y1), baked dark into the background; the first n are lit for n lit windows. */\n"
out += "export const WINDOWS: readonly (readonly [number, number, number, number])[] = [%s]\n" % ','.join('[%d,%d,%d,%d]' % w for w in windows)
out += "export const BG: readonly (readonly string[])[] = [\n"
for rows in bg: out += "  [\n" + "".join("    '%s',\n" % r for r in rows) + "  ],\n"
out += "]\n"
open(OUT, 'w').write(out)
q = [[[pal[idx(c)] for c in row] for row in g] for g in frames]
if PREVIEW:
    K = 10
    im = Image.new('RGB', (W, H)); im.putdata([c for row in q[0] for c in row]); im.resize((W * K, H * K), Image.NEAREST).save(PREVIEW)
pairs = set()
for g in q:
    for cy in range(H // 2):
        for x in range(W): pairs.add((g[2 * cy][x], g[2 * cy + 1][x]))
print('palette', len(palette), 'background pairs', len(pairs))
```

- [ ] **Step 4: Generate the world and look at it**

Run: `python3 tools/gen-world.py --preview /tmp/citadel-preview.png`
Expected output: `palette 32 background pairs 179`, a new `hooks/world.ts` of about 28 KB, and a 960x320 PNG. Open the PNG (Read tool on the path): a golden-sunset sky, a large glowing Erdtree across the top and right, a dark blue-slate citadel with needle towers in the centre, an ochre path along the bottom, and small dark window slits in the stone (none lit).

- [ ] **Step 5: Run the tests and see them pass**

Run: `claude plugin test .`
Expected: `hooks/world.test.ts` shows 2 passes; 25 pass, 0 fail in total.

---

### Task 2: Layout and window lighting

**Files:**
- Create: `hooks/layout.ts`
- Test: `hooks/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_SCENE_COLUMNS = 96`, `MIN_SCENE_COLUMNS = 16`, `MAX_SCENE_ROWS = 16`, `MIN_SCENE_ROWS = 8`, `INFO_ROWS = 15`, `DEFAULT_BODY_ROWS = 40`; `type SceneLayout = { columns: number; rows: number; firstRow: number }`; `sceneLayout(innerColumns: number, bodyRows: number): SceneLayout | undefined`; `litWindows(done: number, total: number, windows: number): number`.

- [ ] **Step 1: Write the failing test**

Create `hooks/layout.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { litWindows, sceneLayout } from './layout'

test('a roomy pane gets the full 96x16 scene, wider panes still 96', () => {
  expect(sceneLayout(96, 40)).toEqual({ columns: 96, rows: 16, firstRow: 0 })
  expect(sceneLayout(140, 31)).toEqual({ columns: 96, rows: 16, firstRow: 0 })
})

test('a narrow pane keeps the width it has, down to 16 columns', () => {
  expect(sceneLayout(69, 35)).toEqual({ columns: 69, rows: 16, firstRow: 0 })
  expect(sceneLayout(40, 35)).toEqual({ columns: 40, rows: 16, firstRow: 0 })
  expect(sceneLayout(16, 35)).toEqual({ columns: 16, rows: 16, firstRow: 0 })
  expect(sceneLayout(15, 35)).toBeUndefined()
  expect(sceneLayout(0, 35)).toBeUndefined()
})

test('a short pane crops the top rows and keeps the info zone at 15 rows', () => {
  expect(sceneLayout(96, 30)).toEqual({ columns: 96, rows: 15, firstRow: 1 })
  expect(sceneLayout(96, 24)).toEqual({ columns: 96, rows: 9, firstRow: 7 })
  expect(sceneLayout(96, 23)).toEqual({ columns: 96, rows: 8, firstRow: 8 })
  expect(sceneLayout(96, 22)).toBeUndefined()
  expect(sceneLayout(96, 0)).toBeUndefined()
})

test('no windows are lit for an empty list or no progress', () => {
  expect(litWindows(0, 0, 16)).toBe(0)
  expect(litWindows(0, 5, 16)).toBe(0)
})

test('windows light in proportion and all of them only once every task is done', () => {
  expect(litWindows(1, 2, 16)).toBe(8)
  expect(litWindows(1, 3, 16)).toBe(5)
  expect(litWindows(99, 100, 16)).toBe(15)
  expect(litWindows(2, 2, 16)).toBe(16)
  expect(litWindows(1, 1, 16)).toBe(16)
})

test('lit windows never go down as tasks finish', () => {
  for (const total of [1, 2, 3, 7, 16, 40, 200]) {
    let last = 0
    for (let done = 0; done <= total; done += 1) {
      const lit = litWindows(done, total, 16)
      expect(lit >= last).toBe(true)
      expect(lit <= 16).toBe(true)
      expect(lit === 16).toBe(done === total)
      last = lit
    }
  }
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `claude plugin test .`
Expected: `hooks/layout.test.ts: cannot import "./layout"` as a failed file.

- [ ] **Step 3: Write the implementation**

Create `hooks/layout.ts`:

```ts
export const MAX_SCENE_COLUMNS = 96
export const MIN_SCENE_COLUMNS = 16
export const MAX_SCENE_ROWS = 16
export const MIN_SCENE_ROWS = 8
/** Rows the pane keeps for everything but the scene: 7 of chrome and 8 for tasks. */
export const INFO_ROWS = 15
/** Rows assumed when the pane does not report its height. */
export const DEFAULT_BODY_ROWS = 40

export type SceneLayout = { columns: number; rows: number; firstRow: number }

/**
 * The scene's size for a pane, or undefined when the pane is too small and shows the text layout.
 * A short pane crops the top rows of the scene (`firstRow`): the citadel and the path stay.
 */
export function sceneLayout(innerColumns: number, bodyRows: number): SceneLayout | undefined {
  const rows = Math.min(MAX_SCENE_ROWS, bodyRows - INFO_ROWS)
  if (innerColumns < MIN_SCENE_COLUMNS || rows < MIN_SCENE_ROWS) return undefined

  return { columns: Math.min(MAX_SCENE_COLUMNS, innerColumns), rows, firstRow: MAX_SCENE_ROWS - rows }
}

/** Windows lit for `done` of `total` tasks: all of them only once every task is done, none for an empty list. */
export function litWindows(done: number, total: number, windows: number): number {
  if (total <= 0) return 0
  if (done >= total) return windows

  return Math.floor((windows * Math.max(0, done)) / total)
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `claude plugin test .`
Expected: `hooks/layout.test.ts` shows 6 passes; 0 fail in total.

---

### Task 3: Compositor

**Files:**
- Create: `hooks/compositor.ts`
- Test: `hooks/compositor.test.ts`

**Interfaces:**
- Consumes: `world.ts` (`ALPHABET`, `BG`, `PALETTE`, `WINDOWS`, `WINDOW_ON`, `WORLD_H`, `WORLD_W`), and in the test `MAX_SCENE_COLUMNS`, `MAX_SCENE_ROWS` from `layout.ts`.
- Produces: `sceneCells(columns: number, firstRow: number, rows: number, lit: number, phase = 0): string`. Standard padded base64 of `columns * rows` little-endian u32 triplets `[code point, foreground, background]`, the form a Raster's `cells` prop takes. `columns` is cut from the centre of the 96-wide world; cell rows `firstRow` up to `firstRow + rows` are drawn; the first `lit` entries of `WINDOWS` are painted `WINDOW_ON`.

- [ ] **Step 1: Write the failing test**

Create `hooks/compositor.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { sceneCells } from './compositor'
import { MAX_SCENE_COLUMNS, MAX_SCENE_ROWS } from './layout'
import { BG, PALETTE, WINDOWS, WINDOW_ON } from './world'

const CELL_BYTES = 12
const SPACE = 0x20
const UPPER_HALF = 0x2580
const PAIR_BUDGET = 900
const RENDER_BUDGET_MS = 3

type Cell = { glyph: number; fg: number; bg: number }

/** Cells are base64 of little-endian u32 triplets [code point, foreground, background], colours 0x00RRGGBB. */
function decode(cells: string): Cell[] {
  const bytes = Array.from(atob(cells), ch => ch.charCodeAt(0))
  const out: Cell[] = []
  for (let i = 0; i < bytes.length; i += CELL_BYTES) {
    const at = (offset: number): number => bytes[i + offset] ?? 0
    out.push({
      glyph: at(0) | (at(1) << 8),
      fg: at(4) | (at(5) << 8) | (at(6) << 16),
      bg: at(8) | (at(9) << 8) | (at(10) << 16),
    })
  }

  return out
}

/** The colour of pixel (x, y) of a rendered scene whose first cell row is row 0: a cell is two pixels, top then bottom. */
function pixel(cells: Cell[], columns: number, x: number, y: number): number {
  const cell = cells[Math.floor(y / 2) * columns + x]

  return (y % 2 === 0 ? cell?.fg : cell?.bg) ?? -1
}

test('a full scene has columns*rows cells and only space and upper-half glyphs', () => {
  const bytes = atob(sceneCells(MAX_SCENE_COLUMNS, 0, MAX_SCENE_ROWS, 0)).length
  expect(bytes).toBe(MAX_SCENE_COLUMNS * MAX_SCENE_ROWS * CELL_BYTES)
  for (const cell of decode(sceneCells(MAX_SCENE_COLUMNS, 0, MAX_SCENE_ROWS, 0))) {
    expect(cell.glyph === SPACE || cell.glyph === UPPER_HALF).toBe(true)
    expect(PALETTE.includes(cell.fg) && PALETTE.includes(cell.bg)).toBe(true)
  }
})

test('the same arguments give the same cells', () => {
  expect(sceneCells(69, 0, 16, 5)).toBe(sceneCells(69, 0, 16, 5))
})

test('a narrower scene is the centre of the full one', () => {
  const full = decode(sceneCells(96, 0, 16, 0))
  for (const columns of [16, 40, 69, 95]) {
    const crop = decode(sceneCells(columns, 0, 16, 0))
    const left = Math.floor((96 - columns) / 2)
    for (let row = 0; row < 16; row += 1) {
      for (let x = 0; x < columns; x += 1) expect(crop[row * columns + x]).toEqual(full[row * 96 + left + x])
    }
  }
})

test('a short scene is the bottom rows of the full one', () => {
  const full = decode(sceneCells(96, 0, 16, 0))
  const short = decode(sceneCells(96, 8, 8, 0))
  expect(short.length).toBe(96 * 8)
  expect(short).toEqual(full.slice(8 * 96))
})

test('lit windows paint exactly the first n windows', () => {
  for (const lit of [0, 1, 7, 16]) {
    const cells = decode(sceneCells(96, 0, 16, lit))
    WINDOWS.forEach(([x0, y0], index) => {
      expect(pixel(cells, 96, x0, y0) === PALETTE[WINDOW_ON]).toBe(index < lit)
    })
  }
})

test('every phase and lighting stays within the colour-pair budget', () => {
  const pairs = new Set<string>()
  for (let phase = 0; phase < BG.length; phase += 1) {
    for (const lit of [0, 5, 10, 16]) {
      for (const cell of decode(sceneCells(96, 0, 16, lit, phase))) pairs.add(`${cell.fg}:${cell.bg}`)
    }
  }
  expect(pairs.size <= PAIR_BUDGET).toBe(true)
})

test('a render stays within the time budget', () => {
  const runs = 50
  sceneCells(96, 0, 16, 8)
  const start = Date.now()
  for (let i = 0; i < runs; i += 1) sceneCells(96, 0, 16, i % 17)

  expect((Date.now() - start) / runs <= RENDER_BUDGET_MS).toBe(true)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `claude plugin test .`
Expected: `hooks/compositor.test.ts: cannot import "./compositor"` as a failed file.

- [ ] **Step 3: Write the implementation**

Create `hooks/compositor.ts`:

```ts
import { ALPHABET, BG, PALETTE, WINDOWS, WINDOW_ON, WORLD_H, WORLD_W } from './world'

const SPACE = 0x20
const UPPER_HALF = 0x2580
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const PALETTE_SIZE = PALETTE.length

const CHAR_INDEX = new Uint8Array(128)
for (let i = 0; i < ALPHABET.length; i += 1) CHAR_INDEX[ALPHABET.charCodeAt(i)] = i

const cellCache = new Map<number, string>()

/** One cell: three little-endian u32 words [code point, foreground, background], 12 bytes, base64 without padding (16 characters). */
function cellString(glyph: number, fg: number, bg: number): string {
  const key = ((glyph === SPACE ? 0 : 1) * PALETTE_SIZE + fg) * PALETTE_SIZE + bg
  const hit = cellCache.get(key)
  if (hit !== undefined) return hit
  const fgRgb = PALETTE[fg] ?? 0
  const bgRgb = PALETTE[bg] ?? 0
  const bytes = [glyph & 255, glyph >> 8, 0, 0, fgRgb & 255, (fgRgb >> 8) & 255, fgRgb >> 16, 0, bgRgb & 255, (bgRgb >> 8) & 255, bgRgb >> 16, 0]
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += `${B64[a >> 2]}${B64[((a & 3) << 4) | (b >> 4)]}${B64[((b & 15) << 2) | (c >> 6)]}${B64[c & 63]}`
  }
  cellCache.set(key, out)

  return out
}

/**
 * The scene as Raster cells, half blocks (one cell is two square pixels, top over bottom).
 * `columns` is cut from the centre of the world; the cell rows are `firstRow` up to `firstRow + rows`; the first `lit` windows are lit.
 */
export function sceneCells(columns: number, firstRow: number, rows: number, lit: number, phase = 0): string {
  const left = Math.floor((WORLD_W - columns) / 2)
  const world = BG[phase % BG.length] ?? []
  const pixels = new Uint8Array(WORLD_W * WORLD_H)
  for (let y = 0; y < WORLD_H; y += 1) {
    const row = world[y] ?? ''
    for (let x = 0; x < WORLD_W; x += 1) pixels[y * WORLD_W + x] = CHAR_INDEX[row.charCodeAt(x)] ?? 0
  }
  for (const [x0, y0, x1, y1] of WINDOWS.slice(0, lit)) {
    for (let y = y0; y < y1; y += 1) pixels.fill(WINDOW_ON, y * WORLD_W + x0, y * WORLD_W + x1)
  }
  const at = (x: number, y: number): number => (x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H ? (pixels[y * WORLD_W + x] ?? 0) : 0)
  const out: string[] = []
  for (let cy = firstRow; cy < firstRow + rows; cy += 1) {
    for (let cx = 0; cx < columns; cx += 1) {
      const top = at(left + cx, cy * 2)
      const bottom = at(left + cx, cy * 2 + 1)
      out.push(top === bottom ? cellString(SPACE, bottom, bottom) : cellString(UPPER_HALF, top, bottom))
    }
  }

  return out.join('')
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `claude plugin test .`
Expected: `hooks/compositor.test.ts` shows 7 passes; 0 fail in total. (Measured while writing this plan: 185 colour pairs, about 0.4 ms per render.)

---

### Task 4: Draw the scene in the pane and retire the singer

**Files:**
- Modify: `hooks/progress.ts` (append `isAllDone`), `hooks/progress.test.ts`
- Modify: `hooks/register.tsx`, `hooks/register.test.ts`
- Delete: `hooks/stage.ts`, `hooks/stage.test.ts`, `hooks/singer.ts`
- Modify: `README.md`, `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: `sceneCells(columns, firstRow, rows, lit, phase?)` from `compositor.ts`; `sceneLayout`, `litWindows`, `DEFAULT_BODY_ROWS`, `MAX_SCENE_COLUMNS` from `layout.ts`; `WINDOWS` from `world.ts`.
- Produces: `isAllDone(items: ReadonlyArray<{ status: string }>): boolean` in `progress.ts`. The pane draws a `Raster` with key `scene` when a scene fits.

- [ ] **Step 1: Move `isAllDone` to `progress.ts` with its test**

Append to `hooks/progress.ts`:

```ts
/** True when the list has tasks and every one is completed. */
export function isAllDone(items: ReadonlyArray<{ status: string }>): boolean {
  return items.length > 0 && items.every(i => i.status === 'completed')
}
```

In `hooks/progress.test.ts`, change the import line to `import { formatDuration, isAllDone, remainingMs, timingText } from './progress'` and append:

```ts
test('all done needs at least one task and every task completed', () => {
  expect(isAllDone([])).toBe(false)
  expect(isAllDone([{ status: 'completed' }, { status: 'pending' }])).toBe(false)
  expect(isAllDone([{ status: 'completed' }, { status: 'completed' }])).toBe(true)
})
```

- [ ] **Step 2: Replace the singing-stage test in `hooks/register.test.ts`**

Change the line `import { stageCells } from './stage'` to:

```ts
import { sceneCells } from './compositor'
import { litWindows } from './layout'
import { WINDOWS } from './world'
```

Then replace the whole test `the stage sings while a turn runs and rests when it ends` (from its `test(` line to its closing `})`, just above the `/** The jingle starts unawaited ... */` comment) with:

```ts
const PANE_PROPS = { title: 'Task progress', isFocused: true, placement: 'dock' } as const
const HALF_DONE = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'in_progress', activeForm: 'B' },
] as const
const ALL_COMPLETED = [
  { content: 'a', status: 'completed', activeForm: 'A' },
  { content: 'b', status: 'completed', activeForm: 'B' },
] as const

test('the pane draws the citadel and lights windows as tasks finish', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  const ui = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })
  const cells = async () => (await ui.find({ type: 'Raster' }))?.props.cells
  expect(await cells()).toBe(sceneCells(96, 0, 16, 0))

  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })
  await ui.redraw()
  expect(await cells()).toBe(sceneCells(96, 0, 16, litWindows(1, 2, WINDOWS.length)))

  await $.tool.call({ tool: 'TodoWrite', todos: [...ALL_COMPLETED] })
  await ui.redraw()
  expect(await cells()).toBe(sceneCells(96, 0, 16, WINDOWS.length))

  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'c', status: 'pending', activeForm: 'C' }] })
  await ui.redraw()
  expect(await cells()).toBe(sceneCells(96, 0, 16, 0))
  await ui.unmount()
})

test('a narrow pane crops the scene around the centre, a short one crops its top', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const narrow = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 71, scroll: { bodyRows: 35 } } as never,
    requestId: 'task-progress',
  })
  expect((await narrow.find({ type: 'Raster' }))?.props.cells).toBe(sceneCells(69, 0, 16, 0))
  await narrow.unmount()

  const short = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 24 } } as never,
    requestId: 'task-progress',
  })
  expect((await short.find({ type: 'Raster' }))?.props.cells).toBe(sceneCells(96, 7, 9, 0))
  await short.unmount()
})

test('a pane that reports no height counts as 40 rows, and only a terminal gets the scene', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  const terminal = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98 } as never,
    requestId: 'task-progress',
  })
  expect((await terminal.find({ type: 'Raster' }))?.props.cells).toBe(sceneCells(96, 0, 16, 0))
  await terminal.unmount()

  const desktop = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'desktop',
    component: 'Pane',
    props: { ...PANE_PROPS, bodyColumns: 98, scroll: { bodyRows: 40 } } as never,
    requestId: 'task-progress',
  })
  expect(await desktop.find({ type: 'Raster' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
  await desktop.unmount()
})

test('a pane too small for the scene shows the text layout alone', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({ tool: 'TodoWrite', todos: [...HALF_DONE] })
  for (const props of [
    { bodyColumns: 98, scroll: { bodyRows: 22 } },
    { bodyColumns: 17, scroll: { bodyRows: 40 } },
  ]) {
    const ui = await $.ui.mount({
      plugin: 'task-progress',
      surface: 'terminal',
      component: 'Pane',
      props: { ...PANE_PROPS, ...props } as never,
      requestId: 'task-progress',
    })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1\/2 tasks/ })).toBeDefined()
    await ui.unmount()
  }
})
```

- [ ] **Step 3: Run the tests and see the new ones fail**

Run: `claude plugin test .`
Expected: the four new register tests fail (the pane still draws the singer stage); everything else passes.

- [ ] **Step 4: Edit `hooks/register.tsx`**

Apply this diff (it removes the stage import and state, the frame timer, the two turn hooks and the old stage drawing, and draws the scene):

```diff
@@ -2,19 +2,12 @@
 import type { EngineInterface, Register } from 'claude-code'
 
 import type { Item, TaskStatus } from '../types'
-import {
-  FRAME_MS,
-  MAX_COLUMNS,
-  MIN_COLUMNS,
-  STAGE_ROWS,
-  frameKey,
-  isAllDone,
-  modeOf,
-  stageCells,
-} from './stage'
-import { timingText } from './progress'
+import { sceneCells } from './compositor'
+import { DEFAULT_BODY_ROWS, MAX_SCENE_COLUMNS, litWindows, sceneLayout } from './layout'
+import { isAllDone, timingText } from './progress'
 import { playerCommands, soundPath, wasCutByCap } from './sound'
 import { COLORS, barParts, truncate } from './style'
+import { WINDOWS } from './world'
 
 const PANE = 'task-progress'
 const PROGRESS_TOOL = 'mcp__task-progress__progress'
@@ -25,15 +18,10 @@
 const MIN_SOUND_SECONDS = 1
 const MAX_SOUND_SECONDS = 120
 
-let isBusy = false
 let isSoundOn = true
 let customSound = ''
 let soundMs = DEFAULT_SOUND_SECONDS * 1000
 let hasChimed = false
-let isDone = false
-let tick = 0
-let lastKey = ''
-let columns = DEFAULT_COLUMNS
 
 const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [] as Item[])
 const startedAt = atom({ plugin: 'task-progress', key: 'startedAt' } as const, 0)
@@ -87,7 +75,7 @@
 async function refreshStatus($: EngineInterface) {
   const list = [...(await read($, todos)), ...(await read($, tasks))]
   const { done, total, percent } = summarize(list)
-  isDone = isAllDone(list)
+  const isDone = isAllDone(list)
   if (!isDone) hasChimed = false
   if (isDone && !hasChimed) {
     hasChimed = true
@@ -139,35 +127,10 @@
       },
       isDeferred: false,
     })
-    $.clock.every(FRAME_MS, () => {
-      tick += 1
-      const mode = modeOf(isBusy, isDone)
-      const key = frameKey(mode, tick, columns)
-      if (key === lastKey) return
-      lastKey = key
-      void $.ui.blit({
-        requestId: PANE,
-        key: 'stage',
-        columns,
-        cells: stageCells(mode, tick, columns),
-      })
-    })
 
     return next(e)
   })
 
-  on('turn.start', ($, e, next) => {
-    if (e.agentId === undefined) isBusy = true
-
-    return next(e)
-  }).catch((_$, e, next) => next(e))
-
-  on('turn.complete', ($, e, next) => {
-    if (e.agentId === undefined) isBusy = false
-
-    return next(e)
-  }).catch((_$, e, next) => next(e))
-
   on('command.run', { command: 'task-progress' }, async $ => {
     await $.ui.open({ id: PANE, title: 'Task progress' })
 
@@ -261,19 +224,22 @@
     const elapsed = started === 0 ? 0 : (finished || now) - started
     const timing = timingText(elapsed, done, total, finished !== 0)
 
-    const inner = Math.min(
-      MAX_COLUMNS,
-      Math.max(MIN_COLUMNS, (e.props.bodyColumns ?? DEFAULT_COLUMNS + 2 * CARD_PADDING) - 2 * CARD_PADDING),
-    )
-    columns = inner
-    isDone = isAllDone(items)
-    const mode = modeOf(isBusy, isDone)
-    const hasStage = e.surface === 'terminal' && 'Raster' in ui && (e.viewport?.rows ?? 99) >= STAGE_ROWS + 8
-    const stage = hasStage ? (
-      <ui.Raster key="stage" columns={inner} rows={STAGE_ROWS} cells={stageCells(mode, tick, inner)} />
-    ) : null
+    const available = Math.max(1, (e.props.bodyColumns ?? DEFAULT_COLUMNS + 2 * CARD_PADDING) - 2 * CARD_PADDING)
+    const inner = Math.min(MAX_SCENE_COLUMNS, available)
+    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? DEFAULT_BODY_ROWS
+    const Raster = e.surface === 'terminal' && 'Raster' in ui ? ui.Raster : undefined
+    const layout = Raster === undefined ? undefined : sceneLayout(available, bodyRows)
+    const scene =
+      Raster === undefined || layout === undefined ? null : (
+        <Raster
+          key="scene"
+          columns={layout.columns}
+          rows={layout.rows}
+          cells={sceneCells(layout.columns, layout.firstRow, layout.rows, litWindows(done, total, WINDOWS.length))}
+        />
+      )
 
-    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7 - (hasStage ? STAGE_ROWS : 0))
+    const room = Math.max(1, bodyRows - 7 - (layout?.rows ?? 0))
     const shownItems = [
       ...items.filter(i => i.status === 'in_progress'),
       ...items.filter(i => i.status !== 'in_progress'),
@@ -290,7 +256,7 @@
         backgroundColor={COLORS.card}
         height={height}
       >
-        {stage}
+        {scene}
         <Text>
           <Text color={accent}>{filled}</Text>
           <Text color={COLORS.track}>{rest}</Text>
```

- [ ] **Step 5: Delete the singer**

Run: `rm hooks/stage.ts hooks/stage.test.ts hooks/singer.ts`

- [ ] **Step 6: Run tests, type-check and validate**

Run: `claude plugin test .`
Expected: 37 pass, 0 fail across 7 files.

Run: `tsc -p /tmp/task-progress-tsconfig.json`
Expected: no output.

Run: `claude plugin validate .`
Expected: `Validation passed with warnings` (warnings only, no errors).

- [ ] **Step 7: Update the README and the version**

In `README.md`, replace the paragraph starting `The pane shows done/total, percent, elapsed time and an ETA, plus a pixel-art singer portrait` with:

```md
The pane shows done/total, percent, elapsed time and an ETA, under a pixel-art citadel scene (an Erdtree at sunset behind a great citadel). The citadel has 16 windows, all dark at rest; they light up as tasks finish and all glow when the list is done. The scene is 96 columns x 16 rows, cropped around the centre in narrower panes and from the top in shorter ones; a pane that is too small shows the text layout alone.

The scene is generated: `python3 tools/gen-world.py [--preview out.png]` rewrites `hooks/world.ts` (needs Python 3 and Pillow).
```

In `.claude-plugin/plugin.json`, set `"version": "0.6.0"` and `"description": "Pane tracking the session's todo/task list with a progress bar, percent done and a citadel scene whose windows light as tasks finish"`.

---

### Task 5: Final check and the user's look

**Files:** none.

- [ ] **Step 1: Full verification**

Run, from the repo: `claude plugin test .`, `tsc -p /tmp/task-progress-tsconfig.json`, `claude plugin validate .`
Expected: 37 pass 0 fail; no tsc output; validation passed with warnings.

- [ ] **Step 2: Regenerate and confirm the generated file is current**

Run: `cp hooks/world.ts /tmp/world.ts.before && python3 tools/gen-world.py && cmp hooks/world.ts /tmp/world.ts.before && echo SAME`
Expected: `SAME` (the generator is deterministic).

- [ ] **Step 3: Look at it in the real pane**

Run `claude --plugin-dir ~/claude-mods/task-progress` in a terminal at least 96 + 4 columns wide and 31 rows tall, open `/task-progress`, and ask Claude to make a 4-step task list and finish the steps one by one. Expected: the scene shows above the progress bar; windows light 4, 8, 12, 16 as steps complete; a narrower pane crops the scene around the centre.

- [ ] **Step 4: User sign-off**

Show the user the preview PNG and the pane. Success criterion 3 of the spec (the user approves the look) needs their word. Leave everything uncommitted until they ask for a commit.
