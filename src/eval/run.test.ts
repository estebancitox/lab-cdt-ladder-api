import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_MESSAGE } from '../request/errors'
import { UPSTREAM_MESSAGE } from '../response'
import { CASES, caseById } from '../test-support/contract'
import type { FetchCounter } from './fetch-counter'

/**
 * The runner end to end without paying: the real Anthropic SDK over a fake fetch that answers
 * like the API, SSM mocked, the handler in process. This is where the model-call count is
 * shown to be exact before the paid run depends on it.
 */
const mocks = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = mocks.send
  },
  GetParameterCommand: class {
    constructor(readonly input: unknown) {}
  },
}))

const REPLY =
  'Qué pasa y cuándo\n\nTu escalera tiene $ 50.000.000 de capital en 3 peldaños y 3 entidades. El peldaño 1 está en Banco Andino y vence el 4 de abril de 2027, el peldaño 2 en Cooperativa Ñame & Café el 3 de julio de 2027 y el peldaño 3 en Entidad B el 1 de octubre de 2027.\n\nRiesgos\n\nSin riesgos para señalar con estos datos.'

let suite: typeof import('./suite')
let counterModule: typeof import('./fetch-counter')
let apiRequests: { url: string; body: unknown }[]
let counter: FetchCounter

/** Answers each call with the next of `texts`, the last one repeated. */
function fakeApi(
  texts: string | string[],
  usage = { input_tokens: 3041, output_tokens: 261 },
): typeof fetch {
  const replies = Array.isArray(texts) ? texts : [texts]
  let served = 0
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    apiRequests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const text = replies[Math.min(served, replies.length - 1)]
    served += 1
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    }
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
    })
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('API_KEY_PARAMETER', '/lab-cdt-ladder-api/anthropic-api-key')
  mocks.send.mockReset()
  mocks.send.mockResolvedValue({ Parameter: { Value: 'test-key' } })
  apiRequests = []
  vi.stubGlobal('fetch', fakeApi(REPLY))
  counterModule = await import('./fetch-counter')
  counter = counterModule.installFetchCounter()
  suite = await import('./suite')
})

afterEach(() => {
  counter.uninstall()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('criterion 2: cases 8 and 9 through the runner', () => {
  it('pass error_message_exact with zero model calls, counted at the fetch boundary', async () => {
    const result = await suite.runSuite(
      [caseById('missing-required-field'), caseById('negative-amount')],
      {
        runs: 3,
        counter,
        startedAt: '2026-10-05T00:00:00.000Z',
      },
    )
    expect(result.runs).toHaveLength(2)
    for (const r of result.runs) {
      expect(r).toMatchObject({
        status: 400,
        calls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      })
      expect(r.text).toBe(ERROR_MESSAGE)
      expect(r.verdicts).toEqual([{ rule: 'error_message_exact', pass: true }])
    }
    expect(apiRequests).toHaveLength(0)
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('a valid case through the runner', () => {
  it('counts exactly one model call per run, records tokens, latency and cost, and evaluates the rules', async () => {
    const result = await suite.runSuite([caseById('healthy-3-rung')], {
      runs: 3,
      counter,
      startedAt: '2026-10-05T00:00:00.000Z',
    })
    expect(result).toMatchObject({
      model: 'claude-sonnet-5-5',
      promptVersion: 'v1',
      priceUsdPerMtok: { input: 2, output: 10 },
    })
    expect(result.runs.map((r) => r.run)).toEqual([1, 2, 3])
    for (const r of result.runs) {
      expect(r).toMatchObject({
        status: 200,
        calls: 1,
        inputTokens: 3041,
        outputTokens: 261,
        failedRules: [],
        verificationRetry: false,
        text: REPLY,
      })
      expect(r.costUsd).toBeCloseTo(0.008692, 9)
      expect(typeof r.latencyMs).toBe('number')
      expect(r.verdicts.map((v) => v.rule)).toEqual(caseById('healthy-3-rung').rules)
      expect(r.verdicts.filter((v) => !v.pass)).toEqual([])
    }
    expect(apiRequests).toHaveLength(3)
    expect(apiRequests[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(apiRequests[0].body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 600 })
    // The key was read once for the whole run.
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  // A reply that fails numbers_subset_of_input never reaches the runner as a 200: the handler
  // verifies it (SPEC §7.4), retries once, and answers 502 when the retry fails too.
  const INVENTED = REPLY.replace('$ 50.000.000', '$ 50.000.001')

  it('a reply failing verification twice is a 502 run: two calls, both spends, every rule failed on the status', async () => {
    vi.stubGlobal('fetch', fakeApi(INVENTED))
    counter.uninstall()
    counter = counterModule.installFetchCounter()
    const result = await suite.runSuite([caseById('healthy-3-rung')], {
      runs: 1,
      counter,
      startedAt: 't',
    })
    expect(result.runs[0]).toMatchObject({
      status: 502,
      calls: 2,
      inputTokens: 3041 * 2,
      outputTokens: 261 * 2,
      failedRules: [['numbers_subset_of_input'], ['numbers_subset_of_input']],
      verificationRetry: true,
      text: UPSTREAM_MESSAGE,
    })
    expect(result.runs[0].costUsd).toBeCloseTo(0.008692 * 2, 9)
    expect(result.runs[0].verdicts).toEqual(
      caseById('healthy-3-rung').rules.map((rule) => ({
        rule,
        pass: false,
        evidence: 'status 502',
      })),
    )
    expect(apiRequests).toHaveLength(2)
  })

  it('a 502 run reaches the report with its evidence, an empty Classification cell and no reply', async () => {
    vi.stubGlobal('fetch', fakeApi(INVENTED))
    counter.uninstall()
    counter = counterModule.installFetchCounter()
    const { renderReport } = await import('./report')
    const cases = [caseById('healthy-3-rung')]
    const result = await suite.runSuite(cases, { runs: 1, counter, startedAt: 't' })
    const report = renderReport(result, cases)
    expect(report).toContain('| 1 | healthy-3-rung | 1 | 0/10 |')
    expect(report).toContain('| Rule | Run 1 | Classification |')
    expect(report).toContain('| numbers_subset_of_input | FAIL: status 502 |  |')
    expect(report).toContain('| max_words:150 | FAIL: status 502 |  |')
    expect(report).toContain('status 502 · 2 model calls · 6082 in / 522 out')
    expect(report).toContain(`> ${UPSTREAM_MESSAGE}`)
    expect(report).not.toContain('Tu escalera tiene $ 50.000.001')
  })
})

describe("the verification retry, recorded from the handler's log line (SPEC §8.6)", () => {
  it('a 200 reached after a retry: two calls, both spends, the reply that passed', async () => {
    vi.stubGlobal('fetch', fakeApi([REPLY.replace('$ 50.000.000', '$ 50.000.001'), REPLY]))
    counter.uninstall()
    counter = counterModule.installFetchCounter()
    const result = await suite.runSuite([caseById('healthy-3-rung')], {
      runs: 1,
      counter,
      startedAt: 't',
    })
    expect(result.runs[0]).toMatchObject({
      status: 200,
      calls: 2,
      inputTokens: 3041 * 2,
      outputTokens: 261 * 2,
      failedRules: [['numbers_subset_of_input'], []],
      verificationRetry: true,
      text: REPLY,
    })
    expect(result.runs[0].verdicts.filter((v) => !v.pass)).toEqual([])
  })

  // The handler's line, as each outcome writes it; `calls` model calls are made first.
  async function recorded(status: number, failedRules: string[][] | undefined, calls: number) {
    const invoke = async () => {
      for (let i = 0; i < calls; i += 1) {
        await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })
      }
      const line = {
        requestId: 'x',
        bodyHash: 'h',
        bodyBytes: 1,
        rungCount: 3,
        entityCount: 3,
        status,
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 5,
        ...(failedRules === undefined ? {} : { failedRules }),
      }
      process.stdout.write(JSON.stringify(line) + '\n')
      const text = status === 200 ? REPLY : UPSTREAM_MESSAGE
      return { statusCode: status, headers: {}, body: JSON.stringify({ text }) }
    }
    const result = await suite.runSuite([caseById('healthy-3-rung')], {
      runs: 1,
      counter,
      startedAt: 't',
      invoke,
    })
    return result.runs[0]
  }

  it.each([
    ['a 200 on the first reply', 200, undefined, 1, [], false],
    ['a 502 with no time for a retry', 502, [['max_words']], 1, [['max_words']], false],
    ['a 503 after a retry that failed upstream', 503, [['max_words']], 2, [['max_words']], true],
    ['a 500 after a retry that threw', 500, [['max_words']], 2, [['max_words']], true],
    ['a 200 after a retry', 200, [['max_words'], []], 2, [['max_words'], []], true],
    [
      'a 502 after a retry',
      502,
      [['max_words'], ['language_es']],
      2,
      [['max_words'], ['language_es']],
      true,
    ],
  ] as const)('%s', async (_, status, line, calls, failedRules, verificationRetry) => {
    const run = await recorded(
      status,
      line?.map((entry) => [...entry]),
      calls,
    )
    expect(run).toMatchObject({ status, calls, failedRules, verificationRetry })
  })

  it('a run with no log line records neither', async () => {
    const invoke = async () => ({
      statusCode: 503,
      headers: {},
      body: JSON.stringify({ text: UPSTREAM_MESSAGE }),
    })
    const result = await suite.runSuite([caseById('healthy-3-rung')], {
      runs: 1,
      counter,
      startedAt: 't',
      invoke,
    })
    expect(result.runs[0]).toMatchObject({ failedRules: null, verificationRetry: null })
  })
})

describe('counting is checked against the handler', () => {
  it('aborts when a 200 carries tokens but no model call was counted', async () => {
    const invoke = async () => {
      process.stdout.write(
        '{"requestId":"x","bodyHash":"h","bodyBytes":1,"rungCount":3,"entityCount":3,"status":200,"latencyMs":1,"inputTokens":10,"outputTokens":5}\n',
      )
      return { statusCode: 200, headers: {}, body: JSON.stringify({ text: REPLY }) }
    }
    await expect(
      suite.runSuite([caseById('healthy-3-rung')], { runs: 1, counter, startedAt: 't', invoke }),
    ).rejects.toThrow(suite.CountingError)
  })

  it('aborts when a 400 came with a model call', async () => {
    const invoke = async () => {
      await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })
      process.stdout.write(
        '{"requestId":"x","bodyHash":"h","bodyBytes":1,"rungCount":null,"entityCount":null,"status":400,"latencyMs":1}\n',
      )
      return { statusCode: 400, headers: {}, body: JSON.stringify({ text: ERROR_MESSAGE }) }
    }
    await expect(
      suite.runSuite([caseById('missing-required-field')], {
        runs: 1,
        counter,
        startedAt: 't',
        invoke,
      }),
    ).rejects.toThrow(/status 400 with 1 model call/)
  })
})

describe('coverage', () => {
  it('the suite covers every case of evals/cases.json', () => {
    expect(CASES).toHaveLength(10)
  })
})

describe('replay: stored replies re-evaluated with the rules as they are now', () => {
  it('keeps the measurement and recomputes only the verdicts', async () => {
    const { replay } = await import('./replay-core')
    const { renderReport } = await import('./report')
    const cases = [caseById('healthy-3-rung'), caseById('negative-amount')]
    const stored: import('./suite').SuiteResult = {
      model: 'claude-sonnet-5-5',
      promptVersion: 'v1',
      priceUsdPerMtok: { input: 2, output: 10 },
      startedAt: '2026-10-05T00:00:00Z',
      runs: [
        {
          caseId: 'healthy-3-rung',
          position: 1,
          run: 1,
          status: 200,
          calls: 1,
          inputTokens: 3041,
          outputTokens: 261,
          latencyMs: 3535,
          costUsd: 0.008692,
          text: REPLY,
          verdicts: [],
        },
        {
          caseId: 'healthy-3-rung',
          position: 1,
          run: 2,
          status: 200,
          calls: 1,
          inputTokens: 3041,
          outputTokens: 261,
          latencyMs: 3535,
          costUsd: 0.008692,
          text: REPLY.replace('$ 50.000.000', '16,7 millones'),
          verdicts: [],
        },
        {
          caseId: 'negative-amount',
          position: 9,
          run: 1,
          status: 400,
          calls: 0,
          inputTokens: null,
          outputTokens: null,
          latencyMs: 1,
          costUsd: null,
          text: ERROR_MESSAGE,
          verdicts: [],
        },
      ],
    }
    const result = replay(stored, cases)
    expect(result.runs[0].verdicts.filter((v) => !v.pass)).toEqual([])
    expect(result.runs[1].verdicts.filter((v) => !v.pass)).toEqual([
      { rule: 'numbers_subset_of_input', pass: false, evidence: 'not in A: 16,7 → 16.7' },
    ])
    expect(result.runs[2].verdicts).toEqual([{ rule: 'error_message_exact', pass: true }])
    expect(result.runs.map((r) => r.costUsd)).toEqual([0.008692, 0.008692, null])
    const report = renderReport(result, cases)
    expect(report).toContain('| Rule | Run 1 | Run 2 | Classification |')
    expect(report).toContain('FAIL: not in A: 16,7 → 16.7')
    expect(report).toContain('> Qué pasa y cuándo')
    expect(report).toContain('| 9 | negative-amount | 1 | 1/1 |')
  })
})
