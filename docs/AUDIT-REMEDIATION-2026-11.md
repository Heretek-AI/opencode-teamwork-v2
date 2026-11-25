# Audit, remediation and `agy` parity — November 2026

- **Repository:** `Heretek-AI/opencode-teamwork-v2`
- **Branch:** `feat/remediation-waves-1-4`, merged into `main` at `884744e` and pushed
- **Base for the audit:** `main` @ `efb5232ca` (last scanner analysis before the branch)
- **Host contract:** OpenCode 2.4.1, zero runtime dependencies
- **Reference behaviour:** `/home/john/.local/bin/agy` 1.5.17, `teamwork` command
- **Integrity mode:** `development`
- **Date:** 2026-11-25

This report covers the four requested outputs: findings by source with
evidence, every remediation, the tools or endpoints that were unavailable, and
the items left unresolved. It also records the independent five-surface rubric.

## 1. Method

| Source | How it was run | Scope |
| --- | --- | --- |
| fallow 3.48.0 | `fallow dead-code --no-cache --format json`, `fallow dupes`, `fallow health` | whole repo; `docs/re/` is a reverse-engineering corpus that never ships |
| SonarCloud | `sonar api` against `Heretek-AI_opencode-teamwork-v2`; `sonar analyze secrets .`; `sonar-scanner` probe | `main` @ `efb5232ca`, plus the local secrets scan |
| GitHub code scanning | `gh api repos/Heretek-AI/opencode-teamwork-v2/code-scanning/alerts --paginate` | CodeQL 2.27.5 on `refs/heads/main` @ `efb5232ca` |
| `agy` parity | live command output, binary inspection, and the local `docs/re/antigravity-teamwork/` corpus | `agy` 1.5.17 |
| Repository gates | `npm test`, `tests/runtime`, `cargo test`, `npm pack --dry-run`, lints | this branch |

The audit is **source-grounded**: each finding below names a file and line or a
symbol, and the tool output or observed `agy` behaviour that produced it.

## 2. Baseline and final counts

| Source | Baseline | After remediation (local) | Remote state |
| --- | ---: | ---: | --- |
| fallow dead-code | **255** issues: 18 unused files, 214 unused exports, 15 unused types, 5 duplicate exports, 1 unresolved import, 2 unlisted deps | **0** issues (exit 0) | n/a (local tool) |
| SonarCloud open issues | **1,234** total; **1,050** outside `docs/re` (55 bugs, 45 vulnerabilities, 950 code smells) | Target bugs/vulnerabilities and the dead-code/duplication findings are fixed; the secrets scan is clean. The 0.19.1 PR analysis is gate-OK with **0 new bugs/vulnerabilities** | `main` @ `7e0de63` (0.19.1): **1,292 open** (7 bugs, 5 vulnerabilities, 1,280 smells); **all 12 bugs/vulnerabilities are in `docs/re/`**, **0 outside**. The nine #49 findings are fixed or line-suppressed |
| GitHub code scanning | **44** alerts: 22 open, 14 fixed, 8 dismissed. Open: 19 `js/file-system-race`, 2 `js/file-access-to-http`, 1 `actions/unpinned-tag` | All 22 are fixed, plus the 3 new alerts introduced by the merge (`#66-68`); 0 new alerts in 0.19.1 | **52 alerts: 0 open, 43 fixed, 9 dismissed** after the 0.19.1 analysis. The 0.19.1 addition is a deterministic test-fixture nonce in `signer/tests/spec_28.rs`, dismissed as used in tests |
| Runtime gates | 52 pass, 1 skip (L4 live), 0 fail | 114 pass, 1 skip (L4 live), 0 fail | local |
| Rust signer | 5/5 | 5/5 | local |
| Packaging | 103 files, 0 deps | 109 files, 0 deps (the parity script and `url-guard.mjs` + `.d.mts` ship); no `tests/`, `docs/re/`, or `signer/` | local |

The local-vs-remote distinction is deliberate: local gates and the actual
remote `main` analyses are recorded separately.

## 3. Findings by source

### 3.1 fallow (255 → 0)

**Duplicate exports (5).**

| Export | Baseline locations | Resolution |
| --- | --- | --- |
| `AUTH_ED25519` | `plugins/opencode-teamwork/approval-format.mjs:41`, `auth.ts:69` | one canonical definition in `approval-format.mjs`; `auth.ts` imports it |
| `RouteClassification` | `document-review.ts:58`, `lemma.ts:105` | renamed `DocumentRouteClassification` / `LemmaRouteClassification` |
| `classifyRoute` | `document-review.ts:902`, `lemma.ts:611`, `tournament.ts:698` | renamed `classifyDocumentRoute` / `classifyLemmaRoute` / `classifyTournamentRoute`; every caller updated |
| `clean` | `lemma.ts:129`, `tournament.ts:205` | one implementation in `plugins/opencode-teamwork/text-utils.ts` |
| `cleanBlock` | `lemma.ts:135`, `tournament.ts:214` | same shared implementation |

**Unused exports and types (214 + 15 → 0).** 219 declarations lost their
`export` keyword after a word-boundary reference check across `plugins/`,
`lib/`, `bin/`, `scripts/` and `tests/`; the 29 declarations that were then
dead private code and the imports they orphaned were removed. The remaining 11
exports are named, exact exemptions in the non-shipped `.fallowrc.json`:
three dynamic test consumers (`readDraftDigest`, `buildApprovalRequest`,
`writeApprovalAtomically`), two static test seams
(`setRequirePinnedWritesForTest`, `nextEventSeqFromFd`), one documented id
contract (`LEMMA_ID`), and five documented storage/env constants
(`KEY_RING_STORAGE_KEY`, `ENV_KEY`, `ENV_KEY_ID`, `ENV_ED25519_KEY_ID`,
`ALLOW_LOCALHOST_ENV`). There is no `"*"` suppression.

**Unused files (18 → 0).** 13 are the never-shipped `docs/re/` corpus. The
other five are real subprocess/harness entry points, declared in
`.fallowrc.json`: `scripts/approval-driver.mjs`, `scripts/test-nfs.mjs`,
`scripts/test-agy-parity.mjs`, `tests/runtime/harness/preload.ts` and
`tests/runtime/harness/race-child.ts`. `bin/opencode-teamwork.mjs` and
`postinstall.mjs` are also declared for clarity.

**Unresolved import and unlisted dependencies (1 + 2 → 0).** The
`/preload.js` specifier and `sidecar_sdk` exist only inside `docs/re/`;
`@opencode/client` is a dev/test-only dynamic import in `tests/runtime` and is
declared in `ignoreDependencies`.

### 3.2 SonarCloud

The API reported 1,234 open issues on `main` @ `efb5232ca`. Excluding the
never-shipped `docs/re/` corpus: 1,050 issues (55 bugs, 45 vulnerabilities, 950
code smells).

**Bugs fixed.**

| Rule | Location | Fix |
| --- | --- | --- |
| `S3923` | `lib/security.mjs:118` | `normalizeGroupNames` now maps numbers and strings without an identical-branch ternary; `null`/`undefined` are skipped |
| `S3923` | `lib/verify.mjs:1673` | handoff mode simplifies to `raw === "required" ? "required" : "skip"` (the legacy-compatible fallback is documented) |

**Vulnerabilities fixed.**

| Rule | Evidence | Fix |
| --- | --- | --- |
| `S8707` (path traversal) | `scripts/approval-driver.mjs:103-106` joined `input.runId` into the run path | `SESSION_ID` allowlist and `relative()` containment before any disk access |
| `S5443` (publicly writable tmp) | `tests/runtime/harness/project.ts:81` | `TMPDIR` created with mode `0o700` and a targeted, justified suppression comment |
| `S7637` / `S6505` / `S8543` | `.github/workflows/ci.yml:20,26`; `publish.yml:66` | `oven-sh/setup-bun` pinned to a full commit SHA; `--ignore-scripts` on installs; npm install pinned |
| `S2871` (locale-dependent sort) | 38 reported sites plus later finds | explicit code-unit comparators everywhere; `canonicalAxiomSet` proved byte-identical under `C`, `en_US`, `tr_TR` and `de_DE` |
| `S1244` (float equality) | tests | tolerance-based assertions |
| `S5332` (http URLs) | test fixtures | https fixtures or documented localhost exceptions |
| `S4036` (PATH lookup) | shipped code | one `resolveTrustedExecutable` resolver; 0777/relative/foreign-owner PATH entries refused; `lemma.ts` toolchain probes now use it with `fallbackToStandard: false` |

After 0.19.1, `main` @ `7e0de63` reports **1,292** open issues (7 bugs, 5
vulnerabilities, 1,280 code smells); all 12 bugs/vulnerabilities are in the
never-shipped `docs/re/` corpus, 0 outside.

**Code smells.** The dead-code and duplicate findings above are the targeted
M2 smells. The remaining large family is cognitive complexity (`S3776`, 106
TypeScript + 81 JavaScript occurrences across the whole project, including
`docs/re`) and other style rules. Those were not mass-refactored: a wholesale
complexity rewrite would be a separate, higher-risk change and is recorded as
unresolved in §7.

### 3.3 GitHub code scanning / CodeQL

44 alerts total, 22 open on `main` @ `efb5232ca`:

| Alert(s) | Rule | File | Fix |
| --- | --- | --- | --- |
| 43-60, 64-65 (19) | `js/file-system-race` | `lib/security.mjs`, `lib/verify.mjs`, `lib/approve.mjs`, `bin/opencode-teamwork.mjs`, `tools.ts`, `locks.ts`, `safe-fs.mjs`, test/harness files | fd-pinned `open(O_NOFOLLOW)` + `fstat` + bounded fd read/write, or `readBounded*`/`readWithinBounded`; the check-then-use window is removed rather than annotated |
| 61-62 (2) | `js/file-access-to-http` | `tools.ts:435-436` | `parseLoopbackServiceUrl` validates scheme, host, port, credentials, path/query/fragment and reconstructs a clean loopback origin; `safeFetch(..., { loopbackOnly: true })` never follows redirects |
| 63 (1) | `actions/unpinned-tag` | `.github/workflows/ci.yml:20` | `oven-sh/setup-bun` pinned to a full commit SHA |

There are no new `NOSONAR`/`codeql[...]` suppressions in the remediation. The
local CodeQL result cannot be observed; the alert state changes only after a
push and a scan of this branch.

### 3.4 `agy` parity findings (A1-A9)

The full matrix, with observed behaviour and local source locations, is in the
survey artifact `parity_matrix.md`. The gap closure is summarized here; the
proof column names the reproducible tests.

| Gap | Observed `agy` behaviour | Local change | Proof |
| --- | --- | --- | --- |
| **A1** leading `[skip-interview]` | strips the bracket, records it in `ORIGINAL_REQUEST.md ## Parameters`, reports unlisted leading brackets, asks on an empty request | `parseTeamworkLaunch` in `tools.ts`; `/teamwork` command + `teamwork_plan`; `## Parameters` before `## Request`; empty-command prompt | L0 `A1-T1-01..05`, `A1-T2-01..05`; runtime `[M3 A1]` (5) |
| **A2** interview gate | blocks routing until the interview/spec, behavioural `(a)-(e)` Step 3, exact opt-in phrases | `/teamwork` template gate; `sentinel.md` interview gate; `crafter.md` Step 2/3 + mapping + `The team must NOT:` | L0 `A2-T1-01..05`, `A2-T2-01..05`; runtime `[M3 A2]` (5) |
| **A3** follow-up append | appends user/parent messages under UTC headers without changing the initial request or mode | `teamwork_plan({ followUp })`; duplicate-last no-op; empty/oversize refusal; manifest `requestHash` re-bound/re-signed | L0 `A3-T1-01..05`, `A3-T2-05`, PAIR-02/04; runtime `[M3 A3]` |
| **A4** small-focused loop | up to 32 refinement rounds over an open-issues ledger, at most 2 victory audits | `maxRounds` clamp 1..32; report-derived feedback; signed `auditCount` cap (small-focused only) | L0 `A4-T1-01..05`, `A4-T2-01..05`, PAIR-05/06; runtime `[M4 A4]`, `[T3 A4]` |
| **A5** survey/tracking | two scouts, Feature Inventory, dual-track E2E, `DEAD_ENDS.md` oscillation guard | 2-scout prompt, `PROJECT/SCOPE/TEST_INFRA` create-only stubs, failure signatures, `DEAD_ENDS.md`, integrity warning | L0 `A5-T1-01..05`, `A5-T2-01..05`, PAIR-06; runtime `[M4 A5]`, `[T4.3]` |
| **A6** verification wave | default Reviewer + Challenger + Forensic Auditor; empirical challenger | distributed-coding strict default; GATE_STATUS wave line; falsifier shell allow/edit deny | L0 `A6-T1-01..05`, `A6-T2-01..05`, PAIR-07/08; runtime `[M4 A6]`, `[T3 A5xA6]` |
| **A7** prerequisites | probes `pypdfium2`/`Pillow` before PDF work, writes `PREREQUISITES.md`, `leap doctor` | trusted `python3` PDF ingest; root `PREREQUISITES.md` on MISSING/OUTAGE; `leap doctor` status | L0 `A7-T1-01..05`, `A7-T2-01..05`, PAIR-09/10/15; runtime `[M4 A7]`, `[T4.4/4.5]` |
| **A8** victory audit | three-phase `=== VICTORY AUDIT REPORT ===`, pause vs terminal non-victory | `victory-auditor.md` 3-phase mandate; `sentinel.md` pause/terminal rules; `worker.md` handoff fix; 2-audit cap | L0 `A8-T1-01..05`, `A8-T2-01..05`, PAIR-14; runtime `[M4 A8]` |
| **A9** toggle/protection/interrupted | feature disable, prompt protection, `interrupted.md`, legacy command clarity | `OPENCODE_TEAMWORK_DISABLED` early return; protection block in all 15 agents; abort-time `interrupted.md`; legacy descriptions | L0 `A9-T1-01..05`, `A9-T2-01..05`, E2E-07; runtime `[M3 A9]` |

## 4. Remediation ledger

| Milestone | Items | What changed |
| --- | --- | --- |
| M1 | 1-7 | Rule #7 DB resolution, `S3923`, 19 race sites, 2 file-access-to-http sinks, CI pins, `S8707`/`S5443`, `S2871`/`S1244`/`S5332`/`S4036`; `lemma.ts` toolchain probes moved to the trusted resolver; unreadable group files now report `unknown` |
| M2 | 8-10 | 5 duplicate exports consolidated/renamed, 219 un-exports, 29 dead private names removed, scoped `.fallowrc.json`, fallow 255 → 0 |
| M3 | 11-14 | A1 bracket parsing/Parameters, A2 interview gate and behavioural integrity mode, A3 follow-up append/re-sign, A9 toggle/protection/interrupted/legacy |
| M4 | 15-19 | A4 loop/ledger/audit cap, A5 survey/stubs/DEAD_ENDS, A6 strict default/wave/empirical challenger, A7 PDF/LEMMA prerequisites, A8 victory format/terminal discipline |
| E2E | 20 | 152 L0 cases + 61 runtime specs, `npm run test:agy-parity`, `docs/TEST_INFRA.md`, `docs/TEST_READY.md` |
| M5 | 21 | this report, final re-audit, five-surface rubric, full suite |

### Post-merge follow-ups

- The first `main` CI run exposed a test-only inode-reuse assumption in
  `scripts/test-safe-fs-write.mjs`; it was fixed in `34cc451` (the product
  already refused the same-inode byte change) and the rerun is green.
- The merge introduced three new CodeQL alerts; `c770dd8` fixes the survey
  markdown escaping, the lock-owner read and the parity fixture write. CodeQL
  now reports **0 open**.
- The parity script is shipped with the other test scripts so the published
  `test:agy-parity` entry is valid (108-file tarball).
- Residual work is tracked in #49 (9 Sonar bugs/vulnerabilities outside
  `docs/re`), #50 (LEMMA live-toolchain CI), #51 (document-review visual audit)
  and #52 (per-dispatch model override).

### Findings from the independent verification waves

The adversarial agents found defects that the implementation workers had not:

- **M1 challenger:** `lemma.ts` still resolved `lean`/`lake`/`leap` through raw
  `PATH` (a 0777 or relative PATH entry executed planted binaries), and an
  unreadable `/etc/group` made `doctor --security` report `privileged_groups:
  pass` instead of `unknown`. Both are fixed; the resolver is now the shared
  trusted-path helper with `fallbackToStandard: false`, and the group check
  fails closed. The same probe found `canonicalAxiomSet` used `localeCompare`;
  it now uses a code-unit comparator and its hash is byte-identical across the
  tested locales.
- **M2 challenger:** 29 declarations that lost their `export` were dead private
  code, and the handoff's count for `WAVE_KINDS` was stale. The dead names and
  orphaned imports were removed; `WAVE_KINDS` is now private.
- **M3/M4 reviewer and parity challenger:** two drafted runtime assertions used
  the wrong contract (plain sha256 instead of the keyed ADR-0015 digest; total
  host commands instead of the plugin's seven). Both were corrected to assert
  the real contract. The challenger also found a real re-plan bug: a refused
  re-plan with a different topology rewrote `plan.dag.json` **before** the
  signed-baseline drift check, which moved the 2-audit cap. The drift check now
  runs before the approval nonce and every run write; a refused re-plan leaves
  `plan.dag.json` and `state.json` byte-identical, and the cap holds. A
  legitimate same-topology re-plan still succeeds. The reviewer then found three
  handoff blockers: the documented `teamwork_plan({ followUp })` call was not
  callable without dummy `topology`/`tasks` (fixed with a two-branch `anyOf`
  schema and a pre-topology branch), `PREREQUISITES.md` always said `MISSING`
  even on `OUTAGE` while the refusal text claimed nothing was written (fixed
  with explicit statuses and honest wording), and several runtime specs claimed
  coverage they did not assert (fixed by adding the real assertions for the A5
  stubs/symlink, A6 wave line, A7 statuses, A8 legacy summary, A9 abort
  artifact, A4 clamps/report feedback and A3 manifest re-bind).

## 5. Verification results

All commands below were run from the repo root unless noted.

```sh
npm test                                   # exit 0; 15 L0 suites
npm run test:agy-parity                    # 153/153 parity
node scripts/lint-security-claims.mjs      # 31 files clean
npm run lint:prompts                       # 15 agents, 6 topologies
npm pack --dry-run                         # 109 files, 0 deps, no tests/docs/re/signer
cargo test --manifest-path signer/Cargo.toml  # 5/5
fallow dead-code --no-cache                # 0 issues, exit 0
cd tests/runtime && bun test --timeout 30000  # 114 pass, 1 skip (L4 live), 0 fail
```

The full audit and test evidence is in the fresh run recorded with this report.

## 6. Tools and endpoints that were unavailable

| Tool / endpoint | Command | Observed |
| --- | --- | --- |
| Sonar Vortex analysis | `sonar analyze --file plugins/opencode-teamwork/claim-state.mjs --format json` | `Vortex analysis is not available on this connection (403 Forbidden).` The secrets scan in the same command succeeded. |
| `sonar-scanner` without `JAVA_HOME` | `sonar-scanner --version` | `Could not find 'java' executable in JAVA_HOME or PATH` even though `java` was on PATH. With `JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(which java)")")")"` the scanner starts, but no `SONAR_TOKEN`/project properties are available to it, so it cannot upload an analysis. |
| SonarCloud remote state | `sonar api GET /api/issues/search?...` | Reachable and authenticated; it reports the last `main` analysis, not this branch. |
| fallow dependency graph | `fallow dead-code --no-cache` | Warns `'node_modules' does not exist` because the package is deliberately dependency-free; package-export classification is therefore degraded. The dead-code results were cross-checked by hand. |
| CodeQL local run | n/a | CodeQL is a GitHub-hosted workflow; there is no local database in this environment. Alert states were read from the API and the fixes were verified by tests, not by a local CodeQL run. |
| `agy` internals | n/a | Treated as an opaque binary (1.5.17); behaviour comes from live output and the recorded corpus. |

The local secrets scan, `sonar analyze secrets .`, succeeded and found **no
secrets**.

## 7. Unresolved items and residual risks

1. **Remote scanner state.** CodeQL is clean on `main` (`7e0de63`: 0 open,
   43 fixed, 9 dismissed; the 0.19.1 addition is a deterministic test-fixture
   nonce in `signer/tests/spec_28.rs`, dismissed as used in tests). SonarCloud
   analyzed `main` @ `7e0de63` (0.19.1): 1,292 open (7 bugs, 5 vulnerabilities,
   1,280 smells); all 12 bugs/vulnerabilities are in the never-shipped
   `docs/re/` corpus, 0 outside. #49 is closed. The larger smell count is new
   code, not a regression in the shipped behaviour.
2. **Sonar code smells remain.** The targeted bug/vulnerability/dead-code set is
   fixed; the large `S3776` cognitive-complexity family (and other style rules)
   was not mass-refactored. Reducing it safely is a separate change.
3. **`S4036` residuals.** `resolveTrustedExecutable` rejects world-writable,
   relative and foreign-owned PATH entries, but accepts group-writable trusted
   directories and does not close the stat→exec window on every platform. A
   `verify --rerun` command is intentionally operator-supplied and is resolved
   from its recorded `argv[0]`; this is the documented re-execution contract,
   not a hidden PATH lookup.
4. **Same-UID boundary.** A same-UID process that can read the OpenCode KV or
   `opencode.db` can read a local HMAC/Ed25519 key and mint envelopes. This is
   the documented boundary; the signer/witness/attestation layers detect
   specific cross-run and downgrade cases, not a hostile same-UID writer.
5. **Falsifier shell.** `team/falsifier` now has `shell` (for empirical tests)
   and still has `edit`/`subagent` denied. Shell can modify files, so the prompt
   forbids using it for edits; this is a prompt-enforced, not code-enforced,
   boundary.
6. **Windows containment.** The preventive fd-pinned write guarantee is Linux
   `/proc/self/fd` only; macOS/Windows keep the detective post-write check, and
   the Windows ACL model is weaker than the POSIX mode checks. Documented in
   ADR 0010 and `docs/GUARDRAILS.md`.
7. **`cleanBlock(value, 0)`.** It returns `"…"` (length 1) for a zero cap; no
   caller passes zero. The edge is inherited and recorded rather than changing
   the established sanitizer contract.
8. **Partial sanitizer consolidation.** `text-utils.ts` is the one
   lemma/tournament-family implementation; `tools.ts`, `document-review.ts` and
   `briefing.ts` keep their own primitives with different object semantics by
   design. The header comment scopes the claim.
9. **Survey artifacts are scaffolds.** `PROJECT.md`, `SCOPE.md` and
   `TEST_INFRA.md` are created create-only at plan time; the scouts and sentinel
   fill in the inventory/milestones and own the content. `TEST_READY.md` is
   never created by the engine (only after a green E2E run).
10. **Document-review visual audit.** The local ingestor extracts text through
    `pypdfium2`/`Pillow` when the pure-JS path cannot read a PDF, but it does
    not render per-page PNGs or provide an equivalent of `agy`'s `view_file`
    visual check. This is a real difference outside the A1-A9 scope and is not
    claimed closed.
11. **Per-dispatch model override.** Model choice is install-time
    (`teamwork.json` / agent frontmatter) plus the process toggle; there is no
    `agy`-style per-subagent `Model` override. The parity matrix treats this as
    a host/design difference, not an A-gap.
12. **`state.json` is unsigned coordinator state.** The signed artifacts are
    `run.manifest.json`, the `_auth`-indexed files and the final/victory
    verdicts; the ledger is recomputed and drift-checked, not signed as a file.
13. **Matrix wording.** The survey matrix says `shell` is denied for four
    roles; `READ_ONLY_ACTIONS` denies it for three (segment reviewer,
    formalization reviewer, referee). The code and `a5-permission-hook` agree.
14. **History.** Commit `b3a3666` on the branch carries the M1 work with a
    generic message and was already on `origin`; this run did not rewrite it.
    The remediation is recorded in the follow-up commits and this report.

## 8. Independent five-surface rubric

Filled by an independent reviewer against the five observable `agy` 1.5.17
surfaces named in R2. The reviewer did not implement the remediation. The
comparison side is the survey matrix (`parity_matrix.md`, features 1-17, each
tagged with one of these five surfaces); the local side is source inspection,
the L0 suite and direct command probes. Runtime specs were **not re-run by this
reviewer** (a separate reviewer owns `tests/runtime`); the runtime evidence
below is the recorded run in `docs/TEST_READY.md`.

| Surface | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| 1. CLI commands and flags | 13 management commands, exit codes, `--run-dir`/`--session`, 7 slash commands, legacy descriptions, `OPENCODE_TEAMWORK_DISABLED` | **PASS** | Matrix features 1-3 and edge cases 1, 2, 4. `bin/opencode-teamwork.mjs:44-124` lists 13 commands; `:830-834` dispatches `approve` before the installer parser; `:845-850` rejects every other verb with exit 1 (observed). `lib/verify.mjs:762-774` makes `--session` and `--run-dir` mutually exclusive; `:3316-3321` maps PASS/FAIL/UNKNOWN to 0/1/2 and `bin/opencode-teamwork.mjs:725-731` maps usage to 3 (observed 3 for no target, both targets, and a traversal id). `plugins/opencode-teamwork/index.ts:30-191` is exactly 7 commands; `:98,:119,:139,:160,:178` label the five `/team-*` commands legacy and point at `/teamwork`; `:263-264` implements `OPENCODE_TEAMWORK_DISABLED`. Tests: `test-catalog.mjs` (26 tools, 23 prompt tokens), L0 `A9-T1-01/02`, `A9-T1-05`, `A9-T2-01..03`, `E2E-07`; runtime `a3-commands.test.ts:15-44` (7 commands, agent switch, `$ARGUMENTS`) and `[M3 A9]` at `agy-parity.test.ts:676,693`. |
| 2. Workflow stages | route order (document-review first), interview gate, plan/DAG/rounds, small-focused loop, survey/dual-track, strict wave, security/final/victory gates, terminal stop | **PASS** | Matrix features 4-13 and edge cases 5, 6, 8, 9. Route: `tools.ts:7630-7639` reaches the `document-review` branch before lemma/tournament, and `test-engine.mjs:5320-5329` asserts a supplied math paper beats `proof`. Interview: `sentinel.md:57-62`, `index.ts:38`, L0 `A2-T1-01`, `A2-T2-03/04`. Plan/DAG/rounds: `tools.ts:6913-6925` clamps 1..32 (default 4, no 1-round cap; `A4-T1-01`, `A4-T2-01/05`). Small-focused loop: `sentinel.md:114-119`, `victory.ts:493-503` (2-audit cap), `A4-T1-02..04`, `A4-T2-04`, runtime `[M4 A4]`. Survey/dual-track: `sentinel.md:30-40,156-163`, stubs `tools.ts:4049-4135` (never `TEST_READY.md`), `A5-T1-01..03`, runtime `[M4 A5]`. Strict wave: `tools.ts:6385` (`distributed-coding` defaults strict), `strict.ts:648-716`, `A6-T1-01/03`, runtime `[M4 A6]`. Security/final/victory: `sentinel.md:136-150`, `A6`, `A8`. Terminal stop: `sentinel.md:270-280`; an abort writes `interrupted.md` at `tools.ts:9644`; `E2E-03`, runtime `[T4.3]`. |
| 3. Tool contracts | exactly 26 `teamwork_*` tools, namespace/codemode, `strictInput`, no undeclared `output`, new `followUp`/`skipInterview` inputs | **PASS** | Matrix feature 14. `test-catalog.mjs` passes (26 ids, `{namespace:"teamwork",codemode:false}`, `strictInput`, every prompt token resolves); `a2-catalog.test.ts:60-104` repeats the contract against the real runtime. A separate load of `registerTeamworkTools` for this review returned 26 ids, 0 wrong options, 0 non-`strictInput` inputs and 0 `output` keys. `followUp`/`skipInterview` are declared inputs (`tools.ts:7405,7488`) and behaviour-tested by `A1-T1-02..04`, `A3-T1-01..05`, `A3-T2-01..05`. Unknown-key rejection: `test-tool-schema.mjs` (17 checks), `j-strict-input.test.ts`, and `[M1/A1-A8 Runtime Boundary]` at `agy-parity.test.ts:1312`. |
| 4. Agent prompts and roles | 15 agents, read-only deny sets, prompt protection in all 15, crafter Step 2/3, sentinel gates, victory 3-phase, worker handoff, falsifier shell | **PASS** | Matrix features 15-16 and edge cases 3, 7, 10. `lib/team.mjs:50-66` defines 15 agents; `npm run lint:prompts` passes (15 agents, 6 topologies). `READ_ONLY_ACTIONS` (`tools.ts:1429-1445`) denies `edit` for 8 roles and `shell` for 3; `a5-permission-hook.test.ts:21-31` proves verifier `edit` denied, victory-auditor `shell` allowed and `edit` denied, worker untouched; `A6-T1-04` proves falsifier `shell` allowed and `edit` denied. `# SYSTEM PROMPT PROTECTION` is present in 15/15 (grep) and asserted by `A9-T2-04` and `[M3 A9]` at `agy-parity.test.ts:693`. Crafter Step 2/3: `crafter.md:33-57,93-106`, `A2-T1-02..04`. Sentinel gate: `sentinel.md:57-62`, `A2-T1-01`. Victory 3-phase: `victory-auditor.md:75-95`, `A8-T1-01/02`, `A8-T2-01`. Worker handoff: `worker.md:111,118-121`, `A8-T1-04`, `PAIR-14`. `a7-agents.test.ts:7-31` decodes every shipped agent. |
| 5. State and artifacts | `ORIGINAL_REQUEST.md` + Parameters/follow-ups, manifest `requestHash` re-bind, `state.json` ledger/signatures, `DEAD_ENDS.md`, `GATE_STATUS.md`, `PREREQUISITES.md`, `interrupted.md`, `TEST_INFRA/READY` | **PASS** | Matrix features 5, 17 and edge cases 6, 9. `writeOriginalRequest` (`tools.ts:1380-1417`) writes the header, `## Parameters` and `## Request` once; `followUp` (`tools.ts:5891-5976`) appends UTC sections and re-signs the manifest's whole-file `requestHash` (`:5947-5956`); runtime `[M3 A1 x Manifest]` (`agy-parity.test.ts:1357-1374`) checks that digest and `PAIR-04` checks post-append staleness. `state.json` carries the `feedbackLog` ledger (`tools.ts:10886-10954`, `A4-T1-03/04`) and the claim fence; it is not itself signed — the signed baseline is `run.manifest.json` plus the `_auth` index, and `final_verify` recomputes drift from disk (`tools.ts:4700-4797`). `DEAD_ENDS.md`: `tools.ts:4180-4210,10908`, `A5-T1-05`, `A5-T2-03`, runtime `[M4 A5]`. `GATE_STATUS.md`: `strict.ts:648-716`, `tools.ts:13194-13223`, `A6-T1-03`. `PREREQUISITES.md`: `tools.ts:3984-3991`, `A7-T1-02/03`, runtime `[M4 A7]`. `interrupted.md`: `tools.ts:3970-3979,9644`, `A9-T1-04`, `A9-T2-05`, runtime `[T4.3]`. `TEST_INFRA.md` is seeded for `distributed-coding` and `TEST_READY.md` is withheld (`tools.ts:4049-4135`); both suite documents exist and ship. |

### Rubric notes

**Method.** Independent review of `feat/remediation-waves-1-4`; this reviewer
wrote none of the implementation. Comparison: survey matrix features 1-17, each
tagged with one of the five surfaces above. Local: source, L0, and direct CLI
probes. `tests/runtime` was deliberately not run here; its rows cite the
recorded `docs/TEST_READY.md` run for 0.19.0 (61/61 parity; 113 pass, 1 skip,
0 fail overall). The 0.19.1 counts are in §§2 and 5.

**Commands run for this rubric.**

- `npm test` -> exit 0; 15 L0 suites plus parity; 152/152 (T1 65, T2 65, T3 15,
  T4 7). One engine check prints `[SKIP] LEMMA live-toolchain` because
  `lean`/`lake`/`leap` are not installed on this host; no parity case skips.
- `node scripts/test-agy-parity.mjs --milestone=M1|M3|M4` -> 44/44, 46/46, 62/62.
- `node scripts/test-catalog.mjs` -> 26 tools, 23 prompt tokens, v0.19.0.
- Direct tool load -> 26 ids, 0 bad `options`, 0 non-`strictInput`, 0 `output`.
- CLI probes -> `help` 0; unknown command 1; `verify` with no target, both
  targets, and a traversal id 3.
- `node scripts/lint-security-claims.mjs` -> 31 files clean after this edit.
- `npm pack --dry-run` -> 108 files, 0 dependencies; no `tests/`, `docs/re/`,
  or `signer/`; the parity script ships with the other test scripts.

**Residual divergences (outside the eight surface-2 rubric points).**

- Document-review internals (matrix feature 10): the local ingestor extracts
  text through `pypdfium2` when needed and does not write per-page PNGs, so
  `agy`'s `view_file` visual check has no local equivalent. A1-A9 did not close
  this; it remains a real behavioural difference if byte-for-byte
  document-review parity is the bar.
- Per-dispatch model override (matrix feature 2): local model choice is
  install-time (`teamwork.json` / agent frontmatter) plus the process toggle;
  there is no per-subagent override. The matrix treats this as a host/design
  difference, not an A-gap.
- Matrix feature 15 says `shell` is denied for four roles; `READ_ONLY_ACTIONS`
  denies it for three (`segment-reviewer`, `formalization-reviewer`,
  `referee`). The code and the permission test agree; the matrix sentence is
  imprecise.
- Report counts: `npm pack --dry-run` is 109 files and the claim lint sees 31
  files because this report, `TEST_INFRA.md` and `TEST_READY.md` were added;
  §§2 and 5 were refreshed to match.
- `state.json` is unsigned coordinator state. No signature is claimed for the
  ledger itself; the signed artifacts are the manifest, the `_auth`-indexed
  files and the final verdict.

**Verdict.** All five surfaces pass the checks stated in the table. The
document-review visual-audit difference above is the one residual parity gap
outside those checks and is not claimed as closed.

## 9. Conclusion

The branch closes audit items 1–21 locally: the targeted fallow dead code and
duplicate exports are gone, the M1 security findings have code-level fixes with
regression tests, the A1–A9 parity gaps have reproducible L0 and runtime
coverage, and the full repository suite is green. The remaining work is
explicitly bounded: remote scanner states need a push and CI run, and the
non-targeted Sonar complexity/style findings remain a separate refactor.
