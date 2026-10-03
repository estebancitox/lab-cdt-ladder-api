import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { errorCodeName } from '../error-name'

/**
 * SPEC §8 leaves 5 s between the model deadline and the Lambda timeout. Reading the key, which
 * happens once per container, gets a bounded share of them.
 */
export const KEY_FETCH_TIMEOUT_MS = 3_000

/**
 * The key could not be read. Carries the exception name of the underlying error, never its
 * message: the handler logs `causeName` and nothing else.
 */
export class ApiKeyUnavailableError extends Error {
  constructor(readonly causeName: string) {
    super('the API key could not be read')
    this.name = 'ApiKeyUnavailableError'
  }
}

let cached: Promise<string> | undefined

/**
 * The Anthropic API key, read from the SSM SecureString named by API_KEY_PARAMETER and decrypted
 * once per container. Only a successful read is kept, so a failure is retried by the next
 * request instead of poisoning the container. The value is never logged or put in an error.
 */
export function getApiKey(): Promise<string> {
  cached ??= readApiKey().catch((error: unknown) => {
    cached = undefined
    throw new ApiKeyUnavailableError(errorCodeName(error))
  })
  return cached
}

async function readApiKey(): Promise<string> {
  const name = process.env.API_KEY_PARAMETER
  if (name === undefined || name === '') throw new ConfigurationError('ParameterNameMissing')
  const client = new SSMClient({ maxAttempts: 2 })
  const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
    abortSignal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
  })
  const value = result.Parameter?.Value
  if (value === undefined || value === '') throw new ConfigurationError('ParameterValueMissing')
  return value
}

class ConfigurationError extends Error {
  constructor(name: string) {
    super(name)
    this.name = name
  }
}
