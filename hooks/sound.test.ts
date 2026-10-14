import { expect, test } from 'claude-code/testing'

import { playerCommands, soundPath, wasCutByCap } from './sound'

test('every player gets the file as its last argument, macOS first', () => {
  const commands = playerCommands('/x/a.wav')
  expect(commands[0]).toEqual(['afplay', '/x/a.wav'])
  expect(commands.every(argv => argv.at(-1) === '/x/a.wav')).toBe(true)
  expect(commands.map(argv => argv[0])).toContain('pw-play')
  expect(commands.map(argv => argv[0])).toContain('aplay')
})

test('own absolute file wins, anything else falls back to the bundled clip', () => {
  expect(soundPath('/mod', '/home/me/song.mp3')).toBe('/home/me/song.mp3')
  expect(soundPath('/mod', '  /home/me/song.mp3 ')).toBe('/home/me/song.mp3')
  expect(soundPath('/mod', '')).toBe('/mod/sounds/done.wav')
  expect(soundPath('/mod', '~/song.mp3')).toBe('/mod/sounds/done.wav')
  expect(soundPath('/mod', undefined)).toBe('/mod/sounds/done.wav')
})

test('a failure at the cap means the clip was cut, an instant failure means no player', () => {
  expect(wasCutByCap(0, 12_000, 12_000)).toBe(true)
  expect(wasCutByCap(0, 11_600, 12_000)).toBe(true)
  expect(wasCutByCap(0, 40, 12_000)).toBe(false)
})
