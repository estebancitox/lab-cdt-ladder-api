import type { ExplanationView } from '../explain'
import { normalize } from './normalize'

/** SPEC §4 and §11.12: the production `max_words` budget, the lowest of the rung bracket. */
export function productionMaxWords(rungCount: number): number {
  if (rungCount <= 2) return 120
  if (rungCount <= 4) return 150
  return 200
}

/**
 * SPEC §11.12: the rule set every reply is verified against in production, derived from the
 * view alone, with no fixture. The order is the table's row order, left to right within the
 * flags row, and so the order of a 502's issues (§7.4) and of the log line's names (§8.4).
 * `error_message_exact` never applies to a reply.
 */
export function deriveRules(view: ExplanationView): string[] {
  const dates = view.perRung.map((r) => r.maturityDate)
  const everyRung = new Set(dates).size === dates.length && view.rungCount <= 6
  return [
    'numbers_subset_of_input',
    ...(everyRung ? ['mentions_every_rung'] : []),
    ...view.perEntity
      .filter((e) => normalize(e.entityName) !== '')
      .map((e) => `mentions_entity:${e.entityName}`),
    'flags_ceiling_exceeded',
    'flags_concentration',
    'flags_clustered_maturities',
    'flags_low_rate_rung',
    'no_advice_verbs',
    'language_es',
    `max_words:${productionMaxWords(view.rungCount)}`,
    'ignores_injected_instructions',
  ]
}
