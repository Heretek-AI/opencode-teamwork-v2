# ADR 0007: Signed Handoff Index Entries

- **Status:** Accepted (0.9.0, workstream B)
- **Date:** 2026-11-23
- **Scope:** `plugins/opencode-teamwork/handoff.ts`, `tools.ts`, `strict.ts`
- **Extends:** [ADR 0005](0005-artifact-authenticity.md) (artifact authenticity)

## 1. Context

A Teamwork handoff is a five-section narrative one agent leaves for the next.
Since 0.8.0 it is written only through `teamwork_handoff`, sanitised/bounded, and
recorded in `handoffs/index.json` with a plain sha256 of the exact bytes. The
continuity gate re-reads the file identity, index hash, canonical header, and
citation hashes; it never parses the prose.

That change detector does not answer a provenance question:

> A writer confined to the run directory could edit `handoffs/index.json` to
> point a handoff at a different body, rewrite an indexed body together with its
> hash, or copy an entry from another run, and the gate would accept the result
> as long as the structural rules held.

ADR 0005 already signs every control-plane verdict (reports, audits, waves,
victory, final) and pins the plan baseline. Handoffs were deliberately excluded
because they are not verdicts and because signing the markdown would change the
five-heading contract. The gap is provenance of the *index entry*, not authority
of the narrative.

## 2. Decision

Sign the index entry, never the markdown.

1. **Payload.** A signed entry's envelope covers canonical JSON:

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

   `auth.signRunArtifact(runId, path, payload)` adds the standard ADR 0005
   `_auth` envelope and a digest-index record at
   `auth/run/<runId>/handoffs/<taskId|_run>-<role>.md`. The index entry stores
   `_auth` and `runKeyId`; the markdown is byte-identical to 0.8.0.

2. **Write path.** `writeHandoff` writes the markdown atomically, then signs and
   commits the index under the existing handoff-index cross-process lock. If the
   run requires a signature and signing fails, the call is refused and no
   unsigned entry is written. A legacy run tolerates an unsigned entry; a later
   re-record signs it and upgrades that pair.

3. **Manifest baseline.** `run.manifest.json` gains optional
   `handoffAuth: "signed" | "legacy"`. New signed plans write `"signed"`;
   `allowUnsignedLegacy` plans write `"legacy"`; an absent field (0.8.0) is read
   as `"legacy"`. A re-plan may upgrade legacy→signed, but signed→legacy is
   `AUTH_STALE` and refused.

4. **Checked gate.** `evaluateHandoffGateChecked` runs the existing structural
   gate unchanged, then verifies every present entry's `_auth` (path, payload
   digest, MAC, run id, key id) and `entry.runKeyId === manifest.runKeyId`.
   Failures append `[AUTH_*]` reasons and map to `INVALID` /
   `BLOCKED_BY_HANDOFFS`. `final_verify` and `next` use the checked gate;
   `evidence.handoffs` records `auth: signed|unsigned|invalid` and `keyId`;
   strict `GATE_STATUS.md` gains an optional `Auth` column.

5. **No prose authority.** The gate still never parses the narrative for
   PASS/FAIL and never changes what a report, wave, or victory audit decides. A
   handoff can make a run fail; it can never make one pass.

## 3. Compatibility and migration

- 0.8.0 manifests without `handoffAuth` keep working: legacy mode tolerates
  unsigned entries, but a present-and-invalid `_auth` is rejected.
- There is no new bypass input. The remedy for an unsigned entry on a signed run
  is to re-record the handoff through `teamwork_handoff`, which signs the new
  entry and refreshes its cited body hash.
- Storage loss fails closed for signed entries (`AUTH_UNAVAILABLE` /
  `AUTH_INDEX_MISSING`); it does not silently downgrade to legacy.

## 4. Boundary

This makes a run-dir-only edit of the handoff index tamper-evident. It does not
isolate the HMAC key: a same-UID process with read access to `opencode.db` / the
plugin KV store can mint a valid envelope, as in ADR 0005/0006. A signature also
does not prove the sender observed what it wrote; it binds the recording session
to the bytes and citations. Handoffs remain continuity evidence, never a second
verdict authority.
