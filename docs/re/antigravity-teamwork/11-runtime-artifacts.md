# Runtime Artifacts — Live Dispatch and the On-Disk Teamwork Contract

**Status: OBSERVED — two live invocations with divergent paths, one quota-partial; second evidence class: the state tree of the user's own prior runs.** Recorded on **2026-11-21** and **2026-11-22** against `agy --version` **1.5.14**, the same binary analysed throughout this corpus (`00-artifact-identity.md`; `07` §1 re-proves byte identity). This document does three things the rest of the set could not:

1. It records a **live `/teamwork-preview` print-mode run** that the client recognised, dispatched to a subagent, lost twice to HTTP 429 quota, and then completed **inline** — §1.1–§1.5.
2. It records a **second invocation of the same command** that started a lean **native swarm** instead — a `coordinator` + `coder` + `monitor` with a `board.jsonl`, no `.agents/teamwork/` anywhere — and it states the divergence between the two runs with the cause `UNKNOWN` — §1.6–§1.7.
3. It records the **artifact contract as it exists on disk**, recovered from state trees that already existed under the CLI's app-data directory — §2–§6. Those trees are the user's own prior teamwork runs, not a controlled experiment.

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md), with one addition used only here: **OBSERVED — disk** means a file whose path, name and structure were read on this machine; **OBSERVED — client** means a string the CLI printed; **OBSERVED — source** means the shipped prompt text quoted at `file:line`. Nothing about the user's project content is reproduced: names, slugs, percentages, commit ids and conversation ids of prior runs are replaced with `<placeholders>`, and no conversation transcript is quoted. See §7.

The short version: **the teamwork artifacts are real, but they are not written into the user's workspace.** They live under `<appDataDir>/brain/<conversation-id>/scratch/.agents/teamwork/`, one state root per agent conversation, and the dispatch text explicitly forbids creating `.agents/teamwork/` in the project directory (§2, §6). **But the command does not always produce them:** a second invocation on the next day produced a native-swarm board instead (§1.6), so this contract describes one of at least two outcomes of `/teamwork-preview`, not the only one.

---

## 1. The live run

### 1.1 Command and result

| Item | Value | Label |
|---|---|---|
| Command | `agy -p='/teamwork-preview [skip-interview] Create a file hello.txt containing exactly: hello. Keep it small and cheap: this is a quick, single, self-contained change.' --dangerously-skip-permissions --print-timeout 880s --output-format text` | OBSERVED — client |
| Workspace | `/tmp/opencode/agy-lab`, empty at start | OBSERVED — disk |
| Exit code | `0` | OBSERVED — client |
| Product | `hello.txt`, **5 bytes**, content exactly `hello` (no trailing newline) | OBSERVED — disk (`wc -c`, `cat`) |
| Wall-clock | ~6 minutes (19:11–19:17 local) | OBSERVED — disk mtimes |
| Teamwork artifacts in the workspace | **none** — no `.agents/`, no `ORIGINAL_REQUEST.md`, no `plan.md`, no `progress.md` | OBSERVED — disk (`find`) |

The timeout was `880s`; the run finished well inside it, so the printed result is the client's final answer, not a partial cut.

### 1.2 Output text, verbatim

Three paragraphs, in order, exactly as printed:

```text
I have handed your request over to the `teamwork` multi-agent team ([Teamwork Orchestrator](conversation://dbeb883c-80f3-415e-86d3-37dffaa41ba4)). I will forward any updates or final results as soon as the team reports back.

The first Teamwork orchestrator (`dbeb883c-...`) hit an individual model quota limit (`RESOURCE_EXHAUSTED (code 429)`). I have re-launched the Teamwork orchestrator on the `flash` model ([Teamwork Orchestrator](conversation://62c78193-...)) and will update you as soon as it reports back.

The `teamwork` subagent (`62c78193-...`) is temporarily unavailable due to a model quota limit (`RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 6m57s.`). To ensure your task is completed right away, I created [hello.txt](file:///tmp/opencode/agy-lab/hello.txt) directly containing `hello`.
```

[OBSERVED — client] The reset interval (`6m57s`) is the server's value at that moment, not a durable fact.

### 1.3 What the text and the state tree establish

| Finding | Evidence | Label |
|---|---|---|
| The slash command is recognised in print mode and **dispatches** | the run produced a normal answer and a `conversation://` link for a separate conversation; the parent conversation's message store records an `invoke_subagent` call | OBSERVED — client + disk |
| The dispatched agent is addressable by `conversation://<id>` | paragraphs 1 and 2 link `conversation://dbeb883c…` and `conversation://62c78193…`; both ids exist as `brain/<id>/` directories | OBSERVED — client + disk |
| On 429, the client **re-launched** the orchestrator with a model override | second `invoke_subagent` call carries `"Model":"flash"`; the first call has **no** `Model` field | OBSERVED — disk |
| The relaunch created a **new conversation** | the second id differs from the first; both `brain/<id>/scratch/` directories exist and are **empty** | OBSERVED — disk |
| When the orchestrator stayed unavailable, the sentinel **completed the work inline** | paragraph 3 states it, and `hello.txt` exists with the requested content | OBSERVED — client + disk |
| No orchestrator turn produced content | both dispatched conversations have an empty `scratch/` and no `.agents/` tree — only `.system_generated/` message and transcript stubs (570-byte transcripts) | OBSERVED — disk |

### 1.4 The dispatch calls, structurally

Read from the parent conversation's message store (structure only; prompt text is the command's own task line, already quoted above):

| Call | `TypeName` | `Role` | `Model` | Child conversation |
|---|---|---|---|---|
| 1 | `teamwork` | `Teamwork Orchestrator` | *(absent)* | `dbeb883c…` |
| 2 | `teamwork` | `Teamwork Orchestrator` | `flash` | `62c78193…` |

[OBSERVED — disk] Two details matter and should not be smoothed over:

- The dispatched **type is `teamwork`**, not `teamwork_orchestrator`, and the role label is **"Teamwork Orchestrator"**, which is not the sentinel prompt's vocabulary ("Project Orchestrator", `prompts/sentinel-routing.md:326`). The observed call is therefore the command's **entry dispatch** — the top-level print-mode turn handing off to a `teamwork`-typed agent — not a route dispatch. Inferring that the General route was chosen would be wrong: no route decision was ever emitted.
- The `Model` field appears **in the tool call**, not in config. That is the live counterpart of the static model-tier material in [`06-config-gates-and-model-tiers.md`](06-config-gates-and-model-tiers.md): `teamwork.RootAgentWithDefaultTier` (34,566,022), the `MODEL_TIER_*` enum (116,298,796), `TeamworkDefaultsToFlash` (33,572,314) and `disable-teamwork-forced-flash-model` (107,270,651) describe a *forced* or *default* flash policy; this run shows an **explicit per-dispatch override** chosen after a quota failure. Whether that override is the sentinel's judgement, a retry policy in the client, or a default that the first call happened to omit is `UNKNOWN`; that the mechanism exists and is exercised at dispatch time is [OBSERVED — disk].

### 1.5 What the live run does **not** show

- **No interviewer turn.** `[skip-interview]` was passed intact in the dispatch prompt, but the orchestrator never produced a turn, so whether the token is honoured — or parsed at all — remains `UNKNOWN`. The token's presence in the prompt is not evidence of its effect.
- **No routing, no per-role dispatch, no gate.** The child never ran, so `01`'s decision table, `04`'s DAGs, the worker/reviewer/challenger/auditor composition, `GATE_STATUS.md` evaluation and completion verification were not exercised.
- **No artifact write by a live orchestrator.** The workspace is empty of teamwork state, and both dispatcher scratch directories are empty. The artifact contract in §2–§6 comes from completed **prior** runs, not from this one.
- **No claim that the inline fallback is prompt-sanctioned.** The recovered prompt tells the sentinel to manage failures and, on a terminal non-victory stop, to relay the status plainly and **never report project completion** (`prompts/sentinel-routing.md:670-676`); it contains no instruction to do the work itself. The observed inline completion is therefore a **behaviour outside the recovered prompt text** — possibly deliberate client-side fallback, possibly the sentinel model's own choice. [OBSERVED behaviour; cause UNKNOWN]

### 1.6 Second live run (2026-11-22): a lean native swarm

Same binary, same `--print` channel (`-p=`), same `[skip-interview]` token, new empty workspace.

| Item | Value | Label |
|---|---|---|
| Command | `agy -p='/teamwork-preview [skip-interview] Create fizzbuzz.js … Keep it small and cheap: a quick single self-contained change.' --dangerously-skip-permissions --print-timeout 1450s` (task text elided at `…`) | OBSERVED — client |
| Workspace | `/tmp/opencode/agy-run2`, empty at start | OBSERVED — disk |
| Exit code | `0` | OBSERVED — client |
| Wall-clock | ~4 minutes | OBSERVED — disk mtimes |
| Product | `fizzbuzz.js` (210 B) and `test.js` (713 B); `node test.js` exited `0` | OBSERVED — disk |
| Teamwork artifacts in the workspace | **none** — no `.agents/`, no `ORIGINAL_REQUEST.md`, no `plan.md`, no `progress.md` | OBSERVED — disk |
| Teamwork state in app data | **none** — no `brain/<any-conversation>/scratch/.agents/teamwork/` created by this run | OBSERVED — disk |
| Native-swarm state | `~/.gemini/antigravity-cli/brain/0e3db35c-47d2-4faf-98e6-a2a842cd4fc2/.system_generated/swarm/` with `swarm.json`, `plan.json`, `members.json`, `board.jsonl` | OBSERVED — disk |

Output text, verbatim (paragraph 2 is elided at `…`; every quoted word is the model's, including the `fuzzbuzz` spelling):

```text
I have started a lean swarm (`coder` + `monitor`) to create [fizzbuzz.js](file:///tmp/opencode/agy-run2/fizzbuzz.js) and [test.js](file:///tmp/opencode/agy-run2/test.js) and run the test suite. I will report back as soon as `coder` posts the result.

[fizzbuzz.js] and [test.js] have been created and verified: … `node test.js` exited `0` with `All fuzzbuzz tests passed!`
```

[OBSERVED — client] What the state directory shows:

| Fact | Value | Label |
|---|---|---|
| `swarm.json` | `{"version":1,"backend":"local","swarm_id":"0e3db35c-47d2-4faf-98e6-a2a842cd4fc2","created_at":"2026-11-22T00:30:52Z"}` | OBSERVED — disk |
| `plan.json` | `goal.title` "Create and test FizzBuzz in JavaScript"; one task, `coder`; one thread `t-fizzbuzz` whose `tasks` is `["coder"]` | OBSERVED — disk |
| `members.json` title | `FizzBuzz module and test suite` | OBSERVED — disk |
| Members | `coordinator` (role `coordinator`, `wake_mode:"mentions"`), `coder` (role `worker`, `wake_mode:"working"`), `monitor` (role `worker`, `wake_mode:"mentions"`) | OBSERVED — disk |
| Model, all three | `desired_model` / `applied_model` / `model` all `gemini-4-argon-medium` | OBSERVED — disk |
| Coder on completion | `desired_state:"KILLED"`, `phase:"KILLED"`, `killed:true`, while `wake_mode` stays `working` | OBSERVED — disk |
| Board | four lines, `seq` 1–4: coordinator assigns file ownership (`kind:"brief"`), coordinator briefs the monitor (`kind:"brief"`), coder posts `@coordinator [done] …`, coordinator posts `[done] …`; every line carries a distinct `request_id` | OBSERVED — disk |
| Monitor activity | briefed but never posted — no stall occurred | OBSERVED — disk |

The shape of the swarm is `coordinator` + `coder` + `monitor`; the coordinator's **own conversation is the swarm id**. It delegated one self-contained change to one worker, and the monitor existed only as a watchdog. The board, member schema and swarm-directory contract are documented from the source and this capture in [`09-swarm-board-and-skills.md`](09-swarm-board-and-skills.md) §2.4, §3.5 and §4.

**The coordinator killed the coder on completion.** After the coder's `[done]` post (`board.jsonl` seq 3), `members.json` records the coder with `desired_state:"KILLED"`, `phase:"KILLED"`, `killed:true`. The call that produced that transition was not captured in this document; whether it was an explicit `swarm{action:"kill"}`, an automatic cleanup, or part of turn teardown is `UNKNOWN`. The final answer is the coordinator's summary (seq 4), not the coder's.

### 1.7 Two runs, one command: the divergence

The two live runs are the most important pair in this set because they share the entry conditions — same binary, same print-mode channel, same bracket token, both on an empty workspace — and produced different subsystems.

| Dimension | Run 1 (2026-11-21) | Run 2 (2026-11-22) |
|---|---|---|
| Entry channel | `-p=` print mode | `-p=` print mode |
| Bracket token | `[skip-interview]` | `[skip-interview]` |
| What the command dispatched | a `teamwork`-typed conversation labelled **"Teamwork Orchestrator"** (`invoke_subagent`) | a **native swarm**: coordinator + coder + monitor, which the client calls a "lean swarm" |
| Where state landed | empty `brain/<conv>/scratch/` for two orchestrator conversations; no `.agents/` tree | `brain/<coordinatorConv>/.system_generated/swarm/{swarm.json,plan.json,members.json,board.jsonl}` |
| `.agents/teamwork/` artifacts | none (orchestrator never ran) | **none** (the swarm does not use them) |
| Coordination medium | parent → child dispatch (never exercised) | `board.jsonl` posts and `@`-mentions; `members.json` carries park cursors (`wake_mode`, `wait_since`) |
| Terminal state | two orchestrators quota-blocked; sentinel completed inline | coder completed; coordinator killed it and summarised |
| Workspace result | `hello.txt`, 5 B | `fizzbuzz.js` 210 B, `test.js` 713 B; tests exit `0` |

**The divergence is real and the cause is `UNKNOWN`.** Both runs used `--print` and `[skip-interview]`; both targeted an empty workspace; both exited `0`. The token therefore does **not** select the teamwork path, and the entry point does **not** imply it. The remaining differences between the invocations are the task text, the timeout (`880s` vs `1450s`), the date, and the workspace path — none of which is a demonstrated cause. Whether the CLI picks teamwork vs native swarm by task shape, by an enabled plugin/skill (`enable-native-swarm`), by model output, by quota/availability at dispatch time, or nondeterministically, this record cannot say. [OBSERVED — both runs; cause UNKNOWN]

Two things must not be inferred from this pair:

- **Not** that `/teamwork-preview` *is* native swarm. One invocation of the command left a swarm directory; another dispatched a teamwork orchestrator. Both are outcomes of the same command on the same binary.
- **Not** that native swarm is now the default or the fallback. Two observations cannot establish a default; `07` §3.5 and this section record an existence proof for each path, nothing about their frequencies.

The `/teamwork-preview` ↔ native-swarm question in [`09`](09-swarm-board-and-skills.md) §11 therefore moves from "no runtime evidence" to "one observed instance, mechanism unexplained". The artifact contract in §2–§6 is untouched: it describes the teamwork path, which run 2 did not take.

---

## 2. Where the artifacts actually live

### 2.1 The path pattern

```text
~/.gemini/antigravity-cli/brain/<conversation-id>/scratch/.agents/teamwork/
```

`~/.gemini/antigravity-cli` is the CLI's app-data directory (`07` §2). The recovered prompt makes this location explicit: entry roots use `<appDataDir>/scratch/teamwork/<run_id>/.agents/teamwork/`, and the fallback when that is unavailable is **`<appDataDir>/brain/<conversation-id>/scratch/`** (`prompts/sentinel-routing.md:191-202`). Every state root found on disk is the fallback form. [OBSERVED — source for the rule; OBSERVED — disk for the shape]

Two root variants were observed, both under `scratch/`:

| Root form | What sat in it | Label |
|---|---|---|
| `brain/<conv>/scratch/.agents/teamwork/` | the full vocabulary: `ORIGINAL_REQUEST.md`, `PROJECT.md`, per-agent folders, `GATE_STATUS.md`, `SCOPE.md` | OBSERVED — disk |
| `brain/<conv>/scratch/teamwork_carryover/` | shared `PROJECT.md` + `ORIGINAL_REQUEST.md` + `M<N>_SCOPE.md` + handoffs for a resumed multi-milestone effort | OBSERVED — disk (one instance) |

The carryover form matters only because it shows the state root is a **convention**, not a fixed path: the same document kinds can be placed in a parent-supplied folder. Do not treat `teamwork_carryover` as a tenth artifact kind.

### 2.2 Scale of the sample

Discovery commands, re-runnable:

```sh
# state roots
find ~/.gemini/antigravity-cli/brain -type d -path '*scratch/.agents/teamwork'

# artifact vocabulary and counts
find ~/.gemini/antigravity-cli/brain -path '*teamwork*' -type f -printf '%f\n' | sort | uniq -c | sort -rn

# per-agent directory names
find ~/.gemini/antigravity-cli/brain -type d -path '*scratch/.agents/teamwork/*' -printf '%f\n' | sort -u
```

| Measure | Value | Label |
|---|---:|---|
| `.agents/teamwork/` state roots | **39** | OBSERVED — disk |
| Per-agent subdirectories under those roots | **51** | OBSERVED — disk |
| Non-markdown files inside the roots | 2 (project artefacts, not state documents) | OBSERVED — disk |

Artifact counts across the 39 roots — **the vocabulary, not a closed schema**:

| File | Count | Where it sits |
|---|---:|---|
| `BRIEFING.md` | 50 | one per agent folder |
| `progress.md` | 48 | one per agent folder |
| `DISPATCH.md` | 48 | one per agent folder |
| `handoff.md` | 41 | one per agent folder, written at the end |
| `SCOPE.md` | 5 | per-milestone, in the sub-orchestrator folder |
| `GATE_STATUS.md` | 3 | per-milestone, in the sub-orchestrator folder |
| `prompt_draft.md` | 2 | in the `interviewer/` folder |
| `PROJECT.md` | 2 (+1 carryover) | run root / `orchestrator_r<N>/` / carryover |
| `ORIGINAL_REQUEST.md` | 2 (+1 carryover) | run root |

The counts are not a census of one run: 50 briefings across 39 roots means several roots contain multiple agent folders, and there is one fewer briefing than agent folder — the sample does not show which folder omits it. Sizes vary widely — `BRIEFING.md` 1.6–7.1 KB, `handoff.md` 4.8–36.5 KB, `progress.md` 0.1–2.0 KB, `GATE_STATUS.md` 1.0–1.9 KB — which fits "one live document per agent" rather than a fixed template dump.

### 2.3 The negative result

The run's workspace contained **no** `.agents/teamwork/`, **no** `ORIGINAL_REQUEST.md`, **no** `plan.md` and **no** `progress.md`. [OBSERVED — disk]

This is not an accident of the quota failure. The dispatch text itself is explicit, and the same rule appears twice in the sampled completed run — in the dispatched agent's `DISPATCH.md` and in its `BRIEFING.md` `Key Constraints`:

```text
Metadata & State Folder Rule:
- NEVER create `.agents/teamwork/` inside `<project-dir>`.
- Write your `progress.md` and `handoff.md` ONLY inside your own conversation scratch folder
  `<appDataDir>/brain/<conversation-id>/scratch/.agents/teamwork/<agent-folder>/`.
```

[OBSERVED — disk; project path redacted] The prompt's own `File Workspace Convention` says the same thing in general terms: keep code and work products in the working directory and **Teamwork state** in the per-run state folder, "never in the working directory" (`prompts/sentinel-routing.md:181-202`). So the absence of artifacts in `/tmp/opencode/agy-lab` is the **specified** behaviour, not evidence that artifacts are not written at all.

Run 2 (§1.6) is an independent second instance, and a stronger one because it did **not** fail on quota: an empty workspace, a completed task, exit `0`, and still **no** `.agents/teamwork/` in the workspace and **no** `.agents/teamwork/` tree in app data. The only coordination state it left was a native-swarm directory. So the negative workspace result is a property of the teamwork path, not an artefact of the quota failure — and the swarm path produces a different root entirely, which §2.1's pattern does not cover.

---

## 3. The nine artifact kinds: producer, consumer, content

Each row is a contract observed on disk. "Producer" and "consumer" are read from the document's own `Read FIRST` lists, its identity block, and the gate file's `Source` column; where the sample does not show a reader, the row says `UNKNOWN` rather than guessing.

| # | Artifact | Written by | Read by | What it contains | Shape observed |
|---|---|---|---|---|---|
| 1 | `ORIGINAL_REQUEST.md` | the **sentinel/orchestrator**, once, before the chosen agent starts (the prompt requires this: `prompts/sentinel-routing.md:263-288`; literals in `05` §6) | every dispatched agent — each `DISPATCH.md` lists it under `Read FIRST`; auditors read the integrity mode from it | the routed request as recorded: `# Original User Request`, `## Initial Request — <UTC>`, working directory and integrity mode, `## Context & Reference Material`, numbered `## Requirements` (R1…Rn), `## Verification Resources`, `## Acceptance Criteria` | 3.7–10.5 KB; no `## Parameters` block in either sampled run (both were not bracket-launched, or the block was not emitted — `UNKNOWN`) |
| 2 | `prompt_draft.md` | the **interviewer**, during prompt crafting | the **sentinel**, as the draft it approves and routes on | the proposed task prompt: the one-paragraph task statement, `Working directory:`, `Integrity mode:`, then context, numbered requirements, verification resources and acceptance criteria | 6.2–9.5 KB; nearly the same body as `ORIGINAL_REQUEST.md`, without the recording frame — consistent with the docs' "prompt artifact" (`10` row 19/20 context) |
| 3 | `PROJECT.md` | the **project orchestrator** (found at the run root and in `orchestrator_r<N>/`) | sub-orchestrators and workers; cited for write ownership | project-level plan: `# Project: …`, `## Architecture`, `## Feature Inventory`, `## Milestones`, `## Interface Contracts` | 7.0–9.6 KB; the docs' "project plan artifact" half (`10` §2.4) |
| 4 | `SCOPE.md` | the **sub-orchestrator** for its milestone (lives in `sub_orch_m<N>/`) | the workers/reviewers/challengers dispatched for that milestone — `DISPATCH.md` lists it under `Read FIRST` | milestone scope: `# Scope: Milestone <N> — <slug>`, `## Architecture`, `## Feature Inventory`, `## Milestones`, `## Interface Contracts` per component | 2.3–3.5 KB; 5 instances across 3 milestones |
| 5 | `DISPATCH.md` | the **parent agent** (orchestrator/sub-orchestrator/sentinel) — not the agent that owns the folder | the **agent that owns the folder**, as its instruction sheet | timestamped sections (`## <UTC>`), each with role, the `DO NOT CHEAT` integrity warning, a `Read FIRST` path list (`ORIGINAL_REQUEST.md`, `PROJECT.md`, `SCOPE.md`, upstream handoffs), the state-folder rule, and task-specific constraints | 0.6–4.9 KB; 2 of 48 files have more than one timestamped section, i.e. **append-only re-dispatch** on the same agent folder |
| 6 | `BRIEFING.md` | the **agent itself**, at start and on significant state change | the agent itself after context loss; the **sentinel's Cron 1** reads the active orchestrator's copy plus subagents' progress (`prompts/sentinel-routing.md:328-334`) | `# BRIEFING — <UTC>`, `## Mission`, `## 🔒 My Identity` (archetype, roles, working dir, state folder, parent conversation, milestone), `## 🔒 Key Constraints`, `## Current Parent`, `## Task Summary`, `## Change Tracker`, `## Key Decisions Made`, `## Artifact Index` | 1.6–7.1 KB; the 🔒 sections are the append-only part (`prompts/sentinel-routing.md:115-124`) |
| 7 | `progress.md` | the **agent**, appended during work | the **parent** and the sentinel's Cron 1 (change detection beyond `Last visited`) | `# Progress Log — M<N> (<slug>) <role>`, `Last visited: <UTC>`, `Status: …`, then the step log | 0.1–2.0 KB; timestamp discipline is a stated rule in every dispatch |
| 8 | `handoff.md` | the **agent**, at the end of its turn | the **parent** (aggregation) and the **gate file's `Source` column**; later agents read upstream handoffs via `Read FIRST` | role-specific title, then the 5-part protocol: `## 1. Observation`, `## 2. Logic Chain`, `## 3. Caveats`, `## 4. Conclusion`, `## 5. Verification Method`; auditor/reviewer handoffs add their own phase tables above it | 4.8–36.5 KB; **the largest artifact kind** in the sample |
| 9 | `GATE_STATUS.md` | the **(sub-)orchestrator** at a milestone gate; lives beside its `SCOPE.md` | the parent orchestrator and the user | one table per iteration (`\| Agent \| Role \| Verdict \| Source \|`) plus a final `Gate Result:` line stating the rule | 1.0–1.9 KB; 3 instances, 1 iteration each — see §5 |

**What is missing from the sample.** The prompt's state-file list also names `DEAD_ENDS.md`, `TEST_INFRA.md`, `TEST_READY.md`, `plan.md` and `context.md` (`prompts/sentinel-routing.md:188-190`, `:219`; `10` §2.4). **None of the five appeared** in the 39 roots. That is `OBSERVED` absence in this sample, not proof they are never written: they may be route-specific (LEMMA, SWE, Document Review), written only on failure, or renamed in practice. Treat the nine kinds above as the observed vocabulary and the rest as `UNKNOWN`.

---

## 4. The naming convention

The prompt states it directly (`prompts/sentinel-routing.md:298-310`):

```text
.agents/teamwork/<type>_<milestone/round>[_<N>][_gen<N>]/
```

| Segment | Meaning (prompt text) | Observed on disk |
|---|---|---|
| `<type>` | the agent type: `teamwork_explorer` / `worker` / `reviewer` / `challenger` / `sub_orch`, etc. | `teamwork_worker`, `teamwork_reviewer`, `teamwork_challenger`, `teamwork_auditor`, `teamwork_explorer`; **orchestrator-level roles are bare**: `orchestrator_r1`, `sub_orch_m1`, `interviewer` |
| `_m<N>` | milestone number | `_m1`, `_m2`, `_m3` |
| `_r<R>` | round | `_r1` present on every agent in one sampled run; **absent** in another run's folders (`teamwork_reviewer_m1_1`) — so the `r` segment is conditional, exactly as the `[_…]` brackets imply |
| `_<N>` | **parallel instance** (`prompts/sentinel-routing.md:308`) | `teamwork_reviewer_m1_r1_1` / `_2`, `teamwork_challenger_m1_r1_1` / `_2`, `teamwork_explorer_m1_r1_1`…`_3` — the suffix distinguishes **sibling agents of the same type, milestone and round**, not retries |
| `_gen<N>` | successor generation | not observed in this sample (`UNKNOWN`) |

Two refinements the prompt does not state, both observed:

1. **The disambiguator is a slot, not strictly a number.** Besides `_1`/`_2`/`_3`, folders appear as `teamwork_worker_m2_cleanup`, `teamwork_worker_m1_commit`, `teamwork_explorer_m1_tests`, `teamwork_explorer_m1_parser`, `teamwork_explorer_survey_1`…`_3` and `teamwork_explorer_m2_1`…`_3`. Read `_<N>` as "short label that makes the folder unique" — parallel index usually, purpose label sometimes. [OBSERVED — disk]
2. **`teamwork_explorer_*` and `teamwork_auditor_*` appear in the same folder scheme** as the worker/reviewer/challenger set, so the convention covers every dispatched registry type, not only the gate participants. [OBSERVED — disk]

Consequence for a reimplementation: the folder name is the agent's **identity on disk**, and the gate and `DISPATCH.md` both reference it. A reader resolving `teamwork_reviewer_m1_r1_2/handoff.md` can tell type, milestone, round and sibling index without opening the file. Do not invent a different key.

---

## 5. The gate, as observed

### 5.1 Composition

The three sampled `GATE_STATUS.md` files — two milestones of one project, one milestone of another — all carry the **same six rows**:

| Row | `Role` (runtime type) | Verdict values seen |
|---|---|---|
| `worker_<N>` | `teamwork_worker` | `DONE (…)` |
| `reviewer_<N>_1` | `teamwork_reviewer` | `APPROVE (…)`, `APPROVE` |
| `reviewer_<N>_2` | `teamwork_reviewer` | `APPROVE` |
| `challenger_<N>_1` | `teamwork_challenger` | `APPROVE / CONFIRMED`, `CONFIRMED (…)` |
| `challenger_<N>_2` | `teamwork_challenger` | `APPROVE / CONFIRMED`, `CONFIRMED (…)` |
| `auditor_<N>` | `teamwork_auditor` | `CLEAN` |

So the sampled gate is **1 worker + 2 reviewers + 2 challengers + 1 auditor**, and the final line is a strict AND over those verdicts plus an independent test/audit result. [OBSERVED — disk]

**Whether this composition is fixed is `UNKNOWN`.** All three samples come from the same route family (a General-style implementation milestone) and the corpus' per-route DAGs (`04`) plus the 49-entry registry (`02`) contain many more reviewer/challenger types. A LEMMA, Document Review or SWE gate could compose differently. The honest statement is: *the observed composition is six agents with the 2+2 redundancy pattern; the rule that produces it was not recovered.*

### 5.2 Redacted template

Reproduced for **shape**, with the user's project data replaced by placeholders. Keep the structural text; substitute your own values.

```markdown
# Milestone <N> (`<milestone>`) Gate Status

## Gate — Iteration <i>
| Agent | Role | Verdict | Source |
|---|---|---|---|
| worker_<N> (`<conv>`) | teamwork_worker | DONE (`<commit>`, `<test-cmd>` fails=0, `<audit-cmd>` <a>%, `<red-proof>` fails=<k>) | `/…/brain/<conv-worker>/scratch/.agents/teamwork/teamwork_worker_m<N>_r<R>/handoff.md` |
| reviewer_<N>_1 (`<conv>`) | teamwork_reviewer | APPROVE (`<test-cmd>` fails=0, `<audit-cmd>` <a>%, clean git) | `/…/brain/<conv-reviewer-1>/…/teamwork_reviewer_m<N>_r<R>_1/handoff.md` |
| reviewer_<N>_2 (`<conv>`) | teamwork_reviewer | APPROVE | `/…/brain/<conv-reviewer-2>/…/teamwork_reviewer_m<N>_r<R>_2/handoff.md` |
| challenger_<N>_1 (`<conv>`) | teamwork_challenger | APPROVE / CONFIRMED (<k> isolated probes pass, <a>% coverage, no leaks) | `/…/brain/<conv-challenger-1>/…/teamwork_challenger_m<N>_r<R>_1/handoff.md` |
| challenger_<N>_2 (`<conv>`) | teamwork_challenger | APPROVE / CONFIRMED (<j>/<j> probes pass, `<test-cmd>` fails=0) | `/…/brain/<conv-challenger-2>/…/teamwork_challenger_m<N>_r<R>_2/handoff.md` |
| auditor_<N> (`<conv>`) | teamwork_auditor | CLEAN | `/…/brain/<conv-auditor>/…/teamwork_auditor_m<N>_r<R>/handoff.md` |

Gate Result: **PASS** (Auditor CLEAN + both Reviewers APPROVE + both Challengers CONFIRMED + independent `<test-cmd>` `fails=0` & `<audit-cmd>` `<a>%`)
```

Structural observations that survive redaction:

- **In the absolute-path samples, every `Source` resolves into a *different* `brain/<conversation-id>/` directory** — the worker's, each reviewer's, each challenger's, the auditor's. That is the clearest on-disk proof that **each agent runs in its own conversation**, not as a sub-turn of one conversation. [OBSERVED — disk]
- **The gate file lives in the sub-orchestrator's folder** (`sub_orch_m<N>/GATE_STATUS.md`), not at the run root: the milestone orchestrator authors it, and the parent reads it. [OBSERVED — disk]
- **Title and source forms vary.** Titles seen: `# Milestone <N> (<milestone-slug>) Gate Status` and `# Gate Status — Milestone M<N>`. `Source` is an absolute path in two samples and bare `handoff.md` in one (written from the sub-orchestrator's cwd). A reimplementation should accept relative sources rather than require absolute. [OBSERVED — disk]
- **Verdict text is free-form inside a parenthetical.** `DONE (…)`, `APPROVE (…)`, `CONFIRMED (…)` carry the evidence summary — commit id, test counts, coverage, probe counts. The gate rule is prose, not a schema. [OBSERVED — disk]
- One sample states its iteration bound as `Iteration <i> / <max>`; that bound is project policy and is **not** asserted here as a runtime constant. [OBSERVED — disk; value redacted]

---

## 6. Docs versus disk: which is authoritative?

The corpus and the binary use shorter names than the state tree does, and the difference is systematic:

| Source | What it says | Where |
|---|---|---|
| Public docs | a "project plan artifact" and a "progress artifact", plus an `ORIGINAL_REQUEST`-style record | `10` §1 rows 19–20, §2.4 |
| Prompt/binary | state files `BRIEFING.md` / `progress.md` / `DISPATCH.md` / `handoff.md`; `SCOPE.md` / `GATE_STATUS.md` / `DEAD_ENDS.md`; shared `PROJECT.md` / `TEST_INFRA.md` / `TEST_READY.md` / `ORIGINAL_REQUEST.md`; `plan.md`, `context.md` in the state tree | `prompts/sentinel-routing.md:186-191`, `:219`; `01` §7; `05` §6 |
| On disk | `ORIGINAL_REQUEST.md` **and** `PROJECT.md` (no `plan.md`); `progress.md`; `prompt_draft.md`; the nine kinds in §3 | §3 table; `OBSERVED — disk` |

Resolution, in three parts:

1. **The docs' "plan artifact" is a category, not a filename.** The binary's own mapping is split: project-level plan in `PROJECT.md`, milestone scope in `SCOPE.md`, and per-agent state in `BRIEFING.md`/`progress.md`. `plan.md` is an available literal (`10` §2.4) that this sample never used. **Authoritative for naming: the on-disk vocabulary** — it is what a run actually produces.
2. **The path prefix `.agents/teamwork/` is logical, not workspace-relative.** `05` §6 records the prompt's relocatable-root prose; this sample resolves it to `brain/<conv>/scratch/.agents/teamwork/`, and the dispatch text forbids writing it into the project. **Authoritative for location: the runtime root** (`<appDataDir>/brain/<conv>/scratch/…`); `05` §6's `.agents/teamwork/…` paths should be read as paths *inside that root*.
3. **The nine kinds are the observed floor, not a closed schema.** `DEAD_ENDS.md`, `TEST_INFRA.md`, `TEST_READY.md`, `plan.md`, `context.md`, `_gen<N>` folders and the segment/synthesis artifacts of `05` §6 did not appear at all. Neither source should be read as excluding them; the disk sample simply did not exercise those routes.

For anyone reconciling this corpus: cite the **structure and vocabulary** from this document, cite the **intent** from the prompt, and do not present a docs filename as an implemented one without a disk instance.

---

## 7. Privacy and provenance

- **These are the user's own prior runs.** The 39 state roots predate this document and were created by normal use of the CLI on this machine. They were read to recover structure, filenames, counts and one redacted gate template.
- **Only structure and vocabulary are recorded.** Project names, milestone slugs, file paths, commit ids, coverage percentages, test counts, probe counts and conversation ids are replaced with `<placeholders>` or omitted. The redacted gate template in §5.2 preserves the table shape, the runtime role names, the verdict vocabulary and the rule form; it does not preserve any project value.
- **No conversation transcript content is copied.** The dispatch and briefing evidence in §2.3 is quoted only for the **state-folder rule** (a template instruction), with the project path removed. The live-run paragraphs in §1.2 are this session's own CLI output, quoted because they are the observation.
- **Counts are of a sample, not of all runs.** 39 roots is what exists on this machine at this time; the CLI may create roots elsewhere on other installs or on other platforms. The pattern in §2.1 is corroborated by the recovered prompt text, which is what makes it generalisable beyond this machine.
- **No project artifact is redistributed.** The two non-markdown files found inside a state root are project products and were neither copied nor named here.
- **Run 2's swarm state is quoted because it is the observation.** `swarm.json`, `plan.json`, the member fields and the four board lines in §1.6 come from this corpus' own invocation of the CLI, not from a prior user run, and the task text in them is the small self-contained task that invocation was given. No unrelated project content, credentials or personal data appears in them.

---

## 8. Open questions this document does not settle

| Question | Why it is still open |
|---|---|
| Is the six-agent gate composition fixed? | All samples are one route family; no non-General gate was observed (§5.1) |
| Does `[skip-interview]` suppress the interview at runtime? | The token reached the dispatch prompt, but the interviewer never ran (§1.5) |
| Is the inline fallback a client policy or the sentinel's choice? | The recovered prompt neither mandates nor forbids it; no log line attributes the edit (§1.5) |
| Is `Model:"flash"` the sentinel's retry choice or a client default? | The override is visible in the tool call; the decision path is not (§1.4) |
| When are `DEAD_ENDS.md`, `TEST_INFRA.md`, `TEST_READY.md`, `plan.md`, `context.md` written? | Zero instances in 39 roots (§3) |
| What does `_gen<N>` mark? | No successor-generation folder occurred in the sample (§4) |
| Does the state root ever use the `<appDataDir>/scratch/teamwork/<run_id>/` form rather than the `brain/<conv>/scratch/` fallback? | Only the fallback form was found (§2.1) |
| Does a completed run write anything at all into the workspace? | All observed product files are project code/outputs; no teamwork state document appeared in a workspace in either run (§2.3, §1.6) |
| What selects native swarm over the teamwork path for one `/teamwork-preview` invocation? | Both runs used `--print` and `[skip-interview]` and diverged; no flag, task feature or log line is attributed (§1.7) |
| Is a worker killed on completion by an explicit call or by turn teardown? | `killed:true`, `phase:"KILLED"` observed after the coder's `[done]`; the call is not captured (§1.6) |
| Is `coordinator` + `coder` + `monitor` a standard lean composition? | One swarm only; no second composition or size observed (§1.6) |

A controlled run that completes one milestoned task on the cheapest route — long enough for a worker, two reviewers, two challengers and an auditor to hand off — would settle the gate-composition, fallback, override and workspace rows at once. Run 2 (§1.6) shows a cheap completed run can bypass the teamwork path altogether, so such a run must first select that path; how to force the choice is itself `UNKNOWN` (§1.7). It should be attempted only after quota is confirmed, as `07` §5 sequences it.

