// Type declarations for ./safe-fs.mjs. Hand-maintained; keep in sync with the
// implementation. Type-only: this file has no runtime effect.

export type FdContainmentMode = "enforce" | "fail-closed" | "unsupported"

export type SafeFsRead =
  | { status: "ok"; text: string }
  | { status: "absent" }
  | { status: "oversize"; size: number; cap: number }
  | { status: "refused"; reason: "symlink" | "not-regular" | "containment" | "unreadable"; message: string }

/** True when the post-open fd containment check is enforced on this host. */
export function supportsFdContainment(): boolean

/** "enforce" on Linux + usable /proc/self/fd, "fail-closed" on unusable Linux procfs, else "unsupported". */
export function fdContainmentMode(): FdContainmentMode

/** True when the opened fd resolves to a real path strictly inside `runReal`. */
export function fdWithin(runReal: string, fd: number): boolean

/** Bounded no-follow read without a root: no containment check. */
export function readRegularBounded(file: string, maxBytes: number): SafeFsRead

/** Bounded no-follow read that also refuses a descriptor outside `runReal`. */
export function readWithinBounded(runReal: string, file: string, maxBytes: number): SafeFsRead
