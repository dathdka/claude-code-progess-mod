import { expect, test } from 'claude-code/testing'

import { formatDuration, remainingMs, timingText } from './progress'

const MIN = 60_000

test('formats seconds, minutes and hours', () => {
  expect(formatDuration(45_000)).toBe('45s')
  expect(formatDuration(12 * MIN)).toBe('12m')
  expect(formatDuration(60 * MIN)).toBe('1h')
  expect(formatDuration(135 * MIN)).toBe('2h15m')
})

test('no estimate until a task is done or once all are', () => {
  expect(remainingMs(10 * MIN, 0, 4)).toBeUndefined()
  expect(remainingMs(10 * MIN, 4, 4)).toBeUndefined()
  expect(remainingMs(10 * MIN, 2, 4)).toBe(10 * MIN)
})

test('timing text for running, finished and empty lists', () => {
  expect(timingText(0, 0, 0, false)).toBe('')
  expect(timingText(5 * MIN, 0, 3, false)).toBe('5m')
  expect(timingText(12 * MIN, 3, 7, false)).toBe('12m · ~16m left')
  expect(timingText(20 * MIN, 3, 3, true)).toBe('20m total')
})
