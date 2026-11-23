// opencode-teamwork — Teamwork engine tools + hooks (V2 plugin API)
//
// Turns the mechanics that the prompts used to describe in prose (run dir,
// plan, state, cost, pitfalls, resume) into real tools, and uses hooks to
// enforce the read-only guarantee and to inject run context automatically.
//
// Security notes:
//   * Every run path is built from a VALIDATED session id and asserted to stay
//     inside the run root (no path traversal / arbitrary file write).
//   * Untrusted run state is sanitised before it is injected into any system
//     prompt (no stored prompt injection).
//   * The read-only policy is an explicit per-agent deny list (fail-closed):
//     an unknown agent is not silently allowed to escalate via subagent/webfetch.
//
// No OpenCode imports: tool definitions are plain objects, so the loader never
// has to resolve node_modules for this package.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  constants as fsConstants,
  statSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  MAX_FINDINGS,
  MAX_SEGMENT_CHARS,
  MAX_TEXT_MAP_CHARS,
  SEGMENT_ID,
  classifyRoute as classifyDocumentRoute,
  ingestDocument,
  isSafeSegmentId,
  resolveAndReadDocument,
  segmentDocument,
  splitInstructionAndInlineDoc,
  validateTreeBounds,
} from "./document-review.ts"
import {
  classifyRoute as classifyLemmaRoute,
  evaluateLemmaFinalEvidence,
  formatMissingToolchainRefusal,
  initLemmaArtifacts,
  mutateLemmaNode,
  probeLemmaToolchain,
  recordFormalizationDraft,
  recordFormalizationFinalReview,
  recordFormalizationPreReview,
  resolveManifestAxiomAllowlist,
  sameAxiomSet,
  validateLemmaBounds,
  validateLemmaPolicy,
  verifyLemmaNodeAttempt,
  type LemmaBounds,
  type LemmaPolicy,
  type LemmaProbeResult,
} from "./lemma.ts"
import {
  TOURNAMENT_ACTIVE_PHASES,
  TOURNAMENT_PHASES,
  MAX_MANIFEST_BYTES,
  MAX_REPORT_BYTES,
  auditTournament,
  classifyRoute as classifyTournamentRoute,
  ensureSafeRunSubpath as ensureSafeTournamentSubpath,
  estimateTournamentBudget,
  falsifyCandidate,
  finalizeTournamentPartial,
  hasExplicitMassiveProofOptIn,
  initTournamentManifest,
  manifestPathOf,
  mergeCandidates,
  proposeCandidate,
  readBoundedRunFile,
  readBoundedRunJson,
  readTournamentManifest,
  readTournamentVerdict,
  reportPathOf,
  resolveAndValidateTournamentConfig,
  scoreCandidates,
  tournamentConfigsEqual,
  tournamentDir,
  validateTournamentConfig,
  writeSafeRunFile,
} from "./tournament.ts"
import type { BudgetEstimate, TournamentConfig, TournamentManifest } from "./tournament.ts"
import {
  DEFAULT_VERIFICATION_MODE,
  evaluateStrictGateChecked,
  normalizeVerificationMode,
  normalizeWaveKind,
  recordVerificationWave,
  renderGateStatus,
  resolveVerificationMode,
  WAVE_AGENTS,
} from "./strict.ts"
import type { VerificationMode } from "./strict.ts"
import {
  VICTORY_AUDITOR_AGENT,
  callerRequirementsFile,
  currentRequirementsHash,
  deriveRequirementsFromRequest,
  describeVictoryGate,
  evaluateVictoryGateChecked,
  normalizeVictoryAuditMode,
  originalRequestHash,
  persistRequirementsBaseline,
  readRequirementsBaseline,
  recordVictoryAudit,
  resolveVictoryAuditMode,
  validateRequirementsBaseline,
} from "./victory.ts"
import {
  canonicalJson,
  createAuthContext,
  sha256Hex,
  type AuthContext,
  type AuthEnvelope,
  type AuthFailure,
} from "./auth.ts"
import type { RequirementsFile, VictoryAuditMode } from "./victory.ts"
import { readBriefingExcerpt, refreshRunBriefing } from "./briefing.ts"
import { fdWithin, readWithinBounded, supportsFdContainment } from "./safe-fs.mjs"

// ---------------------------------------------------------------------------
// OpenCode native cost tracking
//
// Total consumption is computed exactly from OpenCode across the entire
// session tree: the root Sentinel session + all spawned child/subagent
// sessions (workers, verifiers, scouts, challengers, etc.).
//
// We discover OpenCode session trees via three redundant channels:
//   1. OpenCode SQLite database (`session_v2` recursive query) via `node:sqlite`
//   2. OpenCode SQLite database via `sqlite3` CLI
//   3. OpenCode background service API (`GET /api/session?parentID=...`)
//   4. Native client fallback (`ctx.session.get({ sessionID })`)
//
// We snapshot cumulative cost per session and report deltas, ensuring a run's
// spend is measured honestly — never self-reported or lost if a worker halts.
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface SessionSnapshot {
  /** Last observed cumulative cost for this OpenCode session, in USD. */
  lastCost: number
  lastTokens: TokenUsage
  agent?: string
  timestamp: string
}

interface SnapshotsFile {
  sessionId: string
  rootSessionIds?: string[]
  bySession: Record<string, SessionSnapshot>
}

interface SessionUsageItem {
  id: string
  parentId?: string
  agent?: string
  cost: number
  tokens: TokenUsage
}

interface TreeUsageResult {
  sessions: SessionUsageItem[]
  source: string
}

function normalizeTokens(t: any): TokenUsage {
  return {
    input: Number(t?.input) || 0,
    output: Number(t?.output) || 0,
    reasoning: Number(t?.reasoning) || 0,
    cache: { read: Number(t?.cache?.read) || 0, write: Number(t?.cache?.write) || 0 },
  }
}

function readSnapshots(run: string, file: string): SnapshotsFile | undefined {
  const parsed = readJson<SnapshotsFile | undefined>(run, file, undefined)
  if (!parsed || typeof parsed !== "object" || typeof parsed.bySession !== "object") return undefined
  if (!Array.isArray(parsed.rootSessionIds)) parsed.rootSessionIds = []
  return parsed
}

/**
 * Write `content` to `file` atomically. The temp file is created with a fresh
 * random suffix and `O_CREAT|O_EXCL` (`wx`), so a symlink or hard link planted
 * at the old predictable `<file>.tmp` path cannot redirect the write; the
 * `renameSync` replaces the destination directory entry itself.
 */
function writeTextAtomicSafe(file: string, content: string) {
  refuseSymlink(file)
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    try {
      writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" })
    } catch (err: any) {
      if (err?.code === "EEXIST") continue
      throw err
    }
    renameSync(tmp, file)
    return
  }
  throw new Error(`refused: could not create a unique temp file for "${basename(file)}"`)
}

function writeSnapshots(file: string, value: SnapshotsFile) {
  writeTextAtomicSafe(file, JSON.stringify(value, null, 2) + "\n")
}

function getOpencodeDbPath(): string | undefined {
  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) {
    candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"))
  }
  const home = homedir()
  candidates.push(join(home, ".local", "share", "opencode", "opencode.db"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "opencode.db"))
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "opencode", "opencode.db"))
  }
  candidates.push(join(home, "AppData", "Local", "opencode", "opencode.db"))
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return undefined
}

function getOpencodeService(): { url: string; auth: string } | undefined {
  const candidates: string[] = []
  if (process.env.XDG_STATE_HOME) {
    candidates.push(join(process.env.XDG_STATE_HOME, "opencode", "service.json"))
  }
  const home = homedir()
  candidates.push(join(home, ".local", "state", "opencode", "service.json"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "service.json"))
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "opencode", "service.json"))
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"))
        if (raw?.url) {
          const auth = "Basic " + Buffer.from(`opencode:${raw.password ?? ""}`).toString("base64")
          return { url: raw.url, auth }
        }
      }
    } catch {}
  }
  return undefined
}

async function fetchServiceTree(url: string, auth: string, rootIds: string[]): Promise<SessionUsageItem[] | undefined> {
  const sessions: SessionUsageItem[] = []
  const seen = new Set<string>()
  const queue: string[] = rootIds.filter(validSessionId)

  for (const rootId of rootIds) {
    if (!validSessionId(rootId) || seen.has(rootId)) continue
    seen.add(rootId)
    try {
      const res = await fetch(`${url}/api/session/${encodeURIComponent(rootId)}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const json: any = await res.json()
        const s = json?.data
        if (s && typeof s.cost === "number") {
          sessions.push({
            id: s.id,
            parentId: s.parentID,
            agent: s.agent,
            cost: s.cost,
            tokens: normalizeTokens(s.tokens),
          })
        }
      }
    } catch {}
  }

  while (queue.length > 0) {
    const parentId = queue.shift()!
    if (!validSessionId(parentId)) continue
    try {
      const res = await fetch(`${url}/api/session?parentID=${encodeURIComponent(parentId)}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const json: any = await res.json()
        const children = Array.isArray(json?.data) ? json.data : []
        for (const c of children) {
          const childId = c?.id
          if (!validSessionId(childId) || seen.has(childId)) continue
          seen.add(childId)
          queue.push(childId)
          sessions.push({
            id: childId,
            parentId: c.parentID,
            agent: c.agent,
            cost: Number(c.cost) || 0,
            tokens: normalizeTokens(c.tokens),
          })
        }
      }
    } catch {}
  }

  return sessions.length ? sessions : undefined
}

/**
 * Read the real cumulative cost + tokens for an OpenCode session tree (root +
 * all child/subagent sessions).
 */
async function readSessionTreeUsage(
  ctx: any,
  rootIds: string[],
  fallbackSessionId?: string,
): Promise<TreeUsageResult | undefined> {
  // Ids come from snapshots.json / costs.json (untrusted run state): only ones
  // matching the SESSION_ID allowlist may reach a database query or request URL.
  const safeIds = safeSessionIds([...rootIds, ...(fallbackSessionId ? [fallbackSessionId] : [])])
  if (!safeIds.length) return undefined

  // 1. Try local SQLite database (node:sqlite)
  const dbPath = getOpencodeDbPath()
  if (dbPath) {
    try {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const placeholders = safeIds.map(() => "?").join(", ")
      const stmt = db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          FROM session_v2 WHERE id IN (${placeholders})
          UNION ALL
          SELECT s.id, s.parent_id, s.agent, s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write
          FROM session_v2 s JOIN tree t ON s.parent_id = t.id
        )
        SELECT id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM tree;
      `)
      const rows = stmt.all(...safeIds)
      db.close()
      if (rows && rows.length > 0) {
        return {
          sessions: rows.map((r: any) => ({
            id: String(r.id),
            parentId: r.parent_id ? String(r.parent_id) : undefined,
            agent: r.agent ? String(r.agent) : undefined,
            cost: Number(r.cost) || 0,
            tokens: {
              input: Number(r.tokens_input) || 0,
              output: Number(r.tokens_output) || 0,
              reasoning: Number(r.tokens_reasoning) || 0,
              cache: { read: Number(r.tokens_cache_read) || 0, write: Number(r.tokens_cache_write) || 0 },
            },
          })),
          source: "opencode database (node:sqlite)",
        }
      }
    } catch {}

    // 2. Try sqlite3 CLI fallback
    try {
      const inClause = safeIds.map((id) => `'${id}'`).join(", ")
      const sql = `
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          FROM session_v2 WHERE id IN (${inClause})
          UNION ALL
          SELECT s.id, s.parent_id, s.agent, s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write
          FROM session_v2 s JOIN tree t ON s.parent_id = t.id
        )
        SELECT id, coalesce(parent_id, ''), coalesce(agent, ''), cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM tree;
      `
      const raw = execFileSync("sqlite3", [dbPath, "-separator", "\t", sql], { encoding: "utf8", timeout: 5000 })
      const lines = raw.trim().split("\n").filter(Boolean)
      if (lines.length > 0) {
        return {
          sessions: lines.map((line) => {
            const [id, parentId, agent, cost, inp, out, reas, cr, cw] = line.split("\t")
            return {
              id,
              parentId: parentId || undefined,
              agent: agent || undefined,
              cost: Number(cost) || 0,
              tokens: {
                input: Number(inp) || 0,
                output: Number(out) || 0,
                reasoning: Number(reas) || 0,
                cache: { read: Number(cr) || 0, write: Number(cw) || 0 },
              },
            }
          }),
          source: "opencode database (sqlite3 CLI)",
        }
      }
    } catch {}
  }

  // 3. Try OpenCode background service API
  const svc = getOpencodeService()
  if (svc) {
    try {
      const items = await fetchServiceTree(svc.url, svc.auth, safeIds)
      if (items && items.length > 0) {
        return {
          sessions: items,
          source: "opencode service API",
        }
      }
    } catch {}
  }

  // 4. Fallback to client ctx.session.get
  const fallbackSessions: SessionUsageItem[] = []
  for (const id of safeIds) {
    const u = await readSessionUsage(ctx, id)
    if (u) fallbackSessions.push({ id, cost: u.cost, tokens: u.tokens })
  }
  if (fallbackSessions.length > 0) {
    return {
      sessions: fallbackSessions,
      source: `opencode session ${safeIds[0]}`,
    }
  }

  return undefined
}

/**
 * Read cumulative cost + tokens for a single session from ctx.session.get.
 * Used for baselines or as a single-session fallback.
 */
async function readSessionUsage(
  ctx: any,
  sessionID: string | undefined,
): Promise<{ cost: number; tokens: TokenUsage } | undefined> {
  if (!sessionID || typeof ctx?.session?.get !== "function") return undefined
  try {
    const info = await ctx.session.get({ sessionID })
    if (!info || typeof info.cost !== "number") return undefined
    return { cost: info.cost, tokens: normalizeTokens(info.tokens) }
  } catch {
    return undefined
  }
}

/** Reject if `p` does not settle within `ms`; the timer is always cleared. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

/**
 * Best-effort actor lookup for the calling session. Fail-open: never throws and
 * never blocks longer than 2s. Order: the client's session.get agent, then the
 * agent recorded for that session in snapshots.json (same source as
 * bySession[*].agent). Returns the actor with its provenance (`session` for both
 * sources), or undefined when neither is available.
 */
async function deriveCallerAgent(
  ctx: any,
  run: string,
  sessionID: string | undefined,
): Promise<{ agent: string; source: "session" } | undefined> {
  if (!sessionID) return undefined
  try {
    if (typeof ctx?.session?.get === "function") {
      const info: any = await withTimeout(Promise.resolve(ctx.session.get({ sessionID })), 2000)
      const a = typeof info?.agent === "string" ? clean(info.agent, 64).trim() : ""
      if (a) return { agent: a, source: "session" }
    }
  } catch {}
  try {
    const a = readSnapshots(run, join(run, "snapshots.json"))?.bySession?.[sessionID]?.agent
    if (typeof a === "string") {
      const c = clean(a, 64).trim()
      if (c) return { agent: c, source: "session" }
    }
  } catch {}
  return undefined
}

type TokenTotals = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

/** Non-negative integer, 0 for anything non-finite. */
function tokenInt(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Add the token delta (cur - prev.lastTokens) of one session to
 * costs.byTaskTokens[bucket]. Mirrors the cost-delta baseline: no prior snapshot
 * means the full current total is the delta. A prior snapshot without
 * lastTokens cannot yield an honest delta, so it is skipped. An all-zero token
 * delta returns early WITHOUT touching either map, so byTaskTokens and byTask
 * key sets can diverge (a bucket can have spend and no token entry).
 * Both maps are null-prototype (see nullMap) so no bucket name collides.
 */
function accumulateTokenDelta(costs: any, bucket: string, cur: TokenTotals | undefined, prev: any) {
  if (!cur || typeof cur !== "object") return
  if (prev && !prev.lastTokens) return
  const base: any = prev ? prev.lastTokens : undefined
  const d = {
    input: tokenInt(cur.input) - tokenInt(base?.input),
    output: tokenInt(cur.output) - tokenInt(base?.output),
    reasoning: tokenInt(cur.reasoning) - tokenInt(base?.reasoning),
    cache: {
      read: tokenInt(cur.cache?.read) - tokenInt(base?.cache?.read),
      write: tokenInt(cur.cache?.write) - tokenInt(base?.cache?.write),
    },
  }
  const parts = [d.input, d.output, d.reasoning, d.cache.read, d.cache.write].map((x) => Math.max(0, x))
  if (parts.every((x) => x === 0)) return
  costs.byTaskTokens = nullMap(costs.byTaskTokens)
  costs.byTask = nullMap(costs.byTask)
  if (costs.byTask[bucket] === undefined) costs.byTask[bucket] = 0
  const b = costs.byTaskTokens[bucket]
  const cur2 = b && typeof b === "object" ? b : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  costs.byTaskTokens[bucket] = {
    input: tokenInt(cur2.input) + parts[0],
    output: tokenInt(cur2.output) + parts[1],
    reasoning: tokenInt(cur2.reasoning) + parts[2],
    cache: {
      read: tokenInt(cur2.cache?.read) + parts[3],
      write: tokenInt(cur2.cache?.write) + parts[4],
    },
  }
}

/** True when the opencode_console MCP server is connected for this location. */
async function isConsoleMcpConnected(ctx: any): Promise<boolean> {
  try {
    if (typeof ctx?.mcp?.list !== "function") return false
    const out = await ctx.mcp.list()
    const servers = Array.isArray(out) ? out : (out?.data ?? [])
    return servers.some((s: any) => /console/i.test(String(s?.name ?? "")) && s?.status?.status === "connected")
  } catch {
    return false
  }
}

/** Provider id of a Model.Ref, unwrapping the `{ location, data }` client envelope. */
function providerOf(value: any): string | undefined {
  const v = value && typeof value === "object" && "data" in value ? value.data : value
  return v?.providerID ?? v?.provider ?? undefined
}

/**
 * True when the run is on managed `opencode/` models — checked against the
 * active session's model, the location default model, and every `team/*`
 * agent's configured model. Any `opencode` provider ⇒ console credits apply.
 */
async function usesOpencodeModel(ctx: any, sessionID?: string): Promise<boolean> {
  // 1. The active session's model.
  try {
    if (sessionID && typeof ctx?.session?.get === "function") {
      const s: any = await ctx.session.get({ sessionID })
      if (providerOf(s?.model ?? s?.data?.model) === "opencode") return true
    }
  } catch {}
  // 2. The location default model.
  try {
    if (typeof ctx?.model?.default === "function") {
      if (providerOf(await ctx.model.default()) === "opencode") return true
    }
  } catch {}
  // 3. Any team/* agent configured with an opencode/ model.
  try {
    if (typeof ctx?.agent?.list === "function") {
      const out: any = await ctx.agent.list()
      const agents = Array.isArray(out) ? out : (out?.data ?? [])
      return agents.some((a: any) => /^team\//.test(String(a?.id ?? a?.name ?? "")) && providerOf(a?.model) === "opencode")
    }
  } catch {}
  return false
}

const RUN_ROOT = ".opencode/teamwork"

// session ids are generated by us; anything else must match this allowlist.
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

/**
 * The only session-id allowlist: the same `SESSION_ID` used for run directory
 * names. Every id that can reach a request URL is checked against it.
 */
function validSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id)
}

/** Deduplicated copy of `ids` containing only conforming session identifiers. */
function safeSessionIds(ids: unknown[]): string[] {
  const out: string[] = []
  for (const id of ids) if (validSessionId(id) && !out.includes(id)) out.push(id)
  return out
}

/**
 * A task id is used as a single filesystem path segment (worktree dir, verifier
 * dir, report/conflict file names) and inside git branch names. Only allow a
 * conservative single-segment token. `clean()` is NOT sufficient: it keeps `/`
 * and `..`, which let `../../x` escape the worktrees base (SEC-1).
 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function isSafeTaskId(id: string): boolean {
  return TASK_ID.test(id) && id !== "." && id !== ".."
}

/**
 * Canonical terminal status is `verified_pass`; `pass` is the legacy alias.
 * Every completion count must use this predicate so a finished run is never
 * reported as having zero passed tasks.
 */
const isPassStatus = (s: any) => s === "pass" || s === "verified_pass"

// Canonical topologies (docs/ARTIFACTS.md) and the legacy aliases the plan tool
// still accepts. Aliases are normalised before they are persisted.
const TOPOLOGIES = ["small-focused", "iterative-coding", "distributed-coding", "proof", "massive-proof", "document-review"]
const TOPOLOGY_ALIASES: Record<string, string> = {
  "large-swarm": "distributed-coding",
  "doc-review": "document-review",
  "long-proof": "proof",
  "massive-proof-swarm": "massive-proof",
}

/** Normalise a topology (canonical or legacy alias); undefined when unknown. */
function normalizeTopology(value: unknown): string | undefined {
  const v = clean(value, 64)
  return TOPOLOGY_ALIASES[v] ?? (TOPOLOGIES.includes(v) ? v : undefined)
}

// Integrity modes (docs/ARTIFACTS.md). Chosen when the run is routed, recorded
// once in ORIGINAL_REQUEST.md, and read back from that artifact by the audit and
// final-verification gates. `development` is the default for legacy runs.
const INTEGRITY_MODES = ["development", "demo", "benchmark"] as const
type IntegrityMode = (typeof INTEGRITY_MODES)[number]
const DEFAULT_INTEGRITY_MODE: IntegrityMode = "development"
const REQUEST_MAX = 20000

/**
 * Canonical integrity rules and the lowest mode that forbids each one
 * (docs/ARTIFACTS.md). A higher mode inherits every prohibition below it.
 * These are rules the auditor *reports* as violated; the tool cannot detect
 * dishonesty, it only makes a reported violation binding.
 */
const INTEGRITY_RULES = {
  fabricated_output: { forbiddenFrom: "development" },
  core_logic_copied: { forbiddenFrom: "demo" },
  delegated_core_work: { forbiddenFrom: "demo" },
  test_source_read: { forbiddenFrom: "demo" },
  external_dependency_used: { forbiddenFrom: "benchmark" },
} as const satisfies Record<string, { forbiddenFrom: IntegrityMode }>
type IntegrityRule = keyof typeof INTEGRITY_RULES
const INTEGRITY_RULE_IDS = Object.keys(INTEGRITY_RULES) as IntegrityRule[]
const INTEGRITY_FINDINGS_MAX = 50

/** Normalise an integrity mode; undefined when it is not one of the three. */
function normalizeIntegrityMode(value: unknown): IntegrityMode | undefined {
  const v = String(value ?? "").trim()
  return (INTEGRITY_MODES as readonly string[]).includes(v) ? (v as IntegrityMode) : undefined
}

/** Rank a mode by strictness: development < demo < benchmark. */
function integrityModeRank(mode: IntegrityMode): number {
  return INTEGRITY_MODES.indexOf(mode)
}

/** True when `rule` is forbidden at `mode` (at or above its threshold). */
function isIntegrityRuleForbidden(rule: IntegrityRule, mode: IntegrityMode): boolean {
  return integrityModeRank(mode) >= integrityModeRank(INTEGRITY_RULES[rule].forbiddenFrom)
}

/**
 * Read the integrity mode from `<run>/ORIGINAL_REQUEST.md`. That artifact is the
 * only source of truth at audit/final-verification time; legacy runs have none,
 * so they default to `development`.
 */
const MAX_RUN_FILE_BYTES = 512 * 1024



function readIntegrityMode(run: string): { mode: IntegrityMode; source: "artifact" | "default" } {
  const file = join(run, "ORIGINAL_REQUEST.md")
  try {
    const text = readRunText(run, file)
    if (text !== undefined) {
      // Only the metadata block counts: a "- Integrity mode:" line inside the
      // verbatim request body must never override the header.
      const splitAt = text.indexOf("\n## Request")
      const header = splitAt === -1 ? text : text.slice(0, splitAt)
      const m = header.match(/^- Integrity mode:[ \t]*(\S+)[ \t]*$/m)
      const mode = m && normalizeIntegrityMode(m[1])
      if (mode) return { mode, source: "artifact" }
    }
  } catch {}
  return { mode: DEFAULT_INTEGRITY_MODE, source: "default" }
}

// ---------------------------------------------------------------------------
// Input preflight
//
// A routed request often names files or URLs the work depends on. Before a run
// is created (or on demand for an existing run) the engine inventories those
// inputs and reports whether they exist / answer. The block list is deliberately
// narrow: explicit `inputs`, URLs, and tokens starting with `/`, `~/` or
// `file://`; other path-like tokens are advisory and never block.
// ---------------------------------------------------------------------------
const PREFLIGHT_MAX = 100
// The exact URL token grammar (docs/ARTIFACTS.md): no whitespace, no closing
// punctuation, no quote characters.
const PREFLIGHT_URL_RE = /https?:\/\/[^\s)>\]}"']+/g
const PREFLIGHT_URL_TIMEOUT_MS = 3000

type PreflightKind = "path" | "url"
type PreflightItemStatus = "READY" | "MISSING" | "UNCHECKED" | "OUTAGE"

interface PreflightItem {
  /** Token exactly as named by the caller/request (or the local path it maps to). */
  value: string
  kind: PreflightKind
  /** Explicit inputs, URLs and absolute/`~`/`file:` paths block; relative paths do not. */
  blocking: boolean
  /** A path-like relative token: reported, never blocking. */
  advisory: boolean
  status: PreflightItemStatus
  /** `file`/`dir` for paths; an HTTP status or error/timeout for URLs. */
  detail?: string
}

/** Strip surrounding prose punctuation from a whitespace token before checking it. */
function trimInputToken(token: string): string {
  return token.replace(/^[([`"'<]+/, "").replace(/[)\]`"'>,.;:!?]+$/, "")
}

function isUrlToken(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/**
 * Build the deduplicated input inventory from the explicit `inputs` (highest
 * trust) and the routed `request`. First-seen order wins; capped at 100 items.
 */
function extractInventory(request: string | undefined, inputs: string[] | undefined): PreflightItem[] {
  const seen = new Set<string>()
  const items: PreflightItem[] = []
  const add = (rawValue: string, kind: PreflightKind, blocking: boolean, advisory = false) => {
    const value = clean(rawValue, 500).trim()
    if (!value || seen.has(value) || items.length >= PREFLIGHT_MAX) return
    seen.add(value)
    items.push({ value, kind, blocking, advisory, status: kind === "url" ? "UNCHECKED" : "MISSING" })
  }
  // Explicit inputs are taken whole and always block, including relative paths.
  for (const raw of inputs ?? []) {
    if (raw) add(raw, isUrlToken(clean(raw, 500).trim()) ? "url" : "path", true)
  }
  if (typeof request === "string" && request) {
    for (const match of request.matchAll(PREFLIGHT_URL_RE)) add(match[0], "url", true)
    for (const rawToken of request.split(/\s+/)) {
      const token = trimInputToken(rawToken)
      if (!token || isUrlToken(token)) continue // URLs were captured above
      if (token.startsWith("/") || token.startsWith("~/") || token.startsWith("file://")) {
        add(token, "path", true)
      } else if (token.includes("/") && !/\s/.test(token)) {
        add(token, "path", false, true)
      }
    }
  }
  return items
}

/** Map a blocking path token (`~`, `~/`, `file:`) onto a local filesystem path. */
function localInputPath(value: string): string {
  let p = value
  if (p.startsWith("file://")) {
    p = p.slice("file://".length)
    try {
      p = decodeURIComponent(p)
    } catch {}
  }
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function checkInputPath(value: string): { status: PreflightItemStatus; detail?: string } {
  const path = localInputPath(value)
  try {
    if (!existsSync(path)) return { status: "MISSING" }
    const st = lstatSync(path)
    return { status: "READY", detail: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other" }
  } catch {
    return { status: "MISSING" }
  }
}

async function checkInputUrl(value: string, checkUrls: boolean): Promise<{ status: PreflightItemStatus; detail?: string }> {
  if (!checkUrls) return { status: "UNCHECKED", detail: "checkUrls: false" }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_URL_TIMEOUT_MS)
  try {
    // HEAD only: no body is read, and redirects are reported (not followed).
    const res = await fetch(value, { method: "HEAD", signal: controller.signal, redirect: "manual" })
    return {
      status: res.status >= 200 && res.status < 400 ? "READY" : "OUTAGE",
      detail: `HTTP ${res.status}`,
    }
  } catch (err: any) {
    const why = err?.name === "AbortError" ? "timeout" : err?.message || "request failed"
    return { status: "OUTAGE", detail: clean(why, 120) }
  } finally {
    clearTimeout(timer)
  }
}

/** Run every check. Never throws; each item lands on READY/MISSING/UNCHECKED/OUTAGE. */
async function checkInventory(items: PreflightItem[], checkUrls: boolean): Promise<PreflightItem[]> {
  await Promise.all(
    items.map(async (item) => {
      const result = item.kind === "url" ? await checkInputUrl(item.value, checkUrls) : checkInputPath(item.value)
      item.status = result.status
      if (result.detail) item.detail = result.detail
    }),
  )
  return items
}

function summarizePreflight(items: PreflightItem[]) {
  const missing = items.filter((i) => i.status === "MISSING")
  const outage = items.filter((i) => i.status === "OUTAGE")
  const blockingMissing = missing.filter((i) => i.blocking)
  const advisoryMissing = missing.filter((i) => i.advisory)
  // Advisory misses never change the overall status.
  const status: "READY" | "MISSING" | "OUTAGE" = outage.length
    ? "OUTAGE"
    : blockingMissing.length
      ? "MISSING"
      : "READY"
  return {
    status,
    total: items.length,
    blocking: items.filter((i) => i.blocking).length,
    missing: missing.length,
    blockingMissing: blockingMissing.length,
    advisoryMissing: advisoryMissing.length,
    outage: outage.length,
    unchecked: items.filter((i) => i.status === "UNCHECKED").length,
  }
}

/** Read the verbatim request body back out of `<run>/ORIGINAL_REQUEST.md`. */
function readRecordedRequest(run: string): string | undefined {
  try {
    const text = readRunText(run, join(run, "ORIGINAL_REQUEST.md"))
    if (text === undefined) return undefined
    const marker = "\n## Request\n"
    const at = text.indexOf(marker)
    if (at === -1) return undefined
    let body = text.slice(at + marker.length)
    if (body.startsWith("\n")) body = body.slice(1)
    return body
  } catch {
    return undefined
  }
}

/**
 * Write `<run>/ORIGINAL_REQUEST.md` exactly once, before any plan files.
 * `request` is preserved byte-for-byte (no reflow, no trimming). Returns an
 * actionable error string on refusal; the caller must then write nothing else.
 * The open with `wx` (O_CREAT|O_EXCL) makes "once" true even across two
 * concurrent planners and refuses an existing file/symlink: there is deliberately
 * no exists/read pre-check, which would be a redundant check-then-use race.
 */
function writeOriginalRequest(run: string, request: string, mode: IntegrityMode, sessionId: string): string | undefined {
  const file = join(run, "ORIGINAL_REQUEST.md")
  const body = `# Original Request\n\n- Integrity mode: ${mode}\n- Recorded: ${new Date().toISOString()}\n- Session: ${sessionId}\n\n## Request\n\n${request}`
  try {
    writeFileSync(file, body.endsWith("\n") ? body : body + "\n", { flag: "wx" })
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      return `refused: ${file} already records this run's request and is write-once.\nUse a new session (a new teamwork_plan sessionId) for a different request. Nothing was written.`
    }
    return `refused: could not record ${file} (${clean(err?.message, 120)}); nothing else was written`
  }
  return undefined
}

/**
 * Lexical containment check: `child` must be a strict descendant of `parent`.
 * Returns an error string when it is not, `undefined` when it is safe.
 * Must be evaluated BEFORE any mkdir / rmSync / git worktree add on `child`.
 */
function containmentError(parent: string, child: string): string | undefined {
  const rel = relative(resolve(parent), resolve(child))
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) {
    return "refused: target path escapes the worktrees base"
  }
  return undefined
}
const PHASES = new Set(["LOAD_SPEC", "WORKTREE_INIT", "DAG_BUILD", "DISPATCH", "SECURITY_AUDIT", "FINAL_VERIFICATION", "MERGE", "PRESENT_PARTIAL", "DONE"])

// Per-agent read-only policy, enforced in code. Keys are agent ids; values are
// the actions that agent may NOT perform. Anything not listed keeps its
// frontmatter permissions.
const READ_ONLY_ACTIONS: Record<string, Set<string>> = {
  // Real OpenCode permission actions only (see the V2 docs): edit covers the
  // write tool too, so "write"/"task" are intentionally not listed.
  "team/verifier": new Set(["edit", "webfetch", "subagent"]),
  "team/falsifier": new Set(["edit", "shell", "subagent"]),
  "team/scout": new Set(["edit", "subagent"]),
  "team/security-auditor": new Set(["edit", "webfetch", "subagent"]),
  "team/segment-reviewer": new Set(["edit", "shell", "subagent", "webfetch"]),
  "team/formalization-reviewer": new Set(["edit", "shell", "subagent", "webfetch"]),
  "team/referee": new Set(["edit", "shell", "subagent", "webfetch"]),
  // The victory auditor needs shell to run the project's tests independently;
  // it must not edit, delegate, or fetch anything.
  "team/victory-auditor": new Set(["edit", "subagent", "webfetch"]),
}

const pad = (n: number) => String(n).padStart(2, "0")

function newSessionId(): string {
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const hex = randomBytes(4).toString("hex")
  return `${ts}-${hex}`
}

/**
 * Strip control characters (C0, DEL, C1 incl. U+0085) / line separators and cap
 * length. Never inject raw file text. Matches lib/timeline.mjs CONTROL_CHARS.
 * NOT a prototype-safety mechanism: task ids need the TASK_ID allowlist and
 * object-keyed state needs nullMap().
 */
function clean(value: unknown, max = 64): string {
  return String(value ?? "")
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
    .slice(0, max)
}

/**
 * Multi-line variant of clean() for the cumulative feedback ledger: the same
 * control characters are replaced with spaces, except "\n", which is preserved
 * so one line can hold one round. The result never adds a line that the engine
 * did not join itself. Truncation is marked with "…" and stays within `max`.
 */
function cleanBlock(value: unknown, max = 2000): string {
  const s = String(value ?? "").replace(/[\r\t\x00-\x09\x0b-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s
}

/**
 * A `verify/final.json` counts as *stamped* only when `teamwork_final_verify`
 * wrote it: a non-empty `generatedBy` object with a non-empty `session`, a
 * parseable `generatedAt`, and an `evidence` object. Anything else was written
 * by hand (or by an engine older than the stamp), and cannot complete a run
 * without the explicit, recorded `allowUnstamped` bypass.
 */
function isStampedFinalReport(report: any): boolean {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false
  const by = report.generatedBy
  if (!by || typeof by !== "object" || Array.isArray(by)) return false
  if (typeof by.session !== "string" || by.session.trim() === "") return false
  if (typeof report.generatedAt !== "string" || Number.isNaN(Date.parse(report.generatedAt))) return false
  const ev = report.evidence
  return !!ev && typeof ev === "object" && !Array.isArray(ev)
}

/**
 * Null-prototype copy of an object-keyed map (byTask, byTaskTokens, state.tasks).
 * With no prototype, no inherited member name (constructor, __proto__, ...) can
 * collide with a task/bucket key. Own keys are copied with [[Set]] onto a
 * null-prototype target, so a "__proto__" key becomes an ordinary own property.
 * JSON.stringify serialises the result exactly like a plain object.
 */
function nullMap<T = any>(src?: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null)
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const k of Object.keys(src as object)) out[k] = (src as Record<string, T>)[k]
  }
  return out
}

function runsDir(root: string) {
  return join(root, RUN_ROOT)
}

/**
 * Caps for run-dir reads. These are local artifacts (state, plans, reports,
 * specs, free text); a larger file is treated as unreadable rather than loaded.
 */
const MAX_RUN_JSON_BYTES = 8 * 1024 * 1024
const MAX_RUN_TEXT_BYTES = 1 * 1024 * 1024

/**
 * Bounded, symlink- and FIFO-safe text read for a run artifact. Returns
 * `undefined` for absent/refused/unreadable files so callers fall back exactly
 * as before, but an outside file can never be pulled into run context. The path
 * is validated with the tournament run-containment check and then opened with
 * the shared `readWithinBounded` primitive (O_NOFOLLOW|O_NONBLOCK, fstat, cap,
 * and the post-open /proc/self/fd containment check on Linux). On macOS/Windows
 * the intermediate-component race remains the documented residual risk.
 * Known gap: authn of run content is out of scope — a writer already inside the
 * run dir can still influence context, never a verdict (verdicts are recomputed
 * from evidence).
 */
function readRunText(run: string, file: string, maxBytes = MAX_RUN_TEXT_BYTES): string | undefined {
  const check = ensureSafeTournamentSubpath(run, file)
  if (!check.ok) return undefined
  const res = readWithinBounded(check.runReal, check.path, maxBytes)
  return res.status === "ok" ? res.text : undefined
}

/**
 * True when a run artifact declares `constraints.network: "denied"`. JSON is
 * read structurally first; the text fallback covers the Markdown spec
 * (`prompt_draft.md`) where the same constraint is written as prose.
 */
function declaresNetworkDenied(text: string): boolean {
  try {
    const parsed = JSON.parse(text)
    const network = parsed?.constraints?.network
    if (typeof network === "string" && network.trim().toLowerCase() === "denied") return true
  } catch {
    // Not JSON: fall through to the text form.
  }
  return /network\s*["']?\s*:\s*["']?denied["']?/i.test(text)
}

/** Bounded, no-follow discovery of per-task spec.json files inside a run. */
function perTaskSpecFiles(base: string, dir = base, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length >= 200) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= 200) break
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      perTaskSpecFiles(base, full, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    const relParts = relative(base, full).split(/[\\/]/)
    const inSpecsDir = relParts.slice(0, -1).includes("specs")
    if (entry.name === "spec.json" || (inSpecsDir && entry.name.endsWith(".json"))) out.push(full)
  }
  return out
}

/**
 * Resolve the active run's network policy. `prompt_draft.md` is the run-wide
 * spec; every per-task `spec.json` is checked too, so a task-scoped denial is
 * never weaker than the run-wide one. A denied policy is enforced for all
 * `team/*` agents.
 */
function runNetworkDenied(run: string): boolean {
  const draft = readRunText(run, join(run, "prompt_draft.md"))
  if (draft && declaresNetworkDenied(draft)) return true
  for (const file of perTaskSpecFiles(run)) {
    const text = readRunText(run, file)
    if (text && declaresNetworkDenied(text)) return true
  }
  return false
}

function readPitfalls(run: string, taskId?: string): string[] {
  try {
    const content = readRunText(run, join(run, "pitfalls.md"))
    if (content === undefined) return []
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => clean(l.replace(/^-\s*/, ""), 200))
    if (!taskId) return lines
    const targetTag = `seen in ${clean(taskId, 64)}`
    return lines.filter((l) => !l.includes("seen in ") || l.includes(targetTag))
  } catch {
    return []
  }
}

/**
 * lstat that treats only ENOENT as absent. Unlike existsSync(), a dangling
 * symlink is still seen (and can be refused), because lstat does not follow it.
 */
function lstatIfExists(file: string) {
  try {
    return lstatSync(file)
  } catch (e: any) {
    if (e?.code === "ENOENT") return null
    throw e
  }
}

/**
 * Validate the run root itself: `.opencode` and `.opencode/teamwork` must not
 * be symlinks, and the resolved base must stay inside the project root. This
 * closes the "commit `.opencode/teamwork` as a symlink" escape that a run-dir
 * check alone misses.
 */
function runsBase(root: string): { base: string } | { error: string } {
  const parent = join(root, ".opencode")
  const base = join(parent, "teamwork")
  for (const p of [parent, base]) {
    let st
    try {
      st = lstatIfExists(p)
    } catch {
      return { error: "refused: run root is not readable" }
    }
    if (st?.isSymbolicLink()) return { error: "refused: run root is a symlink" }
  }
  let baseStat
  try {
    baseStat = lstatIfExists(base)
  } catch {
    return { error: "refused: run root is not readable" }
  }
  if (baseStat) {
    try {
      const rel = relative(realpathSync(root), realpathSync(base))
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: "refused: run root escapes the project" }
    } catch {
      return { error: "refused: run root is not resolvable" }
    }
  }
  return { base }
}

/**
 * Refuse to write through a symlinked file (would escape the run dir).
 * lstat the path directly: existsSync() follows links, so a *dangling* symlink
 * would otherwise be missed and the write would follow it.
 */
function refuseSymlink(file: string) {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`refused: refusing to write through symlink "${basename(file)}"`)
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e
  }
}

function listRuns(root: string) {
  const b = runsBase(root)
  if ("error" in b) return [] as { name: string; path: string; mtime: number }[]
  const dir = b.base
  if (!existsSync(dir)) return [] as { name: string; path: string; mtime: number }[]
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      let mtime = 0
      try {
        mtime = lstatSync(path).mtimeMs
      } catch {}
      return { name, path, mtime }
    })
    .filter((e) => {
      try {
        // lstat: a symlinked dir is NOT a run (would escape the root).
        return lstatSync(e.path).isDirectory()
      } catch {
        return false
      }
    })
    .filter((e) => SESSION_ID.test(e.name)) // only names we could have generated
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * Resolve a run directory. Validates the run root, the session id (allowlist),
 * and asserts — lexically and via realpath — that the result stays inside the
 * run root. Closes `..` traversal and symlink escapes.
 */
function resolveRun(root: string, sessionId?: string): { run?: string; error?: string } {
  const b = runsBase(root)
  if ("error" in b) return { error: b.error }
  const base = b.base

  if (sessionId) {
    if (!SESSION_ID.test(sessionId)) return { error: `refused: invalid session id "${clean(sessionId, 32)}"` }
    const run = join(base, sessionId)
    const rel = relative(base, run)
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: "refused: session id escapes the run root" }
    let runStat
    try {
      runStat = lstatIfExists(run)
    } catch {
      return { error: "refused: run dir is not resolvable" }
    }
    if (runStat) {
      try {
        if (runStat.isSymbolicLink()) return { error: "refused: run dir is a symlink" }
        const relReal = relative(realpathSync(base), realpathSync(run))
        if (!relReal || relReal.startsWith("..") || isAbsolute(relReal)) return { error: "refused: run dir escapes the run root" }
      } catch {
        return { error: "refused: run dir is not resolvable" }
      }
    }
    return { run }
  }
  const latest = listRuns(root)[0]?.path
  return latest ? { run: latest } : { error: "no Teamwork run found" }
}

function readJson<T>(run: string, file: string, fallback: T): T {
  const text = readRunText(run, file, MAX_RUN_JSON_BYTES)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown) {
  writeTextAtomicSafe(file, JSON.stringify(value, null, 2) + "\n")
}

/**
 * Create `file` with `content` only if it does not already exist.
 *
 * One atomic `O_CREAT|O_EXCL` create (flag `wx`) replaces the old
 * lstat/existsSync-then-write sequence: `O_EXCL` refuses an existing entry
 * (including a symlink planted at the target), so there is no window in which a
 * link can be swapped in between the check and the write, and a symlink is
 * never followed. `EEXIST` is the expected "already present" case and is a
 * no-op. Exported for the regression tests.
 */
export function touch(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(file, content, { encoding: "utf8", flag: "wx" })
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err
  }
}

/**
 * Next sequence number for one `<run>/events.jsonl`: a single number space per
 * file, starting at 1. Called inside the append lock, so no two appends can
 * race for the same value. The tail (last 8 KiB) is read rather than the whole
 * file: the last non-empty line's `seq` + 1 is the answer in the common case.
 * A legacy line without `seq`, or a malformed / truncated tail, falls back to
 * counting non-empty lines (correctness over micro-optimisation: a legacy log
 * still gets a value above every line already present, and nothing is lost).
 * The tail and the fallback count share ONE fd opened `O_NOFOLLOW|O_NONBLOCK`;
 * a symlink (ELOOP), a missing file (ENOENT), or a non-regular file (FIFO)
 * yields "first event" so the fail-open append path can never block or follow
 * a link. Exported for the regression tests.
 */
export function nextEventSeq(file: string, run?: string): number {
  let fd: number
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch {
    return 1 // absent (ENOENT), symlink (ELOOP), or unreadable: this is the first event
  }
  try {
    const stat = fstatSync(fd)
    // A FIFO/device/socket must never be followed or block an append.
    if (!stat.isFile()) return 1
    // Optional ADR 0004 check: on Linux, never count a descriptor that resolved
    // outside the run. Other platforms keep the existing behavior.
    if (run && supportsFdContainment()) {
      let runReal: string
      try {
        runReal = realpathSync(run)
      } catch {
        return 1
      }
      if (!fdWithin(runReal, fd)) return 1
    }
    const fromTail = seqFromTail(readTail(fd, stat.size))
    if (fromTail !== null) return fromTail
    return countNonEmptyLines(fd) + 1
  } catch {
    return 1
  } finally {
    closeSync(fd)
  }
}

/** Read the last ≤8 KiB of a file through an already-open fd. */
function readTail(fd: number, size: number): string {
  const len = Math.min(size, 8192)
  if (len <= 0) return ""
  const buf = Buffer.alloc(len)
  let read = 0
  while (read < len) {
    const n = readSync(fd, buf, read, len - read, size - len + read)
    if (n === 0) break
    read += n
  }
  return buf.subarray(0, read).toString("utf8")
}

/**
 * `seq` of the last non-empty line of `tail`, plus one — or null when that line
 * is legacy (no seq) or corrupt, in which case the caller counts lines instead.
 */
function seqFromTail(tail: string): number | null {
  const lines = tail.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l) continue
    try {
      const seq = (JSON.parse(l) as any)?.seq
      if (Number.isInteger(seq) && seq > 0) return seq + 1
    } catch {}
    break // last line is legacy or corrupt: count lines instead
  }
  return null
}

/**
 * Count non-empty lines through an already-open fd, in fixed-size 64 KiB
 * positional reads (no lseek, no unbounded buffer). ASCII whitespace does not
 * make a line non-empty.
 */
function countNonEmptyLines(fd: number): number {
  let count = 0
  let pending = false // non-whitespace bytes seen on the current line
  let position = 0
  const chunk = Buffer.alloc(64 * 1024)
  for (;;) {
    const n = readSync(fd, chunk, 0, chunk.length, position)
    if (n === 0) break
    position += n
    const scanned = scanLineChunk(chunk, n, count, pending)
    count = scanned.count
    pending = scanned.pending
  }
  return pending ? count + 1 : count
}

/** ASCII whitespace: it never makes a line non-empty. */
function isBlankByte(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0b || b === 0x0c
}

/** Advance the pending/count state across one chunk of bytes. */
function scanLineChunk(
  chunk: Buffer,
  n: number,
  count: number,
  pending: boolean,
): { count: number; pending: boolean } {
  for (let i = 0; i < n; i++) {
    const b = chunk[i]
    if (b === 0x0a) {
      if (pending) count++
      pending = false
    } else if (!isBlankByte(b)) {
      pending = true
    }
  }
  return { count, pending }
}

/**
 * Append one lifecycle event to `<run>/events.jsonl` (append-only, one JSON
 * object per line). Fail-open: any error is swallowed so the DAG engine never
 * depends on the event log. Every string field is sanitised with clean() so no
 * value can inject a second physical line.
 *
 * `seq` is assigned here, inside the same lock as the append, and is monotonic
 * per file. `agentSource` records where the actor came from and is emitted only
 * when `agent` is non-null.
 */
async function appendEvent(
  run: string,
  ev: {
    event:
      | "run_created"
      | "task_transition"
      | "security_audit"
      | "victory_audit"
      | "verification_wave"
      | "final_verification"
      | "final_verification_bypass"
      | "preflight"
      | "tournament_step"
      | "tournament_cancelled"
      | "briefing_warning"
    sessionId: string
    taskId?: string | null
    from?: string | null
    to: string
    round?: number
    agent?: string | null
    /** Provenance of `agent`: explicit input, session lookup, or plan declaration. */
    agentSource?: "explicit" | "session" | "plan"
    branch?: string | null
    worktree?: string | null
    phase?: string | null
    /** run_created only: how the spec gate was decided (3.4). */
    specGate?: "satisfied" | "bypassed" | "not_required"
    /** run_created only: the spec file, when the gate was satisfied. */
    specPath?: string | null
    /**
     * final_verification_bypass: why an unstamped verdict was accepted.
     * preflight / run_created: an input-preflight bypass or missing-input note.
     */
    note?: string | null
  },
) {
  try {
    const eventsFile = join(run, "events.jsonl")
    await withFileLock(eventsFile, () => {
      refuseSymlink(eventsFile)
      const opt = (v: unknown, max: number) => (v === null || v === undefined || v === "" ? null : clean(v, max))
      const agent = opt(ev.agent, 64)
      const note = opt(ev.note, 200)
      const source =
        agent && (ev.agentSource === "explicit" || ev.agentSource === "session" || ev.agentSource === "plan")
          ? ev.agentSource
          : null
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        seq: nextEventSeq(eventsFile, run),
        event: ev.event,
        sessionId: clean(ev.sessionId, 64),
        taskId: opt(ev.taskId, 64),
        from: opt(ev.from, 32),
        to: clean(ev.to, 32),
        round: Number(ev.round) || 0,
        agent,
        ...(source ? { agentSource: source } : {}),
        branch: opt(ev.branch, 120),
        worktree: opt(ev.worktree, 200),
        phase: opt(ev.phase, 32),
        ...(note ? { note } : {}),
        // Only run_created carries the spec-gate decision. Every line now also
        // carries seq (and agentSource when an actor exists); legacy lines on
        // disk keep their old shape and remain valid.
        ...(ev.specGate
          ? { specGate: clean(ev.specGate, 16), ...(ev.specPath ? { specPath: clean(ev.specPath, 200) } : {}) }
          : {}),
      })
      appendFileSync(eventsFile, line + "\n")
    })
  } catch {
    // fail-open: an events.jsonl write failure must never alter tool results
  }
}

// Serialise read-modify-write of a run's cost files within this process, so
// concurrent agents (parallel workers calling teamwork_cost at once) cannot
// clobber each other's attribution. Keyed by the file path; the whole async
// section — including the client read — runs inside the lock.
const fileLocks = new Map<string, Promise<unknown>>()
function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  fileLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next as Promise<T>
}

/**
 * Compact, sanitised run summary injected into team agents' system prompt.
 * Only whitelisted/enumerated fields are emitted; no raw file content.
 */
const UNSAFE_PATH_RE =
  /symlink|escapes|outside|containment|not a regular file|not accessible|not resolvable|unreadable|invalid path segment|intermediate path/i

function isUnsafePathError(msg: string): boolean {
  return /^refused:/i.test(msg) || UNSAFE_PATH_RE.test(msg)
}

function isUnsafePathDetail(msg: string): boolean {
  return UNSAFE_PATH_RE.test(msg)
}

export function describeRun(root: string): string | undefined {
  const { run } = resolveRun(root)
  if (!run) return undefined
  const state = readJson<any>(run, join(run, "state.json"), undefined)
  if (!state) return undefined
  const tasks = Object.values(state.tasks || {}) as any[]
  const pass = tasks.filter((t) => isPassStatus(t?.status)).length
  const fail = tasks.filter((t) => t?.status === "fail" || t?.status === "verified_fail" || t?.status === "blocked").length
  const allPitfalls = readPitfalls(run)
  const pitfalls = allPitfalls.length
  const recentPitfalls = allPitfalls.slice(-2).map((p) => clean(p, 70))
  const pitfallSuffix = recentPitfalls.length ? ` (recent: ${recentPitfalls.join("; ")})` : ""
  const id = basename(run)
  if (!SESSION_ID.test(id)) return undefined // never inject a non-conforming dir name
  const phase = PHASES.has(state.phase) ? state.phase : "UNKNOWN"
  const tournamentLine = describeTournamentLine(run)
  return [
    `[teamwork] active run ${id} — phase ${phase}.`,
    `Tasks: ${pass}/${tasks.length} pass, ${fail} fail. Open pitfalls: ${pitfalls}${pitfallSuffix}.`,
    ...(tournamentLine ? [tournamentLine] : []),
    describeCostLine(run),
    ...describeBriefingLines(root, id),
    `State: ${join(runsDir(root), id, "state.json")} (read it before dispatching).`,
  ].join("\n")
}

function describeCostLine(run: string): string {
  const costs = readJson<any>(run, join(run, "costs.json"), undefined)
  if (!costs || typeof costs.budgetUsd !== "number") return "Cost: unknown."
  const budget = costs.budgetUsd
  const spent = Number(costs.spentUsd) || 0
  const pct = budget ? Math.floor((spent / budget) * 100) : 0
  return `Cost: $${spent} of $${budget} (${pct}%)${pct >= 80 ? " — near budget, halt non-essential workers" : ""}.`
}

function describeTournamentLine(run: string): string | undefined {
  const mRes = readTournamentManifest(run)
  if (mRes.status !== "ok") return undefined
  const m = mRes.manifest
  const mPhase = TOURNAMENT_PHASES.has(m.phase) ? m.phase : "UNKNOWN"
  const candList = Object.values(m.candidates || {})
  const surviving = candList.filter((c) => c && c.status !== "pruned").length
  return `Tournament: phase ${mPhase}, iter ${Number(m.iteration) || 0}/${Number(m.config?.maxIterations) || 0}, level ${Number(m.currentLevel) || 0}/${Number(m.config?.levels) || 0}, candidates ${candList.length} (${surviving} surviving).`
}

function describeBriefingLines(root: string, id: string): string[] {
  const run = join(runsDir(root), id)
  const briefing = readBriefingExcerpt(run)
  if (!briefing) return []
  const file = join(run, "BRIEFING.md")
  const header = briefing.truncated
    ? `[teamwork] run briefing (${file}) — first 4096 of ${briefing.bytes} bytes:`
    : `[teamwork] run briefing (${file}):`
  const lines = [header, briefing.text]
  if (briefing.truncated) {
    lines.push("[teamwork] briefing excerpt truncated at 4096 bytes; read BRIEFING.md for the rest.")
  }
  return lines
}

/**
 * Rebuild `<run>/BRIEFING.md` without ever failing the caller's operation.
 * A refused/failed write is recorded as a `briefing_warning` event; the
 * primary tool result is unchanged either way.
 */
async function refreshBriefingSafe(run: string): Promise<string | undefined> {
  try {
    refreshRunBriefing(run)
    return undefined
  } catch (err: any) {
    const note = clean(err?.message || "briefing refresh failed", 200)
    try {
      await appendEvent(run, {
        event: "briefing_warning",
        sessionId: basename(run),
        taskId: null,
        to: "BRIEFING",
        round: 0,
        agent: null,
        phase: null,
        note,
      })
    } catch {}
    return note
  }
}

function ensureSafeRunSubpath(run: string, targetFile: string) {
  const absRun = resolve(run)
  const absTarget = resolve(targetFile)
  const rel = relative(absRun, absTarget)
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) {
    throw new Error("refused: target path escapes run directory")
  }
  let runStat
  try {
    runStat = lstatIfExists(absRun)
  } catch {
    throw new Error("refused: run directory is not resolvable")
  }
  if (runStat?.isSymbolicLink()) throw new Error("refused: run directory is a symlink")
  const realRun = runStat ? realpathSync(absRun) : absRun
  let cur = absTarget
  while (cur !== absRun && cur !== dirname(cur)) {
    refuseSymlink(cur)
    let st
    try {
      st = lstatIfExists(cur)
    } catch {
      throw new Error(`refused: cannot inspect "${basename(cur)}"`)
    }
    if (st) {
      if (cur !== absTarget && !st.isDirectory()) {
        throw new Error(`refused: parent "${basename(cur)}" is not a directory`)
      }
      if (cur === absTarget && !st.isFile()) {
        throw new Error(`refused: target "${basename(cur)}" is not a regular file`)
      }
      const realRel = relative(realRun, realpathSync(cur))
      if (!realRel || isAbsolute(realRel) || realRel.startsWith("..")) {
        throw new Error("refused: path escapes run directory via realpath")
      }
    }
    cur = dirname(cur)
  }
}

function writeTextSafe(run: string, targetFile: string, content: string) {
  // Write-path residual (ADR 0004): the containment check is by path. A raced
  // intermediate directory can still redirect the temp create/rename outside
  // the run. The read path is the one with post-open fd containment.
  ensureSafeRunSubpath(run, targetFile)
  mkdirSync(dirname(targetFile), { recursive: true })
  const tmp = targetFile + ".tmp"
  refuseSymlink(tmp)
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, targetFile)
}

function writeJsonSafe(run: string, targetFile: string, value: unknown) {
  ensureSafeRunSubpath(run, targetFile)
  writeJson(targetFile, value)
}

function readRegularJson<T>(run: string, targetFile: string): { ok: true; data: T } | { ok: false; reason: "missing" | "symlink" | "invalid" } {
  const res = readBoundedRunFile(run, targetFile, MAX_RUN_FILE_BYTES)
  if (res.status === "absent") return { ok: false, reason: "missing" }
  if (res.status === "error") {
    return res.error.includes("symlink") || res.error.includes("escapes") || res.error.includes("not a regular file")
      ? { ok: false, reason: "symlink" }
      : { ok: false, reason: "invalid" }
  }
  try {
    return { ok: true, data: JSON.parse(res.text) as T }
  } catch {
    return { ok: false, reason: "invalid" }
  }
}

// ---------------------------------------------------------------------------
// Artifact authenticity (Phase A)
//
// Control-plane artifacts are HMAC-signed and indexed in ctx.storage. The run
// manifest is the signed baseline: it pins the plan/request/requirements/policy
// hashes and the three completion modes, so a later edit that downgrades
// strict→standard or required→skip is AUTH_STALE. See auth.ts and
// docs/adr/0005-artifact-authenticity.md.
// ---------------------------------------------------------------------------

const RUN_MANIFEST = "run.manifest.json"
const RUN_MANIFEST_VERSION = 1

type RunManifest = {
  version: 1
  sessionId: string
  rootSessionId: string
  integrityMode: IntegrityMode
  verification: VerificationMode
  victoryAudit: VictoryAuditMode
  requestHash: string | null
  requirementsHash: string | null
  planHash: string
  lemmaPolicyHash: string | null
  runKeyId: string
  createdAt: string
  _auth?: AuthEnvelope
}

function runManifestFile(run: string): string {
  return join(run, RUN_MANIFEST)
}

function planBaselineHash(plan: any): string {
  return sha256Hex(
    canonicalJson({
      topology: plan?.topology ?? null,
      integrityMode: plan?.integrityMode ?? null,
      verification: plan?.verification ?? null,
      victoryAudit: plan?.victoryAudit ?? null,
      route: plan?.route ?? null,
      lemmaBounds: plan?.lemmaBounds ?? null,
      tasks: Array.isArray(plan?.tasks) ? plan.tasks : [],
    }),
  )
}

function planHashOf(plan: unknown): string {
  return planBaselineHash(plan)
}

function lemmaPolicyHashOf(run: string): string | null {
  const res = readRegularJson<any>(run, join(run, "lemma", "manifest.json"))
  if (!res.ok) return null
  const policy = res.data?.policy
  if (policy === undefined || policy === null) return null
  return sha256Hex(canonicalJson(policy))
}

function authFailureText(failure: AuthFailure): string {
  return `[${failure.code}] ${failure.message}`
}

type ManifestCheck =
  | { ok: true; manifest: RunManifest; signed: true }
  | { ok: true; signed: false }
  | { ok: false; failure: AuthFailure }

/**
 * Read and verify `run.manifest.json`. A present-but-unsigned manifest is an
 * AUTH_INVALID failure (never a legacy run), and a missing index entry fails
 * closed rather than adopting the artifact.
 */
async function readRunManifest(run: string, auth?: AuthContext): Promise<ManifestCheck> {
  if (!existsSync(runManifestFile(run))) return { ok: true, signed: false }
  const res = readRegularJson<any>(run, runManifestFile(run))
  if (!res.ok) {
    if (res.reason === "missing") return { ok: true, signed: false }
    return {
      ok: false,
      failure: {
        code: "AUTH_INVALID",
        message: `run.manifest.json is ${res.reason === "symlink" ? "a symlink" : "unreadable or malformed"}`,
      },
    }
  }
  const value = res.data
  if (!value || typeof value !== "object" || value.version !== RUN_MANIFEST_VERSION) {
    return { ok: false, failure: { code: "AUTH_INVALID", message: "run.manifest.json has an invalid schema version" } }
  }
  if (!auth) {
    return { ok: false, failure: { code: "AUTH_UNAVAILABLE", message: "no authenticity context is wired for this run" } }
  }
  const check = await auth.verifyRunArtifact(basename(run), RUN_MANIFEST, value)
  if (check.status === "unsigned") {
    return { ok: false, failure: { code: "AUTH_INVALID", message: "run.manifest.json has no _auth envelope" } }
  }
  if (check.status !== "signed") {
    return {
      ok: false,
      failure: check.failure ?? { code: "AUTH_INVALID", message: "run.manifest.json failed verification" },
    }
  }
  return { ok: true, manifest: value as RunManifest, signed: true }
}

/**
 * Compare the signed baseline with the current artifacts. Any drift is
 * AUTH_STALE and closes the strict→standard / required→skip downgrade path.
 */
function manifestDriftReason(drift: string): string {
  if (drift.startsWith("requestHash")) {
    return `[AUTH_STALE] victory audit: requestHash does not match the current ORIGINAL_REQUEST.md (${drift})`
  }
  if (drift.startsWith("requirementsHash")) {
    return `[AUTH_STALE] requirements baseline changed since the plan (${drift})`
  }
  if (drift.startsWith("verification")) {
    return `[AUTH_STALE] verification downgrade/change refused (${drift})`
  }
  if (drift.startsWith("integrityMode")) {
    return `[AUTH_STALE] integrity mode downgrade/change refused (${drift})`
  }
  if (drift.startsWith("victoryAudit")) {
    return `[AUTH_STALE] victory audit downgrade/change refused (${drift})`
  }
  if (drift.startsWith("planHash")) {
    return `[AUTH_STALE] plan baseline changed (${drift})`
  }
  if (drift.startsWith("lemmaPolicyHash")) {
    return `[AUTH_STALE] LEMMA policy baseline changed (${drift})`
  }
  return `[AUTH_STALE] ${drift}`
}

function manifestDrift(manifest: RunManifest, current: Omit<RunManifest, "version" | "sessionId" | "rootSessionId" | "runKeyId" | "createdAt" | "_auth">): string[] {
  const drift: string[] = []
  if (manifest.integrityMode !== current.integrityMode) {
    drift.push(`integrityMode drifted: manifest=${manifest.integrityMode} current=${current.integrityMode}`)
  }
  if (manifest.verification !== current.verification) {
    drift.push(`verification drifted: manifest=${manifest.verification} current=${current.verification}`)
  }
  if (manifest.victoryAudit !== current.victoryAudit) {
    drift.push(`victoryAudit drifted: manifest=${manifest.victoryAudit} current=${current.victoryAudit}`)
  }
  for (const key of ["requestHash", "requirementsHash", "planHash", "lemmaPolicyHash"] as const) {
    const a = manifest[key]
    const b = current[key]
    if (a !== b) drift.push(`${key} drifted (manifest=${a ?? "null"} current=${b ?? "null"})`)
  }
  return drift
}

/** Recompute the signed-baseline comparison from the current run artifacts. */
function currentManifestDrift(manifest: RunManifest, plan: any, state: any, run: string): string[] {
  return manifestDrift(manifest, {
    integrityMode: normalizeIntegrityMode(plan?.integrityMode ?? state?.integrityMode) ?? DEFAULT_INTEGRITY_MODE,
    verification: resolveVerificationMode(plan, state).mode,
    victoryAudit: resolveVictoryAuditMode(plan, state, run).mode,
    requestHash: originalRequestHash(run),
    requirementsHash: currentRequirementsHash(run),
    planHash: planHashOf(plan),
    lemmaPolicyHash: lemmaPolicyHashOf(run),
  })
}

/**
 * Session-tree binding: the caller of victory_audit / wave_record / report must
 * be a strict descendant of the run's root (the plan-time Sentinel session).
 * Fails closed when the ancestry cannot be resolved.
 */
const SESSION_TREE_MAX_DEPTH = 32

async function requireDescendantSession(
  ctx: any,
  rootSessionId: string | undefined,
  sessionID: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!sessionID) return { ok: false, reason: "no session identity was supplied" }
  if (!rootSessionId) return { ok: false, reason: "the run has no recorded rootSessionId (fail closed)" }
  if (sessionID === rootSessionId) {
    return { ok: false, reason: "the caller is the root session, not a descendant (fail closed)" }
  }
  let current = sessionID
  for (let depth = 0; depth < SESSION_TREE_MAX_DEPTH; depth++) {
    let info: any
    try {
      if (typeof ctx?.session?.get !== "function") {
        return { ok: false, reason: "ctx.session.get is unavailable, so session ancestry cannot be resolved (fail closed)" }
      }
      info = await withTimeout(Promise.resolve(ctx.session.get({ sessionID: current })), 2000)
    } catch {
      return { ok: false, reason: `session ${clean(current, 64)} could not be resolved (fail closed)` }
    }
    const parent = info?.parentID ?? info?.parentId ?? info?.parent_id
    if (typeof parent !== "string" || parent.trim() === "") {
      return {
        ok: false,
        reason: `session ${clean(current, 64)} has no parent, so it does not descend from ${clean(rootSessionId, 64)} (fail closed)`,
      }
    }
    if (parent === rootSessionId) return { ok: true }
    current = parent
  }
  return { ok: false, reason: `session ancestry exceeds ${SESSION_TREE_MAX_DEPTH} levels (fail closed)` }
}

/** The run's recorded root session (manifest first, then plan/state). */
function recordedRootSessionId(manifest: RunManifest | undefined, plan: any, state: any): string | undefined {
  const candidate = manifest?.rootSessionId ?? plan?.rootSessionId ?? state?.rootSessionId
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined
}

async function createPlanRun(
  ctx: any,
  root: string,
  input: any,
  context: any,
  beforeMkdir?: (info: { sessionId: string; run: string; integrityMode: IntegrityMode; topology: string }) => Promise<string | undefined> | string | undefined,
  auth?: AuthContext,
): Promise<{ ok: true; sessionId: string; run: string; tasks: any[]; topology: string; integrityMode: IntegrityMode; content: string } | { ok: false; content: string; refused?: string; aborted?: boolean }> {
  const sessionId = input.sessionId || newSessionId()
  const resolved = resolveRun(root, sessionId)
  if (resolved.error) return { ok: false, content: resolved.error }
  const run = resolved.run as string
  // Authenticity preflight. A signed run is the default. `allowUnsignedLegacy`
  // is the explicit, recorded opt-out for pre-1.4 runs; without it, a missing
  // key source refuses the plan before anything is written.
  const allowUnsignedLegacy = input.allowUnsignedLegacy === true
  const authReady = await (auth
    ? auth.ready()
    : Promise.resolve({ ok: false as const, failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired" } }))
  if (!authReady.ok && !allowUnsignedLegacy) {
    return {
      ok: false,
      content: `refused: ${authFailureText(authReady.failure)}; this plan would be unsigned. Configure ctx.storage (the plugin runtime provides it) or set OPENCODE_TEAMWORK_HMAC_KEY for CI, or re-call with allowUnsignedLegacy: true to create an explicitly unsigned legacy run. Nothing was written.`,
      refused: authReady.failure.code,
    }
  }
  const existingManifestCheck = await readRunManifest(run, auth)
  if (!existingManifestCheck.ok) {
    return {
      ok: false,
      content: `refused: ${authFailureText(existingManifestCheck.failure)}; the existing run manifest is not trustworthy. Nothing was written.`,
      refused: existingManifestCheck.failure.code,
    }
  }
  const existingManifest = existingManifestCheck.ok && existingManifestCheck.signed ? existingManifestCheck.manifest : undefined
  const runHasPlan = existsSync(join(run, "plan.dag.json"))
  if (!existingManifest && runHasPlan && !allowUnsignedLegacy) {
    return {
      ok: false,
      content:
        "refused: [AUTH_LEGACY] this run has no signed run.manifest.json (it predates artifact authenticity). Re-call teamwork_plan with allowUnsignedLegacy: true to keep the legacy run, or start a new session. Nothing was written.",
      refused: "AUTH_LEGACY",
    }
  }
  // Refuse an unknown topology before anything is written, so a typo can
  // never become the run's permanent label.
  const topology = normalizeTopology(input.topology)
  if (!topology) {
    return {
      ok: false,
      content: `refused: invalid topology "${clean(input.topology, 32)}" (accepted: ${TOPOLOGIES.join(", ")}; aliases: ${Object.keys(TOPOLOGY_ALIASES).join(", ")})`,
    }
  }
  const rawRoute = typeof input.route === "string" ? clean(input.route, 32).trim().toLowerCase() : ""
  const isLemma = input.lemmaMode === true || rawRoute === "lemma"
  if (input.lemmaMode === true && rawRoute && rawRoute !== "lemma") {
    return {
      ok: false,
      content: `refused: lemmaMode: true conflicts with route "${rawRoute}"; nothing was written.`,
    }
  }
  if (input.lemmaMode === false && rawRoute === "lemma") {
    return {
      ok: false,
      content: `refused: route "lemma" conflicts with lemmaMode: false; nothing was written.`,
    }
  }
  if (isLemma && topology !== "proof") {
    return {
      ok: false,
      content: `refused: LEMMA route requires topology "proof" (got "${topology}"); nothing was written.`,
    }
  }
  let lemmaBounds: LemmaBounds | undefined
  if (isLemma || input.lemmaBounds !== undefined) {
    const boundsCheck = validateLemmaBounds(input.lemmaBounds)
    if (boundsCheck.error || !boundsCheck.bounds) {
      return { ok: false, content: boundsCheck.error ?? "refused: invalid lemmaBounds; nothing was written." }
    }
    lemmaBounds = boundsCheck.bounds
  }
  // The caller may propose the axiom allowlist only at plan time. It is
  // validated here, persisted in lemma/manifest.json, and never accepted again
  // by verification.
  let lemmaPolicy: LemmaPolicy | undefined
  if (input.lemmaPolicy !== undefined) {
    if (!isLemma) {
      return { ok: false, content: "refused: lemmaPolicy requires lemmaMode: true (or route: \"lemma\"); nothing was written." }
    }
    const policyCheck = validateLemmaPolicy(input.lemmaPolicy)
    if (policyCheck.error || !policyCheck.policy) {
      return { ok: false, content: policyCheck.error ?? "refused: invalid lemmaPolicy; nothing was written." }
    }
    lemmaPolicy = policyCheck.policy
  }
  let lemmaProbe: LemmaProbeResult | undefined
  if (isLemma) {
    let runExists = existsSync(run)
    if (!runExists) {
      try {
        lstatSync(run)
        runExists = true
      } catch {}
    }
    if (runExists) {
      for (const rel of ["lemma/manifest.json", "lemma/formalization-review.json"]) {
        try {
          ensureSafeRunSubpath(run, join(run, rel))
        } catch (err: any) {
          return { ok: false, content: `${clean(err?.message, 200)}; nothing was written.` }
        }
      }
      const existingManRes = readBoundedRunFile(run, join(run, "lemma", "manifest.json"), MAX_RUN_FILE_BYTES)
      if (existingManRes.status === "ok") {
        try {
          const parsedMan = JSON.parse(existingManRes.text)
          const prevB = parsedMan?.bounds
          if (prevB) {
            if (
              input.lemmaBounds !== undefined &&
              (prevB.maxDepth !== lemmaBounds?.maxDepth ||
                prevB.maxWidth !== lemmaBounds?.maxWidth ||
                prevB.maxNodes !== lemmaBounds?.maxNodes ||
                prevB.maxRetries !== lemmaBounds?.maxRetries)
            ) {
              return {
                ok: false,
                content: "refused: lemmaBounds conflict with existing lemma/manifest.json; nothing was written.",
              }
            }
            lemmaBounds = {
              maxDepth: prevB.maxDepth,
              maxWidth: prevB.maxWidth,
              maxNodes: prevB.maxNodes,
              maxRetries: prevB.maxRetries,
            }
          }
          // The approved axiom policy is immutable once persisted. A re-plan
          // that supplies a different list is refused; omitting it keeps the
          // previously approved policy (matching the bounds-consistency rule).
          const prevPolicy = parsedMan?.policy
          if (prevPolicy !== undefined && prevPolicy !== null) {
            const resolved = resolveManifestAxiomAllowlist(parsedMan)
            if (resolved.error) {
              return { ok: false, content: `${resolved.error}; nothing was written.` }
            }
            if (input.lemmaPolicy !== undefined && !sameAxiomSet(resolved.allowedAxioms, lemmaPolicy?.allowedAxioms ?? [])) {
              return {
                ok: false,
                content: "refused: lemmaPolicy conflicts with the approved policy in lemma/manifest.json; nothing was written.",
              }
            }
          } else if (input.lemmaPolicy !== undefined && (lemmaPolicy?.allowedAxioms.length ?? 0) > 0) {
            return {
              ok: false,
              content:
                "refused: existing lemma/manifest.json has no approved axiom policy (legacy run); start a new run instead of widening it.",
            }
          }
        } catch {}
      }
    }
    // Capability probe runs BEFORE mkdirSync; allowMissingInputs MUST NOT bypass.
    lemmaProbe = probeLemmaToolchain()
    if (!lemmaProbe.ready) {
      return {
        // Preserve the probe payload for the route/tool caller; the plan tool
        // only returns content, but tests inspect the refusal text.
        ok: false,
        content: formatMissingToolchainRefusal(lemmaProbe),
      }
    }
  }
  // Refuse an unknown integrity mode before anything is written. The mode
  // is the run's integrity contract, so a typo must never be persisted.
  const integrityMode =
    input.integrityMode === undefined || input.integrityMode === null
      ? DEFAULT_INTEGRITY_MODE
      : normalizeIntegrityMode(input.integrityMode)
  if (!integrityMode) {
    return {
      ok: false,
      content: `refused: invalid integrityMode "${clean(input.integrityMode, 32)}" (accepted: ${INTEGRITY_MODES.join(", ")}; default: ${DEFAULT_INTEGRITY_MODE})`,
    }
  }
  // Verification mode: standard (default, unchanged) or strict (one falsifier
  // challenge + one security-auditor audit per task). It is part of the run's
  // contract, so an invalid value refuses before anything is written and a
  // re-plan may keep or repeat the persisted mode but never change it.
  const requestedVerification =
    input.verification === undefined || input.verification === null
      ? undefined
      : normalizeVerificationMode(input.verification)
  if (input.verification !== undefined && input.verification !== null && !requestedVerification) {
    return {
      ok: false,
      content: `refused: invalid verification "${clean(input.verification, 32)}" (accepted: standard | strict; default: ${DEFAULT_VERIFICATION_MODE}); nothing was written.`,
    }
  }
  let persistedVerification: VerificationMode | undefined
  if (existsSync(run)) {
    const planRes = readBoundedRunJson<any>(run, join(run, "plan.dag.json"), MAX_MANIFEST_BYTES)
    if (planRes.status === "error") {
      return { ok: false, content: `${planRes.error}; nothing was written.` }
    }
    const stateRes = readBoundedRunJson<any>(run, join(run, "state.json"), MAX_MANIFEST_BYTES)
    if (stateRes.status === "error") {
      return { ok: false, content: `${stateRes.error}; nothing was written.` }
    }
    const fromPlanRaw = planRes.status === "ok" ? planRes.value?.verification : undefined
    const fromStateRaw = stateRes.status === "ok" ? stateRes.value?.verification : undefined
    const fromPlan =
      fromPlanRaw === undefined || fromPlanRaw === null ? undefined : normalizeVerificationMode(fromPlanRaw)
    const fromState =
      fromStateRaw === undefined || fromStateRaw === null ? undefined : normalizeVerificationMode(fromStateRaw)
    if (
      (fromPlanRaw !== undefined && fromPlanRaw !== null && !fromPlan) ||
      (fromStateRaw !== undefined && fromStateRaw !== null && !fromState)
    ) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json or state.json records an invalid verification mode; repair the run or start a new session. Nothing was written.",
      }
    }
    if (fromPlan && fromState && fromPlan !== fromState) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json and state.json disagree about verification; repair the run or start a new session. Nothing was written.",
      }
    }
    persistedVerification = fromPlan ?? fromState
  }
  if (persistedVerification && requestedVerification && persistedVerification !== requestedVerification) {
    return {
      ok: false,
      content: `refused: verification is already persisted as "${persistedVerification}" for this run and cannot be changed by a re-plan; omit it to keep the mode or start a new session. Nothing was written.`,
    }
  }
  const verificationMode: VerificationMode =
    persistedVerification ?? requestedVerification ?? DEFAULT_VERIFICATION_MODE
  // The request record is verbatim, so refuse rather than truncate. The
  // length check runs before anything is written.
  const request = typeof input.request === "string" ? input.request : undefined
  if (request !== undefined && !request.trim()) {
    return {
      ok: false,
      content: "refused: request must be non-empty when supplied; omit it or pass the user's verbatim request. Nothing was written.",
    }
  }
  if (request !== undefined && request.length > REQUEST_MAX) {
    return {
      ok: false,
      content: `refused: request is ${request.length} chars, over the ${REQUEST_MAX}-char limit; it must be recorded verbatim. Shorten it or start the run from a shorter routed request. Nothing was written.`,
    }
  }
  // Requirements baseline + victory-audit mode. Both are validated before any
  // write: an invalid id / duplicate refuses the whole plan with nothing on disk.
  let requirementsBaseline: RequirementsFile | undefined
  if (input.requirements !== undefined) {
    const reqCheck = validateRequirementsBaseline(input.requirements)
    if (!reqCheck.ok) return { ok: false, content: `${reqCheck.error}; nothing was written.` }
    if (reqCheck.items.length > 0) requirementsBaseline = callerRequirementsFile(reqCheck.items)
  }
  if (!requirementsBaseline) requirementsBaseline = readRequirementsBaseline(run)
  if (!requirementsBaseline && request !== undefined) requirementsBaseline = deriveRequirementsFromRequest(request)
  let victoryAuditMode: VictoryAuditMode
  let victoryAuditSource: "caller" | "default" = "default"
  if (input.victoryAudit !== undefined && input.victoryAudit !== null) {
    const requestedMode = normalizeVictoryAuditMode(input.victoryAudit)
    if (!requestedMode) {
      return {
        ok: false,
        content: "refused: victoryAudit must be \"required\" or \"skip\"; nothing was written.",
      }
    }
    victoryAuditMode = requestedMode
    victoryAuditSource = "caller"
  } else {
    victoryAuditMode = requirementsBaseline ? "required" : "skip"
  }
  if (victoryAuditMode === "required" && !requirementsBaseline) {
    return {
      ok: false,
      content:
        "refused: victoryAudit: \"required\" needs a requirements baseline; pass request or requirements, or record victoryAudit: \"skip\" explicitly. Nothing was written.",
    }
  }
  // Benchmark mode is the strictest integrity contract: it refuses to exist
  // unsigned and it refuses the victory-audit skip.
  if (integrityMode === "benchmark" && allowUnsignedLegacy) {
    return {
      ok: false,
      content:
        "refused: [AUTH_LEGACY] benchmark mode cannot run unsigned; allowUnsignedLegacy is not permitted with integrityMode: \"benchmark\". Nothing was written.",
      refused: "AUTH_LEGACY",
    }
  }
  if (integrityMode === "benchmark" && victoryAuditMode === "skip") {
    return {
      ok: false,
      content:
        "refused: benchmark mode requires the independent victory audit; victoryAudit: \"skip\" is not permitted with integrityMode: \"benchmark\". Nothing was written.",
    }
  }
  if (existingManifest) {
    const modeDrift: string[] = []
    if (existingManifest.integrityMode !== integrityMode) {
      modeDrift.push(`integrityMode (${existingManifest.integrityMode} -> ${integrityMode})`)
    }
    if (existingManifest.verification !== verificationMode) {
      modeDrift.push(`verification (${existingManifest.verification} -> ${verificationMode})`)
    }
    if (existingManifest.victoryAudit !== victoryAuditMode) {
      modeDrift.push(`victoryAudit (${existingManifest.victoryAudit} -> ${victoryAuditMode})`)
    }
    if (modeDrift.length > 0) {
      return {
        ok: false,
        content: `refused: [AUTH_STALE] a re-plan cannot change the signed baseline (${modeDrift.join(", ")}); omit the mode to keep it or start a new session. Nothing was written.`,
        refused: "AUTH_STALE",
      }
    }
  }
  // SEC-1: task ids become keys of state/costs maps and path/branch segments.
  // Refuse the whole plan (before anything is written) on any unsafe id.
  for (const t of input.tasks || []) {
    const ids = [t?.id, ...(Array.isArray(t?.dependsOn) ? t.dependsOn : [])]
    const i = ids.findIndex((id: unknown) => typeof id !== "string" || !isSafeTaskId(id))
    if (i !== -1) {
      return { ok: false, content: `refused: invalid task id "${clean(ids[i], 32)}" (must be a single segment matching ${TASK_ID})` }
    }
  }
  // Tournament context: explicit opt-in, active-bounds reconciliation, and
  // budget preflight all run before mkdir. Document-review and LEMMA branches
  // never enter this block.
  const isBareLegacyMassiveProofAlias =
    input.topology === "massive-proof-swarm" &&
    input.tournamentMode === undefined &&
    input.massiveProofOptIn === undefined &&
    input.tournament === undefined &&
    input.tournamentBounds === undefined &&
    request === undefined &&
    input.budgetUsd === undefined &&
    existsSync(run)
  const tournamentContextActive = topology === "massive-proof" && !isBareLegacyMassiveProofAlias
  let validatedTournamentConfig: TournamentConfig | undefined
  let activeManifestConfig: TournamentConfig | undefined
  let tournamentEstimate: BudgetEstimate | undefined
  let existingBudget: number | undefined
  let optInExplicitFlag = false
  let optInExplicitSignal = false
  if (tournamentContextActive) {
    optInExplicitFlag = input.massiveProofOptIn === true
    optInExplicitSignal = typeof request === "string" && hasExplicitMassiveProofOptIn(request)
    const optInGranted = optInExplicitFlag || (input.massiveProofOptIn !== false && optInExplicitSignal)
    if (!optInGranted) {
      return {
        ok: false,
        content:
          "refused: massive-proof requires explicit large-team opt-in (massiveProofOptIn: true or explicit large-team request); use topology 'proof' for standard math/proof runs. Nothing was written.",
        refused: "opt_in_required",
      }
    }
    const cfgRes = resolveAndValidateTournamentConfig(input.tournament, input.tournamentBounds)
    if (!cfgRes.ok) {
      return {
        ok: false,
        content: cfgRes.conflict
          ? `refused: ${cfgRes.error}. Nothing was written.`
          : `refused: invalid tournament config (${cfgRes.error}); nothing was written.`,
        refused: "invalid_tournament_config",
      }
    }
    validatedTournamentConfig = cfgRes.config
    const runExistsOrSymlink = existsSync(run)
    let existingSpent = 0
    if (runExistsOrSymlink) {
      const tourDirCheck = ensureSafeTournamentSubpath(run, tournamentDir(run))
      if (!tourDirCheck.ok) return { ok: false, content: `${tourDirCheck.error}; nothing was written.`, refused: "unsafe_path" }
      const manifestCheck = ensureSafeTournamentSubpath(run, manifestPathOf(run))
      if (!manifestCheck.ok) return { ok: false, content: `${manifestCheck.error}; nothing was written.`, refused: "unsafe_path" }
      const existingCostsRes = readBoundedRunJson<any>(run, join(run, "costs.json"), MAX_MANIFEST_BYTES)
      if (existingCostsRes.status === "error") return { ok: false, content: `${existingCostsRes.error}; nothing was written.`, refused: "unsafe_path" }
      if (existingCostsRes.status === "ok") {
        existingSpent = Number(existingCostsRes.value?.spentUsd) || 0
        if (typeof existingCostsRes.value?.budgetUsd === "number") existingBudget = existingCostsRes.value.budgetUsd
      }
      const activeManifest = readTournamentManifest(run)
      if (activeManifest.status === "error") return { ok: false, content: `${activeManifest.error}; nothing was written.`, refused: "unsafe_path" }
      if (activeManifest.status === "ok") activeManifestConfig = activeManifest.manifest.config
    }
    if (activeManifestConfig) {
      const configOmitted = input.tournament === undefined && input.tournamentBounds === undefined
      if (configOmitted) {
        validatedTournamentConfig = activeManifestConfig
      } else if (!tournamentConfigsEqual(validatedTournamentConfig, activeManifestConfig)) {
        return {
          ok: false,
          content:
            "refused: a re-plan cannot change the bounds of an active tournament; omit tournament/tournamentBounds to retain the existing config. Nothing was written.",
          refused: "invalid_tournament_config",
        }
      }
    }
    const rawBudget = input.budgetUsd === undefined ? (existingBudget ?? 20) : input.budgetUsd
    if (typeof rawBudget !== "number" || !Number.isFinite(rawBudget) || rawBudget <= 0) {
      return { ok: false, content: "refused: massive-proof requires a positive budgetUsd (> 0); nothing was written.", refused: "budget_preflight" }
    }
    tournamentEstimate = estimateTournamentBudget(validatedTournamentConfig, existingSpent, rawBudget)
    if (!tournamentEstimate.sufficient) {
      return {
        ok: false,
        content: `refused: ${tournamentEstimate.refusalReason} (remaining $${tournamentEstimate.remainingUsd.toFixed(2)}, minimum 1-iteration estimate $${tournamentEstimate.estimatedMinUsd.toFixed(2)}, worst-case $${tournamentEstimate.estimatedMaxUsd.toFixed(2)}). Increase budgetUsd or reduce tournament bounds; nothing was written.`,
        refused: "budget_preflight",
      }
    }
  }
  // ORIGINAL_REQUEST.md is write-once. No exists/read pre-check here: the `wx`
  // write in writeOriginalRequest is the atomic authority (CodeQL #19).
  const originalRequestFile = join(run, "ORIGINAL_REQUEST.md")
  // 3.4: a run starts from an approved spec (`<run>/prompt_draft.md`). The
  // gate runs BEFORE mkdir, so a refusal leaves no run dir and no plan files
  // behind. `skipInterview` is the explicit, recorded bypass.
  const specFile = join(run, "prompt_draft.md")
  // Root-aware read: a symlinked (including dangling) or non-regular spec is
  // refused, and on Linux a raced intermediate directory cannot leak bytes.
  const specRead = readBoundedRunFile(run, specFile, MAX_RUN_FILE_BYTES)
  const specText = specRead.status === "ok" ? specRead.text.trim() : ""
  const hasSpec = specText.length > 0
  const specGate: "satisfied" | "bypassed" | "not_required" | undefined =
    input.requireSpec === false ? "not_required" : hasSpec ? "satisfied" : input.skipInterview === true ? "bypassed" : undefined
  if (!specGate) {
    return {
      ok: false,
      content: `refused: no spec found for this run (expected ${specFile}). Run /teamwork-craft to produce one, or re-call with skipInterview: true to proceed without an approved prompt.`,
    }
  }
  // Input preflight. Runs before mkdir so a refusal writes NOTHING (no run
  // dir, no ORIGINAL_REQUEST.md, no plan). Only a narrow block list can
  // refuse: explicit inputs, URLs, and absolute/`~`/`file:` paths. Relative
  // path-like tokens are advisory and can never block.
  const explicitInputs = (Array.isArray(input.inputs) ? input.inputs : []).filter(
    (v: unknown): v is string => typeof v === "string",
  )
  let preflight: { status: "READY" | "MISSING" | "OUTAGE" | "SKIPPED"; bypassed?: boolean } = { status: "SKIPPED" }
  let preflightNote: string | undefined
  let preflightLine = "Preflight: SKIPPED (no request or explicit inputs)."
  const preflightRequest = input.preflightRequest !== undefined ? input.preflightRequest : request
  if (preflightRequest !== undefined || explicitInputs.length > 0) {
    const items = await checkInventory(extractInventory(preflightRequest, explicitInputs), input.checkUrls === true)
    const summary = summarizePreflight(items)
    const blockingProblems = items.filter(
      (i) => i.blocking && (i.status === "MISSING" || i.status === "OUTAGE"),
    )
    if (blockingProblems.length > 0 && input.allowMissingInputs !== true) {
      return {
        ok: false,
        content: [
          `refused: ${blockingProblems.length} required input(s) are missing or unreachable; nothing was written.`,
          ...blockingProblems.map((i) => `  ${i.status} ${i.value}${i.detail ? ` (${i.detail})` : ""}`),
          "Fix the paths/URLs, or re-call with allowMissingInputs: true to proceed and record the bypass.",
        ].join("\n"),
      }
    }
    if (blockingProblems.length > 0) {
      preflight = { status: summary.status, bypassed: true }
      preflightNote = `preflight bypassed: ${summary.status} (${blockingProblems.length} item${blockingProblems.length === 1 ? "" : "s"})`
    } else {
      preflight = { status: summary.status, bypassed: false }
    }
    const advisory = items.filter((i) => i.advisory && i.status === "MISSING").map((i) => i.value)
    preflightLine = `Preflight: ${summary.status}${preflight.bypassed ? " (bypassed: allowMissingInputs)" : ""} (${summary.total} item(s); ${summary.unchecked} unchecked)${advisory.length ? `; ${advisory.length} advisory path missing (non-blocking): ${advisory.join(", ")}` : ""}.`
  }

  if (context?.signal?.aborted) {
    return { ok: false, content: "refused: request aborted before run creation; nothing was written.", aborted: true }
  }
  if (beforeMkdir) {
    const preErr = await beforeMkdir({ sessionId, run, integrityMode, topology })
    if (preErr) return { ok: false, content: preErr }
  }

  mkdirSync(run, { recursive: true })
  // The request record goes first: it is the artifact the auditor and the
  // final gate read the integrity mode from.
  if (request !== undefined) {
    const refused = writeOriginalRequest(run, request, integrityMode, sessionId)
    if (refused) return { ok: false, content: refused }
  }
  if (requirementsBaseline) {
    const refused = persistRequirementsBaseline(run, requirementsBaseline)
    if (refused) return { ok: false, content: refused }
  }
  // A victory audit is required unless the plan explicitly records a skip.
  // Record the mode in BOTH plan.dag.json and state.json so a later re-plan or
  // hand edit cannot silently drop the gate.
  const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
  const rootSessionId = callSession ?? sessionId
  const tasks = (input.tasks || []).map((t: any) => ({
    id: clean(t.id, 64),
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((d: any) => clean(d, 64)) : [],
    requirements: Array.isArray(t.requirements) ? t.requirements.map((r: any) => clean(r, 120)) : [],
    agent: clean(t.agent || "team/worker", 64),
    status: "pending",
    round: 0,
    maxRounds: Number.isFinite(t.maxRounds) ? t.maxRounds : 4,
  }))
  const routingReason = typeof input.routingReason === "string" ? clean(input.routingReason, 200).trim() : ""
  const planObject = {
    sessionId,
    rootSessionId,
    topology,
    integrityMode,
    verification: verificationMode,
    victoryAudit: victoryAuditMode,
    victoryAuditSource,
    ...(requirementsBaseline ? { requirementsSource: requirementsBaseline.source, requirementsCount: requirementsBaseline.items.length } : {}),
    preflight,
    ...(isLemma ? { lemmaMode: true, route: "lemma", lemmaBounds } : rawRoute ? { route: rawRoute } : {}),
    ...(validatedTournamentConfig && tournamentEstimate
      ? { tournament: { config: validatedTournamentConfig, estimate: tournamentEstimate } }
      : {}),
    tasks,
    ...(routingReason ? { routingReason } : {}),
    ...(allowUnsignedLegacy ? { allowUnsignedLegacy: true } : {}),
  }
  writeJson(join(run, "plan.dag.json"), planObject)
  if (!existsSync(join(run, "state.json"))) {
    writeJson(join(run, "state.json"), {
      version: 1,
      sessionId,
      rootSessionId,
      integrityMode,
      verification: verificationMode,
      victoryAudit: victoryAuditMode,
      ...(allowUnsignedLegacy ? { allowUnsignedLegacy: true } : {}),
      ...(isLemma ? { lemmaMode: true, route: "lemma" } : {}),
      phase: "DISPATCH",
      tasks: nullMap(Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }]))),
      updatedAt: new Date().toISOString(),
    })
  } else {
    // A re-plan keeps the run's checkpoint but must still carry the mode
    // the caller chose (defaults to development when omitted).
    const stateFile = join(run, "state.json")
    const state = readJson<any>(run, stateFile, undefined)
    if (
      state &&
      (state.integrityMode !== integrityMode ||
        state.verification !== verificationMode ||
        state.victoryAudit !== victoryAuditMode ||
        state.rootSessionId !== rootSessionId ||
        (allowUnsignedLegacy && state.allowUnsignedLegacy !== true) ||
        (isLemma && !state.lemmaMode))
    ) {
      state.integrityMode = integrityMode
      state.verification = verificationMode
      state.victoryAudit = victoryAuditMode
      state.rootSessionId = rootSessionId
      if (allowUnsignedLegacy) state.allowUnsignedLegacy = true
      if (isLemma) {
        state.lemmaMode = true
        state.route = "lemma"
      }
      state.updatedAt = new Date().toISOString()
      writeJson(stateFile, state)
    }
  }
  if (isLemma && lemmaBounds && lemmaProbe) {
    const lemmaInit = initLemmaArtifacts(run, sessionId, lemmaBounds, lemmaProbe, lemmaPolicy ?? null)
    if (lemmaInit.error) {
      return { ok: false, content: lemmaInit.error }
    }
  }
  // Signed baseline. The manifest is written last, after requirements, plan,
  // state and the LEMMA policy are on disk, so its hashes describe exactly
  // what a later gate re-reads.
  const baselineRequestHash = originalRequestHash(run)
  const baselineRequirementsHash = currentRequirementsHash(run)
  const baselinePlanHash = planHashOf(planObject)
  const baselineLemmaPolicyHash = lemmaPolicyHashOf(run)
  if (existingManifest) {
    const drift = manifestDrift(existingManifest, {
      integrityMode,
      verification: verificationMode,
      victoryAudit: victoryAuditMode,
      requestHash: baselineRequestHash,
      requirementsHash: baselineRequirementsHash,
      planHash: baselinePlanHash,
      lemmaPolicyHash: baselineLemmaPolicyHash,
    })
    if (drift.length > 0) {
      return {
        ok: false,
        content: `refused: [AUTH_STALE] a re-plan must preserve the signed baseline; ${drift.join("; ")}. Nothing was written.`,
        refused: "AUTH_STALE",
      }
    }
  }
  const signedRun = !!existingManifest || !allowUnsignedLegacy
  if (signedRun) {
    if (!auth || !authReady.ok) {
      return {
        ok: false,
        content: `refused: ${authFailureText(authReady.ok ? { code: "AUTH_UNAVAILABLE", message: "no authenticity context" } : authReady.failure)}; this plan would be unsigned. Nothing was written.`,
        refused: "AUTH_UNAVAILABLE",
      }
    }
    try {
      const manifest: RunManifest = {
        version: RUN_MANIFEST_VERSION,
        sessionId,
        rootSessionId,
        integrityMode,
        verification: verificationMode,
        victoryAudit: victoryAuditMode,
        requestHash: baselineRequestHash,
        requirementsHash: baselineRequirementsHash,
        planHash: baselinePlanHash,
        lemmaPolicyHash: baselineLemmaPolicyHash,
        runKeyId: authReady.keyId,
        createdAt: new Date().toISOString(),
      }
      const signed = await auth.signRunArtifact(sessionId, RUN_MANIFEST, manifest)
      writeJsonSafe(run, runManifestFile(run), signed)
    } catch (err: any) {
      const failure = err?.failure as AuthFailure | undefined
      return {
        ok: false,
        content: `refused: could not sign ${RUN_MANIFEST} (${failure ? failure.code : "signing failed"}: ${clean(err?.message, 160)}); the run is not complete.`,
        refused: failure?.code ?? "AUTH_UNAVAILABLE",
      }
    }
  }
  // Use ?? (nullish coalescing) so budgetUsd: 0 is respected as "no budget"
  const budget = input.budgetUsd ?? (tournamentContextActive && existingBudget !== undefined ? existingBudget : 20)
  const costsFile = join(run, "costs.json")
  // Same lock as the cost tool so a re-plan cannot race a concurrent cost call.
  await withFileLock(costsFile, async () => {
    const existing = readJson<any>(run, costsFile, undefined)
    if (!existing) {
      writeJson(costsFile, {
        sessionId,
        rootSessionIds: callSession ? [callSession] : [],
        budgetUsd: budget,
        budgetSource: input.budgetSource ? clean(input.budgetSource, 32) : "default",
        spentUsd: 0,
        byTask: nullMap(),
        byTaskTokens: nullMap(),
        updatedAt: new Date().toISOString(),
      })
    } else {
      existing.byTaskTokens = nullMap(existing.byTaskTokens)
      existing.byTask = nullMap(existing.byTask)
      if (callSession) {
        const currentRoots = Array.isArray(existing.rootSessionIds) ? existing.rootSessionIds : []
        if (!currentRoots.includes(callSession)) {
          existing.rootSessionIds = [...currentRoots, callSession]
        }
      }
      if (
        existing.budgetUsd !== budget ||
        (input.budgetSource && existing.budgetSource !== clean(input.budgetSource, 32))
      ) {
        // Update the budget/source but PRESERVE accumulated spend and
        // per-task buckets (a re-plan must not wipe the run's measured cost).
        existing.budgetUsd = budget
        if (input.budgetSource) existing.budgetSource = clean(input.budgetSource, 32)
      }
      existing.updatedAt = new Date().toISOString()
      writeJson(costsFile, existing)
    }
    // Establish the native cost baseline for the calling session, preserving
    // any baselines already recorded for other sessions (merge, don't clobber).
    const now = new Date().toISOString()
    const snaps = readSnapshots(run, join(run, "snapshots.json")) ?? { sessionId, rootSessionIds: [], bySession: {} }
    snaps.sessionId = sessionId
    if (!snaps.rootSessionIds) snaps.rootSessionIds = []
    if (callSession && !snaps.rootSessionIds.includes(callSession)) {
      snaps.rootSessionIds.push(callSession)
    }
    const usage = await readSessionUsage(ctx, callSession)
    if (callSession && usage && !snaps.bySession[callSession]) {
      snaps.bySession[callSession] = { lastCost: usage.cost, lastTokens: usage.tokens, timestamp: now }
    }
    writeSnapshots(join(run, "snapshots.json"), snaps)
  })
  touch(join(run, "pitfalls.md"), "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
  if (validatedTournamentConfig && tournamentEstimate) {
    try {
      await withFileLock(manifestPathOf(run), async () => {
        const current = readTournamentManifest(run)
        if (current.status === "absent") {
          initTournamentManifest({
            run,
            sessionId,
            config: validatedTournamentConfig!,
            budgetEstimate: tournamentEstimate!,
            explicitFlag: optInExplicitFlag,
            explicitRequestSignal: optInExplicitSignal,
          })
        } else if (current.status === "error") {
          throw new Error(current.error)
        } else if (!tournamentConfigsEqual(validatedTournamentConfig!, current.manifest.config)) {
          throw new Error("refused: active tournament bounds cannot be changed by a re-plan.")
        }
      })
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : String(err)
      return { ok: false, content: msg.startsWith("refused:") ? msg : `refused: ${msg}` }
    }
  }
  await appendEvent(run, { event: "run_created", sessionId, taskId: null, from: null, to: "pending", round: 0, phase: "DAG_BUILD", specGate, ...(specGate === "satisfied" ? { specPath: specFile } : {}), ...(preflightNote ? { note: preflightNote } : {}) })
  // Shared continuity briefing: written after plan/state/costs, never fatal.
  await refreshBriefingSafe(run)
  // Backstop: if console credits apply but the budget wasn't derived from
  // them, warn (advisory — the sentinel is instructed to run the preflight).
  let creditWarning = ""
  if (input.budgetSource !== "credits" && (await isConsoleMcpConnected(ctx)) && (await usesOpencodeModel(ctx, context?.sessionID))) {
    creditWarning = "\n⚠ opencode/ models + opencode_console connected — run teamwork_budget and derive budgetUsd from credits before dispatching."
  }
  return {
    ok: true,
    sessionId,
    run,
    tasks,
    topology,
    integrityMode,
    content: `Planned ${tasks.length} task(s).\nSESSION_ID: ${sessionId}\nRun dir: ${run}\nBudget: $${budget} (source: ${input.budgetSource ? clean(input.budgetSource, 32) : "default"})\nplan.dag.json + state.json + costs.json written.\n${preflightLine}\nIntegrity mode: ${integrityMode}${request !== undefined ? ` (request recorded in ${originalRequestFile})` : ""}.\nVerification: ${verificationMode}${verificationMode === "strict" ? " (one falsifier challenge + one security-auditor audit per task)" : ""}.\nVictory audit: ${victoryAuditMode}${victoryAuditSource === "caller" ? " (explicit)" : ""}${requirementsBaseline ? `; requirements baseline ${requirementsBaseline.items.length} item(s) from ${requirementsBaseline.source} (requirements.json)` : "; no requirements baseline"}.\nAuthenticity: ${signedRun ? `signed baseline (run.manifest.json; key ${clean(authReady.ok ? authReady.keyId : "unknown", 64)})` : "UNSIGNED LEGACY (allowUnsignedLegacy: true; final_verify/next require the recorded bypass)"}.${specGate === "bypassed" ? "\n⚠ Spec gate bypassed (skipInterview: true): planned without an approved prompt_draft.md." : ""}${preflight.bypassed ? `\n⚠ Input preflight bypassed (allowMissingInputs: true): ${preflight.status}.` : ""}${creditWarning}`,
  }
}

export async function registerTeamworkTools(ctx: any, root: string) {
  if (!ctx?.tool?.transform) return
  // Plugin-global KV storage (host-provided). Tests inject a Map-backed shim;
  // `OPENCODE_TEAMWORK_HMAC_KEY` is the CI/offline override. Missing both is
  // AUTH_UNAVAILABLE: signed plans then refuse unless allowUnsignedLegacy is
  // explicitly recorded.
  const auth = createAuthContext(ctx?.storage, process.env)
  await ctx.tool.transform((editor: any) => {
    editor.namespace({
      name: "teamwork",
      description: "Deterministic Teamwork run state: plan, status, resume, cost, pitfalls.",
    })

    editor.add({
      name: "plan",
      description:
        "Create a Teamwork run directory and write plan.dag.json + state.json + costs.json. Returns the run path and the (validated) session id. Call this once before dispatching workers.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Reuse an existing session id; omit to create one." },
          topology: { type: "string", description: "small-focused | iterative-coding | distributed-coding | proof | massive-proof | document-review. Legacy aliases accepted and normalised: large-swarm → distributed-coding, doc-review → document-review, long-proof → proof, massive-proof-swarm → massive-proof." },
          routingReason: { type: "string", description: "Optional. Why this topology was chosen; persisted in plan.dag.json when provided." },
          request: { type: "string", description: "The verbatim text this run was routed on (max 20000 chars); recorded once in ORIGINAL_REQUEST.md. Sentinel must always pass this for LEMMA and general runs; a second plan into the same run with a non-empty request file is refused." },
          integrityMode: { type: "string", description: "development | demo | benchmark. Default development. Recorded in ORIGINAL_REQUEST.md, state.json and plan.dag.json; the security auditor and final gate read it from ORIGINAL_REQUEST.md." },
          verification: {
            type: "string",
            description:
              "standard | strict. Default standard (unchanged verifier-only completion). Strict adds exactly one team/falsifier challenge and one team/security-auditor audit per task; both must be recorded with teamwork_wave_record before final verification can PASS. Persisted in plan.dag.json and state.json; a re-plan may not change it.",
          },
          requirements: {
            type: "array",
            description: "Optional requirements baseline (max 50). Ids are safe tokens; text is non-empty and <= 2,000 chars. Duplicates are refused. Persisted to <run>/requirements.json and checked item-by-item by the independent victory audit.",
            items: {
              type: "object",
              properties: { id: { type: "string" }, text: { type: "string" } },
              required: ["id", "text"],
              additionalProperties: false,
            },
          },
          victoryAudit: {
            type: "string",
            description: "required | skip. Default required when a request or requirements baseline exists. A skip is recorded in plan.dag.json/state.json and final_verify then records \"SKIPPED (explicit)\".",
          },
          budgetUsd: { type: "number", description: "Run budget in USD. When using opencode/ models + opencode_console, derive this from credits (full or partial, per the user's choice)." },
          budgetSource: { type: "string", description: "Where the budget came from: credits | default | manual." },
          requireSpec: { type: "boolean", description: "Default true. When true, the run must have a non-empty prompt_draft.md (the approved spec) before the plan is written; see skipInterview for the explicit bypass." },
          skipInterview: { type: "boolean", description: "Default false. Explicit bypass of the spec gate: plan without an approved prompt_draft.md. Recorded in events.jsonl as specGate: bypassed." },
          inputs: {
            type: "array",
            items: { type: "string" },
            description: "Optional. Files/URLs this run depends on, checked before anything is written. Every entry is blocking, including relative paths (resolved from the engine's cwd).",
          },
          checkUrls: {
            type: "boolean",
            description: "Default false. When false, URLs are recorded UNCHECKED. When true, each URL gets a HEAD request with a 3 s timeout; failures refuse the plan.",
          },
          allowMissingInputs: {
            type: "boolean",
            description: "Default false. Explicit bypass: plan even when a blocking input is MISSING/OUTAGE. The bypass is recorded in plan.dag.json and events.jsonl.",
          },
          allowUnsignedLegacy: {
            type: "boolean",
            description:
              "Default false. Explicit opt-out of the signed baseline: create/keep an unsigned legacy run. New runs should not use it. Refused with integrityMode: benchmark. final_verify/next still require an explicit allowUnsignedLegacy bypass before completing an unsigned run, and record it as an event.",
          },
          lemmaMode: {
            type: "boolean",
            description: "Optional. True only for explicit Lean 4 / LEMMA formal-proof runs (requires topology: 'proof' and Lean 4 + the LEAP CLI `leap`, or legacy `leap-tools`, on PATH).",
          },
          route: {
            type: "string",
            description: "Optional. Route label (e.g. 'lemma', 'document-review', 'proof', 'massive-proof', 'general').",
          },
          lemmaBounds: {
            type: "object",
            description: "Optional bounds for LEMMA decomposition tree: maxDepth (1..3), maxWidth (1..4), maxNodes (1..24), maxRetries (1..4).",
            properties: {
              maxDepth: { type: "number" },
              maxWidth: { type: "number" },
              maxNodes: { type: "number" },
              maxRetries: { type: "number" },
            },
            additionalProperties: false,
          },
          lemmaPolicy: {
            type: "object",
            description:
              "Optional plan-time LEMMA axiom policy. allowedAxioms (max 32 safe Lean axiom names; sorryAx always rejected) extends the standard axioms (Classical.choice, propext, Quot.sound) for the whole run. Persisted in lemma/manifest.json; verification reads it from disk and refuses caller-supplied overrides. A re-plan must match the persisted policy.",
            properties: {
              allowedAxioms: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
          massiveProofOptIn: {
            type: "boolean",
            description: "Explicit opt-in required for massive-proof tournaments when tournament context is active.",
          },
          tournamentMode: {
            type: "boolean",
            description: "Enable bounded massive-proof tournament initialization under tournament/manifest.json.",
          },
          tournament: {
            type: "object",
            additionalProperties: true,
            description: "Optional bounded tournament config (levels, branchingFactor/width, maxCandidates, maxIterations, unitCostUsd, passScoreThreshold).",
          },
          tournamentBounds: {
            type: "object",
            additionalProperties: true,
            description: "Alias for bounded tournament configuration.",
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
                requirements: { type: "array", items: { type: "string" } },
                agent: { type: "string" },
                maxRounds: { type: "number" },
              },
              required: ["id"],
              additionalProperties: true,
            },
          },
        },
        required: ["topology", "tasks"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const res = await createPlanRun(ctx, root, input, context, undefined, auth)
        return { content: res.content, ...(res.ok ? {} : { ...(res.refused ? { refused: res.refused } : {}), ...(res.aborted ? { aborted: true } : {}) }) }
      },
    })

    editor.add({
      name: "route",
      description:
        "Deterministic route classifier. Evaluates Document Review (Priority 1, checked BEFORE Lean/LEMMA, massive-proof, and proof) with explicit supplied-document + critique-intent + negative-trigger guards, then Priorities 2-7. Read-only: writes nothing.",
      input: {
        type: "object",
        properties: {
          request: { type: "string", description: "User request text to route." },
          document: {
            type: "object",
            properties: {
              path: { type: "string" },
              url: { type: "string" },
              content: { type: "string" },
              format: { type: "string" },
            },
            additionalProperties: false,
          },
          inputs: { type: "array", items: { type: "string" } },
          checkPaths: { type: "boolean", description: "Default true. Verify explicit document paths in request exist as regular files inside root." },
        },
        additionalProperties: false,
      },
      execute: (input: any) => {
        // Document Review is the authority for Priority 1; LEMMA owns the
        // explicit Lean 4 gate for Priority 2; the tournament classifier owns
        // the explicit massive-proof opt-in for Priority 3. All three features
        // return route/topology/lemmaMode so any caller's tests can assert.
        const doc = classifyDocumentRoute(input || {}, root)
        const request = String(input?.request ?? "")
        const lemma = classifyLemmaRoute(
          {
            request,
            inputs: Array.isArray(input?.inputs) ? input.inputs.map(String) : undefined,
            hasDocument: false,
          },
          root,
        )
        const tournament = classifyTournamentRoute(
          {
            request,
            inputs: Array.isArray(input?.inputs) ? input.inputs.map(String) : undefined,
            hasDocument: false,
          },
          root,
        )
        let result: any
        if (doc.topology === "document-review") {
          result = {
            ...lemma,
            ...tournament,
            topology: "document-review",
            route: "document-review",
            lemmaMode: false,
            massiveProofOptIn: false,
            reason: doc.routingReason,
            routingReason: doc.routingReason,
            documentDetected: true,
          }
        } else if (lemma.lemmaMode) {
          result = {
            ...tournament,
            ...lemma,
            topology: "proof",
            route: "lemma",
            lemmaMode: true,
            massiveProofOptIn: false,
            documentDetected: doc.documentDetected,
            routingReason: lemma.reason,
          }
        } else if (tournament.topology === "massive-proof") {
          result = {
            ...lemma,
            ...tournament,
            topology: "massive-proof",
            route: "massive-proof",
            massiveProofOptIn: true,
            lemmaMode: false,
            documentDetected: doc.documentDetected,
            reason: tournament.reason,
            routingReason: tournament.routingReason,
          }
        } else if (
          doc.topology === "proof" &&
          lemma.route === "general" &&
          /(?:\b(?:theorem|lemma)\s+[A-Za-z_]|:=\s*by\b|\bimport\s+Mathlib\b|\.lean\b)/i.test(request)
        ) {
          // Bare `.lean`/Lean syntax without an explicit opt-in must not become
          // a proof run; the LEMMA classifier owns this negative-gate decision.
          result = {
            ...tournament,
            ...lemma,
            topology: "distributed-coding",
            route: "general",
            lemmaMode: false,
            documentDetected: doc.documentDetected,
            massiveProofOptIn: false,
            routingReason: lemma.reason,
          }
        } else {
          // The tournament classifier is the full non-document router (proof,
          // small-focused, iterative, distributed) and owns the massive-proof
          // opt-in decision. Document Review is owned by the document classifier,
          // whose negative-trigger guards are stricter. Either classifier can
          // surface a proof route; non-distributed coding routes prefer the
          // document classifier's more specific negative-trigger handling.
          let fallbackTopology = tournament.topology
          if (doc.topology === "massive-proof") fallbackTopology = tournament.topology
          else if (tournament.topology === "document-review" || tournament.topology === "massive-proof") fallbackTopology = doc.topology
          else if (doc.topology === "proof" || tournament.topology === "proof") fallbackTopology = "proof"
          else if (doc.topology !== "distributed-coding") fallbackTopology = doc.topology
          result = {
            ...lemma,
            ...tournament,
            topology: fallbackTopology,
            route: fallbackTopology === "distributed-coding" ? "general" : fallbackTopology,
            lemmaMode: false,
            massiveProofOptIn: false,
            reason: tournament.reason,
            routingReason: tournament.routingReason,
            documentDetected: doc.documentDetected,
          }
        }
        return {
          content: `Route: ${result.topology}\nDocument detected: ${result.documentDetected}\nReason: ${result.routingReason}`,
          ...result,
        }
      },
    })

    editor.add({
      name: "document_triage",
      description:
        "Ingest and partition a supplied Markdown/LaTeX/PDF/text/URL/inline document for the document-review topology. Validates bounds, path containment, and PDF headers BEFORE creating any run directory, then writes plan.dag.json (seg-01..seg-0K + doc-synthesis) and document-review/{manifest.json,DOCUMENT_TEXT_MAP.md,ANALYSIS_PARTITION.md}.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          request: { type: "string" },
          routingReason: { type: "string" },
          document: {
            type: "object",
            properties: {
              path: { type: "string" },
              url: { type: "string" },
              content: { type: "string" },
              format: { type: "string" },
            },
            additionalProperties: false,
          },
          integrityMode: { type: "string" },
          skipInterview: { type: "boolean" },
          requireSpec: { type: "boolean" },
          budgetUsd: { type: "number" },
          budgetSource: { type: "string" },
          maxSegments: { type: "number" },
          reviewTreeShape: { type: "array", items: { type: "number" } },
          synthTreeShape: { type: "array", items: { type: "number" } },
          fetchUrl: { type: "boolean" },
          checkUrls: { type: "boolean" },
          allowMissingInputs: { type: "boolean" },
          inputs: { type: "array", items: { type: "string" } },
        },
        required: ["document"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const sessionId = input?.sessionId || newSessionId()
        const resolvedSession = resolveRun(root, sessionId)
        if (resolvedSession.error) return { content: resolvedSession.error }

        const boundsRes = validateTreeBounds({
          maxSegments: input?.maxSegments,
          reviewTreeShape: input?.reviewTreeShape,
          synthTreeShape: input?.synthTreeShape,
        })
        if (!boundsRes.ok) return { content: boundsRes.error }
        const bounds = boundsRes.bounds

        const readRes = await resolveAndReadDocument(root, input?.document, {
          fetchUrl: input?.fetchUrl === true,
        })
        if (!readRes.ok) return { content: readRes.error }

        const ingested = ingestDocument(readRes.doc.bufferOrText, readRes.doc.format)
        if (!ingested.ok) return { content: ingested.error }

        const segments = segmentDocument(ingested.text, bounds.maxSegments)
        const perSegBudget = Math.max(
          1000,
          Math.min(MAX_SEGMENT_CHARS, Math.floor((MAX_TEXT_MAP_CHARS - 2048) / Math.max(1, segments.length)) - 256),
        )
        for (const seg of segments) {
          if (seg.content.length > perSegBudget) {
            seg.content = cleanBlock(seg.content, perSegBudget)
            seg.charCount = seg.content.length
            seg.sha256 = createHash("sha256").update(seg.content, "utf8").digest("hex")
          }
        }
        const segTasks = segments.map((s) => ({
          id: s.id,
          dependsOn: [],
          agent: "team/segment-reviewer",
          requirements: [`Review segment ${s.id}: ${s.title}`],
          maxRounds: 2,
        }))
        const docSynthesisTask = {
          id: "doc-synthesis",
          dependsOn: segments.map((s) => s.id),
          agent: "team/synthesizer",
          requirements: ["Cross-segment synthesis and final DOCUMENT_REVIEW_REPORT.md"],
          maxRounds: 2,
        }

        const rawRequest = typeof input?.request === "string" ? input.request : undefined
        const splitReq = rawRequest !== undefined ? splitInstructionAndInlineDoc(rawRequest) : undefined
        const recordedRequest =
          rawRequest !== undefined && rawRequest.length > REQUEST_MAX && splitReq?.hasInlineDoc
            ? splitReq.instructionText || rawRequest.slice(0, REQUEST_MAX)
            : rawRequest
        const preflightRequest =
          splitReq?.hasInlineDoc || typeof input?.document?.content === "string"
            ? splitReq?.instructionText ?? ""
            : recordedRequest

        let manifestPath = ""
        let textMapPath = ""
        let partitionPath = ""
        let manifest: any

        const planRes = await createPlanRun(
          ctx,
          root,
          {
            sessionId,
            topology: "document-review",
            routingReason: input?.routingReason || "document-review triage",
            request: recordedRequest,
            preflightRequest,
            integrityMode: input?.integrityMode,
            budgetUsd: input?.budgetUsd,
            budgetSource: input?.budgetSource,
            requireSpec: input?.requireSpec,
            skipInterview: input?.skipInterview,
            inputs: input?.inputs,
            checkUrls: input?.checkUrls,
            allowMissingInputs: input?.allowMissingInputs,
            tasks: [...segTasks, docSynthesisTask],
          },
          context,
          ({ sessionId: planSid, run: planRun }) => {
            const docDir = join(planRun, "document-review")
            manifestPath = join(docDir, "manifest.json")
            textMapPath = join(docDir, "DOCUMENT_TEXT_MAP.md")
            partitionPath = join(docDir, "ANALYSIS_PARTITION.md")
            if (existsSync(planRun)) {
              try {
                ensureSafeRunSubpath(planRun, manifestPath)
                ensureSafeRunSubpath(planRun, textMapPath)
                ensureSafeRunSubpath(planRun, partitionPath)
              } catch (err: any) {
                return `refused: failed to write document-review artifacts (${clean(err?.message, 160)})`
              }
            }
            mkdirSync(planRun, { recursive: true })
            manifest = {
              version: 1,
              sessionId: planSid,
              sourceType: readRes.doc.sourceType,
              sourceLabel: readRes.doc.sourceLabel,
              format: ingested.format,
              byteLength: readRes.doc.byteLength,
              extractionStatus: ingested.extractionStatus,
              ...(ingested.warning ? { warning: clean(ingested.warning, 300) } : {}),
              bounds,
              segments: segments.map((s) => ({
                id: s.id,
                title: s.title,
                charCount: s.charCount,
                sha256: s.sha256,
              })),
              createdAt: new Date().toISOString(),
            }
            const textMapSections = segments
              .map((s) => `## ${s.id}: ${s.title}\n\n- Characters: ${s.charCount}\n- SHA-256: ${s.sha256}\n\n${s.content}`)
              .join("\n\n---\n\n")
            const textMapBody = cleanBlock(
              `# Document Text Map\n\n- Session: ${planSid}\n- Source: ${readRes.doc.sourceLabel} (${readRes.doc.sourceType}, ${ingested.format})\n- Extraction status: ${ingested.extractionStatus}${ingested.warning ? `\n- Warning: ${ingested.warning}` : ""}\n\n${textMapSections}\n`,
              MAX_TEXT_MAP_CHARS,
            )
            const partitionRows = segments
              .map((s) => `| \`${s.id}\` | ${s.title.replaceAll("\\", "\\\\").replaceAll("|", "\\|")} | ${s.charCount} | \`${s.sha256.slice(0, 12)}\` |`)
              .join("\n")
            const partitionBody = cleanBlock(
              `# Analysis Partition\n\n- Session: ${planSid}\n- Segments: ${segments.length} (maxSegments=${bounds.maxSegments})\n- Per-segment RSA tree shape: [${bounds.reviewTreeShape.join(", ")}]\n- Cross-segment synthesis shape: [${bounds.synthTreeShape.join(", ")}]\n\n| Segment | Title | Chars | SHA-256 |\n| --- | --- | ---: | --- |\n${partitionRows}\n\n## Schedule\n\n1. Segment reviews (${segments.map((s) => `\`${s.id}\``).join(", ")}) run in parallel using \`team/segment-reviewer\` bounded by [${bounds.reviewTreeShape.join(", ")}].\n2. \`doc-synthesis\` runs \`team/synthesizer\` bounded by [${bounds.synthTreeShape.join(", ")}] after all segments pass.\n`,
              64_000,
            )
            try {
              writeJsonSafe(planRun, manifestPath, manifest)
              writeTextSafe(planRun, textMapPath, textMapBody.endsWith("\n") ? textMapBody : textMapBody + "\n")
              writeTextSafe(planRun, partitionPath, partitionBody.endsWith("\n") ? partitionBody : partitionBody + "\n")
            } catch (err: any) {
              return `refused: failed to write document-review artifacts (${clean(err?.message, 160)})`
            }
            return undefined
          },
          auth,
        )
        if (!planRes.ok) return { content: planRes.content }

        return {
          content: `${planRes.content}\nDocument triage: ${segments.length} segment(s) (${ingested.extractionStatus}).\nManifest: ${manifestPath}`,
          sessionId: planRes.sessionId,
          runDir: planRes.run,
          topology: "document-review",
          extractionStatus: ingested.extractionStatus,
          ...(ingested.warning ? { warning: ingested.warning } : {}),
          bounds,
          segments: manifest.segments,
          manifestPath,
          textMapPath,
          partitionPath,
        }
      },
    })

    editor.add({
      name: "document_record",
      description:
        "Persist bounded RSA tree node outputs, segment unit-reports, synthesis candidates, or final DOCUMENT_REVIEW_REPORT.md for a document-review run. Enforces SEGMENT_ID allowlist, manifest bounds, symlink refusal, realpath containment, and text sanitisation.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          stage: {
            type: "string",
            description: "segment_analysis | segment_aggregate | segment_report | synthesis_candidate | final_report",
          },
          segmentId: { type: "string" },
          level: { type: "number" },
          index: { type: "number" },
          summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    severity: { type: "string" },
                    claim: { type: "string" },
                    location: { type: "string" },
                    evidence: { type: "string" },
                  },
                  additionalProperties: false,
                },
              ],
            },
          },
          content: { type: "string" },
          verdict: { type: "string" },
        },
        required: ["stage", "summary"],
        additionalProperties: false,
      },
      execute: (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string

        const docDir = join(run, "document-review")
        try {
          refuseSymlink(docDir)
          if (existsSync(docDir)) {
            const st = lstatSync(docDir)
            if (!st.isDirectory()) return { content: "refused: document-review is not a directory" }
            const rel = relative(realpathSync(run), realpathSync(docDir))
            if (!rel || isAbsolute(rel) || rel.startsWith("..")) {
              return { content: "refused: document-review escapes run directory" }
            }
          }
        } catch (err: any) {
          return { content: `refused: ${clean(err?.message, 160)}` }
        }

        const manifestPath = join(docDir, "manifest.json")
        const manifestRes = readRegularJson<any>(run, manifestPath)
        if (!manifestRes.ok) {
          return {
            content:
              manifestRes.reason === "symlink"
                ? "refused: document-review/manifest.json is a symlink"
                : "refused: document-review/manifest.json missing or invalid — call teamwork_document_triage first",
          }
        }
        const manifest = manifestRes.data
        const boundsRes = validateTreeBounds(manifest?.bounds)
        if (!boundsRes.ok) {
          return { content: `refused: document-review/manifest.json has invalid bounds (${boundsRes.error})` }
        }
        const reviewShape: number[] = boundsRes.bounds.reviewTreeShape
        const synthShape: number[] = boundsRes.bounds.synthTreeShape
        const knownSegs = new Set<string>(
          Array.isArray(manifest?.segments) ? manifest.segments.map((s: any) => String(s?.id || "")) : [],
        )

        const stage = clean(input?.stage, 32).trim()
        const VALID_STAGES = new Set([
          "segment_analysis",
          "segment_aggregate",
          "segment_report",
          "synthesis_candidate",
          "final_report",
        ])
        if (!VALID_STAGES.has(stage)) {
          return {
            content: `refused: invalid stage "${stage}" (accepted: ${Array.from(VALID_STAGES).join(", ")})`,
          }
        }

        const summary = clean(input?.summary, 500).trim()
        if (!summary) return { content: "refused: summary must be non-empty" }
        const verdict = input?.verdict !== undefined ? clean(input.verdict, 64).trim() : undefined
        const bodyContent = input?.content !== undefined ? cleanBlock(input.content, 64_000) : ""
        const rawFindings = Array.isArray(input?.findings) ? input.findings.slice(0, MAX_FINDINGS) : []
        const findings = rawFindings.map((f: any) => {
          if (typeof f === "string") return cleanBlock(f, 500)
          return {
            ...(f?.id ? { id: clean(f.id, 32) } : {}),
            ...(f?.severity ? { severity: clean(f.severity, 32) } : {}),
            ...(f?.claim ? { claim: cleanBlock(f.claim, 500) } : {}),
            ...(f?.location ? { location: clean(f.location, 120) } : {}),
            ...(f?.evidence ? { evidence: cleanBlock(f.evidence, 500) } : {}),
          }
        })

        const formatFindingsMd = () => {
          if (!findings.length) return ""
          const lines = findings.map((f: any) => {
            if (typeof f === "string") return `- ${f}`
            const tag = [f.id, f.severity, f.location].filter(Boolean).join(" | ")
            return `- ${tag ? `**[${tag}]** ` : ""}${f.claim || ""}${f.evidence ? ` — _Evidence:_ ${f.evidence}` : ""}`
          })
          return `\n\n## Findings\n\n${lines.join("\n")}`
        }

        if (stage === "segment_analysis" || stage === "segment_aggregate" || stage === "segment_report") {
          const rawSegId = input?.segmentId
          if (!isSafeSegmentId(rawSegId)) {
            return {
              content: `refused: invalid segmentId "${clean(rawSegId, 32)}" (must match ${SEGMENT_ID})`,
            }
          }
          if (!knownSegs.has(rawSegId)) {
            return { content: `refused: unknown segmentId "${rawSegId}" (not in manifest.json)` }
          }
          const segDir = join(docDir, "segments", rawSegId)

          if (stage === "segment_analysis" || stage === "segment_aggregate") {
            const level = input?.level
            const index = input?.index
            if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level >= reviewShape.length) {
              return {
                content: `refused: level ${clean(level, 16)} out of bounds for reviewTreeShape [${reviewShape.join(", ")}]`,
              }
            }
            if (stage === "segment_analysis" && level !== 0) {
              return { content: "refused: segment_analysis requires level === 0" }
            }
            if (stage === "segment_aggregate" && reviewShape.length > 1 && level < 1) {
              return { content: "refused: segment_aggregate requires level >= 1" }
            }
            if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= reviewShape[level]) {
              return {
                content: `refused: index ${clean(index, 16)} out of bounds for level ${level} width ${reviewShape[level]}`,
              }
            }
            const outFile = join(segDir, `level-${level}-node-${index}.json`)
            try {
              writeJsonSafe(run, outFile, {
                sessionId: basename(run),
                segmentId: rawSegId,
                stage,
                level,
                index,
                summary,
                ...(verdict ? { verdict } : {}),
                findings,
                ...(bodyContent ? { content: bodyContent } : {}),
                recordedAt: new Date().toISOString(),
              })
            } catch (err: any) {
              return { content: `refused: ${clean(err?.message, 160)}` }
            }
            return {
              content: `Recorded ${stage} for ${rawSegId} (level=${level}, index=${index}) at ${outFile}`,
              stage,
              segmentId: rawSegId,
              level,
              index,
              artifactPath: outFile,
            }
          }

          // segment_report -> unit-report.md
          const outFile = join(segDir, "unit-report.md")
          const md = `# Segment Report: ${rawSegId}\n\n- Summary: ${summary}${verdict ? `\n- Verdict: ${verdict}` : ""}${formatFindingsMd()}${bodyContent ? `\n\n## Details\n\n${bodyContent}` : ""}\n`
          try {
            writeTextSafe(run, outFile, md)
          } catch (err: any) {
            return { content: `refused: ${clean(err?.message, 160)}` }
          }
          return {
            content: `Recorded unit-report.md for ${rawSegId} at ${outFile}`,
            stage,
            segmentId: rawSegId,
            artifactPath: outFile,
          }
        }

        if (stage === "synthesis_candidate") {
          const level = input?.level === undefined ? 0 : input.level
          const index = input?.index
          if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level >= synthShape.length) {
            return {
              content: `refused: synthesis level ${clean(level, 16)} out of bounds for synthTreeShape [${synthShape.join(", ")}]`,
            }
          }
          if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= synthShape[level]) {
            return {
              content: `refused: synthesis index ${clean(index, 16)} out of bounds for level ${level} width ${synthShape[level]}`,
            }
          }
          const candName = level === 0 ? `candidate-${index}.md` : `candidate-l${level}-${index}.md`
          const outFile = join(docDir, "synthesis", candName)
          const md = `# Synthesis Candidate ${index}\n\n- Level: ${level}\n- Summary: ${summary}${verdict ? `\n- Verdict: ${verdict}` : ""}${formatFindingsMd()}${bodyContent ? `\n\n## Synthesis\n\n${bodyContent}` : ""}\n`
          try {
            writeTextSafe(run, outFile, md)
          } catch (err: any) {
            return { content: `refused: ${clean(err?.message, 160)}` }
          }
          return {
            content: `Recorded synthesis candidate ${index} at ${outFile}`,
            stage,
            level,
            index,
            artifactPath: outFile,
          }
        }

        // final_report -> DOCUMENT_REVIEW_REPORT.md
        const outFile = join(run, "DOCUMENT_REVIEW_REPORT.md")
        const md = `# Document Review Report\n\n- Session: ${basename(run)}\n- Source: ${clean(manifest?.sourceLabel, 240)}\n- Summary: ${summary}${verdict ? `\n- Verdict: ${verdict}` : ""}${formatFindingsMd()}${bodyContent ? `\n\n## Report\n\n${bodyContent}` : ""}\n`
        try {
          writeTextSafe(run, outFile, md)
        } catch (err: any) {
          return { content: `refused: ${clean(err?.message, 160)}` }
        }
        return {
          content: `Recorded DOCUMENT_REVIEW_REPORT.md at ${outFile}`,
          stage,
          artifactPath: outFile,
        }
      },
    })

    editor.add({
      name: "preflight",
      description:
        "Re-run the input preflight for an existing run: check the files/URLs named by ORIGINAL_REQUEST.md plus any explicit inputs, write <run>/preflight.json, and append a preflight event. Never throws.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Run to check; omit for the latest run." },
          inputs: {
            type: "array",
            items: { type: "string" },
            description: "Optional additional blocking files/URLs to check alongside the recorded request.",
          },
          checkUrls: {
            type: "boolean",
            description: "Default false. When false, URLs are recorded UNCHECKED. When true, each gets a HEAD request with a 3 s timeout.",
          },
        },
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const explicitInputs = (Array.isArray(input?.inputs) ? input.inputs : []).filter(
          (v: unknown): v is string => typeof v === "string",
        )
        const recorded = readRecordedRequest(run)
        const items = await checkInventory(extractInventory(recorded, explicitInputs), input?.checkUrls === true)
        const summary = summarizePreflight(items)
        const integrity = readIntegrityMode(run)
        const checkedAt = new Date().toISOString()
        const report = { checkedAt, integrityMode: integrity.mode, items, summary }
        const file = join(run, "preflight.json")
        refuseSymlink(file)
        writeJson(file, report)

        const problems = items.filter((i) => i.status === "MISSING" || i.status === "OUTAGE")
        const note = problems.length
          ? `preflight ${summary.status}: ${problems.length} item(s) missing or unreachable`
          : undefined
        const state = readJson<any>(run, join(run, "state.json"), {})
        await appendEvent(run, {
          event: "preflight",
          sessionId: basename(run),
          taskId: null,
          from: null,
          to: summary.status,
          round: 0,
          phase: state?.phase ?? null,
          ...(note ? { note } : {}),
        })

        const lines = items.map(
          (i) => `  ${i.status} ${i.value}${i.detail ? ` (${i.detail})` : ""}${i.advisory ? " [advisory]" : ""}`,
        )
        return {
          content: [
            `Preflight ${summary.status}: ${summary.total} item(s), ${summary.blockingMissing} blocking missing, ${summary.outage} outage, ${summary.unchecked} unchecked.`,
            ...lines,
            `Artifact: ${file}`,
          ].join("\n"),
          status: summary.status,
          summary,
          items,
          integrityMode: integrity.mode,
          preflightPath: file,
        }
      },
    })

    editor.add({
      name: "status",
      description: "Read the active (or given) Teamwork run and summarize per-task progress.",
      input: { type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false },
      execute: (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const state = readJson<any>(run, join(run, "state.json"), {})
        const tasks = state.tasks || {}
        const lines = Object.entries(tasks).map(([id, t]: any) => `  ${clean(id, 64)}: ${clean(t?.status, 16)} (round ${Number(t?.round) || 0})`)
        const pass = Object.values(tasks).filter((t: any) => isPassStatus(t?.status)).length
        return { content: `Run ${basename(run)} — phase ${PHASES.has(state.phase) ? state.phase : "UNKNOWN"}\n${pass}/${lines.length} pass\n${lines.join("\n")}` }
      },
    })

    editor.add({
      name: "resume",
      description: "Return the tasks that still need work (pending/running/fail) so a restarted Sentinel can continue where it stopped.",
      input: { type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false },
      execute: (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const state = readJson<any>(run, join(run, "state.json"), {})
        const open = Object.entries(state.tasks || {}).filter(([, t]: any) => !isPassStatus(t?.status))
        if (!open.length) return { content: `Run ${basename(run)} is complete (all tasks pass).` }
        return {
          content: `Resume ${basename(run)} at phase ${PHASES.has(state.phase) ? state.phase : "UNKNOWN"}. Open tasks:\n` + open.map(([id, t]: any) => `  ${clean(id, 64)}: ${clean(t?.status, 16)} round ${Number(t?.round) || 0}`).join("\n"),
        }
      },
    })

    editor.add({
      name: "cost",
      description:
        "Read the run budget and report real spend across the full session tree (Sentinel + all workers/verifiers). Uses OpenCode's native cost and token tracking; falls back to manual addUsd when client/db is unavailable. Warns at 80%.",
      input: { type: "object", properties: { sessionId: { type: "string" }, addUsd: { type: "number" }, taskId: { type: "string" } }, additionalProperties: false },
      execute: async (input: any, context: any) => {
        // SEC-1: the taskId becomes a costs.byTask key. Refuse unsafe ids (e.g.
        // "__proto__", "a/b") before any read or write.
        if (input?.taskId && (typeof input.taskId !== "string" || !isSafeTaskId(input.taskId))) {
          return { content: `refused: invalid task id "${clean(input.taskId, 32)}" (must be a single segment matching ${TASK_ID})` }
        }
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const file = join(run, "costs.json")
        const snapshotsFile = join(run, "snapshots.json")

        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        // Serialise the whole read-modify-write (including the client read) so
        // parallel workers cannot lose each other's attribution.
        return await withFileLock(file, async () => {
          const costs = readJson<any>(run, file, undefined)
          if (!costs || typeof costs !== "object") {
            return { content: `No costs.json for run ${basename(run)} — call teamwork_plan first.` }
          }
          // Null-prototype maps (SEC-1): no bucket name can collide with an inherited member.
          costs.byTask = nullMap(costs.byTask)
          // Additive key: tolerate its absence in costs.json written before it existed.
          costs.byTaskTokens = nullMap(costs.byTaskTokens)
          const budget = costs.budgetUsd ?? 20

          const snaps = readSnapshots(run, snapshotsFile) ?? { sessionId: basename(run), rootSessionIds: [], bySession: {} }
          snaps.sessionId = basename(run)
          if (!snaps.rootSessionIds) snaps.rootSessionIds = []
          if (callSession && !snaps.rootSessionIds.includes(callSession)) {
            snaps.rootSessionIds.push(callSession)
          }
          if (Array.isArray(costs.rootSessionIds)) {
            for (const r of costs.rootSessionIds) {
              if (typeof r === "string" && !snaps.rootSessionIds.includes(r)) {
                snaps.rootSessionIds.push(r)
              }
            }
          }

          const addToBucket = (bucketName: string, amount: number) => {
            if (amount <= 0) return
            costs.byTask[bucketName] = Math.round(((costs.byTask[bucketName] || 0) + amount) * 1e4) / 1e4
          }

          const treeResult = await readSessionTreeUsage(ctx, snaps.rootSessionIds, callSession)
          let source: string

          if (treeResult && treeResult.sessions.length > 0) {
            const now = new Date().toISOString()
            const totalTokens: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

            for (const s of treeResult.sessions) {
              const prev = snaps.bySession[s.id]
              const delta = prev
                ? Math.round((s.cost - prev.lastCost) * 1e4) / 1e4
                : Math.round(s.cost * 1e4) / 1e4

              snaps.bySession[s.id] = {
                lastCost: s.cost,
                lastTokens: s.tokens,
                agent: s.agent,
                timestamp: now,
              }

              let bucket: string
              if (s.id === callSession && input.taskId) {
                bucket = clean(input.taskId, 64)
              } else if (snaps.rootSessionIds.includes(s.id)) {
                bucket = input.taskId ? clean(input.taskId, 64) : "_sentinel"
              } else if (s.agent) {
                bucket = input.taskId ? clean(input.taskId, 64) : clean(s.agent, 64)
              } else {
                bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              }
              if (delta > 0) addToBucket(bucket, delta)
              accumulateTokenDelta(costs, bucket, s.tokens, prev)

              totalTokens.input += s.tokens.input
              totalTokens.output += s.tokens.output
              totalTokens.reasoning += s.tokens.reasoning
              totalTokens.cache.read += s.tokens.cache.read
              totalTokens.cache.write += s.tokens.cache.write
            }

            costs.spentUsd =
              Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
            costs.tokens = totalTokens
            costs.rootSessionIds = snaps.rootSessionIds
            costs.updatedAt = now
            writeJson(file, costs)
            writeSnapshots(snapshotsFile, snaps)
            source = `opencode session tree (${treeResult.sessions.length} sessions, via ${treeResult.source})`
          } else if (callSession) {
            const usage = await readSessionUsage(ctx, callSession)
            if (usage) {
              const now = new Date().toISOString()
              const prev = snaps.bySession[callSession]
              const delta = prev
                ? Math.round((usage.cost - prev.lastCost) * 1e4) / 1e4
                : Math.round(usage.cost * 1e4) / 1e4
              snaps.bySession[callSession] = { lastCost: usage.cost, lastTokens: usage.tokens, timestamp: now }
              const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              if (delta > 0) addToBucket(bucket, delta)
              accumulateTokenDelta(costs, bucket, usage.tokens, prev)
              costs.spentUsd =
                Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
              costs.updatedAt = now
              writeJson(file, costs)
              writeSnapshots(snapshotsFile, snaps)
              source = `opencode session ${callSession}`
            } else if (typeof input?.addUsd === "number" && Number.isFinite(input.addUsd)) {
              if (input.addUsd < 0) return { content: "Error: addUsd must be non-negative" }
              const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              addToBucket(bucket, input.addUsd)
              costs.spentUsd =
                Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
              costs.updatedAt = new Date().toISOString()
              writeJson(file, costs)
              source = "manual (client unavailable)"
            } else {
              source = "manual (client unavailable)"
            }
          } else if (typeof input?.addUsd === "number" && Number.isFinite(input.addUsd)) {
            if (input.addUsd < 0) return { content: "Error: addUsd must be non-negative" }
            const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
            addToBucket(bucket, input.addUsd)
            costs.spentUsd =
              Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
            costs.updatedAt = new Date().toISOString()
            writeJson(file, costs)
            source = "manual (client unavailable)"
          } else {
            source = "manual (client unavailable)"
          }

          const pct = budget ? Math.floor((costs.spentUsd / budget) * 100) : 0
          const warn = pct >= 80 ? `\n⚠ ${pct}% of budget used — halt non-essential workers and ask the user.` : ""
          // SEC-3: the bucket key is echoed to the caller, so it is sanitised too.
          const taskBreakdown = Object.entries(costs.byTask).map(([k, v]) => `    ${clean(k, 64)}: $${v}`).join("\n")
          return {
            content: `Budget: $${budget} · spent: $${costs.spentUsd} (${pct}%)${warn}${taskBreakdown ? `\nPer-task:\n${taskBreakdown}` : ""}\n(source: ${source})`,
            shouldHalt: pct >= 80,
            pct,
          }
        })
      },
    })

    editor.add({
      name: "budget",
      description:
        "Preflight the run budget BEFORE teamwork_plan. Detects whether the session uses opencode/ (managed) models and whether the opencode_console MCP is connected. When both hold, tells the caller to fetch credits via opencode_console_get_usage and pass a full/partial budgetUsd to teamwork_plan. Otherwise, use the default budget.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input: any, context: any) => {
        const consoleOnline = await isConsoleMcpConnected(ctx)
        const opencodeModel = await usesOpencodeModel(ctx, context?.sessionID)
        if (consoleOnline && opencodeModel) {
          return {
            content: [
              "Budget preflight: opencode/ (managed) models detected AND opencode_console is connected.",
              "1. Call opencode_console_get_usage to read your budgets.",
              "2. remaining = min over budgets of (limitDollars - spentDollars).",
              "3. ASK THE USER: use the FULL remaining budget, or PARTIAL (half)?",
              "4. Pass the chosen budgetUsd to teamwork_plan.",
              "budgetSource: credits",
            ].join("\n"),
            applyCredits: true,
          }
        }
        return {
          content: `Budget preflight: console-credit budgeting does not apply (consoleOnline=${consoleOnline}, opencodeModel=${opencodeModel}). Use the default budget.`,
          applyCredits: false,
        }
      },
    })

    editor.add({
      name: "tournament",
      description:
        "Bounded massive-proof tournament state machine (`estimate`, `init`, `propose`, `falsify`, `merge`, `score`, `audit`, `cancel`, `status`). Enforces explicit opt-in, bounded levels/width/candidates, budget preflight, deterministic candidate ranking, AbortSignal/budget-halt cancellation, and team/referee verdict gating.",
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "estimate | init | propose | falsify | merge | score | audit | cancel | status",
          },
          sessionId: { type: "string" },
          topology: { type: "string" },
          request: { type: "string" },
          massiveProofOptIn: { type: "boolean" },
          budgetUsd: { type: "number" },
          budgetSource: { type: "string" },
          tournament: { type: "object", additionalProperties: true },
          tournamentBounds: { type: "object", additionalProperties: true },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
                requirements: { type: "array", items: { type: "string" } },
                agent: { type: "string" },
                maxRounds: { type: "number" },
              },
              required: ["id"],
              additionalProperties: true,
            },
          },
          candidateId: { type: "string" },
          parentIds: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          proofSketch: { type: "string" },
          agent: { type: "string" },
          closeRound: { type: "boolean" },
          closeLevel: { type: "boolean" },
          verdict: { type: "string" },
          reason: { type: "string" },
          counterexample: { type: "string" },
          scores: {
            type: "array",
            items: {
              type: "object",
              properties: {
                candidateId: { type: "string" },
                soundness: { type: "number" },
                completeness: { type: "number" },
                clarity: { type: "number" },
                verdict: { type: "string" },
                notes: { type: "string" },
              },
              required: ["candidateId", "soundness", "completeness", "clarity", "verdict"],
              additionalProperties: false,
            },
          },
          finalize: { type: "boolean" },
          winnerId: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const action = clean(input?.action, 32).trim()
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        if (action === "estimate") {
          const cfgRes = resolveAndValidateTournamentConfig(input?.tournament, input?.tournamentBounds)
          if (!cfgRes.ok) {
            return {
              content: cfgRes.conflict ? `refused: ${cfgRes.error}` : `refused: invalid tournament config (${cfgRes.error})`,
              ok: false,
              refused: "invalid_tournament_config",
            }
          }
          let existingSpent = 0
          let existingBudget: number | undefined
          if (input?.sessionId) {
            const resolved = resolveRun(root, input.sessionId)
            if (resolved.error) return { content: resolved.error, ok: false }
            const run = resolved.run as string
            if (existsSync(run)) {
              const costsRes = readBoundedRunJson<any>(run, join(run, "costs.json"), MAX_MANIFEST_BYTES)
              if (costsRes.status === "error") return { content: costsRes.error, ok: false, refused: "unsafe_path" }
              if (costsRes.status === "ok") {
                existingSpent = Number(costsRes.value?.spentUsd) || 0
                if (typeof costsRes.value?.budgetUsd === "number") existingBudget = costsRes.value.budgetUsd
              }
            }
          }
          const rawBudget = input?.budgetUsd === undefined ? (existingBudget ?? 20) : input.budgetUsd
          if (typeof rawBudget !== "number" || !Number.isFinite(rawBudget) || rawBudget <= 0) {
            return {
              content: "refused: massive-proof requires a positive budgetUsd (> 0)",
              ok: false,
              refused: "budget_preflight",
            }
          }
          const estimate = estimateTournamentBudget(cfgRes.config, existingSpent, rawBudget)
          return {
            content: estimate.sufficient
              ? `Estimate OK: min $${estimate.estimatedMinUsd.toFixed(2)}, max $${estimate.estimatedMaxUsd.toFixed(2)}, remaining $${estimate.remainingUsd.toFixed(2)} (${estimate.spentPct}% spent).`
              : `refused: ${estimate.refusalReason}`,
            ok: estimate.sufficient,
            sufficient: estimate.sufficient,
            config: cfgRes.config,
            estimate,
            ...(estimate.refusalReason ? { refused: "budget_preflight" } : {}),
          }
        }

        if (action === "init") {
          if (context?.signal?.aborted) {
            return { content: "refused: request aborted before tournament init; nothing was written.", aborted: true }
          }
          const sessionId = input?.sessionId || newSessionId()
          const resolved = resolveRun(root, sessionId)
          if (resolved.error) return { content: resolved.error }
          const run = resolved.run as string

          if (input?.topology !== undefined) {
            const normTop = normalizeTopology(input.topology)
            if (normTop !== "massive-proof") {
              return { content: `refused: tournament init requires topology "massive-proof" (got "${clean(input.topology, 32)}")` }
            }
          }

          const request = typeof input?.request === "string" ? input.request : undefined
          if (request !== undefined && request.length > REQUEST_MAX) {
            return { content: `refused: request exceeds ${REQUEST_MAX} chars; nothing was written.` }
          }

          const explicitFlag = input?.massiveProofOptIn === true
          const explicitSignal = typeof request === "string" && hasExplicitMassiveProofOptIn(request)
          if (!explicitFlag && !(input?.massiveProofOptIn !== false && explicitSignal)) {
            return {
              content: "refused: massive-proof tournament init requires massiveProofOptIn: true (or explicit large-team request); nothing was written.",
              refused: "opt_in_required",
            }
          }

          const cfgRes = resolveAndValidateTournamentConfig(input?.tournament, input?.tournamentBounds)
          if (!cfgRes.ok) {
            return {
              content: cfgRes.conflict
                ? `refused: ${cfgRes.error}; nothing was written.`
                : `refused: invalid tournament config (${cfgRes.error}); nothing was written.`,
              refused: "invalid_tournament_config",
            }
          }

          for (const t of input?.tasks || []) {
            const ids = [t?.id, ...(Array.isArray(t?.dependsOn) ? t.dependsOn : [])]
            const i = ids.findIndex((id: unknown) => typeof id !== "string" || !isSafeTaskId(id))
            if (i !== -1) {
              return { content: `refused: invalid task id "${clean(ids[i], 32)}"; nothing was written.` }
            }
          }

          return await withFileLock(manifestPathOf(run), async () => {
          let existingPlan: any
          let existingCosts: any
          let runExistsOrSymlink = existsSync(run)
          if (!runExistsOrSymlink) {
            try {
              lstatSync(run)
              runExistsOrSymlink = true
            } catch {}
          }
          if (runExistsOrSymlink) {
            const dirCheck = ensureSafeTournamentSubpath(run, tournamentDir(run))
            if (!dirCheck.ok) return { content: `${dirCheck.error}; nothing was written.`, refused: "unsafe_path" }
            const safeCheck = ensureSafeTournamentSubpath(run, manifestPathOf(run))
            if (!safeCheck.ok) return { content: `${safeCheck.error}; nothing was written.`, refused: "unsafe_path" }
            if (existsSync(manifestPathOf(run))) {
              return { content: "refused: tournament/manifest.json already exists for this run." }
            }
            const planRes = readBoundedRunJson<any>(run, join(run, "plan.dag.json"), MAX_MANIFEST_BYTES)
            if (planRes.status === "error") return { content: planRes.error, refused: "unsafe_path" }
            if (planRes.status === "ok") {
              existingPlan = planRes.value
              if (existingPlan.topology && existingPlan.topology !== "massive-proof") {
                return { content: `refused: run ${sessionId} has topology "${clean(existingPlan.topology, 32)}", expected "massive-proof".` }
              }
            }
            const costsRes = readBoundedRunJson<any>(run, join(run, "costs.json"), MAX_MANIFEST_BYTES)
            if (costsRes.status === "error") return { content: costsRes.error, refused: "unsafe_path" }
            if (costsRes.status === "ok") existingCosts = costsRes.value
          }

          const rawBudget = input?.budgetUsd === undefined ? (existingCosts?.budgetUsd ?? 20) : input.budgetUsd
          if (typeof rawBudget !== "number" || !Number.isFinite(rawBudget) || rawBudget <= 0) {
            return { content: "refused: massive-proof requires a positive budgetUsd (> 0); nothing was written.", refused: "budget_preflight" }
          }
          const existingSpent = Number(existingCosts?.spentUsd) || 0
          const estimate = estimateTournamentBudget(cfgRes.config, existingSpent, rawBudget)
          if (!estimate.sufficient) {
            return {
              content: `refused: ${estimate.refusalReason}; nothing was written.`,
              refused: "budget_preflight",
              estimate,
            }
          }

          try {
            mkdirSync(run, { recursive: true })
            if (request !== undefined && !existsSync(join(run, "ORIGINAL_REQUEST.md"))) {
              const refused = writeOriginalRequest(run, request, DEFAULT_INTEGRITY_MODE, sessionId)
              if (refused) return { content: refused }
            }
            if (!existingPlan) {
              const tasks = (Array.isArray(input?.tasks) && input.tasks.length ? input.tasks : [{ id: "tournament", agent: "team/proposer" }]).map((t: any) => ({
                id: clean(t.id, 64),
                dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((d: any) => clean(d, 64)) : [],
                requirements: Array.isArray(t.requirements) ? t.requirements.map((r: any) => clean(r, 120)) : [],
                agent: clean(t.agent || "team/proposer", 64),
                status: "pending",
                round: 0,
                maxRounds: Number.isFinite(t.maxRounds) ? t.maxRounds : 4,
              }))
              writeJson(join(run, "plan.dag.json"), {
                sessionId,
                topology: "massive-proof",
                integrityMode: DEFAULT_INTEGRITY_MODE,
                preflight: { status: "SKIPPED" },
                tasks,
                tournament: { config: cfgRes.config, estimate },
              })
              if (!existsSync(join(run, "state.json"))) {
                writeJson(join(run, "state.json"), {
                  version: 1,
                  sessionId,
                  integrityMode: DEFAULT_INTEGRITY_MODE,
                  phase: "DISPATCH",
                  tasks: nullMap(Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }]))),
                  updatedAt: new Date().toISOString(),
                })
              }
              touch(join(run, "pitfalls.md"), "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
              await appendEvent(run, {
                event: "run_created",
                sessionId,
                taskId: null,
                from: null,
                to: "pending",
                round: 0,
                phase: "DAG_BUILD",
                specGate: "bypassed",
              })
            } else {
              existingPlan.tournament = { config: cfgRes.config, estimate }
              writeJson(join(run, "plan.dag.json"), existingPlan)
            }

            // Repair a missing cost record even on a retry (plan may already
            // exist), and persist the budget this init approved while preserving
            // accumulated spend and buckets.
            const costsFile = join(run, "costs.json")
            await withFileLock(costsFile, async () => {
              const current = readJson<any>(run, costsFile, undefined)
              if (!current) {
                writeJson(costsFile, {
                  sessionId,
                  rootSessionIds: callSession ? [callSession] : [],
                  budgetUsd: rawBudget,
                  budgetSource: input?.budgetSource ? clean(input.budgetSource, 32) : "default",
                  spentUsd: 0,
                  byTask: nullMap(),
                  byTaskTokens: nullMap(),
                  updatedAt: new Date().toISOString(),
                })
                return
              }
              current.byTask = nullMap(current.byTask)
              current.byTaskTokens = nullMap(current.byTaskTokens)
              let changed = false
              if (callSession) {
                const roots = Array.isArray(current.rootSessionIds) ? current.rootSessionIds : []
                if (!roots.includes(callSession)) {
                  current.rootSessionIds = [...roots, callSession]
                  changed = true
                }
              }
              if (current.budgetUsd !== rawBudget) {
                current.budgetUsd = rawBudget
                changed = true
              }
              if (input?.budgetSource && current.budgetSource !== clean(input.budgetSource, 32)) {
                current.budgetSource = clean(input.budgetSource, 32)
                changed = true
              }
              if (changed) {
                current.updatedAt = new Date().toISOString()
                writeJson(costsFile, current)
              }
            })

            const manifest = initTournamentManifest({
              run,
              sessionId,
              config: cfgRes.config,
              budgetEstimate: estimate,
              explicitFlag,
              explicitRequestSignal: explicitSignal,
            })
            await appendEvent(run, {
              event: "tournament_step",
              sessionId,
              taskId: null,
              from: null,
              to: "PROPOSE",
              round: 1,
              phase: "PROPOSE",
            })
            return {
              content: `Tournament initialized for ${sessionId} (phase=${manifest.phase}, levels=${manifest.config.levels}, branchingFactor=${manifest.config.branchingFactor}, maxCandidates=${manifest.config.maxCandidates}, maxIterations=${manifest.config.maxIterations}).`,
              sessionId,
              manifest,
            }
          } catch (err: any) {
            const msg = typeof err?.message === "string" ? err.message : String(err)
            if (/^refused:/i.test(msg) || /symlink|escapes|outside|containment/i.test(msg)) {
              return { content: msg.startsWith("refused:") ? msg : `refused: ${msg}`, refused: "unsafe_path" }
            }
            throw err
          }
          })
        }

        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const sessionId = basename(run)

        if (action === "status") {
          const mRes = readTournamentManifest(run)
          if (mRes.status === "absent") return { content: `No tournament/manifest.json found for run ${sessionId}.` }
          if (mRes.status === "error") {
            return isUnsafePathDetail(mRes.error)
              ? { content: mRes.error, refused: "unsafe_path" }
              : { content: mRes.error }
          }
          const vRes = readTournamentVerdict(run)
          const m = mRes.manifest
          const cands = Object.values(m.candidates || {})
          const surviving = cands.filter((c) => c && c.status !== "pruned").length
          return {
            content: `Tournament ${sessionId}: phase=${m.phase}, iter=${m.iteration}/${m.config.maxIterations}, level=${m.currentLevel}/${m.config.levels}, candidates=${cands.length} (${surviving} surviving).`,
            phase: m.phase,
            iteration: m.iteration,
            currentLevel: m.currentLevel,
            totalCandidates: cands.length,
            survivingCandidates: surviving,
            rankedCandidates: m.rankedCandidates,
            verdict: vRes.status === "ok" ? vRes.verdict : m.verdict,
            cancelled: m.cancelled,
          }
        }

        const mFile = manifestPathOf(run)
        try {
          return await withFileLock(mFile, async () => {
            const mRes = readTournamentManifest(run)
            if (mRes.status === "absent") return { content: `No tournament/manifest.json found for run ${sessionId}.` }
            if (mRes.status === "error") {
              return isUnsafePathDetail(mRes.error)
                ? { content: mRes.error, refused: "unsafe_path" }
                : { content: mRes.error }
            }
          const manifest = mRes.manifest
          const caller = await deriveCallerAgent(ctx, run, callSession)

          if (action === "cancel") {
            if (manifest.phase === "COMPLETED" || manifest.phase === "FAILED") {
              return { content: `refused: tournament already finalized with phase ${manifest.phase}.` }
            }
            const partial = finalizeTournamentPartial(run, manifest, {
              trigger: "explicit",
              reason: typeof input?.reason === "string" && input.reason.trim() ? input.reason : "Cancelled explicitly",
              phase: "CANCELLED",
              cancelledBy: caller?.agent ?? null,
            })
            if (!partial.alreadyFinalized) {
              await appendEvent(run, {
                event: "tournament_cancelled",
                sessionId,
                taskId: null,
                from: null,
                to: "CANCELLED",
                round: manifest.iteration,
                agent: caller?.agent ?? null,
                agentSource: caller?.agent ? "session" : undefined,
                phase: "PRESENT_PARTIAL",
                note: partial.manifest.cancelled?.reason ?? "Cancelled explicitly",
              })
            }
            return {
              content: `Tournament ${sessionId} ${partial.manifest.phase} (partial report: ${partial.reportPath}).`,
              phase: partial.manifest.phase,
              partial: true,
              alreadyFinalized: partial.alreadyFinalized,
              reportPath: partial.reportPath,
              verdict: partial.verdict,
            }
          }

          if (!TOURNAMENT_ACTIVE_PHASES.has(manifest.phase)) {
            return {
              content: `refused: tournament is ${manifest.phase}; no further dispatch allowed. Report: ${reportPathOf(run)}`,
              refused: "tournament_terminal",
              phase: manifest.phase,
            }
          }

          if (context?.signal?.aborted) {
            const partial = finalizeTournamentPartial(run, manifest, {
              trigger: "signal",
              reason: "Aborted via AbortSignal",
              phase: "CANCELLED",
              cancelledBy: caller?.agent ?? null,
            })
            if (!partial.alreadyFinalized) {
              await appendEvent(run, {
                event: "tournament_cancelled",
                sessionId,
                taskId: null,
                from: null,
                to: "CANCELLED",
                round: manifest.iteration,
                agent: caller?.agent ?? null,
                agentSource: caller?.agent ? "session" : undefined,
                phase: "PRESENT_PARTIAL",
                note: "Aborted via AbortSignal",
              })
            }
            return {
              content: `refused: tournament aborted via AbortSignal; partial report written to ${partial.reportPath}.`,
              aborted: true,
              partial: true,
              phase: "CANCELLED",
              reportPath: partial.reportPath,
              verdict: partial.verdict,
            }
          }

          const costsRes = readBoundedRunJson<any>(run, join(run, "costs.json"), MAX_MANIFEST_BYTES)
          if (costsRes.status === "error") {
            return isUnsafePathDetail(costsRes.error)
              ? { content: costsRes.error, refused: "unsafe_path" }
              : { content: costsRes.error }
          }
          if (costsRes.status === "absent") {
            return {
              content: "refused: missing costs.json for this run; restore a valid budget record before continuing tournament work.",
              refused: "budget_preflight",
            }
          }
          if (costsRes.status === "ok") {
            const budget = Number(costsRes.value?.budgetUsd) || 0
            const spent = Number(costsRes.value?.spentUsd) || 0
            const pct = budget > 0 ? Math.floor((spent / budget) * 100) : 100
            if (budget <= 0 || spent >= budget || pct >= 80) {
              const reason = `Budget threshold reached (${pct}% of $${budget})`
              const partial = finalizeTournamentPartial(run, manifest, {
                trigger: "budget_exhausted",
                reason,
                phase: "BUDGET_HALTED",
                cancelledBy: caller?.agent ?? null,
              })
              if (!partial.alreadyFinalized) {
                await appendEvent(run, {
                  event: "tournament_cancelled",
                  sessionId,
                  taskId: null,
                  from: null,
                  to: "BUDGET_HALTED",
                  round: manifest.iteration,
                  agent: caller?.agent ?? null,
                  agentSource: caller?.agent ? "session" : undefined,
                  phase: "PRESENT_PARTIAL",
                  note: reason,
                })
              }
              return {
                content: `refused: ${reason}; tournament halted and partial report written to ${partial.reportPath}.`,
                halted: true,
                shouldHalt: true,
                partial: true,
                phase: "BUDGET_HALTED",
                reportPath: partial.reportPath,
                verdict: partial.verdict,
              }
            }
          }

          const prevPhase = manifest.phase
          if (action === "propose") {
            const res = proposeCandidate(run, manifest, {
              candidateId: input?.candidateId,
              summary: input?.summary,
              proofSketch: input?.proofSketch,
              agent: input?.agent ?? caller?.agent,
              closeRound: input?.closeRound === true,
            })
            if (!res.ok) return { content: res.error }
            await appendEvent(run, {
              event: "tournament_step",
              sessionId,
              taskId: res.candidate.id,
              from: prevPhase,
              to: res.manifest.phase,
              round: res.manifest.iteration,
              agent: res.candidate.agent,
              agentSource: input?.agent ? "explicit" : caller?.agent ? "session" : "plan",
              phase: res.manifest.phase,
            })
            return {
              content: `Proposed candidate ${res.candidate.id} (iter=${res.candidate.iteration}, level=0). Phase: ${res.manifest.phase}.`,
              candidate: res.candidate,
              phase: res.manifest.phase,
              iteration: res.manifest.iteration,
            }
          }

          if (action === "falsify") {
            const res = falsifyCandidate(run, manifest, {
              candidateId: input?.candidateId,
              verdict: input?.verdict,
              reason: input?.reason,
              counterexample: input?.counterexample,
              agent: input?.agent ?? caller?.agent,
            })
            if (!res.ok) return { content: res.error }
            await appendEvent(run, {
              event: "tournament_step",
              sessionId,
              taskId: res.candidate.id,
              from: prevPhase,
              to: res.manifest.phase,
              round: res.manifest.iteration,
              agent: "team/falsifier",
              agentSource: input?.agent ? "explicit" : caller?.agent ? "session" : "plan",
              phase: res.manifest.phase,
            })
            return {
              content: `Falsified ${res.candidate.id} -> ${res.candidate.status}. Phase: ${res.manifest.phase}, iter=${res.manifest.iteration}, level=${res.manifest.currentLevel}.`,
              candidate: res.candidate,
              phase: res.manifest.phase,
              iteration: res.manifest.iteration,
              currentLevel: res.manifest.currentLevel,
            }
          }

          if (action === "merge") {
            const res = mergeCandidates(run, manifest, {
              candidateId: input?.candidateId,
              parentIds: input?.parentIds,
              summary: input?.summary,
              proofSketch: input?.proofSketch,
              agent: input?.agent ?? caller?.agent,
              closeLevel: input?.closeLevel === true,
            })
            if (!res.ok) return { content: res.error }
            await appendEvent(run, {
              event: "tournament_step",
              sessionId,
              taskId: res.candidate.id,
              from: prevPhase,
              to: res.manifest.phase,
              round: res.manifest.iteration,
              agent: "team/synthesizer",
              agentSource: input?.agent ? "explicit" : caller?.agent ? "session" : "plan",
              phase: res.manifest.phase,
            })
            return {
              content: `Merged ${res.candidate.parentIds.join("+")} -> ${res.candidate.id} (level=${res.candidate.level}). Phase: ${res.manifest.phase}.`,
              candidate: res.candidate,
              phase: res.manifest.phase,
              currentLevel: res.manifest.currentLevel,
            }
          }

          if (action === "score") {
            const res = scoreCandidates(run, manifest, {
              scores: input?.scores,
              // Trusted session identity wins over a caller-supplied label; the
              // explicit label is only a legacy fallback when identity is unknown.
              agent: caller?.agent ?? input?.agent,
              finalize: input?.finalize === true,
            })
            if (!res.ok) return { content: res.error }
            await appendEvent(run, {
              event: "tournament_step",
              sessionId,
              taskId: null,
              from: prevPhase,
              to: res.manifest.phase,
              round: res.manifest.iteration,
              agent: "team/referee",
              agentSource: input?.agent ? "explicit" : caller?.agent ? "session" : "plan",
              phase: res.manifest.phase,
            })
            return {
              content: `Referee scored ${input.scores.length} candidate(s). Top: ${res.manifest.rankedCandidates[0]?.id ?? "none"} (${res.manifest.rankedCandidates[0]?.score ?? "n/a"}). Phase: ${res.manifest.phase}.`,
              phase: res.manifest.phase,
              iteration: res.manifest.iteration,
              rankedCandidates: res.manifest.rankedCandidates,
            }
          }

          if (action === "audit") {
            const res = auditTournament(run, manifest, {
              verdict: input?.verdict,
              summary: input?.summary,
              winnerId: input?.winnerId,
              // Same rule as score: authorization follows the session, not the label.
              agent: caller?.agent ?? input?.agent,
            })
            if (!res.ok) return { content: res.error }
            await appendEvent(run, {
              event: "tournament_step",
              sessionId,
              taskId: res.verdict.winnerId,
              from: prevPhase,
              to: res.manifest.phase,
              round: res.manifest.iteration,
              agent: "team/referee",
              agentSource: input?.agent ? "explicit" : caller?.agent ? "session" : "plan",
              phase: res.manifest.phase,
            })
            return {
              content: `Victory audit ${res.verdict.status} (${res.verdict.verdict}), winner=${res.verdict.winnerId ?? "none"}. Report: ${reportPathOf(run)}.`,
              phase: res.manifest.phase,
              verdict: res.verdict,
              reportPath: reportPathOf(run),
            }
          }

          return {
            content: `Error: unknown tournament action "${action}". Allowed: estimate | init | propose | falsify | merge | score | audit | cancel | status`,
          }
          })
        } catch (err: any) {
          const msg = typeof err?.message === "string" ? err.message : String(err)
          if (/^refused:/i.test(msg) || /symlink|escapes|outside|containment/i.test(msg)) {
            return { content: msg.startsWith("refused:") ? msg : `refused: ${msg}`, refused: "unsafe_path" }
          }
          throw err
        }
      },
    })

    editor.add({
      name: "pitfall",
      description: "Append an answer-agnostic failure mode to the run's pitfall registry.",
      input: {
        type: "object",
        properties: { sessionId: { type: "string" }, round: { type: "number" }, taskId: { type: "string" }, pitfall: { type: "string" } },
        required: ["pitfall"],
        additionalProperties: false,
      },
      execute: (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const file = join(run, "pitfalls.md")
        refuseSymlink(file)
        const line = `- [round ${Number(input.round) || "?"}] ${clean(input.pitfall, 200)}${input.taskId ? ` — seen in ${clean(input.taskId, 64)}` : ""}\n`
        appendFileSync(file, line)
        return { content: `Logged pitfall: ${line.trim()}` }
      },
    })

    editor.add({
      name: "next",
      description:
        "Determine the next actionable tasks in the DAG based on dependencies and current lifecycle states. Returns tasks ready for worker dispatch, tasks ready for verifier dispatch, in-progress tasks, or signals completion/deadlock. In strict mode it returns NEEDS_STRICT_WAVE (or BLOCKED_BY_STRICT_WAVE) until every task has its falsifier challenge and security-auditor audit, and never ALL_PASSED before them.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Teamwork session id (defaults to active run)." },
          allowUnstamped: {
            type: "boolean",
            description:
              "Legacy migration escape hatch (default false). When true, a PASS verify/final.json without teamwork_final_verify provenance is accepted for completion and the bypass is recorded as a final_verification_bypass event. Do not use for new runs.",
          },
          allowUnsignedLegacy: {
            type: "boolean",
            description:
              "Legacy migration escape hatch (default false). An unsigned run with no run.manifest.json returns AUTH_LEGACY until this is passed; the bypass is recorded as a legacy_unsigned_bypass event. A signed run never accepts it.",
          },
        },
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string

        const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const state = readJson<any>(run, join(run, "state.json"), undefined)
        if (!plan || !Array.isArray(plan.tasks)) {
          return { content: `No valid plan.dag.json found for run ${basename(run)}.` }
        }
        if (!state || typeof state.tasks !== "object") {
          return { content: `No valid state.json found for run ${basename(run)}.` }
        }

        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return {
            status: "AUTH_INVALID",
            auth: manifestCheck.failure.code,
            content: `BLOCKED_BY_AUTH: ${authFailureText(manifestCheck.failure)}. The run cannot complete until the manifest is trustworthy.`,
          }
        }
        const signedRun = manifestCheck.signed
        const allowUnsignedLegacy = input?.allowUnsignedLegacy === true

        const tournamentPresent =
          plan.topology === "massive-proof" &&
          (!!plan.tournament ||
            existsSync(join(run, "tournament")) ||
            (() => {
              try {
                return lstatSync(join(run, "tournament")).isSymbolicLink()
              } catch {
                return false
              }
            })())
        if (tournamentPresent) {
          const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
          let tOutcome: any
          try {
            tOutcome = await withFileLock(manifestPathOf(run), async () => {
              const mRes = readTournamentManifest(run)
              if (mRes.status === "error") {
                return {
                  content: `BLOCKED_BY_TOURNAMENT: ${mRes.error}`,
                  status: "BLOCKED",
                  ...(isUnsafePathDetail(mRes.error) ? { refused: "unsafe_path" } : {}),
                }
              }
              if (mRes.status === "absent") {
                return {
                  content: `BLOCKED_BY_TOURNAMENT: missing tournament/manifest.json for massive-proof tournament run.`,
                  status: "BLOCKED",
                }
              }
              const manifest = mRes.manifest
              const caller = await deriveCallerAgent(ctx, run, callSession)

              if (TOURNAMENT_ACTIVE_PHASES.has(manifest.phase) && context?.signal?.aborted) {
                const partial = finalizeTournamentPartial(run, manifest, {
                  trigger: "signal",
                  reason: "Aborted via AbortSignal",
                  phase: "CANCELLED",
                  cancelledBy: caller?.agent ?? null,
                })
                if (!partial.alreadyFinalized) {
                  await appendEvent(run, {
                    event: "tournament_cancelled",
                    sessionId: basename(run),
                    taskId: null,
                    from: null,
                    to: "CANCELLED",
                    round: manifest.iteration,
                    agent: caller?.agent ?? null,
                    agentSource: caller?.agent ? "session" : undefined,
                    phase: "PRESENT_PARTIAL",
                    note: "Aborted via AbortSignal",
                  })
                }
                return {
                  content: `TOURNAMENT_CANCELLED: aborted via AbortSignal. Partial report: ${partial.reportPath}`,
                  status: "CANCELLED",
                  phase: "PRESENT_PARTIAL",
                  aborted: true,
                  partialReport: partial.reportPath,
                }
              }

              if (TOURNAMENT_ACTIVE_PHASES.has(manifest.phase)) {
                const costsRes = readBoundedRunJson<any>(run, join(run, "costs.json"), MAX_MANIFEST_BYTES)
                if (costsRes.status === "error") {
                  return {
                    content: `BLOCKED_BY_TOURNAMENT: ${costsRes.error}`,
                    status: "BLOCKED",
                    ...(isUnsafePathDetail(costsRes.error) ? { refused: "unsafe_path" } : {}),
                  }
                }
                if (costsRes.status === "absent") {
                  return {
                    content: "BLOCKED_BY_TOURNAMENT: missing costs.json for this run; restore a valid budget record before dispatching tournament work.",
                    status: "BLOCKED",
                  }
                }
                if (costsRes.status === "ok") {
                  const budget = Number(costsRes.value?.budgetUsd) || 0
                  const spent = Number(costsRes.value?.spentUsd) || 0
                  const pct = budget > 0 ? Math.floor((spent / budget) * 100) : 100
                  if (budget <= 0 || spent >= budget || pct >= 80) {
                    const reason = `Budget threshold reached (${pct}% of $${budget})`
                    const partial = finalizeTournamentPartial(run, manifest, {
                      trigger: "budget_exhausted",
                      reason,
                      phase: "BUDGET_HALTED",
                      cancelledBy: caller?.agent ?? null,
                    })
                    if (!partial.alreadyFinalized) {
                      await appendEvent(run, {
                        event: "tournament_cancelled",
                        sessionId: basename(run),
                        taskId: null,
                        from: null,
                        to: "BUDGET_HALTED",
                        round: manifest.iteration,
                        agent: caller?.agent ?? null,
                        agentSource: caller?.agent ? "session" : undefined,
                        phase: "PRESENT_PARTIAL",
                        note: reason,
                      })
                    }
                    return {
                      content: `TOURNAMENT_BUDGET_HALTED: ${reason}. Partial report: ${partial.reportPath}`,
                      status: "BUDGET_HALTED",
                      phase: "PRESENT_PARTIAL",
                      shouldHalt: true,
                      partialReport: partial.reportPath,
                    }
                  }
                }
              }

              if (manifest.phase === "CANCELLED" || manifest.phase === "BUDGET_HALTED") {
                return {
                  content: `TOURNAMENT_${manifest.phase}: ${manifest.cancelled?.reason ?? "halted"}. Partial report: ${reportPathOf(run)}`,
                  status: manifest.phase,
                  phase: "PRESENT_PARTIAL",
                  partialReport: reportPathOf(run),
                }
              }
              if (manifest.phase === "FAILED") {
                return {
                  content: `BLOCKED_BY_TOURNAMENT: tournament ended in FAILED phase. Report: ${reportPathOf(run)}`,
                  status: "BLOCKED",
                }
              }
              if (manifest.phase === "COMPLETED") {
                // A stamped final PASS must not outlive the evidence it was based
                // on. Revalidate the current verdict/report before generic completion.
                const vRes = readTournamentVerdict(run)
                const rRes = readBoundedRunFile(run, reportPathOf(run), MAX_REPORT_BYTES)
                if (
                  vRes.status !== "ok" ||
                  vRes.verdict.status !== "PASS" ||
                  vRes.verdict.verdict !== "ACCEPT" ||
                  rRes.status !== "ok" ||
                  !rRes.text.trim()
                ) {
                  return {
                    content: `BLOCKED_BY_TOURNAMENT: completed tournament evidence is missing or invalid (verdict: ${
                      vRes.status === "ok" ? `${vRes.verdict.status}/${vRes.verdict.verdict}` : vRes.status === "error" ? vRes.error : "missing"
                    }; report: ${rRes.status === "ok" && rRes.text.trim() ? "present" : "missing or empty"}). Re-run tournament audit before merging.`,
                    status: "BLOCKED",
                  }
                }
              }
              if (TOURNAMENT_ACTIVE_PHASES.has(manifest.phase)) {
                const nextActionMap: Record<string, string> = {
                  PROPOSE: "propose",
                  FALSIFY_PRUNE: "falsify",
                  MERGE: "merge",
                  REFEREE_SCORE: "score",
                  VICTORY_AUDIT: "audit",
                }
                const nextAction = nextActionMap[manifest.phase] || "propose"
                const candidateIds = Object.values(manifest.candidates || {})
                  .filter((c) => c && c.iteration === manifest.iteration && c.level === manifest.currentLevel && c.status !== "pruned")
                  .map((c) => c.id)
                return {
                  content: `TOURNAMENT_ACTIVE: phase=${manifest.phase}, iteration=${manifest.iteration}/${manifest.config.maxIterations}, level=${manifest.currentLevel}/${manifest.config.levels}. Next teamwork_tournament action: ${nextAction}.`,
                  status: "TOURNAMENT_ACTIVE",
                  tournamentPhase: manifest.phase,
                  iteration: manifest.iteration,
                  level: manifest.currentLevel,
                  nextAction,
                  candidateIds,
                }
              }
              return undefined
            })
          } catch (err: any) {
            const msg = typeof err?.message === "string" ? err.message : String(err)
            if (isUnsafePathError(msg)) {
              return {
                status: "BLOCKED",
                content: msg.startsWith("refused:") ? msg : `refused: ${msg}`,
                refused: "unsafe_path",
              }
            }
            throw err
          }
          if (tOutcome) return tOutcome
        } else if (context?.signal?.aborted) {
          return { content: "refused: request aborted via AbortSignal.", status: "CANCELLED", aborted: true }
        }

        // Authenticity applies to the completion path. Tournament-active runs
        // have already returned above with their own phase status; a legacy
        // tournament can still be driven, but it cannot report ALL_PASSED.
        if (!signedRun && !allowUnsignedLegacy) {
          return {
            status: "AUTH_LEGACY",
            auth: "AUTH_LEGACY",
            content:
              "AUTH_LEGACY: this run has no signed run.manifest.json. Re-call teamwork_next with allowUnsignedLegacy: true to record an explicit legacy bypass; a signed run (the default for new plans) never needs this.",
          }
        }
        if (signedRun) {
          const drift = currentManifestDrift(manifestCheck.manifest, plan, state, run)
          if (drift.length > 0) {
            return {
              status: "AUTH_STALE",
              auth: "AUTH_STALE",
              content: `BLOCKED_BY_AUTH: the run drifted from its signed baseline: ${drift.map(manifestDriftReason).join("; ")}. A re-plan is not sufficient; start a new session.`,
              reasons: drift.map(manifestDriftReason),
            }
          }
        }

        const taskDefs = new Map<string, any>(plan.tasks.map((t: any) => [t.id, t]))
        const taskStates = nullMap<any>(state.tasks)

        let docManifest: any
        if (plan.topology === "document-review") {
          const mRes = readRegularJson<any>(run, join(run, "document-review", "manifest.json"))
          if (mRes.ok) docManifest = mRes.data
          else {
            return {
              content:
                mRes.reason === "symlink"
                  ? "BLOCKED_BY_DOCUMENT_MANIFEST: document-review/manifest.json is a symlink."
                  : "BLOCKED_BY_DOCUMENT_MANIFEST: document-review/manifest.json is missing or invalid — call teamwork_document_triage first.",
              status: "BLOCKED",
            }
          }
        }
        const docSegMap = new Map<string, any>(
          Array.isArray(docManifest?.segments)
            ? docManifest.segments.map((s: any) => [String(s?.id || ""), s])
            : [],
        )

        const isPassed = (id: string) => {
          const s = taskStates[id]?.status
          return s === "verified_pass" || s === "pass"
        }

        const isBlocked = (id: string) => {
          const s = taskStates[id]?.status
          const r = Number(taskStates[id]?.round) || 0
          const maxR = Number(taskDefs.get(id)?.maxRounds) || 4
          return s === "blocked" || (s === "verified_fail" && r >= maxR) || (s === "fail" && r >= maxR)
        }

        const readyForWorker: any[] = []
        const readyForVerifier: any[] = []
        const inProgress: any[] = []
        const blockedTasks: any[] = []
        const passedTasks: any[] = []

        for (const [id, def] of taskDefs.entries()) {
          const st = taskStates[id] || { status: "pending", round: 0 }
          const status = st.status || "pending"
          const round = Number(st.round) || 0
          const maxRounds = Number(def.maxRounds) || 4
          const deps = Array.isArray(def.dependsOn) ? def.dependsOn : []

          if (isPassed(id)) {
            passedTasks.push({ id, status, round })
            continue
          }

          if (isBlocked(id)) {
            blockedTasks.push({ id, status, round, reason: "Max rounds exceeded or explicitly blocked" })
            continue
          }

          const blockedDep = deps.find(isBlocked)
          if (blockedDep) {
            blockedTasks.push({ id, status: "blocked", reason: `Dependency ${blockedDep} failed/blocked` })
            continue
          }

          const allDepsPassed = deps.every(isPassed)

          if (status === "worker_done") {
            readyForVerifier.push({
              id,
              agent: "team/verifier",
              branch: st.branch || `teamwork/${basename(run)}-${id}`,
              round,
              summary: st.summary,
            })
          } else if (status === "worker_active" || status === "verifier_active" || status === "running") {
            inProgress.push({
              id,
              status,
              round,
              branch: st.branch,
            })
          } else if (allDepsPassed && (status === "pending" || ((status === "verified_fail" || status === "fail") && round < maxRounds))) {
            const pitfalls = readPitfalls(run, id)
            // 3.6: surface the cumulative unresolved issue set, not just the latest
            // round. Oldest first, one `R<n>: <text>` line per entry, capped.
            const log = Array.isArray(st.feedbackLog) ? st.feedbackLog : []
            const unresolved = log
              .filter((e: any) => e && typeof e === "object" && e.resolved !== true)
              .map((e: any) => `R${Number(e.round) || 0}: ${clean(e.text, 500)}`)
            const docSeg = docSegMap.get(id)
            const documentReview = docManifest
              ? id === "doc-synthesis"
                ? {
                    role: "cross-segment-synthesis",
                    synthTreeShape: docManifest.bounds?.synthTreeShape ?? [4, 1],
                    segmentIds: Array.isArray(docManifest.segments) ? docManifest.segments.map((s: any) => s.id) : [],
                    artifactDir: join(run, "document-review", "synthesis"),
                    reportPath: join(run, "DOCUMENT_REVIEW_REPORT.md"),
                  }
                : docSeg
                  ? {
                      role: "segment-review",
                      segmentId: docSeg.id,
                      segmentTitle: docSeg.title,
                      reviewTreeShape: docManifest.bounds?.reviewTreeShape ?? [4, 2, 1],
                      artifactDir: join(run, "document-review", "segments", docSeg.id),
                      textMapPath: join(run, "document-review", "DOCUMENT_TEXT_MAP.md"),
                    }
                  : undefined
              : undefined
            readyForWorker.push({
              id,
              agent: def.agent || "team/worker",
              round: (status === "verified_fail" || status === "fail") ? round + 1 : (round || 1),
              maxRounds,
              requirements: def.requirements || [],
              dependsOn: deps,
              branch: st.branch || `teamwork/${basename(run)}-${id}`,
              // A legacy run has no ledger: keep the single latest `feedback` field.
              feedback: log.length ? cleanBlock(unresolved.join("\n"), 2000) : st.feedback,
              avoidPitfalls: pitfalls,
              ...(documentReview ? { documentReview } : {}),
            })
          }
        }

        if (passedTasks.length === taskDefs.size) {
          const auditFile = join(run, "verify", "security-audit.json")
          const audit = existsSync(auditFile) ? readJson<any>(run, auditFile, undefined) : undefined
          if (signedRun && audit) {
            const check = auth
              ? await auth.verifyRunArtifact(basename(run), "verify/security-audit.json", audit)
              : {
                  status: "unknown" as const,
                  failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                }
            if (check.status !== "signed") {
              const failure =
                check.status === "unsigned"
                  ? { code: "AUTH_MISSING" as const, message: "verify/security-audit.json has no _auth envelope (a signed run requires one)" }
                  : check.failure ?? { code: "AUTH_INVALID" as const, message: "security audit failed verification" }
              return {
                status: failure.code,
                auth: failure.code,
                content: `BLOCKED_BY_AUTH: [${failure.code}] ${failure.message}. Re-run teamwork_security_audit before completing the run.`,
              }
            }
          }
          // The final gate reports the run's integrity mode, read from the same
          // artifact the auditor uses (legacy runs default to development). It is
          // disclosed, never enforced here: enforcement stays with the auditor.
          const integrity = readIntegrityMode(run)
          const integrityModeNote =
            integrity.source === "artifact"
              ? `Integrity mode: ${integrity.mode} (from ORIGINAL_REQUEST.md).`
              : `Integrity mode: ${integrity.mode} (default; no ORIGINAL_REQUEST.md for this run).`

          if (!audit || audit.status !== "PASS") {
            const auditFailed = audit && audit.status === "FAIL"
            if (state.phase !== "SECURITY_AUDIT" && !auditFailed) {
              state.phase = "SECURITY_AUDIT"
              writeJson(join(run, "state.json"), state)
              await refreshBriefingSafe(run)
            }

            if (auditFailed) {
              const crit = Number(audit?.severityCounts?.critical) || 0
              const high = Number(audit?.severityCounts?.high) || 0
              return {
                content: `BLOCKED_BY_SECURITY: All tasks passed functional verification, but security audit FAILED with ${crit} Critical and ${high} High findings.\nFix findings before final merge.\nReport: ${auditFile}`,
                status: "BLOCKED_BY_SECURITY",
                auditReport: auditFile,
                passedCount: passedTasks.length,
              }
            }

            return {
              content: `READY_FOR_SECURITY_AUDIT: All ${taskDefs.size} tasks passed functional verification and are merged into base.\nMandatory Security Gate: Dispatch team/security-auditor on sentinel worktree before final merge.\nRun teamwork_security_audit tool when audit completes.`,
              status: "READY_FOR_SECURITY_AUDIT",
              agent: "team/security-auditor",
              passedCount: passedTasks.length,
            }
          }

          // Strict mode: the security audit above is the run-level pre-merge
          // gate. Strict additionally needs one falsifier challenge and one
          // security-auditor audit per task, recorded after its verifier PASS.
          // Never complete (or pretend final verification is ready) without them.
          const verification = resolveVerificationMode(plan, state)
          if (verification.mode === "strict") {
            const strictTasks = [...taskDefs.keys()]
              .filter((id) => isSafeTaskId(id))
              .map((id) => ({ id, status: String(taskStates[id]?.status ?? "pending") }))
            const strictGate = await evaluateStrictGateChecked(run, strictTasks, "strict", {
              auth,
              requireSigned: signedRun,
            })
            if (!strictGate.ok) {
              const status =
                strictGate.status === "MISSING" ? "NEEDS_STRICT_WAVE" : "BLOCKED_BY_STRICT_WAVE"
              const pairs = strictGate.missing.map((m) => `${m.taskId}:${m.kind}`)
              return {
                content: `${status}: strict verification is incomplete. ${
                  pairs.length
                    ? `Missing strict verdict(s): ${pairs.join(", ")}.`
                    : "Every strict verdict is present but at least one is not PASS/CLEAN."
                }\nDispatch team/falsifier and team/security-auditor in parallel for each ready task; each must call teamwork_wave_record (challenge=PASS, audit=CLEAN). Then run teamwork_final_verify.\n${strictGate.reasons.map((r) => `  - ${r}`).join("\n")}`,
                status,
                strictWave: {
                  status: strictGate.status,
                  missing: strictGate.missing,
                  reasons: strictGate.reasons,
                },
                missing: strictGate.missing,
                reasons: strictGate.reasons,
                passedCount: passedTasks.length,
              }
            }
          }

          // "Done" needs an independent final verdict, not just per-task PASSes.
          // Missing, unreadable, or malformed reports are NOT done. A PASS is
          // only sufficient when `teamwork_final_verify` stamped it; an
          // unstamped (hand-written or legacy) report needs the explicit,
          // recorded `allowUnstamped` bypass.
          const finalFile = join(run, "verify", "final.json")
          const finalReport = existsSync(finalFile) ? readJson<any>(run, finalFile, undefined) : undefined
          if (signedRun && finalReport && typeof finalReport === "object" && finalReport.status === "PASS") {
            const check = auth
              ? await auth.verifyRunArtifact(basename(run), "verify/final.json", finalReport)
              : {
                  status: "unknown" as const,
                  failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                }
            if (check.status !== "signed") {
              const failure =
                check.status === "unsigned"
                  ? { code: "AUTH_MISSING" as const, message: "verify/final.json has no _auth envelope (a signed run requires one)" }
                  : check.failure ?? { code: "AUTH_INVALID" as const, message: "final report failed verification" }
              return {
                status: failure.code,
                auth: failure.code,
                content: `BLOCKED_BY_AUTH: [${failure.code}] ${failure.message}. Re-run teamwork_final_verify.`,
                finalReport: finalFile,
                integrityMode: integrity.mode,
              }
            }
            // Evidence drift: a stamped PASS must not outlive the report,
            // audit, or requirements baseline it was computed from.
            const recordedDigests = finalReport.evidence?.reportDigests
            const drift: string[] = []
            if (recordedDigests && typeof recordedDigests === "object") {
              for (const [id, digest] of Object.entries(recordedDigests)) {
                if (!isSafeTaskId(id)) continue
                const raw = readBoundedRunFile(run, join(run, `verify/report-${id}.json`), MAX_RUN_FILE_BYTES)
                const current = raw.status === "ok" ? sha256Hex(raw.text) : null
                if (current !== digest) drift.push(`report ${id} changed since final verification`)
              }
            }
            const recordedAudit = finalReport.evidence?.auditDigest
            const auditRaw = readBoundedRunFile(run, join(run, "verify", "security-audit.json"), MAX_RUN_FILE_BYTES)
            const currentAudit = auditRaw.status === "ok" ? sha256Hex(auditRaw.text) : null
            if (recordedAudit !== undefined && recordedAudit !== currentAudit) {
              drift.push("security audit changed since final verification")
            }
            const recordedRequirements = finalReport.requirementsHash
            if (recordedRequirements !== undefined && recordedRequirements !== currentRequirementsHash(run)) {
              drift.push("requirements baseline changed since final verification")
            }
            if (drift.length > 0) {
              return {
                status: "AUTH_STALE",
                auth: "AUTH_STALE",
                content: `BLOCKED_BY_AUTH: [AUTH_STALE] the final verdict is stale: ${drift.join("; ")}. Re-run teamwork_final_verify.`,
                finalReport: finalFile,
                integrityMode: integrity.mode,
                reasons: drift.map((d) => `[AUTH_STALE] ${d}`),
              }
            }
          }

          if (!finalReport || typeof finalReport !== "object" || typeof finalReport.status !== "string") {
            if (state.phase !== "FINAL_VERIFICATION") {
              state.phase = "FINAL_VERIFICATION"
              writeJson(join(run, "state.json"), state)
              await refreshBriefingSafe(run)
            }
            return {
              content: `READY_FOR_FINAL_VERIFICATION: All ${taskDefs.size} tasks passed verification and security audit PASSED, but there is no usable final verification report at ${finalFile} (missing, unreadable, or malformed).\nRun an independent final verification of the whole run and write verify/final.json with "status": "PASS" or "FAIL" before merging.\n${integrityModeNote}`,
              status: "READY_FOR_FINAL_VERIFICATION",
              integrityMode: integrity.mode,
              finalReport: finalFile,
              passedCount: passedTasks.length,
            }
          }

          if (finalReport.status !== "PASS") {
            return {
              content: `BLOCKED_BY_FINAL_VERIFICATION: Final verification did not pass the run (status ${clean(finalReport.status, 32)}).\nAddress the findings in ${finalFile} and re-run the final verification; merge stays blocked until verify/final.json reports PASS.\n${integrityModeNote}`,
              status: "BLOCKED_BY_FINAL_VERIFICATION",
              integrityMode: integrity.mode,
              finalReport: finalFile,
              passedCount: passedTasks.length,
            }
          }

          const stamped = isStampedFinalReport(finalReport)
          const allowUnstamped = input?.allowUnstamped === true

          if (!stamped && !allowUnstamped) {
            if (state.phase !== "FINAL_VERIFICATION") {
              state.phase = "FINAL_VERIFICATION"
              writeJson(join(run, "state.json"), state)
              await refreshBriefingSafe(run)
            }
            return {
              content: `FINAL_VERIFICATION_UNVERIFIED: verify/final.json reports PASS but is not stamped by teamwork_final_verify (no usable generatedBy.session, generatedAt, or evidence), so it cannot complete the run.\nRun teamwork_final_verify to compute the verdict from the per-task reports and the security audit and stamp provenance. To accept this hand-written or legacy report instead, re-call teamwork_next with allowUnstamped: true; that is recorded as a bypass event.\n${integrityModeNote}`,
              status: "FINAL_VERIFICATION_UNVERIFIED",
              finalReport: finalFile,
              passedCount: passedTasks.length,
              integrityMode: integrity.mode,
            }
          }

          // Independent victory audit gate: even a stamped PASS (or an explicit
          // legacy unstamped bypass) cannot complete the run without a confirmed
          // verdict bound to the current ORIGINAL_REQUEST.md, unless the plan
          // explicitly recorded victoryAudit: "skip".
          const nextVictoryMode = resolveVictoryAuditMode(plan, state, run)
          const nextVictoryGate = await evaluateVictoryGateChecked(
            run,
            nextVictoryMode.mode === "required" ? "required" : "skip",
            { auth, requireSigned: signedRun, requirementsHash: currentRequirementsHash(run) },
          )
          if (!nextVictoryGate.ok) {
            if (state.phase !== "FINAL_VERIFICATION") {
              state.phase = "FINAL_VERIFICATION"
              writeJson(join(run, "state.json"), state)
              await refreshBriefingSafe(run)
            }
            const rejected = nextVictoryGate.status === "REJECTED"
            return {
              content: `${rejected ? "BLOCKED_BY_VICTORY_AUDIT" : "READY_FOR_VICTORY_AUDIT"}: ${describeVictoryGate(nextVictoryGate)}\nDispatch a fresh team/victory-auditor against ORIGINAL_REQUEST.md and requirements.json, then have it call teamwork_victory_audit with VICTORY CONFIRMED or VICTORY REJECTED. Only after CONFIRMED (or an explicit plan victoryAudit: "skip") may the run report ALL_PASSED.\n${integrityModeNote}`,
              status: rejected ? "BLOCKED_BY_VICTORY_AUDIT" : "READY_FOR_VICTORY_AUDIT",
              finalReport: finalFile,
              passedCount: passedTasks.length,
              integrityMode: integrity.mode,
              victory: nextVictoryGate.status,
              reasons: nextVictoryGate.reasons,
            }
          }

          if (plan?.topology === "document-review" && docManifest) {
            if (docManifest.extractionStatus === "needs_ingestor") {
              return {
                content: `BLOCKED_BY_FINAL_VERIFICATION: document-review extractionStatus is needs_ingestor (readable text required before completion).\n${integrityModeNote}`,
                status: "BLOCKED_BY_FINAL_VERIFICATION",
                integrityMode: integrity.mode,
                finalReport: finalFile,
                passedCount: passedTasks.length,
              }
            }
          }

          let lemmaSymlinkNext = false
          try {
            lemmaSymlinkNext = lstatSync(join(run, "lemma")).isSymbolicLink()
          } catch {}
          const isLemmaRunNext =
            plan?.lemmaMode === true ||
            plan?.route === "lemma" ||
            state?.lemmaMode === true ||
            lemmaSymlinkNext ||
            existsSync(join(run, "lemma", "manifest.json"))
          if (isLemmaRunNext) {
            const liveLemma = evaluateLemmaFinalEvidence(run)
            if (liveLemma.reasons.length > 0) {
              return {
                content: `BLOCKED_BY_FINAL_VERIFICATION: LEMMA evidence on disk no longer satisfies final verification (${liveLemma.reasons.join("; ")}). Re-run teamwork_final_verify after resolving the LEMMA proof/formalization state.\n${integrityModeNote}`,
                status: "BLOCKED_BY_FINAL_VERIFICATION",
                integrityMode: integrity.mode,
                finalReport: finalFile,
                passedCount: passedTasks.length,
                reasons: liveLemma.reasons,
              }
            }
          }

          const wasAlreadyMerge = state.phase === "MERGE" || state.phase === "DONE"
          if (!wasAlreadyMerge) {
            state.phase = "MERGE"
            writeJson(join(run, "state.json"), state)
            await refreshBriefingSafe(run)
          }

          if (!signedRun && !wasAlreadyMerge) {
            const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
            const caller = await deriveCallerAgent(ctx, run, callSession)
            await appendEvent(run, {
              event: "legacy_unsigned_bypass",
              sessionId: basename(run),
              taskId: null,
              to: "ALL_PASSED",
              round: 0,
              agent: caller?.agent ?? null,
              agentSource: caller?.agent ? "session" : undefined,
              phase: state.phase ?? null,
              note: "allowUnsignedLegacy: true completed an unsigned legacy run; artifact _auth envelopes were not verified",
            })
          }

          if (!stamped) {
            // Explicit legacy escape hatch: accept, but record who did it and why.
            const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
            const caller = await deriveCallerAgent(ctx, run, callSession)
            await appendEvent(run, {
              event: "final_verification_bypass",
              sessionId: basename(run),
              taskId: null,
              to: "ALL_PASSED",
              round: 0,
              agent: caller?.agent ?? null,
              agentSource: caller?.agent ? "session" : undefined,
              phase: state.phase ?? null,
              note: "unstamped verify/final.json accepted via allowUnstamped; verdict was not produced by teamwork_final_verify",
            })
            return {
              content: `ALL_TASKS_PASSED: All ${taskDefs.size} tasks have passed verification, security audit PASSED, and verify/final.json reports PASS — but that verdict was not produced by teamwork_final_verify (unstamped hand-written or legacy report). Accepted via allowUnstamped: true; the bypass was recorded in events.jsonl. Ready to merge Sentinel base worktree to user branch and present final artifact.\n${integrityModeNote}`,
              status: "ALL_PASSED",
              integrityMode: integrity.mode,
              passedCount: passedTasks.length,
              securityAuditPassed: true,
              finalReport: finalFile,
              stamped: false,
              unstampedBypass: true,
              victory: nextVictoryGate.status,
            }
          }

          return {
            content: `ALL_TASKS_PASSED: All ${taskDefs.size} tasks have passed verification, security audit PASSED, final verification PASSED, and the victory audit is ${nextVictoryGate.status}. Ready to merge Sentinel base worktree to user branch and present final artifact.\n${integrityModeNote}`,
            status: "ALL_PASSED",
            integrityMode: integrity.mode,
            passedCount: passedTasks.length,
            securityAuditPassed: true,
            finalReport: finalFile,
            stamped: true,
            victory: nextVictoryGate.status,
          }
        }

        if (!readyForWorker.length && !readyForVerifier.length && !inProgress.length) {
          return {
            content: `DEADLOCK_OR_BLOCKED: No tasks can proceed.\nBlocked tasks (${blockedTasks.length}):\n` +
              blockedTasks.map((t) => `  - ${t.id}: ${t.reason}`).join("\n"),
            status: "DEADLOCK",
            blocked: blockedTasks,
          }
        }

        const lines = [`DAG Status for run ${basename(run)}:`]
        if (readyForWorker.length) {
          lines.push(`\n▶ READY FOR WORKER (${readyForWorker.length}): Dispatch worker subagent for each in parallel:`)
          for (const t of readyForWorker) {
            lines.push(`  - Task: ${t.id} (Agent: ${t.agent}, Round: ${t.round}/${t.maxRounds})`)
            lines.push(`    Branch: ${t.branch}`)
            if (t.feedback) lines.push(`    Verifier Feedback: ${clean(t.feedback, 120)}`)
            if (t.avoidPitfalls?.length) {
              lines.push(`    ⚠ Avoid Known Pitfalls: ${t.avoidPitfalls.slice(0, 3).map((p: string) => clean(p, 80)).join("; ")}`)
            }
          }
        }
        if (readyForVerifier.length) {
          lines.push(`\n▶ READY FOR VERIFIER (${readyForVerifier.length}): Dispatch verifier subagent against worker branch:`)
          for (const t of readyForVerifier) {
            lines.push(`  - Task: ${t.id} (Verifier: ${t.agent}, Branch: ${t.branch})`)
          }
        }
        if (inProgress.length) {
          lines.push(`\n⏳ IN PROGRESS (${inProgress.length}):`)
          for (const t of inProgress) {
            lines.push(`  - ${t.id}: ${t.status} (round ${t.round})`)
          }
        }
        lines.push(`\nProgress: ${passedTasks.length}/${taskDefs.size} passed, ${blockedTasks.length} blocked.`)

        return {
          content: lines.join("\n"),
          readyForWorker,
          readyForVerifier,
          inProgress,
          passedCount: passedTasks.length,
          totalTasks: taskDefs.size,
        }
      },
    })

    editor.add({
      name: "task_update",
      description:
        "Update a task's lifecycle status, round, branch, and verification report in state.json. Lifecycle: pending -> worker_active -> worker_done -> verifier_active -> verified_pass | verified_fail | blocked.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          taskId: { type: "string", description: "The task ID defined in plan.dag.json." },
          status: {
            type: "string",
            description: "pending | worker_active | worker_done | verifier_active | verified_pass | verified_fail | blocked",
          },
          agent: {
            type: "string",
            description:
              "Optional. The actor that performed this transition (e.g. team/worker or team/verifier). Recorded in events.jsonl; when omitted the calling session's agent, then the plan-declared agent, is recorded.",
          },
          round: { type: "number" },
          branch: { type: "string" },
          worktree: { type: "string" },
          summary: { type: "string", description: "Short summary of what worker implemented." },
          feedback: { type: "string", description: "Feedback from verifier for the next worker round." },
          verification: {
            type: "object",
            properties: {
              status: { type: "string", description: "PASS | FAIL" },
              passedChecks: { type: "number" },
              totalChecks: { type: "number" },
              fatalFindings: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: ["taskId", "status"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const stateFile = join(run, "state.json")
        const planFile = join(run, "plan.dag.json")
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        const taskId = clean(input.taskId, 64)
        if (!taskId) return { content: "Error: taskId is required" }

        return await withFileLock(stateFile, async () => {
          const state = readJson<any>(run, stateFile, undefined)
          if (!state || typeof state.tasks !== "object") {
            return { content: `Error: No state.json found for run ${basename(run)}.` }
          }
          // SEC-1: null-prototype task map; existence is an OWN-property check, never truthiness.
          state.tasks = nullMap(state.tasks)
          const plan = readJson<any>(run, planFile, undefined)
          const def = Array.isArray(plan?.tasks) ? plan.tasks.find((t: any) => t.id === taskId) : undefined
          if (!def && !Object.prototype.hasOwnProperty.call(state.tasks, taskId)) {
            return { content: `Error: Task "${taskId}" not found in plan or state.` }
          }

          let status = clean(input.status, 32)
          if (status === "pass") status = "verified_pass"
          else if (status === "fail") status = "verified_fail"
          else if (status === "running") status = "worker_active"

          const VALID_STATUSES = new Set([
            "pending",
            "worker_active",
            "worker_done",
            "verifier_active",
            "verified_pass",
            "verified_fail",
            "blocked",
          ])
          // Deterministic transition graph. `blocked` is reachable from every state
          // so escalation can never deadlock; a same-status re-write is always allowed.
          const ALLOWED_NEXT: Record<string, string[]> = {
            pending: ["worker_active", "blocked"],
            worker_active: ["worker_done", "blocked"],
            worker_done: ["verifier_active", "blocked"],
            verifier_active: ["verified_pass", "verified_fail", "blocked"],
            verified_fail: ["worker_active", "blocked"],
            verified_pass: ["blocked"],
            blocked: ["worker_active", "pending"],
          }
          if (!VALID_STATUSES.has(status)) {
            return { content: `Error: Invalid status "${status}". Allowed: ${Array.from(VALID_STATUSES).join(", ")}` }
          }

          const current = state.tasks[taskId] || { status: "pending", round: 0 }
          const fromStatus = typeof current.status === "string" ? current.status : "pending"
          const maxRounds = Number(def?.maxRounds) || 4
          let round = Number.isFinite(input.round) ? Number(input.round) : (Number(current.round) || 0)

          if (status === "worker_active" && !Number.isFinite(input.round)) {
            round = Math.max(1, (Number(current.round) || 0) + (current.status === "verified_fail" ? 1 : 0))
          }

          if ((status === "verified_fail" || status === "fail") && round >= maxRounds) {
            status = "blocked"
          }

          // Legacy aliases in an existing state.json still resolve to the canonical
          // node; an unrecognised status is treated as `pending` (same fail-open
          // default the rest of the engine uses). The event log keeps the raw value.
          const canonicalFrom =
            fromStatus === "pass" ? "verified_pass"
              : fromStatus === "fail" ? "verified_fail"
              : fromStatus === "running" ? "worker_active"
              : VALID_STATUSES.has(fromStatus) ? fromStatus
              : "pending"
          const allowedNext = ALLOWED_NEXT[canonicalFrom] || []
          if (status !== canonicalFrom && !allowedNext.includes(status)) {
            return {
              content: `Error: Illegal transition for task "${taskId}": ${fromStatus} -> ${status}. Allowed next statuses from ${canonicalFrom}: ${allowedNext.join(", ")} (or ${canonicalFrom} again).`,
            }
          }

          // `verified_pass` needs evidence: either an inline PASS verdict or an
          // on-disk verifier report for THIS task. `verified_fail` needs none.
          if (status === "verified_pass") {
            const inlinePass = input.verification?.status === "PASS"
            const reportFile = isSafeTaskId(taskId) ? join(run, "verify", `report-${taskId}.json`) : undefined
            const report = reportFile && existsSync(reportFile) ? readJson<any>(run, reportFile, undefined) : undefined
            if (!inlinePass && report?.status !== "PASS") {
              return {
                content: `Error: Refusing verified_pass for task "${taskId}" without PASS evidence. Provide input.verification.status = "PASS", or write a verifier report at ${reportFile ?? "verify/report-<taskId>.json"} with "status": "PASS".`,
              }
            }
          }

          // 3.6: cumulative feedback ledger. Every non-empty feedback is appended
          // (sanitised) instead of replacing the previous round; verified_pass
          // resolves all entries in the same write, verified_fail leaves them open.
          // The array is capped at 20 entries, oldest dropped first.
          const priorLog: any[] = Array.isArray(current.feedbackLog)
            ? current.feedbackLog
                .filter((e: any) => e && typeof e === "object")
                .map((e: any) => ({
                  round: Number(e.round) || 0,
                  at: clean(e.at, 32),
                  text: clean(e.text, 500),
                  resolved: e.resolved === true,
                }))
            : []
          const feedbackText = input.feedback ? clean(input.feedback, 500) : ""
          if (feedbackText) {
            priorLog.push({ round, at: new Date().toISOString(), text: feedbackText, resolved: false })
          }
          if (status === "verified_pass") {
            for (const e of priorLog) e.resolved = true
          }
          const feedbackLog = priorLog.slice(-20)

          state.tasks[taskId] = {
            ...current,
            status,
            round,
            ...(input.branch ? { branch: clean(input.branch, 120) } : {}),
            ...(input.worktree ? { worktree: clean(input.worktree, 200) } : {}),
            ...(input.summary ? { summary: clean(input.summary, 300) } : {}),
            ...(feedbackText ? { feedback: feedbackText } : {}),
            // Only tasks that have ledger entries gain the field: the state.json
            // shape of a task that never failed stays exactly as before.
            ...(feedbackLog.length || Array.isArray(current.feedbackLog) ? { feedbackLog } : {}),
            ...(input.verification ? { verification: input.verification } : {}),
            updatedAt: new Date().toISOString(),
          }

          const allTasks = Object.values(state.tasks) as any[]
          const allPassed = allTasks.every((t) => t.status === "verified_pass")
          const anyActive = allTasks.some((t) => t.status === "worker_active" || t.status === "verifier_active")
          if (allPassed) {
            const auditFile = join(run, "verify", "security-audit.json")
            const audit = existsSync(auditFile) ? readJson<any>(run, auditFile, undefined) : undefined
            state.phase = audit?.status === "PASS" ? "MERGE" : "SECURITY_AUDIT"
          } else if (!anyActive && allTasks.some((t) => t.status === "blocked")) {
            state.phase = "PRESENT_PARTIAL"
          }

          state.updatedAt = new Date().toISOString()
          writeJson(stateFile, state)

          // Actor precedence (best-effort, fail-open): explicit input.agent, then the
          // calling session's agent, then the plan-declared agent. clean() runs in appendEvent too.
          const explicitAgent = typeof input.agent === "string" ? clean(input.agent, 64).trim() : ""
          const caller = explicitAgent ? undefined : await deriveCallerAgent(ctx, run, callSession)
          const planAgent = def?.agent ? clean(def.agent, 64) : undefined
          const recordedAgent = explicitAgent || caller?.agent || planAgent || null
          const agentSource = explicitAgent ? "explicit" : caller?.agent ? "session" : planAgent ? "plan" : undefined

          // Log what actually landed in state.json (post-normalisation, post-coercion).
          await appendEvent(run, {
            event: "task_transition",
            sessionId: basename(run),
            taskId,
            from: fromStatus,
            to: status,
            round,
            agent: recordedAgent,
            agentSource,
            branch: input.branch ?? current.branch ?? null,
            worktree: input.worktree ?? current.worktree ?? null,
            phase: state.phase ?? null,
          })
          await refreshBriefingSafe(run)

          return {
            // SEC-3: the branch is echoed to the caller, so it is sanitised like every other field.
            content: `Task ${taskId} updated: status=${status}, round=${round}${input.branch ? `, branch=${clean(input.branch, 120)}` : ""}${status === "blocked" ? " (BLOCKED: max rounds reached)" : ""}`,
            taskId,
            status,
            round,
          }
        })
      },
    })

    editor.add({
      name: "security_audit",
      description:
        "Record the findings of team/security-auditor and enforce the pre-merge security gate. Writes verify/security-audit.json. If Critical or High findings exist, or the auditor reports an integrity finding forbidden at the run's mode, marks status as FAIL and blocks final merge.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          status: { type: "string", description: "PASS | FAIL" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                severity: { type: "string", description: "Critical | High | Medium | Low" },
                location: { type: "string" },
                description: { type: "string" },
              },
              required: ["severity", "description"],
            },
          },
          integrityFindings: {
            type: "array",
            description: `Optional. Up to ${INTEGRITY_FINDINGS_MAX} reported integrity-rule violations. An unknown rule refuses the call before anything is written.`,
            items: {
              type: "object",
              properties: {
                rule: { type: "string", description: INTEGRITY_RULE_IDS.join(" | ") },
                where: { type: "string" },
                why: { type: "string" },
              },
              required: ["rule"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", description: "Summary of the security audit." },
        },
        required: ["status"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        // The auditor works from the recorded request, not from its caller: the
        // mode is read from ORIGINAL_REQUEST.md (legacy runs default to development).
        const integrity = readIntegrityMode(run)

        // Sanitise and validate the reported integrity findings BEFORE anything
        // is written. An unknown rule id is refused outright (like a topology
        // typo), listing the accepted ids.
        const integrityFindings = (Array.isArray(input.integrityFindings) ? input.integrityFindings : [])
          .slice(0, INTEGRITY_FINDINGS_MAX)
          .map((f: any) => ({
            rule: clean(f?.rule, 64).trim(),
            where: clean(f?.where, 200),
            why: clean(f?.why, 500),
          }))
        const unknownRule = integrityFindings.find(
          (f: { rule: string }) => !Object.prototype.hasOwnProperty.call(INTEGRITY_RULES, f.rule),
        )
        if (unknownRule) {
          return {
            content: `refused: unknown integrity rule "${clean(unknownRule.rule, 64)}" (accepted: ${INTEGRITY_RULE_IDS.join(", ")}); nothing was written`,
          }
        }

        const integrityViolations = integrityFindings
          .filter((f: { rule: string }) =>
            isIntegrityRuleForbidden(f.rule as IntegrityRule, integrity.mode),
          )
          .map((f: { rule: string; where: string; why: string }) => ({
            ...f,
            forbiddenFrom: INTEGRITY_RULES[f.rule as IntegrityRule].forbiddenFrom,
          }))
        const violationRules = [...new Set(integrityViolations.map((v) => v.rule))]

        const verifyDir = join(run, "verify")
        mkdirSync(verifyDir, { recursive: true })
        const auditFile = join(verifyDir, "security-audit.json")
        const integrityModeNote =
          integrity.source === "artifact"
            ? `Integrity mode: ${integrity.mode} (from ORIGINAL_REQUEST.md).`
            : `Integrity mode: ${integrity.mode} (default applied; no ORIGINAL_REQUEST.md for this run).`

        const findings = Array.isArray(input.findings) ? input.findings : []
        const counts = {
          critical: findings.filter((f: any) => String(f.severity).toLowerCase() === "critical").length,
          high: findings.filter((f: any) => String(f.severity).toLowerCase() === "high").length,
          medium: findings.filter((f: any) => String(f.severity).toLowerCase() === "medium").length,
          low: findings.filter((f: any) => String(f.severity).toLowerCase() === "low").length,
        }

        let status = clean(input.status, 16).toUpperCase()
        // Severity forcing and integrity forcing are independent; either FAILs.
        if (counts.critical > 0 || counts.high > 0) {
          status = "FAIL"
        }
        if (integrityViolations.length > 0) {
          status = "FAIL"
        }

        const report = {
          sessionId: basename(run),
          integrityMode: integrity.mode,
          status,
          timestamp: new Date().toISOString(),
          severityCounts: counts,
          summary: input.summary ? clean(input.summary, 500) : "",
          findings: findings.map((f: any) => ({
            id: clean(f.id || "", 32),
            severity: clean(f.severity, 16),
            location: clean(f.location || "", 120),
            description: clean(f.description, 300),
          })),
          integrityFindings,
          integrityViolations,
        }
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return {
            content: `refused: ${authFailureText(manifestCheck.failure)}; the security audit was not written.`,
            refused: manifestCheck.failure.code,
          }
        }
        let auditToWrite: any = report
        if (manifestCheck.signed) {
          try {
            auditToWrite = await auth!.signRunArtifact(basename(run), "verify/security-audit.json", report)
          } catch (err: any) {
            const failure = err?.failure as AuthFailure | undefined
            return {
              content: `refused: could not sign verify/security-audit.json (${failure ? failure.code : "signing failed"}); the audit was not written.`,
              refused: failure?.code ?? "AUTH_UNAVAILABLE",
            }
          }
        }
        writeJson(auditFile, auditToWrite)

        const stateFile = join(run, "state.json")
        const state = readJson<any>(run, stateFile, undefined)
        if (state) {
          if (status === "PASS") {
            state.phase = "MERGE"
          } else {
            // Append critical/high findings to pitfalls so they become known
            for (const f of findings) {
              if (["critical", "high"].includes(String(f.severity).toLowerCase())) {
                const line = `- [security] ${clean(f.severity, 16).toUpperCase()}: ${clean(f.description, 160)}${f.location ? ` at ${clean(f.location, 64)}` : ""}\n`
                appendFileSync(join(run, "pitfalls.md"), line)
              }
            }
          }
          state.updatedAt = new Date().toISOString()
          writeJson(stateFile, state)
        }

        await appendEvent(run, {
          event: "security_audit",
          sessionId: basename(run),
          to: status,
          phase: state?.phase ?? null,
        })
        await refreshBriefingSafe(run)

        if (status === "FAIL") {
          const violationNote =
            integrityViolations.length > 0
              ? `\nIntegrity violation(s) at mode ${integrity.mode}: ${violationRules.join(", ")}.`
              : ""
          return {
            content: `SECURITY AUDIT FAILED: ${counts.critical} Critical, ${counts.high} High, ${counts.medium} Medium findings.${violationNote} Final merge is BLOCKED until remediated.\n${integrityModeNote}\nReport saved to: ${auditFile}`,
            status: "FAIL",
            integrityMode: integrity.mode,
            reportPath: auditFile,
          }
        }

        return {
          content: `SECURITY AUDIT PASSED: ${findings.length} findings (${counts.medium} Medium, ${counts.low} Low, 0 High/Critical); no forbidden integrity findings at mode ${integrity.mode}. Final merge is APPROVED.\n${integrityModeNote}\nReport saved to: ${auditFile}`,
          status: "PASS",
          integrityMode: integrity.mode,
          reportPath: auditFile,
        }
      },
    })

    editor.add({
      name: "victory_audit",
      description:
        "Record the independent final acceptance verdict from team/victory-auditor. The auditor compares the delivered artifacts and tests against ORIGINAL_REQUEST.md and requirements.json. Only a trusted session whose agent is team/victory-auditor may call it (a caller-supplied label cannot self-authorize). Writes verify/victory.json; a CONFIRMED verdict is write-once.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Teamwork session id (defaults to the active run)." },
          verdict: { type: "string", description: "VICTORY CONFIRMED | VICTORY REJECTED" },
          requirements: {
            type: "array",
            description: "One result for every id in requirements.json, exactly once. met requires non-empty evidence.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                met: { type: "boolean" },
                evidence: { type: "string" },
              },
              required: ["id", "met", "evidence"],
              additionalProperties: false,
            },
          },
          findings: {
            type: "array",
            items: { type: "string" },
            description: "Optional. Up to 50 concrete gaps found during the audit.",
          },
          summary: { type: "string", description: "Optional. The auditor's prose (max 2000 chars)." },
        },
        required: ["verdict", "requirements"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
        // Authorization follows the trusted session identity only. There is no
        // `agent` input: a caller cannot label itself the victory auditor.
        const caller = callSession ? await deriveCallerAgent(ctx, run, callSession) : undefined
        if (!caller || caller.agent !== VICTORY_AUDITOR_AGENT) {
          return {
            content: `refused: victory_audit must be called by ${VICTORY_AUDITOR_AGENT} (trusted session agent: ${caller?.agent ? clean(caller.agent, 64) : "unknown"}); nothing was written`,
          }
        }
        if (!callSession) {
          return { content: "refused: victory_audit needs a trusted session identity; nothing was written" }
        }
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return { content: `refused: ${authFailureText(manifestCheck.failure)}; nothing was written` }
        }
        const vPlan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const vState = readJson<any>(run, join(run, "state.json"), undefined)
        const rootSessionId = recordedRootSessionId(manifestCheck.signed ? manifestCheck.manifest : undefined, vPlan, vState)
        const ancestry = await requireDescendantSession(ctx, rootSessionId, callSession)
        if (!ancestry.ok) {
          return {
            content: `refused: victory_audit must be called from a session that descends from the run root (${clean(rootSessionId ?? "unrecorded", 64)}); ${ancestry.reason}; nothing was written`,
          }
        }
        const result = await recordVictoryAudit(
          run,
          basename(run),
          {
            verdict: input.verdict,
            requirements: input.requirements,
            findings: input.findings,
            summary: input.summary,
            auditorSessionId: callSession,
          },
          manifestCheck.signed ? auth : undefined,
        )
        if (!result.ok) return { content: result.error }
        const state = readJson<any>(run, join(run, "state.json"), undefined)
        await appendEvent(run, {
          event: "victory_audit",
          sessionId: basename(run),
          taskId: null,
          to: result.verdict.verdict,
          round: 0,
          agent: VICTORY_AUDITOR_AGENT,
          agentSource: "session",
          phase: state?.phase ?? null,
        })
        await refreshBriefingSafe(run)
        return {
          content: `VICTORY AUDIT RECORDED: ${result.verdict.verdict} (${result.verdict.requirements.length} requirement(s)).\nArtifact: ${join(run, "verify", "victory.json")}`,
          verdict: result.verdict,
          artifact: join(run, "verify", "victory.json"),
        }
      },
    })

    editor.add({
      name: "wave_record",
      description:
        "Record one strict-verification verdict. Only team/falsifier may record kind=challenge (verdict PASS) and only team/security-auditor may record kind=audit (verdict CLEAN); the caller identity is derived from the trusted session and cannot be supplied as an input. Requires the task to exist and its verify/report-<taskId>.json to be PASS, binds the verdict to that report's sha256, writes verify/challenge-<taskId>.json or verify/audit-<taskId>.json atomically, appends a verification_wave event, and refuses re-recording the same report (a changed report is the only overwrite path).",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          taskId: { type: "string", description: "The task ID defined in plan.dag.json." },
          kind: { type: "string", description: "challenge | audit." },
          verdict: { type: "string", description: "challenge: PASS; audit: CLEAN. Any other value is refused." },
          notes: { type: "string", description: "Optional adversarial notes (max 1000 chars, sanitized)." },
          evidence: { type: "string", description: "Optional evidence pointer (max 2000 chars, sanitized)." },
        },
        required: ["sessionId", "taskId", "kind", "verdict"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const kind = normalizeWaveKind(input?.kind)
        if (!kind) {
          return {
            content: `refused: invalid strict-wave kind "${clean(input?.kind, 32)}" (expected challenge | audit); nothing was written`,
          }
        }
        // Authorization follows the trusted session identity only. There is no
        // `agent` input: a caller cannot label itself the falsifier or auditor.
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
        const caller = callSession ? await deriveCallerAgent(ctx, run, callSession) : undefined
        const expectedAgent = WAVE_AGENTS[kind]
        if (!caller || caller.agent !== expectedAgent) {
          return {
            content: `refused: a ${kind} verdict must be recorded by ${expectedAgent} (trusted session agent: ${caller?.agent ? clean(caller.agent, 64) : "unknown"}); nothing was written`,
          }
        }
        if (!callSession) {
          return { content: "refused: wave_record needs a trusted session identity; nothing was written" }
        }
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return { content: `refused: ${authFailureText(manifestCheck.failure)}; nothing was written` }
        }
        const wPlan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const wState = readJson<any>(run, join(run, "state.json"), undefined)
        const rootSessionId = recordedRootSessionId(manifestCheck.signed ? manifestCheck.manifest : undefined, wPlan, wState)
        const ancestry = await requireDescendantSession(ctx, rootSessionId, callSession)
        if (!ancestry.ok) {
          return {
            content: `refused: wave_record must be called from a session that descends from the run root (${clean(rootSessionId ?? "unrecorded", 64)}); ${ancestry.reason}; nothing was written`,
          }
        }
        const result = await recordVerificationWave(
          run,
          basename(run),
          {
            taskId: input?.taskId,
            kind,
            verdict: input?.verdict,
            notes: input?.notes,
            evidence: input?.evidence,
            agent: caller.agent,
            agentSessionId: callSession,
          },
          manifestCheck.signed ? auth : undefined,
        )
        if (!result.ok) return { content: result.error }
        const state = readJson<any>(run, join(run, "state.json"), undefined)
        await appendEvent(run, {
          event: "verification_wave",
          sessionId: basename(run),
          taskId: result.verdict.taskId,
          to: result.verdict.verdict,
          round: 0,
          agent: expectedAgent,
          agentSource: "session",
          phase: state?.phase ?? null,
          note: `${kind}: ${result.verdict.verdict}`,
        })
        return {
          content: `STRICT WAVE RECORDED: ${kind}=${result.verdict.verdict} for ${result.verdict.taskId} by ${expectedAgent}.\nArtifact: ${result.artifact}`,
          verdict: result.verdict,
          artifact: result.artifact,
        }
      },
    })

    editor.add({
      name: "report",
      description:
        "Trusted writer for verify/report-<taskId>.json. Only a session whose trusted agent is team/verifier, descending from the run root, may call it. The task must exist in plan.dag.json and a PASS report must carry evidence (a summary or checks). The report is signed for a signed run (run.manifest.json) and indexed in ctx.storage; final_verify requires that signature. A wrong agent, a missing task, or evidence-free PASS is refused.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          taskId: { type: "string", description: "Task id from plan.dag.json." },
          status: { type: "string", description: "PASS | FAIL." },
          summary: { type: "string", description: "Optional verifier prose (max 2000 chars, sanitized)." },
          checks: {
            type: "array",
            description: "Optional list of named checks. A PASS without a summary needs at least one check.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                passed: { type: "boolean" },
              },
              required: ["name", "passed"],
              additionalProperties: true,
            },
          },
          fatalFindings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                where: { type: "string" },
                why: { type: "string" },
                fix: { type: "string" },
              },
              required: ["why"],
              additionalProperties: true,
            },
          },
          feedbackForWorker: { type: "string", description: "Optional remediation notes (max 4000 chars)." },
          evidence: { type: "string", description: "Optional evidence pointer (max 2000 chars)." },
        },
        required: ["sessionId", "taskId", "status"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
        const caller = callSession ? await deriveCallerAgent(ctx, run, callSession) : undefined
        if (!caller || caller.agent !== "team/verifier") {
          return {
            content: `refused: teamwork_report must be called by team/verifier (trusted session agent: ${caller?.agent ? clean(caller.agent, 64) : "unknown"}); nothing was written`,
          }
        }
        if (!callSession) {
          return { content: "refused: teamwork_report needs a trusted session identity; nothing was written" }
        }
        const taskId = input?.taskId
        if (!isSafeTaskId(taskId)) {
          return { content: `refused: invalid task id "${clean(taskId, 32)}"; nothing was written` }
        }
        const status = clean(input?.status, 16).toUpperCase()
        if (status !== "PASS" && status !== "FAIL") {
          return { content: `refused: report status must be PASS | FAIL (got "${clean(input?.status, 32)}"); nothing was written` }
        }
        const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const planIds = Array.isArray(plan?.tasks)
          ? plan.tasks.map((t: any) => t?.id).filter((id: unknown) => typeof id === "string")
          : []
        if (!planIds.includes(taskId)) {
          return { content: `refused: task "${clean(taskId, 64)}" is not in plan.dag.json; nothing was written` }
        }
        const checks = Array.isArray(input?.checks)
          ? input.checks.slice(0, 100).map((c: any) => ({
              name: clean(c?.name, 200),
              type: clean(c?.type, 64) || "check",
              passed: c?.passed === true,
            }))
          : []
        const summary = typeof input?.summary === "string" ? cleanBlock(input.summary, 2000).trim() : ""
        if (status === "PASS" && summary === "" && checks.length === 0) {
          return { content: "refused: a PASS report needs evidence — provide a non-empty summary or at least one check; nothing was written" }
        }
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return { content: `refused: ${authFailureText(manifestCheck.failure)}; nothing was written` }
        }
        const state = readJson<any>(run, join(run, "state.json"), undefined)
        const rootSessionId = recordedRootSessionId(manifestCheck.signed ? manifestCheck.manifest : undefined, plan, state)
        const ancestry = await requireDescendantSession(ctx, rootSessionId, callSession)
        if (!ancestry.ok) {
          return {
            content: `refused: teamwork_report must be called from a session that descends from the run root (${clean(rootSessionId ?? "unrecorded", 64)}); ${ancestry.reason}; nothing was written`,
          }
        }
        const fatalFindings = Array.isArray(input?.fatalFindings)
          ? input.fatalFindings.slice(0, 50).map((f: any) => ({
              where: clean(f?.where, 200),
              why: clean(f?.why, 500),
              fix: clean(f?.fix, 500),
            }))
          : []
        const report: any = {
          taskId,
          status,
          verifierAgent: "team/verifier",
          verifierSessionId: callSession,
          timestamp: new Date().toISOString(),
          summary,
          checks,
          fatalFindings,
          feedbackForWorker: typeof input?.feedbackForWorker === "string" ? cleanBlock(input.feedbackForWorker, 4000).trim() : "",
          evidence: typeof input?.evidence === "string" ? cleanBlock(input.evidence, 2000).trim() : "",
          requirementsHash: currentRequirementsHash(run),
        }
        const relativePath = `verify/report-${taskId}.json`
        let toWrite: any = report
        if (manifestCheck.signed) {
          try {
            toWrite = await auth!.signRunArtifact(basename(run), relativePath, report)
          } catch (err: any) {
            const failure = err?.failure as AuthFailure | undefined
            return {
              content: `refused: could not sign ${relativePath} (${failure ? failure.code : "signing failed"}); nothing was written`,
              refused: failure?.code ?? "AUTH_UNAVAILABLE",
            }
          }
        }
        try {
          writeJsonSafe(run, join(run, relativePath), toWrite)
        } catch (err: any) {
          return { content: `refused: could not write ${relativePath} (${clean(err?.message, 140)}); nothing was written` }
        }
        await appendEvent(run, {
          event: "verifier_report",
          sessionId: basename(run),
          taskId,
          to: status,
          round: 0,
          agent: "team/verifier",
          agentSource: "session",
          phase: state?.phase ?? null,
        })
        return {
          content: `VERIFIER REPORT WRITTEN: ${taskId} ${status}${manifestCheck.signed ? " (signed)" : " (unsigned legacy)"}.\nArtifact: ${join(run, relativePath)}`,
          report: toWrite,
          artifact: join(run, relativePath),
          signed: manifestCheck.signed,
        }
      },
    })

    editor.add({
      name: "final_verify",
      description:
        "Compute and stamp the run's final verdict from artifacts. PASS requires every task to be verified_pass, every verify/report-<taskId>.json to be PASS, verify/security-audit.json to be PASS, and (unless the plan explicitly skipped it) a CONFIRMED independent victory audit bound to the current ORIGINAL_REQUEST.md. In strict mode it also requires verify/challenge-<taskId>.json (team/falsifier, PASS) and verify/audit-<taskId>.json (team/security-auditor, CLEAN) for every task, both bound by reportHash to the current verifier report, and writes GATE_STATUS.md. Writes verify/final.json atomically and appends a final_verification event. The verdict is computed from evidence and cannot be overridden by input.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          summary: { type: "string", description: "Optional. The verifier's prose; recorded in verify/final.json (max 2000 chars)." },
          findings: {
            type: "array",
            description: "Optional. Up to 50 findings; recorded in verify/final.json.",
            items: {
              type: "object",
              properties: {
                where: { type: "string" },
                why: { type: "string" },
                fix: { type: "string" },
              },
              required: ["where", "why", "fix"],
              additionalProperties: false,
            },
          },
          failReason: { type: "string", description: "Optional. A reason to force FAIL; appended to the computed reasons." },
          allowUnsignedLegacy: {
            type: "boolean",
            description:
              "Default false. For a run with no signed run.manifest.json, an explicit legacy bypass is required before final_verify will consider the artifacts. The bypass is recorded as a legacy_unsigned_bypass event. A signed run never accepts this.",
          },
        },
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const finalFile = join(run, "verify", "final.json")
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        return await withFileLock(finalFile, async () => {
          const caller = await deriveCallerAgent(ctx, run, callSession)
          const state = readJson<any>(run, join(run, "state.json"), undefined)
          if (!state || typeof state.tasks !== "object") {
            return { content: `Error: No state.json found for run ${basename(run)}.` }
          }
          const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
          const manifestCheck = await readRunManifest(run, auth)
          if (!manifestCheck.ok) {
            return {
              status: "FAIL",
              auth: manifestCheck.failure.code,
              content: `FINAL VERIFICATION FAILED: [${manifestCheck.failure.code}] ${manifestCheck.failure.message}. Final merge is BLOCKED.`,
              reasons: [authFailureText(manifestCheck.failure)],
            }
          }
          const allowUnsignedLegacy = input?.allowUnsignedLegacy === true
          const signedRun = manifestCheck.signed
          const legacyUnsignedBlock = !signedRun && !allowUnsignedLegacy
          if (!signedRun && allowUnsignedLegacy) {
            await appendEvent(run, {
              event: "legacy_unsigned_bypass",
              sessionId: basename(run),
              taskId: null,
              to: "final_verify",
              round: 0,
              agent: caller?.agent ?? null,
              agentSource: caller?.agent ? "session" : undefined,
              phase: state.phase ?? null,
              note: "allowUnsignedLegacy: true accepted an unsigned legacy run; artifact _auth envelopes are not verified",
            })
          }
          const requireSigned = signedRun
          if (signedRun) {
            const drift = currentManifestDrift(manifestCheck.manifest, plan, state, run)
            if (drift.length > 0) {
              return {
                status: "FAIL",
                auth: "AUTH_STALE",
                content: `FINAL VERIFICATION FAILED: the run drifted from its signed baseline: ${drift.map(manifestDriftReason).join("; ")}. Final merge is BLOCKED.`,
                reasons: drift.map(manifestDriftReason),
              }
            }
          }
          // SEC-1: null-prototype map; ids are read as data, never used as paths
          // unless they pass isSafeTaskId.
          const taskStates = nullMap<any>(state.tasks)
          const planIds: string[] = Array.isArray(plan?.tasks)
            ? plan.tasks.map((t: any) => t?.id).filter((id: any) => typeof id === "string")
            : []
          const ids: string[] = []
          for (const id of [...planIds, ...Object.keys(taskStates)]) {
            if (!ids.includes(id)) ids.push(id)
          }

          // Evidence comes from disk only; no input can supply or alter it.
          const tasks: Array<{ id: string; status: string; report: string | null; reportStatus: string }> = []
          const reportDigests: Record<string, string | null> = Object.create(null)
          const authReasons: string[] = []
          for (const id of ids) {
            const safe = isSafeTaskId(id)
            const reportRel = safe ? `verify/report-${id}.json` : null
            const report = reportRel ? readJson<any>(run, join(run, reportRel), undefined) : undefined
            const rawStatus = taskStates[id]?.status
            tasks.push({
              id: clean(id, 64),
              status: typeof rawStatus === "string" ? clean(rawStatus, 32) : "pending",
              report: reportRel,
              reportStatus:
                report?.status === "PASS" ? "PASS" : report?.status === "FAIL" ? "FAIL" : "MISSING",
            })
            if (reportRel) {
              const raw = readBoundedRunFile(run, join(run, reportRel), MAX_RUN_FILE_BYTES)
              reportDigests[clean(id, 64)] =
                raw.status === "ok" ? sha256Hex(raw.text) : null
              if (requireSigned && raw.status === "ok" && report) {
                const check = auth
                  ? await auth.verifyRunArtifact(basename(run), reportRel, report)
                  : {
                      status: "unknown" as const,
                      failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                    }
                if (check.status === "unsigned") {
                  authReasons.push(`task ${id}: [AUTH_MISSING] ${reportRel} has no _auth envelope (a signed run requires one)`)
                } else if (check.status !== "signed") {
                  const failure = check.failure ?? { code: "AUTH_INVALID" as const, message: "report failed verification" }
                  authReasons.push(`task ${id}: [${failure.code}] ${failure.message}`)
                }
              }
            }
          }
          const audit = readJson<any>(run, join(run, "verify", "security-audit.json"), undefined)
          const securityAudit = {
            path: "verify/security-audit.json",
            status: audit?.status === "PASS" ? "PASS" : audit?.status === "FAIL" ? "FAIL" : "MISSING",
          }
          const auditRaw = readBoundedRunFile(run, join(run, "verify", "security-audit.json"), MAX_RUN_FILE_BYTES)
          const auditDigest = auditRaw.status === "ok" ? sha256Hex(auditRaw.text) : null
          if (requireSigned && audit) {
            const check = auth
              ? await auth.verifyRunArtifact(basename(run), "verify/security-audit.json", audit)
              : {
                  status: "unknown" as const,
                  failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                }
            if (check.status === "unsigned") {
              authReasons.push("[AUTH_MISSING] verify/security-audit.json has no _auth envelope (a signed run requires one)")
            } else if (check.status !== "signed") {
              const failure = check.failure ?? { code: "AUTH_INVALID" as const, message: "security audit failed verification" }
              authReasons.push(`[${failure.code}] ${failure.message}`)
            }
          }
          const allTasksVerifiedPass = tasks.length > 0 && tasks.every((t) => t.status === "verified_pass")

          const reasons: string[] = []
          if (legacyUnsignedBlock) {
            reasons.push(
              "[AUTH_LEGACY] this run has no signed run.manifest.json; re-call teamwork_final_verify with allowUnsignedLegacy: true to record an explicit legacy bypass",
            )
          }
          if (tasks.length === 0) reasons.push("no tasks in plan or state")
          for (const t of tasks) {
            if (t.status !== "verified_pass") reasons.push(`task ${t.id}: state status ${t.status} (not verified_pass)`)
            if (t.reportStatus !== "PASS") reasons.push(`task ${t.id}: report ${t.reportStatus}`)
          }
          if (securityAudit.status !== "PASS") reasons.push(`security audit: ${securityAudit.status}`)
          reasons.push(...authReasons)

          // Opt-in strict wave: recompute the per-task challenge/audit evidence.
          // A missing or non-PASS/CLEAN verdict is a named FAIL reason. Standard
          // mode is a no-op, so its verdict and artifacts are unchanged.
          const verificationMode = resolveVerificationMode(plan, state).mode
          const strictGate = await evaluateStrictGateChecked(
            run,
            tasks.filter((t) => t.report !== null).map((t) => ({ id: t.id, status: t.status })),
            verificationMode,
            { auth, requireSigned },
          )
          if (!strictGate.skipped) reasons.push(...strictGate.reasons)

          let documentReviewEvidence:
            | { checked: boolean; segmentReportsComplete: boolean; finalReportPresent: boolean }
            | undefined
          if (plan?.topology === "document-review") {
            const manifestPath = join(run, "document-review", "manifest.json")
            const mRes = readRegularJson<any>(run, manifestPath)
            if (!mRes.ok && mRes.reason === "missing") {
              reasons.push("document-review/manifest.json missing")
              documentReviewEvidence = { checked: true, segmentReportsComplete: false, finalReportPresent: false }
            } else if (!mRes.ok && mRes.reason === "symlink") {
              reasons.push("document-review/manifest.json is a symlink")
              documentReviewEvidence = { checked: true, segmentReportsComplete: false, finalReportPresent: false }
            } else if (!mRes.ok && mRes.reason === "invalid") {
              reasons.push("document-review/manifest.json is unreadable or malformed")
              documentReviewEvidence = { checked: true, segmentReportsComplete: false, finalReportPresent: false }
            } else if (mRes.ok) {
              const docManifest = mRes.data
              const segs = Array.isArray(docManifest?.segments) ? docManifest.segments : []
              let allUnitReportsOk = segs.length > 0
              if (segs.length === 0) {
                reasons.push("document-review/manifest.json has no segments")
              }
              if (docManifest?.extractionStatus === "needs_ingestor") {
                reasons.push("document-review extractionStatus is needs_ingestor (readable text required before final PASS)")
                allUnitReportsOk = false
              }
              const plannedSegIds = planIds.filter((id) => id !== "doc-synthesis")
              const manifestSegIds = new Set<string>(segs.map((s: any) => String(s?.id || "")))
              for (const pid of plannedSegIds) {
                if (!manifestSegIds.has(pid)) {
                  reasons.push(`document-review planned segment ${pid} is missing from manifest.json`)
                  allUnitReportsOk = false
                }
              }
              for (const mid of manifestSegIds) {
                if (mid && !plannedSegIds.includes(mid)) {
                  reasons.push(`document-review manifest segment ${mid} is missing from plan.dag.json`)
                  allUnitReportsOk = false
                }
              }
              const isRegularNonEmpty = (file: string): boolean => {
                const res = readBoundedRunFile(run, file, MAX_RUN_FILE_BYTES)
                return res.status === "ok" && res.text.trim().length > 0
              }
              for (const seg of segs) {
                if (!isSafeSegmentId(seg?.id)) {
                  reasons.push(`document-review manifest has unsafe segment id "${clean(seg?.id, 32)}"`)
                  allUnitReportsOk = false
                  continue
                }
                const unitPath = join(run, "document-review", "segments", seg.id, "unit-report.md")
                if (!isRegularNonEmpty(unitPath)) {
                  reasons.push(`document-review segment ${seg.id}: unit-report.md missing or empty`)
                  allUnitReportsOk = false
                }
              }
              const finalDocPath = join(run, "DOCUMENT_REVIEW_REPORT.md")
              const finalReportPresent = isRegularNonEmpty(finalDocPath)
              if (!finalReportPresent) {
                reasons.push("DOCUMENT_REVIEW_REPORT.md missing or empty")
              }
              documentReviewEvidence = {
                checked: true,
                segmentReportsComplete: allUnitReportsOk,
                finalReportPresent,
              }
            }
          }
          let lemmaSymlink = false
          try {
            lemmaSymlink = lstatSync(join(run, "lemma")).isSymbolicLink()
          } catch {}
          const isLemmaRun =
            plan?.lemmaMode === true ||
            plan?.route === "lemma" ||
            state?.lemmaMode === true ||
            lemmaSymlink ||
            existsSync(join(run, "lemma", "manifest.json"))
          const lemmaEvidence = isLemmaRun ? evaluateLemmaFinalEvidence(run) : undefined
          if (lemmaEvidence) {
            reasons.push(...lemmaEvidence.reasons)
          }
          if (context?.signal?.aborted) {
            reasons.push("request aborted via AbortSignal")
          }

          let tournamentEvidence: Record<string, unknown> | undefined
          const tournamentPresent =
            plan?.topology === "massive-proof" &&
            (!!plan?.tournament ||
              existsSync(join(run, "tournament")) ||
              (() => {
                try {
                  return lstatSync(join(run, "tournament")).isSymbolicLink()
                } catch {
                  return false
                }
              })())
          if (tournamentPresent) {
            const mFile = manifestPathOf(run)
            try {
              await withFileLock(mFile, async () => {
                const mRes = readTournamentManifest(run)
                if (mRes.status === "ok" && TOURNAMENT_ACTIVE_PHASES.has(mRes.manifest.phase) && context?.signal?.aborted) {
                  const callerAbort = await deriveCallerAgent(ctx, run, callSession)
                  const partial = finalizeTournamentPartial(run, mRes.manifest, {
                    trigger: "signal",
                    reason: "Aborted via AbortSignal",
                    phase: "CANCELLED",
                    cancelledBy: callerAbort?.agent ?? null,
                  })
                  if (!partial.alreadyFinalized) {
                    await appendEvent(run, {
                      event: "tournament_cancelled",
                      sessionId: basename(run),
                      taskId: null,
                      from: null,
                      to: "CANCELLED",
                      round: mRes.manifest.iteration,
                      agent: callerAbort?.agent ?? null,
                      agentSource: callerAbort?.agent ? "session" : undefined,
                      phase: "PRESENT_PARTIAL",
                      note: "Aborted via AbortSignal",
                    })
                  }
                }
              })
            } catch (err: any) {
              const msg = typeof err?.message === "string" ? err.message : String(err)
              if (isUnsafePathError(msg)) {
                return {
                  status: "FAIL",
                  content: msg.startsWith("refused:") ? msg : `refused: ${msg}`,
                  refused: "unsafe_path",
                }
              }
              throw err
            }

            const mRes = readTournamentManifest(run)
            const vRes = readTournamentVerdict(run)
            const rRes = readBoundedRunFile(run, reportPathOf(run), MAX_REPORT_BYTES)

            if (mRes.status !== "ok") {
              reasons.push(mRes.status === "error" ? mRes.error : "tournament/manifest.json missing")
              tournamentEvidence = {
                phase: "MISSING",
                partial: true,
                cancellationReason: mRes.status === "error" ? mRes.error : null,
                totalCandidates: 0,
                survivingCandidates: 0,
                winnerId: null,
                topScore: null,
                refereeAgent: null,
                verdictPath: "tournament/verdict.json",
                reportPath: "TOURNAMENT_REPORT.md",
              }
            } else {
              const m = mRes.manifest
              const cands = Object.values(m.candidates || {})
              const surviving = cands.filter((c) => c && c.status !== "pruned").length
              const v = vRes.status === "ok" ? vRes.verdict : null
              const ranked = Array.isArray(v?.rankedCandidates) ? v.rankedCandidates : m.rankedCandidates
              const winnerId = v?.winnerId ?? null
              const winnerNode = winnerId && Object.prototype.hasOwnProperty.call(m.candidates, winnerId) ? m.candidates[winnerId] : null
              const topScore = ranked.length > 0 && typeof ranked[0].score === "number" ? ranked[0].score : null

              if (m.phase !== "COMPLETED") {
                reasons.push(
                  m.cancelled
                    ? `tournament ${m.phase}: ${m.cancelled.reason}`
                    : `tournament incomplete (phase ${m.phase})`,
                )
              }
              if (vRes.status !== "ok") {
                reasons.push(vRes.status === "error" ? vRes.error : "tournament/verdict.json missing")
              } else {
                if (v!.status !== "PASS" || v!.verdict !== "ACCEPT") {
                  reasons.push(`tournament verdict is ${v!.status} (${v!.verdict})`)
                }
                if (v!.refereeAgent !== "team/referee") {
                  reasons.push(`tournament verdict refereeAgent must be team/referee (got ${clean(v!.refereeAgent, 32)})`)
                }
                if (!Array.isArray(v!.rankedCandidates) || v!.rankedCandidates.length === 0) {
                  reasons.push("tournament verdict has no rankedCandidates")
                }
                if (!winnerId || !winnerNode || winnerNode.status === "pruned") {
                  reasons.push("tournament verdict has no valid non-pruned winnerId")
                }
              }
              if (rRes.status !== "ok" || !rRes.text.trim()) {
                reasons.push(rRes.status === "error" ? rRes.error : "TOURNAMENT_REPORT.md missing or empty")
              }

              tournamentEvidence = {
                phase: m.phase,
                partial: m.phase !== "COMPLETED",
                cancellationReason: m.cancelled?.reason ?? null,
                totalCandidates: cands.length,
                survivingCandidates: surviving,
                winnerId,
                topScore,
                refereeAgent: v?.refereeAgent ?? null,
                verdictPath: "tournament/verdict.json",
                reportPath: "TOURNAMENT_REPORT.md",
              }
            }
          }

          // Independent victory audit: required unless the plan explicitly opted
          // out. The verdict binds to the current ORIGINAL_REQUEST.md hash, so a
          // deleted/edited request or a stale audit cannot complete a run.
          const victoryMode = resolveVictoryAuditMode(plan, state, run).mode
          const victoryGate = await evaluateVictoryGateChecked(run, victoryMode, {
            auth,
            requireSigned,
            requirementsHash: currentRequirementsHash(run),
          })
          if (!victoryGate.ok) reasons.push(...victoryGate.reasons)

          // A supplied failReason can only make the verdict fail, never pass it.
          const failReason = typeof input?.failReason === "string" ? clean(input.failReason, 500).trim() : ""
          if (failReason) reasons.push(failReason)

          // Bound both the artifact and the message; 100 conditions is already far
          // beyond a useful verdict.
          const integrity = readIntegrityMode(run)
          // The signal can abort while deriveCallerAgent waits; never stamp PASS
          // from a request that was cancelled after the first check.
          if (context?.signal?.aborted && !reasons.includes("request aborted via AbortSignal")) {
            reasons.push("request aborted via AbortSignal")
          }
          let status: "PASS" | "FAIL" = reasons.length === 0 ? "PASS" : "FAIL"
          let cappedReasons = reasons.slice(0, 100)
          const summary = typeof input?.summary === "string" ? clean(input.summary, 2000).trim() : ""
          const findings = Array.isArray(input?.findings)
            ? input.findings.slice(0, 50).map((f: any) => ({
                where: clean(f?.where, 200),
                why: clean(f?.why, 500),
                fix: clean(f?.fix, 500),
              }))
            : []

          // Strict mode writes a sanitized GATE_STATUS.md table. A failure to
          // write the required artifact is itself a FAIL reason, so a symlinked
          // or unwritable path can never leave a PASS without its evidence.
          if (!strictGate.skipped) {
            const gateFile = join(run, "GATE_STATUS.md")
            try {
              writeSafeRunFile(
                run,
                gateFile,
                renderGateStatus({
                  sessionId: basename(run),
                  finalStatus: status,
                  gate: strictGate,
                  reasons: cappedReasons,
                }),
              )
            } catch (err: any) {
              reasons.push(`strict gate: could not write GATE_STATUS.md (${clean(err?.message, 120)})`)
              status = "FAIL"
              cappedReasons = reasons.slice(0, 100)
              try {
                writeSafeRunFile(
                  run,
                  gateFile,
                  renderGateStatus({
                    sessionId: basename(run),
                    finalStatus: "FAIL",
                    gate: strictGate,
                    reasons: cappedReasons,
                  }),
                )
              } catch {}
            }
          }

          const victoryRecord = victoryGate.skipped
            ? "SKIPPED (explicit)"
            : victoryGate.ok
              ? "CONFIRMED"
              : "FAILED"
          const finalPayload: any = {
            status,
            generatedBy: { agent: caller?.agent ?? null, session: callSession || basename(run) },
            generatedAt: new Date().toISOString(),
            integrityMode: integrity.mode,
            victory: victoryRecord,
            requirementsHash: currentRequirementsHash(run),
            evidence: {
              tasks,
              securityAudit,
              allTasksVerifiedPass,
              reportDigests,
              auditDigest,
              victory: victoryGate.skipped
                ? { mode: "skip", status: victoryGate.status, reasons: [] }
                : victoryGate.ok
                  ? {
                      mode: "required",
                      status: victoryGate.status,
                      auditor: victoryGate.verdict.auditor,
                      auditorSessionId: victoryGate.verdict.auditorSessionId,
                      requestHash: victoryGate.verdict.requestHash,
                      requirementsHash: (victoryGate.verdict as any).requirementsHash ?? null,
                    }
                  : { mode: "required", status: victoryGate.status, reasons: victoryGate.reasons },
              ...(documentReviewEvidence ? { documentReview: documentReviewEvidence } : {}),
              ...(lemmaEvidence ? { lemma: lemmaEvidence } : {}),
              ...(tournamentEvidence ? { tournament: tournamentEvidence } : {}),
              ...(verificationMode === "strict"
                ? {
                    strict: {
                      mode: "strict",
                      status: strictGate.status,
                      missing: strictGate.missing,
                      reasons: strictGate.reasons,
                      tasks: strictGate.tasks.map((t) => ({
                        id: t.id,
                        report: `verify/report-${t.id}.json`,
                        reportStatus: t.reportStatus,
                        challenge: {
                          path: t.challenge.path,
                          status: t.challenge.verdict,
                          agent: t.challenge.agent,
                          reportHash: t.challenge.reportHash,
                          ok: t.challenge.ok,
                        },
                        audit: {
                          path: t.audit.path,
                          status: t.audit.verdict,
                          agent: t.audit.agent,
                          reportHash: t.audit.reportHash,
                          ok: t.audit.ok,
                        },
                      })),
                    },
                  }
                : {}),
            },
            reasons: cappedReasons,
            ...(summary ? { summary } : {}),
            ...(findings.length ? { findings } : {}),
          }
          let finalToWrite: any = finalPayload
          if (signedRun) {
            try {
              finalToWrite = await auth!.signRunArtifact(basename(run), "verify/final.json", finalPayload)
            } catch (err: any) {
              const failure = err?.failure as AuthFailure | undefined
              return {
                status: "FAIL",
                auth: failure?.code ?? "AUTH_UNAVAILABLE",
                content: `FINAL VERIFICATION FAILED: could not sign verify/final.json (${failure ? failure.code : "signing failed"}). Final merge is BLOCKED.`,
                reasons: [`[${failure?.code ?? "AUTH_UNAVAILABLE"}] could not sign verify/final.json`],
              }
            }
          }
          refuseSymlink(finalFile)
          writeJson(finalFile, finalToWrite)

          await appendEvent(run, {
            event: "final_verification",
            sessionId: basename(run),
            taskId: null,
            to: status,
            round: 0,
            agent: caller?.agent ?? null,
            agentSource: caller?.agent ? "session" : undefined,
            phase: state.phase ?? null,
          })
          await refreshBriefingSafe(run)

          const integrityModeNote =
            integrity.source === "artifact"
              ? `Integrity mode: ${integrity.mode} (from ORIGINAL_REQUEST.md).`
              : `Integrity mode: ${integrity.mode} (default applied; no ORIGINAL_REQUEST.md for this run).`
          const evidenceLine = `Evidence: ${tasks.length} task(s), allTasksVerifiedPass=${allTasksVerifiedPass}, security audit ${securityAudit.status}, ${verificationMode === "strict" ? `strict wave ${strictGate.status}, ` : ""}${describeVictoryGate(victoryGate)}`

          if (status === "FAIL") {
            return {
              content: `FINAL VERIFICATION FAILED: ${reasons.length} unmet condition(s). Final merge is BLOCKED.\nReasons:\n${cappedReasons.map((r) => `  - ${r}`).join("\n")}\n${evidenceLine}\n${integrityModeNote}\nArtifact: ${finalFile}${verificationMode === "strict" ? `\nGate status: ${join(run, "GATE_STATUS.md")}` : ""}`,
              status: "FAIL",
              finalReport: finalFile,
              integrityMode: integrity.mode,
              victory: victoryRecord,
              ...(legacyUnsignedBlock ? { auth: "AUTH_LEGACY" } : {}),
              ...(verificationMode === "strict" ? { strictGate: strictGate.status, strictMissing: strictGate.missing } : {}),
              reasons: cappedReasons,
            }
          }

          return {
            content: `FINAL VERIFICATION PASSED: every task is verified_pass, every task report is PASS, the security audit is PASS, ${verificationMode === "strict" ? "the strict challenge/audit wave is PASS, " : ""}and the victory audit is ${victoryRecord}.\n${evidenceLine}\n${integrityModeNote}\nArtifact: ${finalFile}${verificationMode === "strict" ? `\nGate status: ${join(run, "GATE_STATUS.md")}` : ""}`,
            status: "PASS",
            finalReport: finalFile,
            integrityMode: integrity.mode,
            victory: victoryRecord,
            ...(verificationMode === "strict" ? { strictGate: strictGate.status } : {}),
          }
        })
      },
    })

    editor.add({
      name: "worktree",
      description:
        "Deterministic git worktree manager for Teamwork runs: setup, diff, merge, resolve, and cleanup. Prevents in-repo nesting and isolates worker branches.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: {
            type: "string",
            description: "setup | diff | merge | resolve | cleanup",
          },
          role: {
            type: "string",
            description: "Role for setup action: sentinel | worker | verifier",
          },
          taskId: {
            type: "string",
            description: "Task ID (required for worker/verifier setup, diff, merge, and resolve)",
          },
          commitMessage: {
            type: "string",
            description: "Commit message for resolve action",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const runId = basename(run)

        const action = clean(input.action, 16)
        // SEC-1: validate at the entry point, before any path or branch is built.
        // Raw value is checked (not clean()ed) so nothing is silently truncated.
        const rawTaskId = input.taskId ? String(input.taskId) : undefined
        if (rawTaskId !== undefined && !isSafeTaskId(rawTaskId)) {
          return { content: `refused: invalid task id "${clean(rawTaskId, 32)}" (must be a single segment matching ${TASK_ID})` }
        }
        const taskId = rawTaskId

        const worktreesBase = process.env.TEAMWORK_WORKTREES_DIR
          ? process.env.TEAMWORK_WORKTREES_DIR
          : join(root, "..", ".teamwork-worktrees")
        const runWorktreesDir = join(worktreesBase, runId)
        const baseBranch = `teamwork/base-${runId}`

        const execGit = (args: string[], cwd = root) => {
          try {
            return {
              stdout: execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim(),
              code: 0,
            }
          } catch (e: any) {
            return {
              stdout: String(e.stdout ?? "").trim(),
              stderr: String(e.stderr ?? e.message ?? "").trim(),
              code: typeof e.status === "number" ? e.status : 1,
            }
          }
        }

        const isGit = execGit(["rev-parse", "--is-inside-work-tree"])
        if (isGit.code !== 0) {
          return { content: "Skipped worktree operation: current directory is not a git repository." }
        }

        // Merge/resolve must only ever touch the run's sentinel worktree. There
        // is deliberately no fallback to `root`: a missing, symlinked, escaping
        // or non-git sentinel path is a hard refusal, never a merge into the
        // user's checkout.
        const verifiedSentinelWorktree = (): { path?: string; error?: string } => {
          const sentinelDir = join(runWorktreesDir, "sentinel")
          const escape = containmentError(runWorktreesDir, sentinelDir)
          if (escape) return { error: `refused: sentinel worktree is not contained in ${runWorktreesDir}: ${escape}` }

          let linkStat
          try {
            linkStat = lstatSync(sentinelDir)
          } catch {
            return {
              error: `refused: sentinel worktree is missing at ${sentinelDir}; run worktree setup with role "sentinel" before merge/resolve (never falling back to the user repo).`,
            }
          }
          if (linkStat.isSymbolicLink()) return { error: "refused: sentinel worktree path is a symlink" }
          if (!linkStat.isDirectory()) return { error: "refused: sentinel worktree path is not a directory" }

          try {
            const baseReal = realpathSync(runWorktreesDir)
            const sentinelReal = realpathSync(sentinelDir)
            const relReal = relative(baseReal, sentinelReal)
            if (!relReal || relReal.startsWith("..") || isAbsolute(relReal)) {
              return { error: "refused: sentinel worktree escapes the worktrees base" }
            }
            const top = execGit(["rev-parse", "--show-toplevel"], sentinelDir)
            if (top.code !== 0 || realpathSync(top.stdout) !== sentinelReal) {
              return { error: "refused: sentinel worktree path is not the worktree root" }
            }
          } catch {
            return { error: "refused: sentinel worktree path is not resolvable" }
          }

          const inside = execGit(["rev-parse", "--is-inside-work-tree"], sentinelDir)
          if (inside.code !== 0 || inside.stdout !== "true") {
            return { error: "refused: sentinel worktree path is not a git worktree" }
          }
          return { path: sentinelDir }
        }

        if (action === "setup") {
          const role = clean(input.role || "worker", 16)
          let targetDir: string
          let branch: string

          if (role === "sentinel") {
            targetDir = join(runWorktreesDir, "sentinel")
            branch = baseBranch
            // SEC-1: containment must hold before ANY mkdir / rmSync / worktree add.
            const escape = containmentError(runWorktreesDir, targetDir)
            if (escape) return { content: escape }
            const branchExists = execGit(["rev-parse", "--verify", branch]).code === 0
            mkdirSync(dirname(targetDir), { recursive: true })
            if (existsSync(targetDir)) {
              const check = execGit(["rev-parse", "--is-inside-work-tree"], targetDir)
              if (check.code !== 0) {
                // rmSync only after re-proving containment (defence in depth).
                if (!containmentError(runWorktreesDir, targetDir)) {
                  try { rmSync(targetDir, { recursive: true, force: true }) } catch {}
                }
                execGit(["worktree", "prune"])
              }
            }
            if (!existsSync(targetDir)) {
              const res = branchExists
                ? execGit(["worktree", "add", targetDir, branch])
                : execGit(["worktree", "add", "-b", branch, targetDir])
              if (res.code !== 0) {
                return { content: `Error creating sentinel worktree: ${res.stderr || res.stdout}` }
              }
            }
            return {
              content: `Sentinel worktree ready at: ${targetDir}\nBranch: ${branch}`,
              worktreePath: targetDir,
              branch,
              baseBranch,
            }
          } else {
            if (!taskId) return { content: "Error: taskId is required for worker/verifier setup." }
            targetDir = join(runWorktreesDir, role === "verifier" ? `verifier-${taskId}` : taskId)
            branch = `teamwork/${runId}-${taskId}`
            // SEC-1: containment must hold before ANY mkdir / rmSync / worktree add.
            const escape = containmentError(runWorktreesDir, targetDir)
            if (escape) return { content: escape }

            const hasBase = execGit(["rev-parse", "--verify", baseBranch]).code === 0
            const startPoint = hasBase ? baseBranch : "HEAD"

            mkdirSync(dirname(targetDir), { recursive: true })
            if (existsSync(targetDir)) {
              const check = execGit(["rev-parse", "--is-inside-work-tree"], targetDir)
              if (check.code !== 0) {
                // rmSync only after re-proving containment (defence in depth).
                if (!containmentError(runWorktreesDir, targetDir)) {
                  try { rmSync(targetDir, { recursive: true, force: true }) } catch {}
                }
                execGit(["worktree", "prune"])
              }
            }
            if (!existsSync(targetDir)) {
              const branchExists = execGit(["rev-parse", "--verify", branch]).code === 0
              const res = branchExists
                ? execGit(["worktree", "add", targetDir, branch])
                : execGit(["worktree", "add", "-b", branch, targetDir, startPoint])
              if (res.code !== 0) {
                return { content: `Error creating ${role} worktree: ${res.stderr || res.stdout}` }
              }
            }
            return {
              content: `${role} worktree ready at: ${targetDir}\nBranch: ${branch}\nBase: ${startPoint}`,
              worktreePath: targetDir,
              branch,
              baseBranch: startPoint,
            }
          }
        }

        if (action === "diff") {
          if (!taskId) return { content: "Error: taskId is required for diff." }
          const branch = `teamwork/${runId}-${taskId}`
          const hasBranch = execGit(["rev-parse", "--verify", branch]).code === 0
          if (!hasBranch) {
            return { content: `Error: branch "${branch}" not found.` }
          }
          const hasBase = execGit(["rev-parse", "--verify", baseBranch]).code === 0
          const baseRef = hasBase ? baseBranch : "HEAD"
          const diffRes = execGit(["diff", `${baseRef}..${branch}`])
          const statRes = execGit(["diff", "--stat", `${baseRef}..${branch}`])

          return {
            content: `Diff for ${taskId} (${baseRef}..${branch}):\n${statRes.stdout || "No changes."}\n\n${diffRes.stdout || ""}`,
            hasChanges: diffRes.stdout.length > 0,
            stat: statRes.stdout,
          }
        }

        if (action === "merge") {
          if (!taskId) return { content: "Error: taskId is required for merge." }
          const branch = `teamwork/${runId}-${taskId}`
          const sentinel = verifiedSentinelWorktree()
          if (!sentinel.path) return { content: sentinel.error }
          const targetCwd = sentinel.path

          const mergeRes = execGit(["merge", "--no-ff", branch, "-m", `Merge task ${taskId} (${branch})`], targetCwd)
          if (mergeRes.code !== 0) {
            const conflictingFiles = mergeRes.stdout
              .split("\n")
              .filter((l) => l.includes("CONFLICT"))
              .map((l) => clean(l.replace(/CONFLICT\s*\([^)]*\):\s*/, ""), 120))

            const oursDiff = execGit(["diff", `${branch}...${baseBranch}`], targetCwd).stdout
            const theirsDiff = execGit(["diff", `${baseBranch}...${branch}`], targetCwd).stdout

            execGit(["merge", "--abort"], targetCwd)

            const synDir = join(run, "synthesis")
            mkdirSync(synDir, { recursive: true })
            const conflictFile = join(synDir, `conflict-${taskId}.json`)
            const conflictArtifact = {
              taskId,
              sessionId: runId,
              baseBranch,
              incomingBranch: branch,
              conflictingFiles,
              diffOurs: oursDiff.slice(0, 10000),
              diffTheirs: theirsDiff.slice(0, 10000),
              timestamp: new Date().toISOString(),
            }
            writeJson(conflictFile, conflictArtifact)

            return {
              content: `MERGE CONFLICT for task ${taskId} into ${baseBranch}:\n${conflictingFiles.join("\n") || mergeRes.stderr || mergeRes.stdout}\n\nConflict artifact generated at: ${conflictFile}\n(Merge was aborted; worktree remains clean. Sentinel should dispatch team/synthesizer to resolve conflict.)`,
              conflict: true,
              conflictArtifact: conflictFile,
              conflictingFiles,
              output: mergeRes.stdout,
            }
          }

          return {
            content: `Successfully merged ${branch} into ${baseBranch}.\n${mergeRes.stdout}`,
            conflict: false,
            merged: true,
          }
        }

        if (action === "resolve") {
          if (!taskId) return { content: "Error: taskId is required for resolve." }
          const sentinel = verifiedSentinelWorktree()
          if (!sentinel.path) return { content: sentinel.error }
          const targetCwd = sentinel.path
          const statusRes = execGit(["status", "--porcelain"], targetCwd)
          if (!statusRes.stdout) {
            return { content: `No modified files to commit for conflict resolution in ${targetCwd}.` }
          }
          execGit(["add", "-A"], targetCwd)
          const commitMsg = clean(input.commitMessage || `Resolve merge conflict for task ${taskId}`, 200)
          const commitRes = execGit(["commit", "-m", commitMsg], targetCwd)
          return {
            content: `Committed conflict resolution for ${taskId}:\n${commitRes.stdout}`,
            resolved: true,
          }
        }

        if (action === "cleanup") {
          if (existsSync(runWorktreesDir)) {
            execGit(["worktree", "prune"])
            try {
              const entries = readdirSync(runWorktreesDir)
              for (const entry of entries) {
                const p = join(runWorktreesDir, entry)
                execGit(["worktree", "remove", "--force", p])
              }
            } catch {}
            execGit(["worktree", "prune"])
          }
          return {
            content: `Cleaned up worktrees for run ${runId} at ${runWorktreesDir}.`,
            cleaned: true,
          }
        }

        return { content: `Error: unknown action "${action}". Allowed: setup | diff | merge | resolve | cleanup` }
      },
    })

    const resolveSafeLemmaCwd = (run: string, rawCwd: unknown): { ok: true; cwd?: string } | { ok: false; error: string } => {
      if (typeof rawCwd !== "string" || !rawCwd.trim()) return { ok: true }
      const cand = resolve(root, rawCwd)
      const worktreesBase = resolve(
        process.env.TEAMWORK_WORKTREES_DIR ? process.env.TEAMWORK_WORKTREES_DIR : join(root, "..", ".teamwork-worktrees"),
      )
      const runWorktreeDir = join(worktreesBase, basename(run))
      const resolveContainedDir = (baseDir: string, targetDir: string, allowEqual: boolean): string | null => {
        const absBase = resolve(baseDir)
        const absTarget = resolve(targetDir)
        const lexRel = relative(absBase, absTarget)
        if (isAbsolute(lexRel) || lexRel.startsWith("..")) return null
        if (!allowEqual && !lexRel) return null
        try {
          let cur = absBase
          const segments = lexRel ? lexRel.split(/[\\/]+/).filter(Boolean) : []
          for (const seg of segments) {
            cur = join(cur, seg)
            if (lstatSync(cur).isSymbolicLink()) return null
          }
          if (lstatSync(absTarget).isSymbolicLink()) return null
          if (!statSync(absTarget).isDirectory()) return null
          const realBase = realpathSync(absBase)
          const realTarget = realpathSync(absTarget)
          const realRel = relative(realBase, realTarget)
          if (isAbsolute(realRel) || realRel.startsWith("..")) return null
          if (!allowEqual && !realRel) return null
          return realTarget
        } catch {
          return null
        }
      }
      const resolvedInRoot = resolveContainedDir(root, cand, true)
      const resolvedInWt = resolvedInRoot ? null : resolveContainedDir(runWorktreeDir, cand, true)
      const safeCwd = resolvedInRoot ?? resolvedInWt
      if (!safeCwd) {
        return { ok: false, error: "refused: cwd must be an existing non-symlink directory inside project root or run worktree" }
      }
      return { ok: true, cwd: safeCwd }
    }

    editor.add({
      name: "lemma_probe",
      description:
        "Read-only probe for the external LEMMA toolchain (`lean`, `lake`, and the LEAP CLI `leap`, or legacy `leap-tools`) on PATH. Never touches disk and never installs packages.",
      input: {
        type: "object",
        properties: {
          timeoutMs: { type: "number", description: "Optional per-binary probe timeout in ms (250..30000)." },
        },
        additionalProperties: false,
      },
      execute: (input: any) => {
        const probe = probeLemmaToolchain({ timeoutMs: input?.timeoutMs })
        if (!probe.ready) {
          return {
            content: formatMissingToolchainRefusal(probe),
            ...probe,
          }
        }
        return {
          content: `LEMMA toolchain READY: lean (${probe.lean.version}), lake (${probe.lake.version}), ${probe.leap.name} (${probe.leap.version}).`,
          ...probe,
        }
      },
    })

    editor.add({
      name: "lemma_formalize",
      description:
        "Manage LEMMA Phase 0 formalization (problem_draft.lean -> preSearch APPROVE/REQUEST_CHANGES -> problem.lean) and final faithfulness review (FAITHFUL/UNFAITHFUL/MISFORMALIZED).",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: { type: "string", description: "draft | review_pre | review_final" },
          leanCode: { type: "string", description: "Lean 4 source for problem_draft.lean (action=draft)." },
          verdict: { type: "string", description: "APPROVE | REQUEST_CHANGES (review_pre) or FAITHFUL | UNFAITHFUL | MISFORMALIZED (review_final)." },
          notes: { type: "string", description: "Reviewer notes." },
          reviewer: { type: "string", description: "Optional reviewer agent id (default team/formalization-reviewer)." },
          verifyDraft: { type: "boolean", description: "Default true for draft: run Lean syntax/typecheck on problem_draft.lean." },
          mode: { type: "string", description: "Optional draft verification mode: lean | lake-env-lean (default: lean)." },
          cwd: { type: "string", description: "Optional working directory inside project root or run worktree (for Lake/Mathlib draft checking)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const action = clean(input?.action, 32)
        const manifestFile = join(run, "lemma", "manifest.json")
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        return await withFileLock(manifestFile, async () => {
          if (action === "draft") {
            const modeRaw = input?.mode ? clean(input.mode, 32) : "lean"
            if (modeRaw !== "lean" && modeRaw !== "lake-env-lean") {
              return { content: `refused: invalid draft mode "${modeRaw}" (allowed: lean | lake-env-lean)` }
            }
            const cwdRes = resolveSafeLemmaCwd(run, input?.cwd)
            if (!cwdRes.ok) return { content: cwdRes.error }
            const res = recordFormalizationDraft(run, String(input?.leanCode ?? ""), {
              verifyDraft: input?.verifyDraft !== false,
              cwd: cwdRes.cwd,
              mode: modeRaw,
            })
            if (res.error) return { content: res.error }
            return {
              content: `Recorded lemma/problem_draft.lean (compiled=${res.compiled}, exitCode=${res.exitCode}).`,
              ...res,
            }
          }
          if (action === "review_pre" || action === "review_final") {
            const caller = await deriveCallerAgent(ctx, run, callSession)
            const explicitReviewer = input?.reviewer ? clean(input.reviewer, 64).trim() : ""
            if (explicitReviewer && explicitReviewer !== "team/formalization-reviewer") {
              return { content: `refused: formalization review must be performed by team/formalization-reviewer (got "${explicitReviewer}").` }
            }
            if (caller?.agent && (caller.agent === "team/proof-worker" || caller.agent === "team/worker")) {
              return { content: `refused: worker agent "${caller.agent}" cannot self-review formalization; dispatch team/formalization-reviewer.` }
            }
            const reviewerId = explicitReviewer || "team/formalization-reviewer"
            if (action === "review_pre") {
              const res = recordFormalizationPreReview(
                run,
                String(input?.verdict ?? ""),
                String(input?.notes ?? ""),
                reviewerId,
              )
              if (res.error) return { content: res.error }
              return {
                content: `Recorded preSearch formalization review (promoted=${res.promoted}, phase=${res.phase}).`,
                ...res,
              }
            }
            const res = recordFormalizationFinalReview(
              run,
              String(input?.verdict ?? ""),
              String(input?.notes ?? ""),
              reviewerId,
            )
            if (res.error) return { content: res.error }
            return {
              content: `Recorded final formalization faithfulness review (phase=${res.phase}).`,
              ...res,
            }
          }
          return { content: `refused: unknown action "${action}" (allowed: draft | review_pre | review_final)` }
        })
      },
    })

    editor.add({
      name: "lemma_node",
      description:
        "Manage bounded LEMMA decomposition tree nodes under lemma/nodes/<lemmaId>/ (create, update, blueprint, attempt) enforcing maxDepth, maxWidth, maxNodes, maxRetries, and cycle/symlink guards. Record `declaration` (Lean theorem/lemma name) and `statement` (exact Lean proposition type) so lemma_verify can bind the attempt to the approved proposition.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: { type: "string", description: "create | update | blueprint | attempt" },
          lemmaId: { type: "string" },
          parentId: { type: "string" },
          statement: { type: "string", description: "Approved Lean proposition/type this node must prove (exact type after the declaration name)." },
          declaration: { type: "string", description: "Lean theorem/lemma name the verified attempt must declare (optional; inferred from lemma/problem.lean when unique)." },
          status: { type: "string" },
          blueprint: { type: "string" },
          leanCode: { type: "string" },
          round: { type: "number" },
        },
        required: ["action", "lemmaId"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const action = clean(input?.action, 32)
        if (action !== "create" && action !== "update" && action !== "blueprint" && action !== "attempt") {
          return { content: `refused: unknown action "${action}" (allowed: create | update | blueprint | attempt)` }
        }
        const manifestFile = join(run, "lemma", "manifest.json")
        return await withFileLock(manifestFile, async () => {
          const res = mutateLemmaNode(run, {
            action,
            lemmaId: String(input?.lemmaId ?? ""),
            parentId: input?.parentId === undefined ? undefined : input.parentId === null ? null : String(input.parentId),
            statement: typeof input?.statement === "string" ? input.statement : undefined,
            declaration: typeof input?.declaration === "string" ? input.declaration : undefined,
            status: typeof input?.status === "string" ? input.status : undefined,
            blueprint: typeof input?.blueprint === "string" ? input.blueprint : undefined,
            leanCode: typeof input?.leanCode === "string" ? input.leanCode : undefined,
            round: typeof input?.round === "number" ? input.round : undefined,
          })
          if (res.error) return { content: res.error }
          return {
            content: `LEMMA node ${res.node?.id} (${action}) updated: status=${res.node?.status}, depth=${res.node?.depth}, attempts=${res.node?.attempts}.`,
            ...res,
          }
        })
      },
    })

    editor.add({
      name: "lemma_verify",
      description:
        "Execute real Lean 4 (`lean`, `lake env lean`, or `lake build`) on lemma/nodes/<lemmaId>/attempt-<r>.lean, bind the declared theorem/lemma name and type to the approved node statement, check transitive axiom dependencies via `#print axioms` against the allowlist approved in lemma/manifest.json at plan time, reject sorry/admit/unauthorized axioms even on exit 0, and stamp verify-<r>.json.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          lemmaId: { type: "string" },
          round: { type: "number" },
          mode: { type: "string", description: "lean | lake-env-lean | lake-build (default: lean)" },
          cwd: { type: "string", description: "Optional working directory inside project root or run worktree." },
        },
        required: ["lemmaId"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        // Deprecated field: never accept a caller-supplied allowlist. Widening
        // the axiom gate is a plan-time decision persisted in the manifest.
        if (input?.allowedAxioms !== undefined) {
          return {
            content:
              "refused: allowedAxioms is no longer accepted by teamwork_lemma_verify; declare it once as lemmaPolicy.allowedAxioms on teamwork_plan, where it is validated and persisted in lemma/manifest.json.",
          }
        }
        const modeRaw = input?.mode ? clean(input.mode, 32) : "lean"
        if (modeRaw !== "lean" && modeRaw !== "lake-env-lean" && modeRaw !== "lake-build") {
          return { content: `refused: invalid mode "${modeRaw}" (allowed: lean | lake-env-lean | lake-build)` }
        }
        const cwdRes = resolveSafeLemmaCwd(run, input?.cwd)
        if (!cwdRes.ok) return { content: cwdRes.error }
        const verifiedCwd = cwdRes.cwd
        const manifestFile = join(run, "lemma", "manifest.json")
        return await withFileLock(manifestFile, async () => {
          const res = verifyLemmaNodeAttempt(run, {
            lemmaId: String(input?.lemmaId ?? ""),
            round: typeof input?.round === "number" ? input.round : undefined,
            mode: modeRaw,
            cwd: verifiedCwd,
          })
          if (res.error || !res.report) return { content: res.error ?? "verification failed" }
          return {
            content: `LEMMA verify ${res.report.lemmaId} round ${res.report.round}: ${res.report.status} (executed=${res.report.executed}, exitCode=${res.report.exitCode}, sorry=${res.report.hasSorry}, admit=${res.report.hasAdmit}, unauthorizedAxiom=${res.report.hasUnauthorizedAxiom}).`,
            ...res,
          }
        })
      },
    })
  })
}

export async function registerTeamworkHooks(ctx: any, root: string) {
  // Fail-closed: if the permission API is unavailable we refuse to load rather
  // than silently dropping the read-only guardrail.
  if (typeof ctx?.permission?.hook !== "function") {
    throw new Error("teamwork: permission API unavailable — refusing to load without the read-only guardrail")
  }

  // Read-only guarantee for critic/verifier/security-auditor agents, enforced in code.
  await ctx.permission.hook("evaluate", (event: any) => {
    const deny = READ_ONLY_ACTIONS[event.agent]
    if (deny && deny.has(event.action)) {
      event.effect = "deny"
      event.message = `${event.agent} is restricted during a Teamwork run (${event.action} denied).`
      return
    }

    // Network constraint enforcement for every team agent (sentinel, workers,
    // verifiers, reviewers, auditors). Prompt text is the run-wide spec; a
    // task-scoped spec.json is honoured too.
    if (
      event.action === "webfetch" &&
      typeof event.agent === "string" &&
      event.agent.startsWith("team/")
    ) {
      const { run } = resolveRun(root)
      if (run && runNetworkDenied(run)) {
        event.effect = "deny"
        event.message = "Network access is denied by run spec constraints."
      }
    }
  })

  // Inject the active run's (sanitised) state into every team agent's context.
  await ctx.session?.hook?.("context", (event: any) => {
    if (typeof event.agent === "string" && event.agent.startsWith("team/")) {
      const text = describeRun(root)
      if (text) event.system.push({ type: "text", text })
    }
  })
}
