# Release runbook

This document describes the release gates and the tag-only publish rule. It is
instructions, not evidence: the hosted Actions runs are the evidence. Branch and
tag rulesets are repository settings owned by an admin; this repository's code
cannot change them and this branch does not try to.

## 1. Before tagging

1. Bump `package.json` and `plugins/opencode-teamwork/package.json` to the same
   version (lockstep; the plugin package version is what `setup` reports).
2. Add a `## [<version>]` section to `CHANGELOG.md`. Keep-a-Changelog
   headings are matched exactly, so `## [0.19.2] - 2026-11-25` satisfies
   version `0.19.2`.
3. Run the local gates from a clean worktree:

   ```sh
   node scripts/check-release-consistency.mjs --require-clean
   npm test
   node scripts/test-agy-parity.mjs
   node scripts/test-packed-tarball.mjs
   npm pack --dry-run
   ```

4. Push to `main` and wait for the required checks in section 3. Do not tag a
   commit that is not on `main`: `scripts/check-release-tag.mjs` refuses to
   publish such a tag.
5. Tag `v<version>` and push the tag. The tag push is the only event that can
   reach `npm publish`.

```sh
npm version patch --no-git-tag-version   # or edit both package.json files
# update plugins/opencode-teamwork/package.json, CHANGELOG.md, commit, then:
git tag "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

## 2. What the publish workflow guarantees

`publish.yml` has two jobs and two privilege levels:

| Job | Trigger | Permissions | What it does |
| --- | --- | --- | --- |
| `verify` | tag push or `workflow_dispatch` | `contents: read` | release consistency, `npm test`, L0 parity, packaging guard, tag provenance, T4 |
| `publish` | tag-only, `needs: verify` | `contents: read`, `id-token: write` | downloads the verified tarball, checks its sha256 and that a fresh `npm pack --ignore-scripts` of the same commit is byte-identical, then `npm publish` |

The branch/tag boundary is structural:

- `publish` has `if: startsWith(github.ref, 'refs/tags/v')`. A
  `workflow_dispatch` on a branch runs only `verify`; a skipped job receives no
  OIDC token.
- `npm publish` is the only publish command in the repository's workflows and
  lives only in the `publish` job. `verify` has no registry credential.
- The privileged job never runs repository test code: it packs with
  `--ignore-scripts` and publishes the already-built tarball.
- `scripts/check-release-consistency.mjs` rejects a tag whose name is not
  exactly `v<package version>`. `scripts/check-release-tag.mjs` rejects a tag
  whose commit is not an ancestor of `origin/main`.

To dry-run a release without publishing: open a pull request (CI runs every
gate), or dispatch `publish.yml` on a branch (only `verify` runs). There is no
separate `release-dry-run.yml`: `ci.yml` already runs parity, T4, the packaging
guard and release consistency on every PR and push, so a second workflow would
only duplicate those jobs.

## 3. Required checks

Configure these as required status checks for `main`. Names are the workflow job
names; a matrix job appears once per value.

| Check | Workflow | Gate |
| --- | --- | --- |
| `test (22)`, `test (24)` | `ci.yml` | `npm test` (L0 engine, catalog, verifier, release-consistency self-test) and the packaging whitelist guard |
| `runtime-l1` | `ci.yml` | full L1/L2/L3 suite with `@opencode/cli@2.4.1` installed; fails unless the log is 118 pass, 1 skip (L4 live), 0 fail and the process E2E marker is present |
| `l0-parity` | `ci.yml` | `node scripts/test-agy-parity.mjs` (153 cases) as a distinct check |
| `pack-t4` | `ci.yml` | packs the tarball, installs it in a clean project, verifies the whitelist/sha256, loads it through the real host and plans one L2 run |
| `release-consistency` | `ci.yml` | root/plugin versions, `CHANGELOG.md` heading, and `v<version>` on tag builds |
| `signer` | `ci.yml` | Rust reference signer tests |
| `lint` | `lint-prompts.yml` | prompt linter (15 agents, 6 topologies) |
| `containment (macos-latest)`, `containment (windows-latest)` | `platform.yml` | read/write containment, approvals, signer/witness SPI on the detective platform boundaries |
| `Live Lean 4 + LEAP CLI (no Mathlib)` (`lemma-e2e` job) | `lemma-e2e.yml` | live Lean 4 + LEAP CLI E2E, no Mathlib |
| CodeQL | repository code scanning | static analysis; configured in repository/org settings, not in a checked-in workflow here |
| SonarCloud | external analysis | quality/security analysis; configured in the Sonar project, not a GitHub check this repo can author |

`host-drift.yml` is nightly and non-blocking by design; do not make it required.
L4 live-model runs are opt-in (`live-l4.yml`) and are not a required check.

The exact check names GitHub records can be confirmed in the branch-protection
UI after the first run. If a ruleset expects a different name than the table
above, update the ruleset, not the workflow job id.

## 4. Admin-only settings

A repository admin must configure these; they are outside this repository:

1. **Branch ruleset for `main`.** Require the checks in section 3, require a
   pull request, and block force pushes and deletion.
2. **Tag ruleset for `v*`.** Restrict creation/update/deletion to release
   maintainers. The workflow already gates `npm publish` on the tag ref; the
   ruleset is defence in depth so an arbitrary user cannot create the tag that
   starts a release.
3. **npm Trusted Publisher.** Package → Settings → Trusted Publisher → GitHub
   Actions with user `Heretek-AI`, repo `opencode-teamwork-v2`, workflow
   `publish.yml`, action `npm publish`.
4. **Optional `npm-publish` environment.** `publish.yml` intentionally has no
   `environment:` today. If required reviewers are wanted, create the
   environment first, then add `environment: npm-publish` to the `publish` job.
   An unconfigured environment would block every release.
5. **`ci-attestation` environment.** `attest.yml` expects it for the signing
   key; configure required reviewers if the attestation must be human-gated.
6. **CodeQL / SonarCloud.** Enable the default setup or the Sonar app and, if
   they should block merges, add them to the same ruleset.

## 5. T4 limitation

T4 proves the tarball installs and its entry point loads. The L1 proof is A1's
directory mode; `tests/runtime/e2e/packed-l2.test.ts` adds one L2 plan run
through the installed tree. A2/A3 still execute in memory mode against the
working tree, and the L3 worktree/claim/verifier scenarios are not re-run from
the tarball. A green T4 is therefore evidence about packaging, entry loading,
catalog/commands parity and one plan flow, not proof that every L2/L3 scenario
works from the published artifact.

The source-level suite remains the full proof: `runtime-l1` runs the working
tree against the pinned host, and `npm pack --dry-run` plus the packaging guard
keep `tests/`, `docs/re/` and `signer/` out of the artifact.
