import { describe, expect, it } from 'vitest'
import { addDays } from '../engine'
import { CLUSTER_WINDOW_DAYS, sweepClusters, type ClusterInput } from './clusters'

const START = '2027-01-04'

/** Rungs maturing at the given day offsets from START, in that order, 10.000.000 each. */
function rungsAt(...offsets: number[]): ClusterInput[] {
  return offsets.map((days, i) => ({
    index: i + 1,
    maturityDate: addDays(START, days),
    principal: 10_000_000,
  }))
}

describe('sweepClusters: anchor-greedy, inclusive at 30 days (SPEC §5.4)', () => {
  it('is inclusive at exactly 30 days and exclusive at 31', () => {
    expect(CLUSTER_WINDOW_DAYS).toBe(30)
    expect(sweepClusters(rungsAt(0, 30))).toMatchObject([{ count: 2, rungIndexes: [1, 2] }])
    expect(sweepClusters(rungsAt(0, 31))).toEqual([])
  })

  it('measures from the anchor, not from the previous rung: 0, 20, 40 is a pair plus a singleton', () => {
    // Single-linkage would chain all three (gaps 20 and 20). The anchor at day 0 absorbs day
    // 20 (gap 20) but not day 40 (gap 40); day 40 then anchors a group of one, which is not
    // a cluster.
    expect(sweepClusters(rungsAt(0, 20, 40))).toMatchObject([
      { index: 1, count: 2, rungIndexes: [1, 2] },
    ])
  })

  it('a 12-rung ladder at 25-day spacing yields six pairs, not one chain (case twelve-rungs)', () => {
    const clusters = sweepClusters(rungsAt(...Array.from({ length: 12 }, (_, i) => 25 * (i + 1))))
    expect(clusters).toHaveLength(6)
    expect(clusters.map((c) => c.rungIndexes)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
      [11, 12],
    ])
    expect(clusters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('endDate is the last maturity in the cluster, never the window end (SPEC §3.3)', () => {
    const [c] = sweepClusters(rungsAt(0, 10, 20))
    expect(c.startDate).toBe(START)
    expect(c.endDate).toBe(addDays(START, 20))
    expect(c.endDate).not.toBe(addDays(START, CLUSTER_WINDOW_DAYS))
    expect(c.endDateDisplay).toBe('24 ene 2027')
  })

  it('drops groups of one: 90/180/270 has no cluster, and neither does 31-day spacing', () => {
    expect(sweepClusters(rungsAt(90, 180, 270))).toEqual([])
    expect(sweepClusters(rungsAt(90, 121, 152))).toEqual([])
  })

  it("sums the members' principal and formats it with the engine", () => {
    const [c] = sweepClusters([
      { index: 1, maturityDate: '2027-06-01', principal: 20_000_000 },
      { index: 2, maturityDate: '2027-06-11', principal: 20_000_000 },
      { index: 3, maturityDate: '2027-06-21', principal: 20_000_000 },
    ])
    expect(c).toMatchObject({
      count: 3,
      principal: 60_000_000,
      startDate: '2027-06-01',
      endDate: '2027-06-21',
      rungIndexes: [1, 2, 3],
    })
    expect(c.principalDisplay.replace(/[  ]/g, ' ')).toBe('$ 60.000.000')
  })

  it('refuses unsorted input and returns nothing for an empty ladder', () => {
    expect(() => sweepClusters(rungsAt(40, 0))).toThrow(/sorted/)
    expect(sweepClusters([])).toEqual([])
  })
})
