import { evaluate, evaluateRefusal } from '../rules'
import { groundTruth, type EvalCase, type SuiteResult } from './suite'

/** The prompt of version 1, the Spanish system. Both runs stored before version 2.0 record it. */
export const V1_PROMPT_VERSION = 'v1'

/**
 * SPEC §10.2 and the head of the SPEC: a v1 run is a dated record of the Spanish system, Spanish
 * replies under the Spanish prompt, judged by the v1 rules. A v1 verdict and a v2 verdict are
 * verdicts of different rules on text in different languages, so such a run is not replayed:
 * under the rules of this version every one of its replies fails `language_en`, which would say
 * nothing about the run. A run records its prompt version, and that is what tells them apart.
 */
export function comparable(stored: Pick<SuiteResult, 'promptVersion'>): boolean {
  return stored.promptVersion !== V1_PROMPT_VERSION
}

/**
 * The stored replies of a run, re-evaluated with the rules as they are now. Tokens, latency,
 * cost and the replies themselves are kept as measured; only the verdicts are recomputed. Pure:
 * it replays whatever it is given, and replay.ts refuses a run that is not comparable.
 */
export function replay(stored: SuiteResult, cases: readonly EvalCase[]): SuiteResult {
  const byId = new Map(cases.map((c) => [c.id, c]))
  return {
    ...stored,
    runs: stored.runs.map((r) => {
      const c = byId.get(r.caseId)
      if (!c) throw new Error(`no case ${r.caseId} in evals/cases.json`)
      const invalid = c.rules.includes('error_message_exact')
      const verdicts = invalid
        ? evaluateRefusal(r.status, { text: r.text }, r.calls, c.rules)
        : r.status === 200 && r.text !== null
          ? evaluate(r.text, groundTruth(c), c.rules)
          : c.rules.map((rule) => ({ rule, pass: false, evidence: `status ${r.status}` }))
      return { ...r, verdicts }
    }),
  }
}
