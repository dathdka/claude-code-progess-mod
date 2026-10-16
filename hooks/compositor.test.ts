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
