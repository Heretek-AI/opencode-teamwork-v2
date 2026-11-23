// opencode-teamwork — serialisation primitives
//
// Two layers of locking protect read-modify-write of run artifacts:
//
//   1. `withFileLock` is an in-process FIFO keyed by path. It prevents two
//      tool calls in this plugin process from interleaving.
//   2. `withCrossProcessLock` adds an on-disk `<target>.lock` file created with
//      `O_CREAT|O_EXCL` (`flag: "wx"`). It prevents two separate OpenCode
//      processes (or two Node child processes in the regression suite) from
//      losing each other's update to `state.json`, `costs.json`, or the handoff
//      index.
//
// The cross-process lock is intentionally a *short* critical-section lock:
// acquire, read, modify, write, release. Never await network/client work while
// holding it. The in-process queue is acquired first, so a process cannot
// deadlock against its own lock file; the single on-disk key per target is the
// same key used by the in-process queue.
//
// Zero runtime dependencies. Erasable TypeScript only.

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, isAbsolute } from "node:path"
import { randomBytes } from "node:crypto"

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
}

interface LockOwner {
  pid: number
  host: string
  at: string
  nonce: string
}

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_BASE_MS = 10
const DEFAULT_RETRY_MAX_MS = 100

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

/** Refuse a symlinked lock path (never follow it). */
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

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const pid = Number(parsed.pid)
    const host = typeof parsed.host === "string" ? parsed.host : ""
    const at = typeof parsed.at === "string" ? parsed.at : ""
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : ""
    if (!Number.isFinite(pid) || !host || !at || !nonce) return undefined
    return { pid, host, at, nonce }
  } catch {
    return undefined
  }
}

function ownerAgeMs(owner: LockOwner, now: number): number {
  const at = Date.parse(owner.at)
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
  return Math.max(0, now - at)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeOwner(owner: LockOwner | undefined): string {
  return owner ? `pid ${owner.pid} on ${owner.host} since ${owner.at}` : "an unreadable lock file"
}

const SELF_HOST = hostname()

/**
 * Run `fn` while holding a cross-process lock for `targetPath`.
 *
 * Lock protocol:
 *   * Create `<targetPath>.lock` with `O_CREAT|O_EXCL` and JSON
 *     `{pid, host, at, nonce}`. A pre-existing symlink is refused.
 *   * Retry with bounded exponential backoff plus jitter until `timeoutMs`.
 *   * A lock is stale when it is older than `leaseMs` AND it was written on
 *     this host by the current pid or by a pid that is no longer alive. A lock
 *     from another host is never reclaimed based on pid liveness (the remote
 *     pid is meaningless here); it can only be cleared manually or by its
 *     owner. This is the safe behaviour on shared filesystems (see the NFS
 *     caveat in docs/ARTIFACTS.md).
 *   * The lock file is unlinked in `finally`, but only if its nonce still
 *     matches the one this call created.
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
  return withFileLock(lockPath, () => acquireAndRun(targetPath, lockPath, fn, options))
}

async function acquireAndRun<T>(
  targetPath: string,
  lockPath: string,
  fn: () => Promise<T> | T,
  options: CrossProcessLockOptions,
): Promise<T> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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

  let acquired = false
  while (!acquired) {
    assertLockPathSafe(lockPath)
    const at = new Date(now()).toISOString()
    const owner: LockOwner = { pid, host, at, nonce }
    try {
      // `wx` is O_CREAT|O_EXCL: it never follows or overwrites an existing
      // entry, including a symlink planted at the lock path.
      const fd = openSync(lockPath, "wx", 0o600)
      try {
        writeSync(fd, JSON.stringify(owner))
      } finally {
        closeSync(fd)
      }
      acquired = true
      break
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        throw new Error(`refused: could not create lock file "${lockPath}" (${err?.code ?? err?.message ?? "unknown error"})`)
      }
    }

    const existing = readOwner(lockPath)
    const age = existing ? ownerAgeMs(existing, now()) : Number.POSITIVE_INFINITY
    const sameHost = existing?.host === host
    // Never infer liveness for a lock written on another host. If the JSON is
    // unreadable we also keep waiting until the timeout rather than unlinking
    // an artifact we cannot identify.
    const stale =
      !!existing &&
      age > leaseMs &&
      sameHost &&
      (existing.pid === pid || !isAlive(existing.pid))

    if (stale) {
      // Re-read immediately before unlinking and require the same nonce. This
      // narrows (but cannot entirely remove) the classic stale-lock race.
      const again = readOwner(lockPath)
      if (again && again.nonce === existing!.nonce) {
        try {
          unlinkSync(lockPath)
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err
        }
      }
      continue
    }

    if (now() >= deadline) {
      const holder = existing ?? readOwner(lockPath)
      throw new Error(
        `refused: lock timeout after ${timeoutMs}ms waiting for "${lockPath}" (held by ${describeOwner(holder)}); no artifact was written`,
      )
    }

    attempt += 1
    const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt, 8))
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 2)))
    await sleep(backoff + jitter)
  }

  try {
    return await fn()
  } finally {
    // Only remove the lock file if it is still ours. Another process could not
    // have legitimately replaced it while we held it, but a manual recovery or
    // a stale reclaimer might have; unlinking someone else's lock would be
    // worse than leaving ours behind.
    const current = readOwner(lockPath)
    if (current?.nonce === nonce) {
      try {
        unlinkSync(lockPath)
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err
      }
    }
  }
}
