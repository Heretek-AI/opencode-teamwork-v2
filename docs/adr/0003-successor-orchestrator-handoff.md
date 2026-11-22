# ADR 0003: Successor Orchestrator Handoff Is Not Possible on OpenCode V2 Without Host Session-Replacement Primitives

- **Status:** Accepted (`Not possible on this host`)
- **Date:** 2026-11-22
- **Issue:** [Heretek-AI/opencode-teamwork-v2#4](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/4) (`feat: Successor orchestrator handoff`)
- **Classification:** `SPIKE` → `BLOCKED` (`not possible on this host`)

## 1. Context

Issue [#4](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/4) tracks the deferred gap (`A20` in `docs/re/antigravity-teamwork/08-gap-analysis-opencode-teamwork-v2.md` §2.5 and §4.6) for automatic orchestrator self-succession at a subagent spawn-count threshold.

In Antigravity (`docs/re/antigravity-teamwork/10-official-docs-cross-check.md` §1 row 6 and §2.3):
- A top-level **Sentinel** conversation (`sentinel@external`, runtime type `teamwork`) manages a separate **Project Orchestrator** child conversation (`orchestrator_pure`, runtime type `teamwork_orchestrator`) via `invoke_subagent` (`@113,255,284`).
- The Project Orchestrator tracks cumulative subagent spawns against `succession_threshold` (`Spawn count: [0] / [succession_threshold]` at `@113,710,952` and `@113,710,972`; role `successor` at `@114,727,128`).
- When the threshold is reached, the orchestrator writes a structured `handoff.md` (*Milestone State / Active Subagents / Pending Decisions / Remaining Work / Key Artifacts* at `@114,728,898`), spawns a fresh replacement orchestrator conversation passing the Sentinel's conversation ID as parent, and exits (`@113,256,585`).

In `@heretek-ai/opencode-teamwork-v2` (`plugins/opencode-teamwork/index.ts:31-65, 215-230`):
- Invoking `/teamwork` does **not** spawn a child orchestrator conversation under a persistent parent Sentinel; instead, `ctx.command.transform` switches the user's current foreground session to `team/sentinel` via `ctx.session.switchAgent({ sessionID, agent: "team/sentinel" })` (`index.ts:223`) and runs the coordinator directly in that session.
- Run state is checkpointed deterministically on disk in `.opencode/teamwork/<session-id>/state.json` (plus `plan.dag.json`, `costs.json`, `pitfalls.md`, and `feedbackLog`), and `session.hook("context")` (`plugins/opencode-teamwork/tools.ts:2906-2911`) injects `describeRun(root)` into every `team/*` agent turn.

Per issue [#4](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/4) (`feat: Successor orchestrator handoff`), whose triage note is recorded in [#1](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/1#issuecomment-7074469705):
- **Acceptance:** *"If buildable, a threshold triggers a correct successor. If not, an ADR names the missing host primitive and the outcome 'not possible on this host'."*
- **Prohibitions:** *"Do not fake a successor by clearing context in place; do not build a supervisor sidecar as a side effect. Spike/ADR first; 'not possible' is acceptable and expected."*

## 2. Host Capability & Empirical Spike Evidence

A timeboxed spike inspected the `opencode` binary on `PATH` (`OPENCODE_BIN` overrides the lookup; `v2.3.2` on this host) across the HTTP/RPC session endpoints (`@123,383,500–123,386,000`, `@169,870,000–169,875,000`), the plugin `ctx.session` wrapper (`@173,426,510–173,427,100`), and the inner `PluginHost` session service (`@177,414,200–177,415,600`, `@177,464,500–177,465,800`).

### 2.1 What OpenCode V2.3.2 `ctx.session` Exposes

Unlike the earlier static note in `08-gap-analysis-opencode-teamwork-v2.md` §4.6 (which observed only `ctx.session.switchAgent` in this repository's source), OpenCode `v2.3.2` exposes the following methods on `ctx.session` (`@173,426,379–173,427,050` and `@177,464,434–177,465,700`):

- `hook(type, fn, opts)` — supports `"context"`, `"compaction"`, `"generate"`, `"fork"`, `"experimental.idle"`
- `list`, `create`, `get`, `remove`
- `switchAgent`, `switchModel`
- `prompt`, `generate`, `command`, `compact`, `synthetic`
- `interrupt`, `update`, `move`, `wait`, `context`
- `instructions.entry.{list, put, remove}`

`wait({ sessionID })` is an experimental idle/completion barrier (paired with `hook("experimental.idle")`), not a successor/handoff primitive: it cannot retire `S_1`, reparent `S_2`, or move the user's attached TUI/CLI stream.

Specifically, `ctx.session.create` (`@177,464,505`) is implemented as:

```js
create: (HH) => IH.create({
  id: HH?.id,
  title: HH?.title,
  agent: HH?.agent,
  model: HH?.model,
  metadata: HH?.metadata,
  permissions: HH?.permissions,
  ...HH?.parentID === void 0
    ? { location: HH?.location ?? WH.make({ directory: j.directory, workspaceID: j.workspaceID }) }
    : { parentID: HH.parentID }
})
```

### 2.2 Why Seamless Orchestrator Succession Fails on OpenCode V2.3.2

Testing the semantics of `ctx.session.create`, `ctx.session.update`, and `ctx.session.compact` reveals four missing host capabilities that prevent an active orchestrator session `S_1` from handing off to a fresh successor session `S_2`:

1. **`ctx.session.create({ parentID: S_1 })` creates a subordinate child that reports back to `S_1`, not a replacement (`@123,383,940`, `@169,870,555`):**
   OpenCode's `session.create` schema contract states verbatim:
   > *"Set parentID to create a subagent session at the parent's location; set agent to choose its agent (otherwise it uses the default) and start it with session.prompt. After each completed round, the child sends a `<subagent>` report to the parent's inbox and wakes the parent unless it has a staged revert."*
   If `S_1` spawns `S_2` with `parentID: S_1` and exits, `S_2` is a child subagent of `S_1`. As soon as `S_2` completes a round (or waits for a child of its own), OpenCode delivers a `<subagent>` report to `S_1`'s inbox and wakes `S_1`, resurrecting the degraded predecessor session instead of retiring it.
2. **`ctx.session.create({})` (without `parentID`) detaches from the user's active TUI/CLI foreground session (`@177,464,637`):**
   Calling `ctx.session.create` without `parentID` creates an unlinked top-level session in the database (`parent_id = NULL`). However, OpenCode `v2.3.2` exposes **no TUI/CLI foreground session-handoff primitive** (`ctx.ui` / `ctx.session.attach` / `ctx.session.replaceActive`) to switch the user's attached terminal or TUI view from `S_1` to `S_2`. A background `ctx.session.prompt({ sessionID: S_2.id, ... })` executes detached from the user's active conversation stream, leaving the user staring at a halted `S_1` session.
3. **No session reparenting / child-ownership transfer (`@177,414,307`, `@177,465,023`):**
   `ctx.session.update({ sessionID, title?, metadata?, permissions? })` only calls `IH.rename`, `IH.setMetadata`, and `IH.setPermissions`. Neither `ctx.session.update` nor `ctx.session.move` can update `parentID` on in-flight child sessions or transfer pending `<subagent>` inbox deliveries from `S_1` to `S_2`.
4. **`ctx.session.compact` and `session.fork` do not provide fresh-session succession (`@123,385,152`, `@169,872,567`, `@173,426,379`):**
   - `ctx.session.compact({ sessionID })` summarises `S_1`'s message history in place within the same session ID. Faking a successor via in-place compaction or context clearing is explicitly prohibited by the issue contract (*"Do not fake a successor by clearing context in place"*).
   - `session.fork` (`/api/session/:sessionID/fork` at `@169,872,567` and its description at `@123,385,152`) is not exposed on the plugin `ctx.session` wrapper (`@173,426,379`), and its contract (*"Create a child session by copying projected history before a message"*) copies historical messages into a child session rather than starting a clean-context replacement orchestrator.

### 2.3 Reproducible Verification Command

Run the following command to verify the exact `ctx.session` surface and schema contracts in OpenCode `v2.3.2` with zero network calls. It resolves the binary from `OPENCODE_BIN` or `PATH`, prints the resolved version, and prints an 80-character excerpt around each match (`-1` and `null` mean the string is absent):

```sh
node -e '
const fs = require("fs");
const { execSync } = require("child_process");
const bin = process.env.OPENCODE_BIN || execSync("command -v opencode", { encoding: "utf8" }).trim();
const buf = fs.readFileSync(bin);
console.log("version:", execSync(bin + " --version", { encoding: "utf8" }).trim());
for (const needle of [
  "After each completed round, the child sends a `<subagent>` report to the parent\x27s inbox and wakes the parent",
  "...HH?.parentID===void 0?{location:HH?.location??WH.make({directory:j.directory,workspaceID:j.workspaceID})}:{parentID:HH.parentID}",
  "if(yield*IH.get(HH.sessionID),HH.title!==void 0)yield*IH.rename({sessionID:HH.sessionID,title:HH.title})",
  "session.fork\",\"/api/session/:sessionID/fork\"",
  "switchAgent:r(k[\"session.switchAgent\"],e.session.switchAgent)",
  "session.handoff",
  "session.replaceActive"
]) {
  const offset = buf.indexOf(Buffer.from(needle));
  if (offset === -1) {
    console.log(JSON.stringify({ needle, offset, excerpt: null }));
    continue;
  }
  const excerpt = buf.slice(Math.max(0, offset - 80), offset + needle.length + 80)
    .toString("utf8")
    .replace(/[^\x20-\x7E]/g, "?");
  console.log(JSON.stringify({ needle, offset, excerpt }));
}
'
```

Observed output on this host (regenerated after correcting the stale offsets; the previous `IH.rename` needle no longer matched):

```json
version: opencode v2.3.2
{"needle":"After each completed round, the child sends a `<subagent>` report to the parent's inbox and wakes the parent","offset":123383940,"excerpt":"ose its agent (otherwise it uses the default) and start it with session.prompt. After each completed round, the child sends a `<subagent>` report to the parent's inbox and wakes the parent unless it has a staged revert.?????CE??Create session??o???E???Create a session"}
{"needle":"...HH?.parentID===void 0?{location:HH?.location??WH.make({directory:j.directory,workspaceID:j.workspaceID})}:{parentID:HH.parentID}","offset":177464637,"excerpt":"ent:HH?.agent,model:HH?.model,metadata:HH?.metadata,permissions:HH?.permissions,...HH?.parentID===void 0?{location:HH?.location??WH.make({directory:j.directory,workspaceID:j.workspaceID})}:{parentID:HH.parentID}}),get:(HH)=>IH.get(HH.sessionID),remove:(HH)=>IH.remove(HH.sessionID),switchAge"}
{"needle":"if(yield*IH.get(HH.sessionID),HH.title!==void 0)yield*IH.rename({sessionID:HH.sessionID,title:HH.title})","offset":177465023,"excerpt":"=>IH.command({...HH,command:HH.name}),compact:IH.compact,update:u(function*(HH){if(yield*IH.get(HH.sessionID),HH.title!==void 0)yield*IH.rename({sessionID:HH.sessionID,title:HH.title});if(HH.metadata!==void 0)yield*IH.setMetadata({sessionID:HH.sessionID,metadata:H"}
{"needle":"session.fork\",\"/api/session/:sessionID/fork\"","offset":169872567,"excerpt":"ete session\",description:\"Delete a session and its child sessions.\"}))).add(Yi(\"session.fork\",\"/api/session/:sessionID/fork\",{params:{sessionID:Go},payload:o({before:so.pipe(i)}),success:o({data:A}),error"}
{"needle":"switchAgent:r(k[\"session.switchAgent\"],e.session.switchAgent)","offset":173426633,"excerpt":"(k[\"session.get\"],e.session.get),remove:r(k[\"session.remove\"],e.session.remove),switchAgent:r(k[\"session.switchAgent\"],e.session.switchAgent),switchModel:r(k[\"session.switchModel\"],e.session.switchModel),prompt:r(k[\"sessi"}
{"needle":"session.handoff","offset":-1,"excerpt":null}
{"needle":"session.replaceActive","offset":-1,"excerpt":null}
```

The corrected `IH.rename` excerpt confirms that `ctx.session.update` only renames, sets metadata, and sets permissions — there is no `parentID` write. The absent `session.handoff` / `session.replaceActive` strings corroborate that the host surface has no foreground replacement primitive.

## 3. Decision

**Automatic successor orchestrator handoff is classified as `BLOCKED` (`not possible on this host`) on OpenCode V2 (`v2.3.2`).**

1. **No fake in-place succession or supervisor sidecar:** In compliance with the [issue #4 contract](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/4) (triage note: [#1 comment](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/1#issuecomment-7074469705)), we do **not** fake a successor by wrapping `ctx.session.compact` in a tool that claims to spawn a replacement orchestrator, and we do **not** introduce a background supervisor sidecar or detach into a headless top-level session that orphans the user's active TUI/CLI view.
2. **Rely on disk-checkpointed run state and an explicit resume path:**
   `@heretek-ai/opencode-teamwork-v2` already persists all milestone and task progress deterministically in `.opencode/teamwork/<session-id>/state.json` (`phase`, per-task `status`, `round`, `branch`, `worktree`, `summary`, `feedbackLog`, `verification`), `plan.dag.json`, `costs.json` (with `snapshots.json.rootSessionIds` supporting multiple root sessions across restarts, `plugins/opencode-teamwork/tools.ts:1428-1442, 1622-1631`), and `pitfalls.md`. When a long-running coordinator session approaches context limits or is interrupted:
   - Host compaction (`session.hook("compaction")` / `session.hook("context")`) automatically re-injects `describeRun(root)` (`tools.ts:1179-1208, 2906-2911`) so the compacted session retains the active run ID, phase, task counts, and `state.json` path.
   - Recovery uses `teamwork_resume({ sessionId })`, which returns the still-open tasks, followed by `teamwork_next({ sessionId })`, which re-derives dispatchable work and skips every `verified_pass` task (`docs/ARTIFACTS.md:223-224`, `snapshots.json.rootSessionIds`). **However, the current `/teamwork` command template always instructs Sentinel to call `teamwork_plan` (`plugins/opencode-teamwork/index.ts:42-43`), so `/teamwork <session-id>` today starts a new run instead of resuming the supplied run.** Until the template is changed (follow-up), recovery must be driven explicitly by calling `teamwork_resume({ sessionId })` and then `teamwork_next({ sessionId })` — never `teamwork_plan` — for the existing run ID. The exact command change is a resume branch at the top of the `/teamwork` template: when `$ARGUMENTS` names an existing `.opencode/teamwork/<id>/state.json` (with `plan.dag.json`), call `teamwork_resume`/`teamwork_next` for that ID and skip `teamwork_plan` plus worktree provisioning. This is a manual-recovery UX gap only; it does not make automatic succession possible.

## 4. Alternatives Considered

### Alternative A (Chosen): Declare automatic successor handoff `not possible on this host` and use `state.json` + explicit resume

- **Pros:**
  - Honest to OpenCode `v2.3.2`'s actual session architecture; avoids broken background sessions or parent back-wake loops.
  - Zero new runtime dependencies, zero sidecars, and zero risk of orphaning the user's active TUI/CLI session.
  - Existing `snapshots.json.rootSessionIds` (`tools.ts:1428-1442, 1622-1631`) already aggregates cost across multiple root OpenCode sessions when a run is resumed explicitly.
- **Cons:**
  - Starting a fresh top-level session requires the user to call `teamwork_resume`/`teamwork_next` in that new session (the `/teamwork` template does not yet select this path; see Known gaps) rather than rotating invisibly mid-turn.

### Alternative B (Rejected): Spawn a child successor via `ctx.session.create({ parentID: currentSessionID })`

- **Why rejected:** Because `parentID` binds the new session as a child of the retiring session (`@123,383,940`), every completed round in the child emits a `<subagent>` report into the retiring parent's inbox and wakes the retiring parent session, causing duplicate orchestration turns and compounding token spend.

### Alternative C (Rejected): Spawn an unlinked top-level session via `ctx.session.create({})` and call `ctx.session.prompt`

- **Why rejected:** Runs headless in the background with no way to attach the user's active TUI/CLI viewport to the new `sessionID`, breaking interactive status visibility, permission prompts, and user cancellation.

### Alternative D (Rejected): Call `ctx.session.compact({ sessionID })` at a threshold and label it "successor handoff"

- **Why rejected:** Explicitly forbidden by the [issue #4 contract](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/4) (triage note: [#1 comment](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/1#issuecomment-7074469705)): *"Do not fake a successor by clearing context in place"*. In-place compaction is already handled natively by OpenCode V2 and assisted by `session.hook("context")`.

## 5. Consequences

### Positive
- Prevents silent background session leaks, parent back-wake loops, and TUI detachment on OpenCode V2.
- Preserves the existing `teamwork_resume` + `state.json` + `snapshots.json.rootSessionIds` manual-resume tooling (see Known gaps for the command-template follow-up).

### Negative / Trade-offs
- Unattended multi-hour runs within a single OpenCode session rely on OpenCode's native context compaction plus `session.hook("context")` (`describeRun`) rather than automatic fresh-session rotation.

### Known gaps / follow-ups

These are real limitations of the manual-resume path. None of them change the decision: they concern recovery ergonomics and correctness *within* a session, not session replacement.

- **The `/teamwork` command template does not select the resume path.** As noted in §3 item 2, the template calls `teamwork_plan` unconditionally (`plugins/opencode-teamwork/index.ts:42-43`), so `/teamwork <session-id>` starts a new run. Follow-up: add the explicit resume branch described in §3 item 2 (or a separate `/teamwork-resume <session-id>` command).
- **Interrupted tasks are not re-queued.** `teamwork_next` classifies `worker_active` / `verifier_active` tasks as `inProgress` and never returns them as `readyForWorker` or `readyForVerifier` (`tools.ts:1878-1884`). After an interrupted worker or verifier, the task must be reset explicitly (for example with `teamwork_task_update` back to `pending` or `verified_fail`) before it can be dispatched again.
- **Concurrent resumes can dispatch duplicate workers.** `teamwork_next` reads `state.json` and returns ready tasks without a claim or lease (`tools.ts:1795-1900`), so two concurrent resumes can both observe the same task as dispatchable and both spawn a worker for it.
- **`describeRun(root)` selects the newest run, not the caller's session.** Runs resolved without an explicit `sessionId` take the first entry from `listRuns(root)` (`resolveRun`, `tools.ts:1005`). When multiple runs exist, callers must pass `sessionId` explicitly; the injected context summary may otherwise describe a different run.
- **Interrupted cost updates can double-count.** The cost tool writes `costs.json` and then `snapshots.json` under one lock but not one transaction (`tools.ts:1686-1687`, `1704-1705`). A crash or interrupt between the two writes leaves `snapshots.json` with stale `lastCost` values, so the next invocation re-adds the same session delta.

## 6. Exact Missing Host Capabilities (To Revisit Issue #4)

Issue [#4](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/4) remains blocked on the host until OpenCode V2 exposes **either**:

1. **Active-session replacement / foreground handoff API (`ctx.session.replace` or `ctx.session.handoff`):**
   A host primitive `ctx.session.handoff({ fromSessionID, agent, model, prompt, metadata })` that:
   - Atomically terminates or archives `fromSessionID` so it cannot be woken by future `<subagent>` inbox reports;
   - Creates a fresh session `toSessionID` with clean message history;
   - Rebinds the user's attached TUI/CLI client stream from `fromSessionID` to `toSessionID`; and
   - Reparents or links `fromSessionID` in `session_v2` so session-tree cost queries (`teamwork_cost`) and child subagents recognize `toSessionID`.
2. **Or non-waking parent delegation (`wakeParent: false` on `ctx.session.create`):**
   An option on `ctx.session.create({ parentID, wakeParent: false })` (paired with a persistent thin root Sentinel session that never accumulates worker tool output) allowing a child orchestrator session to spawn a sibling under the same root `parentID` and terminate itself without waking the retired sibling.
