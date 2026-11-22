# Spike: One Shared Safe-FS Module for Bounded Reads and Contained Writes

- **Status:** Proposed (research complete; no code written)
- **Date:** 2026-11-22
- **Workstream:** Sprint 2, S4a
- **Related:** `docs/adr/0004-intermediate-symlink-races.md`
- **Question:** Can the three bounded-reader implementations — `plugins/opencode-teamwork/tournament.ts` `readBoundedFileNoFollow`, `lib/export.mjs` `readBounded`, and `lib/timeline.mjs` `readBounded` — and the write paths share one module?

## 1. Answer in One Paragraph

**Yes, but not with the module in `lib/`.** A single low-level module works if it lives at `plugins/opencode-teamwork/safe-fs.mjs`: it ships with the plugin directory in every documented install mode, the plugin's TypeScript can import it statically, and `lib/*.mjs` / `bin/*.mjs` can import it as plain ESM on Node >=18. A `lib/safe-fs.mjs` placement works for npm and GitHub installs but breaks the documented manual install, which copies only `plugins/opencode-teamwork` into the OpenCode config directory (`README.md:188-193`). The three readers also have different public result shapes and policies, so the shared module must expose a low-level primitive plus thin adapters, not a single drop-in function.

## 2. Constraints

1. **Zero runtime dependencies.** `package.json` has no `dependencies` field; the package is intentionally dependency-free at runtime (`plugins/opencode-teamwork/index.ts:16-19`, `lib/export.mjs:11-12`, `lib/timeline.mjs:10-11`).
2. **Erasable TypeScript in the plugin, no `node_modules` imports.** `plugins/opencode-teamwork/index.ts:16-21`; Node's type stripping must be able to load every plugin file unchanged.
3. **`lib/*.mjs` and `bin/*.mjs` run on Node >=18.** `package.json` `engines.node` is `>=18`; these are plain ESM with no TypeScript syntax.
4. **The npm `files` whitelist ships `lib`, `plugins`, and `bin`.** `package.json:33-44`.
5. **No `docs/re/**` in the shipped package.** `package.json:38-39`; this spike does not rely on `docs/re/`.
6. **The documented manual install copies only the plugin directory.**
   `README.md:188-193` copies `agents/team/*.md` to `$CFG/agents/team/` and `plugins/opencode-teamwork` to `$CFG/plugins/`; it does **not** copy `lib/` or `bin/`. The plugin is then registered by directory path (`README.md:195-202`).
7. **The readers are synchronous.** All call sites are synchronous (`plugins/opencode-teamwork/tools.ts:988-990`, `lib/export.mjs:203,232,255`, `lib/timeline.mjs:136,221`), so an async dynamic import cannot replace the low-level read without rippling through every caller.

## 3. Inventory of the Implementations

### 3.1 `plugins/opencode-teamwork/tournament.ts` — `readBoundedFileNoFollow`

- Function: `plugins/opencode-teamwork/tournament.ts:347-402`.
- Flags: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (`:352-353`, `:363`).
- Fallback: if either flag is unavailable, an `lstat` pre-check refuses symlinks and non-regular files (`:354-362`).
- Post-open type/size: `fstatSync` (`:364-370`).
- Bounded read: `size + 1` buffer, `EINTR` retry, `EAGAIN` fail-closed (`:371-388`).
- Result shape: `{ status: "ok"; text } | { status: "absent" } | { status: "error"; error }` (`:326-329`).
- Wrapper: `readBoundedRunFile` runs `ensureSafeRunSubpath` first (`:404-408`).
- Write path in the same file: `writeSafeRunFile` (`:428-457`) validates via `ensureSafeRunSubpath`, creates a random-suffix temp with `wx`, then `renameSync`. `writeSafeRunJson` delegates (`:459-461`).

### 3.2 `lib/export.mjs` — `readBounded`

- Function: `lib/export.mjs:144-172`.
- Flags: `O_RDONLY | (O_NOFOLLOW ?? 0)` (`:148`). **No `O_NONBLOCK`**, so the open can block on a FIFO before `fstat` refuses it.
- Pre-check: `lstatSync(file).isFile()` (`:147`). This is a separate check-then-open, so the final-component race is not fully atomic on platforms where `O_NOFOLLOW` is missing; on Linux `O_NOFOLLOW` covers the final symlink.
- Post-open type/size: `fstatSync` (`:149-151`).
- Result shape: `{ status: "ok"; text } | { status: "absent" } | { status: "oversize"; size; cap } | { status: "unreadable" }` (`lib/export.mjs:142-143`).
- Call sites: `:203`, `:232`, `:255`.
- No write path: the module is read-only (`lib/export.mjs:11-12`).

### 3.3 `lib/timeline.mjs` — `readBounded`

- Function: `lib/timeline.mjs:54-82`; byte-for-byte the same policy as `lib/export.mjs` (`:57-59`).
- Result shape: the same `ok | absent | oversize | unreadable` (`lib/timeline.mjs:48-53`).
- Call sites: `:136`, `:221`.
- No write path: the module is read-only (`lib/timeline.mjs:10-11`).

### 3.4 `plugins/opencode-teamwork/tools.ts` — readers and writers

- `readRunText` calls `readBoundedFileNoFollow` directly (`:988-990`), with no `ensureSafeRunSubpath`. Call sites include `join(run, "ORIGINAL_REQUEST.md")` (`:840`), `join(run, "pitfalls.md")` (`:995`), `readJson` (`:1109`), and `join(run, "prompt_draft.md")` (`:5308`).
- Duplicate containment helper: `ensureSafeRunSubpath` (`:1335-1361`) that throws instead of returning a result. It walks upward from the target and uses `realpathSync` on each existing ancestor; `tournament.ts:251-323` walks downward from the run and returns a result. They are similar in intent but not identical in behavior or error text.
- `refuseSymlink` (`:1042-1050`) is an `lstat`-only guard.
- `writeTextAtomicSafe` (`:182-197`) creates a random temp with `wx` and renames; it does **not** validate run containment. It is used by `writeSnapshots` (`:199-201`) and by `writeJson` (`:1118-1120`).
- `writeTextSafe` (`:1363-1370`) uses a **predictable** `<file>.tmp`, calls `refuseSymlink(tmp)`, then `writeFileSync` (not `wx`) and `renameSync`. This re-introduces the symlink-race class that `writeTextAtomicSafe` was written to avoid.
- `writeJsonSafe` (`:1372-1375`) calls `ensureSafeRunSubpath` and then `writeJson`, which goes to `writeTextAtomicSafe` — a second path-based write with no run containment after the initial check.

### 3.5 Divergences

| Aspect | `tournament.ts` | `lib/export.mjs` | `lib/timeline.mjs` | `tools.ts` |
|---|---|---|---|---|
| `O_NOFOLLOW` | yes, with explicit fallback | `?? 0` only | `?? 0` only | via `tournament.ts` reader |
| `O_NONBLOCK` | yes | no | no | via `tournament.ts` reader |
| Pre-open `lstat` | segment-wise + target | final only | final only | segment-wise for writes; none for direct `readRunText` reads |
| Post-open `fstat` | yes | yes | yes | via `tournament.ts` reader |
| Oversize status | `error` text | `oversize` + size/cap | `oversize` + size/cap | `undefined` (maps error to absent) |
| Result vocabulary | `ok/absent/error` | `ok/absent/oversize/unreadable` | same as export | `string \| undefined` |
| Containment check | `ensureSafeRunSubpath` | `runRootIsLink` + lexical | `runRootIsLink` + lexical | duplicate `ensureSafeRunSubpath` |
| Write path | random temp + `wx` + rename | none | none | predictable temp + non-`wx` (`writeTextSafe`), random temp (`writeTextAtomicSafe`) |

The divergence is not just duplication: the CLI readers are weaker on FIFOs and (on platforms without `O_NOFOLLOW`) on the final component, while `writeTextSafe` in `tools.ts` is weaker than the tournament writer. A shared module is an opportunity to make the weakest path match the strongest, not merely to deduplicate lines.

## 4. Option Analysis

### 4.1 Option (a): a `.mjs` helper in `lib/`

**What works**

- Node >=18 can import a `.mjs` from another `.mjs`; `lib/export.mjs` and `lib/timeline.mjs` are already plain ESM.
- TypeScript can statically import a `.mjs` file, and the import statement itself is erasable. Verified on the review host (Node v26.13.1) with a `.ts` file that does `import { hi } from "./helper.mjs"` and runs under plain `node consumer.ts` and `node --experimental-strip-types consumer.ts`.
- The OpenCode v2.3.2 loader accepts a static `.mjs` import from a `.ts` plugin entrypoint. An isolated-`HOME` probe (`opencode --standalone plugin list --print-logs`) loaded a plugin whose `index.ts` statically imports `./helper.mjs`; the loader registered `helper.mjs` as a plugin dependency and watched it. This is consistent with the existing `await import("../../lib/team.mjs")` in `plugins/opencode-teamwork/index.ts:199-205`.
- The npm `files` whitelist includes `lib` (`package.json:36`), so the published package would contain the helper.

**What breaks**

- The documented manual install (`README.md:188-193`) copies only `plugins/opencode-teamwork` into `$CFG/plugins/`. A static import in the plugin to `../../lib/safe-fs.mjs` would resolve to `$CFG/lib/safe-fs.mjs`, which is not copied. The plugin would fail to load in that supported layout. Unlike the existing optional dynamic import at `index.ts:199-205`, a static import cannot be wrapped in `try/catch` without making the read path async.
- A missing static import is likely to fail the plugin load rather than degrade gracefully, and the host probe showed that plugin load errors are not surfaced loudly by `plugin list`. A silent plugin disable is worse than a caught optional import.
- The three readers return different statuses. A shared `readBounded` would need adapters in every caller, so the module cannot be a drop-in replacement anyway.
- Type declarations are absent; a `.d.mts` would be needed for editor/typecheck use. There is no `tsc` in the current test chain, but the plugin is TypeScript and should stay ergonomic.

**Verdict:** rejected as stated. It works for npm/GitHub installs and fails the documented manual copy.

### 4.2 Option (a′): the same helper at `plugins/opencode-teamwork/safe-fs.mjs`

This is option (a) with one placement correction: move the shared module into the plugin directory, where it is copied by every install mode.

**What works**

- The manual copy (`README.md:188-193`) includes `safe-fs.mjs` automatically.
- The npm package includes `plugins` (`package.json:35`).
- The plugin's TypeScript imports it as `./safe-fs.mjs`; the host loader already resolves `.mjs` from the plugin (probe above).
- `lib/export.mjs` and `lib/timeline.mjs` import it as `../plugins/opencode-teamwork/safe-fs.mjs`; `bin/opencode-teamwork.mjs` inherits it through those modules. Node >=18 resolves it as plain ESM. The module is a leaf: it imports only `node:fs`, `node:path`, and `node:crypto`, never `lib` or another plugin file, so there is no cycle.
- Zero runtime dependencies; no `node_modules` import.
- One implementation, so the security policy cannot drift between the plugin and the CLI readers.
- A sibling `safe-fs.d.mts` can provide types without adding a build step; the Node loader ignores it, and the `files` whitelist includes it.

**What is less good**

- The dependency direction is `lib -> plugins/opencode-teamwork`, which inverts the usual "library supports the product" layering. It is acceptable only because `safe-fs.mjs` is a leaf and the package always ships both directories. Document the direction in the file header.
- The plugin directory gains a plain `.mjs` file alongside its `.ts` files. This is a small deviation from "plugin code is TypeScript", but the plugin already reaches into `lib/team.mjs` at runtime (`index.ts:199-205`), so `.mjs` is not a new runtime concept.
- A future change that copies only `lib` and `bin` (not documented today) would break the CLI readers. Add a packaging test or a comment in `package.json`/README.

**Verdict:** recommended. It is the only single-module option that satisfies npm, GitHub, and the documented manual install.

### 4.3 Option (b): duplicate the helper, add a cross-file comment and a shared conformance test

**What works**

- No packaging change, no new module boundary, no type-declaration work.
- Every install mode keeps working exactly as today.
- Each reader keeps its public result shape, so no caller churn.
- A conformance test can import all three implementations and assert normalized behavior on the same fixture matrix, catching most drift.

**What is less good**

- The security primitive is duplicated three times (and the `tools.ts` write helpers add a fourth write policy). A conformance test catches behavioral drift only for the cases it covers; a future edit that drops `O_NONBLOCK` in one copy can pass a test that never exercises a FIFO.
- The `tools.ts` `writeTextSafe` bug (predictable `.tmp`, non-`wx`) is exactly the kind of drift a shared module prevents. A test can catch it, but only after someone writes the test.
- The comments already say "intentionally not routed through tournament.ts" (`lib/export.mjs:14-18`, `lib/timeline.mjs:13-16`), so duplication is a deliberate current choice, not an accident.

**Verdict:** the correct fallback if the team rejects `lib -> plugins` layering or wants zero packaging risk. Not the first choice.

### 4.4 Option (c): code generation or test-only parity

**Code generation**

- Generate the helper block from one canonical source into `lib/` and `plugins/`.
- The package has no build step today; adding one means a contributor must run the generator, generated files must be committed, and a stale generated file can silently drift. It also complicates the "copy the plugin directory" install unless the generated file is checked in.
- Rejected for this package's size and zero-build philosophy.

**Test-only parity**

- This is a subset of option (b): a test asserts that the three readers agree on a normalized matrix. It does not prevent a new copy from being added, and it does not unify the write paths.
- Useful as a complement to either (a′) or (b), not as the primary answer.

**Verdict:** reject codegen; keep the parity test as part of the recommendation.

## 5. Recommendation

**Adopt option (a′): one low-level module at `plugins/opencode-teamwork/safe-fs.mjs`, imported by the plugin TypeScript and by `lib/*.mjs` (and therefore `bin`), with thin per-caller adapters and a new conformance test suite.**

### 5.1 Exact files

**New**

- `plugins/opencode-teamwork/safe-fs.mjs` — the single implementation. Leaf imports only:
  - `node:fs`: `closeSync`, `constants`, `fstatSync`, `lstatSync`, `openSync`, `readSync`, `realpathSync`, `renameSync`, `writeFileSync`.
  - `node:path`: `basename`, `isAbsolute`, `relative`, `resolve`, `dirname`.
  - `node:crypto`: `randomBytes` for the write temp suffix.
- `plugins/opencode-teamwork/safe-fs.d.mts` — type declarations for the TypeScript import. Type-only; no runtime effect.
- `scripts/test-safe-fs.mjs` — the conformance and race suite.

**Modified**

- `plugins/opencode-teamwork/tournament.ts`:
  - `readBoundedFileNoFollow` becomes a thin wrapper over `readRegularBounded` (same public result shape and messages).
  - `ensureSafeRunSubpath` returns `runReal` in addition to `path`; `readBoundedRunFile` then calls `readWithinBounded(runReal, path, maxBytes)`.
  - `writeSafeRunFile` / `writeSafeRunJson` delegate to `writeFileAtomicWithin`.
- `plugins/opencode-teamwork/tools.ts`:
  - `readRunText` continues to use the shared reader, but takes the run root (or a `{ root, file }` pair) and calls `readWithinBounded`; update the call sites at `:840`, `:995`, `:1109`, and `:5308`.
  - Replace `writeTextSafe` with `writeFileAtomicWithin` (or delete it and use `writeSafeRunFile`).
  - Replace `writeJsonSafe`'s `writeJson` path with `writeSafeRunJson`.
  - Keep `writeTextAtomicSafe` only for non-run files (snapshots), or have it delegate to `writeFileAtomic`.
  - Consider replacing the duplicate `ensureSafeRunSubpath` (`:1335-1361`) with the tournament helper in a separate change; the two have different error semantics, so tests must cover the change.
- `lib/export.mjs`: `readBounded` becomes a thin adapter over `readWithinBounded`, mapping `refused` to `unreadable` and preserving `oversize`. `buildExportData` resolves `runReal = realpathSync(runDir)` once after `runRootIsLink` and passes it down.
- `lib/timeline.mjs`: same adapter and the same once-per-run `runReal` resolution.
- `package.json`: add `"test:safe-fs": "node ./scripts/test-safe-fs.mjs"` and insert it into the `test` chain (`package.json:45-53`).
- `README.md`: add `safe-fs.mjs` to the architecture file list (`README.md:34-38`) and note the shared-primitive boundary. No install-step change is needed for (a′).
- `docs/GUARDRAILS.md` and `docs/ARTIFACTS.md`: update the reader/writer containment wording once ADR 0004's control is implemented.

### 5.2 Module API

Keep the module low-level and policy-free; callers own their public result shapes.

```ts
// proposed, type-level sketch only
export type BoundedRead =
  | { status: "ok"; text: string }
  | { status: "absent" }
  | { status: "oversize"; size: number; cap: number }
  | { status: "refused"; reason: "symlink" | "not-regular" | "containment" | "unreadable"; message: string };

export function readRegularBounded(file: string, maxBytes: number): BoundedRead;
export function readWithinBounded(runReal: string, file: string, maxBytes: number): BoundedRead;
export function fdWithin(runReal: string, fd: number): boolean;
export function writeFileAtomic(file: string, content: string): void;
export function writeFileAtomicWithin(run: string, target: string, content: string): void;
```

- `readRegularBounded` always uses `O_NOFOLLOW | O_NONBLOCK` when available and the explicit `lstat` fallback when not. It performs `fstat`, the regular-file check, the size check, the bounded read, and the fail-closed error mapping.
- `readWithinBounded` adds ADR 0004's post-open fd containment check where `/proc/self/fd` exists. It accepts a precomputed `runReal` so the caller does not re-resolve the root on every read. A bare `readRegularBounded(file, maxBytes)` call cannot enforce containment because it has no root; callers that need containment must use `readWithinBounded`.
- `fdWithin` is exported for the deterministic unit test in ADR 0004 §5.5.
- `writeFileAtomic` is the random-suffix `wx` + rename primitive. `writeFileAtomicWithin` adds `ensureSafeRunSubpath` and the run-directory mkdir. It does **not** claim to fix the write-path intermediate race; that remains an ADR 0004 follow-up.

### 5.3 Adapters

| Caller | Maps |
|---|---|
| `tournament.ts` `readBoundedFileNoFollow` | `ok` -> `ok`; `absent` -> `absent`; `oversize`/`refused` -> `{ status: "error", error: "refused: ..." }`, preserving the current `refused:` prefix and `basename` text where tests assert it. |
| `tournament.ts` `readBoundedRunFile` | Keeps `ensureSafeRunSubpath` and returns its error text unchanged. |
| `lib/export.mjs` / `lib/timeline.mjs` | `ok` -> `ok`; `absent` -> `absent`; `oversize` -> `oversize` with `size`/`cap`; `refused` -> `unreadable`. |
| `tools.ts` `readRunText` | `ok` -> text; everything else -> `undefined`. |

This preserves the public behavior of each caller while giving all three the same flags, bounds, and containment check.

## 6. Test Plan

### 6.1 New `scripts/test-safe-fs.mjs`

Run with plain Node, following the existing hermetic style (`scripts/test-export.mjs:1-30`, `scripts/test-timeline.mjs:1-38`): every fixture in its own `mkdtemp`, `HOME` and `XDG_*` pointed at empty temp dirs, no network.

Fixture matrix (one case per row; run through `readRegularBounded` for flags/bounds, `readWithinBounded` for containment, and each caller adapter):

1. Regular file under the cap -> `ok`, exact bytes.
2. Absent file -> `absent`.
3. Directory -> `refused` / `unreadable`.
4. Final symlink to an outside regular file -> `refused`; outside bytes never returned.
5. Static intermediate symlink (`run/sub -> outside`) -> `refused`; outside bytes never returned.
6. FIFO -> `refused`; completes under the 15-second child timeout (mirror `scripts/test-engine.mjs:4891-4939`).
7. File exactly at the cap -> `ok`.
8. File one byte over the cap -> `oversize` / error, with `size` and `cap`.
9. File that grows after `fstat` -> the `size + 1` read cap still bounds the result (the existing logic at `plugins/opencode-teamwork/tournament.ts:371-388`).
10. Unreadable file (`chmod 000`) -> `refused` / `unreadable`; skip when running as root.
11. Run root itself is a symlink -> refused before the read (the existing `ensureSafeRunSubpath` behavior).

Parity assertion: for each fixture, normalize the three callers' results to `ok | absent | oversize | refused` and assert they agree. This is the "shared conformance test" from option (b), retained even though code is shared, so a future adapter cannot silently diverge.

### 6.2 Race harness

Copy the harness from ADR 0004 §5.4 into `scripts/test-safe-fs.mjs`:

- Parent reads `run/sub/secret.json` in a tight loop (2,000 iterations, matching ADR 0004 §5.4) while a child swaps `run/sub` between a real directory and a symlink to `outside/`.
- Assert zero `SENTINEL` reads and at least one legitimate inside read.
- Include the test-only `vulnerableRead` negative control with a deliberate delay between `lstat` and `open`; assert the control observes a leak. This proves the harness detects the bug class.
- Run under a 15-second timeout. On non-Linux or when `/proc/self/fd` is absent, skip the fd-containment assertions with an explicit `SKIP:` line, but still run the static and FIFO cases.

### 6.3 Deterministic fd test

Use `fdWithin` from the shared module:

- Inside fd -> `true`.
- Outside fd -> `false`.
- Open inside, rename outside -> `false`.
- Open inside, unlink -> `false`.
- Open inside, rename the run directory, check against the old real path -> `false`.

### 6.4 Existing suites

- `scripts/test-engine.mjs`: keep the PR #10 FIFO test (`:4891-4939`) and the symlink/containment cases (`:3485-3577`). Add a static intermediate-symlink read case next to the existing tournament symlink cases.
- `scripts/test-export.mjs`: add a fixture where `pitfalls.md` or `events.jsonl` is an intermediate symlink; assert an `unreadable` diagnostic and no sentinel in HTML/Markdown.
- `scripts/test-timeline.mjs`: add a fixture where `events.jsonl` or `verify/` is an intermediate symlink; assert a warning/UNKNOWN and no sentinel. Add a FIFO-in-`events.jsonl` child-timeout test; it should fail against the current `lib` reader (no `O_NONBLOCK`) and pass after the shared module.
- `scripts/test-cost.mjs`, `scripts/test-doctor.mjs`, `scripts/lint-prompts.mjs`: no changes expected; run them to catch import-cycle or packaging regressions.

### 6.5 Gates

- `npm test` green, including the new `test:safe-fs`.
- `git diff package.json` adds only the test script and the `test` chain entry; no `dependencies`.
- `node --experimental-strip-types` (or the host's equivalent) loads `plugins/opencode-teamwork/index.ts` with the new `.mjs` static import. The isolated-host probe from §4.1 is the template; rerun it after implementation.
- A packaging smoke test: `npm pack --dry-run` lists `plugins/opencode-teamwork/safe-fs.mjs` and `safe-fs.d.mts`; `README.md`'s manual copy still works because the file is inside `plugins/opencode-teamwork`.
- Linux CI runs the race harness and fd tests; macOS/Windows skip only the `/proc`-dependent cases and still run static symlink/FIFO/oversize.

## 7. Risks and Open Questions

1. **Layering.** `lib -> plugins` is unusual. If the team considers that unacceptable, fall back to option (b), not to `lib/safe-fs.mjs`. Document the leaf-module rule: `safe-fs.mjs` must never import `lib`, `bin`, or another plugin file.
2. **Type declarations.** `safe-fs.d.mts` is a hand-maintained file. If it drifts from the `.mjs`, TypeScript users see the wrong API. Keep it small and add a type-only import test, or use JSDoc types in the `.mjs` and `// @ts-check`.
3. **Write-path containment is not solved.** The shared writer unifies atomicity and removes the predictable `.tmp` path, but a raced intermediate directory can still redirect a write. That needs the same component-wise primitive as ADR 0004; do not let the shared module imply a guarantee it does not provide.
4. **`ensureSafeRunSubpath` duplication.** `tools.ts:1335-1361` and `tournament.ts:251-323` differ in traversal direction and error semantics. Unifying them is a separate, test-heavy change; the shared module should not silently replace one with the other.
5. **Windows.** `O_NOFOLLOW`/`O_NONBLOCK` are unavailable; the shared module must keep the explicit `lstat` fallback from `tournament.ts:354-362`. The current `lib` readers use `?? 0` and would follow a symlink on Windows after the `lstat` pre-check; the shared module should standardize the fail-closed fallback.
6. **macOS.** No `/proc/self/fd`; ADR 0004's post-open check is unavailable. The shared module should still centralize the existing checks and document the residual.
7. **Performance.** One extra `realpathSync` per read in `readWithinBounded`; negligible for JSON-sized files. `readRegularBounded` itself is the same syscall count as today.

## 8. Recommendation Summary

**Use one leaf module at `plugins/opencode-teamwork/safe-fs.mjs`, imported by the plugin TypeScript and by `lib`/`bin`, with per-caller adapters and a new `scripts/test-safe-fs.mjs` conformance/race suite; reject a `lib/safe-fs.mjs` placement because the documented manual install copies only `plugins/opencode-teamwork`.** This is Proposed; no code has been changed.

## 9. References

- `plugins/opencode-teamwork/tournament.ts:347-402` — current plugin bounded reader.
- `plugins/opencode-teamwork/tournament.ts:404-408` — `readBoundedRunFile` pre-check-then-read.
- `plugins/opencode-teamwork/tournament.ts:428-457` — `writeSafeRunFile` random-temp/`wx`/rename.
- `plugins/opencode-teamwork/tools.ts:182-197` — `writeTextAtomicSafe`.
- `plugins/opencode-teamwork/tools.ts:988-990` — `readRunText`.
- `plugins/opencode-teamwork/tools.ts:1335-1361` — duplicate `ensureSafeRunSubpath`.
- `plugins/opencode-teamwork/tools.ts:1363-1375` — `writeTextSafe` / `writeJsonSafe`.
- `lib/export.mjs:14-18`, `:144-172` — independent CLI reader.
- `lib/timeline.mjs:13-16`, `:54-82` — independent CLI reader.
- `plugins/opencode-teamwork/index.ts:16-21` — zero-dependency/erasable-TS contract.
- `plugins/opencode-teamwork/index.ts:199-205` — existing dynamic `../../lib/team.mjs` import (optional, caught).
- `package.json:33-44` — `files` whitelist; `package.json:45-53` — test scripts.
- `README.md:188-193` — manual install copies only `plugins/opencode-teamwork`.
- `README.md:34-38` — architecture file list.
- `scripts/test-engine.mjs:4891-4939` — FIFO child-timeout pattern.
- `scripts/test-export.mjs:1-30`, `scripts/test-timeline.mjs:1-38` — hermetic test style.
- Runtime probe: Node v26.13.1; a `.ts` file can statically import `./helper.mjs` and run under plain Node and `--experimental-strip-types`. OpenCode v2.3.2, isolated `HOME`, `opencode --standalone plugin list --print-logs`: the loader resolved a static `.mjs` import from a `.ts` plugin entrypoint and registered the `.mjs` as a plugin dependency. This probe did not exercise the package's full `tools.ts` import graph, so rerun it after implementation.
