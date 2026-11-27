import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_MESSAGE } from '../request/errors'
import { UPSTREAM_MESSAGE } from '../response'
import { constructedReply } from '../test-support/constructed-replies'
import { CASES, CASES_VERSION, V1_RUNS, V2_RUN, caseById } from '../test-support/contract'
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

/** The constructed reply of case 1 (SPEC §10.2): it passes its derived set and its own rules. */
const REPLY = constructedReply('healthy-3-rung')

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
      promptVersion: 'v2',
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
  const INVENTED = REPLY.replace('COP 50,000,000', 'COP 50,000,001')

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
    expect(INVENTED).toContain('Your ladder holds COP 50,000,001')
    expect(report).not.toContain('Your ladder holds COP 50,000,001')
  })
})

describe("the verification retry, recorded from the handler's log line (SPEC §8.6)", () => {
  it('a 200 reached after a retry: two calls, both spends, the reply that passed', async () => {
    vi.stubGlobal('fetch', fakeApi([REPLY.replace('COP 50,000,000', 'COP 50,000,001'), REPLY]))
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
      [['max_words'], ['language_en']],
      2,
      [['max_words'], ['language_en']],
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
  it('the suite covers every case of evals/cases.json, version 2', () => {
    expect(CASES).toHaveLength(10)
    expect(CASES_VERSION).toBe(2)
  })

  it('the harness loads version 2 of the cases, and refuses a file of another version', async () => {
    const { CASES_VERSION: harnessVersion, loadCases } = await import('./cases')
    expect(harnessVersion).toBe(2)
    expect(loadCases().map((c) => c.id)).toEqual(CASES.map((c) => c.id))
    const directory = mkdtempSync(join(tmpdir(), 'cases-'))
    try {
      const v1 = join(directory, 'cases.json')
      writeFileSync(v1, JSON.stringify({ version: 1, cases: [] }))
      expect(() => loadCases(v1)).toThrow('is version 1, and this harness runs version 2')
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
})

describe('replay: stored replies re-evaluated with the rules as they are now', () => {
  it('keeps the measurement and recomputes only the verdicts', async () => {
    const { replay } = await import('./replay-core')
    const { renderReport } = await import('./report')
    const cases = [caseById('healthy-3-rung'), caseById('negative-amount')]
    const stored: import('./suite').SuiteResult = {
      model: 'claude-sonnet-5-5',
      promptVersion: 'v2',
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
          text: REPLY.replace('COP 50,000,000', 'COP 16.7 million'),
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
      { rule: 'numbers_subset_of_input', pass: false, evidence: 'not in A: 16.7 → 16.7' },
    ])
    expect(result.runs[2].verdicts).toEqual([{ rule: 'error_message_exact', pass: true }])
    expect(result.runs.map((r) => r.costUsd)).toEqual([0.008692, 0.008692, null])
    const report = renderReport(result, cases)
    expect(report).toContain('| Rule | Run 1 | Run 2 | Classification |')
    expect(report).toContain('FAIL: not in A: 16.7 → 16.7')
    expect(report).toContain('> What happens and when')
    expect(report).toContain('| 9 | negative-amount | 1 | 1/1 |')
  })

  it('a v2 run is comparable, and a v1 run is not: both stored runs record prompt v1 (SPEC §10.2)', async () => {
    const { V1_PROMPT_VERSION, comparable } = await import('./replay-core')
    expect(V1_PROMPT_VERSION).toBe('v1')
    expect(comparable({ promptVersion: 'v2' })).toBe(true)
    expect(comparable({ promptVersion: 'v1' })).toBe(false)
    // A file that records no prompt version cannot be told from a v1 run, and is refused too.
    expect(comparable({})).toBe(false)
    expect(comparable({ promptVersion: undefined })).toBe(false)
    expect(comparable({ promptVersion: 2 })).toBe(false)
    expect(V1_RUNS).toHaveLength(2)
    for (const directory of V1_RUNS) {
      const stored = JSON.parse(
        readFileSync(new URL(`../../${directory}/results.json`, import.meta.url), 'utf8'),
      ) as import('./suite').SuiteResult
      expect(stored.promptVersion, directory).toBe('v1')
      expect(comparable(stored), directory).toBe(false)
    }
    // A run made from here on records the prompt it ran against, which is v2.
    const { PROMPT_VERSION } = await import('../model/prompt.v2')
    expect(comparable({ promptVersion: PROMPT_VERSION })).toBe(true)
  })

  it('the stored v2 run is comparable, and replayed it gives every verdict it recorded', async () => {
    const { comparable, replay } = await import('./replay-core')
    const stored = JSON.parse(
      readFileSync(new URL(`../../${V2_RUN}/results.json`, import.meta.url), 'utf8'),
    ) as import('./suite').SuiteResult
    expect(stored.promptVersion).toBe('v2')
    expect(comparable(stored)).toBe(true)
    // 26 runs: three per valid case and one per invalid case, each with the rules of its case.
    expect(stored.runs).toHaveLength(26)
    const recorded = stored.runs.flatMap((r) => r.verdicts)
    expect(recorded).toHaveLength(245)
    expect(recorded.filter((v) => !v.pass)).toEqual([])
    // The rules as they are now give each of them again, run by run and rule by rule.
    const replayed = replay(stored, [...CASES])
    expect(replayed.runs.map((r) => r.verdicts)).toEqual(stored.runs.map((r) => r.verdicts))
    // Only the verdicts are recomputed: the measurement is kept as it was stored.
    const measured = (r: import('./suite').RunRecord) => ({ ...r, verdicts: undefined })
    expect(replayed.runs.map(measured)).toEqual(stored.runs.map(measured))
  })

  it('replayed anyway, a v1 run fails language_en in each of its 24 replies, which says nothing of the run', async () => {
    const { replay } = await import('./replay-core')
    for (const directory of V1_RUNS) {
      const stored = JSON.parse(
        readFileSync(new URL(`../../${directory}/results.json`, import.meta.url), 'utf8'),
      ) as import('./suite').SuiteResult
      const replies = replay(stored, [...CASES]).runs.filter((r) => r.status === 200)
      expect(replies).toHaveLength(24)
      for (const r of replies) {
        expect(
          r.verdicts.find((v) => v.rule === 'language_en')?.pass,
          `${directory} ${r.caseId} run ${r.run}`,
        ).toBe(false)
      }
    }
  })
})

describe('eval:replay as a command: its exit codes, and what it writes (SPEC §10.2)', () => {
  const root = new URL('../../', import.meta.url)
  const pathOf = (directory: string) => new URL(`${directory}/results.json`, root).pathname
  /** The command with both of its streams collected. */
  async function run(path: string | undefined) {
    const { replayCommand } = await import('./replay-command')
    const out: string[] = []
    const err: string[] = []
    const code = replayCommand(path, { out: (t) => out.push(t), err: (t) => err.push(t) })
    return { code, out: out.join(''), err: err.join('') }
  }

  it('with no path it is a usage error: exit 2', async () => {
    expect(await run(undefined)).toEqual({
      code: 2,
      out: '',
      err: 'usage: npm run eval:replay -- evals/runs/<timestamp>/results.json',
    })
  })

  it.each([...V1_RUNS])('%s: a v1 run is not comparable: exit 3, and nothing is written', async (directory) => {
    const path = pathOf(directory)
    const folder = new URL(`${directory}/`, root).pathname
    const before = readFileSync(path)
    expect(readdirSync(folder).sort()).toEqual(['report.md', 'results.json'])
    const result = await run(path)
    expect(result.code).toBe(3)
    expect(result.out).toBe('')
    expect(result.err).toContain(`not comparable: ${path} is a v1 run`)
    expect(result.err).toContain('SPEC §10.2')
    expect(result.err).toContain('Nothing was written.')
    // The folder of the stored run holds what it held, byte for byte.
    expect(readdirSync(folder).sort()).toEqual(['report.md', 'results.json'])
    expect(existsSync(join(folder, 'report.replay.md'))).toBe(false)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('a file that records no prompt version is refused the same way', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'replay-'))
    try {
      const stored = JSON.parse(readFileSync(pathOf(V1_RUNS[0]), 'utf8')) as Record<string, unknown>
      delete stored.promptVersion
      const path = join(directory, 'results.json')
      writeFileSync(path, JSON.stringify(stored))
      const result = await run(path)
      expect(result.code).toBe(3)
      expect(result.err).toContain('records no prompt version, so it cannot be told from a v1 run')
      expect(readdirSync(directory)).toEqual(['results.json'])
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('a v2 run is replayed: exit 0, the report written beside the results, the results untouched', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'replay-'))
    try {
      const stored: import('./suite').SuiteResult = {
        model: 'claude-sonnet-5-5',
        promptVersion: 'v2',
        priceUsdPerMtok: { input: 2, output: 10 },
        startedAt: 'a fixture, not a measurement',
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
        ],
      }
      const path = join(directory, 'results.json')
      const written = JSON.stringify(stored)
      writeFileSync(path, written)
      const result = await run(path)
      expect(result.code).toBe(0)
      expect(result.err).toBe('')
      expect(result.out).toContain('| 1 | healthy-3-rung | 1 | 10/10 |')
      expect(result.out).toContain(`written: ${join(directory, 'report.replay.md')}`)
      expect(readdirSync(directory).sort()).toEqual(['report.replay.md', 'results.json'])
      expect(readFileSync(join(directory, 'report.replay.md'), 'utf8')).toContain('> What happens and when')
      expect(readFileSync(path, 'utf8')).toBe(written)
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
})
