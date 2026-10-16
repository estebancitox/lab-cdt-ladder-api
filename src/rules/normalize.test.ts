import { describe, expect, it } from 'vitest'
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
    expect(normalize('- **Tope del seguro:** algo')).toBe('- Tope del seguro: algo')
    expect(normalize('_Riesgos_')).toBe('Riesgos')
  })

  it('4. the five special spaces become U+0020', () => {
    expect(normalize('$ 1 2 3 4⁠5')).toBe('$1 2 3 4 5')
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

  it('8. the space between $ and a digit is deleted, 9. the space before % is deleted', () => {
    expect(normalize('$ 1.234.567 y 13,5 %')).toBe('$1.234.567 y 13,5%')
    expect(normalize('$ x')).toBe('$ x')
  })

  it('ICU forms collapse to one token each (SPEC §11.1 rationale)', () => {
    expect(normalize('$ 1.234.567').split(/\s+/u)).toEqual(['$1.234.567'])
    expect(normalize('13,5 %').split(/\s+/u)).toEqual(['13,5%'])
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
    expect(fold('$1.234.567 13,5%')).toBe('$1.234.567 13,5%')
  })
})
