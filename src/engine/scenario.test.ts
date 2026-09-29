import { describe, expect, it } from 'vitest'
import { blendedEA, computeRung, computeScenario } from './scenario'
import type { DayCountBase, FiscalParams, RungInput, ScenarioInput } from './types'

const FISCAL: FiscalParams = { retencionRate: 0.04, insuranceCeiling: 50_000_000 }

function rung(over: Partial<RungInput>): RungInput {
  return { id: 'r1', principal: 10_000_000, days: 90, ea: 0.1, entityId: 'e1', ...over }
}

// Historical measured values in this file were pinned on base 365; the
// helpers keep that base explicit while base-360 cases set their own.
function scenario(
  rungs: RungInput[],
  fiscal: FiscalParams = FISCAL,
  dayCountBase: DayCountBase = 365,
): ScenarioInput {
  return {
    startDate: '2026-07-26',
    rungs,
    entities: [{ id: 'e1', name: 'Entidad A' }],
    fiscal,
    dayCountBase,
  }
}

// Deterministic PRNG for property-style tests (no Math.random in tests).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('computeRung', () => {
  it('measured base case: 850M at 13,5 % E.A., 90 days', () => {
    const r = computeRung(rung({ principal: 850_000_000, ea: 0.135 }), '2026-07-26', FISCAL, 365)
    // Measured raw gross: 26_959_524.2123186
    expect(r.grossInterest).toBe(26_959_524)
    expect(r.retencion).toBe(1_078_381) // roundCOP(26_959_524 * 0.04) = roundCOP(1_078_380.96)
    expect(r.netInterest).toBe(25_881_143)
    expect(r.maturityDate).toBe('2026-10-24')
  })

  it('retención 0 % → net equals gross bit-for-bit', () => {
    const r = computeRung(
      rung({ principal: 850_000_000, ea: 0.135 }),
      '2026-07-26',
      { ...FISCAL, retencionRate: 0 },
      365,
    )
    expect(r.retencion).toBe(0)
    expect(r.netInterest).toBe(r.grossInterest)
  })

  it('E.A. 0 % → all-zero interest, every field finite', () => {
    const r = computeRung(rung({ ea: 0 }), '2026-07-26', FISCAL, 365)
    expect(r.grossInterest).toBe(0)
    expect(r.retencion).toBe(0)
    expect(r.netInterest).toBe(0)
    for (const v of [r.periodRate, r.grossInterest, r.retencion, r.netInterest]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('retención rounding policy — per rung, on the rounded gross', () => {
  it('discriminates rounded-gross vs raw-gross basis (impossible at 4 %, so 7 %)', () => {
    // principal 100 at EA 7,4 % over 365 days → raw gross 7.400000000000007.
    // On the rounded gross: roundCOP(7 × 0.07) = roundCOP(0.49) = 0.
    // On the raw gross: roundCOP(7.4 × 0.07) = roundCOP(0.518) = 1.
    // At 4 % the two bases are provably indistinguishable for every input.
    const r = computeRung(
      rung({ principal: 100, days: 365, ea: 0.074 }),
      '2026-07-26',
      { ...FISCAL, retencionRate: 0.07 },
      365,
    )
    expect(r.grossInterest).toBe(7)
    expect(r.retencion).toBe(0)
    expect(r.netInterest).toBe(7)
  })

  it('gross totals are the sum of rounded rows, not the rounded raw sum', () => {
    // Each rung's raw gross ≈ 260.4 → rounded 260; three rungs total 780,
    // while rounding the raw sum would give roundCOP(781.2) = 781.
    const rungs = [1, 2, 3].map((i) =>
      rung({ id: `r${i}`, principal: 10_000, days: 365, ea: 0.02604 }),
    )
    const result = computeScenario(scenario(rungs))
    for (const r of result.rungs) expect(r.grossInterest).toBe(260)
    expect(result.totals.grossInterest).toBe(780)
    expect(result.totals.grossInterest).not.toBe(781)
  })

  it('discriminating case: 3 rungs of gross 260 at 4 % total 30, not 31', () => {
    // principal 26_000 at EA 1 % over 365 days → gross ≈ 260.0000000000002 → 260
    const rungs = [1, 2, 3].map((i) =>
      rung({ id: `r${i}`, principal: 26_000, days: 365, ea: 0.01 }),
    )
    const result = computeScenario(scenario(rungs))
    for (const r of result.rungs) {
      expect(r.grossInterest).toBe(260)
      expect(r.retencion).toBe(10) // roundCOP(10.4)
    }
    expect(result.totals.retencion).toBe(30)
    // Rounding on the portfolio total would give roundCOP(780 * 0.04) = 31.
    expect(result.totals.retencion).not.toBe(31)
  })

  it('totals always equal the sum of the displayed per-rung values', () => {
    const rand = mulberry32(20260726)
    const rungs = Array.from({ length: 8 }, (_, i) =>
      rung({
        id: `r${i}`,
        principal: 1_000_000 + Math.floor(rand() * 899_000_000),
        days: 30 + Math.floor(rand() * 700),
        ea: rand() * 0.2,
      }),
    )
    const result = computeScenario(scenario(rungs))
    const sum = (k: 'principal' | 'grossInterest' | 'retencion' | 'netInterest') =>
      result.rungs.reduce((a, r) => a + r[k], 0)
    expect(result.totals.principal).toBe(sum('principal'))
    expect(result.totals.grossInterest).toBe(sum('grossInterest'))
    expect(result.totals.retencion).toBe(sum('retencion'))
    expect(result.totals.netInterest).toBe(sum('netInterest'))
    expect(Number.isSafeInteger(result.totals.netInterest)).toBe(true)
  })
})

describe('safe-integer output guard', () => {
  it('the worst input the UI permits stays peso-exact (12 digits × 100 % × 3650 d)', () => {
    const r = computeRung(
      rung({ principal: 999_999_999_999, days: 3650, ea: 1 }),
      '2026-07-26',
      FISCAL,
      365,
    )
    expect(Number.isSafeInteger(r.grossInterest)).toBe(true)
    expect(Number.isSafeInteger(r.netInterest)).toBe(true)
  })

  it('throws instead of silently losing pesos beyond safe-integer range', () => {
    expect(() =>
      computeRung(rung({ principal: 999_999_999_999_999, days: 3650, ea: 1 }), '2026-07-26', FISCAL, 365),
    ).toThrow(RangeError)
  })
})

describe('base 360 comercial — reproduction fixtures', () => {
  // Anonymized figures-only fixtures for the comercial liquidation base that
  // Colombian CDT certificates state as "Base liquidación: 360".

  it('fixture A: 50M, 390 días, 13,50 % E.A. — engine path and statement path', () => {
    // Engine (unrounded period rate): 50M × ((1.135)^(390/360) − 1)
    // = 7_352_037.89… → 7_352_038.
    const r = computeRung(
      rung({ principal: 50_000_000, days: 390, ea: 0.135 }),
      '2026-07-26',
      FISCAL,
      360,
    )
    expect(r.grossInterest).toBe(7_352_038)

    // Documented statement reproduction: banks round the period rate to four
    // decimals AS A PERCENT (14.7041 %) before applying it, which yields
    // bruto 7_352_050 / retención 294_082 / neto 7_057_968 to the peso.
    const statementRate = Math.round((Math.pow(1.135, 390 / 360) - 1) * 1e6) / 1e6
    expect(statementRate).toBe(0.147041)
    const statementGross = Math.round(50_000_000 * statementRate)
    expect(statementGross).toBe(7_352_050)
    expect(Math.round(statementGross * 0.04)).toBe(294_082)
    expect(statementGross - 294_082).toBe(7_057_968)

    // The engine's unrounded path must stay within half a rate-rounding step
    // of the statement figure: 0.5e-6 × principal = 25 pesos here.
    expect(Math.abs(r.grossInterest - statementGross)).toBeLessThanOrEqual(
      50_000_000 * 0.5e-6,
    )
  })

  it('fixture B: 44M, 360 días, 13,60 % E.A. — 360/360 collapses to the E.A. exactly', () => {
    // Raw gross is 5_983_999.999999995 — also a roundCOP float-noise case.
    const r = computeRung(
      rung({ principal: 44_000_000, days: 360, ea: 0.136 }),
      '2026-07-26',
      FISCAL,
      360,
    )
    expect(r.grossInterest).toBe(5_984_000)
    expect(r.retencion).toBe(239_360)
    expect(r.netInterest).toBe(5_744_640)
  })
})

describe('blendedEA — principal × days weighting (pinned)', () => {
  it('discriminating asymmetric pair: 13,2 %, and NOT the principal-only 12,0 %', () => {
    const rungs = [
      { principal: 100_000_000, days: 90, ea: 0.1 },
      { principal: 100_000_000, days: 360, ea: 0.14 },
    ]
    const b = blendedEA(rungs)
    expect(b).toBeCloseTo(0.132, 12)
    expect(Math.abs(b - 0.12)).toBeGreaterThan(0.005)
  })

  it('same-EA invariance across random amounts and terms', () => {
    const rand = mulberry32(42)
    for (let i = 0; i < 50; i++) {
      const rungs = Array.from({ length: 2 + Math.floor(rand() * 6) }, () => ({
        principal: 1_000_000 + Math.floor(rand() * 899_000_000),
        days: 30 + Math.floor(rand() * 700),
        ea: 0.135,
      }))
      expect(blendedEA(rungs)).toBeCloseTo(0.135, 12)
    }
  })

  it('all-zero-EA ladder blends to exactly 0, never NaN', () => {
    const b = blendedEA([
      { principal: 10_000_000, days: 90, ea: 0 },
      { principal: 20_000_000, days: 180, ea: 0 },
    ])
    expect(b).toBe(0)
  })

  it('empty or zero-weight ladders throw a typed error instead of returning NaN', () => {
    expect(() => blendedEA([])).toThrow(RangeError)
    expect(() => blendedEA([{ principal: 0, days: 90, ea: 0.1 }])).toThrow(RangeError)
  })
})

describe('computeScenario', () => {
  it('sorts rungs by maturity and reports the first as nextMaturity', () => {
    const rungs = [
      rung({ id: 'long', days: 360 }),
      rung({ id: 'short', days: 90 }),
      rung({ id: 'mid', days: 180 }),
    ]
    const result = computeScenario(scenario(rungs))
    expect(result.rungs.map((r) => r.id)).toEqual(['short', 'mid', 'long'])
    expect(result.nextMaturity).toBe('2026-10-24')
  })

  it('E.A. 0 % full pipeline: zero interest, blended 0, everything finite', () => {
    const rungs = [1, 2, 3].map((i) => rung({ id: `r${i}`, ea: 0, days: 90 * i }))
    const result = computeScenario(scenario(rungs))
    expect(result.totals.grossInterest).toBe(0)
    expect(result.totals.retencion).toBe(0)
    expect(result.totals.netInterest).toBe(0)
    expect(result.blendedEA).toBe(0)
    for (const r of result.rungs) {
      for (const v of [r.periodRate, r.grossInterest, r.retencion, r.netInterest]) {
        expect(Number.isFinite(v)).toBe(true)
      }
    }
  })
})
