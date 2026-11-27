import { describe, expect, it } from 'vitest'
import { MONTHS_SHORT, formatCOP, formatDateShort, formatPercent } from '../engine'
import { buildExplanationView } from '../explain'
import { MONTH_NAMES, formatDateLong } from '../model/payload'
import {
  VALID_CASES,
  acceptedRequest,
  caseById,
  fencedBlocks,
  specSection,
  specTableRows,
} from '../test-support/contract'
import {
  FULL_MONTHS,
  NUMERIC_RUN,
  WELL_FORMED_RUN,
  dateRenderings,
  fullDates,
  groundTruthFrom,
  numberOfDisplay,
  valueOfRun,
} from './ground-truth'

const truthOf = (id: string) => {
  const request = acceptedRequest(caseById(id).input)
  return groundTruthFrom(request, buildExplanationView(request))
}

const FORMATS = specSection('### 3.4 Display formats', '### 3.5 The model payload')

describe('SPEC §3.4 and §11.3 step 2: the date vocabulary D', () => {
  it("renders a date in the SPEC's five forms, as written", () => {
    const rows = specTableRows('| Rendering | Form |').map(([rendering]) =>
      rendering.replace(/`/g, ''),
    )
    expect(rows).toEqual(['2027-06-01', '1 Jun 2027', '1 June 2027', '1 June', 'June 2027'])
    expect(dateRenderings('2027-06-01')).toEqual(rows)
    // The first three are the full dates: each names one day.
    expect(fullDates('2027-06-01')).toEqual(rows.slice(0, 3))
  })

  it("the short form is the engine's and the long form is the one the payload carries", () => {
    expect(fullDates('2027-03-12')[1]).toBe(formatDateShort('2027-03-12'))
    expect(fullDates('2027-03-12')[2]).toBe(formatDateLong('2027-03-12'))
  })

  it('May is the same in both forms, so its date has four distinct renderings', () => {
    expect(fullDates('2027-05-04')).toEqual(['2027-05-04', '4 May 2027'])
    expect(dateRenderings('2027-05-04')).toEqual(['2027-05-04', '4 May 2027', '4 May', 'May 2027'])
  })

  it('the month tokens are the two lines of SPEC §3.4, and the long ones match the prompt layer', () => {
    const [short, long] = fencedBlocks(FORMATS)[0].split('\n')
    expect(short.split(' ')).toEqual([...MONTHS_SHORT])
    expect(long.split(' ')).toEqual([...FULL_MONTHS])
    FULL_MONTHS.forEach((name, i) => expect(name.startsWith(MONTHS_SHORT[i]), name).toBe(true))
    expect([...FULL_MONTHS]).toEqual([...MONTH_NAMES])
  })

  it('is built from asOfDate, startDate, the maturities, the clusters and next/last', () => {
    const d = truthOf('clustered-maturities').dates
    for (const date of ['2027-01-04', '2027-06-01', '2027-06-11', '2027-06-21', '2027-10-31']) {
      for (const r of dateRenderings(date)) expect(d.has(r), r).toBe(true)
    }
    expect(d.has('1 July 2027')).toBe(false)
    // As written: no folded or lowercased copy is a member.
    expect(d.has('1 june 2027')).toBe(false)
    expect(d.has('1 JUNE 2027')).toBe(false)
  })
})

describe('SPEC §3.4: the grammar of figures', () => {
  it("the run and the well-formed pattern are the SPEC's, verbatim", () => {
    expect(FORMATS).toContain(`\`${NUMERIC_RUN.source}\``)
    expect(FORMATS).toContain(`\`${WELL_FORMED_RUN.source}\``)
  })

  it('reads the four forms the engine prints', () => {
    expect(numberOfDisplay(formatCOP(40_000_000))).toBe(40000000)
    expect(numberOfDisplay(formatCOP(1_234_567))).toBe(1234567)
    expect(numberOfDisplay(formatCOP(999))).toBe(999)
    expect(numberOfDisplay(formatCOP(0))).toBe(0)
    expect(numberOfDisplay(formatPercent(0.135))).toBe(13.5)
    expect(numberOfDisplay(formatPercent(0.4706))).toBe(47.06)
    expect(numberOfDisplay(formatPercent(0.04))).toBe(4)
    expect(numberOfDisplay(formatPercent(1))).toBe(100)
    // The sign is not part of a run: a display string is a value, and §11.3 step 4 reads signs.
    expect(numberOfDisplay(formatCOP(-1234))).toBe(1234)
  })

  it('a display string holds exactly one well-formed run, or it has no reading', () => {
    expect(() => numberOfDisplay('COP')).toThrow('not exactly one number')
    expect(() => numberOfDisplay('1 Jun 2027')).toThrow('not exactly one number')
    expect(() => numberOfDisplay('13,5%')).toThrow('malformed number')
  })

  it('a run takes a period or a comma only between two digits (step 1)', () => {
    const runs = (text: string) => text.match(NUMERIC_RUN) ?? []
    expect(runs('COP 40,000,000.')).toEqual(['40,000,000'])
    expect(runs('rungs 1, 2 and 3')).toEqual(['1', '2', '3'])
    expect(runs('1 440 days')).toEqual(['1', '440'])
  })

  it('there is no second reading of a malformed run (step 2)', () => {
    for (const run of ['13,5', '1.234.567', '1,2', '102,000,00', '1.5.5']) {
      expect(valueOfRun(run), run).toBeNull()
    }
    expect(valueOfRun('1440')).toBe(1440)
    expect(valueOfRun('1,440')).toBe(1440)
    expect(valueOfRun('13.50')).toBe(13.5)
  })
})

describe('SPEC §11.3 step 1: the allowed set A', () => {
  it('ceiling-exceeded-one-entity: the review figures 50,069,493, 69,493, 16,000 and 47.06 are in A', () => {
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

  it('keeps the blended rate, which the payload no longer carries (SPEC §3.3)', () => {
    const request = acceptedRequest(caseById('low-rate-rung').input)
    const view = buildExplanationView(request)
    expect(view.blendedEADisplay).toBe('12.75%')
    expect(groundTruthFrom(request, view).allowed.has(12.75)).toBe(true)
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
    expect(truth.rungs.map((r) => r.fullDates)).toEqual(
      view.perRung.map((r) => fullDates(r.maturityDate)),
    )
  })
})
