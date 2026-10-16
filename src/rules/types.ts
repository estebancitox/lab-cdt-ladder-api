import type { RiskKey } from '../explain'

/**
 * The result of one SPEC §11 rule. `rule` is the fixture string the verdict answers
 * (`max_words:150`, `mentions_entity:Entidad A`), and `evidence` names what failed: the
 * offending token, line, span or count. A passing verdict carries no evidence.
 */
export interface Verdict {
  rule: string
  pass: boolean
  evidence?: string
}

/** One rung as `mentions_every_rung` needs it: its position and the D renderings of its date. */
export interface RungTruth {
  index: number
  maturityDate: string
  renderings: readonly string[]
}

/**
 * What SPEC §10 derives from the engine for one request: the allowed set A (§11.3), the date
 * vocabulary D, the server's `selected` set S (§5.3), the entity names of the request and the
 * rungs. Built by ground-truth.ts from the view the 2A code computes; never typed by hand.
 */
export interface GroundTruth {
  allowed: ReadonlySet<number>
  dates: ReadonlySet<string>
  selected: readonly RiskKey[]
  entityNames: readonly string[]
  rungs: readonly RungTruth[]
}

/** A fixture rule string split on its first colon (SPEC §10). */
export interface RuleSpec {
  raw: string
  name: string
  arg?: string
}
