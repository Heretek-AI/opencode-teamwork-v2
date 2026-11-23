// plugins/opencode-teamwork/safe-fs.mjs — shared bounded-read / fd-containment leaf
//
// This is the single low-level implementation used by the plugin TypeScript
// (tournament.ts, tools.ts, lemma.ts) and by the CLI readers (lib/*.mjs, and
// therefore bin/*.mjs). It is a leaf module on purpose: it imports only Node
// built-ins and never imports lib/, bin/, or another plugin file. The
// lib -> plugins dependency direction is unusual, but the documented manual
// install copies only plugins/opencode-teamwork (README.md), so this is the one
// placement that ships in every install mode.
//
// ADR 0004 (docs/adr/0004-intermediate-symlink-races.md): O_NOFOLLOW only
// protects the final path component. After opening a file, on Linux with a
// mounted /proc/self/fd we resolve the opened descriptor's real path and refuse
// to read when it is not inside the run's real path. The check is deliberately
// ordered open -> fstat -> regular -> size -> containment -> read, so no bytes
// are returned from a refused descriptor.
//
// ADR 0010 (docs/adr/0010-pinned-fd-write-containment.md): the same
// /proc/self/fd traversal makes a *preventive* write path possible in pure JS.
// A directory descriptor is pinned once, and every subsequent create, mkdir,
// rename, write and lstat is expressed as
// `/proc/self/fd/<dirfd>/<one-validated-segment>`. A parent directory renamed
// or replaced by a symlink after the pin cannot redirect the operation: the
// kernel resolves the already-open descriptor, not the old name. Each segment
// is a single validated path component, so `..` and `/` can never appear.
//
// Platform boundary: the preventive write guarantee is Linux + a usable
// /proc/self/fd only. On Linux where procfs is unusable, writes fail closed
// (nothing is written). On macOS and Windows there is no fd-to-path primitive
// in Node core, so writers keep the previous path-based atomic write plus a
// *detective* post-write containment/identity check; a transient swap that is
// reverted before the check can be missed. That distinction is permanent and is
// documented in docs/GUARDRAILS.md and ADR 0010.

import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 as win32Path } from "node:path"

const PROC_SELF_FD = "/proc/self/fd"
const DELETED_SUFFIX = " (deleted)"

/**
 * Probe how fd containment can be enforced on this host.
 *   "enforce"    Linux + /proc/self/fd resolves an open fd -> post-open check.
 *   "fail-closed" Linux but /proc/self/fd is absent/unusable -> refuse existing reads.
 *   "unsupported" non-Linux -> keep the pre-ADR behavior and residual risk.
 * The probe runs once at module load; it opens only /proc/self/fd itself.
 */
function probeFdMode() {
  if (process.platform !== "linux") return "unsupported"
  let fd = null
  try {
    // Open the directory directly: no lstat-then-open check (CodeQL
    // js/file-system-race). A throw at either step means procfs is unusable.
    fd = openSync(PROC_SELF_FD, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0))
    realpathSync(`${PROC_SELF_FD}/${fd}`)
    return "enforce"
  } catch {
    return "fail-closed"
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

const FD_MODE = probeFdMode()

// Test-only override for the read-side containment mode. The non-Linux branch
// (containment unavailable) can then be exercised on a Linux CI host.
let containmentModeOverride = null

function currentContainmentMode() {
  return containmentModeOverride ?? FD_MODE
}

/** Test seam: force "enforce" | "fail-closed" | "unsupported" (or null). */
export function setFdContainmentModeForTest(mode) {
  containmentModeOverride = mode === "enforce" || mode === "fail-closed" || mode === "unsupported" ? mode : null
}

/** True when the post-open fd containment check is enforced on this host. */
export function supportsFdContainment() {
  return currentContainmentMode() === "enforce"
}

/** "enforce" | "fail-closed" | "unsupported" (exported for tests/diagnostics). */
export function fdContainmentMode() {
  return currentContainmentMode()
}

// Separator-aware relative containment: a file literally named "..foo" is
// inside, while "..", "../x" and an absolute result are not.
function isPathWithin(root, target) {
  let rel
  try {
    rel = relative(root, target)
  } catch {
    return false
  }
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * True when the opened descriptor `fd` resolves to a real path strictly inside
 * `runReal`. A deleted/unlinked file is refused ("... (deleted)"), as is any
 * path that is exactly the root or escapes it. False when the fd path cannot be
 * resolved or fd containment is unavailable (fail closed).
 */
export function fdWithin(runReal, fd) {
  if (currentContainmentMode() !== "enforce") return false
  let fdPath
  try {
    fdPath = realpathSync(`${PROC_SELF_FD}/${fd}`)
  } catch {
    return false
  }
  if (fdPath.endsWith(DELETED_SUFFIX)) return false
  return isPathWithin(runReal, fdPath)
}

function sanitize(message) {
  return String(message === undefined || message === null ? "" : message)
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .slice(0, 80)
}

function refused(reason, message) {
  return { status: "refused", reason, message }
}

function notRegular(file) {
  return refused("not-regular", `refused: "${basename(file)}" is not a regular file`)
}

/** Map an open/read error to the shared result vocabulary (never throws). */
function mapError(err, file) {
  const code = err && err.code
  if (code === "ENOENT") return { status: "absent" }
  if (code === "ELOOP" || code === "EMLINK") return notRegular(file)
  return refused("unreadable", `refused: cannot read "${basename(file)}" (${sanitize(err && err.message)})`)
}

/**
 * Core open/fstat/containment/bounded-read sequence. `runReal === null` means
 * "no root": containment cannot be checked and is not attempted.
 */
function readOpened(file, maxBytes, runReal) {
  let fd = null
  try {
    // Truthiness (not `typeof === "number"`) so a platform exposing 0 (no flag)
    // is treated as unavailable.
    const nofollow = fsConstants.O_NOFOLLOW || 0
    const nonblock = fsConstants.O_NONBLOCK || 0
    if (nofollow === 0 || nonblock === 0) {
      // Non-atomic fallback only where the flags are unavailable. It is still a
      // refusal (never a permissive path); POSIX uses O_NOFOLLOW below.
      const lst = lstatSync(file)
      if (lst.isSymbolicLink() || !lst.isFile()) return notRegular(file)
    }
    fd = openSync(file, fsConstants.O_RDONLY | nofollow | nonblock)
    const fst = fstatSync(fd)
    if (!fst.isFile()) return notRegular(file)
    if (fst.size > maxBytes) return { status: "oversize", size: fst.size, cap: maxBytes }
    // ADR 0004 order: the descriptor is checked BEFORE the buffer is allocated
    // and before any byte is read. "unsupported" keeps the old behavior.
    if (runReal !== null && currentContainmentMode() !== "unsupported" && !fdWithin(runReal, fd)) {
      return refused(
        "containment",
        `refused: "${basename(file)}" is not inside the run directory (fd containment unavailable or failed)`,
      )
    }
    // Read at most maxBytes+1 so a file that grows after fstat stays bounded.
    const cap = Math.min(fst.size, maxBytes) + 1
    const buf = Buffer.alloc(cap)
    let total = 0
    while (total < cap) {
      let n
      try {
        n = readSync(fd, buf, total, cap - total, null)
      } catch (err) {
        if (err && err.code === "EINTR") continue
        throw err // EAGAIN and everything else fail closed
      }
      if (n === 0) break
      total += n
    }
    if (total > maxBytes) return { status: "oversize", size: total, cap: maxBytes }
    return { status: "ok", text: buf.subarray(0, total).toString("utf8") }
  } catch (err) {
    return mapError(err, file)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

/**
 * Read one regular file with O_NOFOLLOW | O_NONBLOCK (lstat fallback), fstat,
 * byte cap, EINTR retry and fail-closed errors. It has no root, so it performs
 * no containment check. Result:
 *   { status: "ok", text }
 *   { status: "absent" }
 *   { status: "oversize", size, cap }
 *   { status: "refused", reason, message }
 */
export function readRegularBounded(file, maxBytes) {
  return readOpened(file, maxBytes, null)
}

/**
 * Read one regular file and refuse it unless the opened descriptor resolves
 * inside `runReal`. Adds ADR 0004's post-open containment check to
 * readRegularBounded. On Linux without a usable /proc/self/fd every existing
 * file is refused (fail closed); on non-Linux the containment check is skipped
 * and the documented residual risk remains.
 */
export function readWithinBounded(runReal, file, maxBytes) {
  return readOpened(file, maxBytes, runReal)
}

// ---------------------------------------------------------------------------
// Write containment (ADR 0010)
// ---------------------------------------------------------------------------
//
// fd numbers are process-local and reused. A pinned descriptor is either used
// and closed inside one synchronous operation, or held across an `await` and
// closed only in a `finally`. The write primitives below are synchronous, so a
// caller cannot interleave an `await` between the pin and its use.

const MAX_WRITE_ANOMALIES = 100
const writeAnomalies = []
let writeAuditSink = null
let traversalModeOverride = null

/**
 * Probe whether the preventive writer can pin directories.
 *   "pinned"      Linux + a self-traversable /proc/self/fd -> fd-relative writes.
 *   "detective"   non-Linux -> path-based atomic write + post-write checks.
 *   "fail-closed" Linux but /proc/self/fd is absent/unusable -> refuse writes.
 * The probe runs once at module load. It opens /proc/self/fd, resolves the
 * descriptor through /proc/self/fd and stats through it; nothing is written.
 */
function probeFdTraversalMode() {
  if (process.platform !== "linux") return "detective"
  let dfd = null
  try {
    const dirFlag = fsConstants.O_DIRECTORY || 0
    const noFollow = fsConstants.O_NOFOLLOW || 0
    dfd = openSync(PROC_SELF_FD, fsConstants.O_RDONLY | dirFlag | noFollow)
    const self = realpathSync(`${PROC_SELF_FD}/${dfd}`)
    if (!self || self.endsWith(DELETED_SUFFIX)) return "fail-closed"
    if (!statSync(`${PROC_SELF_FD}/${dfd}`).isDirectory()) return "fail-closed"
    return "pinned"
  } catch {
    return "fail-closed"
  } finally {
    if (dfd !== null) {
      try {
        closeSync(dfd)
      } catch {}
    }
  }
}

const FD_TRAVERSAL_MODE = probeFdTraversalMode()

function currentTraversalMode() {
  return traversalModeOverride ?? FD_TRAVERSAL_MODE
}

/**
 * "pinned" | "detective" | "fail-closed" (exported for tests/diagnostics).
 * `FD_TRAVERSAL_MODE` is decided once at load; a test hook may override it to
 * exercise the detective fallback and the fail-closed branch on one host.
 */
export function fdTraversalMode() {
  return currentTraversalMode()
}

/** True only when writes are preventive (a pinned directory descriptor). */
export function supportsPinnedWrites() {
  return currentTraversalMode() === "pinned"
}

/**
 * Test seam: force "pinned" | "detective" | "fail-closed" (or null to clear).
 * Production code never calls this. It exists so the fallback and fail-closed
 * branches can be exercised on a Linux CI host, and so non-Linux hosts can still
 * run the pinned unit cases when they choose to.
 */
export function setFdTraversalModeForTest(mode) {
  traversalModeOverride =
    mode === "pinned" || mode === "detective" || mode === "fail-closed" ? mode : null
}

/** Recent write anomalies (bounded ring, oldest first). */
export function recentWriteAnomalies(limit = MAX_WRITE_ANOMALIES) {
  const n = Math.max(0, Math.min(MAX_WRITE_ANOMALIES, Math.trunc(limit) || MAX_WRITE_ANOMALIES))
  return writeAnomalies.slice(-n)
}

/**
 * Register a best-effort diagnostic sink for write anomalies. The plugin wires
 * this to its event log; it must never throw into the writer.
 */
export function onWriteAnomaly(sink) {
  writeAuditSink = typeof sink === "function" ? sink : null
}

export function recordWriteAnomaly(entry) {
  const record = { at: new Date().toISOString(), ...entry }
  writeAnomalies.push(record)
  if (writeAnomalies.length > MAX_WRITE_ANOMALIES) {
    writeAnomalies.splice(0, writeAnomalies.length - MAX_WRITE_ANOMALIES)
  }
  try {
    writeAuditSink?.(record)
  } catch {
    // A diagnostic sink must never break the writer.
  }
  return record
}

function refusalError(reason, message) {
  const err = new Error(message)
  err.reason = reason
  err.code = "EREFUSED"
  return err
}

/**
 * Reject anything that is not exactly one path component: no empty name, no
 * `.`/`..`, no separator or NUL, and at most NAME_MAX (255) UTF-8 bytes.
 *
 * On Windows (or when the test seam enables the Windows policy) names that NTFS
 * silently rewrites or reserves are refused too: a trailing dot/space, any `:`
 * (drive/ADS syntax), the reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
 * `COM1`-`COM9`, `LPT1`-`LPT9`, including an extension) and any name that does
 * not survive a `path.win32.resolve` round-trip. Linux behaviour is unchanged.
 */
let windowsLexicalOverride = null

/** Test seam: force the Windows lexical policy on any host (or null). */
export function setWindowsLexicalModeForTest(enabled) {
  windowsLexicalOverride = typeof enabled === "boolean" ? enabled : null
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function windowsSegmentInvalid(value) {
  if (/[. ]$/.test(value)) return true
  if (value.includes(":")) return true
  if (WINDOWS_RESERVED_NAME.test(value)) return true
  try {
    const roundTrip = win32Path.resolve(win32Path.sep + "tw-root", value)
    if (win32Path.basename(roundTrip) !== value) return true
  } catch {
    return true
  }
  return false
}

export function assertSingleSegment(name) {
  const value = typeof name === "string" ? name : String(name ?? "")
  const invalid =
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > 255
  if (invalid || ((windowsLexicalOverride ?? process.platform === "win32") && windowsSegmentInvalid(value))) {
    throw refusalError(
      "segment",
      `refused: invalid single path segment ${JSON.stringify(value).slice(0, 80)}`,
    )
  }
  return value
}

/** The real path of an open descriptor (Linux /proc/self/fd only). Throws. */
export function fdPath(fd) {
  return realpathSync(`${PROC_SELF_FD}/${fd}`)
}

/**
 * True when the open directory/file descriptor resolves to exactly `real`.
 * The run root itself is accepted; " (deleted)" and every non-exact realpath are
 * refused. False when the mode is not "pinned" or the fd cannot be resolved.
 */
export function fdExactly(real, fd) {
  if (currentTraversalMode() !== "pinned") return false
  let path
  try {
    path = fdPath(fd)
  } catch {
    return false
  }
  if (!path || path.endsWith(DELETED_SUFFIX)) return false
  return path === real
}

/**
 * Pin `<run>` itself: lstat (refuse a symlink), realpath, then
 * `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` and an exact fd check. Returns
 *   { status: "ok", fd, real }
 *   { status: "refused", reason, message }
 * The caller owns `fd` and must close it in a `finally`.
 */
export function openPinnedRoot(run) {
  const mode = currentTraversalMode()
  if (mode === "fail-closed") {
    return refused(
      "traversal-unavailable",
      "refused: write containment is unavailable on this host (Linux without a usable /proc/self/fd); nothing was written",
    )
  }
  if (mode !== "pinned") {
    return refused(
      "traversal-unavailable",
      "refused: a pinned run directory requires Linux /proc/self/fd; nothing was written",
    )
  }
  let lst
  try {
    lst = lstatSync(run)
  } catch (err) {
    if (err?.code === "ENOENT") return refused("run-missing", "refused: run directory does not exist")
    return refused("unreadable", "refused: run directory is not accessible")
  }
  if (lst.isSymbolicLink()) return refused("run-symlink", "refused: run directory is a symlink")
  if (!lst.isDirectory()) return refused("run-not-directory", "refused: run path is not a directory")
  let real
  try {
    real = realpathSync(run)
  } catch {
    return refused("unreadable", "refused: run directory is not resolvable")
  }
  let fd = null
  try {
    fd = openSync(run, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0))
  } catch (err) {
    return refused("unreadable", `refused: cannot open run directory (${sanitize(err?.code || err?.message)})`)
  }
  if (!fdExactly(real, fd)) {
    try {
      closeSync(fd)
    } catch {}
    return refused("containment", "refused: opened run directory is not the validated run realpath")
  }
  return { status: "ok", fd, real }
}

/** Open one child directory relative to a pinned parent (never follows a link). */
export function openChildDir(parentFd, name) {
  assertSingleSegment(name)
  return openSync(
    `${PROC_SELF_FD}/${parentFd}/${name}`,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0),
  )
}

/** Open a child directory, creating exactly that one segment when absent. */
export function openOrCreateDir(parentFd, name) {
  assertSingleSegment(name)
  const path = `${PROC_SELF_FD}/${parentFd}/${name}`
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0)
  try {
    return openSync(path, flags)
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (mkdirErr) {
      if (mkdirErr?.code !== "EEXIST") throw mkdirErr
    }
    return openSync(path, flags)
  }
}

/**
 * Validate `relPath` lexically (inside `run`, one validated segment per
 * component) and then pin its parent directory with one syscall per segment.
 * Missing intermediate directories are created only when `create` is true, and
 * only with a non-recursive validated-segment mkdir.
 *
 * Returns { status: "ok", dirFd, name, real, relPath } | refused. The caller
 * owns `dirFd` and must close it in a `finally`.
 */
export function pinParent(run, relPath, options = {}) {
  if (currentTraversalMode() !== "pinned") {
    return refused(
      "traversal-unavailable",
      "refused: pinning a parent directory requires Linux /proc/self/fd; nothing was written",
    )
  }
  let rel
  try {
    rel = relative(resolve(run), resolve(run, relPath))
  } catch {
    return refused("path", "refused: invalid target path")
  }
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return refused("escape", `refused: path escapes the run directory (${sanitize(basename(String(relPath)))})`)
  }
  const segments = rel.split(sep).filter((part) => part !== "")
  if (segments.length === 0) return refused("path", "refused: empty target path")
  for (const segment of segments) {
    try {
      assertSingleSegment(segment)
    } catch (err) {
      return refused("segment", err.message)
    }
  }
  const name = segments[segments.length - 1]
  const dirs = segments.slice(0, -1)
  const root = openPinnedRoot(run)
  if (root.status !== "ok") return root
  let cur = root.fd
  let handedOff = false
  try {
    for (const segment of dirs) {
      let next
      try {
        next = options.create ? openOrCreateDir(cur, segment) : openChildDir(cur, segment)
      } catch (err) {
        return refused(
          "directory",
          `refused: cannot pin directory "${sanitize(segment)}" (${sanitize(err?.code || err?.message)})`,
        )
      }
      closeSync(cur)
      cur = next
    }
    handedOff = true
    return { status: "ok", dirFd: cur, name, real: root.real, relPath: segments.join("/") }
  } finally {
    if (!handedOff) {
      try {
        closeSync(cur)
      } catch {}
    }
  }
}

function writeAllSync(fd, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    let written
    try {
      written = writeSync(fd, buffer, offset, buffer.length - offset)
    } catch (err) {
      if (err?.code === "EINTR") continue
      throw err
    }
    if (!Number.isFinite(written) || written <= 0) {
      throw refusalError("short-write", "refused: short write while writing a run artifact")
    }
    offset += written
  }
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content
  return Buffer.from(String(content ?? ""), "utf8")
}

let identityUnavailableForTest = false

/** Test seam: force `sameIdentity` to report an unusable (dev, ino) pair. */
export function setIdentityUnavailableForTest(enabled) {
  identityUnavailableForTest = enabled === true
}

/**
 * Compare the opened/recorded inode identity. A filesystem that reports
 * `dev === 0` or `ino === 0` cannot support a meaningful identity check, so it
 * is refused by name (`identity-unavailable`) instead of being treated as a
 * match or a benign mismatch.
 */
function sameIdentity(stat, recorded) {
  if (!stat || !recorded) return false
  if (
    identityUnavailableForTest ||
    stat.dev === 0 ||
    stat.ino === 0 ||
    recorded.dev === 0 ||
    recorded.ino === 0
  ) {
    recordWriteAnomaly({
      kind: "identity-unavailable",
      detail: "the filesystem reported dev=0 or ino=0; identity containment cannot be verified",
    })
    throw refusalError(
      "identity-unavailable",
      "refused: the filesystem reports no stable (dev, ino) identity; the write cannot be verified",
    )
  }
  return stat.dev === recorded.dev && stat.ino === recorded.ino
}

function fsyncDirBestEffort(fd) {
  try {
    fsyncSync(fd)
  } catch (err) {
    // Some filesystems reject fsync on a directory descriptor (EINVAL). The
    // rename is already atomic; this is crash durability, not containment.
    if (err?.code && !["EINVAL", "ENOTSUP", "EBADF"].includes(err.code)) throw err
  }
}

/**
 * Atomic write of `content` to `name` inside an already-pinned directory
 * descriptor. The temp file is a fresh random single segment created with
 * O_CREAT|O_EXCL|O_NOFOLLOW; the rename and the post-rename identity check both
 * go through `/proc/self/fd/<dirFd>/...`, so no path walk can be diverted.
 * `dirFd` is never closed here.
 *
 * Test seams (options, production never sets them):
 *   mode?: "pinned" | "detective" | "fail-closed"
 *   afterRename?: ({ dirFd, tempName, destName }) => void
 *   durable?: boolean (default true: fsync file and directory)
 */
export function writeFileAtomicAt(dirFd, name, content, options = {}) {
  assertSingleSegment(name)
  const data = toBuffer(content)
  const dirReal = (() => {
    try {
      return fdPath(dirFd)
    } catch {
      return null
    }
  })()
  const tempName = `.tw-${randomBytes(9).toString("hex")}.tmp`
  const tempPath = `${PROC_SELF_FD}/${dirFd}/${tempName}`
  const destPath = `${PROC_SELF_FD}/${dirFd}/${name}`
  let fd = null
  let recorded = null
  let renamed = false
  try {
    fd = openSync(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    )
    writeAllSync(fd, data)
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusalError("not-regular", `refused: temp inode for "${name}" is not a regular file`)
    recorded = { dev: st.dev, ino: st.ino, size: st.size }
    if (options.durable !== false) fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tempPath, destPath)
    renamed = true
    if (typeof options.afterRename === "function") {
      options.afterRename({ dirFd, tempName, destName: name })
    }
    const after = lstatSync(destPath)
    if (!after.isFile() || !sameIdentity(after, recorded)) {
      recordWriteAnomaly({
        kind: "rename-identity",
        run: options.run ?? null,
        dir: dirReal,
        name,
        detail: "post-rename inode does not match the fsync'ed temp inode",
      })
      throw refusalError(
        "identity",
        `refused: "${sanitize(name)}" changed identity during the atomic write; the write is not trusted`,
      )
    }
    if (options.durable !== false) fsyncDirBestEffort(dirFd)
    return { status: "ok", bytes: data.length, name }
  } catch (err) {
    if (!renamed) {
      try {
        unlinkSync(tempPath)
      } catch {}
    }
    throw err
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

/** Create `name` once (O_CREAT|O_EXCL|O_NOFOLLOW). `EEXIST` is propagated. */
export function writeOnceAt(dirFd, name, content, options = {}) {
  assertSingleSegment(name)
  const data = toBuffer(content)
  const destPath = `${PROC_SELF_FD}/${dirFd}/${name}`
  let fd = null
  let recorded = null
  try {
    fd = openSync(
      destPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    )
    writeAllSync(fd, data)
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusalError("not-regular", `refused: "${name}" is not a regular file`)
    recorded = { dev: st.dev, ino: st.ino }
    if (options.durable !== false) fsyncSync(fd)
    // Identity while the create fd is still open: a rename cannot have swapped
    // the entry without changing (dev, ino).
    const after = lstatSync(destPath)
    if (!sameIdentity(after, recorded)) {
      recordWriteAnomaly({
        kind: "create-identity",
        run: options.run ?? null,
        name,
        detail: "created entry does not match the open inode",
      })
      throw refusalError("identity", `refused: "${sanitize(name)}" changed identity during the write`)
    }
    closeSync(fd)
    fd = null
    if (options.durable !== false) fsyncDirBestEffort(dirFd)
    return { status: "ok", bytes: data.length, name }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

/** Create `name` with `content` only if it does not exist; EEXIST is a no-op. */
export function touchAt(dirFd, name, content, options = {}) {
  try {
    return writeOnceAt(dirFd, name, content, options)
  } catch (err) {
    if (err?.code === "EEXIST") return { status: "exists", name }
    throw err
  }
}

/**
 * Append one line to `name` inside a pinned directory. The file is opened
 * O_RDWR|O_APPEND|O_CREAT|O_NOFOLLOW, fstat'ed (regular, nlink === 1), the line
 * is built from *that* descriptor (so a sequence number cannot be computed from
 * a different inode), written with one non-positional write, and fsync'ed.
 */
export function appendLineAt(dirFd, name, buildLineFromFd, options = {}) {
  assertSingleSegment(name)
  const destPath = `${PROC_SELF_FD}/${dirFd}/${name}`
  let fd = null
  try {
    fd = openSync(
      destPath,
      fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    )
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusalError("not-regular", `refused: "${name}" is not a regular file`)
    if (st.nlink !== 1) {
      recordWriteAnomaly({
        kind: "hardlink",
        run: options.run ?? null,
        name,
        detail: `refused append: nlink=${st.nlink} (an aliased inode can write outside the run)`,
      })
      throw refusalError(
        "hardlink",
        `refused: "${sanitize(name)}" has ${st.nlink} hard links; refusing to append through an aliased inode`,
      )
    }
    const line = buildLineFromFd(fd, st)
    if (typeof line !== "string" || line === "" || !line.endsWith("\n")) {
      throw refusalError("line", "refused: append builder did not return one newline-terminated line")
    }
    const data = Buffer.from(line, "utf8")
    writeAllSync(fd, data)
    if (options.durable !== false) fsyncSync(fd)
    return { status: "ok", bytes: data.length, name }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

/** Unlink `name` inside a pinned directory (cleanup helper). */
export function unlinkAt(dirFd, name) {
  assertSingleSegment(name)
  try {
    unlinkSync(`${PROC_SELF_FD}/${dirFd}/${name}`)
    return true
  } catch (err) {
    if (err?.code === "ENOENT") return false
    throw err
  }
}

// ---------------------------------------------------------------- wrappers

function pinOrThrow(run, relPath, create, mode) {
  if (mode === "fail-closed") {
    throw refusalError(
      "traversal-unavailable",
      "refused: write containment is unavailable on this host (Linux without a usable /proc/self/fd); nothing was written",
    )
  }
  const pin = pinParent(run, relPath, { create })
  if (pin.status !== "ok") throw refusalError(pin.reason, pin.message)
  return pin
}

/** Atomic write of `content` to `run/relPath` with pinned-fd containment. */
export function writeFileAtomicWithin(run, relPath, content, options = {}) {
  const mode = options.mode ?? currentTraversalMode()
  if (mode === "detective") return writeFileAtomicDetective(run, relPath, content, options)
  const pin = pinOrThrow(run, relPath, options.createDirs !== false, mode)
  try {
    const out = writeFileAtomicAt(pin.dirFd, pin.name, content, { ...options, run })
    return { ...out, path: resolve(run, relPath) }
  } finally {
    try {
      closeSync(pin.dirFd)
    } catch {}
  }
}

/** Write `run/relPath` once. `EEXIST` is propagated to the caller. */
export function writeOnceWithin(run, relPath, content, options = {}) {
  const mode = options.mode ?? currentTraversalMode()
  if (mode === "detective") return writeOnceDetective(run, relPath, content, options)
  const pin = pinOrThrow(run, relPath, options.createDirs !== false, mode)
  try {
    const out = writeOnceAt(pin.dirFd, pin.name, content, { ...options, run })
    return { ...out, path: resolve(run, relPath) }
  } finally {
    try {
      closeSync(pin.dirFd)
    } catch {}
  }
}

/** Create `run/relPath` only if absent; `EEXIST` is a no-op. */
export function touchWithin(run, relPath, content, options = {}) {
  const mode = options.mode ?? currentTraversalMode()
  if (mode === "detective") return touchDetective(run, relPath, content, options)
  const pin = pinOrThrow(run, relPath, options.createDirs !== false, mode)
  try {
    const out = touchAt(pin.dirFd, pin.name, content, { ...options, run })
    return { ...out, path: resolve(run, relPath) }
  } finally {
    try {
      closeSync(pin.dirFd)
    } catch {}
  }
}

/**
 * Append one line to `run/relPath`. `buildLineFromFd(fd, stat)` must return a
 * newline-terminated line; it runs while the append descriptor is open, so a
 * sequence number computed from it is read from the same inode.
 */
export function appendLineWithin(run, relPath, buildLineFromFd, options = {}) {
  const mode = options.mode ?? currentTraversalMode()
  if (mode === "detective") return appendLineDetective(run, relPath, buildLineFromFd, options)
  const pin = pinOrThrow(run, relPath, true, mode)
  try {
    const out = appendLineAt(pin.dirFd, pin.name, buildLineFromFd, { ...options, run })
    return { ...out, path: resolve(run, relPath) }
  } finally {
    try {
      closeSync(pin.dirFd)
    } catch {}
  }
}

/** Remove `run/relPath` through a pinned parent (best-effort ENOENT). */
export function unlinkWithin(run, relPath, options = {}) {
  const mode = options.mode ?? currentTraversalMode()
  if (mode === "detective") {
    // A delete never creates parent directories as a side effect. A missing
    // parent is "nothing to remove", not permission to materialise a tree.
    let target
    try {
      target = detectiveTarget(run, relPath, { createParents: false })
    } catch (err) {
      if (err?.reason === "absent") return false
      throw err
    }
    try {
      unlinkSync(target.dest)
    } catch (err) {
      if (err?.code === "ENOENT") return false
      throw err
    }
    if (typeof options.afterUnlink === "function") options.afterUnlink({ dest: target.dest })
    try {
      const parentReal = realpathSync(dirname(target.dest))
      if (parentReal !== target.runReal && !isPathWithin(target.runReal, parentReal)) {
        recordWriteAnomaly({
          kind: "detective-unlink",
          run: target.run ?? null,
          name: target.name,
          detail: "post-unlink parent realpath is outside the run",
        })
        throw refusalError("containment", "refused: post-unlink containment check failed")
      }
    } catch (err) {
      if (err?.code === "EREFUSED") throw err
      recordWriteAnomaly({
        kind: "detective-unlink",
        run: target.run ?? null,
        name: target.name,
        detail: sanitize(err?.message),
      })
      throw refusalError("postcheck", "refused: post-unlink containment check failed")
    }
    return true
  }
  if (mode !== "pinned") return false
  const pin = pinOrThrow(run, relPath, false, mode)
  try {
    return unlinkAt(pin.dirFd, pin.name)
  } finally {
    try {
      closeSync(pin.dirFd)
    } catch {}
  }
}

/**
 * Create `run/relPath` as a directory, one validated segment per syscall. This
 * is not `mkdir -p` by path: each existing component is opened O_NOFOLLOW and
 * the next one is created relative to that pinned descriptor.
 */
export function createDirWithin(run, relPath, options = {}) {
  const mode = options.mode ?? currentTraversalMode()
  if (mode === "fail-closed") {
    throw refusalError(
      "traversal-unavailable",
      "refused: write containment is unavailable on this host (Linux without a usable /proc/self/fd); nothing was created",
    )
  }
  if (mode === "detective") {
    const target = detectiveTarget(run, relPath)
    mkdirSync(target.dest, { recursive: true })
    if (typeof options.afterCreate === "function") options.afterCreate({ dest: target.dest })
    try {
      const createdReal = realpathSync(target.dest)
      if (createdReal !== target.runReal && !isPathWithin(target.runReal, createdReal)) {
        recordWriteAnomaly({
          kind: "detective-create-dir",
          run: target.run ?? null,
          name: target.name,
          detail: "post-create directory realpath is outside the run",
        })
        throw refusalError("containment", "refused: post-create containment check failed")
      }
    } catch (err) {
      if (err?.code === "EREFUSED") throw err
      recordWriteAnomaly({
        kind: "detective-create-dir",
        run: target.run ?? null,
        name: target.name,
        detail: sanitize(err?.message),
      })
      throw refusalError("postcheck", "refused: post-create containment check failed")
    }
    return { status: "ok", path: target.dest }
  }
  let rel
  try {
    rel = relative(resolve(run), resolve(run, relPath))
  } catch {
    throw refusalError("path", "refused: invalid directory path")
  }
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw refusalError("escape", "refused: directory path escapes the run directory")
  }
  const segments = rel.split(sep).filter((part) => part !== "")
  const root = openPinnedRoot(run)
  if (root.status !== "ok") throw refusalError(root.reason, root.message)
  let cur = root.fd
  try {
    for (const segment of segments) {
      assertSingleSegment(segment)
      const next = openOrCreateDir(cur, segment)
      closeSync(cur)
      cur = next
    }
    return { status: "ok", path: resolve(run, relPath) }
  } finally {
    try {
      closeSync(cur)
    } catch {}
  }
}

// ---------------------------------------------------- detective fallback
//
// Used on macOS/Windows (no /proc/self/fd) after a path-based atomic write. It
// is detective only: a transient intermediate swap that is reverted before the
// post-write checks can be missed. On Linux without procfs writes fail closed
// instead; this code is never selected there by default.

function detectiveTarget(run, relPath, options = {}) {
  const runRoot = resolve(run)
  const dest = resolve(runRoot, relPath)
  const rel = relative(runRoot, dest)
  // Parity with tournament.ts: reject anything whose relative path starts with
  // "..", so a sibling literally named "..foo" cannot masquerade as inside.
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw refusalError("escape", "refused: path escapes the run directory")
  }
  const segments = rel.split(sep).filter((part) => part !== "")
  for (const segment of segments) assertSingleSegment(segment)
  let runStat
  try {
    runStat = lstatSync(runRoot)
  } catch {
    throw refusalError("run-missing", "refused: run directory does not exist")
  }
  if (runStat.isSymbolicLink()) {
    throw refusalError("run-symlink", "refused: run directory is a symlink")
  }
  if (!runStat.isDirectory()) {
    throw refusalError("run-not-directory", "refused: run path is not a directory")
  }
  let runReal
  try {
    runReal = realpathSync(runRoot)
  } catch {
    throw refusalError("run-missing", "refused: run directory does not exist")
  }
  // Pre-check every existing component is not a symlink (detective; not atomic).
  let cur = runRoot
  for (let i = 0; i < segments.length - 1; i++) {
    cur = resolve(cur, segments[i])
    try {
      const st = lstatSync(cur)
      if (st.isSymbolicLink()) throw refusalError("symlink", `refused: "${sanitize(segments[i])}" is a symlink`)
      if (!st.isDirectory()) throw refusalError("directory", `refused: "${sanitize(segments[i])}" is not a directory`)
    } catch (err) {
      if (err?.code === "ENOENT") break
      throw err
    }
  }
  if (options.createParents !== false) mkdirSync(dirname(dest), { recursive: true })
  let dirReal
  try {
    dirReal = realpathSync(dirname(dest))
  } catch (err) {
    if (options.createParents === false && err?.code === "ENOENT") {
      throw refusalError("absent", "refused: the target's parent directory does not exist")
    }
    throw refusalError("postcheck", "refused: the target parent cannot be resolved")
  }
  if (dirReal !== runReal && !isPathWithin(runReal, dirReal)) {
    throw refusalError("containment", "refused: target parent is outside the run realpath")
  }
  return { dest, dirReal, runReal, run, name: segments[segments.length - 1], segments }
}

function detectivePostCheck(target, recorded) {
  try {
    const dirReal = realpathSync(dirname(target.dest))
    if (dirReal !== target.runReal && !isPathWithin(target.runReal, dirReal)) {
      recordWriteAnomaly({
        kind: "detective-containment",
        run: target.run ?? null,
        name: target.name,
        detail: "post-write parent realpath is outside the run",
      })
      throw refusalError("containment", "refused: post-write containment check failed")
    }
    const after = lstatSync(target.dest)
    if (!after.isFile() || !sameIdentity(after, recorded)) {
      recordWriteAnomaly({
        kind: "detective-identity",
        run: target.run ?? null,
        name: target.name,
        detail: "post-write inode does not match the temp inode",
      })
      throw refusalError("identity", `refused: "${sanitize(target.name)}" failed the post-write identity check`)
    }
  } catch (err) {
    if (err?.code === "EREFUSED") throw err
    recordWriteAnomaly({
      kind: "detective-postcheck",
      run: target.run ?? null,
      name: target.name,
      detail: sanitize(err?.message),
    })
    throw refusalError("postcheck", "refused: post-write containment check failed")
  }
}

function writeFileAtomicDetective(run, relPath, content, options) {
  const target = detectiveTarget(run, relPath)
  const data = toBuffer(content)
  const temp = `${target.dest}.${randomBytes(9).toString("hex")}.tmp`
  let fd = null
  let recorded = null
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    writeAllSync(fd, data)
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusalError("not-regular", `refused: temp inode for "${target.name}" is not a regular file`)
    recorded = { dev: st.dev, ino: st.ino }
    if (options.durable !== false) fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, target.dest)
    if (typeof options.afterRename === "function") {
      options.afterRename({ dirFd: null, tempName: temp, destName: target.name, destPath: target.dest })
    }
    detectivePostCheck(target, recorded)
    return { status: "ok", bytes: data.length, name: target.name, path: target.dest }
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {}
    throw err
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function writeOnceDetective(run, relPath, content, options) {
  const target = detectiveTarget(run, relPath)
  const data = toBuffer(content)
  let fd = null
  let recorded = null
  try {
    fd = openSync(target.dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    writeAllSync(fd, data)
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusalError("not-regular", `refused: "${target.name}" is not a regular file`)
    recorded = { dev: st.dev, ino: st.ino }
    if (options.durable !== false) fsyncSync(fd)
    closeSync(fd)
    fd = null
    detectivePostCheck(target, recorded)
    return { status: "ok", bytes: data.length, name: target.name, path: target.dest }
  } catch (err) {
    throw err
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function touchDetective(run, relPath, content, options) {
  try {
    return writeOnceDetective(run, relPath, content, options)
  } catch (err) {
    if (err?.code === "EEXIST") return { status: "exists", name: basename(relPath) }
    throw err
  }
}

function appendLineDetective(run, relPath, buildLineFromFd, options) {
  const target = detectiveTarget(run, relPath)
  const nofollow = fsConstants.O_NOFOLLOW || 0
  let fd = null
  let recorded = null
  try {
    if (nofollow === 0) {
      // Windows has no O_NOFOLLOW: refuse a symlink at the final component
      // immediately before the open. This check is not atomic, but it closes
      // the deterministic `pitfalls.md -> ~/.bashrc` pre-planted escape.
      try {
        if (lstatSync(target.dest).isSymbolicLink()) {
          recordWriteAnomaly({
            kind: "detective-append",
            run: target.run ?? null,
            name: target.name,
            detail: "refused append: the final component is a symlink",
          })
          throw refusalError("symlink", `refused: "${sanitize(target.name)}" is a symlink; refusing to append`)
        }
      } catch (err) {
        if (err?.code !== "ENOENT") throw err
      }
    }
    try {
      fd = openSync(
        target.dest,
        fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | nofollow,
        0o600,
      )
    } catch (err) {
      if (err?.code === "ELOOP") {
        recordWriteAnomaly({
          kind: "detective-append",
          run: target.run ?? null,
          name: target.name,
          detail: "refused append: O_NOFOLLOW saw a symlink",
        })
        throw refusalError("symlink", `refused: "${sanitize(target.name)}" is a symlink; refusing to append`)
      }
      throw err
    }
    const st = fstatSync(fd)
    if (!st.isFile()) throw refusalError("not-regular", `refused: "${target.name}" is not a regular file`)
    recorded = { dev: st.dev, ino: st.ino }
    if (st.nlink !== 1) {
      recordWriteAnomaly({
        kind: "hardlink",
        run: target.run ?? null,
        name: target.name,
        detail: `refused append: nlink=${st.nlink}`,
      })
      throw refusalError("hardlink", `refused: "${sanitize(target.name)}" has ${st.nlink} hard links`)
    }
    // Where the read-side primitive is available, require the opened append
    // descriptor to resolve inside the run. On non-Linux it cannot, so the
    // check is skipped and the detective realpath post-check remains.
    if (currentContainmentMode() === "enforce" && !fdWithin(target.runReal, fd)) {
      throw refusalError("containment", "refused: append descriptor is not inside the run")
    }
    const line = buildLineFromFd(fd, st)
    if (typeof line !== "string" || line === "" || !line.endsWith("\n")) {
      throw refusalError("line", "refused: append builder did not return one newline-terminated line")
    }
    writeAllSync(fd, Buffer.from(line, "utf8"))
    if (options.durable !== false) fsyncSync(fd)
    if (typeof options.afterAppend === "function") options.afterAppend({ fd, dest: target.dest })
    // Post-write identity against the descriptor that was actually opened.
    let after
    try {
      after = lstatSync(target.dest)
    } catch (err) {
      recordWriteAnomaly({
        kind: "detective-append",
        run: target.run ?? null,
        name: target.name,
        detail: sanitize(err?.message),
      })
      throw refusalError("identity", `refused: "${sanitize(target.name)}" disappeared during the append`)
    }
    if (!after.isFile() || !sameIdentity(after, recorded)) {
      recordWriteAnomaly({
        kind: "detective-append",
        run: target.run ?? null,
        name: target.name,
        detail: "post-append inode does not match the opened append descriptor",
      })
      throw refusalError("identity", `refused: "${sanitize(target.name)}" changed identity during the append`)
    }
    const dirReal = realpathSync(dirname(target.dest))
    if (dirReal !== target.runReal && !isPathWithin(target.runReal, dirReal)) {
      recordWriteAnomaly({ kind: "detective-containment", run: target.run ?? null, name: target.name, detail: "append parent moved outside" })
      throw refusalError("containment", "refused: post-append containment check failed")
    }
    return { status: "ok", name: target.name, path: target.dest }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}
