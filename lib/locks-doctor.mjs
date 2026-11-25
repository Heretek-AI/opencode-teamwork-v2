// @heretek-ai/opencode-teamwork-v2 — lock inventory and safe manual unlock (Issue #41)
//
// Zero-dependency lock inspection and conservative unlock helper for
// `opencode-teamwork doctor --locks` and `opencode-teamwork doctor --unlock <path> --confirm`.
//
// Locks provide best-effort duplicate suppression, never exactly-once execution.
// `--unlock` is strictly limited to same-host, dead-pid, older-than-lease locks
// and unconditionally refuses foreign-host locks.

import { lstatSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs"
import { hostname } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { readRegularBounded } from "../plugins/opencode-teamwork/safe-fs.mjs"

const DEFAULT_LOCK_LEASE_MS = 30_000
const MAX_SCAN_DEPTH = 6
const MAX_SCAN_ENTRIES = 2000

function currentHost(env = process.env) {
  const override = typeof env?.OPENCODE_TEAMWORK_TEST_HOST === "string" ? env.OPENCODE_TEAMWORK_TEST_HOST.trim() : ""
  if (override) return override
  try {
    return hostname() || "unknown-host"
  } catch {
    return "unknown-host"
  }
}

function defaultProcessIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

function classifyFileName(name) {
  if (/\.lock\.stale\./.test(name)) return "stale-quarantine"
  if (/\.lock\.release\./.test(name)) return "release-quarantine"
  if (name.endsWith(".lock")) return "lock"
  if (name.endsWith(".tmp")) return "tmp"
  return null
}

function parseOwner(fullPath, stat) {
  let raw
  try {
    const ownerPath = stat.isDirectory() ? join(fullPath, "owner.json") : fullPath
    if (stat.isDirectory() || (stat.isFile() && stat.size <= 4096)) {
      // One fd-pinned bounded read: no lstat/readFile check-then-use window.
      const res = readRegularBounded(ownerPath, 4096)
      if (res.status === "ok") raw = res.text
    }
  } catch {
    return undefined
  }
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const pid = Number(parsed.pid)
    const host = typeof parsed.host === "string" ? parsed.host : ""
    const at = typeof parsed.at === "string" ? parsed.at : ""
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : ""
    if (!Number.isFinite(pid) || pid <= 0 || !host) return undefined
    return { pid, host, at, nonce }
  } catch {
    return undefined
  }
}

function classifyEntry(artifactType, owner, ageMs, leaseMs, host, isProcessAlive) {
  if (artifactType === "stale-quarantine") return "quarantine-stale"
  if (artifactType === "release-quarantine") return "quarantine-release"
  if (artifactType === "tmp") return ageMs > leaseMs ? "tmp-orphan" : "tmp-recent"
  if (!owner) return ageMs > leaseMs ? "unreadable-stale" : "unreadable-recent"
  if (owner.host !== host) return "foreign-host"
  const alive = isProcessAlive(owner.pid)
  if (alive) return ageMs > leaseMs ? "active-local-over-lease" : "active-local"
  return ageMs > leaseMs ? "stale-local-dead" : "dead-within-lease"
}

/**
 * Scan `rootDir` (typically `<repo>/.opencode/teamwork`) for lock and temp
 * artifacts without following symlinks.
 */
export function inventoryLocks(rootDir, options = {}) {
  const base = resolve(rootDir)
  const host = options.host || currentHost(options.env)
  const now = typeof options.now === "number" ? options.now : Date.now()
  const leaseMs = Number.isFinite(options.leaseMs) && options.leaseMs > 0 ? options.leaseMs : DEFAULT_LOCK_LEASE_MS
  const isProcessAlive = options.isProcessAlive || defaultProcessIsAlive
  const entries = []
  let visited = 0

  function walk(dir, depth) {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES) return
    let items
    try {
      items = readdirSync(dir)
    } catch {
      return
    }
    items.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of items) {
      if (visited >= MAX_SCAN_ENTRIES) break
      visited++
      const full = join(dir, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      const artifactType = classifyFileName(name)
      if (artifactType) {
        const owner = parseOwner(full, st)
        const ageMs = Math.max(0, now - st.mtimeMs)
        const hostMatch = owner ? owner.host === host : null
        const pidAlive = owner && hostMatch ? isProcessAlive(owner.pid) : null
        const classification = classifyEntry(artifactType, owner, ageMs, leaseMs, host, isProcessAlive)
        entries.push({
          path: full,
          relativePath: relative(base, full),
          kind: st.isDirectory() ? "directory" : "file",
          artifactType,
          mtimeMs: st.mtimeMs,
          ageMs,
          owner: owner ?? null,
          hostMatch,
          pidAlive,
          classification,
        })
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
    }
  }

  walk(base, 0)
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
  return { root: base, host, leaseMs, count: entries.length, entries }
}

/**
 * Manually unlock a single lock artifact. Strictly limited to same-host,
 * dead-pid, older-than-lease locks, and requires explicit `confirm: true`.
 * Never removes a foreign-host lock, a live-pid lock, a lock within its lease,
 * or a symlink.
 */
export function unlockLock(lockPath, options = {}) {
  if (options.confirm !== true) {
    return { ok: false, code: "CONFIRM_REQUIRED", message: "refused: --unlock requires --confirm" }
  }
  const target = resolve(String(lockPath || ""))
  if (!basename(target).endsWith(".lock")) {
    return { ok: false, code: "NOT_A_LOCK", message: `refused: "${target}" does not end with .lock` }
  }
  let st
  try {
    st = lstatSync(target)
  } catch (err) {
    return { ok: false, code: "NOT_FOUND", message: `refused: lock "${target}" not found (${err?.code || "ENOENT"})` }
  }
  if (st.isSymbolicLink()) {
    return { ok: false, code: "SYMLINK_REFUSED", message: `refused: "${target}" is a symlink` }
  }
  const host = options.host || currentHost(options.env)
  const now = typeof options.now === "number" ? options.now : Date.now()
  const leaseMs = Number.isFinite(options.leaseMs) && options.leaseMs > 0 ? options.leaseMs : DEFAULT_LOCK_LEASE_MS
  const isProcessAlive = options.isProcessAlive || defaultProcessIsAlive
  const ageMs = Math.max(0, now - st.mtimeMs)
  const owner = parseOwner(target, st)

  if (!owner) {
    return {
      ok: false,
      code: "OWNER_UNREADABLE",
      message: `refused: "${target}" has no readable owner metadata; cannot verify same-host dead-pid precondition`,
    }
  }
  if (owner.host !== host) {
    return {
      ok: false,
      code: "FOREIGN_LOCK_REFUSED",
      message: `refused: "${target}" is owned by foreign host "${owner.host}" (this host is "${host}"); foreign locks are never unlocked automatically`,
    }
  }
  if (isProcessAlive(owner.pid)) {
    return {
      ok: false,
      code: "OWNER_ALIVE",
      message: `refused: "${target}" owner pid ${owner.pid} on host "${host}" is still alive`,
    }
  }
  if (ageMs <= leaseMs) {
    return {
      ok: false,
      code: "WITHIN_LEASE",
      message: `refused: "${target}" age ${ageMs}ms is within the ${leaseMs}ms lease window`,
    }
  }

  // Atomic quarantine rename before removal so a concurrently created new lock
  // cannot be unlinked by path.
  const quarantine = `${target}.stale.manual-${randomBytes(6).toString("hex")}`
  try {
    renameSync(target, quarantine)
    if (st.isDirectory()) rmSync(quarantine, { recursive: true, force: true })
    else unlinkSync(quarantine)
  } catch (err) {
    return { ok: false, code: "UNLOCK_FAILED", message: `failed to remove "${target}": ${err?.message || err}` }
  }

  return {
    ok: true,
    code: "UNLOCKED",
    path: target,
    owner,
    ageMs,
    message: `unlocked stale same-host dead-pid lock "${target}" (pid=${owner.pid}, age=${ageMs}ms)`,
  }
}

export function formatLocksReport(inventory) {
  const lines = [
    `Lock inventory under ${inventory.root} (host=${inventory.host}, lease=${inventory.leaseMs}ms)`,
    "Note: locks provide best-effort duplicate suppression, never exactly-once execution.",
  ]
  if (inventory.entries.length === 0) {
    lines.push("No lock or temp artifacts found.")
    return lines.join("\n")
  }
  for (const e of inventory.entries) {
    const ownerText = e.owner ? `host=${e.owner.host} pid=${e.owner.pid}` : "owner=unreadable"
    lines.push(`- [${e.classification}] ${e.relativePath} (${e.artifactType}, ${e.kind}, age=${Math.round(e.ageMs)}ms, ${ownerText})`)
  }
  return lines.join("\n")
}
