# ADR 0014: Verifiable witness receipts and signer v2

- **Status:** Accepted (0.14.0)
- **Date:** 2026-11-24
- **Scope:** `plugins/opencode-teamwork/auth.ts`,
  `plugins/opencode-teamwork/approval-format.mjs`,
  `plugins/opencode-teamwork/tools.ts`, `lib/security.mjs`,
  `lib/approve.mjs`, `bin/opencode-teamwork.mjs`,
  `scripts/hardening-check.sh`, `scripts/test-auth.mjs`,
  `scripts/test-approval.mjs`, `scripts/test-security.mjs`,
  `docs/{SIGNER-PROTOCOL.md,ADMIN-HARDENING.md,ARTIFACTS.md,GUARDRAILS.md}`,
  `SECURITY.md`
- **Extends:** [ADR 0008](0008-signer-spi-and-trust-levels.md) (signer SPI and
  trust levels), [ADR 0011](0011-authenticated-prompt-approval.md) (approval
  producer and domain separation)
- **Related:** [ADR 0005](0005-artifact-authenticity.md) (envelope + index),
  [ADR 0006](0006-artifact-trust-isolation.md) (one UID is not a boundary),
  [ADR 0012](0012-evidence-binding-and-contradiction-detection.md) (evidence),
  [ADR 0013](0013-containment-parity-and-the-detective-boundary.md)
  (containment vs detection)

## 1. Context

Three gaps remained after 0.13.1:

1. **Witness receipts were opaque strings.** `OPENCODE_TEAMWORK_WITNESS`
   appended a receipt to `auth/witness/<runId>/<relPath>`, but nothing bound the
   receipt to the run, path, digest, nonce or time. A same-UID writer could put
   any string in the KV store and `requireWitness` would accept it. The witness
   was a liveness check, not evidence.
2. **The signer protocol was v1 in the plugin and v2 only on paper.** The
   request carried no `runId` and no approval reference, so a command signer
   could not distinguish the plugin's request from a same-UID shell asking for
   the same signature. `docs/SIGNER-PROTOCOL.md` specified v2, and
   `docs/ADMIN-HARDENING.md` showed a different approval filename
   (`<run>/approval.json`) than the protocol (`<run>/<sha256(path)>.json`);
   nothing produced the approval.
3. **`doctor --security` treated a visible approver private key as a note.** It
   passed `approval_key` whenever the public key existed, even when
   `OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY` was inline in the workload's
   environment or a key file was readable by the workload. It also had no probe
   for the signer approval directory.

## 2. Decision

### 2.1 Signed witness receipts

The witness request becomes:

```json
{"v":2,"runId":"…","path":"…","digest":"…","keyId":"…","nonce":"…","at":"…"}
```

A witness that is configured with `OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY`
(SPKI Ed25519, base64url; optional `_KEY_ID`) must return:

```json
{"receipt":"…","alg":"ed25519","keyId":"…","sig":"base64url 64-byte signature"}
```

`sig` is Ed25519 over the UTF-8 bytes of:

```text
teamwork-witness-v1\0<runId>\0<path>\0<digest>\0<nonce>\0<at>
```

The record stored at `auth/witness/<runId>/<relPath>` is
`{v:2, receipt, alg:"ed25519", keyId, sig, at, verified:true, record, recordedAt}`
when signed. Without a configured public key the receipt is stored with
`alg:"unverified"`, `verified:false`, and the plugin keeps 0.13 behaviour.

`final_verify` calls `verifyWitnessReceipt(runId, RUN_MANIFEST, {digest,
nonce})` when `requireWitness` is set. With a witness public key configured:

- a missing receipt is `AUTH_WITNESS_UNAVAILABLE`;
- a forged, foreign, or different-digest/nonce record is `AUTH_INVALID`;
- only a signature over this exact run, path, digest, nonce and signed `at` is
  `verified`.

Without a public key the receipt is labelled `unverified` in
`verify/final.json` evidence. That is detection-only: a local file/command
witness shares the same UID and cannot prove an event happened. The evidence
label is deliberately not `verified`.

### 2.2 Approval-key diagnostics

`doctor --security` now **fails** `approval_key` when approver private material
is visible to the process: an inline
`OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY`, or a key file readable by this euid.
The approver key must be usable only from `opencode-teamwork approve` under a
different principal. A public-key-only configuration passes; a missing public
key remains a warning (the trust level refuses at plan time).

A new `signer_approval_dir` check reports configured/unset and fails when
`OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` is relative, missing, a symlink, inside
the repository/run, or owned/writable by this UID.
`scripts/hardening-check.sh` adds read-only `signer_approval_dir` and
`agent_signer_approval_read` probes (the workload must not be able to read
signer approvals).

### 2.3 Signer protocol v2

When `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` is **set**, `signerEnvelope` sends:

```json
{"v":2,"op":"sign-artifact","runId":"…","alg":"ed25519","keyId":"…",
 "path":"…","digest":"…","nonce":"…","at":"…","approvalRef":"…","message":"…"}
```

`approvalRef` is derived only from trusted inputs:

```text
<OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR>/<runId>/<contentSha256Hex(path)>.json
```

`contentSha256Hex` is the **plain, unkeyed SHA-256** of the UTF-8 run-relative
path, not the keyed `payloadDigest`/`sha256Hex`. The run id must match
`^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`. The plugin never reads or verifies the
approval: the signer's policy is the boundary.

When the variable is **unset**, `signerEnvelope` sends the exact v1 request
`{v,alg,keyId,path,digest,nonce,at,message}` for byte-compatible back-compat.
`runId` is threaded through `signRunArtifact` → `signArtifact` as an optional
`SignOptions.runId` (additive, not a breaking required field).

A v2-only signer with a v1 request, or a v1-only signer with the directory set,
fails closed as `AUTH_SIGNER_UNAVAILABLE`; the plugin never falls back to the
local HMAC key. The directory itself must be absolute, an existing real
directory, and not owned by this process, or signing fails before any spawn.

### 2.4 Signer approval producer

`opencode-teamwork approve signer --session <runId> --path <relPath> --digest
<64hex> [--key <path>] [--ttl 1h] [--approver uid:<name>|oidc:…] [--out <dir>]`
writes one file per `(runId, path)` under the configured signer approval
directory, mode `0600`, atomically. The payload is:

```json
{"v":1,"kind":"teamwork.signer-approval","runId":"…","path":"…","digest":"…",
 "nonce":"<run nonce>","approvedAt":"…","expiresAt":"…","approvedBy":"…",
 "approvalId":"…","_auth":{"alg":"ed25519","keyId":"…","sig":"…"}}
```

The signature domain is:

```text
teamwork-signer-approval-v1\0<runId>\0<path>\0<digest>\0<nonce>\0<expiresAt>\0<canonicalJson(payload without _auth)>
```

`nonce` is the run nonce read from the run's signed
`run.manifest.json` — never a freshly invented value, which could not match the
plugin's request. The payload deliberately reuses no prompt-approval field
(`binding`, `trustLevel`, `promptDraft*`, `openGaps`, `approvalNonce`,
`planHash`). The CLI requires `--out` or the environment variable, refuses an
output inside the run/repository, and refuses a `--out` that differs from the
configured directory.

### 2.5 Documentation

`docs/SIGNER-PROTOCOL.md` and `docs/ADMIN-HARDENING.md` now state the same
layout: one file per `(run, path)` at `<DIR>/<runId>/<sha256(path)>.json` with a
**plain** SHA-256. `ADMIN-HARDENING.md` states that the signer is not in this
repository and must be built; the plugin only speaks the protocol.

## 3. Consequences

- A forged KV witness record is `AUTH_INVALID` at `final_verify`, not a pass.
  The receipt signature covers the run, path, digest, nonce and the witness's
  signed time, so a record copied to another path/digest/run fails.
- `requireWitness` with a configured witness key is a signature check; without
  one it remains the 0.13 detection-only behaviour and is labelled
  `unverified` in evidence.
- The plugin now has a v2 signer path that a policy-enforcing signer can
  implement; the signer still has to check the approval, audit, and refuse.
- Deployments that set the approval directory but keep a v1-only signer fail
  every signed write by design. There is no silent downgrade.
- `approve signer` gives an operator a repeatable way to produce the approval;
  a same-UID key holder can still produce one, so the directory owner and the
  signer policy remain deployment properties.

## 4. Residuals

- **Local witness is detection-only.** A local file/command witness shares the
  UID and can be written by the same process; even a signed receipt proves only
  that *a* configured witness key signed those fields, not that an independent
  observer saw the artifact. Only a witness in a different trust domain, with
  its public key pinned outside the workload, adds a boundary.
- **Signer policy is outside the plugin.** The plugin verifies the returned
  signature and the response shape; it does not verify the approval, the
  signer's checks, or the verdict. A malicious signer with the key can sign
  anything; a user-writable plugin can skip the signer.
- **No reference signer is shipped.** `docs/SIGNER-PROTOCOL.md` is a contract
  and test list; the signer must be built and installed by the administrator.
  There is no in-repo reference implementation to copy.
- **Same-UID approver key.** `approval_key` now fails when the key is visible,
  but a single-UID host cannot satisfy a different-principal approver. The
  producer still runs as whoever holds the key; the CLI's typed confirmation is
  not human-presence proof.
- **Containment.** This ADR does not change write containment; ADR 0010/0013
  still bound it (preventive only on Linux with pinned fds, detective
  elsewhere). The witness and signer are separate controls.
