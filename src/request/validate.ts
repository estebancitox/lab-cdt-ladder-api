import { computeScenario, parseISODate, validateScenario } from '../engine'
import {
  ERROR_MESSAGE,
  type ApiIssue,
  type EngineIssue,
  type ErrorCode,
  type Issue,
  type RefusalBody,
} from './errors'
import { validateShape, type ExplainRequest } from './schema'

/** SPEC §8: 8 KiB on the raw body, before parsing. Exactly 8192 bytes passes; 8193 does not. */
export const MAX_BODY_BYTES = 8 * 1024

/** Which stage refused the body. A stage sees the body only if every earlier one accepted it. */
export type Stage = 'cap' | 'json' | 'schema' | 'engine' | 'asOfDate'

export type ValidationOutcome =
  | { ok: true; request: ExplainRequest }
  | { ok: false; stage: Stage; status: 413 | 400; body: RefusalBody }

/** Strict decoding: malformed UTF-8 is not JSON either. */
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Raw request body to validated request, as a pure function. Order, from SPEC §7 and §2.1:
 *   1. the byte cap on the raw body, before any parsing;
 *   2. JSON parse;
 *   3. the draft-07 schema: shape, JSON types, resource bounds;
 *   4. the engine's validateScenario, its issues returned verbatim (§7.2);
 *   5. the API's two asOfDate rules, which the engine does not know about.
 * Each stage returns only its own issues and later stages do not run. Content-Length is the
 * handler's concern; this function only sees bytes.
 */
export function validateRequest(raw: string | Uint8Array): ValidationOutcome {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength
  if (bytes > MAX_BODY_BYTES) return refuse('cap', 413, 'payload_too_large', [])

  let parsed: unknown
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : utf8.decode(raw))
  } catch {
    return refuse('json', 400, 'invalid_input', [
      {
        source: 'api',
        code: 'invalid_json',
        path: '',
        message: 'El cuerpo de la solicitud no es JSON válido.',
      },
    ])
  }

  const shape = validateShape(parsed)
  if (!shape.ok) return refuse('schema', 400, 'invalid_input', shape.issues)
  const { request } = shape

  const engineIssues = validateScenario(request.ladder)
  if (engineIssues.length > 0) {
    return refuse(
      'engine',
      400,
      'invalid_input',
      engineIssues.map((issue): EngineIssue => ({ source: 'engine', ...issue })),
    )
  }

  const apiIssues = checkAsOfDate(request)
  if (apiIssues.length > 0) return refuse('asOfDate', 400, 'invalid_input', apiIssues)

  return { ok: true, request }
}

function checkAsOfDate(request: ExplainRequest): ApiIssue[] {
  // Rule 1: a real calendar date, decided by the engine's parser rather than by a new rule.
  try {
    parseISODate(request.asOfDate)
  } catch {
    return [
      {
        source: 'api',
        code: 'as_of_date_invalid',
        path: 'asOfDate',
        message: 'La fecha de consulta no es válida.',
      },
    ]
  }
  // Rule 2: not after the last maturity. computeScenario sorts by maturity, so the last rung
  // carries it. Valid ISO dates compare correctly as strings, as the engine itself relies on.
  const { rungs } = computeScenario(request.ladder)
  const lastMaturity = rungs[rungs.length - 1].maturityDate
  if (request.asOfDate > lastMaturity) {
    return [
      {
        source: 'api',
        code: 'as_of_date_after_last_maturity',
        path: 'asOfDate',
        message: 'La fecha de consulta es posterior al último vencimiento de la escalera.',
      },
    ]
  }
  return []
}

function refuse(
  stage: Stage,
  status: 413 | 400,
  code: ErrorCode,
  issues: Issue[],
): ValidationOutcome {
  return { ok: false, stage, status, body: { text: ERROR_MESSAGE, error: { code, issues } } }
}
