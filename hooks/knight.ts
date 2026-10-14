export type Mode = 'idle' | 'run' | 'win'
type Item = { status: string }

export const KNIGHT_ROWS = 7
export const FRAME_MS = 120
export const MIN_COLUMNS = 16
export const MAX_COLUMNS = 60
export const SKY = 0x14171c

const NONE = 0x01000000
const HEIGHT = KNIGHT_ROWS * 2
const GROUND_Y = HEIGHT - 1
const SPRITE_W = 10
const SPRITE_Y = 1
const FLAG_W = 3
const OUTLINE = 0x2d333b
const POLE = 0x8b6b4a
const CLOTH = 0xd0312d
const FAR_STEP = 8

const PALETTE: Record<string, number> = {
  R: 0xd0312d,
  L: 0xc9d1d9,
  M: 0x8b95a1,
  D: 0x4a525c,
  V: 0x15181c,
  S: 0xe8eef5,
  G: 0xe0b341,
  B: 0x5a3d2b,
}

const RUN_HEAD = ['...RR.....', '..RRR.....', '..LLLL....', '..LVVVD...', '..LLLLD...']
const RUN_BODY = ['..DLLLD...', '..LLMMLSSS', '..LMMMD...', '..DGGGD...']
const IDLE_HEAD = ['...RR...S.', '..RRR...S.', '..LLLL..S.', '..LVVVD.S.', '..LLLLD.S.']
const IDLE_HEAD_SWAY = ['....RR..S.', '..RRR...S.', '..LLLL..S.', '..LVVVD.S.', '..LLLLD.S.']
const IDLE_BODY = ['..DLLLD.S.', '..LLMMLGGG', '..LMMMD.G.', '..DGGGD...']
const LEGS_STAND = ['..LL.LL...', '..LL.LL...', '..BB.BB...']
const LEGS_STRIDE_A = ['..LL..LL..', '.LL....LL.', '.BB....BB.']
const LEGS_STRIDE_C = ['...LLLL...', '..LL..LL..', '..BB..BBB.']

const SPARKLES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0, 2], [12, 1], [11, 5]],
  [[1, 4], [13, 3], [12, 0]],
]

export function modeOf(items: ReadonlyArray<Item>): Mode {
  if (items.length === 0) return 'idle'
  if (items.every(i => i.status === 'completed')) return 'win'
  return items.some(i => i.status === 'in_progress') ? 'run' : 'idle'
}

function sprite(mode: Mode, tick: number): { rows: string[]; lift: number } {
  if (mode === 'run') {
    const step = tick % 4
    const legs = step === 0 ? LEGS_STRIDE_A : step === 2 ? LEGS_STRIDE_C : LEGS_STAND
    return { rows: [...RUN_HEAD, ...RUN_BODY, ...legs], lift: step % 2 === 1 ? 1 : 0 }
  }
  const head = Math.floor(tick / 6) % 2 === 0 || mode === 'win' ? IDLE_HEAD : IDLE_HEAD_SWAY
  const lift = mode === 'win' && Math.floor(tick / 2) % 2 === 1 ? 1 : 0

  return { rows: [...head, ...IDLE_BODY, ...LEGS_STAND], lift }
}

export function knightTarget(columns: number, percent: number): number {
  const room = Math.max(0, columns - SPRITE_W - FLAG_W)

  return Math.round((Math.min(100, Math.max(0, percent)) / 100) * room)
}

/** One tick of travel toward `target`: two pixels when far, one when near, snapping back when ahead. */
export function stepX(current: number, target: number): number {
  if (current > target) return target
  const gap = target - current

  return current + (gap > FAR_STEP ? 2 : Math.min(1, gap))
}

function outlined(layer: ReadonlyArray<number | undefined>, width: number): Array<number | undefined> {
  const out = [...layer]
  const filled = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < HEIGHT && layer[y * width + x] !== undefined
  for (let y = 0; y < GROUND_Y; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isEdge = filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)
      if (layer[y * width + x] === undefined && isEdge) out[y * width + x] = OUTLINE
    }
  }

  return out
}

function pixels(mode: Mode, tick: number, width: number, x: number): number[] {
  const grid = new Array<number>(width * HEIGHT).fill(SKY)
  const shift = mode === 'run' ? tick : 0
  for (let gx = 0; gx < width; gx += 1) {
    grid[GROUND_Y * width + gx] = (gx + shift) % 4 < 2 ? 0x6b4f3a : 0x4a3626
  }
  const layer = new Array<number | undefined>(width * HEIGHT).fill(undefined)
  const { rows, lift } = sprite(mode, tick)
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx += 1) {
      const color = PALETTE[row[rx] ?? '.']
      const y = SPRITE_Y + ry - lift
      if (color !== undefined && y >= 0 && y < GROUND_Y && x + rx < width) {
        layer[y * width + x + rx] = color
      }
    }
  })
  outlined(layer, width).forEach((color, index) => {
    if (color !== undefined) grid[index] = color
  })
  for (let y = 3; y < GROUND_Y; y += 1) grid[y * width + width - FLAG_W] = POLE
  for (let y = 3; y < 6; y += 1) {
    for (let fx = width - FLAG_W + 1; fx < width; fx += 1) grid[y * width + fx] = CLOTH
  }
  if (mode === 'win') {
    for (const [sx, sy] of SPARKLES[Math.floor(tick / 3) % 2] ?? []) {
      const px = Math.min(width - 1, sx + x)
      grid[sy * width + px] = 0xffe27a
    }
  }

  return grid
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (b >> 4)]
    out += B64[((b & 15) << 2) | (c >> 6)]
    out += B64[c & 63]
  }

  return out
}

export function knightCells(mode: Mode, tick: number, columns: number, x: number): string {
  const grid = pixels(mode, tick, columns, x)
  const bytes: number[] = []
  const word = (n: number) => bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255)
  for (let row = 0; row < KNIGHT_ROWS; row += 1) {
    for (let gx = 0; gx < columns; gx += 1) {
      const top = grid[row * 2 * columns + gx] ?? SKY
      const bottom = grid[(row * 2 + 1) * columns + gx] ?? SKY
      if (top === bottom) {
        word(0x20); word(NONE); word(top)
      } else {
        word(0x2580); word(top); word(bottom)
      }
    }
  }

  return base64(bytes)
}

/** Frames repeat with this key: blit only when it changes. */
export function frameKey(mode: Mode, tick: number, columns: number, x: number): string {
  const base = `${columns}:${x}`
  if (mode === 'run') return `run:${tick % 4}:${base}`
  if (mode === 'win') return `win:${Math.floor(tick / 2) % 2}:${Math.floor(tick / 3) % 2}:${base}`

  return `idle:${Math.floor(tick / 6) % 2}:${base}`
}
