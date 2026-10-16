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
