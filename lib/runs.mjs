// lib/runs.mjs — Teamwork run management & inspection helpers
//
// Shared by CLI commands (opencode-teamwork runs/inspect/prune) and tests.
// Zero runtime dependencies.
//
// Security note: every run artifact read goes through the shared bounded reader
// (lib/bounded-read.mjs -> plugins/opencode-teamwork/safe-fs.mjs): O_NOFOLLOW,
// O_NONBLOCK, fstat and a byte cap, plus the post-open /proc/self/fd containment
// check on Linux. Symlinked/FIFO artifacts are refused rather than followed.
// On macOS/Windows the intermediate-directory race remains the documented
// residual risk (ADR 0004). The write path is not involved here.

import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { readBoundedWithin } from "./bounded-read.mjs"
import { BLOCKING_CLAIM_STATES, deriveClaimStateFromClaim } from "../plugins/opencode-teamwork/claim-state.mjs"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const MAX_RUN_JSON_BYTES = 16 * 1024 * 1024
const MAX_PITFALLS_BYTES = 1 * 1024 * 1024

/**
 * Display-only authenticity label. Standalone CLI readers do not have the
 * plugin KV key ring, so they never claim verification: "signed" only means an
 * `_auth` envelope is present, "unsigned" means there is none, and "unknown"
 * means the artifact exists but could not be read as an object.
 */
function authLabel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown"
  return value._auth && typeof value._auth === "object" ? "signed" : "unsigned"
}

function readJson(runReal, file, fallback = undefined, maxBytes = MAX_RUN_JSON_BYTES) {
  const r = readBoundedWithin(runReal, file, maxBytes)
  if (r.status !== "ok") return fallback
  try {
    return JSON.parse(r.text)
  } catch {
    return fallback
  }
}

// Resolve a run directory once; a symlinked / non-directory entry is skipped.
function runRealOf(runDir) {
  try {
    if (!lstatSync(runDir).isDirectory()) return null
    return realpathSync(runDir)
  } catch {
    return null
  }
}

export function listTeamworkRuns(projectRoot = process.cwd()) {
  const dir = join(projectRoot, ".opencode", "teamwork")
  if (!runRealOf(dir)) return []

  try {
    return readdirSync(dir)
      .filter((name) => SESSION_ID.test(name))
      .map((name) => {
        const runDir = join(dir, name)
        const runReal = runRealOf(runDir)
        if (!runReal) return null
        let mtime = 0
        try {
          mtime = lstatSync(runDir).mtimeMs
        } catch {}

        const state = readJson(runReal, join(runDir, "state.json"), {})
        const plan = readJson(runReal, join(runDir, "plan.dag.json"), {})
        const costs = readJson(runReal, join(runDir, "costs.json"), {})
        const manifest = readJson(runReal, join(runDir, "run.manifest.json"), undefined)
        const audit = readJson(runReal, join(runDir, "verify", "security-audit.json"), undefined)
        const authenticity = manifest === undefined ? "unsigned" : authLabel(manifest)

        const tasks = state.tasks ? Object.values(state.tasks) : []
        const totalTasks = plan.tasks ? plan.tasks.length : tasks.length
        const passedTasks = tasks.filter((t) => t?.status === "pass" || t?.status === "verified_pass").length
        const blockedTasks = tasks.filter((t) => t?.status === "blocked").length

        let securityStatus = "N/A"
        if (audit) {
          securityStatus = audit.status === "PASS" ? "PASS" : `FAIL (${(audit.severityCounts?.critical || 0) + (audit.severityCounts?.high || 0)} high/crit)`
        } else if (state.phase === "SECURITY_AUDIT") {
          securityStatus = "IN_PROGRESS"
        }

        const spent = Number(costs.spentUsd) || 0
        const budget = typeof costs.budgetUsd === "number" ? costs.budgetUsd : 20

        return {
          sessionId: name,
          path: runDir,
          phase: state.phase || "UNKNOWN",
          topology: plan.topology || "unknown",
          tasksPassed: passedTasks,
          tasksBlocked: blockedTasks,
          tasksTotal: totalTasks,
          securityStatus,
          authenticity,
          auditAuthenticity: audit === undefined ? "unknown" : authLabel(audit),
          spentUsd: spent,
          budgetUsd: budget,
          updatedAt: state.updatedAt || new Date(mtime).toISOString(),
          mtime,
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function inspectTeamworkRun(projectRoot = process.cwd(), sessionId = undefined) {
  const runs = listTeamworkRuns(projectRoot)
  if (!runs.length) return { error: "No Teamwork runs found." }

  const target = sessionId ? runs.find((r) => r.sessionId === sessionId) : runs[0]
  if (!target) return { error: `Run "${sessionId}" not found.` }

  const runDir = target.path
  const runReal = runRealOf(runDir)
  if (!runReal) return { error: `Run "${target.sessionId}" is not resolvable.` }
  const state = readJson(runReal, join(runDir, "state.json"), {})
  const plan = readJson(runReal, join(runDir, "plan.dag.json"), {})
  const costs = readJson(runReal, join(runDir, "costs.json"), {})
  const manifest = readJson(runReal, join(runDir, "run.manifest.json"), undefined)
  const audit = readJson(runReal, join(runDir, "verify", "security-audit.json"), undefined)

  let pitfalls = []
  try {
    const r = readBoundedWithin(runReal, join(runDir, "pitfalls.md"), MAX_PITFALLS_BYTES)
    if (r.status === "ok") {
      pitfalls = r.text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"))
    }
  } catch {}

  let conflicts = []
  try {
    const synDir = join(runDir, "synthesis")
    if (lstatSync(synDir).isDirectory()) {
      conflicts = readdirSync(synDir)
        .filter((f) => f.startsWith("conflict-") && f.endsWith(".json"))
        .map((f) => readJson(runReal, join(synDir, f), { file: f }))
    }
  } catch {}

  return {
    run: target,
    tasks: state.tasks || {},
    planTasks: plan.tasks || [],
    costs,
    audit,
    authenticity: manifest === undefined ? "unsigned" : authLabel(manifest),
    auditAuthenticity: audit === undefined ? "unknown" : authLabel(audit),
    pitfalls,
    conflicts,
  }
}

/**
 * Claim guard shared with `worktree cleanup` (claim-state.mjs). Prune must not
 * remove a worktree another claim is still using: live, expired (inside the
 * grace window), needs-inspection and cross-host all block. `--force` is an
 * explicit operator override; it records the blocking claims and the reason in
 * the result, never silently.
 */
function blockingClaimsForRun(projectRoot, sessionId, selfHost) {
  const runDir = join(projectRoot, ".opencode", "teamwork", sessionId)
  const runReal = runRealOf(runDir)
  if (!runReal) return { blocking: [], unreadable: true }
  const state = readJson(runReal, join(runDir, "state.json"), undefined)
  if (!state || typeof state !== "object" || !state.tasks || typeof state.tasks !== "object") {
    return { blocking: [], unreadable: true }
  }
  const now = Date.now()
  // Protocol 1 predates the host field; protocol 2 fails closed on a missing
  // host (cross-host), matching the claim engine.
  const legacyHostless = !(Number(state.claimProtocol) >= 2)
  const blocking = []
  for (const [id, task] of Object.entries(state.tasks)) {
    const claim = task && typeof task === "object" ? task.claim : undefined
    if (!claim || typeof claim !== "object") continue
    const derived = deriveClaimStateFromClaim(claim, {
      now,
      selfHost,
      flagged: claim.needsInspection === true,
      legacyHostless,
    })
    if (BLOCKING_CLAIM_STATES.has(derived.state) || claim.needsInspection === true) {
      blocking.push({
        id,
        by: typeof claim.by === "string" ? claim.by : "unknown",
        host: typeof claim.host === "string" ? claim.host : "missing",
        leaseUntil: typeof claim.leaseUntil === "string" ? claim.leaseUntil : null,
        state: derived.state,
      })
    }
  }
  return { blocking, unreadable: false }
}

export function pruneTeamworkWorktrees(projectRoot = process.cwd(), options = {}) {
  const base = process.env.TEAMWORK_WORKTREES_DIR || join(projectRoot, "..", ".teamwork-worktrees")
  try {
    if (!lstatSync(base).isDirectory()) return { count: 0, removed: [], refused: [], forced: [] }
  } catch {
    return { count: 0, removed: [], refused: [], forced: [] }
  }

  const execGit = (args) => {
    try {
      return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim()
    } catch {
      return ""
    }
  }

  const removed = []
  const refused = []
  const forced = []
  const selfHost = hostname()
  try {
    const entries = readdirSync(base)
    for (const entry of entries) {
      if (!SESSION_ID.test(entry)) continue
      if (options.sessionId && entry !== options.sessionId) continue

      const entryPath = join(base, entry)
      if (!options.all && !options.sessionId) {
        // If neither --all nor specific --session is set, check if run is done
        const runDir = join(projectRoot, ".opencode", "teamwork", entry)
        const runReal = runRealOf(runDir)
        if (!runReal) continue
        const state = readJson(runReal, join(runDir, "state.json"), {})
        const isFinished = ["MERGE", "DONE", "PRESENT_PARTIAL"].includes(state.phase)
        if (!isFinished) continue
      }

      // Fail closed on an unreadable state: an unreadable claim is not proof
      // that no claim exists.
      const guard = blockingClaimsForRun(projectRoot, entry, selfHost)
      if (guard.blocking.length > 0 || guard.unreadable) {
        const detail = guard.unreadable
          ? "state.json is missing or unreadable"
          : `claim(s) not stale: ${guard.blocking
              .map((claim) => `${claim.id} (${claim.by}, host=${claim.host}, state=${claim.state})`)
              .join(", ")}`
        if (options.force !== true) {
          refused.push({ sessionId: entry, reason: detail, claims: guard.blocking })
          continue
        }
        forced.push({
          sessionId: entry,
          reason:
            typeof options.reason === "string" && options.reason.trim()
              ? options.reason.trim().slice(0, 200)
              : `--force: ${detail}`,
          claims: guard.blocking,
        })
      }

      try {
        const subdirs = readdirSync(entryPath)
        for (const sub of subdirs) {
          const subPath = join(entryPath, sub)
          execGit(["worktree", "remove", "--force", subPath])
        }
      } catch {}

      try {
        rmSync(entryPath, { recursive: true, force: true })
        removed.push(entry)
      } catch {}
    }
    execGit(["worktree", "prune"])
  } catch {}

  return { count: removed.length, removed, refused, forced }
}
