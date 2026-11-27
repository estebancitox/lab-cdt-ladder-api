import { readFileSync } from 'node:fs'
import type { EvalCase } from './suite'

/** SPEC §10: the version of evals/cases.json this harness runs and replays. */
export const CASES_VERSION = 2

/**
 * The cases of evals/cases.json, refused when the file is not the version this code is written
 * for: the rule names and the injection case differ between versions (§10.1), so a run against
 * another version would measure something else.
 */
export function loadCases(path = 'evals/cases.json'): EvalCase[] {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; cases: EvalCase[] }
  if (file.version !== CASES_VERSION) {
    throw new Error(
      `${path} is version ${String(file.version)}, and this harness runs version ${CASES_VERSION} (SPEC §10)`,
    )
  }
  return file.cases
}
