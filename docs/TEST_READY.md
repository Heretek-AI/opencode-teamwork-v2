# Test readiness — audit remediation and `agy` parity

Status: **READY** (2026-11-25)

The dual-track E2E suite described in [`TEST_INFRA.md`](TEST_INFRA.md) is green
on the 0.19.x branch line, on top of OpenCode 2.4.1. Counts below are labelled
by where they were recorded; the 0.19.x evidence is the last full local run.
The `runtime-l1` CI job installs the pinned `@opencode/cli@2.4.1` and requires
the process E2E to run (see the CI gates section below); the hosted Actions run
is the first execution evidence for that wiring.

## Last recorded run

| Layer | Command | Result |
| --- | --- | --- |
| L0 parity/regression | `npm run test:agy-parity` | **153/153** (T1 66, T2 65, T3 15, T4 7) |
| Runtime parity | `cd tests/runtime && bun test --timeout 30000 spec/agy-parity.test.ts` | **62/62**, 0 fail |
| Full runtime L1–L3 | `cd tests/runtime && bun test --timeout 30000` | local host with `opencode` 2.4.1 on `PATH`: **118 pass, 1 skip (L4 live), 0 fail**. Intended CI gate: same **118/1/0**, asserted by `runtime-l1` after installing `@opencode/cli@2.4.1`; a run without a usable host is 117 pass, 2 skip (process E2E, L4 live) and fails that gate |
| L0 repository suite | `npm test` | all L0 suites (17 at 0.19.2; the release-consistency self-test is one), exit 0 |
| Rust signer | `cargo test --manifest-path signer/Cargo.toml` | 5/5 |
| Packaging | `npm pack --dry-run` | 115 files on the 0.19.3 release line (unchanged from 0.19.2; `lib/oidc-fetch.mjs` and the two attestation-input scripts add three, and `scripts/check-release-consistency.mjs`, `scripts/test-release-consistency.mjs` and `docs/RELEASE-RUNBOOK.md` add three), 0 dependencies, no `tests/`, `docs/re/`, or `signer/`; the parity script ships with the other test scripts |

## CI gates added for the 0.19.2 release line

`ci.yml` keeps the gates distinct so a failure names the contract it broke:

| Check | What it runs | Why it is separate |
| --- | --- | --- |
| `test (22)`, `test (24)` | `npm test`, packaging whitelist guard | L0 engine/catalog/verifier suites on both supported Node versions |
| `runtime-l1` | `bun test --timeout 30000` after installing `@opencode/cli@2.4.1` | Full L1–L3 plus the real-host process E2E; asserts `118 pass, 1 skip, 0 fail` and requires the `[process-e2e]` marker |
| `l0-parity` | `node scripts/test-agy-parity.mjs` | 153-case parity/audit suite is not part of `npm test` |
| `pack-t4` | `node scripts/test-packed-tarball.mjs` after `bun install` in `tests/runtime` | Packed-tarball install and load; see the T4 boundary below |
| `release-consistency` | `node scripts/check-release-consistency.mjs` | Root/plugin version, changelog heading, `v<version>` on tag builds |
| `lint` | `node scripts/lint-prompts.mjs` | Prompt/agent contract |
| `containment (macos-latest)`, `containment (windows-latest)` | containment, approvals, signer/witness suites | Detective platform boundary |
| `signer` | `cargo test --manifest-path signer/Cargo.toml` | Reference signer |
| `Live Lean 4 + LEAP CLI (no Mathlib)` | live Lean 4 + LEAP CLI E2E | Formal-proof toolchain |

`host-drift.yml` is nightly and non-blocking. L4 live-model runs remain opt-in.

**T4 boundary.** A1 directory mode is the L1 package-load proof, and
`tests/runtime/e2e/packed-l2.test.ts` (registered only when
`TEAMWORK_PACKED_PACKAGE` is set) plans one L2 run through the installed tree.
A2/A3 still execute in memory mode against the working tree, and the L3
worktree/claim/verifier scenarios are not re-run from the tarball. T4 is
evidence about installability, entry loading, catalog/commands parity and one
plan flow, not proof that every L2/L3 scenario works from the published
artifact.

## What is covered

Every closed parity gap A1–A9 has at least one L0 case and one runtime spec:

- **A1** `[skip-interview]` parsing, empty-request prompt, `## Parameters`,
  unknown leading brackets, `requestHash` binding.
- **A2** pre-routing interview gate, behavioural Step 3, exact opt-in phrases,
  `The team must NOT:`.
- **A3** UTC-timestamped follow-up append via the documented minimal
  `teamwork_plan({ sessionId, followUp })` call, persisted-topology return,
  duplicate-last no-op, empty/oversize refusal, symlink refusal, signed
  manifest `requestHash` re-binding, post-victory staleness.
- **A4** small-focused multi-round loop (up to 32), `maxRounds` clamps
  (`0`→`1`, `33`→`32`), persistent open-issues ledger, report-derived feedback,
  two-audit cap (including an unsigned legacy re-plan that cannot change
  topology/verification and therefore cannot move the cap).
- **A5** two-scout survey stubs (`PROJECT.md`/`SCOPE.md`/`TEST_INFRA.md` created;
  `TEST_READY.md` not pre-seeded), dual-track readiness, `DEAD_ENDS.md`
  oscillation/regression guards (including a planted symlink that is never
  followed or replaced), integrity warning.
- **A6** `distributed-coding` strict default, explicit standard opt-out,
  reviewer/challenger/forensic-auditor wave line in `GATE_STATUS.md`,
  falsifier empirical shell with `edit` still denied.
- **A7** PDF `pypdfium2`/`Pillow` pre-flight, root `PREREQUISITES.md` recording
  the actual `MISSING`/`OUTAGE` status (a `READY` probe writes nothing),
  symlink refusal, `leap doctor --offline` (a `LEAN_PROJECT_DIR`-only failure is
  `WARN`, not a block), pre-`mkdir` refusal.
- **A8** three-phase `=== VICTORY AUDIT REPORT ===`, acceptance of a legacy
  non-3-phase summary (the prompt mandates the format; the engine stores it
  verbatim), terminal non-victory discipline, `worker.md` handoff fix.
- **A9** `OPENCODE_TEAMWORK_DISABLED`, system prompt protection in all 15
  agents, abort-time `interrupted.md` with a real `AbortSignal` (CANCELLED),
  planted-symlink target untouched, legacy `/team-*` clarity.

## Boundary

A green local suite is evidence about this host and these pinned dependency
versions. It is not a claim that a model read an artifact, that CI proves code
correctness, or that a same-UID writer is contained. Those boundaries are in
`SECURITY.md`, `docs/GUARDRAILS.md` and the ADRs.
