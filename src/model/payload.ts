import { parseISODate, type ISODate } from '../engine'
import { basisPoints, type EntityView, type ExplanationView, type RiskKey } from '../explain'
import type { ExplainRequest } from '../request/schema'

/** SPEC §4: the closed label vocabulary, one label per risk of the view. */
export const RISK_LABELS: Record<RiskKey, string> = {
  ceiling: 'Deposit-insurance ceiling',
  concentration: 'Concentration',
  clustered: 'Clustered maturities',
  rateGap: 'Rate difference',
}

/** SPEC §3.4: the twelve whole month names. Each begins with the engine's three letters. */
export const MONTH_NAMES = [
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
 * '2027-06-01' → '1 June 2027': the long date of SPEC §3.4, the form the payload carries. The
 * engine has no long form, and the model is handed the form a reader expects so that it copies a
 * date instead of expanding or reordering one. Calendar validity is still the engine's:
 * parseISODate throws on anything that is not a real date.
 */
export function formatDateLong(date: ISODate): string {
  const { y, m, d } = parseISODate(date)
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * The user message of the model call, SPEC §3.5. A projection of the SPEC §3.3 view that carries
 * only what the model may say: display strings and integers of the SPEC §11.3 allowed set, dates
 * of its date vocabulary in the long form, institution names, and the labels of `selected`. No
 * ids, no raw fractions, no dayCountBase, no withholding rate, no threshold and no blended rate.
 * Risk figures appear only for the selected risks, so a risk the server did not select has
 * nothing to be narrated from.
 *
 * The keys are written in the order of the two tables of §3.5, and every key of more than one
 * word is camelCase, which is what lets SPEC §11.8 step 4 catch a key echoed into a reply.
 */
export interface ModelPayload {
  asOfDate: string
  startDate: string
  rungCount: number
  institutionCount: number
  totals: {
    principal: string
    grossInterest: string
    withholdingTax: string
    netInterest: string
  }
  nextMaturity: { date: string; daysFromAsOfDate: number }
  lastMaturity: string
  rungs: {
    number: number
    institution: string
    principal: string
    termDays: number
    rateEA: string
    maturity: string
    grossInterest: string
    withholdingTax: string
    netInterest: string
  }[]
  institutions: { institution: string; principal: string; share: string }[]
  risks: RiskEntry[]
}

export type RiskEntry =
  | {
      label: string
      institutions: {
        institution: string
        exposure: string
        insuranceCeiling: string
        excess: string
      }[]
    }
  | { label: string; institutions: { institution: string; principal: string; share: string }[] }
  | {
      label: string
      groupCount: number
      groups: {
        rungCount: number
        rungNumbers: number[]
        firstMaturity: string
        lastMaturity: string
        principal: string
      }[]
    }
  | {
      label: string
      highestRate: string
      rungs: { number: number; institution: string; rateEA: string }[]
    }

/** Expects the request validateRequest accepted and the view built from it. */
export function buildModelPayload(request: ExplainRequest, view: ExplanationView): ModelPayload {
  const { totals } = view
  return {
    asOfDate: formatDateLong(request.asOfDate),
    startDate: formatDateLong(request.ladder.startDate),
    rungCount: view.rungCount,
    institutionCount: view.entityCount,
    totals: {
      principal: totals.principalDisplay,
      grossInterest: totals.grossInterestDisplay,
      withholdingTax: totals.retencionDisplay,
      netInterest: totals.netInterestDisplay,
    },
    nextMaturity: {
      date: formatDateLong(view.nextMaturity),
      daysFromAsOfDate: view.daysToNextMaturity,
    },
    lastMaturity: formatDateLong(view.lastMaturity),
    rungs: view.perRung.map((r) => ({
      number: r.index,
      institution: r.entityName,
      principal: r.principalDisplay,
      termDays: r.days,
      rateEA: r.eaDisplay,
      maturity: formatDateLong(r.maturityDate),
      grossInterest: r.grossInterestDisplay,
      withholdingTax: r.retencionDisplay,
      netInterest: r.netInterestDisplay,
    })),
    institutions: view.perEntity.map((e) => ({
      institution: e.entityName,
      principal: e.principalDisplay,
      share: e.shareOfCapitalDisplay,
    })),
    // SPEC §5.3: only the survivors of the priority, in priority order.
    risks: view.risks.selected.map((key) => riskEntry(key, view)),
  }
}

/** Compact JSON: its string syntax is the delimiter around institution names (SPEC §8.3). */
export function renderUserMessage(payload: ModelPayload): string {
  return JSON.stringify(payload)
}

function riskEntry(key: RiskKey, view: ExplanationView): RiskEntry {
  const label = RISK_LABELS[key]
  switch (key) {
    case 'ceiling':
      return {
        label,
        institutions: view.risks.ceiling.entityIds.map((id) => {
          const e = entityOf(view, id)
          return {
            institution: e.entityName,
            exposure: e.exposureDisplay,
            insuranceCeiling: e.ceilingDisplay,
            excess: e.excessDisplay,
          }
        }),
      }
    case 'concentration':
      return {
        label,
        institutions: view.risks.concentration.entityIds.map((id) => {
          const e = entityOf(view, id)
          return {
            institution: e.entityName,
            principal: e.principalDisplay,
            share: e.shareOfCapitalDisplay,
          }
        }),
      }
    case 'clustered':
      return {
        label,
        groupCount: view.clusterCount,
        groups: view.clusters.map((c) => ({
          rungCount: c.count,
          rungNumbers: c.rungIndexes,
          firstMaturity: formatDateLong(c.startDate),
          lastMaturity: formatDateLong(c.endDate),
          principal: c.principalDisplay,
        })),
      }
    case 'rateGap': {
      const { maxBp, rungIndexes } = view.risks.rateGap
      // The highest rate is handed over as the display string of a rung that carries it, so
      // the figure is one SPEC §11.3 already allows. The gap itself is never given.
      const highest = view.perRung.find((r) => basisPoints(r.ea) === maxBp)
      if (highest === undefined) throw new Error('no rung carries the highest rate of the view')
      return {
        label,
        highestRate: highest.eaDisplay,
        rungs: rungIndexes.map((index) => {
          const r = view.perRung[index - 1]
          return { number: r.index, institution: r.entityName, rateEA: r.eaDisplay }
        }),
      }
    }
  }
}

function entityOf(view: ExplanationView, entityId: string): EntityView {
  const entity = view.perEntity.find((e) => e.entityId === entityId)
  if (entity === undefined) throw new Error('a risk names an entity that is not in the view')
  return entity
}
