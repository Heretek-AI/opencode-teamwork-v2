# ADR 0012: Evidence Binding and Contradiction Detection

- **Status:** Accepted (0.12.0)
- **Date:** 2026-11-23
- **Scope:** `plugins/opencode-teamwork/{tools.ts,victory.ts,strict.ts,handoff.ts,authorize.ts}`,
  `docs/ARTIFACTS.md`, `docs/GUARDRAILS.md`, `SECURITY.md`, `scripts/test-engine.mjs`
- **Extends:** [ADR 0005](0005-artifact-authenticity.md) (envelope + digest index),
  [ADR 0007](0007-signed-handoff-provenance.md) (signed handoff index),
  [ADR 0009](0009-claim-protocol-and-crash-recovery.md) (round/branch-bound reports)
- **Related:** [ADR 0006](0006-artifact-trust-isolation.md) (why one UID is not a boundary),
  [ADR 0010](0010-pinned-fd-write-containment.md) (pinned writes)

## 1. Context

By 0.11.0 every completion artifact was authenticated, but each verdict was only
loosely bound to the evidence it claimed to have reviewed:

1. `verify/victory.json` bound the request and requirements baseline, not the
   per-task reports or the security audit. A report could be rewritten after a
   `VICTORY CONFIRMED` and the verdict still read as current.
2. `verify/report-<task>.json` bound a branch (ADR 0009) but not the worker
   handoff that preceded it. A verifier could report `PASS` with no continuity
   narrative, and a re-recorded worker handoff did not invalidate the report.
3. `verify/security-audit.json` recorded integrity findings, but not which
   rules it had checked. A `PASS` could omit a rule the run's mode forbids, and
   nothing recorded the reports the auditor actually looked at.
4. `verify/challenge-<task>.json` / `verify/audit-<task>.json` bound a report
   hash, but not the evidence (`verify/` artifacts) the reviewer inspected.
5. Handoff citations were one-directional: a verifier handoff cited its report,
   never the worker handoff it followed.
6. Individually valid artifacts could contradict each other: a confirmed
   victory over a failing task, a `PASS` report for a moved branch, a `CLEAN`
   audit with a `High` finding, or a wave verdict bound to a `FAIL` report. Each
   check passed on its own.

The remaining design question is not "can a same-UID writer lie?" (it can; see
ADR 0006) but "when it lies, is the claim specific enough that a privileged
verifier can falsify it without re-running the whole run?".

## 2. Decision

### 2.1 Victory binds reviewed digests (A3)

`teamwork_victory_audit` computes, from disk and never from caller input:

```json
"evidenceDigests": {
  "reports": { "<taskId>": "<sha256 of verify/report-<taskId>.json>" },
  "securityAudit": "<sha256 of verify/security-audit.json>|null",
  "final": "<sha256 of a PASS verify/final.json>|null"
}
```

- `CONFIRMED` with an empty `reports` map is refused at record time.
- `evaluateVictoryGate`/`final_verify`/`next` recompute the same set. Any
  difference is `AUTH_STALE`, and `next` returns status `AUTH_STALE` with the
  drift reasons.
- A legacy verdict without `evidenceDigests` is stale, never silently current.
- A `final` digest is bound only when it is already a `PASS` verdict and was
  written before the audit; the normal order is audit → `final_verify`, so a
  later final is not a contradiction.

The verdict remains an audit input, not the PASS/FAIL authority: the engine
still recomputes task status and report/audit semantics.

### 2.2 Reports bind the worker handoff (A4)

`teamwork_report` resolves the task's assigned worker from `plan.dag.json`
(default `team/worker`) and reads `handoffs/index.json` itself, filling:

```json
"workerHandoff": { "taskId": "...", "agent": "team/worker", "path": "handoffs/...-worker.md", "sha256": "..." }
```

- With `requireHandoffs: "required"` a `PASS` report is refused as
  `REPORT_HANDOFF_MISSING` when the handoff is absent, and
  `REPORT_HANDOFF_STALE` when the indexed body hash no longer matches.
- `final_verify` re-checks the binding for every `PASS` report; `next` also
  treats a re-recorded worker handoff as drift.
- A worker handoff recorded after the report is a new narrative (new
  `generatedAt`), so it changes the body hash and deliberately stales the old
  report. Re-record the report after the handoff, not before.

### 2.3 Security audits record coverage (A5)

`teamwork_security_audit` writes:

```json
"ruleChecks": [
  { "rule": "fabricated_output", "result": "clean" },
  { "rule": "core_logic_copied", "result": "violation", "where": "src/x.ts:3" }
],
"reviewedDigests": { "reports": { "<taskId>": "<sha256>" }, "final": null }
```

- The engine builds one check for every rule forbidden at the run's integrity
  mode. A `PASS` requires each exactly once; a `violation` forces `FAIL`.
- `final_verify` refuses a `PASS` audit that omits a forbidden rule, records a
  violation, or whose `reviewedDigests` drifted (`AUTH_STALE`). `next` surfaces
  digest drift as `AUTH_STALE` before the handoff/final gates.

### 2.4 Wave verdicts cite hashed evidence (A6)

`teamwork_wave_record` accepts up to 16 `cites` paths inside `verify/`. The
engine reads each file through the bounded reader and records
`[{ "path", "sha256", "bytes" }]`. `readWaveEvidence` re-hashes every cite:
missing, changed, or resized evidence makes the verdict `STALE`. A pre-0.12.0
verdict without `cites` still reads, but carries a `legacy_unbound_wave`
warning in `final.json` and is never silently current.

### 2.5 Verifier → worker → report chain (A7)

For `team/verifier`, `collectCites` appends
`handoffs/<taskId>-<assignedWorker>.md` when present (after the report cite).
A re-recorded worker handoff therefore stales the verifier handoff, and the
gate names `handoffs/<task>-verifier.md is stale: handoffs/<task>-worker.md
changed`. The handoff cite allowlist accepts `handoffs/*.md` and
`verify/*.json`; prose is still never a verdict.

### 2.6 Contradictions are named refusals (O6)

`final_verify` and `next` detect:

| Code | Contradiction |
| --- | --- |
| `INCONSISTENT_VICTORY_TASK` | `VICTORY CONFIRMED` while a task is `verified_fail` or its report is `FAIL` |
| `INCONSISTENT_REPORT_BRANCH` | a `PASS` report's `headSha`/`diffHash` disagrees with the current verified branch |
| `INCONSISTENT_AUDIT_HIGH` | a `PASS` security audit with a `High`/`Critical` finding |
| `INCONSISTENT_WAVE_REPORT` | a wave verdict bound to the current hash of a `FAIL` report |

`final_verify` appends `[CODE] detail` reasons and records
`contradictions`; `next` returns `INCONSISTENT_EVIDENCE` before any readiness or
completion path. Nothing is auto-fixed: the operator re-records the named
evidence.

### 2.7 Bounded evidence artifacts (A9)

`teamwork_evidence` writes one `verify/evidence/<name>` file through the pinned
writer (ADR 0010): one safe segment, 64 KiB per file, 32 files per run, trusted
team roles only. It returns `{path, sha256, bytes}`. Wave `cites` accept those
paths, record `bytes`, and the gate re-hashes them. A missing or edited
artifact is a `FAIL` reason. This records **bytes**, not a verdict.

## 3. Honest boundary sentence

> a same-UID writer can still author false content; the engine guarantees the
> false claim is specific, signed, path-bound and digest-chained, so a
> privileged verifier can falsify it.

Three distinct claims are now visible in the artifacts:

1. **Bytes.** `sha256`/`_auth` bind the exact file bytes and path. This catches
   edits, copies, truncation, and cross-run reuse, not the meaning of the bytes.
2. **Facts.** Engine-computed relations — `workerHandoff` binding, rule
   coverage, `reviewedDigests`, cite hashes, contradiction codes — are derived
   from disk. They can make a run fail; they cannot make a dishonest claim true.
3. **Observation.** The auditor's/verifier's judgment (that a requirement is
   met, that a rule is clean) is recorded, not proven. The engine never parses
   prose as PASS/FAIL.

## 4. Residuals

- **Judgment remains unprovable.** A correctly signed `CLEAN` audit can be
  wrong; the engine binds the claim, not the reviewer's competence.
- **Fabricated evidence at creation.** A writer can author a false report or a
  false evidence artifact and then cite it consistently. Binding makes the
  claim specific and falsifiable, not true.
- **Same-UID writer.** It can read the key store, mint envelopes, and rewrite
  digests. The guarantee is against a run-dir-limited writer; ADR 0006 is
  unchanged.
- **No re-execution.** The gate re-hashes artifacts and recomputes relations;
  it does not re-run tests or re-inspect a branch in an isolated environment.
- **Legacy artifacts.** Pre-0.12.0 victories/waves are stale/warned, not
  upgraded. Pre-0.12.0 reports without `workerHandoff` fail a required run
  until re-recorded through `teamwork_report`.
- **Time-based final guard.** A `final.json` written after an audit is not
  treated as reviewed evidence; the guard uses `generatedAt` timestamps, so a
  writer with clock control is back inside the same-UID boundary.
