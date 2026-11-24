# Signer protocol v2: from signing oracle to policy enforcement

**Status:** target contract for a policy-enforcing command signer. **The 0.13.0
plugin sends `v: 1` and does not send `runId` or `approvalRef`.** This document
specifies the v2 contract and the plugin change required to use it. A
v2-only signer is incompatible with an unmodified 0.13.0 plugin: it will refuse
every request, and every signed write will fail closed with
`AUTH_SIGNER_UNAVAILABLE`. Do not deploy the two halves separately.

The runbook that installs the service, key directory and approvals is
[docs/ADMIN-HARDENING.md](ADMIN-HARDENING.md). The artifact envelope and digest
index are in [docs/adr/0005-artifact-authenticity.md](adr/0005-artifact-authenticity.md);
the signer SPI is in [docs/adr/0008-signer-spi-and-trust-levels.md](adr/0008-signer-spi-and-trust-levels.md).

> **The policy lives outside the plugin.** The plugin can verify that a
> signature matches a configured public key. It cannot verify that the signer
> checked an approval, that a human was present, or that a verdict is true. A
> malicious signer holding the key can sign anything; a user-writable plugin can
> be edited to skip its own checks. The signer's policy and the external
> verifier's trust in the signer key are the boundary.

---

## 1. Why v1 is an oracle

The v1 request is:

```json
{"v":1,"alg":"ed25519","keyId":"…","path":"…","digest":"…","nonce":"…","at":"…","message":"…"}
```

It contains no `runId` and no reference to an approval. A v1 signer has no
basis on which to distinguish:

- the plugin signing a verdict after its gate passed; and
- a same-UID shell asking for a signature over any `(path, digest)` it likes.

If the signer merely checks the algorithm, key id and schema and then signs, it
is a signing oracle. Moving the key to another UID or another socket does not
change that: the agent and the shell are the same principal. v2 adds the
missing decision input — a separate approval bound to the exact `runId`, path,
digest and nonce — and requires the signer to check it every time.

A signer that accepts v1 alongside v2 re-opens the oracle for any caller that
sends v1. A v2 signer must refuse `v: 1` with `E_VERSION`.

---

## 2. Request

One JSON object on stdin, one JSON object on stdout, no shell, bounded size
(256 KiB is a reasonable maximum). The process exits non-zero on refusal or
error. `message` is base64url of the exact UTF-8 signature input; the signer
must not sign the JSON wording of the request.

```json
{
  "v": 2,
  "op": "sign-artifact",
  "runId": "r-01J8Z5K8V6Q9W2M4N7P3S6T8X0",
  "alg": "ed25519",
  "keyId": "signer_test",
  "path": "verify/victory.json",
  "digest": "ebafa7996580c7e8623f2eb09c1e32ae1c3f8cef511dc1a8552c1a15313810da",
  "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
  "at": "2026-11-23T12:00:00.000Z",
  "approvalRef": "/var/lib/teamwork-approvals/signer/r-01J8Z5K8V6Q9W2M4N7P3S6T8X0/9f2c….json",
  "message": "dGVhbXdvcmstYXJ0aWZhY3QtdjEAZWQyNTUxOQBzaWduZXJfdGVzdAB2ZXJpZnkvdmljdG9yeS5qc29uAEFBQUFBQUFBQUFBQUFBQUFBQUFBQUEAeyJraW5kIjoidGVhbXdvcmsudGVzdCIsIm4iOjEsInZlcmRpY3QiOiJQQVNTIiwieiI6Imxhc3QifQ"
}
```

| Field | Rule |
| --- | --- |
| `v` | Integer `2`. `1` or any other value is `E_VERSION`. |
| `op` | Exactly `"sign-artifact"`. Any other value is `E_OP`. |
| `runId` | The signed run id, matching `^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`. |
| `alg` | Exactly `"ed25519"`. |
| `keyId` | The signer's configured key id. The signer must not accept a caller-chosen key. |
| `path` | Run-relative artifact path: no leading `/`, no `..` segment, no empty segment, no NUL; not `approvals/` or `./approvals/` (`E_APPROVAL_SCOPE`). |
| `digest` | 64 lowercase hex characters; the keyed digest in §3. |
| `nonce` | The run nonce from the signed manifest; base64url, at least 16 decoded bytes. |
| `at` | ISO-8601 timestamp. **Not covered by the signature.** Use it only for a bounded clock-skew check; never as an authorization fact. |
| `approvalRef` | Absolute path to the signer approval in §4. Must resolve under the configured approval directory. |
| `message` | Base64url (no padding) of the exact signature input in §3. |

The request must be rejected if any field is missing, of the wrong type, or
outside its bound. Extra unknown fields are ignored only if the implementation
can prove they do not affect the signed message; rejecting them is safer.

---

## 3. The message and the digest

### 3.1 Signature input

The plugin builds this string and signs its UTF-8 bytes (the same construction
as ADR 0008):

```text
teamwork-artifact-v1\0ed25519\0<keyId>\0<path>\0<nonce>\0<canonicalJson(payload without _auth)>
```

- The separator is a single NUL byte (`0x00`).
- There are exactly **six** fields: domain, algorithm, key id, path, nonce,
  canonical JSON.
- `canonicalJson` is the plugin's canonical JSON: object keys sorted, no
  whitespace, JSON-string escaping. The artifact schema uses ASCII keys; a v2
  signer should reject a non-ASCII key to avoid a JS/Rust/Go sorting mismatch.
- A literal NUL cannot occur inside the canonical JSON: `JSON.stringify` and
  the canonicalizer escape it as `\u0000`. Splitting on NUL is therefore
  unambiguous.
- The plugin signs and verifies the **string**, not the base64url rendering.
  Decode `message`, validate UTF-8, and sign those bytes.

### 3.2 Keyed digest

`digest` is not a plain SHA-256 of the payload. It is the plugin's
`payloadDigest`:

```text
HMAC-SHA256(
  key     = ASCII bytes "teamwork-artifact-digest-v1",
  message = UTF-8 canonicalJson(payload without _auth)
)
```

encoded as 64 lowercase hex characters. The label is a public domain-separation
value, not a secret. The signer must recompute this from the canonical JSON
field in the message, then compare the recomputed value in constant time with
the request's `digest`. Separately, it must require the re-canonicalised JSON to
be byte-identical to field 6; that catches non-canonical input before the digest
comparison. The signer must not trust the request's `digest` without
recomputation.

### 3.3 Test vector

This vector is generated from `plugins/opencode-teamwork/approval-format.mjs`.
It is a test vector, not a production artifact.

Payload (without `_auth`):

```json
{"kind":"teamwork.test","n":1,"verdict":"PASS","z":"last"}
```

`path = "verify/victory.json"`, `nonce = "AAAAAAAAAAAAAAAAAAAAAA"`,
`keyId = "signer_test"`.

```text
canonicalJson:
{"kind":"teamwork.test","n":1,"verdict":"PASS","z":"last"}

digest:
ebafa7996580c7e8623f2eb09c1e32ae1c3f8cef511dc1a8552c1a15313810da

message (UTF-8, NUL shown as \0):
teamwork-artifact-v1\0ed25519\0signer_test\0verify/victory.json\0AAAAAAAAAAAAAAAAAAAAAA\0{"kind":"teamwork.test","n":1,"verdict":"PASS","z":"last"}

message (base64url):
dGVhbXdvcmstYXJ0aWZhY3QtdjEAZWQyNTUxOQBzaWduZXJfdGVzdAB2ZXJpZnkvdmljdG9yeS5qc29uAEFBQUFBQUFBQUFBQUFBQUFBQUFBQUEAeyJraW5kIjoidGVhbXdvcmsudGVzdCIsIm4iOjEsInZlcmRpY3QiOiJQQVNTIiwieiI6Imxhc3QifQ
```

A signer that does not reproduce this vector byte-for-byte is not compatible.

---

## 4. The approval artifact

A signer approval is a separate Ed25519 artifact, owned by a principal other
than the workload, stored under the configured approval directory. It is not the
same artifact as the prompt approval used by `human-approved`/`ci-attested`
(ADR 0011), though it may use the same approver key.

### 4.1 Location and ownership

- `approvalRef` is absolute and must resolve under the signer's configured
  approval directory (for example `/var/lib/teamwork-approvals/signer/`).
- The directory and file must be owned by the configured approver UID (or, at
  minimum, not by the workload UID). The runbook uses a dedicated
  `teamwork-approver`.
- The file is a regular file, not a symlink, at most 64 KiB, mode `0640` with a
  group the signer can read. The workload must not be in that group.
- The filename is not a policy input. The signed payload binds the policy
  fields; a copied file with the same fields is the same authorization.

### 4.2 Payload

```json
{
  "v": 1,
  "kind": "teamwork.signer-approval",
  "approvalId": "b7Q…base64url at least 16 bytes…",
  "runId": "r-01J8Z5K8V6Q9W2M4N7P3S6T8X0",
  "path": "verify/victory.json",
  "digest": "ebafa7996580c7e8623f2eb09c1e32ae1c3f8cef511dc1a8552c1a15313810da",
  "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
  "approvedAt": "2026-11-23T11:55:00.000Z",
  "expiresAt": "2026-11-24T11:55:00.000Z",
  "approvedBy": "uid:approver",
  "note": "optional text; not a policy input",
  "_auth": {
    "alg": "ed25519",
    "keyId": "approval_…",
    "sig": "base64url Ed25519 signature"
  }
}
```

`approvedBy` must match `uid:<name>`, `oidc:<issuer>#<sub>`, or
`ci:<workflow>`. It is a claimed label, not an identity proof. `note` is
optional and covered by the signature but is not used for authorization; do not
let free text change a decision.

### 4.3 Approval signature input

Use a distinct domain so an artifact signature can never be reused as an
approval (or the reverse):

```text
teamwork-signer-approval-v1\0<runId>\0<path>\0<digest>\0<nonce>\0<expiresAt>\0<canonicalJson(approval payload without _auth)>
```

The signature is Ed25519 over the UTF-8 bytes of that string, verified with the
configured approver public key. `_auth.keyId` must equal the configured
approver key id. The approval `_auth` is not an artifact envelope; it uses the
domain above, not the artifact domain. The `approvedAt` field is inside the
canonical payload and is therefore signed; `expiresAt` is both signed and
separately compared. An approval with an unknown `kind`, a missing field, an
HMAC `_auth`, a different domain, or a different approver key is
`E_APPROVAL_SIG` or `E_APPROVAL_BINDING`.

### 4.4 Replay and expiry

- `runId`, `path`, `digest` and `nonce` must equal the request exactly.
- `expiresAt` must be in the future at signing time; `approvedAt` must not be
  in the future beyond a small skew. The lifetime is bounded (24 hours by
  default; 7 days maximum, matching the approval TTL policy).
- A replay of the **same** approval for the **same** `(runId, path, digest,
  nonce)` is idempotent: it authorizes the same artifact again. A replay for a
  different path or digest fails the binding check.
- If the deployment needs a strict single-use decision, the signer keeps a
  durable ledger keyed by `approvalId` (and a hash of the request) and refuses a
  different request that reuses it. That ledger is signer state; a crash must
  fail closed, not reset the ledger silently. Do not claim single-use without
  it.

---

## 5. The six checks the signer performs

Perform them in this order. Every failure returns a named error and no `sig`.
Do not sign first and check later.

### Check 1 — Version, operation, algorithm, key id, time

- `v === 2` (`E_VERSION`); `op === "sign-artifact"` (`E_OP`).
- `alg === "ed25519"` (`E_ALG`); `keyId === configured key id` (`E_KEYID`).
- `runId` matches the run-id pattern; `path` is a valid run-relative path and
  is not under `approvals/` (`E_PATH`, `E_APPROVAL_SCOPE`).
- `at` parses and is within the configured skew (`E_REQUEST`). Treat a clock
  failure as a refusal, not as "probably fine".

### Check 2 — Split and validate the message

- Strict base64url decode (no padding, no whitespace, canonical re-encode
  equality); reject invalid UTF-8 (`E_MESSAGE`).
- Split on NUL into exactly six fields (`E_MESSAGE`).
- Field 1 is exactly `teamwork-artifact-v1`; field 2 is `ed25519`; field 3 is
  the request `keyId`; field 4 is the request `path`; field 5 is the request
  `nonce` (`E_MESSAGE`).
- Parse field 6 as a JSON object. Reject arrays, scalars, duplicate keys,
  non-ASCII keys, and non-finite numbers (`E_CANONICAL`).
- Re-canonicalise the parsed payload and require byte equality with field 6
  (after UTF-8 encoding). This rejects reordered keys, whitespace, and
  alternate escapes (`E_CANONICAL`).

### Check 3 — Recompute the digest

- Compute the keyed digest in §3.2 over the canonical JSON.
- Compare it in constant time with `request.digest`; require 64 lowercase hex
  (`E_DIGEST`).
- The signature the signer returns is over the **message bytes**, not over the
  digest. The digest is the envelope field the plugin records; a mismatch means
  the request is internally inconsistent.

### Check 4 — Open the approval safely

- Require `approvalRef` to be absolute, with no `..` segment, under the
  configured approval directory. Resolve the directory once and keep a
  descriptor.
- Open the approval directory with `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`, verify
  it is a directory owned by the configured approver (or at least not the
  workload), and keep that descriptor for the file open. When peer credentials
  are available (`SO_PEERCRED`), require the peer UID to be the configured
  workload UID; a different peer is `E_PEER`.
- Open the file relative to the directory descriptor with
  `O_RDONLY|O_NOFOLLOW|O_CLOEXEC` (`openat2` with
  `RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH` if available). `O_NOFOLLOW` protects
  only the final component; the directory descriptor protects the parent.
- `fstat` the opened descriptor; require a regular file, size at most 64 KiB,
  and owner UID equal to the configured approver UID (or at minimum **not** the
  workload UID). Require no group/other write. Reject a file whose
  `(dev, ino, uid, mode)` changed between the pre-open check and `fstat`
  (`E_APPROVAL_OPEN`, `E_APPROVAL_OWNER`).
- Read the bounded bytes and parse JSON. Do not trust the filename or a
  caller-supplied digest to identify the file.

### Check 5 — Verify the approval signature and binding

- Require `v === 1` and `kind === "teamwork.signer-approval"`.
- `_auth.alg === "ed25519"`, `_auth.keyId === configured approver key id`, and
  the signature verifies over the §4.3 input with the approver public key
  (`E_APPROVAL_SIG`).
- Require `runId`, `path`, `digest`, `nonce` equal the request exactly
  (`E_APPROVAL_BINDING`). A mismatch on any one field is a refusal.
- Require `expiresAt` in the future, `approvedAt` not beyond the skew, and the
  lifetime within the configured maximum (`E_APPROVAL_EXPIRED`).
- Require `approvedBy` to match the `uid:`/`oidc:`/`ci:` shape, and
  `approvalId` to be present and at least 16 decoded bytes (`E_APPROVAL_BINDING`).
- If a durable `approvalId` ledger is enabled, check and update it atomically.
  A ledger write failure is a refusal (`E_APPROVAL_REPLAY`/`E_INTERNAL`).

### Check 6 — Append the audit line, then sign

- Append one line, before returning the signature, to a sink outside the
  workload's write domain. Include at least: `at`, `peerUid` (from
  `SO_PEERCRED` when available, otherwise the configured workload UID),
  `runId`, `path`, `digest`, `keyId`, `approvalId`, `approvalRef`, `decision`,
  and a hash of the request. Open the sink `O_APPEND|O_NOFOLLOW|O_CLOEXEC`,
  `fstat` it as a regular file, and `fsync` before signing.
- If the audit append fails, return `E_AUDIT` and **do not sign**. An
  unrecorded signature is a policy failure.
- Sign the decoded `message` bytes with Ed25519. Return exactly
  `{"alg":"ed25519","keyId":"<configured>","sig":"<base64url>"}` on stdout and
  exit 0.
- Never log the message or payload at a level that stores artifact content;
  log path, run id, digest and decision only. Error messages must not include
  key material or a partial signature.

---

## 6. Response and failure vocabulary

Success:

```json
{"alg":"ed25519","keyId":"signer_2f9c…","sig":"base64url 64-byte Ed25519 signature"}
```

Failure (stdout; exit non-zero; no `sig`):

```json
{"ok":false,"code":"E_APPROVAL_BINDING","message":"approval path does not match request"}
```

| Code | Meaning | Retry? |
| --- | --- | --- |
| `E_VERSION` | `v` is not 2 (including v1) | No; fix the caller. |
| `E_OP` | Unsupported `op` | No. |
| `E_ALG` | Not `ed25519` | No. |
| `E_KEYID` | Wrong key id | No. |
| `E_REQUEST` | Missing/wrong-type field, bad runId/path, bad time | No. |
| `E_MESSAGE` | Bad base64url/UTF-8/NUL split/field mismatch | No. |
| `E_CANONICAL` | Non-canonical JSON, duplicate/non-ASCII key, bad number | No. |
| `E_PATH` | Path traversal, absolute path, empty segment | No. |
| `E_NONCE` | Missing/weak/mismatched nonce | No. |
| `E_DIGEST` | Recomputed digest does not match `digest` | No. |
| `E_APPROVAL_REF` | `approvalRef` absent, not absolute, outside the approval dir | No. |
| `E_APPROVAL_OPEN` | Symlink, non-regular, too large, changed identity | No. |
| `E_APPROVAL_OWNER` | Wrong owner (workload or unexpected principal) | No. |
| `E_APPROVAL_SIG` | Bad/missing approval signature or key id | No. |
| `E_APPROVAL_BINDING` | `runId`/`path`/`digest`/`nonce`/`approvedBy` mismatch | No. |
| `E_APPROVAL_EXPIRED` | Expired, not yet valid, or overlong lifetime | No. |
| `E_APPROVAL_REPLAY` | Reused approval id for a different request | No. |
| `E_APPROVAL_SCOPE` | Attempt to sign an `approvals/` path | No; the approval CLI owns that path. |
| `E_PEER` | Socket peer UID is not the configured workload UID | No; root is outside the policy. |
| `E_AUDIT` | Audit append failed | No; signing is refused. |
| `E_INTERNAL` | Unexpected internal error | Maybe; fail closed, never fall back. |

### 6.1 Plugin-side fail-closed mapping

The 0.13.0 plugin's `spawnJson` verifies the response shape and signature. Any
of the following is `AUTH_SIGNER_UNAVAILABLE` and the write fails; there is no
fallback to the local HMAC key:

- a non-zero exit, a timeout, a malformed/partial response, or stderr noise;
- a response without `alg === "ed25519"`, the expected `keyId`, or a 64-byte
  `sig`;
- a signature that does not verify with `OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY`;
- a response containing `{"ok":false,...}` (it is not a signature response).

A future plugin may surface the signer's `code` as a named
`AUTH_SIGNER_REFUSED` or `AUTH_APPROVAL_*` error, but it must remain
fail-closed. Do not add an automatic retry with a different digest, a local
key, or a lower trust level. A transport retry with the **identical** request
is acceptable only if the signer is idempotent for the same approval; a
different request is a new policy decision.

---

## 7. Plugin-side change required for v2

This is a specification, not a patch. The change is small but it is a code
change, not a configuration toggle:

1. **Send `v: 2` and `op: "sign-artifact"`** from the command-signer adapter
   (currently `signerEnvelope` in `plugins/opencode-teamwork/auth.ts` builds
   `v: 1`).
2. **Carry `runId`** through `signArtifact` and `signerEnvelope`. `signRunArtifact`
   already has it; `signArtifact` (used for non-run artifacts) does not. A v2
   signer must refuse an artifact with no run id.
3. **Derive `approvalRef` from trusted state**, not from an agent tool argument:
   `approvalRef = <OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR>/<runId>/<sha256(path)>.json`.
   Validate the run id and path with the same allowlist the engine uses. Do not
   accept a caller-supplied `approvalRef`; the agent must not choose which
   approval to present.
4. **Configure the approval directory** with
   `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` (proposed; not present in 0.13.0).
   It is absolute, outside the run and repository, and owned by another
   principal. When it is unset, keep v1 for compatibility; when it is set, send
   v2 and let the signer refuse.
5. **Do not verify the approval in the plugin.** The plugin cannot know whether
   the approver is a human or whether the signer applied its policy. It verifies
   the returned signature only. Duplicating the approval check in the plugin
   would create a second, weaker policy and a false sense of assurance.
6. **Keep the fail-closed path.** A configured but unavailable or refusing
   signer must never fall back to the local key. The existing
   `AUTH_SIGNER_UNAVAILABLE` behavior is correct.

**Compatibility warning.** A v2-only signer + an unmodified 0.13.0 plugin is a
broken deployment: every signed write is refused. Ship the plugin change and
the signer together, or keep the v1 signer and document that it is an oracle
unless it independently enforces a policy. Do not call a v1 signer "hardened."

**What the plugin still cannot do.** It can verify a signature; it cannot verify
a policy. A same-UID writer can edit the plugin to skip the signer entirely, or
change the public key it trusts. The external verifier must pin the signer
public key outside the workload's write domain. That is why the policy and the
key custody are deployment properties.

---

## 8. Reference implementation outline

### 8.1 Language and process model

Use **Rust or Go** for the key-holding service. Both can enforce
`MemoryDenyWriteExecute=yes` and read `SO_PEERCRED` from the accepted Unix
socket. A Node implementation is possible with `node --jitless`, but core
`node:net` does not expose peer credentials (observed in the feasibility spike),
and a JIT is incompatible with `MemoryDenyWriteExecute`; use Node only if the
approval-owner check is by configured UID and the service actually starts under
the directive. Test the real binary.

One request per connection, one response, then exit (systemd `Accept=yes` with
`StandardInput=socket`/`StandardOutput=socket`). Bound the read (256 KiB) and
the wall clock. No shell, no network, no secret in argv or environment. Load the
key from a `0600` file owned by the signer UID; keep it in memory only as long
as needed and zero it where the language supports it.

### 8.2 Modules

| Module | Responsibility |
| --- | --- |
| `config` | Key id, key path, approval dir, approver uid/key, workload uid, audit sink, skew/TTL bounds. |
| `protocol` | Strict request parsing, base64url, UTF-8, NUL split, response encoding. |
| `canonical` | Canonical JSON matching the plugin's `approval-format.mjs`; duplicate-key and non-ASCII-key rejection. |
| `digest` | HMAC-SHA256 with the `teamwork-artifact-digest-v1` label; constant-time compare. |
| `approval` | `openat`/`openat2` with `O_NOFOLLOW`, `fstat`, owner/mode checks, signature and binding checks. |
| `audit` | Append, `fstat`, `fsync`, failure-is-refusal. |
| `sign` | Ed25519 over the decoded message bytes; response shape. |

Rust crates: `ed25519-dalek`, `hmac`, `sha2`, `serde`/`serde_json` (or a small
canonical encoder), `rustix`/`nix` for `openat2`, `fstat`, `SO_PEERCRED`.
Go: `crypto/ed25519`, `crypto/hmac`, `crypto/sha256`, `encoding/json` plus a
custom canonical encoder, `golang.org/x/sys/unix`. Do not use a JSON encoder
that sorts differently or escapes non-ASCII differently from the plugin; test
the vector in §3.3 and add non-ASCII value cases.

### 8.3 Configuration example

```text
--key-id signer_2f9c…
--key-file /var/lib/teamwork-signer/keys/signer.pem
--approval-dir /var/lib/teamwork-approvals/signer
--approver-uid 996                 # teamwork-approver
--workload-uid 997                # opencode
--approver-key /etc/teamwork/approver-ed25519.pub
--audit-log /var/log/teamwork/signer-audit.jsonl
--max-request-bytes 262144
--max-approval-bytes 65536
--max-approval-ttl 24h
--clock-skew 300s
```

The audit log path must be root-owned or signer-owned and not writable by the
workload. A signer-owned log can be rewritten by a compromised signer; forward
it to a remote sink if the audit is evidence.

### 8.4 Unit-test list

Protocol and canonicalisation:

1. v1 refused (`E_VERSION`); v2 accepted.
2. Bad base64url, padding, whitespace, invalid UTF-8 (`E_MESSAGE`).
3. Wrong domain, wrong field count, NUL inside a field (`E_MESSAGE`).
4. Key order/whitespace differences rejected (`E_CANONICAL`).
5. Duplicate keys rejected; non-ASCII keys rejected; non-finite numbers
   rejected.
6. The §3.3 vector reproduces the exact digest and message.
7. Non-ASCII **values** round-trip; escaping matches the plugin.
8. Request larger than the bound is refused.

Policy:

9. `alg`, `keyId`, `op`, `runId` and `path` mismatches.
10. Absolute path, `..`, empty segment, and `approvals/` path (`E_PATH`,
    `E_APPROVAL_SCOPE`).
11. Digest mismatch (`E_DIGEST`); constant-time comparison.
12. Missing approval ref; ref outside the approval dir; ref with `..`.
13. Approval symlink, non-regular file, oversized file, changed identity.
14. Approval owned by the workload (`E_APPROVAL_OWNER`).
15. Bad approval signature; wrong approver key id; HMAC approval.
16. Each binding field mismatch: `runId`, `path`, `digest`, `nonce`.
17. Expired, not-yet-valid, overlong lifetime; clock skew.
18. Reused `approvalId` for a different request (ledger enabled).
19. A failed audit append returns `E_AUDIT` and no signature.
20. A valid request returns a signature that verifies over the decoded message
    bytes with the public key.

Service and integration:

21. Peer UID mismatch (when `SO_PEERCRED` is used).
22. Partial/oversized/timeout reads; process exits without a signature.
23. Key file unreadable/wrong mode; startup fails closed.
24. Plugin sends v2 with `runId`/`approvalRef`; happy path writes `_auth`.
25. Plugin with signer stopped: `AUTH_SIGNER_UNAVAILABLE`; no HMAC fallback.
26. v2-only signer + unmodified 0.13.0 plugin: every request refused; the
    failure is visible and does not silently downgrade.
27. External verifier accepts only the signer public key; a local HMAC
    envelope fails the trust level.
28. Key rotation: old artifacts verify with the old public key; new requests
    use the new key id; the private key never appears in logs or responses.

---

## 9. Do not ship a bare oracle signer

The following are all signing oracles, regardless of the key's location:

- a signer that accepts `v: 1` and signs any well-formed request;
- a signer that checks the schema, key id and path allowlist but does not check
  an approval or independently recompute the verdict;
- a signer that trusts `request.digest` without recomputing it from the
  message;
- a signer that accepts any `approvalRef` without verifying its owner,
  signature and binding;
- a signer that signs before appending the audit line, or ignores an audit
  failure;
- a signer that runs as the workload UID, or reads its key from an environment
  variable the workload can read;
- a signer that falls back to a local key, a cached signature, or a lower trust
  level when the policy fails;
- a signer that accepts a caller-chosen `approvalRef` from an agent tool.

A different UID, a socket mode or a root-owned binary is not enough by itself.
The policy is what makes the signer non-oracle.

---

## 10. Honest limits

- **Same-UID reachability.** The socket is reachable by the workload UID, and
  any same-UID process can call it. `SO_PEERCRED` names a UID, not a process or
  a user intent; the agent and a shell are the same principal. The approval
  binding is the only thing that distinguishes a permitted signing operation
  from an arbitrary one.
- **Human presence and key custody are deployment properties.** The signer can
  verify that a configured approver key signed the exact fields. It cannot
  establish that a human was present, that a human read the draft, that the
  displayed text matched the bytes hashed, or that the approver understood the
  consequence. `approvedBy` is a claimed label; a script with the approver key
  can reproduce the CLI's typed confirmation.
- **Approval content is not validated.** The signer does not know whether the
  approved verdict is true. An independent verifier that recomputes from
  evidence is a different design; it must define which evidence it trusts.
- **Compromise.** A compromised signer, signer key, approver key or host
  defeats the policy. Root can read the key, ptrace the service, edit the unit
  and rewrite the audit log.
- **Audit.** The audit line is a record, not proof. A local log can be erased by
  root or a compromised signer; forward it if it is evidence.
- **Clock and replay.** `expiresAt` is signed; `at` is not. Clock skew can
  reject a valid request or accept one outside the intended window. A replay of
  the same approval for the same artifact is idempotent; strict single-use needs
  a durable ledger.
- **Run id binding.** The artifact signature input does not contain `runId`; the
  run id is bound by the approval and by the per-run nonce pinned in the signed
  manifest. Do not claim that the artifact signature alone names the run. If a
  deployment needs `runId` inside the signature domain, define a new artifact
  domain version rather than changing v2 silently.
- **Plugin tampering.** The plugin is user-owned. A same-UID writer can disable
  its local gate or change the public key it trusts. The external verifier's
  pin and the signer's refusal are the remaining controls.
- **Availability.** A stopped signer fails every signed write closed. That is
  the intended behavior, but it is an availability dependency; plan a restart
  policy and monitor the socket.
- **Version compatibility.** This v2 contract requires the plugin change in §7.
  A v2 signer must refuse v1; an unmodified 0.13.0 plugin cannot use it. Do not
  describe a v1 deployment as policy-enforcing.
