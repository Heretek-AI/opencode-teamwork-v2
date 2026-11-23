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
// Platform boundary: the containment guarantee is Linux + a usable
// /proc/self/fd only. On Linux where /proc/self/fd is unusable we fail closed
// for existing files (every attempted read is refused). On macOS and Windows
// the fd path cannot be resolved from Node core, so the previous checks
// (O_NOFOLLOW / lstat fallback, O_NONBLOCK, fstat, cap) are kept and the
// intermediate-component race remains a documented residual risk.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs"
import { basename, isAbsolute, relative, sep } from "node:path"

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

/** True when the post-open fd containment check is enforced on this host. */
export function supportsFdContainment() {
  return FD_MODE === "enforce"
}

/** "enforce" | "fail-closed" | "unsupported" (exported for tests/diagnostics). */
export function fdContainmentMode() {
  return FD_MODE
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
  if (FD_MODE !== "enforce") return false
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
    if (runReal !== null && FD_MODE !== "unsupported" && !fdWithin(runReal, fd)) {
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
