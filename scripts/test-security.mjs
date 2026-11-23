// opencode-teamwork — doctor security section + security-claim lint tests
//
// Hermetic, zero-dependency coverage for `lib/security.mjs`, the
// `opencode-teamwork doctor --security/--json` surface, and
// `scripts/lint-security-claims.mjs`. Host probes are overridden so the test
// never depends on the developer's kernel groups or ptrace setting.

import { collectSecurityReport, SECURITY_CHECK_NAMES } from "../lib/security.mjs"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import assert from "node:assert"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const cliPath = join(root, "bin", "opencode-teamwork.mjs")
const lintPath = join(root, "scripts", "lint-security-claims.mjs")
const testDir = mkdtempSync(join(tmpdir(), "teamwork-security-test-"))

try {
  // ==========================================================================
  // 1. Security posture: docker group + ptrace_scope=0 are named warnings
  // ==========================================================================
  {
    console.log("Testing the doctor security posture probes...")
    const groupFile = join(testDir, "group")
    writeFileSync(groupFile, "root:x:0:\nwheel:x:10:fixture\nsudo:x:27:\ndocker:x:998:fixture\n")
    const configDir = join(testDir, "config")
    mkdirSync(configDir, { recursive: true })
    const report = collectSecurityReport({
      env: {},
      platform: "linux",
      configDir,
      pluginDir: join(testDir, "plugin"),
      ptraceScope: "0",
      groupFile,
      groups: [0, 10, 27, 998],
      dbPath: join(testDir, "opencode.db"),
      selinux: "1",
    })
    assert.strictEqual(report.ok, true, "warnings must not make the report fail")
    assert.deepStrictEqual(
      report.checks.map((c) => c.name),
      SECURITY_CHECK_NAMES,
      "the security check names must be stable",
    )
    const ptrace = report.checks.find((c) => c.name === "ptrace_scope")
    assert.strictEqual(ptrace.status, "warn", "ptrace_scope=0 must warn")
    assert(/same-UID/.test(ptrace.message))
    const groups = report.checks.find((c) => c.name === "privileged_groups")
    assert.strictEqual(groups.status, "warn", "docker/wheel membership must warn")
    assert(/docker/.test(groups.message) && /wheel/.test(groups.message), groups.message)
    assert(report.warnings.some((w) => w.startsWith("ptrace_scope:")))
    assert(report.warnings.some((w) => w.startsWith("privileged_groups:")))

    // The CLI exposes the same section in text and JSON.
    const text = spawnSync(process.execPath, [cliPath, "doctor", "--security", "--config-dir", configDir], {
      encoding: "utf8",
    })
    assert(text.stdout.includes("Artifact-trust security posture"), text.stdout + text.stderr)
    assert(text.stdout.includes("key_source"))
    assert(text.stdout.includes("ptrace_scope"))

    const json = spawnSync(process.execPath, [cliPath, "doctor", "--json", "--config-dir", configDir], {
      encoding: "utf8",
    })
    const parsed = JSON.parse(json.stdout)
    assert(parsed.security, "doctor --json must include a security section")
    assert.deepStrictEqual(parsed.security.checks.map((c) => c.name), SECURITY_CHECK_NAMES)
    assert(parsed.checks.length === 7, "the original seven doctor checks must remain unchanged")

    console.log("✓ doctor security flags docker/wheel membership and ptrace_scope=0 in text and JSON")
  }

  // ==========================================================================
  // 2. Claim lint: forbidden phrase fails, a negated boundary note passes
  // ==========================================================================
  {
    console.log("Testing the security-claim lint...")
    const bad = join(testDir, "bad.md")
    writeFileSync(bad, "# Claims\n\nThis package is tamper-proof and signed by a trusted authority.\n")
    const badRun = spawnSync(process.execPath, [lintPath, bad], { encoding: "utf8" })
    assert.strictEqual(badRun.status, 1, badRun.stdout + badRun.stderr)
    assert(/tamper-proof/.test(badRun.stderr), badRun.stderr)
    assert(/signed by a trusted authority/.test(badRun.stderr), badRun.stderr)

    const good = join(testDir, "good.md")
    writeFileSync(
      good,
      "# Boundary\n\nArtifacts are tamper-evident. Do not claim tamper-proof or trusted signature behaviour.\n",
    )
    const goodRun = spawnSync(process.execPath, [lintPath, good], { encoding: "utf8" })
    assert.strictEqual(goodRun.status, 0, goodRun.stdout + goodRun.stderr)

    const repoRun = spawnSync(process.execPath, [lintPath], { encoding: "utf8" })
    assert.strictEqual(repoRun.status, 0, `README/docs must be clean:\n${repoRun.stdout}${repoRun.stderr}`)

    console.log("✓ the lint fails forbidden claims, accepts a negated boundary note, and the repo docs are clean")
  }

  console.log("All security tests passed")
} finally {
  rmSync(testDir, { recursive: true, force: true })
}
