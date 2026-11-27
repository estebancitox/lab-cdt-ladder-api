import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadCases } from './cases'
import { renderReport } from './report'
import { comparable, replay } from './replay-core'
import type { SuiteResult } from './suite'

/** Where the command writes its two streams. Tests collect them; replay.ts leaves the default. */
export interface CommandOutput {
  out: (text: string) => void
  err: (text: string) => void
}

const STANDARD_STREAMS: CommandOutput = {
  out: (text) => process.stdout.write(text),
  err: (text) => console.error(text),
}

/**
 * `npm run eval:replay -- <results.json>` as a function, so its exit codes can be tested without
 * a process. It returns 0 after writing report.replay.md beside the results, 2 when no path is
 * given, and 3, having written nothing, for a run that is not comparable (SPEC §10.2): a v1 run,
 * or a file that records no prompt version and so cannot be told from one.
 */
export function replayCommand(
  path: string | undefined,
  io: CommandOutput = STANDARD_STREAMS,
): number {
  if (!path) {
    io.err('usage: npm run eval:replay -- evals/runs/<timestamp>/results.json')
    return 2
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as SuiteResult
  if (!comparable(stored)) {
    const recorded =
      typeof stored.promptVersion === 'string'
        ? `is a v1 run, Spanish replies under prompt ${stored.promptVersion}, judged by the v1 rules`
        : 'records no prompt version, so it cannot be told from a v1 run'
    io.err(
      `not comparable: ${path} ${recorded} (SPEC §10.2). Its verdicts are in the report.md beside it. Nothing was written.`,
    )
    return 3
  }
  const cases = loadCases()
  const report = renderReport(replay(stored, cases), cases)
  const out = join(dirname(path), 'report.replay.md')
  writeFileSync(out, report)
  io.out(report.slice(0, report.indexOf('\n## ')) + '\n')
  io.out(`\nwritten: ${out}\n`)
  return 0
}
