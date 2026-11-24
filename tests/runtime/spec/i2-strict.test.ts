// I2 — the strict path.
//
// Every task needs an independent falsifier challenge (PASS) and a trusted
// security-auditor wave audit (CLEAN), both bound by reportHash to the verifier
// report and both citing evidence the engine re-hashes. `teamwork_next` must
// refuse to complete until both waves exist for both tasks, and the strict PASS
// must write GATE_STATUS.md.

import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { readEvents, readRunJson, runFile, withRun } from "../harness/plan"
import {
  evidence,
  finalVerify,
  next,
  readFinal,
  securityAudit,
  taskCycle,
  victory,
  waveRecord,
} from "../harness/flow"

test("I2 strict run: waves gate next, a missing wave blocks, GATE_STATUS.md records every row", async () => {
  await withRun(
    "i2-strict",
    {
      sessionId: "20261124-000000-i2",
      verification: "strict",
      request: "Deliver two fixture tasks under the strict challenge and audit wave.",
      requireHandoffs: "skip",
      tasks: [{ id: "T1" }, { id: "T2" }],
    },
    async (fx) => {
      const claimed = await next(fx)
      expect(claimed.content).toContain("READY FOR WORKER (2)")

      for (const taskId of ["T1", "T2"]) {
        await taskCycle(fx, taskId, { fileName: `src/${taskId.toLowerCase()}.txt` })
      }
      await securityAudit(fx, "PASS")
      await victory(fx, { verdict: "VICTORY CONFIRMED" })

      // No waves yet: the strict gate must stop completion.
      const noWaves = await next(fx)
      expect(noWaves.status).toBe("NEEDS_STRICT_WAVE")
      expect(noWaves.content).toContain("NEEDS_STRICT_WAVE")
      const missing = (noWaves.missing as any[]).map((entry) => `${entry.taskId}:${entry.kind}`).sort()
      expect(missing).toEqual(["T1:audit", "T1:challenge", "T2:audit", "T2:challenge"])

      const t1Evidence = await evidence(fx, "T1-review.txt", "T1 strict review evidence\n")
      await waveRecord(fx, "T1", "challenge", [t1Evidence])
      await waveRecord(fx, "T1", "audit", [t1Evidence])

      // T1 is covered; T2 is not, so the run still cannot complete.
      const oneWave = await next(fx)
      expect(oneWave.status).toBe("NEEDS_STRICT_WAVE")
      const missingOne = (oneWave.missing as any[]).map((entry) => `${entry.taskId}:${entry.kind}`).sort()
      expect(missingOne).toEqual(["T2:audit", "T2:challenge"])

      // Directly asking for the final verdict is refused for the same reason.
      const blockedFinal = await finalVerify(fx)
      expect(blockedFinal.status).toBe("FAIL")
      expect(
        (blockedFinal.reasons as string[]).some(
          (reason) => reason.includes("strict") && reason.includes("T2") && reason.includes("challenge"),
        ),
      ).toBe(true)
      expect(readFinal(fx).status).toBe("FAIL")
      expect(readFinal(fx).evidence.strict.tasks.find((task: any) => task.id === "T2").challenge.status).toBe("MISSING")

      const t2Evidence = await evidence(fx, "T2-review.txt", "T2 strict review evidence\n")
      await waveRecord(fx, "T2", "challenge", [t2Evidence])
      await waveRecord(fx, "T2", "audit", [t2Evidence])

      // The earlier refused final_verify wrote a FAIL report; until a fresh
      // verdict is stamped, `next` keeps the run blocked rather than ready.
      const stillBlocked = await next(fx)
      expect(stillBlocked.status).toBe("BLOCKED_BY_FINAL_VERIFICATION")

      const final = await finalVerify(fx)
      expect(final.status).toBe("PASS")
      expect(final.strictGate).toBe("PASS")

      const finalJson = readFinal(fx)
      expect(finalJson.status).toBe("PASS")
      expect(finalJson.evidence.strict.mode).toBe("strict")
      expect(finalJson.evidence.strict.status).toBe("PASS")
      expect(finalJson.evidence.strict.missing).toEqual([])
      expect(finalJson.evidence.strict.tasks).toHaveLength(2)
      for (const task of finalJson.evidence.strict.tasks) {
        expect(task.reportStatus).toBe("PASS")
        expect(task.challenge.status).toBe("PASS")
        expect(task.challenge.agent).toBe("team/falsifier")
        expect(task.challenge.ok).toBe(true)
        expect(task.challenge.cites).toHaveLength(1)
        expect(task.audit.status).toBe("CLEAN")
        expect(task.audit.agent).toBe("team/security-auditor")
        expect(task.audit.ok).toBe(true)
        expect(task.audit.cites).toHaveLength(1)
        expect(task.challenge.reportHash).toBe(task.audit.reportHash)
      }

      // The strict PASS writes the human-readable gate table.
      const gatePath = runFile(fx.project, fx.runId, "GATE_STATUS.md")
      expect(existsSync(gatePath)).toBe(true)
      const gate = readFileSync(gatePath, "utf8")
      expect(gate).toContain("- Mode: strict")
      expect(gate).toContain("Gate Result: **PASS**")
      for (const taskId of ["T1", "T2"]) {
        expect(gate).toContain(`| team/worker | worker | verified_pass | state.json#tasks.${taskId} |`)
        expect(gate).toContain(`| team/verifier | verifier | PASS | verify/report-${taskId}.json |`)
        expect(gate).toContain(`| team/falsifier | challenger | PASS | verify/challenge-${taskId}.json |`)
        expect(gate).toContain(`| team/security-auditor | auditor | CLEAN | verify/audit-${taskId}.json |`)
      }
      expect(gate).not.toContain("MISSING")

      // Both strict artifacts live where the gate says they do.
      for (const taskId of ["T1", "T2"]) {
        const challenge = readRunJson(fx.project, fx.runId, `verify/challenge-${taskId}.json`)
        const audit = readRunJson(fx.project, fx.runId, `verify/audit-${taskId}.json`)
        expect(challenge.kind).toBe("challenge")
        expect(challenge.verdict).toBe("PASS")
        expect(challenge.agent).toBe("team/falsifier")
        expect(challenge.agentSessionId).toBe(fx.falsifier.id)
        expect(challenge._auth.alg).toBe("hmac-sha256")
        expect(audit.kind).toBe("audit")
        expect(audit.verdict).toBe("CLEAN")
        expect(audit.agent).toBe("team/security-auditor")
        expect(audit.agentSessionId).toBe(fx.auditor.id)
      }

      const complete = await next(fx)
      expect(complete.status).toBe("ALL_PASSED")
      expect(complete.stamped).toBe(true)

      const waves = readEvents(fx.project, fx.runId).filter((entry) => entry.event === "verification_wave")
      expect(waves).toHaveLength(4)
      expect(waves.map((entry) => entry.note).sort()).toEqual([
        "audit: CLEAN",
        "audit: CLEAN",
        "challenge: PASS",
        "challenge: PASS",
      ])
    },
  )
})
