# Test readiness — audit remediation and `agy` parity

Status: **READY** (2026-11-25)

The dual-track E2E suite described in [`TEST_INFRA.md`](TEST_INFRA.md) is green
on the 0.19.x branch line, on top of OpenCode 2.4.1. Counts below are labelled
by where they were recorded; the 0.19.x evidence is the last full local run,
and CI runs the same suite without an `opencode` binary on `PATH`.

## Last recorded run

| Layer | Command | Result |
| --- | --- | --- |
| L0 parity/regression | `npm run test:agy-parity` | **153/153** (T1 66, T2 65, T3 15, T4 7) |
| Runtime parity | `cd tests/runtime && bun test --timeout 30000 spec/agy-parity.test.ts` | **62/62**, 0 fail |
| Full runtime L1–L3 | `cd tests/runtime && bun test --timeout 30000` | **CI: 113 pass, 2 skip (process E2E when `opencode` is absent, L4 live), 0 fail**; local host with `opencode` on `PATH`: 114 pass, 1 skip (L4 live), 0 fail |
| L0 repository suite | `npm test` | all L0 suites (15 at 0.19.1; the 0.19.2 attestation-input check adds one), exit 0 |
| Rust signer | `cargo test --manifest-path signer/Cargo.toml` | 5/5 |
| Packaging | `npm pack --dry-run` | 110 files on the 0.19.2 release line (the URL/L4 `lib/oidc-fetch.mjs` adds one), 0 dependencies, no `tests/`, `docs/re/`, or `signer/`; the parity script ships with the other test scripts |

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
