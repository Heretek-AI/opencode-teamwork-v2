# ADR 0002: Retain Single Workspace Run Artifact Root `.opencode/teamwork/<session-id>/` Pending Host Per-Conversation Filesystem Storage

- **Status:** Accepted
- **Date:** 2026-11-22
- **Issue:** [#6](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/6) (`refactor: Per-conversation artifact root`)
- **Classification:** `SPIKE` (Spike + ADR before moving files)

## 1. Context

Issue [#6](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/6) tracks the deferred architectural difference (`A21` in `docs/re/antigravity-teamwork/08-gap-analysis-opencode-teamwork-v2.md` §2.5 and §4.5) between Antigravity's per-conversation scratch root and `@heretek-ai/opencode-teamwork-v2`'s workspace-rooted run directory.

In Antigravity (`docs/re/antigravity-teamwork/11-runtime-artifacts.md` §2.1–§2.3, §4, §5.2):
- Teamwork state files (`ORIGINAL_REQUEST.md`, `PROJECT.md`, `SCOPE.md`, `GATE_STATUS.md`, and per-agent `teamwork_<role>_m<M>_r<R>[_<N>]/{DISPATCH,BRIEFING,progress,handoff}.md`) are written under `<appDataDir>/brain/<conversation-id>/scratch/.agents/teamwork/`.
- Each dispatched subagent runs in its own conversation with its own `brain/<conversation-id>/scratch/` directory, and the dispatch instructions explicitly forbid creating `.agents/teamwork/` inside the user's project workspace.

In `@heretek-ai/opencode-teamwork-v2` (`docs/ARTIFACTS.md:7-38`, `docs/GUARDRAILS.md:18-25`):
- Every run writes under a single workspace-relative root: `<workspace>/.opencode/teamwork/<session-id>/` (while git worktrees live outside the repository under `$TEAMWORK_WORKTREES_DIR` or `../.teamwork-worktrees/<session-id>/`).
- Every engine tool (`plugins/opencode-teamwork/tools.ts`), every CLI reader (`lib/runs.mjs`, `lib/timeline.mjs`, `lib/export.mjs`), every agent prompt (`agents/team/*.md`), and the CI prompt linter (`scripts/lint-prompts.mjs`) are written against this single-root contract; §7 records where that enforcement is incomplete.

Per [issue #6](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/6) and the [triage comment on #1](https://github.com/Heretek-AI/opencode-teamwork-v2/issues/1#issuecomment-7074469705) (`#6 Per-conversation artifact root — SPIKE, then ADR`), a spike must verify whether OpenCode V2 actually exposes a per-conversation or per-agent filesystem data directory and evaluate the impact on path containment, `timeline`, `export`, and legacy runs before moving any files.

## 2. Host Capability & Empirical Spike Evidence

### 2.1 OpenCode V2.3.2 Storage, Location, and Tool Context Primitives

A timeboxed spike inspected the installed OpenCode V2 binary (resolved as `OPENCODE_BIN`, else `command -v opencode`; reported `v2.3.2`) across the plugin context provider (`@173,419,500–173,428,500`) and inner plugin host (`@177,457,000–177,466,500`):

1. **`ctx.location` is workspace-scoped, not conversation-scoped (`@169,617,677`, `@173,420,383`, `@177,464,686`):**
   `ctx.location` exposes `{ directory, workspaceID }` representing the project workspace directory (`process.cwd()`). When `ctx.session.create` is called without `parentID`, it defaults to `WH.make({ directory: j.directory, workspaceID: j.workspaceID })` (`@177,464,686`). There is no per-session or per-conversation scratch path on `ctx.location`.
2. **`ctx.storage` is a plugin-global key-value store, not a filesystem directory (`@173,424,254` and `@177,465,959`):**
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
3. **`ctx.experimental.artifact` is a provider registration API, not a scratch directory (`@173,421,302`):**
   `ctx.experimental.artifact` exposes `{ reload, transform }` where `transform` allows a plugin to register an artifact provider (`add({ id, name, capabilities, prompt, create, read, update, delete })`). It does not supply a host-managed per-conversation directory to tools.
4. **`tool.execute(input, context)` receives `context.sessionID`, not a scratch path (`@173,428,138`):**
   The tool execution wrapper `Q(a, e, p)` invokes `a.execute(e, { ...R, get signal() { ... }, progress: (b) => ... })` where `R` carries `{ sessionID }` (used in `tools.ts:1421, 1607, 2126, 2501`). The host passes a string session identifier (e.g. `ses_...`), never a per-session directory on disk.

### 2.2 Reproducible Verification Command

Run the following command to verify the exact host primitives in OpenCode `v2.3.2` with zero network calls. It prints the resolved version first, and any needle that no longer matches is reported as `offset: -1` rather than silently omitted:

```sh
node -e '
const { readFileSync } = require("fs");
const { execSync } = require("child_process");
let bin = process.env.OPENCODE_BIN;
if (!bin) {
  try { bin = execSync("command -v opencode", { encoding: "utf8" }).trim(); } catch {}
}
if (!bin) {
  console.error("opencode binary not found: set OPENCODE_BIN or put opencode on PATH");
  process.exit(1);
}
const version = execSync(`"${bin}" --version`, { encoding: "utf8" }).trim();
console.log(version);
const buf = readFileSync(bin);
for (const needle of [
  "_={app:e.app,location:e.location,options:e.options",
  "storage:{get:(o)=>y(e.storage.get(o))",
  "function Fd(L,e){let f=`plugin:${e.split",
  "artifact:{reload:()=>y(e.experimental.artifact.reload())",
  "return Promise.resolve(a.execute(e,{...R,get signal()"
]) {
  const offset = buf.indexOf(Buffer.from(needle));
  if (offset === -1) {
    console.log(JSON.stringify({ needle, offset, note: "needle not found: update the contract string" }));
    continue;
  }
  const start = Math.max(0, offset - 80);
  const end = Math.min(buf.length, offset + needle.length + 80);
  console.log(JSON.stringify({ needle, offset, excerpt: buf.subarray(start, end).toString("utf8") }));
}
'
```

Observed output on this host (OpenCode `v2.3.2`, binary resolved from `PATH`; offsets are byte offsets and each `excerpt` is the matched text plus 80 characters either side):

```text
opencode v2.3.2
{"needle":"_={app:e.app,location:e.location,options:e.options","offset":173420383,"excerpt":"return yield*t.encode(P)}).pipe(rp(M))},D=(o)=>(s)=>I(o.transform((t)=>{s(t)})),_={app:e.app,location:e.location,options:e.options,agent:{get:r(E[\"agent.get\"],e.agent.get),list:r(E[\"agent.list\"],e.agent.list),t"}
{"needle":"storage:{get:(o)=>y(e.storage.get(o))","offset":173424254,"excerpt":"skill.list\"],e.skill.list),transform:D(e.skill),reload:()=>y(e.skill.reload())},storage:{get:(o)=>y(e.storage.get(o)),set:(o,s)=>y(e.storage.set(o,s)),remove:(o)=>y(e.storage.remove(o)),scan:(o)=>y"}
{"needle":"function Fd(L,e){let f=`plugin:${e.split","offset":177465959,"excerpt":",P9,yw,Ise,ns,px,Mw,bj,Cf,Pz,yse,Fz,Bj,gEe,vse,Bse,wse,Cse,X1,cx,y9,sse,Mj,B1]);function Fd(L,e){let f=`plugin:${e.split(\"\").map((r)=>r.charCodeAt(0).toString(16).padStart(4,\"0\")).join(\"\")}:`;return{g"}
{"needle":"artifact:{reload:()=>y(e.experimental.artifact.reload())","offset":173421302,"excerpt":".image),decisions:r(v[\"generate.decisions\"],e.experimental.generate.decisions)},artifact:{reload:()=>y(e.experimental.artifact.reload()),transform:(o)=>I(e.experimental.artifact.transform((s)=>{o({add:(t)=>s.add({id:"}
{"needle":"return Promise.resolve(a.execute(e,{...R,get signal()","offset":173428138,"excerpt":"n;v=!0,Np(g,{signal:AbortSignal.any([w,E.signal])}).then(()=>T.abort(),()=>{})};return Promise.resolve(a.execute(e,{...R,get signal(){return f(),x},progress:(b)=>Np(p.progress(b),{signal:w})})).finally(()=>E.abort"}
```

### 2.3 Local Single-Root Containment & CLI Reader Invariants

Inspecting the repository confirms three tightly coupled invariants anchored on `<workspace>/.opencode/teamwork/<session-id>/`:

1. **Path containment and symlink refusal (`plugins/opencode-teamwork/tools.ts:495-507, 917-1007`):**
   - `RUN_ROOT = ".opencode/teamwork"` (`:495`), `SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/` (`:498`), `TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (`:506`).
   - `runsBase(root)` (`:917-936`) calls `lstatSync` on `<root>/.opencode` and `<root>/.opencode/teamwork` to refuse symlinks and verifies `realpathSync(base)` stays within `realpathSync(root)`.
   - `resolveRun(root, sessionId)` (`:984-1007`) validates `SESSION_ID`, rejects a lexically escaping `relative(base, cand)` (`..` or absolute), and — only when `existsSync(cand)` is true — refuses `lstatSync(cand).isSymbolicLink()` and re-checks containment with `realpathSync(base)` / `realpathSync(cand)`. It does **not** call `containmentError`; that helper (`:804-810`) is used only by the worktree code (`:2694, 2702, 2727, 2738`). The `existsSync` guard is a known dangling-symlink gap (§7).
2. **Standalone CLI inspection (`lib/runs.mjs:21`, `lib/timeline.mjs:89-125`, `lib/export.mjs:138-223`):**
   - `opencode-teamwork runs`, `inspect`, `timeline`, and `export` run as standalone Node CLI processes from the project root (`process.cwd()`), with no connection to the OpenCode plugin runtime.
   - `lib/timeline.mjs` and `lib/export.mjs` verify `runRootIsLink(projectRoot)` (`.opencode` and `.opencode/teamwork` symlink checks), read `<projectRoot>/.opencode/teamwork/<session-id>/` with `O_RDONLY | O_NOFOLLOW` and byte caps (`8 MiB` for `events.jsonl`, `64 MiB` for JSON), and validate `verify/report-<taskId>.json` containment inside the single `runDir`.
3. **CI prompt linter (`scripts/lint-prompts.mjs:5, 76-85, 123-124`):**
   - Rejects the legacy `.teamwork-runs` root and `<run-id>` terminology in agent prompts (`FORBIDDEN`, `:76-85`) and the legacy root in plugin command templates (`:123-124`); it also parses topologies from `docs/ARTIFACTS.md` (`:29-73`).
   - It does **not** assert that `docs/ARTIFACTS.md` documents only the canonical root, nor that `tools.ts`, `lib/runs.mjs`, `lib/timeline.mjs`, and `lib/export.mjs` agree on it (see §7, artifact-root drift).

## 3. Decision

**We retain `<workspace>/.opencode/teamwork/<session-id>/` as the single canonical artifact root and defer relocating artifacts to per-conversation roots.**

Specifically:
1. **No relocation to non-existent host per-conversation storage:** Because OpenCode `v2.3.2` exposes no host-provided per-conversation filesystem directory (`ctx.location` is workspace-level and `ctx.storage` is a global KV store inaccessible to standalone CLI tools), moving run state out of `<workspace>/.opencode/teamwork/<session-id>/` cannot use a native host primitive.
2. **Preserve single-root `resolveRun`, `timeline`, and `export` guarantees:** Keeping all artifacts for `<session-id>` under one contained directory means the `SESSION_ID`/`TASK_ID` allowlists, intended `lstatSync` symlink refusal (with the dangling-symlink limit noted in §7), `realpathSync` containment, and standalone `opencode-teamwork runs | inspect | timeline | export` behavior stay unchanged, without multi-directory discovery or clock-skew unioning.
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

### Alternative B (Deferred): Explicit `scratchRoot` / `$OPENCODE_TEAMWORK_SCRATCH_DIR` outside the workspace

- Mirrors `$TEAMWORK_WORKTREES_DIR` (`tools.ts:2659-2661`) by relocating the entire `.opencode/teamwork/<session-id>/` tree to a user-configured external directory while keeping one directory per `<session-id>`.
- **Why deferred:** Unlike per-conversation roots, a single external `scratchRoot` still puts all agents of a run in one directory (so it does not provide per-agent write isolation), and it breaks parameterless `npx @heretek-ai/opencode-teamwork-v2 timeline | export` unless the same environment variable or config is present in every user shell.

### Alternative C (Rejected): Split a single run across multiple per-`context.sessionID` root directories and union them in `timeline` / `export`

- Would store artifacts under `<root>/<runId>/<context.sessionID>/...` or `<scratchRoot>/<context.sessionID>/...` and require `lib/timeline.mjs` and `lib/export.mjs` to discover and union multiple roots into one run report.
- **Why rejected:**
  1. Standalone CLI calls (`opencode-teamwork timeline <runId>`) have no access to OpenCode's in-memory session tree when `opencode.db` is absent or located in a custom XDG data path, making child-root discovery unreliable without a parent manifest inside the primary run root anyway.
  2. Unioning `state.json`, `costs.json`, `events.jsonl` (`seq`), and `verify/final.json` across multiple directories reintroduces split-brain state and cross-root ordering ambiguity.

## 5. Consequences

### Positive
- No regression to `resolveRun` behavior, `O_NOFOLLOW` bounded readers in `lib/timeline.mjs` and `lib/export.mjs`, `scripts/lint-prompts.mjs`, or legacy single-root runs (their pre-existing gaps are listed in §7).
- Maintains a clear separation between out-of-repo git worktrees (`../.teamwork-worktrees/<session-id>/`) and single-rooted run metadata (`.opencode/teamwork/<session-id>/`).

### Negative / Trade-offs
- Agents holding `edit` or `shell` permissions are not confined by the host to a private per-agent scratch directory (`docs/GUARDRAILS.md:27-33, 38-40`).

## 6. Missing Capabilities & Migration Plan (If Revisited)

### 6.1 Exact Missing Host Capabilities in OpenCode V2 (`v2.3.2`)
1. **Per-session filesystem scratch path:** OpenCode's `PluginContextProvider` (`@173,420,383`) and tool `execute` context (`Q` at `@173,428,138`) expose `ctx.location.directory` (workspace) and `context.sessionID` (string ID), but no host-managed per-session scratch directory (`context.scratchDir` or `ctx.session.scratchPath({ sessionID })`) outside the git working tree.
2. **Per-agent filesystem sandbox enforcement:** OpenCode's `permission.hook("evaluate")` (`@173,423,694`) can deny `edit` or `shell`, but does not enforce per-agent path confinement for `shell` commands (`docs/GUARDRAILS.md:27-32, 41`).

### 6.2 Migration Plan If Per-Conversation Roots or `scratchRoot` Are Revisited

If OpenCode V2 adds a per-session scratch directory or if maintainers opt into an explicit `scratchRoot` setting. Throughout this subsection `<runRoot>` is the artifact base (`<workspace>/.opencode/teamwork`, or the configured external root) and `<runDir>` is `<runRoot>/<session-id>`:
1. **Primary Run Anchor & Legacy Tolerance:**
   - Keep `<runDir>` (the legacy layout is `<workspace>/.opencode/teamwork/<session-id>/`) as the fallback so existing runs continue to resolve without migration.
   - If an external `scratchRoot` is configured (via `OPENCODE_TEAMWORK_SCRATCH_DIR`, or a documented `artifactsRoot` key in `~/.config/opencode/teamwork.json`), validate that `scratchRoot` is an absolute path, is not a symlink (`lstatSync`), and does not alias `/` or the git `.git` directory; resolve runs by checking the configured `scratchRoot` first and falling back to `<workspace>/.opencode/teamwork/<session-id>/`. Note that `teamwork.json` is currently the installer-written agent model map (`{ "models": { ... } }`, read by `lib/team.mjs:79-81, 84-94` and documented in `README.md`); adding paths there requires an explicit, documented schema addition, not an ad-hoc key.
2. **Per-Agent Sub-Roots Under One Run Index:**
   - Never scatter root-level files (`ORIGINAL_REQUEST.md`, `plan.dag.json`, `state.json`, `costs.json`, `events.jsonl`, `verify/final.json`) across sibling conversation folders.
   - Instead, isolate per-agent outputs under `<runDir>/agents/<subSessionId>/` (validated against `SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/` and `ensureSafeRunSubpath` segment-wise `lstatSync` + `realpathSync`).
3. **Reader Union Contract (`lib/runs.mjs`, `lib/timeline.mjs`, `lib/export.mjs`):**
   - `buildTimeline` and `buildExportData` continue to read `plan.dag.json`, `state.json`, `costs.json`, `events.jsonl`, and `verify/final.json` from the canonical `<runDir>` anchor, and union per-agent artifacts from `<runDir>/agents/<subSessionId>/` in deterministic `(seq, timestamp, subSessionId)` order while enforcing `O_RDONLY | O_NOFOLLOW` and byte caps on every sub-path.

## 7. Known gaps / follow-ups

This ADR records a decision, not a guarantee that the current single-root implementation is airtight. The following gaps are known and deliberately left to follow-up work:

1. **Dangling symlinks bypass the refusal checks (High).** Both `runsBase` (`plugins/opencode-teamwork/tools.ts:917-936`) and `resolveRun` (`:984-1007`) gate their `lstatSync` / `realpathSync` checks behind `existsSync`. `existsSync` follows symlinks, so a *dangling* symlink at `.opencode`, `.opencode/teamwork`, or `.opencode/teamwork/<session-id>` reports absent and is never refused; `resolveRun` then returns the path and writers such as `mkdirSync(run, { recursive: true })` (`:1373`) and `writeFileSync` follow the link outside the root. A future resolver must `lstat` every component of the path, treat only `ENOENT` as absent, refuse *any* symlink (including dangling ones), and only then apply `realpathSync` containment. This is a real escape today, not only a per-conversation concern.
2. **External `scratchRoot` runs would be invisible to every reader (Medium).** `listTeamworkRuns` hard-codes `<projectRoot>/.opencode/teamwork` (`lib/runs.mjs:20-25`); `inspect` reuses it (`lib/runs.mjs:75-76`), and `runs`, `timeline`, and `export` discover runs through it (`bin/opencode-teamwork.mjs:221, 303, 372`). Worktree `prune` reads the phase from the same workspace-rooted `state.json` (`lib/runs.mjs:140-145`), so an external run would look unfinished and its worktrees would never be pruned. Adopting Alternative B therefore requires one shared resolver plumbed through run creation, `listTeamworkRuns`, `buildTimeline`, `buildExportData`, and `pruneTeamworkWorktrees`; otherwise external runs silently disappear from the CLI.
3. **Artifact-root drift passes CI (Medium).** `scripts/lint-prompts.mjs` only rejects the legacy `.teamwork-runs` string and `<run-id>` terminology (`:5, 76-85, 123-124`) and asserts that `tools.ts` *contains* `SESSION_ID`, `relative(`, `realpathSync(`, `lstatSync(`, and `permission.hook` (`:141-149`). It never asserts that `RUN_ROOT = ".opencode/teamwork"` (`tools.ts:495`), the layout in `docs/ARTIFACTS.md:7-38`, and the root literals in `lib/runs.mjs` / `lib/timeline.mjs` / `lib/export.mjs` agree. A future root change can therefore land half-applied and still pass. The required check is a single canonical root (a constant, or parsed from `docs/ARTIFACTS.md`) compared against every reader and writer, failing CI on mismatch.
