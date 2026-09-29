import type { DayCountBase } from './types'

/**
 * E.A. → period rate over `days`: (1 + EA)^(days/base) − 1.
 *
 * `base` is the liquidation base: 360 "comercial" (the usual convention on
 * Colombian CDT certificates) or 365 (ACT/365 fixed). The denominator is
 * deliberately independent of the calendar — a 366-day rung on base 365
 * yields slightly more than one year of E.A. while its calendar maturity
 * counts real days (see addDays). Do not "fix" either base to the calendar.
 */
export function periodRate(ea: number, days: number, base: DayCountBase): number {
  return Math.pow(1 + ea, days / base) - 1
}
