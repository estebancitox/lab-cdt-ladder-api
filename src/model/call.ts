import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { errorClassName } from '../error-name'
import { SYSTEM_PROMPT_V1 } from './prompt.v1'

/** The model that narrates. A change here invalidates every evaluation result of the prompt. */
export const MODEL = 'claude-sonnet-5-5'
/** SPEC §8: sized for the reply alone, which is why the call runs without up-front thinking. */
export const MAX_TOKENS = 600
/** SPEC §8: the model call, retries included, is abandoned at 20 s. */
export const MODEL_DEADLINE_MS = 20_000
/**
 * Retries serve failures that return fast: connection errors, 408, 409, 429 and 5xx. An attempt
 * may use the whole deadline, so a slow one is never cut short to gamble on a second.
 */
export const MAX_RETRIES = 2

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * SPEC §7 seen from the model call. `cause` is what the log line carries on a 503: an SDK error
 * class name, an upstream status or a stop reason, never message text.
 */
export type ModelOutcome =
  | { kind: 'ok'; text: string; usage: TokenUsage }
  | { kind: 'truncated'; cause: string; usage: TokenUsage }
  | { kind: 'unavailable'; cause: string; usage?: TokenUsage }

class DeadlineError extends Error {}

/**
 * Pinned in code rather than left to the SDK's defaults, which read ANTHROPIC_BASE_URL and
 * ANTHROPIC_LOG from the environment: a variable set on the function could otherwise send the
 * key elsewhere or make the SDK log request bodies (SPEC §8.4).
 */
export const CLIENT_OPTIONS = {
  baseURL: 'https://api.anthropic.com',
  logLevel: 'off',
} as const

let cached: { apiKey: string; client: Anthropic } | undefined

function clientFor(apiKey: string): Anthropic {
  if (cached?.apiKey !== apiKey) {
    cached = { apiKey, client: new Anthropic({ apiKey, ...CLIENT_OPTIONS }) }
  }
  return cached.client
}

/**
 * One request, one reply. On claude-sonnet-5-5 `between_tools` is the setting that turns
 * up-front thinking off (`disabled` is rejected), and a request without tools then returns only
 * text, so max_tokens bounds the reply and nothing else.
 *
 * The 20 s limit is enforced here rather than left to the SDK: its `timeout` covers one attempt
 * up to the response headers, not the retries or the body. The signal stops the request in
 * flight and wakes the SDK's backoff sleep; the race guarantees the caller gets its answer at
 * the deadline whatever the SDK does with the signal.
 */
export async function callModel(apiKey: string, userMessage: string): Promise<ModelOutcome> {
  const client = clientFor(apiKey)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DeadlineError())
    }, MODEL_DEADLINE_MS)
  })
  // Whichever promise loses the race still settles later, with nobody waiting for it.
  deadline.catch(() => {})

  let message: Anthropic.Message
  try {
    const request = client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'between_tools' },
        system: SYSTEM_PROMPT_V1,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal, timeout: MODEL_DEADLINE_MS, maxRetries: MAX_RETRIES },
    )
    request.catch(() => {})
    message = await Promise.race([request, deadline])
  } catch (error) {
    if (error instanceof DeadlineError) return { kind: 'unavailable', cause: 'deadline' }
    if (error instanceof APIError) return { kind: 'unavailable', cause: describeFailure(error) }
    // Only the SDK's transport and body parsing run inside the race. A failure there that is
    // not an APIError (undici's TypeError "terminated" when the connection drops mid-body, a
    // SyntaxError on a truncated body) is still the upstream failing, not a defect of this
    // service, and SPEC §7 gives every upstream failure the same answer.
    return { kind: 'unavailable', cause: errorClassName(error) }
  } finally {
    clearTimeout(timer)
  }

  const usage: TokenUsage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  }
  if (message.stop_reason === 'max_tokens') {
    return { kind: 'truncated', cause: 'stop_reason max_tokens', usage }
  }
  if (message.stop_reason !== 'end_turn') {
    return { kind: 'unavailable', cause: `stop_reason ${message.stop_reason}`, usage }
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (text.trim() === '') return { kind: 'unavailable', cause: 'empty_reply', usage }
  return { kind: 'ok', text, usage }
}

/**
 * Named by instanceof rather than by constructor.name, which a bundler may rename. API error
 * messages can quote the request, so the message is never part of the description.
 */
function describeFailure(error: APIError): string {
  if (error instanceof APIConnectionTimeoutError) return 'APIConnectionTimeoutError'
  if (error instanceof APIUserAbortError) return 'APIUserAbortError'
  if (error instanceof APIConnectionError) return 'APIConnectionError'
  return error.status === undefined ? 'APIError' : `status ${error.status}`
}
