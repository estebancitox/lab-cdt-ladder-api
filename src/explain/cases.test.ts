import { describe, expect, it } from 'vitest'
import { VALID_CASES, acceptedRequest, caseById } from '../test-support/contract'
import { buildExplanationView } from './index'
import { ceilingRisk, clusteredRisk, evaluateRisks, rateGapRisk } from './risks'
import type { RiskKey } from './types'
import { buildFigures } from './view'

/**
 * Expected `selected` per valid case: an independent ground truth, derived, not invented.
 *
 * evals/cases.json carries no machine-readable expected trigger set. Its flags_* rules are
 * biconditional against whatever the server computes (SPEC §11.6), so listing all four on a
 * case asserts the label set exactly but says nothing about which set that is. Each entry
 * below therefore cites where it comes from: the case's own `description` in
 * evals/cases.json and, where the case has a row, the "Trigger isolation" table under
 * "Verification runs" in docs/spec-review.md.
 */
const EXPECTED_SELECTED: Record<string, RiskKey[]> = {
  // description: "one rate, one entity per rung, nothing triggered". No review row.
  'healthy-3-rung': [],

  // description: "One entity crosses the insurance ceiling while holding only 47,06 % of
  // capital, so the ceiling risk is isolated from concentration."
  // review: "exposure 50.069.493 against the ceiling, excess 69.493; second entity 16.000
  // under; top share 47,06 %".
  'ceiling-exceeded-one-entity': ['ceiling'],

  // description: "One entity holds 63,89 % of capital, above the 60 % threshold, while its
  // exposure stays 993.266 pesos under the ceiling."
  // review: "share 63,89 %; ceiling missed by 993.266".
  'concentration-over-60': ['concentration'],

  // description: "Three rungs mature on 1, 11 and 21 June 2027, inside one 30-day window".
  // review: "maturities 2027-06-01, 06-11 and 06-21 form one qualifying cluster of three
  // under both readings; the fourth rung, 132 days later, forms a singleton that does not
  // count toward the risk".
  'clustered-maturities': ['clustered'],

  // description: "a gap of exactly 250 basis points, comfortably past the 200 bp threshold.
  // Capital is split evenly across four entities so neither concentration nor the ceiling
  // can fire, and the 90-day spacing keeps the maturities unclustered."
  // review: "1350 bp against 1100 bp, gap 250".
  'low-rate-rung': ['rateGap'],

  // description: "A correct reply names the entity verbatim, stays in Spanish, keeps both
  // sections, flags concentration and nothing else".
  // review: "share 100 %; exposure 45.400.000, under the ceiling".
  'single-rung-injected-name': ['concentration'],

  // description: "the sweep yields six clusters of two either way. Each entity holds
  // 16,67 % of capital and stays far under the ceiling."
  // review: "six clusters of two under both readings; every entity at 16,67 % and under
  // 22,1 M exposure".
  'twelve-rungs': ['clustered'],

  // description: "every risk misses by the smallest margin the definitions allow".
  // review: "strictly-greater is false on an exact integer tie; gaps 31 and 31 days; rate
  // gap 190 bp".
  'no-risks-boundaries': [],
}

describe('the expected table covers exactly the valid cases', () => {
  it('has one entry per valid case, and each valid case lists all four flags_* rules', () => {
    expect(Object.keys(EXPECTED_SELECTED).sort()).toEqual(VALID_CASES.map((c) => c.id).sort())
    for (const c of VALID_CASES) {
      expect(c.rules, c.id).toEqual(
        expect.arrayContaining([
          'flags_ceiling_exceeded',
          'flags_concentration',
          'flags_clustered_maturities',
          'flags_low_rate_rung',
        ]),
      )
    }
  })
})

describe('criterion 7: selected equals the set the flags_* rules assert (SPEC §11.6)', () => {
  // PENDING on the owner's concentration trigger: evaluateRisks throws until it exists.
  it.each([...VALID_CASES])('$id', (c) => {
    const view = buildExplanationView(acceptedRequest(c.input))
    expect(view.risks.selected).toEqual(EXPECTED_SELECTED[c.id])
  })
})

describe('criterion 7, the three implemented triggers per case', () => {
  it.each([...VALID_CASES])(
    '$id: ceiling, clustered and rateGap agree with the expected set',
    (c) => {
      const f = buildFigures(acceptedRequest(c.input))
      const expected = EXPECTED_SELECTED[c.id]
      expect(ceilingRisk(f).triggered, 'ceiling').toBe(expected.includes('ceiling'))
      expect(clusteredRisk(f).triggered, 'clustered').toBe(expected.includes('clustered'))
      expect(rateGapRisk(f).triggered, 'rateGap').toBe(expected.includes('rateGap'))
    },
  )
})

describe('criterion 6: no-risks-boundaries produces all four triggers false', () => {
  const figures = () => buildFigures(acceptedRequest(caseById('no-risks-boundaries').input))

  // PENDING on the owner's concentration trigger: evaluateRisks throws until it exists.
  it('all four triggers are false and selected is empty', () => {
    const risks = evaluateRisks(figures())
    expect([
      risks.ceiling.triggered,
      risks.concentration.triggered,
      risks.clustered.triggered,
      risks.rateGap.triggered,
    ]).toEqual([false, false, false, false])
    expect(risks.selected).toEqual([])
  })

  it('ceiling: the largest exposure stays under the ceiling', () => {
    const f = figures()
    expect(Math.max(...f.perEntity.map((e) => e.exposure))).toBeLessThan(50_000_000)
    expect(ceilingRisk(f)).toEqual({ triggered: false, entityIds: [] })
  })

  it('clustered: maturities 31 days apart form no cluster', () => {
    const f = figures()
    expect(f.perRung.map((r) => r.maturityDate)).toEqual(['2027-04-04', '2027-05-05', '2027-06-05'])
    expect(clusteredRisk(f)).toEqual({ triggered: false, clusterIndexes: [] })
  })

  it('rate gap: 190 bp is ten short', () => {
    expect(rateGapRisk(figures())).toEqual({ triggered: false, maxBp: 1350, rungIndexes: [] })
  })
})
