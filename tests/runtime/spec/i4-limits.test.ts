// I4 — failure limits.
//
// I4a drives one task past its `maxRounds`: the verifier fails round 1, the
// engine refuses another round and blocks the task, `next` reports DEADLOCK,
// the run records PRESENT_PARTIAL, and nothing outside the run is written.
//
// I4b records spend at 1000% of the plan budget. The budget is advisory outside
// the massive-proof tournament (README/ARTIFACTS): `teamwork_cost` warns and
// returns `shouldHalt`, but `teamwork_next` still dispatches and `task_update`
// still starts a round. Only `teamwork_tournament`/`next`'s tournament branch
// enforce the threshold. The spec asserts that documented behaviour rather than
// a cap the engine does not apply.

import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { readState, runFile, snapshotTree, treeDiff, withRun } from "../harness/plan"
import { call, next, readFinal, state, transition } from "../harness/flow"
import { execute } from "../harness/run"

function outsideRun(projectRoot: string, runDir: string, snapshot: Record<string, string>) {
  const prefix = `${runDir.slice(projectRoot.length + 1).split("\\").join("/")}/`
  return Object.fromEntries(Object.entries(snapshot).filter(([path]) => !path.startsWith(prefix)))
}

test("I4a maxRounds exhaustion blocks the task, reports DEADLOCK, and writes only inside the run", async () => {
  await withRun(
    "i4a-max-rounds",
    {
      sessionId: "20261124-000000-i4a",
      request: "Attempt a fixture task that can never satisfy its verifier.",
      requireHandoffs: "skip",
      tasks: [{ id: "T1", maxRounds: 1 }],
    },
    async (fx) => {
      const claimed = await next(fx)
      expect(claimed.content).toContain("READY FOR WORKER (1)")

      await transition(fx, "T1", "worker_active")
      await transition(fx, "T1", "worker_done")
      await transition(fx, "T1", "verifier_active")
      const fail = await call(fx, fx.verifier, "report", {
        taskId: "T1",
        status: "FAIL",
        summary: "The fixture cannot pass.",
        fatalFindings: [{ where: "src/t1.txt", why: "Fixture is intentionally incomplete.", fix: "Not possible in one round." }],
      })
      expect(fail.content).toContain("VERIFIER REPORT WRITTEN: T1 FAIL")

      const before = outsideRun(fx.project.root, fx.runDir, snapshotTree(fx.project.root))
      // maxRounds is 1 and the task is on round 1, so verified_fail is coerced
      // to blocked by the engine itself.
      const failed = await execute(fx.loaded, fx.root, "task_update", {
        sessionId: fx.runId,
        taskId: "T1",
        status: "verified_fail",
      })
      expect(failed.status).toBe("blocked")
      expect(failed.content).toContain("status=blocked")

      const runState = state(fx)
      expect(runState.tasks.T1.status).toBe("blocked")
      expect(runState.tasks.T1.round).toBe(1)
      expect(runState.phase).toBe("PRESENT_PARTIAL")
      expect(readState(fx.project, fx.runId).tasks.T1.status).toBe("blocked")

      const deadlock = await next(fx)
      expect(deadlock.status).toBe("DEADLOCK")
      expect(deadlock.content).toContain("DEADLOCK_OR_BLOCKED")
      expect((deadlock.blocked as any[]).map((task) => task.id)).toEqual(["T1"])
      expect(deadlock.content).not.toContain("ALL_TASKS_PASSED")

      // No final verdict was stamped, and nothing outside the run changed.
      expect(readFinal(fx)).toBeUndefined()
      const after = outsideRun(fx.project.root, fx.runDir, snapshotTree(fx.project.root))
      expect(treeDiff(before, after)).toEqual({ added: [], removed: [], changed: [] })

      // A blocked task cannot be driven further without an explicit recovery;
      // the same-status re-write is still allowed and changes nothing else.
      const stillBlocked = await execute(fx.loaded, fx.root, "task_update", {
        sessionId: fx.runId,
        taskId: "T1",
        status: "blocked",
      })
      expect(stillBlocked.content).toContain("status=blocked")
      expect(state(fx).tasks.T1.round).toBe(1)
    },
  )
})

test("I4b budgetUsd is advisory outside the massive-proof tournament", async () => {
  await withRun(
    "i4b-budget-advisory",
    {
      sessionId: "20261124-000000-i4b",
      request: "Dispatch a task after the advisory budget threshold is reached.",
      requireHandoffs: "skip",
      budgetUsd: 0.5,
      tasks: [{ id: "T1" }],
    },
    async (fx) => {
      // Seed an over-budget record. `byTask` is the accounting source: the real
      // cost tool recomputes `spentUsd` from the buckets, so the seeded spend
      // survives a real `teamwork_cost` read.
      const costsFile = runFile(fx.project, fx.runId, "costs.json")
      const costs = JSON.parse(readFileSync(costsFile, "utf8"))
      writeFileSync(
        costsFile,
        JSON.stringify({ ...costs, budgetUsd: 0.5, spentUsd: 5, byTask: { _unattributed: 5 } }, null, 2) + "\n",
      )

      const cost = await call(fx, fx.root, "cost", {})
      expect(cost.content).toContain("Budget: $0.5")
      expect(cost.content).toContain("1000%")
      expect(cost.content).toContain("advisory")
      expect(cost.shouldHalt).toBe(true)
      expect(cost.pct).toBe(1000)
      expect(cost.thresholdPct).toBe(80)

      // The standard-run engine does not gate dispatch on that signal.
      const dispatched = await next(fx)
      expect(dispatched.status).toBeUndefined()
      expect(dispatched.content).toContain("READY FOR WORKER (1)")
      expect((dispatched.readyForWorker as any[]).map((task) => task.id)).toEqual(["T1"])
      expect(dispatched.content).not.toContain("BUDGET")
      expect(state(fx).phase).toBe("DISPATCH")
      expect(readState(fx.project, fx.runId).tasks.T1.status).toBe("pending")

      // `task_update` still starts the round; the budget is not a transition gate.
      const started = await transition(fx, "T1", "worker_active")
      expect(started.content).toContain("status=worker_active")
      expect(state(fx).tasks.T1.round).toBe(1)

      // No partial verdict was forced by the budget.
      expect(readFinal(fx)).toBeUndefined()
      expect(state(fx).phase).not.toBe("PRESENT_PARTIAL")
    },
  )
})

test("I4b2 budgetUsd: 0 is an explicit no-budget run", async () => {
  await withRun(
    "i4b2-budget-unlimited",
    {
      sessionId: "20261124-000000-i4b2",
      request: "Dispatch with no budget recorded.",
      requireHandoffs: "skip",
      budgetUsd: 0,
      tasks: [{ id: "T1" }],
    },
    async (fx) => {
      const costsFile = runFile(fx.project, fx.runId, "costs.json")
      const costs = JSON.parse(readFileSync(costsFile, "utf8"))
      writeFileSync(costsFile, JSON.stringify({ ...costs, budgetUsd: 0, spentUsd: 99, byTask: { _unattributed: 99 } }, null, 2) + "\n")

      const cost = await call(fx, fx.root, "cost", {})
      expect(cost.content).toContain("Budget: $0")
      expect(cost.pct).toBe(0)
      expect(cost.shouldHalt).toBe(false)

      const dispatched = await next(fx)
      expect((dispatched.readyForWorker as any[]).map((task) => task.id)).toEqual(["T1"])
      expect(dispatched.content).not.toContain("BUDGET")
    },
  )
})
