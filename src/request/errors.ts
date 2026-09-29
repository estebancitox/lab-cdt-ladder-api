/**
 * Fixed strings and codes of SPEC §7 that the validation layer produces. ERROR_MESSAGE is
 * byte-exact against the SPEC: validate.test.ts compares it to the line parsed out of
 * SPEC.md rather than to a retyped copy.
 */
export const ERROR_MESSAGE = 'No puedo explicar esta escalera: los datos recibidos no son válidos.'

/** SPEC §7: the two refusal codes reachable before any model call. */
export type ErrorCode = 'payload_too_large' | 'invalid_input'

/** A JSON Schema violation: the AJV keyword and a JSON Pointer to the offending value. */
export interface SchemaIssue {
  source: 'schema'
  keyword: string
  path: string
}

/** The engine's ValidationIssue, returned verbatim (SPEC §7.2), tagged with its source. */
export interface EngineIssue {
  source: 'engine'
  code: string
  path: string
  message: string
}

/**
 * The API's own rules: a body that is not JSON, and the two asOfDate rules of SPEC §2.1,
 * which the engine does not know about. Shapes fixed by plan decisions 2 and 3.
 */
export type ApiIssueCode = 'invalid_json' | 'as_of_date_invalid' | 'as_of_date_after_last_maturity'

export interface ApiIssue {
  source: 'api'
  code: ApiIssueCode
  path: string
  message: string
}

export type Issue = SchemaIssue | EngineIssue | ApiIssue

/**
 * SPEC §7.1 refusal shape. `text` is always the fixed string; `issues` is diagnostic
 * metadata for the client, not the explanation.
 */
export interface RefusalBody {
  text: typeof ERROR_MESSAGE
  error: { code: ErrorCode; issues: Issue[] }
}
