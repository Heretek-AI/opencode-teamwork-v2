// lib/bounded-read.mjs — shared no-follow bounded file reader
//
// Used by the READ-ONLY report exporters (lib/export.mjs, lib/timeline.mjs and
// lib/runs.mjs). Opening first is deliberate: O_NOFOLLOW turns a symlinked final
// component into ELOOP, O_NONBLOCK keeps a FIFO from blocking before fstat can
// reject it, and fstat on the descriptor (not a pre-open lstat) is the authority
// on what was opened.
//
// The low-level implementation is the shared leaf in
// plugins/opencode-teamwork/safe-fs.mjs so the plugin and the CLI readers cannot
// drift. This file only adapts its result vocabulary to the CLI's
// ok/absent/oversize/unreadable shape.
//
// Zero runtime dependencies. Node >= 18.
//
// Security note (ADR 0004): readBoundedWithin adds the post-open
// /proc/self/fd containment check on Linux. readBounded is rootless and keeps
// the final-component-only protection; callers that know the run root must use
// readBoundedWithin. On macOS/Windows the intermediate-directory race remains a
// documented residual risk. The write path is not covered by this module.

import {
  readRegularBounded,
  readWithinBounded,
} from "../plugins/opencode-teamwork/safe-fs.mjs"

function adapt(r) {
  if (r.status === "ok") return { status: "ok", text: r.text }
  if (r.status === "absent") return { status: "absent" }
  if (r.status === "oversize") return { status: "oversize", size: r.size, cap: r.cap }
  // refused (symlink / not-regular / containment / unreadable) is unreadable to
  // the CLI, exactly as before.
  return { status: "unreadable" }
}

/**
 * Read a regular file without following a final-component symlink, up to
 * maxBytes. Returns one of:
 *   { status: "ok", text }            read in full
 *   { status: "absent" }              does not exist
 *   { status: "oversize", size, cap } exists but is larger than maxBytes
 *   { status: "unreadable" }          exists but is not a readable regular file
 * Oversize is never reported as absent. Never writes. No containment check.
 */
export function readBounded(file, maxBytes) {
  return adapt(readRegularBounded(file, maxBytes))
}

/**
 * Same result shape as readBounded, but additionally refuses an opened file
 * whose descriptor resolves outside `runReal`. On Linux with /proc/self/fd this
 * closes the intermediate-component symlink read bypass; on other platforms it
 * is the same as readBounded.
 */
export function readBoundedWithin(runReal, file, maxBytes) {
  return adapt(readWithinBounded(runReal, file, maxBytes))
}
