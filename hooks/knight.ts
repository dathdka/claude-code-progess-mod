export type Mode = 'idle' | 'run' | 'win'
type Item = { status: string }

export const KNIGHT_COLUMNS = 14
export const KNIGHT_ROWS = 7
export const FRAME_MS = 120

const WIDTH = KNIGHT_COLUMNS
const HEIGHT = KNIGHT_ROWS * 2
const NONE = 0x01000000
const GROUND_Y = HEIGHT - 1
const SPRITE_X = 2
const SPRITE_Y = 1

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

function pixels(mode: Mode, tick: number): number[] {
  const grid = new Array<number>(WIDTH * HEIGHT).fill(NONE)
  const shift = mode === 'run' ? tick : 0
  for (let x = 0; x < WIDTH; x += 1) {
    grid[GROUND_Y * WIDTH + x] = (x + shift) % 4 < 2 ? 0x6b4f3a : 0x4a3626
  }
  const { rows, lift } = sprite(mode, tick)
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx += 1) {
      const color = PALETTE[row[rx] ?? '.']
      const y = SPRITE_Y + ry - lift
      if (color !== undefined && y >= 0 && y < GROUND_Y) {
        grid[y * WIDTH + SPRITE_X + rx] = color
      }
    }
  })
  if (mode === 'win') {
    for (const [x, y] of SPARKLES[Math.floor(tick / 3) % 2] ?? []) {
      grid[y * WIDTH + x] = 0xffe27a
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

export function knightCells(mode: Mode, tick: number): string {
  const grid = pixels(mode, tick)
  const bytes: number[] = []
  const word = (n: number) => bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255)
  for (let row = 0; row < KNIGHT_ROWS; row += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const top = grid[row * 2 * WIDTH + x] ?? NONE
      const bottom = grid[(row * 2 + 1) * WIDTH + x] ?? NONE
      if (top === NONE && bottom === NONE) {
        word(0x20); word(NONE); word(NONE)
      } else if (top === NONE) {
        word(0x2584); word(bottom); word(NONE)
      } else {
        word(0x2580); word(top); word(bottom)
      }
    }
  }

  return base64(bytes)
}

/** Distinct frames of a mode repeat after this many ticks: blit only when the key changes. */
export function frameKey(mode: Mode, tick: number): string {
  if (mode === 'run') return `run:${tick % 4}`
  if (mode === 'win') return `win:${Math.floor(tick / 2) % 2}:${Math.floor(tick / 3) % 2}`

  return `idle:${Math.floor(tick / 6) % 2}`
}
