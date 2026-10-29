import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, validateScenario, type ScenarioInput } from '../engine'
import {
  SPEC_MD,
  VALID_CASES,
  bodyOf,
  caseById,
  inputOf,
  specErrorMessage,
  type RawRequest,
} from '../test-support/contract'
import { ERROR_MESSAGE } from './errors'
import { validateShape } from './schema'
import { MAX_BODY_BYTES, MAX_RUNG_DAYS, MAX_RUNG_PRINCIPAL, validateRequest } from './validate'

function refused(raw: string | Uint8Array) {
  const outcome = validateRequest(raw)
  if (outcome.ok) throw new Error('expected a refusal')
  return outcome
}

/** Byte for byte against the string parsed out of SPEC.md, not against a retyped copy. */
function expectErrorMessageBytes(text: string) {
  expect(Buffer.from(text, 'utf8').equals(Buffer.from(specErrorMessage(), 'utf8'))).toBe(true)
}

function lastMaturityOf(r: RawRequest): string {
  return addDays(r.ladder.startDate, Math.max(...r.ladder.rungs.map((x) => x.days)))
}

describe('ERROR_MESSAGE', () => {
  it('equals the SPEC §7 fixed string byte for byte', () => {
    expectErrorMessageBytes(ERROR_MESSAGE)
    expect(ERROR_MESSAGE).toBe(specErrorMessage())
  })
})

describe('criterion 3: the 8 KiB cap runs before parsing (SPEC §8)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses 8193 bytes of non-JSON with 413 payload_too_large and never calls JSON.parse', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const outcome = refused('{'.repeat(MAX_BODY_BYTES + 1))
    expect(parse).not.toHaveBeenCalled()
    expect(outcome.stage).toBe('cap')
    expect(outcome.status).toBe(413)
    expect(outcome.body.error).toEqual({ code: 'payload_too_large', issues: [] })
    expectErrorMessageBytes(outcome.body.text)
  })

  it('accepts exactly 8192 bytes and refuses 8193, as a string and as bytes', () => {
    const json = bodyOf(caseById('healthy-3-rung'))
    const exact = json + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(json))
    expect(Buffer.byteLength(exact)).toBe(MAX_BODY_BYTES)
    expect(validateRequest(exact).ok).toBe(true)
    expect(validateRequest(new TextEncoder().encode(exact)).ok).toBe(true)
    expect(refused(exact + ' ').status).toBe(413)
    expect(refused(new TextEncoder().encode(exact + ' ')).status).toBe(413)
  })

  it('measures bytes, not characters', () => {
    const json = bodyOf(caseById('healthy-3-rung'))
    const padded = json + 'é'.repeat(MAX_BODY_BYTES - Buffer.byteLength(json))
    expect(padded.length).toBeLessThan(MAX_BODY_BYTES)
    expect(Buffer.byteLength(padded)).toBeGreaterThan(MAX_BODY_BYTES)
    expect(refused(padded).status).toBe(413)
  })
})

describe('criterion 4: cases 8 and 9 (SPEC §7)', () => {
  it('missing-required-field is refused by the schema stage: 400, invalid_input, ERROR_MESSAGE bytes', () => {
    const c = caseById('missing-required-field')
    expect(validateShape(c.input).ok).toBe(false)
    const outcome = refused(bodyOf(c))
    expect(outcome.stage).toBe('schema')
    expect(outcome.status).toBe(400)
    expect(outcome.body.error.code).toBe('invalid_input')
    expectErrorMessageBytes(outcome.body.text)
  })

  it('negative-amount passes the schema and is refused by the engine stage: 400, invalid_input, ERROR_MESSAGE bytes', () => {
    const c = caseById('negative-amount')
    expect(validateShape(c.input).ok).toBe(true)
    const outcome = refused(bodyOf(c))
    expect(outcome.stage).toBe('engine')
    expect(outcome.status).toBe(400)
    expect(outcome.body.error.code).toBe('invalid_input')
    expectErrorMessageBytes(outcome.body.text)
  })

  it('engine issues are returned verbatim, tagged with their source (SPEC §7.2)', () => {
    // Compared against the engine's own output for the same ladder, not against the
    // fixture's expectIssues, which SPEC §10 keeps as documentation.
    const c = caseById('negative-amount')
    const ladder = (c.input as RawRequest).ladder as unknown as ScenarioInput
    const fromEngine = validateScenario(ladder)
    expect(fromEngine.length).toBeGreaterThan(0)
    expect(refused(bodyOf(c)).body.error.issues).toEqual(
      fromEngine.map((issue) => ({ source: 'engine', ...issue })),
    )
  })
})

describe('bodies that are not JSON (plan decision 2)', () => {
  it('non-JSON text is refused at the json stage with api/invalid_json', () => {
    const outcome = refused('{not json')
    expect(outcome.stage).toBe('json')
    expect(outcome.status).toBe(400)
    expect(outcome.body.error).toEqual({
      code: 'invalid_input',
      issues: [
        {
          source: 'api',
          code: 'invalid_json',
          path: '',
          message: 'El cuerpo de la solicitud no es JSON válido.',
        },
      ],
    })
    expectErrorMessageBytes(outcome.body.text)
  })

  it('invalid UTF-8 bytes are refused at the json stage', () => {
    expect(refused(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])).stage).toBe('json')
  })

  it('valid JSON that is not an object is refused at the schema stage', () => {
    for (const raw of ['null', '42', '"x"', '[]', 'true'])
      expect(refused(raw).stage, raw).toBe('schema')
  })
})

describe('criterion 5: the two asOfDate rules (SPEC §2.1)', () => {
  it('rule 1: a pattern-valid but impossible asOfDate returns 400 invalid_input', () => {
    const body = inputOf('healthy-3-rung')
    body.asOfDate = '2027-02-29'
    expect(validateShape(body).ok).toBe(true)
    const outcome = refused(JSON.stringify(body))
    expect(outcome.stage).toBe('asOfDate')
    expect(outcome.status).toBe(400)
    expect(outcome.body.error).toEqual({
      code: 'invalid_input',
      issues: [
        {
          source: 'api',
          code: 'as_of_date_invalid',
          path: 'asOfDate',
          message: 'La fecha de consulta no es válida.',
        },
      ],
    })
    expectErrorMessageBytes(outcome.body.text)
  })

  it('rule 2: an asOfDate one day after the last maturity returns 400 invalid_input', () => {
    const body = inputOf('healthy-3-rung')
    const last = lastMaturityOf(body)
    expect(last).toBe('2027-10-01')
    body.asOfDate = addDays(last, 1)
    const outcome = refused(JSON.stringify(body))
    expect(outcome.stage).toBe('asOfDate')
    expect(outcome.status).toBe(400)
    expect(outcome.body.error).toEqual({
      code: 'invalid_input',
      issues: [
        {
          source: 'api',
          code: 'as_of_date_after_last_maturity',
          path: 'asOfDate',
          message: 'La fecha de consulta es posterior al último vencimiento de la escalera.',
        },
      ],
    })
    expectErrorMessageBytes(outcome.body.text)
  })

  it('rule 2 is inclusive: the last maturity itself passes, and so does a date before the start', () => {
    const body = inputOf('healthy-3-rung')
    body.asOfDate = lastMaturityOf(body)
    expect(validateRequest(JSON.stringify(body)).ok).toBe(true)
    body.asOfDate = '2026-12-01'
    expect(validateRequest(JSON.stringify(body)).ok).toBe(true)
  })
})

describe('the per-rung range stage (SPEC §8.5)', () => {
  const principalIssue = (i: number) => ({
    source: 'api',
    code: 'principal_out_of_range',
    path: `rungs[${i}].principal`,
    message: 'El monto no puede superar 1.000.000.000.000 pesos.',
  })
  const daysIssue = (i: number) => ({
    source: 'api',
    code: 'days_out_of_range',
    path: `rungs[${i}].days`,
    message: 'El plazo no puede superar 3.650 días.',
  })

  it('the limits are the SPEC §8 rows', () => {
    expect(SPEC_MD).toContain('| Rung term `days` | at most 3650 |')
    expect(SPEC_MD).toContain('| Rung `principal` | at most 1e12 pesos |')
    expect(MAX_RUNG_DAYS).toBe(3650)
    expect(MAX_RUNG_PRINCIPAL).toBe(1e12)
  })

  it('both limits are inclusive', () => {
    const body = inputOf('healthy-3-rung')
    Object.assign(body.ladder.rungs[0], { principal: MAX_RUNG_PRINCIPAL, days: MAX_RUNG_DAYS })
    expect(validateRequest(JSON.stringify(body)).ok).toBe(true)
  })

  it('one over a limit is a 400 invalid_input at the range stage, in the API issue shape', () => {
    const days = inputOf('healthy-3-rung')
    days.ladder.rungs[1].days = MAX_RUNG_DAYS + 1
    const byDays = refused(JSON.stringify(days))
    expect(byDays.stage).toBe('range')
    expect(byDays.status).toBe(400)
    expect(byDays.body.error).toEqual({ code: 'invalid_input', issues: [daysIssue(1)] })
    expectErrorMessageBytes(byDays.body.text)

    const principal = inputOf('healthy-3-rung')
    principal.ladder.rungs[0].principal = MAX_RUNG_PRINCIPAL + 1
    const byPrincipal = refused(JSON.stringify(principal))
    expect(byPrincipal.stage).toBe('range')
    expect(byPrincipal.body.error).toEqual({ code: 'invalid_input', issues: [principalIssue(0)] })
  })

  it('one issue per offending field of every offending rung, in the engine field order', () => {
    const body = inputOf('healthy-3-rung')
    Object.assign(body.ladder.rungs[0], {
      principal: MAX_RUNG_PRINCIPAL + 1,
      days: MAX_RUNG_DAYS + 1,
    })
    body.ladder.rungs[2].days = MAX_RUNG_DAYS + 1
    expect(refused(JSON.stringify(body)).body.error.issues).toEqual([
      principalIssue(0),
      daysIssue(0),
      daysIssue(2),
    ])
  })

  it('runs only when the engine stage returned no issues', () => {
    const body = inputOf('healthy-3-rung')
    body.ladder.rungs[0].principal = -1
    body.ladder.rungs[1].days = MAX_RUNG_DAYS + 1
    const outcome = refused(JSON.stringify(body))
    expect(outcome.stage).toBe('engine')
    expect(outcome.body.error.issues.map((i) => i.source)).toEqual(['engine'])
  })

  it('precedes both asOfDate rules, not only the one that calls computeScenario', () => {
    const invalidDate = inputOf('healthy-3-rung')
    invalidDate.ladder.rungs[0].days = MAX_RUNG_DAYS + 1
    invalidDate.asOfDate = '2027-02-29'
    expect(refused(JSON.stringify(invalidDate)).body.error.issues).toEqual([daysIssue(0)])

    const afterLast = inputOf('healthy-3-rung')
    afterLast.ladder.rungs[0].days = MAX_RUNG_DAYS + 1
    afterLast.asOfDate = addDays(afterLast.ladder.startDate, MAX_RUNG_DAYS + 2)
    expect(refused(JSON.stringify(afterLast)).body.error.issues).toEqual([daysIssue(0)])
  })
})

describe('the largest legal body, re-measured with thirteen-digit principals (SPEC §8, §12)', () => {
  // Every bound of §2.2 and §8.5 at its maximum: 12 rungs at 1e12 pesos, 6 entities, 8-character
  // ids, 60-character names, compact JSON.stringify. The fiscal and rate values are free in the
  // schema, so three figures are measured: ordinary values, the longest number spellings found,
  // and names and ids of control characters, which serialize as six bytes each.
  interface Variant {
    label: string
    char: string
    ea: number
    retencionRate: number
    insuranceCeiling: number
    bytes: number
  }
  function largest({ char, ea, retencionRate, insuranceCeiling }: Variant): RawRequest {
    const id = (n: number) => char.repeat(8 - String(n).length) + String(n)
    const entities = Array.from({ length: 6 }, (_, i) => ({
      id: id(i),
      name: char.repeat(59) + String(i),
    }))
    const rungs = Array.from({ length: 12 }, (_, i) => ({
      id: id(i + 10),
      principal: MAX_RUNG_PRINCIPAL,
      days: MAX_RUNG_DAYS - i,
      ea,
      entityId: entities[i % 6].id,
    }))
    return {
      asOfDate: '2027-01-04',
      ladder: {
        startDate: '2027-01-04',
        dayCountBase: 365,
        fiscal: { retencionRate, insuranceCeiling },
        entities,
        rungs,
      },
    }
  }
  // 24 characters as JSON.stringify writes it; the longest safe integer has 16 digits.
  const LONGEST_RATE = 0.0000012345678901234567
  const variants: Variant[] = [
    {
      label: 'ordinary values, ASCII names and ids',
      char: 'N',
      ea: 0.135,
      retencionRate: 0.04,
      insuranceCeiling: 50_000_000,
      bytes: 1759,
    },
    {
      label: 'the longest number spellings, ASCII names and ids',
      char: 'N',
      ea: LONGEST_RATE,
      retencionRate: LONGEST_RATE,
      insuranceCeiling: Number.MAX_SAFE_INTEGER,
      bytes: 2015,
    },
    {
      label: 'the longest number spellings, control-character names and ids',
      char: '\u0001',
      ea: LONGEST_RATE,
      retencionRate: LONGEST_RATE,
      insuranceCeiling: Number.MAX_SAFE_INTEGER,
      bytes: 4775,
    },
  ]

  it.each(variants)('$label', (variant) => {
    const raw = JSON.stringify(largest(variant))
    expect(String(MAX_RUNG_PRINCIPAL)).toHaveLength(13)
    expect(String(LONGEST_RATE)).toHaveLength(24)
    expect(validateRequest(raw).ok).toBe(true)
    const bytes = Buffer.byteLength(raw)
    console.info(`largest legal body, ${variant.label}: ${bytes} bytes of ${MAX_BODY_BYTES}`)
    expect(bytes).toBe(variant.bytes)
    expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES)
  })
})

describe('stages short-circuit in order (plan decision 1)', () => {
  it('a body failing schema and engine reports only schema issues', () => {
    const body = inputOf('healthy-3-rung') as unknown as {
      ladder: { rungs: Record<string, unknown>[] }
    }
    delete body.ladder.rungs[0].ea
    body.ladder.rungs[1].principal = -1
    const outcome = refused(JSON.stringify(body))
    expect(outcome.stage).toBe('schema')
    expect(outcome.body.error.issues.map((i) => i.source)).toEqual(['schema'])
  })

  it('a body failing engine and asOfDate reports only engine issues', () => {
    const body = inputOf('healthy-3-rung')
    body.ladder.rungs[0].principal = -1
    body.asOfDate = '2027-02-29'
    const outcome = refused(JSON.stringify(body))
    expect(outcome.stage).toBe('engine')
    expect(outcome.body.error.issues.map((i) => i.source)).toEqual(['engine'])
  })
})

describe('valid cases', () => {
  it.each([...VALID_CASES])('$id passes the whole pipeline unchanged', (c) => {
    const outcome = validateRequest(bodyOf(c))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.request).toEqual(c.input)
  })
})
