#!/usr/bin/env node
// T4 release gate: prove the shipped npm tarball installs cleanly and loads
// inside the real OpenCode 2.4.1 runtime (Issue #46).
//
// Usage: node scripts/test-packed-tarball.mjs

import assert from "node:assert"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveTrustedExecutable } from "../plugins/opencode-teamwork/safe-fs.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const RUNTIME_DIR = join(ROOT, "tests", "runtime")

const npmBin = resolveTrustedExecutable("npm")
if (!npmBin) {
  console.error("test-packed-tarball: no trusted npm executable found on PATH")
  process.exit(1)
}
const bunBin = resolveTrustedExecutable("bun")
if (!bunBin) {
  console.error("test-packed-tarball: no trusted bun executable found on PATH")
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), "teamwork-t4-pack-"))
try {
  const packOut = execFileSync(npmBin, ["pack", "--json", "--pack-destination", work], {
    cwd: ROOT,
    encoding: "utf8",
  })
  const packed = JSON.parse(packOut)[0]
  assert(packed && packed.filename, "npm pack --json must return tarball metadata")
  const tarballPath = join(work, packed.filename)
  const tarBytes = readFileSync(tarballPath)
  const sha256 = createHash("sha256").update(tarBytes).digest("hex")
  console.log(`tarball: ${packed.filename}`)
  console.log(`sha256:  ${sha256}`)
  console.log(`files:   ${packed.files.length}`)

  const paths = packed.files.map((f) => f.path)
  const forbidden = paths.filter(
    (p) =>
      p === "tests" ||
      p.startsWith("tests/") ||
      p === "docs/re" ||
      p.startsWith("docs/re/") ||
      p === "signer" ||
      p.startsWith("signer/"),
  )
  assert.deepStrictEqual(forbidden, [], `forbidden paths in tarball: ${forbidden.join(", ")}`)

  for (const prefix of ["plugins/", "agents/", "lib/", "docs/"]) {
    assert(
      paths.some((p) => p.startsWith(prefix)),
      `tarball must contain files under ${prefix}`,
    )
  }

  // Install into an isolated temp project and verify zero runtime dependencies.
  const consumer = join(work, "consumer")
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "t4-consumer", private: true }) + "\n")
  execFileSync(npmBin, ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: consumer,
    stdio: "inherit",
  })

  const installedPkgDir = join(consumer, "node_modules", "@heretek-ai", "opencode-teamwork-v2")
  assert(existsSync(join(installedPkgDir, "plugins", "opencode-teamwork", "index.ts")), "installed plugin entry missing")
  const installedPkg = JSON.parse(readFileSync(join(installedPkgDir, "package.json"), "utf8"))
  assert.strictEqual(Object.keys(installedPkg.dependencies ?? {}).length, 0, "installed package must have zero runtime dependencies")

  // Load the packed artifact via `{ package: "<installed>" }` in L1 specs.
  if (existsSync(join(RUNTIME_DIR, "node_modules"))) {
    execFileSync(
      bunBin,
      ["test", "--timeout", "30000", "spec/a1-load.test.ts", "spec/a2-catalog.test.ts", "spec/a3-commands.test.ts"],
      {
        cwd: RUNTIME_DIR,
        stdio: "inherit",
        env: { ...process.env, TEAMWORK_PACKED_PACKAGE: installedPkgDir },
      },
    )
  } else {
    console.error("tests/runtime/node_modules missing — run `cd tests/runtime && bun install --frozen-lockfile` first")
    process.exit(1)
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### T4 Packed Tarball Verification\n- Tarball: \`${packed.filename}\`\n- SHA-256: \`${sha256}\`\n- Packed files: ${packed.files.length}\n`,
      { flag: "a" },
    )
  }
  console.log(`✓ T4 packed-tarball install test passed (sha256=${sha256})`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
