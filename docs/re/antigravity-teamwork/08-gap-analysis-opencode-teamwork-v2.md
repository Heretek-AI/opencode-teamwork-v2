# Gap Analysis — Antigravity `/teamwork` vs. `opencode-teamwork-v2`

A capability-by-capability comparison between the Antigravity `/teamwork`
subsystem and this repository. The Antigravity column is the reference
implementation, recovered by static analysis. The local column is measured from
this repository's source only.

## 0. Method and evidence rules

- **Antigravity side.** Facts are read from the corpus in this directory:
  `prompts/sentinel-routing.md` (697-line verbatim sentinel slice),
  `02-agent-registry.md` (the 49-entry `AllAgents` roster and per-agent dispatch
  text), and `00-artifact-identity.md` (package location and command
  description). The roster count used here is **49** — the membership of
  `teamwork.AllAgents`; the earlier "60+" figure counted identifier-like strings
  (runtime type names, prompt archetypes, source-file stems) and is superseded.
  Facts that are not in those slices — route-pipeline internals, the board's
  coordination mechanics and the five gating flags — are marked `(brief)` and
  are not re-derived here. The five flags' enforcement path is `UNKNOWN` on the
  Antigravity side.
- **Local side.** Every claim cites a file path and line range. Behaviour the
  source does not determine is written `UNKNOWN`; nothing is inferred from
  prompts about what the engine enforces.
- **Classes.** Exactly one per capability:
  - `PRESENT-EQUIVALENT` — same shape, comparable guarantees.
  - `WEAKER` — implemented, but with a named guarantee absent.
  - `DIVERGENT` — implemented differently on purpose; the difference is named.
  - `MISSING` — no equivalent.
- **Enforcement vs. prose.** The decisive axis is whether a guarantee is
  enforced by code or merely stated in a prompt. §1.6 separates the two
  locally; §2 notes it per capability.

## 1. Local capability inventory (as built)

### 1.1 Entry surface — 7 commands, registered unconditionally

`plugins/opencode-teamwork/index.ts:30-189` declares the command array;
`:215-230` registers each one through `ctx.command.transform` → `editor.add`,
switching the session agent with `ctx.session.switchAgent({ sessionID, agent })`
(`:223`) and substituting `$ARGUMENTS` textually (`:224-226`).

| Command | Agent | Declared at |
| --- | --- | --- |
| `/teamwork` | `team/sentinel` | `index.ts:31-65` |
| `/teamwork-craft` | `team/crafter` | `index.ts:66-92` |
| `/team-orchestrate` | `team/orchestrator` | `index.ts:93-113` |
| `/team-propose` | `team/orchestrator` | `index.ts:114-133` |
| `/team-falsify` | `team/orchestrator` | `index.ts:134-154` |
| `/team-synthesize` | `team/orchestrator` | `index.ts:155-172` |
| `/team-review` | `team/orchestrator` | `index.ts:173-188` |

No command is gated. There is no enable/disable flag, environment switch, or
admin control in `plugins/`, `lib/`, or `bin/` (searched for `disabled`,
`feature flag`, and `admin`). The worktree root is overridable via
`TEAMWORK_WORKTREES_DIR` (`plugins/opencode-teamwork/tools.ts:1659-1661`), but
that relocates state rather than gating the subsystem.

The `/teamwork` description is a multi-line operating instruction for the
sentinel (`index.ts:33-34`), not the Antigravity blurb "Preview the multi-agent
teamwork workflow." (`00-artifact-identity.md:91`).

### 1.2 Agents — 11

`lib/team.mjs:35-47` is the canonical roster; `agents/team/` holds one markdown
file per agent. One-line purposes (paraphrased from each file's frontmatter
`description:`):

| Agent | Purpose |
| --- | --- |
| `team/crafter` | Elicitation wizard; produces `prompt_draft.md` |
| `team/sentinel` | User-facing coordinator for `/teamwork` |
| `team/orchestrator` | Legacy propose/falsify/synthesize/verify loop |
| `team/scout` | Read-only context gatherer |
| `team/worker` | Implementation worker in its own worktree |
| `team/proof-worker` | Formal-proof worker (Lean/Coq/Isabelle) |
| `team/proposer` | One candidate solution per dispatch |
| `team/falsifier` | Adversarial critic of one candidate |
| `team/synthesizer` | Merges candidates and critiques |
| `team/verifier` | Verification forcing function |
| `team/security-auditor` | Read-only pre-merge security auditor |

All 11 are installed as markdown files because the V2 `AgentEditor` has no
`add` (`README.md:24`, `index.ts:8-11`). The installer writes them and the
plugin recreates only missing files on load
(`index.ts:198-211`).

### 1.3 Engine tools — 10, one namespace

`plugins/opencode-teamwork/tools.ts:795-1869` registers them under the
`teamwork` namespace (`:798-801`).

| Tool | Lines | What the code does |
| --- | --- | --- |
| `teamwork_plan` | `803-933` | Creates the run dir, validates task/dependency ids against `TASK_ID`, writes `plan.dag.json` / `state.json` / `costs.json` / `snapshots.json`, mints the session id |
| `teamwork_status` | `935-949` | Reads `state.json`, prints per-task status |
| `teamwork_resume` | `951-966` | Lists tasks whose status is not `pass` |
| `teamwork_cost` | `968-1121` | Reads real cost/tokens for the whole OpenCode session tree, tracks deltas in `snapshots.json`, warns at 80% |
| `teamwork_budget` | `1123-1149` | Detects `opencode/` models + connected `opencode_console`; returns instructions, applies nothing |
| `teamwork_pitfall` | `1151-1170` | Appends one line to `pitfalls.md` |
| `teamwork_next` | `1172-1361` | Dependency resolution, ready sets, deadlock, security gate, `ALL_TASKS_PASSED` |
| `teamwork_task_update` | `1363-1510` | Status whitelist, alias normalisation, `maxRounds` → `blocked`, phase advance, event append |
| `teamwork_security_audit` | `1512-1614` | Writes `verify/security-audit.json`; forces `FAIL` on any Critical/High finding |
| `teamwork_worktree` | `1616-1867` | `setup` / `diff` / `merge` / `resolve` / `cleanup`, worktrees outside the repo |

### 1.4 Hooks — 2

`registerTeamworkHooks` (`tools.ts:1871-1912`):

- `permission.hook("evaluate")` (`:1879-1903`) — per-agent deny list for
  `team/verifier`, `team/falsifier`, `team/scout`, `team/security-auditor`
  (`:508-515`), plus a narrow `webfetch` deny for `team/worker` and
  `team/verifier` when `prompt_draft.md` matches `network: denied`
  (`:1888-1902`).
- `session.hook("context")` (`:1906-1911`) — injects a sanitised run summary
  (`describeRun`, `:764-793`) into the system prompt of any `team/*` agent.

If the permission API is absent the plugin refuses to load (`:1874-1876`), so
the read-only guardrail cannot be silently dropped.

### 1.5 Artifact layout

One root per run, `.opencode/teamwork/<session-id>/` (`docs/ARTIFACTS.md:11-30`),
where the session id is `YYYYMMDD-HHMMSS-<4 hex>` (`:32`) and is minted by
`teamwork_plan` (`tools.ts:519-524`, `:834`). Files include `prompt_draft.md`,
`plan.dag.json`, `state.json`, `costs.json`, `snapshots.json`, `events.jsonl`,
`pitfalls.md`, `candidates/`, `critiques/`, `synthesis/`, `verify/`, `final.md`,
and optional `report.html` / `report.md` (`ARTIFACTS.md:12-30`).

Worktrees are created **outside** the repository (`tools.ts:1659-1662`,
`ARTIFACTS.md:34-36`), with per-task branches
`teamwork/<session-id>-<taskId>` (`tools.ts:1725`) and a sentinel base branch
`teamwork/base-<session-id>` (`:1663`).

"Active run" means *most recently modified run directory*: `resolveRun(root)`
with no id returns `listRuns(root)[0]` (`tools.ts:669-670`), and `listRuns`
sorts by mtime (`:617-641`). There is no active-run pointer, so two concurrent
runs are indistinguishable to a tool call that omits `sessionId`.

### 1.6 Code-enforced vs. prompt prose

**Enforced in code:**

- Session-id allowlist + lexical and realpath containment + symlink refusal
  (`tools.ts:581-600`, `:607-615`, `:648-671`).
- Task-id allowlist `TASK_ID` before any path, branch, or map key is built
  (`tools.ts:486-489`, `:840-846`, `:976-978`, `:1653-1657`;
  `ARTIFACTS.md:187-192`).
- Status set whitelist, legacy alias normalisation, and automatic
  `verified_fail → blocked` when `round >= maxRounds`
  (`tools.ts:1423-1452`).
- Dependency gating, deadlock detection, `READY_FOR_SECURITY_AUDIT`,
  `BLOCKED_BY_SECURITY`, `ALL_TASKS_PASSED` (`tools.ts:1200-1324`).
- Security gate: any Critical/High finding forces `FAIL`
  (`tools.ts:1555-1558`); `PASS` sets the phase to `MERGE` (`:1578-1579`).
- Read-only guarantee for four agents, fail-closed on a missing permission API
  (`tools.ts:508-515`, `:1874-1886`).
- Cost/token accounting read from OpenCode's database, service API, or client,
  with delta tracking (`tools.ts:211-324`, `:1019-1066`;
  `ARTIFACTS.md:224-254`).
- Serialised read-modify-write within the process (`tools.ts:746-758`) and
  best-effort, fail-open `events.jsonl` (`:696-740`, `ARTIFACTS.md:316-325`).

**Prompt prose only (not enforced):**

- The sentinel does not edit code (`agents/team/sentinel.md:118-121`).
- Topology selection and alias normalisation (`sentinel.md:34-37`,
  `orchestrator.md:39-61`). `teamwork_plan` writes `topology` as a free string
  after `clean()` and never validates it (`tools.ts:811`, `:857`); no tool
  branches on it.
- Existence of `prompt_draft.md` before `teamwork_plan`
  (`sentinel.md:30-33`). `teamwork_plan` never checks for it
  (`tools.ts:833-933`); the only reader anywhere is the network-deny hook
  (`:1892`).
- Production and consumption of `verify/report-<task>.json` and
  `verify/final.json` (`sentinel.md:73`, `:97-101`, `index.ts:53`). No engine
  tool reads either file; only the export report parses `final.json`
  (`lib/export.mjs:370`).
- `interrupted.md` when the user stops a run (`orchestrator.md:106`;
  `ARTIFACTS.md:29`) — legacy agent only; no tool writes it.
- Worker `handoff.md` when stuck (`agents/team/worker.md:71-73`).
- "Halt non-essential workers" at 80% budget — `teamwork_cost` returns
  `shouldHalt` (`tools.ts:1110-1118`) but nothing enforces a halt.
- Worktree/cwd confinement for writers (`docs/GUARDRAILS.md:27-31`).
- `constraints.network` / `constraints.sandbox` beyond the narrow `webfetch`
  slice above (`GUARDRAILS.md:32-33` vs `tools.ts:1888-1902`).

### 1.7 Support surface

- CLI with 10 subcommands plus `help` — `init`, `models`, `install`, `status`,
  `runs`, `inspect`, `timeline`, `export`, `prune`, `doctor`
  (`bin/opencode-teamwork.mjs:40-75`, `README.md:110-122`).
- Package at `0.5.6` (`package.json:3`); `npm test` chains prompt lint, cost,
  engine, doctor, timeline and export suites (`package.json:44-62`).
- The prompt linter enforces invariants in CI: one artifact root, one topology
  enum, no stale references, and the guardrail docs
  (`scripts/lint-prompts.mjs:2-9`, `:100-110`).

### 1.8 Inconsistencies observed while reading (stated, not fixed)

These bound what the local engine can honestly claim:

1. **`verified_pass` is invisible to two tools.** `teamwork_status` counts
   `status === "pass"` (`tools.ts:946`) and `teamwork_resume` filters
   `status !== "pass"` (`:960`), while the lifecycle and `describeRun` use
   `verified_pass` (`ARTIFACTS.md:128-135`, `tools.ts:770-771`). After a normal
   run, `status` reports `0/N pass` and `resume` reports a finished run as open.
2. **The state machine's ordering is not enforced.** `teamwork_task_update`
   whitelists the seven statuses (`tools.ts:1428-1439`) but never checks the
   previous status, so `pending → verified_pass` is accepted (`:1441-1464`).
   `README.md:66` calls these "deterministic task state machine transitions";
   only the status *set* and the `maxRounds` coercion are deterministic.
3. **`verified_pass` needs no evidence.** The `verification` payload is optional
   (`tools.ts:1386-1394`) and no tool reads `verify/report-<task>.json`.
4. **Network enforcement is narrower than the README says.** `README.md:70-74`
   says the hook "enforces network constraints (`constraints.network: denied`)".
   The code denies `webfetch` only, only for `team/worker` and `team/verifier`,
   and only via a regex over `prompt_draft.md` (`tools.ts:1888-1902`).
   `GUARDRAILS.md:32-33` calls this honor-system, which is closer but not exact.
5. **Plugin tools are not agent-scoped** (`GUARDRAILS.md:34-36`): any agent in a
   run can call `teamwork_task_update` or `teamwork_security_audit`.

## 2. Per-capability classification

Class counts over 18 capabilities: 1 `PRESENT-EQUIVALENT`, 2 `DIVERGENT`,
8 `WEAKER`, 7 `MISSING`.

### 2.1 Entry and routing

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 Slash-command entry | `/teamwork`, described "Preview the multi-agent teamwork workflow." (`00-artifact-identity.md:88-91`); dispatches the sentinel | `/teamwork` switches the session to `team/sentinel` and injects a multi-step operating template with `$ARGUMENTS` substituted (`index.ts:31-65`, `:215-230`). Six further commands expose the legacy loop's stages and the crafter (`index.ts:66-188`) | **PRESENT-EQUIVALENT** | Same entry shape: one command hands the request to a coordinator agent. Local additionally exposes stage commands | `plugins/opencode-teamwork/index.ts:30-230`; `00-artifact-identity.md:88-91` |
| A2 Interview gate before routing | `teamwork_interviewer` runs before routing; the run starts only after the user approves a task prompt; `[skip-interview]` bypasses (`sentinel-routing.md:426-522`, `:690`; sentinel dispatch row `02-agent-registry.md:101`, prompt-level-actor note `:144`). `teamwork_interviewer` is a prompt-level dispatch target, not an `AllAgents` registry entry (`02:144`) | Elicitation exists as an optional upstream command: `/teamwork-craft` runs a 9-step wizard producing `prompt_draft.md` (`index.ts:66-92`, `crafter.md:27-77`). When no spec is found, the sentinel's template says to "ask 1-2 short questions to pick the topology" and then run the crafter or inline the answers (`index.ts:38`); the sentinel prompt itself says to ask and use the crafter (`sentinel.md:30-33`). Nothing blocks `teamwork_plan` on a missing spec (`tools.ts:833-933`) | **WEAKER** | The absent guarantee is the barrier: no approved prompt is required, there is no skip token because there is no gate, and a request can be dispatched with no falsifiable spec. The spec wizard is otherwise a stronger, more explicit form of the interview | `index.ts:38`, `:66-92`; `docs/ARTIFACTS.md:13`; `agents/team/crafter.md:27-77`; `agents/team/sentinel.md:30-33`; `tools.ts:833-933`; `sentinel-routing.md:426-522` |
| A3 Router: 6-route taxonomy, ordered procedure, anti-patterns, default General | Six named routes — Document Review, Formal Math / Lean 4 (LEMMA), Math / Proof (Large Team), Math / Proof, SWE Light, General — a five-step ordered procedure, a nine-item anti-pattern list ("do not deliberate endlessly", "do not split a request across paths", "do not route to SWE Light just because it sounds small", "do not re-route mid-execution"), and default General (`sentinel-routing.md:523-640`, `:642-672`) | A **topology** enum exists: six values recorded in `plan.dag.json` (`ARTIFACTS.md:40-51`, `tools.ts:811`), chosen by prompt prose (`sentinel.md:34-37`). A signal→topology table with a default lives in the **legacy** orchestrator (`orchestrator.md:39-61`: "ambiguous … ask the user once, then default to `distributed-coding`"). The sentinel has no decision procedure, no anti-pattern list, no default. `teamwork_plan` does not validate the value (`tools.ts:857`) and no tool behaviour depends on it | **WEAKER** | Topology is a DAG-shape label, not a request-class router: it selects nothing, accepts any string, and records no rationale. A typo becomes a run's permanent label; a wrong route is invisible afterwards | `agents/team/sentinel.md:34-37`; `agents/team/orchestrator.md:39-61`; `docs/ARTIFACTS.md:40-51`; `tools.ts:811`, `:857`; `sentinel-routing.md:523-672` |

### 2.2 Recording and continuity

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A4 Record the routed request once, before the chosen agent starts | The routed text is recorded once in `.agents/teamwork/ORIGINAL_REQUEST.md` before dispatch; later messages are appended; it is the baseline an auditor checks the work against (`sentinel-routing.md:263-288`, `:691`) | `prompt_draft.md` is a **drafted spec** produced by the crafter/wizard, not a verbatim record of the text routed on (`ARTIFACTS.md:13`, `crafter.md:79-90`). No tool writes or requires it (`tools.ts:833-933`); the sentinel only looks for one (`index.ts:38`). No append-only request log exists | **MISSING** | The original wording is lost: a spec is a transformation of the request, so a later "does the work match what was asked" check has no verbatim baseline, and nothing guarantees the file exists or predates dispatch | `docs/ARTIFACTS.md:13`; `plugins/opencode-teamwork/index.ts:38`; `tools.ts:1892`; `agents/team/crafter.md:79-90`; `sentinel-routing.md:263-288` |
| A5 `## Parameters` block for bracket-led requests | When a request began with a recognised bracket, the bracket is preserved verbatim in its own section with the line "How this run was launched; not part of the task." (`sentinel-routing.md:426-445`, `:691`) | No equivalent. The whole argument text is passed through `$ARGUMENTS` substitution (`index.ts:224-226`); there is no parameter grammar or recording convention | **MISSING** | Launch modifiers are indistinguishable from task text. Low impact today because the plugin defines no launch modifiers, and it is the prerequisite for A2's skip token | `plugins/opencode-teamwork/index.ts:224-226`; `sentinel-routing.md:426-445` |
| A6 `BRIEFING.md` mission/identity, re-read when out of context | Mission, identity, key constraints, active orchestrator, progress, victory-audit status, artifact index; re-read whenever it falls out of recent context (`sentinel-routing.md:105-179`, `:692`) | No briefing file. The substitute is the `session.context` hook, which injects a sanitised summary — run id, phase, pass/fail counts, cost, state path — into every `team/*` agent's prompt (`tools.ts:764-793`, `:1906-1911`) | **WEAKER** | Continuity is automatic rather than a re-read convention, which is stronger for *state*, but carries none of mission, identity, decisions, or acceptance criteria. After compaction an agent knows the run exists, not what it is for | `tools.ts:764-793`, `:1906-1911`; `sentinel-routing.md:105-179` |
| A7 `handoff.md` five-part protocol | Fixed structure: Observation, Logic Chain, Caveats, Conclusion, Verification Method; the sentinel rewrites its own handoff each cycle (`sentinel-routing.md:697`) | `handoff.md` appears once, as an instruction to a **stuck** worker: write what is left and stop (`worker.md:71-73`). No structure is mandated; no other agent writes one | **WEAKER** | A handoff artifact exists but not a protocol: reasoning, caveats, and verification instructions are not required, so a successor starts from a status note, and only after a worker declares itself stuck | `agents/team/worker.md:71-73`; `sentinel-routing.md:697` |

### 2.3 Monitoring and completion

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A8 Progress monitoring with `Sentinel Monitoring` → `Cleanup` | Two crons: `*/8` progress reporting (reads `progress.md` / `BRIEFING.md`, scans the top recently modified workspace files) and `*/20` liveness (kill and re-spawn a dead orchestrator); cleanup cancels timers and subagents (`sentinel-routing.md:324-376`) | No scheduler of any kind: no `setInterval` or cron in `plugins/`, `lib/`, or `bin/`; `setTimeout` appears only in the request-timeout helper (`tools.ts:346-352`). Progress is pull-only: `teamwork_status` reads `state.json` on request (`:935-949`) and `describeRun` re-injects state each turn (`:764-793`) | **MISSING** | No proactive progress reports and no liveness recovery: a stalled worker is noticed only when the sentinel's next turn runs or the user asks. Separately, `teamwork_status` mis-reports `verified_pass` runs as incomplete (§1.8 #1) | `tools.ts:346-352`, `:935-949`, `:764-793`; `sentinel-routing.md:324-376` |
| A9 Victory audit: a claim is never accepted at face value | Route-dependent verification (`sentinel-routing.md:673-683`). SWE runs its own blocking auditor (at most two) and must cite `VICTORY CONFIRMED`; Document Review spawns `teamwork_document_victory_auditor`; Math / Proof (Large Team) reports its pipeline's own verified result; LEMMA accepts a kernel-checked proof without a second auditor; every unlisted route spawns `teamwork_victory_auditor`. `VICTORY REJECTED` → forward the audit report and resume the team; the audit is given `ORIGINAL_REQUEST.md` as its baseline | A real code gate exists but answers a different question: the mandatory pre-merge **security** audit (`tools.ts:1274-1302`, `:1512-1614`, `sentinel.md:87-92`). Completion is decided by task statuses plus that audit (`tools.ts:1274-1315`). An independent final verifier is prompt prose writing `verify/final.json` (`sentinel.md:97-101`, `index.ts:53`), read by no engine tool and only by the export report (`lib/export.mjs:370`; `ARTIFACTS.md:435-445`). No auditor measures fidelity to the request | **WEAKER** | The strongest local gate asks "is this safe to merge", not "is this what was asked". `teamwork_next` returns `ALL_TASKS_PASSED` on statuses + security alone, so a run can be reported complete with an unread final verdict — and, because `verified_pass` needs no evidence or legal predecessor (§1.8 #2-3), with no verified work at all | `tools.ts:1274-1315`, `:1512-1614`, `:1428-1464`; `agents/team/sentinel.md:87-101`; `agents/team/security-auditor.md:2`; `lib/export.mjs:370`; `sentinel-routing.md:673-683` |
| A10 Terminal-state discipline: pause vs. terminal non-victory vs. confirmed completion | Three explicit branches with what *not* to do: pause → no auditor, no cleanup, never report completion; terminal non-victory → no auditor, run cleanup, never report completion; confirmed → cleanup, report (`sentinel-routing.md:673-683`, `:359-375`) | Terminal *states* exist in code: `PRESENT_PARTIAL` when nothing is active and something is blocked (`tools.ts:1473-1475`), `DEADLOCK` (`:1317-1324`), `BLOCKED_BY_SECURITY` (`:1285-1294`). The sentinel is told to present the partial result and open reports (`sentinel.md:93-96`). No pause state (`PHASES`, `:503`), no cleanup rule, no prohibition on announcing completion; `interrupted.md` is prose in the legacy agent only (`orchestrator.md:106`) | **WEAKER** | Partial outcomes are represented, which is the important half. But there is no defined behaviour for "the user answered a question mid-run", and nothing stops a completion claim after a DEADLOCK or with a missing final report | `tools.ts:503`, `:1473-1475`, `:1317-1324`, `:1285-1294`; `agents/team/sentinel.md:93-96`; `agents/team/orchestrator.md:106`; `sentinel-routing.md:673-683` |

### 2.4 Route-specific pipelines

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A11 SWE Light: one implementer, repeated reviewer rounds over a **cumulative open-issues ledger**, correctness by running tests, orchestrator writes no code | One `teamwork_implementer`; reviewer rounds carry a cumulative open-issues ledger; the gate is tests; the orchestrator does not write code (`02-agent-registry.md:102-104`; ledger rule `04-pipeline-topologies.md:522`) | Generic DAG loop: worker → verifier → `verified_fail` → re-dispatch with feedback until `maxRounds` (`tools.ts:1258-1270`, `:1450-1452`; `ARTIFACTS.md:128-138`). Feedback is a **single string overwritten each round** (`tools.ts:1461`, capped at 500 chars); the verifier's report is written but never read by the engine (`ARTIFACTS.md:327-344`). "Sentinel does not edit code" is prose (`sentinel.md:118-121`). Tests-as-gate is the verifier's rubric, not an engine check | **WEAKER** | Convergence quality is the gap: a round-2 worker sees only the previous round's last feedback, not the ledger of every open issue, so fixed-then-regressed problems can reappear. `small-focused` (1 worker + 1 verifier; `ARTIFACTS.md:42`) is the closest existing shape | `tools.ts:1258-1270`, `:1461`; `docs/ARTIFACTS.md:42`, `:128-138`, `:327-344`; `agents/team/sentinel.md:118-121`; `02-agent-registry.md:102-104` |
| A12 Document Review: segment triage → `teamwork_group` per segment (RSA review tree) → cross-segment synthesis → `teamwork_synthesizer` | Multi-stage pipeline with per-segment group agents and a synthesis stage (`02-agent-registry.md:97-99`; `sentinel-routing.md:530-539`) | `document-review` is a label only: "1 chair + 3 critics + 1 aggregator" (`ARTIFACTS.md:47`). No segment triage, no per-segment agent, no review tree, no segment handoff or candidate artifacts (`synthesis/` holds only `syn-<n>.md` and conflict JSON, `ARTIFACTS.md:22-23`, `:368-383`). No tool reads topology (`tools.ts:857`) | **MISSING** | A document review must be hand-composed by the sentinel in its prompt loop, with no segmentation discipline and no per-segment isolation. A long document is reviewed as one blob | `docs/ARTIFACTS.md:22-23`, `:47`; `tools.ts:857`; `02-agent-registry.md:97-99` |
| A13 LEMMA pipeline + capability gate | `teamwork_worker` / `planner` / `reviewer` / `verifier` / `formalizer` / `formalization_reviewer`; gated on user-installed `leap-tools` + Lean; **stops before work** when absent (`02-agent-registry.md:70-76`, `:224-235`; `sentinel-routing.md:572-573`) | One `team/proof-worker` whose diff is a Lean/Coq/Isabelle proof and whose verifier is the formal checker (`proof-worker.md:1-2`, `:29-46`); `proof` topology is "1 strategist + 3-5 searchers + 1 formal checker" (`ARTIFACTS.md:45`). No toolchain probe, no gate, no stop-before-work, and no planner/formalizer/formalization-reviewer split | **WEAKER** | A Lean request is attempted and fails at compile time instead of being refused before budget is spent. No separation between informal reasoning and formalization review, where Lean proofs usually break | `agents/team/proof-worker.md:1-2`, `:29-46`; `docs/ARTIFACTS.md:45`; `02-agent-registry.md:70-76` |
| A14 Theorem proving: 5-phase outer loop delegating tournament-tree levels to `teamwork_layer` | Phase loop plus a layer agent owning tournament-tree levels (`02-agent-registry.md:69`, `:86`; `sentinel-routing.md:536`) | `massive-proof` is a string in the topology list ("1 meta-coordinator + 100+ searchers (opt-in)", `ARTIFACTS.md:46`) plus a 24 h cap in the command template (`index.ts:56`). No layer agent, no tournament bracket, no phase object: `teamwork_next` runs the same generic task/round loop (`tools.ts:1183-1360`), and "100+" is prose | **MISSING** | The declared shape is not implemented: wide search is just many independent tasks whose results the root model must reconcile itself, with no elimination or per-level aggregation | `docs/ARTIFACTS.md:46`; `plugins/opencode-teamwork/index.ts:56`; `tools.ts:1183-1360`; `02-agent-registry.md:69`, `:86` |
| A15 Dependency pre-flight: BLOCKING audit naming every file, folder and URL | `teamwork_dependency` is dispatched before routes whose Route Summary marks a pre-flight audit required (Document Review, LEMMA); it must name every file, folder and URL the request names; verdicts READY / MISSING / OUTAGE are blocking, and the sentinel never installs anything (`sentinel-routing.md:61-72`, `:530-539`). It is a dispatch target, not a route; `teamwork_dependency` is a prompt-level actor and is not an `AllAgents` registry entry (`02-agent-registry.md:144`) | No equivalent. `dependsOn` in `plan.dag.json` is task ordering (`ARTIFACTS.md:81-97`, `tools.ts:1223-1241`), not an input inventory. Missing inputs surface as worker failures mid-DAG | **MISSING** | Budget is spent before missing prerequisites are discovered, and there is no place where the request's named files and URLs are enumerated and checked | `tools.ts:1223-1241`; `docs/ARTIFACTS.md:81-97`; `sentinel-routing.md:61-72`, `:530-539`; `02-agent-registry.md:144` |

### 2.5 Coordination, roster, gating

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A16 Coordination surface: shared swarm board with sequenced posts, inbox, per-segment handoffs, `candidate_*.md`, `teamwork_tmp` | A mutable shared board with sequenced posts and an inbox, including the post format `Post %d/%d (seq #%d by %s)` `(brief)`; per-agent state folders under `.agents/teamwork/<type>_<milestone>/` and scratch space at `teamwork_tmp` (`sentinel-routing.md:306-323`, `:257-258`) | Deliberately the opposite: **one file per artifact**, no shared mutable state — `candidates/cand-<n>.md`, `critiques/crit-<n>.md`, `synthesis/syn-<n>.md`, `verify/report-<task>.json`, plus an append-only `events.jsonl` (`ARTIFACTS.md:11-30`, `:256-325`). No board, inbox, segment folders, or `teamwork_tmp` anywhere in `plugins/`, `lib/`, or `agents/` (searched) | **DIVERGENT** | Trade-off, not a shortfall: no cross-writer ordering or contention, and every artifact is sanitised and path-contained (`GUARDRAILS.md:18-25`). The loss is inter-agent messaging and post attribution: `events.jsonl.agent` is caller-reported and unverified (`ARTIFACTS.md:296-304`), and concurrent runs share no coordination channel at all | `docs/ARTIFACTS.md:11-30`, `:256-325`, `:296-304`; `sentinel-routing.md:306-323` |
| A17 Roster breadth — 49 `AllAgents` registry entries | 49 decoded registry entries: 39 core (sentinel, orchestrators, critics, workers, LEMMA, math/proof, audit, curation, pipeline, entry) plus 5 `@document_review`, 3 `@swe_light`, 1 `@colosseum` and 1 `@external` (`02-agent-registry.md:44-104`). `swarm_*` names are source files, not registry entries; `teamwork_dependency` and `teamwork_interviewer` are prompt-level actors (`02:144`) | 11 agents, each installed as a file in the user's config dir (`lib/team.mjs:35-47`), with one worker/verifier pair parameterised by `spec.json` and `plan.dag.json` (`ARTIFACTS.md:55-77`, `tools.ts:848-856`) | **DIVERGENT** | 11 is a deliberate fit for a plugin that installs agents into the user's own config and makes them visible in the UI (`CHANGELOG.md:48-50`, `README.md:307-314`). The loss is role specialisation: no dependency auditor, document segment reviewer, formalization reviewer, or curator exists, which is why A12/A14/A15 are missing and A13 is weak rather than merely smaller | `lib/team.mjs:35-47`; `docs/ARTIFACTS.md:55-77`; `CHANGELOG.md:48-50`; `README.md:307-314`; `02-agent-registry.md:44-104` |
| A18 Gating: `TeamworkPreviewCommandDisabled`, `enable-teamwork-subagent`, `disable-teamwork-forced-flash-model`, `TeamworkDefaultsToFlash`, `teamworkDisabled` | Admin/feature flags around the subsystem; enforcement path `UNKNOWN` (`brief`) | No flags. All 7 commands register unconditionally (`index.ts:215-230`); models are per-agent frontmatter (`README.md:235-245`, `lib/team.mjs:35-47`). The installer exposes `--dry-run`, `--no-register`, and `--refresh` (`bin/opencode-teamwork.mjs:57-75`, `:100-110`); none of them disables the subsystem | **MISSING** | There is no way to disable `/teamwork` short of removing the plugin or its config entry. Whether that is a gap depends on the host: this material documents no OpenCode V2 admin surface, so an equivalent control may not exist to implement. Antigravity enforcement: `UNKNOWN` | `plugins/opencode-teamwork/index.ts:215-230`; `lib/team.mjs:35-47`; `bin/opencode-teamwork.mjs:57-75`; `(brief)` |

## 3. Highest-value upgrades

Ranked by (user-visible quality gain) ÷ (implementation effort). Six items; no
padding. Item 3.1 is first on ratio; 3.2 is the largest absolute gain.

### 3.1 Fix completion accounting in `teamwork_status` / `teamwork_resume`

**Gap.** §1.8 #1. Both tools recognise only the legacy `pass` (`tools.ts:946`,
`:960`), while the canonical terminal state is `verified_pass`
(`ARTIFACTS.md:128-135`).

**Change.** Accept both spellings, as `describeRun` already does
(`tools.ts:770-771`). Two predicates, two lines.

**Why.** Near-zero effort against a defect that makes the two tools users reach
for first actively mislead: a finished run reads "0/N pass" and as having open
tasks. It also repairs the human-facing half of the monitoring gap that a
scheduler cannot close locally (§4.1).

### 3.2 Make completion a gate that reads evidence — `teamwork_next`

**Gap.** A9. `ALL_TASKS_PASSED` is decided from task statuses plus the security
audit (`tools.ts:1274-1315`); the independent final verdict that
`sentinel.md:97-101` tells the model to produce is never read by any tool.

**Change.** In the `passedTasks.length === taskDefs.size` branch
(`tools.ts:1274`), after the security check, read `verify/final.json`. Treat a
missing file as not done: return `READY_FOR_FINAL_VERIFICATION` instead of
`ALL_PASSED`; return a partial status when it reports `FAIL`. Mirror the audit
branch's phase handling (`tools.ts:1304-1307`). Export already parses the file
(`lib/export.mjs:370`, `ARTIFACTS.md:435-445`), so the schema and tolerance
rules exist.

**Why.** It converts the most consequential claim in the system — "done" — from
prose into a precondition, and reuses an artifact the pipeline already produces.
One function, no new agent, no new format.

### 3.3 Make `verified_pass` unforgeable — `teamwork_task_update`

**Gap.** A9 plus §1.8 #2-3. The status set is whitelisted, but the transition
graph is not (`tools.ts:1428-1464`); `verification` is optional
(`:1386-1394`); no tool reads `verify/report-<task>.json`.

**Change.** Add an allowed-predecessor map and refuse anything else, e.g.
`verified_pass` only from `verifier_active`, and only when
`verification.status === "PASS"` or a `verify/report-<task>.json` exists on
disk. Keep `blocked` reachable from every state so escalation never deadlocks.
Return the refusal as a tool error the sentinel must handle.

**Why.** Every downstream guarantee (security gate, completion, export status)
inherits its truth from this field. Without this, 3.2 can be satisfied by a
fabricated record.

### 3.4 Gate dispatch on a spec — `teamwork_plan`

**Gap.** A2. The sentinel *may* ask questions and *may* use the crafter
(`sentinel.md:30-33`, `index.ts:38`); `teamwork_plan` accepts a task list
unconditionally (`tools.ts:833-933`).

**Change.** Add `requireSpec` (default true) and `skipInterview` (boolean) to
`teamwork_plan`'s input. When `requireSpec` is true and
`<run>/prompt_draft.md` is absent, refuse and tell the caller to run
`/teamwork-craft` or re-call with `skipInterview: true`. Record the bypass in
the new run's `events.jsonl` (`run_created`, `tools.ts:696-740`, `:922`) so it
is visible in `timeline` and `export`.

**Why.** This is the Antigravity gate reduced to one boolean and one file check,
and it makes the escape explicit rather than implicit — the property worth
copying, not the interviewer agent.

### 3.5 Validate the topology enum and persist the routing decision

**Gap.** A3. `topology` is written after `clean()` with no enum check
(`tools.ts:857`); no rationale is recorded anywhere.

**Change.** Validate against the six canonical values plus the four legacy
aliases, normalised on write (`ARTIFACTS.md:49-51`), and refuse otherwise — the
pattern already used for task ids (`tools.ts:840-846`). Add an optional
`routingReason` string (capped by `clean()`) to `teamwork_plan`, persist it in
`plan.dag.json`, and surface it in `inspect` (`lib/runs.mjs`) and the export
summary.

**Why.** Cheap, and it closes a real hole: a typo'd topology silently becomes a
run's permanent label. It also creates the record any future triage logic
(A12/A15) would need.

### 3.6 Cumulative open-issue ledger per task

**Gap.** A11. Round feedback overwrites a single 500-char field
(`tools.ts:1461`); `teamwork_next` injects only that field plus pitfalls
(`:1258-1270`).

**Change.** Append each round's feedback to `verify/issues-<task>.md` (or a
`feedbackLog` array in `state.tasks[<id>]`), and have `teamwork_next` include
the whole unresolved set in `readyForWorker[].feedback`, condensed to entries
not yet marked fixed. Marking fixed can piggyback on the existing verifier
payload (`verification`, `tools.ts:1386-1394`), so no new agent contract.

**Why.** This is what makes repeated review rounds converge rather than repeat,
and it is contained to two tools plus one artifact. It is ranked last because it
needs a small schema decision, unlike 3.1-3.5.

## 4. Do not port

### 4.1 Cron-based monitoring with project-file scanning

The plugin has no scheduler (§2.3), and its tools are request/response:
`ctx.tool.transform`, `ctx.permission.hook`, `ctx.session.hook`,
`ctx.command.transform` (`index.ts:213-230`, `tools.ts:795-801`, `:1879-1911`).
The Antigravity mechanism also depends on `progress.md` / `BRIEFING.md`
conventions and a scan of recently modified project files
(`sentinel-routing.md:324-376`) that has no local counterpart and would emit
guesses about work the plugin cannot observe. Improve `teamwork_status`,
`timeline`, and the export report instead — they report from recorded state,
which the local design can do honestly.

### 4.2 Cleanup that kills subagents

Antigravity's `Sentinel Monitoring` cleanup cancels timers and kills subagents
(`sentinel-routing.md:359-372`). The plugin uses no such API: the only
subagent-facing call is `ctx.session.switchAgent` (`index.ts:223`), and no kill
primitive appears in `plugins/`, `lib/`, or `bin/`. Whether the V2 host exposes
one is `UNKNOWN`. `GUARDRAILS.md:27-40` deliberately declines destructive powers
it cannot confine. `teamwork_worktree({ action: "cleanup" })`
(`tools.ts:1847-1863`), which prunes worktrees, already covers the reversible
half.

### 4.3 Shared swarm board, inbox, and `teamwork_tmp`

A mutable board with sequenced posts and an inbox is a second coordination plane
competing with the run directory, and it widens the injection surface:
`GUARDRAILS.md:37-39` already treats run artifacts as untrusted control data,
and every board post would be a new untrusted-input path into prompts. The
one-file-per-artifact layout (`ARTIFACTS.md:11-30`) plus sanitised injection in
`describeRun` (`tools.ts:764-793`) is the safer shape. Port the *handoff* idea
(A7), not the board.

### 4.4 A 49-entry agent roster

Local agents are markdown files installed into
`~/.config/opencode/agents/team/` and deliberately visible in the UI
(`lib/team.mjs:35-47`, `CHANGELOG.md:48-50`, `README.md:307-314`). The Antigravity
roster's 49 `AllAgents` entries would flood the picker, multiply the per-agent model assignment the
installer performs (`lib/team.mjs:35-49`), and duplicate capability the engine
expresses through `spec.json` and DAG tasks. Add roles only where a *contract*
differs (a dependency auditor, a formalization reviewer), never for breadth.

## 5. What this comparison does not establish

- Whether the local `session.context` injection reaches every subagent session
  on every OpenCode V2 build: `UNKNOWN` (it depends on host hook delivery; the
  code registers it at `tools.ts:1906-1911`).
- Whether `ctx.command.transform` failures are fail-open or fail-closed in the
  host: `UNKNOWN` (no local code handles a registration failure, `index.ts:215`).
- Antigravity's enforcement path for its five gating flags: `UNKNOWN` (brief).
- Whether Antigravity's route agents beyond the sentinel can be reused across
  runs: `UNKNOWN`; the recovered sentinel text states a no-reuse-after-handoff
  rule (`sentinel-routing.md:289-297`).
- Whether the V2 host exposes a subagent-kill or scheduler API: `UNKNOWN`; no
  such call appears in the local source (§4.1-4.2).
