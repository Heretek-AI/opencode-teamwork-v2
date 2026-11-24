// I3 — a rejected victory audit blocks completion, and only a fresh audit
// (not a repeated `next` read) can resume the run.
//
// `teamwork_final_verify` cannot stamp PASS while the recorded verdict is
// VICTORY REJECTED, so the dedicated `BLOCKED_BY_VICTORY_AUDIT` gate is only
// reachable when a stamped final PASS already exists (for example a PASS that
// predates the rejection). The spec seeds that PASS as a fixture, exactly as
// `scripts/test-engine.mjs` does, and asserts the gate around it.

import { expect, test } from "bun:test"
import { readRunJson, snapshotTree, treeDiff, withStorageRun } from "../harness/plan"
import { signFixtureArtifact } from "../harness/sign"
import {
  finalVerify,
  next,
  readFinal,
  securityAudit,
  state,
  taskCycle,
  victory,
  writeRunFile,
  readRunText,
} from "../harness/flow"

const EMPTY_DIFF = { added: [], removed: [], changed: [] }

async function seedStampedPass(fx: any) {
  const payload = {
    status: "PASS",
    generatedBy: { agent: "team/verifier", session: "ses_i3_pre_rejection" },
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    evidence: {},
    reasons: [],
  }
  const signed = await signFixtureArtifact(fx.project, fx.runId, "verify/final.json", payload, fx.storage)
  writeRunFile(fx, "verify/final.json", `${JSON.stringify(signed, null, 2)}\n`)
}

test("I3 rejected victory blocks next; a fresh CONFIRMED audit resumes and only then can final PASS", async () => {
  await withStorageRun(
    "i3-victory",
    {
      sessionId: "20261124-000000-i3",
      request: "Deliver the fixture change and satisfy both recorded requirements.",
      requirements: [
        { id: "R1", text: "The fixture change is delivered." },
        { id: "R2", text: "The acceptance behaviour is observable." },
      ],
      requireHandoffs: "skip",
      tasks: [{ id: "T1" }],
    },
    async (fx) => {
      await next(fx)
      await taskCycle(fx, "T1")
      await securityAudit(fx, "PASS")

      const rejected = await victory(fx, {
        verdict: "VICTORY REJECTED",
        unmet: ["R2"],
        findings: ["R2 is not observable in the delivered artifact."],
      })
      expect(rejected.verdict?.verdict).toBe("VICTORY REJECTED")
      const verdictJson = readRunJson(fx.project, fx.runId, "verify/victory.json")
      expect(verdictJson.verdict).toBe("VICTORY REJECTED")
      expect(verdictJson.requirements.find((item: any) => item.id === "R2").met).toBe(false)
      expect(verdictJson._auth.alg).toBe("hmac-sha256")

      // While REJECTED, a direct final verification cannot stamp PASS.
      const blockedFinal = await finalVerify(fx)
      expect(blockedFinal.status).toBe("FAIL")
      expect((blockedFinal.reasons as string[]).some((reason) => reason.includes("VICTORY REJECTED"))).toBe(true)
      expect(readFinal(fx).status).toBe("FAIL")

      // A stamped PASS that predates the rejection now hits the dedicated gate.
      await seedStampedPass(fx)
      const gate = await next(fx)
      expect(gate.status).toBe("BLOCKED_BY_VICTORY_AUDIT")
      expect(gate.content).toContain("BLOCKED_BY_VICTORY_AUDIT")
      expect(gate.victory).toBe("REJECTED")
      expect(gate.content).not.toContain("ALL_TASKS_PASSED")

      // The rejected verdict is not overwritable by reading `next` again, and
      // the read changes nothing on disk.
      const victoryBytes = readRunText(fx, "verify/victory.json")
      const before = snapshotTree(fx.runDir)
      const again = await next(fx)
      expect(again.status).toBe("BLOCKED_BY_VICTORY_AUDIT")
      expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)
      expect(readRunText(fx, "verify/victory.json")).toBe(victoryBytes)
      expect(readRunJson(fx.project, fx.runId, "verify/victory.json").verdict).toBe("VICTORY REJECTED")

      // A fresh audit from the trusted auditor is the only way forward.
      const confirmed = await victory(fx, { verdict: "VICTORY CONFIRMED" })
      expect(confirmed.verdict?.verdict).toBe("VICTORY CONFIRMED")

      // Only now can final verification stamp PASS, and it replaces the fixture.
      const final = await finalVerify(fx)
      expect(final.status).toBe("PASS")
      const finalJson = readFinal(fx)
      expect(finalJson.status).toBe("PASS")
      expect(finalJson.evidence.victory.status).toBe("CONFIRMED")
      expect(finalJson.generatedBy.session).not.toBe("ses_i3_pre_rejection")
      expect(finalJson.evidence.victory.auditorSessionId).toBe(fx.victoryAuditor.id)

      const complete = await next(fx)
      expect(complete.status).toBe("ALL_PASSED")
      expect(complete.victory).toBe("CONFIRMED")
      expect(state(fx).tasks.T1.status).toBe("verified_pass")

      // The real victory artifact is the CONFIRMED one; nothing was repaired
      // by writing final.json alone.
      expect(readRunJson(fx.project, fx.runId, "verify/victory.json").verdict).toBe("VICTORY CONFIRMED")
    },
  )
})
