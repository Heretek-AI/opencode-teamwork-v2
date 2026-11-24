// L3 claim-race child.
//
// One embedded OpenCode host in its own process, sharing the parent's temp
// project and file-backed session DB, calling exactly one `teamwork_next` as a
// pre-created Sentinel session. The parent spawns two of these concurrently and
// serialises the assertions afterwards.
//
// Usage: RACE_SPEC=<json> bun harness/race-child.ts
//   { root, dbPath, runId, sessionId, out }

import { writeFileSync } from "node:fs"
import { loadHost } from "./load"
import { openProject } from "./project"
import { execute, type RunSession } from "./run"

const spec = JSON.parse(process.env.RACE_SPEC ?? "{}")
if (!spec.root || !spec.dbPath || !spec.runId || !spec.sessionId || !spec.out) {
  console.error("race-child: RACE_SPEC is incomplete")
  process.exit(2)
}

const project = openProject(spec.root)
const loaded = await loadHost(project, { mode: "memory", databasePath: spec.dbPath })
const session: RunSession = {
  id: spec.sessionId,
  agent: "team/sentinel",
  parentID: spec.rootSessionId ?? null,
  info: { id: spec.sessionId, agent: "team/sentinel", parentID: spec.rootSessionId ?? null },
}

try {
  const result = await execute(loaded, session, "next", { sessionId: spec.runId })
  const transitions: any[] = []
  // Claim-then-start is the real dispatch order. Letting both processes write
  // these transitions concurrently also exercises the run's cross-process
  // state lock and event sequence space.
  for (const task of Array.isArray(result.readyForWorker) ? result.readyForWorker : []) {
    const update = await execute(loaded, session, "task_update", {
      sessionId: spec.runId,
      taskId: task.id,
      status: "worker_active",
      ...(task.fence !== undefined ? { fence: task.fence } : {}),
    })
    transitions.push({ taskId: task.id, status: update.status ?? null, content: update.content, fence: update.fence ?? null })
  }
  writeFileSync(
    spec.out,
    `${JSON.stringify(
      {
        pid: process.pid,
        sessionId: spec.sessionId,
        status: result.status ?? null,
        content: result.content,
        readyForWorker: result.readyForWorker ?? null,
        inProgress: result.inProgress ?? null,
        error: result.error ?? null,
        transitions,
      },
      null,
      2,
    )}\n`,
  )
} catch (error) {
  writeFileSync(
    spec.out,
    `${JSON.stringify({ pid: process.pid, sessionId: spec.sessionId, threw: String((error as Error)?.message ?? error) }, null, 2)}\n`,
  )
} finally {
  await loaded.close()
}
