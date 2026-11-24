# ADR 0018: CI Attestation and the Second Principal

- **Status:** Accepted (0.18.0)
- **Date:** 2026-11-24
- **Scope:** `plugins/opencode-teamwork/attestation.mjs`,
  `plugins/opencode-teamwork/{auth.ts,approval-format.mjs,tools.ts}`,
  `lib/verify.mjs`, `lib/security.mjs`, `bin/opencode-teamwork.mjs`,
  `scripts/attest-sign.mjs`, `.github/workflows/attest.yml`,
  `scripts/test-{engine,verify}.mjs`, `tests/runtime/`,
  `docs/ARTIFACTS.md`, `SECURITY.md`, `README.md`
- **Extends:** [ADR 0016](0016-re-executable-verification.md) (re-execution),
  [ADR 0015](0015-offline-verification.md) (offline verification),
  [ADR 0011](0011-authenticated-prompt-approval.md) (distinct-principal
  approval), [ADR 0008](0008-signer-spi-and-trust-levels.md) (key sources)
- **Related:** [ADR 0006](0006-artifact-trust-isolation.md) (one UID is not a
  boundary), [ADR 0013](0013-containment-parity-and-the-detective-boundary.md)

## 1. Context

0.16.0 made a verifier report's command evidence re-executable, but the run
still has only one signing principal: the key the agent's process holds. The
engine can authenticate that a report says `npm test` exited 0, and
`verify --rerun` can re-run it against the observed commit. It cannot show that
anyone outside the agent's process observed the same commit, the same plan, and
the same output.

A CI job is the natural second observer. The security value is not "CI ran a
test" — a local shell can run the same command. It is that a **key the run does
not hold** signs a statement about the run, and that statement is bound to the
signed manifest, the report's commit, and the report's command outputs. If the
key is reachable by the agent's UID, it is not a second principal; that remains
a documented residual.

## 2. Decision

### 2.1 The artifact

`verify/ci/attestation.json` is an `_auth`-signed Ed25519 document:

```json
{
  "v": 1,
  "provider": "github-actions",
  "workflow": "ci-attestation",
  "runId": "20261124-120000-abcd",
  "runAttempt": 1,
  "repository": "owner/repo",
  "commitSha": "<40/64-hex git id>",
  "baseSha": "<40/64-hex git id | ''>",
  "promptHash": "<sha256 of prompt_draft.md>",
  "planHash": "<the signed manifest planHash>",
  "manifestDigest": "<payload digest of run.manifest.json>",
  "commands": [
    {
      "argv": ["npm", "test"],
      "cwd": ".",
      "exitCode": 0,
      "outputSha256": "<unkeyed sha256 of stdout+stderr bytes>",
      "outputBytes": 8421
    }
  ],
  "oidc": { "issuer": "...", "subject": "...", "audience": "..." },
  "issuedAt": "ISO8601",
  "expiresAt": "ISO8601",
  "_auth": {
    "v": 1,
    "alg": "ed25519",
    "keyId": "attestation_...",
    "path": "verify/ci/attestation.json",
    "digest": "<sha256 of the canonical payload without _auth>",
    "sig": "<base64url Ed25519>",
    "nonce": "<the run manifest runNonce>",
    "at": "ISO8601"
  }
}
```

The envelope is the existing v1 `_auth` shape. The signed bytes use a dedicated
domain separator, `teamwork-ci-attestation-v1`, so a CI signature cannot be
replayed as a run artifact, a witness receipt, or an approval. `nonce` is the
signed manifest's `runNonce`; `runId` and `planHash` bind the run. The
`manifestDigest` field is an additive binding to the exact signed manifest
bytes; it is not required by the verifier because `planHash`/`nonce` already
bind the run.

`outputSha256` is **unkeyed**, matching `verify/rerun.json`, and covers the
same `stdout+stderr` bytes. The verifier recomputes it from the report's
untruncated `output`; a truncated report check cannot be attested.

### 2.2 Manifest version 5

`run.manifest.json` v5 adds:

- `attestationPolicy: "off" | "optional" | "required"` (default `off`);
- `attestationKeyId: string | null` (optional pin);
- `attestationIssuer: string | null` (optional pin).

Versions 1–4 read as `off`. The policy and both pins are recorded in
`plan.dag.json` and `state.json` and are part of the plan baseline when the
policy is not `off`. A re-plan may move `off → optional → required` (and set
pins), never the reverse nor change a pinned value; each is `AUTH_STALE`.
`final_verify` re-checks all three against the signed manifest.

### 2.3 Policy matrix

| Policy | Artifact | Public key | `final_verify` | `verify` CLI |
| --- | --- | --- | --- | --- |
| `off` | any | any | ignored; no evidence | `attestation.status: "OFF"` |
| `optional` | missing | any | PASS; status `MISSING` | skip |
| `optional` | present, valid | supplied | PASS; status `ATTESTED` | PASS, `attested: true` |
| `optional` | present, invalid | supplied | PASS; status `INVALID` | WARN, `attested: false` |
| `optional` | present | missing | PASS; status `UNKNOWN` | UNKNOWN (exit 2) |
| `required` | missing | any | FAIL `AUTH_ATTESTATION_MISSING` | FAIL (key) / UNKNOWN (no key) |
| `required` | present, valid | supplied | PASS; status `ATTESTED` | PASS, `attested: true` |
| `required` | present | missing | FAIL `AUTH_ATTESTATION_UNTRUSTED` | UNKNOWN (exit 2) |
| `required` | present, invalid | supplied | FAIL with the named code | FAIL |

Without `--attestation-public-key`, the verifier never promotes an attestation
to `PASS`: a present artifact is `UNKNOWN` (exit 2), and `optional` records it
as a warning.

### 2.4 Binding rules

A valid attestation must satisfy all of:

1. `_auth` verifies under the configured **attestation** public key; the key id
   matches the manifest pin or the key's derived id.
2. `_auth.keyId !== manifest.runKeyId`: a run-key signature is
   `AUTH_ATTESTATION_UNTRUSTED` even if it verifies.
3. `_auth.nonce === manifest.runNonce` and `runId === <run>`; otherwise
   `AUTH_ATTESTATION_REPLAY`.
4. `planHash === manifest.planHash`, `promptHash === manifest.specHash` when the
   manifest pins one, `expiresAt` is in the future; otherwise
   `AUTH_ATTESTATION_STALE`.
5. `oidc.issuer`, when pinned, matches; otherwise `AUTH_ATTESTATION_UNTRUSTED`.
6. `commitSha === report.headSha` for every report with a head; otherwise
   `AUTH_ATTESTATION_COMMIT_MISMATCH`.
7. Every attestation command matches a report `checks[]` entry by argv, cwd,
   exit code, unkeyed output digest and byte count; otherwise
   `AUTH_ATTESTATION_STALE`.

### 2.5 Verifier and doctor

`opencode-teamwork verify` gains:

```
--attestation-public-key <b64url|@file>
--attestation-key-id <id>
--attestation-issuer <issuer>
```

`--json` always includes `attestation: {status, commitSha, keyId, issuer}` and
`attested: boolean`. `final.json.evidence.attestation` records the policy plus
the same status/commitSha/keyId/issuer fields. `doctor --security` reports
`attestation_key`: a verify-only Ed25519 key is a pass; visible private
material is a fail; `required` with no key is a warning.

### 2.6 Producer and CI template

`scripts/attest-sign.mjs` is a dev/CI-only producer with no runtime dependency.
It signs the documented payload with `--key` (PKCS#8 Ed25519) and writes
atomically with mode 0600. It never runs a command and never uses the network;
the CI job runs the command and hands over its output digest. `--manifest`
cross-checks the nonce, plan hash, prompt hash and manifest digest, so a
dispatcher cannot invent a binding.

`.github/workflows/attest.yml` is a `workflow_dispatch` template with only
`run_id` and `manifest_digest` as required inputs. It is gated on
`github.ref_protected` and the default branch, uses a literal test command from
that protected checkout, passes inputs through environment variables (never a
shell line), and signs with an environment secret. A dispatch cannot select
arbitrary code, a ref, or a command; the run manifest must already be present
in the protected checkout. The workflow comments state the residual: a
compromised runner, a key readable by the agent, a weak suite, or a test edited
in the same commit still produces a valid attestation.

## 3. What this establishes and what it does not

Establishes: the declared commands ran at the recorded commit, with the
recorded output digests, under a **separate signing identity** that also bound
the signed plan and the run nonce.

Does not establish:

- that the suite is meaningful (`npm test` may be `true`), or that a test was
  not edited in the same commit;
- that the CI host or runner was not compromised;
- that the CI principal is unreachable by the agent's UID. A repository secret
  or key file readable by that UID makes the "second principal" nominal; the
  attestation then proves only the binding, not independence. This is the
  central residual in `SECURITY.md`.
- that the OIDC claims are true unless the issuer itself is trusted. The
  verifier checks the signed `oidc.issuer` pin; it does not fetch or validate a
  token.

## 4. Consequences

- A `required` run cannot complete without a second-key signature over the
  signed plan, the report's commit, and the report's command outputs.
- Existing runs are unaffected: versions 1–4 are `off`, and `off` ignores the
  artifact even if one is present.
- The engine still never executes an attested command; `final_verify` and
  `verify` only check the cryptographic and structural binding. Re-execution
  remains `verify --rerun`.
- A verifier needs one public key and the run bytes. The producer needs the CI
  private key and the manifest; neither needs the run key.
