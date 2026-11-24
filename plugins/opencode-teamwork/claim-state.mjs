// plugins/opencode-teamwork/claim-state.mjs — shared claim-state predicate
//
// A leaf module (Node built-ins only) used by the plugin (`tools.ts`) and by
// the CLI readers (`lib/runs.mjs`). One predicate decides whether a claim is
// live, expired (inside the grace window), stale, needs-inspection or
// cross-host, so `prune` and `worktree cleanup` can never disagree about
// whether a run is still in use.
//
// Fail-closed rules (ADR 0009/0013):
//   * a claim with no recorded `host` is cross-host, not local;
//   * a flagged (`needsInspection`) claim is needs-inspection even while its
//     lease is live — it is never silently renewed or resumed;
//   * cross-host wins over every other state (never auto-reclaimed).

export const CLAIM_GRACE_MS = 5 * 60 * 1000

/** States that mean a task is still in use (or cannot be trusted as idle). */
export const BLOCKING_CLAIM_STATES = new Set(["live", "expired", "needs-inspection", "cross-host"])

/**
 * Derive the state of a normalised claim.
 *
 * @param {any} claim
 * @param {{ now?: number, selfHost: string, graceMs?: number, flagged?: boolean }} options
 */
export function deriveClaimStateFromClaim(claim, options) {
  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  const selfHost = options?.selfHost
  const graceMs = Number.isFinite(options?.graceMs) ? options.graceMs : CLAIM_GRACE_MS
  if (!claim || typeof claim !== "object") {
    return { state: "none", remainingMs: 0, crossHost: false, needsInspection: false }
  }
  const until = Date.parse(claim.leaseUntil)
  const remainingMs = Number.isFinite(until) ? until - now : 0
  const hb = claim.heartbeatAt ? Date.parse(claim.heartbeatAt) : NaN
  const heartbeatAgeMs = Number.isFinite(hb) ? Math.max(0, now - hb) : undefined
  const host = typeof claim.host === "string" ? claim.host.trim() : ""
  // A missing host cannot be proven local. A claim-protocol-1 run predates the
  // host field entirely, so its shape is explicitly local-compatible; for
  // protocol 2 a missing host is cross-host (fail closed).
  const legacyHostless = options?.legacyHostless === true && host === ""
  const crossHost = !legacyHostless && (host === "" || host !== selfHost)
  const flagged = options?.flagged === true || claim.needsInspection === true
  let state
  if (crossHost) state = "cross-host"
  else if (flagged) state = "needs-inspection"
  else if (remainingMs > 0) state = "live"
  else if (Number.isFinite(until) && now < until + graceMs) state = "expired"
  else state = "stale"
  return { state, remainingMs, ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}), crossHost, needsInspection: state === "needs-inspection" }
}

/** True when `claim` blocks prune/cleanup (live, expired, flagged or cross-host). */
export function claimBlocksCleanup(claim, options) {
  if (!claim || typeof claim !== "object") return false
  return BLOCKING_CLAIM_STATES.has(deriveClaimStateFromClaim(claim, options).state)
}
