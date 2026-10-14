import { PORTRAIT_PALETTE, PORTRAIT_ROWS } from './singer'

export type Mode = 'idle' | 'sing' | 'win'
type Item = { status: string }

export const STAGE_ROWS = 22
export const FRAME_MS = 120
export const MIN_COLUMNS = 52
export const MAX_COLUMNS = 70
export const SKY = 0x14171c
export const PORTRAIT_SIZE = 40

const NONE = 0x01000000
const HEIGHT = STAGE_ROWS * 2
const PORTRAIT_Y = 2
const OUTLINE = 0x58606b

const MOUTH_X = 18
const MOUTH_Y = 23
const MOUTH_W = 5
const MOUTH_DARK = 0x3a1218
const MOUTH_SEQUENCE = [0, 1, 2, 2, 1, 2, 0, 1] as const

const NOTE = ['..XXX', '..X..', '..X..', '..X..', '.XX..', 'XXX..', '.X...'] as const
const NOTE_COLORS = [0x79c0ff, 0xf778ba, 0xf2cc60] as const
const NOTE_PERIOD = 46
const NOTE_STAGGER = 15
const NOTE_START_Y = 30

const SPARKLES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[-3, 3], [42, 6], [-2, 28], [43, 25]],
  [[-4, 14], [43, 1], [-1, 36], [42, 32]],
]

export function modeOf(isBusy: boolean, isAllDone: boolean): Mode {
  if (isBusy) return 'sing'

  return isAllDone ? 'win' : 'idle'
}

export function isAllDone(items: ReadonlyArray<Item>): boolean {
  return items.length > 0 && items.every(i => i.status === 'completed')
}

function mouthRows(mode: Mode, tick: number): number {
  if (mode === 'idle') return 0
  if (mode === 'win') return 2

  return MOUTH_SEQUENCE[Math.floor(tick / 2) % MOUTH_SEQUENCE.length] ?? 0
}

function lift(mode: Mode, tick: number): number {
  const phase = Math.floor(tick / 2) % 2 === 1
  if (mode === 'sing') return phase ? 1 : 0
  if (mode === 'win') return phase ? 2 : 0

  return 0
}

function portraitLayer(mode: Mode, tick: number, width: number, left: number): Array<number | undefined> {
  const layer = new Array<number | undefined>(width * HEIGHT).fill(undefined)
  const top = PORTRAIT_Y - lift(mode, tick)
  const put = (x: number, y: number, color: number) => {
    const gx = left + x
    const gy = top + y
    if (gx >= 0 && gx < width && gy >= 0 && gy < HEIGHT) layer[gy * width + gx] = color
  }
  PORTRAIT_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) put(x, y, PORTRAIT_PALETTE[row[x] ?? ''] ?? SKY)
  })
  const open = mouthRows(mode, tick)
  for (let y = 0; y < open; y += 1) {
    for (let x = 0; x < MOUTH_W; x += 1) put(MOUTH_X + x, MOUTH_Y + y, MOUTH_DARK)
  }

  return layer
}

function outlined(layer: ReadonlyArray<number | undefined>, width: number): Array<number | undefined> {
  const out = [...layer]
  const filled = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < HEIGHT && layer[y * width + x] !== undefined
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isEdge = filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)
      if (layer[y * width + x] === undefined && isEdge) out[y * width + x] = OUTLINE
    }
  }

  return out
}

function drawNotes(grid: number[], tick: number, width: number, left: number): void {
  NOTE_COLORS.forEach((color, index) => {
    const phase = (tick + index * NOTE_STAGGER) % NOTE_PERIOD
    const sway = Math.floor(phase / 5) % 2 === 0 ? 0 : 2
    const x = index % 2 === 0 ? left + PORTRAIT_SIZE + 2 + sway : left - 7 - sway
    const y = NOTE_START_Y - phase
    NOTE.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx += 1) {
        const gx = x + rx
        const gy = y + ry
        if (row[rx] === 'X' && gx >= 0 && gx < width && gy >= 0 && gy < HEIGHT) grid[gy * width + gx] = color
      }
    })
  })
}

function pixels(mode: Mode, tick: number, width: number): number[] {
  const grid = new Array<number>(width * HEIGHT).fill(SKY)
  const left = Math.max(0, Math.floor((width - PORTRAIT_SIZE) / 2))
  if (mode === 'sing') drawNotes(grid, tick, width, left)
  outlined(portraitLayer(mode, tick, width, left), width).forEach((color, index) => {
    if (color !== undefined) grid[index] = color
  })
  if (mode === 'win') {
    for (const [sx, sy] of SPARKLES[Math.floor(tick / 3) % 2] ?? []) {
      const gx = left + sx
      if (gx >= 0 && gx < width && sy >= 0 && sy < HEIGHT) grid[sy * width + gx] = 0xffe27a
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

export function stageCells(mode: Mode, tick: number, columns: number): string {
  const grid = pixels(mode, tick, columns)
  const bytes: number[] = []
  const word = (n: number) => bytes.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255)
  for (let row = 0; row < STAGE_ROWS; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const top = grid[row * 2 * columns + x] ?? SKY
      const bottom = grid[(row * 2 + 1) * columns + x] ?? SKY
      if (top === bottom) {
        word(0x20); word(NONE); word(top)
      } else {
        word(0x2580); word(top); word(bottom)
      }
    }
  }

  return base64(bytes)
}

/** Frames repeat with this key: blit only when it changes. Singing moves every tick (the notes rise). */
export function frameKey(mode: Mode, tick: number, columns: number): string {
  if (mode === 'sing') return `sing:${tick}:${columns}`
  if (mode === 'win') return `win:${Math.floor(tick / 2) % 2}:${Math.floor(tick / 3) % 2}:${columns}`

  return `idle:${columns}`
}
