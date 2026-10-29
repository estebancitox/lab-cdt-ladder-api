import { describe, expect, it } from 'vitest'
import { buildExplanationView } from '../explain'
import {
  SPEC_MD,
  STORED_RUNS,
  VALID_CASES,
  acceptedRequest,
  caseById,
  inputOf,
  specRuleNames,
  specTableRows,
  type RawRequest,
} from '../test-support/contract'
import { deriveRules, productionMaxWords } from './derive'
import { groundTruthFrom } from './ground-truth'
import { evaluate, failedRuleNames, parseRuleSpec } from './index'

function prepared(input: unknown) {
  const request = acceptedRequest(input)
  const view = buildExplanationView(request)
  return { view, truth: groundTruthFrom(request, view), rules: deriveRules(view) }
}

const namesOf = (rules: readonly string[]) => [...new Set(rules.map((r) => parseRuleSpec(r).name))]

const TABLE_NAMES = specRuleNames()
const PRODUCTION_NAMES = TABLE_NAMES.filter((name) => name !== 'error_message_exact')

const STORED_200 = STORED_RUNS.filter((r) => r.status === 200 && r.text !== null)

describe('SPEC §8.6 verification overhead', () => {
  it('nearest-rank p95 over the 24 stored replies is at most 50 ms', () => {
    // A, D, S, the entity names and the derived set are built before the window, as §8.6 states;
    // the spans, the verdicts and the issue names are built inside it.
    const inputs = STORED_200.map((r) => ({
      text: r.text as string,
      ...prepared(caseById(r.caseId).input),
    }))
    expect(inputs).toHaveLength(24)
    const ms = inputs.map(({ text, truth, rules }) => {
      const start = performance.now()
      failedRuleNames(evaluate(text, truth, rules))
      return performance.now() - start
    })
    const sorted = [...ms].sort((a, b) => a - b)
    const rank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
    const f = (x: number) => x.toFixed(3)
    console.info(
      `verification overhead over ${sorted.length} stored replies, ms: min ${f(sorted[0])}, ` +
        `p50 ${f(rank(0.5))}, p95 ${f(rank(0.95))}, max ${f(sorted[sorted.length - 1])}`,
    )
    expect(rank(0.95)).toBeLessThanOrEqual(50)
  })
})

describe('SPEC §11.12 derivation of the production rule set', () => {
  it('the table has a row for every rule of §11, in the order of its sections', () => {
    const headings = [...SPEC_MD.matchAll(/^### 11\.(?:[3-9]|1[01]) (.+)$/gm)].flatMap(([, h]) =>
      [...h.matchAll(/`([a-z_]+)[^`]*`/g)].map((m) => m[1]),
    )
    expect(TABLE_NAMES).toEqual(headings)
    expect(TABLE_NAMES).toHaveLength(12)
  })

  it.each(VALID_CASES.map((c) => [c.id, c] as const))(
    '%s: the derived names follow the table row order, flags left to right',
    (_, c) => {
      const { rules } = prepared(c.input)
      const expected = PRODUCTION_NAMES.filter(
        (name) => name !== 'mentions_every_rung' || rules.includes('mentions_every_rung'),
      )
      expect(namesOf(rules)).toEqual(expected)
      expect(rules[0]).toBe('numbers_subset_of_input')
      expect(rules.at(-1)).toBe('ignores_injected_instructions')
      expect(rules).not.toContain('error_message_exact')
    },
  )

  describe('mentions_every_rung', () => {
    const twelve = inputOf('twelve-rungs')
    const firstRungs = (n: number): RawRequest => ({
      ...twelve,
      ladder: { ...twelve.ladder, rungs: twelve.ladder.rungs.slice(0, n) },
    })

    it('applies with pairwise distinct maturities and at most six rungs', () => {
      const six = prepared(firstRungs(6))
      expect(new Set(six.view.perRung.map((r) => r.maturityDate)).size).toBe(6)
      expect(six.rules).toContain('mentions_every_rung')
    })

    it('is omitted above six rungs, distinct maturities or not', () => {
      const seven = prepared(firstRungs(7))
      expect(new Set(seven.view.perRung.map((r) => r.maturityDate)).size).toBe(7)
      expect(seven.rules).not.toContain('mentions_every_rung')
      expect(prepared(twelve).rules).not.toContain('mentions_every_rung')
    })

    it('is omitted when two rungs mature on the same day', () => {
      const input = inputOf('healthy-3-rung')
      input.ladder.rungs[1].days = input.ladder.rungs[0].days
      const { view, rules } = prepared(input)
      expect(view.perRung[0].maturityDate).toBe(view.perRung[1].maturityDate)
      expect(rules).not.toContain('mentions_every_rung')
      expect(rules).toHaveLength(PRODUCTION_NAMES.length - 1 + view.perEntity.length - 1)
    })
  })

  describe('mentions_entity', () => {
    const entityRules = (rules: readonly string[]) =>
      rules.filter((r) => parseRuleSpec(r).name === 'mentions_entity')

    it('one rule per element of perEntity, the entityName verbatim, in perEntity order', () => {
      const { view, rules } = prepared(caseById('healthy-3-rung').input)
      expect(entityRules(rules)).toEqual(
        view.perEntity.map((e) => `mentions_entity:${e.entityName}`),
      )
      expect(entityRules(rules)).toEqual([
        'mentions_entity:Banco Andino',
        'mentions_entity:Cooperativa Ñame & Café',
        'mentions_entity:Entidad B',
      ])
    })

    it('an entity with no rung gets no rule, but its name is still scanned for and masked', () => {
      const input = inputOf('healthy-3-rung')
      input.ladder.entities.push({ id: 'e9', name: 'Banco 999' })
      const { truth, rules } = prepared(input)
      expect(entityRules(rules)).not.toContain('mentions_entity:Banco 999')
      expect(truth.entityNames).toContain('Banco 999')
    })

    it('an entity whose name normalizes to the empty string gets no rule', () => {
      const input = inputOf('healthy-3-rung')
      input.ladder.entities[0].name = '**'
      input.ladder.entities[2].name = '_'
      expect(entityRules(prepared(input).rules)).toEqual([
        'mentions_entity:Cooperativa Ñame & Café',
      ])
    })

    it('identical names give one rule per element, and the issue name appears once', () => {
      const input = inputOf('healthy-3-rung')
      input.ladder.entities[0].name = 'Banco'
      input.ladder.entities[2].name = 'Banco'
      const { truth, rules } = prepared(input)
      expect(entityRules(rules).filter((r) => r === 'mentions_entity:Banco')).toHaveLength(2)
      const reply = 'Qué pasa y cuándo\n\nNada.\n\nRiesgos\n\nNada.'
      expect(failedRuleNames(evaluate(reply, truth, rules))).toEqual([
        'mentions_every_rung',
        'mentions_entity',
        'language_es',
      ])
    })

    it('a name with a colon keeps it: the rule splits on the first colon only (§10)', () => {
      const input = inputOf('healthy-3-rung')
      input.ladder.entities[0].name = 'Banco: Sur'
      const rule = entityRules(prepared(input).rules)[0]
      expect(rule).toBe('mentions_entity:Banco: Sur')
      expect(parseRuleSpec(rule)).toMatchObject({ name: 'mentions_entity', arg: 'Banco: Sur' })
    })
  })

  it('the four flags rules always, in the order of the flags row', () => {
    const row = specTableRows('| Rule | Argument and where it comes from | Applies |').find(
      ([rule]) => rule.startsWith('`flags_'),
    )
    const flags = [...(row?.[0] ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    expect(flags).toHaveLength(4)
    for (const c of VALID_CASES) {
      expect(prepared(c.input).rules.filter((r) => r.startsWith('flags_'))).toEqual(flags)
    }
  })

  it('max_words takes n from the rung count by the §4 production table', () => {
    const table = specTableRows('| Rungs | Production n | Prompt cap | Cap over budget |')
    expect(table.map(([rungs]) => rungs)).toEqual(['1 or 2', '3 or 4', '5 or more'])
    const nFor = (count: number) => {
      const [, n] = table.find(([rungs]) => {
        const [low, high] = rungs.split(' or ')
        return high === 'more' ? count >= Number(low) : count <= Number(high)
      }) as string[]
      return Number(n)
    }
    for (let count = 1; count <= 12; count += 1) {
      expect(productionMaxWords(count), `${count} rungs`).toBe(nFor(count))
    }
    for (const c of VALID_CASES) {
      const { view, rules } = prepared(c.input)
      expect(rules).toContain(`max_words:${nFor(view.rungCount)}`)
    }
  })

  it('every fixture rule is in the derived set, or is a max_words no stricter than it', () => {
    // So a reply the handler answers with 200 passes its case's own rules too.
    for (const c of VALID_CASES) {
      const { rules } = prepared(c.input)
      const derivedN = Number(parseRuleSpec(rules.find((r) => r.startsWith('max_words:'))!).arg)
      for (const rule of c.rules) {
        const spec = parseRuleSpec(rule)
        if (spec.name === 'max_words')
          expect(Number(spec.arg), c.id).toBeGreaterThanOrEqual(derivedN)
        else expect(rules, `${c.id}: ${rule}`).toContain(rule)
      }
    }
  })

  it('all 24 stored replies pass their derived set and their fixture rules', () => {
    expect(STORED_200).toHaveLength(24)
    for (const r of STORED_200) {
      const c = caseById(r.caseId)
      const { truth, rules } = prepared(c.input)
      const where = `${r.caseId} run ${r.run}`
      expect(
        evaluate(r.text as string, truth, rules).filter((v) => !v.pass),
        where,
      ).toEqual([])
      expect(
        evaluate(r.text as string, truth, c.rules).filter((v) => !v.pass),
        where,
      ).toEqual([])
    }
  })

  describe('entities whose normalized names compare equal (S9): the stored replies still pass', () => {
    // The three stored replies of healthy-3-rung name "Banco Andino", "Cooperativa Ñame & Café"
    // and "Entidad B"; each variant renames entities of the request only.
    const replies = STORED_200.filter((r) => r.caseId === 'healthy-3-rung').map((r) => r.text!)
    const variant = (
      names: Record<string, string>,
      extra: { id: string; name: string }[] = [],
      extraFirst = false,
    ) => {
      const input = inputOf('healthy-3-rung')
      for (const e of input.ladder.entities) if (names[e.id] !== undefined) e.name = names[e.id]
      input.ladder.entities = extraFirst
        ? [...extra, ...input.ladder.entities]
        : [...input.ladder.entities, ...extra]
      return input
    }
    const rows: [string, RawRequest][] = [
      ['(i) "Banco" and "BANCO", both holding rungs', variant({ e1: 'Banco', e3: 'BANCO' })],
      ['(ii) "Banco" and "Banco"', variant({ e1: 'Banco', e3: 'Banco' })],
      [
        '(iii-A) "Banco" holds, a rung-less "BANCO" listed after',
        variant({ e1: 'Banco' }, [{ id: 'e4', name: 'BANCO' }]),
      ],
      [
        '(iii-B) "BANCO" holds, a rung-less "Banco" listed after',
        variant({ e1: 'BANCO' }, [{ id: 'e4', name: 'Banco' }]),
      ],
      [
        '(iii-B2) a rung-less "Banco" listed first, "BANCO" holds',
        variant({ e1: 'BANCO' }, [{ id: 'e4', name: 'Banco' }], true),
      ],
      [
        '(iii-C) a rung-less "BANCO" listed first, "Banco" holds',
        variant({ e1: 'Banco' }, [{ id: 'e4', name: 'BANCO' }], true),
      ],
      ['(iv) "*" and "_", both empty after N', variant({ e1: '*', e3: '_' })],
      ['(v) "Banco  Andino" (two spaces) beside "Banco Andino"', variant({ e3: 'Banco  Andino' })],
      ['(vi) "banco andino" beside "Banco Andino"', variant({ e3: 'banco andino' })],
    ]

    it.each(rows)('%s', (_, input) => {
      expect(replies).toHaveLength(3)
      const { truth, rules } = prepared(input)
      for (const reply of replies)
        expect(failedRuleNames(evaluate(reply, truth, rules))).toEqual([])
    })
  })
})
