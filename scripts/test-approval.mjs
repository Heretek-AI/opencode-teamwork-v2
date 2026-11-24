// opencode-teamwork — authenticated prompt-approval parity harness (0.11.0)
//
// Proves the reference sequence end to end:
//   1. the interviewer writes prompt_draft.md (first with [OPEN:] gaps, then
//      resolved) and no plan/ORIGINAL_REQUEST.md exists yet;
//   2. the approver signs the exact draft bytes with an Ed25519 key the run
//      process does not hold, writing outside the repo/run;
//   3. only then does teamwork_plan write plan.dag.json + ORIGINAL_REQUEST.md;
//   4. final_verify re-reads and re-hashes the draft and completes.
//
// Two drivers share the same expectations:
//   * print mode — every turn is a child process; state lives only on disk
//     (run dir + a JSON-backed ctx.storage). Removing the approval between
//     turns refuses the plan.
//   * TUI — a single process; an in-memory "approved" flag cannot substitute
//     for the approval file.
//
// Negative coverage: missing approval, edited draft, another run's approval,
// HMAC and run-key approvals, expiry, nonce replay, remaining [OPEN:] gaps,
// a bare team/... approver, an in-run approval, and the signer scope refusal.
// Legacy v1/v2 manifests and the unchanged local-hmac/allowUnsignedLegacy
// paths stay readable.
//
// Run with plain Node (no test framework): an uncaught assertion exits non-zero.

import { registerTeamworkTools, setApprovalOwnerUidForTest } from "../plugins/opencode-teamwork/tools.ts"
import { createAuthContext, canonicalJson } from "../plugins/opencode-teamwork/auth.ts"
import { payloadDigest, contentSha256Hex } from "../plugins/opencode-teamwork/approval-format.mjs"
import {
  buildSignerApprovalPayload,
  signApprovalArtifact,
  signSignerApproval,
  signerApprovalFileFor,
  verifyApprovalArtifact,
  writeSignerApprovalAtomically,
} from "../lib/approve.mjs"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify as cryptoVerify } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import assert from "node:assert"

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, "..", "bin", "opencode-teamwork.mjs")
const DRIVER = join(here, "approval-driver.mjs")
const testDir = mkdtempSync(join(tmpdir(), "teamwork-approval-test-"))
const ROOT_SESSION = "ses_approval_root"
const OWNER_UID_CEILING = 2_000_000_000

let caseSeq = 0
const roots = []

function makeRoot(label) {
  const root = mkdtempSync(join(testDir, `${label}-`))
  roots.push(root)
  return { root, storage: join(root, "..", `${label}-${process.pid}-${++caseSeq}.storage.json`) }
}

function makeApprovalsDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `teamwork-approvals-${label}-`))
  roots.push(dir)
  return dir
}

function makeKeys() {
  const pair = generateKeyPairSync("ed25519")
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
  return { pair, publicKey, privateKey, keyId: "approver_parity" }
}

function writeKeyFile(pair) {
  const file = join(testDir, `approver-${++caseSeq}.pem`)
  writeFileSync(file, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
  return file
}

function approvalEnv(dir, keys, extra = {}) {
  return {
    OPENCODE_TEAMWORK_APPROVAL_DIR: dir,
    OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY: keys.publicKey,
    OPENCODE_TEAMWORK_APPROVAL_KEY_ID: keys.keyId,
    ...extra,
  }
}

async function withEnv(env, fn) {
  const saved = {}
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ---------------------------------------------------------------------------
// In-process tool registration (TUI + negative cases)
// ---------------------------------------------------------------------------

const stores = new Map()
function mapStorage(root) {
  let store = stores.get(root)
  if (!store) {
    store = new Map()
    stores.set(root, store)
  }
  return {
    async get(key) {
      return store.get(key)
    },
    async set(key, value) {
      store.set(key, value)
    },
  }
}

async function toolsFor(root, env) {
  return withEnv(env, async () => {
    const tools = {}
    await registerTeamworkTools(
      {
        tool: {
          transform: async (cb) => {
            await cb({ namespace: () => {}, add: (tool) => (tools[tool.name] = tool) })
          },
        },
        session: {
          async get({ sessionID }) {
            if (sessionID === ROOT_SESSION) return { agent: "team/sentinel" }
            const agent =
              sessionID === "ses_approval_verifier"
                ? "team/verifier"
                : sessionID === "ses_approval_auditor"
                  ? "team/security-auditor"
                  : sessionID === "ses_approval_worker"
                    ? "team/worker"
                    : undefined
            return agent ? { agent, parentID: ROOT_SESSION } : undefined
          },
        },
        storage: mapStorage(root),
      },
      root,
    )
    return tools
  })
}

function runFile(root, runId, name) {
  return join(root, ".opencode", "teamwork", runId, name)
}

function setDraft(root, runId, text) {
  const dir = join(root, ".opencode", "teamwork", runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "prompt_draft.md"), text, "utf8")
}

function basePayload(runId, draftText, trustLevel = "human-approved", overrides = {}) {
  const bytes = Buffer.from(draftText, "utf8")
  return {
    v: 1,
    runId,
    trustLevel,
    binding: "prompt",
    promptDraftSha256: contentSha256Hex(bytes),
    promptDraftBytes: bytes.length,
    openGaps: (draftText.match(/\[OPEN:/g) ?? []).length,
    approvalNonce: randomBytes(32).toString("base64url"),
    approvedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    planHash: null,
    ...(trustLevel === "ci-attested" ? { attestedBy: "ci:github/workflows/ci.yml" } : { approvedBy: "uid:parity" }),
    ...overrides,
  }
}

function writeApproval(dir, payload, keys) {
  const artifact = signApprovalArtifact(payload, { privateKey: keys.pair.privateKey, keyId: keys.keyId })
  const file = join(dir, `${payload.runId}.json`)
  writeFileSync(file, JSON.stringify(artifact, null, 2), { mode: 0o600 })
  return { file, artifact }
}

function readApproval(dir, runId) {
  return JSON.parse(readFileSync(join(dir, `${runId}.json`), "utf8"))
}

async function planRun(tools, runId, trustLevel = "human-approved", extra = {}) {
  return tools.plan.execute(
    {
      sessionId: runId,
      topology: "iterative-coding",
      request: "Approval parity fixture.",
      trustLevel,
      victoryAudit: "skip",
      victorySkipReason: "fixture: approval parity harness skips the victory audit",
      requireHandoffs: "skip",
      tasks: [{ id: "A1" }],
      ...extra,
    },
    { sessionID: ROOT_SESSION },
  )
}

async function seedVerified(tools, runId) {
  for (const status of ["worker_active", "worker_done", "verifier_active"]) {
    await tools.task_update.execute({ sessionId: runId, taskId: "A1", status }, { sessionID: ROOT_SESSION })
  }
  const report = await tools.report.execute(
    {
      sessionId: runId,
      taskId: "A1",
      status: "PASS",
      summary: "Approval fixture PASS.",
      checks: [{ name: "fixture", type: "check", passed: true }],
    },
    { sessionID: "ses_approval_verifier" },
  )
  assert(!String(report.content).startsWith("refused:"), `fixture report refused: ${report.content}`)
  const pass = await tools.task_update.execute(
    { sessionId: runId, taskId: "A1", status: "verified_pass", verification: { status: "PASS" } },
    { sessionID: ROOT_SESSION },
  )
  assert.strictEqual(pass.status, "verified_pass", `verified_pass refused: ${pass.content}`)
  await tools.security_audit.execute(
    { sessionId: runId, status: "PASS", findings: [] },
    { sessionID: "ses_approval_auditor" },
  )
}

async function finalVerify(tools, runId) {
  return tools.final_verify.execute({ sessionId: runId }, { sessionID: ROOT_SESSION })
}

// ---------------------------------------------------------------------------
// Child-process drivers
// ---------------------------------------------------------------------------

function runDriver(spec, env, cwd) {
  const res = spawnSync(process.execPath, [DRIVER, JSON.stringify(spec)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd,
    timeout: 120_000,
  })
  const line = String(res.stdout ?? "").trim().split("\n").filter(Boolean).pop()
  let parsed
  try {
    parsed = line ? JSON.parse(line) : undefined
  } catch {
    parsed = undefined
  }
  assert(parsed, `driver emitted no JSON (status ${res.status}): ${res.stdout}\n${res.stderr}`)
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, result: parsed }
}

function runCli(args, env, cwd, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd,
    input,
    timeout: 120_000,
  })
}

function parseCliJson(res) {
  try {
    return JSON.parse(String(res.stdout ?? "").trim())
  } catch {
    return undefined
  }
}

function writeRequestFile(payload) {
  const file = join(testDir, `request-${++caseSeq}.json`)
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
  return file
}

/**
 * A v2 signer stub: it enforces the documented request layout, derives the
 * approval reference itself, verifies the approval over the
 * `teamwork-signer-approval-v1` domain, checks the binding/expiry, refuses a
 * reused approvalId, and only then signs `request.message`.
 */
function writeV2SignerStub({ signerPrivateKey, signerKeyId, approverPublicKey, approverKeyId, approvalDir, ledgerFile }) {
  const file = join(testDir, `v2-signer-${++caseSeq}.mjs`)
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
const request = JSON.parse(readFileSync(0, "utf8"))
const die = (code, message) => { process.stdout.write(JSON.stringify({ ok: false, code, message })); process.exit(1) }
const canon = (v) => {
  if (v === null) return "null"
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]"
  if (typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  return JSON.stringify(v)
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
if (request.v !== 2) die("E_VERSION", "v must be 2")
if (request.op !== "sign-artifact") die("E_OP", "op")
if (request.alg !== "ed25519") die("E_ALG", "alg")
if (request.keyId !== ${JSON.stringify(signerKeyId)}) die("E_KEYID", "key id")
if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(request.runId)) die("E_REQUEST", "run id")
if (typeof request.path !== "string" || request.path.startsWith("/") || request.path.split("/").some((s) => !s || s === "." || s === "..")) die("E_PATH", "path")
if (!/^[0-9a-f]{64}$/.test(request.digest)) die("E_DIGEST", "digest shape")
if (typeof request.nonce !== "string" || Buffer.from(request.nonce, "base64url").length < 16) die("E_NONCE", "nonce")
const approvalRef = ${JSON.stringify(approvalDir)} + "/" + request.runId + "/" + sha256(request.path) + ".json"
if (request.approvalRef !== approvalRef) die("E_APPROVAL_REF", "approval ref layout")
let approval
try { approval = JSON.parse(readFileSync(approvalRef, "utf8")) } catch { die("E_APPROVAL_OPEN", "approval unreadable") }
if (approval.v !== 1 || approval.kind !== "teamwork.signer-approval") die("E_APPROVAL_BINDING", "kind/version")
if (!approval._auth || approval._auth.alg !== "ed25519" || approval._auth.keyId !== ${JSON.stringify(approverKeyId)}) die("E_APPROVAL_SIG", "key")
const unsigned = { ...approval }
delete unsigned._auth
const input = "teamwork-signer-approval-v1\\0" + unsigned.runId + "\\0" + unsigned.path + "\\0" + unsigned.digest + "\\0" + unsigned.nonce + "\\0" + unsigned.expiresAt + "\\0" + canon(unsigned)
const approverKey = createPublicKey({ key: Buffer.from(${JSON.stringify(approverPublicKey)}, "base64url"), format: "der", type: "spki" })
if (!verify(null, Buffer.from(input, "utf8"), approverKey, Buffer.from(String(approval._auth.sig), "base64url"))) die("E_APPROVAL_SIG", "signature")
if (approval.runId !== request.runId || approval.path !== request.path || approval.digest !== request.digest || approval.nonce !== request.nonce) die("E_APPROVAL_BINDING", "binding")
const expires = Date.parse(approval.expiresAt)
const approved = Date.parse(approval.approvedAt)
if (!Number.isFinite(expires) || !Number.isFinite(approved)) die("E_APPROVAL_EXPIRED", "time")
if (Date.now() > expires) die("E_APPROVAL_EXPIRED", "expired")
if (approved > Date.now() + 300000) die("E_APPROVAL_EXPIRED", "not yet valid")
if (expires - approved > 7 * 24 * 3600 * 1000) die("E_APPROVAL_EXPIRED", "lifetime")
let ledger = {}
try { ledger = JSON.parse(readFileSync(${JSON.stringify(ledgerFile)}, "utf8")) } catch {}
if (ledger[approval.approvalId]) die("E_APPROVAL_REPLAY", "approval id already used")
ledger[approval.approvalId] = sha256(request.runId + "\\0" + request.path + "\\0" + request.digest + "\\0" + request.nonce)
writeFileSync(${JSON.stringify(ledgerFile)}, JSON.stringify(ledger), { mode: 0o600 })
const message = Buffer.from(request.message, "base64url")
const key = createPrivateKey({ key: Buffer.from(${JSON.stringify(signerPrivateKey)}, "base64url"), format: "der", type: "pkcs8" })
process.stdout.write(JSON.stringify({ alg: "ed25519", keyId: request.keyId, sig: sign(null, message, key).toString("base64url") }))
`,
    { mode: 0o755 },
  )
  return { file, approvalDir }
}

function v2RequestFor({ runId, path, digest, nonce, approvalDir, signerKeyId }) {
  const message = Buffer.from(
    `teamwork-artifact-v1\u0000ed25519\u0000${signerKeyId}\u0000${path}\u0000${nonce}\u0000{"kind":"teamwork.test","verdict":"PASS"}`,
    "utf8",
  ).toString("base64url")
  return {
    v: 2,
    op: "sign-artifact",
    runId,
    alg: "ed25519",
    keyId: signerKeyId,
    path,
    digest,
    nonce,
    at: new Date().toISOString(),
    approvalRef: join(approvalDir, runId, `${contentSha256Hex(path)}.json`),
    message,
  }
}

function runV2Signer(stubFile, request) {
  const res = spawnSync(process.execPath, [stubFile], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 30_000,
  })
  let body
  try {
    body = JSON.parse(String(res.stdout ?? "").trim())
  } catch {}
  return { status: res.status, body, stdout: res.stdout, stderr: res.stderr }
}

function approvalFixture(label, { trustLevel = "human-approved", draftText, overrides = {} } = {}) {
  const { root, storage } = makeRoot(label)
  const approvalsDir = makeApprovalsDir(label)
  const keys = makeKeys()
  const runId = `${label}-${++caseSeq}`
  const draft = draftText ?? "# Approved spec\n\nDeliver fixture A1.\n"
  const env = approvalEnv(approvalsDir, keys)
  return { root, storage, approvalsDir, keys, runId, draft, env, trustLevel, overrides }
}

function ownerUidForSeam() {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : 0
  return Math.min(euid + 1, OWNER_UID_CEILING)
}

try {
  // ==========================================================================
  // 1. Print-mode reference ordering and the full approved flow
  // ==========================================================================
  {
    console.log("Testing print-mode approval ordering (one process per turn)...")
    const { root, storage } = makeRoot("print")
    const approvalsDir = makeApprovalsDir("print")
    const keys = makeKeys()
    const runId = "approval-print-flow"
    const env = approvalEnv(approvalsDir, keys)
    const gapDraft = "# Spec\n\n- goal: [OPEN: goal]\n- acceptance: [OPEN: acceptance]\n"
    const resolvedDraft = "# Spec\n\n- goal: ship the fixture\n- acceptance: A1 passes\n"
    const driverEnv = { ...env, OPENCODE_TEAMWORK_APPROVAL_DIR: approvalsDir }
    const seamUid = ownerUidForSeam()

    setApprovalOwnerUidForTest(seamUid)
    try {
      // Turn 1: the interviewer writes a gap-marked draft. Nothing else exists.
      const turn1 = runDriver({ root, storage, action: "write-draft", runId, draft: gapDraft, ownerUid: seamUid }, driverEnv, root)
      assert(turn1.result.ok, JSON.stringify(turn1.result))
      assert(!existsSync(runFile(root, runId, "plan.dag.json")), "no plan before approval")
      assert(!existsSync(runFile(root, runId, "ORIGINAL_REQUEST.md")), "no ORIGINAL_REQUEST.md before approval")

      const gapRequest = parseCliJson(runCli(["approve", "request", "--session", runId, "--json"], driverEnv, root))
      assert(
        gapRequest && gapRequest.openGaps === 2,
        `approve request must report the [OPEN:] gaps: ${JSON.stringify(gapRequest)}`,
      )
      assert.strictEqual(gapRequest.manifestDigest, null, "no manifest exists before the plan")

      // Signing a gap-marked draft without --allow-open is refused.
      const gapRequestFile = writeRequestFile(gapRequest.payload)
      const draftPath = runFile(root, runId, "prompt_draft.md")
      const keyFile = writeKeyFile(keys.pair)
      const refuseOpen = runCli(
        ["approve", "sign", "--request", gapRequestFile, "--draft", draftPath, "--key", keyFile, "--approver", "uid:parity"],
        driverEnv,
        root,
        `${gapRequest.promptDraftSha256.slice(0, 8)}\napprove\n`,
      )
      assert.notStrictEqual(refuseOpen.status, 0, "signing a gap-marked draft must be refused")
      assert(/OPEN/.test(refuseOpen.stderr), refuseOpen.stderr)

      // --allow-open records the gaps; the plan then refuses the approval.
      const allowOpen = runCli(
        ["approve", "sign", "--request", gapRequestFile, "--draft", draftPath, "--key", keyFile, "--approver", "uid:parity", "--allow-open"],
        driverEnv,
        root,
        `${gapRequest.promptDraftSha256.slice(0, 8)}\napprove\n`,
      )
      assert.strictEqual(allowOpen.status, 0, `${allowOpen.stdout}${allowOpen.stderr}`)
      const allowedArtifact = readApproval(approvalsDir, runId)
      assert.strictEqual(allowedArtifact.openGaps, 2, "the approval must record the gap count")
      const gapPlan = runDriver({ root, storage, action: "plan", runId, ownerUid: seamUid }, driverEnv, root)
      assert.strictEqual(gapPlan.result.ok, false, "an allow-open approval must not be plannable")
      assert(
        String(gapPlan.result.content).includes("AUTH_APPROVAL_INCOMPLETE"),
        `the plan must name the open-gap refusal: ${gapPlan.result.content}`,
      )
      assert(!existsSync(runFile(root, runId, "plan.dag.json")), "no plan after a refused approval")
      assert(!existsSync(runFile(root, runId, "ORIGINAL_REQUEST.md")), "no ORIGINAL_REQUEST.md after a refused approval")

      // Turn 2: the interviewer resolves the draft. Still nothing else exists.
      const turn2 = runDriver({ root, storage, action: "write-draft", runId, draft: resolvedDraft, ownerUid: seamUid }, driverEnv, root)
      assert(turn2.result.ok, JSON.stringify(turn2.result))
      assert(!existsSync(runFile(root, runId, "plan.dag.json")), "no plan before the approval turn")
      assert(!existsSync(runFile(root, runId, "ORIGINAL_REQUEST.md")), "no ORIGINAL_REQUEST.md before the approval turn")

      const request = parseCliJson(runCli(["approve", "request", "--session", runId, "--json"], driverEnv, root))
      assert(request && request.openGaps === 0, JSON.stringify(request))
      assert.strictEqual(request.promptDraftSha256, contentSha256Hex(Buffer.from(resolvedDraft, "utf8")))
      assert.strictEqual(request.promptDraftBytes, Buffer.byteLength(resolvedDraft))
      const requestFile = writeRequestFile(request.payload)
      const signed = runCli(
        ["approve", "sign", "--request", requestFile, "--draft", draftPath, "--key", keyFile, "--approver", "uid:parity"],
        driverEnv,
        root,
        `${request.promptDraftSha256.slice(0, 8)}\napprove\n`,
      )
      assert.strictEqual(signed.status, 0, `${signed.stdout}${signed.stderr}`)
      const approvalFile = join(approvalsDir, `${runId}.json`)
      assert(existsSync(approvalFile), "the approval must be written outside the run")
      if (process.platform === "win32") {
        console.log("SKIP: win32 does not report POSIX file modes; the 0600 approval assertion is recorded")
      } else {
        const mode = statSync(approvalFile).mode & 0o777
        assert.strictEqual(mode, 0o600, `the approval must be 0600 (got ${mode.toString(8)})`)
      }
      assert(!existsSync(runFile(root, runId, "approvals")), "no approval may be written inside the run")

      // Turn 3: only now can the sentinel plan.
      const turn3 = runDriver({ root, storage, action: "plan", runId, ownerUid: seamUid }, driverEnv, root)
      assert.strictEqual(turn3.result.ok, true, `${JSON.stringify(turn3.result)}`)
      assert(turn3.result.planExists, "the plan exists after the approval turn")
      assert(turn3.result.requestExists, "ORIGINAL_REQUEST.md exists after the approval turn")

      // approve verify re-runs the binding and agrees with the gate.
      const verify = parseCliJson(runCli(["approve", "verify", "--session", runId, "--json"], driverEnv, root))
      assert(verify && verify.ok === true, JSON.stringify(verify))
      const manifest = JSON.parse(readFileSync(runFile(root, runId, "run.manifest.json"), "utf8"))
      assert.strictEqual(verify.promptDraftSha256, manifest.specHash)
      assert.strictEqual(verify.promptDraftBytes, manifest.specBytes)
      assert.strictEqual(verify.approvalDigest, manifest.approvalDigest)
      assert.strictEqual(verify.approvalNonce, manifest.approvalNonce)
      assert.strictEqual(verify.approver, manifest.approvedBy)
      assert.strictEqual(verify.binding, "prompt")

      // Turn 4: evidence + final verification.
      const seed = runDriver({ root, storage, action: "seed", runId, ownerUid: seamUid }, driverEnv, root)
      assert(seed.result.ok, JSON.stringify(seed.result))
      const final = runDriver({ root, storage, action: "final", runId, ownerUid: seamUid }, driverEnv, root)
      assert.strictEqual(final.result.ok, true, `${JSON.stringify(final.result)}`)

      // Print-mode removal: a new process with the approval file gone refuses
      // the plan even though the previous turns succeeded.
      rmSync(approvalFile)
      const removed = runDriver({ root, storage, action: "plan", runId, ownerUid: seamUid }, driverEnv, root)
      assert.strictEqual(removed.result.ok, false, "the plan must refuse when the approval is removed")
      assert(
        String(removed.result.content).includes("AUTH_APPROVAL_MISSING"),
        `the refusal must name the missing approval: ${removed.result.content}`,
      )
    } finally {
      setApprovalOwnerUidForTest(null)
    }
    console.log("✓ print mode: draft → approval → plan → final_verify, ordering and removal refusal")
  }

  // ==========================================================================
  // 2. TUI: a single process; an in-memory flag cannot replace the file
  // ==========================================================================
  {
    console.log("Testing the single-process TUI path...")
    const fx = approvalFixture("tui")
    setApprovalOwnerUidForTest(ownerUidForSeam())
    try {
      await withEnv(fx.env, async () => {
        const tools = await toolsFor(fx.root, fx.env)
        setDraft(fx.root, fx.runId, fx.draft)
        writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft), fx.keys)
        const first = await planRun(tools, fx.runId)
        assert(!String(first.content).startsWith("refused:"), `the approved plan must succeed: ${first.content}`)
        // The in-memory flag is true for the second call; the file is gone.
        const inMemoryApproved = true
        rmSync(join(fx.approvalsDir, `${fx.runId}.json`))
        const second = await planRun(tools, fx.runId)
        assert.strictEqual(inMemoryApproved, true)
        assert(
          String(second.content).includes("AUTH_APPROVAL_MISSING"),
          `an in-memory approval flag must not substitute for the file: ${second.content}`,
        )
      })
    } finally {
      setApprovalOwnerUidForTest(null)
    }
    console.log("✓ TUI: in-memory approval does not replace the file")
  }

  // ==========================================================================
  // 3. Negative cases
  // ==========================================================================
  {
    console.log("Testing approval negatives...")
    const resolvedDraft = "# Approved spec\n\nDeliver fixture A1 exactly.\n"

    async function withCase(label, fn, opts = {}) {
      const fx = approvalFixture(label, { draftText: resolvedDraft, ...opts })
      setApprovalOwnerUidForTest(ownerUidForSeam())
      try {
        await withEnv(fx.env, async () => fn(fx))
      } finally {
        setApprovalOwnerUidForTest(null)
      }
    }

    // (a) no approval
    await withCase("no-approval", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_MISSING"), res.content)
      assert(!existsSync(runFile(fx.root, fx.runId, "plan.dag.json")), "no plan without an approval")
      assert(!existsSync(runFile(fx.root, fx.runId, "ORIGINAL_REQUEST.md")), "no request without an approval")
    })

    // (b) approval written inside the run directory is ignored
    await withCase("in-run-approval", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      const payload = basePayload(fx.runId, fx.draft)
      mkdirSync(runFile(fx.root, fx.runId, "approvals"), { recursive: true })
      writeApproval(runFile(fx.root, fx.runId, "approvals"), payload, fx.keys)
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_MISSING"), res.content)
    })

    // (c) a bare team/... identity
    await withCase("bare-approver", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft, "human-approved", { approvedBy: "team/sentinel" }), fx.keys)
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_NOT_HUMAN"), res.content)
    })

    // (d) expired approval
    await withCase("expired", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      writeApproval(
        fx.approvalsDir,
        basePayload(fx.runId, fx.draft, "human-approved", {
          approvedAt: new Date(Date.now() - 7_200_000).toISOString(),
          expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        }),
        fx.keys,
      )
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_STALE"), res.content)
    })

    // (e) approval bound to another run id
    await withCase("other-run", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      const payload = basePayload("another-run-id", fx.draft)
      const artifact = signApprovalArtifact(payload, { privateKey: fx.keys.pair.privateKey, keyId: fx.keys.keyId })
      writeFileSync(join(fx.approvalsDir, `${fx.runId}.json`), JSON.stringify(artifact, null, 2), { mode: 0o600 })
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(
        String(res.content).includes("AUTH_INVALID") || String(res.content).includes("AUTH_APPROVAL_INCOMPLETE"),
        res.content,
      )
    })

    // (f) edited draft after approval
    await withCase("edited-draft", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft), fx.keys)
      const tools = await toolsFor(fx.root, fx.env)
      const ok = await planRun(tools, fx.runId)
      assert(!String(ok.content).startsWith("refused:"), ok.content)
      setDraft(fx.root, fx.runId, `${fx.draft}\nA late extra requirement.\n`)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_STALE"), res.content)
    })

    // (g) remaining [OPEN:] gap in the draft
    await withCase("open-gap-draft", async (fx) => {
      const gapDraft = "# Spec\n\n- goal: [OPEN: goal]\n"
      setDraft(fx.root, fx.runId, gapDraft)
      writeApproval(fx.approvalsDir, basePayload(fx.runId, gapDraft, "human-approved", { openGaps: 0 }), fx.keys)
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_INCOMPLETE"), res.content)
    })

    // (h) replayed nonce: a valid approval with a new nonce after plan
    await withCase("replayed-nonce", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      const firstPayload = basePayload(fx.runId, fx.draft)
      writeApproval(fx.approvalsDir, firstPayload, fx.keys)
      const tools = await toolsFor(fx.root, fx.env)
      const ok = await planRun(tools, fx.runId)
      assert(!String(ok.content).startsWith("refused:"), ok.content)
      writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft), fx.keys)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_REPLAY"), res.content)
    })

    // (i) HMAC approval (the run's own key type)
    {
      const fx = approvalFixture("hmac-approval")
      const hmacKey = randomBytes(32)
      const hmacKeyB64 = hmacKey.toString("base64url")
      const env = approvalEnv(fx.approvalsDir, fx.keys, {
        OPENCODE_TEAMWORK_HMAC_KEY: hmacKeyB64,
        OPENCODE_TEAMWORK_HMAC_KEY_ID: "hmac_parity",
      })
      setApprovalOwnerUidForTest(ownerUidForSeam())
      try {
        await withEnv(env, async () => {
          setDraft(fx.root, fx.runId, fx.draft)
          const payload = basePayload(fx.runId, fx.draft)
          const relPath = `approvals/${fx.runId}.json`
          const digest = payloadDigest(payload)
          const nonce = payload.approvalNonce
          const at = new Date().toISOString()
          const base = { v: 1, alg: "hmac-sha256", keyId: "hmac_parity", path: relPath, digest, nonce, at }
          const mac = createHmac("sha256", hmacKey).update(canonicalJson(base)).digest("hex")
          writeFileSync(
            join(fx.approvalsDir, `${fx.runId}.json`),
            JSON.stringify({ ...payload, _auth: { ...base, mac } }, null, 2),
            { mode: 0o600 },
          )
          const tools = await toolsFor(fx.root, env)
          const res = await planRun(tools, fx.runId)
          assert(String(res.content).includes("AUTH_APPROVAL_NOT_HUMAN"), res.content)
        })
      } finally {
        setApprovalOwnerUidForTest(null)
      }
    }

    // (j) run-key approval: the approver key is also the run key
    {
      const fx = approvalFixture("run-key-approval")
      const env = approvalEnv(fx.approvalsDir, fx.keys, {
        OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: fx.keys.privateKey,
        OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: fx.keys.publicKey,
        OPENCODE_TEAMWORK_ED25519_KEY_ID: fx.keys.keyId,
      })
      setApprovalOwnerUidForTest(ownerUidForSeam())
      try {
        await withEnv(env, async () => {
          setDraft(fx.root, fx.runId, fx.draft)
          writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft), fx.keys)
          const tools = await toolsFor(fx.root, env)
          const res = await planRun(tools, fx.runId)
          assert(String(res.content).includes("AUTH_APPROVAL_NOT_HUMAN"), res.content)
        })
      } finally {
        setApprovalOwnerUidForTest(null)
      }
    }

    // (k) a planHash pre-commitment to a different plan
    await withCase("plan-hash", async (fx) => {
      setDraft(fx.root, fx.runId, fx.draft)
      writeApproval(
        fx.approvalsDir,
        basePayload(fx.runId, fx.draft, "human-approved", { planHash: "0".repeat(64) }),
        fx.keys,
      )
      const tools = await toolsFor(fx.root, fx.env)
      const res = await planRun(tools, fx.runId)
      assert(String(res.content).includes("AUTH_APPROVAL_STALE"), res.content)
    })

    console.log("✓ negatives: missing/edited/other-run/HMAC/run-key/expired/replay/open-gaps/bare/in-run/plan-hash")
  }

  // ==========================================================================
  // 4. The approver fixture can tamper with every binding field
  // ==========================================================================
  {
    console.log("Testing tampered approval fields...")
    const keys = makeKeys()
    const draftText = "# Approved spec\n\nDeliver fixture A1.\n"
    const payload = basePayload("tamper-run", draftText, "human-approved", { planHash: "a".repeat(64) })
    const valid = signApprovalArtifact(payload, { privateKey: keys.pair.privateKey, keyId: keys.keyId })
    const publicKey = keys.pair.publicKey
    const good = verifyApprovalArtifact(valid, { publicKey, expectedKeyId: keys.keyId })
    assert(good.ok, `the untampered approval must verify: ${JSON.stringify(good)}`)
    const tampers = {
      draft: (a) => (a.promptDraftSha256 = "0".repeat(64)),
      runId: (a) => (a.runId = "different-run"),
      alg: (a) => (a._auth.alg = "hmac-sha256"),
      approver: (a) => (a.approvedBy = "uid:mallory"),
      nonce: (a) => (a.approvalNonce = randomBytes(32).toString("base64url")),
      planHash: (a) => (a.planHash = "b".repeat(64)),
      openGaps: (a) => (a.openGaps = 1),
    }
    for (const [name, mutate] of Object.entries(tampers)) {
      const copy = JSON.parse(JSON.stringify(valid))
      mutate(copy)
      const res = verifyApprovalArtifact(copy, { publicKey, expectedKeyId: keys.keyId })
      assert.strictEqual(res.ok, false, `a tampered ${name} must not verify`)
    }
    console.log("✓ tamper: draft, runId, alg, approver, nonce, planHash, openGaps all fail verification")
  }

  // ==========================================================================
  // 5. Signer scope: approvals/ never goes through the plugin/command signer
  // ==========================================================================
  {
    console.log("Testing AUTH_APPROVAL_SCOPE...")
    const keys = makeKeys()
    const hmacKey = randomBytes(32).toString("base64url")
    const storage = mapStorage(makeRoot("scope").root)
    const local = createAuthContext(storage, {})
    let localError
    try {
      await local.signArtifact("approvals/run.json", { runId: "run" })
    } catch (err) {
      localError = err
    }
    assert(localError && localError.failure.code === "AUTH_APPROVAL_SCOPE", String(localError))
    let runScopeError
    try {
      await local.signRunArtifact("run", "approvals/run.json", { runId: "run" })
    } catch (err) {
      runScopeError = err
    }
    assert(runScopeError && runScopeError.failure.code === "AUTH_APPROVAL_SCOPE", String(runScopeError))

    const marker = join(testDir, "signer-called.txt")
    const signerScript = join(testDir, "signer.mjs")
    writeFileSync(
      signerScript,
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "called")\nprocess.stdout.write(JSON.stringify({alg:"ed25519",keyId:"x",sig:"AA"})+"\\n")\n`,
    )
    chmodSync(signerScript, 0o755)
    const external = createAuthContext(storage, {
      OPENCODE_TEAMWORK_SIGNER: `command:${signerScript}`,
      OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY: keys.publicKey,
      OPENCODE_TEAMWORK_SIGNER_KEY_ID: keys.keyId,
      OPENCODE_TEAMWORK_HMAC_KEY: hmacKey,
    })
    let signerError
    try {
      await external.signArtifact("approvals/run.json", { runId: "run" })
    } catch (err) {
      signerError = err
    }
    assert(signerError && signerError.failure.code === "AUTH_APPROVAL_SCOPE", String(signerError))
    assert(!existsSync(marker), "the command signer must not be invoked for an approval path")
    console.log("✓ scope: local, run-artifact and command signers refuse approvals/ before signing")
  }

  // ==========================================================================
  // 6. Legacy manifests and unchanged defaults
  // ==========================================================================
  {
    console.log("Testing legacy and unchanged paths...")
    const resolvedDraft = "# Approved spec\n\nDeliver fixture A1 exactly.\n"

    // (a) v2 manifest keeps manifestDigest-bound approval semantics.
    {
      const fx = approvalFixture("legacy-v2", { draftText: resolvedDraft })
      setApprovalOwnerUidForTest(ownerUidForSeam())
      try {
        await withEnv(fx.env, async () => {
          const tools = await toolsFor(fx.root, fx.env)
          setDraft(fx.root, fx.runId, fx.draft)
          writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft), fx.keys)
          const plan = await planRun(tools, fx.runId)
          assert(!String(plan.content).startsWith("refused:"), plan.content)
          await seedVerified(tools, fx.runId)

          const runDir = join(fx.root, ".opencode", "teamwork", fx.runId)
          const manifestFile = join(runDir, "run.manifest.json")
          const v3 = JSON.parse(readFileSync(manifestFile, "utf8"))
          const auth = createAuthContext(mapStorage(fx.root), process.env)
          const v2 = { ...v3, version: 2 }
          delete v2.specHash
          delete v2.specBytes
          delete v2.approvalDigest
          delete v2.approvalNonce
          delete v2.approvalBinding
          delete v2.approvedBy
          delete v2.approvedAt
          const signedV2 = await auth.signRunArtifact(fx.runId, "run.manifest.json", v2)
          writeFileSync(manifestFile, JSON.stringify(signedV2, null, 2))
          // v2 approval: manifestDigest-bound, issued after the manifest.
          const v2Payload = {
            runId: fx.runId,
            trustLevel: "human-approved",
            approvedBy: "uid:parity",
            approvedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            manifestDigest: payloadDigest(signedV2),
          }
          writeApproval(fx.approvalsDir, v2Payload, fx.keys)
          const final = await finalVerify(tools, fx.runId)
          assert.strictEqual(final.status, "PASS", `a v2 manifest must stay readable: ${final.content}`)
        })
      } finally {
        setApprovalOwnerUidForTest(null)
      }
    }

    // (b) v1 in-run approval read with the run key (HMAC), recorded unbound.
    {
      const fx = approvalFixture("legacy-v1", { draftText: resolvedDraft })
      const hmacKey = randomBytes(32)
      const hmacKeyB64 = hmacKey.toString("base64url")
      const env = approvalEnv(fx.approvalsDir, fx.keys, {
        OPENCODE_TEAMWORK_HMAC_KEY: hmacKeyB64,
        OPENCODE_TEAMWORK_HMAC_KEY_ID: "hmac_legacy",
      })
      setApprovalOwnerUidForTest(ownerUidForSeam())
      try {
        await withEnv(env, async () => {
          // Plan at local-hmac (no approval), then down-version the baseline.
          const tools = await toolsFor(fx.root, env)
          setDraft(fx.root, fx.runId, fx.draft)
          const plan = await planRun(tools, fx.runId, "local-hmac")
          assert(!String(plan.content).startsWith("refused:"), plan.content)
          await seedVerified(tools, fx.runId)

          const runDir = join(fx.root, ".opencode", "teamwork", fx.runId)
          for (const name of ["plan.dag.json", "state.json"]) {
            const file = join(runDir, name)
            const value = JSON.parse(readFileSync(file, "utf8"))
            value.trustLevel = "human-approved"
            writeFileSync(file, JSON.stringify(value, null, 2))
          }
          const manifestFile = join(runDir, "run.manifest.json")
          const current = JSON.parse(readFileSync(manifestFile, "utf8"))
          const auth = createAuthContext(mapStorage(fx.root), process.env)
          const v1 = { ...current, version: 1, trustLevel: "human-approved" }
          delete v1.approvalPolicy
          delete v1.approvalKeyId
          delete v1.specHash
          delete v1.specBytes
          delete v1.approvalDigest
          delete v1.approvalNonce
          delete v1.approvalBinding
          delete v1.approvedBy
          delete v1.approvedAt
          const signedV1 = await auth.signRunArtifact(fx.runId, "run.manifest.json", v1)
          writeFileSync(manifestFile, JSON.stringify(signedV1, null, 2))

          const relPath = `approvals/${fx.runId}.json`
          const payload = {
            runId: fx.runId,
            trustLevel: "human-approved",
            approvedBy: "fixture-human",
            approvedAt: new Date().toISOString(),
            manifestDigest: payloadDigest(signedV1),
          }
          const digest = payloadDigest(payload)
          const at = new Date().toISOString()
          const base = {
            v: 1,
            alg: "hmac-sha256",
            keyId: signedV1.runKeyId,
            path: relPath,
            digest,
            nonce: signedV1.runNonce,
            at,
          }
          const mac = createHmac("sha256", hmacKey).update(canonicalJson(base)).digest("hex")
          const approvalDir = join(runDir, "approvals")
          mkdirSync(approvalDir, { recursive: true })
          writeFileSync(
            join(approvalDir, `${fx.runId}.json`),
            JSON.stringify({ ...payload, _auth: { ...base, mac } }, null, 2),
          )
          const final = await finalVerify(tools, fx.runId)
          assert.strictEqual(final.status, "PASS", `a v1 in-run approval must stay readable: ${final.content}`)
          const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          assert(events.some((e) => e.event === "approval_unbound"), "v1 must record approval_unbound")
        })
      } finally {
        setApprovalOwnerUidForTest(null)
      }
    }

    // (c) local-hmac unchanged: a v3 plan + PASS without an approval.
    {
      const fx = approvalFixture("local-hmac")
      await withEnv(fx.env, async () => {
        const tools = await toolsFor(fx.root, fx.env)
        setDraft(fx.root, fx.runId, fx.draft)
        const plan = await planRun(tools, fx.runId, "local-hmac")
        assert(!String(plan.content).startsWith("refused:"), plan.content)
        const manifest = JSON.parse(readFileSync(runFile(fx.root, fx.runId, "run.manifest.json"), "utf8"))
        assert.strictEqual(manifest.trustLevel, "local-hmac")
        assert.strictEqual(manifest.approvalPolicy, "none")
        assert.strictEqual(manifest.approvalDigest, undefined)
        assert.strictEqual(manifest.specHash, contentSha256Hex(Buffer.from(fx.draft, "utf8")))
        await seedVerified(tools, fx.runId)
        const final = await finalVerify(tools, fx.runId)
        assert.strictEqual(final.status, "PASS", final.content)
      })
    }

    // (d) allowUnsignedLegacy unchanged: an unsigned plan is still explicit.
    {
      const { root } = makeRoot("unsigned")
      const runId = "unsigned-legacy"
      setDraft(root, runId, resolvedDraft)
      const tools = await withEnv({ OPENCODE_TEAMWORK_HMAC_KEY: undefined, OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: undefined, OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: undefined }, async () => {
        const local = {}
        await registerTeamworkTools(
          {
            tool: {
              transform: async (cb) => {
                await cb({ namespace: () => {}, add: (tool) => (local[tool.name] = tool) })
              },
            },
            session: { get: async () => ({ agent: "team/sentinel" }) },
            // no storage and no env key => AUTH_UNAVAILABLE unless explicitly allowed
          },
          root,
        )
        return local
      })
      const refused = await tools.plan.execute(
        { sessionId: runId, topology: "iterative-coding", tasks: [{ id: "A1" }] },
        { sessionID: ROOT_SESSION },
      )
      assert(String(refused.content).includes("AUTH_UNAVAILABLE"), refused.content)
      const allowed = await tools.plan.execute(
        {
          sessionId: runId,
          topology: "iterative-coding",
          allowUnsignedLegacy: true,
          victoryAudit: "skip",
          victorySkipReason: "fixture: unsigned legacy",
          requireHandoffs: "skip",
          tasks: [{ id: "A1" }],
        },
        { sessionID: ROOT_SESSION },
      )
      assert(!String(allowed.content).startsWith("refused:"), allowed.content)
      assert(!existsSync(runFile(root, runId, "run.manifest.json")), "allowUnsignedLegacy must stay unsigned")
    }

    // (e) ci-attested uses attestedBy and the same prompt binding.
    {
      const fx = approvalFixture("ci", { draftText: resolvedDraft })
      setApprovalOwnerUidForTest(ownerUidForSeam())
      try {
        await withEnv(fx.env, async () => {
          const tools = await toolsFor(fx.root, fx.env)
          setDraft(fx.root, fx.runId, fx.draft)
          writeApproval(fx.approvalsDir, basePayload(fx.runId, fx.draft, "ci-attested"), fx.keys)
          const plan = await planRun(tools, fx.runId, "ci-attested")
          assert(!String(plan.content).startsWith("refused:"), plan.content)
          const manifest = JSON.parse(readFileSync(runFile(fx.root, fx.runId, "run.manifest.json"), "utf8"))
          assert.strictEqual(manifest.approvalBinding, "prompt")
          assert.strictEqual(manifest.approvedBy, "ci:github/workflows/ci.yml")
          await seedVerified(tools, fx.runId)
          const final = await finalVerify(tools, fx.runId)
          assert.strictEqual(final.status, "PASS", final.content)
        })
      } finally {
        setApprovalOwnerUidForTest(null)
      }
    }

    console.log("✓ legacy: v1 unbound + v2 readable; local-hmac/allowUnsignedLegacy unchanged; ci-attested bound")
  }

  // ==========================================================================
  // 6. Signer approval producer (`approve signer`) and the v2 signer stub
  // ==========================================================================
  {
    console.log("Testing the signer approval producer...")
    const { root } = makeRoot("signer-approval")
    const outDir = mkdtempSync(join(tmpdir(), "teamwork-signer-approvals-"))
    roots.push(outDir)
    const keys = makeKeys()
    const keyFile = writeKeyFile(keys.pair)
    const runId = `signer-${++caseSeq}`
    const relPath = "verify/victory.json"
    const digest = "ab".repeat(32)
    const emptyEnv = { OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR: "" }
    const runDir = join(root, ".opencode", "teamwork", runId)
    mkdirSync(runDir, { recursive: true })
    const runNonce = randomBytes(32).toString("base64url")
    writeFileSync(join(runDir, "run.manifest.json"), JSON.stringify({ version: 3, runNonce }, null, 2))

    const produced = runCli(
      [
        "approve",
        "signer",
        "--session",
        runId,
        "--path",
        relPath,
        "--digest",
        digest,
        "--key",
        keyFile,
        "--approver",
        "uid:signer-approver",
        "--ttl",
        "1h",
        "--out",
        outDir,
      ],
      emptyEnv,
      root,
    )
    assert.strictEqual(produced.status, 0, `${produced.stdout}${produced.stderr}`)
    const approvalFile = signerApprovalFileFor(outDir, runId, relPath)
    assert(existsSync(approvalFile), `the signer approval must be at ${approvalFile}`)
    const artifact = JSON.parse(readFileSync(approvalFile, "utf8"))
    assert.strictEqual(artifact.kind, "teamwork.signer-approval")
    assert.strictEqual(artifact.v, 1)
    assert.strictEqual(artifact.runId, runId)
    assert.strictEqual(artifact.path, relPath)
    assert.strictEqual(artifact.digest, digest)
    assert.strictEqual(artifact.approvedBy, "uid:signer-approver")
    assert(Buffer.from(artifact.nonce, "base64url").length >= 16, "nonce must be >=128 bits")
    assert(Buffer.from(artifact.approvalId, "base64url").length >= 16, "approvalId must be >=128 bits")
    assert(Number.isFinite(Date.parse(artifact.expiresAt)), "expiresAt must be an ISO timestamp")
    assert.strictEqual(artifact._auth.alg, "ed25519")
    for (const promptField of [
      "binding",
      "trustLevel",
      "promptDraftSha256",
      "promptDraftBytes",
      "openGaps",
      "approvalNonce",
      "planHash",
    ]) {
      assert(!(promptField in artifact), `a signer approval must not reuse the prompt field ${promptField}`)
    }
    if (process.platform !== "win32") {
      assert.strictEqual(statSync(approvalFile).mode & 0o777, 0o600, "the signer approval must be 0600")
    }

    // A v2 signer stub accepts the produced approval and signs the request.
    const approverKeyId = artifact._auth.keyId
    const signerKeys = makeKeys()
    const signerKeyId = "signer_stub"
    const ledgerFile = join(testDir, `signer-ledger-${++caseSeq}.json`)
    const stub = writeV2SignerStub({
      signerPrivateKey: signerKeys.privateKey,
      signerKeyId,
      approverPublicKey: keys.publicKey,
      approverKeyId,
      approvalDir: outDir,
      ledgerFile,
    }).file
    const nonce = runNonce
    const request = v2RequestFor({ runId, path: relPath, digest, nonce, approvalDir: outDir, signerKeyId })
    const accepted = runV2Signer(stub, request)
    assert.strictEqual(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`)
    assert.strictEqual(accepted.body.alg, "ed25519")
    assert.strictEqual(accepted.body.keyId, signerKeyId)
    const signerPublic = createPublicKey({
      key: Buffer.from(signerKeys.publicKey, "base64url"),
      format: "der",
      type: "spki",
    })
    assert(
      cryptoVerify(
        null,
        Buffer.from(request.message, "base64url"),
        signerPublic,
        Buffer.from(accepted.body.sig, "base64url"),
      ),
      "the stub signature must verify over the request message",
    )

    // Wrong digest: the approval file exists at the same (run, path) but the
    // binding check refuses it.
    const wrongDigest = runV2Signer(stub, { ...request, digest: "cd".repeat(32) })
    assert.notStrictEqual(wrongDigest.status, 0, "a wrong digest must be refused")
    assert.strictEqual(wrongDigest.body.code, "E_APPROVAL_BINDING", JSON.stringify(wrongDigest.body))

    // Wrong path/runId derive a different approvalRef, which does not exist.
    const wrongPath = runV2Signer(
      stub,
      v2RequestFor({ runId, path: "verify/final.json", digest, nonce, approvalDir: outDir, signerKeyId }),
    )
    assert.notStrictEqual(wrongPath.status, 0, "a wrong path must be refused")
    assert.strictEqual(wrongPath.body.code, "E_APPROVAL_OPEN", JSON.stringify(wrongPath.body))
    const wrongRun = runV2Signer(
      stub,
      v2RequestFor({ runId: "another-run", path: relPath, digest, nonce, approvalDir: outDir, signerKeyId }),
    )
    assert.notStrictEqual(wrongRun.status, 0, "a wrong run id must be refused")
    assert.strictEqual(wrongRun.body.code, "E_APPROVAL_OPEN", JSON.stringify(wrongRun.body))

    // Expired approval: built for a window that has already ended.
    const expiredPath = "verify/expired.json"
    const expiredPayload = buildSignerApprovalPayload({
      runId,
      path: expiredPath,
      digest,
      nonce: runNonce,
      approver: "uid:signer-approver",
      ttlMs: 60 * 60 * 1000,
      now: Date.now() - 2 * 60 * 60 * 1000,
    })
    const expiredArtifact = signSignerApproval(expiredPayload, {
      privateKey: keys.pair.privateKey,
      keyId: approverKeyId,
    })
    const expiredWritten = writeSignerApprovalAtomically(outDir, runId, expiredPath, expiredArtifact)
    assert(expiredWritten.ok, JSON.stringify(expiredWritten))
    const expired = runV2Signer(stub, v2RequestFor({ runId, path: expiredPath, digest, nonce, approvalDir: outDir, signerKeyId }))
    assert.notStrictEqual(expired.status, 0, "an expired approval must be refused")
    assert.strictEqual(expired.body.code, "E_APPROVAL_EXPIRED", JSON.stringify(expired.body))

    // Replay: the same approvalId cannot be used a second time by the stub.
    const replay = runV2Signer(stub, request)
    assert.notStrictEqual(replay.status, 0, "a replayed approvalId must be refused")
    assert.strictEqual(replay.body.code, "E_APPROVAL_REPLAY", JSON.stringify(replay.body))

    // The CLI refuses an output inside the run directory.
    const inRun = runCli(
      [
        "approve",
        "signer",
        "--session",
        runId,
        "--path",
        relPath,
        "--digest",
        digest,
        "--key",
        keyFile,
        "--out",
        runDir,
      ],
      emptyEnv,
      root,
    )
    assert.strictEqual(inRun.status, 1, `${inRun.stdout}${inRun.stderr}`)
    assert(/inside the run directory/.test(inRun.stderr), inRun.stderr)
    assert(!existsSync(signerApprovalFileFor(runDir, runId, relPath)), "no approval may be written into the run")

    // Without --out or the env there is no destination: refuse before signing.
    const noDir = runCli(
      ["approve", "signer", "--session", runId, "--path", relPath, "--digest", digest, "--key", keyFile],
      emptyEnv,
      root,
    )
    assert.strictEqual(noDir.status, 1, `${noDir.stdout}${noDir.stderr}`)
    assert(/OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR is not set/.test(noDir.stderr), noDir.stderr)

    console.log("✓ producer writes the documented file; the v2 stub accepts it; wrong digest/path/runId/expiry/replay fail; in-run output refused")
  }

  console.log("All authenticated prompt-approval tests passed")
} finally {
  setApprovalOwnerUidForTest(null)
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  rmSync(testDir, { recursive: true, force: true })
}
