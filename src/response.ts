import { ERROR_MESSAGE, type ErrorCode, type Issue } from './request/errors'

/**
 * Fixed string of SPEC §7 for every response that is not the caller's fault: the model call
 * produced no usable reply, or the service itself failed. Byte-exact against the SPEC:
 * handler.test.ts compares it to the line parsed out of SPEC.md rather than to a retyped copy.
 */
export const UPSTREAM_MESSAGE =
  'No puedo explicar esta escalera en este momento: el servicio no está disponible.'

/** SPEC §7: the codes that exist only once validation has passed. */
export type ServiceCode = 'upstream_unavailable' | 'upstream_truncated' | 'internal_error'

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

/** SPEC §7: 503 when the model call gave no usable reply, 500 for a defect in the service. */
export function serviceFailure(code: ServiceCode): HttpResponse {
  const issues: Issue[] = []
  return json(code === 'internal_error' ? 500 : 503, {
    text: UPSTREAM_MESSAGE,
    error: { code, issues },
  })
}
