# Gap Analysis — Antigravity `/teamwork` vs. `opencode-teamwork-v2`

A capability-by-capability comparison between the Antigravity `/teamwork`
subsystem and this repository. The Antigravity column is the reference
implementation, recovered by static analysis and, where noted, by runtime
observation. The local column is measured from this repository's source only.

> **Revision 2.** The first revision predated `07`, `09`, `10` and `11` and the
> engine changes that implemented its own §3.1–§3.6. §2.6 lists the findings
> that changed the table, each with its source document; §3.0 records where the
> first revision's proposals now live.
>
> **Revision 3.** Records the shipment of revision 2's own §3.1–§3.3 in `0.5.7`
> and the final-verification provenance, stamped completion gate and CI work in
> `0.5.8`. §3.0 lists both shipments; §3 now holds only the remaining open work.
>
> **Revision 4.** Revision 3's §3.1 and §3.2 shipped in `0.5.9`:
> integrity-rule enforcement in `teamwork_security_audit`, and the input
> pre-flight gate in `teamwork_plan` plus the new `teamwork_preflight` tool.
> §3.0 records both; A15 and A19 are reclassified below; no open item remains in
> §3.

## 0. Method and evidence rules

- **Antigravity side.** Three evidence classes are used, and they are not
  interchangeable:
  - **binary / prompt text** — `prompts/sentinel-routing.md` (697-line verbatim
    sentinel slice), `02-agent-registry.md` (the 49-entry `AllAgents` roster,
    per-agent dispatch text and decoded tool allowlists), `10-official-docs-cross-check.md`
    (docs vs. binary byte offsets);
  - **materialised source** — `09-swarm-board-and-skills.md` reads the shipped
    sidecar and skills directly, so its mechanical claims are `file:line` facts
    rather than inference;
  - **runtime** — `07-runtime-observed.md` (one live, quota-partial dispatch) and
    `11-runtime-artifacts.md` (the on-disk state tree of 39 prior runs plus one
    observed gate).
  The roster count used here is **49** — the membership of `teamwork.AllAgents`
  (`02-agent-registry.md:129-146`). The earlier "60+"/"70+" figures counted
  identifier-like strings (runtime type names, prompt archetypes, source-file
  stems) and are superseded.
  Where the sample is one milestone or one route family, this document says
  `UNKNOWN` rather than generalising. In particular, the gate composition in
  §2.4 is observed, not established as universal (`11` §5.1).
- **Local side.** Every claim cites a file path and line range, measured against
  the tree containing this revision. `plugins/opencode-teamwork/tools.ts` was
  re-read after the engine changes that closed the first revision's §3 and again
  for `0.5.9`; §1.3 and the A15/A19 rows carry current line numbers. Numbers in
  rows last revised before `0.5.9` predate its insertions and have shifted, but
  the cited symbols are unchanged. Behaviour the source does not determine is
  written `UNKNOWN`.
- **Classes.** Exactly one per capability:
  - `PRESENT-EQUIVALENT` — same shape, comparable guarantees.
  - `WEAKER` — implemented, but with a named guarantee absent.
  - `DIVERGENT` — implemented differently on purpose; the difference is named.
  - `MISSING` — no equivalent.
- **Enforcement vs. prose.** The decisive axis is whether a guarantee is
  enforced by code or merely stated in a prompt. §1.6 separates the two
  locally; §2 notes it per capability. The Antigravity evidence now supplies a
  worked example of the distinction: the explorer's role text says read-only
  and its allowlist contains all three write tools (`10` §3.5).

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
`TEAMWORK_WORKTREES_DIR` (`plugins/opencode-teamwork/tools.ts:1838-1840`), but
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
plugin recreates only missing files on load (`index.ts:198-211`).

### 1.3 Engine tools — 12, one namespace

`plugins/opencode-teamwork/tools.ts:1214-2869` registers them under the
`teamwork` namespace (`:1214-1217`).

| Tool | Lines | What the code does |
| --- | --- | --- |
| `teamwork_plan` | `1219-1484` | Creates the run dir; validates topology, task/dependency ids, integrity mode and the spec gate; runs the blocking input pre-flight before `mkdir`; writes `ORIGINAL_REQUEST.md` once when a request is supplied; writes `plan.dag.json` / `state.json` / `costs.json` / `snapshots.json`; mints the session id |
| `teamwork_preflight` | `1487-1555` | Re-runs the input inventory for an existing run, writes `<run>/preflight.json`, appends a `preflight` event; never refuses and never throws |
| `teamwork_status` | `1558-1571` | Reads `state.json`, prints per-task status (counts both `pass` and `verified_pass`) |
| `teamwork_resume` | `1574-1589` | Lists tasks whose status is not a passing state |
| `teamwork_cost` | `1591-1744` | Reads real cost/tokens for the whole OpenCode session tree, tracks deltas in `snapshots.json`, warns at 80% |
| `teamwork_budget` | `1746-1772` | Detects `opencode/` models + connected `opencode_console`; returns instructions, applies nothing |
| `teamwork_pitfall` | `1774-1793` | Appends one line to `pitfalls.md` |
| `teamwork_next` | `1795-2083` | Dependency resolution, ready sets, deadlock, security gate, stamped final-verification gate (`FINAL_VERIFICATION_UNVERIFIED`), `ALL_TASKS_PASSED` |
| `teamwork_task_update` | `2085-2299` | Status whitelist, alias normalisation, transition graph, PASS evidence, `maxRounds` → `blocked`, cumulative feedback ledger, phase advance, event append |
| `teamwork_security_audit` | `2302-2467` | Writes `verify/security-audit.json`; forces `FAIL` on any Critical/High finding or any integrity finding forbidden at the run's mode |
| `teamwork_final_verify` | `2470-2615` | Computes the verdict from task states, `verify/report-<task>.json` and the security audit; writes and stamps `verify/final.json` atomically; appends a `final_verification` event |
| `teamwork_worktree` | `2617-2867` | `setup` / `diff` / `merge` / `resolve` / `cleanup`, worktrees outside the repo |

### 1.4 Hooks — 2

`registerTeamworkHooks` (`tools.ts:2050-2091`):

- `permission.hook("evaluate")` (`:2058-2082`) — per-agent deny list for
  `team/verifier`, `team/falsifier`, `team/scout`, `team/security-auditor`
  (`:531-538`), plus a narrow `webfetch` deny for `team/worker` and
  `team/verifier` when `prompt_draft.md` matches `network: denied`
  (`:2067-2081`).
- `session.hook("context")` (`:2085-2090`) — injects a sanitised run summary
  (`describeRun`, `:807-836`) into the system prompt of any `team/*` agent.

If the permission API is absent the plugin refuses to load (`:2051-2055`), so
the deny list cannot be silently dropped. The deny list covers `edit`; three of
the four "read-only" agents still have `shell` (§1.8 #1).

### 1.5 Artifact layout

One root per run, `.opencode/teamwork/<session-id>/` (`RUN_ROOT`,
`tools.ts:475`; `runsDir`, `:587-589`; `docs/ARTIFACTS.md:11-30`), where the
session id is `YYYYMMDD-HHMMSS-<4 hex>` (`:32`) and is minted by
`teamwork_plan` (`tools.ts:542-547`, `:847-1012`). Files include
`prompt_draft.md`, `plan.dag.json`, `state.json`, `costs.json`,
`snapshots.json`, `events.jsonl`, `pitfalls.md`, `candidates/`, `critiques/`,
`synthesis/`, `verify/`, `final.md`, and optional `report.html` / `report.md`
(`ARTIFACTS.md:12-30`). `ORIGINAL_REQUEST.md` is present only when `teamwork_plan`
received a `request` (write-once; absent on legacy runs). `verify/final.json` is
written and stamped by `teamwork_final_verify`, but it is not listed in the
layout block (§1.8 #5). `preflight.json` is written only by `teamwork_preflight`.

Worktrees are created **outside** the repository (`tools.ts:1838-1841`,
`ARTIFACTS.md:34-36`), with per-task branches `teamwork/<session-id>-<taskId>`
(`tools.ts:1904`) and a sentinel base branch `teamwork/base-<session-id>`
(`:1842`).

"Active run" means *most recently modified run directory*: `resolveRun(root)`
with no id returns `listRuns(root)[0]` (`tools.ts:682-704`), and `listRuns`
sorts by mtime (`:651-680`). There is no active-run pointer, so two concurrent
runs are indistinguishable to a tool call that omits `sessionId`.

### 1.6 Code-enforced vs. prompt prose

**Enforced in code:**

- Session-id allowlist + lexical and realpath containment + symlink refusal
  (`tools.ts:615-634`, `:641-649`, `:682-704`).
- Task-id allowlist `TASK_ID` before any path, branch, or map key is built
  (`tools.ts:486-489`, `:894-899`, `:1830-1835`; `ARTIFACTS.md:235-240`).
- Topology enum and legacy-alias normalisation on write
  (`tools.ts:498-512`, `:886-892`, `:929-935`).
- Status set whitelist, legacy alias normalisation, an allowed-predecessor
  graph, PASS evidence for `verified_pass`, and automatic
  `verified_fail → blocked` when `round >= maxRounds`
  (`tools.ts:1536-1605`).
- Dependency gating, deadlock detection, `READY_FOR_SECURITY_AUDIT`,
  `BLOCKED_BY_SECURITY`, `READY_FOR_FINAL_VERIFICATION`,
  `BLOCKED_BY_FINAL_VERIFICATION`, `ALL_TASKS_PASSED`
  (`tools.ts:1278-1437`).
- Security gate: any Critical/High finding forces `FAIL`, as does any integrity
  finding forbidden at the run's recorded mode (`tools.ts:2396-2402`); `PASS`
  sets the phase to `MERGE` (`:2425-2426`). An unknown integrity rule id is
  refused before the audit is written (`:2360-2367`).
- Input pre-flight: `teamwork_plan` inventories the request and explicit inputs
  before `mkdir`; a blocking `MISSING`/`OUTAGE` refuses unless
  `allowMissingInputs` is passed (`tools.ts:1339-1372`). The decision is
  persisted as `plan.dag.json.preflight`, and `teamwork_preflight` re-runs the
  check for an existing run (`:1487-1555`).
- Completion gate: all tasks passed + security PASS + a stamped
  `verify/final.json` (`status: "PASS"` with `generatedBy.session`,
  `generatedAt` and `evidence`); `teamwork_final_verify` derives that status
  from the task reports and the audit, and `teamwork_next` refuses an unstamped
  PASS unless `allowUnstamped` is passed (`tools.ts:1661-1694`, `:2098-2243`).
- Spec gate: a non-empty `prompt_draft.md` is required before the run dir is
  created, unless the caller passes the recorded bypass
  (`tools.ts:901-920`).
- Cumulative feedback ledger: append-only per task, capped at 20 entries,
  resolved on `verified_pass`, surfaced to the next worker
  (`tools.ts:1337-1354`, `:1607-1628`; `ARTIFACTS.md:148-167`).
- Deny list for four agents, fail-closed on a missing permission API
  (`tools.ts:531-538`, `:2051-2064`).
- Cost/token accounting read from OpenCode's database, service API, or client,
  with delta tracking (`tools.ts:211-324`, `:1047-1200`;
  `ARTIFACTS.md:272-302`).
- Serialised read-modify-write within the process (`tools.ts:790-805`) and
  best-effort, fail-open `events.jsonl` (`:736-788`, `ARTIFACTS.md:371-380`).

**Prompt prose only (not enforced):**

- The sentinel does not edit code (`agents/team/sentinel.md:118-121`).
- Topology *selection* and its rationale (`sentinel.md:34-37`,
  `orchestrator.md:39-61`). The enum is validated, but nothing checks that the
  chosen shape fits the request; `routingReason` is optional and unread
  (`tools.ts:929-935`).
- Production and content of `verify/report-<task>.json` (`sentinel.md:73`,
  `:97-101`, `index.ts:53`). `verify/final.json` is now written by
  `teamwork_final_verify`, and `teamwork_next` checks its stamp
  (`tools.ts:1661-1694`); the tool's evidence is still the per-task reports and
  security audit produced under the coordinator, so independence depends on
  which verifier the sentinel dispatched.
- `interrupted.md` when the user stops a run (`orchestrator.md:106`;
  `ARTIFACTS.md:29`) — legacy agent only; no tool writes it.
- Worker `handoff.md` when stuck (`agents/team/worker.md:71-73`).
- "Halt non-essential workers" at 80% budget — `teamwork_cost` returns
  `shouldHalt` (`tools.ts:1194`) but nothing enforces a halt.
- Worktree/cwd confinement for writers (`docs/GUARDRAILS.md:27-31`).
- `constraints.network` / `constraints.sandbox` beyond the narrow `webfetch`
  slice above (`GUARDRAILS.md:32-33` vs `tools.ts:2067-2081`).

### 1.7 Support surface

- CLI with 10 subcommands plus `help` — `init`, `models`, `install`, `status`,
  `runs`, `inspect`, `timeline`, `export`, `prune`, `doctor`
  (`bin/opencode-teamwork.mjs:40-75`, `README.md:110-122`).
- Package at `0.5.9` (`package.json:3`); `npm test` chains prompt lint, cost,
  engine, doctor, timeline and export suites (`package.json:45-63`).
- CI at `0.5.9`: `.github/workflows/ci.yml` runs `npm test` on Node 22 and 24
  plus a packaging guard (no `docs/re/**`; required docs and plugin entry
  present); `publish.yml` runs the same suite and guard before publishing.
- The prompt linter enforces invariants in CI: one artifact root, one topology
  enum, no stale references, and the guardrail docs
  (`scripts/lint-prompts.mjs:2-9`, `:100-110`).

### 1.8 Inconsistencies observed while reading (stated, not fixed)

These bound what the local engine can honestly claim:

1. **"Read-only" covers the edit tool, not the filesystem.** `team/scout`,
   `team/verifier` and `team/security-auditor` deny `edit` in both frontmatter
   and code (`tools.ts:531-538`; `agents/team/scout.md:7-12`,
   `agents/team/verifier.md:7-15`, `agents/team/security-auditor.md:7-18`) but
   allow `shell`, which can write files. Only `team/falsifier` denies `shell`
   as well. The code-enforced guarantee is therefore "no in-place edits through
   the edit tool", not "cannot modify the workspace".
2. **The final-verification gate trusts a stamp, not an independent check.**
   `teamwork_next` now requires a report stamped by `teamwork_final_verify`
   (`generatedBy.session`, `generatedAt`, `evidence`) and refuses an unstamped
   PASS (`tools.ts:1661-1694`). But the tool derives its status from
   `verify/report-<task>.json` and `verify/security-audit.json`, both produced
   by agents the sentinel dispatches (`index.ts:53`). A fabricated task report
   followed by `teamwork_final_verify` still produces a stamped PASS: the stamp
   proves the verdict was computed from artifacts, not that the artifacts are
   true.
3. **Plugin tools are not agent-scoped** (`GUARDRAILS.md:34-36`): any agent in a
   run can call `teamwork_task_update` or `teamwork_security_audit`.
4. **`events.jsonl` attribution is best-effort, though order is now explicit.**
   Every new line carries a monotonic `seq` and, when an actor exists, an
   `agentSource` (`explicit | session | plan`) (`tools.ts:846-960`,
   `ARTIFACTS.md:371-395`). The `agent` itself is resolved from an explicit
   input, then the calling session, then the plan — and is never verified, so
   the field records how the actor was looked up, not proof of identity.
5. **Two completion rules disagree.** `teamwork_next` requires every task to be
   `verified_pass` before it looks at `verify/final.json`
   (`tools.ts:1359-1392`), while the export report returns `PASS` when
   `final.json` says PASS even if some tasks are not yet `verified_pass`
   (`ARTIFACTS.md:490-500`). A run can be "PASS" in an exported report and
   "not done" to the engine.
6. **The spec gate checks presence, not approval.** Any caller can pass
   `requireSpec: false` (recorded as `not_required`) or `skipInterview: true`
   (recorded as `bypassed`); the file's provenance is never checked
   (`tools.ts:901-920`).

## 2. Per-capability classification

Class counts over 22 capabilities: 2 `PRESENT-EQUIVALENT`, 4 `DIVERGENT`,
10 `WEAKER`, 6 `MISSING`.

### 2.1 Entry and routing

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 Slash-command entry | `/teamwork`, described "Preview the multi-agent teamwork workflow." (`00-artifact-identity.md:88-91`); dispatches the sentinel. Runtime now confirms the entry **spawns a separate `teamwork`-typed conversation** and links it as `conversation://<id>` (`07` §3.5, `11` §1.3-§1.4) | `/teamwork` switches the *current* session to `team/sentinel` and injects a multi-step operating template with `$ARGUMENTS` substituted (`index.ts:31-65`, `:215-230`). Six further commands expose the legacy loop's stages and the crafter (`index.ts:66-188`) | **PRESENT-EQUIVALENT** | Same entry shape: one command hands the request to a coordinator. The local command mutates the caller's session instead of opening a child conversation; that isolation difference is counted once, under A21, so it is not double-charged here | `plugins/opencode-teamwork/index.ts:30-230`; `00-artifact-identity.md:88-91`; `07` §3.5; `11` §1.3 |
| A2 Interview gate before routing | `teamwork_interviewer` runs before routing; the run starts only after the user approves a task prompt; `[skip-interview]` bypasses (`sentinel-routing.md:426-522`, `:690`; sentinel dispatch row `02-agent-registry.md:101`, prompt-level-actor note `:144`). `teamwork_interviewer` is a prompt-level dispatch target, not an `AllAgents` registry entry (`02:144`) | A **spec gate** now exists: `teamwork_plan` refuses when `<run>/prompt_draft.md` is missing or empty, before creating anything, and records the decision (`specGate: satisfied \| bypassed \| not_required`) (`tools.ts:901-920`). The bypass is explicit and recorded (`skipInterview`, `requireSpec:false`). The crafter wizard can produce the spec (`/teamwork-craft`, `index.ts:66-92`). Nothing verifies that the user approved it | **WEAKER** | The barrier is now enforced; the absent guarantee is **approval**, not existence. A non-empty file and a caller-chosen bypass both satisfy the tool, so the gate proves a spec was present, not that anyone signed off. Antigravity's gate is an interviewer turn the user answers | `tools.ts:901-920`; `docs/ARTIFACTS.md:186-196`; `agents/team/crafter.md:27-77`; `index.ts:66-92`; `sentinel-routing.md:426-522` |
| A3 Router: 6-route taxonomy, ordered procedure, anti-patterns, default General | Six named routes — Document Review, Formal Math / Lean 4 (LEMMA), Math / Proof (Large Team), Math / Proof, SWE Light, General — a five-step ordered procedure, a nine-item anti-pattern list ("do not deliberate endlessly", "do not split a request across paths", "do not route to SWE Light just because it sounds small", "do not re-route mid-execution"), and default General (`sentinel-routing.md:523-640`, `:642-672`) | A validated **topology** enum: six canonical values plus four legacy aliases, normalised on write and refused otherwise (`tools.ts:498-512`, `:886-892`); an optional `routingReason` is persisted (`:929-935`). The choice itself is prompt prose (`sentinel.md:34-37`); a signal→topology table with a default exists only in the **legacy** orchestrator (`orchestrator.md:39-61`). No tool branches on topology | **WEAKER** | The typo hole is closed: a bad label can no longer become a run's permanent name. Topology is still a DAG-shape label, not a request classifier — it selects nothing, has no anti-patterns and no default, and `routingReason` is unread and optional | `agents/team/sentinel.md:34-37`; `agents/team/orchestrator.md:39-61`; `docs/ARTIFACTS.md:38-51`; `tools.ts:498-512`, `:886-892`, `:929-935`; `sentinel-routing.md:523-672` |

### 2.2 Recording and continuity

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A4 Record the routed request once, before the chosen agent starts | The routed text is recorded once in `.agents/teamwork/ORIGINAL_REQUEST.md` before dispatch; later messages are appended; it is the baseline an auditor checks the work against (`sentinel-routing.md:263-288`, `:691`; on disk: `11` §3 row 1, with requirements R1…Rn and acceptance criteria) | `teamwork_plan` accepts an optional `request`, writes it **verbatim and once** to `<run>/ORIGINAL_REQUEST.md`, and refuses a second non-empty write (`tools.ts:549-590`, `:1096-1135`). The file is written before the plan files and is separate from the spec gate (`:1110-1139`). `prompt_draft.md` remains the drafted spec. The record is optional: omitting `request` creates no artifact, and later messages are still not appended | **WEAKER** | The verbatim baseline now exists and cannot be silently overwritten, so a reader can recover the original wording when the run supplies it. The remaining gap is coverage: nothing forces the sentinel to pass `request`, and there is no append log for later messages. The spec gate still governs the drafted spec, not this record | `tools.ts:549-590`, `:1096-1139`; `docs/ARTIFACTS.md:62-90`, `:247-253`; `agents/team/crafter.md:79-90`; `sentinel-routing.md:263-288`; `11` §3 |
| A5 `## Parameters` block for bracket-led requests | When a request began with a recognised bracket, the bracket is preserved verbatim in its own section with the line "How this run was launched; not part of the task." (`sentinel-routing.md:426-445`, `:691`) | No equivalent. The whole argument text is passed through `$ARGUMENTS` substitution (`index.ts:224-226`); there is no parameter grammar or recording convention. Neither sampled Antigravity run contains a `## Parameters` block (`11` §3 row 1, `UNKNOWN` whether because neither was bracket-launched) | **MISSING** | Launch modifiers are indistinguishable from task text. Low impact today because the plugin defines no launch modifiers, and it is the prerequisite for A2's skip token | `plugins/opencode-teamwork/index.ts:224-226`; `sentinel-routing.md:426-445`; `11` §3 |
| A6 `BRIEFING.md` mission/identity, re-read when out of context | Mission, identity, key constraints, active orchestrator, progress, victory-audit status, artifact index; re-read whenever it falls out of recent context (`sentinel-routing.md:105-179`, `:692`). On disk it is one brief per agent folder, 1.6–7.1 KB, with a locked append-only identity block (`11` §3 row 6) | No briefing file. The substitute is the `session.context` hook, which injects a sanitised summary — run id, phase, pass/fail counts, cost, state path — into every `team/*` agent's prompt (`tools.ts:807-836`, `:2085-2090`) | **WEAKER** | Continuity is automatic rather than a re-read convention, which is stronger for *state*, but carries none of mission, identity, decisions, or acceptance criteria. After compaction an agent knows the run exists, not what it is for. The observed Antigravity briefing is per-agent, so it also preserves identity uniqueness the local shared summary cannot | `tools.ts:807-836`, `:2085-2090`; `sentinel-routing.md:105-179`; `11` §3 |
| A7 `handoff.md` five-part protocol | Fixed structure: Observation, Logic Chain, Caveats, Conclusion, Verification Method; the sentinel rewrites its own handoff each cycle (`sentinel-routing.md:697`). On disk it is the largest artifact kind (4.8–36.5 KB), read by the parent and cited as the `Source` of every gate verdict (`11` §3 row 8, §5.2) | `handoff.md` appears once, as an instruction to a **stuck** worker: write what is left and stop (`worker.md:71-73`). No structure is mandated; no other agent writes one | **WEAKER** | A handoff artifact exists but not a protocol: reasoning, caveats, and verification instructions are not required, so a successor starts from a status note, and only after a worker declares itself stuck. The observed gate is built entirely out of these handoffs, which is why their absence local is a gate gap as well as a continuity gap | `agents/team/worker.md:71-73`; `sentinel-routing.md:697`; `11` §3, §5.2 |

### 2.3 Monitoring and completion

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A8 Progress monitoring with `Sentinel Monitoring` → `Cleanup` | Two crons: `*/8` progress reporting (reads `progress.md` / `BRIEFING.md`, scans the top recently modified workspace files) and `*/20` liveness (kill and re-spawn a dead orchestrator); cleanup cancels timers and subagents (`sentinel-routing.md:324-376`). Firing is still unobserved: the live run never produced an orchestrator turn (`07` §1.5, `11` §1.5) | No scheduler of any kind: no `setInterval` or cron in `plugins/`, `lib/`, or `bin/`; `setTimeout` appears only in the request-timeout helper (`tools.ts:346-352`). Progress is pull-only: `teamwork_status` reads `state.json` on request (`:1014-1028`) and `describeRun` re-injects state each turn (`:807-836`) | **MISSING** | No proactive reports and no liveness recovery: a stalled worker is noticed only when the sentinel's next turn runs or the user asks. The `verified_pass` counting defect in the first revision is fixed (`isPassStatus`, `tools.ts:496`, `:813`, `:1024`, `:1038`), so the tools no longer misreport a finished run | `tools.ts:346-352`, `:496`, `:1014-1028`, `:807-836`; `sentinel-routing.md:324-376`; `07` §1.5 |
| A9 Victory audit: a claim is never accepted at face value | Route-dependent verification (`sentinel-routing.md:673-683`). SWE runs its own blocking auditor (at most two) and must cite `VICTORY CONFIRMED`; Document Review spawns `teamwork_document_victory_auditor`; Math / Proof (Large Team) reports its pipeline's own verified result; LEMMA accepts a kernel-checked proof without a second auditor; every unlisted route spawns `teamwork_victory_auditor`. `VICTORY REJECTED` → forward the audit report and resume the team; the audit is given `ORIGINAL_REQUEST.md` as its baseline. The observed milestone gate is an explicit AND over six verdicts plus an independent test result (`11` §5.1-§5.2) | A real completion gate now exists: all tasks `verified_pass` → security audit PASS → a **stamped** `verify/final.json` (`status: "PASS"` with `generatedBy.session`, `generatedAt`, `evidence`). `teamwork_final_verify` computes the verdict from every `verify/report-<task>.json` and `verify/security-audit.json`, writes it atomically, and appends a `final_verification` event (`tools.ts:2098-2243`); `teamwork_next` returns `FINAL_VERIFICATION_UNVERIFIED` for an unstamped PASS unless `allowUnstamped` is passed (`:1661-1694`). The verifier that calls the tool is still dispatched by the sentinel (`index.ts:53`). No auditor measures fidelity to the request | **WEAKER** | The gate now asks "do the recorded task reports and the security audit support PASS", and a hand-written status can no longer complete a run. It still does not ask "is this what was asked": `ORIGINAL_REQUEST.md` is recorded (A4) but nothing compares the work to it, and the reports the tool reads are produced under the coordinator, so independence is procedural rather than structural. Antigravity's observed gate is redundant (2 reviewers + 2 challengers) and cites each agent's handoff; local is single-verifier | `tools.ts:1661-1694`, `:1984-2096`, `:2098-2243`; `agents/team/sentinel.md:87-101`; `index.ts:53`; `docs/ARTIFACTS.md:524-593`; `sentinel-routing.md:673-683`; `11` §5 |
| A10 Terminal-state discipline: pause vs. terminal non-victory vs. confirmed completion | Three explicit branches with what *not* to do: pause → no auditor, no cleanup, never report completion; terminal non-victory → no auditor, run cleanup, never report completion; confirmed → cleanup, report (`sentinel-routing.md:673-683`, `:359-375`). Runtime shows the rule is prose: when the orchestrator was quota-blocked, the sentinel **did the work inline** instead of relaying a non-victory (`07` §3.5.3, `11` §1.5) | Terminal *states* exist in code: `PRESENT_PARTIAL` when nothing is active and something is blocked (`tools.ts:1944`), `DEADLOCK` (`:1725`), `BLOCKED_BY_SECURITY` (`:1615`), `BLOCKED_BY_FINAL_VERIFICATION` (`:1654`), and `FINAL_VERIFICATION_UNVERIFIED` for an unstamped PASS (`:1671`). The sentinel is told to present the partial result (`sentinel.md:93-96`). No pause state (`PHASES`, `:616`), no cleanup rule, no prohibition on announcing completion | **WEAKER** | Partial outcomes are represented, which is the important half. There is still no defined behaviour for "the user answered a question mid-run", and nothing stops a completion claim after a DEADLOCK or with a missing final report. The Antigravity branch rules are also only prose — the observed inline fallback is the proof — so the comparison is between two prose disciplines plus local terminal states, not between a guarantee and a gap | `tools.ts:616`, `:1615`, `:1654`, `:1671`, `:1725`, `:1944`; `agents/team/sentinel.md:93-96`; `sentinel-routing.md:673-683`; `07` §3.5.3; `11` §1.5 |

### 2.4 Route-specific pipelines and the gate

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A11 Iterative coding / SWE Light: implementer + repeated reviewer rounds over a **cumulative open-issues ledger**; observed milestone gate is 1 worker + 2 reviewers + 2 challengers + 1 auditor | SWE Light: one `teamwork_implementer`, then repeated `teamwork_reviewer` rounds carrying a cumulative open-issues ledger; the gate is tests; the orchestrator writes no code (`02-agent-registry.md:102-104`; ledger rule `04-pipeline-topologies.md:522`). Separately, the observed milestone gate has six rows — worker, two reviewers, two challengers, auditor — each verdict citing a `handoff.md` in a **different** conversation directory, with `PASS = Auditor CLEAN + both Reviewers APPROVE + both Challengers CONFIRMED + independent test/audit result` (`11` §5.1-§5.2). Whether that composition is fixed is `UNKNOWN`; all three samples are one route family | Generic DAG loop with a now-real **cumulative ledger**: every non-empty feedback appends `{round, at, text, resolved}` to `state.tasks[id].feedbackLog` (cap 20, resolved on `verified_pass`), and `teamwork_next` injects every unresolved entry to the next worker (`tools.ts:1337-1354`, `:1607-1628`; `ARTIFACTS.md:148-167`). Redundancy is 1 worker + 1 verifier; there is no reviewer/challenger/auditor role. Tests-as-gate remains the verifier's rubric, not an engine check. "Sentinel does not edit code" is prose (`sentinel.md:118-121`) | **WEAKER** | Convergence is now at parity on the ledger: a round-2 worker sees every open issue, not just the last. What remains absent is the gate's redundancy and independence — one verifier's PASS closes a task, and no separate auditor re-derives the result. The 2+2+1 composition is observed, not proven universal | `tools.ts:1337-1354`, `:1607-1628`; `docs/ARTIFACTS.md:42`, `:148-167`; `agents/team/sentinel.md:118-121`; `02-agent-registry.md:102-104`; `04-pipeline-topologies.md:522`; `11` §5 |
| A12 Document Review: segment triage → `teamwork_group` per segment (RSA review tree) → cross-segment synthesis → `teamwork_synthesizer` | Multi-stage pipeline with per-segment group agents and a synthesis stage (`02-agent-registry.md:97-99`; `sentinel-routing.md:530-539`). The route was **not** exercised by any of the 39 sampled runs: no segment or synthesis artifacts appear in the state trees (`11` §3, §6.3) | `document-review` is a label only: "1 chair + 3 critics + 1 aggregator" (`ARTIFACTS.md:47`). No segment triage, no per-segment agent, no review tree, no segment handoff or candidate artifacts (`synthesis/` holds only `syn-<n>.md` and conflict JSON, `ARTIFACTS.md:22-23`, `:382-399`). No tool reads topology (`tools.ts:886-892`) | **MISSING** | A document review must be hand-composed by the sentinel in its prompt loop, with no segmentation discipline and no per-segment isolation. A long document is reviewed as one blob. Antigravity's side is also only statically known, so this row compares an unimplemented local pipeline with an unobserved reference | `docs/ARTIFACTS.md:22-23`, `:47`; `tools.ts:886-892`; `02-agent-registry.md:97-99`; `11` §3 |
| A13 LEMMA pipeline + capability gate | `teamwork_worker` / `planner` / `reviewer` / `verifier` / `formalizer` / `formalization_reviewer`; gated on user-installed `leap-tools` + Lean; **stops before work** when absent (`02-agent-registry.md:70-76`, `:224-235`; `sentinel-routing.md:572-573`) | One `team/proof-worker` whose diff is a Lean/Coq/Isabelle proof and whose verifier is the formal checker (`proof-worker.md:1-2`, `:29-46`); `proof` topology is "1 strategist + 3-5 searchers + 1 formal checker" (`ARTIFACTS.md:45`). No toolchain probe, no gate, no stop-before-work, and no planner/formalizer/formalization-reviewer split | **WEAKER** | A Lean request is attempted and fails at compile time instead of being refused before budget is spent. No separation between informal reasoning and formalization review, where Lean proofs usually break. The one registry entry whose allowlist omits all three write tools (`lemma_formalization_reviewer`, 10 tools) has no local counterpart (`02` §*Tool allowlist observations*) | `agents/team/proof-worker.md:1-2`, `:29-46`; `docs/ARTIFACTS.md:45`; `02-agent-registry.md:70-76` |
| A14 Theorem proving: 5-phase outer loop delegating tournament-tree levels to `teamwork_layer` | Phase loop plus a layer agent owning tournament-tree levels (`02-agent-registry.md:69`, `:86`; `sentinel-routing.md:536`) | `massive-proof` is a string in the topology list ("1 meta-coordinator + 100+ searchers (opt-in)", `ARTIFACTS.md:46`) plus a 24 h cap in the command template (`index.ts:56`). No layer agent, no tournament bracket, no phase object: `teamwork_next` runs the same generic task/round loop (`tools.ts:1261-1473`), and "100+" is prose | **MISSING** | The declared shape is not implemented: wide search is just many independent tasks whose results the root model must reconcile itself, with no elimination or per-level aggregation | `docs/ARTIFACTS.md:46`; `plugins/opencode-teamwork/index.ts:56`; `tools.ts:1261-1473`; `02-agent-registry.md:69`, `:86` |
| A15 Dependency pre-flight: BLOCKING audit naming every file, folder and URL | `teamwork_dependency` is dispatched before routes whose Route Summary marks a pre-flight audit required (Document Review, LEMMA); it must name every file, folder and URL the request names; verdicts READY / MISSING / OUTAGE are blocking, and the sentinel never installs anything (`sentinel-routing.md:61-72`, `:530-539`). It is a dispatch target, not a route; `teamwork_dependency` is a prompt-level actor and is not an `AllAgents` registry entry (`02-agent-registry.md:144`) | A deterministic pre-flight runs before `teamwork_plan` creates the run dir. A shared inventory extracts explicit `inputs` (all blocking), URLs, and tokens beginning `/`, `~/` or `file://` (blocking), plus relative path-like tokens (advisory, never blocking), deduplicated and capped at 100 (`tools.ts:641-746`). A blocking `MISSING`/`OUTAGE` refuses the plan and writes nothing unless `allowMissingInputs: true` is recorded; the outcome is persisted as `plan.dag.json.preflight` (`:1339-1372`). `teamwork_preflight` re-runs the inventory from `ORIGINAL_REQUEST.md` plus explicit inputs, writes `<run>/preflight.json` (`checkedAt`, `integrityMode`, `items`, `summary`) and appends a `preflight` event (`:1487-1555`). URLs are `UNCHECKED` by default; `checkUrls: true` issues one 3 s HEAD request per URL and maps reachability to `READY`/`OUTAGE` (`:694-711`) | **WEAKER** | The spend-before-discovery gap is closed for what the inventory can see: a missing blocking path or failed explicit URL now refuses the plan, and nothing is written. What remains: Antigravity dispatches an auditor agent that enumerates the request, checks URLs by default and is route-gated before Document Review and LEMMA; local is a deterministic token extractor with no agent judgement, URL checks are opt-in, and a relative path named in prose is advisory. Coverage is narrower even though the refusal is enforced | `tools.ts:641-746`, `:1339-1372`, `:1487-1555`; `docs/ARTIFACTS.md:286-321`, `:324-354`; `sentinel-routing.md:61-72`, `:530-539`; `02-agent-registry.md:144` |

### 2.5 Coordination, roster, gating

| Capability | Antigravity behaviour | Local behaviour | Class | Impact | Evidence |
| --- | --- | --- | --- | --- | --- |
| A16 Coordination surface: per-agent artifact folders + `send_message`; a shared swarm board exists but belongs to `/swarm` | `/teamwork` coordinates through parent/child dispatch and per-agent state folders — one `DISPATCH.md`, `BRIEFING.md`, `progress.md` and `handoff.md` per agent, in `teamwork_<role>_m<M>_r<R>[_<N>]/` (`11` §3-§4); `send_message` is in every registry item (`02` Appendix B, `09` §11.1). A separate feature, `/swarm`, has a shared board with source-established mechanics: one `seq` space per board, channels rebuilt from log control lines, `wake_mode ∈ mentions \| anything \| working`, and append-verified reads using head/tail anchors (`09` §3.3, §5, §6.2, §7.1). `09` §11 does **not** bind that board to `/teamwork`, but it records one `/teamwork-preview` invocation that created a swarm directory and no `.agents/teamwork/` tree; whether the command or the top-level agent chose that path is `UNKNOWN` (`09` §11.4) | Deliberately the opposite: **one file per artifact**, no shared mutable state — `candidates/cand-<n>.md`, `critiques/crit-<n>.md`, `synthesis/syn-<n>.md`, `verify/report-<task>.json`, plus an append-only `events.jsonl` (`ARTIFACTS.md:11-30`, `:371-380`). No per-agent state folder, board, inbox, or `teamwork_tmp` in `plugins/`, `lib/`, or `agents/` (searched). Concurrency needs are avoided by worktree isolation (`tools.ts:1838-1841`) | **DIVERGENT** | Trade-off, not a shortfall: no cross-writer ordering or contention, and every artifact is sanitised and path-contained (`GUARDRAILS.md:18-25`). The loss is per-agent state uniqueness and inter-agent messaging: the local run has one shared directory and a shared context injection, `events.jsonl.agent` is best-effort and unverified (`ARTIFACTS.md:389-395`), and each new line now carries `seq` and `agentSource` but there is no read cursor. The earlier framing of this row as "teamwork uses a shared board" was wrong: the board is `/swarm`'s. One `/teamwork-preview` invocation still took the native-swarm path and wrote a swarm directory instead of teamwork artifacts (`09` §11.4), so the runtime selection is `UNKNOWN` — but the coordination *vocabulary* the local design would have to match is not the board's | `docs/ARTIFACTS.md:11-30`, `:371-400`; `tools.ts:475`, `:587-589`, `:846-960`, `:981-1008`; `09` §3.3, §5, §7.1, §11.4; `11` §3-§4; `02` Appendix B |
| A17 Roster breadth — 49 `AllAgents` registry entries | 49 decoded registry entries: 39 core (sentinel, orchestrators, critics, workers, LEMMA, math/proof, audit, curation, pipeline, entry) plus 5 `@document_review`, 3 `@swe_light`, 1 `@colosseum` and 1 `@external` (`02-agent-registry.md:44-104`, correction at `:129-146`). The 49 collapse to **43 distinct runtime types**, because four items share `teamwork_worker`, three share `teamwork_reviewer` and two share `teamwork_explorer` (`02:143`). `swarm_*` names are source files, not registry entries; `teamwork_dependency` and `teamwork_interviewer` are prompt-level actors (`02:144`) | 11 agents, each installed as a file in the user's config dir (`lib/team.mjs:35-47`), with one worker/verifier pair parameterised by `spec.json` and `plan.dag.json` (`ARTIFACTS.md:55-77`, `tools.ts:920-928`) | **DIVERGENT** | 11 is a deliberate fit for a plugin that installs agents into the user's own config and makes them visible in the UI (`CHANGELOG.md:48-50`, `README.md:307-314`). The loss is role specialisation: no dependency auditor, document segment reviewer, formalization reviewer, or curator exists, which is why A12/A14/A15 are missing and A13 is weak rather than merely smaller. Counting 49 as "dispatchable types" would overstate it — the type count is 43 | `lib/team.mjs:35-47`; `docs/ARTIFACTS.md:55-77`; `tools.ts:920-928`; `CHANGELOG.md:48-50`; `README.md:307-314`; `02-agent-registry.md:44-104`, `:129-146` |
| A18 Gating: `TeamworkPreviewCommandDisabled`, `enable-teamwork-subagent`, `disable-teamwork-forced-flash-model`, `TeamworkDefaultsToFlash`, `teamworkDisabled` | Admin/feature flags around the subsystem (`06-config-gates-and-model-tiers.md:34-42`); enforcement path `UNKNOWN`. The flash policy now has a **runtime counterpart**: on HTTP 429 the client re-launched the orchestrator with `"Model":"flash"` in the dispatch call (`11` §1.3-§1.4, `07` §3.5). Whether that override is the sentinel's judgement, a client retry policy, or a default is `UNKNOWN`; the mechanism is exercised | No flags. All 7 commands register unconditionally (`index.ts:215-230`); models are per-agent frontmatter (`README.md:235-245`, `lib/team.mjs:35-47`), with no per-dispatch override. The installer exposes `--dry-run`, `--no-register`, and `--refresh` (`bin/opencode-teamwork.mjs:57-75`, `:100-110`); none of them disables the subsystem | **MISSING** | There is no way to disable `/teamwork` short of removing the plugin or its config entry, and no way to constrain or override a model for one dispatch. Whether an equivalent admin control exists in the V2 host is `UNKNOWN`; the runtime evidence confirms the Antigravity *model-override* mechanism but not the *gate* | `plugins/opencode-teamwork/index.ts:215-230`; `lib/team.mjs:35-47`; `bin/opencode-teamwork.mjs:57-75`; `11` §1.4; `07` §3.5; `06-config-gates-and-model-tiers.md:34-42` |
| A19 Integrity modes: `development \| demo \| benchmark`, authored into the prompt and read by the auditor | Three modes with different rule sets, chosen by a behavioural questionnaire and recorded in the prompt artifact (`Integrity mode: …`, `10` §2.1 at `112,230,526`/`112,235,817`). Enforcement is the auditor prompt's `### Integrity Enforcement Levels` (`112,966,504`), and the auditor is told to read the mode **from `ORIGINAL_REQUEST.md` directly**, not from the orchestrator (`112,968,482`). A floor rule raises `from scratch` to at least `demo`. No code path enforces any of it (`10` §2.1, §4) | Integrity mode is recorded as before: `teamwork_plan` accepts `integrityMode` (`development` default, `demo`, `benchmark`), refuses any other value before writing, and records it once in `ORIGINAL_REQUEST.md`; the security audit and final verification read it from that artifact, never from the caller (`tools.ts:537-595`, `:1279-1289`, `:2348`, `:2556`). The mode is now load-bearing: `teamwork_security_audit` accepts up to 50 `integrityFindings` (`{rule, where?, why?}`), refuses an unknown rule id before writing, and compares each rule against the run's mode (`:548-573`, `:2353-2377`). `fabricated_output` is forbidden from `development`; `core_logic_copied`, `delegated_core_work` and `test_source_read` from `demo`; `external_dependency_used` from `benchmark`. A forbidden finding becomes an `integrityViolation` and forces `status: "FAIL"` independently of Critical/High (`:2396-2402`); the FAIL propagates to `teamwork_final_verify`, and `teamwork_next` reports `BLOCKED_BY_SECURITY`. `verify/security-audit.json` persists `integrityMode`, `integrityFindings` and `integrityViolations` with each `forbiddenFrom` (`:2404-2419`) | **PRESENT-EQUIVALENT** | The two sides now share the shape: a mode recorded in the request artifact, read from that artifact by the auditor, with mode-specific prohibitions. Local is tighter on enforcement — a reported violation fails the audit in code, where Antigravity's levels live only in the auditor prompt — and narrower on authoring, since its rule set is the five-id table rather than prose that can be elaborated per mode. The limitation is shared: the auditor is still the judge and supplies the findings; the tool normalises and enforces a reported violation but cannot detect one, so no independent detection exists on either side | `tools.ts:537-595`, `:1279-1289`, `:2348`, `:2353-2419`, `:2556`; `docs/ARTIFACTS.md:76-90`, `:623`; `10` §2.1 at `112,230,526`, `112,966,504`, `112,968,482`; `11` §3 row 1 |
| A20 Successor handoff at a spawn-count threshold | A named `successor` orchestrator role writes state, spawns a replacement and exits; the `## Succession Status` template compares `Spawn count` against `succession_threshold` (`10` §2.3; threshold at `113,710,972`; role text at `114,727,128`). State transfer covers milestone state, active subagents, pending decisions, remaining work and key artifacts. The docs' "between milestones" cadence differs from the binary's trigger | No successor. The sentinel is one session for the run (`ctx.session.switchAgent`, `index.ts:223`); no tool spawns a replacement conversation, and no spawn count is tracked. Continuity is the shared `session.context` summary (`tools.ts:807-836`, `:2085-2090`), not a state-transfer document | **MISSING** | A long run relies on the host's context handling with no defined handoff, so a compacted sentinel keeps the run summary but not the decisions that led to it. The *trigger* is not portable (§4.6); the *artifact* is, and is the same protocol as A7 — which is why A7 is the cheaper half to close | `index.ts:223`; `tools.ts:807-836`, `:2085-2090`; `10` §2.3; `11` §3 row 8 |
| A21 Per-agent conversation isolation of state | Each dispatched agent runs in its **own conversation**; its `BRIEFING.md`, `progress.md`, `DISPATCH.md` and `handoff.md` live under that conversation's scratch root, and the observed gate's `Source` paths resolve into different `brain/<conversation-id>/` directories (`11` §2.1, §4, §5.2). The dispatch text forbids writing the state tree into the project (`11` §2.3) | One shared run root for every agent (`RUN_ROOT`, `tools.ts:475`; `runsDir`, `:587-589`), one shared context injection (`:807-836`, `:2085-2090`), and no per-agent scratch folder. Agents are separated by worktree (code) but not by state: every agent can read the run directory and the agents holding `edit` can modify any artifact in it, while `task_update`/`security_audit` are not agent-scoped (§1.8 #3) | **DIVERGENT** | Deliberate and mostly beneficial: one directory is inspectable, exportable and prunable as a unit, and there is no per-conversation tree to reconcile. The loss is isolation and identity — no per-agent state root means no place where a worker's notes are private to that worker, and attribution depends on a self-reported label rather than a directory that names the agent. It also means a single poisoned artifact is visible to every reader | `tools.ts:475`, `:587-589`, `:807-836`, `:2058-2064`; `docs/ARTIFACTS.md:11-30`, `:351-359`; `11` §2.1, §4, §5.2 |
| A22 Read-only agents: documented property vs. capability | Explorers are "read-only research agents … without modifying any source files" and the registry description says "Read-only exploration agent.", but the decoded 13-tool allowlist includes `write_to_file`, `replace_file_content` and `multi_replace_file_content` (`02-agent-registry.md:64`, Appendix B row 9; `10` §3.5). The sentinel has the same mismatch. Read-onlyness is prompt-enforced; the allowlist does not restrict it | Code-enforced for the edit tool: `READ_ONLY_ACTIONS` denies `edit` for `team/verifier`, `team/falsifier`, `team/scout` and `team/security-auditor`, fail-closed on a missing permission API (`tools.ts:621-627`, `:2500-2514`). But `shell` is allowed for scout, verifier and security-auditor (frontmatter, `agents/team/scout.md:7-12`, `verifier.md:7-15`, `security-auditor.md:7-18`), and shell can write. Only `falsifier` denies both. The documentation now states exactly that and a drift test asserts it (`README.md:70-78`; `scripts/test-engine.mjs:1630-1710`) | **DIVERGENT** | Local is strictly stronger than the reference on the `edit` capability, and the claim now matches the capability instead of overstating it. The residual gap is capability, not prose: `shell` can still write for three of the four agents. Antigravity's explorer shows the same failure one layer down, without the narrowed claim or the drift test | `tools.ts:621-627`, `:2500-2514`; `agents/team/scout.md:7-12`, `agents/team/verifier.md:7-15`, `agents/team/security-auditor.md:7-18`; `README.md:70-78`; `scripts/test-engine.mjs:1630-1710`; `02-agent-registry.md:64`, Appendix B row 9; `10` §3.5 |

### 2.6 Post-hoc findings (revision 2)

The first revision was written before the runtime and cross-check documents
landed, and before the engine changes that implemented its own §3. These nine
findings are what changed the table; each points at the document that
establishes it.

1. **The roster is 49**, not 60+/70+; the larger figures counted strings, not
   registry entries. `02-agent-registry.md:129-146`.
2. **Explorers are documented read-only but their decoded allowlist includes
   `write_to_file`, `replace_file_content` and `multi_replace_file_content`.**
   Read-onlyness is a prompt rule, not a capability restriction; the sentinel's
   allowlist has the same property. `02-agent-registry.md:64`, Appendix B row 9;
   `10` §3.5.
3. **The observed gate is 1 worker + 2 reviewers + 2 challengers + 1 auditor**,
   each verdict citing a `handoff.md`; in the two samples with absolute paths
   every `Source` resolves into a *different* `brain/<conversation-id>/`. The
   PASS rule is Auditor CLEAN + both Reviewers APPROVE + both Challengers
   CONFIRMED + an independent test/audit result. Whether the composition is
   universal is `UNKNOWN` (one route family, three files). `11` §5.1-§5.2,
   §8.
4. **The artifact root is per-conversation scratch**, not the workspace:
   `~/.gemini/antigravity-cli/brain/<conv>/scratch/.agents/teamwork/`, with nine
   observed artifact kinds and per-agent folders
   `teamwork_<role>_m<M>_r<R>[_<N>]` (`_r` is conditional; `_gen<N>` unobserved).
   No teamwork *state* document is written into the project by design; work
   products still are. `11` §2-§4, §6.3.
5. **Dispatch is real, and so is the fallback.** The slash command spawns a
   separate orchestrator conversation; on HTTP 429 the client re-launched it
   with `"Model":"flash"`; when that also failed, the sentinel completed the
   task inline. The cause of the override and the fallback is `UNKNOWN`.
   `07` §3.5; `11` §1.
6. **Integrity modes exist in the binary**: `development | demo | benchmark`,
   authored at `112,230,526` and enforced through the auditor prompt at
   `112,966,504`/`112,968,482`, which tells the auditor to read the mode from
   `ORIGINAL_REQUEST.md` directly. Enforcement is prompt-level; no code path was
   found. `10` §2.1.
7. **Successor handoff is triggered by a spawn count**, not a milestone
   boundary: `succession_threshold` at `113,710,972`, with a named `successor`
   role that writes state, spawns a replacement and exits. `10` §2.3.
8. **The coordination layer is source-established, but it belongs to
   `/swarm`**: one `seq` space per board, channels rebuilt from log controls,
   `wake_mode ∈ mentions | anything | working`, append-verified reads. A single
   `/teamwork-preview` invocation took the native-swarm path — a swarm directory
   and no `.agents/teamwork/` — and why is `UNKNOWN`. `09` §3.3, §5, §6.2,
   §7.1, §11.4.
9. **The local side moved too.** The engine now implements the first revision's
   §3.1-§3.6 (completion accounting, final-verification gate, transition graph
   plus evidence, spec gate, topology validation, cumulative ledger). §3.0
   records where each lives; the rows above were rewritten against that code.
   Revision 2's own §3.1-§3.3 shipped in `0.5.7`, the final-verification
   provenance, stamped gate and CI in `0.5.8`, and revision 3's §3.1-§3.2 in
   `0.5.9`; §3.0 records all three shipments.

## 3. Highest-value upgrades

Ranked by (user-visible quality gain) ÷ (implementation effort). After
`0.5.9`, no open item clears that bar. Revision 3's two items were the last ones
small enough to be worth their cost; they shipped in `0.5.9` and are recorded in
§3.0. The remaining classified gaps (A12, A13, A20) are named in §2 and are not
the next sprint: §4.6 and §4.8 state why. No replacement item is invented to
fill this section.

### 3.0 What earlier revisions proposed, and where it shipped

Revision 1's six items shipped in `0.5.7`; they are listed so a reader does not
treat them as open work, and so the list below is not padded with them.

| First-revision item | Now |
| --- | --- |
| 3.1 Fix completion counting | `isPassStatus` used by `status`, `resume` and `describeRun` (`tools.ts:516`, `:981-1008`, `:1240-1271`) |
| 3.2 Gate completion on evidence | stamped `verify/final.json` gate, with `READY_FOR_FINAL_VERIFICATION`, `BLOCKED_BY_FINAL_VERIFICATION` and `FINAL_VERIFICATION_UNVERIFIED` (`tools.ts:1641-1717`, `:2098-2243`) |
| 3.3 Make `verified_pass` unforgeable | transition graph (`:1843-1883`) and PASS-evidence refusal (`:1885-1898`) |
| 3.4 Gate dispatch on a spec | `requireSpec` / `skipInterview` before the run dir is created (`:1110-1139`) |
| 3.5 Validate topology and persist the reason | enum + aliases (`:520-531`) and `routingReason` (`:1029`, `:1144-1150`) |
| 3.6 Cumulative open-issue ledger | `feedbackLog` (`:1902-1935`) and unresolved-set injection (`:1572-1580`) |

Revision 2's three items also shipped:

| Revision-2 item | Shipped in | Now |
| --- | --- | --- |
| 3.1 Make "read-only" mean one thing | `0.5.7` | README, GUARDRAILS and the four agent descriptions state the edit-only guarantee and the shell caveat; `scripts/test-engine.mjs:1630-1710` asserts the deny sets and the docs |
| 3.2 Record the routed request once, with an integrity mode | `0.5.7` | write-once `ORIGINAL_REQUEST.md` and validated `integrityMode` in `teamwork_plan`; the security audit and final verification read the mode from that artifact (`tools.ts:535-590`, `:1070-1170`, `:2020-2024`, `:2185`) |
| 3.3 Give `events.jsonl` a sequence and actor provenance | `0.5.7` | every new line carries `seq` and, when an actor exists, `agentSource`; `timeline` displays both (`tools.ts:846-960`, `:981-1008`) |
| Final-verification provenance and stamped completion gate | `0.5.8` | `teamwork_final_verify` writes and stamps `verify/final.json` from the task reports and audit; `teamwork_next` refuses an unstamped PASS unless `allowUnstamped` is passed (`tools.ts:1661-1694`, `:2098-2243`) |

Revision 3's two items also shipped:

| Revision-3 item | Shipped in | Now |
| --- | --- | --- |
| 3.1 Enforce the integrity mode, not just record it | `0.5.9` | five-rule table with `forbiddenFrom` thresholds in `teamwork_security_audit`; a forbidden finding forces `FAIL`, which blocks merge and final verification (`tools.ts:548-573`, `:2353-2419`) |
| 3.2 Pre-flight the inputs the request names | `0.5.9` | `teamwork_plan` inventories the request plus explicit inputs before `mkdir` and refuses blocking misses unless `allowMissingInputs` is recorded; `teamwork_preflight` writes `<run>/preflight.json` (`tools.ts:641-746`, `:1339-1372`, `:1487-1555`) |

CI now protects these guarantees: `.github/workflows/ci.yml` runs `npm test` on
Node 22 and 24 and adds a packaging guard (no `docs/re/**`; required docs and
plugin entry present); `publish.yml` runs the same suite and guard before
publishing.

### 3.1 Enforce the integrity mode, not just record it (shipped in `0.5.9`)

**Shipped.** `teamwork_security_audit` accepts up to 50 `integrityFindings`,
refuses an unknown rule id before writing, records each violation with its
`forbiddenFrom` threshold, and forces `FAIL` on any finding forbidden at the
run's mode. The five ids and thresholds are in §2.5/A19. The FAIL propagates to
`teamwork_final_verify`, and `teamwork_next` reports `BLOCKED_BY_SECURITY`.

**What remains.** Detection. The auditor supplies the findings; the tool makes a
reported violation binding but cannot find one itself, and the rule table is
closed at five ids. That limit is shared with Antigravity.

### 3.2 Pre-flight the inputs the request names (shipped in `0.5.9`)

**Shipped.** `teamwork_plan` inventories explicit `inputs`, URLs and blocking
absolute/`~`/`file:` paths from the routed request before `mkdir`; a blocking
`MISSING`/`OUTAGE` refuses the plan unless `allowMissingInputs` is recorded, and
the result is persisted as `plan.dag.json.preflight`. `teamwork_preflight`
re-runs the check for an existing run and writes `<run>/preflight.json`.

**What remains.** Coverage and judgement. URL checks are opt-in
(`checkUrls: true`), a relative path named in prose is advisory, and the
inventory is a deterministic token extractor with no agent enumerating the
request. `teamwork_preflight` re-checks an existing run but reads the same
inventory; it does not widen it.

## 4. Do not port

### 4.1 Cron-based monitoring with project-file scanning

The plugin has no scheduler (§2.3), and its tools are request/response:
`ctx.tool.transform`, `ctx.permission.hook`, `ctx.session.hook`,
`ctx.command.transform` (`index.ts:213-230`, `tools.ts:838-845`, `:2058-2090`).
The Antigravity mechanism also depends on `progress.md` / `BRIEFING.md`
conventions and a scan of recently modified project files
(`sentinel-routing.md:324-376`) that has no local counterpart and would emit
guesses about work the plugin cannot observe. The crons' firing is unobserved
even on the Antigravity side (`11` §1.5). Improve `teamwork_status`, `timeline`,
and the export report instead — they report from recorded state, which the local
design can do honestly.

### 4.2 Cleanup that kills subagents

Antigravity's `Sentinel Monitoring` cleanup cancels timers and kills subagents
(`sentinel-routing.md:359-372`). The plugin uses no such API: the only
subagent-facing call is `ctx.session.switchAgent` (`index.ts:223`), and no kill
primitive appears in `plugins/`, `lib/`, or `bin/`. Whether the V2 host exposes
one is `UNKNOWN`. `GUARDRAILS.md:27-40` deliberately declines destructive powers
it cannot confine. `teamwork_worktree({ action: "cleanup" })`
(`tools.ts:2026-2042`), which prunes worktrees, already covers the reversible
half. The live run also shows why "kill" is not the only outcome: when the
dispatched agent was quota-blocked, the Antigravity sentinel completed the task
itself instead (`07` §3.5.3).

### 4.3 Shared swarm board, inbox, and `teamwork_tmp`

A mutable board with sequenced posts and an inbox is a second coordination plane
competing with the run directory, and it widens the injection surface:
`GUARDRAILS.md:37-39` already treats run artifacts as untrusted control data,
and every board post would be a new untrusted-input path into prompts. The
one-file-per-artifact layout (`ARTIFACTS.md:11-30`) plus sanitised injection in
`describeRun` (`tools.ts:807-836`) is the safer shape. The board is
`/swarm`'s (`09` §11); one `/teamwork-preview` invocation took that path
instead of the teamwork one, and the selection is `UNKNOWN` (`09` §11.4), so
porting the board would import a feature the reference keeps separate for every
other observed run. Port the *handoff* idea
(A7), not the board.

### 4.4 A 49-entry agent roster

Local agents are markdown files installed into
`~/.config/opencode/agents/team/` and deliberately visible in the UI
(`lib/team.mjs:35-47`, `CHANGELOG.md:48-50`, `README.md:307-314`). The Antigravity
roster's 49 `AllAgents` entries would flood the picker, multiply the per-agent model
assignment the installer performs (`lib/team.mjs:35-49`), and duplicate
capability the engine expresses through `spec.json` and DAG tasks. Add roles
only where a *contract* differs (a dependency auditor, a formalization reviewer),
never for breadth.

### 4.5 Per-conversation artifact roots

Antigravity writes teamwork state under
`~/.gemini/antigravity-cli/brain/<conv>/scratch/.agents/teamwork/` and forbids
creating it in the project (`11` §2.1-§2.3). This looks like a hardening
opportunity — state outside the user's repository — but it does not transfer:

- every local tool builds its paths from the workspace `root` (`runsDir`,
  `tools.ts:587-589`) and the containment and symlink checks are written against
  that root (`:615-649`);
- the CLI verbs `inspect`, `timeline`, `export`, `prune` and the single-root
  contract in `docs/ARTIFACTS.md:7-30` and `scripts/lint-prompts.mjs:100-110`
  assume the workspace path;
- the plugin API surface this repo uses (`ctx.tool.transform`,
  `ctx.permission.hook`, `ctx.session.hook`, `ctx.command.transform`) exposes no
  per-conversation data directory; whether V2 has one is `UNKNOWN`.

What is portable is the *sub-shape*, if isolation is wanted later: per-agent
subfolders under the existing run root, not relocation. The current design also
buys something Antigravity's does not — one directory a human can inspect and
delete.

### 4.6 Successor handoff at a spawn threshold

The mechanism is real (`10` §2.3) and the problem it solves — context
degradation in a long run — is real. It is not portable as shipped:

- there is no spawn primitive in the plugin; `ctx.session.switchAgent` switches
  the current session and no call anywhere in `plugins/`, `lib/` or `bin/`
  creates a replacement conversation;
- `succession_threshold` is compared against a spawn count the local engine does
  not track;
- the observed gate shows the *state transfer* first: a `handoff.md` with
  milestone state, active subagents, pending decisions, remaining work and key
  artifacts (`10` §2.3, `11` §3 row 8).

Port the handoff protocol (A7), which is a markdown contract and needs no host
support. Do not invent a successor role until the host exposes a way to start
one.

### 4.7 The six-agent gate as a fixed template

The observed 1+2+2+1 composition and its explicit AND rule are the strongest
gate evidence in the corpus (`11` §5). Copying the *template* would add three
roles the local roster deliberately lacks (§4.4), and the composition's
universality is `UNKNOWN` — all three samples are one route family
(`11` §5.1, §8). The portable part is the rule shape, and the local engine
already uses it: independent gates are explicit ANDs with named refusals
(`READY_FOR_SECURITY_AUDIT`, `READY_FOR_FINAL_VERIFICATION`,
`BLOCKED_BY_*`, `tools.ts:1359-1428`). If redundancy is added later, it should
be as a second verifier contract on the same task, not as a copied roster.

### 4.8 Remaining route-specific pipelines and formal-math tooling

Two candidates remain open after `0.5.9`, and neither should be ported as
shipped:

- **A12 Document Review** requires the engine to branch on topology and add
  segment triage, per-segment agent dispatch and a synthesis contract. That is a
  new pipeline, not an extension of the existing DAG loop, and the reference
  route was never exercised in the 39 sampled runs (`11` §3, §6.3), so its shape
  would be ported from prompt text alone.
- **A13 LEMMA / formal math** depends on a user-installed Lean/`leap-tools`
  toolchain. A presence probe would be a small start, but it only helps
  environments that intend to run Lean, and the rest of the route (planner,
  formalizer, formalization reviewer) is the six-role split §4.4 rules out
  adding for breadth. Presenting the probe alone as an upgrade would overstate
  it.

A20 successor handoff is host-blocked and is covered in §4.6.

## 5. What this comparison does not establish

- Whether the observed six-agent gate composition is fixed across routes:
  `UNKNOWN`; three samples, one route family (`11` §5.1, §8).
- What makes one `/teamwork-preview` invocation dispatch a `teamwork`
  conversation and another produce a native swarm: `UNKNOWN`; each is observed
  once (`09` §11.4).
- Whether Antigravity's explorers ever use their write tools at runtime:
  `UNKNOWN`; the allowlist permits it and the prompt forbids it, and no tool
  trace was captured (`10` §3.5, §4).
- Whether Antigravity's integrity modes are enforced by anything other than the
  auditor's prompt: `UNKNOWN`; the mode text exists on both the authoring and
  enforcement sides, and no code path was found (`10` §2.1, §4). The local
  counterpart now has a code-enforcement path (`tools.ts:2396-2402`), so this
  question is about the reference only.
- What runtime value `succession_threshold` takes, and whether succession fires
  in practice: `UNKNOWN`; only the literal and the template were recovered
  (`10` §2.3).
- Whether the local `session.context` injection reaches every subagent session
  on every OpenCode V2 build: `UNKNOWN` (it depends on host hook delivery; the
  code registers it at `tools.ts:2085-2090`).
- Whether `ctx.command.transform` failures are fail-open or fail-closed in the
  host: `UNKNOWN` (no local code handles a registration failure, `index.ts:215`).
- Antigravity's enforcement path for its five gating flags: `UNKNOWN` (`06-config-gates-and-model-tiers.md:34-42`);
  the flash *override* is observed, its decision path is not (`11` §1.4).
- Whether Antigravity's route agents beyond the sentinel can be reused across
  runs: `UNKNOWN`; the recovered sentinel text states a no-reuse-after-handoff
  rule (`sentinel-routing.md:289-297`).
- Whether the V2 host exposes a subagent-kill, scheduler, or per-conversation
  data directory: `UNKNOWN`; no such call appears in the local source
  (§4.1-§4.2, §4.5).
