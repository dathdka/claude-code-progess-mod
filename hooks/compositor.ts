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
