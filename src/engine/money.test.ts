import { describe, expect, it } from 'vitest'
import { roundCOP, splitCapital } from './money'

describe('roundCOP', () => {
  it('rounds half-up and truncates float noise on large amounts', () => {
    expect(roundCOP(0.5)).toBe(1)
    expect(roundCOP(10.4)).toBe(10)
    // Measured: 850_000_000 * ((1.135)^(90/365) - 1) = 26_959_524.2123186
    expect(roundCOP(26_959_524.2123186)).toBe(26_959_524)
  })

  it('never returns -0', () => {
    expect(Object.is(roundCOP(-0.4), 0)).toBe(true)
    expect(Object.is(roundCOP(-0.5), 0)).toBe(true)
  })
})

describe('splitCapital', () => {
  it('always sums back to the input exactly', () => {
    for (const [total, parts] of [
      [50_000_000, 3],
      [850_000_000, 4],
      [10, 3],
      [5, 5],
      [999_999_999, 7],
    ] as const) {
      const split = splitCapital(total, parts)
      expect(split).toHaveLength(parts)
      expect(split.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })

  it('distributes the remainder one peso at a time from the first rung', () => {
    expect(splitCapital(50_000_000, 3)).toEqual([16_666_667, 16_666_667, 16_666_666])
    expect(splitCapital(10, 3)).toEqual([4, 3, 3])
  })

  it('rejects non-positive or non-integer inputs', () => {
    expect(() => splitCapital(0, 3)).toThrow(RangeError)
    expect(() => splitCapital(-5, 3)).toThrow(RangeError)
    expect(() => splitCapital(10.5, 3)).toThrow(RangeError)
    expect(() => splitCapital(10, 0)).toThrow(RangeError)
    expect(() => splitCapital(10, 2.5)).toThrow(RangeError)
    expect(() => splitCapital(2 ** 53, 2)).toThrow(RangeError)
  })
})
