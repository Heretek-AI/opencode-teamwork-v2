// I1 — the standard happy path, with exactly one verifier failure per task.
//
// Both tasks are claimed by the Sentinel, driven through a real git worktree,
// failed once by the real verifier, retried by the worker on round 2, then
// verified PASS. The run-level gates (security audit, independent victory
// audit, final verification) are the plugin's own writers. Every assertion is
// on an artifact or a structured tool result, never on prose.

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readEvents, readRunJson, runFile, snapshotTree, treeDiff, withRun } from "../harness/plan"
import {
  finalVerify,
  next,
  plannedTasks,
  readFinal,
  securityAudit,
  state,
  taskCycle,
  victory,
} from "../harness/flow"

const EMPTY_DIFF = { added: [], removed: [], changed: [] }

test("I1 standard run: two tasks, one verifier retry, real worktrees, stamped PASS", async () => {
  await withRun(
    "i1-standard",
    {
      sessionId: "20261124-000000-i1",
      verification: "standard",
      request: "Ship two deterministic fixture changes, each verified once more after a review failure.",
      requirements: [
        { id: "R1", text: "Both fixture tasks are delivered and verified." },
        { id: "R2", text: "The run carries a stamped final PASS." },
      ],
      // I1 isolates the standard evidence chain; the continuity handoff matrix
      // and the strict wave are covered by I2. Recorded as an explicit skip.
      requireHandoffs: "skip",
      tasks: [{ id: "T1" }, { id: "T2" }],
    },
    async (fx) => {
      expect(plannedTasks(fx)).toEqual(["T1", "T2"])

      const claimed = await next(fx)
      expect(claimed.content).toContain("READY FOR WORKER (2)")
      expect((claimed.readyForWorker as any[]).map((task) => task.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(["T1", "T2"])
      for (const taskId of ["T1", "T2"]) {
        expect(state(fx).tasks[taskId].claim.by).toBe(fx.root.id)
      }

      const cycles: Record<string, any> = {}
      for (const taskId of ["T1", "T2"]) {
        const cycle = await taskCycle(fx, taskId, { retry: true })
        expect(state(fx).tasks[taskId].status).toBe("verified_pass")
        expect(state(fx).tasks[taskId].round).toBe(2)
        expect(cycle.fail).toBeDefined()
        expect(cycle.commits).toHaveLength(2)
        expect(cycle.commits[0]).not.toBe(cycle.commits[1])
        expect(existsSync(runFile(fx.project, fx.runId, `verify/report-${taskId}.json`))).toBe(true)
        cycles[taskId] = cycle
      }

      await securityAudit(fx, "PASS")
      await victory(fx, { verdict: "VICTORY CONFIRMED" })

      const final = await finalVerify(fx)
      expect(final.status).toBe("PASS")
      expect(final.victory).toBe("CONFIRMED")

      const finalJson = readFinal(fx)
      expect(finalJson.status).toBe("PASS")
      expect(typeof finalJson.generatedBy?.session).toBe("string")
      expect(finalJson.generatedBy.session.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(String(finalJson.generatedAt)))).toBe(false)
      expect(Object.keys(finalJson.evidence.reportDigests).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(["T1", "T2"])
      expect(finalJson.evidence.auditDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(finalJson.evidence.handoffs).toBeDefined()
      expect(finalJson.evidence.handoffs.mode).toBe("skip")
      expect(finalJson.evidence.allTasksVerifiedPass).toBe(true)
      expect(finalJson.evidence.victory.status).toBe("CONFIRMED")

      // The report digests are the digests of the bytes now on disk.
      const manifest = readRunJson(fx.project, fx.runId, "run.manifest.json")
      expect(manifest._auth.digest).toMatch(/^[0-9a-f]{64}$/)
      for (const taskId of ["T1", "T2"]) {
        const report = readRunJson(fx.project, fx.runId, `verify/report-${taskId}.json`)
        expect(report.status).toBe("PASS")
        expect(report.round).toBe(2)
        expect(report._auth.alg).toBe("hmac-sha256")
        expect(report.headSha).toBe(cycles[taskId].commits[1])
      }

      const complete = await next(fx)
      expect(complete.status).toBe("ALL_PASSED")
      expect(complete.stamped).toBe(true)
      expect(complete.securityAuditPassed).toBe(true)
      expect(complete.content).toContain("ALL_TASKS_PASSED")

      // Standard mode never writes the strict gate table.
      expect(existsSync(runFile(fx.project, fx.runId, "GATE_STATUS.md"))).toBe(false)

      // No duplicate tool effects: exactly one final verdict, one audit, one
      // victory audit, and the two report rounds per task.
      const events = readEvents(fx.project, fx.runId)
      const count = (event: string, predicate: (entry: any) => boolean = () => true) =>
        events.filter((entry) => entry.event === event && predicate(entry)).length
      expect(count("final_verification")).toBe(1)
      expect(count("security_audit")).toBe(1)
      expect(count("victory_audit")).toBe(1)
      for (const taskId of ["T1", "T2"]) {
        expect(count("verifier_report", (entry) => entry.taskId === taskId && entry.to === "FAIL")).toBe(1)
        expect(count("verifier_report", (entry) => entry.taskId === taskId && entry.to === "PASS")).toBe(1)
        expect(count("task_transition", (entry) => entry.taskId === taskId && entry.to === "worker_active")).toBe(2)
      }
      const seqs = events.map((entry) => entry.seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

      // A second completion read is a no-op: no state/event/artifact churn.
      const before = snapshotTree(fx.runDir)
      const again = await next(fx)
      expect(again.status).toBe("ALL_PASSED")
      expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)
    },
  )
})
