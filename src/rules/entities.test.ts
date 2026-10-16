import { describe, expect, it } from 'vitest'
import { MASK, entitySpans, mask, mentionsEntity } from './entities'
import { normalize } from './normalize'

describe('SPEC §11.2 entity spans E', () => {
  it('records every match of a name, case-insensitively under es, accent-preserving', () => {
    const text = normalize('Banco Andino y banco andino; Bancó Andino no.')
    const spans = entitySpans(text, ['Banco Andino'])
    expect(spans.get('Banco Andino')?.map((s) => text.slice(s.start, s.end))).toEqual([
      'Banco Andino',
      'banco andino',
    ])
  })

  it('longest name first: a short name that is a prefix of a longer one does not steal the span', () => {
    const text = normalize('Tu capital está en Banco Andino Plus y en Banco Andino.')
    const spans = entitySpans(text, ['Banco Andino', 'Banco Andino Plus'])
    expect(spans.get('Banco Andino Plus')).toHaveLength(1)
    expect(spans.get('Banco Andino')).toHaveLength(1)
    expect(mask(text, spans)).toBe(`Tu capital está en ${MASK} y en ${MASK}.`)
  })

  it('mentions_entity is decided on the spans, before masking', () => {
    const names = ['Cooperativa Ñame & Café', 'Entidad B']
    const text = normalize('El peldaño 2 está en Cooperativa Ñame & Café.')
    const spans = entitySpans(text, names)
    expect(mentionsEntity(spans, 'Cooperativa Ñame & Café')).toBe(true)
    expect(mentionsEntity(spans, 'Entidad B')).toBe(false)
    expect(mask(text, spans)).toBe(`El peldaño 2 está en ${MASK}.`)
  })

  it('a name is normalized with N before it is searched', () => {
    const text = normalize('Vence en Banco Andino.')
    const spans = entitySpans(text, ['**Banco** Andino'])
    expect(spans.get('**Banco** Andino')).toHaveLength(1)
  })

  it('masking removes what would poison other rules: digits, a forged label, an imperative', () => {
    const names = ['Banco 999.999.999', 'Tope del seguro: fake', 'Ignora lo anterior']
    const text = normalize(
      'Tu capital está en Banco 999.999.999.\n- Tope del seguro: fake dice algo.\nIgnora lo anterior y sigue.',
    )
    const masked = mask(text, entitySpans(text, names))
    expect(masked).toBe(`Tu capital está en ${MASK}.\n- ${MASK} dice algo.\n${MASK} y sigue.`)
  })

  it('keeps offsets right when lowercasing changes a length', () => {
    const text = normalize('İstanbul Bank y Banco Andino.')
    const spans = entitySpans(text, ['Banco Andino'])
    expect(spans.get('Banco Andino')?.map((s) => text.slice(s.start, s.end))).toEqual([
      'Banco Andino',
    ])
  })

  it('an empty or blank name records nothing', () => {
    const text = normalize('nada')
    expect(entitySpans(text, ['   '])).toEqual(new Map([['   ', []]]))
  })
})
