import type {
  CeilingRisk,
  ClusteredRisk,
  ConcentrationRisk,
  Figures,
  RateGapRisk,
  RiskKey,
  Risks,
} from './types'

/** SPEC §5.3: the drop order when more risks trigger than bullets fit. Highest first. */
export const PRIORITY: readonly RiskKey[] = ['ceiling', 'concentration', 'clustered', 'rateGap']
/** SPEC §4: at most three bullets. */
export const MAX_SELECTED = 3
/** SPEC §5.4: a rung 200 or more integer basis points below the highest rate. */
export const RATE_GAP_BP = 200

/**
 * Every comparison in this file is integer arithmetic exactly as SPEC §5.4 writes it. No
 * float is ever compared against a threshold.
 */

/** SPEC §5.4: exposure > ceiling, strict. `exceeded` is that very comparison in exposure.ts. */
export function ceilingRisk(figures: Pick<Figures, 'perEntity'>): CeilingRisk {
  const entityIds = figures.perEntity.filter((e) => e.exceeded).map((e) => e.entityId)
  return { triggered: entityIds.length > 0, entityIds }
}

/** SPEC §5.4: principal * 5 > total * 3, strict. An exact 60 % tie does not trigger. */
export function concentrationRisk(figures: Pick<Figures, 'perEntity' | 'totals'>): ConcentrationRisk {
  const entityIds = figures.perEntity
    .filter((e) => exceedsConcentration(e.principal, figures.totals.principal))
    .map((e) => e.entityId)
  return { triggered: entityIds.length > 0, entityIds }
}

export function exceedsConcentration(entityPrincipal: number, totalPrincipal: number): boolean {
  return entityPrincipal * 5 > totalPrincipal * 3
}

/** SPEC §5.4: clusters[] already holds only groups of two or more rungs inside a 30-day anchor window. */
export function clusteredRisk(figures: Pick<Figures, 'clusters'>): ClusteredRisk {
  const clusterIndexes = figures.clusters.map((c) => c.index)
  return { triggered: clusterIndexes.length > 0, clusterIndexes }
}

/** SPEC §5.4: bp = Math.round(ea * 10000). The raw floats are never subtracted. */
export function basisPoints(ea: number): number {
  return Math.round(ea * 10000)
}

/** SPEC §5.4: maxBp − bp >= 200, two or more rungs required. */
export function rateGapRisk(figures: Pick<Figures, 'perRung'>): RateGapRisk {
  const bps = figures.perRung.map((r) => basisPoints(r.ea))
  const maxBp = bps.length > 0 ? Math.max(...bps) : 0
  const rungIndexes =
    figures.perRung.length >= 2
      ? figures.perRung.filter((_, i) => maxBp - bps[i] >= RATE_GAP_BP).map((r) => r.index)
      : []
  return { triggered: rungIndexes.length > 0, maxBp, rungIndexes }
}

/** SPEC §5.3: keep the triggered risks in priority order and drop everything past the third. */
export function selectRisks(triggered: Record<RiskKey, boolean>): RiskKey[] {
  return PRIORITY.filter((key) => triggered[key]).slice(0, MAX_SELECTED)
}

export function evaluateRisks(figures: Figures): Risks {
  const ceiling = ceilingRisk(figures)
  const concentration = concentrationRisk(figures)
  const clustered = clusteredRisk(figures)
  const rateGap = rateGapRisk(figures)
  const selected = selectRisks({
    ceiling: ceiling.triggered,
    concentration: concentration.triggered,
    clustered: clustered.triggered,
    rateGap: rateGap.triggered,
  })
  return { ceiling, concentration, clustered, rateGap, selected }
}
