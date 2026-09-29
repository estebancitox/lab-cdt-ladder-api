import { describe, expect, it } from 'vitest'
import { addDays, computeScenario, formatCOP, formatDateShort, formatPercent } from '../engine'
import { VALID_CASES, acceptedRequest, caseById, inputOf } from '../test-support/contract'
import { buildFigures } from './view'

const figuresOf = (id: string) => buildFigures(acceptedRequest(caseById(id).input))
const noSpace = (s: string) => s.replace(/\s/g, '')

describe('perRung order (SPEC §3.3)', () => {
  it('is sorted by maturityDate, ties broken by rungId, index 1-based after the sort', () => {
    const body = inputOf('healthy-3-rung')
    body.ladder.rungs = [
      { id: 'b', principal: 10_000_000, days: 90, ea: 0.135, entityId: 'e1' },
      { id: 'a', principal: 10_000_000, days: 90, ea: 0.135, entityId: 'e2' },
      { id: 'c', principal: 10_000_000, days: 30, ea: 0.135, entityId: 'e3' },
    ]
    const { perRung } = buildFigures(acceptedRequest(body))
    expect(perRung.map((r) => r.rungId)).toEqual(['c', 'a', 'b'])
    expect(perRung.map((r) => r.index)).toEqual([1, 2, 3])
    expect(perRung.map((r) => r.maturityDate)).toEqual(['2027-02-03', '2027-04-04', '2027-04-04'])
  })

  it('carries the entity name verbatim from the request', () => {
    expect(figuresOf('healthy-3-rung').perRung[1].entityName).toBe('Cooperativa Ñame & Café')
  })
})

describe('perEntity (SPEC §3.3)', () => {
  it('exposure is principal + gross interest, never net', () => {
    const { perRung, perEntity } = figuresOf('ceiling-exceeded-one-entity')
    for (const e of perEntity) {
      const rungs = perRung.filter((r) => r.entityId === e.entityId)
      const gross = rungs.reduce((a, r) => a + r.grossInterest, 0)
      const net = rungs.reduce((a, r) => a + r.netInterest, 0)
      expect(e.interest).toBe(gross)
      expect(e.exposure).toBe(e.principal + gross)
      expect(e.exposure).not.toBe(e.principal + net)
    }
  })

  it('excess and headroom are non-negative, one of them is zero, and both follow their formula', () => {
    for (const c of VALID_CASES) {
      for (const e of buildFigures(acceptedRequest(c.input)).perEntity) {
        const where = `${c.id} ${e.entityId}`
        expect(e.excess, where).toBeGreaterThanOrEqual(0)
        expect(e.headroom, where).toBeGreaterThanOrEqual(0)
        expect(e.excess === 0 || e.headroom === 0, where).toBe(true)
        expect(e.excess, where).toBe(Math.max(0, e.exposure - e.ceiling))
        expect(e.headroom, where).toBe(Math.max(0, e.ceiling - e.exposure))
        expect(e.exceeded, where).toBe(e.exposure > e.ceiling)
      }
    }
  })

  it('ceiling-exceeded-one-entity: one entity 69.493 over, another 16.000 under (docs/spec-review.md)', () => {
    const byId = Object.fromEntries(
      figuresOf('ceiling-exceeded-one-entity').perEntity.map((e) => [e.entityId, e]),
    )
    expect(byId.e1).toMatchObject({
      exposure: 50_069_493,
      exceeded: true,
      excess: 69_493,
      headroom: 0,
    })
    expect(byId.e2).toMatchObject({
      exposure: 49_984_000,
      exceeded: false,
      excess: 0,
      headroom: 16_000,
    })
    expect(noSpace(byId.e1.shareOfCapitalDisplay)).toBe('47,06%')
  })

  it('concentration-over-60: share 63,89 %, ceiling missed by 993.266 (docs/spec-review.md)', () => {
    const e1 = figuresOf('concentration-over-60').perEntity.find((e) => e.entityId === 'e1')
    expect(e1).toMatchObject({ exceeded: false, excess: 0, headroom: 993_266 })
    expect(noSpace(e1!.shareOfCapitalDisplay)).toBe('63,89%')
  })

  it('shareOfCapital is principal over total principal, and the shares sum to one', () => {
    const { perEntity, totals } = figuresOf('twelve-rungs')
    for (const e of perEntity) expect(e.shareOfCapital).toBe(e.principal / totals.principal)
    expect(perEntity.reduce((a, e) => a + e.shareOfCapital, 0)).toBeCloseTo(1, 12)
    expect(perEntity.map((e) => noSpace(e.shareOfCapitalDisplay))).toEqual(Array(6).fill('16,67%'))
  })

  it('follows the entities-list order and counts only entities holding a rung', () => {
    const body = inputOf('healthy-3-rung')
    body.ladder.entities.push({ id: 'e9', name: 'Sin peldaños' })
    const f = buildFigures(acceptedRequest(body))
    expect(f.perEntity.map((e) => e.entityId)).toEqual(['e1', 'e2', 'e3'])
    expect(f.entityCount).toBe(3)
  })
})

describe('clusters (SPEC §3.3, §5.4)', () => {
  it('clustered-maturities: one cluster of three ending 2027-06-21, and the far rung is no cluster', () => {
    const f = figuresOf('clustered-maturities')
    expect(f.clusterCount).toBe(1)
    expect(f.clusters).toMatchObject([
      {
        index: 1,
        startDate: '2027-06-01',
        endDate: '2027-06-21',
        count: 3,
        rungIndexes: [1, 2, 3],
        principal: 60_000_000,
      },
    ])
    expect(f.perRung[3].maturityDate).toBe('2027-10-31')
  })

  it('twelve-rungs: six clusters of two; healthy-3-rung and no-risks-boundaries: none', () => {
    expect(figuresOf('twelve-rungs').clusters.map((c) => c.count)).toEqual([2, 2, 2, 2, 2, 2])
    expect(figuresOf('healthy-3-rung').clusterCount).toBe(0)
    expect(figuresOf('no-risks-boundaries').clusterCount).toBe(0)
  })
})

describe('nextMaturity, daysToNextMaturity, lastMaturity and the counts (SPEC §3.3)', () => {
  it('nextMaturity is the earliest maturity on or after asOfDate', () => {
    const body = inputOf('healthy-3-rung')
    let f = buildFigures(acceptedRequest(body))
    expect([f.nextMaturity, f.daysToNextMaturity]).toEqual(['2027-04-04', 90])

    body.asOfDate = '2027-04-05' // the day after the first maturity
    f = buildFigures(acceptedRequest(body))
    expect([f.nextMaturity, f.daysToNextMaturity]).toEqual(['2027-07-03', 89])

    body.asOfDate = '2027-07-03' // exactly on a maturity: on or after
    f = buildFigures(acceptedRequest(body))
    expect([f.nextMaturity, f.daysToNextMaturity]).toEqual(['2027-07-03', 0])

    body.asOfDate = '2027-10-01' // the last maturity itself
    f = buildFigures(acceptedRequest(body))
    expect([f.nextMaturity, f.lastMaturity, f.daysToNextMaturity]).toEqual([
      '2027-10-01',
      '2027-10-01',
      0,
    ])
  })

  it('lastMaturity and the counts', () => {
    expect(figuresOf('healthy-3-rung')).toMatchObject({
      rungCount: 3,
      entityCount: 3,
      clusterCount: 0,
      lastMaturity: addDays('2027-01-04', 270),
    })
    expect(figuresOf('twelve-rungs')).toMatchObject({
      rungCount: 12,
      entityCount: 6,
      clusterCount: 6,
      lastMaturity: addDays('2027-01-04', 300),
    })
  })
})

describe('totals and blendedEA come from the engine', () => {
  it("equal computeScenario's totals and blendedEA for every valid case", () => {
    for (const c of VALID_CASES) {
      const request = acceptedRequest(c.input)
      const engine = computeScenario(request.ladder)
      const f = buildFigures(request)
      expect(f.totals, c.id).toMatchObject(engine.totals)
      expect(f.blendedEA, c.id).toBe(engine.blendedEA)
      expect(f.totals.netInterest, c.id).toBe(f.perRung.reduce((a, r) => a + r.netInterest, 0))
    }
  })
})

describe("every money, rate and date figure carries a Display string built by the engine's formatters (SPEC §3.3)", () => {
  const MONEY = [
    'principal',
    'grossInterest',
    'retencion',
    'netInterest',
    'interest',
    'exposure',
    'ceiling',
    'excess',
    'headroom',
  ]
  const RATE = ['ea', 'blendedEA', 'shareOfCapital']
  const DATE = ['maturityDate', 'startDate', 'endDate', 'nextMaturity', 'lastMaturity']

  function checkDisplays(obj: Record<string, unknown>, where: string): number {
    let checked = 0
    for (const key of MONEY) {
      if (key in obj) {
        expect(obj[`${key}Display`], `${where}.${key}`).toBe(formatCOP(obj[key] as number))
        checked += 1
      }
    }
    for (const key of RATE) {
      if (key in obj) {
        expect(obj[`${key}Display`], `${where}.${key}`).toBe(formatPercent(obj[key] as number))
        checked += 1
      }
    }
    for (const key of DATE) {
      if (key in obj) {
        expect(obj[`${key}Display`], `${where}.${key}`).toBe(formatDateShort(obj[key] as string))
        checked += 1
      }
    }
    // And no Display string exists without a money, rate or date figure behind it.
    for (const key of Object.keys(obj)) {
      if (key.endsWith('Display')) {
        expect([...MONEY, ...RATE, ...DATE], `${where}.${key}`).toContain(
          key.slice(0, -'Display'.length),
        )
      }
    }
    return checked
  }

  it.each([...VALID_CASES])('$id', (c) => {
    const f = buildFigures(acceptedRequest(c.input)) as unknown as Record<string, unknown>
    let n = checkDisplays(f, 'view')
    n += checkDisplays(f.totals as Record<string, unknown>, 'totals')
    for (const [i, r] of (f.perRung as Record<string, unknown>[]).entries())
      n += checkDisplays(r, `perRung[${i}]`)
    for (const [i, e] of (f.perEntity as Record<string, unknown>[]).entries())
      n += checkDisplays(e, `perEntity[${i}]`)
    for (const [i, k] of (f.clusters as Record<string, unknown>[]).entries())
      n += checkDisplays(k, `clusters[${i}]`)
    expect(n).toBeGreaterThan(0)
  })

  it('exposes every path the SPEC §11.3 allowed-number set reads', () => {
    const f = figuresOf('clustered-maturities')
    for (const k of ['principal', 'grossInterest', 'retencion', 'netInterest'] as const) {
      expect(f.totals[`${k}Display`]).toBeTypeOf('string')
    }
    expect(f.blendedEADisplay).toBeTypeOf('string')
    for (const r of f.perRung) {
      for (const k of ['principal', 'ea', 'grossInterest', 'retencion', 'netInterest'] as const) {
        expect(r[`${k}Display`]).toBeTypeOf('string')
      }
      expect(Number.isInteger(r.index) && Number.isInteger(r.days)).toBe(true)
    }
    for (const e of f.perEntity) {
      for (const k of [
        'principal',
        'interest',
        'exposure',
        'ceiling',
        'shareOfCapital',
        'excess',
        'headroom',
      ] as const) {
        expect(e[`${k}Display`]).toBeTypeOf('string')
      }
    }
    for (const k of f.clusters) {
      expect(k.principalDisplay).toBeTypeOf('string')
      expect(Number.isInteger(k.count)).toBe(true)
    }
    for (const n of [f.rungCount, f.entityCount, f.clusterCount, f.daysToNextMaturity]) {
      expect(Number.isInteger(n)).toBe(true)
    }
  })
})
