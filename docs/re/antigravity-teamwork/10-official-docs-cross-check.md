# Official Documentation Cross-Check — `/teamwork`

**Purpose.** This document tests the claims that Google's public documentation makes about Teamwork against what the shipped binary actually contains. It exists because the corpus now has **three evidence classes**, and they are not interchangeable:

| Class | What it establishes | What it cannot establish |
|---|---|---|
| **DOCS** — `https://antigravity.google/docs/teamwork/` | Intended, user-facing behaviour; the product's own description of itself | Whether the shipped artifact implements it, enforces it, or gates it |
| **OBSERVED** — static analysis of `antigravity` (SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`, 273,240,776 bytes; decimal file offsets) | What mechanics were compiled into the artifact: tokens, prompt text, role descriptions, tool allowlists, path literals | What the runtime does with them; entitlements; quotas; whether a prompt instruction is obeyed |
| **OBSERVED (assets)** — the materialised builtin assets under [`assets/`](assets/) and the recovered prompt text in [`prompts/`](prompts/) | The prompt and template corpus in readable form | The same limits as static analysis |

**Disagreement is the finding, not an error.** A DOCS/OBSERVED mismatch means either (a) the docs describe a different (older, newer, or other-surface) build, (b) the docs simplify a mechanism the binary implements in more detail, or (c) the docs describe intent that the shipped build does not enforce. Each verdict below says which, where the evidence supports saying.

**Version scope.** Every binary offset in this document is a **1.5.14** offset (the static axis). The live CLI is now **1.5.16** (SHA-256 `05245f43…430934e785`); **1.5.15** (`7b004d26…41fa2d`) is the historical live axis that produced the 2026-11-23 gate runs. The docs page was read against the static build, and its claims are about product intent; none of them is re-scoped to 1.5.15 or 1.5.16. See [`PROVENANCE.md`](PROVENANCE.md) *version axes*.

**Method.** The docs page was re-fetched on 2026-11-21 and its text compared claim-by-claim against the offsets already established in `00`–`08` of this corpus. Where a docs claim had no counterpart in the corpus, the binary was searched directly for it (`grep -aobF`) and, if found, the surrounding region was dumped and read. Those searches are the source of the four "new" mechanisms in §2 — all four turned out to be **in the binary already**, so none remains DOCS-ONLY. The commands are in *Reproduction*.

**Labels.** `DOCS` — asserted by the documentation page, cited to its section. `OBSERVED` — a byte string at a cited decimal offset, or a prompt statement quoted from it. `INFERRED` — reasoned from stated OBSERVED premises. `UNKNOWN` — not measured. The confidence legend is [`PROVENANCE.md`](PROVENANCE.md)'s.

**Source record.** Page title: *Teamwork agent teams (/teamwork)*. Availability line: "Available on: Antigravity App, Antigravity CLI, IDE extensions, Antigravity IDE". Plan line: "The `/teamwork` command is available on **paid plans** across the Google Antigravity App and the Antigravity CLI." The page sections used here are *Multi-agent architecture and roles*, *Execution paths*, *Two-phase workflow*, *Integrity modes*, *Safety, workspaces, and isolation*, and *When to use /teamwork*. All DOCS quotations below are from that page unless another URL is given.

---

## 1. Three-way table

Verdict vocabulary:

- **CONFIRMED** — docs and artifact agree on the mechanism. A name mapping is stated where the shipped short name differs; naming differences alone do not downgrade a row, because the mechanism is what is being checked.
- **DIVERGENT** — both describe the same mechanism but disagree on a material detail: count, trigger, or the relationship between the documented behaviour and the shipped implementation.
- **DOCS-ONLY** — asserted by the docs and **not** found in the artifact. This means "unverified statically", not "false". Several DOCS-ONLY rows are plausibly true at runtime (billing, UI surfaces).
- **BINARY-ONLY** — present in the artifact and absent from the docs.

Row references: `01` = [`01-command-contract.md`](01-command-contract.md), `02 rN` = row N of the registry table in [`02-agent-registry.md`](02-agent-registry.md), `04 §x` = section of [`04-pipeline-topologies.md`](04-pipeline-topologies.md), `05 §x` = section of [`05-coordination-and-artifacts.md`](05-coordination-and-artifacts.md).

| # | Claim | Docs (https://antigravity.google/docs/teamwork/) | Binary / recovered evidence | Verdict |
|---:|---|---|---|---|
| 1 | The command is `/teamwork` | Title and body: `/teamwork`; "How you start: `/teamwork <goal>`, followed by a scoping interview" | CLI literal is `teamwork-preview` @ 106,155,303 and 116,708,666, description `Preview the multi-agent teamwork workflow.` @ 107,480,810; the 8-byte `teamwork` token is compared as `movabs` immediates @ 174,580,885 / 174,581,082 / 174,581,141 (`01` §1). Admin gate `TeamworkPreviewCommandDisabled` @ 204,669,341 | **CONFIRMED** that both forms exist. The split is a preview-gated command identifier (`teamwork-preview`) presented to users as `/teamwork`; see §3.1 |
| 2 | Available on App, CLI, IDE extensions, IDE | "Available on: Antigravity App, Antigravity CLI, IDE extensions, Antigravity IDE" | Only the Linux CLI was analysed. No artifact evidence for the App, extensions or IDE surfaces | **DOCS-ONLY** (surface coverage) |
| 3 | Paid plans only | "available on **paid plans**"; comparison table row "Plan tier: Paid plans" | No billing or entitlement string found. What exists is a remote **feature control**, `FetchAdminControlsResponse_FeatureControls_MultiagentControls` @ 30,306,835 and `TeamworkPreviewCommandDisabled` @ 204,669,341, i.e. an on/off gate, not a plan check (`01` §2, §8). Whether the gate is driven by entitlement is UNKNOWN | **DOCS-ONLY** |
| 4 | **Sentinel** records the request, routes tasks, posts periodic progress updates, spawns the Success Auditor | "Sentinel records your request, routes tasks, posts periodic progress updates, and spawns the Success Auditor before wrapping up" | `sentinel@external` / runtime type `teamwork` (`02 r46`); sentinel prompt block 113,241,709 + 36,482 bytes; request recording @ 113,276,573; `## Sentinel Monitoring` @ 113,255,263; Cron 1 progress reporting `*/8` @ 113,255,355; `teamwork_victory_auditor` dispatch `01` §7.2 | **CONFIRMED** |
| 5 | **Project Orchestrator** breaks the brief into milestones and delegates every unit of work | "breaks the approved brief into structured milestones, coordinates parallel work tracks, delegates every unit of work" | Literal "You manage one subagent: the Project Orchestrator." @ 113,255,284; "Project Orchestrator" @ 114,750,837 and 114,752,070; `orchestrator_pure` / `teamwork_orchestrator` (`02 r22`) "Dispatches tasks to specialists… Does not write code directly"; "NEVER write, modify, or create source code files directly" @ 114,725,494; milestone decomposition "target **3-7 milestones**" @ 114,753,577; `04 §2.1` | **CONFIRMED** |
| 6 | The Orchestrator "hands off to a fresh successor **between milestones** to prevent context degradation" | same sentence as row 5 | Successor machinery exists: architecture diagram `[Project Orchestrator] … self-succeeds … [Successor]` @ 114,750,837–114,750,863; `successor` is a named orchestrator role ("handles self-succession when context grows too large. Writes state, spawns replacement, and exits") @ 114,727,128; `succession_threshold` @ 113,710,972 / 114,116,924 / 114,738,827; `Spawn count: [0] / [succession_threshold]` @ 113,710,952; sentinel "Successor tracking: If the orchestrator hands off to a successor" @ 113,256,585. **Trigger is a spawn-count threshold, not a milestone boundary** | **DIVERGENT** (mechanism CONFIRMED; cadence differs) — see §3.4 |
| 7 | **Explorers** are "read-only research agents" that do not modify source files | "Read-only research agents that explore the repository… without modifying any source files" | `explorer` / `teamwork_explorer` (`02 r9`): "Read-only exploration agent." But its decoded tool allowlist is 13 tools **including `replace_file_content`, `multi_replace_file_content` and `write_to_file`** (`02` Appendix A r9; `02` §*Tool allowlists*). "Spawn 2 **Explorer(s)** in parallel to map scope" @ 114,752,480 | **DIVERGENT** — read-only is a prompt-level rule, not an allowlist restriction; see §3.5 |
| 8 | **Workers** are implementation agents with terminal and file tools | "Implementation agents equipped with terminal and file tools… in focused, non-overlapping tracks" | `armed_worker` / `teamwork_worker` (`02 r2`), 15 tools including `run_command` and the three write tools; variant arms `armed_worker@colosseum` (`02 r40`), `armed_worker@document_review` (`02 r41`), `lemma_proof_worker` (`02 r20`); "DO NOT CHEAT… A teamwork_auditor will independently verify your work" @ 114,757,896 | **CONFIRMED** |
| 9 | **Critic** performs independent code review | "Performs independent code reviews, evaluating correctness, logical completeness, robustness, interface conformance, and adherence to project code style" | `armed_critic` / `teamwork_critic` (`02 r1`): "Domain-expert reviewer and adversarial critic. Loads a verification methodology skill…"; registry also carries `reviewer_critic` / `teamwork_reviewer` (`02 r26`) "Both objectively reviews AND adversarially challenges"; "Critic Orchestrator" prompt (`teamwork_critic_orchestrator`) @ 110,705,9xx, heading `# Critic Orchestration` @ 110,706,158 (`04 §5.1`) | **CONFIRMED** (two registry entries plus a critic sub-flow cover the documented role; see §3.3) |
| 10 | **Challenger** builds adversarial test suites and stress-tests | "Actively stress-tests the code by building adversarial test suites, edge cases, failure-path probes, and worst-case inputs" | `empirical_challenger` / `teamwork_challenger` (`02 r6`): "Code-executing adversarial verifier. Writes generators, oracles, and stress test harnesses to empirically verify solution correctness and performance"; "Challenger" @ 114,751,590, 114,756,095, 114,759,328; Phase-2 hardening loop "Challenger → Worker → Reviewer loop" @ 114,751,590 | **CONFIRMED** |
| 11 | **Auditor** validates against the integrity mode and checks test evidence against real command output | "Validates work against the selected integrity mode and checks test evidence against real command output, ensuring tests genuinely passed rather than being mocked or skipped" | `forensic_auditor` / `teamwork_auditor` (`02 r10`): "Forensic integrity auditor… static analysis, runtime tracing, execution validation"; `### Integrity Enforcement Levels` @ 112,966,504; `### 2-Phase Investigation Architecture` @ 112,968,073; "If a Forensic Auditor reports INTEGRITY VIOLATION, the milestone FAILS UNCONDITIONALLY" @ 114,726,148; verdict `CLEAN` / `INTEGRITY VIOLATION` @ 114,761,834 | **CONFIRMED** |
| 12 | **Success Auditor** runs a full end-to-end pass and must confirm everything works | "The final reviewer spawned by Sentinel… runs a full end-to-end verification pass and must confirm everything works" | No literal `Success Auditor` in the binary (`grep -aobFi 'success auditor'` → 0 hits). Semantic equivalent is `victory_auditor` / `teamwork_victory_auditor` (`02 r39`): "Independent post-victory auditor. Spawned by the Sentinel when the team claims project completion. Conducts a 3-phase audit (timeline, cheating detection, independent test execution)…"; document variant `02 r45`; sentinel spawn rule `01` §7.2 | **CONFIRMED** by role semantics; docs name ≠ registry name (see §3.3) |
| 13 | Five execution paths, selected automatically | Table lists General, Iterative coding, Document Review, Math / Proof, Math / Proof (Large Team) | Six routes in `### Route Summary` @ 113,265,667: Document Review, LEMMA, Math / Proof (Large Team), Math / Proof, SWE Light, General (`01` §3, `04` §2) | **DIVERGENT** — see §3.2 |
| 14 | (No Lean 4 path documented) | Not in the execution-paths table; "Math / Proof" is described as "theorem proving" | `orchestrator_lemma` → `teamwork_lean` (`02 r21`): "Orchestrator dedicated to the LEMMA formal proof pipeline pattern in Lean 4"; route @ 113,267,369; hard gate on `leap-tools` @ 113,268,283; pre-flight `teamwork_dependency` (`01` §3, `04 §2.3`) | **BINARY-ONLY** |
| 15 | Phase 1 is a scoping interview before any work | "the main Antigravity agent conducts a structured interview with you"; five numbered steps | `Task Interview` @ 113,261,255; "until you route, dispatch only the teamwork_interviewer" @ 113,276,251; interviewer dispatch payload @ 113,262,735; "Set no timer for the interview" @ 113,264,815; `# Prompt Crafting` with **nine** steps (Step 1 @ 112,228,578 through Step 9 @ 112,235,627) | **CONFIRMED** — with a granularity note: docs' five steps compress the shipped nine-step protocol (§3.6) |
| 16 | Interview ends in a reviewable **prompt artifact** the user approves once | "creates a reviewable **prompt artifact**. You can review the prompt, adjust details, and approve execution with a single confirmation" | `## Step 9: Assemble and validate` @ 112,235,627, with the fenced template beginning `[1-2 sentence project description…]`; approval handoff `Approved task prompt:` @ 113,263,893; `END PROMPT` marker @ 113,263,691; "no question or option names an integrity mode (development, demo, benchmark)" @ 112,226,976 | **CONFIRMED** |
| 17 | New projects default to `~/teamwork_projects/{PROJECT_NAME}` | "defaulting to `~/teamwork_projects/{PROJECT_NAME}`" (Phase 1 step 5 and Safety section) | "the default is `~/teamwork_projects/<project_name>` (lowercase, underscores)" @ 112,235,431; becomes the prompt line `Working directory: <path>` @ 112,235,5xx (`## Step 8: Working directory` @ 112,235,267) | **CONFIRMED** — identical path, different placeholder notation (`{PROJECT_NAME}` vs `<project_name>`) |
| 18 | **Request artifact**: initial prompt, goals, constraints, acceptance criteria | "Captures your initial prompt, goals, constraints, and testable acceptance criteria" | `.agents/teamwork/ORIGINAL_REQUEST.md` — "record the text you route on … once, before that agent starts… (not the workspace root)" @ 113,276,573; `01` §6; `05` §6 | **CONFIRMED** |
| 19 | **Project plan artifact**: milestone roadmap, active workstreams, dependency flow | "Tracks the milestone roadmap, active workstreams, and dependency flow" | State tree `.agents/teamwork/<parent_agent_name>/ # plan.md, progress.md, context.md` @ 111,758,997; `plan.md` literals at 108,303,343 / 111,758,999; milestone records in `BRIEFING.md` ("Milestone: [milestone name]" @ 111,761,988); `PROJECT.md` "Feature Inventory" @ 114,753,1xx and "Code Layout" @ 114,757,707 | **CONFIRMED** that a plan artifact exists and is distinct; the mapping docs-artifact → `plan.md` is **INFERRED** (no literal "plan artifact" string) |
| 20 | **Progress artifact**: live milestone status and completed tracks | "Records live milestone status and completed tracks" | `progress.md` literals at 108,360,947 / 108,519,500 / 108,612,851; Cron 1 reads "the active orchestrator's `progress.md` + `BRIEFING.md`" @ 113,255,406; `05` §6 | **CONFIRMED** |
| 21 | Three **integrity modes** with a documented rule set | `development` (lenient; fabricated output and facades only), `demo` (adds no copying core logic, no delegating core work, no reading test source), `benchmark` (from scratch, standard library only) | Authoring side: `## Step 3: Integrity mode` @ 112,230,526; shortcut options `(a) Copy code from existing open-source projects for core logic` @ 112,230,846 … `(e) None of these` @ 112,231,124; mapping "(e) alone… gives `development`… some but not all of (a) to (d) gives `demo`; all of (a) to (d) gives `benchmark`" @ 112,231,6xx–112,231,715; floor "if the request itself says \"from scratch\", the mode is at least `demo`… if it also forbids delegating, `benchmark`" @ 112,231,872–112,231,897. Enforcement side: `### Integrity Enforcement Levels` @ 112,966,504 with `#### Development Mode (lenient)` / `#### Demo Mode (moderate)` / `#### Benchmark Mode (maximum strictness)`; auditor reads the mode "from `ORIGINAL_REQUEST.md` **directly** … do NOT receive the mode from the orchestrator" @ 112,968,482; template line `Integrity mode: [development \| demo \| benchmark]` @ 112,235,817 | **CONFIRMED** (no longer DOCS-ONLY — see §2.1; the binary's `demo` mapping is coarser than the docs' row, noted there) |
| 22 | Exclusive file ownership: multiple workers never edit the same file at once | "the Project Orchestrator assigns specific files to individual Workers. Multiple workers never edit the same file at the same time" | "**Write ownership**: Assign exclusive file ownership per Worker (`PROJECT.md` · `Code Layout`); concurrent Workers MUST NOT write the same file." @ 114,757,686 | **CONFIRMED** (prompt-level rule; no code enforcement found — §4) |
| 23 | Per-agent scratch directories | "Each subagent has its own working directory and writes its helper scripts, notes, and logs there" | Per-run scratch `teamwork_tmp` @ 111,760,275, canonical path `<appDataDir>/scratch/teamwork_tmp/<conversation-id>`; per-agent state folder `.agents/teamwork/<agent_name>_<n>/` @ 111,761,858 tree; `05` §6 | **CONFIRMED** — per-conversation path makes it per-agent; shipped literal is `teamwork_tmp`, docs use prose only |
| 24 | Sentinel posts periodic progress updates; progress is monitorable | "posts periodic progress updates"; "monitor live progress across agent tracks in the UI subagent panel or CLI status bar" | Cron 1 — Progress Reporting `*/8 * * * *` @ 113,255,355: reads `progress.md` + `BRIEFING.md`, "report 3-5 bullets to the user; otherwise send nothing but a one-line status on the 2nd, 4th and every 8th unchanged tick"; Cron 2 — Liveness Check `*/20` @ 113,255,856; `01` §7.4, `05` §7 | **CONFIRMED** (CLI text output OBSERVED; the UI panel is DOCS-ONLY) |
| 25 | `/swarm` coordinates named workers and a verifier on one shared message board; Teamwork uses a Sentinel + Project Orchestrator through a milestone plan | Comparison table and *Next steps*: swarm = "named workers and a verifier that talk on one shared message board"; teamwork = "a `Sentinel` and `Project Orchestrator` … through a milestone plan with review gates" | `/swarm` command exists @ 47,237,988; board substrate `board.Message` (Seq/Agent/Text/Channel/RequestID) @ 40,757,180 and `swarm.Member` @ 47,248,753, documented in `05` §2–§3 and, from the materialised tree, [`09-swarm-board-and-skills.md`](09-swarm-board-and-skills.md); Teamwork prompts use `send_message`, `progress.md`, `BRIEFING.md` and `.agents/teamwork/`, not the board schema (`05` §5, §8) | **CONFIRMED** for the contrast (swarm half OBSERVED; "teamwork does not use the board" INFERRED from absence) |
| 26 | Typical horizon: hours to days | Comparison table: "Typical horizon — Hours to days" | No artifact evidence: horizons are runtime outcomes, not constants | **DOCS-ONLY** |
| 27 | Teamwork "automatically adjusts team composition, verification depth, and agent roles based on the task and your prompt" | *Execution paths* preamble | Route selection is a fixed ordered chain over explicit signals (`01` §4); the interviewer also asks two opt-in questions and writes the answer into the prompt (`keep it small and focused` @ 112,229,999; "Use a very large team of agents." @ 112,230,354). "Automatic" is therefore partly a **prompt-signal** mechanism, not a classifier | **DOCS-ONLY** (characterisation) — the mechanics are `01` §4, not an autonomous classifier |
| 28 | Sentinel spawns the Success Auditor before wrapping up | "spawns the Success Auditor before wrapping up" | Sentinel must not report completion or run `Cleanup` without `VICTORY CONFIRMED`; spawns `teamwork_victory_auditor` on non-proof routes @ 113,273,475 / 113,275,716; `01` §7.2–§7.3 | **CONFIRMED** |

**Tally.** 20 CONFIRMED, 3 DIVERGENT (rows 6, 7, 13), 1 BINARY-ONLY (row 14), 4 DOCS-ONLY (rows 2, 3, 26, 27). The DOCS-ONLY set is exactly what static analysis cannot settle: surface coverage, billing, horizons, and the word "automatically". Every role and every artifact the docs name has an artifact counterpart; the disagreements are about *how* (trigger, allowlist, path count), not *whether the thing exists*.

---

## 2. Newly discovered mechanisms

These four were **not previously in this corpus** and were found by reading the docs page. The corpus brief described them as DOCS-ONLY. That was true when the brief was written; all four were then **confirmed in the binary** during this cross-check (the plan artifact with an inferred file mapping). The table below is deliberately explicit about which confirmation was actually performed, so a later reader does not have to guess.

| Mechanism | Docs status before | Confirmation performed | Result |
|---|---|---|---|
| Integrity modes + shortcut mapping | DOCS-ONLY | yes — `grep -aobF 'Step 3: Integrity mode'`, `'Integrity Enforcement Levels'` | **CONFIRMED** |
| `~/teamwork_projects/{PROJECT_NAME}` default | DOCS-ONLY | yes — `grep -aobF 'teamwork_projects'` | **CONFIRMED** |
| Fresh successor between milestones | DOCS-ONLY | yes — `grep -aobF 'self-succeeds'`, `'succession_threshold'` | **CONFIRMED** as a mechanism; **DIVERGENT** on trigger |
| Request / plan / progress artifacts | DOCS-ONLY | yes — `ORIGINAL_REQUEST.md`, `plan.md`, `progress.md` literals | **CONFIRMED** (plan mapping INFERRED) |

### 2.1 Integrity modes and the shortcut mapping

**Docs.** Three modes, recorded in the prompt artifact: `development` (default; flags only fabricated outputs and facade implementations; reuse, libraries and frameworks permitted), `demo` (adds: no copying core logic from open source, no delegating core work to external tools, no reading test source to reverse-engineer expected behaviour), `benchmark` (fully independent from-scratch implementation; language standard library only). "if you rule out all four shortcuts, the run uses `benchmark` mode."

**Binary.** [OBSERVED] The mechanism is compiled in twice, on both sides of the handoff:

- **Authoring** — `## Step 3: Integrity mode` @ **112,230,526**. The interviewer does not ask for a mode; it asks a behavioural multi-select, "Which of these should the team NOT be allowed to do?", with options `(a)` copy code from existing open-source projects for core logic @ 112,230,846, `(b)` use pre-built libraries or frameworks for core functionality, `(c)` run external scripts or delegate execution to other tools, `(d)` read test source code to understand expected behaviour before implementing, `(e)` none of these @ 112,231,124. Mapping @ 112,231,652: "(e) alone, or nothing selected, gives `development`… some but not all of (a) to (d) gives `demo`; all of (a) to (d) gives `benchmark`."
- **Floor rule** @ 112,231,872: "if the request itself says \"from scratch\", the mode is at least `demo`; if it also forbids delegating, `benchmark`. Draft a lower mode only if the user themselves lifts that restriction." This is stronger than the docs, which describe the mapping but not the floor.
- **Overlap with the docs' rule sets.** The endpoints match exactly: `development` = none of (a)–(d) forbidden; `demo` = *some but not all* of (a)–(d) forbidden; `benchmark` = all four forbidden. The docs' `demo` row lists the maximal case ({a, c, d} forbidden, {b} permitted), while the binary maps **any** proper non-empty subset to `demo`. Enforcement then applies the mode's fixed rule set — the auditor's `#### Demo Mode (moderate)` prohibits all three of copying core logic, delegating core work and reading test source regardless of which subset the user selected. So mode selection is coarser than the questionnaire: forbidding only (d) still yields the full `demo` rule set. The docs simplify this in the direction of the maximal case.
- **Recording** — the `Integrity mode:` line of the Step 9 template @ 112,235,817 writes `Integrity mode: [development | demo | benchmark]` into the prompt artifact, and, if anything was forbidden, `The team must NOT: <each forbidden item, in words>` @ 112,235,895.
- **Enforcement** — `### Integrity Enforcement Levels` @ **112,966,504** gives one subsection per mode, with the docs' rule sets almost verbatim: `#### Development Mode (lenient)` ("Catch fabricated outputs and facade implementations only"), `#### Demo Mode (moderate)`, `#### Benchmark Mode (maximum strictness)` ("Permitted: Language standard library only").
- **Independence of the check** — `### 2-Phase Investigation Architecture` @ 112,968,073. Phase 1 flags nothing and records observations for all three modes; Phase 2 reads the mode "from `ORIGINAL_REQUEST.md` **directly** … do NOT receive the mode from the orchestrator (to avoid transmission bias)" @ 112,968,482. If no mode is stated the auditor infers it with the same floor: "from scratch" + "MUST NOT delegate" → benchmark; "from scratch" alone → demo; no constraints → development.

**Assessment.** This is the most completely documented mechanism in the whole page: every rule in the docs table has a matching binary rule, and the binary has two rules the docs omit (the floor, and the auditor's read-from-source-of-truth rule). The docs' "if you rule out all four shortcuts, the run uses `benchmark`" is exactly mapping rule "all of (a) to (d) gives `benchmark`". [OBSERVED for the text; INFERRED that the two regions are the authoring and enforcement halves of one design, since the mode strings and rule sets match one-to-one]

**Docs-vs-binary wording trap.** The docs page uses "demo" as a *project purpose* ("purpose (demo, production, eval, exploration)") and again as an *integrity mode*. The shipped interviewer forbids naming a mode to the user at all — options "no question or option names an integrity mode (development, demo, benchmark), not even as \"showcase / demo\"" @ 112,226,976 — and the purpose question reads "for what purpose (showcase, never \"demo\"; production; eval; exploration)" @ 112,228,653. The docs' colloquial use of "demo" for purpose is one the shipped prompt explicitly avoids, to prevent users reading `demo` mode as a quality level.

### 2.2 Default project directory `~/teamwork_projects/{PROJECT_NAME}`

**Docs.** Phase 1 step 5 and the Safety section: "defaulting to `~/teamwork_projects/{PROJECT_NAME}`".

**Binary.** [OBSERVED] `## Step 8: Working directory` @ 112,235,267: "For work on existing files the directory is where they are: do not ask. For a new project ask where it should live; the default is `~/teamwork_projects/<project_name>` (lowercase, underscores). It becomes the top-level line `Working directory: <path>`." The only occurrence of the literal `teamwork_projects` in the binary is @ **112,235,431**.

**Assessment.** CONFIRMED. Two details are binary-only: the not-applicable case (existing files → do not ask) and the lowercase/underscores normalisation. The docs' `{PROJECT_NAME}` and the binary's `<project_name>` are the same placeholder in different notation.

### 2.3 Fresh successor orchestrator handoff

**Docs.** The Project Orchestrator "hands off to a fresh successor between milestones to prevent context degradation".

**Binary.** [OBSERVED] A full succession subsystem exists:

| Element | Evidence |
|---|---|
| Successor is a named orchestrator role | "You are a Teamwork agent with roles: orchestrator, user_liaison, human_reporter, **successor**" @ 114,726,0xx; "**successor**: Succession manager: handles self-succession when context grows too large. Writes state, spawns replacement, and exits." @ 114,727,128 |
| Architecture places it mid-run | `[Project Orchestrator] … self-succeeds … [Successor]` @ 114,750,837–114,750,863 |
| Trigger is a spawn count | `## Succession Status` template: "Succession required: [yes/no] / Spawn count: [0] / [succession_threshold]" @ 113,710,952; "4. **Succession**: [when to self-succeed … e.g., at N spawns, write handoff.md, spawn successor]" @ 114,738,087 |
| Threshold literal | `succession_threshold` @ 113,710,972; repeated per-route at 114,116,924, 114,738,827, 114,937,586, 115,055,963, 115,128,570, 115,396,119 |
| State transfer | `[successor_state_dir]`; "spawn fresh agent with partial progress" @ 114,737,811; handoff sections *Milestone State / Active Subagents / Pending Decisions / Remaining Work / Key Artifacts* @ 114,728,898 |
| Sentinel tracks the swap | "**Successor tracking**: If the orchestrator hands off to a successor (via the succession protocol), the successor becomes the active agent." @ 113,256,585; a completed handoff is explicitly not death, so Cron 2 does not respawn (`01` §7.4) |

**Assessment.** CONFIRMED as a mechanism, DIVERGENT on cadence. The binary's trigger is a **spawn-count threshold** ("at N spawns"), i.e. context growth; the docs' "between milestones" describes a cleaner policy that the shipped prompt does not state. This matters for anyone reimplementing: a milestone-boundary handoff and a spawn-count handoff produce different context windows and different handoff frequencies.

### 2.4 The three named artifacts

**Docs.** Request artifact (initial prompt, goals, constraints, acceptance criteria), project plan artifact (milestone roadmap, workstreams, dependency flow), progress artifact (live milestone status, completed tracks).

**Binary.** [OBSERVED for the file literals; INFERRED for the docs-name → file-name mapping]

| Docs artifact | On-disk counterpart | Evidence | Mapping strength |
|---|---|---|---|
| Request artifact | `.agents/teamwork/ORIGINAL_REQUEST.md` | 113,276,573; read by every auditor (`01` §7.3) | OBSERVED — one file, written once, explicitly not the workspace root |
| Project plan artifact | `.agents/teamwork/<agent>/plan.md`, plus `PROJECT.md` sections *Feature Inventory* / *Code Layout* | state tree @ 111,758,997; `plan.md` @ 111,758,999; `PROJECT.md` @ 111,755,084, 114,753,050 | INFERRED — no literal "plan artifact"; the milestone/roadmap role is split across `plan.md` and `PROJECT.md` |
| Progress artifact | `.agents/teamwork/<agent>/progress.md` | 108,360,947; Cron 1 reads it @ 113,255,406 | OBSERVED |

**Assessment.** CONFIRMED as three distinct artifacts. The docs' single "project plan artifact" is the weakest mapping: the binary keeps a per-agent `plan.md` *and* a shared `PROJECT.md` with milestone/layout sections, so the docs' umbrella term covers two files. Do not collapse them when reimplementing; the auditors cite `PROJECT.md` for write-ownership scope @ 114,757,686.

*Reproduction caveat:* the shipped section reference uses a UTF-8 middle dot, `PROJECT.md · Code Layout` (`c2 b7` between the two names, visible at 114,757,73x). `grep -aobF 'PROJECT.md .. Code Layout'` therefore returns nothing; search for `PROJECT.md` alone.

---

## 3. Divergences to report honestly

### 3.1 Command name: `/teamwork` vs `teamwork-preview`

**Facts.** [OBSERVED] The CLI command literal is `teamwork-preview` at file offsets 106,155,303 and 116,708,666, with the description `Preview the multi-agent teamwork workflow.` at 107,480,810 and the admin-control gate `TeamworkPreviewCommandDisabled` at 204,669,341. The 8-byte `teamwork` token also exists and is loaded as `movabs` immediates at 174,580,885, 174,581,082 and 174,581,141 (`01` §1). [DOCS] The page's title and every example use `/teamwork`; the "How you start" row says "`/teamwork <goal>`, followed by a scoping interview".

**Verdict: CONFIRMED that both forms exist.** This is not a contradiction to resolve in favour of one side; it is a naming split with a clear explanation:

- `teamwork-preview` is the **shipped identifier** — a preview-gated command, with a dedicated kill switch named after it. The `-preview` suffix is a release-stage marker, and the command's own description still says "Preview the … workflow."
- `/teamwork` is the **documented, user-facing name**. Docs are version-independent marketing/usage copy; they drop release-stage suffixes.
- The bare `teamwork` token is the identifier with the suffix stripped, used inside the package (`teamwork.AllAgents`, `teamwork.init` @ ~34,565,473) and compared as an 8-byte immediate, because an 8-byte immediate is the natural unit for a Go string-equal against a name of that length.

**Correction to the brief for this document.** The brief stated that site navigation labels the entry "Teamwork (/teamwork-preview)". The page as re-fetched on 2026-11-21 labels it "Agent teams/teamwork" in the *Featured* group and "Agent teams/teamwork" in the sidebar; no `-preview` appears anywhere in the fetched HTML. Treat the `-preview` nav label as **UNVERIFIED** — possibly a stale locale/version variant. The substance of the divergence (docs `/teamwork`; binary `teamwork-preview`) is unaffected and is OBSERVED.

*Consequence for this corpus:* keep `/teamwork` as prose shorthand, but when citing the artifact use `teamwork-preview`. Do not "fix" one to match the other.

### 3.2 Execution paths: docs five, binary six

**Docs.** The *Execution paths* table lists exactly five: General (Distributed coding), Iterative coding, Document Review, Math / Proof, Math / Proof (Large Team).

**Binary.** `### Route Summary` @ 113,265,667 declares **six**: Document Review, **Formal Math / Lean 4 (LEMMA)**, Math / Proof (Large Team), Math / Proof, SWE Light, General. The LEMMA route (trigger @ 113,267,369) is a hard-gated, opt-in path: it needs an explicit Lean 4 request *and* user-installed `leap-tools`, and it stops before any work when they are missing @ 113,268,283. Its registry entry is `orchestrator_lemma` → runtime type `teamwork_lean` (`02 r21`).

**Verdict: DIVERGENT.** The docs omit an internal/opt-in route. This is a defensible documentation choice — LEMMA has a toolchain prerequisite the page never mentions, so advertising it would generate support load — but it is a real gap: a user who asks for a Lean 4 proof gets a different pipeline from every path the docs list. A second, smaller naming divergence sits inside the same table: the docs' **"Iterative coding"** is the binary's **SWE Light** (`teamwork_swe`, `02 r48`), with identical semantics ("cannot decompose the task" / "Runs a collapsed team … and **cannot decompose**", `01` §3).

*Consequence:* [`01-command-contract.md`](01-command-contract.md) §3 keeps the six-route taxonomy and now points here; [`04-pipeline-topologies.md`](04-pipeline-topologies.md) §2 keeps six route topologies. Do not "correct" either to five.

### 3.3 Role naming: docs names vs registry short names

The docs use human role names; the registry uses short names bound to runtime types. The mapping is by **role semantics**, and it is stated here so nobody has to re-derive it:

| Docs role | Registry short name | Runtime type | Registry row | Basis for the mapping |
|---|---|---|---|---|
| **Sentinel** | `sentinel@external` | `teamwork` | `02 r46` | "Sentinel with task routing. Dispatches teamwork_orchestrator, teamwork_swe, …" — exactly the docs' routing/recording/monitoring role |
| **Project Orchestrator** | `orchestrator_pure` (general) / `orchestrator_pure@swe_light` / `orchestrator_pure@document_review` | `teamwork_orchestrator` / `teamwork_swe` / `teamwork_document` | `02 r22`, `r48`, `r43` | "Pure orchestrator. Dispatches tasks to specialists… Does not write code directly." The docs describe the *general* one |
| **Explorers** | `explorer` | `teamwork_explorer` | `02 r9` | "Read-only exploration agent. Investigates codebases…" |
| **Workers** | `armed_worker` (+ `@colosseum`, `@document_review`, `lemma_proof_worker`) | `teamwork_worker` | `02 r2`, `r40`, `r41`, `r20` | "Versatile worker with loadable domain expertise… implementation, QA" |
| **Critic** | `armed_critic` | `teamwork_critic` | `02 r1` | "Domain-expert reviewer and adversarial critic" |
| **Challenger** | `empirical_challenger` | `teamwork_challenger` | `02 r6` | "Code-executing adversarial verifier… stress test harnesses" |
| **Auditor** | `forensic_auditor` | `teamwork_auditor` | `02 r10` | "Forensic integrity auditor… static analysis, runtime tracing, execution validation" |
| **Success Auditor** | `victory_auditor` (+ `victory_auditor@document_review`) | `teamwork_victory_auditor` (`teamwork_document_victory_auditor`) | `02 r39`, `r45` | "Independent post-victory auditor. Spawned by the Sentinel when the team claims project completion." |

**Verdict: CONFIRMED by role semantics, with the name mapping as stated.** Three mappings are worth calling out because a naive string search fails:

- **"Project Orchestrator"** is not a registry short name, but it *is* a literal phrase in the sentinel prompt ("You manage one subagent: the Project Orchestrator." @ 113,255,284) and in the general-orchestrator architecture @ 114,750,837. So the docs' name is real product vocabulary; the registry's name for the type is `orchestrator_pure`.
- **"Success Auditor"** has **zero** literal occurrences in the binary. The role is real and richly described, but under the name `victory_auditor`. Anyone auditing "does the binary implement the Success Auditor?" with a `grep 'Success Auditor'` will get a false negative.
- **"Challenger"** is a literal phrase in the orchestrator prompt (@ 114,751,590 etc.) and in the Phase-2 loop, while the registry entry is `empirical_challenger`. The docs' name is the *prompt* name; the registry name is the *type* name.

Note also that the docs' **Critic** is spread across two registry entries — `armed_critic` (domain-expert adversarial review) and `reviewer_critic` ("Both objectively reviews AND adversarially challenges" @ `02 r26`). The docs' single role does not map one-to-one; the orchestrator arms a Critic depending on the stage.

### 3.4 Successor handoff cadence (new)

Docs: "between milestones". Binary: spawn-count threshold / context growth (§2.3). **DIVERGENT** on trigger, CONFIRMED on existence. State this whenever the docs' handoff sentence is quoted; otherwise a reimplementation will hand off at the wrong time.

### 3.5 Explorers are documented read-only, but their allowlist is write-capable (new)

Docs: "Read-only research agents … without modifying any source files". Registry description: "Read-only exploration agent." Decoded allowlist for `explorer` (`02` Appendix A r9, 13 tools): `find_by_name`, `grep_search`, `list_dir`, `manage_task`, **`multi_replace_file_content`**, `read_url_content`, **`replace_file_content`**, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, **`write_to_file`**.

**Verdict: DIVERGENT.** Read-onlyness is a **prompt-level instruction**, not an allowlist restriction. The same is true of the sentinel's "You MUST NOT write code" (@ 113,243,665) despite a 15-tool allowlist that includes all three write tools (`02` §*Tool allowlists*). This is the clearest example in the corpus of why docs cannot establish enforcement: the artifact's *description* and the artifact's *capability* disagree, and only a runtime trace can say which wins.

### 3.6 The interview's five documented steps are nine shipped steps (new)

Docs list five: scope, requirements, independent verification, acceptance criteria, working directory. The shipped `# Prompt Crafting` section has nine: 1 elicit the idea, 2 identify ambiguity, **3 integrity mode**, 4 draft requirements, 5 design verification, 6 acceptance criteria, 7 infrastructure constraints, 8 working directory, 9 assemble and validate. **DIVERGENT in granularity, not in substance** — every docs step is present in the binary, but the docs' list folds integrity mode (Step 3) and infrastructure constraints (Step 7) out of the narrative even though the docs describe integrity modes in a later section. A reimplementation built from the five-step summary would omit the mode question entirely.

---

## 4. What documentation cannot establish

The docs page is good at *roles* and *artifacts* — those all cross-check. It is silent on, or unable to settle, the following. Each is listed with the evidence class that would settle it.

| Question | Why docs cannot answer | What would settle it | Status |
|---|---|---|---|
| Is the command actually disabled for non-paid users, and how? | The page asserts a plan requirement; the binary has an on/off feature control (`TeamworkPreviewCommandDisabled` @ 204,669,341, `MultiagentControls` @ 30,306,835), not a billing check | Disassembly of the admin-controls consumer, or a live run on a free account | **UNKNOWN** |
| What are each agent's real tool permissions? | Docs describe roles, not allowlists; the allowlists disagree with the role prose (§3.5) | A live run with tool-call tracing, or the dispatch handler that builds the tool set | **UNKNOWN** for effective permissions; allowlist membership is OBSERVED (`02` Appendix A) |
| Concurrency and fan-out limits | Docs say "parallel work tracks", no numbers | Prompt literals: 128 agents per orchestrator @ 114,744,315; 8 LEMMA workers @ 114,086,125; ≤32 nodes/layer @ 114,942,300 (`04` §6). These are *stated caps in prompts*, not enforced quotas | OBSERVED (stated) / **UNKNOWN** (enforced) |
| Failure modes and recovery | Docs describe the happy path plus "guardrails" | `01` §8 tables the programmed failure behaviour; whether the model obeys is a runtime question | OBSERVED (programmed) / **UNKNOWN** (runtime) |
| Does the Sentinel actually post on the documented cadence? | Page says "periodic"; binary says `*/8` and `*/20` (`01` §7.4) | Prompt text is OBSERVED; schedule execution is a runtime fact | OBSERVED (text) / **UNKNOWN** (firing) |
| Do auditors really run tests independently? | Page says they check "real command output" | The auditor prompt says it runs "independent test execution" (`02 r39`); no code path validates compliance | OBSERVED (instruction) / **UNKNOWN** (behaviour) |
| Is the UI subagent panel / CLI status bar as described? | Not analysable from a CLI binary's strings alone | The TUI/web surface, or a live run | **UNKNOWN** |
| Quotas, cost, and model tiers per role | Docs are silent; binary has `disable-teamwork-forced-flash-model` @ 223,052,618 and per-agent tier builders | `06-config-gates-and-model-tiers.md` work, plus billing data | **UNKNOWN** |

**Rule for this corpus.** A docs sentence may be cited as *intended* behaviour, never as *implemented* behaviour. Where the two disagree, record both and name the disagreement — as §3 does.

---

## 5. Effect on the rest of the corpus

- [`01-command-contract.md`](01-command-contract.md) §1.1 now carries availability, the three integrity modes, and the default project directory; §3 carries a pointer to the five-vs-six path divergence.
- [`04-pipeline-topologies.md`](04-pipeline-topologies.md) §2.7 now carries the docs-role → registry-role mapping and the successor handoff as a labelled DOCS-ONLY edge.
- [`02-agent-registry.md`](02-agent-registry.md) is unchanged by this document and remains the authority for short names, runtime types, and allowlists. Its row numbers are used throughout.
- No mechanism in `00`–`08` was found to be contradicted by the docs. The DIVERGENT rows and subsections are trigger, allowlist, and path-count differences, not false statements.

---

## Reproduction

```sh
B=/tmp/opencode/antigravity-re/antigravity

# §2.1 integrity modes — authoring side (interviewer)
grep -aobF 'Step 3: Integrity mode' "$B"                 # 112230526
grep -aobF 'gives `benchmark`' "$B"                      # 112231715
grep -aobF 'mode is at least `demo`' "$B"                # 112231872
dd if="$B" bs=1 skip=112230500 count=1800 status=none | tr -c '[:print:]\n' '.'

# §2.1 integrity modes — enforcement side (auditor)
grep -aobF 'Integrity Enforcement Levels' "$B"           # 112966504
grep -aobF 'Read the integrity mode from `ORIGINAL_REQUEST.md`' "$B"  # 112968482
dd if="$B" bs=1 skip=112965900 count=1800 status=none | tr -c '[:print:]\n' '.'

# §2.2 default project directory
grep -aobF 'teamwork_projects' "$B"                      # 112235431
dd if="$B" bs=1 skip=112235300 count=200 status=none | tr -c '[:print:]\n' '.'

# §2.3 successor handoff
grep -aobF 'self-succeeds' "$B"                          # 114750863
grep -aobF 'succession_threshold' "$B"                   # 113710972 + 6 more
grep -aobF 'hands off to a successor' "$B"               # 113256585
grep -aobF 'You manage one subagent: the Project Orchestrator' "$B"   # 113255284

# §2.4 artifacts
grep -aobF '# plan.md, progress.md, context.md' "$B"     # 111758997
grep -aobF 'ORIGINAL_REQUEST.md' "$B" | head
grep -aobF 'progress.md' "$B" | head

# §3.1 command name
grep -aobF 'teamwork-preview' "$B"                       # 106155303, 116708666
grep -aobF 'Preview the multi-agent teamwork workflow.' "$B"  # 107480810

# §3.5 explorer allowlist is write-capable
grep -n '^9\. `explorer`' docs/re/antigravity-teamwork/02-agent-registry.md

# §2.1 docs-vs-binary "demo" wording trap
grep -aobF 'showcase, never' "$B"                        # 112228653
grep -aobF 'integrity mode' "$B" | head                  # 112226976 region

# §3 excluding "success auditor" by literal (a false negative trap)
grep -aobFi 'success auditor' "$B"                       # no hits
```
