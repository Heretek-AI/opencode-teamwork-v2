# Release runbook

This document describes the release gates and the tag-only publish rule. It is
instructions, not evidence: the hosted Actions runs are the evidence. Branch and
tag rulesets are repository settings owned by an admin; this repository's code
cannot change them and this branch does not try to.

## 1. Before tagging

1. Bump `package.json` and `plugins/opencode-teamwork/package.json` to the same
   version (lockstep; the plugin package version is what `setup` reports).
2. Add a `## [<version>]` section to `CHANGELOG.md`. Keep-a-Changelog
   headings are matched exactly, so `## [0.19.3] - 2026-11-26` satisfies
   version `0.19.3`.
3. Run the local gates from a clean worktree:

   ```sh
   node scripts/check-release-consistency.mjs --require-clean
   npm test
   node scripts/test-agy-parity.mjs
   node scripts/test-packed-tarball.mjs
   npm pack --dry-run
   ```

4. Push to `main` and wait for the 10 required checks in section 3. Do not tag
   a commit that is not on `main`: `scripts/check-release-tag.mjs` refuses to
   publish such a tag.
5. **Tag the current tip of `main`.** The release tag must point at the commit
   the required checks passed on, not an older ancestor that happens to be on
   `main`. Fetch and compare before tagging:

   ```sh
   git fetch origin main
   test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
   ```

   Never move or delete a tag that has already been pushed. If `main` moved
   before the tag was published, cut the next patch from the new tip instead of
   rewriting history.
6. Tag `v<version>` and push the tag. The tag push is the only event that can
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
  `workflow_dispatch` run can reach only `verify`; it has no route to the
  OIDC-bearing `publish` job, and a skipped job receives no token.
- `npm publish` is the only publish command in the repository's workflows and
  lives only in the `publish` job. `verify` has no registry credential.
- The privileged job runs no repository script and never runs repository test
  code: it starts from a clean checkout and clean npm config, packs with
  `--ignore-scripts`, publishes the already-built tarball, and uses only the
  npm CLI plus read-only git for the tag check.
- Release checks reject a repository `.npmrc` and a `publishConfig` entry that
  could redirect the registry, access or tag. The publish job sets its registry
  explicitly instead of inheriting one.
- `scripts/check-release-consistency.mjs` rejects a tag whose name is not
  exactly `v<package version>`. `scripts/check-release-tag.mjs` rejects a tag
  whose commit is not on `origin/main`; the tag-tip rule in section 1 is
  stricter and remains a release-manager requirement.

To dry-run a release without publishing: open a pull request (CI runs every
gate), or dispatch `publish.yml` on a branch (only `verify` runs). There is no
separate `release-dry-run.yml`: `ci.yml` already runs parity, T4, the packaging
guard and release consistency on every PR and push, so a second workflow would
only duplicate those jobs.

### 2.1 Post-publish order

Do these in order. Do not create the GitHub release first.

1. **Verify the registry artifact.** Resolve the version and download the
   published tarball, then compare its sha256 to the `release.json` recorded by
   the publish job:

   ```sh
   npm view @heretek-ai/opencode-teamwork-v2@0.19.3 version dist.tarball dist.integrity
   npm pack @heretek-ai/opencode-teamwork-v2@0.19.3
   sha256sum heretek-ai-opencode-teamwork-v2-0.19.3.tgz
   ```

   A missing `dist.integrity`, a different version, or a hash that does not
   match the verified artifact stops the release: deprecate and fix forward.

2. **Publish the advisory.** The 0.19.2 verifier-completeness (C-1) and central
   signed-run legacy-downgrade (H-1) defects require a **new** GitHub Security
   Advisory. [GHSA-jf59-xgq8-hjmv](https://github.com/Heretek-AI/opencode-teamwork-v2/security/advisories/GHSA-jf59-xgq8-hjmv)
   covers the earlier `verify --rerun`/`--allow-unsigned` false-PASS defect and
   is patched in 0.19.2; do not reuse it or invent another ID.

3. **Deprecate 0.19.2.** This is an npm-authenticated maintainer action and is
   **not** performed by the workflow. It is not done until the command below
   succeeds with an authenticated account (2FA as required):

   ```sh
   npm deprecate "@heretek-ai/opencode-teamwork-v2@0.19.2" \
     "Affected by verifier completeness and signed-run legacy downgrade defects; upgrade to 0.19.3 or later."
   ```

   The range is `@0.19.2`, not the whole package. A published deprecation is
   visible in registry metadata; check it with
   `npm view @heretek-ai/opencode-teamwork-v2@0.19.2 deprecated`.

4. **Create the GitHub release** for the existing tag `v0.19.3`, with the
   changelog section and the advisory link. The tag is not moved or recreated.

### 2.2 Manual publish fallback

If the admin gates in section 4 are **not** applied (no tag ruleset, no npm
Trusted Publisher, or required checks not enforced), the workflow does not
provide the boundary described above. A maintainer may publish manually only
from a clean, verified checkout:

1. `git switch main && git pull --ff-only`, and confirm
   `git status --porcelain` is empty.
2. Confirm `HEAD` is the current `origin/main` tip and the tag points at it:

   ```sh
   test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
   test "$(git rev-parse 'v0.19.3^{commit}')" = "$(git rev-parse HEAD)"
   ```

3. Run the section 1 gates, then `npm pack` and inspect the tarball.
4. `npm publish <tarball> --access public` with a granular token and 2FA.
   Publishing the tarball runs no repository lifecycle scripts.
5. Verify the registry as in section 2.1.

A manual publish has no OIDC provenance and bypasses the tag-only workflow
boundary. Record that fact in the release notes and the tracking issue; do not
describe it as the normal path. Never publish from a dirty tree, and never run
`npm publish` on the directory instead of the packed tarball.

## 3. Required checks

The `main` ruleset currently requires **10 checks** (the two `test` matrix
values and the two `containment` values count separately). Names are the
workflow job names.

| Check | Workflow | Gate |
| --- | --- | --- |
| `test (22)`, `test (24)` | `ci.yml` | `npm test` (L0 engine, catalog, verifier, release-consistency self-test) and the packaging whitelist guard |
| `runtime-l1` | `ci.yml` | full L1/L2/L3 suite with `@opencode/cli@2.4.1` installed; fails unless the log is 118 pass, 1 skip (L4 live), 0 fail and the process E2E marker is present |
| `l0-parity` | `ci.yml` | `node scripts/test-agy-parity.mjs` (153 cases) as a distinct check |
| `pack-t4` | `ci.yml` | packs the tarball, installs it in a clean project, verifies the whitelist/sha256, loads it through the real host and plans one L2 run |
| `release-consistency` | `ci.yml` | root/plugin versions, `CHANGELOG.md` heading, and `v<version>` on tag builds |
| `signer` | `ci.yml` | Rust reference signer tests |
| `lint` | `lint-prompts.yml` | prompt linter (15 agents, 6 topologies); unfiltered so the required check always reports |
| `containment (macos-latest)`, `containment (windows-latest)` | `platform.yml` | read/write containment, approvals, signer/witness SPI on the detective platform boundaries |

These are **not** required checks:

| Check | Workflow | Why it is advisory |
| --- | --- | --- |
| `Live Lean 4 + LEAP CLI (no Mathlib)` (`lemma-e2e` job) | `lemma-e2e.yml` | path-filtered to plugin/agent/script changes; a skipped path-filtered check is not a stable required gate |
| CodeQL | repository code scanning | configured in repository/org settings; advisory static analysis |
| SonarCloud | external analysis | quality/security analysis in the Sonar project; not a GitHub check this repository can author and not stable enough to require |

`host-drift.yml` is nightly and non-blocking by design; do not make it required.
L4 live-model runs are opt-in (`live-l4.yml`) and are not a required check.

Path-filtered checks must stay advisory: a required check that never runs on a
docs-only pull request can leave the merge blocked indefinitely. `lint` is
unfiltered after 0.19.3 so it can be required.

The exact check names GitHub records can be confirmed in the branch-protection
UI after the first run. If a ruleset expects a different name than the table
above, update the ruleset, not the workflow job id.

### 3.1 Rollback and deprecation

A published version and a pushed release tag are immutable for this process. Do
**not** delete or move the tag, and do not republish the same version.

If an artifact is wrong:

1. Deprecate the affected version with `npm deprecate` (the command in section
   2.1), which requires npm authentication.
2. Fix forward with the next patch version: bump both manifests, add the
   changelog section, run the gates, tag the new tip, and publish.
3. Record the supersession in the changelog, the advisory and the GitHub
   release.

`npm unpublish` is a last resort. It is time-limited, may be refused, and does
not undo installs or restore trust in a version others may already have used.
Do not treat it as a rollback plan.

## 4. Admin-only settings

A repository admin must configure these; they are outside this repository:

1. **Branch ruleset for `main`.** Require the 10 checks in section 3, require a
   pull request, require review from code owners, and block force pushes and
   deletion. `CODEOWNERS` covers `.github/workflows/`, `scripts/check-release*`,
   `scripts/attest*`, and both package manifests so a test-only or release-only
   change cannot be merged without an owner review.
2. **Tag ruleset for `v*`.** Restrict creation/update/deletion to release
   maintainers. The workflow already gates `npm publish` on the tag ref; the
   ruleset is defence in depth so an arbitrary user cannot create the tag that
   starts a release. The tag-tip rule in section 1 is not a substitute for this
   ruleset.
3. **npm Trusted Publisher.** Package → Settings → Trusted Publisher → GitHub
   Actions with user `Heretek-AI`, repo `opencode-teamwork-v2`, workflow
   `publish.yml`, action `npm publish`.
4. **Optional `npm-publish` environment.** `publish.yml` intentionally has no
   `environment:` today. If required reviewers are wanted, create the
   environment first, then add `environment: npm-publish` to the `publish` job.
   An unconfigured environment would block every release.
5. **`ci-attestation` environment.** `attest.yml` expects it for the signing
   key; configure required reviewers if the attestation must be human-gated.
   CI attestation is **experimental** in 0.19.3 and is not a working control
   until JWKS verification, commit binding and expiry are fixed; do not present
   it as independent acceptance evidence.
6. **CodeQL / SonarCloud.** Enable the default setup or the Sonar app. Keep them
   advisory unless their result names are stable enough to require; adding a
   path-filtered or flaky external check to the ruleset can block unrelated
   pull requests.

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
