import { expect, test } from 'claude-code/testing'

import {
  KNIGHT_ROWS,
  MAX_COLUMNS,
  MIN_COLUMNS,
  frameKey,
  knightCells,
  knightTarget,
  modeOf,
  stepX,
} from './knight'

const CELL_BYTES = 12
const ALLOWED_GLYPHS = new Set([0x20, 0x2580])

const decode = (cells: string): number[] => Array.from(atob(cells), ch => ch.charCodeAt(0))

test('mode follows task status', () => {
  expect(modeOf([])).toBe('idle')
  expect(modeOf([{ status: 'pending' }])).toBe('idle')
  expect(modeOf([{ status: 'pending' }, { status: 'in_progress' }])).toBe('run')
  expect(modeOf([{ status: 'completed' }, { status: 'completed' }])).toBe('win')
})

test('every frame has columns*rows cells with only width-1 glyphs, at any width and position', () => {
  for (const columns of [MIN_COLUMNS, 24, MAX_COLUMNS]) {
    for (const percent of [0, 50, 100]) {
      const x = knightTarget(columns, percent)
      for (const mode of ['idle', 'run', 'win'] as const) {
        for (let tick = 0; tick < 12; tick += 1) {
          const bytes = decode(knightCells(mode, tick, columns, x))
          expect(bytes.length).toBe(columns * KNIGHT_ROWS * CELL_BYTES)
          for (let i = 0; i < bytes.length; i += CELL_BYTES) {
            const glyph = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)
            expect(ALLOWED_GLYPHS.has(glyph)).toBe(true)
          }
        }
      }
    }
  }
})

test('the knight stays clear of the flag and runs further as percent rises', () => {
  expect(knightTarget(24, 0)).toBe(0)
  expect(knightTarget(24, 100)).toBe(24 - 10 - 3)
  expect(knightTarget(24, 50)).toBeGreaterThan(knightTarget(24, 0))
  expect(knightTarget(10, 100)).toBe(0)
})

test('the knight steps toward its target and snaps back when ahead', () => {
  expect(stepX(0, 20)).toBe(2)
  expect(stepX(18, 20)).toBe(19)
  expect(stepX(19, 20)).toBe(20)
  expect(stepX(20, 20)).toBe(20)
  expect(stepX(15, 3)).toBe(3)
})

test('running frames differ from each other and from idle', () => {
  const frames = [0, 1, 2, 3].map(t => knightCells('run', t, 24, 0))
  expect(new Set(frames).size).toBe(4)
  expect(frames).not.toContain(knightCells('idle', 0, 24, 0))
  expect(knightCells('win', 0, 24, 0)).not.toBe(knightCells('idle', 0, 24, 0))
})

test('frame key repeats with the animation period and changes with position or width', () => {
  expect(frameKey('run', 1, 24, 4)).toBe(frameKey('run', 5, 24, 4))
  expect(frameKey('run', 1, 24, 4)).not.toBe(frameKey('run', 2, 24, 4))
  expect(frameKey('idle', 0, 24, 4)).not.toBe(frameKey('idle', 0, 24, 5))
  expect(frameKey('idle', 0, 24, 4)).not.toBe(frameKey('idle', 0, 30, 4))
})
