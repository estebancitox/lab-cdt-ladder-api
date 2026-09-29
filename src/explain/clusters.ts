import { dayNumber, formatCOP, formatDateShort } from '../engine'
import type { ClusterView, RungView } from './types'

/** SPEC §5.4: the window is measured from the cluster's anchor and is inclusive at 30 days. */
export const CLUSTER_WINDOW_DAYS = 30
/** SPEC §5.4: a cluster is two or more rungs. A group of one is not a cluster (plan decision 4). */
export const CLUSTER_MIN_RUNGS = 2

export type ClusterInput = Pick<RungView, 'index' | 'maturityDate' | 'principal'>

/**
 * Anchor-greedy sweep. `perRung` must be sorted by maturityDate ascending. The earliest
 * unclustered rung anchors a group that absorbs every following rung whose maturity lies
 * within CLUSTER_WINDOW_DAYS of the anchor, counted in whole calendar days through the
 * engine's dayNumber. The window never slides, so this is not single-linkage: a monthly
 * ladder becomes pairs, not one chain. Groups smaller than CLUSTER_MIN_RUNGS are dropped, so
 * clusters[] lists only what the risk is about. endDate is the last member's maturity, never
 * the window's arithmetic end (SPEC §3.3).
 */
export function sweepClusters(perRung: readonly ClusterInput[]): ClusterView[] {
  const groups: ClusterInput[][] = []
  let i = 0
  while (i < perRung.length) {
    const anchor = dayNumber(perRung[i].maturityDate)
    const group: ClusterInput[] = [perRung[i]]
    let j = i + 1
    while (j < perRung.length) {
      const gap = dayNumber(perRung[j].maturityDate) - anchor
      if (gap < 0) throw new Error('sweepClusters requires rungs sorted by maturityDate')
      if (gap > CLUSTER_WINDOW_DAYS) break
      group.push(perRung[j])
      j += 1
    }
    groups.push(group)
    i = j
  }
  return groups
    .filter((group) => group.length >= CLUSTER_MIN_RUNGS)
    .map((group, k) => {
      const startDate = group[0].maturityDate
      const endDate = group[group.length - 1].maturityDate
      const principal = group.reduce((sum, r) => sum + r.principal, 0)
      return {
        index: k + 1,
        startDate,
        startDateDisplay: formatDateShort(startDate),
        endDate,
        endDateDisplay: formatDateShort(endDate),
        count: group.length,
        rungIndexes: group.map((r) => r.index),
        principal,
        principalDisplay: formatCOP(principal),
      }
    })
}
