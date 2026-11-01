import { ERROR_MESSAGE, type ErrorCode, type Issue } from './request/errors'

/**
 * Fixed string of SPEC §7 for every response that is not the caller's fault: the model call
 * produced no usable reply, or the service itself failed. Byte-exact against the SPEC:
 * handler.test.ts compares it to the line parsed out of SPEC.md rather than to a retyped copy.
 */
export const UPSTREAM_MESSAGE =
  'No puedo explicar esta escalera en este momento: el servicio no está disponible.'

/**
 * Fixed string of SPEC §7 for a 429: a §8.2 daily cap refused the request before the key read and
 * the model call. Byte-exact against the SPEC, checked the same way.
 */
export const LIMIT_MESSAGE =
  'No puedo explicar esta escalera por ahora: se alcanzó el límite diario de solicitudes.'

/** SPEC §7: the codes that exist only once validation has passed. */
export type ServiceCode = 'upstream_unavailable' | 'upstream_truncated' | 'internal_error'

/** SPEC §7: the two 429 codes, one per §8.2 cap. */
export type LimitCode = 'ip_limit_reached' | 'daily_limit_reached'

/** SPEC §7.4: a verification issue names a rule, the part before its first colon, and no more. */
export interface VerificationIssue {
  source: 'verification'
  rule: string
}

/** What a Lambda Function URL expects back (payload format 2.0). */
export interface HttpResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

export function json(statusCode: number, body: unknown): HttpResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The explanation names the reader's banks and amounts: no cache may keep it.
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

/** SPEC §7.1 success shape: the explanation and nothing else. */
export function explanation(text: string): HttpResponse {
  return json(200, { text })
}

/** A 413 or 400 the handler decides itself, in the shape validateRequest gives its own. */
export function refusal(statusCode: 413 | 400, code: ErrorCode): HttpResponse {
  const issues: Issue[] = []
  return json(statusCode, { text: ERROR_MESSAGE, error: { code, issues } })
}

/**
 * SPEC §7: 429 when a §8.2 cap refused the request, with `retry-after` in whole seconds until the
 * next 00:00 UTC, when both counters start again. The platform's own 429, for a throttled
 * Function URL, carries no such body, so a client reads `error.code`, not the status alone.
 */
export function limitReached(limit: 'ip' | 'daily', retryAfterSeconds: number): HttpResponse {
  const issues: Issue[] = []
  const code: LimitCode = limit === 'ip' ? 'ip_limit_reached' : 'daily_limit_reached'
  const response = json(429, { text: LIMIT_MESSAGE, error: { code, issues } })
  response.headers['retry-after'] = String(retryAfterSeconds)
  return response
}

/** SPEC §7: 503 when the model call gave no usable reply, 500 for a defect in the service. */
export function serviceFailure(code: ServiceCode): HttpResponse {
  const issues: Issue[] = []
  return json(code === 'internal_error' ? 500 : 503, {
    text: UPSTREAM_MESSAGE,
    error: { code, issues },
  })
}

/**
 * SPEC §7.4: 502 when the reply last evaluated failed verification and no retry remains. One
 * issue per distinct failed rule name, in the order given, which is the §11.12 row order.
 */
export function verificationFailure(ruleNames: readonly string[]): HttpResponse {
  const issues: VerificationIssue[] = ruleNames.map((rule) => ({ source: 'verification', rule }))
  return json(502, { text: UPSTREAM_MESSAGE, error: { code: 'verification_failed', issues } })
}
