import { expect, test } from 'claude-code/testing'

import { litWindows, sceneLayout } from './layout'

test('a roomy pane gets the full 96x16 scene, wider panes still 96', () => {
  expect(sceneLayout(96, 40)).toEqual({ columns: 96, rows: 16, firstRow: 0 })
  expect(sceneLayout(140, 31)).toEqual({ columns: 96, rows: 16, firstRow: 0 })
})

test('a narrow pane keeps the width it has, down to 16 columns', () => {
  expect(sceneLayout(69, 35)).toEqual({ columns: 69, rows: 16, firstRow: 0 })
  expect(sceneLayout(40, 35)).toEqual({ columns: 40, rows: 16, firstRow: 0 })
  expect(sceneLayout(16, 35)).toEqual({ columns: 16, rows: 16, firstRow: 0 })
  expect(sceneLayout(15, 35)).toBeUndefined()
  expect(sceneLayout(0, 35)).toBeUndefined()
})

test('a short pane crops the top rows and keeps the info zone at 15 rows', () => {
  expect(sceneLayout(96, 30)).toEqual({ columns: 96, rows: 15, firstRow: 1 })
  expect(sceneLayout(96, 24)).toEqual({ columns: 96, rows: 9, firstRow: 7 })
  expect(sceneLayout(96, 23)).toEqual({ columns: 96, rows: 8, firstRow: 8 })
  expect(sceneLayout(96, 22)).toBeUndefined()
  expect(sceneLayout(96, 0)).toBeUndefined()
})

test('no windows are lit for an empty list or no progress', () => {
  expect(litWindows(0, 0, 16)).toBe(0)
  expect(litWindows(0, 5, 16)).toBe(0)
})

test('windows light in proportion and all of them only once every task is done', () => {
  expect(litWindows(1, 2, 16)).toBe(8)
  expect(litWindows(1, 3, 16)).toBe(5)
  expect(litWindows(99, 100, 16)).toBe(15)
  expect(litWindows(2, 2, 16)).toBe(16)
  expect(litWindows(1, 1, 16)).toBe(16)
})

test('lit windows never go down as tasks finish', () => {
  for (const total of [1, 2, 3, 7, 16, 40, 200]) {
    let last = 0
    for (let done = 0; done <= total; done += 1) {
      const lit = litWindows(done, total, 16)
      expect(lit >= last).toBe(true)
      expect(lit <= 16).toBe(true)
      expect(lit === 16).toBe(done === total)
      last = lit
    }
  }
})
