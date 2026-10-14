import { expect, test } from 'claude-code/testing'

import {
  MAX_COLUMNS,
  MIN_COLUMNS,
  STAGE_ROWS,
  frameKey,
  isAllDone,
  modeOf,
  stageCells,
} from './stage'

const CELL_BYTES = 12
const ALLOWED_GLYPHS = new Set([0x20, 0x2580])

const decode = (cells: string): number[] => Array.from(atob(cells), ch => ch.charCodeAt(0))

test('mode: singing while busy, celebrating once all tasks are done, else resting', () => {
  expect(modeOf(true, false)).toBe('sing')
  expect(modeOf(true, true)).toBe('sing')
  expect(modeOf(false, true)).toBe('win')
  expect(modeOf(false, false)).toBe('idle')
})

test('all done needs at least one task and every task completed', () => {
  expect(isAllDone([])).toBe(false)
  expect(isAllDone([{ status: 'completed' }, { status: 'pending' }])).toBe(false)
  expect(isAllDone([{ status: 'completed' }, { status: 'completed' }])).toBe(true)
})

test('every frame has columns*rows cells with only width-1 glyphs, at any width', () => {
  for (const columns of [MIN_COLUMNS, 60, MAX_COLUMNS]) {
    for (const mode of ['idle', 'sing', 'win'] as const) {
      for (let tick = 0; tick < 50; tick += 7) {
        const bytes = decode(stageCells(mode, tick, columns))
        expect(bytes.length).toBe(columns * STAGE_ROWS * CELL_BYTES)
        for (let i = 0; i < bytes.length; i += CELL_BYTES) {
          const glyph = (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)
          expect(ALLOWED_GLYPHS.has(glyph)).toBe(true)
        }
      }
    }
  }
})

test('singing opens and closes the mouth and moves the notes', () => {
  const frames = Array.from({ length: 8 }, (_, t) => stageCells('sing', t * 2, 60))
  expect(new Set(frames).size).toBe(8)
  expect(stageCells('sing', 0, 60)).not.toBe(stageCells('sing', 1, 60))
  expect(stageCells('idle', 0, 60)).not.toBe(stageCells('sing', 4, 60))
  expect(stageCells('win', 0, 60)).not.toBe(stageCells('idle', 0, 60))
})

test('resting is one still frame; singing changes every tick', () => {
  expect(frameKey('idle', 0, 60)).toBe(frameKey('idle', 99, 60))
  expect(frameKey('sing', 1, 60)).not.toBe(frameKey('sing', 2, 60))
  expect(frameKey('idle', 0, 60)).not.toBe(frameKey('idle', 0, 52))
})
