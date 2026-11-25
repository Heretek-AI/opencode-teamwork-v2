# Handoff: finish the opencode-teamwork-v2 audit, remediation & `agy` parity run

You are taking over a multi-agent run that stopped mid-flight (the previous orchestrator hit a model quota). **Use subagents** (the `task`/subagent tool) for the exploration, implementation, and verification work below. Keep your own context for coordination: dispatch, read handoffs, gate, commit.

- **Repo:** `/home/john/Projects/opencode-teamwork-v2`
- **Branch:** `feat/remediation-waves-1-4`. Stay on it. Do not merge to `main`, do not open a PR, and do not push unless the user asks.
- **Read first:** `AGENTS.md` in the repo root. It defines the hard contracts.
- **Previous run's scratch state (read-only reference):**
  `S=/home/john/.gemini/antigravity-cli/scratch/teamwork/95de31f5-8954-4fcb-8ef1-566a91cb8de5/.agents/teamwork`

## 1. Goal (approved task prompt, condensed)

1. Audit the repo with **fallow**, **Sonar**, and **GitHub code-scanning** (`gh api repos/Heretek-AI/opencode-teamwork-v2/code-scanning/alerts`).
2. Remove verified unused code and resolve the scanner findings.
3. Close behavioural parity gaps so the OpenCode v2 plugin behaves like `/home/john/.local/bin/agy`'s `teamwork` command across five surfaces:
   - CLI commands and flags
   - workflow stages
   - tool contracts
   - agent prompts and roles
   - state and artifacts
4. Deliver a structured summary (R4): findings by source, every remediation, tools that were unavailable, and items left unresolved.

**Acceptance criteria:**
- Every finding cites a file:line or symbol plus the tool output or observed `agy` behaviour behind it.
- Every closed parity gap has a reproducible test.
- After remediation, the audit tools are re-run.
- `npm test`, `npm run lint:prompts`, and all other repo checks pass with zero failures.
- An independent reviewer checks all five surfaces against a point-by-point rubric.

The integrity mode is `development`: fixes must be real. No stubs, no hard-coded test outputs, no weakened or skipped assertions, and no blanket `NOSONAR` comments.

## 2. Where things stand

### Survey: complete. Read these before dispatching anything.

| Artifact | What it holds |
| --- | --- |
| `$S/PROJECT.md` | **Master plan**: 21-item Feature Inventory, milestones M1–M5, interface contracts |
| `$S/teamwork_explorer_survey_1/audit_findings.md` and `baseline.md` | Findings from fallow, SonarCloud, and CodeQL, plus the baseline test results |
| `$S/teamwork_spec_miner_survey_2/parity_matrix.md` and `agy_inspection.md` | `agy` 1.5.17 parity gaps A1–A9, with evidence |
| `$S/TEST_INFRA.md` | Design of the E2E parity suite: 13 feature units, 4 test tiers, at least 152 cases |
| `$S/ORIGINAL_REQUEST.md` | The user's request verbatim, plus a follow-up note about the Sonar tooling |

**Baseline audit numbers:**
- **fallow:** 258 dead-code issues (149 unreferenced exports, 16 unused types, 5 duplicate exports).
- **SonarCloud API:** 1,050 open issues outside `docs/re` (55 bugs, 45 vulnerabilities, 950 code smells).
- **CodeQL:** 22 open alerts, 19 of them `js/file-system-race`.

### M1 (Security, CodeQL & Sonar bugs/vulnerabilities, items 1–7): implemented, gate nearly closed

- **Uncommitted change set:** 41 modified tracked files (+1207/−407).
- **Gate status:** see `$S/sub_orch_m1/GATE_STATUS.md`.
  - Worker: DONE.
  - Forensic Auditor: **CLEAN** (`$S/m1_auditor_1/handoff.md`).
  - Reviewer: **APPROVE** (`$S/m1_reviewer_1/handoff.md`).
  - Challenger (`$S/m1_challenger_1/progress.md`): probes 1–3 passed (SSRF 49/49, symlink/FIFO/TOCTOU, path traversal 16/16). **Probes 4–6 never finished:**
    - `resolveTrustedExecutable` (S4036)
    - Rule #7 and S3923 (`lib/security.mjs`, `lib/verify.mjs`)
    - locale-independent `.sort()` determinism (S2871)
- **Small issues the reviewers noted:**
  - `TRUSTED_BIN_NAME` in `safe-fs.mjs` accepts `.` and `..`. It is harmless, because directories are rejected later, but it should be tightened.
  - `openPinnedRoot(symlinkDir)` reports reason `run-not-directory` where `run-symlink` is expected.
  - `npm pack --dry-run` picks up the untracked `scripts/test-agy-parity.mjs`, because `scripts` is listed in `package.json` `files`. Decide whether that should ship (and exclude it if not).

### Parallel E2E track: drafted, untracked, held

- **New files:**
  - `scripts/test-agy-parity.mjs`: 152 L0 cases. `--milestone=M1` passes 44/44.
  - `tests/runtime/spec/agy-parity.test.ts`: 61 runtime specs, 29 passing. The 32 `[M3 A*]`/`[M4 A*]` specs fail **by design** until M3 and M4 land.
- Phase 2 (after M4) still needs to:
  - refine the assertions against the final contracts;
  - run a gate on the suite itself;
  - decide whether to wire `test:agy-parity` into `package.json`;
  - write `TEST_READY.md`.

### M2, M3, M4, M5: not started. Full scope is in `$S/PROJECT.md` items 8–21.

## 3. Hard contracts (from `AGENTS.md`; breaking any of these is a regression)

- **Zero runtime dependencies.** Root and `plugins/opencode-teamwork/package.json` keep `dependencies: {}`, and shipped code has no `@opencode/*` imports.
- **Exactly 26 `teamwork_*` tools,** each registered with `options: { namespace: "teamwork", codemode: false }`. Every input goes through `strictInput()`, and no result carries an `output` key without an output schema.
- **7 slash commands and 15 agents in `agents/team/*.md`.** `scripts/test-catalog.mjs` and L1 `a2-catalog` pin these counts and the prompt token references.
- **DB paths:** resolve `OPENCODE_DB` first, then `OPENCODE_CHANNEL`. Never hard-code `opencode.db` or `service.json`.
- **Identity:** use `context.agent` first, then `Session.Info.agent`. Forks have no `parentID`.
- **Security claims:** run `node scripts/lint-security-claims.mjs` after any doc change. No "tamper-proof"-style claims.
- **Packaging:** `npm pack --dry-run` must exclude `tests/`, `docs/re/`, and `signer/`.
- **Test defects:** if a test exposes a product defect, record it in `tests/runtime/FINDINGS.md`.
- **Changelog:** update `CHANGELOG.md` under `[Unreleased]`.

## 4. Work plan (run in order; each milestone gets its own verification gate)

For each milestone:
1. Dispatch **explorer** subagent(s) to map exact edit sites.
2. Dispatch **worker** subagent(s) to implement. Split by file ownership so no two workers edit the same file at once.
3. Dispatch a **verification wave** of at least two independent subagents, both of which run the suites themselves:
   - a **reviewer**, who reviews the diff and runs the suites;
   - a **challenger**, who writes adversarial and edge-case probes;
   - for M1 and M5, also a **forensic auditor**, who checks for stubs, weakened tests, and suppressions.
4. Only commit the milestone (one or more conventional commits, referencing the item numbers) once every verifier approves.

Never let two subagents run `tests/runtime` at the same time. They share the workspace and the SQLite/temp state.

### M1 close-out
1. Finish challenger probes 4–6 against the current diff.
2. Fix the three small issues listed above.
3. Re-run the full suite (section 5).
4. Commit M1.

### M2: dead code and duplication (`PROJECT.md` items 8–10)
- Consolidate the 5 fallow `duplicate_exports`:
  - `AUTH_ED25519`;
  - `RouteClassification` and `classifyRoute` across `document-review.ts`, `lemma.ts`, `tournament.ts`;
  - `clean`/`cleanBlock` in `lemma.ts` and `tournament.ts`.
- Un-export the verified zero-reference exports (149) and types (16). **Preserve** the following, and verify each one with `grep` or the knowledge graph before removing anything:
  - exports that tests import (the survey found 11);
  - cross-module references (27);
  - standalone script and harness entrypoints (4);
  - anything `scripts/test-*.mjs` imports.
- Optionally add a non-shipped `.fallowrc.json` that ignores `docs/re/` and declares the subprocess entrypoints.
- Reduce the top Sonar S3776 complexity hotspots only where you touch the code anyway.
- **Gate:** fallow re-run shows the targeted issues gone, plus the full suite passes.

### M3: parity part 1 (items 11–14 = gaps A1, A2, A3, A9 in `parity_matrix.md`)
- **A1:** handle a leading `[skip-interview]` in `/teamwork` and in `teamwork_plan`:
  - strip it from the task text;
  - report unknown leading brackets;
  - if the remaining request is empty, ask the user for it;
  - write a `## Parameters` section in `ORIGINAL_REQUEST.md`.
- **A2:** add an interview gate before routing (skipped when `[skip-interview]` is given). In `crafter.md`:
  - make Step 3 a behavioural multi-select (a)–(e), with a "from scratch" floor;
  - use Step 2's exact opt-in phrases;
  - include a `The team must NOT:` section.
- **A3:** append follow-up messages to `ORIGINAL_REQUEST.md` under UTC timestamp headers. Skip a message that duplicates the last one. Never change the initial request or the integrity mode.
- **A9:**
  - add an `OPENCODE_TEAMWORK_DISABLED` runtime toggle;
  - add a `# SYSTEM PROMPT PROTECTION` section to `agents/team/*.md`;
  - implement `interrupted.md` or align the docs with what exists (`ARTIFACTS.md:66`, `orchestrator.md:106`);
  - clarify the legacy `/team-*` commands **without** changing the 7-command/15-agent/26-tool contract.
- **Gate:** all `[M3 A*]` specs in both parity suites pass, plus the full suite and `lint:prompts`.

### M4: parity part 2 (items 15–19 = gaps A4–A8)
- **A4 (small-focused multi-round loop):**
  - remove the `maxRounds: 1` cap at `index.ts:58` (allow up to 32, or make it configurable);
  - carry an open-issues ledger across rounds;
  - allow at most 2 victory audits, then stop at a terminal state.
- **A5 (distributed-coding survey and tracking):**
  - 2-scout survey;
  - `PROJECT.md`/`SCOPE.md` feature-inventory cross-check;
  - dual-track E2E via `TEST_INFRA.md`/`TEST_READY.md`;
  - `DEAD_ENDS.md` oscillation guard that triggers after 2 identical consecutive failures;
  - the verbatim worker integrity warning.
- **A6 (verification wave):**
  - make the verification wave reviewer + challenger + forensic auditor, recorded in `GATE_STATUS.md`;
  - close the `team/falsifier` gap (it cannot empirically execute because `shell` is denied) **safely**.
- **A7 (prerequisite pre-flights):**
  - probe for `pypdfium2` and `Pillow` before PDF document review;
  - write `PREREQUISITES.md` when a dependency is MISSING;
  - add a `leap doctor` check to `teamwork_lemma_probe`.
- **A8 (victory audit and stop discipline):**
  - give `victory-auditor.md` the 3-phase `=== VICTORY AUDIT REPORT ===` format;
  - in `sentinel.md`, distinguish a mid-run pause from a terminal non-victory stop;
  - fix the `worker.md:87` contradiction between `handoff.md` and `teamwork_handoff`.
- **Gate:** all `[M4 A*]` specs pass, plus the full suite.

### E2E Phase 2 (after M4)
1. Finalize `scripts/test-agy-parity.mjs` and `tests/runtime/spec/agy-parity.test.ts`. Assert on tool results and artifacts, never on model prose.
2. Run a reviewer/challenger gate on the suite itself.
3. Wire in `npm run test:agy-parity`, and exclude the file from the npm tarball if it should not ship.
4. Write `TEST_READY.md` in the repo or under `docs/`.

### M5: final re-audit and R4 summary (item 21)
1. Re-run every audit source and diff against the baseline:
   - fallow;
   - Sonar (see section 6);
   - `gh api` code-scanning (alerts only flip to Fixed after a push and a CI run; say so in the report).
2. Run the full suite (section 5).
3. Have an **independent reviewer subagent** fill a point-by-point rubric covering all five `agy` surfaces.
4. Write the R4 summary as a Markdown report, for example `docs/AUDIT-REMEDIATION-2026-11.md`. Make sure it passes `lint-security-claims`. It must cover:
   - findings by source, each with evidence;
   - every remediation;
   - tools that were unavailable (with the exact command and error);
   - items left unresolved, with reasons.

## 5. Verification commands (all must exit 0 before any milestone commit)

```sh
cd /home/john/Projects/opencode-teamwork-v2
npm test                                   # 15 L0 suites, including lint:prompts and lint:security
node scripts/lint-security-claims.mjs
npm pack --dry-run                         # 0 deps; tests/, docs/re/, signer/ excluded
cargo test --manifest-path signer/Cargo.toml
node scripts/test-agy-parity.mjs           # use --milestone=M1|M3|M4 during progressive work
(cd tests/runtime && bun install --frozen-lockfile --ignore-scripts && bun run test)
# Before M3 and M4 land, parity specs can be filtered, for example:
(cd tests/runtime && bun test --timeout 30000 spec/agy-parity.test.ts -t '\[M1')
```

Baseline before this run: L1–L3 had 52 pass, 1 skip (L4 live), 0 fail. Rust: 5/5.

## 6. Tooling notes

- **fallow:** installed. Run it from the repo root.
- **Sonar:**
  - `sonar analyze` works for secrets scanning (it found none), but Vortex analysis reports "not available on this connection" and skips every file.
  - `sonar-scanner` is installed but fails with `Could not find 'java'`, even though `java` is on `PATH`. Try `export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(which java)")")")"` and re-run.
  - If the scanner still cannot run, fall back to the SonarCloud web API, which the survey used.
  - Record the exact command and error in the R4 report.
- **GitHub:** `gh` is authenticated. Fetch alerts with `gh api repos/Heretek-AI/opencode-teamwork-v2/code-scanning/alerts --paginate`.
- **`agy` reference:** `/home/john/.local/bin/agy` (version 1.5.17). Treat it as an opaque box. Its observed behaviour is already captured in `parity_matrix.md` and `agy_inspection.md`, so re-probe only to settle a disputed gap.
- **OpenCode v2 host source:** `/home/john/Projects/opencode`, pinned at 2.4.1. Use it to look up host behaviour only. Never import from it.

## 7. Final report to the user

When everything is done, give a short summary covering:
- the commits made, one line each;
- before/after counts for fallow, Sonar, and CodeQL (noting which numbers are pending a push to CI);
- which parity gaps A1–A9 are closed and the tests that prove each one;
- the path of the R4 report;
- any remaining items.
