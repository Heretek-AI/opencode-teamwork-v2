# E2E test infrastructure — audit regression and `agy` parity

This document describes the reproducible regression suite that covers the audit
remediation (M1, M2) and the behavioural parity gaps A1–A9 against the observed
`agy` 1.5.17 `teamwork` command. It is the dual-track companion to `TEST_READY.md`.

## Test philosophy

- **Opaque-box and requirement-driven.** Assertions go on CLI exit codes,
  `teamwork_*` tool results, OpenCode 2.4.1 host state, permission decisions and
  on-disk artifacts. They never assert on model prose.
- **Artifacts are the evidence.** `ORIGINAL_REQUEST.md`, `plan.dag.json`,
  `state.json`, `run.manifest.json`, `verify/*`, `GATE_STATUS.md`,
  `DEAD_ENDS.md`, `PREREQUISITES.md`, `interrupted.md`, `TEST_INFRA.md` and
  `TEST_READY.md` are inspected directly.
- **Hermetic.** Each case uses its own `mkdtemp` sandbox (or a fresh OpenCode
  memory host) and cleans up in `finally`.
- **Progressive gates during development.** Cases are tagged `[M1]`, `[M3]`
  and `[M4]` so a milestone can be verified without waiting for the next one.
  The final suite runs all of them; nothing is skipped.
- **Integrity.** No hard-coded expected test results, no weakened assertions,
  no blanket suppressions. A test that exposes a product defect is recorded in
  `tests/runtime/FINDINGS.md` and fixed on a separate branch.

## Feature inventory (13 units, 5 surfaces)

| Unit | Surfaces | Source |
| --- | --- | --- |
| M1.1 `dbPathFor` / `OPENCODE_DB` / `OPENCODE_CHANNEL` | CLI, state | `AGENTS.md` Rule #7 |
| M1.2 `S3923` normalisations | CLI, state | SonarCloud |
| M1.3 approval-driver `runId` allowlist | CLI, state | SonarCloud S8707 |
| M1.4 `service*.json` loopback URL validation | tools, state | CodeQL #61/#62 |
| A1 leading `[skip-interview]`, `## Parameters` | CLI, workflow, tools, state | parity matrix A1 |
| A2 interview gate and behavioural integrity mode | workflow, agents, state | parity matrix A2 |
| A3 follow-up append to `ORIGINAL_REQUEST.md` | workflow, tools, state | parity matrix A3 |
| A4 small-focused loop, ledger, 2-audit cap | workflow, tools, agents, state | parity matrix A4 |
| A5 survey, feature inventory, dual-track E2E, `DEAD_ENDS.md` | workflow, agents, state | parity matrix A5 |
| A6 verification wave and empirical challenger | workflow, tools, agents, state | parity matrix A6 |
| A7 PDF/LEMMA prerequisites and `PREREQUISITES.md` | workflow, tools, state | parity matrix A7 |
| A8 victory audit format and terminal discipline | workflow, tools, agents, state | parity matrix A8 |
| A9 runtime toggle, prompt protection, `interrupted.md`, v1 alignment | CLI, tools, agents, state | parity matrix A9 |

## Layers

1. **L0 — `scripts/test-agy-parity.mjs` (153 cases).**
   Zero-dependency Node ESM. Exercises the CLI, plugin registration, tool
   contracts, prompt text, artifact shapes, filesystem containment and the
   security regressions. Run with `npm run test:agy-parity`; filter with
   `--milestone=M1|M3|M4` and `--tier=T1|T2|T3|T4`.
   Tiers: T1 feature coverage (66), T2 boundary/corner (65), T3 pairwise (15),
   T4 real-world scenarios (7).
2. **L1–L3 — `tests/runtime/spec/agy-parity.test.ts` (62 specs).**
   Runs the plugin inside the real OpenCode 2.4.1 runtime with real git
   worktrees, SQLite KV, command dispatch and permission hooks. Run with:
   `cd tests/runtime && bun test --timeout 30000 spec/agy-parity.test.ts`.
3. **Full runtime suite.** `cd tests/runtime && bun test --timeout 30000`
   includes the parity specs plus the pre-existing L1–L3 contract suite.
   The L4 live-model suite remains opt-in (`TEAMWORK_LIVE=1`).

## Coverage thresholds

- T1 ≥ 5 cases per feature unit (66 total).
- T2 ≥ 5 cases per feature unit (65 total).
- T3 ≥ 13 pairwise interactions (15 total).
- T4 ≥ 7 end-to-end scenarios (7 total).
- Total L0 ≥ 153 cases; runtime parity = 62 specs.

## Commands

```sh
npm test                     # the 15 repository L0 suites
npm run test:agy-parity      # the 153-case parity/regression suite
cd tests/runtime
bun test --timeout 30000     # L1-L3 including the 62 parity specs
```

## Scope boundary

The suite proves the recorded contracts and the observed local behaviour. It
does not prove that a future OpenCode host, a model, or a remote CI scanner will
behave identically; `docs/OPENCODE-COMPATIBILITY.md` and the host-drift job own
that boundary.
