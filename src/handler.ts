import { createHash } from 'node:crypto'
import { errorClassName } from './error-name'
import { buildExplanationView, type ExplanationView } from './explain'
import { ApiKeyUnavailableError, getApiKey } from './model/api-key'
import { callModel } from './model/call'
import { buildModelPayload, renderUserMessage } from './model/payload'
import type { ExplainRequest } from './request/schema'
import { MAX_BODY_BYTES, validateRequest } from './request/validate'
import { explanation, json, refusal, serviceFailure, type HttpResponse } from './response'

/** The fields of a Lambda Function URL event (payload format 2.0) this handler reads. */
export interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>
  body?: string | null
  isBase64Encoded?: boolean
}

/** The one field of the Lambda context this handler reads. */
export interface LambdaContext {
  awsRequestId?: string
}

/**
 * SPEC §8.4: one line per request, and nothing the request or the reply contains. `requestId`
 * is the invocation's id, so the line can be joined to the runtime's own START and REPORT
 * records. The counts are known only once the pipeline has accepted the body. Token counts
 * exist when the model answered. The cause fields name a class, a status or a stop reason,
 * never a message: `upstreamError` exists only on a 503, `internalError` only on a 500.
 */
interface LogLine {
  requestId: string | null
  bodyHash: string
  bodyBytes: number
  rungCount: number | null
  entityCount: number | null
  status: number
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  upstreamError?: string
  internalError?: string
}

export async function handler(
  event: FunctionUrlEvent | null | undefined,
  context?: LambdaContext | null,
): Promise<HttpResponse> {
  const startedAt = performance.now()
  const raw = rawBody(event)
  const line: LogLine = {
    requestId: typeof context?.awsRequestId === 'string' ? context.awsRequestId : null,
    bodyHash: createHash('sha256').update(raw).digest('hex'),
    bodyBytes: raw.byteLength,
    rungCount: null,
    entityCount: null,
    status: 500,
    latencyMs: 0,
  }
  let response: HttpResponse
  try {
    response = await respond(event, raw, line)
  } catch (error) {
    // SPEC §7: a defect in this service. Only the class of the error is logged: its message
    // can carry request data (SPEC §8.4).
    line.internalError = errorClassName(error)
    response = serviceFailure('internal_error')
  }
  line.status = response.statusCode
  line.latencyMs = Math.round(performance.now() - startedAt)
  // Written raw so the log event is exactly this JSON, without the runtime's console prefix.
  process.stdout.write(JSON.stringify(line) + '\n')
  return response
}

async function respond(
  event: FunctionUrlEvent | null | undefined,
  raw: Buffer,
  line: LogLine,
): Promise<HttpResponse> {
  // SPEC §8: the cap applies to Content-Length and to the raw body, before parsing. Either one
  // over the cap refuses. A small declared length never admits a large body, because
  // validateRequest measures the bytes itself.
  const declared = declaredLength(event?.headers)
  if (declared !== null && declared > MAX_BODY_BYTES) return refusal(413, 'payload_too_large')

  let request: ExplainRequest
  let view: ExplanationView
  try {
    const outcome = validateRequest(raw)
    if (!outcome.ok) return json(outcome.status, outcome.body)
    request = outcome.request
    line.rungCount = request.ladder.rungs.length
    line.entityCount = request.ladder.entities.length
    view = buildExplanationView(request)
  } catch (error) {
    // The engine refuses by RangeError what it cannot represent in pesos or as a date, and
    // validateScenario does not reject every such ladder first. The input is the cause: 400.
    if (error instanceof RangeError) return refusal(400, 'invalid_input')
    throw error
  }
  const userMessage = renderUserMessage(buildModelPayload(request, view))

  let apiKey: string
  try {
    apiKey = await getApiKey()
  } catch (error) {
    if (!(error instanceof ApiKeyUnavailableError)) throw error
    line.upstreamError = `ssm ${error.causeName}`
    return serviceFailure('upstream_unavailable')
  }

  const outcome = await callModel(apiKey, userMessage)
  if (outcome.usage !== undefined) {
    line.inputTokens = outcome.usage.inputTokens
    line.outputTokens = outcome.usage.outputTokens
  }
  if (outcome.kind === 'ok') return explanation(outcome.text)
  line.upstreamError = outcome.cause
  return serviceFailure(
    outcome.kind === 'truncated' ? 'upstream_truncated' : 'upstream_unavailable',
  )
}

/**
 * The body as the bytes the client sent: base64 when the platform flags it, UTF-8 otherwise. A
 * missing event (a direct invocation with a null payload) is an empty body, so it still gets
 * its log line.
 */
function rawBody(event: FunctionUrlEvent | null | undefined): Buffer {
  const body = typeof event?.body === 'string' ? event.body : ''
  return Buffer.from(body, event?.isBase64Encoded === true ? 'base64' : 'utf8')
}

/** The Content-Length the client declared, when it is a plain non-negative integer. */
function declaredLength(headers: FunctionUrlEvent['headers']): number | null {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === 'content-length' && value !== undefined && /^\d+$/.test(value)) {
      return Number(value)
    }
  }
  return null
}
