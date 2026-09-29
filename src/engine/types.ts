/** Date-only ISO string 'YYYY-MM-DD'. The engine never does Date millisecond math. */
export type ISODate = string

/**
 * Denominator of the period-rate exponent. Colombian CDTs usually liquidate
 * on the 360 "comercial" base (it appears on the certificate as "Base
 * liquidación"); 365 is the ACT/365 alternative. Calendar maturities always
 * count real days — only the exponent changes.
 */
export type DayCountBase = 360 | 365

export interface FiscalParams {
  /** Retención en la fuente on interest, as a fraction (0.04 = 4 %). User-supplied, never current truth. */
  retencionRate: number
  /** Deposit-insurance ceiling per entity, integer COP. User-supplied, never current truth. */
  insuranceCeiling: number
}

export interface Entity {
  id: string
  name: string
}

export interface RungInput {
  id: string
  /** Integer COP. */
  principal: number
  /** Term in days, integer > 0. */
  days: number
  /** Effective annual rate as a fraction (0.135 = 13,5 % E.A.). */
  ea: number
  entityId: string
}

/**
 * Modes are mutually exclusive by construction — no precedence ambiguity.
 * `cycles` counts renewals after the initial term (≥ 1); `horizonDate` renews
 * until the horizon, pricing a truncated stub if it lands mid-cycle.
 */
export type RolloverConfig =
  | { mode: 'cycles'; cycles: number }
  | { mode: 'horizon'; horizonDate: ISODate }

export interface ScenarioInput {
  startDate: ISODate
  rungs: RungInput[]
  entities: Entity[]
  fiscal: FiscalParams
  dayCountBase: DayCountBase
  rollover?: RolloverConfig
}

export interface RolloverCycle {
  /** 1-based renewal index (the initial term is not a cycle). */
  index: number
  startDate: ISODate
  endDate: ISODate
  days: number
  /** Reinvested at cycle start: previous principal + rounded net (cash event). */
  principal: number
  periodRate: number
  grossInterest: number
  retencion: number
  netInterest: number
  endValue: number
  isStub: boolean
}

export interface RungProjection {
  rungId: string
  entityId: string
  /** Renewals only; empty when the horizon precedes the first renewal. */
  cycles: RolloverCycle[]
  /** Original invested principal. */
  initialPrincipal: number
  finalValue: number
  finalMaturity: ISODate
  /** Initial net + every renewal's net. */
  cumulativeNet: number
  hasStub: boolean
}

export interface RungResult extends RungInput {
  periodRate: number
  /** Rounded COP — interest at maturity is a cash event. */
  grossInterest: number
  /** Rounded COP, computed on the rounded gross so each row reconciles by hand. */
  retencion: number
  /** grossInterest − retencion; integer by construction. */
  netInterest: number
  maturityDate: ISODate
}

export interface ScenarioTotals {
  principal: number
  grossInterest: number
  retencion: number
  netInterest: number
}

export interface EntityExposure {
  entityId: string
  entityName: string
  /** Sum of original invested principal for this entity. */
  principal: number
  /**
   * Without rollover: gross (pre-tax) interest at maturity. With rollover:
   * the interest embedded in the chain's highest balance at any maturity —
   * the most the insurance would ever have had to cover.
   */
  interest: number
  /** principal + interest; net-of-retención would understate exposure. */
  exposure: number
  ceiling: number
  /** Strictly above the ceiling; exactly-at-ceiling is compliant. */
  exceeded: boolean
  /** max(0, exposure − ceiling). */
  excess: number
}

export interface ProjectionSummary {
  /** One entry per rung, same order as `rungs`. */
  perRung: RungProjection[]
  totalFinalValue: number
  totalCumulativeNet: number
  /** Latest final maturity across rungs. */
  finalMaturity: ISODate
}

export interface ScenarioResult {
  /** Sorted by maturity date ascending. */
  rungs: RungResult[]
  /** Sums of the rounded per-rung values — always equals what the table shows. */
  totals: ScenarioTotals
  blendedEA: number
  nextMaturity: ISODate | null
  /** One entry per entity that holds at least one rung, in input entity order. */
  exposures: EntityExposure[]
  /** Present only when the input requests rollover. */
  projection?: ProjectionSummary
}

export interface ValidationIssue {
  code: string
  path: string
  message: string
}
