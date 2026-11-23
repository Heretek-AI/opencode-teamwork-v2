# Live SWE Light Runs — Interrupted (Run 1) and Completed (Run 2)

**Status: OBSERVED — two SWE Light runs on the same binary. Run 1 (2026-11-22) selected the route, implemented the fix and entered its reviewer loop, then stopped when the server restarted; it produced no gate file and no verdict. Run 2 (2026-11-23) completed the same loop, passed a three-phase independent victory audit, and returned `VICTORY CONFIRMED`.** Recorded against the installed Antigravity CLI **1.5.14**, the same binary analysed throughout this corpus (`00-artifact-identity.md`). The companion General run is [`12-live-general-run.md`](12-live-general-run.md).

| Run | Capture / request window | Terminal state | Section |
|---|---|---|---|
| **Run 1** | 2026-11-22, 23:03:50Z–23:18:38Z | server restart mid-loop; no verdict | §1–§11 |
| **Run 2** | 2026-11-23, 02:07:34Z–02:34:13Z | exit 0; `VICTORY CONFIRMED` | §12 |

Sections 1–11 describe **Run 1 only**. Section 12 is the completed successor. Do not merge their artifact counts or infer Run 2's verdict into Run 1.

Run 1 is the first runtime observation of the **SWE Light** route, and both runs show a **different gate mechanism** from the General run:

| | General (`12`) | SWE Light (Runs 1 and 2) |
|---|---|---|
| Orchestrator archetype | project orchestrator (`teamwork_orchestrator`) | `teamwork_swe` |
| Decomposition | 1 milestone, 2 survey explorers, 1 worker | **none** — the whole task is passed verbatim to each worker |
| Gate | 4-row `GATE_STATUS.md` (worker + reviewer + challenger + auditor) | **no `GATE_STATUS.md`**; the sequential `teamwork_implementer` → `teamwork_reviewer` loop is the gate |
| Redundant verification | 1 reviewer + 1 challenger + 1 auditor | repeated reviewer rounds with a cumulative open-issues ledger |
| Terminal state | gate PASS; victory audit cut by print timeout | Run 1: server restart, no verdict; Run 2: `VICTORY CONFIRMED` |

The last row is the important one: **do not read "no `GATE_STATUS.md`" as "no gate."** The SWE Light workflow defines the loop itself as the gate, and the victory auditor as mandatory after it. Run 1 did not reach a closed loop or the auditor; Run 2 reached both (§12).

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md). Paths are written relative to placeholders:

| Placeholder | Resolves to |
|---|---|
| `<capture>` | `/tmp/opencode/agy-swelight-20261122-180347/capture/` (Run 1: `stream.jsonl`, `agy.log`) |
| `<state>` | `<appDataDir>/scratch/teamwork/de4caef3-434f-4591-9b19-7e13439cc095/.agents/teamwork/` (Run 1) |
| `<workspace>` | Run 1's two-file Node.js fixture |
| `<capture-2>` | `/tmp/opencode/agy-swelight-complete-20261122-210730/capture/` (Run 2: `stream.jsonl`, `agy.log`, `exit.txt`) |
| `<state-2>` | `<appDataDir>/brain/5a2f01f1-a0f2-46cc-97fa-8967ba123f7c/scratch/.agents/teamwork/` (Run 2) |
| `<auditor-2>` | `<appDataDir>/brain/054a14c2-6ecb-48d3-96d3-29f7b0559c73/scratch/` (Run 2 victory auditor) |
| `<workspace-2>` | Run 2's two-file Node.js fixture |

`<capture>`, `<state>` and `<workspace>` are Run 1; the `-2` forms are Run 2.

The redacted evidence bundles are in [`live/2026-11-22-swe-light/`](live/2026-11-22-swe-light/) (Run 1) and [`live/2026-11-22-swe-light-complete/`](live/2026-11-22-swe-light-complete/) (Run 2).

---

## 1. Run 1 — identity

| Field | Value | Label |
|---|---|---|
| Top-level conversation | `8e6decab-d1a6-433e-871e-8ae98e551663` | OBSERVED — `<capture>/stream.jsonl` `init`; brain transcript |
| Coordinator / sentinel conversation | `de4caef3-434f-4591-9b19-7e13439cc095` | OBSERVED — `<state>/sentinel/BRIEFING.md`; `<state>/ORIGINAL_REQUEST.md` |
| SWE Light orchestrator conversation | `23ea31fc-c92d-4b47-a88f-93616700c53b` | OBSERVED — `<state>/swe_light/BRIEFING.md` |
| Round 1 implementer | `005eec9e-d2ab-408f-89e8-bdc4fa483260` | OBSERVED — `<state>/swe_light/BRIEFING.md` team roster |
| Round 2 reviewer | `1ebc2d4e-b0a1-4ccb-8934-ed3ab4933fdf` | OBSERVED — `<state>/swe_light/BRIEFING.md`; `<state>/teamwork_reviewer_r2/progress.md` |
| Top-level model | `gemini-3.8-flash-low` | OBSERVED — `stream.jsonl` `init.init.model`; all four main-turn `model` fields |
| Teamwork models | `gemini-4-hydrogen-tiered-high` (coordinator, SWE orchestrator, implementer, reviewer) | OBSERVED — every `PLANNER_RESPONSE.model` in the four brain transcripts |
| Exit code / terminal result | **none recorded** — no `exit.txt`, no final `result` event | OBSERVED — `<capture>/` file list; `stream.jsonl` ends on a status delta |
| Termination | server restart while Round 2 was the active work item | OBSERVED — capture owner's report; `agy.log` ends abruptly at 18:18:38 local with no shutdown/exit; see §7 |
| Top-level usage | 26,625 input / 402 output / 17,370 cache-read | OBSERVED — summed `PLANNER_RESPONSE` fields; the `stream.jsonl` step totals agree |

### 1.1 The model split recurs

The top-level conversation is again `gemini-3.8-flash-low`, while every teamwork conversation records `gemini-4-hydrogen-tiered-high`:

| Conversation | Recorded model | Planner turns |
|---|---|---:|
| `8e6decab…` main | `gemini-3.8-flash-low` | 4 |
| `de4caef3…` coordinator / sentinel | `gemini-4-hydrogen-tiered-high` | 8 |
| `23ea31fc…` SWE orchestrator | `gemini-4-hydrogen-tiered-high` | 11 |
| `005eec9e…` implementer | `gemini-4-hydrogen-tiered-high` | 6 |
| `1ebc2d4e…` reviewer | `gemini-4-hydrogen-tiered-high` | 4 |

[OBSERVED — brain transcripts under `.../brain/<conv>/.system_generated/logs/transcript.jsonl`]

This is the same split as `12` §1.1, now in a second independent run. It strengthens the observation that the launch model and the team's model are separate selections; **which selector produced the split is still `UNKNOWN`**, and the two runs do not prove a fixed policy.

---

## 2. Command shape and `## Parameters`

The capture records the prompt but no argv. The assembled line is `INFERRED`; each component is observed.

```sh
agy -p='/teamwork [skip-interview] Use the SWE Light route for this small, quick, single-file task: make the failing test in hello.test.mjs pass without editing the test file. Run node --test and stop when it passes.' \
    --dangerously-skip-permissions \
    --print-timeout 30m \
    --output-format stream-json \
    > <capture>/stream.jsonl 2> <capture>/agy.log
```

[OBSERVED prompt text in `main` transcript step 0 and `ORIGINAL_REQUEST.md`; OBSERVED `init.init.model`, `init.init.cwd` and stream schema; `INFERRED` flag spelling/order and redirections]

The request was bracket-led, and the `## Parameters` block appears again, before `## Initial Request`:

```markdown
# Original User Request

## Parameters
[skip-interview]
How this run was launched; not part of the task.

## Initial Request — 2026-11-22T23:06:48Z
Use the SWE Light route for this small, quick, single-file task: make the failing test in hello.test.mjs pass without editing the test file. Run node --test and stop when it passes.
```

[OBSERVED — `<state>/ORIGINAL_REQUEST.md` (332 bytes, 8 lines)]

| Finding | Evidence | Label |
|---|---|---|
| `## Parameters` / `[skip-interview]` / exact sentence | `ORIGINAL_REQUEST.md:3-5` | OBSERVED |
| Task text is separate and verbatim | `ORIGINAL_REQUEST.md:7-8` | OBSERVED |
| No `interviewer/` folder | `find <state> -maxdepth 1 -type d` | OBSERVED |
| The token caused the skip | No interviewer ran; no log names the token | INFERRED |

This is the second runtime instance of A5; it no longer rests on a single run.

---

## 3. Route decision

The sentinel selected **SWE Light**:

> **Path**: SWE Light (`teamwork_swe`)
>
> **Rationale**: User explicitly requested SWE Light for a small, quick, single-file task (one self-contained code change with explicit lightness/route signal).

[OBSERVED — `<state>/sentinel/BRIEFING.md` §Routing Decision]

| Finding | Evidence | Label |
|---|---|---|
| A named path and rationale were emitted | `sentinel/BRIEFING.md` | OBSERVED |
| The rationale cites the **user's explicit route request** plus task size | same | OBSERVED |
| The route maps to `teamwork_swe` | `sentinel/BRIEFING.md`; `swe_light/BRIEFING.md` "Archetype: teamwork_swe" | OBSERVED |
| No project orchestrator was dispatched | No `orchestrator/` folder; one `swe_light/` orchestrator | OBSERVED (absence) |
| The router would choose SWE Light again for a similar request | One run only | UNKNOWN |

The route wording is worth keeping: this was **not** a router inference from task shape alone. The user wrote "Use the SWE Light route" and "explicit lightness/route signal" in the rationale. Do not treat this run as evidence that a small single-file task routes to SWE Light by itself.

---

## 4. Workflow: no decomposition, one sequential loop

The SWE Light briefing states the pattern in its own words:

> **Decompose**: None — SWE Light does not decompose; every worker receives the whole task verbatim.
>
> **Direct (iteration loop)**: Sequential loop: `teamwork_implementer` -> `teamwork_reviewer` (repeat until 0 issues, 0 edits, empty open-issues ledger, and own `node --test` verification passes, then `teamwork_victory_auditor`).

[OBSERVED — `<state>/swe_light/BRIEFING.md` §My Workflow]

| Fact | Value | Label |
|---|---|---|
| Step 0 Survey / explorers | **none** — no explorer folder, no survey dispatch | OBSERVED (absence) |
| `PROJECT.md` | **absent** | OBSERVED |
| Milestone decomposition | **none** — one whole task, assigned verbatim | OBSERVED — briefing text; no `M1` scope documents |
| Worker type | `teamwork_implementer` (not `teamwork_worker`) | OBSERVED |
| Verifier type | `teamwork_reviewer`, repeated per round | OBSERVED |
| Parallel verification wave | **none** — one reviewer at a time | OBSERVED (absence) |
| Deterministic per-task reports | none; the loop is prose plus the `progress.md` ledger | OBSERVED |
| Victory auditor | mandatory after a closed loop | OBSERVED — briefing; §8 |

**The loop is the gate.** There is no `GATE_STATUS.md`, no row table, and no separate challenger/auditor wave in this route. A round passes only when the reviewer reports **zero issues, zero edits**, the open-issues ledger is **empty**, and the reviewer's own `node --test` passes. The next agent is then the victory auditor, not a gate-table author. [OBSERVED workflow text; the "loop is the gate" framing is the document's interpretation, `INFERRED` from the absence of a gate file plus the explicit loop condition]

### 4.1 The open-issues ledger

`<state>/swe_light/progress.md` carries a cumulative ledger:

```markdown
## Open-Issues Ledger
- [Round 1] Unverified aspect: Behavior if `hello` is called with arguments or imported under a different runtime/environment (no other files or tests exist in the repository).
- [Round 1] Untested edge case / next step raised: Review the `git diff` on `hello.mjs` and confirm no extra behavior (e.g., parameterized greetings) was expected beyond what `hello.test.mjs` tests.
```

[OBSERVED — `<state>/swe_light/progress.md`]

The ledger is the SWE Light analogue of the General run's gate rows: it is how one round's unresolved concerns reach the next. In this run it still contained **two Round 1 entries** when the process stopped. No Round 2 resolution was written. [OBSERVED — file content and mtime 23:15:15, before the reviewer finished at 23:17:51]

---

## 5. Timeline

All timestamps UTC. The capture starts at 18:03:50 local = 23:03:50Z; the user request is at 23:04:02Z.

| Time (UTC) | Event | Evidence | Label |
|---|---|---|---|
| 23:03:50 | Print-mode process starts | `<capture>/agy.log` first line | OBSERVED |
| 23:04:02 | User submits `/teamwork [skip-interview] Use the SWE Light route…` | main transcript step 0 | OBSERVED |
| 23:06:45 | Main model calls `invoke_subagent` (`TypeName: "teamwork"`) | main transcript step 1 | OBSERVED |
| 23:06:48 | Coordinator conversation `de4caef3…` is created; `ORIGINAL_REQUEST.md` timestamp | main transcript step 2; `<state>/ORIGINAL_REQUEST.md` | OBSERVED |
| 23:08:09 | Coordinator writes the request/briefing and creates `swe_light/` | coordinator transcript step 1 | OBSERVED |
| 23:08:23–30 | Coordinator dispatches the SWE orchestrator; `23ea31fc…` is created at 23:08:30; coordinator schedules `*/8` and `*/20` crons and notifies the caller | coordinator transcript steps 5–13; `sentinel/BRIEFING.md` | OBSERVED |
| 23:09:51 | SWE orchestrator first turn reads `ORIGINAL_REQUEST.md` | SWE transcript step 1 | OBSERVED |
| 23:09:56 | Writes `swe_light/DISPATCH.md`, `BRIEFING.md`, `progress.md` | SWE transcript step 3 | OBSERVED |
| 23:10:10–12 | Dispatches **Round 1 `teamwork_implementer`** (`005eec9e…`) and schedules heartbeat `task-11` | SWE transcript steps 9–16 | OBSERVED |
| 23:13:45 | Implementer starts; reads the two files | implementer transcript step 1 | OBSERVED |
| 23:13:50 | Edits `hello.mjs`: `"bye"` → `"hello"` | implementer transcript step 8 | OBSERVED |
| 23:13:52–14:00 | Runs `node --test` (1/1), writes `progress.md`, sends its final report via `send_message` | implementer transcript steps 10–16; `<state>/teamwork_implementer_r1/progress.md` | OBSERVED |
| 23:15:03 | SWE orchestrator re-runs `git status`, `git diff`, `node --test`; sees 1/1 pass | SWE transcript step 19 | OBSERVED |
| 23:15:07–12 | Dispatches **Round 2 `teamwork_reviewer`** (`1ebc2d4e…`) | SWE transcript steps 21–27 | OBSERVED |
| 23:15:15 | `swe_light/progress.md` updated: Round 1 done, Round 2 pending, ledger has two entries | `<state>/swe_light/progress.md` mtime and content | OBSERVED |
| 23:17:38 | Reviewer starts; reads both files and runs `git status`, `git diff`, `node --test`, plus argument/`this` probes | reviewer transcript step 1 | OBSERVED |
| 23:17:44 | Reviewer writes `progress.md` ("Verified zero defects and 0 code/test edits needed; sending final review report.") and sends the report via `send_message` | reviewer transcript step 8; `<state>/teamwork_reviewer_r2/progress.md` | OBSERVED |
| 23:17:51 | Reviewer's planner turn ends ("final report sent to parent via `send_message`") | reviewer transcript step 11 | OBSERVED |
| 23:18:38 | Last `agy.log` line; no shutdown, no exit, no final `result` event | `<capture>/agy.log`; `<capture>/stream.jsonl` | OBSERVED |
| after 23:18:38 | Server restart kills the run | capture owner's report; abrupt log end | OBSERVED — report; cause/attribution `INFERRED` from artifacts |

**The run never returned from Round 2.** The reviewer's own transcript records a completed check and an outbound report, but the SWE orchestrator's last turn is 23:15:18 — before the reviewer's 23:17:51 message — and there is no Round 2 handoff, no ledger update, and no next dispatch. So the **recorded state** has Round 2 in progress; the reviewer's outbound message is not a verdict the parent ever consumed. [OBSERVED transcripts; the "not consumed" conclusion is `INFERRED` because no parent turn follows]

One counter disagrees between levels: the top-level status message at 23:16:20 says "Iteration 1 / 32", while `<state>/swe_light/progress.md` at 23:15:15 says `Current iteration: 2 / 32`. This document uses the orchestrator's own counter; the top-level message is a stale/derived summary. [OBSERVED — both strings]

---

## 6. Artifacts: what SWE Light writes

The shared state root is the same primary form as `12`:

```text
<appDataDir>/scratch/teamwork/de4caef3-434f-4591-9b19-7e13439cc095/.agents/teamwork/
```

| Fact | Value | Label |
|---|---|---|
| Files | **7** | OBSERVED — `find <state> -type f \| wc -l` |
| Size | **28 KB** (`du -sh`) | OBSERVED |
| Folders | `sentinel/`, `swe_light/`, `teamwork_implementer_r1/`, `teamwork_reviewer_r2/` | OBSERVED |
| `ORIGINAL_REQUEST.md` | present (332 B) | OBSERVED |
| `PROJECT.md` | **absent** | OBSERVED |
| `GATE_STATUS.md` | **absent** | OBSERVED |
| `SCOPE.md` / `sub_orch_*` | **absent** | OBSERVED |
| `TEST_INFRA.md` / `TEST_READY.md` | **absent** | OBSERVED |
| `interviewer/` | **absent** (`[skip-interview]`) | OBSERVED |
| Implementer `handoff.md` | **absent** — folder contains only `progress.md` | OBSERVED |
| Reviewer `handoff.md` | **absent** — folder contains only `progress.md` | OBSERVED |
| Victory auditor folder | **absent** | OBSERVED |
| Workspace teamwork state | **none** | OBSERVED |

This is a much smaller artifact set than the General run: no project plan, no milestone scope, no gate table, no handoffs. The route's state is the two `progress.md` files plus the orchestrator's briefing/progress. [OBSERVED]

### 6.1 The missing handoffs

The implementer **did** complete its work: it edited `hello.mjs`, ran `node --test` (1/1), wrote a `progress.md`, and sent a final report through `send_message`. But it wrote **no `handoff.md`**, and the reviewer folder likewise contains only `progress.md`. The artifact is therefore stronger than "empty handoff": **there is no implementer handoff file at all.** The completion exists in the transcript and the progress note, not in the gate artifact the General run used. [OBSERVED — `ls` of both agent folders; transcripts]

Do **not** convert the implementer's `send_message` or the reviewer's outbound report into a gate verdict. The SWE Light workflow requires a closed loop and then a victory auditor; neither happened on disk.

### 6.2 Workspace result

| Check | Result | Label |
|---|---|---|
| `hello.mjs` | modified to `export function hello() { return "hello" }` | OBSERVED — implementer transcript; workspace file |
| `hello.test.mjs` | unmodified | OBSERVED — reviewer `git diff`; workspace file |
| `node --test` | 1/1 pass, exit 0 | OBSERVED — implementer, orchestrator and reviewer all ran it |
| Extra files | none | OBSERVED — workspace contains `.git`, `hello.mjs`, `hello.test.mjs` |

So the product is correct by the repository's only test; the **process** did not close.

---

## 7. Termination: server restart, not quota

| Signal | Result | Label |
|---|---|---|
| `exit.txt` | **absent** | OBSERVED |
| Final `result` event in `stream.jsonl` | **absent** | OBSERVED |
| HTTP 429 / `RESOURCE_EXHAUSTED` | **absent** from `stream.jsonl`; `agy.log`'s only "quota" strings are `quota_manager` startup lines, and its only "429" is a timestamp substring | OBSERVED |
| Shutdown / exit log lines | absent; `agy.log` ends at 18:18:38.626 local on an MCP message | OBSERVED |
| Reviewer round | pending in the orchestrator's state; the reviewer's outbound report has no parent turn | OBSERVED |
| Cause | server restart | OBSERVED — capture owner's report; `INFERRED` as the artifact-level explanation from the abrupt, non-quota end |

This is a **third distinct terminal class** in the corpus, alongside the General run's `print_timeout` (`12` §9) and the quota-blocked first live run (`07` §3.5): an **external process death with no agent-level terminal event**. The workspace still passes; the run does not have a completion record.

---

## 8. Victory audit: mandatory, not reached

The sentinel's briefing states the requirement:

```text
- Victory Audit is MANDATORY before reporting completion (via teamwork_swe's VICTORY CONFIRMED or sentinel-spawned teamwork_victory_auditor)
```

[OBSERVED — `<state>/sentinel/BRIEFING.md` §Key Constraints]

| Fact | Value | Label |
|---|---|---|
| Victory audit required | yes | OBSERVED — sentinel briefing; SWE briefing's "then `teamwork_victory_auditor`" |
| Auditor spawned | **no** — no victory folder, no conversation id | OBSERVED |
| Verdict | **none** — sentinel says `Verdict: pending`, `Triggered: no` | OBSERVED |
| Loop closed first | **no** — ledger not empty, no Round 2 handoff, no parent turn after the reviewer | OBSERVED (absence) |

The run stopped **before** the point at which a victory auditor would be dispatched. This is not a `VICTORY REJECTED`; it is an uncompleted audit. [OBSERVED] Run 2 shows the other side: the same route completed the audit and returned `VICTORY CONFIRMED` (§12.5).

---

## 9. General vs. SWE Light: two gate mechanisms

| Dimension | General (`12`) | SWE Light (this run) |
|---|---|---|
| Decomposition | 2 explorers → `PROJECT.md` → 1 worker | none |
| Gate artifact | `orchestrator/GATE_STATUS.md`, 4 rows | **no gate file** |
| Gate mechanism | independent reviewer + challenger + auditor, ANDed | sequential implementer → reviewer, repeat until 0 issues / 0 edits / empty ledger / test passes |
| Redundancy | 3 independent verdicts (minimum) | repeated reviewer rounds; one reviewer per round |
| Handoffs | five-part `handoff.md` per agent | `progress.md` only; reports via `send_message` |
| Victory audit | dispatched after gate PASS; cut by timeout | mandatory after loop; not reached |
| Terminal state | timeout after PASS | server restart mid-loop |

**The reference's General and SWE Light gates are different mechanisms, not two row counts of one template.** A six-row table is one General-family composition; a four-row table is another; SWE Light has no table at all and gates on a convergence loop. Any reimplementation must model the route's **verification contract**, not a universal gate schema. [OBSERVED for both runs; the "different mechanisms" conclusion is `INFERRED` from the workflow text plus artifact absence, and is exactly what two samples can support]

What remains `UNKNOWN` after Run 1 alone, and what Run 2 adds:

- whether SWE Light normally writes a `handoff.md` at all — **Run 2 shows the sentinel and `teamwork_swe_1` do, while implementer/reviewer still do not (sandbox)** (§12.6-§12.7);
- how many reviewer rounds a typical SWE Light task takes — Run 2 needed **one** reviewer round after implementation (§12.4); one sample is not a typical count;
- whether the ledger is normally written by the reviewer or the orchestrator — Run 2's `teamwork_swe_1/progress.md` holds the empty final ledger, so the orchestrator writes it in that run;
- whether the victory auditor is always sentinel-spawned or can be the SWE orchestrator's own — Run 2's auditor was dispatched **inside `teamwork_swe`** (§12.5);
- whether the 4-row General form and the no-row SWE Light form generalise to other SWE tasks — still `UNKNOWN`; two SWE Light samples, one completed.

The remaining route-level question is not the verdict (Run 2 supplies it) but the **root and reporting contract**: why Run 1 used `<appDataDir>/scratch/teamwork/<run-id>` while Run 2 used `brain/<coordinator>/scratch`, and how often each occurs (§12.6; `11` §2.1).

---

## 10. Run 1 — limits

- **Run 1** is one interrupted SWE Light run. It does not show a completed SWE Light victory, a reviewer handoff, or the loop's convergence check; §12 supplies those for Run 2.
- **Run 1's** implementer and reviewer **handoff files do not exist**; their `progress.md` and transcript messages are the only completion evidence.
- **Run 1's** reviewer transcript says it found zero defects and sent a report, but no parent turn processed it. Do not quote that as the run's verdict.
- The server-restart cause is the capture owner's report; the artifacts show only an abrupt end with no exit/result and no quota error.
- The argv is reconstructed; the prompt and flags are observed separately.
- The route rationale includes the user's explicit "Use the SWE Light route" wording, so this run does not prove automatic routing by task size.
- The model split is observed again; its selector remains `UNKNOWN`.
- The bundle contains only the five named state documents for Run 1; no empty/missing handoff is fabricated.
- **Run 2** is one completed sample. Its `brain/<coordinator>/scratch` root, sandboxed per-agent folders and prose `VICTORY CONFIRMED` may be route/host conditions rather than invariants (§12.9).

---

## 11. Run 1 — re-derive

```sh
# identity and terminal state
head -2 <capture>/stream.jsonl
tail -3 <capture>/stream.jsonl
ls -la <capture>
grep -c 'RESOURCE_EXHAUSTED\|429' <capture>/stream.jsonl   # expect 0
tail -5 <capture>/agy.log                                  # abrupt end

# state tree
find <state> -type f -printf '%s %p\n' | sort -k2
du -sh <state>

# route and workflow
cat <state>/sentinel/BRIEFING.md
cat <state>/swe_light/BRIEFING.md
cat <state>/swe_light/progress.md

# workspace
cd <workspace> && node --test && git status --short && git diff
```

The redacted copies in [`live/2026-11-22-swe-light/`](live/2026-11-22-swe-light/) are the stable citation targets.

---

## 12. Run 2 — completed (2026-11-23)

Run 2 is the completed successor to Run 1: same route, same binary, same two-file fixture, same `[skip-interview]` bracket. It closed the loop, ran the mandatory independent victory audit, and returned **`VICTORY CONFIRMED`**.

### 12.1 Identity and terminal state

| Field | Value | Label |
|---|---|---|
| Top-level conversation | `8d162c43-ff84-4298-8c7b-f698da82192c` | OBSERVED — `<capture-2>/stream.jsonl` `init`; brain transcript |
| Coordinator / sentinel | `5a2f01f1-a0f2-46cc-97fa-8967ba123f7c` | OBSERVED — `<state-2>/sentinel/BRIEFING.md` |
| SWE Light orchestrator | `93eb99f5-eecf-4690-b4dd-191b3766e852` | OBSERVED — `<state-2>/teamwork_swe_1/BRIEFING.md` |
| Round 1 implementer | `43fa897d-fcc1-465e-aed6-c67eb5008db8` | OBSERVED — team roster |
| Round 2 reviewer | `f2ac7b04-e4c3-4b11-a43a-892c4d111efa` | OBSERVED — team roster |
| Victory auditor | `054a14c2-6ecb-48d3-96d3-29f7b0559c73` | OBSERVED — `<auditor-2>/handoff.md`; sentinel briefing |
| Top-level model | `gemini-3.8-flash-low` | OBSERVED — `init.init.model`; all main-turn `model` fields |
| Teamwork models | `gemini-4-hydrogen-tiered-high` (coordinator, SWE orchestrator, implementer, reviewer, auditor) | OBSERVED — every teamwork `PLANNER_RESPONSE.model` |
| Exit code | `0` | OBSERVED — `<capture-2>/exit.txt` (`EXIT=0`) |
| Result status | `SUCCESS`, `finished_reason` absent, `error` absent | OBSERVED — final `result` event |
| Duration | **1,593.19 s ≈ 26m33s** | OBSERVED — `result.duration_seconds` |
| Main `num_turns` | **1** | OBSERVED — `result.num_turns` |
| Main usage | **22,927 input / 1,191 output / 46,076 cache-read** | OBSERVED — `result.usage` |
| Process window | 02:07:34Z process start; request 02:10:32Z; final 02:34:13Z | OBSERVED — `agy.log`; transcripts |

The `num_turns: 1` field is the client's turn count, not the number of model calls: the main transcript still contains the initial handoff plus five progress/final responses. Do not read it as "one model response". [OBSERVED both fields]

### 12.2 The model split recurs, again

| Conversation | Recorded model | Planner responses |
|---|---|---:|
| `8d162c43…` main | `gemini-3.8-flash-low` | 6 |
| `5a2f01f1…` coordinator / sentinel | `gemini-4-hydrogen-tiered-high` | 19 |
| `93eb99f5…` SWE orchestrator | `gemini-4-hydrogen-tiered-high` | 15 |
| `43fa897d…` implementer | `gemini-4-hydrogen-tiered-high` | 6 |
| `f2ac7b04…` reviewer | `gemini-4-hydrogen-tiered-high` | 4 |
| `054a14c2…` auditor | `gemini-4-hydrogen-tiered-high` | 7 |

[OBSERVED — brain transcripts]

The launch-vs-team model split now appears in all three completed or partially completed live runs (`12` §1.1, §13 §1.1, this section). The selector remains `UNKNOWN`; three observations make it a recurring fact, not a proven policy.

### 12.3 Command and `## Parameters`

```sh
agy -p='/teamwork [skip-interview] Use the SWE Light route for this small, quick, single-file task: make the failing test in hello.test.mjs pass without editing the test file. Run node --test and stop when it passes. Complete the full SWE Light loop, including the mandatory independent victory audit, and report the verdict.' \
    --dangerously-skip-permissions \
    --print-timeout 30m \
    --output-format stream-json \
    > <capture-2>/stream.jsonl 2> <capture-2>/agy.log
```

[OBSERVED prompt text and `init` fields; `INFERRED` flag spelling/order and redirections]

`ORIGINAL_REQUEST.md` again carries the block, timestamped **2026-11-23T02:10:32Z**:

```markdown
# Original User Request

## Parameters
[skip-interview]
How this run was launched; not part of the task.

## Initial Request — 2026-11-23T02:10:32Z
Use the SWE Light route for this small, quick, single-file task: make the failing test in hello.test.mjs pass without editing the test file. Run node --test and stop when it passes. Complete the full SWE Light loop, including the mandatory independent victory audit, and report the verdict.
```

[OBSERVED — `<state-2>/ORIGINAL_REQUEST.md` (441 bytes, 8 lines)]

The explicit request includes the full-loop and victory-audit requirement, which is stronger than Run 1's task line; the route still had to execute the same loop, but the user removed any ambiguity about stopping early.

### 12.4 Route decision

> **Path**: SWE Light (`teamwork_swe`)
>
> **Rationale**: Single self-contained code change (fix failing test in `hello.test.mjs` without editing it) AND user explicitly requested the SWE Light route for a small, quick, single-file task. `[skip-interview]` parameter skipped the task interview.

[OBSERVED — `<state-2>/sentinel/BRIEFING.md` §Routing Decision]

The rationale names **two** conditions — a single self-contained change **and** an explicit request — plus the skip token. That is more precise than Run 1's "explicit lightness/route signal" wording and again does not show automatic routing by size alone.

### 12.5 The loop, the convergence, and the verdict

The workflow text is the same loop as Run 1 (`13` §4), with an explicit "no decomposition" statement:

> **Decompose**: No decomposition — SWE Light sends the whole verbatim task through sequential refinement.
>
> **Direct (iteration loop)**: teamwork_implementer -> teamwork_reviewer -> (repeat until clean 0-issue, 0-edit, empty-ledger pass + own test verification) -> teamwork_victory_auditor.

[OBSERVED — `<state-2>/teamwork_swe_1/BRIEFING.md`]

| Time (UTC) | Event | Evidence | Label |
|---|---|---|---|
| 02:07:34 | Process starts | `<capture-2>/agy.log` | OBSERVED |
| 02:10:32 | Coordinator creates `ORIGINAL_REQUEST.md` / sentinel briefing | `<state-2>/ORIGINAL_REQUEST.md`; coordinator transcript | OBSERVED |
| 02:12:15–23 | Dispatches `teamwork_swe`; schedules `*/8` + `*/20` crons; notifies caller. SWE records its own `DISPATCH.md` at 02:13:45 | coordinator transcript; `<state-2>/teamwork_swe_1/DISPATCH.md` | OBSERVED |
| 02:13:45–14:05 | SWE orchestrator reads request, writes briefing/progress, dispatches **Round 1 implementer** | SWE transcript | OBSERVED |
| 02:16:20–16:37 | Implementer edits `hello.mjs` (`"bye"` → `"hello"`), runs `node --test` (1/1), reports by `send_message` | implementer transcript | OBSERVED |
| 02:19:36 | Orchestrator re-runs `git status && git diff && node --test`; only `hello.mjs` modified, 1/1 pass | SWE transcript step 13 | OBSERVED |
| 02:19:43 | Dispatches **Round 2 reviewer** | SWE transcript step 16 | OBSERVED |
| 02:23:30–23:45 | Reviewer audits; **0 issues, 0 edits**, runs `git log -p`, `git diff`, `node --test`, direct import; reports by `send_message` | reviewer transcript | OBSERVED |
| 02:25:07 | Orchestrator re-verifies diff + `node --test` (exit 0) | SWE transcript step 24 | OBSERVED |
| 02:25:11–17 | Dispatches **victory auditor**; writes progress with Audit #1 pending | SWE transcript steps 26–32 | OBSERVED |
| 02:27:42–28:28 | Auditor runs Phases A/B/C and writes `handoff.md` in its own brain scratch | auditor transcript; `<auditor-2>/handoff.md` | OBSERVED |
| 02:30:38 | Orchestrator kills heartbeat `93eb99f5…/task-6`, writes its `handoff.md` | SWE transcript step 34 | OBSERVED |
| 02:32:26–52 | Sentinel reads the auditor + orchestrator handoffs, writes its own `handoff.md`, kills monitoring crons, sends the final report | coordinator transcript steps 43–57 | OBSERVED |
| 02:34:13 | Main conversation emits the final summary; process exits 0 | `<capture-2>/stream.jsonl`; `exit.txt` | OBSERVED |

The convergence conditions are explicit in `<state-2>/teamwork_swe_1/progress.md`:

```text
Current iteration: 2 / 32
Open-Issues Ledger
(empty)
Victory Audits
- Audit #1 (054a14c2-…): VICTORY CONFIRMED (Phase A PASS, Phase B PASS, Phase C PASS — node --test exit 0, 1 passed, 0 failed)
```

[OBSERVED — `<state-2>/teamwork_swe_1/progress.md`]

### 12.6 Victory audit: three phases, prose verdict

The auditor's handoff is a numbered five-part report:

| Phase | Result | Label |
|---|---|---|
| A — Timeline & Provenance | **PASS** — seed commit `491c40c`, coherent mtimes, `hello.test.mjs` unchanged | OBSERVED |
| B — Integrity Forensics | **PASS** — genuine one-line implementation, no pre-populated artifacts, no test bypass, no hooks | OBSERVED |
| C — Independent Test Execution | **PASS** — `node --test` 1/1, exit 0; direct import returns `"hello"` | OBSERVED |
| Final verdict | **`VICTORY CONFIRMED`** | OBSERVED — `<auditor-2>/handoff.md` §4; sentinel and SWE briefings |

The verdict is **prose**, not a machine-readable artifact:

- sentinel `BRIEFING.md` records `Victory Audit Status → Verdict: VICTORY CONFIRMED` and `Auditor: 054a14c2…`;
- sentinel and SWE `handoff.md` each state `Verdict: VICTORY CONFIRMED`;
- the auditor's own `handoff.md` states `VICTORY CONFIRMED` in §4.

There is **no `GATE_STATUS.md`** and **no structured `verify/victory.json`** anywhere in the run tree. A `find` over the coordinator root and the auditor scratch for `GATE_STATUS.md`, `PROJECT.md` and `victory.json` returns nothing. This is a **divergence from this repository's structured `verify/final.json` / `teamwork_final_verify` model**: the reference's completion evidence is a handoff plus prose, not a stamped JSON verdict. [OBSERVED absence; the comparison is `INFERRED` from our own contract]

### 12.7 Artifact root and the per-agent sandbox

Run 2 used the **brain** root:

```text
<appDataDir>/brain/5a2f01f1-a0f2-46cc-97fa-8967ba123f7c/scratch/.agents/teamwork/
```

not Run 1's shared `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/`. The root contains only **7 files / 32 KB**:

| Path | Bytes | Label |
|---|---:|---|
| `ORIGINAL_REQUEST.md` | 441 | OBSERVED |
| `sentinel/BRIEFING.md` | 2,955 | OBSERVED |
| `sentinel/handoff.md` | 2,744 | OBSERVED |
| `teamwork_swe_1/BRIEFING.md` | 4,581 | OBSERVED |
| `teamwork_swe_1/DISPATCH.md` | 1,391 | OBSERVED |
| `teamwork_swe_1/progress.md` | 1,278 | OBSERVED |
| `teamwork_swe_1/handoff.md` | 2,940 | OBSERVED |

Three per-agent folders exist but are **empty**: `teamwork_implementer_r1/`, `teamwork_reviewer_r2/`, `teamwork_victory_auditor_1/`. The auditor's actual handoff is at `<auditor-2>/handoff.md` (its own brain scratch), not under the coordinator root.

The cause is stated directly in the auditor's Caveats:

> `write_file` enforces writing only within this agent's own artifact directory (`<appDataDir>/brain/054a14c2-…`), so state files (`DISPATCH.md`, `BRIEFING.md`, `progress.md`, `handoff.md`) were written to `<appDataDir>/brain/054a14c2-…/scratch/` rather than the parent-referenced `5a2f01f1-…/teamwork_victory_auditor_1`.

[OBSERVED — `<auditor-2>/handoff.md` §3 Caveats]

The SWE orchestrator records the same operational consequence:

> Subagents' `write_file` calls targeting the parent brain's scratch directory are restricted by the tool's artifact-directory sandbox; subagents delivered full reports via `send_message` (and the auditor wrote `handoff.md` in its own brain scratch dir).

[OBSERVED — `<state-2>/teamwork_swe_1/progress.md` §Retrospective Notes]

| Consequence | Value | Label |
|---|---|---|
| Implementer folder | empty; report by `send_message` | OBSERVED |
| Reviewer folder | empty; report by `send_message` | OBSERVED |
| Auditor folder under coordinator root | empty; handoff in own brain scratch | OBSERVED |
| Auditor handoff path | `<appDataDir>/brain/054a14c2-…/scratch/handoff.md` | OBSERVED |
| Work products | still in `<workspace-2>`; sandbox affects state files only | OBSERVED |

This **also explains Run 1's empty implementer/reviewer folders**: the same `write_file` sandbox is the likely cause there, though Run 1's own artifact set never records the explanation. The Run 1 attribution is therefore `INFERRED`; Run 2's is `OBSERVED` in the auditor's Caveats. [OBSERVED for Run 2; `INFERRED` for Run 1]

### 12.8 Handoffs and the five-part structure

| Document | Five-part structure | Label |
|---|---|---|
| `sentinel/handoff.md` | Observation, Logic Chain, Caveats, Conclusion, Verification Method | OBSERVED |
| `teamwork_swe_1/handoff.md` | same five | OBSERVED |
| `<auditor-2>/handoff.md` | `## 1. Observation` … `## 5. Verification Method` | OBSERVED |

The implementer and reviewer wrote **no handoffs**; their folders are empty and their reports are `send_message` payloads. So the five-part protocol is confirmed for the **sentinel, orchestrator and auditor**, not for every agent in the route. This matches Run 1's missing per-agent handoffs and narrows the A7 claim: the protocol is a **role-dependent** artifact, not a universal one. [OBSERVED]

### 12.9 Run 1 vs Run 2: what changed

| Dimension | Run 1 (interrupted) | Run 2 (completed) |
|---|---|---|
| Artifact root | `<appDataDir>/scratch/teamwork/<run-id>/` | `<appDataDir>/brain/<coordinator>/scratch/` |
| Files in root | 7 | 7 |
| Exit / result | none; server restart | exit 0; `SUCCESS` |
| Loop | Round 2 pending; no verdict | Round 2 clean; loop closed |
| Ledger | two Round 1 entries | empty |
| Victory audit | not reached | 3 phases PASS; `VICTORY CONFIRMED` |
| Verdict artifact | prose pending in sentinel briefing | prose in three handoffs/briefings; no JSON |
| Per-agent handoffs | none (implementer/reviewer) | sentinel + SWE + auditor; implementer/reviewer none |
| Iterations / spawns | 2 / 32; 2 / 32 | 2 / 32; 3 / 32 |
| Heartbeat | `task-11` (Run 1) | `task-6`, killed |

What Run 2 **settles** for this route:

- a SWE Light loop can close and produce `VICTORY CONFIRMED` without a `GATE_STATUS.md`;
- the victory auditor is dispatched **inside `teamwork_swe`**, not by the sentinel;
- the sentinel and SWE orchestrator do write hard handoffs;
- the `brain/<coordinator>/scratch` root is a real, completed-run form, not only a fallback stub;
- the per-agent emptiness is a **sandbox** effect, not evidence that the agents did nothing.

What remains **route-level `UNKNOWN`**:

- whether every SWE Light run uses the brain root or whether the shared `scratch/teamwork` form is equally normal (two samples, one each);
- whether implementer/reviewer are ever expected to write handoffs under a different sandbox policy;
- whether the prose verdict is the route's normal completion record or a client/tooling limitation;
- how many reviewer rounds a typical SWE Light task needs (Run 2 used one).

---

## 13. Series conclusion

Two SWE Light runs, one interrupted and one completed, now bracket the route's behaviour:

1. **The gate is the loop.** No `GATE_STATUS.md` in either run. The convergence conditions are 0 issues, 0 edits, an empty open-issues ledger, and the reviewer's own `node --test`.
2. **The completion record is prose.** The completed run's verdict lives in the sentinel briefing, the sentinel handoff, the SWE handoff and the auditor handoff — not in a structured `verify/victory.json`.
3. **The artifact root varies.** The shared `scratch/teamwork/<run-id>` form and the `brain/<coordinator>/scratch` form are both observed for this route; the General run's shared root is not the only form.
4. **The per-agent folders can be empty by design.** A `write_file` sandbox keeps subagent state in each agent's own brain directory; reports travel by `send_message`, and the auditor writes its handoff outside the parent root.
5. **Do not collapse the routes.** General uses a row-table gate; SWE Light uses a convergence loop. A reimplementation needs a route-specific verification contract with an explicit completion rule, not a universal gate schema.
