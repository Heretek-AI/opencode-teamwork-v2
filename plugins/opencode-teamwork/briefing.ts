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

import { createHash } from "node:crypto"
import { lstatSync, readdirSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import {
  clean,
  ensureSafeRunSubpath,
  readBoundedRunFile,
  readBoundedRunJson,
  writeSafeRunFile,
} from "./tournament.ts"
import { evaluateStrictGate, normalizeVerificationMode } from "./strict.ts"
import { evaluateVictoryGate, readVictoryVerdict, recordedVictorySkipReason, resolveVictoryAuditMode } from "./victory.ts"

export const BRIEFING_FILE = "BRIEFING.md"
/** Hard cap for the on-disk briefing, in UTF-8 bytes. */
export const MAX_BRIEFING_BYTES = 16 * 1024
/** How much of the briefing is injected into <run>/context. */
export const BRIEFING_EXCERPT_BYTES = 4 * 1024

/** Per-agent briefings live under `<run>/agents/<slug>-<hash32>/BRIEFING.md`. */
export const AGENT_BRIEFING_DIR = "agents"
export const MAX_AGENT_BRIEFING_DIRS = 64
const AGENT_BRIEFING_DIR_RE = /^[a-z][a-z0-9-]{0,31}-[0-9a-f]{32}$/
const AGENT_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/

const MAX_MISSION_CHARS = 2000
const MAX_MISSION_READ_BYTES = 64 * 1024
const MAX_SPEC_READ_BYTES = 64 * 1024
const MAX_COSTS_READ_BYTES = 64 * 1024

// Preserve "\n" (0x0a) for blocks; replace every other control / line
// separator. \x00-\x09 covers tab; \x0b-\x1f covers CR; \x7f-\x9f covers NEL.
const BLOCK_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ARTIFACT_INDEX = [
  "plan.dag.json",
  "state.json",
  "ORIGINAL_REQUEST.md",
  "requirements.json",
  "verify/final.json",
  "GATE_STATUS.md",
] as const

/** Stringify only primitives; objects/arrays/functions become "". */
function primitiveText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

/**
 * Sanitise multi-line briefing text while keeping "\n". Caps by characters and
 * marks a truncation. Never returns a raw control character.
 */
export function sanitizeBriefingText(value: unknown, max = MAX_MISSION_CHARS): string {
  const raw = primitiveText(value).replace(BLOCK_CONTROL, " ")
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
  const raw = primitiveText(value).replace(BLOCK_CONTROL, " ")
  return raw.length > max ? raw.slice(0, Math.max(0, max - 1)) + "…" : raw
}

/**
 * Escape ATX heading markers at the start of a line, so verbatim mission text
 * can never create a new `## ...` section in the briefing.
 */
function defuseHeadings(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, String.raw`$1\$2`))
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

function readRunValue(run: string, rel: string, maxBytes: number): any {
  const res = readBoundedRunJson<any>(run, join(run, rel), maxBytes)
  return res.status === "ok" ? res.value : undefined
}

function taskStatus(stateTasks: any, id: string): string {
  const own = Object.hasOwn(stateTasks, id) ? stateTasks[id] : undefined
  return typeof own?.status === "string" ? own.status : "pending"
}

type TaskBucket = "pending" | "active" | "verifiedPass" | "failed" | "blocked"

function taskBucket(status: string): TaskBucket {
  if (status === "worker_active" || status === "worker_done" || status === "verifier_active") return "active"
  if (status === "verified_pass" || status === "pass") return "verifiedPass"
  if (status === "verified_fail" || status === "fail") return "failed"
  if (status === "blocked") return "blocked"
  return "pending"
}

function collectTaskIds(plan: any, state: any): string[] {
  const fromPlan: string[] = Array.isArray(plan?.tasks)
    ? plan.tasks.map((t: any) => t?.id).filter((id: any) => typeof id === "string")
    : []
  const stateTasks = state?.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks) ? state.tasks : {}
  const ids: string[] = []
  for (const id of [...fromPlan, ...Object.keys(stateTasks)]) if (!ids.includes(id)) ids.push(id)
  return ids
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
  const stateTasks = state?.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks) ? state.tasks : {}
  const ids = collectTaskIds(plan, state)
  const counts: Record<TaskBucket, number> = { pending: 0, active: 0, verifiedPass: 0, failed: 0, blocked: 0 }
  for (const id of ids) counts[taskBucket(taskStatus(stateTasks, id))]++
  return { total: ids.length, ...counts, ids }
}

function identityFor(run: string, plan: any, state: any, costs: any) {
  return {
    sessionId: clean(plan?.sessionId || state?.sessionId || run.split(/[\\/]/).pop() || "unknown", 64),
    topology: clean(plan?.topology || "unknown", 32),
    integrityMode: clean(plan?.integrityMode || state?.integrityMode || "development", 32),
    verification: normalizeVerificationMode(plan?.verification ?? state?.verification) ?? "standard",
    victoryMode: resolveVictoryAuditMode(plan, state, run).mode,
    victorySkipReason:
      recordedVictorySkipReason(plan?.victorySkipReason) ?? recordedVictorySkipReason(state?.victorySkipReason),
    budget: costs && typeof costs.budgetUsd === "number" ? `$${costs.budgetUsd}` : "unknown",
    phase: clean(state?.phase || "UNKNOWN", 32),
  }
}

function strictGateStatus(run: string, ids: string[], stateTasks: any): string {
  if (!ids.length) return "MISSING"
  const gate = evaluateStrictGate(
    run,
    ids.map((id) => ({ id, status: taskStatus(stateTasks, id) })),
    "strict",
  )
  return gate.status
}

function victoryStatusLabel(
  gate: ReturnType<typeof evaluateVictoryGate>,
  envelope: "none" | "present",
): string {
  if (gate.skipped) return gate.reason ? `SKIPPED (explicit): ${gate.reason}` : "SKIPPED (legacy default)"
  if (gate.status === "CONFIRMED") {
    // The briefing is semantic-only and does not verify envelopes. Never render
    // an unsigned or unverified victory.json as a plain CONFIRMED.
    return envelope === "present"
      ? "CONFIRMED (envelope present; not verified by the briefing)"
      : "CONFIRMED (unverified envelope)"
  }
  if (gate.status === "REJECTED") return "REJECTED"
  if (gate.status === "AUTH_STALE") {
    return envelope === "present"
      ? "CONFIRMED (envelope present; stale or unbound evidence)"
      : "CONFIRMED (unverified envelope; stale or unbound evidence)"
  }
  return "PENDING"
}

function constraintsFor(verification: string, victoryMode: string): string[] {
  const constraints = [
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
  return constraints
}

/**
 * Build the full briefing text. Reads only run-local artifacts through the
 * bounded, no-follow helpers, and sanitises every value it interpolates.
 */
export function buildBriefing(
  run: string,
  timestamp = new Date().toISOString(),
  extraIdentity: string[] = [],
): string {
  const plan = readRunValue(run, "plan.dag.json", 8 * 1024 * 1024)
  const state = readRunValue(run, "state.json", 8 * 1024 * 1024)
  const costs = readRunValue(run, "costs.json", MAX_COSTS_READ_BYTES)
  const identity = identityFor(run, plan, state, costs)
  const counts = taskCounts(plan, state)
  const safeIds = counts.ids.filter((id) => SAFE_TASK_ID.test(id))
  const gateLine =
    identity.verification === "strict"
      ? `- Gate (strict): ${strictGateStatus(run, safeIds, state?.tasks)}`
      : undefined
  const victoryRecord = readVictoryVerdict(run)
  const victoryEnvelope: "none" | "present" =
    victoryRecord &&
    typeof (victoryRecord as any)._auth === "object" &&
    (victoryRecord as any)._auth !== null
      ? "present"
      : "none"
  const victory = victoryStatusLabel(
    evaluateVictoryGate(run, identity.victoryMode, identity.victorySkipReason),
    victoryEnvelope,
  )
  const artifacts = ARTIFACT_INDEX.filter((rel) => isRegularRunFile(run, rel))

  const lines: string[] = [
    `# BRIEFING — ${timestamp}`,
    "",
    "## Mission",
    missionText(run),
    "",
    "## Identity",
    `- Session: ${identity.sessionId}`,
    ...extraIdentity,
    `- Topology: ${identity.topology}`,
    `- Integrity mode: ${identity.integrityMode}`,
    `- Verification mode: ${identity.verification}`,
    `- Victory audit mode: ${identity.victoryMode}`,
    `- Budget: ${identity.budget}`,
    "",
    "## Key Constraints",
    ...constraintsFor(identity.verification, identity.victoryMode),
    "",
    "## Project Status",
    `- Phase: ${identity.phase}`,
    `- Tasks: ${counts.total} total — pending ${counts.pending}, active ${counts.active}, verified_pass ${counts.verifiedPass}, failed ${counts.failed}, blocked ${counts.blocked}`,
    ...(gateLine ? [gateLine] : []),
    `- Victory: ${victory}`,
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

// ---------------------------------------------------------------------------
// Per-agent briefing
//
// The shared briefing stays exactly as it was; a caller that is known
// (`session.context` has both `event.sessionID` and `event.agent`) also gets a
// per-agent copy at:
//
//   <run>/agents/<agentSlug>-<sha256(sessionID).slice(0,32)>/BRIEFING.md
//
// The directory name never contains the raw (up to 68-character) OpenCode
// session id, and both the slug and the hash shape are enforced on read and on
// prune. The copy is written lazily by the context hook, never by the gates.
// ---------------------------------------------------------------------------

/** `team/worker` → `worker`; undefined for any other shape. */
export function agentBriefingSlug(agent: unknown): string | undefined {
  const raw = typeof agent === "string" ? agent.trim() : ""
  const m = /^team\/([a-z][a-z0-9-]{0,31})$/.exec(raw)
  return m && AGENT_SLUG_RE.test(m[1]) ? m[1] : undefined
}

/** Plain sha256 of the OpenCode session id, first 32 hex chars. */
export function agentBriefingSessionHash(sessionID: unknown): string | undefined {
  if (typeof sessionID !== "string" || !sessionID.trim()) return undefined
  return createHash("sha256").update(sessionID, "utf8").digest("hex").slice(0, 32)
}

/** `<slug>-<hash32>`; the only directory name this feature writes. */
export function agentBriefingDirName(agent: unknown, sessionID: unknown): string | undefined {
  const slug = agentBriefingSlug(agent)
  const hash = agentBriefingSessionHash(sessionID)
  if (!slug || !hash) return undefined
  return `${slug}-${hash}`
}

/** Run-relative per-agent briefing path (`agents/<slug>-<hash32>/BRIEFING.md`). */
export function agentBriefingRelativePath(agent: unknown, sessionID: unknown): string | undefined {
  const dir = agentBriefingDirName(agent, sessionID)
  return dir ? `${AGENT_BRIEFING_DIR}/${dir}/${BRIEFING_FILE}` : undefined
}

/** Build the per-agent text from the shared briefing data + identity extras. */
export function buildAgentBriefing(
  run: string,
  agent: string,
  sessionID: string,
  timestamp = new Date().toISOString(),
): string {
  const runId = basename(run)
  const extras = [
    `- Agent: ${clean(agent, 64)}`,
    `- Agent session: ${clean(sessionID, 64)}`,
    `- Run session: ${runId}`,
  ]
  return buildBriefing(run, timestamp, extras)
}

function lstatOrNull(file: string) {
  try {
    return lstatSync(file)
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

function newestArtifactMtime(run: string): number {
  let newest = 0
  for (const rel of ["state.json", "plan.dag.json", "costs.json"]) {
    try {
      const st = lstatSync(join(run, rel))
      if (st.isFile() && !st.isSymbolicLink()) newest = Math.max(newest, st.mtimeMs)
    } catch {}
  }
  return newest
}

/**
 * Keep at most 64 per-agent briefing directories. Only correctly named real
 * directories are candidates; symlinks and any other entry are never touched.
 */
function pruneAgentBriefingDirs(run: string): void {
  const dir = join(run, AGENT_BRIEFING_DIR)
  let entries: { name: string }[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const candidates: { path: string; mtime: number }[] = []
  for (const entry of entries) {
    if (!AGENT_BRIEFING_DIR_RE.test(entry.name)) continue
    const path = join(dir, entry.name)
    let st
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue
    let mtime = st.mtimeMs
    try {
      const brief = lstatSync(join(path, BRIEFING_FILE))
      if (brief.isFile() && !brief.isSymbolicLink()) mtime = brief.mtimeMs
    } catch {}
    candidates.push({ path, mtime })
  }
  if (candidates.length <= MAX_AGENT_BRIEFING_DIRS) return
  candidates.sort((a, b) => a.mtime - b.mtime)
  for (const stale of candidates.slice(0, candidates.length - MAX_AGENT_BRIEFING_DIRS)) {
    try {
      rmSync(stale.path, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Write/refresh one per-agent briefing. Lazy: a regular, non-symlink copy whose
 * mtime is at least as new as state.json/plan.dag.json/costs.json is left alone.
 * Throws on refusal (symlink/FIFO/containment/I/O); the hook swallows that and
 * falls back to the shared briefing.
 */
export function refreshAgentBriefing(
  run: string,
  agent: string,
  sessionID: string,
): { changed: boolean; bytes: number; path?: string } {
  const rel = agentBriefingRelativePath(agent, sessionID)
  if (!rel) return { changed: false, bytes: 0 }
  const file = join(run, rel)
  const existing = lstatOrNull(file)
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`refused: per-agent briefing "${basename(file)}" is not a regular file`)
    }
    if (existing.mtimeMs >= newestArtifactMtime(run)) {
      return { changed: false, bytes: existing.size, path: file }
    }
  }
  const text = buildAgentBriefing(run, agent, sessionID)
  const bytes = Buffer.byteLength(text, "utf8")
  writeSafeRunFile(run, file, text)
  pruneAgentBriefingDirs(run)
  return { changed: true, bytes, path: file }
}

/** Bounded, no-follow per-agent excerpt; undefined when absent/refused. */
export function readAgentBriefingExcerpt(
  run: string,
  agent: string,
  sessionID: string,
  maxBytes = BRIEFING_EXCERPT_BYTES,
): { text: string; truncated: boolean; bytes: number; path: string } | undefined {
  const rel = agentBriefingRelativePath(agent, sessionID)
  if (!rel) return undefined
  const file = join(run, rel)
  const res = readBoundedRunFile(run, file, MAX_BRIEFING_BYTES)
  if (res.status !== "ok" || !res.text.trim()) return undefined
  const safe = sanitizeBriefingOutput(res.text, MAX_BRIEFING_BYTES)
  const bytes = Buffer.byteLength(safe, "utf8")
  if (bytes <= maxBytes) return { text: safe, truncated: false, bytes, path: file }
  return { text: truncateUtf8(safe, maxBytes), truncated: true, bytes, path: file }
}
