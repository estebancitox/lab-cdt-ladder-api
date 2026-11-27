import { describe, expect, it } from 'vitest'
import { formatCOP, formatDateShort, formatPercent } from './format'

describe('formatCOP — COP code, en-US grouping, whole pesos only', () => {
  it('groups thousands with commas and puts the code first', () => {
    expect(formatCOP(1_234_567)).toBe('COP 1,234,567')
    expect(formatCOP(26_959_524)).toBe('COP 26,959,524')
  })

  it('groups already at four digits', () => {
    expect(formatCOP(1234)).toBe('COP 1,234')
  })

  it('formats zero and negatives', () => {
    expect(formatCOP(0)).toBe('COP 0')
    expect(formatCOP(-1_234_567)).toBe('-COP 1,234,567')
  })

  it('handles very large amounts', () => {
    expect(formatCOP(1e12)).toBe('COP 1,000,000,000,000')
  })

  it('formats an amount above one billion', () => {
    expect(formatCOP(1_500_000_000)).toBe('COP 1,500,000,000')
  })

  it('puts a plain hyphen before the code on negative amounts', () => {
    const result = formatCOP(-1234)
    expect(result).toBe('-COP 1,234')
    expect(result.startsWith('\u002D')).toBe(true)
    expect(result).not.toContain('\u2212')
  })

  it('formats zero without a sign', () => {
    expect(formatCOP(0)).toBe('COP 0')
  })

  it('separates with one plain space and commas, nothing else', () => {
    const amount = formatCOP(40_000_000)
    expect(amount).toBe('COP 40,000,000')
    // Every character that is not a capital letter or a digit, by code point:
    // U+0020 after the code, then U+002C per group. No U+00A0, no U+202F.
    const separators = Array.from(amount)
      .filter((c) => !/[A-Z0-9]/.test(c))
      .map((c) => c.codePointAt(0))
    expect(separators).toEqual([0x20, 0x2c, 0x2c])
  })

  it('never shows decimals, even for fractional input', () => {
    expect(formatCOP(10.4)).not.toContain('.')
    expect(formatCOP(10.4)).toBe('COP 10')
    expect(formatCOP(1_234_567)).not.toContain('.')
  })
})

describe('formatPercent — en-US decimal point', () => {
  it('uses a decimal point and the % sign', () => {
    expect(formatPercent(0.135)).toBe('13.5%')
    expect(formatPercent(0.04)).toBe('4%')
  })

  it('caps decimals at the requested precision', () => {
    expect(formatPercent(0.132456, 2)).toBe('13.25%')
    expect(formatPercent(0, 2)).toBe('0%')
  })
})

describe('formatDateShort — hand-rolled English abbreviations', () => {
  it('renders day, capitalized month, full year', () => {
    expect(formatDateShort('2027-03-12')).toBe('12 Mar 2027')
    expect(formatDateShort('2026-01-01')).toBe('1 Jan 2026')
    expect(formatDateShort('2028-12-31')).toBe('31 Dec 2028')
  })

  it('renders all twelve month abbreviations', () => {
    expect(formatDateShort('2027-01-01')).toBe('1 Jan 2027')
    expect(formatDateShort('2027-02-01')).toBe('1 Feb 2027')
    expect(formatDateShort('2027-03-01')).toBe('1 Mar 2027')
    expect(formatDateShort('2027-04-01')).toBe('1 Apr 2027')
    expect(formatDateShort('2027-05-01')).toBe('1 May 2027')
    expect(formatDateShort('2027-06-01')).toBe('1 Jun 2027')
    expect(formatDateShort('2027-07-01')).toBe('1 Jul 2027')
    expect(formatDateShort('2027-08-01')).toBe('1 Aug 2027')
    expect(formatDateShort('2027-09-01')).toBe('1 Sep 2027')
    expect(formatDateShort('2027-10-01')).toBe('1 Oct 2027')
    expect(formatDateShort('2027-11-01')).toBe('1 Nov 2027')
    expect(formatDateShort('2027-12-01')).toBe('1 Dec 2027')
  })
})
