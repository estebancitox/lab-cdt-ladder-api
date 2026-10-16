import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderReport } from './report'
import { replay } from './replay-core'
import type { EvalCase, SuiteResult } from './suite'

/**
 * Re-evaluates the replies of a stored run with the rules as they are now, without paying:
 *   npm run eval:replay -- evals/runs/<timestamp>/results.json
 * Writes report.replay.md beside the results. The measurement itself is never rewritten.
 */
function main(): number {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: npm run eval:replay -- evals/runs/<timestamp>/results.json')
    return 2
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as SuiteResult
  const { cases } = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as { cases: EvalCase[] }
  const report = renderReport(replay(stored, cases), cases)
  const out = join(dirname(path), 'report.replay.md')
  writeFileSync(out, report)
  process.stdout.write(report.slice(0, report.indexOf('\n## ')) + '\n')
  process.stdout.write(`\nwritten: ${out}\n`)
  return 0
}

try {
  process.exit(main())
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exit(1)
}
