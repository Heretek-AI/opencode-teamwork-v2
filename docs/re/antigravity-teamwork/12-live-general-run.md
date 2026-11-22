# Live General Run — One Completed Single-Cycle `/teamwork` Dispatch

**Status: OBSERVED — one completed General-route run, timed out only after the gate passed.** Recorded on **2026-11-22** against the installed Antigravity CLI **1.5.14**, the same binary analysed throughout this corpus (`00-artifact-identity.md`). This document is the first runtime record in the set of a `/teamwork` invocation that **routed, decomposed, implemented, verified and gated a task end to end**. It is deliberately narrow: **one** run, one route, one milestone. It does not establish a default, a fixed gate, or a route-selection rule.

The run is the reference sample for four things the corpus previously held only statically or from prior state trees:

1. the `## Parameters` block emitted for a bracket-led request (`[skip-interview]`);
2. the **General** route decision, quoted from the run's own sentinel briefing;
3. a **four-row gate** for a single-cycle General run, as against the six-row gate in the earlier multi-milestone sample;
4. a live **`<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/`** shared state root, not the `brain/<conversation-id>/scratch/` fallback recorded in `11-runtime-artifacts.md` §2.1.

It is also the first record of the monitoring crons **firing**, and the first heading-by-heading confirmation of the five-part handoff protocol on disk. The victory audit did **not** return a verdict: the process hit its 30-minute print timeout seconds after the auditor was spawned. A completed `VICTORY CONFIRMED` from the earlier multi-milestone run is cited in §9.

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md): **OBSERVED** means read in a cited transcript, log or state file; **INFERRED** means reasoned from stated observed premises; **UNKNOWN** means not measured. Paths are written relative to two roots defined once, so the document carries no unrelated personal path:

| Placeholder | Resolves to |
|---|---|
| `<capture>` | `/tmp/opencode/agy-teamwork-live-20261122-171703/capture/` — the run's own JSONL streams and CLI log |
| `<state>` | `<appDataDir>/scratch/teamwork/d9f5d6b1-be80-4411-830b-4fa5df298ff0/.agents/teamwork/` — the shared teamwork state root for this run |
| `<workspace>` | the run's working directory (a two-file Node.js fixture) |

The redacted evidence bundle is in [`live/2026-11-22-general/`](live/2026-11-22-general/); every quoted state document is reproduced there with absolute home and workspace paths normalised.

---

## 1. Run identity

| Field | Value | Label |
|---|---|---|
| Top-level conversation | `9d81af51-373c-4f2e-b6b8-11f53d18f6f6` | OBSERVED — `<capture>/stream.clean.jsonl` `init` and final `result` events |
| Teamwork coordinator / sentinel conversation | `d9f5d6b1-be80-4411-830b-4fa5df298ff0` | OBSERVED — `<state>/sentinel/BRIEFING.md`, `<state>/orchestrator/DISPATCH.md` |
| Project orchestrator conversation | `e62b1c3e-a5d2-42e2-bbbb-d93eceecdbe5` | OBSERVED — `<state>/orchestrator/BRIEFING.md`; `<capture>/orchestrator-transcript.jsonl` |
| Victory auditor conversation | `3c0737cb-489c-462e-aa02-2604ef773348` | OBSERVED — `<capture>/coordinator-transcript.jsonl` step 71; `<state>/sentinel/BRIEFING.md` |
| Top-level model | `gemini-3.8-flash-low` | OBSERVED — `<capture>/stream.clean.jsonl` `init.event.init.model`; every main-turn `model` field |
| Teamwork conversation model | `gemini-4-hydrogen-tiered-high` | OBSERVED — every coordinator and orchestrator `PLANNER_RESPONSE.model`; see §1.1 |
| Exit code | `3` | OBSERVED — `<capture>/exit.txt` (`EXIT=3`) |
| Terminal reason | `print_timeout` at 30m0s, turn still in progress | OBSERVED — `<capture>/stream.clean.jsonl` final `result.result` (`finished_reason`, `error`); `<capture>/agy.log` |
| Main-conversation usage | 40,349 input / 580 output / 27,371 cache-read tokens | OBSERVED — `<capture>/stream.clean.jsonl` final `result.result.usage`; same totals summed over `<capture>/main-transcript.jsonl` |
| Run duration (reported) | 1,713.85 s ≈ 28m34s of a 30m envelope | OBSERVED — `result.duration_seconds`; the timeout clock starts before the request is sent |

### 1.1 The model is not one model

The task was launched on **Gemini 3.8 Flash (Low)** — the top-level conversation's `init` object and all six main-turn responses record `gemini-3.8-flash-low` — but the coordinator and orchestrator turns record **`gemini-4-hydrogen-tiered-high`**:

| Conversation | Recorded models | Turns | Label |
|---|---|---:|---|
| `9d81af51…` (top level) | `gemini-3.8-flash-low` | 6 | OBSERVED |
| `d9f5d6b1…` (coordinator / sentinel) | `gemini-4-hydrogen-tiered-high` | 20 | OBSERVED |
| `e62b1c3e…` (orchestrator) | `gemini-4-hydrogen-tiered-high` | 21 | OBSERVED |

**Inference, not a claim about policy:** the teamwork subagents were resolved to a different model tier than the caller. Whether this is a fixed subagent tier, a *tiered* model alias resolving differently inside a child conversation, or a per-dispatch choice is `UNKNOWN`. The observed fact is only that the launched model and the team's model are not the same string. This matches the corpus' earlier finding that dispatch-time model selection exists (`07` §3.5, `11` §1.4), but the selector here is not the observed flash override.

The 40,349 / 580 / 27,371 figures in the run summary are the **top-level conversation's** usage. The child conversations are separately metered and are much larger:

| Conversation | Input | Output | Cache read | Label |
|---|---:|---:|---:|---|
| `9d81af51…` main | 40,349 | 580 | 27,371 | OBSERVED — final `result.usage` |
| `d9f5d6b1…` coordinator | 78,223 | 11,913 | 565,791 | OBSERVED — summed `PLANNER_RESPONSE` fields |
| `e62b1c3e…` orchestrator | 105,242 | 26,068 | 907,779 | OBSERVED — summed `PLANNER_RESPONSE` fields |

Do not read the top-level total as the cost of the run. It excludes the team. [OBSERVED arithmetic; the billing model is `UNKNOWN`]

---

## 2. Command shape and the `## Parameters` block

### 2.1 Command shape

The command is **not** written to the capture as an argv array. Its components are each observed separately; the assembled line below is **INFERRED** from those components and is marked so.

```sh
agy -p='/teamwork [skip-interview] Make the failing test in hello.test.mjs pass without editing the test file. Run node --test and stop when it passes.' \
    --dangerously-skip-permissions \
    --print-timeout 30m \
    --output-format stream-json \
    > <capture>/stream.jsonl 2> <capture>/agy.log
```

| Component | Evidence | Label |
|---|---|---|
| Prompt text, exactly 143 characters including `/teamwork` | `<capture>/agy.log` `Print mode: starting (promptLength=143, model="gemini-3.8-flash-low", conversationID="")`; the text in `main-transcript.jsonl` step 0 is 143 chars | OBSERVED |
| Slash command expanded as `teamwork` | `<capture>/agy.log` `Print mode: expanded slash command "teamwork" (system)` | OBSERVED |
| `--dangerously-skip-permissions` | `<capture>/agy.log` `Print mode: --dangerously-skip-permissions set, auto-approving all tool permissions` | OBSERVED |
| 30-minute print timeout | `<capture>/agy.log` `Print mode: print timeout after 30m0s with turn in progress after 71204 polls (printed=12)` | OBSERVED |
| `--output-format stream-json` and the two redirections | `<capture>/stream.jsonl` is line-delimited `{"event":…}` JSON; `<capture>/agy.log` is the stderr log. No argv record exists, so the flag spelling is inferred from the stream schema | INFERRED |
| `--mode auto` absent / unavailable | `<capture>/stream.jsonl` line 1: `warning: --mode auto is not available for this account; continuing in the default mode.` The warning is emitted even though no `--mode` flag is visible in the capture; the invocation may have carried it | OBSERVED warning; flag presence `UNKNOWN` |

### 2.2 The `## Parameters` block

The bracket token was preserved verbatim in its own section, with the exact explanatory line the recovered prompt specifies. This is the first runtime instance in the corpus. From `<state>/ORIGINAL_REQUEST.md` (whole file is 267 bytes; all eight lines quoted):

```markdown
# Original User Request

## Parameters
[skip-interview]
How this run was launched; not part of the task.

## Initial Request — 2026-11-22T22:20:05Z
Make the failing test in hello.test.mjs pass without editing the test file. Run node --test and stop when it passes.
```

| Finding | Evidence | Label |
|---|---|---|
| A `## Parameters` section exists, before `## Initial Request` | `<state>/ORIGINAL_REQUEST.md:1-8` | OBSERVED |
| The bracket is preserved **on its own line**, not inline with the task | `<state>/ORIGINAL_REQUEST.md:4` | OBSERVED |
| The sentence is exactly `How this run was launched; not part of the task.` | `<state>/ORIGINAL_REQUEST.md:5` | OBSERVED |
| The task text is recorded separately and verbatim | `<state>/ORIGINAL_REQUEST.md:7-8` | OBSERVED |
| No interviewer ran; no `interviewer/` folder exists | `find <state> -maxdepth 1 -type d`; §6 | OBSERVED |
| `[skip-interview]` is what suppressed the interview | Not directly evidenced: the token is in the prompt and no interview occurred. The sentinel also routed immediately. Causality is `INFERRED`, not logged | INFERRED |

The local plugin still has no equivalent recording convention (gap-analysis A5). The reference side of A5 is now **OBSERVED at runtime**, not only in prompt text.

---

## 3. Route decision

The sentinel chose **General**. The decision is recorded in two places with the same wording: the sentinel briefing and the coordinator's first briefing write.

> **Path:** General (`teamwork_orchestrator`)
>
> **Rationale:** Standard SWE bug-fix task without explicit lightness signal for SWE Light.

[OBSERVED — `<state>/sentinel/BRIEFING.md` §Routing Decision; repeated in `<capture>/coordinator-transcript.jsonl` step 9's `write_file` content]

What the run then did is consistent with that label: the sentinel dispatched a `teamwork_orchestrator` conversation (`e62b1c3e…`), not a SWE Light implementer. `<state>/orchestrator/DISPATCH.md` records the dispatch as *"Identity: Project Orchestrator (`orchestrator`)"* from the sentinel conversation `d9f5d6b1…`.

| Finding | Evidence | Label |
|---|---|---|
| The router emitted a named path and a rationale | `sentinel/BRIEFING.md` §Routing Decision | OBSERVED |
| The chosen path is General | same | OBSERVED |
| The rationale names the **absence** of a lightness signal, not the presence of a bug-fix signal | same: "without explicit lightness signal for SWE Light" | OBSERVED |
| General means `teamwork_orchestrator` in this run | `orchestrator/DISPATCH.md`; `orchestrator/BRIEFING.md` | OBSERVED |
| The route was *not* re-evaluated mid-run | One dispatch to one orchestrator; no second route record in any briefing | OBSERVED (absence) |
| The router would choose General again for a similar request | Not established by one run | UNKNOWN |

This is the runtime counterpart of `01-command-contract.md`'s decision table and `04-pipeline-topologies.md` §2.1. It does **not** validate the table's other routes; only the General branch is exercised.

---

## 4. Timeline

All timestamps are UTC, taken from the JSONL `created_at` fields and file mtimes where noted. The 30-minute envelope began at **22:17:18Z**, before the request was sent; the first request turn is at 22:20:05Z.

| Time (UTC) | Event | Evidence | Label |
|---|---|---|---|
| 22:17:18 | Print-mode process starts; 30m timeout clock begins | `<capture>/agy.log`; `result.duration_seconds` 1713.85 | OBSERVED |
| 22:20:02 | Top-level model calls `invoke_subagent` with `TypeName: "teamwork"`, `Role: "Teamwork Coordinator"` | `main-transcript.jsonl` step 1 | OBSERVED |
| 22:20:05 | Coordinator conversation `d9f5d6b1…` created; sentinel writes `ORIGINAL_REQUEST.md` and its `BRIEFING.md` | `<capture>/main-transcript.jsonl` step 2; `<state>/ORIGINAL_REQUEST.md` | OBSERVED |
| 22:21:44 | Sentinel schedules `*/8` progress cron (`task-9`) and `*/20` liveness cron (`task-10`); dispatches the orchestrator | `coordinator-transcript.jsonl` steps 7, 9–10; `orchestrator/DISPATCH.md` | OBSERVED |
| 22:23:00 | Orchestrator `e62b1c3e…` writes `DISPATCH.md`, `BRIEFING.md`, `progress.md` | `orchestrator-transcript.jsonl` step 6 | OBSERVED |
| 22:23:21 | Orchestrator dispatches **two survey explorers** (`teamwork_explorer_survey_1`, `_2`) and schedules its `*/20` heartbeat (`task-13`) | `orchestrator-transcript.jsonl` step 10 | OBSERVED |
| 22:23:30–32 | Both explorer conversations created (`3e1a2454…`, `5726cfa4…`) | `orchestrator-transcript.jsonl` steps 11–12 | OBSERVED |
| 22:26:11 | Explorer 1 handoff written | `<state>/teamwork_explorer_survey_1/handoff.md` mtime | OBSERVED |
| 22:27:38 | Explorer 2 handoff written | `<state>/teamwork_explorer_survey_2/handoff.md` mtime | OBSERVED |
| 22:28:46 | Orchestrator reads both handoffs and writes `PROJECT.md` with one milestone, M1 | `orchestrator-transcript.jsonl` steps 20, 27 | OBSERVED |
| 22:28:56–29:02 | **Worker** `teamwork_worker_m1` dispatched (`45cfd598…`) | `orchestrator-transcript.jsonl` steps 30–31 | OBSERVED |
| 22:31:57 | Worker handoff written: `hello.mjs` changed, `node --test` 1/1, exit 0 | `<state>/teamwork_worker_m1/handoff.md` | OBSERVED |
| 22:34:04–11 | **Parallel verification wave** spawned: reviewer (`a38d1e28…`), challenger (`0fba878f…`), auditor (`f5a073fe…`) | `orchestrator-transcript.jsonl` steps 43–45 | OBSERVED |
| 22:37:09 | Reviewer handoff: `APPROVE`, risk `LOW` | `<state>/teamwork_reviewer_m1/handoff.md` | OBSERVED |
| 22:38:27 | Auditor handoff: `CLEAN` | `<state>/teamwork_auditor_m1/handoff.md` | OBSERVED |
| 22:39:16 | First `GATE_STATUS.md` write: reviewer + auditor rows, challenger still pending | `orchestrator-transcript.jsonl` step 56; gate file mtime later rewritten | OBSERVED |
| 22:42:40 | Challenger handoff: `PASS (CONFIRMED)`, risk `LOW` | `<state>/teamwork_challenger_m1/handoff.md` | OBSERVED |
| 22:44:28 | Final `GATE_STATUS.md`: four rows, `Gate Result: **PASS**`; M1 marked `DONE`; heartbeat cron `task-13` killed | `orchestrator-transcript.jsonl` steps 63–68; `<state>/orchestrator/GATE_STATUS.md` | OBSERVED |
| 22:44:52 | Orchestrator writes its final `handoff.md` and sends the completion report to the sentinel | `orchestrator-transcript.jsonl` step 74; `orchestrator/handoff.md` | OBSERVED |
| 22:47:04 | Sentinel receives the report, sets phase `auditing`, and calls `invoke_subagent` for the **victory auditor**; the auditor conversation `3c0737cb…` is created at 22:47:11 | `coordinator-transcript.jsonl` steps 63–67 | OBSERVED |
| 22:47:18 | 30m print timeout; process stops; the auditor's state folder is empty | `<capture>/agy.log`; `<capture>/stream.clean.jsonl` final `result`; `<state>/teamwork_victory_auditor_1/` (0 files) | OBSERVED |

**Reading the timeline.** The implementation cycle is 22:23–22:44, about 21 minutes. The 30-minute envelope was consumed by the three-minute pre-dispatch lead, the cycle itself, and the sentinel's status/cron handling; the victory audit began **7 seconds** before the cut. [OBSERVED timestamps; the apportionment is `INFERRED`] This is not a failed gate — it is a completed gate whose mandatory post-victory audit was cut off by the harness.

---

## 5. Gate

### 5.1 The table, verbatim

From `<state>/orchestrator/GATE_STATUS.md` (1,000 bytes). The table is verbatim except the four `Source` prefixes, which are normalised from the absolute shared root to `<state>/` so the document does not reproduce a home path; the original prefix is `<appDataDir>/scratch/teamwork/d9f5d6b1-be80-4411-830b-4fa5df298ff0/.agents/teamwork/`.

```markdown
## Gate — Iteration 1
| Agent | Role | Verdict | Source |
|-------|------|---------|--------|
| teamwork_worker_m1 | teamwork_worker | DONE (`node --test` passed 1/1) | <state>/teamwork_worker_m1/handoff.md |
| teamwork_reviewer_m1 | teamwork_reviewer | APPROVE (`node --test` passed 1/1) | <state>/teamwork_reviewer_m1/handoff.md |
| teamwork_challenger_m1 | teamwork_challenger | PASS (`node --test` passed 1/1; adversarial ESM probes passed) | <state>/teamwork_challenger_m1/handoff.md |
| teamwork_auditor_m1 | teamwork_auditor | CLEAN | <state>/teamwork_auditor_m1/handoff.md |

Gate Result: **PASS**
```

| Structural fact | Value | Label |
|---|---|---|
| Rows | **4** | OBSERVED |
| Composition | 1 worker + 1 reviewer + 1 challenger + 1 forensic auditor | OBSERVED |
| Final rule | `Gate Result: **PASS**` — prose AND over the four verdicts | OBSERVED |
| Each `Source` resolves to that agent's own `handoff.md` | yes, four different agent folders | OBSERVED |
| The gate file's title | `## Gate — Iteration 1`, with no `# Milestone …` heading | OBSERVED |
| Gate author | the **project orchestrator** `e62b1c3e…`, at `<state>/orchestrator/GATE_STATUS.md` | OBSERVED — written by orchestrator turn 56/67 |

### 5.2 Compare with the earlier multi-milestone sample

The prior completed run cited in `11` §5 (`5d42725e-45a3-490f-b291-e7137aedde94`) carries a **six-row** gate for a three-milestone project:

| Row | Role | Verdict (that run) |
|---|---|---|
| `worker_1` | `teamwork_worker` | `DONE (build passed)` |
| `reviewer_1` | `teamwork_reviewer` | `APPROVE` |
| `reviewer_2` | `teamwork_reviewer` | `APPROVE` |
| `challenger_1` | `teamwork_challenger` | `APPROVE` |
| `challenger_2` | `teamwork_challenger` | `APPROVE` |
| `auditor_1` | `teamwork_auditor` | `CLEAN` |

[OBSERVED — that run's `orchestrator/GATE_STATUS.md`]

| Dimension | This run (General, single cycle) | Prior run (multi-milestone) |
|---|---|---|
| Milestones | 1 (`M1`) | 3 (`M1`–`M3`) |
| Worker | 1 | 1 |
| Reviewers | **1** | **2** |
| Challengers | **1** | **2** |
| Auditors | 1 | 1 |
| Gate rows | **4** | **6** |
| Gate file | `orchestrator/GATE_STATUS.md` | `orchestrator/GATE_STATUS.md` |
| Iterations | 1 | 1 |

**The gate composition is not fixed.** Across these two samples it scales with scope/iteration: a single-cycle General run used the minimum independent set — **1 reviewer + 1 challenger + 1 auditor** — while the larger multi-milestone run doubled the reviewers and challengers. This is the correct statement to carry forward. It is **not** a rule, a default, or a universal template: two samples cannot establish how a LEMMA, Document Review, SWE Light or tournament gate composes, and the earlier 39-root sample showed gate files under `sub_orch_m<N>/` for milestone gates, which this run did not create. [OBSERVED composition; `INFERRED` that redundancy scales with scope; universality `UNKNOWN`]

What is stable across both samples is the **rule shape**, not the row count:

- the worker's `DONE` is one row among verdicts, not the gate;
- reviewer, challenger and auditor are independent conversations;
- every verdict cites a `handoff.md` produced by that agent;
- the gate is an explicit AND closed by a `Gate Result:` line.

---

## 6. Artifact layout

### 6.1 The shared root

This run used the **primary** state-root form:

```text
<appDataDir>/scratch/teamwork/d9f5d6b1-be80-4411-830b-4fa5df298ff0/.agents/teamwork/
```

not the `brain/<conversation-id>/scratch/.agents/teamwork/` fallback used by the 39-root sample in `11` §2.1. The root is shared by every agent; per-agent state is a **subfolder**, not a per-conversation tree. `<state>/orchestrator/BRIEFING.md` names it explicitly as `Teamwork state root`; every `DISPATCH.md` repeats the path.

| Fact | Value | Label |
|---|---|---|
| Shared root | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` | OBSERVED — every state file and dispatch |
| Run id | the coordinator conversation id, `d9f5d6b1…` | OBSERVED |
| Files under the root | **31** | OBSERVED — `find <state> -type f \| wc -l` |
| Total size | **160 KB** (`du -sh`) | OBSERVED |
| Per-agent folders | 9: `sentinel/`, `orchestrator/`, 2 explorers, worker, reviewer, challenger, auditor, and an empty `teamwork_victory_auditor_1/` | OBSERVED |
| Shared documents | `ORIGINAL_REQUEST.md`, `PROJECT.md` | OBSERVED |
| `TEST_INFRA.md` | **absent** | OBSERVED |
| `TEST_READY.md` | **absent** | OBSERVED |
| `interviewer/` | **absent** (`[skip-interview]`) | OBSERVED |
| `SCOPE.md` / `sub_orch_*` | **absent** (single cycle, no sub-orchestrator) | OBSERVED |
| Workspace teamwork state | **none** — state stayed out of `<workspace>` | OBSERVED — all artifacts under `<state>` |

The absence of `TEST_INFRA.md`/`TEST_READY.md` is consistent with `11` §3's "observed vocabulary, not a closed schema": this small run had no test-infrastructure phase to record. The absence of `interviewer/` is the runtime consequence of the `[skip-interview]` parameter, not a missing feature.

### 6.2 Folder-by-folder contents

| Folder | Files | Size | Label |
|---|---:|---:|---|
| `sentinel/` | 1 (`BRIEFING.md`) | 2,267 B | OBSERVED |
| `orchestrator/` | 5 (`BRIEFING`, `DISPATCH`, `GATE_STATUS`, `handoff`, `progress`) | 13,049 B | OBSERVED |
| `teamwork_explorer_survey_1/` | 3 (`BRIEFING`, `DISPATCH`, `handoff`; no `progress.md`) | 9,889 B | OBSERVED |
| `teamwork_explorer_survey_2/` | 4 | 12,339 B | OBSERVED |
| `teamwork_worker_m1/` | 4 | 10,985 B | OBSERVED |
| `teamwork_reviewer_m1/` | 4 | 14,962 B | OBSERVED |
| `teamwork_challenger_m1/` | 4 | 13,517 B | OBSERVED |
| `teamwork_auditor_m1/` | 4 | 14,326 B | OBSERVED |
| `teamwork_victory_auditor_1/` | **0** | 0 B | OBSERVED |
| root | 2 (`ORIGINAL_REQUEST.md` 267 B, `PROJECT.md` 1,526 B) | 1,793 B | OBSERVED |

The explorer 1 folder is the only **dispatched-subagent** folder without a `progress.md` (the sentinel folder also contains only its briefing), which is the same one-fewer-`progress.md`-than-`BRIEFING.md` skew noted in `11` §2.2. The empty victory-auditor folder is the timeout's residue: the folder was created at 22:47:11, the process died at 22:47:18.

`PROJECT.md` (1,526 B) has the standard project shape: `## Architecture`, `## Code Layout`, `## Feature Inventory`, `## Milestones`, `## Interface Contracts`. It names M1 `DONE` after the gate. It is much smaller than the 7.0–9.6 KB `PROJECT.md` samples in `11` §3 because the project has two files and one milestone. [OBSERVED]

---

## 7. The handoff protocol

All four gate agents and both explorers used the five named parts. The worker's handoff is the cleanest instance:

| # | Heading (verbatim) | Present in |
|---|---|---|
| 1 | `## 1. Observation` | worker, reviewer, challenger, auditor, both explorers |
| 2 | `## 2. Logic Chain` | same |
| 3 | `## 3. Caveats` | same |
| 4 | `## 4. Conclusion` | same |
| 5 | `## 5. Verification Method` | same |

[OBSERVED — `<state>/teamwork_worker_m1/handoff.md:9,60,69,75,81`; reviewer `:10,84,98,121,144,150,156`; etc.]

The reviewer adds two role-specific sections **between** Logic Chain and Caveats, and keeps the five-part sequence around them:

```text
## 1. Observation
## 2. Logic Chain
## 3. Quality Review Report
## 4. Adversarial Challenge Report
## 5. Caveats
## 6. Conclusion
## 7. Verification Method
```

[OBSERVED — `<state>/teamwork_reviewer_m1/handoff.md` headings]

The auditor is the other variant: a `## Forensic Audit Report` with `### Phase Results` precedes the numbered five parts, and the numbering still ends at `## 5. Verification Method`. The challenger uses the five parts with a `### Stress Test Summary` inside Observation. **The five names are the invariant; the extra sections are role-specific and may renumber the later parts.** [OBSERVED]

Content-level confirmation:

- The worker's Observation carries before/after file text and verbatim command output, not a summary.
- The Logic Chain is numbered and cites `ORIGINAL_REQUEST.md:8` and `PROJECT.md` interface lines.
- Caveats are explicit about what was *not* tested (no linter, no `package.json`; CommonJS interop untested in the challenger).
- The Verification Method gives commands **and invalidation conditions** — a re-runnable recipe, not "trust me".
- The auditor's report includes SHA-256 values, `git rev-parse HEAD`, Node version, and a pre-populated-artifact `find`.

This is the strongest runtime confirmation of A7 in the gap analysis. It also shows why the gate can be built from handoffs alone: each verdict's evidence is in the file the gate cites.

---

## 8. Crons, liveness and succession

### 8.1 Three schedules

| Owner | Schedule | Task id | Prompt purpose | Fired? |
|---|---|---|---|---|
| Sentinel (`d9f5d6b1…`) | `*/8 * * * *` | `d9f5d6b1…/task-9` | read orchestrator `progress.md`/`BRIEFING.md` and subagent progress; report changes | **yes** |
| Sentinel | `*/20 * * * *` | `d9f5d6b1…/task-10` | liveness; skip while a blocking subagent is running | **yes** |
| Orchestrator (`e62b1c3e…`) | `*/20 * * * *` | `e62b1c3e…/task-13` | inspect open subagents, update `progress.md` only on state change | **yes**, once, then cancelled |

[OBSERVED — `coordinator-transcript.jsonl` steps 7, 9–10; `orchestrator-transcript.jsonl` step 10]

### 8.2 Firing evidence

The cron prompts arrive as `SYSTEM_MESSAGE`s from the task id, with timestamps. This is the first time in the corpus that firing is directly observed rather than inferred from a briefing field.

| Cron | Delivered at | Iteration | Evidence |
|---|---|---|---|
| `task-9` progress | 22:24:58 | 1 | `coordinator-transcript.jsonl` step 15 |
| `task-9` progress | 22:32:58 | — | step 32 |
| `task-9` progress | 22:40:58 | — | step 46 |
| `task-10` liveness | 22:30:00 | 1 | step 16 |
| `task-10` liveness | 22:47:04 | 2 | step 64 |
| `task-13` heartbeat | 22:28:42 | 1 | `orchestrator-transcript.jsonl` step 19 |

The `*/8` schedule delivers at 22:24:58, 22:32:58 and 22:40:58 — exactly 8 minutes apart. The `*/20` liveness delivers at 22:30:00 and 22:47:04, a 17m04s interval. The capture does not record the scheduler's tick clock or any re-arm, so the interval is reported as observed and not normalised into a rule. [OBSERVED timestamps; the scheduler's cadence accounting is `UNKNOWN`] The orchestrator heartbeat fired once at 22:28:42, five minutes after creation, and was cancelled at 22:44:33 as part of gate cleanup.

### 8.3 What the briefings track

`sentinel/BRIEFING.md` carries both states as separate fields:

```text
- Last report state: 2026-11-22T22:42:22Z (Iteration 1 verification wave completed: Reviewer APPROVE, Auditor CLEAN, Challenger PASSED; 0 unchanged ticks)
- Last liveness state: active at 2026-11-22T22:29:10Z (0 unchanged checks, no status request pending)
```

[OBSERVED — `<state>/sentinel/BRIEFING.md`]

The report state advanced with the run (22:29:00 → 22:34:00 → 22:42:22), and the liveness state remained `active` with `0 unchanged checks`. The `0 unchanged ticks` counters are the sentinel's own bookkeeping, not a scheduler metric. The orchestrator briefing separately records `Heartbeat cron: cancelled (e62b1c3e…/task-13)` after the gate.

### 8.4 Succession

The orchestrator's briefing states the rule and the counter:

```text
- **Succession**: Self-succeed at 32 spawns; write handoff.md, kill timers, spawn successor.
...
- Succession required: no
- Spawn count: 6 / 32
```

[OBSERVED — `<state>/orchestrator/BRIEFING.md` §My Workflow and §Succession Status]

The run spawned six agents under the orchestrator (2 explorers, 1 worker, 1 reviewer, 1 challenger, 1 auditor) and never approached the threshold. The victory auditor was spawned later by the **sentinel**, not the orchestrator, and does not appear in the orchestrator's 6/32 count. Succession was **not triggered**, so this run provides no runtime evidence of the successor artifact or of the `_gen<N>` folder. [OBSERVED counter; successor behaviour `UNKNOWN`]

---

## 9. The unfinished victory audit

The gate passed at 22:44:28. The sentinel received the completion report at 22:47:04, set phase `auditing`, created `teamwork_victory_auditor_1/`, and called `invoke_subagent`; the auditor conversation `3c0737cb-489c-462e-aa02-2604ef773348` was created at 22:47:11. Seven seconds later the 30-minute print timeout stopped the process. The auditor's folder contains **zero files**; the sentinel briefing still records:

```text
## Victory Audit Status
- **Auditor**: 3c0737cb-489c-462e-aa02-2604ef773348
- **Triggered**: yes
- **Verdict**: pending
- **Retry count**: 0
```

[OBSERVED — `<state>/sentinel/BRIEFING.md`; `<state>/teamwork_victory_auditor_1/` is empty]

**What this run establishes:** the mandatory post-victory audit is dispatched after the gate, and it is the sentinel (not the orchestrator) that owns it. **What it does not establish:** whether this task would have received `VICTORY CONFIRMED`, and how long a victory audit takes on a two-file project.

For a completed verdict, the corpus already has one in the earlier multi-milestone run:

- that run's `sentinel/BRIEFING.md` records `- **Verdict**: VICTORY CONFIRMED`;
- its second victory auditor's `handoff.md` closes with `Final Verdict: **VICTORY CONFIRMED**.` at line 90, after a three-phase audit (timeline, integrity, independent test execution).

[OBSERVED — `5d42725e-45a3-490f-b291-e7137aedde94/.agents/teamwork/sentinel/BRIEFING.md:34`; `.../teamwork_victory_auditor_2/handoff.md:90`]

The contrast is useful: the six-row/multi-milestone run completed its victory audit and confirmed; this four-row/single-cycle run passed its gate but was cut before the audit returned. **A gate PASS and a victory verdict are separate events.** [OBSERVED]

---

## 10. What this run changes in the corpus

| Claim in the corpus | Before this run | After this run | Where updated |
|---|---|---|---|
| `## Parameters` block | Prompt text only; neither sampled run had one | **Observed** with `[skip-interview]` and the exact sentence | `11` §3 row 1 (A5); `08` A5 |
| Gate composition | Six rows in three samples; fixedness `UNKNOWN` | General single-cycle = **4 rows**; multi-milestone = **6 rows**; composition variable | `11` §5.1, §8; `08` A9/A11 |
| Gate author/location | Sub-orchestrator folder in the 39-root sample | **Project orchestrator**, `orchestrator/GATE_STATUS.md`, for a single cycle | `11` §5.2 |
| State root | `brain/<conv>/scratch/` fallback only | **`<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/`** observed | `11` §2.1, §4 |
| Five-part handoff | Inferred from sizes/headings | **Confirmed** heading by heading, including reviewer extras | `11` §3 row 8; `08` A7 |
| Crons firing | Never observed | **Observed** at `*/8` and `*/20`, with delivery timestamps | `11` §8; `08` A8, §4.1 |
| Succession | Threshold literal only | Rule and 6/32 counter observed; **not triggered** | `08` A20 (ADR 0003); this doc §8.4 |
| Victory audit | One prior confirmed verdict | Gate PASS then **timeout before verdict**; prior run supplies the confirmed case | this doc §9 |

### 10.1 Structured for the next run

This document is the **first** entry in a two-run live series. The follow-up SWE Light run is reserved as **§11 — Live SWE Light run**, keeping §1–§10 as the General baseline and adding a side-by-side comparison table in §11.5. Do not merge the two runs into one set of counts: the point of the series is the **difference** in route, gate composition and artifact set.

---

## 11. Live SWE Light run (pending)

Reserved. When the SWE Light run completes, append one subsection per axis and keep the General baseline above unchanged:

| Subsection | What to record |
|---|---|
| §11.1 | Identity: conversation, coordinator, orchestrator, victory auditor, model(s), exit code/reason, usage |
| §11.2 | Command shape and `## Parameters` block |
| §11.3 | Route decision quote — the SWE Light rationale, not the General one |
| §11.4 | Timeline: survey → milestone(s) → worker → reviewer rounds → gate → victory audit |
| §11.5 | Gate table verbatim, plus a side-by-side row-count comparison with §5 (General 4 rows; multi-milestone 6 rows; SWE Light **?**) |
| §11.6 | Artifact layout and file count, including whether `TEST_INFRA.md` / `TEST_READY.md` appear |
| §11.7 | Handoff structure and any SWE-specific sections |
| §11.8 | Crons, succession counter, terminal state, victory verdict |
| §11.9 | What the second run changes in §10's table |

Do not rewrite §1–§10 to fit the second run. If the two runs disagree, record the disagreement; two samples do not establish a default.

---

## 12. Limits

- One General run. It does not show what SWE Light, Document Review, LEMMA, Math/Proof or a multi-milestone General run would write.
- The top-level model and the teamwork models differ (§1.1); which tier the route or the harness selected is `UNKNOWN`.
- The command's argv is reconstructed, not recorded (§2.1). The prompt length and each flag are observed; the exact flag order and quoting are `INFERRED`.
- The `[skip-interview]` → no-interview causality is `INFERRED` from absence; there is no log line naming the token as the cause.
- The gate's four-row composition is one sample. The explicit claim is only that it is **not fixed** and that it scaled between two observed runs.
- The victory audit did not complete. `VICTORY CONFIRMED` comes from the prior run, not this one.
- The 31-file/160-KB count is this run's state tree at capture time; the empty victory-auditor folder contributes no files.
- No transcript content beyond the quoted decision, gate, briefing fields and handoff headings is reproduced. The bundle in `live/2026-11-22-general/` contains only the ten named state documents, with absolute home/workspace paths normalised.

---

## 13. Re-derive

```sh
# identity and terminal reason
head -2 <capture>/stream.clean.jsonl
tail -1 <capture>/stream.clean.jsonl
cat <capture>/exit.txt

# state tree
find <state> -type f | wc -l
du -sh <state>
find <state> -maxdepth 1 -type d

# gate
cat <state>/orchestrator/GATE_STATUS.md

# parameters block
cat <state>/ORIGINAL_REQUEST.md

# cron firings (addresses are task ids)
grep -o 'timestamp=[^ ]* sender=d9f5d6b1[^ ]*/task-[0-9]*' <capture>/coordinator-transcript.jsonl
```

The redacted copies of the ten cited documents in [`live/2026-11-22-general/`](live/2026-11-22-general/) are the stable citation targets; the live state root above is the machine-local source and may be pruned by the CLI.
