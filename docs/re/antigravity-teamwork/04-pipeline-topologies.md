# Pipeline Topologies — Antigravity `/teamwork`

Static-analysis reconstruction of the **dispatch graph** of Antigravity's `/teamwork` subsystem: which agent starts which, in what order, for each of the six routes the sentinel can choose. [OBSERVED for every edge so labelled] Everything here was measured from the extracted Linux CLI binary `antigravity` (SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`, 273,240,776 bytes). The binary was **never executed**. All offsets are **decimal file offsets** into that binary.

Companion documents: [`00-artifact-identity.md`](00-artifact-identity.md) (binary identity, section map), [`01-command-contract.md`](01-command-contract.md) (route set, Route Summary mapping, pre-flight audit semantics, completion verification), [`02-agent-registry.md`](02-agent-registry.md) (agent types, the eight verbatim role descriptions D1–D8, the length-bucketed string limitation), [`05-coordination-and-artifacts.md`](05-coordination-and-artifacts.md) (board, members, on-disk artifacts, conductor/updater roles), [`10-official-docs-cross-check.md`](10-official-docs-cross-check.md) (docs role names → registry names, and docs-vs-binary divergences), [`prompts/sentinel-routing.md`](prompts/sentinel-routing.md) (verbatim sentinel prompt).

**Scope.** This document covers dispatch edges only — entry, parent/child, loop, and terminal-verification edges for the six routes — and the artifacts that carry state between nodes. It does not re-derive the command surface (`01-command-contract.md`), the roster and its type bindings (`02-agent-registry.md`), the board/member substrate (`05-coordination-and-artifacts.md`), or model tiers and admin gating (deferred to the planned `06-config-gates-and-model-tiers.md`). Offsets quoted here are evidence pointers into the same artifact, not independent re-measurements.

## Confidence Legend

| Label | Meaning |
|---|---|
| **OBSERVED** | Directly read from the artifact: a byte string at a measured file offset, or a dispatch statement in recovered prompt text. Earned by quoting the value and its offset. |
| **INFERRED** | Derived by reasoning over observed data (morphology, the Route Summary mapping, file provenance, prompt prose). Earned by stating the premises. |
| **UNKNOWN** | Not measured, or not determinable from the available evidence. Written literally as `UNKNOWN`; never guessed. |

Five edge classes are used in the per-route tables; they do **not** have equal force.

- **R1 — role description names its target.** The verbatim text that *is* the agent's role (the D-series in `02-agent-registry.md`) says which agents it dispatches. Strongest available evidence; still prompt prose, not code.
- **R2 — the Route Summary / sentinel protocol names the target.** The sentinel's own instructions map a route to an agent, or name an agent as an outcome handler.
- **R3 — recovered prompt text of a downstream agent names its caller or its children.** A pipeline prompt that says "spawn the Pipeline Blackboard Updater (`TypeName: …`)".
- **R4 — morphology / source-file provenance only.** No text says this agent starts that one. The name, its `.go` path, or its position in a type list is the whole evidence. Always `INFERRED`.
- **R5 — nothing.** Either the target type is known and the parent is not, or the type itself is unbound. Always `UNKNOWN`.

## Reconstruction Method

Edges were accepted only from four sources, in this order: (1) the eight verbatim role descriptions catalogued as D1–D8 in `02-agent-registry.md`, each of which names its dispatch targets in prose (for example D2: "Dispatches teamwork_worker, teamwork_planner, teamwork_reviewer, teamwork_verifier, teamwork_formalizer, and teamwork_formalization_reviewer"); (2) the `### Route Summary` table and the sentinel's Workflow Protocol / Route Completion Verification prose, which map each route to its entry agent and each outcome to its auditor; (3) recovered prompts belonging to the downstream agents themselves, which state in imperative text whom they spawn (`TypeName: "teamwork_conductor"`, "spawn exactly one `teamwork_updater` subagent"); and (4) Observed source-file provenance (`.go` paths under `builtin/teamwork/`, `swe_light/`, `document_review/`, `colosseum/`, `external/`), which places a type in a package but proves no edge. Everything else is marked `INFERRED` and says explicitly that the type name — or its file name — is the only evidence. Where a name is present but no role text and no dispatch site exist, the edge is `UNKNOWN` and appears in §7 rather than in a diagram.

Two structural caveats govern every diagram below. First, the binary's Go string literals are stored in a **length-bucketed layout with no NUL separators**, so two names being adjacent in `.rodata` proves nothing about a pipeline relationship (`02-agent-registry.md`, *Known Limitation*). Second, the prompts are **instructions to a model**, not code: no code path was found that validates compliance (`01-command-contract.md`, *Evidence classes*). A diagram is therefore "the topology the shipped artifact specifies", not "the topology the runtime enforces".

---

## 1. Shared spine

Every route begins with the same entry chain. Only the `[route agent]` node differs per route.

```text
/teamwork  ("Preview the multi-agent teamwork workflow."  @ 107,480,810)
   |
   +-- {first bracket of the request holds a listed name?}
   |      |
   |      +-- yes, `[skip-interview]` -------------------------------+
   |      |                                                          |
   |      `-- no: [teamwork_interviewer]                             |
   |               |  payload: "Teamwork state folder:" / "Relay to:" |
   |               |           "Parameters:" / "Request (verbatim):"  |
   |               |  no timer is set; the run waits indefinitely     |
   |               v                                                  |
   |          {approved task prompt}   first one wins; later ignored  |
   |               |                                                  |
   |               +-- interviewer killed once the run routes --------+
   |                                                                  |
   v                                                                  v
{SENTINEL route decision}   fixed order: Document Review -> LEMMA -> General (formal math, no explicit Lean)
   |                        -> Math / Proof (Large Team) -> Math / Proof -> SWE Light -> General
   |
   +.. side obligation: BRIEFING.md  (re-read if no longer in context; create if absent;
   |                    record the routing decision and rationale)
   |
   v
(record .agents/teamwork/ORIGINAL_REQUEST.md)      exactly once, BEFORE the chosen agent starts;
   |                                               never the pre-approval request text
   |
   +-- if the chosen route's summary row marks a pre-flight audit:
   |      [teamwork_dependency]  {BLOCKING}
   |         +-- MISSING / OUTAGE --> relay + STOP   (terminal, no agent spawned)
   |         `-- READY ------------> continue, passing the READY report verbatim
   |
   v
[route agent]     teamwork_orchestrator | teamwork_document | teamwork_lean
   |              teamwork_pipeline     | teamwork_proof    | teamwork_swe
   |
   +.. "Your Teamwork run has started—execution is now under way."  sent once,
   |   only after the first dispatch returns a run and only after a pre-flight audit
   |   has let the run start; never again
   |
   +.. monitoring: Cron 1 progress (*/8) and Cron 2 liveness (*/20) @ 113,255,355 / 113,255,856
   |
   v
{outcome}  -> route-specific verification (§4) -> VICTORY CONFIRMED -> Cleanup -> report
                                                -> VICTORY REJECTED -> forward full report, resume team
                                                -> mid-run pause     -> relay, keep monitoring open
                                                -> terminal non-victory stop -> Cleanup, relay as unverified
   |
   `.. side obligation: handoff.md (Observation, Logic Chain, Caveats, Conclusion, Verification Method)
```

### 1.1 Spine edge evidence

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| S1 | `/teamwork` → `teamwork_interviewer` (default) | Sentinel `## Workflow Protocol` step 1: "until you route, dispatch only the teamwork_interviewer" @ 113,276,251; Task Interview section @ 113,261,255; dispatch payload @ 113,262,735 | OBSERVED (R1) |
| S2 | `[skip-interview]` suppresses S1 | Parameter table row `skip-interview` @ 113,261,163; "route on the rest of the request as received" | OBSERVED (R1) |
| S3 | `teamwork_interviewer` → approved prompt → sentinel | `Approved task prompt:` @ 113,263,893; "Route on the first approved prompt that reaches you; a later copy… ignore it" | OBSERVED (R1) |
| S4 | interviewer torn down after routing | 113,265,411 ("…once you route.") | OBSERVED (R1) |
| S5 | sentinel → route agent | `### Route Summary` @ 113,265,667; Decision Process step 4 "Spawn the chosen agent directly" @ 113,270,345; D1 names all seven dispatch targets @ 108,451,228 | OBSERVED (R1 + R2) |
| S6 | record `ORIGINAL_REQUEST.md` before the agent starts | "record the text you route on … once, before that agent starts, in `.agents/teamwork/ORIGINAL_REQUEST.md` (not the workspace root)" @ 113,276,573 | OBSERVED (R1) |
| S7 | `BRIEFING.md` re-read / create | 113,277,330; template @ 113,246,504 (Situational Awareness @ 113,245,880); routing rationale @ 113,271,547 | OBSERVED (R1) |
| S8 | `handoff.md` obligation on every agent | 113,278,028; `handoff.md` literal @ 108,613,368 with `Verification Method` @ 108,613,447 | OBSERVED (R1) |
| S9 | pre-flight audit sits between recording and spawn | Sentinel job (3): "If the Route Summary marks the chosen path as needing a pre-flight audit, dispatch teamwork_dependency first… The audit is BLOCKING" @ 113,242,112–113,243,024 | OBSERVED (R1); the exact ordering against `ORIGINAL_REQUEST.md` is INFERRED from the Workflow Protocol's numbered steps |
| S10 | start acknowledgement sent once | 113,264,707; "Send it only after any pre-flight audit has let the run start, and never again" | OBSERVED (R1) |
| S11 | monitoring crons | Cron 1 `*/8` @ 113,255,355; Cron 2 `*/20` @ 113,255,856 | OBSERVED (R1) |

The spine has **no** route-specific content, and the sentinel's own constraints forbid it from acquiring any: "You MUST NOT write code, analyze problems, or make any technical decisions. Keep your context ultra-light." @ 113,243,665. The sentinel's four jobs are record, monitor, choose-and-start, and handle-outcome, stated at the head of the sentinel block that begins at 113,241,709 (36,482 bytes, ending 113,278,190).

### 1.2 Side obligations are not pipeline nodes

`BRIEFING.md`, `handoff.md`, `progress.md`, `DISPATCH.md` and the `.agents/teamwork/<type>_<milestone>/` folder convention are written by **every** agent that executes a node, so drawing them as edges would connect every node to every other node and convey nothing. They are drawn as `..>` annotations above and are governed by `prompts/sentinel-routing.md` (# Situational Awareness, # File Workspace Convention) and `05-coordination-and-artifacts.md` §6. Monitoring (`Cron 1`/`Cron 2`) is likewise a property of the spine, not a route stage: it observes the active orchestrator, it does not feed it.

---

## 2. Route topologies

### 2.0 Coverage summary

Counts are per DAG edge, not per table row; a row whose type is named but whose dispatch site is not evidenced counts as "partly inferred".

| Route | Entry agent | Edges fully OBSERVED | Partly inferred / unknown site | Edges UNKNOWN |
|---|---|---|---|---|
| General | `teamwork_orchestrator` | 7 | 2 | 1 |
| Document Review | `teamwork_document` | 11 | 1 | 1 |
| Formal Math / LEMMA | `teamwork_lean` (binding INFERRED) | 7 | 4 | 1 |
| Math / Proof | `teamwork_pipeline` | 14 | 1 | 1 |
| Math / Proof (Large Team) | `teamwork_proof` | 22 | 2 | — |
| SWE Light | `teamwork_swe` | 13 | 2 | 1 |

---

### 2.1 General — `teamwork_orchestrator`

**Coverage.** The entry edge and the milestone-gate loop are OBSERVED. The orchestrator's *complete* child roster is not: its prompt names an example type list in the state-folder convention, and the gate table shows four concrete gate roles. Repository-wide dispatch of a document sub-flow is INFERRED and may not exist.

```text
[SENTINEL]
   |
   `--> [teamwork_orchestrator]      ("assess complexity, plan topology, dispatch tasks, manage subagents")
           |
           +-- per milestone, a gate iteration -------------+
           |                                               |
           |   [teamwork_explorer] --------+               |   investigation / approach change
           |                               |               |
           |   [teamwork_worker] ----------+               |   implementation (branch workspace)
           |                               |               |
           |   [teamwork_reviewer] --------+--> {gate}     |   APPROVE / REQUEST_CHANGES
           |                               |      |        |
           |   [teamwork_challenger] ------+      |        |   confirms correctness
           |                               |      |        |
           |   [teamwork_auditor] ---------+      |        |   CLEAN / INTEGRITY VIOLATION
           |                                      v        |
           |                            (GATE_STATUS.md)   |
           |                            PASS --> next milestone
           |                            FAIL --> loop back (oscillation guard after 2 identical failures)
           |                                               |
           +-----------------------------------------------+
           |
           +.. if a document is supplied: [teamwork_document] sub-flow (§2.2)   INFERRED, not evidenced
           |
           +.. optional recursive sub-orchestrator: teamwork_sub_orch   UNKNOWN
           |
           `--> victory claim --> [teamwork_victory_auditor]   (profile: General Project)
```

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| G1 | `SENTINEL` → `teamwork_orchestrator` | Route Summary **General** row @ 113,265,667; D1 dispatch list @ 108,451,228 | OBSERVED (R1+R2) |
| G2 | `teamwork_orchestrator` → `teamwork_explorer` / `worker` / `reviewer` / `challenger` / `sub_orch` | State-folder convention: "`<type>`: `teamwork_explorer`/`worker`/`reviewer`/`challenger`/`sub_orch`, etc." @ 114,745,365; role line "assess complexity, plan topology, dispatch tasks, manage subagents" @ 115,044,163 | INFERRED (R4) — the list is a naming example, not an enumerated dispatch set |
| G3 | `teamwork_orchestrator` → `teamwork_worker` (per milestone) | Gate example: "`worker_1 \| teamwork_worker \| DONE (build passed)`" @ 114,761,631; "Build and tests pass in an independent post-edit verifier run" | OBSERVED (R3) for the role; milestone granularity INFERRED |
| G4 | `teamwork_worker` → `teamwork_reviewer` | Gate example "`reviewer_1 \| teamwork_reviewer \| REQUEST_CHANGES`" @ 114,761,700; pass criterion "**Every** Reviewer verdict is APPROVE" @ 114,762,647 | OBSERVED (R3) |
| G5 | gate → `teamwork_challenger` | Gate example "`challenger_1 \| teamwork_challenger \| APPROVE`" @ 114,761,769 | OBSERVED (R3) |
| G6 | gate → `teamwork_auditor` | "`auditor_1 \| teamwork_auditor \| CLEAN`" @ 114,761,834; "**Evaluate the teamwork_auditor verdict FIRST** … if INTEGRITY VIOLATION, skip all criteria" @ 114,762,023 | OBSERVED (R3) |
| G7 | gate → `GATE_STATUS.md` (`PASS` / `FAIL`) | "Write `Gate Result: **PASS**` in `GATE_STATUS.md`" @ 114,761,890 | OBSERVED (R3) |
| G8 | spawn budget `128` per orchestrator | "Count the agents you spawn … do not exceed `128`" @ 114,744,315 | OBSERVED (R3) — budget, not an edge |
| G9 | `teamwork_orchestrator` → document sub-flow | D3: "Analysis-pattern orchestrator (Main Orchestrator). Triages the paper into segments, dispatches teamwork_group per segment…" @ 108,392,625 | INFERRED — no recovered text shows `teamwork_orchestrator` dispatching `teamwork_document`; the Document Review route is the only evidenced dispatcher |
| G10 | victory claim → `teamwork_victory_auditor` | Route Completion Verification "Any other route — spawn `teamwork_victory_auditor`" @ 113,273,475; auditor profile "General Project" @ 113,236,331 | OBSERVED (R1+R2) |
| G11 | `teamwork_orchestrator` → `teamwork_sub_orch` | Type stem present in the example list only | UNKNOWN (R5) |

**What this diagram does not claim.** It does not claim a fixed pipeline: General is the catch-all route and its orchestrator is told to *choose* a topology ("assess complexity, plan topology"). The gate is the only recurring structure evidenced by concrete agent names, and it is a **milestone** loop, not a document or proof tree. Nor does it claim `teamwork_explorer` is always spawned — the gate table is illustrative, and the prompt says so ("Illustrative names… use actual dispatched subagent names").

---

### 2.2 Document Review — `teamwork_document`

**Coverage.** This is the best-evidenced non-trivial topology in the corpus: the main orchestrator's prompt contains an architecture diagram in ASCII, the RSA tree shapes, the group-orchestrator dispatch, and the synthesis sub-tree. All of it is OBSERVED. The leaf-orchestrator type name and `teamwork_spec_miner`'s participation are the only gaps.

```text
[SENTINEL]  --route: a document is supplied AND the deliverable is an assessment-->
   |
   +-- pre-flight [teamwork_dependency] {BLOCKING: READY | MISSING | OUTAGE}   (§3)
   |
   v
[teamwork_document]   "Main Orchestrator"  (analysis-pattern orchestrator; self-succeeds on context exhaustion)
   |
   +-- Phase 1: TRIAGE ------------------------------------------------+
   |      |  .pdf input only:                                         |
   |      |     [teamwork_ingestor]  -- pure-Python pypdfium2          |
   |      |        `..> scratch/document_pages/*.png (200 DPI)         |
   |      |        `..> DOCUMENT_TEXT_MAP.md                          |
   |      |  .tex input: read directly (no ingestor)                   |
   |      `..> (ANALYSIS_PARTITION.md)   segments + input_format        |
   |                                                                   |
   +-- Phase 2: PER-SEGMENT RSA, one group per segment (parallel) ----+
   |      |
   |      +--> [teamwork_group]  "segment A"     tree shape [4,2,1]
   |      |        +--> [teamwork_worker] x4      analysts        (Level 0)
   |      |        +--> [teamwork_worker] x2      review aggregators (Level 1)
   |      |        +--> [teamwork_worker] x1      aggregator       (Level 2)
   |      |        `..> (unit_report_<segment>.md)
   |      |
   |      +--> [teamwork_group]  "segment B" ... same shape
   |      |
   |      `--> ... one per segment
   |
   +-- Phase 3: CROSS-SEGMENT SYNTHESIS -------------------------------+
   |      |
   |      `--> [teamwork_group]  "synthesis"    tree shape [4,1]
   |               +--> [teamwork_synthesizer] x4     candidate reports
   |               |      `..> (.agents/teamwork/synthesis/candidate_<index>.md)
   |               `--> [teamwork_synthesizer] x1     reducer
   |                      `..> (DOCUMENT_REVIEW_REPORT.md)
   |
   `--> victory claim --> [teamwork_document_victory_auditor]  (profile: Document Review Project)
```

Per-segment candidate handoffs and the synthesis candidates are the two on-disk artifacts that make the tree legible after the fact: `.agents/teamwork/segment_<segment_name>/handoff_<candidate_index>.md` @ 115,094,780 and `.agents/teamwork/synthesis/candidate_<index>.md` @ 115,099,834.

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| B1 | `SENTINEL` → `teamwork_document` | Route Summary **Document Review** row @ 113,266,610; D1 @ 108,451,228 | OBSERVED (R1+R2) |
| B2 | `teamwork_document` → `teamwork_ingestor` (PDF only) | D3 role text names `teamwork_ingestor` "for PDF extraction" @ 108,392,625; imperative dispatch `TypeName="teamwork_ingestor"`, "Ingest the PDF document at `<pdf_path>` into page images and DOCUMENT_TEXT_MAP.md." @ 115,069,973 | OBSERVED (R1+R3) |
| B3 | `teamwork_document` → `(ANALYSIS_PARTITION.md)` | "Orchestrator reads paper, writes ANALYSIS_PARTITION.md" @ 115,089,330; path literal @ 112,101,333 | OBSERVED (R3) |
| B4 | `teamwork_document` → `teamwork_group` × segments | D3 "dispatches teamwork_group per segment for RSA tree execution" @ 108,392,625; "For each segment, you MUST dispatch one Group Orchestrator" @ 115,091,070 | OBSERVED (R1+R3) |
| B5 | `teamwork_group` → `teamwork_worker` (analysts + aggregators) | D4 "Dispatches teamwork_worker (analysts and aggregators)" @ 108,391,900; role table rows `Analyst \| teamwork_worker`, `Review Aggregator \| teamwork_worker` @ 115,088,571 | OBSERVED (R1+R3) |
| B6 | `teamwork_group` → 4 → 2 → 1 tree | `review_tree_shape` @ 115,074,350; "The tree shape `[4, 2, 1]` is a mandatory level-by-level contraction schedule" @ 115,092,467; "Level 0: 4 Analysts" @ 115,089,557 | OBSERVED (R3) |
| B7 | `teamwork_document` → one `teamwork_group` for synthesis | "The Main Orchestrator spawns one `teamwork_group`… synthesis tree shape `[4, 1]`" @ 115,097,842 | OBSERVED (R3) |
| B8 | synthesis group → `teamwork_synthesizer` ×4, then reducers | D4 "Dispatches … teamwork_synthesizer (synthesizers and reducers)" @ 108,391,900; "Dispatch `4` parallel **Synthesizer** agents (`teamwork_synthesizer`)" @ 115,098,219 | OBSERVED (R1+R3) |
| B9 | levels ≥1 reduce with the same archetype | "Dispatch the required number of **Reducer** agents (`teamwork_synthesizer` — same archetype as Level 0)" @ 115,098,219 | OBSERVED (R3) |
| B10 | `teamwork_document` self-succeeds | Architecture block: "[Main Orchestrator] … self-succeeds … [Successor]" @ 115,089,204 | OBSERVED (R3) |
| B11 | "Leaf Orch" exists below the group orchestrator | "Level: Main Orchestrator, Group Orch, or Leaf Orch" @ 115,090,383 | OBSERVED (existence) / UNKNOWN (type name) |
| B12 | victory claim → `teamwork_document_victory_auditor` | "`teamwork_document` — spawn `teamwork_document_victory_auditor`, which carries the document-review forensics the plain auditor does not" @ 113,275,546; profile "Document Review Project" @ 113,556,848 | OBSERVED (R1+R2) |
| B13 | `teamwork_spec_miner` participates | D7 exists @ 108,404,367, but no document-review prompt names it | UNKNOWN (R5) |

**What this diagram does not claim.** The `.tex` path is drawn with the ingestor absent because the prompt says so: "When the paper path ends in `.tex`, skip PDF ingestion entirely" @ 115,069,973 region. The architecture block also shows a `[Sentinel]` above the Main Orchestrator, which is consistent with B1 but is prompt decoration, not a second edge. The RSA tree is a **fan-out/fan-in symmetry**: "At every level, the orchestrator that fans out (decomposes) is paired with a synthesizer that fans in" @ 115,091,587 — which is why analysts and aggregators are both `teamwork_worker` while the synthesis side uses `teamwork_synthesizer`.

---

### 2.3 Formal Math / Lean 4 (LEMMA) — `teamwork_lean`

**Coverage.** The dispatch set is OBSERVED from D2, and the orchestrator's operating loop is OBSERVED from its own directive. Three edges are not: where `teamwork_verifier`, `teamwork_formalizer` and `teamwork_formalization_reviewer` are invoked in the loop, because the orchestrator's own dispatch table has no row for them. The type-name binding of the route target is INFERRED (registry, D2 note) and is flagged in §7.

```text
[SENTINEL] --route: explicit "prove/check in Lean 4"-->
   |
   +-- pre-flight [teamwork_dependency] {BLOCKING}  -- leap-tools + Lean setup required
   |      `-- MISSING -> relay final notice, STOP before any work
   v
[teamwork_lean]   (= D2 "Orchestrator dedicated to the LEMMA formal proof pipeline pattern in Lean 4")
   |
   +-- Phase 0: formalization gate ----------------------------+
   |      [teamwork_formalizer]                               |  informal problem -> problem_draft.lean (compiles)
   |            |                                              |
   |            `--> [teamwork_formalization_reviewer]        |  APPROVE / REQUEST_CHANGES
   |                     `..> problem.lean (on APPROVE)        |
   |                                                           |
   +-- Phase 0': disproof check (after a root refutation) -----+
   |      [teamwork_formalization_reviewer]  { FAITHFUL | MISFORMALIZED }
   |
   +-- Dispatch loop (state_manager_bin claim_next) -----------+
   |      pool: up to 8 concurrent workers                    |
   |                                                          |
   |      claim metadata.phase / metadata.role                |
   |        |                                                 |
   |        +-- informal  -> [teamwork_planner]   writes the blueprint, no Lean
   |        +-- formal    -> [teamwork_worker]    proves or decomposes the target
   |        +-- disprove  -> [teamwork_worker]    derives False, taken as an axiom
   |        +-- review    -> [teamwork_reviewer]  rules on a decomposition, no Lean
   |        `-- blocked   -> (not dispatchable)
   |
   +-- Verification -------------------------------------------+
   |      [teamwork_verifier]   D2 names it                       "kernel acceptance + allowed axioms"
   |      [teamwork_lemma_verifier archetype] -> lean_verifier_tool_bin / state_manager_bin
   |      [teamwork_formalization_reviewer]  final faithfulness: FAITHFUL / UNFAITHFUL
   |
   `--> terminal: kernel-checked proof or disproof  --> sentinel reports it, NO auditor
```

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| L1 | `SENTINEL` → `teamwork_lean` | Route Summary **Formal Math / Lean 4 (LEMMA)** row @ 113,267,369; D1 @ 108,451,228 | OBSERVED (R1+R2) |
| L2 | `teamwork_lean` is the agent D2 describes | D2 @ 108,372,219; route target of the LEMMA row. Alternative candidate `teamwork_orchestrator_lemma` exists only as the stem `orchestrator_lemma` @ 48,230,833 | INFERRED (R1 role, R4 binding) — registry records this binding as unproven |
| L3 | orchestrator → `teamwork_planner` (informal phase) | D2 dispatch list @ 108,372,219; dispatch-as table: `informal` / `"lemma_informal_prover"` → **`teamwork_planner`** @ 114,088,176 | OBSERVED (R1+R3) |
| L4 | orchestrator → `teamwork_worker` (formal + disprove) | D2; table rows `formal` and `disprove` / `"lemma_proof_worker"` → **`teamwork_worker`** @ 114,088,176 | OBSERVED (R1+R3) |
| L5 | orchestrator → `teamwork_reviewer` (review phase) | D2; table row `review` / `"lemma_decomposition_reviewer"` → **`teamwork_reviewer`** @ 114,088,176 | OBSERVED (R1+R3) |
| L6 | orchestrator → `teamwork_verifier` | D2 dispatch list names it @ 108,372,219 | OBSERVED as a named target (R1) / UNKNOWN as to dispatch site — no `claim_next` row dispatches it |
| L7 | orchestrator → `teamwork_formalizer` | D2 names it; formalizer directive "translates an informal problem statement into a faithful, compiling Lean 4 problem file before LEMMA proof search begins" @ 111,270,943 | OBSERVED (R1) / UNKNOWN dispatch site |
| L8 | orchestrator → `teamwork_formalization_reviewer` | D2 names it; directive @ 111,164,752 | OBSERVED (R1) / UNKNOWN dispatch site |
| L9 | orchestrator ↔ state manager (`claim_next`) | "You are a DISPATCH-ONLY orchestrator for the LEMMA Formal Proof Pipeline" @ 114,077,580; `claim_next` actions @ 114,086,928; "You are the only agent permitted to invoke subagents. No subagent may spawn another." @ 114,077,580 | OBSERVED (R3) |
| L10 | worker pool of 8 | "Maintain a pool of up to **8** concurrent workers" @ 114,086,125 | OBSERVED (R3) |
| L11 | `lemma_*` names are archetypes, not dispatch names | Recovered table + "It is **not** the name to dispatch" @ 114,088,176; registry Appendix A | OBSERVED (R3) |
| L12 | `teamwork_orchestrator_lemma` is the orchestrator | Stem `orchestrator_lemma` @ 48,230,833; no role text | UNKNOWN (R5) — cannot be separated from L2 by string evidence |

**What this diagram does not claim.** It does not claim `teamwork_formalizer` and `teamwork_formalization_reviewer` are inside the `claim_next` loop. Their prompts describe a **pre-search** gate ("before LEMMA proof search begins") and a **post-verification** faithfulness check, which is why they are drawn before and after the claim loop rather than inside it. It also does not claim the verifier is a subagent the orchestrator spawns: `teamwork_verifier` is named by D2 and `lemma_verifier` (archetype) invokes `lean_verifier_tool_bin` directly, so the boundary between "verifier agent" and "verifier binary" is UNKNOWN.

**The `teamwork_lemma_*` names.** The registry carries six: `lemma_formalizer`, `lemma_proof_worker`, `lemma_proof_verifier`, `lemma_informal_prover`, `lemma_decomposition_reviewer`, `lemma_formalization_reviewer`. Only two are evidenced as prompt identities — `teamwork_formalizer` @ 111,270,943 and `teamwork_formalization_reviewer` @ 111,164,752 — and the `claim_next` table binds `lemma_informal_prover`, `lemma_proof_worker` and `lemma_decomposition_reviewer` to the generic dispatch types `teamwork_planner`, `teamwork_worker` and `teamwork_reviewer` @ 114,088,176. `lemma_proof_verifier` is bound to no directive and no table row. So the `teamwork_lemma_*` set is a **phase/archetype vocabulary**, not a set of dispatch targets (registry Appendix A); §2.3 draws only the dispatch targets.

**Naming ambiguity — `teamwork_lean` vs `teamwork_orchestrator_lemma` (UNKNOWN).** The directive that actually runs the LEMMA pipeline is "a DISPATCH-ONLY orchestrator for the LEMMA Formal Proof Pipeline" @ 114,077,580, and the registry's name for a LEMMA-scoped orchestrator is `teamwork_orchestrator_lemma` (it exists only as the stem `orchestrator_lemma` @ 48,230,833). But the sentinel's route target is `teamwork_lean` (type @ 105,881,561), and D2 — the only recovered role text for a LEMMA orchestrator — is that route's description. `teamwork_orchestrator_lemma` has **no** recovered role text; `teamwork_lean` has no recovered imperative prompt. The registry therefore carries both names rather than merging them, and this document follows that: the diagrams use `teamwork_lean` because it is the observed dispatch target, while `teamwork_orchestrator_lemma` remains the unproven identity of the directive. Which name the runtime registers for the LEMMA orchestrator is UNKNOWN (registry *Gaps*; §7 gap 8).

Two kernel-level verdict vocabularies are OBSERVED and matter for §4: the Lean check reports `is_valid: true`; the formalization reviewer directive @ 111,164,752 replies `APPROVE` / `REQUEST_CHANGES` @ 111,167,875, then `FAITHFUL` / `MISFORMALIZED`, then `FAITHFUL` / `UNFAITHFUL` @ 111,168,648.

---

### 2.4 Math / Proof — `teamwork_pipeline`

**Coverage.** The route target, the pipeline sentinel's routing branch, the conductor, its per-stage orchestrators, and the `mathematics` stage template with its loop are OBSERVED. The **mergers** named in the brief (`solve`/`verify`/`revise`) are OBSERVED as *proof-route* aggregators and their placement on this route is UNKNOWN — shown as a detached block, not an edge.

```text
[SENTINEL] --route: natural-language math/proof, no large-team request, no explicit Lean 4-->
   |
   v
[teamwork_pipeline]   "Pipeline Sentinel"  (task_router role: "a pipeline sentinel (teamwork_pipeline) for multi-stage pipeline tasks")
   |
   +-- single-stage task --------------------------> [teamwork_orchestrator]  (§2.1)
   |
   `-- multi-stage / template match ---------------+
                                                  v
                                        [teamwork_conductor]  "Pipeline Conductor"
                                          |   "You manage the stage DAG ... you do NOT manage individual workers"
                                          |
                                          +--> [teamwork_pipeline_updater]
                                          |      events: stage_started / stage_completed
                                          |      `..> .pipeline_blackboard_<task_name>.md
                                          |
                                          +--> per stage, a full swarm:
                                          |      |
                                          |      +-- stage "critic" --> [teamwork_critic_orchestrator]   (§5.1)
                                          |      |        +--> [teamwork_updater]        (per-stage blackboard)
                                          |      |        +--> [teamwork_follower] x N   (per-section verifiers)
                                          |      |
                                          |      +-- all other stages --> [teamwork_orchestrator]  "Swarm Orchestrator"
                                          |      |        +--> [teamwork_updater]        (.swarm_blackboard_<stage>_<task>.md)
                                          |      |        +--> worker x N                 type NOT named in the prompt
                                          |      |        `--> [teamwork_synthesizer]     on synthesis trigger
                                          |      |
                                          |      `..> (stage_artifact_<stage_name>_<task_name>.md)
                                          |
                                          +--> stage order (template `mathematics`), sizes by profile:
                                                 generate -> referee -> improve -> critic -> ref_check -> verify -> revise
                                                                                    (critic and ref_check run in parallel)
                                                 revise --loop_to--> referee   while verdict is NOT \boxed{Correct}
                                                 max loops: 2 (small) / 3 (medium) / 5 (large)
                                          |
                                          `..> .pipeline_progress_<task_name>.md

   detached: merger layer   [teamwork_explore_merger] [teamwork_plan_merger] [teamwork_gate_merger]
                            [teamwork_solve_merger]   [teamwork_verify_merger] [teamwork_revise_merger]
                            -- OBSERVED as proof-route aggregators (§2.5); placement here UNKNOWN
```

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| P1 | `SENTINEL` → `teamwork_pipeline` | Route Summary **Math / Proof** row @ 113,269,010; D1 @ 108,451,228 | OBSERVED (R1+R2) |
| P2 | `teamwork_pipeline` is a pipeline sentinel | Sentinel role line: "routes them to either a project orchestrator (teamwork_orchestrator) for standard SWE work, or a pipeline sentinel (teamwork_pipeline) for multi-stage pipeline tasks" @ 113,244,829 | OBSERVED (R1) |
| P3 | pipeline sentinel → `teamwork_conductor` | "spawn a Pipeline Conductor (`TypeName: "teamwork_conductor"`)" @ 111,494,319; sentinel self-description "routes to either a Pipeline Conductor (multi-stage) or Swarm Orchestrator (simple tasks)" @ 111,494,565 | OBSERVED (R3) |
| P4 | pipeline sentinel → `teamwork_orchestrator` (single-stage) | "For ALL OTHER tasks … spawn a Swarm Orchestrator (`TypeName: "teamwork_orchestrator"`)" @ 111,494,446 | OBSERVED (R3) |
| P5 | conductor → `teamwork_pipeline_updater` | "**Spawn the Pipeline Blackboard Updater**: … `TypeName`**: `"teamwork_pipeline_updater"`" @ 111,767,835; updater directive @ 109,973,588 | OBSERVED (R3) |
| P6 | conductor → per-stage `teamwork_orchestrator` | "For all other stages … `TypeName`: `"teamwork_orchestrator"`, `Role`: `"Swarm Orchestrator"`" @ 111,768,885 | OBSERVED (R3) |
| P7 | conductor → `teamwork_critic_orchestrator` for the `critic` stage | "For the `critic` stage specifically … `TypeName`: `"teamwork_critic_orchestrator"`, `Role`: `"Critic Orchestrator"`" @ 111,768,625 | OBSERVED (R3) |
| P8 | conductor → stage artifacts / progress | `.pipeline_progress_<task_name>.md`, `.pipeline_blackboard_<task_name>.md`, `stage_artifact_<stage_name>_<task_name>.md` @ 111,765,949 | OBSERVED (R3) |
| P9 | stage orchestrator → `teamwork_updater` | "At the start of the swarm, spawn exactly one `teamwork_updater` subagent" @ 111,836,180 | OBSERVED (R3) |
| P10 | stage orchestrator → `teamwork_synthesizer` | "immediately spawn the `teamwork_synthesizer` to merge the candidates" @ 111,842,326 | OBSERVED (R3) |
| P11 | stage orchestrator → followers/workers | "spawn a worker … You MUST pass the conversation ID of the blackboard updater"; worker `TypeName` not stated in this prompt | OBSERVED edge (R3) / UNKNOWN worker type |
| P12 | `revise` → `referee` loop | `loop_to: referee` @ 111,499,584; `loop_condition: "verdict is NOT \boxed{Correct}"`; `Termination: success_condition: "verifier verdict is \boxed{Correct}"` | OBSERVED (R3) |
| P13 | `critic` ∥ `ref_check` | "Stages 4 (critic) and 5 (ref_check) both depend only on `improve` … so the Pipeline Conductor should launch them **in parallel**" @ 111,501,844 | OBSERVED (R3) |
| P14 | verify-stage verdict vocabulary | "Correct / Almost Correct / Plausible with Gaps / Critically Flawed" @ 111,499,100 | OBSERVED (R3) |
| P15 | `teamwork_pipeline` → mergers | Names exist (@ 106,553,529, 106,639,761, 106,639,783, 106,478,959, 106,478,999); none is named in the conductor or sentinel prompts | UNKNOWN (R5) |
| P16 | victory claim → `teamwork_victory_auditor` | "Any other route (`teamwork_orchestrator`, `teamwork_pipeline`) — spawn `teamwork_victory_auditor`" @ 113,273,475 | OBSERVED (R1+R2) |

**What this diagram does not claim.** It does not claim the route is a swarm of mergers. The recovered pipeline prompts describe **one swarm per stage** (`teamwork_orchestrator` / `teamwork_critic_orchestrator`) feeding a **synthesizer**, with stage-to-stage handoff through `stage_artifact_*.md` and a `loop_to` edge. The six `*_merger` types are aggregation agents of the *theorem-proving* pipeline (§2.5), where the prompts name them explicitly; whether the Math / Proof route ever instantiates them is UNKNOWN. This is the one place where the reconstruction contradicts a plausible reading of the type names — the names suggest mergers, the prompts show synthesizers.

A second caveat: the pipeline prompts use a **Swarm Workspace Convention** that puts `.pipeline_progress_*`, `.pipeline_blackboard_*`, `.swarm_blackboard_*` and `stage_artifact_*` at the **workspace root**, and explicitly says "Do NOT create legacy folders under `.agents/`" @ 111,765,949. The sentinel's own File Workspace Convention relocates state into `.agents/teamwork/`. Both conventions are OBSERVED; which one governs a `/teamwork` Math / Proof run is UNKNOWN (§7).

---

### 2.5 Math / Proof (Large Team) — `teamwork_proof`

**Coverage.** This is the most fully specified topology in the artifact because the proof orchestrator prompt spells out all five phases, their fan-out counts, the tournament tree semantics, falser pairing, and the delegation protocol. All edges below except two are OBSERVED. The `teamwork_proof` ↔ D8 binding is INFERRED (registry), and the parent of the Phase-4 assembly worker is INFERRED.

```text
[SENTINEL] --route: math/proof AND explicit "very large team / many agents"-->
   |
   v
[teamwork_proof]   "PROOF ORCHESTRATOR"   (= D8: "Top-level 5-phase orchestrator ... delegates each tournament tree level
   |                                        to dedicated teamwork_layer agents. Executes protocol only")
   |
   |   outer iteration loop, at most 32 iterations
   |   v
   +-- Phase 1: STRATEGY EXPLORATION ------------------------------+
   |      [teamwork_layer] level 0: [teamwork_explorer] x32        |  strategy cards
   |            `..> [teamwork_explore_falser] per card            |
   |      [teamwork_layer] levels 1..n: [teamwork_explore_merger]  |  random-sample tree, sample size 5
   |            `..> [teamwork_explore_falser] per synthesized card |
   |      Gate Review (max 3 rounds):                               |
   |        [teamwork_layer] level 0: [teamwork_judge] x8          |  gate verdicts
   |        [teamwork_layer] levels 1..n: [teamwork_gate_merger]   |  tree [8,5,1]
   |        rejected --> next exploration round (<=3), then Phase 2 anyway
   |
   +-- Phase 2: PROBLEM DECOMPOSITION -----------------------------+
   |      [teamwork_layer] level 0: [teamwork_outliner] x8         |  LaTeX skeletons
   |      [teamwork_layer] levels 1..n: [teamwork_plan_merger]     |  -> 1 skeleton, <=10 subproblems
   |
   +-- Phase 3: PARALLEL DEPENDENCY-DRIVEN SOLVING -----------------+
   |      [teamwork_layer] level 0: [teamwork_solver] x8 per subproblem
   |            `..> [teamwork_solve_falser]                        |
   |      [teamwork_layer] levels 1..n: [teamwork_solve_merger]     |  root retry <=3 on reject/falsified/needs_repair
   |            `..> [teamwork_solve_falser] per node               |
   |      (teamwork_checker deliberately skipped in this phase)     |
   |
   +-- Phase 4: PARALLEL GLOBAL VERIFICATION -----------------------+
   |      [teamwork_worker] x1   -- mechanical assembly, placeholder substitution
   |      [teamwork_layer] level 0: [teamwork_referee] x8          |  verifier audit + falser audit in one report
   |      [teamwork_layer] levels 1..n: [teamwork_verify_merger]   |  tree [8,5,1] -> Accept / Reject
   |      Accept --> final_proof.tex, stop                          |
   |
   +-- Phase 5: SURGICAL REVISION & STRATEGY ROLLBACK ---------------+
   |      major/structural --> status: strategy_abort, roll back to Phase 1
   |      moderate  --> [teamwork_replanner] x8 -> [teamwork_revise_merger]   (outline revision)
   |      minor/moderate --> [teamwork_patcher] x8 per broken section ->
   |                         [teamwork_revise_merger] -> [teamwork_solve_falser]
   |      then re-run Phase 4; accepted -> stop; rejected -> next iteration
   |
   +-- between levels: [teamwork_curator]  (knowledge directory; proof-level only, never layer-level)
   |
   `.. self-succession between complete outer iterations
```

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| T1 | `SENTINEL` → `teamwork_proof` | Route Summary **Math / Proof (Large Team)** row @ 113,268,594; D1 @ 108,451,228 | OBSERVED (R1+R2) |
| T2 | `teamwork_proof` is D8's orchestrator | D8 "Top-level 5-phase orchestrator for the theorem-proving pipeline … delegates each tournament tree level to dedicated teamwork_layer agents" @ 108,390,701; "You are the PROOF ORCHESTRATOR … You run the 5-phase outer loop and delegate ALL tree-level execution to teamwork_layer agents" @ 115,373,006; "**Proof Orchestrator** (`teamwork_proof`)" @ 115,416,520 | OBSERVED (R3) / D8-type binding INFERRED per registry |
| T3 | proof orchestrator → `teamwork_layer`, one per tree level, sequential | "Invoke one teamwork_layer per tournament tree level" @ 115,373,006; "Level 0 contains 32 input candidates… forbidden to skip levels" @ 115,410,200 | OBSERVED (R1+R3) |
| T4 | layer orchestrator → its level's agents | "You are a LAYER ORCHESTRATOR managing one level … of a tournament tree" and `level_type` assignment @ 114,907,336; "`level_type`: Target archetype for this level (e.g., teamwork_explorer, teamwork_explore_merger, teamwork_solver)" @ 115,373,006 | OBSERVED (R3) |
| T5 | layer → sub-layer when >32 nodes | "When `num_nodes > 32`, partition into sub-layer `teamwork_layer` instances" @ 114,942,300 | OBSERVED (R3) |
| T6 | Phase 1 → `teamwork_explorer` ×32 | "Dispatch `32` parallel `teamwork_explorer` agents. Each produces a compact strategy card" @ 115,420,399 | OBSERVED (R3) |
| T7 | exploration → `teamwork_explore_falser` per node | "Dispatch `teamwork_explore_falser` agents to audit each generated strategy card"; "Interleaved Every-Node Audit" @ 115,420,516 | OBSERVED (R3) |
| T8 | tournament aggregation → `teamwork_explore_merger` | "dispatching `teamwork_explore_merger` subagents at each level" @ 115,420,998 | OBSERVED (R3) |
| T9 | Gate Review → `teamwork_judge` ×8 | "Dispatch `8` parallel `teamwork_judge` agents to audit the winning strategy card" @ 115,422,867 | OBSERVED (R3) |
| T10 | gate aggregation → `teamwork_gate_merger`, tree `[8,5,1]` | "dispatching `teamwork_gate_merger` subagents at each level" @ 115,423,043 | OBSERVED (R3) |
| T11 | Phase 2 → `teamwork_outliner` ×8, then `teamwork_plan_merger` | "Dispatch `teamwork_outliner` agents (using `8` parallel samples)… dispatching `teamwork_plan_merger` subagents" @ 115,424,050 / 115,424,271 | OBSERVED (R3) |
| T12 | Phase 3 → `teamwork_solver` ×8 per subproblem, `teamwork_solve_falser`, `teamwork_solve_merger` | "For each subproblem, dispatch `8` parallel `teamwork_solver` agents"; "Dispatch `teamwork_solve_falser` agents"; "dispatching `teamwork_solve_merger`" @ 115,426,036 / 115,426,603 | OBSERVED (R3) |
| T13 | Phase 3 root retry ≤3 | "Retry on `reject`, `falsified`, or `needs_repair` **only** at the final root … up to **3** attempts" @ 114,942,300 | OBSERVED (R3) |
| T14 | Phase 3 skips `teamwork_checker` | "Intermediate per-subproblem `teamwork_checker` execution is completely skipped during Phase 3" @ 115,427,674 | OBSERVED (R3) |
| T15 | Phase 4 assembly → one `teamwork_worker` | "delegate the assembly of the primary proof draft to one `teamwork_worker` subagent" @ 115,429,443 | OBSERVED edge (R3) / INFERRED parent (the prompt does not say whether the orchestrator or a layer dispatches it) |
| T16 | Phase 4 → `teamwork_referee` ×8 | "Dispatch `8` `teamwork_referee` agents… Each reviewer must perform both roles in a single report" @ 115,430,550 | OBSERVED (R3) |
| T17 | referee doubles as falser | "each also performs an adversarial falser audit" @ 115,410,200; "**Falser audit**: actively attempt to construct counterexamples" @ 115,430,550 | OBSERVED (R3) |
| T18 | Phase 4 aggregation → `teamwork_verify_merger`, tree `[8,5,1]` | "At each node, dispatch one `teamwork_verify_merger`" @ 115,432,091 | OBSERVED (R3) |
| T19 | Phase 5 outline → `teamwork_replanner` + `teamwork_revise_merger` | "Dispatch `teamwork_replanner` agents … dispatching `teamwork_revise_merger` subagents at each aggregation level" @ 115,433,866 | OBSERVED (R3) |
| T20 | Phase 5 patching → `teamwork_patcher` + `teamwork_revise_merger` + `teamwork_solve_falser` | "Dispatch parallel `teamwork_patcher` agents (`8` samples per section, up to `5` sections simultaneously)" @ 115,435,016; falser pairing list @ 114,942,300 | OBSERVED (R3) |
| T21 | proof orchestrator → `teamwork_curator` between levels | "Do not dispatch `teamwork_curator`; `teamwork_proof` runs curators between tree levels" @ 114,942,569 | OBSERVED (R3, by explicit division of labour) |
| T22 | proof orchestrator self-succession between iterations | "Triggers self-succession between complete outer iterations to prevent context exhaustion" @ 115,416,520 | OBSERVED (R3) |
| T23 | iteration cap 32 | "an **outer iteration loop** (up to `32` iterations)" @ 115,408,069 | OBSERVED (R3) |
| T24 | sentinel grants ≥60-minute timeouts on this route | "On the teamwork_proof path also grant extended timeouts (at least 60 minutes) to workers drafting dense mathematical structures" @ 113,243,471 | OBSERVED (R1) |
| T25 | victory claim → `teamwork_victory_auditor` at the sentinel | Route table: "`teamwork_proof` — already verified by that pipeline's own verification phase" @ 113,273,475 | OBSERVED (R1+R2) — **no** sentinel auditor on this route |
| T26 | `teamwork_referee` / `teamwork_judge` are "tournament judging candidates" only | Both are dispatched explicitly in Phases 4 and 1 respectively, so the narrower "candidate" reading is superseded | OBSERVED (R3) — see §7 for the residual `teamwork_auditor`-vs-`judge` ambiguity |

**What this diagram does not claim.** It does not claim the layer is a *separate pipeline*: the layer exists solely to keep any orchestrator under 32 direct subagents, and it is forbidden to evaluate quality. It does not claim `teamwork_judge` is a victory auditor: the judge audits a **strategy card** at the Phase 1 gate, not the finished work. It does not claim `teamwork_referee` and `teamwork_explore_falser` are interchangeable: the referee produces a combined `verifier_audit` + `falser_audit` report at Phase 4, while the explore/solve falsers audit individual candidates at tree nodes. And it does not claim `teamwork_victory_auditor` participates — the sentinel explicitly does not spawn one on this route.

On the three "tournament judging candidates" named in the extraction brief: two are now evidenced and one is not. `teamwork_referee` is the Phase 4 combined reviewer @ 115,430,550 and `teamwork_judge` is the Phase 1 gate reviewer @ 115,422,867, so the INFERRED label is superseded for both. `teamwork_victory_auditor` has no tournament role anywhere in the recovered text; it is the route-completion auditor (§4) and is not spawned on this route at all. No edge to `teamwork_victory_auditor` was inferred from its name alone.

---

### 2.6 SWE Light — `teamwork_swe`

**Coverage.** Fully OBSERVED, and deliberately the simplest: a two-agent alternating loop with a ledger, a test-execution gate, and a bounded victory audit. One edge — fresh agent per round — is INFERRED from the general subagent no-reuse rule; `teamwork_test_writer` has no evidence at all.

```text
[SENTINEL] --route: ONE self-contained change AND explicit "small / quick / cheap / focused"-->
   |
   v
[teamwork_swe]   "Dispatch-only orchestrator"  (D5)   -- does NOT write code, does NOT decompose
   |
   |  iteration n = 1..32
   |  v
   +--> [teamwork_implementer]     (once, on the WHOLE task)
   |        |   receives: <original_task> verbatim + Additional Context (State folder)
   |        `..> working diff in the repository
   |
   +--> [teamwork_reviewer]        (round 1)   tries to BREAK the diff, then fixes it
   |        |   receives: <original_task> verbatim + <prior_attempt> verbatim
   |        `..> full report: issues, edits, caveats, unverified aspects, test output
   |
   +--> [teamwork_reviewer]        (round 2)   sees round 1's actual diff + actual test output
   |        `..> same
   |
   +--> ... repeat until the ledger closes or 32 iterations
   |
   +.. OPEN-ISSUES LEDGER (orchestrator-owned, one line per open item)
   |      add: every "Unverified aspects" / "Known Issues" / "Remaining risk & next step"
   |      close: only on test output showing resolution, or the orchestrator's own re-run
   |      never close because a later round stopped mentioning it
   |      every open item is re-sent in Additional Context of EVERY later dispatch
   |
   +.. orchestrator re-runs the relevant tests itself after the last change
   |
   `--> {ledger empty AND latest review found 0 issues / 0 edits AND own test run passes}
           |
           +-- yes --> [teamwork_victory_auditor]   BLOCKING, at most 2 audits
           |              +-- VICTORY CONFIRMED --> report, cite it, done
           |              +-- 1st VICTORY REJECTED --> forward full report into a fresh reviewer round
           |              `-- 2nd VICTORY REJECTED --> STOP, report "unverified open findings"
           |
           `-- 32 iterations without the condition --> one final reviewer round, then either
                  audit (only if it is clean) or report "unverified open findings"
```

| # | Edge | Evidence | Confidence |
|---|---|---|---|
| W1 | `SENTINEL` → `teamwork_swe` | Route Summary **SWE Light** row @ 113,269,431; D1 @ 108,451,228 | OBSERVED (R1+R2) |
| W2 | `teamwork_swe` is D5's agent | D5 "Dispatch-only orchestrator for a single self-contained software engineering task… one teamwork_implementer on the whole task, then repeated teamwork_reviewer rounds" @ 108,450,217; route row; HARD RULES @ 113,697,508 | OBSERVED (R1) / binding INFERRED per registry |
| W3 | `teamwork_swe` → `teamwork_implementer` (once) | D5 "one `teamwork_implementer` on the whole task" @ 108,450,217; shape `teamwork_implementer --> teamwork_reviewer` @ 113,721,299 | OBSERVED (R1+R3) |
| W4 | `teamwork_implementer` → `teamwork_reviewer` | "Rule 2 — Sequential refinement… `teamwork_implementer` … produces a working diff; `teamwork_reviewer` … tries to BREAK that diff, then fixes it" @ 113,722,904 | OBSERVED (R3) |
| W5 | `teamwork_reviewer` → `teamwork_reviewer` (repeat) | "(repeat if anything is still wrong)"; "Dispatch these **one at a time** and wait for each to finish" @ 113,722,904 | OBSERVED (R3) |
| W6 | reviewer round n+1 sees round n's real result | "Each round must see the previous round's actual diff and actual test output" @ 113,727,311; Rule 3 `<prior_attempt>` @ 113,723,949 | OBSERVED (R3) |
| W7 | ledger carried across all rounds | "Rule 8 — Carry an open-issues ledger across ALL rounds" @ 113,727,311 | OBSERVED (R3) |
| W8 | correctness = executing tests | "correctness established by running tests rather than by claims about the code" @ 108,450,217; "Test results are the evidence for that" @ 113,697,860 | OBSERVED (R1+R3) |
| W9 | no decomposition | "This pattern does NOT decompose. Every worker receives the whole task, however large it looks" @ 113,721,182 | OBSERVED (R3) |
| W10 | orchestrator writes no code | "NEVER write, modify, or create source code files yourself. Delegate all implementation and all repair to teamwork_implementer and teamwork_reviewer" @ 113,697,508 | OBSERVED (R3) |
| W11 | termination condition | "at least one teamwork_reviewer round has run after the latest code or test edit, and that latest review round found `0` issues/bugs, applied `0` code or test edits… **and** you personally re-ran the relevant tests" @ 113,729,435; 32-iteration cap | OBSERVED (R3) |
| W12 | → `teamwork_victory_auditor`, blocking, ≤2 | "dispatch teamwork_victory_auditor (passing that `ORIGINAL_REQUEST.md` path)… Run at most two audits" @ 113,730,349 | OBSERVED (R3) |
| W13 | first rejection → fresh reviewer round | "**First `VICTORY REJECTED`**: Forward the full audit report into a sequential teamwork_reviewer" @ 113,731,300 | OBSERVED (R3) |
| W14 | second rejection → terminal unverified | "**Second `VICTORY REJECTED`**: Stop immediately and report `unverified open findings`" @ 113,731,300 | OBSERVED (R3) |
| W15 | fresh agent per round | Sentinel/agent "Iron rule — no reuse after handoff" @ prompts/sentinel-routing.md Subagent Management; not restated in the SWE prompt | INFERRED (R2 generalised) |
| W16 | `teamwork_test_writer` participates | Type @ 106,479,099; no SWE prompt names it | UNKNOWN (R5) |

**What this diagram does not claim.** It does not claim parallel review panels: the prompt forbids them ("Two agents that run the code beat eight agents that have opinions about it" @ 113,722,904). It does not claim the reviewer is read-only: the reviewer is explicitly allowed to fix ("tries to BREAK that diff, then fixes it"). And it does not claim the sentinel audits on this route — the SWE orchestrator owns a **blocking** auditor, and the sentinel only spawns one if a victory claim arrives **without** citing `VICTORY CONFIRMED` @ 113,273,475.

---

### 2.7 Documented roles vs registry roles

The official documentation (`https://antigravity.google/docs/teamwork/`, *Multi-agent architecture and roles*) describes eight roles. Several of those names are literal in the prompts; none is a registry short name. This table is the translation layer, so that a docs role can be followed into the edge tables above without re-deriving it from prose. [DOCS for the role names and their descriptions; OBSERVED for every registry row cited; INFERRED for the mapping, which rests on role semantics — the descriptions on both sides, not on a shared identifier]

| Docs role (DOCS) | Registry short name (OBSERVED) | Runtime type | Row in `02` | Where it appears in this document |
|---|---|---|---|---|
| **Sentinel** | `sentinel@external` | `teamwork` | 46 | Spine §1; no route table |
| **Project Orchestrator** | `orchestrator_pure` (general); `orchestrator_pure@swe_light`; `orchestrator_pure@document_review` | `teamwork_orchestrator` / `teamwork_swe` / `teamwork_document` | 22, 48, 43 | §2.1, §2.6, §2.2 |
| **Explorers** | `explorer` (also `strategy_explorer`, same runtime type) | `teamwork_explorer` | 9, 32 | §2.1, §5.5 |
| **Workers** | `armed_worker`, `armed_worker@colosseum`, `armed_worker@document_review`, `lemma_proof_worker` | `teamwork_worker` | 2, 40, 41, 20 | every route |
| **Critic** | `armed_critic` (and `reviewer_critic` for the combined review+challenge role) | `teamwork_critic` / `teamwork_reviewer` | 1, 26 | §2.1, §2.6, §5.1 |
| **Challenger** | `empirical_challenger` | `teamwork_challenger` | 6 | §2.1, §5.5 |
| **Auditor** | `forensic_auditor` | `teamwork_auditor` | 10 | milestone gates, §4 |
| **Success Auditor** | `victory_auditor`, `victory_auditor@document_review` | `teamwork_victory_auditor` / `teamwork_document_victory_auditor` | 39, 45 | §4, spine outcome |

**Three warnings when using this table.**

1. **"Success Auditor" is not in the binary.** `grep -aobFi 'success auditor'` returns zero hits. The role is real and is described at length, but under the short name `victory_auditor`. A literal search is a false negative, not evidence of absence.
2. **"Project Orchestrator" is prompt vocabulary, not a type.** The phrase is literal in the sentinel prompt — "You manage one subagent: the Project Orchestrator." @ 113,255,284 — and in the orchestrator's own architecture @ 114,750,837, but no registry entry carries that name. The general route's type is `teamwork_orchestrator` (short name `orchestrator_pure`), and the same short name is re-armed for SWE Light and Document Review with different prompts.
3. **"Critic" is not one registry entry.** `armed_critic` is the domain-expert adversarial reviewer; `reviewer_critic` "both objectively reviews AND adversarially challenges". Which one the docs' single role denotes depends on the stage. Do not collapse them.

**A documented edge whose cadence the binary does not state — DOCS-ONLY in its documented form.** The docs say the Project Orchestrator "hands off to a fresh successor between milestones to prevent context degradation". The binary has the succession subsystem — `successor` is a named orchestrator role ("handles self-succession when context grows too large. Writes state, spawns replacement, and exits" @ 114,727,128); the architecture draws `[Project Orchestrator] … self-succeeds … [Successor]` @ 114,750,837–114,750,863; `succession_threshold` appears at 113,710,972 and per-route at 114,116,924 / 114,738,827 / …; `Spawn count: [0] / [succession_threshold]` @ 113,710,952 — but its trigger is a **spawn count**, not a milestone boundary. The edge, labelled:

```text
[Project Orchestrator] --(DOCS-ONLY: between milestones)--> [fresh Successor]
[Project Orchestrator] --(OBSERVED: at succession_threshold spawns)--> [fresh Successor]
```

The second form is the shipped one. `[DOCS for the milestone wording; OBSERVED for the successor role, the self-succeeds edge and the threshold literal; DIVERGENT on cadence — see 10-official-docs-cross-check.md §3.4]` This edge is **not** drawn in the §1 spine or any route diagram, because it is a property of the orchestrator's own context management (like `BRIEFING.md` re-reading), not a dispatch edge between pipeline nodes.

---

## 3. Blocking pre-flight audit

`teamwork_dependency` is **not a route and not a pipeline stage**. It is a gate the sentinel fires *before* spawning the route agent, and only when the `### Route Summary` pre-flight column says so. In the recovered table that is exactly two routes: **Document Review** and **Formal Math / Lean 4 (LEMMA)** @ 113,265,667 / 113,265,703.

```text
{SENTINEL route decision}
   |
   +-- route row's Pre-flight audit column empty --> record request --> spawn route agent
   |
   `-- route row says "required" ------------------+
                                                  v
                             (record .agents/teamwork/ORIGINAL_REQUEST.md first)
                                                  |
                                                  v
                        [teamwork_dependency]   dispatch prompt names:
                             - the chosen path
                             - EVERY file, folder and URL the request names
                             - the audit's verdict vocabulary
                                                  |
                    +-----------------------------+-----------------------------+
                    |                             |                             |
                 READY                          MISSING                       OUTAGE
                    |                             |                             |
        pass the READY report as written      relay final notice verbatim   relay diagnostics
        to the route agent, and again on      then STOP                     then STOP
        every restart                             |                             |
                    |                        install nothing; on a user       no route agent is
                    v                        install request, re-dispatch   ever spawned
             [route agent]                   teamwork_dependency and
                                             re-read the verdict
```

| # | Property | Evidence | Confidence |
|---|---|---|---|
| A1 | It is dispatched before the route agent, not as a route | Sentinel job (3): "If the Route Summary marks the chosen path as needing a pre-flight audit, dispatch teamwork_dependency first, naming that path and giving it every file, folder and URL the request names. The audit is BLOCKING — wait for its verdict." @ 113,242,112 | OBSERVED (R1) |
| A2 | It applies only to Document Review and LEMMA | `Pre-flight audit` column: Document Review "required", LEMMA "required", all four others "—" @ 113,265,667–113,265,703 | OBSERVED (R2) |
| A3 | It must name every file, folder and URL | 113,242,139–113,242,293 | OBSERVED (R1) |
| A4 | Three outcomes, exactly `READY` / `MISSING` / `OUTAGE` | 113,242,420 onward (`READY`), 113,242,584 (`MISSING`), 113,243,024 (`OUTAGE`) | OBSERVED (R1) |
| A5 | `READY` report is passed to the agent verbatim, and again on every restart | "start the agent, giving it the audit's READY report as written, and the same report again whenever you restart it" @ 113,242,420 | OBSERVED (R1) |
| A6 | `MISSING` is terminal for the run; the sentinel installs nothing | "relay its final notice verbatim … then stop. Never install yourself"; re-dispatch on an explicit install request is "an exception to Subagent Management's no-reuse rule" @ 113,242,584 | OBSERVED (R1) |
| A7 | `OUTAGE` is terminal | "relay its diagnostics and stop" @ 113,243,024 | OBSERVED (R1) |
| A8 | The auditor's own role | "Environment and dependency auditor: probes backend tool services, runtimes, and packages for execution paths and reports readiness verdicts" @ 112,766,136; `OUTAGE` appears in its prompt @ 112,765,519 | OBSERVED (R1) |
| A9 | LEMMA's stop-before-work depends on it | "The route 'stops before any work'; the pre-flight `teamwork_dependency` audit returns `MISSING`…" @ 113,268,283; `leap-tools` @ 113,268,283 | OBSERVED (R1) |

**Placement nuance.** The audit is a **sibling of the spawn**, not a predecessor of the recording. The Workflow Protocol records the routed text "once, before that agent starts" @ 113,276,573, and the audit is dispatched as part of "start the chosen agent" @ 113,242,112. The diagram above therefore records first and audits second; the reverse order is not contradicted by any single sentence, but the recording obligation is unconditional while the audit is conditional, so recording-before-audit is the only order that satisfies both. That ordering is INFERRED.

**Why it matters topologically.** `teamwork_dependency` has **no children**. It returns a verdict to the sentinel and the sentinel acts. It must never appear inside a route's DAG as a stage: if it did, a `MISSING` would be a stage failure rather than a pre-run stop, and the sentinel's "never install yourself" rule would have no owner. Its re-dispatch on an install request is the only loop it participates in, and that loop is sentinel → auditor → sentinel, not a pipeline edge.

---

## 4. Verification and completion per route

The sentinel "never takes a victory claim at face value" @ 113,274,513 and applies a **per-route verification matrix** @ 113,273,475. The matrix is reproduced here as topology: what closes a route, and what happens when it does not.

| Route | Who verifies | Verdict values (as recovered) | On rejection / non-victory |
|---|---|---|---|
| **General** (`teamwork_orchestrator`) | `teamwork_victory_auditor`, profile **General Project** (3 phases: timeline, integrity, independent test execution) | `VICTORY CONFIRMED` / `VICTORY REJECTED`; a single failed integrity check is decisive @ 113,235,971 | Forward the full audit report to the orchestrator and resume the team @ 113,275,802; retry bound UNKNOWN |
| **Document Review** (`teamwork_document`) | `teamwork_document_victory_auditor`, profile **Document Review Project** (partition completeness, per-candidate handoffs, spot-check against raw paper) | `VICTORY CONFIRMED` / `VICTORY REJECTED`; any hallucinated finding = REJECTED @ 113,556,848 | Same forwarding rule @ 113,275,802; the auditor is told to verify `ANALYSIS_PARTITION.md` coverage, so a missing segment blocks confirmation |
| **Formal Math / LEMMA** (`teamwork_lean`) | No auditor when the result is a **kernel-checked** proof or disproof @ 113,273,475; otherwise the pipeline's own verifier | `is_valid: true`; `APPROVE` / `REQUEST_CHANGES`; `FAITHFUL` / `MISFORMALIZED`; `FAITHFUL` / `UNFAITHFUL` — directive @ 111,164,752, verdicts @ 111,167,875 / 111,168,648 | Nothing to reject at the sentinel: an unchecked or given-up result is passed on as the pipeline's own **unchecked** judgement, never as verified @ 113,273,475 |
| **Math / Proof** (`teamwork_pipeline`) | `teamwork_victory_auditor` (the "any other route" row) | `VICTORY CONFIRMED` / `VICTORY REJECTED`; the route's own `verify` stage produces `Correct` / `Almost Correct` / `Plausible with Gaps` / `Critically Flawed` @ 111,499,100, and success is "verifier verdict is `\boxed{Correct}`" @ 111,499,691 | Forward + resume @ 113,275,802; the `revise → referee` loop reruns while the verdict is not `Correct`, bounded by the size profile (2/3/5 loops) |
| **Math / Proof (Large Team)** (`teamwork_proof`) | **No sentinel auditor**: "already verified by that pipeline's own verification phase — run `Cleanup` and report the verified result directly" @ 113,273,475 | Phase 4 root verdict `Accept` / `Reject`; stop condition "verifier returns `is_correct: true`" @ 115,408,069 | Internal: rejected proof → Phase 5 revision or the next outer iteration, ≤32 @ 115,408,069; `strategy_abort` rolls back to Phase 1 |
| **SWE Light** (`teamwork_swe`) | Its own **blocking** `teamwork_victory_auditor`, at most two audits; the sentinel spawns one only if the completion report claims victory without citing `VICTORY CONFIRMED` @ 113,273,475 | `VICTORY CONFIRMED` / `VICTORY REJECTED`; completion must **cite** `VICTORY CONFIRMED` @ 113,730,349 | 1st: forward report into a fresh reviewer round; 2nd: stop and report `unverified open findings` @ 113,731,300 |

Two cross-cutting values appear in the sentinel's Cleanup conditions and are easy to over-read. `VICTORY UNVERIFIED` exists @ 113,257,448 as an instruction-defined cleanup trigger, but **no recovered route prompt defines which route emits it** — UNKNOWN. `VICTORY REJECTED` in every row above returns the run to the working team and explicitly withholds `Cleanup` (a paused or resumed run must keep its subagents and monitoring open) @ 113,257,324 / 113,275,802.

---

## 5. Sub-flows

None of these is a route. Each is either a component reachable from a route (5.1–5.3) or a set of types with no recovered path at all (5.4–5.5).

### 5.1 `teamwork_critic_orchestrator` — adversarial verification sub-flow (OBSERVED)

```text
[teamwork_conductor] -- stage "critic" -->
   |
   v
[teamwork_critic_orchestrator]   "Coordinates critic subswarms across manuscript sections"
   |
   +--> [teamwork_updater] x1              initializes .swarm_blackboard_critic_<task_name>.md
   |        `.. events: worker_dispatched / worker_completed / synthesis_started / synthesis_completed
   |
   +--> [teamwork_follower] x (sections + 1)   one per identified section + one holistic verifier
   |        `..> output_<worker_short_id>.md
   |
   `..> stage_artifact_critic_<task_name>.md  -> notify conductor
```

- **OBSERVED**: the conductor's stage dispatch (`critic` → this type) @ 111,768,625; the critic's own prompt "spawn exactly one `teamwork_updater` subagent" @ 110,707,417 and "**`TypeName`**: `"teamwork_follower"`, **`Role`**: `"Critic Subswarm Worker"`" @ 110,708,631; the final artifact name and the notification to the Pipeline Conductor in the same directive (from 110,710,024).
- **OBSERVED constraint**: it may not verify itself — "You are not authorized to perform verification yourself, regardless of how minor the manuscript changes appear" @ 110,706,011. That prohibition is what makes the fan-out mandatory rather than optional.
- **UNKNOWN**: whether it is used outside the pipeline route; whether the "section" partition it computes is the same `ANALYSIS_PARTITION.md` used by Document Review (its blackboard is `.swarm_blackboard_critic_*`, not `.agents/teamwork/`).

### 5.2 `teamwork_stellar_orchestrator` — name only (UNKNOWN)

```text
[?] --> [teamwork_stellar_orchestrator] --> [?]
```

Nothing recovered connects this type to anything. It exists as the source stem `stellar_orchestrator.go` @ 48,231,713 and as a bucketed type string @ 106,479,059. `02-agent-registry.md` notes it cannot be excluded as the type behind D8 ("Top-level 5-phase orchestrator"), because D8's own binding is unproven. No role prompt, no dispatch site, no artifact literal, no child. **Do not draw edges from the word "stellar"** — a wide-search or best-of-N connotation is a guess, and the naming convention in this subsystem is not reliable enough to support it (length bucketing, 28 of 70 names never observed in prefixed form). Listed in §7.

### 5.3 The `teamwork_swarm_*` family (partly OBSERVED)

```text
[teamwork_swarm_orchestrator]   "Coordinates a parallel swarm of agents using a blackboard"
   |
   +--> [teamwork_updater] x1     per-stage blackboard: .swarm_blackboard_<stage>_<task>.md
   |
   +--> worker x N                "same global goal", lanes refilled to the Resolved Swarm Size
   |        `.. Build: Workspace='branch' (git worktree); Artifact/Message: Workspace='inherit'
   |
   `--> [teamwork_swarm_synthesizer]   on the synthesis trigger
            `.. Build: diff consolidation into the user workspace
                Artifact/Message: canonical deliverable
```

- **OBSERVED**: swarm orchestrator's role and methodology ("Maintain a pool of parallel workers (lanes) and continuously spawn them with the **same global goal**… **stigmergy**") @ 111,832,623; "spawn exactly one `teamwork_updater` subagent" @ 111,836,180; "immediately spawn the `teamwork_synthesizer`" @ 111,842,326; synthesizer's diff-based consolidation @ 110,697,553; follower's board rule "coordinate on the board, and do not repeat @%s's work" @ 108,449,168.
- **OBSERVED naming divergence**: the *file* is `swarm_blackboard_updater.go` @ 48,232,193, the *dispatch type* in prompts is `teamwork_updater` (and `teamwork_pipeline_updater` for the pipeline level). Neither `teamwork_swarm_blackboard_updater` nor `teamwork_swarm_synthesizer` is observed as a dispatch string; `teamwork_synthesizer` is.
- **UNKNOWN**: the worker type used by the swarm orchestrator. Its prompt says only "spawn a worker"; `teamwork_follower` is evidenced **only** as the critic orchestrator's subswarm worker @ 110,708,631. Drawing swarm-orchestrator → `teamwork_follower` is therefore INFERRED from the shared board/stigmergy prose, not proven.

### 5.4 `teamwork_colosseum` proof verification (UNKNOWN)

```text
[?] --> colosseum_proof_verifier --> [?]
        `.. armed_worker (colosseum/armed_worker.go; state folder "armed_worker@colosseum")
```

- **OBSERVED**: the sub-package `colosseum/` with `armed_worker.go` and `colosseum_proof_verifier.go` @ §*Source-file provenance* in `02-agent-registry.md`; the bare string `colosseum_proof_verifier` @ 106,782,397; the folder literal `armed_worker@colosseum` @ 106,639,752; `colosseum.init` @ 34,565,493.
- **INFERRED**: a proof-verification sub-flow that uses an "armed worker" and has its own state folder. The word "colosseum" plus "proof_verifier" is the whole basis.
- **UNKNOWN**: who dispatches it, what it verifies, and whether it overlaps `teamwork_victory_auditor` / `teamwork_referee`. No prompt, no dispatch site, no verdict vocabulary recovered. It must not be placed on the Math / Proof or Large Team routes — no evidence links it to either.

### 5.5 `teamwork_empirical_challenger` + `teamwork_strategy_explorer` (name only, INFERRED family)

| Type | What is observed | What is inferred | What is unknown |
|---|---|---|---|
| `teamwork_empirical_challenger` | Stem `empirical_challenger` @ 48,229,556; bucketed name @ 106,478,979; source path `empirical_challenger.go` | An adversarial, evidence-based challenger role — the stem and the `empirical` adjective are the only basis | Parent, position, verdict vocabulary, relation to `teamwork_challenger` (which *is* an OBSERVED gate participant @ 114,761,769) |
| `teamwork_strategy_explorer` | Stem `strategy_explorer` @ 48,231,795; bucketed name @ 106,245,774; source path `strategy_explorer.go` | An approach-exploration role, distinct from `teamwork_explorer` (proof Phase 1, OBSERVED) | Parent, position, whether it feeds a strategy card into a proof tree or a general milestone gate |

Both sit in the **General** family in `02-agent-registry.md` on morphology alone. Do not draw an edge from `teamwork_orchestrator` to either: the general orchestrator's only evidenced child names are the five state-folder examples (`explorer`/`worker`/`reviewer`/`challenger`/`sub_orch`) plus the four gate roles. `strategy_explorer` and `empirical_challenger` appear in neither list.

---

## 6. Topology at a glance

| Route | Shape | Depth (entry → leaf) | Loop | Fan-out cap |
|---|---|---|---|---|
| General | milestone gate loop with an optional document sub-flow | 3 (sentinel → orchestrator → gate role) | per milestone | 128 agents per orchestrator @ 114,744,315 |
| Document Review | two-tier orchestrator + RSA trees | 4 (sentinel → document → group → worker) | per segment / succession | tree `[4,2,1]` per segment; `[4,1]` synthesis |
| LEMMA | claim-driven worker pool | 3–4 (sentinel → orchestrator → role; +1 through the formalization gate) | `claim_next` until graph exhausted | 8 concurrent workers @ 114,086,125 |
| Math / Proof | staged swarm pipeline | 5 (sentinel → pipeline → conductor → stage orchestrator → worker) | `revise → referee`, 2/3/5 | profile size (3/5/9 lanes) |
| Math / Proof (Large Team) | 5-phase outer loop + tournament trees | 4 (sentinel → proof → layer → node) | ≤32 outer iterations; ≤3 root retries; ≤3 gate rounds | ≤32 nodes per layer, ≤128 direct spawns @ 114,942,300 |
| SWE Light | alternating two-agent refinement | 3 (sentinel → swe → implementer/reviewer) | ≤32 iterations + ≤2 audits | 1 implementer, 1 reviewer at a time |

The two extremes are diagnostic of intent: SWE Light is a **collapsed** team that cannot decompose, and Math / Proof (Large Team) is the only route with an explicit hierarchical delegation protocol whose purpose is to keep each orchestrator's context small while still running hundreds of agents.

---

## 7. Topology gaps

These edges could not be established. Each is written as a gap rather than an inference because no recovered text names both ends.

1. **D-series type bindings.** D1 (root sentinel), D6 (`teamwork_forensic_auditor`), D7 (`teamwork_spec_miner`) and D8 (`teamwork_proof`) are bound to their types by content, not by proven struct-field adjacency. Every diagram above that passes through `teamwork_proof` inherits that INFERRED binding. Closing it needs `pclntab` parsing plus disassembly of `teamwork.buildAgentItemWithDefaultTier` (`02-agent-registry.md`, *Gaps* steps 1–6).
2. **The General orchestrator's child roster.** Only a five-item naming example and four gate roles are evidenced. No recovered text enumerates the general orchestrator's dispatchable set, so the diagram is a lower bound. A live run with subagent tracing would close it directly.
3. **General → document sub-flow.** No prompt shows `teamwork_orchestrator` dispatching `teamwork_document`. The Document Review route is the only evidenced dispatcher. If General never hosts a document tree, §2.1's dotted edge is spurious.
4. **Math / Proof's ownership of the pipeline prompts.** The conductor/sentinel prompts use `.pipeline_*` and `.swarm_blackboard_*` at the workspace root and say "Do NOT create legacy folders under `.agents/`" @ 111,766,538, which conflicts with the sentinel's File Workspace Convention. Whether these prompts are the `/teamwork` Math / Proof route or a sibling command surface sharing the package is UNKNOWN.
5. **Merger placement on Math / Proof.** `teamwork_solve_merger`, `teamwork_verify_merger`, `teamwork_revise_merger`, `teamwork_gate_merger` and `teamwork_plan_merger` are OBSERVED proof-route aggregators and nothing more. The Math / Proof route's own prompts synthesize with `teamwork_synthesizer` per stage.
6. **`teamwork_conductor` vs `teamwork_pipeline_conductor`.** The dispatch string is `teamwork_conductor` @ 111,494,319; the source file is `pipeline_conductor.go` @ 48,231,081; the registry row is `teamwork_pipeline_conductor`. All three are OBSERVED and none is proven to be the same registration.
7. **`teamwork_pipeline_updater` vs `teamwork_pipeline_blackboard_updater`.** Dispatch string @ 111,767,835 versus file stem @ 48,230,992. Same class of ambiguity.
8. **LEMMA's type binding.** `teamwork_lean` (route target @ 113,267,369) versus `teamwork_orchestrator_lemma` (stem only @ 48,230,833). D2's role text matches the route, but the registration is not proven. Both names are carried rather than merged.
9. **LEMMA verifier/formalizer dispatch sites.** D2 names `teamwork_verifier`, `teamwork_formalizer` and `teamwork_formalization_reviewer`, but the orchestrator's `claim_next` dispatch table has no row for any of them, and the orchestrator is "the only agent permitted to invoke subagents" @ 114,077,580. How those three are invoked is UNKNOWN — possibly by a phase not covered by the recovered directive, possibly by the state manager's own hooks.
10. **Document Review's leaf-orchestrator type.** "Level: Main Orchestrator, Group Orch, or Leaf Orch" @ 115,090,383 proves a third level exists; its type name and dispatch site are UNKNOWN.
11. **SWE Light's reviewer freshness and `teamwork_test_writer`.** The no-reuse rule is a general subagent rule, not restated in the SWE prompt. `teamwork_test_writer` exists as a type @ 106,479,099 but is named by no route prompt.
12. **Swarm worker type.** The swarm orchestrator's prompt says "spawn a worker" without a `TypeName`; `teamwork_follower` is evidenced only under the critic orchestrator.
13. **`teamwork_stellar_orchestrator`, `colosseum_proof_verifier`, `teamwork_empirical_challenger`, `teamwork_strategy_explorer`.** Four types with no recovered parent, child, verdict vocabulary or artifact. All edges involving them are absent from this document by design.
14. **`VICTORY UNVERIFIED`.** The sentinel's Cleanup condition names it @ 113,257,448; no route prompt defines it. Which route can emit it is UNKNOWN.
15. **Phase-4 assembly worker's parent.** The proof prompt says "delegate the assembly … to one `teamwork_worker` subagent" without saying whether the proof orchestrator or a layer dispatches it.
16. **`teamwork_checker`, `teamwork_outliner`, `teamwork_replanner`, `teamwork_patcher` outside the proof route.** The registry files the first of these under the document-review family and the rest under revision-loop morphology; the proof prompt uses all four. Whether the same registrations serve both is UNKNOWN.
17. **Three audit-like types with different scopes.** `teamwork_auditor` (milestone gate, verdict `CLEAN` / `INTEGRITY VIOLATION` @ 114,761,834), `teamwork_judge` (Phase 1 strategy gate @ 115,422,867) and `teamwork_victory_auditor` (route completion, `VICTORY CONFIRMED` / `VICTORY REJECTED`) all audit something, and no text states their relationship or whether they share a prompt. `teamwork_referee` is a fourth, Phase-4-only variant.

**What would close these.** Two passes, in order. First, the `pclntab` + disassembly pass already specified in `02-agent-registry.md` (*Gaps*, steps 1–6): recover `functab`, disassemble `teamwork.AllAgents` / `teamwork.init` / every `buildAgentItemWithDefaultTier` call site, and read name → description → allowlist → tier from the argument registers. That binds types and settles gaps 1, 6, 7, 8 and 14. Second, a **live run** of each route with subagent tracing, because gaps 2, 3, 5, 9, 10, 11, 12 and 15 are about which prompt is actually dispatched at runtime — a fact the static artifact cannot contain. No amount of further string extraction will close them.

---

## Reproduction

```sh
B=/tmp/opencode/antigravity-re/antigravity

# Role descriptions that name their dispatch targets (D1-D8)
grep -aobF 'Sentinel with task routing'           "$B"
grep -aobF 'Orchestrator dedicated to the LEMMA'  "$B"
grep -aobF 'Analysis-pattern orchestrator'        "$B"
grep -aobF 'Dedicated group orchestrator'         "$B"
grep -aobF 'Dispatch-only orchestrator'           "$B"
grep -aobF 'Top-level 5-phase orchestrator'       "$B"

# Route Summary and pre-flight column
dd if="$B" bs=1 skip=113265667 count=4700 status=none | tr -c '[:print:]\n' '.'

# SWE Light shape and loop rules
dd if="$B" bs=1 skip=113721100 count=2500 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=113727200 count=2600 status=none | tr -c '[:print:]\n' '.'

# Document review architecture, segment dispatch, synthesis dispatch
dd if="$B" bs=1 skip=115088400 count=2200 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=115090600 count=1400 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=115097800 count=2600 status=none | tr -c '[:print:]\n' '.'

# LEMMA dispatch-as table and claim loop
dd if="$B" bs=1 skip=114086000 count=3000 status=none | tr -c '[:print:]\n' '.'

# math pipeline template and conductor dispatch
dd if="$B" bs=1 skip=111494300 count=1200 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=111497800 count=2400 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=111767800 count=1400 status=none | tr -c '[:print:]\n' '.'

# proof orchestrator phases and layer delegation
dd if="$B" bs=1 skip=115373000 count=1200 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=115419400 count=5000 status=none | tr -c '[:print:]\n' '.'
dd if="$B" bs=1 skip=115432000 count=4500 status=none | tr -c '[:print:]\n' '.'

# Pre-flight audit semantics
dd if="$B" bs=1 skip=113242100 count=1200 status=none | tr -c '[:print:]\n' '.'
```
