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
