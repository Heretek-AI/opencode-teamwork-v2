# ADR 0017: OpenCode 2.4.1 Plugin Contract and Test Strategy

- **Status:** Accepted (implemented 0.17.1–0.18.1; harness evidence recorded in
  [`TEST_READY.md`](../TEST_READY.md))
- **Date:** 2026-11-24
- **Scope:** `plugins/opencode-teamwork/index.ts`,
  `plugins/opencode-teamwork/tools.ts`,
  `plugins/opencode-teamwork/authorize.ts`,
  `plugins/opencode-teamwork/package.json`, `package.json`, `README.md`,
  `scripts/test-engine.mjs`, `tests/runtime/`,
  `docs/OPENCODE-COMPATIBILITY.md`
- **Depends on:** [OPENCODE-COMPATIBILITY.md](../OPENCODE-COMPATIBILITY.md)
  (the audited contract and the defect table this ADR decides to test)
- **Related:** [ADR 0013](0013-containment-parity-and-the-detective-boundary.md)
  (the detective boundary this ADR does not widen),
  [ADR 0016](0016-re-executable-verification.md) (re-execution: what a test can
  and cannot prove)

## 1. Context

The plugin was written against an earlier V2 host and the README still says
OpenCode `v2.0.26` (`README.md:18`). The audited host is 2.4.1
(`b0cda2010b`). In this ADR, `packages/...` paths are in the audited clone at
`/home/john/Projects/opencode`; paths under `plugins/`, `scripts/` or `agents/`
are this repository. Reading the two trees side by side
(`docs/OPENCODE-COMPATIBILITY.md` §1-§3) produced two findings:

1. The contract we rely on is narrower than the code assumes. In 2.4.1 the
   model-facing tool id is derived from `tool.options.namespace`
   (`packages/core/src/tool/runtime.ts:302-305`), while
   `editor.namespace()` only populates the Code Mode catalog
   (`packages/core/src/tool.ts:258-269`). Code Mode is on by default
   (`packages/core/src/tool/runtime.ts:307`) and moves every tool that does not
   opt out behind `execute` (`packages/core/src/tool.ts:328-332`). Our tools
   declare neither, so the prompts name `teamwork_*` ids the host never
   registers.
2. The existing unit shim cannot see either defect. It keys its tool table by
   `tool.name` and stubs `namespace` to a no-op
   (`scripts/test-engine.mjs:400-411`), so it agrees with the prompts rather
   than with the host.

Ten concrete defects follow from the audit
(`docs/OPENCODE-COMPATIBILITY.md` §4). Three are crashes or silent data loss
(the merge-path `output` defect, the ignored `cursor`, the hardcoded DB/service
paths); the rest are contract mismatches that make documented workflows fail or
degrade. A test strategy that only re-reads our own source would pass all of
them.

The alternative — pin the host and never test against it — was rejected. The
plugin's whole value is orchestration through host tools; a host-contract break
is a product break.

## 2. Decision

### 2.1 Host baseline

The supported host is OpenCode **2.4.1** (`b0cda2010b`). The compatibility
document is the normative statement of the surfaces we use; a change to a
cited surface is a compatibility change, not an implementation detail.

The `2.0.26` claim is retired. It is replaced by a reference to
`docs/OPENCODE-COMPATIBILITY.md`, which states the audit commit and labels every
claim OBSERVED or INFERRED.

### 2.2 Name contract

Every engine tool declares its namespace explicitly:

- `options.namespace: "teamwork"` on each `editor.add`, so the direct id is
  `teamwork_<name>` and the Code Mode path is `teamwork.<name>`;
- `editor.namespace({ name: "teamwork", description })` is retained only for the
  catalog description;
- one shared registration helper computes the declared id, so a new tool cannot
  be added without it.

The declaration is the single source of truth. Prompts keep the
`teamwork_<name>` spelling; the catalog golden (§2.5) proves the host agrees.

### 2.3 Code Mode placement is explicit

Each tool states its placement. Control-plane tools that the Sentinel is told to
call directly set `options.codemode: false`; tools that are only meaningful
inside a script keep the default. The decision is recorded per tool, not
inherited from a host default that may change between minors.

Placement is asserted from the host's snapshot, not from reading our options:
the test records whether the tool appears as a direct definition or only inside
the Code Mode inventory.

### 2.4 Test layers

| Layer | Scope | Gate |
| --- | --- | --- |
| L0 | existing unit suites, corrected so the shim computes effective names from `options.namespace` | every push |
| L1 | plugin in an embedded host, tools invoked directly with no model | every push |
| L2 | scripted `TestLLM` multi-turn through the embedded host | every push |
| L3 | L2 over a real temp git repository and worktree | every push |
| L4 | live provider, opt-in only | never a correctness gate |

L1 and L2 use the host's own embedding surface, not a new one:

- `OpenCode.create(options, { overrides })`
  (`packages/sdk/src/promise.ts:20-34`,
  `packages/sdk/src/internal/host.ts:18-33`);
- `llmClient.replace(Layer.succeed(LLMClient.Service, llm))` with
  `TestLLM.testLayer(...)` (`packages/ai/src/testing.ts:53-102`), the pattern
  the host's own embedded test uses
  (`packages/sdk/test/embedded.test.ts:59-81`);
- the in-memory database default (`packages/sdk/src/internal/host.ts:41`), so
  L1/L2 cannot touch a real user database;
- the plugin loaded twice: from a local directory through
  `config.plugins` (`packages/core/src/plugin/module.ts:107-120`,
  `packages/schema/src/config/plugin.ts:6-14`) and in memory through `plugins`
  (`packages/sdk/src/promise.ts:71-75`).

Assertions are on tool results and on-disk artifacts. A prompt assertion may
exist as a cheap regression, but it is never the existence proof for a tool;
the catalog is.

### 2.5 The catalog golden

The first artifact is `tests/runtime/catalog.golden.json`: effective id,
`options.namespace`, Code Mode placement, required input keys, and a digest of
each input/output JSON Schema, captured from `ctx.tool.list()` after all
transforms (`packages/plugin/src/promise/tool.ts:83-88`).

This is deliberately first. It is the smallest artifact that reproduces the
bare-name and Code-Mode-default defects with no model, no git and no network,
and its diff names the tool and the field that changed. Every other layer may
be flaky or expensive; this one is neither.

### 2.6 CI tiers

| Tier | Contents | Trigger | Blocking |
| --- | --- | --- | --- |
| T0 | `npm test` + catalog golden | push/PR | yes |
| T1 | L1 + L2, exact `@opencode/*@2.4.1` | push/PR | yes |
| T2 | L3, real git worktree | push/PR | yes |
| T3 | full matrix + `@opencode/*@latest` drift | nightly | no |
| T4 | `npm pack`, clean install, load | release tag | yes |

T3 reports drift rather than blocking: a 2.5 change should be visible before it
is urgent, but it must not hold a security release. T4 is the only tier that
proves the tarball's `files` list is sufficient; `tests/` is excluded by
omission (`package.json:33-45`).

### 2.7 Dependency and version policy

- The published package remains **dependency-free at runtime**
  (`package.json` has no `dependencies` key). The host is a peer, never a
  dependency.
- `package.json` gains an optional peer range:
  `peerDependencies: { "@opencode/plugin": "^2.4.0" }` plus
  `peerDependenciesMeta: { "@opencode/plugin": { "optional": true } }`.
- `setup` reads `ctx.app.version` (`packages/core/src/app.ts:4-19`) and logs one
  warning on mismatch, tolerating `"unknown"` (the embedded case). It never
  refuses to load.
- Exact `@opencode/*@2.4.1` pins exist only in the harness devDependencies.

A hard refusal was rejected: channel builds and the embedded SDK legitimately
report a different or unknown version, and a version string is not a
capability probe. The warning plus the pinned test range is the honest signal.

### 2.8 Transmission of the ten defects

The fix direction is part of this decision, because the tests are written to
fail on the current behaviour and pass on the stated one:

| # | Defect (`OPENCODE-COMPATIBILITY.md` §4) | Decision |
| --- | --- | --- |
| 1 | bare tool ids | declare `options.namespace` (§2.2) |
| 2 | Code Mode hides tools | declare placement (§2.3) |
| 3 | `output` without schema on the merge path | delete the stray `output` key; return the conflict text in `content` |
| 4 | hardcoded `opencode.db` / `service.json` | honour `OPENCODE_DB`; resolve the channel filename (`packages/cli/src/database-path.ts:4-13`, `packages/cli/src/services/service-config.ts:41-44`); skip cleanly when neither exists |
| 5 | ignored session cursor | follow `cursor.next` to exhaustion, bounded by depth and a page cap |
| 6 | identity assumptions | walk `parentID ?? fork.sessionID`; treat an absent agent as unresolved only for mutating tools (unchanged fail-closed) |
| 7 | agents installed during `setup` | move installation to `init`; `setup` registers only |
| 8 | nested package version | derive or delete the nested version |
| 9 | stray `AD` lines | delete |
| 10 | plan template missing required args | include `topology` and `tasks` in the command template, matching the Sentinel prompt |

## 3. Consequences

- The plugin's public tool names become testable facts. A rename, a lost
  namespace or a host default change fails T0 before a model is involved.
- The test suite gains a real host dependency and a bun runtime. That is a
  deliberate increase in CI cost; it buys the only signal that distinguishes
  "our prompts agree with our source" from "the host agrees with our prompts".
- The pinned 2.4.1 harness will be wrong about 2.5. T3's non-blocking drift job
  is the intended early-warning channel, not a substitute for re-auditing the
  contract when a minor lands.
- Moving agent installation out of `setup` changes install behaviour for
  existing users: `init` must remain idempotent and non-destructive (the
  existing installer already is, `lib/team.mjs` `installAgents`).
- The optional peer range changes nothing for users who install with npm and
  never install the host package; it documents the tested range for package
  managers and humans.
- The residuals in `OPENCODE-COMPATIBILITY.md` §7 are unchanged. In particular,
  a scripted model in L2 and L3 cannot prove judgment, and a same-UID harness
  cannot prove isolation. This ADR deliberately does not claim otherwise.

## 4. Alternatives considered

- **String-search tests over prompts and source.** Cheap, fast, and blind to
  both defects in §1. Rejected: it would have passed the current tree.
- **Snapshot the whole repository and diff it.** Noisy, unreviewable, and it
  cannot distinguish a host contract change from a comment edit. Rejected in
  favour of the narrow catalog golden.
- **Live-model-only end-to-end tests.** Slow, nondeterministic, costly, and they
  conflate model judgment with contract compliance. Rejected as a gate; kept as
  L4.
- **Vendoring the host packages to remove the install step.** Reproducible but
  enormous, license-heavy, and it stops testing the published package boundary.
  Rejected.
- **Hard-failing on an unexpected host version.** Simple, but it turns a
  channel build or an embedded SDK into an outage and provides no more
  capability information than a warning. Rejected in favour of §2.7.

## 5. Verification of this decision

The decision is satisfied when:

1. `tests/runtime/catalog.golden.json` exists and T0 diffs it;
2. every engine tool's effective id is `teamwork_*` and its Code Mode placement
   is recorded;
3. L1 proves the merge-conflict path returns content rather than a defect;
4. L2 proves a scripted model can call the tool by the name the prompt uses;
5. L3 proves the worktree setup/merge path in a real repository;
6. T4 installs the packed tarball and loads the plugin from it.

**Implementation note (0.19.2).** Items 1–6 are implemented. The generated
`catalog.golden.json` was replaced by `scripts/test-catalog.mjs` (L0) plus
`tests/runtime/spec/a2-catalog.test.ts` (real host); the explicit expected list
is the reviewable artifact. T4 (`scripts/test-packed-tarball.mjs`) installs the
packed tarball and loads it through the A1 directory-mode spec; A2/A3 in that
same run still exercise the working-tree module. See
`docs/OPENCODE-COMPATIBILITY.md` §4.1 and §5.4.
