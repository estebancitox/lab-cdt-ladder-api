import { MONTHS_SHORT, parseISODate, type ISODate } from '../engine'
import type { ExplanationView } from '../explain'
import type { ExplainRequest } from '../request/schema'
import { normalize } from './normalize'
import type { GroundTruth, RungTruth } from './types'

/**
 * The whole month names of SPEC §3.4, behind the long date and the two renderings that lack a
 * day or a year. Kept here rather than imported from the prompt layer so the harness does not
 * share a table with what it measures; ground-truth.test.ts checks the two agree.
 */
export const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/**
 * SPEC §3.4: the full dates of one date, each naming one day: ISO, short and long, as written.
 * `2027-06-01`, `1 Jun 2027`, `1 June 2027`. In May the short and the long form are one string.
 */
export function fullDates(date: ISODate): string[] {
  const { y, m, d } = parseISODate(date)
  return [
    ...new Set([date, `${d} ${MONTHS_SHORT[m - 1]} ${y}`, `${d} ${FULL_MONTHS[m - 1]} ${y}`]),
  ]
}

/**
 * SPEC §3.4 and §11.3 step 2: the five renderings of one date, as written: the three full
 * dates, then `1 June` and `June 2027`. Nothing is folded: a rendering is compared
 * case-sensitively.
 */
export function dateRenderings(date: ISODate): string[] {
  const { y, m, d } = parseISODate(date)
  const long = FULL_MONTHS[m - 1]
  return [...fullDates(date), `${d} ${long}`, `${long} ${y}`]
}

/**
 * SPEC §3.4, the grammar of figures, step 1: a numeric run is a maximal match of digits, with a
 * `.` or a `,` taken into the run only where a digit stands on both sides of it.
 */
export const NUMERIC_RUN = /\d+(?:[.,]\d+)*/g
/** SPEC §3.4 step 2: a run is well formed when the whole of it matches `number`. */
export const WELL_FORMED_RUN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

/**
 * SPEC §3.4 steps 2 and 3: the value of a run, every `,` deleted and the rest read as a decimal,
 * or null when the run is not well formed. There is no second reading.
 */
export function valueOfRun(run: string): number | null {
  return WELL_FORMED_RUN.test(run) ? Number(run.replace(/,/g, '')) : null
}

/**
 * SPEC §3.4 step 4: the sign of the run that begins at `at`. A run is signed when a `-` stands
 * immediately before it, or immediately before a `COP` that stands immediately before it, which
 * is where step 8 of N leaves the code. The text is one that N has been applied to.
 */
export function signBefore(text: string, at: number): '' | '-' | '-COP' {
  if (at >= 1 && text[at - 1] === '-') return '-'
  if (at >= 4 && text.slice(at - 4, at) === '-COP') return '-COP'
  return ''
}

/**
 * SPEC §11.3 step 1: the number inside a display string, read with the grammar of §3.4, as a
 * figure of a reply is read: after N, one numeric run, its value, and its sign.
 * `COP 1,234,567` → 1234567, `13.5%` → 13.5, and the formatter's negative form `-COP 1,234` →
 * -1234, as the reading table of §3.4 has it. No view holds a negative amount (§3.3, §12).
 */
export function numberOfDisplay(display: string): number {
  const text = normalize(display)
  const runs = [...text.matchAll(NUMERIC_RUN)]
  if (runs.length !== 1) throw new Error(`not exactly one number in display string: ${display}`)
  const value = valueOfRun(runs[0][0])
  if (value === null) throw new Error(`malformed number in display string: ${display}`)
  return signBefore(text, runs[0].index) === '' || value === 0 ? value : -value
}

/**
 * SPEC §10 and §11.3: A, D and S derived from the engine's own view of the request, so that
 * ground truth cannot be influenced by the fixture author or by a caller.
 */
export function groundTruthFrom(request: ExplainRequest, view: ExplanationView): GroundTruth {
  const displays = [
    view.totals.principalDisplay,
    view.totals.grossInterestDisplay,
    view.totals.retencionDisplay,
    view.totals.netInterestDisplay,
    view.blendedEADisplay,
    ...view.perRung.flatMap((r) => [
      r.principalDisplay,
      r.eaDisplay,
      r.grossInterestDisplay,
      r.retencionDisplay,
      r.netInterestDisplay,
    ]),
    ...view.perEntity.flatMap((e) => [
      e.principalDisplay,
      e.interestDisplay,
      e.exposureDisplay,
      e.ceilingDisplay,
      e.shareOfCapitalDisplay,
      e.excessDisplay,
      e.headroomDisplay,
    ]),
    ...view.clusters.map((c) => c.principalDisplay),
  ]
  const integers = [
    view.rungCount,
    view.entityCount,
    view.clusterCount,
    ...view.clusters.map((c) => c.count),
    ...view.perRung.flatMap((r) => [r.index, r.days]),
    view.daysToNextMaturity,
  ]
  const allowed = new Set<number>([...displays.map(numberOfDisplay), ...integers])

  const dateList = [
    request.asOfDate,
    request.ladder.startDate,
    ...view.perRung.map((r) => r.maturityDate),
    ...view.clusters.flatMap((c) => [c.startDate, c.endDate]),
    view.nextMaturity,
    view.lastMaturity,
  ]
  const dates = new Set<string>(dateList.flatMap(dateRenderings))

  const rungs: RungTruth[] = view.perRung.map((r) => ({
    index: r.index,
    maturityDate: r.maturityDate,
    fullDates: fullDates(r.maturityDate),
  }))

  return {
    allowed,
    dates,
    selected: view.risks.selected,
    entityNames: request.ladder.entities.map((e) => e.name),
    rungs,
  }
}
