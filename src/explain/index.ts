import type { ExplainRequest } from '../request/schema'
import { evaluateRisks } from './risks'
import type { ExplanationView } from './types'
import { buildFigures } from './view'

/**
 * The SPEC §3.3 explanation view: the figures plus the four risks and `selected`. Expects a
 * request that validateRequest has accepted. Internal, never serialized to a client.
 */
export function buildExplanationView(request: ExplainRequest): ExplanationView {
  const figures = buildFigures(request)
  return { ...figures, risks: evaluateRisks(figures) }
}

export * from './types'
export { buildFigures } from './view'
export { CLUSTER_MIN_RUNGS, CLUSTER_WINDOW_DAYS, sweepClusters } from './clusters'
export {
  MAX_SELECTED,
  PRIORITY,
  RATE_GAP_BP,
  basisPoints,
  ceilingRisk,
  clusteredRisk,
  concentrationRisk,
  evaluateRisks,
  rateGapRisk,
  selectRisks,
} from './risks'
