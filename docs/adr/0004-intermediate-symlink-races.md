# ADR 0004: Post-Open fd Containment for Intermediate-Component Symlink Races in Run-Directory Reads

- **Status:** Implemented for the read path on Linux (Sprint 1.2); the write path remains proposed
- **Date:** 2026-11-22
- **Workstream:** Sprint 2, S4a (follow-up to the PR #10 hardening)
- **Classification:** ADR / security design gate
- **Related:** [PR #10](https://github.com/Heretek-AI/opencode-teamwork-v2/pull/10), `docs/ARTIFACTS.md:806-809`, `docs/GUARDRAILS.md:28-43`

## 1. Context

### 1.1 The invariant under attack

Run artifacts live under `<workspace>/.opencode/teamwork/<session-id>/` and are treated as untrusted control data (`docs/ARTIFACTS.md:7-38`, `docs/GUARDRAILS.md:6-41`). A reader must not return bytes from a file outside that run directory, even when an attacker can create, rename, or delete entries **inside** the run directory.

The primary read path is:

1. `readBoundedRunFile(run, targetPath, maxBytes)` calls `ensureSafeRunSubpath(run, targetPath)` and then `readBoundedFileNoFollow(check.path, maxBytes)` (`plugins/opencode-teamwork/tournament.ts:404-408`).
2. `ensureSafeRunSubpath` validates the run directory and every path segment with `lstatSync`, then validates the parent and target with `realpathSync`, and finally returns the resolved target path (`plugins/opencode-teamwork/tournament.ts:251-323`).
3. `readBoundedFileNoFollow` opens that returned **path** with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then uses `fstat` on the returned fd for the authoritative type and size check (`plugins/opencode-teamwork/tournament.ts:347-402`, flags at `:352-353`, open at `:363`, `fstat` at `:364`).

There are also two independent CLI readers:

- `lib/export.mjs` has its own `readBounded` (`lib/export.mjs:144-172`) with an `lstatSync` pre-check (`:147`), `O_RDONLY | O_NOFOLLOW` open (`:148`), and `fstat` (`:149`). Call sites are `:203`, `:232`, and `:255`.
- `lib/timeline.mjs` has the same implementation (`lib/timeline.mjs:54-82`, pre-check `:57`, open `:58`, `fstat` `:59`). Call sites are `:136` and `:221`.

Those two readers are intentionally not routed through `tournament.ts` (`lib/export.mjs:14-18`, `lib/timeline.mjs:13-16`).

### 1.2 What PR #10 already closed

PR #10 made the **final** path component atomic on POSIX:

- `O_NOFOLLOW` makes the open fail with `ELOOP` if the final component is a symlink.
- `O_NONBLOCK` prevents `open()` from blocking forever on a FIFO.
- `fstat(fd)` is authoritative for the opened inode, so a final component swapped *after* the open cannot change the type or size the reader validates.
- `readSync` retries `EINTR` and fails closed on `EAGAIN` and every other error (`plugins/opencode-teamwork/tournament.ts:374-381`).
- The non-POSIX fallback is an `lstat` pre-check and still refuses symlinks and non-regular files, but is explicitly non-atomic (`plugins/opencode-teamwork/tournament.ts:354-362`).

The existing FIFO regression test is `scripts/test-engine.mjs:4891-4939`; it runs the reader in a child process with a hard timeout so a blocking regression fails rather than hangs the suite.

### 1.3 What remains

`O_NOFOLLOW` only affects the **final** component. `ensureSafeRunSubpath` performs all of its `lstat`/`realpath` checks *before* `readBoundedFileNoFollow` calls `openSync` (`plugins/opencode-teamwork/tournament.ts:269-321` versus `:363`). An attacker who can rename an intermediate directory inside the run can therefore make the checked path resolve to a different directory between the check and the open.

The code already documents the gap:

- `plugins/opencode-teamwork/tournament.ts:342-345`: "`O_NOFOLLOW` protects only the final path component. An intermediate directory swapped for a symlink between the segment checks and the open is still a race; closing it fully needs component-by-component `openat`/`O_PATH` traversal, which is not implemented here."
- `lib/export.mjs:14-18` and `lib/timeline.mjs:13-16` say the same for their readers.
- `docs/ARTIFACTS.md:806-809` records the same limitation in the public artifact contract.

An adversarial review in Sprint 2 demonstrated the bypass: swap an intermediate directory (for example `run/verify/`) for a symlink to an outside directory after the segment checks and before the open, and the reader returns the outside regular file's contents. This ADR responds to that finding. **No fix is claimed here.**

### 1.4 Reproducible shape of the bypass

```text
run/
  verify/            <- real directory during ensureSafeRunSubpath
    report.json      <- inside file, passes every check

attacker: rename(run/verify, run/verify.real)
          symlink(outside_dir, run/verify)      <- now points outside

readBoundedRunFile(run, run/verify/report.json)
  ensureSafeRunSubpath: already passed (saw run/verify as a directory)
  openSync(run/verify/report.json, O_NOFOLLOW)
    -> resolves through the symlinked run/verify
    -> opens outside_dir/report.json
  fstat: regular file, within byte cap
  -> status "ok" with outside contents
```

The final component (`report.json`) is not a symlink, so `O_NOFOLLOW` does not help. The final `fstat` sees a perfectly ordinary regular file; it has no way to know which directory the path resolved through.

The same class applies to the run directory itself: `ensureSafeRunSubpath` calls `lstatSync(run)` and `realpathSync(run)` at `plugins/opencode-teamwork/tournament.ts:254-258`, and the open happens later by path at `:363`.

### 1.5 Scope of this ADR

In scope: the **read** path used by `readBoundedRunFile`/`readBoundedFileNoFollow`, plus the same pre-check-then-open pattern in `lib/export.mjs` and `lib/timeline.mjs`.

Out of scope but noted:

- The **write** path has the same structural risk. `writeSafeRunFile` validates the target and temp path with `ensureSafeRunSubpath` (`plugins/opencode-teamwork/tournament.ts:428-436`, `:445`), then `writeFileSync` and `renameSync` operate by path (`:448`, `:453`). A raced intermediate directory can redirect the create/rename outside the run. The read mitigation in this ADR does not fix it.
- `tools.ts` calls `readBoundedFileNoFollow` directly from `readRunText` (`plugins/opencode-teamwork/tools.ts:988-990`), without `ensureSafeRunSubpath`; call sites include `join(run, "ORIGINAL_REQUEST.md")` (`:840`), `join(run, "pitfalls.md")` (`:995`), and `join(run, "prompt_draft.md")` (`:5308`). A bare file path cannot be containment-checked because the low-level reader does not know the run root. The post-open check proposed here therefore belongs in a root-aware primitive (`readWithinBounded(runReal, file, maxBytes)`), and `readRunText` / its call sites must pass the run root so these direct reads get the same check.
- A hardlink inside the run to an outside file is not a path-traversal escape: the inode is reachable from inside the run, and creating the link requires the target to be owned by the process user (or `protected_hardlinks` to be disabled) plus write access to the run directory. It is a separate threat and is not addressed here.

## 2. Threat Model and Impact

### 2.1 Attacker capabilities assumed

- Can create, rename, and delete entries **inside** `<workspace>/.opencode/teamwork/<session-id>/`, including subdirectories.
- Can win a race against a coordinator/verifier/CLI read, or can plant a static intermediate symlink.
- **Cannot** write or rename entries outside the run directory (no write permission on the target directory, no ownership of the target).
- Does not need to be a different OS user. A compromised or prompt-injected agent, a malicious artifact writer, or untrusted run content is enough. The process may hold read permissions the attacker does not directly have (for example, a secret elsewhere in the workspace or in the user's home directory).

### 2.2 Impact

**Containment bypass / information disclosure.** Outside file contents can be pulled into:

- run context injected by `describeRun` / `session.hook("context")` (`plugins/opencode-teamwork/tools.ts:988-990` and its callers),
- `timeline` and `export` output, and
- reports or logs derived from those reads.

That can leak secrets into prompts, transcripts, or exported artifacts even though the attacker could not read the file directly.

**Not privilege escalation.** Reaching a false `PASS` still requires writing run-dir artifacts (a manifest, a report, a verdict), which run-dir write access already permits. Verdicts are recomputed from evidence, not from injected context (`docs/ARTIFACTS.md:809-813`). The security boundary that is crossed is *containment*: the reader's promise that it only reads inside the run.

### 2.3 Non-goals

- Authenticating run content. A writer inside the run can still forge a manifest or a report; that is accepted by the threat model and is documented at `docs/ARTIFACTS.md:809-813`.
- Defending against an attacker who can write outside the run, control the kernel, mount a malicious `/proc`, or replace the Node binary.
- Preventing the `open()` syscall itself. The proposed control is detective: it refuses to **read or return** bytes after checking the opened fd. It cannot guarantee that the open never touched an outside path, and it cannot undo side effects of opening a special file (the existing `fstat` regular-file check runs before any read).
- Fixing write-path containment.

## 3. Options

### 3.1 Option (a): component-by-component `openat` / `O_PATH` traversal

Walk from a directory fd for the run root, opening each segment relative to the previous directory fd with `O_NOFOLLOW | O_DIRECTORY`, then open the final component relative to the last directory fd with `O_NOFOLLOW | O_NONBLOCK`.

**Pros**

- Preventive and exact: no path re-resolution between validation and open.
- Refuses intermediate symlinks at the syscall boundary, not by a separate check.
- Works for reads and writes if the write path is rewritten the same way.

**Cons**

- Node core has no `openat`/`openat2` API. `fs.open` takes a path, and `fs.constants.O_PATH` is not even defined on the Node v26.13.1 / Linux 7.4 host used for this review (runtime probe).
- A pure-JS Linux workaround exists: after opening a directory fd, `openSync("/proc/self/fd/<dirfd>/<segment>", O_NOFOLLOW | O_DIRECTORY)` resolves relative to the pinned directory inode. This was verified on the review host. It is still Linux-only, adds one fd per path segment, and is a procfs trick rather than a stable Node API.
- On macOS, `/dev/fd/<fd>` is not guaranteed to support path traversal beneath the fd, and Node exposes no `fcntl(F_GETPATH)` binding. A native addon would be required for a real component-wise traversal.

**Verdict:** the correct long-term primitive, but too large and too platform-specific for this sprint. The Linux procfs variant is a reasonable follow-up once the smaller control is in place.

### 3.2 Option (b): Linux `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`

Kernel 5.6+ supports `openat2(2)` with `RESOLVE_BENEATH` (refuse any resolution that escapes the starting directory) and `RESOLVE_NO_SYMLINKS` (refuse every symlink component). This is the strongest Linux-only guarantee.

**Pros**

- One syscall closes the entire class, including intermediate components.
- `RESOLVE_BENEATH` expresses the containment invariant directly.

**Cons**

- Node core exposes no `openat2` binding. Using it requires a native addon, a helper binary, or an unstable internal binding. All of those violate the package's zero-runtime-dependency constraint and complicate installation on Node >=18 and on non-Linux platforms.
- Kernel/version gating and an `ENOSYS`/`EINVAL` fallback are required.
- `RESOLVE_NO_SYMLINKS` forbids all symlinks, including a symlinked workspace root; the run root must be resolved first and passed as the `dirfd`, which means the same directory-fd plumbing as option (a).

**Verdict:** an optional fast path only if a zero-dependency binding becomes available. It is not part of the proposed implementation.

### 3.3 Option (c): post-open fd identity / containment check

Keep the existing pre-checks, `O_NOFOLLOW`, `O_NONBLOCK`, and `fstat`. After the open and the regular-file check, resolve the fd's current path and assert it is still under the run's real path:

```text
fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
fst = fstatSync(fd)                     // regular file?
if /proc/self/fd exists:
  try fdPath = realpathSync("/proc/self/fd/" + fd)
  catch -> refuse                       // e.g. deleted file: ENOENT
  if fdPath ends with " (deleted)" -> refuse
  rel = relative(runReal, fdPath)
  if !rel || rel.startsWith("..") || isAbsolute(rel) -> refuse
read(fd)
```

**Pros**

- Pure JS, zero dependencies, no native addon, no new package entry point.
- Works on Linux where `/proc/self/fd` is mounted (verified on the review host: `realpathSync("/proc/self/fd/<fd>")` returns the opened file's path).
- Catches the raced intermediate symlink **before any bytes are read**, because the check is placed between `fstat` and the first `readSync`.
- Can cover direct callers such as `readRunText` once they pass the run root to the root-aware primitive; it does not require the full `ensureSafeRunSubpath` policy on every call.
- Small enough to share with the CLI readers (see `docs/spikes/shared-safe-fs.md`).

**Cons**

- Detective, not preventive: the outside file is opened, then refused. For a regular file that is harmless; for a special file, `fstat` refuses before any read, but the open itself still occurred.
- Linux-only in practice. macOS has no pure-JS fd-to-path primitive in Node core (`fcntl(F_GETPATH)` is not bound, and `/dev/fd` path resolution is not guaranteed); Windows has neither. Those platforms keep the current behavior and the residual risk.
- The fd path can change between the check and the read if the attacker can rename the file **outside** the run, which the threat model excludes. Renames **inside** the run are harmless: the bytes are still inside.
- It does not prove the inode was the *intended* child. A run-dir writer can redirect the path to a different file **inside** the run; that is already permitted by run-dir write access and is not a containment breach.
- Requires a documented fail-closed policy when `/proc/self/fd` exists but resolution fails (for example, a deleted file or a restricted `/proc`).

**Verdict:** the smallest portable improvement that actually closes the demonstrated read bypass on Linux. Recommended.

### 3.4 Option (d): accept and document the residual risk

Keep the current code and the known-limitation comments (`plugins/opencode-teamwork/tournament.ts:342-345`, `lib/export.mjs:14-18`, `lib/timeline.mjs:13-16`, `docs/ARTIFACTS.md:806-809`).

**Pros:** zero change, zero new platform assumptions.

**Cons:** a demonstrated containment bypass remains in a security-hardening sprint. The mitigation in option (c) is small enough that "accept" is hard to justify on Linux.

**Verdict:** rejected as the primary decision. Keep the documentation current for platforms where (c) is unavailable.

### 3.5 Comparison

| | Preventive | Portable | Zero deps | Node-only | Covers writes | Complexity |
|---|---|---|---|---|---|---|
| (a) `openat`/`O_PATH` | yes | no (Linux procfs / native on macOS) | yes on Linux procfs; no on macOS | yes on Linux; native elsewhere | yes if reused | high |
| (b) `openat2` | yes | Linux only | no (native) | no | yes if reused | high |
| (c) post-open fd check | no (detective) | Linux only in practice | yes | yes | no | low |
| (d) accept | no | yes | yes | yes | no | none |

## 4. Decision

**Adopt option (c) for the read path, as a defense-in-depth control, with an optional future option (b) fast path.**

Specifically:

1. **Keep every existing check.** `ensureSafeRunSubpath` remains; `O_NOFOLLOW`, `O_NONBLOCK`, `fstat`, the byte cap, and the `EINTR`/fail-closed handling remain. The post-open check is additive.
2. **Place the check in the root-aware read primitive**, not in the pre-check itself. `readBoundedRunFile` keeps `ensureSafeRunSubpath`, which must also return `runReal`; it then calls `readWithinBounded(runReal, path, maxBytes)`. The bare `readBoundedFileNoFollow(file, maxBytes)` cannot enforce containment because it has no root, so `tools.ts` `readRunText` and its call sites must pass the run root (or the run directory) and use the root-aware primitive for direct reads.
3. **Check before the first read.** Order: `open` -> `fstat` -> regular-file check -> size check -> fd containment -> read. No bytes are read from a refused fd.
4. **Fail closed on ambiguity.** If `/proc/self/fd` exists and the fd path cannot be resolved, or resolves to a path ending in `" (deleted)"`, return `status: "error"` with a `refused:` message. If `/proc/self/fd` does not exist (macOS, Windows, hardened containers), keep the current behavior and the documented residual risk; do not turn every read into an error.
5. **Record the platform boundary.** The guarantee is "on Linux with a mounted `/proc/self/fd`, an outside regular file is never returned." It is not a portable guarantee. Update `docs/ARTIFACTS.md:806-809`, the reader comments, and the guardrails table to say exactly that.
6. **Keep the optional `openat2` fast path out of scope.** If a zero-dependency binding appears, it can be added behind a capability probe; it must not become a required native dependency.
7. **Proposed, not implemented.** This ADR does not claim the code has changed. The acceptance tests in §5 define what "done" means.

What remains unprovable without `openat`-style traversal:

- That the path resolved to the intended directory at the instant of the open. The check proves only that the opened fd's path is inside the run when checked.
- That the open itself had no side effects. `fstat` prevents reading a non-regular file, but it cannot undo an open of a device or FIFO (the latter is non-blocking).
- On macOS and Windows, anything stronger than the current pre-checks.

## 5. Acceptance Tests

These tests are **proposed**. They should be added with the implementation; until then, they describe the target behavior. All paths below are inside a fresh `mkdtemp` fixture.

### 5.1 Static intermediate symlink

Setup:

```text
root/run/                  (real directory)
root/run/verify -> root/outside   (symlink)
root/outside/report.json   (regular file containing SENTINEL)
```

Assert:

- `readBoundedRunFile(run, join(run, "verify", "report.json"), 4096)` returns `status: "error"`.
- The error is a `refused:` message naming a symlink, escape, or non-regular file.
- The returned object does not contain `SENTINEL`.
- The outside file is unchanged.

This case is caught by the existing segment `lstat` (`plugins/opencode-teamwork/tournament.ts:278-284`); it is the baseline that proves the pre-check still works.

### 5.2 Final symlink

Setup: `root/run/report.json -> root/outside/report.json`, with `SENTINEL` in the outside file.

Assert:

- `readBoundedRunFile(run, join(run, "report.json"), 4096)` returns `status: "error"`.
- No `SENTINEL` is returned.
- The behavior is unchanged by the post-open check: `O_NOFOLLOW` produces `ELOOP`, mapped to a refusal at `plugins/opencode-teamwork/tournament.ts:391-393`.

Also run a **final-component race** variant: a child process alternates `run/report.json` between a regular inside file and a symlink to the outside file while the parent reads in a loop. Assert zero outside reads. This is a regression guard for PR #10, not for the new check.

### 5.3 FIFO

Setup: `mkfifo root/run/report.json`.

Assert:

- The read returns `status: "error"` and does not hang.
- Run it in a child process with a 15-second timeout, following `scripts/test-engine.mjs:4891-4939`.
- A timeout is a test failure, not a skip.

### 5.4 Race harness (intermediate directory swap)

This is the test that distinguishes the pre-fix and post-fix code.

Parent process (reader):

```js
const run = join(root, "run")
const sub = join(run, "sub")           // real dir with secret.json
const outside = join(root, "outside")  // outside dir with secret.json = SENTINEL

const swapper = spawn(process.execPath, ["-e", swapperCode], {
  env: { ...process.env, SUB: sub, OUTSIDE: outside },
})

let okInside = 0
for (let i = 0; i < 2000; i++) {
  const r = readBoundedRunFile(run, join(run, "sub", "secret.json"), 4096)
  if (r.status === "ok") {
    if (r.text.includes("SENTINEL")) assert.fail("outside content returned")
    okInside++
  }
}
swapper.kill()
assert(okInside > 0, "harness never read the legitimate inside file")
```

Swapper child (hold each state briefly so both the legitimate read and the race window are exercised):

```js
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (;;) {
  renameSync(SUB, SUB + ".real")
  symlinkSync(OUTSIDE, SUB)
  sleep(0.5)
  renameSync(SUB, SUB + ".link")
  renameSync(SUB + ".real", SUB)
  sleep(0.5)
  unlinkSync(SUB + ".link")
}
```

Assertions:

- Zero results contain `SENTINEL`.
- At least one read succeeds against the legitimate inside file, so the loop is actually exercising the path (not just `ENOENT`).
- The whole test completes under 15 seconds and does not hang or crash.
- Add a **negative control** in the test file: a local `vulnerableRead` that performs the old `lstat`-then-`open` sequence with a deliberate busy-wait between the check and the open. Run the same swapper against it and assert it observes at least one `SENTINEL` read. This proves the harness can detect the bug class; it is not run against production code.
- The zero-leak assertion is a regression guard, not a proof. The negative control is what makes a pass meaningful.

### 5.5 fd containment primitive (deterministic)

If the fix exports a small `fdWithin(runReal, fd)` helper for testing, assert:

1. An fd opened at `run/a.txt` is inside `runReal` -> `true`.
2. An fd opened at `outside/b.txt` is outside -> `false`.
3. Open `run/a.txt`, rename it to `outside/a.txt`, then check -> `false` (path is now outside).
4. Open `run/a.txt`, unlink it, then check -> `false` (deleted; fail closed).
5. Open `run/a.txt`, rename the run directory, then check against the old `runReal` -> `false` (fail closed; a false negative is acceptable).

This is deterministic and directly tests the new primitive, independent of the race harness.

### 5.6 Cross-reader tests

- `lib/export.mjs`: a fixture with `pitfalls.md` or `events.jsonl` as an intermediate-symlink target must produce an `unreadable` diagnostic and no sentinel in the rendered HTML/Markdown. Add to `scripts/test-export.mjs`.
- `lib/timeline.mjs`: a fixture with `events.jsonl` or `verify/` symlinked must produce the corresponding warning/UNKNOWN and no sentinel. Add to `scripts/test-timeline.mjs`.
- A FIFO in `events.jsonl` must not hang `buildTimeline`; the current lib readers do not pass `O_NONBLOCK` (`lib/export.mjs:148`, `lib/timeline.mjs:58`), so this test will initially fail. It should be added with the shared-reader change, or as a separate bug fix.

### 5.7 Gates

- `npm test` stays green (`package.json:53`).
- No new runtime dependency: `package.json` has no `dependencies` field today, and the diff must not add one.
- On Linux with `/proc/self/fd`, §5.4 and §5.5 run and must pass.
- On platforms without `/proc/self/fd`, those tests skip with an explicit `SKIP: /proc/self/fd unavailable` line; the static symlink and FIFO tests still run.
- `docs/ARTIFACTS.md:806-809` and the three reader comments are updated to state the Linux-only guarantee and the remaining macOS/Windows gap.

## 6. Consequences

### Positive

- Would close the demonstrated intermediate-directory read bypass on Linux for regular files, before any bytes are returned.
- Covers direct `readBoundedFileNoFollow` callers that skip `ensureSafeRunSubpath`.
- Small, dependency-free, and compatible with Node >=18.
- Composable with the shared safe-fs module proposed in `docs/spikes/shared-safe-fs.md`.

### Negative

- One extra `realpathSync` per read on Linux; negligible against JSON parsing and file I/O.
- A new platform distinction in the security contract: Linux stronger, macOS/Windows unchanged.
- `/proc/self/fd` may be absent or restricted in hardened containers; the fallback must be documented and must not silently claim the stronger guarantee.
- False negatives if the run directory is renamed after `runReal` is computed; the read is refused, which is safe but may surprise callers.

### Residual risks

- The `open()` itself still occurs on the outside path before the check. For regular files this is harmless; the `fstat` regular-file check prevents reading devices/FIFOs.
- macOS and Windows retain the intermediate-component race.
- Write paths retain the same race; `writeSafeRunFile` is not fixed by this ADR.
- A run-dir writer can still forge content inside the run and influence what agents read. That is accepted and documented; verdicts are recomputed from evidence.
- Hardlinks inside the run to outside files are outside this threat model.

### Follow-ups

1. Implement the shared safe-fs module (`docs/spikes/shared-safe-fs.md`) so all three readers get the same check.
2. Evaluate Linux `/proc/self/fd/<dirfd>/<segment>` traversal for a preventive read path, and a native/optional `openat2` path if a zero-dependency binding becomes available.
3. Apply the same analysis to `writeSafeRunFile` (`plugins/opencode-teamwork/tournament.ts:428-457`) and the `tools.ts` writers.
4. Add `O_NONBLOCK` to the `lib/*.mjs` readers, or route them through the shared module, to remove the FIFO-blocking difference.

## 7. Alternatives Rejected

- **(a) component-wise `openat`/`O_PATH` now:** correct, but Node core has no directory-relative open; the Linux procfs workaround is a larger change and does not help macOS. Defer.
- **(b) `openat2` now:** strongest on Linux, but requires a native addon or helper and breaks the zero-dependency/Node-only constraint. Keep as an optional future fast path.
- **(d) accept and document only:** leaves a demonstrated containment bypass that option (c) closes cheaply on the primary platform. Keep the documentation for platforms where (c) is unavailable, not as the decision.

## 8. The Exact Missing Primitive

A directory-fd-relative open in Node core:

```text
openat(dirfd, path, flags)                      // POSIX
openat2(dirfd, path, how)                       // Linux 5.6+, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
fcntl(fd, F_GETPATH, buf)                       // macOS fd-to-path
```

Node's `fs` exposes only path-based `open`, and `fs.constants.O_PATH` is not defined on the review host (Node v26.13.1 / Linux 7.4). Without one of those primitives, there is no portable way to prove that the path validated is the path opened. On Linux, `/proc/self/fd/<dirfd>/<segment>` is a usable workaround but is not a cross-platform API and is not used by the proposed patch. On macOS, there is no pure-JS fd-to-path primitive, so option (c) cannot be enforced there without a native binding.

## 9. References

- `plugins/opencode-teamwork/tournament.ts:251-323` — `ensureSafeRunSubpath` per-segment `lstat` and `realpath` checks.
- `plugins/opencode-teamwork/tournament.ts:342-345` — documented intermediate-component limitation.
- `plugins/opencode-teamwork/tournament.ts:347-402` — `readBoundedFileNoFollow` (`O_NOFOLLOW`, `O_NONBLOCK`, `fstat`, bounded read, fail-closed errors).
- `plugins/opencode-teamwork/tournament.ts:404-408` — `readBoundedRunFile` check-then-open sequence.
- `plugins/opencode-teamwork/tournament.ts:428-457` — `writeSafeRunFile` (same pre-check-then-path-write pattern).
- `plugins/opencode-teamwork/tools.ts:988-990` — `readRunText` calls the low-level reader directly.
- `plugins/opencode-teamwork/tools.ts:1335-1361` — duplicate `ensureSafeRunSubpath` in the tool layer.
- `plugins/opencode-teamwork/tools.ts:1363-1375` — `writeTextSafe` / `writeJsonSafe`.
- `plugins/opencode-teamwork/tools.ts:182-197` — `writeTextAtomicSafe` (random temp, `wx`, rename).
- `lib/export.mjs:14-18`, `lib/export.mjs:144-172` — independent reader and its known limitation.
- `lib/timeline.mjs:13-16`, `lib/timeline.mjs:54-82` — independent reader and its known limitation.
- `docs/ARTIFACTS.md:806-809` — public known-limitation statement.
- `scripts/test-engine.mjs:4891-4939` — existing FIFO timeout regression test.
- `scripts/test-engine.mjs:3485-3577` — existing symlink/containment tests.
- `package.json:33-44` — npm `files` whitelist; `package.json:53` — `npm test` chain.
- Runtime probe: Node v26.13.1, Linux 7.4, `/proc/self/fd` present; `O_NOFOLLOW`, `O_DIRECTORY`, `O_NONBLOCK` defined; `O_PATH` undefined.
