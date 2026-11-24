# `/teamwork` — Observable Command Contract

**Scope.** This document states the externally observable contract of Antigravity's `/teamwork` slash command: how it is invoked, what it requires before it starts work, which execution routes it offers and what triggers each, how the route decision is ordered, which actions the sentinel agent is forbidden to take, which files the run is obliged to write, and how completion is verified and reported. Everything here is derived from static evidence in the extracted Linux CLI binary `antigravity` (SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`, 273,240,776 bytes) — embedded prompt strings, embedded description strings, and machine code that compares the command name. The binary was never executed for this document. All offsets are **decimal file offsets** into that binary. Verbatim prompt text is not duplicated here: the recovered sentinel prompt is reproduced in [`prompts/sentinel-routing.md`](prompts/sentinel-routing.md), which this document references by section heading.

**Confidence legend:** `OBSERVED` — directly read from the artifact (byte string present at a cited offset, or machine-code bytes). `INFERRED` — reasoned from stated observed premises. `UNKNOWN` — not measured; written as unknown rather than guessed. Confidence definitions follow [`PROVENANCE.md`](PROVENANCE.md).

**Version scope.** Every offset in this document is a **1.5.14** offset (the static axis). The live CLI is now **1.5.16** (SHA-256 `05245f43…430934e785`); **1.5.15** (`7b004d26…41fa2d`) is the historical live axis that produced the 2026-11-23 gate runs. The recovered sentinel prompt is byte-identical across all three, but its slice start moved 113,241,709 → 113,300,479 → 113,868,721, so no static offset resolves unchanged on a later build. See [`PROVENANCE.md`](PROVENANCE.md) *version axes*.

**Evidence classes.** Three distinct classes of evidence are used, and they do not have equal force:

1. **Machine code** (e.g. the `teamwork` immediates at 174,580,885) — the only class that proves the CLI itself acts on a token.
2. **Embedded prompt text** (the sentinel block at 113,241,709 + 36,482 bytes, ending 113,278,190; 1-based, as in [`prompts/sentinel-routing.md`](prompts/sentinel-routing.md)) — proves what the product *instructs its agent to do*, not what code enforces. Routing, recording and completion-verification rules below are instructions to a model; a run can deviate from them, and no code path was found that validates compliance.
3. **Embedded UI strings** (the description at 107,480,810) — proves user-visible copy, not its control flow.

"Programmed behaviour" in this document therefore means "the behaviour the shipped artifact specifies", stated with the class of evidence that specifies it.

**Naming note.** The shipped command identifier is the literal `teamwork-preview` (file offsets 106,155,303 and 116,708,666), with the description string `Preview the multi-agent teamwork workflow.` and the admin-control gate `TeamworkPreviewCommandDisabled`. `/teamwork` is the shorthand used throughout this corpus, and the separate 8-byte `teamwork` token that also exists in the binary is that identifier minus its suffix. `06-config-gates-and-model-tiers.md` carries the full derivation. [OBSERVED for the two literals and the description; INFERRED that the two name forms denote the same command]

**Version scope of the identifier.** The literal above is **1.5.14**. Both `/teamwork` and `/teamwork-preview` reached the subsystem on that build, but on **1.5.16** a zero-token probe shows `/teamwork` expanding client-side and `/teamwork-preview` not expanding at all. The live trigger on the current axis is therefore `/teamwork`; this note's stored-literal claim is not withdrawn, only version-scoped. See [`20-live-swarm-repeats.md`](20-live-swarm-repeats.md) §2 and §5. [OBSERVED — probe; the exact build of the change is `UNKNOWN`]

---

## 1. Invocation surface

| Attribute | Value | Confidence | Evidence |
|---|---|---|---|
| Command token | `teamwork` | OBSERVED (literal) / INFERRED (it is the command name) | The 8-byte literal appears three times as `movabs r13, 0x6b726f776d616574` immediates in one code region, at file offsets 174,580,885, 174,581,082, 174,581,141 (all inside `.text`, which spans 120,213,504–191,473,711). Observed: the bytes. Inferred: that a code path loading and comparing this literal is command-name dispatch. |
| Slash form | `/teamwork` | INFERRED | No standalone `/teamwork` string exists in the binary — every `/teamwork` byte match is a path component of `.../builtin/teamwork/...`. The `/` prefix is therefore supplied by the command surface, not stored as part of the name. The prompt itself refers to "the slash command" as an existing thing at offset 113,261,986. |
| Description string | `Preview the multi-agent teamwork workflow.` | OBSERVED | Byte-identical at offset 107,480,810, inside `.rodata` (section spans 105,026,432–120,188,895 per `readelf -SW`). |
| Description storage form | String constant fused with its neighbours; no length prefix or delimiter separates it from the following description string `Show pinned hierarchy panels for a symbol.` | OBSERVED (fusion) / INFERRED (that it is a description table) | The description reads out as two sentences with no separator at 107,480,810; it sits in a run of short imperative description strings. Exact per-string boundaries are therefore inferred, not delimited in the artifact. |
| Registry mechanism (how the surface enumerates the command and binds this description to it) | **unknown** | UNKNOWN | Not disassembled. Adjacent observed evidence only: the Go package metadata region around offset 34,565,473 contains `.../builtin/teamwork/teamwork.init`, `teamwork.AllAgents`, `teamwork.RootAgentWithDefaultTier`, and `teamwork.indexByName`, i.e. the package registers an agent set indexed by name. How that set is surfaced as a slash command, and how the description at 107,480,810 is linked to the token at 174,580,885, is not evidenced. |
| Argument syntax | Free-form request text follows the command. One bracketed parameter is recognised, and it must sit immediately after the command. No flags, subcommands, `--` options, or positional grammar are evidenced anywhere in the recovered text. | OBSERVED (bracket parameter and its position) / UNKNOWN (everything else) | `# Request Parameters` at 113,260,269 defines "a request may begin with one bracket"; the interview notice at 113,261,986 places it "right after the slash command, if using one". Whether any non-bracket argument parsing exists is **unknown**; settling it requires disassembling the command handler reached from the code that loads the `teamwork` literal at 174,580,885. |

**Summary of the surface.** `[OBSERVED — each fragment cited above]` The user issues a slash command whose token is `teamwork`, described as "Preview the multi-agent teamwork workflow.", and supplies the actual task as free-form text. A single optional leading parameter, `[skip-interview]`, may precede that text directly after the command. `[UNKNOWN]` How the CLI enumerates the command, and how it binds the description string, is not established.

### 1.1 Availability and integrity modes

Three user-facing attributes qualify the command. The documentation page supplies them; the binary was then searched for each, and the results are stated per row.

| Attribute | Value | Confidence | Evidence |
|---|---|---|---|
| Plan availability | `/teamwork` is available on **paid plans** only. The docs comparison table also lists Plan tier "Paid plans" for Teamwork, against "All plans" for `/subagents` and `/swarm`. | `DOCS` | `https://antigravity.google/docs/teamwork/`, *Plan availability* line and *When to use /teamwork* table. `[UNKNOWN]` whether a plan check is what drives the shipped gate: the binary carries a remote on/off feature control (`TeamworkPreviewCommandDisabled`, `MultiagentControls`), not a billing check — §2 and §8. |
| Integrity modes | Three modes, selected by a behavioural questionnaire about which shortcuts the team must **not** take: `development` (default) flags only fabricated outputs and facade implementations, and permits reuse, libraries and frameworks; `demo` additionally forbids copying core logic from open source, delegating core work to external tools, and reading test source to reverse-engineer expected behaviour; `benchmark` requires a fully independent from-scratch implementation using the language standard library only. All four shortcuts ruled out ⇒ `benchmark`. | `DOCS` + `OBSERVED` | Docs *Integrity modes* table. The mechanism is also compiled in, in two halves: the authoring questionnaire at `## Step 3: Integrity mode` @ 112,230,526 (options `(a)`–`(e)` at 112,230,846–112,231,124; mapping "(e) alone … gives `development` … all of (a) to (d) gives `benchmark`" @ 112,231,652–112,231,715; the "from scratch" floor @ 112,231,872), and the enforcement rules at `### Integrity Enforcement Levels` @ 112,966,504 with `### 2-Phase Investigation Architecture` @ 112,968,073. The auditor reads the mode from `ORIGINAL_REQUEST.md` directly rather than from the orchestrator @ 112,968,482. See `10-official-docs-cross-check.md` §2.1. |
| Mode recording | The mode is written into the prompt artifact as the line `Integrity mode: [development \| demo \| benchmark]`. | `OBSERVED` | Step 9 template @ 112,235,817; forbidden items are written beneath it as `The team must NOT: <…>` @ 112,235,895. The docs say "recorded in the prompt artifact"; the binary confirms both the line and the approval handoff (see §2). |
| Default project directory | A new project defaults to `~/teamwork_projects/{PROJECT_NAME}` per the docs; the binary states `~/teamwork_projects/<project_name>` (lowercase, underscores) and emits `Working directory: <path>`. For work on existing files the directory is the files' current location and the user is not asked. | `DOCS` + `OBSERVED` | Docs Phase 1 step 5 and *Safety* section; binary `## Step 8: Working directory` @ 112,235,267, literal `teamwork_projects` @ 112,235,431. |

**Correction to earlier drafts of this corpus.** Integrity modes, the `~/teamwork_projects/` default, the successor handoff, and the three named artifacts were absent from `00`–`08` and were initially treated as documentation-only. Direct searches of the binary (`10` §2) confirmed all four; the only inferred step is the mapping of the docs' "project plan artifact" onto `plan.md` / `PROJECT.md`. The `DOCS`-only residue for this section is the paid-plan requirement; everything else has artifact evidence. `[OBSERVED for the offsets cited; INFERRED that the authoring and enforcement halves are one design, since the mode names and rule sets match one-to-one]`

---

## 2. Preconditions

The command does not begin execution on receipt. It runs an interview first unless explicitly told otherwise.

| Precondition | Behaviour | Confidence | Evidence |
|---|---|---|---|
| Task interview (default) | Before routing, the sentinel must dispatch **only** `teamwork_interviewer`. | OBSERVED | Sentinel `## Workflow Protocol` step 1 at 113,276,251, verbatim: "Follow the Task Interview section first: until you route, dispatch only the teamwork_interviewer." Task Interview section at 113,261,255. |
| Interview notice | The user is told, verbatim, that the run "is being prepared" and will start once they approve the task prompt. | OBSERVED | 113,261,658. |
| Interview dispatch payload | Fixed four-field prompt: `Teamwork state folder:`, `Relay to:`, `Parameters:`, `Request (verbatim):` with `<<<REQUEST … REQUEST>>>` delimiters. | OBSERVED | 113,262,735 / 113,262,847 / 113,262,931, with the template following. |
| No timer on the interview | "Set no timer for the interview: without an approved prompt, the run does not start." The run waits indefinitely for user input. | OBSERVED | 113,264,815. |
| Approved-prompt handoff | The run routes on the first approved prompt that reaches it, supplied either as a message whose first line is `Approved task prompt:` or between `BEGIN PROMPT` / `END PROMPT` markers. Later copies are ignored. | OBSERVED | `Approved task prompt:` at 113,263,893. |
| Interviewer teardown | The interviewer is killed once the run routes. | OBSERVED | 113,265,411 ("…once you route."). |
| `[skip-interview]` parameter | Skips the interview: the request is routed on as received. This is the only parameter the parameter table lists. | OBSERVED | `skip-interview` table row at 113,261,163; table introduction at 113,260,269. |
| Bracket parsing rules | Only the **first** bracket counts, and only if it holds at least one listed name. A bracket holding none (e.g. `[WIP]`) is part of the request. Unlisted names inside a counting bracket are reported as ignored, then execution continues. The bracket is stripped before routing or dispatch but preserved verbatim on record. Only the first request carries parameters. | OBSERVED | 113,260,269 onwards; recording interaction at 113,277,002. |
| Start acknowledgement | After the first dispatch — and only after any pre-flight audit has let the run start — the user is sent, once, "Your Teamwork run has started—execution is now under way." | OBSERVED | 113,264,707. |
| Admin / feature gating | Gating identifiers exist in the binary: `TeamworkPreviewCommandDisabled`, the admin-controls response type `FetchAdminControlsResponse_FeatureControls_MultiagentControls`, and the toggle strings `enable-teamwork-subagent`, `disable-teamwork-forced-flash-model`, `teamworkDisabled`. **Whether, where, and how these disable the command is unknown.** | OBSERVED (existence) / UNKNOWN (enforcement) | `TeamworkPreviewCommandDisabled` at 204,669,341 (also 30,308,654 / 34,011,276 / 206,785,570 / 212,954,391); `MultiagentControls` at 30,306,835; `enable-teamwork-subagent` at 223,052,805; `disable-teamwork-forced-flash-model` at 223,052,618; `teamworkDisabled` at 34,055,633. Enforcement path deferred to the planned `06-config-gates-and-model-tiers.md`. |

---

## 3. Route set

Six routes are declared in the `### Route Summary` table at 113,265,667. The pre-flight audit column is part of the same table (header `Pre-flight audit` at 113,265,703), and its semantics are given in the sentinel's job list at 113,242,112.

| Route | Trigger signals | Downstream agent | Pre-flight audit | Cost characteristics | Opt-in | Confidence | Evidence |
|---|---|---|---|---|---|---|---|
| **Document Review** | A document is supplied (attachment, path or URL) **and** the deliverable is an assessment of it — a critique, not a solution. Checked before Math / Proof because a mathematics paper trips every math signal. | `teamwork_document` | **Required** (`teamwork_dependency`) | Not characterised in the text | No — triggered by the request shape | OBSERVED (trigger, agent, audit); UNKNOWN (cost) | Route at 113,266,610; summary row at 113,265,667 |
| **Formal Math / Lean 4 (LEMMA)** | The user **explicitly** asks for a result to be proved or checked in Lean 4. Lean syntax or a `.lean` file alone is **not** sufficient. Requires user-installed `leap-tools` and a Lean setup; the route stops before any work when they are missing. | `teamwork_lean` | **Required** (`teamwork_dependency`) | High setup cost; hard-gated on user-installed tooling | **Yes** — explicit Lean 4 request required | OBSERVED (trigger, agent, audit, gate); INFERRED (cost) | Route at 113,267,369; `leap-tools` at 113,268,283 |
| **Math / Proof (Large Team)** | A math/proof task **and** an explicit request for an extremely large team or very many agents. | `teamwork_proof` | None | **Expensive** — explicitly "expensive and strictly opt-in" | **Yes** — explicit large-team request required | OBSERVED | Route at 113,268,594 |
| **Math / Proof** | Natural-language mathematical problem solving, informal proofs or claims — without a large-team request and without formal Lean 4. | `teamwork_pipeline` | None | Default math pipeline cost | No | OBSERVED (trigger, agent); INFERRED (cost) | Route at 113,269,010 |
| **SWE Light** | **Both**: one self-contained code change (bug fix, small feature, contained refactor) **and** an explicit lightness signal ("just fix this bug", "quick fix", "keep it cheap", "don't spin up a big team"). Runs a collapsed team — one implementer then adversarial review rounds — and **cannot decompose**. | `teamwork_swe` | None | **Cheap** by construction — collapsed team, no decomposition, stated as such | **Yes** — explicit lightness signal required | OBSERVED (trigger, agent, shape); INFERRED (cost ranking) | Route at 113,269,431 |
| **General** | Everything else — SWE, refactoring, research, ops. The default when in doubt, and the destination for Lean-flavoured requests that did not explicitly ask for Lean 4. | `teamwork_orchestrator` | None | Default orchestrator cost | No | OBSERVED (trigger, agent); INFERRED (cost) | Route at 113,270,283 |

**Agent roster note.** `[OBSERVED, 108,451,228]` The entry-point sentinel's own role description names its dispatch targets as `teamwork_orchestrator`, `teamwork_swe`, `teamwork_document`, `teamwork_lean`, `teamwork_proof`, `teamwork_dependency` and `teamwork_pipeline`, plus `teamwork_interviewer` for the interview. `[INFERRED]` `teamwork_dependency` is not a seventh route: it is the pre-flight auditor that runs before the Document Review and LEMMA routes, as the `### Route Summary` pre-flight column and the sentinel job list at 113,242,139–113,242,293 show.

**Docs cross-reference.** The official *Execution paths* table lists only **five** paths — General (Distributed coding), Iterative coding, Document Review, Math / Proof, and Math / Proof (Large Team) — and omits the LEMMA route entirely; it also calls the binary's SWE Light path "Iterative coding". This document keeps the **six**-route taxonomy because that is what the shipped `### Route Summary` declares, and the divergence is recorded, with the docs' naming mapped to the registry, in [`10-official-docs-cross-check.md`](10-official-docs-cross-check.md) §3.2. `[OBSERVED for the six-route table; DOCS for the five-path table]`

**Pre-flight audit semantics** `[OBSERVED, 113,242,112–113,243,024]`. When the chosen route requires it, `teamwork_dependency` is dispatched first, naming the route and every file, folder and URL the request names. The audit is **BLOCKING**; the sentinel waits for one of three verdicts:

- `READY` — start the agent, passing the audit's READY report as written, and again on every restart.
- `MISSING` — relay the auditor's final notice verbatim and **stop**. The sentinel must never install anything itself; on a user install request it re-dispatches `teamwork_dependency` (an explicit exception to the no-reuse rule) and re-reads the verdict.
- `OUTAGE` — relay diagnostics and stop.

---

## 4. Decision procedure

`OBSERVED` — `## Decision Process` at 113,270,345. The check order and the if/else chain are quoted from that section.

1. **Read** the user's request carefully.
2. **Check** the request for each route signal, in this fixed order:
   1. A supplied document that is to be reviewed.
   2. Formal math / Lean 4, and if so, whether the user explicitly asks for the result to be proved or checked in Lean 4.
   3. Math or proofs (natural language), and if so, whether the user explicitly asks for a very large team or many agents.
   4. One self-contained code change that the user explicitly asked to be handled small, quick, cheap or focused.
3. **Route** by the ordered chain:
   1. Supplied document to be reviewed → **Document Review**.
   2. Else formal math / Lean 4 signal **and** explicit Lean 4 request → **Formal Math / Lean 4 (LEMMA)**.
   3. Else formal math / Lean 4 signal → **General** *(not Math / Proof)*.
   4. Else math/proof **and** explicit large-team request → **Math / Proof (Large Team)**.
   5. Else math/proof signal → **Math / Proof**.
   6. Else single self-contained change **and** explicit lightness signal → **SWE Light**.
   7. Otherwise → **General**.
4. **Spawn** the chosen agent directly.
5. **Record** the routing decision and rationale in `BRIEFING.md` (offset 113,271,547).

The chain is a total function: every request lands on exactly one route, and General is the catch-all. `[INFERRED — follows from the explicit final "Otherwise →" branch at 113,270,345]`

---

## 5. Anti-pattern rules

`OBSERVED` — `## Anti-Patterns` at 113,271,563, running to the `## Route Completion Verification` heading at 113,273,475.

- **Do not deliberate endlessly.** Routing should take seconds, not minutes; when in doubt, choose General.
- **Do not split one request across paths.** Pick one route. If the request spans domains, route on the **primary** intent.
- **Do not route Lean 4 formalization or `.lean` proof files to Math / Proof.** The Math / Proof agent is strictly for natural-language reasoning and does not compile or verify Lean code. Formal math goes to LEMMA when explicitly requested, and to General otherwise.
- **Do not route to LEMMA just because Lean code appears.** The route needs user-installed tooling and stops without it; the user must ask for the Lean 4 proof or check.
- **Do not route to Math / Proof (Large Team) without an explicit large-team request.** A hard problem alone is not enough; the large-team path is expensive and strictly opt-in.
- **Do not send a supplied paper to Math / Proof merely because it contains mathematics.** Ask what the user gets back: a critique, or an answer.
- **Do not route to Document Review without a document.** "Review my design" with nothing attached is General.
- **Do not route to SWE Light just because a task sounds small.** The user must ask for it. Because SWE Light cannot decompose, sending a multi-part project there is called out as a *worse* failure than running a small task on the General path; sizing the task oneself is described as exactly the judgement this route forbids.
- **Do not re-route mid-execution.** Once routed, the downstream agent owns the task. On failure, restart with the same or an alternate path.

---

## 6. Recording obligations

`OBSERVED` — sentinel `## Workflow Protocol` step 2 at 113,276,573, plus `## Workflow Protocol` step 3 at 113,277,330 and `# User Request Recording` at 113,252,809.

| Obligation | Rule | Confidence | Evidence |
|---|---|---|---|
| Canonical request file | `.agents/teamwork/ORIGINAL_REQUEST.md` — explicitly **not** the workspace root. This exact path is the one handed to any auditor that checks the work against the request. | OBSERVED | 113,276,573 |
| Write timing | Exactly once, **before** the chosen agent starts. Nothing is recorded earlier. | OBSERVED | 113,276,573 |
| Excluded content | "never the request an approved prompt started from" — the pre-approval request text is not recorded. | OBSERVED | 113,276,573 |
| Parameter block | If the request began with a counting bracket, it is written once, **as received**, under the file's title and above the first entry, in its own section: a `## Parameters` heading, then the bracket, then the line `How this run was launched; not part of the task.` | OBSERVED | `## Parameters` literal at 113,276,951; `How this run was launched` at 113,277,002 |
| Entry headings | The text routed on keeps its own entry heading, separate from the parameter section. | OBSERVED | 113,276,573 |
| Later messages | Each later message from the user or parent agent, and any later approved prompt other than the routed text, is appended. | OBSERVED | 113,276,573 |
| Timestamps | UTC. Duplicate content already held by the last entry is skipped. | OBSERVED | 113,276,573 |
| Fallback rules | "Otherwise follow User Request Recording": append-only, verbatim, never edit or summarise prior entries; skip continuations, acknowledgements and approvals; dispatched in-run agents treat a parent's `ORIGINAL_REQUEST.md` as read-only. | OBSERVED | 113,252,809 |
| State folder relocation | Where the per-run scratch state applies, shared `ORIGINAL_REQUEST.md` resolves to that state folder rather than `/workspace/ORIGINAL_REQUEST.md`, and agents must not write `.agents/teamwork/` or bare state files into the working directory. | OBSERVED | File Workspace Convention, `/workspace/ORIGINAL_REQUEST.md` at 113,250,588 |
| `BRIEFING.md` | Re-read if no longer in context; create with current mission and identity if absent. It carries the routing decision and rationale and the current state (key decisions, progress). Sections marked 🔒 are append-only. | OBSERVED | 113,277,330; 113,271,547 |
| Handoff | A `handoff.md` is written in the agent's working directory following the Handoff Protocol: Observation, Logic Chain, Caveats, Conclusion, Verification Method. | OBSERVED | 113,278,028 |

---

## 7. Completion and monitoring protocol

`OBSERVED` — `## Route Completion Verification` at 113,273,475, with monitoring defined in `## Sentinel Monitoring` at 113,255,260. Every row in tables 7.1, 7.2 and 7.4 is `OBSERVED` at the cited offset; no row in those tables is inferred.

### 7.1 Outcome handling

| Situation | Auditor? | `Cleanup`? | May report completion? | Required action | Evidence |
|---|---|---|---|---|---|
| **Mid-run pause** (any route) — agent waits for user input or a pre-report gate | **No** | **No** — paused subagent and active monitoring stay open so the user's reply can resume | **Never** | Relay the pause or question plainly, as written | 113,273,475 |
| **Terminal non-victory stop** (any route) — `unverified open findings`, gave up, or stopped at an iteration/budget limit | **No** | **Yes** — cancel active monitoring crons/timers first, then clean up finished subagents, before the terminal report (so `Cron 2` cannot later kill or re-spawn a fresh orchestrator) | **Never** | Relay the incomplete, unverified or unchecked status plainly | 113,273,475 |
| **Victory claimed** | Route-dependent — see 7.2 | Only on the verified path | Only after the route's required verification, or a `VICTORY CONFIRMED` verdict | Verify first; a victory claim is never taken at face value | 113,274,513 |
| **`VICTORY REJECTED`** | — | **No** | No | Forward the full audit report to the chosen agent and resume the team to address the findings | 113,275,802 |

### 7.2 Verification by route

| Route / agent | Verification performed | Evidence |
|---|---|---|
| `teamwork_proof` | Already verified by that pipeline's own verification phase — run `Cleanup` and report the verified result directly. | 113,273,475 |
| `teamwork_swe` | Runs its own blocking `teamwork_victory_auditor`, at most two audits. If its completion report cites `VICTORY CONFIRMED`, run `Cleanup` and report directly without a second auditor; if it claims victory without citing it, the sentinel spawns `teamwork_victory_auditor`. | 113,273,475 |
| `teamwork_lean` | No auditor when it returns a kernel-checked proof or disproof — run `Cleanup` and report it as the result. If it gave up or returns an unchecked claim, run `Cleanup` and pass it on as the pipeline's own **unchecked** judgement, never as verified. | 113,273,475 |
| `teamwork_document` | Spawns `teamwork_document_victory_auditor`, which carries document-review forensics the plain auditor lacks. | 113,275,546 |
| Any other route (`teamwork_orchestrator`, `teamwork_pipeline`) | Spawns `teamwork_victory_auditor`. | 113,273,475 |

### 7.3 Blocking audit contract

`OBSERVED, 113,275,716` (path requirement at 113,275,802). Whenever an auditor is spawned, the dispatch prompt must include the path to `ORIGINAL_REQUEST.md` so the auditor can check the work against the original request. The sentinel **must not** report completion, and must not run `Cleanup`, without a `VICTORY CONFIRMED` verdict. `Cleanup` runs only after the verdict; a rejection returns the run to the working team.

### 7.4 Monitoring during the run

| Element | Definition | Evidence |
|---|---|---|
| Cron 1 — Progress Reporting | `*/8 * * * *`. Reads the active orchestrator's `progress.md` and `BRIEFING.md` plus its subagents' progress files; on change, a first report, or an orchestrator message, scans the top 5 recently modified workspace files (first 30 lines each) and reports 3–5 bullets; otherwise emits nothing except a one-line status on the 2nd, 4th and every 8th unchanged tick. | 113,255,355 |
| Cron 2 — Liveness Check | `*/20 * * * *`. Skipped while the orchestrator waits on a blocking subagent or a user reply. If the active orchestrator stopped or errored without completing or handing off, or its progress is unchanged since the last check and it has not answered the status request, it is killed via `manage_subagents(Action="kill", ConversationIds=[…])` — never `kill_all` — and re-spawned. Otherwise it is asked for status. | 113,255,856 |
| Successor tracking | A completed handoff transfers monitoring to the successor; `Root orchestrator` stays fixed. A completed handoff is explicitly **not** death, so no respawn. | 113,256,541 |
| `Cleanup` | Runs only when the whole run is over: `VICTORY CONFIRMED`, an instruction-defined `VICTORY UNVERIFIED` or audit limit, a route with no victory audit finishing, or an unrecoverable early stop. Order is fixed: cancel every active cron and timer with `manage_task(Action="kill", …)` **first**, then `manage_subagents(Action="kill_all", …)`, before the final report. | 113,257,324 |

### 7.5 Sentinel role constraints

`OBSERVED, 113,243,665`: "You MUST NOT write code, analyze problems, or make any technical decisions. Keep your context ultra-light." The sentinel has exactly four jobs — record the request, monitor progress, choose and start the agent, and handle the outcome. `[OBSERVED, 113,241,709 + 36,482 bytes]` On the `teamwork_proof` path it additionally grants at least 60-minute timeouts to workers drafting dense mathematical structures (113,243,471) and relaunches a terminated worker with clean context rather than stitching partial output.

---

## 8. Failure modes

| Condition | Programmed behaviour | Confidence | Evidence |
|---|---|---|---|
| LEMMA requested but `leap-tools` / Lean setup missing | The route "stops before any work"; the pre-flight `teamwork_dependency` audit returns `MISSING`, the sentinel relays the final notice verbatim and stops. The sentinel installs nothing itself; on a user install request it re-dispatches the auditor and re-reads the verdict. | OBSERVED | 113,268,283; 113,242,420 |
| Pre-flight auditor reports `OUTAGE` | Relays diagnostics and stops. | OBSERVED | 113,243,024 |
| Request is ambiguous or matches nothing | Routes to General. | OBSERVED | 113,270,283; final `Otherwise →` branch at 113,270,345 |
| Lean code supplied without an explicit Lean 4 request | Routes to General, not Math / Proof and not LEMMA. | OBSERVED | Decision chain branch 3 at 113,270,345 |
| Interviewer dispatch fails, or the interviewer dies | Re-dispatch once with the same prompt. If that fails too, tell the user the interview could not run, then route only on a prompt the user sends — or on the request as received if the user says to. | OBSERVED | 113,265,005 ("If the dispatch fails, or you learn…"); 113,265,199 |
| User never approves a prompt | The run never starts. No timer is set for the interview. | OBSERVED | 113,264,815 |
| Victory rejected | Full audit report forwarded to the chosen agent; the team resumes. No retry bound is stated for the sentinel's own audits (the `teamwork_swe` inner auditor is bounded at two). | OBSERVED (mechanism) / UNKNOWN (bound) | 113,275,802 |
| Orchestrator dies or stalls | Killed and re-spawned by Cron 2; not while it is legitimately blocked on an auditor or a user reply. | OBSERVED | 113,255,856 |
| Command disabled by admin/feature control | **unknown** — the identifiers exist (`TeamworkPreviewCommandDisabled` and the `MultiagentControls` feature-controls type), but the enforcement path was not analysed for this task. Whether the command is hidden, errors, or runs degraded is not evidenced. | UNKNOWN | 204,669,341; 30,306,835 |
| Multi-agent tier forced or restricted (`teamworkDisabled`, `disable-teamwork-forced-flash-model`) | **unknown** — string presence only. | UNKNOWN | 34,055,633; 223,052,618 |

---

## 9. Open questions

1. **Registry mechanism.** How does the CLI enumerate `/teamwork` and bind the description at 107,480,810 to the token compared at 174,580,885? The `teamwork` package metadata shows `AllAgents` and `indexByName` (around 34,565,473), which is a name-indexed agent set, but the bridge from that set to the slash-command surface is not evidenced. *Evidence that would settle it:* disassembly of the handler that loads the `teamwork` immediate, plus the `.data.rel.ro` relocation table entry pairing a name pointer with a description pointer.
2. **Argument grammar.** Beyond the single leading `[skip-interview]` bracket, is any argument parsing performed? No flag, subcommand, or option syntax appears in the recovered text. *Evidence that would settle it:* the same handler disassembly, or a Go registration structure with an args/spec field.
3. **Description fidelity.** The description string is fused with the next constant (`Show pinned hierarchy panels for a symbol.`) at 107,480,810. `Preview the multi-agent teamwork workflow.` is what `strings` and direct byte reads yield, but the exact stored length is not delimited in the artifact.
4. **Admin gating enforcement.** `TeamworkPreviewCommandDisabled`, `FetchAdminControlsResponse_FeatureControls_MultiagentControls`, `enable-teamwork-subagent`, `disable-teamwork-forced-flash-model`, and `teamworkDisabled` all exist; none were traced to a decision point. Deferred to the planned `06-config-gates-and-model-tiers.md`.
5. **Model-tier effects.** The `disable-teamwork-forced-flash-model` toggle implies `[INFERRED]` a forced Flash model tier for at least one agent, but which agents are defaulted to which tier is not established here. Also check `teamwork.RootAgentWithDefaultTier` (around 34,565,473), which suggests per-agent default tiering.
6. **Retry bounds.** The `teamwork_swe` inner auditor is bounded at two audits. No equivalent bound is stated for sentinel-spawned auditors on `VICTORY REJECTED`, so whether a rejecting loop can run indefinitely is unknown.
7. **Block boundaries.** The sentinel prompt block spans 113,241,709 + 36,482 bytes (end 113,278,190), ending immediately before protobuf descriptor bytes. Because the artifact fuses adjacent literals, these boundaries are measured byte positions, not necessarily the original source-string extents.

---

## Reproduction

```sh
B=/tmp/opencode/antigravity-re/antigravity
sha256sum "$B"
dd if="$B" bs=1 skip=107480810 count=100 status=none      # description string
dd if="$B" bs=1 skip=108451228 count=400 status=none      # sentinel role description
dd if="$B" bs=1 skip=113241708 count=36482 status=none     # sentinel prompt block (1-based start 113,241,709)
dd if="$B" bs=1 skip=113265667 count=4700  status=none     # Route Summary + Routing Decision Table
dd if="$B" bs=1 skip=174580870 count=48 | xxd              # `movabs` "teamwork" immediates
strings -a -n 5 -t d "$B" | grep -E ' teamwork$'          # command-name literals
```
