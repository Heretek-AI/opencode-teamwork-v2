// @heretek-ai/opencode-teamwork-v2 — guarded OIDC discovery/JWKS fetcher
//
// Opt-in CLI-only network path (`verify --fetch-jwks <issuer-url>`). Strictly
// HTTPS-only (no redirects to HTTP), bounded response size, never invoked unless
// the operator explicitly passes `--fetch-jwks`.
//
// Both the discovery document and its `jwks_uri` go through `url-guard.mjs`:
// loopback, private, link-local, and cloud-metadata addresses are refused, DNS
// is validated and pinned, and redirects are never followed. Intranet issuers
// must use `--oidc-jwks <file>` instead of this network path.
//
// A single deadline spans discovery, DNS validation, and the JWKS fetch. The
// guard's `timeoutMs` is socket inactivity, so the signal is what stops a
// slow-drip issuer or a slow resolver from stalling `verify`.
//
// Plain ESM with zero runtime dependencies.

import { assertSafeUrl, safeFetch } from "../plugins/opencode-teamwork/url-guard.mjs"

export const OIDC_FETCH_TIMEOUT_MS = 10_000
export const OIDC_FETCH_MAX_BYTES = 512 * 1024

// Echo a user-supplied value in an error message without control characters.
function safeEcho(value, max = 64) {
  const shown = String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "?")
  return shown.length > max ? `${shown.slice(0, max)}...` : shown
}

function timedOut(label, href, timeoutMs) {
  return new Error(`${label} ${href} timed out after ${timeoutMs}ms`)
}

/**
 * Fetch and parse one OIDC JSON document through the SSRF guard.
 *
 * @param {string} rawUrl
 * @param {string} label
 * @param {{ signal?: AbortSignal, timeoutMs?: number, resolveHost?: Function }} [options]
 */
export async function fetchGuardedOidcJson(rawUrl, label, options = {}) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || "").trim())
  } catch {
    throw new Error(`${label} "${safeEcho(rawUrl)}" is not a valid URL`)
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} requires an https:// URL (got ${parsed.protocol})`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not embed credentials`)
  }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : OIDC_FETCH_TIMEOUT_MS
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs)
  const guarded = await assertSafeUrl(parsed.href, {
    allowLocalhost: false,
    resolveHost: options.resolveHost,
    signal,
  })
  if (!guarded.ok) {
    if (guarded.code === "URL_TIMEOUT") throw timedOut(label, parsed.href, timeoutMs)
    throw new Error(`${label} ${parsed.href} refused (${guarded.code}): ${guarded.error}`)
  }
  if (signal.aborted) throw timedOut(label, parsed.href, timeoutMs)
  const res = await safeFetch(guarded.url.href, {
    timeoutMs,
    maxBytes: OIDC_FETCH_MAX_BYTES,
    allowLocalhost: false,
    resolveHost: options.resolveHost,
    signal,
  })
  if (!res.ok) {
    if (res.code === "URL_TIMEOUT") throw timedOut(label, parsed.href, timeoutMs)
    throw new Error(`${label} ${parsed.href} failed (${res.code}): ${res.error}`)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label} ${parsed.href} failed with HTTP ${res.status}`)
  }
  if (!res.body || res.body.length === 0) {
    throw new Error(`${label} ${parsed.href} returned no body`)
  }
  if (res.body.length > OIDC_FETCH_MAX_BYTES) {
    throw new Error(`${label} response exceeds 512 KiB bound`)
  }
  try {
    return JSON.parse(res.body.toString("utf8"))
  } catch {
    throw new Error(`${label} ${parsed.href} did not return valid JSON`)
  }
}

/**
 * Fetch an issuer's JWKS using one end-to-end deadline for discovery, DNS, and
 * the JWKS request. `fetchJson` is a test seam; production uses
 * `fetchGuardedOidcJson`.
 */
export async function fetchOidcJwks(issuerUrl, options = {}) {
  const base = String(issuerUrl || "").trim().replace(/\/+$/, "")
  let parsed
  try {
    parsed = new URL(base)
  } catch {
    throw new Error(`--fetch-jwks issuer "${base}" is not a valid URL`)
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`--fetch-jwks requires an https:// issuer URL (got ${parsed.protocol})`)
  }
  if (parsed.username || parsed.password) {
    throw new Error("--fetch-jwks issuer URL must not embed credentials")
  }
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : OIDC_FETCH_TIMEOUT_MS
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs)
  const fetchJson = options.fetchJson ?? fetchGuardedOidcJson
  const fetchOptions = { signal, timeoutMs, resolveHost: options.resolveHost }

  const wellKnownUrl = `${base}/.well-known/openid-configuration`
  const disco = await fetchJson(wellKnownUrl, "OIDC discovery", fetchOptions)
  if (signal.aborted) throw timedOut("OIDC discovery", wellKnownUrl, timeoutMs)
  if (typeof disco?.jwks_uri !== "string" || disco.jwks_uri.trim() === "") {
    throw new Error(`OIDC discovery at ${wellKnownUrl} returned no valid https:// jwks_uri`)
  }
  const jwks = await fetchJson(disco.jwks_uri, "JWKS", fetchOptions)
  if (signal.aborted) throw timedOut("JWKS", disco.jwks_uri, timeoutMs)
  if (!Array.isArray(jwks?.keys)) throw new Error("JWKS response has no keys array")
  return jwks
}
