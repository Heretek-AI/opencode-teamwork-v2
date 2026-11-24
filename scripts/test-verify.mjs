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
import { canonicalJson, payloadDigest, sha256Hex } from "../plugins/opencode-teamwork/approval-format.mjs"
import {
  computePlanHash,
  computeRequirementsHash,
  renderVerify,
  verifyExitCode,
  verifyRun,
} from "../lib/verify.mjs"

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
  return out.sort()
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
      version: 3,
      sessionId: runId,
      rootSessionId: "ses_fixture_root",
      integrityMode,
      verification,
      victoryAudit,
      ...(victoryAudit === "skip" ? { victorySkipReason: "fixture skip" } : {}),
      requireHandoffs,
      handoffAuth: "signed",
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

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
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
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
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
      assert.deepStrictEqual(listFiles(ctx.run).sort(), [...before.keys()].sort())
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
