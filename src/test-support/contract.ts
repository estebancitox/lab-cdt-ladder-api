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

/** SPEC §10: the cases file in force is version 2. */
export const CASES_VERSION: number = suite.version
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

/** The text of SPEC.md from the first occurrence of `from` up to the next occurrence of `to`. */
export function specSection(from: string, to: string): string {
  const start = SPEC_MD.indexOf(from)
  const end = SPEC_MD.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`SPEC.md section not found: ${from}`)
  return SPEC_MD.slice(start, end)
}

/** The fenced blocks of a piece of SPEC.md, without their fences and without indentation. */
export function fencedBlocks(section: string): string[] {
  return [...section.matchAll(/^( *)```[a-z]*\n([\s\S]*?)\n\1```$/gm)].map(([, indent, body]) =>
    body
      .split('\n')
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join('\n'),
  )
}

/** A constructed reply of SPEC §10.2, Example 1 (case 2) or Example 2 (case 10), as written. */
export function specExample(n: 1 | 2): string {
  const at = SPEC_MD.indexOf(`Example ${n}, for case `)
  if (at < 0) throw new Error(`Example ${n} not found in SPEC.md §10.2`)
  const [block] = fencedBlocks(SPEC_MD.slice(at))
  if (block === undefined) throw new Error(`no fenced block after Example ${n}`)
  return block
}

/** The body rows of the SPEC.md table under `header`, up to the first blank line, as cells. */
export function specTableRows(header: string): string[][] {
  return tableRows(SPEC_MD, header)
}

/** The same for a piece of SPEC.md, where two sections head a table alike. */
export function tableRows(text: string, header: string): string[][] {
  const at = text.indexOf(`${header}\n`)
  if (at < 0) throw new Error(`table not found in SPEC.md: ${header}`)
  const lines = text.slice(at).split('\n')
  return lines.slice(2, lines.indexOf('')).map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  )
}

/** The rule names of the SPEC §11.12 table's first column, row by row, left to right. */
export function specRuleNames(): string[] {
  return specTableRows('| Rule | Argument and where it comes from | Applies |').flatMap(([rule]) =>
    [...rule.matchAll(/`([a-z_]+)[^`]*`/g)].map((m) => m[1]),
  )
}

/** SPEC §7 ERROR_MESSAGE, parsed from the "Fixed strings, byte-exact" block. */
export function specErrorMessage(): string {
  const m = /^ERROR_MESSAGE\s+(.+)$/m.exec(SPEC_MD)
  if (!m) throw new Error('ERROR_MESSAGE line not found in SPEC.md')
  return m[1]
}

/**
 * The stored run of SPEC §8.6, read-only: the v1 run of 2026-10-06. It is a dated record of the
 * Spanish system and no longer a source of replies known to pass verification (§10.2). It
 * remains the source of what does not depend on the language of the rules: the latencies R is
 * computed from.
 */
export const STORED_RUN = 'evals/runs/2026-10-06T19-50-56Z'
/** Both v1 runs under evals/runs/, in date order: 24 Spanish replies each. */
export const V1_RUNS = [STORED_RUN, 'evals/runs/2026-10-29T23-18-30Z'] as const

export interface StoredRun {
  caseId: string
  run: number
  status: number
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  text: string | null
}

function runsOf(directory: string): StoredRun[] {
  return (
    JSON.parse(readFileSync(new URL(`${directory}/results.json`, ROOT), 'utf8')) as {
      runs: StoredRun[]
    }
  ).runs
}

export const STORED_RUNS: readonly StoredRun[] = runsOf(STORED_RUN)

/** The 48 stored replies of v1 (SPEC §10.2), each with the run it comes from. */
export const V1_REPLIES: readonly { directory: string; caseId: string; run: number; text: string }[] =
  V1_RUNS.flatMap((directory) =>
    runsOf(directory)
      .filter((r) => r.status === 200 && r.text !== null)
      .map((r) => ({ directory, caseId: r.caseId, run: r.run, text: r.text as string })),
  )

/** The engine commit SPEC.md pins in its header. */
export function specEnginePin(): string {
  const m = /engine pinned at `([0-9a-f]{40})`/.exec(SPEC_MD)
  if (!m) throw new Error('engine pin not found in SPEC.md')
  return m[1]
}
