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
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { randomBytes, randomInt } from "node:crypto"
import {
  assertSingleSegment,
  containmentModeRefusal,
  fdTraversalMode,
  pinParent,
  recordWriteAnomaly,
  resolveRunPolicy,
} from "./safe-fs.mjs"

const PROC_SELF_FD = "/proc/self/fd"

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
  /** Test seam: fail the `mkdir` fallback owner-file publication. */
  failOwnerWrite?: boolean
  /**
   * Internal: the lock path is already `/proc/self/fd/<dirfd>/<name>` from a
   * pinned run directory. Skips the path-level directory checks (which would see
   * the procfs fd entry as a symlink) because the parent was validated by
   * `pinParent` and cannot be diverted by an intermediate swap.
   */
  pinned?: boolean
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
  | "detective_lock"

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
// ADR 0010's state.json critical section can include a short git read on a cold
// worktree. 30 s is the maximum default: it equals the lease and never exceeds
// it, so a waiter cannot outlive the artifact it is waiting for.
const DEFAULT_TIMEOUT_MS = 30_000
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
  // Publish the owner inside the directory with the same temp-then-rename
  // discipline as the file path. A directory with no valid owner is a broken
  // mutex, not a "created" lock: remove it and fail closed so the caller never
  // writes an artifact it does not actually hold.
  try {
    if (options.failOwnerWrite === true) {
      throw Object.assign(new Error("injected owner-write failure"), { code: "EIO" })
    }
    const tempOwner = join(lockPath, `owner.${owner.nonce}.tmp`)
    writeFileSync(tempOwner, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
    renameSync(tempOwner, join(lockPath, "owner.json"))
  } catch (err: any) {
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      // Best effort: the directory is inert and the next attempt will see it.
    }
    throw new Error(
      `refused: could not publish the lock owner in "${lockPath}" (${err?.code ?? err?.message ?? "unknown error"}); the lock directory was removed and no artifact was written`,
    )
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
 * Release our lock artifact. A single atomic `rename(2)` moves the lock into a
 * nonce-named quarantine: the path becomes free in one step, so a process that
 * acquires a new lock immediately after release can never be unlinked by this
 * caller. Only the quarantined artifact whose nonce matches ours is removed. If
 * the moved artifact is not ours (a replacement raced the rename), it is put
 * back with `link(2)` + `unlink(2)` — never a clobbering rename — and a new lock
 * already at the path is left untouched.
 *
 * Cleanup is deliberately best-effort: an unlink error must never mask the
 * primary error from `fn`.
 */
function releaseLock(lockPath: string, nonce: string): void {
  const quarantinePath = `${lockPath}.release.${safeName(nonce) || "unknown"}`
  let moved: LockArtifactObservation | undefined
  try {
    rmSync(quarantinePath, { recursive: true, force: true })
    renameSync(lockPath, quarantinePath)
  } catch {
    return
  }
  try {
    releaseHookForTest?.({ lockPath, quarantinePath, nonce })
  } catch {
    // A test seam must never break release.
  }
  try {
    moved = observeLockArtifact(quarantinePath)
  } catch {
    moved = undefined
  }
  if ((moved?.nonce ?? "") !== nonce) {
    // Not our artifact. Restore it without clobbering anything published since.
    try {
      if (observeLockArtifact(lockPath) === undefined) {
        if ((moved?.kind ?? "file") === "directory") {
          renameSync(quarantinePath, lockPath)
        } else {
          linkSync(quarantinePath, lockPath)
          unlinkSync(quarantinePath)
        }
      }
    } catch {
      // Best-effort restore; the caller will time out rather than write.
    }
    return
  }
  removeArtifact(quarantinePath, moved?.kind ?? "file")
}

let releaseHookForTest: ((info: { lockPath: string; quarantinePath: string; nonce: string }) => void) | null = null

/** Test seam: observe (and race) the release quarantine rename. */
export function setReleaseHookForTest(fn: ((info: { lockPath: string; quarantinePath: string; nonce: string }) => void) | null): void {
  releaseHookForTest = typeof fn === "function" ? fn : null
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

function pathWithinOrEqual(root: string, target: string): boolean {
  let rel: string
  try {
    rel = relative(root, target)
  } catch {
    return false
  }
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Cross-process lock for `run/relTargetPath` whose lock file is created inside
 * the already-pinned parent directory (ADR 0010). The in-process queue key is a
 * stable `realpath + relative path` string (not the procfs descriptor path,
 * which changes on every call), while every on-disk lock operation uses
 * `/proc/self/fd/<dirfd>/<name>`. An intermediate directory swapped for a
 * symlink therefore cannot divert the lock create, link, rename or unlink.
 *
 * The directory descriptor is held for the whole acquire/run/release sequence
 * and closed in `finally`; it is never closed while the lock is being used.
 *
 * On a host without fd traversal (macOS/Windows) the lock is path-based but not
 * unguarded: the target parent's realpath must stay under the run realpath
 * before acquisition and after release, a `detective-lock` diagnostic/anomaly
 * is recorded, and a failed containment check fails closed. Linux without a
 * usable `/proc/self/fd` still fails closed; it never silently falls back.
 */
export async function withPinnedCrossProcessLock<T>(
  run: string,
  relTargetPath: string,
  fn: () => Promise<T> | T,
  options: CrossProcessLockOptions = {},
): Promise<T> {
  const mode = fdTraversalMode()
  // The resolver rehydrates `plan.dag.json` itself (realpath + (dev, ino) keyed,
  // bounded by mtime/size), so a fresh process that reaches an unlocked writer
  // is covered before any lock artifact is created.
  if (resolveRunPolicy(run).required && mode !== "pinned") {
    // One refusal for the writer and the lock layer: same reason, same text
    // (including the run id).
    throw containmentModeRefusal(run, mode)
  }
  if (mode === "detective") {
    let runReal: string
    try {
      const st = lstatSync(run)
      if (st.isSymbolicLink()) throw new Error("the run directory is a symlink")
      if (!st.isDirectory()) throw new Error("the run path is not a directory")
      runReal = realpathSync(run)
    } catch (err: any) {
      throw new Error(`refused: cannot lock inside "${run}" (${err?.code ?? err?.message ?? "unavailable"}); nothing was written`)
    }
    const lockPath = crossProcessLockPath(join(run, relTargetPath))
    const lexicalRel = relative(resolve(run), resolve(run, relTargetPath))
    if (!lexicalRel || lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
      throw new Error(`refused: lock target "${relTargetPath}" escapes "${run}"; nothing was written`)
    }
    const key = `detective|${runReal}|${resolve(relTargetPath)}`
    const verifyParent = (phase: string): void => {
      let parentReal: string
      try {
        parentReal = realpathSync(dirname(lockPath))
      } catch (err: any) {
        recordWriteAnomaly({
          kind: "detective-lock",
          detail: `${phase}: the lock parent cannot be resolved (${err?.code ?? "unavailable"})`,
        })
        throw new Error(`refused: ${phase} containment check failed for "${lockPath}"; nothing was written`)
      }
      if (!pathWithinOrEqual(runReal, parentReal)) {
        recordWriteAnomaly({
          kind: "detective-lock",
          detail: `${phase}: lock parent "${parentReal}" is outside the run realpath "${runReal}"`,
        })
        recordDiagnostic(
          {
            at: new Date().toISOString(),
            path: lockPath,
            event: "detective_lock",
            nonce: null,
            detail: `${phase}: lock parent escaped the run realpath`,
          },
          options.onDiagnostic,
        )
        throw new Error(`refused: ${phase} containment check failed for "${lockPath}"; nothing was written`)
      }
    }
    try {
      mkdirSync(dirname(lockPath), { recursive: true })
    } catch (err: any) {
      throw new Error(`refused: cannot create the lock parent for "${lockPath}" (${err?.code ?? "unavailable"}); nothing was written`)
    }
    verifyParent("pre-acquire")
    try {
      return await withFileLock(key, () => acquireAndRun(lockPath, fn, options))
    } finally {
      verifyParent("post-release")
      // Detective, not preventive: the path-based lock itself is the residual.
      recordWriteAnomaly({
        kind: "detective-lock",
        detail: `path-based cross-process lock for "${lockPath}" (no fd traversal on this host)`,
      })
      recordDiagnostic(
        {
          at: new Date().toISOString(),
          path: lockPath,
          event: "detective_lock",
          nonce: null,
          detail: "released a path-based lock after verifying the parent realpath",
        },
        options.onDiagnostic,
      )
    }
  }
  const pin = pinParent(run, relTargetPath, { create: true })
  if (pin.status !== "ok") {
    // A brand-new run root does not exist yet (teamwork_plan/teamwork_tournament
    // create it at the first write). Run-root creation is the documented
    // path-based residual, so this one pre-creation lock keeps the previous
    // path-based behavior; every later lock pins the now-existing directory.
    if (pin.reason === "run-missing") {
      const lockPath = crossProcessLockPath(join(run, relTargetPath))
      return withFileLock(lockPath, () => acquireAndRun(lockPath, fn, options))
    }
    throw new Error(pin.message)
  }
  const dirFd = pin.dirFd
  try {
    const lockName = `${basename(relTargetPath)}.lock`
    assertSingleSegment(lockName)
    const lockPath = `${PROC_SELF_FD}/${dirFd}/${lockName}`
    const key = `pinned|${pin.real}|${pin.relPath}`
    return await withFileLock(key, () => acquireAndRun(lockPath, fn, { ...options, pinned: true }))
  } finally {
    try {
      closeSync(dirFd)
    } catch {}
  }
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

  if (options.pinned !== true) {
    mkdirSync(dirname(lockPath), { recursive: true })
  }

  while (true) {
    if (options.pinned !== true) assertLockPathSafe(lockPath)
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
