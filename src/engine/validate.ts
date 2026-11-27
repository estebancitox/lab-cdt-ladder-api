import { parseISODate } from './dates'
import { formatPercent } from './format'
import type { ScenarioInput, ValidationIssue } from './types'

/**
 * Returns issues instead of throwing: the UI shows them next to the fields.
 * Rates are fractions here — the UI converts from % at its own boundary, and
 * anything > 1 is rejected to catch percent-passed-as-fraction mistakes.
 */
export function validateScenario(input: ScenarioInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  try {
    parseISODate(input.startDate)
  } catch {
    issues.push({
      code: 'start_date_invalid',
      path: 'startDate',
      message: 'The start date is not valid.',
    })
  }

  if (input.rungs.length === 0) {
    issues.push({
      code: 'rungs_empty',
      path: 'rungs',
      message: 'Add at least one rung.',
    })
  }

  const entityIds = new Set(input.entities.map((e) => e.id))
  const seenIds = new Set<string>()
  input.entities.forEach((e, i) => {
    if (seenIds.has(e.id)) {
      issues.push({
        code: 'entity_id_duplicate',
        path: `entities[${i}].id`,
        message: 'Each institution needs a unique ID.',
      })
    }
    seenIds.add(e.id)
    if (e.name.trim() === '') {
      issues.push({
        code: 'entity_name_empty',
        path: `entities[${i}].name`,
        message: 'Give each institution a name.',
      })
    }
  })

  input.rungs.forEach((r, i) => {
    const at = `rungs[${i}]`
    if (!Number.isSafeInteger(r.principal) || r.principal <= 0) {
      issues.push({
        code: 'principal_invalid',
        path: `${at}.principal`,
        message: 'The amount must be a whole number of pesos, greater than zero.',
      })
    }
    if (!Number.isInteger(r.days) || r.days <= 0) {
      issues.push({
        code: 'days_invalid',
        path: `${at}.days`,
        message: 'The term must be a whole number of days, greater than zero.',
      })
    }
    if (!Number.isFinite(r.ea) || r.ea < 0 || r.ea > 1) {
      issues.push({
        code: 'ea_out_of_range',
        path: `${at}.ea`,
        message: `The E.A. rate must be between ${formatPercent(0)} and ${formatPercent(1)}.`,
      })
    }
    if (!r.entityId || !entityIds.has(r.entityId)) {
      issues.push({
        code: 'entity_missing',
        path: `${at}.entityId`,
        message: 'Each rung needs an existing institution.',
      })
    }
  })

  if (input.rollover) {
    const ro = input.rollover
    if (ro.mode === 'cycles') {
      if (!Number.isInteger(ro.cycles) || ro.cycles < 1 || ro.cycles > 36) {
        issues.push({
          code: 'rollover_cycles_invalid',
          path: 'rollover.cycles',
          message: 'The number of renewals must be between 1 and 36.',
        })
      }
    } else {
      let horizonOk = true
      try {
        parseISODate(ro.horizonDate)
      } catch {
        horizonOk = false
        issues.push({
          code: 'rollover_horizon_invalid',
          path: 'rollover.horizonDate',
          message: 'The horizon date is not valid.',
        })
      }
      if (horizonOk && ro.horizonDate <= input.startDate) {
        issues.push({
          code: 'rollover_horizon_before_start',
          path: 'rollover.horizonDate',
          message: 'The horizon must be after the start date.',
        })
      }
    }
  }

  if (input.dayCountBase !== 360 && input.dayCountBase !== 365) {
    issues.push({
      code: 'day_count_base_invalid',
      path: 'dayCountBase',
      message: 'The day-count basis must be 360 or 365.',
    })
  }

  const f = input.fiscal
  if (!Number.isFinite(f.retencionRate) || f.retencionRate < 0 || f.retencionRate >= 1) {
    issues.push({
      code: 'retencion_out_of_range',
      path: 'fiscal.retencionRate',
      message: `The withholding tax must be ${formatPercent(0)} or more and less than ${formatPercent(1)}.`,
    })
  }
  if (!Number.isSafeInteger(f.insuranceCeiling) || f.insuranceCeiling < 0) {
    issues.push({
      code: 'ceiling_invalid',
      path: 'fiscal.insuranceCeiling',
      message: 'The deposit-insurance ceiling must be a whole number of pesos, zero or greater.',
    })
  }

  return issues
}
