import { expect, test } from 'claude-code/testing'

import { contextAlarm, formatGauges, freshLimitAlerts, limitName, readingsFromUsage, resetText } from './gauges'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const text = (segments: ReturnType<typeof formatGauges>): string => (segments ?? []).map(s => s.text).join('')

test('context comes from percent, else from tokens over window, rounded and clamped', () => {
  expect(readingsFromUsage({ context: { tokens: 1, window: 1, percent: 62.4 }, rateLimits: [] }).context).toBe(62)
  expect(readingsFromUsage({ context: { tokens: 250, window: 1000 }, rateLimits: [] }).context).toBe(25)
  expect(readingsFromUsage({ context: { percent: 140 }, rateLimits: [] }).context).toBe(100)
  expect(readingsFromUsage({ context: { percent: -3 }, rateLimits: [] }).context).toBe(0)
  expect(readingsFromUsage({ context: { tokens: 5, window: 0 }, rateLimits: [] }).context).toBeUndefined()
  expect(readingsFromUsage({ context: {}, rateLimits: [] }).context).toBeUndefined()
})

test('junk usage gives no readings and never throws', () => {
  for (const junk of [undefined, null, 5, 'x', [], {}, { context: 'x', rateLimits: 'y' }, { context: { percent: Number.NaN }, rateLimits: [null, 3, {}] }]) {
    expect(readingsFromUsage(junk)).toEqual({ context: undefined, limits: [] })
  }
})

test('only five_hour and seven_day limits are kept, once each, in that order', () => {
  const usage = {
    context: {},
    rateLimits: [
      { kind: 'seven_day', percentUsed: 9 },
      { kind: 'spend_limit', percentUsed: 50 },
      { kind: 'five_hour', percentUsed: 31.6, resetsAt: '2026-10-16T03:10:00.000Z' },
      { kind: 'five_hour', percentUsed: 99 },
      { kind: 'seven_day', percentUsed: 'many' },
    ],
  }
  expect(readingsFromUsage(usage).limits).toEqual([
    { kind: 'five_hour', percent: 32, resetsAt: '2026-10-16T03:10:00.000Z' },
    { kind: 'seven_day', percent: 9, resetsAt: undefined },
  ])
})

test('the gauges line shows a bar and a figure for each reading', () => {
  const readings = { context: 62, limits: [{ kind: 'five_hour' as const, percent: 31, resetsAt: undefined }, { kind: 'seven_day' as const, percent: 9, resetsAt: undefined }] }
  expect(text(formatGauges(readings, NOW))).toBe('ctx ▰▰▰▰▰▱▱▱ 62%   5h ▰▱▱▱ 31%   7d ▱▱▱▱ 9%')
  expect(text(formatGauges({ context: undefined, limits: readings.limits }, NOW))).toBe('5h ▰▱▱▱ 31%   7d ▱▱▱▱ 9%')
  expect(text(formatGauges({ context: 100, limits: [] }, NOW))).toBe('ctx ▰▰▰▰▰▰▰▰ 100%')
})

test('no reading at all gives no line', () => {
  expect(formatGauges({ context: undefined, limits: [] }, NOW)).toBeUndefined()
})

test('a figure at 80% or more takes the warning tone, a limit also shows when it resets', () => {
  const tone = (percent: number) => formatGauges({ context: percent, limits: [] }, NOW)?.at(-1)?.tone
  expect(tone(79)).toBe('text')
  expect(tone(80)).toBe('warn')

  const resetsAt = new Date(NOW + 130 * MINUTE).toISOString()
  const hot = formatGauges({ context: undefined, limits: [{ kind: 'five_hour', percent: 85, resetsAt }] }, NOW)
  expect(text(hot)).toBe('5h ▰▰▰▱ 85% ↻2h10m')
  const cool = formatGauges({ context: undefined, limits: [{ kind: 'five_hour', percent: 79, resetsAt }] }, NOW)
  expect(text(cool)).toBe('5h ▰▰▰▱ 79%')
})

test('reset text counts up to whole minutes and ignores a missing, junk or past time', () => {
  expect(resetText(new Date(NOW + 40 * MINUTE).toISOString(), NOW)).toBe('40m')
  expect(resetText(new Date(NOW + 40 * MINUTE + 1).toISOString(), NOW)).toBe('41m')
  expect(resetText(new Date(NOW + 60 * MINUTE).toISOString(), NOW)).toBe('1h00m')
  expect(resetText(new Date(NOW + 130 * MINUTE).toISOString(), NOW)).toBe('2h10m')
  expect(resetText(undefined, NOW)).toBeUndefined()
  expect(resetText('soon', NOW)).toBeUndefined()
  expect(resetText(new Date(NOW - MINUTE).toISOString(), NOW)).toBeUndefined()
})

test('the limit names are 5h and 7d', () => {
  expect(limitName('five_hour')).toBe('5h')
  expect(limitName('seven_day')).toBe('7d')
})

test('the context alarm fires once per crossing of 80% and re-arms only below 70%', () => {
  let armed = true
  const feed = (percent: number | undefined): boolean => {
    const next = contextAlarm(armed, percent)
    armed = next.isArmed

    return next.shouldFire
  }
  expect([62, 79, 80, 85, 75, 72, 81, 69, 80].map(feed)).toEqual([false, false, true, false, false, false, false, false, true])
  expect(feed(undefined)).toBe(false)
})

test('a limit alert fires once per window, again for a later window or after a dip, never for a jittering reset time', () => {
  const at = (percent: number, resetsAt?: string) => ({ kind: 'five_hour' as const, percent, resetsAt })
  const first = freshLimitAlerts(new Map(), [at(91, '2026-10-16T03:10:00.000Z'), { kind: 'seven_day', percent: 40, resetsAt: undefined }])
  expect(first.fresh.length).toBe(1)
  expect(freshLimitAlerts(first.announced, [at(92, '2026-10-16T03:10:00.000Z')]).fresh).toEqual([])
  expect(freshLimitAlerts(first.announced, [at(92, '2026-10-16T03:10:00.900Z')]).fresh).toEqual([])
  expect(freshLimitAlerts(first.announced, [at(92, '2026-10-16T08:10:00.000Z')]).fresh.length).toBe(1)
  const dipped = freshLimitAlerts(first.announced, [at(50, '2026-10-16T03:10:00.000Z')])
  expect(freshLimitAlerts(dipped.announced, [at(95, '2026-10-16T03:10:00.000Z')]).fresh.length).toBe(1)
  const noReset = freshLimitAlerts(new Map(), [at(91)])
  expect(noReset.fresh.length).toBe(1)
  expect(freshLimitAlerts(noReset.announced, [at(93)]).fresh).toEqual([])
  expect(freshLimitAlerts(new Map(), [at(89)]).fresh).toEqual([])
})

test('the gauges line gives up its reset times, then 7d, then 5h, to fit the width', () => {
  const resetsAt = new Date(NOW + 130 * MINUTE).toISOString()
  const readings = { context: 85, limits: [{ kind: 'five_hour' as const, percent: 85, resetsAt }, { kind: 'seven_day' as const, percent: 90, resetsAt }] }
  const width = (w: number) => text(formatGauges(readings, NOW, w))
  expect(width(100)).toBe('ctx ▰▰▰▰▰▰▰▱ 85%   5h ▰▰▰▱ 85% ↻2h10m   7d ▰▰▰▰ 90% ↻2h10m')
  expect(width(55)).toBe('ctx ▰▰▰▰▰▰▰▱ 85%   5h ▰▰▰▱ 85%   7d ▰▰▰▰ 90%')
  expect(width(40)).toBe('ctx ▰▰▰▰▰▰▰▱ 85%   5h ▰▰▰▱ 85%')
  expect(width(20)).toBe('ctx ▰▰▰▰▰▰▰▱ 85%')
  expect(width(5)).toBe('ctx ▰▰▰▰▰▰▰▱ 85%')
})
