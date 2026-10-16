import { describe, expect, it } from 'vitest'
import { MONTHS_ES, formatCOP, formatPercent } from '../engine'
import { buildExplanationView } from '../explain'
import { MONTH_NAMES } from '../model/payload'
import { SPEC_MD, VALID_CASES, acceptedRequest, caseById } from '../test-support/contract'
import { FULL_MONTHS, dateRenderings, groundTruthFrom, numberOfDisplay } from './ground-truth'

const truthOf = (id: string) => {
  const request = acceptedRequest(caseById(id).input)
  return groundTruthFrom(request, buildExplanationView(request))
}

describe('SPEC §11.3 step 2: the date vocabulary D', () => {
  it("renders a date in the SPEC's seven forms, lowercased and accent-folded", () => {
    const listed = /renderings — ([^\n]+)\n[^\n]*`junio 2027`/.exec(SPEC_MD)
    expect(listed).not.toBeNull()
    expect(dateRenderings('2027-06-01')).toEqual([
      '2027-06-01',
      '1 jun 2027',
      '1 de junio de 2027',
      '1 de jun de 2027',
      '1 de junio',
      'junio de 2027',
      'junio 2027',
    ])
  })

  it('month names start with the engine abbreviations and match the prompt layer', () => {
    FULL_MONTHS.forEach((name, i) => expect(name.startsWith(MONTHS_ES[i]), name).toBe(true))
    expect([...FULL_MONTHS]).toEqual([...MONTH_NAMES])
  })

  it('is built from asOfDate, startDate, the maturities, the clusters and next/last', () => {
    const d = truthOf('clustered-maturities').dates
    for (const date of ['2027-01-04', '2027-06-01', '2027-06-11', '2027-06-21', '2027-10-31']) {
      for (const r of dateRenderings(date)) expect(d.has(r), r).toBe(true)
    }
    expect(d.has('1 de julio de 2027')).toBe(false)
  })
})

describe('SPEC §11.3 step 1: the allowed set A', () => {
  it('parses display strings as the SPEC says', () => {
    expect(numberOfDisplay(formatCOP(1_234_567))).toBe(1234567)
    expect(numberOfDisplay(formatPercent(0.135))).toBe(13.5)
    expect(numberOfDisplay(formatPercent(0.4706))).toBe(47.06)
    expect(numberOfDisplay(formatCOP(0))).toBe(0)
  })

  it('ceiling-exceeded-one-entity: the review figures 50.069.493, 69.493, 16.000 and 47,06 are in A', () => {
    const a = truthOf('ceiling-exceeded-one-entity').allowed
    for (const n of [50_069_493, 69_493, 16_000, 47.06, 102_000_000, 3, 120, 360]) {
      expect(a.has(n), String(n)).toBe(true)
    }
  })

  it('deliberately excludes thresholds, ids, dayCountBase and raw fractions', () => {
    const a = truthOf('concentration-over-60').allowed
    expect(a.has(63.89)).toBe(true)
    for (const n of [60, 30, 200, 0.135, 0.04]) expect(a.has(n), String(n)).toBe(false)
    expect(a.has(360)).toBe(false) // dayCountBase 360 is not a term in this case
  })

  it('carries the counts and the per-rung days and indexes', () => {
    const a = truthOf('twelve-rungs').allowed
    for (const n of [12, 6, 2, 25, 300]) expect(a.has(n), String(n)).toBe(true)
  })
})

describe('S, the entity names and the rungs', () => {
  it.each([...VALID_CASES])("$id: selected is the view's, names are the request's", (c) => {
    const request = acceptedRequest(c.input)
    const view = buildExplanationView(request)
    const truth = groundTruthFrom(request, view)
    expect(truth.selected).toEqual(view.risks.selected)
    expect(truth.entityNames).toEqual(request.ladder.entities.map((e) => e.name))
    expect(truth.rungs.map((r) => r.index)).toEqual(view.perRung.map((r) => r.index))
  })
})
