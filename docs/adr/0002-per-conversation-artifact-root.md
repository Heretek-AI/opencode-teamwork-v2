# ADR 0002: Retain Single Workspace Run Artifact Root `.opencode/teamwork/<session-id>/` Pending Host Per-Conversation Filesystem Storage

- **Status:** Accepted
- **Date:** 2026-11-22
- **Issue:** [Heretek-AI/opencode-teamwork-v2#6](https://github.com/Heretek-AI/opencode-teamwork-v2#6) (`refactor: Per-conversation artifact root`)
- **Classification:** `SPIKE` (Spike + ADR before moving files)

## 1. Context

Issue [#6](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/6) tracks the deferred architectural difference (`A21` in `docs/re/antigravity-teamwork/08-gap-analysis-opencode-teamwork-v2.md` §2.5 and §4.5) between Antigravity's per-conversation scratch root and `@heretek-ai/opencode-teamwork-v2`'s workspace-rooted run directory.

In Antigravity (`docs/re/antigravity-teamwork/11-runtime-artifacts.md` §2.1–§2.3, §4, §5.2):
- Teamwork state files (`ORIGINAL_REQUEST.md`, `PROJECT.md`, `SCOPE.md`, `GATE_STATUS.md`, and per-agent `teamwork_<role>_m<M>_r<R>[_<N>]/{DISPATCH,BRIEFING,progress,handoff}.md`) are written under `<appDataDir>/brain/<conversation-id>/scratch/.agents/teamwork/`.
- Each dispatched subagent runs in its own conversation with its own `brain/<conversation-id>/scratch/` directory, and the dispatch instructions explicitly forbid creating `.agents/teamwork/` inside the user's project workspace.

In `@heretek-ai/opencode-teamwork-v2` (`docs/ARTIFACTS.md:7-44`, `docs/GUARDRAILS.md:18-25`):
- Every run writes under a single workspace-relative root: `<workspace>/.opencode/teamwork/<session-id>/` (while git worktrees live outside the repository under `$TEAMWORK_WORKTREES_DIR` or `../.teamwork-worktrees/<session-id>/`).
- Every engine tool (`plugins/opencode-teamwork/tools.ts`), every CLI reader (`lib/runs.mjs`, `lib/timeline.mjs`, `lib/export.mjs`), every agent prompt (`agents/team/*.md`), and the CI prompt linter (`scripts/lint-prompts.mjs`) enforce this single-root contract.

Per `contrib/HANDOFF_ANTIGRAVITY_ISSUES.md` §5–§6 (`#6 Per-conversation artifact root — SPIKE, then ADR`), a spike must verify whether OpenCode V2 actually exposes a per-conversation or per-agent filesystem data directory and evaluate the impact on path containment, `timeline`, `export`, and legacy runs before moving any files.

## 2. Host Capability & Empirical Spike Evidence

### 2.1 OpenCode V2.3.2 Storage, Location, and Tool Context Primitives

A timeboxed spike inspected the installed OpenCode V2 binary (`/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.3.2/bin/opencode`, `v2.3.2`) across the plugin context provider (`@173,419,500–173,428,500`) and inner plugin host (`@177,457,000–177,466,500`):

1. **`ctx.location` is workspace-scoped, not conversation-scoped (`@169,617,677`, `@173,420,415`, `@177,464,650`):**
   `ctx.location` exposes `{ directory, workspaceID }` representing the project workspace directory (`process.cwd()`). When `ctx.session.create` is called without `parentID`, it defaults to `WH.make({ directory: j.directory, workspaceID: j.workspaceID })` (`@177,464,630`). There is no per-session or per-conversation scratch path on `ctx.location`.
2. **`ctx.storage` is a plugin-global key-value store, not a filesystem directory (`@173,424,254` and `@177,465,980`):**
   `ctx.storage` exposes only four methods — `{ get, set, remove, scan }` — backed by `Fd(L, e)`:
   ```js
   function Fd(L, e) {
     let f = `plugin:${e.split("").map((r) => r.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`;
     return {
       get: (r) => L.get(f + r),
       set: (r, a) => L.set(f + r, a),
       remove: (r) => L.remove(f + r),
       scan: (r) => L.scan({ prefix: f + r.prefix, ... })
     };
   }
   ```
   All keys live in one global namespace per plugin ID (`plugin:006f00700065006e0063006f00640065...`). It provides no filesystem path, no per-conversation isolation, and cannot be inspected by standalone CLI binaries (`bin/opencode-teamwork.mjs runs | inspect | timeline | export`) that run outside the OpenCode plugin host process.
3. **`ctx.experimental.artifact` is a provider registration API, not a scratch directory (`@173,421,280`):**
   `ctx.experimental.artifact` exposes `{ reload, transform }` where `transform` allows a plugin to register an artifact provider (`add({ id, name, capabilities, prompt, create, read, update, delete })`). It does not supply a host-managed per-conversation directory to tools.
4. **`tool.execute(input, context)` receives `context.sessionID`, not a scratch path (`@173,427,250`):**
   The tool execution wrapper `Q(a, e, p)` invokes `a.execute(e, { ...R, get signal() { ... }, progress: (b) => ... })` where `R` carries `{ sessionID }` (used in `tools.ts:1421, 1607, 2126, 2501`). The host passes a string session identifier (e.g. `ses_...`), never a per-session directory on disk.

### 2.2 Reproducible Verification Command

Run the following command to verify the exact host primitives in OpenCode `v2.3.2` with zero network calls:

```sh
node -e '
const fs = require("fs");
const buf = fs.readFileSync("/home/linuxbrew/.linuxbrew/Cellar/opencode-v2/2.3.2/bin/opencode");
for (const needle of [
  "_={app:e.app,location:e.location,options:e.options",
  "storage:{get:(o)=>y(e.storage.get(o))",
  "function Fd(L,e){let f=`plugin:${",
  "artifact:{reload:()=>y(e.experimental.artifact.reload())",
  "return Promise.resolve(a.execute(e,{...R,get signal()"
]) {
  const offset = buf.indexOf(Buffer.from(needle));
  console.log(JSON.stringify({ needle, offset }));
}
'
```

Observed output on this host:

```json
{"needle":"_={app:e.app,location:e.location,options:e.options","offset":173420403}
{"needle":"storage:{get:(o)=>y(e.storage.get(o))","offset":173424254}
{"needle":"function Fd(L,e){let f=`plugin:${","offset":177465981}
{"needle":"artifact:{reload:()=>y(e.experimental.artifact.reload())","offset":173421279}
{"needle":"return Promise.resolve(a.execute(e,{...R,get signal()","offset":173427423}
```

### 2.3 Local Single-Root Containment & CLI Reader Invariants

Inspecting the repository confirms five tightly coupled invariants anchored on `<workspace>/.opencode/teamwork/<session-id>/`:

1. **Path containment and symlink refusal (`plugins/opencode-teamwork/tools.ts:495-507, 917-1007`):**
   - `RUN_ROOT = ".opencode/teamwork"` (`:495`), `SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/` (`:498`), `TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (`:506`).
   - `runsBase(root)` (`:917-936`) calls `lstatSync` on `<root>/.opencode` and `<root>/.opencode/teamwork` to refuse symlinks and verifies `realpathSync(base)` stays within `realpathSync(root)`.
   - `resolveRun(root, sessionId)` (`:984-1007`) validates `SESSION_ID`, checks `lstatSync(cand).isSymbolicLink()`, and enforces `containmentError(base, cand)`.
2. **Standalone CLI inspection (`lib/runs.mjs:21`, `lib/timeline.mjs:89-125`, `lib/export.mjs:138-223`):**
   - `opencode-teamwork runs`, `inspect`, `timeline`, and `export` run as standalone Node CLI processes from the project root (`process.cwd()`), with no connection to the OpenCode plugin runtime.
   - `lib/timeline.mjs` and `lib/export.mjs` verify `runRootIsLink(projectRoot)` (`.opencode` and `.opencode/teamwork` symlink checks), read `<projectRoot>/.opencode/teamwork/<session-id>/` with `O_RDONLY | O_NOFOLLOW` and byte caps (`8 MiB` for `events.jsonl`, `64 MiB` for JSON), and validate `verify/report-<taskId>.json` containment inside the single `runDir`.
3. **CI prompt linter (`scripts/lint-prompts.mjs:5, 83, 100-110`):**
   - Asserts that `.opencode/teamwork/<session-id>/` is the sole artifact root referenced across `docs/ARTIFACTS.md`, `agents/team/*.md`, and `plugins/opencode-teamwork/index.ts`.

## 3. Decision

**We retain `<workspace>/.opencode/teamwork/<session-id>/` as the single canonical artifact root and defer relocating artifacts to per-conversation roots.**

Specifically:
1. **No relocation to non-existent host per-conversation storage:** Because OpenCode `v2.3.2` exposes no host-provided per-conversation filesystem directory (`ctx.location` is workspace-level and `ctx.storage` is a global KV store inaccessible to standalone CLI tools), moving run state out of `<workspace>/.opencode/teamwork/<session-id>/` cannot use a native host primitive.
2. **Preserve single-root `resolveRun`, `timeline`, and `export` guarantees:** Keeping all artifacts for `<session-id>` under one contained directory guarantees that `SESSION_ID`/`TASK_ID` allowlists, `lstatSync` symlink refusal, `realpathSync` containment, and standalone `opencode-teamwork runs | inspect | timeline | export` work deterministically without multi-directory discovery or clock-skew unioning.
3. **Adopt per-agent / per-subflow subdirectories inside `.opencode/teamwork/<session-id>/` when isolation is needed:** As noted in `08-gap-analysis-opencode-teamwork-v2.md` §4.5, when route-specific or per-agent artifact isolation is needed, it belongs in subdirectories *under* `.opencode/teamwork/<session-id>/` (such as `candidates/`, `critiques/`, `synthesis/`, `verify/`) rather than separate root directories.

## 4. Alternatives Considered

### Alternative A (Chosen): Keep single run root `<workspace>/.opencode/teamwork/<session-id>/` (with internal subdirectories)

- **Pros:**
  - Works with every existing CLI command (`runs`, `inspect`, `timeline`, `export`, `prune`) and CI prompt lint check (`scripts/lint-prompts.mjs`) with zero configuration.
  - Preserves a single `realpathSync` containment anchor (`runsBase(root)`), preventing cross-directory symlink traversal.
  - Self-contained: a user can inspect, archive, or delete one run by operating on one directory.
- **Cons:**
  - Leave `.opencode/teamwork/<session-id>/` inside the workspace directory unless the user configures `.gitignore` (unlike worktrees, which already live outside the repository under `../.teamwork-worktrees/<session-id>/`).
  - Concurrent subagents share the run directory and rely on disjoint per-task/per-candidate filenames (`verify/report-<taskId>.json`, `candidates/cand-<n>.md`) rather than host-enforced per-conversation directory sandboxes.

### Alternative B (Deferred): Explicit `scratchRoot` / `$TEAMWORK_ARTIFACTS_DIR` outside the workspace

- Mirrors `$TEAMWORK_WORKTREES_DIR` (`tools.ts:2617`) by relocating the entire `.opencode/teamwork/<session-id>/` tree to a user-configured external directory while keeping one directory per `<session-id>`.
- **Why deferred:** Unlike per-conversation roots, a single external `scratchRoot` still puts all agents of a run in one directory (so it does not provide per-agent write isolation), and it breaks parameterless `npx @heretek-ai/opencode-teamwork-v2 timeline | export` unless the same environment variable or config is present in every user shell.

### Alternative C (Rejected): Split a single run across multiple per-`context.sessionID` root directories and union them in `timeline` / `export`

- Would store artifacts under `<root>/<runId>/<context.sessionID>/...` or `<scratchRoot>/<context.sessionID>/...` and require `lib/timeline.mjs` and `lib/export.mjs` to discover and union multiple roots into one run report.
- **Why rejected:**
  1. Standalone CLI calls (`opencode-teamwork timeline <runId>`) have no access to OpenCode's in-memory session tree when `opencode.db` is absent or located in a custom XDG data path, making child-root discovery unreliable without a parent manifest inside the primary run root anyway.
  2. Unioning `state.json`, `costs.json`, `events.jsonl` (`seq`), and `verify/final.json` across multiple directories reintroduces split-brain state and cross-root ordering ambiguity.

## 5. Consequences

### Positive
- Zero regression risk to `resolveRun` containment, `O_NOFOLLOW` bounded readers in `lib/timeline.mjs` and `lib/export.mjs`, `scripts/lint-prompts.mjs`, and legacy single-root runs.
- Maintains a clear separation between out-of-repo git worktrees (`../.teamwork-worktrees/<session-id>/`) and single-rooted run metadata (`.opencode/teamwork/<session-id>/`).

### Negative / Trade-offs
- Agents holding `edit` or `shell` permissions are not confined by the host to a private per-agent scratch directory (`docs/GUARDRAILS.md:27-33, 38-40`).

## 6. Missing Capabilities & Migration Plan (If Revisited)

### 6.1 Exact Missing Host Capabilities in OpenCode V2 (`v2.3.2`)
1. **Per-session filesystem scratch path:** OpenCode's `PluginContextProvider` (`@173,420,403`) and tool `execute` context (`Q` at `@173,427,423`) expose `ctx.location.directory` (workspace) and `context.sessionID` (string ID), but no host-managed per-session scratch directory (`context.scratchDir` or `ctx.session.scratchPath({ sessionID })`) outside the git working tree.
2. **Per-agent filesystem sandbox enforcement:** OpenCode's `permission.hook("evaluate")` (`@173,423,600`) can deny `edit` or `shell`, but does not enforce per-agent path confinement for `shell` commands (`docs/GUARDRAILS.md:27-32, 41`).

### 6.2 Migration Plan If Per-Conversation Roots or `scratchRoot` Are Revisited

If OpenCode V2 adds a per-session scratch directory or if maintainers opt into an explicit `scratchRoot` setting:
1. **Primary Run Anchor & Legacy Tolerance:**
   - Keep `<workspace>/.opencode/teamwork/<session-id>/` as the fallback and legacy layout so existing runs continue to resolve without migration.
   - If an external `scratchRoot` is configured (via `OPENCODE_TEAMWORK_SCRATCH_DIR` or `~/.config/opencode/teamwork.json`), validate that `scratchRoot` is an absolute path, is not a symlink (`lstatSync`), and does not alias `/` or the git `.git` directory; resolve runs by checking the configured `scratchRoot` first and falling back to `<workspace>/.opencode/teamwork/<session-id>/`.
2. **Per-Agent Sub-Roots Under One Run Index:**
   - Never scatter root-level files (`ORIGINAL_REQUEST.md`, `plan.dag.json`, `state.json`, `costs.json`, `events.jsonl`, `verify/final.json`) across sibling conversation folders.
   - Instead, isolate per-agent outputs under `<runRoot>/<session-id>/agents/<subSessionId>/` (validated against `SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/` and `ensureSafeRunSubpath` segment-wise `lstatSync` + `realpathSync`).
3. **Reader Union Contract (`lib/runs.mjs`, `lib/timeline.mjs`, `lib/export.mjs`):**
   - `buildTimeline` and `buildExportData` continue to read `plan.dag.json`, `state.json`, `costs.json`, `events.jsonl`, and `verify/final.json` from the canonical `<runDir>` anchor, and union per-agent artifacts from `<runDir>/agents/<subSessionId>/` in deterministic `(seq, timestamp, subSessionId)` order while enforcing `O_RDONLY | O_NOFOLLOW` and byte caps on every sub-path.
