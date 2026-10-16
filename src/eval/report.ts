import type { EvalCase, RunRecord, SuiteResult } from './suite'

/**
 * The measurement as Markdown: a summary table, then one section per case with a rule × run
 * table, the exact evidence of every failure, a Classification column left empty for the
 * owner's review, and each run's figures and reply verbatim.
 */
export function renderReport(result: SuiteResult, cases: readonly EvalCase[]): string {
  const out: string[] = []
  const totalCost = sum(result.runs.map((r) => r.costUsd ?? 0))
  out.push(`# Evaluation run ${result.startedAt}`)
  out.push('')
  out.push(
    `Model: \`${result.model}\` · Prompt: ${result.promptVersion} · Prices: $${result.priceUsdPerMtok.input} / $${result.priceUsdPerMtok.output} per MTok (input / output) · Runs: ${result.runs.length} · Model calls: ${sum(result.runs.map((r) => r.calls))} · Cost: $${totalCost.toFixed(6)}`,
  )
  out.push('')
  out.push(
    '| # | Case | Runs | Rules passed per run | Input tokens | Output tokens | Latency ms | Cost USD |',
  )
  out.push('|---|---|---|---|---|---|---|---|')
  for (const c of cases) {
    const runs = result.runs.filter((r) => r.caseId === c.id)
    if (runs.length === 0) continue
    const passed = runs
      .map((r) => `${r.verdicts.filter((v) => v.pass).length}/${r.verdicts.length}`)
      .join(', ')
    out.push(
      `| ${runs[0].position} | ${c.id} | ${runs.length} | ${passed} | ${sum(runs.map((r) => r.inputTokens ?? 0))} | ${sum(runs.map((r) => r.outputTokens ?? 0))} | ${runs.map((r) => r.latencyMs ?? '-').join(', ')} | ${sum(runs.map((r) => r.costUsd ?? 0)).toFixed(6)} |`,
    )
  }
  for (const c of cases) {
    const runs = result.runs.filter((r) => r.caseId === c.id)
    if (runs.length === 0) continue
    out.push('')
    out.push(`## ${runs[0].position}. ${c.id}`)
    out.push('')
    out.push(`| Rule | ${runs.map((r) => `Run ${r.run}`).join(' | ')} | Classification |`)
    out.push(`|---|${runs.map(() => '---').join('|')}|---|`)
    for (const rule of c.rules) {
      const cells = runs.map((r) => {
        const v = r.verdicts.find((x) => x.rule === rule)
        if (!v) return 'not evaluated'
        return v.pass ? 'pass' : `FAIL: ${cell(v.evidence ?? '')}`
      })
      out.push(`| ${cell(rule)} | ${cells.join(' | ')} |  |`)
    }
    for (const r of runs) {
      out.push('')
      out.push(`### Run ${r.run}`)
      out.push('')
      out.push(figures(r))
      out.push('')
      out.push(quote(r.text ?? '(no text field in the body)'))
    }
  }
  out.push('')
  return out.join('\n')
}

function figures(r: RunRecord): string {
  const parts = [`status ${r.status}`, `${r.calls} model call${r.calls === 1 ? '' : 's'}`]
  if (r.inputTokens !== null && r.outputTokens !== null) {
    parts.push(`${r.inputTokens} in / ${r.outputTokens} out`, `$${(r.costUsd ?? 0).toFixed(6)}`)
  }
  if (r.latencyMs !== null) parts.push(`${r.latencyMs} ms`)
  return parts.join(' · ')
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}
