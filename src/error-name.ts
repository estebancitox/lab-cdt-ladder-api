/**
 * What the log line may say about an error: a class or exception name, never a message, which
 * can carry request data (SPEC §8.4). Anything that is not shaped like an identifier is replaced,
 * so free text cannot pass through a name either. A bundler may suffix a class name it had to
 * rename (InternalServerError2); the value is diagnostic, not a contract.
 */
const IDENTIFIER = /^[A-Za-z_$][\w$.]{0,63}$/

export const UNKNOWN_ERROR = 'UnknownError'

export function safeName(name: unknown): string {
  return typeof name === 'string' && IDENTIFIER.test(name) ? name : UNKNOWN_ERROR
}

/** The class of a thrown value, for the 500 line. */
export function errorClassName(error: unknown): string {
  return safeName(error instanceof Error ? error.constructor?.name : undefined)
}

/** The `name` of a thrown value, which the AWS SDK sets to the exception code. */
export function errorCodeName(error: unknown): string {
  return safeName(error instanceof Error ? error.name : undefined)
}
