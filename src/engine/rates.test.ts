import { describe, expect, it } from 'vitest'
import { periodRate } from './rates'
import type { DayCountBase } from './types'

const BASES: DayCountBase[] = [360, 365]

describe('periodRate — parameterized liquidation base', () => {
  it('a term equal to the base recovers the E.A. (approximately, same code path)', () => {
    for (const base of BASES) {
      for (const ea of [0, 0.01, 0.135, 0.5]) {
        expect(periodRate(ea, base, base)).toBeCloseTo(ea, 12)
      }
    }
  })

  it('compounds instead of pro-rating linearly on both bases', () => {
    // base 365: 360-day term
    const r365 = periodRate(0.12, 360, 365)
    expect(r365).toBeCloseTo(0.1182626074812847, 12)
    expect(Math.abs(r365 - (0.12 * 360) / 365)).toBeGreaterThan(5e-5)
    // base 360: 390-day term
    const r360 = periodRate(0.12, 390, 360)
    expect(r360).toBeCloseTo(Math.pow(1.12, 390 / 360) - 1, 15)
    expect(Math.abs(r360 - (0.12 * 390) / 360)).toBeGreaterThan(5e-4)
  })

  it('a double-base term equals (1+EA)^2 − 1, not 2×EA', () => {
    for (const base of BASES) {
      const r = periodRate(0.12, base * 2, base)
      expect(r).toBeCloseTo(Math.pow(1.12, 2) - 1, 12)
      expect(Math.abs(r - 0.24)).toBeGreaterThan(0.01)
    }
  })

  it('base 365: a 366-day term yields slightly more than the E.A. (Feb-29 asymmetry)', () => {
    expect(periodRate(0.12, 366, 365)).toBeGreaterThan(0.12)
    expect(periodRate(0.12, 366, 365)).toBeCloseTo(Math.pow(1.12, 366 / 365) - 1, 15)
  })

  it('the two bases genuinely differ for the same term', () => {
    // 90 days at 13,5 %: base 360 accrues faster than base 365.
    expect(periodRate(0.135, 90, 360)).toBeGreaterThan(periodRate(0.135, 90, 365))
  })

  it('E.A. of 0 % gives exactly zero for any term on either base', () => {
    for (const base of BASES) {
      for (const days of [1, 90, 360, 365, 730]) {
        expect(periodRate(0, days, base)).toBe(0)
      }
    }
  })
})
