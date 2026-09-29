import { readFileSync } from 'node:fs'
import type { ExplainRequest } from '../request/schema'
import { validateRequest } from '../request/validate'

/**
 * Read-only access to the contract files for tests: SPEC.md and evals/cases.json. Nothing
 * here retypes a fixed string or a fixture; tests compare against the files themselves.
 */
const ROOT = new URL('../../', import.meta.url)

export const SPEC_MD: string = readFileSync(new URL('SPEC.md', ROOT), 'utf8')

/** A request body as cases.json carries it: plain JSON types, before any validation. */
export interface RawRequest {
  asOfDate: string
  ladder: {
    startDate: string
    dayCountBase: number
    fiscal: { retencionRate: number; insuranceCeiling: number }
    entities: { id: string; name: string }[]
    rungs: { id: string; principal: number; days: number; ea: number; entityId: string }[]
  }
}

export interface EvalCase {
  id: string
  description: string
  input: unknown
  rules: string[]
  expectIssues?: unknown[]
}

const suite = JSON.parse(readFileSync(new URL('evals/cases.json', ROOT), 'utf8')) as {
  version: number
  cases: EvalCase[]
}

export const CASES: readonly EvalCase[] = suite.cases
export const VALID_CASES: readonly EvalCase[] = CASES.filter(
  (c) => !c.rules.includes('error_message_exact'),
)
export const INVALID_CASES: readonly EvalCase[] = CASES.filter((c) =>
  c.rules.includes('error_message_exact'),
)

export function caseById(id: string): EvalCase {
  const found = CASES.find((c) => c.id === id)
  if (!found) throw new Error(`no case with id ${id} in evals/cases.json`)
  return found
}

/** A case's request body as the wire would carry it. */
export function bodyOf(c: EvalCase): string {
  return JSON.stringify(c.input)
}

/** A deep copy of a case's input, for tests that change one field. */
export function inputOf(id: string): RawRequest {
  return structuredClone(caseById(id).input) as RawRequest
}

/** A body through the real pipeline, so views are built only from accepted input. */
export function acceptedRequest(input: unknown): ExplainRequest {
  const outcome = validateRequest(JSON.stringify(input))
  if (!outcome.ok) {
    throw new Error(
      `fixture rejected at stage ${outcome.stage}: ${JSON.stringify(outcome.body.error.issues)}`,
    )
  }
  return outcome.request
}

/** The fenced ```json block that follows a heading in SPEC.md, as raw text. */
export function specJsonBlockAfter(heading: string): string {
  const at = SPEC_MD.indexOf(heading)
  if (at < 0) throw new Error(`heading not found in SPEC.md: ${heading}`)
  const open = SPEC_MD.indexOf('```json\n', at)
  if (open < 0) throw new Error(`no json block after ${heading}`)
  const start = open + '```json\n'.length
  const end = SPEC_MD.indexOf('\n```', start)
  if (end < 0) throw new Error(`unterminated json block after ${heading}`)
  return SPEC_MD.slice(start, end)
}

/** SPEC §7 ERROR_MESSAGE, parsed from the "Fixed strings, byte-exact" block. */
export function specErrorMessage(): string {
  const m = /^ERROR_MESSAGE\s+(.+)$/m.exec(SPEC_MD)
  if (!m) throw new Error('ERROR_MESSAGE line not found in SPEC.md')
  return m[1]
}

/** The engine commit SPEC.md pins in its header. */
export function specEnginePin(): string {
  const m = /engine pinned at `([0-9a-f]{40})`/.exec(SPEC_MD)
  if (!m) throw new Error('engine pin not found in SPEC.md')
  return m[1]
}
