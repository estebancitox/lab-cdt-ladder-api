import Ajv, { type ErrorObject } from 'ajv'
import schema from '../../schemas/explain-request.v1.json'
import type { ScenarioInput } from '../engine'
import type { SchemaIssue } from './errors'

/**
 * The request body once the schema has accepted it: shape, JSON types and resource bounds
 * only (SPEC §2.1). Domain rules are still the engine's: `dayCountBase` is any integer here
 * and is known to be 360 | 365 only after validateScenario has passed.
 */
export interface ExplainRequest {
  asOfDate: string
  ladder: Ladder
}

/** ScenarioInput without rollover, which `additionalProperties: false` rejects (SPEC §6). */
export type Ladder = Omit<ScenarioInput, 'rollover'>

/** SPEC §2.2, loaded from schemas/explain-request.v1.json, which is identical to the SPEC. */
export const explainRequestSchema = schema

/**
 * The default Ajv class is draft-07 (2019-09 and 2020-12 are separate classes). allErrors
 * so the diagnostic `issues` array lists every violation, not only the first.
 */
export const schemaCompiler = new Ajv({ allErrors: true })
const validate = schemaCompiler.compile<ExplainRequest>(schema)

export type ShapeOutcome =
  { ok: true; request: ExplainRequest } | { ok: false; issues: SchemaIssue[] }

export function validateShape(body: unknown): ShapeOutcome {
  if (validate(body)) return { ok: true, request: body }
  return { ok: false, issues: (validate.errors ?? []).map(toIssue) }
}

/**
 * AJV reports `required` and `additionalProperties` at the parent object and names the
 * property in `params`. Appending it yields the path SPEC §7.1 shows for a missing field,
 * /ladder/rungs/0/ea. Property names are escaped per RFC 6901.
 */
function toIssue(error: ErrorObject): SchemaIssue {
  let path = error.instancePath
  if (error.keyword === 'required') {
    path += '/' + escapePointerToken(String(error.params.missingProperty))
  } else if (error.keyword === 'additionalProperties') {
    path += '/' + escapePointerToken(String(error.params.additionalProperty))
  }
  return { source: 'schema', keyword: error.keyword, path }
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}
