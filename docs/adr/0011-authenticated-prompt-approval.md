# ADR 0011: Authenticated Prompt Approval

- **Status:** Accepted (0.11.0 workstream)
- **Date:** 2026-11-23
- **Scope:** `plugins/opencode-teamwork/tools.ts`,
  `plugins/opencode-teamwork/auth.ts`,
  `plugins/opencode-teamwork/approval-format.mjs`,
  `plugins/opencode-teamwork/safe-fs.mjs` (`bytes`), `lib/approve.mjs`,
  `bin/opencode-teamwork.mjs`, `lib/security.mjs`, `scripts/test-approval.mjs`,
  `scripts/approval-driver.mjs`
- **Extends:** [ADR 0005](0005-artifact-authenticity.md) (envelope + index),
  [ADR 0008](0008-signer-spi-and-trust-levels.md) (trust levels and the
  approval artifact)
- **Related:** [ADR 0006](0006-artifact-trust-isolation.md) (why one UID is not
  a boundary), [ADR 0010](0010-pinned-fd-write-containment.md) (pinned writes)
- **Supersedes:** the manifestDigest-bound approval semantics of version 2 for
  version-3 runs. Version 1/2 runs remain readable.

## 1. Context

0.10.2 made `human-approved`/`ci-attested` meaningful: the approval must come
from an external directory owned by another UID, be signed by an Ed25519 key
distinct from `runKeyId`, be fresh, and carry a `uid:`/`oidc:`/`ci:` identity.
It also bound the approval to the **signed manifest digest**.

That still left the central interview-gate gap unclosed:

1. the approval was bound to the manifest, not to the text being planned;
2. nothing produced approvals — an agent could only ask a human to write a
   file by hand;
3. the approval nonce could be replayed;
4. the plan did not check that the approved text was the text it was about to
   plan, and `final_verify` never re-read the draft.

The observed interview gate ([`docs/re/antigravity-teamwork/14`](../re/antigravity-teamwork/14-interview-gate-observed.md))
shows the procedural shape: an interviewer writes a gap-marked draft, a relay
collects answers, the draft is resolved, and an `Approved task prompt:`
message precedes `ORIGINAL_REQUEST.md`. That message is text, not proof. The
engine needs an artifact whose bytes and run are fixed before planning.

A version-2 approval also cannot be produced before the plan: its
`manifestDigest` depends on `planHash`, which depends on the plan. The producer
had to run after planning, so it could not gate the plan at all.

## 2. Decision

### 2.1 Manifest version 3

`RUN_MANIFEST_VERSION` becomes 3; versions 1, 2, and 3 are readable.

New signed fields (present for a version-3 plan when applicable):

| Field | Meaning |
| --- | --- |
| `specHash` | **unkeyed SHA-256 of the exact `prompt_draft.md` bytes** (`contentSha256Hex`), or `null` |
| `specBytes` | byte length of the draft, or `null` |
| `approvalDigest` | `payloadDigest(approval)` (canonical payload without `_auth`) |
| `approvalNonce` | the approval's one-use nonce |
| `approvalBinding` | literal `"prompt"` |
| `approvedBy` | the `approvedBy`/`attestedBy` label from the approval |
| `approvedAt` | the approval's ISO timestamp |

`specHash` is recorded for any version-3 plan with a draft, including
`local-hmac` runs: editing the planned text later is `AUTH_STALE` for every
trust level, not only approval runs. The approval fields are recorded only when
`trustLevel` requires an approval.

`manifestDrift` compares all of these fields. A re-plan that changes them is
`AUTH_STALE`. For a version-3 approval run, `final_verify`'s drift comparison
intentionally defers to the trust gate so the named
`AUTH_APPROVAL_STALE`/`_INCOMPLETE`/`_REPLAY` failure is reported instead of a
generic drift.

`approvalPolicyFor` compares against version 2 (`APPROVAL_EXTERNAL_MIN_VERSION`),
not the current version, so bumping to 3 does not turn version-2 runs into
in-run-legacy runs.

### 2.2 The approval artifact

`approvals/<runId>.json` is unchanged in location (external directory, regular
file, different owner) and envelope format, but version-3 payloads carry:

```json
{
  "v": 1,
  "runId": "…",
  "trustLevel": "human-approved | ci-attested",
  "binding": "prompt",
  "promptDraftSha256": "…",
  "promptDraftBytes": 2089,
  "openGaps": 0,
  "approvalNonce": "base64url, ≥128 bits",
  "approvedAt": "…",
  "expiresAt": "…",
  "planHash": null,
  "approvedBy": "uid:… | oidc:…#… | ci:…",
  "_auth": { "alg": "ed25519", "…": "…", "nonce": "equals approvalNonce" }
}
```

`ci-attested` uses `attestedBy`. The manifest records `approvalDigest`, so the
approval does **not** include a manifest digest; that removes the circular
dependency and lets the producer run before the plan. `planHash` is an optional
pre-commitment to an existing plan baseline; `null` means "any plan for this
exact draft".

### 2.3 Plan-time verification order

`teamwork_plan` performs these checks after the spec presence gate and before
any `mkdir`, preflight artifact, `beforeMkdir` writer, or state write:

1. resolve `OPENCODE_TEAMWORK_APPROVAL_DIR` (absolute, real directory, outside
   run/repo, not owned by this UID) and the pinned approver key;
2. read `prompt_draft.md` through the bounded no-follow run reader, hash the
   exact bytes, count `[OPEN:` gaps;
3. read the approval without following symlinks and verify the Ed25519
   envelope with the configured approval public key;
4. require the key to be distinct from `runKeyId` and equal to the pinned
   `approvalKeyId`;
5. require `runId`, `trustLevel`, `binding: "prompt"`,
   `promptDraftSha256 === current hash`, `promptDraftBytes === current size`,
   `openGaps === 0`, no remaining `[OPEN:`, and an unused
   `approvalNonce` that equals `_auth.nonce`;
6. require a fresh `approvedAt`/`expiresAt` and (if non-null) a `planHash`
   equal to the existing plan baseline.

Failures are named `AUTH_APPROVAL_INCOMPLETE`, `AUTH_APPROVAL_STALE`,
`AUTH_APPROVAL_MISSING`, `AUTH_APPROVAL_UNTRUSTED`,
`AUTH_APPROVAL_NOT_HUMAN`, or `AUTH_APPROVAL_REPLAY`. A refusal leaves no run
directory.

`final_verify` repeats the draft hash/size, approval digest, nonce, approver,
and freshness checks against the manifest and then requires the approval to be
live. A prompt-bound approval is issued before the plan, so the version-2
"`approvedAt >= manifest.createdAt`" rule is replaced by "still live when the
manifest was written".

### 2.4 Replay control

`approvalNonce` must be at least 128 bits of base64url and equal `_auth.nonce`.
After every plan-time refusal path passes, the plugin consumes it once per run
and stores `{approvalNonce, approvalDigest, planHash, at, runId}` at
`ctx.storage` key `auth/approval/<runId>/consumed`, under the in-process plan
lock. A later plan presenting a different nonce is `AUTH_APPROVAL_REPLAY`; the
same nonce and digest is idempotent (a legitimate re-plan), and the record's
`planHash` is filled in when the plan object exists. `planHash` is therefore
recorded, not a new gate.

The plan lock is the existing in-process queue plus the storage read/write. A
cross-process plan race on the same run is bounded by signed-manifest drift and
the single artifact path; it is a residual (see §5).

### 2.5 Producer CLI

`lib/approve.mjs` is wired into `bin/opencode-teamwork.mjs` as
`opencode-teamwork approve`:

- `approve request --session <runId> [--json] [--trust …] [--approver …]
  [--ttl …] [--out <file>]` prints the draft digest, byte count, `[OPEN:`
  count, the observed (unverified) manifest digest, the current plan hash, and
  the exact payload that will be signed. `--out` writes that untrusted request;
  nothing trusted is written.
- `approve sign --request <file|-> --draft <path> [--key <path>] [--ttl 24h]
  [--approver uid:…|oidc:…|ci:…] [--allow-open]` re-hashes the draft's raw
  bytes, refuses a request built for different bytes, refuses remaining
  `[OPEN:` unless `--allow-open` records the count, requires the operator to
  retype the first 8 hex characters of the digest and type `approve`, then
  writes the Ed25519 approval atomically with mode `0600` into
  `OPENCODE_TEAMWORK_APPROVAL_DIR`. A symlinked target is refused.
- `approve verify --session <runId> [--json]` re-runs the binding checks and
  prints them. It reports the approval directory owner but treats same-UID as a
  warning (the plan gate is the enforcement point), and it never claims a human
  read the draft.

The signer key comes from `--key <path>`, `OPENCODE_TEAMWORK_APPROVAL_KEY_FILE`,
or `OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY` (PKCS#8, base64url). The key id is
`OPENCODE_TEAMWORK_APPROVAL_KEY_ID` or the same SPKI-derived
`approval_<digest>` the plugin computes, so the pinned `approvalKeyId` agrees
without configuration.

### 2.6 Signer scope

`signArtifact`, `signRunArtifact`, and therefore the command signer refuse any
`relPath` equal to or starting with `approvals/` (`AUTH_APPROVAL_SCOPE`). The
approval CLI does not use the plugin signer; it holds the approver key
directly. This is a static refusal, not a configuration choice.

### 2.7 Doctor

`doctor --security` additionally reports:

- `approval_key`: whether a verify-only approver key is configured (and
  whether signer material is visible to this UID);
- `approval_signer_scope`: whether a configured command signer could be asked
  to sign an `approvals/` path (the plugin signer always refuses; an external
  signer's policy is reported as not inspectable).

`approval_dir` continues to report the absolute path and owner.

### 2.8 Bytes, not re-encoded text

`prompt_draft.md` is hashed from the exact bytes read by the bounded reader.
`safe-fs` now returns `bytes` alongside the UTF-8 `text`, so a digest never
depends on a lossy decode/re-encode. `specHash` is named unkeyed SHA-256 to
distinguish it from the keyed artifact `digest`.

## 3. Boundary

**Newly possible:** a human or CI principal outside the agent's process can
produce an approval over the exact draft bytes and this run, before planning;
the plugin verifies it with a public key, refuses an HMAC/run-key signature and
the plugin/command signer, consumes a one-use nonce, and re-hashes the draft at
completion. A re-plan or a post-approval draft edit cannot silently rebind.

> `human-approved` means the approval artifact verifies under an Ed25519 key
> the agent's process does not hold and cannot ask to sign, and is bound to the
> exact bytes of prompt_draft.md and this run. It does not establish that a
> human read the draft, that the displayed text matched the bytes hashed, or
> that the approver understood it. Treat it as provenance, not comprehension.

**Still not protected:** a same-UID process (it cannot satisfy the
different-owner rule and can read a local key), an approver process that signs
without reading, a display/renderer that shows different bytes than it hashes,
a malicious plugin/config, root, or denial of service. `approvedBy` is a claimed
label; the CLI's typed confirmation is not human-presence enforcement.

## 4. Consequences

- New approvals are produced before the plan and cannot be reused for another
  run, another draft, or a replay.
- A version-3 plan with a draft is immutable in its spec bytes; a deliberate
  spec change means a new run (or, for approval runs, a fresh approval and a
  re-plan that presents the same approval digest, which the drift check then
  compares).
- Version-1/2 runs keep their old semantics: v1 in-run approvals remain
  readable and are recorded as `approval_unbound`; v2 keeps the
  manifestDigest-bound approval and `approvedAt >= createdAt` rule.
- `local-hmac`, `external-signer`, and `allowUnsignedLegacy` are unchanged.
- The approval producer is a standalone CLI and cannot be reached through an
  agent tool. An agent can run the CLI only if it has shell, but it still does
  not hold the approver key or write to the different-UID directory.

## 5. Residuals

- **Approval content is a name, not a proof.** `approvedBy` is not an identity
  assertion beyond the configured key; a compromised approver signs anything.
- **Display spoofing.** The CLI hashes bytes on disk; it cannot prove the
  approver's review surface showed those bytes.
- **Same-UID key.** A single-UID deployment cannot satisfy the ownership rule;
  a local approver key is readable by that UID. The hardened profile still
  needs a separate UID/KMS/HSM or a remote approver service.
- **No human-presence enforcement.** The typed digest prefix and `approve`
  word are friction, not proof; a script with the key reproduces both.
- **Cross-process consumption race.** `ctx.storage` has no compare-and-swap.
  The in-process lock serialises this process; two processes planning the same
  run with different nonces are additionally bounded by the signed manifest
  (only one baseline can be written and read). Treat the consumed record as a
  replay *detector*, not a distributed mutex.
- **Expiry vs. run duration.** A prompt approval must still be live at
  `final_verify`; a long run needs a TTL chosen accordingly (max 7 days).

## 6. Acceptance evidence

`scripts/test-approval.mjs` covers the print-mode reference ordering (one
process per turn, disk-only state), the TUI single-process case where an
in-memory flag cannot replace the file, removal between turns, the full
approved flow to `final_verify` PASS, `approve verify` agreement, and the
negative set: no approval, edited draft, another run's approval, HMAC approval,
run-key approval, expired, replayed nonce, remaining `[OPEN:`, a bare
`team/...` approver, an in-run approval, a wrong `planHash`, and every tampered
binding field. It also covers `AUTH_APPROVAL_SCOPE` for local, run-artifact and
command signers, v1/v2 readability, `local-hmac`, `allowUnsignedLegacy`, and
`ci-attested`. `scripts/test-engine.mjs` covers the prompt-bound trust levels,
the `run_created` approval summary, and the v3 manifest fields;
`scripts/test-auth.mjs` and `scripts/test-security.mjs` remain green.
