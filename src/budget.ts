import { MODEL_DEADLINE_MS } from './model/call'

/**
 * SPEC §8 and §8.6: the handler's total budget B, measured from the start of the handler,
 * strictly below the 25 s Lambda timeout of template.yaml.
 */
export const HANDLER_BUDGET_MS = 24_000
/** SPEC §8.6: the verification threshold, kept free at the end of every model call. */
export const VERIFICATION_THRESHOLD_MS = 50
/** SPEC §8.6: the nearest-rank p95 of the stored v1 run's latency, the basis of R. */
export const STORED_P95_MS = 4_113
/** SPEC §8 and §8.6: a verification retry starts only when at least R of B remains. */
export const RETRY_THRESHOLD_MS = STORED_P95_MS + VERIFICATION_THRESHOLD_MS

/**
 * SPEC §8.6: a model call's deadline, the smaller of 20 s and B minus the elapsed time minus the
 * verification threshold, with the elapsed time taken at the instant the call starts. Rounded
 * down to whole milliseconds, so no call runs past B minus the threshold.
 */
export function callDeadlineMs(elapsedMs: number): number {
  return Math.floor(
    Math.min(MODEL_DEADLINE_MS, HANDLER_BUDGET_MS - elapsedMs - VERIFICATION_THRESHOLD_MS),
  )
}

/** SPEC §7.4 and §8.6: whether B minus the elapsed time leaves at least R for a retry. */
export function retryFits(elapsedMs: number): boolean {
  return HANDLER_BUDGET_MS - elapsedMs >= RETRY_THRESHOLD_MS
}
