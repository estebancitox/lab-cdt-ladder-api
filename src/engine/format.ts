import { parseISODate } from './dates'
import type { ISODate } from './types'

/**
 * One-way formatters: the engine speaks numbers and never parses a display
 * string back ('COP 40,000,000' is not a number, and parseFloat('40,000,000')
 * stops at the first comma and returns 40).
 */

const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/**
 * 40000000 → 'COP 40,000,000'. The code, the plain space (U+0020) and the sign
 * position are literals here, so ICU supplies only the digits, the commas and
 * the minus: the same characters in every runtime.
 */
export function formatCOP(x: number): string {
  const digits = integerFormatter.format(x)
  return digits.startsWith('-') ? `-COP ${digits.slice(1)}` : `COP ${digits}`
}

const percentFormatters = new Map<number, Intl.NumberFormat>()

export function formatPercent(fraction: number, maxDecimals = 2): string {
  let f = percentFormatters.get(maxDecimals)
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDecimals,
    })
    percentFormatters.set(maxDecimals, f)
  }
  return f.format(fraction)
}

export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** '2027-03-12' → '12 Mar 2027'. Hand-rolled: deterministic across ICU versions. */
export function formatDateShort(date: ISODate): string {
  const { y, m, d } = parseISODate(date)
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`
}
