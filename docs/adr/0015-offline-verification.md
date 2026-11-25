# ADR 0015: Offline Verification

- **Status:** Accepted (0.15.0)
- **Date:** 2026-11-24
- **Scope:** `lib/verify.mjs`, `bin/opencode-teamwork.mjs`, `scripts/test-verify.mjs`,
  `docs/ARTIFACTS.md`, `SECURITY.md`, `README.md`
- **Extends:** [ADR 0005](0005-artifact-authenticity.md) (envelope + digest index),
  [ADR 0007](0007-signed-handoff-provenance.md) (signed handoff index),
  [ADR 0008](0008-signer-spi-and-trust-levels.md) (Ed25519 signer SPI),
  [ADR 0012](0012-evidence-binding-and-contradiction-detection.md)
  (evidence binding and contradictions),
  [ADR 0014](0014-verifiable-witness-and-signer-v2.md) (witness receipts)
- **Related:** [ADR 0006](0006-artifact-trust-isolation.md) (why one UID is not a
  boundary), [ADR 0013](0013-containment-parity-and-the-detective-boundary.md)
  (read/write containment)

## 1. Context

Through 0.14.0 the engine authenticated and cross-bound control-plane artifacts,
but every check that consumed them ran inside the plugin with `ctx.storage`, the
key ring and the run directory. A reviewer who received an archived run had no
way to answer a simple question: *does this directory still describe one
consistent, signed set of artifacts?*

The export command displayed `signed`/`unsigned` from envelope presence, and
`doctor --security` described the local posture, but neither recomputed a
relation from bytes. The audit asked for an offline, read-only verifier that can
run from a copy of the run plus a public key, without the plugin, without
`ctx.storage`, and without a private key.

## 2. Decision

Add `opencode-teamwork verify` and a standalone `lib/verify.mjs` that recompute
the run's named relations from disk. It is read-only and uses only Node
built-ins plus the canonical-JSON leaf in
`plugins/opencode-teamwork/approval-format.mjs`.

### 2.1 Invocation

```
opencode-teamwork verify --session <id> --public-key <base64url|@file>
                         [--key-id <id>] [--repo <path>] [--require-git]
                         [--require-index <snapshot>] [--allow-unsigned]
                         [--fail-on-warning] [--json]
opencode-teamwork verify --run-dir <path> ...
opencode-teamwork verify --session <id> --hmac-key <base64url> --hmac-key-id <id>
```

`--session <id>` resolves `<repo>/.opencode/teamwork/<id>` (`--repo`, else the
current directory). `--run-dir <path>` verifies that directory directly.
`--public-key` may be base64url SPKI or `@file`; a PEM public key is also
accepted. HMAC runs need the 32-byte secret because an HMAC verifier is also a
signer; Ed25519 verification needs only the public key.

### 2.2 The trust anchor

1. Read `run.manifest.json` and verify its `_auth` against the supplied key.
2. Take `runNonce`, `runKeyId` and `_auth.alg` **from the signed payload** (the
   nonce and key id are covered by the envelope, not read from storage).
3. Pin every other artifact to those values: `_auth.path` equals its
   run-relative path, `_auth.keyId` equals `runKeyId`, `_auth.nonce` equals
   `runNonce`, `_auth.alg` equals the manifest algorithm, and the canonical
   payload digest equals `_auth.digest`.
4. Recompute the manifest's baseline hashes: `requestHash` (keyed digest of
   `ORIGINAL_REQUEST.md`), `requirementsHash` (keyed digest of canonical
   normalised `requirements.json`), `planHash` (the semantic plan baseline),
   `lemmaPolicyHash`, and the version-3 `specHash`/`specBytes` (unkeyed SHA-256
   of the exact `prompt_draft.md` bytes).

The verifier never reads the plugin digest index. The signed nonce plus the
path/digest in each envelope replace the index for offline purposes: a copied
envelope fails on path, nonce, key id or digest without `ctx.storage`.

### 2.3 What is recomputed

| Relation | Source of truth |
| --- | --- |
| Every signed artifact's envelope | `_auth` + manifest nonce/key/alg |
| Victory reviewed evidence | `victory.evidenceDigests` vs current report/audit/final bytes |
| Audit rule coverage | `ORIGINAL_REQUEST.md` integrity mode vs `ruleChecks` |
| Audit reviewed evidence | `reviewedDigests.reports`/`final` vs current bytes |
| Report → worker handoff | `report.workerHandoff` vs `handoffs/index.json` body hash |
| Wave report binding | `reportHash` vs unkeyed SHA-256 of the current report bytes |
| Wave citations | `cites[].sha256`/`bytes` vs current `verify/` bytes |
| Handoff index entry | `_auth`, body hash, byte length, canonical header, cites |
| Continuity matrix | plan/state modes vs required `(taskId, agent)` entries |
| Final verdict | `evidence.reportDigests`, `evidence.auditDigest`, `requirementsHash` |
| Report schema | PASS checks, `outputSha256`, `CHECK_EXIT_CONFLICT`, fatal findings |
| Four contradictions | `INCONSISTENT_{VICTORY_TASK,REPORT_BRANCH,AUDIT_HIGH,WAVE_REPORT}` |
| Optional branch binding | `--repo`: `git rev-parse` and `git diff` vs `headSha`/`diffHash` |
| Optional rollback check | `--require-index <snapshot>` file hashes |

Wave `cites` and `reportHash` use **unkeyed** SHA-256, matching `strict.ts`.
`evidenceDigests`, `reviewedDigests`, handoff hashes and final digests use the
keyed domain-separated digest from `approval-format.mjs`. The verifier must not
mix the two.

A `cites: []` wave is unbound and fails. A missing `cites` field is a warning
(`legacy_unbound_wave`) and is surfaced, never silently current. A `null` report
digest for a PASS report fails. A programmatic check whose `passed` and
`exitCode` disagree fails. The verifier never runs the check, so a consistently
signed false observation still passes (see §4).

### 2.4 Verdicts and exit codes

| Exit | Verdict | Meaning |
| --- | --- | --- |
| 0 | `PASS` | Every check that could be evaluated passed; required relations hold |
| 1 | `FAIL` | A required check failed (or `--fail-on-warning` promoted a warning) |
| 2 | `UNKNOWN` | No key for the run algorithm, unsigned legacy, HMAC without a secret, git required but unavailable, index snapshot requested but missing, or witness required but no receipt |
| 3 | — | Usage error (bad flags, missing run directory, invalid key) |

A failed signature is `FAIL`, not `UNKNOWN`: a key was supplied and it did not
verify the bytes. `UNKNOWN` is never promoted to `PASS`. `--allow-unsigned`
permits relation analysis of a legacy run with no `run.manifest.json`, but the
verdict stays `UNKNOWN`, because the missing signatures are exactly what the tool
was asked to establish. When a manifest is present, signed or not,
`--allow-unsigned` has no effect: a missing artifact envelope is `FAIL`, as is a
missing handoff-index envelope on a run whose manifest requires signed handoffs.
It cannot be combined with `--rerun`.

`run.manifest.json` also carries a `trustLevel`. Offline `verify` has no
approval enforcement, so `human-approved` and `ci-attested` emit
`trust:approval` / `AUTH_APPROVAL_UNVERIFIED` (`UNKNOWN`), never `PASS`. A
manifest with `requireWitness: true` and no usable witness receipt emits
`trust:witness` / `AUTH_WITNESS_UNVERIFIED` (`UNKNOWN`). The `trust` object
reports `runTrustLevel`, `approval.status` and `witness.status` so a consumer
can distinguish "not required" from "not verified".

### 2.5 Stable JSON

`--json` is the source of the human table. The object is built in one place:

```json
{
  "schemaVersion": 1,
  "toolVersion": "0.15.0",
  "runId": "20261124-120000-abcd",
  "runPath": "/abs/path/.opencode/teamwork/20261124-120000-abcd",
  "trust": { "alg": "ed25519", "keyId": "ed_...", "source": "public-key" },
  "verdict": "PASS|FAIL|UNKNOWN",
  "counts": { "pass": 0, "warn": 0, "fail": 0, "skip": 0, "unknown": 0, "total": 0 },
  "checks": [
    { "id": "auth:verify/report-R1.json", "level": "required", "status": "pass", "detail": "...", "artifacts": ["..."] }
  ],
  "relations": [
    { "from": "verify/victory.json", "to": "verify/report-R1.json", "kind": "evidenceDigest", "expected": "...", "actual": "..." }
  ],
  "reasons": ["[AUTH_STALE] ..."],
  "generatedAt": "2026-11-24T12:07:00.000Z"
}
```

`generatedAt` is the only clock field. `checks`, their `artifacts`, and
`relations` are emitted in a deterministic order (artifact paths sorted), so two
runs over the same bytes differ only in `generatedAt`. Failure reasons begin
with the machine code (`AUTH_INVALID`, `AUTH_STALE`, `REPORT_HANDOFF_STALE`,
`AUDIT_RULE_MISSING`, `WAVE_UNBOUND`, `INCONSISTENT_*`, …). A human table is
rendered from this object, not composed separately.

### 2.6 Index snapshot (`--require-index`)

A whole-run rollback to an earlier, internally consistent signed set is
invisible to per-artifact checks. An optional snapshot closes that gap:

```json
{
  "version": 1,
  "runId": "20261124-120000-abcd",
  "generatedAt": "2026-11-24T12:06:00.000Z",
  "files": {
    "run.manifest.json": "<unkeyed sha256 of the exact file bytes>",
    "verify/report-R1.json": "<unkeyed sha256>",
    "handoffs/index.json": "<unkeyed sha256>"
  }
}
```

The verifier requires every snapshot entry to still hash to the recorded value
and every current run file (excluding the snapshot itself) to appear in the
snapshot. A missing, added or changed file is `INDEX_ROLLBACK`. Without a
snapshot the residual remains (§4). `--require-index` with no path yields
`UNKNOWN` rather than a false assurance.

The snapshot is a caller-supplied witness of an earlier state. It is not signed
by this tool and is only as trustworthy as the place it was stored.

### 2.7 Read-only and containment

The verifier opens files with `O_RDONLY | O_NOFOLLOW`, requires a regular file
under the run root, checks the real path stays inside the run root, checks
`lstat` for a symlink, and applies a byte cap per artifact class. It refuses a
symlinked run root or `verify/` root. It never creates a file, lock, temp file,
or event; the test suite runs one fixture under `chmod -R a-w` and asserts both
the verdict and unchanged file sizes/mtimes.

`O_NOFOLLOW` covers the final component; the `realpath` check covers an
intermediate directory that resolves outside the run. A same-UID writer that can
change the copy while it is being read is outside the model, as it is for every
reader in this project ([ADR 0006](0006-artifact-trust-isolation.md)).

## 3. Consequences

- A reviewer can attach a run directory and a public key to an issue and have a
  reproducible machine verdict without the plugin, database or key ring.
- The verifier duplicates a small, stable amount of engine logic (plan baseline
  hash, requirements normalisation, integrity-rule table, handoff header and
  cite allowlists). The duplication is deliberate: `lib/verify.mjs` must run on
  plain Node without TypeScript stripping or plugin imports. Tests exercise the
  real signer and handoff writer so the formats stay in lockstep.
- Failures are named after the engine's own codes (`AUTH_INVALID`,
  `AUTH_STALE`, `REPORT_HANDOFF_STALE`, `INCONSISTENT_*`), so an operator can
  map a verifier failure to the tool that must re-record the evidence.
- The tool is additive. No engine tool reads `lib/verify.mjs`, no artifact
  schema changed, and an existing run needs no migration.

## 4. Residuals

> a verifier holding only the public key and a read-only copy can recompute every
> byte digest, citation, branch binding and cross-artifact relation; it still
> cannot prove an observation, a consistently authored false report passes every
> check, and a whole-run rollback to an earlier signed set is undetectable
> without a snapshot or witness.

- **Observation is not proof.** A signed `PASS` report can assert that 999 tests
  passed when none ran. `outputSha256` binds the claimed output; it does not
  execute it. Test T17 is the negative control that locks this in.
- **Consistent forgery at creation.** A writer with the signing key can author a
  false report, audit, victory and final that agree with each other. Every
  relation verifies; the claim is still false. Binding makes the claim specific
  and falsifiable, not true.
- **Whole-run rollback.** Replacing every file with an earlier validly signed
  set defeats per-artifact checks. Only a snapshot (`--require-index`) or an
  external witness with a monotonic record detects it.
- **Same-UID key holder.** The verifier does not defend against a writer that can
  read the HMAC secret or Ed25519 private key; it only makes the public-key case
  meaningful.
- **Git is optional and local.** `--repo` recomputes branch heads and diffs from
  the supplied repository. A forged repository with the same branch names and
  bytes is evidence about that repository, not about the world.
- **Legacy artifacts.** Missing `cites`, missing `evidenceDigests` and
  `reviewedDigests` are `AUTH_STALE`/warnings, never silently current.

## 5. Alternatives considered

- **Reuse the TypeScript gate functions.** They import `ctx.storage`, locks,
  `safe-fs` and the signer; adding an offline mode would either drag the plugin
  runtime into the CLI or create a second set of conditions. The chosen leaf is
  smaller and testable on plain Node.
- **Trust the plugin digest index.** The index lives outside the run in
  `ctx.storage`; an archived directory does not contain it. The signed nonce and
  path are sufficient to detect cross-run/cross-file reuse offline.
- **Make `--require-index` mandatory.** That would make the common case
  `UNKNOWN` and the CLI impractical. The rollback residual is stated instead,
  and the snapshot is opt-in.
- **Re-execute reported checks.** That would make the verifier a build system:
  it needs the source tree, toolchain, network policy and a sandbox. It would
  not prove the original run's observation either. The verifier reports bytes.
