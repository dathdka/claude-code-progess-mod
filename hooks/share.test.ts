import { expect, test } from 'claude-code/testing'

import { CURRENT_MAX, RECORD_VERSION, parseRecord, parseRegistry, progressRecord } from './share'

const ITEMS = [
  { id: '0', label: 'first', status: 'completed' },
  { id: '1', label: 'second', status: 'in_progress' },
  { id: '2', label: 'third', status: 'pending' },
] as const

test('a record counts done and total and names the task in progress', () => {
  expect(progressRecord('s1', ITEMS, 1000)).toEqual({
    v: RECORD_VERSION,
    sessionId: 's1',
    done: 1,
    total: 3,
    current: 'second',
    updatedAt: 1000,
  })
})

test('a record with no task in progress has an empty current, and a long label is cut', () => {
  expect(progressRecord('s1', [], 5)).toEqual({ v: 1, sessionId: 's1', done: 0, total: 0, current: '', updatedAt: 5 })
  const long = [{ id: '0', label: 'x'.repeat(200), status: 'in_progress' }] as const
  expect(progressRecord('s1', long, 5).current.length).toBe(CURRENT_MAX)
})

test('a record survives the round trip through JSON', () => {
  const record = progressRecord('s1', ITEMS, 1000)
  expect(parseRecord(JSON.stringify(record))).toEqual(record)
})

test('parseRecord refuses junk, other versions and wrong types', () => {
  const good = { v: 1, sessionId: 's1', done: 1, total: 2, current: '', updatedAt: 9 }
  expect(parseRecord('')).toBeUndefined()
  expect(parseRecord('{"v":1,"sessionId":"s1","done":1')).toBeUndefined()
  expect(parseRecord('[]')).toBeUndefined()
  expect(parseRecord('null')).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, v: 2 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, sessionId: '' }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, done: '1' }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, total: -1 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...good, current: 3 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify(good))).toEqual(good)
})

test('parseRegistry reads a session file and fills what is missing', () => {
  const text = JSON.stringify({
    pid: 42,
    sessionId: 'abc',
    name: 'Sync giá AI',
    kind: 'interactive',
    status: 'idle',
    statusUpdatedAt: 7000,
    startedAt: 1000,
    cwd: '/x',
  })
  expect(parseRegistry(text)).toEqual({
    sessionId: 'abc',
    pid: 42,
    name: 'Sync giá AI',
    kind: 'interactive',
    status: 'idle',
    statusSince: 7000,
    startedAt: 1000,
  })
  expect(parseRegistry('{"pid":1,"sessionId":"z"}')).toEqual({
    sessionId: 'z',
    pid: 1,
    name: '',
    kind: '',
    status: '',
    statusSince: 0,
    startedAt: 0,
  })
})

test('parseRegistry refuses junk and entries without an id or a pid', () => {
  expect(parseRegistry('nope')).toBeUndefined()
  expect(parseRegistry('{"pid":1}')).toBeUndefined()
  expect(parseRegistry('{"sessionId":"z"}')).toBeUndefined()
  expect(parseRegistry('{"sessionId":"z","pid":"1"}')).toBeUndefined()
})

test('control characters in text from another session never reach the pane', () => {
  const entry = parseRegistry(JSON.stringify({ pid: 1, sessionId: 'z', name: 'a\nb\u001b[31mc', status: 'id\tle' }))
  expect(entry?.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  expect(entry?.status).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  const record = parseRecord(JSON.stringify({ v: 1, sessionId: 'z', done: 0, total: 1, current: 'x\ny', updatedAt: 1 }))
  expect(record?.current).toBe('x y')
})
