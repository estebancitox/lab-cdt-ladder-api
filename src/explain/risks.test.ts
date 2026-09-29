import { describe, expect, it } from 'vitest'
import { acceptedRequest, inputOf, type RawRequest } from '../test-support/contract'
import {
  MAX_SELECTED,
  PRIORITY,
  RATE_GAP_BP,
  basisPoints,
  ceilingRisk,
  clusteredRisk,
  exceedsConcentration,
  rateGapRisk,
  selectRisks,
} from './risks'
import type { RiskKey } from './types'
import { buildFigures } from './view'

const figuresOf = (body: RawRequest) => buildFigures(acceptedRequest(body))

/** One entity at a zero rate, so exposure equals the principal exactly (as exposure.test.ts does). */
function zeroRateLadder(principal: number, ceiling: number): RawRequest {
  const body = inputOf('healthy-3-rung')
  body.ladder.fiscal.insuranceCeiling = ceiling
  body.ladder.entities = [{ id: 'e1', name: 'Entidad A' }]
  body.ladder.rungs = [{ id: 'r1', principal, days: 90, ea: 0, entityId: 'e1' }]
  return body
}

function twoRungs(days: [number, number], ea: [number, number] = [0.135, 0.135]): RawRequest {
  const body = inputOf('healthy-3-rung')
  body.ladder.rungs = [
    {
      id: 'r1',
      principal: 10_000_000,
      days: days[0],
      ea: ea[0],
      entityId: 'e1',
    },
    {
      id: 'r2',
      principal: 10_000_000,
      days: days[1],
      ea: ea[1],
      entityId: 'e2',
    },
  ]
  return body
}

describe('ceiling trigger: exposure > ceiling, strict (SPEC §5.4)', () => {
  it('exactly at the ceiling is not triggered', () => {
    const f = figuresOf(zeroRateLadder(50_000_000, 50_000_000))
    expect(f.perEntity[0].exposure).toBe(50_000_000)
    expect(ceilingRisk(f)).toEqual({ triggered: false, entityIds: [] })
  })

  it('one peso over is triggered and names the entity', () => {
    const f = figuresOf(zeroRateLadder(50_000_001, 50_000_000))
    expect(f.perEntity[0].exposure).toBe(50_000_001)
    expect(ceilingRisk(f)).toEqual({ triggered: true, entityIds: ['e1'] })
  })
})

describe('clustered trigger: two rungs within 30 days of the anchor, inclusive (SPEC §5.4)', () => {
  it('30 days apart is triggered', () => {
    const f = figuresOf(twoRungs([100, 130]))
    expect(f.perRung.map((r) => r.maturityDate)).toEqual(['2027-04-14', '2027-05-14'])
    expect(clusteredRisk(f)).toEqual({ triggered: true, clusterIndexes: [1] })
  })

  it('31 days apart is not', () => {
    const f = figuresOf(twoRungs([100, 131]))
    expect(clusteredRisk(f)).toEqual({ triggered: false, clusterIndexes: [] })
  })
})

describe('rate gap trigger: maxBp − bp >= 200 in integer basis points (SPEC §5.4)', () => {
  it('basisPoints rounds to the nearest integer bp', () => {
    expect([0.135, 0.11, 0.116, 0.022, 0.002, 0.0219].map(basisPoints)).toEqual([
      1350, 1100, 1160, 220, 20, 219,
    ])
  })

  it('exactly 200 bp is triggered, even where the float difference falls short of 0.02', () => {
    expect(0.022 - 0.002 >= 0.02).toBe(false) // the float trap SPEC §5.4 documents
    expect(rateGapRisk(figuresOf(twoRungs([90, 180], [0.022, 0.002])))).toEqual({
      triggered: true,
      maxBp: 220,
      rungIndexes: [2],
    })
  })

  it('199 bp is not triggered', () => {
    expect(rateGapRisk(figuresOf(twoRungs([90, 180], [0.0219, 0.002])))).toEqual({
      triggered: false,
      maxBp: 219,
      rungIndexes: [],
    })
  })

  it('requires two rungs', () => {
    expect(rateGapRisk(figuresOf(inputOf('single-rung-injected-name')))).toEqual({
      triggered: false,
      maxBp: 1350,
      rungIndexes: [],
    })
  })

  it('names every rung at or beyond the gap by its perRung index', () => {
    // low-rate-rung: 13,5 / 13,5 / 11,0 / 13,5 at 90/180/270/360 days; the low rung sorts third.
    expect(rateGapRisk(figuresOf(inputOf('low-rate-rung')))).toEqual({
      triggered: true,
      maxBp: 1350,
      rungIndexes: [3],
    })
  })
})

describe('selectRisks: the SPEC §5.3 priority', () => {
  const KEYS: RiskKey[] = ['ceiling', 'concentration', 'clustered', 'rateGap']

  it('is ceiling > concentration > clustered > rateGap, at most three survive, gap threshold 200', () => {
    expect(PRIORITY).toEqual(KEYS)
    expect(MAX_SELECTED).toBe(3)
    expect(RATE_GAP_BP).toBe(200)
  })

  it('all four triggered drops the rate gap', () => {
    expect(
      selectRisks({
        ceiling: true,
        concentration: true,
        clustered: true,
        rateGap: true,
      }),
    ).toEqual(['ceiling', 'concentration', 'clustered'])
  })

  it('three triggered keeps all three, in priority order', () => {
    expect(
      selectRisks({
        ceiling: false,
        concentration: true,
        clustered: true,
        rateGap: true,
      }),
    ).toEqual(['concentration', 'clustered', 'rateGap'])
  })

  it('nothing triggered selects nothing, one triggered selects that one', () => {
    expect(
      selectRisks({
        ceiling: false,
        concentration: false,
        clustered: false,
        rateGap: false,
      }),
    ).toEqual([])
    expect(
      selectRisks({
        ceiling: false,
        concentration: false,
        clustered: false,
        rateGap: true,
      }),
    ).toEqual(['rateGap'])
  })

  it('every one of the 16 combinations is the triggered keys in priority order, cut at three', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const triggered = Object.fromEntries(
        KEYS.map((k, i) => [k, Boolean(mask & (1 << i))]),
      ) as Record<RiskKey, boolean>
      expect(selectRisks(triggered), `mask ${mask}`).toEqual(
        KEYS.filter((k) => triggered[k]).slice(0, 3),
      )
    }
  })

  it('does not depend on the key order of its input', () => {
    expect(
      selectRisks({
        rateGap: true,
        clustered: true,
        concentration: false,
        ceiling: true,
      }),
    ).toEqual(['ceiling', 'clustered', 'rateGap'])
  })

  it('exceedsConcentration: 60 % of the capital is the threshold, strict (SPEC §5.4)', () => {
    expect(exceedsConcentration(60, 100)).toBe(false)
    expect(exceedsConcentration(61, 100)).toBe(true)
    expect(exceedsConcentration(60_000_000, 100_000_000)).toBe(false)
    expect(exceedsConcentration(60_000_001, 100_000_000)).toBe(true)
  })
})
