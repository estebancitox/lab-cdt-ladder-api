import { describe, expect, it } from 'vitest'
import { validateScenario } from './validate'
import type { ScenarioInput } from './types'

function valid(): ScenarioInput {
  return {
    startDate: '2026-07-26',
    rungs: [
      { id: 'r1', principal: 10_000_000, days: 90, ea: 0.135, entityId: 'e1' },
      { id: 'r2', principal: 10_000_000, days: 180, ea: 0.14, entityId: 'e1' },
    ],
    entities: [{ id: 'e1', name: 'Entidad A' }],
    fiscal: { retencionRate: 0.04, insuranceCeiling: 50_000_000 },
    dayCountBase: 360,
  }
}

function codes(input: ScenarioInput): string[] {
  return validateScenario(input).map((i) => i.code)
}

describe('validateScenario', () => {
  it('accepts a well-formed scenario', () => {
    expect(validateScenario(valid())).toEqual([])
  })

  it('rejects invalid start dates', () => {
    for (const bad of ['2026-02-30', 'hoy', '']) {
      expect(codes({ ...valid(), startDate: bad })).toContain('start_date_invalid')
    }
  })

  it('rejects an empty ladder', () => {
    expect(codes({ ...valid(), rungs: [] })).toContain('rungs_empty')
  })

  it('rejects non-positive, fractional, or unsafe principals', () => {
    const s = valid()
    for (const principal of [0, -1, 1.5, 2 ** 53]) {
      s.rungs[0] = { ...s.rungs[0], principal }
      expect(codes(s)).toContain('principal_invalid')
    }
  })

  it('rejects invalid terms', () => {
    const s = valid()
    for (const days of [0, -30, 1.5, NaN]) {
      s.rungs[0] = { ...s.rungs[0], days }
      expect(codes(s)).toContain('days_invalid')
    }
  })

  it('rejects E.A. out of [0, 1] — including percent-passed-as-fraction', () => {
    const s = valid()
    for (const ea of [-0.01, 1.01, 13.5, NaN]) {
      s.rungs[0] = { ...s.rungs[0], ea }
      expect(codes(s)).toContain('ea_out_of_range')
    }
  })

  it('rejects rungs without an entity', () => {
    const s = valid()
    s.rungs[0] = { ...s.rungs[0], entityId: '' }
    expect(codes(s)).toContain('entity_missing')
  })

  it('rejects rungs pointing at a nonexistent entity', () => {
    const s = valid()
    s.rungs[0] = { ...s.rungs[0], entityId: 'ghost' }
    expect(codes(s)).toContain('entity_missing')
  })

  it('rejects duplicate entity ids', () => {
    const s = valid()
    s.entities = [
      { id: 'e1', name: 'Entidad A' },
      { id: 'e1', name: 'Entidad B' },
    ]
    expect(codes(s)).toContain('entity_id_duplicate')
  })

  it('rejects retención out of [0, 1) — including percent-passed-as-fraction', () => {
    const s = valid()
    for (const retencionRate of [-0.1, 1, 4, NaN]) {
      s.fiscal = { ...s.fiscal, retencionRate }
      expect(codes(s)).toContain('retencion_out_of_range')
    }
  })

  it('accepts both liquidation bases, rejects anything else', () => {
    for (const dayCountBase of [360, 365] as const) {
      expect(codes({ ...valid(), dayCountBase })).toEqual([])
    }
    for (const bad of [364, 0, 366]) {
      expect(
        codes({ ...valid(), dayCountBase: bad as unknown as 360 }),
      ).toContain('day_count_base_invalid')
    }
  })

  it('rejects invalid insurance ceilings, accepts zero', () => {
    const s = valid()
    for (const insuranceCeiling of [-5, 1.5, 2 ** 53]) {
      s.fiscal = { ...s.fiscal, insuranceCeiling }
      expect(codes(s)).toContain('ceiling_invalid')
    }
    s.fiscal = { ...s.fiscal, insuranceCeiling: 0 }
    expect(codes(s)).not.toContain('ceiling_invalid')
  })

  it('collects multiple issues at once with field paths', () => {
    const s = valid()
    s.rungs[0] = { ...s.rungs[0], principal: 0, days: 0 }
    const issues = validateScenario(s)
    expect(issues.length).toBeGreaterThanOrEqual(2)
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['rungs[0].principal', 'rungs[0].days']),
    )
  })
})
