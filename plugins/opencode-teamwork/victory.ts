// opencode-teamwork — independent final acceptance ("victory") audit
//
// Zero runtime dependencies. Uses erasable TypeScript only (compatible with
// Node 22/24/26 `--experimental-strip-types`).
//
// The victory audit is the final fidelity check: an independent, fresh-session
// `team/victory-auditor` compares the delivered artifacts and tests against the
// original request and the requirements captured at plan time. The engine only
// stores the verdict; it recomputes the gate from artifacts on every read.
//
// Security & containment:
//   * Requirement ids are a strict single-segment allowlist.
//   * The baseline (`requirements.json`) is immutable once written: a re-plan
//     with a different baseline is refused, not silently overwritten.
//   * The verdict binds to `sha256(ORIGINAL_REQUEST.md)`, so a stale audit can
//     never satisfy a newer request.
//   * Symlink-safe bounded reads/writes via the tournament artifact helpers.

import { basename, join } from "node:path"
import {
  clean,
  cleanBlock,
  isSafeTaskId,
  readBoundedRunFile,
  readBoundedRunJson,
  writeSafeRunJson,
} from "./tournament.ts"
import { canonicalJson, sha256Hex, type AuthContext, type AuthEnvelope, type AuthFailure } from "./auth.ts"

export const VICTORY_AUDITOR_AGENT = "team/victory-auditor"
export const VICTORY_CONFIRMED = "VICTORY CONFIRMED"
export const VICTORY_REJECTED = "VICTORY REJECTED"
export const VICTORY_VERDICTS = [VICTORY_CONFIRMED, VICTORY_REJECTED] as const
export type VictoryVerdictKind = (typeof VICTORY_VERDICTS)[number]

export const REQUIREMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
export const REQUIREMENTS_MAX_ITEMS = 50
export const REQUIREMENT_TEXT_MAX = 2000
export const VICTORY_FINDINGS_MAX = 50
export const VICTORY_SUMMARY_MAX = 2000
export const VICTORY_SKIP_REASON_MAX = 500

const MAX_REQUIREMENTS_BYTES = 256 * 1024
const MAX_VICTORY_BYTES = 512 * 1024
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_REPORT_BYTES = 1024 * 1024
const MAX_PLAN_BYTES = 8 * 1024 * 1024
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_AUDIT_BYTES = 1024 * 1024
const MAX_FINAL_BYTES = 1024 * 1024

export type VictoryAuditMode = "required" | "skip"

export interface RequirementBaselineItem {
  id: string
  text: string
}

export interface RequirementsFile {
  version: 1
  source: "caller" | "request"
  items: RequirementBaselineItem[]
}

export interface VictoryRequirementResult {
  id: string
  met: boolean
  evidence: string
}

/**
 * Digests of the artifacts an audit actually reviewed, computed from disk by
 * `recordVictoryAudit`. A verdict that does not match the current files is
 * stale: the audit is bound to the exact bytes it saw, never to caller input.
 */
export interface VictoryEvidenceDigests {
  /** sha256 of each `verify/report-<taskId>.json` present at audit time. */
  reports: Record<string, string>
  /** sha256 of `verify/security-audit.json`, or null when absent. */
  securityAudit: string | null
  /** sha256 of `verify/final.json` when one existed at audit time. */
  final: string | null
}

export interface VictoryVerdictFile {
  version: 1
  sessionId: string
  verdict: VictoryVerdictKind
  auditor: string
  auditorSessionId: string
  requestHash: string | null
  /** sha256 of the canonical requirements.json baseline this verdict reviewed. */
  requirementsHash?: string | null
  /** Digests of the evidence this verdict reviewed (0.12.0, never caller input). */
  evidenceDigests?: VictoryEvidenceDigests
  requirements: VictoryRequirementResult[]
  findings: string[]
  summary: string
  generatedAt: string
  _auth?: AuthEnvelope
}

export type VictoryGate =
  | { ok: true; skipped: true; status: "SKIPPED (explicit)"; reason: string | undefined; reasons: [] }
  | {
      ok: true
      skipped: false
      status: "CONFIRMED"
      reasons: []
      verdict: VictoryVerdictFile
    }
  | {
      ok: false
      skipped: false
      status:
        | "MISSING"
        | "REJECTED"
        | "STALE"
        | "FORGED"
        | "INVALID"
        | "AUTH_MISSING"
        | "AUTH_INVALID"
        | "AUTH_UNKNOWN_KEY"
        | "AUTH_INDEX_MISSING"
        | "AUTH_STALE"
        | "AUTH_LEGACY"
        | "AUTH_UNAVAILABLE"
        | "AUTH_KEY_CORRUPT"
      reasons: string[]
    }

/** True when `value` is one of the two recognised victory verdicts. */
export function normalizeVictoryVerdict(value: unknown): VictoryVerdictKind | undefined {
  const text = typeof value === "string" ? value.trim() : ""
  return (VICTORY_VERDICTS as readonly string[]).includes(text) ? (text as VictoryVerdictKind) : undefined
}

/** True when `value` is a recognised victory-audit mode. */
export function normalizeVictoryAuditMode(value: unknown): VictoryAuditMode | undefined {
  return value === "required" || value === "skip" ? value : undefined
}

/**
 * Validate a caller-supplied reason for `victoryAudit: "skip"`. A skip is a
 * recorded completion bypass, so the reason is required, trimmed to 500 chars
 * (refused, never truncated, when longer), and sanitized before persistence.
 */
export function validateVictorySkipReason(
  value: unknown,
): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "refused: victorySkipReason must be a string when victoryAudit is \"skip\"" }
  }
  const trimmed = value.trim()
  if (trimmed === "") {
    return { ok: false, error: "refused: victorySkipReason must be non-empty when victoryAudit is \"skip\"" }
  }
  if (trimmed.length > VICTORY_SKIP_REASON_MAX) {
    return {
      ok: false,
      error: `refused: victorySkipReason is ${trimmed.length} chars; the maximum is ${VICTORY_SKIP_REASON_MAX}`,
    }
  }
  const reason = clean(trimmed, VICTORY_SKIP_REASON_MAX).trim()
  if (reason === "") {
    return { ok: false, error: "refused: victorySkipReason is empty after sanitization" }
  }
  return { ok: true, reason }
}

/** Read a persisted skip reason, or undefined when absent/blank. */
export function recordedVictorySkipReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const reason = clean(value, VICTORY_SKIP_REASON_MAX).trim()
  return reason === "" ? undefined : reason
}

/**
 * Display label for a skipped victory audit. An explicit skip always carries a
 * reason; the legacy no-baseline default is labelled separately so it is never
 * mistaken for a justified bypass.
 */
export function victorySkipLabel(reason: string | undefined): string {
  return reason
    ? `SKIPPED (explicit): ${reason}`
    : "SKIPPED (legacy default: no requirements baseline)"
}

/**
 * Validate and normalise caller-supplied plan requirements.
 * Ids must be unique safe tokens, text must be non-empty and <= 2,000 chars.
 */
export function validateRequirementsBaseline(
  raw: unknown,
): { ok: true; items: RequirementBaselineItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "refused: requirements must be an array of {id, text}" }
  }
  if (raw.length > REQUIREMENTS_MAX_ITEMS) {
    return {
      ok: false,
      error: `refused: requirements has ${raw.length} item(s); the maximum is ${REQUIREMENTS_MAX_ITEMS}`,
    }
  }
  const items: RequirementBaselineItem[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `refused: requirements[${i}] must be an object with string id and text` }
    }
    const id = (entry as any).id
    const text = (entry as any).text
    if (typeof id !== "string" || !REQUIREMENT_ID.test(id)) {
      return {
        ok: false,
        error: `refused: invalid requirement id "${clean(id, 40)}" (must match ${REQUIREMENT_ID})`,
      }
    }
    if (seen.has(id)) return { ok: false, error: `refused: duplicate requirement id "${id}"` }
    seen.add(id)
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, error: `refused: requirement "${id}" must have non-empty text` }
    }
    if (text.length > REQUIREMENT_TEXT_MAX) {
      return {
        ok: false,
        error: `refused: requirement "${id}" text is ${text.length} chars; the maximum is ${REQUIREMENT_TEXT_MAX}`,
      }
    }
    items.push({ id, text: cleanBlock(text, REQUIREMENT_TEXT_MAX) })
  }
  return { ok: true, items }
}

/** The single request-derived baseline item used when the caller supplies none. */
export function deriveRequirementsFromRequest(request: string): RequirementsFile {
  return {
    version: 1,
    source: "request",
    items: [{ id: "R1", text: cleanBlock(request.trim(), REQUIREMENT_TEXT_MAX) }],
  }
}

/** Build the caller baseline file from validated items. */
export function callerRequirementsFile(items: RequirementBaselineItem[]): RequirementsFile {
  return { version: 1, source: "caller", items }
}

/**
 * Parse a persisted requirements.json. Returns undefined when the file is
 * missing, unreadable, or does not match the schema (fail closed).
 */
export function readRequirementsBaseline(run: string): RequirementsFile | undefined {
  const res = readBoundedRunJson<any>(run, join(run, "requirements.json"), MAX_REQUIREMENTS_BYTES)
  if (res.status !== "ok") return undefined
  const data = res.value
  if (data?.version !== 1) return undefined
  if (data?.source !== "caller" && data?.source !== "request") return undefined
  if (!Array.isArray(data?.items) || data.items.length === 0) return undefined
  if (data.items.length > REQUIREMENTS_MAX_ITEMS) return undefined
  const seen = new Set<string>()
  const items: RequirementBaselineItem[] = []
  for (const entry of data.items) {
    if (!entry || typeof entry !== "object") return undefined
    const id = entry.id
    const text = entry.text
    if (typeof id !== "string" || !REQUIREMENT_ID.test(id) || seen.has(id)) return undefined
    if (typeof text !== "string" || text.trim() === "" || text.length > REQUIREMENT_TEXT_MAX) return undefined
    seen.add(id)
    items.push({ id, text })
  }
  return { version: 1, source: data.source, items }
}

/**
 * Persist the baseline. Write-once in effect: an existing file must be
 * byte-equivalent in content (same source and ordered items), otherwise the
 * re-plan is refused so a confirmed verdict cannot be invalidated silently.
 */
export function persistRequirementsBaseline(
  run: string,
  baseline: RequirementsFile,
): string | undefined {
  const existingRes = readBoundedRunJson<any>(run, join(run, "requirements.json"), MAX_REQUIREMENTS_BYTES)
  if (existingRes.status === "error") return existingRes.error
  if (existingRes.status === "ok") {
    const existing = readRequirementsBaseline(run)
    if (!existing) return "refused: existing requirements.json is malformed; nothing was changed"
    const same =
      existing.source === baseline.source &&
      existing.items.length === baseline.items.length &&
      existing.items.every((item, i) => item.id === baseline.items[i].id && item.text === baseline.items[i].text)
    if (!same) {
      return "refused: requirements.json already records this run's baseline and cannot be changed by a re-plan; use a new session"
    }
    return undefined
  }
  try {
    writeSafeRunJson(run, join(run, "requirements.json"), baseline)
  } catch (err: any) {
    return `refused: could not write requirements.json (${clean(err?.message, 120)})`
  }
  return undefined
}

/** sha256 of `<run>/ORIGINAL_REQUEST.md`; null when it is absent/unreadable. */
export function originalRequestHash(run: string): string | null {
  const res = readBoundedRunFile(run, join(run, "ORIGINAL_REQUEST.md"), MAX_REQUEST_BYTES)
  if (res.status !== "ok") return null
  return sha256Hex(res.text)
}

/** Canonical digest of a requirements baseline (or null when absent). */
export function requirementsBaselineHash(baseline: RequirementsFile | undefined): string | null {
  if (!baseline) return null
  return sha256Hex(canonicalJson(baseline))
}

/** Canonical digest of the persisted requirements.json, or null. */
export function currentRequirementsHash(run: string): string | null {
  return requirementsBaselineHash(readRequirementsBaseline(run))
}

/** Every task id that can own a verifier report: plan first, state as fallback. */
function evidenceTaskIds(run: string): string[] {
  const ids = new Set<string>()
  const plan = readBoundedRunJson<any>(run, join(run, "plan.dag.json"), MAX_PLAN_BYTES)
  if (plan.status === "ok" && Array.isArray(plan.value?.tasks)) {
    for (const task of plan.value.tasks) {
      if (typeof task?.id === "string" && isSafeTaskId(task.id)) ids.add(task.id)
    }
  }
  const state = readBoundedRunJson<any>(run, join(run, "state.json"), MAX_STATE_BYTES)
  if (state.status === "ok" && state.value?.tasks && typeof state.value.tasks === "object") {
    for (const id of Object.keys(state.value.tasks)) {
      if (isSafeTaskId(id)) ids.add(id)
    }
  }
  return [...ids]
}

function runFileDigest(run: string, relPath: string, maxBytes: number): string | null {
  const res = readBoundedRunFile(run, join(run, relPath), maxBytes)
  return res.status === "ok" ? sha256Hex(res.text) : null
}

/**
 * Compute the digest set of the evidence on disk. Used at record time to bind
 * the verdict, and by the gate to detect an artifact edited afterwards. The
 * caller never supplies any part of this value.
 */
export function evidenceDigestsFromDisk(run: string): VictoryEvidenceDigests {
  // Null-prototype map: a task id such as `constructor` is an ordinary key.
  const reports: Record<string, string> = Object.create(null)
  for (const id of evidenceTaskIds(run)) {
    const digest = runFileDigest(run, `verify/report-${id}.json`, MAX_REPORT_BYTES)
    if (digest !== null) reports[id] = digest
  }
  // A `final.json` is bound only when it is a PASS verdict the audit could have
  // reviewed. The normal order is audit → final_verify, and a pre-audit FAIL
  // must not make the later PASS verdict permanently stale.
  const finalRaw = readBoundedRunFile(run, join(run, "verify/final.json"), MAX_FINAL_BYTES)
  let finalDigest: string | null = null
  if (finalRaw.status === "ok") {
    try {
      if (JSON.parse(finalRaw.text)?.status === "PASS") finalDigest = sha256Hex(finalRaw.text)
    } catch {}
  }
  return {
    reports,
    securityAudit: runFileDigest(run, "verify/security-audit.json", MAX_AUDIT_BYTES),
    final: finalDigest,
  }
}


/** Read the existing verdict, or undefined when absent/unreadable. */
export function readVictoryVerdict(run: string): VictoryVerdictFile | undefined {
  const res = readBoundedRunJson<any>(run, join(run, "verify", "victory.json"), MAX_VICTORY_BYTES)
  if (res.status !== "ok") return undefined
  if (!res.value || typeof res.value !== "object") return undefined
  return res.value as VictoryVerdictFile
}

export type RecordVictoryResult =
  | { ok: true; verdict: VictoryVerdictFile }
  | { ok: false; error: string }

/**
 * Validate a victory-audit call, enforce write-once for a confirmed verdict,
 * bind it to the current request, and write `verify/victory.json`.
 */
export async function recordVictoryAudit(
  run: string,
  sessionId: string,
  input: {
    verdict: unknown
    requirements: unknown
    findings?: unknown
    summary?: unknown
    auditorSessionId: string
  },
  auth?: AuthContext,
): Promise<RecordVictoryResult> {
  const verdictKind = normalizeVictoryVerdict(input.verdict)
  if (!verdictKind) {
    return {
      ok: false,
      error: `refused: invalid victory verdict "${clean(input.verdict, 32)}" (expected ${VICTORY_VERDICTS.join(" | ")})`,
    }
  }
  const baseline = readRequirementsBaseline(run)
  if (!baseline) {
    return {
      ok: false,
      error: "refused: requirements.json is missing, unreadable, or malformed; a victory audit needs a plan-time baseline",
    }
  }

  if (!Array.isArray(input.requirements)) {
    return { ok: false, error: "refused: requirements must be an array of {id, met, evidence}" }
  }
  const baselineIds = new Set(baseline.items.map((item) => item.id))
  const seen = new Set<string>()
  const results: VictoryRequirementResult[] = []
  for (let i = 0; i < input.requirements.length; i++) {
    const entry = input.requirements[i]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `refused: requirements[${i}] must be an object with id, met, evidence` }
    }
    const id = (entry as any).id
    if (typeof id !== "string" || !REQUIREMENT_ID.test(id)) {
      return { ok: false, error: `refused: invalid requirement id "${clean(id, 40)}" in the audit result` }
    }
    if (!baselineIds.has(id)) {
      return { ok: false, error: `refused: requirement "${id}" is not in this run's requirements.json` }
    }
    if (seen.has(id)) return { ok: false, error: `refused: duplicate requirement id "${id}" in the audit result` }
    seen.add(id)
    const met = (entry as any).met
    if (typeof met !== "boolean") {
      return { ok: false, error: `refused: requirement "${id}" must record met as a boolean` }
    }
    const evidenceRaw = (entry as any).evidence
    const evidence = typeof evidenceRaw === "string" ? cleanBlock(evidenceRaw, 2000).trim() : ""
    if (met && evidence === "") {
      return { ok: false, error: `refused: requirement "${id}" is met but has no evidence` }
    }
    results.push({ id, met, evidence })
  }
  for (const id of baselineIds) {
    if (!seen.has(id)) {
      return { ok: false, error: `refused: requirement "${id}" is missing from the audit result` }
    }
  }

  const requestHash = originalRequestHash(run)
  if (verdictKind === VICTORY_CONFIRMED && requestHash === null) {
    return {
      ok: false,
      error: "refused: cannot record VICTORY CONFIRMED without ORIGINAL_REQUEST.md (requestHash is required)",
    }
  }

  // Bind the verdict to what is actually on disk right now. The caller cannot
  // supply these digests, so a later edit to a report/audit/final is detectable.
  const evidenceDigests = evidenceDigestsFromDisk(run)
  if (verdictKind === VICTORY_CONFIRMED && Object.keys(evidenceDigests.reports).length === 0) {
    return {
      ok: false,
      error:
        "refused: cannot record VICTORY CONFIRMED with evidenceDigests.reports empty (no verifier report was on disk for this run; nothing was written)",
    }
  }

  const existing = readVictoryVerdict(run)
  if (existing?.verdict === VICTORY_CONFIRMED) {
    return {
      ok: false,
      error: "refused: verify/victory.json already records VICTORY CONFIRMED and is write-once; start a new run for a different verdict",
    }
  }

  const findings = Array.isArray(input.findings)
    ? input.findings
        .slice(0, VICTORY_FINDINGS_MAX)
        .map((f: unknown) => cleanBlock(f, 500).trim())
        .filter((f: string) => f !== "")
    : []
  const summary = typeof input.summary === "string" ? cleanBlock(input.summary, VICTORY_SUMMARY_MAX).trim() : ""

  const verdict: VictoryVerdictFile = {
    version: 1,
    sessionId,
    verdict: verdictKind,
    auditor: VICTORY_AUDITOR_AGENT,
    auditorSessionId: input.auditorSessionId,
    requestHash,
    requirementsHash: requirementsBaselineHash(baseline),
    evidenceDigests,
    requirements: results,
    findings,
    summary,
    generatedAt: new Date().toISOString(),
  }

  let toWrite: VictoryVerdictFile = verdict
  if (auth) {
    try {
      toWrite = await auth.signRunArtifact(basename(run), "verify/victory.json", verdict)
    } catch (err: any) {
      const failure = err?.failure as AuthFailure | undefined
      return {
        ok: false,
        error: `refused: could not sign verify/victory.json (${failure ? failure.code : "signing failed"}: ${clean(err?.message, 160)}); nothing was written`,
      }
    }
  }

  try {
    writeSafeRunJson(run, join(run, "verify", "victory.json"), toWrite)
  } catch (err: any) {
    return { ok: false, error: `refused: could not write verify/victory.json (${clean(err?.message, 120)})` }
  }
  return { ok: true, verdict: toWrite }
}

/**
 * Resolve the completion mode. New plans always record the choice; for legacy
 * plans with no field, a run with a baseline is required and a run with neither
 * request nor requirements stays on the recorded legacy skip path.
 */
export function resolveVictoryAuditMode(
  plan: any,
  state: any,
  run: string,
): { mode: VictoryAuditMode; source: "plan" | "state" | "legacy" } {
  const fromPlan = normalizeVictoryAuditMode(plan?.victoryAudit)
  if (fromPlan) return { mode: fromPlan, source: "plan" }
  const fromState = normalizeVictoryAuditMode(state?.victoryAudit)
  if (fromState) return { mode: fromState, source: "state" }
  const hasBaseline =
    !!readRequirementsBaseline(run) ||
    readBoundedRunFile(run, join(run, "ORIGINAL_REQUEST.md"), MAX_REQUEST_BYTES).status === "ok"
  return { mode: hasBaseline ? "required" : "skip", source: "legacy" }
}

/**
 * Recompute the completion gate from artifacts. This is the only authority used
 * by `teamwork_final_verify` and `teamwork_next`; it never trusts the caller.
 */
export interface VictoryGateAuth {
  auth?: AuthContext
  /** A signed run must carry a valid `_auth` envelope and index entry. */
  requireSigned?: boolean
  /** Current canonical requirements.json digest; a mismatch is AUTH_STALE. */
  requirementsHash?: string | null
  /** Persisted reason for an explicit skip (display only; never a verdict). */
  skipReason?: string
}

type AuthFailureCodeLike = Extract<
  VictoryGate extends { ok: false; status: infer S } ? S : never,
  `AUTH_${string}`
>

function evaluateVictoryCore(
  run: string,
  mode: VictoryAuditMode,
  extraReasons: string[],
  authCode: AuthFailureCodeLike | undefined,
  requirementsHash?: string | null,
  skipReason?: string,
): VictoryGate {
  if (mode === "skip") {
    return { ok: true, skipped: true, status: "SKIPPED (explicit)", reason: skipReason, reasons: [] }
  }

  const baseline = readRequirementsBaseline(run)
  if (!baseline) {
    return {
      ok: false,
      skipped: false,
      status: "MISSING",
      reasons: ["victory audit: requirements.json missing, unreadable, or malformed", ...extraReasons],
    }
  }

  const victory = readVictoryVerdict(run)
  if (!victory) {
    return {
      ok: false,
      skipped: false,
      status: "MISSING",
      reasons: ["victory audit: verify/victory.json missing, unreadable, or malformed", ...extraReasons],
    }
  }

  const reasons: string[] = [...extraReasons]
  if (requirementsHash !== undefined && requirementsHash !== null) {
    const recorded =
      typeof (victory as any).requirementsHash === "string" ? (victory as any).requirementsHash : null
    if (recorded !== requirementsHash) {
      authCode = authCode ?? "AUTH_STALE"
      reasons.push(
        recorded === null
          ? "[AUTH_STALE] victory audit: verdict has no requirementsHash (stale or unsigned baseline)"
          : "[AUTH_STALE] victory audit: requirementsHash does not match the current requirements.json",
      )
    }
  }

  // The verdict is bound to the exact evidence bytes it reviewed. Recompute
  // from disk: any drift means the audit no longer describes this run.
  const recordedDigests = (victory as any).evidenceDigests
  if (recordedDigests === undefined || recordedDigests === null) {
    authCode = "AUTH_STALE"
    reasons.push(
      "[AUTH_STALE] victory audit: legacy verdict has no evidenceDigests, so it is not bound to the reports it claims to have reviewed; record a new audit",
    )
  } else if (typeof recordedDigests !== "object" || Array.isArray(recordedDigests)) {
    authCode = "AUTH_STALE"
    reasons.push("[AUTH_STALE] victory audit: evidenceDigests is malformed")
  } else {
    const current = evidenceDigestsFromDisk(run)
    const recordedReports =
      recordedDigests.reports && typeof recordedDigests.reports === "object" && !Array.isArray(recordedDigests.reports)
        ? recordedDigests.reports
        : null
    if (!recordedReports) {
      authCode = "AUTH_STALE"
      reasons.push("[AUTH_STALE] victory audit: evidenceDigests.reports is missing or malformed")
    } else {
      for (const [id, digest] of Object.entries(recordedReports)) {
        if (!isSafeTaskId(id)) {
          authCode = "AUTH_STALE"
          reasons.push(`[AUTH_STALE] victory audit: evidenceDigests names an invalid task id "${clean(id, 40)}"`)
          continue
        }
        if (current.reports[id] !== digest) {
          authCode = "AUTH_STALE"
          reasons.push(
            `[AUTH_STALE] victory audit: report ${id} changed since the audit reviewed it (drift in verify/report-${id}.json)`,
          )
        }
      }
      for (const id of Object.keys(current.reports)) {
        if (!Object.prototype.hasOwnProperty.call(recordedReports, id)) {
          authCode = "AUTH_STALE"
          reasons.push(`[AUTH_STALE] victory audit: report ${id} was never reviewed by this audit (drift)`)
        }
      }
    }
    const recordedAudit = (recordedDigests as any).securityAudit ?? null
    if (recordedAudit !== current.securityAudit) {
      authCode = "AUTH_STALE"
      reasons.push(
        recordedAudit === null
          ? "[AUTH_STALE] victory audit: security-audit.json appeared after the audit reviewed the run"
          : "[AUTH_STALE] victory audit: security-audit.json changed since the audit reviewed it",
      )
    }
    // `final.json` is normally written after the audit, so a recorded null is
    // expected; once the audit recorded a digest it must keep matching.
    const recordedFinal = (recordedDigests as any).final ?? null
    if (recordedFinal !== null && recordedFinal !== current.final) {
      authCode = "AUTH_STALE"
      reasons.push("[AUTH_STALE] victory audit: verify/final.json changed since the audit reviewed it")
    }
  }

  if (victory.verdict !== VICTORY_CONFIRMED && victory.verdict !== VICTORY_REJECTED) {
    reasons.push(`victory audit: invalid verdict "${clean(victory.verdict, 40)}"`)
  } else if (victory.verdict === VICTORY_REJECTED) {
    reasons.push("victory audit: VICTORY REJECTED")
  }
  if (victory.auditor !== VICTORY_AUDITOR_AGENT) {
    reasons.push(
      `victory audit: auditor must be ${VICTORY_AUDITOR_AGENT} (got ${clean(victory.auditor, 64) || "none"})`,
    )
  }
  if (typeof victory.auditorSessionId !== "string" || victory.auditorSessionId.trim() === "") {
    reasons.push("victory audit: auditorSessionId is missing")
  }

  const currentHash = originalRequestHash(run)
  if (currentHash === null) {
    reasons.push("victory audit: ORIGINAL_REQUEST.md missing or unreadable (requestHash required)")
  } else if (victory.requestHash !== currentHash) {
    reasons.push("victory audit: requestHash does not match the current ORIGINAL_REQUEST.md (stale or forged)")
  }

  const results = Array.isArray(victory.requirements) ? victory.requirements : []
  if (!Array.isArray(victory.requirements)) {
    reasons.push("victory audit: requirements result list is missing")
  }
  const baselineIds = new Set(baseline.items.map((item) => item.id))
  const seen = new Set<string>()
  for (const entry of results) {
    const id = entry && typeof entry === "object" ? (entry as any).id : undefined
    if (typeof id !== "string" || !REQUIREMENT_ID.test(id)) {
      reasons.push(`victory audit: invalid requirement result "${clean(id, 40)}"`)
      continue
    }
    if (seen.has(id)) {
      reasons.push(`victory audit: duplicate requirement result "${id}"`)
      continue
    }
    seen.add(id)
    if (!baselineIds.has(id)) {
      reasons.push(`victory audit: unknown requirement result "${id}"`)
      continue
    }
    if ((entry as any).met !== true) {
      reasons.push(`victory audit: requirement "${id}" is not met`)
    } else if (typeof (entry as any).evidence !== "string" || (entry as any).evidence.trim() === "") {
      reasons.push(`victory audit: requirement "${id}" is met but has no evidence`)
    }
  }
  for (const id of baselineIds) {
    if (!seen.has(id)) reasons.push(`victory audit: requirement "${id}" missing from the audit result`)
  }

  if (reasons.length > 0) {
    const semantic: VictoryGate["status"] = reasons.some((r) => r.includes("VICTORY REJECTED"))
      ? "REJECTED"
      : reasons.some((r) => r.includes("does not match"))
        ? "STALE"
        : reasons.some((r) => r.includes("auditor must be") || r.includes("invalid requirement result"))
          ? "FORGED"
          : "INVALID"
    // An authenticity failure is the headline status unless a stronger semantic
    // rejection is also present; both kinds of reason stay in the list.
    const status: VictoryGate["status"] =
      semantic === "REJECTED" ? semantic : authCode ?? semantic
    return { ok: false, skipped: false, status, reasons }
  }

  return { ok: true, skipped: false, status: "CONFIRMED", reasons: [], verdict: victory }
}

/** Semantic-only gate (used by the continuity briefing, which never claims authenticity). */
export function evaluateVictoryGate(run: string, mode: VictoryAuditMode, skipReason?: string): VictoryGate {
  return evaluateVictoryCore(run, mode, [], undefined, undefined, skipReason)
}

/** Gate with artifact authenticity enforced for signed runs. */
export async function evaluateVictoryGateChecked(
  run: string,
  mode: VictoryAuditMode,
  opts: VictoryGateAuth = {},
): Promise<VictoryGate> {
  const extra: string[] = []
  let authCode: AuthFailureCodeLike | undefined
  if (opts.requireSigned && mode !== "skip") {
    const victory = readVictoryVerdict(run)
    const check = victory
      ? opts.auth
        ? await opts.auth.verifyRunArtifact(basename(run), "verify/victory.json", victory)
        : {
            status: "unknown" as const,
            failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
          }
      : undefined
    if (check && check.status === "unsigned") {
      authCode = "AUTH_MISSING"
      extra.push("[AUTH_MISSING] victory audit: verify/victory.json has no _auth envelope (a signed run requires one)")
    } else if (check && check.status !== "signed") {
      const failure = check.failure ?? { code: "AUTH_INVALID" as const, message: "victory artifact failed verification" }
      authCode = failure.code as AuthFailureCodeLike
      extra.push(`[${failure.code}] victory audit: ${failure.message}`)
    }
  }
  return evaluateVictoryCore(run, mode, extra, authCode, opts.requirementsHash, opts.skipReason)
}

/** Human-readable one-line gate summary for tool results. */
export function describeVictoryGate(gate: VictoryGate): string {
  if (gate.ok && gate.skipped) return `Victory audit: ${victorySkipLabel(gate.reason)}.`
  if (gate.ok) return "Victory audit: CONFIRMED."
  return `Victory audit: ${gate.status} — ${gate.reasons.join("; ")}`
}
