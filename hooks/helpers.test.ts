import { expect, test } from 'claude-code/testing'

import { staleReminder } from './helpers'

test('the stale reminder comes at the 10th, 20th, 30th call without a list update, only while a task is in progress', () => {
  expect(staleReminder(9, true)).toBeUndefined()
  expect(staleReminder(10, true)).toBe(
    'task-progress: the pane\'s task list has not been updated for 10 tool calls while a task is in progress. Call mcp__task-progress__progress now with the full list and the current status of every task (keep every task as its own entry).',
  )
  expect(staleReminder(11, true)).toBeUndefined()
  expect(staleReminder(19, true)).toBeUndefined()
  expect(staleReminder(20, true)).toContain('for 20 tool calls')
  expect(staleReminder(30, true)).toContain('for 30 tool calls')
  expect(staleReminder(10, false)).toBeUndefined()
  expect(staleReminder(0, true)).toBeUndefined()
})
