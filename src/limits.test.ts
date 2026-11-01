import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The limiter against a fake DynamoDB client: the command inputs, the order of the two writes,
 * the refusals, the failures and the client key. The clock is passed in, so every instant here
 * is explicit, and test:ci runs the file under two time zones.
 */
const mocks = vi.hoisted(() => ({ send: vi.fn(), clientOptions: vi.fn() }))

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mocks.send
    constructor(options: unknown) {
      mocks.clientOptions(options)
    }
  },
  UpdateItemCommand: class {
    constructor(readonly input: unknown) {}
  },
}))

const TABLE = 'lab-cdt-ladder-api-LimitsTable-1A2B3C'
const NOW = new Date('2026-11-01T15:04:05.678Z')
const DAY = '2026-11-01'
const NEXT_MIDNIGHT_MS = Date.UTC(2026, 10, 2)

let limits: typeof import('./limits')

beforeEach(async () => {
  // A fresh module graph per test: the client is built once per container.
  vi.resetModules()
  limits = await import('./limits')
  mocks.send.mockReset()
  mocks.clientOptions.mockReset()
  mocks.send.mockResolvedValue({})
  vi.stubEnv('LIMITS_TABLE', TABLE)
  vi.stubEnv('DAILY_LIMIT', '100')
  vi.stubEnv('IP_DAILY_LIMIT', '10')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** What the SDK throws when the condition fails: the message is what it would say. */
function conditionFailed() {
  return Object.assign(new Error('MARKER The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The command input of the n-th write (0-based) and the options it was sent with. */
function sent(n: number): { input: Record<string, unknown>; options: Record<string, unknown> } {
  const call = mocks.send.mock.calls[n]
  return { input: call[0].input, options: call[1] }
}

describe('off: no table variable, no client, no write (SPEC §8.2)', () => {
  it('is off when LIMITS_TABLE is unset', async () => {
    vi.stubEnv('LIMITS_TABLE', undefined)
    expect(await limits.admit('203.0.113.9', NOW)).toEqual({ kind: 'off' })
    expect(mocks.clientOptions).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('is off when LIMITS_TABLE is empty, whatever the limits say', async () => {
    vi.stubEnv('LIMITS_TABLE', '')
    vi.stubEnv('DAILY_LIMIT', 'not a number')
    expect(await limits.admit('203.0.113.9', NOW)).toEqual({ kind: 'off' })
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('admitted: two conditional writes, the client first, then everyone', () => {
  it('sends exactly these two UpdateItem commands, in this order, sharing one deadline', async () => {
    expect(await limits.admit('203.0.113.9', NOW)).toEqual({ kind: 'admitted' })
    expect(mocks.send).toHaveBeenCalledTimes(2)
    const expiresAt = String(NEXT_MIDNIGHT_MS / 1000)
    expect(Number.isInteger(Number(expiresAt))).toBe(true)
    const command = (pk: string, limit: string) => ({
      TableName: TABLE,
      Key: { pk: { S: pk } },
      UpdateExpression: 'SET #expiresAt = :expiresAt ADD #requests :one',
      ConditionExpression: 'attribute_not_exists(#requests) OR #requests < :limit',
      ExpressionAttributeNames: { '#expiresAt': 'expiresAt', '#requests': 'requests' },
      ExpressionAttributeValues: {
        ':expiresAt': { N: expiresAt },
        ':one': { N: '1' },
        ':limit': { N: limit },
      },
    })
    expect(sent(0).input).toEqual(command(`ip#${DAY}#${sha256(`${DAY} 203.0.113.9`)}`, '10'))
    expect(sent(1).input).toEqual(command(`day#${DAY}`, '100'))
    expect(Object.keys(sent(0).options)).toEqual(['abortSignal'])
    expect(sent(0).options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(sent(1).options.abortSignal).toBe(sent(0).options.abortSignal)
    expect((sent(0).options.abortSignal as AbortSignal).aborted).toBe(false)
  })

  it('stores a hash of the day and the address, never the address', async () => {
    await limits.admit('203.0.113.9', NOW)
    const keys = [sent(0).input, sent(1).input].map((input) => JSON.stringify(input))
    for (const key of keys) expect(key).not.toContain('203.0.113.9')
    expect(JSON.stringify(sent(0).input)).toMatch(/ip#2026-11-01#[0-9a-f]{64}/)
  })

  it('builds the client once per container, with one attempt per write, and reuses it', async () => {
    await limits.admit('203.0.113.9', NOW)
    await limits.admit('198.51.100.7', NOW)
    expect(mocks.clientOptions).toHaveBeenCalledTimes(1)
    // The deadline is the retry policy: the SDK's cooldown before a second attempt ignores the
    // abort signal, so a retry would only sleep past the deadline and fail as AbortError.
    expect(mocks.clientOptions).toHaveBeenCalledWith({ maxAttempts: 1 })
    expect(mocks.send).toHaveBeenCalledTimes(4)
  })

  it('a new UTC day is a new pair of items with a new expiry', async () => {
    const tomorrow = new Date('2026-11-02T00:00:00.000Z')
    await limits.admit('203.0.113.9', tomorrow)
    expect(sent(0).input.Key).toEqual({
      pk: { S: `ip#2026-11-02#${sha256('2026-11-02 203.0.113.9')}` },
    })
    expect(sent(1).input.Key).toEqual({ pk: { S: 'day#2026-11-02' } })
    const values = sent(1).input.ExpressionAttributeValues as Record<string, { N: string }>
    expect(values[':expiresAt']).toEqual({ N: String(Date.UTC(2026, 10, 3) / 1000) })
  })

  it('takes the limits from the environment, as the template parameters set them', async () => {
    vi.stubEnv('DAILY_LIMIT', '250')
    vi.stubEnv('IP_DAILY_LIMIT', '1')
    await limits.admit('203.0.113.9', NOW)
    const limitOf = (n: number) =>
      (sent(n).input.ExpressionAttributeValues as Record<string, { N: string }>)[':limit']
    expect(limitOf(0)).toEqual({ N: '1' })
    expect(limitOf(1)).toEqual({ N: '250' })
  })
})

describe('refused: the write whose condition fails names the limit (SPEC §7, the 429 rows)', () => {
  it('on the client cap: one write, the shared count untouched, retry-after to 00:00 UTC', async () => {
    mocks.send.mockRejectedValueOnce(conditionFailed())
    expect(await limits.admit('203.0.113.9', NOW)).toEqual({
      kind: 'refused',
      limit: 'ip',
      retryAfterSeconds: Math.ceil((NEXT_MIDNIGHT_MS - NOW.getTime()) / 1000),
    })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('on the shared cap: the client was counted first, then refused', async () => {
    mocks.send.mockResolvedValueOnce({}).mockRejectedValueOnce(conditionFailed())
    expect(await limits.admit('203.0.113.9', NOW)).toMatchObject({ kind: 'refused', limit: 'daily' })
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(sent(1).input.Key).toEqual({ pk: { S: `day#${DAY}` } })
  })
})

describe('unavailable: any other failure refuses the request by name (SPEC §7, the 503 row)', () => {
  async function expectUnavailable(causeName: string) {
    const outcome = limits.admit('203.0.113.9', NOW)
    await expect(outcome).rejects.toBeInstanceOf(limits.LimitsUnavailableError)
    await expect(outcome).rejects.toMatchObject({ causeName })
    await expect(outcome).rejects.not.toThrow(/MARKER/)
  }

  it('a throttled or failing table: the exception code, never its message', async () => {
    mocks.send.mockRejectedValue(
      Object.assign(new Error('MARKER throughput'), {
        name: 'ProvisionedThroughputExceededException',
      }),
    )
    await expectUnavailable('ProvisionedThroughputExceededException')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('the deadline: the SDK rejects an aborted request as AbortError', async () => {
    mocks.send.mockRejectedValue(Object.assign(new Error('MARKER aborted'), { name: 'AbortError' }))
    await expectUnavailable('AbortError')
  })

  it('the deadline fires: a write that never answers is aborted after LIMITS_TIMEOUT_MS of real time', async () => {
    // The fake client answers only when the signal fires, as the SDK's handler does: an error
    // named AbortError with the signal's reason as its cause.
    mocks.send.mockImplementation(
      (_command: unknown, options: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('MARKER aborted'), {
                name: 'AbortError',
                cause: options.abortSignal.reason,
              }),
            )
          })
        }),
    )
    const started = performance.now()
    await expectUnavailable('AbortError')
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(limits.LIMITS_TIMEOUT_MS - 5)
    expect(elapsed).toBeLessThan(limits.LIMITS_TIMEOUT_MS + 1_000)
    const signal = sent(0).options.abortSignal as AbortSignal
    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).name).toBe('TimeoutError')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('a second write failing after the first passed is a failure too, not a refusal', async () => {
    mocks.send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('MARKER'), { name: 'InternalServerError' }))
    await expectUnavailable('InternalServerError')
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })

  it('an error without a usable name is UnknownError', async () => {
    mocks.send.mockRejectedValue(Object.assign(new Error('MARKER'), { name: 'Not an MARKER code' }))
    await expectUnavailable('UnknownError')
    mocks.send.mockRejectedValue('MARKER a string')
    await expectUnavailable('UnknownError')
  })

  it.each([
    ['DAILY_LIMIT', undefined, 'DailyLimitInvalid'],
    ['DAILY_LIMIT', '', 'DailyLimitInvalid'],
    ['DAILY_LIMIT', '0', 'DailyLimitInvalid'],
    ['DAILY_LIMIT', '-1', 'DailyLimitInvalid'],
    ['DAILY_LIMIT', '1.5', 'DailyLimitInvalid'],
    ['DAILY_LIMIT', 'ten', 'DailyLimitInvalid'],
    ['DAILY_LIMIT', '1000000000', 'DailyLimitInvalid'],
    ['IP_DAILY_LIMIT', undefined, 'IpDailyLimitInvalid'],
    ['IP_DAILY_LIMIT', '0', 'IpDailyLimitInvalid'],
  ])('a limit that is not a positive integer: %s=%s refuses before any write', async (variable, value, causeName) => {
    vi.stubEnv(variable, value)
    await expectUnavailable(causeName)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.clientOptions).not.toHaveBeenCalled()
  })
})

describe('the client key (SPEC §8.2): IPv4 as written, IPv6 by its /64, else unknown', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3::/64'],
    ['2001:DB8:85A3:08D3:1319:8A2E:0370:7348', '2001:db8:85a3:8d3::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::ffff:cb00:7109', '203.0.113.9'],
    ['64:ff9b::203.0.113.9', '64:ff9b:0:0::/64'],
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['203.0.113', 'unknown'],
    ['203.0.113.9, 198.51.100.7', 'unknown'],
    ['not an address', 'unknown'],
  ])('%s → %s', (address, key) => {
    expect(limits.clientKey(address)).toBe(key)
  })

  it('two addresses of one /64 share a key, and two /64s do not', () => {
    expect(limits.clientKey('2001:db8:1:2::1')).toBe(limits.clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(limits.clientKey('2001:db8:1:2::1')).not.toBe(limits.clientKey('2001:db8:1:3::1'))
  })

  it('the hash is SHA-256 of the day, a space and the key, so it changes with the day', () => {
    expect(limits.clientHash(DAY, '203.0.113.9')).toBe(sha256('2026-11-01 203.0.113.9'))
    expect(limits.clientHash(DAY, '2001:db8:1:2::1')).toBe(sha256('2026-11-01 2001:db8:1:2::/64'))
    expect(limits.clientHash(DAY, undefined)).toBe(sha256('2026-11-01 unknown'))
    expect(limits.clientHash('2026-11-02', '203.0.113.9')).not.toBe(limits.clientHash(DAY, '203.0.113.9'))
  })
})

describe('the UTC day and retry-after (SPEC §7)', () => {
  it('the day is the UTC calendar date, whatever the process time zone', () => {
    expect(limits.utcDay(new Date('2026-11-01T23:59:59.999Z'))).toBe('2026-11-01')
    expect(limits.utcDay(new Date('2026-11-02T00:00:00.000Z'))).toBe('2026-11-02')
    // 19:00 in Bogotá is already the next UTC day.
    expect(limits.utcDay(new Date('2026-11-01T19:00:00-05:00'))).toBe('2026-11-02')
  })

  it('the next midnight crosses a month and a year', () => {
    expect(limits.nextUtcMidnightMs(new Date('2026-11-30T12:00:00Z'))).toBe(Date.UTC(2026, 11, 1))
    expect(limits.nextUtcMidnightMs(new Date('2026-12-31T23:59:59.999Z'))).toBe(Date.UTC(2027, 0, 1))
    expect(limits.nextUtcMidnightMs(new Date('2028-02-28T00:00:00Z'))).toBe(Date.UTC(2028, 1, 29))
  })

  it.each([
    ['2026-11-01T23:59:30.000Z', 30],
    ['2026-11-01T23:59:59.500Z', 1],
    ['2026-11-01T23:59:59.999Z', 1],
    ['2026-11-02T00:00:00.000Z', 86_400],
    ['2026-11-02T00:00:00.001Z', 86_400],
    ['2026-11-01T15:04:05.678Z', 32_155],
  ])('at %s retry-after is %i: whole seconds, rounded up, 1 to 86 400', (instant, seconds) => {
    expect(limits.retryAfterSeconds(new Date(instant))).toBe(seconds)
  })

  it('LIMITS_TIMEOUT_MS is the 1 500 ms both writes share', () => {
    expect(limits.LIMITS_TIMEOUT_MS).toBe(1_500)
  })
})
