import type { ISODate } from './types'

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export interface CalendarDate {
  y: number
  m: number
  d: number
}

export function parseISODate(date: ISODate): CalendarDate {
  const match = ISO_RE.exec(date)
  if (!match) throw new RangeError(`Invalid ISO date: ${date}`)
  const parts = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
  const t = new Date(Date.UTC(parts.y, parts.m - 1, parts.d))
  if (
    t.getUTCFullYear() !== parts.y ||
    t.getUTCMonth() !== parts.m - 1 ||
    t.getUTCDate() !== parts.d
  ) {
    throw new RangeError(`Invalid calendar date: ${date}`)
  }
  return parts
}

export function toISODate({ y, m, d }: CalendarDate): ISODate {
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}

/**
 * Calendar-day arithmetic via UTC fields — immune to the host timezone and DST.
 * Never add N * 86_400_000 milliseconds to an instant.
 */
export function addDays(date: ISODate, days: number): ISODate {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer: ${days}`)
  const { y, m, d } = parseISODate(date)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return toISODate({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() })
}

/** Day number since the epoch, date-only and TZ-independent. For axis math. */
export function dayNumber(date: ISODate): number {
  const { y, m, d } = parseISODate(date)
  return Date.UTC(y, m - 1, d) / 86_400_000
}
