#!/usr/bin/env node
// test-agy-parity.mjs — L0 E2E Parity & Audit Regression Suite
//
// Opaque-box 4-tier test suite covering N = 13 feature units across 5 surfaces:
//   - M1 regressions: M1.1 (dbPathFor), M1.2 (S3923), M1.3 (approval-driver runId), M1.4 (service*.json URL guard)
//   - agy parity gaps: A1..A9
//   - Tiers: T1 (Feature Coverage, 65), T2 (Boundary & Corner, 65), T3 (Pairwise, 15), T4 (E2E Scenarios, 7) => 152 cases
//
// Zero runtime dependencies; no @opencode/* imports.
// Usage: node scripts/test-agy-parity.mjs [--milestone=M1|M3|M4|all] [--tier=T1|T2|T3|T4|all] [--verbose]

import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

import { registerTool } from "./tool-registry.mjs"
import { collectSecurityReport } from "../lib/security.mjs"
import { verifyRun } from "../lib/verify.mjs"
import { TEAM_AGENTS } from "../lib/team.mjs"
import pluginDefault, { COMMANDS } from "../plugins/opencode-teamwork/index.ts"
import { registerTeamworkTools, registerTeamworkHooks } from "../plugins/opencode-teamwork/tools.ts"
import { createAuthContext } from "../plugins/opencode-teamwork/auth.ts"
import { refreshRunBriefing } from "../plugins/opencode-teamwork/briefing.ts"
import { probeLemmaToolchain } from "../plugins/opencode-teamwork/lemma.ts"
import { evaluateStrictGate, renderGateStatus } from "../plugins/opencode-teamwork/strict.ts"
import { setWriteAnomalyAuditPathForTest, resolveTrustedExecutable } from "../plugins/opencode-teamwork/safe-fs.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const CLI_PATH = join(REPO_ROOT, "bin", "opencode-teamwork.mjs")
const APPROVAL_DRIVER_PATH = join(REPO_ROOT, "scripts", "approval-driver.mjs")
const PROMPT_LINT_PATH = join(REPO_ROOT, "scripts", "lint-prompts.mjs")
const CATALOG_TEST_PATH = join(REPO_ROOT, "scripts", "test-catalog.mjs")
const GIT_BIN = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"].find(existsSync) ?? "git"
const SQLITE_BIN = resolveTrustedExecutable("sqlite3")

// CLI flags
const args = process.argv.slice(2)
let milestoneFilter = "all"
let tierFilter = "all"
let verbose = false
for (const arg of args) {
  if (arg.startsWith("--milestone=")) milestoneFilter = arg.slice("--milestone=".length).toUpperCase()
  else if (arg.startsWith("--tier=")) tierFilter = arg.slice("--tier=".length).toUpperCase()
  else if (arg === "--verbose" || arg === "-v") verbose = true
}
if (milestoneFilter === "ALL") milestoneFilter = "all"
if (tierFilter === "ALL") tierFilter = "all"

const PARITY_TMP_ROOT = mkdtempSync(join(tmpdir(), "teamwork-parity-"))
setWriteAnomalyAuditPathForTest(join(PARITY_TMP_ROOT, "write-anomalies.jsonl"))

let sandboxSeq = 0
async function withSandbox(label, fn) {
  sandboxSeq += 1
  const safeLabel = String(label).replace(/[^A-Za-z0-9._-]/g, "_")
  const dir = mkdtempSync(join(PARITY_TMP_ROOT, `${String(sandboxSeq).padStart(3, "0")}-${safeLabel}-`))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function withEnv(overrides, fn) {
  const prev = new Map()
  for (const [k, v] of Object.entries(overrides)) {
    prev.set(k, Object.hasOwn(process.env, k) ? process.env[k] : undefined)
    if (v === undefined || v === null) delete process.env[k]
    else process.env[k] = String(v)
  }
  try {
    return await fn()
  } finally {
    for (const [k, old] of prev.entries()) {
      if (old === undefined) delete process.env[k]
      else process.env[k] = old
    }
  }
}

async function withLoopbackServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => resolveListen())
  })
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    return await fn({ server, port, baseUrl })
  } finally {
    await new Promise((resolveClose) => server.close(() => resolveClose()))
  }
}

function writeStubBin(binDir, name, scriptBody) {
  mkdirSync(binDir, { recursive: true })
  const p = join(binDir, name)
  writeFileSync(p, `#!${process.execPath}\n${scriptBody}\n`, "utf8")
  chmodSync(p, 0o755)
  return p
}

let sqliteModulePromise
function loadNodeSqlite() {
  if (sqliteModulePromise === undefined) {
    sqliteModulePromise = import("node:sqlite").catch(() => null)
  }
  return sqliteModulePromise
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

async function createSessionDb(dbPath, rows) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const schema = `CREATE TABLE IF NOT EXISTS session_v2 (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    agent TEXT,
    cost REAL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_reasoning INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER
  )`
  const mod = await loadNodeSqlite()
  if (mod && typeof mod.DatabaseSync === "function") {
    const db = new mod.DatabaseSync(dbPath)
    try {
      db.exec(schema)
      const ins = db.prepare(
        "INSERT OR REPLACE INTO session_v2 (id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      for (const row of rows) ins.run(...row)
    } finally {
      db.close()
    }
    return
  }
  const stmts = [
    schema,
    ...rows.map(
      (r) =>
        `INSERT OR REPLACE INTO session_v2 (id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (${r
          .map(sqlLiteral)
          .join(", ")})`,
    ),
  ]
  if (!SQLITE_BIN) {
    throw new Error(
      "sqlite3 fallback unavailable: no trusted sqlite3 executable on PATH (install sqlite3 or use a Node build with the node:sqlite module)",
    )
  }
  execFileSync(SQLITE_BIN, [dbPath, `${stmts.join(";\n")};`], { encoding: "utf8", timeout: 5000 })
}

const DEFAULT_AGENTS = {
  ses_sentinel: { agent: "team/sentinel" },
  ses_orchestrator: { agent: "team/orchestrator" },
  ses_crafter: { agent: "team/crafter" },
  ses_worker: { agent: "team/worker", parentID: "ses_sentinel" },
  ses_verifier: { agent: "team/verifier", parentID: "ses_sentinel" },
  ses_falsifier: { agent: "team/falsifier", parentID: "ses_sentinel" },
  ses_auditor: { agent: "team/security-auditor", parentID: "ses_sentinel" },
  ses_victory: { agent: "team/victory-auditor", parentID: "ses_sentinel" },
  ses_seg: { agent: "team/segment-reviewer", parentID: "ses_sentinel" },
  ses_synth: { agent: "team/synthesizer", parentID: "ses_sentinel" },
  ses_proof: { agent: "team/proof-worker", parentID: "ses_sentinel" },
  ses_form_rev: { agent: "team/formalization-reviewer", parentID: "ses_sentinel" },
}

async function makeHarness(root, options = {}) {
  const store = new Map()
  const storage = {
    get: async (k) => store.get(k),
    set: async (k, v) => {
      store.set(k, v)
    },
    remove: async (k) => {
      store.delete(k)
    },
    scan: async () => ({ entries: [], hasMore: false }),
  }
  const agentsMap = { ...DEFAULT_AGENTS, ...(options.agents ?? {}) }
  const tools = {}
  const commands = {}
  const permissionHooks = {}
  const sessionHooks = {}
  const switched = []
  const prompted = []

  const ctx = {
    app: {
      version: options.version ?? "2.4.1",
      ...(options.channel ? { channel: options.channel } : {}),
    },
    location: { directory: root },
    storage,
    tool: {
      transform: async (cb) => {
        await cb({
          namespace: () => {},
          add: (tool) => registerTool(tools, tool),
        })
      },
    },
    command: {
      transform: async (cb) => {
        await cb({
          add: (cmd) => {
            commands[cmd.name] = cmd
          },
        })
      },
    },
    session: {
      get: async ({ sessionID }) => {
        const entry = agentsMap[sessionID]
        if (!entry) return undefined
        return options.withSessionCost
          ? { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...entry }
          : { ...entry }
      },
      switchAgent: async (payload) => {
        switched.push(payload)
      },
      prompt: async (payload) => {
        prompted.push(payload)
      },
      hook: async (name, handler) => {
        sessionHooks[name] = handler
      },
    },
    ...(options.omitPermission
      ? {}
      : {
          permission: {
            hook: async (name, handler) => {
              permissionHooks[name] = handler
            },
          },
        }),
  }

  if (options.viaSetup) {
    const origWarn = console.warn
    console.warn = () => {}
    try {
      await pluginDefault.setup(ctx)
    } finally {
      console.warn = origWarn
    }
  } else {
    await registerTeamworkTools(ctx, root)
    if (!options.omitPermission) {
      await registerTeamworkHooks(ctx, root)
    }
  }

  return { ctx, tools, commands, permissionHooks, sessionHooks, switched, prompted, store, storage }
}

function makePdfBuffer(textContent) {
  const escaped = String(textContent).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  const streamBody = escaped ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : ""
  const compressed = deflateSync(Buffer.from(streamBody, "utf8"))
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n",
    `4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
  ]
  const head = Buffer.from(parts.join(""), "latin1")
  const tail = Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")
  return Buffer.concat([head, compressed, tail])
}

function makeUnreadableImagePdfBuffer() {
  const streamBody = "q 100 0 0 100 0 0 cm /Im0 Do Q"
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n4 0 obj << /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream\nendobj\n%%EOF\n`,
    "latin1",
  )
}

function makePassReportInput(sessionId, taskId, extra = {}) {
  return {
    sessionId,
    taskId,
    status: "PASS",
    summary: `Verified ${taskId} cleanly.`,
    checks: [{ name: "unit-check", type: "check", passed: true }],
    ...extra,
  }
}

function makeHandoffInput(sessionId, taskId, conclusion = "Completed cleanly.") {
  return {
    sessionId,
    ...(taskId ? { taskId } : {}),
    observation: "## 1. Observation\nRan checks and inspected artifacts.",
    logicChain: "## 2. Logic Chain\nChecks passed, therefore requirement holds.",
    caveats: "## 3. Caveats\nNo caveats.",
    conclusion: `## 4. Conclusion\n${conclusion}`,
    verificationMethod: "## 5. Verification Method\nRe-run test command.",
  }
}

function makeThreePhaseVictorySummary(verdict = "VICTORY CONFIRMED") {
  return [
    "=== VICTORY AUDIT REPORT ===",
    `VERDICT: ${verdict}`,
    "PHASE A — TIMELINE: No timeline anomalies observed.",
    "PHASE B — INTEGRITY CHECK: Integrity mode rules respected.",
    "PHASE C — INDEPENDENT TEST EXECUTION: Re-ran suite; observed matches claimed.",
  ].join("\n")
}

function securityBaseOpts(dir, overrides = {}) {
  const groupFile = join(dir, "group")
  try {
    writeFileSync(groupFile, "users:x:1000:\nstaff:x:1001:\n", { flag: "wx" })
  } catch (err) {
    if (err?.code !== "EEXIST") throw err
  }
  const repoRoot = join(dir, "repo")
  mkdirSync(repoRoot, { recursive: true })
  return {
    env: { OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "fixture-pub" },
    platform: "linux",
    configDir: join(dir, "absent-config"),
    pluginDir: join(dir, "absent-plugin"),
    ptraceScope: "1",
    groupFile,
    groups: [1000],
    selinux: "1",
    euid: 4242,
    repoRoot,
    containmentMode: "pinned",
    readContainment: true,
    ...overrides,
  }
}

function readAgentPrompt(name) {
  return readFileSync(join(REPO_ROOT, "agents", "team", name), "utf8")
}

// Discovers whichever teamwork_* tool/parameter implements A3 follow-up request appending
async function invokeFollowUpAppend(tools, sessionId, message, callCtx) {
  // Check dedicated follow-up / append tools first
  const candidateToolNames = Object.keys(tools)
    .filter((k) => /^teamwork_.*(append|follow|request)/i.test(k) && k !== "teamwork_route")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of candidateToolNames) {
    const tool = tools[name]
    const props = tool?.input?.["~standard"]?.jsonSchema?.input?.({ target: "draft-2020-12" })?.properties ?? {}
    const msgKey = ["message", "followUp", "followup", "text", "request", "content"].find((k) => k in props)
    if (msgKey) {
      return await tool.execute({ sessionId, [msgKey]: message }, callCtx)
    }
  }
  // Check teamwork_plan / teamwork_status / teamwork_resume parameter extensions
  for (const name of ["teamwork_plan", "teamwork_status", "teamwork_resume"]) {
    const tool = tools[name]
    if (!tool) continue
    const props = tool.input?.["~standard"]?.jsonSchema?.input?.({ target: "draft-2020-12" })?.properties ?? {}
    const msgKey = ["followUp", "followup", "appendRequest", "followUpMessage"].find((k) => k in props)
    if (msgKey) {
      if (name === "teamwork_plan") {
        // A3: the documented minimal call is `{ sessionId, followUp }`; the
        // tool reads the persisted topology/tasks from the run.
        return await tool.execute({ sessionId, [msgKey]: message }, callCtx)
      }
      return await tool.execute({ sessionId, [msgKey]: message }, callCtx)
    }
  }
  assert.fail("A3 unimplemented: no teamwork_* tool or parameter supports appending follow-up messages to ORIGINAL_REQUEST.md")
}

// Helper to create a signed/complete run up to verify/victory or final_verify
async function setupCodingRunToPass(tools, root, sessionId, opts = {}) {
  const topology = opts.topology ?? "iterative-coding"
  const verification = opts.verification ?? "standard"
  const integrityMode = opts.integrityMode ?? "development"
  const requireHandoffs = opts.requireHandoffs ?? "required"
  const victoryAudit = opts.victoryAudit ?? "required"
  const taskId = opts.taskId ?? "t1"
  const draftDir = join(root, ".opencode", "teamwork", sessionId)
  if (!opts.skipInterview) {
    mkdirSync(draftDir, { recursive: true })
    writeFileSync(join(draftDir, "prompt_draft.md"), opts.draftText ?? "# Spec\n\nImplement parser fix.\n")
  }
  const planRes = await tools.teamwork_plan.execute(
    {
      sessionId,
      topology,
      request: opts.request ?? "Fix parser off-by-one bug",
      integrityMode,
      verification,
      requireHandoffs,
      victoryAudit,
      ...(opts.victorySkipReason ? { victorySkipReason: opts.victorySkipReason } : {}),
      ...(opts.skipInterview ? { skipInterview: true } : {}),
      requirements: opts.requirements ?? [{ id: "R1", text: "Fix parser off-by-one bug" }],
      tasks: [{ id: taskId, ...(opts.maxRounds ? { maxRounds: opts.maxRounds } : {}) }],
    },
    { sessionID: "ses_sentinel" },
  )
  assert(!String(planRes.content).startsWith("refused:"), `plan failed unexpectedly: ${planRes.content}`)

  const next1 = await tools.teamwork_next.execute({ sessionId }, { sessionID: "ses_sentinel" })
  const fence1 = next1.readyForWorker?.[0]?.fence
  await tools.teamwork_task_update.execute(
    { sessionId, taskId, status: "worker_active", ...(fence1 !== undefined ? { fence: fence1 } : {}) },
    { sessionID: "ses_sentinel" },
  )
  if (requireHandoffs === "required") {
    const wh = await tools.teamwork_handoff.execute(makeHandoffInput(sessionId, taskId, "Implemented."), {
      sessionID: "ses_worker",
    })
    assert(!String(wh.content).startsWith("refused:"), `worker handoff failed: ${wh.content}`)
  }
  await tools.teamwork_task_update.execute({ sessionId, taskId, status: "worker_done" }, { sessionID: "ses_sentinel" })
  await tools.teamwork_task_update.execute({ sessionId, taskId, status: "verifier_active" }, { sessionID: "ses_sentinel" })
  const rep = await tools.teamwork_report.execute(makePassReportInput(sessionId, taskId), { sessionID: "ses_verifier" })
  assert(!String(rep.content).startsWith("refused:"), `report failed: ${rep.content}`)
  if (requireHandoffs === "required") {
    const vh = await tools.teamwork_handoff.execute(makeHandoffInput(sessionId, taskId, "Verified PASS."), {
      sessionID: "ses_verifier",
    })
    assert(!String(vh.content).startsWith("refused:"), `verifier handoff failed: ${vh.content}`)
  }
  const passUp = await tools.teamwork_task_update.execute(
    { sessionId, taskId, status: "verified_pass", verification: { status: "PASS" } },
    { sessionID: "ses_sentinel" },
  )
  assert.equal(passUp.status, "verified_pass", `verified_pass failed: ${passUp.content}`)

  if (verification === "strict") {
    const ch = await tools.teamwork_wave_record.execute(
      {
        sessionId,
        taskId,
        kind: "challenge",
        verdict: "PASS",
        notes: "No flaws found",
        evidence: "verify/report-t1.json",
        cites: [`verify/report-${taskId}.json`],
      },
      { sessionID: "ses_falsifier" },
    )
    assert(!String(ch.content).startsWith("refused:"), `challenge wave failed: ${ch.content}`)
    const au = await tools.teamwork_wave_record.execute(
      {
        sessionId,
        taskId,
        kind: "audit",
        verdict: "CLEAN",
        notes: "No security issues",
        evidence: "verify/report-t1.json",
        cites: [`verify/report-${taskId}.json`],
      },
      { sessionID: "ses_auditor" },
    )
    assert(!String(au.content).startsWith("refused:"), `audit wave failed: ${au.content}`)
    if (requireHandoffs === "required") {
      await tools.teamwork_handoff.execute(makeHandoffInput(sessionId, taskId, "Challenge PASS."), {
        sessionID: "ses_falsifier",
      })
      await tools.teamwork_handoff.execute(makeHandoffInput(sessionId, taskId, "Audit CLEAN."), {
        sessionID: "ses_auditor",
      })
    }
  }

  const sec = await tools.teamwork_security_audit.execute(
    { sessionId, status: "PASS", findings: [], summary: "Clean." },
    { sessionID: "ses_auditor" },
  )
  assert.equal(sec.status, "PASS", `security audit failed: ${sec.content}`)

  if (victoryAudit === "required") {
    const vic = await tools.teamwork_victory_audit.execute(
      {
        sessionId,
        verdict: "VICTORY CONFIRMED",
        requirements: [{ id: "R1", met: true, evidence: "Tests passed." }],
        summary: makeThreePhaseVictorySummary("VICTORY CONFIRMED"),
      },
      { sessionID: "ses_victory" },
    )
    assert(!String(vic.content).startsWith("refused:"), `victory audit failed: ${vic.content}`)
    if (requireHandoffs === "required") {
      const vh = await tools.teamwork_handoff.execute(makeHandoffInput(sessionId, undefined, "VICTORY CONFIRMED."), {
        sessionID: "ses_victory",
      })
      assert(!String(vh.content).startsWith("refused:"), `victory handoff failed: ${vh.content}`)
    }
  }
  if (requireHandoffs === "required") {
    const sh = await tools.teamwork_handoff.execute(makeHandoffInput(sessionId, undefined, "Run complete."), {
      sessionID: "ses_sentinel",
    })
    assert(!String(sh.content).startsWith("refused:"), `sentinel handoff failed: ${sh.content}`)
  }
}

// Case registry
const CASES = []
function addCase(def) {
  CASES.push(def)
}

// =============================================================================
// TIER 1: FEATURE COVERAGE (65 cases: 5 per feature M1.1..M1.4 + A1..A9)
// =============================================================================

// --- M1.1 dbPathFor(env) (lib/security.mjs) ---
addCase({
  id: "M1.1-T1-01",
  milestone: "M1",
  feature: "M1.1",
  tier: "T1",
  title: "collectSecurityReport uses OPENCODE_DB absolute path and detects 0644",
  fn: () =>
    withSandbox("m1-1-t1-01", (dir) => {
      const dbPath = join(dir, "custom-opencode.db")
      writeFileSync(dbPath, "sqlite-stub")
      chmodSync(dbPath, 0o644)
      const report = collectSecurityReport(securityBaseOpts(dir, { env: { OPENCODE_DB: dbPath, OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }))
      const dbCheck = report.checks.find((c) => c.name === "db_mode")
      assert.ok(dbCheck, "db_mode check must exist")
      assert.equal(dbCheck.status, "fail", `expected db_mode fail on 0644 OPENCODE_DB, got ${dbCheck.status}: ${dbCheck.message}`)
      assert.ok(dbCheck.message.includes(dbPath), `db_mode message must reference OPENCODE_DB ${dbPath}, got: ${dbCheck.message}`)
    }),
})

addCase({
  id: "M1.1-T1-02",
  milestone: "M1",
  feature: "M1.1",
  tier: "T1",
  title: "collectSecurityReport resolves relative OPENCODE_DB against XDG_DATA_HOME/opencode",
  fn: () =>
    withSandbox("m1-1-t1-02", (dir) => {
      const xdgData = join(dir, "xdg-data")
      const relTarget = join(xdgData, "opencode", "rel-test.db")
      mkdirSync(dirname(relTarget), { recursive: true })
      writeFileSync(relTarget, "sqlite-stub")
      chmodSync(relTarget, 0o644)
      const report = collectSecurityReport(
        securityBaseOpts(dir, {
          env: { XDG_DATA_HOME: xdgData, OPENCODE_DB: "rel-test.db", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" },
        }),
      )
      const dbCheck = report.checks.find((c) => c.name === "db_mode")
      assert.equal(dbCheck.status, "fail", `relative OPENCODE_DB 0644 should fail: ${dbCheck.message}`)
      assert.ok(dbCheck.message.includes("rel-test.db"), `must inspect resolved relative DB: ${dbCheck.message}`)
    }),
})

addCase({
  id: "M1.1-T1-03",
  milestone: "M1",
  feature: "M1.1",
  tier: "T1",
  title: "collectSecurityReport resolves opencode-<channel>.db when OPENCODE_CHANNEL=nightly",
  fn: () =>
    withSandbox("m1-1-t1-03", (dir) => {
      const xdgData = join(dir, "xdg-data")
      const channelDb = join(xdgData, "opencode", "opencode-nightly.db")
      mkdirSync(dirname(channelDb), { recursive: true })
      writeFileSync(channelDb, "sqlite-stub")
      chmodSync(channelDb, 0o644)
      const report = collectSecurityReport(
        securityBaseOpts(dir, {
          env: { XDG_DATA_HOME: xdgData, OPENCODE_CHANNEL: "nightly", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" },
        }),
      )
      const dbCheck = report.checks.find((c) => c.name === "db_mode")
      assert.equal(dbCheck.status, "fail", `opencode-nightly.db 0644 must fail: ${dbCheck.message}`)
      assert.ok(dbCheck.message.includes("opencode-nightly.db"), `must resolve opencode-nightly.db, got: ${dbCheck.message}`)
    }),
})

addCase({
  id: "M1.1-T1-04",
  milestone: "M1",
  feature: "M1.1",
  tier: "T1",
  title: "collectSecurityReport resolves opencode.db when OPENCODE_CHANNEL is unset or stable",
  fn: () =>
    withSandbox("m1-1-t1-04", (dir) => {
      const xdgData = join(dir, "xdg-data")
      const stdDb = join(xdgData, "opencode", "opencode.db")
      mkdirSync(dirname(stdDb), { recursive: true })
      writeFileSync(stdDb, "sqlite-stub")
      chmodSync(stdDb, 0o600)
      const reportUnset = collectSecurityReport(
        securityBaseOpts(dir, { env: { XDG_DATA_HOME: xdgData, OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }),
      )
      const dbCheckUnset = reportUnset.checks.find((c) => c.name === "db_mode")
      assert.equal(dbCheckUnset.status, "pass")
      assert.ok(dbCheckUnset.message.includes(stdDb), dbCheckUnset.message)

      const reportStable = collectSecurityReport(
        securityBaseOpts(dir, {
          env: { XDG_DATA_HOME: xdgData, OPENCODE_CHANNEL: "stable", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" },
        }),
      )
      const dbCheckStable = reportStable.checks.find((c) => c.name === "db_mode")
      assert.equal(dbCheckStable.status, "pass")
      assert.ok(dbCheckStable.message.includes(stdDb), dbCheckStable.message)
    }),
})

addCase({
  id: "M1.1-T1-05",
  milestone: "M1",
  feature: "M1.1",
  tier: "T1",
  title: "CLI doctor --security --json inspects OPENCODE_DB mode (0600 pass vs 0644 fail)",
  fn: () =>
    withSandbox("m1-1-t1-05", (dir) => {
      const cfg = join(dir, "cfg")
      mkdirSync(cfg, { recursive: true })
      const dbFile = join(dir, "cli-test.db")
      writeFileSync(dbFile, "sqlite-stub")
      chmodSync(dbFile, 0o600)
      const resPass = spawnSync(process.execPath, [CLI_PATH, "doctor", "--security", "--json", "--config-dir", cfg], {
        encoding: "utf8",
        env: { ...process.env, OPENCODE_DB: dbFile },
      })
      const parsedPass = JSON.parse(resPass.stdout)
      const cPass = parsedPass.security.checks.find((c) => c.name === "db_mode")
      assert.equal(cPass.status, "pass", cPass.message)
      assert.ok(cPass.message.includes(dbFile), `CLI must report ${dbFile}, got: ${cPass.message}`)

      chmodSync(dbFile, 0o644)
      const resFail = spawnSync(process.execPath, [CLI_PATH, "doctor", "--security", "--json", "--config-dir", cfg], {
        encoding: "utf8",
        env: { ...process.env, OPENCODE_DB: dbFile },
      })
      const parsedFail = JSON.parse(resFail.stdout)
      const cFail = parsedFail.security.checks.find((c) => c.name === "db_mode")
      assert.equal(cFail.status, "fail", cFail.message)
      assert.ok(cFail.message.includes(dbFile), `CLI must fail on ${dbFile}, got: ${cFail.message}`)
    }),
})

// --- M1.2 S3923 ternary fixes (lib/security.mjs, lib/verify.mjs) ---
addCase({
  id: "M1.2-T1-01",
  milestone: "M1",
  feature: "M1.2",
  tier: "T1",
  title: "collectSecurityReport resolves numeric GID 998 to docker group failure",
  fn: () =>
    withSandbox("m1-2-t1-01", (dir) => {
      const groupFile = join(dir, "group")
      writeFileSync(groupFile, "users:x:1000:\ndocker:x:998:\n")
      const report = collectSecurityReport(securityBaseOpts(dir, { groupFile, groups: [998], dbPath: join(dir, "a.db") }))
      const g = report.checks.find((c) => c.name === "privileged_groups")
      assert.equal(g.status, "fail")
      assert.match(g.message, /docker/)
    }),
})

addCase({
  id: "M1.2-T1-02",
  milestone: "M1",
  feature: "M1.2",
  tier: "T1",
  title: "collectSecurityReport resolves string group name 'docker' to failure",
  fn: () =>
    withSandbox("m1-2-t1-02", (dir) => {
      const groupFile = join(dir, "group")
      writeFileSync(groupFile, "users:x:1000:\ndocker:x:998:\n")
      const report = collectSecurityReport(securityBaseOpts(dir, { groupFile, groups: ["docker"], dbPath: join(dir, "a.db") }))
      const g = report.checks.find((c) => c.name === "privileged_groups")
      assert.equal(g.status, "fail")
      assert.match(g.message, /docker/)
    }),
})

addCase({
  id: "M1.2-T1-03",
  milestone: "M1",
  feature: "M1.2",
  tier: "T1",
  title: "lib/security.mjs removes S3923 identical-branch ternary and passes non-root GID",
  fn: () =>
    withSandbox("m1-2-t1-03", (dir) => {
      const secSrc = readFileSync(join(REPO_ROOT, "lib", "security.mjs"), "utf8")
      assert.equal(
        /typeof\s+g\s*===\s*"number"\s*\?\s*String\(g\)\s*:\s*String\(g\)/.test(secSrc),
        false,
        "lib/security.mjs still contains S3923 identical-branch ternary",
      )
      const report = collectSecurityReport(securityBaseOpts(dir, { groups: [1000], dbPath: join(dir, "a.db") }))
      assert.equal(report.checks.find((c) => c.name === "privileged_groups").status, "pass")
    }),
})

addCase({
  id: "M1.2-T1-04",
  milestone: "M1",
  feature: "M1.2",
  tier: "T1",
  title: "verifyRun enforces requireHandoffs: 'required' when handoffs are missing",
  fn: () =>
    withSandbox("m1-2-t1-04", async (dir) => {
      const runId = "20261125-120000-m12a"
      const h = await makeHarness(dir)
      await setupCodingRunToPass(h.tools, dir, runId, { requireHandoffs: "required", victoryAudit: "skip", victorySkipReason: "fixture" })
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
      // Remove handoffs index to verify requireHandoffs: "required" catches it in verifyRun
      rmSync(join(runDir, "handoffs"), { recursive: true, force: true })
      const vr = await verifyRun({ runDir, allowUnsigned: true })
      const hc = vr.checks.find((c) => c.id.startsWith("handoff"))
      assert.ok(hc && hc.status === "fail", `expected handoff failure, got: ${JSON.stringify(vr.checks)}`)
    }),
})

addCase({
  id: "M1.2-T1-05",
  milestone: "M1",
  feature: "M1.2",
  tier: "T1",
  title: "lib/verify.mjs removes S3923 identical-branch ternary and handles requireHandoffs: 'skip'",
  fn: () =>
    withSandbox("m1-2-t1-05", async (dir) => {
      const verSrc = readFileSync(join(REPO_ROOT, "lib", "verify.mjs"), "utf8")
      assert.equal(
        /raw\s*===\s*"skip"\s*\?\s*"skip"\s*:\s*"skip"/.test(verSrc),
        false,
        "lib/verify.mjs still contains S3923 identical-branch ternary",
      )
      const runId = "20261125-120000-m12b"
      const h = await makeHarness(dir)
      await setupCodingRunToPass(h.tools, dir, runId, { requireHandoffs: "skip", victoryAudit: "skip", victorySkipReason: "fixture" })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
      const vr = await verifyRun({ runDir: join(dir, ".opencode", "teamwork", runId), allowUnsigned: true })
      assert.ok(!vr.reasons.some((r) => /HANDOFF_MISSING/.test(r)), `unexpected handoff failure: ${vr.reasons}`)
    }),
})

// --- M1.3 approval-driver.mjs runId allowlist (S8707) ---
addCase({
  id: "M1.3-T1-01",
  milestone: "M1",
  feature: "M1.3",
  tier: "T1",
  title: "approval-driver.mjs write-draft succeeds with standard SESSION_ID",
  fn: () =>
    withSandbox("m1-3-t1-01", (dir) => {
      const storage = join(dir, "storage.json")
      const runId = "20261125-120000-abcd"
      const res = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId, draft: "# Draft\n" })],
        { encoding: "utf8" },
      )
      assert.equal(res.status, 0, res.stderr || res.stdout)
      const parsed = JSON.parse(res.stdout)
      assert.equal(parsed.ok, true)
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId, "prompt_draft.md")), true)
    }),
})

addCase({
  id: "M1.3-T1-02",
  milestone: "M1",
  feature: "M1.3",
  tier: "T1",
  title: "approval-driver.mjs accepts dotted and underscored valid runId",
  fn: () =>
    withSandbox("m1-3-t1-02", (dir) => {
      const storage = join(dir, "storage.json")
      const runId = "run_01.test"
      const res = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId, draft: "# Spec\n" })],
        { encoding: "utf8" },
      )
      assert.equal(res.status, 0, res.stderr || res.stdout)
      assert.equal(JSON.parse(res.stdout).ok, true)
    }),
})

addCase({
  id: "M1.3-T1-03",
  milestone: "M1",
  feature: "M1.3",
  tier: "T1",
  title: "approval-driver.mjs plan succeeds with signed external approval",
  fn: () =>
    withSandbox("m1-3-t1-03", (dir) => {
      const repoDir = join(dir, "repo")
      mkdirSync(repoDir, { recursive: true })
      const storage = join(dir, "storage.json")
      const approvalDir = join(dir, "approvals")
      mkdirSync(approvalDir, { recursive: true })
      const runId = "20261125-120000-app3"
      const draftText = "# Spec\n\nApproved draft.\n"
      const w = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: repoDir, storage, action: "write-draft", runId, draft: draftText })],
        { encoding: "utf8" },
      )
      assert.equal(w.status, 0, w.stderr)
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64url")
      const privPem = privateKey.export({ format: "pem", type: "pkcs8" })
      const keyFile = join(dir, "approver.pem")
      writeFileSync(keyFile, privPem, { mode: 0o600 })
      const reqRes = spawnSync(
        process.execPath,
        [CLI_PATH, "approve", "request", "--session", runId, "--json"],
        { cwd: repoDir, encoding: "utf8" },
      )
      assert.equal(reqRes.status, 0, reqRes.stderr || reqRes.stdout)
      const reqFile = join(dir, "req.json")
      writeFileSync(reqFile, reqRes.stdout)
      const draftSha8 = createHash("sha256").update(draftText, "utf8").digest("hex").slice(0, 8)
      const signRes = spawnSync(
        process.execPath,
        [
          CLI_PATH,
          "approve",
          "sign",
          "--request",
          reqFile,
          "--draft",
          join(repoDir, ".opencode", "teamwork", runId, "prompt_draft.md"),
          "--key",
          keyFile,
          "--approver",
          "uid:tester",
        ],
        {
          cwd: repoDir,
          input: `${draftSha8}\napprove\n`,
          encoding: "utf8",
          env: { ...process.env, OPENCODE_TEAMWORK_APPROVAL_DIR: approvalDir },
        },
      )
      assert.equal(signRes.status, 0, signRes.stderr || signRes.stdout)
      assert.equal(existsSync(join(approvalDir, `${runId}.json`)), true, `approval file missing: ${signRes.stdout}\n${signRes.stderr}`)

      const planRes = spawnSync(
        process.execPath,
        [
          APPROVAL_DRIVER_PATH,
          JSON.stringify({ root: repoDir, storage, action: "plan", runId, trustLevel: "human-approved", ownerUid: 999999 }),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCODE_TEAMWORK_APPROVAL_DIR: approvalDir,
            OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY: pubB64,
          },
        },
      )
      assert.equal(planRes.status, 0, planRes.stderr || planRes.stdout)
      const parsed = JSON.parse(planRes.stdout)
      assert.equal(parsed.ok, true, parsed.content)
      assert.equal(parsed.planExists, true)
    }),
})

addCase({
  id: "M1.3-T1-04",
  milestone: "M1",
  feature: "M1.3",
  tier: "T1",
  title: "approval-driver.mjs seed writes verifier report and security audit",
  fn: () =>
    withSandbox("m1-3-t1-04", (dir) => {
      const storage = join(dir, "storage.json")
      const runId = "20261125-120000-seed"
      spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId, draft: "# Spec\n" })],
        { encoding: "utf8" },
      )
      const p = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "plan", runId, trustLevel: "local-hmac" })],
        { encoding: "utf8" },
      )
      assert.equal(JSON.parse(p.stdout).ok, true, p.stdout)
      const s = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "seed", runId })],
        { encoding: "utf8" },
      )
      assert.equal(s.status, 0, s.stderr || s.stdout)
      assert.equal(JSON.parse(s.stdout).audit, "PASS")
    }),
})

addCase({
  id: "M1.3-T1-05",
  milestone: "M1",
  feature: "M1.3",
  tier: "T1",
  title: "approval-driver.mjs final completes final_verify PASS across separate process",
  fn: () =>
    withSandbox("m1-3-t1-05", (dir) => {
      const storage = join(dir, "storage.json")
      const runId = "20261125-120000-fin"
      spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId, draft: "# Spec\n" })],
        { encoding: "utf8" },
      )
      spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "plan", runId, trustLevel: "local-hmac" })],
        { encoding: "utf8" },
      )
      spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "seed", runId })],
        { encoding: "utf8" },
      )
      const f = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "final", runId })],
        { encoding: "utf8" },
      )
      assert.equal(f.status, 0, f.stderr || f.stdout)
      const parsed = JSON.parse(f.stdout)
      assert.equal(parsed.status, "PASS", parsed.content)
    }),
})

// --- M1.4 service*.json URL validation (tools.ts) ---
addCase({
  id: "M1.4-T1-01",
  milestone: "M1",
  feature: "M1.4",
  tier: "T1",
  title: "teamwork_cost reads service.json loopback URL and sums session tree",
  fn: () =>
    withSandbox("m1-4-t1-01", async (dir) => {
      await withLoopbackServer((req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/api/session/ses_sentinel") {
          res.end(JSON.stringify({ data: { id: "ses_sentinel", agent: "team/sentinel", cost: 0.25, tokens: { input: 10, output: 5 } } }))
          return
        }
        if (req.url?.startsWith("/api/session?")) {
          const u = new URL(req.url, "http://127.0.0.1")
          if (u.searchParams.get("parentID") === "ses_sentinel") {
            res.end(JSON.stringify({ data: [{ id: "ses_worker", parentID: "ses_sentinel", agent: "team/worker", cost: 0.5, tokens: { input: 20, output: 10 } }] }))
            return
          }
          res.end(JSON.stringify({ data: [] }))
          return
        }
        res.statusCode = 404
        res.end("{}")
      }, async ({ baseUrl }) => {
        const xdgState = join(dir, "xdg-state")
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: baseUrl, password: "p" }))
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir)
          const runId = "20261125-120000-svc1"
          await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          const cost = await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
          assert.ok(cost.content.includes("opencode session tree"), cost.content)
          const costsJson = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "costs.json"), "utf8"))
          assert.ok(Math.abs(costsJson.spentUsd - 0.75) < 1e-6, `expected 0.75, got ${costsJson.spentUsd}`)
        })
      })
    }),
})

addCase({
  id: "M1.4-T1-02",
  milestone: "M1",
  feature: "M1.4",
  tier: "T1",
  title: "teamwork_cost selects service-nightly.json when app.channel='nightly'",
  fn: () =>
    withSandbox("m1-4-t1-02", async (dir) => {
      await withLoopbackServer((req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/api/session/ses_sentinel") {
          res.end(JSON.stringify({ data: { id: "ses_sentinel", agent: "team/sentinel", cost: 1.2, tokens: {} } }))
          return
        }
        res.end(JSON.stringify({ data: [] }))
      }, async ({ baseUrl }) => {
        const xdgState = join(dir, "xdg-state")
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service-nightly.json"), JSON.stringify({ url: baseUrl, password: "p" }))
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir, { channel: "nightly" })
          const runId = "20261125-120000-svc2"
          await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          const cost = await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
          assert.ok(cost.content.includes("opencode session tree"), cost.content)
          const costsJson = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "costs.json"), "utf8"))
          assert.ok(Math.abs(costsJson.spentUsd - 1.2) < 1e-6)
        })
      })
    }),
})

addCase({
  id: "M1.4-T1-03",
  milestone: "M1",
  feature: "M1.4",
  tier: "T1",
  title: "teamwork_cost falls back to legacy service-<hash>.json registration",
  fn: () =>
    withSandbox("m1-4-t1-03", async (dir) => {
      await withLoopbackServer((req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/api/session/ses_sentinel") {
          res.end(JSON.stringify({ data: { id: "ses_sentinel", agent: "team/sentinel", cost: 0.4, tokens: {} } }))
          return
        }
        res.end(JSON.stringify({ data: [] }))
      }, async ({ baseUrl }) => {
        const xdgState = join(dir, "xdg-state")
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service-deadbeef.json"), JSON.stringify({ url: baseUrl }))
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir)
          const runId = "20261125-120000-svc3"
          await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          const cost = await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
          assert.ok(cost.content.includes("opencode session tree"), cost.content)
        })
      })
    }),
})

addCase({
  id: "M1.4-T1-04",
  milestone: "M1",
  feature: "M1.4",
  tier: "T1",
  title: "teamwork_cost follows cursor pagination across child pages",
  fn: () =>
    withSandbox("m1-4-t1-04", async (dir) => {
      await withLoopbackServer((req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/api/session/ses_sentinel") {
          res.end(JSON.stringify({ data: { id: "ses_sentinel", agent: "team/sentinel", cost: 0.1, tokens: {} } }))
          return
        }
        const u = new URL(req.url, "http://127.0.0.1")
        if (u.searchParams.get("parentID") === "ses_sentinel") {
          const cur = u.searchParams.get("cursor")
          if (!cur) {
            res.end(JSON.stringify({ data: [{ id: "ses_c1", parentID: "ses_sentinel", agent: "team/worker", cost: 0.2, tokens: {} }], cursor: { next: "p2" } }))
          } else {
            res.end(JSON.stringify({ data: [{ id: "ses_c2", parentID: "ses_sentinel", agent: "team/verifier", cost: 0.3, tokens: {} }] }))
          }
          return
        }
        res.end(JSON.stringify({ data: [] }))
      }, async ({ baseUrl }) => {
        const xdgState = join(dir, "xdg-state")
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: baseUrl }))
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir)
          const runId = "20261125-120000-svc4"
          await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
          const costsJson = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "costs.json"), "utf8"))
          assert.ok(Math.abs(costsJson.spentUsd - 0.6) < 1e-6, `expected 0.6 across paginated children, got ${costsJson.spentUsd}`)
        })
      })
    }),
})

addCase({
  id: "M1.4-T1-05",
  milestone: "M1",
  feature: "M1.4",
  tier: "T1",
  title: "teamwork_cost falls back cleanly to SQLite DB when loopback service is closed",
  fn: () =>
    withSandbox("m1-4-t1-05", async (dir) => {
      const xdgState = join(dir, "xdg-state")
      mkdirSync(join(xdgState, "opencode"), { recursive: true })
      writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: "http://127.0.0.1:1" }))
      const dbPath = join(dir, "fallback.db")
      await createSessionDb(dbPath, [["ses_sentinel", null, "team/sentinel", 0.9, 10, 5, 0, 0, 0]])
      await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: dbPath }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-svc5"
        await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
        const cost = await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
        assert.ok(cost.content.includes("opencode session tree"), cost.content)
        const costsJson = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "costs.json"), "utf8"))
        assert.ok(Math.abs(costsJson.spentUsd - 0.9) < 1e-6)
      })
    }),
})

// --- A1: [skip-interview] bracket parsing, empty-arg prompt, ## Parameters ---
addCase({
  id: "A1-T1-01",
  milestone: "M3",
  feature: "A1",
  tier: "T1",
  title: "/teamwork command parses leading [skip-interview] and strips it from routed task text",
  fn: () =>
    withSandbox("a1-t1-01", async (dir) => {
      const h = await makeHarness(dir, { viaSetup: true })
      const cmd = h.commands.teamwork
      assert.ok(cmd, "/teamwork command must be registered")
      await cmd.execute({ sessionID: "ses_sentinel", prompt: { text: "[skip-interview] build parser" } })
      assert.equal(h.prompted.length, 1, "must forward prompt")
      const forwarded = h.prompted[0].text
      assert.ok(forwarded.includes("build parser"), "forwarded text must preserve task body")
      const firstLine = forwarded.split("\n")[0]
      assert.equal(
        firstLine.includes("[skip-interview]"),
        false,
        `leading [skip-interview] must be parsed and stripped from task text line, got: ${firstLine}`,
      )
      assert.match(forwarded, /skipInterview|skip-interview/i, "must signal skipInterview parameter explicitly")
    }),
})

addCase({
  id: "A1-T1-02",
  milestone: "M3",
  feature: "A1",
  tier: "T1",
  title: "teamwork_plan strips leading [skip-interview] from request and bypasses prompt_draft.md",
  fn: () =>
    withSandbox("a1-t1-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1t2"
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview] build parser", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(res.content).startsWith("refused:"), `leading [skip-interview] should bypass spec gate: ${res.content}`)
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      const reqPart = orig.split("## Request\n")[1] ?? ""
      assert.equal(reqPart.trim(), "build parser", `expected stripped request body, got: ${reqPart}`)
    }),
})

addCase({
  id: "A1-T1-03",
  milestone: "M3",
  feature: "A1",
  tier: "T1",
  title: "ORIGINAL_REQUEST.md records ## Parameters section for [skip-interview]",
  fn: () =>
    withSandbox("a1-t1-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1t3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview] build parser", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(orig, /^## Parameters$/m, `ORIGINAL_REQUEST.md must contain ## Parameters:\n${orig}`)
      assert.match(orig, /\[skip-interview\]/, "ORIGINAL_REQUEST.md ## Parameters must record [skip-interview]")
    }),
})

addCase({
  id: "A1-T1-04",
  milestone: "M3",
  feature: "A1",
  tier: "T1",
  title: "teamwork_plan with skipInterview: true writes ## Parameters while keeping ## Request verbatim",
  fn: () =>
    withSandbox("a1-t1-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1t4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Implement  exact  spacing", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(orig, /^## Parameters$/m)
      assert.ok(orig.includes("Implement  exact  spacing"), "verbatim request spacing preserved")

      // A1 residual: leading whitespace is only consumed when it introduces a
      // bracketed token. No leading bracket -> byte-identical request text.
      const spacedRun = "20261125-120000-a1t4s"
      await h.tools.teamwork_plan.execute(
        { sessionId: spacedRun, topology: "small-focused", request: "  Implement  exact  spacing", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const spaced = readFileSync(join(dir, ".opencode", "teamwork", spacedRun, "ORIGINAL_REQUEST.md"), "utf8")
      assert.equal(spaced.split("## Request\n\n")[1], "  Implement  exact  spacing\n", "a request without a leading bracket keeps meaningful leading whitespace")

      // With a leading bracket, the indentation is launch formatting and the
      // [skip-interview] marker is recorded in ## Parameters, not ## Request.
      const bracketedRun = "20261125-120000-a1t4b"
      const bracketed = await h.tools.teamwork_plan.execute(
        { sessionId: bracketedRun, topology: "small-focused", request: "  [skip-interview] build parser", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(bracketed.content).startsWith("refused:"), bracketed.content)
      const bracketedOrig = readFileSync(join(dir, ".opencode", "teamwork", bracketedRun, "ORIGINAL_REQUEST.md"), "utf8")
      assert.equal(bracketedOrig.split("## Request\n\n")[1], "build parser\n", "indented [skip-interview] is parsed and stripped")
      assert.match(bracketedOrig, /- skipInterview: true/)
    }),
})

addCase({
  id: "A1-T1-05",
  milestone: "M3",
  feature: "A1",
  tier: "T1",
  title: "refreshRunBriefing and teamwork_status extract clean mission text with ## Parameters present",
  fn: () =>
    withSandbox("a1-t1-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1t5"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview] Implement parser", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const orig = readFileSync(join(runDir, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(orig, /^## Parameters$/m)
      refreshRunBriefing(runDir)
      const briefing = readFileSync(join(runDir, "BRIEFING.md"), "utf8")
      assert.ok(briefing.includes("Implement parser"), briefing)
      const status = await h.tools.teamwork_status.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.ok(status.content.includes(runId), status.content)
    }),
})

// --- A2: Pre-routing interview gate & behavioral Step 3 Integrity Mode ---
addCase({
  id: "A2-T1-01",
  milestone: "M3",
  feature: "A2",
  tier: "T1",
  title: "/teamwork template and sentinel.md block routing until prompt_draft.md exists unless [skip-interview]",
  fn: () => {
    const teamworkCmd = COMMANDS.find((c) => c.name === "teamwork")
    assert.ok(teamworkCmd)
    assert.equal(
      /If not,\s*run\s*`?teamwork_route`?\s*first/i.test(teamworkCmd.template),
      false,
      "/teamwork must NOT tell Sentinel to run teamwork_route before interview/prompt_draft.md",
    )
    const sentinel = readAgentPrompt("sentinel.md")
    assert.match(sentinel, /crafter|interview/i)
    assert.equal(/inline the answers if the user wants speed/i.test(sentinel), false, "sentinel must gate on crafter unless [skip-interview]")
  },
})

addCase({
  id: "A2-T1-02",
  milestone: "M3",
  feature: "A2",
  tier: "T1",
  title: "crafter.md Step 2 includes exact small-focused and massive-proof opt-in phrases",
  fn: () => {
    const crafter = readAgentPrompt("crafter.md")
    assert.ok(
      crafter.includes("This is a single self-contained fix; keep it small and focused."),
      "crafter.md Step 2 missing exact small-focused opt-in phrase",
    )
    assert.ok(
      crafter.includes("Use a very large team of agents."),
      "crafter.md Step 2 missing exact massive-proof opt-in phrase",
    )
  },
})

addCase({
  id: "A2-T1-03",
  milestone: "M3",
  feature: "A2",
  tier: "T1",
  title: "crafter.md Step 3 uses behavioral multi-select (a)-(e) options",
  fn: () => {
    const crafter = readAgentPrompt("crafter.md")
    const step3 = crafter.slice(crafter.indexOf("3."), crafter.indexOf("4."))
    for (const marker of ["(a)", "(b)", "(c)", "(d)", "(e)"]) {
      assert.ok(step3.includes(marker), `crafter.md Step 3 missing behavioral option ${marker}`)
    }
  },
})

addCase({
  id: "A2-T1-04",
  milestone: "M3",
  feature: "A2",
  tier: "T1",
  title: "crafter.md Step 3 documents 'from scratch' floor and 'The team must NOT:' lines",
  fn: () => {
    const crafter = readAgentPrompt("crafter.md")
    assert.match(crafter, /from scratch/i, "crafter.md Step 3 must document 'from scratch' integrity floor")
    assert.ok(crafter.includes("The team must NOT:"), "crafter.md must document 'The team must NOT:' output lines")
  },
})

addCase({
  id: "A2-T1-05",
  milestone: "M3",
  feature: "A2",
  tier: "T1",
  title: "teamwork_plan blocks when prompt_draft.md absent and succeeds once prompt_draft.md exists",
  fn: () =>
    withSandbox("a2-t1-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a2t5"
      const refused = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix bug", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(refused.content).startsWith("refused:"), `expected refusal without prompt_draft.md, got: ${refused.content}`)
      const runDir = join(dir, ".opencode", "teamwork", runId)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "prompt_draft.md"), "# Spec\n\nApproved.\n")
      const ok = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix bug", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(ok.content).startsWith("refused:"), ok.content)
    }),
})

// --- A3: Follow-up message append to ORIGINAL_REQUEST.md ---
addCase({
  id: "A3-T1-01",
  milestone: "M3",
  feature: "A3",
  tier: "T1",
  title: "Follow-up message append adds UTC timestamp header and message body to ORIGINAL_REQUEST.md",
  fn: () =>
    withSandbox("a3-t1-01", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3t1"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Initial request.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      // B1: the documented minimal payload validates and does not require the
      // normal-plan fields; a bare normal plan still fails validation.
      const planSchema = h.tools.teamwork_plan.input?.["~standard"]
      const minimal = planSchema.validate({ sessionId: runId, followUp: "Also support JSON output." })
      assert.equal(minimal.issues, undefined, `minimal followUp payload must validate: ${JSON.stringify(minimal.issues)}`)
      const missingBoth = planSchema.validate({ sessionId: runId })
      assert.ok(Array.isArray(missingBoth.issues) && missingBoth.issues.length > 0, "a plan without topology/tasks/followUp must fail schema validation")
      const appended = await invokeFollowUpAppend(h.tools, runId, "Also support JSON output.", { sessionID: "ses_sentinel" })
      assert.equal(appended.topology, "small-focused", "follow-up must return the persisted topology")
      assert.equal(appended.tasks.length, 1, "follow-up must return the persisted tasks")
      // A direct execute (schema bypassed) without topology/tasks refuses.
      const normalNoFields = await h.tools.teamwork_plan.execute({ sessionId: runId, skipInterview: true }, { sessionID: "ses_sentinel" })
      assert.ok(String(normalNoFields.content).startsWith("refused:"), `normal plan without topology/tasks must refuse: ${normalNoFields.content}`)
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(orig, /^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m, `expected UTC header in:\n${orig}`)
      assert.ok(orig.includes("Also support JSON output."), orig)
    }),
})

addCase({
  id: "A3-T1-02",
  milestone: "M3",
  feature: "A3",
  tier: "T1",
  title: "Appending a second distinct follow-up preserves chronological order",
  fn: () =>
    withSandbox("a3-t1-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3t2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Initial.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      await invokeFollowUpAppend(h.tools, runId, "First follow-up.", { sessionID: "ses_sentinel" })
      await invokeFollowUpAppend(h.tools, runId, "Second follow-up.", { sessionID: "ses_sentinel" })
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      const i1 = orig.indexOf("First follow-up.")
      const i2 = orig.indexOf("Second follow-up.")
      assert.ok(i1 > 0 && i2 > i1, "both follow-ups must appear in order")
    }),
})

addCase({
  id: "A3-T1-03",
  milestone: "M3",
  feature: "A3",
  tier: "T1",
  title: "Initial - Integrity mode: header and ## Request bytes remain immutable after follow-up append",
  fn: () =>
    withSandbox("a3-t1-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3t3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", integrityMode: "demo", request: "Exact initial bytes.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const before = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      await invokeFollowUpAppend(h.tools, runId, "Follow-up clarification.", { sessionID: "ses_sentinel" })
      const after = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.ok(after.startsWith(before.trimEnd()), "initial ORIGINAL_REQUEST.md prefix must remain byte-identical")
      assert.match(after, /- Integrity mode: demo/)
    }),
})

addCase({
  id: "A3-T1-04",
  milestone: "M3",
  feature: "A3",
  tier: "T1",
  title: "## Parameters preserved intact when follow-up is appended",
  fn: () =>
    withSandbox("a3-t1-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3t4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview] Task body", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      await invokeFollowUpAppend(h.tools, runId, "Extra constraint.", { sessionID: "ses_sentinel" })
      const after = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(after, /^## Parameters$/m)
      assert.ok(after.includes("Extra constraint."))
    }),
})

addCase({
  id: "A3-T1-05",
  milestone: "M3",
  feature: "A3",
  tier: "T1",
  title: "teamwork_status and refreshRunBriefing remain readable after follow-up appends",
  fn: () =>
    withSandbox("a3-t1-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3t5"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Base task.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      await invokeFollowUpAppend(h.tools, runId, "Follow-up task detail.", { sessionID: "ses_sentinel" })
      refreshRunBriefing(join(dir, ".opencode", "teamwork", runId))
      const st = await h.tools.teamwork_status.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.ok(st.content.includes(runId), st.content)
    }),
})

// --- A4: small-focused multi-round loop & open-issues ledger + audit cap ---
addCase({
  id: "A4-T1-01",
  milestone: "M4",
  feature: "A4",
  tier: "T1",
  title: "index.ts and sentinel.md do not cap small-focused at maxRounds: 1",
  fn: () => {
    const teamworkCmd = COMMANDS.find((c) => c.name === "teamwork")
    assert.equal(/1 for small-focused/i.test(teamworkCmd.template), false, "index.ts still caps small-focused at 1 round")
    const sentinel = readAgentPrompt("sentinel.md")
    assert.equal(/1 for small-focused/i.test(sentinel), false, "sentinel.md still caps small-focused at 1 round")
  },
})

addCase({
  id: "A4-T1-02",
  milestone: "M4",
  feature: "A4",
  tier: "T1",
  title: "small-focused run allows round 1 verified_fail -> round 2 worker_active -> verified_pass",
  fn: () =>
    withSandbox("a4-t1-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4t2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Small fix", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const plan = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "plan.dag.json"), "utf8"))
      const taskDef = plan.tasks.find((t) => t.id === "t1")
      assert.ok((taskDef.maxRounds ?? 4) > 1, `small-focused task maxRounds must be > 1, got ${taskDef.maxRounds}`)
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      const fail1 = await h.tools.teamwork_task_update.execute(
        { sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Issue A: edge case" },
        { sessionID: "ses_sentinel" },
      )
      assert.equal(fail1.status, "verified_fail", `round 1 fail should not block small-focused: ${fail1.content}`)
      const w2 = await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      assert.equal(w2.round, 2)
    }),
})

addCase({
  id: "A4-T1-03",
  milestone: "M4",
  feature: "A4",
  tier: "T1",
  title: "feedbackLog preserves open issues across consecutive verified_fail rounds",
  fn: () =>
    withSandbox("a4-t1-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4t3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Small fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const [r, fb] of [
        [1, "Open issue 1"],
        [2, "Open issue 2"],
      ]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: fb }, { sessionID: "ses_sentinel" })
      }
      const state = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "state.json"), "utf8"))
      const log = state.tasks.t1.feedbackLog
      assert.equal(log.length, 2)
      assert.equal(log[0].resolved, false)
      assert.equal(log[1].resolved, false)
    }),
})

addCase({
  id: "A4-T1-04",
  milestone: "M4",
  feature: "A4",
  tier: "T1",
  title: "verified_pass resolves feedbackLog entries only after passing report",
  fn: () =>
    withSandbox("a4-t1-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4t4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Small fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Open issue 1" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "t1", "Fixed"), { sessionID: "ses_worker" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      const rep = await h.tools.teamwork_report.execute(makePassReportInput(runId, "t1"), { sessionID: "ses_verifier" })
      assert.ok(!String(rep.content).startsWith("refused:"), rep.content)
      const pass = await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_pass", verification: { status: "PASS" } }, { sessionID: "ses_sentinel" })
      assert.equal(pass.status, "verified_pass", pass.content)
      const state = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "state.json"), "utf8"))
      assert.equal(state.tasks.t1.feedbackLog.every((e) => e.resolved === true), true)
    }),
})

addCase({
  id: "A4-T1-05",
  milestone: "M4",
  feature: "A4",
  tier: "T1",
  title: "sentinel.md documents small-focused open-issues ledger and max 2 victory audits",
  fn: () => {
    const sentinel = readAgentPrompt("sentinel.md")
    assert.match(sentinel, /open[- ]issues ledger/i, "sentinel.md must document small-focused open-issues ledger")
    assert.match(sentinel, /2\s+(?:victory\s+)?audits|max(?:imum)?\s+2\s+victory/i, "sentinel.md must document max 2 victory audits")
  },
})

// --- A5: General Survey, Feature Inventory, Dual-Track E2E, DEAD_ENDS.md ---
addCase({
  id: "A5-T1-01",
  milestone: "M4",
  feature: "A5",
  tier: "T1",
  title: "sentinel.md and orchestrator.md document Step 0 2-Scout Survey and PROJECT.md/SCOPE.md Feature Inventory",
  fn: () => {
    const sentinel = readAgentPrompt("sentinel.md")
    const orch = readAgentPrompt("orchestrator.md")
    const combined = `${sentinel}\n${orch}`
    assert.match(combined, /2\s+(?:parallel\s+)?(?:scout|explorer)/i, "must document 2 parallel scouts/explorers in Survey")
    assert.ok(combined.includes("PROJECT.md") && combined.includes("SCOPE.md"), "must document PROJECT.md and SCOPE.md")
    assert.match(combined, /Feature Inventory/i, "must document Feature Inventory cross-check")
  },
})

addCase({
  id: "A5-T1-02",
  milestone: "M4",
  feature: "A5",
  tier: "T1",
  title: "sentinel.md and orchestrator.md document Dual-Track E2E (TEST_INFRA.md, TEST_READY.md, 4 tiers)",
  fn: () => {
    const combined = `${readAgentPrompt("sentinel.md")}\n${readAgentPrompt("orchestrator.md")}`
    assert.ok(combined.includes("TEST_INFRA.md") && combined.includes("TEST_READY.md"), "must document TEST_INFRA.md and TEST_READY.md")
    assert.match(combined, /dual[- ]track|4[- ]tier/i, "must document Dual-Track / 4-tier E2E testing")
  },
})

addCase({
  id: "A5-T1-03",
  milestone: "M4",
  feature: "A5",
  tier: "T1",
  title: "prompts and docs/ARTIFACTS.md document DEAD_ENDS.md Oscillation Guard and Regression Guard",
  fn: () => {
    const artifacts = readFileSync(join(REPO_ROOT, "docs", "ARTIFACTS.md"), "utf8")
    const sentinel = readAgentPrompt("sentinel.md")
    const orch = readAgentPrompt("orchestrator.md")
    const all = `${artifacts}\n${sentinel}\n${orch}`
    assert.ok(all.includes("DEAD_ENDS.md"), "must document DEAD_ENDS.md")
    assert.match(all, /Oscillation Guard/i, "must document Oscillation Guard")
    assert.match(all, /Regression Guard/i, "must document Regression Guard")
  },
})

addCase({
  id: "A5-T1-04",
  milestone: "M4",
  feature: "A5",
  tier: "T1",
  title: "sentinel.md and worker.md include verbatim MANDATORY INTEGRITY WARNING (DO NOT CHEAT)",
  fn: () => {
    const sentinel = readAgentPrompt("sentinel.md")
    const worker = readAgentPrompt("worker.md")
    assert.ok(
      sentinel.includes("MANDATORY INTEGRITY WARNING") || worker.includes("MANDATORY INTEGRITY WARNING"),
      "must embed MANDATORY INTEGRITY WARNING",
    )
    assert.ok(
      sentinel.includes("DO NOT CHEAT") || worker.includes("DO NOT CHEAT"),
      "must include DO NOT CHEAT integrity text",
    )
  },
})

addCase({
  id: "A5-T1-05",
  milestone: "M4",
  feature: "A5",
  tier: "T1",
  title: "Two consecutive identical verified_fail transitions record/surface DEAD_ENDS.md oscillation guard",
  fn: () =>
    withSandbox("a5-t1-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a5t5"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Build feature", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute(
          { sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Same exact failure: TypeError at line 10" },
          { sessionID: "ses_sentinel" },
        )
      }
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const deadEndsExists = existsSync(join(runDir, "DEAD_ENDS.md"))
      assert.ok(deadEndsExists, "2 consecutive identical failures must write DEAD_ENDS.md")
      const deadEnds = readFileSync(join(runDir, "DEAD_ENDS.md"), "utf8")
      assert.match(deadEnds, /oscillation|dead.?end/i)
      const next = await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.match(String(next.content), /Oscillation Guard:.*DEAD_ENDS\.md/i, `teamwork_next must surface the oscillation guard, got:\n${next.content}`)
    }),
})

// --- A6: Verification wave depth, GATE_STATUS.md, empirical challenger ---
addCase({
  id: "A6-T1-01",
  milestone: "M4",
  feature: "A6",
  tier: "T1",
  title: "distributed-coding defaults verification wave to strict (or documents strict wave alignment)",
  fn: () =>
    withSandbox("a6-t1-01", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6t1"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Distributed feature", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const plan = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "plan.dag.json"), "utf8"))
      assert.equal(plan.verification, "strict", `distributed-coding should default to strict verification wave, got: ${plan.verification}`)
    }),
})

addCase({
  id: "A6-T1-02",
  milestone: "M4",
  feature: "A6",
  tier: "T1",
  title: "teamwork_wave_record records falsifier challenge PASS and security-auditor audit CLEAN",
  fn: () =>
    withSandbox("a6-t1-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6t2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", verification: "strict", request: "Task", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "t1", "Done"), { sessionID: "ses_worker" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      const rep = await h.tools.teamwork_report.execute(makePassReportInput(runId, "t1"), { sessionID: "ses_verifier" })
      assert.ok(!String(rep.content).startsWith("refused:"), rep.content)
      const c = await h.tools.teamwork_wave_record.execute(
        { sessionId: runId, taskId: "t1", kind: "challenge", verdict: "PASS", cites: ["verify/report-t1.json"] },
        { sessionID: "ses_falsifier" },
      )
      const a = await h.tools.teamwork_wave_record.execute(
        { sessionId: runId, taskId: "t1", kind: "audit", verdict: "CLEAN", cites: ["verify/report-t1.json"] },
        { sessionID: "ses_auditor" },
      )
      assert.equal(c.verdict.verdict, "PASS")
      assert.equal(a.verdict.verdict, "CLEAN")
    }),
})

addCase({
  id: "A6-T1-03",
  milestone: "M4",
  feature: "A6",
  tier: "T1",
  title: "teamwork_final_verify writes GATE_STATUS.md with 4-role table and ## Continuity",
  fn: () =>
    withSandbox("a6-t1-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6t3"
      await setupCodingRunToPass(h.tools, dir, runId, { verification: "strict" })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
      const gateMd = readFileSync(join(dir, ".opencode", "teamwork", runId, "GATE_STATUS.md"), "utf8")
      assert.match(gateMd, /team\/falsifier/)
      assert.match(gateMd, /team\/security-auditor/)
      assert.match(gateMd, /^## Continuity$/m)
    }),
})

addCase({
  id: "A6-T1-04",
  milestone: "M4",
  feature: "A6",
  tier: "T1",
  title: "team/falsifier supports empirical challenger shell execution while remaining edit-denied",
  fn: () =>
    withSandbox("a6-t1-04", async (dir) => {
      const h = await makeHarness(dir)
      const evalHook = h.permissionHooks.evaluate
      assert.ok(typeof evalHook === "function")
      const evShell = { agent: "team/falsifier", action: "shell", effect: "allow" }
      evalHook(evShell)
      assert.notEqual(evShell.effect, "deny", "team/falsifier must be able to run shell tests as empirical challenger")
      const evEdit = { agent: "team/falsifier", action: "edit", effect: "allow" }
      evalHook(evEdit)
      assert.equal(evEdit.effect, "deny", "team/falsifier must still deny edit")
    }),
})

addCase({
  id: "A6-T1-05",
  milestone: "M4",
  feature: "A6",
  tier: "T1",
  title: "evaluateStrictGate returns PASS when report, challenge, and audit are valid",
  fn: () =>
    withSandbox("a6-t1-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6t5"
      await setupCodingRunToPass(h.tools, dir, runId, { verification: "strict" })
      const gate = evaluateStrictGate(join(dir, ".opencode", "teamwork", runId), [{ id: "t1", status: "verified_pass" }], "strict")
      assert.equal(gate.ok, true)
      assert.equal(gate.status, "PASS")
    }),
})

// --- A7: PDF pre-flight (pypdfium2 + Pillow), PREREQUISITES.md, leap doctor ---
addCase({
  id: "A7-T1-01",
  milestone: "M4",
  feature: "A7",
  tier: "T1",
  title: "teamwork_document_triage probes pypdfium2 + Pillow on image PDF and ingests when available",
  fn: () =>
    withSandbox("a7-t1-01", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(
        binDir,
        "python3",
        `
const args = process.argv.slice(2).join(" ");
if (args.includes("pypdfium2") && args.includes("PIL")) {
  console.log(JSON.stringify({ ok: true, pages: ["Extracted page 1 text from stub"] }));
  process.exit(0);
}
process.exit(0);
`,
      )
      const pdfPath = join(dir, "scan.pdf")
      writeFileSync(pdfPath, makeUnreadableImagePdfBuffer())
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-a7t1"
        const res = await h.tools.teamwork_document_triage.execute(
          { sessionId: runId, document: { path: pdfPath, format: "pdf" }, skipInterview: true },
          { sessionID: "ses_sentinel" },
        )
        assert.ok(!String(res.content).startsWith("refused:"), res.content)
        const manifest = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "document-review", "manifest.json"), "utf8"))
        assert.notEqual(manifest.extractionStatus, "needs_ingestor", "stubbed pypdfium2+Pillow should satisfy PDF ingestion")
      })
    }),
})

addCase({
  id: "A7-T1-02",
  milestone: "M4",
  feature: "A7",
  tier: "T1",
  title: "teamwork_document_triage on unreadable PDF without pypdfium2/Pillow reports MISSING and writes PREREQUISITES.md",
  fn: () =>
    withSandbox("a7-t1-02", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "python3", `console.error("ModuleNotFoundError: No module named 'pypdfium2'"); process.exit(1);`)
      const pdfPath = join(dir, "scan.pdf")
      writeFileSync(pdfPath, makeUnreadableImagePdfBuffer())
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-a7t2"
        const res = await h.tools.teamwork_document_triage.execute(
          { sessionId: runId, document: { path: pdfPath, format: "pdf" }, skipInterview: true },
          { sessionID: "ses_sentinel" },
        )
        assert.match(res.content, /MISSING|pypdfium2|Pillow/i, res.content)
        assert.match(String(res.content), /^refused: MISSING PDF text extraction prerequisites/, res.content)
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true, "PREREQUISITES.md must be written on MISSING PDF deps")
        assert.match(readFileSync(join(dir, "PREREQUISITES.md"), "utf8"), /^- Status: MISSING$/m)
      })
    }),
})

addCase({
  id: "A7-T1-03",
  milestone: "M4",
  feature: "A7",
  tier: "T1",
  title: "teamwork_plan with missing blocking input writes PREREQUISITES.md on MISSING verdict",
  fn: () =>
    withSandbox("a7-t1-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a7t3"
      const res = await h.tools.teamwork_plan.execute(
        {
          sessionId: runId,
          topology: "small-focused",
          request: "Process data",
          inputs: [join(dir, "does-not-exist.csv")],
          skipInterview: true,
          tasks: [{ id: "t1" }],
        },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).includes("MISSING") || String(res.content).startsWith("refused:"), res.content)
      assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true, "PREREQUISITES.md must be written on MISSING plan input")
      const prereq = readFileSync(join(dir, "PREREQUISITES.md"), "utf8")
      assert.match(prereq, /^- Status: MISSING$/m, `plan-input refusal must record MISSING:\n${prereq}`)
    }),
})

addCase({
  id: "A7-T1-04",
  milestone: "M4",
  feature: "A7",
  tier: "T1",
  title: "teamwork_lemma_probe invokes leap doctor alongside lean/lake/leap --help and returns READY",
  fn: () =>
    withSandbox("a7-t1-04", async (dir) => {
      const binDir = join(dir, "bin")
      const marker = join(dir, "leap-doctor-called.txt")
      writeStubBin(binDir, "lean", `console.log("Lean (version 4.14.0)"); process.exit(0);`)
      writeStubBin(binDir, "lake", `console.log("lake version 5.0.0"); process.exit(0);`)
      writeStubBin(
        binDir,
        "leap",
        `
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a.includes("doctor")) {
  fs.writeFileSync(${JSON.stringify(marker)}, a.join(" "));
  console.log("doctor ok");
  process.exit(0);
}
console.log("leap 1.0.0");
process.exit(0);
`,
      )
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const probe = await h.tools.teamwork_lemma_probe.execute({}, { sessionID: "ses_sentinel" })
        assert.equal(probe.ready, true, probe.content)
        assert.equal(probe.leap.doctor.status, "READY", "a passing offline doctor must be READY")
        assert.equal(existsSync(marker), true, "teamwork_lemma_probe must invoke `leap doctor`")
        assert.match(readFileSync(marker, "utf8"), /--offline/, "teamwork_lemma_probe must invoke `leap doctor --offline`")
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), false, "a READY probe must not write PREREQUISITES.md")
      })
    }),
})

addCase({
  id: "A7-T1-05",
  milestone: "M4",
  feature: "A7",
  tier: "T1",
  title: "teamwork_document_triage on valid readable PDF creates DOCUMENT_TEXT_MAP.md and ANALYSIS_PARTITION.md",
  fn: () =>
    withSandbox("a7-t1-05", async (dir) => {
      const pdfPath = join(dir, "readable.pdf")
      writeFileSync(pdfPath, makePdfBuffer("Theorem 1 states that all bounds hold."))
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a7t5"
      const res = await h.tools.teamwork_document_triage.execute(
        { sessionId: runId, document: { path: pdfPath, format: "pdf" }, skipInterview: true },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(res.content).startsWith("refused:"), res.content)
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId, "document-review", "DOCUMENT_TEXT_MAP.md")), true)
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId, "document-review", "ANALYSIS_PARTITION.md")), true)
    }),
})

addCase({
  id: "A7-T1-06",
  milestone: "M4",
  feature: "A7",
  tier: "T1",
  title: "teamwork_lemma_probe treats a LEAN_PROJECT_DIR-only leap doctor failure as READY/WARN",
  fn: () =>
    withSandbox("a7-t1-06", async (dir) => {
      const binDir = join(dir, "bin")
      const leapStub = `
const a = process.argv.slice(2);
if (a.includes("doctor")) {
  console.log("[FAIL] LEAN_PROJECT_DIR -- no local Lean project found");
  process.exit(1);
}
console.log("leap 1.0.0"); process.exit(0);
`
      writeStubBin(binDir, "lean", `console.log("Lean (version 4.14.0)"); process.exit(0);`)
      writeStubBin(binDir, "lake", `console.log("lake version 5.0.0"); process.exit(0);`)
      writeStubBin(binDir, "leap", leapStub)
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const probe = await h.tools.teamwork_lemma_probe.execute({}, { sessionID: "ses_sentinel" })
        assert.equal(probe.ready, true, `a project-only doctor warning must keep the probe READY: ${probe.content}`)
        assert.equal(probe.status, "READY", `expected READY on a core-only host, got ${probe.status}`)
        assert.equal(probe.leap.available, true, "a doctor warning must not make the LEAP CLI unavailable")
        assert.equal(probe.leap.doctor.status, "WARN", "only LEAN_PROJECT_DIR failed, so doctor must be WARN")
        assert.match(String(probe.content), /WARN/, "teamwork_lemma_probe must show the doctor warning")
        assert.match(String(probe.content), /LEAN_PROJECT_DIR/, "the probe must name the failed check")
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), false, "a READY/WARN probe must not write PREREQUISITES.md")

        // When another binary blocks the route, PREREQUISITES.md must still show
        // the doctor warning so the operator can tell it is advisory.
        const partialBin = join(dir, "bin-leap-only")
        writeStubBin(partialBin, "leap", leapStub)
        await withEnv({ PATH: partialBin }, async () => {
          const partial = await h.tools.teamwork_lemma_probe.execute({}, { sessionID: "ses_sentinel" })
          assert.equal(partial.ready, false, "missing lean/lake must still block the probe")
          const prereq = readFileSync(join(dir, "PREREQUISITES.md"), "utf8")
          assert.match(prereq, /leap doctor: WARN/, `PREREQUISITES.md must show the doctor warning:\n${prereq}`)
          assert.match(prereq, /LEAN_PROJECT_DIR/, "PREREQUISITES.md must name the failed doctor check")
        })
      })
    }),
})

// --- A8: Victory Auditor 3-phase report, terminal-state discipline, worker.md:87 ---
addCase({
  id: "A8-T1-01",
  milestone: "M4",
  feature: "A8",
  tier: "T1",
  title: "victory-auditor.md mandates === VICTORY AUDIT REPORT === with Phase A, B, and C",
  fn: () => {
    const va = readAgentPrompt("victory-auditor.md")
    assert.ok(va.includes("=== VICTORY AUDIT REPORT ==="), "victory-auditor.md missing === VICTORY AUDIT REPORT ===")
    assert.match(va, /PHASE A/i)
    assert.match(va, /PHASE B/i)
    assert.match(va, /PHASE C/i)
  },
})

addCase({
  id: "A8-T1-02",
  milestone: "M4",
  feature: "A8",
  tier: "T1",
  title: "teamwork_victory_audit records 3-phase === VICTORY AUDIT REPORT === summary into verify/victory.json",
  fn: () =>
    withSandbox("a8-t1-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a8t2"
      await setupCodingRunToPass(h.tools, dir, runId, { skipInterview: true })
      const saved = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "verify", "victory.json"), "utf8"))
      assert.equal(saved.verdict, "VICTORY CONFIRMED")
      assert.ok(saved.summary.includes("=== VICTORY AUDIT REPORT ==="))
    }),
})

addCase({
  id: "A8-T1-03",
  milestone: "M4",
  feature: "A8",
  tier: "T1",
  title: "sentinel.md distinguishes mid-run pause vs terminal non-victory stop and forbids victory-auditor on pause/incomplete",
  fn: () => {
    const sentinel = readAgentPrompt("sentinel.md")
    assert.match(sentinel, /mid-run pause/i, "sentinel.md must document mid-run pause")
    assert.match(sentinel, /terminal non-victory stop/i, "sentinel.md must document terminal non-victory stop")
  },
})

addCase({
  id: "A8-T1-04",
  milestone: "M4",
  feature: "A8",
  tier: "T1",
  title: "worker.md contains zero bare 'write handoff.md' instructions",
  fn: () => {
    const worker = readAgentPrompt("worker.md")
    assert.equal(/write\s+`?handoff\.md`?/i.test(worker), false, "worker.md must not instruct bare 'write handoff.md'")
    assert.match(worker, /teamwork_handoff/)
  },
})

addCase({
  id: "A8-T1-05",
  milestone: "M4",
  feature: "A8",
  tier: "T1",
  title: "scripts/lint-prompts.mjs passes cleanly",
  fn: () => {
    const res = spawnSync(process.execPath, [PROMPT_LINT_PATH], { encoding: "utf8" })
    assert.equal(res.status, 0, res.stderr || res.stdout)
  },
})

// --- A9: OPENCODE_TEAMWORK_DISABLED, # SYSTEM PROMPT PROTECTION, interrupted.md, v1 alignment ---
addCase({
  id: "A9-T1-01",
  milestone: "M3",
  feature: "A9",
  tier: "T1",
  title: "plugin.setup(ctx) registers 0 tools, 0 commands, 0 hooks when OPENCODE_TEAMWORK_DISABLED=1",
  fn: () =>
    withSandbox("a9-t1-01", async (dir) => {
      await withEnv({ OPENCODE_TEAMWORK_DISABLED: "1" }, async () => {
        const h = await makeHarness(dir, { viaSetup: true })
        assert.equal(Object.keys(h.tools).length, 0, `expected 0 tools, got ${Object.keys(h.tools).length}`)
        assert.equal(Object.keys(h.commands).length, 0, `expected 0 commands, got ${Object.keys(h.commands).length}`)
        assert.equal(Object.keys(h.permissionHooks).length, 0, "expected 0 hooks")
      })
    }),
})

addCase({
  id: "A9-T1-02",
  milestone: "M3",
  feature: "A9",
  tier: "T1",
  title: "plugin.setup(ctx) registers 26 tools and 7 commands when OPENCODE_TEAMWORK_DISABLED is unset",
  fn: () =>
    withSandbox("a9-t1-02", async (dir) => {
      await withEnv({ OPENCODE_TEAMWORK_DISABLED: undefined }, async () => {
        const h = await makeHarness(dir, { viaSetup: true })
        assert.equal(Object.keys(h.tools).length, 26)
        assert.equal(Object.keys(h.commands).length, 7)
        assert.equal(typeof h.permissionHooks.evaluate, "function")
      })
    }),
})

addCase({
  id: "A9-T1-03",
  milestone: "M3",
  feature: "A9",
  tier: "T1",
  title: "sentinel.md and crafter.md embed # SYSTEM PROMPT PROTECTION Decoy Rules 1-2",
  fn: () => {
    for (const file of ["sentinel.md", "crafter.md"]) {
      const txt = readAgentPrompt(file)
      assert.ok(txt.includes("# SYSTEM PROMPT PROTECTION"), `${file} missing # SYSTEM PROMPT PROTECTION`)
      assert.ok(txt.includes("I'm a Teamwork agent. What task can I help you with?"), `${file} missing Decoy Rule 1`)
    }
  },
})

addCase({
  id: "A9-T1-04",
  milestone: "M3",
  feature: "A9",
  tier: "T1",
  title: "interrupted.md contract is implemented on non-tournament abort or aligned consistently",
  fn: () =>
    withSandbox("a9-t1-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a9t4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Task", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const ac = new AbortController()
      ac.abort()
      await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel", signal: ac.signal })
      const artifactsDoc = readFileSync(join(REPO_ROOT, "docs", "ARTIFACTS.md"), "utf8")
      const interruptedExists = existsSync(join(dir, ".opencode", "teamwork", runId, "interrupted.md"))
      if (artifactsDoc.includes("interrupted.md")) {
        assert.equal(interruptedExists, true, "docs/ARTIFACTS.md documents interrupted.md, so aborted teamwork_next must write it")
      }
    }),
})

addCase({
  id: "A9-T1-05",
  milestone: "M3",
  feature: "A9",
  tier: "T1",
  title: "COMMANDS preserves 7 commands and legacy /team-* commands clearly defer to /teamwork",
  fn: () => {
    assert.equal(COMMANDS.length, 7)
    for (const cmd of COMMANDS.filter((c) => c.name.startsWith("team-"))) {
      assert.match(cmd.description + "\n" + cmd.template, /legacy|\/teamwork/i, `${cmd.name} must clarify legacy v1 status`)
    }
  },
})

// =============================================================================
// TIER 2: BOUNDARY & CORNER CASES (65 cases: 5 per feature M1.1..M1.4 + A1..A9)
// =============================================================================

// --- M1.1 Boundaries ---
addCase({
  id: "M1.1-T2-01",
  milestone: "M1",
  feature: "M1.1",
  tier: "T2",
  title: "OPENCODE_DB=':memory:' does not check literal ':memory:' file on disk",
  fn: () =>
    withSandbox("m1-1-t2-01", (dir) => {
      const report = collectSecurityReport(
        securityBaseOpts(dir, { env: { OPENCODE_DB: ":memory:", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }),
      )
      const c = report.checks.find((x) => x.name === "db_mode")
      assert.equal(c.message.includes(":memory: mode"), false, `should not stat literal :memory:: ${c.message}`)
    }),
})

addCase({
  id: "M1.1-T2-02",
  milestone: "M1",
  feature: "M1.1",
  tier: "T2",
  title: "0644 -wal sibling of 0600 OPENCODE_DB triggers db_mode failure",
  fn: () =>
    withSandbox("m1-1-t2-02", (dir) => {
      const dbPath = join(dir, "wal-test.db")
      writeFileSync(dbPath, "db")
      chmodSync(dbPath, 0o600)
      writeFileSync(`${dbPath}-wal`, "wal")
      chmodSync(`${dbPath}-wal`, 0o644)
      const report = collectSecurityReport(
        securityBaseOpts(dir, { env: { OPENCODE_DB: dbPath, OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }),
      )
      const c = report.checks.find((x) => x.name === "db_mode")
      assert.equal(c.status, "fail", c.message)
      assert.ok(c.message.includes(`${dbPath}-wal`), c.message)
    }),
})

addCase({
  id: "M1.1-T2-03",
  milestone: "M1",
  feature: "M1.1",
  tier: "T2",
  title: "Empty/whitespace OPENCODE_CHANNEL falls back to opencode.db",
  fn: () =>
    withSandbox("m1-1-t2-03", (dir) => {
      const xdgData = join(dir, "xdg")
      const dbPath = join(xdgData, "opencode", "opencode.db")
      mkdirSync(dirname(dbPath), { recursive: true })
      writeFileSync(dbPath, "db")
      chmodSync(dbPath, 0o644)
      const report = collectSecurityReport(
        securityBaseOpts(dir, { env: { XDG_DATA_HOME: xdgData, OPENCODE_CHANNEL: "   ", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }),
      )
      const c = report.checks.find((x) => x.name === "db_mode")
      assert.equal(c.status, "fail", c.message)
      assert.ok(c.message.includes(dbPath), c.message)
    }),
})

addCase({
  id: "M1.1-T2-04",
  milestone: "M1",
  feature: "M1.1",
  tier: "T2",
  title: "Missing XDG_DATA_HOME falls back to HOME/.local/share/opencode",
  fn: () =>
    withSandbox("m1-1-t2-04", async (dir) => {
      const fakeHome = join(dir, "home")
      const expectedDb = join(fakeHome, ".local", "share", "opencode", "opencode-canary.db")
      mkdirSync(dirname(expectedDb), { recursive: true })
      writeFileSync(expectedDb, "db")
      chmodSync(expectedDb, 0o644)
      await withEnv({ HOME: fakeHome, XDG_DATA_HOME: undefined, OPENCODE_CHANNEL: "canary", OPENCODE_DB: undefined }, () => {
        const report = collectSecurityReport(
          securityBaseOpts(dir, { env: { HOME: fakeHome, OPENCODE_CHANNEL: "canary", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }),
        )
        const c = report.checks.find((x) => x.name === "db_mode")
        assert.equal(c.status, "fail", c.message)
        assert.ok(c.message.includes("opencode-canary.db"), c.message)
      })
    }),
})

addCase({
  id: "M1.1-T2-05",
  milestone: "M1",
  feature: "M1.1",
  tier: "T2",
  title: "OPENCODE_DB overrides OPENCODE_CHANNEL when both are set",
  fn: () =>
    withSandbox("m1-1-t2-05", (dir) => {
      const overrideDb = join(dir, "override.db")
      writeFileSync(overrideDb, "db")
      chmodSync(overrideDb, 0o600)
      const xdgData = join(dir, "xdg")
      mkdirSync(join(xdgData, "opencode"), { recursive: true })
      const channelDb = join(xdgData, "opencode", "opencode-nightly.db")
      writeFileSync(channelDb, "db")
      chmodSync(channelDb, 0o644)
      const report = collectSecurityReport(
        securityBaseOpts(dir, {
          env: {
            XDG_DATA_HOME: xdgData,
            OPENCODE_CHANNEL: "nightly",
            OPENCODE_DB: overrideDb,
            OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k",
          },
        }),
      )
      const c = report.checks.find((x) => x.name === "db_mode")
      assert.equal(c.status, "pass", c.message)
      assert.ok(c.message.includes(overrideDb), c.message)
    }),
})

// --- M1.2 Boundaries ---
addCase({
  id: "M1.2-T2-01",
  milestone: "M1",
  feature: "M1.2",
  tier: "T2",
  title: "collectSecurityReport handles empty groups: [] cleanly",
  fn: () =>
    withSandbox("m1-2-t2-01", (dir) => {
      const report = collectSecurityReport(securityBaseOpts(dir, { groups: [], dbPath: join(dir, "a.db") }))
      assert.equal(report.checks.find((c) => c.name === "privileged_groups").status, "pass")
    }),
})

addCase({
  id: "M1.2-T2-02",
  milestone: "M1",
  feature: "M1.2",
  tier: "T2",
  title: "collectSecurityReport ignores unknown numeric GID 99999 not in groupFile",
  fn: () =>
    withSandbox("m1-2-t2-02", (dir) => {
      const report = collectSecurityReport(securityBaseOpts(dir, { groups: [99999], dbPath: join(dir, "a.db") }))
      assert.equal(report.checks.find((c) => c.name === "privileged_groups").status, "pass")
    }),
})

addCase({
  id: "M1.2-T2-03",
  milestone: "M1",
  feature: "M1.2",
  tier: "T2",
  title: "collectSecurityReport detects wheel via numeric 10 and string 'wheel' identically",
  fn: () =>
    withSandbox("m1-2-t2-03", (dir) => {
      const gf = join(dir, "group")
      writeFileSync(gf, "wheel:x:10:\n")
      const rNum = collectSecurityReport(securityBaseOpts(dir, { groupFile: gf, groups: [10], dbPath: join(dir, "a.db") }))
      const rStr = collectSecurityReport(securityBaseOpts(dir, { groupFile: gf, groups: ["wheel"], dbPath: join(dir, "a.db") }))
      assert.equal(rNum.checks.find((c) => c.name === "privileged_groups").status, "fail")
      assert.equal(rStr.checks.find((c) => c.name === "privileged_groups").status, "fail")
    }),
})

addCase({
  id: "M1.2-T2-04",
  milestone: "M1",
  feature: "M1.2",
  tier: "T2",
  title: "verifyRun falls back to 'skip' when requireHandoffs is unrecognized",
  fn: () =>
    withSandbox("m1-2-t2-04", async (dir) => {
      const runId = "20261125-120000-m12t4"
      const h = await makeHarness(dir)
      await setupCodingRunToPass(h.tools, dir, runId, { requireHandoffs: "skip", victoryAudit: "skip", victorySkipReason: "fixture" })
      await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
      state.requireHandoffs = "bogus"
      writeFileSync(join(runDir, "state.json"), JSON.stringify(state))
      const plan = JSON.parse(readFileSync(join(runDir, "plan.dag.json"), "utf8"))
      plan.requireHandoffs = "bogus"
      writeFileSync(join(runDir, "plan.dag.json"), JSON.stringify(plan))
      const vr = await verifyRun({ runDir, allowUnsigned: true })
      assert.ok(!vr.reasons.some((r) => /HANDOFF_MISSING/.test(r)), `bogus requireHandoffs should fall back to skip: ${vr.reasons}`)
    }),
})

addCase({
  id: "M1.2-T2-05",
  milestone: "M1",
  feature: "M1.2",
  tier: "T2",
  title: "verifyRun falls back to 'skip' when requireHandoffs is omitted in legacy run",
  fn: () =>
    withSandbox("m1-2-t2-05", async (dir) => {
      const runId = "20261125-120000-m12t5"
      const runDir = join(dir, ".opencode", "teamwork", runId)
      mkdirSync(join(runDir, "verify"), { recursive: true })
      writeFileSync(join(runDir, "plan.dag.json"), JSON.stringify({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }] }))
      writeFileSync(join(runDir, "state.json"), JSON.stringify({ sessionId: runId, tasks: { t1: { status: "verified_pass", round: 1 } } }))
      const vr = await verifyRun({ runDir, allowUnsigned: true })
      assert.ok(!vr.reasons.some((r) => /HANDOFF_MISSING/.test(r)))
    }),
})

// --- M1.3 Boundaries ---
for (const [idx, badId] of [
  ["01", "../escape"],
  ["02", "../../etc"],
  ["03", "a/b"],
  ["04", ".."],
  ["05", "x".repeat(65)],
]) {
  addCase({
    id: `M1.3-T2-${idx}`,
    milestone: "M1",
    feature: "M1.3",
    tier: "T2",
    title: `approval-driver.mjs rejects hostile runId ${JSON.stringify(badId)} before touching disk`,
    fn: () =>
      withSandbox(`m1-3-t2-${idx}`, (dir) => {
        const storage = join(dir, "storage.json")
        const res = spawnSync(
          process.execPath,
          [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId: badId, draft: "pwn" })],
          { encoding: "utf8" },
        )
        assert.notEqual(res.status, 0, `expected non-zero exit for runId ${JSON.stringify(badId)}`)
        assert.equal(existsSync(join(dir, ".opencode", "teamwork", "escape")), false)
        assert.equal(existsSync(join(dir, ".opencode", "teamwork", "prompt_draft.md")), false)
      }),
  })
}

// --- M1.4 Boundaries ---
addCase({
  id: "M1.4-T2-01",
  milestone: "M1",
  feature: "M1.4",
  tier: "T2",
  title: "service.json with ftp:// URL never hits loopback server and falls back cleanly",
  fn: () =>
    withSandbox("m1-4-t2-01", async (dir) => {
      let hits = 0
      await withLoopbackServer((_req, res) => {
        hits += 1
        res.end("{}")
      }, async ({ port }) => {
        const xdgState = join(dir, "xdg")
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: `ftp://127.0.0.1:${port}` }))
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir)
          await h.tools.teamwork_plan.execute({ sessionId: "20261125-120000-m14b1", topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          const cost = await h.tools.teamwork_cost.execute({ addUsd: 0.2 }, { sessionID: "ses_sentinel" })
          assert.equal(hits, 0)
          assert.ok(cost.content.includes("manual"))
        })
      })
    }),
})

addCase({
  id: "M1.4-T2-02",
  milestone: "M1",
  feature: "M1.4",
  tier: "T2",
  title: "service.json with cloud metadata IP 169.254.169.254 is rejected before fetch",
  fn: () =>
    withSandbox("m1-4-t2-02", async (dir) => {
      const xdgState = join(dir, "xdg")
      mkdirSync(join(xdgState, "opencode"), { recursive: true })
      writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: "http://169.254.169.254/latest" }))
      let fetchCalls = 0
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url, ...rest) => {
        if (String(url).includes("169.254.169.254")) {
          fetchCalls += 1
          throw new Error("blocked test fetch to metadata IP")
        }
        return origFetch(url, ...rest)
      }
      try {
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir)
          await h.tools.teamwork_plan.execute({ sessionId: "20261125-120000-m14b2", topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          const cost = await h.tools.teamwork_cost.execute({ addUsd: 0.1 }, { sessionID: "ses_sentinel" })
          assert.equal(fetchCalls, 0, `metadata IP 169.254.169.254 must be rejected before fetch (got ${fetchCalls} call(s))`)
          assert.ok(cost.content.includes("manual"), "metadata IP must be rejected and fall back")
        })
      } finally {
        globalThis.fetch = origFetch
      }
    }),
})

addCase({
  id: "M1.4-T2-03",
  milestone: "M1",
  feature: "M1.4",
  tier: "T2",
  title: "service.json with embedded credentials http://user:pass@127.0.0.1 is rejected before fetch",
  fn: () =>
    withSandbox("m1-4-t2-03", async (dir) => {
      let hits = 0
      await withLoopbackServer((_req, res) => {
        hits += 1
        res.end("{}")
      }, async ({ port }) => {
        const xdgState = join(dir, "xdg")
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: `http://user:pass@127.0.0.1:${port}` }))
        await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
          const h = await makeHarness(dir)
          await h.tools.teamwork_plan.execute({ sessionId: "20261125-120000-m14b3", topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_cost.execute({ addUsd: 0.1 }, { sessionID: "ses_sentinel" })
          assert.equal(hits, 0, `URL with embedded user:pass must be rejected before fetch (got ${hits} hits)`)
        })
      })
    }),
})

addCase({
  id: "M1.4-T2-04",
  milestone: "M1",
  feature: "M1.4",
  tier: "T2",
  title: "service.json with file:///etc/passwd is rejected cleanly",
  fn: () =>
    withSandbox("m1-4-t2-04", async (dir) => {
      const xdgState = join(dir, "xdg")
      mkdirSync(join(xdgState, "opencode"), { recursive: true })
      writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: "file:///etc/passwd" }))
      await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
        const h = await makeHarness(dir)
        await h.tools.teamwork_plan.execute({ sessionId: "20261125-120000-m14b4", topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
        const cost = await h.tools.teamwork_cost.execute({ addUsd: 0.1 }, { sessionID: "ses_sentinel" })
        assert.ok(cost.content.includes("manual"))
      })
    }),
})

addCase({
  id: "M1.4-T2-05",
  milestone: "M1",
  feature: "M1.4",
  tier: "T2",
  title: "service.json with non-string url or malformed JSON does not crash",
  fn: () =>
    withSandbox("m1-4-t2-05", async (dir) => {
      const xdgState = join(dir, "xdg")
      mkdirSync(join(xdgState, "opencode"), { recursive: true })
      writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url: 12345 }))
      await withEnv({ HOME: dir, XDG_STATE_HOME: xdgState, OPENCODE_DB: join(dir, "absent.db") }, async () => {
        const h = await makeHarness(dir)
        await h.tools.teamwork_plan.execute({ sessionId: "20261125-120000-m14b5", topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
        const cost = await h.tools.teamwork_cost.execute({ addUsd: 0.3 }, { sessionID: "ses_sentinel" })
        assert.ok(cost.content.includes("manual"))
      })
    }),
})

// --- A1 Boundaries ---
addCase({
  id: "A1-T2-01",
  milestone: "M3",
  feature: "A1",
  tier: "T2",
  title: "/teamwork [skip-interview] with empty body asks user first instead of routing",
  fn: () =>
    withSandbox("a1-t2-01", async (dir) => {
      const h = await makeHarness(dir, { viaSetup: true })
      await h.commands.teamwork.execute({ sessionID: "ses_sentinel", prompt: { text: "[skip-interview]   " } })
      assert.equal(h.prompted.length, 1)
      assert.match(h.prompted[0].text, /ask the user|empty|what .*task/i, `empty /teamwork [skip-interview] must prompt user: ${h.prompted[0].text}`)
      assert.equal(/teamwork_plan/.test(h.prompted[0].text), false, "must not launch routing DAG on empty request")
    }),
})

addCase({
  id: "A1-T2-02",
  milestone: "M3",
  feature: "A1",
  tier: "T2",
  title: "Unlisted leading bracket [WIP] fix bug stays in ## Request",
  fn: () =>
    withSandbox("a1-t2-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1b2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[WIP] fix bug", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.ok((orig.split("## Request\n")[1] ?? "").includes("[WIP] fix bug"))
    }),
})

addCase({
  id: "A1-T2-03",
  milestone: "M3",
  feature: "A1",
  tier: "T2",
  title: "[skip-interview][WIP] fix strips only leading [skip-interview] and keeps [WIP] fix",
  fn: () =>
    withSandbox("a1-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1b3"
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview][WIP] fix", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(res.content).startsWith("refused:"), res.content)
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.equal((orig.split("## Request\n")[1] ?? "").trim(), "[WIP] fix")
    }),
})

addCase({
  id: "A1-T2-04",
  milestone: "M3",
  feature: "A1",
  tier: "T2",
  title: "Non-leading [skip-interview] is treated as literal text and does not bypass interview gate",
  fn: () =>
    withSandbox("a1-t2-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1b4"
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "fix [skip-interview] bug", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:"), "non-leading [skip-interview] must NOT bypass prompt_draft.md gate")
    }),
})

addCase({
  id: "A1-T2-05",
  milestone: "M3",
  feature: "A1",
  tier: "T2",
  title: "Post-strip request > 20000 chars is refused before creating run files",
  fn: () =>
    withSandbox("a1-t2-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a1b5"
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: `[skip-interview] ${"x".repeat(20001)}`, skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:"))
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId)), false)
    }),
})

// --- A2 Boundaries ---
addCase({
  id: "A2-T2-01",
  milestone: "M3",
  feature: "A2",
  tier: "T2",
  title: "crafter.md Step 3 does not present development/demo/benchmark as user-facing option labels",
  fn: () => {
    const crafter = readAgentPrompt("crafter.md")
    const step3 = crafter.slice(crafter.indexOf("3."), crafter.indexOf("4."))
    assert.equal(
      /`development`\s*\(default\),\s*`demo`/i.test(step3),
      false,
      "crafter.md Step 3 must use behavioral options, not expose mode names directly",
    )
  },
})

addCase({
  id: "A2-T2-02",
  milestone: "M3",
  feature: "A2",
  tier: "T2",
  title: "crafter.md Step 3 maps 'from scratch' + no delegation to benchmark floor",
  fn: () => {
    const crafter = readAgentPrompt("crafter.md")
    assert.match(crafter, /from scratch/i)
    assert.match(crafter, /benchmark/i)
  },
})

addCase({
  id: "A2-T2-03",
  milestone: "M3",
  feature: "A2",
  tier: "T2",
  title: "teamwork_plan without prompt_draft.md and skipInterview: false writes zero files",
  fn: () =>
    withSandbox("a2-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a2b3"
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Build API", skipInterview: false, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:"))
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId)), false)
    }),
})

addCase({
  id: "A2-T2-04",
  milestone: "M3",
  feature: "A2",
  tier: "T2",
  title: "Empty/whitespace-only prompt_draft.md is refused by teamwork_plan",
  fn: () =>
    withSandbox("a2-t2-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a2b4"
      const runDir = join(dir, ".opencode", "teamwork", runId)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, "prompt_draft.md"), "   \n\t\n")
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:"))
      assert.equal(existsSync(join(runDir, "plan.dag.json")), false)
    }),
})

addCase({
  id: "A2-T2-05",
  milestone: "M3",
  feature: "A2",
  tier: "T2",
  title: "test-catalog.mjs passes tool and prompt token invariants",
  fn: () => {
    const res = spawnSync(process.execPath, [CATALOG_TEST_PATH], { encoding: "utf8" })
    assert.equal(res.status, 0, res.stderr || res.stdout)
  },
})

// --- A3 Boundaries ---
addCase({
  id: "A3-T2-01",
  milestone: "M3",
  feature: "A3",
  tier: "T2",
  title: "Duplicate consecutive follow-up message is skipped idempotently",
  fn: () =>
    withSandbox("a3-t2-01", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3b1"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Initial.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      await invokeFollowUpAppend(h.tools, runId, "Repeated note", { sessionID: "ses_sentinel" })
      await invokeFollowUpAppend(h.tools, runId, "Repeated note", { sessionID: "ses_sentinel" })
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      const matches = orig.match(/Repeated note/g) ?? []
      assert.equal(matches.length, 1, "duplicate consecutive follow-up must be skipped")
    }),
})

addCase({
  id: "A3-T2-02",
  milestone: "M3",
  feature: "A3",
  tier: "T2",
  title: "Empty/whitespace follow-up message is refused without modifying ORIGINAL_REQUEST.md",
  fn: () =>
    withSandbox("a3-t2-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3b2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Initial.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const before = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      const res = await invokeFollowUpAppend(h.tools, runId, "   \n  ", { sessionID: "ses_sentinel" })
      assert.ok(String(res.content).startsWith("refused:"), res.content)
      assert.equal(readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8"), before)
    }),
})

addCase({
  id: "A3-T2-03",
  milestone: "M3",
  feature: "A3",
  tier: "T2",
  title: "Oversized follow-up (> 20000 chars) is refused without modifying ORIGINAL_REQUEST.md",
  fn: () =>
    withSandbox("a3-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3b3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Initial.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const before = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      const res = await invokeFollowUpAppend(h.tools, runId, "z".repeat(20001), { sessionID: "ses_sentinel" })
      assert.ok(String(res.content).startsWith("refused:"), res.content)
      assert.equal(readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8"), before)
    }),
})

addCase({
  id: "A3-T2-04",
  milestone: "M3",
  feature: "A3",
  tier: "T2",
  title: "Symlinked ORIGINAL_REQUEST.md is refused on follow-up append",
  fn: () =>
    withSandbox("a3-t2-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3b4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Initial.", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const reqFile = join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md")
      const victim = join(dir, "victim.txt")
      writeFileSync(victim, "UNTOUCHED")
      rmSync(reqFile)
      symlinkSync(victim, reqFile)
      const res = await invokeFollowUpAppend(h.tools, runId, "Follow-up", { sessionID: "ses_sentinel" })
      assert.ok(String(res.content).startsWith("refused:"), res.content)
      assert.equal(readFileSync(victim, "utf8"), "UNTOUCHED")
    }),
})

addCase({
  id: "A3-T2-05",
  milestone: "M3",
  feature: "A3",
  tier: "T2",
  title: "Follow-up append after VICTORY CONFIRMED invalidates/stales victory gate",
  fn: () =>
    withSandbox("a3-t2-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a3b5"
      await setupCodingRunToPass(h.tools, dir, runId, { skipInterview: true })
      // Prove the run is terminal before the append; otherwise "not ALL_PASSED
      // afterwards" is vacuous.
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.equal(fv.status, "PASS", `fixture must reach final PASS before the append: ${fv.content}`)
      const beforeAppend = await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.equal(beforeAppend.status, "ALL_PASSED", `fixture must be ALL_PASSED before the append: ${beforeAppend.content}`)
      await invokeFollowUpAppend(h.tools, runId, "New requirement after victory.", { sessionID: "ses_sentinel" })
      const next = await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.notEqual(next.status, "ALL_PASSED", "follow-up append must not keep stale VICTORY CONFIRMED valid")
      assert.match(String(next.content), /AUTH_STALE|request.?hash/i, `stale victory must cite AUTH_STALE/requestHash drift: ${next.content}`)
    }),
})

// --- A4 Boundaries ---
addCase({
  id: "A4-T2-01",
  milestone: "M4",
  feature: "A4",
  tier: "T2",
  title: "small-focused with maxRounds: 3 blocks only at round 3 verified_fail",
  fn: () =>
    withSandbox("a4-t2-01", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4b1"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 3 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2, 3]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        const u = await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: `r${r}` }, { sessionID: "ses_sentinel" })
        assert.equal(u.status, r < 3 ? "verified_fail" : "blocked")
      }
    }),
})

addCase({
  id: "A4-T2-02",
  milestone: "M4",
  feature: "A4",
  tier: "T2",
  title: "small-focused verified_fail preserves prior open issues without silent drop",
  fn: () =>
    withSandbox("a4-t2-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4b2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Keep me" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail" }, { sessionID: "ses_sentinel" })
      const state = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "state.json"), "utf8"))
      assert.ok(state.tasks.t1.feedbackLog.some((e) => e.text === "Keep me" && e.resolved === false))
    }),
})

addCase({
  id: "A4-T2-03",
  milestone: "M4",
  feature: "A4",
  tier: "T2",
  title: "small-focused enforces max 2 victory audits (blocks 3rd audit attempt)",
  fn: () =>
    withSandbox("a4-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4b3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", requirements: [{ id: "R1", text: "Fix" }], skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      for (const n of [1, 2]) {
        const res = await h.tools.teamwork_victory_audit.execute(
          { sessionId: runId, verdict: "VICTORY REJECTED", requirements: [{ id: "R1", met: false, evidence: `Reject ${n}` }], summary: makeThreePhaseVictorySummary("VICTORY REJECTED") },
          { sessionID: "ses_victory" },
        )
        assert.ok(!String(res.content).startsWith("refused:"), res.content)
      }
      const third = await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY REJECTED", requirements: [{ id: "R1", met: false, evidence: "Reject 3" }], summary: makeThreePhaseVictorySummary("VICTORY REJECTED") },
        { sessionID: "ses_victory" },
      )
      assert.ok(String(third.content).startsWith("refused:"), `3rd victory audit in small-focused should be capped/refused: ${third.content}`)

      // Residual review finding: an unsigned legacy run has no signed manifest.
      // A re-plan must still not change topology (it would move the 2-audit cap
      // to an uncapped topology) and must leave plan.dag.json byte-identical.
      const unsignedRun = "20261125-120000-a4b3u"
      const firstUnsigned = await h.tools.teamwork_plan.execute(
        {
          sessionId: unsignedRun,
          topology: "small-focused",
          request: "Unsigned fix",
          requirements: [{ id: "R1", text: "Fix" }],
          allowUnsignedLegacy: true,
          skipInterview: true,
          tasks: [{ id: "t1" }],
        },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(firstUnsigned.content).startsWith("refused:"), firstUnsigned.content)
      const unsignedPlanFile = join(dir, ".opencode", "teamwork", unsignedRun, "plan.dag.json")
      const beforeUnsignedPlan = readFileSync(unsignedPlanFile)
      const unsignedReplan = await h.tools.teamwork_plan.execute(
        { sessionId: unsignedRun, topology: "iterative-coding", allowUnsignedLegacy: true, skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(unsignedReplan.content).startsWith("refused:"), `unsigned topology change must be refused: ${unsignedReplan.content}`)
      assert.match(String(unsignedReplan.content), /AUTH_STALE|re-plan/i, unsignedReplan.content)
      assert.deepEqual(readFileSync(unsignedPlanFile), beforeUnsignedPlan, "a refused unsigned re-plan must not rewrite plan.dag.json")
      for (const n of [1, 2]) {
        const rejected = await h.tools.teamwork_victory_audit.execute(
          {
            sessionId: unsignedRun,
            verdict: "VICTORY REJECTED",
            requirements: [{ id: "R1", met: false, evidence: `Unsigned reject ${n}` }],
            summary: makeThreePhaseVictorySummary("VICTORY REJECTED"),
          },
          { sessionID: "ses_victory" },
        )
        assert.ok(!String(rejected.content).startsWith("refused:"), rejected.content)
      }
      const unsignedThird = await h.tools.teamwork_victory_audit.execute(
        {
          sessionId: unsignedRun,
          verdict: "VICTORY REJECTED",
          requirements: [{ id: "R1", met: false, evidence: "Unsigned reject 3" }],
          summary: makeThreePhaseVictorySummary("VICTORY REJECTED"),
        },
        { sessionID: "ses_victory" },
      )
      assert.ok(String(unsignedThird.content).startsWith("refused:"), `unsigned small-focused run must keep the 2-audit cap: ${unsignedThird.content}`)
    }),
})

addCase({
  id: "A4-T2-04",
  milestone: "M4",
  feature: "A4",
  tier: "T2",
  title: "Re-opening via verified_fail after prior failures retains full history in feedbackLog",
  fn: () =>
    withSandbox("a4-t2-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4b4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 6 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2, 3]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: `item-${r}` }, { sessionID: "ses_sentinel" })
      }
      const state = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "state.json"), "utf8"))
      assert.equal(state.tasks.t1.feedbackLog.length, 3)
    }),
})

addCase({
  id: "A4-T2-05",
  milestone: "M4",
  feature: "A4",
  tier: "T2",
  title: "small-focused accepts maxRounds: 32 cleanly",
  fn: () =>
    withSandbox("a4-t2-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a4b5"
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 32 }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(res.content).startsWith("refused:"), res.content)
      const plan = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "plan.dag.json"), "utf8"))
      assert.equal(plan.tasks[0].maxRounds, 32)
    }),
})

// --- A5 Boundaries ---
addCase({
  id: "A5-T2-01",
  milestone: "M4",
  feature: "A5",
  tier: "T2",
  title: "1 failure alone does NOT trigger DEAD_ENDS.md Oscillation Guard",
  fn: () =>
    withSandbox("a5-t2-01", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a5b1"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Build", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Single fail" }, { sessionID: "ses_sentinel" })
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId, "DEAD_ENDS.md")), false)
    }),
})

addCase({
  id: "A5-T2-02",
  milestone: "M4",
  feature: "A5",
  tier: "T2",
  title: "2 different consecutive failures do NOT trigger DEAD_ENDS.md Oscillation Guard",
  fn: () =>
    withSandbox("a5-t2-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a5b2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Build", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const [r, fb] of [
        [1, "Error alpha"],
        [2, "Error beta"],
      ]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: fb }, { sessionID: "ses_sentinel" })
      }
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId, "DEAD_ENDS.md")), false)
    }),
})

addCase({
  id: "A5-T2-03",
  milestone: "M4",
  feature: "A5",
  tier: "T2",
  title: "2 consecutive identical failures write DEAD_ENDS.md with task/approach details",
  fn: () =>
    withSandbox("a5-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a5b3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Build", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Identical failure X" }, { sessionID: "ses_sentinel" })
      }
      const dePath = join(dir, ".opencode", "teamwork", runId, "DEAD_ENDS.md")
      assert.equal(existsSync(dePath), true, "DEAD_ENDS.md must be written after 2 identical failures")
      assert.ok(readFileSync(dePath, "utf8").includes("Identical failure X"))
    }),
})

addCase({
  id: "A5-T2-04",
  milestone: "M4",
  feature: "A5",
  tier: "T2",
  title: "Regression Guard documented across sentinel/orchestrator/ARTIFACTS.md",
  fn: () => {
    const all = `${readAgentPrompt("sentinel.md")}\n${readAgentPrompt("orchestrator.md")}\n${readFileSync(join(REPO_ROOT, "docs", "ARTIFACTS.md"), "utf8")}`
    assert.match(all, /Regression Guard/i)
    assert.match(all, /DEAD_ENDS\.md/)
  },
})

addCase({
  id: "A5-T2-05",
  milestone: "M4",
  feature: "A5",
  tier: "T2",
  title: "Dual-Track E2E gate requires TEST_READY.md before Final Milestone completion in prompts",
  fn: () => {
    const all = `${readAgentPrompt("sentinel.md")}\n${readAgentPrompt("orchestrator.md")}`
    assert.ok(all.includes("TEST_READY.md"))
    assert.match(all, /TEST_READY\.md[\s\S]{0,200}(?:final|sign[- ]?off|milestone|complete)/i)
  },
})

// --- A6 Boundaries ---
addCase({
  id: "A6-T2-01",
  milestone: "M4",
  feature: "A6",
  tier: "T2",
  title: "team/falsifier permission hook still denies edit and subagent",
  fn: () =>
    withSandbox("a6-t2-01", async (dir) => {
      const h = await makeHarness(dir)
      for (const action of ["edit", "subagent"]) {
        const ev = { agent: "team/falsifier", action, effect: "allow" }
        h.permissionHooks.evaluate(ev)
        assert.equal(ev.effect, "deny", `team/falsifier must deny ${action}`)
      }
    }),
})

addCase({
  id: "A6-T2-02",
  milestone: "M4",
  feature: "A6",
  tier: "T2",
  title: "teamwork_wave_record refuses challenge from non-falsifier caller",
  fn: () =>
    withSandbox("a6-t2-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6b2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", verification: "strict", request: "T", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const res = await h.tools.teamwork_wave_record.execute(
        { sessionId: runId, taskId: "t1", kind: "challenge", verdict: "PASS" },
        { sessionID: "ses_worker" },
      )
      assert.ok(String(res.content).startsWith("refused:"), res.content)
    }),
})

addCase({
  id: "A6-T2-03",
  milestone: "M4",
  feature: "A6",
  tier: "T2",
  title: "teamwork_wave_record refuses when verifier report is missing or FAIL",
  fn: () =>
    withSandbox("a6-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6b3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", verification: "strict", request: "T", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const res = await h.tools.teamwork_wave_record.execute(
        { sessionId: runId, taskId: "t1", kind: "challenge", verdict: "PASS" },
        { sessionID: "ses_falsifier" },
      )
      assert.ok(String(res.content).startsWith("refused:"), res.content)
    }),
})

addCase({
  id: "A6-T2-04",
  milestone: "M4",
  feature: "A6",
  tier: "T2",
  title: "Modifying cited verify/evidence file invalidates strict wave as STALE",
  fn: () =>
    withSandbox("a6-t2-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a6b4"
      await setupCodingRunToPass(h.tools, dir, runId, { verification: "strict" })
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const repPath = join(runDir, "verify", "report-t1.json")
      writeFileSync(repPath, readFileSync(repPath, "utf8") + "\n")
      const gate = evaluateStrictGate(runDir, [{ id: "t1", status: "verified_pass" }], "strict")
      assert.equal(gate.ok, false)
      assert.equal(gate.status, "STALE")
    }),
})

addCase({
  id: "A6-T2-05",
  milestone: "M4",
  feature: "A6",
  tier: "T2",
  title: "renderGateStatus escapes pipe characters in GATE_STATUS.md cells",
  fn: () => {
    const md = renderGateStatus({
      sessionId: "s1",
      finalStatus: "FAIL",
      gate: {
        mode: "strict",
        skipped: false,
        ok: false,
        status: "FAIL",
        reasons: ["bad|reason"],
        missing: [],
        tasks: [],
      },
      reasons: ["bad|reason"],
      handoffs: {
        mode: "required",
        status: "FAIL",
        entries: [{ taskId: "t|1", agent: "team/worker", path: "h.md", sha256: "abc" }],
      },
    })
    assert.ok(md.includes("t\\|1"), `expected escaped pipe in GATE_STATUS.md:\n${md}`)
  },
})

// --- A7 Boundaries ---
addCase({
  id: "A7-T2-01",
  milestone: "M4",
  feature: "A7",
  tier: "T2",
  title: "Unreadable PDF without pypdfium2/Pillow writes PREREQUISITES.md and refuses before creating run dir",
  fn: () =>
    withSandbox("a7-t2-01", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "python3", `process.exit(1);`)
      const pdfPath = join(dir, "img.pdf")
      writeFileSync(pdfPath, makeUnreadableImagePdfBuffer())
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-a7b1"
        const res = await h.tools.teamwork_document_triage.execute(
          { sessionId: runId, document: { path: pdfPath, format: "pdf" }, skipInterview: true },
          { sessionID: "ses_sentinel" },
        )
        assert.match(res.content, /MISSING|refused/i, res.content)
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true)
        assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId)), false, "run dir must NOT be created on pre-flight MISSING")
      })
    }),
})

addCase({
  id: "A7-T2-02",
  milestone: "M4",
  feature: "A7",
  tier: "T2",
  title: "teamwork_lemma_probe returns OUTAGE when leap --help passes but leap doctor fails",
  fn: () =>
    withSandbox("a7-t2-02", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "lean", `console.log("Lean 4.14.0"); process.exit(0);`)
      writeStubBin(binDir, "lake", `console.log("lake 5.0.0"); process.exit(0);`)
      writeStubBin(
        binDir,
        "leap",
        `
const a = process.argv.slice(2);
if (a.includes("doctor")) { console.error("doctor failed"); process.exit(1); }
console.log("leap 1.0.0"); process.exit(0);
`,
      )
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const probe = await h.tools.teamwork_lemma_probe.execute({}, { sessionID: "ses_sentinel" })
        assert.equal(probe.ready, false, "failing leap doctor must make probe not ready")
        assert.equal(probe.status, "OUTAGE", `expected OUTAGE when leap doctor fails, got ${probe.status}`)
        assert.doesNotMatch(String(probe.content), /Nothing was written/i, "PREREQUISITES.md is written, so the refusal must not claim nothing was written")
        assert.match(String(probe.content), /No run directory or plan artifact was created/)
        const prereq = readFileSync(join(dir, "PREREQUISITES.md"), "utf8")
        assert.match(prereq, /^- Status: OUTAGE$/m, `a leap doctor failure is OUTAGE, not MISSING:\n${prereq}`)
        assert.doesNotMatch(prereq, /^- Status: MISSING$/m)
      })
    }),
})

addCase({
  id: "A7-T2-03",
  milestone: "M4",
  feature: "A7",
  tier: "T2",
  title: "Symlinked PREREQUISITES.md target is refused on MISSING preflight",
  fn: () =>
    withSandbox("a7-t2-03", async (dir) => {
      const victim = join(dir, "victim-prereq.txt")
      writeFileSync(victim, "SAFE")
      symlinkSync(victim, join(dir, "PREREQUISITES.md"))
      const h = await makeHarness(dir)
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: "20261125-120000-a7b3", topology: "small-focused", request: "Task", inputs: [join(dir, "missing.txt")], skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:") || String(res.content).includes("MISSING"))
      assert.equal(readFileSync(victim, "utf8"), "SAFE", "symlinked PREREQUISITES.md must never be overwritten")
      assert.equal(lstatSync(join(dir, "PREREQUISITES.md")).isSymbolicLink(), true, "a planted PREREQUISITES.md symlink must be refused, not replaced")
    }),
})

addCase({
  id: "A7-T2-04",
  milestone: "M4",
  feature: "A7",
  tier: "T2",
  title: "Corrupt PDF without %PDF- header is refused before mkdir",
  fn: () =>
    withSandbox("a7-t2-04", async (dir) => {
      const badPdf = join(dir, "forged.pdf")
      writeFileSync(badPdf, "NOT A PDF FILE")
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a7b4"
      const res = await h.tools.teamwork_document_triage.execute(
        { sessionId: runId, document: { path: badPdf, format: "pdf" }, skipInterview: true },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:"), res.content)
      assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId)), false)
    }),
})

addCase({
  id: "A7-T2-05",
  milestone: "M4",
  feature: "A7",
  tier: "T2",
  title: "Markdown document review succeeds even when python3 lacks pypdfium2/Pillow",
  fn: () =>
    withSandbox("a7-t2-05", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "python3", `process.exit(1);`)
      const mdPath = join(dir, "spec.md")
      writeFileSync(mdPath, "# Architecture\n\nSection 1 details.\n")
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-a7b5"
        const res = await h.tools.teamwork_document_triage.execute(
          { sessionId: runId, document: { path: mdPath, format: "markdown" }, skipInterview: true },
          { sessionID: "ses_sentinel" },
        )
        assert.ok(!String(res.content).startsWith("refused:"), res.content)
      })
    }),
})

// --- A8 Boundaries ---
addCase({
  id: "A8-T2-01",
  milestone: "M4",
  feature: "A8",
  tier: "T2",
  title: "victory-auditor.md forbids claim-only PASS and mandates Phase C independent test diff",
  fn: () => {
    const va = readAgentPrompt("victory-auditor.md")
    assert.match(va, /claim-only/i)
    assert.match(va, /PHASE C[\s\S]*INDEPENDENT TEST EXECUTION/i)
  },
})

addCase({
  id: "A8-T2-02",
  milestone: "M4",
  feature: "A8",
  tier: "T2",
  title: "teamwork_victory_audit rejects met: true with empty evidence",
  fn: () =>
    withSandbox("a8-t2-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a8b2"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", requirements: [{ id: "R1", text: "Fix" }], skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const res = await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "   " }] },
        { sessionID: "ses_victory" },
      )
      assert.ok(String(res.content).startsWith("refused:"), res.content)
    }),
})

addCase({
  id: "A8-T2-03",
  milestone: "M4",
  feature: "A8",
  tier: "T2",
  title: "teamwork_victory_audit rejects duplicate and unknown requirement ids",
  fn: () =>
    withSandbox("a8-t2-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a8b3"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", requirements: [{ id: "R1", text: "Fix" }], skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const dup = await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "a" }, { id: "R1", met: true, evidence: "b" }] },
        { sessionID: "ses_victory" },
      )
      assert.ok(String(dup.content).startsWith("refused:"))
      const unk = await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R99", met: true, evidence: "a" }] },
        { sessionID: "ses_victory" },
      )
      assert.ok(String(unk.content).startsWith("refused:"))
    }),
})

addCase({
  id: "A8-T2-04",
  milestone: "M4",
  feature: "A8",
  tier: "T2",
  title: "teamwork_victory_audit refuses non-victory-auditor caller (team/worker, team/sentinel)",
  fn: () =>
    withSandbox("a8-t2-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a8b4"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", requirements: [{ id: "R1", text: "Fix" }], skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      for (const sid of ["ses_worker", "ses_sentinel"]) {
        const res = await h.tools.teamwork_victory_audit.execute(
          { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "ok" }] },
          { sessionID: sid },
        )
        assert.ok(String(res.content).startsWith("refused:"), `${sid} must be refused`)
      }
    }),
})

addCase({
  id: "A8-T2-05",
  milestone: "M4",
  feature: "A8",
  tier: "T2",
  title: "VICTORY CONFIRMED is write-once and refuses second overwrite",
  fn: () =>
    withSandbox("a8-t2-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a8b5"
      await setupCodingRunToPass(h.tools, dir, runId, { skipInterview: true })
      const second = await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY REJECTED", requirements: [{ id: "R1", met: false, evidence: "flip" }] },
        { sessionID: "ses_victory" },
      )
      assert.ok(String(second.content).startsWith("refused:"), second.content)
    }),
})

// --- A9 Boundaries ---
addCase({
  id: "A9-T2-01",
  milestone: "M3",
  feature: "A9",
  tier: "T2",
  title: "OPENCODE_TEAMWORK_DISABLED='true' disables tool, command, and hook registration",
  fn: () =>
    withSandbox("a9-t2-01", async (dir) => {
      await withEnv({ OPENCODE_TEAMWORK_DISABLED: "true" }, async () => {
        const h = await makeHarness(dir, { viaSetup: true })
        assert.equal(Object.keys(h.tools).length, 0)
        assert.equal(Object.keys(h.commands).length, 0)
        assert.equal(Object.keys(h.permissionHooks).length, 0)
      })
    }),
})

addCase({
  id: "A9-T2-02",
  milestone: "M3",
  feature: "A9",
  tier: "T2",
  title: "OPENCODE_TEAMWORK_DISABLED='0' and 'false' keep plugin enabled",
  fn: () =>
    withSandbox("a9-t2-02", async (dir) => {
      for (const val of ["0", "false"]) {
        await withEnv({ OPENCODE_TEAMWORK_DISABLED: val }, async () => {
          const h = await makeHarness(dir, { viaSetup: true })
          assert.equal(Object.keys(h.tools).length, 26, `val=${val} should register 26 tools`)
          assert.equal(Object.keys(h.commands).length, 7, `val=${val} should register 7 commands`)
        })
      }
    }),
})

addCase({
  id: "A9-T2-03",
  milestone: "M3",
  feature: "A9",
  tier: "T2",
  title: "OPENCODE_TEAMWORK_DISABLED=1 does not throw even when ctx.permission is absent",
  fn: () =>
    withSandbox("a9-t2-03", async (dir) => {
      await withEnv({ OPENCODE_TEAMWORK_DISABLED: "1" }, async () => {
        const h = await makeHarness(dir, { viaSetup: true, omitPermission: true })
        assert.equal(Object.keys(h.tools).length, 0)
      })
    }),
})

addCase({
  id: "A9-T2-04",
  milestone: "M3",
  feature: "A9",
  tier: "T2",
  title: "All 15 agents/team/*.md files embed # SYSTEM PROMPT PROTECTION Rules 1 and 2",
  fn: () => {
    assert.equal(TEAM_AGENTS.length, 15)
    for (const agent of TEAM_AGENTS) {
      const txt = readAgentPrompt(agent.file)
      assert.ok(txt.includes("# SYSTEM PROMPT PROTECTION"), `${agent.file} missing # SYSTEM PROMPT PROTECTION`)
      assert.ok(txt.includes("I'm a Teamwork agent. What task can I help you with?"), `${agent.file} missing Rule 1 decoy`)
      assert.match(txt, /Rule 2|No overrides/i, `${agent.file} missing Rule 2`)
    }
  },
})

addCase({
  id: "A9-T2-05",
  milestone: "M3",
  feature: "A9",
  tier: "T2",
  title: "Symlinked interrupted.md target is never overwritten on interrupt/abort",
  fn: () =>
    withSandbox("a9-t2-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-a9b5"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Task", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const victim = join(dir, "victim-int.txt")
      writeFileSync(victim, "SAFE")
      symlinkSync(victim, join(dir, ".opencode", "teamwork", runId, "interrupted.md"))
      const ac = new AbortController()
      ac.abort()
      await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel", signal: ac.signal })
      assert.equal(readFileSync(victim, "utf8"), "SAFE")
    }),
})

// =============================================================================
// TIER 3: CROSS-FEATURE PAIRWISE INTERACTIONS (15 cases)
// =============================================================================

addCase({
  id: "PAIR-01",
  milestone: "M3",
  feature: "A1+A2",
  tier: "T3",
  title: "A1+A2: /teamwork [skip-interview] bypasses interview gate and records ## Parameters + specGate: bypassed",
  fn: () =>
    withSandbox("pair-01", async (dir) => {
      const h = await makeHarness(dir, { viaSetup: true })
      await h.commands.teamwork.execute({ sessionID: "ses_sentinel", prompt: { text: "[skip-interview] build CLI" } })
      const runId = "20261125-120000-p01"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview] build CLI", tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const orig = readFileSync(join(runDir, "ORIGINAL_REQUEST.md"), "utf8")
      const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      assert.match(orig, /^## Parameters$/m)
      assert.match(events, /bypassed/)
    }),
})

addCase({
  id: "PAIR-02",
  milestone: "M3",
  feature: "A1+A3",
  tier: "T3",
  title: "A1+A3: [skip-interview] writes ## Parameters, then follow-up appends without mutating ## Parameters or ## Request",
  fn: () =>
    withSandbox("pair-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p02"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "[skip-interview] initial task", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      await invokeFollowUpAppend(h.tools, runId, "follow-up detail", { sessionID: "ses_sentinel" })
      const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(orig, /^## Parameters$/m)
      assert.ok(orig.includes("initial task"))
      assert.ok(orig.includes("follow-up detail"))
    }),
})

addCase({
  id: "PAIR-03",
  milestone: "M1",
  feature: "A1+M1.3",
  tier: "T3",
  title: "A1+M1.3: trustLevel human-approved refuses skipInterview without signed approval, and approval-driver rejects bad runId",
  fn: () =>
    withSandbox("pair-03", async (dir) => {
      const storage = join(dir, "storage.json")
      const bad = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId: "../bad", draft: "# Spec" })],
        { encoding: "utf8" },
      )
      assert.notEqual(bad.status, 0)
      const h = await makeHarness(dir)
      const res = await h.tools.teamwork_plan.execute(
        { sessionId: "20261125-120000-p03", topology: "small-focused", trustLevel: "human-approved", skipInterview: true, tasks: [{ id: "t1" }] },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(String(res.content).startsWith("refused:"))
    }),
})

addCase({
  id: "PAIR-04",
  milestone: "M3",
  feature: "A3+A8",
  tier: "T3",
  title: "A3+A8: Follow-up append after verify/victory.json invalidates stale VICTORY CONFIRMED",
  fn: () =>
    withSandbox("pair-04", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p04"
      await setupCodingRunToPass(h.tools, dir, runId, { skipInterview: true })
      await invokeFollowUpAppend(h.tools, runId, "Changed scope after victory", { sessionID: "ses_sentinel" })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.notEqual(fv.status, "PASS", "final_verify must not PASS with stale victory after follow-up append")
    }),
})

addCase({
  id: "PAIR-05",
  milestone: "M4",
  feature: "A4+A8",
  tier: "T3",
  title: "A4+A8: small-focused passes on round 3, then 3-phase Victory Audit + handoff passes final_verify",
  fn: () =>
    withSandbox("pair-05", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p05"
      await h.tools.teamwork_plan.execute(
        {
          sessionId: runId,
          topology: "small-focused",
          request: "Multi-round fix",
          requirements: [{ id: "R1", text: "Multi-round fix" }],
          skipInterview: true,
          tasks: [{ id: "t1" }],
        },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        const f = await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: `fail-${r}` }, { sessionID: "ses_sentinel" })
        assert.equal(f.status, "verified_fail", `small-focused round ${r} must not block early: ${f.content}`)
      }
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: 3 }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "t1", "Fixed on round 3"), { sessionID: "ses_worker" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_report.execute(makePassReportInput(runId, "t1"), { sessionID: "ses_verifier" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "t1", "Round 3 PASS"), { sessionID: "ses_verifier" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_pass", verification: { status: "PASS" } }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_security_audit.execute({ sessionId: runId, status: "PASS", findings: [] }, { sessionID: "ses_auditor" })
      await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "R3 pass" }], summary: makeThreePhaseVictorySummary() },
        { sessionID: "ses_victory" },
      )
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, undefined, "Victory"), { sessionID: "ses_victory" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, undefined, "Done"), { sessionID: "ses_sentinel" })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
    }),
})

addCase({
  id: "PAIR-06",
  milestone: "M4",
  feature: "A4+A5",
  tier: "T3",
  title: "A4+A5: small-focused hitting 2 consecutive identical failures triggers DEAD_ENDS.md while preserving feedbackLog",
  fn: () =>
    withSandbox("pair-06", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p06"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "small-focused", request: "Fix", skipInterview: true, tasks: [{ id: "t1", maxRounds: 5 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Repeated parse error" }, { sessionID: "ses_sentinel" })
      }
      const runDir = join(dir, ".opencode", "teamwork", runId)
      const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
      assert.equal(state.tasks.t1.feedbackLog.length, 2)
      assert.equal(existsSync(join(runDir, "DEAD_ENDS.md")), true)
    }),
})

addCase({
  id: "PAIR-07",
  milestone: "M4",
  feature: "A5+A6",
  tier: "T3",
  title: "A5+A6: distributed-coding strict wave writes GATE_STATUS.md + verify/{challenge,audit}-*.json and passes final_verify",
  fn: () =>
    withSandbox("pair-07", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p07"
      await setupCodingRunToPass(h.tools, dir, runId, { topology: "distributed-coding", verification: "strict", skipInterview: true })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
      const runDir = join(dir, ".opencode", "teamwork", runId)
      assert.equal(existsSync(join(runDir, "GATE_STATUS.md")), true)
      assert.equal(existsSync(join(runDir, "verify", "challenge-t1.json")), true)
      assert.equal(existsSync(join(runDir, "verify", "audit-t1.json")), true)
    }),
})

addCase({
  id: "PAIR-08",
  milestone: "M4",
  feature: "A6+A9",
  tier: "T3",
  title: "A6+A9: OPENCODE_TEAMWORK_DISABLED=0 enforces updated falsifier/verifier READ_ONLY_ACTIONS",
  fn: () =>
    withSandbox("pair-08", async (dir) => {
      await withEnv({ OPENCODE_TEAMWORK_DISABLED: "0" }, async () => {
        const h = await makeHarness(dir, { viaSetup: true })
        const evF = { agent: "team/falsifier", action: "shell", effect: "allow" }
        h.permissionHooks.evaluate(evF)
        assert.notEqual(evF.effect, "deny")
        const evV = { agent: "team/verifier", action: "edit", effect: "allow" }
        h.permissionHooks.evaluate(evV)
        assert.equal(evV.effect, "deny")
      })
    }),
})

addCase({
  id: "PAIR-09",
  milestone: "M4",
  feature: "A7+A1",
  tier: "T3",
  title: "A7+A1: document-review [skip-interview] on unreadable PDF writes PREREQUISITES.md before mkdir and creates no ORIGINAL_REQUEST.md",
  fn: () =>
    withSandbox("pair-09", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "python3", `process.exit(1);`)
      const pdf = join(dir, "unreadable.pdf")
      writeFileSync(pdf, makeUnreadableImagePdfBuffer())
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-p09"
        await h.tools.teamwork_document_triage.execute(
          { sessionId: runId, request: "[skip-interview] review this pdf", document: { path: pdf, format: "pdf" }, skipInterview: true },
          { sessionID: "ses_sentinel" },
        )
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true)
        assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md")), false)
      })
    }),
})

addCase({
  id: "PAIR-10",
  milestone: "M4",
  feature: "A7+A8",
  tier: "T3",
  title: "A7+A8: document-review PDF completes document_record, victory_audit, and final_verify when extracted cleanly",
  fn: () =>
    withSandbox("pair-10", async (dir) => {
      const pdf = join(dir, "clean.pdf")
      writeFileSync(pdf, makePdfBuffer("Section 1: Complete specification details."))
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p10"
      const tri = await h.tools.teamwork_document_triage.execute(
        {
          sessionId: runId,
          request: "Review this document",
          document: { path: pdf, format: "pdf" },
          skipInterview: true,
        },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(tri.content).startsWith("refused:"), tri.content)
      const manifest = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "document-review", "manifest.json"), "utf8"))
      for (const seg of manifest.segments) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: seg.id, status: "worker_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_document_record.execute(
          { sessionId: runId, stage: "segment_report", segmentId: seg.id, summary: `Reviewed ${seg.id}` },
          { sessionID: "ses_seg" },
        )
        await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, seg.id, "Segment reviewed"), { sessionID: "ses_seg" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: seg.id, status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: seg.id, status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_report.execute(makePassReportInput(runId, seg.id), { sessionID: "ses_verifier" })
        await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, seg.id, "Verified"), { sessionID: "ses_verifier" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: seg.id, status: "verified_pass" }, { sessionID: "ses_sentinel" })
      }
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "doc-synthesis", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_document_record.execute(
        { sessionId: runId, stage: "final_report", summary: "Final document critique" },
        { sessionID: "ses_synth" },
      )
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "doc-synthesis", "Synthesized"), { sessionID: "ses_synth" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "doc-synthesis", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "doc-synthesis", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_report.execute(makePassReportInput(runId, "doc-synthesis"), { sessionID: "ses_verifier" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "doc-synthesis", "Verified"), { sessionID: "ses_verifier" })
      await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "doc-synthesis", status: "verified_pass" }, { sessionID: "ses_sentinel" })
      await h.tools.teamwork_security_audit.execute({ sessionId: runId, status: "PASS", findings: [] }, { sessionID: "ses_auditor" })
      await h.tools.teamwork_victory_audit.execute(
        { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "DOCUMENT_REVIEW_REPORT.md" }], summary: makeThreePhaseVictorySummary() },
        { sessionID: "ses_victory" },
      )
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, undefined, "Victory"), { sessionID: "ses_victory" })
      await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, undefined, "Done"), { sessionID: "ses_sentinel" })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
    }),
})

addCase({
  id: "PAIR-11",
  milestone: "M1",
  feature: "M1.1+M1.4",
  tier: "T3",
  title: "M1.1+M1.4: OPENCODE_CHANNEL=nightly aligns teamwork_cost and collectSecurityReport on nightly DB & service",
  fn: () =>
    withSandbox("pair-11", async (dir) => {
      const xdgData = join(dir, "xdg-data")
      const xdgState = join(dir, "xdg-state")
      const dbPath = join(xdgData, "opencode", "opencode-nightly.db")
      await createSessionDb(dbPath, [["ses_sentinel", null, "team/sentinel", 0.42, 0, 0, 0, 0, 0]])
      chmodSync(dbPath, 0o600)
      mkdirSync(join(xdgState, "opencode"), { recursive: true })
      writeFileSync(join(xdgState, "opencode", "service-nightly.json"), JSON.stringify({ url: "http://169.254.169.254/bad" }))
      await withEnv({ HOME: dir, XDG_DATA_HOME: xdgData, XDG_STATE_HOME: xdgState, OPENCODE_CHANNEL: "nightly", OPENCODE_DB: undefined }, async () => {
        const h = await makeHarness(dir, { channel: "nightly" })
        const runId = "20261125-120000-p11"
        await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
        const cost = await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
        assert.ok(cost.content.includes("opencode session tree"), cost.content)
        const sec = collectSecurityReport(
          securityBaseOpts(dir, { env: { XDG_DATA_HOME: xdgData, OPENCODE_CHANNEL: "nightly", OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: "k" } }),
        )
        const dbCheck = sec.checks.find((c) => c.name === "db_mode")
        assert.equal(dbCheck.status, "pass")
        assert.ok(dbCheck.message.includes("opencode-nightly.db"), dbCheck.message)
      })
    }),
})

addCase({
  id: "PAIR-12",
  milestone: "M1",
  feature: "M1.1+M1.2",
  tier: "T3",
  title: "M1.1+M1.2: doctor --security --json reports 0644 OPENCODE_DB and verifyRun evaluates requireHandoffs cleanly",
  fn: () =>
    withSandbox("pair-12", async (dir) => {
      const dbFile = join(dir, "pair12.db")
      writeFileSync(dbFile, "db")
      chmodSync(dbFile, 0o644)
      const cfg = join(dir, "cfg")
      mkdirSync(cfg, { recursive: true })
      const doc = spawnSync(process.execPath, [CLI_PATH, "doctor", "--security", "--json", "--config-dir", cfg], {
        encoding: "utf8",
        env: { ...process.env, OPENCODE_DB: dbFile },
      })
      const parsed = JSON.parse(doc.stdout)
      const dbCheck = parsed.security.checks.find((c) => c.name === "db_mode")
      assert.equal(dbCheck.status, "fail")
      assert.ok(dbCheck.message.includes(dbFile), dbCheck.message)

      const h = await makeHarness(dir)
      const runId = "20261125-120000-p12"
      await setupCodingRunToPass(h.tools, dir, runId, { requireHandoffs: "required", victoryAudit: "skip", victorySkipReason: "fixture" })
      await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      const vr = await verifyRun({ runDir: join(dir, ".opencode", "teamwork", runId), allowUnsigned: true })
      assert.equal(vr.reasons.some((r) => /HANDOFF_/.test(r)), false, vr.reasons.join("; "))
    }),
})

addCase({
  id: "PAIR-13",
  milestone: "M3",
  feature: "A2+A9",
  tier: "T3",
  title: "A2+A9: All 15 agents pass lint-prompts.mjs, test-catalog.mjs, AND # SYSTEM PROMPT PROTECTION",
  fn: () => {
    const pLint = spawnSync(process.execPath, [PROMPT_LINT_PATH], { encoding: "utf8" })
    assert.equal(pLint.status, 0, pLint.stderr || pLint.stdout)
    const pCat = spawnSync(process.execPath, [CATALOG_TEST_PATH], { encoding: "utf8" })
    assert.equal(pCat.status, 0, pCat.stderr || pCat.stdout)
    for (const agent of TEAM_AGENTS) {
      assert.ok(readAgentPrompt(agent.file).includes("# SYSTEM PROMPT PROTECTION"), `${agent.file} missing protection`)
    }
  },
})

addCase({
  id: "PAIR-14",
  milestone: "M4",
  feature: "A8+lint",
  tier: "T3",
  title: "A8+lint: worker.md teamwork_handoff alignment + teamwork_handoff + final_verify PASS",
  fn: () =>
    withSandbox("pair-14", async (dir) => {
      const worker = readAgentPrompt("worker.md")
      assert.equal(/write\s+`?handoff\.md`?/i.test(worker), false, "worker.md line 87 regression")
      const h = await makeHarness(dir)
      const runId = "20261125-120000-p14"
      await setupCodingRunToPass(h.tools, dir, runId, { requireHandoffs: "required" })
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
    }),
})

addCase({
  id: "PAIR-15",
  milestone: "M4",
  feature: "A7+LEMMA",
  tier: "T3",
  title: "A7+LEMMA: Failing leap doctor causes teamwork_plan (lemmaMode: true) to refuse pre-mkdir and write PREREQUISITES.md",
  fn: () =>
    withSandbox("pair-15", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "lean", `console.log("Lean 4.14.0"); process.exit(0);`)
      writeStubBin(binDir, "lake", `console.log("lake 5.0.0"); process.exit(0);`)
      writeStubBin(
        binDir,
        "leap",
        `
const a = process.argv.slice(2);
if (a.includes("doctor")) { console.error("leap doctor outage"); process.exit(1); }
console.log("leap 1.0.0"); process.exit(0);
`,
      )
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const runId = "20261125-120000-p15"
        const res = await h.tools.teamwork_plan.execute(
          {
            sessionId: runId,
            topology: "proof",
            lemmaMode: true,
            route: "lemma",
            request: "Prove theorem in Lean 4",
            skipInterview: true,
            tasks: [{ id: "L1" }],
          },
          { sessionID: "ses_sentinel" },
        )
        assert.ok(String(res.content).startsWith("refused:"), res.content)
        assert.equal(existsSync(join(dir, ".opencode", "teamwork", runId)), false)
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true)
      })
    }),
})

// =============================================================================
// TIER 4: REAL-WORLD END-TO-END SCENARIOS (7 scenarios)
// =============================================================================

addCase({
  id: "E2E-01",
  milestone: "M4",
  feature: "A1+A4+A8+M1.2",
  tier: "T4",
  title: "Scenario 1: [skip-interview] fast-track small-focused multi-round fix -> 3-phase Victory Audit -> CLI verify exit 0",
  fn: () =>
    withSandbox("e2e-01", async (dir) => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64url")
      const privB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
      await withEnv(
        {
          OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: pubB64,
          OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: privB64,
          OPENCODE_TEAMWORK_ED25519_KEY_ID: "e2e_k1",
        },
        async () => {
          const h = await makeHarness(dir, { viaSetup: true })
          await h.commands.teamwork.execute({
            sessionID: "ses_sentinel",
            prompt: { text: "[skip-interview] fix off-by-one in parser" },
          })
          const runId = "20261125-120000-e2e01"
          const plan = await h.tools.teamwork_plan.execute(
            {
              sessionId: runId,
              topology: "small-focused",
              request: "[skip-interview] fix off-by-one in parser",
              trustLevel: "external-signer",
              requirements: [{ id: "R1", text: "Fix off-by-one in parser" }],
              tasks: [{ id: "fix-1" }],
            },
            { sessionID: "ses_sentinel" },
          )
          assert.ok(!String(plan.content).startsWith("refused:"), plan.content)
          const orig = readFileSync(join(dir, ".opencode", "teamwork", runId, "ORIGINAL_REQUEST.md"), "utf8")
          assert.match(orig, /^## Parameters$/m)

          // Round 1 FAIL
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "worker_active", round: 1 }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "worker_done" }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
          const r1Fail = await h.tools.teamwork_task_update.execute(
            { sessionId: runId, taskId: "fix-1", status: "verified_fail", feedback: "Boundary length off by 1" },
            { sessionID: "ses_sentinel" },
          )
          assert.equal(r1Fail.status, "verified_fail", r1Fail.content)

          // Round 2 PASS
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "worker_active", round: 2 }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "fix-1", "Fixed parser bound"), { sessionID: "ses_worker" })
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "worker_done" }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
          await h.tools.teamwork_report.execute(makePassReportInput(runId, "fix-1"), { sessionID: "ses_verifier" })
          await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, "fix-1", "Verified fix"), { sessionID: "ses_verifier" })
          await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "fix-1", status: "verified_pass" }, { sessionID: "ses_sentinel" })

          await h.tools.teamwork_security_audit.execute({ sessionId: runId, status: "PASS", findings: [] }, { sessionID: "ses_auditor" })
          await h.tools.teamwork_victory_audit.execute(
            { sessionId: runId, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "Parser tests PASS" }], summary: makeThreePhaseVictorySummary() },
            { sessionID: "ses_victory" },
          )
          await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, undefined, "Victory confirmed"), { sessionID: "ses_victory" })
          await h.tools.teamwork_handoff.execute(makeHandoffInput(runId, undefined, "Run finished"), { sessionID: "ses_sentinel" })
          const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
          assert.equal(fv.status, "PASS", fv.content)

          const cli = spawnSync(
            process.execPath,
            [
              CLI_PATH,
              "verify",
              "--run-dir",
              join(dir, ".opencode", "teamwork", runId),
              "--public-key",
              pubB64,
              "--json",
            ],
            { encoding: "utf8" },
          )
          assert.equal(cli.status, 0, cli.stderr || cli.stdout)
        },
      )
    }),
})

addCase({
  id: "E2E-02",
  milestone: "M3",
  feature: "A2+A3+A5+A6+A8",
  tier: "T4",
  title: "Scenario 2: Interview-gated distributed-coding with follow-up append and strict verification wave",
  fn: () =>
    withSandbox("e2e-02", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-e2e02"
      const runDir = join(dir, ".opencode", "teamwork", runId)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, "prompt_draft.md"),
        "# Teamwork Spec: API\n\n**Integrity mode:** demo\nThe team must NOT: copy OSS core logic.\n",
      )
      await setupCodingRunToPass(h.tools, dir, runId, {
        topology: "distributed-coding",
        verification: "strict",
        integrityMode: "demo",
      })
      await invokeFollowUpAppend(h.tools, runId, "Confirm strict wave GATE_STATUS.md.", { sessionID: "ses_sentinel" })
      const orig = readFileSync(join(runDir, "ORIGINAL_REQUEST.md"), "utf8")
      assert.match(orig, /- Integrity mode: demo/)
      assert.ok(orig.includes("Confirm strict wave GATE_STATUS.md."))
      // Re-record victory after follow-up or check GATE_STATUS.md
      const fv = await h.tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: "ses_verifier" })
      assert.ok(existsSync(join(runDir, "GATE_STATUS.md")) || fv.status !== "PASS")
    }),
})

addCase({
  id: "E2E-03",
  milestone: "M4",
  feature: "A4+A5+A8+A9",
  tier: "T4",
  title: "Scenario 3: Oscillation Guard (DEAD_ENDS.md) & terminal non-victory stop (interrupted.md, no victory audit)",
  fn: () =>
    withSandbox("e2e-03", async (dir) => {
      const h = await makeHarness(dir)
      const runId = "20261125-120000-e2e03"
      await h.tools.teamwork_plan.execute(
        { sessionId: runId, topology: "distributed-coding", request: "Complex task", skipInterview: true, tasks: [{ id: "t1", maxRounds: 2 }] },
        { sessionID: "ses_sentinel" },
      )
      for (const r of [1, 2]) {
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_active", round: r }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute({ sessionId: runId, taskId: "t1", status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h.tools.teamwork_task_update.execute(
          { sessionId: runId, taskId: "t1", status: "verified_fail", feedback: "Identical failure loop" },
          { sessionID: "ses_sentinel" },
        )
      }
      const runDir = join(dir, ".opencode", "teamwork", runId)
      assert.equal(existsSync(join(runDir, "DEAD_ENDS.md")), true, "DEAD_ENDS.md must exist after 2 identical failures")
      const next = await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel" })
      assert.equal(next.status, "DEADLOCK")
      const ac = new AbortController()
      ac.abort()
      await h.tools.teamwork_next.execute({ sessionId: runId }, { sessionID: "ses_sentinel", signal: ac.signal })
      assert.equal(existsSync(join(runDir, "verify", "victory.json")), false, "non-victory stop must NOT run victory audit")
    }),
})

addCase({
  id: "E2E-04",
  milestone: "M4",
  feature: "A7+M1.4",
  tier: "T4",
  title: "Scenario 4: PDF Document Review pre-flight MISSING (PREREQUISITES.md) vs valid PDF full workflow PASS",
  fn: () =>
    withSandbox("e2e-04", async (dir) => {
      const binDir = join(dir, "bin")
      writeStubBin(binDir, "python3", `process.exit(1);`)
      const imgPdf = join(dir, "scan.pdf")
      writeFileSync(imgPdf, makeUnreadableImagePdfBuffer())
      await withEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const failRun = "20261125-120000-e2e04a"
        await h.tools.teamwork_document_triage.execute(
          { sessionId: failRun, document: { path: imgPdf, format: "pdf" }, skipInterview: true },
          { sessionID: "ses_sentinel" },
        )
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true)
        assert.equal(existsSync(join(dir, ".opencode", "teamwork", failRun)), false)
      })

      const goodPdf = join(dir, "good.pdf")
      writeFileSync(goodPdf, makePdfBuffer("Complete technical specification for review."))
      const h2 = await makeHarness(dir)
      const okRun = "20261125-120000-e2e04b"
      const tri = await h2.tools.teamwork_document_triage.execute(
        { sessionId: okRun, request: "Critique good.pdf", document: { path: goodPdf, format: "pdf" }, skipInterview: true },
        { sessionID: "ses_sentinel" },
      )
      assert.ok(!String(tri.content).startsWith("refused:"), tri.content)
      const manifest = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", okRun, "document-review", "manifest.json"), "utf8"))
      for (const seg of manifest.segments) {
        await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: seg.id, status: "worker_active" }, { sessionID: "ses_sentinel" })
        await h2.tools.teamwork_document_record.execute({ sessionId: okRun, stage: "segment_report", segmentId: seg.id, summary: "OK" }, { sessionID: "ses_seg" })
        await h2.tools.teamwork_handoff.execute(makeHandoffInput(okRun, seg.id, "OK"), { sessionID: "ses_seg" })
        await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: seg.id, status: "worker_done" }, { sessionID: "ses_sentinel" })
        await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: seg.id, status: "verifier_active" }, { sessionID: "ses_sentinel" })
        await h2.tools.teamwork_report.execute(makePassReportInput(okRun, seg.id), { sessionID: "ses_verifier" })
        await h2.tools.teamwork_handoff.execute(makeHandoffInput(okRun, seg.id, "OK"), { sessionID: "ses_verifier" })
        await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: seg.id, status: "verified_pass" }, { sessionID: "ses_sentinel" })
      }
      await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: "doc-synthesis", status: "worker_active" }, { sessionID: "ses_sentinel" })
      await h2.tools.teamwork_document_record.execute({ sessionId: okRun, stage: "final_report", summary: "Final" }, { sessionID: "ses_synth" })
      await h2.tools.teamwork_handoff.execute(makeHandoffInput(okRun, "doc-synthesis", "OK"), { sessionID: "ses_synth" })
      await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: "doc-synthesis", status: "worker_done" }, { sessionID: "ses_sentinel" })
      await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: "doc-synthesis", status: "verifier_active" }, { sessionID: "ses_sentinel" })
      await h2.tools.teamwork_report.execute(makePassReportInput(okRun, "doc-synthesis"), { sessionID: "ses_verifier" })
      await h2.tools.teamwork_handoff.execute(makeHandoffInput(okRun, "doc-synthesis", "OK"), { sessionID: "ses_verifier" })
      await h2.tools.teamwork_task_update.execute({ sessionId: okRun, taskId: "doc-synthesis", status: "verified_pass" }, { sessionID: "ses_sentinel" })
      await h2.tools.teamwork_security_audit.execute({ sessionId: okRun, status: "PASS", findings: [] }, { sessionID: "ses_auditor" })
      await h2.tools.teamwork_victory_audit.execute(
        { sessionId: okRun, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "Done" }], summary: makeThreePhaseVictorySummary() },
        { sessionID: "ses_victory" },
      )
      await h2.tools.teamwork_handoff.execute(makeHandoffInput(okRun, undefined, "Victory"), { sessionID: "ses_victory" })
      await h2.tools.teamwork_handoff.execute(makeHandoffInput(okRun, undefined, "Done"), { sessionID: "ses_sentinel" })
      const fv = await h2.tools.teamwork_final_verify.execute({ sessionId: okRun }, { sessionID: "ses_verifier" })
      assert.equal(fv.status, "PASS", fv.content)
    }),
})

addCase({
  id: "E2E-05",
  milestone: "M4",
  feature: "A7+A1",
  tier: "T4",
  title: "Scenario 5: LEMMA pre-flight with stubbed lean/lake/leap (doctor fail vs doctor pass)",
  fn: () =>
    withSandbox("e2e-05", async (dir) => {
      const binFail = join(dir, "bin-fail")
      writeStubBin(binFail, "lean", `console.log("Lean 4.14.0"); process.exit(0);`)
      writeStubBin(binFail, "lake", `console.log("lake 5.0.0"); process.exit(0);`)
      writeStubBin(binFail, "leap", `if (process.argv.includes("doctor")) process.exit(1); console.log("leap 1.0"); process.exit(0);`)
      await withEnv({ PATH: `${binFail}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const probe = await h.tools.teamwork_lemma_probe.execute({}, { sessionID: "ses_sentinel" })
        assert.equal(probe.ready, false)
        assert.equal(probe.status, "OUTAGE")
        const plan = await h.tools.teamwork_plan.execute(
          { sessionId: "20261125-120000-e2e05a", topology: "proof", lemmaMode: true, route: "lemma", request: "Prove x=x in Lean 4", skipInterview: true, tasks: [{ id: "L1" }] },
          { sessionID: "ses_sentinel" },
        )
        assert.ok(String(plan.content).startsWith("refused:"))
        assert.equal(existsSync(join(dir, "PREREQUISITES.md")), true)
      })

      const binOk = join(dir, "bin-ok")
      writeStubBin(binOk, "lean", `console.log("Lean 4.14.0"); process.exit(0);`)
      writeStubBin(binOk, "lake", `console.log("lake 5.0.0"); process.exit(0);`)
      writeStubBin(binOk, "leap", `console.log("leap ok"); process.exit(0);`)
      await withEnv({ PATH: `${binOk}:${process.env.PATH ?? ""}` }, async () => {
        const h = await makeHarness(dir)
        const probe = await h.tools.teamwork_lemma_probe.execute({}, { sessionID: "ses_sentinel" })
        assert.equal(probe.ready, true)
        const plan = await h.tools.teamwork_plan.execute(
          { sessionId: "20261125-120000-e2e05b", topology: "proof", lemmaMode: true, route: "lemma", request: "[skip-interview] Prove x=x in Lean 4", skipInterview: true, tasks: [{ id: "L1" }] },
          { sessionID: "ses_sentinel" },
        )
        assert.ok(!String(plan.content).startsWith("refused:"), plan.content)
      })
    }),
})

addCase({
  id: "E2E-06",
  milestone: "M1",
  feature: "M1.1+M1.2+M1.4",
  tier: "T4",
  title: "Scenario 6: Hardened host channel parity (OPENCODE_CHANNEL=canary DB + service-canary.json + doctor --security)",
  fn: () =>
    withSandbox("e2e-06", async (dir) => {
      const xdgData = join(dir, "xdg-data")
      const xdgState = join(dir, "xdg-state")
      const dbPath = join(xdgData, "opencode", "opencode-canary.db")
      await createSessionDb(dbPath, [
        ["ses_sentinel", null, "team/sentinel", 0.1, 10, 5, 0, 0, 0],
        ["ses_worker", "ses_sentinel", "team/worker", 0.4, 20, 10, 0, 0, 0],
      ])
      chmodSync(dbPath, 0o600)

      await withLoopbackServer((req, res) => {
        res.setHeader("Content-Type", "application/json")
        if (req.url === "/api/session/ses_sentinel") {
          res.end(JSON.stringify({ data: { id: "ses_sentinel", agent: "team/sentinel", cost: 0.1, tokens: {} } }))
          return
        }
        if (req.url?.startsWith("/api/session?")) {
          res.end(JSON.stringify({ data: [{ id: "ses_worker", parentID: "ses_sentinel", agent: "team/worker", cost: 0.4, tokens: {} }] }))
          return
        }
        res.statusCode = 404
        res.end("{}")
      }, async ({ baseUrl }) => {
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        writeFileSync(join(xdgState, "opencode", "service-canary.json"), JSON.stringify({ url: baseUrl, password: "pw" }))
        await withEnv({ HOME: dir, XDG_DATA_HOME: xdgData, XDG_STATE_HOME: xdgState, OPENCODE_CHANNEL: "canary", OPENCODE_DB: undefined }, async () => {
          const h = await makeHarness(dir, { channel: "canary" })
          const runId = "20261125-120000-e2e06"
          await h.tools.teamwork_plan.execute({ sessionId: runId, topology: "small-focused", tasks: [{ id: "t1" }], skipInterview: true }, { sessionID: "ses_sentinel" })
          const cost = await h.tools.teamwork_cost.execute({}, { sessionID: "ses_sentinel" })
          assert.ok(cost.content.includes("opencode session tree"))
          const costs = JSON.parse(readFileSync(join(dir, ".opencode", "teamwork", runId, "costs.json"), "utf8"))
          assert.ok(Math.abs(costs.spentUsd - 0.5) < 1e-6)
        })
      })

      const cfg = join(dir, "cfg")
      mkdirSync(cfg, { recursive: true })
      const doc = spawnSync(process.execPath, [CLI_PATH, "doctor", "--security", "--json", "--config-dir", cfg], {
        encoding: "utf8",
        env: { ...process.env, XDG_DATA_HOME: xdgData, OPENCODE_CHANNEL: "canary", OPENCODE_DB: "" },
      })
      const parsed = JSON.parse(doc.stdout)
      const dbCheck = parsed.security.checks.find((c) => c.name === "db_mode")
      assert.equal(dbCheck.status, "pass", dbCheck.message)
      assert.ok(dbCheck.message.includes("opencode-canary.db"), `doctor must inspect opencode-canary.db, got: ${dbCheck.message}`)
    }),
})

addCase({
  id: "E2E-07",
  milestone: "M3",
  feature: "A9+M1.3",
  tier: "T4",
  title: "Scenario 7: OPENCODE_TEAMWORK_DISABLED=1 disables plugin, then approval-driver completes valid lifecycle while rejecting traversal",
  fn: () =>
    withSandbox("e2e-07", async (dir) => {
      await withEnv({ OPENCODE_TEAMWORK_DISABLED: "1" }, async () => {
        const disabled = await makeHarness(dir, { viaSetup: true })
        assert.equal(Object.keys(disabled.tools).length, 0)
        assert.equal(Object.keys(disabled.commands).length, 0)
      })
      const storage = join(dir, "storage.json")
      const traversal = spawnSync(
        process.execPath,
        [APPROVAL_DRIVER_PATH, JSON.stringify({ root: dir, storage, action: "write-draft", runId: "../pwn", draft: "x" })],
        { encoding: "utf8" },
      )
      assert.notEqual(traversal.status, 0)

      const runId = "20261125-120000-e2e07"
      for (const payload of [
        { root: dir, storage, action: "write-draft", runId, draft: "# Approved Spec\n" },
        { root: dir, storage, action: "plan", runId, trustLevel: "local-hmac" },
        { root: dir, storage, action: "seed", runId },
        { root: dir, storage, action: "final", runId },
      ]) {
        const r = spawnSync(process.execPath, [APPROVAL_DRIVER_PATH, JSON.stringify(payload)], { encoding: "utf8" })
        assert.equal(r.status, 0, r.stderr || r.stdout)
        assert.equal(JSON.parse(r.stdout).ok, true, r.stdout)
      }
    }),
})

// =============================================================================
// RUNNER & SUMMARY
// =============================================================================

async function main() {
  const selected = CASES.filter((c) => {
    if (milestoneFilter !== "all" && c.milestone !== milestoneFilter) return false
    if (tierFilter !== "all" && c.tier !== tierFilter) return false
    return true
  })

  let passed = 0
  let failed = 0
  const failures = []
  const byMilestone = { M1: { pass: 0, fail: 0 }, M3: { pass: 0, fail: 0 }, M4: { pass: 0, fail: 0 } }
  const byTier = { T1: { pass: 0, fail: 0 }, T2: { pass: 0, fail: 0 }, T3: { pass: 0, fail: 0 }, T4: { pass: 0, fail: 0 } }

  for (const c of selected) {
    try {
      await c.fn()
      passed += 1
      byMilestone[c.milestone].pass += 1
      byTier[c.tier].pass += 1
      if (verbose) console.log(`PASS [${c.milestone}][${c.tier}] ${c.id}: ${c.title}`)
    } catch (err) {
      failed += 1
      byMilestone[c.milestone].fail += 1
      byTier[c.tier].fail += 1
      const msg = String(err?.message ?? err).split("\n")[0]
      failures.push({ id: c.id, milestone: c.milestone, tier: c.tier, feature: c.feature, title: c.title, error: msg })
      console.log(`FAIL [${c.milestone}][${c.tier}] ${c.id}: ${c.title} -> ${msg}`)
    }
  }

  console.log("\n=== agy Parity & Regression Summary ===")
  console.log(`Total executed: ${selected.length} (Passed: ${passed}, Failed: ${failed})`)
  console.log(
    `By Tier: T1=${byTier.T1.pass}/${byTier.T1.pass + byTier.T1.fail}, T2=${byTier.T2.pass}/${byTier.T2.pass + byTier.T2.fail}, T3=${byTier.T3.pass}/${byTier.T3.pass + byTier.T3.fail}, T4=${byTier.T4.pass}/${byTier.T4.pass + byTier.T4.fail}`,
  )
  console.log(
    `By Milestone: M1=${byMilestone.M1.pass}/${byMilestone.M1.pass + byMilestone.M1.fail}, M3=${byMilestone.M3.pass}/${byMilestone.M3.pass + byMilestone.M3.fail}, M4=${byMilestone.M4.pass}/${byMilestone.M4.pass + byMilestone.M4.fail}`,
  )

  if (failures.length > 0) {
    console.log(`\nFailed cases (${failures.length}):`)
    for (const f of failures) {
      console.log(`  - ${f.id} [${f.milestone}/${f.tier}/${f.feature}]: ${f.error}`)
    }
  }

  return failed === 0 ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} finally {
  rmSync(PARITY_TMP_ROOT, { recursive: true, force: true })
}
process.exit(exitCode)
