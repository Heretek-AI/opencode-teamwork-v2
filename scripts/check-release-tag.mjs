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

import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

// Resolve git to an absolute path once; never fall back to PATH lookup.
const GIT_BIN = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"].find(existsSync) ?? "/usr/bin/git"

function git(args) {
  const res = spawnSync(GIT_BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
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

// Strict allowlist before any git process starts: a release tag is one path
// segment, so nothing argv/GITHUB_REF_NAME supplies reaches git as an option,
// revision expression, or ref outside refs/tags/.
const TAG_RE = /^v[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
if (!TAG_RE.test(tag)) {
  console.error(
    "check-release-tag: refusing to publish: invalid release tag name " +
      JSON.stringify(tag) +
      " (expected v[0-9A-Za-z][0-9A-Za-z._-]{0,63}).",
  )
  process.exit(1)
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

// Resolve the requested tag from git's own ref listing instead of passing the
// caller-supplied name back to git as an argument. The command has no dynamic
// argv; matching happens in JS against a strict `refs/tags/<tag>` equality.
const tagRef = `refs/tags/${tag}`
const listedTags = git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/tags"])
if (!listedTags.ok) {
  console.error("check-release-tag: refusing to publish: could not list local tags.")
  if (listedTags.stderr) console.error(listedTags.stderr)
  process.exit(1)
}
let tagCommit = ""
for (const line of listedTags.stdout.split("\n")) {
  const [ref, object, peeled] = line.split("\0")
  if (ref === tagRef) {
    tagCommit = peeled || object
    break
  }
}
if (!tagCommit) {
  console.error(`check-release-tag: refusing to publish: tag ${tag} does not exist (expected ${tagRef}).`)
  process.exit(1)
}

const ancestry = git(["merge-base", "--is-ancestor", "--", tagCommit, "origin/main"])
if (!ancestry.ok) {
  console.error(
    [
      `check-release-tag: refusing to publish ${tag}.`,
      `${tag} (${tagCommit.slice(0, 12)}) is not an ancestor of origin/main.`,
      "Release tags must point at a commit that is already on main; tag the intended main commit",
      "before pushing. Never rewrite a tag that has already been published.",
    ].join("\n"),
  )
  process.exit(1)
}

console.log(`check-release-tag: ${tag} (${tagCommit.slice(0, 12)}) is an ancestor of origin/main — OK.`)
