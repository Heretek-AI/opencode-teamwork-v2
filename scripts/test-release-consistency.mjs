#!/usr/bin/env node
// Self-test for scripts/check-release-consistency.mjs.
//
// Builds throwaway fixture trees; every case is a package version, changelog
// heading, tag ref, npm/yarn config file, publishConfig and (optional) dirty
// worktree. Proves that a version/changelog mismatch fails, a tag mismatch
// fails, repository npm config or a privileged publishConfig key fails, and
// --require-clean is the only way a dirty worktree fails.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkReleaseConsistency } from "./check-release-consistency.mjs"

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`)
  }
}

function fixture({
  rootVersion = "1.2.3",
  pluginVersion = "1.2.3",
  changelog = "## [1.2.3] - 2026-11-25\n",
  rootPackage,
  pluginPackage,
  files = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-consistency-"))
  mkdirSync(join(root, "plugins", "opencode-teamwork"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(rootPackage ?? { name: "@heretek-ai/fixture", version: rootVersion }) + "\n",
  )
  writeFileSync(
    join(root, "plugins", "opencode-teamwork", "package.json"),
    JSON.stringify(pluginPackage ?? { name: "@heretek-ai/fixture-plugin", version: pluginVersion }) + "\n",
  )
  writeFileSync(join(root, "CHANGELOG.md"), changelog)
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return root
}

function run(options) {
  const root = fixture(options.fixture)
  try {
    return checkReleaseConsistency({
      root,
      env: options.env ?? {},
      requireClean: options.requireClean ?? false,
      statusOutput: options.statusOutput ?? "",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// 1. The happy path: both package versions and the changelog agree.
{
  const result = run({})
  check("consistent fixture passes", result.ok, result.errors.join("; "))
  check("reports the version", result.version === "1.2.3", String(result.version))
}

// 2. A plugin package version drift fails.
{
  const result = run({ fixture: { pluginVersion: "1.2.4" } })
  check("plugin version mismatch fails", !result.ok)
  check(
    "mismatch names both versions",
    result.errors.some((error) => error.includes("1.2.4") && error.includes("1.2.3")),
    result.errors.join("; "),
  )
}

// 3. A missing changelog heading fails.
{
  const result = run({ fixture: { changelog: "## [1.2.2] - 2026-11-24\n" } })
  check("missing changelog heading fails", !result.ok)
  check(
    "changelog failure names the expected heading",
    result.errors.some((error) => error.includes("## [1.2.3]")),
    result.errors.join("; "),
  )
}

// 4. A tag build must point at v<version>.
{
  const result = run({ env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.4" } })
  check("tag mismatch fails", !result.ok)
  check(
    "tag failure names the expected tag",
    result.errors.some((error) => error.includes("v1.2.3") && error.includes("v1.2.4")),
    result.errors.join("; "),
  )
}
{
  const result = run({ env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" } })
  check("matching tag passes", result.ok, result.errors.join("; "))
}
{
  const result = run({ env: { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" } })
  check("branch build skips the tag check", result.ok, result.errors.join("; "))
}

// 5. A dirty worktree fails only when --require-clean is requested.
{
  const dirty = " M README.md\n?? scratch.txt\n"
  const relaxed = run({ statusOutput: dirty })
  check("dirty worktree passes without --require-clean", relaxed.ok, relaxed.errors.join("; "))
  const strict = run({ statusOutput: dirty, requireClean: true })
  check("dirty worktree fails with --require-clean", !strict.ok)
  check(
    "dirty failure reports the changed paths",
    strict.errors.some((error) => error.includes("README.md") && error.includes("scratch.txt")),
    strict.errors.join("; "),
  )
  const clean = run({ statusOutput: "", requireClean: true })
  check("clean worktree passes with --require-clean", clean.ok, clean.errors.join("; "))
}

// 6. An invalid version is refused rather than compared loosely.
{
  const result = run({ fixture: { rootVersion: "1.2", pluginVersion: "1.2" } })
  check("invalid semver fails", !result.ok)
}

// 7. A committed npm/yarn config could redirect or authenticate the release.
for (const configFile of [".npmrc", ".yarnrc", ".yarnrc.yml"]) {
  const result = run({
    fixture: { files: { [configFile]: "registry=https://registry.example.invalid/\n" } },
  })
  check(`${configFile} is rejected`, !result.ok)
  check(
    `${configFile} failure names the file`,
    result.errors.some((error) => error.startsWith(`${configFile}:`)),
    result.errors.join("; "),
  )
}

// 8. `publishConfig` may only carry `access`; npm applies the other keys from
// the tarball during `npm publish`, even when the workflow passes flags.
{
  const result = run({
    fixture: {
      rootPackage: { name: "@heretek-ai/fixture", version: "1.2.3", publishConfig: { access: "public" } },
      pluginPackage: {
        name: "@heretek-ai/fixture-plugin",
        version: "1.2.3",
        publishConfig: { access: "public" },
      },
    },
  })
  check("publishConfig access passes", result.ok, result.errors.join("; "))
}
for (const key of ["registry", "tag", "provenance"]) {
  const result = run({
    fixture: {
      rootPackage: { name: "@heretek-ai/fixture", version: "1.2.3", publishConfig: { [key]: "forbidden" } },
    },
  })
  check(`publishConfig ${key} is rejected`, !result.ok)
  check(
    `publishConfig ${key} failure names the key`,
    result.errors.some((error) => error.includes(`publishConfig (package.json)`) && error.includes(`"${key}"`)),
    result.errors.join("; "),
  )
}
{
  const result = run({
    fixture: {
      pluginPackage: {
        name: "@heretek-ai/fixture-plugin",
        version: "1.2.3",
        publishConfig: { registry: "https://registry.example.invalid/" },
      },
    },
  })
  check("plugin package publishConfig registry is rejected", !result.ok)
  check(
    "plugin publishConfig failure names the plugin package",
    result.errors.some((error) => error.includes("plugins/opencode-teamwork/package.json")),
    result.errors.join("; "),
  )
}
{
  const result = run({
    fixture: {
      rootPackage: {
        name: "@heretek-ai/fixture",
        version: "1.2.3",
        publishConfig: { access: "public", tag: "next" },
      },
    },
  })
  check("publishConfig access plus a forbidden key is rejected", !result.ok)
  check(
    "mixed publishConfig failure names only the forbidden key",
    result.errors.some((error) => error.includes('forbidden key(s) "tag"')),
    result.errors.join("; "),
  )
}
{
  const result = run({
    fixture: {
      rootPackage: {
        name: "@heretek-ai/fixture",
        version: "1.2.3",
        publishConfig: "https://registry.example.invalid/",
      },
    },
  })
  check("non-object publishConfig is rejected", !result.ok)
  check(
    "non-object publishConfig failure says so",
    result.errors.some((error) => error.includes("not-an-object")),
    result.errors.join("; "),
  )
}

const total = passed + failed
if (failed > 0) {
  console.error(`\nrelease-consistency self-test: ${passed}/${total} passed, ${failed} failed`)
  process.exit(1)
}
console.log(`\nrelease-consistency self-test: ${passed}/${total} passed`)
