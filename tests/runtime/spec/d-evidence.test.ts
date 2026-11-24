import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  readRunJson,
  readState,
  readVictory,
  runFile,
  snapshotTree,
  treeDiff,
  withRun,
} from "../harness/plan"
import { execute } from "../harness/run"
import { approvalFormat, claimTasks, confirmVictory, passSecurityAudit, passTask, recordWorkerHandoff, HANDOFF } from "./helpers"

const EMPTY_DIFF = { added: [], removed: [], changed: [] }

test("D15 a handoff missing a section refuses and writes nothing; the five-section handoff writes a signed index entry", async () => {
  await withRun("d15-handoff", { sessionId: "20261124-000000-d15", tasks: [{ id: "T1" }] }, async (fx) => {
    const before = snapshotTree(fx.runDir)
    const missing = await execute(fx.loaded, fx.worker, "handoff", {
      sessionId: fx.runId,
      taskId: "T1",
      ...HANDOFF,
      caveats: "",
    })
    expect(missing.content).toContain('handoff section "3. Caveats" is empty after sanitisation')
    expect(existsSync(runFile(fx.project, fx.runId, "handoffs/T1-worker.md"))).toBe(false)
    expect(existsSync(runFile(fx.project, fx.runId, "handoffs/index.json"))).toBe(false)
    expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)

    const written = await recordWorkerHandoff(fx, "T1")
    expect(written.content.startsWith("Handoff recorded:")).toBe(true)
    const path = runFile(fx.project, fx.runId, "handoffs/T1-worker.md")
    expect(existsSync(path)).toBe(true)
    const body = readFileSync(path, "utf8")
    for (const label of ["1. Observation", "2. Logic Chain", "3. Caveats", "4. Conclusion", "5. Verification Method"]) {
      expect(body).toContain(`## ${label}`)
    }

    const index = readRunJson(fx.project, fx.runId, "handoffs/index.json")
    const entry = index.entries.find((item: any) => item.taskId === "T1" && item.agent === "team/worker")
    expect(entry).toBeDefined()
    expect(entry.path).toBe("handoffs/T1-worker.md")
    const { sha256Hex } = await approvalFormat()
    expect(entry.sha256).toBe(sha256Hex(body))
    expect(entry.bytes).toBe(Buffer.byteLength(body, "utf8"))
    expect(entry._auth).toBeDefined()
    expect(entry._auth.alg).toBe("hmac-sha256")
    expect(entry._auth.path).toBe("handoffs/T1-worker.md")
  })
})

test("D16 A PASS report binds the worker handoff from disk; re-recording the handoff makes the report stale", async () => {
  await withRun(
    "d16-report-binding",
    {
      sessionId: "20261124-000000-d16",
      tasks: [{ id: "T1" }],
      requireHandoffs: "required",
      victoryAudit: "skip",
      victorySkipReason: "fixture: report binding is independent of the victory gate",
    },
    async (fx) => {
      await claimTasks(fx)
      const { report } = await passTask(fx, "T1")
      const binding = report.report?.workerHandoff
      expect(binding).toBeDefined()
      expect(binding.taskId).toBe("T1")
      expect(binding.agent).toBe("team/worker")
      expect(binding.path).toBe("handoffs/T1-worker.md")

      const index = readRunJson(fx.project, fx.runId, "handoffs/index.json")
      const entry = index.entries.find((item: any) => item.taskId === "T1" && item.agent === "team/worker")
      expect(binding.sha256).toBe(entry.sha256)

      // Re-record the worker handoff after the report: the bound bytes changed.
      const again = await recordWorkerHandoff(fx, "T1", { conclusion: "The worker rewrote its narrative after verification." })
      expect(again.content.startsWith("Handoff recorded:")).toBe(true)

      const final = await execute(fx.loaded, fx.root, "final_verify", { sessionId: fx.runId })
      expect(final.status).toBe("FAIL")
      expect(final.reasons.some((reason: string) => reason.startsWith("[REPORT_HANDOFF_STALE] task T1"))).toBe(true)
    },
  )
})

test("D17 a CONFIRMED victory records evidenceDigests; mutating a report afterwards makes next/final_verify AUTH_STALE", async () => {
  await withRun(
    "d17-victory-digests",
    { sessionId: "20261124-000000-d17", tasks: [{ id: "T1" }], requireHandoffs: "skip" },
    async (fx) => {
      await claimTasks(fx)
      await passTask(fx, "T1", { handoff: false })
      await passSecurityAudit(fx)
      const victory = await confirmVictory(fx)
      expect(victory.content.startsWith("VICTORY AUDIT RECORDED: VICTORY CONFIRMED")).toBe(true)

      const verdict = readVictory(fx.project, fx.runId)
      expect(verdict.evidenceDigests).toBeDefined()
      expect(Object.keys(verdict.evidenceDigests.reports)).toEqual(["T1"])
      const { sha256Hex } = await approvalFormat()
      const reportText = readFileSync(runFile(fx.project, fx.runId, "verify/report-T1.json"), "utf8")
      expect(verdict.evidenceDigests.reports.T1).toBe(sha256Hex(reportText))

      const final = await execute(fx.loaded, fx.root, "final_verify", { sessionId: fx.runId })
      expect(final.status).toBe("PASS")

      // Mutate the report the audit reviewed. Its bytes no longer match.
      const reportPath = runFile(fx.project, fx.runId, "verify/report-T1.json")
      const report = JSON.parse(reportText)
      report.summary = `${report.summary} (mutated after the audit)`
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

      const before = snapshotTree(fx.runDir)
      const next = await execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
      expect(next.status).toBe("AUTH_STALE")
      expect(next.content).toContain("BLOCKED_BY_AUTH: [AUTH_STALE]")
      expect(next.reasons.some((reason: string) => reason.includes("[AUTH_STALE]"))).toBe(true)
      // next must not repair or rewrite anything.
      expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)

      const finalAgain = await execute(fx.loaded, fx.root, "final_verify", { sessionId: fx.runId })
      expect(finalAgain.status).toBe("FAIL")
      expect(
        finalAgain.reasons.some(
          (reason: string) =>
            reason.includes("[AUTH_STALE]") &&
            reason.includes("victory audit") &&
            reason.includes("report T1 changed"),
        ),
      ).toBe(true)
    },
  )
})

const strictOptions = {
  verification: "strict",
  requireHandoffs: "skip",
  victoryAudit: "skip",
  victorySkipReason: "fixture: strict-wave evidence is independent of the victory gate",
}

function writeWave(
  fx: { project: any; runId: string; falsifier: { id: string } },
  includeCites: boolean,
  cites: Array<{ path: string; sha256: string; bytes: number }> = [],
) {
  return approvalFormat().then(({ sha256Hex }) => {
    const report = readFileSync(runFile(fx.project, fx.runId, "verify/report-T1.json"), "utf8")
    const challenge: Record<string, unknown> = {
      version: 1,
      sessionId: fx.runId,
      taskId: "T1",
      kind: "challenge",
      verdict: "PASS",
      agent: "team/falsifier",
      agentSessionId: fx.falsifier.id,
      reportHash: sha256Hex(report),
      notes: "",
      evidence: "",
      generatedAt: new Date().toISOString(),
    }
    if (includeCites) challenge.cites = cites
    writeFileSync(
      runFile(fx.project, fx.runId, "verify/challenge-T1.json"),
      `${JSON.stringify(challenge, null, 2)}\n`,
    )
  })
}

test("D18 teamwork_wave_record hashes cites; a changed cite is STALE", async () => {
  await withRun("d18-cites", { sessionId: "20261124-000000-d18", tasks: [{ id: "T1" }], ...strictOptions }, async (fx) => {
    await claimTasks(fx)
    await passTask(fx, "T1", { handoff: false })
    const evidence = await execute(fx.loaded, fx.root, "evidence", {
      sessionId: fx.runId,
      name: "note.txt",
      content: "fixture evidence\n",
    })
    expect(evidence.content.startsWith("EVIDENCE RECORDED:")).toBe(true)

    const wave = await execute(fx.loaded, fx.falsifier, "wave_record", {
      sessionId: fx.runId,
      taskId: "T1",
      kind: "challenge",
      verdict: "PASS",
      cites: ["verify/evidence/note.txt"],
      notes: "Reviewed the artifact.",
    })
    expect(wave.content.startsWith("STRICT WAVE RECORDED:")).toBe(true)
    const artifact = readRunJson(fx.project, fx.runId, "verify/challenge-T1.json")
    expect(artifact.cites).toHaveLength(1)
    expect(artifact.cites[0].path).toBe("verify/evidence/note.txt")
    const { contentSha256Hex } = await approvalFormat()
    expect(artifact.cites[0].sha256).toBe(contentSha256Hex("fixture evidence\n"))
    expect(artifact.cites[0].bytes).toBe(Buffer.byteLength("fixture evidence\n", "utf8"))
    expect(artifact._auth).toBeDefined()

    writeFileSync(runFile(fx.project, fx.runId, "verify/evidence/note.txt"), "changed evidence\n")
    const final = await execute(fx.loaded, fx.root, "final_verify", { sessionId: fx.runId })
    expect(final.status).toBe("FAIL")
    expect(
      final.reasons.some(
        (reason: string) =>
          reason.includes("[AUTH_STALE]") &&
          reason.includes("strict challenge T1") &&
          reason.includes("cited evidence verify/evidence/note.txt changed"),
      ),
    ).toBe(true)
  })
})

test("D18b cites: [] is refused at write time; a present-but-empty on-disk cite is unbound", async () => {
  await withRun("d18b-empty-cites", { sessionId: "20261124-000000-d18b", tasks: [{ id: "T1" }], ...strictOptions }, async (fx) => {
    await claimTasks(fx)
    await passTask(fx, "T1", { handoff: false })
    const refused = await execute(fx.loaded, fx.falsifier, "wave_record", {
      sessionId: fx.runId,
      taskId: "T1",
      kind: "challenge",
      verdict: "PASS",
      cites: [],
    })
    expect(refused.content).toContain("cites is present but empty")
    expect(existsSync(runFile(fx.project, fx.runId, "verify/challenge-T1.json"))).toBe(false)

    await writeWave(fx, true, [])
    const final = await execute(fx.loaded, fx.root, "final_verify", { sessionId: fx.runId })
    expect(final.status).toBe("FAIL")
    expect(final.reasons.some((reason: string) => reason.includes("cites is empty; the verdict is unbound"))).toBe(true)
  })
})

test("D18c a wave with no cites is legacy_unbound_wave", async () => {
  await withRun("d18c-legacy-cites", { sessionId: "20261124-000000-d18c", tasks: [{ id: "T1" }], ...strictOptions }, async (fx) => {
    await claimTasks(fx)
    await passTask(fx, "T1", { handoff: false })
    await writeWave(fx, false)
    const final = await execute(fx.loaded, fx.root, "final_verify", { sessionId: fx.runId })
    expect(final.status).toBe("FAIL")
    const finalJson = readRunJson(fx.project, fx.runId, "verify/final.json")
    const challenge = finalJson.evidence.strict.tasks.find((task: any) => task.id === "T1").challenge
    expect(challenge.cites).toEqual([])
    expect(challenge.warnings.some((warning: string) => warning.startsWith("legacy_unbound_wave:"))).toBe(true)
  })
})

test("D19 a CONFIRMED victory while a task is verified_fail yields INCONSISTENT_VICTORY_TASK and fixes nothing", async () => {
  await withRun(
    "d19-contradiction",
    { sessionId: "20261124-000000-d19", tasks: [{ id: "T1" }, { id: "T2" }], requireHandoffs: "skip" },
    async (fx) => {
      await claimTasks(fx)
      await passTask(fx, "T1", { handoff: false })

      await execute(fx.loaded, fx.root, "task_update", { sessionId: fx.runId, taskId: "T2", status: "worker_active" })
      for (const status of ["worker_done", "verifier_active"]) {
        await execute(fx.loaded, fx.root, "task_update", { sessionId: fx.runId, taskId: "T2", status })
      }
      const failReport = await execute(fx.loaded, fx.verifier, "report", {
        sessionId: fx.runId,
        taskId: "T2",
        status: "FAIL",
        summary: "Fixture failure.",
        fatalFindings: [{ why: "The fixture is intentionally broken." }],
      })
      expect(failReport.content.startsWith("VERIFIER REPORT WRITTEN: T2 FAIL")).toBe(true)
      const failed = await execute(fx.loaded, fx.root, "task_update", { sessionId: fx.runId, taskId: "T2", status: "verified_fail" })
      expect(failed.content).toContain("status=verified_fail")

      const victory = await confirmVictory(fx)
      expect(victory.content.startsWith("VICTORY AUDIT RECORDED: VICTORY CONFIRMED")).toBe(true)
      const victoryBefore = readFileSync(runFile(fx.project, fx.runId, "verify/victory.json"), "utf8")
      const before = snapshotTree(fx.runDir)

      const next = await execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
      expect(next.status).toBe("INCONSISTENT_EVIDENCE")
      expect(next.contradictions.map((item: any) => item.code)).toEqual(["INCONSISTENT_VICTORY_TASK"])
      expect(next.contradictions[0].detail).toContain("task T2 is verified_fail")

      // Nothing was auto-fixed: task state, reports and the victory verdict stand.
      const state = readState(fx.project, fx.runId)
      expect(state.tasks.T2.status).toBe("verified_fail")
      expect(readRunJson(fx.project, fx.runId, "verify/report-T2.json").status).toBe("FAIL")
      expect(readFileSync(runFile(fx.project, fx.runId, "verify/victory.json"), "utf8")).toBe(victoryBefore)
      expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual(EMPTY_DIFF)
    },
  )
})
