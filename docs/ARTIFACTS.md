# Teamwork artifacts

Single source of truth for the files every Teamwork run reads and writes, and
for the topologies the coordinator may pick. Agents reference this file instead
of redefining formats.

## Layout

Every run writes under one root:

```
.opencode/teamwork/<session-id>/
├── prompt_draft.md          # spec (from the crafter, or inlined by the sentinel); required by teamwork_plan unless bypassed
├── ORIGINAL_REQUEST.md      # verbatim routed request + integrity mode (write-once; absent on legacy runs)
├── requirements.json        # plan-time requirements baseline (caller or request-derived; absent when neither exists)
├── run.manifest.json        # signed baseline: modes + request/requirements/plan/policy hashes (_auth)
├── plan.dag.json            # task DAG (+ preflight gate result + verification/victoryAudit/requireHandoffs modes)
├── preflight.json           # input-checks report (written by teamwork_preflight)
├── state.json               # resumable coordinator state
├── costs.json               # coordinator-maintained budget tracker
├── BRIEFING.md              # shared run briefing: mission, identity, constraints, status, artifacts, succession
├── handoffs/                # canonical agent handoffs: <taskId|_run>-<agent>.md + index.json
├── agents/                  # per-agent briefings: <agentSlug>-<sha256(sessionID)[0:32]>/BRIEFING.md
├── handoff.md               # legacy unqualified handoff (read-only; new writes go through teamwork_handoff)
├── events.jsonl             # append-only lifecycle event log (JSON Lines)
├── pitfalls.md              # answer-agnostic failure registry
├── document-review/         # present for document-review runs
│   ├── manifest.json        # validated bounds, source metadata, segments
│   ├── DOCUMENT_TEXT_MAP.md # sanitised extracted document text map
│   ├── ANALYSIS_PARTITION.md # segment table & bounded RSA tree schedule
│   ├── segments/<segId>/level-<L>-node-<I>.json # bounded RSA node output
│   ├── segments/<segId>/unit-report.md          # adjudicated segment report
│   └── synthesis/candidate-<I>.md               # cross-segment synthesis candidate
├── DOCUMENT_REVIEW_REPORT.md # final synthesised critique report
├── scout-report.md          # scout output
├── candidates/cand-<n>.md   # one per proposer
├── critiques/crit-<n>.md    # one per falsifier
├── synthesis/syn-<n>.md     # one per synthesizer run
├── synthesis/conflict-<task>.json # git 3-way merge conflict artifact
├── verify/report-<task>.json
├── verify/challenge-<task>.json # strict mode: team/falsifier PASS challenge
├── verify/audit-<task>.json     # strict mode: team/security-auditor CLEAN audit
├── verify/summary.json
├── verify/security-audit.json # pre-merge security gate report
├── verify/victory.json        # independent final acceptance verdict (team/victory-auditor)
├── verify/final.json          # stamped final verification verdict
├── verify/evidence/<name>     # optional bounded evidence artifacts cited by wave verdicts (0.12.0)
├── GATE_STATUS.md             # strict mode: final verification gate table
├── lemma/                     # optional: LEMMA (Lean 4) formal-proof state when lemmaMode=true
│   ├── manifest.json          # bounds, toolchain snapshot, phase, node index
│   ├── problem_draft.lean     # Phase 0 formalization draft
│   ├── problem.lean           # approved Phase 0 formalization
│   ├── formalization-review.json # preSearch (APPROVE/REQUEST_CHANGES) + final (FAITHFUL/...)
│   └── nodes/<lemmaId>/       # state.json, blueprint.md, attempt-<r>.lean, verify-<r>.json
├── tournament/                # optional: bounded massive-proof tournament state (explicit opt-in)
│   ├── manifest.json          # opt-in proof, bounds, budget estimate, phase, level, cancellation state
│   ├── candidates/<candId>.json # candidate metadata, level, parents, status, refutations, score
│   ├── candidates/<candId>.md   # sanitized candidate strategy/proof body
│   ├── critiques/<candId>-falser.json # team/falsifier structured critique + counterexamples
│   ├── merges/L<level>-<candId>.json  # team/synthesizer level aggregation record
│   └── verdict.json           # team/referee ranked candidates + ACCEPT | REJECT | PARTIAL verdict
├── TOURNAMENT_REPORT.md       # deterministic tournament summary (COMPLETED, FAILED, or PARTIAL)
├── final.md                 # presented result
├── report.html / report.md  # optional export output (`opencode-teamwork export`)
└── interrupted.md           # present when the user stops a run
```

`<session-id>` = `YYYYMMDD-HHMMSS-<4 hex>`.

Worktrees are created **outside the repository** (nested git worktrees inside
the repo are a footgun). Default root: `$TEAMWORK_WORKTREES_DIR` or
`../.teamwork-worktrees/<session-id>/`.

## Topologies

| Topology | Shape |
| --- | --- |
| `small-focused` | 1 worker + 1 verifier loop |
| `iterative-coding` | 1 worker, test-driven tight loop on one module |
| `distributed-coding` | N workers fan-out + merge |
| `proof` | 1 strategist + 3-5 searchers + 1 formal checker (plus explicit opt-in LEMMA / Lean 4 mode via `lemmaMode: true`) |
| `massive-proof` | Bounded multi-level tournament search + falsers + mergers + referee (explicit opt-in only; 1 meta-coordinator + up to 100+ searchers) |
| `document-review` | segment triage (1–8 segments, default 6) → bounded per-segment RSA tree `[4,2,1]` → cross-segment synthesis `[4,1]` |

Legacy aliases — accept them, normalize on write:
`large-swarm` → `distributed-coding`, `doc-review` → `document-review`,
`long-proof` → `proof`, `massive-proof-swarm` → `massive-proof`.

## Integrity modes

Every run is routed with one integrity mode. It is recorded in
`ORIGINAL_REQUEST.md`, copied to `state.json` and `plan.dag.json`, and read back
by the security auditor and the final-verification gate from
`ORIGINAL_REQUEST.md` (never from the caller). The orchestrator records and
reports it; the auditor reports rule violations and the audit tool makes them
binding (see [Integrity rules](#integrity-rules)).

| Mode | Meaning |
| --- | --- |
| `development` | Default. Reuse, libraries and frameworks are allowed; only fabricated outputs and facade implementations are ruled out. |
| `demo` | Also forbids copying core logic from open source, delegating core work to external tools, and reading test sources to reverse-engineer expected behaviour. |
| `benchmark` | A fully independent from-scratch implementation using the language standard library only. |

`development` is the default: `teamwork_plan` applies it when `integrityMode` is
omitted, and the auditor and final gate apply it to legacy runs with no
`ORIGINAL_REQUEST.md`. Any other value is refused before anything is written.

### Integrity rules

The auditor reports structured integrity claims as `integrityFindings` on
`teamwork_security_audit`. Each rule is forbidden from a given mode onward, and
every stricter mode inherits it:

| Rule | Forbidden from |
| --- | --- |
| `fabricated_output` | `development` (always blocking) |
| `core_logic_copied` | `demo` |
| `delegated_core_work` | `demo` |
| `test_source_read` | `demo` |
| `external_dependency_used` | `benchmark` |

A finding whose rule is forbidden at the run's mode is a **violation**. Any
violation forces the audit to `FAIL` regardless of severity counts, so
`teamwork_final_verify` cannot reach `PASS` and the merge stays blocked; the
audit result names the violated rules and the mode. An unknown rule id is
refused before anything is written.

**Limitation.** The tool cannot detect dishonesty. It does not inspect the code
to prove a rule was broken; it takes the auditor's report at face value and
makes a reported violation binding on the gate.

## Schemas

### `ORIGINAL_REQUEST.md` — verbatim routed request (write-once)

`teamwork_plan` writes this file once, **before** `plan.dag.json` and
`state.json`, when its optional `request` input is provided. It is the artifact
the auditor reads the integrity mode from, and the path to hand any auditor that
checks the work against the original request.

- **Write-once.** If the file already exists with non-empty content, a second
  plan into the same run is refused ("write-once ... use a new session") and
  writes nothing else.
- **Verbatim.** The request text is preserved exactly — no reflow, no trimming
  of interior whitespace — and capped at 20,000 characters. A longer request is
  refused, never silently truncated.
- **Legacy tolerance.** When `request` is omitted, no file is created; the run
  still plans and the mode defaults to `development`.

Format:

~~~markdown
# Original Request

- Integrity mode: demo
- Recorded: 2026-01-12T10:15:00.000Z
- Session: 20260112-101500-a1b2

## Request

<verbatim request>
~~~

### `requirements.json` — plan-time requirements baseline

`teamwork_plan` writes this once per run when the caller supplies
`requirements`, or derives a single `R1` item from a supplied verbatim
`request`. When neither exists (legacy/tiny path), no file is written and the
plan records `victoryAudit: "skip"` explicitly.

```json
{
  "version": 1,
  "source": "caller|request",
  "items": [{ "id": "R1", "text": "Behaviour-focused requirement" }]
}
```

- `source: "caller"` — the exact validated `requirements` array (order kept).
- `source: "request"` — one `R1` item containing the request text (≤2,000 chars).
- **Immutable once written.** A re-plan with a different baseline is refused;
  the same baseline is idempotent. This stops a confirmed verdict from being
  invalidated by editing the requirements afterwards.

### `run.manifest.json` — signed completion baseline (ADR 0005)

Written by `teamwork_plan` for a signed run (the default). It pins the run's
modes and the hashes a later gate recomputes, so a control-plane downgrade is
`AUTH_STALE` rather than accepted:

```json
{
  "version": 3,
  "sessionId": "20261122-120000-abcd",
  "rootSessionId": "ses_...",
  "integrityMode": "development|demo|benchmark",
  "verification": "standard|strict",
  "victoryAudit": "required|skip",
  "victorySkipReason": "why an explicit victory skip was recorded (only when skip)",
  "requireHandoffs": "required|skip",
  "handoffAuth": "signed|legacy",
  "requestHash": "sha256 | null",
  "requirementsHash": "sha256 | null",
  "planHash": "sha256",
  "lemmaPolicyHash": "sha256 | null",
  "runKeyId": "k_...",
  "trustLevel": "local-hmac|external-signer|human-approved|ci-attested",
  "requireWitness": false,
  "approvalPolicy": "external-dir|in-run-legacy|none",
  "approvalKeyId": "approval_... | null",
  "specHash": "sha256 of the exact prompt_draft.md bytes | null",
  "specBytes": 2089,
  "approvalDigest": "sha256 of the approval payload without _auth | null",
  "approvalNonce": "base64url >=128-bit one-use nonce | null",
  "approvalBinding": "prompt",
  "approvedBy": "uid:<name>|oidc:<issuer>#<sub>|ci:<workflow> | null",
  "approvedAt": "2026-11-22T11:59:00.000Z",
  "createdAt": "2026-11-22T12:00:00.000Z",
  "_auth": {
    "v": 1,
    "alg": "hmac-sha256",
    "keyId": "k_...",
    "path": "run.manifest.json",
    "digest": "sha256",
    "mac": "sha256",
    "at": "2026-11-22T12:00:00.000Z"
  }
}
```

- Version 3 is written by 0.11.0+. Version 2 (0.10.2) and version 1
  (pre-0.10.2) manifests remain readable. Version 1 in-run
  `approvals/<runId>.json` is honoured only for those runs and is recorded as
  `approval_unbound`; version 2 keeps its manifestDigest-bound approval
  semantics.
- `specHash` is an **unkeyed SHA-256 of the exact file bytes** (not the keyed
  artifact digest), and `specBytes` is the byte length. `teamwork_plan` reads
  the draft through the bounded no-follow run reader before any `mkdir`, so a
  symlinked, non-regular, or edited draft cannot be planned against a different
  text. A version-3 plan records `specHash`/`specBytes` whenever a draft exists,
  including `local-hmac` runs; editing the draft later is `AUTH_STALE`.
- `approvalPolicy`/`approvalKeyId`/`specHash`/`specBytes`/`approvalDigest`/
  `approvalNonce`/`approvalBinding`/`approvedBy`/`approvedAt` are part of the
  signed baseline and drift checks. `human-approved`/`ci-attested` pin
  `external-dir` and the configured verify-only approver key; a re-plan cannot
  remove or change either. For a version-3 approval, the manifest records the
  approval payload digest (never a digest of the manifest inside the approval),
  which removes the old circular manifestDigest requirement.

- `rootSessionId` is the plan-time caller session. `teamwork_victory_audit`,
  `teamwork_wave_record`, and `teamwork_report` require the caller session to
  be a strict descendant of it (walked through `parentID`, bounded, fail closed).
- `planHash` covers the semantic plan (topology, modes, the victory skip reason
  when present, route, LEMMA bounds, tasks), not formatting or `routingReason`.
- An explicit `victoryAudit: "skip"` requires `victorySkipReason` (non-empty,
  trimmed, ≤500 chars, sanitized). The reason is persisted in
  `plan.dag.json`, `state.json` and this manifest; a re-plan may repeat it but
  not change it (`AUTH_STALE`). The legacy no-baseline default skip has no
  reason and is labelled `SKIPPED (legacy default: no requirements baseline)`.
- A re-plan must present the same modes and hashes. `final_verify`/`next`
  return `AUTH_STALE` if `plan.dag.json`, `state.json`, `ORIGINAL_REQUEST.md`,
  `requirements.json`, or the LEMMA policy diverges from the manifest.
- `handoffAuth` pins the handoff-index provenance baseline. A new signed plan
  writes `"signed"`; a plan created with `allowUnsignedLegacy: true` writes
  `"legacy"`; a 0.8.0 manifest without the field is read as `"legacy"`. A
  re-plan may upgrade `legacy → signed`, but a `signed → legacy` downgrade is
  `AUTH_STALE` and refused.
- **Legacy:** `allowUnsignedLegacy: true` at plan time creates/keeps an
  unsigned run. Its completion gates return `AUTH_LEGACY` until the caller
  explicitly passes `allowUnsignedLegacy: true`; that bypass is recorded as a
  `legacy_unsigned_bypass` event. An unsigned baseline cannot require the
  handoff gate, so it records `requireHandoffs: "skip"`. `benchmark` refuses the
  bypass and refuses both `victoryAudit: "skip"` and `requireHandoffs: "skip"`.

### `_auth` envelopes and the digest index (ADR 0005/0008)

Every signed control-plane artifact carries an `_auth` object in addition to its
normal fields:

| Field | Meaning |
| --- | --- |
| `v` | envelope version (`1`) |
| `alg` | `hmac-sha256` (field `mac`) or `ed25519` (field `sig`) |
| `keyId` | key used (current or retired ring key); must equal the signed manifest's `runKeyId` |
| `path` | exact run-relative path; a copied envelope fails |
| `digest` | sha256 of `canonicalJson(payload without _auth)` |
| `mac` | HMAC-SHA256 over the envelope without `mac` (`hmac-sha256` only) |
| `sig` | base64url Ed25519 signature over `"teamwork-artifact-v1\0alg\0keyId\0path\0nonce\0canonicalJson(payload)"` (`ed25519` only) |
| `nonce` | per-run 128-bit nonce; required for `ed25519`, bound to the run for both algorithms |
| `at` | ISO-8601 timestamp |

Every new signed run writes a `runNonce` and `runKeyId` into the signed
`run.manifest.json`; the plugin binds both at `auth/run/<runId>/.nonce` and
`.keyid`. Artifacts signed for that run carry the nonce and must match the key
id, so a copy from another run or a re-sign with a rotated key fails.

The plugin also writes `ctx.storage` key `auth/run/<runId>/<relPath>` with the
same `path`/`digest`/`keyId`/`alg`/`mac` or `sig`/`nonce`/`at`. A signed run
fails closed when the index entry is missing (`AUTH_INDEX_MISSING`) or stale
(`AUTH_STALE`); an old artifact is never auto-adopted. The key ring lives at
`auth/key/ring` (`{version: 1, keys: [...]}`), current + up to two previous
keys; entries may be `hmac-sha256` or `ed25519` (PKCS#8 private key and/or SPKI
public key). A malformed ring is `AUTH_KEY_CORRUPT` and is never silently
rotated.

Key configuration: `OPENCODE_TEAMWORK_HMAC_KEY` + `_ID` (CI/offline HMAC),
`OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY` / `_PUBLIC_KEY` / `_KEY_ID` (local
Ed25519, public-only verification allowed), or
`OPENCODE_TEAMWORK_SIGNER=command:<absolute path>` +
`OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY` (+ optional `_KEY_ID`, `_TIMEOUT_MS`) for
an external Ed25519 signer. An optional witness is configured with
`OPENCODE_TEAMWORK_WITNESS=command:<path>` or `http(s)://<url>` and receipts are
stored at `auth/witness/<runId>/<relPath>`. The v2 witness request is
`{v:2, runId, path, digest, keyId, nonce, at}`; when
`OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY` is configured the response must be
`{receipt, alg:"ed25519", keyId, sig}` over
`teamwork-witness-v1\0runId\0path\0digest\0nonce\0at`, and the record stores
`{v:2, receipt, alg, keyId, sig, at, verified:true, record, recordedAt}`.
`final_verify` verifies it when `requireWitness` is set: a missing receipt is
`AUTH_WITNESS_UNAVAILABLE`, a forged/foreign/different-digest record is
`AUTH_INVALID`. Without a witness public key the receipt is stored with
`alg:"unverified"`, `verified:false`, and final.json records
`evidence.witness.status: "unverified"` (detection-only).

`teamwork_plan` also records `trustLevel` (`local-hmac` default,
`external-signer`, `human-approved`, `ci-attested`) and `requireWitness`.
`final_verify` enforces them: `external-signer` refuses HMAC envelopes
(`AUTH_TRUST_LEVEL`), `human-approved`/`ci-attested` require an Ed25519
`approvals/<runId>.json` from `OPENCODE_TEAMWORK_APPROVAL_DIR` signed by a key
distinct from `runKeyId` and bound to the exact prompt draft and this run
(`AUTH_APPROVAL_MISSING`, `AUTH_APPROVAL_DIR`, `AUTH_APPROVAL_UNTRUSTED`,
`AUTH_APPROVAL_STALE`, `AUTH_APPROVAL_NOT_HUMAN`,
`AUTH_APPROVAL_INCOMPLETE`, `AUTH_APPROVAL_REPLAY`), and a required witness
without a receipt fails `AUTH_WITNESS_UNAVAILABLE`. Version 1 (pre-0.10.2)
manifests keep the in-run approval path readable and record
`approval_unbound`. The signed manifest is version 3 and pins `approvalKeyId`,
`approvalPolicy`, and the prompt/approval binding; a re-plan cannot change any
of them. `OPENCODE_TEAMWORK_SIGNER` that is configured but
unavailable/malformed fails `AUTH_SIGNER_UNAVAILABLE`; there is no fallback to
local HMAC. The plugin signer and command signer refuse an `approvals/` path
with `AUTH_APPROVAL_SCOPE`; approvals are produced only by the approver key
holder.

### `approvals/<runId>.json` — authenticated prompt approval (ADR 0011)

Written outside the run and repository, in an absolute
`OPENCODE_TEAMWORK_APPROVAL_DIR` owned by a different UID, by
`opencode-teamwork approve sign` (or an equivalent CI job) using the approver's
Ed25519 private key directly. The plugin verifies it with
`OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` and never signs it itself.

```json
{
  "v": 1,
  "runId": "20261122-120000-abcd",
  "trustLevel": "human-approved|ci-attested",
  "binding": "prompt",
  "promptDraftSha256": "unkeyed sha256 of the exact prompt_draft.md bytes",
  "promptDraftBytes": 2089,
  "openGaps": 0,
  "approvalNonce": "base64url >=128-bit, one use per run",
  "approvedAt": "2026-11-22T11:59:00.000Z",
  "expiresAt": "2026-11-23T11:59:00.000Z",
  "planHash": "optional pre-commitment to an existing plan | null",
  "approvedBy": "uid:<name>|oidc:<issuer>#<sub>|ci:<workflow>",
  "_auth": {
    "v": 1,
    "alg": "ed25519",
    "keyId": "approval_...",
    "path": "approvals/20261122-120000-abcd.json",
    "digest": "sha256 of the payload without _auth",
    "sig": "base64url Ed25519 signature",
    "nonce": "must equal approvalNonce",
    "at": "2026-11-22T11:59:01.000Z"
  }
}
```

- `ci-attested` uses `attestedBy` (usually `ci:<workflow>`) instead of
  `approvedBy`; the binding fields are identical.
- `approvedAt`/`expiresAt` are validated at plan time and again at
  `final_verify`: the default lifetime is 24 h
  (`OPENCODE_TEAMWORK_APPROVAL_TTL_MS`, hard cap 7 days), and a prompt-bound
  approval must still be live when the manifest was written.
- `openGaps` must be `0`. `approve sign --allow-open` records a nonzero count
  (so an operator can document that gaps remained) and the plan then refuses
  the approval with `AUTH_APPROVAL_INCOMPLETE`; a draft containing `[OPEN:` is
  refused even if the approval claims zero.
- `planHash` is optional. `null` approves any plan for the exact draft; a
  non-null value must equal an existing run's `plan.dag.json` baseline, so a
  re-approval is tied to the plan it was shown.
- `approvalNonce` must be at least 128 bits and equal `_auth.nonce`. The plugin
  consumes it once per run under the plan lock and stores
  `{approvalNonce, approvalDigest, planHash, at, runId}` at
  `ctx.storage` key `auth/approval/<runId>/consumed`. A later plan with a
  different nonce is `AUTH_APPROVAL_REPLAY`. The nonce is only consumed after
  every plan-time refusal path has passed.
- The approval does **not** contain a manifest digest: the manifest records its
  `approvalDigest`, so the two cannot reference each other circularly.
- `human-approved`/`ci-attested` are refused when the approval directory is
  inside the run/repo, is a symlink, or is owned by the run process's UID
  (`AUTH_APPROVAL_UNTRUSTED`). The approval file itself must be a regular file
  owned by the directory's UID.

Failure vocabulary: `AUTH_UNAVAILABLE`, `AUTH_KEY_CORRUPT`, `AUTH_MISSING`,
`AUTH_INVALID`, `AUTH_UNKNOWN_KEY`, `AUTH_INDEX_MISSING`, `AUTH_STALE`,
`AUTH_LEGACY`, `AUTH_SIGNER_UNAVAILABLE`, `AUTH_WITNESS_UNAVAILABLE`,
`AUTH_TRUST_LEVEL`, `AUTH_APPROVAL_MISSING`, `AUTH_APPROVAL_DIR`,
`AUTH_APPROVAL_UNTRUSTED`, `AUTH_APPROVAL_STALE`, `AUTH_APPROVAL_NOT_HUMAN`,
`AUTH_APPROVAL_INCOMPLETE`, `AUTH_APPROVAL_REPLAY`, `AUTH_APPROVAL_SCOPE`.

Plan-time approval order (all before `mkdir` / any state write):
1. resolve the external directory and its ownership;
2. read `prompt_draft.md` through the bounded no-follow reader and hash the
   exact bytes;
3. verify the approval envelope (Ed25519, distinct key, pinned
   `approvalKeyId`) and its `runId`/`trustLevel`/`binding`;
4. require `promptDraftSha256`/`promptDraftBytes` to equal the current bytes,
   `openGaps: 0`, and no remaining `[OPEN:` marker;
5. require a fresh `approvedAt`/`expiresAt` and an unused
   `approvalNonce == _auth.nonce`.

`final_verify` repeats steps 2-5, then compares the approval payload digest,
nonce, approver, and `approvedAt` with the signed manifest.

> **Boundary.** A same-UID shell with read access to `opencode.db` / the plugin
> KV store can read a local HMAC or Ed25519 private key and mint envelopes, and
> can call a same-UID command signer. Ed25519 makes verification possible with
> only a public key; it does not isolate the key. See
> `docs/adr/0005-artifact-authenticity.md`,
> `docs/adr/0006-artifact-trust-isolation.md`,
> `docs/adr/0008-signer-spi-and-trust-levels.md` and `SECURITY.md`.

### Signer protocol v2 and the signer approval (ADR 0014)

Without `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` the command signer receives the
exact v1 request `{v:1, alg, keyId, path, digest, nonce, at, message}`. When
the directory is set, the request is
`{v:2, op:"sign-artifact", runId, alg, keyId, path, digest, nonce, at,
approvalRef, message}` and `approvalRef` is
`<DIR>/<runId>/<plain sha256(path)>.json` (`contentSha256Hex`, not the keyed
artifact digest). `runId` is threaded through `signRunArtifact` →
`signArtifact` (`SignOptions.runId`). The plugin validates the directory
(absolute, real, not owned by this process), derives the reference from trusted
inputs, and never reads the approval. A v1-only signer with the directory set,
or a v2-only signer without it, fails `AUTH_SIGNER_UNAVAILABLE`; there is no HMAC
fallback.

The approval is produced by
`opencode-teamwork approve signer --session <runId> --path <relPath> --digest
<64hex>`, written mode `0600` at the same layout, with payload
`{v:1, kind:"teamwork.signer-approval", runId, path, digest, nonce, approvedAt,
expiresAt, approvedBy, approvalId, _auth}`. `nonce` is the run nonce from the
signed manifest. The signature domain is
`teamwork-signer-approval-v1\0runId\0path\0digest\0nonce\0expiresAt\0canonicalJson(payload without _auth)`.
The plugin does not verify this artifact; the signer does.

### `spec.json` — one per dispatched worker (written by the sentinel)

```json
{
  "taskId": "R1-impl",
  "sessionId": "20260112-101500-a1b2",
  "title": "Implement R1",
  "topology": "distributed-coding",
  "objective": "one sentence",
  "requirements": ["R1", "R2"],
  "acceptanceCriteria": ["- [ ] ...", "- [ ] ..."],
  "localChecks": ["npm test -- foo"],
  "verification": ["how the verifier proves PASS"],
  "dependencies": [{ "taskId": "R0", "artifacts": ["synthesis/syn-1.md"] }],
  "avoidPitfalls": ["assumes input is sorted"],
  "worktree": "/abs/path/to/worktree",
  "baseBranch": "teamwork/base-<session-id>",
  "constraints": { "network": "allowed", "sandbox": "worktree-only" }
}
```

`constraints.network`: `allowed | denied | whitelist`.
`constraints.sandbox`: `full | read-only | worktree-only`.

### `plan.dag.json`

```json
{
  "sessionId": "20260112-101500-a1b2",
  "topology": "distributed-coding",
  "integrityMode": "development",
  "verification": "standard|strict",
  "victoryAudit": "required",
  "victoryAuditSource": "default",
  "victorySkipReason": "required when victoryAudit is skip",
  "requireHandoffs": "required",
  "requireHandoffsSource": "default",
  "requirementsSource": "request",
  "requirementsCount": 1,
  "preflight": { "status": "READY", "bypassed": false },
  "tasks": [
    {
      "id": "R1-impl",
      "dependsOn": [],
      "requirements": ["R1"],
      "agent": "team/worker",
      "status": "pending",
      "round": 0,
      "maxRounds": 4
    }
  ]
}
```

### `state.json` — coordinator checkpoint (rewritten on every transition)

```json
{
  "version": 1,
  "sessionId": "20260112-101500-a1b2",
  "integrityMode": "development",
  "verification": "standard|strict",
  "victoryAudit": "required|skip",
  "victorySkipReason": "present only when victoryAudit is skip",
  "requireHandoffs": "required|skip",
  "claimProtocol": 2,
  "claimLeaseMs": 300000,
  "host": "workstation",
  "storage": {
    "lockProtocol": "atomic-link",
    "fallback": "mkdir",
    "hardlinkSupport": "auto",
    "diagnostics": []
  },
  "phase": "LOAD_SPEC|WORKTREE_INIT|DAG_BUILD|DISPATCH|SECURITY_AUDIT|FINAL_VERIFICATION|MERGE|PRESENT_PARTIAL|DONE",
  "tasks": {
    "R1-impl": {
      "status": "pending|worker_active|worker_done|verifier_active|verified_pass|verified_fail|blocked",
      "round": 1,
      "fence": 3,
      "claim": {
        "by": "ses_abc123",
        "at": "2026-01-12T10:14:58Z",
        "leaseUntil": "2026-01-12T10:19:58Z",
        "host": "workstation",
        "runHost": "workstation",
        "epoch": 2,
        "heartbeatAt": "2026-01-12T10:16:10Z",
        "renewals": 1,
        "baseline": {
          "scope": "git",
          "baseSha": "<40 hex>",
          "headSha": "<40 hex>",
          "diffHash": "<64 hex>",
          "statusHash": "<64 hex>",
          "untracked": { "count": 0, "digest": "<64 hex>", "truncated": false },
          "fingerprint": "<64 hex>",
          "at": "2026-01-12T10:15:00Z"
        },
        "history": [
          { "by": "ses_old123", "at": "2026-01-12T10:00:00Z", "leaseUntil": "2026-01-12T10:05:00Z", "event": "reclaimed" }
        ],
        "previousClaimant": {
          "by": "ses_old123",
          "at": "2026-01-12T10:00:00Z",
          "leaseUntil": "2026-01-12T10:05:00Z"
        }
      },
      "inspection": {
        "tokenHash": "<sha256 of the one-time token>",
        "at": "2026-01-12T10:20:00Z",
        "expiresAt": "2026-01-12T10:30:00Z",
        "fingerprint": "<64 hex>",
        "round": 1,
        "fence": 3,
        "by": "ses_abc123"
      },
      "checkpoint": {
        "at": "2026-01-12T10:24:00Z",
        "by": "ses_abc123",
        "headSha": "<40 hex>",
        "fingerprint": "<64 hex>",
        "commits": 1
      },
      "claimHistory": [
        { "by": "ses_abc123", "at": "2026-01-12T10:14:58Z", "leaseUntil": "2026-01-12T10:19:58Z", "event": "released" }
      ],
      "branch": "teamwork/20260112-101500-a1b2-R1-impl",
      "worktree": "../.teamwork-worktrees/20260112-101500-a1b2/R1-impl",
      "summary": "Implemented core validation logic",
      "feedback": "Verifier found edge case in empty inputs",
      "feedbackLog": [
        {
          "round": 1,
          "at": "2026-01-12T10:15:00Z",
          "text": "Verifier found edge case in empty inputs",
          "resolved": false
        }
      ],
      "verification": {
        "status": "PASS|FAIL",
        "passedChecks": 4,
        "totalChecks": 4,
        "fatalFindings": []
      },
      "lastReport": "verify/report-R1-impl.json",
      "updatedAt": "2026-01-12T10:15:00Z"
    }
  },
  "updatedAt": "2026-01-12T10:15:00Z"
}
```

Task lifecycle:
- `pending`: Unstarted, waiting for dependencies to reach `verified_pass`.
- `worker_active`: Worker subagent is dispatched and coding in its isolated worktree.
- `worker_done`: Worker has committed changes to its branch; ready for verification.
- `verifier_active`: Verifier subagent is running tests/rubrics against the branch diff.
- `verified_pass`: Verification passed; ready for `teamwork_worktree` merge to sentinel base.
- `verified_fail`: Verification failed; if `round < maxRounds`, ready to re-dispatch worker with feedback; if `round >= maxRounds`, automatically transitions to `blocked`.
- `blocked`: Max rounds exceeded or upstream dependency blocked.

**Task claims, fences and recovery (claim protocol 2).** `teamwork_next` does
not just read the graph: before returning a ready task it writes a bounded
claim under the `state.json` cross-process lock. A new plan records
`claimProtocol: 2` and `claimLeaseMs` (default **5 minutes**, bounded 60 s–60 m).
A **5-minute grace** follows the lease. A `state.json` without `claimProtocol`
is protocol **1** and keeps the 0.9.0 behaviour exactly (15-minute lease,
expired claims reclaimable without a fingerprint, no fence enforcement).

```json
"claim": {
  "by": "<calling session id>", "at": "ISO8601", "leaseUntil": "ISO8601",
  "host": "<claiming process host>", "runHost": "<run's recorded host>",
  "epoch": 2, "heartbeatAt": "ISO8601", "renewals": 1,
  "baseline": { "scope": "git|artifact", "fingerprint": "<64 hex>", "...": "..." },
  "history": [ { "by": "ses_old", "at": "ISO8601", "event": "reclaimed" } ]
}
```

`claim.host` is the **claiming process**, not necessarily the host that planned
the run (`claim.runHost`). Cross-host checks compare `claim.host`; a protocol-2
claim written by 0.10.0 with the run host is read as local on a local run and is
never rewritten. **A protocol-2 claim with no `host` is cross-host** (fail
closed): it is never auto-reclaimed, and `release` needs the cross-host
confirmation. A protocol-1 run predates the field and keeps the legacy local
behaviour. The same rule applies to `runHostOf`: a protocol-2 state/plan with no
recorded host reports `unknown`, not this host.

* **Derived state** (`teamwork_status`, `teamwork_resume`, `teamwork_next`):
  * `live` — the lease is still in the future.
  * `expired` — past the lease, inside the grace window. **Not reclaimable.**
  * `stale` — past lease + grace. Reclaimable only by the rules below.
  * `needs-inspection` — a claim explicitly flagged by a forced expiry (or any
    later flag), whose side effects changed, or whose baseline is
    missing/unknown. A flag is reported even while the lease is **live**. It
    **always wins**: excluded from `readyForWorker`/`readyForVerifier`, never
    renewed or reclaimed even when the fingerprint is unchanged, gated on every
    `task_update` transition (not only `worker_active`), and listed in
    `status.needsInspection`.
  * `cross-host` — `claim.host` (the claiming process) is not this host.
    **Never auto-reclaimed.**
  `status.claims[]` carries `remainingMs`, `heartbeatAgeMs`, `fence` and
  `fingerprintChanged`; `status.warnings` names `FOREIGN_HOST` /
  `SHARED_FS_SUSPECTED` when the run host differs.
* **Fence.** Every task has a monotonic `fence` that increments on a claim,
  reclaim, release, explicit Sentinel override, or round change. A **round
  change and a release are separate events**, so a transition that does both
  increments twice (a new round is a new epoch; the release is a new owner
  slot). A heartbeat and a renewal of the same owner/epoch never increment, so
  the fence returned by `next` is valid for the immediate `task_update` in the
  common path (owner and round unchanged). `teamwork_next`
  returns it; `teamwork_task_update` accepts an optional `fence` and refuses a
  mismatch with `STALE_FENCE` **without changing state**. A live claim held by a
  non-owner/non-descendant is `CLAIM_OWNED_BY_OTHER`; an expired claim the caller
  does not own is `CLAIM_EXPIRED`; a flagged claim cannot be resumed
  (`CLAIM_NEEDS_INSPECTION`). Ownership is the claim's session or a session
  descended from it. The checks run on **every** transition, not only
  `worker_active`.
* **Sentinel override.** `team/sentinel`/`team/orchestrator` may override another
  session's claim only with a non-empty `reason`; the override is recorded as
  `claim_override` and increments the fence. Starting an *unclaimed* task is the
  older, reason-optional recorded behaviour.
* **Heartbeat.** The owner or a descendant renews `leaseUntil`/`heartbeatAt`
  without changing the fence. `next`, `task_update`, worktree `setup`/`diff`,
  `handoff` and `report` auto-renew when the caller is the owner/descendant.
  Tenure is bounded at **60 minutes or 20 renewals**; past that the claim is
  forced `expired` and `needs-inspection`.
* **Side-effect baseline.** Captured at the `worker_active` transition (after
  worktree setup, not at `next`):
  * a git worktree fingerprint (`baseSha`, `headSha`, `diffHash`, `statusHash`,
    bounded untracked digest, `fingerprint`);
  * a verifier claim uses the artifact scope `verify/report-<taskId>.json`
    (+ `challenge-*.json` / `audit-*.json`); `document-review` uses the task's
    segment dir + `DOCUMENT_REVIEW_REPORT.md`; LEMMA uses `lemma/nodes/<id>/`.
  Untracked scans are bounded to **1000 files / 8 MiB** and return `unknown`
  when exceeded. `unknown` or a missing baseline is `needs-inspection`, never a
  clean reclaim.
* **Reclaim decision.** Unchanged fingerprint → clean reclaim with `fence++` and
  `previousClaimant`/`history` recorded. Changed / unknown / missing /
  `needs-inspection` → `needs-inspection`. A cross-host claim is never reclaimed
  automatically. Released/adopted/requeued/blocked claims keep a bounded
  task-level `claimHistory`: `claim.history` is merged into `task.claimHistory`
  before `claim` is deleted, and a later claim rehydrates its `history` from the
  task-level chain, so release → reclaim → release never erases an earlier
  claimant. The chain is capped at 5 entries. A terminal
  `teamwork_task_update` emits `claim_released`.
* **Recovery (`teamwork_recover`).** `team/sentinel` or `team/orchestrator`,
  from the run root or a descendant. `inspect` returns claim, baseline and
  observed fingerprints, diffstat, commits, dirty/untracked paths, and writes a
  **single-use 10-minute token, stored only as a SHA-256 hash**, in
  `task.inspection`. The token is bound to `(round, fence, claim.by)`; `recover`
  also accepts an optional `fence`, and any mismatch is `INSPECTION_STALE`.
  `adopt`/`requeue`/`block` require that token and re-check
  the fingerprint; a change is `INSPECTION_STALE`. `adopt` only accepts a clean
  committed branch whose baseline head is an ancestor, marks `worker_done` with a
  `checkpoint`, and **makes no commit**. `requeue` needs the fingerprint to equal
  the baseline, or `force: true` + `confirm: true` to discard the unverified
  state (no files are deleted and nothing is committed). `discard` needs
  `force` + `confirm`. `release` of a cross-host claim is refused unless
  `allowCrossHost: true` or `TEAMWORK_ALLOW_CROSS_HOST=1` **and** `confirm: true`.
  Events: `claim_renewed`, `claim_reclaimed`, `claim_released`,
  `claim_inspection_required`, `claim_recovered`, `claim_override`.
* `teamwork_task_update` to `worker_active` still requires a live claim. Only
  `team/sentinel`/`team/orchestrator` may start an unclaimed task; that override
  is recorded on the claim (`"override": "sentinel"`). `worker_done` and every
  terminal state (`verified_pass`, `verified_fail`, `blocked`) release the claim,
  as does a return to `pending`.
* `teamwork_status` and `teamwork_next` surface claims (`status.claims`,
  `readyForWorker[*].claim/fence`, `inProgress[*].claim/claimState/fence`). A
  lease is coordination, not authentication: role/session-tree authorization
  still comes from `authorize.ts`.
* **Verifier reports are bound.** `teamwork_report` records `round`, `fence`,
  `branch`, `baseSha`, `headSha`, `diffHash` and `bound`. `verified_pass` requires
  the report round to equal the task round and refuses a moved head/diff with
  `BRANCH_MOVED`; `worktree merge` refuses a verified report whose head no longer
  matches the branch. A legacy report without these fields is accepted with a
  `legacy_unbound_report` warning; it is never silently treated as current.
  A plan may set `requireReportBinding: true` (sticky, default off) to make an
  unbound PASS unconsumable: `teamwork_report` and `final_verify` refuse it with
  `REPORT_UNBOUND`. A check whose `exitCode` contradicts `passed` is refused by
  name (`CHECK_EXIT_CONFLICT`). The report digest is read at one shared cap
  (1 MiB) by `final_verify`, the strict wave and the victory audit; a PASS
  artifact with no readable digest is rejected, never recorded as `null`.
  A strict wave verdict that provides `cites` must cite at least one artifact;
  `cites: []` is **unbound** and fails the gate (an absent field is the legacy
  shape and only warns).
* **Worktree host/claim guards.** `setup` records the baseline and renews the
  claim; `diff` returns `HEAD`/`baseSha`/`diffHash`; `cleanup` refuses while any
  claim is `live`, `expired` (inside grace), `needs-inspection`, or `cross-host`
  (only a stale claim is recoverable). `opencode-teamwork prune` uses the **same
  predicate** (one shared `claim-state.mjs`): it refuses a run directory whose
  state has any blocking claim, and an unreadable `state.json` also refuses
  (an unreadable claim is not proof that no claim exists). `--force` proceeds
  only with an explicit operator warning and records the blocking claims and
  the reason in the result; it never runs silently. `setup`/`merge`/`resolve`/`cleanup`
  refuse when `state.host` differs from this host, unless
  `allowSharedWorktrees: true` — and never when the plan set
  `requireSameHost: true`. `TEAMWORK_ALLOW_CROSS_HOST` stays `0` by default for
  claim release.

Resume: re-read `state.json`, skip tasks already `verified_pass`, continue the current
`round` for `verified_fail`/`worker_active`/`worker_done`.

**Cumulative feedback ledger (`feedbackLog`).** `feedback` holds only the latest
round, so it is lossy across repeated review rounds. Each task may therefore also
carry `feedbackLog`, an ordered array of per-round entries:

| Field | Type | Meaning |
| --- | --- | --- |
| `round` | integer | The task round the feedback was recorded in. |
| `at` | string | ISO 8601 time the entry was written. |
| `text` | string | The feedback, sanitised with `clean()` and capped at 500 chars. |
| `resolved` | boolean | `true` once the verifier accepted the work. |

Every `teamwork_task_update` call carrying a non-empty `feedback` appends one
entry with `resolved: false`; existing entries are preserved, never overwritten.
The array is capped at **20 entries**: when a 21st would be added, the oldest is
dropped, so state stays bounded. A task that has never failed has no
`feedbackLog` field at all.

`verified_pass` marks **every** existing entry `resolved: true` in the same write
that records the transition, so no second tool call is needed. `verified_fail`
leaves existing entries unresolved; the verifier's new feedback is appended as
another unresolved entry. `feedback` continues to hold the latest round only and
is unchanged by this ledger.

`teamwork_next` surfaces the unresolved set to the next worker: for each
`readyForWorker` entry, `feedback` is the newline-joined list of
`R<n>: <text>` for every entry with `resolved: false`, oldest first, capped at
2000 characters (truncated with `…`). Runs written before the ledger existed — or
a task with an absent/empty `feedbackLog` — fall back to the single `feedback`
field, exactly as before.

### `BRIEFING.md` — shared run briefing (continuity)

One briefing per run, written by `teamwork_plan` after `plan.dag.json`,
`state.json`, and `costs.json`, then refreshed on `teamwork_task_update`,
`teamwork_security_audit`, `teamwork_final_verify`, `teamwork_victory_audit`,
and `teamwork_next` phase changes. It is a *shared* run artifact: per-agent state
roots are not supported on this host (ADR 0003), so the briefing is the
continuity record a fresh agent session starts from.

```markdown
# BRIEFING — 2026-01-12T10:15:00.000Z

## Mission
<verbatim request, bounded and sanitised; or the spec title>

## Identity
- Session: 20260112-101500-a1b2
- Topology: distributed-coding
- Integrity mode: development
- Verification mode: standard|strict
- Victory audit mode: required|skip
- Budget: $20

## Key Constraints
- no edits outside the worktree, no publish/PR, strict + victory requirements

## Project Status
- Phase: DISPATCH
- Tasks: 3 total — pending 2, active 1, verified_pass 0, failed 0, blocked 0
- Gate (strict): PASS|FAIL|MISSING        # strict runs only
- Victory: CONFIRMED|REJECTED|PENDING|SKIPPED (with the recorded reason when explicit); a semantic CONFIRMED whose `verify/victory.json` has no `_auth` envelope is rendered `CONFIRMED (unverified envelope)`

## Artifact Index
- plan.dag.json
- state.json
- ORIGINAL_REQUEST.md
- requirements.json
- verify/final.json          # when present
- GATE_STATUS.md             # when present

## Succession
- Not supported on this host (ADR 0003); continuity is this briefing.
```

The file is capped at **16 KiB** (UTF-8), every interpolated value is sanitised
(control characters removed, mission headings defused), the write is atomic and
refuses a symlink, and an unchanged refresh does not rewrite it. A failed
refresh never fails the primary tool call; it is recorded as a
`briefing_warning` event. `session.context` injects only the first **4 KiB**,
explicitly marked as the run briefing and truncated when longer. Legacy runs
without a briefing behave exactly as before.

### `handoffs/` — canonical five-section agent handoffs

Written only through `teamwork_handoff`. A handoff is the narrative record one
agent leaves for the next one, and it always stands on its own. The path is
derived from the trusted caller and the scope — never supplied by the agent:

| Caller role | Scope | Artifact |
| --- | --- | --- |
| `team/worker`, `team/proof-worker`, `team/segment-reviewer`, `team/synthesizer`, `team/verifier`, `team/falsifier` | task (`taskId` required, must exist in plan/state) | `<run>/handoffs/<taskId>-<role>.md` |
| `team/security-auditor` | task (strict per-task audit) or run-level (pre-merge audit) | `handoffs/<taskId>-security-auditor.md` / `handoffs/_run-security-auditor.md` |
| `team/victory-auditor`, `team/sentinel`, `team/orchestrator` | run-level only (`taskId` omitted or `_run`) | `<run>/handoffs/_run-<role>.md` |

The tool has no `agent` input: it uses `deriveCallerAgent` plus descent from the
plan-time `rootSessionId`. Every handoff has exactly these five headings:

```markdown
# HANDOFF — <taskId|_run> — team/<role>

- Run: <run id>
- Agent: team/<role>
- Agent session: <OpenCode session id>
- Task: <taskId|_run (run-level)>
- Round: <n>
- Generated: <ISO 8601>
- Citations: <path (sha256 …) | none>

## 1. Observation
What you actually saw and ran: concrete paths, commands, outputs, diffs, failures.

## 2. Logic Chain
How the observation leads to the conclusion, step by step, with no leap of faith.

## 3. Caveats
What you did not check, assumptions made, and remaining risks or open questions.

## 4. Conclusion
The decision or run state the next agent must act on (done, blocked, needs re-scope).

## 5. Verification Method
How to reproduce or independently check the conclusion: the exact command, test, or artifact.
```

Every section is required and non-empty after sanitisation. Control characters
are stripped and line-leading ATX headings are defused, so a section body cannot
forge another section. Caps are **2 KiB per section** and **8 KiB for the five
bodies**; oversize is refused, never silently truncated. Writes are atomic
(`O_EXCL` temp + rename), refuse symlinks/FIFOs, and stay inside the run dir.

`cites` is derived from the caller role when the artifact exists, and is a
citation only — it is never read as a verdict:

| Role | Cited artifact |
| --- | --- |
| verifier (task) | `verify/report-<taskId>.json` |
| falsifier (task) | `verify/challenge-<taskId>.json` |
| security-auditor (task) | `verify/audit-<taskId>.json` |
| security-auditor (run-level) | `verify/security-audit.json` |
| victory-auditor (run-level) | `verify/victory.json` |

`handoffs/index.json` is the bounded index, serialised through the same
cross-process `<artifact>.lock` (plus in-process queue) as the cost/state
writers. It keeps one latest entry per
`(taskId, agent)` (a rewrite replaces in place), at most **200 entries** and
**256 KiB**, with run-relative paths only:

```json
{
  "version": 1,
  "sessionId": "20260112-101500-a1b2",
  "updatedAt": "2026-01-12T10:20:00.000Z",
  "entries": [
    {
      "taskId": "T1",
      "agent": "team/worker",
      "agentSessionId": "ses_…",
      "round": 2,
      "path": "handoffs/T1-worker.md",
      "sha256": "<64 hex of the exact file bytes>",
      "bytes": 1234,
      "generatedAt": "2026-01-12T10:20:00.000Z",
      "cites": [{ "path": "verify/report-T1.json", "sha256": "<64 hex>" }],
      "runKeyId": "k_...",
      "_auth": {
        "v": 1,
        "alg": "hmac-sha256",
        "keyId": "k_...",
        "path": "handoffs/T1-worker.md",
        "digest": "sha256",
        "mac": "sha256",
        "at": "2026-01-12T10:20:00.000Z"
      }
    }
  ]
}
```

On a signed run the index entry — not the markdown — carries the provenance.
The markdown bytes stay exactly as documented above (five headings, metadata,
sanitised bodies). `_auth` is an ordinary [ADR 0005](#_auth-envelopes-and-the-digest-index-adr-0005)
envelope over the canonical payload

```json
{
  "kind": "teamwork.handoff",
  "v": 1,
  "runId": "<run id>",
  "runKeyId": "k_...",
  "taskId": "T1",
  "agent": "team/worker",
  "agentSessionId": "ses_…",
  "round": 2,
  "path": "handoffs/T1-worker.md",
  "sha256": "<64 hex of the exact file bytes>",
  "bytes": 1234,
  "generatedAt": "2026-01-12T10:20:00.000Z",
  "cites": [{ "path": "verify/report-T1.json", "sha256": "<64 hex>" }]
}
```

so the signature binds the run, writer, scope, body hash, byte length, round and
citations, and the digest-index record lives at
`auth/run/<runId>/handoffs/<taskId|_run>-<role>.md`. A present `_auth` that does
not verify (edited entry field, copied envelope within or across runs, unknown
key, missing index record) fails the checked gate as `[AUTH_*]`. On a run whose
manifest pins `handoffAuth: "signed"` an absent envelope is
`[AUTH_MISSING]`; a legacy run tolerates an unsigned entry. Re-recording through
`teamwork_handoff` signs the new entry and upgrades that pair.

`teamwork_handoff` appends a `handoff_recorded` event. Handoffs are continuity
evidence, never a second verdict authority: the gate checks file identity,
index hashes, citation hashes, and provenance only, and never parses the prose
for PASS/FAIL. A handoff can therefore make a run fail (missing/stale evidence)
but never make one pass.

**Required matrix (`requireHandoffs: "required"`).** Derived from
`plan.dag.json`/`state.json`, never from caller claims:

| Required handoff | Scope |
| --- | --- |
| task's assigned worker agent (`team/worker`, `team/proof-worker`, `team/segment-reviewer`, or `team/synthesizer`) | one per plan task |
| `team/verifier` | one per plan task |
| `team/falsifier` | one per plan task when `verification: "strict"` |
| `team/security-auditor` | one per plan task when `verification: "strict"` |
| `team/sentinel` **or** `team/orchestrator` | exactly one run-level (`_run`) |
| `team/victory-auditor` | one run-level, recorded after `teamwork_victory_audit`, when `victoryAudit: "required"` is confirmed |

For each required `(taskId, agent)` exactly one latest index entry must exist.
The gate verifies the markdown path is run-relative, the file exists as a
regular non-symlink, the sha256 and byte length match the index, the canonical
`# HANDOFF — <taskId> — team/<role>` header agrees with the entry, and every
citation hash still matches the current artifact. A verifier handoff cites
`verify/report-<taskId>.json`, a falsifier handoff cites
`verify/challenge-<taskId>.json`, a task security auditor cites
`verify/audit-<taskId>.json`, and the victory auditor cites `verify/victory.json`.
**Provenance:** `final_verify` and `next` use the checked gate, which also
verifies every present entry's `_auth` (path, payload digest, MAC, run id, key
id) and requires `entry.runKeyId === run.manifest.json.runKeyId`. On a
`handoffAuth: "signed"` run an unsigned required entry is `[AUTH_MISSING]`; on a
legacy run unsigned entries are tolerated but a present-and-invalid `_auth` is
rejected. Auth failures are appended as `[AUTH_*]` reasons and map to
`INVALID` / `BLOCKED_BY_HANDOFFS`; they never change a PASS computed from the
structural checks.
**Stale semantics:** any change to a cited report/wave/audit/victory after the
handoff was recorded makes that handoff stale; the task must be re-verified and
the affected handoffs re-recorded. Duplicate entries, unknown tasks/roles, a
header/task mismatch, a hash mismatch, or a symlink fail the gate. `final_verify`
records the required pairs and the matched entries (path, sha256, agent, task,
`auth`, `keyId`) under `evidence.handoffs`, and strict `GATE_STATUS.md` cites
them in `## Continuity` with an `Auth` column. `requireHandoffs: "skip"` records
`handoffs: "SKIPPED (explicit)"` in `verify/final.json` and never reads the
index.

### `agents/` — per-agent briefings

The `session.context` hook writes a per-agent copy of the shared briefing when
the caller is known (`event.agent` + `event.sessionID`):

```
<run>/agents/<agentSlug>-<sha256(sessionID).slice(0,32)>/BRIEFING.md
```

The directory name must match `^[a-z][a-z0-9-]{0,31}-[0-9a-f]{32}$`; the raw
OpenCode session id (up to 68 chars) is never used as a path. The file is built
from the same briefing data as `BRIEFING.md`, with these extra Identity lines:

```markdown
## Identity
- Session: 20260112-101500-a1b2
- Agent: team/worker
- Agent session: ses_…
- Run session: 20260112-101500-a1b2
- Topology: distributed-coding
…
```

It is capped at **16 KiB**, written atomically with symlink/FIFO refusal, and
refreshed lazily: a regular, non-symlink copy whose mtime is at least as new as
`state.json`, `plan.dag.json`, and `costs.json` is left untouched. At most **64**
correctly named real directories are kept (oldest pruned; symlinks and other
entries are never touched). Any write/read failure is fail-open: the hook falls
back to the shared briefing, and legacy runs without `agents/` behave exactly as
before. `describeRun` marks the per-agent excerpt as an “agent briefing” and the
shared one as a “run briefing”; both inject the first 4 KiB with a truncation
note. `teamwork_plan` records `run-by-root/<root session id>` in `ctx.storage`;
the hook walks the caller's bounded `parentID` chain to that root, then uses the
mapping. An unresolvable mapping keeps the legacy newest-run behaviour.


### Engine Tools

The plugin provides deterministic orchestration tools for the Sentinel coordinator:
- `teamwork_plan`: Creates the run directory and writes `plan.dag.json`, `state.json` and `costs.json`. It is gated on a spec by default (`requireSpec`, see below). `skipInterview` is the explicit, recorded bypass. `verification` selects `standard` (default, unchanged) or `strict` (per-task falsifier challenge + security-auditor audit); it is persisted in both artifacts and a re-plan cannot change it.
- `teamwork_route`: Deterministic read-only route classifier checking `document-review` FIRST (before Math/Proof) when a supplied document has critique intent while rejecting PR/code reviews, bare filenames without supplied docs, and problem-solving/coding tasks.
- `teamwork_document_triage`: Validates bounds (`maxSegments <= 8`, `reviewTreeShape <= [4,2,1]`, `synthTreeShape <= [4,1]`), path containment (`realpathSync` + `O_NOFOLLOW`), URL/inline limits, and PDF headers **before** creating any directory, ingests and partitions the document into `seg-01`..`seg-0K` + `doc-synthesis`, and writes `document-review/{manifest.json,DOCUMENT_TEXT_MAP.md,ANALYSIS_PARTITION.md}`. A `document.url` is fetched only through the SSRF guard: http/https only, public addresses only, pinned DNS, no automatic redirects, 3 s timeout, 16 MiB cap (see “URL network policy” below).
- `teamwork_document_record`: Persists bounded RSA node outputs (`level-<L>-node-<I>.json`), `unit-report.md`, `synthesis/candidate-<I>.md`, and `DOCUMENT_REVIEW_REPORT.md` with `SEGMENT_ID` allowlist, manifest bounds, symlink refusal, and `clean()`/`cleanBlock()` sanitisation.
- `teamwork_next`: Evaluates the DAG dependencies against current task lifecycle statuses. Categorizes tasks into `readyForWorker`, `readyForVerifier`, `inProgress`, or terminal conditions (`ALL_TASKS_PASSED` / `DEADLOCK`). Completion additionally requires a stamped `verify/final.json` from `teamwork_final_verify` (unless the caller passes the recorded `allowUnstamped: true` legacy bypass) **and** a `CONFIRMED` `verify/victory.json` bound to the current `ORIGINAL_REQUEST.md`, unless the plan explicitly recorded `victoryAudit: "skip"`. When `requireHandoffs: "required"`, it also recomputes the continuity matrix and returns `NEEDS_HANDOFFS` (missing `taskId:agent` pairs) or `BLOCKED_BY_HANDOFFS` (stale/duplicate/unknown/tampered) before `ALL_PASSED`; a stale final verdict still returns `AUTH_STALE` first. On a signed run the final verdict, security audit, reports, victory verdict, and strict-wave verdicts must all verify against their `_auth` envelopes and digest-index entries; any evidence changed since `final_verify` returns `AUTH_STALE`. An unsigned legacy run returns `AUTH_LEGACY` until `allowUnsignedLegacy: true` is passed (recorded as an event). Before a confirmed verdict it returns `READY_FOR_VICTORY_AUDIT` (or `BLOCKED_BY_VICTORY_AUDIT` for a rejection). In strict mode it returns `NEEDS_STRICT_WAVE` / `BLOCKED_BY_STRICT_WAVE` first, listing the missing `taskId:kind` pairs, and never returns `ALL_PASSED` without both per-task verdicts.
- `teamwork_task_update`: Enforces deterministic state transitions, tracks worker branch names and diff summaries, updates verifier metrics, and advances run `phase` to `MERGE` or `PRESENT_PARTIAL`.
- `teamwork_report`: Trusted writer for `verify/report-<taskId>.json`. Only a session whose trusted agent resolves to `team/verifier` and that descends from the run's `rootSessionId` may call it; the task must exist in `plan.dag.json`, and a `PASS` needs a summary or at least one check. The report is signed for a signed run; `final_verify` requires that signature. A wrong agent, missing task, or evidence-free PASS is refused.
- `teamwork_victory_audit`: Records the independent final acceptance verdict from `team/victory-auditor`. Only a trusted session whose agent resolves to `team/victory-auditor` **and that descends from the run's `rootSessionId`** may call it; there is no caller-supplied `agent` label. Every `requirements.json` id must appear exactly once, `met: true` needs non-empty evidence, and `VICTORY CONFIRMED` needs a current `ORIGINAL_REQUEST.md` (the verdict stores its sha256 and the `requirementsHash`). Writes signed `verify/victory.json`; a confirmed verdict is write-once.
- `teamwork_wave_record`: Strict mode only. Records one wave verdict: `kind: "challenge"` / `verdict: "PASS"` may only be written by a trusted session whose agent resolves to `team/falsifier`; `kind: "audit"` / `verdict: "CLEAN"` only by `team/security-auditor`. There is no caller-supplied `agent` label. It refuses a task absent from `plan.dag.json`, a missing/non-PASS `verify/report-<taskId>.json`, any other verdict, and a repeat recording for the same report hash. It stores the sha256 of the exact report bytes (the gate requires a match) and writes `verify/challenge-<taskId>.json` or `verify/audit-<taskId>.json` atomically, then appends a `verification_wave` event. A changed report is the only overwrite path (the previous verdict is stale).
- `teamwork_handoff`: Trusted writer for the canonical five-section handoff (`handoffs/<taskId|_run>-<role>.md`). The trusted session agent and run-root descent decide the role; there is no caller-supplied `agent`. Task-scoped roles must name an existing task, while `team/victory-auditor`, `team/sentinel`, and `team/orchestrator` record run-level handoffs (`taskId` omitted or `_run`). Every section is required and bounded (2 KiB/section, 8 KiB total), control characters are stripped and headings defused, and the bounded `handoffs/index.json` keeps one latest entry per `(taskId, agent)`. On a signed plan the index entry carries an `_auth` envelope over run/writer/scope/body-hash/cites (`handoffAuth: "signed"`); a signing failure refuses the write and records no unsigned entry. Citations to existing verifier/audit/victory artifacts are recorded, never treated as verdicts, so this tool never changes `final_verify`/`next` outcomes.
- `teamwork_final_verify`: Computes the run's final verdict from the artifacts on disk — every task must be `verified_pass`, every `verify/report-<taskId>.json` must be `PASS`, `verify/security-audit.json` must be `PASS`, the victory audit must be `CONFIRMED` (unless explicitly skipped), the continuity matrix must be complete when `requireHandoffs: "required"`, and when `document-review/manifest.json` exists, every segment's `unit-report.md` and `DOCUMENT_REVIEW_REPORT.md` must exist as non-empty regular files. On a signed run each report, audit, wave verdict, and victory verdict must verify against `_auth` + the digest index, and the current plan/request/requirements/policy/handoff-mode hashes must match `run.manifest.json` (`AUTH_STALE` on drift). In strict mode it also requires `verify/challenge-<taskId>.json` (`team/falsifier`, `PASS`) and `verify/audit-<taskId>.json` (`team/security-auditor`, `CLEAN`) for every task, then writes `GATE_STATUS.md` with its `## Continuity` section. It writes signed `verify/final.json` (including `requirementsHash`, per-report digests, the audit digest, `handoffs`, and `evidence.handoffs`) atomically and appends a `final_verification` event. The verdict is computed from evidence; no input can turn a failing run into `PASS` (a caller-supplied `failReason` can only force `FAIL`, and handoff prose is never parsed). An unsigned legacy run returns `AUTH_LEGACY` unless `allowUnsignedLegacy: true` is explicitly passed. See [`verify/final.json`](#verifyfinaljson-final-verification-verdict).
- `teamwork_worktree`: Isolates git worktrees outside the project repo (`setup` for sentinel and worker), inspects branch diffs (`diff`), performs clean merges into `teamwork/base-$SESSION_ID` with automatic conflict abort (`merge`), and prunes worktrees (`cleanup`).
- `teamwork_preflight`: Re-checks the inputs named by an existing run's `ORIGINAL_REQUEST.md` (plus optional `inputs`), writes `<run>/preflight.json`, and appends a `preflight` event. It never throws and never blocks; it reports.

**Spec presence gate (`teamwork_plan`).** A run must start from a spec
artifact: `<run>/prompt_draft.md`, present and non-empty after trimming. This is
a **presence** check, not an approval check — the engine cannot prove the user
reviewed or approved the file. The check runs after topology/task-id validation
and **before anything is written**, so a refusal creates no run directory and no
plan files. Two inputs control it:

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `requireSpec` | boolean | `true` | When true, a usable `prompt_draft.md` must exist or the plan is refused. `false` records `specGate: "not_required"`. |
| `skipInterview` | boolean | `false` | Explicit bypass: plan without a prompt file. Recorded as `specGate: "bypassed"`, and the tool result says so. |

Both inputs are **caller-controlled and recorded; they are not proof of user
approval**. With no spec and neither override, the call is refused with an
actionable message naming the expected path, `/teamwork-craft`, and
`skipInterview: true`. A whitespace-only `prompt_draft.md` counts as no spec.

`human-approved`/`ci-attested` go beyond the presence gate: a version-3 plan
requires the external approval to bind the **exact draft bytes**
(`specHash`/`specBytes`), the run id, and a one-use nonce. `skipInterview` does
not bypass that binding (the approval is refused with
`AUTH_APPROVAL_INCOMPLETE` when no draft exists), and a draft containing
`[OPEN:` cannot be planned. The approval can be produced with
`opencode-teamwork approve request`/`sign` **before** the plan; see ADR 0011.

**Request record & integrity mode (`teamwork_plan`).** Two additive, optional inputs:

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `request` | string | omitted | The verbatim text the run was routed on (≤20,000 chars). Recorded once in `ORIGINAL_REQUEST.md` before any plan file; omitting it creates no artifact. |
| `integrityMode` | `development \| demo \| benchmark` | `development` | Recorded in `ORIGINAL_REQUEST.md`, `state.json` and `plan.dag.json`. Any other value refuses the plan before anything is written. |
| `verification` | `standard \| strict` | `standard` | Recorded in `plan.dag.json` and `state.json`. `strict` adds exactly one `team/falsifier` challenge (`PASS`) and one `team/security-auditor` audit (`CLEAN`) per task. Any other value refuses the plan before anything is written; a re-plan may omit or repeat the persisted mode but not change it. |
| `requirements` | `Array<{id, text}>` | omitted | Up to 50 plan-time requirements. `id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` and must be unique; `text` is non-empty and ≤2,000 chars. Persisted to `requirements.json` (source `caller`). Invalid/duplicate items refuse the plan before anything is written. |
| `victoryAudit` | `required \| skip` | `required` when a request/requirements baseline exists | Recorded in `plan.dag.json`, `state.json` and the signed `run.manifest.json`. A run with no request and no requirements records the legacy default `skip`; `required` without a baseline is refused. An explicit `skip` requires `victorySkipReason` (non-empty, trimmed, ≤500 chars, sanitized) and makes `final_verify` record `victory: "SKIPPED (explicit): <reason>"`. A re-plan may repeat but not change the mode or reason; `benchmark` refuses skip. |
| `requireHandoffs` | `required \| skip` | `required` for a new run with a request/requirements baseline; `skip` for legacy/unsigned runs | Recorded in `plan.dag.json`, `state.json`, and the signed `run.manifest.json`. `required` makes `final_verify` and `next` demand the continuity matrix. An explicit `skip` is recorded (surface in `verify/final.json` as `handoffs: "SKIPPED (explicit)"`). A re-plan may repeat but not change the mode. `benchmark` refuses `skip`; a run that cannot be signed records `skip` under `allowUnsignedLegacy`. |

The request record is a separate artifact from the approved spec: it does not
satisfy the spec presence gate, and the spec presence gate does not replace it. `teamwork_security_audit`
and the final-verification gate read the mode back from `ORIGINAL_REQUEST.md`.

**Input preflight (`teamwork_plan`).** Before anything is written, the plan
inventories the inputs the request names and checks them. The inventory comes
from the explicit `inputs` array (highest trust) plus the routed `request`
(when provided): URLs, and path tokens. It is deduplicated, keeps first-seen
order, and is capped at 100 items.

The block list is deliberately **narrow**:

| Item | Blocking? | Check |
| --- | --- | --- |
| Explicit `inputs` entry | yes (even a relative path) | path or URL as classified |
| URL (`/https?:\/\/[^\s)>\]}"']+/g`) | yes | `UNCHECKED` unless `checkUrls` |
| Token starting `/`, `~/` or `file://` | yes | local path |
| Other path-like token (contains `/`, no whitespace, not a URL) | **no — advisory** | local path, reported only |

Path checks report `READY` (with `file`/`dir`) when the path exists and
`MISSING` otherwise. URL checks record `UNCHECKED` when `checkUrls` is false
(the default); with `checkUrls: true` each URL is first validated by the SSRF
guard (`url-guard.ts`), then gets one `HEAD` request with a 3 s timeout and is
`READY` on 2xx/3xx or `OUTAGE` on any other status, error or timeout. A URL whose
hostname resolves to loopback/private/link-local/metadata (or any other
non-public address) is `OUTAGE` before a connection is made; a 3xx `Location` is
validated too, so a redirect cannot point at a blocked address. Redirects are
not followed. The overall status is `OUTAGE` if any check is an outage, else
`MISSING` if any **blocking** item is missing, else `READY`. Advisory misses
never change the overall status.

**URL network policy.** Plugin URL ingress accepts only `http`/`https` and
rejects embedded credentials. The guard resolves the hostname, rejects
loopback, private, carrier-grade NAT, link-local (including
`169.254.169.254`), unspecified, multicast, reserved, documentation, 6to4,
Teredo, unique-local, and IPv4-mapped/compatible IPv6 addresses, and pins the
connection to the validated address so a second DNS answer cannot rebind it.
Response bodies are capped (16 MiB for document ingestion) and requests time
out after 3 s. `OPENCODE_TEAMWORK_ALLOW_LOCALHOST=1` is an explicit
test/development opt-in that permits loopback only; the default is deny.

Three additive, optional plan inputs control the gate:

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `inputs` | string[] | omitted | Extra blocking files/URLs to check (relative entries block too). |
| `checkUrls` | boolean | `false` | When false URLs are `UNCHECKED`; when true they are HEAD-checked. |
| `allowMissingInputs` | boolean | `false` | Explicit bypass when the status is `MISSING`/`OUTAGE`. Recorded as `preflight: { status, bypassed: true }` in `plan.dag.json` and as a `run_created` `note`. |

When the overall status is `MISSING` or `OUTAGE` and `allowMissingInputs` is
not `true`, the plan is **refused** with each blocking item and its status, and
nothing is written (no run dir, no `ORIGINAL_REQUEST.md`, no plan files). When
`request` and `inputs` are both absent the gate is skipped and `plan.dag.json`
records `preflight: { status: "SKIPPED" }`; otherwise it records
`{ status, bypassed }`.

### `preflight.json` — input-checks report

Written by `teamwork_preflight` for an existing run (`teamwork_plan` records
the summary inline in `plan.dag.json` instead). The inventory is re-read from
this run's `ORIGINAL_REQUEST.md` plus the tool's optional `inputs`.

```json
{
  "checkedAt": "2026-01-12T10:20:00.000Z",
  "integrityMode": "development",
  "items": [
    { "value": "/abs/path/spec.md", "kind": "path", "blocking": true, "advisory": false, "status": "READY", "detail": "file" },
    { "value": "docs/draft.md", "kind": "path", "blocking": false, "advisory": true, "status": "MISSING" },
    { "value": "https://example.com/issue/1", "kind": "url", "blocking": true, "advisory": false, "status": "UNCHECKED", "detail": "checkUrls: false" }
  ],
  "summary": {
    "status": "READY",
    "total": 3,
    "blocking": 2,
    "missing": 1,
    "blockingMissing": 0,
    "advisoryMissing": 1,
    "outage": 0,
    "unchecked": 1
  }
}
```

`summary.status` uses the same rule as the plan gate: `OUTAGE` beats `MISSING`
beats `READY`, and advisory misses never change it. The tool also appends a
`preflight` event (`to` is the status) with a `note` when any item is missing or
unreachable. It reports; it does not block a run.

### `costs.json`

```json
{
  "sessionId": "...",
  "budgetUsd": 20,
  "budgetSource": "credits|default|manual",
  "spentUsd": 0,
  "byTask": {},
  "byTaskTokens": {},
  "appliedSnapshotDigest": "sha256 hex of the last applied usage observation",
  "appliedSnapshotAt": "ISO8601",
  "snapshotCursors": {
    "ses_abc123": {
      "lastCost": 0.62,
      "lastTokens": { "input": 1200, "output": 640, "reasoning": 0, "cache": { "read": 300, "write": 40 } },
      "agent": "team/sentinel",
      "timestamp": "ISO8601"
    }
  },
  "lastCostUpdate": {
    "at": "ISO8601",
    "source": "opencode session tree (...)",
    "digest": "sha256 hex",
    "skippedDuplicate": false
  },
  "updatedAt": "ISO8601"
}
```

`appliedSnapshotDigest` is the idempotency key for native snapshot updates. The
digest is a stable sha256 over the observed session id, agent, cost, and token
totals. When `teamwork_cost` observes the **same** digest again (for example a
retry after the process crashed between the costs write and the snapshots write,
or an immediate second call), it adds no cost/token delta and records
`lastCostUpdate.skippedDuplicate: true`. `snapshotCursors` is the authoritative
per-session delta baseline; `snapshots.json` remains a compatibility view and is
refreshed after `costs.json`, but a missing/stale copy cannot double-count.
Manual `addUsd` calls have no snapshot digest and are recorded without touching
either digest or cursors.

`byTask` maps a bucket name to its cumulative spend in USD. `byTaskTokens` is an
additive key (added after the original schema) keyed by bucket name. Both are
updated in the same locked section, but their key sets are **not** guaranteed to
be identical: every `byTaskTokens` key is also a `byTask` key, while a `byTask`
bucket can have spend and no `byTaskTokens` entry (see the all-zero case below):

```json
{
  "byTask":       { "R1-impl": 0.1234 },
  "byTaskTokens": { "R1-impl": { "input": 1200, "output": 640, "reasoning": 0, "cache": { "read": 300, "write": 40 } } }
}
```

Each `byTaskTokens` bucket holds integer token deltas (current session totals
minus the per-session `lastTokens` recorded in `costs.snapshotCursors`, mirrored
in `snapshots.json`), the same way cost deltas are computed. A `costs.json`
without `byTaskTokens` is valid: readers treat it as absent. The manual `addUsd`
path has no token data, so it adds dollars to `byTask` only and leaves
`byTaskTokens` untouched. The session-global `tokens` total is unchanged.

A token delta whose five components are all zero (for example, a session whose
cost rose but whose tokens did not change) is skipped **before** either map is
touched. In that case the bucket still gains its spend in `byTask` but gets no
`byTaskTokens` key. Readers must treat a missing `byTaskTokens[<bucket>]` as "no
token data", not as zero.

**Bucket names are safe map keys.** A `taskId` must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Both `teamwork_plan` (task ids and
`dependsOn`) and `teamwork_cost` (`taskId`) refuse anything else, so ids such as
`__proto__` or `a/b` are never stored. `byTask`, `byTaskTokens` and `state.tasks`
are null-prototype maps in memory, so an id such as `constructor` is an ordinary
key. The allowlist is the guard; `clean()` alone does not prevent these ids.

**Bucketing rule.** Each session in the run's tree is assigned a bucket when
`teamwork_cost` finds spend for it:

1. The calling session, when `taskId` is supplied → `taskId`.
2. A root session (the run's sentinel) → `taskId` if supplied, else `_sentinel`.
3. Any other (non-root, e.g. worker or verifier) session → `taskId` if supplied,
   else its agent name (the legacy behaviour), else `_unattributed`.

So when the sentinel calls `teamwork_cost({ taskId })` at a task boundary, the
spend of the worker and verifier sessions lands on **that task**. Without a
`taskId`, subagent spend is still bucketed by agent name, exactly as before.

**Per-task attribution requires the sentinel to call it.** Per-task cost and
tokens only populate for runs whose sentinel called `teamwork_cost({ taskId })`
after each worker return and each verifier report. Spend recorded by calls made
without a `taskId` stays in agent-name or `_sentinel` buckets.

**Timeline `tokens`.** The timeline view (`lib/timeline.mjs`) reports each task's
`tokens` as `costs.byTaskTokens[<taskId>]`, when that bucket exists and holds
finite numbers. It is `null` otherwise, and **always `null` for any run recorded
before `byTaskTokens` existed**. Per-task token counts are not reconstructed for
older runs.

When the session uses `opencode/` (managed) models and the `opencode_console`
MCP is connected, `teamwork_budget` tells the sentinel to derive `budgetUsd`
from console credits (`opencode_console_get_usage` →
`min(limitDollars - spentDollars)`), after asking the user whether to use the
full remaining budget or a partial (half) amount. `budgetSource` records where
the budget came from.

Cost and token consumption are read directly from OpenCode, not self-reported.
The engine discovers the full OpenCode session tree rooted at the run's sentinel
session (`opencode.db` SQLite tree query, background service API, or client get),
aggregating the root session and all child/subagent sessions (workers, verifiers,
scouts, auditors). Deltas between calls are tracked by the authoritative
`costs.snapshotCursors` map (and mirrored in `snapshots.json`). When native
discovery is unavailable (tests, non-OpenCode host) the tool falls back to manual
`addUsd`.

### `snapshots.json` — per-session cost baseline for delta tracking

```json
{
  "sessionId": "20260112-101500-a1b2",
  "rootSessionIds": ["ses_abc123"],
  "bySession": {
    "ses_abc123": {
      "lastCost": 0.62,
      "lastTokens": { "input": 1200, "output": 640, "reasoning": 0, "cache": { "read": 300, "write": 40 } },
      "agent": "team/sentinel",
      "timestamp": "ISO8601"
    }
  }
}
```

`lastCost` is the last cumulative cost observed for that OpenCode session.
Each `teamwork_cost` call queries the entire session tree, computes
`delta = current_cost - lastCost` for every session (sentinel + all subagents),
adds new spend to `costs.json`, and advances `lastCost`. Because the running total
is the sum of these deltas across the entire tree, cumulative cost is never
double-counted and subagent consumption is never lost or ignored.

`snapshots.json` is now a **compatibility view**. The authoritative baseline and
the idempotency digest live in `costs.json` (`snapshotCursors`,
`appliedSnapshotDigest`), which is written first. A crash after the costs write
but before the snapshot write is therefore safe: a retry observes the same
digest and skips the delta. Readers may still consume `snapshots.json`; writers
refresh it after `costs.json` and never rely on it for correctness.

### Cross-process lock files (`<artifact>.lock`)

Read-modify-write of `state.json`, `costs.json`, `events.jsonl`, and
`handoffs/index.json` is serialised **across processes**, not just within one
plugin process. The lock is a sibling artifact named `<artifact>.lock`:

```json
{ "pid": 12345, "host": "workstation", "at": "ISO8601", "nonce": "hex" }
```

* **Atomic publication.** The complete owner JSON is first written to a unique
  temp file `<artifact>.lock.<host>.<pid>.<nonce>.tmp` with `wx`, then
  `link(2)`ed into place. A reader can never observe a zero-length or
  half-written lock; `EEXIST` means the lock is held. The temp name is always
  unlinked (best effort). On filesystems without hard links (`EPERM`/`ENOTSUP`/
  `ENOSYS`/…), the primitive falls back to an atomic `mkdir(2)` plus
  `<lock>/owner.json`, published with the same temp + `rename(2)` discipline; if
  the owner write fails the directory is removed and acquisition fails closed
  (it never reports `"created"` without a readable owner). The capability is
  detected once, cached for the process, and recorded as a
  `hardlink_unsupported` diagnostic.
* **Atomic reclaim.** A stale lock is quarantined with a single
  `rename(2)` to `<artifact>.lock.stale.<observedNonce>`, then deleted. Of N
  concurrent reclaimers exactly one rename wins. The observation's inode and
  nonce are re-checked before the rename, so a lock that was replaced in the
  meantime is never removed; the live path is **never** unlinked by nonce.
* **Nonce-checked release.** Release also quarantines first: it renames the lock
  to `<artifact>.lock.release.<ownNonce>`, reads the moved artifact, and removes
  only the quarantine whose nonce is ours. A lock published immediately after
  release survives. A foreign/replaced artifact is restored with `link(2)` +
  `unlink(2)`, never a clobbering rename.
* **Age comes from the filesystem.** Staleness uses
  `lstat(lockPath).mtimeMs`, never the owner's self-reported `at`, so a falsified
  future `at` cannot defeat the lease and an old `at` cannot make a fresh lock
  stale. An **empty or unparseable** lock older than the lease is stale and
  reclaimable (recorded as `unreadable_lock_reclaimed` in
  `recentLockDiagnostics()`); younger than the lease it may still be
  mid-publication and is left alone.
* A non-empty lock is reclaimed only when it is older than the lease **and** it
  was written on this host by the current pid or by a pid that is no longer
  alive. A lock from another host is never guessed at. A symlink at the lock
  path (or its directory) is refused, never followed.
* Acquisition retries with bounded exponential backoff plus jitter and fails
  closed with an explicit `lock timeout` error. The default timeout is **30 s**,
  equal to (never above) the 30 s lock lease; worst-case recovery latency is one
  lease plus one timeout. A caller that cannot get the lock writes nothing.
* The on-disk lock is always acquired after an in-process queue keyed by the
  same path, so a process cannot deadlock against its own lock file. Only the
  short read-modify-write is held; external cost/session reads happen before
  the lock, and full side-effect baselines (including the bounded untracked scan)
  and verifier-report base/head/diff reads happen before the `state.json` lock.
  Inside the lock the claim path re-reads only `HEAD`, `status --porcelain` and
  the tracked-diff hash, so a multi-MiB untracked scan never extends the critical
  section. Locks stay short (30 s lease); claims carry the longer 5 min + 5 min
  grace semantics.
* **Hosts without `/proc/self/fd`.** macOS/Windows use the path-based lock with
  a stable in-process key, a parent-realpath check before acquisition and after
  release, and a `detective-lock` anomaly/diagnostic. A failed check fails
  closed; Linux without usable procfs still fails closed and never degrades to
  the detective path.
* **NFS/multi-host limit:** `link(2)`, `rename(2)` and `mkdir(2)` are not a
  reliable distributed mutex on every NFS deployment (client-side caching,
  delayed visibility, no atomic rename in some configurations). On a shared
  filesystem treat these locks as best-effort duplicate-dispatch suppression:
  the claim protocol plus the idempotent cost digest and append-only event log
  limit the damage, but they do not turn NFS into a linearizable lock service.
  `requireSameHost` (worktree refusal) and the default-refused cross-host claim
  release exist for exactly this case. Use a local filesystem for the run root,
  or an external lock service, when strict cross-host exclusion is required.
* **Shared-filesystem contract.** These guarantees hold **only among processes
  on one host with a coherent filesystem**. Multi-host coordination is
  best-effort duplicate suppression, **never exactly-once**: two hosts can both
  believe they own a claim or a lock when the filesystem view is delayed. A
  missing `claim.host` is read as cross-host, so an incomplete record fails
  closed instead of being treated as local.

#### Write-anomaly audit and quarantine

A containment refusal means the writer must not touch the run again, so an
anomaly is **never** appended to `<run>/events.jsonl` (the policy itself refuses
that path). Every write anomaly is appended best-effort to
`<config-dir>/teamwork/write-anomalies.jsonl` (`OPENCODE_TEAMWORK_ANOMALY_AUDIT`
overrides the path), and `containment-mode` / `detective-lock` anomalies are also
printed to stderr. The file is bounded (1 MiB; it keeps a tail when it grows) and
is outside every run, so it survives a refused or renamed run.

Detective (`macOS`/`Windows`) atomic writes record a **write intent** before the
rename and a matching commit after the post-check. A process killed between
those two points leaves an uncommitted intent, which readers surface as a
`detective-temp` anomaly rather than losing the crash. The other recorded kinds
are `detective-containment`, `detective-precreate`, `detective-identity`,
`detective-identity-changed`, `detective-append`, `detective-unlink`,
`detective-lock`, `detective_mode`, `containment-mode` and `detective-temp`
(with `phase`, `tempPath`, `destRealAfter`, `bytesWritten`, `intendedSha256`).

A run with an **unacknowledged** write anomaly reports `needs-inspection` in
`teamwork_status` (`runState`, `writeAnomalies`, `unacknowledgedWriteAnomalies`)
and `teamwork_final_verify` refuses to consume it (status `NEEDS_INSPECTION`,
no `final.json`). Acknowledgement is an explicit operator record written to the
same config-dir audit (`teamwork_status { acknowledgeAnomalies: true }`); it
acknowledges every anomaly for that run up to the recorded timestamp. The
`detective_mode` and `detective-lock` diagnostics describe the documented
non-pinned fallback and never block a run. `doctor --security` reports
unacknowledged anomalies as a `write_anomalies` failure, so
`--require-hardened` exits 2.

### `events.jsonl` — lifecycle event log (JSON Lines)

Append-only log of run lifecycle events. Each event is one JSON object on its own
line, terminated by `\n`. Lines are only ever appended; nothing rewrites earlier
lines.

Every new line has these 12 fields, always present (`null` where not applicable),
plus `agentSource` when an actor exists:

- `ts` (string): ISO 8601 time the event was written
- `seq` (integer): position in this file's event sequence, starting at `1` and
  increasing by one with every append. The value is assigned inside the same
  `withFileLock` as the append, so concurrent appends cannot duplicate it.
  **Optional on legacy lines**: logs written before `seq` existed have no
  `seq`, and they remain valid.
- `event` (string): `run_created`, `task_transition`, `verifier_report`,
  `security_audit`, `victory_audit`, `verification_wave`, `final_verification`,
  `final_verification_bypass`, `legacy_unsigned_bypass`, `preflight`,
  `claim_renewed`, `claim_reclaimed`, `claim_released`,
  `claim_inspection_required`, `claim_recovered`, or `claim_override`
- `sessionId` (string): Run session id (≤64 chars)
- `taskId` (string or null): Task id (≤64 chars); `null` for run-level events
- `from` (string or null): Previous task status (≤32 chars)
- `to` (string): New task status, or `PASS`/`FAIL` for `security_audit` and `final_verification` (≤32 chars)
- `round` (integer): Task round; `0` when not applicable
- `agent` (string or null): Actor that performed the transition (≤64 chars). **Caller-reported (self-reported)**, see the **Actor** paragraph below.
- `agentSource` (string, optional): Provenance of `agent` — `"explicit"` (the
  `agent` input on `teamwork_task_update`), `"session"` (the calling session's
  agent, from the session tree or `snapshots.json`), or `"plan"` (the agent
  declared for the task in `plan.dag.json`). Emitted **only** when `agent` is
  non-null; `run_created` and `security_audit` carry no actor, so they omit it.
  `final_verification` records the calling session's agent (`"session"`) when it
  can be resolved. Legacy lines also omit it.
- `branch` (string or null): Task branch (≤120 chars)
- `worktree` (string or null): Task worktree path (≤200 chars)
- `phase` (string or null): Run phase after the event (≤32 chars)
- `note` (string, optional): Why a bypass was taken, what input preflight
  found, or which strict-wave verdict was recorded (≤200 chars). Emitted on
  `final_verification_bypass`, `legacy_unsigned_bypass`, on
  `teamwork_preflight`'s `preflight` event, on `verification_wave`, and on
  `run_created` when the input-preflight gate was bypassed. Every other event
  omits it. Sanitised with `clean()`.

The event kinds:

- `run_created`: written by `teamwork_plan` once the run is created. `taskId` and
  `from` are `null`, `to` is `"pending"`, `round` is `0`, `phase` is `"DAG_BUILD"`.
  It additionally carries the spec-presence-gate decision: `specGate`
  (`"satisfied" | "bypassed" | "not_required"`) and, only when satisfied,
  `specPath` (the `prompt_draft.md` path, ≤200 chars). These two fields appear
  **only** on `run_created`; every other event keeps the fields above.
  `specGate` and `specPath` also go through `clean()`. The field records what the caller did; it is not proof that a user approved the spec. On a
  version-3 approval run `run_created` also records the approval summary:
  `approvalDigest`, `approvalKeyId`, `approvedBy`, `promptDraftSha256`, and
  `binding: "prompt"` (each sanitised and capped). The event is a record of
  what the gate accepted, not another signature. The timeline view parses
  events field by field and does not surface `specGate` (it is visible in
  `events.jsonl` itself). When the input-preflight gate was bypassed with
  `allowMissingInputs: true`, `run_created` also carries `note` (e.g.
  `preflight bypassed: MISSING (2 items)`).
- `task_transition`: written by `teamwork_task_update` after `state.json` is saved.
  `from` is the previous status and `to` the status that landed. `round`, `branch`,
  `worktree` and `phase` are the values after the transition. `agentSource`
  appears when an actor was resolved.
- `security_audit`: written by `teamwork_security_audit`. `to` is `"PASS"` or
  `"FAIL"`, and `phase` is the run phase. `taskId`, `from`, `branch`, `worktree` and
  `agent` are `null`, `round` is `0`, and `agentSource` is omitted.
- `victory_audit`: written by `teamwork_victory_audit` after
  `verify/victory.json` is saved. `to` is `"VICTORY CONFIRMED"` or
  `"VICTORY REJECTED"`, `taskId` and `from` are `null`, `round` is `0`, and
  `agent` is always `"team/victory-auditor"` with `agentSource: "session"`.
- `verification_wave`: written by `teamwork_wave_record` after
  `verify/challenge-<taskId>.json` or `verify/audit-<taskId>.json` is saved.
  `taskId` is the task, `to` is `"PASS"` or `"CLEAN"`, `round` is `0`, and
  `agent` is the trusted agent for the kind (`team/falsifier` or
  `team/security-auditor`) with `agentSource: "session"`. `note` is
  `challenge: PASS` or `audit: CLEAN`. A refused call appends nothing.
- `preflight`: written by `teamwork_preflight` after `preflight.json` is
  saved. `to` is the overall preflight status (`READY`, `MISSING`, or
  `OUTAGE`); `taskId` and `from` are `null`, `round` is `0`, and `phase` is the
  run phase. `note` is present when any item is missing or unreachable.
- `final_verification`: written by `teamwork_final_verify` after
  `verify/final.json` is saved. `to` is `"PASS"` or `"FAIL"`, `taskId` and `from`
  are `null`, `round` is `0`, and `phase` is the run phase. `agent` is the calling
  session's agent when it could be resolved (with `agentSource: "session"`);
  otherwise it is `null` and `agentSource` is omitted.
- `verifier_report`: written by `teamwork_report` after the signed (or legacy
  unsigned) `verify/report-<taskId>.json` is written. `to` is `PASS` or `FAIL`;
  `agent` is `team/verifier` with `agentSource: "session"`.
- `final_verification_bypass`: written by `teamwork_next` when it accepts an
  **unstamped** `verify/final.json` through the explicit `allowUnstamped: true`
  bypass. `to` is `"ALL_PASSED"`, `taskId` and `from` are `null`, `round` is
  `0`, and `phase` is the run phase after the bypass (normally `"MERGE"`).
  `agent` is the calling session's agent when it could be resolved (with
  `agentSource: "session"`), otherwise `null`. It carries a `note` explaining
  that the verdict was not produced by `teamwork_final_verify`. A stamped
  verdict never emits this event.
- `legacy_unsigned_bypass`: written by `teamwork_final_verify`/`teamwork_next`
  when `allowUnsignedLegacy: true` lets an unsigned run proceed. `to` is
  `final_verify` or `"ALL_PASSED"`; the `note` states that artifact `_auth`
  envelopes were not verified.

Example (one `task_transition` line, wrapped here for readability):

```json
{"ts":"2026-01-12T10:15:00.000Z","seq":12,"event":"task_transition","sessionId":"20260112-101500-a1b2",
 "taskId":"R1-impl","from":"worker_active","to":"worker_done","round":1,
 "agent":"team/worker","agentSource":"explicit","branch":"teamwork/20260112-101500-a1b2-R1-impl",
 "worktree":"../.teamwork-worktrees/20260112-101500-a1b2/R1-impl","phase":"DISPATCH"}
```

**Actor (`agent`) — caller-reported, not verified.** On `task_transition` the field
records the actor, resolved in this order: (1) the explicit `agent` input to
`teamwork_task_update`, (2) the calling session's agent, read from the session
tree, (3) the agent declared for the task in `plan.dag.json`. `agentSource`
records which of those three produced the value (`explicit`, `session`, `plan`).
The sentinel passes `agent: "team/worker"` on `worker_done` and
`agent: "team/verifier"` on `verified_pass` / `verified_fail`. The value is
self-reported: the engine does not check that the named agent actually performed
the transition. No engine decision reads it; the timeline view only displays it.
Treat it as a label, not as evidence of who acted.

**Sanitising.** The caller-supplied and file-derived string fields (`sessionId`,
`taskId`, `from`, `to`, `agent`, `branch`, `worktree`, `phase`, `note`) are
passed through `clean()` and truncated to the limit above. `ts` is generated by the engine
(`new Date().toISOString()`), `seq` is assigned by the engine, `event` is a
code-supplied literal, and `agentSource` is only emitted for one of the three
fixed values above, so none of those goes through `clean()`. `clean()` replaces
C0 control characters, DEL, C1 controls (U+0080–U+009F, including U+0085), and
U+2028/U+2029 with spaces. A value can therefore never add a second physical
line. It is a line-safety and display sanitiser, not a complete defence against
hostile text, and it does not guard against prototype-key collisions (see Bucket
names above).

**Locking and symlinks.** Each append runs inside the cross-process
`<artifact>.lock` plus the in-process queue keyed on the `events.jsonl` path, so
two plugin processes cannot assign the same `seq` or interleave a read/count
with an append. A symlinked `events.jsonl` is refused: nothing is written
through the link, and the link is left in place.

**Best-effort, fail-open.** Writing is best-effort. Any error (including a refused
symlink) is swallowed, and no tool result changes because of it. The DAG engine
(`teamwork_next`, `teamwork_task_update`) never reads `events.jsonl`, so a run works
fully without it. Only the timeline view reads it. Without it the timeline falls back
to derived mode, with start and duration unknown.

### `verify/report-<task>.json` (verifier output)

```json
{
  "taskId": "R1-impl",
  "status": "PASS",
  "verifierAgent": "team/verifier",
  "verifierSessionId": "ses_abc123",
  "timestamp": "ISO8601",
  "summary": "Rubric and programmatic checks passed.",
  "checks": [
    { "name": "...", "type": "programmatic|adversarial|rubric", "passed": true, "output": "..." }
  ],
  "feedbackForWorker": "...",
  "fatalFindings": [
    { "where": "file:line", "why": "...", "fix": "...", "reproduction": "..." }
  ],
  "evidence": "npm test tail + src/api.ts:42",
  "requirementsHash": "<sha256 of canonical requirements.json>",
  "workerHandoff": {
    "taskId": "R1-impl",
    "agent": "team/worker",
    "path": "handoffs/R1-impl-worker.md",
    "sha256": "<sha256 of the worker handoff body>"
  },
  "_auth": { "v": 1, "alg": "hmac-sha256", "keyId": "k_...", "path": "verify/report-R1-impl.json", "digest": "sha256", "mac": "sha256", "at": "ISO8601" }
}
```

`teamwork_report` is the trusted writer: the caller must be `team/verifier`,
descend from the run's `rootSessionId`, and name a task that exists in
`plan.dag.json`. A `PASS` needs a non-empty summary or at least one check. On a
signed run the report is signed and indexed; `final_verify` requires that
signature. A hand-written unsigned report is `AUTH_MISSING`.

**Worker-handoff binding (0.12.0).** The engine fills `workerHandoff` from
`plan.dag.json` and `handoffs/index.json` (never from caller input): the task's
assigned agent (default `team/worker`), the indexed path, and the hash of the
handoff body. When the plan records `requireHandoffs: "required"`, a `PASS`
report is refused as `REPORT_HANDOFF_MISSING` when the handoff is absent and
`REPORT_HANDOFF_STALE` when the indexed hash no longer matches the file.
`final_verify` re-checks the binding; re-recording the worker handoff changes
its body hash and makes the old report stale, so write the worker handoff before
the report.

### `verify/challenge-<taskId>.json` (strict challenge verdict)

```json
{
  "version": 1,
  "sessionId": "20260112-101500-a1b2",
  "taskId": "R1-impl",
  "kind": "challenge",
  "verdict": "PASS",
  "agent": "team/falsifier",
  "agentSessionId": "ses_abc123",
  "reportHash": "<sha256 of verify/report-R1-impl.json>",
  "cites": [{ "path": "verify/evidence/trace.txt", "sha256": "<sha256>", "bytes": 1234 }],
  "notes": "Tried empty input, overflow, TOCTOU; no fatal or serious flaw.",
  "evidence": "verify/report-R1-impl.json + src/api.ts:42",
  "generatedAt": "ISO8601",
  "_auth": { "v": 1, "alg": "hmac-sha256", "keyId": "k_...", "path": "verify/challenge-R1-impl.json", "digest": "sha256", "mac": "sha256", "at": "ISO8601" }
}
```

### `verify/audit-<taskId>.json` (strict audit verdict)

```json
{
  "version": 1,
  "sessionId": "20260112-101500-a1b2",
  "taskId": "R1-impl",
  "kind": "audit",
  "verdict": "CLEAN",
  "agent": "team/security-auditor",
  "agentSessionId": "ses_def456",
  "reportHash": "<sha256 of verify/report-R1-impl.json>",
  "cites": [{ "path": "verify/evidence/audit.log", "sha256": "<sha256>", "bytes": 2048 }],
  "notes": "No Critical/High findings; no forbidden integrity rule.",
  "evidence": "npm test tail + git diff base..task",
  "generatedAt": "ISO8601",
  "_auth": { "v": 1, "alg": "hmac-sha256", "keyId": "k_...", "path": "verify/audit-R1-impl.json", "digest": "sha256", "mac": "sha256", "at": "ISO8601" }
}
```

Both are written only by `teamwork_wave_record`. There is no caller-supplied
agent label: the tool derives the caller from the trusted session identity,
requires the caller session to descend from the run's `rootSessionId`, and
accepts `challenge` only from `team/falsifier` and `audit` only from
`team/security-auditor`. The task must exist in `plan.dag.json` and its
`verify/report-<taskId>.json` must already be `PASS`. The allowed verdicts are
exactly `PASS` (challenge) and `CLEAN` (audit); `notes` and `evidence` are
sanitised and bounded. Each file is refused if a symlink or unsafe entry is
present and is written atomically.

**Report binding and rework.** `reportHash` is the sha256 of the exact
`verify/report-<taskId>.json` bytes the verdict approved. The gate requires it
to equal the sha256 of the current report, so a verdict can never be reused for
a report it did not see. Recording the same kind for the same task against the
**same** report hash is refused (write-once for that verification round).
Recording against a **different** report hash is the only overwrite path: the
old verdict is stale because the task was reworked and re-verified, so the new
verdict replaces it with the new hash. A missing hash is a named
`strict challenge/audit <task>: reportHash missing or invalid` failure; a hash
mismatch is a named `strict challenge/audit for <task> is stale (report changed
since it was recorded)` failure. `GATE_STATUS.md` renders either row as `FAIL`.

**Cited evidence (0.12.0).** A wave verdict may cite up to 16 paths inside
`verify/` (a single control-plane file or a `verify/evidence/<name>` artifact).
The engine hashes each file at record time and stores
`cites: [{path, sha256, bytes}]`. `readWaveEvidence` re-hashes every cite: a
missing, edited, or resized artifact makes the verdict `STALE` (the strict gate
status becomes `STALE`, and `final_verify` reports `[AUTH_STALE]`). A
pre-0.12.0 verdict with no `cites` still reads, but carries a
`legacy_unbound_wave` warning in `final.json` and is never silently current.

### `verify/security-audit.json` (pre-merge security gate output)

```json
{
  "sessionId": "20260112-101500-a1b2",
  "integrityMode": "development",
  "status": "PASS|FAIL",
  "timestamp": "ISO8601",
  "severityCounts": { "critical": 0, "high": 0, "medium": 1, "low": 2 },
  "summary": "Audited base branch diff; no secrets or injection vectors found.",
  "findings": [
    {
      "id": "SEC-1",
      "severity": "Medium",
      "location": "src/api.ts:42",
      "description": "Unbounded payload buffer could allow memory pressure under high concurrency."
    }
  ],
  "integrityFindings": [
    { "rule": "external_dependency_used", "where": "src/parser.ts:3", "why": "uses a third-party parser" }
  ],
  "integrityViolations": [
    {
      "rule": "external_dependency_used",
      "where": "src/parser.ts:3",
      "why": "uses a third-party parser",
      "forbiddenFrom": "benchmark"
    }
  ],
  "ruleChecks": [
    { "rule": "fabricated_output", "result": "clean" },
    { "rule": "external_dependency_used", "result": "clean" }
  ],
  "reviewedDigests": {
    "reports": { "R1-impl": "<sha256 of verify/report-R1-impl.json>" },
    "final": null
  },
  "_auth": { "v": 1, "alg": "hmac-sha256", "keyId": "k_...", "path": "verify/security-audit.json", "digest": "sha256", "mac": "sha256", "at": "ISO8601" }
}
```

`integrityMode` is read at audit time from `ORIGINAL_REQUEST.md` and recorded
here; legacy runs with no request artifact record `development` and the tool
result says the default was applied. The mode itself is disclosed, not enforced,
by `teamwork_next`'s final-verification gate (whose responses carry the same
`integrityMode` field); enforcement happens in the audit tool when it records
`integrityViolations`.

`integrityFindings` records the auditor's sanitised claims (rule, optional
`where`/`why`, capped at 50). `integrityViolations` is the subset whose rule is
forbidden at the recorded mode; each entry also carries the rule's
`forbiddenFrom` threshold (see [Integrity rules](#integrity-rules)). Any
violation forces `status` to `FAIL`, independently of severity counts.

**Coverage and reviewed digests (0.12.0).** The engine (not the caller) writes
`ruleChecks` with exactly one entry for every rule forbidden at the run's
integrity mode, plus `reviewedDigests {reports, final}` hashed from disk at
audit time. A `PASS` is refused at `final_verify` if a forbidden rule is missing,
appears twice, records a `violation`, or if a reviewed report changed
(`AUTH_STALE`). `next` surfaces the same drift as `AUTH_STALE`. A
`verify/final.json` written after the audit is not treated as a reviewed final.

If `critical` > 0 or `high` > 0, `status` is forced to `FAIL` and `teamwork_next` blocks final merge (`BLOCKED_BY_SECURITY`).

### `verify/victory.json` (independent final acceptance verdict)

```json
{
  "version": 1,
  "sessionId": "20260112-101500-a1b2",
  "verdict": "VICTORY CONFIRMED|VICTORY REJECTED",
  "auditor": "team/victory-auditor",
  "auditorSessionId": "ses_abc123",
  "requestHash": "<sha256 of ORIGINAL_REQUEST.md>",
  "requirementsHash": "<sha256 of canonical requirements.json>",
  "evidenceDigests": {
    "reports": { "R1": "<sha256 of verify/report-R1.json>" },
    "securityAudit": "<sha256 of verify/security-audit.json>",
    "final": null
  },
  "requirements": [
    { "id": "R1", "met": true, "evidence": "npm test tail + src/api.ts:42" }
  ],
  "findings": ["Optional concrete gap"],
  "summary": "Independent acceptance audit prose.",
  "generatedAt": "ISO8601",
  "_auth": { "v": 1, "alg": "hmac-sha256", "keyId": "k_...", "path": "verify/victory.json", "digest": "sha256", "mac": "sha256", "at": "ISO8601" }
}
```

Written only by `teamwork_victory_audit`, which derives the caller from the
trusted session identity (a caller-supplied label cannot self-authorize) and
requires that session to descend from the run's `rootSessionId`. It validates
that every `requirements.json` id appears exactly once, that `met: true` carries
non-empty evidence, and that a `CONFIRMED` verdict has a current
`ORIGINAL_REQUEST.md`; it then stores the request's sha256 and the current
`requirementsHash`. A confirmed verdict is **write-once** (a later audit cannot
overwrite it). On `REJECTED` the Sentinel forwards `findings` and resumes the
team.

On a signed run the verdict is signed and indexed. `final_verify`/`next` fail
with `AUTH_MISSING` (no envelope), `AUTH_INVALID` (edited field), `AUTH_UNKNOWN_KEY`,
`AUTH_INDEX_MISSING` (copied from another run), or `AUTH_STALE` (requirements
baseline changed) rather than trusting it.

**Reviewed evidence (0.12.0).** The tool also records `evidenceDigests`
computed from disk: the sha256 of every `verify/report-<taskId>.json` present,
the security audit, and a pre-existing `PASS` final. `CONFIRMED` with an empty
`reports` map is refused. The gate recomputes the set; any drift is `AUTH_STALE`
and `next` returns status `AUTH_STALE`. A legacy verdict without
`evidenceDigests` is stale (never silently current). The verdict is still an
audit input: PASS/FAIL is recomputed from task/report/audit semantics.

### `verify/final.json` (final verification verdict)

```json
{
  "status": "PASS|FAIL",
  "generatedBy": { "agent": "team/verifier", "session": "ses_abc123" },
  "generatedAt": "ISO8601",
  "integrityMode": "development",
  "victory": "CONFIRMED|FAILED|SKIPPED (explicit): <reason>|SKIPPED (legacy default: no requirements baseline)",
  "handoffs": "PASS|MISSING|STALE|INVALID|SKIPPED (explicit)",
  "requirementsHash": "<sha256 of canonical requirements.json>",
  "evidence": {
    "tasks": [
      {
        "id": "R1-impl",
        "status": "verified_pass",
        "report": "verify/report-R1-impl.json",
        "reportStatus": "PASS"
      }
    ],
    "securityAudit": { "path": "verify/security-audit.json", "status": "PASS" },
    "allTasksVerifiedPass": true,
    "reportDigests": { "R1-impl": "<sha256 of report bytes>" },
    "auditDigest": "<sha256 of security-audit.json bytes>",
    "victory": { "mode": "required", "status": "CONFIRMED", "auditor": "team/victory-auditor", "requestHash": "...", "requirementsHash": "..." },
    "handoffs": {
      "mode": "required",
      "status": "PASS",
      "required": [{ "taskId": "R1-impl", "agent": "team/worker" }],
      "entries": [
        {
          "taskId": "R1-impl",
          "agent": "team/worker",
          "path": "handoffs/R1-impl-worker.md",
          "sha256": "<64 hex of the handoff file>",
          "agentSessionId": "ses_...",
          "cites": [],
          "auth": "signed|unsigned|invalid",
          "keyId": "k_..."
        }
      ],
      "reasons": []
    },
    "strict": {
      "mode": "strict",
      "status": "PASS",
      "missing": [],
      "reasons": [],
      "tasks": [
        {
          "id": "R1-impl",
          "report": "verify/report-R1-impl.json",
          "reportStatus": "PASS",
          "challenge": { "path": "verify/challenge-R1-impl.json", "status": "PASS", "agent": "team/falsifier", "reportHash": "...", "ok": true },
          "audit": { "path": "verify/audit-R1-impl.json", "status": "CLEAN", "agent": "team/security-auditor", "reportHash": "...", "ok": true }
        }
      ]
    }
  },
  "reasons": [],
  "contradictions": [
    { "code": "INCONSISTENT_AUDIT_HIGH", "detail": "security audit reports PASS with 1 High finding" }
  ],
  "summary": "Independent final check passed.",
  "findings": [
    { "where": "src/api.ts:42", "why": "...", "fix": "..." }
  ],
  "_auth": { "v": 1, "alg": "hmac-sha256", "keyId": "k_...", "path": "verify/final.json", "digest": "sha256", "mac": "sha256", "at": "ISO8601" }
}
```

For a skip, `evidence.victory` is
`{ "mode": "skip", "status": "SKIPPED (explicit)", "reason": "<victorySkipReason>", "reasons": [] }`.

`teamwork_final_verify` writes this file atomically. On a signed run the final
verdict is signed and the evidence digests let `teamwork_next` detect a report
or audit edited after the verdict (`AUTH_STALE`). `evidence.handoffs.entries`
records each matched handoff's `auth` (`signed|unsigned|invalid`) and `keyId`
from the checked continuity gate. An unsigned legacy run needs
the explicit `allowUnsignedLegacy` bypass. `status` is `PASS` **only**
when every task in `state.json` is `verified_pass`, every task report
(`verify/report-<taskId>.json`, task ids validated with the same safe-id
allowlist) reports `PASS`, `verify/security-audit.json` reports `PASS`, and the
independent victory audit is `CONFIRMED` with every requirement met and a
`requestHash` matching the current `ORIGINAL_REQUEST.md`. A plan that explicitly
recorded `victoryAudit: "skip"` records
`victory: "SKIPPED (explicit): <victorySkipReason>"` instead; a legacy
no-baseline default skip records
`victory: "SKIPPED (legacy default: no requirements baseline)"`.
When the plan's `requireHandoffs` is `required`, `status` also requires the
continuity matrix to be complete: every plan task has its assigned worker and
`team/verifier` task-scoped handoff, strict runs add `team/falsifier` and
`team/security-auditor` task handoffs, and the run has one run-level
`team/sentinel` or `team/orchestrator` handoff plus (when the victory audit is
required) a `team/victory-auditor` run-level handoff recorded after the audit.
Each required entry must exist once in `handoffs/index.json`, name a regular
non-symlink markdown file whose sha256/byte length match the index, carry the
canonical header for that task/agent, and cite the current report/challenge/
audit/victory where the role has one. A verifier handoff additionally cites
`handoffs/<taskId>-<worker>.md` (0.12.0), so a re-recorded worker narrative
makes the verifier handoff stale (`verifier → worker → report`). A changed
cited artifact makes the handoff **stale**; duplicate, unknown, or mismatched
index entries fail. The
gate result is recorded as `handoffs` and under `evidence.handoffs` (path,
sha256, agent, task). A plan that recorded `requireHandoffs: "skip"` does not
read the index and records `handoffs: "SKIPPED (explicit)"` instead.
A plan that recorded `verification: "strict"` must additionally have, for every
task, `verify/challenge-<taskId>.json` with `kind: "challenge"`,
`verdict: "PASS"`, `agent: "team/falsifier"`, the run's `sessionId`, and a
`reportHash` equal to the current report's sha256, plus
`verify/audit-<taskId>.json` with `kind: "audit"`, `verdict: "CLEAN"`,
`agent: "team/security-auditor"`, the run's `sessionId`, and the same current
`reportHash`; a missing, malformed, mismatched, stale, or non-PASS/CLEAN verdict
adds a named `strict <kind> <taskId>` reason. Standard mode never reads those
files, so stray wave artifacts cannot affect it.
Any unmet condition yields `FAIL` with one entry per condition in `reasons`
(capped at 100), including named victory reasons (`missing`, `VICTORY REJECTED`,
unmet requirement, stale hash, forged auditor). The verdict is computed from
these artifacts and cannot be overridden by input: a supplied `failReason` only
appends a reason and forces `FAIL`.

`generatedBy` records provenance: `agent` is the calling session's agent (or
`null` when it could not be resolved) and `session` is the calling OpenCode
session id (or the run id when no caller session is available). `generatedAt` is
the write time. `integrityMode` is read from `ORIGINAL_REQUEST.md` and defaults
to `development`. `summary` and `findings` are optional (the verifier's prose and
up to 50 `{where, why, fix}` entries).

**Contradictions (0.12.0).** `final_verify` and `next` name four cross-artifact
conflicts instead of silently passing them: `INCONSISTENT_VICTORY_TASK`
(CONFIRMED over a failing task), `INCONSISTENT_REPORT_BRANCH` (a PASS report's
`headSha`/`diffHash` no longer matches the verified branch),
`INCONSISTENT_AUDIT_HIGH` (a PASS audit with a High/Critical finding), and
`INCONSISTENT_WAVE_REPORT` (a wave bound to the current hash of a FAIL report).
`final_verify` writes `contradictions` and FAILs; `next` returns
`INCONSISTENT_EVIDENCE` before any readiness path. Nothing is auto-fixed.

**Stamped requirement.** `teamwork_next` treats a report as *stamped* only when
it has a non-empty `generatedBy` object containing a non-empty `session`, a
parseable `generatedAt`, and an `evidence` object. A report missing any of those
was written outside the engine (by hand, or before the stamp existed): it is
unstamped/legacy and cannot complete a run by default. Recompute it with
`teamwork_final_verify`.

**Completion gate.** With every task `verified_pass` and the security audit
`PASS`, `teamwork_next` evaluates `verify/final.json`:

In strict mode the wave gate runs first: if any task is missing its challenge
or audit, `teamwork_next` returns `NEEDS_STRICT_WAVE` (or
`BLOCKED_BY_STRICT_WAVE` when both exist but a verdict is wrong) and lists the
`taskId:kind` pairs. It does not evaluate `verify/final.json` or report
`ALL_PASSED` until the wave is complete.

| Report state | Result | Phase |
| --- | --- | --- |
| missing/unreadable/malformed | `READY_FOR_FINAL_VERIFICATION` | `FINAL_VERIFICATION` |
| `status: "FAIL"` | `BLOCKED_BY_FINAL_VERIFICATION` | unchanged |
| `status: "PASS"`, stamped | victory check (below) | `MERGE` after it passes |
| `status: "PASS"`, unstamped, default | `FINAL_VERIFICATION_UNVERIFIED` | `FINAL_VERIFICATION` |
| `status: "PASS"`, unstamped, `allowUnstamped: true` | victory check (below) | `MERGE` after it passes |
| required handoffs missing | `NEEDS_HANDOFFS` (names the `taskId:agent` pairs) | `FINAL_VERIFICATION` |
| handoff stale/duplicate/unknown/tampered | `BLOCKED_BY_HANDOFFS` | `FINAL_VERIFICATION` |
| victory `required`, missing/rejected/stale/forged | `READY_FOR_VICTORY_AUDIT` / `BLOCKED_BY_VICTORY_AUDIT` | `FINAL_VERIFICATION` |
| victory confirmed (or explicit plan `skip`) | `ALL_PASSED` | `MERGE` |

When `requireHandoffs: "required"`, `teamwork_next` checks the continuity matrix
after the final report's auth/drift checks and before the final status branch.
A stale report still wins as `AUTH_STALE`; otherwise missing pairs return
`NEEDS_HANDOFFS` and bad evidence (including `[AUTH_*]`) returns
`BLOCKED_BY_HANDOFFS`. An explicit plan `requireHandoffs: "skip"` bypasses the
check and can complete without a `handoffs/` directory.

`allowUnstamped` (boolean, default `false`) is a legacy migration escape hatch.
It accepts a hand-written report and appends one `final_verification_bypass`
event whose `note` records the acceptance. Use it only to finish runs that
predate `teamwork_final_verify`; every new run should complete through a stamped
verdict. `FINAL_VERIFICATION_UNVERIFIED` results carry `finalReport`,
`passedCount` and `integrityMode`, and the message names both remedies (run the
tool, or re-call with the bypass).

### `verify/evidence/<name>` (optional bounded evidence artifact, 0.12.0)

Written only by `teamwork_evidence` through the pinned run writer. `name` is one
safe segment (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), the file is at most 64 KiB,
and a run holds at most 32 of them. The tool returns:

```json
{ "path": "verify/evidence/trace.txt", "sha256": "<plain sha256>", "bytes": 1234 }
```

Cite the path from `teamwork_wave_record`; the strict gate re-hashes the file
and FAILs if it is missing, resized, or edited. This records bytes, not a
verdict.

### `GATE_STATUS.md` (strict verification gate table)

Written by `teamwork_final_verify` only in strict mode (on PASS and FAIL). It is
sanitised and written atomically, and cites the artifact behind every row:

```md
# Verification Gate

- Session: `20260112-101500-a1b2`
- Mode: strict
- Generated: 2026-01-12T10:30:00.000Z

| Agent | Role | Verdict | Source |
| --- | --- | --- | --- |
| team/worker | worker | verified_pass | state.json#tasks.R1-impl |
| team/verifier | verifier | PASS | verify/report-R1-impl.json |
| team/falsifier | challenger | PASS | verify/challenge-R1-impl.json |
| team/security-auditor | auditor | CLEAN | verify/audit-R1-impl.json |

## Continuity

Handoffs: **PASS** (required)

| Task | Agent | Handoff | sha256 | Auth |
| --- | --- | --- | --- | --- |
| R1-impl | team/worker | handoffs/R1-impl-worker.md | <64 hex> | signed (k_...) |
| R1-impl | team/verifier | handoffs/R1-impl-verifier.md | <64 hex> | signed (k_...) |
| R1-impl | team/falsifier | handoffs/R1-impl-falsifier.md | <64 hex> | signed (k_...) |
| R1-impl | team/security-auditor | handoffs/R1-impl-security-auditor.md | <64 hex> | signed (k_...) |
| _run | team/sentinel | handoffs/_run-sentinel.md | <64 hex> | signed (k_...) |

Gate Result: **PASS**
```

On FAIL it adds a `## Reasons` list and ends with `Gate Result: **FAIL**`. A
task adds one worker/verifier/challenger/auditor group; the wave scales by tasks
and rounds, not by a fixed row count. A stale or invalid challenge/audit is
rendered as `FAIL` in its verdict cell. The `## Continuity` section cites each
required handoff path and sha256 (or says `SKIPPED (explicit)`); handoff prose
never appears in a Verdict cell. If `GATE_STATUS.md` cannot be written
(for example a symlink is planted at the path), final verification records a
named strict reason and cannot PASS.

### `synthesis/conflict-<task>.json` (git 3-way merge conflict artifact)

Generated by `teamwork_worktree({ action: "merge" })` when a conflict occurs:

```json
{
  "taskId": "R2-impl",
  "sessionId": "20260112-101500-a1b2",
  "baseBranch": "teamwork/base-20260112-101500-a1b2",
  "incomingBranch": "teamwork/20260112-101500-a1b2-R2-impl",
  "conflictingFiles": ["src/router.ts"],
  "diffOurs": "...",
  "diffTheirs": "...",
  "timestamp": "ISO8601"
}
```

### `pitfalls.md`

One line per entry:

```
- [round 2] assumes the input is already sorted — seen in R1-impl
```

### LEMMA (`lemma/` — explicit opt-in Lean 4 mode under `proof` + `lemmaMode: true`)

When `teamwork_plan` is invoked with `lemmaMode: true` (or `route: "lemma"`, requiring `topology: "proof"`), the engine first probes `lean`, `lake`, and the LEAP CLI (`leap`; legacy `leap-tools` accepted) on `PATH` **before `mkdir`**. If any tool is missing or unusable (even when `allowMissingInputs: true`), planning is refused immediately with exact install instructions for both Lean 4 (`elan`) and the pinned LEAP CLI (`pipx install git+https://github.com/billkunghappy/LEAP-CLI@afc016d23579d8236050a157fe6cac8f17b13096`), writing zero files and spending zero budget.

When the toolchain is ready, the run initializes `.opencode/teamwork/<session-id>/lemma/`:

- `manifest.json`: `phase` (`FORMALIZE | SOLVING | VERIFIED | BLOCKED`), `bounds` (`maxDepth <= 3`, `maxWidth <= 4`, `maxNodes <= 24`, `maxRetries <= 4`, `maxFormalizationRounds <= 3`), `toolchain` snapshot, `policy` (the approved axiom allowlist), and `nodes` map keyed by safe `LEMMA_ID` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, not `.`/`..`).
  - `policy` is written once by `teamwork_plan` from `lemmaPolicy.allowedAxioms` and is immutable for the run:
    ```json
    {
      "version": 1,
      "allowedAxioms": ["my_custom_ax"]
    }
    ```
    Each entry must be a non-empty safe Lean axiom name (guillemet-normalized), entries are deduped, the list is capped at 32, and `sorryAx` is always rejected. The configured list extends the standard axioms (`Classical.choice`, `propext`, `Quot.sound`); it never replaces them. A re-plan that supplies a different list is refused. A legacy manifest without `policy` fails closed to the standard axioms only.
- `problem_draft.lean` & `problem.lean`: Phase 0 formalization written via `teamwork_lemma_formalize({ action: "draft" })`; promoted to `problem.lean` only after compilation (`exitCode === 0`) and `team/formalization-reviewer` `preSearch.verdict === "APPROVE"`.
- `formalization-review.json`: records `draftVerification` (including `draftHash` SHA-256), `preSearch` (`APPROVE | REQUEST_CHANGES`), and `final` (`FAITHFUL | UNFAITHFUL | MISFORMALIZED`).
- `nodes/<lemmaId>/`: `state.json` (including optional `declaration` — the Lean theorem/lemma name — and `statement` — the exact Lean type), `blueprint.md`, `attempt-<r>.lean`, and stamped `verify-<r>.json` written by `teamwork_lemma_verify`.
  - The verifier executes real `lean`/`lake` via `spawnSync`, captures both `stdout` and `stderr`, and rejects `sorry`/`admit`/unauthorized local `axiom` even when `lean` exits `0`.
  - **Proposition binding:** before a node can become `proved`/`disproved`, the attempt's declaration name must match the node's `declaration` (or the unique declaration in `problem.lean`), and its declared type must match the node's `statement` after whitespace/binder normalization. The scan masks comments, string/char literals, and syntax quotations; it refuses duplicate names, namespaces/sections, and `private`/`protected` theorem/lemma declarations rather than taking a first match.
  - **Transitive axioms:** after a successful compile, the verifier runs `#print axioms <declaration>` on the attempt and records `declaration`, `declarationType`, `axiomDependencies`, and `unauthorizedAxioms`. Only `Classical.choice`, `propext`, `Quot.sound`, plus the `policy.allowedAxioms` approved at plan time are accepted; `sorryAx` is never accepted. The allowlist is read from `lemma/manifest.json`, never from the `teamwork_lemma_verify` caller: that tool has no `allowedAxioms` input and explicitly refuses a deprecated one. The output parser requires exactly one report naming the expected declaration; reports for other names, duplicate reports, or source containing `#` commands / `logInfo` / `dbg_trace` / `trace` / `run_cmd` / `println` / `IO.` / `set_option trace` fail closed.
  - **Known limits:** binding is a lexical comparison of the elaborated type text, not proof of semantic equality; a legacy manifest without `policy` permits only the standard axioms; and the live Lean path is not exercised on hosts without the toolchain (stub tests cover the control flow, and live E2E skips loudly). `teamwork_final_verify` re-evaluates each stamped report's `axiomDependencies` against the manifest policy and rejects a report whose `allowedAxioms` differs from it, so a forged report cannot widen the gate.
  - Node `statement`/`declaration` are immutable once the node is `proved`/`disproved`: reset it to `formal` first and re-verify. `teamwork_final_verify` also compares the stamped report's declaration, declaration type, and axiom fields against the current node metadata and FAILs on mismatch.
- `teamwork_final_verify` validates all `lemma/` artifacts with `O_NOFOLLOW` + `realpathSync` containment and stamps `evidence.lemma` into `verify/final.json`.

### `scout-report.md`, `candidates/*.md`, `critiques/*.md`, `synthesis/*.md`

Free-form markdown following the section structure described in the scout,
proposer, falsifier and synthesizer agent files.

### Tournament artifacts (`massive-proof`, explicit opt-in)

When `massive-proof` runs in tournament mode (`teamwork_plan` with explicit opt-in or
`teamwork_tournament({ action: "init" })`), the engine validates bounds (`levels <= 4`,
`branchingFactor <= 8`, `maxCandidates <= 64`, `maxIterations <= 32`, `unitCostUsd >= 0.05`)
and runs budget preflight (`budgetUsd > 0`, `spentPct < 80`, `remainingUsd >= estimatedMinUsd`)
**strictly before `mkdirSync`**. All tournament IDs match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
and every path under `tournament/` enforces segment-wise `lstatSync` symlink refusal,
`realpathSync` containment, bounded `O_NOFOLLOW | O_NONBLOCK` reads, and
`O_CREAT | O_EXCL` temp files (a planted symlink/hard link at a temp path cannot
redirect an atomic write).

**Known limitations (same threat model).** Run-artifact reads go through the
shared `plugins/opencode-teamwork/safe-fs.mjs` primitive: open → `fstat` →
regular-file → size cap → **fd containment** → bounded read. On **Linux with a
usable `/proc/self/fd`**, the opened descriptor's real path must stay under the
run's realpath, so an intermediate directory swapped for a symlink between the
segment checks and the open cannot return outside bytes. On Linux where
`/proc/self/fd` is absent or unusable, existing-file reads fail closed. On
**macOS and Windows** Node core exposes no fd-to-path primitive, so the check is
unavailable: those platforms keep `O_NOFOLLOW`/`lstat`, `O_NONBLOCK`, `fstat`,
the byte cap and the intermediate-component residual race. The guarantee is not
portable. `O_NOFOLLOW` itself still covers only the final path component. The
run-context line injected by `describeRun` is sanitised (`clean()`, bounded
reads that refuse symlinks and non-regular files) but not authenticated: a
writer that can already modify the run directory can influence what agents read
there. Verdicts are not affected — they are recomputed from the evidence
artifacts, not from injected context. `events.jsonl` remains a best-effort,
fail-open path with the same guarantee boundary.

**Write path (ADR 0010).** Run-artifact writes are **preventive on Linux** when
`/proc/self/fd` is usable. The writer opens the destination's parent directory
once (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`), requires an exact `/proc/self/fd`
realpath match with the run realpath, and then expresses every create, mkdir,
rename, write, lstat and unlink as
`/proc/self/fd/<dirfd>/<one-validated-segment>`. A directory swapped for a
symlink after the pin cannot redirect the bytes. Each write uses a fresh random
temp segment with `O_CREAT|O_EXCL|O_NOFOLLOW`, an `fstat` + `fsync`, a rename
under the pinned descriptor, and a post-rename `(dev, ino)` identity compare.
`ORIGINAL_REQUEST.md` is created once (`O_CREAT|O_EXCL`, write-once); an append
(`events.jsonl`, `pitfalls.md`) is refused when the opened inode has
`nlink !== 1`, so a hard link planted at the log cannot modify an outside file.
The cross-process lock file is created inside the same pinned directory
(`withPinnedCrossProcessLock`), keyed in-process by the stable realpath plus
relative path. Known run subdirectories are pre-created at plan time.

**Boundary.** This is a Linux guarantee. **Linux without procfs fails closed**
(nothing is written). **macOS and Windows are detective**: there is no pure-JS
dir-relative write without a native addon, so writers keep the path-based atomic
write plus a **detective** containment/identity check. 0.13.0 pins the run root
and every existing ancestor `(dev, ino)` at target time, re-stats them
immediately before the create/rename/unlink and again in the post-check, and
refuses a mismatch as `identity-changed`; a legitimately renamed run root fails
closed. The signed `run.manifest.json` also records the run-root identity at
plan time, re-checked before control-plane writes. **A detected write is a
report about an event that already happened, not a prevented one:** a transient
swap that is reverted before the check can be missed, and a detected write is
not rolled back. That is the permanent platform stance. The first `mkdir` of the
run root is still path-based, and a same-UID process that can ptrace the plugin
is outside this boundary. Containment does not authenticate artifact content: a
writer that can already modify the run directory can still forge content inside
it, which is why verdicts are recomputed from evidence.

**Pinned-write policy.** `OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1` (or a
plan's `requirePinnedWrites: true`) makes the fail-closed stance explicit: on a
host whose write-containment mode is not `pinned`, control-plane writes
(manifest, state, costs, `verify/*`, handoffs, plan) are refused with a named
`containment-mode` refusal and nothing is written. It is off by default.
`doctor --security` reports the mode and the env setting; when the policy is
asserted and the mode is not pinned, the check is a failure and
`--require-hardened` exits 2.

- `tournament/manifest.json`: 5-phase bounded state machine (`PROPOSE → FALSIFY_PRUNE → MERGE → REFEREE_SCORE → VICTORY_AUDIT` → `COMPLETED | FAILED | CANCELLED | BUDGET_HALTED`), `optInProof`, `budgetEstimate`, `candidates`, and deterministic `rankedCandidates`.
- `tournament/verdict.json`: written by `team/referee` on `audit` (`ACCEPT`/`REJECT`) or by `finalizeTournamentPartial` on cancellation/budget halt (`PARTIAL`).
- `TOURNAMENT_REPORT.md` (+ `interrupted.md` + `state.json` `phase: "PRESENT_PARTIAL"` + `tournament_cancelled` event on `AbortSignal`, explicit `cancel`, or `shouldHalt` / budget exhaustion).
- `teamwork_final_verify` stamps `evidence.tournament` into `verify/final.json` and refuses `PASS` unless `manifest.phase === "COMPLETED"` with a `team/referee` `ACCEPT` verdict.

## Offline verification (`opencode-teamwork verify`)

`opencode-teamwork verify` recomputes a run's named relations from the bytes in
one run directory plus a public key. It never writes into the run, never reads
`ctx.storage`, and never executes a reported check. See
[ADR 0015](adr/0015-offline-verification.md).

```sh
opencode-teamwork verify --session <id> --public-key <base64url|@file> [--key-id <id>] [--json]
opencode-teamwork verify --run-dir <path> --public-key ...
opencode-teamwork verify --session <id> --hmac-key <base64url> --hmac-key-id <id>
```

The manifest is the trust anchor. Its `_auth` is verified first; `runNonce`,
`runKeyId` and the algorithm are read from the signed payload (not from
storage), then every artifact is pinned to those values. A copied envelope
fails on path, nonce, key id or digest.

### What the verifier recomputes

| Artifact | Recomputed relation |
| --- | --- |
| `run.manifest.json` | `_auth`; `requestHash`, `requirementsHash`, `planHash`, `lemmaPolicyHash`, `specHash`/`specBytes` against the artifacts on disk; plan/state mode drift |
| `verify/report-<task>.json` | `_auth`; task id and PASS schema; each check's `outputSha256`; `passed` vs `exitCode` (`CHECK_EXIT_CONFLICT`); `workerHandoff` path+sha256 vs the current body and `handoffs/index.json` |
| `verify/security-audit.json` | `_auth`; one `ruleChecks` entry for every rule forbidden by the integrity mode parsed from `ORIGINAL_REQUEST.md`; `reviewedDigests.reports`/`final` vs current bytes; violations on a PASS |
| `verify/challenge-<task>.json`, `verify/audit-<task>.json` | `_auth`; `kind`/`verdict`/`agent`/`sessionId`; `reportHash` (unkeyed sha256) vs the current report; every `cites[].sha256` and `bytes`; `cites: []` is unbound (fail), absent is `legacy_unbound_wave` (warn) |
| `verify/victory.json` | `_auth`; `evidenceDigests.reports` vs every current report (including "appeared after" and "never reviewed"); `securityAudit` and a pre-existing PASS `final`; `requestHash`/`requirementsHash`; requirement coverage |
| `handoffs/index.json` + `<entry>.md` | each entry's `_auth` (payload rebuilt from the entry), body sha256/bytes, canonical `# HANDOFF — <taskId> — <agent>` header, and every citation |
| `verify/final.json` | `_auth`; `evidence.reportDigests` (a `null` for a PASS is a failure), `evidence.auditDigest`, `requirementsHash`; its PASS claim against task/report/audit/victory/handoff evidence |
| Cross-artifact | `INCONSISTENT_VICTORY_TASK`, `INCONSISTENT_REPORT_BRANCH`, `INCONSISTENT_AUDIT_HIGH`, `INCONSISTENT_WAVE_REPORT` |
| Optional | `--repo` branch head/diff vs `headSha`/`diffHash`; `--require-index` snapshot vs every run file |

Wave `cites` and `reportHash` use **unkeyed** SHA-256 (matching `strict.ts`);
`evidenceDigests`, `reviewedDigests`, handoff hashes and final digests use the
keyed domain-separated digest from `approval-format.mjs`. The two are never
mixed.

### Exit codes and JSON

`0` verified (`PASS`), `1` fail (`FAIL`), `2` unverifiable (`UNKNOWN`), `3`
usage. `--fail-on-warning` promotes a warning to exit 1. `--json` prints the
stable object described in ADR 0015; the human table is rendered from it.
`--allow-unsigned` analyses an unsigned legacy run but the verdict stays
`UNKNOWN`: a missing signature is exactly what the verifier cannot supply.

### Index snapshot (`--require-index`)

A per-artifact check cannot see a whole-run rollback to an earlier validly
signed set. A snapshot maps each run-relative file to its unkeyed SHA-256:

```json
{
  "version": 1,
  "runId": "20261124-120000-abcd",
  "generatedAt": "2026-11-24T12:06:00.000Z",
  "files": { "run.manifest.json": "<sha256>", "verify/report-R1.json": "<sha256>" }
}
```

Every snapshot file must still match, and every current run file must be in the
snapshot. A difference is `INDEX_ROLLBACK` (exit 1). `--require-index` without a
path is `UNKNOWN` (exit 2). The snapshot is caller-supplied, not signed by this
tool.

### What it cannot prove

A verifier holding only the public key and a read-only copy can recompute every
byte digest, citation, branch binding and cross-artifact relation; it still
cannot prove an observation, a consistently authored false report passes every
check, and a whole-run rollback to an earlier signed set is undetectable without
a snapshot or witness.

## Export report (`report.html` / `report.md`)

`opencode-teamwork export` writes a human-readable report of one run. It is a
reporting output only: it is read by no engine tool, no agent, and no gate, and
deleting it changes nothing about the run.

**Where it is written.** Without `-o`, the file goes to the run directory:

- HTML (default): `.opencode/teamwork/<session-id>/report.html`
- Markdown (`-m` / `--markdown`): `.opencode/teamwork/<session-id>/report.md`

The CLI prints the **absolute** path of the file it wrote. With `-o <file>` the
report goes to that path instead. With `-o -` it is streamed to stdout and no file
is written. The export reads the run directory and never modifies it.

**Format: HTML.** A standalone single-file document. CSS is embedded in a `<style>`
block, and the file has no external CDN, fonts, scripts, or images. It works fully
offline and is safe to attach to an issue or archive. Dynamic text is HTML-escaped,
and absolute `http(s)://` URLs in quoted text are defanged, so the file contains no
live links.

**Format: Markdown.** GitHub-flavored Markdown with tables and a checklist. It is
suitable for pasting into a PR description or an issue comment.

**Contents** (both formats, in this order):

| Section | Source |
| --- | --- |
| Summary | `plan.dag.json`, `state.json`, `costs.json`, `events.jsonl`: session id, topology, overall status, phase, duration, budget, spend, tokens, task totals |
| Run terms | integrity mode, input-preflight status, final-verdict provenance, `victory` label, handoff-gate status, and artifact-authenticity display (envelope presence only; HMACs are not verified) |
| Tasks | one row per task: status, worker, verifier, rounds, duration, cost, checks. Details: summary, feedback, fatal findings, branch, worktree |
| Acceptance checklist | (Markdown) one box per task, ticked when `verified_pass`, plus the security gate |
| Security audit | `verify/security-audit.json`: pre-merge status, severity counts, findings |
| Final verification | `verify/final.json`, when present |
| Pitfalls | `pitfalls.md` entries |
| Other cost buckets | cost buckets that are not task ids (HTML only, when present) |
| Warnings | files that were oversize, unreadable, or malformed and were skipped |

**Run terms labels.** `victory` is copied from `verify/final.json` (for example
`CONFIRMED`, or `SKIPPED (explicit): <reason>`). The handoff gate is shown as
`required (PASS|MISSING|STALE|INVALID)` or `SKIPPED (explicit)`. Artifact
authenticity is **envelope presence only**: `signed` means an `_auth` object is
present (the export has no key and cannot verify the MAC), `unsigned` means it
is absent, and `unknown` means there is no final verdict. A final report that
reports `PASS` while required handoffs are unmet is marked
**ENGINE WOULD REJECT**; the export never upgrades that to a clean PASS claim.

The overall status is decided from three inputs: the tasks, the security audit, and
`verify/final.json`. It is checked in this order:

1. `FAIL` when any task is `verified_fail` or `blocked`, when the security audit
   reports `FAIL` or has any `critical` or `high` finding, or when
   `verify/final.json` reports `FAIL`.
2. `PASS` when `verify/final.json` reports `PASS` (even if some tasks are not yet
   `verified_pass`).
3. `PASS` when there is at least one task, every task is `verified_pass`, and the
   audit did not fail.
4. Otherwise `INCOMPLETE`. (If `tournament/` is present with phase `CANCELLED`, `BUDGET_HALTED`, or any non-`COMPLETED` phase, `export` never promotes the run to `PASS` via task fallback and reports `FAIL` or `INCOMPLETE`.)

Missing `events.jsonl` data is shown
as "timing unknown" rather than guessed.

**Errors.** A missing or invalid run (no run directory, or no valid
`plan.dag.json` / `state.json`) makes `export` exit with code `1`, as does a
file-write error.

