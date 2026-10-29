import { buildExplanationView } from '../explain'
import { handler as realHandler, type FunctionUrlEvent, type LambdaContext } from '../handler'
import { MODEL } from '../model/call'
import { PROMPT_VERSION } from '../model/prompt.v1'
import { validateRequest } from '../request/validate'
import type { HttpResponse } from '../response'
import { evaluate, evaluateRefusal, groundTruthFrom, type Verdict } from '../rules'
import type { FetchCounter } from './fetch-counter'

/** A case of evals/cases.json as the runner reads it. */
export interface EvalCase {
  id: string
  description: string
  input: unknown
  rules: string[]
  expectIssues?: unknown[]
}

/**
 * Claude Sonnet 5.5, base price per million tokens, in USD. Source:
 * https://platform.claude.com/docs/en/about-claude/pricing, read on 2026-10-03. The run uses
 * no prompt cache, so these two rates are the whole price of a call.
 */
export const PRICE_USD_PER_MTOK = { input: 2, output: 10 } as const

export function costUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * PRICE_USD_PER_MTOK.input + outputTokens * PRICE_USD_PER_MTOK.output) / 1e6
}

export interface RunRecord {
  caseId: string
  position: number
  run: number
  status: number
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  costUsd: number | null
  /**
   * SPEC §8.4, from the handler's log line: the distinct failed rule names of each reply
   * evaluated, [] when no reply failed verification, null when no line was captured. Absent
   * from runs recorded before 4B-code.
   */
  failedRules?: string[][] | null
  /**
   * SPEC §8.6: whether a verification retry was made, from the same line, so the runs answered
   * 200 without one can be selected; null when no line was captured.
   */
  verificationRetry?: boolean | null
  /** The reply, or the refusal body's text; null when the body had none. */
  text: string | null
  verdicts: Verdict[]
}

export interface SuiteResult {
  model: string
  promptVersion: string
  priceUsdPerMtok: { input: number; output: number }
  startedAt: string
  runs: RunRecord[]
}

/** The model-call count disagrees with what the handler reported: the measurement is void. */
export class CountingError extends Error {}

export interface SuiteOptions {
  /** Runs per valid case. Invalid cases run once. */
  runs: number
  counter: FetchCounter
  startedAt: string
  invoke?: (event: FunctionUrlEvent, context: LambdaContext) => Promise<HttpResponse>
  onRun?: (record: RunRecord) => void
}

/**
 * Invokes the handler in process once per run, counts the model calls, captures the handler's
 * own log line for tokens and latency, and evaluates the SPEC §11 rules of the case on the
 * response. Each valid case runs `runs` times, each invalid case once.
 */
export async function runSuite(
  cases: readonly EvalCase[],
  options: SuiteOptions,
): Promise<SuiteResult> {
  const invoke = options.invoke ?? realHandler
  const runs: RunRecord[] = []
  for (const [i, c] of cases.entries()) {
    const invalid = c.rules.includes('error_message_exact')
    const times = invalid ? 1 : options.runs
    for (let run = 1; run <= times; run += 1) {
      const body = JSON.stringify(c.input)
      const event: FunctionUrlEvent = {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
        isBase64Encoded: false,
      }
      const before = options.counter.calls
      const { response, line } = await captureLogLine(() =>
        invoke(event, { awsRequestId: `${c.id}#${run}` }),
      )
      const calls = options.counter.calls - before
      const parsed = parseBody(response.body)
      const text = typeof parsed?.text === 'string' ? parsed.text : null
      const tokens = tokensOf(line)
      checkCounting(c.id, run, response.statusCode, calls, tokens)
      const verdicts = invalid
        ? evaluateRefusal(response.statusCode, parsed, calls, c.rules)
        : response.statusCode === 200 && text !== null
          ? evaluate(text, groundTruth(c), c.rules)
          : c.rules.map((rule) => ({
              rule,
              pass: false,
              evidence: `status ${response.statusCode}`,
            }))
      const record: RunRecord = {
        caseId: c.id,
        position: i + 1,
        run,
        status: response.statusCode,
        calls,
        inputTokens: tokens?.input ?? null,
        outputTokens: tokens?.output ?? null,
        latencyMs: typeof line?.latencyMs === 'number' ? line.latencyMs : null,
        costUsd: tokens ? costUsd(tokens.input, tokens.output) : null,
        ...verificationOf(line, response.statusCode),
        text,
        verdicts,
      }
      runs.push(record)
      options.onRun?.(record)
    }
  }
  return {
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    priceUsdPerMtok: { ...PRICE_USD_PER_MTOK },
    startedAt: options.startedAt,
    runs,
  }
}

/** Ground truth for a case, through the same pipeline the handler runs (SPEC §10). */
export function groundTruth(c: EvalCase) {
  const outcome = validateRequest(JSON.stringify(c.input))
  if (!outcome.ok)
    throw new Error(`${c.id}: the pipeline refused a valid case at stage ${outcome.stage}`)
  return groundTruthFrom(outcome.request, buildExplanationView(outcome.request))
}

function checkCounting(
  caseId: string,
  run: number,
  status: number,
  calls: number,
  tokens: { input: number; output: number } | null,
): void {
  const where = `${caseId} run ${run}`
  if ((status === 400 || status === 413) && calls !== 0) {
    throw new CountingError(`${where}: status ${status} with ${calls} model call(s)`)
  }
  if (tokens !== null && calls === 0) {
    throw new CountingError(`${where}: the log line carries tokens but no model call was counted`)
  }
  if (status === 200 && tokens === null) {
    throw new CountingError(`${where}: status 200 without a token count in the log line`)
  }
}

/** Runs the invocation while capturing the handler's JSON log line from stdout. */
async function captureLogLine(
  invoke: () => Promise<HttpResponse>,
): Promise<{ response: HttpResponse; line: Record<string, unknown> | null }> {
  const original = process.stdout.write.bind(process.stdout)
  let line: Record<string, unknown> | null = null
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk)
    if (text.startsWith('{"requestId"')) {
      line = JSON.parse(text) as Record<string, unknown>
      return true
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  try {
    const response = await invoke()
    return { response, line }
  } finally {
    process.stdout.write = original
  }
}

function parseBody(body: string): { text?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' ? (parsed as { text?: unknown }) : null
  } catch {
    return null
  }
}

/**
 * The line carries `failedRules` only when a reply failed verification, one entry per reply
 * evaluated. Two entries mean a retry was made. One entry means one was made unless the request
 * ended in 502: a retry that failed upstream, or threw, leaves no reply to evaluate, so its 503
 * or 500 carries one entry too, as a 502 without a retry does.
 */
function verificationOf(
  line: Record<string, unknown> | null,
  status: number,
): { failedRules: string[][] | null; verificationRetry: boolean | null } {
  if (!line) return { failedRules: null, verificationRetry: null }
  const entries = Array.isArray(line.failedRules) ? (line.failedRules as string[][]) : []
  const retried = entries.length === 2 || (entries.length === 1 && status !== 502)
  return { failedRules: entries, verificationRetry: retried }
}

function tokensOf(line: Record<string, unknown> | null): { input: number; output: number } | null {
  if (!line || typeof line.inputTokens !== 'number' || typeof line.outputTokens !== 'number')
    return null
  return { input: line.inputTokens, output: line.outputTokens }
}
