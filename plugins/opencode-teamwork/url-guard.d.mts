// Type declarations for ./url-guard.mjs. Hand-maintained; keep in sync with the
// implementation. Type-only: this file has no runtime effect.

export const ALLOW_LOCALHOST_ENV: string

export type UrlGuardCode =
  | "URL_INVALID"
  | "URL_PROTOCOL"
  | "URL_CREDENTIALS"
  | "URL_BLOCKED_ADDRESS"
  | "URL_DNS"
  | "URL_NETWORK"
  | "URL_TIMEOUT"
  | "URL_TOO_LARGE"

export type UrlGuardFailure = { ok: false; code: UrlGuardCode; error: string }

export interface SafeUrl {
  ok: true
  url: URL
  addresses: Array<{ address: string; family: 4 | 6 }>
  allowLocalhost: boolean
}

export interface AssertSafeUrlOptions {
  allowLocalhost?: boolean
  loopbackOnly?: boolean
  /** Test seam; production always uses the system resolver. */
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
}

export interface SafeFetchOptions extends AssertSafeUrlOptions {
  method?: "GET" | "HEAD"
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
  /** Optional end-to-end deadline. The request is destroyed when this aborts. */
  signal?: AbortSignal
}

export interface SafeFetchSuccess {
  ok: true
  status: number
  headers: Record<string, any>
  body?: Buffer
}

export type SafeFetchResult = SafeFetchSuccess | UrlGuardFailure

/** Classify one resolved address. Returns a human-readable reason when blocked. */
export function blockedAddressReason(address: string, allowLocalhost?: boolean): string | undefined

/**
 * Validate and normalize a local OpenCode service origin URL (from `service*.json`).
 * Returns a reconstructed clean origin string (`http(s)://host[:port]`) or `undefined`.
 */
export function parseLoopbackServiceUrl(rawUrl: string): string | undefined

/**
 * Validate a URL and resolve every address it names. All answers must be
 * public; a hostname with one private answer is refused as a whole.
 */
export function assertSafeUrl(
  rawUrl: string,
  options?: AssertSafeUrlOptions,
): Promise<SafeUrl | UrlGuardFailure>

/**
 * Fetch a URL through the guard. Redirects are NOT followed (3xx is returned to
 * the caller); callers that choose to follow one must validate the target with
 * `assertSafeUrl` first. The connection is pinned to the validated address.
 */
export function safeFetch(rawUrl: string, options?: SafeFetchOptions): Promise<SafeFetchResult>
