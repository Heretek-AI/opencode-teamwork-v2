// opencode-teamwork — doctor security section + security-claim lint tests
//
// Hermetic, zero-dependency coverage for `lib/security.mjs`, the
// `opencode-teamwork doctor --security/--json` surface, and
// `scripts/lint-security-claims.mjs`. Host probes are overridden so the test
// never depends on the developer's kernel groups or ptrace setting.

import { collectSecurityReport, hardenedExitCode, SECURITY_CHECK_NAMES } from "../lib/security.mjs"
import { TEAM_AGENTS } from "../lib/team.mjs"
import { recordWriteAnomaly, setWriteAnomalyAuditPathForTest } from "../plugins/opencode-teamwork/safe-fs.mjs"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
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

    // Approver private material visible to this process is a failure: the key
    // belongs to the approver's principal, not the workload's.
    const inlineKey = collectSecurityReport(
      allPassOptions({
        env: {
          OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY: "fixture-public-key",
          OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY: "fixture-private-key",
        },
      }),
    )
    const inlineCheck = inlineKey.checks.find((c) => c.name === "approval_key")
    assert.strictEqual(inlineCheck.status, "fail", `an inline approver key must fail: ${inlineCheck.message}`)
    assert(/visible to this process/.test(inlineCheck.message), inlineCheck.message)
    assert(/different principal/.test(inlineCheck.message), inlineCheck.message)

    const keyFile = join(testDir, "approver.pem")
    writeFileSync(keyFile, "fixture-private-key\n", { mode: 0o600 })
    const readableKey = collectSecurityReport(
      allPassOptions({
        env: {
          OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY: "fixture-public-key",
          OPENCODE_TEAMWORK_APPROVAL_KEY_FILE: keyFile,
        },
      }),
    )
    const readableCheck = readableKey.checks.find((c) => c.name === "approval_key")
    assert.strictEqual(readableCheck.status, "fail", `a readable approver key file must fail: ${readableCheck.message}`)

    // An approver key path this process cannot read is not visible: verify-only.
    const unreadableKey = collectSecurityReport(
      allPassOptions({
        env: {
          OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY: "fixture-public-key",
          OPENCODE_TEAMWORK_APPROVAL_KEY_FILE: join(testDir, "absent-approver.pem"),
        },
      }),
    )
    const unreadableCheck = unreadableKey.checks.find((c) => c.name === "approval_key")
    assert.strictEqual(unreadableCheck.status, "pass", unreadableCheck.message)
    assert(/no approver private material is readable/.test(unreadableCheck.message), unreadableCheck.message)

    // CI attestation key: verify-only is a pass, visible private material is a
    // failure, and `required` with no key is a warning.
    const { generateKeyPairSync } = await import("node:crypto")
    const attestationPair = generateKeyPairSync("ed25519")
    const attestationPublic = attestationPair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
    const attestationOk = collectSecurityReport(
      allPassOptions({ env: { OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY: attestationPublic } }),
    )
    const attestationOkCheck = attestationOk.checks.find((c) => c.name === "attestation_key")
    assert.strictEqual(attestationOkCheck.status, "pass", attestationOkCheck.message)
    assert(/verify-only Ed25519 CI attestation key/.test(attestationOkCheck.message), attestationOkCheck.message)

    const attestationPrivate = collectSecurityReport(
      allPassOptions({
        env: {
          OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY: attestationPublic,
          OPENCODE_TEAMWORK_ATTESTATION_PRIVATE_KEY: "fixture-private-key",
        },
      }),
    )
    const attestationPrivateCheck = attestationPrivate.checks.find((c) => c.name === "attestation_key")
    assert.strictEqual(attestationPrivateCheck.status, "fail", attestationPrivateCheck.message)
    assert(/CI signer key must live only in the CI principal/.test(attestationPrivateCheck.message))

    const requiredRun = join(testDir, "attestation-required-run")
    mkdirSync(requiredRun, { recursive: true })
    writeFileSync(
      join(requiredRun, "run.manifest.json"),
      JSON.stringify({ version: 5, attestationPolicy: "required" }),
    )
    const attestationMissing = collectSecurityReport(allPassOptions({ runDir: requiredRun }))
    const attestationMissingCheck = attestationMissing.checks.find((c) => c.name === "attestation_key")
    assert.strictEqual(attestationMissingCheck.status, "warn", attestationMissingCheck.message)
    assert(/attestationPolicy "required"/.test(attestationMissingCheck.message), attestationMissingCheck.message)

    // Signer approval directory: unset is a pass (v1), inside repo / caller
    // owned is a failure.
    const signerUnset = collectSecurityReport(allPassOptions())
    const signerUnsetCheck = signerUnset.checks.find((c) => c.name === "signer_approval_dir")
    assert.strictEqual(signerUnsetCheck.status, "pass", signerUnsetCheck.message)
    assert(/is not configured/.test(signerUnsetCheck.message), signerUnsetCheck.message)

    const signerInsideRepo = join(testDir, "repo", "signer-approvals")
    mkdirSync(signerInsideRepo, { recursive: true })
    const signerInsideReport = collectSecurityReport(
      allPassOptions({
        env: { OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR: signerInsideRepo },
        euid: statSync(signerInsideRepo).uid + 1,
        repoRoot: join(testDir, "repo"),
      }),
    )
    const signerInsideCheck = signerInsideReport.checks.find((c) => c.name === "signer_approval_dir")
    assert.strictEqual(signerInsideCheck.status, "fail", signerInsideCheck.message)
    assert(/inside the repository/.test(signerInsideCheck.message), signerInsideCheck.message)

    const signerOwned = join(testDir, "owned-signer-approvals")
    mkdirSync(signerOwned, { recursive: true })
    const signerOwnedReport = collectSecurityReport(
      allPassOptions({
        env: { OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR: signerOwned },
        euid: statSync(signerOwned).uid,
      }),
    )
    const signerOwnedCheck = signerOwnedReport.checks.find((c) => c.name === "signer_approval_dir")
    assert.strictEqual(signerOwnedCheck.status, "fail", signerOwnedCheck.message)
    assert(/owned or writable/.test(signerOwnedCheck.message), signerOwnedCheck.message)

    const signerRelative = collectSecurityReport(
      allPassOptions({ env: { OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR: "relative/signer-approvals" } }),
    )
    const signerRelativeCheck = signerRelative.checks.find((c) => c.name === "signer_approval_dir")
    assert.strictEqual(signerRelativeCheck.status, "fail", signerRelativeCheck.message)
    assert(/must be an absolute path/.test(signerRelativeCheck.message), signerRelativeCheck.message)

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

  // ==========================================================================
  // 5. AGENTS.md Rule #7 (OPENCODE_DB & channel DB resolution) & S3923 group names
  // ==========================================================================
  {
    console.log("Testing DB path resolution (Rule #7) and string/null group normalization (S3923)...")
    const dbRoot = join(testDir, "db-resolution")
    const xdgData = join(dbRoot, "xdg-data")
    const ocDir = join(xdgData, "opencode")
    mkdirSync(ocDir, { recursive: true })

    // 5a. OPENCODE_DB absolute path: 0600 passes, 0644 fails
    const absDb = join(dbRoot, "custom-abs.db")
    writeFileSync(absDb, "sqlite")
    chmodSync(absDb, 0o600)
    const absPass = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", OPENCODE_DB: absDb, HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    assert.strictEqual(absPass.checks.find((c) => c.name === "db_mode").status, "pass")

    chmodSync(absDb, 0o644)
    const absFail = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", OPENCODE_DB: absDb, HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    assert.strictEqual(absFail.checks.find((c) => c.name === "db_mode").status, "fail")

    // 5b. OPENCODE_DB relative path resolves against primary XDG_DATA_HOME/opencode root
    const relDb = join(ocDir, "rel-sub.db")
    writeFileSync(relDb, "sqlite")
    chmodSync(relDb, 0o644)
    const relFail = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", OPENCODE_DB: "rel-sub.db", HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    const relCheck = relFail.checks.find((c) => c.name === "db_mode")
    assert.strictEqual(relCheck.status, "fail")
    assert(relCheck.message.includes("rel-sub.db"), relCheck.message)

    // 5c. OPENCODE_DB=":memory:" passes without statting a file
    const memPass = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", OPENCODE_DB: ":memory:", HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    const memCheck = memPass.checks.find((c) => c.name === "db_mode")
    assert.strictEqual(memCheck.status, "pass")
    assert(memCheck.message.includes(":memory:"), memCheck.message)

    // 5d. OPENCODE_CHANNEL="nightly" inspects opencode-nightly.db even if opencode.db is 0600
    const defaultDb = join(ocDir, "opencode.db")
    const nightlyDb = join(ocDir, "opencode-nightly.db")
    writeFileSync(defaultDb, "sqlite")
    chmodSync(defaultDb, 0o600)
    writeFileSync(nightlyDb, "sqlite")
    chmodSync(nightlyDb, 0o644)
    const nightlyFail = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", OPENCODE_CHANNEL: "nightly", HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    const nightlyCheck = nightlyFail.checks.find((c) => c.name === "db_mode")
    assert.strictEqual(nightlyCheck.status, "fail")
    assert(nightlyCheck.message.includes("opencode-nightly.db"), nightlyCheck.message)

    // 5e. OPENCODE_CHANNEL="dev" (unscoped) and OPENCODE_DISABLE_CHANNEL_DB="1" inspect opencode.db
    const devPass = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", OPENCODE_CHANNEL: "dev", HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    assert.strictEqual(devPass.checks.find((c) => c.name === "db_mode").status, "pass")
    const disabledPass = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: {
          OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key",
          OPENCODE_CHANNEL: "nightly",
          OPENCODE_DISABLE_CHANNEL_DB: "1",
          HOME: dbRoot,
          XDG_DATA_HOME: xdgData,
        },
      }),
    )
    assert.strictEqual(disabledPass.checks.find((c) => c.name === "db_mode").status, "pass")

    // 5f. Default unset OPENCODE_CHANNEL prefers opencode-local.db over opencode.db
    const localDb = join(ocDir, "opencode-local.db")
    writeFileSync(localDb, "sqlite")
    chmodSync(localDb, 0o644)
    const localFail = collectSecurityReport(
      allPassOptions({
        dbPath: undefined,
        env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-public-key", HOME: dbRoot, XDG_DATA_HOME: xdgData },
      }),
    )
    const localCheck = localFail.checks.find((c) => c.name === "db_mode")
    assert.strictEqual(localCheck.status, "fail")
    assert(localCheck.message.includes("opencode-local.db"), localCheck.message)

    // 5g. S3923: string GIDs, group names, and null/undefined entries normalize cleanly
    const groupFile = join(dbRoot, "group-s3923")
    writeFileSync(groupFile, "users:x:1000:\ndocker:x:998:\n")
    const strGroupsReport = collectSecurityReport(
      allPassOptions({
        groupFile,
        groups: [null, undefined, "998", "wheel"],
      }),
    )
    const grpCheck = strGroupsReport.checks.find((c) => c.name === "privileged_groups")
    assert.strictEqual(grpCheck.status, "fail", grpCheck.message)
    assert(grpCheck.message.includes("docker") && grpCheck.message.includes("wheel"), grpCheck.message)

    // 5h. An unreadable group file must fail closed as UNKNOWN, not PASS.
    // A directory is unreadable as a file even for root, so this stays
    // discriminating on any runner.
    const unreadableReport = collectSecurityReport(
      allPassOptions({
        groupFile: dbRoot,
        groups: [998],
      }),
    )
    const unreadableCheck = unreadableReport.checks.find((c) => c.name === "privileged_groups")
    assert.strictEqual(unreadableCheck.status, "unknown", unreadableCheck.message)
    assert.match(unreadableCheck.message, /unreadable|cannot be verified/)

    console.log("✓ Rule #7 DB resolution (OPENCODE_DB, :memory:, channels, precedence) and S3923 group normalization pass")
  }

  console.log("All security tests passed")
} finally {
  rmSync(testDir, { recursive: true, force: true })
}
