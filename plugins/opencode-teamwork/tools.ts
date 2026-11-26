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
import { homedir, hostname } from "node:os"
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  MAX_FINDINGS,
  MAX_SEGMENT_CHARS,
  MAX_TEXT_MAP_CHARS,
  SEGMENT_ID,
  classifyDocumentRoute,
  ingestDocument,
  ingestPdfWithPython,
  isSafeSegmentId,
  resolveAndReadDocument,
  segmentDocument,
  splitInstructionAndInlineDoc,
  validateTreeBounds,
} from "./document-review.ts"
import { authorizeToolCall } from "./authorize.ts"
import { BUDGET_HALT_PCT, budgetPercent, budgetThresholdReached } from "./budget.ts"
import { assertSafeUrl, parseLoopbackServiceUrl, safeFetch } from "./url-guard.mjs"
import {
  LEAP_REQUIREMENT,
  classifyLemmaRoute,
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
  MAX_VERIFIER_REPORT_BYTES,
  assertRunRootIdentity,
  auditTournament,
  classifyTournamentRoute,
  ensureSafeRunSubpath as ensureSafeTournamentSubpath,
  estimateTournamentBudget,
  falsifyCandidate,
  finalizeTournamentPartial,
  hasExplicitMassiveProofOptIn,
  initTournamentManifest,
  isSafeTaskId,
  TASK_ID,
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
  VICTORY_CONFIRMED,
  callerRequirementsFile,
  currentRequirementsHash,
  deriveRequirementsFromRequest,
  describeVictoryGate,
  evaluateVictoryGateChecked,
  evidenceDigestsFromDisk,
  normalizeVictoryAuditMode,
  originalRequestHash,
  persistRequirementsBaseline,
  readRequirementsBaseline,
  readVictoryVerdict,
  recordVictoryAudit,
  resolveVictoryAuditMode,
  recordedVictorySkipReason,
  validateRequirementsBaseline,
  validateVictorySkipReason,
  victorySkipLabel,
} from "./victory.ts"
import {
  AuthError,
  approvalKeyIdFromEnv,
  canonicalJson,
  createAuthContext,
  payloadDigest,
  sha256Hex,
  type AuthContext,
  type AuthEnvelope,
  type AuthFailure,
} from "./auth.ts"
import { contentSha256Hex, isApprovalNonce } from "./approval-format.mjs"
import { strictInput } from "./tool-schema.mjs"
import {
  ATTESTATION_PATH,
  ENV_ATTESTATION_ISSUER,
  ENV_ATTESTATION_KEY_ID,
  ENV_ATTESTATION_PUBLIC_KEY,
  attestationKeyIdFromPublicKey,
  evaluateAttestation,
  loadAttestationPublicKey,
  manifestAttestationPolicy,
  normalizeAttestationPolicy,
  attestationPolicyRank,
} from "./attestation.mjs"
import type { RequirementsFile, VictoryAuditMode } from "./victory.ts"
import { readAgentBriefingExcerpt, readBriefingExcerpt, refreshAgentBriefing, refreshRunBriefing } from "./briefing.ts"
import {
  writeHandoff,
  resolveHandoffScope,
  handoffAgentSlug,
  evaluateHandoffGateChecked,
  normalizeHandoffMode,
  resolveHandoffMode,
  assignedWorkerAgent,
  readWorkerHandoffBinding,
} from "./handoff.ts"
import type { HandoffGate, HandoffMode, HandoffTaskRef } from "./handoff.ts"
import { withCrossProcessLock, withFileLock, withPinnedCrossProcessLock, recentLockDiagnostics } from "./locks.ts"
import { BLOCKING_CLAIM_STATES, deriveClaimStateFromClaim } from "./claim-state.mjs"
import {
  acknowledgeWriteAnomalies,
  appendLineWithin,
  createDirWithin,
  fdWithin,
  onWriteAnomaly,
  readWithinBounded,
  resolveTrustedExecutable,
  setRunRequirePinnedWrites,
  supportsFdContainment,
  touchWithin,
  listContainmentIncidents,
  unacknowledgedWriteAnomalies,
  writeFileAtomicWithin,
  writeOnceWithin,
  writeAnomaliesForRun,
} from "./safe-fs.mjs"

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
  /** Non-fatal losses, e.g. a child list truncated at the pagination cap. */
  warnings?: string[]
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
 * Write `content` to a run artifact atomically through the pinned-fd writer
 * (ADR 0010). The destination's parent is pinned once and every create, rename
 * and identity check is relative to that descriptor, so a raced intermediate
 * directory cannot redirect the write outside the run.
 */
function runRel(run: string, file: string): string {
  return relative(resolve(run), resolve(file))
}

function writeTextAtomicSafe(run: string, file: string, content: string) {
  // ADR 0013: a signed manifest's recorded run-root identity must still match.
  assertRunRootIdentity(run)
  // Retain the path-level policy and error vocabulary (final symlink, escape,
  // non-directory parent) before the pinned write.
  ensureSafeRunSubpath(run, file)
  writeFileAtomicWithin(run, runRel(run, file), content)
}

function writeSnapshots(run: string, file: string, value: SnapshotsFile) {
  writeTextAtomicSafe(run, file, JSON.stringify(value, null, 2) + "\n")
}

/**
 * Channel from the host app (`ctx.app.channel`). OpenCode embeds
 * OPENCODE_CHANNEL into its CLI; the plugin sees the same value through
 * `ctx.app`. Absent (older hosts, tests) means the "local" build.
 */
function opencodeChannel(ctx: any): string {
  const channel = typeof ctx?.app?.channel === "string" ? ctx.app.channel.trim() : ""
  return channel || "local"
}

/** Channels whose database/service file has no channel suffix. */
const UNSCOPED_CHANNELS = new Set(["latest", "dev", "beta", "next", "prod"])
const PLAIN_SERVICE_CHANNELS = new Set(["latest", "dev", "beta", "next"])

function channelSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-")
}

/** `packages/cli/src/database-path.ts` databasePath(). */
function opencodeDatabaseFilename(channel: string): string {
  const disable =
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  return UNSCOPED_CHANNELS.has(channel) || disable ? "opencode.db" : `opencode-${channelSafe(channel)}.db`
}

/** `packages/cli/src/services/service-config.ts` filename(). */
function opencodeServiceFilenames(channel: string): string[] {
  if (PLAIN_SERVICE_CHANNELS.has(channel)) return ["service.json"]
  // The CLI migrates a plain service.json into the channel file for
  // non-standard channels; for "local" it does not, but reading a plain
  // registration is still better than reporting no service at all.
  return [`service-${channelSafe(channel)}.json`, "service.json"]
}

/** XDG roots OpenCode uses (`packages/util/src/global-roots.ts`), then platform fallbacks. */
function opencodeRoots(envHome: string, envKey: string, fallback: string): string[] {
  const roots: string[] = []
  const xdg = process.env[envKey]
  if (xdg) roots.push(join(xdg, "opencode"))
  roots.push(join(envHome, fallback, "opencode"))
  roots.push(join(envHome, "Library", "Application Support", "opencode"))
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "opencode"))
  roots.push(join(envHome, "AppData", "Local", "opencode"))
  return [...new Set(roots)]
}

function getOpencodeDbPath(ctx?: any): string | undefined {
  const home = homedir()
  const dataRoots = opencodeRoots(home, "XDG_DATA_HOME", ".local/share")
  // OPENCODE_DB wins exactly as in the CLI. A relative value resolves against
  // the data directory, and ":memory:" names a database this reader cannot use.
  const override = process.env.OPENCODE_DB?.trim()
  if (override) {
    if (override === ":memory:") return undefined
    return isAbsolute(override) ? override : resolve(dataRoots[0], override)
  }
  const channel = opencodeChannel(ctx)
  const names = [...new Set([opencodeDatabaseFilename(channel), "opencode.db"])]
  for (const root of dataRoots) {
    for (const name of names) {
      const p = join(root, name)
      try {
        if (existsSync(p)) return p
      } catch {}
    }
  }
  return undefined
}

function getOpencodeService(ctx?: any): { url: string; auth: string } | undefined {
  const home = homedir()
  const stateRoots = opencodeRoots(home, "XDG_STATE_HOME", ".local/state")
  const names = opencodeServiceFilenames(opencodeChannel(ctx))
  const candidates: string[] = []
  for (const root of stateRoots) for (const name of names) candidates.push(join(root, name))
  // The CLI also migrates legacy `service-<hash>.json` registrations. The hash
  // is not reproducible here, so accept any remaining service-*.json in the
  // same state directories.
  for (const root of stateRoots) {
    try {
      for (const name of readdirSync(root)) {
        if (/^service-[A-Za-z0-9._-]+\.json$/.test(name)) candidates.push(join(root, name))
      }
    } catch {}
  }
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"))
      const safeUrl = parseLoopbackServiceUrl(raw?.url)
      if (safeUrl) {
        const auth = "Basic " + Buffer.from(`opencode:${raw.password ?? ""}`).toString("base64")
        return { url: safeUrl, auth }
      }
    } catch {}
  }
  return undefined
}

/** Maximum child pages fetched per parent; one page is 200 sessions. */
const SERVICE_TREE_PAGE_LIMIT = 200
const SERVICE_TREE_MAX_PAGES = 25

async function fetchServiceTree(
  url: string,
  auth: string,
  rootIds: string[],
  warnings: string[] = [],
): Promise<SessionUsageItem[] | undefined> {
  const baseUrl = parseLoopbackServiceUrl(url)
  if (!baseUrl) return undefined
  const sessions: SessionUsageItem[] = []
  const seen = new Set<string>()
  const queue: string[] = rootIds.filter(validSessionId)

  for (const rootId of rootIds) {
    if (!validSessionId(rootId) || seen.has(rootId)) continue
    seen.add(rootId)
    try {
      const res = await safeFetch(`${baseUrl}/api/session/${encodeURIComponent(rootId)}`, {
        loopbackOnly: true,
        headers: { Authorization: auth },
        timeoutMs: 3000,
        maxBytes: 4 * 1024 * 1024,
      })
      if (res.ok && res.status >= 200 && res.status < 300 && res.body) {
        const json: any = JSON.parse(res.body.toString("utf8"))
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
    // session.list defaults to 50 children (packages/protocol/src/groups/
    // session.ts "Defaults to the newest 50 sessions"), so a parent with more
    // workers would silently lose spend unless cursor.next is followed.
    let cursor: string | undefined
    for (let page = 0; page < SERVICE_TREE_MAX_PAGES; page++) {
      try {
        const query = new URLSearchParams({ parentID: parentId, limit: String(SERVICE_TREE_PAGE_LIMIT) })
        if (cursor) query.set("cursor", cursor)
        const res = await safeFetch(`${baseUrl}/api/session?${query.toString()}`, {
          loopbackOnly: true,
          headers: { Authorization: auth },
          timeoutMs: 3000,
          maxBytes: 4 * 1024 * 1024,
        })
        if (!res.ok || res.status < 200 || res.status >= 300 || !res.body) break
        const json: any = JSON.parse(res.body.toString("utf8"))
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
        const next = typeof json?.cursor?.next === "string" ? json.cursor.next : ""
        if (!next || next === cursor) break
        cursor = next
        if (page === SERVICE_TREE_MAX_PAGES - 1) {
          warnings.push(
            `session ${parentId} has more than ${SERVICE_TREE_MAX_PAGES * SERVICE_TREE_PAGE_LIMIT} children; spend beyond the cap was not read`,
          )
        }
      } catch {
        break
      }
    }
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
  const dbPath = getOpencodeDbPath(ctx)
  if (dbPath && existsSync(dbPath)) {
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
      const sqliteBin = resolveTrustedExecutable("sqlite3")
      if (!sqliteBin) throw new Error("sqlite3 unavailable")
      const raw = execFileSync(sqliteBin, [dbPath, "-separator", "\t", sql], { encoding: "utf8", timeout: 5000 })
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
  const svc = getOpencodeService(ctx)
  if (svc) {
    try {
      const warnings: string[] = []
      const items = await fetchServiceTree(svc.url, svc.auth, safeIds, warnings)
      if (items && items.length > 0) {
        return {
          sessions: items,
          source: "opencode service API",
          ...(warnings.length ? { warnings } : {}),
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
 * never blocks longer than 2s.
 *
 * Order:
 *   1. `context.agent` — OpenCode sets it from the tool call itself
 *      (packages/schema/src/tool.ts Context.agent), so it is the current value
 *      even after `switchAgent`.
 *   2. `ctx.session.get(sessionID).agent` — `Session.Info.agent` is optional
 *      and may be stale, but is better than nothing.
 *   3. The agent recorded for that session in snapshots.json.
 *
 * `source` records which surface answered; "context" is the call's own agent,
 * "session" is a session/snapshot lookup. Undefined only when every source is
 * absent, which lets the authorization layer fail closed with its named
 * refusal.
 */
async function deriveCallerAgent(
  ctx: any,
  run: string,
  sessionID: string | undefined,
  context?: any,
): Promise<{ agent: string; source: "context" | "session" } | undefined> {
  const fromCall = typeof context?.agent === "string" ? clean(context.agent, 64).trim() : ""
  if (fromCall) return { agent: fromCall, source: "context" }
  if (!sessionID) return undefined
  try {
    if (typeof ctx?.session?.get === "function") {
      const info: any = await withTimeout(Promise.resolve(ctx.session.get({ sessionID })), 2000)
      const a = typeof info?.agent === "string" ? clean(info.agent, 64).trim() : ""
      if (a) return { agent: a, source: "session" }
    }
  } catch {}
  if (!run) return undefined
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

/**
 * Stable digest of a usage observation. Applying the same observation twice
 * must be a no-op: the digest is stored in costs.json and compared before any
 * delta is added. Costs are rounded to 1e-4 so a JSON round-trip cannot change
 * the digest.
 */
function costUsageDigest(sessions: SessionUsageItem[]): string {
  const normalized = sessions
    .map((s) => ({
      id: String(s.id),
      agent: typeof s.agent === "string" ? clean(s.agent, 64) : "",
      cost: Math.round((Number(s.cost) || 0) * 1e4) / 1e4,
      tokens: normalizeTokens(s.tokens),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return sha256Hex(canonicalJson(normalized))
}

function snapshotCursor(raw: any): SessionSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const lastCost = Number(raw.lastCost)
  if (!Number.isFinite(lastCost)) return undefined
  const cursor: any = { lastCost }
  // A legacy snapshot without lastTokens cannot yield an honest token delta;
  // preserve the old "skip token accounting" behaviour instead of inventing 0.
  if (raw.lastTokens && typeof raw.lastTokens === "object") cursor.lastTokens = normalizeTokens(raw.lastTokens)
  if (typeof raw.agent === "string") cursor.agent = clean(raw.agent, 64)
  cursor.timestamp = typeof raw.timestamp === "string" ? raw.timestamp : ""
  return cursor as SessionSnapshot
}

/**
 * Write the single costs.json update. `lastCostUpdate` records whether this
 * call applied a snapshot or skipped a duplicate digest, for operator
 * diagnostics. The digest/cursors are the authoritative delta baseline; the
 * legacy snapshots.json remains a compatibility view only.
 */
function writeCostsOnce(run: string, file: string, costs: any, update: { source: string; digest?: string; skippedDuplicate?: boolean }) {
  costs.lastCostUpdate = {
    at: new Date().toISOString(),
    source: clean(update.source, 80),
    ...(update.digest ? { digest: update.digest } : {}),
    skippedDuplicate: update.skippedDuplicate === true,
  }
  writeJson(run, file, costs)
}

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
 * dir, report/conflict file names) and inside git branch names. The allowlist
 * lives in tournament.ts so every writer (including handoffs) shares it.
 */

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
 * Parse the launch prefix of a `/teamwork` task (or a verbatim `request`).
 *
 * Only a leading `[skip-interview]` is a parameter: it is case-insensitive,
 * may be followed by spaces/tabs, and is removed from the task text. Any other
 * leading `[...]` token (1..64 chars, no `]`) is reported as `ignoredBracket`
 * but left in the text because it is part of the task. Brackets anywhere else
 * are literal. Leading spaces/tabs are consumed only when they precede a
 * leading bracketed token; a request with no leading bracket is returned
 * byte-for-byte, so meaningful leading whitespace is preserved. Interior
 * whitespace is kept byte-for-byte.
 */
export function parseTeamworkLaunch(raw: unknown): {
  text: string
  skipInterview: boolean
  ignoredBracket?: string
} {
  if (typeof raw !== "string") return { text: "", skipInterview: false }
  let text = raw
  // A1: only consume indentation that introduces a bracket token. `[^[]` is
  // not the test here: the lookahead checks the very next character after the
  // run of spaces/tabs, so `  Fix bug` stays byte-identical.
  const indented = /^[ \t]+(?=\[)/.exec(text)
  if (indented) text = text.slice(indented[0].length)
  let skipInterview = false
  const skip = /^\[skip-interview\][ \t]*/i.exec(text)
  if (skip) {
    skipInterview = true
    text = text.slice(skip[0].length)
  }
  const ignored = /^\[([^\]\n]{1,64})\]/.exec(text)
  return {
    text,
    skipInterview,
    ...(ignored ? { ignoredBracket: ignored[0] } : {}),
  }
}

// Artifact trust levels (ADR 0008). `local-hmac` is the Phase A default; the
// stronger levels are enforced by final_verify and can only be chosen at plan
// time (a re-plan cannot weaken them).
const TRUST_LEVELS = ["local-hmac", "external-signer", "human-approved", "ci-attested"] as const
type TrustLevel = (typeof TRUST_LEVELS)[number]
const DEFAULT_TRUST_LEVEL: TrustLevel = "local-hmac"

function normalizeTrustLevel(value: unknown): TrustLevel | undefined {
  const v = String(value ?? "").trim()
  return (TRUST_LEVELS as readonly string[]).includes(v) ? (v as TrustLevel) : undefined
}

/** Trust levels that require an approval artifact from a different principal. */
function requiresApproval(trustLevel: TrustLevel): boolean {
  return trustLevel === "human-approved" || trustLevel === "ci-attested"
}

function approvalPolicyFor(trustLevel: TrustLevel, version: number): ApprovalPolicy {
  if (!requiresApproval(trustLevel)) return "none"
  return version < APPROVAL_EXTERNAL_MIN_VERSION ? "in-run-legacy" : "external-dir"
}

function normalizeApprovalPolicy(value: unknown, version: number): ApprovalPolicy {
  if (version < APPROVAL_EXTERNAL_MIN_VERSION) return "in-run-legacy"
  return value === "external-dir" || value === "none" || value === "in-run-legacy"
    ? (value as ApprovalPolicy)
    : "none"
}

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

/** Every rule the run's integrity mode forbids (the audit must cover each once). */
function forbiddenIntegrityRules(mode: IntegrityMode): IntegrityRule[] {
  return INTEGRITY_RULE_IDS.filter((rule) => isIntegrityRuleForbidden(rule, mode))
}

/**
 * 0.12.0: named contradictions between artifacts that can each pass their own
 * check. The engine never fixes these; it refuses and asks for a re-record.
 */
const CONTRADICTION_CODES = [
  "INCONSISTENT_VICTORY_TASK",
  "INCONSISTENT_REPORT_BRANCH",
  "INCONSISTENT_AUDIT_HIGH",
  "INCONSISTENT_WAVE_REPORT",
] as const
type ContradictionCode = (typeof CONTRADICTION_CODES)[number]
interface EvidenceContradiction {
  code: ContradictionCode
  detail: string
}

function detectEvidenceContradictions(opts: {
  run: string
  root: string
  runId: string
  tasks: Array<{ id: string; status: string; reportStatus: string }>
  reports: Record<string, any>
  audit: any
  victory: any
  strictGate?: { tasks?: Array<any> }
}): EvidenceContradiction[] {
  const out: EvidenceContradiction[] = []
  const { run, root, runId, tasks, reports, audit, victory } = opts

  // 1. A CONFIRMED victory while a task fails.
  if (victory?.verdict === VICTORY_CONFIRMED) {
    for (const task of tasks) {
      if (task.status === "verified_fail" || task.status === "failed" || task.reportStatus === "FAIL") {
        out.push({
          code: "INCONSISTENT_VICTORY_TASK",
          detail: `VICTORY CONFIRMED while task ${task.id} is ${task.status}${task.reportStatus === "FAIL" ? " and its report is FAIL" : ""}`,
        })
      }
    }
  }

  // 2. A PASS report computed against a branch that has moved.
  for (const task of tasks) {
    const report = reports[task.id]
    if (task.reportStatus !== "PASS" || !report || typeof report !== "object") continue
    const branch = typeof report.branch === "string" && report.branch ? report.branch : `teamwork/${runId}-${task.id}`
    const head = execGitCapture(root, ["rev-parse", "--verify", branch])
    if (!head) continue
    if (typeof report.headSha === "string" && report.headSha && report.headSha !== head) {
      out.push({
        code: "INCONSISTENT_REPORT_BRANCH",
        detail: `task ${task.id}: PASS report names head ${clean(report.headSha, 64).slice(0, 12)}, but ${branch} is ${head.slice(0, 12)}`,
      })
      continue
    }
    if (typeof report.diffHash === "string" && report.diffHash) {
      const base = execGitCapture(root, ["rev-parse", "--verify", `teamwork/base-${runId}`])
      if (!base) continue
      const diff = execGitCapture(root, ["diff", "--no-color", `${base}..${head}`])
      if (diff !== undefined && sha256Hex(diff) !== report.diffHash) {
        out.push({
          code: "INCONSISTENT_REPORT_BRANCH",
          detail: `task ${task.id}: PASS report's diffHash does not match the current ${branch} diff`,
        })
      }
    }
  }

  // 3. A PASS/CLEAN security audit with a High (or Critical) finding.
  if (audit?.status === "PASS") {
    const counts = audit?.severityCounts ?? {}
    const highCount = Number(counts.high) || 0
    const criticalCount = Number(counts.critical) || 0
    const highFinding = Array.isArray(audit?.findings)
      ? audit.findings.find((f: any) => ["high", "critical"].includes(String(f?.severity).toLowerCase()))
      : undefined
    if (highCount > 0 || criticalCount > 0 || highFinding) {
      out.push({
        code: "INCONSISTENT_AUDIT_HIGH",
        detail: `security audit reports PASS with ${criticalCount} Critical / ${highCount} High finding(s)`,
      })
    }
  }

  // 4. A strict wave verdict bound to the current hash of a FAIL report.
  for (const task of opts.strictGate?.tasks ?? []) {
    if (task.reportStatus !== "FAIL") continue
    const raw = readBoundedRunFile(run, join(run, `verify/report-${task.id}.json`), MAX_VERIFIER_REPORT_BYTES)
    const digest = raw.status === "ok" ? contentSha256Hex(raw.text) : null
    if (!digest) continue
    const wave = [task.challenge, task.audit].find(
      (w: any) => w && w.present && typeof w.reportHash === "string" && w.reportHash === digest,
    )
    if (wave) {
      out.push({
        code: "INCONSISTENT_WAVE_REPORT",
        detail: `task ${task.id}: ${wave.path} records ${clean(wave.verdict, 32)} against the current FAIL report`,
      })
    }
  }
  return out
}

/**
 * 0.12.0: validate a recorded security audit against the run's mode.
 * A PASS must cover every forbidden rule exactly once, contain no `violation`,
 * and its `reviewedDigests` must still match the evidence on disk.
 */
function evaluateSecurityAuditEvidence(
  run: string,
  audit: any,
  mode: IntegrityMode,
): { ok: boolean; authStale: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (audit?.status !== "PASS") return { ok: true, authStale: false, reasons: [] }

  const forbidden = forbiddenIntegrityRules(mode)
  const checks = Array.isArray(audit?.ruleChecks) ? audit.ruleChecks : []
  if (!Array.isArray(audit?.ruleChecks)) {
    reasons.push(`security audit: ruleChecks is missing (a PASS must cover ${forbidden.join(", ")} at mode ${mode})`)
  } else {
    const seen = new Map<string, number>()
    for (const check of checks) {
      const rule = check && typeof check === "object" ? check.rule : undefined
      if (typeof rule !== "string" || !Object.prototype.hasOwnProperty.call(INTEGRITY_RULES, rule)) {
        reasons.push(`security audit: ruleChecks names an unknown rule "${clean(rule, 64)}"`)
        continue
      }
      seen.set(rule, (seen.get(rule) ?? 0) + 1)
      if (check.result !== "clean" && check.result !== "violation") {
        reasons.push(`security audit: ruleChecks[${rule}].result must be clean | violation`)
      }
      if (check.result === "violation") {
        reasons.push(`security audit: ruleChecks records a violation for ${rule} while the audit reports PASS`)
      }
    }
    for (const rule of forbidden) {
      const count = seen.get(rule) ?? 0
      if (count === 0) reasons.push(`security audit: ruleChecks is missing the forbidden rule ${rule} at mode ${mode}`)
      else if (count > 1) reasons.push(`security audit: ruleChecks records ${rule} ${count} times (expected exactly once)`)
    }
  }

  let authStale = false
  const reviewed = audit?.reviewedDigests
  if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) {
    authStale = true
    reasons.push("[AUTH_STALE] security audit: reviewedDigests is missing; the audit is not bound to the evidence it reviewed")
  } else {
    const current = evidenceDigestsFromDisk(run)
    const recordedReports =
      reviewed.reports && typeof reviewed.reports === "object" && !Array.isArray(reviewed.reports)
        ? reviewed.reports
        : null
    if (!recordedReports) {
      authStale = true
      reasons.push("[AUTH_STALE] security audit: reviewedDigests.reports is missing or malformed")
    } else {
      for (const [id, digest] of Object.entries(recordedReports)) {
        if (!isSafeTaskId(id)) {
          authStale = true
          reasons.push(`[AUTH_STALE] security audit: reviewedDigests names an invalid task id "${clean(id, 40)}"`)
          continue
        }
        if (current.reports[id] !== digest) {
          authStale = true
          reasons.push(`[AUTH_STALE] security audit: report ${id} changed since the audit reviewed it`)
        }
      }
      for (const id of Object.keys(current.reports)) {
        if (!Object.prototype.hasOwnProperty.call(recordedReports, id)) {
          authStale = true
          reasons.push(`[AUTH_STALE] security audit: report ${id} was never reviewed by this audit`)
        }
      }
    }
    const recordedFinal = reviewed.final ?? null
    if (recordedFinal !== null) {
      const currentFinalValue = readJson<any>(run, join(run, "verify", "final.json"), undefined)
      const currentFinalAt = typeof currentFinalValue?.generatedAt === "string" ? Date.parse(currentFinalValue.generatedAt) : NaN
      const auditAt = typeof audit?.timestamp === "string" ? Date.parse(audit.timestamp) : NaN
      // A final verdict written *after* the audit could not have been reviewed by
      // it; only a final that predates the audit is a binding mismatch.
      const writtenAfterAudit = Number.isFinite(currentFinalAt) && Number.isFinite(auditAt) && currentFinalAt > auditAt
      if (!writtenAfterAudit && recordedFinal !== current.final) {
        authStale = true
        reasons.push("[AUTH_STALE] security audit: verify/final.json changed since the audit reviewed it")
      }
    }
  }
  return { ok: reasons.length === 0, authStale, reasons }
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
  // HEAD only: no body is read. Redirects are not followed, but a Location is
  // validated so a redirect cannot point at a loopback/private/metadata address.
  const fetched = await safeFetch(value, {
    method: "HEAD",
    timeoutMs: PREFLIGHT_URL_TIMEOUT_MS,
    signal: AbortSignal.timeout(PREFLIGHT_URL_TIMEOUT_MS),
  })
  if (!fetched.ok) {
    if (fetched.code === "URL_TIMEOUT") return { status: "OUTAGE", detail: "timeout" }
    return { status: "OUTAGE", detail: clean(fetched.error, 160) }
  }
  if (fetched.status >= 300 && fetched.status < 400) {
    const location = fetched.headers?.location
    if (location) {
      try {
        const next = new URL(String(location), value)
        const target = await assertSafeUrl(next.toString(), {
          signal: AbortSignal.timeout(PREFLIGHT_URL_TIMEOUT_MS),
        })
        if (!target.ok) return { status: "OUTAGE", detail: clean(`redirect to blocked address: ${target.error}`, 160) }
      } catch {
        return { status: "OUTAGE", detail: "redirect with an invalid Location" }
      }
    }
    return { status: "READY", detail: `HTTP ${fetched.status} (redirect not followed)` }
  }
  return {
    status: fetched.status >= 200 && fetched.status < 400 ? "READY" : "OUTAGE",
    detail: `HTTP ${fetched.status}`,
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
 *
 * `launch` is the parsed launch metadata (`parseTeamworkLaunch`). It is written
 * to a `## Parameters` section between the header and `## Request`, so the
 * bypass/reporting state is recorded without contaminating the verbatim task.
 */
function writeOriginalRequest(
  run: string,
  request: string,
  mode: IntegrityMode,
  sessionId: string,
  launch: { skipInterview: boolean; ignoredBracket?: string },
): string | undefined {
  const file = join(run, "ORIGINAL_REQUEST.md")
  const parameters = [
    "## Parameters",
    "",
    "How this run was launched; not part of the task.",
    `- skipInterview: ${launch.skipInterview ? "true" : "false"}`,
    ...(launch.skipInterview ? ["- [skip-interview]"] : []),
    ...(launch.ignoredBracket ? [`- Ignored leading bracket: ${launch.ignoredBracket}`] : []),
    "",
  ].join("\n")
  const body = `# Original Request\n\n- Integrity mode: ${mode}\n- Recorded: ${new Date().toISOString()}\n- Session: ${sessionId}\n\n${parameters}\n## Request\n\n${request}`
  try {
    // ADR 0010: create-once inside the pinned run directory. O_CREAT|O_EXCL
    // makes "once" true across concurrent planners and refuses an existing
    // file or symlink; the parent descriptor cannot be diverted by a swap.
    writeOnceWithin(run, "ORIGINAL_REQUEST.md", body.endsWith("\n") ? body : body + "\n")
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
  // The falsifier is the empirical challenger: shell is allowed so it can run
  // the project's tests itself. It can modify files through shell, so the
  // prompt forbids using it for edits; `edit` stays denied in code.
  "team/falsifier": new Set(["edit", "subagent"]),
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

function writeJson(run: string, file: string, value: unknown) {
  writeTextAtomicSafe(run, file, JSON.stringify(value, null, 2) + "\n")
}

/**
 * Directories every run is expected to use. They are created once at plan time
 * through the pinned writer (ADR 0010). This is attack-surface reduction, not a
 * substitute for pinning: a writer still pins and validates the parent it uses,
 * and a missing directory is created one validated segment at a time.
 */
const PRECREATED_RUN_DIRS = [
  "verify",
  "tournament",
  "tournament/candidates",
  "tournament/critiques",
  "tournament/merges",
  "lemma",
  "lemma/nodes",
  "synthesis",
  "document-review",
  "document-review/segments",
  "document-review/synthesis",
]

function precreateRunDirs(run: string, taskIds: string[] = []) {
  for (const dir of PRECREATED_RUN_DIRS) createDirWithin(run, dir)
  for (const id of taskIds) {
    // Document-review segment ids are already allowlisted at triage time; the
    // anchored pattern keeps a hostile plan from adding a path segment here.
    if (/^seg-[A-Za-z0-9_-]{1,32}$/.test(id)) createDirWithin(run, `document-review/segments/${id}`)
  }
}

// ---------------------------------------------------------------------------
// Task claims / leases / fencing (claim protocol 2)
//
// `teamwork_next` atomically stamps a bounded lease on every task it hands out.
// The lease is advisory coordination, not an authorization boundary: role and
// session-tree checks still live in authorize.ts. Its job is to stop two
// Sentinel resumes from dispatching duplicate workers for the same ready task.
//
// Protocol 2 (0.10.0) adds, additively:
//   * a per-run lease (`claimLeaseMs`) and `host`, plus a per-task `fence`;
//   * `claim.host/epoch/heartbeatAt/baseline/history` and a bounded heartbeat;
//   * a side-effect baseline captured at `worker_active` so a crashed claim can
//     only be reclaimed when nothing changed;
//   * a single-use, hashed inspection token for explicit recovery.
//
// A legacy state.json without `claimProtocol` is protocol 1 and behaves exactly
// as 0.9.0: the 15-minute advisory lease, expired-claim reclaim, and no fence
// enforcement.
// ---------------------------------------------------------------------------

const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000
const MIN_CLAIM_LEASE_MS = 60 * 1000
const MAX_CLAIM_LEASE_MS = 60 * 60 * 1000
const CLAIM_GRACE_MS = 5 * 60 * 1000
const CLAIM_MAX_TENURE_MS = 60 * 60 * 1000
const CLAIM_MAX_RENEWALS = 20
const INSPECTION_TOKEN_TTL_MS = 10 * 60 * 1000
const CLAIM_HISTORY_MAX = 5
const CLAIM_PROTOCOL = 2
const LEGACY_CLAIM_LEASE_MS = 15 * 60 * 1000
const MAX_UNTRACKED_FILES = 1000
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024
const SELF_HOST = hostname()

interface ClaimBaseline {
  scope: string
  baseSha?: string
  headSha?: string
  diffHash?: string
  statusHash?: string
  artifactHash?: string
  untracked?: { count: number; digest: string; truncated: boolean }
  fingerprint: string
  at?: string
  reason?: string
}

function claimTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function normalizePreviousClaimant(raw: any): { by: string; at: string; leaseUntil: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const by = clean(raw.by, 80).trim()
  const at = claimTime(raw.at)
  const leaseUntil = claimTime(raw.leaseUntil)
  if (!by || !at || !leaseUntil) return undefined
  return { by, at, leaseUntil }
}

function normalizeUntracked(raw: any): { count: number; digest: string; truncated: boolean } | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const digest = typeof raw.digest === "string" ? clean(raw.digest, 128).trim() : ""
  if (!digest) return undefined
  return {
    count: Math.max(0, Math.trunc(Number(raw.count) || 0)),
    digest,
    truncated: raw.truncated === true,
  }
}

/** Sanitise an untrusted side-effect baseline read from state.json. */
function normalizeBaseline(raw: any): ClaimBaseline | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const fingerprint = typeof raw.fingerprint === "string" ? clean(raw.fingerprint, 128).trim() : ""
  if (!fingerprint) return undefined
  const baseline: ClaimBaseline = {
    scope: clean(raw.scope, 32).trim() || "unknown",
    fingerprint,
  }
  for (const key of ["baseSha", "headSha", "diffHash", "statusHash", "artifactHash"] as const) {
    if (typeof raw[key] === "string" && raw[key]) baseline[key] = clean(raw[key], 128).trim()
  }
  const untracked = normalizeUntracked(raw.untracked)
  if (untracked) baseline.untracked = untracked
  const at = claimTime(raw.at)
  if (at) baseline.at = at
  if (typeof raw.reason === "string" && raw.reason) baseline.reason = clean(raw.reason, 200)
  return baseline
}

function normalizeHistory(raw: any): any[] {
  if (!Array.isArray(raw)) return []
  const out: any[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const by = clean(entry.by, 80).trim()
    const at = claimTime(entry.at)
    if (!by || !at) continue
    const normalized: any = { by, at, event: clean(entry.event, 32).trim() || "claim" }
    const leaseUntil = claimTime(entry.leaseUntil)
    if (leaseUntil) normalized.leaseUntil = leaseUntil
    if (typeof entry.reason === "string" && entry.reason) normalized.reason = clean(entry.reason, 200)
    out.push(normalized)
  }
  return out.slice(-CLAIM_HISTORY_MAX)
}

/** Sanitise an untrusted claim read from state.json. Invalid claims are absent. */
function normalizeClaim(raw: any): any | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const by = clean(raw.by, 80).trim()
  const at = claimTime(raw.at)
  const leaseUntil = claimTime(raw.leaseUntil)
  if (!by || !at || !leaseUntil) return undefined
  const claim: any = { by, at, leaseUntil }
  const previous = normalizePreviousClaimant(raw.previousClaimant)
  if (previous && previous.by !== by) claim.previousClaimant = previous
  if (raw.override === "sentinel") claim.override = "sentinel"
  if (typeof raw.host === "string" && raw.host.trim()) claim.host = clean(raw.host, 80).trim()
  if (typeof raw.runHost === "string" && raw.runHost.trim()) claim.runHost = clean(raw.runHost, 80).trim()
  const epoch = Number(raw.epoch)
  if (Number.isFinite(epoch) && epoch >= 0) claim.epoch = Math.trunc(epoch)
  const heartbeatAt = claimTime(raw.heartbeatAt)
  if (heartbeatAt) claim.heartbeatAt = heartbeatAt
  const tenureStartAt = claimTime(raw.tenureStartAt)
  if (tenureStartAt) claim.tenureStartAt = tenureStartAt
  const renewals = Number(raw.renewals)
  if (Number.isFinite(renewals) && renewals >= 0) claim.renewals = Math.trunc(renewals)
  const baseline = normalizeBaseline(raw.baseline)
  if (baseline) claim.baseline = baseline
  const history = normalizeHistory(raw.history)
  if (history.length) claim.history = history
  if (raw.needsInspection === true) claim.needsInspection = true
  if (raw.maxTenureReached === true) claim.maxTenureReached = true
  return claim
}

function nextFence(task: any): number {
  const raw = Number(task?.fence)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0
}

function claimProtocolOf(state: any): number {
  const raw = Number(state?.claimProtocol)
  return Number.isFinite(raw) && raw >= CLAIM_PROTOCOL ? CLAIM_PROTOCOL : 1
}

function claimLeaseOf(state: any): number {
  if (claimProtocolOf(state) < CLAIM_PROTOCOL) return LEGACY_CLAIM_LEASE_MS
  const raw = Number(state?.claimLeaseMs)
  if (!Number.isFinite(raw)) return DEFAULT_CLAIM_LEASE_MS
  return Math.min(MAX_CLAIM_LEASE_MS, Math.max(MIN_CLAIM_LEASE_MS, Math.trunc(raw)))
}

function runHostOf(state: any, plan?: any): string {
  if (typeof state?.host === "string" && state.host.trim()) return clean(state.host, 80).trim()
  if (typeof plan?.host === "string" && plan.host.trim()) return clean(plan.host, 80).trim()
  // A claim-protocol-1 run predates the host field entirely, so it keeps the
  // legacy local behaviour. For protocol 2 a missing host is not assumed to be
  // local: the run is reported as an unknown host (fail closed), and a missing
  // claim.host is cross-host in deriveClaimState.
  if (claimProtocolOf(state) < CLAIM_PROTOCOL) return SELF_HOST
  return "unknown"
}

/** A claim with no recorded host is cross-host (fail closed), never local. */
function claimIsCrossHost(claim: any): boolean {
  const host = typeof claim?.host === "string" ? claim.host.trim() : ""
  return host === "" || host !== SELF_HOST
}

function appendClaimHistory(history: any[], entry: any): any[] {
  const next = [...(Array.isArray(history) ? history : []), entry]
  return next.slice(-CLAIM_HISTORY_MAX)
}

/**
 * Merge history lists without losing a claimant. `claim.history` (embedded in
 * the current claim) and `task.claimHistory` (task-level, survives release)
 * are two views of the same chain; before a claim is deleted both are merged
 * into the task-level list. Duplicate (by, at, event) entries collapse and the
 * 5-entry bound is kept.
 */
function mergeClaimHistory(...lists: any[]): any[] {
  const merged: any[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const entry of normalizeHistory(list)) {
      const key = `${entry.by}|${entry.at}|${entry.event}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }
  // normalizeHistory bounds each input; the union may still exceed the cap.
  return merged.slice(-CLAIM_HISTORY_MAX)
}

/** The exact 0.9.0 claim shape, for a claimProtocol 1 run. */
function makeLegacyTaskClaim(by: string, now: number, previous?: any): any {
  const claim: any = {
    by: clean(by, 80),
    at: new Date(now).toISOString(),
    leaseUntil: new Date(now + LEGACY_CLAIM_LEASE_MS).toISOString(),
  }
  const prev = normalizePreviousClaimant(previous)
  if (prev && prev.by !== claim.by) claim.previousClaimant = prev
  return claim
}

function makeTaskClaim(
  by: string,
  now: number,
  previous: any,
  opts: {
    host: string
    runHost?: string
    leaseMs: number
    epoch: number
    event?: string
    reason?: string
    /** The task-level chain to rehydrate a later claim from. */
    priorHistory?: any[]
  },
): any {  const at = new Date(now).toISOString()
  const claim: any = {
    by: clean(by, 80),
    at,
    leaseUntil: new Date(now + opts.leaseMs).toISOString(),
    host: opts.host,
    ...(opts.runHost ? { runHost: opts.runHost } : {}),
    epoch: Math.max(1, Math.trunc(opts.epoch) || 1),
    heartbeatAt: at,
    tenureStartAt: at,
    renewals: 0,
  }
  const prev = normalizePreviousClaimant(previous)
  const seeded = mergeClaimHistory(opts.priorHistory, previous?.history)
  if (prev && prev.by !== claim.by) {
    claim.previousClaimant = prev
    claim.history = appendClaimHistory(seeded, {
      by: prev.by,
      at: prev.at,
      leaseUntil: prev.leaseUntil,
      event: opts.event ?? "reclaimed",
      ...(opts.reason ? { reason: clean(opts.reason, 200) } : {}),
    })
  } else if (seeded.length) {
    claim.history = seeded
  }
  return claim
}

/**
 * Renew an owned claim without changing its fence. Tenure is bounded: after
 * CLAIM_MAX_TENURE_MS or CLAIM_MAX_RENEWALS the claim is forced expired and the
 * caller must recover it explicitly.
 */
function renewClaimObject(
  claim: any,
  now: number,
  leaseMs: number,
): { claim: any; renewed: boolean; reason?: string } {
  const at = new Date(now).toISOString()
  const tenureStart = Date.parse(claim?.tenureStartAt ?? claim?.at)
  const start = Number.isFinite(tenureStart) ? tenureStart : now
  const renewals = Math.max(0, Math.trunc(Number(claim?.renewals) || 0)) + 1
  if (now - start > CLAIM_MAX_TENURE_MS || renewals > CLAIM_MAX_RENEWALS) {
    return {
      claim: {
        ...claim,
        heartbeatAt: at,
        leaseUntil: at,
        renewals,
        maxTenureReached: true,
      },
      renewed: false,
      reason: `max claim tenure reached (${Math.round((now - start) / 60000)} min, ${renewals - 1} renewals); claim forced expired`,
    }
  }
  return {
    claim: {
      ...claim,
      heartbeatAt: at,
      leaseUntil: new Date(now + leaseMs).toISOString(),
      renewals,
    },
    renewed: true,
  }
}

/** The claim shape returned to callers (never an untrusted raw object). */
function publicClaim(raw: any): any | undefined {
  const claim = normalizeClaim(raw)
  if (!claim) return undefined
  return {
    by: claim.by,
    at: claim.at,
    leaseUntil: claim.leaseUntil,
    ...(claim.host ? { host: claim.host } : {}),
    ...(claim.runHost ? { runHost: claim.runHost } : {}),
    ...(claim.epoch !== undefined ? { epoch: claim.epoch } : {}),
    ...(claim.heartbeatAt ? { heartbeatAt: claim.heartbeatAt } : {}),
    ...(claim.renewals !== undefined ? { renewals: claim.renewals } : {}),
    ...(claim.previousClaimant ? { previousClaimant: claim.previousClaimant } : {}),
    ...(claim.override ? { override: claim.override } : {}),
    ...(claim.needsInspection ? { needsInspection: true } : {}),
    ...(claim.maxTenureReached ? { maxTenureReached: true } : {}),
    ...(claim.history ? { history: claim.history } : {}),
    ...(claim.baseline ? { baseline: claim.baseline } : {}),
  }
}

type DerivedClaimState = "none" | "live" | "expired" | "stale" | "needs-inspection" | "cross-host"

function deriveClaimState(
  task: any,
  now = Date.now(),
  options: { legacyHostless?: boolean } = {},
): {
  state: DerivedClaimState
  remainingMs: number
  heartbeatAgeMs?: number
  crossHost: boolean
  needsInspection: boolean
} {
  const claim = normalizeClaim(task?.claim)
  if (!claim) return { state: "none", remainingMs: 0, crossHost: false, needsInspection: false }
  // One shared predicate (claim-state.mjs) so prune, cleanup, status and the
  // claim engine cannot disagree. Missing host is cross-host (protocol 2); a
  // flagged claim is needs-inspection even while its lease is live.
  const derived = deriveClaimStateFromClaim(claim, {
    now,
    selfHost: SELF_HOST,
    graceMs: CLAIM_GRACE_MS,
    flagged: task?.claim?.needsInspection === true,
    legacyHostless: options.legacyHostless === true,
  })
  return {
    state: derived.state as DerivedClaimState,
    remainingMs: derived.remainingMs,
    ...(derived.heartbeatAgeMs !== undefined ? { heartbeatAgeMs: derived.heartbeatAgeMs } : {}),
    crossHost: derived.crossHost,
    needsInspection: derived.needsInspection,
  }
}

// ---------------------------------------------------------------------------
// Side-effect baselines (git worktree or scoped artifacts)
// ---------------------------------------------------------------------------

function execGitCapture(cwd: string, args: string[]): string | undefined {
  const gitBin = resolveTrustedExecutable("git")
  if (!gitBin) return undefined
  try {
    return execFileSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return undefined
  }
}

function worktreesBaseDir(root: string): string {
  return process.env.TEAMWORK_WORKTREES_DIR
    ? process.env.TEAMWORK_WORKTREES_DIR
    : join(root, "..", ".teamwork-worktrees")
}

function runWorktreesPath(root: string, runId: string): string {
  return join(worktreesBaseDir(root), runId)
}

function findTaskWorktree(
  root: string,
  runId: string,
  task: any,
  taskId: string,
): { path: string } | undefined {
  const candidates: string[] = []
  if (typeof task?.worktree === "string" && task.worktree.trim()) {
    const raw = task.worktree.trim()
    candidates.push(isAbsolute(raw) ? raw : resolve(root, raw))
  }
  const base = runWorktreesPath(root, runId)
  for (const name of [taskId, `verifier-${taskId}`, `worker-${taskId}`]) candidates.push(join(base, name))
  for (const candidate of candidates) {
    try {
      const st = lstatSync(candidate)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      if (execGitCapture(candidate, ["rev-parse", "--is-inside-work-tree"]) !== "true") continue
      return { path: candidate }
    } catch {
      continue
    }
  }
  return undefined
}

function scanUntracked(cwd: string): { count: number; digest: string; truncated: boolean } | undefined {
  const raw = execGitCapture(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (raw === undefined) return undefined
  const names = raw
    .split("\u0000")
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (names.length > MAX_UNTRACKED_FILES) {
    return { count: names.length, digest: "unknown", truncated: true }
  }
  const hash = createHash("sha256")
  let bytes = 0
  const nofollow = fsConstants.O_NOFOLLOW || 0
  const nonblock = fsConstants.O_NONBLOCK || 0
  for (const name of names) {
    hash.update(name)
    hash.update("\u0000")
    const file = join(cwd, name)
    let fd: number | null = null
    try {
      if (nofollow === 0 || nonblock === 0) {
        const st = lstatSync(file)
        if (st.isSymbolicLink()) {
          hash.update("symlink")
          continue
        }
        if (!st.isFile()) {
          hash.update("nonregular")
          continue
        }
      }
      fd = openSync(file, fsConstants.O_RDONLY | nofollow | nonblock)
      const fst = fstatSync(fd)
      if (!fst.isFile()) {
        hash.update("nonregular")
        continue
      }
      bytes += fst.size
      if (bytes > MAX_UNTRACKED_BYTES) return { count: names.length, digest: "unknown", truncated: true }
      hash.update(readFileSync(fd))
    } catch (err: any) {
      if (err?.code === "ELOOP" || err?.code === "EMLINK") hash.update("symlink")
      else hash.update("unreadable")
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }
  return { count: names.length, digest: hash.digest("hex"), truncated: false }
}

function captureGitBaseline(cwd: string, baseRef: string): ClaimBaseline | undefined {
  const headSha = execGitCapture(cwd, ["rev-parse", "HEAD"])
  if (!headSha) return undefined
  const baseSha = execGitCapture(cwd, ["rev-parse", "--verify", baseRef])
  const diff = baseSha ? execGitCapture(cwd, ["diff", "--no-color", `${baseSha}..${headSha}`]) : ""
  const status = execGitCapture(cwd, ["status", "--porcelain"])
  if (diff === undefined || status === undefined) return undefined
  const untracked = scanUntracked(cwd)
  if (!untracked) return undefined
  const diffHash = sha256Hex(diff)
  const statusHash = sha256Hex(status)
  const fingerprint = sha256Hex(
    canonicalJson({
      scope: "git",
      baseSha: baseSha ?? null,
      headSha,
      diffHash,
      statusHash,
      untracked,
    }),
  )
  return {
    scope: "git",
    ...(baseSha ? { baseSha } : {}),
    headSha,
    diffHash,
    statusHash,
    untracked,
    fingerprint,
    at: new Date().toISOString(),
  }
}

/**
 * The cheap half of a git baseline: HEAD, the tracked diff and porcelain status.
 * It deliberately omits the untracked scan (up to 1000 files / 8 MiB), which is
 * captured once outside the state.json critical section. Used under the lock to
 * prove the tracked tree did not move while a claim was being evaluated.
 */
function captureGitBaselineCheap(
  cwd: string,
  baseRef: string,
): { headSha: string; baseSha?: string; diffHash: string; statusHash: string } | undefined {
  const headSha = execGitCapture(cwd, ["rev-parse", "HEAD"])
  if (!headSha) return undefined
  const baseSha = execGitCapture(cwd, ["rev-parse", "--verify", baseRef])
  const diff = baseSha ? execGitCapture(cwd, ["diff", "--no-color", `${baseSha}..${headSha}`]) : ""
  const status = execGitCapture(cwd, ["status", "--porcelain"])
  if (diff === undefined || status === undefined) return undefined
  return {
    headSha,
    ...(baseSha ? { baseSha } : {}),
    diffHash: sha256Hex(diff),
    statusHash: sha256Hex(status),
  }
}

function collectArtifactFiles(
  run: string,
  target: string,
  out: Array<{ path: string; sha256: string; bytes: number }>,
  budget: { bytes: number },
): "ok" | "truncated" {
  const nofollow = fsConstants.O_NOFOLLOW || 0
  const nonblock = fsConstants.O_NONBLOCK || 0
  if (nofollow === 0 || nonblock === 0) {
    try {
      if (lstatSync(target).isSymbolicLink()) return "ok"
    } catch {
      return "ok"
    }
  }

  let isDir = false
  let fd: number | null = null
  try {
    fd = openSync(target, fsConstants.O_RDONLY | nofollow | nonblock)
    const st = fstatSync(fd)
    if (st.isFile()) {
      if (out.length >= MAX_UNTRACKED_FILES) return "truncated"
      try {
        const data = readFileSync(fd)
        budget.bytes += data.byteLength
        if (budget.bytes > MAX_UNTRACKED_BYTES) return "truncated"
        out.push({ path: relative(run, target), sha256: sha256Hex(data), bytes: data.byteLength })
      } catch {
        out.push({ path: relative(run, target), sha256: "unreadable", bytes: 0 })
      }
      return "ok"
    }
    if (!st.isDirectory()) return "ok"
    isDir = true
  } catch (err: any) {
    if (err?.code === "EISDIR") isDir = true
    else return "ok"
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
  if (!isDir) return "ok"

  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return "ok"
  }
  for (const dirent of entries) {
    if (dirent.isSymbolicLink()) continue
    if (collectArtifactFiles(run, join(target, dirent.name), out, budget) === "truncated") return "truncated"
  }
  return "ok"
}

function captureArtifactBaseline(run: string, targets: string[]): ClaimBaseline | undefined {
  const files: Array<{ path: string; sha256: string; bytes: number }> = []
  const budget = { bytes: 0 }
  let truncated = false
  for (const target of targets) {
    if (collectArtifactFiles(run, target, files, budget) === "truncated") {
      truncated = true
      break
    }
  }
  const sorted = files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (truncated) {
    return {
      scope: "artifact",
      artifactHash: "unknown",
      fingerprint: "unknown",
      at: new Date().toISOString(),
      reason: "artifact scan exceeded the bounded file/byte cap",
    }
  }
  const artifactHash = sha256Hex(canonicalJson(sorted))
  return {
    scope: "artifact",
    artifactHash,
    fingerprint: sha256Hex(canonicalJson({ scope: "artifact", artifactHash })),
    at: new Date().toISOString(),
  }
}

/**
 * Capture the side-effect baseline for a task: the git worktree fingerprint
 * when one exists, otherwise the artifact scope for the route.
 */
function captureClaimBaseline(
  root: string,
  run: string,
  task: any,
  taskId: string,
  status: string,
  plan: any,
): ClaimBaseline | undefined {
  const runId = basename(run)
  const topology = plan?.topology
  const documentScope = topology === "document-review" || /^doc-/.test(taskId) || /^seg-/.test(taskId)
  const lemmaScope = plan?.lemmaMode === true || plan?.route === "lemma"
  const verifierScope =
    !documentScope && !lemmaScope && (status === "worker_done" || status === "verifier_active" || status === "verified_pass")
  if (verifierScope) {
    return captureArtifactBaseline(run, [
      join(run, "verify", `report-${taskId}.json`),
      join(run, "verify", `challenge-${taskId}.json`),
      join(run, "verify", `audit-${taskId}.json`),
    ])
  }

  const worktree = findTaskWorktree(root, runId, task, taskId)
  if (worktree) return captureGitBaseline(worktree.path, `teamwork/base-${runId}`)

  const targets: string[] = []
  if (documentScope) {
    targets.push(join(run, "document-review", "segments", taskId))
    if (taskId === "doc-synthesis") targets.push(join(run, "document-review", "synthesis"))
    targets.push(join(run, "DOCUMENT_REVIEW_REPORT.md"))
  } else if (lemmaScope) {
    targets.push(join(run, "lemma", "nodes", taskId))
    targets.push(join(run, "lemma"))
  }
  if (!targets.length) return undefined
  return captureArtifactBaseline(run, targets)
}

interface WorktreeInspection {
  available: boolean
  worktree?: string
  headSha?: string
  baseSha?: string
  diffHash?: string
  diffstat?: string
  commitCount: number
  commits: Array<{ sha: string; subject: string }>
  dirty: boolean
  dirtyPaths: string[]
  untracked?: { count: number; digest: string; truncated: boolean }
  baselineAncestor?: boolean
}

/** Read-only git evidence used by `teamwork_recover` and `teamwork_status`. */
function inspectWorktreeState(
  root: string,
  run: string,
  task: any,
  taskId: string,
  baseline?: ClaimBaseline,
): WorktreeInspection {
  const runId = basename(run)
  const worktree = findTaskWorktree(root, runId, task, taskId)
  const branch = `teamwork/${runId}-${taskId}`
  const baseBranch = `teamwork/base-${runId}`
  const headSha = execGitCapture(root, ["rev-parse", "--verify", branch])
  const baseSha = execGitCapture(root, ["rev-parse", "--verify", baseBranch]) ?? baseline?.baseSha
  const empty: WorktreeInspection = {
    available: !!headSha,
    ...(worktree ? { worktree: worktree.path } : {}),
    ...(headSha ? { headSha } : {}),
    ...(baseSha ? { baseSha } : {}),
    commitCount: 0,
    commits: [],
    dirty: false,
    dirtyPaths: [],
  }
  if (!headSha) return empty
  const diff = baseSha ? execGitCapture(root, ["diff", "--no-color", `${baseSha}..${headSha}`]) ?? "" : ""
  const diffstat = baseSha ? execGitCapture(root, ["diff", "--stat", `${baseSha}..${headSha}`]) : undefined
  const log = execGitCapture(root, ["log", "--oneline", "--no-decorate", baseSha ? `${baseSha}..${headSha}` : "HEAD"])
  const commits = (log ? log.split("\n") : [])
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => {
      const [sha, ...rest] = line.split(" ")
      return { sha, subject: clean(rest.join(" "), 120) }
    })
  const commitCount = log ? log.split("\n").filter(Boolean).length : 0
  let dirty = false
  let dirtyPaths: string[] = []
  let untracked: WorktreeInspection["untracked"]
  if (worktree) {
    const status = execGitCapture(worktree.path, ["status", "--porcelain"]) ?? ""
    dirtyPaths = status.split("\n").filter(Boolean).slice(0, 50).map((line) => clean(line, 200))
    dirty = dirtyPaths.length > 0
    untracked = scanUntracked(worktree.path)
  }
  let baselineAncestor: boolean | undefined
  if (baseline?.headSha) {
    baselineAncestor =
      execGitCapture(root, ["merge-base", "--is-ancestor", baseline.headSha, headSha]) !== undefined
  }
  return {
    available: true,
    ...(worktree ? { worktree: worktree.path } : {}),
    headSha,
    ...(baseSha ? { baseSha } : {}),
    diffHash: sha256Hex(diff),
    ...(diffstat ? { diffstat } : {}),
    commitCount,
    commits,
    dirty,
    dirtyPaths,
    ...(untracked ? { untracked } : {}),
    ...(baselineAncestor !== undefined ? { baselineAncestor } : {}),
  }
}

// ---------------------------------------------------------------------------
// Session ownership and inspection tokens
// ---------------------------------------------------------------------------

const CLAIM_SESSION_MAX_DEPTH = 32

/** `same` owner, `descendant` of the owner, or `none`. Fails closed. */
async function claimRelation(
  ctx: any,
  sessionID: string | undefined,
  owner: string | undefined,
): Promise<"same" | "descendant" | "none"> {
  if (!sessionID || !owner) return "none"
  if (sessionID === owner) return "same"
  if (typeof ctx?.session?.get !== "function") return "none"
  let current = sessionID
  for (let depth = 0; depth < CLAIM_SESSION_MAX_DEPTH; depth++) {
    let info: any
    try {
      info = await ctx.session.get({ sessionID: current })
    } catch {
      return "none"
    }
    const parent = info?.parentID ?? info?.parentId ?? info?.parent_id
    if (typeof parent !== "string" || parent.trim() === "") return "none"
    if (parent === owner) return "descendant"
    current = parent
  }
  return "none"
}

function normalizeInspection(raw: any): any | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const tokenHash = typeof raw.tokenHash === "string" ? clean(raw.tokenHash, 128).trim() : ""
  const at = claimTime(raw.at)
  const expiresAt = claimTime(raw.expiresAt)
  const fingerprint = typeof raw.fingerprint === "string" ? clean(raw.fingerprint, 128).trim() : ""
  if (!tokenHash || !at || !expiresAt || !fingerprint) return undefined
  return {
    tokenHash,
    at,
    expiresAt,
    fingerprint,
    round: Math.max(0, Math.trunc(Number(raw.round) || 0)),
    fence: Math.max(0, Math.trunc(Number(raw.fence) || 0)),
    ...(typeof raw.by === "string" && raw.by.trim() ? { by: clean(raw.by, 80).trim() } : {}),
    ...(typeof raw.baseSha === "string" ? { baseSha: clean(raw.baseSha, 64) } : {}),
    ...(typeof raw.headSha === "string" ? { headSha: clean(raw.headSha, 64) } : {}),
    ...(typeof raw.diffHash === "string" ? { diffHash: clean(raw.diffHash, 64) } : {}),
  }
}

function issueInspectionToken(task: any, observed: ClaimBaseline | undefined, now: number): string {
  const token = randomBytes(24).toString("base64url")
  const claim = normalizeClaim(task?.claim)
  task.inspection = {
    tokenHash: sha256Hex(token),
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + INSPECTION_TOKEN_TTL_MS).toISOString(),
    fingerprint: observed?.fingerprint ?? "unknown",
    round: Math.max(0, Math.trunc(Number(task?.round) || 0)),
    fence: nextFence(task),
    ...(claim?.by ? { by: claim.by } : {}),
    ...(observed?.baseSha ? { baseSha: observed.baseSha } : {}),
    ...(observed?.headSha ? { headSha: observed.headSha } : {}),
    ...(observed?.diffHash ? { diffHash: observed.diffHash } : {}),
  }
  return token
}

function validateInspectionToken(
  task: any,
  token: unknown,
  now: number,
): { ok: true; inspection: any } | { ok: false; code: string; reason: string } {
  const inspection = normalizeInspection(task?.inspection)
  if (!inspection) {
    return { ok: false, code: "INSPECTION_TOKEN_REQUIRED", reason: "run teamwork_recover with action \"inspect\" first" }
  }
  if (Date.parse(inspection.expiresAt) <= now) {
    return { ok: false, code: "INSPECTION_EXPIRED", reason: "the inspection token expired; inspect again" }
  }
  const presented = typeof token === "string" ? token.trim() : ""
  if (!presented || sha256Hex(presented) !== inspection.tokenHash) {
    return { ok: false, code: "INSPECTION_TOKEN_INVALID", reason: "the inspection token does not match" }
  }
  // A token is bound to the exact claim generation it was issued for. If the
  // round, fence, or claimant changed since inspection, the evidence the
  // operator saw no longer describes the claim they are about to recover.
  const claim = normalizeClaim(task?.claim)
  if (
    inspection.round !== Math.max(0, Math.trunc(Number(task?.round) || 0)) ||
    inspection.fence !== nextFence(task) ||
    (inspection.by ?? "") !== (claim?.by ?? "")
  ) {
    return {
      ok: false,
      code: "INSPECTION_STALE",
      reason: `the inspection token was issued for round ${inspection.round}, fence ${inspection.fence}, claim ${inspection.by ?? "unknown"}; the task is now round ${Math.max(0, Math.trunc(Number(task?.round) || 0))}, fence ${nextFence(task)}, claim ${claim?.by ?? "unknown"}. Inspect again`,
    }
  }
  return { ok: true, inspection }
}

interface ReportBindingCheck {
  ok: boolean
  code?: string
  reason?: string
  warning?: string
}

/**
 * Validate a verifier report against the live round/fence/branch. A report that
 * predates the binding fields is accepted with a `legacy_unbound_report`
 * warning; it is never silently treated as bound to the current round.
 */
function validateVerifierReportBinding(
  report: any,
  opts: {
    taskId: string
    round: number
    fence: number
    root: string
    runId: string
    requireReportBinding?: boolean
  },
  evidence?: { headSha?: string; baseSha?: string; diffHash?: string },
): ReportBindingCheck {
  if (!report || typeof report !== "object") {
    return { ok: false, code: "REPORT_MISSING", reason: "no verifier report was found" }
  }
  const warnings = new Set<string>()
  if (report.round === undefined || report.round === null) {
    warnings.add("legacy_unbound_report")
  } else if (Number(report.round) !== opts.round) {
    return {
      ok: false,
      code: "REPORT_ROUND_STALE",
      reason: `report round ${Number(report.round)} does not match the current round ${opts.round}`,
    }
  }
  if (report.fence !== undefined && report.fence !== null && Number(report.fence) !== opts.fence) {
    return {
      ok: false,
      code: "REPORT_FENCE_STALE",
      reason: `report fence ${Number(report.fence)} does not match the current fence ${opts.fence}`,
    }
  }
  const branch = `teamwork/${opts.runId}-${opts.taskId}`
  // `evidence` is the pre-lock git read. Only the cheap HEAD is re-read under
  // the lock, so the critical section never runs a full diff.
  const headSha = evidence ? evidence.headSha : execGitCapture(opts.root, ["rev-parse", "--verify", branch])
  if (typeof report.headSha === "string" && report.headSha && headSha && report.headSha !== headSha) {
    return {
      ok: false,
      code: "BRANCH_MOVED",
      reason: `the branch head moved after the report (report ${report.headSha.slice(0, 12)}, head ${headSha.slice(0, 12)})`,
    }
  }
  if (typeof report.diffHash === "string" && report.diffHash) {
    let actualDiffHash = evidence?.diffHash
    if (actualDiffHash === undefined) {
      const baseSha = execGitCapture(opts.root, ["rev-parse", "--verify", `teamwork/base-${opts.runId}`])
      const head = headSha ?? execGitCapture(opts.root, ["rev-parse", "HEAD"])
      if (baseSha && head) {
        const diff = execGitCapture(opts.root, ["diff", "--no-color", `${baseSha}..${head}`]) ?? ""
        actualDiffHash = sha256Hex(diff)
      }
    }
    if (actualDiffHash !== undefined && actualDiffHash !== report.diffHash) {
      return {
        ok: false,
        code: "BRANCH_MOVED",
        reason: "the branch diff changed after the verifier report",
      }
    }
  }
  if (opts.requireReportBinding === true) {
    if (typeof report.headSha !== "string" || report.headSha === "" || typeof report.diffHash !== "string" || report.diffHash === "") {
      return {
        ok: false,
        code: "REPORT_UNBOUND",
        reason: "requireReportBinding is asserted, but the report carries no headSha/diffHash",
      }
    }
  } else if (report.headSha === undefined || report.diffHash === undefined) {
    warnings.add("legacy_unbound_report")
  }
  return { ok: true, ...(warnings.size ? { warning: Array.from(warnings).join(",") } : {}) }
}

const CHECK_MAX_ARGS = 32
const CHECK_MAX_ARG_BYTES = 4096
const CHECK_DEFAULT_TIMEOUT_MS = 120000
const CHECK_MAX_TIMEOUT_MS = 600000
const SHELL_NAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "pdksh",
  "fish",
  "csh",
  "tcsh",
  "busybox",
  "ash",
  "powershell",
  "pwsh",
  "cmd",
  "cmd.exe",
  "sh.exe",
  "bash.exe",
])

/** Refuse an argv that names a shell and asks it to evaluate a string. */
function checkShellRefusal(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const name = basename(String(argv[i])).toLowerCase()
    if (!SHELL_NAMES.has(name)) continue
    for (let j = i + 1; j < argv.length; j += 1) {
      const arg = String(argv[j]).toLowerCase()
      if (arg === "-c" || arg === "/c" || arg === "-command" || arg.startsWith("-command:")) {
        return `uses a shell interpreter (${name} ${String(argv[j])})`
      }
    }
  }
  return undefined
}

function normalizeCheckCwd(raw: unknown): { cwd?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { cwd: "." }
  if (typeof raw !== "string") return { error: "cwd must be a string" }
  if (raw.includes("\0")) return { error: "cwd contains a NUL byte" }
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return { error: "cwd must be relative to the worktree" }
  if (raw.startsWith("~")) return { error: "cwd must not start with ~" }
  const segments = raw.split("/")
  if (segments.includes("..")) return { error: "cwd must not escape the worktree with .." }
  const cwd = segments.filter((segment) => segment !== "" && segment !== ".").join("/")
  return { cwd: cwd === "" ? "." : cwd }
}

/** Normalise and validate argv-only command evidence for checks[] v2. */
function normalizeCheckCommand(raw: unknown): { argv?: string[]; error?: string } {
  if (!Array.isArray(raw)) return { error: "command must be an array of argv strings" }
  if (raw.length === 0) return { error: "command must not be empty" }
  if (raw.length > CHECK_MAX_ARGS) return { error: `command has ${raw.length} args (cap ${CHECK_MAX_ARGS})` }
  const argv: string[] = []
  for (const arg of raw) {
    if (typeof arg !== "string" || arg === "") return { error: "command must contain only non-empty strings" }
    if (arg.includes("\0")) return { error: "command must not contain a NUL byte" }
    if (Buffer.byteLength(arg, "utf8") > CHECK_MAX_ARG_BYTES) {
      return { error: `command arg exceeds ${CHECK_MAX_ARG_BYTES} bytes` }
    }
    argv.push(arg)
  }
  const shell = checkShellRefusal(argv)
  if (shell) return { error: `command ${shell}; record argv, not a shell line` }
  return { argv }
}

/** The run-relative command digest: unkeyed over canonical {argv,cwd}. */
function checkCommandDigest(argv: string[], cwd: string): string {
  return contentSha256Hex(canonicalJson({ argv, cwd }))
}

/**
 * Validate and normalise one checks[] v2 entry. The engine computes the
 * provenance fields (commandSha256, outputBytes, outputSha256); a caller can
 * only supply the observation (command, cwd, exitCode, output, durationMs).
 */
function normalizeReportCheck(
  c: any,
  provenance: ProvenanceMode,
): { check?: any; problems: string[] } {
  const problems: string[] = []
  const name = clean(c?.name, 200) || `#${"?"}`
  const type = clean(c?.type, 64) || "check"
  const rawOutput = typeof c?.output === "string" ? c.output : ""
  const hasCommandInput = c?.command !== undefined
  // A command claim's digest must cover exactly the bytes the verifier
  // captured: sanitising or trimming would make every re-execution mismatch.
  // Non-command prose keeps the existing display sanitisation.
  const output = hasCommandInput
    ? rawOutput.length > 2000
      ? rawOutput.slice(0, 2000)
      : rawOutput
    : rawOutput
      ? cleanBlock(rawOutput, 2000).trim()
      : ""
  const outputTruncated = c?.outputTruncated === true || rawOutput.length > 2000
  const exitCode = Number.isInteger(c?.exitCode) ? Number(c.exitCode) : undefined
  const durationMs = c?.durationMs === undefined ? undefined : Number(c.durationMs)
  const timeoutMs = c?.timeoutMs === undefined ? CHECK_DEFAULT_TIMEOUT_MS : Number(c.timeoutMs)
  const check: any = {
    name,
    type,
    passed: c?.passed === true,
    ...(output ? { output, outputSha256: sha256Hex(output) } : {}),
    ...(typeof c?.error === "string" && cleanBlock(c.error, 2000).trim()
      ? { error: cleanBlock(c.error, 2000).trim() }
      : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  }

  if (c?.command !== undefined) {
    const argvCheck = normalizeCheckCommand(c.command)
    const cwdCheck = normalizeCheckCwd(c.cwd)
    if (argvCheck.error) problems.push(`check ${name} ${argvCheck.error}`)
    if (cwdCheck.error) problems.push(`check ${name} ${cwdCheck.error}`)
    if (exitCode === undefined) problems.push(`check ${name} with a command must record an integer exitCode`)
    if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 0)) {
      problems.push(`check ${name} durationMs must be a non-negative integer`)
    }
    if (durationMs === undefined) problems.push(`check ${name} with a command must record durationMs`)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CHECK_MAX_TIMEOUT_MS) {
      problems.push(`check ${name} timeoutMs must be an integer in 1..${CHECK_MAX_TIMEOUT_MS}`)
    }
    if (argvCheck.argv && cwdCheck.cwd !== undefined) {
      check.command = argvCheck.argv
      check.cwd = cwdCheck.cwd
      check.commandSha256 = checkCommandDigest(argvCheck.argv, cwdCheck.cwd)
    } else {
      if (argvCheck.argv) check.command = argvCheck.argv
      if (cwdCheck.cwd !== undefined) check.cwd = cwdCheck.cwd
    }
    check.outputBytes = Buffer.byteLength(output, "utf8")
    check.outputTruncated = outputTruncated
    if (durationMs !== undefined) check.durationMs = durationMs
    if (Number.isInteger(timeoutMs)) check.timeoutMs = timeoutMs
  } else {
    if (c?.cwd !== undefined || c?.commandSha256 !== undefined) {
      problems.push(`check ${name} records cwd/commandSha256 without a command`)
    }
    if (provenance === "command" && type === "programmatic") {
      problems.push(`CHECK_COMMAND_MISSING: programmatic check ${name} has no command under requiredProvenance "command"`)
    }
  }
  if (exitCode !== undefined && check.passed === true && exitCode !== 0) {
    problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=true but exitCode=${exitCode}`)
  } else if (exitCode !== undefined && check.passed !== true && exitCode === 0) {
    problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=false but exitCode=0`)
  }
  return { check, problems }
}

/** The signed rerun record for one check; only a full, untruncated capture. */
function rerunEntryForCheck(check: any): any | undefined {
  if (!check || !Array.isArray(check.command) || check.command.length === 0) return undefined
  if (check.outputTruncated !== false) return undefined
  return {
    name: check.name,
    argv: check.command,
    cwd: check.cwd,
    expectedExit: Number(check.exitCode),
    outputSha256: contentSha256Hex(check.output ?? ""),
    outputBytes: Buffer.byteLength(check.output ?? "", "utf8"),
    timeoutMs: Number(check.timeoutMs) || CHECK_DEFAULT_TIMEOUT_MS,
  }
}

/** The command checks a report claims, in report order (what rerun.json must mirror). */
function reportCommandProjection(report: any): any[] {
  return (Array.isArray(report?.checks) ? report.checks : [])
    .filter(
      (check: any) =>
        check &&
        typeof check === "object" &&
        Array.isArray(check.command) &&
        check.command.length > 0 &&
        check.outputTruncated === false,
    )
    .map((check: any) => ({
      name: check.name,
      argv: check.command,
      cwd: normalizeCheckCwd(check.cwd).cwd ?? ".",
      expectedExit: Number(check.exitCode),
      outputBytes: Number(check.outputBytes),
    }))
}

/** Compare a rerun.json task's checks to the report projection, in order. */
function rerunMatchesReport(report: any, recorded: any): boolean {
  if (!Array.isArray(recorded)) return false
  const expected = reportCommandProjection(report)
  if (recorded.length !== expected.length) return false
  for (let i = 0; i < expected.length; i += 1) {
    const a = expected[i]
    const b = recorded[i]
    if (!b || typeof b !== "object") return false
    if (b.name !== a.name || b.expectedExit !== a.expectedExit || b.outputBytes !== a.outputBytes) return false
    if (normalizeCheckCwd(b.cwd).cwd !== a.cwd) return false
    if (canonicalJson(b.argv) !== canonicalJson(a.argv)) return false
  }
  return true
}

/**
 * Re-check a verifier report's PASS evidence from its content. `teamwork_report`
 * writes these invariants, but final_verify must not trust a hand-forged file
 * that was signed through some other path: every check passed, no fatal
 * findings, some evidence, and each output hash matches the output bytes.
 */
function verifierReportIntegrityProblems(report: any, provenance: ProvenanceMode = "declared"): string[] {
  const problems: string[] = []
  if (!report || typeof report !== "object") return ["report is not an object"]
  const checks = Array.isArray(report.checks) ? report.checks : []
  if (report.checks !== undefined && !Array.isArray(report.checks)) {
    problems.push("checks is not an array")
  }
  let rerunnable = 0
  checks.forEach((check: any, index: number) => {
    const name = typeof check?.name === "string" && check.name ? check.name : `#${index + 1}`
    if (!check || typeof check !== "object" || check.passed !== true) {
      problems.push(`check ${name} did not pass`)
    }
    const output = typeof check?.output === "string" ? check.output : ""
    if (output !== "") {
      const expected = typeof check?.outputSha256 === "string" ? check.outputSha256 : ""
      if (expected !== sha256Hex(output)) problems.push(`check ${name} outputSha256 does not match its output`)
    } else if (check?.outputSha256 !== undefined) {
      problems.push(`check ${name} has outputSha256 without output`)
    }
    // D4: an exit code is a second, independent signal. `passed: true` with a
    // non-zero exitCode (or `passed: false` with 0) contradicts the verdict and
    // is refused by name instead of being ignored.
    if (check?.exitCode !== undefined && check?.exitCode !== null) {
      const exitCode = Number(check.exitCode)
      if (!Number.isInteger(exitCode)) {
        problems.push(`check ${name} exitCode is not an integer`)
      } else if (check.passed === true && exitCode !== 0) {
        problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=true but exitCode=${exitCode}`)
      } else if (check.passed !== true && exitCode === 0) {
        problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=false but exitCode=0`)
      }
    }
    // checks[] v2: a command is argv only and must be self-describing. The
    // digest is recomputed, never trusted.
    if (check?.command !== undefined) {
      const argvProblem = normalizeCheckCommand(check.command)
      const cwdCheck = normalizeCheckCwd(check.cwd)
      if (!Array.isArray(check.command)) problems.push(`check ${name} command must be an array of argv strings`)
      else if (check.command.length > CHECK_MAX_ARGS) problems.push(`check ${name} command has more than ${CHECK_MAX_ARGS} args`)
      if (argvProblem.error) problems.push(`check ${name} ${argvProblem.error}`)
      if (cwdCheck.error) problems.push(`check ${name} ${cwdCheck.error}`)
      if (!Number.isInteger(Number(check.exitCode))) problems.push(`check ${name} with a command must record an integer exitCode`)
      if (!Number.isInteger(Number(check.outputBytes)) || Number(check.outputBytes) < 0) {
        problems.push(`check ${name} must record a non-negative integer outputBytes`)
      }
      if (typeof check.outputTruncated !== "boolean") problems.push(`check ${name} must record a boolean outputTruncated`)
      if (!Number.isInteger(Number(check.durationMs)) || Number(check.durationMs) < 0) {
        problems.push(`check ${name} must record a non-negative integer durationMs`)
      }
      if (!cwdCheck.error && Array.isArray(check.command)) {
        let expected: string | undefined
        try {
          expected = checkCommandDigest(check.command, cwdCheck.cwd ?? ".")
        } catch {
          expected = undefined
        }
        if (!/^[0-9a-f]{64}$/.test(String(check.commandSha256 ?? ""))) {
          problems.push(`check ${name} commandSha256 is missing or invalid`)
        } else if (expected && check.commandSha256 !== expected) {
          problems.push(`check ${name} commandSha256 does not match {argv,cwd}`)
        }
      }
      if (check.outputTruncated === false && Number.isInteger(Number(check.outputBytes)) && output !== "") {
        if (Number(check.outputBytes) !== Buffer.byteLength(output, "utf8")) {
          problems.push(`check ${name} outputBytes does not match its untruncated output`)
        }
      }
      if (
        check.type === "programmatic" &&
        Array.isArray(check.command) &&
        check.command.length > 0 &&
        check.outputTruncated === false
      ) {
        rerunnable += 1
      }
    } else {
      if (check?.cwd !== undefined || check?.commandSha256 !== undefined) {
        problems.push(`check ${name} records cwd/commandSha256 without a command`)
      }
      if (provenance === "command" && check?.type === "programmatic") {
        problems.push(`CHECK_COMMAND_MISSING: programmatic check ${name} has no command under requiredProvenance "command"`)
      }
    }
  })
  if (provenance === "command" && rerunnable === 0) {
    problems.push(
      'CHECK_COMMAND_MISSING: requiredProvenance "command" needs at least one programmatic check with a re-executable command',
    )
  }
  if (Array.isArray(report.fatalFindings) && report.fatalFindings.length > 0) {
    problems.push("fatalFindings is non-empty")
  }
  const summary = typeof report.summary === "string" ? report.summary.trim() : ""
  if (summary === "" && checks.length === 0) problems.push("no summary and no checks")
  return problems
}

function isSentinelAgent(agent: string | undefined): boolean {
  return agent === "team/sentinel" || agent === "team/orchestrator"
}

/** Re-read state under its cross-process lock, mutate it, and write it once. */
async function mutateRunState<T>(
  run: string,
  mutator: (state: any) => T | Promise<T>,
  opts: { write?: (state: any) => boolean } = {},
): Promise<T | undefined> {
  const stateFile = join(run, "state.json")
  return withPinnedCrossProcessLock(run, runRel(run, stateFile), async () => {
    const state = readJson<any>(run, stateFile, undefined)
    if (!state || typeof state.tasks !== "object") return undefined
    const result = await mutator(state)
    if (!opts.write || opts.write(state)) {
      state.updatedAt = new Date().toISOString()
      writeJson(run, stateFile, state)
    }
    return result
  })
}

async function setRunPhase(run: string, phase: string): Promise<void> {
  let changed = false
  await mutateRunState(
    run,
    (state) => {
      changed = state.phase !== phase
      state.phase = phase
    },
    { write: () => changed },
  )
}

/**
 * Renew a claim when the caller is its owner or descends from the owner.
 * Never changes the fence. Failures are silent: a heartbeat is an optimisation
 * for a live owner, not a mutation the calling tool depends on.
 */
async function renewClaimFor(
  run: string,
  taskId: string | undefined,
  sessionID: string | undefined,
  ctx: any,
  note: string,
): Promise<{ renewed: boolean; reason?: string }> {
  if (!taskId || !sessionID) return { renewed: false }
  const pre = readJson<any>(run, join(run, "state.json"), undefined)
  // Protocol 1 keeps the 0.9.0 shape: no heartbeat fields are added.
  if (claimProtocolOf(pre) < CLAIM_PROTOCOL) return { renewed: false }
  const preClaim = normalizeClaim(pre?.tasks?.[taskId]?.claim)
  if (!preClaim) return { renewed: false }
  const relation = await claimRelation(ctx, sessionID, preClaim.by)
  if (relation !== "same" && relation !== "descendant") return { renewed: false }

  const now = Date.now()
  let result: { renewed: boolean; reason?: string } = { renewed: false }
  let forceExpired = false
  await mutateRunState(
    run,
    (state) => {
      const task = state.tasks?.[taskId]
      const claim = normalizeClaim(task?.claim)
      if (!claim || claim.by !== preClaim.by) return
      const leaseMs = claimLeaseOf(state)
      const renewal = renewClaimObject(claim, now, leaseMs)
      task.claim = renewal.claim
      if (!renewal.renewed) {
        forceExpired = true
        task.claim.needsInspection = true
        result = { renewed: false, reason: renewal.reason }
      } else {
        result = { renewed: true }
      }
    },
    { write: () => true },
  )
  if (result.renewed) {
    await appendEvent(run, {
      event: "claim_renewed",
      sessionId: basename(run),
      taskId,
      to: "CLAIM_RENEWED",
      round: 0,
      note: `${note}: heartbeat renewed for ${preClaim.by}`,
    })
  } else if (forceExpired) {
    await appendEvent(run, {
      event: "claim_inspection_required",
      sessionId: basename(run),
      taskId,
      to: "NEEDS_INSPECTION",
      round: 0,
      note: `${note}: ${result.reason ?? "claim forced expired"}`,
    })
  }
  return result
}

interface ClaimCandidate {
  id: string
  round?: number
  claim?: any
  fence?: number
}

interface ClaimEvent {
  event:
    | "claim_renewed"
    | "claim_reclaimed"
    | "claim_released"
    | "claim_inspection_required"
    | "claim_recovered"
    | "claim_override"
  taskId: string
  round: number
  note: string
}

/**
 * Atomically claim the ready tasks handed out by `teamwork_next`.
 *
 * The first read of state.json happened before the (potentially expensive)
 * gate checks. This function re-reads it under the cross-process lock and
 * re-checks each task's current status, so a task another process started or
 * claimed in the meantime is never returned as ready.
 *
 * Protocol 2 requires a side-effect baseline before an expired claim from
 * another session can be reclaimed. A missing, unknown, or changed fingerprint
 * marks the claim `needs-inspection` and excludes the task from the ready list;
 * it is never silently re-dispatched. A cross-host claim is never reclaimed.
 */
async function claimReadyTasks(
  root: string,
  run: string,
  plan: any,
  readyForWorker: ClaimCandidate[],
  readyForVerifier: ClaimCandidate[],
  callSession: string | undefined,
  observedBaselines: Map<string, ClaimBaseline | undefined> = new Map(),
  observedWorktrees: Map<string, string | undefined> = new Map(),
): Promise<{
  worker: ClaimCandidate[]
  verifier: ClaimCandidate[]
  skipped: any[]
  events: ClaimEvent[]
  protocol: number
}> {
  if (!callSession) return { worker: readyForWorker, verifier: readyForVerifier, skipped: [], events: [], protocol: 1 }
  const stateFile = join(run, "state.json")
  return withPinnedCrossProcessLock(run, runRel(run, stateFile), async () => {
    const state = readJson<any>(run, stateFile, undefined)
    if (!state || typeof state.tasks !== "object") {
      return { worker: [], verifier: [], skipped: [], events: [], protocol: 1 }
    }
    state.tasks = nullMap(state.tasks)
    const protocol = claimProtocolOf(state)
    const leaseMs = claimLeaseOf(state)
    const host = runHostOf(state, plan)
    const now = Date.now()
    const worker: ClaimCandidate[] = []
    const verifier: ClaimCandidate[] = []
    const skipped: any[] = []
    const events: ClaimEvent[] = []
    let changed = false

    const markNeedsInspection = (taskId: string, task: any, reason: string) => {
      const raw = task?.claim && typeof task.claim === "object" ? task.claim : undefined
      if (!raw) return
      const first = raw.needsInspection !== true
      raw.needsInspection = true
      if (first) {
        events.push({
          event: "claim_inspection_required",
          taskId,
          round: Number(task.round) || 0,
          note: reason,
        })
      }
      changed = true
    }

    const claimOne = (candidate: ClaimCandidate, kind: "worker" | "verifier") => {
      const st = state.tasks[candidate.id]
      if (!st || typeof st !== "object") return
      const status = typeof st.status === "string" ? st.status : "pending"
      const eligible =
        kind === "worker"
          ? status === "pending" || status === "verified_fail" || status === "fail"
          : status === "worker_done"
      if (!eligible) {
        skipped.push({ id: candidate.id, status, round: Number(st.round) || 0, claim: publicClaim(st.claim), reason: "status changed" })
        return
      }
      const existing = normalizeClaim(st.claim)
      const derivedExisting = existing
        ? deriveClaimState(st, now, { legacyHostless: protocol < CLAIM_PROTOCOL })
        : undefined
      const heldLive =
        derivedExisting?.state === "live" ||
        (protocol < CLAIM_PROTOCOL && derivedExisting?.state === "cross-host")
      // A cross-host claim is never renewed or re-dispatched, even when the
      // claimant string matches this session: the same session id on another
      // host is not this live process. A missing host is cross-host.
      if (existing && protocol >= CLAIM_PROTOCOL && derivedExisting?.state === "cross-host") {
        skipped.push({
          id: candidate.id,
          status: "claimed",
          round: Number(st.round) || 0,
          claim: publicClaim(existing),
          claimState: "cross-host",
          fence: nextFence(st),
          reason: `claim was made on host ${existing.host ?? "unknown"}; cross-host claims are never auto-reclaimed`,
        })
        return
      }
      if (existing && existing.by !== callSession && heldLive) {
        skipped.push({
          id: candidate.id,
          status: "claimed",
          round: Number(st.round) || 0,
          claim: publicClaim(existing),
          claimState: derivedExisting.state,
          fence: nextFence(st),
          reason: `live claim held by ${existing.by}`,
        })
        return
      }

      // A flagged claim is never re-dispatched, even when the caller owns it and
      // the fingerprint happens to match. Inspect, then explicitly recover.
      if (existing && protocol >= CLAIM_PROTOCOL && (existing.needsInspection === true || derivedExisting?.state === "needs-inspection")) {
        skipped.push({
          id: candidate.id,
          status: "claimed",
          round: Number(st.round) || 0,
          claim: publicClaim(existing),
          claimState: "needs-inspection",
          fence: nextFence(st),
          reason: "the claim needs inspection; run teamwork_recover { action: \"inspect\" } before reclaiming",
        })
        return
      }

      if (existing && existing.by === callSession) {
        if (protocol < CLAIM_PROTOCOL) {
          const claim = makeLegacyTaskClaim(callSession, now, undefined)
          if (existing.previousClaimant) claim.previousClaimant = existing.previousClaimant
          if (existing.override === "sentinel") claim.override = "sentinel"
          st.claim = claim
          changed = true
          candidate.claim = publicClaim(claim)
          ;(kind === "worker" ? worker : verifier).push(candidate)
          return
        }
        const renewal = renewClaimObject(existing, now, leaseMs)
        st.claim = renewal.claim
        changed = true
        candidate.fence = nextFence(st)
        candidate.claim = publicClaim(renewal.claim)
        if (!renewal.renewed) {
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(renewal.claim),
            claimState: "expired",
            fence: candidate.fence,
            reason: renewal.reason ?? "max claim tenure reached",
          })
          events.push({
            event: "claim_inspection_required",
            taskId: candidate.id,
            round: Number(st.round) || 0,
            note: renewal.reason ?? "max claim tenure reached",
          })
          return
        }
        ;(kind === "worker" ? worker : verifier).push(candidate)
        return
      }

      if (existing && protocol >= CLAIM_PROTOCOL) {
        const derived = deriveClaimState(st, now, { legacyHostless: protocol < CLAIM_PROTOCOL })
        if (derived.crossHost) {
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(existing),
            claimState: "cross-host",
            fence: nextFence(st),
            reason: `claim was made on host ${existing.host ?? "unknown"}; cross-host claims are never auto-reclaimed`,
          })
          return
        }
        if (derived.state === "needs-inspection") {
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(existing),
            claimState: "needs-inspection",
            fence: nextFence(st),
            reason: "needs-inspection: the claim was flagged by an earlier transition",
          })
          return
        }
        const baseline = normalizeBaseline(st.claim?.baseline)
        if (derived.state === "expired") {
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(existing),
            claimState: "expired",
            fence: nextFence(st),
            reason: "the claim is past its lease but inside the grace window; not reclaimable yet",
          })
          return
        }
        if (!baseline || baseline.fingerprint === "unknown") {
          markNeedsInspection(candidate.id, st, "expired claim has no usable side-effect baseline")
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(st.claim),
            claimState: "needs-inspection",
            fence: nextFence(st),
            reason: "needs-inspection: missing or unknown baseline",
          })
          return
        }
        // The full baseline (including the bounded untracked scan) was captured
        // before this lock. Under the lock only the cheap tracked evidence is
        // re-read, so a multi-MiB untracked scan never extends the critical
        // section. A tracked tree that moved in between is not reclaimable.
        const current = observedBaselines.get(candidate.id)
        const cwd = observedWorktrees.get(candidate.id)
        let drifted = false
        if (current && current.scope === "git" && cwd) {
          const cheap = captureGitBaselineCheap(cwd, `teamwork/base-${basename(run)}`)
          drifted =
            !cheap ||
            cheap.headSha !== current.headSha ||
            cheap.diffHash !== current.diffHash ||
            cheap.statusHash !== current.statusHash
        }
        if (drifted) {
          markNeedsInspection(candidate.id, st, "the tracked worktree changed while the claim was being evaluated")
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(st.claim),
            claimState: "needs-inspection",
            fence: nextFence(st),
            reason: "needs-inspection: the tracked worktree changed during claim evaluation",
          })
          return
        }
        if (!current || current.fingerprint === "unknown" || current.fingerprint !== baseline.fingerprint) {
          markNeedsInspection(candidate.id, st, "side effects changed since the claim baseline")
          skipped.push({
            id: candidate.id,
            status: "claimed",
            round: Number(st.round) || 0,
            claim: publicClaim(st.claim),
            claimState: "needs-inspection",
            fence: nextFence(st),
            reason:
              !current || current.fingerprint === "unknown"
                ? "needs-inspection: the current side effects cannot be observed"
                : "needs-inspection: side effects changed since the baseline",
          })
          return
        }
      }

      const previous = existing && existing.by !== callSession ? existing : undefined
      const fence = nextFence(st) + 1
      const claim =
        protocol >= CLAIM_PROTOCOL
          ? makeTaskClaim(callSession, now, previous, {
              host: SELF_HOST,
              runHost: host,
              leaseMs,
              epoch: (Number(existing?.epoch) || 0) + 1,
              event: previous ? "reclaimed" : "claimed",
              priorHistory: st.claimHistory,
            })
          : makeLegacyTaskClaim(callSession, now, previous)
      st.claim = claim
      if (protocol >= CLAIM_PROTOCOL) st.fence = fence
      st.updatedAt = new Date(now).toISOString()
      changed = true
      candidate.claim = publicClaim(claim)
      if (protocol >= CLAIM_PROTOCOL) candidate.fence = fence
      if (previous && protocol >= CLAIM_PROTOCOL) {
        events.push({
          event: "claim_reclaimed",
          taskId: candidate.id,
          round: Number(st.round) || 0,
          note: `reclaimed an expired claim from ${previous.by}; fingerprint unchanged`,
        })
      }
      ;(kind === "worker" ? worker : verifier).push(candidate)
    }

    for (const candidate of readyForWorker) claimOne(candidate, "worker")
    for (const candidate of readyForVerifier) claimOne(candidate, "verifier")

    // Auto-renew a live claim the same session already owns on an in-progress
    // task (a Sentinel that calls `next` again keeps its own worker alive).
    // Protocol 1 keeps the 0.9.0 behaviour: an in-progress claim is untouched.
    if (protocol >= CLAIM_PROTOCOL) {
      for (const [taskId, task] of Object.entries(state.tasks) as Array<[string, any]>) {
        if (!task || typeof task !== "object") continue
        const status = typeof task.status === "string" ? task.status : ""
        if (status !== "worker_active" && status !== "verifier_active") continue
        const claim = normalizeClaim(task.claim)
        if (!claim || claim.by !== callSession) continue
        const renewal = renewClaimObject(claim, now, leaseMs)
        task.claim = renewal.claim
        changed = true
        if (!renewal.renewed) {
          task.claim.needsInspection = true
          events.push({
            event: "claim_inspection_required",
            taskId,
            round: Number(task.round) || 0,
            note: renewal.reason ?? "max claim tenure reached",
          })
        }
      }
    }

    if (changed) {
      state.updatedAt = new Date(now).toISOString()
      writeJson(run, stateFile, state)
    }
    return { worker, verifier, skipped, events, protocol }
  })
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
  // Path signature retained for non-run callers and tests. Run call sites use
  // `touchRun`, which creates the file inside the pinned run directory.
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(file, content, { encoding: "utf8", flag: "wx" })
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err
  }
}

/** Create `run/relPath` once through the pinned writer; EEXIST is a no-op. */
function touchRun(run: string, relPath: string, content: string) {
  touchWithin(run, relPath, content)
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
    return nextEventSeqFromFd(fd)
  } catch {
    return 1
  } finally {
    closeSync(fd)
  }
}

/**
 * Sequence number computed from an already-open `events.jsonl` descriptor. The
 * pinned append path (ADR 0010) passes the append fd here, so the tail read and
 * the append are guaranteed to be the same inode. Positional reads do not move
 * the append offset.
 */
export function nextEventSeqFromFd(fd: number): number {
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return 1
    const fromTail = seqFromTail(readTail(fd, stat.size))
    if (fromTail !== null) return fromTail
    return countNonEmptyLines(fd) + 1
  } catch {
    return 1
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
      | "handoff_recorded"
      | "claim_renewed"
      | "claim_reclaimed"
      | "claim_released"
      | "claim_inspection_required"
      | "claim_recovered"
      | "claim_override"
      | "write_anomaly"
    sessionId: string
    taskId?: string | null
    from?: string | null
    to: string
    round?: number
    agent?: string | null
    /** Provenance of `agent`: explicit input, the call context, a session lookup, or plan declaration. */
    agentSource?: "explicit" | "context" | "session" | "plan"
    branch?: string | null
    worktree?: string | null
    phase?: string | null
    /** run_created only: how the spec presence gate was decided (3.4). */
    specGate?: "satisfied" | "bypassed" | "not_required"
    /** run_created only: the spec file, when the gate was satisfied. */
    specPath?: string | null
    /** run_created only: approval summary (0.11.0 prompt binding). */
    approvalDigest?: string | null
    approvalKeyId?: string | null
    approvedBy?: string | null
    promptDraftSha256?: string | null
    binding?: "prompt" | null
    /**
     * final_verification_bypass: why an unstamped verdict was accepted.
     * preflight / run_created: an input-preflight bypass or missing-input note.
     */
    note?: string | null
  },
) {
  try {
    const eventsFile = join(run, "events.jsonl")
    // ADR 0010: the lock file and the append both live inside the pinned run
    // directory. `nextEventSeqFromFd` reads the tail through the *same* append
    // descriptor, so a sequence number cannot come from a different inode.
    await withPinnedCrossProcessLock(run, "events.jsonl", () => {
      const opt = (v: unknown, max: number) => (v === null || v === undefined || v === "" ? null : clean(v, max))
      const agent = opt(ev.agent, 64)
      const note = opt(ev.note, 200)
      const source =
        agent && (ev.agentSource === "explicit" ||
        ev.agentSource === "context" ||
        ev.agentSource === "session" ||
        ev.agentSource === "plan")
          ? ev.agentSource
          : null
      const buildLine = (fd: number) =>
        JSON.stringify({
          ts: new Date().toISOString(),
          seq: nextEventSeqFromFd(fd),
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
          // Only run_created carries the spec-presence-gate decision. Every line now also
          // carries seq (and agentSource when an actor exists); legacy lines on
          // disk keep their old shape and remain valid.
          ...(ev.specGate
            ? { specGate: clean(ev.specGate, 16), ...(ev.specPath ? { specPath: clean(ev.specPath, 200) } : {}) }
            : {}),
          // run_created approval summary (0.11.0). The event is a record of
          // what the gate accepted; it is not itself a signature.
          ...(ev.approvalDigest ? { approvalDigest: clean(ev.approvalDigest, 64) } : {}),
          ...(ev.approvalKeyId ? { approvalKeyId: clean(ev.approvalKeyId, 128) } : {}),
          ...(ev.approvedBy ? { approvedBy: clean(ev.approvedBy, 200) } : {}),
          ...(ev.promptDraftSha256 ? { promptDraftSha256: clean(ev.promptDraftSha256, 64) } : {}),
          ...(ev.binding ? { binding: clean(ev.binding, 16) } : {}),
        }) + "\n"
      appendLineWithin(run, "events.jsonl", buildLine)
    })
  } catch {
    // fail-open: an events.jsonl write failure must never alter tool results
  }
}

// Best-effort audit trail for a refused write anomaly (ADR 0010). The shared
// safe-fs ring is always updated; this sink also appends a bounded event to the
// run that produced it. It is intentionally reentrancy-guarded and swallows all
// errors: a diagnostic must never turn a write failure into a crash loop.
let writeAnomalySinkBusy = false
onWriteAnomaly((anomaly: any) => {
  if (writeAnomalySinkBusy) return
  const run = typeof anomaly?.run === "string" ? anomaly.run : ""
  if (!run) return
  // Policy and lock anomalies go to stderr and the config-dir audit (already
  // written by safe-fs). Appending them to events.jsonl would be a write the
  // policy itself refuses, so that path is skipped explicitly.
  if (anomaly?.kind === "containment-mode" || anomaly?.kind === "detective-lock") return
  writeAnomalySinkBusy = true
  try {
    const kind = clean(anomaly.kind, 32)
    const name = clean(anomaly.name, 64)
    const detail = clean(anomaly.detail, 200)
    appendLineWithin(run, "events.jsonl", (fd: number) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        seq: nextEventSeqFromFd(fd),
        event: "write_anomaly",
        sessionId: clean(basename(run), 64),
        taskId: null,
        from: null,
        to: kind || "refused",
        round: 0,
        agent: null,
        note: detail || name || null,
      }) + "\n",
    )
  } catch {
    // best effort only
  } finally {
    writeAnomalySinkBusy = false
  }
})

// Serialise read-modify-write of a run's cost files within this process, so
// concurrent agents (parallel workers calling teamwork_cost at once) cannot
// clobber each other's attribution. The lock primitive lives in locks.ts so the
// handoff index uses the same one.

/**
 * Session→run resolution for the context hook.
 *
 * `teamwork_plan` records `run-by-root/<root session id>` in ctx.storage. A
 * child agent session resolves its `parentID` chain to that root, then reads the
 * mapping, so a fresh worker sees the run it actually belongs to instead of
 * whichever run happens to be newest on disk. Every step is fail-open: an
 * unavailable storage API, unknown session, or missing mapping returns
 * undefined and the caller keeps the legacy newest-run behaviour.
 */
const RUN_BY_ROOT_PREFIX = "run-by-root/"
const ROOT_CHAIN_MAX_DEPTH = 32

function sessionKey(value: unknown): string {
  return String(value ?? "").replace(/[^0-9A-Za-z._:-]/g, "").slice(0, 80)
}

async function rememberRunForRoot(ctx: any, rootSessionId: string, runId: string): Promise<void> {
  if (!rootSessionId || !validSessionId(runId)) return
  const key = sessionKey(rootSessionId)
  if (!key) return
  try {
    if (typeof ctx?.storage?.set === "function") {
      await ctx.storage.set(`${RUN_BY_ROOT_PREFIX}${key}`, runId)
    }
  } catch {}
}

async function rootSessionOf(ctx: any, sessionID: string | undefined): Promise<string | undefined> {
  if (!sessionID || typeof ctx?.session?.get !== "function") return undefined
  let current = sessionID
  for (let depth = 0; depth < ROOT_CHAIN_MAX_DEPTH; depth++) {
    let info: any
    try {
      info = await withTimeout(Promise.resolve(ctx.session.get({ sessionID: current })), 2000)
    } catch {
      return undefined
    }
    if (!info) return undefined
    const parent = info.parentID ?? info.parentId ?? info.parent_id
    if (typeof parent !== "string" || parent.trim() === "") return current
    current = parent
  }
  return undefined
}

/** Resolve the run this caller belongs to through its root-session mapping. */
async function runForSession(ctx: any, root: string, sessionID: string | undefined): Promise<string | undefined> {
  const rootSessionId = await rootSessionOf(ctx, sessionID)
  if (!rootSessionId) return undefined
  let mapped: unknown
  try {
    if (typeof ctx?.storage?.get !== "function") return undefined
    mapped = await ctx.storage.get(`${RUN_BY_ROOT_PREFIX}${sessionKey(rootSessionId)}`)
  } catch {
    return undefined
  }
  if (!validSessionId(mapped)) return undefined
  const mappedRun = join(runsDir(root), mapped)
  if (!existsSync(mappedRun)) return undefined
  const resolved = resolveRun(root, mapped)
  return resolved.error ? undefined : resolved.run
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

export function describeRun(
  root: string,
  opts: { sessionID?: string; agent?: string; runId?: string } = {},
): string | undefined {
  const { run } = resolveRun(root, opts.runId)
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
    ...describeBriefingLines(run, opts.sessionID, opts.agent),
    `State: ${join(runsDir(root), id, "state.json")} (read it before dispatching).`,
  ].join("\n")
}

function describeCostLine(run: string): string {
  const costs = readJson<any>(run, join(run, "costs.json"), undefined)
  if (!costs || typeof costs.budgetUsd !== "number") return "Cost: unknown."
  const budget = costs.budgetUsd
  const spent = Number(costs.spentUsd) || 0
  const pct = budgetPercent(spent, budget)
  return `Cost: $${spent} of $${budget} (${pct}%)${pct >= BUDGET_HALT_PCT ? " — advisory budget threshold reached; halt non-essential workers (enforced only by massive-proof tournaments)" : ""}.`
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

function describeBriefingLines(run: string, sessionID?: string, agent?: string): string[] {
  // Prefer the caller's per-agent briefing when its identity is known; fall
  // back to the shared briefing exactly as before (legacy runs included).
  const agentBriefing = sessionID && agent ? readAgentBriefingExcerpt(run, agent, sessionID) : undefined
  if (agentBriefing) {
    const header = agentBriefing.truncated
      ? `[teamwork] agent briefing (${agentBriefing.path}) — first 4096 of ${agentBriefing.bytes} bytes:`
      : `[teamwork] agent briefing (${agentBriefing.path}):`
    const lines = [header, agentBriefing.text]
    if (agentBriefing.truncated) {
      lines.push(`[teamwork] agent briefing excerpt truncated at 4096 bytes; read ${agentBriefing.path} for the rest.`)
    }
    return lines
  }
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

/**
 * Record `<run>/interrupted.md` for a mid-run abort. Best-effort: the caller
 * still returns CANCELLED. `writeTextSafe` refuses a symlinked or non-regular
 * target, so a planted link is never followed and the write failure is swallowed.
 */
function writeInterruptedSafe(run: string, phase: unknown, reason: string): void {
  try {
    const phaseText = clean(phase, 64) || "UNKNOWN"
    const body = `# Interrupted\n\n- Session: ${basename(run)}\n- Phase: ${phaseText}\n- At: ${new Date().toISOString()}\n- Reason: ${clean(reason, 200)}\n`
    writeTextSafe(run, join(run, "interrupted.md"), body)
  } catch {}
}

/**
 * Write `PREREQUISITES.md` at the project root (never inside a run). The
 * pinned writer creates through a directory fd with `O_NOFOLLOW`, so a planted
 * `PREREQUISITES.md` symlink is replaced/refused rather than followed, and a
 * write failure (read-only root, hostile path) never fails the refusal itself.
 */
function writePrerequisitesSafe(root: string, body: string): boolean {
  try {
    const target = join(root, "PREREQUISITES.md")
    // A7: refuse to replace a planted symlink. The pinned atomic writer would
    // never follow the link, but silently replacing it hides the operator's
    // signal and makes "symlinked PREREQUISITES.md is refused" false. A TOCTOU
    // race after this check can still only reach the safe rename.
    try {
      if (lstatSync(target).isSymbolicLink()) return false
    } catch {}
    writeFileAtomicWithin(root, "PREREQUISITES.md", body)
    return true
  } catch {
    return false
  }
}

/** Shared preflight body: explicit status, blocker, required items and hints. */
function prerequisitesBody(
  status: "MISSING" | "OUTAGE",
  title: string,
  required: string[],
  hints: string[],
  detail?: string,
): string {
  const lines = [
    "# Prerequisites",
    "",
    `- Status: ${status}`,
    `- Checked: ${new Date().toISOString()}`,
    `- Blocker: ${clean(title, 200)}`,
    ...(detail ? [`- Detail: ${cleanBlock(detail, 1000).trim()}`] : []),
    "",
    "## Required",
    "",
    ...(required.length ? required.map((r) => `- ${r}`) : ["- (none recorded)"]),
    "",
    "## Install hints",
    "",
    ...(hints.length ? hints.map((h) => `- ${h}`) : ["- (none recorded)"]),
    "",
    "Fix the prerequisites above, then re-run the same command. No run directory was created.",
  ]
  return lines.join("\n") + "\n"
}

/** PDF extraction prerequisites (A7). */
function pdfPrerequisitesBody(status: "MISSING" | "OUTAGE", detail: string): string {
  return prerequisitesBody(
    status,
    "PDF text extraction requires the Python `pypdfium2` and `Pillow` packages (with python3 on PATH)",
    ["`pypdfium2` (PDF page renderer used for image-only PDFs)", "`Pillow` (Python imaging library required by pypdfium2)"],
    [
      "`python3 -m pip install --user pypdfium2 Pillow`",
      "or install them inside the interpreter that provides `python3` (virtualenv, pipx inject, distro package)",
      "verify with `python3 -c \"import pypdfium2, PIL; print('ok')\"`",
    ],
    detail,
  )
}

/** LEMMA / Lean 4 toolchain prerequisites (A7). */
function lemmaPrerequisitesBody(probe: LemmaProbeResult): string {
  const doctor = probe.leap.doctor
  const doctorLine = doctor
    ? `leap doctor: ${doctor.status}${doctor.failedChecks?.length ? ` [failed: ${doctor.failedChecks.slice(0, 8).join(", ")}]` : ""}${doctor.warning ? ` — warning: ${clean(doctor.warning, 240)}` : ""}${doctor.error ? ` (${clean(doctor.error, 180)})` : ""}${doctor.output ? ` — ${cleanBlock(doctor.output, 400).trim().replace(/\s+/g, " ")}` : ""}`
    : ""
  return prerequisitesBody(
    probe.status,
    "LEMMA route requires Lean 4 (`lean`, `lake`) and a healthy LEAP CLI (`leap` or legacy `leap-tools`)",
    [
      `lean: ${probe.lean.available ? "READY" : `${probe.lean.status}${probe.lean.error ? ` (${probe.lean.error})` : ""}`}`,
      `lake: ${probe.lake.available ? "READY" : `${probe.lake.status}${probe.lake.error ? ` (${probe.lake.error})` : ""}`}`,
      `${LEAP_REQUIREMENT}: ${probe.leap.available ? "READY" : `${probe.leap.status}${probe.leap.error ? ` (${probe.leap.error})` : ""}`}`,
      ...(doctor ? [doctorLine] : []),
    ],
    probe.installInstructions.split("\n"),
    `probe status: ${probe.status}; missing/unusable: ${probe.missing.join(", ")}`,
  )
}

/**
 * A5 survey stubs. `distributed-coding` starts with the planning survey
 * artifacts as create-only placeholders: the Sentinel's 2-Scout Survey fills
 * them in later. `TEST_READY.md` is deliberately NOT created — it is the
 * Dual-Track E2E gate and must be produced by the team, not pre-seeded.
 */
function surveyStubBodies(tasks: Array<{ id?: unknown; agent?: unknown }>): Array<{ name: string; body: string }> {
  const cell = (v: unknown, max = 64) => clean(v, max).replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
  const inventory = tasks.length
    ? tasks.map((t) => `| ${cell(t.id)} | ${cell(t.agent || "team/worker")} | pending |`)
    : ["| (none) | team/worker | pending |"]
  const milestoneRows = tasks.length
    ? tasks.map((t, i) => `| ${i + 1} | ${cell(t.id)} | ${cell(t.agent || "team/worker")} | pending |`)
    : ["| 1 | (none) | team/worker | pending |"]
  const project = [
    "# Project",
    "",
    "## Architecture",
    "",
    "Planning survey stub: the Sentinel's 2-Scout Survey records the verified architecture here before the first milestone.",
    "",
    "## Code Layout",
    "",
    "Planning survey stub: record the repository layout (entry points, modules, test dirs) discovered by the survey.",
    "",
    "## Feature Inventory",
    "",
    "| Task | Agent | Status |",
    "| --- | --- | --- |",
    ...inventory,
    "",
    "## Milestones",
    "",
    "| Milestone | Task | Agent | Status |",
    "| --- | --- | --- | --- |",
    ...milestoneRows,
    "",
  ].join("\n")
  const scope = [
    "# Scope",
    "",
    "## Milestones",
    "",
    "| Task | Agent | Status |",
    "| --- | --- | --- |",
    ...inventory,
    "",
    "## Out of Scope",
    "",
    "- Anything not traced to a requirement in `requirements.json`.",
    "- Unrelated refactors, dependency upgrades, and formatting-only churn.",
    "",
  ].join("\n")
  const infra = [
    "# E2E Test Infra",
    "",
    "## Test Philosophy",
    "",
    "Tests are evidence, not assertions from the implementer. Every milestone cites a re-runnable command and its observed output.",
    "",
    "## Feature Inventory",
    "",
    "| Task | Agent | Status |",
    "| --- | --- | --- |",
    ...inventory,
    "",
    "## Test Architecture",
    "",
    "Dual-Track E2E testing: author the test intent and expectations up front (`TEST_INFRA.md`), then require the executed build to satisfy them (`TEST_READY.md`).",
    "",
    "1. Tier 1 — unit / pure function checks.",
    "2. Tier 2 — module and contract integration checks.",
    "3. Tier 3 — cross-component workflow checks.",
    "4. Tier 4 — full end-to-end scenario checks against the delivered artifact.",
    "",
    "## Coverage Thresholds",
    "",
    "- New behaviour needs at least one Tier 1 check plus the narrowest integration tier that exercises it.",
    "- Every requirement needs a Tier 3 or Tier 4 command that a fresh verifier can re-run.",
    "- A milestone is not complete until `TEST_READY.md` records the executed commands and their observed results.",
    "",
  ].join("\n")
  return [
    { name: "PROJECT.md", body: project },
    { name: "SCOPE.md", body: scope },
    { name: "TEST_INFRA.md", body: infra },
  ]
}

/** Create the A5 survey stubs create-only; a planted symlink is never followed. */
function writeSurveyStubsSafe(run: string, tasks: Array<{ id?: unknown; agent?: unknown }>): void {
  for (const stub of surveyStubBodies(tasks)) {
    try {
      touchWithin(run, stub.name, stub.body)
    } catch {}
  }
}

/**
 * A5 failure-signature canonicalisation. Whitespace, line endings and case do
 * not distinguish two failures; the report summary, the fatal findings and the
 * worker feedback do. The round number is deliberately excluded, so the same
 * failure reproduced in round 2 hashes identically to round 1.
 */
function normalizeFailureSignatureText(value: unknown): string {
  return cleanBlock(value, 4000).replace(/\s+/g, " ").trim().toLowerCase()
}

function failureSignatureOf(args: { report?: any; summary?: unknown; feedback?: unknown }): {
  signature: string
  summary: string
  findingsText: string
  feedbackText: string
} {
  const report = args.report && typeof args.report === "object" ? args.report : undefined
  const fatalFindings = Array.isArray(report?.fatalFindings)
    ? report.fatalFindings.slice(0, 50).map((f: any) => ({
        where: normalizeFailureSignatureText(f?.where),
        why: normalizeFailureSignatureText(f?.why),
        fix: normalizeFailureSignatureText(f?.fix),
      }))
    : []
  const summary = normalizeFailureSignatureText(report?.summary ?? args.summary ?? args.feedback ?? "")
  const feedbackForWorker = normalizeFailureSignatureText(report?.feedbackForWorker ?? args.feedback ?? "")
  const signature = sha256Hex(canonicalJson({ summary, fatalFindings, feedbackForWorker }))
  const findingsText = fatalFindings
    .map((f: any) => [f.where, f.why, f.fix].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("\n")
  return { signature, summary, findingsText, feedbackText: feedbackForWorker }
}

/**
 * A5 Oscillation/Regression Guard. Appends one section per distinct failure
 * signature; a repeated call with the same signature is a no-op. Best-effort:
 * a symlinked/read-only `DEAD_ENDS.md` must never fail the task transition.
 */
function writeDeadEndsSafe(run: string, entry: {
  taskId: string
  round: number
  signature: string
  count: number
  feedback: string
  summary: string
  findings: string
}): void {
  try {
    const marker = `signature: ${entry.signature}`
    const deadEndsFile = join(run, "DEAD_ENDS.md")
    const existingRes = readBoundedRunFile(run, deadEndsFile, MAX_RUN_FILE_BYTES)
    const existing = existingRes.status === "ok" ? existingRes.text : ""
    if (existing.includes(marker)) return
    const observed = [entry.feedback, entry.summary && entry.summary !== entry.feedback ? entry.summary : "", entry.findings]
      .filter(Boolean)
      .join("\n")
    const section = [
      `## ${entry.taskId} — Oscillation Guard`,
      "",
      `- Task: ${clean(entry.taskId, 64)}`,
      `- Round: ${entry.round}`,
      `- Identical failures: ${entry.count}`,
      `- At: ${new Date().toISOString()}`,
      `- ${marker}`,
      "",
      "### Regression Guard",
      "",
      "The previous approach reproduced the same failure. Record the checks that already pass and re-run them before claiming a fix; a fix must not regress an earlier passing check.",
      "",
      "### Observed failure",
      "",
      "```text",
      observed || "(no verifier feedback was recorded)",
      "```",
      "",
      "### Change approach",
      "",
      "Stop retrying the same edit. Reproduce the failure deterministically (minimal test or log), identify the root cause, and change the implementation strategy or ask the Sentinel for a new decomposition before spending another round.",
      "",
    ].join("\n")
    const body = existing.trim()
      ? `${existing.trimEnd()}\n\n${section}`
      : `# Dead Ends\n\nFailures that repeated identically are recorded here so the team changes approach instead of oscillating.\n\n${section}`
    writeTextSafe(run, deadEndsFile, body)
  } catch {}
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
  assertRunRootIdentity(run)
  // Keep the path-level policy/error text, then write with pinned-fd
  // containment. No path-based mkdir/create/rename remains on this writer; an
  // intermediate directory swap cannot redirect it.
  ensureSafeRunSubpath(run, targetFile)
  writeFileAtomicWithin(run, runRel(run, targetFile), content)
}

function writeJsonSafe(run: string, targetFile: string, value: unknown) {
  writeJson(run, targetFile, value)
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
/**
 * 0.10.2 bumped the signed manifest to version 2: approvals must come from an
 * external approval directory with a distinct Ed25519 approver key. Version 1
 * manifests stay readable; their in-run approval path is honoured only for
 * those pre-0.10.2 runs and is recorded as `approval_unbound`.
 *
 * 0.11.0 bumps to version 3: an approval is bound to the exact bytes of
 * `prompt_draft.md` (not only to the manifest), and the manifest records the
 * approval digest/nonce/approver so a re-plan or a later edit is `AUTH_STALE`.
 * Version 2 stays readable and keeps its manifestDigest-bound approval
 * semantics.
 *
 * 0.16.0 bumps to version 4: the manifest records `requiredProvenance`
 * (`declared` | `command`). Versions 1–3 keep their meaning (declared).
 *
 * 0.18.0 bumps to version 5: the manifest records `attestationPolicy`
 * (`off` | `optional` | `required`), `attestationKeyId` and
 * `attestationIssuer` for a signed CI attestation. Versions 1–4 keep their
 * meaning (`off`).
 */
const RUN_MANIFEST_VERSION = 5
const SUPPORTED_RUN_MANIFEST_VERSIONS = [1, 2, 3, 4, 5] as const
type RunManifestVersion = (typeof SUPPORTED_RUN_MANIFEST_VERSIONS)[number]
/** First manifest version that can require re-executable command evidence. */
const COMMAND_PROVENANCE_MIN_VERSION = 4
/** First manifest version that records the CI attestation policy. */
const ATTESTATION_MIN_VERSION = 5
const PROVENANCE_MODES = ["declared", "command"] as const
type ProvenanceMode = (typeof PROVENANCE_MODES)[number]

type AttestationPolicyMode = "off" | "optional" | "required"

function normalizeProvenance(value: unknown): ProvenanceMode | undefined {
  return value === "declared" || value === "command" ? value : undefined
}

function normalizeAttestationMode(value: unknown): AttestationPolicyMode | undefined {
  return normalizeAttestationPolicy(value) as AttestationPolicyMode | undefined
}

/** Manifest attestation policy, typed for the engine. */
function manifestAttestationMode(manifest: RunManifest | undefined): AttestationPolicyMode {
  return manifestAttestationPolicy(manifest) as AttestationPolicyMode
}

/** Manifest authority for re-execution: version < 4 is always `declared`. */
function manifestProvenance(manifest: RunManifest | undefined): ProvenanceMode {
  if (!manifest || Number(manifest.version) < COMMAND_PROVENANCE_MIN_VERSION) return "declared"
  return manifest.requiredProvenance === "command" ? "command" : "declared"
}
/** First manifest version that requires the external approval directory. */
const APPROVAL_EXTERNAL_MIN_VERSION = 2
/** First manifest version that binds the approval to `prompt_draft.md`. */
const APPROVAL_PROMPT_MIN_VERSION = 3

type ApprovalPolicy = "external-dir" | "in-run-legacy" | "none"

type RunManifest = {
  version: RunManifestVersion
  sessionId: string
  rootSessionId: string
  /**
   * Plan-time caller agent. `context.agent` is the current tool-call identity
   * (preferred); `Session.Info.agent` is only a fallback. Absent on legacy
   * manifests and when no identity could be resolved.
   */
  planAgent?: string | null
  integrityMode: IntegrityMode
  verification: VerificationMode
  victoryAudit: VictoryAuditMode
  victorySkipReason?: string
  requireHandoffs: HandoffMode
  /**
   * Handoff-index provenance baseline. Absent on a 0.8.0 manifest = `legacy`
   * (unsigned entries tolerated). New signed plans write `signed`.
   */
  handoffAuth?: "signed" | "legacy"
  requestHash: string | null
  requirementsHash: string | null
  planHash: string
  lemmaPolicyHash: string | null
  runKeyId: string
  /** Ed25519/HMAC key id pinned at plan time (same as runKeyId when present). */
  runNonce?: string
  trustLevel?: TrustLevel
  requireWitness?: boolean
  /** Expected verify-only Ed25519 key id for human/CI approvals (0.10.2). */
  approvalKeyId?: string | null
  /** Approval policy pinned at plan time: external-dir, in-run-legacy, or none. */
  approvalPolicy?: ApprovalPolicy
  /** Version 3+: SHA-256 of the exact `prompt_draft.md` bytes. */
  specHash?: string | null
  /** Version 3+: byte length of `prompt_draft.md`. */
  specBytes?: number | null
  /** Version 3+: digest of the approval artifact payload (without `_auth`). */
  approvalDigest?: string | null
  /** Version 3+: one-use nonce, equal to the approval envelope's nonce. */
  approvalNonce?: string | null
  /** Version 3+: the approval binds the prompt draft, not only the manifest. */
  approvalBinding?: "prompt"
  /** Version 3+: the claimed approver identity (`approvedBy`/`attestedBy`). */
  approvedBy?: string | null
  /** Version 3+: ISO timestamp from the approval artifact. */
  approvedAt?: string | null
  /**
   * Version 4+: whether a PASS must carry re-executable command evidence.
   * Absent = `declared` (the 0.15 meaning). A re-plan may upgrade to `command`
   * but never downgrade it.
   */
  requiredProvenance?: ProvenanceMode
  /**
   * Version 5+: CI attestation requirement. Absent = `off` for versions 1–4.
   * A re-plan may upgrade off→optional→required but never downgrade.
   */
  attestationPolicy?: AttestationPolicyMode
  /** Version 5+: expected `_auth.keyId` of the CI attestation. */
  attestationKeyId?: string | null
  /** Version 5+: expected `oidc.issuer` of the CI attestation. */
  attestationIssuer?: string | null
  /**
   * ADR 0013: the run root `(dev, ino)` at plan time. Additive and optional;
   * a later control-plane write refuses when the root no longer matches.
   */
  runRootIdentity?: { dev: number; ino: number }
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
      // Omitted for legacy plans so their pre-victory-reason planHash stays valid.
      ...(typeof plan?.victorySkipReason === "string" && plan.victorySkipReason !== ""
        ? { victorySkipReason: plan.victorySkipReason }
        : {}),
      // Omitted for legacy plans so their pre-continuity planHash stays valid.
      ...(plan?.requireHandoffs !== undefined && plan?.requireHandoffsSource !== "legacy"
        ? { requireHandoffs: plan.requireHandoffs }
        : {}),
      route: plan?.route ?? null,
      lemmaBounds: plan?.lemmaBounds ?? null,
      ...(plan?.requireSameHost === true ? { requireSameHost: true } : {}),
      // 0.18.0: bind the CI attestation policy to the plan baseline when it is
      // asserted. `off` is omitted so a legacy plan hash is unchanged.
      ...(plan?.attestationPolicy && plan.attestationPolicy !== "off"
        ? {
            attestationPolicy: plan.attestationPolicy,
            ...(typeof plan.attestationKeyId === "string" && plan.attestationKeyId !== ""
              ? { attestationKeyId: plan.attestationKeyId }
              : {}),
            ...(typeof plan.attestationIssuer === "string" && plan.attestationIssuer !== ""
              ? { attestationIssuer: plan.attestationIssuer }
              : {}),
          }
        : {}),
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
 * Control-plane artifacts that only a signed run writes. If the manifest is
 * missing but one of these still carries an `_auth` envelope, the run was
 * signed and the baseline was deleted: that is a downgrade, never a legacy run.
 */
const SIGNED_CONTROL_ARTIFACT_PATHS = [
  "verify/final.json",
  "verify/security-audit.json",
  "verify/victory.json",
  "verify/rerun.json",
  "verify/ci/attestation.json",
  "document-review/manifest.json",
  "lemma/manifest.json",
  "tournament/manifest.json",
] as const
/** Per-task signed artifacts (`report-*`, strict `challenge-*` / `audit-*`). */
const SIGNED_VERIFY_ARTIFACT_NAME = /^(?:report|challenge|audit)-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/
const SIGNED_CONTROL_ARTIFACT_SCAN_MAX = 512

/** True when a parsed control artifact carries a signed `_auth` envelope. */
function carriesAuthEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, any>
  return record._auth !== undefined && record._auth !== null
}

/** Bounded list of control artifacts whose `_auth` marker proves a signed run. */
function signedControlArtifactPaths(run: string): string[] {
  const paths = new Set<string>(SIGNED_CONTROL_ARTIFACT_PATHS)
  let names: string[] = []
  try {
    names = readdirSync(join(run, "verify")).slice(0, SIGNED_CONTROL_ARTIFACT_SCAN_MAX)
  } catch {}
  for (const name of names) {
    if (SIGNED_VERIFY_ARTIFACT_NAME.test(name)) paths.add(`verify/${name}`)
  }
  return [...paths]
}

/**
 * Classify a run that has no `run.manifest.json`. A run whose signed-run state
 * survives in `ctx.storage` (the pinned nonce/key id) or in a signed control
 * artifact is a signed run with its baseline removed: `allowUnsignedLegacy`
 * must not be able to downgrade it into an unsigned legacy run. Only a run with
 * no such evidence is a genuine pre-authenticity legacy run.
 */
async function signedRunWithoutManifest(
  run: string,
  auth?: AuthContext,
): Promise<{ code: "AUTH_LEGACY" | "AUTH_INVALID"; reason: string } | undefined> {
  if (auth) {
    const runId = basename(run)
    let nonce: string | undefined
    let keyId: string | undefined
    try {
      nonce = await auth.runNonce(runId)
    } catch {}
    try {
      keyId = nonce ? undefined : await auth.runKeyId(runId)
    } catch {}
    if (nonce) return { code: "AUTH_LEGACY", reason: "ctx.storage records the signed run nonce" }
    if (keyId) return { code: "AUTH_LEGACY", reason: `ctx.storage records the signed run key id ${clean(keyId, 96)}` }
  }
  for (const relPath of signedControlArtifactPaths(run)) {
    const res = readRegularJson<any>(run, join(run, relPath))
    if (!res.ok) continue
    if (carriesAuthEnvelope(res.data)) {
      return { code: "AUTH_INVALID", reason: `${relPath} carries a signed _auth envelope` }
    }
  }
  return undefined
}

/**
 * Read and verify `run.manifest.json`. A present-but-unsigned manifest is an
 * AUTH_INVALID failure (never a legacy run), and a missing index entry fails
 * closed rather than adopting the artifact.
 *
 * A missing manifest is only a legacy run when no signed-run state exists. The
 * path is inspected with `lstat` (only ENOENT is absent), so a deleted or
 * dangling-symlink manifest cannot be reported as "legacy": a symlink and a
 * file that vanishes between inspection and read fail AUTH_INVALID.
 */
async function readRunManifest(run: string, auth?: AuthContext): Promise<ManifestCheck> {
  const manifestFile = runManifestFile(run)
  let manifestStat
  try {
    manifestStat = lstatSync(manifestFile)
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      return {
        ok: false,
        failure: {
          code: "AUTH_INVALID",
          message: `run.manifest.json cannot be inspected (${clean(err?.code ?? err?.message, 40)})`,
        },
      }
    }
    const signed = await signedRunWithoutManifest(run, auth)
    if (signed) {
      return {
        ok: false,
        failure: {
          code: signed.code,
          message: `run.manifest.json is missing but ${signed.reason}; the signed baseline was removed, so this run cannot be treated as unsigned legacy`,
        },
      }
    }
    return { ok: true, signed: false }
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    return {
      ok: false,
      failure: {
        code: "AUTH_INVALID",
        message: "run.manifest.json is a symlink or not a regular file",
      },
    }
  }
  const res = readRegularJson<any>(run, manifestFile)
  if (!res.ok) {
    // The lstat above already established a regular file, so a "missing" here
    // is a deletion race: fail closed instead of falling back to legacy.
    return {
      ok: false,
      failure: {
        code: "AUTH_INVALID",
        message:
          res.reason === "missing"
            ? "run.manifest.json disappeared between inspection and read"
            : `run.manifest.json is ${res.reason === "symlink" ? "a symlink" : "unreadable or malformed"}`,
      },
    }
  }
  const value = res.data
  if (
    !value ||
    typeof value !== "object" ||
    !(SUPPORTED_RUN_MANIFEST_VERSIONS as readonly unknown[]).includes(value.version)
  ) {
    return { ok: false, failure: { code: "AUTH_INVALID", message: "run.manifest.json has an invalid schema version" } }
  }
  if (!auth) {
    return { ok: false, failure: { code: "AUTH_UNAVAILABLE", message: "no authenticity context is wired for this run" } }
  }
  const check = await auth.verifyRunArtifact(basename(run), RUN_MANIFEST, value, {
    ...(typeof value.runNonce === "string" && value.runNonce !== "" ? { requireNonce: value.runNonce } : {}),
    ...(typeof value.runKeyId === "string" && value.runKeyId !== "" ? { expectedKeyId: value.runKeyId } : {}),
  })
  if (check.status === "unsigned") {
    return { ok: false, failure: { code: "AUTH_INVALID", message: "run.manifest.json has no _auth envelope" } }
  }
  if (check.status !== "signed") {
    return {
      ok: false,
      failure: check.failure ?? { code: "AUTH_INVALID", message: "run.manifest.json failed verification" },
    }
  }
  // Re-bind the signed baseline so a fresh process (or a cleared cache) uses the
  // manifest's nonce/key id for every subsequent artifact.
  if (typeof value.runNonce === "string" && value.runNonce !== "") {
    const bound = await auth.bindRunNonce(basename(run), value.runNonce)
    if (!bound.ok) return { ok: false, failure: bound.failure }
  }
  if (typeof value.runKeyId === "string" && value.runKeyId !== "") {
    const bound = await auth.bindRunKeyId(basename(run), value.runKeyId)
    if (!bound.ok) return { ok: false, failure: bound.failure }
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
  if (drift.startsWith("victorySkipReason")) {
    return `[AUTH_STALE] victory skip reason changed by a re-plan (${drift})`
  }
  if (drift.startsWith("requireHandoffs")) {
    return `[AUTH_STALE] handoff gate downgrade/change refused (${drift})`
  }
  if (drift.startsWith("attestationPolicy")) {
    return `[AUTH_STALE] CI attestation policy downgrade/change refused (${drift})`
  }
  if (drift.startsWith("attestationKeyId") || drift.startsWith("attestationIssuer")) {
    return `[AUTH_STALE] CI attestation identity change refused (${drift})`
  }
  if (drift.startsWith("requiredProvenance")) {
    return `[AUTH_STALE] re-execution requirement downgrade/change refused (${drift})`
  }
  if (drift.startsWith("trustLevel")) {
    return `[AUTH_STALE] artifact trust level downgrade/change refused (${drift})`
  }
  if (drift.startsWith("requireWitness")) {
    return `[AUTH_STALE] witness requirement downgrade/change refused (${drift})`
  }
  if (drift.startsWith("approvalKeyId")) {
    return `[AUTH_STALE] approval approver key change refused (${drift})`
  }
  if (drift.startsWith("approvalPolicy")) {
    return `[AUTH_STALE] approval policy change refused (${drift})`
  }
  if (drift.startsWith("specHash") || drift.startsWith("specBytes")) {
    return `[AUTH_STALE] the approved prompt_draft.md text changed since the plan (${drift})`
  }
  if (
    drift.startsWith("approvalDigest") ||
    drift.startsWith("approvalNonce") ||
    drift.startsWith("approvalBinding") ||
    drift.startsWith("approvedBy") ||
    drift.startsWith("approvedAt")
  ) {
    return `[AUTH_STALE] the approval binding changed since the plan (${drift})`
  }
  if (drift.startsWith("planHash")) {
    return `[AUTH_STALE] plan baseline changed (${drift})`
  }
  if (drift.startsWith("lemmaPolicyHash")) {
    return `[AUTH_STALE] LEMMA policy baseline changed (${drift})`
  }
  return `[AUTH_STALE] ${drift}`
}

/**
 * Route evidence authenticity codes. `lemma.ts`, `tournament.ts` and
 * `document-review.ts` still write their evidence as plain JSON/plain text
 * without an `_auth` envelope. A signed run must not treat that evidence as a
 * verified PASS: a run-directory writer could forge a proof, a tournament
 * verdict, or a document-review report and final_verify would otherwise sign
 * `verify/final.json` as PASS. This guard is deliberately fail-closed until
 * those writers sign their artifacts. An explicitly unsigned legacy run keeps
 * the historical behavior (and records the allowUnsignedLegacy bypass); it is
 * never upgraded into a signed PASS. The check never invents an envelope.
 */
type RouteEvidenceAuthCode =
  | "LEMMA_EVIDENCE_UNSIGNED"
  | "TOURNAMENT_EVIDENCE_UNSIGNED"
  | "DOCUMENT_REVIEW_EVIDENCE_UNSIGNED"

async function routeEvidenceAuthReason(
  auth: AuthContext | undefined,
  runId: string,
  relPath: string,
  payload: unknown,
  code: RouteEvidenceAuthCode,
): Promise<string | null> {
  if (!auth) {
    return `[${code}] ${relPath}: no authenticity context is wired for this run, so the evidence cannot be verified`
  }
  try {
    const check = await auth.verifyRunArtifact(runId, relPath, payload)
    if (check.status === "signed") return null
    if (check.status === "unsigned") {
      return `[${code}] ${relPath} has no _auth envelope; a signed run requires authenticated route evidence`
    }
    const failure = check.failure ?? { code: "AUTH_INVALID" as const, message: "route evidence failed verification" }
    return `[${code}] ${relPath}: ${failure.code} ${failure.message}`
  } catch (err: any) {
    return `[${code}] ${relPath}: authenticity check failed (${clean(err?.message, 160)})`
  }
}

/** Plain-text route evidence cannot carry an `_auth` envelope: fail closed. */
function routeTextEvidenceAuthReason(code: RouteEvidenceAuthCode, relPath: string): string {
  return `[${code}] ${relPath} is a plain-text report written without an _auth envelope; a signed run requires authenticated route evidence`
}

function manifestDrift(
  manifest: RunManifest,
  current: Omit<RunManifest, "version" | "sessionId" | "rootSessionId" | "runKeyId" | "createdAt" | "_auth">,
): string[] {
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
  const baselineSkipReason = recordedVictorySkipReason(manifest.victorySkipReason) ?? ""
  const currentSkipReason = recordedVictorySkipReason(current.victorySkipReason) ?? ""
  if (baselineSkipReason !== currentSkipReason) {
    drift.push(
      `victorySkipReason drifted: manifest=${baselineSkipReason || "none"} current=${currentSkipReason || "none"}`,
    )
  }
  const baselineHandoffs = normalizeHandoffMode(manifest.requireHandoffs) ?? "skip"
  if (baselineHandoffs !== current.requireHandoffs) {
    drift.push(`requireHandoffs drifted: manifest=${baselineHandoffs} current=${current.requireHandoffs}`)
  }
  const baselineTrust = normalizeTrustLevel(manifest.trustLevel) ?? DEFAULT_TRUST_LEVEL
  const currentTrust = normalizeTrustLevel(current.trustLevel) ?? DEFAULT_TRUST_LEVEL
  if (baselineTrust !== currentTrust) {
    drift.push(`trustLevel drifted: manifest=${baselineTrust} current=${currentTrust}`)
  }
  const baselineWitness = manifest.requireWitness === true
  const currentWitness = current.requireWitness === true
  if (baselineWitness !== currentWitness) {
    drift.push(`requireWitness drifted: manifest=${baselineWitness} current=${currentWitness}`)
  }
  const baselineApprovalPolicy = normalizeApprovalPolicy(manifest.approvalPolicy, manifest.version)
  const currentApprovalPolicy = normalizeApprovalPolicy(current.approvalPolicy, manifest.version)
  if (baselineApprovalPolicy !== currentApprovalPolicy) {
    drift.push(`approvalPolicy drifted: manifest=${baselineApprovalPolicy} current=${currentApprovalPolicy}`)
  }
  const baselineApprovalKey = manifest.approvalKeyId ?? null
  const currentApprovalKey = current.approvalKeyId ?? null
  if (baselineApprovalKey !== currentApprovalKey) {
    drift.push(`approvalKeyId drifted (manifest=${baselineApprovalKey ?? "null"} current=${currentApprovalKey ?? "null"})`)
  }
  // Version 3 binds the exact prompt draft and the approval artifact. A
  // re-plan that changes any of these is AUTH_STALE, never a silent rebind.
  for (const key of [
    "specHash",
    "specBytes",
    "approvalDigest",
    "approvalNonce",
    "approvalBinding",
    "approvedBy",
    "approvedAt",
  ] as const) {
    const a = manifest[key] ?? null
    const b = (current as any)[key] ?? null
    if (a !== b) drift.push(`${key} drifted (manifest=${a ?? "null"} current=${b ?? "null"})`)
  }
  // Only a signed→legacy downgrade is drift; a 0.8.0 manifest (absent = legacy)
  // may be re-planned into a signed run.
  const baselineHandoffAuth = manifest.handoffAuth ?? "legacy"
  const currentHandoffAuth = current.handoffAuth ?? "legacy"
  if (baselineHandoffAuth === "signed" && currentHandoffAuth === "legacy") {
    drift.push(`handoffAuth downgraded: manifest=signed current=legacy`)
  }
  // 0.16.0: re-execution is sticky. declared→command is an upgrade (allowed at
  // re-plan); command→declared is a downgrade.
  const baselineProvenance = manifestProvenance(manifest)
  const currentProvenance =
    manifest.version >= COMMAND_PROVENANCE_MIN_VERSION && current.requiredProvenance === "command"
      ? "command"
      : "declared"
  if (baselineProvenance === "command" && currentProvenance !== "command") {
    drift.push(`requiredProvenance downgraded: manifest=command current=${currentProvenance}`)
  }
  // 0.18.0: the attestation requirement is sticky in the same direction. An
  // off→optional→required upgrade is allowed; the reverse is drift. Once a key
  // id or issuer is pinned, changing it is drift too.
  const baselineAttestation = manifestAttestationMode(manifest)
  const currentAttestation = normalizeAttestationMode(current.attestationPolicy) ?? "off"
  if (attestationPolicyRank(currentAttestation) < attestationPolicyRank(baselineAttestation)) {
    drift.push(`attestationPolicy downgraded: manifest=${baselineAttestation} current=${currentAttestation}`)
  }
  if (manifest.attestationKeyId && manifest.attestationKeyId !== (current.attestationKeyId ?? null)) {
    drift.push(
      `attestationKeyId drifted (manifest=${manifest.attestationKeyId} current=${current.attestationKeyId ?? "null"})`,
    )
  }
  if (manifest.attestationIssuer && manifest.attestationIssuer !== (current.attestationIssuer ?? null)) {
    drift.push(`attestationIssuer drifted (manifest pinned, current=${current.attestationIssuer ? "changed" : "null"})`)
  }
  for (const key of ["requestHash", "requirementsHash", "planHash", "lemmaPolicyHash"] as const) {
    const a = manifest[key]
    const b = current[key]
    if (a !== b) drift.push(`${key} drifted (manifest=${a ?? "null"} current=${b ?? "null"})`)
  }
  return drift
}

/**
 * Current version-3 binding fields. For a non-approval run the draft is
 * re-hashed here, so an edited spec is `AUTH_STALE`. For an approval-bound run
 * the trust gate owns the check and names the precise failure; this function
 * mirrors the manifest values so generic drift does not pre-empt it.
 */
function currentApprovalDriftFields(
  manifest: RunManifest,
  run: string,
  trustLevel: TrustLevel,
): Pick<RunManifest, "specHash" | "specBytes" | "approvalDigest" | "approvalNonce" | "approvalBinding" | "approvedBy" | "approvedAt"> {
  if (manifest.version < APPROVAL_PROMPT_MIN_VERSION) {
    return {
      specHash: null,
      specBytes: null,
      approvalDigest: null,
      approvalNonce: null,
      approvedBy: null,
      approvedAt: null,
    }
  }
  // An approval-bound run is checked by evaluateTrustGate, which names the
  // precise failure (AUTH_APPROVAL_STALE / _INCOMPLETE / _REPLAY). Mirroring
  // the manifest values here keeps manifestDrift from pre-empting that named
  // refusal; re-plan drift is still enforced in createPlanRun.
  if (manifest.approvalBinding === "prompt" && requiresApproval(trustLevel)) {
    return {
      specHash: manifest.specHash ?? null,
      specBytes: manifest.specBytes ?? null,
      approvalDigest: manifest.approvalDigest ?? null,
      approvalNonce: manifest.approvalNonce ?? null,
      approvalBinding: "prompt",
      approvedBy: manifest.approvedBy ?? null,
      approvedAt: manifest.approvedAt ?? null,
    }
  }
  const draft = readPromptDraft(run)
  return {
    specHash: draft.ok ? draft.sha256 : null,
    specBytes: draft.ok ? draft.bytes : null,
    approvalDigest: null,
    approvalNonce: null,
    approvedBy: null,
    approvedAt: null,
  }
}

/** Recompute the signed-baseline comparison from the current run artifacts. */
function currentManifestDrift(manifest: RunManifest, plan: any, state: any, run: string): string[] {
  const currentTrust = normalizeTrustLevel(plan?.trustLevel ?? state?.trustLevel) ?? DEFAULT_TRUST_LEVEL
  const currentApprovalKey =
    manifest.version < APPROVAL_EXTERNAL_MIN_VERSION
      ? manifest.approvalKeyId ?? null
      : approvalKeyIdFromEnv(process.env) ?? null
  return manifestDrift(manifest, {
    integrityMode: normalizeIntegrityMode(plan?.integrityMode ?? state?.integrityMode) ?? DEFAULT_INTEGRITY_MODE,
    verification: resolveVerificationMode(plan, state).mode,
    victoryAudit: resolveVictoryAuditMode(plan, state, run).mode,
    victorySkipReason:
      recordedVictorySkipReason(plan?.victorySkipReason) ?? recordedVictorySkipReason(state?.victorySkipReason),
    requireHandoffs: resolveHandoffMode(plan, state).mode,
    trustLevel: currentTrust,
    requireWitness: (plan?.requireWitness ?? state?.requireWitness) === true,
    approvalPolicy: approvalPolicyFor(currentTrust, manifest.version),
    approvalKeyId: currentApprovalKey,
    handoffAuth: plan?.allowUnsignedLegacy === true || state?.allowUnsignedLegacy === true ? "legacy" : "signed",
    requiredProvenance: manifestProvenance(manifest),
    attestationPolicy: normalizeAttestationMode(plan?.attestationPolicy ?? state?.attestationPolicy) ?? "off",
    attestationKeyId:
      (typeof plan?.attestationKeyId === "string" ? plan.attestationKeyId : undefined) ??
      (typeof state?.attestationKeyId === "string" ? state.attestationKeyId : undefined) ??
      null,
    attestationIssuer:
      (typeof plan?.attestationIssuer === "string" ? plan.attestationIssuer : undefined) ??
      (typeof state?.attestationIssuer === "string" ? state.attestationIssuer : undefined) ??
      null,
    requestHash: originalRequestHash(run),
    requirementsHash: currentRequirementsHash(run),
    planHash: planHashOf(plan),
    lemmaPolicyHash: lemmaPolicyHashOf(run),
    ...currentApprovalDriftFields(manifest, run, currentTrust),
  })
}

// ---------------------------------------------------------------------------
// Human/CI approvals (0.10.2)
//
// An approval is the same `_auth`-signed artifact format as every other
// control-plane artifact, but it is read from an external approval directory
// and must be signed by an Ed25519 key that is NOT the run's `runKeyId`.
// "human-approved" records who claims to have approved and when; it does not
// prove that a human read the diff (see SECURITY.md).
// ---------------------------------------------------------------------------

const ENV_APPROVAL_DIR = "OPENCODE_TEAMWORK_APPROVAL_DIR"
const ENV_APPROVAL_TTL_MS = "OPENCODE_TEAMWORK_APPROVAL_TTL_MS"
/** Storage key: one consumed approval nonce per run (0.11.0 replay control). */
const approvalConsumedKey = (runId: string) => `auth/approval/${runId}/consumed`
const APPROVAL_TTL_DEFAULT_MS = 24 * 60 * 60 * 1000
const APPROVAL_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000
const APPROVAL_FILE_MAX_BYTES = 256 * 1024
/** `uid:<name>`, `oidc:<issuer>#<sub>`, or `ci:<workflow>`; free labels are refused. */
const APPROVER_ID_RE =
  /^(?:uid:[A-Za-z0-9._-]{1,64}|oidc:[^\s#\u0000-\u001f]{1,200}#[^\s#\u0000-\u001f]{1,200}|ci:[A-Za-z0-9._/-]{1,120})$/
const approvalUnboundEmitted = new Set<string>()

let approvalOwnerUidOverride: number | null = null

/**
 * Test-only seam. A real different-principal approval directory is owned by a
 * different UID, which a single-UID test process cannot create. Production
 * never calls this; the default is `process.geteuid()`.
 */
export function setApprovalOwnerUidForTest(uid: number | null): void {
  approvalOwnerUidOverride =
    typeof uid === "number" && Number.isFinite(uid) ? Math.trunc(uid) : null
}

function expectedApprovalOwnerUid(): number | undefined {
  if (approvalOwnerUidOverride !== null) return approvalOwnerUidOverride
  try {
    return typeof process.geteuid === "function" ? process.geteuid() : undefined
  } catch {
    return undefined
  }
}

/** True when `child` is `parent` or inside it (separator-aware). */
function pathWithinOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function approvalTtlMs(env: Record<string, string | undefined>): number {
  const raw = String(env[ENV_APPROVAL_TTL_MS] ?? "").trim()
  if (!raw) return APPROVAL_TTL_DEFAULT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return APPROVAL_TTL_DEFAULT_MS
  return Math.min(Math.trunc(parsed), APPROVAL_TTL_MAX_MS)
}

type ApprovalDirResult =
  | { ok: true; dir: string }
  | { ok: false; code: AuthFailure["code"]; message: string }

/**
 * Resolve and validate `OPENCODE_TEAMWORK_APPROVAL_DIR`: absolute, an existing
 * real directory (never a symlink), outside the run directory and outside the
 * repo, and not owned by the run's UID.
 */
function resolveApprovalDir(
  root: string,
  run: string,
  env: Record<string, string | undefined>,
): ApprovalDirResult {
  const raw = String(env[ENV_APPROVAL_DIR] ?? "").trim()
  if (!raw) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_DIR",
      message: `${ENV_APPROVAL_DIR} is not set; human-approved/ci-attested require an external approval directory`,
    }
  }
  if (!isAbsolute(raw)) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_DIR",
      message: `${ENV_APPROVAL_DIR} must be an absolute path (got "${clean(raw, 200)}")`,
    }
  }
  let dir: string
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(raw)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return {
        ok: false,
        code: "AUTH_APPROVAL_DIR",
        message: `${ENV_APPROVAL_DIR} must be a real directory (not a symlink): ${clean(raw, 200)}`,
      }
    }
    dir = realpathSync(raw)
  } catch (err: any) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_DIR",
      message: `${ENV_APPROVAL_DIR} is not readable as a directory (${err?.code ?? "error"}): ${clean(raw, 200)}`,
    }
  }
  let runReal = resolve(run)
  try {
    if (existsSync(run)) runReal = realpathSync(run)
  } catch {}
  let repoReal = resolve(root)
  try {
    repoReal = realpathSync(root)
  } catch {}
  if (pathWithinOrEqual(runReal, dir)) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_UNTRUSTED",
      message: `approval directory ${clean(dir, 200)} is inside the run directory`,
    }
  }
  if (pathWithinOrEqual(repoReal, dir)) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_UNTRUSTED",
      message: `approval directory ${clean(dir, 200)} is inside the repository`,
    }
  }
  const owner = expectedApprovalOwnerUid()
  if (owner === undefined) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_UNTRUSTED",
      message: "cannot determine the process euid; approval ownership cannot be checked",
    }
  }
  if (st.uid === owner) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_UNTRUSTED",
      message: `approval directory ${clean(dir, 200)} is owned by the run UID; approvals must come from a different principal`,
    }
  }
  return { ok: true, dir }
}

type ApprovalReadResult =
  | { ok: true; data: any }
  | { ok: false; code: AuthFailure["code"]; message: string }

/** Read one approval file without following a symlink and without trusting its owner. */
function readApprovalDocument(file: string, owner: number | undefined): ApprovalReadResult {
  const nofollow = fsConstants.O_NOFOLLOW || 0
  const nonblock = fsConstants.O_NONBLOCK || 0
  if (nofollow === 0 || nonblock === 0) {
    try {
      if (lstatSync(file).isSymbolicLink()) {
        return { ok: false, code: "AUTH_APPROVAL_UNTRUSTED", message: `approval artifact ${clean(file, 200)} is a symlink` }
      }
    } catch (err: any) {
      return {
        ok: false,
        code: err?.code === "ENOENT" ? "AUTH_APPROVAL_MISSING" : "AUTH_APPROVAL_UNTRUSTED",
        message:
          err?.code === "ENOENT"
            ? `approval artifact ${clean(file, 200)} does not exist`
            : `approval artifact ${clean(file, 200)} cannot be inspected (${err?.code ?? "error"})`,
      }
    }
  }

  let fd: number | undefined
  try {
    try {
      fd = openSync(file, fsConstants.O_RDONLY | nofollow | nonblock)
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return { ok: false, code: "AUTH_APPROVAL_MISSING", message: `approval artifact ${clean(file, 200)} does not exist` }
      }
      if (err?.code === "ELOOP" || err?.code === "EMLINK") {
        return { ok: false, code: "AUTH_APPROVAL_UNTRUSTED", message: `approval artifact ${clean(file, 200)} is a symlink` }
      }
      return {
        ok: false,
        code: "AUTH_APPROVAL_UNTRUSTED",
        message: `approval artifact ${clean(file, 200)} cannot be inspected (${err?.code ?? "error"})`,
      }
    }
    const st = fstatSync(fd)
    if (!st.isFile()) {
      return { ok: false, code: "AUTH_APPROVAL_UNTRUSTED", message: `approval artifact ${clean(file, 200)} is not a regular file` }
    }
    if (st.size > APPROVAL_FILE_MAX_BYTES) {
      return {
        ok: false,
        code: "AUTH_APPROVAL_UNTRUSTED",
        message: `approval artifact ${clean(file, 200)} is larger than ${APPROVAL_FILE_MAX_BYTES} bytes`,
      }
    }
    if (owner === undefined || st.uid === owner) {
      return {
        ok: false,
        code: "AUTH_APPROVAL_UNTRUSTED",
        message: `approval artifact ${clean(file, 200)} is owned by the run UID; approvals must come from a different principal`,
      }
    }
    const cap = APPROVAL_FILE_MAX_BYTES + 1
    const buf = Buffer.alloc(cap)
    let total = 0
    while (total < cap) {
      let n: number
      try {
        n = readSync(fd, buf, total, cap - total, null)
      } catch (readErr: any) {
        if (readErr?.code === "EINTR") continue
        throw readErr
      }
      if (n === 0) break
      total += n
    }
    if (total > APPROVAL_FILE_MAX_BYTES) {
      return {
        ok: false,
        code: "AUTH_APPROVAL_UNTRUSTED",
        message: `approval artifact ${clean(file, 200)} grew beyond ${APPROVAL_FILE_MAX_BYTES} bytes while it was opened`,
      }
    }
    const text = buf.subarray(0, total).toString("utf8")
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, code: "AUTH_APPROVAL_UNTRUSTED", message: `approval artifact ${clean(file, 200)} is not valid JSON` }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, code: "AUTH_APPROVAL_UNTRUSTED", message: `approval artifact ${clean(file, 200)} is not an object` }
    }
    return { ok: true, data }
  } catch (err: any) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_UNTRUSTED",
      message: `approval artifact ${clean(file, 200)} could not be read (${err?.code ?? "error"})`,
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt-draft binding (0.11.0)
//
// An approval must be bound to the exact bytes of `<run>/prompt_draft.md`.
// `specHash` is an unkeyed SHA-256 of those bytes (not the keyed artifact
// digest `sha256Hex` uses); the byte count is recorded too so a re-encode cannot
// masquerade as the same text.
// ---------------------------------------------------------------------------

type PromptDraftDigest =
  | { ok: true; sha256: string; bytes: number; text: string; openGaps: number; path: string }
  | { ok: false; code: AuthFailure["code"]; message: string }

function countOpenGaps(text: string): number {
  const matches = text.match(/\[OPEN:/g)
  return matches ? matches.length : 0
}

/** Read and hash the draft through the bounded, no-follow run reader. */
function readPromptDraft(run: string): PromptDraftDigest {
  const file = join(run, "prompt_draft.md")
  const res = readBoundedRunFile(run, file, MAX_RUN_FILE_BYTES)
  if (res.status === "absent") {
    return {
      ok: false,
      code: "AUTH_APPROVAL_INCOMPLETE",
      message: `an approval is bound to ${file}, but that draft does not exist`,
    }
  }
  if (res.status !== "ok") {
    return {
      ok: false,
      code: "AUTH_APPROVAL_INCOMPLETE",
      message: `an approval is bound to ${file}, but the draft could not be read (${res.error})`,
    }
  }
  const bytes = res.bytes ?? Buffer.from(res.text, "utf8")
  const text = bytes.toString("utf8")
  return {
    ok: true,
    sha256: contentSha256Hex(bytes),
    bytes: bytes.length,
    text,
    openGaps: countOpenGaps(text),
    path: file,
  }
}

type ApprovalConsumption = {
  approvalNonce: string
  approvalDigest: string
  planHash: string | null
  at: string
  runId: string
}

async function readApprovalConsumption(ctx: any, runId: string): Promise<ApprovalConsumption | undefined> {
  const storage = ctx?.storage
  if (!storage || typeof storage.get !== "function") return undefined
  try {
    const value = await storage.get(approvalConsumedKey(runId))
    if (!value || typeof value !== "object") return undefined
    if (typeof value.approvalNonce !== "string" || value.approvalNonce === "") return undefined
    return value as ApprovalConsumption
  } catch {
    return undefined
  }
}

/**
 * Record the one-use approval nonce. The in-process lock serialises callers in
 * this process; a cross-process race is bounded by the signed manifest drift
 * (both processes must present the same approved draft and nonce to plan the
 * same run). The residual is documented in ADR 0011.
 */
async function consumeApprovalNonce(
  ctx: any,
  runId: string,
  record: Omit<ApprovalConsumption, "at" | "runId">,
): Promise<{ ok: true } | { ok: false; failure: AuthFailure }> {
  const storage = ctx?.storage
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    return {
      ok: false,
      failure: { code: "AUTH_UNAVAILABLE", message: "ctx.storage is unavailable; the approval nonce cannot be consumed" },
    }
  }
  return withFileLock(`approval-consume:${runId}`, async () => {
    let existing: any
    try {
      existing = await storage.get(approvalConsumedKey(runId))
    } catch (err: any) {
      return {
        ok: false as const,
        failure: {
          code: "AUTH_UNAVAILABLE" as const,
          message: `could not read the consumed approval nonce (${String(err?.message ?? err).slice(0, 120)})`,
        },
      }
    }
    if (existing && typeof existing === "object") {
      if (existing.approvalNonce !== record.approvalNonce) {
        return {
          ok: false as const,
          failure: {
            code: "AUTH_APPROVAL_REPLAY" as const,
            message: `run ${runId} already consumed approval nonce ${clean(existing.approvalNonce, 80)}; a different nonce cannot re-approve the same run`,
          },
        }
      }
      if (existing.approvalDigest && existing.approvalDigest !== record.approvalDigest) {
        return {
          ok: false as const,
          failure: {
            code: "AUTH_APPROVAL_REPLAY" as const,
            message: `run ${runId} already consumed nonce ${clean(record.approvalNonce, 80)} with a different approval digest`,
          },
        }
      }
      // A pre-mkdir consumption records planHash: null; the plan records the
      // real hash as soon as it is known, without changing the nonce.
      if (record.planHash && existing.planHash !== record.planHash) {
        try {
          await storage.set(approvalConsumedKey(runId), { ...existing, planHash: record.planHash })
        } catch {}
      }
      return { ok: true as const }
    }
    try {
      await storage.set(approvalConsumedKey(runId), {
        approvalNonce: record.approvalNonce,
        approvalDigest: record.approvalDigest,
        planHash: record.planHash,
        at: new Date().toISOString(),
        runId,
      })
    } catch (err: any) {
      return {
        ok: false as const,
        failure: {
          code: "AUTH_UNAVAILABLE" as const,
          message: `could not consume the approval nonce (${String(err?.message ?? err).slice(0, 120)})`,
        },
      }
    }
    return { ok: true as const }
  })
}

/**
 * Freshness shared by the plan-time gate and final verification. The default
 * lifetime is 24 h and the hard cap is 7 days. A prompt-bound approval is
 * issued before the plan, so it must still be live when the manifest was
 * written rather than postdate it.
 */
function approvalFreshnessReasons(
  label: string,
  approval: any,
  env: Record<string, string | undefined>,
  opts: { requireManifestOrdering: boolean; manifestAt?: string; promptBound: boolean },
): string[] {
  const reasons: string[] = []
  const ttl = approvalTtlMs(env)
  const approvedAtMs = typeof approval.approvedAt === "string" ? Date.parse(approval.approvedAt) : Number.NaN
  const manifestAtMs = opts.manifestAt !== undefined ? Date.parse(opts.manifestAt) : Number.NaN
  if (!Number.isFinite(approvedAtMs)) {
    return [`[AUTH_APPROVAL_STALE] ${clean(label, 200)} needs a valid ISO approvedAt`]
  }
  if (opts.requireManifestOrdering && Number.isFinite(manifestAtMs) && approvedAtMs < manifestAtMs) {
    reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} approvedAt precedes the signed manifest createdAt`)
  }
  let expiresAtMs: number
  if (approval.expiresAt === undefined || approval.expiresAt === null) {
    expiresAtMs = approvedAtMs + ttl
  } else {
    expiresAtMs = typeof approval.expiresAt === "string" ? Date.parse(approval.expiresAt) : Number.NaN
    if (!Number.isFinite(expiresAtMs)) {
      reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} has an invalid expiresAt`)
    } else if (expiresAtMs < approvedAtMs) {
      reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} expiresAt precedes approvedAt`)
    } else if (expiresAtMs > approvedAtMs + APPROVAL_TTL_MAX_MS) {
      reasons.push(
        `[AUTH_APPROVAL_STALE] ${clean(label, 200)} expiresAt exceeds the ${APPROVAL_TTL_MAX_MS / 3600000}h maximum approval lifetime`,
      )
    } else if (expiresAtMs > approvedAtMs + ttl) {
      reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} expiresAt exceeds the configured approval TTL`)
    }
  }
  if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
    reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} expired at ${clean(approval.expiresAt ?? "", 40) || "its TTL"}`)
  }
  if (opts.promptBound && Number.isFinite(expiresAtMs) && Number.isFinite(manifestAtMs) && expiresAtMs < manifestAtMs) {
    reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} expired before the signed manifest was written`)
  }
  return reasons
}

type ApprovalArtifactCheck = { reasons: string[]; legacy: boolean }

/**
 * Verify one approval artifact against the signed manifest. Version 1
 * manifests keep the old in-run `approvals/<runId>.json` path (readable, but
 * recorded as `approval_unbound`); version 2+ requires the external directory,
 * an Ed25519 approver key distinct from `runKeyId`, freshness, and a
 * `uid:`/`oidc:`/`ci:` identity.
 */
async function checkApprovalArtifact(
  ctx: any,
  run: string,
  runId: string,
  manifest: RunManifest,
  auth: AuthContext | undefined,
  trustLevel: TrustLevel,
  repoRoot: string,
  env: Record<string, string | undefined>,
): Promise<ApprovalArtifactCheck> {
  const reasons: string[] = []
  const relPath = `approvals/${runId}.json`
  const legacy = manifest.version < APPROVAL_EXTERNAL_MIN_VERSION
  let approval: any
  let label = relPath
  if (legacy) {
    const res = readRegularJson<any>(run, join(run, relPath))
    if (!res.ok) {
      return {
        reasons: [
          `[AUTH_APPROVAL_MISSING] ${relPath} is ${res.reason}; trustLevel ${trustLevel} requires a signed approval artifact`,
        ],
        legacy: true,
      }
    }
    approval = res.data
  } else {
    const dir = resolveApprovalDir(repoRoot, run, env)
    if (!dir.ok) return { reasons: [`[${dir.code}] ${dir.message}`], legacy: false }
    label = join(dir.dir, `${runId}.json`)
    const read = readApprovalDocument(label, expectedApprovalOwnerUid())
    if (!read.ok) return { reasons: [`[${read.code}] ${read.message}`], legacy: false }
    approval = read.data
  }
  if (!auth) {
    return { reasons: ["[AUTH_UNAVAILABLE] no authenticity context is wired to verify the approval artifact"], legacy }
  }
  const verified = await auth.verifyArtifact(
    relPath,
    approval,
    legacy
      ? {
          ...(manifest.runNonce ? { requireNonce: manifest.runNonce } : {}),
          expectedKeyId: manifest.runKeyId,
        }
      : {},
  )
  if (!verified.ok) {
    return {
      reasons: [`[${verified.failure.code}] ${clean(label, 200)} failed verification: ${verified.failure.message}`],
      legacy,
    }
  }
  if (approval.runId !== runId) {
    reasons.push(`[AUTH_INVALID] ${clean(label, 200)} is bound to run ${clean(approval.runId, 64)} (expected ${runId})`)
  }
  if (approval.trustLevel !== trustLevel) {
    reasons.push(
      `[AUTH_INVALID] ${clean(label, 200)} records trustLevel ${clean(approval.trustLevel, 32)} (expected ${trustLevel})`,
    )
  }
  const promptBound =
    !legacy && manifest.version >= APPROVAL_PROMPT_MIN_VERSION && manifest.approvalBinding === "prompt"
  if (!promptBound && approval.manifestDigest !== payloadDigest(manifest)) {
    reasons.push(`[AUTH_INVALID] ${clean(label, 200)} manifestDigest does not match the signed run manifest`)
  }
  const approverField = trustLevel === "human-approved" ? "approvedBy" : "attestedBy"
  const approver = (approval as any)[approverField]
  if (typeof approver !== "string" || approver.trim() === "") {
    reasons.push(`[AUTH_APPROVAL_MISSING] ${clean(label, 200)} needs ${approverField}`)
  }
  if (legacy) {
    // Pre-0.10.2 runs predate the external-directory and identity policy. They
    // stay readable, but the caller records that the approval was unbound.
    return { reasons, legacy: true }
  }
  if (promptBound) {
    // 0.11.0: the approval is bound to the draft and the manifest records the
    // approval, so there is no circular manifestDigest requirement.
    const approvalDigest = payloadDigest(approval)
    if (typeof manifest.approvalDigest !== "string" || manifest.approvalDigest === "") {
      reasons.push(`[AUTH_APPROVAL_INCOMPLETE] run.manifest.json does not record the approved approvalDigest`)
    } else if (manifest.approvalDigest !== approvalDigest) {
      reasons.push(
        `[AUTH_APPROVAL_STALE] ${clean(label, 200)} payload digest ${clean(approvalDigest, 64)} does not match the signed manifest`,
      )
    }
    if (approval.binding !== "prompt") {
      reasons.push(`[AUTH_APPROVAL_INCOMPLETE] ${clean(label, 200)} does not record binding: "prompt"`)
    }
    if (manifest.approvalNonce !== approval.approvalNonce) {
      reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} approvalNonce does not match the signed manifest`)
    }
    if (manifest.approvedBy !== undefined && manifest.approvedBy !== null && approver !== manifest.approvedBy) {
      reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} approver ${clean(approver, 80)} does not match the signed manifest (${clean(manifest.approvedBy, 80)})`)
    }
    if (manifest.approvedAt !== undefined && manifest.approvedAt !== null && approval.approvedAt !== manifest.approvedAt) {
      reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} approvedAt does not match the signed manifest`)
    }
    if (!isApprovalNonce(approval.approvalNonce)) {
      reasons.push(`[AUTH_APPROVAL_INCOMPLETE] ${clean(label, 200)} needs a >=128-bit base64url approvalNonce`)
    } else if (verified.auth.nonce !== approval.approvalNonce) {
      reasons.push(
        `[AUTH_APPROVAL_INCOMPLETE] ${clean(label, 200)} _auth.nonce does not equal approvalNonce; the one-use nonce must be inside the signed envelope`,
      )
    }
    const draft = readPromptDraft(run)
    if (!draft.ok) {
      reasons.push(`[${draft.code}] ${draft.message}`)
    } else {
      if (manifest.specHash !== draft.sha256) {
        reasons.push(
          `[AUTH_APPROVAL_STALE] prompt_draft.md is ${draft.sha256.slice(0, 16)}… (${draft.bytes} bytes); the signed manifest records ${String(manifest.specHash ?? "null").slice(0, 16)}…`,
        )
      }
      if (manifest.specBytes !== draft.bytes) {
        reasons.push(
          `[AUTH_APPROVAL_STALE] prompt_draft.md is ${draft.bytes} bytes; the signed manifest records ${String(manifest.specBytes ?? "null")}`,
        )
      }
      if (approval.promptDraftSha256 !== draft.sha256) {
        reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} is bound to a different prompt_draft.md digest`)
      }
      if (approval.promptDraftBytes !== draft.bytes) {
        reasons.push(`[AUTH_APPROVAL_STALE] ${clean(label, 200)} is bound to a different prompt_draft.md byte count`)
      }
      if (draft.openGaps > 0) {
        reasons.push(
          `[AUTH_APPROVAL_INCOMPLETE] prompt_draft.md still contains ${draft.openGaps} [OPEN: gap(s); an approved draft must be resolved`,
        )
      }
    }
    if (approval.openGaps !== 0) {
      reasons.push(`[AUTH_APPROVAL_INCOMPLETE] ${clean(label, 200)} records openGaps ${clean(approval.openGaps, 16)}; the plan refuses an approval granted with unresolved gaps`)
    }
    const consumed = ctx ? await readApprovalConsumption(ctx, runId) : undefined
    if (consumed && consumed.approvalNonce !== approval.approvalNonce) {
      reasons.push(
        `[AUTH_APPROVAL_REPLAY] run ${runId} consumed approval nonce ${clean(consumed.approvalNonce, 80)}; this approval uses a different nonce`,
      )
    }
  }

  // Distinct-principal rules. An HMAC envelope or the run's own key is not a
  // human/CI approval; it is the same principal approving itself.
  if (verified.auth.alg !== "ed25519") {
    reasons.push(
      `[AUTH_APPROVAL_NOT_HUMAN] ${clean(label, 200)} is signed with ${verified.auth.alg}; human-approved/ci-attested require an Ed25519 approver key`,
    )
  }
  if (verified.keyId === manifest.runKeyId) {
    reasons.push(
      `[AUTH_APPROVAL_NOT_HUMAN] ${clean(label, 200)} is signed by the run key ${clean(manifest.runKeyId, 96)}; approval must use a distinct approver key`,
    )
  }
  if (manifest.approvalKeyId && verified.keyId !== manifest.approvalKeyId) {
    reasons.push(
      `[AUTH_APPROVAL_UNTRUSTED] ${clean(label, 200)} approver key ${clean(verified.keyId, 96)} is not the key pinned at plan time (${clean(manifest.approvalKeyId, 96)})`,
    )
  }
  reasons.push(
    ...approvalFreshnessReasons(label, approval, env, {
      requireManifestOrdering: !promptBound,
      manifestAt: manifest.createdAt,
      promptBound,
    }),
  )
  if (typeof approver === "string" && approver.trim() !== "" && !APPROVER_ID_RE.test(approver.trim())) {
    reasons.push(
      `[AUTH_APPROVAL_NOT_HUMAN] ${clean(label, 200)} ${approverField} must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow> (got "${clean(approver, 80)}")`,
    )
  }
  return { reasons, legacy }
}

/**
 * Plan-time prerequisites. These run before any mkdir/state write, so a refusal
 * leaves no run directory. A version 1 run keeps the legacy in-run path.
 */
function checkApprovalPrerequisites(
  root: string,
  run: string,
  trustLevel: TrustLevel,
  version: number,
  env: Record<string, string | undefined>,
): { ok: true; approvalKeyId: string | null; approvalPolicy: ApprovalPolicy } | { ok: false; code: AuthFailure["code"]; message: string } {
  const approvalPolicy = approvalPolicyFor(trustLevel, version)
  const approvalKeyId = approvalKeyIdFromEnv(env) ?? null
  if (approvalPolicy !== "external-dir") return { ok: true, approvalKeyId, approvalPolicy }
  const dir = resolveApprovalDir(root, run, env)
  if (!dir.ok) return { ok: false, code: dir.code, message: dir.message }
  if (!approvalKeyId) {
    return {
      ok: false,
      code: "AUTH_APPROVAL_UNTRUSTED",
      message:
        "human-approved/ci-attested require OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY so the approval can be verified with a key that is not the run key",
    }
  }
  return { ok: true, approvalKeyId, approvalPolicy }
}

type PlanApprovalSummary = {
  approvalDigest: string
  approvalNonce: string
  approver: string
  approvedAt: string
  approvalKeyId: string
  path: string
  specHash: string
  specBytes: number
  openGaps: number
}

/**
 * Plan-time approval verification (0.11.0). Runs before any mkdir/state write
 * and binds the approval to the exact bytes of `prompt_draft.md`, the run id,
 * and a one-use nonce. Version 1/2 runs keep their pre-0.11 semantics; the
 * caller only consults this for version 3.
 */
async function verifyPlanApproval(
  run: string,
  runId: string,
  trustLevel: TrustLevel,
  runKeyId: string | undefined,
  existingPlanHash: string | null,
  auth: AuthContext | undefined,
  root: string,
  env: Record<string, string | undefined>,
): Promise<{ ok: true; summary: PlanApprovalSummary } | { ok: false; code: AuthFailure["code"]; message: string }> {
  const fail = (code: AuthFailure["code"], message: string) => ({ ok: false as const, code, message })
  const draft = readPromptDraft(run)
  if (!draft.ok) return fail(draft.code, draft.message)
  const dir = resolveApprovalDir(root, run, env)
  if (!dir.ok) return fail(dir.code, dir.message)
  const label = join(dir.dir, `${runId}.json`)
  const read = readApprovalDocument(label, expectedApprovalOwnerUid())
  if (!read.ok) return fail(read.code, read.message)
  const approval = read.data
  if (!auth) return fail("AUTH_UNAVAILABLE", "no authenticity context is wired to verify the approval artifact")
  const verified = await auth.verifyArtifact(`approvals/${runId}.json`, approval, {})
  if (!verified.ok) {
    return fail(verified.failure.code, `${clean(label, 200)} failed verification: ${verified.failure.message}`)
  }
  // A human/CI approval is not the run key approving itself.
  if (verified.auth.alg !== "ed25519") {
    return fail(
      "AUTH_APPROVAL_NOT_HUMAN",
      `${clean(label, 200)} is signed with ${verified.auth.alg}; human-approved/ci-attested require an Ed25519 approver key`,
    )
  }
  const pinnedApprovalKey = approvalKeyIdFromEnv(env)
  if (!pinnedApprovalKey) {
    return fail(
      "AUTH_APPROVAL_UNTRUSTED",
      "human-approved/ci-attested require OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY so the approval can be verified with a key that is not the run key",
    )
  }
  if (verified.keyId === runKeyId) {
    return fail(
      "AUTH_APPROVAL_NOT_HUMAN",
      `${clean(label, 200)} is signed by the run key ${clean(runKeyId ?? "", 96)}; approval must use a distinct approver key`,
    )
  }
  if (verified.keyId !== pinnedApprovalKey) {
    return fail(
      "AUTH_APPROVAL_UNTRUSTED",
      `${clean(label, 200)} approver key ${clean(verified.keyId, 96)} is not the configured approval key (${clean(pinnedApprovalKey, 96)})`,
    )
  }
  if (approval.runId !== runId) {
    return fail(
      "AUTH_APPROVAL_INCOMPLETE",
      `${clean(label, 200)} is bound to run ${clean(approval.runId, 64)} (expected ${runId})`,
    )
  }
  if (approval.trustLevel !== trustLevel) {
    return fail(
      "AUTH_APPROVAL_INCOMPLETE",
      `${clean(label, 200)} records trustLevel ${clean(approval.trustLevel, 32)} (expected ${trustLevel})`,
    )
  }
  if (approval.binding !== "prompt") {
    return fail("AUTH_APPROVAL_INCOMPLETE", `${clean(label, 200)} does not record binding: "prompt"`)
  }
  if (approval.manifestDigest !== undefined && approval.manifestDigest !== null) {
    // v3 approvals are bound to the draft + manifest record, not to a digest
    // that would have to include itself. An explicit legacy digest can never
    // match and is refused rather than silently ignored.
    return fail(
      "AUTH_APPROVAL_INCOMPLETE",
      `${clean(label, 200)} carries a manifestDigest; a prompt-bound approval must bind the draft instead`,
    )
  }
  const approverField = trustLevel === "human-approved" ? "approvedBy" : "attestedBy"
  const approver = approval[approverField]
  if (typeof approver !== "string" || approver.trim() === "") {
    return fail("AUTH_APPROVAL_MISSING", `${clean(label, 200)} needs ${approverField}`)
  }
  if (!APPROVER_ID_RE.test(approver.trim())) {
    return fail(
      "AUTH_APPROVAL_NOT_HUMAN",
      `${clean(label, 200)} ${approverField} must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow> (got "${clean(approver, 80)}")`,
    )
  }
  if (approval.promptDraftSha256 !== draft.sha256) {
    return fail(
      "AUTH_APPROVAL_STALE",
      `${clean(label, 200)} is bound to a different prompt_draft.md digest (${clean(approval.promptDraftSha256, 64)}); the current draft is ${draft.sha256}`,
    )
  }
  if (approval.promptDraftBytes !== draft.bytes) {
    return fail(
      "AUTH_APPROVAL_STALE",
      `${clean(label, 200)} is bound to ${clean(approval.promptDraftBytes, 16)} bytes; the current draft is ${draft.bytes} bytes`,
    )
  }
  if (approval.openGaps !== 0) {
    return fail(
      "AUTH_APPROVAL_INCOMPLETE",
      `${clean(label, 200)} records openGaps ${clean(approval.openGaps, 16)}; an approval granted with unresolved [OPEN:] gaps cannot be planned`,
    )
  }
  if (approval.planHash !== undefined && approval.planHash !== null) {
    if (typeof approval.planHash !== "string" || approval.planHash !== existingPlanHash) {
      return fail(
        "AUTH_APPROVAL_STALE",
        `${clean(label, 200)} pre-commits to plan ${clean(approval.planHash, 64)}, but this run's plan baseline is ${clean(existingPlanHash ?? "null", 64)}`,
      )
    }
  }
  if (draft.openGaps > 0) {
    return fail(
      "AUTH_APPROVAL_INCOMPLETE",
      `prompt_draft.md still contains ${draft.openGaps} [OPEN: gap(s); an approved draft must be resolved`,
    )
  }
  if (!isApprovalNonce(approval.approvalNonce)) {
    return fail("AUTH_APPROVAL_INCOMPLETE", `${clean(label, 200)} needs a >=128-bit base64url approvalNonce`)
  }
  if (verified.auth.nonce !== approval.approvalNonce) {
    return fail(
      "AUTH_APPROVAL_INCOMPLETE",
      `${clean(label, 200)} _auth.nonce does not equal approvalNonce; the one-use nonce must be inside the signed envelope`,
    )
  }
  const freshness = approvalFreshnessReasons(label, approval, env, {
    requireManifestOrdering: false,
    promptBound: false,
  })
  if (freshness.length > 0) {
    const first = freshness[0]
    return fail("AUTH_APPROVAL_STALE", first.replace(/^\[[A-Z_]+\]\s*/, ""))
  }
  return {
    ok: true,
    summary: {
      approvalDigest: payloadDigest(approval),
      approvalNonce: approval.approvalNonce,
      approver: approver.trim(),
      approvedAt: approval.approvedAt,
      approvalKeyId: verified.keyId,
      path: label,
      specHash: draft.sha256,
      specBytes: draft.bytes,
      openGaps: draft.openGaps,
    },
  }
}

/**
 * Enforce the run's persisted trust level at completion:
 *   * external-signer — the manifest (and every sampled artifact) must carry a
 *     verified Ed25519 envelope, never HMAC.
 *   * human-approved / ci-attested — a signed `approvals/<runId>.json` bound to
 *     this run id and the current manifest digest, from the external approval
 *     directory (version 2+) and signed by a distinct Ed25519 approver key.
 *   * requireWitness — a witness receipt must exist for the signed manifest.
 * Returns named refusal reasons; an empty array means the level is satisfied.
 */
async function evaluateTrustGate(
  ctx: any,
  run: string,
  runId: string,
  manifest: RunManifest,
  auth: AuthContext | undefined,
  trustLevel: TrustLevel,
  observedAlgs: Array<string | undefined>,
  repoRoot: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const reasons: string[] = []
  if (trustLevel === "external-signer") {
    const seen = [manifest._auth?.alg, ...observedAlgs].filter((alg): alg is string => alg !== undefined)
    const hmac = seen.filter((alg) => alg !== "ed25519")
    if (manifest._auth?.alg !== "ed25519" || hmac.length > 0) {
      reasons.push(
        `[AUTH_TRUST_LEVEL] external-signer requires verified Ed25519 envelopes; found ${seen.join(", ") || "no envelope"}`,
      )
    }
  }
  if (requiresApproval(trustLevel)) {
    const check = await checkApprovalArtifact(ctx, run, runId, manifest, auth, trustLevel, repoRoot, env)
    reasons.push(...check.reasons)
    if (check.legacy && check.reasons.length === 0 && !approvalUnboundEmitted.has(run)) {
      approvalUnboundEmitted.add(run)
      try {
        await appendEvent(run, {
          event: "approval_unbound",
          sessionId: runId,
          taskId: null,
          to: trustLevel,
          round: 0,
          agent: null,
          phase: null,
          note: "pre-0.10.2 manifest: approvals/<runId>.json was read from the run directory and is not bound to a distinct external approver",
        })
      } catch {}
    }
  }
  if (manifest.requireWitness === true) {
    // A required witness is checked, not merely counted: when a witness
    // public key is configured the receipt signature must cover this run,
    // path, digest and nonce. With no public key the receipt is
    // `unverified` (detection-only) and the requirement fails closed: a
    // receipt nobody can check is not evidence, so a run that requires a
    // witness can never PASS on an unverifiable one.
    const check = auth
      ? await auth.verifyWitnessReceipt(runId, RUN_MANIFEST, {
          digest: manifest._auth?.digest,
          nonce: manifest._auth?.nonce ?? manifest.runNonce,
        })
      : {
          status: "unknown" as const,
          failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
        }
    if (check.status === "missing" || check.status === "unknown") {
      reasons.push(
        `[${check.failure?.code ?? "AUTH_WITNESS_UNAVAILABLE"}] requireWitness is set but no usable witness receipt was recorded for run.manifest.json${
          check.failure?.message ? ` (${check.failure.message})` : ""
        }`,
      )
    } else if (check.status === "invalid") {
      reasons.push(
        `[${check.failure?.code ?? "AUTH_INVALID"}] the witness receipt for run.manifest.json is not valid: ${check.failure?.message ?? "verification failed"}`,
      )
    } else if (check.status === "unverified") {
      reasons.push(
        "[AUTH_WITNESS_UNVERIFIED] requireWitness is set and a witness receipt exists, but no OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY is configured, so the receipt cannot be verified; configure the verify-only witness key or omit requireWitness",
      )
    }
  }
  return reasons
}

/** Every task that must have continuity handoffs (plan first, state as fallback). */
function handoffTaskRefs(plan: any, state: any): HandoffTaskRef[] {
  const refs = new Map<string, HandoffTaskRef>()
  if (Array.isArray(plan?.tasks)) {
    for (const task of plan.tasks) {
      if (typeof task?.id !== "string" || !isSafeTaskId(task.id)) continue
      refs.set(task.id, { id: task.id, agent: typeof task.agent === "string" ? task.agent : "team/worker" })
    }
  }
  if (state?.tasks && typeof state.tasks === "object") {
    for (const id of Object.keys(state.tasks)) {
      if (!isSafeTaskId(id) || refs.has(id)) continue
      refs.set(id, { id, agent: "team/worker" })
    }
  }
  return [...refs.values()]
}

/**
 * Resolve the run's persisted modes and recompute the continuity gate plus the
 * provenance check for every present index entry. Only the manifest pins
 * whether a signature is required; the narrative is never inspected.
 */
async function evaluateHandoffGateCheckedFor(
  run: string,
  plan: any,
  state: any,
  auth: AuthContext | undefined,
  manifest: RunManifest | undefined,
): Promise<HandoffGate> {
  const mode = resolveHandoffMode(plan, state).mode
  // The victory handoff is defined as recorded after teamwork_victory_audit.
  // Until a confirmed verdict exists, the victory gate (not the handoff gate)
  // owns the next action, so it is not counted as missing.
  const victoryConfirmed =
    resolveVictoryAuditMode(plan, state, run).mode === "required" &&
    readVictoryVerdict(run)?.verdict === VICTORY_CONFIRMED
  return evaluateHandoffGateChecked(run, handoffTaskRefs(plan, state), {
    mode,
    strict: resolveVerificationMode(plan, state).mode === "strict",
    victoryAudit: victoryConfirmed,
    auth,
    requireSigned: !!manifest && (manifest.handoffAuth ?? "legacy") === "signed",
    manifestRunKeyId: manifest?.runKeyId,
  })
}

/**
 * Session-tree binding for the control plane: identity comes from the trusted
 * session (`deriveCallerAgent`), and run-bound tools require root/descendant
 * ancestry. Implemented in authorize.ts so every tool shares one rule set.
 */

/** The run's recorded root session (manifest first, then plan/state). */
function recordedRootSessionId(manifest: RunManifest | undefined, plan: any, state: any): string | undefined {
  const candidate = manifest?.rootSessionId ?? plan?.rootSessionId ?? state?.rootSessionId
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined
}

/**
 * Resolve the trusted caller + the run root, then apply the central role map.
 * The `agent` input on a tool is only a recorded label: authorization always
 * uses the session's agent.
 */
async function authorizeToolAction(
  ctx: any,
  run: string | undefined,
  toolName: string,
  action: string | undefined,
  context: any,
  opts: { skipSessionTree?: boolean } = {},
): Promise<{ ok: true; caller: { agent: string; source: "context" | "session" } | undefined; sessionID: string | undefined } | { ok: false; content: string }> {
  const sessionID = typeof context?.sessionID === "string" ? context.sessionID : undefined
  const caller = sessionID ? await deriveCallerAgent(ctx, run ?? "", sessionID, context) : undefined
  let rootSessionId: string | undefined
  if (run && existsSync(run)) {
    const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
    const state = readJson<any>(run, join(run, "state.json"), undefined)
    let manifest: RunManifest | undefined
    try {
      const check = await readRunManifest(run, auth)
      if (check.ok && check.signed) manifest = check.manifest
    } catch {}
    rootSessionId = recordedRootSessionId(manifest, plan, state)
  }
  const decision = await authorizeToolCall(toolName, action, caller?.agent, {
    run,
    rootSessionId,
    sessionID,
    ctx,
    skipSessionTree: opts.skipSessionTree,
  })
  if (!decision.ok) {
    // Keep the human-readable refusal first (callers and tests match on it) and
    // append the machine-readable authorization code the decision already carries.
    return { ok: false, content: `${decision.error} [${decision.code}]` }
  }
  return { ok: true, caller, sessionID }
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
  const persistedPlan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
  const persistedState = readJson<any>(run, join(run, "state.json"), undefined)
  // A3: a follow-up appends to an existing run's request record; it is not a
  // re-plan. This branch runs before topology normalisation, the pinned-write
  // policy and every normal-plan validation, and it reads the persisted
  // plan/state itself, so the documented minimal call
  // (`{ sessionId, followUp }`) is sufficient. It returns before
  // integrity/verification/mode validation so it cannot change tasks, modes,
  // requirements, or the write-once header. Only ORIGINAL_REQUEST.md and the
  // signed manifest's whole-file requestHash move. A sign failure after the
  // append is reported as a refusal (the append is already durable) rather
  // than claiming success.
  if (typeof input.followUp === "string") {
    const originalRequestFile = join(run, "ORIGINAL_REQUEST.md")
    const noRun = "refused: followUp requires an existing run with ORIGINAL_REQUEST.md; nothing was written."
    if (!existsSync(join(run, "plan.dag.json"))) return { ok: false, content: noRun }
    if (!persistedPlan || typeof persistedPlan !== "object" || Array.isArray(persistedPlan)) {
      return {
        ok: false,
        content: `refused: followUp requires a readable ${join(run, "plan.dag.json")}; nothing was written.`,
      }
    }
    const followUpRaw = input.followUp
    if (!followUpRaw.trim()) {
      return { ok: false, content: "refused: followUp must be non-empty; nothing was written." }
    }
    if (followUpRaw.length > REQUEST_MAX) {
      return {
        ok: false,
        content: `refused: followUp is ${followUpRaw.length} chars, over the ${REQUEST_MAX}-char limit; it must be appended verbatim. Shorten it or record it separately. Nothing was written.`,
        refused: "followup_too_long",
      }
    }
    const currentRes = readBoundedRunFile(run, originalRequestFile, MAX_RUN_FILE_BYTES)
    if (currentRes.status !== "ok") return { ok: false, content: noRun }
    const followUpText = followUpRaw.trim()
    const lastSection = /\n## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\n\n([\s\S]*)$/.exec(currentRes.text)
    const persistedTopology = normalizeTopology(persistedPlan.topology) ?? ""
    const persistedIntegrityMode = (normalizeIntegrityMode(persistedPlan.integrityMode) ??
      normalizeIntegrityMode(persistedState?.integrityMode) ??
      DEFAULT_INTEGRITY_MODE) as IntegrityMode
    const followUpResult = () => ({
      ok: true as const,
      sessionId,
      run,
      tasks: Array.isArray(persistedPlan.tasks) ? persistedPlan.tasks : [],
      topology: persistedTopology,
      integrityMode: persistedIntegrityMode,
    })
    if (lastSection && lastSection[2].trim() === followUpText) {
      // Exact duplicate of the last follow-up: leave the file byte-identical so
      // a retried call is idempotent.
      return {
        ...followUpResult(),
        content: "Recorded follow-up: identical to the last follow-up section; nothing was appended (idempotent no-op).",
      }
    }
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    const section = `\n## ${stamp}\n\n${followUpText}\n`
    try {
      appendLineWithin(run, "ORIGINAL_REQUEST.md", () => section, { run })
    } catch (err: any) {
      const message = String(err?.message ?? err)
      return {
        ok: false,
        content: `refused: could not append the follow-up to ${originalRequestFile} (${clean(message, 160)}); nothing was changed.`,
        ...(isUnsafePathError(message) ? { refused: "unsafe_path" } : {}),
      }
    }
    const afterRes = readBoundedRunFile(run, originalRequestFile, MAX_RUN_FILE_BYTES)
    if (afterRes.status !== "ok") {
      return {
        ok: false,
        content: `refused: appended the follow-up to ${originalRequestFile} (the append is durable), but could not re-read it (${clean(afterRes.error, 160)}); the manifest was not re-bound.`,
      }
    }
    let rebound = false
    let signFailure: AuthFailure | undefined
    let signMessage = ""
    if (existingManifest && auth && authReady.ok) {
      try {
        const { _auth: _ignored, ...manifestPayload } = existingManifest as any
        manifestPayload.requestHash = sha256Hex(afterRes.text)
        const signed = await auth.signRunArtifact(sessionId, RUN_MANIFEST, manifestPayload)
        writeJsonSafe(run, runManifestFile(run), signed)
        rebound = true
      } catch (err: any) {
        signFailure = err?.failure as AuthFailure | undefined
        signMessage = clean(err?.message, 160)
      }
    }
    if (signFailure || signMessage !== "") {
      return {
        ok: false,
        content: `refused: recorded the follow-up in ${originalRequestFile} (the append is durable), but could not re-sign ${RUN_MANIFEST} (${signFailure ? signFailure.code : "signing failed"}: ${signMessage}); the manifest requestHash no longer matches. Repair the signer and re-plan before final verification.`,
        refused: signFailure?.code ?? "AUTH_UNAVAILABLE",
      }
    }
    await refreshBriefingSafe(run)
    return {
      ...followUpResult(),
      content: `Recorded follow-up in ${originalRequestFile} (## ${stamp}); ${
        rebound ? "run.manifest.json requestHash re-bound to the new file bytes." : "no signed manifest was re-bound."
      }`,
    }
  }
  // A normal plan (schema `anyOf` branch 1) still requires both fields. This
  // explicit check puts a direct `execute` — which bypasses the Standard
  // Schema — under the same contract with a clear refusal instead of the old
  // `invalid topology ""` symptom.
  if (typeof input.topology !== "string" || input.topology.trim() === "") {
    return {
      ok: false,
      content: `refused: topology must be a non-empty string when followUp is not provided (accepted: ${TOPOLOGIES.join(", ")}). Nothing was written.`,
    }
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return {
      ok: false,
      content: "refused: tasks must be a non-empty array when followUp is not provided. Nothing was written.",
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
  // Fail-closed write policy (ADR 0013). `requirePinnedWrites: true` records
  // that this run only accepts pinned control-plane writes; the writer then
  // refuses by name on macOS/Windows instead of silently accepting a detective
  // write. The assertion is sticky: a re-plan cannot turn it off, and it is
  // registered before the first mkdir so a detective host refuses immediately.
  if (input.requirePinnedWrites !== undefined && typeof input.requirePinnedWrites !== "boolean") {
    return { ok: false, content: "refused: requirePinnedWrites must be a boolean; nothing was written." }
  }
  const persistedRequirePinnedWrites = persistedPlan?.requirePinnedWrites === true
  if (persistedRequirePinnedWrites && input.requirePinnedWrites === false) {
    return {
      ok: false,
      content: "refused: requirePinnedWrites is already persisted for this run and cannot be disabled by a re-plan; start a new session. Nothing was written.",
    }
  }
  const requirePinnedWrites = persistedRequirePinnedWrites || input.requirePinnedWrites === true
  setRunRequirePinnedWrites(run, requirePinnedWrites)
  // D2: opt-in report/head binding. Same sticky rule as requirePinnedWrites: a
  // re-plan may assert it but cannot turn an asserted run back off.
  if (input.requireReportBinding !== undefined && typeof input.requireReportBinding !== "boolean") {
    return { ok: false, content: "refused: requireReportBinding must be a boolean; nothing was written." }
  }
  const persistedRequireReportBinding = persistedPlan?.requireReportBinding === true
  if (persistedRequireReportBinding && input.requireReportBinding === false) {
    return {
      ok: false,
      content: "refused: requireReportBinding is already persisted for this run and cannot be disabled by a re-plan; start a new session. Nothing was written.",
    }
  }
  const requireReportBinding = persistedRequireReportBinding || input.requireReportBinding === true
  // 0.16.0: require re-executable command evidence. Chosen at plan time and
  // sticky: a re-plan may upgrade declared→command, never downgrade it.
  if (input.requiredProvenance !== undefined && normalizeProvenance(input.requiredProvenance) === undefined) {
    return {
      ok: false,
      content: `refused: requiredProvenance must be "declared" or "command" (got "${clean(input.requiredProvenance, 32)}"); nothing was written.`,
    }
  }
  const persistedProvenance =
    normalizeProvenance(persistedPlan?.requiredProvenance) ?? manifestProvenance(existingManifest)
  if (persistedProvenance === "command" && input.requiredProvenance === "declared") {
    return {
      ok: false,
      content:
        'refused: [AUTH_STALE] requiredProvenance is already persisted as "command" for this run and cannot be downgraded by a re-plan; omit it to keep the requirement or start a new session. Nothing was written.',
      refused: "AUTH_STALE",
    }
  }
  const requiredProvenance: ProvenanceMode =
    persistedProvenance === "command" || input.requiredProvenance === "command" ? "command" : "declared"
  // 0.18.0: CI attestation policy. Chosen at plan time and sticky: a re-plan
  // may upgrade off→optional→required, never downgrade. The key id and issuer
  // are part of the same signed baseline.
  if (input.attestationPolicy !== undefined && normalizeAttestationMode(input.attestationPolicy) === undefined) {
    return {
      ok: false,
      content: `refused: attestationPolicy must be "off", "optional" or "required" (got "${clean(input.attestationPolicy, 32)}"); nothing was written.`,
    }
  }
  const persistedAttestationPolicy =
    normalizeAttestationMode(persistedPlan?.attestationPolicy) ?? manifestAttestationMode(existingManifest)
  const requestedAttestationPolicy = normalizeAttestationMode(input.attestationPolicy)
  if (
    requestedAttestationPolicy !== undefined &&
    attestationPolicyRank(requestedAttestationPolicy) < attestationPolicyRank(persistedAttestationPolicy)
  ) {
    return {
      ok: false,
      content: `refused: [AUTH_STALE] attestationPolicy is already persisted as "${persistedAttestationPolicy}" for this run and cannot be downgraded by a re-plan; omit it to keep the requirement or start a new session. Nothing was written.`,
      refused: "AUTH_STALE",
    }
  }
  const attestationPolicy: AttestationPolicyMode =
    requestedAttestationPolicy !== undefined &&
    attestationPolicyRank(requestedAttestationPolicy) > attestationPolicyRank(persistedAttestationPolicy)
      ? requestedAttestationPolicy
      : persistedAttestationPolicy
  const requestedAttestationKeyId =
    input.attestationKeyId === undefined ? undefined : clean(input.attestationKeyId, 128).trim()
  if (requestedAttestationKeyId !== undefined && requestedAttestationKeyId === "") {
    return { ok: false, content: "refused: attestationKeyId must be non-empty when supplied; nothing was written." }
  }
  const persistedAttestationKeyId = existingManifest?.attestationKeyId ?? null
  if (
    persistedAttestationKeyId &&
    requestedAttestationKeyId !== undefined &&
    requestedAttestationKeyId !== persistedAttestationKeyId
  ) {
    return {
      ok: false,
      content: `refused: [AUTH_STALE] attestationKeyId is already pinned as "${persistedAttestationKeyId}" for this run and cannot be changed by a re-plan; omit it to keep the pin or start a new session. Nothing was written.`,
      refused: "AUTH_STALE",
    }
  }
  const envAttestationKeyId =
    attestationKeyIdFromPublicKey(process.env[ENV_ATTESTATION_PUBLIC_KEY], process.env[ENV_ATTESTATION_KEY_ID]) ?? null
  const attestationKeyId = persistedAttestationKeyId ?? requestedAttestationKeyId ?? envAttestationKeyId
  const requestedAttestationIssuer =
    input.attestationIssuer === undefined ? undefined : clean(input.attestationIssuer, 512).trim()
  if (requestedAttestationIssuer !== undefined && requestedAttestationIssuer === "") {
    return { ok: false, content: "refused: attestationIssuer must be non-empty when supplied; nothing was written." }
  }
  const persistedAttestationIssuer = existingManifest?.attestationIssuer ?? null
  if (
    persistedAttestationIssuer &&
    requestedAttestationIssuer !== undefined &&
    requestedAttestationIssuer !== persistedAttestationIssuer
  ) {
    return {
      ok: false,
      content: `refused: [AUTH_STALE] attestationIssuer is already pinned for this run and cannot be changed by a re-plan; omit it to keep the pin or start a new session. Nothing was written.`,
      refused: "AUTH_STALE",
    }
  }
  const attestationIssuer =
    persistedAttestationIssuer ?? requestedAttestationIssuer ?? (String(process.env[ENV_ATTESTATION_ISSUER] ?? "").trim() || null)
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
      // A7: record the toolchain prerequisites at the project root before the
      // refusal, so the operator gets an actionable checklist. Best-effort.
      const prereqWritten = writePrerequisitesSafe(root, lemmaPrerequisitesBody(lemmaProbe))
      return {
        // Preserve the probe payload for the route/tool caller; the plan tool
        // only returns content, but tests inspect the refusal text.
        ok: false,
        content: `${formatMissingToolchainRefusal(lemmaProbe)}${prereqWritten ? `\nPrerequisites recorded at ${join(root, "PREREQUISITES.md")}.` : ""}`,
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
  // Verification mode: strict (the distributed-coding default; one falsifier
  // challenge + one security-auditor audit per task) or standard (the explicit
  // opt-out, and the default for every other topology). It is part of the run's
  // contract, so an invalid value refuses before anything is written and a
  // re-plan may keep or repeat the persisted mode but never change it.
  const requestedVerification =
    input.verification === undefined || input.verification === null
      ? undefined
      : normalizeVerificationMode(input.verification)
  if (input.verification !== undefined && input.verification !== null && !requestedVerification) {
    return {
      ok: false,
      content: `refused: invalid verification "${clean(input.verification, 32)}" (accepted: standard | strict; default: ${topology === "distributed-coding" ? "strict" : DEFAULT_VERIFICATION_MODE}); nothing was written.`,
    }
  }
  let persistedVerification: VerificationMode | undefined
  let persistedHandoffs: HandoffMode | undefined
  let persistedVictorySkipReason: string | undefined
  let persistedVictoryAudit: VictoryAuditMode | undefined
  let persistedTrustLevel: TrustLevel | undefined
  let persistedRequireWitness: boolean | undefined
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
    const fromPlanVictoryRaw = planRes.status === "ok" ? planRes.value?.victoryAudit : undefined
    const fromStateVictoryRaw = stateRes.status === "ok" ? stateRes.value?.victoryAudit : undefined
    const fromPlanVictory =
      fromPlanVictoryRaw === undefined || fromPlanVictoryRaw === null
        ? undefined
        : normalizeVictoryAuditMode(fromPlanVictoryRaw)
    const fromStateVictory =
      fromStateVictoryRaw === undefined || fromStateVictoryRaw === null
        ? undefined
        : normalizeVictoryAuditMode(fromStateVictoryRaw)
    if (
      (fromPlanVictoryRaw !== undefined && fromPlanVictoryRaw !== null && !fromPlanVictory) ||
      (fromStateVictoryRaw !== undefined && fromStateVictoryRaw !== null && !fromStateVictory)
    ) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json or state.json records an invalid victoryAudit mode; repair the run or start a new session. Nothing was written.",
      }
    }
    if (fromPlanVictory && fromStateVictory && fromPlanVictory !== fromStateVictory) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json and state.json disagree about victoryAudit; repair the run or start a new session. Nothing was written.",
      }
    }
    persistedVictoryAudit = fromPlanVictory ?? fromStateVictory
    const fromPlanHandoffsRaw = planRes.status === "ok" ? planRes.value?.requireHandoffs : undefined
    const fromStateHandoffsRaw = stateRes.status === "ok" ? stateRes.value?.requireHandoffs : undefined
    const fromPlanHandoffs =
      fromPlanHandoffsRaw === undefined || fromPlanHandoffsRaw === null
        ? undefined
        : normalizeHandoffMode(fromPlanHandoffsRaw)
    const fromStateHandoffs =
      fromStateHandoffsRaw === undefined || fromStateHandoffsRaw === null
        ? undefined
        : normalizeHandoffMode(fromStateHandoffsRaw)
    if (
      (fromPlanHandoffsRaw !== undefined && fromPlanHandoffsRaw !== null && !fromPlanHandoffs) ||
      (fromStateHandoffsRaw !== undefined && fromStateHandoffsRaw !== null && !fromStateHandoffs)
    ) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json or state.json records an invalid requireHandoffs mode; repair the run or start a new session. Nothing was written.",
      }
    }
    if (fromPlanHandoffs && fromStateHandoffs && fromPlanHandoffs !== fromStateHandoffs) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json and state.json disagree about requireHandoffs; repair the run or start a new session. Nothing was written.",
      }
    }
    persistedHandoffs = fromPlanHandoffs ?? fromStateHandoffs
    persistedVictorySkipReason =
      recordedVictorySkipReason(planRes.status === "ok" ? planRes.value?.victorySkipReason : undefined) ??
      recordedVictorySkipReason(stateRes.status === "ok" ? stateRes.value?.victorySkipReason : undefined)
    const fromPlanTrustRaw = planRes.status === "ok" ? planRes.value?.trustLevel : undefined
    const fromStateTrustRaw = stateRes.status === "ok" ? stateRes.value?.trustLevel : undefined
    const fromPlanTrust =
      fromPlanTrustRaw === undefined || fromPlanTrustRaw === null ? undefined : normalizeTrustLevel(fromPlanTrustRaw)
    const fromStateTrust =
      fromStateTrustRaw === undefined || fromStateTrustRaw === null ? undefined : normalizeTrustLevel(fromStateTrustRaw)
    if (
      (fromPlanTrustRaw !== undefined && fromPlanTrustRaw !== null && !fromPlanTrust) ||
      (fromStateTrustRaw !== undefined && fromStateTrustRaw !== null && !fromStateTrust)
    ) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json or state.json records an invalid trustLevel; repair the run or start a new session. Nothing was written.",
      }
    }
    if (fromPlanTrust && fromStateTrust && fromPlanTrust !== fromStateTrust) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json and state.json disagree about trustLevel; repair the run or start a new session. Nothing was written.",
      }
    }
    persistedTrustLevel = fromPlanTrust ?? fromStateTrust
    const fromPlanWitnessRaw = planRes.status === "ok" ? planRes.value?.requireWitness : undefined
    const fromStateWitnessRaw = stateRes.status === "ok" ? stateRes.value?.requireWitness : undefined
    if (
      (fromPlanWitnessRaw !== undefined && typeof fromPlanWitnessRaw !== "boolean") ||
      (fromStateWitnessRaw !== undefined && typeof fromStateWitnessRaw !== "boolean")
    ) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json or state.json records an invalid requireWitness; repair the run or start a new session. Nothing was written.",
      }
    }
    if (
      typeof fromPlanWitnessRaw === "boolean" &&
      typeof fromStateWitnessRaw === "boolean" &&
      fromPlanWitnessRaw !== fromStateWitnessRaw
    ) {
      return {
        ok: false,
        content:
          "refused: plan.dag.json and state.json disagree about requireWitness; repair the run or start a new session. Nothing was written.",
      }
    }
    persistedRequireWitness =
      typeof fromPlanWitnessRaw === "boolean"
        ? fromPlanWitnessRaw
        : typeof fromStateWitnessRaw === "boolean"
          ? fromStateWitnessRaw
          : undefined
  }
  if (persistedVerification && requestedVerification && persistedVerification !== requestedVerification) {
    return {
      ok: false,
      content: `refused: verification is already persisted as "${persistedVerification}" for this run and cannot be changed by a re-plan; omit it to keep the mode or start a new session. Nothing was written.`,
    }
  }
  // A6: distributed-coding defaults to the strict wave (reviewer + falsifier
  // challenger + security-auditor forensic auditor). An explicit "standard" is
  // a recorded opt-out; every other topology keeps the historical default.
  const defaultVerification: VerificationMode =
    topology === "distributed-coding" ? "strict" : DEFAULT_VERIFICATION_MODE
  const verificationMode: VerificationMode =
    persistedVerification ?? requestedVerification ?? defaultVerification
  // Artifact trust level: chosen once at plan time, persisted in plan/state and
  // the signed manifest, and enforced by final_verify. A re-plan may repeat it
  // but never change it.
  const requestedTrustLevel =
    input.trustLevel === undefined || input.trustLevel === null ? undefined : normalizeTrustLevel(input.trustLevel)
  if (input.trustLevel !== undefined && input.trustLevel !== null && !requestedTrustLevel) {
    return {
      ok: false,
      content: `refused: invalid trustLevel "${clean(input.trustLevel, 32)}" (accepted: ${TRUST_LEVELS.join(", ")}; default: ${DEFAULT_TRUST_LEVEL}); nothing was written.`,
    }
  }
  if (persistedTrustLevel && requestedTrustLevel && persistedTrustLevel !== requestedTrustLevel) {
    return {
      ok: false,
      content: `refused: [AUTH_STALE] trustLevel is already persisted as "${persistedTrustLevel}" for this run and cannot be changed by a re-plan; omit it to keep the level or start a new session. Nothing was written.`,
      refused: "AUTH_STALE",
    }
  }
  const trustLevel: TrustLevel = persistedTrustLevel ?? requestedTrustLevel ?? DEFAULT_TRUST_LEVEL
  if (input.requireWitness !== undefined && typeof input.requireWitness !== "boolean") {
    return { ok: false, content: "refused: requireWitness must be a boolean; nothing was written." }
  }
  if (
    persistedRequireWitness !== undefined &&
    typeof input.requireWitness === "boolean" &&
    persistedRequireWitness !== input.requireWitness
  ) {
    return {
      ok: false,
      content: `refused: [AUTH_STALE] requireWitness is already persisted as ${persistedRequireWitness} for this run and cannot be changed by a re-plan; omit it to keep the setting or start a new session. Nothing was written.`,
      refused: "AUTH_STALE",
    }
  }
  const requireWitness = persistedRequireWitness ?? input.requireWitness === true
  // `external-signer` needs a source that actually produces an Ed25519
  // envelope. A local HMAC key cannot be promoted by a label. An external
  // signer that is configured but broken is reported as AUTH_SIGNER_UNAVAILABLE
  // by ready()/signing below.
  if (trustLevel === "external-signer" && auth) {
    const signingAlg = auth.signingAlg()
    if (signingAlg !== "ed25519") {
      return {
        ok: false,
        content:
          "refused: [AUTH_SIGNER_UNAVAILABLE] trustLevel \"external-signer\" requires an Ed25519 key or an OPENCODE_TEAMWORK_SIGNER=command:<path> signer; only a local HMAC key is configured. Nothing was written.",
        refused: "AUTH_SIGNER_UNAVAILABLE",
      }
    }
  }
  // Human/CI approval prerequisites are checked before any mkdir/state write,
  // so a refused plan leaves no run directory. A version 1 manifest is a
  // pre-0.10.2 run and keeps its in-run legacy approval path.
  const manifestVersionBase = existingManifest?.version ?? RUN_MANIFEST_VERSION
  if (requiredProvenance === "command" && manifestVersionBase < COMMAND_PROVENANCE_MIN_VERSION && manifestVersionBase < 3) {
    return {
      ok: false,
      content:
        'refused: requiredProvenance "command" needs a 0.11+ (version 3) run; this legacy manifest cannot be upgraded safely. Start a new session. Nothing was written.',
      refused: "AUTH_STALE",
    }
  }
  const manifestVersion =
    attestationPolicy !== "off"
      ? Math.max(manifestVersionBase, ATTESTATION_MIN_VERSION)
      : requiredProvenance === "command" && manifestVersionBase < COMMAND_PROVENANCE_MIN_VERSION
        ? COMMAND_PROVENANCE_MIN_VERSION
        : manifestVersionBase
  const approvalPrereq = checkApprovalPrerequisites(root, run, trustLevel, manifestVersion, process.env)
  if (!approvalPrereq.ok) {
    return {
      ok: false,
      content: `refused: [${approvalPrereq.code}] ${approvalPrereq.message}. Nothing was written.`,
      refused: approvalPrereq.code,
    }
  }
  // The request record is verbatim, so refuse rather than truncate. The
  // length check runs before anything is written. A leading `[skip-interview]`
  // is a launch parameter: it is stripped from the recorded body and acts as an
  // explicit spec-gate bypass.
  const launch = parseTeamworkLaunch(input.request)
  const request = typeof input.request === "string" ? launch.text : undefined
  const effectiveSkipInterview = input.skipInterview === true || launch.skipInterview
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
    if (persistedVictoryAudit && persistedVictoryAudit !== requestedMode) {
      return {
        ok: false,
        content: `refused: victoryAudit is already persisted as "${persistedVictoryAudit}" for this run and cannot be changed by a re-plan; omit it to keep the mode or start a new session. Nothing was written.`,
      }
    }
    victoryAuditMode = requestedMode
    victoryAuditSource = "caller"
  } else if (persistedVictoryAudit) {
    victoryAuditMode = persistedVictoryAudit
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
  // unsigned and it refuses the victory-audit skip. The refusal is repeated on
  // every tool that accepts `allowUnsignedLegacy` (plan/next/final_verify), not
  // only at creation: a run whose persisted contract is benchmark cannot be
  // downgraded by a later bypass.
  const persistedIntegrityModeForBypass =
    normalizeIntegrityMode(persistedPlan?.integrityMode) ??
    normalizeIntegrityMode(persistedState?.integrityMode) ??
    readIntegrityMode(run).mode
  if (allowUnsignedLegacy && (integrityMode === "benchmark" || persistedIntegrityModeForBypass === "benchmark")) {
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
  // Benchmark is the strictest integrity contract. An explicit local-HMAC trust
  // level is refused; the default only warns, so existing benchmark fixtures
  // remain valid while the downgrade stays visible.
  if (integrityMode === "benchmark" && trustLevel === "local-hmac" && requestedTrustLevel === "local-hmac") {
    return {
      ok: false,
      content:
        "refused: [AUTH_TRUST_LEVEL] benchmark mode refuses an explicit trustLevel \"local-hmac\"; use external-signer, human-approved, or ci-attested (or omit trustLevel for the documented local-hmac default). Nothing was written.",
      refused: "AUTH_TRUST_LEVEL",
    }
  }
  const benchmarkTrustWarning =
    integrityMode === "benchmark" && trustLevel === "local-hmac"
      ? "\n⚠ Benchmark integrity with trustLevel local-hmac: verdicts are tamper-evident only against a run-dir-only writer; a same-UID shell can mint HMAC envelopes."
      : ""
  // An explicit skip is a recorded completion bypass and must carry a reason.
  // The reason is part of the signed baseline: a re-plan may repeat it, never
  // change it. The legacy no-baseline default skip is exempt (it cannot carry
  // an invented reason); it is labelled separately by final_verify/export.
  let victorySkipReason: string | undefined
  const requestedSkipReason = input.victorySkipReason
  if (victoryAuditMode === "skip") {
    if (requestedSkipReason !== undefined && requestedSkipReason !== null) {
      const reasonCheck = validateVictorySkipReason(requestedSkipReason)
      if (!reasonCheck.ok) return { ok: false, content: `${reasonCheck.error}; nothing was written.` }
      if (persistedVictorySkipReason && persistedVictorySkipReason !== reasonCheck.reason) {
        return {
          ok: false,
          content: `refused: [AUTH_STALE] victorySkipReason is already persisted for this run and cannot be changed by a re-plan; omit it to keep the recorded reason or start a new session. Nothing was written.`,
          refused: "AUTH_STALE",
        }
      }
      victorySkipReason = reasonCheck.reason
    } else {
      victorySkipReason = persistedVictorySkipReason
    }
    if (!victorySkipReason && victoryAuditSource === "caller") {
      return {
        ok: false,
        content:
          "refused: victoryAudit: \"skip\" requires a non-empty victorySkipReason (max 500 chars) recording why the independent victory audit is bypassed. Nothing was written.",
      }
    }
  } else if (typeof requestedSkipReason === "string" && requestedSkipReason.trim() !== "") {
    return {
      ok: false,
      content:
        "refused: victorySkipReason is only valid with victoryAudit: \"skip\"; nothing was written.",
    }
  }
  // Continuity handoff gate: required by default when the run records a
  // request/requirements baseline. An unsigned legacy baseline cannot require
  // it (recorded as skip), and benchmark mode never permits the skip.
  const requestedHandoffs =
    input.requireHandoffs === undefined || input.requireHandoffs === null
      ? undefined
      : normalizeHandoffMode(input.requireHandoffs)
  if (input.requireHandoffs !== undefined && input.requireHandoffs !== null && !requestedHandoffs) {
    return {
      ok: false,
      content: `refused: invalid requireHandoffs "${clean(input.requireHandoffs, 32)}" (accepted: required | skip); nothing was written.`,
    }
  }
  if (persistedHandoffs && requestedHandoffs && persistedHandoffs !== requestedHandoffs) {
    return {
      ok: false,
      content: `refused: requireHandoffs is already persisted as "${persistedHandoffs}" for this run and cannot be changed by a re-plan; omit it to keep the mode or start a new session. Nothing was written.`,
    }
  }
  let requireHandoffsMode: HandoffMode =
    persistedHandoffs ?? requestedHandoffs ?? (runHasPlan ? "skip" : requirementsBaseline ? "required" : "skip")
  let requireHandoffsSource: "caller" | "default" | "legacy" | "unsigned" =
    persistedHandoffs ? "default" : requestedHandoffs ? "caller" : runHasPlan ? "legacy" : "default"
  if (requireHandoffsMode === "required" && !existingManifest && allowUnsignedLegacy) {
    // A run that cannot be signed cannot satisfy the signed continuity
    // baseline; the baseline records the effective skip explicitly.
    requireHandoffsMode = "skip"
    requireHandoffsSource = "unsigned"
  }
  if (integrityMode === "benchmark" && requireHandoffsMode === "skip") {
    return {
      ok: false,
      content:
        "refused: benchmark mode requires the continuity handoff gate; requireHandoffs: \"skip\" is not permitted with integrityMode: \"benchmark\". Nothing was written.",
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
    const baselineReason = recordedVictorySkipReason(existingManifest.victorySkipReason) ?? ""
    if (baselineReason !== (victorySkipReason ?? "")) {
      modeDrift.push(`victorySkipReason (${baselineReason || "none"} -> ${victorySkipReason || "none"})`)
    }
    const baselineHandoffs = normalizeHandoffMode(existingManifest.requireHandoffs) ?? "skip"
    if (baselineHandoffs !== requireHandoffsMode) {
      modeDrift.push(`requireHandoffs (${baselineHandoffs} -> ${requireHandoffsMode})`)
    }
    const baselineTrust = normalizeTrustLevel(existingManifest.trustLevel) ?? DEFAULT_TRUST_LEVEL
    if (baselineTrust !== trustLevel) {
      modeDrift.push(`trustLevel (${baselineTrust} -> ${trustLevel})`)
    }
    const baselineWitness = existingManifest.requireWitness === true
    if (baselineWitness !== requireWitness) {
      modeDrift.push(`requireWitness (${baselineWitness} -> ${requireWitness})`)
    }
    if (manifestProvenance(existingManifest) === "command" && requiredProvenance !== "command") {
      modeDrift.push(`requiredProvenance (command -> ${requiredProvenance})`)
    }
    if (modeDrift.length > 0) {
      return {
        ok: false,
        content: `refused: [AUTH_STALE] a re-plan cannot change the signed baseline (${modeDrift.join(", ")}); omit the mode to keep it or start a new session. Nothing was written.`,
        refused: "AUTH_STALE",
      }
    }
  } else if (runHasPlan && persistedPlan) {
    // Residual review finding: an unsigned legacy run has no signed manifest,
    // so there is no drift baseline above. Compare the persisted plan contract
    // directly instead of letting a re-plan move topology (and with it the
    // small-focused 2-audit cap) or a verification/trust mode. Only fields the
    // baseline actually records are compared, so a same-mode re-plan and a
    // pre-0.10 legacy plan stay legal.
    const baselineTopology = normalizeTopology(persistedPlan.topology)
    const baselineIntegrity =
      persistedPlan.integrityMode === undefined || persistedPlan.integrityMode === null
        ? undefined
        : normalizeIntegrityMode(persistedPlan.integrityMode)
    const baselineVerification =
      persistedPlan.verification === undefined || persistedPlan.verification === null
        ? undefined
        : normalizeVerificationMode(persistedPlan.verification)
    const baselineVictory =
      persistedPlan.victoryAudit === undefined || persistedPlan.victoryAudit === null
        ? undefined
        : normalizeVictoryAuditMode(persistedPlan.victoryAudit)
    const baselineHandoffs =
      persistedPlan.requireHandoffs === undefined || persistedPlan.requireHandoffs === null
        ? undefined
        : normalizeHandoffMode(persistedPlan.requireHandoffs)
    const baselineTrust =
      persistedPlan.trustLevel === undefined || persistedPlan.trustLevel === null
        ? undefined
        : normalizeTrustLevel(persistedPlan.trustLevel)
    const modeDrift: string[] = []
    if (baselineTopology && baselineTopology !== topology) {
      modeDrift.push(`topology (${baselineTopology} -> ${topology})`)
    }
    if (baselineIntegrity && baselineIntegrity !== integrityMode) {
      modeDrift.push(`integrityMode (${baselineIntegrity} -> ${integrityMode})`)
    }
    if (baselineVerification && baselineVerification !== verificationMode) {
      modeDrift.push(`verification (${baselineVerification} -> ${verificationMode})`)
    }
    if (baselineVictory && baselineVictory !== victoryAuditMode) {
      modeDrift.push(`victoryAudit (${baselineVictory} -> ${victoryAuditMode})`)
    }
    if (baselineHandoffs && baselineHandoffs !== requireHandoffsMode) {
      modeDrift.push(`requireHandoffs (${baselineHandoffs} -> ${requireHandoffsMode})`)
    }
    if (baselineTrust && baselineTrust !== trustLevel) {
      modeDrift.push(`trustLevel (${baselineTrust} -> ${trustLevel})`)
    }
    if (modeDrift.length > 0) {
      return {
        ok: false,
        content: `refused: [AUTH_STALE] an unsigned legacy re-plan cannot change the persisted plan baseline (${modeDrift.join(", ")}); omit the mode to keep it or start a new session. Nothing was written.`,
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
    input.requireSpec === false ? "not_required" : hasSpec ? "satisfied" : effectiveSkipInterview ? "bypassed" : undefined
  if (!specGate) {
    return {
      ok: false,
      content: `refused: no spec found for this run (expected ${specFile}). Run /teamwork-craft to produce one, or re-call with skipInterview: true to proceed without an approved prompt.`,
    }
  }
  // 0.11.0: a human/CI approval is bound to the exact prompt-draft bytes. This
  // runs before any mkdir/preflight/beforeMkdir work, so a refusal writes
  // nothing. Version 1/2 re-plans keep their historical semantics; only a new
  // version-3 plan enforces the prompt binding.
  let planApproval: PlanApprovalSummary | undefined
  const promptBoundApproval =
    manifestVersion >= APPROVAL_PROMPT_MIN_VERSION && requiresApproval(trustLevel)
  if (promptBoundApproval) {
    const approvalCheck = await verifyPlanApproval(
      run,
      sessionId,
      trustLevel,
      authReady.ok ? authReady.keyId : undefined,
      existingManifest?.planHash ?? null,
      auth,
      root,
      process.env,
    )
    if (!approvalCheck.ok) {
      return {
        ok: false,
        content: `refused: [${approvalCheck.code}] ${approvalCheck.message}. Nothing was written.`,
        refused: approvalCheck.code,
      }
    }
    planApproval = approvalCheck.summary
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
      // A7: the refusal is recorded as a root PREREQUISITES.md so the operator
      // has an actionable checklist. The status is the worst blocking verdict:
      // OUTAGE means an installed dependency is unusable; MISSING means absent.
      const preflightStatus: "MISSING" | "OUTAGE" = blockingProblems.some((i) => i.status === "OUTAGE")
        ? "OUTAGE"
        : "MISSING"
      const prereqWritten = writePrerequisitesSafe(
        root,
        prerequisitesBody(
          preflightStatus,
          `${blockingProblems.length} required input(s) are missing or unreachable`,
          blockingProblems.map((i) => `- ${i.status} \`${clean(i.value, 300)}\`${i.detail ? ` (${clean(i.detail, 300)})` : ""}`),
          [
            "Create or restore the missing path(s) and re-run teamwork_plan",
            "Or re-call with allowMissingInputs: true to proceed and record the bypass",
          ],
          blockingProblems.map((i) => `${i.status} ${i.value}`).join("; "),
        ),
      )
      return {
        ok: false,
        content: [
          `refused: ${blockingProblems.length} required input(s) are missing or unreachable; no run directory or plan artifact was created.`,
          ...blockingProblems.map((i) => `  ${i.status} ${i.value}${i.detail ? ` (${i.detail})` : ""}`),
          "Fix the paths/URLs, or re-call with allowMissingInputs: true to proceed and record the bypass.",
          ...(prereqWritten ? [`Prerequisites recorded at ${join(root, "PREREQUISITES.md")}.`] : []),
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
  // The exact draft bytes are the plan baseline for a version-3 manifest. A
  // draft that exists is hashed even without an approval, so editing it after
  // the plan is AUTH_STALE rather than a silent spec swap.
  const specBuffer =
    specRead.status === "ok" ? (specRead.bytes ?? Buffer.from(specRead.text, "utf8")) : undefined
  const baselineSpecHash = manifestVersion >= APPROVAL_PROMPT_MIN_VERSION && specBuffer ? contentSha256Hex(specBuffer) : null
  const baselineSpecBytes = manifestVersion >= APPROVAL_PROMPT_MIN_VERSION && specBuffer ? specBuffer.length : null
  // Consume the one-use approval nonce only after every refusal path above has
  // passed. The planHash is filled in once the plan object exists (same nonce).
  if (planApproval) {
    const consumed = await consumeApprovalNonce(ctx, sessionId, {
      approvalNonce: planApproval.approvalNonce,
      approvalDigest: planApproval.approvalDigest,
      planHash: null,
    })
    if (!consumed.ok) {
      return {
        ok: false,
        content: `refused: ${authFailureText(consumed.failure)}. Nothing was written.`,
        refused: consumed.failure.code,
      }
    }
  }

  mkdirSync(run, { recursive: true })
  // The request record goes first: it is the artifact the auditor and the
  // final gate read the integrity mode from.
  if (request !== undefined) {
    const refused = writeOriginalRequest(run, request, integrityMode, sessionId, {
      skipInterview: effectiveSkipInterview,
      ...(launch.ignoredBracket ? { ignoredBracket: launch.ignoredBracket } : {}),
    })
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
  // Provenance: who planned the run. The first plan wins on a re-plan, so a
  // later caller cannot rewrite the recorded plan-time identity.
  const planCaller = await deriveCallerAgent(ctx, run, callSession, context)
  const planAgent = existingManifest?.planAgent ?? planCaller?.agent ?? null
  // A4: maxRounds is a bounded integer. small-focused is a refinement loop (up
  // to 32 rounds), not a one-shot; any topology may lower it, but nothing may
  // raise it above 32 or sneak in a fractional/negative value.
  const clampMaxRounds = (value: unknown, fallback = 4): number => {
    const raw = Number(value)
    if (!Number.isFinite(raw)) return fallback
    return Math.min(32, Math.max(1, Math.trunc(raw)))
  }
  const tasks = (input.tasks || []).map((t: any) => ({
    id: clean(t.id, 64),
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((d: any) => clean(d, 64)) : [],
    requirements: Array.isArray(t.requirements) ? t.requirements.map((r: any) => clean(r, 120)) : [],
    agent: clean(t.agent || "team/worker", 64),
    status: "pending",
    round: 0,
    maxRounds: clampMaxRounds(t.maxRounds, 4),
  }))
  const routingReason = typeof input.routingReason === "string" ? clean(input.routingReason, 200).trim() : ""
  // Claim protocol baseline (0.10.0). A brand-new run records protocol 2, its
  // lease, host and lock-storage diagnostics. A re-plan of a legacy run leaves
  // an absent claimProtocol alone, so that run keeps behaving exactly as 0.9.0.
  const existingStateForClaims = readJson<any>(run, join(run, "state.json"), undefined)
  const clampLease = (value: unknown): number => {
    const raw = Number(value)
    if (!Number.isFinite(raw)) return DEFAULT_CLAIM_LEASE_MS
    return Math.min(MAX_CLAIM_LEASE_MS, Math.max(MIN_CLAIM_LEASE_MS, Math.trunc(raw)))
  }
  const persistedLease = Number(existingStateForClaims?.claimLeaseMs)
  const claimLeaseMs =
    input.claimLeaseMs !== undefined && input.claimLeaseMs !== null
      ? clampLease(input.claimLeaseMs)
      : Number.isFinite(persistedLease)
        ? clampLease(persistedLease)
        : DEFAULT_CLAIM_LEASE_MS
  const requireSameHost = input.requireSameHost === true || existingStateForClaims?.requireSameHost === true
  const planHost =
    typeof existingStateForClaims?.host === "string" && existingStateForClaims.host.trim()
      ? clean(existingStateForClaims.host, 80).trim()
      : SELF_HOST
  const claimStorage = {
    lockProtocol: "atomic-link",
    fallback: "mkdir",
    hardlinkSupport: "auto",
    diagnostics: recentLockDiagnostics(5),
  }
  const planObject = {
    sessionId,
    rootSessionId,
    ...(planAgent ? { planAgent } : {}),
    topology,
    integrityMode,
    verification: verificationMode,
    victoryAudit: victoryAuditMode,
    victoryAuditSource,
    trustLevel,
    requireWitness,
    ...(victorySkipReason ? { victorySkipReason } : {}),
    requireHandoffs: requireHandoffsMode,
    requireHandoffsSource,
    ...(requirePinnedWrites ? { requirePinnedWrites: true } : {}),
    ...(requireReportBinding ? { requireReportBinding: true } : {}),
    ...(requiredProvenance === "command" ? { requiredProvenance: "command" as const } : {}),
    ...(manifestVersion >= ATTESTATION_MIN_VERSION
      ? {
          attestationPolicy,
          ...(attestationKeyId ? { attestationKeyId } : {}),
          ...(attestationIssuer ? { attestationIssuer } : {}),
        }
      : {}),
    claimProtocol: CLAIM_PROTOCOL,
    claimLeaseMs,
    host: planHost,
    storage: claimStorage,
    ...(requireSameHost ? { requireSameHost: true } : {}),
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
  // The signed-baseline drift check runs BEFORE the approval nonce is consumed
  // and before any run file is created. A refused re-plan must not rewrite
  // plan.dag.json (a changed topology would otherwise move the 2-audit cap or
  // the verification mode after the caller was told "nothing was written").
  const driftRequestHash = originalRequestHash(run)
  const driftRequirementsHash = requirementsBaseline
    ? sha256Hex(canonicalJson(requirementsBaseline))
    : currentRequirementsHash(run)
  const driftPlanHash = planHashOf(planObject)
  const driftLemmaPolicyHash = lemmaPolicyHashOf(run)
  if (existingManifest) {
    const drift = manifestDrift(existingManifest, {
      integrityMode,
      verification: verificationMode,
      victoryAudit: victoryAuditMode,
      victorySkipReason,
      requireHandoffs: requireHandoffsMode,
      trustLevel,
      requireWitness,
      approvalPolicy: approvalPrereq.approvalPolicy,
      approvalKeyId:
        manifestVersion < APPROVAL_EXTERNAL_MIN_VERSION
          ? existingManifest?.approvalKeyId ?? null
          : approvalPrereq.approvalKeyId,
      handoffAuth: allowUnsignedLegacy ? "legacy" : "signed",
      requiredProvenance,
      attestationPolicy: manifestVersion >= ATTESTATION_MIN_VERSION ? attestationPolicy : "off",
      attestationKeyId: manifestVersion >= ATTESTATION_MIN_VERSION ? attestationKeyId : null,
      attestationIssuer: manifestVersion >= ATTESTATION_MIN_VERSION ? attestationIssuer : null,
      requestHash: driftRequestHash,
      requirementsHash: driftRequirementsHash,
      planHash: driftPlanHash,
      lemmaPolicyHash: driftLemmaPolicyHash,
      ...(manifestVersion >= APPROVAL_PROMPT_MIN_VERSION
        ? {
            specHash: planApproval?.specHash ?? baselineSpecHash,
            specBytes: planApproval?.specBytes ?? baselineSpecBytes,
            approvalDigest: planApproval?.approvalDigest ?? null,
            approvalNonce: planApproval?.approvalNonce ?? null,
            approvalBinding: planApproval ? ("prompt" as const) : undefined,
            approvedBy: planApproval?.approver ?? null,
            approvedAt: planApproval?.approvedAt ?? null,
          }
        : {}),
    })
    if (drift.length > 0) {
      return {
        ok: false,
        content: `refused: [AUTH_STALE] a re-plan must preserve the signed baseline; ${drift.join("; ")}. Nothing was written.`,
        refused: "AUTH_STALE",
      }
    }
  }
  if (planApproval) {
    // Record the consumed nonce's plan hash now that the plan baseline exists.
    await consumeApprovalNonce(ctx, sessionId, {
      approvalNonce: planApproval.approvalNonce,
      approvalDigest: planApproval.approvalDigest,
      planHash: planHashOf(planObject),
    })
  }
  // Pre-create the known run subdirectories (attack-surface reduction; every
  // later write still pins and validates its own parent).
  precreateRunDirs(
    run,
    tasks.map((t: any) => t.id),
  )
  // A5: a distributed-coding run starts with the survey artifacts as
  // create-only stubs (never TEST_READY.md — that is the Dual-Track gate).
  if (topology === "distributed-coding") writeSurveyStubsSafe(run, tasks)
  writeJson(run, join(run, "plan.dag.json"), planObject)
  const planStateFile = join(run, "state.json")
  if (!existsSync(planStateFile)) {
    await withPinnedCrossProcessLock(run, runRel(run, planStateFile), async () => {
      if (existsSync(planStateFile)) return
      writeJson(run, planStateFile, {
        version: 1,
        sessionId,
        rootSessionId,
        integrityMode,
        verification: verificationMode,
        victoryAudit: victoryAuditMode,
        trustLevel,
        requireWitness,
        ...(victorySkipReason ? { victorySkipReason } : {}),
        requireHandoffs: requireHandoffsMode,
        ...(requirePinnedWrites ? { requirePinnedWrites: true } : {}),
        ...(requireReportBinding ? { requireReportBinding: true } : {}),
        ...(requiredProvenance === "command" ? { requiredProvenance: "command" as const } : {}),
        ...(manifestVersion >= ATTESTATION_MIN_VERSION
          ? {
              attestationPolicy,
              ...(attestationKeyId ? { attestationKeyId } : {}),
              ...(attestationIssuer ? { attestationIssuer } : {}),
            }
          : {}),
        claimProtocol: CLAIM_PROTOCOL,
        claimLeaseMs,
        host: planHost,
        storage: claimStorage,
        ...(requireSameHost ? { requireSameHost: true } : {}),
        ...(allowUnsignedLegacy ? { allowUnsignedLegacy: true } : {}),
        ...(isLemma ? { lemmaMode: true, route: "lemma" } : {}),
        phase: "DISPATCH",
        tasks: nullMap(Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }]))),
        updatedAt: new Date().toISOString(),
      })
    })
  } else {
    // A re-plan keeps the run's checkpoint but must still carry the mode
    // the caller chose (defaults to development when omitted).
    let changed = false
    await mutateRunState(
      run,
      (state) => {
        if (
          state &&
          (state.integrityMode !== integrityMode ||
            state.verification !== verificationMode ||
            state.victoryAudit !== victoryAuditMode ||
            state.trustLevel !== trustLevel ||
            state.requireWitness !== requireWitness ||
            state.victorySkipReason !== victorySkipReason ||
            state.requireHandoffs !== requireHandoffsMode ||
            (requirePinnedWrites && state.requirePinnedWrites !== true) ||
            (requireReportBinding && state.requireReportBinding !== true) ||
            (requiredProvenance === "command" && state.requiredProvenance !== "command") ||
            (manifestVersion >= ATTESTATION_MIN_VERSION &&
              (state.attestationPolicy !== attestationPolicy ||
                (attestationKeyId && state.attestationKeyId !== attestationKeyId) ||
                (attestationIssuer && state.attestationIssuer !== attestationIssuer))) ||
            state.rootSessionId !== rootSessionId ||
            (allowUnsignedLegacy && state.allowUnsignedLegacy !== true) ||
            (state.claimProtocol >= CLAIM_PROTOCOL &&
              (state.claimLeaseMs !== claimLeaseMs || state.host !== planHost || (requireSameHost && state.requireSameHost !== true))) ||
            (isLemma && !state.lemmaMode))
        ) {
          state.integrityMode = integrityMode
          state.verification = verificationMode
          state.victoryAudit = victoryAuditMode
          state.trustLevel = trustLevel
          state.requireWitness = requireWitness
          if (victorySkipReason) state.victorySkipReason = victorySkipReason
          else delete state.victorySkipReason
          state.requireHandoffs = requireHandoffsMode
          if (requirePinnedWrites) state.requirePinnedWrites = true
          if (requireReportBinding) state.requireReportBinding = true
          if (requiredProvenance === "command") state.requiredProvenance = "command"
          if (manifestVersion >= ATTESTATION_MIN_VERSION) {
            state.attestationPolicy = attestationPolicy
            if (attestationKeyId) state.attestationKeyId = attestationKeyId
            if (attestationIssuer) state.attestationIssuer = attestationIssuer
          }
          state.rootSessionId = rootSessionId
          if (allowUnsignedLegacy) state.allowUnsignedLegacy = true
          if (state.claimProtocol >= CLAIM_PROTOCOL) {
            state.claimLeaseMs = claimLeaseMs
            state.host = planHost
            if (requireSameHost) state.requireSameHost = true
          }
          if (isLemma) {
            state.lemmaMode = true
            state.route = "lemma"
          }
          changed = true
        }
      },
      { write: () => changed },
    )
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
      // A new signed run gets a fresh 128-bit nonce. A re-plan reuses the
      // manifest's nonce; an older manifest without one stays legacy-shaped.
      const runNonce = existingManifest
        ? existingManifest.runNonce
        : randomBytes(16).toString("base64url")
      if (runNonce) {
        const bound = await auth.bindRunNonce(sessionId, runNonce)
        if (!bound.ok) throw new AuthError(bound.failure)
      }
      const boundKey = await auth.bindRunKeyId(sessionId, authReady.keyId)
      if (!boundKey.ok) throw new AuthError(boundKey.failure)
      // ADR 0013: record the run-root identity inside the signed manifest. The
      // identity is read from the directory itself (not caller input) and used
      // by assertRunRootIdentity before every control-plane write.
      let runRootIdentity: { dev: number; ino: number } | undefined
      try {
        const rootStat = lstatSync(run)
        if (!rootStat.isSymbolicLink() && rootStat.dev !== 0 && rootStat.ino !== 0) {
          runRootIdentity = { dev: rootStat.dev, ino: rootStat.ino }
        }
      } catch {}
      const manifest: RunManifest = {
        version: manifestVersion,
        sessionId,
        rootSessionId,
        ...(planAgent ? { planAgent } : {}),
        integrityMode,
        verification: verificationMode,
        victoryAudit: victoryAuditMode,
        trustLevel,
        requireWitness,
        approvalPolicy: approvalPrereq.approvalPolicy,
        approvalKeyId:
          manifestVersion < APPROVAL_EXTERNAL_MIN_VERSION
            ? existingManifest?.approvalKeyId ?? null
            : approvalPrereq.approvalKeyId,
        ...(victorySkipReason ? { victorySkipReason } : {}),
        requireHandoffs: requireHandoffsMode,
        ...(runNonce ? { runNonce } : {}),
        handoffAuth: allowUnsignedLegacy ? "legacy" : "signed",
        ...(manifestVersion >= COMMAND_PROVENANCE_MIN_VERSION ? { requiredProvenance } : {}),
        ...(manifestVersion >= ATTESTATION_MIN_VERSION
          ? {
              attestationPolicy,
              attestationKeyId,
              attestationIssuer,
            }
          : {}),
        requestHash: baselineRequestHash,
        requirementsHash: baselineRequirementsHash,
        planHash: baselinePlanHash,
        lemmaPolicyHash: baselineLemmaPolicyHash,
        ...(manifestVersion >= APPROVAL_PROMPT_MIN_VERSION
          ? {
              specHash: planApproval ? planApproval.specHash : baselineSpecHash,
              specBytes: planApproval ? planApproval.specBytes : baselineSpecBytes,
            }
          : {}),
        ...(planApproval
          ? {
              approvalDigest: planApproval.approvalDigest,
              approvalNonce: planApproval.approvalNonce,
              approvalBinding: "prompt" as const,
              approvedBy: planApproval.approver,
              approvedAt: planApproval.approvedAt,
            }
          : {}),
        runKeyId: authReady.keyId,
        ...(runRootIdentity ? { runRootIdentity } : {}),
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
  await withPinnedCrossProcessLock(run, runRel(run, costsFile), async () => {
    const existing = readJson<any>(run, costsFile, undefined)
    if (!existing) {
      writeJson(run, costsFile, {
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
      writeJson(run, costsFile, existing)
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
    writeSnapshots(run, join(run, "snapshots.json"), snaps)
  })
  touchRun(run, "pitfalls.md", "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
  if (validatedTournamentConfig && tournamentEstimate) {
    try {
      await withPinnedCrossProcessLock(run, runRel(run, manifestPathOf(run)), async () => {
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
  await appendEvent(run, {
    event: "run_created",
    sessionId,
    taskId: null,
    from: null,
    to: "pending",
    round: 0,
    phase: "DAG_BUILD",
    specGate,
    ...(specGate === "satisfied" ? { specPath: specFile } : {}),
    ...(preflightNote ? { note: preflightNote } : {}),
    ...(planApproval
      ? {
          approvalDigest: planApproval.approvalDigest,
          approvalKeyId: planApproval.approvalKeyId,
          approvedBy: planApproval.approver,
          promptDraftSha256: planApproval.specHash,
          binding: "prompt" as const,
        }
      : {}),
  })
  // Shared continuity briefing: written after plan/state/costs, never fatal.
  await refreshBriefingSafe(run)
  // Remember which root session owns this run, so a child context hook resolves
  // its own run instead of whichever run was written most recently.
  if (callSession) await rememberRunForRoot(ctx, rootSessionId, sessionId)
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
    content: `Planned ${tasks.length} task(s).\nSESSION_ID: ${sessionId}\nRun dir: ${run}\nBudget: $${budget} (source: ${input.budgetSource ? clean(input.budgetSource, 32) : "default"})\nplan.dag.json + state.json + costs.json written.\n${preflightLine}\nIntegrity mode: ${integrityMode}${request !== undefined ? ` (request recorded in ${originalRequestFile})` : ""}.\nVerification: ${verificationMode}${verificationMode === "strict" ? " (one falsifier challenge + one security-auditor audit per task)" : ""}.\nVictory audit: ${victoryAuditMode}${victoryAuditSource === "caller" ? " (explicit)" : ""}${victorySkipReason ? ` (reason: ${clean(victorySkipReason, 500)})` : ""}${requirementsBaseline ? `; requirements baseline ${requirementsBaseline.items.length} item(s) from ${requirementsBaseline.source} (requirements.json)` : "; no requirements baseline"}.\nHandoff gate: ${requireHandoffsMode}${requireHandoffsSource === "caller" ? " (explicit)" : requireHandoffsSource === "unsigned" ? " (unsigned legacy baseline records skip)" : ""}.\nTrust level: ${trustLevel}${requireWitness ? "; witness required" : ""}.\nAuthenticity: ${signedRun ? `signed baseline (run.manifest.json; key ${clean(authReady.ok ? authReady.keyId : "unknown", 64)})` : "UNSIGNED LEGACY (allowUnsignedLegacy: true; final_verify/next require the recorded bypass)"}.${benchmarkTrustWarning}${specGate === "bypassed" ? "\n⚠ Spec presence gate bypassed (skipInterview: true): planned without an approved prompt_draft.md; the bypass is caller-controlled and recorded, not proof of approval." : ""}${preflight.bypassed ? `\n⚠ Input preflight bypassed (allowMissingInputs: true): ${preflight.status}.` : ""}${creditWarning}`,
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Create a Teamwork run directory and write plan.dag.json + state.json + costs.json. Returns the run path and the (validated) session id. Call this once before dispatching workers.",
      input: strictInput({
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Reuse an existing session id; omit to create one." },
          topology: { type: "string", description: "small-focused | iterative-coding | distributed-coding | proof | massive-proof | document-review. Legacy aliases accepted and normalised: large-swarm → distributed-coding, doc-review → document-review, long-proof → proof, massive-proof-swarm → massive-proof." },
          routingReason: { type: "string", description: "Optional. Why this topology was chosen; persisted in plan.dag.json when provided." },
          request: { type: "string", description: "The verbatim text this run was routed on (max 20000 chars); recorded once in ORIGINAL_REQUEST.md. Sentinel must always pass this for LEMMA and general runs; a second plan into the same run with a non-empty request file is refused." },
          followUp: { type: "string", description: "Append a UTC-timestamped user/parent message to an existing run's ORIGINAL_REQUEST.md. Non-empty, <=20000 chars; repeating the exact last follow-up is a no-op. The signed manifest requestHash is re-bound." },
          integrityMode: { type: "string", description: "development | demo | benchmark. Default development. Recorded in ORIGINAL_REQUEST.md, state.json and plan.dag.json; the security auditor and final gate read it from ORIGINAL_REQUEST.md." },
          verification: {
            type: "string",
            description:
              "standard | strict. Default: strict for distributed-coding (reviewer + falsifier challenger + security-auditor forensic auditor per task), standard for every other topology (unchanged verifier-only completion). Pass standard explicitly to opt a distributed-coding run out of the strict wave. Strict adds exactly one team/falsifier challenge and one team/security-auditor audit per task; both must be recorded with teamwork_wave_record before final verification can PASS. Persisted in plan.dag.json and state.json; a re-plan may not change it.",
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
            description: "required | skip. Default required when a request or requirements baseline exists. An explicit skip requires a non-empty victorySkipReason; both are recorded in plan.dag.json/state.json/signed manifest and final_verify records \"SKIPPED (explicit): <reason>\". A re-plan may repeat but not change the mode or reason. Benchmark mode refuses skip.",
          },
          victorySkipReason: {
            type: "string",
            description: "Required with victoryAudit: \"skip\". Non-empty, trimmed, max 500 chars, sanitized. Recorded in plan.dag.json/state.json and the signed run.manifest.json; a re-plan may not change it.",
          },
          requireHandoffs: {
            type: "string",
            description:
              "required | skip. Default required for a new run with a request/requirements baseline, skip for a legacy/unsigned run. Required makes final_verify and next demand the continuity handoff matrix (assigned worker + verifier per task, falsifier + security-auditor per task in strict mode, one sentinel/orchestrator run-level, and the victory-auditor handoff when victoryAudit is required). Persisted in plan.dag.json, state.json and the signed manifest; a re-plan may repeat but not change it. Benchmark mode refuses skip.",
          },
          trustLevel: {
            type: "string",
            description:
              "local-hmac | external-signer | human-approved | ci-attested. Default local-hmac. Persisted in plan.dag.json, state.json and the signed run.manifest.json; a re-plan may repeat but not change it. external-signer requires an Ed25519 key (local key ring or OPENCODE_TEAMWORK_SIGNER=command:<path>) and final_verify refuses an HMAC envelope. human-approved requires an Ed25519 approval in OPENCODE_TEAMWORK_APPROVAL_DIR (absolute, outside the run/repo, owned by another UID) signed by a key distinct from the run key, with approvedAt >= manifest.createdAt, a bounded expiresAt and approvedBy as uid:/oidc:/ci:<name>; ci-attested is the same with attestedBy. The plan refuses before writing when the directory or OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY is missing. Benchmark refuses an explicit local-hmac.",
          },
          requireWitness: {
            type: "boolean",
            description:
              "Default false. When true, final_verify requires a recorded witness receipt for the run manifest (OPENCODE_TEAMWORK_WITNESS=command:<path> or http(s)://<url>). A configured witness is appended on every signed artifact write; an unavailable/malformed witness fails closed with AUTH_WITNESS_UNAVAILABLE. A local file witness is detection-only.",
          },
          requirePinnedWrites: {
            type: "boolean",
            description:
              "Default false. When true this run only accepts pinned control-plane writes; on a non-pinned host (macOS/Windows detective, or Linux without procfs) the writer refuses with reason containment-mode. Sticky: a re-plan cannot disable it.",
          },
          requireReportBinding: {
            type: "boolean",
            description:
              "Default false (compatibility). When true, a PASS verifier report must carry headSha and diffHash computed by the engine; teamwork_report and final_verify refuse an unbound PASS with REPORT_UNBOUND. Sticky: a re-plan cannot disable it.",
          },
          requiredProvenance: {
            type: "string",
            description:
              "declared | command. Default declared (compatibility). command records a manifest-v4 requirement that every PASS verifier report carries at least one programmatic check with argv/cwd/exitCode/output digest, and writes a signed verify/rerun.json that `opencode-teamwork verify --rerun --repo <clean-checkout>` can re-execute. A re-plan may upgrade declared→command but never downgrade it.",
          },
          attestationPolicy: {
            type: "string",
            description:
              "off | optional | required. Default off. required makes final_verify demand a signed verify/ci/attestation.json from a CI principal whose key is distinct from the run key, bound to the run nonce, plan hash, report headSha and the report's command/output digests. optional records the status without failing the run. A re-plan may upgrade off→optional→required but never downgrade it (manifest v5).",
          },
          attestationKeyId: {
            type: "string",
            description:
              "Optional pinned _auth.keyId of the CI attestation (manifest v5). A re-plan cannot change it once pinned.",
          },
          attestationIssuer: {
            type: "string",
            description:
              "Optional pinned OIDC issuer of the CI attestation (manifest v5). A re-plan cannot change it once pinned.",
          },
          requireSameHost: {
            type: "boolean",
            description:
              "Default false. When true, git worktree setup/merge/resolve/cleanup refuse when the run's recorded host differs from the current host, even with allowSharedWorktrees. Benchmark and strict operators may set it to make a shared-filesystem mix-up a hard error instead of a warning.",
          },
          claimLeaseMs: {
            type: "number",
            description:
              "Optional claim lease in milliseconds for the claim protocol (default 300000 = 5 min, bounded to 60s..60m). A separate 5-minute grace period follows the lease before a claim is stale and eligible for fingerprint-checked reclaim.",
          },
          budgetUsd: { type: "number", description: "Run budget in USD. When using opencode/ models + opencode_console, derive this from credits (full or partial, per the user's choice)." },
          budgetSource: { type: "string", description: "Where the budget came from: credits | default | manual." },
          requireSpec: { type: "boolean", description: "Default true. When true, the run must have a non-empty prompt_draft.md (the approved spec) before the plan is written; this is a spec PRESENCE check. Choosing false is caller-controlled and recorded, not proof of approval; see skipInterview for the explicit bypass." },
          skipInterview: { type: "boolean", description: "Default false. Explicit bypass of the spec presence gate: plan without an approved prompt_draft.md. Recorded in events.jsonl as specGate: bypassed. Caller-controlled; recorded, not proof of approval." },
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
        // A3: a follow-up append is a legal minimal call
        // (`{ sessionId, followUp }`); a normal plan still requires topology
        // and tasks. `anyOf` keeps both contracts visible to the model instead
        // of weakening `createPlanRun`, which re-checks the pair explicitly
        // for direct executes that bypass the Standard Schema.
        anyOf: [
          {
            title: "plan",
            type: "object",
            required: ["topology", "tasks"],
            additionalProperties: true,
          },
          {
            title: "follow-up",
            type: "object",
            required: ["followUp"],
            additionalProperties: true,
          },
        ],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const planRun = input?.sessionId ? resolveRun(root, input.sessionId).run : undefined
        const authz = await authorizeToolAction(ctx, planRun, "plan", undefined, context)
        if (!authz.ok) return { content: authz.content, refused: "unauthorized" }
        const res = await createPlanRun(ctx, root, input, context, undefined, auth)
        return {
          content: res.content,
          ...(res.ok
            ? { sessionId: res.sessionId, run: res.run, tasks: res.tasks, topology: res.topology, integrityMode: res.integrityMode }
            : { ...(res.refused ? { refused: res.refused } : {}), ...(res.aborted ? { aborted: true } : {}) }),
        }
      },
    })

    editor.add({
      name: "route",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Deterministic route classifier. Evaluates Document Review (Priority 1, checked BEFORE Lean/LEMMA, massive-proof, and proof) with explicit supplied-document + critique-intent + negative-trigger guards, then Priorities 2-7. Read-only: writes nothing.",
      input: strictInput({
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
      }),
      execute: (input: any) => {
        // Document Review is the authority for Priority 1; LEMMA owns the
        // explicit Lean 4 gate for Priority 2; the tournament classifier owns
        // the explicit massive-proof opt-in for Priority 3. All three features
        // return route/topology/lemmaMode so any caller's tests can assert.
        // A leading [skip-interview] is a launch parameter, never task text.
        const request = parseTeamworkLaunch(input?.request).text
        const doc = classifyDocumentRoute({ ...(input || {}), request }, root)
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Ingest and partition a supplied Markdown/LaTeX/PDF/text/URL/inline document for the document-review topology. Validates bounds, path containment, and PDF headers BEFORE creating any run directory, then writes plan.dag.json (seg-01..seg-0K + doc-synthesis) and document-review/{manifest.json,DOCUMENT_TEXT_MAP.md,ANALYSIS_PARTITION.md}.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const sessionId = input?.sessionId || newSessionId()
        const resolvedSession = resolveRun(root, sessionId)
        if (resolvedSession.error) return { content: resolvedSession.error }
        const authz = await authorizeToolAction(ctx, resolvedSession.run, "document_triage", undefined, context)
        if (!authz.ok) return { content: authz.content }

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

        let ingested = ingestDocument(readRes.doc.bufferOrText, readRes.doc.format)
        if (!ingested.ok) return { content: ingested.error }
        // A7: an image-only PDF needs the pypdfium2 + Pillow ingestor. It runs
        // BEFORE createPlanRun, so a MISSING toolchain refuses without creating
        // a run directory, and a readable extraction replaces the empty text.
        if (ingested.extractionStatus === "needs_ingestor") {
          const pdfBuffer = Buffer.isBuffer(readRes.doc.bufferOrText)
            ? readRes.doc.bufferOrText
            : Buffer.from(String(readRes.doc.bufferOrText), "latin1")
          const pythonIngest = ingestPdfWithPython(pdfBuffer)
          if (!pythonIngest.ok) {
            const prereqWritten = writePrerequisitesSafe(
              root,
              pdfPrerequisitesBody(pythonIngest.status, pythonIngest.detail),
            )
            return {
              content: `refused: ${pythonIngest.status} PDF text extraction prerequisites: pypdfium2 and Pillow are required for this image-only PDF. ${pythonIngest.detail}${prereqWritten ? `\nPrerequisites recorded at ${join(root, "PREREQUISITES.md")}.` : ""} No run directory was created.`,
              extractionStatus: "needs_ingestor",
              missing: ["pypdfium2", "Pillow"],
            }
          }
          ingested = {
            ok: true,
            format: "pdf",
            text: pythonIngest.text,
            extractionStatus: "extracted",
          }
        }

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
        // A leading [skip-interview] is launch metadata, not document-review task
        // text; it also bypasses the spec gate for this triage run.
        const launch = parseTeamworkLaunch(rawRequest)
        const launchRequest = rawRequest !== undefined ? launch.text : undefined
        const splitReq = launchRequest !== undefined ? splitInstructionAndInlineDoc(launchRequest) : undefined
        const recordedRequest =
          launchRequest !== undefined && launchRequest.length > REQUEST_MAX && splitReq?.hasInlineDoc
            ? splitReq.instructionText || launchRequest.slice(0, REQUEST_MAX)
            : launchRequest
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
            skipInterview: input?.skipInterview === true || launch.skipInterview,
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
            precreateRunDirs(planRun, segments.map((s) => s.id))
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Persist bounded RSA tree node outputs, segment unit-reports, synthesis candidates, or final DOCUMENT_REVIEW_REPORT.md for a document-review run. Enforces SEGMENT_ID allowlist, manifest bounds, symlink refusal, realpath containment, and text sanitisation.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "document_record", input?.stage, context)
        if (!authz.ok) return { content: authz.content }

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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Re-run the input preflight for an existing run: check the files/URLs named by ORIGINAL_REQUEST.md plus any explicit inputs, write <run>/preflight.json, and append a preflight event. Never throws.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "preflight", undefined, context)
        if (!authz.ok) return { content: authz.content }
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
        writeJson(run, file, report)

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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Read the active (or given) Teamwork run and summarize per-task progress. Lists unacknowledged write anomalies; a run with one reports needs-inspection. acknowledgeAnomalies: true records an explicit operator acknowledgement in the config-dir audit (never a run write).",
      input: strictInput({
        type: "object",
        properties: {
          sessionId: { type: "string" },
          acknowledgeAnomalies: { type: "boolean" },
        },
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "status", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const state = readJson<any>(run, join(run, "state.json"), {})
        const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const tasks = state.tasks || {}
        const protocol = claimProtocolOf(state)
        const leaseMs = claimLeaseOf(state)
        const host = runHostOf(state, plan)
        const now = Date.now()
        const warnings: string[] = []
        if (host !== SELF_HOST) {
          warnings.push(`FOREIGN_HOST: this run was recorded on ${clean(host, 80)}; the current host is ${clean(SELF_HOST, 80)}.`)
          warnings.push("SHARED_FS_SUSPECTED: cross-host claims are never auto-reclaimed; use teamwork_recover with an explicit decision.")
        }
        const needsInspection: string[] = []
        const claims: any[] = []
        // Durable write-anomaly audit (A5). Only a refusal recorded for this
        // run blocks it; `detective_mode`/`detective-lock` are fallback
        // diagnostics. An acknowledgement is an operator record, not a run write.
        if (input?.acknowledgeAnomalies === true) acknowledgeWriteAnomalies(run)
        const writeAnomalies = writeAnomaliesForRun(run)
        const unacknowledgedAnomalies = writeAnomalies.filter((entry: any) => entry.acknowledged !== true)
        const containmentIncidents = listContainmentIncidents(run)
        const lines = Object.entries(tasks).map(([id, t]: any) => {
          const claim = publicClaim(t?.claim)
          const derived = deriveClaimState(t, now, { legacyHostless: protocol < CLAIM_PROTOCOL })
          let claimState: string = derived.state
          let fingerprintChanged = false
          if (
            claim &&
            protocol >= CLAIM_PROTOCOL &&
            t?.claim?.baseline &&
            (t?.status === "worker_active" || t?.status === "verifier_active") &&
            (derived.state === "stale" || derived.state === "needs-inspection")
          ) {
            const current = captureClaimBaseline(root, run, t, id, String(t.status), plan)
            const baselineFingerprint = normalizeBaseline(t.claim.baseline)?.fingerprint
            fingerprintChanged =
              !current || current.fingerprint === "unknown" || (!!baselineFingerprint && current.fingerprint !== baselineFingerprint)
            if (fingerprintChanged && claimState !== "cross-host") claimState = "needs-inspection"
          }
          if (claim) {
            claims.push({
              id: clean(id, 64),
              claim,
              state: claimState,
              remainingMs: derived.remainingMs,
              ...(derived.heartbeatAgeMs !== undefined ? { heartbeatAgeMs: derived.heartbeatAgeMs } : {}),
              fence: nextFence(t),
              ...(fingerprintChanged ? { fingerprintChanged: true } : {}),
            })
            if (claimState === "needs-inspection" || t?.claim?.needsInspection === true) needsInspection.push(clean(id, 64))
          }
          const claimText = claim
            ? ` [claim ${claim.by} state=${claimState} until ${claim.leaseUntil}${
                Number.isFinite(derived.remainingMs) ? ` remaining=${Math.max(0, derived.remainingMs)}ms` : ""
              }${claim.previousClaimant ? ` reclaimed-from=${claim.previousClaimant.by}` : ""}]`
            : ""
          return `  ${clean(id, 64)}: ${clean(t?.status, 16)} (round ${Number(t?.round) || 0})${claimText}`
        })
        const pass = Object.values(tasks).filter((t: any) => isPassStatus(t?.status)).length
        const warningText = warnings.length ? `\n${warnings.join("\n")}` : ""
        const inspectionText = needsInspection.length
          ? `\nNeeds inspection (${needsInspection.length}): ${needsInspection.join(", ")} — run teamwork_recover { action: "inspect", taskId } before reclaiming.`
          : ""
        const anomalyText = writeAnomalies.length
          ? `\nWrite anomalies (${writeAnomalies.length}, ${unacknowledgedAnomalies.length} unacknowledged): ${writeAnomalies
              .slice(-10)
              .map((entry: any) => `${clean(entry.kind, 32)}${entry.acknowledged ? " (acknowledged)" : ""}`)
              .join(", ")}`
          : ""
        const writeAnomalyState = unacknowledgedAnomalies.length ? "needs-inspection" : "ok"
        return {
          content: `Run ${basename(run)} — phase ${PHASES.has(state.phase) ? state.phase : "UNKNOWN"} (claim protocol ${protocol}, lease ${
            protocol >= CLAIM_PROTOCOL ? leaseMs : LEGACY_CLAIM_LEASE_MS
          }ms, host ${clean(host, 80)})\n${pass}/${lines.length} pass\n${lines.join("\n")}${warningText}${inspectionText}${anomalyText}${
            unacknowledgedAnomalies.length
              ? `\nWRITE ANOMALY NEEDS INSPECTION: ${unacknowledgedAnomalies.length} unacknowledged write anomaly(ies); teamwork_final_verify will refuse this run. Inspect the config-dir audit, then acknowledge explicitly.`
              : ""
          }`,
          claims,
          needsInspection,
          claimProtocol: protocol,
          claimLeaseMs: protocol >= CLAIM_PROTOCOL ? leaseMs : LEGACY_CLAIM_LEASE_MS,
          host,
          warnings,
          writeAnomalies,
          unacknowledgedWriteAnomalies: unacknowledgedAnomalies.length,
          containmentIncidents,
          runState: writeAnomalyState,
          ...(protocol >= CLAIM_PROTOCOL ? { storage: state.storage ?? null, lockDiagnostics: recentLockDiagnostics(5) } : {}),
        }
      },
    })

    editor.add({
      name: "resume",
      options: { namespace: "teamwork", codemode: false },
      description: "Return the tasks that still need work (pending/running/fail) so a restarted Sentinel can continue where it stopped.",
      input: strictInput({ type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "resume", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const state = readJson<any>(run, join(run, "state.json"), {})
        const protocol = claimProtocolOf(state)
        const now = Date.now()
        const open = Object.entries(state.tasks || {}).filter(([, t]: any) => !isPassStatus(t?.status))
        if (!open.length) return { content: `Run ${basename(run)} is complete (all tasks pass).` }
        const openDetails = open.map(([id, t]: any) => {
          const claim = publicClaim(t?.claim)
          const derived = deriveClaimState(t, now, { legacyHostless: protocol < CLAIM_PROTOCOL })
          const claimText = claim
            ? ` claim=${claim.by}/${derived.state}${derived.remainingMs > 0 ? ` (${Math.max(0, derived.remainingMs)}ms left)` : ` (${claim.leaseUntil})`}`
            : ""
          return { id: clean(id, 64), status: clean(t?.status, 16), round: Number(t?.round) || 0, claim, claimState: derived.state }
        })
        return {
          content:
            `Resume ${basename(run)} at phase ${PHASES.has(state.phase) ? state.phase : "UNKNOWN"} (claim protocol ${protocol}). Open tasks:\n` +
            openDetails.map((t) => `  ${t.id}: ${t.status} round ${t.round}${t.claim ? ` [claim ${t.claim.by} state=${t.claimState}]` : ""}`).join("\n"),
          open: openDetails,
          claimProtocol: protocol,
        }
      },
    })

    editor.add({
      name: "cost",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Read the run budget and report real spend across the full session tree (Sentinel + all workers/verifiers). Uses OpenCode's native cost and token tracking; falls back to manual addUsd when client/db is unavailable. Warns at 80% and returns shouldHalt; the budget is advisory outside the massive-proof tournament, which is the only topology that enforces it. budgetUsd: 0 means no budget.",
      input: strictInput({ type: "object", properties: { sessionId: { type: "string" }, addUsd: { type: "number" }, taskId: { type: "string" } }, additionalProperties: false }),
      execute: async (input: any, context: any) => {
        // SEC-1: the taskId becomes a costs.byTask key. Refuse unsafe ids (e.g.
        // "__proto__", "a/b") before any read or write.
        if (input?.taskId && (typeof input.taskId !== "string" || !isSafeTaskId(input.taskId))) {
          return { content: `refused: invalid task id "${clean(input.taskId, 32)}" (must be a single segment matching ${TASK_ID})` }
        }
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "cost", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const file = join(run, "costs.json")
        const snapshotsFile = join(run, "snapshots.json")

        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        // External usage reads happen OUTSIDE the lock: a database/API/client
        // call can take seconds. The roots used for discovery are a hint; the
        // locked section re-reads costs.json/snapshots.json before mutating.
        const preCosts = readJson<any>(run, file, undefined)
        const preSnaps = readSnapshots(run, snapshotsFile)
        const preRoots: string[] = []
        if (callSession) preRoots.push(callSession)
        for (const value of [preCosts?.rootSessionIds, preSnaps?.rootSessionIds]) {
          if (Array.isArray(value)) {
            for (const id of value) {
              if (typeof id === "string" && !preRoots.includes(id)) preRoots.push(id)
            }
          }
        }
        for (const id of Object.keys(preSnaps?.bySession ?? {})) {
          if (!preRoots.includes(id)) preRoots.push(id)
        }
        const treeResult = await readSessionTreeUsage(ctx, preRoots, callSession)
        const singleUsage = treeResult ? undefined : await readSessionUsage(ctx, callSession)

        // Serialise the read-modify-write so parallel processes cannot lose
        // each other's attribution.
        return await withPinnedCrossProcessLock(run, runRel(run, file), async () => {
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

          let source: string
          let skippedDuplicate = false
          let appliedDigest: string | undefined

          const bucketForTree = (s: SessionUsageItem): string => {
            if (s.id === callSession && input.taskId) return clean(input.taskId, 64)
            if (snaps.rootSessionIds.includes(s.id)) return input.taskId ? clean(input.taskId, 64) : "_sentinel"
            if (s.agent) return input.taskId ? clean(input.taskId, 64) : clean(s.agent, 64)
            return input.taskId ? clean(input.taskId, 64) : "_unattributed"
          }

          const applyUsage = (
            sessions: SessionUsageItem[],
            sourceLabel: string,
            bucketOf: (s: SessionUsageItem) => string,
          ) => {
            const digest = costUsageDigest(sessions)
            appliedDigest = digest
            const now = new Date().toISOString()
            const totalTokens: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
            const duplicate =
              typeof costs.appliedSnapshotDigest === "string" && costs.appliedSnapshotDigest === digest

            if (duplicate) {
              // A crash after the costs write but before snapshots.json must not
              // double-count on retry. The digest is the idempotency key, and
              // the per-session cursors below are the authoritative deltas, so
              // the same observation is a no-op for every bucket and cursor.
              for (const s of sessions) {
                const cursor = { lastCost: s.cost, lastTokens: s.tokens, agent: s.agent, timestamp: now }
                costs.snapshotCursors = nullMap(costs.snapshotCursors)
                costs.snapshotCursors[s.id] = cursor
                snaps.bySession[s.id] = cursor
                totalTokens.input += s.tokens.input
                totalTokens.output += s.tokens.output
                totalTokens.reasoning += s.tokens.reasoning
                totalTokens.cache.read += s.tokens.cache.read
                totalTokens.cache.write += s.tokens.cache.write
              }
              costs.tokens = totalTokens
              costs.rootSessionIds = snaps.rootSessionIds
              skippedDuplicate = true
              source = sourceLabel
              writeCostsOnce(run, file, costs, { source: sourceLabel, digest, skippedDuplicate: true })
              // Compatibility view only; costs.json remains sufficient for
              // idempotency even if this second write crashes or is skipped.
              writeSnapshots(run, snapshotsFile, snaps)
              return
            }

            costs.snapshotCursors = nullMap(costs.snapshotCursors)
            for (const s of sessions) {
              // The cursor in costs.json is authoritative. Fall back to the
              // legacy snapshots.json for runs written before cursors existed.
              const cursor =
                snapshotCursor(costs.snapshotCursors[s.id]) ?? snapshotCursor(snaps.bySession[s.id])
              const delta = cursor
                ? Math.round((s.cost - cursor.lastCost) * 1e4) / 1e4
                : Math.round(s.cost * 1e4) / 1e4

              const nextCursor: SessionSnapshot = {
                lastCost: s.cost,
                lastTokens: s.tokens,
                ...(s.agent ? { agent: clean(s.agent, 64) } : {}),
                timestamp: now,
              }
              costs.snapshotCursors[s.id] = nextCursor
              snaps.bySession[s.id] = nextCursor

              const bucket = bucketOf(s)
              if (delta > 0) addToBucket(bucket, delta)
              accumulateTokenDelta(costs, bucket, s.tokens, cursor ? { lastTokens: cursor.lastTokens } : undefined)

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
            costs.appliedSnapshotDigest = digest
            costs.appliedSnapshotAt = now
            costs.updatedAt = now
            source = sourceLabel
            // Costs is the authority and is written once. If the process dies
            // before snapshots.json is refreshed, the digest + cursors in
            // costs.json still make the retry idempotent.
            writeCostsOnce(run, file, costs, { source: sourceLabel, digest })
            writeSnapshots(run, snapshotsFile, snaps)
          }

          // A truncated child list is a real undercount; keep the warning with
          // the snapshot so an operator can tell "no spend" from "not read".
          if (treeResult?.warnings?.length) costs.treeWarnings = treeResult.warnings
          else delete costs.treeWarnings

          if (treeResult && treeResult.sessions.length > 0) {
            applyUsage(
              treeResult.sessions,
              `opencode session tree (${treeResult.sessions.length} sessions, via ${treeResult.source})`,
              bucketForTree,
            )
          } else if (callSession) {
            if (singleUsage) {
              applyUsage(
                [{ id: callSession, cost: singleUsage.cost, tokens: singleUsage.tokens }],
                `opencode session ${callSession}`,
                () => (input.taskId ? clean(input.taskId, 64) : "_unattributed"),
              )
            } else if (typeof input?.addUsd === "number" && Number.isFinite(input.addUsd)) {
              if (input.addUsd < 0) return { content: "Error: addUsd must be non-negative" }
              const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              addToBucket(bucket, input.addUsd)
              costs.spentUsd =
                Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
              costs.updatedAt = new Date().toISOString()
              writeCostsOnce(run, file, costs, { source: "manual (client unavailable)" })
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
            writeCostsOnce(run, file, costs, { source: "manual (client unavailable)" })
            source = "manual (client unavailable)"
          } else {
            source = "manual (client unavailable)"
          }

          const pct = budgetPercent(costs.spentUsd, budget)
          const shouldHalt = budgetThresholdReached(costs.spentUsd, budget)
          const warn = shouldHalt
            ? `\n⚠ ${pct}% of budget used — advisory: halt non-essential workers and ask the user. The budget is enforced only by the massive-proof tournament.`
            : ""
          const treeWarning =
            Array.isArray(costs.treeWarnings) && costs.treeWarnings.length
              ? `\n⚠ cost tree degraded: ${costs.treeWarnings.map((w: any) => clean(w, 300)).join("; ")}`
              : ""
          // SEC-3: the bucket key is echoed to the caller, so it is sanitised too.
          const taskBreakdown = Object.entries(costs.byTask).map(([k, v]) => `    ${clean(k, 64)}: $${v}`).join("\n")
          return {
            content: `Budget: $${budget} · spent: $${costs.spentUsd} (${pct}%)${warn}${taskBreakdown ? `\nPer-task:\n${taskBreakdown}` : ""}\n(source: ${source}${skippedDuplicate ? "; duplicate snapshot digest skipped" : ""})${treeWarning}`,
            shouldHalt,
            thresholdPct: BUDGET_HALT_PCT,
            pct,
            source,
            skippedDuplicate,
            ...(Array.isArray(costs.treeWarnings) && costs.treeWarnings.length ? { treeWarnings: costs.treeWarnings } : {}),
            ...(appliedDigest ? { appliedSnapshotDigest: appliedDigest } : {}),
          }
        })
      },
    })

    editor.add({
      name: "budget",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Preflight the run budget BEFORE teamwork_plan. Detects whether the session uses opencode/ (managed) models and whether the opencode_console MCP is connected. When both hold, tells the caller to fetch credits via opencode_console_get_usage and pass a full/partial budgetUsd to teamwork_plan. Otherwise, use the default budget.",
      input: strictInput({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input: any, context: any) => {
        const authz = await authorizeToolAction(ctx, undefined, "budget", undefined, context)
        if (!authz.ok) return { content: authz.content }
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Bounded massive-proof tournament state machine (`estimate`, `init`, `propose`, `falsify`, `merge`, `score`, `audit`, `cancel`, `status`). Enforces explicit opt-in, bounded levels/width/candidates, budget preflight, deterministic candidate ranking, AbortSignal/budget-halt cancellation, and team/referee verdict gating.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const action = clean(input?.action, 32).trim()
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
        const tournamentRun = input?.sessionId ? resolveRun(root, input.sessionId).run : undefined
        const authz = await authorizeToolAction(ctx, tournamentRun, "tournament", action, context)
        if (!authz.ok) return { content: authz.content, ok: false, refused: "unauthorized" }

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

          return await withPinnedCrossProcessLock(run, runRel(run, manifestPathOf(run)), async () => {
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
            precreateRunDirs(run)
            if (request !== undefined && !existsSync(join(run, "ORIGINAL_REQUEST.md"))) {
              const tournamentLaunch = parseTeamworkLaunch(request)
              const refused = writeOriginalRequest(run, tournamentLaunch.text, DEFAULT_INTEGRITY_MODE, sessionId, {
                skipInterview: tournamentLaunch.skipInterview,
                ...(tournamentLaunch.ignoredBracket ? { ignoredBracket: tournamentLaunch.ignoredBracket } : {}),
              })
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
              writeJson(run, join(run, "plan.dag.json"), {
                sessionId,
                rootSessionId: callSession,
                topology: "massive-proof",
                integrityMode: DEFAULT_INTEGRITY_MODE,
                preflight: { status: "SKIPPED" },
                tasks,
                tournament: { config: cfgRes.config, estimate },
              })
              if (!existsSync(join(run, "state.json"))) {
                const initStateFile = join(run, "state.json")
                await withPinnedCrossProcessLock(run, runRel(run, initStateFile), async () => {
                  if (existsSync(initStateFile)) return
                  writeJson(run, initStateFile, {
                    version: 1,
                    sessionId,
                    rootSessionId: callSession,
                    integrityMode: DEFAULT_INTEGRITY_MODE,
                    phase: "DISPATCH",
                    tasks: nullMap(Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }]))),
                    updatedAt: new Date().toISOString(),
                  })
                })
              }
              touchRun(run, "pitfalls.md", "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
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
              if (!existingPlan.rootSessionId && callSession) existingPlan.rootSessionId = callSession
              writeJson(run, join(run, "plan.dag.json"), existingPlan)
            }

            // Repair a missing cost record even on a retry (plan may already
            // exist), and persist the budget this init approved while preserving
            // accumulated spend and buckets.
            const costsFile = join(run, "costs.json")
            await withPinnedCrossProcessLock(run, runRel(run, costsFile), async () => {
              const current = readJson<any>(run, costsFile, undefined)
              if (!current) {
                writeJson(run, costsFile, {
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
                writeJson(run, costsFile, current)
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
          return await withPinnedCrossProcessLock(run, runRel(run, mFile), async () => {
            const mRes = readTournamentManifest(run)
            if (mRes.status === "absent") return { content: `No tournament/manifest.json found for run ${sessionId}.` }
            if (mRes.status === "error") {
              return isUnsafePathDetail(mRes.error)
                ? { content: mRes.error, refused: "unsafe_path" }
                : { content: mRes.error }
            }
          const manifest = mRes.manifest
          const caller = await deriveCallerAgent(ctx, run, callSession, context)

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
                agentSource: caller?.source,
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
                agentSource: caller?.source,
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
            if (budget <= 0 || spent >= budget || pct >= BUDGET_HALT_PCT) {
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
                  agentSource: caller?.source,
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
      options: { namespace: "teamwork", codemode: false },
      description: "Append an answer-agnostic failure mode to the run's pitfall registry.",
      input: strictInput({
        type: "object",
        properties: { sessionId: { type: "string" }, round: { type: "number" }, taskId: { type: "string" }, pitfall: { type: "string" } },
        required: ["pitfall"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "pitfall", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const line = `- [round ${Number(input.round) || "?"}] ${clean(input.pitfall, 200)}${input.taskId ? ` — seen in ${clean(input.taskId, 64)}` : ""}\n`
        // ADR 0010: append through a pinned parent descriptor, O_NOFOLLOW, and
        // refuse an aliased inode (nlink !== 1).
        appendLineWithin(run, "pitfalls.md", () => line)
        return { content: `Logged pitfall: ${line.trim()}` }
      },
    })

    editor.add({
      name: "next",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Determine the next actionable tasks in the DAG based on dependencies and current lifecycle states. Returns tasks ready for worker dispatch, tasks ready for verifier dispatch, in-progress tasks, or signals completion/deadlock. In strict mode it returns NEEDS_STRICT_WAVE (or BLOCKED_BY_STRICT_WAVE) until every task has its falsifier challenge and security-auditor audit, and never ALL_PASSED before them. When the plan requires handoffs, it returns NEEDS_HANDOFFS (missing taskId:agent pairs) or BLOCKED_BY_HANDOFFS (stale/duplicate/unknown/tampered) before ALL_PASSED.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        // Bind the cancellation signal at entry. The host's Promise adapter
        // starts listening to `context.cancel` the first time the tool reads
        // `signal`, so an entry read lets a cancel that arrives while `next`
        // is working be observed at the completion check below.
        const cancelSignal = context?.signal
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "next", undefined, context)
        if (!authz.ok) return { content: authz.content }

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
        // Benchmark is unsigned-hostile at every stage, not only at plan time.
        if (
          allowUnsignedLegacy &&
          (readIntegrityMode(run).mode === "benchmark" ||
            normalizeIntegrityMode(plan?.integrityMode) === "benchmark" ||
            normalizeIntegrityMode(state?.integrityMode) === "benchmark")
        ) {
          return {
            status: "AUTH_LEGACY",
            auth: "AUTH_LEGACY",
            refused: "AUTH_LEGACY",
            content:
              "refused: [AUTH_LEGACY] benchmark mode cannot run unsigned; allowUnsignedLegacy is not permitted on a benchmark run.",
          }
        }

        // 0.12.0: contradictions are checked before any "ready for worker" or
        // completion path, so a failing task cannot sit under a CONFIRMED audit.
        {
          const earlyReports: Record<string, any> = Object.create(null)
          const earlyTasks: Array<{ id: string; status: string; reportStatus: string }> = []
          const earlyIds: string[] = []
          for (const task of plan.tasks) {
            if (isSafeTaskId(task?.id) && !earlyIds.includes(task.id)) earlyIds.push(task.id)
          }
          for (const id of Object.keys(state.tasks)) {
            if (isSafeTaskId(id) && !earlyIds.includes(id)) earlyIds.push(id)
          }
          for (const id of earlyIds) {
            const report = readJson<any>(run, join(run, `verify/report-${id}.json`), undefined)
            if (report) earlyReports[id] = report
            earlyTasks.push({
              id,
              status: String(state.tasks[id]?.status ?? "pending"),
              reportStatus: report?.status === "PASS" ? "PASS" : report?.status === "FAIL" ? "FAIL" : "MISSING",
            })
          }
          const earlyContradictions = detectEvidenceContradictions({
            run,
            root,
            runId: basename(run),
            tasks: earlyTasks,
            reports: earlyReports,
            audit: readJson<any>(run, join(run, "verify", "security-audit.json"), undefined),
            victory: readVictoryVerdict(run),
          })
          if (earlyContradictions.length > 0) {
            return {
              status: "INCONSISTENT_EVIDENCE",
              content: `INCONSISTENT_EVIDENCE: the recorded artifacts contradict each other; nothing is auto-fixed. Re-record the named evidence.\n${earlyContradictions.map((c) => `  - [${c.code}] ${c.detail}`).join("\n")}`,
              contradictions: earlyContradictions,
              reasons: earlyContradictions.map((c) => `[${c.code}] ${c.detail}`),
            }
          }
        }

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
            tOutcome = await withPinnedCrossProcessLock(run, runRel(run, manifestPathOf(run)), async () => {
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
              const caller = await deriveCallerAgent(ctx, run, callSession, context)

              if (TOURNAMENT_ACTIVE_PHASES.has(manifest.phase) && cancelSignal?.aborted) {
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
                    agentSource: caller?.source,
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
                  if (budget <= 0 || spent >= budget || pct >= BUDGET_HALT_PCT) {
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
                        agentSource: caller?.source,
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
        } else if (cancelSignal?.aborted) {
          writeInterruptedSafe(run, state?.phase, "request aborted via AbortSignal")
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
        const claimProtocol = claimProtocolOf(state)
        const claimCallSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
        // Protocol 2 fails closed when the caller cannot be resolved: returning
        // ready tasks unclaimed is exactly the duplicate-dispatch hole the
        // protocol exists to close. Protocol 1 keeps the 0.9.0 behaviour.
        if (claimProtocol >= CLAIM_PROTOCOL && !claimCallSession) {
          return {
            status: "CLAIM_PROTOCOL_UNRESOLVED",
            content:
              "refused: this run uses claim protocol 2, but the calling session id could not be resolved. An unclaimed dispatch could duplicate a worker, so no ready task was returned. Call teamwork_next from an identified session.",
          }
        }

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

          // 0.12.0: the security audit is bound to the reports/final it
          // reviewed. A PASS must also cover every forbidden rule exactly once.
          if (audit && audit.status === "PASS") {
            const auditCoverage = evaluateSecurityAuditEvidence(run, audit, integrity.mode)
            if (auditCoverage.reasons.length > 0) {
              const stale = auditCoverage.authStale
              return {
                status: stale ? "AUTH_STALE" : "BLOCKED_BY_SECURITY",
                auth: stale ? "AUTH_STALE" : undefined,
                content: stale
                  ? `BLOCKED_BY_AUTH: [AUTH_STALE] the security audit no longer matches the evidence it reviewed: ${auditCoverage.reasons.join("; ")}. Re-run teamwork_security_audit.`
                  : `BLOCKED_BY_SECURITY: the security audit does not cover the run's integrity rules: ${auditCoverage.reasons.join("; ")}. Re-run teamwork_security_audit.`,
                auditReport: auditFile,
                reasons: auditCoverage.reasons,
                passedCount: passedTasks.length,
                integrityMode: integrity.mode,
              }
            }
          }

          if (!audit || audit.status !== "PASS") {
            const auditFailed = audit && audit.status === "FAIL"
            if (state.phase !== "SECURITY_AUDIT" && !auditFailed) {
              state.phase = "SECURITY_AUDIT"
              await setRunPhase(run, "SECURITY_AUDIT")
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
          let nextStrictGate: { tasks?: Array<any> } | undefined
          if (verification.mode === "strict") {
            const strictTasks = [...taskDefs.keys()]
              .filter((id) => isSafeTaskId(id))
              .map((id) => ({ id, status: String(taskStates[id]?.status ?? "pending") }))
            const strictGate = await evaluateStrictGateChecked(run, strictTasks, "strict", {
              auth,
              requireSigned: signedRun,
            })
            nextStrictGate = strictGate
            // A wave bound to a FAIL report is a contradiction, not just a
            // missing strict verdict: name it before NEEDS/BLOCKED_STRICT_WAVE.
            const waveContradictions = detectEvidenceContradictions({
              run,
              root,
              runId: basename(run),
              tasks: strictGate.tasks.map((t) => ({
                id: t.id,
                status: t.workerStatus,
                reportStatus: t.reportStatus,
              })),
              reports: {},
              audit: undefined,
              victory: undefined,
              strictGate,
            })
            if (waveContradictions.length > 0) {
              return {
                status: "INCONSISTENT_EVIDENCE",
                content: `INCONSISTENT_EVIDENCE: a strict wave verdict approves a FAIL report; nothing is auto-fixed. Re-record the report and the wave.\n${waveContradictions.map((c) => `  - [${c.code}] ${c.detail}`).join("\n")}`,
                contradictions: waveContradictions,
                reasons: waveContradictions.map((c) => `[${c.code}] ${c.detail}`),
                passedCount: passedTasks.length,
                integrityMode: integrity.mode,
              }
            }
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

          // 0.12.0: name contradictions before reporting readiness. These are
          // refusals, not something the gate silently repairs.
          {
            const nextReports: Record<string, any> = Object.create(null)
            const nextEvidenceTasks: Array<{ id: string; status: string; reportStatus: string }> = []
            const nextIds: string[] = []
            for (const id of [...taskDefs.keys(), ...Object.keys(taskStates)]) {
              if (isSafeTaskId(id) && !nextIds.includes(id)) nextIds.push(id)
            }
            for (const id of nextIds) {
              const report = readJson<any>(run, join(run, `verify/report-${id}.json`), undefined)
              if (report) nextReports[id] = report
              nextEvidenceTasks.push({
                id,
                status: String(taskStates[id]?.status ?? "pending"),
                reportStatus: report?.status === "PASS" ? "PASS" : report?.status === "FAIL" ? "FAIL" : "MISSING",
              })
            }
            const contradictions = detectEvidenceContradictions({
              run,
              root,
              runId: basename(run),
              tasks: nextEvidenceTasks,
              reports: nextReports,
              audit,
              victory: readVictoryVerdict(run),
              strictGate: nextStrictGate,
            })
            if (contradictions.length > 0) {
              return {
                status: "INCONSISTENT_EVIDENCE",
                content: `INCONSISTENT_EVIDENCE: the recorded artifacts contradict each other; nothing is auto-fixed. Re-record the named evidence.\n${contradictions.map((c) => `  - [${c.code}] ${c.detail}`).join("\n")}\n${integrityModeNote}`,
                contradictions,
                reasons: contradictions.map((c) => `[${c.code}] ${c.detail}`),
                passedCount: passedTasks.length,
                integrityMode: integrity.mode,
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
                const raw = readBoundedRunFile(run, join(run, `verify/report-${id}.json`), MAX_VERIFIER_REPORT_BYTES)
                const current = raw.status === "ok" ? sha256Hex(raw.text) : null
                if (current !== digest) {
                  drift.push(`report ${id} changed since final verification`)
                  continue
                }
                // The report also binds the worker handoff; a re-recorded
                // handoff invalidates a stamped PASS without changing the report.
                if (raw.status === "ok" && resolveHandoffMode(plan, state).mode === "required") {
                  let parsed: any
                  try {
                    parsed = JSON.parse(raw.text)
                  } catch {}
                  const bound = parsed?.workerHandoff
                  if (bound && typeof bound === "object" && typeof bound.agent === "string") {
                    const live = readWorkerHandoffBinding(run, id, bound.agent)
                    if (live.reason || !live.binding || live.binding.path !== bound.path || live.binding.sha256 !== bound.sha256) {
                      drift.push(`worker handoff for report ${id} changed since final verification`)
                    }
                  }
                }
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

          // Continuity gate: every required handoff must exist and cite the
          // current artifacts before completion. This runs after the stamped
          // final report's own auth/drift checks so AUTH_STALE still wins, but
          // before the final status branch so a handoff failure is actionable.
          const nextHandoffs = await evaluateHandoffGateCheckedFor(
            run,
            plan,
            state,
            auth,
            manifestCheck.signed ? manifestCheck.manifest : undefined,
          )
          if (!nextHandoffs.skipped && !nextHandoffs.ok) {
            const status =
              nextHandoffs.status === "MISSING" ? "NEEDS_HANDOFFS" : "BLOCKED_BY_HANDOFFS"
            const pairs = nextHandoffs.missing.map((m) => `${m.taskId}:${m.agent}`)
            return {
              content: `${status}: continuity handoffs are incomplete. ${
                pairs.length
                  ? `Missing handoff(s): ${pairs.join(", ")}.`
                  : "Every required handoff exists but at least one is stale, duplicated, unknown, or tampered."
              }\nDispatch each agent with the run id and task id; the agent must call teamwork_handoff before reporting. Then run teamwork_final_verify.\n${nextHandoffs.reasons.map((r) => `  - ${r}`).join("\n")}`,
              status,
              handoffs: {
                mode: "required",
                status: nextHandoffs.status,
                missing: nextHandoffs.missing,
                required: nextHandoffs.required,
                reasons: nextHandoffs.reasons,
              },
              missing: nextHandoffs.missing,
              reasons: nextHandoffs.reasons,
              passedCount: passedTasks.length,
            }
          }

          if (!finalReport || typeof finalReport !== "object" || typeof finalReport.status !== "string") {
            if (state.phase !== "FINAL_VERIFICATION") {
              state.phase = "FINAL_VERIFICATION"
              await setRunPhase(run, "FINAL_VERIFICATION")
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
              await setRunPhase(run, "FINAL_VERIFICATION")
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
            {
              auth,
              requireSigned: signedRun,
              requirementsHash: currentRequirementsHash(run),
              skipReason:
                recordedVictorySkipReason(plan?.victorySkipReason) ??
                recordedVictorySkipReason(state?.victorySkipReason),
            },
          )
          const nextVictoryLabel = nextVictoryGate.skipped ? victorySkipLabel(nextVictoryGate.reason) : nextVictoryGate.status
          if (!nextVictoryGate.ok) {
            if (state.phase !== "FINAL_VERIFICATION") {
              state.phase = "FINAL_VERIFICATION"
              await setRunPhase(run, "FINAL_VERIFICATION")
              await refreshBriefingSafe(run)
            }
            // A recorded verdict that no longer matches the evidence it saw is
            // drift, not a missing audit: name it AUTH_STALE and force re-record.
            if (nextVictoryGate.status === "AUTH_STALE") {
              return {
                content: `BLOCKED_BY_AUTH: [AUTH_STALE] the recorded victory audit is stale: ${nextVictoryGate.reasons.join("; ")}. Re-run teamwork_victory_audit against the current evidence.\n${integrityModeNote}`,
                status: "AUTH_STALE",
                auth: "AUTH_STALE",
                finalReport: finalFile,
                passedCount: passedTasks.length,
                integrityMode: integrity.mode,
                victory: nextVictoryGate.status,
                reasons: nextVictoryGate.reasons,
              }
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
            await setRunPhase(run, "MERGE")
            await refreshBriefingSafe(run)
          }

          if (!signedRun && !wasAlreadyMerge) {
            const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
            const caller = await deriveCallerAgent(ctx, run, callSession, context)
            await appendEvent(run, {
              event: "legacy_unsigned_bypass",
              sessionId: basename(run),
              taskId: null,
              to: "ALL_PASSED",
              round: 0,
              agent: caller?.agent ?? null,
              agentSource: caller?.source,
              phase: state.phase ?? null,
              note: "allowUnsignedLegacy: true completed an unsigned legacy run; artifact _auth envelopes were not verified",
            })
          }

          if (!stamped) {
            // Explicit legacy escape hatch: accept, but record who did it and why.
            const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
            const caller = await deriveCallerAgent(ctx, run, callSession, context)
            await appendEvent(run, {
              event: "final_verification_bypass",
              sessionId: basename(run),
              taskId: null,
              to: "ALL_PASSED",
              round: 0,
              agent: caller?.agent ?? null,
              agentSource: caller?.source,
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
              victory: nextVictoryLabel,
            }
          }

          return {
            content: `ALL_TASKS_PASSED: All ${taskDefs.size} tasks have passed verification, security audit PASSED, final verification PASSED, and the victory audit is ${nextVictoryLabel}. Ready to merge Sentinel base worktree to user branch and present final artifact.\n${integrityModeNote}`,
            status: "ALL_PASSED",
            integrityMode: integrity.mode,
            passedCount: passedTasks.length,
            securityAuditPassed: true,
            finalReport: finalFile,
            stamped: true,
            victory: nextVictoryLabel,
          }
        }

        // Atomic dispatch claims. Every ready task gets a bounded lease before
        // it is returned; a different live claimant is surfaced as in-progress
        // instead of being dispatched twice. Protocol 2 requires a baseline
        // match (or an explicit recovery) before an expired claim is reclaimed.
        if (claimCallSession) {
          // Capture every full side-effect baseline (including the bounded
          // untracked scan) BEFORE the state.json lock. The reclaim decision
          // under the lock then only re-reads cheap tracked evidence (HEAD,
          // porcelain status, tracked diff), so `git ls-files`/8 MiB reads never
          // extend the critical section.
          const observedBaselines = new Map<string, ClaimBaseline | undefined>()
          const observedWorktrees = new Map<string, string | undefined>()
          for (const candidate of [...readyForWorker, ...readyForVerifier]) {
            const task = taskStates[candidate.id]
            if (!task || typeof task !== "object") continue
            const status = typeof task.status === "string" ? task.status : ""
            observedBaselines.set(candidate.id, captureClaimBaseline(root, run, task, candidate.id, status, plan))
            observedWorktrees.set(candidate.id, findTaskWorktree(root, basename(run), task, candidate.id)?.path)
          }
          const claimed = await claimReadyTasks(
            root,
            run,
            plan,
            readyForWorker,
            readyForVerifier,
            claimCallSession,
            observedBaselines,
            observedWorktrees,
          )
          readyForWorker.length = 0
          readyForWorker.push(...claimed.worker)
          readyForVerifier.length = 0
          readyForVerifier.push(...claimed.verifier)
          for (const skip of claimed.skipped) {
            inProgress.push({
              id: skip.id,
              status: skip.status === "claimed" ? "claimed" : skip.status,
              round: skip.round,
              branch: taskStates[skip.id]?.branch,
              claim: skip.claim,
              ...(skip.claimState ? { claimState: skip.claimState } : {}),
              ...(skip.fence !== undefined ? { fence: skip.fence } : {}),
              ...(skip.reason ? { reason: skip.reason } : {}),
            })
          }
          for (const ev of claimed.events) {
            await appendEvent(run, {
              event: ev.event,
              sessionId: basename(run),
              taskId: ev.taskId,
              to: ev.event === "claim_renewed" ? "CLAIM_RENEWED" : "NEEDS_INSPECTION",
              round: ev.round,
              note: ev.note,
            })
          }
        }

        // A5: surface the oscillation guard to the coordinator. The artifact is
        // authoritative, but a coordinator that only reads the DAG status must
        // still see that the same failure signature has repeated.
        const oscillationTasks = Object.values(state?.tasks || {})
          .filter((task: any) => Number(task?.failureSignatureCount) >= 2)
          .map((task: any) => String(task?.id ?? "task"))
        const oscillationNote = oscillationTasks.length
          ? `\nOscillation Guard: ${oscillationTasks.join(", ")} repeated the same failure signature; see DEAD_ENDS.md and change approach.`
          : ""
        if (!readyForWorker.length && !readyForVerifier.length && !inProgress.length) {
          return {
            content:
              `DEADLOCK_OR_BLOCKED: No tasks can proceed.\nBlocked tasks (${blockedTasks.length}):\n` +
              blockedTasks.map((t) => `  - ${t.id}: ${t.reason}`).join("\n") +
              oscillationNote,
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
            if (t.fence !== undefined) lines.push(`    Fence: ${t.fence} (pass it back on teamwork_task_update)`)
            if (t.claim) lines.push(`    Claim: ${t.claim.by} until ${t.claim.leaseUntil}${t.claim.previousClaimant ? ` (reclaimed from ${t.claim.previousClaimant.by})` : ""}`)
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
            if (t.fence !== undefined) lines.push(`    Fence: ${t.fence} (pass it back on teamwork_task_update)`)
            if (t.claim) lines.push(`    Claim: ${t.claim.by} until ${t.claim.leaseUntil}`)
          }
        }
        if (inProgress.length) {
          lines.push(`\n⏳ IN PROGRESS (${inProgress.length}):`)
          for (const t of inProgress) {
            const claim = t.claim
              ? `; claim ${t.claim.by}${t.claimState ? ` state=${t.claimState}` : ""} until ${t.claim.leaseUntil}`
              : ""
            lines.push(`  - ${t.id}: ${t.status} (round ${t.round})${claim}${t.reason ? ` — ${clean(t.reason, 120)}` : ""}`)
          }
        }
        lines.push(`\nProgress: ${passedTasks.length}/${taskDefs.size} passed, ${blockedTasks.length} blocked.`)

        return {
          content: lines.join("\n") + oscillationNote,
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Update a task's lifecycle status, round, branch, and verification report in state.json. Lifecycle: pending -> worker_active -> worker_done -> verifier_active -> verified_pass | verified_fail | blocked.",
      input: strictInput({
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
          fence: {
            type: "number",
            description:
              "Optional claim-protocol fence token returned by teamwork_next/teamwork_task_update/teamwork_status. When supplied it must match the task's current fence or the call is refused with STALE_FENCE and nothing is written.",
          },
          reason: {
            type: "string",
            description:
              "Required when team/sentinel or team/orchestrator explicitly overrides a claim held by another session. Recorded in events.jsonl (claim_override) and in the claim history; it does not apply to starting an unclaimed task.",
          },
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "task_update", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const stateFile = join(run, "state.json")
        const planFile = join(run, "plan.dag.json")
        const callSession = authz.sessionID
        const runId = basename(run)

        const taskId = clean(input.taskId, 64)
        if (!taskId) return { content: "Error: taskId is required" }

        // Read plan + actor identity before taking the state lock. Resolving the
        // caller can await the session API; the critical section must stay a
        // short read-modify-write.
        const plan = readJson<any>(run, planFile, undefined)
        const def = Array.isArray(plan?.tasks) ? plan.tasks.find((t: any) => t.id === taskId) : undefined
        const explicitAgent = typeof input.agent === "string" ? clean(input.agent, 64).trim() : ""
        const caller = explicitAgent ? undefined : await deriveCallerAgent(ctx, run, callSession, context)
        const planAgent = def?.agent ? clean(def.agent, 64) : undefined
        const recordedAgent = explicitAgent || caller?.agent || planAgent || null
        const agentSource = explicitAgent ? "explicit" : (caller?.source ?? (planAgent ? "plan" : undefined))
        const sentinelCaller = isSentinelAgent(authz.caller?.agent)
        const reasonText = typeof input.reason === "string" ? clean(input.reason, 200).trim() : ""

        // Protocol-aware pre-read: ownership ancestry and the side-effect
        // baseline are resolved before the lock so the critical section stays a
        // short read-modify-write.
        const preState = readJson<any>(run, stateFile, undefined)
        // 0.10.2: `verified_pass` needs a verified PASS report on a signed run.
        // The inline `verification.status` shortcut survives only for explicit
        // allowUnsignedLegacy runs, and its use is recorded.
        const evidenceManifest = await readRunManifest(run, auth)
        const signedEvidenceRun = evidenceManifest.ok ? evidenceManifest.signed : true
        const legacyInlineAllowed =
          !signedEvidenceRun && (plan?.allowUnsignedLegacy === true || preState?.allowUnsignedLegacy === true)
        const preProtocol = claimProtocolOf(preState)
        const preTask = preState?.tasks && typeof preState.tasks === "object" ? preState.tasks[taskId] : undefined
        const preClaim = normalizeClaim(preTask?.claim)
        const preRelation = preClaim ? await claimRelation(ctx, callSession, preClaim.by) : "none"
        let preBaseline: ClaimBaseline | undefined
        // The verifier-binding git read (base/head/full diff) also happens
        // outside the lock. Only a cheap HEAD re-read runs inside it.
        let reportEvidence: { headSha?: string; baseSha?: string; diffHash?: string } | undefined
        if (preProtocol >= CLAIM_PROTOCOL) {
          const rawStatus = clean(input.status, 32)
          const preStatus = rawStatus === "pass" ? "verified_pass" : rawStatus === "fail" ? "verified_fail" : rawStatus === "running" ? "worker_active" : rawStatus
          if (preStatus === "worker_active" || preStatus === "verifier_active") {
            const captureTask = {
              ...(preTask ?? {}),
              ...(input.worktree ? { worktree: clean(input.worktree, 200) } : {}),
            }
            preBaseline = captureClaimBaseline(root, run, captureTask, taskId, preStatus, plan)
          }
          if (preStatus === "verified_pass") {
            const branch = `teamwork/${runId}-${taskId}`
            const headSha = execGitCapture(root, ["rev-parse", "--verify", branch])
            const baseSha = execGitCapture(root, ["rev-parse", "--verify", `teamwork/base-${runId}`])
            const diff = baseSha && headSha ? execGitCapture(root, ["diff", "--no-color", `${baseSha}..${headSha}`]) ?? "" : ""
            reportEvidence = {
              ...(headSha ? { headSha } : {}),
              ...(baseSha ? { baseSha } : {}),
              ...(baseSha && headSha ? { diffHash: sha256Hex(diff) } : {}),
            }
          }
        }

        const outcome = await withPinnedCrossProcessLock(run, runRel(run, stateFile), async () => {
          const state = readJson<any>(run, stateFile, undefined)
          if (!state || typeof state.tasks !== "object") {
            return { content: `Error: No state.json found for run ${basename(run)}.` }
          }
          // SEC-1: null-prototype task map; existence is an OWN-property check, never truthiness.
          state.tasks = nullMap(state.tasks)
          if (!def && !Object.prototype.hasOwnProperty.call(state.tasks, taskId)) {
            return { content: `Error: Task "${taskId}" not found in plan or state.` }
          }

          let status = clean(input.status, 32)
          if (status === "pass") status = "verified_pass"
          else if (status === "fail") status = "verified_fail"
          else if (status === "running") status = "worker_active"
          // Captured before the maxRounds coercion: a verifier FAIL that hits
          // the round cap is recorded as `blocked`, but it is still a failure
          // for the ledger, the derived feedback and the oscillation guard.
          const failureRequested = status === "verified_fail"

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

          const protocol = claimProtocolOf(state)
          const leaseMs = claimLeaseOf(state)
          const host = runHostOf(state, plan)
          const currentFence = nextFence(current)

          // Fence: an optional caller-supplied token must match the task's
          // current fence on every transition. A mismatch means the caller saw
          // an older claim/release/round and must re-read the DAG.
          if (protocol >= CLAIM_PROTOCOL && input.fence !== undefined && input.fence !== null) {
            const presented = Number(input.fence)
            if (!Number.isFinite(presented) || Math.trunc(presented) !== currentFence) {
              return {
                status: "STALE_FENCE",
                content: `STALE_FENCE: task "${taskId}" is at fence ${currentFence}, but the call carried fence ${clean(input.fence, 16)}. Re-read teamwork_next/teamwork_status before transitioning; state was not changed.`,
                fence: currentFence,
              }
            }
          }

          // Claim ownership is enforced on EVERY transition, not only
          // worker_active. A live claim held by a non-owner cannot be mutated;
          // an expired claim the caller does not own needs an explicit Sentinel
          // override with a recorded reason.
          const existingClaim = normalizeClaim((current as any).claim)
          const nowMs = Date.now()
          const derivedCurrent = deriveClaimState(current, nowMs, { legacyHostless: protocol < CLAIM_PROTOCOL })
          const claimLive =
            derivedCurrent.state === "live" || derivedCurrent.state === "cross-host"
          // A flagged claim always wins: no task transition may change it in
          // place (not only worker_active), even if the fingerprint happens to
          // match. Every flagged claim reports needs-inspection, including one
          // whose lease is still live. Inspect + recover first.
          if (
            protocol >= CLAIM_PROTOCOL &&
            existingClaim &&
            (existingClaim.needsInspection === true || derivedCurrent.state === "needs-inspection")
          ) {
            return {
              status: "CLAIM_NEEDS_INSPECTION",
              content: `CLAIM_NEEDS_INSPECTION: task "${taskId}" is flagged for inspection (${existingClaim.by}); run teamwork_recover { action: "inspect" } and adopt/requeue/block/release before any transition. State was not changed.`,
              claim: publicClaim(existingClaim),
              fence: currentFence,
            }
          }
          const relation =
            !existingClaim || !callSession
              ? "none"
              : existingClaim.by === callSession
                ? "same"
                : preClaim && preClaim.by === existingClaim.by
                  ? preRelation
                  : "none"
          // A cross-host claim (including a missing host) is never mutable by
          // this process, even when the claimant string looks like this session.
          const claimOwnedByCaller =
            (relation === "same" || relation === "descendant") &&
            !(protocol >= CLAIM_PROTOCOL && derivedCurrent.crossHost)
          let claimNote: string | undefined
          let claimForState: any | undefined
          let claimEvent: "claim_override" | "claim_reclaimed" | undefined
          let override = false
          if (protocol >= CLAIM_PROTOCOL && existingClaim && !claimOwnedByCaller) {
            if (sentinelCaller && reasonText) {
              override = true
              claimNote = `sentinel override (${reasonText}): ${authz.caller?.agent} transitioned a task claimed by ${existingClaim.by}`
            } else if (claimLive) {
              return {
                status: "CLAIM_OWNED_BY_OTHER",
                content: `CLAIM_OWNED_BY_OTHER: task "${taskId}" is claimed by ${existingClaim.by} until ${existingClaim.leaseUntil}. Call teamwork_next for a claim, or use teamwork_recover (or a Sentinel override with a reason); state was not changed.`,
                claim: publicClaim(existingClaim),
                fence: currentFence,
              }
            } else {
              return {
                status: "CLAIM_EXPIRED",
                content: `CLAIM_EXPIRED: task "${taskId}" has an expired claim from ${existingClaim.by} that this caller does not own. Use teamwork_recover { action: "inspect" } then adopt/requeue/block, or a Sentinel override with a reason; state was not changed.`,
                claim: publicClaim(existingClaim),
                fence: currentFence,
              }
            }
          }

          if (status === "worker_active" && canonicalFrom !== "worker_active") {
            if (protocol >= CLAIM_PROTOCOL) {
              if (!existingClaim) {
                if (!sentinelCaller) {
                  return {
                    status: "CLAIM_REQUIRED",
                    content: `Error: Refusing worker_active for task "${taskId}" without a claim. Call teamwork_next first; only team/sentinel or team/orchestrator may start an unclaimed task, and that override is recorded.`,
                  }
                }
                claimNote = `sentinel override: ${authz.caller?.agent} started task without a teamwork_next claim`
                claimForState = {
                  ...makeTaskClaim(callSession!, nowMs, undefined, {
                    host: SELF_HOST,
                    runHost: host,
                    leaseMs,
                    epoch: 1,
                    event: "override",
                    priorHistory: current.claimHistory,
                  }),
                  override: "sentinel",
                }
              } else if (claimOwnedByCaller) {
                const renewal = renewClaimObject(existingClaim, nowMs, leaseMs)
                claimForState = renewal.claim
                if (existingClaim.override === "sentinel") claimForState.override = "sentinel"
                if (!renewal.renewed) {
                  claimForState.needsInspection = true
                  claimNote = renewal.reason ?? "max claim tenure reached"
                }
              } else if (override) {
                claimForState = {
                  ...makeTaskClaim(callSession!, nowMs, existingClaim, {
                    host: SELF_HOST,
                    runHost: host,
                    leaseMs,
                    epoch: (Number(existingClaim.epoch) || 0) + 1,
                    event: "override",
                    reason: reasonText,
                    priorHistory: current.claimHistory,
                  }),
                  override: "sentinel",
                }
                claimEvent = "claim_override"
              }
            } else if (existingClaim && claimLive && !claimOwnedByCaller && !sentinelCaller) {
              return {
                content: `Error: Task "${taskId}" is claimed by ${existingClaim.by} until ${existingClaim.leaseUntil}; call teamwork_next to obtain a claim (or ask the Sentinel for an explicit override).`,
              }
            } else if (existingClaim && claimLive && !claimOwnedByCaller && sentinelCaller) {
              claimNote = `sentinel override: ${authz.caller?.agent} started a task claimed by ${existingClaim.by}`
              claimForState = { ...makeLegacyTaskClaim(callSession!, nowMs, existingClaim), override: "sentinel" }
              claimEvent = "claim_override"
            } else if (existingClaim && !claimLive && !claimOwnedByCaller) {
              claimNote = `reclaimed expired claim from ${existingClaim.by}`
              claimForState = makeLegacyTaskClaim(callSession!, nowMs, existingClaim)
              claimEvent = "claim_reclaimed"
            } else if (existingClaim && claimOwnedByCaller) {
              claimForState = makeLegacyTaskClaim(callSession!, nowMs)
              if (existingClaim.previousClaimant) claimForState.previousClaimant = existingClaim.previousClaimant
              if (existingClaim.override === "sentinel") claimForState.override = "sentinel"
            } else if (!existingClaim) {
              if (!sentinelCaller) {
                return {
                  content: `Error: Refusing worker_active for task "${taskId}" without a claim. Call teamwork_next first; only team/sentinel or team/orchestrator may start an unclaimed task, and that override is recorded.`,
                }
              }
              claimNote = `sentinel override: ${authz.caller?.agent} started task without a teamwork_next claim`
              claimForState = { ...makeLegacyTaskClaim(callSession!, nowMs), override: "sentinel" }
            }
          }

          // `verified_pass` needs evidence: a verified on-disk PASS verifier
          // report for THIS task. The inline `verification.status` shortcut is
          // accepted only on an explicit allowUnsignedLegacy run; a signed run
          // must have a report. `verified_fail` needs none.
          // Protocol 2 also binds the report to the current round/fence/branch;
          // a bound report whose branch moved is refused with BRANCH_MOVED.
          let reportWarning: string | undefined
          let inlineEvidenceUsed = false
          if (status === "verified_pass") {
            const inlineRequested = input.verification?.status === "PASS"
            const reportFile = isSafeTaskId(taskId) ? join(run, "verify", `report-${taskId}.json`) : undefined
            const report = reportFile && existsSync(reportFile) ? readJson<any>(run, reportFile, undefined) : undefined
            const inlinePass = inlineRequested && legacyInlineAllowed
            if (inlineRequested && !legacyInlineAllowed && report?.status !== "PASS") {
              return {
                status: "REPORT_MISSING",
                content: signedEvidenceRun
                  ? `Error: Refusing verified_pass for task "${taskId}": the inline verification.status = "PASS" shortcut is not accepted on a signed run. Write a verifier report at ${isSafeTaskId(taskId) ? join(run, "verify", `report-${taskId}.json`) : "verify/report-<taskId>.json"} with "status": "PASS".`
                  : `Error: [AUTH_LEGACY] Refusing verified_pass for task "${taskId}": this unsigned run did not record allowUnsignedLegacy, so inline evidence is not accepted. Re-plan with allowUnsignedLegacy: true or write a verifier report.`,
              }
            }
            if (!inlinePass && report?.status !== "PASS") {
              return {
                status: "REPORT_MISSING",
                content: `Error: Refusing verified_pass for task "${taskId}" without evidence. Write a verifier report at ${reportFile ?? "verify/report-<taskId>.json"} with "status": "PASS" (signed runs require a verified report; the inline shortcut is legacy-only).`,
              }
            }
            if (report?.status === "PASS" && signedEvidenceRun) {
              const reportRel = `verify/report-${taskId}.json`
              const check = auth
                ? await auth.verifyRunArtifact(runId, reportRel, report)
                : {
                    status: "unknown" as const,
                    failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                  }
              if (check.status !== "signed") {
                const failure =
                  check.status === "unsigned"
                    ? { code: "AUTH_MISSING", message: `${reportRel} has no _auth envelope (a signed run requires one)` }
                    : check.failure ?? { code: "AUTH_INVALID", message: `${reportRel} failed verification` }
                return {
                  status: "REPORT_UNVERIFIED",
                  content: `REPORT_UNVERIFIED: refusing verified_pass for task "${taskId}" — [${failure.code}] ${failure.message}. Re-write the report through teamwork_report for the current round.`,
                }
              }
            }
            // 0.16.0: under `command` a verified_pass consumes only a report
            // with a re-executable programmatic check and a commit to run it on.
            if (report?.status === "PASS") {
              const reportProvenance = manifestProvenance(
                evidenceManifest.ok && evidenceManifest.signed ? evidenceManifest.manifest : undefined,
              )
              if (reportProvenance === "command") {
                const problems = verifierReportIntegrityProblems(report, "command")
                if (problems.length > 0) {
                  return {
                    status: "REPORT_INVALID",
                    content: `REPORT_INVALID: refusing verified_pass for task "${taskId}" — ${problems.join("; ")}. Re-record the report through teamwork_report.`,
                  }
                }
                if (typeof report.headSha !== "string" || report.headSha.trim() === "") {
                  return {
                    status: "REPORT_UNBOUND",
                    content: `REPORT_UNBOUND: refusing verified_pass for task "${taskId}" — requiredProvenance is "command" but the report records no headSha to re-execute against.`,
                  }
                }
              }
            }
            inlineEvidenceUsed = inlinePass
            if (protocol >= CLAIM_PROTOCOL && report?.status === "PASS") {
              // Cheap movement check under the lock: the expensive base/head
              // diff was read before it. A moved branch still refuses.
              if (reportEvidence?.headSha) {
                const liveHead = execGitCapture(root, ["rev-parse", "--verify", `teamwork/${runId}-${taskId}`])
                if (liveHead !== reportEvidence.headSha) {
                  return {
                    status: "BRANCH_MOVED",
                    content: `BRANCH_MOVED: refusing verified_pass for task "${taskId}" — the branch moved while the transition was evaluated. Re-run the verifier against the current branch and write a fresh report.`,
                  }
                }
              }
              const binding = validateVerifierReportBinding(
                report,
                {
                  taskId,
                  round,
                  fence: currentFence,
                  root,
                  runId,
                  requireReportBinding: plan?.requireReportBinding === true || state?.requireReportBinding === true,
                },
                reportEvidence,
              )
              if (!binding.ok) {
                return {
                  status: binding.code,
                  content: `${binding.code}: refusing verified_pass for task "${taskId}" — ${binding.reason}. Re-run the verifier against the current branch and write a fresh report.`,
                }
              }
              reportWarning = binding.warning
            }
          }

          // 3.6: cumulative feedback ledger. Every non-empty feedback is appended
          // (sanitised) instead of replacing the previous round; verified_pass
          // resolves all entries in the same write, verified_fail leaves them open.
          // The array is capped at 20 entries, oldest dropped first.
          //
          // A4: a verifier FAIL often arrives with no `feedback` argument (the
          // evidence is the report). Derive the open issue from the report's
          // feedbackForWorker, then the first fatal finding, then the summary,
          // so round 2 always sees what round 1 failed on. A missing report is
          // not an error.
          let failureReport: any
          if (failureRequested && isSafeTaskId(taskId)) {
            const reportRes = readBoundedRunJson<any>(
              run,
              join(run, "verify", `report-${taskId}.json`),
              MAX_VERIFIER_REPORT_BYTES,
            )
            if (reportRes.status === "ok") failureReport = reportRes.value
          }
          const reportFeedback =
            typeof failureReport?.feedbackForWorker === "string" ? failureReport.feedbackForWorker : ""
          const firstFatal =
            Array.isArray(failureReport?.fatalFindings) && failureReport.fatalFindings.length > 0
              ? failureReport.fatalFindings[0]
              : undefined
          const fatalFeedback = firstFatal
            ? [clean(firstFatal.where, 200).trim(), clean(firstFatal.why, 300).trim()].filter(Boolean).join(": ")
            : ""
          const derivedFeedback =
            failureRequested && !input.feedback
              ? clean(reportFeedback, 500).trim() ||
                clean(fatalFeedback, 500).trim() ||
                clean(failureReport?.summary, 500).trim()
              : ""
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
          const feedbackText = typeof input.feedback === "string" ? clean(input.feedback, 500).trim() : ""
          if (feedbackText) {
            priorLog.push({ round, at: new Date().toISOString(), text: feedbackText, resolved: false })
          } else if (derivedFeedback) {
            priorLog.push({ round, at: new Date().toISOString(), text: derivedFeedback, resolved: false })
          }
          if (status === "verified_pass") {
            for (const e of priorLog) e.resolved = true
          }
          const feedbackLog = priorLog.slice(-20)

          // A5: canonical failure signature. Two consecutive failures with the
          // same signature are an oscillation: record DEAD_ENDS.md (once per
          // signature) so the next round changes approach instead of retrying.
          // A failure with no report/feedback/summary carries no evidence and
          // clears the counter rather than inventing an identical failure.
          let failureSignature: string | undefined
          let failureSignatureCount = 0
          if (failureRequested) {
            const sig = failureSignatureOf({
              report: failureReport,
              summary: input.summary,
              feedback: input.feedback,
            })
            if (sig.summary || sig.findingsText || sig.feedbackText) {
              const prevSignature =
                typeof current.failureSignature === "string" ? current.failureSignature : ""
              const prevCount = Number(current.failureSignatureCount) || 0
              failureSignature = sig.signature
              failureSignatureCount = prevSignature === sig.signature ? prevCount + 1 : 1
              if (failureSignatureCount >= 2) {
                writeDeadEndsSafe(run, {
                  taskId,
                  round,
                  signature: sig.signature,
                  count: failureSignatureCount,
                  feedback: feedbackText || derivedFeedback,
                  summary: sig.summary,
                  findings: sig.findingsText,
                })
              }
            }
          }

          const nextTask: any = {
            ...current,
            status,
            round,
            ...(failureRequested
              ? { failureSignature: failureSignature, failureSignatureCount }
              : {}),
            ...(input.branch ? { branch: clean(input.branch, 120) } : {}),
            ...(input.worktree ? { worktree: clean(input.worktree, 200) } : {}),
            ...(input.summary ? { summary: clean(input.summary, 300) } : {}),
            ...(feedbackText ? { feedback: feedbackText } : {}),
            ...(inlineEvidenceUsed ? { verificationSource: "inline-legacy" } : {}),
            // Only tasks that have ledger entries gain the field: the state.json
            // shape of a task that never failed stays exactly as before.
            ...(feedbackLog.length || Array.isArray(current.feedbackLog) ? { feedbackLog } : {}),
            ...(input.verification ? { verification: input.verification } : {}),
            updatedAt: new Date().toISOString(),
          }
          // Terminal states and a returned worker release the dispatch claim.
          // `worker_active` keeps (or creates) the claim for this round.
          const keepClaim =
            status === "worker_active"
              ? claimForState ?? existingClaim
              : ["pending", "worker_done", "verified_pass", "verified_fail", "blocked"].includes(status)
                ? undefined
                : claimForState ?? existingClaim
          const claimReleased = !!existingClaim && !keepClaim
          if (claimReleased && protocol >= CLAIM_PROTOCOL) {
            // A released claim is still evidence: keep its bounded history on
            // the task so release/adopt/requeue/block never erase who held it.
            nextTask.claimHistory = appendClaimHistory(
              mergeClaimHistory(current.claimHistory, existingClaim.history),
              {
                by: existingClaim.by,
                at: existingClaim.at,
                leaseUntil: existingClaim.leaseUntil,
                event: "released",
              },
            )
          }
          if (keepClaim) {
            // Any other owner-authorized transition renews the heartbeat too.
            if (protocol >= CLAIM_PROTOCOL && status !== "worker_active" && existingClaim && claimOwnedByCaller && !override) {
              const renewal = renewClaimObject(existingClaim, nowMs, leaseMs)
              nextTask.claim = renewal.claim
              if (!renewal.renewed) {
                nextTask.claim.needsInspection = true
                claimNote = renewal.reason ?? "max claim tenure reached"
              }
            } else {
              nextTask.claim = keepClaim
            }
          } else {
            delete nextTask.claim
          }

          if (protocol >= CLAIM_PROTOCOL) {
            // Fence increments once per protocol event: claim/reclaim/override,
            // release, and round change. These are separate events, so a
            // release that also advances the round increments twice (the round
            // is a new epoch; the release is a new owner slot). A heartbeat —
            // and a renewal of the same owner/epoch — does not increment.
            //
            // The value returned to the caller is the fence *after* this write,
            // and the common path (owner and round unchanged: worker_active ->
            // worker_done -> verifier_active) leaves it unchanged. A caller can
            // therefore present the fence from `next`/`status`/this response to
            // the immediate `task_update`; any owner or round change invalidates
            // an older fence by design.
            const roundChanged = round !== (Number(current.round) || 0)
            const ownerChanged =
              !!claimForState &&
              (!existingClaim ||
                claimForState.by !== existingClaim.by ||
                (Number(claimForState.epoch) || 0) !== (Number(existingClaim.epoch) || 0))
            const claimChanged = ownerChanged || override
            let fence = currentFence
            if (roundChanged) fence++
            if (claimChanged) fence++
            if (claimReleased) fence++
            nextTask.fence = fence
            // Capture the side-effect baseline after the worktree exists, at the
            // worker_active (and verifier_active) transition — not at `next`.
            if ((status === "worker_active" || status === "verifier_active") && nextTask.claim) {
              const haveBaseline = normalizeBaseline(nextTask.claim.baseline)
              if (!haveBaseline) {
                const captureTask = { ...nextTask, worktree: nextTask.worktree ?? preTask?.worktree }
                const baseline = preBaseline ?? captureClaimBaseline(root, run, captureTask, taskId, status, plan)
                if (baseline && baseline.fingerprint !== "unknown") nextTask.claim.baseline = baseline
              }
            }
          }
          state.tasks[taskId] = nextTask

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
          writeJson(run, stateFile, state)

          return {
            taskId,
            status,
            round,
            fromStatus,
            phase: state.phase ?? null,
            branch: input.branch ?? current.branch ?? null,
            worktree: input.worktree ?? current.worktree ?? null,
            keepClaim: nextTask.claim,
            claimNote,
            claimEvent,
            claimReleased,
            fence: protocol >= CLAIM_PROTOCOL ? nextTask.fence : undefined,
            protocol,
            reportWarning,
            inlineEvidenceUsed,
          }
        })

        if ("content" in outcome) return outcome

        // Log what actually landed in state.json (post-normalisation, post-coercion).
        await appendEvent(run, {
          event: "task_transition",
          sessionId: basename(run),
          taskId,
          from: outcome.fromStatus,
          to: outcome.status,
          round: outcome.round,
          agent: recordedAgent,
          agentSource,
          branch: outcome.branch ?? null,
          worktree: outcome.worktree ?? null,
          phase: outcome.phase ?? null,
          ...(outcome.claimNote ? { note: outcome.claimNote } : {}),
        })
        if (outcome.claimEvent && outcome.protocol >= 2) {
          await appendEvent(run, {
            event: outcome.claimEvent,
            sessionId: basename(run),
            taskId,
            to: outcome.status,
            round: outcome.round,
            agent: recordedAgent,
            agentSource,
            note: outcome.claimNote ?? outcome.claimEvent,
          })
        }
        if (outcome.inlineEvidenceUsed) {
          await appendEvent(run, {
            event: "verification_inline_legacy",
            sessionId: basename(run),
            taskId,
            to: outcome.status,
            round: outcome.round,
            agent: recordedAgent,
            agentSource,
            note: "allowUnsignedLegacy run accepted inline verification.status=PASS; no signed verifier report was required",
          })
        }
        if (outcome.claimReleased && outcome.protocol >= 2) {
          await appendEvent(run, {
            event: "claim_released",
            sessionId: basename(run),
            taskId,
            to: outcome.status,
            round: outcome.round,
            agent: recordedAgent,
            agentSource,
            note: `released the dispatch claim on the ${outcome.status} transition`,
          })
        }
        await refreshBriefingSafe(run)

        return {
          // SEC-3: the branch is echoed to the caller, so it is sanitised like every other field.
          content: `Task ${outcome.taskId} updated: status=${outcome.status}, round=${outcome.round}${outcome.fence !== undefined ? `, fence=${outcome.fence}` : ""}${input.branch ? `, branch=${clean(input.branch, 120)}` : ""}${outcome.status === "blocked" ? " (BLOCKED: max rounds reached)" : ""}${outcome.keepClaim ? `, claim=${outcome.keepClaim.by} until ${outcome.keepClaim.leaseUntil}` : ""}${outcome.reportWarning ? ` (${outcome.reportWarning})` : ""}`,
          taskId: outcome.taskId,
          status: outcome.status,
          round: outcome.round,
          ...(outcome.fence !== undefined ? { fence: outcome.fence } : {}),
          ...(outcome.keepClaim ? { claim: publicClaim(outcome.keepClaim) } : {}),
          ...(outcome.claimNote ? { claimNote: outcome.claimNote } : {}),
          ...(outcome.reportWarning ? { warning: outcome.reportWarning } : {}),
        }
      },
    })

    editor.add({
      name: "recover",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Explicit crash recovery for a claim (claim protocol 2). team/sentinel or team/orchestrator, from the run root or a descendant. Inspect the live and baseline fingerprints, then heartbeat, release, block, requeue or adopt the claim. inspect returns a single-use 10-minute token (stored hashed); adopt/requeue/block refuse without it and re-check the fingerprint, so a worktree that changed after inspection is INSPECTION_STALE. adopt marks a clean committed branch worker_done with a checkpoint and makes NO commit. requeue only when nothing changed, unless force+confirm explicitly discards the unverified changes. Nothing is ever auto-committed.",
      input: strictInput({
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Teamwork session id (defaults to the active run)." },
          taskId: { type: "string", description: "Task id from plan.dag.json." },
          action: {
            type: "string",
            description: "heartbeat | inspect | release | block | requeue | adopt | discard",
          },
          reason: { type: "string", description: "Operator reason, recorded in events.jsonl. Required for a Sentinel release/override of another session's claim." },
          token: { type: "string", description: "The plaintext token returned by action: \"inspect\". Required for adopt/requeue/block." },
          force: { type: "boolean", description: "With confirm: true, allow requeue/discard even when the side-effect fingerprint changed. Never deletes files or commits." },
          confirm: { type: "boolean", description: "Explicit second confirmation for force/discard and cross-host release." },
          allowCrossHost: { type: "boolean", description: "Explicitly allow releasing a claim recorded on another host (TEAMWORK_ALLOW_CROSS_HOST=1 is the env equivalent). Default refuse." },
          note: { type: "string", description: "Optional checkpoint note recorded by adopt/discard." },
          fence: {
            type: "number",
            description:
              "Optional claim-protocol fence returned by teamwork_next/teamwork_status. When supplied it must match the task's current fence or the call is refused with INSPECTION_STALE and nothing is written.",
          },
        },
        required: ["taskId", "action"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const rawAction = clean(input.action, 24).toLowerCase()
        const authz = await authorizeToolAction(ctx, run, "recover", rawAction, context)
        if (!authz.ok) return { content: authz.content }
        const callSession = authz.sessionID
        if (!callSession) {
          return { content: "refused: teamwork_recover needs a resolvable session identity (fail closed); nothing was written" }
        }
        const taskId = input?.taskId
        if (!isSafeTaskId(taskId)) {
          return { content: `refused: invalid task id "${clean(taskId, 32)}"; nothing was written` }
        }
        const ACTIONS = new Set(["heartbeat", "inspect", "release", "block", "requeue", "adopt", "discard"])
        if (!ACTIONS.has(rawAction)) {
          return { content: `refused: unknown recover action "${clean(input.action, 24)}" (allowed: ${Array.from(ACTIONS).join(" | ")})` }
        }
        const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const state = readJson<any>(run, join(run, "state.json"), undefined)
        if (!state || typeof state.tasks !== "object" || !Object.prototype.hasOwnProperty.call(state.tasks, taskId)) {
          return { content: `refused: task "${taskId}" is not in state.json; nothing was written` }
        }
        const task = state.tasks[taskId] ?? {}
        const claim = normalizeClaim(task.claim)
        if (!claim) {
          return { content: `refused: task "${taskId}" has no claim to recover; nothing was written` }
        }
        const relation = await claimRelation(ctx, callSession, claim.by)
        const owned = relation === "same" || relation === "descendant"
        const sentinel = isSentinelAgent(authz.caller?.agent)
        const reasonText = typeof input.reason === "string" ? clean(input.reason, 200).trim() : ""
        const now = Date.now()
        const runId = basename(run)
        const derived = deriveClaimState(task, now, {
          legacyHostless: claimProtocolOf(state) < CLAIM_PROTOCOL,
        })
        if (input.fence !== undefined && input.fence !== null && claimProtocolOf(state) >= CLAIM_PROTOCOL) {
          const presented = Number(input.fence)
          if (!Number.isFinite(presented) || Math.trunc(presented) !== nextFence(task)) {
            return {
              status: "INSPECTION_STALE",
              content: `INSPECTION_STALE: task "${taskId}" is at fence ${nextFence(task)}, but the call carried fence ${clean(input.fence, 16)}. Re-read teamwork_status and inspect again; nothing was written.`,
              fence: nextFence(task),
            }
          }
        }
        const baseline = normalizeBaseline(task.claim?.baseline)
        const observed = captureClaimBaseline(root, run, task, taskId, String(task.status ?? "pending"), plan)
        const inspectionState = inspectWorktreeState(root, run, task, taskId, baseline)
        const observedFingerprint = observed?.fingerprint ?? "unknown"
        const checkpoint = {
          at: new Date(now).toISOString(),
          by: claim.by,
          round: Math.max(0, Math.trunc(Number(task.round) || 0)),
          fence: nextFence(task),
          ...(inspectionState.headSha ? { headSha: inspectionState.headSha } : {}),
          ...(inspectionState.baseSha ? { baseSha: inspectionState.baseSha } : {}),
          ...(inspectionState.diffHash ? { diffHash: inspectionState.diffHash } : {}),
          fingerprint: observedFingerprint,
          commits: inspectionState.commitCount,
          ...(typeof input.note === "string" && input.note.trim() ? { note: clean(input.note, 300).trim() } : {}),
        }

        if (rawAction === "heartbeat") {
          if (!owned) {
            return {
              content: `refused: CLAIM_NOT_OWNED: task "${taskId}" is claimed by ${claim.by}; only the owner or a session descended from it may heartbeat. Nothing was written.`,
              status: "CLAIM_NOT_OWNED",
            }
          }
          const renewed = await renewClaimFor(run, taskId, callSession, ctx, "recover heartbeat")
          return {
            content: renewed.renewed
              ? `Claim heartbeat renewed: ${taskId} (owner ${claim.by}, fence ${nextFence(task)} unchanged).`
              : `Claim not renewed: ${taskId} — ${renewed.reason ?? "not owned by the caller"}. The claim is now expired and needs inspection.`,
            status: renewed.renewed ? "RENEWED" : "EXPIRED",
            renewed: renewed.renewed,
            fence: nextFence(task),
          }
        }

        if (rawAction === "inspect") {
          let token = ""
          let wrote = false
          await mutateRunState(
            run,
            (current) => {
              const t = current.tasks?.[taskId]
              if (!t || typeof t !== "object") return
              const currentClaim = normalizeClaim(t.claim)
              if (!currentClaim) return
              const ownedNow = currentClaim.by === callSession || (owned && currentClaim.by === claim.by)
              if (!ownedNow && !sentinel) return
              token = issueInspectionToken(t, observed, now)
              wrote = true
            },
            { write: () => wrote },
          )
          if (!wrote) {
            return { content: `refused: task "${taskId}" cannot be inspected by this caller (claim changed or not owned). Nothing was written.` }
          }
          await appendEvent(run, {
            event: "claim_inspection_required",
            sessionId: runId,
            taskId,
            to: "INSPECTED",
            round: Number(task.round) || 0,
            note: `inspection token issued by ${authz.caller?.agent ?? callSession}`,
          })
          const fingerprintMatch = !!baseline && baseline.fingerprint === observedFingerprint && observedFingerprint !== "unknown"
          return {
            content: `INSPECTION for ${taskId} (claim ${claim.by}, state ${derived.state}, fence ${nextFence(task)}).\nFingerprint: ${
              fingerprintMatch ? "unchanged since the baseline" : "changed/unknown since the baseline"
            }.\nBaseline: ${baseline ? `${baseline.scope} ${baseline.fingerprint.slice(0, 16)}` : "none"}.\nObserved: ${observed ? `${observed.scope} ${observedFingerprint.slice(0, 16)}` : "unavailable"}.\nCommits since base: ${inspectionState.commitCount}. Dirty: ${inspectionState.dirty ? inspectionState.dirtyPaths.length : 0}; untracked: ${
              inspectionState.untracked?.count ?? 0
            }.\nTOKEN (single use, 10 minutes): ${token}\nNext: adopt (clean committed branch), requeue (fingerprint unchanged or force+confirm), block, or release.`,
            status: "INSPECTED",
            token,
            taskId,
            claim: publicClaim(claim),
            claimState: derived.state,
            baseline: baseline ?? null,
            observed: observed ?? null,
            fingerprintMatch,
            checkpoint,
            diffstat: inspectionState.diffstat ?? "",
            commits: inspectionState.commits,
            dirty: inspectionState.dirty,
            dirtyPaths: inspectionState.dirtyPaths,
            untracked: inspectionState.untracked ?? null,
            baselineAncestor: inspectionState.baselineAncestor ?? null,
            expiresAt: new Date(now + INSPECTION_TOKEN_TTL_MS).toISOString(),
          }
        }

        // Every mutating action below revalidates ownership and, where the spec
        // requires it, the inspection token and the live fingerprint.
        let wrote = false
        const outcome = await mutateRunState(
          run,
          (current) => {
            const t = current.tasks?.[taskId]
            if (!t || typeof t !== "object") return { code: "TASK_MISSING", content: `refused: task "${taskId}" disappeared; nothing was written` }
            const currentClaim = normalizeClaim(t.claim)
            if (!currentClaim) return { code: "NO_CLAIM", content: `refused: task "${taskId}" no longer has a claim; nothing was written` }
            const ownedNow = currentClaim.by === callSession || (owned && currentClaim.by === claim.by)
            if (!ownedNow && !sentinel) {
              return { code: "CLAIM_NOT_OWNED", content: `refused: CLAIM_NOT_OWNED: task "${taskId}" is claimed by ${currentClaim.by}; nothing was written` }
            }
            if (!ownedNow && sentinel && !reasonText) {
              return {
                code: "OVERRIDE_REASON_REQUIRED",
                content: `refused: OVERRIDE_REASON_REQUIRED: a Sentinel recovery of another session's claim needs input.reason; nothing was written`,
              }
            }
            const releaseCrossHost = rawAction === "release" && claimIsCrossHost(currentClaim)
            if (releaseCrossHost) {
              const allowed = input.allowCrossHost === true || process.env.TEAMWORK_ALLOW_CROSS_HOST === "1"
              if (!allowed) {
                return {
                  code: "CROSS_HOST_RELEASE_REFUSED",
                  content: `refused: CROSS_HOST_RELEASE_REFUSED: the claim was recorded on ${clean(currentClaim.host || "unknown", 80)} (a missing host is cross-host); set allowCrossHost: true or TEAMWORK_ALLOW_CROSS_HOST=1 only after confirming the host is gone. Nothing was written.`,
                }
              }
              if (input.confirm !== true) {
                return {
                  code: "CONFIRM_REQUIRED",
                  content: `refused: CONFIRM_REQUIRED: a cross-host release needs confirm: true; nothing was written`,
                }
              }
            }

            // A removed claim is still evidence: keep its last holder in the
            // bounded task-level history so release/adopt/requeue/block never
            // erase who held it.
            const preserveReleasedClaim = (event: string) => {
              // The claim's own `history` and the task-level chain are merged
              // before the claim is deleted, so release/adopt/requeue/block
              // never erase an earlier claimant.
              t.claimHistory = appendClaimHistory(
                mergeClaimHistory(t.claimHistory, currentClaim.history),
                {
                  by: currentClaim.by,
                  at: currentClaim.at,
                  leaseUntil: currentClaim.leaseUntil,
                  event,
                  ...(reasonText ? { reason: reasonText } : {}),
                },
              )
            }

            const needsToken = rawAction === "adopt" || rawAction === "requeue" || rawAction === "block"
            if (needsToken) {
              const check = validateInspectionToken(t, input.token, now)
              if (!check.ok) {
                return { code: check.code, content: `refused: ${check.code}: ${check.reason}; nothing was written` }
              }
              if (check.inspection.fingerprint !== observedFingerprint) {
                return {
                  code: "INSPECTION_STALE",
                  content: `refused: INSPECTION_STALE: the side-effect fingerprint changed after inspection (inspected ${check.inspection.fingerprint.slice(
                    0,
                    16,
                  )}, now ${observedFingerprint.slice(0, 16)}). Inspect again; nothing was written.`,
                }
              }
            }

            if (rawAction === "release") {
              t.fence = nextFence(t) + 1
              preserveReleasedClaim("released")
              delete t.claim
              delete t.inspection
              wrote = true
              return {
                code: "OK",
                event: "claim_released",
                note: `released claim ${currentClaim.by}${reasonText ? `: ${reasonText}` : ""}`,
                content: `Claim released for ${taskId} (fence ${t.fence}).`,
              }
            }

            if (rawAction === "block") {
              t.status = "blocked"
              t.fence = nextFence(t) + 1
              preserveReleasedClaim("blocked")
              delete t.claim
              delete t.inspection
              wrote = true
              return {
                code: "OK",
                event: "claim_recovered",
                note: `blocked claim ${currentClaim.by}${reasonText ? `: ${reasonText}` : ""}`,
                content: `Task ${taskId} blocked and claim released (fence ${t.fence}).`,
              }
            }

            if (rawAction === "adopt") {
              const base = normalizeBaseline(currentClaim.baseline)
              if (!base || !base.headSha) {
                return {
                  code: "BASELINE_MISSING",
                  content: `refused: BASELINE_MISSING: adopt needs a committed branch baseline with a head SHA; inspect exists only as an artifact/progress handoff. Nothing was written.`,
                }
              }
              if (!observed || observedFingerprint === "unknown") {
                return { code: "OBSERVATION_UNAVAILABLE", content: `refused: OBSERVATION_UNAVAILABLE: the worktree fingerprint cannot be read; nothing was written` }
              }
              if (inspectionState.dirty || (inspectionState.untracked?.count ?? 0) > 0) {
                return {
                  code: "DIRTY_WORKTREE",
                  content: `refused: DIRTY_WORKTREE: adopt requires a clean committed branch (${inspectionState.dirtyPaths.length} dirty path(s), ${
                    inspectionState.untracked?.count ?? 0
                  } untracked). Commit or discard the changes first; nothing was written.`,
                }
              }
              if (inspectionState.baselineAncestor !== true) {
                return {
                  code: "BASELINE_NOT_ANCESTOR",
                  content: `refused: BASELINE_NOT_ANCESTOR: the baseline head ${base.headSha.slice(0, 12)} is not an ancestor of the current head. The branch was rewritten; do not adopt it. Nothing was written.`,
                }
              }
              // Adopt makes NO commit: it records the existing committed state
              // as worker_done with a checkpoint for the verifier.
              t.status = "worker_done"
              t.fence = nextFence(t) + 1
              t.checkpoint = checkpoint
              preserveReleasedClaim("adopted")
              delete t.claim
              delete t.inspection
              wrote = true
              return {
                code: "OK",
                event: "claim_recovered",
                note: `adopted committed branch ${inspectionState.headSha?.slice(0, 12)} as worker_done (no new commit)`,
                content: `Adopted ${taskId} as worker_done at ${inspectionState.headSha?.slice(0, 12)} (fence ${t.fence}). No commit was made; the verifier can review the existing branch.`,
                headSha: inspectionState.headSha,
                commits: inspectionState.commitCount,
              }
            }

            // requeue / discard
            const explicitDiscard = rawAction === "discard" || (input.force === true && input.confirm === true)
            if (rawAction === "discard" && (input.force !== true || input.confirm !== true)) {
              return {
                code: "DISCARD_CONFIRM_REQUIRED",
                content: `refused: DISCARD_CONFIRM_REQUIRED: discard needs force: true and confirm: true; nothing was written`,
              }
            }
            const unchanged =
              !!baseline && baseline.fingerprint === observedFingerprint && observedFingerprint !== "unknown"
            if (!unchanged && !explicitDiscard) {
              return {
                code: "SIDE_EFFECTS_PRESENT",
                content: `refused: SIDE_EFFECTS_PRESENT: requeue is only safe when the side-effect fingerprint equals the baseline (or with force+confirm discard). Inspect, then decide; nothing was written.`,
              }
            }
            t.status = "pending"
            t.fence = nextFence(t) + 1
            if (explicitDiscard) t.checkpoint = { ...checkpoint, discarded: true }
            preserveReleasedClaim(explicitDiscard ? "discarded" : "requeued")
            delete t.claim
            delete t.inspection
            wrote = true
            return {
              code: "OK",
              event: "claim_recovered",
              note: `${explicitDiscard ? "requeued and discarded unverified changes" : "requeued with an unchanged fingerprint"}${reasonText ? `: ${reasonText}` : ""}`,
              content: `Task ${taskId} requeued as pending (fence ${t.fence}).${
                explicitDiscard ? " Unverified changes were left in place and marked discarded; nothing was committed or deleted." : ""
              }`,
            }
          },
          { write: () => wrote },
        )

        if (!outcome || outcome.code !== "OK") {
          return { content: outcome?.content ?? `refused: recovery state could not be read; nothing was written`, status: outcome?.code ?? "REFUSED" }
        }

        await appendEvent(run, {
          event: outcome.event as any,
          sessionId: runId,
          taskId,
          to: rawAction.toUpperCase(),
          round: Number(task.round) || 0,
          agent: authz.caller?.agent ?? null,
          agentSource: authz.caller?.source,
          note: outcome.note,
        })
        await refreshBriefingSafe(run)
        return {
          content: outcome.content,
          status: "OK",
          action: rawAction,
          taskId,
          ...(outcome.headSha ? { headSha: outcome.headSha } : {}),
          ...(outcome.commits !== undefined ? { commits: outcome.commits } : {}),
        }
      },
    })

    editor.add({
      name: "handoff",
      options: { namespace: "teamwork", codemode: false },

      description:
        "Record the five-section handoff (Observation, Logic Chain, Caveats, Conclusion, Verification Method) for this agent. Writes <run>/handoffs/<taskId|_run>-<agent>.md and updates the bounded handoffs/index.json. Identity comes from the trusted calling session; task-scoped roles must name an existing task, while victory-auditor/sentinel/orchestrator record run-level handoffs. When the plan records requireHandoffs: \"required\", final_verify/next require the derived matrix and reject missing/stale/tampered handoffs, but the prose is never parsed as a PASS/FAIL verdict.",
      input: strictInput({
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Run id (SESSION_ID returned by teamwork_plan), not the OpenCode session id." },
          taskId: { type: "string", description: "Task id for worker/proof-worker/verifier/falsifier/security-auditor. Omit (or pass _run) for victory-auditor/sentinel/orchestrator." },
          observation: { type: "string", description: "1. Observation — what you ran and saw." },
          logicChain: { type: "string", description: "2. Logic Chain — observation → conclusion." },
          caveats: { type: "string", description: "3. Caveats — unchecked/assumed/risky." },
          conclusion: { type: "string", description: "4. Conclusion — done, blocked, or needs re-scope." },
          verificationMethod: { type: "string", description: "5. Verification Method — how the next agent reproduces it." },
          round: { type: "number", description: "Optional round number (default 0)." },
        },
        required: ["sessionId", "observation", "logicChain", "caveats", "conclusion", "verificationMethod"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "handoff", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const agent = authz.caller?.agent
        if (!agent || !handoffAgentSlug(agent)) {
          return { content: "refused: handoff needs a trusted team/<role> session identity; nothing was written" }
        }
        const scope = resolveHandoffScope(agent, input?.taskId)
        if (!scope.ok) return { content: scope.error }

        // The manifest pins whether the run requires signed handoff entries. A
        // present-but-untrustworthy manifest fails closed rather than letting a
        // handoff record against an ambiguous baseline.
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return {
            content: `refused: ${authFailureText(manifestCheck.failure)}; a handoff cannot be recorded against an untrustworthy run manifest. Nothing was written.`,
          }
        }
        const requireSigned =
          manifestCheck.signed && (manifestCheck.manifest.handoffAuth ?? "legacy") === "signed"

        if (scope.taskId) {
          const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
          const state = readJson<any>(run, join(run, "state.json"), undefined)
          const inPlan = Array.isArray(plan?.tasks) && plan.tasks.some((t: any) => t?.id === scope.taskId)
          const inState = !!state?.tasks && Object.prototype.hasOwnProperty.call(state.tasks, scope.taskId)
          if (!inPlan && !inState) {
            return { content: `refused: task "${scope.taskId}" is not in plan.dag.json or state.json; nothing was written` }
          }
        }

        if (scope.taskId) {
          await renewClaimFor(run, scope.taskId, authz.sessionID, ctx, "handoff")
        }

        try {
          const written = await writeHandoff(run, {
            sessionId: basename(run),
            agent,
            agentSessionId: authz.sessionID ?? "",
            taskId: scope.taskId,
            round: input?.round,
            auth,
            requireSigned,
            sections: {
              observation: input?.observation,
              logicChain: input?.logicChain,
              caveats: input?.caveats,
              conclusion: input?.conclusion,
              verificationMethod: input?.verificationMethod,
            },
          })
          await appendEvent(run, {
            event: "handoff_recorded",
            sessionId: basename(run),
            taskId: scope.taskKey,
            to: "HANDOFF",
            round: written.entry.round,
            agent,
            agentSource: "session",
            note: written.relativePath,
          })
          const citeLine = written.entry.cites.length
            ? `\nCitations: ${written.entry.cites.map((c) => `${c.path} (sha256 ${c.sha256})`).join(", ")}`
            : ""
          return {
            content: `Handoff recorded: ${written.relativePath} (${written.bytes} bytes, sha256 ${written.sha256}).${citeLine}`,
            path: written.path,
            relativePath: written.relativePath,
            taskId: scope.taskKey,
            agent,
            sha256: written.sha256,
            bytes: written.bytes,
            cites: written.entry.cites,
          }
        } catch (err: any) {
          return { content: clean(err?.message || "handoff write failed", 300) }
        }
      },
    })

    editor.add({
      name: "security_audit",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Record the findings of team/security-auditor and enforce the pre-merge security gate. Writes verify/security-audit.json. If Critical or High findings exist, or the auditor reports an integrity finding forbidden at the run's mode, marks status as FAIL and blocks final merge.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "security_audit", undefined, context)
        if (!authz.ok) return { content: authz.content }
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

        // Pre-create the known run subdirectory through the pinned writer; the
        // JSON write below would create it too, but an explicit plan-time shape
        // reduces the attack surface and makes failures early and clear.
        createDirWithin(run, "verify")
        const verifyDir = join(run, "verify")
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
          // 0.12.0: the engine records coverage, not the caller. Every forbidden
          // rule appears exactly once; any violation forces FAIL above.
          ruleChecks: forbiddenIntegrityRules(integrity.mode).map((rule) => {
            const finding = integrityFindings.find((f: any) => f.rule === rule)
            return finding
              ? { rule, result: "violation" as const, ...(finding.where ? { where: finding.where } : {}) }
              : { rule, result: "clean" as const }
          }),
          reviewedDigests: (() => {
            const digests = evidenceDigestsFromDisk(run)
            return { reports: digests.reports, final: digests.final }
          })(),
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
        writeJson(run, auditFile, auditToWrite)

        let stateForEvent: any
        await mutateRunState(run, (state) => {
          stateForEvent = state
          if (status === "PASS") {
            state.phase = "MERGE"
          } else {
            // Append critical/high findings to pitfalls so they become known
            for (const f of findings) {
              if (["critical", "high"].includes(String(f.severity).toLowerCase())) {
                const line = `- [security] ${clean(f.severity, 16).toUpperCase()}: ${clean(f.description, 160)}${f.location ? ` at ${clean(f.location, 64)}` : ""}\n`
                appendLineWithin(run, "pitfalls.md", () => line)
              }
            }
          }
        })

        await appendEvent(run, {
          event: "security_audit",
          sessionId: basename(run),
          to: status,
          phase: stateForEvent?.phase ?? null,
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Record the independent final acceptance verdict from team/victory-auditor. The auditor compares the delivered artifacts and tests against ORIGINAL_REQUEST.md and requirements.json. Only a trusted session whose agent is team/victory-auditor may call it (a caller-supplied label cannot self-authorize). Writes verify/victory.json; a CONFIRMED verdict is write-once.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        // Authorization follows the trusted session identity only. There is no
        // `agent` input: a caller cannot label itself the victory auditor.
        const authz = await authorizeToolAction(ctx, run, "victory_audit", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const callSession = authz.sessionID
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return { content: `refused: ${authFailureText(manifestCheck.failure)}; nothing was written` }
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Record one strict-verification verdict. Only team/falsifier may record kind=challenge (verdict PASS) and only team/security-auditor may record kind=audit (verdict CLEAN); the caller identity is derived from the trusted session and cannot be supplied as an input. Requires the task to exist and its verify/report-<taskId>.json to be PASS, binds the verdict to that report's sha256, writes verify/challenge-<taskId>.json or verify/audit-<taskId>.json atomically, appends a verification_wave event, and refuses re-recording the same report (a changed report is the only overwrite path).",
      input: strictInput({
        type: "object",
        properties: {
          sessionId: { type: "string" },
          taskId: { type: "string", description: "The task ID defined in plan.dag.json." },
          kind: { type: "string", description: "challenge | audit." },
          verdict: { type: "string", description: "challenge: PASS; audit: CLEAN. Any other value is refused." },
          notes: { type: "string", description: "Optional adversarial notes (max 1000 chars, sanitized)." },
          evidence: { type: "string", description: "Optional evidence pointer (max 2000 chars, sanitized)." },
          cites: {
            type: "array",
            description:
              "Optional verify/ evidence paths this verdict reviewed (max 16). The engine hashes each file; a missing file refuses the call and a changed/missing cite makes the verdict stale.",
            items: { type: "string" },
          },
        },
        required: ["sessionId", "taskId", "kind", "verdict"],
        additionalProperties: false,
      }),
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
        const authz = await authorizeToolAction(ctx, run, "wave_record", kind, context)
        if (!authz.ok) return { content: authz.content }
        const callSession = authz.sessionID
        const caller = authz.caller
        const expectedAgent = WAVE_AGENTS[kind]
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return { content: `refused: ${authFailureText(manifestCheck.failure)}; nothing was written` }
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
            cites: input?.cites,
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
      name: "evidence",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Write one bounded evidence artifact under verify/evidence/<name> (max 64 KiB, at most 32 files) through the pinned run writer. Returns {path, sha256, bytes}; cite the path from teamwork_wave_record so the strict gate re-hashes it. This records bytes, not a verdict.",
      input: strictInput({
        type: "object",
        properties: {
          sessionId: { type: "string" },
          name: { type: "string", description: "One safe file segment, e.g. trace.txt (max 64 chars)." },
          content: { type: "string", description: "Exact UTF-8 content (max 65536 bytes)." },
        },
        required: ["sessionId", "name", "content"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "evidence", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const name = typeof input?.name === "string" ? input.name.trim() : ""
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
          return { content: `refused: evidence name "${clean(name, 80)}" must be one safe segment (^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$); nothing was written` }
        }
        const content = typeof input?.content === "string" ? input.content : undefined
        if (content === undefined) {
          return { content: "refused: evidence content must be a string; nothing was written" }
        }
        const bytes = Buffer.byteLength(content, "utf8")
        const MAX_EVIDENCE_BYTES = 64 * 1024
        const MAX_EVIDENCE_FILES = 32
        if (bytes > MAX_EVIDENCE_BYTES) {
          return {
            content: `refused: evidence ${name} is ${bytes} bytes; the cap is ${MAX_EVIDENCE_BYTES}; nothing was written`,
          }
        }
        try {
          createDirWithin(run, "verify")
          createDirWithin(run, "verify/evidence")
          const dir = join(run, "verify", "evidence")
          const existing = readdirSync(dir).filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry))
          if (!existing.includes(name) && existing.length >= MAX_EVIDENCE_FILES) {
            return {
              content: `refused: verify/evidence already holds ${existing.length} artifacts (cap ${MAX_EVIDENCE_FILES}); nothing was written`,
            }
          }
          const relativePath = `verify/evidence/${name}`
          writeSafeRunFile(run, join(run, relativePath), content)
          return {
            content: `EVIDENCE RECORDED: ${relativePath} (${bytes} bytes, sha256 ${contentSha256Hex(content)}).`,
            path: relativePath,
            sha256: contentSha256Hex(content),
            bytes,
          }
        } catch (err: any) {
          return { content: `refused: could not write verify/evidence/${clean(name, 64)} (${clean(err?.message, 160)}); nothing was written` }
        }
      },
    })

    editor.add({
      name: "report",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Trusted writer for verify/report-<taskId>.json. Only a session whose trusted agent is team/verifier, descending from the run root, may call it. The task must exist in plan.dag.json and a PASS report must carry evidence (a summary or checks, every check passed, no fatal findings). A check may record argv-only command evidence (command/cwd/exitCode/output/durationMs); the engine computes commandSha256/outputBytes and writes a signed verify/rerun.json projection that `opencode-teamwork verify --rerun` can re-execute at the report's headSha. The report is signed for a signed run (run.manifest.json) and indexed in ctx.storage; final_verify re-checks the signature and the PASS evidence. A wrong agent, a missing task, an inconsistent PASS, a shell command line, or (under requiredProvenance \"command\") a programmatic check without a command is refused.",
      input: strictInput({
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
                output: { type: "string", description: "Optional captured output (max 2000 chars); stored and hashed as outputSha256." },
                error: { type: "string", description: "Optional captured error output (max 2000 chars)." },
                exitCode: { type: "number", description: "Optional process/check exit code (integer)." },
                command: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional argv-only command (max 32 args). Never a shell line; `sh -c`/`bash -c` is refused. Under requiredProvenance \"command\" a programmatic check must record one.",
                },
                cwd: { type: "string", description: "Optional relative directory inside the re-execution worktree (default \".\"). Absolute paths and .. are refused." },
                durationMs: { type: "number", description: "Observed command duration in milliseconds (integer, engine-bounded). Required when command is supplied." },
                timeoutMs: { type: "number", description: "Optional per-command timeout in milliseconds (1..600000, default 120000); recorded only in verify/rerun.json." },
                outputTruncated: { type: "boolean", description: "Set when `output` is a truncated capture; a truncated check stays audit evidence but is never recorded as re-executable." },
                outputBytes: { type: "number", description: "Engine-computed. Ignored on input." },
                commandSha256: { type: "string", description: "Engine-computed over {argv,cwd}. Ignored on input." },
                outputSha256: { type: "string", description: "Engine-computed. Ignored on input; final_verify recomputes it from output." },
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
          round: {
            type: "number",
            description:
              "Optional. The task round this report covers. Must equal the task's current round; a stale round is refused with REPORT_ROUND_STALE. The written report always carries the observed round.",
          },
          fence: {
            type: "number",
            description:
              "Optional claim fence the verifier observed. Must equal the task's current fence or the report is refused with REPORT_FENCE_STALE. The written report carries the observed fence.",
          },
          branch: { type: "string", description: "Optional branch name; when supplied it must match the task branch." },
          baseSha: { type: "string", description: "Optional base commit the report was computed against; a mismatch is BRANCH_MOVED." },
          headSha: { type: "string", description: "Optional branch head the report was computed against; a mismatch is BRANCH_MOVED." },
          diffHash: { type: "string", description: "Optional sha256 of the branch diff the report was computed against; a mismatch is BRANCH_MOVED." },
          checkpoint: {
            type: "object",
            description: "Optional worker checkpoint to bind into the report (for example a commit/diff summary). Sanitised and bounded.",
            properties: {
              note: { type: "string" },
              headSha: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["sessionId", "taskId", "status"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "report", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const callSession = authz.sessionID
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
        const manifestCheck = await readRunManifest(run, auth)
        if (!manifestCheck.ok) {
          return { content: `refused: ${authFailureText(manifestCheck.failure)}; nothing was written` }
        }
        const provenance = manifestProvenance(
          manifestCheck.signed ? manifestCheck.manifest : undefined,
        )
        const checkProblems: string[] = []
        const checks = Array.isArray(input?.checks)
          ? input.checks
              .slice(0, 100)
              .map((c: any) => {
                const normalized = normalizeReportCheck(c, provenance)
                checkProblems.push(...normalized.problems)
                return normalized.check
              })
              .filter(Boolean)
          : []
        const summary = typeof input?.summary === "string" ? cleanBlock(input.summary, 2000).trim() : ""
        const fatalFindings = Array.isArray(input?.fatalFindings)
          ? input.fatalFindings.slice(0, 50).map((f: any) => ({
              where: clean(f?.where, 200),
              why: clean(f?.why, 500),
              fix: clean(f?.fix, 500),
            }))
          : []
        if (status === "PASS" && fatalFindings.length > 0) {
          return {
            content: "refused: a PASS report cannot carry fatalFindings — record status: \"FAIL\" or resolve the findings; nothing was written",
          }
        }
        if (status === "PASS" && checks.some((c: any) => c.passed !== true)) {
          return {
            content: "refused: a PASS report requires every checks[].passed to be true; nothing was written",
          }
        }
        // D4 + checks[] v2: a self-contradictory exitCode, an argv that is not
        // re-executable, or a programmatic claim without a command is refused
        // by name instead of being recorded.
        if (checkProblems.length > 0) {
          const exitConflict = checkProblems.some((p) => p.startsWith("CHECK_EXIT_CONFLICT"))
          const commandMissing = checkProblems.some((p) => p.startsWith("CHECK_COMMAND_MISSING"))
          return {
            status: exitConflict ? "CHECK_EXIT_CONFLICT" : commandMissing ? "CHECK_COMMAND_MISSING" : "CHECK_INVALID",
            content: `refused: ${checkProblems.join("; ")}; nothing was written`,
          }
        }
        if (status === "PASS" && provenance === "command") {
          const rerunnable = checks.some(
            (c: any) => c.type === "programmatic" && Array.isArray(c.command) && c.command.length > 0 && c.outputTruncated === false,
          )
          if (!rerunnable) {
            return {
              status: "CHECK_COMMAND_MISSING",
              content:
                'refused: CHECK_COMMAND_MISSING: requiredProvenance is "command", so a PASS needs at least one programmatic check with an untruncated argv/output observation; nothing was written',
            }
          }
        }
        if (status === "PASS" && summary === "" && checks.length === 0) {
          return { content: "refused: a PASS report needs evidence — provide a non-empty summary or at least one check; nothing was written" }
        }
        // verify/rerun.json is the signed, re-executable projection of the
        // command checks. It is merged per task and re-signed; the existing
        // file's envelope is verified first so a re-report cannot launder a
        // tampered re-execution record.
        const runIdForRerun = basename(run)
        const rerunFile = join(run, "verify", "rerun.json")
        const rerunTasks: Record<string, any> = Object.create(null)
        if (existsSync(rerunFile)) {
          const existingRerun = readJson<any>(run, rerunFile, undefined)
          if (!existingRerun || typeof existingRerun !== "object" || !existingRerun.tasks || typeof existingRerun.tasks !== "object") {
            return { status: "RERUN_INVALID", content: "refused: [RERUN_INVALID] verify/rerun.json is malformed; repair it before recording a report. Nothing was written." }
          }
          if (manifestCheck.signed) {
            const rerunCheck = auth
              ? await auth.verifyRunArtifact(runIdForRerun, "verify/rerun.json", existingRerun)
              : { status: "unknown" as const, failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context" } }
            if (rerunCheck.status !== "signed") {
              const failure =
                rerunCheck.status === "unsigned"
                  ? { code: "AUTH_MISSING", message: "verify/rerun.json has no _auth envelope" }
                  : rerunCheck.failure ?? { code: "AUTH_INVALID", message: "verify/rerun.json failed verification" }
              return { content: `refused: ${authFailureText(failure)}; verify/rerun.json must verify before it can be extended. Nothing was written.` }
            }
          }
          for (const [id, value] of Object.entries(existingRerun.tasks)) {
            if (id !== taskId) rerunTasks[id] = value
          }
        }
        const rerunEntries = checks
          .map((check: any) => rerunEntryForCheck(check))
          .filter((entry: any) => entry !== undefined)
        if (rerunEntries.length > 0) rerunTasks[taskId] = { checks: rerunEntries }
        const rerunPayload: any =
          Object.keys(rerunTasks).length > 0
            ? {
                version: 1,
                sessionId: runIdForRerun,
                tasks: rerunTasks,
                generatedAt: new Date().toISOString(),
              }
            : undefined
        const state = readJson<any>(run, join(run, "state.json"), undefined)
        const taskState = state?.tasks && typeof state.tasks === "object" ? state.tasks[taskId] ?? {} : {}
        const protocol = claimProtocolOf(state)
        const currentRound = Math.max(0, Math.trunc(Number(taskState.round) || 0))
        const currentFence = nextFence(taskState)
        if (protocol >= CLAIM_PROTOCOL) {
          if (input?.round !== undefined && input?.round !== null) {
            const presented = Number(input.round)
            if (!Number.isFinite(presented) || Math.trunc(presented) !== currentRound) {
              return {
                status: "REPORT_ROUND_STALE",
                content: `REPORT_ROUND_STALE: task "${taskId}" is on round ${currentRound}, but the report was submitted for round ${clean(input.round, 16)}; nothing was written.`,
              }
            }
          }
          if (input?.fence !== undefined && input?.fence !== null) {
            const presented = Number(input.fence)
            if (!Number.isFinite(presented) || Math.trunc(presented) !== currentFence) {
              return {
                status: "REPORT_FENCE_STALE",
                content: `REPORT_FENCE_STALE: task "${taskId}" is at fence ${currentFence}, but the report carried fence ${clean(input.fence, 16)}; nothing was written.`,
              }
            }
          }
        }
        const runId = basename(run)
        const reportBranch = `teamwork/${runId}-${taskId}`
        const observedHead = execGitCapture(root, ["rev-parse", "--verify", reportBranch])
        const observedBase = execGitCapture(root, ["rev-parse", "--verify", `teamwork/base-${runId}`])
        const observedDiff =
          observedHead && observedBase ? execGitCapture(root, ["diff", "--no-color", `${observedBase}..${observedHead}`]) ?? "" : undefined
        const observedDiffHash = observedDiff === undefined ? undefined : sha256Hex(observedDiff)
        // D2: an opt-in plan flag makes headSha/diffHash mandatory for a PASS.
        // The values are still computed by the engine, never supplied by input.
        if (plan?.requireReportBinding === true && status === "PASS" && (!observedHead || observedDiffHash === undefined)) {
          return {
            status: "REPORT_UNBOUND",
            content: `refused: REPORT_UNBOUND: requireReportBinding is asserted but branch ${reportBranch} has no resolvable head/diff to bind; the PASS would not be consumable. Nothing was written.`,
          }
        }
        const branchInput = typeof input?.branch === "string" ? clean(input.branch, 120).trim() : ""
        if (branchInput && branchInput !== reportBranch) {
          return {
            status: "BRANCH_MOVED",
            content: `BRANCH_MOVED: task "${taskId}" is on branch "${reportBranch}", but the report named "${branchInput}"; nothing was written.`,
          }
        }
        if (typeof input?.headSha === "string" && observedHead && input.headSha.trim() !== observedHead) {
          return {
            status: "BRANCH_MOVED",
            content: `BRANCH_MOVED: the branch head is ${observedHead.slice(0, 12)}, but the report named ${clean(input.headSha, 64).slice(0, 12)}; nothing was written.`,
          }
        }
        if (typeof input?.baseSha === "string" && observedBase && input.baseSha.trim() !== observedBase) {
          return {
            status: "BRANCH_MOVED",
            content: `BRANCH_MOVED: the base is ${observedBase.slice(0, 12)}, but the report named ${clean(input.baseSha, 64).slice(0, 12)}; nothing was written.`,
          }
        }
        if (typeof input?.diffHash === "string" && observedDiffHash && input.diffHash.trim() !== observedDiffHash) {
          return {
            status: "BRANCH_MOVED",
            content: `BRANCH_MOVED: the branch diff changed since the submitted diffHash; nothing was written.`,
          }
        }
        const checkpointNote =
          input?.checkpoint && typeof input.checkpoint === "object" && typeof input.checkpoint.note === "string"
            ? cleanBlock(input.checkpoint.note, 500).trim()
            : ""
        const checkpointHead =
          input?.checkpoint && typeof input.checkpoint === "object" && typeof input.checkpoint.headSha === "string"
            ? clean(input.checkpoint.headSha, 64).trim()
            : ""
        // 0.12.0: bind the report to the worker handoff that preceded it. The
        // binding is resolved from the handoff index on disk, never from input.
        const handoffMode = resolveHandoffMode(plan, state).mode
        const assignedWorker = assignedWorkerAgent(run, taskId)
        const workerHandoffResult = assignedWorker
          ? readWorkerHandoffBinding(run, taskId, assignedWorker)
          : { reason: `task ${taskId} has no assigned worker role that can record a handoff` }
        if (status === "PASS" && handoffMode === "required") {
          if (workerHandoffResult.reason) {
            return {
              status: "REPORT_HANDOFF_STALE",
              content: `refused: [REPORT_HANDOFF_STALE] ${workerHandoffResult.reason}; nothing was written. Re-record the worker handoff (teamwork_handoff) for ${taskId}, then re-run the verifier report.`,
            }
          }
          if (!workerHandoffResult.binding) {
            return {
              status: "REPORT_HANDOFF_MISSING",
              content: `refused: [REPORT_HANDOFF_MISSING] task "${taskId}" has requireHandoffs: "required" but no ${assignedWorker} handoff is recorded in handoffs/index.json; nothing was written. Have the worker call teamwork_handoff before the verifier reports.`,
            }
          }
        }
        await renewClaimFor(run, taskId, authz.sessionID, ctx, "report")
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
          round: currentRound,
          fence: currentFence,
          branch: reportBranch,
          ...(workerHandoffResult.binding ? { workerHandoff: workerHandoffResult.binding } : {}),
          ...(observedBase ? { baseSha: observedBase } : {}),
          ...(observedHead ? { headSha: observedHead } : {}),
          ...(observedDiffHash ? { diffHash: observedDiffHash } : {}),
          bound: !!(observedHead && observedDiffHash),
          ...(checkpointNote || checkpointHead
            ? { checkpoint: { ...(checkpointNote ? { note: checkpointNote } : {}), ...(checkpointHead ? { headSha: checkpointHead } : {}) } }
            : {}),
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
        let rerunToWrite: any
        if (rerunPayload && manifestCheck.signed) {
          try {
            rerunToWrite = await auth!.signRunArtifact(basename(run), "verify/rerun.json", rerunPayload)
          } catch (err: any) {
            const failure = err?.failure as AuthFailure | undefined
            return {
              content: `refused: could not sign verify/rerun.json (${failure ? failure.code : "signing failed"}); nothing was written`,
              refused: failure?.code ?? "AUTH_UNAVAILABLE",
            }
          }
        } else if (rerunPayload) {
          rerunToWrite = rerunPayload
        }
        try {
          writeJsonSafe(run, join(run, relativePath), toWrite)
        } catch (err: any) {
          return { content: `refused: could not write ${relativePath} (${clean(err?.message, 140)}); nothing was written` }
        }
        try {
          if (rerunToWrite) writeJsonSafe(run, rerunFile, rerunToWrite)
          else if (existsSync(rerunFile)) rmSync(rerunFile, { force: true })
        } catch (err: any) {
          return { content: `refused: could not write verify/rerun.json (${clean(err?.message, 140)}); the report is not consumable` }
        }
        await appendEvent(run, {
          event: "verifier_report",
          sessionId: basename(run),
          taskId,
          to: status,
          round: currentRound,
          agent: "team/verifier",
          agentSource: "session",
          phase: state?.phase ?? null,
        })
        return {
          content: `VERIFIER REPORT WRITTEN: ${taskId} ${status}${manifestCheck.signed ? " (signed)" : " (unsigned legacy)"}.${rerunToWrite ? "\nRe-execution record: verify/rerun.json" : ""}\nArtifact: ${join(run, relativePath)}`,
          report: toWrite,
          artifact: join(run, relativePath),
          signed: manifestCheck.signed,
          ...(rerunToWrite ? { rerunArtifact: join(run, "verify", "rerun.json") } : {}),
        }
      },
    })

    editor.add({
      name: "final_verify",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Compute and stamp the run's final verdict from artifacts. PASS requires every task to be verified_pass, every verify/report-<taskId>.json to be PASS, verify/security-audit.json to be PASS, and (unless the plan explicitly skipped it) a CONFIRMED independent victory audit bound to the current ORIGINAL_REQUEST.md. In strict mode it also requires verify/challenge-<taskId>.json (team/falsifier, PASS) and verify/audit-<taskId>.json (team/security-auditor, CLEAN) for every task, both bound by reportHash to the current verifier report, and writes GATE_STATUS.md. When requireHandoffs is required it also requires the continuity matrix (worker + verifier per task, falsifier + security-auditor per task in strict mode, one sentinel/orchestrator run-level, and the victory-auditor run-level handoff after a confirmed audit), rejecting missing/stale/duplicate/unknown/tampered handoffs without parsing their prose. Writes verify/final.json atomically and appends a final_verification event. The verdict is computed from evidence and cannot be overridden by input.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const finalFile = join(run, "verify", "final.json")
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        return await withPinnedCrossProcessLock(run, runRel(run, finalFile), async () => {
          const caller = await deriveCallerAgent(ctx, run, callSession, context)
          const state = readJson<any>(run, join(run, "state.json"), undefined)
          if (!state || typeof state.tasks !== "object") {
            return { content: `Error: No state.json found for run ${basename(run)}.` }
          }
          const plan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
          // Preserve the abort path below: when the signal fired while the
          // caller was being resolved, let the evidence scan record FAIL.
          if (!context?.signal?.aborted) {
            const authz = await authorizeToolAction(ctx, run, "final_verify", undefined, context)
            if (!authz.ok) return { content: authz.content }
          }
          const manifestCheck = await readRunManifest(run, auth)
          if (!manifestCheck.ok) {
            return {
              status: "FAIL",
              auth: manifestCheck.failure.code,
              content: `FINAL VERIFICATION FAILED: [${manifestCheck.failure.code}] ${manifestCheck.failure.message}. Final merge is BLOCKED.`,
              reasons: [authFailureText(manifestCheck.failure)],
            }
          }
          // A5: a run with an unacknowledged write anomaly is not consumable. A
          // containment refusal is evidence that a control-plane write may not
          // have landed where it was reported; re-verify after inspecting and
          // acknowledging (teamwork_status { acknowledgeAnomalies: true }).
          const pendingAnomalies = unacknowledgedWriteAnomalies(run)
          const incidents = listContainmentIncidents(run)
          if (pendingAnomalies.length > 0) {
            return {
              status: "NEEDS_INSPECTION",
              content: `FINAL VERIFICATION REFUSED: run ${basename(run)} has ${pendingAnomalies.length} unacknowledged write anomaly(ies): ${pendingAnomalies
                .slice(-5)
                .map((entry: any) => clean(entry.kind, 32))
                .join(", ")} (${incidents.length} durable incident manifest(s) recorded). Detection is a report about an event that already happened; no rollback was attempted. Inspect the config-dir incident manifests and re-record any refused artifact before final verification; nothing was written.`,
              reasons: pendingAnomalies.map(
                (entry: any) => `[WRITE_ANOMALY] ${clean(entry.kind, 32)}${entry.name ? ` ${clean(entry.name, 64)}` : ""}: ${clean(entry.detail, 200)}`,
              ),
              unacknowledgedWriteAnomalies: pendingAnomalies.length,
              containmentIncidents: incidents,
            }
          }
          const allowUnsignedLegacy = input?.allowUnsignedLegacy === true
          // Benchmark is unsigned-hostile at every stage, not only at plan time.
          if (
            allowUnsignedLegacy &&
            (readIntegrityMode(run).mode === "benchmark" ||
              normalizeIntegrityMode(plan?.integrityMode) === "benchmark" ||
              normalizeIntegrityMode(state?.integrityMode) === "benchmark")
          ) {
            return {
              status: "FAIL",
              auth: "AUTH_LEGACY",
              refused: "AUTH_LEGACY",
              content:
                "FINAL VERIFICATION FAILED: [AUTH_LEGACY] benchmark mode cannot run unsigned; allowUnsignedLegacy is not permitted on a benchmark run. Final merge is BLOCKED.",
              reasons: [
                "[AUTH_LEGACY] benchmark mode cannot run unsigned; allowUnsignedLegacy is not permitted on a benchmark run",
              ],
            }
          }
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
              agentSource: caller?.source,
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
          const trustLevel: TrustLevel = signedRun
            ? normalizeTrustLevel(manifestCheck.manifest.trustLevel) ?? DEFAULT_TRUST_LEVEL
            : DEFAULT_TRUST_LEVEL
          // 0.16.0: the signed manifest decides whether a claim must be
          // re-executable. A version < 4 manifest keeps the 0.15 `declared`
          // meaning. final_verify never executes a command; `verify --rerun`
          // does. It does enforce the record shape and the rerun artifact.
          const provenance: ProvenanceMode = signedRun ? manifestProvenance(manifestCheck.manifest) : "declared"
          const observedAlgs: Array<string | undefined> = []
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
          const reportValues: Record<string, any> = Object.create(null)
          const authReasons: string[] = []
          const contentIntegrityReasons: string[] = []
          for (const id of ids) {
            const safe = isSafeTaskId(id)
            const reportRel = safe ? `verify/report-${id}.json` : null
            // D3: one shared cap for the parse and the digest. A report that
            // cannot be read at that cap is not a PASS the gate can consume.
            const reportRaw = reportRel
              ? readBoundedRunFile(run, join(run, reportRel), MAX_VERIFIER_REPORT_BYTES)
              : undefined
            let report: any
            if (reportRaw?.status === "ok") {
              try {
                report = JSON.parse(reportRaw.text)
              } catch {
                report = undefined
              }
            }
            if (report) reportValues[id] = report
            const rawStatus = taskStates[id]?.status
            tasks.push({
              id: clean(id, 64),
              status: typeof rawStatus === "string" ? clean(rawStatus, 32) : "pending",
              report: reportRel,
              reportStatus:
                report?.status === "PASS" ? "PASS" : report?.status === "FAIL" ? "FAIL" : "MISSING",
            })
            if (reportRel && report?.status === "PASS") {
              const problems = verifierReportIntegrityProblems(report, provenance)
              if (problems.length > 0) {
                contentIntegrityReasons.push(
                  `task ${id}: report ${reportRel} is not a valid PASS (${problems.join("; ")})`,
                )
              }
              // A command claim without a commit has no worktree to re-run in.
              if (provenance === "command" && (typeof report.headSha !== "string" || report.headSha.trim() === "")) {
                contentIntegrityReasons.push(
                  `[REPORT_UNBOUND] task ${id}: requiredProvenance is "command" but report ${reportRel} records no headSha`,
                )
              }
            }
            if (reportRel) {
              const raw = reportRaw
              reportDigests[clean(id, 64)] =
                raw?.status === "ok" ? sha256Hex(raw.text) : null
              if (report?.status === "PASS" && reportDigests[clean(id, 64)] === null) {
                contentIntegrityReasons.push(
                  `[REPORT_DIGEST] task ${id}: a PASS report has no readable sha256 digest (${clean(
                    raw?.status === "error" ? raw.error : "unreadable or over the shared report cap",
                    160,
                  )}); the PASS cannot be bound to its bytes`,
                )
              }
              if (requireSigned && raw?.status === "ok" && report) {
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
                } else {
                  observedAlgs.push(check.auth?.alg)
                }
              }
            }
          }
          // D2: `requireReportBinding: true` (opt-in, default off for
          // compatibility) makes an unbound PASS unconsumable: a PASS must name
          // the branch head and diff it verified. Legacy runs keep
          // `legacy_unbound_report` instead of a hard refusal.
          const requireReportBinding =
            plan?.requireReportBinding === true || state?.requireReportBinding === true
          if (requireReportBinding) {
            const unbound = tasks.filter((t) => {
              if (t.reportStatus !== "PASS") return false
              const value = reportValues[t.id]
              return (
                !value ||
                typeof value.headSha !== "string" ||
                value.headSha === "" ||
                typeof value.diffHash !== "string" ||
                value.diffHash === ""
              )
            })
            if (unbound.length > 0) {
              return {
                status: "REPORT_UNBOUND",
                content: `FINAL VERIFICATION REFUSED: requireReportBinding is asserted but PASS report(s) for ${unbound
                  .map((t) => t.id)
                  .join(", ")} carry no headSha/diffHash; re-record the verifier report against the current branch. Nothing was written.`,
                reasons: unbound.map(
                  (t) => `[REPORT_UNBOUND] task ${t.id}: PASS report is not bound to a headSha and diffHash`,
                ),
              }
            }
          }
          // A command claim with no commit cannot be re-executed against any
          // tree. This is the same named refusal whether or not the plan also
          // asserted requireReportBinding.
          if (provenance === "command") {
            const unbound = tasks.filter((t) => {
              if (t.reportStatus !== "PASS") return false
              const value = reportValues[t.id]
              return !value || typeof value.headSha !== "string" || value.headSha.trim() === ""
            })
            if (unbound.length > 0) {
              return {
                status: "REPORT_UNBOUND",
                content: `FINAL VERIFICATION REFUSED: requiredProvenance is "command" but PASS report(s) for ${unbound
                  .map((t) => t.id)
                  .join(", ")} record no headSha; a command claim must name the commit it was observed on. Nothing was written.`,
                reasons: unbound.map(
                  (t) => `[REPORT_UNBOUND] task ${t.id}: requiredProvenance "command" needs a report.headSha`,
                ),
              }
            }
          }
          const audit = readJson<any>(run, join(run, "verify", "security-audit.json"), undefined)
          const securityAudit = {
            path: "verify/security-audit.json",
            status: audit?.status === "PASS" ? "PASS" : audit?.status === "FAIL" ? "FAIL" : "MISSING",
          }
          // 0.12.0: a PASS audit must cover every forbidden rule exactly once
          // and its reviewed digests must still match. Violations force FAIL.
          {
            const auditCoverage = evaluateSecurityAuditEvidence(run, audit, readIntegrityMode(run).mode)
            contentIntegrityReasons.push(...auditCoverage.reasons)
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
            } else {
              observedAlgs.push(check.auth?.alg)
            }
          }
          // 0.16.0: verify/rerun.json is the signed re-execution projection of
          // the report's command checks. final_verify does not execute it (the
          // offline verifier's --rerun does); it refuses a missing record under
          // `command`, a bad envelope, or a record that no longer mirrors the
          // reports. Its digest is stamped into final evidence.
          const rerunRaw = readBoundedRunFile(run, join(run, "verify", "rerun.json"), MAX_RUN_FILE_BYTES)
          let rerunValue: any
          let rerunDigest: string | null = null
          if (rerunRaw.status === "ok") {
            rerunDigest = sha256Hex(rerunRaw.text)
            try {
              rerunValue = JSON.parse(rerunRaw.text)
            } catch {
              rerunValue = undefined
              contentIntegrityReasons.push("[RERUN_INVALID] verify/rerun.json is malformed")
            }
          }
          if (rerunValue) {
            if (requireSigned) {
              const check = auth
                ? await auth.verifyRunArtifact(basename(run), "verify/rerun.json", rerunValue)
                : {
                    status: "unknown" as const,
                    failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                  }
              if (check.status === "unsigned") {
                authReasons.push("[AUTH_MISSING] verify/rerun.json has no _auth envelope (a signed run requires one)")
              } else if (check.status !== "signed") {
                const failure = check.failure ?? { code: "AUTH_INVALID" as const, message: "verify/rerun.json failed verification" }
                authReasons.push(`[${failure.code}] ${failure.message}`)
              }
            }
            if (rerunValue.version !== 1 || rerunValue.sessionId !== basename(run)) {
              contentIntegrityReasons.push("[RERUN_INVALID] verify/rerun.json has an unsupported version or sessionId")
            } else if (!rerunValue.tasks || typeof rerunValue.tasks !== "object" || Array.isArray(rerunValue.tasks)) {
              contentIntegrityReasons.push("[RERUN_INVALID] verify/rerun.json has no tasks object")
            } else {
              for (const [id, report] of Object.entries(reportValues)) {
                if (!isSafeTaskId(id)) continue
                const projection = reportCommandProjection(report)
                if (projection.length === 0) continue
                if (!rerunMatchesReport(report, rerunValue.tasks[id]?.checks)) {
                  contentIntegrityReasons.push(
                    `[AUTH_STALE] verify/rerun.json no longer mirrors the command checks in verify/report-${id}.json`,
                  )
                }
              }
              for (const id of Object.keys(rerunValue.tasks)) {
                if (!isSafeTaskId(id) || reportCommandProjection(reportValues[id]).length === 0) {
                  contentIntegrityReasons.push(
                    `[AUTH_STALE] verify/rerun.json records commands for ${clean(id, 64)}, which no report claims`,
                  )
                }
              }
            }
          } else if (provenance === "command") {
            contentIntegrityReasons.push(
              '[RERUN_MISSING] requiredProvenance is "command" but verify/rerun.json is missing',
            )
          }
          // 0.18.0: signed CI attestation. The policy is part of the signed
          // manifest; `off` ignores the artifact, `optional` records a status
          // without failing, and `required` makes every non-ATTESTED outcome a
          // named refusal. The engine never runs the attested commands; it
          // binds the CI observation to the reports and the signed plan.
          let attestationEvidence: Record<string, unknown> | undefined
          const attestationPolicy: AttestationPolicyMode = signedRun
            ? manifestAttestationMode(manifestCheck.manifest)
            : "off"
          if (attestationPolicy !== "off") {
            const rawAttestation = readBoundedRunFile(run, join(run, ATTESTATION_PATH), MAX_RUN_FILE_BYTES)
            let attestationArtifact: any
            if (rawAttestation.status === "ok") {
              try {
                attestationArtifact = JSON.parse(rawAttestation.text)
              } catch {
                // A present but unparseable artifact is untrusted, not absent.
                attestationArtifact = {}
              }
            }
            const attestationKeyRaw = String(process.env[ENV_ATTESTATION_PUBLIC_KEY] ?? "").trim()
            const attestationPublicKey = attestationKeyRaw ? loadAttestationPublicKey(attestationKeyRaw) : undefined
            const envAttestationKeyId = attestationKeyRaw
              ? attestationKeyIdFromPublicKey(attestationKeyRaw, process.env[ENV_ATTESTATION_KEY_ID])
              : undefined
            const attestedManifest = manifestCheck.manifest
            const attestationReports = Object.entries(reportValues).map(([id, report]) => ({
              taskId: id,
              headSha: typeof report?.headSha === "string" && report.headSha !== "" ? report.headSha : undefined,
              checks: Array.isArray(report?.checks)
                ? report.checks
                    .filter((check: any) => Array.isArray(check?.command))
                    .map((check: any) => ({
                      argv: check.command,
                      cwd: typeof check.cwd === "string" ? check.cwd : ".",
                      exitCode: Number.isInteger(check.exitCode) ? check.exitCode : undefined,
                      output: typeof check.output === "string" ? check.output : "",
                      outputTruncated: check.outputTruncated === true,
                    }))
                : [],
            }))
            const evaluated = evaluateAttestation({
              artifact: attestationArtifact,
              policy: attestationPolicy,
              publicKey: attestationPublicKey,
              expectedKeyId: attestedManifest.attestationKeyId ?? envAttestationKeyId,
              expectedIssuer:
                attestedManifest.attestationIssuer ??
                (String(process.env[ENV_ATTESTATION_ISSUER] ?? "").trim() || undefined),
              runId: basename(run),
              runNonce: attestedManifest.runNonce,
              runKeyId: attestedManifest.runKeyId,
              planHash: attestedManifest.planHash,
              promptHash: typeof attestedManifest.specHash === "string" ? attestedManifest.specHash : undefined,
              reports: attestationReports,
            })
            attestationEvidence = {
              policy: attestationPolicy,
              status: evaluated.status,
              ...(evaluated.code ? { code: evaluated.code } : {}),
              ...(evaluated.commitSha ? { commitSha: evaluated.commitSha } : {}),
              ...(evaluated.keyId ? { keyId: evaluated.keyId } : {}),
              ...(evaluated.issuer ? { issuer: evaluated.issuer } : {}),
            }
            if (attestationPolicy === "required" && evaluated.status !== "ATTESTED") {
              contentIntegrityReasons.push(
                `[${evaluated.code ?? "AUTH_ATTESTATION_MISSING"}] ${evaluated.message ?? "the CI attestation is not valid"}`,
              )
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
          reasons.push(...contentIntegrityReasons)
          if (signedRun) {
            reasons.push(
              ...(await evaluateTrustGate(
                ctx,
                run,
                basename(run),
                manifestCheck.manifest,
                auth,
                trustLevel,
                observedAlgs,
                root,
                process.env,
              )),
            )
          }

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

          // Continuity handoffs are required (or explicitly skipped) by the
          // plan baseline. The matrix is derived from plan/state; handoff prose
          // is never read as a verdict.
          const handoffGate = await evaluateHandoffGateCheckedFor(
            run,
            plan,
            state,
            auth,
            manifestCheck.signed ? manifestCheck.manifest : undefined,
          )
          if (!handoffGate.skipped) reasons.push(...handoffGate.reasons)

          // 0.12.0: re-check every PASS report's worker-handoff binding against
          // the current index and body hash. A re-recorded worker handoff makes
          // the old report stale.
          if (resolveHandoffMode(plan, state).mode === "required") {
            for (const t of tasks) {
              if (t.reportStatus !== "PASS") continue
              const recorded = reportValues[t.id]?.workerHandoff
              if (!recorded || typeof recorded !== "object" || typeof recorded.agent !== "string") {
                reasons.push(
                  `[REPORT_HANDOFF_MISSING] task ${t.id}: PASS report has no workerHandoff binding but requireHandoffs is "required"; re-record the report through teamwork_report after the worker handoff`,
                )
                continue
              }
              const current = readWorkerHandoffBinding(run, t.id, recorded.agent)
              if (current.reason) {
                reasons.push(`[REPORT_HANDOFF_STALE] task ${t.id}: ${current.reason}`)
                continue
              }
              if (!current.binding) {
                reasons.push(
                  `[REPORT_HANDOFF_STALE] task ${t.id}: the worker handoff (${clean(recorded.agent, 64)}) bound into the report is no longer in handoffs/index.json`,
                )
                continue
              }
              if (
                current.binding.path !== recorded.path ||
                current.binding.sha256 !== recorded.sha256
              ) {
                reasons.push(
                  `[REPORT_HANDOFF_STALE] task ${t.id}: ${current.binding.path} changed since the verifier report was recorded; the report is not bound to the current worker handoff`,
                )
              }
            }
          }

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
              if (requireSigned) {
                const envelopeReason = await routeEvidenceAuthReason(
                  auth,
                  basename(run),
                  "document-review/manifest.json",
                  docManifest,
                  "DOCUMENT_REVIEW_EVIDENCE_UNSIGNED",
                )
                if (envelopeReason) reasons.push(envelopeReason)
              }
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
                } else if (requireSigned) {
                  reasons.push(
                    routeTextEvidenceAuthReason(
                      "DOCUMENT_REVIEW_EVIDENCE_UNSIGNED",
                      `document-review/segments/${seg.id}/unit-report.md`,
                    ),
                  )
                }
              }
              const finalDocPath = join(run, "DOCUMENT_REVIEW_REPORT.md")
              const finalReportPresent = isRegularNonEmpty(finalDocPath)
              if (!finalReportPresent) {
                reasons.push("DOCUMENT_REVIEW_REPORT.md missing or empty")
              } else if (requireSigned) {
                reasons.push(routeTextEvidenceAuthReason("DOCUMENT_REVIEW_EVIDENCE_UNSIGNED", "DOCUMENT_REVIEW_REPORT.md"))
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
            if (requireSigned) {
              // The exact LEMMA evidence final verification reads: the
              // manifest, the formalization review, and every node verify
              // report selected by the manifest. All are written as plain JSON
              // today, so a signed run fails closed until they are signed.
              const lemmaEvidenceFiles: Array<[string, unknown]> = []
              const lemmaManifestRes = readBoundedRunJson<any>(run, join(run, "lemma", "manifest.json"), MAX_RUN_JSON_BYTES)
              if (lemmaManifestRes.status === "ok") {
                lemmaEvidenceFiles.push(["lemma/manifest.json", lemmaManifestRes.value])
              }
              const lemmaReviewRes = readBoundedRunJson<any>(
                run,
                join(run, "lemma", "formalization-review.json"),
                MAX_RUN_JSON_BYTES,
              )
              if (lemmaReviewRes.status === "ok") {
                lemmaEvidenceFiles.push(["lemma/formalization-review.json", lemmaReviewRes.value])
              }
              for (const node of lemmaEvidence.nodes) {
                if (!node.verifyReport) continue
                const lemmaReportRes = readBoundedRunJson<any>(
                  run,
                  join(run, node.verifyReport),
                  MAX_RUN_JSON_BYTES,
                )
                if (lemmaReportRes.status === "ok") lemmaEvidenceFiles.push([node.verifyReport, lemmaReportRes.value])
              }
              for (const [relPath, payload] of lemmaEvidenceFiles) {
                const envelopeReason = await routeEvidenceAuthReason(
                  auth,
                  basename(run),
                  relPath,
                  payload,
                  "LEMMA_EVIDENCE_UNSIGNED",
                )
                if (envelopeReason) reasons.push(envelopeReason)
              }
            }
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
              await withPinnedCrossProcessLock(run, runRel(run, mFile), async () => {
                const mRes = readTournamentManifest(run)
                if (mRes.status === "ok" && TOURNAMENT_ACTIVE_PHASES.has(mRes.manifest.phase) && context?.signal?.aborted) {
                  const callerAbort = await deriveCallerAgent(ctx, run, callSession, context)
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
                      agentSource: callerAbort?.source,
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
              if (requireSigned) {
                const manifestReason = await routeEvidenceAuthReason(
                  auth,
                  basename(run),
                  "tournament/manifest.json",
                  m,
                  "TOURNAMENT_EVIDENCE_UNSIGNED",
                )
                if (manifestReason) reasons.push(manifestReason)
                if (vRes.status === "ok") {
                  const verdictReason = await routeEvidenceAuthReason(
                    auth,
                    basename(run),
                    "tournament/verdict.json",
                    vRes.verdict,
                    "TOURNAMENT_EVIDENCE_UNSIGNED",
                  )
                  if (verdictReason) reasons.push(verdictReason)
                }
              }
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
            skipReason:
              recordedVictorySkipReason(plan?.victorySkipReason) ??
              recordedVictorySkipReason(state?.victorySkipReason),
          })
          if (!victoryGate.ok) reasons.push(...victoryGate.reasons)

          // 0.12.0: contradictions are named refusals, never silently fixed.
          const contradictions = detectEvidenceContradictions({
            run,
            root,
            runId: basename(run),
            tasks,
            reports: reportValues,
            audit,
            victory: readVictoryVerdict(run),
            strictGate,
          })
          for (const contradiction of contradictions) {
            reasons.push(`[${contradiction.code}] ${contradiction.detail}`)
          }

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
                  handoffs: {
                    mode: handoffGate.skipped ? "skip" : "required",
                    status: handoffGate.status,
                    entries: handoffGate.entries.map((e) => ({
                      taskId: e.taskId,
                      agent: e.agent,
                      path: e.path,
                      sha256: e.sha256,
                      ...(e.auth ? { auth: e.auth } : {}),
                      ...(e.keyId ? { keyId: e.keyId } : {}),
                    })),
                  },
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
                    handoffs: {
                      mode: handoffGate.skipped ? "skip" : "required",
                      status: handoffGate.status,
                      entries: handoffGate.entries.map((e) => ({
                        taskId: e.taskId,
                        agent: e.agent,
                        path: e.path,
                        sha256: e.sha256,
                        ...(e.auth ? { auth: e.auth } : {}),
                        ...(e.keyId ? { keyId: e.keyId } : {}),
                      })),
                    },
                  }),
                )
              } catch {}
            }
          }

          const victoryRecord = victoryGate.skipped
            ? victorySkipLabel(victoryGate.reason)
            : victoryGate.ok
              ? "CONFIRMED"
              : "FAILED"
          // Witness evidence is reported, not implied. A receipt with no
          // configured witness public key is labelled `unverified`; only a
          // signature over this run/path/digest/nonce is `verified`.
          let witnessEvidence: Record<string, unknown> | undefined
          if (signedRun) {
            const witnessCheck = auth
              ? await auth.verifyWitnessReceipt(basename(run), RUN_MANIFEST, {
                  digest: manifestCheck.manifest._auth?.digest,
                  nonce: manifestCheck.manifest._auth?.nonce ?? manifestCheck.manifest.runNonce,
                })
              : {
                  status: "unknown" as const,
                  failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
                }
            const required = manifestCheck.manifest.requireWitness === true
            if (required || (witnessCheck.status !== "missing" && witnessCheck.status !== "unknown")) {
              const failureCode =
                witnessCheck.failure?.code ?? (required && witnessCheck.status === "unverified" ? "AUTH_WITNESS_UNVERIFIED" : undefined)
              witnessEvidence = {
                required,
                status: witnessCheck.status,
                ...(witnessCheck.keyId ? { keyId: witnessCheck.keyId } : {}),
                ...(witnessCheck.at ? { at: witnessCheck.at } : {}),
                ...(failureCode ? { failure: failureCode } : {}),
              }
            }
          }
          const finalPayload: any = {
            status,
            generatedBy: { agent: caller?.agent ?? null, session: callSession || basename(run) },
            generatedAt: new Date().toISOString(),
            integrityMode: integrity.mode,
            victory: victoryRecord,
            handoffs: handoffGate.skipped ? "SKIPPED (explicit)" : handoffGate.status,
            requirementsHash: currentRequirementsHash(run),
            evidence: {
              tasks,
              securityAudit,
              allTasksVerifiedPass,
              reportDigests,
              auditDigest,
              rerunDigest,
              victory: victoryGate.skipped
                ? { mode: "skip", status: victoryGate.status, reason: victoryGate.reason ?? null, reasons: [] }
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
              ...(witnessEvidence ? { witness: witnessEvidence } : {}),
              ...(attestationEvidence ? { attestation: attestationEvidence } : {}),
              handoffs: handoffGate.skipped
                ? { mode: "skip", status: "SKIPPED", required: [], entries: [], reasons: [] }
                : {
                    mode: "required",
                    status: handoffGate.status,
                    required: handoffGate.required,
                    entries: handoffGate.entries,
                    reasons: handoffGate.reasons,
                  },
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
                          cites: t.challenge.cites,
                          warnings: t.challenge.warnings,
                        },
                        audit: {
                          path: t.audit.path,
                          status: t.audit.verdict,
                          agent: t.audit.agent,
                          reportHash: t.audit.reportHash,
                          ok: t.audit.ok,
                          cites: t.audit.cites,
                          warnings: t.audit.warnings,
                        },
                      })),
                    },
                  }
                : {}),
            },
            reasons: cappedReasons,
            ...(contradictions.length ? { contradictions } : {}),
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
          writeJson(run, finalFile, finalToWrite)

          await appendEvent(run, {
            event: "final_verification",
            sessionId: basename(run),
            taskId: null,
            to: status,
            round: 0,
            agent: caller?.agent ?? null,
            agentSource: caller?.source,
            phase: state.phase ?? null,
          })
          await refreshBriefingSafe(run)

          const integrityModeNote =
            integrity.source === "artifact"
              ? `Integrity mode: ${integrity.mode} (from ORIGINAL_REQUEST.md).`
              : `Integrity mode: ${integrity.mode} (default applied; no ORIGINAL_REQUEST.md for this run).`
          const evidenceLine = `Evidence: ${tasks.length} task(s), allTasksVerifiedPass=${allTasksVerifiedPass}, security audit ${securityAudit.status}, ${verificationMode === "strict" ? `strict wave ${strictGate.status}, ` : ""}handoffs ${handoffGate.skipped ? "SKIPPED (explicit)" : handoffGate.status}, ${describeVictoryGate(victoryGate)}`

          if (status === "FAIL") {
            return {
              content: `FINAL VERIFICATION FAILED: ${reasons.length} unmet condition(s). Final merge is BLOCKED.\nReasons:\n${cappedReasons.map((r) => `  - ${r}`).join("\n")}\n${evidenceLine}\n${integrityModeNote}\nArtifact: ${finalFile}${verificationMode === "strict" ? `\nGate status: ${join(run, "GATE_STATUS.md")}` : ""}`,
              status: "FAIL",
              finalReport: finalFile,
              integrityMode: integrity.mode,
              victory: victoryRecord,
              handoffs: handoffGate.skipped ? "SKIPPED (explicit)" : handoffGate.status,
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
            handoffs: handoffGate.skipped ? "SKIPPED (explicit)" : handoffGate.status,
            ...(verificationMode === "strict" ? { strictGate: strictGate.status } : {}),
          }
        })
      },
    })

    editor.add({
      name: "worktree",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Deterministic git worktree manager for Teamwork runs: setup, diff, merge, resolve, and cleanup. Prevents in-repo nesting and isolates worker branches.",
      input: strictInput({
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
          allowSharedWorktrees: {
            type: "boolean",
            description:
              "Default false. When the run was recorded on a different host, setup/merge/resolve/cleanup refuse unless this is explicitly true (and the plan did not set requireSameHost). Recorded in the tool result; never changes the run's host baseline.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const rawAction = clean(input.action, 16)
        const authz = await authorizeToolAction(ctx, run, "worktree", rawAction, context)
        if (!authz.ok) return { content: authz.content }
        const runId = basename(run)

        const action = rawAction
        // SEC-1: validate at the entry point, before any path or branch is built.
        // Raw value is checked (not clean()ed) so nothing is silently truncated.
        const rawTaskId = input.taskId ? String(input.taskId) : undefined
        if (rawTaskId !== undefined && !isSafeTaskId(rawTaskId)) {
          return { content: `refused: invalid task id "${clean(rawTaskId, 32)}" (must be a single segment matching ${TASK_ID})` }
        }
        const taskId = rawTaskId

        const worktreesBase = worktreesBaseDir(root)
        const runWorktreesDir = join(worktreesBase, runId)
        const baseBranch = `teamwork/base-${runId}`

        const execGit = (args: string[], cwd = root) => {
          const gitBin = resolveTrustedExecutable("git")
          if (!gitBin) {
            return { stdout: "", stderr: "git executable not found", code: 1 }
          }
          try {
            return {
              stdout: execFileSync(gitBin, args, { cwd, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim(),
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

        // Cross-host policy: a run records the host it was planned on. A
        // different host may be a shared filesystem where the lock/claim
        // primitives are not a reliable mutex, so destructive worktree actions
        // refuse unless the operator explicitly allows it (and the plan did not
        // require the same host).
        const worktreeState = readJson<any>(run, join(run, "state.json"), undefined)
        const worktreePlan = readJson<any>(run, join(run, "plan.dag.json"), undefined)
        const worktreeHost = runHostOf(worktreeState, worktreePlan)
        const sameHostRequired =
          worktreePlan?.requireSameHost === true || worktreeState?.requireSameHost === true
        if (
          ["setup", "merge", "resolve", "cleanup"].includes(action) &&
          worktreeHost !== SELF_HOST &&
          (sameHostRequired || input.allowSharedWorktrees !== true)
        ) {
          return {
            content: `refused: FOREIGN_HOST: this run was recorded on ${clean(worktreeHost, 80)} but the current host is ${clean(SELF_HOST, 80)}.${
              sameHostRequired
                ? " The plan sets requireSameHost: true, so the shared-worktree override is unavailable."
                : " Re-call with allowSharedWorktrees: true only after confirming both hosts see the same filesystem."
            } Nothing was changed.`,
            refused: "FOREIGN_HOST",
            host: worktreeHost,
            currentHost: SELF_HOST,
          }
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
            // Record the side-effect baseline at setup (before the worker edits)
            // and renew the claim that `teamwork_next` handed to the caller.
            let baselineRecorded = false
            await mutateRunState(run, (state) => {
              if (claimProtocolOf(state) < CLAIM_PROTOCOL) return
              const task = state.tasks?.[taskId]
              if (!task || typeof task !== "object") return
              const claim = normalizeClaim(task.claim)
              if (!claim) return
              const candidate = { ...task, worktree: targetDir }
              const baseline = captureClaimBaseline(
                root,
                run,
                candidate,
                taskId,
                role === "verifier" ? "worker_done" : "worker_active",
                worktreePlan,
              )
              if (baseline && baseline.fingerprint !== "unknown") {
                task.claim = { ...task.claim, baseline }
                baselineRecorded = true
              }
            })
            const renewal = await renewClaimFor(run, taskId, authz.sessionID, ctx, `worktree setup (${role})`)
            return {
              content: `${role} worktree ready at: ${targetDir}\nBranch: ${branch}\nBase: ${startPoint}${
                baselineRecorded ? "\nClaim baseline recorded (side-effect fingerprint)." : ""
              }${renewal.renewed ? "\nClaim lease renewed." : ""}`,
              worktreePath: targetDir,
              branch,
              baseBranch: startPoint,
              baselineRecorded,
              claimRenewed: renewal.renewed,
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
          const headSha = execGit(["rev-parse", branch]).code === 0 ? execGit(["rev-parse", branch]).stdout : undefined
          const baseSha = execGit(["rev-parse", baseRef]).code === 0 ? execGit(["rev-parse", baseRef]).stdout : undefined
          const diffHash = sha256Hex(diffRes.stdout)
          await renewClaimFor(run, taskId, authz.sessionID, ctx, "worktree diff")

          return {
            content: `Diff for ${taskId} (${baseRef}..${branch}):\n${statRes.stdout || "No changes."}\n\n${diffRes.stdout || ""}`,
            hasChanges: diffRes.stdout.length > 0,
            stat: statRes.stdout,
            branch,
            baseRef,
            ...(headSha ? { headSha } : {}),
            ...(baseSha ? { baseSha } : {}),
            diffHash,
          }
        }

        if (action === "merge") {
          if (!taskId) return { content: "Error: taskId is required for merge." }
          const branch = `teamwork/${runId}-${taskId}`
          const sentinel = verifiedSentinelWorktree()
          if (!sentinel.path) return { content: sentinel.error }
          const targetCwd = sentinel.path

          // The verified report is bound to the branch it was computed against.
          // A branch that moved after PASS must be re-verified, not merged.
          const reportPath = join(run, "verify", `report-${taskId}.json`)
          const verifiedReport = existsSync(reportPath) ? readJson<any>(run, reportPath, undefined) : undefined
          const branchHead = execGit(["rev-parse", "--verify", branch])
          if (verifiedReport?.status === "PASS" && branchHead.code === 0) {
            const headNow = branchHead.stdout
            if (typeof verifiedReport.headSha === "string" && verifiedReport.headSha && verifiedReport.headSha !== headNow) {
              return {
                status: "BRANCH_MOVED",
                content: `BRANCH_MOVED: refusing to merge ${branch}. The verified report was computed at ${verifiedReport.headSha.slice(0, 12)}, but the branch head is now ${headNow.slice(0, 12)}. Re-run verification and write a fresh report. Nothing was merged.`,
                verifiedHead: verifiedReport.headSha,
                currentHead: headNow,
              }
            }
            if (typeof verifiedReport.diffHash === "string" && verifiedReport.diffHash) {
              const hasBase = execGit(["rev-parse", "--verify", baseBranch]).code === 0
              if (hasBase) {
                const diffNow = execGit(["diff", "--no-color", `${baseBranch}..${branch}`]).stdout
                if (sha256Hex(diffNow) !== verifiedReport.diffHash) {
                  return {
                    status: "BRANCH_MOVED",
                    content: `BRANCH_MOVED: refusing to merge ${branch}. The branch diff changed since the verified report. Re-run verification. Nothing was merged.`,
                  }
                }
              }
            }
          }

          const mergeRes = execGit(["merge", "--no-ff", branch, "-m", `Merge task ${taskId} (${branch})`], targetCwd)
          if (mergeRes.code !== 0) {
            const conflictingFiles = mergeRes.stdout
              .split("\n")
              .filter((l) => l.includes("CONFLICT"))
              .map((l) => clean(l.replace(/CONFLICT\s*\([^)]*\):\s*/, ""), 120))

            const oursDiff = execGit(["diff", `${branch}...${baseBranch}`], targetCwd).stdout
            const theirsDiff = execGit(["diff", `${baseBranch}...${branch}`], targetCwd).stdout

            execGit(["merge", "--abort"], targetCwd)

            createDirWithin(run, "synthesis")
            const synDir = join(run, "synthesis")
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
            writeJson(run, conflictFile, conflictArtifact)

            // OpenCode's Tool runtime dies when a result has `output` but the
            // tool declared no output schema (packages/core/src/tool/runtime.ts:
            // execute() -- `if ("output" in result) Effect.die(...)`). This path
            // has no schema, so the raw git output belongs in `content`.
            return {
              content: `MERGE CONFLICT for task ${taskId} into ${baseBranch}:\n${conflictingFiles.join("\n") || mergeRes.stderr || mergeRes.stdout}\n\nConflict artifact generated at: ${conflictFile}\n(Merge was aborted; worktree remains clean. Sentinel should dispatch team/synthesizer to resolve conflict.)`,
              conflict: true,
              conflictArtifact: conflictFile,
              conflictingFiles,
              mergeOutput: mergeRes.stdout,
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
          // Never remove a worktree another claim is still using. One predicate:
          // live, expired (inside the grace window), needs-inspection, and
          // cross-host all block; only a stale claim is recoverable.
          const cleanupState = readJson<any>(run, join(run, "state.json"), undefined)
          const nowMs = Date.now()
          const blockingClaims = Object.entries(cleanupState?.tasks ?? {})
            .map(([id, task]: [string, any]) => ({
              id,
              claim: normalizeClaim(task?.claim),
              claimState: deriveClaimState(task, nowMs, {
                legacyHostless: claimProtocolOf(cleanupState) < CLAIM_PROTOCOL,
              }).state,
            }))
            .filter(
              (entry) =>
                entry.claim &&
                (BLOCKING_CLAIM_STATES.has(entry.claimState) || entry.claim.needsInspection === true),
            )
          if (blockingClaims.length) {
            return {
              content: `refused: cleanup is blocked by claim(s) that are not stale: ${blockingClaims
                .map((entry) => `${clean(entry.id, 64)} (${entry.claim!.by}, state=${entry.claimState} until ${entry.claim!.leaseUntil})`)
                .join(", ")}. Wait for release, or use teamwork_recover to release/requeue explicitly. Nothing was removed.`,
              refused: "LIVE_CLAIM",
              liveClaims: blockingClaims.map((entry) => ({
                id: entry.id,
                claim: publicClaim(entry.claim),
                claimState: entry.claimState,
              })),
            }
          }
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Read-only probe for the external LEMMA toolchain (`lean`, `lake`, and the LEAP CLI `leap`, or legacy `leap-tools`) on PATH. Runs `leap doctor --offline`; a `LEAN_PROJECT_DIR`-only failure is a WARN (core Lean + LEAP CLI usable, Mathlib optional). Never touches disk and never installs packages.",
      input: strictInput({
        type: "object",
        properties: {
          timeoutMs: { type: "number", description: "Optional per-binary probe timeout in ms (250..30000)." },
        },
        additionalProperties: false,
      }),
      execute: async (input: any, context: any) => {
        const authz = await authorizeToolAction(ctx, undefined, "lemma_probe", undefined, context)
        if (!authz.ok) return { content: authz.content }
        const probe = probeLemmaToolchain({ timeoutMs: input?.timeoutMs })
        if (!probe.ready) {
          // A7: give the operator an actionable PREREQUISITES.md at the repo root.
          const prereqWritten = writePrerequisitesSafe(root, lemmaPrerequisitesBody(probe))
          return {
            content: `${formatMissingToolchainRefusal(probe)}${prereqWritten ? `\nPrerequisites recorded at ${join(root, "PREREQUISITES.md")}.` : ""}`,
            ...probe,
          }
        }
        const doctor = probe.leap.doctor
        const doctorText = doctor
          ? `; leap doctor ${doctor.status}${doctor.failedChecks?.length ? ` [failed: ${doctor.failedChecks.slice(0, 8).join(", ")}]` : ""}${doctor.warning ? ` — ${clean(doctor.warning, 240)}` : ""}${doctor.output ? ` (${cleanBlock(doctor.output, 240).trim().replace(/\s+/g, " ")})` : ""}`
          : ""
        return {
          content: `LEMMA toolchain READY: lean (${probe.lean.version}), lake (${probe.lake.version}), ${probe.leap.name} (${probe.leap.version})${doctorText}.`,
          ...probe,
        }
      },
    })

    editor.add({
      name: "lemma_formalize",
      options: { namespace: "teamwork", codemode: false },
      description:
        "Manage LEMMA Phase 0 formalization (problem_draft.lean -> preSearch APPROVE/REQUEST_CHANGES -> problem.lean) and final faithfulness review (FAITHFUL/UNFAITHFUL/MISFORMALIZED).",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const action = clean(input?.action, 32)
        const authz = await authorizeToolAction(ctx, run, "lemma_formalize", action, context)
        if (!authz.ok) return { content: authz.content }
        const manifestFile = join(run, "lemma", "manifest.json")
        const callSession = authz.sessionID

        return await withPinnedCrossProcessLock(run, runRel(run, manifestFile), async () => {
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
            const caller = await deriveCallerAgent(ctx, run, callSession, context)
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Manage bounded LEMMA decomposition tree nodes under lemma/nodes/<lemmaId>/ (create, update, blueprint, attempt) enforcing maxDepth, maxWidth, maxNodes, maxRetries, and cycle/symlink guards. Record `declaration` (Lean theorem/lemma name) and `statement` (exact Lean proposition type) so lemma_verify can bind the attempt to the approved proposition.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const action = clean(input?.action, 32)
        const authz = await authorizeToolAction(ctx, run, "lemma_node", action, context)
        if (!authz.ok) return { content: authz.content }
        if (action !== "create" && action !== "update" && action !== "blueprint" && action !== "attempt") {
          return { content: `refused: unknown action "${action}" (allowed: create | update | blueprint | attempt)` }
        }
        const manifestFile = join(run, "lemma", "manifest.json")
        return await withPinnedCrossProcessLock(run, runRel(run, manifestFile), async () => {
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
      options: { namespace: "teamwork", codemode: false },
      description:
        "Execute real Lean 4 (`lean`, `lake env lean`, or `lake build`) on lemma/nodes/<lemmaId>/attempt-<r>.lean, bind the declared theorem/lemma name and type to the approved node statement, check transitive axiom dependencies via `#print axioms` against the allowlist approved in lemma/manifest.json at plan time, reject sorry/admit/unauthorized axioms even on exit 0, and stamp verify-<r>.json.",
      input: strictInput({
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
      }),
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const authz = await authorizeToolAction(ctx, run, "lemma_verify", undefined, context)
        if (!authz.ok) return { content: authz.content }
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
        return await withPinnedCrossProcessLock(run, runRel(run, manifestFile), async () => {
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
  // The run is resolved from the caller's root-session mapping when possible;
  // otherwise this keeps the legacy newest-run behaviour. The per-agent briefing
  // is written lazily here and is fail-open: any refusal leaves the shared
  // briefing (and the rest of the context) exactly as before.
  await ctx.session?.hook?.("context", async (event: any) => {
    if (!(typeof event.agent === "string" && event.agent.startsWith("team/"))) return
    let runPath: string | undefined
    try {
      runPath = await runForSession(ctx, root, event.sessionID)
    } catch {}
    if (runPath && typeof event.sessionID === "string") {
      try {
        refreshAgentBriefing(runPath, event.agent, event.sessionID)
      } catch {}
    }
    const text = describeRun(root, {
      runId: runPath ? basename(runPath) : undefined,
      sessionID: typeof event.sessionID === "string" ? event.sessionID : undefined,
      agent: event.agent,
    })
    if (text) event.system.push({ type: "text", text })
  })
}
