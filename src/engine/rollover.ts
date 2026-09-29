import { addDays, dayNumber } from './dates'
import { roundCOP } from './money'
import { periodRate } from './rates'
import type {
  DayCountBase,
  FiscalParams,
  RolloverConfig,
  RolloverCycle,
  RungProjection,
  RungResult,
} from './types'

/** Defensive backstop only — the UI validates renewal counts far below this. */
const MAX_CYCLES = 200

function computeCycle(
  index: number,
  startDate: string,
  days: number,
  principal: number,
  ea: number,
  fiscal: FiscalParams,
  base: DayCountBase,
  isStub: boolean,
): RolloverCycle {
  const rate = periodRate(ea, days, base)
  // Same cash-event policy as computeRung: gross rounded per cycle, retención
  // on the rounded gross, so each row reproduces by hand from the previous.
  const grossInterest = roundCOP(principal * rate)
  if (!Number.isSafeInteger(grossInterest)) {
    throw new RangeError(
      `grossInterest exceeds safe integer precision: ${grossInterest} — pesos would be lost`,
    )
  }
  const retencion = roundCOP(grossInterest * fiscal.retencionRate)
  const netInterest = grossInterest - retencion
  return {
    index,
    startDate,
    endDate: addDays(startDate, days),
    days,
    principal,
    periodRate: rate,
    grossInterest,
    retencion,
    netInterest,
    endValue: principal + netInterest,
    isStub,
  }
}

/**
 * Project renewals for one computed rung: at each maturity the rounded
 * principal + net reinvests at the SAME E.A. for the same term (real CDT
 * renewals reprice — a modeling assumption the UI states).
 *
 * 'cycles' mode runs exactly `cycles` renewals. 'horizon' mode renews while a
 * full cycle fits; a horizon mid-cycle prices a truncated stub over the
 * remaining days ((1+EA)^(rem/base) − 1); a horizon exactly on a boundary
 * produces no zero-day stub; a horizon at or before the initial maturity
 * produces no renewals.
 */
export function projectRung(
  rung: RungResult,
  config: RolloverConfig,
  fiscal: FiscalParams,
  base: DayCountBase,
): RungProjection {
  const cycles: RolloverCycle[] = []
  let cursor = rung.maturityDate
  let value = rung.principal + rung.netInterest

  const push = (days: number, isStub: boolean) => {
    const cycle = computeCycle(cycles.length + 1, cursor, days, value, rung.ea, fiscal, base, isStub)
    cycles.push(cycle)
    cursor = cycle.endDate
    value = cycle.endValue
  }

  if (config.mode === 'cycles') {
    for (let i = 0; i < config.cycles; i++) push(rung.days, false)
  } else {
    const horizon = dayNumber(config.horizonDate)
    while (dayNumber(addDays(cursor, rung.days)) <= horizon) {
      push(rung.days, false)
      if (cycles.length > MAX_CYCLES) {
        throw new RangeError(`rollover exceeded ${MAX_CYCLES} cycles — validate inputs first`)
      }
    }
    const remaining = horizon - dayNumber(cursor)
    if (remaining > 0) push(remaining, true)
  }

  return {
    rungId: rung.id,
    entityId: rung.entityId,
    cycles,
    initialPrincipal: rung.principal,
    finalValue: value,
    finalMaturity: cursor,
    cumulativeNet: rung.netInterest + cycles.reduce((a, c) => a + c.netInterest, 0),
    hasStub: cycles.some((c) => c.isStub),
  }
}
