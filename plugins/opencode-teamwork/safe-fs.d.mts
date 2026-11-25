// Type declarations for ./safe-fs.mjs. Hand-maintained; keep in sync with the
// implementation. Type-only: this file has no runtime effect.

export type FdContainmentMode = "enforce" | "fail-closed" | "unsupported"

export type SafeFsRead =
  | { status: "ok"; text: string; bytes?: Buffer }
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

// ---------------------------------------------------------------------------
// Write containment (ADR 0010)
// ---------------------------------------------------------------------------

export type FdTraversalMode = "pinned" | "detective" | "fail-closed"

/** "pinned" (Linux), "detective" (non-Linux), or "fail-closed" (Linux, no procfs). */
export function fdTraversalMode(): FdTraversalMode

/** True only when writes are preventive (a pinned directory descriptor). */
export function supportsPinnedWrites(): boolean

/** Test seam: force a traversal mode; production never calls this. */
export function setFdTraversalModeForTest(mode: FdTraversalMode | null): void

export interface WriteRefusal {
  status: "refused"
  reason: string
  message: string
}

export interface PinnedRoot {
  status: "ok"
  fd: number
  real: string
}

export interface ParentPin {
  status: "ok"
  dirFd: number
  name: string
  real: string
  relPath: string
}

export interface WriteOptions {
  durable?: boolean
  mode?: FdTraversalMode
  createDirs?: boolean
  /** Set internally by the `*Within` wrappers so anomalies can name the run. */
  run?: string
  afterRename?: (info: { dirFd: number | null; tempName: string; destName: string; destPath?: string }) => void
}

export interface WriteOk {
  status: "ok"
  bytes: number
  name: string
  path?: string
}

export interface TouchResult {
  status: "ok" | "exists"
  name: string
  bytes?: number
  path?: string
}

export interface WriteAnomaly {
  at: string
  kind: string
  run?: string | null
  dir?: string | null
  name?: string
  detail?: string
  phase?: string
  tempPath?: string
  destRealAfter?: string | null
  bytesWritten?: number
  intendedSha256?: string
  acknowledged?: boolean
  id?: string
  event?: string
  through?: string
}

/**
 * Resolve the pinned-write policy for a run: env assertion OR a plan assertion
 * (`requirePinnedWrites: true` in plan.dag.json), keyed by realpath + (dev, ino)
 * with the lexical path as a fallback.
 */
export function resolveRunPolicy(run: string): {
  run: string | null
  keys: string[]
  envAsserted: boolean
  planAsserted: boolean
  required: boolean
}

/** The shared `containment-mode` refusal (writer and lock layer). */
export function containmentModeRefusal(run: string, mode?: FdTraversalMode): Error

export function setWriteAnomalyAuditPathForTest(path: string | null): void
export function setIncidentDirForTest(dir: string | null): void
export function setMaxIncidentFilesForTest(limit: number | null): void
export function listContainmentIncidents(
  run?: string,
  options?: { incidentDir?: string; env?: Record<string, string | undefined> },
): Array<Record<string, unknown>>
export function writeAnomaliesForRun(
  run?: string,
  options?: { includeDiagnostics?: boolean; auditPath?: string; env?: Record<string, string | undefined> },
): WriteAnomaly[]
export function unacknowledgedWriteAnomalies(
  run?: string,
  options?: { auditPath?: string; env?: Record<string, string | undefined> },
): WriteAnomaly[]
export function acknowledgeWriteAnomalies(run?: string): WriteAnomaly | null

export function assertSingleSegment(name: string): string
export function openPinnedRoot(run: string): PinnedRoot | WriteRefusal
export function pinParent(
  run: string,
  relPath: string,
  options?: { create?: boolean },
): ParentPin | WriteRefusal

export function writeFileAtomicAt(
  dirFd: number,
  name: string,
  content: string | Buffer,
  options?: WriteOptions,
): WriteOk
export function writeFileAtomicWithin(
  run: string,
  relPath: string,
  content: string | Buffer,
  options?: WriteOptions,
): WriteOk
export function writeOnceWithin(
  run: string,
  relPath: string,
  content: string | Buffer,
  options?: WriteOptions,
): WriteOk
export function touchWithin(run: string, relPath: string, content: string | Buffer, options?: WriteOptions): TouchResult
export function appendLineWithin(
  run: string,
  relPath: string,
  buildLineFromFd: (fd: number, stat: unknown) => string,
  options?: WriteOptions,
): WriteOk
export function unlinkWithin(run: string, relPath: string, options?: WriteOptions): boolean
export function createDirWithin(run: string, relPath: string, options?: WriteOptions): { status: "ok"; path: string }
export function recentWriteAnomalies(limit?: number): WriteAnomaly[]
export function onWriteAnomaly(sink: ((anomaly: WriteAnomaly) => void) | null): void

export interface ResolveExecutableOptions {
  env?: Record<string, string | undefined>
  standardOnly?: boolean
  /** Default true. Set false to search only the supplied PATH (no POSIX fallback dirs). */
  fallbackToStandard?: boolean
  allowPath?: boolean
}

export function resolveTrustedExecutable(binName: string, options?: ResolveExecutableOptions): string | null
