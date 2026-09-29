import { describe, expect, it } from 'vitest'
import { formatCOP, formatDateShort, formatPercent } from './format'

// ICU emits U+00A0 or U+202F between symbol and digits depending on version;
// normalize both sides so the suite stays green across Node/ICU builds.
const norm = (s: string) => s.replace(/[  ]/g, ' ')

describe('formatCOP — es-CO, whole pesos only', () => {
  it('groups thousands with dots and separates the symbol', () => {
    expect(norm(formatCOP(1_234_567))).toBe('$ 1.234.567')
    expect(norm(formatCOP(26_959_524))).toBe('$ 26.959.524')
  })

  it('groups already at four digits', () => {
    expect(norm(formatCOP(1234))).toBe('$ 1.234')
  })

  it('formats zero and negatives', () => {
    expect(norm(formatCOP(0))).toBe('$ 0')
    expect(norm(formatCOP(-1_234_567))).toBe('-$ 1.234.567')
  })

  it('handles very large amounts', () => {
    expect(norm(formatCOP(1e12))).toBe('$ 1.000.000.000.000')
  })

  it('never shows decimals, even for fractional input', () => {
    expect(formatCOP(10.4)).not.toContain(',')
    expect(norm(formatCOP(10.4))).toBe('$ 10')
    expect(formatCOP(1_234_567)).not.toContain(',')
  })
})

describe('formatPercent — es-CO decimal comma', () => {
  it('uses a decimal comma and the % sign', () => {
    expect(norm(formatPercent(0.135)).replace(/\s/g, '')).toBe('13,5%')
    expect(norm(formatPercent(0.04)).replace(/\s/g, '')).toBe('4%')
  })

  it('caps decimals at the requested precision', () => {
    expect(norm(formatPercent(0.132456, 2)).replace(/\s/g, '')).toBe('13,25%')
    expect(norm(formatPercent(0, 2)).replace(/\s/g, '')).toBe('0%')
  })
})

describe('formatDateShort — hand-rolled es abbreviations', () => {
  it('renders day, lowercase month, full year', () => {
    expect(formatDateShort('2027-03-12')).toBe('12 mar 2027')
    expect(formatDateShort('2026-01-01')).toBe('1 ene 2026')
    expect(formatDateShort('2028-12-31')).toBe('31 dic 2028')
  })
})
