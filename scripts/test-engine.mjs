import { registerTeamworkTools, registerTeamworkHooks } from "../plugins/opencode-teamwork/tools.ts"
import { listTeamworkRuns, inspectTeamworkRun, pruneTeamworkWorktrees } from "../lib/runs.mjs"
import { currentModels, readRawModelMap, writeModelMap, installAgents, DEFAULT_MODELS } from "../lib/team.mjs"
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import assert from "node:assert"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-engine-test-"))

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
    session: { get: async () => undefined },
  }

  await registerTeamworkTools(mockCtx, testDir)

  assert(registeredTools.next, "next tool must be registered")
  assert(registeredTools.task_update, "task_update tool must be registered")
  assert(registeredTools.security_audit, "security_audit tool must be registered")
  assert(registeredTools.final_verify, "final_verify tool must be registered")
  assert(registeredTools.worktree, "worktree tool must be registered")

  // ==========================================
  // Part 1: DAG Engine & Dynamic Pitfall Injection
  // ==========================================
  console.log("Testing DAG Engine & Dynamic Pitfall Injection...")

  const planRes = await registeredTools.plan.execute({
    sessionId: "20261018-000000-test",
    topology: "distributed-coding",
    skipInterview: true, // fixture: this part exercises the DAG engine, not the spec gate
    tasks: [
      { id: "T1", dependsOn: [], maxRounds: 2 },
      { id: "T2", dependsOn: ["T1"], maxRounds: 2 },
    ],
  })
  assert(planRes.content.includes("Planned 2 task(s)"), "Plan should create 2 tasks")

  // Log a known pitfall for T1
  await registeredTools.pitfall.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    round: 1,
    pitfall: "Do not assume non-empty array",
  })

  // Step 1: Initial state -> T1 readyForWorker with avoidPitfalls
  let nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 1, "Only T1 should be ready for worker")
  assert.strictEqual(nextRes.readyForWorker[0].id, "T1")
  assert(nextRes.readyForWorker[0].avoidPitfalls.some((p) => p.includes("Do not assume non-empty array")), "Pitfall should be injected into readyForWorker")
  assert.strictEqual(nextRes.readyForVerifier.length, 0)

  // Step 2: Worker starts T1 -> worker_active
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_active",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 0)
  assert.strictEqual(nextRes.inProgress.length, 1)
  assert.strictEqual(nextRes.inProgress[0].id, "T1")

  // Step 3: Worker commits -> worker_done
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_done",
    branch: "teamwork/20261018-000000-test-T1",
    summary: "Implemented T1",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForVerifier.length, 1)
  assert.strictEqual(nextRes.readyForVerifier[0].id, "T1")

  // Step 4: Verifier fails T1 (round 1) -> readyForWorker again for round 2
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verifier_active",
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verified_fail",
    feedback: "Fix edge case in validation",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 1)
  assert.strictEqual(nextRes.readyForWorker[0].id, "T1")
  assert.strictEqual(nextRes.readyForWorker[0].round, 2, "Should advance to round 2")
  assert.strictEqual(nextRes.readyForWorker[0].feedback, "R1: Fix edge case in validation", "Unresolved feedback must carry its round prefix")

  // Step 5: T1 passes on round 2
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_active",
    round: 2,
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_done",
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verifier_active",
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verified_pass",
    verification: { status: "PASS", passedChecks: 5, totalChecks: 5 },
  })

  // Step 6: T1 passed -> T2 is unblocked and ready for worker!
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 1)
  assert.strictEqual(nextRes.readyForWorker[0].id, "T2", "T2 should now be ready for worker")

  // Step 7: T2 passes -> Pre-merge security gate triggers!
  // The lifecycle is walked explicitly: a direct pending -> verified_pass jump is
  // refused by the transition graph, and verified_pass requires PASS evidence.
  for (const status of ["worker_active", "worker_done", "verifier_active"]) {
    await registeredTools.task_update.execute({
      sessionId: "20261018-000000-test",
      taskId: "T2",
      status,
    })
  }
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T2",
    status: "verified_pass",
    verification: { status: "PASS", passedChecks: 3, totalChecks: 3 },
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "READY_FOR_SECURITY_AUDIT", "Should require security audit before all-passed")

  // Step 8: Security Audit fails (Critical finding) -> BLOCKED_BY_SECURITY
  const failAuditRes = await registeredTools.security_audit.execute({
    sessionId: "20261018-000000-test",
    status: "FAIL",
    findings: [{ id: "SEC-1", severity: "Critical", description: "Hardcoded API key in config", location: "config.js:10" }],
    summary: "Critical secret detected",
  })
  assert.strictEqual(failAuditRes.status, "FAIL")

  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "BLOCKED_BY_SECURITY", "Should block final merge when audit fails")

  // Step 9: Remediate and run clean Security Audit -> final verification gate
  const passAuditRes = await registeredTools.security_audit.execute({
    sessionId: "20261018-000000-test",
    status: "PASS",
    findings: [{ id: "SEC-2", severity: "Low", description: "Missing cache header", location: "server.js:20" }],
    summary: "All critical/high issues resolved",
  })
  assert.strictEqual(passAuditRes.status, "PASS")

  // (a) Tasks + audit pass, but no verify/final.json -> NOT done.
  const finalFile = join(testDir, ".opencode", "teamwork", "20261018-000000-test", "verify", "final.json")
  const mainStateFile = join(testDir, ".opencode", "teamwork", "20261018-000000-test", "state.json")
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "READY_FOR_FINAL_VERIFICATION", "Missing final.json must block ALL_PASSED")
  assert.strictEqual(nextRes.finalReport, finalFile, "Response must name the final report path")
  assert.strictEqual(nextRes.passedCount, 2)
  assert.strictEqual(nextRes.integrityMode, "development", "a run with no request artifact defaults the gate to development")
  let phase = JSON.parse(readFileSync(mainStateFile, "utf8")).phase
  assert.strictEqual(phase, "FINAL_VERIFICATION", "Phase must advance to FINAL_VERIFICATION")

  // (b) A FAIL final report blocks the run (never ALL_PASSED).
  mkdirSync(dirname(finalFile), { recursive: true })
  writeFileSync(finalFile, JSON.stringify({ status: "FAIL", summary: "acceptance criteria not met" }) + "\n")
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "BLOCKED_BY_FINAL_VERIFICATION", "A FAIL final report must block the run")
  assert.notStrictEqual(nextRes.status, "ALL_PASSED")
  assert.strictEqual(nextRes.finalReport, finalFile)
  assert.strictEqual(nextRes.integrityMode, "development", "BLOCKED_BY_FINAL_VERIFICATION must disclose the default mode")

  // (c) A hand-written PASS report is UNSTAMPED: only the explicit legacy
  //     bypass lets it complete the run. (Before A2 any PASS was accepted.)
  writeFileSync(finalFile, JSON.stringify({ status: "PASS", summary: "independent final check passed" }) + "\n")
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "FINAL_VERIFICATION_UNVERIFIED", "an unstamped PASS must not reach ALL_PASSED by default")
  assert.strictEqual(nextRes.finalReport, finalFile, "FINAL_VERIFICATION_UNVERIFIED must include the final report path")
  assert.strictEqual(nextRes.integrityMode, "development", "FINAL_VERIFICATION_UNVERIFIED must disclose the default mode")
  phase = JSON.parse(readFileSync(mainStateFile, "utf8")).phase
  assert.strictEqual(phase, "FINAL_VERIFICATION", "an unstamped PASS must leave the run in FINAL_VERIFICATION")

  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test", allowUnstamped: true })
  assert.strictEqual(nextRes.status, "ALL_PASSED", "allowUnstamped must accept a hand-written PASS")
  assert.strictEqual(nextRes.stamped, false, "the bypassed verdict must not claim to be stamped")
  assert.strictEqual(nextRes.unstampedBypass, true, "the result must flag the bypass")
  assert.strictEqual(nextRes.finalReport, finalFile, "ALL_PASSED must include the final report path")
  assert.strictEqual(nextRes.integrityMode, "development", "ALL_PASSED must disclose the default mode")
  assert(/not produced by teamwork_final_verify/.test(nextRes.content), `the message must state the verdict was unverified: ${nextRes.content}`)
  phase = JSON.parse(readFileSync(mainStateFile, "utf8")).phase
  assert.strictEqual(phase, "MERGE", "Phase must advance to MERGE after the recorded bypass")

  console.log("✓ DAG engine, dynamic pitfall injection & security gate verified")

  // ==========================================
  // Part 1b: Topology normalisation + verified_pass accounting
  // ==========================================
  console.log("Testing topology normalisation & completion accounting...")

  const planFileOf = (id) => join(testDir, ".opencode", "teamwork", id, "plan.dag.json")
  const stateFileOf = (id) => join(testDir, ".opencode", "teamwork", id, "state.json")
  const runFile = (root, runId, name) => join(root, ".opencode", "teamwork", runId, name)
  const readEvents = (root, runId) =>
    readFileSync(runFile(root, runId, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l))

  // Every legacy alias is accepted and persisted as its canonical topology.
  const aliases = {
    "large-swarm": "distributed-coding",
    "doc-review": "document-review",
    "long-proof": "proof",
    "massive-proof-swarm": "massive-proof",
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    const id = `20261018-000000-alias-${alias}`
    const r = await registeredTools.plan.execute({ sessionId: id, topology: alias, skipInterview: true, tasks: [{ id: "T1" }] })
    assert(r.content.startsWith("Planned"), `alias ${alias} must be accepted: ${r.content}`)
    const persisted = JSON.parse(readFileSync(planFileOf(id), "utf8"))
    assert.strictEqual(persisted.topology, canonical, `${alias} must be persisted as ${canonical}`)
    assert(!("routingReason" in persisted), "routingReason must be absent when not provided")
  }

  // routingReason is optional and persisted when provided.
  const reasonRun = "20261018-000000-reason"
  await registeredTools.plan.execute({
    sessionId: reasonRun,
    topology: "doc-review",
    routingReason: "docs-only review",
    skipInterview: true,
    tasks: [{ id: "T1" }],
  })
  const reasonPlan = JSON.parse(readFileSync(planFileOf(reasonRun), "utf8"))
  assert.strictEqual(reasonPlan.topology, "document-review", "alias must be normalised on write")
  assert.strictEqual(reasonPlan.routingReason, "docs-only review", "routingReason must be persisted")

  // An unknown topology is refused and writes nothing.
  const badTopoRun = "20261018-000000-badtopo"
  const badTopo = await registeredTools.plan.execute({
    sessionId: badTopoRun,
    topology: "not-a-topology",
    tasks: [{ id: "T1" }],
  })
  assert(badTopo.content.startsWith("refused: invalid topology"), `unknown topology must be refused: ${badTopo.content}`)
  assert(badTopo.content.includes("document-review"), "refusal must list the accepted values")
  assert(!existsSync(join(testDir, ".opencode", "teamwork", badTopoRun)), "a refused plan must write nothing")

  // verified_pass is the canonical terminal state: status counts it, resume is complete.
  // The legal lifecycle must be walked and PASS evidence supplied (the engine refuses
  // both a status jump and an evidence-free verified_pass).
  const passRun = "20261018-000000-verified"
  await registeredTools.plan.execute({ sessionId: passRun, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "P1" }, { id: "P2" }] })
  for (const taskId of ["P1", "P2"]) {
    for (const status of ["worker_active", "worker_done", "verifier_active", "verified_pass"]) {
      await registeredTools.task_update.execute({
        sessionId: passRun,
        taskId,
        status,
        ...(status === "verified_pass" ? { verification: { status: "PASS" } } : {}),
      })
    }
  }
  const passStatus = await registeredTools.status.execute({ sessionId: passRun })
  assert(passStatus.content.includes("2/2 pass"), `status must count verified_pass: ${passStatus.content}`)
  const passResume = await registeredTools.resume.execute({ sessionId: passRun })
  assert(passResume.content.includes("is complete"), `resume must treat verified_pass as closed: ${passResume.content}`)

  // Legacy `pass` in an existing state.json is still counted as complete.
  const legacyRun = "20261018-000000-legacy-pass"
  await registeredTools.plan.execute({ sessionId: legacyRun, topology: "small-focused", skipInterview: true, tasks: [{ id: "L1" }] })
  const legacyState = JSON.parse(readFileSync(stateFileOf(legacyRun), "utf8"))
  legacyState.tasks.L1.status = "pass"
  writeFileSync(stateFileOf(legacyRun), JSON.stringify(legacyState, null, 2) + "\n")
  const legacyStatus = await registeredTools.status.execute({ sessionId: legacyRun })
  assert(legacyStatus.content.includes("1/1 pass"), `status must still count legacy pass: ${legacyStatus.content}`)
  const legacyResume = await registeredTools.resume.execute({ sessionId: legacyRun })
  assert(legacyResume.content.includes("is complete"), `resume must treat legacy pass as closed: ${legacyResume.content}`)

  console.log("✓ topology aliases normalised, unknown topologies refused, verified_pass counted as complete")

  // ==========================================
  // Part 1c: teamwork_plan spec gate (3.4)
  // ==========================================
  console.log("Testing the teamwork_plan spec gate...")

  // (a) no spec + defaults -> refused, and the run dir is never created.
  const noSpecRun = "20261018-000000-nospec"
  const noSpecRes = await registeredTools.plan.execute({ sessionId: noSpecRun, topology: "iterative-coding", tasks: [{ id: "S1" }] })
  assert(noSpecRes.content.startsWith("refused: no spec found"), `plan without a spec must be refused: ${noSpecRes.content}`)
  assert(noSpecRes.content.includes(runFile(testDir, noSpecRun, "prompt_draft.md")), "refusal must name the expected spec path")
  assert(noSpecRes.content.includes("skipInterview: true"), "refusal must name the explicit bypass")
  assert(noSpecRes.content.includes("/teamwork-craft"), "refusal must name the action that produces a spec")
  assert(!existsSync(join(testDir, ".opencode", "teamwork", noSpecRun)), "a spec-gate refusal must create no run directory")

  // A whitespace-only prompt_draft.md is not a spec: still refused, still no plan files.
  const blankSpecRun = "20261018-000000-blankspec"
  mkdirSync(join(testDir, ".opencode", "teamwork", blankSpecRun), { recursive: true })
  writeFileSync(runFile(testDir, blankSpecRun, "prompt_draft.md"), "  \n\t\n")
  const blankRes = await registeredTools.plan.execute({ sessionId: blankSpecRun, topology: "iterative-coding", tasks: [{ id: "S1" }] })
  assert(blankRes.content.startsWith("refused: no spec found"), `a whitespace-only spec must not satisfy the gate: ${blankRes.content}`)
  assert(!existsSync(planFileOf(blankSpecRun)), "a refused plan with an existing run dir must write no plan files")

  // (b) skipInterview: true -> succeeds, and run_created records the bypass.
  const bypassRun = "20261018-000000-specbypass"
  const bypassRes = await registeredTools.plan.execute({ sessionId: bypassRun, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "S1" }] })
  assert(bypassRes.content.startsWith("Planned"), `skipInterview must allow planning without a spec: ${bypassRes.content}`)
  assert(bypassRes.content.includes("Spec gate bypassed"), "the bypass must be visible in the tool result")
  const bypassCreated = readEvents(testDir, bypassRun).find((e) => e.event === "run_created")
  assert.strictEqual(bypassCreated.specGate, "bypassed", "run_created must record specGate: bypassed")
  assert(!Object.hasOwn(bypassCreated, "specPath"), "a bypass must not record a specPath")

  // (c) non-empty prompt_draft.md -> succeeds, specPath recorded.
  const specRun = "20261018-000000-specok"
  mkdirSync(join(testDir, ".opencode", "teamwork", specRun), { recursive: true })
  writeFileSync(runFile(testDir, specRun, "prompt_draft.md"), "# Spec\n\nBuild the thing.\n")
  const specRes = await registeredTools.plan.execute({ sessionId: specRun, topology: "iterative-coding", tasks: [{ id: "S1" }] })
  assert(specRes.content.startsWith("Planned"), `a present spec must satisfy the gate: ${specRes.content}`)
  const specCreated = readEvents(testDir, specRun).find((e) => e.event === "run_created")
  assert.strictEqual(specCreated.specGate, "satisfied", "run_created must record specGate: satisfied")
  assert.strictEqual(specCreated.specPath, runFile(testDir, specRun, "prompt_draft.md"), "a satisfied gate must record the spec path")
  assert.deepStrictEqual(
    Object.keys(specCreated),
    ["ts", "seq", "event", "sessionId", "taskId", "from", "to", "round", "agent", "branch", "worktree", "phase", "specGate", "specPath"],
    "existing run_created fields must keep their order (seq after ts); the gate fields are appended",
  )

  // (d) requireSpec: false -> succeeds without a spec and is recorded as such.
  const optOutRun = "20261018-000000-specoptout"
  const optOutRes = await registeredTools.plan.execute({ sessionId: optOutRun, topology: "iterative-coding", requireSpec: false, tasks: [{ id: "S1" }] })
  assert(optOutRes.content.startsWith("Planned"), `requireSpec: false must allow planning without a spec: ${optOutRes.content}`)
  assert(!existsSync(runFile(testDir, optOutRun, "prompt_draft.md")), "requireSpec: false must not invent a spec file")
  const optOutCreated = readEvents(testDir, optOutRun).find((e) => e.event === "run_created")
  assert.strictEqual(optOutCreated.specGate, "not_required", "run_created must record specGate: not_required")
  assert(!Object.hasOwn(optOutCreated, "specPath"), "not_required must not record a specPath")

  console.log("✓ plan refuses without a spec (writing nothing), records satisfied/bypassed/not_required")

  // ==========================================
  // Part 1c-bis: request artifact and integrity modes
  // ==========================================
  console.log("Testing ORIGINAL_REQUEST.md and integrity modes...")

  const requestFileOf = (id) => runFile(testDir, id, "ORIGINAL_REQUEST.md")

  // (a) request + benchmark: verbatim artifact first, mode persisted everywhere.
  const reqRun = "20261018-000000-request-bench"
  const requestText = "Build the thing.\n\nKeep   these spaces\tand this tab.\n\n  indented line"
  const reqRes = await registeredTools.plan.execute({
    sessionId: reqRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: requestText,
    integrityMode: "benchmark",
    tasks: [{ id: "R1" }],
  })
  assert(reqRes.content.startsWith("Planned"), `request plan must succeed: ${reqRes.content}`)
  assert(reqRes.content.includes("benchmark"), "the plan result must name the integrity mode")
  const reqMd = readFileSync(requestFileOf(reqRun), "utf8")
  assert(reqMd.startsWith("# Original Request\n\n- Integrity mode: benchmark\n- Recorded: "), `artifact header must be exact: ${reqMd.slice(0, 80)}`)
  assert(/- Recorded: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(reqMd), "Recorded must be ISO8601 UTC")
  assert(reqMd.includes(`- Session: ${reqRun}`), "artifact must name the run session")
  assert(reqMd.includes(`## Request\n\n${requestText}`), "request text must be preserved verbatim (interior whitespace intact)")
  assert.strictEqual(JSON.parse(readFileSync(planFileOf(reqRun), "utf8")).integrityMode, "benchmark", "plan.dag.json must carry integrityMode")
  assert.strictEqual(JSON.parse(readFileSync(stateFileOf(reqRun), "utf8")).integrityMode, "benchmark", "state.json must carry integrityMode")

  // (b) a second plan into the same run is refused and writes nothing else.
  const planBefore = readFileSync(planFileOf(reqRun), "utf8")
  const stateBefore = readFileSync(stateFileOf(reqRun), "utf8")
  const secondReq = await registeredTools.plan.execute({
    sessionId: reqRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "a different request",
    integrityMode: "benchmark",
    tasks: [{ id: "R2" }],
  })
  assert(secondReq.content.startsWith("refused:"), `a second request must be refused: ${secondReq.content}`)
  assert(/write-once/i.test(secondReq.content), "refusal must explain the write-once rule")
  assert(/new session/i.test(secondReq.content), "refusal must point at a new session")
  assert.strictEqual(readFileSync(requestFileOf(reqRun), "utf8"), reqMd, "the recorded request must be unchanged")
  assert.strictEqual(readFileSync(planFileOf(reqRun), "utf8"), planBefore, "a refused request must not rewrite plan.dag.json")
  assert.strictEqual(readFileSync(stateFileOf(reqRun), "utf8"), stateBefore, "a refused request must not rewrite state.json")

  // (c) an invalid mode is refused before anything is written.
  const badModeRun = "20261018-000000-badmode"
  const badMode = await registeredTools.plan.execute({
    sessionId: badModeRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "do it",
    integrityMode: "production",
    tasks: [{ id: "M1" }],
  })
  assert(badMode.content.startsWith("refused: invalid integrityMode"), `an invalid mode must be refused: ${badMode.content}`)
  for (const mode of ["development", "demo", "benchmark"]) {
    assert(badMode.content.includes(mode), `refusal must list ${mode}`)
  }
  assert(!existsSync(join(testDir, ".opencode", "teamwork", badModeRun)), "an invalid mode must write nothing")

  // (d) legacy tolerance: omitting both inputs plans, defaults to development, no artifact.
  const defaultRun = "20261018-000000-request-default"
  const defaultRes = await registeredTools.plan.execute({ sessionId: defaultRun, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "D1" }] })
  assert(defaultRes.content.startsWith("Planned"), `omitting request/mode must still plan: ${defaultRes.content}`)
  assert(!existsSync(requestFileOf(defaultRun)), "omitting request must create no ORIGINAL_REQUEST.md")
  assert.strictEqual(JSON.parse(readFileSync(planFileOf(defaultRun), "utf8")).integrityMode, "development", "omitted mode defaults to development in plan.dag.json")
  assert.strictEqual(JSON.parse(readFileSync(stateFileOf(defaultRun), "utf8")).integrityMode, "development", "omitted mode defaults to development in state.json")

  // (e) the audit reads the mode from the artifact, not from its caller.
  const demoRun = "20261018-000000-audit-demo"
  await registeredTools.plan.execute({
    sessionId: demoRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "Demo the feature.\n\n- Integrity mode: benchmark",
    integrityMode: "demo",
    tasks: [{ id: "A1" }],
  })
  const demoAudit = await registeredTools.security_audit.execute({ sessionId: demoRun, status: "PASS", findings: [] })
  const demoReport = JSON.parse(readFileSync(runFile(testDir, demoRun, "verify/security-audit.json"), "utf8"))
  assert.strictEqual(demoReport.integrityMode, "demo", "security-audit.json must record the artifact's header mode, not a body line")
  assert(demoAudit.content.includes("demo"), "the audit result must mention the mode")

  // A legacy run (no request artifact) defaults to development and says so.
  const legacyAuditRun = "20261018-000000-audit-legacy"
  await registeredTools.plan.execute({ sessionId: legacyAuditRun, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "A2" }] })
  const legacyAudit = await registeredTools.security_audit.execute({ sessionId: legacyAuditRun, status: "PASS", findings: [] })
  const legacyReport = JSON.parse(readFileSync(runFile(testDir, legacyAuditRun, "verify/security-audit.json"), "utf8"))
  assert.strictEqual(legacyReport.integrityMode, "development", "a legacy run must record the development default")
  assert(/default/i.test(legacyAudit.content), "a legacy run must say the default was applied")

  // (f) final-gate responses carry the mode read from the artifact.
  const gateRun = "20261018-000000-gate-demo"
  await registeredTools.plan.execute({
    sessionId: gateRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "Ship the demo.",
    integrityMode: "demo",
    tasks: [{ id: "G1" }],
  })
  for (const status of ["worker_active", "worker_done", "verifier_active"]) {
    await registeredTools.task_update.execute({ sessionId: gateRun, taskId: "G1", status })
  }
  await registeredTools.task_update.execute({
    sessionId: gateRun,
    taskId: "G1",
    status: "verified_pass",
    verification: { status: "PASS" },
  })
  await registeredTools.security_audit.execute({ sessionId: gateRun, status: "PASS", findings: [] })

  const gateFinal = runFile(testDir, gateRun, "verify/final.json")
  let gateRes = await registeredTools.next.execute({ sessionId: gateRun })
  assert.strictEqual(gateRes.status, "READY_FOR_FINAL_VERIFICATION")
  assert.strictEqual(gateRes.integrityMode, "demo", "READY_FOR_FINAL_VERIFICATION must carry integrityMode")
  assert(gateRes.content.includes("Integrity mode: demo"), `READY message must mention the mode: ${gateRes.content}`)

  mkdirSync(dirname(gateFinal), { recursive: true })
  writeFileSync(gateFinal, JSON.stringify({ status: "FAIL", summary: "not yet" }) + "\n")
  gateRes = await registeredTools.next.execute({ sessionId: gateRun })
  assert.strictEqual(gateRes.status, "BLOCKED_BY_FINAL_VERIFICATION")
  assert.strictEqual(gateRes.integrityMode, "demo", "BLOCKED_BY_FINAL_VERIFICATION must carry integrityMode")
  assert(gateRes.content.includes("Integrity mode: demo"), `BLOCKED message must mention the mode: ${gateRes.content}`)

  // The gate demo's report is hand-written, so reaching ALL_PASSED here takes
  // the explicit bypass (the default refusal is covered in Part 1c(c) above).
  writeFileSync(gateFinal, JSON.stringify({ status: "PASS", summary: "ok" }) + "\n")
  gateRes = await registeredTools.next.execute({ sessionId: gateRun })
  assert.strictEqual(gateRes.status, "FINAL_VERIFICATION_UNVERIFIED", "a hand-written PASS must be refused by default")
  gateRes = await registeredTools.next.execute({ sessionId: gateRun, allowUnstamped: true })
  assert.strictEqual(gateRes.status, "ALL_PASSED")
  assert.strictEqual(gateRes.stamped, false, "the bypassed verdict must not claim to be stamped")
  assert.strictEqual(gateRes.integrityMode, "demo", "ALL_PASSED must carry integrityMode")
  assert(gateRes.content.includes("Integrity mode: demo"), `ALL_PASSED message must mention the mode: ${gateRes.content}`)

  console.log("✓ request recorded verbatim once, modes validated/persisted, audit & final gate read the artifact")

  // ==========================================
  // Part 1c-quinquies: input preflight gate
  // ==========================================
  console.log("Testing the input preflight gate...")

  const existingInput = join(testDir, "preflight-existing.txt")
  writeFileSync(existingInput, "present\n")
  const missingAbs = join(testDir, "preflight-does-not-exist.txt")
  assert(!existsSync(missingAbs), "fixture: the missing path must not exist")

  // (a) an existing absolute path named by the request -> READY, plan proceeds.
  const pfReadyRun = "20261018-000000-preflight-ready"
  const pfReady = await registeredTools.plan.execute({
    sessionId: pfReadyRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: `Read ${existingInput} before planning`,
    tasks: [{ id: "PF1" }],
  })
  assert(pfReady.content.startsWith("Planned"), `an existing input must not block: ${pfReady.content}`)
  assert(/Preflight: READY/.test(pfReady.content), `the plan result must report the preflight: ${pfReady.content}`)
  const pfReadyPlan = JSON.parse(readFileSync(planFileOf(pfReadyRun), "utf8"))
  assert.deepStrictEqual(pfReadyPlan.preflight, { status: "READY", bypassed: false }, "a READY preflight must be recorded in plan.dag.json")

  // (b) an absolute path named by the request that does not exist -> refused, no run dir.
  const pfMissingRun = "20261018-000000-preflight-missing"
  const pfMissing = await registeredTools.plan.execute({
    sessionId: pfMissingRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: `Read ${missingAbs} before planning`,
    tasks: [{ id: "PF1" }],
  })
  assert(pfMissing.content.startsWith("refused:"), `a missing absolute input must be refused: ${pfMissing.content}`)
  assert(/MISSING/.test(pfMissing.content), "the refusal must name the item status")
  assert(pfMissing.content.includes(missingAbs), "the refusal must name the missing path")
  assert(!existsSync(join(testDir, ".opencode", "teamwork", pfMissingRun)), "a preflight refusal must create no run directory")

  // (c) a missing entry in the explicit `inputs` array -> refused.
  const pfExplicitRun = "20261018-000000-preflight-explicit"
  const pfExplicit = await registeredTools.plan.execute({
    sessionId: pfExplicitRun,
    topology: "iterative-coding",
    skipInterview: true,
    inputs: [missingAbs],
    tasks: [{ id: "PF1" }],
  })
  assert(pfExplicit.content.startsWith("refused:"), `a missing explicit input must be refused: ${pfExplicit.content}`)
  assert(pfExplicit.content.includes(missingAbs), "the refusal must name the explicit input")
  assert(!existsSync(join(testDir, ".opencode", "teamwork", pfExplicitRun)), "an explicit-input refusal must create no run directory")

  // (d) the same missing input with allowMissingInputs: true -> planned + recorded bypass.
  const pfBypassRun = "20261018-000000-preflight-bypass"
  const pfBypass = await registeredTools.plan.execute({
    sessionId: pfBypassRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: `Read ${missingAbs} before planning`,
    allowMissingInputs: true,
    tasks: [{ id: "PF1" }],
  })
  assert(pfBypass.content.startsWith("Planned"), `allowMissingInputs must permit the plan: ${pfBypass.content}`)
  assert(/Preflight: MISSING \(bypassed: allowMissingInputs\)/.test(pfBypass.content), `the bypass must be visible: ${pfBypass.content}`)
  const pfBypassPlan = JSON.parse(readFileSync(planFileOf(pfBypassRun), "utf8"))
  assert.deepStrictEqual(pfBypassPlan.preflight, { status: "MISSING", bypassed: true }, "the bypass must be persisted in plan.dag.json")
  const pfBypassCreated = readEvents(testDir, pfBypassRun).find((e) => e.event === "run_created")
  assert(/preflight bypassed: MISSING \(1 item\)/.test(pfBypassCreated.note), `run_created must note the bypass: ${pfBypassCreated.note}`)

  // (e) a relative path-like token that does not exist is advisory only.
  const pfAdvisoryRun = "20261018-000000-preflight-advisory"
  const pfAdvisory = await registeredTools.plan.execute({
    sessionId: pfAdvisoryRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "Review nonexistent/advisory-only.md before planning",
    tasks: [{ id: "PF1" }],
  })
  assert(pfAdvisory.content.startsWith("Planned"), `an advisory path must never block: ${pfAdvisory.content}`)
  assert(
    /advisory path missing \(non-blocking\): nonexistent\/advisory-only\.md/.test(pfAdvisory.content),
    `the advisory miss must be reported: ${pfAdvisory.content}`,
  )
  const pfAdvisoryPlan = JSON.parse(readFileSync(planFileOf(pfAdvisoryRun), "utf8"))
  assert.deepStrictEqual(pfAdvisoryPlan.preflight, { status: "READY", bypassed: false }, "an advisory miss must leave the status READY")

  // (f) a URL is UNCHECKED by default, and the plan proceeds.
  const pfUncheckedRun = "20261018-000000-preflight-unchecked"
  const uncheckedUrl = "http://127.0.0.1:1/unchecked"
  const pfUnchecked = await registeredTools.plan.execute({
    sessionId: pfUncheckedRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: `Watch ${uncheckedUrl} before planning`,
    tasks: [{ id: "PF1" }],
  })
  assert(pfUnchecked.content.startsWith("Planned"), `an unchecked URL must not block: ${pfUnchecked.content}`)
  assert(/1 unchecked/.test(pfUnchecked.content), `the plan result must report the unchecked URL: ${pfUnchecked.content}`)
  assert.deepStrictEqual(JSON.parse(readFileSync(planFileOf(pfUncheckedRun), "utf8")).preflight, { status: "READY", bypassed: false })

  // (g) URL checking against a local server (no internet): 200 is READY,
  // 500 and connection refused are OUTAGE and refuse the plan.
  let preflightServer
  const stopServer = (server) =>
    new Promise((resolve) => {
      server.close(resolve)
      if (typeof server.closeAllConnections === "function") server.closeAllConnections()
    })
  try {
    preflightServer = createServer((req, res) => {
      res.writeHead(req.url === "/ok" ? 200 : 500)
      res.end()
    })
    await new Promise((resolve) => preflightServer.listen(0, "127.0.0.1", resolve))
    const port = preflightServer.address().port
    const base = `http://127.0.0.1:${port}`

    const pfUrlOkRun = "20261018-000000-preflight-url-ok"
    const pfUrlOk = await registeredTools.plan.execute({
      sessionId: pfUrlOkRun,
      topology: "iterative-coding",
      skipInterview: true,
      request: `Fetch ${base}/ok before planning`,
      checkUrls: true,
      tasks: [{ id: "PF1" }],
    })
    assert(pfUrlOk.content.startsWith("Planned"), `a 200 URL must be READY: ${pfUrlOk.content}`)
    assert.deepStrictEqual(JSON.parse(readFileSync(planFileOf(pfUrlOkRun), "utf8")).preflight, { status: "READY", bypassed: false })

    const pfUrlFailRun = "20261018-000000-preflight-url-500"
    const pfUrlFail = await registeredTools.plan.execute({
      sessionId: pfUrlFailRun,
      topology: "iterative-coding",
      skipInterview: true,
      request: `Fetch ${base}/fail before planning`,
      checkUrls: true,
      tasks: [{ id: "PF1" }],
    })
    assert(pfUrlFail.content.startsWith("refused:"), `a 500 URL must be OUTAGE and refuse the plan: ${pfUrlFail.content}`)
    assert(/OUTAGE/.test(pfUrlFail.content) && pfUrlFail.content.includes(`${base}/fail`), "the refusal must name the outage")
    assert(!existsSync(join(testDir, ".opencode", "teamwork", pfUrlFailRun)), "a URL refusal must create no run directory")

    // Closing the listener makes the same port refuse connections.
    await stopServer(preflightServer)
    preflightServer = undefined
    const pfUrlDownRun = "20261018-000000-preflight-url-down"
    const pfUrlDown = await registeredTools.plan.execute({
      sessionId: pfUrlDownRun,
      topology: "iterative-coding",
      skipInterview: true,
      request: `Fetch ${base}/down before planning`,
      checkUrls: true,
      tasks: [{ id: "PF1" }],
    })
    assert(pfUrlDown.content.startsWith("refused:"), `a refused connection must be OUTAGE and refuse the plan: ${pfUrlDown.content}`)
    assert(/OUTAGE/.test(pfUrlDown.content), "the refusal must name the outage")
    assert(!existsSync(join(testDir, ".opencode", "teamwork", pfUrlDownRun)), "a connection refusal must create no run directory")
  } finally {
    if (preflightServer) await stopServer(preflightServer)
  }

  // Standalone teamwork_preflight: re-reads ORIGINAL_REQUEST.md, writes
  // preflight.json, and appends a preflight event (with a note when missing).
  const standaloneMissing = join(testDir, "preflight-standalone-missing.txt")
  const standalone = await registeredTools.preflight.execute({
    sessionId: pfReadyRun,
    inputs: [standaloneMissing],
  })
  assert.strictEqual(standalone.status, "MISSING", `the standalone report must sum to MISSING: ${standalone.content}`)
  const standaloneReport = JSON.parse(readFileSync(runFile(testDir, pfReadyRun, "preflight.json"), "utf8"))
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(standaloneReport.checkedAt), "checkedAt must be ISO8601 UTC")
  assert.strictEqual(standaloneReport.integrityMode, "development", "preflight.json must record the run's integrity mode")
  assert.strictEqual(standaloneReport.summary.status, "MISSING")
  assert(
    standaloneReport.items.some((i) => i.value === existingInput && i.status === "READY" && i.detail === "file"),
    "the recorded request's input must be re-read from ORIGINAL_REQUEST.md",
  )
  assert(
    standaloneReport.items.some((i) => i.value === standaloneMissing && i.status === "MISSING" && i.blocking === true),
    "the explicit missing input must be reported as blocking",
  )
  const standaloneEvent = readEvents(testDir, pfReadyRun).find((e) => e.event === "preflight")
  assert(standaloneEvent, "teamwork_preflight must append a preflight event")
  assert.strictEqual(standaloneEvent.to, "MISSING", "the preflight event must record the status")
  assert(/missing|unreachable/i.test(standaloneEvent.note), `the preflight event must note the miss: ${standaloneEvent.note}`)

  console.log("✓ preflight blocks missing/outage inputs, ignores advisory paths, checks localhost URLs, records bypass; standalone tool writes preflight.json")

  // ==========================================
  // Part 1c-ter: final_verify tool
  // ==========================================
  console.log("Testing the final_verify tool...")

  const reportFileOf = (runId, taskId) => runFile(testDir, runId, `verify/report-${taskId}.json`)
  const writeTaskReport = (runId, taskId, status = "PASS") => {
    const file = reportFileOf(runId, taskId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ taskId, status, timestamp: new Date().toISOString() }) + "\n")
  }
  const seedVerifiedRun = async (runId, taskIds, { request, integrityMode, auditStatus = "PASS" } = {}) => {
    await registeredTools.plan.execute({
      sessionId: runId,
      topology: "iterative-coding",
      skipInterview: true,
      ...(request !== undefined ? { request, integrityMode } : {}),
      tasks: taskIds.map((id) => ({ id })),
    })
    for (const taskId of taskIds) {
      for (const status of ["worker_active", "worker_done", "verifier_active"]) {
        await registeredTools.task_update.execute({ sessionId: runId, taskId, status })
      }
      await registeredTools.task_update.execute({
        sessionId: runId,
        taskId,
        status: "verified_pass",
        verification: { status: "PASS" },
      })
      writeTaskReport(runId, taskId, "PASS")
    }
    await registeredTools.security_audit.execute({
      sessionId: runId,
      status: auditStatus,
      findings: auditStatus === "FAIL" ? [{ severity: "Critical", description: "hardcoded secret" }] : [],
    })
  }
  const finalFileOf = (runId) => runFile(testDir, runId, "verify/final.json")

  // (a) All tasks verified_pass + every report PASS + audit PASS -> PASS, stamped, event appended.
  const fvPassRun = "20261018-000000-fv-pass"
  await seedVerifiedRun(fvPassRun, ["F1", "F2"])
  assert(!existsSync(runFile(testDir, fvPassRun, "ORIGINAL_REQUEST.md")), "fixture run must have no request artifact")
  const fvPassEventsBefore = readEvents(testDir, fvPassRun).length
  const fvPass = await registeredTools.final_verify.execute(
    { sessionId: fvPassRun, summary: "  All acceptance criteria met.  " },
    { sessionID: "ses_final_verify" },
  )
  assert.strictEqual(fvPass.status, "PASS", `complete evidence must PASS: ${fvPass.content}`)
  assert.strictEqual(fvPass.finalReport, finalFileOf(fvPassRun), "the result must name verify/final.json")
  assert(fvPass.content.includes("FINAL VERIFICATION PASSED"), `result must state the verdict: ${fvPass.content}`)
  assert(fvPass.content.includes("development"), "result must state the integrity mode")
  const fvPassReport = JSON.parse(readFileSync(finalFileOf(fvPassRun), "utf8"))
  assert.strictEqual(fvPassReport.status, "PASS", "verify/final.json must record PASS")
  assert.strictEqual(fvPassReport.generatedBy.session, "ses_final_verify", "generatedBy.session must record the calling session")
  assert.strictEqual(fvPassReport.generatedBy.agent, null, "no session agent is available in this test")
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fvPassReport.generatedAt), "generatedAt must be ISO8601 UTC")
  assert.strictEqual(fvPassReport.integrityMode, "development", "a run with no request artifact defaults to development")
  assert.strictEqual(fvPassReport.summary, "All acceptance criteria met.", "summary must be cleaned and recorded")
  assert.deepStrictEqual(
    fvPassReport.evidence.tasks,
    [
      { id: "F1", status: "verified_pass", report: "verify/report-F1.json", reportStatus: "PASS" },
      { id: "F2", status: "verified_pass", report: "verify/report-F2.json", reportStatus: "PASS" },
    ],
    "evidence.tasks must list each task id with its report path and status",
  )
  assert.deepStrictEqual(
    fvPassReport.evidence.securityAudit,
    { path: "verify/security-audit.json", status: "PASS" },
    "evidence must record the security audit",
  )
  assert.strictEqual(fvPassReport.evidence.allTasksVerifiedPass, true)
  assert.deepStrictEqual(fvPassReport.reasons, [], "a PASS verdict carries no reasons")
  const fvPassEvents = readEvents(testDir, fvPassRun)
  assert.strictEqual(fvPassEvents.length, fvPassEventsBefore + 1, "final_verify must append exactly one event")
  const fvEvent = fvPassEvents[fvPassEvents.length - 1]
  assert.strictEqual(fvEvent.event, "final_verification", "the event must be final_verification")
  assert.strictEqual(fvEvent.to, "PASS")
  assert.strictEqual(fvEvent.taskId, null)
  assert.strictEqual(fvEvent.round, 0)
  assert.strictEqual(typeof fvEvent.seq, "number", "the event must carry an engine-assigned seq")
  assert(fvEvent.seq > 0, "seq must be positive")

  // (h) The stamped PASS completes the run: ALL_PASSED with stamped: true.
  const fvStampedGate = await registeredTools.next.execute({ sessionId: fvPassRun })
  assert.strictEqual(fvStampedGate.status, "ALL_PASSED", `a stamped PASS must complete the run: ${fvStampedGate.content}`)
  assert.strictEqual(fvStampedGate.stamped, true, "a stamped verdict must report stamped: true")
  assert.notStrictEqual(fvStampedGate.unstampedBypass, true, "a stamped verdict is not a bypass")
  assert.strictEqual(fvStampedGate.finalReport, finalFileOf(fvPassRun))
  assert.strictEqual(fvStampedGate.integrityMode, "development")
  assert.strictEqual(JSON.parse(readFileSync(runFile(testDir, fvPassRun, "state.json"), "utf8")).phase, "MERGE")

  // (i) A hand-written PASS (no stamp) cannot complete the run by default.
  const fvHandRun = "20261018-000000-fv-handwritten"
  await seedVerifiedRun(fvHandRun, ["F1"])
  const fvHandFile = finalFileOf(fvHandRun)
  mkdirSync(dirname(fvHandFile), { recursive: true })
  writeFileSync(fvHandFile, JSON.stringify({ status: "PASS", summary: "looks fine to me" }) + "\n")
  const fvHandDefault = await registeredTools.next.execute({ sessionId: fvHandRun })
  assert.strictEqual(
    fvHandDefault.status,
    "FINAL_VERIFICATION_UNVERIFIED",
    `an unstamped PASS must be refused by default: ${fvHandDefault.content}`,
  )
  assert.strictEqual(fvHandDefault.finalReport, fvHandFile)
  assert.strictEqual(fvHandDefault.integrityMode, "development")
  assert(/teamwork_final_verify/.test(fvHandDefault.content), "the message must point at teamwork_final_verify")
  assert(/allowUnstamped/.test(fvHandDefault.content), "the message must name the legacy bypass")
  assert.strictEqual(
    JSON.parse(readFileSync(runFile(testDir, fvHandRun, "state.json"), "utf8")).phase,
    "FINAL_VERIFICATION",
    "an unstamped PASS must leave the run in FINAL_VERIFICATION",
  )

  // (j) The same report with allowUnstamped: true completes, flagged and recorded.
  const fvHandBypass = await registeredTools.next.execute({ sessionId: fvHandRun, allowUnstamped: true })
  assert.strictEqual(fvHandBypass.status, "ALL_PASSED", `allowUnstamped must complete the run: ${fvHandBypass.content}`)
  assert.strictEqual(fvHandBypass.stamped, false, "a bypassed verdict must report stamped: false")
  assert.strictEqual(fvHandBypass.unstampedBypass, true, "a bypassed verdict must report unstampedBypass: true")
  assert(/not produced by teamwork_final_verify/.test(fvHandBypass.content), "the message must state the verdict was not tool-produced")
  assert.strictEqual(
    JSON.parse(readFileSync(runFile(testDir, fvHandRun, "state.json"), "utf8")).phase,
    "MERGE",
    "the recorded bypass advances the run to MERGE",
  )
  const bypassEvent = readEvents(testDir, fvHandRun).filter((e) => e.event === "final_verification_bypass").pop()
  assert(bypassEvent, "the bypass must be recorded as a final_verification_bypass event")
  assert.strictEqual(bypassEvent.to, "ALL_PASSED")
  assert.strictEqual(bypassEvent.taskId, null)
  assert.strictEqual(bypassEvent.phase, "MERGE")
  assert.strictEqual(typeof bypassEvent.note, "string", "the bypass event must carry a note")
  assert(bypassEvent.note.includes("allowUnstamped"), `the note must explain the bypass: ${bypassEvent.note}`)
  assert.strictEqual(typeof bypassEvent.seq, "number", "the bypass event must carry an engine-assigned seq")
  assert(bypassEvent.seq > 0, "the bypass event seq must be positive")
  assert.strictEqual(bypassEvent.agent, null, "no session agent is available in this test")

  // (k) A report with provenance but no evidence is still unstamped.
  const fvNoEvidenceRun = "20261018-000000-fv-noevidence"
  await seedVerifiedRun(fvNoEvidenceRun, ["F1"])
  writeFileSync(
    finalFileOf(fvNoEvidenceRun),
    JSON.stringify({
      status: "PASS",
      generatedBy: { agent: "team/verifier", session: "ses_handwritten" },
      generatedAt: new Date().toISOString(),
      integrityMode: "development",
      reasons: [],
    }) + "\n",
  )
  const fvNoEvidence = await registeredTools.next.execute({ sessionId: fvNoEvidenceRun })
  assert.strictEqual(
    fvNoEvidence.status,
    "FINAL_VERIFICATION_UNVERIFIED",
    `a report without evidence must be refused by default: ${fvNoEvidence.content}`,
  )

  // (l) A stamped FAIL still blocks the run (unchanged behaviour).
  const fvStampedFailRun = "20261018-000000-fv-stampedfail"
  await seedVerifiedRun(fvStampedFailRun, ["F1"])
  const fvStampedFail = await registeredTools.final_verify.execute({
    sessionId: fvStampedFailRun,
    failReason: "acceptance criterion 1 is unmet",
  })
  assert.strictEqual(fvStampedFail.status, "FAIL")
  const fvStampedFailGate = await registeredTools.next.execute({ sessionId: fvStampedFailRun })
  assert.strictEqual(
    fvStampedFailGate.status,
    "BLOCKED_BY_FINAL_VERIFICATION",
    "a stamped FAIL must still block the run",
  )
  assert.notStrictEqual(fvStampedFailGate.status, "ALL_PASSED")

  // (b) A missing task report -> FAIL naming the task; the written file is FAIL too.
  const fvMissingRun = "20261018-000000-fv-missing"
  await seedVerifiedRun(fvMissingRun, ["F1", "F2"])
  rmSync(reportFileOf(fvMissingRun, "F2"))
  const fvMissing = await registeredTools.final_verify.execute({ sessionId: fvMissingRun })
  assert.strictEqual(fvMissing.status, "FAIL", `a missing report must FAIL: ${fvMissing.content}`)
  assert(
    fvMissing.reasons.some((r) => r.includes("F2") && r.includes("MISSING")),
    `the reason must name the task and the missing report: ${JSON.stringify(fvMissing.reasons)}`,
  )
  assert(fvMissing.content.includes("F2") && fvMissing.content.includes("MISSING"), "the message must state the reason")
  assert.strictEqual(JSON.parse(readFileSync(finalFileOf(fvMissingRun), "utf8")).status, "FAIL", "the file must be written as FAIL")

  // (f) Re-running cannot upgrade a FAIL file while the evidence still fails.
  const fvSecond = await registeredTools.final_verify.execute({ sessionId: fvMissingRun })
  assert.strictEqual(fvSecond.status, "FAIL", "a second call must recompute FAIL, not trust the previous call")
  assert.strictEqual(
    JSON.parse(readFileSync(finalFileOf(fvMissingRun), "utf8")).status,
    "FAIL",
    "a second call must not upgrade the artifact to PASS",
  )

  // (c) Security audit FAIL -> FAIL.
  const fvAuditRun = "20261018-000000-fv-auditfail"
  await seedVerifiedRun(fvAuditRun, ["F1"], { auditStatus: "FAIL" })
  const fvAudit = await registeredTools.final_verify.execute({ sessionId: fvAuditRun })
  assert.strictEqual(fvAudit.status, "FAIL", `a FAIL audit must FAIL the verdict: ${fvAudit.content}`)
  assert(
    fvAudit.reasons.some((r) => r.startsWith("security audit:") && r.includes("FAIL")),
    `the reason must name the security audit: ${JSON.stringify(fvAudit.reasons)}`,
  )
  assert.strictEqual(JSON.parse(readFileSync(finalFileOf(fvAuditRun), "utf8")).status, "FAIL")

  // (d) A task that is not verified_pass -> FAIL.
  const fvPendingRun = "20261018-000000-fv-notpassed"
  await registeredTools.plan.execute({ sessionId: fvPendingRun, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "F1" }] })
  writeTaskReport(fvPendingRun, "F1", "PASS")
  await registeredTools.security_audit.execute({ sessionId: fvPendingRun, status: "PASS", findings: [] })
  const fvPending = await registeredTools.final_verify.execute({ sessionId: fvPendingRun })
  assert.strictEqual(fvPending.status, "FAIL", `an unverified task must FAIL: ${fvPending.content}`)
  assert(
    fvPending.reasons.some((r) => r.includes("F1") && r.includes("pending")),
    `the reason must name the task and its status: ${JSON.stringify(fvPending.reasons)}`,
  )
  assert.strictEqual(JSON.parse(readFileSync(finalFileOf(fvPendingRun), "utf8")).status, "FAIL")

  // (e) failReason forces FAIL even when the evidence is all PASS.
  const fvForced = await registeredTools.final_verify.execute({
    sessionId: fvPassRun,
    failReason: "acceptance criterion 2 is unmet",
  })
  assert.strictEqual(fvForced.status, "FAIL", "failReason must force FAIL despite PASS evidence")
  assert(fvForced.reasons.includes("acceptance criterion 2 is unmet"), "failReason must be appended to reasons")
  assert.strictEqual(JSON.parse(readFileSync(finalFileOf(fvPassRun), "utf8")).status, "FAIL", "the forced FAIL must be written")

  // (g) integrityMode comes from ORIGINAL_REQUEST.md when present, else development.
  const fvBenchRun = "20261018-000000-fv-benchmark"
  await seedVerifiedRun(fvBenchRun, ["F1"], { request: "Ship it.", integrityMode: "benchmark" })
  const fvBench = await registeredTools.final_verify.execute({ sessionId: fvBenchRun })
  assert.strictEqual(fvBench.status, "PASS", `complete benchmark evidence must PASS: ${fvBench.content}`)
  assert.strictEqual(fvBench.integrityMode, "benchmark", "the result must carry the artifact's mode")
  assert(fvBench.content.includes("benchmark"), "the message must state the artifact's mode")
  assert.strictEqual(
    JSON.parse(readFileSync(finalFileOf(fvBenchRun), "utf8")).integrityMode,
    "benchmark",
    "verify/final.json must record the artifact's mode",
  )

  console.log("✓ final_verify computes PASS only from evidence, stamps provenance + seq, and cannot be overridden")

  // ==========================================
  // Part 1c-quater: integrity mode enforcement
  // ==========================================
  console.log("Testing integrity mode enforcement...")

  const INTEGRITY_RULES = {
    fabricated_output: "development",
    core_logic_copied: "demo",
    delegated_core_work: "demo",
    test_source_read: "demo",
    external_dependency_used: "benchmark",
  }
  const MODE_ORDER = ["development", "demo", "benchmark"]
  const forbiddenAt = (rule, mode) => MODE_ORDER.indexOf(mode) >= MODE_ORDER.indexOf(INTEGRITY_RULES[rule])
  const auditFileOf = (runId) => runFile(testDir, runId, "verify/security-audit.json")

  // One run per mode, each with its mode recorded in ORIGINAL_REQUEST.md.
  const modeRuns = {}
  for (const mode of MODE_ORDER) {
    const runId = `20261018-000000-integrity-${mode}`
    const planned = await registeredTools.plan.execute({
      sessionId: runId,
      topology: "iterative-coding",
      skipInterview: true,
      request: `Run at ${mode}.`,
      integrityMode: mode,
      tasks: [{ id: "I1" }],
    })
    assert(planned.content.startsWith("Planned"), `integrity fixture ${mode} must plan: ${planned.content}`)
    modeRuns[mode] = runId
  }

  // Full 5 rules x 3 modes matrix, driven by the table (15 cases).
  let matrixCases = 0
  for (const mode of MODE_ORDER) {
    for (const rule of Object.keys(INTEGRITY_RULES)) {
      const res = await registeredTools.security_audit.execute({
        sessionId: modeRuns[mode],
        status: "PASS",
        findings: [],
        integrityFindings: [{ rule, where: "src/core.ts:1", why: "reported by the auditor" }],
      })
      const expected = forbiddenAt(rule, mode) ? "FAIL" : "PASS"
      assert.strictEqual(res.status, expected, `${rule} at ${mode} must be ${expected}: ${res.content}`)
      const report = JSON.parse(readFileSync(auditFileOf(modeRuns[mode]), "utf8"))
      assert.strictEqual(report.status, expected, `${rule} at ${mode}: artifact status must be ${expected}`)
      assert.strictEqual(report.integrityMode, mode, `${rule} at ${mode}: artifact must record the run's mode`)
      assert.strictEqual(report.integrityFindings.length, 1, "the supplied finding must be persisted as-is")
      assert.strictEqual(report.integrityFindings[0].rule, rule)
      assert.strictEqual(
        report.integrityViolations.length,
        expected === "FAIL" ? 1 : 0,
        `${rule} at ${mode}: violations must be the forbidden subset only`,
      )
      if (expected === "FAIL") {
        const violation = report.integrityViolations[0]
        assert.strictEqual(violation.rule, rule)
        assert.strictEqual(violation.forbiddenFrom, INTEGRITY_RULES[rule], "the violation must carry its threshold")
        assert.strictEqual(violation.where, "src/core.ts:1")
        assert.strictEqual(violation.why, "reported by the auditor")
        assert(res.content.includes(rule), `the FAIL message must name ${rule}: ${res.content}`)
        assert(res.content.includes(mode), `the FAIL message must name the mode ${mode}: ${res.content}`)
      }
      matrixCases++
    }
  }
  assert.strictEqual(matrixCases, 15, "the matrix must cover 5 rules x 3 modes")

  // A non-forbidden finding is recorded but never becomes a violation.
  const nonForbidden = await registeredTools.security_audit.execute({
    sessionId: modeRuns.demo,
    status: "PASS",
    findings: [],
    integrityFindings: [{ rule: "external_dependency_used", where: "package.json:5", why: "uses a library" }],
  })
  assert.strictEqual(nonForbidden.status, "PASS", "a benchmark-only rule must not fail a demo run")
  const nonForbiddenReport = JSON.parse(readFileSync(auditFileOf(modeRuns.demo), "utf8"))
  assert.strictEqual(nonForbiddenReport.integrityFindings[0].rule, "external_dependency_used")
  assert.deepStrictEqual(nonForbiddenReport.integrityViolations, [], "a non-forbidden rule must not be a violation")

  // The input is capped at 50 findings.
  const capped = await registeredTools.security_audit.execute({
    sessionId: modeRuns.development,
    status: "PASS",
    findings: [],
    integrityFindings: Array.from({ length: 51 }, (_, i) => ({ rule: "fabricated_output", where: `f${i}` })),
  })
  assert.strictEqual(capped.status, "FAIL")
  assert.strictEqual(JSON.parse(readFileSync(auditFileOf(modeRuns.development), "utf8")).integrityFindings.length, 50, "at most 50 findings are persisted")

  // An unknown rule id is refused before anything is written.
  const unknownRun = "20261018-000000-integrity-unknown"
  await registeredTools.plan.execute({
    sessionId: unknownRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "Unknown rule.",
    integrityMode: "development",
    tasks: [{ id: "I1" }],
  })
  assert(!existsSync(auditFileOf(unknownRun)), "fixture must start with no audit artifact")
  const unknownRule = await registeredTools.security_audit.execute({
    sessionId: unknownRun,
    status: "PASS",
    findings: [],
    integrityFindings: [{ rule: "made_up_rule" }],
  })
  assert(unknownRule.content.startsWith("refused: unknown integrity rule"), `an unknown rule must be refused: ${unknownRule.content}`)
  for (const rule of Object.keys(INTEGRITY_RULES)) {
    assert(unknownRule.content.includes(rule), `the refusal must list ${rule}: ${unknownRule.content}`)
  }
  assert(!existsSync(auditFileOf(unknownRun)), "an unknown rule must write no artifact")

  // End-to-end: a violation forces the audit FAIL, and final_verify inherits it.
  const enforceRun = "20261018-000000-integrity-final"
  await seedVerifiedRun(enforceRun, ["I1"], { request: "Ship the demo.", integrityMode: "demo" })
  const enforceAudit = await registeredTools.security_audit.execute({
    sessionId: enforceRun,
    status: "PASS",
    findings: [],
    integrityFindings: [{ rule: "delegated_core_work", where: "src/gen.ts:9", why: "core produced by an external tool" }],
  })
  assert.strictEqual(enforceAudit.status, "FAIL", "a forbidden finding must force FAIL despite status PASS")
  const enforceReport = JSON.parse(readFileSync(auditFileOf(enforceRun), "utf8"))
  assert.strictEqual(enforceReport.status, "FAIL")
  assert.strictEqual(enforceReport.integrityMode, "demo", "the artifact must record the run's mode")
  assert(
    enforceReport.integrityViolations.some((v) => v.rule === "delegated_core_work" && v.forbiddenFrom === "demo"),
    "the artifact must persist the rule and its threshold",
  )
  const enforceFinal = await registeredTools.final_verify.execute({ sessionId: enforceRun })
  assert.strictEqual(enforceFinal.status, "FAIL", `final_verify must inherit the audit failure: ${enforceFinal.content}`)
  assert(
    enforceFinal.reasons.some((r) => r.startsWith("security audit:") && r.includes("FAIL")),
    `final_verify must name the security audit: ${JSON.stringify(enforceFinal.reasons)}`,
  )
  const enforceGate = await registeredTools.next.execute({ sessionId: enforceRun })
  assert.strictEqual(enforceGate.status, "BLOCKED_BY_SECURITY", "the run must stay blocked after a violation")
  assert.notStrictEqual(enforceGate.status, "ALL_PASSED")

  console.log("✓ integrity findings enforced per mode, violations persisted with threshold, unknown rules refused")

  // ==========================================
  // Part 1d: Transition graph + evidence for verified_pass
  // ==========================================
  console.log("Testing task transition graph & verified_pass evidence...")

  const transitionRun = "20261018-000000-transitions"
  await registeredTools.plan.execute({
    sessionId: transitionRun,
    topology: "iterative-coding",
    skipInterview: true,
    tasks: [{ id: "G1" }, { id: "G2" }],
  })
  const transitionState = stateFileOf(transitionRun)

  // (d) pending -> verified_pass is refused, even with inline PASS evidence.
  const jump = await registeredTools.task_update.execute({
    sessionId: transitionRun,
    taskId: "G1",
    status: "verified_pass",
    verification: { status: "PASS" },
  })
  assert(jump.content.startsWith("Error: Illegal transition"), `pending -> verified_pass must be refused: ${jump.content}`)
  assert(jump.content.includes("worker_active") && jump.content.includes("blocked"), `refusal must list allowed next states: ${jump.content}`)
  assert.strictEqual(JSON.parse(readFileSync(transitionState, "utf8")).tasks.G1.status, "pending", "a refused transition must not be persisted")

  for (const status of ["worker_active", "worker_done", "verifier_active"]) {
    const r = await registeredTools.task_update.execute({ sessionId: transitionRun, taskId: "G1", status })
    assert(r.content.includes("updated"), `legal ${status} transition must succeed: ${r.content}`)
  }

  // (e) verifier_active -> verified_pass without evidence is refused.
  const noEvidence = await registeredTools.task_update.execute({
    sessionId: transitionRun,
    taskId: "G1",
    status: "verified_pass",
  })
  assert(noEvidence.content.startsWith("Error: Refusing verified_pass"), `evidence-free verified_pass must be refused: ${noEvidence.content}`)
  assert(noEvidence.content.includes("verification.status") && noEvidence.content.includes("report-G1.json"), `refusal must name both evidence paths: ${noEvidence.content}`)
  assert.strictEqual(JSON.parse(readFileSync(transitionState, "utf8")).tasks.G1.status, "verifier_active", "refusal must leave state unchanged")

  // (f) verifier_active -> verified_pass with an inline PASS is accepted.
  const withEvidence = await registeredTools.task_update.execute({
    sessionId: transitionRun,
    taskId: "G1",
    status: "verified_pass",
    verification: { status: "PASS", passedChecks: 2, totalChecks: 2 },
  })
  assert.strictEqual(withEvidence.status, "verified_pass", `inline PASS evidence must be accepted: ${withEvidence.content}`)
  assert.strictEqual(JSON.parse(readFileSync(transitionState, "utf8")).tasks.G1.status, "verified_pass")

  // (g) blocked stays reachable from verified_pass (escalation can never deadlock).
  const blockFromPass = await registeredTools.task_update.execute({
    sessionId: transitionRun,
    taskId: "G1",
    status: "blocked",
  })
  assert.strictEqual(blockFromPass.status, "blocked", `verified_pass -> blocked must be allowed: ${blockFromPass.content}`)
  assert.strictEqual(JSON.parse(readFileSync(transitionState, "utf8")).tasks.G1.status, "blocked")

  // An on-disk PASS verifier report is equally valid evidence.
  for (const status of ["worker_active", "worker_done", "verifier_active"]) {
    await registeredTools.task_update.execute({ sessionId: transitionRun, taskId: "G2", status })
  }
  const reportFile = join(testDir, ".opencode", "teamwork", transitionRun, "verify", "report-G2.json")
  mkdirSync(dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, JSON.stringify({ taskId: "G2", status: "PASS", feedbackForWorker: "", fatalFindings: [] }) + "\n")
  const fromReport = await registeredTools.task_update.execute({
    sessionId: transitionRun,
    taskId: "G2",
    status: "verified_pass",
  })
  assert.strictEqual(fromReport.status, "verified_pass", `PASS report evidence must be accepted: ${fromReport.content}`)

  console.log("✓ status jumps refused, verified_pass needs legal predecessor + PASS evidence, blocked reachable everywhere")

  // ==========================================
  // Part 2: Max Rounds & Deadlock Detection
  // ==========================================
  console.log("Testing Max Rounds & Deadlock Detection...")

  await registeredTools.plan.execute({
    sessionId: "20261018-000000-deadlock",
    topology: "distributed-coding",
    skipInterview: true,
    tasks: [
      { id: "A", dependsOn: [], maxRounds: 1 },
      { id: "B", dependsOn: ["A"], maxRounds: 2 },
    ],
  })

  // Task A fails at round 1 (maxRounds is 1) -> verifier verdict coerces to blocked.
  for (const status of ["worker_active", "worker_done", "verifier_active"]) {
    await registeredTools.task_update.execute({
      sessionId: "20261018-000000-deadlock",
      taskId: "A",
      status,
    })
  }
  const updateBlockRes = await registeredTools.task_update.execute({
    sessionId: "20261018-000000-deadlock",
    taskId: "A",
    status: "verified_fail",
    round: 1,
  })
  assert.strictEqual(updateBlockRes.status, "blocked", "Task should be blocked when round >= maxRounds")

  const deadlockNext = await registeredTools.next.execute({ sessionId: "20261018-000000-deadlock" })
  assert.strictEqual(deadlockNext.status, "DEADLOCK", "Should report DEADLOCK when all runnable paths are blocked")

  console.log("✓ Max rounds & deadlock detection verified")

  // ==========================================
  // Part 3: Git Worktree Operations & Synthesizer Conflict Artifact
  // ==========================================
  console.log("Testing Git Worktree Tool & Conflict Resolution...")

  const gitRepoDir = mkdtempSync(join(tmpdir(), "teamwork-git-test-"))
  try {
    execFileSync("git", ["init"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    writeFileSync(join(gitRepoDir, "README.md"), "# Teamwork Test Repo\n")
    execFileSync("git", ["add", "README.md"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })

    const gitTools = {}
    await registerTeamworkTools(
      {
        tool: {
          transform: async (cb) => {
            await cb({
              namespace: () => {},
              add: (tool) => {
                gitTools[tool.name] = tool
              },
            })
          },
        },
      },
      gitRepoDir,
    )

    const gitSessionId = `20261018-000000-${Math.random().toString(16).slice(2, 6)}`
    await gitTools.plan.execute({
      sessionId: gitSessionId,
      topology: "distributed-coding",
      skipInterview: true,
      tasks: [{ id: "feature-1" }],
    })

    // 1. Setup sentinel worktree
    const sentinelSetup = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "setup",
      role: "sentinel",
    })
    assert(sentinelSetup.worktreePath, "Sentinel worktree path should be returned")
    assert.strictEqual(sentinelSetup.branch, `teamwork/base-${gitSessionId}`)

    // 2. Setup worker worktree
    const workerSetup = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "setup",
      role: "worker",
      taskId: "feature-1",
    })
    assert(workerSetup.worktreePath, "Worker worktree path should be returned")
    assert.strictEqual(workerSetup.branch, `teamwork/${gitSessionId}-feature-1`)

    // 3. Make change in worker worktree and commit
    writeFileSync(join(workerSetup.worktreePath, "feature.txt"), "hello world\n")
    execFileSync("git", ["add", "feature.txt"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Add feature.txt"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })

    // 4. Test diff
    const diffRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "diff",
      taskId: "feature-1",
    })
    assert(diffRes.hasChanges, "Diff should detect worker changes")
    assert(diffRes.content.includes("feature.txt"), "Diff content should mention feature.txt")

    // 5. Test merge into sentinel base
    const mergeRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "merge",
      taskId: "feature-1",
    })
    assert(mergeRes.merged, "Merge should succeed without conflict")
    assert(!mergeRes.conflict)

    // 6. Test conflict handling: worker modifies file differently than sentinel
    writeFileSync(join(sentinelSetup.worktreePath, "conflict.txt"), "sentinel version\n")
    execFileSync("git", ["add", "conflict.txt"], { cwd: sentinelSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Sentinel commit"], { cwd: sentinelSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })

    writeFileSync(join(workerSetup.worktreePath, "conflict.txt"), "worker conflicting version\n")
    execFileSync("git", ["add", "conflict.txt"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Worker conflicting commit"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })

    const conflictMergeRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "merge",
      taskId: "feature-1",
    })
    assert(conflictMergeRes.conflict, "Should detect merge conflict")
    assert(conflictMergeRes.conflictArtifact, "Should generate conflict artifact path")
    assert(existsSync(conflictMergeRes.conflictArtifact), "Conflict artifact file must exist on disk")

    // 7. Test conflict resolution action
    writeFileSync(join(sentinelSetup.worktreePath, "conflict.txt"), "synthesized combined version\n")
    const resolveRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "resolve",
      taskId: "feature-1",
      commitMessage: "Resolve conflict.txt via synthesizer",
    })
    assert(resolveRes.resolved, "Resolve action should succeed")

    // 8. Cleanup worktrees
    const cleanupRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "cleanup",
    })
    assert(cleanupRes.cleaned, "Cleanup should succeed")

    console.log("✓ Git worktree operations, conflict artifact generation & resolve action verified")
  } finally {
    rmSync(gitRepoDir, { recursive: true, force: true })
  }

  // ==========================================
  // Part 4: CLI Run Management Helpers
  // ==========================================
  console.log("Testing CLI Run Management Helpers...")

  const runsList = listTeamworkRuns(testDir)
  assert(runsList.length >= 2, "Should list created test runs")
  const testRun = runsList.find((r) => r.sessionId === "20261018-000000-test")
  assert(testRun, "Test run should be present in list")
  assert.strictEqual(testRun.securityStatus, "PASS", "Security status should be PASS")

  const inspected = inspectTeamworkRun(testDir, "20261018-000000-test")
  assert(!inspected.error, "Inspect should succeed")
  assert.strictEqual(inspected.run.sessionId, "20261018-000000-test")
  assert(inspected.audit, "Security audit report should be included")
  assert(inspected.pitfalls.length > 0, "Pitfalls should be included")

  console.log("✓ CLI run management helpers verified")

  // ==========================================
  // Part 5: Model Map Priority Resolution
  // ==========================================
  console.log("Testing Model Map Priority Resolution (teamwork.json vs agent files)...")
  const configTestDir = mkdtempSync(join(tmpdir(), "teamwork-config-test-"))
  try {
    const agentsDir = join(configTestDir, "agents", "team")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, "sentinel.md"), "---\nmodel: old-provider/old-model\n---\n")

    // Without teamwork.json, file model takes precedence over default
    const modelsFromFile = currentModels(configTestDir)
    assert.strictEqual(modelsFromFile["team/sentinel"], "old-provider/old-model")

    // When teamwork.json has custom override, it must take precedence over agent file
    writeModelMap(configTestDir, { "team/sentinel": "new-provider/new-model" })
    const modelsFromConfig = currentModels(configTestDir)
    assert.strictEqual(modelsFromConfig["team/sentinel"], "new-provider/new-model")

    console.log("✓ Model map priority resolution verified (teamwork.json > agent files > defaults)")
  } finally {
    rmSync(configTestDir, { recursive: true, force: true })
  }

  // ==========================================
  // Part 6: Attribution — actor identity, taskId buckets, byTaskTokens
  // ==========================================
  console.log("Testing attribution (actor identity, taskId buckets, byTaskTokens)...")

  // Hermetic OpenCode environment: HOME and every XDG/AppData root that
  // tools.ts consults point at a temp dir, so the real opencode.db and
  // service.json are never read. The fake session DB lives in there too.
  const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "LOCALAPPDATA"]
  async function withIsolatedOpencodeEnv(fn) {
    const home = mkdtempSync(join(testDir, "home-"))
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.XDG_DATA_HOME = join(home, "data")
    process.env.XDG_STATE_HOME = join(home, "state")
    process.env.LOCALAPPDATA = join(home, "localappdata")
    try {
      return await fn({ dbPath: join(home, "data", "opencode", "opencode.db") })
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  }

  // Probe ONCE which SQLite backend can seed the session_v2 fixture table:
  // node:sqlite (preferred) or the sqlite3 CLI. Returns null when neither exists.
  async function probeSqliteBackend() {
    try {
      const mod = await import("node:sqlite")
      if (typeof mod.DatabaseSync === "function") return "node:sqlite"
    } catch {}
    try {
      execFileSync("sqlite3", ["--version"], { stdio: ["pipe", "pipe", "pipe"] })
      return "sqlite3"
    } catch {}
    return null
  }
  const sqliteBackend = await probeSqliteBackend()

  // Seed the session_v2 table that tools.ts reads. Errors propagate: a seeding
  // failure with a backend present is a real test failure, never a skip.
  async function seedSessionDb(dbPath, rows) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const ddl = `DROP TABLE IF EXISTS session_v2;
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, cost REAL,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER);`
    const values = rows.map(
      (r) =>
        `INSERT INTO session_v2 VALUES ('${r.id}', ${r.parent ? `'${r.parent}'` : "NULL"}, ${r.agent ? `'${r.agent}'` : "NULL"}, ${r.cost}, ${r.t.input}, ${r.t.output}, ${r.t.reasoning}, ${r.t.read}, ${r.t.write});`,
    )
    if (sqliteBackend === "node:sqlite") {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(dbPath)
      try {
        db.exec(ddl + values.join("\n"))
      } finally {
        db.close()
      }
    } else {
      execFileSync("sqlite3", [dbPath], { input: ddl + values.join("\n"), stdio: ["pipe", "pipe", "pipe"] })
    }
  }

  const ROOT_SES = "ses_attr_root"
  const CHILD_SES = "ses_attr_worker"
  const ZERO_T = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }
  const rootRow = { id: ROOT_SES, parent: null, agent: "sentinel", cost: 0, t: ZERO_T }
  const workerRow = (cost, t) => ({ id: CHILD_SES, parent: ROOT_SES, agent: "team/worker", cost, t })
  const T1 = { input: 1000, output: 200, reasoning: 10, read: 50, write: 5 }


  /** A fresh project root with the real tools registered and a run planned by the root session. */
  async function attrFixture(runId, planAgent = "team/worker", taskIds = ["alpha"], sessionAgent = undefined) {
    const root = mkdtempSync(join(testDir, "attr-"))
    const tools = {}
    await registerTeamworkTools(
      {
        tool: {
          transform: async (cb) => {
            await cb({
              namespace: () => {},
              add: (tool) => {
                tools[tool.name] = tool
              },
            })
          },
        },
        session: { get: async () => (sessionAgent ? { agent: sessionAgent } : undefined) },
      },
      root,
    )
    await tools.plan.execute(
      { sessionId: runId, topology: "iterative-coding", skipInterview: true, tasks: taskIds.map((id) => ({ id, agent: planAgent })) },
      { sessionID: ROOT_SES },
    )
    return { root, tools }
  }

  const RUN_A = "20261018-000000-attr1"
  const RUN_B = "20261018-000000-attr2"
  const RUN_C = "20261018-000000-attr3"
  const RUN_D = "20261018-000000-attr4"

  await withIsolatedOpencodeEnv(async ({ dbPath }) => {
    if (sqliteBackend === null) {
      console.log("⊘ skipped attribution DB tests: no node:sqlite and no sqlite3 CLI")
      return
    }

    // --- 6a: non-root spend WITH a taskId buckets to the task, not to the agent.
    {
      const f = await attrFixture(RUN_A)
      await seedSessionDb(dbPath, [rootRow, workerRow(0.3, T1)])
      const res = await f.tools.cost.execute({ sessionId: RUN_A, taskId: "alpha" }, { sessionID: ROOT_SES })
      assert(res.content.includes("opencode database"), `spend must come from the session DB, got: ${res.content}`)
      const costs = JSON.parse(readFileSync(runFile(f.root, RUN_A, "costs.json"), "utf8"))
      assert.strictEqual(costs.byTask.alpha, 0.3, "subagent spend must bucket to the taskId")
      assert.strictEqual(costs.byTask["team/worker"], undefined, "byTask['team/worker'] must NOT grow when a taskId is given")
      assert.deepStrictEqual(Object.keys(costs.byTask), ["alpha"])
      assert.strictEqual(costs.spentUsd, 0.3)
      console.log("✓ non-root spend with taskId buckets to the task; byTask['team/worker'] does not grow")
    }

    // --- 6b: the SAME fixture WITHOUT a taskId keeps the legacy agent-name bucket.
    {
      const f = await attrFixture(RUN_B)
      await seedSessionDb(dbPath, [rootRow, workerRow(0.3, T1)])
      await f.tools.cost.execute({ sessionId: RUN_B }, { sessionID: ROOT_SES })
      const costs = JSON.parse(readFileSync(runFile(f.root, RUN_B, "costs.json"), "utf8"))
      assert.strictEqual(costs.byTask["team/worker"], 0.3, "without a taskId, non-root spend must bucket by agent name")
      assert.deepStrictEqual(Object.keys(costs.byTask), ["team/worker"], "no task bucket may appear without a taskId")
      assert.deepStrictEqual(Object.keys(costs.byTaskTokens), ["team/worker"], "byTaskTokens keys must mirror byTask")
      console.log("✓ without taskId, non-root spend still buckets by agent name (legacy regression guard)")
    }

    // --- 6c: byTaskTokens SUMS per-session token deltas across the whole tree.
    // Two child sessions and a non-zero root all map to the same taskId, so the
    // expected bucket is the sum of every contribution. A last-writer-wins
    // (absolute) write would leave only one session's total and fail here.
    {
      const f = await attrFixture(RUN_C)
      const ROOT_T1 = { input: 400, output: 80, reasoning: 4, read: 20, write: 2 }
      const CHILD2 = "ses_attr_worker2"
      const child2Row = (cost, t) => ({ id: CHILD2, parent: ROOT_SES, agent: "team/worker", cost, t })
      const T2 = { input: 300, output: 60, reasoning: 3, read: 10, write: 1 }
      // Call 1: root(R1) + child1(T1) + child2(T2) => sum of all three.
      await seedSessionDb(dbPath, [{ ...rootRow, t: ROOT_T1 }, workerRow(0.3, T1), child2Row(0.2, T2)])
      await f.tools.cost.execute({ sessionId: RUN_C, taskId: "alpha" }, { sessionID: ROOT_SES })
      // Call 2: root grows by R2-R1, child1 grows by T1'-T1, child2 unchanged. Only deltas may be added.
      const ROOT_T2 = { input: 500, output: 100, reasoning: 5, read: 30, write: 3 }
      const CHILD1_T2 = { input: 1500, output: 300, reasoning: 10, read: 50, write: 5 }
      await seedSessionDb(dbPath, [
        { ...rootRow, t: ROOT_T2 },
        workerRow(0.45, CHILD1_T2),
        child2Row(0.2, T2),
      ])
      await f.tools.cost.execute({ sessionId: RUN_C, taskId: "alpha" }, { sessionID: ROOT_SES })
      const costs = JSON.parse(readFileSync(runFile(f.root, RUN_C, "costs.json"), "utf8"))
      assert.strictEqual(costs.byTask.alpha, 0.65, "cost must accumulate 0.3 + 0.2 + 0.15 delta")
      // Expected = sum of all sessions' current totals: root(R2) + child1(T1') + child2(T2).
      assert.deepStrictEqual(costs.byTaskTokens.alpha, {
        input: 500 + 1500 + 300,
        output: 100 + 300 + 60,
        reasoning: 5 + 10 + 3,
        cache: { read: 30 + 50 + 10, write: 3 + 5 + 1 },
      }, "byTaskTokens must SUM per-session token deltas across the tree")
      const bucket = costs.byTaskTokens.alpha
      assert.deepStrictEqual(Object.keys(bucket).sort(), ["cache", "input", "output", "reasoning"])
      assert.deepStrictEqual(Object.keys(bucket.cache).sort(), ["read", "write"])
      for (const v of [bucket.input, bucket.output, bucket.reasoning, bucket.cache.read, bucket.cache.write]) {
        assert(Number.isFinite(v) && Number.isInteger(v) && v >= 0, `token value must be a finite non-negative integer, got ${v}`)
      }
      assert.deepStrictEqual(Object.keys(costs.byTaskTokens).sort(), Object.keys(costs.byTask).sort(), "byTaskTokens keys must match byTask keys")
      console.log("✓ byTaskTokens sums per-session token deltas across the tree (absolute-write mutation is caught)")
    }

    // --- 6d: a pre-existing costs.json WITHOUT byTaskTokens is tolerated.
    {
      const f = await attrFixture(RUN_D)
      const file = runFile(f.root, RUN_D, "costs.json")
      const legacy = JSON.parse(readFileSync(file, "utf8"))
      delete legacy.byTaskTokens
      writeFileSync(file, JSON.stringify(legacy, null, 2) + "\n")
      await seedSessionDb(dbPath, [rootRow, workerRow(0.3, T1)])
      const res = await f.tools.cost.execute({ sessionId: RUN_D, taskId: "alpha" }, { sessionID: ROOT_SES })
      assert(res.content.includes("Budget:"), `cost must complete without crashing, got: ${res.content}`)
      const costs = JSON.parse(readFileSync(file, "utf8"))
      assert.strictEqual(costs.byTask.alpha, 0.3)
      assert.strictEqual(costs.byTaskTokens.alpha.input, 1000, "a legacy costs.json must gain the byTaskTokens bucket")
      console.log("✓ pre-existing costs.json without byTaskTokens is tolerated")
    }
  })

  // --- 6e: actor identity recorded in events.jsonl (explicit agent wins).
  {
    const f = await attrFixture("20261018-000000-actor")
    const RUN = "20261018-000000-actor"
    const before = readEvents(f.root, RUN).length
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active", agent: "team/worker" })
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_done", agent: "team/worker" })
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "verifier_active", agent: "team/verifier" })
    const events = readEvents(f.root, RUN)
    assert.strictEqual(events.length, before + 3, "exactly one event per transition")
    const [wa, wd, va] = events.slice(-3)
    assert.strictEqual(wa.agent, "team/worker", "explicit team/worker must be the recorded actor")
    assert.strictEqual(wd.agent, "team/worker")
    assert.strictEqual(va.agent, "team/verifier", "explicit team/verifier must be the recorded actor")
    assert.strictEqual(wa.agentSource, "explicit", "an input.agent actor must be labelled explicit")
    assert.strictEqual(wd.agentSource, "explicit")
    assert.strictEqual(va.agentSource, "explicit")
    console.log("✓ explicit agent (team/worker and team/verifier) is recorded as the actor in events.jsonl")
  }

  // --- 6f: with no explicit agent and no calling session, the plan-declared agent is the fallback.
  {
    const RUN = "20261018-000000-plan"
    const f = await attrFixture(RUN, "team/worker")
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active" })
    const last = readEvents(f.root, RUN).at(-1)
    assert.strictEqual(last.agent, "team/worker", "plan-declared agent must be the fallback actor")
    assert.strictEqual(last.agentSource, "plan", "a plan-declared actor must be labelled plan")
    console.log("✓ plan-declared agent is the fallback actor when none is supplied")
  }

  // --- 6f(2): the calling session's agent wins over the plan and is labelled session.
  {
    const RUN = "20261018-000000-session"
    const f = await attrFixture(RUN, "team/worker", ["alpha"], "team/scout")
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active" }, { sessionID: ROOT_SES })
    const last = readEvents(f.root, RUN).at(-1)
    assert.strictEqual(last.agent, "team/scout", "the session agent must beat the plan-declared agent")
    assert.strictEqual(last.agentSource, "session", "a session-resolved actor must be labelled session")
    console.log("✓ session-resolved agent is recorded with agentSource=session")
  }

  // --- 6g: seq is one monotonic number space per events.jsonl, starting at 1.
  {
    const RUN = "20261018-000000-seq"
    const f = await attrFixture(RUN)
    rmSync(runFile(f.root, RUN, "events.jsonl"))
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active", agent: "team/worker" })
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_done", agent: "team/worker" })
    const events = readEvents(f.root, RUN)
    assert.deepStrictEqual(
      events.map((e) => [e.event, e.seq]),
      [["task_transition", 1], ["task_transition", 2]],
      "two consecutive appends must get seq 1 and 2",
    )
    console.log("✓ consecutive task_transition lines get seq 1 and 2")
  }

  // --- 6h: a legacy events.jsonl without seq still appends the correct next value.
  {
    const RUN = "20261018-000000-legacy-seq"
    const f = await attrFixture(RUN)
    const file = runFile(f.root, RUN, "events.jsonl")
    const legacy = [
      { ts: "2026-10-18T10:00:00.000Z", event: "run_created", sessionId: RUN, taskId: null, from: null, to: "pending", round: 0, agent: null, branch: null, worktree: null, phase: "DAG_BUILD" },
      { ts: "2026-10-18T10:00:01.000Z", event: "task_transition", sessionId: RUN, taskId: "alpha", from: "pending", to: "worker_active", round: 1, agent: null, branch: null, worktree: null, phase: "DISPATCH" },
    ]
    writeFileSync(file, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n")
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active", agent: "team/worker" })
    const events = readEvents(f.root, RUN)
    assert.strictEqual(events.length, 3, "the append must leave the two legacy lines and add one")
    assert(!("seq" in events[0]) && !("seq" in events[1]), "legacy lines must be left untouched")
    assert.strictEqual(events[2].seq, 3, "the appended line must continue after the two legacy lines")
    console.log("✓ a legacy events.jsonl without seq appends the correct next seq")
  }

  // --- 6i: a garbage agent with control characters cannot inject a second JSONL line.
  {
    const RUN = "20261018-000000-inject"
    const f = await attrFixture(RUN)
    const file = runFile(f.root, RUN, "events.jsonl")
    const linesBefore = readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length
    const garbage = 'team/worker\n{"event":"injected"}\u2028FAKE'
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active", agent: garbage })
    const raw = readFileSync(file, "utf8")
    const physical = raw.split("\n").filter((l) => l !== "")
    assert.strictEqual(physical.length, linesBefore + 1, "the garbage agent must add exactly one physical line")
    for (const line of physical) assert.doesNotThrow(() => JSON.parse(line), `every line must parse: ${line}`)
    assert(!raw.includes("\u2028"), "no raw line separator may reach events.jsonl")
    // Sanitised value, not the raw garbage: control characters become spaces.
    assert.strictEqual(JSON.parse(physical.at(-1)).agent, 'team/worker {"event":"injected"} FAKE', "agent must be recorded sanitised")
    console.log("✓ garbage agent with newline cannot inject a second JSONL line; recorded value is sanitised")
  }
} finally {
  rmSync(testDir, { recursive: true, force: true })
}

// ==========================================
// Part 1e: cumulative issue ledger (3.6)
// ==========================================
{
  console.log("Testing cumulative issue ledger (3.6)...")
  const ledgerDir = mkdtempSync(join(tmpdir(), "teamwork-ledger-test-"))
  try {
    const tools = {}
    await registerTeamworkTools(
      {
        tool: {
          transform: async (cb) => {
            await cb({ namespace: () => {}, add: (tool) => (tools[tool.name] = tool) })
          },
        },
        session: { get: async () => undefined },
      },
      ledgerDir,
    )
    const ledgerRunFile = (runId, name) => join(ledgerDir, ".opencode", "teamwork", runId, name)
    const ledgerStateOf = (runId) => JSON.parse(readFileSync(ledgerRunFile(runId, "state.json"), "utf8"))
    const planLedger = async (runId, maxRounds = 3) => {
      const r = await tools.plan.execute({
        sessionId: runId,
        topology: "iterative-coding",
        skipInterview: true,
        tasks: [{ id: "L1", maxRounds }],
      })
      assert(r.content.startsWith("Planned"), `ledger fixture plan must succeed: ${r.content}`)
    }
    const walk = async (runId, statuses, round) => {
      for (const status of statuses) {
        await tools.task_update.execute({ sessionId: runId, taskId: "L1", status, round, ...(status === "verified_pass" ? { verification: { status: "PASS" } } : {}) })
      }
    }

    // (a) two consecutive failed rounds keep two unresolved entries, in order.
    const RUN = "20261018-000000-ledger"
    await planLedger(RUN)
    await walk(RUN, ["worker_active", "worker_done", "verifier_active"], 1)
    await tools.task_update.execute({ sessionId: RUN, taskId: "L1", status: "verified_fail", round: 1, feedback: "first issue" })
    await walk(RUN, ["worker_active", "worker_done", "verifier_active"], 2)
    await tools.task_update.execute({ sessionId: RUN, taskId: "L1", status: "verified_fail", round: 2, feedback: "second issue" })
    let st = ledgerStateOf(RUN)
    assert.deepStrictEqual(
      st.tasks.L1.feedbackLog.map((e) => [e.round, e.text, e.resolved]),
      [
        [1, "first issue", false],
        [2, "second issue", false],
      ],
      "two failed rounds must append two unresolved ledger entries in round order",
    )
    assert.strictEqual(st.tasks.L1.feedback, "second issue", "the latest-round feedback field must be unchanged")

    // (b) teamwork_next exposes both entries in one string, each round-prefixed.
    let nextRes = await tools.next.execute({ sessionId: RUN })
    let worker = nextRes.readyForWorker.find((t) => t.id === "L1")
    assert(worker, "L1 must be ready for another worker round after two failures")
    assert.strictEqual(worker.feedback, "R1: first issue\nR2: second issue", "next must join every unresolved entry, oldest first")
    assert(!/[\x00-\x1f]/.test(worker.feedback.replace(/\n/g, "")), "only the engine's own newline separators may reach the payload")

    // (c) verified_pass resolves every existing entry, in the same write.
    await walk(RUN, ["worker_active", "worker_done", "verifier_active", "verified_pass"], 3)
    st = ledgerStateOf(RUN)
    assert.strictEqual(st.tasks.L1.feedbackLog.length, 2, "verified_pass must preserve the ledger")
    assert(st.tasks.L1.feedbackLog.every((e) => e.resolved === true), "verified_pass must resolve every ledger entry")

    // (d) a later teamwork_next no longer surfaces the resolved texts.
    nextRes = await tools.next.execute({ sessionId: RUN })
    assert(!(nextRes.readyForWorker || []).some((t) => t.id === "L1"), "a passed task is not dispatched again")
    const nextJson = JSON.stringify(nextRes)
    assert(!nextJson.includes("first issue") && !nextJson.includes("second issue"), "resolved feedback must not be surfaced")

    // (e) the ledger caps at the newest 20 entries, dropping the oldest.
    const CAP_RUN = "20261018-000000-ledgercap"
    await planLedger(CAP_RUN)
    await tools.task_update.execute({ sessionId: CAP_RUN, taskId: "L1", status: "worker_active", round: 1 })
    for (let i = 1; i <= 21; i++) {
      await tools.task_update.execute({ sessionId: CAP_RUN, taskId: "L1", status: "worker_active", round: 1, feedback: `issue ${i}` })
    }
    const capLog = ledgerStateOf(CAP_RUN).tasks.L1.feedbackLog
    assert.strictEqual(capLog.length, 20, "feedbackLog must be capped at 20 entries")
    assert.strictEqual(capLog[0].text, "issue 2", "the cap must drop the oldest entry")
    assert.strictEqual(capLog.at(-1).text, "issue 21", "the cap must keep the newest entry")
    assert.deepStrictEqual(capLog.map((e) => e.text), Array.from({ length: 20 }, (_, i) => `issue ${i + 2}`), "the newest 20 must be kept in order")

    // (f) a legacy run with only `feedback` (no ledger) still surfaces that text.
    const LEGACY_RUN = "20261018-000000-ledgerlegacy"
    await planLedger(LEGACY_RUN)
    const legacyFile = ledgerRunFile(LEGACY_RUN, "state.json")
    const legacyState = JSON.parse(readFileSync(legacyFile, "utf8"))
    legacyState.tasks.L1.feedback = "legacy only feedback"
    delete legacyState.tasks.L1.feedbackLog
    writeFileSync(legacyFile, JSON.stringify(legacyState, null, 2) + "\n")
    nextRes = await tools.next.execute({ sessionId: LEGACY_RUN })
    worker = nextRes.readyForWorker.find((t) => t.id === "L1")
    assert(worker, "legacy L1 must still be ready for a worker")
    assert.strictEqual(worker.feedback, "legacy only feedback", "a run without feedbackLog must fall back to the latest feedback")

    console.log("✓ ledger accumulates per round, next surfaces unresolved entries, verified_pass resolves them, 20-entry cap, legacy fallback")
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true })
  }
}

// ==========================================
// Part 7: SEC-1 / SEC-3 — prototype-key integrity and tool-result sanitising
// ==========================================
{
  console.log("Testing prototype-key integrity and tool-result sanitising (SEC-1, SEC-3)...")
  const testDir7 = mkdtempSync(join(tmpdir(), "teamwork-sec1-test-"))
  const protoSnapshot = () => Reflect.ownKeys(Object.prototype).map(String).sort().join(",")
  const protoBefore = protoSnapshot()
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  const costsOf = (root, runId) => JSON.parse(readFileSync(join(root, ".opencode", "teamwork", runId, "costs.json"), "utf8"))
  const stateOf = (root, runId) => JSON.parse(readFileSync(join(root, ".opencode", "teamwork", runId, "state.json"), "utf8"))
  // Any C0/DEL/C1 control character (incl. ESC, BEL, CSI U+009B, U+0085) in tool output.
  const CTRL = /[\x00-\x1f\x7f-\x9f]/
  const ENV7 = ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "LOCALAPPDATA"]
  const saved7 = Object.fromEntries(ENV7.map((k) => [k, process.env[k]]))
  const home7 = mkdtempSync(join(testDir7, "home-"))
  // Isolate from the real opencode.db / service.json so the manual addUsd path is deterministic.
  process.env.HOME = home7
  process.env.USERPROFILE = home7
  process.env.XDG_DATA_HOME = join(home7, "data")
  process.env.XDG_STATE_HOME = join(home7, "state")
  process.env.LOCALAPPDATA = join(home7, "localappdata")

  try {
    const fixture = async (runId, taskIds = ["alpha"]) => {
      const root = mkdtempSync(join(testDir7, "sec1-"))
      const tools = {}
      await registerTeamworkTools(
        {
          tool: {
            transform: async (cb) => {
              await cb({ namespace: () => {}, add: (tool) => (tools[tool.name] = tool) })
            },
          },
          session: { get: async () => undefined },
        },
        root,
      )
      const planRes = await tools.plan.execute({ sessionId: runId, topology: "iterative-coding", skipInterview: true, tasks: taskIds.map((id) => ({ id })) }, {})
      assert(planRes.content.startsWith("Planned"), `fixture plan must succeed: ${planRes.content}`)
      return { root, tools }
    }

    // --- 7a: a legal but Object.prototype-named task id keeps its spend (no NaN, no loss).
    {
      const RUN = "20261018-000000-sec1a"
      const f = await fixture(RUN)
      const res = await f.tools.cost.execute({ sessionId: RUN, taskId: "constructor", addUsd: 0.25 }, {})
      assert(!res.content.includes("NaN"), `breakdown must not contain NaN: ${res.content}`)
      const costs = costsOf(f.root, RUN)
      assert.strictEqual(costs.spentUsd, 0.25, "spentUsd must reflect the constructor-bucket spend")
      assert(hasOwn(costs.byTask, "constructor"), "constructor bucket must be persisted as an own key")
      assert.strictEqual(costs.byTask.constructor, 0.25, "constructor bucket must hold the amount")
      // A second spend accumulates into the same bucket.
      await f.tools.cost.execute({ sessionId: RUN, taskId: "constructor", addUsd: 0.5 }, {})
      assert.strictEqual(costsOf(f.root, RUN).byTask.constructor, 0.75, "constructor bucket must accumulate")
      console.log("✓ taskId 'constructor' is recorded: no NaN, spentUsd and bucket reflect the amount")
    }

    // --- 7b: '__proto__' is REJECTED by the allowlist; nothing is recorded or silently dropped.
    {
      const RUN = "20261018-000000-sec1b"
      const f = await fixture(RUN)
      const res = await f.tools.cost.execute({ sessionId: RUN, taskId: "__proto__", addUsd: 0.5 }, {})
      assert(res.content.startsWith("refused"), `'__proto__' must be refused by validation, got: ${res.content}`)
      const costs = costsOf(f.root, RUN)
      assert.strictEqual(costs.spentUsd, 0, "a refused spend must not change spentUsd")
      assert(!hasOwn(costs.byTask, "__proto__"), "'__proto__' must not be stored as a bucket")
      for (const bad of ["../escape", "a/b", "_sentinel", ""]) {
        const r = await f.tools.cost.execute({ sessionId: RUN, taskId: bad, addUsd: 0.1 }, {})
        if (bad === "") {
          assert(!r.content.startsWith("refused"), "an empty taskId is treated as absent, not refused")
        } else {
          assert(r.content.startsWith("refused"), `taskId ${JSON.stringify(bad)} must be refused: ${r.content}`)
        }
      }
      console.log("✓ taskId '__proto__' (and path-like ids) are refused by validation, never silently dropped")
    }

    // --- 7c: a task absent from the plan cannot be injected via an inherited member name.
    {
      const RUN = "20261018-000000-sec1c"
      const f = await fixture(RUN)
      for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
        const r = await f.tools.task_update.execute({ sessionId: RUN, taskId: id, status: "worker_active" }, {})
        assert(r.content.startsWith("Error: Task"), `task_update('${id}') for an absent task must be refused: ${r.content}`)
      }
      assert.deepStrictEqual(Object.keys(stateOf(f.root, RUN).tasks), ["alpha"], "state.json must gain no phantom task")
      console.log("✓ task_update for an absent 'constructor'/'__proto__' injects no phantom task")
    }

    // --- 7d: a plan CAN declare 'constructor' as a normal task, and it works end to end.
    {
      const RUN = "20261018-000000-sec1d"
      const f = await fixture(RUN, ["constructor"])
      const st = stateOf(f.root, RUN)
      assert(hasOwn(st.tasks, "constructor"), "planned 'constructor' task must be an own key in state.json")
      const upd = await f.tools.task_update.execute({ sessionId: RUN, taskId: "constructor", status: "worker_active" }, {})
      assert(upd.content.startsWith("Task constructor updated"), `valid 'constructor' task must update: ${upd.content}`)
      assert.strictEqual(stateOf(f.root, RUN).tasks.constructor.status, "worker_active")
      console.log("✓ a planned task named 'constructor' is an ordinary task")
    }

    // --- 7e: plan refuses unsafe ids (task or dependsOn) and writes nothing for the refused plan.
    {
      const RUN = "20261018-000000-sec1e"
      const f = await fixture(RUN, ["ok"])
      const before = readFileSync(join(f.root, ".opencode", "teamwork", RUN, "plan.dag.json"), "utf8")
      for (const bad of [
        { tasks: [{ id: "__proto__" }] },
        { tasks: [{ id: "constructor/../x" }] },
        { tasks: [{ id: "ok2" }, { id: "a b" }] },
        { tasks: [{ id: "ok2", dependsOn: ["../up"] }] },
      ]) {
        const r = await f.tools.plan.execute({ sessionId: RUN, topology: "iterative-coding", ...bad }, {})
        assert(r.content.startsWith("refused"), `plan with unsafe id must be refused: ${r.content}`)
      }
      const after = readFileSync(join(f.root, ".opencode", "teamwork", RUN, "plan.dag.json"), "utf8")
      assert.strictEqual(after, before, "a refused plan must not overwrite plan.dag.json")
      console.log("✓ teamwork_plan refuses unsafe task ids and dependsOn before writing anything")
    }

    // --- 7f: SEC-3 — the branch echoed by task_update carries no raw control characters.
    {
      const RUN = "20261018-000000-sec3a"
      const f = await fixture(RUN)
      const hostile = "feat\x1b]52;c;SGVsbG8=\x07\u009b31m\x7f\u0085\u2028end"
      const r = await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active", branch: hostile }, {})
      assert(r.content.includes("branch=feat"), `branch must still be echoed: ${r.content}`)
      assert(!CTRL.test(r.content), `tool-result content must carry no control character: ${JSON.stringify(r.content)}`)
      assert(!r.content.includes("\u2028"), "no line separator in content")
      console.log("✓ task_update echoes the branch with ESC/OSC52/C1/DEL/U+0085 removed")
    }

    // --- 7g: SEC-3 — a hostile bucket key (legacy costs.json) is not echoed raw by cost.
    {
      const RUN = "20261018-000000-sec3b"
      const f = await fixture(RUN)
      const file = join(f.root, ".opencode", "teamwork", RUN, "costs.json")
      const costs = costsOf(f.root, RUN)
      costs.byTask = { ["k\x1b]52;c;QQ==\x07\u009b\x7f\u0085z"]: 0.1 }
      costs.spentUsd = 0.1
      writeFileSync(file, JSON.stringify(costs))
      const r = await f.tools.cost.execute({ sessionId: RUN }, {})
      assert(r.content.includes("$0.1"), `breakdown must still show the amount: ${r.content}`)
      // The template's own "\n" line separators are allowed; nothing else may be control.
      assert(!CTRL.test(r.content.replace(/\n/g, "")), `cost breakdown must carry no control character: ${JSON.stringify(r.content)}`)
      console.log("✓ teamwork_cost echoes bucket keys with ESC/OSC52/C1/DEL/U+0085 removed")
    }

    // --- 7h: per-task tokens through the session tree still accumulate for a 'constructor' bucket.
    {
      let haveSqlite = true
      try {
        await import("node:sqlite")
      } catch {
        haveSqlite = false
      }
      if (!haveSqlite) {
        console.log("⊘ skipped 'constructor' token-tree test: no node:sqlite")
      } else {
        const { DatabaseSync } = await import("node:sqlite")
        const RUN = "20261018-000000-sec1h"
        const f = await fixture(RUN)
        const dbPath = join(home7, "data", "opencode", "opencode.db")
        mkdirSync(dirname(dbPath), { recursive: true })
        const db = new DatabaseSync(dbPath)
        try {
          db.exec(`DROP TABLE IF EXISTS session_v2;
            CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, cost REAL,
              tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
              tokens_cache_read INTEGER, tokens_cache_write INTEGER);
            INSERT INTO session_v2 VALUES ('ses_sec1_root', NULL, 'sentinel', 0, 0, 0, 0, 0, 0);
            INSERT INTO session_v2 VALUES ('ses_sec1_worker', 'ses_sec1_root', 'team/worker', 0.3, 1000, 200, 10, 50, 5);`)
        } finally {
          db.close()
        }
        const res = await f.tools.cost.execute({ sessionId: RUN, taskId: "constructor" }, { sessionID: "ses_sec1_root" })
        assert(!res.content.includes("NaN"), `no NaN in breakdown: ${res.content}`)
        const costs = costsOf(f.root, RUN)
        assert.strictEqual(costs.byTask.constructor, 0.3, "worker spend must bucket to 'constructor'")
        assert.strictEqual(costs.spentUsd, 0.3)
        assert(hasOwn(costs.byTaskTokens, "constructor"), "byTaskTokens must hold an own 'constructor' key")
        assert.deepStrictEqual(costs.byTaskTokens.constructor, {
          input: 1000,
          output: 200,
          reasoning: 10,
          cache: { read: 50, write: 5 },
        })
        console.log("✓ per-task tokens accumulate through the session tree for a 'constructor' bucket")
      }
    }

    // --- 7i: Object.prototype was never modified by any of the above.
    assert.strictEqual(protoSnapshot(), protoBefore, "Object.prototype must have no new or removed own keys")
    assert.strictEqual(({}).spentUsd, undefined, "no global pollution via spentUsd")
    assert.strictEqual(({}).lastCost, undefined, "no global pollution via lastCost")
    console.log("✓ Object.prototype is unmodified after all SEC-1/SEC-3 cases")
  } finally {
    for (const k of ENV7) {
      if (saved7[k] === undefined) delete process.env[k]
      else process.env[k] = saved7[k]
    }
    rmSync(testDir7, { recursive: true, force: true })
  }
}

// ==========================================
// Part 8: read-only policy drift
// ==========================================
{
  console.log("Testing read-only policy drift...")
  const repoRoot = fileURLToPath(new URL("..", import.meta.url))

  // Source of truth for this test: each agent's code-enforced deny set. The
  // shell caveat is derived from the deny set, never restated, so the table
  // cannot disagree with itself.
  const POLICY = [
    { id: "team/verifier", deny: ["edit", "subagent", "webfetch"] },
    { id: "team/falsifier", deny: ["edit", "shell", "subagent"] },
    { id: "team/scout", deny: ["edit", "subagent"] },
    { id: "team/security-auditor", deny: ["edit", "subagent", "webfetch"] },
    { id: "team/segment-reviewer", deny: ["edit", "shell", "subagent", "webfetch"] },
  ].map((p) => ({ ...p, deny: [...p.deny].sort() }))

  // --- 8a: READ_ONLY_ACTIONS holds exactly the documented deny sets.
  const toolsSrc = readFileSync(join(repoRoot, "plugins/opencode-teamwork/tools.ts"), "utf8")
  const table = toolsSrc.match(/const READ_ONLY_ACTIONS[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert(table, "READ_ONLY_ACTIONS table must exist in tools.ts")
  const enforced = {}
  for (const m of table[1].matchAll(/"([^"]+)":\s*new Set\(\[([^\]]*)\]\)/g)) {
    enforced[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((a) => a[1]).sort()
  }
  assert.deepStrictEqual(
    Object.keys(enforced).sort(),
    POLICY.map((p) => p.id).sort(),
    "READ_ONLY_ACTIONS must list exactly the agents covered by this test",
  )
  for (const p of POLICY) {
    assert.deepStrictEqual(enforced[p.id], p.deny, `${p.id}: code deny set drifted: ${JSON.stringify(enforced[p.id])}`)
  }
  console.log("✓ READ_ONLY_ACTIONS matches the expected deny set for all four read-only agents")

  // --- 8b: every agent whose code policy denies `edit` is documented in the
  // README read-only paragraph (parsed, not a duplicate hard-coded list).
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8")
  const start = readme.indexOf("per-agent read-only policy")
  assert(start >= 0, "README must state the per-agent read-only policy")
  const end = readme.indexOf("\n\n", start)
  const paragraph = readme.slice(start, end === -1 ? undefined : end)
  const documented = [...new Set([...paragraph.matchAll(/`(team\/[a-z-]+)`/g)].map((m) => m[1]))].sort()
  const editDeniers = POLICY.filter((p) => p.deny.includes("edit")).map((p) => p.id).sort()
  assert.deepStrictEqual(documented, editDeniers, "README must document exactly the edit-denying agents as read-only")
  assert(/can modify files/i.test(paragraph), "README must state that shell can modify files")
  assert(
    /falsifier[^.]*shell|shell[^.]*falsifier/i.test(paragraph),
    "README must state that the falsifier's deny set includes shell",
  )
  console.log("✓ README documents every edit-denying team agent, plus the shell caveat and the falsifier exception")

  // --- 8c: each agent description matches its own deny set.
  for (const p of POLICY) {
    const name = p.id.replace(/^team\//, "")
    const src = readFileSync(join(repoRoot, "agents/team", `${name}.md`), "utf8")
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    assert(fm, `${p.id}: frontmatter must exist`)
    const desc = fm[1].match(/^description:\s*"([^"]*)"/m)
    assert(desc, `${p.id}: quoted description must exist`)
    const text = desc[1]
    if (p.deny.includes("shell")) {
      assert(
        !/shell[^.]*can modify files/i.test(text),
        `${p.id}: description must not carry the shell caveat (its deny set includes shell): ${text}`,
      )
      assert(/shell[^.]*denied|denied[^.]*shell/i.test(text), `${p.id}: description must say shell is denied: ${text}`)
    } else {
      assert(
        /shell[^.]*can modify files/i.test(text),
        `${p.id}: description must warn that shell is available and can modify files: ${text}`,
      )
    }
  }
  console.log("✓ each read-only agent description matches its own deny set (shell caveat only where shell is allowed)")

  // --- 8d: GUARDRAILS states the same guarantee.
  const guardrails = readFileSync(join(repoRoot, "docs/GUARDRAILS.md"), "utf8")
  const row = guardrails.split("\n").find((line) => line.includes("Read-only enforcement"))
  assert(row, "GUARDRAILS must keep the read-only enforcement row")
  assert(/shell/i.test(row) && /can modify files/i.test(row), "GUARDRAILS read-only row must state the shell caveat")
  console.log("✓ GUARDRAILS read-only row states the edit-only guarantee and the shell caveat")
}

// ==========================================
// Part 9: Document Review route (Issue #1)
// ==========================================
{
  console.log("Testing Document Review route...")
  const docRoot = mkdtempSync(join(tmpdir(), "teamwork-docrev-test-"))
  const outsideDir = mkdtempSync(join(tmpdir(), "teamwork-docrev-outside-"))
  const tools = {}
  let evaluateHook

  try {
    const ctx = {
      tool: {
        transform: async (cb) => {
          await cb({
            namespace: () => {},
            add: (t) => {
              tools[t.name] = t
            },
          })
        },
      },
      permission: {
        hook: async (name, fn) => {
          if (name === "evaluate") evaluateHook = fn
        },
      },
      session: {
        get: async () => ({ agent: "team/verifier" }),
        hook: async () => {},
      },
    }

    await registerTeamworkTools(ctx, docRoot)
    await registerTeamworkHooks(ctx, docRoot)

    assert(tools.route, "teamwork_route must be registered")
    assert(tools.document_triage, "teamwork_document_triage must be registered")
    assert(tools.document_record, "teamwork_document_record must be registered")
    assert(typeof evaluateHook === "function", "permission evaluate hook must register")

    // Verify team/segment-reviewer permission hook denies edit, shell, subagent, webfetch
    for (const action of ["edit", "shell", "subagent", "webfetch"]) {
      const ev = { agent: "team/segment-reviewer", action, effect: "allow", message: "" }
      evaluateHook(ev)
      assert.strictEqual(ev.effect, "deny", `team/segment-reviewer must deny ${action}`)
    }

    const passTask = async (sessionId, taskId) => {
      const verifyDir = join(docRoot, ".opencode", "teamwork", sessionId, "verify")
      mkdirSync(verifyDir, { recursive: true })
      writeFileSync(
        join(verifyDir, `report-${taskId}.json`),
        JSON.stringify({ taskId, verifierAgent: "team/verifier", status: "PASS", checks: [{ name: "rubric", type: "rubric", passed: true }], fatalFindings: [] }) + "\n",
      )
      for (const status of ["worker_active", "worker_done", "verifier_active", "verified_pass"]) {
        const res = await tools.task_update.execute({
          sessionId,
          taskId,
          status,
          ...(status === "verified_pass" ? { verification: { status: "PASS", passedChecks: 2, totalChecks: 2 } } : {}),
        })
        assert(!res.content.startsWith("Error:"), `task_update ${taskId}->${status} failed: ${res.content}`)
      }
    }

    // --- 9.1: Positive Markdown E2E ---
    const mdDocPath = join(docRoot, "docs-design.md")
    writeFileSync(
      mdDocPath,
      [
        "# Introduction",
        "This RFC proposes a deterministic checkpoint protocol.",
        "",
        "# Threat Model",
        "All run inputs are untrusted and must stay contained.",
        "",
        "# Verification Plan",
        "Each segment yields a unit report before synthesis.",
      ].join("\n"),
    )

    const routeMd = await tools.route.execute({
      request: "Please critique ./docs-design.md for soundness and gaps.",
    })
    assert.strictEqual(routeMd.topology, "document-review", `Expected document-review, got ${routeMd.topology}`)
    assert.strictEqual(routeMd.documentDetected, true)

    const mdRun = "20261122-000001-docmd"
    const triageMd = await tools.document_triage.execute({
      sessionId: mdRun,
      request: "Please critique ./docs-design.md for soundness and gaps.",
      document: { path: "docs-design.md" },
      skipInterview: true,
    })
    assert.strictEqual(triageMd.topology, "document-review")
    assert.strictEqual(triageMd.extractionStatus, "extracted")
    assert.strictEqual(triageMd.segments.length, 3, "3-heading doc should produce 3 segments")

    const mdRunDir = join(docRoot, ".opencode", "teamwork", mdRun)
    assert(existsSync(join(mdRunDir, "document-review", "manifest.json")))
    assert(existsSync(join(mdRunDir, "document-review", "DOCUMENT_TEXT_MAP.md")))
    assert(existsSync(join(mdRunDir, "document-review", "ANALYSIS_PARTITION.md")))
    const planMd = JSON.parse(readFileSync(join(mdRunDir, "plan.dag.json"), "utf8"))
    assert.strictEqual(planMd.topology, "document-review")
    assert.deepStrictEqual(
      planMd.tasks.map((t) => t.id),
      ["seg-01", "seg-02", "seg-03", "doc-synthesis"],
    )
    assert.strictEqual(planMd.tasks[0].agent, "team/segment-reviewer")
    assert.strictEqual(planMd.tasks[3].agent, "team/synthesizer")

    let nextMd = await tools.next.execute({ sessionId: mdRun })
    assert.strictEqual(nextMd.readyForWorker.length, 3)
    assert.strictEqual(nextMd.readyForWorker[0].documentReview.role, "segment-review")
    assert.deepStrictEqual(nextMd.readyForWorker[0].documentReview.reviewTreeShape, [4, 2, 1])

    for (const seg of triageMd.segments) {
      const rec0 = await tools.document_record.execute({
        sessionId: mdRun,
        stage: "segment_analysis",
        segmentId: seg.id,
        level: 0,
        index: 0,
        summary: `Analyst 0 checked ${seg.id}`,
        findings: [{ id: "F1", severity: "Minor", claim: "Needs clarity", location: seg.id }],
        verdict: "CONCERN",
      })
      assert(rec0.artifactPath.endsWith(`segments/${seg.id}/level-0-node-0.json`))
      const rec1 = await tools.document_record.execute({
        sessionId: mdRun,
        stage: "segment_aggregate",
        segmentId: seg.id,
        level: 1,
        index: 0,
        summary: `Aggregator 0 merged ${seg.id}`,
      })
      assert(rec1.artifactPath.endsWith(`segments/${seg.id}/level-1-node-0.json`))
      const rep = await tools.document_record.execute({
        sessionId: mdRun,
        stage: "segment_report",
        segmentId: seg.id,
        summary: `Adjudicated report for ${seg.id}`,
        content: `Detailed findings for ${seg.title}.`,
        verdict: "PASS_WITH_NOTES",
      })
      assert(rep.artifactPath.endsWith(`segments/${seg.id}/unit-report.md`))
      await passTask(mdRun, seg.id)
    }

    nextMd = await tools.next.execute({ sessionId: mdRun })
    assert.strictEqual(nextMd.readyForWorker.length, 1)
    assert.strictEqual(nextMd.readyForWorker[0].id, "doc-synthesis")
    assert.strictEqual(nextMd.readyForWorker[0].documentReview.role, "cross-segment-synthesis")

    const synCand = await tools.document_record.execute({
      sessionId: mdRun,
      stage: "synthesis_candidate",
      level: 0,
      index: 0,
      summary: "Candidate synthesis 0",
      content: "Cross-segment findings.",
    })
    assert(synCand.artifactPath.endsWith("synthesis/candidate-0.md"))

    const finalDoc = await tools.document_record.execute({
      sessionId: mdRun,
      stage: "final_report",
      summary: "Unified review complete.",
      content: "All 3 segments reviewed with minor clarity recommendations.",
      verdict: "PASS_WITH_NOTES",
    })
    assert(finalDoc.artifactPath.endsWith("DOCUMENT_REVIEW_REPORT.md"))

    await passTask(mdRun, "doc-synthesis")
    await tools.security_audit.execute({ sessionId: mdRun, status: "PASS", summary: "Clean" })
    const fvPass = await tools.final_verify.execute({ sessionId: mdRun, summary: "Verified all segments." })
    assert.strictEqual(fvPass.status, "PASS", `final_verify must PASS: ${fvPass.content}`)
    const finalJson = JSON.parse(readFileSync(join(mdRunDir, "verify", "final.json"), "utf8"))
    assert.deepStrictEqual(finalJson.evidence.documentReview, {
      checked: true,
      segmentReportsComplete: true,
      finalReportPresent: true,
    })
    nextMd = await tools.next.execute({ sessionId: mdRun })
    assert.strictEqual(nextMd.status, "ALL_PASSED")
    console.log("✓ 9.1 Positive Markdown E2E passed")

    // --- 9.2: Positive PDF ingestion + validation ---
    const buildPdf = (streams) => {
      const objs = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents [${streams.map((_, idx) => `${4 + idx} 0 R`).join(" ")}] >>\nendobj\n`,
      ]
      for (let idx = 0; idx < streams.length; idx++) {
        const s = streams[idx]
        const filter = s.flate ? " /Filter /FlateDecode" : ""
        const header = `${4 + idx} 0 obj\n<< /Length ${s.bytes.length}${filter} >>\nstream\n`
        const footer = "\nendstream\nendobj\n"
        objs.push(Buffer.concat([Buffer.from(header, "latin1"), s.bytes, Buffer.from(footer, "latin1")]))
      }
      const parts = [Buffer.from("%PDF-1.4\n", "latin1")]
      for (const o of objs) parts.push(Buffer.isBuffer(o) ? o : Buffer.from(o, "latin1"))
      parts.push(Buffer.from("%%EOF\n", "latin1"))
      return Buffer.concat(parts)
    }

    const plainStream = Buffer.from("BT\n/F1 12 Tf\n72 720 Td\n(# Introduction) Tj\nT*\n(Plain stream claim one.) Tj\nET", "latin1")
    const flateStream = deflateSync(Buffer.from("BT\n[(Flate) -200 (section) -200 (text.)] TJ\nET", "latin1"))
    writeFileSync(join(docRoot, "sample.pdf"), buildPdf([{ bytes: plainStream, flate: false }, { bytes: flateStream, flate: true }]))

    const pdfRun = "20261122-000002-pdf"
    const pdfTriage = await tools.document_triage.execute({
      sessionId: pdfRun,
      document: { path: "sample.pdf" },
      skipInterview: true,
    })
    assert.strictEqual(pdfTriage.extractionStatus, "extracted")
    const textMap = readFileSync(pdfTriage.textMapPath, "utf8")
    assert(textMap.includes("Plain stream claim one."), "Plain PDF stream text must be extracted")
    assert(textMap.includes("Flate section text."), "FlateDecode PDF stream text must be extracted")

    // Corrupt PDF refused before mkdir
    writeFileSync(join(docRoot, "corrupt.pdf"), "NOT_A_PDF_HEADER")
    const corruptRun = "20261122-000002-badpdf"
    const corruptRes = await tools.document_triage.execute({
      sessionId: corruptRun,
      document: { path: "corrupt.pdf" },
      skipInterview: true,
    })
    assert(corruptRes.content.startsWith("refused:"), `Corrupt PDF must be refused: ${corruptRes.content}`)
    assert(!existsSync(join(docRoot, ".opencode", "teamwork", corruptRun)), "Corrupt PDF must not create run dir")

    // Image-only empty PDF flags needs_ingestor
    writeFileSync(join(docRoot, "scanned.pdf"), buildPdf([{ bytes: Buffer.from("q 100 0 0 100 0 0 cm /Im0 Do Q", "latin1"), flate: false }]))
    const scannedRun = "20261122-000002-scanpdf"
    const scannedRes = await tools.document_triage.execute({
      sessionId: scannedRun,
      document: { path: "scanned.pdf" },
      skipInterview: true,
    })
    assert.strictEqual(scannedRes.extractionStatus, "needs_ingestor", `Empty PDF must report needs_ingestor: ${scannedRes.content}`)
    console.log("✓ 9.2 Positive PDF + FlateDecode + corrupt refusal + needs_ingestor passed")

    // --- 9.3: Positive inline content & localhost URL ---
    const inlineRun = "20261122-000003-inline"
    const inlineRes = await tools.document_triage.execute({
      sessionId: inlineRun,
      document: { content: "# Inline RFC\n\nSection body.\n\n# Security\n\nBounds check." },
      skipInterview: true,
    })
    assert.strictEqual(inlineRes.topology, "document-review")
    assert.strictEqual(inlineRes.segments.length, 2)

    const srv = createServer((req, res) => {
      if (req.url === "/paper.md") {
        res.writeHead(200, { "Content-Type": "text/markdown" })
        res.end("# Localhost Paper\n\nFetched from 127.0.0.1.\n\n# Results\n\nAll good.")
      } else if (req.url === "/redir") {
        res.writeHead(302, { Location: "http://127.0.0.1/other" })
        res.end()
      } else {
        res.writeHead(500)
        res.end("err")
      }
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    const port = srv.address().port
    try {
      // Offline default fetchUrl=false refuses without network call
      const offlineRun = "20261122-000003-offline"
      const offlineRes = await tools.document_triage.execute({
        sessionId: offlineRun,
        document: { url: `http://127.0.0.1:${port}/paper.md` },
        skipInterview: true,
      })
      assert(offlineRes.content.startsWith("refused:"), "fetchUrl=false must refuse live fetch")
      assert(!existsSync(join(docRoot, ".opencode", "teamwork", offlineRun)), "Refused URL must not mkdir")

      // Live localhost fetchUrl=true succeeds
      const urlRun = "20261122-000003-urlok"
      const urlOk = await tools.document_triage.execute({
        sessionId: urlRun,
        document: { url: `http://127.0.0.1:${port}/paper.md` },
        fetchUrl: true,
        skipInterview: true,
      })
      assert.strictEqual(urlOk.topology, "document-review")
      assert.strictEqual(urlOk.segments.length, 2)

      // 302 redirect refused before mkdir
      const redirRun = "20261122-000003-redir"
      const redirRes = await tools.document_triage.execute({
        sessionId: redirRun,
        document: { url: `http://127.0.0.1:${port}/redir` },
        fetchUrl: true,
        skipInterview: true,
      })
      assert(redirRes.content.includes("redirect"), `302 must be refused: ${redirRes.content}`)
      assert(!existsSync(join(docRoot, ".opencode", "teamwork", redirRun)))

      // 500 error refused before mkdir
      const errRun = "20261122-000003-err500"
      const errRes = await tools.document_triage.execute({
        sessionId: errRun,
        document: { url: `http://127.0.0.1:${port}/boom` },
        fetchUrl: true,
        skipInterview: true,
      })
      assert(errRes.content.includes("HTTP 500"), `500 must be refused: ${errRes.content}`)
      assert(!existsSync(join(docRoot, ".opencode", "teamwork", errRun)))
    } finally {
      await new Promise((r) => srv.close(r))
    }

    // Closed port refused before mkdir
    const closedRun = "20261122-000003-closed"
    const closedRes = await tools.document_triage.execute({
      sessionId: closedRun,
      document: { url: `http://127.0.0.1:${port}/paper.md` },
      fetchUrl: true,
      skipInterview: true,
    })
    assert(closedRes.content.startsWith("refused:"))
    assert(!existsSync(join(docRoot, ".opencode", "teamwork", closedRun)))
    console.log("✓ 9.3 Positive inline content & localhost URL checks passed")

    // --- 9.4: Math-paper precedence ---
    writeFileSync(
      join(docRoot, "math-paper.md"),
      "# Theorem 1\nFor all x, there exists y.\n\\begin{theorem}\n\\forall x \\exists y\n\\end{theorem}\n",
    )
    const mathPaperRoute = await tools.route.execute({
      request: "Referee and critique ./math-paper.md (check its Theorem 1 proof).",
    })
    assert.strictEqual(mathPaperRoute.topology, "document-review", "Supplied math paper must beat proof")

    const inlineMathPaperRoute = await tools.route.execute({
      request:
        "Review this preprint:\n<<<DOCUMENT\n\\begin{theorem}\n∀ n ∃ p > n prime.\n\\end{theorem}\n\\begin{proof}\nConsider N! + 1.\n\\end{proof}\n>>>",
    })
    assert.strictEqual(inlineMathPaperRoute.topology, "document-review", "Inline math paper must beat proof")

    const posedProof = await tools.route.execute({
      request: "Prove that there are infinitely many primes ∀ n ∃ p > n.",
    })
    assert.strictEqual(posedProof.topology, "proof")

    const posedMassive = await tools.route.execute({
      request: "Prove this open conjecture using a very large team with 100+ searchers.",
    })
    assert.strictEqual(posedMassive.topology, "massive-proof")

    const leanSyntaxOnly = await tools.route.execute({
      request: "Refactor the helper signatures in Parser.lean.",
    })
    assert.strictEqual(leanSyntaxOnly.topology, "distributed-coding", "Bare .lean syntax must not route to proof")
    console.log("✓ 9.4 Math-paper precedence & Priorities 2-7 passed")

    // --- 9.5: Negative triggers ---
    writeFileSync(join(docRoot, "README.md"), "# Readme\n")
    writeFileSync(join(docRoot, "notes.md"), "# Notes\n")
    writeFileSync(join(docRoot, "paper.pdf"), "%PDF-1.4\n%%EOF\n")
    const negCases = [
      ["review this PR", "distributed-coding"],
      ["review PR #42", "distributed-coding"],
      ["code review src/auth.ts", "distributed-coding"],
      ["review my design", "distributed-coding"],
      ["Mentioning paper.pdf", "distributed-coding"],
      ["check README.md and implement the missing flag", "distributed-coding"],
      ["fix the bug in notes.md", "iterative-coding"],
      ["see ./paper.pdf and solve problem 3", "proof"],
      ["prove Theorem 2 from ./math-paper.md", "proof"],
    ]
    for (const [req, expected] of negCases) {
      const r = await tools.route.execute({ request: req })
      assert.strictEqual(r.topology, expected, `Negative trigger "${req}" routed to ${r.topology}, expected ${expected}`)
      assert.notStrictEqual(r.topology, "document-review", `Negative trigger "${req}" must not trigger document-review`)
    }
    console.log("✓ 9.5 Negative triggers passed")

    // --- 9.6: Bounded depth/width & artifact completeness ---
    const badBoundsCases = [
      { maxSegments: 9 },
      { reviewTreeShape: [5, 2, 1] },
      { reviewTreeShape: [4, 2, 2, 1] },
      { reviewTreeShape: [2, 4, 1] },
      { synthTreeShape: [5, 1] },
      { synthTreeShape: [4, 2] },
    ]
    for (let i = 0; i < badBoundsCases.length; i++) {
      const sid = `20261122-000006-badb${i}`
      const res = await tools.document_triage.execute({
        sessionId: sid,
        document: { path: "docs-design.md" },
        skipInterview: true,
        ...badBoundsCases[i],
      })
      assert(res.content.startsWith("refused:"), `Out-of-bounds ${JSON.stringify(badBoundsCases[i])} must refuse: ${res.content}`)
      assert(!existsSync(join(docRoot, ".opencode", "teamwork", sid)), "Refused bounds must not mkdir")
    }

    // 25-section deterministic packing <= 8 segments (default 6)
    const bigSections = Array.from({ length: 25 }, (_, i) => `# Section ${i + 1}\n\nParagraph content for section ${i + 1}.`).join("\n\n")
    const packRun = "20261122-000006-pack"
    const packRes = await tools.document_triage.execute({
      sessionId: packRun,
      document: { content: bigSections },
      skipInterview: true,
    })
    assert(packRes.segments.length >= 1 && packRes.segments.length <= 8, `25 sections packed to ${packRes.segments.length}`)

    // Out-of-bounds level/index & invalid segmentId refused by document_record
    const badLevel = await tools.document_record.execute({
      sessionId: packRun,
      stage: "segment_analysis",
      segmentId: "seg-01",
      level: 9,
      index: 0,
      summary: "oob",
    })
    assert(badLevel.content.startsWith("refused:"))
    const badIndex = await tools.document_record.execute({
      sessionId: packRun,
      stage: "segment_analysis",
      segmentId: "seg-01",
      level: 0,
      index: 4,
      summary: "oob",
    })
    assert(badIndex.content.startsWith("refused:"))
    const badSeg = await tools.document_record.execute({
      sessionId: packRun,
      stage: "segment_report",
      segmentId: "../x",
      summary: "bad",
    })
    assert(badSeg.content.startsWith("refused:"))
    const protoSeg = await tools.document_record.execute({
      sessionId: packRun,
      stage: "segment_report",
      segmentId: "__proto__",
      summary: "bad",
    })
    assert(protoSeg.content.startsWith("refused:"))

    // Missing unit-report.md or DOCUMENT_REVIEW_REPORT.md fails final_verify even when tasks+audit PASS
    for (const seg of packRes.segments) {
      await passTask(packRun, seg.id)
    }
    await passTask(packRun, "doc-synthesis")
    await tools.security_audit.execute({ sessionId: packRun, status: "PASS", summary: "ok" })
    const fvMissing = await tools.final_verify.execute({ sessionId: packRun })
    assert.strictEqual(fvMissing.status, "FAIL", "final_verify must FAIL when unit-report.md and DOCUMENT_REVIEW_REPORT.md are missing")
    assert(fvMissing.reasons.some((r) => r.includes("unit-report.md missing")))
    assert(fvMissing.reasons.some((r) => r.includes("DOCUMENT_REVIEW_REPORT.md missing")))
    console.log("✓ 9.6 Bounded depth/width, packing, and final_verify completeness passed")

    // --- 9.7: Security (traversal, symlinks, sanitisation) ---
    writeFileSync(join(outsideDir, "secret.md"), "# Secret\nDo not read")
    for (const [label, badPath] of [
      ["traversal", "../../etc/passwd"],
      ["abs", "/etc/passwd"],
    ]) {
      const sid = `20261122-000007-${label}`
      const res = await tools.document_triage.execute({
        sessionId: sid,
        document: { path: badPath },
        skipInterview: true,
      })
      assert(res.content.startsWith("refused:"), `${label} must be refused: ${res.content}`)
      assert(!existsSync(join(docRoot, ".opencode", "teamwork", sid)))
    }

    symlinkSync(join(outsideDir, "secret.md"), join(docRoot, "link-secret.md"))
    const symDocRes = await tools.document_triage.execute({
      sessionId: "20261122-000007-symdoc",
      document: { path: "link-secret.md" },
      skipInterview: true,
    })
    assert(symDocRes.content.startsWith("refused:"), "Symlinked doc file must be refused")

    symlinkSync(outsideDir, join(docRoot, "link-dir"))
    const symDirRes = await tools.document_triage.execute({
      sessionId: "20261122-000007-symdir",
      document: { path: "link-dir/secret.md" },
      skipInterview: true,
    })
    assert(symDirRes.content.startsWith("refused:"), "Symlinked parent dir must be refused")

    // Symlinked target unit-report.md refused by document_record
    const secRun = "20261122-000007-sec"
    await tools.document_triage.execute({
      sessionId: secRun,
      document: { content: "# Safe\n\nContent." },
      skipInterview: true,
    })
    const secSegDir = join(docRoot, ".opencode", "teamwork", secRun, "document-review", "segments", "seg-01")
    mkdirSync(secSegDir, { recursive: true })
    const canaryOut = join(outsideDir, "canary.md")
    writeFileSync(canaryOut, "CANARY")
    symlinkSync(canaryOut, join(secSegDir, "unit-report.md"))
    const symRec = await tools.document_record.execute({
      sessionId: secRun,
      stage: "segment_report",
      segmentId: "seg-01",
      summary: "Should not overwrite symlink target",
    })
    assert(symRec.content.startsWith("refused:"), `Symlinked unit-report.md must be refused: ${symRec.content}`)
    assert.strictEqual(readFileSync(canaryOut, "utf8"), "CANARY")

    // Symlinked document-review/ directory refused
    const secRun2 = "20261122-000007-sec2"
    await tools.document_triage.execute({
      sessionId: secRun2,
      document: { content: "# Safe\n\nContent." },
      skipInterview: true,
    })
    rmSync(join(docRoot, ".opencode", "teamwork", secRun2, "document-review"), { recursive: true, force: true })
    symlinkSync(outsideDir, join(docRoot, ".opencode", "teamwork", secRun2, "document-review"))
    const symDocDirRec = await tools.document_record.execute({
      sessionId: secRun2,
      stage: "final_report",
      summary: "Should refuse symlinked document-review dir",
    })
    assert(symDocDirRec.content.startsWith("refused:"))

    // Control characters stripped from persisted outputs
    const cleanRun = "20261122-000007-clean"
    await tools.document_triage.execute({
      sessionId: cleanRun,
      document: { content: "# Section\n\nBody with \x1b[31mANSI\x1b[0m and\u0085C1\u2028sep." },
      skipInterview: true,
    })
    const cleanMap = readFileSync(join(docRoot, ".opencode", "teamwork", cleanRun, "document-review", "DOCUMENT_TEXT_MAP.md"), "utf8")
    assert(!/[\x1b\u0085\u2028\u2029]/.test(cleanMap), "Control chars must be stripped from DOCUMENT_TEXT_MAP.md")

    await tools.document_record.execute({
      sessionId: cleanRun,
      stage: "final_report",
      summary: "Summary\x1b[31mX\u0085Y\u2028Z",
      content: "Detail\x1b[32mA\u0085B\u2028C",
    })
    const cleanRep = readFileSync(join(docRoot, ".opencode", "teamwork", cleanRun, "DOCUMENT_REVIEW_REPORT.md"), "utf8")
    assert(!/[\x1b\u0085\u2028\u2029]/.test(cleanRep), "Control chars must be stripped from DOCUMENT_REVIEW_REPORT.md")
    console.log("✓ 9.7 Security (traversal, symlinks, SEGMENT_ID, sanitisation) passed")
  } finally {
    rmSync(docRoot, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
}
