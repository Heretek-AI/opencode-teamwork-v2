#!/usr/bin/env node
// Release-tag provenance guard.
//
// A published release must correspond to code that is already on `main`. The
// historical v0.6.0 / v0.7.0 tags are sibling release commits with trees
// identical to the release commits on main; they are exempt because this guard
// only runs for tags pushed after it lands. It never rewrites a tag.
//
// Usage:
//   node scripts/check-release-tag.mjs vX.Y.Z
//   GITHUB_REF_NAME=vX.Y.Z node scripts/check-release-tag.mjs
//
// Refuses (exit 1) when the tag's commit is not an ancestor of origin/main.
// Ignores refs that are not `v*` release tags (for example workflow_dispatch).

import { spawnSync } from "node:child_process"

function git(args) {
  const res = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  return {
    ok: res.status === 0,
    stdout: String(res.stdout ?? "").trim(),
    stderr: String(res.stderr ?? "").trim(),
    status: res.status,
  }
}

const raw = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "").trim()
const tag = raw.startsWith("refs/tags/") ? raw.slice("refs/tags/".length) : raw

if (!tag) {
  console.log("check-release-tag: no tag ref supplied (workflow_dispatch) — nothing to check.")
  process.exit(0)
}

if (!tag.startsWith("v")) {
  console.log(`check-release-tag: ignoring non-release ref "${raw}" (only v* tags are guarded).`)
  process.exit(0)
}

// Fetch first so the check is against the current remote main, not a stale
// local clone. Both fetches fail closed: without the refs we cannot prove
// ancestry, so publishing must stop.
const fetchTags = git(["fetch", "--tags", "--force", "origin"])
if (!fetchTags.ok) {
  console.error("check-release-tag: refusing to publish: could not fetch tags from origin.")
  if (fetchTags.stderr) console.error(fetchTags.stderr)
  process.exit(1)
}
const fetchMain = git(["fetch", "--force", "origin", "main:refs/remotes/origin/main"])
if (!fetchMain.ok) {
  console.error("check-release-tag: refusing to publish: could not fetch origin/main.")
  if (fetchMain.stderr) console.error(fetchMain.stderr)
  process.exit(1)
}

const tagRef = `refs/tags/${tag}`
const tagCommit = git(["rev-parse", "--verify", "--quiet", `${tagRef}^{commit}`])
if (!tagCommit.ok) {
  console.error(`check-release-tag: refusing to publish: tag ${tag} does not exist (expected ${tagRef}).`)
  process.exit(1)
}

const ancestry = git(["merge-base", "--is-ancestor", tagCommit.stdout, "origin/main"])
if (!ancestry.ok) {
  console.error(
    [
      `check-release-tag: refusing to publish ${tag}.`,
      `${tag} (${tagCommit.stdout.slice(0, 12)}) is not an ancestor of origin/main.`,
      "Release tags must point at a commit that is already on main; tag the intended main commit",
      "before pushing. Never rewrite a tag that has already been published.",
    ].join("\n"),
  )
  process.exit(1)
}

console.log(`check-release-tag: ${tag} (${tagCommit.stdout.slice(0, 12)}) is an ancestor of origin/main — OK.`)
