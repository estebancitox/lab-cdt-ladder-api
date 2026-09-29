import { describe, expect, it } from 'vitest'
import { addDays } from './dates'
import { projectRung } from './rollover'
import { computeRung, computeScenario } from './scenario'
import { validateScenario } from './validate'
import type { FiscalParams, RolloverConfig, RungInput, ScenarioInput } from './types'

const FISCAL: FiscalParams = { retencionRate: 0.04, insuranceCeiling: 50_000_000 }
const START = '2026-07-26'

function rung(over: Partial<RungInput> = {}): RungInput {
  return { id: 'r1', principal: 10_000_000, days: 90, ea: 0.13, entityId: 'e1', ...over }
}

function computed(over: Partial<RungInput> = {}, fiscal = FISCAL) {
  return computeRung(rung(over), START, fiscal, 360)
}

function scenario(
  rungs: RungInput[],
  rollover: RolloverConfig | undefined,
  fiscal: FiscalParams = FISCAL,
): ScenarioInput {
  return {
    startDate: START,
    rungs,
    entities: [{ id: 'e1', name: 'Entidad A' }],
    fiscal,
    dayCountBase: 360,
    rollover,
  }
}

describe('projectRung — horizon mode', () => {
  it('90-day rung to a 200-day horizon: renewals [90, 20] with a priced stub', () => {
    // Initial term covers days 0-90; renewal 1 covers 90-180; the next full
    // cycle would end at 270 > 200, so a 20-day stub covers 180-200.
    const p = projectRung(computed(), { mode: 'horizon', horizonDate: addDays(START, 200) }, FISCAL, 360)
    expect(p.cycles.map((c) => c.days)).toEqual([90, 20])
    expect(p.cycles.map((c) => c.isStub)).toEqual([false, true])
    expect(p.hasStub).toBe(true)
    expect(p.cycles[1].periodRate).toBeCloseTo(Math.pow(1.13, 20 / 360) - 1, 15)
    expect(p.finalMaturity).toBe(addDays(START, 200))
  })

  it('horizon exactly on a cycle boundary: full cycles, no zero-day stub', () => {
    const p = projectRung(computed(), { mode: 'horizon', horizonDate: addDays(START, 270) }, FISCAL, 360)
    expect(p.cycles.map((c) => c.days)).toEqual([90, 90])
    expect(p.hasStub).toBe(false)
    expect(p.finalMaturity).toBe(addDays(START, 270))
  })

  it('horizon at or before the initial maturity: no renewals', () => {
    for (const days of [90, 50]) {
      const p = projectRung(computed(), { mode: 'horizon', horizonDate: addDays(START, days) }, FISCAL, 360)
      expect(p.cycles).toEqual([])
      expect(p.hasStub).toBe(false)
      const r = computed()
      expect(p.finalValue).toBe(r.principal + r.netInterest)
      expect(p.finalMaturity).toBe(r.maturityDate)
    }
  })

  it('stub pricing follows the scenario base: 360 vs 365 differ', () => {
    const config: RolloverConfig = { mode: 'horizon', horizonDate: addDays(START, 200) }
    const p360 = projectRung(computed(), config, FISCAL, 360)
    const r365 = computeRung(rung(), START, FISCAL, 365)
    const p365 = projectRung(r365, config, FISCAL, 365)
    expect(p360.cycles[1].periodRate).toBeGreaterThan(p365.cycles[1].periodRate)
  })
})

describe('projectRung — cycles mode', () => {
  it('runs exactly N renewals of the full term', () => {
    const p = projectRung(computed(), { mode: 'cycles', cycles: 3 }, FISCAL, 360)
    expect(p.cycles.map((c) => c.days)).toEqual([90, 90, 90])
    expect(p.hasStub).toBe(false)
    expect(p.finalMaturity).toBe(addDays(computed().maturityDate, 270))
  })

  it('every reinvested principal is a whole, safe COP integer', () => {
    const p = projectRung(
      computed({ principal: 850_000_000, ea: 0.135 }),
      { mode: 'cycles', cycles: 12 },
      FISCAL,
      360,
    )
    for (const c of p.cycles) {
      expect(Number.isSafeInteger(c.principal)).toBe(true)
      expect(Number.isSafeInteger(c.endValue)).toBe(true)
      expect(c.endValue).toBe(c.principal + c.netInterest)
    }
  })

  it('E.A. 0 %: value never moves, everything stays finite', () => {
    const p = projectRung(computed({ ea: 0 }), { mode: 'cycles', cycles: 5 }, FISCAL, 360)
    expect(p.finalValue).toBe(10_000_000)
    for (const c of p.cycles) {
      expect(c.grossInterest).toBe(0)
      expect(Number.isFinite(c.periodRate)).toBe(true)
    }
  })
})

describe('rollover policy — retención per cycle before reinvestment', () => {
  it('two renewals match the hand-computed net chain, not end-of-horizon taxation', () => {
    const P = 10_000_000
    const r = Math.pow(1.13, 90 / 360) - 1
    // Hand chain, mirroring the documented per-cycle cash events:
    const g0 = Math.round(P * r)
    const v1 = P + g0 - Math.round(g0 * 0.04)
    const g1 = Math.round(v1 * r)
    const v2 = v1 + g1 - Math.round(g1 * 0.04)
    const g2 = Math.round(v2 * r)
    const v3 = v2 + g2 - Math.round(g2 * 0.04)

    const p = projectRung(computed(), { mode: 'cycles', cycles: 2 }, FISCAL, 360)
    expect(p.cycles[0].principal).toBe(v1)
    expect(p.cycles[1].principal).toBe(v2)
    expect(p.finalValue).toBe(v3)

    // End-of-horizon taxation (compound gross, tax once) must NOT match.
    const compounded = P * Math.pow(1 + r, 3)
    const taxedOnce = Math.round(compounded - 0.04 * (compounded - P))
    expect(p.finalValue).not.toBe(taxedOnce)
  })

  it('cumulativeNet is the initial net plus every renewal net', () => {
    const initial = computed()
    const p = projectRung(initial, { mode: 'cycles', cycles: 2 }, FISCAL, 360)
    expect(p.cumulativeNet).toBe(
      initial.netInterest + p.cycles[0].netInterest + p.cycles[1].netInterest,
    )
  })
})

describe('computeScenario with rollover', () => {
  it('exposure can cross the ceiling only through the projection', () => {
    const r = rung({ principal: 48_000_000, ea: 0.04, days: 360 })
    const without = computeScenario(scenario([r], undefined))
    expect(without.exposures[0].exceeded).toBe(false)

    const withRollover = computeScenario(
      scenario([r], { mode: 'horizon', horizonDate: addDays(START, 720) }),
    )
    const e = withRollover.exposures[0]
    expect(withRollover.projection?.perRung[0].cycles).toHaveLength(1)
    expect(e.exceeded).toBe(true)
    // Peak = renewal principal + renewal gross, integer-exact:
    // gross1 = 1.920.000, net1 = 1.843.200, P2 = 49.843.200,
    // gross2 = round(49.843.200 × 0.04) = 1.993.728 → 51.836.928.
    expect(e.exposure).toBe(51_836_928)
    expect(e.excess).toBe(1_836_928)
  })

  it('exposure follows the chain peak, not the final cycle', () => {
    // Retención is withheld at every maturity, so a short stub after a long
    // cycle ends BELOW the previous peak. On the last-cycle basis this same
    // ladder reports 58.875.169 and calls a 59.000.000 ceiling compliant,
    // while the balance really reached 59.074.400 on 2028-07-16.
    const result = computeScenario(
      scenario([rung({ principal: 49_000_000, days: 360, ea: 0.1 })], {
        mode: 'horizon',
        horizonDate: addDays(START, 721),
      }, { retencionRate: 0.04, insuranceCeiling: 59_000_000 }),
    )
    expect(result.projection!.perRung[0].cycles.map((c) => c.days)).toEqual([360, 1])
    const e = result.exposures[0]
    expect(e.exposure).toBe(59_074_400)
    expect(e.exposure).not.toBe(58_875_169)
    expect(e.exceeded).toBe(true)
  })

  it('projection summary totals reconcile with per-rung values', () => {
    const rungs = [1, 2].map((i) => rung({ id: `r${i}`, days: 90 * i }))
    const result = computeScenario(scenario(rungs, { mode: 'cycles', cycles: 2 }))
    const p = result.projection!
    expect(p.perRung).toHaveLength(2)
    expect(p.totalFinalValue).toBe(p.perRung.reduce((a, x) => a + x.finalValue, 0))
    expect(p.totalCumulativeNet).toBe(p.perRung.reduce((a, x) => a + x.cumulativeNet, 0))
    expect(p.finalMaturity).toBe(
      p.perRung.map((x) => x.finalMaturity).sort()[p.perRung.length - 1],
    )
  })

  it('no rollover config → no projection and the classic gross exposure basis', () => {
    const result = computeScenario(scenario([rung()], undefined))
    expect(result.projection).toBeUndefined()
    expect(result.exposures[0].exposure).toBe(
      result.rungs[0].principal + result.rungs[0].grossInterest,
    )
  })
})

describe('validateScenario — rollover config', () => {
  function codes(rollover: RolloverConfig): string[] {
    return validateScenario(scenario([rung()], rollover)).map((i) => i.code)
  }

  it('accepts sane configs', () => {
    expect(codes({ mode: 'cycles', cycles: 1 })).toEqual([])
    expect(codes({ mode: 'cycles', cycles: 36 })).toEqual([])
    expect(codes({ mode: 'horizon', horizonDate: addDays(START, 720) })).toEqual([])
  })

  it('rejects cycle counts outside 1..36 and non-integers', () => {
    for (const cycles of [0, -1, 1.5, 37, NaN]) {
      expect(codes({ mode: 'cycles', cycles })).toContain('rollover_cycles_invalid')
    }
  })

  it('rejects invalid or non-future horizons', () => {
    expect(codes({ mode: 'horizon', horizonDate: 'mañana' })).toContain('rollover_horizon_invalid')
    expect(codes({ mode: 'horizon', horizonDate: START })).toContain(
      'rollover_horizon_before_start',
    )
    expect(codes({ mode: 'horizon', horizonDate: '2020-01-01' })).toContain(
      'rollover_horizon_before_start',
    )
  })
})
