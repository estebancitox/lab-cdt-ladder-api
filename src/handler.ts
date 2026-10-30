import { createHash } from 'node:crypto'
import { callDeadlineMs, retryFits } from './budget'
import { errorClassName } from './error-name'
import { buildExplanationView, type ExplanationView } from './explain'
import { ApiKeyUnavailableError, getApiKey } from './model/api-key'
import { callModel, type ModelOutcome, type TokenUsage } from './model/call'
import { buildModelPayload, renderUserMessage } from './model/payload'
import type { ExplainRequest } from './request/schema'
import { MAX_BODY_BYTES, validateRequest } from './request/validate'
import {
  explanation,
  json,
  refusal,
  serviceFailure,
  verificationFailure,
  type HttpResponse,
} from './response'
import { deriveRules, evaluate, failedRuleNames, groundTruthFrom, type GroundTruth } from './rules'

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
 * exist when the model answered, summed over both calls when a verification retry was made.
 * `failedRules` exists only when a reply failed verification (§7.4), whatever the status: one
 * entry per reply evaluated, in order, each the distinct failed rule names in §11.12 order, an
 * empty entry for a reply that passed; never a rule's argument. The cause fields name a class,
 * a status or a stop reason, never a message: `upstreamError` exists only on a 503,
 * `internalError` only on a 500.
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
  failedRules?: string[][]
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
    response = await respond(event, raw, line, () => performance.now() - startedAt)
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
  elapsedMs: () => number,
): Promise<HttpResponse> {
  // SPEC §8: the cap applies to Content-Length and to the raw body, before parsing. Either one
  // over the cap refuses. A small declared length never admits a large body, because
  // validateRequest measures the bytes itself.
  const declared = declaredLength(event?.headers)
  if (declared !== null && declared > MAX_BODY_BYTES) return refusal(413, 'payload_too_large')

  let request: ExplainRequest
  let view: ExplanationView
  let truth: GroundTruth
  let rules: string[]
  try {
    const outcome = validateRequest(raw)
    if (!outcome.ok) return json(outcome.status, outcome.body)
    request = outcome.request
    line.rungCount = request.ladder.rungs.length
    line.entityCount = request.ladder.entities.length
    view = buildExplanationView(request)
    // SPEC §8.6: A, D, S, the entity names and the derived set are built before the first
    // model call, outside the verification window.
    truth = groundTruthFrom(request, view)
    rules = deriveRules(view)
  } catch (error) {
    // A guard. The engine refuses by RangeError what it cannot represent in pesos or as a date;
    // since the §8.5 maturity limit, no validated input is known to reach it. If one does, the
    // input is the cause: 400.
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

  // SPEC §7.4: a reply, a call that ended its turn with non-blank text, is verified before a
  // 200; any other outcome keeps its 503 row unverified. A reply that fails is retried once when
  // B minus the elapsed time leaves at least R; that elapsed time also sets the retry's deadline.
  const first = await callModel(apiKey, userMessage, callDeadlineMs(elapsedMs()))
  addUsage(line, first.usage)
  if (first.kind !== 'ok') return upstreamFailure(line, first)
  const firstFailed = failedRuleNames(evaluate(first.text, truth, rules))
  if (firstFailed.length === 0) return explanation(first.text)
  line.failedRules = [firstFailed]
  const elapsed = elapsedMs()
  if (!retryFits(elapsed)) return verificationFailure(firstFailed)

  const retry = await callModel(apiKey, userMessage, callDeadlineMs(elapsed))
  addUsage(line, retry.usage)
  if (retry.kind !== 'ok') return upstreamFailure(line, retry)
  const retryFailed = failedRuleNames(evaluate(retry.text, truth, rules))
  line.failedRules.push(retryFailed)
  return retryFailed.length === 0 ? explanation(retry.text) : verificationFailure(retryFailed)
}

/** SPEC §8.4: the token fields are the spend, so a second call adds to the first. */
function addUsage(line: LogLine, usage: TokenUsage | undefined): void {
  if (usage === undefined) return
  line.inputTokens = (line.inputTokens ?? 0) + usage.inputTokens
  line.outputTokens = (line.outputTokens ?? 0) + usage.outputTokens
}

/** SPEC §7: a call that failed as upstream keeps the 503 row of its own outcome. */
function upstreamFailure(
  line: LogLine,
  outcome: Exclude<ModelOutcome, { kind: 'ok' }>,
): HttpResponse {
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
