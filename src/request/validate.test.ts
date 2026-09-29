import { afterEach, describe, expect, it, vi } from 'vitest'
import { addDays, validateScenario, type ScenarioInput } from '../engine'
import {
  VALID_CASES,
  bodyOf,
  caseById,
  inputOf,
  specErrorMessage,
  type RawRequest,
} from '../test-support/contract'
import { ERROR_MESSAGE } from './errors'
import { validateShape } from './schema'
import { MAX_BODY_BYTES, validateRequest } from './validate'

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
