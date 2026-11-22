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
├── plan.dag.json            # task DAG (+ preflight gate result + verification/victoryAudit modes)
├── preflight.json           # input-checks report (written by teamwork_preflight)
├── state.json               # resumable coordinator state
├── costs.json               # coordinator-maintained budget tracker
├── BRIEFING.md              # shared run briefing: mission, identity, constraints, status, artifacts, succession
├── handoff.md               # five-section agent handoff (completion, block, or handoff)
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
  "phase": "LOAD_SPEC|WORKTREE_INIT|DAG_BUILD|DISPATCH|SECURITY_AUDIT|FINAL_VERIFICATION|MERGE|PRESENT_PARTIAL|DONE",
  "tasks": {
    "R1-impl": {
      "status": "pending|worker_active|worker_done|verifier_active|verified_pass|verified_fail|blocked",
      "round": 1,
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
- Victory: CONFIRMED|REJECTED|PENDING|SKIPPED

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

### `handoff.md` — five-section agent handoff

Required whenever an agent **completes, blocks, or hands off**. The next agent
(or the Sentinel) reads it instead of replaying the session, so it must stand on
its own and use exactly these five sections:

```markdown
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

Keep it short and evidence-first; never assert a PASS you did not observe.

### Engine Tools

The plugin provides deterministic orchestration tools for the Sentinel coordinator:
- `teamwork_plan`: Creates the run directory and writes `plan.dag.json`, `state.json` and `costs.json`. It is gated on a spec by default (`requireSpec`, see below). `skipInterview` is the explicit, recorded bypass. `verification` selects `standard` (default, unchanged) or `strict` (per-task falsifier challenge + security-auditor audit); it is persisted in both artifacts and a re-plan cannot change it.
- `teamwork_route`: Deterministic read-only route classifier checking `document-review` FIRST (before Math/Proof) when a supplied document has critique intent while rejecting PR/code reviews, bare filenames without supplied docs, and problem-solving/coding tasks.
- `teamwork_document_triage`: Validates bounds (`maxSegments <= 8`, `reviewTreeShape <= [4,2,1]`, `synthTreeShape <= [4,1]`), path containment (`realpathSync` + `O_NOFOLLOW`), URL/inline limits, and PDF headers **before** creating any directory, ingests and partitions the document into `seg-01`..`seg-0K` + `doc-synthesis`, and writes `document-review/{manifest.json,DOCUMENT_TEXT_MAP.md,ANALYSIS_PARTITION.md}`.
- `teamwork_document_record`: Persists bounded RSA node outputs (`level-<L>-node-<I>.json`), `unit-report.md`, `synthesis/candidate-<I>.md`, and `DOCUMENT_REVIEW_REPORT.md` with `SEGMENT_ID` allowlist, manifest bounds, symlink refusal, and `clean()`/`cleanBlock()` sanitisation.
- `teamwork_next`: Evaluates the DAG dependencies against current task lifecycle statuses. Categorizes tasks into `readyForWorker`, `readyForVerifier`, `inProgress`, or terminal conditions (`ALL_TASKS_PASSED` / `DEADLOCK`). Completion additionally requires a stamped `verify/final.json` from `teamwork_final_verify` (unless the caller passes the recorded `allowUnstamped: true` legacy bypass) **and** a `CONFIRMED` `verify/victory.json` bound to the current `ORIGINAL_REQUEST.md`, unless the plan explicitly recorded `victoryAudit: "skip"`. Before a confirmed verdict it returns `READY_FOR_VICTORY_AUDIT` (or `BLOCKED_BY_VICTORY_AUDIT` for a rejection). In strict mode it returns `NEEDS_STRICT_WAVE` / `BLOCKED_BY_STRICT_WAVE` first, listing the missing `taskId:kind` pairs, and never returns `ALL_PASSED` without both per-task verdicts.
- `teamwork_task_update`: Enforces deterministic state transitions, tracks worker branch names and diff summaries, updates verifier metrics, and advances run `phase` to `MERGE` or `PRESENT_PARTIAL`.
- `teamwork_victory_audit`: Records the independent final acceptance verdict from `team/victory-auditor`. Only a trusted session whose agent resolves to `team/victory-auditor` may call it; there is no caller-supplied `agent` label. Every `requirements.json` id must appear exactly once, `met: true` needs non-empty evidence, and `VICTORY CONFIRMED` needs a current `ORIGINAL_REQUEST.md` (the verdict stores its sha256). Writes `verify/victory.json`; a confirmed verdict is write-once.
- `teamwork_wave_record`: Strict mode only. Records one wave verdict: `kind: "challenge"` / `verdict: "PASS"` may only be written by a trusted session whose agent resolves to `team/falsifier`; `kind: "audit"` / `verdict: "CLEAN"` only by `team/security-auditor`. There is no caller-supplied `agent` label. It refuses a task absent from `plan.dag.json`, a missing/non-PASS `verify/report-<taskId>.json`, any other verdict, and a repeat recording for the same report hash. It stores the sha256 of the exact report bytes (the gate requires a match) and writes `verify/challenge-<taskId>.json` or `verify/audit-<taskId>.json` atomically, then appends a `verification_wave` event. A changed report is the only overwrite path (the previous verdict is stale).
- `teamwork_final_verify`: Computes the run's final verdict from the artifacts on disk — every task must be `verified_pass`, every `verify/report-<taskId>.json` must be `PASS`, `verify/security-audit.json` must be `PASS`, the victory audit must be `CONFIRMED` (unless explicitly skipped), and when `document-review/manifest.json` exists, every segment's `unit-report.md` and `DOCUMENT_REVIEW_REPORT.md` must exist as non-empty regular files. In strict mode it also requires `verify/challenge-<taskId>.json` (`team/falsifier`, `PASS`) and `verify/audit-<taskId>.json` (`team/security-auditor`, `CLEAN`) for every task, then writes `GATE_STATUS.md`. It writes `verify/final.json` atomically and appends a `final_verification` event. The verdict is computed from evidence; no input can turn a failing run into `PASS` (a caller-supplied `failReason` can only force `FAIL`). See [`verify/final.json`](#verifyfinaljson-final-verification-verdict).
- `teamwork_worktree`: Isolates git worktrees outside the project repo (`setup` for sentinel and worker), inspects branch diffs (`diff`), performs clean merges into `teamwork/base-$SESSION_ID` with automatic conflict abort (`merge`), and prunes worktrees (`cleanup`).
- `teamwork_preflight`: Re-checks the inputs named by an existing run's `ORIGINAL_REQUEST.md` (plus optional `inputs`), writes `<run>/preflight.json`, and appends a `preflight` event. It never throws and never blocks; it reports.

**Spec gate (`teamwork_plan`).** A run must start from an approved spec: `<run>/prompt_draft.md`, present and non-empty after trimming. The check runs after topology/task-id validation and **before anything is written**, so a refusal creates no run directory and no plan files. Two inputs control it:

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `requireSpec` | boolean | `true` | When true, a usable `prompt_draft.md` must exist or the plan is refused. `false` records `specGate: "not_required"`. |
| `skipInterview` | boolean | `false` | Explicit bypass: plan without an approved prompt. Recorded as `specGate: "bypassed"`, and the tool result says so. |

With no spec and neither override, the call is refused with an actionable message naming the expected path, `/teamwork-craft`, and `skipInterview: true`. A whitespace-only `prompt_draft.md` counts as no spec.

**Request record & integrity mode (`teamwork_plan`).** Two additive, optional inputs:

| Input | Type | Default | Meaning |
| --- | --- | --- | --- |
| `request` | string | omitted | The verbatim text the run was routed on (≤20,000 chars). Recorded once in `ORIGINAL_REQUEST.md` before any plan file; omitting it creates no artifact. |
| `integrityMode` | `development \| demo \| benchmark` | `development` | Recorded in `ORIGINAL_REQUEST.md`, `state.json` and `plan.dag.json`. Any other value refuses the plan before anything is written. |
| `verification` | `standard \| strict` | `standard` | Recorded in `plan.dag.json` and `state.json`. `strict` adds exactly one `team/falsifier` challenge (`PASS`) and one `team/security-auditor` audit (`CLEAN`) per task. Any other value refuses the plan before anything is written; a re-plan may omit or repeat the persisted mode but not change it. |
| `requirements` | `Array<{id, text}>` | omitted | Up to 50 plan-time requirements. `id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` and must be unique; `text` is non-empty and ≤2,000 chars. Persisted to `requirements.json` (source `caller`). Invalid/duplicate items refuse the plan before anything is written. |
| `victoryAudit` | `required \| skip` | `required` when a request/requirements baseline exists | Recorded in `plan.dag.json` and `state.json`. A run with no request and no requirements records `skip`; `required` without a baseline is refused. An explicit `skip` makes `final_verify` record `victory: "SKIPPED (explicit)"`. |

The request record is a separate artifact from the approved spec: it does not
satisfy the spec gate, and the spec gate does not replace it. `teamwork_security_audit`
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
(the default); with `checkUrls: true` each URL gets one `HEAD` request with a
3 s timeout and is `READY` on 2xx/3xx or `OUTAGE` on any other status, error or
timeout. The overall status is `OUTAGE` if any check is an outage, else
`MISSING` if any **blocking** item is missing, else `READY`. Advisory misses
never change the overall status.

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
  "updatedAt": "ISO8601"
}
```

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
minus the `lastTokens` recorded in `snapshots.json`), the same way cost deltas
are computed. A `costs.json` without `byTaskTokens` is valid: readers treat it as
absent. The manual `addUsd` path has no token data, so it adds dollars to `byTask`
only and leaves `byTaskTokens` untouched. The session-global `tokens` total is
unchanged.

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
scouts, auditors). Deltas between calls are tracked in `snapshots.json`. When
native discovery is unavailable (tests, non-OpenCode host) the tool falls back
to manual `addUsd`.

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
- `event` (string): `run_created`, `task_transition`, `security_audit`,
  `victory_audit`, `verification_wave`, `final_verification`, `final_verification_bypass`, or `preflight`
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
  `final_verification_bypass`, on `teamwork_preflight`'s `preflight` event, on
  `verification_wave`, and on `run_created` when the input-preflight gate was
  bypassed. Every other event omits it. Sanitised with `clean()`.

The eight event kinds:

- `run_created`: written by `teamwork_plan` once the run is created. `taskId` and
  `from` are `null`, `to` is `"pending"`, `round` is `0`, `phase` is `"DAG_BUILD"`.
  It additionally carries the spec-gate decision: `specGate`
  (`"satisfied" | "bypassed" | "not_required"`) and, only when satisfied,
  `specPath` (the `prompt_draft.md` path, ≤200 chars). These two fields appear
  **only** on `run_created`; every other event keeps the fields above.
  `specGate` and `specPath` also go through `clean()`. The timeline view parses
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
- `final_verification_bypass`: written by `teamwork_next` when it accepts an
  **unstamped** `verify/final.json` through the explicit `allowUnstamped: true`
  bypass. `to` is `"ALL_PASSED"`, `taskId` and `from` are `null`, `round` is
  `0`, and `phase` is the run phase after the bypass (normally `"MERGE"`).
  `agent` is the calling session's agent when it could be resolved (with
  `agentSource: "session"`), otherwise `null`. It carries a `note` explaining
  that the verdict was not produced by `teamwork_final_verify`. A stamped
  verdict never emits this event.

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

**Locking and symlinks.** Each append runs inside a per-file, in-process lock
(`withFileLock` keyed on the `events.jsonl` path). A symlinked
`events.jsonl` is refused: nothing is written through the link, and the link is left
in place.

**Best-effort, fail-open.** Writing is best-effort. Any error (including a refused
symlink) is swallowed, and no tool result changes because of it. The DAG engine
(`teamwork_next`, `teamwork_task_update`) never reads `events.jsonl`, so a run works
fully without it. Only the timeline view reads it. Without it the timeline falls back
to derived mode, with start and duration unknown.

### `verify/report-<task>.json` (verifier output)

```json
{
  "taskId": "R1-impl",
  "verifierAgent": "team/verifier",
  "verifierModel": "<model>",
  "timestamp": "ISO8601",
  "status": "PASS",
  "checks": [
    { "name": "...", "type": "programmatic|adversarial|rubric", "passed": true, "output": "..." }
  ],
  "feedbackForWorker": "...",
  "fatalFindings": [
    { "where": "file:line", "why": "...", "fix": "...", "reproduction": "..." }
  ]
}
```

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
  "notes": "Tried empty input, overflow, TOCTOU; no fatal or serious flaw.",
  "evidence": "verify/report-R1-impl.json + src/api.ts:42",
  "generatedAt": "ISO8601"
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
  "notes": "No Critical/High findings; no forbidden integrity rule.",
  "evidence": "npm test tail + git diff base..task",
  "generatedAt": "ISO8601"
}
```

Both are written only by `teamwork_wave_record`. There is no caller-supplied
agent label: the tool derives the caller from the trusted session identity and
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
  ]
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
  "requirements": [
    { "id": "R1", "met": true, "evidence": "npm test tail + src/api.ts:42" }
  ],
  "findings": ["Optional concrete gap"],
  "summary": "Independent acceptance audit prose.",
  "generatedAt": "ISO8601"
}
```

Written only by `teamwork_victory_audit`, which derives the caller from the
trusted session identity (a caller-supplied label cannot self-authorize). It
validates that every `requirements.json` id appears exactly once, that
`met: true` carries non-empty evidence, and that a `CONFIRMED` verdict has a
current `ORIGINAL_REQUEST.md`; it then stores the request's sha256. A confirmed
verdict is **write-once** (a later audit cannot overwrite it). On `REJECTED` the
Sentinel forwards `findings` and resumes the team.

The audit is an ordinary run artifact and therefore unauthenticated: a writer
already inside the run directory could forge one. `teamwork_final_verify` and
`teamwork_next` recompute the auditor label, requirement ids, and current
request hash, which catches stale, mislabelled, or partially edited verdicts.

### `verify/final.json` (final verification verdict)

```json
{
  "status": "PASS|FAIL",
  "generatedBy": { "agent": "team/verifier", "session": "ses_abc123" },
  "generatedAt": "ISO8601",
  "integrityMode": "development",
  "victory": "CONFIRMED|FAILED|SKIPPED (explicit)",
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
    "victory": { "mode": "required", "status": "CONFIRMED", "auditor": "team/victory-auditor", "requestHash": "..." },
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
  "summary": "Independent final check passed.",
  "findings": [
    { "where": "src/api.ts:42", "why": "...", "fix": "..." }
  ]
}
```

`teamwork_final_verify` writes this file atomically. `status` is `PASS` **only**
when every task in `state.json` is `verified_pass`, every task report
(`verify/report-<taskId>.json`, task ids validated with the same safe-id
allowlist) reports `PASS`, `verify/security-audit.json` reports `PASS`, and the
independent victory audit is `CONFIRMED` with every requirement met and a
`requestHash` matching the current `ORIGINAL_REQUEST.md`. A plan that explicitly
recorded `victoryAudit: "skip"` records `victory: "SKIPPED (explicit)"` instead.
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
| victory `required`, missing/rejected/stale/forged | `READY_FOR_VICTORY_AUDIT` / `BLOCKED_BY_VICTORY_AUDIT` | `FINAL_VERIFICATION` |
| victory confirmed (or explicit plan `skip`) | `ALL_PASSED` | `MERGE` |

`allowUnstamped` (boolean, default `false`) is a legacy migration escape hatch.
It accepts a hand-written report and appends one `final_verification_bypass`
event whose `note` records the acceptance. Use it only to finish runs that
predate `teamwork_final_verify`; every new run should complete through a stamped
verdict. `FINAL_VERIFICATION_UNVERIFIED` results carry `finalReport`,
`passedCount` and `integrityMode`, and the message names both remedies (run the
tool, or re-call with the bypass).

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

Gate Result: **PASS**
```

On FAIL it adds a `## Reasons` list and ends with `Gate Result: **FAIL**`. A
task adds one worker/verifier/challenger/auditor group; the wave scales by tasks
and rounds, not by a fixed row count. A stale or invalid challenge/audit is
rendered as `FAIL` in its verdict cell. If `GATE_STATUS.md` cannot be written
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

**Known limitations (same threat model).** `O_NOFOLLOW` covers only the final path
component: an intermediate directory swapped for a symlink between the segment
checks and the open is still a race. Closing it fully needs component-by-component
`openat`/`O_PATH` traversal, which is not implemented. The run-context line injected
by `describeRun` is sanitised (`clean()`, bounded reads that refuse symlinks and
non-regular files) but not authenticated: a writer that can already modify the run
directory can influence what agents read there. Verdicts are not affected — they are
recomputed from the evidence artifacts, not from injected context. `events.jsonl`
remains a best-effort, fail-open path with the same final-component TOCTOU caveat.

- `tournament/manifest.json`: 5-phase bounded state machine (`PROPOSE → FALSIFY_PRUNE → MERGE → REFEREE_SCORE → VICTORY_AUDIT` → `COMPLETED | FAILED | CANCELLED | BUDGET_HALTED`), `optInProof`, `budgetEstimate`, `candidates`, and deterministic `rankedCandidates`.
- `tournament/verdict.json`: written by `team/referee` on `audit` (`ACCEPT`/`REJECT`) or by `finalizeTournamentPartial` on cancellation/budget halt (`PARTIAL`).
- `TOURNAMENT_REPORT.md` (+ `interrupted.md` + `state.json` `phase: "PRESENT_PARTIAL"` + `tournament_cancelled` event on `AbortSignal`, explicit `cancel`, or `shouldHalt` / budget exhaustion).
- `teamwork_final_verify` stamps `evidence.tournament` into `verify/final.json` and refuses `PASS` unless `manifest.phase === "COMPLETED"` with a `team/referee` `ACCEPT` verdict.

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
| Tasks | one row per task: status, worker, verifier, rounds, duration, cost, checks. Details: summary, feedback, fatal findings, branch, worktree |
| Acceptance checklist | (Markdown) one box per task, ticked when `verified_pass`, plus the security gate |
| Security audit | `verify/security-audit.json`: pre-merge status, severity counts, findings |
| Final verification | `verify/final.json`, when present |
| Pitfalls | `pitfalls.md` entries |
| Other cost buckets | cost buckets that are not task ids (HTML only, when present) |
| Warnings | files that were oversize, unreadable, or malformed and were skipped |

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

