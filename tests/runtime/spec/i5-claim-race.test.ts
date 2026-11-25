// I5 — two OS processes race `teamwork_next` against one run.
//
// The parent plans the run and creates two Sentinel sessions under the run
// root, then closes its host. Two child processes each open an embedded host on
// the same file-backed session DB and call `next` once, concurrently. The
// assertions are serialised in the parent afterwards: every task is claimed at
// most once, events.jsonl keeps one monotonic seq space, and state.json parses.

import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject } from "../harness/project"
import { loadHost } from "../harness/load"
import { createSession } from "../harness/run"
import { planRun, readEvents, readState } from "../harness/plan"

const HERE = import.meta.dir
const CHILD = join(HERE, "..", "harness", "race-child.ts")

function runChild(spec: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], {
      cwd: join(HERE, ".."),
      env: { ...process.env, RACE_SPEC: JSON.stringify(spec) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test("I5 two processes race next: no task is claimed twice, events seq stays unique and monotonic", async () => {
  const project = createProject("i5-claim-race")
  let loaded: Awaited<ReturnType<typeof loadHost>> | undefined
  try {
    // A file-backed DB is the shared session tree for the child processes.
    loaded = await loadHost(project, { mode: "memory", databasePath: project.dbPath })
    const root = await createSession(loaded, { agent: "team/sentinel", title: "i5 race root" })
    const first = await createSession(loaded, { agent: "team/sentinel", parent: root, title: "i5 sentinel A" })
    const second = await createSession(loaded, { agent: "team/sentinel", parent: root, title: "i5 sentinel B" })

    const runId = "20261124-000000-i5"
    const plan = await planRun(loaded, root, {
      sessionId: runId,
      request: "Race two sentinels for two independent fixture tasks.",
      requireHandoffs: "skip",
      tasks: [{ id: "T1" }, { id: "T2" }],
    })
    expect(plan.content.startsWith("Planned ")).toBe(true)

    // No other process may hold the DB while the children open it.
    await loaded.close()
    loaded = undefined

    const outDir = mkdtempSync(join(tmpdir(), "teamwork-i5-race-"))
    const specs = [first, second].map((session, index) => ({
      root: project.root,
      dbPath: project.dbPath,
      runId,
      rootSessionId: root.id,
      sessionId: session.id,
      out: join(outDir, `result-${index}.json`),
    }))

    const [a, b] = await Promise.all([runChild(specs[0]), runChild(specs[1])])
    for (const child of [a, b]) {
      expect(child.code, child.stderr.slice(-800)).toBe(0)
    }

    const results = specs.map((spec) => JSON.parse(readFileSync(spec.out, "utf8")))
    for (const result of results) {
      expect(result.threw).toBeUndefined()
      expect(result.error ?? null).toBeNull()
      expect(["READY FOR WORKER", "IN PROGRESS", "DEADLOCK"]).toContain(
        String(result.content).includes("READY FOR WORKER")
          ? "READY FOR WORKER"
          : String(result.content).includes("IN PROGRESS")
            ? "IN PROGRESS"
            : "DEADLOCK",
      )
      expect(Array.isArray(result.readyForWorker) || result.readyForWorker === null).toBe(true)
    }

    // Serialised assertion: each task appears in exactly one process's claim
    // response, so no task was handed out twice.
    const claimsByTask = new Map<string, string[]>()
    for (const result of results) {
      for (const task of result.readyForWorker ?? []) {
        const list = claimsByTask.get(task.id) ?? []
        list.push(result.sessionId)
        claimsByTask.set(task.id, list)
      }
    }
    expect([...claimsByTask.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(["T1", "T2"])
    for (const taskId of ["T1", "T2"]) {
      expect(claimsByTask.get(taskId)).toHaveLength(1)
    }
    const totalClaims = [...claimsByTask.values()].reduce((sum, list) => sum + list.length, 0)
    expect(totalClaims).toBe(2)

    // state.json parses and records exactly one owner per task, from the two
    // racing sessions.
    const state = readState(project, runId)
    expect(state).toBeDefined()
    expect(typeof state).toBe("object")
    for (const taskId of ["T1", "T2"]) {
      const task = state.tasks[taskId]
      expect(task.status).toBe("worker_active")
      expect([first.id, second.id]).toContain(task.claim.by)
      expect(task.fence).toBeGreaterThanOrEqual(1)
    }
    // The winner of a task is the process that reported it, and its own
    // worker_active transition is the one that landed.
    for (const taskId of ["T1", "T2"]) {
      expect(state.tasks[taskId].claim.by).toBe(claimsByTask.get(taskId)![0])
    }
    for (const result of results) {
      for (const transition of result.transitions ?? []) {
        expect(transition.status).toBe("worker_active")
        expect(claimsByTask.get(transition.taskId)).toEqual([result.sessionId])
      }
    }

    // One seq space: unique, contiguous and monotonic in file order, even
    // though two processes appended concurrently.
    const events = readEvents(project, runId)
    expect(events.length).toBeGreaterThan(1)
    const seqs = events.map((event) => event.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1))
    expect(events[0].event).toBe("run_created")

    // Exactly one transition per task, each by the process that claimed it.
    const transitions = events.filter((event) => event.event === "task_transition")
    expect(transitions.map((event) => event.taskId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(["T1", "T2"])
    for (const transition of transitions) {
      expect(transition.to).toBe("worker_active")
      expect(transition.agent).toBe("team/sentinel")
      expect([first.id, second.id]).toContain(state.tasks[transition.taskId].claim.by)
    }
  } finally {
    if (loaded) await loaded.close()
    project.cleanup()
  }
})
