import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  commitInWorktree,
  createTaskWorktree,
  gitCommitCount,
  gitHead,
  readEvents,
  readState,
  runFile,
  snapshotTree,
  treeDiff,
  withRun,
} from "../harness/plan"
import { execute } from "../harness/run"
import { createSession } from "../harness/run"

const EMPTY_DIFF = { added: [], removed: [], changed: [] }

test("C10 teamwork_next claims a ready task and returns a fence; a stale fence is refused and changes nothing", async () => {
  await withRun("c10-fence", { sessionId: "20261124-000000-c10" }, async (fx) => {
    const next = await execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
    expect(next.content).toContain("READY FOR WORKER (2)")
    const state = readState(fx.project, fx.runId)
    for (const taskId of ["T1", "T2"]) {
      expect(state.tasks[taskId].status).toBe("pending")
      expect(state.tasks[taskId].claim.by).toBe(fx.root.id)
      expect(state.tasks[taskId].claim.leaseUntil).toBeDefined()
      expect(state.tasks[taskId].fence).toBe(1)
    }

    const before = snapshotTree(fx.runDir)
    const stale = await execute(fx.loaded, fx.root, "task_update", {
      sessionId: fx.runId,
      taskId: "T1",
      status: "worker_active",
      fence: 99,
    })
    expect(stale.status).toBe("STALE_FENCE")
    expect(stale.content).toContain('task "T1" is at fence 1, but the call carried fence 99')
    expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)
    expect(readState(fx.project, fx.runId).tasks.T1.status).toBe("pending")
  })
})

test("C11 a second Sentinel gets no claim for a held task and CLAIM_OWNED_BY_OTHER on update", async () => {
  await withRun("c11-second-sentinel", { sessionId: "20261124-000000-c11", tasks: [{ id: "T1" }] }, async (fx) => {
    // An unrelated root session cannot touch this run at all: the control-plane
    // authorization requires the run root or a descendant.
    const unrelatedRoot = await createSession(fx.loaded, { agent: "team/sentinel" })
    const unrelatedAttempt = await execute(fx.loaded, unrelatedRoot, "next", { sessionId: fx.runId })
    expect(unrelatedAttempt.content).toContain("refused: next must be called from the run root or a session that descends")
    expect(unrelatedAttempt.content).toContain("does not descend from")

    // Two Sentinel sessions at the run root level contend for the same task.
    const first = await fx.child("team/sentinel")
    const second = await fx.child("team/sentinel")
    expect(second.id).not.toBe(first.id)
    const firstNext = await execute(fx.loaded, first, "next", { sessionId: fx.runId })
    expect(firstNext.content).toContain("READY FOR WORKER (1)")

    const secondNext = await execute(fx.loaded, second, "next", { sessionId: fx.runId })
    expect(secondNext.content).toContain("IN PROGRESS")
    expect(secondNext.content).toContain(first.id)
    expect(secondNext.readyForWorker).toEqual([])

    const state = readState(fx.project, fx.runId)
    expect(state.tasks.T1.claim.by).toBe(first.id)
    const before = snapshotTree(fx.runDir)
    const update = await execute(fx.loaded, second, "task_update", {
      sessionId: fx.runId,
      taskId: "T1",
      status: "worker_active",
      fence: state.tasks.T1.fence,
    })
    expect(update.status).toBe("CLAIM_OWNED_BY_OTHER")
    expect(update.content).toContain(`claimed by ${first.id}`)
    expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)
  })
})

test("C12 a child session of the owner may update the task (descendant)", async () => {
  await withRun("c12-descendant", { sessionId: "20261124-000000-c12", tasks: [{ id: "T1" }] }, async (fx) => {
    await execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
    const fence = readState(fx.project, fx.runId).tasks.T1.fence
    const update = await execute(fx.loaded, fx.worker, "task_update", {
      sessionId: fx.runId,
      taskId: "T1",
      status: "worker_active",
      fence,
    })
    expect(update.status).toBe("worker_active")
    const state = readState(fx.project, fx.runId)
    expect(state.tasks.T1.status).toBe("worker_active")
    // The root keeps the claim; the child acted on it as a descendant.
    expect(state.tasks.T1.claim.by).toBe(fx.root.id)
    const event = readEvents(fx.project, fx.runId).filter((item) => item.event === "task_transition").at(-1)
    expect(event.agent).toBe("team/worker")
  })
})

test("C13 verified_pass is refused from pending and without a verified PASS report on a signed run", async () => {
  await withRun("c13-verified-pass", { sessionId: "20261124-000000-c13", tasks: [{ id: "T1" }] }, async (fx) => {
    // From pending: an illegal lifecycle transition, before any evidence check.
    const fromPending = await execute(fx.loaded, fx.root, "task_update", {
      sessionId: fx.runId,
      taskId: "T1",
      status: "verified_pass",
    })
    expect(fromPending.content).toContain('Illegal transition for task "T1": pending -> verified_pass')

    // From verifier_active, with no PASS report on a signed run.
    await execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
    for (const status of ["worker_active", "worker_done", "verifier_active"]) {
      const step = await execute(fx.loaded, fx.root, "task_update", { sessionId: fx.runId, taskId: "T1", status })
      expect(step.content).toContain(`status=${status}`)
    }
    const noReport = await execute(fx.loaded, fx.root, "task_update", {
      sessionId: fx.runId,
      taskId: "T1",
      status: "verified_pass",
      verification: { status: "PASS" },
    })
    expect(noReport.status).toBe("REPORT_MISSING")
    expect(noReport.content).toContain("Refusing verified_pass")
    expect(existsSync(runFile(fx.project, fx.runId, "verify/report-T1.json"))).toBe(false)
    expect(readState(fx.project, fx.runId).tasks.T1.status).toBe("verifier_active")
  })
})

test("C14 recover adopts a clean committed branch without a commit; inspect token is single-use", async () => {
  await withRun("c14-recover-adopt", { sessionId: "20261124-000000-c14", tasks: [{ id: "T1" }] }, async (fx) => {
    const worktree = createTaskWorktree(fx.project, fx.runId, "T1")
    await execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
    const fence = readState(fx.project, fx.runId).tasks.T1.fence
    const active = await execute(fx.loaded, fx.root, "task_update", {
      sessionId: fx.runId,
      taskId: "T1",
      status: "worker_active",
      fence,
    })
    expect(active.status).toBe("worker_active")

    commitInWorktree(worktree, "src/feature.txt", "feature\n")
    const headBefore = gitHead(worktree)
    const commitsBefore = gitCommitCount(worktree)

    const inspect = await execute(fx.loaded, fx.root, "recover", { sessionId: fx.runId, taskId: "T1", action: "inspect" })
    expect(inspect.status).toBe("INSPECTED")
    expect(typeof inspect.token).toBe("string")
    expect(String(inspect.token).length).toBeGreaterThan(16)
    expect(inspect.content).toContain("TOKEN (single use, 10 minutes)")

    const stateBefore = snapshotTree(fx.runDir)
    const noToken = await execute(fx.loaded, fx.root, "recover", { sessionId: fx.runId, taskId: "T1", action: "adopt" })
    expect(noToken.content).toContain("refused: INSPECTION_TOKEN_INVALID")
    expect(treeDiff(stateBefore, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)

    const adopt = await execute(fx.loaded, fx.root, "recover", {
      sessionId: fx.runId,
      taskId: "T1",
      action: "adopt",
      token: inspect.token,
    })
    expect(adopt.status).toBe("OK")
    expect(adopt.content).toContain("No commit was made")
    expect(gitHead(worktree)).toBe(headBefore)
    expect(gitCommitCount(worktree)).toBe(commitsBefore)
    const state = readState(fx.project, fx.runId)
    expect(state.tasks.T1.status).toBe("worker_done")
    expect(state.tasks.T1.checkpoint.headSha).toBe(headBefore)
    expect(state.tasks.T1.claim).toBeUndefined()

    const afterAdopt = snapshotTree(fx.runDir)
    const replay = await execute(fx.loaded, fx.root, "recover", {
      sessionId: fx.runId,
      taskId: "T1",
      action: "adopt",
      token: inspect.token,
    })
    expect(replay.content.startsWith("refused:")).toBe(true)
    expect(treeDiff(afterAdopt, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)
  })
})
