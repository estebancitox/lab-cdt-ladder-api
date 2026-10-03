import { parseISODate, type ISODate } from '../engine'
import { basisPoints, type EntityView, type ExplanationView, type RiskKey } from '../explain'
import type { ExplainRequest } from '../request/schema'

/** SPEC §4: the closed label vocabulary, one label per risk of the view. */
export const RISK_LABELS: Record<RiskKey, string> = {
  ceiling: 'Tope del seguro',
  concentration: 'Concentración',
  clustered: 'Vencimientos agrupados',
  rateGap: 'Diferencia de tasa',
}

export const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const

/**
 * '2027-06-01' → '1 de junio de 2027': the long rendering SPEC §11.3 generates for every date
 * of the view. The engine's formatDateShort abbreviates the month, and the model is handed the
 * form a reader expects so that it copies a date instead of expanding one. Calendar validity is
 * still the engine's: parseISODate throws on anything that is not a real date.
 */
export function formatDateLong(date: ISODate): string {
  const { y, m, d } = parseISODate(date)
  return `${d} de ${MONTH_NAMES[m - 1]} de ${y}`
}

/**
 * The user message of the model call. A projection of the SPEC §3.3 view that carries only what
 * the model may say: display strings and integers of the SPEC §11.3 allowed set, dates of its
 * date vocabulary, entity names, and the labels of `selected`. No ids, no raw fractions, no
 * dayCountBase, no withholding rate, no threshold. Risk figures appear only for the selected
 * risks, so a risk the server did not select has nothing to be narrated from.
 *
 * Keys are Spanish on purpose: the model reads them next to Spanish prose, and a key echoed
 * into a reply must not be an English word (SPEC §11.8).
 */
export interface ModelPayload {
  fechaConsulta: string
  fechaInicio: string
  cantidadPeldanos: number
  cantidadEntidades: number
  totales: {
    capital: string
    interesBruto: string
    retencion: string
    interesNeto: string
    tasaPromedio: string
  }
  proximoVencimiento: { fecha: string; diasDesdeLaFechaDeConsulta: number }
  ultimoVencimiento: string
  peldanos: {
    numero: number
    entidad: string
    capital: string
    plazoDias: number
    tasaEA: string
    vencimiento: string
    interesBruto: string
    retencion: string
    interesNeto: string
  }[]
  entidades: { entidad: string; capital: string; participacion: string }[]
  riesgos: RiskEntry[]
}

export type RiskEntry =
  | {
      etiqueta: string
      entidades: { entidad: string; exposicion: string; topeDelSeguro: string; exceso: string }[]
    }
  | { etiqueta: string; entidades: { entidad: string; capital: string; participacion: string }[] }
  | {
      etiqueta: string
      cantidadGrupos: number
      grupos: {
        cantidadPeldanos: number
        numerosDePeldano: number[]
        primerVencimiento: string
        ultimoVencimiento: string
        capital: string
      }[]
    }
  | {
      etiqueta: string
      tasaMasAlta: string
      peldanos: { numero: number; entidad: string; tasaEA: string }[]
    }

/** Expects the request validateRequest accepted and the view built from it. */
export function buildModelPayload(request: ExplainRequest, view: ExplanationView): ModelPayload {
  const { totals } = view
  return {
    fechaConsulta: formatDateLong(request.asOfDate),
    fechaInicio: formatDateLong(request.ladder.startDate),
    cantidadPeldanos: view.rungCount,
    cantidadEntidades: view.entityCount,
    totales: {
      capital: totals.principalDisplay,
      interesBruto: totals.grossInterestDisplay,
      retencion: totals.retencionDisplay,
      interesNeto: totals.netInterestDisplay,
      tasaPromedio: view.blendedEADisplay,
    },
    proximoVencimiento: {
      fecha: formatDateLong(view.nextMaturity),
      diasDesdeLaFechaDeConsulta: view.daysToNextMaturity,
    },
    ultimoVencimiento: formatDateLong(view.lastMaturity),
    peldanos: view.perRung.map((r) => ({
      numero: r.index,
      entidad: r.entityName,
      capital: r.principalDisplay,
      plazoDias: r.days,
      tasaEA: r.eaDisplay,
      vencimiento: formatDateLong(r.maturityDate),
      interesBruto: r.grossInterestDisplay,
      retencion: r.retencionDisplay,
      interesNeto: r.netInterestDisplay,
    })),
    entidades: view.perEntity.map((e) => ({
      entidad: e.entityName,
      capital: e.principalDisplay,
      participacion: e.shareOfCapitalDisplay,
    })),
    // SPEC §5.3: only the survivors of the priority, in priority order.
    riesgos: view.risks.selected.map((key) => riskEntry(key, view)),
  }
}

/** Compact JSON: its string syntax is the delimiter around entity names (SPEC §8.3). */
export function renderUserMessage(payload: ModelPayload): string {
  return JSON.stringify(payload)
}

function riskEntry(key: RiskKey, view: ExplanationView): RiskEntry {
  const etiqueta = RISK_LABELS[key]
  switch (key) {
    case 'ceiling':
      return {
        etiqueta,
        entidades: view.risks.ceiling.entityIds.map((id) => {
          const e = entityOf(view, id)
          return {
            entidad: e.entityName,
            exposicion: e.exposureDisplay,
            topeDelSeguro: e.ceilingDisplay,
            exceso: e.excessDisplay,
          }
        }),
      }
    case 'concentration':
      return {
        etiqueta,
        entidades: view.risks.concentration.entityIds.map((id) => {
          const e = entityOf(view, id)
          return {
            entidad: e.entityName,
            capital: e.principalDisplay,
            participacion: e.shareOfCapitalDisplay,
          }
        }),
      }
    case 'clustered':
      return {
        etiqueta,
        cantidadGrupos: view.clusterCount,
        grupos: view.clusters.map((c) => ({
          cantidadPeldanos: c.count,
          numerosDePeldano: c.rungIndexes,
          primerVencimiento: formatDateLong(c.startDate),
          ultimoVencimiento: formatDateLong(c.endDate),
          capital: c.principalDisplay,
        })),
      }
    case 'rateGap': {
      const { maxBp, rungIndexes } = view.risks.rateGap
      // The highest rate is handed over as the display string of a rung that carries it, so
      // the figure is one SPEC §11.3 already allows. The gap itself is never given.
      const highest = view.perRung.find((r) => basisPoints(r.ea) === maxBp)
      if (highest === undefined) throw new Error('no rung carries the highest rate of the view')
      return {
        etiqueta,
        tasaMasAlta: highest.eaDisplay,
        peldanos: rungIndexes.map((index) => {
          const r = view.perRung[index - 1]
          return { numero: r.index, entidad: r.entityName, tasaEA: r.eaDisplay }
        }),
      }
    }
  }
}

function entityOf(view: ExplanationView, entityId: string): EntityView {
  const entity = view.perEntity.find((e) => e.entityId === entityId)
  if (entity === undefined) throw new Error('a risk names an entity that is not in the view')
  return entity
}
