# ADR 0008: Signer SPI and Artifact Trust Levels

- **Status:** Accepted (0.9.0 workstream A)
- **Date:** 2026-11-23
- **Scope:** `plugins/opencode-teamwork/auth.ts`, `tools.ts`, `victory.ts`,
  `strict.ts`, `lib/security.mjs`, `bin/opencode-teamwork.mjs`,
  `scripts/lint-security-claims.mjs`
- **Extends:** [ADR 0005](0005-artifact-authenticity.md) (envelope, digest index,
  signed baseline)
- **Related:** [ADR 0006](0006-artifact-trust-isolation.md) (why a same-UID
  signer is not a boundary), [ADR 0007](0007-signed-handoff-provenance.md)
  (sibling extension: signed handoff provenance)
- **Supersedes:** ADR 0005 §4 option 4 (asymmetric signatures) and option 5
  (witness) as *unimplemented* options; the Phase A boundary itself is unchanged.

## 1. Context

ADR 0005 made control-plane artifacts tamper-evident against a writer limited to
the run directory using HMAC-SHA256 envelopes and a storage-backed digest index.
Its explicit residual was that verification needed the same secret as signing:
a same-UID process that could read `opencode.db` could mint a valid envelope.
ADR 0006 assessed key isolation and concluded that moving a *same-UID* signer is
not a boundary, but that an asymmetric key plus a no-oracle policy (human
presence or an independent verifier) is the only worth-building direction.

Two gaps remained even for honest deployments:

1. **No public-key verification.** A CI verifier, a read-only mirror, or a
   separate approval service could not check an artifact without holding the
   HMAC secret.
2. **No declared trust contract.** A run could be planned with a local HMAC key
   and completed as if it had an external signer. Nothing recorded or enforced
   what level of assurance the run asked for.

This ADR implements the small, useful part of ADR 0006's recommended order —
Ed25519 envelopes and public-key verification — and the out-of-process signer
interface with fail-closed behaviour. It deliberately does **not** claim that a
same-UID signer is a boundary; the policy half (ADR 0006 step 3) is represented
by `human-approved`/`ci-attested` artifacts and can be supplied by an external
approver.

## 2. Decision

### 2.1 Envelope algorithms

`_auth` keeps the ADR 0005 fields and adds an algorithm discriminant:

- HMAC: `{v, alg: "hmac-sha256", keyId, path, digest, mac, [nonce], at}`
- Ed25519: `{v, alg: "ed25519", keyId, path, digest, sig, nonce, at}`

`digest` remains `sha256(canonicalJson(payload without _auth))`. HMAC keeps
`mac = HMAC-SHA256(key, canonicalJson(envelope without mac))` and
`timingSafeEqual`, so existing HMAC envelopes remain verifiable.

Ed25519 signs the domain-separated UTF-8 input:

```
"teamwork-artifact-v1" \0 alg \0 keyId \0 path \0 nonce \0 canonicalJson(payload without _auth)
```

The key ring at `auth/key/ring` accepts entries with
`alg: "hmac-sha256" | "ed25519"`. An Ed25519 entry stores a PKCS#8 private key
(base64url) and/or an SPKI public key (base64url); a public-only entry is valid
for verification. The environment overrides are
`OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY`, `OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY`
and `OPENCODE_TEAMWORK_ED25519_KEY_ID`. `rotate("ed25519")` creates a fresh
Ed25519 ring entry; retired keys remain verifiable up to the ring bound.

Verification of an Ed25519 envelope needs only the SPKI key. A private key is
never required to accept a verdict.

### 2.2 Per-run nonce and key-id pinning

Every new signed run generates a 128-bit `runNonce`
(`randomBytes(16).toString("base64url")`) and records it in the signed
`run.manifest.json`. The nonce and the plan-time `runKeyId` are bound in plugin
storage (`auth/run/<runId>/.nonce`, `.keyid`) and in the auth context. Every
artifact signed for that run carries the nonce and is verified against it; the
envelope key id must equal the pinned `runKeyId`.

Consequences:

- copying an artifact to another run fails the nonce check (and the index);
- re-signing it with a rotated key fails the key-id check;
- the manifest's own nonce/key id are re-bound on read, so a fresh process
  reconstructs the pin from the signed baseline;
- older HMAC runs without a manifest nonce keep verifying unchanged.

### 2.3 Command signer SPI

`OPENCODE_TEAMWORK_SIGNER=command:<absolute path>` selects an external signer.
The plugin spawns it with a fixed argv (no shell), sends one JSON request on
stdin, reads one JSON response on stdout, and enforces a timeout
(`OPENCODE_TEAMWORK_SIGNER_TIMEOUT_MS`, default 5000, max 60000).

Request: `{v, alg: "ed25519", keyId, path, digest, nonce, at, message}` where
`message` is the base64url signature input. Response: `{alg, keyId, sig}`.

The plugin requires `OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY` (SPKI base64url),
derives the expected key id from that key (or uses
`OPENCODE_TEAMWORK_SIGNER_KEY_ID`), rejects a response whose `alg` is not
`ed25519` or whose `keyId` differs, and verifies `sig` before accepting it. A
configured signer that is unavailable, malformed, times out, or returns a
non-verifying signature fails closed with `AUTH_SIGNER_UNAVAILABLE`. There is no
silent fallback to the local HMAC key.

A same-UID command signer is a signing oracle. Only a signer in a different
privilege domain, with a policy that refuses arbitrary caller-supplied payloads,
changes the ADR 0006 threat model.

### 2.4 Trust levels

`teamwork_plan` accepts `trustLevel`:

| Level | Persisted and enforced requirement |
| --- | --- |
| `local-hmac` (default) | Verified HMAC (or Ed25519) envelope and index entry. |
| `external-signer` | A verified non-HMAC envelope (Ed25519 from a local key or the command signer). An HMAC envelope fails `AUTH_TRUST_LEVEL`. |
| `human-approved` | A signed `approvals/<runId>.json` with `{runId, trustLevel, approvedBy, at, manifestDigest, _auth}` bound to this run and the current signed manifest digest. |
| `ci-attested` | The same artifact with `attestedBy` and `trustLevel: "ci-attested"`. |

The level is recorded in `plan.dag.json`, `state.json`, and the signed
`run.manifest.json`. A re-plan may repeat it but never change it
(`AUTH_STALE`). `final_verify` enforces it. Benchmark integrity refuses an
explicit `local-hmac` and warns on the default.

The approval artifact is verified with the configured key and the run's nonce
and key id. With `local-hmac`, a same-UID writer can mint it; the stronger
levels are meaningful only when the signer is external or the approval is
produced outside the run directory.

### 2.5 Optional witness

`OPENCODE_TEAMWORK_WITNESS=command:<absolute path>` or `http(s)://<url>`
configures a witness. On every signed run-artifact write the plugin appends
`{runId, path, digest, keyId, nonce, at}` and requires a non-empty `receipt` in
the response; the receipt is stored at `auth/witness/<runId>/<relPath>`. A
configured witness that is unavailable or malformed fails the write closed with
`AUTH_WITNESS_UNAVAILABLE`.

`teamwork_plan` accepts `requireWitness`. When true, `final_verify` requires a
receipt for the signed manifest and fails `AUTH_WITNESS_UNAVAILABLE` when it is
missing. A local file witness is detection-only: it shares the same UID and can
be rewritten.

### 2.6 Doctor and claim lint

`opencode-teamwork doctor --security` (and the additive `security` section in
`doctor --json`) reports the signing key source/algorithm, signer and witness
configuration, `ptrace_scope`, root-equivalent group membership (docker, wheel,
libvirt, sudo, lxd, disk, adm), the OpenCode DB mode, config/plugin writability
and SELinux. `ptrace_scope=0` and root-equivalent groups are warnings.

`scripts/lint-security-claims.mjs` fails the test chain on the four forbidden
marketing claims listed in the script when they appear in `README.md`,
`SECURITY.md` or `docs/`, unless the paragraph explicitly negates the claim (as
this ADR and ADR 0006 do). `SECURITY.md` states the boundary and the
single-UID/hardened decision tree.

## 3. Boundary

**Newly possible with only a public key:** verify a signed manifest, verifier
report, security audit, strict-wave verdict, victory verdict, final verdict, or
approval artifact for an Ed25519 run, including its path, digest, run nonce, key
id, and signature. A verifier can do this without the private key, without the
HMAC secret, and without trusting the signer's claimed algorithm/key id.

**Still not protected:** a same-UID process that can read the local private key
or call a same-UID signer; a rewritten index/nonce/key-id record; a modified
plugin/config; a prompt-injected agent; root; denial of service. See ADR 0006
and `SECURITY.md`.

## 4. Consequences

- Ed25519 is optional; HMAC runs and artifacts keep working, and no dependency
  was added (`node:crypto` and `node:child_process` only).
- A signed plan now writes a nonce and pins a key id; a fresh process rebuilds
  both from the signed manifest plus storage.
- A configured signer or witness becomes an availability dependency and fails
  closed, by design. Operators can omit them for local-first use.
- A re-plan cannot weaken the trust level or the witness requirement.
- `external-signer` alone is not a same-UID boundary. The hardened profile —
  separate UID/remote signer plus `human-approved`/`ci-attested` and a witness —
  is documented, not enforced by the plugin.

## 5. Acceptance evidence

`scripts/test-auth.mjs` covers Ed25519 sign/verify with a generated key, a
public-key-only verifier, wrong key and tampered payload rejection, HMAC
compatibility, nonce replay, key-id mismatch, cross-run copies, the command
signer (happy path, unavailable, malformed, timeout, bad signature, relative
path, missing public key), command/HTTP witnesses, and rotation.
`scripts/test-engine.mjs` covers trust-level enforcement (`external-signer`,
`human-approved`, missing approval, missing witness, benchmark refusal).
`scripts/test-security.mjs` covers doctor `--security`/`--json` and the claim
lint. All existing HMAC and engine suites remain green.

## 6. Amendment — 0.10.2 trust honesty

0.10.2 keeps the envelope, key ring, signer SPI and level names, and tightens
what the two policy levels actually establish:

- **Approval location.** Version 2 manifests (new plans) read
  `approvals/<runId>.json` only from `OPENCODE_TEAMWORK_APPROVAL_DIR`: an
  absolute real directory outside `<run>/` and the repo, owned by a different
  UID. A missing directory or approver key refuses the plan before any mkdir
  or state write (`AUTH_APPROVAL_DIR`, `AUTH_APPROVAL_UNTRUSTED`). Version 1
  manifests keep the in-run path readable and emit `approval_unbound`.
- **Approval principal.** The approval envelope must be Ed25519 and its
  `_auth.keyId` must not equal `runKeyId` (`AUTH_APPROVAL_NOT_HUMAN`). The
  verify-only approver public key is configured with
  `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY`; its key id is pinned as
  `approvalKeyId` in the signed manifest, next to `approvalPolicy`, and both are
  drift-checked.
- **Freshness and identity.** `approvedAt >= manifest.createdAt`; the lifetime
  defaults to 24 h (`OPENCODE_TEAMWORK_APPROVAL_TTL_MS`, max 7 d); stale or
  over-long approvals fail `AUTH_APPROVAL_STALE`. `approvedBy`/`attestedBy`
  must be `uid:<name>`, `oidc:<issuer>#<sub>`, or `ci:<workflow>`.
- **Honest scope.** The approval binds a distinct configured key to the exact
  signed manifest digest. It does not prove a human read the diff: the identity
  is a claimed name, and the approval body is not evidence of review.

The doctor half of this amendment is in § 2.6: knowable facts (`ptrace_scope=0`,
root-equivalent groups, caller-owned signer/approval paths, DB group/other bits,
non-pinned containment while asserting approval/witness) are `fail`, not
warning, and `doctor --security --require-hardened` exits 2 on `fail`/`unknown`.

## 7. References

- ADR 0005: artifact authenticity, canonical JSON, digest index, signed baseline.
- ADR 0006: same-UID isolation feasibility and the missing non-oracle primitive.
- ADR 0007: signed handoff provenance (sibling extension).
- `SECURITY.md`: threat model, trust levels, decision tree, residual risks.
- `plugins/opencode-teamwork/auth.ts`: key ring, envelope signing/verification,
  signer and witness adapters.
