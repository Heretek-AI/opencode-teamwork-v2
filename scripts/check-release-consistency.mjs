#!/usr/bin/env node
// Release consistency guard.
//
// The version in the root package, the plugin package and the changelog must
// name the same release. When GitHub runs a tag build, the tag must be exactly
// `v<version>`; a branch build (GITHUB_REF_TYPE=branch) skips that check.
//
// Usage:
//   node scripts/check-release-consistency.mjs [--require-clean]
//
// `--require-clean` additionally fails when `git status --porcelain` reports
// changes. It is opt-in because test jobs legitimately run after the worktree
// has been touched; release jobs use it on a fresh checkout.
//
// Exit codes: 0 consistent, 1 inconsistent/unreadable/dirty-with-flag.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const PLUGIN_PACKAGE = "plugins/opencode-teamwork/package.json"
const CHANGELOG = "CHANGELOG.md"
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// Resolve git to an absolute path once; never fall back to PATH lookup.
const GIT_BIN = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"].find(existsSync) ?? "/usr/bin/git"

function readJson(root, relativePath, errors) {
  try {
    return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"))
  } catch (error) {
    errors.push(`${relativePath}: cannot read or parse JSON (${error?.message ?? error})`)
    return null
  }
}

function readText(root, relativePath, errors) {
  try {
    return readFileSync(resolve(root, relativePath), "utf8")
  } catch (error) {
    errors.push(`${relativePath}: cannot read (${error?.message ?? error})`)
    return null
  }
}

function gitStatus(root) {
  const result = spawnSync(GIT_BIN, ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    return { ok: false, output: String(result.stderr ?? "").trim() || `git status exited ${result.status}` }
  }
  return { ok: true, output: String(result.stdout ?? "") }
}

/**
 * Check package versions, changelog coverage, the tag ref and optionally the
 * worktree. Pure apart from reading `root` and, when `statusOutput` is not
 * supplied, running `git status` in `root`.
 *
 * @param {{
 *   root?: string,
 *   env?: Record<string, string | undefined>,
 *   requireClean?: boolean,
 *   statusOutput?: string,
 * }} [options]
 * @returns {{ ok: boolean, version: string | null, errors: string[], checks: Array<{ name: string, ok: boolean, detail: string }> }}
 */
export function checkReleaseConsistency(options = {}) {
  const root = options.root ?? ROOT
  const env = options.env ?? process.env
  const requireClean = options.requireClean === true
  const errors = []
  const checks = []

  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    if (!ok) errors.push(`${name}: ${detail}`)
  }

  const pkg = readJson(root, "package.json", errors)
  const pluginPkg = readJson(root, PLUGIN_PACKAGE, errors)
  const version = typeof pkg?.version === "string" ? pkg.version : null
  const pluginVersion = typeof pluginPkg?.version === "string" ? pluginPkg.version : null

  if (version === null) {
    record("root version", false, "package.json has no string version")
  } else {
    record("root version", VERSION_RE.test(version), `package.json version is ${JSON.stringify(version)}`)
  }

  if (version !== null && pluginVersion !== null) {
    record(
      "plugin version",
      pluginVersion === version,
      `${PLUGIN_PACKAGE} version is ${pluginVersion}, root package.json version is ${version}`,
    )
  } else if (pluginVersion === null) {
    record("plugin version", false, `${PLUGIN_PACKAGE} has no string version`)
  }

  const changelog = readText(root, CHANGELOG, errors)
  if (version !== null && changelog !== null) {
    const heading = `## [${version}]`
    record("changelog", changelog.includes(heading), `${CHANGELOG} must contain ${JSON.stringify(heading)}`)
  }

  if (env.GITHUB_REF_TYPE === "tag") {
    const tag = String(env.GITHUB_REF_NAME ?? "").trim()
    const expected = version === null ? null : `v${version}`
    record(
      "release tag",
      expected !== null && tag === expected,
      `GITHUB_REF_NAME is ${JSON.stringify(tag)}, expected ${JSON.stringify(expected)}`,
    )
  } else {
    record("release tag", true, `not a tag build (GITHUB_REF_TYPE=${JSON.stringify(env.GITHUB_REF_TYPE ?? "")})`)
  }

  if (requireClean) {
    const status = options.statusOutput !== undefined ? { ok: true, output: options.statusOutput } : gitStatus(root)
    if (!status.ok) {
      record("worktree", false, `could not inspect git status (${status.output})`)
    } else {
      const dirty = status.output.trim()
      record("worktree", dirty === "", dirty === "" ? "clean" : `unexpected changes:\n${dirty}`)
    }
  }

  return { ok: errors.length === 0, version, errors, checks }
}

function main() {
  const args = new Set(process.argv.slice(2))
  const unknown = [...args].filter((arg) => arg !== "--require-clean")
  if (unknown.length > 0) {
    console.error(`check-release-consistency: unknown argument(s): ${unknown.join(", ")}`)
    process.exit(1)
  }

  const result = checkReleaseConsistency({ root: ROOT, requireClean: args.has("--require-clean") })
  for (const check of result.checks) {
    console.log(`${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}`)
  }
  if (!result.ok) {
    console.error(`\ncheck-release-consistency: ${result.errors.length} problem(s) for ${result.version ?? "unknown version"}`)
    process.exit(1)
  }
  console.log(`\ncheck-release-consistency: ${result.version} is consistent`)
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (import.meta.url === invoked) main()
