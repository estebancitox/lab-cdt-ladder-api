import { describe, expect, it } from 'vitest'
import { addDays, dayNumber, parseISODate, toISODate } from './dates'

// The whole suite runs twice in CI: TZ=America/Bogota and TZ=UTC (see test:ci).
// Every assertion here must hold identically in both.

describe('addDays — calendar-day arithmetic', () => {
  it('crosses a year boundary without timezone drift', () => {
    expect(addDays('2026-12-31', 90)).toBe('2027-03-31')
  })

  it('handles Feb 29 in leap and non-leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
  })

  it('366-day rung starting 2027-06-01 matures 2028-06-01', () => {
    expect(addDays('2027-06-01', 366)).toBe('2028-06-01')
  })

  it('is immune to DST transitions of the host timezone', () => {
    // US spring-forward (2026-03-08) and fall-back (2026-11-01) windows.
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09')
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02')
  })

  it('rejects non-integer day counts', () => {
    expect(() => addDays('2026-01-01', 1.5)).toThrow(RangeError)
  })
})

describe('parseISODate / toISODate', () => {
  it('round-trips valid dates', () => {
    for (const d of ['2026-01-01', '2028-02-29', '1999-12-31']) {
      expect(toISODate(parseISODate(d))).toBe(d)
    }
  })

  it('rejects impossible calendar dates and malformed strings', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2027-02-29', 'not-a-date', '2026-2-3', '']) {
      expect(() => parseISODate(bad)).toThrow(RangeError)
    }
  })
})

describe('dayNumber', () => {
  it('differences count real calendar days', () => {
    expect(dayNumber('2027-01-01') - dayNumber('2026-01-01')).toBe(365)
    expect(dayNumber('2029-01-01') - dayNumber('2028-01-01')).toBe(366)
    expect(dayNumber('2026-07-27') - dayNumber('2026-07-26')).toBe(1)
  })
})
