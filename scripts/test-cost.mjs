// test-cost — verifies session-tree cost aggregation and the manual addUsd fallback.
//
// Hermeticity: the tree-aggregation assertions need a real OpenCode session that
// already recorded cost, which cannot be manufactured here without mutating the
// user's database. Instead of pinning a machine-specific session id:
//   * TEAMWORK_TEST_SESSION_ID overrides discovery when set.
//   * Otherwise the most recently updated session with enough recorded cost in
//     the local OpenCode DB is used. Path discovery and the node:sqlite ->
//     sqlite3 backends mirror plugins/opencode-teamwork/tools.ts, so the test
//     reads the same database the cost tool reads.
//   * With no usable session the script prints one SKIP line and exits 0. A
//     vacuous pass would hide untested behaviour; an explicit skip is honest,
//     and CI without an OpenCode DB must not fail on an environment assumption.
//
// Discovered spend must reach 1% of the plan tool's default $20 budget because
// the cost tool floors the percentage; otherwise an existing assertion (pct > 0)
// could not hold and the test would fail for environmental reasons.

import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert"
import { execFileSync } from "node:child_process"

const SKIP_NOTICE =
  "SKIP: test-cost needs a real OpenCode session with cost data; set TEAMWORK_TEST_SESSION_ID to one, or run after at least one OpenCode session."

const DEFAULT_PLAN_BUDGET_USD = 20
const MIN_DISCOVERED_COST_USD = DEFAULT_PLAN_BUDGET_USD / 100

// Mirrors getOpencodeDbPath() in plugins/opencode-teamwork/tools.ts.
function getOpencodeDbPath() {
  const candidates = []
  if (process.env.XDG_DATA_HOME) {
    candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"))
  }
  const home = homedir()
  candidates.push(join(home, ".local", "share", "opencode", "opencode.db"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "opencode.db"))
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "opencode", "opencode.db"))
  }
  candidates.push(join(home, "AppData", "Local", "opencode", "opencode.db"))
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return undefined
}

let nodeSqlitePromise

function loadNodeSqlite() {
  if (nodeSqlitePromise === undefined) {
    nodeSqlitePromise = import("node:sqlite").catch(() => null)
  }
  return nodeSqlitePromise
}

function inlineParams(sql, params) {
  let i = 0
  return sql.replace(/\?/g, () => {
    const value = params[i++]
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
    return `'${String(value).replace(/'/g, "''")}'`
  })
}

// Same backend order as tools.ts: node:sqlite first, sqlite3 CLI second.
async function queryRows(dbPath, sql, params = []) {
  const mod = await loadNodeSqlite()
  if (mod && typeof mod.DatabaseSync === "function") {
    try {
      const db = new mod.DatabaseSync(dbPath, { readOnly: true })
      try {
        return db.prepare(sql).all(...params).map((row) => ({ ...row }))
      } finally {
        db.close()
      }
    } catch {}
  }
  try {
    const raw = execFileSync("sqlite3", [dbPath, "-json", inlineParams(sql, params)], {
      encoding: "utf8",
      timeout: 5000,
    })
    const parsed = JSON.parse(raw || "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function findSessionWithCost(dbPath) {
  const rows = await queryRows(
    dbPath,
    `WITH RECURSIVE tree(root_id, id, cost, depth) AS (
       SELECT id, id, cost, 0 FROM session_v2 WHERE cost > 0
       UNION ALL
       SELECT t.root_id, s.id, s.cost, t.depth + 1
       FROM session_v2 s JOIN tree t ON s.parent_id = t.id
       WHERE t.depth < 32
     )
     SELECT t.root_id AS id, SUM(t.cost) AS total, MAX(s.time_updated) AS updated
     FROM tree t JOIN session_v2 s ON s.id = t.root_id
     GROUP BY t.root_id
     HAVING SUM(t.cost) >= ?
     ORDER BY updated DESC
     LIMIT 1`,
    [MIN_DISCOVERED_COST_USD],
  )
  const row = rows[0]
  return row && typeof row.id === "string" ? row.id : undefined
}

async function readTreeCost(dbPath, sessionId) {
  const rows = await queryRows(
    dbPath,
    `WITH RECURSIVE tree(id, cost, depth) AS (
       SELECT id, cost, 0 FROM session_v2 WHERE id = ?
       UNION ALL
       SELECT s.id, s.cost, t.depth + 1
       FROM session_v2 s JOIN tree t ON s.parent_id = t.id
       WHERE t.depth < 32
     )
     SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS total FROM tree`,
    [sessionId],
  )
  const row = rows[0]
  if (!row || Number(row.n) === 0) return undefined
  return Number(row.total) || 0
}

async function resolveTestSession() {
  const dbPath = getOpencodeDbPath()
  if (!dbPath) return undefined

  const override = process.env.TEAMWORK_TEST_SESSION_ID?.trim()
  if (override) {
    // A bad override must skip, not crash and not pass vacuously.
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(override)) return undefined
    const total = await readTreeCost(dbPath, override)
    return total !== undefined && total >= MIN_DISCOVERED_COST_USD ? override : undefined
  }

  return await findSessionWithCost(dbPath)
}

const testSessionId = await resolveTestSession()
if (!testSessionId) {
  console.log(SKIP_NOTICE)
  process.exit(0)
}

const testDir = mkdtempSync(join(tmpdir(), "teamwork-test-"))
// Minimal ctx.storage shim: the plan tool now requires a signed baseline (or an
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

try {
  let registeredTools = {}
  const mockCtx = {
    tool: {
      transform: async (cb) => {
        const editor = {
          namespace: () => {},
          add: (tool) => {
            registeredTools[tool.name] = tool
          },
        }
        await cb(editor)
      },
    },
    session: {
      get: async ({ sessionID }) => {
        if (sessionID === "ses_mock_root") {
          return {
            agent: "team/sentinel",
            cost: 0.15,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          }
        }
        // Every fixture session is a trusted sentinel for control-plane auth;
        // the cost assertions read the real DB/API instead of this stub.
        return { agent: "team/sentinel" }
      },
    },
    storage: costStorage,
  }

  await registerTeamworkTools(mockCtx, testDir)

  assert(registeredTools.plan, "plan tool must be registered")
  assert(registeredTools.cost, "cost tool must be registered")

  // 1. Test plan creates run and records root session
  const planRes = await registeredTools.plan.execute(
    {
      topology: "small-focused",
      tasks: [{ id: "task-1" }],
      skipInterview: true, // fixture: this test exercises cost aggregation, not the spec gate
    },
    { sessionID: testSessionId },
  )

  assert(planRes.content.includes("Planned 1 task"), "Plan should succeed")

  // 2. Test cost tool reading real opencode DB session tree
  const costRes = await registeredTools.cost.execute({}, { sessionID: testSessionId })
  assert(costRes.content.includes("opencode session tree"), "Should report opencode session tree as source")
  assert(costRes.content.includes("spent: $"), "Should report spent amount")
  assert(costRes.pct > 0, "Percentage should reflect total consumption")

  // 3. Second call should not double count
  const costRes2 = await registeredTools.cost.execute({}, { sessionID: testSessionId })
  assert.strictEqual(costRes.pct, costRes2.pct, "Percentage should remain identical on immediate re-call")

  // 4. Test manual addUsd fallback when native client/tree is unavailable
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
      add: (tool) => {
        offlineTools[tool.name] = tool
      },
    })
  }
  await registerTeamworkTools(mockOfflineCtx, testDir)

  await offlineTools.plan.execute(
    {
      topology: "small-focused",
      tasks: [{ id: "task-1" }],
      skipInterview: true, // fixture: this test exercises cost aggregation, not the spec gate
    },
    { sessionID: "ses_offline_test" },
  )

  const costOffline = await offlineTools.cost.execute({ addUsd: 1.5, taskId: "T1" }, { sessionID: "ses_offline_test" })
  assert(costOffline.content.includes("spent: $1.5"), "Should record 1.5 in manual fallback mode")
  assert(costOffline.content.includes("manual (client unavailable)"), "Source should be manual")

  console.log("✓ test-cost passed: session tree aggregation & manual fallback verified")
} finally {
  rmSync(testDir, { recursive: true, force: true })
}
