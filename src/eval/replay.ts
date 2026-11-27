import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadCases } from './cases'
import { renderReport } from './report'
import { comparable, replay } from './replay-core'
import type { SuiteResult } from './suite'

/**
 * Re-evaluates the replies of a stored run with the rules as they are now, without paying:
 *   npm run eval:replay -- evals/runs/<timestamp>/results.json
 * Writes report.replay.md beside the results. The measurement itself is never rewritten.
 *
 * A v1 run is not replayed (SPEC §10.2): the command says it is not comparable, writes nothing
 * and exits 3. Exit 2 is a usage error and 1 any other failure.
 */
function main(): number {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: npm run eval:replay -- evals/runs/<timestamp>/results.json')
    return 2
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as SuiteResult
  if (!comparable(stored)) {
    console.error(
      `not comparable: ${path} is a v1 run, Spanish replies under prompt ${stored.promptVersion}, judged by the v1 rules (SPEC §10.2). Its verdicts are in the report.md beside it. Nothing was written.`,
    )
    return 3
  }
  const cases = loadCases()
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
