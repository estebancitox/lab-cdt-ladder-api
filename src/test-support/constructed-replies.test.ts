import { describe, expect, it } from 'vitest'
import { buildExplanationView } from '../explain'
import { buildModelPayload, type ModelPayload } from '../model/payload'
import { CONSTRUCTED } from './constructed-replies'
import { acceptedRequest, caseById } from './contract'

/**
 * SPEC §10.2: every figure, date and name of a constructed reply is copied from its case's view
 * and request. The rules of §11 cannot show that: `numbers_subset_of_input` asks only that a
 * figure is a member of A, so a withholding figure written where the net interest belongs would
 * pass. These tests read each figure where the reply puts it and compare it with the payload the
 * product builds for the case, slot by slot. Nothing below types a figure, a date or a name.
 */
function payloadOf(caseId: string): ModelPayload {
  const request = acceptedRequest(caseById(caseId).input)
  return buildModelPayload(request, buildExplanationView(request))
}

/** The lines of the Risks section that are not blank. */
function riskLines(text: string): string[] {
  const lines = text.split('\n')
  return lines.slice(lines.indexOf('Risks') + 1).filter((line) => line !== '')
}

/** The first section, between the two headers, as one string. */
function firstSection(text: string): string {
  const lines = text.split('\n')
  return lines.slice(1, lines.indexOf('Risks')).join('\n').trim()
}

/** One sentence per rung: "Rung 1, at <institution>, matures on <date>; rung 2, at …, on …". */
function rungSentence(p: ModelPayload): string {
  const parts = p.rungs.map((r, i) => {
    const rung = i === 0 ? 'Rung' : 'rung'
    const verb = i === 0 ? 'matures on' : 'on'
    return `${rung} ${r.number}, at ${r.institution}, ${verb} ${r.maturity}`
  })
  return `${parts.slice(0, -1).join('; ')}; and ${parts.at(-1)}.`
}

/** The bullet a reply writes for each entry of `risks`, built from the entry's own keys. */
function bulletOf(entry: ModelPayload['risks'][number]): string {
  if ('groups' in entry) {
    const [first] = entry.groups
    const last = entry.groups.at(-1)
    if (last === undefined) throw new Error('a clustered entry has no group')
    const numbers = (g: typeof first) =>
      g.rungNumbers.length === 2
        ? g.rungNumbers.join(' and ')
        : `${g.rungNumbers.slice(0, -1).join(', ')} and ${g.rungNumbers.at(-1)}`
    return entry.groupCount === 1
      ? `- ${entry.label}: rungs ${numbers(first)} mature close together, the first on ${first.firstMaturity} and the last on ${first.lastMaturity}, and they hold ${first.principal} of the principal.`
      : `- ${entry.label}: the rungs mature in ${entry.groupCount} groups of ${first.rungCount}, the first, rungs ${numbers(first)}, between ${first.firstMaturity} and ${first.lastMaturity}, and the last, rungs ${numbers(last)}, between ${last.firstMaturity} and ${last.lastMaturity}.`
  }
  if ('highestRate' in entry) {
    const [r] = entry.rungs
    return `- ${entry.label}: rung ${r.number}, at ${r.institution}, pays ${r.rateEA}, while the highest rate in the ladder is ${entry.highestRate}.`
  }
  const [i] = entry.institutions
  return 'exposure' in i
    ? `- ${entry.label}: at ${i.institution}, principal plus gross interest comes to ${i.exposure}, which is ${i.excess} above the ceiling of ${i.insuranceCeiling}.`
    : `- ${entry.label}: ${i.institution} holds ${i.principal}, which is ${i.share} of the principal.`
}

describe('SPEC §10.2: each figure, date and name of a constructed reply stands in its own slot', () => {
  const rows = CONSTRUCTED.map((r) => [r.caseId, r.text] as const)

  it.each(rows)('%s: the principal, the counts, the withholding tax and the net interest', (caseId, text) => {
    const p = payloadOf(caseId)
    const section = firstSection(text)
    const where =
      p.institutionCount === 1
        ? `in 1 rung at 1 institution, ${p.institutions[0].institution}.`
        : `in ${p.rungCount} rungs across ${p.institutionCount} institutions`
    expect(section.startsWith(`Your ladder holds ${p.totals.principal} ${where}`)).toBe(true)
    expect(
      section.endsWith(
        `After withholding tax of ${p.totals.withholdingTax}, the ladder pays ${p.totals.netInterest} in net interest.`,
      ),
    ).toBe(true)
    // The two totals are different figures in every case, so one cannot stand for the other.
    expect(p.totals.withholdingTax).not.toBe(p.totals.netInterest)
    expect(section).not.toContain(p.totals.grossInterest)
  })

  it.each(rows)('%s: each rung with its own institution and its own maturity', (caseId, text) => {
    const p = payloadOf(caseId)
    const section = firstSection(text)
    if (p.rungCount === 1) {
      expect(section).toContain(`The rung matures on ${p.rungs[0].maturity}.`)
    } else if (p.rungCount <= 6) {
      expect(section).toContain(rungSentence(p))
    } else {
      // Above six rungs the reply summarizes: every institution once, the first and the last date.
      const names = p.institutions.map((i) => i.institution)
      expect(section).toContain(
        `institutions: ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`,
      )
      expect(section).toContain(
        `The first rung matures on ${p.rungs[0].maturity} and the last on ${p.lastMaturity}.`,
      )
      expect(p.rungs.at(-1)?.maturity).toBe(p.lastMaturity)
    }
  })

  it.each(rows)('%s: one bullet per selected risk, each with the figures of its own entry', (caseId, text) => {
    const p = payloadOf(caseId)
    expect(riskLines(text)).toEqual(
      p.risks.length === 0 ? ['No risks to flag with this data.'] : p.risks.map(bulletOf),
    )
  })

  it('the entries the bullets read have one institution, one group or one rung where the bullet names one', () => {
    for (const { caseId } of CONSTRUCTED) {
      for (const entry of payloadOf(caseId).risks) {
        if ('groups' in entry) expect(entry.groups).toHaveLength(entry.groupCount)
        else if ('highestRate' in entry) expect(entry.rungs).toHaveLength(1)
        else expect(entry.institutions).toHaveLength(1)
      }
    }
  })

  it('a figure moved to another slot is caught here, where the rules of §11 pass it', () => {
    // Case 2 with its withholding tax and its net interest exchanged: both are members of A.
    const p = payloadOf('ceiling-exceeded-one-entity')
    const text = CONSTRUCTED.find((r) => r.caseId === 'ceiling-exceeded-one-entity')?.text ?? ''
    const swapped = text
      .replace(p.totals.withholdingTax, '\u0000')
      .replace(p.totals.netInterest, p.totals.withholdingTax)
      .replace('\u0000', p.totals.netInterest)
    expect(swapped).not.toBe(text)
    expect(
      firstSection(swapped).endsWith(
        `After withholding tax of ${p.totals.withholdingTax}, the ladder pays ${p.totals.netInterest} in net interest.`,
      ),
    ).toBe(false)
  })
})
