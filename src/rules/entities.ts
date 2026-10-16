import { normalize } from './normalize'

/** A match of an entity name in the normalized text, as UTF-16 offsets into that text. */
export interface EntitySpan {
  entity: string
  start: number
  end: number
}

/** SPEC §11.2 step 4: what every recorded span becomes in the masked text. */
export const MASK = '«ENTIDAD»'

/**
 * SPEC §11.2 steps 1 and 2: every normalized name is searched in the normalized text under
 * `toLocaleLowerCase('es')`, longest name first so a short name that is a prefix of a longer
 * one does not steal the span. A match that overlaps a span already recorded is skipped. The
 * result maps each raw entity name to its spans, possibly none.
 */
export function entitySpans(
  normalizedText: string,
  entityNames: readonly string[],
): Map<string, EntitySpan[]> {
  const spans = new Map<string, EntitySpan[]>(entityNames.map((name) => [name, []]))
  const { lowered, offsets } = lowerWithOffsets(normalizedText)
  const taken: [number, number][] = []
  const byLength = [...entityNames].sort(
    (a, b) => normalize(b).length - normalize(a).length || a.localeCompare(b),
  )
  for (const name of byLength) {
    const needle = normalize(name).toLocaleLowerCase('es')
    if (needle === '') continue
    let from = 0
    for (;;) {
      const at = lowered.indexOf(needle, from)
      if (at < 0) break
      const start = offsets[at]
      const end = offsets[at + needle.length]
      from = at + 1
      if (taken.some(([s, e]) => start < e && s < end)) continue
      taken.push([start, end])
      spans.get(name)?.push({ entity: name, start, end })
    }
  }
  return spans
}

/** SPEC §11.2 step 3 (§11.5): at least one span was recorded for the entity. */
export function mentionsEntity(spans: Map<string, EntitySpan[]>, name: string): boolean {
  return (spans.get(name)?.length ?? 0) > 0
}

/** SPEC §11.2 step 4: the normalized text with every recorded span replaced by MASK. */
export function mask(normalizedText: string, spans: Map<string, EntitySpan[]>): string {
  const all = [...spans.values()].flat().sort((a, b) => b.start - a.start)
  let text = normalizedText
  for (const span of all) text = text.slice(0, span.start) + MASK + text.slice(span.end)
  return text
}

/**
 * The text lowercased code point by code point, with a map from each offset of the lowered
 * text back to the original. Lowercasing can change a character's length (`İ` becomes two
 * code units), so offsets cannot be assumed equal.
 */
function lowerWithOffsets(text: string): { lowered: string; offsets: number[] } {
  let lowered = ''
  const offsets: number[] = []
  let index = 0
  for (const char of text) {
    const low = char.toLocaleLowerCase('es')
    for (let i = 0; i < low.length; i += 1) offsets.push(index)
    lowered += low
    index += char.length
  }
  offsets.push(index)
  return { lowered, offsets }
}
