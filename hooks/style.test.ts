import { expect, test } from 'claude-code/testing'

import { barParts, truncate } from './style'

test('truncate keeps short text and ellipsizes long text to the width', () => {
  expect(truncate('abc', 5)).toBe('abc')
  expect(truncate('abcdef', 4)).toBe('abc…')
  expect(truncate('abcdef', 6)).toBe('abcdef')
  expect(truncate('abcdef', 1)).toBe('a')
})

test('bar fills in proportion and always spans the width', () => {
  expect(barParts(0, 10)).toEqual({ filled: '', rest: '░░░░░░░░░░' })
  expect(barParts(50, 10)).toEqual({ filled: '█████', rest: '░░░░░' })
  expect(barParts(100, 10)).toEqual({ filled: '██████████', rest: '' })
  expect(barParts(150, 4).filled.length + barParts(150, 4).rest.length).toBe(4)
})
