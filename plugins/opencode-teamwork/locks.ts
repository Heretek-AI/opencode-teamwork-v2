// opencode-teamwork — in-process serialisation primitive
//
// Read-modify-write of a run artifact (costs, state, a handoff index) must not
// interleave with another tool call in the same plugin process. These locks are
// keyed by the artifact path and live for the process lifetime; they are not
// cross-process locks (the run-dir write boundary remains documented in
// docs/GUARDRAILS.md).
//
// Zero runtime dependencies. Erasable TypeScript only.

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
