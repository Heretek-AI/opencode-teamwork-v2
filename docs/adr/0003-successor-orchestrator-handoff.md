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

Per `contrib/HANDOFF_ANTIGRAVITY_ISSUES.md` §5–§6 (`#4 Successor orchestrator handoff — SPIKE, then ADR`):
- **Acceptance:** *"If buildable, a threshold triggers a correct successor. If not, an ADR names the missing host primitive and the outcome 'not possible on this host'."*
- **Prohibitions:** *"Do not fake a successor by clearing context in place; do not build a supervisor sidecar as a side effect. Spike/ADR first; 'not possible' is acceptable and expected."*

## 2. Host Capability & Empirical Spike Evidence

A timeboxed spike inspected the installed OpenCode V2 binary (`/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.3.2/bin/opencode`, `v2.3.2`) across the HTTP/RPC session endpoints (`@123,383,500–123,386,000`, `@169,870,000–169,875,000`), the plugin `ctx.session` wrapper (`@173,426,510–173,427,100`), and the inner `PluginHost` session service (`@177,414,200–177,415,600`, `@177,464,500–177,465,800`).

### 2.1 What OpenCode V2.3.2 `ctx.session` Exposes

Unlike the earlier static note in `08-gap-analysis-opencode-teamwork-v2.md` §4.6 (which observed only `ctx.session.switchAgent` in this repository's source), OpenCode `v2.3.2` exposes the following methods on `ctx.session` (`@173,426,510–173,427,050` and `@177,464,515–177,465,700`):

- `hook(type, fn, opts)` — supports `"context"`, `"compaction"`, `"generate"`, `"fork"`, `"experimental.idle"`
- `list`, `create`, `get`, `remove`
- `switchAgent`, `switchModel`
- `prompt`, `generate`, `command`, `compact`, `synthetic`
- `interrupt`, `update`, `move`, `wait`, `context`
- `instructions.entry.{list, put, remove}`

Specifically, `ctx.session.create` (`@177,464,530`) is implemented as:

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
2. **`ctx.session.create({})` (without `parentID`) detaches from the user's active TUI/CLI foreground session (`@177,464,610`):**
   Calling `ctx.session.create` without `parentID` creates an unlinked top-level session in the database (`parent_id = NULL`). However, OpenCode `v2.3.2` exposes **no TUI/CLI foreground session-handoff primitive** (`ctx.ui` / `ctx.session.attach` / `ctx.session.replaceActive`) to switch the user's attached terminal or TUI view from `S_1` to `S_2`. A background `ctx.session.prompt({ sessionID: S_2.id, ... })` executes detached from the user's active conversation stream, leaving the user staring at a halted `S_1` session.
3. **No session reparenting / child-ownership transfer (`@177,414,307`, `@177,464,850`):**
   `ctx.session.update({ sessionID, title?, metadata?, permissions? })` only calls `IH.rename`, `IH.setMetadata`, and `IH.setPermissions`. Neither `ctx.session.update` nor `ctx.session.move` can update `parentID` on in-flight child sessions or transfer pending `<subagent>` inbox deliveries from `S_1` to `S_2`.
4. **`ctx.session.compact` and `session.fork` do not provide fresh-session succession (`@123,385,044`, `@169,872,582`, `@173,426,750`):**
   - `ctx.session.compact({ sessionID })` summarises `S_1`'s message history in place within the same session ID. Faking a successor via in-place compaction or context clearing is explicitly prohibited by the issue contract (*"Do not fake a successor by clearing context in place"*).
   - `session.fork` (`/api/session/:sessionID/fork` at `@123,385,044` and `@169,872,582`) is not exposed on the plugin `ctx.session` wrapper (`@173,426,510`), and its contract (*"Create a child session by copying projected history before a message"*) copies historical messages into a child session rather than starting a clean-context replacement orchestrator.

### 2.3 Reproducible Verification Command

Run the following command to verify the exact `ctx.session` surface and schema contracts in OpenCode `v2.3.2` with zero network calls:

```sh
node -e '
const fs = require("fs");
const buf = fs.readFileSync("/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.3.2/bin/opencode");
for (const needle of [
  "After each completed round, the child sends a `<subagent>` report to the parent\x27s inbox and wakes the parent",
  "...HH?.parentID===void 0?{location:HH?.location??WH.make({directory:j.directory,workspaceID:j.workspaceID})}:{parentID:HH.parentID}",
  "if(HH.title!==void 0)yield*IH.rename({sessionID:HH.sessionID,title:HH.title})",
  "session.fork\",\"/api/session/:sessionID/fork\"",
  "switchAgent:r(k[\"session.switchAgent\"],e.session.switchAgent)"
]) {
  const offset = buf.indexOf(Buffer.from(needle));
  console.log(JSON.stringify({ needle, offset }));
}
'
```

Observed output on this host:

```json
{"needle":"After each completed round, the child sends a `<subagent>` report to the parent's inbox and wakes the parent","offset":123383940}
{"needle":"...HH?.parentID===void 0?{location:HH?.location??WH.make({directory:j.directory,workspaceID:j.workspaceID})}:{parentID:HH.parentID}","offset":177464602}
{"needle":"if(HH.title!==void 0)yield*IH.rename({sessionID:HH.sessionID,title:HH.title})","offset":177464891}
{"needle":"session.fork\",\"/api/session/:sessionID/fork\"","offset":169872568}
{"needle":"switchAgent:r(k[\"session.switchAgent\"],e.session.switchAgent)","offset":173426633}
```

## 3. Decision

**Automatic successor orchestrator handoff is classified as `BLOCKED` (`not possible on this host`) on OpenCode V2 (`v2.3.2`).**

1. **No fake in-place succession or supervisor sidecar:** In compliance with `contrib/HANDOFF_ANTIGRAVITY_ISSUES.md` §6 (`#4`), we do **not** fake a successor by wrapping `ctx.session.compact` in a tool that claims to spawn a replacement orchestrator, and we do **not** introduce a background supervisor sidecar or detach into a headless top-level session that orphans the user's active TUI/CLI view.
2. **Rely on disk-checkpointed run state and explicit `/teamwork <session-id>` resume:**
   `@heretek-ai/opencode-teamwork-v2` already persists all milestone and task progress deterministically in `.opencode/teamwork/<session-id>/state.json` (`phase`, per-task `status`, `round`, `branch`, `worktree`, `summary`, `feedbackLog`, `verification`), `plan.dag.json`, `costs.json` (with `snapshots.json.rootSessionIds` supporting multiple root sessions across restarts, `plugins/opencode-teamwork/tools.ts:1600-1645`), and `pitfalls.md`. When a long-running coordinator session approaches context limits or is interrupted:
   - Host compaction (`session.hook("compaction")` / `session.hook("context")`) automatically re-injects `describeRun(root)` (`tools.ts:807-836, 2906-2911`) so the compacted session retains the active run ID, phase, task counts, and `state.json` path.
   - A user can start a genuinely fresh OpenCode session at any time and run `/teamwork <session-id>` (calling `teamwork_resume` and `teamwork_next`), which skips all `verified_pass` tasks and resumes in-progress rounds from `state.json` with zero duplicated work (`docs/ARTIFACTS.md:232-233`, `snapshots.json.rootSessionIds`).

## 4. Alternatives Considered

### Alternative A (Chosen): Declare automatic successor handoff `not possible on this host` and use `state.json` + `/teamwork <session-id>` resume

- **Pros:**
  - Honest to OpenCode `v2.3.2`'s actual session architecture; avoids broken background sessions or parent back-wake loops.
  - Zero new runtime dependencies, zero sidecars, and zero risk of orphaning the user's active TUI/CLI session.
  - Existing `snapshots.json.rootSessionIds` (`tools.ts:1600-1645`) already aggregates cost across multiple root OpenCode sessions when a run is resumed via `/teamwork <session-id>`.
- **Cons:**
  - Starting a fresh top-level session requires the user to invoke `/teamwork <session-id>` in a new session rather than rotating invisibly mid-turn.

### Alternative B (Rejected): Spawn a child successor via `ctx.session.create({ parentID: currentSessionID })`

- **Why rejected:** Because `parentID` binds the new session as a child of the retiring session (`@123,383,940`), every completed round in the child emits a `<subagent>` report into the retiring parent's inbox and wakes the retiring parent session, causing duplicate orchestration turns and compounding token spend.

### Alternative C (Rejected): Spawn an unlinked top-level session via `ctx.session.create({})` and call `ctx.session.prompt`

- **Why rejected:** Runs headless in the background with no way to attach the user's active TUI/CLI viewport to the new `sessionID`, breaking interactive status visibility, permission prompts, and user cancellation.

### Alternative D (Rejected): Call `ctx.session.compact({ sessionID })` at a threshold and label it "successor handoff"

- **Why rejected:** Explicitly forbidden by `contrib/HANDOFF_ANTIGRAVITY_ISSUES.md` §6 (`#4`: *"Do not fake a successor by clearing context in place"*). In-place compaction is already handled natively by OpenCode V2 and assisted by `session.hook("context")`.

## 5. Consequences

### Positive
- Prevents silent background session leaks, parent back-wake loops, and TUI detachment on OpenCode V2.
- Preserves the existing `teamwork_resume` + `state.json` + `snapshots.json.rootSessionIds` manual-resume contract.

### Negative / Trade-offs
- Unattended multi-hour runs within a single OpenCode session rely on OpenCode's native context compaction plus `session.hook("context")` (`describeRun`) rather than automatic fresh-session rotation.

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
