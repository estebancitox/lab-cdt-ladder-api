import { describe, expect, it } from 'vitest'
import { formatCOP, formatPercent } from '../engine'
import { SPEC_MD } from '../test-support/contract'
import { fold, normalize } from './normalize'

describe('SPEC §11.1 normalization N, step by step', () => {
  it('1. NFC: a decomposed accent becomes one code point', () => {
    expect(normalize('Qué pasa')).toBe('Qué pasa')
  })

  it('2. CRLF and CR become LF', () => {
    expect(normalize('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('3. asterisks and underscores are deleted, so a bold label survives (SPEC example)', () => {
    expect(normalize('- **Deposit-insurance ceiling:** x')).toBe('- Deposit-insurance ceiling: x')
    expect(normalize('_Risks_')).toBe('Risks')
  })

  it('4. the five special spaces become U+0020', () => {
    expect(normalize('COP 1 2 3 4⁠5')).toBe('COP1 2 3 4 5')
  })

  it('5. horizontal whitespace collapses, newlines survive', () => {
    expect(normalize('a \t  b\n\nc')).toBe('a b\n\nc')
  })

  it('6. lines are trimmed and three or more newlines become two', () => {
    expect(normalize('  a  \n\n\n\n  b  ')).toBe('a\n\nb')
  })

  it('7. the whole string is trimmed', () => {
    expect(normalize('\n\n a \n\n')).toBe('a')
  })

  it('8. the space between COP and a digit is deleted, 9. the space before % is deleted', () => {
    expect(normalize('COP 1,234,567 and 13.5 %')).toBe('COP1,234,567 and 13.5%')
    expect(normalize('-COP 1,234')).toBe('-COP1,234')
    // Only the code as a word, and only before a digit.
    expect(normalize('COP x')).toBe('COP x')
    expect(normalize('SCOP 5')).toBe('SCOP 5')
    // v1's form is no longer joined: the engine does not print it.
    expect(normalize('$ 1,234')).toBe('$ 1,234')
  })

  it('an amount and a percentage are one token each (SPEC §11.1 rationale)', () => {
    expect(normalize(formatCOP(40_000_000)).split(/\s+/u)).toEqual(['COP40,000,000'])
    expect(normalize('13.5 %').split(/\s+/u)).toEqual(['13.5%'])
    expect(normalize(formatPercent(0.135))).toBe('13.5%')
  })

  it('is the nine steps the SPEC lists, in order', () => {
    const section = SPEC_MD.slice(SPEC_MD.indexOf('### 11.1'), SPEC_MD.indexOf('### 11.2'))
    const steps = [...section.matchAll(/^\d+\. /gm)].length
    expect(steps).toBe(9)
  })
})

describe('fold: lowercased and accent-folded', () => {
  it('drops accents and case, keeping digits and punctuation', () => {
    expect(fold('1 de Junio de 2027')).toBe('1 de junio de 2027')
    expect(fold('Instrucción')).toBe('instruccion')
    expect(fold('COP1,234,567 13.5%')).toBe('cop1,234,567 13.5%')
  })
})
