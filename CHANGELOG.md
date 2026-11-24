# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0] - 2026-11-24

Re-executable verification. A verifier `PASS` can now record argv-only command
evidence, and the offline verifier can re-execute it at the commit the report
observed. Additive for existing runs: a version 1–3 manifest is read as
`requiredProvenance: "declared"`, which keeps the 0.15 semantics.

### Added

- **`requiredProvenance: "declared" | "command"` (ADR 0016).** New plans write a
  version-4 manifest. `command` makes a `PASS` report carry at least one
  programmatic check with `command`/`cwd`/`exitCode`/`outputBytes`/
  `outputTruncated`/`commandSha256`/`durationMs`, and requires a `headSha`.
  Sticky: a re-plan may upgrade `declared → command`, never downgrade it
  (`AUTH_STALE`).
- **checks[] v2.** `command` is argv only (≤32 args; `sh -c`/`bash -c` refused),
  `cwd` is worktree-relative, `commandSha256 = contentSha256Hex(canonicalJson({argv,
  cwd}))`, `passed === (exitCode === 0)`. The existing `output`/`outputSha256`
  keys are unchanged; a command's `output` is preserved exactly (not trimmed)
  so its digest is reproducible.
- **`verify/rerun.json`.** A signed per-task projection of the command checks
  (`version`, `sessionId`, `tasks.<id>.checks[{name,argv,cwd,expectedExit,
  outputSha256,outputBytes,timeoutMs}]`, `generatedAt`). `teamwork_report`
  merges and re-signs it; `final_verify` re-checks the envelope and projection
  and stamps `evidence.rerunDigest` in `verify/final.json`.
- **`opencode-teamwork verify --rerun --repo <clean-checkout> [--timeout <s>]
  [--keep-worktree]`.** Creates a detached worktree at `report.headSha`, runs
  each argv with `spawnSync` (no shell, minimal env, `cwd` inside the worktree),
  enforces `timeoutMs`, and compares exit code plus stdout+stderr digest.
  Failures: `output-digest-mismatch`, `command-failed`, `command-timeout`,
  `command-refused` (exit 1), `command-unavailable` (exit 2),
  `source-tree-modified`. The worktree is removed unless `--keep-worktree`.
- **Claimed provenance.** Under `command`, `verify` without `--rerun` reports
  `provenance: claimed` and returns `UNKNOWN` (exit 2), never `PASS`. Under
  `declared`, 0.15 behaviour is unchanged with a `provenance: declared` note.

### Changed

- New signed plans write `run.manifest.json` version 4. Existing version 3
  manifests stay valid and are read as `declared`.
- `teamwork_report` refuses a programmatic check without a command under
  `command` (and a `PASS` with no re-executable check) with
  `CHECK_COMMAND_MISSING`; `verified_pass` and `final_verify` refuse a report
  without `headSha` with `REPORT_UNBOUND`.
- Tests: T20–T29 in `scripts/test-verify.mjs` cover re-execution, every failure
  shape, shell/cwd refusal, worktree lifecycle, stale `rerun.json`, downgrade,
  legacy 0.15 parsing, the T17 negative control under `--rerun`, and
  passed/exitCode conflicts. `scripts/test-engine.mjs` covers the writer,
  `final_verify`, sticky provenance and `REPORT_UNBOUND`.

## [0.15.0] - 2026-11-24

Offline verification. A run can now be checked from a read-only copy and a
public key, without the plugin, the key ring or `ctx.storage`. Additive: no
artifact schema changed and no engine tool reads the verifier.

### Added

- **`opencode-teamwork verify` (ADR 0015).** `--session <id>` or `--run-dir
  <path>`, `--public-key <base64url|@file>` (or `--hmac-key <b64url>` +
  `--hmac-key-id`), optional `--repo`/`--require-git`, `--require-index
  <snapshot>`, `--allow-unsigned`, `--fail-on-warning` and `--json`. Exit codes:
  `0` verified, `1` fail, `2` unverifiable, `3` usage. The signed manifest's
  `runNonce`/`runKeyId`/algorithm pin every artifact's `_auth` path, digest,
  nonce, key id and algorithm; no digest index is required.
- **Relation recomputation.** Victory `evidenceDigests` (including reports that
  appeared after the audit and reports never reviewed), audit `ruleChecks`
  coverage against the mode parsed from `ORIGINAL_REQUEST.md` plus
  `reviewedDigests`, report→worker-handoff bindings, wave `cites` (`sha256` and
  bytes), handoff index entry auth/body-hash/bytes/header/cites, final
  `reportDigests`/`auditDigest`/`requirementsHash`, the manifest baseline hashes,
  and the four `INCONSISTENT_*` contradictions.
- **Honest failure shapes.** A `cites: []` wave is unbound (fail); absent cites
  is `legacy_unbound_wave` (warn); a `null` report digest for a PASS fails; a
  `passed`/`exitCode` conflict fails; a legacy victory without `evidenceDigests`
  is `AUTH_STALE`; an unsigned legacy run is `UNKNOWN`, never `PASS`.
- **Optional rollback check.** `--require-index <snapshot>` compares every
  run-relative file to an unkeyed SHA-256 snapshot and reports `INDEX_ROLLBACK`.
  `--require-index` without a path is `UNKNOWN`.
- **Read-only guarantee tests.** `scripts/test-verify.mjs` (T01–T19) builds
  fixtures through the real signer and handoff writer, covers every named
  failure, and runs one fixture under `chmod -R a-w` to assert unchanged sizes,
  mtimes and file set. T17 is the negative control: a consistently signed,
  invented observation still verifies (documented residual).

### Documentation

- Add [ADR 0015](docs/adr/0015-offline-verification.md), a README section, a
  `docs/ARTIFACTS.md` "what the verifier recomputes" table, and the exact
  residual in `SECURITY.md`.
- Add `lib/verify.mjs` and `scripts/test-verify.mjs` to the packaging guard's
  required list. `npm test` now runs `test:verify`.

## [0.14.0] - 2026-11-24

Verifiable witness receipts, honest approval-key diagnostics, and the
policy-signer half of the v2 contract with its approval producer. Additive
schemas; a deployment that does not set the new variables keeps the 0.13
behaviour.

### Added

- **Signed witness receipts (ADR 0014).** The witness request is
  `{v:2, runId, path, digest, keyId, nonce, at}`. With
  `OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY` (SPKI base64url, optional `_KEY_ID`) a
  witness must return `{receipt, alg:"ed25519", keyId, sig}` over
  `teamwork-witness-v1\0runId\0path\0digest\0nonce\0at`; the record stores
  `{receipt, alg, keyId, sig, at}`. `final_verify` verifies the receipt against
  the manifest digest/nonce: a missing receipt is `AUTH_WITNESS_UNAVAILABLE`, a
  forged/foreign/different-digest record is `AUTH_INVALID`. Without the public
  key the receipt is stored as `unverified` and `verify/final.json` records
  that label. A local file/command witness remains detection-only.
- **Signer protocol v2.** With `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` set,
  `signerEnvelope` sends `{v:2, op:"sign-artifact", runId, …, approvalRef,
  message}` and derives `approvalRef` as
  `<DIR>/<runId>/<plain sha256(path)>.json`; `runId` is threaded through
  `signRunArtifact` → `signArtifact` (`SignOptions.runId`). The directory must
  be absolute, real, and not owned by this process. With the variable unset the
  exact v1 request is unchanged. A v1-only signer with the directory set, or a
  v2-only signer without it, fails `AUTH_SIGNER_UNAVAILABLE`; there is no HMAC
  fallback.
- **`opencode-teamwork approve signer`.** Produces a
  `kind:"teamwork.signer-approval"` artifact with
  `{v:1, runId, path, digest, nonce, approvedAt, expiresAt, approvedBy,
  approvalId, _auth}` signed over `teamwork-signer-approval-v1`. It uses the
  run nonce from the signed manifest, writes mode `0600` at the documented
  one-file-per-(run,path) layout, refuses an output inside the run/repo, and
  reuses no prompt-approval field. The plugin never reads the approval; the
  signer does.
- **Approval-key and signer-directory diagnostics.** `doctor --security` now
  fails `approval_key` when the approver private key is inline or a readable
  key file is visible to the workload UID. A new `signer_approval_dir` check
  fails a relative/missing/symlinked/in-repo/in-run/caller-owned directory.
  `scripts/hardening-check.sh` adds `signer_approval_dir` and
  `agent_signer_approval_read` read-only probes.

### Fixed

- `docs/SIGNER-PROTOCOL.md` and `docs/ADMIN-HARDENING.md` state the same
  `approvalRef` layout (`<DIR>/<runId>/<sha256(path)>.json`, plain SHA-256).
  `ADMIN-HARDENING.md` now says the signer is not in this repository and must be
  built; the plugin only speaks the protocol.

### Documentation

- Add [`docs/ADMIN-HARDENING.md`](docs/ADMIN-HARDENING.md): a Linux
  administrator runbook for a separate signer UID, a `0700` key directory, a
  root-owned signer, a systemd socket service, audit rules, SELinux labels and
  a read-only verification loop. Each step has a purpose, commands, a proof, a
  rollback and an honest limit. These are deployment instructions, not claims
  that the steps were executed on any host.
- Add [`docs/SIGNER-PROTOCOL.md`](docs/SIGNER-PROTOCOL.md): the v2
  policy-enforcing signer contract (`v: 2`, `runId`, `approvalRef`, the six
  mandatory checks, failure vocabulary and the plugin-side change).
- Add [`scripts/hardening-check.sh`](scripts/hardening-check.sh): a read-only
  POSIX `sh` verifier that prints `PASS`/`FAIL`/`UNKNOWN` per probe, exits
  non-zero on any `FAIL`, and documents every probe. `UNKNOWN` is not a pass.
- Add [ADR 0014](docs/adr/0014-verifiable-witness-and-signer-v2.md) and link the
  runbook/protocol from `SECURITY.md`, `docs/GUARDRAILS.md` and the README; add
  the new files to the packaging guard's required list.

## [0.13.1] - 2026-11-24

Patch release closing the defects found by the post-0.13.0 audit. No new
capability and no schema version bump; every new plan field is additive and
default-off.

### Fixed

- **Detective evidence.** The failure path never unlinks a destination after a
  containment refusal. A temp/rename failure records `detective-temp`
  (`phase`, `tempPath`, `destRealAfter`, `bytesWritten`, `intendedSha256`) and
  refuses with `postcheck` instead of a bare `ENOENT`. The pre-create
  containment refusal is recorded (`detective-containment` /
  `detective-precreate`), and the post-check re-hashes the destination bytes so
  a same-inode overwrite is an `identity` refusal.
- **Crash evidence.** A detective atomic write records a pre-rename intent and a
  post-check commit; a SIGKILL in between leaves an uncommitted intent that
  surfaces as `detective-temp`.
- **Fail-closed policy.** One `resolveRunPolicy` (realpath + `(dev, ino)` with a
  lexical fallback) hydrates `plan.dag.json` for every writer, so a case-varied
  run spelling on APFS/NTFS and an unlocked `tournament/candidates/*.json` write
  in a fresh process cannot fail open. The lock layer throws the writer's
  `containment-mode` error, including the run id. `doctor --security` reports
  `planRequirePinnedWrites` and fails when either the env or the plan asserts
  the policy.
- **Anomaly audit.** Write anomalies are appended to
  `<config-dir>/teamwork/write-anomalies.jsonl` (and policy/lock anomalies to
  stderr), never to `events.jsonl`. `teamwork_status` and `doctor --security`
  list unacknowledged anomalies; such a run reports `needs-inspection` and
  `teamwork_final_verify` refuses it. Acknowledgement is an explicit operator
  record.
- **Prune guard.** `opencode-teamwork prune` uses the same claim predicate as
  `worktree cleanup` and refuses `live`, `expired`, `needs-inspection` and
  `cross-host` claims (and an unreadable `state.json`). `--force` proceeds with
  a recorded warning and reason.
- **Claim history and host.** `claim.history` is merged into the task-level
  `claimHistory` before deletion and rehydrated by a later claim, so
  release/adopt/requeue/block keep the chain (5-entry bound). A flagged claim is
  `needs-inspection` even while its lease is live and gates every `task_update`
  transition. A protocol-2 claim or run with no `host` is cross-host (a
  protocol-1 run keeps the legacy shape).
- **Content guarantees.** `cites: []` is unbound under strict (an absent field
  remains the legacy shape). A new sticky plan flag `requireReportBinding: true`
  (default off) refuses an unbound PASS with `REPORT_UNBOUND`. Report digests
  use one shared 1 MiB cap across `final_verify`, the strict wave and the
  victory audit, so a PASS digest is never `null` by size. A check whose
  `exitCode` contradicts `passed` is refused as `CHECK_EXIT_CONFLICT`.

### Documentation

- `docs/ARTIFACTS.md`: the anomaly/quarantine record, the prune guard, claim
  history, cross-host fail-closed and report binding.
- `docs/GUARDRAILS.md`: the single-host shared-filesystem contract and the
  0.13.1 boundary.
- ADR 0013: amendment recording detective anomalies, the policy resolver and
  the no-rollback boundary.

## [0.13.0] - 2026-11-23

Detective-mode containment parity on macOS/Windows, an opt-in fail-closed
policy, a run-root identity recorded in the signed manifest, and platform CI
that actually runs the boundary suites. No schema version bump; new manifest and
plan fields are additive.

### Added

- **Ancestor identity pin (ADR 0013).** At detective `detectiveTarget` time the
  writer records `(dev, ino)` for the run root and every existing ancestor
  component (bounded to 32, never following a symlink), re-stats each before the
  create/rename/unlink and again in the post-check, and refuses a mismatch with
  a named `identity-changed` refusal plus a `detective-identity-changed`
  anomaly. A legitimately renamed run root fails closed. On darwin the run root
  is additionally opened and `fstat`'ed against the pinned identity before each
  mutation (identity confidence, not prevention).
- **`OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1` and plan
  `requirePinnedWrites`.** On a host whose traversal mode is not `pinned`,
  control-plane writes (manifest, state, costs, `verify/*`, handoffs, plan) are
  refused with a named `containment-mode` refusal. Default off; the plan
  assertion is sticky and is rehydrated on restart; the env assertion cannot be
  cleared by a caller.
- **Run-root identity in the signed manifest.** `run.manifest.json` records
  `runRootIdentity {dev, ino}` at plan time; `assertRunRootIdentity` re-checks
  it before control-plane writes and refuses a renamed/replaced root. Legacy
  manifests without the field are a no-op.
- **`detective_mode` diagnostic.** One diagnostic per run (not per write) names
  the non-pinned mode and the honest boundary.
- **Platform CI** (`.github/workflows/platform.yml`): macOS and Windows, Node
  24, running `test-safe-fs`, `test-safe-fs-write`, `test-approval` and
  `test-auth`. Platform-native cases: darwin case-insensitive run spelling,
  `/tmp` → `/private/tmp`, final-component append symlink, non-zero `dev`/`ino`;
  win32 junction refusal, `.. ` / `CON` / ADS segments, case-varied run path,
  non-zero `dev`/`ino`. Unsupported runner fixtures print an explicit
  `SKIP`/`RECORD` line.

### Changed

- `doctor --security` reports the containment mode and
  `OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES`; an asserted policy on a non-pinned
  host is a failure, so `--require-hardened` exits 2.
- The detective tests now run on macOS/Windows instead of being gated on Linux
  pinned mode.

### Tests

- New safe-fs-write cases for the identity pin (pre-create, pre-rename,
  renamed root, append post-check, darwin fd seam), the pinned-write policy
  (env, default off, per-run, pinned success, once-per-run diagnostic), and the
  signed-manifest root identity. New security cases for the doctor containment
  output and hardened exit code.
- Linux suites stay green; the packaging guard is unchanged.

### Residuals

- A transient swap that is reverted before the check is missed. A detected
  write already happened and is not rolled back. `(dev, ino)` can be reused.
  There is no pure-JS dir-relative write on macOS/Windows without a native
  addon. Same-UID ptrace remains outside the boundary. See ADR 0013.

## [0.12.0] - 2026-11-23

Minor release binding verdicts to the evidence they reviewed and making
in-run claims falsifiable by a privileged party. No schema version bump; new
fields are additive and legacy artifacts are read with explicit staleness.

### Added

- **Victory reviewed digests (A3).** `verify/victory.json` gains
  `evidenceDigests {reports, securityAudit, final}`, computed from disk by
  `teamwork_victory_audit`. `CONFIRMED` with an empty `reports` map is refused;
  the gate recomputes the set and returns `AUTH_STALE` on drift, including a
  legacy verdict with no digests. `next` surfaces the drift as `AUTH_STALE`.
- **Report → worker-handoff binding (A4).** `verify/report-<task>.json` gains
  `workerHandoff {taskId, agent, path, sha256}` from `handoffs/index.json`. With
  `requireHandoffs: "required"` a PASS report is refused as
  `REPORT_HANDOFF_MISSING`/`REPORT_HANDOFF_STALE`; `final_verify` and `next`
  re-check the binding.
- **Audit coverage (A5).** `verify/security-audit.json` gains `ruleChecks`
  (exactly one `clean|violation` per forbidden rule) and
  `reviewedDigests {reports, final}`. A missing rule, a recorded violation, or
  drift FAILs the gate; digest drift is `AUTH_STALE`.
- **Wave evidence citations (A6).** `teamwork_wave_record` accepts up to 16
  `verify/` paths and records `cites [{path, sha256, bytes}]`. A missing,
  edited, or resized cite is `STALE`; a pre-0.12.0 verdict warns
  `legacy_unbound_wave`.
- **Verifier → worker citation (A7).** A verifier handoff also cites
  `handoffs/<task>-<worker>.md`; changing the worker handoff stales the
  verifier handoff and `next` names why.
- **Contradiction detection (O6).** `INCONSISTENT_VICTORY_TASK`,
  `INCONSISTENT_REPORT_BRANCH`, `INCONSISTENT_AUDIT_HIGH`, and
  `INCONSISTENT_WAVE_REPORT` are named refusals in `final_verify`/`next`
  (`INCONSISTENT_EVIDENCE`); nothing is auto-fixed.
- **Bounded evidence artifacts (A9).** `teamwork_evidence` writes
  `verify/evidence/<name>` through the pinned writer (64 KiB/file, 32 files),
  returns `{path, sha256, bytes}`, and wave cites re-hash them.
- **ADR 0012** records the design and the honest boundary sentence: a same-UID
  writer can still author false content; the engine makes the false claim
  specific, signed, path-bound and digest-chained so a privileged verifier can
  falsify it.

### Changed

- `teamwork_report` refuses a PASS before the worker handoff exists on a
  required run; record the worker handoff before the report.
- `teamwork_security_audit` records coverage and the reviewed report digests.
- A `verify/final.json` written after an audit is not treated as reviewed
  evidence (timestamp guard), so audit → final remains a valid order.
- Run/briefing labels: an unbound/legacy victory renders as
  `CONFIRMED (…; stale or unbound evidence)`, never a plain `CONFIRMED`.

### Tests

- New engine coverage for victory digests, report/handoff binding, audit
  coverage and drift, wave cites (including legacy warnings), the verifier →
  worker chain, the four contradiction codes, and evidence artifacts. Existing
  engine/doctor/timeline/export/auth/approval/security suites stay green.

## [0.11.0] - 2026-11-23

Minor release closing the interview-gate gap: an authenticated approval now
binds the **prompt draft**, not only the manifest. It bumps the signed
`run.manifest.json` schema to version 3; versions 1 and 2 stay readable.

### Added

- **Prompt-bound approvals (manifest v3).** A version-3 manifest records
  `specHash` (unkeyed SHA-256 of the exact `prompt_draft.md` bytes),
  `specBytes`, `approvalDigest`, `approvalNonce`, `approvalBinding: "prompt"`,
  `approvedBy`, and `approvedAt`. The approval payload carries
  `binding: "prompt"`, `promptDraftSha256`, `promptDraftBytes`, `openGaps`,
  `approvalNonce`, and an optional `planHash`, and no longer carries a
  manifest digest (the manifest records the approval digest instead). Editing
  the draft or swapping the approval after the plan is `AUTH_STALE` /
  `AUTH_APPROVAL_STALE`.
- **Plan-time verification before any write.** `teamwork_plan` resolves the
  external approval directory, reads and hashes the draft through the bounded
  no-follow reader, verifies the Ed25519 approval (distinct key, pinned
  `approvalKeyId`, identity, freshness), requires the exact draft bytes, and
  refuses remaining `[OPEN:` gaps — all before `mkdir`/state/preflight writes.
  Failure codes: `AUTH_APPROVAL_INCOMPLETE`, `AUTH_APPROVAL_STALE`,
  `AUTH_APPROVAL_MISSING`, `AUTH_APPROVAL_UNTRUSTED`,
  `AUTH_APPROVAL_NOT_HUMAN`, `AUTH_APPROVAL_REPLAY`.
- **One-use nonce.** `approvalNonce` must be ≥128 bits and equal
  `_auth.nonce`. The plugin consumes it once per run under the plan lock and
  stores `{approvalNonce, approvalDigest, planHash, at}` at
  `ctx.storage` `auth/approval/<runId>/consumed`; a later different nonce is
  `AUTH_APPROVAL_REPLAY`.
- **`opencode-teamwork approve`.** `request` prints the draft digest, byte
  count, `[OPEN:` count, observed manifest/plan digest, and the exact payload
  to sign (writes nothing trusted). `sign` re-hashes the raw bytes, refuses a
  changed draft or remaining gaps (unless `--allow-open` records them), asks
  for the first 8 hex characters and the word `approve`, and writes the
  Ed25519 approval atomically `0600` into the approval directory. `verify`
  re-runs the binding checks and prints them without claiming a human read it.
- **Signer scope.** The plugin signer and the command signer refuse any
  `approvals/` path with `AUTH_APPROVAL_SCOPE`; approvals use the approver key
  directly.
- **Doctor.** `doctor --security` reports the approver key configuration and
  whether a configured signer could accept an `approvals/` path.
- **Parity harness.** `scripts/test-approval.mjs` drives print mode (one child
  process per turn, disk-only state), the TUI single-process path, the full
  approved flow to `final_verify` PASS, and the negative matrix (missing,
  edited, another run, HMAC, run-key, expired, replayed nonce, open gaps, bare
  approver, in-run approval, wrong plan hash, `approvals/` signer scope).
- **ADR 0011** records the design, its boundary sentence, and the residuals.

### Changed

- `_auth` canonical format and digest helpers now live in
  `plugins/opencode-teamwork/approval-format.mjs`, shared by the plugin and the
  approval CLI so an envelope produced outside the plugin verifies identically.
- `safe-fs` bounded reads return the exact `bytes` alongside the decoded
  `text`; `contentSha256Hex` is used for prompt content digests.
- Version-2 approvals keep their manifestDigest-bound semantics and
  `approvedAt >= createdAt` rule; version-1 in-run approvals remain readable
  and are still recorded as `approval_unbound`.
- `local-hmac`, `external-signer`, `allowUnsignedLegacy`, and `ci-attested`
  behaviour is otherwise unchanged.

### Tests

- New `test:approval` in the npm chain. Existing engine/doctor/timeline/
  export/auth/security suites stay green.

## [0.10.2] - 2026-11-23

Patch release closing two cheap content-integrity loopholes and making the
declared trust levels honest. It bumps the signed `run.manifest.json` schema to
version 2; version 1 manifests stay readable.

### Changed

- **`human-approved` / `ci-attested` require a different principal.**
  Approvals are read from `OPENCODE_TEAMWORK_APPROVAL_DIR` (absolute, outside
  the run and repo, real directory owned by another UID). The approval envelope
  must be Ed25519 and its `_auth.keyId` must differ from the manifest's
  `runKeyId`; HMAC or run-key approvals fail `AUTH_APPROVAL_NOT_HUMAN`.
  `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` (+ `_KEY_ID`) configures the
  verify-only approver key, which is pinned as `approvalKeyId` in the signed
  manifest together with `approvalPolicy` and covered by drift checks.
- **Freshness, identity and plan ordering.** An approval needs
  `approvedAt >= manifest.createdAt` and a bounded `expiresAt` (default 24 h;
  `OPENCODE_TEAMWORK_APPROVAL_TTL_MS`, max 7 d) or fails
  `AUTH_APPROVAL_STALE`. `approvedBy`/`attestedBy` must be `uid:<name>`,
  `oidc:<issuer>#<sub>`, or `ci:<workflow>`; bare `team/...`/`ses_...` labels
  are refused. Missing approval prerequisites now refuse the plan **before**
  any run directory or state write. Pre-0.10.2 (version 1) runs keep the in-run
  `approvals/<run>.json` path, recorded with an `approval_unbound` event.
- **`doctor --security --require-hardened`.** Security checks can report
  `fail`, and `report.ok` is false when any check fails. Knowable facts fail
  instead of warning: `ptrace_scope=0`, root-equivalent group membership, a
  caller-owned/writable signer path, a caller-owned/writable or in-repo approval
  directory, and DB/`-wal`/`-shm` group/other bits. A new `containment` check
  reports `fdTraversalMode()`/`supportsFdContainment()`, and fails when an
  approval/witness trust level is asserted on a non-pinned host.
  `--require-hardened` exits 2 on any `fail` or `unknown`; plain
  `doctor --security` stays advisory.

### Fixed

- **Signed runs refuse the inline `verified_pass` shortcut.** `task_update` to
  `verified_pass` now requires a verified `verify/report-<taskId>.json` with
  `status: "PASS"` and a valid `_auth`. The inline `verification.status`
  shortcut survives only on explicit `allowUnsignedLegacy` runs, where it is
  recorded as a `verification_inline_legacy` event and
  `verificationSource: "inline-legacy"`.
- **PASS evidence is recomputed.** The report writer keeps
  `checks[].output`/`checks[].error`, adds `checks[].exitCode` and an
  engine-computed `checks[].outputSha256`, and refuses a PASS with any
  `checks[].passed !== true`, non-empty `fatalFindings`, or no summary/check.
  `final_verify` re-checks the same invariants (including the output hash) so a
  hand-forged, validly signed file cannot bypass them.
- **Briefing honesty.** `BRIEFING.md` no longer renders an unsigned/unverified
  `verify/victory.json` as plain `CONFIRMED`; it says
  `CONFIRMED (unverified envelope)` (or notes that an envelope is present but
  the briefing does not verify it).

### Tests

- Approvals: run-key/HMAC approvals fail `AUTH_APPROVAL_NOT_HUMAN`; a distinct
  Ed25519 approver accepted; in-run approvals ignored for version 2; missing
  approval dir refuses the plan with no run directory; version 1 in-run approval
  still readable and emits `approval_unbound`; expired and pre-manifest
  approvals fail `AUTH_APPROVAL_STALE`; `team/sentinel` refused, `uid:john`
  accepted.
- Doctor: `fail` propagates to exit 2 under `--require-hardened`; caller-owned
  signer and approval dirs fail; non-Linux/unknown refuses; an all-pass fixture
  exits 0; plain `--security` stays exit 0.
- Content integrity: signed-run inline PASS refused; legacy inline PASS recorded;
  inconsistent PASS refused at write and at `final_verify`; `outputSha256`
  mismatch refused; a consistent PASS still passes.
- Briefing renders an unsigned victory as unverified. Existing engine/cost/
  safe-fs/export/auth/security suites stay green.

## [0.10.1] - 2026-11-23

Patch release for defects shipped in 0.10.0. No protocol bump: state written by
0.10.0 is read as-is, with no migration write.

### Fixed

- **macOS/Windows are no longer wholly broken.** `withPinnedCrossProcessLock`
  had no `detective` branch and threw whenever `pinParent` was unavailable. It
  now uses the path-based lock with a stable in-process key, verifies the lock
  parent's realpath under the run realpath before acquisition and after release,
  records a `detective-lock` anomaly/diagnostic, and still fails closed when the
  check fails or the host is `fail-closed`. `appendLineDetective` opens with
  `O_NOFOLLOW` where defined and otherwise refuses a final-component symlink
  immediately before the open, then compares the post-write `(dev, ino)` with the
  opened descriptor (`detective-append` anomaly). `createDirWithin`/
  `unlinkWithin` add parent/target realpath post-checks; a delete never creates
  parent directories. This closes the deterministic `pitfalls.md -> ~/.bashrc`
  append escape. Full platform parity remains scheduled for 0.13.
- **Identity and lexical hardening.** `sameIdentity` refuses `dev === 0 ||
  ino === 0` as a named `identity-unavailable` refusal instead of claiming
  detection; `detectiveTarget` applies the `rel.startsWith("..")` policy and
  refuses a symlinked run root; Windows segment validation refuses trailing
  dots/spaces, reserved device names, `:`, and non-round-trip names (test seam
  covers it on every platform; Linux behaviour is unchanged).
- **Lock release is a nonce-checked quarantine.** `releaseLock` renames to
  `<lock>.release.<nonce>`, reads the moved artifact, removes only our nonce, and
  restores a foreign artifact with `link(2)` + `unlink(2)`. A lock published
  immediately after release survives. The `mkdir` fallback publishes
  `owner.json` via temp + rename; an owner-write failure removes the directory
  and fails closed instead of returning `"created"`.
- **Claim correctness.** A `needs-inspection` claim is never auto-reclaimed, even
  with an unchanged fingerprint, and `task_update` to `worker_active` returns
  `CLAIM_NEEDS_INSPECTION`. `claim.host` is the claiming process and
  `claim.runHost` the run host; cross-host checks compare `claim.host`.
  `worktree cleanup` blocks on `live`, `expired` (grace), `needs-inspection` and
  `cross-host` through `deriveClaimState`; `next`/`task_update`/`recover` use the
  same predicate. Inspection tokens bind `(round, fence, claim.by)` and `recover`
  accepts a `fence` (`INSPECTION_STALE`). The fence increments only when the
  owner/epoch changes, so `next`'s fence is valid for the immediate update.
  Release/adopt/requeue/block preserve a bounded task-level `claimHistory`, and a
  terminal `task_update` emits `claim_released`.
- **Shorter critical section, documented recovery latency.** Full side-effect
  baselines (including the bounded untracked scan) and verifier-report
  base/head/diff evidence are captured before the `state.json` lock; inside it
  only `HEAD`, `status --porcelain` and the tracked-diff hash are re-read. The
  default lock timeout is 30 s, equal to (never above) the 30 s lease:
  worst-case recovery latency is one lease plus one timeout.

### Tests

- Detective/lock: detective-mode lock acquire/run/release plus anomaly;
  `fail-closed` still throws; detective append static-symlink and post-write
  identity refusal; `fdContainment` override for the non-Linux branch;
  `createDir`/`unlink` post-check refusals; `dev`/`ino` 0 refusal; the Windows
  lexical table; release-TOCTOU survival; mkdir owner-write failure.
- Claim engine: `needs-inspection` is not reclaimed on an unchanged fingerprint;
  grace blocks cleanup; a token from fence N is refused at N+1; `next`'s fence is
  accepted by the immediate `task_update`; `claim.host` is the process host; a
  simulated foreign claim is cross-host and not reclaimed.

## [0.10.0] - 2026-11-23

### Added

- **Linux pinned-fd write containment (0.11.0, ADR 0010).** Run-artifact writes
  are now preventive on Linux when `/proc/self/fd` is usable. A parent directory
  descriptor is opened with `O_DIRECTORY|O_NOFOLLOW`, checked for an exact fd
  realpath match, and every create, mkdir, rename, write, lstat, unlink and lock
  publication is expressed as `/proc/self/fd/<dirfd>/<one-validated-segment>`.
  Each atomic write uses a fresh random `O_EXCL` temp, write loop + `fstat` +
  `fsync`, a rename under the pin, and a post-rename `(dev, ino)` identity check.
  `ORIGINAL_REQUEST.md` uses `O_CREAT|O_EXCL`; `events.jsonl`/`pitfalls.md`
  appends refuse an inode with `nlink !== 1`, and the event `seq` is computed from
  the same append descriptor (`nextEventSeqFromFd`). The cross-process lock file
  is created inside the pinned directory (`withPinnedCrossProcessLock`) with a
  stable in-process key, and known run subdirectories are pre-created at plan
  time. Linux without usable procfs **fails closed** for writes. macOS/Windows
  keep the path-based atomic write plus a detective post-write check only; a
  transient swap that is reverted can be missed. New
  `scripts/test-safe-fs-write.mjs` covers nested pins, root renames, a 2,000
  write swapper race, an append race, hard-link refusal, two-process append
  sequencing, write-once concurrency, pre-planted temp links, and the detective
  audit event. Residuals: run-root `mkdir` is still path-based, hard-link
  semantics are best-effort on network filesystems, a renamed pinned directory
  loses its old name, same-UID ptrace is unaffected, and writes inside the run
  remain attacker-influenceable.
- **Claim protocol 2: fencing, side-effect baselines and explicit recovery
  (0.10.0, ADR 0009).** New runs record `claimProtocol: 2`,
  `claimLeaseMs` (default 300000, bounded 60 s–60 m), `host` and lock-storage
  diagnostics. A task gains a monotonic `fence` (claim/reclaim/release/
  override/round change), `claim.{host,epoch,heartbeatAt,baseline,history}`,
  `inspection` and `checkpoint`. `teamwork_next` returns the fence, never
  reclaims a stale claim whose git/artifact fingerprint changed or is unknown
  (it becomes `needs-inspection`), and never auto-reclaims a cross-host claim.
  `teamwork_task_update` accepts an optional `fence` and enforces
  `STALE_FENCE`, `CLAIM_OWNED_BY_OTHER` and `CLAIM_EXPIRED` on **every**
  transition; a Sentinel override of another session's claim needs a recorded
  `reason`. Ownership is the claiming session or a session descended from it,
  and the owner/descendant auto-renews on `next`/`task_update`/worktree
  `setup`/`diff`/`handoff`/`report` (bounded at 60 min or 20 renewals).
  `teamwork_recover` adds `heartbeat`/`inspect`/`release`/`block`/`requeue`/
  `adopt`/`discard`; `inspect` issues a single-use, hashed 10-minute token,
  `adopt`/`requeue`/`block` re-check the fingerprint (`INSPECTION_STALE`), and
  `adopt` marks a clean committed branch `worker_done` with a checkpoint while
  making **no commit**. `teamwork_report` binds `round`/`fence`/`branch`/
  `baseSha`/`headSha`/`diffHash`; `verified_pass` refuses an old-round or moved
  report (`REPORT_ROUND_STALE`/`BRANCH_MOVED`), and `worktree merge` refuses
  `BRANCH_MOVED`. Legacy reports are accepted with a `legacy_unbound_report`
  warning. `worktree setup` records the baseline and renews the claim, `diff`
  returns `HEAD`/`baseSha`/`diffHash`, and `cleanup` refuses a live claim.
  Cross-host worktree actions refuse unless `allowSharedWorktrees: true` (never
  with `requireSameHost: true`), and a foreign-host claim release needs
  `allowCrossHost`/`TEAMWORK_ALLOW_CROSS_HOST=1` plus `confirm`.
- **Atomic lock publication and quarantine reclaim.** `<artifact>.lock` is now
  published as a unique `wx` temp + `link(2)` (atomic `mkdir` fallback detected
  once and cached), aged from `lstat().mtimeMs` rather than the owner's `at`,
  and reclaimed by a single-winner quarantine `rename(2)`. Empty/partial locks
  age out instead of stranding the artifact; a replaced live lock is never
  unlinked by nonce.
- **Pinned-fd write containment on Linux (0.11.0, ADR 0010).** Run writes now
  pin the run root and each path segment with `O_DIRECTORY|O_NOFOLLOW`, then
  create, rename, append, and unlink through `/proc/self/fd/<dirfd>/<name>`, so
  an intermediate-directory swap cannot redirect a write outside the run.
  `writeFileAtomicWithin`, `writeOnceWithin`, `appendLineWithin`, and
  `touchWithin` replace the path-based writers in `tournament.ts`, `tools.ts`,
  `lemma.ts`, and the run locks; appends refuse a hardlinked target
  (`nlink === 1`); known run subdirectories are pre-created at plan time.
  Non-Linux and unusable-procfs hosts fall back to a post-write
  `realpath`/`(dev,ino)` check that refuses and audits a detected redirect, and
  Linux without procfs fails closed. A deterministic race harness with a
  leaking negative control covers the class. macOS/Windows remain
  detective-only; no native addon is used.

## [0.9.0] - 2026-11-23

### Added

- **Ed25519 artifact envelopes and a signer SPI (ADR 0008).** `_auth` now
  supports `alg: "ed25519"` alongside `hmac-sha256`; an Ed25519 envelope
  (`{v, alg, keyId, path, digest, sig, nonce, at}`) signs
  `teamwork-artifact-v1\0alg\0keyId\0path\0nonce\0canonicalJson(payload)` and
  verifies with the SPKI public key alone, so a verifier never needs the secret.
  Key-ring entries accept PKCS#8 and/or SPKI material, with
  `OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY` / `_PUBLIC_KEY` overrides, and HMAC
  envelopes remain the default and stay verifiable.
- **Per-run nonce and key-id pinning.** Each new signed run generates a 128-bit
  `runNonce`, pinned with `runKeyId` in the signed `run.manifest.json` and in
  storage, bound into every `_auth` and checked at verification. Cross-run
  copies fail on nonce, path, and index; a rotated key that re-signs fails the
  key-id equality.
- **External signer adapter.** `OPENCODE_TEAMWORK_SIGNER=command:<absolute path>`
  spawns the signer with fixed argv (no shell), sends a JSON request on stdin,
  and accepts a JSON `{alg,keyId,sig,receipt?}` response only after verifying it
  against the configured public key, with a timeout. Unavailable, malformed,
  timed-out, or non-verifying signers fail closed as
  `AUTH_SIGNER_UNAVAILABLE`; there is no silent HMAC fallback.
- **Trust levels.** `teamwork_plan` accepts
  `trustLevel: "local-hmac" | "external-signer" | "human-approved" |
  "ci-attested"` (default `local-hmac`), persisted and re-plan locked.
  `final_verify` refuses HMAC envelopes under `external-signer` and requires a
  run-bound signed `approvals/<run>.json` for the approval levels.
- **Optional witness receipts.** `OPENCODE_TEAMWORK_WITNESS=command:<path>` or
  `http(s)://<url>` records `{runId, path, digest, keyId, nonce, at}` and returns
  a receipt; `requireWitness` makes a missing receipt
  `AUTH_WITNESS_UNAVAILABLE`. A local-file witness is detection-only.
- **`doctor --security`.** Reports key source/alg, signer/witness config,
  `ptrace_scope`, root-equivalent groups (`docker`/`wheel`/`libvirt`), database
  mode, plugin/config writability, and SELinux, in text and
  `doctor --json.security`.
- **`SECURITY.md`, ADR 0008, and a security-claim lint.** The lint fails
  "tamper-proof", "trusted signature", "safe against a local user", and "signed
  by a trusted authority" in README/SECURITY/docs and runs in the test chain.
- **Signed handoff index entries (ADR 0007).**
  `teamwork_handoff` now signs the `handoffs/index.json` entry, never the
  markdown: `_auth` covers `{kind:"teamwork.handoff", v:1, runId, runKeyId,
  taskId, agent, agentSessionId, round, path, sha256, bytes, generatedAt,
  cites}` and a digest-index record lives at
  `auth/run/<runId>/handoffs/<taskId|_run>-<role>.md`. `run.manifest.json` gains
  optional `handoffAuth: "signed" | "legacy"`; new signed plans write `signed`,
  `allowUnsignedLegacy` plans write `legacy`, absent (0.8.0) is legacy, and a
  re-plan refuses a signed→legacy downgrade. `final_verify`/`next` use
  `evaluateHandoffGateChecked`: the structural gate is unchanged, then every
  present entry's `_auth` and `runKeyId` are verified. Unsigned required entries
  on a signed run are `[AUTH_MISSING]`; legacy unsigned entries are tolerated but
  present-and-invalid envelopes are rejected. Auth failures map to `INVALID` /
  `BLOCKED_BY_HANDOFFS`, `evidence.handoffs` records `auth` + `keyId`, and strict
  `GATE_STATUS.md` shows an `Auth` column. Handoff prose is still never parsed,
  and a signed handoff still cannot flip a failing verdict.

### Changed

- A same-UID writer can still mint a valid envelope by reading the local key;
  `doctor --security` now surfaces the postures (root-equivalent groups,
  `ptrace_scope=0`) that make that practical. Public-key verification changes
  what a *verifier* needs, not what a local shell can do; ADR 0008 and
  `SECURITY.md` state the single-UID vs hardened-profile boundary.

## [0.8.0] - 2026-11-22

### Added

- **Safe-FS read containment (ADR 0004).** A shared `safe-fs.mjs` primitive checks the opened descriptor's `/proc/self/fd` real path before any byte is read (Linux; fail-closed on unusable procfs), and every run-file reader now routes through a run-root-aware reader: `readRunText`, `readJson`, `readSnapshots`, the spec gate, LEMMA reads, handoffs/briefings, and the `lib`/`bin` CLI readers. Dangling-symlink roots are refused, `O_NONBLOCK`/`EINTR` cover FIFOs, and a deterministic race harness (with a leaking negative control) guards the class. macOS/Windows keep the previous checks and the documented residual.
- **Canonical handoffs and per-agent briefings.** `teamwork_handoff` writes the five-section handoff to `<run>/handoffs/<task|_run>-<agent>.md` with a bounded sha256 index and artifact citations; a read-only falsifier can write through the tool. Per-agent `<run>/agents/<slug>-<sha256(session)[:32]>/BRIEFING.md` is written lazily by the context hook, with a shared fallback and a 64-directory cap. `describeRun` resolves the calling session's run via `run-by-root/<rootSessionId>` with a newest-run fallback.
- **Cross-process locks, task claims, and idempotent cost.** `<target>.lock` uses `O_CREAT|O_EXCL`, owner metadata, bounded backoff, same-host stale reclaim, and nonce-checked release. `teamwork_next` atomically claims ready tasks with a 15-minute lease; `task_update` to `worker_active` requires a live claim (recorded sentinel override). `costs.json` stores an applied snapshot digest/cursors, so a crash between costs and snapshots cannot double-count.
- **Victory-skip reasons and export run terms.** An explicit `victoryAudit: "skip"` now requires a sanitized, bounded `victorySkipReason`, persisted in the signed baseline and re-plan locked; benchmark refuses skip. Export shows victory, handoff-gate, and artifact-auth labels (envelope presence only), and marks a reported PASS with required-but-unmet handoffs as **ENGINE WOULD REJECT**.
- **Isolation assessment (ADR 0006).** The Phase A boundary is documented precisely: a run-dir-only writer cannot forge a verdict, but a same-UID shell with `opencode.db` access can read the HMAC key; a same-UID signer, OS keychain, or auto-approvable `ctx.permission.assert` is a signing oracle, not a boundary. Real isolation requires a different privilege domain and a non-oracle signing decision (admin-only options assessed).
- **Completed SWE Light runtime evidence.** A second SWE Light run completed with `VICTORY CONFIRMED` (implementer → reviewer 0 issues/0 edits → 3-phase victory audit, 26m33s, 3/32 spawns), plus the artifact-sandbox and two-root-layout observations; the corpus now records both completed SWE Light runs.
- **Control-plane tool authorization.** `plugins/opencode-teamwork/authorize.ts` applies one trusted-session role map (plus root/descendant ancestry for run-bound tools) across `teamwork_plan`, `task_update`, `security_audit`, `final_verify`, worktree, document-review, LEMMA, and tournament tools. Caller-supplied `agent` labels are recorded, never authoritative; unresolved identity fails closed for mutating tools. Read-only `status`/`resume`/`cost` stay available to installed `team/*` roles.
- **URL SSRF guard.** `plugins/opencode-teamwork/url-guard.ts` validates and pins outbound document/preflight URLs: http/https only, public addresses only (loopback, private, link-local/metadata, multicast/reserved, and mapped IPv6 rejected), no automatic redirects, 3 s timeout, and size caps. `OPENCODE_TEAMWORK_ALLOW_LOCALHOST=1` is the explicit loopback-only test opt-in.
- Release-tag provenance guard: `scripts/check-release-tag.mjs` fetches tags and
  refuses to publish a `v*` tag whose commit is not an ancestor of `origin/main`;
  `publish.yml` runs it before publish with full history/tags, only on tag pushes.
- **Artifact authenticity (Phase A, ADR 0005).** `teamwork_plan` writes a signed `run.manifest.json` baseline (modes + request/requirements/plan/LEMMA-policy hashes). Verifier reports, security audit, strict-wave verdicts, victory verdict, and final verdict carry canonical-JSON HMAC-SHA256 `_auth` envelopes and a digest index in `ctx.storage` (`auth/run/<runId>/<relPath>`, key ring at `auth/key/ring`). `teamwork_report` is the trusted signed writer for `verify/report-<taskId>.json`. `teamwork_victory_audit`, `teamwork_wave_record`, and `teamwork_report` require the caller session to descend from the plan-time `rootSessionId`.
- **Continuity gating (Sprint 2.4b).** `teamwork_plan` accepts `requireHandoffs: "required" | "skip"` (default `required` for a new run with a request/requirements baseline; `skip` for legacy/unsigned runs) and pins it in `plan.dag.json`, `state.json`, and the signed `run.manifest.json`. When required, `teamwork_final_verify` and `teamwork_next` derive the matrix from plan/state — assigned worker + `team/verifier` per task, `team/falsifier` + `team/security-auditor` per task in strict mode, one `team/sentinel`/`team/orchestrator` run-level handoff, and the `team/victory-auditor` run-level handoff after a confirmed audit — and require exactly one index entry per pair with a matching regular-file sha256 and current citation hash. Missing pairs return `NEEDS_HANDOFFS`; stale/duplicate/unknown/tampered entries return `BLOCKED_BY_HANDOFFS`; `final.json` records `handoffs` + `evidence.handoffs`, and strict `GATE_STATUS.md` cites them under `## Continuity`. An explicit `skip` records `handoffs: "SKIPPED (explicit)"` and never reads the index; benchmark mode refuses it. Handoffs remain continuity evidence, never a second verdict authority.
- `OPENCODE_TEAMWORK_HMAC_KEY` (base64url 32 bytes) and `OPENCODE_TEAMWORK_HMAC_KEY_ID` for CI/offline runs.

### Changed

- `teamwork_worktree` merge/resolve now require a verified sentinel worktree
  (present, real directory, contained, and a git worktree root). A missing or
  symlinked sentinel path is refused; the tool never falls back to the user's
  repository root.
- Network denial (`constraints.network: denied`) now applies to `webfetch` for
  every `team/*` agent, not only worker/verifier, and is resolved from per-task
  `spec.json` as well as `prompt_draft.md`. `shell` network access remains
  honor-system.
- `teamwork_final_verify`/`teamwork_next` verify signatures and the signed baseline: a forged/copied/edited artifact fails as `AUTH_MISSING`, `AUTH_INVALID`, `AUTH_UNKNOWN_KEY`, `AUTH_INDEX_MISSING`, or `AUTH_STALE`, and a `strict→standard`/`required→skip`/integrity-mode downgrade is refused. Unsigned legacy runs return `AUTH_LEGACY` until an explicit, recorded `allowUnsignedLegacy` bypass; `benchmark` refuses that bypass and `victoryAudit: "skip"`.
- Standalone CLI readers label authenticity as `signed`/`unsigned`/`unknown` by envelope presence only; they cannot verify and do not claim to.

### Fixed

- Intermediate-component symlink reads are refused before any bytes are returned on Linux; the write path (`mkdir`/`rename`) remains a documented residual.
- `teamwork_next` no longer hands the same ready task to two coordinators: live claims are skipped and expired leases are reclaimed with the previous claimant recorded.
- Concurrent `state.json`/`costs.json` updates no longer lose writes; cost replay is idempotent across a crash between costs and snapshots.
- A strict wave verdict is write-once for a given verifier report; a reworked report makes the old verdict stale and only a new-report record can pass.
- Required handoffs are validated against current citations; missing/stale/duplicate entries cannot complete a run.

### Security

- Signed plan baseline and verdicts, the trusted `teamwork_report` writer, and session-tree binding make run-dir forgery and mode downgrades tamper-evident.
- Control-plane tools are role-scoped; outbound document/preflight URLs are DNS-pinned and reject private/link-local/metadata targets and redirects.
- `constraints.network: denied` covers `webfetch` for every team agent; merge/resolve never falls back to the user's repo root.
- New release tags must be ancestors of `origin/main`; published tags are never rewritten.
- Known boundary: HMAC is tamper-evident against a run-dir-only writer, not a same-UID shell that can read `opencode.db`; ADR 0006 assesses the admin-only isolation options.

### Notes

- `v0.6.0` and `v0.7.0` are sibling release commits with trees identical to
  their `main` release commits. They predate the tag guard; every future `v*`
  tag is ancestor-checked and published tags are never rewritten.

## [0.7.0] - 2026-11-22

### Added

- **Victory acceptance audit.** `teamwork_plan` accepts a requirements baseline and persists `requirements.json`; `teamwork_victory_audit` records an independent `team/victory-auditor` verdict in `verify/victory.json`, bound to the current `ORIGINAL_REQUEST.md` hash and every requirement. `teamwork_final_verify` and `teamwork_next` refuse completion without `VICTORY CONFIRMED` unless the plan explicitly recorded `victoryAudit: "skip"`.
- **Opt-in strict verification wave.** `verification: "strict"` requires, per task, the verifier report PASS plus a `team/falsifier` challenge PASS and a `team/security-auditor` audit CLEAN (`teamwork_wave_record`), writes a human-readable `GATE_STATUS.md`, and reports `NEEDS_STRICT_WAVE` until both verdicts exist. Standard mode is unchanged.
- **Persistent run briefing.** `<run>/BRIEFING.md` carries Mission, Identity, Key Constraints, Project Status, Artifact Index and Succession; it is refreshed at lifecycle transitions and a bounded excerpt is injected into `session.context` so compaction preserves the mission.
- **Five-section handoff protocol.** Worker, verifier, falsifier, security-auditor and victory-auditor prompts and `docs/ARTIFACTS.md` now require Observation, Logic Chain, Caveats, Conclusion and Verification Method.
- **Live reference evidence.** The corpus gains `12-live-general-run.md`, `13-live-swe-light-run.md`, redacted evidence bundles, a revised gate/artifacts analysis and gap-analysis revision 5.

### Changed

- Completion now enforces an independent fidelity verdict in addition to evidence-derived tests; legacy runs without a request/requirements baseline record an explicit skip.
- Packaging guards assert the shipped `victory.ts`, `strict.ts` and `briefing.ts` modules.
- The README, roster and guardrails describe the new victory-auditor role and the strict mode; no runtime dependencies were added.

### Fixed

- A reworked and re-verified task now makes its old challenge/audit verdicts stale: wave verdicts store the verifier report hash and only a new-report re-record can satisfy the strict gate.
- `GATE_STATUS.md` cell escaping neutralizes backslash/pipe table injection.

## [0.6.0] - 2026-11-22

### Added

- Document Review route (`#1`): bounded segment triage and a review/synthesis tree, `teamwork_document_triage` and `teamwork_document_record`, `team/segment-reviewer`, and the `document-review` topology. It triggers only for a supplied document whose deliverable is a critique, ahead of Math/Proof.
- LEMMA Lean 4 formal-proof route (`#2`): a pre-spend capability gate, a bounded lemma tree, `team/formalization-reviewer`, kernel/sorry/axiom verification, declaration-to-statement binding, transitive `#print axioms` checks, and a plan-time axiom policy.
- Bounded massive-proof tournament (`#3`): explicit opt-in only, budget preflight with the 80% dispatch halt cap, the `teamwork_tournament` state machine, ranked candidates, referee verdict gating, and cancellation/partial reports.
- ADRs 0001–0003 (`#5`, `#6`, `#4`): reject a shared mutable swarm board, retain the single artifact root pending per-conversation storage, and record successor handoff as not possible on this host. ADR 0004 proposes a post-open containment check for intermediate symlink races.
- Roster expansion (`#7`): 14 agents, including the segment reviewer, formalization reviewer and referee, each consumed by a route, with explicit deny sets and a documented roster table.
- `lemma-e2e` CI job: live Lean 4 + LEAP CLI verification on a core-only toolchain (no Mathlib), which fails if the live E2E is skipped.

### Changed

- Security hardening across the engine, `lib/` and `bin/`: atomic `O_CREAT|O_EXCL` writes, `O_NOFOLLOW|O_NONBLOCK` reads with `fstat` as the authority, symlink/FIFO refusals, and session-id allowlisting before localhost API calls.
- LEMMA install contract now names the real LEAP CLI (`pipx install git+https://github.com/billkunghappy/LEAP-CLI@…`) instead of the non-existent `leap-tools` PyPI package; `leap` or legacy `leap-tools` satisfies the gate.
- The axiom allowlist is now approved at plan time, validated and persisted in `lemma/manifest.json`; callers can no longer widen it at verification time. Legacy runs fail closed to the standard axioms.

### Fixed

- `ORIGINAL_REQUEST.md` is created write-once with `O_EXCL`, removing a check-then-use race.
- `teamwork_next` revalidates tournament evidence before accepting a stamped PASS, and cancellation retries repair the run checkpoint.
- Committed tournament budgets persist, missing `costs.json` blocks work instead of skipping enforcement, and referee authorization follows the trusted session identity.
- `events.jsonl` sequence counting uses one descriptor, and a non-regular file can no longer block or redirect a read.

### Security

- CodeQL: no open alerts on `main`. Four vendored `docs/re/**` alerts are dismissed as test/documentation evidence, and four `js/file-access-to-http` findings are dismissed as accepted risk (session identifiers sent only to the authenticated localhost service).

## [0.5.9] - 2026-11-22

### Added

- `teamwork_security_audit` accepts `integrityFindings` (`{rule, where?, why?}`, max 50) and enforces a fixed rule table with per-rule thresholds: `fabricated_output` is forbidden from `development`; `core_logic_copied`, `delegated_core_work` and `test_source_read` from `demo`; `external_dependency_used` from `benchmark`. A finding forbidden at the run's mode becomes an `integrityViolation` and forces `status: "FAIL"` independently of Critical/High findings. Unknown rule ids are refused before anything is written. `verify/security-audit.json` persists `integrityMode`, `integrityFindings` and `integrityViolations` (each with its `forbiddenFrom` threshold); `teamwork_final_verify` inherits the FAIL, and `teamwork_next` reports `BLOCKED_BY_SECURITY`.
- Input pre-flight gate. A shared inventory helper extracts explicit `inputs`, URLs, blocking absolute/`~`/`file:` paths and advisory relative path-like tokens from the routed request (deduplicated, capped at 100). `teamwork_plan` gains `inputs`, `checkUrls` and `allowMissingInputs`; `MISSING`/`OUTAGE` refuse the plan before anything is written. A bypass persists `plan.dag.json.preflight: {status, bypassed: true}` plus a `run_created` note; `READY` records `{status: "READY", bypassed: false}`, and a run with no inventory records `{status: "SKIPPED"}`.
- `teamwork_preflight` re-runs the input check for an existing run and writes `<run>/preflight.json` (`checkedAt`, `integrityMode`, `items`, `summary`), appending a `preflight` event. URLs are `UNCHECKED` by default; `checkUrls: true` issues one 3 s HEAD request per URL and yields `READY` or `OUTAGE`.
- `events.jsonl` gains the `preflight` event kind.
- Export reports (HTML and Markdown) gain a "Run terms" block showing the integrity mode, the pre-flight status with an explicit `(bypassed)` marker, and final-verdict provenance (`stamped by <agent/session>`, `UNSTAMPED (legacy)`, or `not produced`); all values are escaped, and legacy runs degrade to `not recorded`.
- `opencode-teamwork doctor --json` gains an additive `nextSteps` array naming one command for the first non-passing check; existing `ok` and `checks` fields are unchanged.

### Changed

- Planning can now be refused for missing blocking inputs, and the refusal writes no run directory. The `allowMissingInputs` bypass is explicit and recorded.
- Integrity violations force the security audit to FAIL, which blocks merge and final verification.
- `opencode-teamwork doctor` prints an actionable `Next steps:` line pointing at the first non-passing check; the seven-check contract is unchanged.
- The model picker ends with an `agent → model` summary and warns, keeping the previous value, when typed input is neither a detected model nor `provider/model`; the banner count is derived from the shipped team instead of hardcoded.
- `opencode-teamwork init` prints the two next commands: `opencode-teamwork models`, then `/teamwork-craft`.
- The README adds a five-minute first-run walkthrough and a "Completion guarantees" section, lists `teamwork_preflight` and `teamwork_final_verify` in the engine table, and documents all 11 agents including `team/security-auditor`.

## [0.5.8] - 2026-11-22

### Added

- `teamwork_final_verify` computes the run's final verdict from the artifacts on disk — every task `verified_pass`, every `verify/report-<task>.json` PASS, and `verify/security-audit.json` PASS — writes `verify/final.json` atomically, and stamps `generatedBy`, `generatedAt`, `integrityMode` and `evidence`. The verdict is evidence-derived: a caller cannot produce a PASS the artifacts do not support, and a supplied `failReason` can only force FAIL.
- `events.jsonl` gains `final_verification` (written by `teamwork_final_verify`) and `final_verification_bypass` (written when `teamwork_next` accepts an unstamped report), plus an optional `note` field recording why a bypass was accepted.
- CI now runs `npm test` on Node 22 and 24, followed by a packaging guard that fails if `docs/re/**` would ship or if required docs and the plugin entry are missing (`.github/workflows/ci.yml`). `publish.yml` runs the same suite and guard before publishing.

### Changed

- Completion now requires a stamped `verify/final.json`. `teamwork_next` treats a PASS report without `generatedBy` (with a session), `generatedAt` or `evidence` as unstamped and returns `FINAL_VERIFICATION_UNVERIFIED`; `allowUnstamped: true` is the explicit, recorded legacy bypass, logged as a `final_verification_bypass` event with a `note`.
- The `/teamwork` sentinel instructions now direct the verifier to call `teamwork_final_verify` instead of hand-writing `verify/final.json`.

## [0.5.7] - 2026-11-21

### Added

- `teamwork_plan` accepts optional `request`, `integrityMode` and `routingReason`; `request` is recorded verbatim and only once in `ORIGINAL_REQUEST.md`, and `integrityMode` (`development` default, `demo`, `benchmark`) is validated and persisted in `state.json` and `plan.dag.json`.
- `ORIGINAL_REQUEST.md` is the single source for the recorded request and mode; `teamwork_security_audit` and the final-verification gate read it from that artifact rather than from the caller.
- `events.jsonl` lines now carry a monotonic `seq` and an `agentSource` (`explicit`, `session`, `plan`) when an actor exists; `teamwork timeline` surfaces both, and logs without them stay valid.
- `teamwork_plan` spec gate: planning is refused without a non-empty `prompt_draft.md` unless `requireSpec: false` or `skipInterview: true`, and the decision is recorded as `specGate` in the `run_created` event.
- `teamwork_plan` rejects unknown topologies, normalises the four legacy aliases on write, and persists `routingReason` in `plan.dag.json` when supplied.
- Per-task `feedbackLog` accumulates each verification round (capped at 20 entries), injects the still-unresolved entries into `teamwork_next`, and clears on `verified_pass`.
- `teamwork_next` requires a PASS `verify/final.json` before reporting `ALL_PASSED`, returning `READY_FOR_FINAL_VERIFICATION` or `BLOCKED_BY_FINAL_VERIFICATION` instead.

### Changed

- Read-only policy documentation now states the exact guarantee: all four read-only agents deny `edit`, verifier, scout and security-auditor keep `shell` (which can modify files), the falsifier also denies `shell`, and a drift test enforces it.
- Legacy topology aliases are normalised on write instead of being stored as supplied.

### Fixed

- `teamwork_status`, `teamwork_resume` and `describeRun` count `verified_pass` as passed, so completed tasks no longer show as outstanding.
- `teamwork_task_update` enforces a transition graph and requires PASS evidence (inline verdict or `verify/report-<task>.json`), so `verified_pass` can no longer be set by a bare status update.
- `scripts/lint-prompts.mjs` scopes topology parsing to its own section and asserts exactly the six canonical topology names.
- `scripts/test-cost.mjs` discovers a real session or skips explicitly instead of depending on a hardcoded session id.

## [0.5.6] - 2026-10-18

### Added

- **`opencode-teamwork export <session-id>` command**:
  - Offline, standalone HTML and GFM Markdown run reporting.
  - Zero external dependencies or CDNs, self-contained embedded CSS with light/dark theme support (`prefers-color-scheme`).
  - Supports `-o <path>` / `--output <path>` (with path containment and symlink traversal guards), `-m` / `--markdown`, and `-o -` stdout streaming.
  - Comprehensive HTML entity escaping (`h()` / `md()`) protecting all dynamic fields against XSS.
  - Wired `export` and `test:export` into `package.json` scripts and aggregate `npm test`.

### Fixed

- **HTML Report Table Layout**:
  - Fixed table column collapse when expanding feedback & summary details by applying `white-space: nowrap` to metadata columns and responsive `min-width` on the task table.

## [0.5.5] - 2026-10-18

### Added

- **`opencode-teamwork timeline <session-id>` command**:
  - Renders a Teamwork run's complete lifecycle in the terminal as a chronological, ANSI-colored timeline (supports `--no-color` and `--json`).
  - Supports both `events` mode (exact wall-clock timings from `events.jsonl`) and honest `derived` mode (`[APPROX]`, no fabricated durations).
  - Timezone-invariant date parsing and formatting.
  - Added 65 hermetic tests in `scripts/test-timeline.mjs` wired into `npm test`.
- **Engine Events Log (`events.jsonl`)**:
  - Appends JSONL events on lifecycle transitions (`run_created`, `task_transition`, `security_audit`) inside locked sections, recording the actual calling actor identity (`team/worker`, `team/verifier`, etc.).
- **Per-Task Cost & Token Attribution**:
  - `costs.json` now records additive `byTaskTokens` (per-task token deltas) alongside task-specific spend, surfaced by the timeline.

### Security & Hardening

- **SEC-1 (Path Traversal in Worktrees)**: Fixed critical arbitrary recursive directory deletion vulnerability in `worktree setup` by introducing strict `TASK_ID` regex allowlist validation and `path.relative()` containment assertions.
- **SEC-2 (Prototype Pollution)**: Converted `byTask`, `byTaskTokens`, and `state.tasks` to null-prototype maps (`Object.create(null)`) with `hasOwnProperty` checks, preventing `constructor` and `__proto__` task IDs from producing NaN, dropping spend, or injecting phantom tasks.
- **SEC-3 (Terminal ANSI / OSC 52 Injection)**: Stripped control characters, OSC 52 clipboard sequences, and C1 bytes from branch names and echoes.
- **SEC-4 (Bounded Safe Reads)**: Replaced unbounded file reads with explicit reason codes (`oversize`, `unreadable`, `absent`, `ok`) and a 64 MiB ceiling.

## [0.5.4] - 2026-10-18

### Changed

- **Set `mode: all` on all team subagents**:
  - OpenCode V2's user interface dropdown only displays agents with `mode: primary` or `mode: all` (agents with `mode: subagent` are hidden from the human user interface).
  - Switched `mode: all` on `worker`, `verifier`, `security-auditor`, `scout`, `synthesizer`, `proof-worker`, `falsifier`, and `proposer`. All 11 team agents can now be seen and selected directly in the OpenCode interface, while remaining fully callable as subagents.

## [0.5.3] - 2026-10-18

### Added

- **`opencode-teamwork doctor` diagnostic command**:
  - Standalone, zero-dependency diagnostic runner in `lib/doctor.mjs` checking 7 environmental invariants: config file presence/validity, plugin registration, 11 installed agents, model map synchronization, git binary, git work tree presence, and worktree directory access.
  - Pretty-printed human readable terminal output with `[✓]`, `[!]`, and `[✗]` status indicators.
  - Added `--json` flag to `opencode-teamwork doctor` for machine-readable diagnostics.
  - Added hermetic automated test suite in `scripts/test-doctor.mjs` wired into `npm test`.

### Fixed

- **Subagent Model & Dispatch Visibility in OpenCode V2**:
  - Subagents previously had `hidden: true` in their frontmatter, causing OpenCode V2 to filter them out of the `subagent` tool schema presented to LLMs. Switched to `hidden: false` on all 8 subagents (`worker`, `verifier`, `security-auditor`, `scout`, `synthesizer`, `proof-worker`, `falsifier`, `proposer`) so OpenCode natively exposes them in the `subagent` tool schema.
  - Updated `sentinel.md` with explicit dispatch rules mandating `agent: "team/*"` (e.g. `team/worker`, `team/verifier`) and strictly forbidding fallback to `general`. This ensures subagents execute with their allocated model (e.g. Claude Haiku / DeepSeek) and dedicated permissions.
- **Model Map Priority Inversion in `lib/team.mjs`**:
  - Fixed `currentModels()` so user configuration in `teamwork.json` takes precedence over installed agent markdown files. Manual edits in `teamwork.json` are now reliably preserved and applied across `install` and `status` runs without dual-list warnings.

## [0.5.2] - 2026-10-18

### Added

- **Complete OpenCode session tree consumption tracking**: `teamwork_cost` and
  `teamwork_plan` now discover and aggregate the entire OpenCode session tree
  (root Sentinel session + all spawned child/subagent sessions, including
  `team/worker`, `team/verifier`, `team/scout`, and adversaries) using OpenCode's
  native SQLite database (`session_v2` recursive query) and background service API.
- Subagent consumptions (such as verifier rounds using frontier models) are no
  longer ignored or lost if a worker halts without calling `teamwork_cost`.
- Added aggregate token usage tracking (`costs.tokens`) across all sessions in
  the tree.
- **Deterministic DAG & Worktree Engine Tools**:
  - `teamwork_next`: Evaluates DAG dependencies and task states to determine ready tasks (`readyForWorker`, `readyForVerifier`), in-progress tasks, injects known pitfalls (`avoidPitfalls`), and enforces the pre-merge security gate.
  - `teamwork_task_update`: Enforces deterministic state transitions (`pending` → `worker_active` → `worker_done` → `verifier_active` → `verified_pass` | `verified_fail` | `blocked`), tracking rounds, worker branches, diff summaries, and verification results. Automatically marks tasks `blocked` if `maxRounds` is exceeded.
  - `teamwork_security_audit`: Enforces mandatory pre-merge security gate (`verify/security-audit.json`). If Critical or High findings exist, blocks final merge (`BLOCKED_BY_SECURITY`).
  - `teamwork_worktree`: Out-of-repo git worktree lifecycle management (`setup`, `diff`, `merge`, `resolve`, `cleanup`). On merge conflict, produces `synthesis/conflict-<taskId>.json` with 3-way diffs for `team/synthesizer`. Self-heals broken or stale worktrees automatically.
- **Dynamic Pitfall Injection**:
  - Known failure modes logged via `teamwork_pitfall` are dynamically injected into `readyForWorker` tasks and surfaced in `describeRun` context.
- **CLI Run Management & Inspection**:
  - `opencode-teamwork runs`: Table summary of all sessions, statuses, security audits, and spent budgets.
  - `opencode-teamwork inspect <id>`: Detailed DAG inspection, task breakdowns, conflict artifacts, and pitfall registries.
  - `opencode-teamwork prune`: Prunes out-of-repo git worktrees for completed sessions.
- Added automated test suite for DAG engine, security gate, conflict handling, and CLI helpers (`npm run test:engine`).
- Added automated test suite for session tree cost tracking (`npm run test:cost`).

### Changed

- Updated `sentinel.md`, `worker.md`, `synthesizer.md`, and `docs/ARTIFACTS.md` to reflect the mandatory pre-merge security gate, dynamic pitfall injection, conflict resolution mode, and new tool options.

## [0.5.1] - 2026-10-12

### Fixed

- **Cost reporting is now accurate.** `teamwork_cost` reads the real,
  OpenCode-computed cost from the native per-session client
  (`ctx.session.get`), instead of trusting agent self-reports. This fixes
  over-reporting (e.g. `$4` reported when the real spend was `$1`) caused by
  cumulative self-reporting and a read-modify-write race on `costs.json`.
- Per-task costs now always sum to the run total — every dollar is attributed
  to a bucket (`_unattributed` when no task is given).
- `budgetUsd: 0` is respected (nullish coalescing instead of `||`); negative
  `addUsd` is rejected.
- Re-planning with a new budget no longer wipes accumulated spend, and now also
  updates `budgetSource`.
- `costs.json` / `snapshots.json` writes are atomic (`.tmp` + rename, with the
  temp path symlink-guarded).
- Concurrent `teamwork_cost` calls are serialized per run, so parallel workers
  can no longer lose each other's attribution.
- A session's first cost check attributes its full cost, so worker sessions are
  no longer reported as `$0`.

### Added

- `teamwork_budget` preflight tool: detects `opencode/` (managed) models — via
  the active session model, the location default, or any `team/*` agent model —
  and a connected `opencode_console` MCP server. When both hold, it instructs
  the sentinel to read console credits (`opencode_console_get_usage` →
  `min(limitDollars - spentDollars)`) and **ask the user** whether to use the
  full remaining budget or a partial (half) amount. `teamwork_plan` records
  `budgetSource` and warns when credits apply but weren't used.
- Cost line injected into every team agent's context (`describeRun`).
- Sentinel: a budget-preflight step and a post-completion `team/verifier` step
  (writes `verify/final.json`).
- `snapshots.json` artifact for per-session cost baselines.

### Changed

- `agents/team/worker.md`: removed the dead `cost.json` estimate; workers now
  call `teamwork_cost` with their `taskId`.
- `docs/ARTIFACTS.md`: documented `snapshots.json`, `budgetSource`, and the
  credits flow.

## [0.5.0] and earlier

See the git history and GitHub releases.
