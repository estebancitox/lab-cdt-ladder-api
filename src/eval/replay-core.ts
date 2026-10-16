import { evaluate, evaluateRefusal } from '../rules'
import { groundTruth, type EvalCase, type SuiteResult } from './suite'

/**
 * The stored replies of a run, re-evaluated with the rules as they are now. Tokens, latency,
 * cost and the replies themselves are kept as measured; only the verdicts are recomputed.
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
