# ADR 0001: Reject Shared Mutable Swarm Board in Favor of Parent-Mediated Subagent Sessions and One-File-Per-Artifact Run Storage

- **Status:** Accepted
- **Date:** 2026-11-22
- **Issue:** [Heretek-AI/opencode-teamwork-v2#5](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/5) (`feat: Shared swarm board and inbox`)
- **Classification:** `SPIKE` (ADR-first design gate)

## 1. Context

Issue [#5](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/5) tracks the deferred gap (`A16` in `docs/re/antigravity-teamwork/08-gap-analysis-opencode-teamwork-v2.md`) between Antigravity's native-swarm shared message board (`board.jsonl`, `members.json`, `swarm.json`, `plan.json` under `<appData>/brain/<conv>/.system_generated/swarm/`) and `@heretek-ai/opencode-teamwork-v2`'s single-root, one-file-per-artifact layout under `.opencode/teamwork/<session-id>/`.

In Antigravity's native `/swarm` subsystem (`docs/re/antigravity-teamwork/09-swarm-board-and-skills.md` §2–§7):
- Coordinator and worker conversations append free-form messages (`{seq, agent, text, time, kind?, request_id?, channel?, control?}`) to a shared `board.jsonl` with a single per-board `seq` space.
- Per-member read/park cursors (`last_read_seq`, `wait_since`, `wake_mode`) are persisted in `members.json`.
- Workers call `swarm_wait{since, mentions_only}` to end their turn and park at zero token/compute cost until woken by an `@name`, `@all`, or `@#channel` post.
- A read-only HTTP sidecar (`docs/re/antigravity-teamwork/assets/builtin/plugins/swarm/sidecars/swarm_board/main.mjs`) tails `board.jsonl` and per-member `transcript.jsonl` files for UI rendering.

**Evidence provenance.** Research files under `docs/re/` are repository-only: the npm package's `files` list includes `docs` but excludes `docs/re/**`, so these citations resolve only in a git checkout (or at `https://github.com/Heretek-AI/opencode-teamwork-v2/blob/main/<path>` on `main`), not in an installed package.

By contrast, `@heretek-ai/opencode-teamwork-v2` was architected around:
1. **One file per artifact, no shared append-only board or peer message bus (`docs/ARTIFACTS.md:9-38`):** Every run writes isolated artifacts under `.opencode/teamwork/<session-id>/` (`plan.dag.json`, `state.json`, `costs.json`, `candidates/cand-<n>.md`, `critiques/crit-<n>.md`, `synthesis/syn-<n>.md`, `verify/report-<task>.json`, `verify/security-audit.json`, `verify/final.json`) and isolates concurrent code edits in out-of-repo git worktrees (`../.teamwork-worktrees/<session-id>/`). The coordinator-owned `state.json` and `costs.json` are still shared mutable files, but they are written only through the coordinator path and serialised by an in-process `withFileLock` (see §2.3), not by a cross-process lock.
2. **Append-only telemetry, never read by the DAG engine (`docs/ARTIFACTS.md:466-584`):** `events.jsonl` records deterministic lifecycle transitions with a `seq` that is monotonic only within one plugin-host process (see §2.3) and `agentSource`, but is best-effort and fail-open; neither `teamwork_next` nor `teamwork_task_update` reads it.
3. **Prompt-injection guardrails (`docs/GUARDRAILS.md:6-41`):** Run artifacts are treated as untrusted control data. `describeRun` (`plugins/opencode-teamwork/tools.ts:1179-1208`) injects enumerated counters/statuses, the `state.json` path, and — on `main` — the last two pitfall lines truncated to 70 chars each with `clean()` (`tools.ts:1187-1189`, used at `1204`), so it is not purely whitelisted. Newline-stripping and truncation keep each pitfall on one physical line, but free-form pitfall text still reaches `session.hook("context")`; §5 records that residual risk.

Per the issue specification ([Heretek-AI/opencode-teamwork-v2#5](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/5)) and the public triage comment ([#1 comment](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/1#issuecomment-7074469705)), no board implementation may proceed before an ADR evaluates OpenCode's actual host messaging primitives, concurrency guarantees, and security boundaries and either **rejects** the shared board with evidence or **accepts** it with a migration plan and concurrency rules.

## 2. Host Capability & Empirical Spike Evidence

A timeboxed spike was executed against the installed OpenCode V2 host binary, resolved on `PATH` via `command -v opencode` (or `$OPENCODE_BIN` when set) and reported by `opencode --version` as `opencode v2.3.2`, and this repository's engine (`plugins/opencode-teamwork/tools.ts`, `lib/timeline.mjs`, `lib/export.mjs`).

### 2.1 OpenCode V2.3.2 Subagent & Session Messaging Primitives

Inspecting the embedded OpenCode `v2.3.2` plugin runtime (`PluginContextProvider` at byte offsets `173,423,500–173,427,600` and inner `PluginHost` at `177,463,000–177,466,500`) establishes:

1. **Built-in parent-child `<subagent>` inbox delivery (`@123,383,940` and `@169,870,555`):**
   OpenCode `v2.3.2` exposes `ctx.session.create({ id?, parentID?, title?, agent?, model?, location?, metadata?, permissions? })`. Its schema contract states verbatim:
   > *"Set parentID to create a subagent session at the parent's location; set agent to choose its agent (otherwise it uses the default) and start it with session.prompt. After each completed round, the child sends a `<subagent>` report to the parent's inbox and wakes the parent unless it has a staged revert."*
2. **Rich session control surface (`@173,426,510–173,427,100` and `@177,464,500–177,465,800`):**
   Plugin `ctx.session` exposes `list`, `create`, `get`, `remove`, `switchAgent`, `switchModel`, `prompt`, `generate`, `command`, `compact`, `synthetic`, `interrupt`, `update`, `move`, `wait`, `context`, `instructions.entry.{list,put,remove}`, and `hook("context" | "compaction" | "generate" | "fork" | "experimental.idle")`. The internal session service (`@177,414,307`) maintains per-session inbox operations (`inbox`, `cancelInbox`, `steerInbox`, `queueInbox`). `wait` is examined in point 5 below.
3. **Plugin KV storage is global, not a per-run board (`@173,424,254` and `@177,465,980`):**
   `ctx.storage` exposes `{ get, set, remove, scan }` wrapped by `Fd(L, e)`, which prefixes keys with:
   ```js
   let f = `plugin:${e.split("").map((r) => r.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`;
   ```
   It is a plugin-global key-value store with no append-only JSONL stream, no monotonic sequence allocator, and no file-descriptor lock.
4. **No `swarm_wait` turn-parking primitive on the host (`@0` matches for `swarm_wait` or `board.jsonl`):**
   Unlike Antigravity's Language Server, which terminates an agent turn on `swarm_wait` `DONE` and wakes the conversation only when a matching `@mention` is appended to `board.jsonl` (`09-swarm-board-and-skills.md` §6.1), OpenCode `v2.3.2` has no turn-parking board primitive. Emulating `board_wait` inside an OpenCode plugin tool would hold an active `tool.execute(input, context)` Promise open while polling the filesystem against `context.signal` (`AbortSignal`), consuming tool execution timeouts rather than parking the session between turns.
5. **`ctx.session.wait` is an idle barrier, not a `swarm_wait` substitute (`@123,386,885`, `@123,386,932`, `@123,386,992`):**
   The `wait` method on `ctx.session` is the experimental `experimental.session.wait` RPC (`POST /api/experimental/session/:sessionID/wait`), whose contract string is `"Wait for a session agent loop to become idle."` It is a parent-child idle/completion barrier: it waits for a session's agent loop to finish, cannot observe `board.jsonl`, cannot be woken by a later `@mention`, and has no board cursor or `mentions_only` filter. Awaiting it inside `tool.execute` still holds the tool Promise open while the call blocks, so it does **not** recover Antigravity's `swarm_wait` semantics (end the turn at zero token/compute cost, then wake only on a matching post).

### 2.2 Reproducible Verification Command

The host findings above can be reproduced hermetically without network calls:

```sh
node -e '
const fs = require("fs");
const { execSync, spawnSync } = require("child_process");
let bin;
try {
  bin = process.env.OPENCODE_BIN || execSync("command -v opencode", { encoding: "utf8" }).trim();
} catch {
  bin = "";
}
if (!bin) {
  console.error("opencode binary not found: set OPENCODE_BIN or put opencode on PATH");
  process.exit(1);
}
const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
console.log(JSON.stringify({ via: process.env.OPENCODE_BIN ? "OPENCODE_BIN" : "PATH", version }));
const buf = fs.readFileSync(bin);
for (const needle of [
  "After each completed round, the child sends a `<subagent>` report",
  "storage:{get:",
  "switchAgent:r(k[\"session.switchAgent\"]",
  "swarm_wait",
  "board.jsonl",
  "experimental/session/:sessionID/wait",
  "experimental.session.wait",
  "Wait for a session agent loop to become idle."
]) {
  const offset = buf.indexOf(Buffer.from(needle));
  if (offset === -1) {
    console.log(JSON.stringify({ needle, offset, excerpt: null }));
    continue;
  }
  const window = buf.subarray(Math.max(0, offset - 40), offset + needle.length + 40);
  const excerpt = window.toString("utf8").replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
  console.log(JSON.stringify({ needle, offset, excerpt }));
}
'
```

Observed output on this host (`opencode v2.3.2`, resolved from `PATH`; offsets are byte offsets into the host binary, `-1` means no match, and each excerpt is the 80 bytes around the match — 40 before and 40 after — sanitised to printable ASCII):

```json
{"via":"PATH","version":"opencode v2.3.2"}
{"needle":"After each completed round, the child sends a `<subagent>` report","offset":123383940,"excerpt":"ault) and start it with session.prompt. After each completed round, the child sends a `<subagent>` report to the parent's inbox and wakes the par"}
{"needle":"storage:{get:","offset":173424254,"excerpt":".skill),reload:()=>y(e.skill.reload())},storage:{get:(o)=>y(e.storage.get(o)),set:(o,s)=>y(e."}
{"needle":"switchAgent:r(k[\"session.switchAgent\"]","offset":173426633,"excerpt":"r(k[\"session.remove\"],e.session.remove),switchAgent:r(k[\"session.switchAgent\"],e.session.switchAgent),switchModel:r(k["}
{"needle":"swarm_wait","offset":-1,"excerpt":null}
{"needle":"board.jsonl","offset":-1,"excerpt":null}
{"needle":"experimental/session/:sessionID/wait","offset":123386885,"excerpt":"ng behind queued prompts. ) ;pJ /api/experimental/session/:sessionID/wait - - experimental.session.wait"}
{"needle":"experimental.session.wait","offset":123386932,"excerpt":"ental/session/:sessionID/wait - - experimental.session.wait Wait for session- 7 Wait"}
{"needle":"Wait for a session agent loop to become idle.","offset":123386992,"excerpt":".wait Wait for session- 7 Wait for a session agent loop to become idle. session.revert.stage$ /"}
```

### 2.3 Local Engine Concurrency & Security Constraints

Inspecting `plugins/opencode-teamwork/tools.ts`, `docs/ARTIFACTS.md`, and `docs/GUARDRAILS.md` surfaces four hard architectural mismatches with a shared mutable board:

1. **`withFileLock` is in-process only (`tools.ts:1162-1173`):**
   `fileLocks` is an in-memory `Map<string, Promise<unknown>>`. It serialises async tool calls within a single plugin host process, but provides zero cross-process mutual exclusion (`flock` / `O_CREAT | O_EXCL` lockfiles) if multiple CLI or subagent processes access the same run directory. For `events.jsonl`, this is acceptable because `appendEvent` (`tools.ts:1091-1155`) is fail-open telemetry that no engine decision reads; even so, `seq` is allocated by `nextEventSeq` (`tools.ts:1041-1079`) from the on-disk tail inside that process-local lock, so two host processes can append the same `seq` (or interleave a torn line). For a control-plane `board.jsonl` driving worker coordination and sequence cursors, those collisions would corrupt wake decisions rather than just telemetry.
2. **Plugin tools are not agent-scoped (`docs/GUARDRAILS.md:35-37`, `08-gap-analysis-opencode-teamwork-v2.md` §1.8 #3):**
   OpenCode's `ctx.permission.hook("evaluate")` mediates built-in capabilities (`edit`, `shell`, `webfetch`, `subagent`) enforced by `READ_ONLY_ACTIONS`, but it does **not** fire on plugin-registered `teamwork_*` tools. Furthermore, `agent` attribution in `events.jsonl` is caller-reported or heuristic (`agentSource: "explicit" | "session" | "plan"`, `docs/ARTIFACTS.md:552-561`). A shared `teamwork_board_post` tool would allow any read-only or untrusted-input-Exposed agent (`team/scout`, `team/falsifier`, `team/verifier`, `team/security-auditor`) to spoof another agent's handle or post control directives onto the board.
3. **Indirect prompt-injection amplification (`docs/GUARDRAILS.md:6-12, 38-40`, `08-gap-analysis` §4.3):**
   `clean()` (`tools.ts:840-844`) strips C0/C1 control characters and line separators (`\r`, `\n`, `\u0085`, `\u2028`, `\u2029`) and truncates to a caller-supplied cap, to prevent physical JSONL line-splitting, and `docs/ARTIFACTS.md:563-572` explicitly notes that `clean()` is *"a line-safety and display sanitiser, not a complete defence against hostile text."* A shared board where workers read free-form peer `text` mid-task creates a lateral prompt-injection bus from read-only/web-fetching agents directly into write-capable `team/worker` and `team/sentinel` sessions.
4. **Provenance separation (`09-swarm-board-and-skills.md` §11, `11-runtime-artifacts.md` §2–§6):**
   In Antigravity itself, `board.jsonl` belongs to `cortex/core/native_swarm/board` (`/swarm`), whereas all 39 sampled `/teamwork-preview` state trees on disk coordinate exclusively through parent-child subagent dispatch and isolated markdown artifacts (`DISPATCH.md`, `BRIEFING.md`, `progress.md`, `handoff.md`, `GATE_STATUS.md`) with no `board.jsonl`.

## 3. Decision

**We reject adding a shared swarm board (`board.jsonl`, `members.json`, `swarm.json`, `teamwork_board_*` tools, or a board sidecar) to `@heretek-ai/opencode-teamwork-v2`.**

Instead, `@heretek-ai/opencode-teamwork-v2` retains its single-plane coordination model:
1. **Parent-mediated subagent dispatch:** Co-ordination flows hub-and-spoke through the coordinator (`team/sentinel` or `team/orchestrator`) using OpenCode V2's native subagent session creation and `<subagent>` inbox reports, `state.json` task transitions (`teamwork_next` / `teamwork_task_update`), the cumulative per-task feedback ledger (`feedbackLog`), and `pitfalls.md`. `teamwork_next` is advisory and does not claim or lease a ready task (`tools.ts:1839-1905`, `2048-2075`), so this model assumes a single coordinator loop: two dispatchers polling concurrently can be handed the same ready task.
2. **One file per artifact (`docs/ARTIFACTS.md`):** Concurrent proposers, falsifiers, synthesizers, verifiers, and route-specific workers write to disjoint, path-validated files under `.opencode/teamwork/<session-id>/` and isolated out-of-repo git worktrees.
3. **Fail-open lifecycle event log (`events.jsonl`):** Chronological run observability for `opencode-teamwork timeline` and `opencode-teamwork export` continues to use `events.jsonl` (with `seq` monotonic within a plugin-host process and `agentSource`), which is never fed back into agent prompts or engine control flow.

## 4. Alternatives Considered

### Alternative A (Chosen): Reject `board.jsonl` and rely on OpenCode `<subagent>` inbox + one-file-per-artifact

- **Pros:**
  - No shared append-only board or peer message bus; every artifact has a single owning step and deterministic schema. The coordinator-owned `state.json` and `costs.json` are still shared mutable files, serialised only by the in-process `withFileLock`, so concurrent cross-process `teamwork_task_update` calls can lose updates (§5).
  - Preserves the `docs/GUARDRAILS.md` prompt-injection boundary for peer chat: `describeRun` never injects peer messages. It does inject the last two pitfall lines via `clean(p, 70)` (`tools.ts:1187-1189`), so stored free-form pitfall text remains an accepted residual risk (§5).
  - Zero new runtime dependencies, zero background polling loops, and full compatibility with `lib/timeline.mjs` and `lib/export.mjs`.
  - Matches both OpenCode V2's native `<subagent>` inbox architecture and Antigravity `/teamwork`'s actual artifact-tree coordination model (`08-gap-analysis` §4.3, `09` §11).
- **Cons:**
  - Concurrent sibling workers cannot chat directly peer-to-peer mid-turn; cross-worker synthesis must pass through a DAG dependency barrier (`dependencies` in `spec.json` / `plan.dag.json`) or a `team/synthesizer` round.

### Alternative B (Rejected): Implement a scoped, opt-in append-only `board.jsonl` under `.opencode/teamwork/<session-id>/`

If a shared board were ever accepted in a future cycle, it could not port Antigravity's `/swarm` board wholesale; it would require all six of the following engineering controls:
1. **Single-root containment:** Store only `.opencode/teamwork/<session-id>/board.jsonl` (no `members.json`, `swarm.json`, channels, or HTTP sidecar), guarded by `SESSION_ID` allowlist, segment-wise `lstatSync` symlink refusal, `realpathSync` containment, and `O_RDONLY | O_NOFOLLOW` bounded reads (`<= 8 MiB`).
2. **Cross-process file locking:** Replace or augment `withFileLock` (`tools.ts:1162-1173`) with an atomic filesystem lockfile (`openSync(lockPath, O_CREAT | O_EXCL | O_RDWR)`, PID + timestamp payload, bounded retry/backoff, and stale-lock eviction) so concurrent OS processes cannot interleave lines or duplicate `seq`.
3. **Malformed-line and torn-tail tolerance:** Readers (`since_seq` cursor queries, `lib/timeline.mjs`, `lib/export.mjs`) must ignore blank lines, permanently skip corrupt interior JSON lines without stalling, and withhold un-newlined trailing partial lines until completed (`09-swarm-board-and-skills.md` §7.3).
4. **Bounded wait with `AbortSignal`:** Because OpenCode V2 has no `swarm_wait` turn-parking primitive — and `ctx.session.wait` is only an idle barrier (§2.1 point 5) — any wait primitive must bound polling duration (e.g., `<= 30 s`) and abort cleanly on `context.signal` (`AbortSignal`) without throwing unhandled errors.
5. **Host-verified caller identity & read-only enforcement:** Because `permission.hook("evaluate")` does not mediate `teamwork_*` plugin tools (`docs/GUARDRAILS.md:35-37`), a board-write tool must never trust a caller-supplied `input.agent`; it must resolve `context.sessionID` via `ctx.session.get` and fail closed for roles in `READ_ONLY_ACTIONS`.
6. **Sanitisation & export defanging:** Apply `clean()` (single-line JSONL safety, default cap 64 chars) to ordinary fields, or `cleanBlock()` (the 2,000-char multi-line variant, which preserves `\n`) when a note must span lines, on write; and apply HTML-escaping plus `http(s)://` URL defanging (`https[://]`) in `lib/export.mjs`.

Alternative B is rejected because it adds substantial locking, identity-verification, and polling complexity while still opening an unauthenticated semantic prompt-injection channel between agents, and no route in `@heretek-ai/opencode-teamwork-v2` (including Document Review `#1`, LEMMA `#2`, or Massive-Proof Tournament `#3`) requires mid-turn peer-to-peer worker chat.

### Alternative C (Rejected): Port Antigravity's `/swarm` board and `swarm_board` sidecar wholesale

- Violates the public decision recorded in issue [#5](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/5) and the [triage comment on #1](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/1#issuecomment-7074469705), including the anti-pattern of porting the board, sidecar, or 49-agent roster wholesale; it introduces a long-running HTTP server outside OpenCode's plugin lifecycle, and duplicates `/swarm` infrastructure that Antigravity itself keeps separate from `/teamwork`.

## 5. Consequences

### Positive
- The artifact contract (`docs/ARTIFACTS.md`) and guardrail model (`docs/GUARDRAILS.md`) remain single-plane and deterministic; there is no shared append-only board, while coordinator-owned `state.json`/`costs.json` stay shared and process-locked only (see Known gaps below).
- Read-only agents (`team/scout`, `team/falsifier`, `team/verifier`, `team/security-auditor`) cannot influence active workers via a shared message bus.
- `opencode-teamwork timeline` and `opencode-teamwork export` remain fast, single-pass readers over `state.json`, `plan.dag.json`, `costs.json`, `verify/*`, and `events.jsonl`.

### Negative / Trade-offs
- All inter-agent coordination remains structured around DAG task boundaries, `spec.json` artifact dependencies, `feedbackLog`, and `pitfalls.md` rather than ad-hoc mid-task peer messaging.

### Known gaps / follow-ups

The decision keeps these residual risks inside the coordinator path rather than claiming they do not exist:

- **Duplicate dispatch of a ready task.** `teamwork_next` computes readiness from `state.json` and returns `readyForWorker` (`tools.ts:1839-1905`, `2048-2075`) without claiming or leasing it, so two coordinator loops polling concurrently can both be handed the same task.
- **Lost updates across processes.** `teamwork_task_update` is a read-modify-write of `state.json` inside `withFileLock` (`tools.ts:2131-2132`, lock at `1162-1173`). The lock is an in-memory `Map`, so concurrent updates from separate plugin-host processes can overwrite each other.
- **`events.jsonl` sequence collisions.** `seq` is allocated by `nextEventSeq` from the on-disk tail (`tools.ts:1041-1079`) inside the same process-local lock, so it is monotonic only within one plugin-host process; cross-process appends can duplicate a `seq` or interleave a torn line. The log stays telemetry-only and fail-open.
- **Pitfall text injection.** `describeRun` injects the last two pitfalls via `clean(p, 70)` (`tools.ts:1187-1189`, used at `1204`). Newlines and control characters are stripped and every entry is truncated, but the text is still free-form and read from the run directory, so a hostile `pitfalls.md` is a residual stored-injection vector.
- **Unmediated plugin tools.** `permission.hook("evaluate")` does not intercept `teamwork_*` tools (`docs/GUARDRAILS.md:35-37`); the session-id allowlist is the only containment for caller identity.

## 6. Missing Capabilities & Revisit Criteria

Do not revisit or implement a shared board unless **all three** conditions below are met:
1. **Concrete route demand:** A shipped route requires concurrent sibling workers to exchange mid-turn messages that cannot be expressed via parent `<subagent>` inbox reports (`ctx.session.create({ parentID })`) or DAG phase barriers.
2. **Host turn-parking & tool permission mediation:** OpenCode V2 exposes (a) a turn-parking wake primitive analogous to `swarm_wait` — not merely `ctx.session.wait`, which is an idle barrier (§2.1 point 5) — so waiting does not block an active `tool.execute` call, and (b) `permission.hook("evaluate")` mediation or authenticated caller-session identity on plugin-defined tools (`docs/GUARDRAILS.md:35-37`).
3. **Cross-process locking specification:** An explicit lockfile and semantic-sanitisation contract (Alternative B §1–§6 above) is ratified in a superseding ADR.
