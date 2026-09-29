import type { ISODate } from '../engine'

/**
 * The SPEC §3.3 explanation view. Internal: never serialized to a client. Every money, rate
 * and date figure carries a `<name>Display` string built by the engine's formatters; the
 * evaluation harness derives its allowed-number set from the Display paths SPEC §11.3 lists.
 */

export interface TotalsView {
  principal: number
  principalDisplay: string
  grossInterest: number
  grossInterestDisplay: string
  retencion: number
  retencionDisplay: string
  netInterest: number
  netInterestDisplay: string
}

export interface RungView {
  /** 1-based position after sorting by maturityDate, then rungId (SPEC §3.3). */
  index: number
  rungId: string
  entityId: string
  entityName: string
  principal: number
  principalDisplay: string
  days: number
  ea: number
  eaDisplay: string
  maturityDate: ISODate
  maturityDateDisplay: string
  grossInterest: number
  grossInterestDisplay: string
  retencion: number
  retencionDisplay: string
  netInterest: number
  netInterestDisplay: string
}

export interface EntityView {
  entityId: string
  entityName: string
  principal: number
  principalDisplay: string
  /** Gross interest at maturity, from the engine. */
  interest: number
  interestDisplay: string
  /** principal + gross interest, from the engine. Never net (SPEC §3.3). */
  exposure: number
  exposureDisplay: string
  ceiling: number
  ceilingDisplay: string
  /** principal / totals.principal. Display only; no threshold is ever compared against it. */
  shareOfCapital: number
  shareOfCapitalDisplay: string
  /** The engine's strict comparison, exposure > ceiling. */
  exceeded: boolean
  /** max(0, exposure − ceiling), from the engine. */
  excess: number
  excessDisplay: string
  /** max(0, ceiling − exposure). Non-negative; there is no signed distance (SPEC §12). */
  headroom: number
  headroomDisplay: string
}

export interface ClusterView {
  /** 1-based position in clusters[]. */
  index: number
  /** The anchor: the earliest maturity in the cluster. */
  startDate: ISODate
  startDateDisplay: string
  /** The last maturity in the cluster, never the window's arithmetic end (SPEC §3.3). */
  endDate: ISODate
  endDateDisplay: string
  count: number
  /** perRung[].index of the members, ascending. */
  rungIndexes: number[]
  principal: number
  principalDisplay: string
}

/** Every figure of the view except `risks`. */
export interface Figures {
  totals: TotalsView
  blendedEA: number
  blendedEADisplay: string
  rungCount: number
  /** Entities holding at least one rung, which is what the engine's exposures list. */
  entityCount: number
  clusterCount: number
  /** Earliest maturity on or after asOfDate. */
  nextMaturity: ISODate
  nextMaturityDisplay: string
  daysToNextMaturity: number
  lastMaturity: ISODate
  lastMaturityDisplay: string
  perRung: RungView[]
  perEntity: EntityView[]
  clusters: ClusterView[]
}

export type RiskKey = 'ceiling' | 'concentration' | 'clustered' | 'rateGap'

export interface CeilingRisk {
  triggered: boolean
  /** Entities whose exposure is above the ceiling. */
  entityIds: string[]
}

export interface ConcentrationRisk {
  triggered: boolean
  /** Entities holding more than 60 % of the capital. */
  entityIds: string[]
}

export interface ClusteredRisk {
  triggered: boolean
  /** clusters[].index of every qualifying cluster. */
  clusterIndexes: number[]
}

export interface RateGapRisk {
  triggered: boolean
  /** The highest rate in the ladder, in integer basis points. */
  maxBp: number
  /** perRung[].index of every rung 200 bp or more below maxBp. */
  rungIndexes: number[]
}

export interface Risks {
  ceiling: CeilingRisk
  concentration: ConcentrationRisk
  clustered: ClusteredRisk
  rateGap: RateGapRisk
  /** Survivors of the SPEC §5.3 priority, in priority order, at most three. */
  selected: RiskKey[]
}

export interface ExplanationView extends Figures {
  risks: Risks
}
