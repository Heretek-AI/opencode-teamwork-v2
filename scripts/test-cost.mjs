// test-cost — verifies session-tree cost aggregation and the manual addUsd fallback.
//
// Hermeticity: the tree-aggregation assertions run against a synthetic
// OpenCode database created in this test, selected through OPENCODE_DB (the
// same override `packages/cli/src/database-path.ts` honours). This exercises
// the real override path instead of depending on the developer's live database
// and skipping when it is empty.
//
// The fixture tree is root -> child -> grandchild. Spend must reach 1% of the
// plan tool's default $20 budget because the cost tool floors the percentage.

import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { registerTool } from "./tool-registry.mjs"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert"
import { execFileSync } from "node:child_process"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-test-"))
const dbPath = join(testDir, "opencode-test.db")
const ROOT = "ses_cost_root"
const CHILD = "ses_cost_child"
const GRANDCHILD = "ses_cost_grandchild"
const EXPECTED_SPENT = 0.65
const RUN_ID = "20261124-000000-cost-fixture"

let nodeSqlitePromise

function loadNodeSqlite() {
  if (nodeSqlitePromise === undefined) {
    nodeSqlitePromise = import("node:sqlite").catch(() => null)
  }
  return nodeSqlitePromise
}

const SCHEMA = `CREATE TABLE session_v2 (
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

const ROWS = [
  [ROOT, null, "team/sentinel", 0, 0, 0, 0, 0, 0],
  [CHILD, ROOT, "team/worker", 0.3, 80, 40, 2, 4, 1],
  [GRANDCHILD, CHILD, "team/verifier", 0.35, 20, 10, 1, 0, 0],
]

function sqlLiteral(value) {
  if (value === null) return "NULL"
  if (typeof value === "number") return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

async function createFixtureDatabase(file = dbPath, rows = ROWS) {
  const mod = await loadNodeSqlite()
  if (mod && typeof mod.DatabaseSync === "function") {
    const db = new mod.DatabaseSync(file)
    try {
      db.exec(SCHEMA)
      const insert = db.prepare(
        "INSERT INTO session_v2 (id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      for (const row of rows) insert.run(...row)
      return
    } finally {
      db.close()
    }
  }
  // Fallback for Node builds without node:sqlite.
  const statements = [
    SCHEMA,
    ...rows.map(
      (row) =>
        `INSERT INTO session_v2 (id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (${row
          .map(sqlLiteral)
          .join(", ")})`,
    ),
  ]
  execFileSync("sqlite3", [file, statements.join(";\n") + ";"], { encoding: "utf8", timeout: 5000 })
}

// Minimal ctx.storage shim: the plan tool requires a signed baseline (or an
// explicit allowUnsignedLegacy opt-out), and this test exercises cost, not auth.
const costStore = new Map()
const costStorage = {
  get: async (key) => costStore.get(key),
  set: async (key, value) => {
    costStore.set(key, value)
  },
  remove: async (key) => {
    costStore.delete(key)
  },
  scan: async () => ({ entries: [], hasMore: false }),
}

const savedDb = process.env.OPENCODE_DB

try {
  await createFixtureDatabase()
  process.env.OPENCODE_DB = dbPath

  let registeredTools = {}
  const mockCtx = {
    tool: {
      transform: async (cb) => {
        const editor = {
          namespace: () => {},
          add: (tool) => registerTool(registeredTools, tool),
        }
        await cb(editor)
      },
    },
    session: {
      get: async ({ sessionID }) => {
        if (sessionID === ROOT) {
          return {
            agent: "team/sentinel",
            // The DB is the source of truth; this baseline is the plan-time
            // snapshot and must not add spend of its own.
            cost: 0,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          }
        }
        return { agent: "team/sentinel" }
      },
    },
    storage: costStorage,
  }

  await registerTeamworkTools(mockCtx, testDir)

  assert(registeredTools.teamwork_plan, "plan tool must be registered")
  assert(registeredTools.teamwork_cost, "cost tool must be registered")

  // 1. Plan creates the run and records the calling session as its root.
  const planRes = await registeredTools.teamwork_plan.execute(
    {
      sessionId: RUN_ID,
      topology: "small-focused",
      tasks: [{ id: "task-1" }],
      skipInterview: true, // fixture: this test exercises cost aggregation, not the spec presence gate
    },
    { sessionID: ROOT },
  )

  assert(planRes.content.includes("Planned 1 task"), "Plan should succeed")

  // 2. OPENCODE_DB selects the temp database and the recursive tree is summed.
  const costRes = await registeredTools.teamwork_cost.execute({}, { sessionID: ROOT })
  assert(costRes.content.includes("opencode session tree"), "Should report opencode session tree as source")
  assert(costRes.content.includes("spent: $"), "Should report spent amount")
  assert.strictEqual(costRes.pct, Math.floor((EXPECTED_SPENT / 20) * 100), "Percentage must use the complete tree")
  const costs = JSON.parse(readFileSync(join(testDir, ".opencode", "teamwork", RUN_ID, "costs.json"), "utf8"))
  assert.strictEqual(costs.spentUsd, EXPECTED_SPENT, "The whole root/child/grandchild tree must be counted")

  // 3. Second call should not double count.
  const costRes2 = await registeredTools.teamwork_cost.execute({}, { sessionID: ROOT })
  assert.strictEqual(costRes.pct, costRes2.pct, "Percentage should remain identical on immediate re-call")

  // 3b. OPENCODE_DB unset: a non-standard channel uses its own database name
  // (packages/cli/src/database-path.ts databasePath()).
  {
    const xdgData = join(testDir, "xdg-data")
    const channelDb = join(xdgData, "opencode", "opencode-nightly.db")
    mkdirSync(join(xdgData, "opencode"), { recursive: true })
    await createFixtureDatabase(channelDb, [[ROOT, null, "team/sentinel", 0.5, 0, 0, 0, 0, 0]])
    const savedXdgData = process.env.XDG_DATA_HOME
    delete process.env.OPENCODE_DB
    process.env.XDG_DATA_HOME = xdgData
    try {
      const channelTools = {}
      await registerTeamworkTools(
        {
          tool: {
            transform: async (cb) => cb({ namespace: () => {}, add: (tool) => registerTool(channelTools, tool) }),
          },
          session: { get: async () => ({ agent: "team/sentinel", cost: 0, tokens: {} }) },
          app: { channel: "nightly" },
          storage: costStorage,
        },
        testDir,
      )
      const channelRun = "20261124-000000-cost-channel"
      await channelTools.teamwork_plan.execute(
        { sessionId: channelRun, topology: "small-focused", tasks: [{ id: "beta-1" }], skipInterview: true },
        { sessionID: ROOT },
      )
      const channelCost = await channelTools.teamwork_cost.execute({}, { sessionID: ROOT })
      assert(channelCost.content.includes("opencode session tree"), `the channel database must be read: ${channelCost.content}`)
      const channelCosts = JSON.parse(readFileSync(join(testDir, ".opencode", "teamwork", channelRun, "costs.json"), "utf8"))
      assert.strictEqual(channelCosts.spentUsd, 0.5, `opencode-nightly.db must be selected for channel nightly: ${channelCosts.spentUsd}`)
    } finally {
      if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = savedXdgData
      process.env.OPENCODE_DB = dbPath
    }
  }

  // 4. Manual addUsd fallback when the database path is unusable.
  process.env.OPENCODE_DB = join(testDir, "does-not-exist.db")
  const mockOfflineCtx = {
    tool: mockCtx.tool,
    // A trusted identity is still required for mutating tools; the stub has no
    // cost, so the cost tool falls back to manual addUsd as before.
    session: { get: async () => ({ agent: "team/sentinel" }) },
    storage: costStorage,
  }
  let offlineTools = {}
  mockOfflineCtx.tool.transform = async (cb) => {
    await cb({
      namespace: () => {},
      add: (tool) => registerTool(offlineTools, tool),
    })
  }
  await registerTeamworkTools(mockOfflineCtx, testDir)

  await offlineTools.teamwork_plan.execute(
    {
      topology: "small-focused",
      tasks: [{ id: "task-1" }],
      skipInterview: true, // fixture: this test exercises cost aggregation, not the spec presence gate
    },
    { sessionID: "ses_offline_test" },
  )

  const costOffline = await offlineTools.teamwork_cost.execute({ addUsd: 1.5, taskId: "T1" }, { sessionID: "ses_offline_test" })
  assert(costOffline.content.includes("spent: $1.5"), "Should record 1.5 in manual fallback mode")
  assert(costOffline.content.includes("manual (client unavailable)"), "Source should be manual")

  console.log("✓ test-cost passed: OPENCODE_DB/channel tree aggregation & manual fallback verified")
} finally {
  if (savedDb === undefined) delete process.env.OPENCODE_DB
  else process.env.OPENCODE_DB = savedDb
  rmSync(testDir, { recursive: true, force: true })
}
