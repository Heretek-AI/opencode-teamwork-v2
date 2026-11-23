# Runtime Artifacts — Live Dispatch and the On-Disk Teamwork Contract

**Status: OBSERVED — five live invocations (one quota-partial, one native swarm, one completed General teamwork run, two SWE Light runs — one interrupted, one completed with `VICTORY CONFIRMED`); second evidence class: the state tree of the user's own prior runs.** Recorded on **2026-11-21**, **2026-11-22** and **2026-11-23** against `agy --version` **1.5.14**, the same binary analysed throughout this corpus (`00-artifact-identity.md`; `07` §1 re-proves byte identity). The completed General run is recorded in full in [`12-live-general-run.md`](12-live-general-run.md) and both SWE Light runs in [`13-live-swe-light-run.md`](13-live-swe-light-run.md); this document uses them to correct the gate and state-root sections below. A 2026-11-15 completed prior run additionally supplies the interview-gate chain, analysed separately in [`14-interview-gate-observed.md`](14-interview-gate-observed.md). It does three things the rest of the set could not:

1. It records a **live `/teamwork-preview` print-mode run** that the client recognised, dispatched to a subagent, lost twice to HTTP 429 quota, and then completed **inline** — §1.1–§1.5.
2. It records a **second invocation of the same command** that started a lean **native swarm** instead — a `coordinator` + `coder` + `monitor` with a `board.jsonl`, no `.agents/teamwork/` anywhere — and it states the divergence between the two runs with the cause `UNKNOWN` — §1.6–§1.7.
3. It records the **artifact contract as it exists on disk**, recovered from state trees that already existed under the CLI's app-data directory — §2–§6. Those trees are the user's own prior teamwork runs, not a controlled experiment. Three live runs then wrote one of the two roots: the General run and SWE Light Run 1 used the **primary** shared `scratch/teamwork/<run-id>/`, with a four-row gate and no table respectively (`12`, `13` §1–§11); SWE Light Run 2 used `brain/<coordinator>/scratch/`, closed its loop and returned a prose `VICTORY CONFIRMED` (`13` §12). §2.1, §3, §5 and §8 are scoped to those observations.

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md), with one addition used only here: **OBSERVED — disk** means a file whose path, name and structure were read on this machine; **OBSERVED — client** means a string the CLI printed; **OBSERVED — source** means the shipped prompt text quoted at `file:line`. Nothing about the user's project content is reproduced: names, slugs, percentages, commit ids and conversation ids of prior runs are replaced with `<placeholders>`, and no conversation transcript is quoted. The General live run in `12` is this corpus' own invocation, so its ids and two-file fixture are quoted there with paths normalised. See §7.

The short version: **the teamwork artifacts are real, but they are not written into the user's workspace.** They live under the primary root `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` or the fallback `<appDataDir>/brain/<conversation-id>/scratch/.agents/teamwork/`, and the dispatch text explicitly forbids creating `.agents/teamwork/` in the project directory (§2, §6). **But the command does not always produce them:** a second invocation on the next day produced a native-swarm board instead (§1.6), so this contract describes one of at least two outcomes of `/teamwork-preview`, not the only one.

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
| After the first 429, a **new planner turn** re-dispatched with a model override | parent transcript: step 22 has **no** `Model`; step 26 is the 429; step 32 is a fresh `PLANNER_RESPONSE` whose thinking selects `flash` and whose call carries `"Model":"flash"` | OBSERVED — disk |
| The relaunch created a **new conversation** | the second id differs from the first; both `brain/<id>/scratch/` directories exist and are **empty** | OBSERVED — disk |
| When the orchestrator stayed unavailable, the sentinel **completed the work inline** | paragraph 3 states it, and `hello.txt` exists with the requested content | OBSERVED — client + disk |
| No orchestrator turn produced content | both dispatched conversations have an empty `scratch/` and no `.agents/` tree — only `.system_generated/` message and transcript stubs (570-byte transcripts) | OBSERVED — disk |

### 1.4 The dispatch calls, structurally

Read from the parent conversation's message store (structure only; prompt text is the command's own task line, already quoted above):

| Call | Parent `step_index` | `TypeName` | `Role` | `Model` | Child conversation |
|---|---|---|---|---|---|
| 1 | 22 | `teamwork` | `Teamwork Orchestrator` | *(absent)* | `dbeb883c…` |
| 2 | 32 | `teamwork` | `Teamwork Orchestrator` | `flash` | `62c78193…` |

[OBSERVED — disk] The 429 did not rewrite the first call. Step 26 is a `SYSTEM_MESSAGE` carrying `RESOURCE_EXHAUSTED (code 429) … Resets in 10m7s`; step 32 is then a **new `PLANNER_RESPONSE`** that reasons about the refusal and issues a fresh `invoke_subagent` with `Model:"flash"`. The decision line from that turn's `thinking`:

> Initial hypothesis: The "teamwork" model's quota exhaustion suggests a possible rate limit issue. Testing a different model ("flash") with the same "teamwork" type could bypass this limitation. If the "flash" model succeeds, this confirms the original quota constraint was the problem.

[OBSERVED — disk] The second dispatch was refused too: step 36 is the matching `SYSTEM_MESSAGE` (`Resets in 6m57s`), and step 40 is the planner's narration plus the inline file write (step 37 is the `write_file`). So the observed instance is a **model decision in a new planner turn**, not a deterministic client retry. [INFERRED from the response structure: the call is attributable to the planner turn that contains it.] Whether the shipped client has a retry/fallback policy that acts without a model turn is `UNKNOWN`; that is a static-RE question, not something these records answer.

Two details matter and should not be smoothed over:

- The dispatched **type is `teamwork`**, not `teamwork_orchestrator`, and the role label is **"Teamwork Orchestrator"**, which is not the sentinel prompt's vocabulary ("Project Orchestrator", `prompts/sentinel-routing.md:326`). The observed call is therefore the command's **entry dispatch** — the top-level print-mode turn handing off to a `teamwork`-typed agent — not a route dispatch. Inferring that the General route was chosen would be wrong: no route decision was ever emitted.
- The `Model` field appears **in a planner-authored tool call**, not in config. That is the live counterpart of the static model-tier material in [`06-config-gates-and-model-tiers.md`](06-config-gates-and-model-tiers.md): `teamwork.RootAgentWithDefaultTier` (34,566,022), the `MODEL_TIER_*` enum (116,298,796), `TeamworkDefaultsToFlash` (33,572,314) and `disable-teamwork-forced-flash-model` (107,270,651) describe a *forced* or *default* flash policy; this run shows an **explicit per-dispatch override** authored by the parent planner after a quota failure. [OBSERVED — disk] Whether the client has an automatic retry that could produce the same call is `UNKNOWN`; the first call's absent `Model` field is also not explained by this record.

### 1.5 What the live run does **not** show

- **No interviewer turn in this run.** `[skip-interview]` was passed intact in the dispatch prompt, but the orchestrator never produced a turn, so whether the token is honoured — or parsed at all — remains `UNKNOWN` for this run. The token's presence in the prompt is not evidence of its effect. A completed prior run's full interview chain is recorded in [`14-interview-gate-observed.md`](14-interview-gate-observed.md).
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
~/.gemini/antigravity-cli/scratch/teamwork/<run-id>/.agents/teamwork/   # primary
~/.gemini/antigravity-cli/brain/<conversation-id>/scratch/.agents/teamwork/   # fallback
```

`~/.gemini/antigravity-cli` is the CLI's app-data directory (`07` §2). The recovered prompt makes this location explicit: entry roots use `<appDataDir>/scratch/teamwork/<run_id>/.agents/teamwork/`, and the fallback when that is unavailable is **`<appDataDir>/brain/<conversation-id>/scratch/`** (`prompts/sentinel-routing.md:191-202`). The 39-root `brain` discovery sample below used the fallback form; the 2026-11-15 multi-milestone and General runs used the **primary** form, while the completed SWE Light Run 2 used the `brain/<coordinator>/scratch/` form. Both root variants are observed on completed runs. [OBSERVED — source for the rule; OBSERVED — disk for both shapes (`12` §6, `13` §12.7)]

Three root forms have been observed, all under `scratch/`:

| Root form | What sat in it | Label |
|---|---|---|
| `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` | the shared root of a completed run: `ORIGINAL_REQUEST.md`, `PROJECT.md`, per-agent folders, `GATE_STATUS.md`; 31 files / 160 KB in the General run, 55 files / 360 KB in the 2026-11-15 run, 7 files / 28 KB in SWE Light Run 1 | OBSERVED — disk (`12` §6; `13` §6; 2026-11-15 run) |
| `brain/<conv>/scratch/.agents/teamwork/` | the 39-root sample's full vocabulary — and the root of the completed SWE Light Run 2 (`13` §12.7): `ORIGINAL_REQUEST.md`, sentinel/SWE briefings and handoffs, one `teamwork_swe_1/` folder, and three empty per-agent folders plus an auditor handoff in the auditor's own brain scratch | OBSERVED — disk |
| `brain/<conv>/scratch/teamwork_carryover/` | shared `PROJECT.md` + `ORIGINAL_REQUEST.md` + `M<N>_SCOPE.md` + handoffs for a resumed multi-milestone effort | OBSERVED — disk (one instance) |

The carryover form matters only because it shows the state root is a **convention**, not a fixed path: the same document kinds can be placed in a parent-supplied folder. Do not treat `teamwork_carryover` as a tenth artifact kind.

The primary form is **shared by every agent**: `<state>` is a single tree whose subfolders (`sentinel/`, `orchestrator/`, `teamwork_<role>_m<N>/`) hold agent state, and each `DISPATCH.md` names the shared root. The fallback form can instead be **per conversation** — one `brain/<conv>/scratch/.agents/teamwork/` per dispatched agent — which is why the prior sample's gate `Source` paths resolve into different `brain/<conversation-id>/` directories. So the root **topology** differs between the two observations, not merely the location. [OBSERVED — `12` §6; `11` §5.2]

### 2.1.1 The per-agent `write_file` sandbox

The completed SWE Light Run 2 used `brain/<coordinator>/scratch/.agents/teamwork/` as the **run root**, but its `teamwork_implementer_r1/`, `teamwork_reviewer_r2/` and `teamwork_victory_auditor_1/` subfolders are **empty**. The auditor's own Caveats explains why:

> `write_file` enforces writing only within this agent's own artifact directory (`<appDataDir>/brain/<auditor>`), so state files (`DISPATCH.md`, `BRIEFING.md`, `progress.md`, `handoff.md`) were written to `<appDataDir>/brain/<auditor>/scratch/` rather than the parent-referenced `<state>/teamwork_victory_auditor_1`.

[OBSERVED — `13` §12.7]

The SWE orchestrator records the same consequence: subagents' writes targeting the parent's scratch are sandbox-restricted, so they deliver full reports via `send_message`; the auditor writes its `handoff.md` in its own brain scratch. This means:

| Observation | Interpretation | Label |
|---|---|---|
| Empty per-agent folder | not proof that the agent did nothing; its state may be in its own brain artifact directory | OBSERVED — Run 2 |
| No per-agent `handoff.md` under the run root | the handoff may live at `<appDataDir>/brain/<agent>/scratch/handoff.md` | OBSERVED — auditor |
| Reports via `send_message` | the parent can complete a round without a file in the run root | OBSERVED — implementer/reviewer |

[OBSERVED for Run 2; `INFERRED` for Run 1, which has the same empty folders but did not record the explanation]

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

The counts are not a census of one run: 50 briefings across 39 roots means several roots contain multiple agent folders, and there is one fewer briefing than agent folder — the sample does not show which folder omits it. The runs read in detail are not included in the 39/51 counts: the 2026-11-22 General run contributes a 31-file tree (`12` §6), the 2026-11-15 run a 55-file tree, and the two SWE Light runs 7-file trees each (`13` §6, §12.7). The `scratch/teamwork` roots are outside the `brain` find above; the SWE Light Run 2 root is a separate `brain` tree created after the 39-root sample. Sizes vary widely — `BRIEFING.md` 1.6–7.1 KB, `handoff.md` 4.3–36.5 KB, `progress.md` 0.1–2.0 KB, `GATE_STATUS.md` 1.0–1.9 KB — which fits "one live document per agent" rather than a fixed template dump.

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
| 1 | `ORIGINAL_REQUEST.md` | the **sentinel/orchestrator**, once, before the chosen agent starts (the prompt requires this: `prompts/sentinel-routing.md:263-288`; literals in `05` §6) | every dispatched agent — each `DISPATCH.md` lists it under `Read FIRST`; auditors read the integrity mode from it | the routed request as recorded: `# Original User Request`, an optional `## Parameters` block for bracket-led requests, `## Initial Request — <UTC>`, working directory and integrity mode, `## Context & Reference Material`, numbered `## Requirements` (R1…Rn), `## Verification Resources`, `## Acceptance Criteria` | 267 B–10.5 KB. The 2026-11-22 General run shows the bracket form: `## Parameters` / `[skip-interview]` / `How this run was launched; not part of the task.` before `## Initial Request` (`12` §2.2). The earlier prior-run samples had no `## Parameters` block; that absence is not evidence that the format omits it, since the block is present only when the request began with a recognised bracket |
| 2 | `prompt_draft.md` | the **interviewer**, during prompt crafting | the **sentinel**, as the draft it approves and routes on | the proposed task prompt: the one-paragraph task statement, `Working directory:`, `Integrity mode:`, then context, numbered requirements, verification resources and acceptance criteria | 6.2–9.5 KB; nearly the same body as `ORIGINAL_REQUEST.md`, without the recording frame — consistent with the docs' "prompt artifact" (`10` row 19/20 context) |
| 3 | `PROJECT.md` | the **project orchestrator** (found at the run root and in `orchestrator_r<N>/`) | sub-orchestrators and workers; cited for write ownership | project-level plan: `# Project: …`, `## Architecture`, `## Feature Inventory`, `## Milestones`, `## Interface Contracts` | 7.0–9.6 KB; the docs' "project plan artifact" half (`10` §2.4) |
| 4 | `SCOPE.md` | the **sub-orchestrator** for its milestone (lives in `sub_orch_m<N>/`) | the workers/reviewers/challengers dispatched for that milestone — `DISPATCH.md` lists it under `Read FIRST` | milestone scope: `# Scope: Milestone <N> — <slug>`, `## Architecture`, `## Feature Inventory`, `## Milestones`, `## Interface Contracts` per component | 2.3–3.5 KB; 5 instances across 3 milestones |
| 5 | `DISPATCH.md` | the **parent agent** (orchestrator/sub-orchestrator/sentinel) — not the agent that owns the folder | the **agent that owns the folder**, as its instruction sheet | timestamped sections (`## <UTC>`), each with role, the `DO NOT CHEAT` integrity warning, a `Read FIRST` path list (`ORIGINAL_REQUEST.md`, `PROJECT.md`, `SCOPE.md`, upstream handoffs), the state-folder rule, and task-specific constraints | 0.6–4.9 KB; 2 of 48 files have more than one timestamped section, i.e. **append-only re-dispatch** on the same agent folder |
| 6 | `BRIEFING.md` | the **agent itself**, at start and on significant state change | the agent itself after context loss; the **sentinel's Cron 1** reads the active orchestrator's copy plus subagents' progress (`prompts/sentinel-routing.md:328-334`) | `# BRIEFING — <UTC>`, `## Mission`, `## 🔒 My Identity` (archetype, roles, working dir, state folder, parent conversation, milestone), `## 🔒 Key Constraints`, `## Current Parent`, `## Task Summary`, `## Change Tracker`, `## Key Decisions Made`, `## Artifact Index` | 1.6–7.1 KB; the 🔒 sections are the append-only part (`prompts/sentinel-routing.md:115-124`) |
| 7 | `progress.md` | the **agent**, appended during work | the **parent** and the sentinel's Cron 1 (change detection beyond `Last visited`) | `# Progress Log — M<N> (<slug>) <role>`, `Last visited: <UTC>`, `Status: …`, then the step log | 0.1–2.0 KB; timestamp discipline is a stated rule in every dispatch |
| 8 | `handoff.md` | the **agent**, at the end of its turn | the **parent** (aggregation) and the **gate file's `Source` column**; later agents read upstream handoffs via `Read FIRST` | role-specific title, then the 5-part protocol: `## 1. Observation`, `## 2. Logic Chain`, `## 3. Caveats`, `## 4. Conclusion`, `## 5. Verification Method`; auditor/reviewer handoffs add their own phase tables above it | 4.3–36.5 KB; **the largest artifact kind** in the sample. In the 2026-11-22 General run every gate agent and both explorers use the five headings; the reviewer inserts `Quality Review Report` and `Adversarial Challenge Report` between Logic Chain and Caveats, while the auditor prefixes a `Forensic Audit Report` (`12` §7). The SWE Light runs qualify this: Run 1 wrote no handoffs (implementer/reviewer reported by `send_message`); Run 2 wrote sentinel, `teamwork_swe_1` and auditor handoffs, while implementer/reviewer folders remained empty due to the `write_file` sandbox (`13` §12.7-§12.8). So handoffs are role- and sandbox-dependent, not universal |
| 9 | `GATE_STATUS.md` | the **project orchestrator** for a single cycle (`orchestrator/GATE_STATUS.md`) or the **sub-orchestrator** for a milestone gate (`sub_orch_m<N>/GATE_STATUS.md`); **SWE Light writes none** — its gate is the sequential verifier loop in both observed runs (`13` §4-§5, §12) | the parent orchestrator and the user | one table per iteration (`\| Agent \| Role \| Verdict \| Source \|`) plus a final `Gate Result:` line stating the rule | 1.0–1.9 KB; 4 instances, 1 iteration each; absent in both SWE Light runs — see §5 |

### 3.1 Two testing-track files, from a completed prior run

The prompt's state-file list also names `TEST_INFRA.md` and `TEST_READY.md`. Both are now observed on disk in the **2026-11-15 completed run** (the primary root `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/`; the run's interview chain is in [`14-interview-gate-observed.md`](14-interview-gate-observed.md)). The producer is the **project orchestrator**, not a worker:

| Artifact | Producer (observed write) | Consumer | Content and shape | Evidence |
|---|---|---|---|---|
| `TEST_INFRA.md` | project orchestrator, after the survey and before implementation; transcript step 87, mtime `21:41:39` | the orchestrator and the verification wave; it indexes the E2E testing track | `# E2E Test Infra: <project>`; `## Test Philosophy`; a `## Feature Inventory & Test Coverage` table with Requirement / Tier 1–4 columns; `## Test Architecture` naming the runner, audit and launch commands and the pass/fail rule | OBSERVED — disk + transcript (1,685 B) |
| `TEST_READY.md` | project orchestrator, after the verification wave and before the victory audit; transcript step 211, mtime `22:06:53` | the orchestrator, the victory auditor and the caller | `# E2E Test Suite Ready`; `## Test Runner` (canonical targets); `## Coverage Summary` (tier counts); `## Feature Checklist` (per-feature PASS rows) | OBSERVED — disk + transcript (2,669 B) |

Both are written at the **run root**, beside `ORIGINAL_REQUEST.md` and `PROJECT.md`, not inside an agent folder. The same 2026-11-15 run also dispatched `TypeName:"teamwork_spec_miner"` agents in its survey phase (`Workspace & Target Spec Miner`, `Gameplay & Data Spec Miner`), each with its own `DISPATCH.md`, `BRIEFING.md`, `progress.md` and `handoff.md`; **spec-miner is a role, not a tenth state document.** [OBSERVED — disk]

The 2026-11-18 multi-milestone root independently has `TEST_INFRA.md` (12,870 B, mtime `10:05:26`) but **no `TEST_READY.md`**; the two files are therefore phase- and run-dependent, not a guaranteed pair. [OBSERVED — disk]

**What is still missing from the sample.** `DEAD_ENDS.md`, `plan.md` and `context.md` did not appear in any sampled root, including the two roots above. That is `OBSERVED` absence in this sample, not proof they are never written: they may be route-specific (LEMMA, SWE, Document Review), written only on failure, or renamed in practice. Treat the nine kinds above plus the two testing-track files as the observed vocabulary and the remaining three as `UNKNOWN`.

---

## 4. The naming convention

The prompt states it directly (`prompts/sentinel-routing.md:298-310`):

```text
.agents/teamwork/<type>_<milestone/round>[_<N>][_gen<N>]/
```

These are folder names **inside the shared state root**; the folder is not itself a conversation-scoped tree. In the 2026-11-22 General run, every agent folder sits under the one `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` root, and the folder name is the agent's identity for both the gate `Source` and the dispatch (`12` §6). [OBSERVED — disk]

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

Four `GATE_STATUS.md` files are compared: the 2026-11-22 General live run, the 2026-11-15 multi-milestone run, and two further milestone gates from the 39-root sample. Their compositions are **not the same**:

| Sample | Rows | Composition | Verdict values seen |
|---|---:|---|---|
| General live run, single cycle (`12` §5) | **4** | 1 worker + **1 reviewer** + **1 challenger** + 1 auditor | `DONE`, `APPROVE`, `PASS`, `CLEAN` |
| 2026-11-15 multi-milestone run (3 milestones) | **6** | 1 worker + **2 reviewers** + **2 challengers** + 1 auditor | `DONE`, `APPROVE`, `CONFIRMED`/`APPROVE`, `CLEAN` |
| Two further prior milestones | **6** | same 2+2+1 pattern | `DONE`, `APPROVE`, `CONFIRMED`, `CLEAN` |

The six-row form is:

| Row | `Role` (runtime type) | Verdict values seen |
|---|---|---|
| `worker_<N>` | `teamwork_worker` | `DONE (…)` |
| `reviewer_<N>_1` | `teamwork_reviewer` | `APPROVE (…)`, `APPROVE` |
| `reviewer_<N>_2` | `teamwork_reviewer` | `APPROVE` |
| `challenger_<N>_1` | `teamwork_challenger` | `APPROVE / CONFIRMED`, `CONFIRMED (…)` |
| `challenger_<N>_2` | `teamwork_challenger` | `APPROVE / CONFIRMED`, `CONFIRMED (…)` |
| `auditor_<N>` | `teamwork_auditor` | `CLEAN` |

The **minimum observed composition** is the four-row General form: worker + one reviewer + one challenger + one auditor. The **larger observed composition** doubles the reviewer and challenger rows for a multi-milestone effort. Both close with a strict AND over their verdicts plus an independent test/audit result. [OBSERVED — disk]

**The composition is variable, not fixed.** It scales with scope/iteration: the single-cycle run used the minimum independent set, and the multi-milestone run used 2+2+1. This is the correct conclusion to carry into a reimplementation: **do not encode six rows as the gate**. Encode the rule shape and the *minimum* independent roles, and allow redundancy to grow with milestone scope. One route family and four samples cannot establish the composition for LEMMA, Document Review, SWE Light or a tournament gate; those remain `UNKNOWN`. [OBSERVED for the two compositions; `INFERRED` for the scaling relationship; universality `UNKNOWN`]

### 5.2 Redacted template

Reproduced for **shape**, with the user's project data replaced by placeholders. This is the **six-row multi-milestone form**; the General single-cycle form in `12` §5 omits `reviewer_<N>_2` and `challenger_<N>_2`, leaving four rows. Keep the structural text; substitute your own values.

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
- **The gate's author and location depend on the level.** A single-cycle General run writes `orchestrator/GATE_STATUS.md` — the project orchestrator authors it. A milestone gate in the 39-root sample lives in the **sub-orchestrator's** folder (`sub_orch_m<N>/GATE_STATUS.md`), beside its `SCOPE.md`; the sub-orchestrator authors it and the parent reads it. The 2026-11-15 multi-milestone run also wrote `orchestrator/GATE_STATUS.md`, so location is not a reliable proxy for scope. [OBSERVED — disk (`12` §5; prior samples)]
- **Title and source forms vary.** Titles seen: `## Gate — Iteration <i>` (the single-cycle run, no top-level heading), `# Milestone <N> (<milestone-slug>) Gate Status` and `# Gate Status — Milestone M<N>`. `Source` is an absolute path in the single-cycle run and two prior samples, and bare `handoff.md` in one (written from the sub-orchestrator's cwd). A reimplementation should accept relative sources rather than require absolute. [OBSERVED — disk]
- **Verdict text is free-form inside a parenthetical.** `DONE (…)`, `APPROVE (…)`, `CONFIRMED (…)` carry the evidence summary — commit id, test counts, coverage, probe counts. The gate rule is prose, not a schema. [OBSERVED — disk]
- One sample states its iteration bound as `Iteration <i> / <max>`; that bound is project policy and is **not** asserted here as a runtime constant. [OBSERVED — disk; value redacted]

### 5.3 SWE Light: no table, a loop gate, prose verdict

Neither SWE Light run wrote a `GATE_STATUS.md`. Run 1 (2026-11-22) wrote no `PROJECT.md` and no agent handoffs and was killed by a server restart; Run 2 (2026-11-23) wrote sentinel/SWE handoffs and completed with a prose `VICTORY CONFIRMED`. The gate in both is the **sequential loop** stated in `teamwork_swe_1/BRIEFING.md`:

```text
teamwork_implementer -> teamwork_reviewer
(repeat until 0 issues, 0 edits, empty open-issues ledger,
 and own node --test verification passes, then teamwork_victory_auditor)
```

| Fact | General (`12`) | SWE Light Run 1 (`13` §1-§11) | SWE Light Run 2 (`13` §12) | Label |
|---|---|---|---|---|
| Gate file | `orchestrator/GATE_STATUS.md` | **none** | **none** | OBSERVED |
| Gate mechanism | independent reviewer + challenger + auditor, ANDed | sequential implementer → reviewer | same loop, closed at 0 issues / 0 edits / empty ledger | OBSERVED |
| Ledger | none | `progress.md`, two Round 1 entries | `progress.md`, empty | OBSERVED |
| Victory audit | after gate PASS | not reached | 3-phase audit, **`VICTORY CONFIRMED`** | OBSERVED |
| Verdict artifact | `Gate Result:` row table | none | prose in briefings/handoffs; **no JSON** | OBSERVED |
| Terminal state | timeout after PASS | server restart mid-loop | exit 0 | OBSERVED |
| Root | shared `scratch/teamwork/<run-id>` | shared `scratch/teamwork/<run-id>` | `brain/<coordinator>/scratch` | OBSERVED |

Run 2's verdict is prose: the sentinel briefing records `Verdict: VICTORY CONFIRMED`, the sentinel and SWE `handoff.md` each state it, and the auditor's own `handoff.md` states it. There is no `verify/victory.json` or other structured verdict file. [OBSERVED — `13` §12.6]

**Do not describe the gate as "the six-row template" or even "the four-row template".** General and SWE Light use different verification mechanisms, and SWE Light's completion record is a handoff, not a table. The portable shape is *a route-specific verification contract with an explicit completion rule*; the row table is one implementation of that contract, not the contract itself. [OBSERVED for the three runs; the generalisation is `INFERRED`]

The SWE Light samples also show that the **absence** of a gate file is not evidence of a run failure by itself: the route never intended to write one. Run 1 failed because the server restarted mid-loop; Run 2 completed with prose evidence. [OBSERVED]

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
- **The 2026-11-22 General run and both 2026-11-22/23 SWE Light runs are this corpus' own invocations.** Their conversation ids, gate evidence, `## Parameters` blocks and handoff/loop headings are quoted in [`12`](12-live-general-run.md) and [`13`](13-live-swe-light-run.md) because they are the observations; absolute home and workspace paths are normalised there, and the bundles under `live/2026-11-22-general/`, `live/2026-11-22-swe-light/` and `live/2026-11-22-swe-light-complete/` reproduce only the cited state documents. No unrelated project content is present in the fixtures (all are two-file `hello` examples).
- **Counts are of a sample, not of all runs.** 39 roots is what existed on this machine before the 2026-11-22 run; the CLI may create roots elsewhere on other installs or on other platforms. The patterns in §2.1 are corroborated by the recovered prompt text and by the live run, which is what makes them generalisable beyond this machine.
- **No project artifact is redistributed.** The two non-markdown files found inside a state root are project products and were neither copied nor named here.
- **Run 2's swarm state is quoted because it is the observation.** `swarm.json`, `plan.json`, the member fields and the four board lines in §1.6 come from this corpus' own invocation of the CLI, not from a prior user run, and the task text in them is the small self-contained task that invocation was given. No unrelated project content, credentials or personal data appears in them.

---

## 8. Open questions this document does not settle

| Question | Why it is still open |
|---|---|
| Is the six-agent gate composition fixed? | **ANSWERED — no, with a caveat.** A General single-cycle run used four rows (1 worker + 1 reviewer + 1 challenger + 1 auditor); the multi-milestone sample used six (2 reviewers + 2 challengers). Composition is variable and scales with scope/iteration. The caveat: SWE Light uses a different mechanism (`13`), and other non-General routes (LEMMA, Document Review) remain `UNKNOWN`; only General-family samples support the 4-vs-6 row comparison (§5.1, `12` §5). |
| Does SWE Light write a gate table? | **ANSWERED — no.** Neither the interrupted run nor the completed run wrote a `GATE_STATUS.md`. The gate is the implementer→reviewer loop plus an empty open-issues ledger; the completed run then passed a 3-phase victory audit and recorded `VICTORY CONFIRMED` in prose, not in a gate file (`13` §4-§6, §12; §5.3 below). |
| Does `[skip-interview]` suppress the interview at runtime? | The 2026-11-22 run records the token in `## Parameters`, runs no interviewer and creates no `interviewer/` folder; the token-to-causality link is `INFERRED`, not logged (`12` §2.2, §6) |
| Is the inline fallback a client policy or the sentinel's choice? | The recovered prompt neither mandates nor forbids it; no log line attributes the edit (§1.5) |
| Is `Model:"flash"` the sentinel's retry choice or a client default? | **ANSWERED for the observed instance — a new planner turn chose it.** Step 32 is a fresh `PLANNER_RESPONSE` containing both the reasoning and the `"Model":"flash"` call, after step 26's 429. It is not evidence of a deterministic client retry; whether such a retry policy exists is `UNKNOWN` and static-RE only (§1.4) |
| When are `DEAD_ENDS.md`, `TEST_INFRA.md`, `TEST_READY.md`, `plan.md`, `context.md` written? | **PARTLY ANSWERED.** `TEST_INFRA.md` and `TEST_READY.md` are observed in the 2026-11-15 completed prior run, written by the project orchestrator at the testing-track setup and test-ready phases; `TEST_INFRA.md` is also present in a 2026-11-18 multi-milestone root. `DEAD_ENDS.md`, `plan.md` and `context.md` remain unobserved in every root sampled (§3) |
| What does `_gen<N>` mark? | No successor-generation folder occurred in the sample (§4) |
| Does the state root ever use the `<appDataDir>/scratch/teamwork/<run_id>/` form rather than the `brain/<conv>/scratch/` fallback? | **ANSWERED — both occur.** The primary form is observed in the 2026-11-15 prior run, the 2026-11-22 General run and SWE Light Run 1; the `brain/<conv>/scratch/` fallback is observed in the 39-root sample and SWE Light Run 2 (§2.1, `12` §6, `13` §6, §12.7) |
| Does a completed run write anything at all into the workspace? | All observed product files are project code/outputs; no teamwork state document appeared in a workspace in either run (§2.3, §1.6) |
| What selects native swarm over the teamwork path for one `/teamwork-preview` invocation? | Both runs used `--print` and `[skip-interview]` and diverged; no flag, task feature or log line is attributed (§1.7) |
| Is a worker killed on completion by an explicit call or by turn teardown? | `killed:true`, `phase:"KILLED"` observed after the coder's `[done]`; the call is not captured (§1.6) |
| Is `coordinator` + `coder` + `monitor` a standard lean composition? | One swarm only; no second composition or size observed (§1.6) |

The 2026-11-22 General run (`12`) and the two SWE Light runs (`13` §1–§11 and §12) settle most of these rows at once: both root forms, the bracket block, a four-row General gate, a no-table SWE Light loop, a prose `VICTORY CONFIRMED`, and cron firing. They do **not** settle the LEMMA/Document Review rows, the General run's victory verdict (cut by timeout), or whether the native-swarm path competes with teamwork. A follow-up Document Review or LEMMA run is the next route discriminator, and how to force a path choice remains `UNKNOWN` (§1.7).

