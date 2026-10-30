import { computeScenario, dayNumber, parseISODate, validateScenario } from '../engine'
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

/** SPEC §8.5: per-rung operator limits, all inclusive. */
export const MAX_RUNG_DAYS = 3650
export const MAX_RUNG_PRINCIPAL = 1e12
/** The last date the engine's four-digit years can carry, so the latest maturity a rung can have. */
export const MAX_MATURITY_DATE = '9999-12-31'

/** Which stage refused the body. A stage sees the body only if every earlier one accepted it. */
export type Stage = 'cap' | 'json' | 'schema' | 'engine' | 'range' | 'asOfDate'

export type ValidationOutcome =
  | { ok: true; request: ExplainRequest }
  | { ok: false; stage: Stage; status: 413 | 400; body: RefusalBody }

/** Strict decoding: malformed UTF-8 is not JSON either. */
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** SPEC §7.3: a JSON `-0` is read as `0`, so no figure derived from it carries a sign. */
function unsignedZero(_key: string, value: unknown): unknown {
  return Object.is(value, -0) ? 0 : value
}

/**
 * Raw request body to validated request, as a pure function. Order, from SPEC §7 and §2.1:
 *   1. the byte cap on the raw body, before any parsing;
 *   2. JSON parse, a `-0` read as `0`;
 *   3. the draft-07 schema: shape, JSON types, resource bounds;
 *   4. the engine's validateScenario, its issues returned verbatim (§7.2);
 *   5. the per-rung range limits of §8.5, so an out-of-range rung never reaches the arithmetic;
 *   6. the API's two asOfDate rules, which the engine does not know about.
 * Each stage returns only its own issues and later stages do not run. Content-Length is the
 * handler's concern; this function only sees bytes.
 */
export function validateRequest(raw: string | Uint8Array): ValidationOutcome {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength
  if (bytes > MAX_BODY_BYTES) return refuse('cap', 413, 'payload_too_large', [])

  let parsed: unknown
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : utf8.decode(raw), unsignedZero)
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

  const rangeIssues = checkRanges(request)
  if (rangeIssues.length > 0) return refuse('range', 400, 'invalid_input', rangeIssues)

  const apiIssues = checkAsOfDate(request)
  if (apiIssues.length > 0) return refuse('asOfDate', 400, 'invalid_input', apiIssues)

  return { ok: true, request }
}

/**
 * One issue per offending field of every offending rung, in the engine's field order. A term over
 * its own limit is not also checked against the maturity limit, so no field carries two issues.
 */
function checkRanges(request: ExplainRequest): ApiIssue[] {
  const issues: ApiIssue[] = []
  // Day numbers, not strings: '10000-01-01' sorts before '9999-12-31'.
  const daysToLimit = dayNumber(MAX_MATURITY_DATE) - dayNumber(request.ladder.startDate)
  request.ladder.rungs.forEach((rung, i) => {
    if (rung.principal > MAX_RUNG_PRINCIPAL) {
      issues.push({
        source: 'api',
        code: 'principal_out_of_range',
        path: `rungs[${i}].principal`,
        message: 'El monto no puede superar 1.000.000.000.000 pesos.',
      })
    }
    if (rung.days > MAX_RUNG_DAYS) {
      issues.push({
        source: 'api',
        code: 'days_out_of_range',
        path: `rungs[${i}].days`,
        message: 'El plazo no puede superar 3.650 días.',
      })
    } else if (rung.days > daysToLimit) {
      issues.push({
        source: 'api',
        code: 'maturity_out_of_range',
        path: `rungs[${i}].days`,
        message: 'El vencimiento no puede ser posterior al 31 de diciembre de 9999.',
      })
    }
  })
  return issues
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
  // carries it. The range stage keeps every maturity within four-digit years, where valid ISO
  // dates compare correctly as strings, as the engine itself relies on.
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
