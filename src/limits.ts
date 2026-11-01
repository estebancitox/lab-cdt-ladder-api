import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { errorCodeName } from './error-name'

/**
 * SPEC §8.2: two daily request caps, counted before the key read and the model call, one for
 * every client together and one per client address. Each is one item of an on-demand DynamoDB
 * table, incremented by a conditional UpdateItem that fails once the count has reached the cap,
 * so the count and the check are one write and two concurrent requests never both pass as the
 * last one. The per-client write goes first: a client refused on its own cap never touches the
 * shared count. Both writes share one deadline. A write that fails for any other reason refuses
 * the request (§7, the 503 row): the limiter fails closed.
 *
 * Off when LIMITS_TABLE is unset or empty, which is how the tests and the §10 harness run; the
 * template always sets it.
 */
export const LIMITS_TIMEOUT_MS = 500

export type LimitName = 'ip' | 'daily'

export type Admission =
  | { kind: 'off' }
  | { kind: 'admitted' }
  | { kind: 'refused'; limit: LimitName; retryAfterSeconds: number }

/**
 * A counter could not be updated, or a limit is misconfigured. Carries the exception name of the
 * underlying error, never its message: the handler logs `causeName` and nothing else.
 */
export class LimitsUnavailableError extends Error {
  constructor(readonly causeName: string) {
    super('the request counters could not be updated')
    this.name = 'LimitsUnavailableError'
  }
}

let client: DynamoDBClient | undefined

/** Whether the request may go on to the model, counted against both caps for the UTC day. */
export async function admit(sourceIp: string | undefined, now: Date): Promise<Admission> {
  const table = process.env.LIMITS_TABLE
  if (table === undefined || table === '') return { kind: 'off' }
  const ipLimit = limitFromEnv('IP_DAILY_LIMIT', 'IpDailyLimitInvalid')
  const dailyLimit = limitFromEnv('DAILY_LIMIT', 'DailyLimitInvalid')
  const day = utcDay(now)
  const expiresAt = Math.floor(nextUtcMidnightMs(now) / 1000)
  const signal = AbortSignal.timeout(LIMITS_TIMEOUT_MS)
  const counters: [LimitName, string, number][] = [
    ['ip', `ip#${day}#${clientHash(day, sourceIp)}`, ipLimit],
    ['daily', `day#${day}`, dailyLimit],
  ]
  for (const [limit, pk, max] of counters) {
    if (!(await count(table, pk, max, expiresAt, signal))) {
      return { kind: 'refused', limit, retryAfterSeconds: retryAfterSeconds(now) }
    }
  }
  return { kind: 'admitted' }
}

/**
 * One counted request, or false when the item has reached `max`. The condition and the
 * increment are one write, so the count never passes the cap. `expiresAt` is the table's TTL
 * attribute, the same value for every write of the day.
 */
async function count(
  table: string,
  pk: string,
  max: number,
  expiresAt: number,
  signal: AbortSignal,
): Promise<boolean> {
  client ??= new DynamoDBClient({ maxAttempts: 2 })
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: pk } },
        UpdateExpression: 'SET #expiresAt = :expiresAt ADD #requests :one',
        ConditionExpression: 'attribute_not_exists(#requests) OR #requests < :limit',
        ExpressionAttributeNames: { '#expiresAt': 'expiresAt', '#requests': 'requests' },
        ExpressionAttributeValues: {
          ':expiresAt': { N: String(expiresAt) },
          ':one': { N: '1' },
          ':limit': { N: String(max) },
        },
      }),
      { abortSignal: signal },
    )
    return true
  } catch (error) {
    const name = errorCodeName(error)
    if (name === 'ConditionalCheckFailedException') return false
    throw new LimitsUnavailableError(name)
  }
}

/** A cap from the environment: a positive integer, or the request is refused as a 503. */
function limitFromEnv(variable: string, causeName: string): number {
  const value = process.env[variable]
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value)) {
    throw new LimitsUnavailableError(causeName)
  }
  return Number(value)
}

/**
 * SPEC §8.2: what is stored for a client is the SHA-256 of the UTC day and the client key, never
 * the address. The key is an IPv4 address as written, an IPv6 address by its /64, which is the
 * prefix a residential connection holds, an IPv4-mapped IPv6 address as its IPv4, and `unknown`
 * when the event carries no usable address, which a direct invocation does not.
 */
export function clientHash(day: string, sourceIp: string | undefined): string {
  return createHash('sha256').update(`${day} ${clientKey(sourceIp)}`).digest('hex')
}

export function clientKey(sourceIp: string | undefined): string {
  if (typeof sourceIp !== 'string') return 'unknown'
  const family = isIP(sourceIp)
  if (family === 4) return sourceIp
  if (family !== 6) return 'unknown'
  const groups = ipv6Groups(sourceIp)
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  if (mapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`
}

/** The eight 16-bit groups of an address `isIP` accepted as IPv6, `::` and a dotted tail expanded. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase()
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':')
    const quad = text.slice(colon + 1).split('.').map(Number)
    const hi = ((quad[0] << 8) | quad[1]).toString(16)
    const lo = ((quad[2] << 8) | quad[3]).toString(16)
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`
  }
  const [head, tail] = text.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const gap = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill('0')
  return [...headGroups, ...gap, ...tailGroups].map((g) => parseInt(g, 16))
}

/** The UTC calendar day, which names the day's counters. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function nextUtcMidnightMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
}

/** SPEC §7: the `retry-after` of a 429, whole seconds until the counters start again, 1 to 86 400. */
export function retryAfterSeconds(now: Date): number {
  return Math.ceil((nextUtcMidnightMs(now) - now.getTime()) / 1000)
}
