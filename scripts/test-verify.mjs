// opencode-teamwork — offline verifier tests
//
// Hermetic fixtures. Every signed fixture is produced through the real
// `auth.ts` signer (Ed25519 or HMAC) and the real `handoff.ts` writer, then
// verified with only the public key and the bytes on disk.
//
// Run with plain Node: an uncaught assertion exits non-zero.

import assert from "node:assert"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { execFileSync } from "node:child_process"

import { createAuthContext } from "../plugins/opencode-teamwork/auth.ts"
import { writeHandoff } from "../plugins/opencode-teamwork/handoff.ts"
import { canonicalJson, contentSha256Hex, payloadDigest, sha256Hex } from "../plugins/opencode-teamwork/approval-format.mjs"
import {
  attestationKeyIdFromPublicKey,
  loadAttestationPrivateKey,
  signAttestation,
} from "../plugins/opencode-teamwork/attestation.mjs"
import {
  computePlanHash,
  computeRequirementsHash,
  renderVerify,
  verifyExitCode,
  verifyRun,
} from "../lib/verify.mjs"
import { resolveTrustedExecutable } from "../plugins/opencode-teamwork/safe-fs.mjs"

const TEST_ROOT = mkdtempSync(join(tmpdir(), "teamwork-verify-test-"))
const CLI = resolve("bin/opencode-teamwork.mjs")
let runCounter = 0

let passed = 0
function ok(name) {
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

function nextRunId(tag) {
  runCounter += 1
  const suffix = `${String(runCounter).padStart(3, "0")}-${tag}`
  return `20261124-120000${suffix}`.slice(0, 64)
}

function makeStorage() {
  const map = new Map()
  return {
    map,
    shim: {
      get: async (key) => map.get(key),
      set: async (key, value) => {
        map.set(key, value)
      },
      remove: async (key) => {
        map.delete(key)
      },
      scan: async () => ({ entries: [], hasMore: false }),
    },
  }
}

function makeSigner(alg) {
  const storage = makeStorage()
  const keyId = alg === "ed25519" ? "ed_fixture" : "k_fixture_hmac"
  const env = {}
  let publicKey
  let hmacKey
  if (alg === "ed25519") {
    const pair = generateKeyPairSync("ed25519")
    publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
    env.OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY = publicKey
    env.OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY = pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url")
    env.OPENCODE_TEAMWORK_ED25519_KEY_ID = keyId
  } else {
    hmacKey = randomBytes(32).toString("base64url")
    env.OPENCODE_TEAMWORK_HMAC_KEY = hmacKey
    env.OPENCODE_TEAMWORK_HMAC_KEY_ID = keyId
  }
  const auth = createAuthContext(storage.shim, env)
  return { alg, auth, storage, keyId, publicKey, hmacKey, env }
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2) + "\n")
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function keyedDigestFile(path) {
  return sha256Hex(readFileSync(path))
}

function plainDigestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function listFiles(root, prefix = "") {
  const out = []
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
    const abs = join(root, rel)
    if (dirent.isSymbolicLink()) out.push(rel)
    else if (dirent.isDirectory()) out.push(...listFiles(root, rel))
    else if (dirent.isFile()) out.push(rel)
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Build one run. The options select the modes and which artifacts are written.
 * The default is a complete, consistent signed run.
 */
async function makeRun({
  tag = "run",
  alg = "ed25519",
  signer = undefined,
  integrityMode = "development",
  verification = "standard",
  victoryAudit = "required",
  requireHandoffs = "required",
  requireReportBinding = false,
  provenance = "declared",
  attestationPolicy = "off",
  attestationKeyId = null,
  attestationIssuer = null,
  manifestVersion = 5,
  tasks = [{ id: "R1", agent: "team/worker" }],
  git = undefined,
  unsigned = false,
} = {}) {
  const ownSigner = signer ?? makeSigner(alg)
  const root = mkdtempSync(join(TEST_ROOT, `${tag}-`))
  const runId = nextRunId(tag)
  const run = join(root, ".opencode", "teamwork", runId)
  mkdirSync(join(run, "verify"), { recursive: true })
  mkdirSync(join(run, "handoffs"), { recursive: true })

  const request = `# Original Request\n\n- Integrity mode: ${integrityMode}\n- Recorded: 2026-11-24T12:00:00.000Z\n- Session: ${runId}\n\n## Request\n\nFixture request body.\n`
  writeText(join(run, "ORIGINAL_REQUEST.md"), request)
  const requirements = {
    version: 1,
    source: "request",
    items: tasks.map((t, i) => ({ id: t.id, text: `Requirement ${t.id}` })),
  }
  writeJson(join(run, "requirements.json"), requirements)
  const requestHash = sha256Hex(request)
  const requirementsHash = computeRequirementsHash(requirements)

  const plan = {
    version: 3,
    sessionId: runId,
    topology: "small-focused",
    integrityMode,
    verification,
    victoryAudit,
    ...(victoryAudit === "skip" ? { victorySkipReason: "fixture skip" } : {}),
    requireHandoffs,
    requireHandoffsSource: "plan",
    route: "coding",
    lemmaBounds: null,
    tasks: tasks.map((t) => ({
      id: t.id,
      agent: t.agent ?? "team/worker",
      title: `Task ${t.id}`,
      dependsOn: [],
    })),
    ...(requireReportBinding ? { requireReportBinding: true } : {}),
    ...(provenance === "command" ? { requiredProvenance: "command" } : {}),
    ...(manifestVersion >= 5
      ? {
          attestationPolicy,
          ...(attestationKeyId ? { attestationKeyId } : {}),
          ...(attestationIssuer ? { attestationIssuer } : {}),
        }
      : {}),
    requirePinnedWrites: false,
  }
  writeJson(join(run, "plan.dag.json"), plan)
  const state = {
    version: 3,
    sessionId: runId,
    phase: "MERGE",
    integrityMode,
    verification,
    victoryAudit,
    requireHandoffs,
    ...(provenance === "command" ? { requiredProvenance: "command" } : {}),
    ...(manifestVersion >= 5
      ? {
          attestationPolicy,
          ...(attestationKeyId ? { attestationKeyId } : {}),
          ...(attestationIssuer ? { attestationIssuer } : {}),
        }
      : {}),
    tasks: Object.fromEntries(
      tasks.map((t) => [t.id, { status: "verified_pass", round: 1 }]),
    ),
  }
  writeJson(join(run, "state.json"), state)

  const ctx = {
    root,
    run,
    runId,
    signer: ownSigner,
    plan,
    state,
    requirements,
    requestHash,
    requirementsHash,
    tasks,
    integrityMode,
    verification,
    victoryAudit,
    requireHandoffs,
    git,
    unsigned,
  }

  if (!unsigned) {
    const nonce = randomBytes(16).toString("base64url")
    await ownSigner.auth.bindRunNonce(runId, nonce)
    await ownSigner.auth.bindRunKeyId(runId, ownSigner.keyId)
    const manifest = {
      version: manifestVersion,
      sessionId: runId,
      rootSessionId: "ses_fixture_root",
      integrityMode,
      verification,
      victoryAudit,
      ...(victoryAudit === "skip" ? { victorySkipReason: "fixture skip" } : {}),
      requireHandoffs,
      handoffAuth: "signed",
      ...(provenance === "command" ? { requiredProvenance: "command" } : {}),
      ...(manifestVersion >= 5
        ? { attestationPolicy, attestationKeyId, attestationIssuer }
        : {}),
      requestHash,
      requirementsHash,
      planHash: computePlanHash(plan),
      lemmaPolicyHash: null,
      runKeyId: ownSigner.keyId,
      runNonce: nonce,
      trustLevel: ownSigner.alg === "ed25519" ? "external-signer" : "local-hmac",
      requireWitness: false,
      approvalPolicy: "none",
      approvalKeyId: null,
      specHash: null,
      specBytes: null,
      approvalDigest: null,
      approvalNonce: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: "2026-11-24T12:00:00.000Z",
    }
    const signed = await ownSigner.auth.signRunArtifact(runId, "run.manifest.json", manifest)
    writeJson(join(run, "run.manifest.json"), signed)
  }

  return ctx
}

async function signWrite(ctx, relPath, payload) {
  const signed = await ctx.signer.auth.signRunArtifact(ctx.runId, relPath, payload)
  writeJson(join(ctx.run, relPath), signed)
  return signed
}

async function writeUnsigned(ctx, relPath, payload) {
  writeJson(join(ctx.run, relPath), payload)
  return payload
}

async function writeWorkerHandoff(ctx, taskId, agent = "team/worker", conclusion = "Worker completed the task.") {
  return writeHandoff(ctx.run, {
    sessionId: ctx.runId,
    agent,
    agentSessionId: "ses_fixture_worker",
    taskId,
    round: 1,
    sections: {
      observation: `Observed task ${taskId}.`,
      logicChain: "Implemented and checked the change.",
      caveats: "Fixture narrative only.",
      conclusion,
      verificationMethod: "Ran the fixture checks.",
    },
    auth: ctx.signer.auth,
    requireSigned: true,
  })
}

async function writeRoleHandoff(ctx, agent, taskId, conclusion = "Recorded.") {
  return writeHandoff(ctx.run, {
    sessionId: ctx.runId,
    agent,
    agentSessionId: `ses_fixture_${handoffSlugSafe(agent)}`,
    ...(taskId ? { taskId } : {}),
    round: 1,
    sections: {
      observation: "Observed the evidence.",
      logicChain: "Followed the chain.",
      caveats: "None recorded.",
      conclusion,
      verificationMethod: "Read the cited artifacts.",
    },
    auth: ctx.signer.auth,
    requireSigned: true,
  })
}

function handoffSlugSafe(agent) {
  return String(agent).replace(/^team\//, "").replace(/[^a-z0-9-]/g, "") || "role"
}

function indexEntry(ctx, taskId, agent) {
  const index = readJson(join(ctx.run, "handoffs", "index.json"))
  return index.entries.find((entry) => entry.taskId === taskId && entry.agent === agent)
}

function makeReportPayload(ctx, taskId, {
  status = "PASS",
  summary = "Fixture verification passed.",
  output = "fixture output\n",
  exitCode = 0,
  extraChecks = [],
  headSha = undefined,
  diffHash = undefined,
  workerBinding = undefined,
} = {}) {
  const outputSha256 = output === "" ? undefined : sha256Hex(output)
  return {
    taskId,
    status,
    verifierAgent: "team/verifier",
    verifierSessionId: "ses_fixture_verifier",
    timestamp: "2026-11-24T12:01:00.000Z",
    summary,
    checks:
      status === "PASS"
        ? [
            {
              name: "fixture-check",
              type: "programmatic",
              passed: true,
              exitCode,
              output,
              ...(outputSha256 ? { outputSha256 } : {}),
            },
            ...extraChecks,
          ]
        : [],
    fatalFindings: [],
    feedbackForWorker: "",
    evidence: "fixture evidence",
    requirementsHash: ctx.requirementsHash,
    round: 1,
    fence: 1,
    branch: `teamwork/${ctx.runId}-${taskId}`,
    ...(workerBinding ? { workerHandoff: workerBinding } : {}),
    ...(headSha ? { headSha } : {}),
    ...(diffHash ? { diffHash } : {}),
    bound: Boolean(headSha && diffHash),
  }
}

function auditPayload(ctx, reportDigests, {
  status = "PASS",
  severityCounts = { critical: 0, high: 0, medium: 0, low: 0 },
  findings = [],
  finalDigest = null,
} = {}) {
  const rules = {
    development: ["fabricated_output"],
    demo: ["fabricated_output", "core_logic_copied", "delegated_core_work", "test_source_read"],
    benchmark: [
      "fabricated_output",
      "core_logic_copied",
      "delegated_core_work",
      "test_source_read",
      "external_dependency_used",
    ],
  }[ctx.integrityMode]
  return {
    sessionId: ctx.runId,
    integrityMode: ctx.integrityMode,
    status,
    timestamp: "2026-11-24T12:02:00.000Z",
    severityCounts,
    summary: "Fixture audit.",
    findings,
    integrityFindings: [],
    integrityViolations: [],
    ruleChecks: rules.map((rule) => ({ rule, result: "clean" })),
    reviewedDigests: { reports: reportDigests, final: finalDigest },
  }
}

function victoryPayload(ctx, reportDigests, auditDigest, { verdict = "VICTORY CONFIRMED" } = {}) {
  return {
    version: 1,
    sessionId: ctx.runId,
    verdict,
    auditor: "team/victory-auditor",
    auditorSessionId: "ses_fixture_victory_auditor",
    requestHash: ctx.requestHash,
    requirementsHash: ctx.requirementsHash,
    evidenceDigests: { reports: reportDigests, securityAudit: auditDigest, final: null },
    requirements: ctx.requirements.items.map((item) => ({
      id: item.id,
      met: true,
      evidence: `Fixture evidence for ${item.id}`,
    })),
    findings: [],
    summary: "Fixture independent audit.",
    generatedAt: "2026-11-24T12:03:00.000Z",
  }
}

function finalPayload(ctx, {
  status = "PASS",
  reportDigests,
  auditDigest,
  tasks,
  victory = "CONFIRMED",
  handoffs = "PASS",
  rerunDigest = undefined,
} = {}) {
  return {
    status,
    generatedBy: { agent: "team/verifier", session: "ses_fixture_verifier" },
    generatedAt: "2026-11-24T12:05:00.000Z",
    integrityMode: ctx.integrityMode,
    victory,
    handoffs,
    requirementsHash: ctx.requirementsHash,
    evidence: {
      tasks,
      securityAudit: { path: "verify/security-audit.json", status: "PASS" },
      allTasksVerifiedPass: status === "PASS",
      reportDigests,
      auditDigest,
      ...(rerunDigest !== undefined ? { rerunDigest } : {}),
      victory: { mode: ctx.victoryAudit, status: "CONFIRMED" },
      handoffs: { mode: ctx.requireHandoffs, status: "PASS", required: [], entries: [], reasons: [] },
    },
    reasons: [],
    contradictions: [],
    summary: "Fixture final verification.",
  }
}

/**
 * Build the default complete run: worker handoff -> report -> verifier handoff
 * -> audit -> victory -> victory handoff -> final, plus the run-level sentinel
 * handoff when the continuity matrix is required.
 */
async function buildComplete(ctx, {
  reportOptions = {},
  auditOptions = {},
  withFinal = true,
  withVictory = ctx.victoryAudit === "required",
  workerConclusion = "Worker completed the task.",
} = {}) {
  const reports = {}
  for (const task of ctx.tasks) {
    if (ctx.requireHandoffs === "required") {
      await writeWorkerHandoff(ctx, task.id, task.agent ?? "team/worker", workerConclusion)
    }
    const binding =
      ctx.requireHandoffs === "required"
        ? (() => {
            const entry = indexEntry(ctx, task.id, task.agent ?? "team/worker")
            return { taskId: task.id, agent: entry.agent, path: entry.path, sha256: entry.sha256 }
          })()
        : undefined
    const report = makeReportPayload(ctx, task.id, { ...reportOptions, workerBinding: binding })
    await signWrite(ctx, `verify/report-${task.id}.json`, report)
    reports[task.id] = keyedDigestFile(join(ctx.run, `verify/report-${task.id}.json`))
    if (ctx.requireHandoffs === "required") {
      await writeRoleHandoff(ctx, "team/verifier", task.id)
    }
  }

  const audit = auditPayload(ctx, { ...reports }, auditOptions)
  await signWrite(ctx, "verify/security-audit.json", audit)
  const auditDigest = keyedDigestFile(join(ctx.run, "verify/security-audit.json"))

  let victory
  if (withVictory) {
    victory = victoryPayload(ctx, { ...reports }, auditDigest)
    await signWrite(ctx, "verify/victory.json", victory)
    if (ctx.requireHandoffs === "required") {
      await writeRoleHandoff(ctx, "team/victory-auditor", undefined, "Victory confirmed.")
    }
  }

  if (ctx.requireHandoffs === "required") {
    await writeRoleHandoff(ctx, "team/sentinel", undefined, "Run-level continuity recorded.")
  }

  if (withFinal) {
    const final = finalPayload(ctx, {
      reportDigests: { ...reports },
      auditDigest,
      tasks: ctx.tasks.map((task) => ({
        id: task.id,
        status: "verified_pass",
        report: `verify/report-${task.id}.json`,
        reportStatus: "PASS",
      })),
      victory: withVictory ? "CONFIRMED" : "SKIPPED (explicit): fixture skip",
      handoffs: ctx.requireHandoffs === "required" ? "PASS" : "SKIPPED (explicit)",
    })
    await signWrite(ctx, "verify/final.json", final)
  }
  return { reports, auditDigest, withVictory }
}

/**
 * A checks[] v2 programmatic entry. The engine computes every provenance field;
 * the fixture computes the same values so the verifier can recompute them.
 */
function makeCommandCheck({
  name = "command-check",
  command,
  output,
  cwd = ".",
  exitCode = 0,
  durationMs = 1,
  outputTruncated = false,
  timeoutMs = 10000,
} = {}) {
  const cwdNorm = cwd === "." ? "." : cwd
  return {
    name,
    type: "programmatic",
    passed: exitCode === 0,
    exitCode,
    output,
    ...(output !== "" ? { outputSha256: sha256Hex(output) } : {}),
    command,
    cwd: cwdNorm,
    commandSha256: contentSha256Hex(canonicalJson({ argv: command, cwd: cwdNorm })),
    outputBytes: Buffer.byteLength(output, "utf8"),
    outputTruncated,
    durationMs,
    timeoutMs,
  }
}

/** The signed rerun projection for one check. */
function rerunEntryFromCheck(check, { timeoutMs = check.timeoutMs ?? 10000 } = {}) {
  return {
    name: check.name,
    argv: check.command,
    cwd: check.cwd,
    expectedExit: check.exitCode,
    outputSha256: contentSha256Hex(check.output),
    outputBytes: Buffer.byteLength(check.output, "utf8"),
    timeoutMs,
  }
}

// ---------------------------------------------------------------------------
// CI attestation fixtures (0.18.0)
// ---------------------------------------------------------------------------

const ATTESTATION_ISSUER = "https://ci.example.invalid/issuer"

function makeAttestationKeys(keyId = undefined) {
  const pair = generateKeyPairSync("ed25519")
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  return {
    pair,
    keyId: keyId ?? attestationKeyIdFromPublicKey(publicKey),
    publicKey,
    privateKey: pair.privateKey,
  }
}

/** A declared run with a command check and a report head, plus required policy. */
async function attestationFixture(tag, { policy = "required", issuer = ATTESTATION_ISSUER } = {}) {
  const ctx = await makeRun({
    tag,
    requireHandoffs: "skip",
    victoryAudit: "skip",
    attestationPolicy: policy,
    attestationIssuer: issuer,
  })
  const headSha = "a".repeat(40)
  const check = makeCommandCheck({
    command: [process.execPath, "-e", "process.stdout.write('attested-ok\\n')"],
    output: "attested-ok\n",
  })
  await buildComplete(ctx, {
    reportOptions: { headSha, diffHash: "b".repeat(64), extraChecks: [check] },
  })
  return { ctx, headSha, check }
}

function attestationPayloadFor(ctx, overrides = {}) {
  const manifest = readJson(join(ctx.run, "run.manifest.json"))
  const report = readJson(join(ctx.run, "verify", "report-R1.json"))
  const check = report.checks.find((entry) => Array.isArray(entry.command))
  return {
    v: 1,
    provider: "github-actions",
    workflow: "ci-attestation",
    runId: ctx.runId,
    runAttempt: 1,
    repository: "example/repo",
    commitSha: report.headSha,
    baseSha: "c".repeat(40),
    promptHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    planHash: manifest.planHash,
    manifestDigest: payloadDigest(manifest),
    commands: [
      {
        argv: check.command,
        cwd: check.cwd,
        exitCode: check.exitCode,
        outputSha256: contentSha256Hex(check.output),
        outputBytes: Buffer.byteLength(check.output, "utf8"),
      },
    ],
    oidc: {
      issuer: ATTESTATION_ISSUER,
      subject: "repo:example/repo:ref:refs/heads/main",
      audience: "opencode-teamwork",
    },
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

function writeAttestation(ctx, payload, keys, options = {}) {
  const artifact = signAttestation(payload, {
    privateKey: keys.privateKey,
    keyId: keys.keyId,
    nonce: options.nonce ?? readJson(join(ctx.run, "run.manifest.json")).runNonce,
  })
  writeJson(join(ctx.run, "verify/ci/attestation.json"), artifact)
  return artifact
}


/** Build a complete `command`-provenance run around one or more v2 checks. */
async function buildCommandRun(ctx, {
  checks,
  headSha,
  rerunChecks,
  withFinal = true,
  withRerun = true,
} = {}) {
  const report = {
    taskId: "R1",
    status: "PASS",
    verifierAgent: "team/verifier",
    verifierSessionId: "ses_fixture_verifier",
    timestamp: "2026-11-24T12:01:00.000Z",
    summary: "Fixture command verification passed.",
    checks,
    fatalFindings: [],
    feedbackForWorker: "",
    evidence: "fixture command evidence",
    requirementsHash: ctx.requirementsHash,
    round: 1,
    fence: 1,
    branch: `teamwork/${ctx.runId}-R1`,
    ...(headSha ? { headSha } : {}),
    bound: Boolean(headSha),
  }
  await signWrite(ctx, "verify/report-R1.json", report)
  const reportDigest = keyedDigestFile(join(ctx.run, "verify/report-R1.json"))
  const audit = auditPayload(ctx, { R1: reportDigest })
  await signWrite(ctx, "verify/security-audit.json", audit)
  const auditDigest = keyedDigestFile(join(ctx.run, "verify/security-audit.json"))
  let rerunDigest
  if (withRerun) {
    await signWrite(ctx, "verify/rerun.json", {
      version: 1,
      sessionId: ctx.runId,
      tasks: { R1: { checks: rerunChecks ?? checks.map((check) => rerunEntryFromCheck(check)) } },
      generatedAt: "2026-11-24T12:04:00.000Z",
    })
    rerunDigest = keyedDigestFile(join(ctx.run, "verify/rerun.json"))
  }
  if (withFinal) {
    const final = finalPayload(ctx, {
      reportDigests: { R1: reportDigest },
      auditDigest,
      tasks: [{ id: "R1", status: "verified_pass", report: "verify/report-R1.json", reportStatus: "PASS" }],
      victory: "SKIPPED (explicit): fixture skip",
      handoffs: "SKIPPED (explicit)",
      ...(rerunDigest !== undefined ? { rerunDigest } : {}),
    })
    await signWrite(ctx, "verify/final.json", final)
  }
  return { reportDigest, auditDigest, rerunDigest }
}

async function commandFixture(tag, overrides = {}) {
  const repo = mkdtempSync(join(TEST_ROOT, `${tag}-repo-`))
  const sha = initGitRepo(repo)
  const ctx = await makeRun({ tag, provenance: "command", requireHandoffs: "skip", victoryAudit: "skip" })
  const command = overrides.command ?? [process.execPath, "-e", "process.stdout.write('ok\\n')"]
  const check = makeCommandCheck({ ...overrides, command, output: overrides.output ?? "ok\n" })
  const headSha = overrides.headSha === null ? undefined : overrides.headSha ?? sha
  const built = await buildCommandRun(ctx, {
    checks: overrides.checks ?? [check],
    headSha,
    ...(overrides.rerunChecks ? { rerunChecks: overrides.rerunChecks } : {}),
  })
  return { repo, sha, ctx, check, ...built }
}

/** Unkeyed hash of a directory's working tree, used to prove --rerun is read-only. */
function hashTree(root, prefix = "") {
  const out = []
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (prefix === "" && dirent.name === ".git") continue
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
    const abs = join(root, rel)
    if (dirent.isSymbolicLink()) out.push([rel, "symlink"])
    else if (dirent.isDirectory()) out.push(...hashTree(root, rel))
    else if (dirent.isFile()) out.push([rel, plainDigestFile(abs)])
  }
  return contentSha256Hex(canonicalJson(out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
}

async function verify(ctx, extra = {}) {
  return verifyRun({
    runDir: ctx.run,
    publicKey: ctx.signer.alg === "ed25519" ? ctx.signer.publicKey : undefined,
    ...(ctx.signer.alg === "ed25519" ? { keyId: ctx.signer.keyId } : {}),
    ...(ctx.signer.alg === "hmac-sha256" ? { hmacKey: ctx.signer.hmacKey, hmacKeyId: ctx.signer.keyId } : {}),
    ...extra,
  })
}

function hasReason(result, code) {
  return result.reasons.some((reason) => reason.includes(code))
}

function checkIds(result) {
  return result.checks.map((check) => check.id)
}

function runCli(args, timeout = 30000, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env, ...extraEnv },
    })
    return { code: 0, stdout, stderr: "" }
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

function signedArgs(ctx) {
  return ctx.signer.alg === "ed25519"
    ? ["--public-key", ctx.signer.publicKey, "--key-id", ctx.signer.keyId]
    : ["--hmac-key", ctx.signer.hmacKey, "--hmac-key-id", ctx.signer.keyId]
}

function gitRun(cwd, args) {
  const gitBin = resolveTrustedExecutable("git")
  assert(gitBin, "git executable must be available")
  return execFileSync(gitBin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function initGitRepo(root) {
  gitRun(root, ["init", "-q"])
  gitRun(root, ["config", "user.email", "fixture@example.test"])
  gitRun(root, ["config", "user.name", "Fixture"])
  writeText(join(root, "README.md"), "fixture\n")
  gitRun(root, ["add", "README.md"])
  gitRun(root, ["commit", "-q", "-m", "base"])
  return gitRun(root, ["rev-parse", "HEAD"])
}

async function main() {
  // -------------------------------------------------------------------------
  // T01 — a valid Ed25519 run verifies with only the public key.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t01" })
    await buildComplete(ctx)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "PASS", JSON.stringify(result.reasons))
    assert.strictEqual(result.counts.fail, 0)
    assert.strictEqual(result.counts.unknown, 0)
    assert.strictEqual(verifyExitCode(result), 0)
    assert(result.counts.pass > 0)
    assert.strictEqual(result.trust.alg, "ed25519")
    assert.strictEqual(result.trust.keyId, ctx.signer.keyId)
    const cli = runCli(["verify", "--run-dir", ctx.run, ...signedArgs(ctx), "--json"])
    assert.strictEqual(cli.code, 0, cli.stderr)
    assert.strictEqual(JSON.parse(cli.stdout).verdict, "PASS")
    ok("T01 valid Ed25519 run verifies (exit 0, required checks pass)")
  }

  // -------------------------------------------------------------------------
  // T02 — flip a byte in a signed report.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t02" })
    await buildComplete(ctx)
    const path = join(ctx.run, "verify", "report-R1.json")
    const text = readFileSync(path, "utf8").replace("Fixture verification passed.", "XFixture verification passed.")
    writeFileSync(path, text)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert.strictEqual(verifyExitCode(result), 1)
    assert(hasReason(result, "AUTH_INVALID"), JSON.stringify(result.reasons))
    assert.strictEqual(runCli(["verify", "--run-dir", ctx.run, ...signedArgs(ctx), "--json"]).code, 1)
    ok("T02 flipped report byte -> AUTH_INVALID (exit 1)")
  }

  // -------------------------------------------------------------------------
  // T03 — copy an `_auth` envelope from another run.
  // -------------------------------------------------------------------------
  {
    const signer = makeSigner("ed25519")
    const a = await makeRun({ tag: "t03a", signer })
    const b = await makeRun({ tag: "t03b", signer })
    await buildComplete(a)
    await buildComplete(b)
    const reportA = readJson(join(a.run, "verify", "report-R1.json"))
    const reportB = readJson(join(b.run, "verify", "report-R1.json"))
    assert.notStrictEqual(reportA._auth.nonce, reportB._auth.nonce)
    reportA._auth = reportB._auth
    writeJson(join(a.run, "verify", "report-R1.json"), reportA)
    const result = await verify(a)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUTH_INVALID"))
    assert(
      result.reasons.some((r) => r.includes("nonce") || r.includes("digest") || r.includes("path")),
      JSON.stringify(result.reasons),
    )
    ok("T03 copied _auth from another run -> AUTH_INVALID")
  }

  // -------------------------------------------------------------------------
  // T04 — edit a report after the victory audit (re-signed, so auth is valid).
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t04" })
    await buildComplete(ctx)
    const rel = "verify/report-R1.json"
    const report = readJson(join(ctx.run, rel))
    report.summary = "Rewritten after the victory audit."
    const signed = await ctx.signer.auth.signRunArtifact(ctx.runId, rel, report)
    writeJson(join(ctx.run, rel), signed)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUTH_STALE"), JSON.stringify(result.reasons))
    assert(checkIds(result).includes("victory:evidenceDigests"))
    ok("T04 report edited after victory -> AUTH_STALE (evidenceDigests)")
  }

  // -------------------------------------------------------------------------
  // T05 — edit a report after the security audit.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t05" })
    await buildComplete(ctx)
    const rel = "verify/report-R1.json"
    const report = readJson(join(ctx.run, rel))
    report.summary = "Rewritten after the security audit."
    const signed = await ctx.signer.auth.signRunArtifact(ctx.runId, rel, report)
    writeJson(join(ctx.run, rel), signed)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUTH_STALE"))
    assert(checkIds(result).includes("audit:reviewedDigests"))
    ok("T05 report edited after audit -> AUTH_STALE (reviewedDigests)")
  }

  // -------------------------------------------------------------------------
  // T06 — delete a ruleChecks entry (audit re-signed so auth still passes).
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t06", integrityMode: "demo" })
    await buildComplete(ctx)
    const rel = "verify/security-audit.json"
    const audit = readJson(join(ctx.run, rel))
    audit.ruleChecks = audit.ruleChecks.filter((check) => check.rule !== "core_logic_copied")
    const signed = await ctx.signer.auth.signRunArtifact(ctx.runId, rel, audit)
    writeJson(join(ctx.run, rel), signed)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUDIT_RULE_MISSING"), JSON.stringify(result.reasons))
    ok("T06 deleted ruleChecks entry -> missing forbidden rule (exit 1)")
  }

  // -------------------------------------------------------------------------
  // T07 — wave cite missing / edited / resized.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({
      tag: "t07",
      verification: "strict",
      victoryAudit: "skip",
      requireHandoffs: "skip",
    })
    const evidenceRel = "verify/evidence/trace.txt"
    writeText(join(ctx.run, evidenceRel), "trace v1\n")
    const evidence = {
      path: evidenceRel,
      sha256: plainDigestFile(join(ctx.run, evidenceRel)),
      bytes: statSync(join(ctx.run, evidenceRel)).size,
    }
    const report = makeReportPayload(ctx, "R1")
    await signWrite(ctx, "verify/report-R1.json", report)
    const reportHash = plainDigestFile(join(ctx.run, "verify/report-R1.json"))
    for (const kind of ["challenge", "audit"]) {
      await signWrite(ctx, `verify/${kind}-R1.json`, {
        version: 1,
        sessionId: ctx.runId,
        taskId: "R1",
        kind,
        verdict: kind === "challenge" ? "PASS" : "CLEAN",
        agent: kind === "challenge" ? "team/falsifier" : "team/security-auditor",
        agentSessionId: `ses_fixture_${kind}`,
        reportHash,
        cites: [evidence],
        notes: "Fixture wave.",
        evidence: evidenceRel,
        generatedAt: "2026-11-24T12:02:00.000Z",
      })
    }

    const base = await verify(ctx)
    assert.strictEqual(base.verdict, "PASS", JSON.stringify(base.reasons))

    // missing
    rmSync(join(ctx.run, evidenceRel))
    const missing = await verify(ctx)
    assert.strictEqual(missing.verdict, "FAIL")
    assert(hasReason(missing, "AUTH_STALE"))

    // restore, then edit
    writeText(join(ctx.run, evidenceRel), "trace v1\n")
    writeText(join(ctx.run, evidenceRel), "trace v2\n")
    const edited = await verify(ctx)
    assert.strictEqual(edited.verdict, "FAIL")
    assert(hasReason(edited, "AUTH_STALE"))
    assert(edited.reasons.some((r) => r.includes("changed since it was recorded")))

    // resize while keeping the recorded hash (tests the byte-length relation)
    writeText(join(ctx.run, evidenceRel), "trace v1\n")
    const wave = readJson(join(ctx.run, "verify", "challenge-R1.json"))
    wave.cites = [{ ...evidence, bytes: evidence.bytes + 1 }]
    const signedWave = await ctx.signer.auth.signRunArtifact(ctx.runId, "verify/challenge-R1.json", wave)
    writeJson(join(ctx.run, "verify", "challenge-R1.json"), signedWave)
    const resized = await verify(ctx)
    assert.strictEqual(resized.verdict, "FAIL")
    assert(resized.reasons.some((r) => r.includes("byte length changed")), JSON.stringify(resized.reasons))
    ok("T07 wave cite missing/edited/resized -> stale (exit 1)")
  }

  // -------------------------------------------------------------------------
  // T08 — re-record the worker handoff after the report.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t08" })
    await buildComplete(ctx)
    await writeWorkerHandoff(ctx, "R1", "team/worker", "Rewritten worker narrative after the report.")
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "REPORT_HANDOFF_STALE"), JSON.stringify(result.reasons))
    ok("T08 re-recorded worker handoff -> REPORT_HANDOFF_STALE")
  }

  // -------------------------------------------------------------------------
  // T09 — a commit after the report's headSha (with --repo).
  // -------------------------------------------------------------------------
  const buildMovedBranch = async (tag) => {
    const ctx = await makeRun({ tag, requireHandoffs: "skip", victoryAudit: "skip" })
    const base = initGitRepo(ctx.root)
    gitRun(ctx.root, ["branch", `teamwork/base-${ctx.runId}`, base])
    gitRun(ctx.root, ["checkout", "-q", "-b", `teamwork/${ctx.runId}-R1`])
    writeText(join(ctx.root, "task.txt"), "one\n")
    gitRun(ctx.root, ["add", "task.txt"])
    gitRun(ctx.root, ["commit", "-q", "-m", "task one"])
    const head1 = gitRun(ctx.root, ["rev-parse", "HEAD"])
    const diff1 = gitRun(ctx.root, ["diff", "--no-color", `${base}..${head1}`])
    const report = makeReportPayload(ctx, "R1", {
      headSha: head1,
      diffHash: sha256Hex(diff1),
    })
    await signWrite(ctx, "verify/report-R1.json", report)
    writeText(join(ctx.root, "task.txt"), "two\n")
    gitRun(ctx.root, ["add", "task.txt"])
    gitRun(ctx.root, ["commit", "-q", "-m", "task two"])
    return ctx
  }
  {
    const ctx = await buildMovedBranch("t09")
    const result = await verify(ctx, { repo: ctx.root })
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "INCONSISTENT_REPORT_BRANCH"), JSON.stringify(result.reasons))
    const cli = runCli(["verify", "--run-dir", ctx.run, ...signedArgs(ctx), "--repo", ctx.root, "--json"])
    assert.strictEqual(cli.code, 1, cli.stderr)
    ok("T09 commit after headSha -> INCONSISTENT_REPORT_BRANCH (with --repo)")
  }

  // -------------------------------------------------------------------------
  // T10 — each named contradiction.
  // -------------------------------------------------------------------------
  {
    // 10a: CONFIRMED victory over a failing task.
    const ctx = await makeRun({ tag: "t10a", requireHandoffs: "skip" })
    const report = makeReportPayload(ctx, "R1", { status: "FAIL", summary: "Task failed." })
    await signWrite(ctx, "verify/report-R1.json", report)
    const reportDigest = keyedDigestFile(join(ctx.run, "verify/report-R1.json"))
    const audit = auditPayload(ctx, { R1: reportDigest })
    await signWrite(ctx, "verify/security-audit.json", audit)
    const auditDigest = keyedDigestFile(join(ctx.run, "verify/security-audit.json"))
    await signWrite(ctx, "verify/victory.json", victoryPayload(ctx, { R1: reportDigest }, auditDigest))
    ctx.state.tasks.R1.status = "verified_fail"
    writeJson(join(ctx.run, "state.json"), ctx.state)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "INCONSISTENT_VICTORY_TASK"), JSON.stringify(result.reasons))
  }
  {
    // 10b: PASS report computed against a moved branch.
    const ctx = await buildMovedBranch("t10b")
    const result = await verify(ctx, { repo: ctx.root })
    assert(hasReason(result, "INCONSISTENT_REPORT_BRANCH"))
  }
  {
    // 10c: PASS audit with a High finding.
    const ctx = await makeRun({ tag: "t10c", requireHandoffs: "skip" })
    await buildComplete(ctx, {
      reportOptions: {},
      auditOptions: { severityCounts: { critical: 0, high: 1, medium: 0, low: 0 } },
    })
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "INCONSISTENT_AUDIT_HIGH"), JSON.stringify(result.reasons))
  }
  {
    // 10d: wave verdict bound to the current FAIL report.
    const ctx = await makeRun({
      tag: "t10d",
      verification: "strict",
      victoryAudit: "skip",
      requireHandoffs: "skip",
    })
    const report = makeReportPayload(ctx, "R1", { status: "FAIL", summary: "Task failed." })
    await signWrite(ctx, "verify/report-R1.json", report)
    const reportHash = plainDigestFile(join(ctx.run, "verify/report-R1.json"))
    writeText(join(ctx.run, "verify/evidence/trace.txt"), "trace\n")
    const cite = {
      path: "verify/evidence/trace.txt",
      sha256: plainDigestFile(join(ctx.run, "verify/evidence/trace.txt")),
      bytes: statSync(join(ctx.run, "verify/evidence/trace.txt")).size,
    }
    for (const kind of ["challenge", "audit"]) {
      await signWrite(ctx, `verify/${kind}-R1.json`, {
        version: 1,
        sessionId: ctx.runId,
        taskId: "R1",
        kind,
        verdict: kind === "challenge" ? "PASS" : "CLEAN",
        agent: kind === "challenge" ? "team/falsifier" : "team/security-auditor",
        agentSessionId: `ses_fixture_${kind}`,
        reportHash,
        cites: [cite],
        notes: "Fixture wave over a FAIL report.",
        evidence: cite.path,
        generatedAt: "2026-11-24T12:02:00.000Z",
      })
    }
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "INCONSISTENT_WAVE_REPORT"), JSON.stringify(result.reasons))
  }
  ok("T10 each contradiction -> exit 1 with its code")

  // -------------------------------------------------------------------------
  // T11 — legacy victory without evidenceDigests.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t11", requireHandoffs: "skip" })
    const built = await buildComplete(ctx, { withFinal: false })
    const rel = "verify/victory.json"
    const victory = readJson(join(ctx.run, rel))
    delete victory.evidenceDigests
    const signed = await ctx.signer.auth.signRunArtifact(ctx.runId, rel, victory)
    writeJson(join(ctx.run, rel), signed)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUTH_STALE"))
    assert(result.reasons.some((r) => r.includes("no evidenceDigests")), JSON.stringify(result.reasons))
    ok("T11 legacy victory without digests -> AUTH_STALE")
  }

  // -------------------------------------------------------------------------
  // T12 — `cites: []` under strict fails; absent cites warns.
  // -------------------------------------------------------------------------
  {
    const makeWaveRun = async (tag) => {
      const ctx = await makeRun({
        tag,
        verification: "strict",
        victoryAudit: "skip",
        requireHandoffs: "skip",
      })
      const report = makeReportPayload(ctx, "R1")
      await signWrite(ctx, "verify/report-R1.json", report)
      const reportHash = plainDigestFile(join(ctx.run, "verify/report-R1.json"))
      writeText(join(ctx.run, "verify/evidence/trace.txt"), "trace\n")
      const cite = {
        path: "verify/evidence/trace.txt",
        sha256: plainDigestFile(join(ctx.run, "verify/evidence/trace.txt")),
        bytes: statSync(join(ctx.run, "verify/evidence/trace.txt")).size,
      }
      await signWrite(ctx, "verify/challenge-R1.json", {
        version: 1,
        sessionId: ctx.runId,
        taskId: "R1",
        kind: "challenge",
        verdict: "PASS",
        agent: "team/falsifier",
        agentSessionId: "ses_fixture_falsifier",
        reportHash,
        cites: [cite],
        notes: "Fixture.",
        evidence: cite.path,
        generatedAt: "2026-11-24T12:02:00.000Z",
      })
      await signWrite(ctx, "verify/audit-R1.json", {
        version: 1,
        sessionId: ctx.runId,
        taskId: "R1",
        kind: "audit",
        verdict: "CLEAN",
        agent: "team/security-auditor",
        agentSessionId: "ses_fixture_security_auditor",
        reportHash,
        cites: [cite],
        notes: "Fixture.",
        evidence: cite.path,
        generatedAt: "2026-11-24T12:02:00.000Z",
      })
      return ctx
    }

    const empty = await makeWaveRun("t12empty")
    const emptyWave = readJson(join(empty.run, "verify", "challenge-R1.json"))
    emptyWave.cites = []
    writeJson(
      join(empty.run, "verify", "challenge-R1.json"),
      await empty.signer.auth.signRunArtifact(empty.runId, "verify/challenge-R1.json", emptyWave),
    )
    const emptyResult = await verify(empty)
    assert.strictEqual(emptyResult.verdict, "FAIL")
    assert(hasReason(emptyResult, "WAVE_UNBOUND"), JSON.stringify(emptyResult.reasons))

    const absent = await makeWaveRun("t12absent")
    const absentWave = readJson(join(absent.run, "verify", "challenge-R1.json"))
    delete absentWave.cites
    writeJson(
      join(absent.run, "verify", "challenge-R1.json"),
      await absent.signer.auth.signRunArtifact(absent.runId, "verify/challenge-R1.json", absentWave),
    )
    const absentResult = await verify(absent)
    assert.strictEqual(absentResult.verdict, "PASS", JSON.stringify(absentResult.reasons))
    assert(absentResult.counts.warn > 0)
    assert(absentResult.checks.some((c) => c.status === "warn" && c.detail.includes("legacy_unbound_wave")))
    assert.strictEqual(verifyExitCode(absentResult, { failOnWarning: true }), 1)
    ok("T12 cites: [] under strict -> fail; absent -> warn (--fail-on-warning exits 1)")
  }

  // -------------------------------------------------------------------------
  // T13 — unbound PASS under requireReportBinding.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({
      tag: "t13",
      requireHandoffs: "skip",
      victoryAudit: "skip",
      requireReportBinding: true,
    })
    const report = makeReportPayload(ctx, "R1")
    await signWrite(ctx, "verify/report-R1.json", report)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "REPORT_UNBOUND"), JSON.stringify(result.reasons))
    ok("T13 unbound PASS under requireReportBinding -> REPORT_UNBOUND")
  }

  // -------------------------------------------------------------------------
  // T14 — unsigned legacy is UNKNOWN, never PASS.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t14", unsigned: true, requireHandoffs: "skip", victoryAudit: "skip" })
    const report = makeReportPayload(ctx, "R1", { workerBinding: undefined })
    writeJson(join(ctx.run, "verify/report-R1.json"), report)
    const result = await verify(ctx, { hmacKey: undefined })
    assert.strictEqual(result.verdict, "UNKNOWN")
    assert.strictEqual(verifyExitCode(result), 2)
    assert.notStrictEqual(result.verdict, "PASS")
    assert(hasReason(result, "UNSIGNED_LEGACY"))
    const allowed = await verify(ctx, { allowUnsigned: true })
    assert.strictEqual(allowed.verdict, "UNKNOWN")
    assert.strictEqual(verifyExitCode(allowed), 2)
    ok("T14 unsigned legacy -> UNKNOWN (exit 2), never PASS")
  }

  // -------------------------------------------------------------------------
  // T15 — HMAC run without --hmac-key.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t15", alg: "hmac-sha256" })
    await buildComplete(ctx)
    const result = await verifyRun({ runDir: ctx.run })
    assert.strictEqual(result.verdict, "UNKNOWN")
    assert.strictEqual(verifyExitCode(result), 2)
    assert(hasReason(result, "AUTH_UNAVAILABLE"), JSON.stringify(result.reasons))
    assert.strictEqual(result.trust.alg, "hmac-sha256")
    const withKey = await verify(ctx)
    assert.strictEqual(withKey.verdict, "PASS", JSON.stringify(withKey.reasons))
    ok("T15 HMAC run without --hmac-key -> UNKNOWN (exit 2)")
  }

  // -------------------------------------------------------------------------
  // T16 — index snapshot detects a rollback; no snapshot cannot.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t16" })
    await buildComplete(ctx)
    // Add a file, snapshot the newer set, then remove it. The resulting run is
    // a valid earlier signed set: every internal relation still verifies.
    writeText(join(ctx.run, "verify", "evidence", "late.txt"), "late\n")
    const snapshotPath = join(TEST_ROOT, `${ctx.runId}-snapshot.json`)
    const snapshot = {
      version: 1,
      runId: ctx.runId,
      generatedAt: "2026-11-24T12:06:00.000Z",
      files: Object.fromEntries(
        listFiles(ctx.run).map((rel) => [rel, plainDigestFile(join(ctx.run, rel))]),
      ),
    }
    writeJson(snapshotPath, snapshot)
    rmSync(join(ctx.run, "verify", "evidence", "late.txt"))

    const rolledBack = await verify(ctx, { requireIndex: snapshotPath })
    assert.strictEqual(rolledBack.verdict, "FAIL")
    assert.strictEqual(verifyExitCode(rolledBack), 1)
    assert(hasReason(rolledBack, "INDEX_ROLLBACK"), JSON.stringify(rolledBack.reasons))

    const noSnapshot = await verify(ctx, { requireIndex: true })
    assert.strictEqual(noSnapshot.verdict, "UNKNOWN")
    assert.strictEqual(verifyExitCode(noSnapshot), 2)
    assert(hasReason(noSnapshot, "INDEX_SNAPSHOT_REQUIRED"))

    // Documented residual: without --require-index the rollback is invisible.
    const silent = await verify(ctx)
    assert.strictEqual(silent.verdict, "PASS")
    assert(silent.checks.some((c) => c.id === "index:snapshot") === false)
    ok("T16 index rollback -> FAIL with snapshot, UNKNOWN when requested without one")
  }

  // -------------------------------------------------------------------------
  // T17 — negative control: a consistently forged observation still passes.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t17" })
    await buildComplete(ctx, {
      reportOptions: {
        output: "Ran 999 tests in 0.01s: all passed.\n",
        exitCode: 0,
      },
    })
    // The report claims an invented observation, signed consistently by the
    // run key. Nothing re-executes it, so every relation verifies.
    const report = readJson(join(ctx.run, "verify", "report-R1.json"))
    assert(report.checks[0].output.includes("999 tests"))
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "PASS", JSON.stringify(result.reasons))
    assert.strictEqual(verifyExitCode(result), 0)
    ok("T17 negative control: a consistently forged observation still verifies (documented residual)")
  }

  // -------------------------------------------------------------------------
  // T18 — a read-only run directory still verifies and is not written.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t18" })
    await buildComplete(ctx)
    const before = new Map()
    for (const rel of listFiles(ctx.run)) {
      const st = statSync(join(ctx.run, rel))
      before.set(rel, { size: st.size, mtimeMs: st.mtimeMs })
    }
    for (const rel of listFiles(ctx.run)) chmodSync(join(ctx.run, rel), 0o444)
    for (const rel of listFiles(ctx.run)) {
      const abs = join(ctx.run, rel)
      // chmod every directory after its files, deepest first.
      const parts = rel.split("/")
      for (let i = 1; i < parts.length; i += 1) {
        chmodSync(join(ctx.run, ...parts.slice(0, i)), 0o555)
      }
    }
    chmodSync(ctx.run, 0o555)
    try {
      const result = await verify(ctx)
      assert.strictEqual(result.verdict, "PASS", JSON.stringify(result.reasons))
      const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      assert.deepStrictEqual(listFiles(ctx.run).sort(cmp), [...before.keys()].sort(cmp))
      for (const [rel, st] of before) {
        const now = statSync(join(ctx.run, rel))
        assert.strictEqual(now.size, st.size, `${rel} size changed`)
        assert.strictEqual(now.mtimeMs, st.mtimeMs, `${rel} mtime changed`)
      }
    } finally {
      chmodSync(ctx.run, 0o755)
      for (const rel of [...before.keys()].sort((a, b) => b.split("/").length - a.split("/").length)) {
        const abs = join(ctx.run, rel)
        const parts = rel.split("/")
        for (let i = 1; i <= parts.length; i += 1) {
          try {
            chmodSync(join(ctx.run, ...parts.slice(0, i)), 0o755)
          } catch {}
        }
        try {
          chmodSync(abs, 0o644)
        } catch {}
      }
    }
    ok("T18 chmod -R a-w run still verifies and writes nothing")
  }

  // -------------------------------------------------------------------------
  // T19 — --json shape is stable across fixtures.
  // -------------------------------------------------------------------------
  {
    const happy = await makeRun({ tag: "t19a" })
    await buildComplete(happy)
    const broken = await makeRun({ tag: "t19b" })
    await buildComplete(broken)
    writeFileSync(
      join(broken.run, "verify", "report-R1.json"),
      readFileSync(join(broken.run, "verify", "report-R1.json"), "utf8").replace("Fixture", "Broken"),
    )
    const legacy = await makeRun({ tag: "t19c", unsigned: true, requireHandoffs: "skip", victoryAudit: "skip" })
    writeJson(join(legacy.run, "verify", "report-R1.json"), makeReportPayload(legacy, "R1"))

    const fixtures = [happy, broken, legacy]
    const topKeys = [
      "schemaVersion",
      "toolVersion",
      "runId",
      "runPath",
      "trust",
      "attestation",
      "attested",
      "verdict",
      "counts",
      "checks",
      "relations",
      "reasons",
      "generatedAt",
    ]
    const payloads = []
    for (const ctx of fixtures) {
      const cli = runCli(["verify", "--run-dir", ctx.run, ...signedArgs(ctx), "--json"])
      assert(cli.stdout.length > 0, cli.stderr)
      const parsed = JSON.parse(cli.stdout)
      assert.deepStrictEqual(Object.keys(parsed), topKeys)
      assert.deepStrictEqual(Object.keys(parsed.trust), ["alg", "keyId", "source"])
      assert.deepStrictEqual(Object.keys(parsed.attestation), ["status", "commitSha", "keyId", "issuer"])
      assert.deepStrictEqual(Object.keys(parsed.counts), ["pass", "warn", "fail", "skip", "unknown", "total"])
      for (const check of parsed.checks) {
        assert.deepStrictEqual(Object.keys(check), ["id", "level", "status", "detail", "artifacts"])
      }
      for (const relation of parsed.relations) {
        assert.deepStrictEqual(Object.keys(relation), ["from", "to", "kind", "expected", "actual"])
      }
      payloads.push(parsed)
    }
    assert.strictEqual(payloads[1].verdict, "FAIL")
    assert.strictEqual(payloads[2].verdict, "UNKNOWN")

    // Deterministic shape and values (generatedAt is the only clock field).
    const first = runCli(["verify", "--run-dir", happy.run, ...signedArgs(happy), "--json"])
    const second = runCli(["verify", "--run-dir", happy.run, ...signedArgs(happy), "--json"])
    const a = JSON.parse(first.stdout)
    const b = JSON.parse(second.stdout)
    delete a.generatedAt
    delete b.generatedAt
    assert.deepStrictEqual(a, b)
    const text = renderVerify(JSON.parse(first.stdout), { color: false }).join("\n")
    assert(text.includes("opencode-teamwork verify"))
    assert(text.includes("Verdict:"))
    ok("T19 --json shape is stable across 3 fixtures (and the human table is rendered from it)")
  }

  // -------------------------------------------------------------------------
  // T20 — checks[] v2: a command claim is not PASS until it is re-executed.
  // -------------------------------------------------------------------------
  {
    const { repo, ctx } = await commandFixture("t20")
    const before = hashTree(repo)
    const claimed = await verify(ctx)
    assert.strictEqual(claimed.verdict, "UNKNOWN", JSON.stringify(claimed.reasons))
    assert.strictEqual(verifyExitCode(claimed), 2)
    assert(hasReason(claimed, "PROVENANCE_CLAIMED"), JSON.stringify(claimed.reasons))
    assert(
      claimed.checks.some((c) => c.id === "provenance:declared") === false,
      "command provenance must not be reported as declared",
    )

    const rerun = await verify(ctx, { rerun: true, repo })
    assert.strictEqual(rerun.verdict, "PASS", JSON.stringify(rerun.reasons))
    assert.strictEqual(verifyExitCode(rerun), 0)
    assert.strictEqual(rerun.counts.fail, 0)
    assert(rerun.checks.some((c) => c.id === "provenance:required" && c.status === "pass"))
    assert.strictEqual(hashTree(repo), before, "the source checkout must be byte-identical after --rerun")
    assert.strictEqual(rerun.rerun.worktrees.length, 1)
    for (const worktree of rerun.rerun.worktrees) {
      assert(!existsSync(worktree), `a disposable worktree must be removed: ${worktree}`)
    }
    const cli = runCli(["verify", "--run-dir", ctx.run, ...signedArgs(ctx), "--rerun", "--repo", repo, "--json"])
    assert.strictEqual(cli.code, 0, cli.stderr)
    assert.strictEqual(JSON.parse(cli.stdout).verdict, "PASS")
    ok("T20 command provenance is claimed without --rerun (exit 2), PASS after re-execution, worktree removed")
  }

  // -------------------------------------------------------------------------
  // T21 — each re-execution failure shape.
  // -------------------------------------------------------------------------
  {
    const changed = await commandFixture("t21a", {
      command: [process.execPath, "-e", "process.stdout.write('actual\\n')"],
      output: "expected\n",
    })
    const changedResult = await verify(changed.ctx, { rerun: true, repo: changed.repo })
    assert.strictEqual(changedResult.verdict, "FAIL")
    assert(hasReason(changedResult, "output-digest-mismatch"), JSON.stringify(changedResult.reasons))

    const failed = await commandFixture("t21b", {
      command: [process.execPath, "-e", "process.exit(1)"],
      output: "",
    })
    const failedResult = await verify(failed.ctx, { rerun: true, repo: failed.repo })
    assert.strictEqual(failedResult.verdict, "FAIL")
    assert.strictEqual(verifyExitCode(failedResult), 1)
    assert(hasReason(failedResult, "command-failed"), JSON.stringify(failedResult.reasons))

    const missing = await commandFixture("t21c", {
      command: ["definitely-not-a-real-binary-0x16"],
      output: "",
    })
    const missingResult = await verify(missing.ctx, { rerun: true, repo: missing.repo })
    assert.strictEqual(missingResult.verdict, "UNKNOWN")
    assert.strictEqual(verifyExitCode(missingResult), 2)
    assert(hasReason(missingResult, "command-unavailable"), JSON.stringify(missingResult.reasons))

    const timed = await commandFixture("t21d", {
      command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      output: "",
      timeoutMs: 200,
    })
    const timedResult = await verify(timed.ctx, { rerun: true, repo: timed.repo })
    assert.strictEqual(timedResult.verdict, "FAIL")
    assert.strictEqual(verifyExitCode(timedResult), 1)
    assert(hasReason(timedResult, "command-timeout"), JSON.stringify(timedResult.reasons))
    ok("T21 output-digest-mismatch / command-failed / command-unavailable (exit 2) / command-timeout")
  }

  // -------------------------------------------------------------------------
  // T22 — shell lines and escaping cwd are refused, not executed.
  // -------------------------------------------------------------------------
  {
    const shell = await commandFixture("t22a", {
      command: ["sh", "-c", "exit 0"],
      output: "",
    })
    const shellResult = await verify(shell.ctx, { rerun: true, repo: shell.repo })
    assert.strictEqual(shellResult.verdict, "FAIL")
    assert(
      hasReason(shellResult, "command-refused") || shellResult.reasons.some((r) => /shell interpreter/.test(r)),
      JSON.stringify(shellResult.reasons),
    )

    const escaped = await commandFixture("t22b", { cwd: "../outside", output: "ok\n" })
    const escapedResult = await verify(escaped.ctx, { rerun: true, repo: escaped.repo })
    assert.strictEqual(escapedResult.verdict, "FAIL")
    assert(
      hasReason(escapedResult, "command-refused") || escapedResult.reasons.some((r) => /cwd/.test(r)),
      JSON.stringify(escapedResult.reasons),
    )
    ok("T22 sh -c and a cwd outside the worktree are refused")
  }

  // -------------------------------------------------------------------------
  // T23 — --keep-worktree leaves the worktree; the default removes it.
  // -------------------------------------------------------------------------
  {
    const { repo, ctx } = await commandFixture("t23")
    const kept = await verify(ctx, { rerun: true, repo, keepWorktree: true })
    assert.strictEqual(kept.verdict, "PASS", JSON.stringify(kept.reasons))
    assert.strictEqual(kept.rerun.worktrees.length, 1)
    const keptPath = kept.rerun.worktrees[0]
    assert(existsSync(keptPath), "--keep-worktree must leave the disposable worktree")
    assert(kept.checks.some((c) => c.id === "rerun:worktrees" && c.status === "skip"))
    rmSync(keptPath, { recursive: true, force: true })
    try {
      const gitBin = resolveTrustedExecutable("git")
      if (gitBin) execFileSync(gitBin, ["-C", repo, "worktree", "prune"], { stdio: "ignore" })
    } catch {}
    ok("T23 --keep-worktree leaves the worktree and reports its path")
  }

  // -------------------------------------------------------------------------
  // T24 — an edited verify/rerun.json is AUTH_STALE, even when re-signed.
  // -------------------------------------------------------------------------
  {
    const { ctx } = await commandFixture("t24")
    const rel = "verify/rerun.json"
    const rerun = readJson(join(ctx.run, rel))
    rerun.tasks.R1.checks[0].argv = [process.execPath, "-e", "process.stdout.write('tampered\\n')"]
    const signed = await ctx.signer.auth.signRunArtifact(ctx.runId, rel, rerun)
    writeJson(join(ctx.run, rel), signed)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUTH_STALE"), JSON.stringify(result.reasons))
    assert(
      result.reasons.some((r) => r.includes("rerun") || r.includes("R1")),
      JSON.stringify(result.reasons),
    )
    ok("T24 edited rerun.json -> AUTH_STALE at verify (report/rerun digest relation)")
  }

  // -------------------------------------------------------------------------
  // T25 — manifest v4 requiredProvenance cannot be downgraded.
  // -------------------------------------------------------------------------
  {
    const { ctx } = await commandFixture("t25")
    const plan = readJson(join(ctx.run, "plan.dag.json"))
    delete plan.requiredProvenance
    writeJson(join(ctx.run, "plan.dag.json"), plan)
    const state = readJson(join(ctx.run, "state.json"))
    delete state.requiredProvenance
    writeJson(join(ctx.run, "state.json"), state)
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "AUTH_STALE"), JSON.stringify(result.reasons))
    assert(result.reasons.some((r) => r.includes("requiredProvenance")), JSON.stringify(result.reasons))
    ok("T25 plan downgrade of requiredProvenance -> AUTH_STALE")
  }

  // -------------------------------------------------------------------------
  // T26 — a command check with no headSha is REPORT_UNBOUND.
  // -------------------------------------------------------------------------
  {
    const { ctx } = await commandFixture("t26", { headSha: null })
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "FAIL")
    assert(hasReason(result, "REPORT_UNBOUND"), JSON.stringify(result.reasons))
    ok("T26 command claim without headSha -> REPORT_UNBOUND")
  }

  // -------------------------------------------------------------------------
  // T27 — a legacy 0.15 report (manifest v3, checks v1) still parses as declared.
  // -------------------------------------------------------------------------
  {
    const ctx = await makeRun({ tag: "t27", manifestVersion: 3, requireHandoffs: "skip", victoryAudit: "skip" })
    const built = await buildComplete(ctx, { withFinal: false })
    const report = readJson(join(ctx.run, "verify/report-R1.json"))
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(report.checks[0], "command"),
      false,
      "legacy fixture must not carry v2 command fields",
    )
    await signWrite(
      ctx,
      "verify/final.json",
      finalPayload(ctx, {
        reportDigests: { ...built.reports },
        auditDigest: built.auditDigest,
        tasks: [{ id: "R1", status: "verified_pass", report: "verify/report-R1.json", reportStatus: "PASS" }],
        victory: "SKIPPED (explicit): fixture skip",
        handoffs: "SKIPPED (explicit)",
      }),
    )
    const result = await verify(ctx)
    assert.strictEqual(result.verdict, "PASS", JSON.stringify(result.reasons))
    assert(result.checks.some((c) => c.id === "provenance:declared" && c.status === "skip"))
    assert.strictEqual(result.checks.some((c) => c.id === "manifest:requiredProvenance"), true)
    ok("T27 legacy v3 manifest + checks v1 -> PASS as declared")
  }

  // -------------------------------------------------------------------------
  // T28 — T17 under command + --rerun: the forged observation is re-executed.
  // -------------------------------------------------------------------------
  {
    const { repo, ctx } = await commandFixture("t28", {
      command: [process.execPath, "-e", "process.exit(1)"],
      output: "Ran 999 tests in 0.01s: all passed.\n",
    })
    const result = await verify(ctx, { rerun: true, repo })
    assert.strictEqual(result.verdict, "FAIL", JSON.stringify(result.reasons))
    assert(hasReason(result, "command-failed"), JSON.stringify(result.reasons))
    ok("T28 T17 negative control under command + --rerun -> command-failed")
  }

  // -------------------------------------------------------------------------
  // T29 — passed/exitCode conflicts are refused by name in checks[] v2.
  // -------------------------------------------------------------------------
  {
    const liePass = await commandFixture("t29a", { output: "" })
    const report = readJson(join(liePass.ctx.run, "verify/report-R1.json"))
    report.checks[0].passed = true
    report.checks[0].exitCode = 1
    writeJson(
      join(liePass.ctx.run, "verify/report-R1.json"),
      await liePass.ctx.signer.auth.signRunArtifact(liePass.ctx.runId, "verify/report-R1.json", report),
    )
    const passResult = await verify(liePass.ctx)
    assert.strictEqual(passResult.verdict, "FAIL")
    assert(hasReason(passResult, "CHECK_EXIT_CONFLICT"), JSON.stringify(passResult.reasons))

    const lieFail = await commandFixture("t29b", { output: "" })
    const report2 = readJson(join(lieFail.ctx.run, "verify/report-R1.json"))
    report2.checks[0].passed = false
    report2.checks[0].exitCode = 0
    writeJson(
      join(lieFail.ctx.run, "verify/report-R1.json"),
      await lieFail.ctx.signer.auth.signRunArtifact(lieFail.ctx.runId, "verify/report-R1.json", report2),
    )
    const failResult = await verify(lieFail.ctx)
    assert.strictEqual(failResult.verdict, "FAIL")
    assert(hasReason(failResult, "CHECK_EXIT_CONFLICT"), JSON.stringify(failResult.reasons))
    ok("T29 passed:true/exitCode:1 and passed:false/exitCode:0 -> CHECK_EXIT_CONFLICT")
  }

  // -------------------------------------------------------------------------
  // T30 — a valid CI attestation is PASS, and the CLI reports attested:true.
  // -------------------------------------------------------------------------
  {
    const keys = makeAttestationKeys()
    const { ctx } = await attestationFixture("t30")
    writeAttestation(ctx, attestationPayloadFor(ctx), keys)
    const result = await verify(ctx, {
      attestationPublicKey: keys.publicKey,
      attestationIssuer: ATTESTATION_ISSUER,
    })
    assert.strictEqual(result.verdict, "PASS", JSON.stringify(result.reasons))
    assert.strictEqual(result.attested, true)
    assert.deepStrictEqual(result.attestation, {
      status: "ATTESTED",
      commitSha: "a".repeat(40),
      keyId: keys.keyId,
      issuer: ATTESTATION_ISSUER,
    })
    const cli = runCli([
      "verify",
      "--run-dir",
      ctx.run,
      ...signedArgs(ctx),
      "--attestation-public-key",
      keys.publicKey,
      "--attestation-issuer",
      ATTESTATION_ISSUER,
      "--json",
    ])
    assert.strictEqual(cli.code, 0, cli.stderr)
    const parsed = JSON.parse(cli.stdout)
    assert.strictEqual(parsed.verdict, "PASS")
    assert.strictEqual(parsed.attested, true)
    assert.strictEqual(parsed.attestation.status, "ATTESTED")
    ok("T30 required + valid fixture attestation -> PASS, attested:true (CLI and API)")
  }

  // -------------------------------------------------------------------------
  // T31 — required + missing is a named FAIL; without a key it is UNKNOWN.
  // -------------------------------------------------------------------------
  {
    const keys = makeAttestationKeys()
    const missing = await attestationFixture("t31a")
    const missingResult = await verify(missing.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(missingResult.verdict, "FAIL", JSON.stringify(missingResult.reasons))
    assert(hasReason(missingResult, "AUTH_ATTESTATION_MISSING"), JSON.stringify(missingResult.reasons))
    assert.strictEqual(missingResult.attestation.status, "MISSING")

    const noKey = await attestationFixture("t31b")
    writeAttestation(noKey.ctx, attestationPayloadFor(noKey.ctx), keys)
    const unknown = await verify(noKey.ctx)
    assert.strictEqual(unknown.verdict, "UNKNOWN", JSON.stringify(unknown.reasons))
    assert.strictEqual(verifyExitCode(unknown), 2)
    assert.strictEqual(unknown.attestation.status, "UNKNOWN")
    assert(!hasReason(unknown, "AUTH_ATTESTATION_STALE"))
    ok("T31 required missing -> AUTH_ATTESTATION_MISSING; no public key -> UNKNOWN (exit 2)")
  }

  // -------------------------------------------------------------------------
  // T32 — stale plan hash, commit mismatch and command/output mismatch.
  // -------------------------------------------------------------------------
  {
    const keys = makeAttestationKeys()
    const stale = await attestationFixture("t32a")
    writeAttestation(stale.ctx, attestationPayloadFor(stale.ctx, { planHash: "f".repeat(64) }), keys)
    const staleResult = await verify(stale.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(staleResult.verdict, "FAIL")
    assert(hasReason(staleResult, "AUTH_ATTESTATION_STALE"), JSON.stringify(staleResult.reasons))

    const commit = await attestationFixture("t32b")
    writeAttestation(commit.ctx, attestationPayloadFor(commit.ctx, { commitSha: "d".repeat(40) }), keys)
    const commitResult = await verify(commit.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(commitResult.verdict, "FAIL")
    assert(hasReason(commitResult, "AUTH_ATTESTATION_COMMIT_MISMATCH"), JSON.stringify(commitResult.reasons))

    const output = await attestationFixture("t32c")
    const payload = attestationPayloadFor(output.ctx)
    payload.commands[0].outputSha256 = contentSha256Hex("different output\n")
    payload.commands[0].outputBytes = Buffer.byteLength("different output\n")
    writeAttestation(output.ctx, payload, keys)
    const outputResult = await verify(output.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(outputResult.verdict, "FAIL")
    assert(hasReason(outputResult, "AUTH_ATTESTATION_STALE"), JSON.stringify(outputResult.reasons))
    ok("T32 stale plan / commit mismatch / command-output mismatch -> named codes")
  }

  // -------------------------------------------------------------------------
  // T33 — replay from another run and a run-key signature are refused.
  // -------------------------------------------------------------------------
  {
    const keys = makeAttestationKeys()
    const replay = await attestationFixture("t33a")
    const payload = attestationPayloadFor(replay.ctx, { runId: "20261124-000000-other" })
    writeAttestation(replay.ctx, payload, keys, { nonce: randomBytes(16).toString("base64url") })
    const replayResult = await verify(replay.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(replayResult.verdict, "FAIL")
    assert(hasReason(replayResult, "AUTH_ATTESTATION_REPLAY"), JSON.stringify(replayResult.reasons))

    const runKeyed = await attestationFixture("t33b")
    // The fixture's run is HMAC; rebuild one with an Ed25519 run key so the
    // same private key can sign the attestation.
    const ed = await makeRun({
      tag: "t33c",
      alg: "ed25519",
      requireHandoffs: "skip",
      victoryAudit: "skip",
      attestationPolicy: "required",
      attestationIssuer: ATTESTATION_ISSUER,
    })
    const headSha = "a".repeat(40)
    const check = makeCommandCheck({
      command: [process.execPath, "-e", "process.stdout.write('run-key\\n')"],
      output: "run-key\n",
    })
    await buildComplete(ed, {
      reportOptions: { headSha, diffHash: "b".repeat(64), extraChecks: [check] },
    })
    const edPayload = attestationPayloadFor(ed)
    const runPrivate = loadAttestationPrivateKey(ed.signer.env.OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY)
    assert(runPrivate, "the Ed25519 fixture run must expose its private key")
    writeAttestation(ed, edPayload, { privateKey: runPrivate, keyId: ed.signer.keyId })
    const runKeyResult = await verify(ed, { attestationPublicKey: ed.signer.publicKey })
    assert.strictEqual(runKeyResult.verdict, "FAIL")
    assert(hasReason(runKeyResult, "AUTH_ATTESTATION_UNTRUSTED"), JSON.stringify(runKeyResult.reasons))
    ok("T33 foreign runId/nonce -> REPLAY; run-key signature -> UNTRUSTED")
  }

  // -------------------------------------------------------------------------
  // T34 — policy downgrade is AUTH_STALE; off ignores; optional records.
  // -------------------------------------------------------------------------
  {
    const keys = makeAttestationKeys()
    const downgrade = await attestationFixture("t34a")
    writeAttestation(downgrade.ctx, attestationPayloadFor(downgrade.ctx), keys)
    for (const rel of ["plan.dag.json", "state.json"]) {
      const value = readJson(join(downgrade.ctx.run, rel))
      value.attestationPolicy = "off"
      writeJson(join(downgrade.ctx.run, rel), value)
    }
    const downgraded = await verify(downgrade.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(downgraded.verdict, "FAIL")
    assert(hasReason(downgraded, "AUTH_STALE"), JSON.stringify(downgraded.reasons))
    assert(
      downgraded.reasons.some((reason) => reason.includes("attestationPolicy")),
      JSON.stringify(downgraded.reasons),
    )

    const off = await attestationFixture("t34b", { policy: "off" })
    writeJson(join(off.ctx.run, "verify/ci/attestation.json"), { garbage: true })
    const offResult = await verify(off.ctx)
    assert.strictEqual(offResult.verdict, "PASS", JSON.stringify(offResult.reasons))
    assert.strictEqual(offResult.attestation.status, "OFF")
    assert.strictEqual(offResult.attested, false)

    const optional = await attestationFixture("t34c", { policy: "optional" })
    writeJson(join(optional.ctx.run, "verify/ci/attestation.json"), { garbage: true })
    const optionalResult = await verify(optional.ctx, { attestationPublicKey: keys.publicKey })
    assert.strictEqual(optionalResult.verdict, "PASS", JSON.stringify(optionalResult.reasons))
    assert.strictEqual(optionalResult.attestation.status, "INVALID")
    assert(optionalResult.counts.warn >= 1)
    ok("T34 downgrade -> AUTH_STALE; off ignores; optional records INVALID without failing")
  }

  // -------------------------------------------------------------------------
  // T35 — the producer CLI writes an artifact the verifier accepts.
  // -------------------------------------------------------------------------
  {
    const keys = makeAttestationKeys()
    const { ctx } = await attestationFixture("t35")
    const manifestPath = join(ctx.run, "run.manifest.json")
    const manifest = readJson(manifestPath)
    const report = readJson(join(ctx.run, "verify/report-R1.json"))
    const payload = attestationPayloadFor(ctx)
    const keyFile = join(TEST_ROOT, "t35-attestation-key.pem")
    writeFileSync(keyFile, keys.pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
    const commandsFile = join(TEST_ROOT, "t35-commands.json")
    writeJson(commandsFile, payload.commands)
    const outPath = join(ctx.run, "verify/ci/attestation.json")
    const cli = execFileSync(
      process.execPath,
      [
        resolve("scripts/attest-sign.mjs"),
        "--run-id",
        ctx.runId,
        "--manifest-digest",
        payloadDigest(manifest),
        "--manifest",
        manifestPath,
        "--commit",
        report.headSha,
        "--base",
        "",
        "--commands",
        `@${commandsFile}`,
        "--key",
        keyFile,
        "--out",
        outPath,
        "--oidc-issuer",
        ATTESTATION_ISSUER,
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
    const produced = JSON.parse(cli)
    assert.strictEqual(produced.ok, true)
    assert.strictEqual(produced.keyId, keys.keyId)
    const artifact = readJson(outPath)
    assert.strictEqual(artifact._auth.path, "verify/ci/attestation.json")
    assert.strictEqual(artifact.planHash, manifest.planHash)
    const verified = await verify(ctx, { attestationPublicKey: keys.publicKey, attestationIssuer: ATTESTATION_ISSUER })
    assert.strictEqual(verified.verdict, "PASS", JSON.stringify(verified.reasons))
    assert.strictEqual(verified.attested, true)

    // The producer refuses a manifest digest that does not match the manifest.
    let refused = 0
    try {
      execFileSync(
        process.execPath,
        [
          resolve("scripts/attest-sign.mjs"),
          "--run-id",
          ctx.runId,
          "--manifest-digest",
          "0".repeat(64),
          "--manifest",
          manifestPath,
          "--commit",
          report.headSha,
          "--commands",
          `@${commandsFile}`,
          "--key",
          keyFile,
          "--out",
          outPath,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
    } catch (err) {
      refused = err.status ?? 1
    }
    assert.strictEqual(refused, 1)
    ok("T35 attest-sign.mjs produces a verifiable artifact and refuses a mismatched manifest digest")
  }

  // T36: real OIDC JWT validation, forged issuer refusal, cross-repo/ref replay, UNKNOWN without JWKS (#44)
  {
    const { generateKeyPairSync, sign: cryptoSign } = await import("node:crypto")
    const { evaluateAttestation, signAttestation, ATTESTATION_CODES } = await import("../plugins/opencode-teamwork/attestation.mjs")
    const attKeys = generateKeyPairSync("ed25519")
    const oidcKeys = generateKeyPairSync("ed25519")
    const oidcJwk = { ...oidcKeys.publicKey.export({ format: "jwk" }), kid: "oidc-k1", alg: "EdDSA" }
    const jwks = { keys: [oidcJwk] }

    function makeJwt(claims, privKey = oidcKeys.privateKey, kid = "oidc-k1") {
      const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid })).toString("base64url")
      const p = Buffer.from(JSON.stringify(claims)).toString("base64url")
      const sig = cryptoSign(null, Buffer.from(`${h}.${p}`, "utf8"), privKey).toString("base64url")
      return `${h}.${p}.${sig}`
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const runNonce = "A".repeat(24)
    const sha = "a".repeat(40)
    const planHash = "b".repeat(64)
    const promptHash = "c".repeat(64)
    const basePayload = {
      v: 1,
      provider: "github-actions",
      workflow: "ci-attestation",
      runId: "r-oidc-1",
      runAttempt: 1,
      repository: "Heretek-AI/opencode-teamwork-v2",
      commitSha: sha,
      promptHash,
      planHash,
      commands: [],
      oidc: {
        issuer: "https://token.actions.githubusercontent.com",
        subject: "repo:Heretek-AI/opencode-teamwork-v2:ref:refs/heads/main",
        audience: "opencode-teamwork",
        ref: "refs/heads/main",
      },
      issuedAt: new Date(nowSec * 1000).toISOString(),
      expiresAt: new Date((nowSec + 3600) * 1000).toISOString(),
    }

    // 1. Forged issuer string without token fails when requireOidcToken is true.
    const noTokenArt = signAttestation(basePayload, { privateKey: attKeys.privateKey, keyId: "att-1", nonce: runNonce })
    const forged = evaluateAttestation({
      artifact: noTokenArt,
      policy: "required",
      publicKey: attKeys.publicKey,
      expectedKeyId: "att-1",
      expectedIssuer: "https://token.actions.githubusercontent.com",
      oidcJwks: jwks,
      requireOidcToken: true,
      runId: "r-oidc-1",
      runNonce,
      planHash,
      promptHash,
    })
    assert.strictEqual(forged.status, "INVALID")
    assert.strictEqual(forged.code, ATTESTATION_CODES.untrusted)

    // 2. Valid signed OIDC token passes.
    const validToken = makeJwt({
      iss: "https://token.actions.githubusercontent.com",
      aud: "opencode-teamwork",
      sub: "repo:Heretek-AI/opencode-teamwork-v2:ref:refs/heads/main",
      repository: "Heretek-AI/opencode-teamwork-v2",
      ref: "refs/heads/main",
      sha,
      exp: nowSec + 600,
    })
    const validArt = signAttestation(
      { ...basePayload, oidc: { ...basePayload.oidc, token: validToken } },
      { privateKey: attKeys.privateKey, keyId: "att-1", nonce: runNonce },
    )
    const validRes = evaluateAttestation({
      artifact: validArt,
      policy: "required",
      publicKey: attKeys.publicKey,
      expectedKeyId: "att-1",
      expectedIssuer: "https://token.actions.githubusercontent.com",
      expectedAudience: "opencode-teamwork",
      expectedRepository: "Heretek-AI/opencode-teamwork-v2",
      expectedRef: "refs/heads/main",
      oidcJwks: jwks,
      requireOidcToken: true,
      runId: "r-oidc-1",
      runNonce,
      planHash,
      promptHash,
    })
    assert.strictEqual(validRes.status, "ATTESTED")

    // 3. Missing JWKS trust material reports UNKNOWN.
    const unknownRes = evaluateAttestation({
      artifact: validArt,
      policy: "required",
      publicKey: attKeys.publicKey,
      expectedKeyId: "att-1",
      expectedIssuer: "https://token.actions.githubusercontent.com",
      requireOidcToken: true,
      runId: "r-oidc-1",
      runNonce,
      planHash,
      promptHash,
    })
    assert.strictEqual(unknownRes.status, "UNKNOWN")

    // 4. Cross-repository and cross-ref replay fail with AUTH_ATTESTATION_REPLAY.
    const wrongRepo = evaluateAttestation({
      artifact: validArt,
      policy: "required",
      publicKey: attKeys.publicKey,
      expectedKeyId: "att-1",
      expectedIssuer: "https://token.actions.githubusercontent.com",
      expectedRepository: "OtherOrg/other-repo",
      oidcJwks: jwks,
      requireOidcToken: true,
      runId: "r-oidc-1",
      runNonce,
      planHash,
      promptHash,
    })
    assert.strictEqual(wrongRepo.status, "INVALID")
    assert.strictEqual(wrongRepo.code, ATTESTATION_CODES.replay)

    const wrongRef = evaluateAttestation({
      artifact: validArt,
      policy: "required",
      publicKey: attKeys.publicKey,
      expectedKeyId: "att-1",
      expectedIssuer: "https://token.actions.githubusercontent.com",
      expectedRef: "refs/heads/feature",
      oidcJwks: jwks,
      requireOidcToken: true,
      runId: "r-oidc-1",
      runNonce,
      planHash,
      promptHash,
    })
    assert.strictEqual(wrongRef.status, "INVALID")
    assert.strictEqual(wrongRef.code, ATTESTATION_CODES.replay)
    ok("T36 OIDC real-token verification, forged-issuer refusal, replay checks, and UNKNOWN without JWKS")
  }

  // -------------------------------------------------------------------------
  // T37 — S3923: omitted requireHandoffs resolves to "skip"; "required" still enforces
  // -------------------------------------------------------------------------
  {
    const omitted = await makeRun({ tag: "t37-omitted", unsigned: true, requireHandoffs: undefined, victoryAudit: "skip" })
    delete omitted.plan.requireHandoffs
    delete omitted.state.requireHandoffs
    writeJson(join(omitted.run, "plan.dag.json"), omitted.plan)
    writeJson(join(omitted.run, "state.json"), omitted.state)
    writeJson(join(omitted.run, "verify", "report-R1.json"), makeReportPayload(omitted, "R1"))
    const resOmitted = await verify(omitted)
    assert.strictEqual(
      resOmitted.checks.some((c) => c.id.startsWith("handoff:matrix") || c.id === "report:R1:handoff"),
      false,
      `omitted requireHandoffs must skip handoff matrix/report checks: ${JSON.stringify(resOmitted.checks)}`,
    )

    const required = await makeRun({ tag: "t37-required", unsigned: true, requireHandoffs: "required", victoryAudit: "skip" })
    writeJson(join(required.run, "verify", "report-R1.json"), makeReportPayload(required, "R1"))
    const resRequired = await verify(required)
    assert.strictEqual(
      resRequired.checks.find((c) => c.id === "handoff:matrix")?.status,
      "fail",
      `requireHandoffs=required without handoffs must fail handoff:matrix: ${JSON.stringify(resRequired.checks)}`,
    )
    assert.strictEqual(
      resRequired.checks.find((c) => c.id === "report:R1:handoff")?.status,
      "fail",
      `requireHandoffs=required without workerHandoff binding must fail report:R1:handoff: ${JSON.stringify(resRequired.checks)}`,
    )
    ok("T37 omitted requireHandoffs defaults to skip while required still enforces handoffs")
  }

  // -------------------------------------------------------------------------
  // T38 — S8476/S5144: --fetch-jwks refuses non-https, loopback, metadata, and
  // IPv6 loopback issuers before any run fixture is read.
  // -------------------------------------------------------------------------
  {
    const cases = [
      { issuer: "http://127.0.0.1:9", pattern: /https:\/\//i, why: "plain http" },
      { issuer: "https://127.0.0.1:9", pattern: /loopback/i, why: "IPv4 loopback" },
      { issuer: "https://169.254.169.254/latest/meta-data", pattern: /cloud metadata/i, why: "cloud metadata" },
      { issuer: "https://[::1]:9", pattern: /loopback/i, why: "IPv6 loopback" },
    ]
    for (const entry of cases) {
      const res = runCli(["verify", "--fetch-jwks", entry.issuer], 15000)
      assert.strictEqual(res.code, 2, `${entry.why}: expected exit 2, got ${res.code}: ${res.stderr}`)
      assert.match(res.stderr, entry.pattern, `${entry.why}: unexpected stderr: ${res.stderr}`)
      assert(res.stderr.length < 1000, `${entry.why}: stderr is not bounded (${res.stderr.length} bytes)`)
    }
    // The OIDC path must not honor the guard's localhost test opt-in.
    const allowed = runCli(["verify", "--fetch-jwks", "https://127.0.0.1:9"], 15000, {
      OPENCODE_TEAMWORK_ALLOW_LOCALHOST: "1",
    })
    assert.strictEqual(allowed.code, 2, `localhost opt-in: expected exit 2, got ${allowed.code}: ${allowed.stderr}`)
    assert.match(allowed.stderr, /loopback/i, `localhost opt-in must still refuse loopback: ${allowed.stderr}`)
    ok("T38 --fetch-jwks refuses non-https, loopback, metadata, and IPv6 loopback issuers (exit 2), even with the localhost opt-in")
  }

  rmSync(TEST_ROOT, { recursive: true, force: true })
  console.log(`\n${passed} verify tests passed`)
}

main().catch((err) => {
  try {
    chmodSync(TEST_ROOT, 0o755)
  } catch {}
  console.error(err)
  process.exitCode = 1
})
