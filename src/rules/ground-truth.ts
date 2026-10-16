import { MONTHS_ES, parseISODate, type ISODate } from '../engine'
import type { ExplanationView } from '../explain'
import type { ExplainRequest } from '../request/schema'
import { fold } from './normalize'
import type { GroundTruth, RungTruth } from './types'

/**
 * The full month names behind the renderings of SPEC §11.3 step 2. Kept here rather than
 * imported from the prompt layer so the harness does not share a table with what it measures;
 * ground-truth.test.ts checks the two agree.
 */
export const FULL_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const

/**
 * SPEC §11.3 step 2: the seven renderings of one date, lowercased and accent-folded.
 * `2027-06-01`, `1 jun 2027`, `1 de junio de 2027`, `1 de jun de 2027`, `1 de junio`,
 * `junio de 2027`, `junio 2027`.
 */
export function dateRenderings(date: ISODate): string[] {
  const { y, m, d } = parseISODate(date)
  const short = MONTHS_ES[m - 1]
  const long = FULL_MONTHS[m - 1]
  return [
    date,
    `${d} ${short} ${y}`,
    `${d} de ${long} de ${y}`,
    `${d} de ${short} de ${y}`,
    `${d} de ${long}`,
    `${long} de ${y}`,
    `${long} ${y}`,
  ].map(fold)
}

/**
 * SPEC §11.3 step 1: the number inside a display string. Extract `\d[\d.]*(,\d+)?`, delete
 * `.`, replace `,` with `.`, parse. `$ 1.234.567` → 1234567, `13,5%` → 13.5.
 */
export function numberOfDisplay(display: string): number {
  const match = /\d[\d.]*(,\d+)?/.exec(display)
  if (!match) throw new Error(`no number in display string: ${display}`)
  return Number(match[0].replace(/\./g, '').replace(',', '.'))
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
    renderings: dateRenderings(r.maturityDate),
  }))

  return {
    allowed,
    dates,
    selected: view.risks.selected,
    entityNames: request.ladder.entities.map((e) => e.name),
    rungs,
  }
}
