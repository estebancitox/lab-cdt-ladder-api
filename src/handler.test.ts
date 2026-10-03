import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDays, validateScenario, type ScenarioInput } from './engine'
import { buildExplanationView } from './explain'
import type { FunctionUrlEvent } from './handler'
import { KEY_FETCH_TIMEOUT_MS } from './model/api-key'
import { CLIENT_OPTIONS, MAX_RETRIES, MAX_TOKENS, MODEL, MODEL_DEADLINE_MS } from './model/call'
import { buildModelPayload } from './model/payload'
import { SYSTEM_PROMPT_V1 } from './model/prompt.v1'
import { ERROR_MESSAGE } from './request/errors'
import { MAX_BODY_BYTES, validateRequest } from './request/validate'
import { UPSTREAM_MESSAGE } from './response'
import {
  SPEC_MD,
  VALID_CASES,
  acceptedRequest,
  bodyOf,
  caseById,
  inputOf,
  type RawRequest,
} from './test-support/contract'

/**
 * The handler against every row of the SPEC §7 table, with the Anthropic SDK and the SSM client
 * mocked: no test here reaches the network. The SDK's error classes stay the real ones, so the
 * handler's instanceof checks are exercised as they run in production.
 */
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  anthropicOptions: vi.fn(),
  send: vi.fn(),
  ssmOptions: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  class FakeAnthropic {
    messages = { create: mocks.create }
    constructor(options: unknown) {
      mocks.anthropicOptions(options)
    }
  }
  return { ...actual, default: FakeAnthropic }
})

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = mocks.send
    constructor(options: unknown) {
      mocks.ssmOptions(options)
    }
  },
  GetParameterCommand: class {
    constructor(readonly input: unknown) {}
  },
}))

const PARAMETER = '/lab-cdt-ladder-api/anthropic-api-key'
const REPLY =
  'Qué pasa y cuándo\n\nTu escalera tiene 3 peldaños.\n\nRiesgos\n\nSin riesgos para señalar con estos datos.'
const USAGE = { input_tokens: 1742, output_tokens: 251 }

let handler: typeof import('./handler').handler
let sdk: typeof import('@anthropic-ai/sdk')
let written: string[]

beforeEach(async () => {
  // A fresh module graph per test: the key and the client are cached per container.
  vi.resetModules()
  sdk = await import('@anthropic-ai/sdk')
  ;({ handler } = await import('./handler'))
  mocks.create.mockReset()
  mocks.anthropicOptions.mockReset()
  mocks.send.mockReset()
  mocks.ssmOptions.mockReset()
  mocks.send.mockResolvedValue({ Parameter: { Value: 'test-key' } })
  vi.stubEnv('API_KEY_PARAMETER', PARAMETER)
  written = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

/** A Function URL event carrying a text body, as the platform delivers application/json. */
function post(body: string, contentLength?: string | null): FunctionUrlEvent {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (contentLength !== null) {
    headers['content-length'] = contentLength ?? String(Buffer.byteLength(body))
  }
  return { headers, body, isBase64Encoded: false }
}

/** The same request as the platform delivers it when it treats the body as binary. */
function postBase64(bytes: Buffer, contentLength?: string | null): FunctionUrlEvent {
  const headers: Record<string, string> = {}
  if (contentLength !== null) headers['content-length'] = contentLength ?? String(bytes.byteLength)
  return { headers, body: bytes.toString('base64'), isBase64Encoded: true }
}

function reply(text: string, stopReason = 'end_turn', usage = USAGE) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: text === '' ? [] : [{ type: 'text', text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  }
}

function statusError(status: number, type: string, message: string) {
  const body = { type: 'error', error: { type, message } }
  return sdk.APIError.generate(status, body, undefined, new Headers())
}

/** A 200 the SDK parsed but the handler cannot read: the 500 path, outside the model call. */
function unreadable(thrown: unknown) {
  const message = reply(REPLY)
  Object.defineProperty(message, 'usage', {
    get() {
      throw thrown
    },
  })
  return message
}

/** The one line the request logged. Anything else written to stdout fails the test. */
function logLine(): Record<string, unknown> {
  expect(written).toHaveLength(1)
  expect(written[0].endsWith('\n')).toBe(true)
  return JSON.parse(written[0]) as Record<string, unknown>
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function expectNoModelCall() {
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.anthropicOptions).not.toHaveBeenCalled()
  expect(mocks.create).not.toHaveBeenCalled()
}

/** Byte for byte against the string parsed out of SPEC.md, not against a retyped copy. */
function expectBytes(text: unknown, specName: 'ERROR_MESSAGE' | 'UPSTREAM_MESSAGE') {
  const line = new RegExp(`^${specName}\\s+(.+)$`, 'm').exec(SPEC_MD)
  if (!line) throw new Error(`${specName} line not found in SPEC.md`)
  expect(typeof text).toBe('string')
  expect(Buffer.from(text as string, 'utf8').equals(Buffer.from(line[1], 'utf8'))).toBe(true)
}

const BASE_KEYS = [
  'requestId',
  'bodyHash',
  'bodyBytes',
  'rungCount',
  'entityCount',
  'status',
  'latencyMs',
]
const TOKEN_KEYS = ['inputTokens', 'outputTokens']
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const CASE_1 = bodyOf(caseById('healthy-3-rung'))

/** The log line has the base fields, the token fields when the model answered, and `extra`. */
function expectKeys(line: Record<string, unknown>, ...extra: string[]) {
  const tokens = 'inputTokens' in line ? TOKEN_KEYS : []
  expect(Object.keys(line)).toEqual([...BASE_KEYS, ...tokens, ...extra])
}

describe('the SPEC §7 table is the list of rows this file covers', () => {
  it('has exactly these rows, each with a describe block below', () => {
    const table = /\| Condition \| Status \|[^\n]*\n\|[-| ]+\n((?:\|[^\n]*\n)+)/.exec(SPEC_MD)
    if (!table) throw new Error('SPEC §7 table not found')
    const rows = table[1]
      .trim()
      .split('\n')
      .map((row) => row.split('|').map((cell) => cell.trim().replace(/`/g, '')))
      .map(([, condition, status, text, code]) => [condition, Number(status), text, code])
    expect(rows).toEqual([
      ['Body over the byte cap', 413, 'ERROR_MESSAGE', 'payload_too_large'],
      ['Schema violation', 400, 'ERROR_MESSAGE', 'invalid_input'],
      ['Engine validation failure', 400, 'ERROR_MESSAGE', 'invalid_input'],
      ['asOfDate invalid or after the last maturity', 400, 'ERROR_MESSAGE', 'invalid_input'],
      [
        'Model unavailable, overloaded or timed out',
        503,
        'UPSTREAM_MESSAGE',
        'upstream_unavailable',
      ],
      ['Model response truncated at max_tokens', 503, 'UPSTREAM_MESSAGE', 'upstream_truncated'],
      ['Unexpected internal error', 500, 'UPSTREAM_MESSAGE', 'internal_error'],
    ])
  })

  it('UPSTREAM_MESSAGE equals the SPEC §7 fixed string byte for byte', () => {
    expectBytes(UPSTREAM_MESSAGE, 'UPSTREAM_MESSAGE')
  })
})

describe('200: the explanation (SPEC §7.1)', () => {
  it('returns { text } with the reply exactly as the model wrote it, and nothing else', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    const response = await handler(post(CASE_1))
    expect(response.statusCode).toBe(200)
    expect(response.headers).toEqual(HEADERS)
    expect(JSON.parse(response.body)).toEqual({ text: REPLY })
  })

  it('sends one request: the model, max_tokens 600, thinking off, prompt v1, the payload as JSON', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    await handler(post(CASE_1))
    expect(mocks.create).toHaveBeenCalledTimes(1)
    const [params, options] = mocks.create.mock.calls[0]
    const request = acceptedRequest(caseById('healthy-3-rung').input)
    const payload = buildModelPayload(request, buildExplanationView(request))
    // toEqual: no other key is sent. No tools, no sampling parameter, no beta, no fallback.
    expect([MODEL, MAX_TOKENS, MAX_RETRIES]).toEqual(['claude-sonnet-5-5', 600, 2])
    expect(params).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 600,
      thinking: { type: 'between_tools' },
      system: SYSTEM_PROMPT_V1,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    })
    expect(Object.keys(options).sort()).toEqual(['maxRetries', 'signal', 'timeout'])
    expect(options).toMatchObject({ timeout: 20_000, maxRetries: 2 })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.signal.aborted).toBe(false)
  })

  it('every response carries the content type and cache-control: no-store', async () => {
    mocks.create.mockResolvedValue(reply(REPLY, 'max_tokens'))
    expect((await handler(post(CASE_1))).headers).toEqual(HEADERS)
    expect((await handler(post('{not json'))).headers).toEqual(HEADERS)
    expect((await handler(post(CASE_1, String(MAX_BODY_BYTES + 1)))).headers).toEqual(HEADERS)
  })

  it('the time budget: the key read and the model call fit inside the Lambda timeout', () => {
    const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8')
    const timeout = /^\s+Timeout: (\d+)$/m.exec(template)
    if (!timeout) throw new Error('Timeout not found in template.yaml')
    expect(Number(timeout[1])).toBe(25)
    expect(MODEL_DEADLINE_MS).toBe(20_000)
    expect(KEY_FETCH_TIMEOUT_MS).toBe(3_000)
    expect(KEY_FETCH_TIMEOUT_MS + MODEL_DEADLINE_MS).toBeLessThan(Number(timeout[1]) * 1000)
  })

  it.each([...VALID_CASES])('$id is explained', async (c) => {
    mocks.create.mockResolvedValue(reply(REPLY))
    const response = await handler(post(bodyOf(c)))
    expect(response.statusCode).toBe(200)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('decodes a base64 body before measuring, hashing and validating it', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    const bytes = Buffer.from(CASE_1, 'utf8')
    const response = await handler(postBase64(bytes))
    expect(response.statusCode).toBe(200)
    expect(logLine()).toMatchObject({ bodyHash: sha256(bytes), bodyBytes: bytes.byteLength })
  })
})

describe('the API key (SSM SecureString, once per container)', () => {
  it('is read from the parameter named by the environment, decrypted, and only once', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    await handler(post(CASE_1))
    await handler(post(CASE_1))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][0].input).toEqual({ Name: PARAMETER, WithDecryption: true })
    expect(mocks.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal)
    expect(mocks.ssmOptions).toHaveBeenCalledTimes(1)
    expect(mocks.ssmOptions).toHaveBeenCalledWith({ maxAttempts: 2 })
    expect(mocks.anthropicOptions).toHaveBeenCalledTimes(1)
    // The transport is pinned in code: no environment variable can move the key or turn on
    // the SDK's request logging.
    expect(CLIENT_OPTIONS).toEqual({ baseURL: 'https://api.anthropic.com', logLevel: 'off' })
    expect(mocks.anthropicOptions).toHaveBeenCalledWith({ apiKey: 'test-key', ...CLIENT_OPTIONS })
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })

  it('is not kept when the read fails: the next request reads again', async () => {
    mocks.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }))
    mocks.create.mockResolvedValue(reply(REPLY))
    expect((await handler(post(CASE_1))).statusCode).toBe(503)
    expect((await handler(post(CASE_1))).statusCode).toBe(200)
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })

  it('never appears in a response or in the log', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    const response = await handler(post(CASE_1))
    expect(response.body).not.toContain('test-key')
    expect(written.join('')).not.toContain('test-key')
  })
})

describe('row 1: body over the byte cap → 413 payload_too_large', () => {
  const padded = (bytes: number) => CASE_1 + ' '.repeat(bytes - Buffer.byteLength(CASE_1))

  async function expectTooLarge(event: FunctionUrlEvent) {
    const response = await handler(event)
    expect(response.statusCode).toBe(413)
    const body = JSON.parse(response.body)
    expectBytes(body.text, 'ERROR_MESSAGE')
    expect(body.error).toEqual({ code: 'payload_too_large', issues: [] })
    expectNoModelCall()
    expectKeys(logLine())
  }

  it('by Content-Length alone, even when the body itself is small and valid', async () => {
    await expectTooLarge(post(CASE_1, String(MAX_BODY_BYTES + 1)))
  })

  it('by the measured bytes when no Content-Length is declared', async () => {
    await expectTooLarge(post(padded(MAX_BODY_BYTES + 1), null))
  })

  it('by the measured bytes when Content-Length declares less: the header cannot admit', async () => {
    await expectTooLarge(post(padded(MAX_BODY_BYTES + 1), '100'))
  })

  it('by the decoded bytes of a base64 body, not by its encoded length', async () => {
    const atCap = Buffer.from(padded(MAX_BODY_BYTES), 'utf8')
    const overCap = Buffer.from(padded(MAX_BODY_BYTES + 1), 'utf8')
    // The two encode to the same number of base64 characters: only decoding can tell them apart.
    expect(overCap.toString('base64')).toHaveLength(atCap.toString('base64').length)
    await expectTooLarge(postBase64(overCap, null))
  })

  it('reads the header whatever its letter case', async () => {
    const event = post(CASE_1, null)
    event.headers = { ...event.headers, 'Content-Length': String(MAX_BODY_BYTES + 1) }
    await expectTooLarge(event)
  })

  it('accepts exactly 8192 bytes, as text and as base64, and logs the measured size', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    const exact = padded(MAX_BODY_BYTES)
    expect((await handler(post(exact))).statusCode).toBe(200)
    expect(logLine()).toMatchObject({ bodyBytes: MAX_BODY_BYTES, bodyHash: sha256(exact) })
    written = []
    expect((await handler(postBase64(Buffer.from(exact, 'utf8')))).statusCode).toBe(200)
    expect(logLine()).toMatchObject({ bodyBytes: MAX_BODY_BYTES, bodyHash: sha256(exact) })
  })

  it('ignores a Content-Length that is not a plain integer and decides on the bytes', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    for (const value of ['', 'abc', '-1', '1e9', '487, 487']) {
      written = []
      expect((await handler(post(CASE_1, value))).statusCode, value).toBe(200)
    }
  })

  it('an unreadable Content-Length does not excuse an oversized body', async () => {
    await expectTooLarge(post(padded(MAX_BODY_BYTES + 1), 'abc'))
  })

  it('logs the measured size, not the declared one', async () => {
    await handler(post(CASE_1, String(MAX_BODY_BYTES + 1)))
    expect(logLine()).toMatchObject({
      bodyBytes: Buffer.byteLength(CASE_1),
      bodyHash: sha256(CASE_1),
      status: 413,
    })
  })
})

describe('rows 2 to 4: every 400 is ERROR_MESSAGE, invalid_input, and no model call', () => {
  async function expectInvalid(event: FunctionUrlEvent) {
    const response = await handler(event)
    expect(response.statusCode).toBe(400)
    const body = JSON.parse(response.body)
    expectBytes(body.text, 'ERROR_MESSAGE')
    expect(body.text).toBe(ERROR_MESSAGE)
    expect(body.error.code).toBe('invalid_input')
    expectNoModelCall()
    const line = logLine()
    // No token field: the log line itself shows the model was not called.
    expectKeys(line)
    return { body, line }
  }

  it('row 2, schema violation: case 8 (missing-required-field)', async () => {
    const { body, line } = await expectInvalid(post(bodyOf(caseById('missing-required-field'))))
    expect(body.error.issues).toEqual([
      { source: 'schema', keyword: 'required', path: '/ladder/rungs/0/ea' },
    ])
    expect(line).toMatchObject({ rungCount: null, entityCount: null, status: 400 })
  })

  it('row 3, engine validation failure: case 9 (negative-amount), issues verbatim', async () => {
    const c = caseById('negative-amount')
    const { body } = await expectInvalid(post(bodyOf(c)))
    const fromEngine = validateScenario((c.input as RawRequest).ladder as unknown as ScenarioInput)
    expect(fromEngine.length).toBeGreaterThan(0)
    expect(body.error.issues).toEqual(fromEngine.map((issue) => ({ source: 'engine', ...issue })))
  })

  it('row 4, asOfDate that is not a calendar date', async () => {
    const input = inputOf('healthy-3-rung')
    input.asOfDate = '2027-02-29'
    const { body } = await expectInvalid(post(JSON.stringify(input)))
    expect(body.error.issues.map((i: { code: string }) => i.code)).toEqual(['as_of_date_invalid'])
  })

  it('row 4, asOfDate one day after the last maturity', async () => {
    const input = inputOf('healthy-3-rung')
    const longestTerm = Math.max(...input.ladder.rungs.map((rung) => rung.days))
    input.asOfDate = addDays(input.ladder.startDate, longestTerm + 1)
    const { body } = await expectInvalid(post(JSON.stringify(input)))
    expect(body.error.issues.map((i: { code: string }) => i.code)).toEqual([
      'as_of_date_after_last_maturity',
    ])
  })

  it('a body that is not JSON, a request with no body, and an invocation with no event', async () => {
    const notJson = await expectInvalid(post('{not json'))
    expect(notJson.body.error.issues[0].code).toBe('invalid_json')
    written = []
    const noBody = await expectInvalid({ headers: {} })
    expect(noBody.body.error.issues[0].code).toBe('invalid_json')
    expect(noBody.line).toMatchObject({ bodyBytes: 0, bodyHash: sha256('') })
    // A direct invocation with a null payload: not a request, but it still gets its line.
    written = []
    const noEvent = await expectInvalid(null as unknown as FunctionUrlEvent)
    expect(noEvent.line).toMatchObject({ bodyBytes: 0, requestId: null })
  })

  it('a ladder the engine cannot compute, thrown from inside validateRequest', async () => {
    const input = inputOf('single-rung-injected-name')
    Object.assign(input.ladder.rungs[0], { principal: Number.MAX_SAFE_INTEGER, ea: 1, days: 361 })
    const raw = JSON.stringify(input)
    expect(() => validateRequest(raw)).toThrow(RangeError)
    const { body } = await expectInvalid(post(raw))
    expect(body.error.issues).toEqual([])
  })

  it('a ladder the engine cannot date, thrown while the view is built', async () => {
    const input = inputOf('healthy-3-rung')
    Object.assign(input.ladder.rungs[1], { ea: 0, days: 3_000_000 })
    const raw = JSON.stringify(input)
    const outcome = validateRequest(raw)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(() => buildExplanationView(outcome.request)).toThrow(RangeError)
    const { body, line } = await expectInvalid(post(raw))
    expect(body.error.issues).toEqual([])
    expect(line).toMatchObject({ rungCount: 3, entityCount: 3 })
  })
})

describe('row 5: model unavailable, overloaded or timed out → 503 upstream_unavailable', () => {
  async function expectUnavailable(event: FunctionUrlEvent, upstreamError: string) {
    const response = await handler(event)
    expect(response.statusCode).toBe(503)
    const body = JSON.parse(response.body)
    expectBytes(body.text, 'UPSTREAM_MESSAGE')
    expect(body).toEqual({
      text: UPSTREAM_MESSAGE,
      error: { code: 'upstream_unavailable', issues: [] },
    })
    const line = logLine()
    expect(line).toMatchObject({ status: 503, upstreamError })
    expectKeys(line, 'upstreamError')
    return line
  }

  // Every message carries a marker: the log may name the class or the status, never the text.
  const failures: [string, () => unknown, string][] = [
    [
      'overloaded (529)',
      () => statusError(529, 'overloaded_error', 'MARKER overloaded'),
      'status 529',
    ],
    ['unavailable (500)', () => statusError(500, 'api_error', 'MARKER internal'), 'status 500'],
    [
      'rate limited (429)',
      () => statusError(429, 'rate_limit_error', 'MARKER slow down'),
      'status 429',
    ],
    [
      'a rejected key (401)',
      () => statusError(401, 'authentication_error', 'MARKER x-api-key'),
      'status 401',
    ],
    [
      'an unknown model (404)',
      () => statusError(404, 'not_found_error', 'MARKER model: x'),
      'status 404',
    ],
    [
      'a rejected request (400)',
      () => statusError(400, 'invalid_request_error', 'MARKER Banco Andino'),
      'status 400',
    ],
    [
      'a connection failure',
      () => new sdk.APIConnectionError({ message: 'MARKER reset', cause: new Error('MARKER') }),
      'APIConnectionError',
    ],
    [
      'an attempt that timed out',
      () => new sdk.APIConnectionTimeoutError({ message: 'MARKER timeout' }),
      'APIConnectionTimeoutError',
    ],
    [
      'an aborted request',
      () => new sdk.APIUserAbortError({ message: 'MARKER aborted' }),
      'APIUserAbortError',
    ],
    // Not SDK errors: what undici throws when the connection drops while the body is being
    // read, and what a truncated body does to the SDK's JSON parsing. Still the upstream.
    [
      'a connection dropped mid-body',
      () => Object.assign(new TypeError('MARKER terminated'), { cause: new Error('MARKER') }),
      'TypeError',
    ],
    ['a body that is not JSON', () => new SyntaxError('MARKER Unexpected end'), 'SyntaxError'],
  ]

  it.each(failures)('%s', async (_name, failure, upstreamError) => {
    mocks.create.mockImplementation(() => Promise.reject(failure()))
    const line = await expectUnavailable(post(CASE_1), upstreamError)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(Object.keys(line)).toEqual([...BASE_KEYS, 'upstreamError'])
    expect(written.join('')).not.toContain('MARKER')
  })

  it('a synchronous throw from the SDK call is an upstream failure too, and leaves no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    mocks.create.mockImplementation(() => {
      throw new TypeError('MARKER rejected client-side')
    })
    await expectUnavailable(post(CASE_1), 'TypeError')
    expect(vi.getTimerCount()).toBe(0)
    expect(written.join('')).not.toContain('MARKER')
  })

  it('the status errors above are the SDK classes the handler will meet', () => {
    expect(statusError(529, 'overloaded_error', 'x')).toBeInstanceOf(sdk.InternalServerError)
    expect(statusError(429, 'rate_limit_error', 'x')).toBeInstanceOf(sdk.RateLimitError)
    expect(statusError(401, 'authentication_error', 'x')).toBeInstanceOf(sdk.AuthenticationError)
  })

  it('timed out: gives up at 20 s, retries included, even if the SDK ignored the signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    mocks.create.mockImplementation(() => new Promise(() => {}))
    const settled = vi.fn()
    const pending = handler(post(CASE_1))
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledTimes(1)
    const response = await pending
    expect(JSON.parse(response.body).error.code).toBe('upstream_unavailable')
    expectBytes(JSON.parse(response.body).text, 'UPSTREAM_MESSAGE')
    expect(logLine()).toMatchObject({ status: 503, upstreamError: 'deadline', latencyMs: 20_000 })
    // The request in flight is told to stop.
    expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('a reply that arrives before the deadline leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    mocks.create.mockResolvedValue(reply(REPLY))
    expect((await handler(post(CASE_1))).statusCode).toBe(200)
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.create.mock.calls[0][1].signal.aborted).toBe(false)
  })

  it('the key cannot be read: no model call, and the log names the AWS error', async () => {
    const denied = Object.assign(new Error('MARKER not authorized'), {
      name: 'AccessDeniedException',
    })
    mocks.send.mockRejectedValue(denied)
    await expectUnavailable(post(CASE_1), 'ssm AccessDeniedException')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(written.join('')).not.toContain('MARKER')
  })

  it('an AWS error whose name is not an exception code is logged as UnknownError', async () => {
    const odd = Object.assign(new Error('MARKER'), { name: 'Parameter MARKER was not found' })
    mocks.send.mockRejectedValue(odd)
    await expectUnavailable(post(CASE_1), 'ssm UnknownError')
    expect(written.join('')).not.toContain('MARKER')
  })

  it('the parameter name is not configured, or the parameter is empty', async () => {
    vi.stubEnv('API_KEY_PARAMETER', '')
    await expectUnavailable(post(CASE_1), 'ssm ParameterNameMissing')
    expect(mocks.send).not.toHaveBeenCalled()
    vi.stubEnv('API_KEY_PARAMETER', PARAMETER)
    mocks.send.mockResolvedValue({ Parameter: {} })
    written = []
    await expectUnavailable(post(CASE_1), 'ssm ParameterValueMissing')
  })

  it('the model declines: no text is returned, and the tokens it billed are logged', async () => {
    mocks.create.mockResolvedValue(reply('', 'refusal', { input_tokens: 1742, output_tokens: 0 }))
    const line = await expectUnavailable(post(CASE_1), 'stop_reason refusal')
    expect(line).toMatchObject({ inputTokens: 1742, outputTokens: 0 })
  })

  it('a decline that arrives with partial text: the text is withheld, as for any other stop reason', async () => {
    for (const stopReason of [
      'refusal',
      'pause_turn',
      'stop_sequence',
      'model_context_window_exceeded',
    ]) {
      written = []
      const partial = `Qué pasa y cuándo\n\nMARKER partial text under ${stopReason}`
      mocks.create.mockResolvedValue(
        reply(partial, stopReason, { input_tokens: 1742, output_tokens: 40 }),
      )
      const response = await handler(post(CASE_1))
      expect(response.statusCode, stopReason).toBe(503)
      expect(JSON.parse(response.body).error.code, stopReason).toBe('upstream_unavailable')
      expect(response.body, stopReason).not.toContain('MARKER')
      const line = logLine()
      expectKeys(line, 'upstreamError')
      expect(line).toMatchObject({ upstreamError: `stop_reason ${stopReason}`, outputTokens: 40 })
      expect(written.join(''), stopReason).not.toContain('MARKER')
    }
  })

  it('the model returns no text', async () => {
    mocks.create.mockResolvedValue(reply('', 'end_turn', { input_tokens: 1742, output_tokens: 3 }))
    await expectUnavailable(post(CASE_1), 'empty_reply')
    mocks.create.mockResolvedValue(reply('  \n ', 'end_turn'))
    written = []
    await expectUnavailable(post(CASE_1), 'empty_reply')
  })
})

describe('row 6: model response truncated at max_tokens → 503 upstream_truncated', () => {
  it('returns the fixed string, never the partial text, and logs the tokens that were spent', async () => {
    const partial = 'Qué pasa y cuándo\n\nTu escalera tiene 3 peldaños que vencen el'
    mocks.create.mockResolvedValue(
      reply(partial, 'max_tokens', { input_tokens: 1742, output_tokens: 600 }),
    )
    const response = await handler(post(CASE_1))
    expect(response.statusCode).toBe(503)
    const body = JSON.parse(response.body)
    expectBytes(body.text, 'UPSTREAM_MESSAGE')
    expect(body).toEqual({
      text: UPSTREAM_MESSAGE,
      error: { code: 'upstream_truncated', issues: [] },
    })
    expect(response.body).not.toContain('Tu escalera')
    const line = logLine()
    expect(Object.keys(line)).toEqual([...BASE_KEYS, ...TOKEN_KEYS, 'upstreamError'])
    expect(line).toMatchObject({
      status: 503,
      inputTokens: 1742,
      outputTokens: 600,
      upstreamError: 'stop_reason max_tokens',
    })
  })
})

describe('row 7: unexpected internal error → 500 internal_error', () => {
  it('a defect is neither a refusal nor an outage, and its message is not logged', async () => {
    // A 200 the SDK parsed but whose usage is missing: reading it throws in this service.
    mocks.create.mockResolvedValue({ ...reply(REPLY), usage: undefined })
    const response = await handler(post(CASE_1))
    expect(response.statusCode).toBe(500)
    const body = JSON.parse(response.body)
    expectBytes(body.text, 'UPSTREAM_MESSAGE')
    expect(body).toEqual({ text: UPSTREAM_MESSAGE, error: { code: 'internal_error', issues: [] } })
    expect(response.headers).toEqual(HEADERS)
    const line = logLine()
    expectKeys(line, 'internalError')
    expect(line).toMatchObject({
      status: 500,
      rungCount: 3,
      entityCount: 3,
      internalError: 'TypeError',
    })
    expect(written.join('')).not.toContain('input_tokens')
  })

  it('logs the class of whatever was thrown, and a placeholder when it has no usable class', async () => {
    class LadderExplodedError extends Error {}
    for (const [thrown, expected] of [
      [new LadderExplodedError('MARKER'), 'LadderExplodedError'],
      [new RangeError('MARKER outside the pipeline'), 'RangeError'],
      ['MARKER a thrown string', 'UnknownError'],
      [
        Object.assign(new Error('MARKER'), { constructor: { name: 'with MARKER inside' } }),
        'UnknownError',
      ],
      [Object.assign(new Error('MARKER'), { constructor: null }), 'UnknownError'],
    ] as const) {
      written = []
      mocks.create.mockResolvedValue(unreadable(thrown))
      const response = await handler(post(CASE_1))
      expect(response.statusCode, expected).toBe(500)
      const line = logLine()
      expectKeys(line, 'internalError')
      expect(line, expected).toMatchObject({ status: 500, internalError: expected })
      expect(written.join(''), expected).not.toContain('MARKER')
    }
  })
})

describe('the log line (SPEC §8.4)', () => {
  it('is one JSON line with the request id, the §8.4 fields and the token counts', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    await handler(post(CASE_1), { awsRequestId: 'e1506fd5-9e7b-434f-bd42-4f8fa224b599' })
    const line = logLine()
    expect(Object.keys(line)).toEqual([...BASE_KEYS, ...TOKEN_KEYS])
    expect(line).toMatchObject({
      requestId: 'e1506fd5-9e7b-434f-bd42-4f8fa224b599',
      bodyHash: sha256(CASE_1),
      bodyBytes: Buffer.byteLength(CASE_1),
      rungCount: 3,
      entityCount: 3,
      status: 200,
      inputTokens: 1742,
      outputTokens: 251,
    })
    expect(line.bodyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isInteger(line.latencyMs)).toBe(true)
    expect(line.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('has requestId null when the invocation carries no context', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    await handler(post(CASE_1))
    expect(logLine()).toMatchObject({ requestId: null })
    written = []
    await handler(post(CASE_1), {})
    expect(logLine()).toMatchObject({ requestId: null })
  })

  it('counts rungs and entities as the request lists them', async () => {
    mocks.create.mockResolvedValue(reply(REPLY))
    await handler(post(bodyOf(caseById('twelve-rungs'))))
    expect(logLine()).toMatchObject({ rungCount: 12, entityCount: 6 })
  })

  it.each([...VALID_CASES])(
    '$id: carries nothing of the body and nothing of the reply',
    async (c) => {
      const input = c.input as RawRequest
      const text = `Qué pasa y cuándo\n\n${input.ladder.entities.map((e) => e.name).join(', ')}.\n\nRiesgos\n\nSin riesgos para señalar con estos datos.`
      mocks.create.mockResolvedValue(reply(text))
      const response = await handler(post(bodyOf(c)))
      expect(JSON.parse(response.body).text).toBe(text)
      const line = written.join('')
      for (const entity of input.ladder.entities) expect(line).not.toContain(entity.name)
      for (const rung of input.ladder.rungs) expect(line).not.toContain(String(rung.principal))
      for (const fragment of ['Qué pasa', 'Riesgos', 'Sin riesgos', input.asOfDate]) {
        expect(line).not.toContain(fragment)
      }
      // Every value is an id, a hash, a number or null: there is no free text field on a 200.
      for (const [key, value] of Object.entries(logLine())) {
        if (key === 'requestId' || key === 'bodyHash') continue
        expect(value === null || typeof value === 'number', key).toBe(true)
      }
    },
  )
})
