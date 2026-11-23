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
import { clean, isSafeTaskId, readBoundedRunFile, writeSafeRunFile } from "./tournament.ts"
import { withFileLock } from "./locks.ts"

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
}

/**
 * Write one handoff markdown file and refresh the bounded index. Throws a
 * `refused:` error on any validation/containment failure; nothing is written in
 * that case (the markdown is validated before its first write).
 */
export function writeHandoffSync(run: string, opts: WriteHandoffOptions): {
  path: string
  relativePath: string
  sha256: string
  bytes: number
  entry: HandoffIndexEntry
  index: HandoffIndex
} {
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

  const entry: HandoffIndexEntry = {
    taskId: scope.taskKey,
    agent: opts.agent,
    agentSessionId,
    round,
    path: relativePath,
    sha256,
    bytes,
    generatedAt,
    cites,
  }
  const index = updateIndex(run, entry)
  return { path: file, relativePath, sha256, bytes, entry, index }
}

/** Async wrapper; index updates share the process-wide file lock. */
export async function writeHandoff(run: string, opts: WriteHandoffOptions): Promise<{
  path: string
  relativePath: string
  sha256: string
  bytes: number
  entry: HandoffIndexEntry
  index: HandoffIndex
}> {
  return withFileLock(join(run, handoffIndexRelativePath()), () => writeHandoffSync(run, opts))
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
