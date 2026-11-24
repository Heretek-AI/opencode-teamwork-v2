# L1 runtime harness

The real plugin registered in the real **OpenCode 2.4.1** runtime, exercised
through the host's own tool executor, with **no model and no network**. This
directory is development-only: it is not in the root package's `files` list and
is excluded from the published tarball by omission.

## Run

```sh
cd tests/runtime
bun install
bun test
```

The install is the only network step. At test time the host is embedded with an
in-memory database, `models.fetch: false`, and a disabled file watcher; the
plugin is pointed at a temp project, temp `HOME`, temp XDG roots and a temp
config directory. Test output starts with one line per loaded host:

```text
[l1] @opencode/core=2.4.1 sdk=2.4.1 plugin=2.4.1 ai=2.4.1 effect=4.1.0 host=2.4.1 mode=memory
```

## Pinned dependencies

`tests/runtime/package.json` pins exact devDependencies only:

| Package           | Version |
| ----------------- | ------- |
| `@opencode/core`  | 2.4.1   |
| `@opencode/sdk`   | 2.4.1   |
| `@opencode/plugin`| 2.4.1   |
| `@opencode/ai`    | 2.4.1   |
| `effect`          | 4.1.0   |

`4.1.0` is the `effect` version `@opencode/sdk@2.4.1` depends on. The root
package remains dependency-free; `scripts/test-catalog.mjs` and the CI packaging
guard both assert that, and that `tests/` never appears in the tarball.

## Load paths

Both are covered by `spec/a1-load.test.ts`:

1. **In-memory plugin object** — the plugin's default `{ id, setup }` object is
   passed to the host's `plugins` list. The host reports the source as `sdk`.
2. **Local directory** — `<config>/opencode.json` contains
   `plugins: [{ package: "<abs>/plugins/opencode-teamwork" }]`. The host resolves
   the directory's `package.json`/`exports`, imports the TypeScript entry, and
   reports the source as `local`.

The harness builds the host with `@opencode/sdk`'s internal
`dist/internal/host.js` and adapts plugins with `@opencode/core/plugin/promise`,
which is exactly what the public Promise `create()` does. **OBSERVED —
internal:** the public `create()` returns only an HTTP client and discards the
host runtime, but L1 needs that runtime to reach the real Tool service. No
public HTTP endpoint exposes the tool catalog. The internal entrypoint is the
smallest documented seam (cited in `docs/OPENCODE-COMPATIBILITY.md` §5.2); no
fake host is built.

Two host details the harness relies on:

- `config.directory` in the embedded host is the **global config directory**, not
  the session location (`packages/server/src/routes.ts` replaces `Global.config`
  with it). The harness puts `opencode.json` and `agents/` there, and pins each
  session's `location.directory` to the temp project root.
- Plugin setup is location-scoped and activation is asynchronous. The harness
  boots the project location with an `agent.list` request, then waits (bounded,
  15 s) until every expected plugin id is in `plugin.list`'s inventory.

## Tool listing and execution

- **List:** `Tool.Service.list()` for the project Location, reached through the
  host runtime and `LocationServiceMap`. **OBSERVED — internal** (see above).
  The effective id is the host's: `teamwork_<name>` with
  `options.namespace: "teamwork"`.
- **Execute:** `Tool.Service.snapshot().execute(...)`. This is the host's real
  executor: it decodes the tool's JSON Schema, runs `execute.before`/`after`
  hooks, enforces the output-schema rule, and normalizes content. A4/A8 use it.
- **Raw return:** A8 also calls the registered tool executor directly to
  observe the plugin's pre-normalization object (`teamwork_route` returns
  `content` as a string and no `output` key).

## Scenarios

| Spec | What it asserts |
| ---- | --------------- |
| A1 | Both load paths: plugin id, setup completes, state `active`, `ctx.app.version` is the installed `2.4.x` version. |
| A2 | Exactly the 26 `teamwork_*` ids from `scripts/test-catalog.mjs`; each has `options.namespace === "teamwork"`, `options.codemode === false`, and an object JSON Schema input; no bare `plan`/`next`; every `teamwork_*` token in `agents/team/**/*.md` and the command templates resolves. |
| A3 | The 7 commands are registered with their descriptions; invoking `team-review` substitutes `$ARGUMENTS`, switches the session to `team/orchestrator`, and admits the expanded prompt to the inbox. No model is configured; the model-less wake is interrupted. |
| A4 | A missing required property yields the runtime `Tool.Error` text and writes nothing. The unknown-property case is **OBSERVED — host limitation** (below). |
| A5 | Synthetic `permission.evaluate` events: `team/verifier` `edit` denied; `team/victory-auditor` `shell` allowed and `edit` denied; `team/worker`/`build` untouched. Session permissions are set to allow so the outcome is the hook's, not the markdown's own deny rule. |
| A6 | Two real plugin instances with different ids write the same key through `ctx.storage` and read back only their own value; values round-trip as JSON. |
| A7 | Every `agents/team/*.md` parses as a config agent with `id`, `name`, non-empty `description`; no stray `AD` lines. |
| A8 | `teamwork_route` through the runtime: raw `content` is a string with no `output` key; the normalized result has text content and `output === undefined` because no output schema is declared. |

## Findings

**Unknown input properties are stripped, not rejected (OpenCode 2.4.1).** The
runtime converts a tool's JSON Schema to an Effect codec and decodes with
`onExcessProperty: "ignore"`; `additionalProperties: false` therefore does not
produce a `Tool.Error` at the runtime boundary. The A4 unknown-property test
records this observed behavior (a read-only tool still succeeds and writes
nothing). Rejecting unknown input properties requires the plugin to validate
the raw input with a strict standard schema; that is a plugin change, not a
harness change, and is not made on this branch.

## Deliberately not covered

- **L2** (scripted `TestLLM` turns), **L3** (real git worktrees), and **L4**
  (live provider) — this harness is L1 only. It never sends a model request.
- TUI rendering, prompt judgment, cost/provider truth, same-UID forgery, NFS
  lock semantics, and transient filesystem swaps. These are residuals in
  `docs/OPENCODE-COMPATIBILITY.md` §7 and are not made provable by L1.
- The published tarball's installability (T4): `npm pack --dry-run` in CI checks
  the file list, but nothing here installs the packed tarball.
- Channel/dev builds and `@opencode/*@latest` drift (T3).
