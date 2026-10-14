import { expect, test } from 'claude-code/testing'

import { KNIGHT_COLUMNS, KNIGHT_ROWS, frameKey, knightCells, modeOf } from './knight'

const CELL_BYTES = 12
const ALLOWED_GLYPHS = new Set([0x20, 0x2580, 0x2584])

const decode = (cells: string): number[] => {
  const raw = atob(cells)

  return Array.from(raw, ch => ch.charCodeAt(0))
}

test('mode follows task status', () => {
  expect(modeOf([])).toBe('idle')
  expect(modeOf([{ status: 'pending' }])).toBe('idle')
  expect(modeOf([{ status: 'pending' }, { status: 'in_progress' }])).toBe('run')
  expect(modeOf([{ status: 'completed' }, { status: 'completed' }])).toBe('win')
})

test('every frame has columns*rows cells with only width-1 glyphs', () => {
  for (const mode of ['idle', 'run', 'win'] as const) {
    for (let tick = 0; tick < 24; tick += 1) {
      const bytes = decode(knightCells(mode, tick))
      expect(bytes.length).toBe(KNIGHT_COLUMNS * KNIGHT_ROWS * CELL_BYTES)
      for (let i = 0; i < bytes.length; i += CELL_BYTES) {
        const glyph = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)
        expect(ALLOWED_GLYPHS.has(glyph)).toBe(true)
      }
    }
  }
})

test('running frames differ from each other and from idle', () => {
  const frames = [0, 1, 2, 3].map(t => knightCells('run', t))
  expect(new Set(frames).size).toBe(4)
  expect(frames).not.toContain(knightCells('idle', 0))
  expect(knightCells('win', 0)).not.toBe(knightCells('idle', 0))
})

test('frame key repeats with the animation period', () => {
  expect(frameKey('run', 1)).toBe(frameKey('run', 5))
  expect(frameKey('run', 1)).not.toBe(frameKey('run', 2))
})
