import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { listTeamworkRuns, inspectTeamworkRun, pruneTeamworkWorktrees } from "../lib/runs.mjs"
import { currentModels, readRawModelMap, writeModelMap, installAgents, DEFAULT_MODELS } from "../lib/team.mjs"
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
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
  let phase = JSON.parse(readFileSync(mainStateFile, "utf8")).phase
  assert.strictEqual(phase, "FINAL_VERIFICATION", "Phase must advance to FINAL_VERIFICATION")

  // (b) A FAIL final report blocks the run (never ALL_PASSED).
  mkdirSync(dirname(finalFile), { recursive: true })
  writeFileSync(finalFile, JSON.stringify({ status: "FAIL", summary: "acceptance criteria not met" }) + "\n")
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "BLOCKED_BY_FINAL_VERIFICATION", "A FAIL final report must block the run")
  assert.notStrictEqual(nextRes.status, "ALL_PASSED")
  assert.strictEqual(nextRes.finalReport, finalFile)

  // (c) Only a PASS final report completes the run.
  writeFileSync(finalFile, JSON.stringify({ status: "PASS", summary: "independent final check passed" }) + "\n")
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "ALL_PASSED", "A PASS final report is required for ALL_PASSED")
  assert.strictEqual(nextRes.finalReport, finalFile, "ALL_PASSED must include the final report path")
  phase = JSON.parse(readFileSync(mainStateFile, "utf8")).phase
  assert.strictEqual(phase, "MERGE", "Phase must advance to MERGE only after final PASS")

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
    ["ts", "event", "sessionId", "taskId", "from", "to", "round", "agent", "branch", "worktree", "phase", "specGate", "specPath"],
    "existing run_created fields must keep their order; the gate fields are appended",
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
  async function attrFixture(runId, planAgent = "team/worker", taskIds = ["alpha"]) {
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
        session: { get: async () => undefined },
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
    console.log("✓ explicit agent (team/worker and team/verifier) is recorded as the actor in events.jsonl")
  }

  // --- 6f: with no explicit agent and no calling session, the plan-declared agent is the fallback.
  {
    const RUN = "20261018-000000-plan"
    const f = await attrFixture(RUN, "team/worker")
    await f.tools.task_update.execute({ sessionId: RUN, taskId: "alpha", status: "worker_active" })
    const last = readEvents(f.root, RUN).at(-1)
    assert.strictEqual(last.agent, "team/worker", "plan-declared agent must be the fallback actor")
    console.log("✓ plan-declared agent is the fallback actor when none is supplied")
  }

  // --- 6g: a garbage agent with control characters cannot inject a second JSONL line.
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
