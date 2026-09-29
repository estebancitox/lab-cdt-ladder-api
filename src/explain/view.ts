import { computeScenario, dayNumber, formatCOP, formatDateShort, formatPercent } from '../engine'
import type { EntityExposure, RungResult } from '../engine'
import type { ExplainRequest } from '../request/schema'
import { sweepClusters } from './clusters'
import type { EntityView, Figures, RungView } from './types'

/**
 * Every figure of the SPEC §3.3 view except `risks`, from a request that validateRequest has
 * accepted. Everything the engine already computes (period rate, rounding, totals, maturity
 * dates, exposure, exceeded, excess, formatting) is taken from computeScenario and the
 * engine's formatters. This layer adds only the derivations SPEC §3.1 names: share of
 * capital, headroom and maturity clusters here, the rate gap in risks.ts.
 */
export function buildFigures(request: ExplainRequest): Figures {
  const { asOfDate, ladder } = request
  const result = computeScenario(ladder)
  const entityNames = new Map(ladder.entities.map((e) => [e.id, e.name] as const))
  const nameOf = (entityId: string): string => {
    const name = entityNames.get(entityId)
    if (name === undefined)
      throw new Error(`entity ${entityId} is not in the ladder; validate first`)
    return name
  }

  // SPEC §3.3: sorted by maturityDate, ties by rungId, index 1-based after the sort. The
  // engine's comparator returns 0 on equal dates, so the tiebreak is added here.
  const perRung = [...result.rungs]
    .sort(byMaturityThenRungId)
    .map((r, i) => rungView(r, i + 1, nameOf(r.entityId)))

  const { totals } = result
  const perEntity = result.exposures.map((e) => entityView(e, totals.principal))
  const clusters = sweepClusters(perRung)

  const lastMaturity = perRung[perRung.length - 1].maturityDate
  // Earliest maturity on or after asOfDate. The pipeline's second asOfDate rule guarantees
  // asOfDate <= lastMaturity, so the search cannot come back empty.
  const next = perRung.find((r) => r.maturityDate >= asOfDate)
  if (next === undefined) throw new Error('asOfDate is after the last maturity; validate first')
  const nextMaturity = next.maturityDate

  return {
    totals: {
      principal: totals.principal,
      principalDisplay: formatCOP(totals.principal),
      grossInterest: totals.grossInterest,
      grossInterestDisplay: formatCOP(totals.grossInterest),
      retencion: totals.retencion,
      retencionDisplay: formatCOP(totals.retencion),
      netInterest: totals.netInterest,
      netInterestDisplay: formatCOP(totals.netInterest),
    },
    blendedEA: result.blendedEA,
    blendedEADisplay: formatPercent(result.blendedEA),
    rungCount: perRung.length,
    entityCount: perEntity.length,
    clusterCount: clusters.length,
    nextMaturity,
    nextMaturityDisplay: formatDateShort(nextMaturity),
    daysToNextMaturity: dayNumber(nextMaturity) - dayNumber(asOfDate),
    lastMaturity,
    lastMaturityDisplay: formatDateShort(lastMaturity),
    perRung,
    perEntity,
    clusters,
  }
}

function byMaturityThenRungId(a: RungResult, b: RungResult): number {
  if (a.maturityDate !== b.maturityDate) return a.maturityDate < b.maturityDate ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

function rungView(r: RungResult, index: number, entityName: string): RungView {
  return {
    index,
    rungId: r.id,
    entityId: r.entityId,
    entityName,
    principal: r.principal,
    principalDisplay: formatCOP(r.principal),
    days: r.days,
    ea: r.ea,
    eaDisplay: formatPercent(r.ea),
    maturityDate: r.maturityDate,
    maturityDateDisplay: formatDateShort(r.maturityDate),
    grossInterest: r.grossInterest,
    grossInterestDisplay: formatCOP(r.grossInterest),
    retencion: r.retencion,
    retencionDisplay: formatCOP(r.retencion),
    netInterest: r.netInterest,
    netInterestDisplay: formatCOP(r.netInterest),
  }
}

function entityView(e: EntityExposure, totalPrincipal: number): EntityView {
  // The two derivations that do not exist upstream (SPEC §3.1). Both stay off the
  // thresholds: shareOfCapital is display only, headroom is the non-negative counterpart
  // of the engine's excess (SPEC §12: no signed distance).
  const shareOfCapital = e.principal / totalPrincipal
  const headroom = Math.max(0, e.ceiling - e.exposure)
  return {
    entityId: e.entityId,
    entityName: e.entityName,
    principal: e.principal,
    principalDisplay: formatCOP(e.principal),
    interest: e.interest,
    interestDisplay: formatCOP(e.interest),
    exposure: e.exposure,
    exposureDisplay: formatCOP(e.exposure),
    ceiling: e.ceiling,
    ceilingDisplay: formatCOP(e.ceiling),
    shareOfCapital,
    shareOfCapitalDisplay: formatPercent(shareOfCapital),
    exceeded: e.exceeded,
    excess: e.excess,
    excessDisplay: formatCOP(e.excess),
    headroom,
    headroomDisplay: formatCOP(headroom),
  }
}
