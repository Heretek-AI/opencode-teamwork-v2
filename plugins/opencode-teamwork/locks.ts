// opencode-teamwork — serialisation primitives
//
// Two layers of locking protect read-modify-write of run artifacts:
//
//   1. `withFileLock` is an in-process FIFO keyed by path. It prevents two
//      tool calls in this plugin process from interleaving.
//   2. `withCrossProcessLock` adds an on-disk `<target>.lock` artifact. It
//      prevents two separate OpenCode processes (or two Node child processes
//      in the regression suite) from losing each other's update to
//      `state.json`, `costs.json`, or the handoff index.
//
// The cross-process lock is intentionally a *short* critical-section lock:
// acquire, read, modify, write, release. Never await network/client work while
// holding it. The in-process queue is acquired first, so a process cannot
// deadlock against its own lock file; the single on-disk key per target is the
// same key used by the in-process queue.
//
// Publication (0.10.0): the owner JSON is written in full to a unique temp
// file (`wx`) and then `link(2)`ed into place, so a reader can never observe a
// zero-length or half-written lock. `EEXIST` means the lock is held. On
// filesystems without hard links the primitive falls back to an atomic
// `mkdir(2)`; the capability is detected once and cached.
//
// Staleness is measured from the server's `lstat(lockPath).mtimeMs`, never from
// the owner's self-reported `at`, so a falsified timestamp cannot defeat the
// lease. Reclaim is a single atomic `rename(2)` into a quarantine name: exactly
// one reclaimer can win, and a live lock that replaced the observed one is
// never unlinked by path.
//
// Zero runtime dependencies. Erasable TypeScript only.

import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { randomBytes, randomInt } from "node:crypto"

const fileLocks = new Map<string, Promise<unknown>>()

/** Run `fn` after every previously queued call for `key` has settled. */
export function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
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

export interface CrossProcessLockOptions {
  /** Reclaim a lock older than this when its owner is not alive on this host. */
  leaseMs?: number
  /** Fail closed after waiting this long for the lock. */
  timeoutMs?: number
  /** First retry delay; doubled up to retryMaxMs. */
  retryBaseMs?: number
  retryMaxMs?: number
  /** Test seams. Production callers use the defaults. */
  now?: () => number
  host?: string
  pid?: number
  isProcessAlive?: (pid: number) => boolean
  /** Test seam: pretend this filesystem has no hard links. */
  disableHardlinks?: boolean
  /** Optional diagnostic sink (also recorded in the bounded module ring). */
  onDiagnostic?: (diagnostic: LockDiagnostic) => void
}

export interface LockOwner {
  pid: number
  host: string
  at: string
  nonce: string
}

export type LockDiagnosticEvent =
  | "stale_reclaimed"
  | "unreadable_lock_reclaimed"
  | "stale_reclaim_raced"
  | "hardlink_unsupported"

export interface LockDiagnostic {
  at: string
  path: string
  event: LockDiagnosticEvent
  nonce: string | null
  detail?: string
}

/** Read-only observation of a lock artifact. */
export interface LockArtifactObservation {
  path: string
  kind: "file" | "directory"
  mtimeMs: number
  ino?: number
  nonce: string
  owner?: LockOwner
  readable: boolean
}

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_BASE_MS = 10
const DEFAULT_RETRY_MAX_MS = 100
const MAX_DIAGNOSTICS = 100

const diagnostics: LockDiagnostic[] = []

/** Recent lock diagnostics (bounded ring, oldest first). */
export function recentLockDiagnostics(limit = MAX_DIAGNOSTICS): LockDiagnostic[] {
  const n = Math.max(0, Math.min(MAX_DIAGNOSTICS, Math.trunc(limit) || MAX_DIAGNOSTICS))
  return diagnostics.slice(-n)
}

/** The on-disk lock path for an artifact. */
export function crossProcessLockPath(targetPath: string): string {
  return `${targetPath}.lock`
}

function assertLockTarget(targetPath: string): void {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new Error("refused: cross-process lock needs a non-empty target path")
  }
  if (targetPath.includes("\u0000")) {
    throw new Error("refused: cross-process lock target contains a NUL byte")
  }
  if (!isAbsolute(targetPath)) {
    throw new Error("refused: cross-process lock target must be an absolute path")
  }
}

/** Refuse a symlinked lock path or lock directory (never follow it). */
function assertLockPathSafe(lockPath: string): void {
  try {
    if (lstatSync(dirname(lockPath)).isSymbolicLink()) {
      throw new Error(`refused: lock directory "${dirname(lockPath)}" is a symlink`)
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }
  try {
    if (lstatSync(lockPath).isSymbolicLink()) {
      throw new Error(`refused: "${lockPath}" is a symlink; refusing to use it as a lock file`)
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means the process exists but is owned by another user.
    return err?.code === "EPERM"
  }
}

function ownerFromParsed(parsed: any): LockOwner | undefined {
  if (!parsed || typeof parsed !== "object") return undefined
  const pid = Number(parsed.pid)
  const host = typeof parsed.host === "string" ? parsed.host : ""
  const at = typeof parsed.at === "string" ? parsed.at : ""
  const nonce = typeof parsed.nonce === "string" ? parsed.nonce : ""
  if (!Number.isFinite(pid) || pid <= 0 || !host || !at || !nonce) return undefined
  return { pid, host, at, nonce }
}

function readOwnerText(raw: string): LockOwner | undefined {
  try {
    return ownerFromParsed(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * Observe a lock artifact without modifying it. Returns `undefined` when the
 * path does not exist. Directory locks (mkdir fallback) keep their owner in
 * `<lockPath>/owner.json`.
 */
export function observeLockArtifact(lockPath: string): LockArtifactObservation | undefined {
  let stat
  try {
    stat = lstatSync(lockPath)
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined
    throw err
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refused: "${lockPath}" is a symlink; refusing to use it as a lock file`)
  }
  const kind: "file" | "directory" = stat.isDirectory() ? "directory" : "file"
  let raw: string | undefined
  try {
    if (kind === "directory") {
      const ownerFile = join(lockPath, "owner.json")
      const ownerStat = lstatSync(ownerFile)
      if (ownerStat.isFile() && !ownerStat.isSymbolicLink() && ownerStat.size <= 4096) {
        raw = readFileSync(ownerFile, "utf8")
      }
    } else if (stat.isFile() && stat.size <= 4096) {
      raw = readFileSync(lockPath, "utf8")
    }
    // A FIFO/socket/device (or an oversized/planted symlink) at the lock path
    // is left unread (reading a FIFO would block); it is treated as an
    // unreadable artifact and ages out after the lease.
  } catch {
    raw = undefined
  }
  const owner = raw === undefined ? undefined : readOwnerText(raw)
  return {
    path: lockPath,
    kind,
    mtimeMs: stat.mtimeMs,
    ino: typeof stat.ino === "number" && stat.ino > 0 ? stat.ino : undefined,
    nonce: owner?.nonce ?? "",
    owner,
    readable: owner !== undefined,
  }
}

function safeName(value: string): string {
  return String(value || "").replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 80)
}

function removeArtifact(path: string, kind: "file" | "directory"): void {
  try {
    if (kind === "directory") rmSync(path, { recursive: true, force: true })
    else unlinkSync(path)
  } catch {
    // Best-effort cleanup only; never throw from finally.
  }
}

/**
 * Atomically quarantine a stale lock. The caller supplies the observation it
 * judged stale; the function refuses when the artifact has been replaced in
 * the meantime (different inode or nonce), so a freshly taken lock is never
 * removed by a racing reclaimer. `rename(2)` is the winner election: of N
 * concurrent reclaimers exactly one succeeds.
 */
export function quarantineStaleLock(lockPath: string, observed: LockArtifactObservation): boolean {
  let current: LockArtifactObservation | undefined
  try {
    current = observeLockArtifact(lockPath)
  } catch {
    return false
  }
  if (!current) return false
  if (observed.ino !== undefined && current.ino !== undefined && current.ino !== observed.ino) return false
  if (current.nonce !== observed.nonce) return false

  const quarantinePath = `${lockPath}.stale.${safeName(observed.nonce) || "unknown"}`
  // Clear a leftover quarantine from an earlier crash before renaming into it.
  rmSync(quarantinePath, { recursive: true, force: true })
  try {
    renameSync(lockPath, quarantinePath)
  } catch {
    return false
  }
  // Post-check: if a different artifact was at the path when rename ran, put
  // it back rather than deleting it. The inode/nonce check above makes this
  // window vanishingly small, but the restore keeps the invariant absolute.
  let moved: LockArtifactObservation | undefined
  try {
    moved = observeLockArtifact(quarantinePath)
  } catch {
    moved = undefined
  }
  if ((moved?.nonce ?? "") !== observed.nonce) {
    try {
      if (observeLockArtifact(lockPath) === undefined) renameSync(quarantinePath, lockPath)
    } catch {
      // Best-effort restore; the caller will time out rather than write.
    }
    return false
  }
  removeArtifact(quarantinePath, moved?.kind ?? observed.kind)
  return true
}

/** Bounded exponential backoff plus cryptographic jitter. */
function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const backoff = Math.max(1, Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 8)))
  const jitter = randomInt(0, Math.max(1, Math.floor(backoff / 2)))
  return backoff + jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeOwner(owner: LockOwner | undefined): string {
  return owner ? `pid ${owner.pid} on ${owner.host} since ${owner.at}` : "an unreadable lock file"
}

const SELF_HOST = hostname()

/**
 * Hard-link capability, detected once and cached. `unknown` means no attempt
 * has failed yet; a filesystem that rejects `link(2)` switches every later
 * acquisition to the `mkdir` fallback.
 */
let hardlinkSupport: "unknown" | "yes" | "no" = "unknown"

const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EACCES"])

function recordDiagnostic(diagnostic: LockDiagnostic, sink?: (d: LockDiagnostic) => void): void {
  diagnostics.push(diagnostic)
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS)
  try {
    sink?.(diagnostic)
  } catch {
    // A diagnostic sink must never break locking.
  }
}

/**
 * Create the lock artifact atomically.
 *
 * File mode: write the complete owner JSON to a unique temp with `wx`, then
 * `link(2)` it to `lockPath`. `EEXIST` means held. The temp is always unlinked.
 * Directory mode (no hard links): `mkdir(2)` the lock path, then write
 * `<lockPath>/owner.json`. A crash between the two leaves an empty directory,
 * which the stale path treats as unreadable-but-reclaimable after the lease.
 */
function tryCreateLock(
  lockPath: string,
  owner: LockOwner,
  options: CrossProcessLockOptions,
): "created" | "exists" {
  const forceDir = options.disableHardlinks === true || hardlinkSupport === "no"

  if (!forceDir) {
    const tempPath = `${lockPath}.${safeName(owner.host)}.${owner.pid}.${owner.nonce}.tmp`
    let wroteTemp = false
    try {
      writeFileSync(tempPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
      wroteTemp = true
      linkSync(tempPath, lockPath)
      hardlinkSupport = "yes"
      return "created"
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        // Either the lock exists or (vanishingly unlikely) the temp name
        // collided. Both mean "not created on this attempt".
        return "exists"
      }
      if (wroteTemp && NO_HARDLINK_CODES.has(String(err?.code))) {
        hardlinkSupport = "no"
        recordDiagnostic(
          {
            at: new Date().toISOString(),
            path: lockPath,
            event: "hardlink_unsupported",
            nonce: owner.nonce,
            detail: `link(2) failed with ${err?.code}; using the mkdir fallback for every later lock`,
          },
          options.onDiagnostic,
        )
        // Fall through to the directory implementation.
      } else {
        throw new Error(
          `refused: could not create lock file "${lockPath}" (${err?.code ?? err?.message ?? "unknown error"})`,
        )
      }
    } finally {
      if (wroteTemp) {
        try {
          unlinkSync(tempPath)
        } catch {
          // The temp is inert; a leftover is cleaned by the next attempt.
        }
      }
    }
  }

  try {
    mkdirSync(lockPath, { mode: 0o700 })
  } catch (err: any) {
    if (err?.code === "EEXIST") return "exists"
    throw new Error(`refused: could not create lock directory "${lockPath}" (${err?.code ?? err?.message ?? "unknown error"})`)
  }
  try {
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 })
  } catch {
    // An empty lock directory is a recoverable state: it ages out as an
    // unreadable lock after the lease instead of stranding the artifact.
  }
  return "created"
}

interface StaleVerdict {
  stale: boolean
  reason: string
}

/**
 * Decide whether the observed artifact may be reclaimed. Age always comes from
 * the filesystem mtime, never the owner's `at`. A remote host is never guessed
 * at. An empty/partial artifact becomes reclaimable once it is older than the
 * lease; before that it may still be mid-publication.
 */
function staleVerdict(
  observed: LockArtifactObservation,
  opts: {
    leaseMs: number
    now: number
    host: string
    pid: number
    isAlive: (pid: number) => boolean
  },
): StaleVerdict {
  const ageMs = Math.max(0, opts.now - observed.mtimeMs)
  if (ageMs <= opts.leaseMs) return { stale: false, reason: `age ${ageMs}ms is within the ${opts.leaseMs}ms lease` }
  if (!observed.owner) {
    return { stale: true, reason: `unreadable/empty lock is ${ageMs}ms old (lease ${opts.leaseMs}ms)` }
  }
  if (observed.owner.host !== opts.host) {
    return { stale: false, reason: `owner is on another host (${observed.owner.host}); never reclaimed from a remote pid` }
  }
  if (observed.owner.pid === opts.pid) return { stale: true, reason: `owner pid is this process and the lock is stale` }
  if (!opts.isAlive(observed.owner.pid)) return { stale: true, reason: `owner pid ${observed.owner.pid} is not alive` }
  return { stale: false, reason: `owner pid ${observed.owner.pid} is still alive` }
}

/**
 * Release our lock artifact. Cleanup is deliberately best-effort: an unlink
 * error (EACCES, ENOENT after a racing reclaimer, etc.) must never mask the
 * primary error from `fn`. The nonce check ensures a lock that replaced ours
 * (after a stale reclaim) is never removed.
 */
function releaseLock(lockPath: string, nonce: string): void {
  try {
    const observed = observeLockArtifact(lockPath)
    if (observed?.nonce === nonce) removeArtifact(lockPath, observed.kind)
  } catch {
    // Best-effort cleanup only; never throw from finally.
  }
}

/**
 * Run `fn` while holding a cross-process lock for `targetPath`.
 *
 * * Publication is atomic (temp + hard link, or mkdir fallback).
 * * Retry with bounded exponential backoff plus jitter until `timeoutMs`.
 * * A lock is stale when the artifact mtime is older than `leaseMs` and it is
 *   unreadable (empty/partial), or it was written on this host by the current
 *   pid or a pid that is no longer alive. A lock from another host is never
 *   reclaimed based on pid liveness. See the NFS caveat in docs/ARTIFACTS.md.
 * * Reclaim is an atomic quarantine rename; concurrent reclaimers elect one
 *   winner and no live path is ever unlinked by nonce.
 *
 * The timeout error is deliberately explicit and fails closed: callers must
 * not write an artifact when they could not acquire its lock.
 */
export async function withCrossProcessLock<T>(
  targetPath: string,
  fn: () => Promise<T> | T,
  options: CrossProcessLockOptions = {},
): Promise<T> {
  assertLockTarget(targetPath)
  const lockPath = crossProcessLockPath(targetPath)
  // The in-process queue uses the same key as the on-disk lock. A single key
  // per target is what prevents self-deadlock: this process can never own the
  // on-disk lock while another call in this process waits for the queue.
  return withFileLock(lockPath, () => acquireAndRun(lockPath, fn, options))
}

async function acquireAndRun<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: CrossProcessLockOptions,
): Promise<T> {
  const nonce = await acquireLock(lockPath, options)
  try {
    return await fn()
  } finally {
    releaseLock(lockPath, nonce)
  }
}

async function acquireLock(lockPath: string, options: CrossProcessLockOptions): Promise<string> {
  const leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS)
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
  const now = options.now ?? Date.now
  const host = options.host ?? SELF_HOST
  const pid = options.pid ?? process.pid
  const isAlive = options.isProcessAlive ?? processIsAlive
  const nonce = randomBytes(12).toString("hex")
  const deadline = now() + timeoutMs
  let attempt = 0

  mkdirSync(dirname(lockPath), { recursive: true })

  while (true) {
    assertLockPathSafe(lockPath)
    const owner: LockOwner = { pid, host, at: new Date(now()).toISOString(), nonce }
    if (tryCreateLock(lockPath, owner, options) === "created") return nonce

    let observed: LockArtifactObservation | undefined
    try {
      observed = observeLockArtifact(lockPath)
    } catch (err) {
      // A symlink planted at the lock path is a refusal, not a retry.
      throw err
    }

    if (observed) {
      const verdict = staleVerdict(observed, { leaseMs, now: now(), host, pid, isAlive })
      if (verdict.stale) {
        if (quarantineStaleLock(lockPath, observed)) {
          recordDiagnostic(
            {
              at: new Date().toISOString(),
              path: lockPath,
              event: observed.owner ? "stale_reclaimed" : "unreadable_lock_reclaimed",
              nonce: observed.owner?.nonce ?? null,
              detail: verdict.reason,
            },
            options.onDiagnostic,
          )
          continue
        }
        recordDiagnostic(
          {
            at: new Date().toISOString(),
            path: lockPath,
            event: "stale_reclaim_raced",
            nonce: observed.owner?.nonce ?? null,
            detail: "another process won the quarantine rename",
          },
          options.onDiagnostic,
        )
      }
    }

    if (now() >= deadline) {
      const holder = observed?.owner
      throw new Error(
        `refused: lock timeout after ${timeoutMs}ms waiting for "${lockPath}" (held by ${describeOwner(holder)}); no artifact was written`,
      )
    }

    attempt += 1
    await sleep(retryDelayMs(attempt, retryBaseMs, retryMaxMs))
  }
}
