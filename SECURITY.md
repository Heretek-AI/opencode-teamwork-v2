# Security model and artifact-trust boundary

This document states what `@heretek-ai/opencode-teamwork-v2` does and does not
protect, and how to choose a trust level. The implementation decisions are in
[ADR 0005](docs/adr/0005-artifact-authenticity.md),
[ADR 0006](docs/adr/0006-artifact-trust-isolation.md) and
[ADR 0008](docs/adr/0008-signer-spi-and-trust-levels.md). Handoff provenance is
a sibling extension of ADR 0005, specified in
[ADR 0007](docs/adr/0007-signed-handoff-provenance.md).

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
membership, DB mode including `-wal`/`-shm`, config/plugin writability, the
approval directory, write-containment mode, SELinux). A knowable problem is a
`fail`; an uninspectable fact is `unknown`, never "safe".
`doctor --security --require-hardened` exits 2 when any check is `fail` or
`unknown`; plain `doctor --security` is advisory (exit 0 with a warning
summary). The doctor does not turn a warning into protection.

## Trust levels

`teamwork_plan` accepts `trustLevel` (default `local-hmac`). The level is
persisted in `plan.dag.json`, `state.json`, and the signed
`run.manifest.json`; a re-plan may repeat it but never change it. `final_verify`
enforces it.

| Level | Signing | What `final_verify` requires |
| --- | --- | --- |
| `local-hmac` | HMAC-SHA256 key ring in plugin storage (or `OPENCODE_TEAMWORK_HMAC_KEY`) | A verified HMAC envelope and index entry. |
| `external-signer` | Local Ed25519 key or `OPENCODE_TEAMWORK_SIGNER=command:<path>` | Verified **Ed25519** envelopes only; an HMAC envelope fails `AUTH_TRUST_LEVEL`. |
| `human-approved` | Any configured run source | An Ed25519 approval in `OPENCODE_TEAMWORK_APPROVAL_DIR` bound to the run id and signed-manifest digest, with `approvedBy` and a fresh bounded lifetime. |
| `ci-attested` | Any configured run source | The same approval with `attestedBy` and `trustLevel: "ci-attested"`. |

### What `human-approved` / `ci-attested` establish

An approval is a separate `_auth` envelope over
`{runId, trustLevel, approvedBy|attestedBy, approvedAt, expiresAt?, manifestDigest}`:

- It must be read from an **absolute approval directory** outside the run and
  the repository, a real directory (never a symlink), owned by a **different
  UID** than the run process. A file must be a regular file, not a symlink, also
  owned by that other UID.
- Its envelope must be **Ed25519**, and its `_auth.keyId` must be **different**
  from the manifest's `runKeyId`. An HMAC approval or an approval signed with
  the run key fails `AUTH_APPROVAL_NOT_HUMAN`. Configure the verify-only
  approver key with `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` (and optionally
  `_KEY_ID`); the key id is pinned in the signed manifest as `approvalKeyId`.
- It must bind the current signed `manifestDigest` and `runId`, have
  `approvedAt >= manifest.createdAt`, and not be expired. The default lifetime
  is 24 hours (`OPENCODE_TEAMWORK_APPROVAL_TTL_MS`, capped at 7 days); a stale
  or over-long approval fails `AUTH_APPROVAL_STALE`.
- `approvedBy`/`attestedBy` must look like a principal: `uid:<name>`,
  `oidc:<issuer>#<sub>`, or `ci:<workflow>`. A bare `team/...` or `ses_...`
  label fails `AUTH_APPROVAL_NOT_HUMAN`.

This establishes that a **different configured principal signed this exact
manifest digest while the approval was fresh**. It does **not** establish that
a human read the code, understood the diff, or approves the behaviour: the
identity is a claimed label, not an identity proof, and approval content is not
validated. The run process must still be configured so that the approver key
and directory are outside the agent's write reach; a same-UID approver is not a
boundary.

A new plan with `human-approved`/`ci-attested` refuses **before writing
anything** when the directory or approver key is missing
(`AUTH_APPROVAL_DIR` / `AUTH_APPROVAL_UNTRUSTED`). Manifests written by 0.10.1
and earlier (version 1) keep their old in-run `approvals/<run>.json` path
readable, but `final_verify` records `approval_unbound` and does not claim a
distinct principal for it.

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
   required and missing). A local file witness is detection-only; it shares the
   same UID.

The hardened profile is an administrator/deployment change (a system service,
separate UID, SELinux labels, or a remote approver). The plugin cannot create
that boundary in-process.

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
| `OPENCODE_TEAMWORK_WITNESS_TIMEOUT_MS` | Witness timeout (default 5000, max 60000). |
| `OPENCODE_TEAMWORK_APPROVAL_DIR` | Absolute approval directory outside the run and repo, owned by a different UID. Required for `human-approved`/`ci-attested`. |
| `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` | SPKI Ed25519 public key of the approver (verify-only). Pinned as `approvalKeyId` at plan time. |
| `OPENCODE_TEAMWORK_APPROVAL_KEY_ID` | Optional approval key id; defaults to a digest of the approval public key. |
| `OPENCODE_TEAMWORK_APPROVAL_TTL_MS` | Default approval lifetime when `expiresAt` is omitted (24 h; max 7 days). |

The command signer receives `{v, alg, keyId, path, digest, nonce, at, message}`
and must return `{alg: "ed25519", keyId, sig}`. The plugin verifies the returned
signature with the configured public key before accepting it. A configured but
unavailable, malformed, timing-out, or non-verifying signer fails closed with
`AUTH_SIGNER_UNAVAILABLE`; it never falls back to the local HMAC key.

## Residual risks

- **Same-UID key access.** A local HMAC or Ed25519 private key is only as secret
  as the process UID. Only a different privilege domain (separate UID, KMS/HSM,
  hardware token) changes that.
- **Command signer is only non-oracle if external.** A signer reachable by the
  agent's UID can be called by any same-UID process. Its policy, not its
  location, is what makes it meaningful.
- **Nonce and index storage.** The nonce, key-id pin, and digest index live in
  plugin storage. A same-UID writer can rewrite them; the witness is the
  optional cross-check.
- **Approval artifact.** `approvals/<runId>.json` is verified with the
  configured approval key. With `local-hmac`, a same-UID writer can mint a run
  envelope; that is why 0.10.2 requires an Ed25519 approver key distinct from
  `runKeyId` and an approval directory owned by another UID. The approval proves
  which configured key signed which manifest digest; it does not prove the
  approver's real-world identity, that a human read the change, or that the
  approval content is accurate.
