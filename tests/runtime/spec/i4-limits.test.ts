// I4 — failure limits.
//
// I4a drives one task past its `maxRounds`: the verifier fails round 1, the
// engine refuses another round and blocks the task, `next` reports DEADLOCK,
// the run records PRESENT_PARTIAL, and nothing outside the run is written.
//
// I4b (budget exhaustion mid-run) is skipped: the plugin records `budgetUsd`
// and `teamwork_cost` reports `shouldHalt` at the threshold, but no
// non-tournament tool consumes that signal, so a standard run does not block or
// enter PRESENT_PARTIAL when the budget is exhausted. Tests must not assert a
// cap the engine does not enforce; FINDINGS.md records the observation and the
// exact transcript.

import { expect, test } from "bun:test"
import { readState, snapshotTree, treeDiff, withRun } from "../harness/plan"
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

test.skip("I4b budgetUsd exhaustion halts a standard run mid-run (plugin defect: budget is advisory outside tournaments)", () => {
  // Reproduced by hand on 0.17.1: plan with budgetUsd: 0.5, record $5 of manual
  // spend through teamwork_cost (`shouldHalt: true`, pct 1000), then call
  // teamwork_next. The task is still dispatched (no BUDGET/BLOCKED status, no
  // PRESENT_PARTIAL) because only `teamwork_tournament` consumes the budget
  // signal. See tests/runtime/FINDINGS.md §4b.
})
