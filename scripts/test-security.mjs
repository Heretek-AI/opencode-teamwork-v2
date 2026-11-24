// opencode-teamwork — doctor security section + security-claim lint tests
//
// Hermetic, zero-dependency coverage for `lib/security.mjs`, the
// `opencode-teamwork doctor --security/--json` surface, and
// `scripts/lint-security-claims.mjs`. Host probes are overridden so the test
// never depends on the developer's kernel groups or ptrace setting.

import { collectSecurityReport, hardenedExitCode, SECURITY_CHECK_NAMES } from "../lib/security.mjs"
import { TEAM_AGENTS } from "../lib/team.mjs"
import { recordWriteAnomaly, setWriteAnomalyAuditPathForTest } from "../plugins/opencode-teamwork/safe-fs.mjs"
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
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

/** Make the doctor's own environment checks pass (warnings are fine). */
function fakeInstalledConfig(configDir) {
  const agentDir = join(configDir, "agents", "team")
  mkdirSync(agentDir, { recursive: true })
  for (const agent of TEAM_AGENTS) writeFileSync(join(agentDir, agent.file), `# ${agent.id} fixture\n`)
}

const allPassOptions = (overrides = {}) => ({
  env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" },
  platform: "linux",
  configDir: join(testDir, "absent-config"),
  pluginDir: join(testDir, "absent-plugin"),
  ptraceScope: "1",
  groupFile: join(testDir, "group-pass"),
  groups: [1000],
  dbPath: join(testDir, "absent.db"),
  selinux: "1",
  euid: 4242,
  repoRoot: join(testDir, "repo"),
  containmentMode: "pinned",
  readContainment: true,
  ...overrides,
})

try {
  writeFileSync(join(testDir, "group-pass"), "users:x:1000:\nstaff:x:1001:\n")
  mkdirSync(join(testDir, "repo"), { recursive: true })

  // ==========================================================================
  // 1. Security posture: docker group + ptrace_scope=0 are named failures
  // ==========================================================================
  {
    console.log("Testing the doctor security posture probes...")
    const groupFile = join(testDir, "group")
    writeFileSync(groupFile, "root:x:0:\nwheel:x:10:fixture\nsudo:x:27:\ndocker:x:998:fixture\n")
    const configDir = join(testDir, "config")
    mkdirSync(configDir, { recursive: true })
    fakeInstalledConfig(configDir)
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
      euid: 4242,
      repoRoot: join(testDir, "repo"),
      containmentMode: "pinned",
      readContainment: true,
    })
    assert.strictEqual(report.ok, false, "knowable failures must make the posture not-ok")
    assert.deepStrictEqual(
      report.checks.map((c) => c.name),
      SECURITY_CHECK_NAMES,
      "the security check names must be stable",
    )
    const ptrace = report.checks.find((c) => c.name === "ptrace_scope")
    assert.strictEqual(ptrace.status, "fail", "ptrace_scope=0 must fail")
    assert(/same-UID/.test(ptrace.message))
    const groups = report.checks.find((c) => c.name === "privileged_groups")
    assert.strictEqual(groups.status, "fail", "docker/wheel membership must fail")
    assert(/docker/.test(groups.message) && /wheel/.test(groups.message), groups.message)
    assert(report.failures.some((c) => c.name === "ptrace_scope"))
    assert(report.failures.some((c) => c.name === "privileged_groups"))
    assert.strictEqual(hardenedExitCode(report), 2, "a failure must hard-fail the hardened profile")

    // The CLI exposes the same section in text and JSON. Plain --security stays
    // advisory: exit 0 with a warning/failure summary.
    const text = spawnSync(process.execPath, [cliPath, "doctor", "--security", "--config-dir", configDir], {
      encoding: "utf8",
    })
    assert.strictEqual(text.status, 0, `plain doctor --security must exit 0: ${text.stdout}${text.stderr}`)
    assert(text.stdout.includes("Artifact-trust security posture"), text.stdout + text.stderr)
    assert(text.stdout.includes("key_source"))
    assert(text.stdout.includes("ptrace_scope"))
    assert(/security failure\(s\)|security warning\(s\)|No security warnings/.test(text.stdout), text.stdout)

    const json = spawnSync(process.execPath, [cliPath, "doctor", "--json", "--config-dir", configDir], {
      encoding: "utf8",
    })
    const parsed = JSON.parse(json.stdout)
    assert(parsed.security, "doctor --json must include a security section")
    assert.deepStrictEqual(parsed.security.checks.map((c) => c.name), SECURITY_CHECK_NAMES)
    assert(parsed.checks.length === 7, "the original seven doctor checks must remain unchanged")

    console.log("✓ doctor security reports failures, plain --security exits 0, and the hardened helper returns 2")
  }

  // ==========================================================================
  // 2. --require-hardened exits 2 on a knowable failure
  // ==========================================================================
  {
    console.log("Testing --require-hardened exit codes...")
    const configDir = join(testDir, "config-hardened")
    mkdirSync(configDir, { recursive: true })
    const env = {
      ...process.env,
      OPENCODE_TEAMWORK_SIGNER: `command:${join(testDir, "missing-signer")}`,
      OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY: "fixture-public-key",
      OPENCODE_TEAMWORK_APPROVAL_DIR: "",
    }
    const hardened = spawnSync(process.execPath, [cliPath, "doctor", "--require-hardened", "--config-dir", configDir], {
      encoding: "utf8",
      env,
    })
    assert.strictEqual(hardened.status, 2, `a fail must exit 2: ${hardened.stdout}${hardened.stderr}`)
    assert(/configured signer path/.test(hardened.stdout), hardened.stdout)

    const allPass = collectSecurityReport(allPassOptions())
    assert.strictEqual(allPass.ok, true, JSON.stringify(allPass.failures))
    assert.strictEqual(hardenedExitCode(allPass), 0, "an all-pass fixture must exit 0")

    // A non-Linux host cannot inspect ptrace/groups: unknown, not safe.
    const nonLinux = collectSecurityReport(
      allPassOptions({ platform: "darwin", ptraceScope: undefined, groups: [] }),
    )
    assert.strictEqual(nonLinux.checks.find((c) => c.name === "ptrace_scope").status, "unknown")
    assert.strictEqual(nonLinux.checks.find((c) => c.name === "privileged_groups").status, "unknown")
    assert.strictEqual(hardenedExitCode(nonLinux), 2, "unknown checks must refuse the hardened profile")

    console.log("✓ --require-hardened exits 2 on fail/unknown and 0 only when every check passes")
  }

  // ==========================================================================
  // 3. Caller-owned signer / approval dir failures
  // ==========================================================================
  {
    console.log("Testing caller-owned signer and approval directory probes...")
    const signerPath = join(testDir, "signer.sh")
    writeFileSync(signerPath, "#!/bin/sh\nexit 0\n")
    const signerReport = collectSecurityReport(
      allPassOptions({
        env: {
          OPENCODE_TEAMWORK_SIGNER: `command:${signerPath}`,
          OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY: "fixture-public-key",
        },
        euid: statSync(signerPath).uid,
      }),
    )
    const signerCheck = signerReport.checks.find((c) => c.name === "signer")
    assert.strictEqual(signerCheck.status, "fail", signerCheck.message)
    assert(/owned|writable/.test(signerCheck.message), signerCheck.message)

    const approvalDir = join(testDir, "writable-approvals")
    mkdirSync(approvalDir, { recursive: true })
    const approvalReport = collectSecurityReport(
      allPassOptions({
        env: { OPENCODE_TEAMWORK_APPROVAL_DIR: approvalDir },
        euid: statSync(approvalDir).uid,
      }),
    )
    const approvalCheck = approvalReport.checks.find((c) => c.name === "approval_dir")
    assert.strictEqual(approvalCheck.status, "fail", approvalCheck.message)
    assert(/owned or writable/.test(approvalCheck.message), approvalCheck.message)

    const insideRepo = join(testDir, "repo", "approvals")
    mkdirSync(insideRepo, { recursive: true })
    const insideReport = collectSecurityReport(
      allPassOptions({
        env: { OPENCODE_TEAMWORK_APPROVAL_DIR: insideRepo },
        euid: statSync(insideRepo).uid + 1,
        repoRoot: join(testDir, "repo"),
      }),
    )
    const insideCheck = insideReport.checks.find((c) => c.name === "approval_dir")
    assert.strictEqual(insideCheck.status, "fail", insideCheck.message)
    assert(/inside the repository/.test(insideCheck.message), insideCheck.message)

    const runRoot = join(testDir, "fixture-run")
    const insideRunDir = join(runRoot, "approvals")
    mkdirSync(insideRunDir, { recursive: true })
    const insideRunReport = collectSecurityReport(
      allPassOptions({
        env: { OPENCODE_TEAMWORK_APPROVAL_DIR: insideRunDir },
        euid: statSync(insideRunDir).uid + 1,
        repoRoot: join(testDir, "repo"),
        runDir: runRoot,
      }),
    )
    const insideRunCheck = insideRunReport.checks.find((c) => c.name === "approval_dir")
    assert.strictEqual(insideRunCheck.status, "fail", insideRunCheck.message)
    assert(/inside the run directory/.test(insideRunCheck.message), insideRunCheck.message)

    const detectiveReport = collectSecurityReport(
      allPassOptions({
        env: { OPENCODE_TEAMWORK_WITNESS: "command:/usr/bin/fixture-witness" },
        containmentMode: "detective",
      }),
    )
    const containment = detectiveReport.checks.find((c) => c.name === "containment")
    assert.strictEqual(containment.status, "fail", containment.message)

    console.log("✓ caller-owned signer and approval dirs fail; asserted trust levels require pinned containment")
  }

  // ==========================================================================
  // 3b. Containment mode, the pinned-write policy, and the hardened profile
  // ==========================================================================
  {
    console.log("Testing containment mode and REQUIRE_PINNED_WRITES visibility...")
    const pinned = collectSecurityReport(allPassOptions({ env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" } }))
    const pinnedCheck = pinned.checks.find((c) => c.name === "containment")
    assert.strictEqual(pinnedCheck.status, "pass", pinnedCheck.message)
    assert(/fdTraversalMode=pinned/.test(pinnedCheck.message), pinnedCheck.message)
    assert(/OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=0/.test(pinnedCheck.message), pinnedCheck.message)

    // Detective by default: advisory only, so the hardened profile is untouched.
    const detectiveDefault = collectSecurityReport(
      allPassOptions({ containmentMode: "detective", env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" } }),
    )
    const defaultCheck = detectiveDefault.checks.find((c) => c.name === "containment")
    assert.strictEqual(defaultCheck.status, "warn", defaultCheck.message)
    assert(/fdTraversalMode=detective/.test(defaultCheck.message), defaultCheck.message)
    assert(/OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=0/.test(defaultCheck.message), defaultCheck.message)
    assert.strictEqual(hardenedExitCode(detectiveDefault), 0, "a mere detective warning must not hard-fail")

    // The policy is asserted but the host cannot satisfy it: fail, exit 2.
    const asserted = collectSecurityReport(
      allPassOptions({
        containmentMode: "detective",
        env: { OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES: "1", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" },
      }),
    )
    const assertedCheck = asserted.checks.find((c) => c.name === "containment")
    assert.strictEqual(assertedCheck.status, "fail", assertedCheck.message)
    assert(/fdTraversalMode=detective/.test(assertedCheck.message), assertedCheck.message)
    assert(/OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1/.test(assertedCheck.message), assertedCheck.message)
    assert(/requirePinnedWrites is asserted/.test(assertedCheck.message), assertedCheck.message)
    assert.strictEqual(hardenedExitCode(asserted), 2, "an asserted policy on a detective host must fail --require-hardened")

    // Pinned + the policy is satisfied.
    const satisfied = collectSecurityReport(
      allPassOptions({
        containmentMode: "pinned",
        env: { OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES: "1", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" },
      }),
    )
    assert.strictEqual(satisfied.checks.find((c) => c.name === "containment").status, "pass")
    assert.strictEqual(hardenedExitCode(satisfied), 0)

    // The per-run plan flag is visible even when the env is off. Doctor must
    // hydrate it from plan.dag.json (fresh process) and the CLI also passes it.
    const planRun = join(testDir, "plan-flag-run")
    mkdirSync(planRun, { recursive: true })
    writeFileSync(join(planRun, "plan.dag.json"), JSON.stringify({ requirePinnedWrites: true }, null, 2))
    const planFlagged = collectSecurityReport(
      allPassOptions({
        containmentMode: "detective",
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" },
        runDir: planRun,
      }),
    )
    const planCheck = planFlagged.checks.find((c) => c.name === "containment")
    assert.strictEqual(planCheck.status, "fail", planCheck.message)
    assert(/planRequirePinnedWrites=1/.test(planCheck.message), planCheck.message)
    assert.strictEqual(hardenedExitCode(planFlagged), 2, "a plan-asserted policy must fail --require-hardened")
    const planExplicit = collectSecurityReport(
      allPassOptions({
        containmentMode: "detective",
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key" },
        planRequirePinnedWrites: true,
      }),
    )
    assert(/planRequirePinnedWrites=1/.test(planExplicit.checks.find((c) => c.name === "containment").message))
    assert.strictEqual(hardenedExitCode(planExplicit), 2)

    // The CLI passes the plan flag it read from the run directory.
    const cliProject = join(testDir, "cli-project")
    const cliRun = "20261124-000000-plan-flag"
    mkdirSync(join(cliProject, ".opencode", "teamwork", cliRun), { recursive: true })
    writeFileSync(
      join(cliProject, ".opencode", "teamwork", cliRun, "plan.dag.json"),
      JSON.stringify({ requirePinnedWrites: true }, null, 2),
    )
    const cliJson = spawnSync(
      process.execPath,
      [cliPath, "doctor", "--json", "--session", cliRun, "--config-dir", join(testDir, "cli-config")],
      {
        cwd: cliProject,
        encoding: "utf8",
        env: { ...process.env, OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES: "", OPENCODE_TEAMWORK_ANOMALY_AUDIT: join(testDir, "cli-anomalies.jsonl") },
      },
    )
    const cliParsed = JSON.parse(cliJson.stdout)
    const cliContainment = cliParsed.security.checks.find((c) => c.name === "containment")
    assert(/planRequirePinnedWrites=1/.test(cliContainment.message), cliContainment.message)

    // A5: an unacknowledged write anomaly is a doctor failure.
    const anomalyConfig = join(testDir, "anomaly-config")
    setWriteAnomalyAuditPathForTest(join(anomalyConfig, "teamwork", "write-anomalies.jsonl"))
    try {
      recordWriteAnomaly({ kind: "containment-mode", run: join(testDir, "some-run"), mode: "detective", detail: "fixture refusal" })
      const anomalyReport = collectSecurityReport(allPassOptions({ configDir: anomalyConfig }))
      const anomalyCheck = anomalyReport.checks.find((c) => c.name === "write_anomalies")
      assert.strictEqual(anomalyCheck.status, "fail", anomalyCheck.message)
      assert(/unacknowledged write anomaly/.test(anomalyCheck.message), anomalyCheck.message)
      assert.strictEqual(hardenedExitCode(anomalyReport), 2)
    } finally {
      setWriteAnomalyAuditPathForTest(null)
    }

    console.log("✓ doctor reports the containment mode, env setting and plan flag; an asserted policy on a detective host fails hardened")
  }

  // ==========================================================================
  // 4. Claim lint: forbidden phrase fails, a negated boundary note passes
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
