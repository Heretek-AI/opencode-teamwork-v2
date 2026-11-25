#!/usr/bin/env node
// approval-driver.mjs — one turn of the print-mode approval parity harness
//
// Each invocation is a separate process. All state that must survive a turn
// lives on disk: the run directory and a small JSON-backed `ctx.storage` file.
// The driver deliberately has no in-memory approval flag; the plan gate reads
// the approval file from OPENCODE_TEAMWORK_APPROVAL_DIR every time.
//
// Usage: node scripts/approval-driver.mjs '<json>'
//   { root, storage, action: "write-draft"|"plan"|"seed"|"final",
//     runId, draft, trustLevel, ownerUid, tasks, sessionId }
//
// Test-only: `ownerUid` enables the plugin's ownership seam so a single-UID
// host can simulate the different-principal approval directory.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { registerTeamworkTools, setApprovalOwnerUidForTest } from "../plugins/opencode-teamwork/tools.ts"
import { registerTool } from "./tool-registry.mjs"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

const input = JSON.parse(process.argv[2] || "{}")
const root = input.root
const storagePath = input.storage
const runId = input.runId
const ROOT_SESSION = "ses_approval_root"

if (!root || !storagePath || typeof runId !== "string" || !SESSION_ID.test(runId)) {
  console.error("approval-driver: root, storage and a valid runId are required")
  process.exit(2)
}

const teamworkRoot = resolve(root, ".opencode", "teamwork")
const runDir = resolve(teamworkRoot, runId)
const relRunDir = relative(teamworkRoot, runDir)
if (!relRunDir || relRunDir === ".." || relRunDir.startsWith("..") || isAbsolute(relRunDir)) {
  console.error("approval-driver: runId resolves outside teamwork root")
  process.exit(2)
}

// A tiny disk-backed KV store: the plugin's key ring, nonce/key-id pins, and
// approval-consumption record must survive process exit.
function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(storagePath, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(data) {
  mkdirSync(dirname(storagePath), { recursive: true })
  const temp = `${storagePath}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2))
  renameSync(temp, storagePath)
}

const storage = {
  async get(key) {
    return readStore()[key]
  },
  async set(key, value) {
    const data = readStore()
    data[key] = value
    writeStore(data)
  },
}

const AGENTS = {
  [ROOT_SESSION]: "team/sentinel",
  ses_approval_verifier: "team/verifier",
  ses_approval_auditor: "team/security-auditor",
  ses_approval_worker: "team/worker",
}

const session = {
  async get({ sessionID }) {
    const agent = AGENTS[sessionID]
    if (!agent) return undefined
    return sessionID === ROOT_SESSION ? { agent } : { agent, parentID: ROOT_SESSION }
  },
}

const tools = {}
await registerTeamworkTools(
  {
    tool: {
      transform: async (cb) => {
        await cb({ namespace: () => {}, add: (tool) => registerTool(tools, tool) })
      },
    },
    session,
    storage,
  },
  root,
)

if (typeof input.ownerUid === "number") setApprovalOwnerUidForTest(input.ownerUid)

function runFile(name) {
  return resolve(runDir, name)
}

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

try {
  if (input.action === "write-draft") {
    mkdirSync(runDir, { recursive: true }) // NOSONAR (S8707): runId is allowlist-checked and runDir is containment-checked above
    const file = resolve(runDir, "prompt_draft.md") // NOSONAR (S8707): fixed child name under the containment-checked runDir
    if (lstatSync(runDir).isSymbolicLink()) throw new Error("the run directory is a symlink") // NOSONAR (S8707): runDir is containment-checked above
    try {
      if (lstatSync(file).isSymbolicLink()) throw new Error("the draft file is a symlink")
    } catch (err) {
      if (err?.code !== "ENOENT") throw err
    }
    writeFileSync(file, String(input.draft ?? ""), "utf8") // NOSONAR (S8707): runId allowlist plus containment check bound the directory, and the draft entry is refused if it is a symlink
    reply({ ok: true, path: file, bytes: Buffer.byteLength(String(input.draft ?? "")) })
  } else if (input.action === "plan") {
    const res = await tools.teamwork_plan.execute(
      {
        sessionId: runId,
        topology: "iterative-coding",
        request: input.request ?? "Approval parity fixture.",
        trustLevel: input.trustLevel ?? "human-approved",
        victoryAudit: "skip",
        victorySkipReason: "fixture: approval parity harness skips the victory audit",
        requireHandoffs: "skip",
        tasks: (input.tasks ?? ["A1"]).map((id) => ({ id })),
      },
      { sessionID: ROOT_SESSION },
    )
    reply({
      ok: !String(res.content ?? "").startsWith("refused:"),
      content: res.content,
      refused: res.refused ?? null,
      sessionId: res.sessionId ?? null,
      planExists: existsSync(runFile("plan.dag.json")),
      requestExists: existsSync(runFile("ORIGINAL_REQUEST.md")),
    })
  } else if (input.action === "seed") {
    const taskIds = input.tasks ?? ["A1"]
    for (const taskId of taskIds) {
      for (const status of ["worker_active", "worker_done", "verifier_active"]) {
        await tools.teamwork_task_update.execute({ sessionId: runId, taskId, status }, { sessionID: ROOT_SESSION })
      }
      const report = await tools.teamwork_report.execute(
        {
          sessionId: runId,
          taskId,
          status: "PASS",
          summary: `Approval fixture PASS for ${taskId}.`,
          checks: [{ name: "fixture", type: "check", passed: true }],
        },
        { sessionID: "ses_approval_verifier" },
      )
      if (String(report.content ?? "").startsWith("refused:")) throw new Error(`report refused: ${report.content}`)
      const pass = await tools.teamwork_task_update.execute(
        { sessionId: runId, taskId, status: "verified_pass", verification: { status: "PASS" } },
        { sessionID: ROOT_SESSION },
      )
      if (pass.status !== "verified_pass") throw new Error(`verified_pass refused: ${pass.content}`)
    }
    const audit = await tools.teamwork_security_audit.execute(
      { sessionId: runId, status: "PASS", findings: [] },
      { sessionID: "ses_approval_auditor" },
    )
    reply({ ok: true, audit: audit.status ?? null })
  } else if (input.action === "final") {
    const res = await tools.teamwork_final_verify.execute({ sessionId: runId }, { sessionID: ROOT_SESSION })
    reply({ ok: res.status === "PASS", status: res.status, content: res.content, reasons: res.reasons ?? [] })
  } else {
    throw new Error(`unknown action "${input.action}"`)
  }
} catch (err) {
  reply({ ok: false, error: String(err?.message ?? err) })
  process.exit(1)
}
