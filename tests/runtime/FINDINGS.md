# L2 findings

**No genuine plugin defects were found.** All 24 L2 scenarios pass against the
real plugin on OpenCode 2.4.1 without changing plugin code, so no spec is
skipped.

The three notes below are behaviour the specs had to interpret or route around.
They are recorded here so a later reader does not mistake them for missing
coverage or for a silently weakened assertion.

## 1. Structured tool results are invisible after runtime normalization

**Observed.** No Teamwork tool declares an output schema. The 2.4.1 snapshot
executor keeps only `content` and drops the plugin's other keys
(`plugins/opencode-teamwork/tools.ts` returns `status`, `fence`, `token`,
`report`, ...; `packages/core/src/tool/runtime.ts` returns `{output: undefined,
content}` when no output schema is declared). L1 A8 already records this at the
result-shape level.

**How L2 handles it.** `harness/run.ts` executes the tool object the host
registered (`rawExecute`) when a spec needs the plugin's structured result, and
adds `executeViaRuntime` for representative calls (B1 no-spec plan, B9 route)
that cross the snapshot executor. Both paths use the host's real location tool
service and the same registered executors; no plugin code or tool schema is
changed.

## 2. "A second root Sentinel" cannot reach a run-bound tool

**Observed.** The control plane requires the caller to be the run's recorded
root session or a strict descendant (`authorize.ts`, `requireDescendantSession`).
A second, unrelated root session is refused before `next` or `task_update` can
run at all:

```text
refused: next must be called from the run root or a session that descends from
the run root (<root>); session <other> has no parent, so it does not descend from
<root> (fail closed); nothing was written
```

**How L2 handles it.** C11 asserts that unrelated-root refusal, then exercises
the reachable contention case: two Sentinel sessions created under the run root.
The first claims; the second gets no `readyForWorker` entry and its update is
`CLAIM_OWNED_BY_OTHER`. This is the same claim-ownership rule the literal spec
describes, with a caller the authorization layer can actually admit.

## 3. `teamwork_wave_record` refuses `cites: []` at write time

**Observed.** The writer refuses an explicitly empty cite list:

```text
refused: cites is present but empty; a strict verdict must cite at least one
verify/ artifact it reviewed; nothing was written
```

The strict gate, however, distinguishes a pre-existing artifact with
`cites: []` ("unbound") from one with no `cites` key at all
(`legacy_unbound_wave`), because those files can predate 0.12.0.

**How L2 handles it.** D18b asserts the write-time refusal, then writes the
empty-cites artifact directly (the same fixture technique
`scripts/test-engine.mjs` uses) and asserts the gate reports "cites is empty; the
verdict is unbound". D18c writes an artifact with no `cites` key and asserts
`verify/final.json` carries the `legacy_unbound_wave` warning. The gate is the
real tool; only the on-disk artifact is hand-built, as in the engine suite.
