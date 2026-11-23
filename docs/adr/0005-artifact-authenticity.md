# ADR 0005: Artifact Authenticity — Signed Control-Plane Artifacts and a Storage-Backed Digest Index

- **Status:** Accepted (Phase A)
- **Date:** 2026-11-22
- **Scope:** `plugins/opencode-teamwork/auth.ts`, `tools.ts`, `victory.ts`, `strict.ts`
- **Supersedes:** the "run artifacts are unauthenticated" residual in `docs/GUARDRAILS.md`

## 1. Context

Every completion decision in a Teamwork run is recomputed from files under
`<workspace>/.opencode/teamwork/<session-id>/`. Before this ADR the engine verified
the *semantics* of those files — agent labels, task ids, verdict strings,
`reportHash` bindings, request hashes — but not their *origin*. That left a
specific gap:

> A writer who can create or modify a file inside the run directory (a shell
> command, a tool that forgot its boundary, a prompt-injected agent) can write a
> `verify/victory.json` with `VICTORY CONFIRMED`, a `verify/report-<task>.json`
> with `PASS`, or a `verify/final.json` with `PASS`, and the engine will trust
> it after the ordinary schema checks pass.

Two distinct attackers matter:

1. **Run-dir-only writer.** Can write inside `.opencode/teamwork/<id>/` but
   cannot read the plugin key store. This is the Phase A target.
2. **Same-UID process with local read access.** Can read `opencode.db` or the
   plugin KV backing store, hence can read the HMAC key and mint valid MACs.
   Phase A does **not** stop this attacker. Phase B decides whether to isolate
   the key (OS keychain, separate user, hardware-backed key, or an out-of-process
   signer).

The design also closes a control-plane downgrade: an attacker who can edit
`plan.dag.json` or `state.json` could previously turn `verification: strict`
into `standard`, or `victoryAudit: required` into `skip`, and the gates would
follow the edited file.

## 2. Decision

Phase A makes the run-dir-only forgery **tamper-evident** and pins the run's
completion policy in a signed baseline:

1. **Key ring in plugin storage.** `auth.ts` keeps a key ring at `ctx.storage`
   key `auth/key/ring` (`{version: 1, keys: [{keyId, key, createdAt, retiredAt}]}`).
   The ring holds the current key plus up to two previous keys. On first use it
   creates `randomBytes(32)`, writes, re-reads, and caches the result; a
   malformed ring fails closed with `AUTH_KEY_CORRUPT` and is never silently
   rotated. `OPENCODE_TEAMWORK_HMAC_KEY` (base64url, 32 bytes) and optional
   `OPENCODE_TEAMWORK_HMAC_KEY_ID` are the CI/offline override.
2. **Canonical signing.** `canonicalJson` sorts object keys, preserves array
   order, and rejects `undefined`, non-finite numbers, non-plain objects and
   cycles. Each artifact gets `_auth {v: 1, alg: "hmac-sha256", keyId, path,
   digest, mac, at}` where `digest = sha256(canonicalJson(payload without
   _auth))` and `mac = HMAC-SHA256(key, canonicalJson(envelope without mac))`.
   Verification checks the path, key id, digest, and MAC with
   `timingSafeEqual`.
3. **Digest index outside the run dir.** Every signed artifact also writes
   `auth/run/<runId>/<relPath>` = `{v, path, digest, keyId, mac, at}` to
   `ctx.storage`. A signed run fails closed if the index entry is missing
   (`AUTH_INDEX_MISSING`) or disagrees with the artifact (`AUTH_STALE`). The
   engine never auto-adopts an old artifact into the index, so copying a valid
   artifact into another run does not carry its authority.
4. **Signed plan baseline.** `teamwork_plan` writes `run.manifest.json` with
   `version`, `sessionId`, `rootSessionId`, `integrityMode`, `verification`,
   `victoryAudit`, `requestHash`, `requirementsHash`, `planHash`,
   `lemmaPolicyHash`, `runKeyId`, `createdAt`, `_auth`. Re-plans verify the
   baseline and refuse any mode or hash change. `final_verify`/`next` recompute
   the same hashes and return `AUTH_STALE` on drift.
5. **Signed verdicts.** `verify/report-<task>.json` (via the new
   `teamwork_report` writer), `verify/security-audit.json`,
   `verify/challenge-<task>.json`, `verify/audit-<task>.json`,
   `verify/victory.json`, and `verify/final.json` are signed at their write
   points. Victory and final bind `requirementsHash`; final also records per-
   report and security-audit digests so a later edit makes the verdict stale.
6. **Session-tree binding.** `rootSessionId` is recorded at plan time.
   `teamwork_victory_audit`, `teamwork_wave_record`, and `teamwork_report`
   require the caller session to be a strict descendant of that root, walked
   through `ctx.session.get(...).parentID` with a bound and fail-closed on an
   unresolvable chain. This closes `opencode run --agent team/victory-auditor`
   (a top-level session that never descended from the run).
7. **Explicit legacy path.** `teamwork_plan` accepts `allowUnsignedLegacy`
   (default `false`) to create or keep an unsigned pre-1.4 run. `final_verify`
   and `next` return `AUTH_LEGACY` for an unsigned run until the caller passes
   `allowUnsignedLegacy: true`; the bypass is recorded as a
   `legacy_unsigned_bypass` event. `benchmark` mode refuses both
   `allowUnsignedLegacy` and `victoryAudit: "skip"`.

Failure vocabulary: `AUTH_UNAVAILABLE`, `AUTH_KEY_CORRUPT`, `AUTH_MISSING`,
`AUTH_INVALID`, `AUTH_UNKNOWN_KEY`, `AUTH_INDEX_MISSING`, `AUTH_STALE`,
`AUTH_LEGACY`.

## 3. Exact boundary

Protected against a run-dir-only writer:

- Forging a verifier report, security audit, strict-wave verdict, victory
  verdict, or final verdict.
- Flipping a signed verdict field (status, requirements, auditor, summary).
- Copying an `_auth` envelope between files or runs.
- Downgrading `verification`, `victoryAudit`, `integrityMode`, the plan, the
  request, the requirements baseline, or the LEMMA axiom policy after signing.
- Re-using a stale report after the final verdict (final records report digests).

**Not protected:**

- A same-UID shell (or any process that can read the OpenCode DB / plugin KV
  backing store) can read the HMAC key and compute a valid envelope. Phase A
  makes an *in-run-dir* forgery evident; it does not isolate the key from the
  user account.
- A caller with write access to `ctx.storage` can rewrite the digest index.
  The storage is plugin-global and outside the run dir, but it is not a
  different privilege domain.
- The CLI readers (`opencode-teamwork runs | inspect | timeline | export`) have
  no key-ring access. They display `signed` (an `_auth` envelope is present),
  `unsigned`, or `unknown`, and never claim verification.
- A same-UID writer can delete the whole run or deny service; authenticity is
  about accepting a verdict, not availability.

## 4. Phase B options (not decided here)

1. **OS keychain / secret service** (libsecret, macOS Keychain, Windows
   Credential Manager) with a key that is not in the user's readable KV store.
   Same-UID processes may still call the keychain unless the OS gates by
   application identity.
2. **Separate OS user or helper process** that owns the key and exposes only
   sign/verify over a socket; the workspace process never sees the key.
3. **Hardware-backed key** (TPM/Secure Enclave) with a non-exportable key.
4. **Asymmetric signatures** (Ed25519) with the private key held by the helper;
   the run dir only needs the public key, so verification no longer requires
   key secrecy.
5. **Transparency log / append-only remote witness** for the digest index,
   making storage tampering detectable after the fact.

> **Phase B assessment (2026-11-22).** `docs/adr/0006-artifact-trust-isolation.md`
> evaluates these options against the same-UID shell on the review host. It
> finds that a bare separate-UID signer (option 2) is a signing oracle, that an
> OS keychain is not a UID boundary, and that `ctx.permission.assert` is
> auto-approvable. It recommends accepting and documenting the Phase A boundary
> for Sprint 2.1, and records a human-presence gate or an independent verifier
> as the missing primitive. This pointer does not change the Phase A decision
> above.

The Phase A HMAC envelope, canonical encoding, path binding, digest index, and
manifest schema are deliberately compatible with Phase B: moving to Ed25519 or a
helper process changes the key holder and MAC/signature algorithm, not the
artifact shapes.

## 5. Consequences

- A missing `ctx.storage` refuses a signed plan (`AUTH_UNAVAILABLE`); CI/tests
  can use the env key, and an explicit `allowUnsignedLegacy` run remains
  possible for migration.
- Storage loss makes existing signed artifacts fail closed
  (`AUTH_INDEX_MISSING`) rather than silently pass.
- Every control-plane write now has an async signing step; failures leave the
  old artifact in place and return a named refusal.
- Legacy runs need an explicit, recorded bypass at both the plan and the
  completion gate.
