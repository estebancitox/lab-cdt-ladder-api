import type { Entity, EntityExposure } from './types'

export interface ExposureItem {
  entityId: string
  /** Original invested principal. */
  principal: number
  /** Gross interest at maturity, or total projected interest under rollover. */
  interest: number
}

/**
 * Aggregate per-rung exposure contributions per entity and compare against
 * the insurance ceiling. All inputs are already peso-rounded integers
 * (cash-event policy), so the comparison is integer-exact. The warning is
 * strict (> ceiling): exactly-at-ceiling is compliant. A ceiling of 0 means
 * "no coverage" and flags any positive exposure.
 */
export function entityExposures(
  entities: Entity[],
  items: ExposureItem[],
  ceiling: number,
): EntityExposure[] {
  const byEntity = new Map<string, { principal: number; interest: number }>()
  for (const item of items) {
    const acc = byEntity.get(item.entityId) ?? { principal: 0, interest: 0 }
    acc.principal += item.principal
    acc.interest += item.interest
    byEntity.set(item.entityId, acc)
  }
  return entities
    .filter((e) => byEntity.has(e.id))
    .map((e) => {
      const { principal, interest } = byEntity.get(e.id)!
      const exposure = principal + interest
      const excess = Math.max(0, exposure - ceiling)
      return {
        entityId: e.id,
        entityName: e.name,
        principal,
        interest,
        exposure,
        ceiling,
        exceeded: exposure > ceiling,
        excess,
      }
    })
}
