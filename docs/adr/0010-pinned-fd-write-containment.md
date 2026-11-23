# ADR 0010: Pinned-fd Write Containment for Run-Directory Writes

- **Status:** Implemented for the write path on Linux
- **Date:** 2026-11-23
- **Workstream:** 0.11.0 (follow-up to ADR 0004)
- **Classification:** ADR / security design gate
- **Related:** [ADR 0004](0004-intermediate-symlink-races.md), [`docs/spikes/shared-safe-fs.md`](../spikes/shared-safe-fs.md), [`docs/ARTIFACTS.md`](../ARTIFACTS.md), [`docs/GUARDRAILS.md`](../GUARDRAILS.md)

## 1. Context

ADR 0004 closed the read side of the intermediate-directory race: after opening a
file, the opened descriptor's `/proc/self/fd` real path must stay under the run
realpath before any byte is returned. It explicitly left the write side open.
`writeSafeRunFile` (tournament), `writeTextSafe`/`writeJsonSafe` and the
run-file `writeJson` sites (tools), and the LEMMA writer all validated a target
**by path** and then `mkdir`/create/rename'd **by path**. A directory swapped for
a symlink between the check and the write could redirect the bytes outside the
run. The random `wx` temp plus rename only prevented a planted temp-path link
from overwriting a victim.

Node core has no directory-relative `openat`. On Linux, however,
`/proc/self/fd/<dirfd>/<single-name>` lets a process resolve a child relative to
an **already-open directory descriptor**. That is enough to build a preventive
writer in pure JavaScript.

### Verified host facts

On Node v26.13.1 / Linux 7.4:

- `stat`, `open`, `mkdir`, `rename`, `link` and `unlink` accept
  `/proc/self/fd/<dirfd>/<name>`.
- A pinned descriptor survives the parent name being renamed or replaced by a
  symlink; the kernel resolves the descriptor, not the old path.
- `O_DIRECTORY` and `O_NOFOLLOW` are available; `O_PATH` is `undefined`.
- Opening `/proc/self/fd/<fd>` itself with `O_NOFOLLOW` fails (`ELOOP` on the
  probe host), so a descriptor cannot be re-opened as a child that way.
- `/proc/self/fd/<fd>/..` escapes toward `/proc`; it must never be accepted as a
  path segment.
- A `/proc/self/fd` path fails with `ENOENT` after the descriptor is closed.
- `fsync` on a directory descriptor works.

## 2. Decision

Add a preventive write primitive to `plugins/opencode-teamwork/safe-fs.mjs` and
route every run-artifact writer through it. No native addon is added and no
runtime dependency is introduced.

### 2.1 Traversal mode (decided once at load)

`fdTraversalMode()` returns:

| Mode | Host | Write behaviour |
| --- | --- | --- |
| `pinned` | Linux + a self-traversable `/proc/self/fd` | Preventive: every operation is relative to a pinned directory descriptor. |
| `fail-closed` | Linux, procfs absent/unusable | **Refuse every run write**; nothing is created. |
| `detective` | macOS / Windows | Path-based atomic write, then post-write containment/identity checks. Detective only. |

The probe opens `/proc/self/fd`, resolves the descriptor through
`/proc/self/fd/<dfd>` and stats through it. It runs once at module load. A test
hook (`setFdTraversalModeForTest`) can force a mode so the fallback and
fail-closed branches are exercised on one host; production never calls it.
`supportsPinnedWrites()` is exported for callers and diagnostics.

### 2.2 Primitive API

- `assertSingleSegment(name)` — reject empty, `.`, `..`, `/`, `\`, NUL, or more
  than 255 UTF-8 bytes. This is the only way a name reaches a syscall.
- `fdPath(fd)` / `fdExactly(real, fd)` — resolve a descriptor and require exact
  equality with the validated run realpath. `fdExactly` accepts the root itself
  and refuses `" (deleted)"` or any other path.
- `openPinnedRoot(run)` — `lstat` (no symlink), `realpath`, then
  `open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` and `fdExactly`. Returns
  `{status:"ok", fd, real}` or the shared `{status:"refused", reason, message}`
  vocabulary. The caller owns the fd.
- `openChildDir(parentFd, name)` / `openOrCreateDir(parentFd, name)` — one
  validated child per syscall. `openOrCreateDir` creates exactly one segment on
  `ENOENT`; it is **not** a recursive path mkdir.
- `pinParent(run, relPath, {create})` — lexical policy first (strictly inside the
  run, no `..`, no absolute result), then one segment per syscall, closing every
  intermediate descriptor. Returns `{status:"ok", dirFd, name, real, relPath}`.
- `writeFileAtomicAt(dirFd, name, content, opts)` /
  `writeFileAtomicWithin(run, relPath, content, opts)` — random temp segment,
  `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, write loop, `fstat` identity, `fsync`,
  close, rename both ends under the pinned directory, post-rename `(dev, ino)`
  identity compare, optional directory `fsync`, and every descriptor closed in
  `finally`.
- `writeOnceAt` / `writeOnceWithin` — `O_CREAT|O_EXCL|O_NOFOLLOW`; `EEXIST`
  propagates (used by `ORIGINAL_REQUEST.md`).
- `appendLineAt` / `appendLineWithin(run, relPath, buildLineFromFd)` — open
  `O_RDWR|O_APPEND|O_CREAT|O_NOFOLLOW`; `fstat` regular and `nlink === 1`; the
  line (including its sequence number) is built from **that** descriptor via
  positional `pread`; one non-positional append write; `fsync`.
- `touchAt` / `touchWithin` — create-once, `EEXIST` is a no-op.
- `createDirWithin` / `unlinkWithin` — validated, pinned directory creation and
  cleanup.
- `recentWriteAnomalies()` / `onWriteAnomaly(sink)` — a bounded diagnostic ring
  plus a best-effort audit sink (wired to `events.jsonl` as `write_anomaly`).

**Descriptor lifetime rule.** Descriptor numbers are process-local and reused.
A pinned fd is either used and closed inside one synchronous operation, or held
across an `await` and closed only in a `finally`. The write primitives are
synchronous; a caller cannot interleave an `await` between the pin and its use.

### 2.3 Routed call sites

- `tournament.ts` `writeSafeRunFile` keeps `ensureSafeRunSubpath` for the path
  policy and error text, then calls `writeFileAtomicWithin`. `writeSafeRunJson`
  delegates. The recursive `mkdir` was deleted.
- `tools.ts`: `writeTextSafe`, `writeJsonSafe`, `writeTextAtomicSafe`,
  `writeSnapshots`, `writeCostsOnce` and every run-file `writeJson` site (costs,
  snapshots, state, `plan.dag.json`, verify/*, synthesis, manifest) use the pinned
  writer. `writeOriginalRequest` uses `writeOnceWithin`. `touch` keeps its path
  signature for non-run callers; run call sites use `touchRun`/`touchWithin`.
  `appendEvent` and the `pitfalls.md` appends use `appendLineWithin`; the event
  sequence is computed by `nextEventSeqFromFd` from the append descriptor.
- `lemma.ts`: the artifact writer, the axiom probe create/unlink (when inside a
  run), and node-directory creation use the pinned primitives.
- `locks.ts`: `withPinnedCrossProcessLock(run, relTargetPath, fn)` holds a
  directory descriptor for the whole acquire/run/release sequence and expresses
  the lock create, `link`, `rename`, `mkdir`, `lstat` and `unlink` as
  `/proc/self/fd/<dirfd>/<name>`. The in-process queue key is the stable
  `realpath + relative path`, not the per-call descriptor path. A brand-new run
  root (which does not exist yet) keeps the previous path-based lock for that
  pre-creation call; run-root creation is a documented residual.
- Known run subdirectories are pre-created at plan time (`verify`,
  `tournament{,/candidates,/critiques,/merges}`, `lemma{,/nodes}`, `synthesis`,
  `document-review{,/segments,/segments/<seg-id>,/synthesis}`) and
  `lemma/nodes/<id>` at node-add. Pre-creation is attack-surface reduction, not a
  substitute for the pin.

### 2.4 Fallback and failure behaviour

- A refusal is a named `{status:"refused", reason, message}` (or an `Error` with
  `reason` and `code: "EREFUSED"`). Nothing is written on refusal.
- Linux without a usable procfs refuses writes; it never silently falls back to
  a path-based write that claims containment.
- `detective` mode keeps the atomic write and adds a post-write
  `realpathSync(dirname(dest))` under-run check plus a post-rename `(dev, ino)`
  identity check, and `nlink === 1` plus (where available) `fdWithin` on the
  append descriptor. An append opens with `O_NOFOLLOW` where the platform
  defines it; on Windows (no `O_NOFOLLOW`) a symlink at the final component is
  refused immediately before the open, and the `(dev, ino)` read from the opened
  descriptor is compared with a post-write `lstat` (`detective-append` anomaly on
  mismatch). A `createDir`/`unlink` verifies the target/parent realpath after the
  operation, and a delete never creates parent directories. `dev === 0 ||
  ino === 0` is refused by name (`identity-unavailable`) instead of being treated
  as a match. A mismatch throws a named refusal and records an anomaly.
- The detective lock path (`withPinnedCrossProcessLock` on macOS/Windows) checks
  the lock parent's realpath before acquisition and after release and records a
  `detective-lock` anomaly. A failed check fails closed; `fail-closed` never
  degrades to this path.
- **Scope of the 0.10.1 patch.** These detective checks close the deterministic
  pre-planted cases (a final-component symlink or a lock/creating-delete parent
  swap); they do not make macOS/Windows preventive. Full detective parity and a
  platform matrix are deferred to 0.13.
- A transient swap that is reverted before the post-write check can be missed in
  `detective` mode. This is why the mode is not selected on Linux.

## 3. Guarantees and residuals

### Guarantees (Linux + usable procfs)

- An intermediate directory renamed or replaced by a symlink **after** the pin
  cannot redirect a create, mkdir, rename, write, lstat, unlink or lock
  publication.
- A destination symlink or hard link is replaced as a directory entry, never
  followed; a victim outside the run is unchanged.
- An append through an inode with `nlink !== 1` is refused before any byte is
  written, so a hard link planted at `events.jsonl` cannot modify the outside
  file.
- `ORIGINAL_REQUEST.md` remains write-once across concurrent processes.
- Every descriptor is closed on success and on every error path.

### Residuals (explicit)

- **procfs unavailable.** Linux without `/proc/self/fd` fails closed for writes
  (and reads, per ADR 0004). Hardened containers that hide procfs lose the
  writer.
- **Descriptor reuse.** A caller that holds a pinned fd across an `await` must
  not close it early; the primitive documents and follows one rule, but a future
  caller can still violate it.
- **Hard links on network filesystems.** `nlink` and `rename`/`link` semantics
  are not reliable on every NFS deployment. The hard-link refusal is a local
  filesystem guarantee; treat shared filesystems as best-effort.
- **Renamed/deleted pinned directory.** If the run (or a pinned parent) is
  renamed, writes through an existing descriptor land in the renamed directory;
  a fresh path-based call fails closed. Artifacts can therefore be "lost" from
  the old name rather than leaked outside.
- **Run-root creation is still path-based.** The first `mkdir` of the run
  directory (and the pre-creation lock for a not-yet-existing run) uses a path.
  Everything after the pin is preventive.
- **macOS and Windows are detective-only.** No pure-JS fd-to-path primitive
  exists; the path-based atomic write plus post-checks is the permanent stance.
- **Same-UID ptrace is unaffected.** A same-UID process that can ptrace the
  plugin can observe or alter its descriptors; this ADR does not create a new
  privilege domain.
- **Writes inside the run remain attacker-influenceable.** Containment stops
  redirection outside the run; it does not authenticate artifact content. A
  writer that can already modify run files can still forge content inside the
  run, which is why verdicts are recomputed from evidence.

## 4. Tests

`scripts/test-safe-fs-write.mjs`, added to the `npm test` chain:

1. exact bytes into `run`, `run/verify`, and a newly created nested directory;
   no fd leak over 1,000 writes (compare `/proc/self/fd`).
2. static intermediate symlink refusal, plus a negative control in which the old
   path-based mkdir+write **does** deposit a marker outside.
3. nested pin: pin `run/verify`, swap the name, write through the pin; bytes in
   the real directory, outside unchanged.
4. root rename after a pin: bytes in the renamed directory, a fresh path call
   refuses, outside unchanged.
5. 1 ms swapper race, 2,000 writes to `sub/report.json`; no marker under
   `outside`, at least one inside success, under 15 s.
6. the same race against an append log; outside never gains a line, inside lines
   parse.
7. hard link at `events.jsonl`: append refused (`nlink > 1`), outside unchanged;
   a plain-append negative control leaks.
8. two child processes × 100 appends through the pinned lock: 200 well-formed
   lines, unique `seq` 1..200, lock artifact observed inside the run.
9. concurrent `ORIGINAL_REQUEST` writes: one wins, one `EEXIST`.
10. pre-planted temp-name symlink/hard link and a destination symlink: victim
    unchanged, target written.
11. non-Linux: static symlink/FIFO cases run; pinned/race cases print an explicit
    `SKIP` line.
12. detective fallback: a test hook moves the renamed temp outside; the
    post-check refuses and records a `write_anomaly` audit event.
13. (0.10.1) detective lock acquires/runs/releases on Linux via
    `setFdTraversalModeForTest("detective")`, records a `detective-lock`
    anomaly/diagnostic, and `fail-closed` still throws.
14. (0.10.1) detective append refuses a pre-planted final-component symlink,
    refuses a post-write `(dev, ino)` mismatch and records `detective-append`,
    and exercises the non-Linux containment branch through
    `setFdContainmentModeForTest("unsupported")`.
15. (0.10.1) `createDir`/`unlink` post-check swaps are refused and audited; a
    delete never creates parent directories; `dev`/`ino` 0 is refused by name.
16. (0.10.1) the Windows lexical table is refused on every platform via
    `setWindowsLexicalModeForTest`; ordinary names are unaffected.
17. (0.10.1) release quarantine survives a lock published inside the release
    seam; the mkdir fallback removes its directory and fails closed when the
    owner write fails.

The existing `scripts/test-safe-fs.mjs` read suite stays green.

## 5. Alternatives considered

- **Native addon with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`.** The
  strongest Linux primitive, but it breaks the zero-dependency/Node-only
  constraint. Rejected; could be an optional future fast path.
- **Path-based write plus post-checks only.** Detective at best; a transient
  swap is missed. Rejected as the Linux default, kept for macOS/Windows.
- **Refuse all writes on every platform.** Safe but unusable; also loses the
  existing atomic-write behaviour that does not depend on procfs.
- **A helper process or separate service.** More moving parts without a new
  privilege domain; rejected for this release.

## 6. Status of the previous decision

ADR 0004's conclusion that "the write path is not solved" is superseded on
Linux by this ADR. The read-side primitive is unchanged. On macOS and Windows
the write path is detective-only, and that is the permanent documented stance.
