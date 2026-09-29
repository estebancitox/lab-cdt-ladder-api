import { describe, expect, it } from 'vitest'
import { computeScenario } from './scenario'
import type { Entity, FiscalParams, RungInput, ScenarioInput } from './types'

const ENTITIES: Entity[] = [
  { id: 'e1', name: 'Entidad A' },
  { id: 'e2', name: 'Entidad B' },
]

function input(
  rungs: Array<Partial<RungInput> & { id: string }>,
  fiscal: Partial<FiscalParams> = {},
): ScenarioInput {
  return {
    startDate: '2026-07-26',
    rungs: rungs.map((r) => ({
      principal: 20_000_000,
      days: 90,
      ea: 0.1,
      entityId: 'e1',
      ...r,
    })),
    entities: ENTITIES,
    fiscal: { retencionRate: 0.04, insuranceCeiling: 50_000_000, ...fiscal },
    dayCountBase: 360,
  }
}

describe('entityExposures — per-entity aggregation vs ceiling', () => {
  it('aggregates rungs of the same entity: 3 × 20M breaches a 50M ceiling once', () => {
    const result = computeScenario(input([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]))
    expect(result.exposures).toHaveLength(1)
    const e = result.exposures[0]
    expect(e.entityId).toBe('e1')
    expect(e.principal).toBe(60_000_000)
    expect(e.exposure).toBe(60_000_000 + e.interest)
    expect(e.exceeded).toBe(true)
    expect(e.excess).toBe(e.exposure - 50_000_000)
  })

  it('the same money split across entities stays under the ceiling', () => {
    const result = computeScenario(
      input([
        { id: 'r1', entityId: 'e1' },
        { id: 'r2', entityId: 'e1' },
        { id: 'r3', entityId: 'e2' },
      ]),
    )
    expect(result.exposures).toHaveLength(2)
    expect(result.exposures.map((e) => e.exceeded)).toEqual([false, false])
    expect(result.exposures.map((e) => e.entityId)).toEqual(['e1', 'e2'])
    // Kills the mutant that drops the Math.max clamp: under-ceiling excess
    // must be exactly 0, never negative pesos.
    expect(result.exposures.map((e) => e.excess)).toEqual([0, 0])
  })

  it('exposures follow the entities-list order, not rung encounter order', () => {
    const result = computeScenario(
      input([
        { id: 'r1', entityId: 'e2' },
        { id: 'r2', entityId: 'e1' },
      ]),
    )
    expect(result.exposures.map((e) => e.entityId)).toEqual(['e1', 'e2'])
  })

  it('exactly at the ceiling is compliant; one peso over warns', () => {
    // EA 0 → exposure equals the principal exactly.
    const at = computeScenario(
      input([{ id: 'r1', principal: 50_000_000, ea: 0 }]),
    ).exposures[0]
    expect(at.exposure).toBe(50_000_000)
    expect(at.exceeded).toBe(false)
    expect(at.excess).toBe(0)

    const over = computeScenario(
      input([{ id: 'r1', principal: 50_000_001, ea: 0 }]),
    ).exposures[0]
    expect(over.exceeded).toBe(true)
    expect(over.excess).toBe(1)
  })

  it('exposure uses gross interest, not net of retención', () => {
    const result = computeScenario(input([{ id: 'r1' }]))
    const e = result.exposures[0]
    const rung = result.rungs[0]
    expect(rung.retencion).toBeGreaterThan(0)
    expect(e.exposure).toBe(rung.principal + rung.grossInterest)
    expect(e.exposure).not.toBe(rung.principal + rung.netInterest)
  })

  it('a retención change never moves the exposure', () => {
    const base = computeScenario(input([{ id: 'r1' }], { retencionRate: 0 }))
    const taxed = computeScenario(input([{ id: 'r1' }], { retencionRate: 0.07 }))
    expect(base.exposures[0].exposure).toBe(taxed.exposures[0].exposure)
  })

  it('entities without rungs are omitted; order follows the entities list', () => {
    const result = computeScenario(input([{ id: 'r1', entityId: 'e2' }]))
    expect(result.exposures).toHaveLength(1)
    expect(result.exposures[0].entityId).toBe('e2')
    expect(result.exposures[0].entityName).toBe('Entidad B')
  })

  it('ceiling 0 means no coverage: any positive exposure warns', () => {
    const e = computeScenario(
      input([{ id: 'r1' }], { insuranceCeiling: 0 }),
    ).exposures[0]
    expect(e.exceeded).toBe(true)
    expect(e.excess).toBe(e.exposure)
  })
})
