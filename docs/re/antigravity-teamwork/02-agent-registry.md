# Agent Registry — Antigravity `/teamwork` Subsystem

Static-analysis reconstruction of the `/teamwork` agent roster in the Google Antigravity Linux CLI (extracted binary `antigravity`, SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`, 273,240,776 bytes). The `name → runtime type → description` binding is **recovered** for all registry entries: `teamwork.AllAgents` was located through the surviving Go `pclntab`, its body was disassembled, and every item it stores was decoded field by field. The per-agent **tool allowlist** is recovered as well: each item carries a `[]string` slice at `+0x40`, decoded for all 49 entries (counts in the roster table, full ordered lists in Appendix B). [OBSERVED] Facts marked OBSERVED were measured from the extracted binary; inferences are labelled INFERRED and state their premises. No part of the binary was executed and no network or authentication was used.

Companion documents: `00-artifact-identity.md` (binary identity, section map, toolchain), `PROVENANCE.md` (chain of custody, licensing, method limits), `prompts/sentinel-routing.md` (recovered routing prompt text).

## Confidence Legend

| Label | Meaning |
|---|---|
| **OBSERVED** | Directly read from the artifact: a byte string at a measured file offset, or a symbol/path string present in the binary. Earned by quoting the value and its offset. |
| **INFERRED** | Derived by reasoning over observed data (name morphology, routing table text, source-path co-location, description content). Earned by stating the premises. |
| **UNKNOWN** | Not measured, or not determinable from the available evidence. Written literally as `UNKNOWN`; never guessed. |

Abbreviations used in prose: `OBS` = OBSERVED, `INF` = INFERRED, `UNK` = UNKNOWN.

## Naming note

The shipped command identifier is the literal `teamwork-preview` (file offsets 106,155,303 and 116,708,666), with the description string `Preview the multi-agent teamwork workflow.` and the admin-control gate `TeamworkPreviewCommandDisabled`. `/teamwork` is the shorthand used throughout this corpus, and the separate 8-byte `teamwork` token that also exists in the binary is that identifier minus its suffix. `06-config-gates-and-model-tiers.md` carries the full derivation. [OBSERVED for the two literals and the description; INFERRED that the two name forms denote the same command]

The registry contains one item whose runtime type is exactly the bare `teamwork` token — the `sentinel@external` root sentinel, row 46 below. The naming note above still stands: the command identifier is `teamwork-preview`, not `teamwork`.

## How the binding was recovered

The chain is short and fully mechanical. Every numbered step below is OBSERVED; the INFERRED claims in this document are limited to what the undecoded fields carry and what the allowlist differences mean (see *What remains UNKNOWN* and *Tool allowlist observations*).

1. **`pclntab` → function addresses.** `docs/re/tools/pclntab/` is a stdlib Go pclntab reader. It resolves **189,632** functions from the stripped binary using `debug/gosym`; the run reports `parser=gosym` (the local go1.27 `debug/gosym` accepts the Go 1.28 table). The tool's manual pcHeader/functab-walk fallback produced an identical 189,632-line dump, so the count is parser-independent. It resolves `teamwork.AllAgents` to virtual address **`0x8c82380`**.
2. **`AllAgents` body → 49 pointers.** The disassembly of **`0x8c82400`–`0x8c826a0`** stores **49** pointers to agent item structs in `.data`.
3. **Item struct → three string headers, then a tool slice.** Each agent item struct holds, in order: field 0 = the short/internal name, field 1 = the runtime agent type, field 2 = the description. Each is a 16-byte Go string header `{ptr, len}`. At byte offset `+0x40` the struct stores a Go slice header `{ptr, len, cap}` whose elements are themselves Go string headers: the tool allowlist, in declared order. Fields 3 and above otherwise hold non-string or nested-struct data (see *What remains UNKNOWN*).
4. **String headers → pointers, via RELA.** `docs/re/tools/strhdr/` is a stdlib Go RELA string-header resolver. The binary's `.rela.dyn` has 1,050,169 entries and 1,050,072 indexed relocations. For a relocation-covered string header the on-disk `ptr` is zero and the real pointer is carried in the `R_X86_64_RELATIVE` addend; the tool decodes the 16-byte header at a virtual address by taking the pointer from that addend and the length from the header's second word. [OBSERVED for the counts and the zero on-disk pointer]
5. **Pointers → `.rodata` literals.** Every resolved `ptr` lands in `.rodata`, where the virtual address equals the file offset, and every `len` is the exact byte count. The literal is therefore read as the exact `len`-byte range at `ptr` — no NUL scanning, no length-bucket inference, and no adjacency guessing. [OBSERVED]

Reproduction (tool directory `docs/re/tools/strhdr`):

```sh
go run . -bin /tmp/opencode/antigravity-re/antigravity -struct 0xd8101c0 -fields 3
go run . -bin /tmp/opencode/antigravity-re/antigravity -compact -agent 0xd810280
```

That prints the `armed_critic → teamwork_critic → description` item, the first registry entry, and the `armed_worker` tool allowlist. The decoded data for all 49 entries is preserved at `/tmp/opencode/agents.txt`, one struct per block, with `ptr` and `len` for each of the three fields; the 49 decoded tool allowlists are in `/tmp/opencode/agents_tools.txt` and Appendix B.

**Mechanism status: OBSERVED.** The three fields are bound by struct offsets written by the registry builder, not by semantic matching. This supersedes the earlier revision's statement that the binding was `UNKNOWN`.

## Roster — all 49 registry entries

Rows are in **`AllAgents` order**: 1–49 is the registry order, not alphabetical and not grouped by family.

- **Short name** is field 0, the internal name used by the registry and by `@package`-suffixed instance variants.
- **Runtime type** is field 1, the `teamwork_*` type name an orchestrator dispatches.
- **Description** is field 2, reproduced verbatim. A literal longer than 200 characters is cut at a word boundary and marked `…`; the full literal is always the `len`-byte range starting at `ptr`.
- **Tools** is the number of entries in the item's tool-allowlist slice at `+0x40`; the full ordered list for every agent is in **Appendix B**.
- **Struct addr** is the address of the agent item itself in `.data`; **Evidence** repeats it with the description's `ptr`/`len` so the text can be re-read byte-exactly.

| # | Short name | Runtime type | Description | Struct addr | Tools | Evidence |
|---:|---|---|---|---|---:|---|
| 1 | `armed_critic` | `teamwork_critic` | Domain-expert reviewer and adversarial critic. Loads a verification methodology skill (e.g., proof-rigor-verification) to provide rigorous, domain-informed review. Orchestrator arms it with a domain… | 0xd8101c0 | 13 | 0xd8101c0 ptr=0x675bf56 len=227 |
| 2 | `armed_worker` | `teamwork_worker` | Versatile worker with loadable domain expertise. Combines implementation, QA, and external skill loading. Orchestrator arms it with a domain skill path at dispatch time. | 0xd810280 | 15 | 0xd810280 ptr=0x674e30c len=169 |
| 3 | `colosseum_proof_verifier` | `teamwork_referee` | Independent, strict mathematical auditor reviewing fully assembled LaTeX manuscripts like a blind peer reviewer. | 0xd810340 | 14 | 0xd810340 ptr=0x6734085 len=112 |
| 4 | `decompose_aggregator` | `teamwork_plan_merger` | Synthesizes multiple decomposition plans into a single optimal LaTeX skeleton during Phase 2 tournament aggregation. | 0xd8104c0 | 15 | 0xd8104c0 ptr=0x673752b len=116 |
| 5 | `document_ingestor` | `teamwork_ingestor` | Document ingestion worker. Extracts text and renders 200 DPI page images from input PDFs using pure Python (pypdfium2) and generates DOCUMENT_TEXT_MAP.md. | 0xd810640 | 14 | 0xd810640 ptr=0x674980c len=154 |
| 6 | `empirical_challenger` | `teamwork_challenger` | Code-executing adversarial verifier. Writes generators, oracles, and stress test harnesses to empirically verify solution correctness and performance. Armed with domain skills by the orchestrator at… | 0xd810700 | 14 | 0xd810700 ptr=0x6759101 len=213 |
| 7 | `exploration_falser` | `teamwork_explore_falser` | Adversarial mathematician auditing exploration strategy cards to find potential flaws, wrong-sided bounds, and unstated assumptions before aggregation. | 0xd8107c0 | 14 | 0xd8107c0 ptr=0x6748af2 len=151 |
| 8 | `explore_aggregator` | `teamwork_explore_merger` | Synthesizes multiple exploration strategy cards into a single superior strategy card during Phase 1 tournament aggregation. | 0xd810880 | 15 | 0xd810880 ptr=0x673c7af len=123 |
| 9 | `explorer` | `teamwork_explorer` | Read-only exploration agent. Investigates codebases, analyzes problems, and produces structured handoff reports with verified evidence chains. | 0xd810940 | 13 | 0xd810940 ptr=0x6745b28 len=142 |
| 10 | `forensic_auditor` | `teamwork_auditor` | Forensic integrity auditor. Verifies that work products implement functionality authentically using systematic checks (static analysis, runtime tracing, execution validation). Armed with domain skills… | 0xd810a00 | 14 | 0xd810a00 ptr=0x675e750 len=238 |
| 11 | `gate_aggregator` | `teamwork_gate_merger` | Aggregates multiple gate reviewer verdicts into a single consolidated gate decision during Phase 1 gate review tournament. | 0xd810ac0 | 14 | 0xd810ac0 ptr=0x673bd28 len=122 |
| 12 | `gate_reviewer` | `teamwork_judge` | Strict mathematical critic vetting exploration strategy cards for fatal flaws before allowing problem decomposition. | 0xd810b80 | 14 | 0xd810b80 ptr=0x673759f len=116 |
| 13 | `knowledge_curator` | `teamwork_curator` | Extracts and curates mathematical knowledge from tournament candidates into a persistent knowledge directory with individual topic files and an index. Runs asynchronously after each tournament level… | 0xd810d00 | 14 | 0xd810d00 ptr=0x67662bb len=283 |
| 14 | `layer_orchestrator` | `teamwork_layer` | Manages one level of a tournament tree (or a partition of one level). Invokes that level's subagents, collects results, and writes output files. Recursively partitions into sub-layer orchestrators… | 0xd810dc0 | 15 | 0xd810dc0 ptr=0x676976b len=306 |
| 15 | `lemma_decomposition_reviewer` | `teamwork_reviewer` | Direct Lean 4 informal decomposition reviewer worker using LEMMA architecture. | 0xd810e80 | 14 | 0xd810e80 ptr=0x67106a0 len=78 |
| 16 | `lemma_formalization_reviewer` | `teamwork_formalization_reviewer` | Blind reviewer that checks a LEMMA formal statement, a root disproof, or a finished proof against the user's informal problem. | 0xd810f40 | 10 | 0xd810f40 ptr=0x673de88 len=126 |
| 17 | `lemma_formalizer` | `teamwork_formalizer` | Lean 4 formalizer that turns an informal problem statement or document into a faithful LEMMA problem file before proof search. | 0xd811000 | 14 | 0xd811000 ptr=0x673df06 len=126 |
| 18 | `lemma_informal_prover` | `teamwork_planner` | Direct Lean 4 informal prover worker using LEMMA architecture. | 0xd8110c0 | 15 | 0xd8110c0 ptr=0x66e353e len=62 |
| 19 | `lemma_proof_verifier` | `teamwork_verifier` | Independent Lean 4 formal verifier agent auditing kernel acceptance and axiom legality. | 0xd811180 | 14 | 0xd811180 ptr=0x671d3d1 len=87 |
| 20 | `lemma_proof_worker` | `teamwork_worker` | Direct Lean 4 formal prover worker using LEMMA architecture and solvers. | 0xd811240 | 15 | 0xd811240 ptr=0x6703086 len=72 |
| 21 | `orchestrator_lemma` | `teamwork_lean` | Orchestrator dedicated to the LEMMA formal proof pipeline pattern in Lean 4. Dispatches teamwork_worker, teamwork_planner, teamwork_reviewer, teamwork_verifier, teamwork_formalizer, and… | 0xd811300 | 15 | 0xd811300 ptr=0x675a0fb len=218 |
| 22 | `orchestrator_pure` | `teamwork_orchestrator` | Pure orchestrator. Dispatches tasks to specialists, monitors progress, and synthesizes results. Does not write code directly. | 0xd8113c0 | 15 | 0xd8113c0 ptr=0x673d72f len=125 |
| 23 | `pipeline_conductor` | `teamwork_conductor` | Orchestrates a multi-stage pipeline of swarms, routing stage artifacts between stages. | 0xd811540 | 15 | 0xd811540 ptr=0x671c196 len=86 |
| 24 | `pipeline_sentinel_agent` | `teamwork_pipeline` | Stable user-facing agent. Routes to a Pipeline Conductor for multi-stage tasks, or a Swarm Orchestrator for simple tasks. | 0xd811600 | 15 | 0xd811600 ptr=0x673afde len=121 |
| 25 | `problem_decomposer` | `teamwork_outliner` | Mathematician expanding winning strategies into standalone LaTeX master document skeletons with ordered subproblems and placeholder tokens. | 0xd8116c0 | 15 | 0xd8116c0 ptr=0x6744543 len=139 |
| 26 | `reviewer_critic` | `teamwork_reviewer` | High-reliability review agent. Both objectively reviews AND adversarially challenges the work product. | 0xd811780 | 14 | 0xd811780 ptr=0x672c179 len=102 |
| 27 | `revise_aggregator` | `teamwork_revise_merger` | Synthesizes multiple revised proof sections or revised skeletons into the single best revision during Phase 5 revision tournament aggregation. | 0xd811840 | 15 | 0xd811840 ptr=0x6745bb6 len=142 |
| 28 | `revision_decomposer` | `teamwork_replanner` | Mathematician revising a proof outline conservatively after verifier feedback without introducing a completely new proof plan. | 0xd811900 | 15 | 0xd811900 ptr=0x673df84 len=126 |
| 29 | `section_verifier` | `teamwork_checker` | Strict mathematical checker auditing individual proof sections during sequential solving before assembly. | 0xd8119c0 | 14 | 0xd8119c0 ptr=0x672e1d2 len=105 |
| 30 | `spec_miner` | `teamwork_spec_miner` | Read-only specification investigator. Probes authoritative sources (codebases, documentation, APIs, reference implementations, or user requirements) to discover and document features, behaviors, error… | 0xd811a80 | 14 | 0xd811a80 ptr=0x6761e8f len=257 |
| 31 | `stellar_orchestrator` | `teamwork_proof` | Top-level 5-phase orchestrator for the theorem-proving pipeline. Manages the outer iteration loop and delegates each tournament tree level to dedicated teamwork_layer agents. Executes protocol only —… | 0xd811b40 | 15 | 0xd811b40 ptr=0x675e92d len=239 |
| 32 | `strategy_explorer` | `teamwork_explorer` | Mathematician searching for high-level proof strategies, answer guesses, and key invariants before decomposition. | 0xd811c00 | 15 | 0xd811c00 ptr=0x6734a31 len=113 |
| 33 | `subproblem_aggregator` | `teamwork_solve_merger` | Synthesizes multiple candidate section bodies into a single rigorous proof section during Phase 3 subproblem tournament aggregation. | 0xd811cc0 | 15 | 0xd811cc0 ptr=0x6741a7b len=132 |
| 34 | `subproblem_falser` | `teamwork_solve_falser` | Adversarial checker auditing proposed proof section bodies to audit claimed results, bridge claims, and open obligations before final assembly. | 0xd811d80 | 14 | 0xd811d80 ptr=0x674640b len=143 |
| 35 | `subproblem_solver` | `teamwork_solver` | Mathematician solving proof subproblems driven by a dependency graph with trimmed context. | 0xd811e40 | 15 | 0xd811e40 ptr=0x6720a24 len=90 |
| 36 | `surgical_reviser` | `teamwork_patcher` | Mathematician surgically patching broken LaTeX sections identified by the verifier without restarting from scratch. | 0xd811f00 | 15 | 0xd811f00 ptr=0x6736561 len=115 |
| 37 | `test_writer` | `teamwork_test_writer` | Writes comprehensive tests for assigned functionality based on specifications and project requirements. Does NOT modify implementation code. | 0xd8122c0 | 15 | 0xd8122c0 ptr=0x6745025 len=140 |
| 38 | `verify_aggregator` | `teamwork_verify_merger` | Consolidates multiple global proof reviewer reports into a single Accept/Reject verdict during Phase 4 verification tournament aggregation. | 0xd812380 | 14 | 0xd812380 ptr=0x67445ce len=139 |
| 39 | `victory_auditor` | `teamwork_victory_auditor` | Independent post-victory auditor. Spawned by the Sentinel when the team claims project completion. Conducts a 3-phase audit (timeline, cheating detection, independent test execution) with zero shared… | 0xd812440 | 14 | 0xd812440 ptr=0x6763d30 len=268 |
| 40 | `armed_worker@colosseum` | `teamwork_worker` | Versatile worker with loadable domain expertise. Combines implementation, QA, and external skill loading. Orchestrator arms it with a domain skill path at dispatch time. | 0xd812980 | 15 | 0xd812980 ptr=0x674e30c len=169 |
| 41 | `armed_worker@document_review` | `teamwork_worker` | Versatile worker with loadable domain expertise. Combines implementation, QA, and external skill loading. Orchestrator arms it with a domain skill path at dispatch time. | 0xd812a40 | 15 | 0xd812a40 ptr=0x674e30c len=169 |
| 42 | `group_orchestrator@document_review` | `teamwork_group` | Dedicated group orchestrator for document review. Manages a single segment's RSA review tree or the cross-segment synthesis RSA tree. Dispatches teamwork_worker (analysts and aggregators) and… | 0xd812b00 | 15 | 0xd812b00 ptr=0x675eddc len=241 |
| 43 | `orchestrator_pure@document_review` | `teamwork_document` | Analysis-pattern orchestrator (Main Orchestrator). Triages the paper into segments, dispatches teamwork_group per segment for RSA tree execution, dispatches teamwork_group for cross-segment synthesis,… | 0xd812bc0 | 15 | 0xd812bc0 ptr=0x675f0b1 len=242 |
| 44 | `synthesizer@document_review` | `teamwork_synthesizer` | Report aggregator. Reads multiple child analysis reports, identifies cross-report patterns, deduplicates findings, resolves conflicts, and produces a single synthesized report. | 0xd812c80 | 15 | 0xd812c80 ptr=0x674ff4e len=176 |
| 45 | `victory_auditor@document_review` | `teamwork_document_victory_auditor` | Independent post-victory auditor. Spawned by the Sentinel when the team claims project completion. Conducts a 3-phase audit (timeline, cheating detection, independent test execution) with zero shared… | 0xd812d40 | 14 | 0xd812d40 ptr=0x6763d30 len=268 |
| 46 | `sentinel@external` | `teamwork` | Sentinel with task routing. Dispatches teamwork_orchestrator, teamwork_swe, teamwork_document, teamwork_lean, teamwork_proof, teamwork_dependency or teamwork_pipeline according to the Routing Decision… | 0xd812e00 | 15 | 0xd812e00 ptr=0x676d59c len=338 |
| 47 | `implementer@swe_light` | `teamwork_implementer` | Primary implementation specialist for a SWE Light task. Reads the original task verbatim, implements the change, and verifies it by running the repository test suite. Reports with an explicit… | 0xd812ec0 | 15 | 0xd812ec0 ptr=0x67699cf len=306 |
| 48 | `orchestrator_pure@swe_light` | `teamwork_swe` | Dispatch-only orchestrator for a single self-contained software engineering task. Runs the SWE Light loop: one teamwork_implementer on the whole task, then repeated teamwork_reviewer rounds carrying a… | 0xd812f80 | 15 | 0xd812f80 ptr=0x676d1a9 len=336 |
| 49 | `reviewer@swe_light` | `teamwork_reviewer` | Adversarial improvement worker. Dispatch AFTER teamwork_implementer, passing the original task verbatim plus that agent's full report. It re-derives the requirements independently, actively tries to… | 0xd813040 | 15 | 0xd813040 ptr=0x6774f74 len=404 |

## Cross-check against the eight previously recovered descriptions

Before this pass, eight descriptions (D1–D8) had been recovered verbatim as literals but bound to type names only by content. **All eight are present among the 49**, each as a unique, exact, whole-string match on field 2 — not a substring match:

| Earlier label | Entry # | Short name | Runtime type |
|---|---:|---|---|
| D1 — Sentinel (top-level router) | 46 | `sentinel@external` | `teamwork` |
| D2 — LEMMA orchestrator | 21 | `orchestrator_lemma` | `teamwork_lean` |
| D3 — Main / analysis orchestrator | 43 | `orchestrator_pure@document_review` | `teamwork_document` |
| D4 — Document review group orchestrator | 42 | `group_orchestrator@document_review` | `teamwork_group` |
| D5 — SWE Light orchestrator | 48 | `orchestrator_pure@swe_light` | `teamwork_swe` |
| D6 — Forensic integrity auditor | 10 | `forensic_auditor` | `teamwork_auditor` |
| D7 — Specification investigator | 30 | `spec_miner` | `teamwork_spec_miner` |
| D8 — Theorem-proving orchestrator | 31 | `stellar_orchestrator` | `teamwork_proof` |

Because none is missing, both alternatives left open in the earlier revision are excluded: none of the eight belongs to a different registry, and none is reachable only by indirection.

The earlier content-based bindings for D2–D5 and D7 named the correct runtime types. Three bindings that were previously `UNKNOWN` or wrong are now settled by struct offset:

- **D1** — runtime type is the bare `teamwork` token; the root sentinel item's short name is `sentinel@external`.
- **D6** — runtime type is `teamwork_auditor`. The earlier candidate spelling `teamwork_forensic_auditor` is **not** a runtime type in this registry; `forensic_auditor` is the short name.
- **D8** — runtime type is `teamwork_proof`. The earlier rival candidates (`teamwork_pipeline`, `teamwork_stellar_orchestrator`) are resolved: `teamwork_pipeline` belongs to `pipeline_sentinel_agent` (row 24), and `teamwork_stellar_orchestrator` does not exist as a runtime type — `stellar_orchestrator` is the short name.

## Roster size correction: 49, not 70+

**The roster is 49.** The earlier revision carried 70 dispatchable-looking names from the reconstruction brief, plus one synthetic row for the `UNKNOWN`-named root sentinel (71 rows). That figure was incorrect.

The 70+ figure counted **distinct `teamwork_*`-like identifiers in string data**. String data contains three classes of identifier that are not registry entries:

1. **Runtime type names** — 43 distinct strings across the 49 items.
2. **Subagent / archetype identifiers compiled into prompts** — for example `lemma_informal_prover` is the *short name* (field 0) of an item whose runtime type (field 1) is `teamwork_planner`. It is a dispatch-time role label, not a dispatchable type.
3. **Source-file stems and helper symbols** — `swarm_*`, `pipeline_blackboard_updater`, and similar strings name files or helpers. No `swarm_*` item appears in `AllAgents`.

So the correct membership test is: **a name is a registry entry only if it appears as field 0 (short name) or field 1 (runtime type) of a struct returned by `AllAgents`.** Counting strings, counting files, or counting prompt identifiers all overstate the roster.

Two observations that follow directly, recorded so the correction is auditable:

- **49 items collapse to 43 distinct runtime types**, because six items share a runtime type under different short names: `teamwork_worker` (4 items — `armed_worker`, `lemma_proof_worker`, `armed_worker@colosseum`, `armed_worker@document_review`), `teamwork_reviewer` (3 items — `lemma_decomposition_reviewer`, `reviewer_critic`, `reviewer@swe_light`), and `teamwork_explorer` (2 items — `explorer`, `strategy_explorer`). Distinct runtime types are therefore not the roster size either.
- **Names in prompt text are not membership.** The root sentinel's own description dispatches `teamwork_dependency` and `teamwork_interviewer`, yet neither is a runtime type among the 49. How those two are registered is `UNKNOWN`; what is certain is that they are not entries in `teamwork.AllAgents`.

Nothing in the 49-entry table was inferred from a string list. Each row comes from one struct at the stated `.data` address.

## Tool allowlist observations

Every agent item stores a Go slice at `+0x40`, `{ptr, len, cap}`, whose elements are Go string headers — the tool allowlist, in declared order. All 49 decode cleanly: each slice pointer lands in `.data`/`.data.rel.ro`, `cap ≥ len`, `len ≤ 15`, and every element resolves through RELA to a `.rodata` literal exactly as the three name/type/description headers do. The length buckets are **15 tools ×28 agents, 14 ×18, 13 ×2 and 10 ×1** — 49 items, 708 tool slots, 17 distinct tool names overall. [OBSERVED]

The two decoded example sets differ in a way that tracks role. `armed_worker` (row 2) has the 15-tool worker set: the 13-tool core (`find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`) plus `generate_image` and `notebook_edit`. In the sampled comparison, `sentinel@external` (row 46) has the same 15-tool count but swaps those two for `invoke_subagent` and `manage_subagents` — it is the only one of the two sampled items carrying the dispatch pair. [OBSERVED for both lists] Across the full decode the dispatch pair appears in exactly 10 items (rows 14, 21, 22, 23, 24, 31, 42, 43, 46, 48), every one an orchestrator, layer, pipeline, group or sentinel role; the 18 non-dispatch 15-tool items instead carry the media pair, and the single 10-tool item (`lemma_formalization_reviewer`) omits all three write tools (`multi_replace_file_content`, `replace_file_content`, `write_to_file`). [OBSERVED for membership] **INFERRED:** the allowlist itself encodes the role split — dispatch capability for orchestrators versus file/shell/web tooling for workers, and a write-free set for the blind reviewer — which is why no separate role field is required in the item struct.

## What remains UNKNOWN

The name → runtime type → description binding is closed, and the per-agent tool allowlist is now OBSERVED for all 49 (slice layout `{ptr, len, cap}` at `+0x40`, decoded by `docs/re/tools/strhdr/`, full lists in Appendix B). Two configuration bindings remain open:

| Binding | Status for all 49 | Why |
|---|---|---|
| Per-agent model tier | **UNKNOWN** | No tier value was decoded from any item. |
| Per-agent cascade / fallback config | **UNKNOWN** | No cascade chain was decoded from any item. |

**Why these remain open.** With the three string headers and the `+0x40` tool slice accounted for, the remaining fields of the agent item struct are non-string scalars and nested pointers that do not decode as Go string headers. A **nested `.data` pointer is visible at field 4**, so at least part of the remainder is out-of-line data rather than inline scalars. [OBSERVED for the pointer; INFERRED that the remaining fields carry configuration, since the builder names (`…WithDefaultTier`, `buildCascadeConfig`) imply per-item config]

The two integer slots at `+0x78` and `+0x80` are **`1` for all 49 items**, while every other unknown `u64` slot (`+0x30`, `+0x38`, `+0x58`, `+0x60`, `+0x68`, `+0x70`, `+0x88`) is `0` for all 49. [OBSERVED] They therefore **look like two boolean flags, not a model tier** — a tier field that took the same value for the sentinel, every orchestrator and every worker would not discriminate anything. If the tier is per item, it must live at some other offset or behind the nested pointer; if it is uniform, it may live outside the item struct entirely (for example in `RootAgentWithDefaultTier` / the `…WithDefaultTier` builder). Which of those holds is `UNKNOWN`.

Closing these requires **struct-layout analysis of the agent item type** — mapping each remaining field's offset, width and pointee — correlated with `buildAgentItemWithDefaultTier` (`0x8c827e0`) and `buildCascadeConfig`. More string recovery will not help: the strings that exist, including all tool names, have already been read exhaustively, and the missing values are not strings.

One further `UNKNOWN`: the key used by `indexByName` (`0x8c82720`) — short name or runtime type — has not been recovered. The function name implies a name-keyed index, but which of the two fields is the key was not measured.

## Registry Construction Evidence

`docs/re/tools/pclntab/` resolves **189,632** functions from the stripped binary (`parser=gosym`; the manual functab walk agrees on the count). The addresses below are `.text` virtual addresses. The earlier revision could record only the `.lrodata` file offsets (~34.5 M) at which these symbol *names* appear; the PC mapping is what turns a name into analysable code, and it is now resolved.

| Symbol | Virtual address | What the name implies |
|---|---:|---|
| `teamwork.init` | `0x8c811a0` | Package initialiser; performs registration at startup. |
| `teamwork.AllAgents` | `0x8c82380` | Enumerates the builtin agent set. Disassembly `0x8c82400`–`0x8c826a0` stores the 49 pointers to agent item structs; this function defines the roster order used above. |
| `teamwork.RootAgentWithDefaultTier` | `0x8c826a0` | Builds the root agent with an explicit default tier. |
| `teamwork.indexByName` | `0x8c82720` | Indexes the roster by name. The key field is `UNKNOWN` (see above). |
| `teamwork.buildAgentItemWithDefaultTier` | `0x8c827e0` | Constructs one agent item (name + type + description + config) with a default tier. |

`teamwork.RootAgent`, `teamwork.buildCascadeConfig`, and the call-side `agents.*` helpers (`TeamworkAgentWithConfig`, `teamworkAgentWithConfig`, `ByNameWithConfig`, `SelfAgent`) were also located by name in the pclntab string table, but their virtual addresses were not resolved in this pass: **`UNKNOWN`**. In particular, `buildCascadeConfig` is the symbol that would yield cascade configuration, and it has not been disassembled.

## Source-file provenance [OBSERVED]

The subsystem root path embedded in the binary is `third_party/jetski/cortex/customizations/builtin/teamwork/`, with sub-packages `swe_light/`, `document_review/`, `colosseum/`, and `external/`. The following `.go` paths were observed verbatim in the source-path string table (base offset range 48,229,3xx–48,232,4xx):

```text
all_agents_external.go        armed_critic.go             armed_worker.go
colosseum_proof_verifier.go   critic_orchestrator.go      decompose_aggregator.go
dependency_auditor.go         document_ingestor.go        empirical_challenger.go
exploration_falser.go         explore_aggregator.go       explorer.go
forensic_auditor.go           gate_aggregator.go          gate_reviewer.go
interviewer.go                knowledge_curator.go        layer_orchestrator.go
orchestrator_lemma.go         orchestrator_pure.go        problem_decomposer.go
reviewer_critic.go            revise_aggregator.go        revision_decomposer.go
section_verifier.go           spec_miner.go               stellar_orchestrator.go
strategy_explorer.go          surgical_reviser.go         test_writer.go
types.go                      verify_aggregator.go        victory_auditor.go
registry.go
```

Grouped families seen in the same table:

```text
lemma_*.go (6):     lemma_decomposition_reviewer  lemma_formalization_reviewer
                    lemma_formalizer              lemma_informal_prover
                    lemma_proof_verifier          lemma_proof_worker
pipeline_*.go (3):  pipeline_blackboard_updater   pipeline_conductor
                    pipeline_sentinel_agent
subproblem_*.go (3): subproblem_aggregator  subproblem_falser  subproblem_solver
swarm_*.go (4):     swarm_blackboard_updater  swarm_follower
                    swarm_orchestrator        swarm_synthesizer
swe_light/:         implementer.go  orchestrator_pure.go  reviewer.go
document_review/:   armed_worker.go  group_orchestrator.go  orchestrator_pure.go
                    synthesizer.go  victory_auditor.go
colosseum/:         armed_worker.go
external/:          sentinel.go
```

Paths prove that a file exists in the string table; they do **not** prove registry membership. `swarm_*.go` and `pipeline_blackboard_updater` are present as paths yet correspond to no item in `AllAgents`; where (if anywhere) they are registered is `UNKNOWN`.

## Appendix A — Archetypes are short names, not dispatch types

The earlier revision inferred from prompt text that LEMMA "archetype" strings such as `lemma_informal_prover` are role labels and that dispatch uses generic types. The registry confirms this at the struct level: every such archetype is a field-0 short name whose field-1 runtime type is one of the generic dispatch types.

| Short name (field 0) | Runtime type (field 1) |
|---|---|
| `lemma_informal_prover` | `teamwork_planner` |
| `lemma_proof_worker` | `teamwork_worker` |
| `lemma_decomposition_reviewer` | `teamwork_reviewer` |
| `lemma_formalization_reviewer` | `teamwork_formalization_reviewer` |
| `lemma_formalizer` | `teamwork_formalizer` |
| `lemma_proof_verifier` | `teamwork_verifier` |

The recovered LEMMA prompt table states of `metadata.role`: "The archetype that works this phase (e.g. `"lemma_proof_worker"`). Same value as the top-level `action_type`. It is **not** the name to dispatch." [OBSERVED, verbatim at 114,087,3xx] That is exactly the field-0/field-1 split.

## Appendix B — Per-agent tool allowlists [OBSERVED]

Each entry is the `+0x40` slice of that agent item in `AllAgents` order, decoded element by element. `N tools` is the slice length; the list is in declared order and is reproduced verbatim, including the `generate_image`/`notebook_edit` versus `invoke_subagent`/`manage_subagents` split.

1. `armed_critic` — 13 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
2. `armed_worker` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
3. `colosseum_proof_verifier` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
4. `decompose_aggregator` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
5. `document_ingestor` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
6. `empirical_challenger` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
7. `exploration_falser` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
8. `explore_aggregator` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
9. `explorer` — 13 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
10. `forensic_auditor` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
11. `gate_aggregator` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
12. `gate_reviewer` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
13. `knowledge_curator` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
14. `layer_orchestrator` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
15. `lemma_decomposition_reviewer` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
16. `lemma_formalization_reviewer` — 10 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `read_url_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`
17. `lemma_formalizer` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
18. `lemma_informal_prover` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
19. `lemma_proof_verifier` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
20. `lemma_proof_worker` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
21. `orchestrator_lemma` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
22. `orchestrator_pure` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
23. `pipeline_conductor` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
24. `pipeline_sentinel_agent` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
25. `problem_decomposer` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
26. `reviewer_critic` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
27. `revise_aggregator` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
28. `revision_decomposer` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
29. `section_verifier` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
30. `spec_miner` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
31. `stellar_orchestrator` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
32. `strategy_explorer` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
33. `subproblem_aggregator` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
34. `subproblem_falser` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
35. `subproblem_solver` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
36. `surgical_reviser` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
37. `test_writer` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
38. `verify_aggregator` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
39. `victory_auditor` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
40. `armed_worker@colosseum` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
41. `armed_worker@document_review` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
42. `group_orchestrator@document_review` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
43. `orchestrator_pure@document_review` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
44. `synthesizer@document_review` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
45. `victory_auditor@document_review` — 14 tools: `find_by_name`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
46. `sentinel@external` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
47. `implementer@swe_light` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
48. `orchestrator_pure@swe_light` — 15 tools: `find_by_name`, `grep_search`, `invoke_subagent`, `list_dir`, `manage_subagents`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`
49. `reviewer@swe_light` — 15 tools: `find_by_name`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `notebook_edit`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `send_message`, `view_file`, `write_to_file`

## Reproduction

All offsets are decimal byte offsets into the extracted binary; `.rodata` virtual addresses equal file offsets. [OBSERVED]

```sh
B=/tmp/opencode/antigravity-re/antigravity

# Registry item decode: short name, runtime type, description (docs/re/tools/strhdr)
(cd docs/re/tools/strhdr && go run . -bin "$B" -struct 0xd8101c0 -fields 3)

# Tool allowlist for one item, and for the whole roster as tab-separated lines
(cd docs/re/tools/strhdr && go run . -bin "$B" -compact -agent 0xd810280)
(cd docs/re/tools/strhdr && go run . -bin "$B" -compact \
   -agent 0xd8101c0 -agent 0xd810280 -agent 0xd812e00)

# Function addresses from the pclntab (docs/re/tools/pclntab)
(cd docs/re/tools/pclntab && go run . -bin "$B" -filter teamwork.)

# Independent text check: exact start offset of each previously recovered description
grep -aobF 'Sentinel with task routing'           "$B"
grep -aobF 'Orchestrator dedicated to the LEMMA'  "$B"
grep -aobF 'Analysis-pattern orchestrator'        "$B"
grep -aobF 'Dedicated group orchestrator'         "$B"
grep -aobF 'Dispatch-only orchestrator'           "$B"
grep -aobF 'Forensic integrity auditor'           "$B"
grep -aobF 'Read-only specification investigator' "$B"
grep -aobF 'Top-level 5-phase orchestrator'       "$B"
```

The decoded structs for all 49 entries are preserved at `/tmp/opencode/agents.txt` — one `-struct <addr> -fields 3` block per item, each field carrying `ptr=` and `len=`. The decoded allowlists are preserved at `/tmp/opencode/agents_tools.txt`, one tab-separated `addr / short name / runtime type / tool count / comma-separated tools` line per agent; Appendix B was generated from that file.

**Note on `.rodata` layout.** The literals remain length-bucketed and concatenated with no NUL separators, which is why the earlier string-adjacency approach could not bind a description to a name. The registry walk sidesteps the layout entirely: pointers come from struct fields, and lengths are exact, so adjacency is never consulted.
