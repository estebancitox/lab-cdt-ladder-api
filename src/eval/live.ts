import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFetchCounter } from './fetch-counter'
import { renderReport } from './report'
import { runSuite, type EvalCase } from './suite'

/**
 * The paid run: every case of evals/cases.json through the handler in process, valid cases
 * three times. Needs the key's parameter name and the AWS profile on the command line:
 *   API_KEY_PARAMETER=/lab-cdt-ladder-api/anthropic-api-key AWS_PROFILE=lab AWS_REGION=us-east-2 npm run eval:live
 * Writes evals/runs/<timestamp>/results.json and report.md. Never part of `npm test`.
 */
const RUNS_PER_VALID_CASE = 3

async function main(): Promise<number> {
  if (!process.env.API_KEY_PARAMETER) {
    console.error(
      'set API_KEY_PARAMETER to the SSM parameter that holds the key (never the key itself)',
    )
    return 2
  }
  const { cases } = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as { cases: EvalCase[] }
  const startedAt = new Date().toISOString()
  const dir = join('evals', 'runs', startedAt.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-'))
  const counter = installFetchCounter()
  console.error(`${cases.length} cases, ${RUNS_PER_VALID_CASE} runs per valid case → ${dir}`)
  let result
  try {
    result = await runSuite(cases, {
      runs: RUNS_PER_VALID_CASE,
      counter,
      startedAt,
      onRun: (r) => {
        const failed = r.verdicts.filter((v) => !v.pass).length
        const retry = r.verificationRetry ? ', verification retry' : ''
        console.error(
          `${r.caseId} run ${r.run}: status ${r.status}, ${r.calls} call(s)${retry}, ${r.inputTokens ?? '-'} in / ${r.outputTokens ?? '-'} out, ${r.latencyMs ?? '-'} ms, ${failed} rule(s) failed`,
        )
      },
    })
  } finally {
    counter.uninstall()
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  const report = renderReport(result, cases)
  writeFileSync(join(dir, 'report.md'), report)
  process.stdout.write(report.slice(0, report.indexOf('\n## ')) + '\n')
  process.stdout.write(`\nwritten: ${join(dir, 'results.json')} and ${join(dir, 'report.md')}\n`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    process.exit(1)
  },
)
