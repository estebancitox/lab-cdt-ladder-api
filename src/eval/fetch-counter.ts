/**
 * Counts the HTTP requests the Anthropic SDK makes, at the fetch boundary. The SDK captures
 * `globalThis.fetch` when its client is constructed, so the counter must be installed before
 * the handler's first call in the process. SSM goes through Node's https, not fetch, so it is
 * never counted. Every request is passed through unchanged.
 */
export interface FetchCounter {
  readonly calls: number
  uninstall(): void
}

export const ANTHROPIC_HOST = 'api.anthropic.com'

export function installFetchCounter(host = ANTHROPIC_HOST): FetchCounter {
  const original = globalThis.fetch
  let calls = 0
  const counting: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).host === host) calls += 1
    return original(input, init)
  }
  globalThis.fetch = counting
  return {
    get calls() {
      return calls
    },
    uninstall() {
      if (globalThis.fetch === counting) globalThis.fetch = original
    },
  }
}
