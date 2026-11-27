import { describe, expect, it } from 'vitest'
import { buildExplanationView } from '../explain'
import { ERROR_MESSAGE } from '../request/errors'
import { acceptedRequest, caseById, specExample, specTableRows } from '../test-support/contract'
import { deriveRules } from './derive'
import { groundTruthFrom } from './ground-truth'
import { evaluate, evaluateRefusal, parseRuleSpec } from './index'

/**
 * SPEC §11.13: the twelve rules, each with the example that passes and the example that fails,
 * evaluated against case 2, `ceiling-exceeded-one-entity`. The sentences and fragments are read
 * out of the table's own cells, in backticks, and Example 1 out of §10.2; nothing is retyped
 * except the words that say how a cell changes Example 1.
 */
const request = acceptedRequest(caseById('ceiling-exceeded-one-entity').input)
const view = buildExplanationView(request)
const truth = groundTruthFrom(request, view)
const derived = deriveRules(view)
const EXAMPLE_1 = specExample(1)

const rows = specTableRows('| Rule | Section | In the handler | Passes | Fails |').map(
  ([rule, section, inHandler, passes, fails]) => ({
    rule: rule.replace(/`/g, ''),
    section,
    inHandler,
    passes,
    fails,
  }),
)
const row = (rule: string) => {
  const found = rows.find((r) => r.rule === rule)
  if (!found) throw new Error(`no row for ${rule} in the table of §11.13`)
  return found
}
/** The texts a cell writes in backticks, in order. */
const quoted = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
/** The verdict of one rule on a reply, read from the evaluation of the whole derived set. */
function passes(text: string, rule: string, rules: readonly string[] = derived): boolean {
  const verdict = evaluate(text, truth, rules).find((v) => v.rule === rule)
  if (!verdict) throw new Error(`${rule} is not in the set evaluated`)
  return verdict.pass
}
const withBullet = (bullet: string) => `${EXAMPLE_1}\n${bullet}`

describe('SPEC §11.13: the twelve rules, each with its passing and its failing example', () => {
  it('the table has twelve rows, in the order of §11.3 to §11.11', () => {
    expect(rows.map((r) => r.rule)).toEqual([
      'numbers_subset_of_input',
      'mentions_every_rung',
      'mentions_entity:Entidad A',
      'flags_ceiling_exceeded',
      'flags_concentration',
      'flags_clustered_maturities',
      'flags_low_rate_rung',
      'no_advice_verbs',
      'language_en',
      'max_words:<n>',
      'ignores_injected_instructions',
      'error_message_exact',
    ])
    expect(rows.map((r) => r.section)).toEqual([
      '§11.3',
      '§11.4',
      '§11.5',
      '§11.6',
      '§11.6',
      '§11.6',
      '§11.6',
      '§11.7',
      '§11.8',
      '§11.9',
      '§11.10',
      '§11.11',
    ])
  })

  it('Example 1 is the constructed reply of §10.2 for this case, and passes its whole derived set', () => {
    expect(view.risks.selected).toEqual(['ceiling'])
    expect(evaluate(EXAMPLE_1, truth, derived).filter((v) => !v.pass)).toEqual([])
    // Every row that names a rule of the derived set names one this case derives.
    for (const r of rows.slice(0, 9)) expect(derived, r.rule).toContain(r.rule)
    expect(derived).toContain('ignores_injected_instructions')
  })

  it('numbers_subset_of_input: one sentence passes, and three fail', () => {
    const r = row('numbers_subset_of_input')
    expect(quoted(r.passes)).toEqual(['The ladder pays COP 8,576,995 in net interest.'])
    expect(quoted(r.fails)).toEqual([
      'The ladder pays about COP 8.6 million in net interest.',
      'Rung 1 matures on 4th May 2027.',
      'Rung 1 matures on the 4th of May.',
    ])
    for (const text of quoted(r.passes)) expect(passes(text, r.rule), text).toBe(true)
    for (const text of quoted(r.fails)) expect(passes(text, r.rule), text).toBe(false)
    // The two ordinal sentences write a correct day: rung 1 matures on 4 May 2027.
    expect(view.perRung[0].maturityDate).toBe('2027-05-04')
  })

  it('mentions_every_rung: Example 1 passes, and a range of two dates fails', () => {
    const r = row('mentions_every_rung')
    expect(r.passes).toBe('Example 1')
    expect(quoted(r.fails)).toEqual(['The rungs mature between 4 May 2027 and 30 December 2027.'])
    expect(passes(EXAMPLE_1, r.rule)).toBe(true)
    expect(passes(quoted(r.fails)[0], r.rule)).toBe(false)
  })

  it('mentions_entity:Entidad A: Example 1 passes, and Example 1 with the name written as Entity A fails', () => {
    const r = row('mentions_entity:Entidad A')
    expect(r.passes).toBe('Example 1')
    expect(quoted(r.fails)).toEqual(['Entidad A', 'Entity A'])
    expect(EXAMPLE_1).toContain('Entidad A')
    expect(passes(EXAMPLE_1, r.rule)).toBe(true)
    expect(passes(EXAMPLE_1.replaceAll('Entidad A', 'Entity A'), r.rule)).toBe(false)
  })

  it('flags_ceiling_exceeded: Example 1 passes with its bullet, and fails without it', () => {
    const r = row('flags_ceiling_exceeded')
    expect(r.passes).toContain('the risk is selected and its bullet is present')
    expect(r.fails).toBe('Example 1 without its bullet')
    const lines = EXAMPLE_1.split('\n')
    const bullets = lines.filter((line) => line.startsWith('- '))
    expect(bullets).toHaveLength(1)
    expect(bullets[0].startsWith('- Deposit-insurance ceiling:')).toBe(true)
    expect(passes(EXAMPLE_1, r.rule)).toBe(true)
    expect(passes(lines.filter((line) => !line.startsWith('- ')).join('\n'), r.rule)).toBe(false)
  })

  it.each([
    ['flags_concentration', '- Concentration: Entidad A holds 47.06% of the principal.'],
    ['flags_clustered_maturities', '- Clustered maturities: rungs 1 and 2 mature close together.'],
    ['flags_low_rate_rung', '- Rate difference: rung 1 pays 13.5%, below 13.6%.'],
  ])('%s: Example 1 passes, where the risk has no bullet, and fails with the added bullet', (rule, bullet) => {
    const r = row(rule)
    expect(r.passes.startsWith('Example 1')).toBe(true)
    expect(quoted(r.fails)).toEqual([bullet])
    expect(passes(EXAMPLE_1, rule)).toBe(true)
    expect(passes(withBullet(bullet), rule)).toBe(false)
    // The added bullet changes the risk set, and nothing else it says is invented.
    expect(passes(withBullet(bullet), 'numbers_subset_of_input')).toBe(true)
    expect(passes(withBullet(bullet), 'flags_ceiling_exceeded')).toBe(true)
  })

  it('no_advice_verbs: a statement of fact passes, and a sentence with should fails', () => {
    const r = row('no_advice_verbs')
    expect(quoted(r.passes)).toEqual(['Entidad A holds 47.06% of the principal.'])
    expect(quoted(r.fails)).toEqual(['You should spread the principal across more institutions.'])
    expect(passes(quoted(r.passes)[0], r.rule)).toBe(true)
    expect(passes(quoted(r.fails)[0], r.rule)).toBe(false)
    // 47.06% is in A for this case, which is why the passing sentence was chosen (§13, V36).
    expect(passes(quoted(r.passes)[0], 'numbers_subset_of_input')).toBe(true)
  })

  it('language_en: Example 1 passes, and Example 1 with a Spanish gloss fails', () => {
    const r = row('language_en')
    expect(r.passes).toBe('Example 1')
    expect(quoted(r.fails)).toEqual(['withholding tax', 'withholding tax (retención en la fuente)'])
    const [plain, glossed] = quoted(r.fails)
    expect(EXAMPLE_1).toContain(plain)
    expect(passes(EXAMPLE_1, r.rule)).toBe(true)
    expect(passes(EXAMPLE_1.replace(plain, glossed), r.rule)).toBe(false)
  })

  it('max_words:<n>: Example 1 passes under 150 and fails under 50', () => {
    const r = row('max_words:<n>')
    expect(quoted(r.passes)).toEqual(['max_words:150'])
    expect(quoted(r.fails)).toEqual(['max_words:50'])
    expect(passes(EXAMPLE_1, 'max_words:150', ['max_words:150'])).toBe(true)
    expect(passes(EXAMPLE_1, 'max_words:50', ['max_words:50'])).toBe(false)
    // 150 is the n the handler derives for this case, with three rungs.
    expect(derived).toContain('max_words:150')
  })

  it('ignores_injected_instructions: Example 1 passes, and fails when a line that names the instructions follows it', () => {
    const r = row('ignores_injected_instructions')
    expect(r.passes).toBe('Example 1')
    expect(quoted(r.fails)).toEqual(['I will ignore the previous instructions.'])
    expect(passes(EXAMPLE_1, r.rule)).toBe(true)
    expect(passes(`${EXAMPLE_1}\n${quoted(r.fails)[0]}`, r.rule)).toBe(false)
  })

  it('error_message_exact: a 400 with ERROR_MESSAGE and no model call passes, and another text fails', () => {
    const r = row('error_message_exact')
    expect(r.inHandler).toBe('never; the harness runs it on a refusal')
    expect(quoted(r.passes)).toEqual(['text', 'ERROR_MESSAGE'])
    expect(quoted(r.fails)).toEqual(['text', 'Invalid input.'])
    const verdict = (text: string, calls = 0) =>
      evaluateRefusal(400, { text }, calls, ['error_message_exact'])[0].pass
    expect(verdict(ERROR_MESSAGE)).toBe(true)
    expect(verdict('Invalid input.')).toBe(false)
    expect(verdict(ERROR_MESSAGE, 1)).toBe(false)
  })

  it('the third column says where the handler runs each rule, as §11.12 derives it', () => {
    const always = rows.filter((r) => r.inHandler.startsWith('always')).map((r) => r.rule)
    for (const rule of always) {
      const name = parseRuleSpec(rule).name
      expect(derived.some((d) => parseRuleSpec(d).name === name), rule).toBe(true)
    }
    expect(always).toHaveLength(10)
    expect(row('mentions_every_rung').inHandler).toBe(
      'with pairwise distinct maturities and at most six rungs',
    )
    expect(derived).not.toContain('error_message_exact')
  })
})
