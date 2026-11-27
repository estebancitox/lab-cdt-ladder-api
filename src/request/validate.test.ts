import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, formatCOP, validateScenario, type ScenarioInput } from '../engine'
import { formatDateLong } from '../model/payload'
import {
  SPEC_MD,
  VALID_CASES,
  bodyOf,
  caseById,
  inputOf,
  specErrorMessage,
  specSection,
  tableRows,
  type RawRequest,
} from '../test-support/contract'
import { ERROR_MESSAGE } from './errors'
import { validateShape } from './schema'
import {
  MAX_BODY_BYTES,
  MAX_MATURITY_DATE,
  MAX_RUNG_DAYS,
  MAX_RUNG_PRINCIPAL,
  validateRequest,
} from './validate'

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
          message: 'The request body is not valid JSON.',
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

describe('a JSON -0 is read as 0 (SPEC §7.3)', () => {
  it('in the fiscal fields and in a rung, written in any form, as text and as bytes', () => {
    // JSON.stringify never writes -0, so only a hand-written body carries one.
    expect(JSON.stringify(-0)).toBe('0')
    const raw = bodyOf(caseById('healthy-3-rung'))
      .replace('"retencionRate":0.04', '"retencionRate":-0.0')
      .replace('"insuranceCeiling":50000000', '"insuranceCeiling":-0')
      .replace('"ea":0.135', '"ea":-0e3')
    expect(JSON.parse(raw).ladder.fiscal.insuranceCeiling).toBe(-0)
    for (const body of [raw, Buffer.from(raw, 'utf8')]) {
      const outcome = validateRequest(body)
      if (!outcome.ok) throw new Error('expected the body to be accepted')
      const { fiscal, rungs } = outcome.request.ladder
      // toBe compares with Object.is, which tells 0 from -0.
      expect(fiscal.retencionRate).toBe(0)
      expect(fiscal.insuranceCeiling).toBe(0)
      expect(rungs[0].ea).toBe(0)
    }
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
          message: 'The as-of date is not valid.',
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
          message: "The as-of date is after the ladder's last maturity.",
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
    message: 'The amount cannot exceed COP 1,000,000,000,000.',
  })
  const daysIssue = (i: number) => ({
    source: 'api',
    code: 'days_out_of_range',
    path: `rungs[${i}].days`,
    message: 'The term cannot exceed 3,650 days.',
  })
  const maturityIssue = (i: number) => ({
    source: 'api',
    code: 'maturity_out_of_range',
    path: `rungs[${i}].days`,
    message: 'The maturity cannot be later than 31 December 9999.',
  })
  /** Case 1 started on `startDate`, every rung with the term `days`, asOfDate the start. */
  function startingOn(startDate: string, days: number): RawRequest {
    const body = inputOf('healthy-3-rung')
    body.asOfDate = startDate
    body.ladder.startDate = startDate
    for (const rung of body.ladder.rungs) rung.days = days
    return body
  }

  it('the limits are the SPEC §8 rows', () => {
    expect(SPEC_MD).toContain('| Rung term `days` | at most 3650 |')
    expect(SPEC_MD).toContain('| Rung `principal` | at most 1e12 pesos |')
    expect(SPEC_MD).toContain('| Rung maturity, `startDate` plus `days` | at most 9999-12-31 |')
    expect(MAX_RUNG_DAYS).toBe(3650)
    expect(MAX_RUNG_PRINCIPAL).toBe(1e12)
    expect(MAX_MATURITY_DATE).toBe('9999-12-31')
  })

  it('the maturity limit is inclusive, at the longest term and at the shortest', () => {
    // 9990-01-03 is the earliest start from which a 3650-day term passes 9999-12-31.
    expect(addDays('9990-01-02', MAX_RUNG_DAYS)).toBe(MAX_MATURITY_DATE)
    expect(addDays('9990-01-03', MAX_RUNG_DAYS)).toBe('10000-01-01')
    expect(validateRequest(JSON.stringify(startingOn('9990-01-02', MAX_RUNG_DAYS))).ok).toBe(true)
    const longest = refused(JSON.stringify(startingOn('9990-01-03', MAX_RUNG_DAYS)))
    expect(longest.stage).toBe('range')
    expect(longest.status).toBe(400)
    expect(longest.body.error).toEqual({
      code: 'invalid_input',
      issues: [maturityIssue(0), maturityIssue(1), maturityIssue(2)],
    })
    expectErrorMessageBytes(longest.body.text)

    expect(validateRequest(JSON.stringify(startingOn('9999-12-30', 1))).ok).toBe(true)
    expect(refused(JSON.stringify(startingOn('9999-12-31', 1))).body.error.issues).toEqual([
      maturityIssue(0),
      maturityIssue(1),
      maturityIssue(2),
    ])
  })

  it('a term over its own limit gets only the term issue, never the maturity issue too', () => {
    const body = startingOn('9999-01-01', 90)
    body.ladder.rungs[1].days = MAX_RUNG_DAYS + 1
    expect(refused(JSON.stringify(body)).body.error.issues).toEqual([daysIssue(1)])
  })

  it('issues come by rung, the principal before the term or the maturity within a rung', () => {
    // From 9999-06-01, 300 days matures in 10000; 90 days stays in 9999.
    const body = startingOn('9999-06-01', 90)
    Object.assign(body.ladder.rungs[0], { principal: MAX_RUNG_PRINCIPAL + 1, days: 300 })
    body.ladder.rungs[2].days = MAX_RUNG_DAYS + 1
    expect(refused(JSON.stringify(body)).body.error.issues).toEqual([
      principalIssue(0),
      maturityIssue(0),
      daysIssue(2),
    ])
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
  // schema, so three figures are measured: ordinary values, the longest number spellings, and
  // the maximum, with every character of every id and name written as a six-byte escape.
  interface Variant {
    label: string
    escaped: boolean
    ea: number
    retencionRate: number
    insuranceCeiling: number
    bytes: number
  }
  /** Control characters JSON.stringify writes as `\u00XX`, six bytes; none is trimmed. */
  const SIX_BYTE = Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).filter(
    (c) => JSON.stringify(c).length === 8 && c.trim() !== '',
  )
  function largest({ escaped, ea, retencionRate, insuranceCeiling }: Variant): RawRequest {
    // Ids are distinct, as the engine requires; names need not be.
    const id = (n: number) => (escaped ? SIX_BYTE[n].repeat(8) : String(n).padStart(8, 'N'))
    const name = (n: number) => (escaped ? SIX_BYTE[n].repeat(60) : String(n).padStart(60, 'N'))
    const entities = Array.from({ length: 6 }, (_, i) => ({ id: id(i), name: name(i) }))
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
  // 24 characters as JSON.stringify writes it, the most a rate below 1 can take; the longest
  // safe integer has 16 digits, and the engine refuses a negative ceiling.
  const LONGEST_RATE = 0.0000012345678901234567
  const variants: Variant[] = [
    {
      label: 'ordinary values, ASCII names and ids',
      escaped: false,
      ea: 0.135,
      retencionRate: 0.04,
      insuranceCeiling: 50_000_000,
      bytes: 1759,
    },
    {
      label: 'the longest number spellings, ASCII names and ids',
      escaped: false,
      ea: LONGEST_RATE,
      retencionRate: LONGEST_RATE,
      insuranceCeiling: Number.MAX_SAFE_INTEGER,
      bytes: 2015,
    },
    {
      label: 'the maximum: the longest numbers, every id and name character a six-byte escape',
      escaped: true,
      ea: LONGEST_RATE,
      retencionRate: LONGEST_RATE,
      insuranceCeiling: Number.MAX_SAFE_INTEGER,
      bytes: 5015,
    },
  ]

  it.each(variants)('$label', (variant) => {
    const raw = JSON.stringify(largest(variant))
    expect(String(MAX_RUNG_PRINCIPAL)).toHaveLength(13)
    expect(String(LONGEST_RATE)).toHaveLength(24)
    expect(SIX_BYTE.length).toBeGreaterThanOrEqual(22)
    expect(validateRequest(raw).ok).toBe(true)
    const bytes = Buffer.byteLength(raw)
    console.info(`largest legal body, ${variant.label}: ${bytes} bytes of ${MAX_BODY_BYTES}`)
    expect(bytes).toBe(variant.bytes)
    expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES)
  })
})

describe('the six API messages are those of SPEC §7.3 and §8.5', () => {
  /** code → [path, message], from a table whose first three columns are Code, Path, Message. */
  const rowsOf = (section: string, header: string) =>
    new Map(
      tableRows(section, header).flatMap(([codes, path, message]) =>
        [...codes.matchAll(/`([a-z_]+)`/g)].map(([, code]) => [code, { path, message }] as const),
      ),
    )
  const api = rowsOf(
    specSection('### 7.3 API issues', '### 7.4'),
    '| Code | Path | Message | Row of the §7 table |',
  )
  const range = rowsOf(specSection('### 8.5 Per-rung range limits', '### 8.6'), '| Code | Path | Message |')
  const issueOf = (body: unknown) => {
    const { issues } = refused(typeof body === 'string' ? body : JSON.stringify(body)).body.error
    expect(issues).toHaveLength(1)
    return issues[0] as { source: string; code: string; path: string; message: string }
  }

  it('§7.3 has six codes, three of them given in §8.5', () => {
    expect([...api.keys()]).toEqual([
      'invalid_json',
      'principal_out_of_range',
      'days_out_of_range',
      'maturity_out_of_range',
      'as_of_date_invalid',
      'as_of_date_after_last_maturity',
    ])
    expect([...range.keys()]).toEqual([
      'principal_out_of_range',
      'days_out_of_range',
      'maturity_out_of_range',
    ])
    for (const code of range.keys()) expect(api.get(code)?.message).toBe('given in §8.5')
  })

  it('invalid_json and the two asOfDate codes carry the message and the path of their §7.3 row', () => {
    const invalidDate = inputOf('healthy-3-rung')
    invalidDate.asOfDate = '2027-02-31'
    const late = inputOf('healthy-3-rung')
    late.asOfDate = addDays(lastMaturityOf(late), 1)
    for (const [code, body] of [
      ['invalid_json', '{not json'],
      ['as_of_date_invalid', invalidDate],
      ['as_of_date_after_last_maturity', late],
    ] as const) {
      const issue = issueOf(body)
      expect(issue).toMatchObject({ source: 'api', code })
      expect(issue.message, code).toBe(api.get(code)?.message)
      // The empty path is written `""` in the table; the other two name the field.
      expect(issue.path, code).toBe(code === 'invalid_json' ? '' : 'asOfDate')
      expect(api.get(code)?.path, code).toContain(code === 'invalid_json' ? '`""`' : '`asOfDate`')
    }
  })

  it('the three range codes carry the message of their §8.5 row, on the path of the rung', () => {
    const overPrincipal = inputOf('healthy-3-rung')
    overPrincipal.ladder.rungs[1].principal = MAX_RUNG_PRINCIPAL + 1
    const overDays = inputOf('healthy-3-rung')
    overDays.ladder.rungs[1].days = MAX_RUNG_DAYS + 1
    const overMaturity = inputOf('healthy-3-rung')
    overMaturity.ladder.startDate = '9999-12-01'
    overMaturity.asOfDate = '9999-12-01'
    overMaturity.ladder.rungs.forEach((rung) => (rung.days = 30))
    overMaturity.ladder.rungs[1].days = 31
    for (const [code, body, field] of [
      ['principal_out_of_range', overPrincipal, 'principal'],
      ['days_out_of_range', overDays, 'days'],
      ['maturity_out_of_range', overMaturity, 'days'],
    ] as const) {
      const issue = issueOf(body)
      expect(issue).toMatchObject({ source: 'api', code, path: `rungs[1].${field}` })
      expect(issue.message, code).toBe(range.get(code)?.message)
      expect(range.get(code)?.path, code).toBe(`\`rungs[i].${field}\``)
    }
  })

  it('the amount and the term are written as the engine prints them, the date in the long form', () => {
    expect(range.get('principal_out_of_range')?.message).toBe(
      `The amount cannot exceed ${formatCOP(MAX_RUNG_PRINCIPAL)}.`,
    )
    expect(range.get('days_out_of_range')?.message).toBe(
      `The term cannot exceed ${formatCOP(MAX_RUNG_DAYS).replace('COP ', '')} days.`,
    )
    expect(range.get('maturity_out_of_range')?.message).toBe(
      `The maturity cannot be later than ${formatDateLong(MAX_MATURITY_DATE)}.`,
    )
  })
})

describe('SPEC §7.2: the 14 engine issues, each from an input with that one defect', () => {
  const rows = tableRows(
    specSection('### 7.2 Engine validation issues', '### 7.3'),
    '| Code | Path | Message |',
  ).map(([code, path, message]) => ({
    code: code.replace(/`/g, ''),
    path: path.replace(/`/g, ''),
    message,
  }))
  const base = (): ScenarioInput => structuredClone(inputOf('healthy-3-rung').ladder) as ScenarioInput
  const withDefect = (change: (ladder: ScenarioInput) => void): ScenarioInput => {
    const ladder = base()
    change(ladder)
    return ladder
  }
  /** One input per code, in the order of the table. */
  const defects: Record<string, ScenarioInput> = {
    start_date_invalid: withDefect((l) => (l.startDate = '2027-02-31')),
    rungs_empty: withDefect((l) => (l.rungs = [])),
    entity_id_duplicate: withDefect((l) => {
      // The second entry takes the first one's id, and its rung moves with it.
      const [first, second] = l.entities
      for (const rung of l.rungs) if (rung.entityId === second.id) rung.entityId = first.id
      second.id = first.id
    }),
    entity_name_empty: withDefect((l) => (l.entities[0].name = '   ')),
    principal_invalid: withDefect((l) => (l.rungs[0].principal = -5_000_000)),
    days_invalid: withDefect((l) => (l.rungs[0].days = 0)),
    ea_out_of_range: withDefect((l) => (l.rungs[0].ea = 5)),
    entity_missing: withDefect((l) => (l.rungs[0].entityId = 'nowhere')),
    rollover_cycles_invalid: withDefect((l) => (l.rollover = { mode: 'cycles', cycles: 37 })),
    rollover_horizon_invalid: withDefect(
      (l) => (l.rollover = { mode: 'horizon', horizonDate: '2028-02-30' }),
    ),
    rollover_horizon_before_start: withDefect(
      (l) => (l.rollover = { mode: 'horizon', horizonDate: l.startDate }),
    ),
    day_count_base_invalid: withDefect((l) => ((l.dayCountBase as number) = 364)),
    retencion_out_of_range: withDefect((l) => (l.fiscal.retencionRate = 1)),
    ceiling_invalid: withDefect((l) => (l.fiscal.insuranceCeiling = -1)),
  }

  it('the table has 14 rows, and the base input has no defect', () => {
    expect(rows).toHaveLength(14)
    expect(rows.map((row) => row.code)).toEqual(Object.keys(defects))
    expect(validateScenario(base())).toEqual([])
  })

  it.each(Object.keys(defects))('%s: the code, the path and the message of its row', (code) => {
    const row = rows.find((r) => r.code === code)
    expect(validateScenario(defects[code])).toEqual([row])
  })

  it('no message holds a Spanish word of the SPEC §11.8 list, a peso sign or a spaced percent', () => {
    const list = /`(\\b\(el\|la\|[^`]+)`/.exec(specSection('### 11.8', '### 11.9'))
    if (!list) throw new Error('the Spanish list was not found in SPEC §11.8')
    for (const { code, message } of rows) {
      expect(message.match(new RegExp(list[1], 'gi')), code).toBeNull()
      expect(message, code).not.toMatch(/\$| %/)
    }
  })

  it('four of the 14 cannot reach a client: the schema refuses the body first', () => {
    for (const code of ['rollover_cycles_invalid', 'rollover_horizon_invalid', 'rungs_empty']) {
      const body = { asOfDate: '2027-01-04', ladder: defects[code] }
      expect(refused(JSON.stringify(body)).stage, code).toBe('schema')
    }
    const body = { asOfDate: '2027-01-04', ladder: defects.rollover_horizon_before_start }
    expect(refused(JSON.stringify(body)).stage).toBe('schema')
  })

  it('the other ten reach a client verbatim, tagged with their source', () => {
    const reachable = rows.filter((row) => !row.code.startsWith('rollover_') && row.code !== 'rungs_empty')
    expect(reachable).toHaveLength(10)
    for (const row of reachable) {
      const outcome = refused(JSON.stringify({ asOfDate: '2027-01-04', ladder: defects[row.code] }))
      expect(outcome.stage, row.code).toBe('engine')
      expect(outcome.body.error.issues, row.code).toEqual([{ source: 'engine', ...row }])
    }
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
