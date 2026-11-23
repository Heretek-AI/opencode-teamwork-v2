// opencode-teamwork — canonical agent handoffs
//
// A handoff is the narrative record one agent leaves for the next one, written
// through a trusted tool instead of an unqualified `handoff.md` in whatever
// directory the agent happened to be in. Each handoff is:
//
//   * task-scoped (`<run>/handoffs/<taskId>-<agent>.md`) or run-level
//     (`<run>/handoffs/_run-<agent>.md`) — the path is derived, never supplied;
//   * composed of exactly five sections: Observation, Logic Chain, Caveats,
//     Conclusion, Verification Method;
//   * bounded (2 KiB/section, 8 KiB total), control-character scrubbed, and
//     heading-defused so one section cannot forge another;
//   * recorded in a bounded `<run>/handoffs/index.json` with a plain sha256 of
//     the exact bytes written;
//   * cross-referenced to existing verifier/audit/victory artifacts as
//     citations only. A handoff is never a source of a gate verdict.
//
// Zero runtime dependencies. Erasable TypeScript only.

import { lstatSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { sha256Hex } from "./auth.ts"
import type { AuthContext, AuthEnvelope, AuthFailure } from "./auth.ts"
import { clean, isSafeTaskId, readBoundedRunFile, writeSafeRunFile } from "./tournament.ts"
import { withPinnedCrossProcessLock } from "./locks.ts"

/** Domain separator for the signed handoff index payload. */
export const HANDOFF_AUTH_KIND = "teamwork.handoff"
export const HANDOFF_AUTH_VERSION = 1

export const HANDOFF_SECTIONS = [
  "Observation",
  "Logic Chain",
  "Caveats",
  "Conclusion",
  "Verification Method",
] as const

/** The exact heading labels, in order (`## 1. Observation` …). */
export const HANDOFF_SECTION_LABELS = HANDOFF_SECTIONS.map((name, i) => `${i + 1}. ${name}`)

export const HANDOFF_DIR = "handoffs"
export const HANDOFF_INDEX_FILE = "index.json"
export const RUN_LEVEL_HANDOFF_ID = "_run"

/** Whether final completion requires the handoff matrix or records an explicit skip. */
export const HANDOFF_MODES = ["required", "skip"] as const
export type HandoffMode = (typeof HANDOFF_MODES)[number]
/** Per-section cap after sanitisation (UTF-8 bytes). */
export const MAX_HANDOFF_SECTION_BYTES = 2 * 1024
/** Total cap for the five section bodies (UTF-8 bytes). */
export const MAX_HANDOFF_BYTES = 8 * 1024
/** Index caps: newest 200 entries, 256 KiB on disk. */
export const MAX_HANDOFF_ENTRIES = 200
export const MAX_HANDOFF_INDEX_BYTES = 256 * 1024

const CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g
const AGENT_SLUG = /^[a-z][a-z0-9-]{0,31}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const RUN_HANDOFF_PATH = /^handoffs\/[A-Za-z0-9._-]+\.md$/
const CITE_PATH = /^verify\/[A-Za-z0-9._-]+\.json$/

export const TASK_SCOPED_HANDOFF_ROLES = [
  "team/worker",
  "team/proof-worker",
  "team/segment-reviewer",
  "team/synthesizer",
  "team/verifier",
  "team/falsifier",
  "team/security-auditor",
] as const

/** These roles record run-level handoffs and must omit `taskId`. */
export const RUN_LEVEL_HANDOFF_ROLES = ["team/victory-auditor", "team/sentinel", "team/orchestrator"] as const

export type HandoffCite = { path: string; sha256: string }

export interface HandoffIndexEntry {
  taskId: string
  agent: string
  agentSessionId: string
  round: number
  path: string
  sha256: string
  bytes: number
  generatedAt: string
  cites: HandoffCite[]
  /**
   * Key id used to sign this entry. Absent on an unsigned legacy entry; the
   * checked gate requires it to equal the plan manifest's `runKeyId`.
   */
  runKeyId?: string
  /** HMAC envelope over the entry payload; absent on an unsigned legacy entry. */
  _auth?: AuthEnvelope
}

export interface HandoffIndex {
  version: 1
  sessionId: string
  updatedAt: string
  entries: HandoffIndexEntry[]
}

export interface HandoffSections {
  observation: string
  logicChain: string
  caveats: string
  conclusion: string
  verificationMethod: string
}

export interface NormalizedHandoffSection {
  label: string
  body: string
}

const SECTION_FIELDS: { field: keyof HandoffSections; label: string }[] = [
  { field: "observation", label: HANDOFF_SECTION_LABELS[0] },
  { field: "logicChain", label: HANDOFF_SECTION_LABELS[1] },
  { field: "caveats", label: HANDOFF_SECTION_LABELS[2] },
  { field: "conclusion", label: HANDOFF_SECTION_LABELS[3] },
  { field: "verificationMethod", label: HANDOFF_SECTION_LABELS[4] },
]

/** Escape an ATX heading at the start of a line so a section cannot forge one. */
function defuseHeading(line: string): string {
  return line.replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, String.raw`$1\$2`)
}

/**
 * Control-character scrub + heading defuse. Preserves newlines, collapses
 * three or more blank lines, trims, and never returns a raw control character.
 * Oversize is refused by `validateHandoffSections`, not truncated here.
 */
export function sanitizeHandoffText(value: unknown): string {
  const raw = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, " ")
  return raw
    .split("\n")
    .map(defuseHeading)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Validate and sanitise the five section strings. Every section must be
 * non-empty after sanitisation; per-section and total caps are enforced before
 * anything is written.
 */
export function validateHandoffSections(
  input: Partial<Record<keyof HandoffSections, unknown>>,
): { ok: true; sections: NormalizedHandoffSection[] } | { ok: false; error: string } {
  const sections: NormalizedHandoffSection[] = []
  let total = 0
  for (const { field, label } of SECTION_FIELDS) {
    const raw = input?.[field]
    if (typeof raw !== "string") {
      return { ok: false, error: `refused: handoff section "${label}" must be a string; nothing was written` }
    }
    const body = sanitizeHandoffText(raw)
    if (!body) {
      return { ok: false, error: `refused: handoff section "${label}" is empty after sanitisation; nothing was written` }
    }
    const bytes = Buffer.byteLength(body, "utf8")
    if (bytes > MAX_HANDOFF_SECTION_BYTES) {
      return {
        ok: false,
        error: `refused: handoff section "${label}" is ${bytes} bytes (cap ${MAX_HANDOFF_SECTION_BYTES}); nothing was written`,
      }
    }
    total += bytes
    sections.push({ label, body })
  }
  if (total > MAX_HANDOFF_BYTES) {
    return {
      ok: false,
      error: `refused: handoff sections total ${total} bytes (cap ${MAX_HANDOFF_BYTES}); nothing was written`,
    }
  }
  return { ok: true, sections }
}

/** `team/worker` → `worker`; only the trusted installed-role shape is accepted. */
export function handoffAgentSlug(agent: unknown): string | undefined {
  const raw = typeof agent === "string" ? agent.trim() : ""
  const m = /^team\/([a-z][a-z0-9-]{0,31})$/.exec(raw)
  return m && AGENT_SLUG.test(m[1]) ? m[1] : undefined
}

function isTaskScopedRole(agent: string): boolean {
  return (TASK_SCOPED_HANDOFF_ROLES as readonly string[]).includes(agent)
}

function isRunLevelRole(agent: string): boolean {
  return (RUN_LEVEL_HANDOFF_ROLES as readonly string[]).includes(agent)
}

/**
 * Resolve the caller's trusted agent and optional task id into a handoff scope.
 * Task-scoped roles (including the security auditor's per-task strict audit)
 * must name an existing-safe task id; run-level roles must omit it (or pass
 * `_run`). A caller can never widen its own scope.
 */
export function resolveHandoffScope(
  agent: string,
  rawTaskId: unknown,
): { ok: true; taskKey: string; taskId?: string } | { ok: false; error: string } {
  if (!isTaskScopedRole(agent) && !isRunLevelRole(agent)) {
    return { ok: false, error: `refused: ${clean(agent, 64) || "this role"} may not record a handoff; nothing was written` }
  }
  const raw = typeof rawTaskId === "string" ? rawTaskId.trim() : ""
  const runLevel = raw === "" || raw === RUN_LEVEL_HANDOFF_ID
  // The security auditor writes both a task-scoped strict audit and the
  // run-level pre-merge audit; every other task-scoped role needs a task.
  const canRunLevel = isRunLevelRole(agent) || agent === "team/security-auditor"
  if (runLevel) {
    if (isTaskScopedRole(agent) && !canRunLevel) {
      return {
        ok: false,
        error: `refused: ${agent} must record a task-scoped handoff (taskId is required); nothing was written`,
      }
    }
    return { ok: true, taskKey: RUN_LEVEL_HANDOFF_ID }
  }
  if (isRunLevelRole(agent)) {
    return {
      ok: false,
      error: `refused: ${agent} writes run-level handoffs only; omit taskId (or pass "${RUN_LEVEL_HANDOFF_ID}"); nothing was written`,
    }
  }
  if (!isSafeTaskId(raw)) {
    return { ok: false, error: `refused: invalid taskId "${clean(raw, 32)}" (must be one safe path segment); nothing was written` }
  }
  return { ok: true, taskKey: raw, taskId: raw }
}

export function handoffRelativePath(taskKey: string, agentSlug: string): string {
  return `${HANDOFF_DIR}/${taskKey}-${agentSlug}.md`
}

export function handoffIndexRelativePath(): string {
  return `${HANDOFF_DIR}/${HANDOFF_INDEX_FILE}`
}

/**
 * The citation a role's handoff may carry when the artifact exists. Citations
 * are evidence pointers, never a verdict source.
 */
export function handoffCiteRelativePath(agent: string, taskId?: string): string | undefined {
  if (taskId) {
    if (agent === "team/verifier") return `verify/report-${taskId}.json`
    if (agent === "team/falsifier") return `verify/challenge-${taskId}.json`
    if (agent === "team/security-auditor") return `verify/audit-${taskId}.json`
    return undefined
  }
  if (agent === "team/security-auditor") return "verify/security-audit.json"
  if (agent === "team/victory-auditor") return "verify/victory.json"
  return undefined
}

function collectCites(run: string, agent: string, taskId?: string): HandoffCite[] {
  const rel = handoffCiteRelativePath(agent, taskId)
  if (!rel) return []
  const res = readBoundedRunFile(run, join(run, rel), 8 * 1024 * 1024)
  if (res.status !== "ok") return []
  return [{ path: rel, sha256: sha256Hex(res.text) }]
}

function isFiniteRound(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function handoffMarkdown(opts: {
  taskKey: string
  taskId?: string
  runId: string
  agent: string
  agentSessionId: string
  round: number
  generatedAt: string
  sections: NormalizedHandoffSection[]
  cites: HandoffCite[]
}): string {
  const lines = [
    `# HANDOFF — ${opts.taskId ?? opts.taskKey} — ${opts.agent}`,
    "",
    `- Run: ${opts.runId}`,
    `- Agent: ${opts.agent}`,
    `- Agent session: ${opts.agentSessionId}`,
    `- Task: ${opts.taskId ?? `${RUN_LEVEL_HANDOFF_ID} (run-level)`}`,
    `- Round: ${opts.round}`,
    `- Generated: ${opts.generatedAt}`,
    `- Citations: ${opts.cites.length ? opts.cites.map((c) => `${c.path} (sha256 ${c.sha256})`).join(", ") : "none"}`,
    "",
  ]
  for (const section of opts.sections) {
    lines.push(`## ${section.label}`, "", section.body, "")
  }
  return lines.join("\n")
}

function validCite(value: unknown): value is HandoffCite {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const c = value as any
  return typeof c.path === "string" && CITE_PATH.test(c.path) && typeof c.sha256 === "string" && SHA256_HEX.test(c.sha256)
}

function validIndexEntry(value: unknown): value is HandoffIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const e = value as any
  if (typeof e.taskId !== "string" || (e.taskId !== RUN_LEVEL_HANDOFF_ID && !isSafeTaskId(e.taskId))) return false
  if (typeof e.agent !== "string") return false
  const slug = handoffAgentSlug(e.agent)
  if (!slug) return false
  if (typeof e.agentSessionId !== "string" || e.agentSessionId.trim() === "") return false
  if (!Number.isFinite(e.round) || Number(e.round) < 0) return false
  if (typeof e.path !== "string" || !RUN_HANDOFF_PATH.test(e.path) || e.path !== handoffRelativePath(e.taskId, slug)) return false
  if (typeof e.sha256 !== "string" || !SHA256_HEX.test(e.sha256)) return false
  if (!Number.isFinite(e.bytes) || Number(e.bytes) < 0) return false
  if (typeof e.generatedAt !== "string" || Number.isNaN(Date.parse(e.generatedAt))) return false
  if (!Array.isArray(e.cites) || !e.cites.every(validCite)) return false
  return true
}

function readIndex(run: string): HandoffIndex {
  const res = readBoundedRunFile(run, join(run, handoffIndexRelativePath()), MAX_HANDOFF_INDEX_BYTES)
  if (res.status === "absent") {
    return { version: 1, sessionId: basename(run), updatedAt: new Date().toISOString(), entries: [] }
  }
  if (res.status !== "ok") throw new Error(res.error)
  let parsed: any
  try {
    parsed = JSON.parse(res.text)
  } catch {
    throw new Error("refused: handoffs/index.json is malformed JSON; nothing was written")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("refused: handoffs/index.json has an unsupported schema; nothing was written")
  }
  return {
    version: 1,
    sessionId: typeof parsed.sessionId === "string" ? clean(parsed.sessionId, 64) : basename(run),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    entries: parsed.entries.filter(validIndexEntry),
  }
}

function writeIndex(run: string, index: HandoffIndex): void {
  let entries = index.entries
  if (entries.length > MAX_HANDOFF_ENTRIES) {
    const sorted = [...entries].sort((a, b) => (Date.parse(a.generatedAt) || 0) - (Date.parse(b.generatedAt) || 0))
    entries = sorted.slice(-MAX_HANDOFF_ENTRIES)
  }
  const next: HandoffIndex = { ...index, entries }
  let text = JSON.stringify(next, null, 2) + "\n"
  while (Buffer.byteLength(text, "utf8") > MAX_HANDOFF_INDEX_BYTES && next.entries.length > 0) {
    next.entries = next.entries.slice(1)
    text = JSON.stringify(next, null, 2) + "\n"
  }
  writeSafeRunFile(run, join(run, handoffIndexRelativePath()), text)
}

function updateIndex(run: string, entry: HandoffIndexEntry): HandoffIndex {
  const index = readIndex(run)
  const key = `${entry.taskId}\u0000${entry.agent}`
  const kept = index.entries.filter((e) => `${e.taskId}\u0000${e.agent}` !== key)
  kept.push(entry)
  const next: HandoffIndex = {
    version: 1,
    sessionId: basename(run),
    updatedAt: new Date().toISOString(),
    entries: kept,
  }
  writeIndex(run, next)
  return next
}

function assertRegularOrAbsent(file: string): void {
  try {
    const st = lstatSync(file)
    if (st.isSymbolicLink()) throw new Error(`refused: handoff target "${basename(file)}" is a symlink`)
    if (!st.isFile()) throw new Error(`refused: handoff target "${basename(file)}" is not a regular file`)
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }
}

export interface WriteHandoffOptions {
  sessionId: string
  agent: string
  agentSessionId: string
  taskId?: string
  round?: number
  sections: Partial<Record<keyof HandoffSections, unknown>>
  generatedAt?: string
  /** Authenticity context. When present the entry is signed opportunistically. */
  auth?: AuthContext
  /**
   * True on a run whose manifest pinned `handoffAuth: "signed"`. A signing
   * failure then refuses the write instead of recording an unsigned entry.
   */
  requireSigned?: boolean
}

interface PreparedHandoff {
  file: string
  relativePath: string
  runId: string
  sha256: string
  bytes: number
  entry: HandoffIndexEntry
}

interface WrittenHandoff {
  path: string
  relativePath: string
  sha256: string
  bytes: number
  entry: HandoffIndexEntry
  index: HandoffIndex
}

/** Build the canonical payload that binds one index entry to its run and body. */
export function handoffAuthPayload(runId: string, entry: HandoffIndexEntry): Record<string, unknown> {
  return {
    kind: HANDOFF_AUTH_KIND,
    v: HANDOFF_AUTH_VERSION,
    runId,
    ...(typeof entry.runKeyId === "string" ? { runKeyId: entry.runKeyId } : {}),
    taskId: entry.taskId,
    agent: entry.agent,
    agentSessionId: entry.agentSessionId,
    round: entry.round,
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    generatedAt: entry.generatedAt,
    cites: entry.cites,
    ...(entry._auth !== undefined ? { _auth: entry._auth } : {}),
  }
}

function authRefusal(failure: AuthFailure, detail: string): Error {
  const err = new Error(`refused: [${failure.code}] ${detail}`)
  ;(err as any).failure = failure
  return err
}

/**
 * Validate and compose one handoff, then write the markdown atomically. The
 * index entry is not touched here, so a later signing refusal cannot leave an
 * unsigned entry behind.
 */
function prepareHandoff(run: string, opts: WriteHandoffOptions): PreparedHandoff {
  const slug = handoffAgentSlug(opts.agent)
  if (!slug) throw new Error("refused: the caller agent is not a team/<role> handoff author; nothing was written")
  const scope = resolveHandoffScope(opts.agent, opts.taskId)
  if (!scope.ok) throw new Error(scope.error)
  const normalized = validateHandoffSections(opts.sections)
  if (!normalized.ok) throw new Error(normalized.error)

  const runId = basename(run)
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const round = isFiniteRound(opts.round)
  const agentSessionId = clean(opts.agentSessionId, 64).trim()
  const cites = collectCites(run, opts.agent, scope.taskId)
  const text = handoffMarkdown({
    taskKey: scope.taskKey,
    taskId: scope.taskId,
    runId,
    agent: opts.agent,
    agentSessionId,
    round,
    generatedAt,
    sections: normalized.sections,
    cites,
  })
  const bytes = Buffer.byteLength(text, "utf8")
  const sha256 = sha256Hex(text)
  const relativePath = handoffRelativePath(scope.taskKey, slug)
  const file = join(run, relativePath)

  // Refuse a non-regular destination (symlink/FIFO/device) before the atomic
  // replace. writeSafeRunFile independently re-checks containment and uses a
  // fresh O_EXCL temp, so a planted temp link cannot redirect the write.
  assertRegularOrAbsent(file)
  writeSafeRunFile(run, file, text)

  return {
    file,
    relativePath,
    runId,
    sha256,
    bytes,
    entry: {
      taskId: scope.taskKey,
      agent: opts.agent,
      agentSessionId,
      round,
      path: relativePath,
      sha256,
      bytes,
      generatedAt,
      cites,
    },
  }
}

function finishHandoff(run: string, prepared: PreparedHandoff, entry: HandoffIndexEntry): WrittenHandoff {
  const index = updateIndex(run, entry)
  return {
    path: prepared.file,
    relativePath: prepared.relativePath,
    sha256: prepared.sha256,
    bytes: prepared.bytes,
    entry,
    index,
  }
}

/**
 * Sign one prepared entry. The plan key id is resolved before signing so the
 * payload and the stored `runKeyId` agree; the digest index record is written
 * by `signRunArtifact`.
 */
async function signPreparedHandoff(prepared: PreparedHandoff, auth: AuthContext): Promise<HandoffIndexEntry> {
  const ready = await auth.ready()
  if (!ready.ok) throw authRefusal(ready.failure, `could not resolve an authenticity key for ${prepared.relativePath}`)
  const payload = handoffAuthPayload(prepared.runId, { ...prepared.entry, runKeyId: ready.keyId })
  let signed: any
  try {
    signed = await auth.signRunArtifact(prepared.runId, prepared.relativePath, payload)
  } catch (err: any) {
    const failure: AuthFailure = err?.failure ?? { code: "AUTH_UNAVAILABLE", message: clean(err?.message ?? err, 200) }
    throw authRefusal(failure, `could not sign ${prepared.relativePath} (${clean(err?.message ?? err, 200)})`)
  }
  const envelope = signed?._auth as AuthEnvelope | undefined
  if (!envelope || envelope.keyId !== ready.keyId) {
    throw authRefusal(
      { code: "AUTH_INVALID", message: "the signing helper returned an envelope for a different key" },
      `could not bind ${prepared.relativePath} to run key ${ready.keyId}`,
    )
  }
  return { ...prepared.entry, runKeyId: ready.keyId, _auth: envelope }
}

/**
 * Write one handoff markdown file and refresh the bounded index, without
 * signing. Throws a `refused:` error on any validation/containment failure;
 * nothing is written in that case (the markdown is validated before its first
 * write). Use `writeHandoff` when an authenticity context is available.
 */
export function writeHandoffSync(run: string, opts: WriteHandoffOptions): WrittenHandoff {
  if (opts.auth) {
    throw new Error("refused: writeHandoffSync cannot sign; use the async writeHandoff")
  }
  const prepared = prepareHandoff(run, opts)
  return finishHandoff(run, prepared, prepared.entry)
}

/**
 * Async writer. The markdown is written first, then the index entry is signed
 * (when `opts.auth` is present) and committed under the handoff-index lock. A
 * required signature that cannot be produced refuses the call and writes no
 * unsigned entry; a legacy run keeps the unsigned entry so a 0.8.0 run still
 * works, and re-recording upgrades that pair on any later call.
 */
export async function writeHandoff(run: string, opts: WriteHandoffOptions): Promise<WrittenHandoff> {
  return withPinnedCrossProcessLock(run, handoffIndexRelativePath(), async () => {
    const prepared = prepareHandoff(run, opts)
    let entry = prepared.entry
    if (opts.auth) {
      try {
        entry = await signPreparedHandoff(prepared, opts.auth)
      } catch (err) {
        if (opts.requireSigned) throw err
        // Legacy migration: an unsigned entry is tolerated on a legacy run.
      }
    }
    return finishHandoff(run, prepared, entry)
  })
}

/** List valid handoff documents (used by tests/diagnostics); never follows links. */
export function listHandoffFiles(run: string): string[] {
  try {
    return readdirSync(join(run, HANDOFF_DIR))
      .filter((name) => /^[A-Za-z0-9._-]+\.md$/.test(name))
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Continuity gate
//
// The gate is derived from plan/state, never from a caller's claim. Handoff
// prose is never parsed for PASS/FAIL: only file identity, index hashes and
// citation hashes are checked, so a handoff can make a run fail (missing or
// stale evidence) but can never make one pass.
// ---------------------------------------------------------------------------

/** True when `value` is a recognised handoff mode. */
export function normalizeHandoffMode(value: unknown): HandoffMode | undefined {
  return value === "required" || value === "skip" ? value : undefined
}

/**
 * Resolve the run's handoff mode from persisted plan/state. A legacy run with
 * no field predates the continuity gate and keeps the old behaviour (skip);
 * strict is never inferred. An unsigned legacy plan records the effective skip.
 */
export function resolveHandoffMode(
  plan: any,
  state: any,
): { mode: HandoffMode; source: "plan" | "state" | "legacy" } {
  const fromPlan = normalizeHandoffMode(plan?.requireHandoffs)
  if (fromPlan) return { mode: fromPlan, source: "plan" }
  const fromState = normalizeHandoffMode(state?.requireHandoffs)
  if (fromState) return { mode: fromState, source: "state" }
  return { mode: "skip", source: "legacy" }
}

export interface HandoffTaskRef {
  id: string
  agent?: string
}

export interface RequiredHandoffPair {
  taskId: string
  agent: string
}

export interface HandoffGateRequirement {
  taskId: string
  /** One of these agents satisfies the requirement (exactly one entry). */
  agents: string[]
  label: string
}

export interface HandoffGateEntryEvidence {
  taskId: string
  agent: string
  path: string
  sha256: string
  agentSessionId: string
  cites: HandoffCite[]
  /** Provenance of this entry, checked only against `_auth`, never prose. */
  auth?: "signed" | "unsigned" | "invalid"
  keyId?: string
}

export interface HandoffGate {
  mode: HandoffMode
  skipped: boolean
  ok: boolean
  status: "SKIPPED" | "PASS" | "MISSING" | "STALE" | "INVALID"
  reasons: string[]
  missing: Array<{ taskId: string; agent: string }>
  required: RequiredHandoffPair[]
  entries: HandoffGateEntryEvidence[]
  /** Aggregate provenance of the required entries when the checked gate ran. */
  auth?: "signed" | "unsigned" | "invalid"
}

export interface HandoffAuthCheckOptions {
  /** Authenticity context; absent fails closed for a signed entry. */
  auth?: AuthContext
  /** True when the run manifest pinned `handoffAuth: "signed"`. */
  requireSigned?: boolean
  /** The plan manifest's run key id; signed entries must match it. */
  manifestRunKeyId?: string
}

export interface HandoffEntryAuthCheck {
  status: "signed" | "unsigned" | "invalid"
  keyId?: string
  failure?: AuthFailure
}

/**
 * Verify one index entry's `_auth`. The signed payload is reconstructed from
 * the entry plus the run id, so a copied envelope fails on path/digest/run and a
 * changed entry field fails on the payload digest. Prose is never inspected.
 */
export async function checkHandoffEntryAuth(
  run: string,
  entry: HandoffIndexEntry,
  opts: HandoffAuthCheckOptions,
): Promise<HandoffEntryAuthCheck> {
  const raw = (entry as any)._auth
  if (raw === undefined || raw === null) {
    if (opts.requireSigned) {
      return {
        status: "invalid",
        failure: { code: "AUTH_MISSING", message: `${entry.path} has no _auth envelope (a signed run requires one)` },
      }
    }
    return { status: "unsigned" }
  }
  if (!opts.auth) {
    return {
      status: "invalid",
      failure: { code: "AUTH_UNAVAILABLE", message: "no authenticity context is wired for this run" },
    }
  }
  const runId = basename(run)
  const check = await opts.auth.verifyRunArtifact(runId, entry.path, handoffAuthPayload(runId, entry))
  if (check.status !== "signed") {
    if (check.status === "unsigned") {
      return {
        status: "invalid",
        failure: { code: "AUTH_MISSING", message: `${entry.path} has no _auth envelope` },
      }
    }
    return {
      status: "invalid",
      keyId: check.keyId,
      failure: check.failure ?? { code: "AUTH_INVALID", message: `${entry.path} failed authenticity verification` },
    }
  }
  if (typeof entry.runKeyId !== "string" || entry.runKeyId !== check.keyId) {
    return {
      status: "invalid",
      keyId: check.keyId,
      failure: {
        code: "AUTH_INVALID",
        message: `${entry.path} runKeyId ${String(entry.runKeyId)} does not match the signing key ${check.keyId}`,
      },
    }
  }
  if (opts.manifestRunKeyId !== undefined && entry.runKeyId !== opts.manifestRunKeyId) {
    return {
      status: "invalid",
      keyId: check.keyId,
      failure: {
        code: "AUTH_INVALID",
        message: `${entry.path} runKeyId ${entry.runKeyId} does not match run.manifest.json ${opts.manifestRunKeyId}`,
      },
    }
  }
  return { status: "signed", keyId: check.keyId }
}

/**
 * Continuity gate plus provenance. The structural gate runs unchanged; this
 * wrapper only appends `[AUTH_*]` reasons for present index entries and can only
 * turn a would-be PASS into INVALID. It never reads the narrative.
 */
export async function evaluateHandoffGateChecked(
  run: string,
  tasks: HandoffTaskRef[],
  opts: HandoffAuthCheckOptions & { mode: HandoffMode; strict: boolean; victoryAudit: boolean },
): Promise<HandoffGate> {
  const gate = evaluateHandoffGate(run, tasks, opts)
  if (gate.skipped) return gate
  let index: HandoffIndex
  try {
    index = readIndex(run)
  } catch {
    return gate
  }
  if (index.entries.length === 0) return gate

  const checks = new Map<string, HandoffEntryAuthCheck>()
  const reasons = [...gate.reasons]
  let authInvalid = false
  for (const entry of index.entries) {
    const key = `${entry.taskId}\u0000${entry.agent}`
    const check = await checkHandoffEntryAuth(run, entry, opts)
    checks.set(key, check)
    if (check.status === "invalid") {
      authInvalid = true
      const failure = check.failure ?? { code: "AUTH_INVALID", message: "handoff _auth failed verification" }
      reasons.push(`handoff ${entry.path}: [${failure.code}] ${failure.message}`)
    }
  }

  const entries = gate.entries.map((entry) => {
    const check = checks.get(`${entry.taskId}\u0000${entry.agent}`)
    return {
      ...entry,
      auth: check?.status ?? "unsigned",
      ...(check?.keyId ? { keyId: check.keyId } : {}),
    }
  })
  const auth: HandoffGateEntryEvidence["auth"] = authInvalid
    ? "invalid"
    : entries.some((e) => e.auth === "signed")
      ? "signed"
      : "unsigned"

  if (reasons.length === gate.reasons.length) {
    return { ...gate, entries, auth }
  }
  const status: HandoffGate["status"] = gate.status === "STALE" ? "STALE" : "INVALID"
  return { ...gate, ok: false, status, reasons, entries, auth }
}

/**
 * Build the required (taskId, agent) matrix from the plan's tasks and the run's
 * modes. The task's own assigned agent writes its worker handoff; verifier,
 * falsifier and security-auditor handoffs are added by mode, not by request.
 */
export function requiredHandoffMatrix(
  tasks: HandoffTaskRef[],
  opts: { strict: boolean; victoryAudit: boolean },
): { requirements: HandoffGateRequirement[]; errors: string[] } {
  const requirements: HandoffGateRequirement[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const push = (taskId: string, agents: string[], label: string) => {
    const key = `${taskId}\u0000${agents.join("|")}`
    if (seen.has(key)) return
    seen.add(key)
    requirements.push({ taskId, agents, label })
  }
  for (const task of tasks) {
    if (!isSafeTaskId(task.id)) {
      errors.push(`handoffs: invalid task id "${clean(task.id, 32)}" cannot have a handoff`)
      continue
    }
    const assigned = typeof task.agent === "string" && task.agent.trim() ? task.agent.trim() : "team/worker"
    if (!isTaskScopedRole(assigned)) {
      errors.push(`handoffs: task ${task.id} is assigned ${clean(assigned, 64)}, which cannot record a task handoff`)
    } else {
      push(task.id, [assigned], `task ${task.id} worker`)
    }
    push(task.id, ["team/verifier"], `task ${task.id} verifier`)
    if (opts.strict) {
      push(task.id, ["team/falsifier"], `task ${task.id} falsifier`)
      push(task.id, ["team/security-auditor"], `task ${task.id} security auditor`)
    }
  }
  // One run-level continuity narrative from the sentinel or orchestrator.
  push(RUN_LEVEL_HANDOFF_ID, ["team/sentinel", "team/orchestrator"], "run-level sentinel/orchestrator")
  if (opts.victoryAudit) {
    push(RUN_LEVEL_HANDOFF_ID, ["team/victory-auditor"], "run-level victory auditor")
  }
  return { requirements, errors }
}

function isAllowedHandoffPair(taskId: string, agent: string): boolean {
  if (taskId === RUN_LEVEL_HANDOFF_ID) {
    return isRunLevelRole(agent) || agent === "team/security-auditor"
  }
  return isTaskScopedRole(agent)
}

const HANDOFF_MARKDOWN_HEADER = /^# HANDOFF — ([^\s—]+) — (team\/[a-z][a-z0-9-]{0,31})$/
const MAX_HANDOFF_MARKDOWN_READ = 64 * 1024
const MAX_CITED_ARTIFACT_BYTES = 8 * 1024 * 1024

function readCiteHash(run: string, relPath: string): string | null {
  const res = readBoundedRunFile(run, join(run, relPath), MAX_CITED_ARTIFACT_BYTES)
  return res.status === "ok" ? sha256Hex(res.text) : null
}

/**
 * Recompute the continuity gate from disk. A changed cited report/wave/audit/
 * victory artifact makes the handoff stale; a duplicate, unknown or tampered
 * index entry fails it. Handoff prose is never inspected for PASS/FAIL.
 */
export function evaluateHandoffGate(
  run: string,
  tasks: HandoffTaskRef[],
  opts: { mode: HandoffMode; strict: boolean; victoryAudit: boolean },
): HandoffGate {
  if (opts.mode === "skip") {
    return {
      mode: "skip",
      skipped: true,
      ok: true,
      status: "SKIPPED",
      reasons: [],
      missing: [],
      required: [],
      entries: [],
    }
  }
  const matrix = requiredHandoffMatrix(tasks, { strict: opts.strict, victoryAudit: opts.victoryAudit })
  const reasons: string[] = [...matrix.errors]
  const missing: Array<{ taskId: string; agent: string }> = []
  const taskIds = new Set(tasks.filter((t) => isSafeTaskId(t.id)).map((t) => t.id))
  let index: HandoffIndex
  try {
    index = readIndex(run)
  } catch (err: any) {
    return {
      mode: "required",
      skipped: false,
      ok: false,
      status: "INVALID",
      reasons: [...reasons, clean(err?.message || "handoffs/index.json is unreadable", 300)],
      missing,
      required: matrix.requirements.flatMap((r) => r.agents.map((agent) => ({ taskId: r.taskId, agent }))),
      entries: [],
    }
  }

  // Group entries by their exact (taskId, agent) key. More than one entry for a
  // pair is a duplicate even when the pair is not required.
  const byPair = new Map<string, HandoffIndexEntry[]>()
  for (const entry of index.entries) {
    const key = `${entry.taskId}\u0000${entry.agent}`
    const list = byPair.get(key) ?? []
    list.push(entry)
    byPair.set(key, list)
  }
  for (const [key, list] of byPair) {
    if (list.length > 1) {
      const [taskId, agent] = key.split("\u0000")
      reasons.push(`handoff index has ${list.length} duplicate entries for ${agent} ${taskId}`)
    }
  }

  // Unknown / out-of-scope entries fail closed. Legitimate extras (for example
  // the run-level security auditor) are still validated below.
  for (const entry of index.entries) {
    if (!isAllowedHandoffPair(entry.taskId, entry.agent)) {
      reasons.push(
        `handoff index has an unsupported role ${clean(entry.agent, 64)} for ${clean(entry.taskId, 32)}`,
      )
    }
    if (entry.taskId !== RUN_LEVEL_HANDOFF_ID && !taskIds.has(entry.taskId)) {
      reasons.push(`handoff index names unknown task ${clean(entry.taskId, 32)}`)
    }
  }

  // Validate every indexed document: regular non-symlink, bytes match the index
  // hash, and the header agrees with the indexed task/agent.
  const documentOk = new Map<string, boolean>()
  for (const entry of index.entries) {
    const key = `${entry.taskId}\u0000${entry.agent}`
    const file = join(run, entry.path)
    const res = readBoundedRunFile(run, file, MAX_HANDOFF_MARKDOWN_READ)
    if (res.status === "absent") {
      reasons.push(`handoff file ${entry.path} is missing`)
      documentOk.set(key, false)
      continue
    }
    if (res.status === "error") {
      reasons.push(`handoff file ${entry.path} is not readable as a regular file (${clean(res.error, 160)})`)
      documentOk.set(key, false)
      continue
    }
    const actual = sha256Hex(res.text)
    if (actual !== entry.sha256) {
      reasons.push(`handoff ${entry.path} sha256 does not match handoffs/index.json`)
      documentOk.set(key, false)
      continue
    }
    if (Buffer.byteLength(res.text, "utf8") !== entry.bytes) {
      reasons.push(`handoff ${entry.path} byte length does not match handoffs/index.json`)
      documentOk.set(key, false)
      continue
    }
    const header = HANDOFF_MARKDOWN_HEADER.exec(res.text.split("\n", 1)[0] ?? "")
    if (!header) {
      reasons.push(`handoff ${entry.path} has no canonical HANDOFF header`)
      documentOk.set(key, false)
      continue
    }
    if (header[1] !== entry.taskId || header[2] !== entry.agent) {
      reasons.push(
        `handoff ${entry.path} header claims ${clean(header[1], 32)}/${clean(header[2], 64)}, not ${entry.taskId}/${entry.agent}`,
      )
      documentOk.set(key, false)
      continue
    }
    documentOk.set(key, true)
  }

  const required: RequiredHandoffPair[] = []
  let stale = false
  let invalid = false
  const evidence: HandoffGateEntryEvidence[] = []
  for (const req of matrix.requirements) {
    const candidates: HandoffIndexEntry[] = []
    for (const agent of req.agents) {
      required.push({ taskId: req.taskId, agent })
      const key = `${req.taskId}\u0000${agent}`
      const list = byPair.get(key) ?? []
      if (list.length > 0) candidates.push(...list)
    }
    const missingAgent = req.agents.join(" or ")
    if (candidates.length === 0) {
      missing.push({ taskId: req.taskId, agent: missingAgent })
      reasons.push(`handoff missing: ${req.taskId} ${missingAgent} (${req.label})`)
      continue
    }
    if (candidates.length > 1) {
      // Already named by the duplicate check when the same pair repeats; an
      // alternative role (sentinel AND orchestrator) is a duplicate too.
      reasons.push(`handoff duplicate: ${req.label} has ${candidates.length} entries (expected exactly one)`)
      invalid = true
      continue
    }
    const entry = candidates[0]
    const key = `${entry.taskId}\u0000${entry.agent}`
    if (documentOk.get(key) !== true) {
      missing.push({ taskId: req.taskId, agent: entry.agent })
      continue
    }
    const citePath = handoffCiteRelativePath(entry.agent, entry.taskId === RUN_LEVEL_HANDOFF_ID ? undefined : entry.taskId)
    if (citePath && !entry.cites.some((c) => c.path === citePath)) {
      invalid = true
      reasons.push(`handoff ${entry.path} does not cite ${citePath}`)
    }
    // Every recorded citation must still match the current artifact.
    for (const cite of entry.cites) {
      const current = readCiteHash(run, cite.path)
      if (current === null) {
        stale = true
        reasons.push(`handoff ${entry.path} cites ${cite.path}, which is missing or unreadable`)
      } else if (current !== cite.sha256) {
        stale = true
        reasons.push(`handoff ${entry.path} is stale: ${cite.path} changed since the handoff was recorded`)
      }
    }
    evidence.push({
      taskId: entry.taskId,
      agent: entry.agent,
      path: entry.path,
      sha256: entry.sha256,
      agentSessionId: entry.agentSessionId,
      cites: entry.cites,
    })
  }

  // An entry for a required task but an unexpected extra role is not fatal by
  // itself (e.g. a standard-mode security-auditor handoff); an entry for an
  // unknown task/role, a duplicate, or a bad document is.
  if (reasons.length > 0 && !invalid && !stale) {
    invalid = reasons.some(
      (r) =>
        /duplicate|unsupported role|unknown task|sha256|byte length|header|not readable|missing file/.test(r),
    )
  }
  const status: HandoffGate["status"] =
    reasons.length === 0 ? "PASS" : stale ? "STALE" : invalid ? "INVALID" : "MISSING"
  return {
    mode: "required",
    skipped: false,
    ok: reasons.length === 0,
    status,
    reasons,
    missing,
    required,
    entries: evidence,
  }
}
