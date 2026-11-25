# OpenCode compatibility

What this plugin is written against, which host surfaces it uses, where the
implementation departs from them, and how the departure is tested.

> **Status at 0.19.2 (2026-11-25).** This is the historical audit of plugin
> **0.16.0**. The host-contract analysis in §1–§3 and the residuals in §7–§8
> remain the reference. All ten defects in §4 were fixed in 0.17.1–0.18.1
> (disposition in §4.1), and the harness planned in §5 now exists at
> `tests/runtime/`. The audit prose keeps its original citations and evidence
> labels; current-state notes are marked separately so the historical claims
> are not mistaken for present behaviour.

**Audited host:** OpenCode **2.4.1**, commit `b0cda2010b`, read from the clone at
`/home/john/Projects/opencode`. Package version and commit are OBSERVED
(`package.json:5`; `git log -1` in the clone). **Audited plugin (historical):**
this checkout at `main` `6340f64` (`package.json` version `0.16.0`). The
current tree is version 0.19.2; its runtime evidence is recorded in
[`TEST_READY.md`](TEST_READY.md).

**Evidence labels.** Every claim below is marked:

- **OBSERVED** — read in the cited source at the cited line.
- **INFERRED** — reasoned from the source but not directly stated there.

The 0.16.0 audit made no claim that a host or harness was executed; its
behavioural statements are what the cited source says. Runtime evidence added
after the harness existed is labelled as such and recorded in `TEST_READY.md`.

At the 0.16.0 audit the README still said "Verified against **OpenCode
`v2.0.26`**", two minor lines behind the audited host and predating the Code
Mode default, the `Tool.Options` reshaping and the automation context addition
in §1.2. The README now names **OpenCode 2.4.1** (`README.md:18`).

---

## 1. Supported host and plugin entry

### 1.1 Entry shape

The host accepts a plugin module whose `default` export is exactly one of:

- `{ id: string, effect: (Context) => Effect<void> }`, or
- `{ id: string, setup: (Context) => Cleanup | void | Promise<Cleanup | void> }`.

OBSERVED: `packages/core/src/plugin/module.ts:81-94` (the module schema rejects
a bare function and any other shape), and
`packages/plugin/src/promise/plugin.ts:64-69` (`Cleanup` is optional; a setup may
return a disposer).

This repository exports the second shape (`plugins/opencode-teamwork/index.ts:
210-233`), which is the promise adapter. That matches the contract (OBSERVED).
There is no `config` hook in this API; commands are registered through
`ctx.command.transform` (OBSERVED: `packages/plugin/src/promise/command.ts:19-26`).

### 1.2 2.3.2 → 2.4.1 delta

OBSERVED by reading `git diff v2.3.2..v2.4.1` over `packages/plugin/src`,
`packages/schema/src`, and `packages/sdk`: no exported server-side symbol this
plugin consumes was removed. The surface we use grew, but six changes are
behavioural or type-shaping rather than purely additive:

| Change | Kind | Where |
| --- | --- | --- |
| `Tool.Context.codemode` added (true inside `execute`) | additive field | `packages/schema/src/tool.ts:45-46` |
| `Tool.Options` reshaped: `codemode` may be `boolean`, `{ pinned, description, input, output }`; top-level `pinned` deprecated | type-breaking widening, source-compatible for our use | `packages/schema/src/tool.ts:59-75` |
| `Tool.Info` gained `CMInput`/`CMOutput`; `execute` input is the union of both; `ToolEditor.add` gained the same parameters | type-level generic change | `packages/schema/src/tool.ts:127-142`, `packages/plugin/src/promise/tool.ts:22-49` |
| `ToolHooks` gained `info` and `codemode` | additive fields | `packages/plugin/src/promise/tool.ts:51-81` |
| `ctx.experimental.automation` added | additive context domain | `packages/plugin/src/promise/plugin.ts:36-43` |
| `Job.Kind` / `SessionIdleBackground` gained `video` | additive variant | `packages/schema/src/job.ts:8-12`, `packages/plugin/src/promise/session.ts:184-188` |

INFERRED: the one place a 2.3.2-era plugin could break at compile time without
touching removed symbols is `Tool.Info`'s fourth generic parameter, because a
plugin that annotates its own helper types over `Tool.Info<Input, Output>` still
compiles but a helper that passed three arguments positionally would now mean
`CMInput` where it previously meant nothing. Our plugin uses `any` at its tool
registration boundary, so this is not currently load-bearing.

---

## 2. Context surface we use

`Context` is the object passed to `setup` (OBSERVED:
`packages/plugin/src/promise/plugin.ts:27-62`). The fields below are those the
plugin actually reads or calls.

| Surface | Host type / location | Used for | Notes |
| --- | --- | --- | --- |
| `location.directory` | `packages/schema/src/location.ts:19-27` | Resolving the project root; every run path is relative to it | Absolute path; the only location field we read |
| `command.transform` | `packages/plugin/src/promise/command.ts:19-26` | Registering `/teamwork` and the legacy command family | `editor.add` only; no command update/remove |
| `tool.transform` | `packages/plugin/src/promise/tool.ts:83-89` | Registering all 26 engine tools and the `teamwork` namespace | See §3 for naming |
| `session.get` | `packages/plugin/src/promise/session.ts:225-245` | Session ancestry and the caller's agent for authorization | Manual walk; see §2.2 |
| `session.switchAgent` | `packages/plugin/src/promise/session.ts:225-245` | Command templates that must run as `team/sentinel` etc. | Called before `session.prompt` |
| `session.prompt` | `packages/plugin/src/promise/session.ts:225-245` | Re-emitting the command template with `$ARGUMENTS` substituted | Same `delivery` object is forwarded |
| `session.hook("context")` | `packages/plugin/src/promise/session.ts:207-223` | Injecting the sanitised run briefing into `event.system` | Per-request, mutable |
| `permission.hook("evaluate")` | `packages/plugin/src/promise/permission.ts:19-24` | Denying `edit`/`shell`/`webfetch`/`subagent` for read-only team roles | Hook errors fail plugin load |
| `storage.get` / `storage.set` | `packages/plugin/src/promise/storage.ts:4-9` | HMAC key ring, root-session→run mapping, rotating indices | See §2.1 |
| `mcp.list` | `packages/plugin/src/promise/mcp.ts:14-17` | Detecting `opencode_console` for credit budgeting | Read-only |
| `model.default` | `packages/client/src/promise/generated/client.ts:1884-1895` | Reading the host default for model assignments | `GET /api/model/default`; the editor form is `ModelEditor.default.get/set` (`packages/plugin/src/promise/model.ts:14-17`) |
| `agent.list` | `packages/plugin/src/promise/agent.ts:14-17` | Checking that `team/*` agents are installed | `AgentApi.list` is `GET /api/agent` (OBSERVED: `packages/client/src/promise/generated/client.ts:537-549`) |
| `app.version` | `packages/core/src/app.ts:4-19` | Version warning (§8) | May be `"unknown"` in an embedded host |

### 2.1 Storage is a global KV, not a per-session store

OBSERVED:

- The host exposes only `get`, `set`, `remove`, `scan` (`packages/plugin/src/promise/storage.ts:4-9`).
- Values are `Schema.Json`; the SQLite column is `text({ mode: "json" })`
  (`packages/core/src/kv.ts:9`, `packages/core/src/kv/sql.ts:5-9`).
- The plugin's key namespace is derived solely from the plugin id:
  `plugin:<hex-of-id>:`, so every session, location and worktree on that host
  shares one keyspace (`packages/core/src/plugin/host.ts:681-708`).
- `set` is an unconditional upsert (`onConflictDoUpdate`) with no
  compare-and-swap, no version, no lease and no expiry
  (`packages/core/src/kv.ts:49-56`); the table has only key/value/timestamps
  (`packages/core/src/kv/sql.ts:5-9`).

Consequences (INFERRED from the above):

- Two concurrent writers to the same key are last-writer-wins. Our run locks
  (`plugins/opencode-teamwork/locks.ts`) are therefore required for control
  plane writes; the KV must not be treated as a mutex.
- There is no TTL, so every index we keep must carry its own timestamp and be
  bounded/compacted by us.
- Nothing is scoped to a session, directory or workspace. A key that embeds a
  session id is the only isolation available.
- Values round-trip through JSON, so `undefined`, `NaN`, `BigInt`, functions and
  cycles are not representable.

### 2.2 Session ancestry is manual

OBSERVED: there is no "ancestors" API. The host exposes `parentID` on a session
(`packages/schema/src/session.ts:32-40`), a `parentID` list filter
(`packages/schema/src/session.ts:74-102`), and `session.get`
(`packages/plugin/src/promise/session.ts:225-245`). Any walk is the caller's.

Two traps, both OBSERVED:

1. **Forks are roots by `parentID`.** The projector inserts a fork with
   `parent_id: null` and `fork_session_id: <source>`
   (`packages/core/src/session/projector.ts:163-170`). The host's own affinity
   helper therefore uses `parentID ?? fork.sessionID ?? id`
   (`packages/core/src/session/affinity.ts:5-8`). A walk that follows only
   `parentID` stops at a fork and treats it as unrelated to the run.
2. **Paged child lists.** `session.list` defaults to 50 rows and returns
   `cursor.previous` / `cursor.next`
   (`packages/core/src/session.ts:89`, `:434-458`; client query parameter at
   `packages/client/src/promise/generated/client.ts:616-631`). A caller that
   asks for children by `parentID` without following `cursor.next` silently
   loses every child after the first page.

At the 0.16.0 audit our implementation followed neither fork lineage nor the
cursor; both were fixed in 0.17.1 (see §4 rows 5-6 and §4.1).

### 2.3 Identity is optional and partly contextual

OBSERVED:

- `Session.Info.agent` is optional (`packages/schema/src/session.ts:32-40`).
  A session may have no recorded agent, including a session created by an API
  client rather than the TUI.
- `switchAgent` changes the session's agent for subsequent work
  (`packages/plugin/src/promise/session.ts:225-245`); the stored value is not a
  history.
- The session's `parentID` is the only structural fact; there is no signed
  "who called me" field.

INFERRED: any authorization that treats `session.get(...).agent` as an
authenticated caller identity is trusting host-written metadata that is absent
for some sessions and mutable for others. It is a useful routing signal, not a
security boundary. Our code fails closed when the agent is missing
(`plugins/opencode-teamwork/authorize.ts:317-331`), which is the right default.
At 0.16.0 it also failed closed for legitimate fork descendants; since 0.17.1
the ancestry walk follows `fork.sessionID` (see §4 row 6 and §4.1).

---

## 3. Tool contract

### 3.1 Effective id

OBSERVED (`packages/core/src/tool/runtime.ts:300-305`):

```ts
export const normalizedName = (tool) => tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
export const effectiveName = (tool) =>
  tool.options?.namespace === undefined
    ? normalizedName(tool)
    : `${tool.options.namespace.replaceAll(".", "_")}_${normalizedName(tool)}`
```

So the model-facing id is:

- `<normalized name>` when `options.namespace` is absent, and
- `<namespace with dots → underscores>_<normalized name>` when it is present.

The underscore form is what `editor.add` commits (`packages/core/src/tool.ts:
266-269`) and what a model calls as a direct tool. The dot form is what Code
Mode uses for `options.namespace` (below).

### 3.2 `editor.namespace` is catalog-only

OBSERVED:

- `editor.namespace({ name, description })` writes into `editor.namespaces`
  (`packages/core/src/tool.ts:258-265`). It has no effect on `add`, `update` or
  `effectiveName`.
- `add` derives the id from the **tool's own** `options.namespace`
  (`packages/core/src/tool.ts:266-269`).
- The only consumer of `namespaces` is the Code Mode inventory
  (`packages/core/src/tool.ts:346-349`), where it supplies a description for a
  path; tools are still placed by `qualifiedName(registration)`
  (`packages/core/src/codemode/tool.ts:503-514`, `:408-417`).

INFERRED: `editor.namespace("teamwork")` alone does **not** produce
`teamwork_plan`. It creates a namespace node that has no tools unless the added
tools declare `options.namespace: "teamwork"`. This is the root cause of the
bare-name defect in §4 row 1.

### 3.3 Code Mode is the default, and it hides direct tools

OBSERVED:

- `defaultCodeMode(tool) = tool.options?.codemode !== false`
  (`packages/core/src/tool/runtime.ts:307`).
- In `snapshot`, a tool is moved into the Code Mode inventory when Code Mode is
  available and `defaultCodeMode(tool)` is true; only tools with
  `codemode: false`, or explicitly kept direct, stay as direct tools
  (`packages/core/src/tool.ts:321-333`).
- Without Code Mode the same tools become direct, because otherwise they would
  be unreachable (`packages/core/src/tool.ts:312-314`).
- Inside Code Mode the callable path is the dot-qualified name
  (`packages/core/src/codemode/tool.ts:408-417`); the dispatcher accepts either
  the map key or the qualified name (`:503-514`).

INFERRED: a plugin that adds tools without `options.codemode: false` is
invisible as a direct tool on a Code Mode host. The model can still reach it
only by writing an `execute` program that calls the dot path. Prompts that say
"call `teamwork_plan`" do not match either form unless the namespace is declared.

### 3.4 Only `content` (and a declared `output`) reaches the model

OBSERVED (`packages/core/src/tool/runtime.ts:58-73`):

- With no output schema, the host returns `{ output: undefined, content:
  normalizeContent(result.content), metadata? }`. Any other key on the result
  object is dropped.
- With an output schema, `result.output` is encoded/validated and passed as
  `output`; `content` is normalized with the output as a fallback when content
  is empty.

INFERRED: returning `{ content, conflict: true, conflictingFiles }` does not
surface `conflict` or `conflictingFiles` to the model. Only the text in
`content` is visible (plus `metadata` if the caller inspects it). Extra keys are
dead weight, and a prompt that depends on them is depending on nothing.

### 3.5 An `output` key without a schema is a defect

OBSERVED (`packages/core/src/tool/runtime.ts:58-61`):

```ts
if (outputSchema === undefined) {
  if ("output" in result) return yield* Effect.die("Tool result declared output without an output schema")
  ...
}
```

`Effect.die` is a defect, not a typed `Tool.Error`. The call does not become a
normal tool failure with a message the model can act on; it escapes the
declared error channel. OBSERVED and load-bearing for §4 row 3.

Conversely, when an output schema **is** declared, a result without `output`
fails with `Tool.Error("Tool did not return its declared output")`
(`packages/core/src/tool/runtime.ts:67`).

### 3.6 A failed JSON-Schema conversion silently disables validation

OBSERVED:

- `codecFor` builds a codec inside `Result.try(...).pipe(Result.getOrUndefined)`
  and caches `undefined` on failure (`packages/core/src/tool/runtime.ts:15-20`).
- `validateInput` then does `if (codec === undefined) return { value }`
  (`packages/core/src/tool/runtime.ts:88-91`).

INFERRED: a malformed or unsupported JSON Schema on a tool input does not fail
registration. It makes that tool accept unvalidated input. The tool's own
`execute` body must therefore not assume the schema ran; our tools do their own
sanitisation, which is why this is a latent risk rather than an active exploit.

### 3.7 Excess input properties are stripped before the tool runs (closed plugin-side in 0.18.1)

OBSERVED:

- The runtime compiles a raw JSON-Schema input to an Effect codec and decodes
  with `onExcessProperty: "ignore"` (`packages/core/src/tool/runtime.ts:115-121`,
  `:187-201`).
- The built-in `opencode.tool.input.repair` plugin runs on `execute.before`
  (`packages/core/src/plugin/tool-input-repair.ts:32,41-58`). Its `repairObject`
  deletes every undeclared key when the schema says
  `additionalProperties: false` (`:161-171`), before the runtime validator sees
  the input.

INFERRED: `additionalProperties: false` alone does not reject an unknown key on
2.4.1; by the time any decoder runs, the repair pass has removed it. A tool
input that is a Standard Schema still receives this repaired object.

**Closed in 0.18.1 (ADR 0019).** Every Teamwork tool input is wrapped in
`strictInput()`, a Standard Schema. The runtime calls
`schema["~standard"].validate` and turns its `{path, message}` issues into
`Tool.Error` (`packages/core/src/tool/runtime.ts:76-82`, `:101-113`,
`:148-167`), while `jsonSchema.input` returns the original schema unchanged
(`:169-185`). The wrapper also attaches a non-enumerable empty
`patternProperties` to each closed object so the repair pass leaves unknown keys
in place; the validator then rejects them at the exact path. The catalog is
byte-identical, and L1 A4 plus L2 J1 assert the refusal. `additionalProperties:
true` records remain intentionally open.

`Tool.Result` is defined at `packages/schema/src/tool.ts:121-125`; `Tool.Info`
and `Options` at `:127-143`.

---

## 4. Known defects against this contract (historical; all ten fixed)

These are the defects the `0.17.1` fix targeted. "Impact" is INFERRED from the
cited source; the defect itself is OBSERVED. The table is preserved as the
0.16.0 finding record; §4.1 records the 0.19.2 disposition.

| # | Defect | Evidence | Impact |
| --- | --- | --- | --- |
| 1 | **Bare effective ids.** All 26 tools call `editor.add` without `options.namespace`; the plugin only calls `editor.namespace`. Effective ids are `plan`, `route`, `next`, … not `teamwork_plan`. | `plugins/opencode-teamwork/tools.ts:6572-6580` and the other `editor.add` sites; no `options.namespace` anywhere in the file. Host rule at `packages/core/src/tool/runtime.ts:302-305`; catalog-only namespace at `packages/core/src/tool.ts:258-269`. | Every prompt and agent instruction that names `teamwork_*` (`plugins/opencode-teamwork/index.ts:44-55`, `agents/team/sentinel.md`) names a tool that does not exist under that id. The model sees the bare id instead. In Code Mode the path is bare too, because `qualifiedName` also keys off `options.namespace` (`packages/core/src/codemode/tool.ts:510-514`). |
| 2 | **Code Mode hides the tools by default.** No tool sets `codemode: false`, so on a Code Mode host all 26 are callable only from `execute`. | `packages/core/src/tool/runtime.ts:307`; `packages/core/src/tool.ts:328-332`. | Direct calls named in prompts fail, and the catalog shows an `execute` tool plus a tool list the prompt is not written for. Any test that calls `tools.plan` directly passes only because its shim ignores placement (`scripts/test-engine.mjs:400-411`). |
| 3 | **`output` without a schema on the worktree merge path.** The conflict return includes `output: mergeRes.stdout` while the tool declares no output schema. | `plugins/opencode-teamwork/tools.ts:12719-12725`; host rule at `packages/core/src/tool/runtime.ts:59-60`. | A merge conflict kills the call as a defect instead of returning the conflict text. The conflict artifact is already written by then, so recovery is possible, but the model gets a crash rather than the conflict branch it was told to handle. |
| 4 | **Hardcoded database and service paths.** The cost reader probes only `<home>/…/opencode/opencode.db` and `service.json`; it never reads `OPENCODE_DB`, and it never looks for the channel-suffixed filenames the host actually uses. | `plugins/opencode-teamwork/tools.ts:271-289`, `:291-314`. Host behaviour: `OPENCODE_DB` and `opencode-<channel>.db` at `packages/cli/src/database-path.ts:4-13`; `service-<channel>.json` at `packages/cli/src/services/service-config.ts:41-44`. | Cost tracking silently falls back to `ctx.session.get` for one session, losing the tree total, on any dev/beta/local channel or custom DB location. No error is raised because every probe is wrapped in `try {} catch {}`. |
| 5 | **The session `cursor` is ignored.** The service-tree walk requests `/api/session?parentID=…` once per parent and never reads `cursor.next`. | `plugins/opencode-teamwork/tools.ts:345-371`. Host default 50 and cursor shape: `packages/core/src/session.ts:89`, `:434-458`; API parameter: `packages/client/src/promise/generated/client.ts:616-631`. | A parent with more than 50 children loses the rest from the cost tree. The truncated total looks authoritative because the fallback order only runs when the API returns nothing at all. |
| 6 | **Identity assumptions.** Authorization walks `parentID` only, and treats a session with no stored `agent` as unresolved. Forks have `parentID = null`; their lineage is `fork.sessionID`. | `plugins/opencode-teamwork/authorize.ts:255-289`, `:317-331`; same walk in `plugins/opencode-teamwork/tools.ts:3599-3615`. Host: `packages/core/src/session/projector.ts:167`; `packages/core/src/session/affinity.ts:5-8`; `packages/schema/src/session.ts:40`. | A legitimate fork of a run session is denied as a non-descendant (`AUTHZ_SESSION_TREE`), and a session without a recorded agent is denied as unresolved (`AUTHZ_IDENTITY_UNRESOLVED`). This is fail-closed, so it is availability rather than forgery; it still makes a documented workflow unusable. |
| 7 | **Agents installed during `setup`.** The plugin writes markdown agents into the user's config directory as part of setup. | `plugins/opencode-teamwork/index.ts:200-215`. | Setup is not a pure registration step: it mutates the user's config, can race a concurrent host start, and makes a failed write invisible (`catch {}`). It also means an in-memory test host writes to the real config unless `HOME` is redirected. |
| 8 | **Nested package version.** The vendored plugin package declares `0.5.0` while the published root is `0.16.0`. | `plugins/opencode-teamwork/package.json:3`; `package.json:3`. | Two version surfaces drift; any diagnostic that reports the plugin package version reports the wrong generation. |
| 9 | **Stray `AD` lines.** Literal `AD` lines sit in the Sentinel and orchestrator prompts. | `agents/team/sentinel.md:46`, `:68`, `:79`, `:144`; `agents/team/orchestrator.md:59`. | They are sent to the model as prompt text and consume attention next to the routing instructions they interrupt. |
| 10 | **The `/teamwork` template omits the plan's required arguments.** `teamwork_plan` requires `topology` and `tasks`; the command template only tells the model to pass `request`, `requirements` and policy flags. | `plugins/opencode-teamwork/index.ts:45`; required list at `plugins/opencode-teamwork/tools.ts:6737`. | A model that follows the command text literally calls `teamwork_plan` without required arguments and gets an input validation error. The Sentinel agent prompt does mention topology and the task list, so the two instruction sources disagree. |

Rows 1 and 2 compound: the prompts use a name the host never registers, and the
host hides the bare names behind Code Mode. The unit shim cannot catch either,
because it keys the tool table by `tool.name` and stubs `namespace` to a no-op
(`scripts/test-engine.mjs:400-411`). That is the motivation for the harness in
§5.

### 4.1 Disposition at 0.19.2

All ten rows are fixed in the shipped tree:

| # | Current state | Guard |
| --- | --- | --- |
| 1, 2 | Every `editor.add` passes `options: { namespace: "teamwork", codemode: false }`; effective ids are `teamwork_*` and the tools stay direct. | `scripts/test-catalog.mjs` (26 ids, options, `strictInput`, prompt tokens); `tests/runtime/spec/a2-catalog.test.ts` against the real host |
| 3 | The merge-conflict return carries `content` and `mergeOutput`; it no longer sets an undeclared `output` key (merge-conflict branch in `tools.ts`). | The merge-conflict case in `scripts/test-engine.mjs` |
| 4 | Database resolution honors `OPENCODE_DB`, then channel-specific `opencode-<channel>.db`, then `opencode.db`; service lookup follows the same channel names (`tools.ts:312-347`). | `scripts/test-cost.mjs` |
| 5 | The session-tree walk follows `cursor.next` with a bounded loop (`tools.ts:435-465`). | The paginated child-list case in `scripts/test-engine.mjs` |
| 6 | Ancestry follows `fork.sessionID` / `fork_session_id` when `parentID` is absent (`authorize.ts:289-295`). | The fork-ancestry case in `scripts/test-engine.mjs` |
| 7 | `setup` only verifies agents and warns; it does not write them. Installation belongs to `init`/postinstall (`index.ts:232-250`). | L1 load specs |
| 8 | The root and vendored plugin manifests are in lockstep at 0.19.2. | `scripts/test-catalog.mjs` version check |
| 9 | No literal `AD` lines remain in the sentinel or orchestrator prompts. | Prompt lint; `tests/runtime/spec/a7-agents.test.ts` |
| 10 | The `/teamwork` template tells the model to pass `topology` and `tasks` (`index.ts:45`). | Prompt lint; `scripts/test-catalog.mjs` token check |

The unit shim's blindness is also addressed: the catalog guard runs without the
shim's namespace stub, and L1–L3 drive the real 2.4.1 runtime. The recorded
run counts and skip reasons are in [`TEST_READY.md`](TEST_READY.md).

---

## 5. Test strategy

The goal is to test the contract the host actually enforces, not the strings
our own prompts contain. Five layers, cheapest first.

| Layer | What runs | Model | What it proves |
| --- | --- | --- | --- |
| **L0** | `node`/`bun` unit suites under `scripts/` | none | Pure logic, artifact schemas, crypto, containment, CLI behaviour |
| **L1** | Real plugin registered in an embedded host; load, catalog, commands, schema, hooks, storage, result shape | none | Registration, effective names, schema conversion, refusal/auth paths, storage semantics against the real host |
| **L2** | Engine tools driven through real sessions and host storage: plan, claims, evidence, approvals | none | Tool placement, artifact flow, signing and gate behaviour without a model |
| **L3** | Whole workflows over a real temp git repository and worktree, including a two-process claim race and the verifier CLI | none | Worktree setup/merge/conflict, retries, strict waves, victory refusal/resume, crash recovery |
| **L4** | Real provider, real models, opt-in via `TEAMWORK_LIVE=1` | live | Only that a live model can use the catalog; never used as a correctness gate |

The original plan used a scripted `TestLLM` for L2/L3. The implemented harness
chose *no model at all*: it calls the host's real tool executor and the plugin's
registered tools, which is a stronger and cheaper assertion for the contract.
Prompt fidelity is the only question left to L4.

### 5.1 Harness location and dependencies

The harness planned here now exists (0.19.x):

```
tests/runtime/
  harness/load.ts       # embedded host, plugin load (memory or directory), overrides
  harness/project.ts    # throwaway project, config dir and TMPDIR per spec
  harness/tools.ts      # direct-call helpers and artifact assertions
  harness/plan.ts, run.ts, sign.ts, attest.ts, flow.ts
  spec/a1-load.test.ts … spec/a8-result-shape.test.ts  # contract, catalog, commands, schema, hooks
  spec/b-plan.test.ts … spec/j-strict-input.test.ts
  spec/agy-parity.test.ts                    # parity specs
  e2e/process-e2e.test.ts                    # real `opencode serve`; skips locally without the CLI (CI installs @opencode/cli@2.4.1)
  live/l4-live.test.ts                       # skipped unless TEAMWORK_LIVE=1
```

- Runtime: **bun**. `tests/runtime/package.json` pins the exact
  `@opencode/*@2.4.1` packages and `effect@4.1.0` as **devDependencies only**;
  the root package stays dependency-free.
- Packaging: `tests/` is not in the root `files` list, so it is excluded from
  the tarball by omission. `npm pack --dry-run` and
  `scripts/test-packed-tarball.mjs` are the guards.
- No test imports from `/home/john/Projects/opencode` at runtime. The clone is
  a reading reference; the harness installs the published packages.
- The L4 suite is opt-in via `TEAMWORK_LIVE=1`; it is never a correctness gate.

### 5.2 Embedded host and overrides

OBSERVED:

- `OpenCode.create(options, embed)` has the shape
  `create(CreateOptions = {}, EmbedOptions = {})`
  (`packages/sdk/src/promise.ts:20-34`).
- `EmbedOptions` is `{ overrides?: LayerNode.Replacements }`
  (`packages/sdk/src/internal/host.ts:25-28`); overrides are threaded into the
  embedded routes (`:43-47`).
- The embedded database defaults to `:memory:` (`packages/sdk/src/internal/host.ts:41`),
  so a test can opt into a file only when it needs cross-process work.
- `plugins` accepts in-memory plugin objects (`packages/sdk/src/promise.ts:20-24`,
  `:71-75`).
- A local directory is loaded through config
  (`packages/core/src/plugin/module.ts:107-120`); entries are
  `string | { package, options }` (`packages/schema/src/config/plugin.ts:6-14`).
- `TestLLM` exists as a real `LLMClient` replacement
  (`packages/ai/src/testing.ts:53-102`), but the implemented L1–L3 harness does
  not use it: there is no model request to script. It is reserved for a future
  prompt-level suite; L4 is the live-model layer.

Implemented harness shape (`tests/runtime/harness/load.ts`, OBSERVED):

```ts
const embedded = await Effect.runPromise(
  EmbeddedHost.create({
    database: { path: options.databasePath ?? ":memory:" },
    app: { name: "opencode-l1", version: versions.core },
    config: { directory: project.configDir, project: false, content: "{}" },
    models: { fetch: false },
    fs: { filewatcher: false },
    plugins: promisePlugins.map((plugin) => PluginPromise.fromPromise(plugin)),
  }),
)
```

The public `OpenCode.create()` returns only an HTTP client and discards the
runtime the L1 assertions need, so the harness uses the SDK's internal
`EmbeddedHost` entrypoint and documents it. The plugin is loaded both ways,
because they exercise different paths:

- **from a directory**: `config.plugins: ["/abs/path/to/plugins/opencode-teamwork"]`
  — proves the real module graph, `import.meta.url` agent lookup, and package
  resolution;
- **in memory**: `plugins: [teamworkPlugin]` — proves the exported object shape
  without a filesystem dependency.

### 5.3 Assertions

Assert on **tool results and on-disk artifacts**, never on prompt prose or the
model's narration:

- tool return `content` and `metadata`, plus `output` only when a schema is
  declared;
- files under the run directory (bytes/digest, JSON shape);
- refusal codes (`AUTHZ_*`, `AUTH_*`, `STALE_FENCE`, …) and exit paths;
- host-visible catalog entries: effective id, namespace, whether the tool is
  direct or Code Mode only.

A test may assert that a prompt *contains* a tool name (a cheap regression for
the §4 row 1 defect), but it must not treat that as proof the tool exists. The
existence proof is the catalog, not the prompt.

### 5.4 The catalog guard is the first artifact

The plan called for one captured `catalog.golden.json`. It was implemented as
two guards instead, because an explicit expected list is easier to review than a
large generated blob:

- `scripts/test-catalog.mjs` (L0) registers the real tools through the same
  effective-name shim and asserts the exact 26 `teamwork_*` ids, the
  `{ namespace: "teamwork", codemode: false }` options, the `strictInput`
  wrapper, the supported JSON-Schema keyword set, and that every tool token in
  the shipped prompts resolves to a registered id.
- `tests/runtime/spec/a2-catalog.test.ts` (L1) repeats the id/options contract
  against the real 2.4.1 host, while `a1-load.test.ts` proves both the
  in-memory and local-directory load paths.

This catches the bare-name and Code Mode defects before a model is involved,
and its diff is readable in review. It is also the check that would have caught
the `2.3.2 → 2.4.1` `Tool.Options` reshaping if the plugin had declared
namespaces.

---

## 6. CI tiers

| Tier | Contents | Trigger | Blocking |
| --- | --- | --- | --- |
| **T0** | `npm test` (all L0 suites) + `scripts/test-catalog.mjs` | every push / PR | yes |
| **T1** | L1 + L2 on pinned `@opencode/*@2.4.1` | every push / PR | yes |
| **T2** | L3 in a real git worktree | every push / PR | yes |
| **T3** | Nightly `@opencode/*@latest` drift, plus the macOS/Windows containment matrix | nightly / push | drift: no (reports); platform: yes |
| **T4** | Release tarball: `npm pack`, install into a clean dir, load the installed package through the A1 directory-mode L1 spec, then plan one L2 run through the same install (`e2e/packed-l2.test.ts`); A2/A3 in the same run still use the working tree | every push / PR and release tag | yes |

Notes (INFERRED):

- T3's `@latest` job is deliberately non-blocking: a 2.5 behavioural change
  should be visible in the nightly report, not stop a security release at 02:00.
  The macOS/Windows containment jobs are a separate blocking matrix; they do not
  run the full engine suite. The pinned 2.4.1 jobs remain the contract.
- T1's CI job (`runtime-l1`) installs `@opencode/cli@2.4.1` and runs the
  process E2E against a real `opencode serve`. The job asserts 118 pass, 1 skip
  (L4 live), 0 fail and requires the `[process-e2e]` log marker, so a missing
  host is a failure rather than a silent skip.
- T4 is the only tier that proves the published `files` list is sufficient.
  `tests/` being excluded by omission is verified by the tarball, not by a unit
  test reading `package.json`. The packed L2 smoke covers one plan flow; the L3
  worktree/claim/verifier scenarios are not re-run from the tarball.
- L4 never appears in a required tier. It costs money, depends on a provider,
  and answers a different question ("can a model cope?") than the contract does.

---

## 7. What no harness can prove

These remain residuals no matter how many layers pass. Each is a property of a
different principal or of the model, not of the plugin's code path.

| Residual | Why a harness cannot close it |
| --- | --- |
| **Prompt injection** | A test that scripts the model follows a script; the L1–L3 harness calls no model at all. A live model reading an untrusted document is the attack, and a passing test only shows the injection used in the test did not work. |
| **Same-UID forgery** | The engine and the attacker share a UID in every test we can run. Reading the KV key ring and minting an envelope is not simulated by a test that uses the same key legitimately. |
| **Model judgment** | Whether `team/verifier` noticed the real defect is not a function of the harness; a passing tool-level assertion only proves the call path, and a live run only proves the model made a call. |
| **A consistent signed lie under `declared`** | Under `declared` provenance there is nothing to re-execute. A false PASS with a matching signature passes every check by construction; only `command` provenance plus external re-execution narrows it. |
| **NFS exactly-once** | Locks are `link`/`rename`-based and documented as best-effort off one local filesystem. A test on tmpfs cannot prove a network filesystem's semantics. |
| **Transient detective swaps** | The post-write `(dev, ino)` check can miss a symlink swapped and restored between syscalls. A test sees one interleaving. |
| **TUI rendering** | The harness drives the server API, not the terminal renderer. Layout, wrapping, colours and keybindings are outside it. |
| **Cost/quota truth** | The harness can assert what the host reports; it cannot prove a provider billed that amount. |

---

## 8. Version pinning decision

**Decision:** publish an **optional peer range** and warn at runtime; do not add
a runtime dependency.

- `package.json` declares:
  - `peerDependencies: { "@opencode/plugin": "^2.4" }`
  - `peerDependenciesMeta: { "@opencode/plugin": { "optional": true } }`
- `setup` compares `ctx.app.version` (`packages/core/src/app.ts:4-19`) against
  the audited major/minor and logs **one** warning on mismatch, including the
  `"unknown"` embedded-host case. It never refuses to load.
- Installs stay dependency-free: an optional peer is not installed by npm
  (INFERRED: npm optional-peer semantics; the current package manifest has no
  `dependencies` key at all — OBSERVED, `package.json`).
- The exact `@opencode/*@2.4.1` pins live only in the harness
  devDependencies, where reproducibility matters and consumers are unaffected.

Rationale (INFERRED): a hard `engines`-style refusal would break channel builds
and the embedded SDK, both of which legitimately report a different or unknown
version. A warning plus a tested range keeps the common case honest without
turning a minor drift into an outage. The peer range documents intent for
package managers and humans; the runtime warning covers hosts that never
resolve the peer.

---

## 9. What remains unverified

- The audit in §1–§3 was a source read of 2.4.1, not an execution. Statements
  about how the host *behaves* there are INFERRED even where the harness now
  exercises the same path; the runtime evidence is the harness's own assertions
  (recorded in `TEST_READY.md`), not this document.
- The harness in §5 exists and runs against the published 2.4.1 packages. Its
  coverage is the listed specs, not every host surface; the L4 live suite is
  opt-in and the process-level E2E spec skips when the `opencode` CLI is absent
  from `PATH` (including the current CI runner).
- The 2.3.2 → 2.4.1 delta was read for the packages this plugin imports. A
  transitive type change outside them was not audited.
- npm's optional-peer installation behaviour was not executed in this checkout.
- Whether later 2.4.x releases change any §3 behaviour is unknown; the nightly
  host-drift job (`.github/workflows/host-drift.yml`) exists to surface it, and
  is non-blocking by design.
- The audit's "no harness can prove" list in §7 is unchanged: passing specs do
  not prove prompt injection is impossible, model judgment, same-UID containment
  or provider billing.
