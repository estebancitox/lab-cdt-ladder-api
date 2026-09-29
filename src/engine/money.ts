/**
 * The single rounding used at cash events and display: half-up, −0 normalized.
 * Internal math stays in full double precision; only cash events round.
 */
export function roundCOP(x: number): number {
  const r = Math.round(x)
  return r === 0 ? 0 : r
}

/**
 * Split integer COP into `parts` near-equal integers. The first (total mod parts)
 * rungs carry one extra peso, so the sum always equals the input exactly.
 */
export function splitCapital(total: number, parts: number): number[] {
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new RangeError(`total must be a positive integer: ${total}`)
  }
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`parts must be a positive integer: ${parts}`)
  }
  const base = Math.floor(total / parts)
  const extra = total % parts
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0))
}
