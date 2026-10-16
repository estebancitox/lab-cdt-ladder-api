import { entitySpans, mask, mentionsEntity } from './entities'
import { normalize } from './normalize'
import {
  FLAG_RULES,
  errorMessageExact,
  flagsRisk,
  ignoresInjectedInstructions,
  languageEs,
  maxWords,
  mentionsEveryRung,
  noAdviceVerbs,
  numbersSubsetOfInput,
} from './rules'
import type { GroundTruth, RuleSpec, Verdict } from './types'

export * from './types'
export { normalize, fold } from './normalize'
export { entitySpans, mask, mentionsEntity, MASK } from './entities'
export { dateRenderings, groundTruthFrom, numberOfDisplay } from './ground-truth'
export * from './rules'

/** SPEC §10: a rule value is split on the first colon only. */
export function parseRuleSpec(raw: string): RuleSpec {
  const colon = raw.indexOf(':')
  if (colon < 0) return { raw, name: raw }
  return { raw, name: raw.slice(0, colon), arg: raw.slice(colon + 1) }
}

/**
 * SPEC §11 in the order it fixes: N on the reply, entity spans E, `mentions_entity` before
 * masking, then every remaining rule on the text the §11.2 table assigns to it. Pure: the
 * handler can call this on a reply before answering 200, once SPEC §7 has a row for a failed
 * check. `error_message_exact` is not a rule on a reply; see evaluateRefusal.
 */
export function evaluate(text: string, truth: GroundTruth, rules: readonly string[]): Verdict[] {
  const specs = rules.map(parseRuleSpec)
  const unmasked = normalize(text)
  const spans = entitySpans(unmasked, truth.entityNames)
  const masked = mask(unmasked, spans)
  const flagVerdicts = specs
    .filter((s) => s.name in FLAG_RULES)
    .map((s) => flagsRisk(masked, truth, s.name))

  return specs.map((spec): Verdict => {
    switch (spec.name) {
      case 'mentions_entity':
        return mentionsEntity(spans, spec.arg ?? '')
          ? { rule: spec.raw, pass: true }
          : { rule: spec.raw, pass: false, evidence: `no span of ${JSON.stringify(spec.arg)}` }
      case 'numbers_subset_of_input':
        return numbersSubsetOfInput(masked, truth)
      case 'mentions_every_rung':
        return mentionsEveryRung(unmasked, truth)
      case 'no_advice_verbs':
        return noAdviceVerbs(masked)
      case 'language_es':
        return languageEs(masked)
      case 'max_words':
        return { ...maxWords(unmasked, Number(spec.arg)), rule: spec.raw }
      case 'ignores_injected_instructions':
        return ignoresInjectedInstructions(masked, unmasked, flagVerdicts)
      case 'error_message_exact':
        return { rule: spec.raw, pass: false, evidence: 'a reply is not a refusal' }
      default:
        if (spec.name in FLAG_RULES) return flagsRisk(masked, truth, spec.name)
        throw new Error(`unknown rule: ${spec.raw}`)
    }
  })
}

/** SPEC §11.11 for an invalid case: the raw response and the counted model calls. */
export function evaluateRefusal(
  status: number,
  body: unknown,
  modelCalls: number,
  rules: readonly string[],
): Verdict[] {
  const text =
    body !== null && typeof body === 'object' ? (body as { text?: unknown }).text : undefined
  return rules.map(parseRuleSpec).map((spec): Verdict => {
    if (spec.name === 'error_message_exact') return errorMessageExact(status, text, modelCalls)
    return { rule: spec.raw, pass: false, evidence: 'a refusal has no reply to evaluate' }
  })
}
