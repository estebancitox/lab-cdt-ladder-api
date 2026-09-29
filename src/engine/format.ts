import { parseISODate } from './dates'
import type { ISODate } from './types'

/**
 * One-way formatters: the engine speaks numbers, nothing parses display strings
 * back (the es-CO thousands separator is the JS decimal point — round-tripping
 * silently divides by ~10^6).
 */

const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export function formatCOP(x: number): string {
  return copFormatter.format(x)
}

const percentFormatters = new Map<number, Intl.NumberFormat>()

export function formatPercent(fraction: number, maxDecimals = 2): string {
  let f = percentFormatters.get(maxDecimals)
  if (!f) {
    f = new Intl.NumberFormat('es-CO', {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDecimals,
    })
    percentFormatters.set(maxDecimals, f)
  }
  return f.format(fraction)
}

export const MONTHS_ES = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
] as const

/** '2027-03-12' → '12 mar 2027'. Hand-rolled: deterministic across ICU versions. */
export function formatDateShort(date: ISODate): string {
  const { y, m, d } = parseISODate(date)
  return `${d} ${MONTHS_ES[m - 1]} ${y}`
}
