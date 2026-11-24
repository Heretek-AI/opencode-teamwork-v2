# ADR 0013: Containment Parity and the Detective Boundary

- **Status:** Accepted (0.13.0)
- **Date:** 2026-11-23
- **Scope:** `plugins/opencode-teamwork/{safe-fs.mjs,locks.ts,tools.ts,tournament.ts}`,
  `lib/security.mjs`, `.github/workflows/platform.yml`,
  `docs/{GUARDRAILS.md,ARTIFACTS.md}`, `SECURITY.md`,
  `scripts/test-safe-fs*.mjs`, `scripts/test-security.mjs`
- **Extends:** [ADR 0004](0004-intermediate-symlink-races.md) (read containment),
  [ADR 0010](0010-pinned-fd-write-containment.md) (pinned-fd writes)
- **Related:** [ADR 0006](0006-artifact-trust-isolation.md) (one UID is not a boundary),
  [ADR 0012](0012-evidence-binding-and-contradiction-detection.md) (evidence binding)

## 1. Context

ADR 0010 made run-directory writes **preventive** on Linux with a usable
`/proc/self/fd`: the destination parent is pinned once and every create, mkdir,
rename, write, lstat, unlink and lock publication is expressed relative to that
descriptor. On macOS and Windows Node core has no fd-to-path primitive, so
writes stayed path-based with post-write checks. The 0.10.1 patch added
deterministic detective cases (final-component append symlink, post-write
`(dev, ino)`, createDir/unlink post-checks, Windows lexical policy, a detective
lock), but the platform boundary was still loosely described and macOS/Windows
ran none of the containment suites in CI.

0.13.0 finishes detective parity, records the run-root identity in the signed
manifest, adds an opt-in fail-closed policy, and makes the platform boundary
honest in CI and documentation.

## 2. Decision

### 2.1 Ancestor identity pin (both platforms)

`detectiveTarget()` records `(dev, ino)` for the run root and every existing
component between it and the destination parent, using `lstat` only (a symlink
component is never followed while pinning). The list is bounded to 32 entries;
the run root is always kept and the closest components win.

Every detective operation re-stats the pinned components:

- immediately before the create, rename or unlink (`pre-create`, `pre-rename`,
  `pre-append`, `pre-create-dir`, `pre-unlink`), and
- again in the post-check (`post-write`, `post-append`, `post-create-dir`,
  `post-unlink`).

A missing, unreadable, symlinked or different-identity component is a named
`identity-changed` refusal and a `detective-identity-changed` anomaly. A
legitimately renamed run root therefore refuses: the old path no longer names
the pinned inode, so the write is not trusted (fail closed). On darwin the run
root is additionally opened as a directory, `fstat`'ed and compared with the
pinned path identity before each mutation; the descriptor is closed in
`finally`. That is identity confidence, not prevention.

Recording the run-root identity in the signed manifest at plan time
(`runRootIdentity {dev, ino}`) is additive. `assertRunRootIdentity` re-checks it
before each control-plane write and refuses `identity-changed` when the root was
renamed or replaced. A legacy/unsigned manifest without the field is a no-op.

### 2.2 Fail-closed policy

`OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1`, or a plan's
`requirePinnedWrites: true`, asserts that the run only accepts **pinned**
control-plane writes. On a host whose traversal mode is not `pinned`
(`detective` on macOS/Windows, `fail-closed` on Linux without procfs) the writer
refuses by name (`containment-mode`) and writes nothing.

- Default off: macOS/Windows keep the documented detective behaviour unless the
  operator asks for the policy.
- The plan option is sticky: a re-plan cannot disable it, and it is registered
  before the first `mkdir`, so a detective host refuses plan artifacts
  immediately.
- The env assertion cannot be cleared by a caller.
- A per-run plan assertion applies only to that run and is rehydrated from
  `plan.dag.json` after a process restart.

### 2.3 Visibility

`doctor --security` reports the traversal mode and the env setting in the
`containment` check. When `requirePinnedWrites` is asserted and the mode is not
pinned, the check is a `fail`, so `--require-hardened` exits 2: the policy is
asserted, so the host must satisfy it. A plain detective host without the policy
remains a warning, not a hard failure.

The first run write in a non-pinned mode records one `detective_mode` diagnostic
per run (not per write) with the mode and the honest boundary sentence. It is
diagnostic only; it does not change the write.

### 2.4 Platform CI

`.github/workflows/platform.yml` runs the containment-relevant suites only
(`test-safe-fs`, `test-safe-fs-write`, `test-approval`, `test-auth`) on
`macos-latest` and `windows-latest` with Node 24. Platform-native cases cover
darwin case-insensitive run spelling, `/tmp` → `/private/tmp` as a fixture root,
a final-component append symlink, non-zero `dev`/`ino`, and win32 junction
refusal, `.. ` / reserved-device / ADS segments, case-varied run paths and
non-zero `dev`/`ino`. A runner that cannot support a case (symlink privilege,
`mkfifo`, a case-sensitive filesystem, a POSIX shebang executable) prints an
explicit `SKIP`/`RECORD` line; nothing fails silently.

## 3. The four windows (verbatim)

1. **static** — a symlink or swapped component that exists before the writer
   checks it is **refused** on both platforms (ADR 0004/0010 checks plus the
   ancestor pin).
2. **transient** — a swap that is reverted before the post-check can be
   **missed**. Detective checks are samples, not a lock.
3. **detected** — when the checks see the swap, the write is reported, but the
   **bytes are already outside, and nothing is rolled back**. A detected write
   is a report about an event that already happened, not a prevented one.
4. **no pure-JS dir-relative write without a native addon** — macOS and Windows
   have no `openat`/`/proc/self/fd` equivalent in Node core. A preventive,
   directory-relative write there would require a native addon, which this
   package does not ship. The platform boundary is therefore permanent:
   **macOS/Windows are detective; Linux without procfs fails closed.**

## 4. Guarantees and residuals

### Guarantees

- **Linux + usable procfs:** unchanged preventive pinned-fd writes (ADR 0010).
- **macOS/Windows (detective):** a statically planted symlink is refused on the
  read and write paths; an append through a final symlink is refused; a
  post-write `(dev, ino)` mismatch, a renamed/replaced run root, or a swapped
  ancestor produces a named refusal and an audit anomaly. A delete never creates
  parents. `dev`/`ino` 0 is refused by name (`identity-unavailable`).
- **Policy:** `REQUIRE_PINNED_WRITES`/`requirePinnedWrites` refuses control-plane
  writes on a non-pinned host with a `containment-mode` refusal.
- **Signed manifest:** a plan-time run-root identity is re-checked before
  control-plane writes; a renamed/replaced root fails closed.

### Residuals (explicit)

- **Transient swap.** A rename/replace that is reverted before the check is
  missed. Detection is not prevention.
- **No rollback.** A detected write already happened. The bytes might be outside
  the run and the tool refuses the result; it does not undo the effect.
- **`ino` reuse.** `(dev, ino)` equality is a strong hint, not a proof: a
  filesystem may reuse an inode number after deletion. The post-check is a
  point-in-time comparison.
- **No dir-relative write.** On macOS/Windows, path resolution is still
  path-based; a same-UID process that can race the path can redirect a write
  inside a window the checks do not observe.
- **Same-UID ptrace.** A process that can ptrace the plugin can observe or alter
  its descriptors and memory on any platform.
- **Manifest absence after restart.** The signed-manifest identity re-check is
  fail-closed once a run identity has been observed in the process; a fresh
  process that finds no manifest falls back to the run's normal missing-artifact
  handling, not to a new identity.
- **Writes inside the run remain attacker-influenceable.** Containment stops
  redirection outside the run; it does not authenticate artifact content.
- **macOS case-folding and Windows 8.3 names.** The writer validates segments
  lexically and by identity, but the host filesystem's aliasing rules still
  apply to what a same-UID process can name.
- **First run-root creation is path-based.** The initial `mkdir` of the run
  directory remains path-based on every platform.

## 5. Tests

- Identity pin: an ancestor swapped after the pin / after the temp create is
  refused with `identity-changed`; a legitimately renamed run root refuses; an
  append through a renamed root refuses in the post-check; the darwin root-fd
  check is exercised on Linux through a test seam.
- Policy: `REQUIRE_PINNED_WRITES=1` refuses manifest/state/costs/verify writes,
  `createDir` and appends in detective mode; default off still writes; a
  per-run plan assertion refuses only that run; pinned mode satisfies it;
  `detective_mode` is recorded once per run.
- Manifest identity: a matching root passes, a renamed/replaced root fails
  closed, a legacy manifest is a no-op.
- Doctor: the containment check reports the mode and env setting; an asserted
  policy on a detective host is a fail and `--require-hardened` exits 2.
- Platform jobs run the four suites on macOS and Windows; Linux suites stay
  green.

## 6. Alternatives considered

- **Native addon with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` or a
  Windows handle-relative equivalent.** Preventive, but breaks the
  zero-dependency/Node-only constraint and the single-file manual install.
  Rejected; could be an optional future fast path.
- **Always-on fail-closed policy on macOS/Windows.** Would refuse every run on
  the platforms the package supports. Rejected; the policy is opt-in and
  visible.
- **Claim detective checks as prevention.** False. Rejected; the four windows
  are documented verbatim above and the doctor calls the mode what it is.
