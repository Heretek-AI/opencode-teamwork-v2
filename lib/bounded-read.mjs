// lib/bounded-read.mjs — shared no-follow bounded file reader
//
// Used by the READ-ONLY report exporters (lib/export.mjs and lib/timeline.mjs).
// Opening first is deliberate: O_NOFOLLOW turns a symlinked final component into
// ELOOP, O_NONBLOCK keeps a FIFO from blocking before fstat can reject it, and
// fstat on the descriptor (not a pre-open lstat) is the authority on what was
// opened.
//
// Zero runtime dependencies. Node >= 18.
//
// Security note: O_NOFOLLOW protects only the final path component. An
// intermediate-directory symlink raced in between checks remains a known gap;
// the full fix is component-by-component openat traversal.

import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from "node:fs"

/**
 * Read a regular file without following a final-component symlink, up to
 * maxBytes. Returns one of:
 *   { status: "ok", text }            read in full
 *   { status: "absent" }              does not exist
 *   { status: "oversize", size, cap } exists but is larger than maxBytes
 *   { status: "unreadable" }          exists but is not a readable regular file
 * Oversize is never reported as absent. Never writes.
 */
export function readBounded(file, maxBytes) {
  let fd = null
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    )
    const st = fstatSync(fd)
    if (!st.isFile()) return { status: "unreadable" }
    if (st.size > maxBytes) return { status: "oversize", size: st.size, cap: maxBytes }
    // Read at most maxBytes+1 so a file that grows after fstat stays bounded.
    const cap = Math.min(st.size, maxBytes) + 1
    const buf = Buffer.alloc(cap)
    let total = 0
    while (total < cap) {
      const n = readSync(fd, buf, total, cap - total, null)
      if (n === 0) break
      total += n
    }
    if (total > maxBytes) return { status: "oversize", size: total, cap: maxBytes }
    return { status: "ok", text: buf.subarray(0, total).toString("utf8") }
  } catch (err) {
    const code = err && err.code
    if (code === "ENOENT") return { status: "absent" }
    // ELOOP/EMLINK: a symlink (or a link loop) was refused by O_NOFOLLOW.
    if (code === "ELOOP" || code === "EMLINK") return { status: "unreadable" }
    return { status: "unreadable" }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}
