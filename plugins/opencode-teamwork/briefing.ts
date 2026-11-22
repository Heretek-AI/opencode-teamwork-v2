// opencode-teamwork — shared run briefing (continuity artifact)
//
// One `<run>/BRIEFING.md` per run, written by the coordinator tools and read
// back into every team agent's context. It is deliberately a *shared* file:
// per-agent state roots are not supported on this host (ADR 0003), so the
// briefing is the continuity record a fresh session can start from.
//
// Sections (kept stable; documented in docs/ARTIFACTS.md):
//   Mission, Identity, Key Constraints, Project Status, Artifact Index,
//   Succession.
//
// Security & containment:
//   * Bounded reads/writes through the tournament artifact helpers
//     (`O_NOFOLLOW`, realpath containment, atomic rename, symlink refusal).
//   * The file is capped at 16 KiB (UTF-8 bytes), and every interpolated value
//     is sanitised: control characters are replaced, headings in the verbatim
//     mission are defused so a request cannot forge a section.
//   * Writes that fail are the caller's problem to swallow (fail-open): the
//     briefing must never fail the operation that produced it.
//
// Zero runtime dependencies. Erasable TypeScript only.

import { lstatSync } from "node:fs"
import { join } from "node:path"
import {
  clean,
  ensureSafeRunSubpath,
  readBoundedRunFile,
  readBoundedRunJson,
  writeSafeRunFile,
} from "./tournament.ts"
import { evaluateStrictGate, normalizeVerificationMode } from "./strict.ts"
import { evaluateVictoryGate, resolveVictoryAuditMode } from "./victory.ts"

export const BRIEFING_FILE = "BRIEFING.md"
/** Hard cap for the on-disk briefing, in UTF-8 bytes. */
export const MAX_BRIEFING_BYTES = 16 * 1024
/** How much of the briefing is injected into <run>/context. */
export const BRIEFING_EXCERPT_BYTES = 4 * 1024

const MAX_MISSION_CHARS = 2000
const MAX_MISSION_READ_BYTES = 64 * 1024
const MAX_SPEC_READ_BYTES = 64 * 1024
const MAX_COSTS_READ_BYTES = 64 * 1024

// Preserve "\n" for blocks; replace every other control / line separator.
const BLOCK_CONTROL = /[\r\t\x00-\x08\x0b-\x1f\x7f-\x9f\u0085\u2028\u2029]/g
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ARTIFACT_INDEX = [
  "plan.dag.json",
  "state.json",
  "ORIGINAL_REQUEST.md",
  "requirements.json",
  "verify/final.json",
  "GATE_STATUS.md",
] as const

/**
 * Sanitise multi-line briefing text while keeping "\n". Caps by characters and
 * marks a truncation. Never returns a raw control character.
 */
export function sanitizeBriefingText(value: unknown, max = MAX_MISSION_CHARS): string {
  const raw = String(value ?? "").replace(BLOCK_CONTROL, " ")
  const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim()
  const capped =
    collapsed.length > max ? collapsed.slice(0, Math.max(0, max - 1)) + "…" : collapsed
  return defuseHeadings(capped)
}

/**
 * Control-character scrub for already-structured briefing text (used on read).
 * Unlike sanitizeBriefingText it must NOT defuse headings or collapse lines:
 * the briefing's own `## Section` markers are content here.
 */
export function sanitizeBriefingOutput(value: unknown, max = MAX_BRIEFING_BYTES): string {
  const raw = String(value ?? "").replace(BLOCK_CONTROL, " ")
  return raw.length > max ? raw.slice(0, Math.max(0, max - 1)) + "…" : raw
}

/**
 * Escape ATX heading markers at the start of a line, so verbatim mission text
 * can never create a new `## ...` section in the briefing.
 */
function defuseHeadings(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, "$1\\$2"))
    .join("\n")
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  let cut = Math.max(0, maxBytes)
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--
  return buf.subarray(0, cut).toString("utf8")
}

function boundBriefing(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_BRIEFING_BYTES) return text
  const marker = "\n\n[truncated to 16384 bytes]\n"
  const room = MAX_BRIEFING_BYTES - Buffer.byteLength(marker, "utf8")
  return truncateUtf8(text, room) + marker
}

/** Read the verbatim request (or the spec title) and bound/sanitise it. */
function missionText(run: string): string {
  const request = readBoundedRunFile(run, join(run, "ORIGINAL_REQUEST.md"), MAX_MISSION_READ_BYTES)
  if (request.status === "ok") {
    const marker = "\n## Request\n\n"
    const idx = request.text.indexOf(marker)
    if (idx >= 0) {
      const body = request.text.slice(idx + marker.length)
      if (body.trim()) return sanitizeBriefingText(body)
    }
  }

  const spec = readBoundedRunFile(run, join(run, "prompt_draft.md"), MAX_SPEC_READ_BYTES)
  if (spec.status === "ok") {
    const lines = spec.text.split("\n")
    const heading = lines.find((line) => /^\s{0,3}#\s+\S/.test(line))
    const first = heading || lines.find((line) => line.trim())
    if (first) {
      const title = first.replace(/^\s{0,3}#+\s*/, "").trim()
      if (title) return sanitizeBriefingText(title)
    }
  }
  return "No recorded request or spec title."
}

function isRegularRunFile(run: string, rel: string): boolean {
  const check = ensureSafeRunSubpath(run, join(run, rel))
  if (!check.ok) return false
  try {
    const st = lstatSync(check.path)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function taskCounts(plan: any, state: any): {
  total: number
  pending: number
  active: number
  verifiedPass: number
  failed: number
  blocked: number
  ids: string[]
} {
  const fromPlan: string[] = Array.isArray(plan?.tasks)
    ? plan.tasks.map((t: any) => t?.id).filter((id: any) => typeof id === "string")
    : []
  const stateTasks = state?.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks) ? state.tasks : {}
  const fromState = Object.keys(stateTasks)
  const ids: string[] = []
  for (const id of [...fromPlan, ...fromState]) if (!ids.includes(id)) ids.push(id)

  let pending = 0
  let active = 0
  let verifiedPass = 0
  let failed = 0
  let blocked = 0
  for (const id of ids) {
    const own = Object.prototype.hasOwnProperty.call(stateTasks, id) ? stateTasks[id] : undefined
    const status = typeof own?.status === "string" ? own.status : "pending"
    if (status === "pending") pending++
    else if (status === "worker_active" || status === "worker_done" || status === "verifier_active") active++
    else if (status === "verified_pass" || status === "pass") verifiedPass++
    else if (status === "verified_fail" || status === "fail") failed++
    else if (status === "blocked") blocked++
    else pending++
  }
  return { total: ids.length, pending, active, verifiedPass, failed, blocked, ids }
}

/**
 * Build the full briefing text. Reads only run-local artifacts through the
 * bounded, no-follow helpers, and sanitises every value it interpolates.
 */
export function buildBriefing(run: string, timestamp = new Date().toISOString()): string {
  const planRes = readBoundedRunJson<any>(run, join(run, "plan.dag.json"), 8 * 1024 * 1024)
  const plan = planRes.status === "ok" ? planRes.value : undefined
  const stateRes = readBoundedRunJson<any>(run, join(run, "state.json"), 8 * 1024 * 1024)
  const state = stateRes.status === "ok" ? stateRes.value : undefined
  const costsRes = readBoundedRunJson<any>(run, join(run, "costs.json"), MAX_COSTS_READ_BYTES)
  const costs = costsRes.status === "ok" ? costsRes.value : undefined

  const sessionId = clean(plan?.sessionId || state?.sessionId || run.split(/[\\/]/).pop() || "unknown", 64)
  const topology = clean(plan?.topology || "unknown", 32)
  const integrityMode = clean(plan?.integrityMode || state?.integrityMode || "development", 32)
  const verification =
    normalizeVerificationMode(plan?.verification ?? state?.verification) ?? "standard"
  const victoryMode = resolveVictoryAuditMode(plan, state, run).mode
  const budget =
    costs && typeof costs.budgetUsd === "number" ? `$${costs.budgetUsd}` : "unknown"
  const phase = clean(state?.phase || "UNKNOWN", 32)

  const counts = taskCounts(plan, state)
  const safeIds = counts.ids.filter((id) => SAFE_TASK_ID.test(id))
  const gateLine =
    verification === "strict"
      ? `- Gate (strict): ${
          safeIds.length
            ? evaluateStrictGate(
                run,
                safeIds.map((id) => ({ id, status: (state?.tasks?.[id]?.status as string) || "pending" })),
                "strict",
              ).status
            : "MISSING"
        }`
      : undefined
  const victoryGate = evaluateVictoryGate(run, victoryMode)
  const victoryStatus = victoryGate.skipped
    ? "SKIPPED"
    : victoryGate.status === "CONFIRMED"
      ? "CONFIRMED"
      : victoryGate.status === "REJECTED"
        ? "REJECTED"
        : "PENDING"

  const artifacts = ARTIFACT_INDEX.filter((rel) => isRegularRunFile(run, rel))
  const constraints: string[] = [
    "- Do not edit outside the run worktrees; the Sentinel owns state.json and plan.dag.json.",
    "- Do not publish, push, or open PRs; the Sentinel performs the merge.",
    "- Do not self-certify: verifier reports and the final gate are recomputed from artifacts.",
  ]
  if (verification === "strict") {
    constraints.push(
      "- Strict verification: every task needs a PASS falsifier challenge and a CLEAN security-auditor audit recorded via teamwork_wave_record.",
    )
  }
  if (victoryMode === "required") {
    constraints.push(
      "- Victory audit required: only team/victory-auditor may confirm, against ORIGINAL_REQUEST.md + requirements.json.",
    )
  } else {
    constraints.push("- Victory audit explicitly skipped for this run (recorded in the plan).")
  }

  const lines: string[] = [
    `# BRIEFING — ${timestamp}`,
    "",
    "## Mission",
    missionText(run),
    "",
    "## Identity",
    `- Session: ${sessionId}`,
    `- Topology: ${topology}`,
    `- Integrity mode: ${integrityMode}`,
    `- Verification mode: ${verification}`,
    `- Victory audit mode: ${victoryMode}`,
    `- Budget: ${budget}`,
    "",
    "## Key Constraints",
    ...constraints,
    "",
    "## Project Status",
    `- Phase: ${phase}`,
    `- Tasks: ${counts.total} total — pending ${counts.pending}, active ${counts.active}, verified_pass ${counts.verifiedPass}, failed ${counts.failed}, blocked ${counts.blocked}`,
    ...(gateLine ? [gateLine] : []),
    `- Victory: ${victoryStatus}`,
    "",
    "## Artifact Index",
    ...(artifacts.length ? artifacts.map((rel) => `- ${rel}`) : ["- (none yet)"]),
    "",
    "## Succession",
    "- Not supported on this host (ADR 0003); continuity is this briefing.",
    "",
  ]
  return boundBriefing(lines.join("\n"))
}

/**
 * Rebuild and atomically replace `<run>/BRIEFING.md`. Idempotent: unchanged
 * content is not rewritten. Throws on refusal (symlink, containment, I/O); the
 * caller is expected to swallow that and record a warning.
 */
export function refreshRunBriefing(run: string): { changed: boolean; bytes: number } {
  const file = join(run, BRIEFING_FILE)
  const existing = readBoundedRunFile(run, file, MAX_BRIEFING_BYTES)
  // Preserve the previous timestamp when nothing else changed, so a repeated
  // refresh is byte-identical and does not rewrite the file.
  if (existing.status === "ok") {
    const stamp = /^# BRIEFING — (\S+)/.exec(existing.text)?.[1]
    if (stamp && !Number.isNaN(Date.parse(stamp))) {
      const same = buildBriefing(run, stamp)
      if (same === existing.text) {
        return { changed: false, bytes: Buffer.byteLength(same, "utf8") }
      }
    }
  }
  const text = buildBriefing(run)
  const bytes = Buffer.byteLength(text, "utf8")
  writeSafeRunFile(run, file, text)
  return { changed: true, bytes }
}

/**
 * Bounded, no-follow excerpt for context injection. Returns undefined when the
 * briefing is absent or refused, so legacy runs keep their exact old context.
 */
export function readBriefingExcerpt(
  run: string,
  maxBytes = BRIEFING_EXCERPT_BYTES,
): { text: string; truncated: boolean; bytes: number } | undefined {
  const res = readBoundedRunFile(run, join(run, BRIEFING_FILE), MAX_BRIEFING_BYTES)
  if (res.status !== "ok" || !res.text.trim()) return undefined
  const safe = sanitizeBriefingOutput(res.text, MAX_BRIEFING_BYTES)
  const bytes = Buffer.byteLength(safe, "utf8")
  if (bytes <= maxBytes) return { text: safe, truncated: false, bytes }
  return { text: truncateUtf8(safe, maxBytes), truncated: true, bytes }
}
