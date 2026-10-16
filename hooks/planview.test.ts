import { expect, test } from 'claude-code/testing'

import type { Plan } from '../types'
import { FOCUS_RETURN_MS, phaseLines, phaseNumber, shownFocus, taskLines } from './planview'

const task = (n: number, isDone: boolean, done = 0, total = 3) => ({ name: `Task ${n}: name ${n}`, number: n, done, total, isDone })
/** Five phases of fifteen tasks; `finished` tasks of the whole plan are done, from the top. */
const big = (finished: number): Plan => ({
  title: 'Big',
  phases: Array.from({ length: 5 }, (_, p) => ({
    name: `Phase ${p + 1}`,
    tasks: Array.from({ length: 15 }, (__, t) => task(p * 15 + t + 1, p * 15 + t < finished)),
  })),
})
const texts = (lines: ReturnType<typeof taskLines>) => lines.map(l => l.text)

test('phases are numbered with circled digits up to twelve, then plainly', () => {
  expect(phaseNumber(0)).toBe('①')
  expect(phaseNumber(11)).toBe('⑫')
  expect(phaseNumber(12)).toBe('13')
})

test('the phase list marks done, current and waiting phases with their counts', () => {
  const lines = phaseLines(big(41), 2, 2, 8, 60)
  expect(lines.length).toBe(5)
  expect(lines[0]?.text).toMatch(/^① Phase 1 +✔ 15\/15/)
  expect(lines[1]?.text).toMatch(/^② Phase 2 +✔ 15\/15/)
  expect(lines[2]?.text).toMatch(/^③ Phase 3 +▶ 11\/15 +▰+▱*$/)
  expect(lines[3]?.text).toMatch(/^④ Phase 4 +○ 0\/15$/)
  expect(lines[2]?.isBold).toBe(true)
  expect(lines[3]?.isBold).toBe(false)
})

test('the focused phase also gets a bar when it is not the current one', () => {
  const lines = phaseLines(big(41), 0, 2, 8, 60)
  expect(lines[0]?.text).toMatch(/✔ 15\/15 +▰{8}$/)
  expect(lines[2]?.text).toMatch(/▶ 11\/15 +▰+▱*$/)
  expect(lines[0]?.isBold).toBe(true)
})

test('with more phases than rows the list scrolls to keep the focused phase in view', () => {
  const plan: Plan = { title: 'T', phases: Array.from({ length: 12 }, (_, i) => ({ name: `P${i + 1}`, tasks: [task(i, false)] })) }
  const at = (focus: number) => phaseLines(plan, focus, 0, 8, 40).map(l => l.text.slice(0, 4))
  expect(at(0)[0]).toMatch(/^① P1/)
  expect(at(11).at(-1)).toMatch(/^⑫ P1/)
  expect(at(11).length).toBe(8)
  expect(at(6).join(' ')).toContain('⑦ P7')
})

test('a phase name is cut to fit the width and a one-row budget still shows a row', () => {
  const plan: Plan = { title: 'T', phases: [{ name: 'a very long phase name indeed', tasks: [task(1, false)] }] }
  const lines = phaseLines(plan, 0, 0, 1, 24)
  expect(lines.length).toBe(1)
  expect((lines[0]?.text.length ?? 99) <= 24).toBe(true)
  expect(lines[0]?.text.includes('…')).toBe(true)
})

test('the focused current phase collapses finished tasks, marks the current one, shows the next and counts the rest', () => {
  const lines = texts(taskLines(big(40), 2, 6, 60))
  expect(lines).toEqual(['✔ 9 done', '✔ Task 40: name 40', '▶ Task 41: name 41  0/3', '○ Task 42: name 42', '○ Task 43: name 43', '… +2'])
})

test('with room for all tasks nothing is hidden, a phase not started shows from its first task', () => {
  expect(texts(taskLines(big(0), 3, 20, 60)).length).toBe(15)
  const lines = texts(taskLines(big(0), 3, 4, 60))
  expect(lines).toEqual(['▶ Task 46: name 46  0/3', '○ Task 47: name 47', '○ Task 48: name 48', '… +12'])
})

test('a finished phase reads as one line, a single finished task is not collapsed', () => {
  expect(texts(taskLines(big(15), 0, 5, 60))).toEqual(['✔ all 15 done'])
  const lines = texts(taskLines(big(1), 0, 5, 60))
  expect(lines[0]).toBe('✔ Task 1: name 1')
  expect(lines[1]).toMatch(/^▶ Task 2/)
})

test('a tiny budget keeps the current task and drops the collapsed head first', () => {
  const lines = texts(taskLines(big(40), 2, 1, 60))
  expect(lines).toEqual(['▶ Task 41: name 41  0/3'])
  expect(texts(taskLines(big(40), 2, 2, 60))).toEqual(['✔ Task 40: name 40', '▶ Task 41: name 41  0/3'])
})

test('long task names are cut to the width', () => {
  const plan: Plan = { title: 'T', phases: [{ name: 'P', tasks: [{ name: 'x'.repeat(80), number: null, done: 0, total: 1, isDone: false }] }] }
  expect((taskLines(plan, 0, 3, 30)[0]?.text.length ?? 99) <= 30).toBe(true)
})

test('the focus follows the current phase until a press, and returns to it after a minute', () => {
  const T = 1_700_000_000_000
  expect(shownFocus(null, 0, T, 2, 5)).toBe(2)
  expect(shownFocus(4, T, T + 1000, 2, 5)).toBe(4)
  expect(shownFocus(4, T, T + FOCUS_RETURN_MS, 2, 5)).toBe(4)
  expect(shownFocus(4, T, T + FOCUS_RETURN_MS + 1, 2, 5)).toBe(2)
  expect(shownFocus(9, T, T + 1000, 2, 5)).toBe(4)
  expect(shownFocus(-3, T, T + 1000, 2, 5)).toBe(0)
  expect(shownFocus(null, 0, T, 7, 5)).toBe(4)
})

test('with more than twelve phases (several plans merged) the two-digit numbers still fit the width', () => {
  const long = 'N'.repeat(60)
  const many: Plan = { title: '3 plans', phases: Array.from({ length: 14 }, (_, p) => ({ name: `${long}${p}`, tasks: [task(p + 1, false)] })) }
  for (const line of phaseLines(many, 13, 0, 8, 40)) expect(line.text.length).toBeLessThanOrEqual(40)
})
