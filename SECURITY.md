# Security model and artifact-trust boundary

This document states what `@heretek-ai/opencode-teamwork-v2` does and does not
protect, and how to choose a trust level. The implementation decisions are in
[ADR 0005](docs/adr/0005-artifact-authenticity.md),
[ADR 0006](docs/adr/0006-artifact-trust-isolation.md) and
[ADR 0008](docs/adr/0008-signer-spi-and-trust-levels.md). Handoff provenance is
a sibling extension of ADR 0005, specified in
[ADR 0007](docs/adr/0007-signed-handoff-provenance.md). Evidence binding and
contradiction detection are specified in
[ADR 0012](docs/adr/0012-evidence-binding-and-contradiction-detection.md).
Verifiable witness receipts and signer protocol v2 are specified in
[ADR 0014](docs/adr/0014-verifiable-witness-and-signer-v2.md). Offline
verification from bytes and a public key is specified in
[ADR 0015](docs/adr/0015-offline-verification.md). Re-execution of recorded
command evidence is specified in
[ADR 0016](docs/adr/0016-re-executable-verification.md).

## What is protected

Control-plane artifacts — `run.manifest.json`, `verify/report-<task>.json`,
`verify/security-audit.json`, `verify/challenge-<task>.json`,
`verify/audit-<task>.json`, `verify/victory.json`, and `verify/final.json` —
carry an `_auth` envelope over their exact run-relative path plus a canonical
JSON digest. Every signed run pins a 128-bit `runNonce` and a `runKeyId` in the
signed manifest, and each artifact also has a digest-index entry outside the run
directory (`auth/run/<runId>/<relPath>` in `ctx.storage`).

Against a writer limited to the run directory, the envelope and index make these
attacks detectable:

- forging a verifier report, security audit, strict-wave verdict, victory
  verdict, or final verdict;
- flipping a signed verdict field after the write;
- copying an `_auth` envelope between files or between runs (path, nonce, key
  id, and index all bind the artifact to one run);
- re-signing a rotated run with a different key id (the manifest's `runKeyId` is
  pinned);
- downgrading `verification`, `victoryAudit`, `requireHandoffs`,
  `integrityMode`, the plan, the request, the requirements baseline, or the
  LEMMA axiom policy after the plan.

With an Ed25519 key, **verification needs only the SPKI public key**. A verifier
does not need the private key, and does not need to trust the signer's claimed
algorithm or key id: the envelope algorithm is fixed to `ed25519`, the key id is
pinned by the manifest, and the signature is checked against the configured
public key before the artifact is accepted.

### Evidence binding: bytes, facts, observation

0.12.0 makes each verdict name the evidence it reviewed and the gate recompute
that relation from disk ([ADR 0012](docs/adr/0012-evidence-binding-and-contradiction-detection.md)):

- **Bytes.** A victory binds `evidenceDigests {reports, securityAudit, final}`;
  a verifier report binds the worker handoff body (`workerHandoff`); a security
  audit binds its `reviewedDigests` and its `ruleChecks`; a wave binds cited
  `verify/` files; `verify/evidence/<name>` artifacts are bounded (64 KiB, 32
  per run) and re-hashed. Editing, deleting, resizing, or swapping any of those
  makes the dependent verdict `AUTH_STALE`/`STALE`.
- **Facts.** The engine derives the relations from `plan.dag.json`,
  `handoffs/index.json`, and the files themselves — coverage of every rule
  forbidden at the run's integrity mode, the verifier → worker → report chain,
  and four cross-artifact contradictions
  (`INCONSISTENT_VICTORY_TASK`, `INCONSISTENT_REPORT_BRANCH`,
  `INCONSISTENT_AUDIT_HIGH`, `INCONSISTENT_WAVE_REPORT`). These can make a run
  fail; they cannot make a dishonest claim true.
- **Observation.** The reviewer's judgment (a requirement is met, a rule is
  clean) is recorded, not proven. The engine never parses prose as PASS/FAIL.

> a same-UID writer can still author false content; the engine guarantees the
> false claim is specific, signed, path-bound and digest-chained, so a
> privileged verifier can falsify it.

That sentence is the whole claim. Binding makes a lie **specific and
falsifiable**; it does not detect a false statement at creation, prove that a
reviewer read the artifact, or replace re-execution.

## What is not protected

- **A same-UID process.** A shell running as the OpenCode user can read
  `opencode.db` / the plugin KV store, the local Ed25519 private key, the HMAC
  key, and the digest index. It can mint an envelope and rewrite the index. A
  local `command:` signer that accepts any request from that UID is a signing
  oracle, not a boundary. This is why the package does not describe artifacts
  as tamper-proof or as signed by a trusted authority.
- **A modified plugin or config.** The plugin, agent prompts, and
  `opencode.json` are user-owned; a same-UID writer can disable the gate.
- **A prompt-injected agent with shell access.** The gate authenticates the
  artifact, not the judgment of the agent that wrote it.
- **Root, a malicious kernel/OpenCode binary, a compromised model provider, or
  physical access.**
- **Availability.** A same-UID writer can delete or truncate a run.
- **Secrecy of run artifacts.** Authenticity is not confidentiality.

`opencode-teamwork doctor --security` prints the relevant host facts (key
source/algorithm, signer/witness config, `ptrace_scope`, root-equivalent group
membership, DB mode including `-wal`/`-shm`, config/plugin writability, whether
an approver key is configured and whether its private material is visible to
this UID, whether a configured signer could accept an `approvals/` path, the
prompt-approval directory and its owner, the signer-approval directory and its
owner, write-containment mode, SELinux). A knowable problem is a
`fail`; an uninspectable fact is `unknown`, never "safe".
`doctor --security --require-hardened` exits 2 when any check is `fail` or
`unknown`; plain `doctor --security` is advisory (exit 0 with a warning
summary). The doctor does not turn a warning into protection.

### Write containment is preventive on Linux, detective elsewhere

Run-artifact writers are **preventive** only on Linux with a usable
`/proc/self/fd`: the destination parent is pinned once and every create, mkdir,
rename, write, lstat and unlink is relative to that descriptor (ADR 0010).
**Linux without procfs fails closed**; nothing is written. **macOS and Windows
are detective**: there is no pure-JS dir-relative write without a native addon,
so the writer keeps the path-based atomic write and checks. 0.13.0 records the
run root and every existing ancestor `(dev, ino)` at target time, re-stats them
before the create/rename/unlink and in the post-check, refuses a mismatch as
`identity-changed`, and records the run-root identity in the signed
`run.manifest.json` for a re-check before control-plane writes. A detected swap
is a report about an event that already happened, not a prevented one: bytes may
already be outside the run and are not rolled back, and a transient swap that is
reverted before the check can be missed. A legitimately renamed run root fails
closed.

`OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1` (or a plan's
`requirePinnedWrites: true`) makes the policy explicit: on a host whose mode is
not `pinned`, **control-plane writes are refused** with a named
`containment-mode` refusal. It is off by default. `doctor --security` reports
the mode and the env setting; an asserted policy on a non-pinned host is a
failure, so `--require-hardened` exits 2.

## Trust levels

`teamwork_plan` accepts `trustLevel` (default `local-hmac`). The level is
persisted in `plan.dag.json`, `state.json`, and the signed
`run.manifest.json`; a re-plan may repeat it but never change it. `final_verify`
enforces it.

| Level | Signing | What `final_verify` requires |
| --- | --- | --- |
| `local-hmac` | HMAC-SHA256 key ring in plugin storage (or `OPENCODE_TEAMWORK_HMAC_KEY`) | A verified HMAC envelope and index entry. |
| `external-signer` | Local Ed25519 key or `OPENCODE_TEAMWORK_SIGNER=command:<path>` | Verified **Ed25519** envelopes only; an HMAC envelope fails `AUTH_TRUST_LEVEL`. |
| `human-approved` | Any configured run source | An Ed25519 approval in `OPENCODE_TEAMWORK_APPROVAL_DIR` bound to the exact `prompt_draft.md` bytes, the run id, and a one-use nonce, with `approvedBy` and a fresh bounded lifetime. |
| `ci-attested` | Any configured run source | The same prompt-bound approval with `attestedBy` and `trustLevel: "ci-attested"`. |

### What `human-approved` / `ci-attested` establish

An approval is a separate Ed25519 `_auth` envelope over
`{runId, trustLevel, binding: "prompt", promptDraftSha256, promptDraftBytes,
openGaps, approvalNonce, approvedAt, expiresAt, planHash?, approvedBy|attestedBy}`.
Since 0.11.0 it binds the **prompt draft**, not only the manifest. The
manifest (version 3) records `specHash`, `specBytes`, `approvalDigest`,
`approvalNonce`, `approvalBinding`, `approvedBy`, and `approvedAt`; a re-plan
that changes any of them is `AUTH_STALE`.

- It must be read from an **absolute approval directory** outside the run and
  the repository, a real directory (never a symlink), owned by a **different
  UID** than the run process. A file must be a regular file, not a symlink, also
  owned by that other UID. A same-UID directory fails
  `AUTH_APPROVAL_UNTRUSTED`; the sandbox cannot satisfy this on one UID.
- Its envelope must be **Ed25519**, and its `_auth.keyId` must be **different**
  from the manifest's `runKeyId`. An HMAC approval or an approval signed with
  the run key fails `AUTH_APPROVAL_NOT_HUMAN`. Configure the verify-only
  approver key with `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` (and optionally
  `_KEY_ID`); the key id is pinned in the signed manifest as `approvalKeyId`.
- It must bind the exact `prompt_draft.md` bytes
  (`promptDraftSha256 === specHash`, `promptDraftBytes === specBytes`), the
  `runId`, and `binding: "prompt"`. An edited draft, another run's approval, or
  a missing field fails `AUTH_APPROVAL_STALE` / `AUTH_APPROVAL_INCOMPLETE`.
- `openGaps` must be `0` and the draft must contain no `[OPEN:` marker.
  `approve sign --allow-open` records a nonzero count, which the plan then
  refuses (`AUTH_APPROVAL_INCOMPLETE`).
- `approvalNonce` must be at least 128 bits, equal `_auth.nonce`, and unused for
  the run. The plugin consumes it once at plan time and stores
  `{approvalNonce, approvalDigest, planHash, at}` at
  `ctx.storage` `auth/approval/<runId>/consumed`; a later different nonce is
  `AUTH_APPROVAL_REPLAY`.
- `approvedAt`/`expiresAt` must be fresh. The default lifetime is 24 hours
  (`OPENCODE_TEAMWORK_APPROVAL_TTL_MS`, capped at 7 days); a stale, expired, or
  over-long approval fails `AUTH_APPROVAL_STALE`. A prompt-bound approval is
  produced before the plan, so it must still be live when the manifest was
  written.
- `approvedBy`/`attestedBy` must look like a principal: `uid:<name>`,
  `oidc:<issuer>#<sub>`, or `ci:<workflow>`. A bare `team/...` or `ses_...`
  label fails `AUTH_APPROVAL_NOT_HUMAN`.
- The plugin signer and any `command:` signer refuse an `approvals/` path with
  `AUTH_APPROVAL_SCOPE`. Approvals are produced only by
  `opencode-teamwork approve sign` (or an equivalent CI job) holding the
  approver private key directly.

This establishes that a **different configured principal signed these exact
draft bytes and this run while the approval was fresh**. It does **not**
establish that a human read the draft, understood it, or approves the
behaviour: the identity is a claimed label, not an identity proof, the CLI
cannot prove that the text displayed to the approver was the text hashed, and
approval content is not validated. The run process must still be configured so
that the approver key and directory are outside the agent's write reach; a
same-UID approver is not a boundary and cannot satisfy the gate.

> `human-approved` means the approval artifact verifies under an Ed25519 key
> the agent's process does not hold and cannot ask to sign, and is bound to the
> exact bytes of prompt_draft.md and this run. It does not establish that a
> human read the draft, that the displayed text matched the bytes hashed, or
> that the approver understood it. Treat it as provenance, not comprehension.

A new plan with `human-approved`/`ci-attested` refuses **before writing
anything** when the directory, approver key, draft, or approval is missing or
incomplete (`AUTH_APPROVAL_DIR` / `AUTH_APPROVAL_UNTRUSTED` /
`AUTH_APPROVAL_INCOMPLETE`). Manifests written by 0.10.1 and earlier
(version 1) keep their old in-run `approvals/<run>.json` path readable, but
`final_verify` records `approval_unbound` and does not claim a distinct
principal for it. Version 2 (0.10.2) keeps its manifestDigest-bound approval
semantics.

### CI attestation (`attestationPolicy`, 0.18.0)

`attestationPolicy` (`off` | `optional` | `required`, default `off`) is a
separate, post-plan requirement. A CI job holding an Ed25519 key the run does
not have signs `verify/ci/attestation.json` over the run nonce, plan hash,
prompt hash, commit and the argv/cwd/exit/output digest of every command it
ran. `final_verify` and `verify --attestation-public-key` bind it to the signed
manifest and every report head; a run-key signature is
`AUTH_ATTESTATION_UNTRUSTED`, and a foreign run id/nonce is
`AUTH_ATTESTATION_REPLAY`.

This establishes that **a second configured identity signed the same plan and
commit and observed the same command outputs**. It does not establish that the
suite is meaningful, that a test was not edited in the same commit, or that the
CI principal is independent of the agent's UID. Configure the verify-only key
with `OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY`; the private key belongs only
to the CI producer. `doctor --security` fails `attestation_key` when private
material is visible to this process and warns when `attestationPolicy` is
`required` but no key is configured. See
[ADR 0018](docs/adr/0018-ci-attestation.md).

Benchmark integrity refuses an explicit `local-hmac` trust level and warns when
the default is used.

## Decision tree

1. **Single-user laptop, no separate privilege domain.** Use `local-hmac`
   (the default). Accept that a same-UID shell can forge verdicts. The envelope
   still stops run-dir-only writers, accidental copies, and post-plan
   downgrades.
2. **You need verification without giving the verifier the signing secret.**
   Use an Ed25519 key and publish only the SPKI public key
   (`OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY`), or a command signer with
   `OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY`. Choose `external-signer`.
3. **You need a real boundary against the agent's UID.** Use the hardened
   profile: run the signer as a **separate OS user** (or a remote KMS/HSM) and
   give it a no-oracle policy — sign only after a human approves the exact
   `(runId, path, digest)`, or after an independent verifier recomputes the
   verdict from evidence the agent UID cannot rewrite. Pair it with
   `human-approved` or `ci-attested`, and configure a witness.
4. **You need post-hoc detection of index tampering.** Configure
   `OPENCODE_TEAMWORK_WITNESS=command:<path>` or `http(s)://<url>` and set
   `requireWitness: true` on the plan. A witness receipt is appended on every
   signed write and checked by `final_verify` (`AUTH_WITNESS_UNAVAILABLE` when
   required and missing). Configure `OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY` to
   make the receipt a signature over `(runId, path, digest, nonce, at)`: a
   forged KV receipt is then `AUTH_INVALID` instead of accepted. Without that
   public key the receipt is recorded and labelled `unverified` in
   `verify/final.json`; a local file/command witness is detection-only and
   shares the same UID either way.
5. **You need an observer outside the agent's process.** Run
   `.github/workflows/attest.yml` (or `scripts/attest-sign.mjs`) under a CI
   principal, set `attestationPolicy: "required"`, and give the verifier only
   `OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY`. The attestation binds the signed
   plan, the report's commit and the command outputs to a key the run does not
   hold. It is only a boundary when the agent's UID cannot read the CI key.

The hardened profile is an administrator/deployment change (a system service,
separate UID, SELinux labels, or a remote approver). The plugin cannot create
that boundary in-process. The step-by-step administrator runbook is
[docs/ADMIN-HARDENING.md](docs/ADMIN-HARDENING.md); the policy-enforcing signer
contract is [docs/SIGNER-PROTOCOL.md](docs/SIGNER-PROTOCOL.md); the read-only
host verifier is [scripts/hardening-check.sh](scripts/hardening-check.sh). Those
steps are deployment guidance, not something the plugin enforces.

## Configuration

| Variable | Meaning |
| --- | --- |
| `OPENCODE_TEAMWORK_HMAC_KEY`, `OPENCODE_TEAMWORK_HMAC_KEY_ID` | HMAC key (base64url, 32 bytes) and optional key id; CI/offline override. |
| `OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY` | PKCS#8 Ed25519 private key (base64url DER). Readable by this UID. |
| `OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY` | SPKI Ed25519 public key (base64url DER). Required for public-key-only verification. |
| `OPENCODE_TEAMWORK_ED25519_KEY_ID` | Optional key id; defaults to a digest of the public key. |
| `OPENCODE_TEAMWORK_SIGNER` | `command:<absolute path>`. Spawned with fixed argv, JSON on stdin/stdout, no shell. |
| `OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY` | SPKI public key used to verify the signer's response. Required. |
| `OPENCODE_TEAMWORK_SIGNER_KEY_ID` | Optional expected key id; defaults to a digest of the public key. |
| `OPENCODE_TEAMWORK_SIGNER_TIMEOUT_MS` | Signer timeout (default 5000, max 60000). |
| `OPENCODE_TEAMWORK_WITNESS` | `command:<absolute path>` or `http(s)://<url>`. |
| `OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY` | SPKI Ed25519 witness key (base64url). When set, a receipt must carry a valid `sig` over `teamwork-witness-v1`. |
| `OPENCODE_TEAMWORK_WITNESS_KEY_ID` | Optional witness key id; defaults to a digest of the public key. |
| `OPENCODE_TEAMWORK_WITNESS_TIMEOUT_MS` | Witness timeout (default 5000, max 60000). |
| `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` | Absolute signer-approval directory outside the run/repo, owned by a different UID. When set, the signer request is v2 with `runId` and `approvalRef`; when unset, the exact v1 request is sent. |
| `OPENCODE_TEAMWORK_APPROVAL_DIR` | Absolute approval directory outside the run and repo, owned by a different UID. Required for `human-approved`/`ci-attested`. |
| `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` | SPKI Ed25519 public key of the approver (verify-only). Pinned as `approvalKeyId` at plan time. |
| `OPENCODE_TEAMWORK_APPROVAL_KEY_ID` | Optional approval key id; defaults to a digest of the approval public key. |
| `OPENCODE_TEAMWORK_APPROVAL_TTL_MS` | Default approval lifetime when `expiresAt` is omitted (24 h; max 7 days). |
| `OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY` | PKCS#8 Ed25519 private key (base64url DER) used **only by the approver's own process** (`approve sign`). Never give it to the agent's process. |
| `OPENCODE_TEAMWORK_APPROVAL_KEY_FILE` | Path to a PEM or base64url PKCS#8 approver key for `approve sign` (alternative to the env/`--key`). |
| `OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY` | SPKI Ed25519 CI attestation key (base64url or PEM) for `final_verify`/`verify`. Verify-only. |
| `OPENCODE_TEAMWORK_ATTESTATION_KEY_ID` | Optional attestation key id; defaults to a digest of the public key. |
| `OPENCODE_TEAMWORK_ATTESTATION_ISSUER` | Optional expected `oidc.issuer` when the manifest does not pin one. |
| `OPENCODE_TEAMWORK_ATTESTATION_PRIVATE_KEY`, `_KEY_FILE` | CI producer key; must never be visible to the agent's UID (`doctor --security` fails if it is). |

The command signer receives `{v, alg, keyId, path, digest, nonce, at, message}`
when `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` is unset, or
`{v: 2, op: "sign-artifact", runId, alg, keyId, path, digest, nonce, at,
approvalRef, message}` when it is set, and must return
`{alg: "ed25519", keyId, sig}`. The plugin verifies the returned signature with
the configured public key before accepting it. A configured but unavailable,
malformed, timing-out, or non-verifying signer fails closed with
`AUTH_SIGNER_UNAVAILABLE`; it never falls back to the local HMAC key. A v1-only
signer with the directory set, or a v2-only signer without it, fails the same
way. The plugin derives `approvalRef` as
`<DIR>/<runId>/<plain sha256(path)>.json` and does not read the approval; the
signer's policy is outside the plugin.

## Residual risks

- **Offline verification is relational, not observational.** `opencode-teamwork
  verify` (0.15.0) recomputes the envelopes, evidence digests, citations,
  handoffs, branch binding and contradictions from a read-only copy and a public
  key. It cannot execute a claimed check, so an invented `output` with a correct
  `outputSha256` still verifies. A consistently authored false report passes
  every check. A whole-run rollback to an earlier signed set is undetectable
  without `--require-index <snapshot>` or an external witness. The exact
  residual is: a verifier holding only the public key and a read-only copy can
  recompute every byte digest, citation, branch binding and cross-artifact
  relation; it still cannot prove an observation, a consistently authored false
  report passes every check, and a whole-run rollback to an earlier signed set
  is undetectable without a snapshot or witness.
- **Re-execution narrows the residual; it does not close it.** Under
  `requiredProvenance: "command"` (0.16.0) a `PASS` must now survive
  `opencode-teamwork verify --rerun --repo <clean-checkout>`: the signed
  `verify/rerun.json` commands are re-executed at the report's commit in a
  disposable worktree and their exit code and output digest must match. The
  engine itself never runs the command (`teamwork_report` records the
  observation; `final_verify` only checks the record shape), so a compromised
  verifier can still author a consistent claim that the deployed environment
  later reproduces. A meaningless command (for example `true`), a test edited in
  the same commit, a non-deterministic command, or one whose output exceeds the
  bounded capture still passes; re-execution proves reproducibility of the
  recorded command at that commit, not that the command tests the requirement.
  `declared` runs keep the 0.15 residual unchanged.
- **Same-UID key access.** A local HMAC or Ed25519 private key is only as secret
  as the process UID. Only a different privilege domain (separate UID, KMS/HSM,
  hardware token) changes that.
- **Command signer is only non-oracle if external.** A signer reachable by the
  agent's UID can be called by any same-UID process. Its policy, not its
  location, is what makes it meaningful.
- **Nonce and index storage.** The nonce, key-id pin, and digest index live in
  plugin storage. A same-UID writer can rewrite them; the witness is the
  optional cross-check. A witness receipt is only `verified` when a witness
  public key is configured and its signature covers the run, path, digest,
  nonce and signed time. Without that key it is `unverified` (detection-only),
  and a local witness shares the UID.
- **Approval artifact.** `approvals/<runId>.json` is verified with the
  configured approval key. The plugin refuses to sign an `approvals/` path, and
  0.11.0 requires an Ed25519 approver key distinct from `runKeyId` and an
  approval directory owned by another UID. The approval proves which configured
  key signed which exact draft bytes and run id; it does not prove the
  approver's real-world identity, that a human read the draft, that the text
  displayed to the approver matched the bytes hashed, or that the approval
  content is accurate.
- **Approval content is a name, not a proof.** `approvedBy` is a claimed label.
  A compromised or careless approver process can sign any draft, and a
  same-UID key holder (including a single-UID sandbox) cannot satisfy the
  distinct-principal requirement at all. `doctor --security` now fails
  `approval_key` when the approver private key (inline or a readable key file)
  is visible to the workload UID, but a single-UID host cannot fix that by
  configuration. There is no human-presence enforcement: the CLI asks for a
  typed digest prefix and the word `approve`, but a script holding the key can
  reproduce both.
- **CI attestation is an identity claim plus a binding, not a proof of quality.**
  With `attestationPolicy: "required"` (0.18.0) the declared commands ran at the
  recorded commit under a separate signing identity, and the key is distinct
  from `runKeyId`; the attestation also binds the run nonce, plan hash, report
  head and command/output digests. It still does not prove the suite is
  meaningful, and a compromised CI, a weak suite, or a test edited in the same
  commit still pass. A CI principal reachable by the agent's UID (a repository
  secret readable from the workload, a key file in the same account) is not a
  boundary: the signature then proves the binding, not independence. The OIDC
  claims are checked only as a signed/pinned issuer string; no token is fetched
  or validated. A malicious dispatcher with write access to the protected
  branch can change what CI runs, which is exactly the CI privilege boundary
  the deployment must protect.
- **Display spoofing.** The CLI hashes the bytes on disk and prints the digest.
  It cannot prove that the approver's review surface showed those same bytes; a
  redirect, a different checkout, or a renderer that hides text is outside the
  boundary.
