import { describe, expect, it } from 'vitest'
import { formatTimecode, parseTimecode } from './timecode'

describe('timecode', () => {
  it('formats frames as minutes and hundredths', () => {
    expect(formatTimecode(0, 30)).toBe('0:00.00')
    expect(formatTimecode(675, 30)).toBe('0:22.50')
    expect(formatTimecode(1920, 30)).toBe('1:04.00')
  })

  it('parses minutes, bare seconds and explicit frames', () => {
    expect(parseTimecode('0:22.50', 30)).toBe(675)
    expect(parseTimecode('1:04', 30)).toBe(1920)
    expect(parseTimecode('75.5', 30)).toBe(2265)
    expect(parseTimecode(' F42 ', 30)).toBe(42)
  })

  it('round-trips formatted values', () => {
    for (const frame of [0, 1, 29, 30, 899, 1921]) {
      expect(parseTimecode(formatTimecode(frame, 30), 30)).toBe(frame)
    }
  })

  it('rejects text that is not a time', () => {
    expect(parseTimecode('', 30)).toBeNull()
    expect(parseTimecode('abc', 30)).toBeNull()
    expect(parseTimecode('1:75', 30)).toBeNull()
    expect(parseTimecode('-3', 30)).toBeNull()
  })
})
