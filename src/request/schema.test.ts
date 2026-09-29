import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import {
  CASES,
  INVALID_CASES,
  VALID_CASES,
  caseById,
  inputOf,
  specJsonBlockAfter,
  type RawRequest,
} from '../test-support/contract'
import { explainRequestSchema, schemaCompiler, validateShape } from './schema'
import { validateRequest } from './validate'

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#'
const SCHEMA_FILE = new URL('../../schemas/explain-request.v1.json', import.meta.url)

describe('schemas/explain-request.v1.json', () => {
  it('is the SPEC §2.2 schema, byte for byte', () => {
    const fromSpec = specJsonBlockAfter('### 2.2 Schema')
    expect(readFileSync(SCHEMA_FILE, 'utf8')).toBe(fromSpec + '\n')
    expect(explainRequestSchema).toEqual(JSON.parse(fromSpec))
  })

  it('is compiled by AJV in draft-07 mode', () => {
    expect(explainRequestSchema.$schema).toBe(DRAFT_07)
    // The compiler validateShape uses has the draft-07 meta-schema loaded and accepts the
    // schema under it; a fresh default Ajv agrees, so this is the class default.
    expect(schemaCompiler.getSchema(DRAFT_07)).toBeDefined()
    expect(schemaCompiler.validateSchema(explainRequestSchema)).toBe(true)
    expect(new Ajv().validateSchema(explainRequestSchema)).toBe(true)
  })
})

describe('schema-does-not-duplicate-the-engine (SPEC §2.1)', () => {
  // Every row of the §2.1 table: a value the schema must accept and a later layer rejects.
  // The ISO-date row is exercised twice: startDate through the engine, asOfDate through the
  // API's first rule, which itself calls the engine's parseISODate.
  interface Row {
    field: string
    mutate: (r: RawRequest) => void
    rejectedBy: 'engine' | 'asOfDate'
    code: string
  }
  const rows: Row[] = [
    {
      field: 'principal -5000000',
      mutate: (r) => void (r.ladder.rungs[0].principal = -5000000),
      rejectedBy: 'engine',
      code: 'principal_invalid',
    },
    {
      field: 'days 0',
      mutate: (r) => void (r.ladder.rungs[0].days = 0),
      rejectedBy: 'engine',
      code: 'days_invalid',
    },
    {
      field: 'ea 5',
      mutate: (r) => void (r.ladder.rungs[0].ea = 5),
      rejectedBy: 'engine',
      code: 'ea_out_of_range',
    },
    {
      field: 'retencionRate 1',
      mutate: (r) => void (r.ladder.fiscal.retencionRate = 1),
      rejectedBy: 'engine',
      code: 'retencion_out_of_range',
    },
    {
      field: 'dayCountBase 364',
      mutate: (r) => void (r.ladder.dayCountBase = 364),
      rejectedBy: 'engine',
      code: 'day_count_base_invalid',
    },
    {
      field: 'entities[].name "   "',
      mutate: (r) => void (r.ladder.entities[0].name = '   '),
      rejectedBy: 'engine',
      code: 'entity_name_empty',
    },
    {
      field: 'startDate 2026-02-31',
      mutate: (r) => void (r.ladder.startDate = '2026-02-31'),
      rejectedBy: 'engine',
      code: 'start_date_invalid',
    },
    {
      field: 'asOfDate 2026-02-31',
      mutate: (r) => void (r.asOfDate = '2026-02-31'),
      rejectedBy: 'asOfDate',
      code: 'as_of_date_invalid',
    },
    {
      field: 'entityId dangling',
      mutate: (r) => void (r.ladder.rungs[0].entityId = 'ghost'),
      rejectedBy: 'engine',
      code: 'entity_missing',
    },
  ]

  it.each(rows)(
    '$field passes the schema and is rejected by the $rejectedBy layer',
    ({ mutate, rejectedBy, code }) => {
      const body = inputOf('healthy-3-rung')
      mutate(body)
      expect(validateShape(body)).toMatchObject({ ok: true })
      const outcome = validateRequest(JSON.stringify(body))
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.stage).toBe(rejectedBy)
      expect(outcome.body.error.issues.map((i) => ('code' in i ? i.code : i.keyword))).toContain(
        code,
      )
    },
  )
})

describe('shape rules the schema does own', () => {
  it('reports a missing required field at the path SPEC §7.1 shows', () => {
    const body = inputOf('healthy-3-rung') as unknown as {
      ladder: { rungs: Record<string, unknown>[] }
    }
    delete body.ladder.rungs[0].ea
    expect(validateShape(body)).toEqual({
      ok: false,
      issues: [{ source: 'schema', keyword: 'required', path: '/ladder/rungs/0/ea' }],
    })
  })

  it('rejects rollover through additionalProperties, naming the property (SPEC §6)', () => {
    const body = inputOf('healthy-3-rung') as unknown as { ladder: Record<string, unknown> }
    body.ladder.rollover = { mode: 'cycles', cycles: 2 }
    expect(validateShape(body)).toEqual({
      ok: false,
      issues: [{ source: 'schema', keyword: 'additionalProperties', path: '/ladder/rollover' }],
    })
  })

  it('accepts a 60-character entity name and rejects 61 (SPEC §8.1: rejected, never truncated)', () => {
    const body = inputOf('healthy-3-rung')
    body.ladder.entities[0].name = 'x'.repeat(60)
    expect(validateShape(body).ok).toBe(true)
    body.ladder.entities[0].name = 'x'.repeat(61)
    expect(validateShape(body)).toEqual({
      ok: false,
      issues: [{ source: 'schema', keyword: 'maxLength', path: '/ladder/entities/0/name' }],
    })
  })

  it('caps rungs at 12 and entities at 6 (SPEC §8)', () => {
    const body = inputOf('twelve-rungs')
    expect(validateShape(body).ok).toBe(true)
    const thirteen = structuredClone(body)
    thirteen.ladder.rungs.push({ ...body.ladder.rungs[0], id: 'r13' })
    expect(validateShape(thirteen)).toMatchObject({
      ok: false,
      issues: [{ keyword: 'maxItems', path: '/ladder/rungs' }],
    })
    const seven = structuredClone(body)
    seven.ladder.entities.push({ id: 'e7', name: 'Entidad G' })
    expect(validateShape(seven)).toMatchObject({
      ok: false,
      issues: [{ keyword: 'maxItems', path: '/ladder/entities' }],
    })
  })

  it('rejects bodies that are not objects', () => {
    for (const body of [null, 42, 'x', [], true]) {
      expect(validateShape(body).ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('escapes JSON Pointer tokens in property names (RFC 6901)', () => {
    const body = inputOf('healthy-3-rung') as unknown as Record<string, unknown>
    body['a/b~c'] = 1
    expect(validateShape(body)).toMatchObject({
      ok: false,
      issues: [{ keyword: 'additionalProperties', path: '/a~1b~0c' }],
    })
  })
})

describe('evals/cases.json against the schema', () => {
  it('has 10 cases; the schema accepts every valid case and negative-amount, and rejects only missing-required-field', () => {
    expect(CASES).toHaveLength(10)
    expect(INVALID_CASES.map((c) => c.id).sort()).toEqual([
      'missing-required-field',
      'negative-amount',
    ])
    for (const c of VALID_CASES) expect(validateShape(c.input).ok, c.id).toBe(true)
    expect(validateShape(caseById('negative-amount').input).ok).toBe(true)
    expect(validateShape(caseById('missing-required-field').input).ok).toBe(false)
  })
})
