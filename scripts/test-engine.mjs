import { registerTeamworkTools, registerTeamworkHooks, describeRun, touch, nextEventSeq } from "../plugins/opencode-teamwork/tools.ts"
import {
  analyzeLeanDeclarations,
  bindVerifiedDeclaration,
  checkLeanAxiomDependencies,
  classifyRoute as classifyLemmaRoute,
  detectAxiomProbeHijacks,
  detectLeanProofHoles,
  formatMissingToolchainRefusal,
  leanStatementMatches,
  LEAP_REQUIREMENT,
  parseLeanAxiomOutput,
  parseLeanDeclarations,
  probeLemmaToolchain,
  stripLeanComments,
  stripLeanCommentsAndStrings,
  validateLemmaPolicy,
  verifyLeanFile,
} from "../plugins/opencode-teamwork/lemma.ts"
import { compareCandidates, classifyRoute, maskCodeAndQuotes, clean, cleanBlock, readBoundedRunFile, writeSafeRunFile } from "../plugins/opencode-teamwork/tournament.ts"
import { listTeamworkRuns, inspectTeamworkRun, pruneTeamworkWorktrees } from "../lib/runs.mjs"
import {
  currentModels,
  writeModelMap,
  installAgents,
  ensureAgents,
  registerPlugin,
  writeReferenceFile,
  DEFAULT_MODELS,
} from "../lib/team.mjs"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createServer } from "node:http"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { createHash, randomBytes } from "node:crypto"
import assert from "node:assert"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-engine-test-"))
// Sonar S6324: build ESC without embedding a control character in a regex literal.
const ESC_CHAR = String.fromCharCode(27)

// Compare URLs by parsed origin/path instead of substring containment
// (CodeQL js/incomplete-url-substring-sanitization).
function mentionsExactUrl(text, expected) {
  const want = new URL(expected).href
  for (const m of String(text).matchAll(/https?:\/\/[^\s)>"']+/g)) {
    try {
      if (new URL(m[0]).href === want) return true
    } catch {}
  }
  return false
}

// Record a default CONFIRMED victory verdict through the real tool, with a
// trusted session identity that only the fixture controls. Tests that expect a
// later final_verify PASS on a request-bearing run use this instead of
// weakening the victory requirement.
async function stampVictoryFor(tools, ctx, root, runId, { sessionID = "ses_victory_auditor", summary = "Fixture audit: delivered work matches the request." } = {}) {
  const reqs = JSON.parse(readFileSync(join(root, ".opencode", "teamwork", runId, "requirements.json"), "utf8"))
  const originalGet = ctx?.session?.get
  if (ctx?.session) ctx.session.get = async () => ({ agent: "team/victory-auditor" })
  try {
    const res = await tools.victory_audit.execute(
      {
        sessionId: runId,
        verdict: "VICTORY CONFIRMED",
        requirements: reqs.items.map((item) => ({ id: item.id, met: true, evidence: `Fixture evidence for ${item.id}` })),
        summary,
      },
      { sessionID },
    )
    assert.strictEqual(res.verdict?.verdict, "VICTORY CONFIRMED", `stampVictoryFor(${runId}) failed: ${res.content}`)
    return res
  } finally {
    if (ctx?.session) ctx.session.get = originalGet
  }
}

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
  assert(registeredTools.wave_record, "wave_record tool must be registered")
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
    const r = await registeredTools.plan.execute({
      sessionId: id,
      topology: alias,
      skipInterview: true,
      ...(canonical === "massive-proof" ? { massiveProofOptIn: true, budgetUsd: 20 } : {}),
      tasks: [{ id: "T1" }],
    })
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

  // (b2) existence is decided by O_EXCL, not a pre-read: an empty file refuses too.
  const emptyReqRun = "20261018-000000-request-empty"
  mkdirSync(join(testDir, ".opencode", "teamwork", emptyReqRun), { recursive: true })
  writeFileSync(requestFileOf(emptyReqRun), "")
  const emptyReq = await registeredTools.plan.execute({
    sessionId: emptyReqRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "a new request over an empty file",
    tasks: [{ id: "E1" }],
  })
  assert(emptyReq.content.startsWith("refused:"), `an existing empty request file must be refused: ${emptyReq.content}`)
  assert(/write-once/i.test(emptyReq.content), "empty-file refusal must state write-once")
  assert.strictEqual(readFileSync(requestFileOf(emptyReqRun), "utf8"), "", "the empty request file must be left untouched")
  assert(!existsSync(planFileOf(emptyReqRun)), "a refused empty-file request must not write a plan")

  // (b3) a symlink at the request path is refused and its target is untouched.
  const symReqRun = "20261018-000000-request-symlink"
  mkdirSync(join(testDir, ".opencode", "teamwork", symReqRun), { recursive: true })
  const requestVictim = join(testDir, "request-victim.txt")
  writeFileSync(requestVictim, "VICTIM")
  symlinkSync(requestVictim, requestFileOf(symReqRun))
  const symReq = await registeredTools.plan.execute({
    sessionId: symReqRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "write through a symlink",
    tasks: [{ id: "S1" }],
  })
  assert(symReq.content.startsWith("refused:"), `a symlinked request path must be refused: ${symReq.content}`)
  assert.strictEqual(readFileSync(requestVictim, "utf8"), "VICTIM", "the symlink target must remain untouched")
  assert(!existsSync(planFileOf(symReqRun)), "a refused symlink request must not write a plan")

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

  // (c2) a supplied but blank request is refused before anything is written.
  const blankRequestRun = "20261018-000000-blank-request"
  for (const blank of ["", "   ", "\n\t  \n"]) {
    const blankRes = await registeredTools.plan.execute({
      sessionId: blankRequestRun,
      topology: "iterative-coding",
      skipInterview: true,
      request: blank,
      tasks: [{ id: "B1" }],
    })
    assert(blankRes.content.startsWith("refused: request must be non-empty"), `blank request must be refused: ${blankRes.content}`)
  }
  assert(!existsSync(join(testDir, ".opencode", "teamwork", blankRequestRun)), "a blank request must write nothing")

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
  await stampVictoryFor(registeredTools, mockCtx, testDir, gateRun)

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
  const seedVerifiedRun = async (runId, taskIds, { request, integrityMode, auditStatus = "PASS", stampVictory = request !== undefined, victoryAudit, verification } = {}) => {
    await registeredTools.plan.execute({
      sessionId: runId,
      topology: "iterative-coding",
      skipInterview: true,
      ...(request !== undefined ? { request, integrityMode } : {}),
      ...(victoryAudit !== undefined ? { victoryAudit } : {}),
      ...(verification !== undefined ? { verification } : {}),
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
    if (stampVictory && request !== undefined) await stampVictoryFor(registeredTools, mockCtx, testDir, runId)
  }
  const finalFileOf = (runId) => runFile(testDir, runId, "verify/final.json")

  // (a) All tasks verified_pass + every report PASS + audit PASS -> PASS, stamped, event appended.
  const fvPassRun = "20261018-000000-fv-pass"
  await seedVerifiedRun(fvPassRun, ["F1", "F2"], { request: "Implement and verify the fixture functionality." })
  assert(existsSync(runFile(testDir, fvPassRun, "ORIGINAL_REQUEST.md")), "fixture run records the request it is audited against")
  const fvPassRequirements = JSON.parse(readFileSync(runFile(testDir, fvPassRun, "requirements.json"), "utf8"))
  assert.strictEqual(fvPassRequirements.source, "request", "the request-derived baseline must be recorded")
  assert.strictEqual(fvPassRequirements.items[0].id, "R1")
  assert(!existsSync(finalFileOf(fvPassRun)), "fixture must start without final.json")
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
  assert.strictEqual(fvPassReport.victory, "CONFIRMED", "a PASS must record the confirmed victory audit")
  assert.strictEqual(fvPassReport.evidence.victory.status, "CONFIRMED")
  assert.strictEqual(fvPassReport.evidence.victory.auditor, "team/victory-auditor")
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
  // Part 1c-ter-victory: requirements baseline + independent victory audit
  // ==========================================
  console.log("Testing requirements baseline & independent victory audit...")

  const vRunDir = (runId) => join(testDir, ".opencode", "teamwork", runId)
  const vPlanFile = (runId) => join(vRunDir(runId), "plan.dag.json")
  const vRequirementsFile = (runId) => join(vRunDir(runId), "requirements.json")
  const vVictoryFile = (runId) => join(vRunDir(runId), "verify", "victory.json")

  // Caller requirements are persisted verbatim in id order and make victory required.
  const vCallerRun = "20261018-000000-v-caller"
  const vCallerPlan = await registeredTools.plan.execute({
    sessionId: vCallerRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "Build the caller-requirements fixture.",
    requirements: [
      { id: "R1", text: "First behaviour is observable." },
      { id: "R2", text: "Second behaviour is observable." },
    ],
    tasks: [{ id: "V1" }],
  })
  assert(vCallerPlan.content.startsWith("Planned"), `caller requirements must plan: ${vCallerPlan.content}`)
  const vCallerReqs = JSON.parse(readFileSync(vRequirementsFile(vCallerRun), "utf8"))
  assert.deepStrictEqual(vCallerReqs, {
    version: 1,
    source: "caller",
    items: [
      { id: "R1", text: "First behaviour is observable." },
      { id: "R2", text: "Second behaviour is observable." },
    ],
  })
  assert.strictEqual(JSON.parse(readFileSync(vPlanFile(vCallerRun), "utf8")).victoryAudit, "required")
  assert.strictEqual(JSON.parse(readFileSync(join(vRunDir(vCallerRun), "state.json"), "utf8")).victoryAudit, "required")

  // A request with no explicit requirements yields the single R1 baseline.
  const vRequestRun = "20261018-000000-v-request"
  await registeredTools.plan.execute({
    sessionId: vRequestRun,
    topology: "iterative-coding",
    skipInterview: true,
    request: "Ship the request-derived item.",
    tasks: [{ id: "V1" }],
  })
  const vRequestReqs = JSON.parse(readFileSync(vRequirementsFile(vRequestRun), "utf8"))
  assert.strictEqual(vRequestReqs.source, "request")
  assert.strictEqual(vRequestReqs.items.length, 1)
  assert.strictEqual(vRequestReqs.items[0].id, "R1")
  assert(vRequestReqs.items[0].text.includes("request-derived item"), "R1 must contain the verbatim request text")

  // Invalid ids, duplicates, empty text, and over-cap baselines are refused before mkdir.
  for (const [label, requirements] of [
    ["bad-id", [{ id: "bad id", text: "x" }]],
    ["duplicate-id", [{ id: "R1", text: "a" }, { id: "R1", text: "b" }]],
    ["empty-text", [{ id: "R1", text: "   " }]],
    ["over-long-text", [{ id: "R1", text: "x".repeat(2001) }]],
    ["over-cap", Array.from({ length: 51 }, (_, i) => ({ id: `R${i + 1}`, text: "x" }))],
  ]) {
    const sid = `20261018-000000-v-bad-${label}`
    const res = await registeredTools.plan.execute({
      sessionId: sid,
      topology: "iterative-coding",
      skipInterview: true,
      requirements,
      tasks: [{ id: "V1" }],
    })
    assert(res.content.startsWith("refused:"), `${label} requirements must be refused: ${res.content}`)
    assert(!existsSync(vRunDir(sid)), `${label} refusal must create no run dir`)
  }

  // Victory tool authorization: an unknown/other trusted session agent is refused,
  // and there is no caller-supplied label that can self-authorize.
  const vAuthRun = "20261018-000000-v-auth"
  await seedVerifiedRun(vAuthRun, ["V1"], { request: "Authorize the victory auditor.", stampVictory: false })
  const vAuthRequirements = JSON.parse(readFileSync(vRequirementsFile(vAuthRun), "utf8")).items.map((item) => ({
    id: item.id,
    met: true,
    evidence: "observed",
  }))
  const vWrongAgent = await registeredTools.victory_audit.execute(
    { sessionId: vAuthRun, verdict: "VICTORY CONFIRMED", requirements: vAuthRequirements },
    { sessionID: "ses_not_victory" },
  )
  assert(vWrongAgent.content.startsWith("refused:"), `unknown session identity must be refused: ${vWrongAgent.content}`)
  const originalAuditorGet = mockCtx.session.get
  mockCtx.session.get = async () => ({ agent: "team/verifier" })
  try {
    const vVerifier = await registeredTools.victory_audit.execute(
      { sessionId: vAuthRun, verdict: "VICTORY CONFIRMED", requirements: vAuthRequirements },
      { sessionID: "ses_not_victory" },
    )
    assert(vVerifier.content.startsWith("refused:"), `team/verifier must not self-authorize: ${vVerifier.content}`)
  } finally {
    mockCtx.session.get = originalAuditorGet
  }
  assert(!existsSync(vVictoryFile(vAuthRun)), "a refused caller must write no verdict")

  // Requirement result validation: missing, unknown, duplicate, and met-without-evidence.
  const originalVictoryGet = mockCtx.session.get
  mockCtx.session.get = async () => ({ agent: "team/victory-auditor" })
  try {
    const vMissingId = await registeredTools.victory_audit.execute(
      { sessionId: vAuthRun, verdict: "VICTORY CONFIRMED", requirements: [] },
      { sessionID: "ses_victory_auditor" },
    )
    assert(/missing/.test(vMissingId.content), `missing requirement id must be refused: ${vMissingId.content}`)
    const vUnknownId = await registeredTools.victory_audit.execute(
      {
        sessionId: vAuthRun,
        verdict: "VICTORY CONFIRMED",
        requirements: [{ id: "R1", met: true, evidence: "x" }, { id: "RX", met: true, evidence: "x" }],
      },
      { sessionID: "ses_victory_auditor" },
    )
    assert(/not in this run/.test(vUnknownId.content), `unknown requirement id must be refused: ${vUnknownId.content}`)
    const vDuplicateId = await registeredTools.victory_audit.execute(
      {
        sessionId: vAuthRun,
        verdict: "VICTORY CONFIRMED",
        requirements: [
          { id: "R1", met: true, evidence: "x" },
          { id: "R1", met: true, evidence: "x" },
        ],
      },
      { sessionID: "ses_victory_auditor" },
    )
    assert(/duplicate/.test(vDuplicateId.content), `duplicate requirement id must be refused: ${vDuplicateId.content}`)
    const vNoEvidence = await registeredTools.victory_audit.execute(
      { sessionId: vAuthRun, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "  " }] },
      { sessionID: "ses_victory_auditor" },
    )
    assert(/no evidence/.test(vNoEvidence.content), `met without evidence must be refused: ${vNoEvidence.content}`)
  } finally {
    mockCtx.session.get = originalVictoryGet
  }
  assert(!existsSync(vVictoryFile(vAuthRun)), "invalid audit results must write no verdict")

  // CONFIRMED without ORIGINAL_REQUEST.md is refused (requestHash cannot be forged).
  const vNoRequestRun = "20261018-000000-v-norequest"
  await registeredTools.plan.execute({
    sessionId: vNoRequestRun,
    topology: "iterative-coding",
    skipInterview: true,
    requirements: [{ id: "R1", text: "Caller-only baseline." }],
    tasks: [{ id: "V1" }],
  })
  mockCtx.session.get = async () => ({ agent: "team/victory-auditor" })
  try {
    const vNoRequest = await registeredTools.victory_audit.execute(
      { sessionId: vNoRequestRun, verdict: "VICTORY CONFIRMED", requirements: [{ id: "R1", met: true, evidence: "seen" }] },
      { sessionID: "ses_victory_auditor" },
    )
    assert(/without ORIGINAL_REQUEST/.test(vNoRequest.content), `CONFIRMED without a request must be refused: ${vNoRequest.content}`)
  } finally {
    mockCtx.session.get = originalVictoryGet
  }

  // Happy path: confirmed audit -> final_verify PASS -> next ALL_PASSED.
  const vHappyRun = "20261018-000000-v-happy"
  await seedVerifiedRun(vHappyRun, ["V1"], { request: "Deliver the happy-path fixture.", stampVictory: false })
  const vHappyReqs = JSON.parse(readFileSync(vRequirementsFile(vHappyRun), "utf8")).items.map((item) => ({
    id: item.id,
    met: true,
    evidence: `Observed ${item.id} in the fixture artifact.`,
  }))
  mockCtx.session.get = async () => ({ agent: "team/victory-auditor" })
  try {
    const vHappyAudit = await registeredTools.victory_audit.execute(
      { sessionId: vHappyRun, verdict: "VICTORY CONFIRMED", requirements: vHappyReqs, summary: "Fixture matches." },
      { sessionID: "ses_victory_auditor" },
    )
    assert.strictEqual(vHappyAudit.verdict?.verdict, "VICTORY CONFIRMED")
    assert.strictEqual(vHappyAudit.verdict?.auditor, "team/victory-auditor")
    assert.strictEqual(vHappyAudit.verdict?.auditorSessionId, "ses_victory_auditor")
    assert(/^[0-9a-f]{64}$/.test(vHappyAudit.verdict?.requestHash), "the verdict must bind to a sha256 request hash")
    // A second CONFIRMED is refused (write-once).
    const vOverwrite = await registeredTools.victory_audit.execute(
      { sessionId: vHappyRun, verdict: "VICTORY CONFIRMED", requirements: vHappyReqs },
      { sessionID: "ses_victory_auditor" },
    )
    assert(/write-once/.test(vOverwrite.content), `a confirmed verdict must be write-once: ${vOverwrite.content}`)
  } finally {
    mockCtx.session.get = originalVictoryGet
  }
  const vHappyEvents = readEvents(testDir, vHappyRun).filter((e) => e.event === "victory_audit")
  assert.strictEqual(vHappyEvents.length, 1, "the audit must append exactly one victory_audit event")
  assert.strictEqual(vHappyEvents[0].agent, "team/victory-auditor")
  assert.strictEqual(vHappyEvents[0].to, "VICTORY CONFIRMED")
  const vHappyFinal = await registeredTools.final_verify.execute({ sessionId: vHappyRun })
  assert.strictEqual(vHappyFinal.status, "PASS", `confirmed victory must PASS final_verify: ${vHappyFinal.content}`)
  assert.strictEqual(vHappyFinal.victory, "CONFIRMED")
  const vHappyFinalJson = JSON.parse(readFileSync(finalFileOf(vHappyRun), "utf8"))
  assert.strictEqual(vHappyFinalJson.victory, "CONFIRMED")
  assert.strictEqual(vHappyFinalJson.evidence.victory.auditor, "team/victory-auditor")
  const vHappyGate = await registeredTools.next.execute({ sessionId: vHappyRun })
  assert.strictEqual(vHappyGate.status, "ALL_PASSED")
  assert.strictEqual(vHappyGate.victory, "CONFIRMED")

  // Missing verdict: final_verify FAIL, and next never reports ALL_PASSED.
  const vMissingRun = "20261018-000000-v-missing"
  await seedVerifiedRun(vMissingRun, ["V1"], { request: "Deliver the missing-verdict fixture.", stampVictory: false })
  const vMissingFinal = await registeredTools.final_verify.execute({ sessionId: vMissingRun })
  assert.strictEqual(vMissingFinal.status, "FAIL", "missing victory.json must FAIL final_verify")
  assert(vMissingFinal.reasons.some((r) => /victory audit:.*victory\.json missing/.test(r)), `the reason must name the missing verdict: ${JSON.stringify(vMissingFinal.reasons)}`)
  const vMissingGate = await registeredTools.next.execute({ sessionId: vMissingRun })
  assert.notStrictEqual(vMissingGate.status, "ALL_PASSED", "next must not complete without a victory verdict")

  // A stamped PASS with no victory verdict is blocked at the dedicated gate.
  const vNextRun = "20261018-000000-v-next-gate"
  await seedVerifiedRun(vNextRun, ["V1"], { request: "Deliver the next-gate fixture.", stampVictory: false })
  const vNextFinalFile = finalFileOf(vNextRun)
  mkdirSync(dirname(vNextFinalFile), { recursive: true })
  writeFileSync(
    vNextFinalFile,
    JSON.stringify({
      status: "PASS",
      generatedBy: { agent: "team/verifier", session: "ses_next_fixture" },
      generatedAt: new Date().toISOString(),
      evidence: {},
      reasons: [],
    }) + "\n",
  )
  const vNextBefore = await registeredTools.next.execute({ sessionId: vNextRun })
  assert.strictEqual(vNextBefore.status, "READY_FOR_VICTORY_AUDIT", `next must stop at the victory gate: ${vNextBefore.content}`)
  assert.notStrictEqual(vNextBefore.status, "ALL_PASSED")
  await stampVictoryFor(registeredTools, mockCtx, testDir, vNextRun)
  const vNextAfter = await registeredTools.next.execute({ sessionId: vNextRun })
  assert.strictEqual(vNextAfter.status, "ALL_PASSED", `confirmed victory must unblock next: ${vNextAfter.content}`)

  // REJECTED -> FAIL and no completion.
  const vRejectedRun = "20261018-000000-v-rejected"
  await seedVerifiedRun(vRejectedRun, ["V1"], { request: "Deliver the rejected fixture.", stampVictory: false })
  mockCtx.session.get = async () => ({ agent: "team/victory-auditor" })
  try {
    const vRejectedAudit = await registeredTools.victory_audit.execute(
      {
        sessionId: vRejectedRun,
        verdict: "VICTORY REJECTED",
        requirements: [{ id: "R1", met: false, evidence: "The requested behavior is absent." }],
        findings: ["R1 is not implemented."],
      },
      { sessionID: "ses_victory_auditor" },
    )
    assert.strictEqual(vRejectedAudit.verdict?.verdict, "VICTORY REJECTED")
  } finally {
    mockCtx.session.get = originalVictoryGet
  }
  const vRejectedFinal = await registeredTools.final_verify.execute({ sessionId: vRejectedRun })
  assert.strictEqual(vRejectedFinal.status, "FAIL", "a rejected victory must FAIL final_verify")
  assert(vRejectedFinal.reasons.some((r) => r.includes("VICTORY REJECTED")), `the reason must name the rejection: ${JSON.stringify(vRejectedFinal.reasons)}`)
  const vRejectedGate = await registeredTools.next.execute({ sessionId: vRejectedRun })
  assert.notStrictEqual(vRejectedGate.status, "ALL_PASSED")

  // One unmet requirement -> FAIL with the requirement id.
  const vUnmetRun = "20261018-000000-v-unmet"
  await seedVerifiedRun(vUnmetRun, ["V1"], { request: "Deliver the unmet fixture.", stampVictory: false })
  mockCtx.session.get = async () => ({ agent: "team/victory-auditor" })
  try {
    await registeredTools.victory_audit.execute(
      {
        sessionId: vUnmetRun,
        verdict: "VICTORY CONFIRMED",
        requirements: [{ id: "R1", met: false, evidence: "" }],
      },
      { sessionID: "ses_victory_auditor" },
    )
  } finally {
    mockCtx.session.get = originalVictoryGet
  }
  const vUnmetFinal = await registeredTools.final_verify.execute({ sessionId: vUnmetRun })
  assert.strictEqual(vUnmetFinal.status, "FAIL", "an unmet requirement must FAIL final_verify")
  assert(vUnmetFinal.reasons.some((r) => r.includes('requirement "R1" is not met')), `the reason must name R1: ${JSON.stringify(vUnmetFinal.reasons)}`)

  // A forged verdict with a missing requirement result -> FAIL.
  const vForgedMissingRun = "20261018-000000-v-forged-missing"
  await seedVerifiedRun(vForgedMissingRun, ["V1"], { request: "Deliver the missing-result fixture.", stampVictory: false })
  await stampVictoryFor(registeredTools, mockCtx, testDir, vForgedMissingRun)
  const vForgedMissing = JSON.parse(readFileSync(vVictoryFile(vForgedMissingRun), "utf8"))
  vForgedMissing.requirements = []
  writeFileSync(vVictoryFile(vForgedMissingRun), JSON.stringify(vForgedMissing, null, 2) + "\n")
  const vForgedMissingFinal = await registeredTools.final_verify.execute({ sessionId: vForgedMissingRun })
  assert.strictEqual(vForgedMissingFinal.status, "FAIL", "a missing requirement result must FAIL final_verify")
  assert(vForgedMissingFinal.reasons.some((r) => r.includes("missing from the audit result")), `the reason must name the missing result: ${JSON.stringify(vForgedMissingFinal.reasons)}`)

  // Stale requestHash -> FAIL.
  const vStaleRun = "20261018-000000-v-stale"
  await seedVerifiedRun(vStaleRun, ["V1"], { request: "Deliver the stale fixture.", stampVictory: false })
  await stampVictoryFor(registeredTools, mockCtx, testDir, vStaleRun)
  appendFileSync(runFile(testDir, vStaleRun, "ORIGINAL_REQUEST.md"), "\n- tampered after audit\n")
  const vStaleFinal = await registeredTools.final_verify.execute({ sessionId: vStaleRun })
  assert.strictEqual(vStaleFinal.status, "FAIL", "a stale request hash must FAIL final_verify")
  assert(vStaleFinal.reasons.some((r) => r.includes("requestHash does not match")), `the reason must name the stale hash: ${JSON.stringify(vStaleFinal.reasons)}`)

  // Forged auditor label -> FAIL.
  const vForgedAuditorRun = "20261018-000000-v-forged-auditor"
  await seedVerifiedRun(vForgedAuditorRun, ["V1"], { request: "Deliver the forged-auditor fixture.", stampVictory: false })
  await stampVictoryFor(registeredTools, mockCtx, testDir, vForgedAuditorRun)
  const vForgedAuditor = JSON.parse(readFileSync(vVictoryFile(vForgedAuditorRun), "utf8"))
  vForgedAuditor.auditor = "team/verifier"
  writeFileSync(vVictoryFile(vForgedAuditorRun), JSON.stringify(vForgedAuditor, null, 2) + "\n")
  const vForgedAuditorFinal = await registeredTools.final_verify.execute({ sessionId: vForgedAuditorRun })
  assert.strictEqual(vForgedAuditorFinal.status, "FAIL", "a forged auditor label must FAIL final_verify")
  assert(vForgedAuditorFinal.reasons.some((r) => r.includes("auditor must be team/victory-auditor")), `the reason must name the forged label: ${JSON.stringify(vForgedAuditorFinal.reasons)}`)

  // Explicit plan skip is recorded and completes as SKIPPED (explicit).
  const vSkipRun = "20261018-000000-v-skip"
  await seedVerifiedRun(vSkipRun, ["V1"], { request: "Deliver the explicit-skip fixture.", victoryAudit: "skip", stampVictory: false })
  assert.strictEqual(JSON.parse(readFileSync(vPlanFile(vSkipRun), "utf8")).victoryAudit, "skip")
  assert.strictEqual(JSON.parse(readFileSync(join(vRunDir(vSkipRun), "state.json"), "utf8")).victoryAudit, "skip")
  const vSkipFinal = await registeredTools.final_verify.execute({ sessionId: vSkipRun })
  assert.strictEqual(vSkipFinal.status, "PASS", `an explicit skip must complete: ${vSkipFinal.content}`)
  assert.strictEqual(vSkipFinal.victory, "SKIPPED (explicit)")
  const vSkipJson = JSON.parse(readFileSync(finalFileOf(vSkipRun), "utf8"))
  assert.strictEqual(vSkipJson.victory, "SKIPPED (explicit)")
  const vSkipGate = await registeredTools.next.execute({ sessionId: vSkipRun })
  assert.strictEqual(vSkipGate.status, "ALL_PASSED")

  console.log("✓ requirements baseline, trusted victory-auditor identity, write-once verdict, and completion gate verified")

  // ==========================================
  // Part 1c-ter-strict: opt-in strict verification wave
  // ==========================================
  console.log("Testing opt-in strict verification wave...")

  const strictRunDir = (runId) => join(testDir, ".opencode", "teamwork", runId)
  const strictPlanFile = (runId) => join(strictRunDir(runId), "plan.dag.json")
  const strictStateFile = (runId) => join(strictRunDir(runId), "state.json")
  const strictWaveFile = (runId, kind, taskId) => join(strictRunDir(runId), "verify", `${kind}-${taskId}.json`)
  const strictGateFile = (runId) => join(strictRunDir(runId), "GATE_STATUS.md")
  const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")
  const withAgent = async (agent, fn) => {
    const previous = mockCtx.session.get
    mockCtx.session.get = async () => ({ agent })
    try {
      return await fn()
    } finally {
      mockCtx.session.get = previous
    }
  }
  const recordWave = async (runId, taskId, kind, verdict, agent, { sessionID = `ses_${kind}_wave`, notes, evidence } = {}) =>
    withAgent(agent, () =>
      registeredTools.wave_record.execute(
        {
          sessionId: runId,
          taskId,
          kind,
          verdict,
          ...(notes !== undefined ? { notes } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        },
        { sessionID },
      ),
    )

  // Standard is the default and is persisted in both artifacts.
  const strictDefaultRun = "20261018-000000-sv-default"
  const strictDefaultPlan = await registeredTools.plan.execute({
    sessionId: strictDefaultRun,
    topology: "iterative-coding",
    skipInterview: true,
    tasks: [{ id: "S1" }],
  })
  assert(strictDefaultPlan.content.startsWith("Planned"), `default plan must succeed: ${strictDefaultPlan.content}`)
  assert.strictEqual(JSON.parse(readFileSync(strictPlanFile(strictDefaultRun), "utf8")).verification, "standard")
  assert.strictEqual(JSON.parse(readFileSync(strictStateFile(strictDefaultRun), "utf8")).verification, "standard")
  assert(strictDefaultPlan.content.includes("Verification: standard"), "the plan result must report the default mode")

  // Invalid modes are refused before any write.
  const strictBadRun = "20261018-000000-sv-bad"
  const strictBad = await registeredTools.plan.execute({
    sessionId: strictBadRun,
    topology: "iterative-coding",
    skipInterview: true,
    verification: "paranoid",
    tasks: [{ id: "S1" }],
  })
  assert(strictBad.content.startsWith("refused:"), `an invalid verification mode must be refused: ${strictBad.content}`)
  assert(!existsSync(strictRunDir(strictBadRun)), "an invalid verification mode must create no run dir")

  // Strict persists in plan.dag.json and state.json, and a matching re-plan keeps it.
  const strictPlanRun = "20261018-000000-sv-plan"
  const strictPlan = await registeredTools.plan.execute({
    sessionId: strictPlanRun,
    topology: "iterative-coding",
    skipInterview: true,
    verification: "strict",
    tasks: [{ id: "S1" }],
  })
  assert(strictPlan.content.startsWith("Planned"), `strict plan must succeed: ${strictPlan.content}`)
  assert.strictEqual(JSON.parse(readFileSync(strictPlanFile(strictPlanRun), "utf8")).verification, "strict")
  assert.strictEqual(JSON.parse(readFileSync(strictStateFile(strictPlanRun), "utf8")).verification, "strict")
  assert(strictPlan.content.includes("Verification: strict"), "the plan result must report strict")
  assert(strictPlan.content.includes("falsifier"), "the strict plan result must name the wave")
  const strictReplan = await registeredTools.plan.execute({
    sessionId: strictPlanRun,
    topology: "iterative-coding",
    skipInterview: true,
    verification: "strict",
    tasks: [{ id: "S1" }],
  })
  assert(strictReplan.content.startsWith("Planned"), `a matching re-plan must be accepted: ${strictReplan.content}`)
  const strictReplanOmitted = await registeredTools.plan.execute({
    sessionId: strictPlanRun,
    topology: "iterative-coding",
    skipInterview: true,
    tasks: [{ id: "S1" }],
  })
  assert(strictReplanOmitted.content.startsWith("Planned"), `omitting verification on re-plan must keep the mode: ${strictReplanOmitted.content}`)
  assert.strictEqual(JSON.parse(readFileSync(strictPlanFile(strictPlanRun), "utf8")).verification, "strict")
  const strictModeChange = await registeredTools.plan.execute({
    sessionId: strictPlanRun,
    topology: "iterative-coding",
    skipInterview: true,
    verification: "standard",
    tasks: [{ id: "S1" }],
  })
  assert(strictModeChange.content.startsWith("refused:"), `a re-plan must not change strict to standard: ${strictModeChange.content}`)
  assert.strictEqual(JSON.parse(readFileSync(strictPlanFile(strictPlanRun), "utf8")).verification, "strict")
  assert.strictEqual(JSON.parse(readFileSync(strictStateFile(strictPlanRun), "utf8")).verification, "strict")

  // A standard plan cannot be upgraded to strict by a re-plan either.
  const strictUpgrade = await registeredTools.plan.execute({
    sessionId: strictDefaultRun,
    topology: "iterative-coding",
    skipInterview: true,
    verification: "strict",
    tasks: [{ id: "S1" }],
  })
  assert(strictUpgrade.content.startsWith("refused:"), `a re-plan must not change standard to strict: ${strictUpgrade.content}`)
  assert.strictEqual(JSON.parse(readFileSync(strictPlanFile(strictDefaultRun), "utf8")).verification, "standard")

  // Wave authorization, validation, schema, atomic write, and write-once.
  const strictWaveRun = "20261018-000000-sv-wave"
  await seedVerifiedRun(strictWaveRun, ["W1", "W2"], {
    request: "Exercise the strict wave tool.",
    victoryAudit: "skip",
    verification: "strict",
    stampVictory: false,
  })
  const strictWrongChallenge = await recordWave(strictWaveRun, "W1", "challenge", "PASS", "team/verifier")
  assert(strictWrongChallenge.content.startsWith("refused:"), `team/verifier must not record a challenge: ${strictWrongChallenge.content}`)
  assert(!existsSync(strictWaveFile(strictWaveRun, "challenge", "W1")), "a refused caller must write no challenge")
  const strictUnknownCaller = await registeredTools.wave_record.execute(
    { sessionId: strictWaveRun, taskId: "W1", kind: "challenge", verdict: "PASS" },
    { sessionID: "ses_unknown_wave" },
  )
  assert(strictUnknownCaller.content.startsWith("refused:"), `an unknown session agent must be refused: ${strictUnknownCaller.content}`)
  const strictWrongAudit = await recordWave(strictWaveRun, "W2", "audit", "CLEAN", "team/falsifier")
  assert(strictWrongAudit.content.startsWith("refused:"), `team/falsifier must not record an audit: ${strictWrongAudit.content}`)
  assert(!existsSync(strictWaveFile(strictWaveRun, "audit", "W2")), "a refused caller must write no audit")

  const strictChallenge = await recordWave(strictWaveRun, "W1", "challenge", "PASS", "team/falsifier", {
    notes: "  Tried\tempty input, overflow, and TOCTOU.  ",
    evidence: "verify/report-W1.json + src/core.ts:42",
  })
  assert.strictEqual(strictChallenge.verdict?.verdict, "PASS", `a trusted falsifier must record PASS: ${strictChallenge.content}`)
  const strictChallengeJson = JSON.parse(readFileSync(strictWaveFile(strictWaveRun, "challenge", "W1"), "utf8"))
  assert.deepStrictEqual(
    {
      version: strictChallengeJson.version,
      sessionId: strictChallengeJson.sessionId,
      taskId: strictChallengeJson.taskId,
      kind: strictChallengeJson.kind,
      verdict: strictChallengeJson.verdict,
      agent: strictChallengeJson.agent,
      agentSessionId: strictChallengeJson.agentSessionId,
    },
    {
      version: 1,
      sessionId: strictWaveRun,
      taskId: "W1",
      kind: "challenge",
      verdict: "PASS",
      agent: "team/falsifier",
      agentSessionId: "ses_challenge_wave",
    },
  )
  assert.strictEqual(strictChallengeJson.notes, "Tried empty input, overflow, and TOCTOU.", "notes must be sanitized and trimmed")
  assert.strictEqual(strictChallengeJson.evidence, "verify/report-W1.json + src/core.ts:42")
  assert.strictEqual(
    strictChallengeJson.reportHash,
    sha256(readFileSync(reportFileOf(strictWaveRun, "W1"), "utf8")),
    "the challenge must bind to the exact verifier report bytes",
  )
  assert(/^\d{4}-\d{2}-\d{2}T/.test(strictChallengeJson.generatedAt), "generatedAt must be recorded")
  const strictChallengeAgain = await recordWave(strictWaveRun, "W1", "challenge", "PASS", "team/falsifier")
  assert(/write-once/.test(strictChallengeAgain.content), `a recorded challenge must be write-once: ${strictChallengeAgain.content}`)

  const strictMissingTask = await recordWave(strictWaveRun, "NOPE", "challenge", "PASS", "team/falsifier")
  assert(strictMissingTask.content.startsWith("refused:"), `a missing task must be refused: ${strictMissingTask.content}`)
  const strictBadVerdict = await recordWave(strictWaveRun, "W2", "challenge", "CLEAN", "team/falsifier")
  assert(strictBadVerdict.content.startsWith("refused:"), `a challenge with the wrong verdict must be refused: ${strictBadVerdict.content}`)
  assert(!existsSync(strictWaveFile(strictWaveRun, "challenge", "W2")), "a bad verdict must write no file")
  const strictBadAuditVerdict = await recordWave(strictWaveRun, "W2", "audit", "PASS", "team/security-auditor")
  assert(strictBadAuditVerdict.content.startsWith("refused:"), `an audit with the wrong verdict must be refused: ${strictBadAuditVerdict.content}`)
  assert(!existsSync(strictWaveFile(strictWaveRun, "audit", "W2")), "a bad audit verdict must write no file")

  const strictWaveEvents = readEvents(testDir, strictWaveRun).filter((e) => e.event === "verification_wave")
  assert.strictEqual(strictWaveEvents.length, 1, "only successful wave records append an event")
  assert.strictEqual(strictWaveEvents[0].taskId, "W1")
  assert.strictEqual(strictWaveEvents[0].agent, "team/falsifier")
  assert.strictEqual(strictWaveEvents[0].to, "PASS")
  assert.strictEqual(strictWaveEvents[0].agentSource, "session")

  // A missing verifier report is refused: the wave supplements the review.
  const strictNoReportRun = "20261018-000000-sv-noreport"
  await seedVerifiedRun(strictNoReportRun, ["N1"], { victoryAudit: "skip", verification: "strict", stampVictory: false })
  rmSync(runFile(testDir, strictNoReportRun, "verify/report-N1.json"))
  const strictNoReport = await recordWave(strictNoReportRun, "N1", "challenge", "PASS", "team/falsifier")
  assert(/report-N1\.json is missing/.test(strictNoReport.content), `a missing verifier report must be refused: ${strictNoReport.content}`)
  assert(!existsSync(strictWaveFile(strictNoReportRun, "challenge", "N1")), "no verdict may be written without a report")

  console.log("✓ strict mode persists, re-plans are locked, and wave verdicts are authorized, validated, and write-once")

  // Strict completion gate: NEEDS_STRICT_WAVE, PASS with GATE_STATUS.md, and FAIL.
  const strictHappyRun = "20261018-000000-sv-happy"
  await seedVerifiedRun(strictHappyRun, ["H1"], {
    request: "Deliver the strict happy-path fixture.",
    victoryAudit: "skip",
    verification: "strict",
    stampVictory: false,
  })
  const strictNextMissing = await registeredTools.next.execute({ sessionId: strictHappyRun })
  assert.strictEqual(
    strictNextMissing.status,
    "NEEDS_STRICT_WAVE",
    `next must stop before the strict wave: ${strictNextMissing.content}`,
  )
  assert.notStrictEqual(strictNextMissing.status, "ALL_PASSED")
  assert.deepStrictEqual(
    strictNextMissing.missing,
    [
      { taskId: "H1", kind: "challenge" },
      { taskId: "H1", kind: "audit" },
    ],
    "NEEDS_STRICT_WAVE must list the missing task/kind pairs",
  )
  assert(strictNextMissing.content.includes("H1:challenge") && strictNextMissing.content.includes("H1:audit"))

  await recordWave(strictHappyRun, "H1", "challenge", "PASS", "team/falsifier", {
    notes: "No fatal or serious flaw found.",
    evidence: "verify/report-H1.json",
  })
  const strictNextHalf = await registeredTools.next.execute({ sessionId: strictHappyRun })
  assert.strictEqual(strictNextHalf.status, "NEEDS_STRICT_WAVE")
  assert.deepStrictEqual(strictNextHalf.missing, [{ taskId: "H1", kind: "audit" }], "only the audit may remain missing")
  await recordWave(strictHappyRun, "H1", "audit", "CLEAN", "team/security-auditor", {
    notes: "No Critical/High findings.",
    evidence: "npm test tail",
  })
  const strictNextReady = await registeredTools.next.execute({ sessionId: strictHappyRun })
  assert.strictEqual(
    strictNextReady.status,
    "READY_FOR_FINAL_VERIFICATION",
    `the completed wave must unlock final verification: ${strictNextReady.content}`,
  )
  assert(!existsSync(strictGateFile(strictHappyRun)), "GATE_STATUS.md is written by final_verify, not next")
  const strictHappyFinal = await registeredTools.final_verify.execute({ sessionId: strictHappyRun })
  assert.strictEqual(strictHappyFinal.status, "PASS", `complete strict evidence must PASS: ${strictHappyFinal.content}`)
  assert.strictEqual(strictHappyFinal.strictGate, "PASS")
  assert(existsSync(strictGateFile(strictHappyRun)), "strict final_verify must write GATE_STATUS.md")
  const strictGateText = readFileSync(strictGateFile(strictHappyRun), "utf8")
  assert(/^\| Agent \| Role \| Verdict \| Source \|$/m.test(strictGateText), "GATE_STATUS.md must carry the exact table header")
  assert(strictGateText.includes("| team/worker | worker | verified_pass | state.json#tasks.H1 |"))
  assert(strictGateText.includes("| team/verifier | verifier | PASS | verify/report-H1.json |"))
  assert(strictGateText.includes("| team/falsifier | challenger | PASS | verify/challenge-H1.json |"))
  assert(strictGateText.includes("| team/security-auditor | auditor | CLEAN | verify/audit-H1.json |"))
  assert(strictGateText.includes("Gate Result: **PASS**"), `GATE_STATUS.md must state the gate result: ${strictGateText}`)
  const strictHappyFinalJson = JSON.parse(readFileSync(finalFileOf(strictHappyRun), "utf8"))
  assert.strictEqual(strictHappyFinalJson.status, "PASS")
  assert.strictEqual(strictHappyFinalJson.evidence.strict.status, "PASS")
  assert.strictEqual(strictHappyFinalJson.evidence.strict.tasks[0].challenge.status, "PASS")
  assert.strictEqual(strictHappyFinalJson.evidence.strict.tasks[0].audit.status, "CLEAN")
  const strictHappyNext = await registeredTools.next.execute({ sessionId: strictHappyRun })
  assert.strictEqual(strictHappyNext.status, "ALL_PASSED", `the strict run must complete: ${strictHappyNext.content}`)

  // Report binding: a reworked and re-verified task invalidates the earlier wave.
  const strictReworkRun = "20261018-000000-sv-rework"
  await seedVerifiedRun(strictReworkRun, ["RH1"], {
    request: "Deliver the strict rework fixture.",
    victoryAudit: "skip",
    verification: "strict",
    stampVictory: false,
  })
  const reworkChallenge = await recordWave(strictReworkRun, "RH1", "challenge", "PASS", "team/falsifier")
  const reworkAudit = await recordWave(strictReworkRun, "RH1", "audit", "CLEAN", "team/security-auditor")
  const originalReportText = readFileSync(reportFileOf(strictReworkRun, "RH1"), "utf8")
  assert.strictEqual(reworkChallenge.verdict?.reportHash, sha256(originalReportText))
  assert.strictEqual(reworkAudit.verdict?.reportHash, sha256(originalReportText))
  const reworkFirstFinal = await registeredTools.final_verify.execute({ sessionId: strictReworkRun })
  assert.strictEqual(reworkFirstFinal.status, "PASS", `the original report must pass: ${reworkFirstFinal.content}`)

  const reworkedReportText =
    JSON.stringify({
      taskId: "RH1",
      status: "PASS",
      checks: [{ name: "reworked behavior", type: "programmatic", passed: true }],
      timestamp: "2026-11-22T00:00:00.000Z",
    }) + "\n"
  assert.notStrictEqual(reworkedReportText, originalReportText, "the fixture must actually change the report bytes")
  writeFileSync(reportFileOf(strictReworkRun, "RH1"), reworkedReportText)
  const reworkStaleFinal = await registeredTools.final_verify.execute({ sessionId: strictReworkRun })
  assert.strictEqual(reworkStaleFinal.status, "FAIL", `a changed report must invalidate the wave: ${reworkStaleFinal.content}`)
  assert(
    reworkStaleFinal.reasons.includes("strict challenge for RH1 is stale (report changed since it was recorded)"),
    `the stale challenge must be named: ${JSON.stringify(reworkStaleFinal.reasons)}`,
  )
  assert(
    reworkStaleFinal.reasons.includes("strict audit for RH1 is stale (report changed since it was recorded)"),
    `the stale audit must be named: ${JSON.stringify(reworkStaleFinal.reasons)}`,
  )
  const reworkGateText = readFileSync(strictGateFile(strictReworkRun), "utf8")
  assert(reworkGateText.includes("| team/falsifier | challenger | FAIL | verify/challenge-RH1.json |"), `a stale challenge must render FAIL: ${reworkGateText}`)
  assert(reworkGateText.includes("| team/security-auditor | auditor | FAIL | verify/audit-RH1.json |"), `a stale audit must render FAIL: ${reworkGateText}`)

  const reworkChallengeAgain = await recordWave(strictReworkRun, "RH1", "challenge", "PASS", "team/falsifier", {
    notes: "Re-challenged the reworked report.",
  })
  assert.strictEqual(reworkChallengeAgain.verdict?.verdict, "PASS", `a changed report must allow a new challenge: ${reworkChallengeAgain.content}`)
  assert.strictEqual(reworkChallengeAgain.verdict?.reportHash, sha256(reworkedReportText), "the new challenge must bind to the new report")
  const reworkAuditAgain = await recordWave(strictReworkRun, "RH1", "audit", "CLEAN", "team/security-auditor")
  assert.strictEqual(reworkAuditAgain.verdict?.reportHash, sha256(reworkedReportText), "the new audit must bind to the new report")
  const reworkSameHash = await recordWave(strictReworkRun, "RH1", "challenge", "PASS", "team/falsifier")
  assert(/write-once/.test(reworkSameHash.content), `re-recording the same report must be refused: ${reworkSameHash.content}`)
  const reworkSecondFinal = await registeredTools.final_verify.execute({ sessionId: strictReworkRun })
  assert.strictEqual(reworkSecondFinal.status, "PASS", `the re-recorded wave must pass: ${reworkSecondFinal.content}`)
  const reworkFinalJson = JSON.parse(readFileSync(finalFileOf(strictReworkRun), "utf8"))
  assert.strictEqual(reworkFinalJson.evidence.strict.tasks[0].challenge.reportHash, sha256(reworkedReportText))
  assert.strictEqual(reworkFinalJson.evidence.strict.tasks[0].audit.reportHash, sha256(reworkedReportText))

  console.log("✓ strict wave is report-hash bound: reworked reports make old verdicts stale, and only a new-report re-record can pass")

  const seedStrictGateRun = async (runId, taskId) => {
    await seedVerifiedRun(runId, [taskId], {
      request: `Strict gate fixture ${runId}.`,
      victoryAudit: "skip",
      verification: "strict",
      stampVictory: false,
    })
  }
  const writeRawWave = (runId, taskId, kind, verdict, agent) => {
    const file = strictWaveFile(runId, kind, taskId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessionId: runId,
        taskId,
        kind,
        verdict,
        agent,
        agentSessionId: `ses_${kind}_forged`,
        notes: "",
        evidence: "",
        generatedAt: new Date().toISOString(),
      }) + "\n",
    )
  }

  // Missing challenge -> FAIL with a named reason and a FAIL gate table.
  const strictNoChallengeRun = "20261018-000000-sv-nochallenge"
  await seedStrictGateRun(strictNoChallengeRun, "C1")
  await recordWave(strictNoChallengeRun, "C1", "audit", "CLEAN", "team/security-auditor")
  const strictNoChallenge = await registeredTools.final_verify.execute({ sessionId: strictNoChallengeRun })
  assert.strictEqual(strictNoChallenge.status, "FAIL", `a missing challenge must FAIL: ${strictNoChallenge.content}`)
  assert(
    strictNoChallenge.reasons.some((r) => r.includes("strict challenge C1") && r.includes("missing")),
    `the reason must name the missing challenge: ${JSON.stringify(strictNoChallenge.reasons)}`,
  )
  assert(readFileSync(strictGateFile(strictNoChallengeRun), "utf8").includes("Gate Result: **FAIL**"), "a strict failure must write a FAIL gate table")

  // Missing audit -> FAIL with a named reason.
  const strictNoAuditRun = "20261018-000000-sv-noaudit"
  await seedStrictGateRun(strictNoAuditRun, "A1")
  await recordWave(strictNoAuditRun, "A1", "challenge", "PASS", "team/falsifier")
  const strictNoAudit = await registeredTools.final_verify.execute({ sessionId: strictNoAuditRun })
  assert.strictEqual(strictNoAudit.status, "FAIL", `a missing audit must FAIL: ${strictNoAudit.content}`)
  assert(
    strictNoAudit.reasons.some((r) => r.includes("strict audit A1") && r.includes("missing")),
    `the reason must name the missing audit: ${JSON.stringify(strictNoAudit.reasons)}`,
  )

  // A present but non-PASS challenge fails.
  const strictChallengeFailRun = "20261018-000000-sv-challenge-fail"
  await seedStrictGateRun(strictChallengeFailRun, "CF")
  await recordWave(strictChallengeFailRun, "CF", "audit", "CLEAN", "team/security-auditor")
  writeRawWave(strictChallengeFailRun, "CF", "challenge", "FAIL", "team/falsifier")
  const strictChallengeFail = await registeredTools.final_verify.execute({ sessionId: strictChallengeFailRun })
  assert.strictEqual(strictChallengeFail.status, "FAIL", "a FAIL challenge must FAIL final_verify")
  assert(
    strictChallengeFail.reasons.some((r) => r.includes("strict challenge CF") && r.includes("verdict FAIL") && r.includes("expected PASS")),
    `the reason must name the challenge verdict: ${JSON.stringify(strictChallengeFail.reasons)}`,
  )

  // A present but non-CLEAN audit fails.
  const strictAuditBadRun = "20261018-000000-sv-audit-bad"
  await seedStrictGateRun(strictAuditBadRun, "AB")
  await recordWave(strictAuditBadRun, "AB", "challenge", "PASS", "team/falsifier")
  writeRawWave(strictAuditBadRun, "AB", "audit", "INTEGRITY VIOLATION", "team/security-auditor")
  const strictAuditBad = await registeredTools.final_verify.execute({ sessionId: strictAuditBadRun })
  assert.strictEqual(strictAuditBad.status, "FAIL", "a non-CLEAN audit must FAIL final_verify")
  assert(
    strictAuditBad.reasons.some((r) => r.includes("strict audit AB") && r.includes("INTEGRITY VIOLATION") && r.includes("expected CLEAN")),
    `the reason must name the audit verdict: ${JSON.stringify(strictAuditBad.reasons)}`,
  )

  // Standard mode ignores stray wave files entirely (today's behaviour).
  const strictStdRun = "20261018-000000-sv-standard"
  await seedVerifiedRun(strictStdRun, ["STD"], {
    request: "Deliver the standard fixture.",
    victoryAudit: "skip",
    stampVictory: false,
  })
  assert.strictEqual(JSON.parse(readFileSync(strictPlanFile(strictStdRun), "utf8")).verification, "standard")
  writeRawWave(strictStdRun, "STD", "challenge", "FAIL", "team/verifier")
  writeRawWave(strictStdRun, "STD", "audit", "INTEGRITY VIOLATION", "team/verifier")
  const strictStdFinal = await registeredTools.final_verify.execute({ sessionId: strictStdRun })
  assert.strictEqual(strictStdFinal.status, "PASS", `standard mode must ignore stray wave files: ${strictStdFinal.content}`)
  assert(!existsSync(strictGateFile(strictStdRun)), "standard mode must not write GATE_STATUS.md")
  const strictStdJson = JSON.parse(readFileSync(finalFileOf(strictStdRun), "utf8"))
  assert.strictEqual(strictStdJson.evidence.strict, undefined, "standard mode must not add strict evidence")

  console.log("✓ strict gate requires per-task challenge PASS + audit CLEAN, names gaps, and writes GATE_STATUS.md; standard is unchanged")

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

    const gitSessionId = `20261018-000000-${randomBytes(4).toString("hex")}`
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
// Part 1d2: security regressions (CodeQL #20, #21, #11–#14)
// ==========================================
{
  console.log("Testing security regressions (atomic touch, single-fd event seq, validated session ids)...")
  const secDir = mkdtempSync(join(tmpdir(), "teamwork-security-test-"))
  const TOOLS_URL = new URL("../plugins/opencode-teamwork/tools.ts", import.meta.url).href
  const runFileSec = (root, runId, name) => join(root, ".opencode", "teamwork", runId, name)
  try {
    // --- CodeQL #20: touch() is ONE O_EXCL create; no check-then-use window.
    {
      const nested = join(secDir, "touch", "nested", "pitfalls.md")
      touch(nested, "# Pitfalls\n")
      assert.strictEqual(readFileSync(nested, "utf8"), "# Pitfalls\n", "touch must create a missing file (and its dirs)")
      touch(nested, "# REPLACED\n")
      assert.strictEqual(readFileSync(nested, "utf8"), "# Pitfalls\n", "touch must never overwrite an existing file")
      console.log("✓ touch creates a missing file and never overwrites an existing one")
    }
    {
      const target = join(secDir, "touch-symlink", "target.md")
      const link = join(secDir, "touch-symlink", "pitfalls.md")
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, "TARGET\n")
      symlinkSync(target, link)
      assert.doesNotThrow(() => touch(link, "ATTACK\n"), "touch must not throw on a pre-planted symlink")
      assert.strictEqual(readFileSync(target, "utf8"), "TARGET\n", "touch must never write through a symlink")
      assert(lstatSync(link).isSymbolicLink(), "the pre-planted symlink must be left in place")
      const danglingLink = join(secDir, "touch-symlink", "dangling.md")
      const danglingTarget = join(secDir, "touch-symlink", "never-created.md")
      symlinkSync(danglingTarget, danglingLink)
      touch(danglingLink, "ATTACK\n")
      assert(!existsSync(danglingTarget), "touch must not create the target of a dangling symlink")
      console.log("✓ touch ignores a pre-planted symlink and leaves the target untouched")
    }

    // --- CodeQL #21: nextEventSeq uses ONE fd for tail + fallback count.
    {
      const missing = join(secDir, "seq-missing", "events.jsonl")
      assert.strictEqual(nextEventSeq(missing), 1, "a missing events.jsonl is the first event")
      const target = join(secDir, "seq-symlink", "target.jsonl")
      const link = join(secDir, "seq-symlink", "events.jsonl")
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '{"seq":41}\n')
      symlinkSync(target, link)
      assert.strictEqual(nextEventSeq(link), 1, "a symlinked events.jsonl must not be followed (first event)")
      console.log("✓ nextEventSeq returns 1 for a missing file or symlink")
    }
    {
      const file = join(secDir, "seq-tail", "events.jsonl")
      mkdirSync(dirname(file), { recursive: true })
      const lines = []
      for (let i = 1; i <= 40; i++) lines.push(JSON.stringify({ seq: i, event: "task_transition" }))
      writeFileSync(file, lines.join("\n") + "\n")
      assert.strictEqual(nextEventSeq(file), 41, "the 8 KiB tail fast path must read the last seq")
      console.log("✓ nextEventSeq keeps the 8 KiB tail fast path (last line seq)")
    }
    {
      const file = join(secDir, "seq-legacy", "events.jsonl")
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '{"event":"run_created"}\n{"event":"task_transition"}\n\n')
      assert.strictEqual(nextEventSeq(file), 3, "a legacy tail must count non-empty lines through the same fd")
      console.log("✓ nextEventSeq counts a legacy tail through the same fd")
    }
    {
      const file = join(secDir, "seq-corrupt", "events.jsonl")
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '{"seq":10}\nnot json\n')
      assert.strictEqual(nextEventSeq(file), 3, "a corrupt tail must fall back to counting non-empty lines")

      const big = join(secDir, "seq-large", "events.jsonl")
      mkdirSync(dirname(big), { recursive: true })
      const pad = "x".repeat(48)
      const bigLines = []
      for (let i = 1; i <= 20000; i++) bigLines.push(JSON.stringify({ event: "task_transition", i, pad }))
      bigLines.push(JSON.stringify({ seq: 7777, event: "task_transition" }))
      writeFileSync(big, bigLines.join("\n") + "\n")
      assert(statSync(big).size > 8192, "the large fixture must exceed the 8 KiB tail")
      assert.strictEqual(nextEventSeq(big), 7778, "a large file with a seq last line must continue from it")

      const bigLegacy = join(secDir, "seq-large-legacy", "events.jsonl")
      mkdirSync(dirname(bigLegacy), { recursive: true })
      writeFileSync(bigLegacy, bigLines.slice(0, 20000).join("\n") + "\n")
      assert.strictEqual(nextEventSeq(bigLegacy), 20001, "a large legacy file must be counted in chunks, not from the tail")
      console.log("✓ nextEventSeq counts a corrupt tail and a large file chunked")
    }
    {
      const fifo = join(secDir, "seq-fifo", "events.jsonl")
      mkdirSync(dirname(fifo), { recursive: true })
      // Absolute-path lookup: never resolve a command through PATH (S4036).
      const mkfifo = ["/usr/bin/mkfifo", "/bin/mkfifo", "/usr/local/bin/mkfifo"].find((p) => existsSync(p))
      const made = mkfifo ? spawnSync(mkfifo, [fifo], { stdio: "ignore" }) : undefined
      if (!made || made.status !== 0) {
        console.log("⊘ skipped FIFO regression: mkfifo is unavailable")
      } else {
        const script = `import { nextEventSeq } from ${JSON.stringify(TOOLS_URL)}; process.stdout.write(String(nextEventSeq(process.argv[1])))`
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, fifo], {
          encoding: "utf8",
          timeout: 5000,
        })
        assert.strictEqual(child.signal, null, `nextEventSeq must not hang on a FIFO (signal: ${child.signal})`)
        assert.strictEqual(child.stdout, "1", `a FIFO is not a log and must be treated as the first event: ${child.stdout}`)
        console.log("✓ nextEventSeq returns 1 for a FIFO without hanging")
      }
    }

    // --- CodeQL #11–#14: ids read from snapshots.json must pass SESSION_ID
    // before any fetch URL is built; invalid ids are skipped, not encoded.
    {
      const root = mkdtempSync(join(secDir, "sid-"))
      const home = join(secDir, "sid-home")
      const requests = []
      const server = createServer((req, res) => {
        requests.push(req.url)
        res.setHeader("content-type", "application/json")
        if (req.url === "/api/session/ses_root_ok") {
          res.end(
            JSON.stringify({
              data: { id: "ses_root_ok", parentID: null, agent: "sentinel", cost: 1.25, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
            }),
          )
        } else if (req.url === "/api/session?parentID=ses_root_ok") {
          res.end(
            JSON.stringify({
              data: [
                { id: "ses_child_ok", parentID: "ses_root_ok", agent: "team/worker", cost: 0.5, tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
                { id: "../../etc/passwd", parentID: "ses_root_ok", cost: 99, tokens: {} },
                { id: "bad id", parentID: "ses_root_ok", cost: 99, tokens: {} },
              ],
            }),
          )
        } else if (req.url === "/api/session?parentID=ses_child_ok") {
          res.end(JSON.stringify({ data: [] }))
        } else {
          res.writeHead(404)
          res.end("{}")
        }
      })
      await new Promise((r) => server.listen(0, "127.0.0.1", r))
      const savedEnv = {}
      for (const k of ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "LOCALAPPDATA"]) {
        savedEnv[k] = process.env[k]
      }
      try {
        const base = `http://127.0.0.1:${server.address().port}`
        process.env.HOME = home
        process.env.USERPROFILE = home
        process.env.XDG_DATA_HOME = join(home, "data")
        process.env.XDG_STATE_HOME = join(home, "state")
        process.env.LOCALAPPDATA = join(home, "localappdata")
        mkdirSync(join(home, "state", "opencode"), { recursive: true })
        writeFileSync(join(home, "state", "opencode", "service.json"), JSON.stringify({ url: base, password: "test" }))

        const tools = {}
        await registerTeamworkTools(
          {
            tool: { transform: async (cb) => cb({ namespace: () => {}, add: (tool) => (tools[tool.name] = tool) }) },
            session: { get: async () => undefined },
          },
          root,
        )
        const RUN = "20261018-000000-sidval"
        await tools.plan.execute(
          { sessionId: RUN, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "alpha" }] },
          { sessionID: "ses_root_ok" },
        )
        const snapsFile = runFileSec(root, RUN, "snapshots.json")
        const snaps = JSON.parse(readFileSync(snapsFile, "utf8"))
        snaps.rootSessionIds = ["ses_root_ok", "../../etc/passwd", "bad id", "a/b", "-leading", "x".repeat(80)]
        writeFileSync(snapsFile, JSON.stringify(snaps, null, 2))
        const costsFile = runFileSec(root, RUN, "costs.json")
        const costsBefore = JSON.parse(readFileSync(costsFile, "utf8"))
        costsBefore.rootSessionIds = []
        writeFileSync(costsFile, JSON.stringify(costsBefore, null, 2))

        const res = await tools.cost.execute({ sessionId: RUN, taskId: "alpha" }, { sessionID: "ses_root_ok" })
        assert(res.content.includes("opencode service API"), `cost must still aggregate via the service tree: ${res.content}`)
        assert.deepStrictEqual(
          requests,
          ["/api/session/ses_root_ok", "/api/session?parentID=ses_root_ok", "/api/session?parentID=ses_child_ok"],
          `only SESSION_ID-valid ids may reach the API: ${JSON.stringify(requests)}`,
        )
        for (const url of requests) {
          assert(!/passwd|etc|%2F|%2E%2E|bad%20id/i.test(url), `invalid id leaked into a request URL: ${url}`)
        }
        const costs = JSON.parse(readFileSync(costsFile, "utf8"))
        assert.strictEqual(costs.byTask.alpha, 1.75, "valid root + child spend must still bucket to the task")
        assert.strictEqual(costs.spentUsd, 1.75, "aggregation must not be dropped")
        console.log("✓ cost request URLs only ever contain SESSION_ID-valid ids")
      } finally {
        for (const k of Object.keys(savedEnv)) {
          if (savedEnv[k] === undefined) delete process.env[k]
          else process.env[k] = savedEnv[k]
        }
        await new Promise((resolve) => {
          server.close(resolve)
          if (typeof server.closeAllConnections === "function") server.closeAllConnections()
        })
      }
    }
  } finally {
    rmSync(secDir, { recursive: true, force: true })
  }
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
    { id: "team/formalization-reviewer", deny: ["edit", "shell", "subagent", "webfetch"] },
    { id: "team/referee", deny: ["edit", "shell", "subagent", "webfetch"] },
    { id: "team/victory-auditor", deny: ["edit", "subagent", "webfetch"] },
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
  console.log("✓ READ_ONLY_ACTIONS matches the expected deny set for all read-only agents")

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
    await stampVictoryFor(tools, ctx, docRoot, mdRun)
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

    // Image-only PDF with empty PATH (pdftotext unavailable) cleanly returns needs_ingestor
    const savedPath = process.env.PATH
    try {
      process.env.PATH = ""
      const noPdfTextRun = "20261122-000002-nopathpdf"
      const noPdfTextRes = await tools.document_triage.execute({
        sessionId: noPdfTextRun,
        document: { path: "scanned.pdf" },
        skipInterview: true,
      })
      assert.strictEqual(
        noPdfTextRes.extractionStatus,
        "needs_ingestor",
        `Empty PDF without pdftotext on PATH must return needs_ingestor: ${noPdfTextRes.content}`,
      )
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
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

    // Line-0 multiline structured math & Markdown papers + trailing critique instruction
    const line0MathPaperRoute = await tools.route.execute({
      request:
        "\\section{Introduction}\n\\begin{theorem}\n\\forall x \\exists y, P(x,y).\n\\end{theorem}\n" +
        "A".repeat(180) +
        "\n\nPlease critique this paper for soundness.",
    })
    assert.strictEqual(
      line0MathPaperRoute.topology,
      "document-review",
      "Line-0 multiline structured math paper with trailing critique instruction must route to document-review",
    )
    assert.strictEqual(line0MathPaperRoute.documentDetected, true)

    const line0MdPaperRoute = await tools.route.execute({
      request:
        "# Introduction\nThis draft specifies the consensus protocol.\n\n## Soundness\n" +
        "B".repeat(200) +
        "\n\nPlease critique this paper for soundness.",
    })
    assert.strictEqual(line0MdPaperRoute.topology, "document-review")

    // LaTeX \documentclass preamble + \end{document} and YAML frontmatter + trailing critique
    const latexPreambleRoute = await tools.route.execute({
      request:
        "\\documentclass{article}\n\\begin{document}\n\\begin{theorem}\n\\forall x \\exists y, P(x,y).\n\\end{theorem}\n" +
        "A".repeat(200) +
        "\n\\end{document}\n\nPlease critique this paper for soundness.",
    })
    assert.strictEqual(
      latexPreambleRoute.topology,
      "document-review",
      "LaTeX \\documentclass preamble + \\end{document} with trailing critique must route to document-review",
    )

    const yamlFrontmatterRoute = await tools.route.execute({
      request:
        "---\ntitle: Spec\n---\n\n# Introduction\n" +
        "B".repeat(240) +
        "\n\nPlease critique this spec.",
    })
    assert.strictEqual(
      yamlFrontmatterRoute.topology,
      "document-review",
      "YAML frontmatter Markdown doc with trailing critique must route to document-review",
    )

    // Topic-mention & masked-path positive document-review cases (Challenger 2 / Reviewer 2 / Challenger 3)
    mkdirSync(join(docRoot, "docs"), { recursive: true })
    writeFileSync(join(docRoot, "docs", "spec.md"), "# Spec\nSpecification details.\n")
    writeFileSync(join(docRoot, "docs", "cli.md"), "# CLI\nDebug flags reference.\n")
    writeFileSync(join(docRoot, "docs", "debug-guide.md"), "# Debug Guide\nHow to use debug flags.\n")
    writeFileSync(join(docRoot, "docs", "runbook.md"), "# Runbook\nHow to debug, diagnose, and troubleshoot crashes.\n")
    for (const topicReq of [
      "review this paper for bugs in the proof docs/spec.md",
      "review docs/cli.md covering debug flags",
      "review docs/debug-guide.md",
      "review docs/runbook.md covering how to debug, diagnose, and troubleshoot crashes",
      "review docs/spec.md covering class invariants",
    ]) {
      const topicRes = await tools.route.execute({ request: topicReq })
      assert.strictEqual(
        topicRes.topology,
        "document-review",
        `Topic/path review "${topicReq}" must route to document-review, got ${topicRes.topology}`,
      )
    }

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
    mkdirSync(join(docRoot, "src"), { recursive: true })
    writeFileSync(join(docRoot, "src", "foo.md"), "# Foo\nSome documentation.\n")
    const negCases = [
      ["review this PR", "distributed-coding"],
      ["review PR #42", "distributed-coding"],
      ["code review src/auth.ts", "distributed-coding"],
      ["review my design", "distributed-coding"],
      ["Mentioning paper.pdf", "distributed-coding"],
      ["check README.md and implement the missing flag", "distributed-coding"],
      ["fix the bug in notes.md", "iterative-coding"],
      ["analyze the bug in src/foo.md", "distributed-coding"],
      ["analyze the bugs in src/foo.md", "distributed-coding"],
      ["analyze the errors in src/foo.md", "distributed-coding"],
      ["analyze these regressions in docs/spec.md", "distributed-coding"],
      ["analyze the flaky test failure in src/foo.md", "distributed-coding"],
      ["analyze a memory leak in src/foo.md", "distributed-coding"],
      ["analyze the performance bottleneck in src/foo.md", "distributed-coding"],
      ["investigate the error in src/foo.md", "distributed-coding"],
      ["diagnose the crash in src/foo.md", "distributed-coding"],
      ["debug src/foo.md", "distributed-coding"],
      ["see ./paper.pdf and solve problem 3", "proof"],
      ["prove Theorem 2 from ./math-paper.md", "proof"],
      [
        "\\documentclass{article}\n\\begin{document}\n\\begin{theorem}\n\\forall x \\exists y, P(x,y).\n\\end{theorem}\n" +
          "A".repeat(180) +
          "\n\\end{document}\n\nProve Theorem 1.",
        "proof",
      ],
      [
        "\\section{Introduction}\n\\begin{theorem}\n\\forall x \\exists y, P(x,y).\n\\end{theorem}\n" +
          "A".repeat(180) +
          "\n\nProve that this holds.",
        "proof",
      ],
      [
        "# Introduction\n" + "C".repeat(240) + "\n\n# Conclusion\nWe analyze these results in Section 2.",
        "distributed-coding",
      ],
      [
        "# Introduction\n" +
          "C".repeat(240) +
          "\n\nIn Section 3 we review prior benchmarks and analyze the throughput results.",
        "distributed-coding",
      ],
      [
        "# Introduction\n" +
          "C".repeat(240) +
          "\n\nIn Section 3 we review prior benchmarks and analyze the results. Please see Appendix A for details.",
        "distributed-coding",
      ],
      ["review docs/spec.md and check the bugs in src/foo.md", "distributed-coding"],
      ["review docs/spec.md and fix src/foo.md", "distributed-coding"],
      ["review docs/spec.md and edit src/foo.md", "distributed-coding"],
      ["review docs/spec.md and update src/foo.md", "distributed-coding"],
      ["review docs/spec.md and write tests for src/foo.md", "distributed-coding"],
      ["review docs/runbook.md covering how to debug, and debug src/foo.md", "distributed-coding"],
      [
        "Please review this implementation:\n\n```ts\n" +
          "export function parseHeader(buf: Uint8Array): string {\n" +
          "  return new TextDecoder().decode(buf.subarray(0, 16))\n" +
          "}\n" +
          "export function helper(x: number) { return x * 2 }\n" +
          "```",
        "distributed-coding",
      ],
      [
        "Review this function for bugs:\n\n```ts\n" +
          "export function parseHeader(buf: Uint8Array): string {\n" +
          "  return new TextDecoder().decode(buf.subarray(0, 16))\n" +
          "}\n" +
          "export function helper(x: number) { return x * 2 }\n" +
          "```",
        "distributed-coding",
      ],
      ["review docs/spec.md and write unit tests for src/foo.md", "distributed-coding"],
      ["review docs/spec.md and write integration tests for src/foo.md", "distributed-coding"],
      ["review docs/spec.md and write new tests for src/foo.md", "distributed-coding"],
      [
        "Audit this implementation:\n\n```ts\n" +
          "export function parseHeader(buf: Uint8Array): string {\n" +
          "  return new TextDecoder().decode(buf.subarray(0, 16))\n" +
          "}\n" +
          "export function helper(x: number) { return x * 2 }\n" +
          "```",
        "distributed-coding",
      ],
      [
        "Critique this function:\n\n```ts\n" +
          "export function parseHeader(buf: Uint8Array): string {\n" +
          "  return new TextDecoder().decode(buf.subarray(0, 16))\n" +
          "}\n" +
          "export function helper(x: number) { return x * 2 }\n" +
          "```",
        "distributed-coding",
      ],
      [
        "Evaluate this code:\n\n```ts\n" +
          "export function parseHeader(buf: Uint8Array): string {\n" +
          "  return new TextDecoder().decode(buf.subarray(0, 16))\n" +
          "}\n" +
          "export function helper(x: number) { return x * 2 }\n" +
          "```",
        "distributed-coding",
      ],
      [
        "Assess this snippet:\n\n```ts\n" +
          "export function parseHeader(buf: Uint8Array): string {\n" +
          "  return new TextDecoder().decode(buf.subarray(0, 16))\n" +
          "}\n" +
          "export function helper(x: number) { return x * 2 }\n" +
          "```",
        "distributed-coding",
      ],
      [
        "Review this component:\n\n```tsx\n" +
          "export function UserCard({ name, role }: { name: string; role: string }) {\n" +
          '  return <div className="card"><strong>{name}</strong><span>{role}</span></div>\n' +
          "}\n" +
          "```",
        "distributed-coding",
      ],
      ["review docs/spec.md and modify src/foo.md", "distributed-coding"],
      ["review docs/spec.md and patch src/foo.md", "distributed-coding"],
      ["review docs/spec.md and fix the typo in src/foo.md", "distributed-coding"],
      [
        "review docs/runbook.md covering how to build, test, and debug, and troubleshoot the crash in src/foo.md",
        "distributed-coding",
      ],
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

    // Deleting/omitting document-review/manifest.json on a document-review run must FAIL final_verify
    rmSync(join(docRoot, ".opencode", "teamwork", packRun, "document-review", "manifest.json"))
    const fvMissingManifest = await tools.final_verify.execute({ sessionId: packRun })
    assert.strictEqual(
      fvMissingManifest.status,
      "FAIL",
      "final_verify must FAIL when document-review/manifest.json is missing",
    )
    assert(
      fvMissingManifest.reasons.some((r) => r.includes("document-review/manifest.json missing")),
      `Expected missing manifest reason, got: ${JSON.stringify(fvMissingManifest.reasons)}`,
    )
    const fvMissingManifestJson = JSON.parse(
      readFileSync(join(docRoot, ".opencode", "teamwork", packRun, "verify", "final.json"), "utf8"),
    )
    assert.deepStrictEqual(fvMissingManifestJson.evidence.documentReview, {
      checked: true,
      segmentReportsComplete: false,
      finalReportPresent: false,
    })
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
    assert(!/[\u0085\u2028\u2029]/.test(cleanMap) && !cleanMap.includes("\x1b"), "Control chars must be stripped from DOCUMENT_TEXT_MAP.md")

    await tools.document_record.execute({
      sessionId: cleanRun,
      stage: "final_report",
      summary: "Summary\x1b[31mX\u0085Y\u2028Z",
      content: "Detail\x1b[32mA\u0085B\u2028C",
    })
    const cleanRep = readFileSync(join(docRoot, ".opencode", "teamwork", cleanRun, "DOCUMENT_REVIEW_REPORT.md"), "utf8")
    assert(!/[\u0085\u2028\u2029]/.test(cleanRep) && !cleanRep.includes("\x1b"), "Control chars must be stripped from DOCUMENT_REVIEW_REPORT.md")
    console.log("✓ 9.7 Security (traversal, symlinks, SEGMENT_ID, sanitisation) passed")
  } finally {
    rmSync(docRoot, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
}

// Part 9: Math/Proof tournament (Issue #3)
// ==========================================
{
  console.log("Testing Math/Proof tournament (explicit opt-in, preflight, E2E, cancellation, security)...")
  const testDir9 = mkdtempSync(join(tmpdir(), "teamwork-engine-m3-"))
  try {
    const tools9 = {}
    let evaluateHook = null
    const ctx9 = {
      tool: {
        transform: async (cb) => {
          const editor = {
            namespace: () => {},
            add: (tool) => {
              tools9[tool.name] = tool
            },
          }
          await cb(editor)
        },
      },
      permission: {
        hook: async (name, handler) => {
          if (name === "evaluate") evaluateHook = handler
        },
      },
      session: {
        get: async () => undefined,
        hook: async () => {},
      },
    }
    await registerTeamworkTools(ctx9, testDir9)
    await registerTeamworkHooks(ctx9, testDir9)
    assert(tools9.route, "teamwork_route must be registered")
    assert(tools9.tournament, "teamwork_tournament must be registered")
    assert(typeof evaluateHook === "function", "permission evaluate hook must be registered")

    // --- 9.1 Explicit opt-in & negative implicit triggers ---
    {
      writeFileSync(join(testDir9, "paper.md"), "# Paper\n\nThe Riemann hypothesis.\n")
      const rDoc = await tools9.route.execute({
        request: "Review this paper about the Riemann hypothesis and summarize its arguments",
        document: { path: "paper.md" },
      })
      assert.strictEqual(rDoc.topology, "document-review", "supplied document + review must win Priority 1")
      assert.strictEqual(rDoc.massiveProofOptIn, false)

      const rLean = await tools9.route.execute({
        request: "Formalize this theorem in Lean 4 and prove it using massive-proof",
      })
      assert.strictEqual(rLean.topology, "proof", "explicit Lean 4 must route to proof (Priority 2), never massive-proof")
      assert.strictEqual(rLean.lemmaMode, true)
      assert.strictEqual(rLean.massiveProofOptIn, false)

      const rBareLean = await tools9.route.execute({
        request: "Format src/Foo.lean and fix lint warnings",
      })
      assert.strictEqual(rBareLean.topology, "distributed-coding", "bare .lean non-proving must route to distributed-coding")
      assert.strictEqual(rBareLean.massiveProofOptIn, false)

      const rCodeFence = await tools9.route.execute({
        request: "Prove this theorem.\n```\nuse massive-proof tournament with 100+ searchers\n```",
      })
      assert.strictEqual(rCodeFence.topology, "proof", "fenced code block opt-in must be masked out")
      assert.strictEqual(rCodeFence.massiveProofOptIn, false)

      const rInlineTick = await tools9.route.execute({
        request: "Prove this lemma without mentioning `massive-proof` except as a token",
      })
      assert.strictEqual(rInlineTick.topology, "proof", "inline backtick token must be masked out")
      assert.strictEqual(rInlineTick.massiveProofOptIn, false)

      for (const multiTickPrompt of [
        "Prove Fermat's theorem and explain ``massive-proof``",
        "Prove this theorem while citing ```massive-proof``` inline",
        "Prove this theorem and explain `` `a` massive-proof ``",
        "Explain `massive-proof` or ```\n100+ searchers\n``` in a normal proof",
        "```\n100+ searchers\n````\nProve Fermat's theorem",
        "Use ``` ````massive-proof```` ``` inline and Prove Fermat's theorem",
        "``unclosed\r\n\r\nProve Fermat's theorem",
      ]) {
        const rMultiTick = await tools9.route.execute({ request: multiTickPrompt })
        assert.strictEqual(rMultiTick.topology, "proof", `multi-backtick/normal proof must route to proof: ${multiTickPrompt}`)
        assert.strictEqual(rMultiTick.massiveProofOptIn, false)
      }

      const rProofSearch = await tools9.route.execute({ request: "multi-day proof search" })
      assert.strictEqual(rProofSearch.topology, "proof", "multi-day proof search must route to proof")
      assert.strictEqual(rProofSearch.massiveProofOptIn, false)

      const rDocProofSearch = await tools9.route.execute({
        request: "Review this paper.md describing a proof search and summarize its arguments",
        document: { path: "paper.md" },
      })
      assert.strictEqual(rDocProofSearch.topology, "document-review", "document-review must win Priority 1 over proof search")
      assert.strictEqual(rDocProofSearch.massiveProofOptIn, false)

      for (const nonProofPrompt of [
        "proofread this README.md",
        "make this script foolproof and fix the bug",
        "build a proof of concept web app",
      ]) {
        const rNonProof = await tools9.route.execute({ request: nonProofPrompt })
        assert.notStrictEqual(rNonProof.topology, "proof", `must not false-positive on proof: ${nonProofPrompt}`)
        assert.notStrictEqual(rNonProof.topology, "massive-proof")
        assert.strictEqual(rNonProof.massiveProofOptIn, false)
      }

      for (const negatedProofPrompt of [
        "Prove X without using massive-proof",
        "Prove X without massively parallel proof",
        "Prove X without using a proof tournament",
        "Prove X without running 100+ searchers",
        "Prove X, avoid using massive-proof",
        "Prove X without a large-team proof",
        "Prove this conjecture; do not use a large-team proof",
      ]) {
        const rNegProof = await tools9.route.execute({ request: negatedProofPrompt })
        assert.strictEqual(rNegProof.topology, "proof", `negated opt-in must route to proof: ${negatedProofPrompt}`)
        assert.strictEqual(rNegProof.massiveProofOptIn, false)
      }

      for (const implicitPrompt of [
        "Prove Goldbach's conjecture with unlimited budget",
        "Solve the Riemann hypothesis, hard open problem",
        "Prove this difficult conjecture in a multi-day proof",
        "Prove this theorem; do not use massive-proof or a very large team",
        "Use a very large team to build a web dashboard",
      ]) {
        const rNeg = await tools9.route.execute({ request: implicitPrompt })
        assert.notStrictEqual(rNeg.topology, "massive-proof", `must never implicitly route to massive-proof: ${implicitPrompt}`)
        assert.strictEqual(rNeg.massiveProofOptIn, false)
      }

      const rOptIn = await tools9.route.execute({
        request: "Prove this conjecture using a massive-proof tournament with 100+ searchers",
      })
      assert.strictEqual(rOptIn.topology, "massive-proof")
      assert.strictEqual(rOptIn.massiveProofOptIn, true)

      // Bare canonical topology: "massive-proof" without opt-in/budget/request is refused before mkdirSync
      const sidBareCanonical = "20261018-190000-barecan"
      const resBareCanonical = await tools9.plan.execute({
        sessionId: sidBareCanonical,
        topology: "massive-proof",
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert(resBareCanonical.content.startsWith("refused:"), `bare canonical massive-proof must be refused: ${resBareCanonical.content}`)
      assert.strictEqual(resBareCanonical.refused, "opt_in_required")
      assert(!existsSync(join(testDir9, ".opencode", "teamwork", sidBareCanonical)), "bare canonical refusal must write zero files")

      // teamwork_plan rejects massive-proof without opt-in before mkdirSync
      const sidNoOpt = "20261018-190001-noopt"
      const resNoOpt = await tools9.plan.execute({
        sessionId: sidNoOpt,
        topology: "massive-proof",
        request: "Prove Goldbach's conjecture with unlimited budget",
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert(resNoOpt.content.startsWith("refused:"), `must refuse massive-proof without opt-in: ${resNoOpt.content}`)
      assert(!existsSync(join(testDir9, ".opencode", "teamwork", sidNoOpt)), "refusal must write zero files")

      const sidExplicitFalse = "20261018-190002-optno"
      const resExplicitFalse = await tools9.plan.execute({
        sessionId: sidExplicitFalse,
        topology: "massive-proof",
        massiveProofOptIn: false,
        request: "Prove this theorem with massive-proof tournament",
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert(resExplicitFalse.content.startsWith("refused:"), "massiveProofOptIn: false must override prose")
      assert(!existsSync(join(testDir9, ".opencode", "teamwork", sidExplicitFalse)), "must not create run dir")
    }

    // --- 9.2 Pre-mkdirSync budget, bounds, and AbortSignal refusal ---
    {
      const acPre = new AbortController()
      acPre.abort()
      const sidAbortPre = "20261018-190003-abpre"
      const resAbortPre = await tools9.plan.execute(
        {
          sessionId: sidAbortPre,
          topology: "massive-proof",
          massiveProofOptIn: true,
          skipInterview: true,
          tasks: [{ id: "T1" }],
        },
        { signal: acPre.signal },
      )
      assert.strictEqual(resAbortPre.aborted, true)
      assert(!existsSync(join(testDir9, ".opencode", "teamwork", sidAbortPre)), "aborted plan must not mkdir")

      for (const [label, extra] of [
        ["zero-budget", { budgetUsd: 0 }],
        ["neg-budget", { budgetUsd: -5 }],
        ["low-budget", { budgetUsd: 1 }],
        ["levels-oob", { budgetUsd: 20, tournament: { levels: 5 } }],
        ["width-oob", { budgetUsd: 20, tournament: { branchingFactor: 9 } }],
        ["cands-oob", { budgetUsd: 20, tournament: { maxCandidates: 65 } }],
        ["iter-oob", { budgetUsd: 20, tournament: { maxIterations: 33 } }],
        ["unit-cost-low", { budgetUsd: 20, tournament: { unitCostUsd: 0.01 } }],
        ["float-levels", { budgetUsd: 20, tournament: { levels: 1.5 } }],
        ["nan-budget", { budgetUsd: Number.NaN }],
      ]) {
        const sid = `20261018-190010-${label}`
        const r = await tools9.plan.execute({
          sessionId: sid,
          topology: "massive-proof",
          massiveProofOptIn: true,
          skipInterview: true,
          tasks: [{ id: "T1" }],
          ...extra,
        })
        assert(r.content.startsWith("refused:"), `${label} must be refused: ${r.content}`)
        assert(!existsSync(join(testDir9, ".opencode", "teamwork", sid)), `${label} must not create run dir`)
      }

      // estimate action is read-only
      const estFail = await tools9.tournament.execute({ action: "estimate", budgetUsd: 1 })
      assert.strictEqual(estFail.sufficient, false)
      assert.strictEqual(estFail.refused, "budget_preflight")

      // Pre-existing costs.json at >= 80% refuses init before writing manifest
      const sidHighSpent = "20261018-190011-hispt"
      const highRun = join(testDir9, ".opencode", "teamwork", sidHighSpent)
      mkdirSync(highRun, { recursive: true })
      writeFileSync(join(highRun, "costs.json"), JSON.stringify({ sessionId: sidHighSpent, budgetUsd: 20, spentUsd: 16 }))
      const resHigh = await tools9.tournament.execute({
        action: "init",
        sessionId: sidHighSpent,
        massiveProofOptIn: true,
        budgetUsd: 20,
      })
      assert(resHigh.content.startsWith("refused:"), `>=80% spent must refuse init: ${resHigh.content}`)
      assert(!existsSync(join(highRun, "tournament", "manifest.json")), "must not write tournament/manifest.json on preflight failure")

      // teamwork_plan respects existingCosts.budgetUsd ($8/$10 = 80%) when input.budgetUsd is omitted
      const sidExistingBudget = "20261018-190012-exbud"
      const exBudRun = join(testDir9, ".opencode", "teamwork", sidExistingBudget)
      mkdirSync(exBudRun, { recursive: true })
      const origCosts = JSON.stringify({ sessionId: sidExistingBudget, budgetUsd: 10, spentUsd: 8 })
      writeFileSync(join(exBudRun, "costs.json"), origCosts)
      const resExBud = await tools9.plan.execute({
        sessionId: sidExistingBudget,
        topology: "massive-proof",
        massiveProofOptIn: true,
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert.strictEqual(resExBud.refused, "budget_preflight", `existing $8/$10 must refuse plan when budgetUsd omitted: ${resExBud.content}`)
      assert.strictEqual(readFileSync(join(exBudRun, "costs.json"), "utf8"), origCosts, "costs.json must not be overwritten on refusal")
      assert(!existsSync(join(exBudRun, "plan.dag.json")), "must not write plan.dag.json on budget refusal")

      // Order-insensitive tournament vs tournamentBounds comparison
      const sidOrderEq = "20261018-190013-ordeq"
      const resOrderEq = await tools9.plan.execute({
        sessionId: sidOrderEq,
        topology: "massive-proof",
        massiveProofOptIn: true,
        budgetUsd: 20,
        skipInterview: true,
        tournament: { levels: 2, width: 3 },
        tournamentBounds: { branchingFactor: 3, levels: 2 },
        tasks: [{ id: "T1" }],
      })
      assert(resOrderEq.content.startsWith("Planned"), `equivalent tournament & tournamentBounds in different key order must succeed: ${resOrderEq.content}`)

      const sidOrderConflict = "20261018-190014-ordcf"
      const resOrderConflict = await tools9.plan.execute({
        sessionId: sidOrderConflict,
        topology: "massive-proof",
        massiveProofOptIn: true,
        budgetUsd: 20,
        skipInterview: true,
        tournament: { levels: 2, width: 3 },
        tournamentBounds: { levels: 3, width: 3 },
        tasks: [{ id: "T1" }],
      })
      assert.strictEqual(resOrderConflict.refused, "invalid_tournament_config", "conflicting tournament vs tournamentBounds must be refused")
      assert(!existsSync(join(testDir9, ".opencode", "teamwork", sidOrderConflict)), "conflicting bounds must not mkdir")
    }

    // --- 9.3 Bounded synthetic tournament E2E + team/referee evaluateHook check ---
    {
      for (const act of ["edit", "shell", "subagent", "webfetch"]) {
        const ev = { agent: "team/referee", action: act }
        evaluateHook(ev)
        assert.strictEqual(ev.effect, "deny", `team/referee must deny ${act} in evaluateHook`)
      }

      const sid = "20261018-190020-e2e"
      const planRes = await tools9.plan.execute({
        sessionId: sid,
        topology: "massive-proof",
        massiveProofOptIn: true,
        request: "Prove synthetic lemma via massive-proof tournament",
        budgetUsd: 20,
        skipInterview: true,
        tournament: { levels: 2, branchingFactor: 3, maxCandidates: 8, maxIterations: 2 },
        tasks: [{ id: "T1", agent: "team/proposer" }],
      })
      assert(planRes.content.startsWith("Planned"), `bounded plan must succeed: ${planRes.content}`)

      const nextInit = await tools9.next.execute({ sessionId: sid })
      assert.strictEqual(nextInit.status, "TOURNAMENT_ACTIVE")
      assert.strictEqual(nextInit.tournamentPhase, "PROPOSE")
      assert.strictEqual(nextInit.nextAction, "propose")

      // Propose 3 candidates -> transitions to FALSIFY_PRUNE
      for (const [cid, summary] of [
        ["cand-a", "Direct inductive proof"],
        ["cand-b", "Contradiction proof with helper bound"],
        ["cand-c", "Heuristic leap without base case"],
      ]) {
        const pr = await tools9.tournament.execute({
          action: "propose",
          sessionId: sid,
          candidateId: cid,
          summary,
          proofSketch: `Sketch for ${cid}`,
        })
        assert.strictEqual(pr.candidate.id, cid)
      }

      // Falsify: prune cand-c, cand-a survives, cand-b weakened -> transitions to MERGE
      await tools9.tournament.execute({ action: "falsify", sessionId: sid, candidateId: "cand-c", verdict: "FALSIFIED", reason: "Fails n=0" })
      await tools9.tournament.execute({ action: "falsify", sessionId: sid, candidateId: "cand-a", verdict: "SURVIVES", reason: "Base and inductive steps hold" })
      const fB = await tools9.tournament.execute({ action: "falsify", sessionId: sid, candidateId: "cand-b", verdict: "WEAKENED", reason: "Needs explicit constant" })
      assert.strictEqual(fB.phase, "MERGE")

      // Cannot merge pruned candidate
      const badMerge = await tools9.tournament.execute({
        action: "merge",
        sessionId: sid,
        candidateId: "merge-bad",
        parentIds: ["cand-a", "cand-c"],
        summary: "Should fail",
      })
      assert(badMerge.content.startsWith("refused:"), "merging pruned parent must be refused")

      // Merge surviving parents -> level 1 FALSIFY_PRUNE
      const mRes = await tools9.tournament.execute({
        action: "merge",
        sessionId: sid,
        candidateId: "merge-ab",
        parentIds: ["cand-a", "cand-b"],
        summary: "Combined inductive proof with explicit bound",
        proofSketch: "Full proof combining cand-a and cand-b",
      })
      assert.strictEqual(mRes.phase, "FALSIFY_PRUNE")
      assert.strictEqual(mRes.currentLevel, 1)

      // Falsify merged candidate -> REFEREE_SCORE
      const fM = await tools9.tournament.execute({
        action: "falsify",
        sessionId: sid,
        candidateId: "merge-ab",
        verdict: "SURVIVES",
        reason: "Survives all counterexample probes",
      })
      assert.strictEqual(fM.phase, "REFEREE_SCORE")

      // final_verify while tournament incomplete MUST stamp FAIL
      const runPath = join(testDir9, ".opencode", "teamwork", sid)
      mkdirSync(join(runPath, "verify"), { recursive: true })
      writeFileSync(join(runPath, "verify", "report-T1.json"), JSON.stringify({ status: "PASS" }))
      await tools9.task_update.execute({ sessionId: sid, taskId: "T1", status: "worker_active", agent: "team/proposer" })
      await tools9.task_update.execute({ sessionId: sid, taskId: "T1", status: "worker_done", agent: "team/proposer" })
      await tools9.task_update.execute({ sessionId: sid, taskId: "T1", status: "verifier_active", agent: "team/verifier" })
      await tools9.task_update.execute({ sessionId: sid, taskId: "T1", status: "verified_pass", agent: "team/verifier" })
      await tools9.security_audit.execute({ sessionId: sid, status: "PASS", summary: "Clean" })
      const fvIncomplete = await tools9.final_verify.execute({ sessionId: sid })
      assert.strictEqual(fvIncomplete.status, "FAIL", "final_verify must refuse PASS while tournament is incomplete")

      // Non-referee refused on score
      const badActor = await tools9.tournament.execute({
        action: "score",
        sessionId: sid,
        agent: "team/proposer",
        scores: [{ candidateId: "merge-ab", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" }],
      })
      assert(badActor.content.startsWith("refused:"), "non-referee must be refused on score")

      // Score with tie-breaking check (cand-a and merge-ab tied at 90 -> merge-ab wins by higher level!)
      const scRes = await tools9.tournament.execute({
        action: "score",
        sessionId: sid,
        agent: "team/referee",
        scores: [
          { candidateId: "cand-a", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" },
          { candidateId: "merge-ab", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" },
          { candidateId: "cand-b", soundness: 80, completeness: 80, clarity: 80, verdict: "NEEDS_REVISION" },
        ],
      })
      assert.strictEqual(scRes.phase, "VICTORY_AUDIT")
      assert.strictEqual(scRes.rankedCandidates[0].id, "merge-ab", "level 1 candidate must outrank tied level 0 candidate")

      // Deterministic lexicographical tie-breaker check on compareCandidates
      const baseTie = {
        iteration: 1,
        level: 0,
        parentIds: [],
        agent: "team/proposer",
        status: "survives",
        summary: "x",
        proofSketch: "x",
        refutations: [{ agent: "team/falsifier", verdict: "SURVIVES", reason: "ok", at: "2026-01-01T00:00:00Z" }],
        score: 85,
        rubric: { soundness: 85, completeness: 85, clarity: 85 },
        refereeVerdict: "PASS",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }
      assert(compareCandidates({ ...baseTie, id: "cand-1" }, { ...baseTie, id: "cand-2" }) < 0, "lexicographical tie-break asc")

      // Victory audit by team/referee
      const audRes = await tools9.tournament.execute({
        action: "audit",
        sessionId: sid,
        agent: "team/referee",
        verdict: "PASS",
        summary: "Synthesized proof verified cleanly.",
      })
      assert.strictEqual(audRes.phase, "COMPLETED")
      assert.strictEqual(audRes.verdict.verdict, "ACCEPT")
      assert.strictEqual(audRes.verdict.refereeAgent, "team/referee")
      assert.strictEqual(audRes.verdict.winnerId, "merge-ab")
      assert(existsSync(join(runPath, "TOURNAMENT_REPORT.md")))

      // The tournament has its own victory audit; the independent final
      // acceptance audit is separate and still required for completion.
      await stampVictoryFor(tools9, ctx9, testDir9, sid)
      const fvDone = await tools9.final_verify.execute({ sessionId: sid })
      assert.strictEqual(fvDone.status, "PASS")
      const finalObj = JSON.parse(readFileSync(join(runPath, "verify", "final.json"), "utf8"))
      assert.strictEqual(finalObj.evidence.tournament.phase, "COMPLETED")
      assert.strictEqual(finalObj.evidence.tournament.winnerId, "merge-ab")
      assert.strictEqual(finalObj.evidence.tournament.refereeAgent, "team/referee")

      const nextDone = await tools9.next.execute({ sessionId: sid })
      assert.strictEqual(nextDone.status, "ALL_PASSED")
      assert.strictEqual(nextDone.stamped, true)

      // mF4f: a stamped PASS must not outlive the tournament evidence it rested on.
      {
        const vFile = join(runPath, "tournament", "verdict.json")
        const rFile = join(runPath, "TOURNAMENT_REPORT.md")
        const savedVerdict = readFileSync(vFile, "utf8")
        const savedReport = readFileSync(rFile, "utf8")
        rmSync(vFile)
        rmSync(rFile)
        const stale = await tools9.next.execute({ sessionId: sid })
        assert.strictEqual(stale.status, "BLOCKED", "deleted tournament verdict/report must block merge")
        assert(/completed tournament evidence/i.test(stale.content), `stale evidence refusal must be explicit: ${stale.content}`)
        writeFileSync(vFile, savedVerdict)
        writeFileSync(rFile, savedReport)
        const restored = await tools9.next.execute({ sessionId: sid })
        assert.strictEqual(restored.status, "ALL_PASSED", "restored evidence must allow completion again")
      }

      // mF4l: an AbortSignal that fires during deriveCallerAgent must not stamp PASS.
      {
        const midAbort = new AbortController()
        const originalGet = ctx9.session.get
        ctx9.session.get = async () => {
          midAbort.abort()
          return undefined
        }
        try {
          const fvMidAbort = await tools9.final_verify.execute({ sessionId: sid }, { signal: midAbort.signal, sessionID: sid })
          assert.strictEqual(fvMidAbort.status, "FAIL", "abort after the last await must fail closed")
          assert(/aborted/i.test(fvMidAbort.content), `aborted verdict must say so: ${fvMidAbort.content}`)
        } finally {
          ctx9.session.get = originalGet
        }
      }

      // All-falsified tournament refuses PASS audit
      const sidAllFail = "20261018-190021-allfail"
      await tools9.tournament.execute({
        action: "init",
        sessionId: sidAllFail,
        massiveProofOptIn: true,
        budgetUsd: 20,
        tournament: { levels: 1, branchingFactor: 2, maxCandidates: 4, maxIterations: 1 },
      })
      await tools9.tournament.execute({ action: "propose", sessionId: sidAllFail, candidateId: "c1", summary: "bad 1" })
      await tools9.tournament.execute({ action: "propose", sessionId: sidAllFail, candidateId: "c2", summary: "bad 2" })
      await tools9.tournament.execute({ action: "falsify", sessionId: sidAllFail, candidateId: "c1", verdict: "FALSIFIED", reason: "wrong" })
      await tools9.tournament.execute({ action: "falsify", sessionId: sidAllFail, candidateId: "c2", verdict: "FALSIFIED", reason: "wrong" })
      await tools9.tournament.execute({
        action: "score",
        sessionId: sidAllFail,
        scores: [{ candidateId: "c1", soundness: 10, completeness: 10, clarity: 10, verdict: "FAIL" }],
      })
      const refusePassAudit = await tools9.tournament.execute({
        action: "audit",
        sessionId: sidAllFail,
        verdict: "PASS",
      })
      assert(refusePassAudit.content.startsWith("refused:"), "must refuse PASS when all candidates are pruned")
    }

    // --- 9.4 Cancellation & partial-report handling ---
    {
      // (a) AbortSignal mid-tournament
      const sidSig = "20261018-190030-sig"
      await tools9.tournament.execute({
        action: "init",
        sessionId: sidSig,
        massiveProofOptIn: true,
        budgetUsd: 20,
        tournament: { levels: 2, branchingFactor: 2, maxCandidates: 8, maxIterations: 2 },
      })
      await tools9.tournament.execute({ action: "propose", sessionId: sidSig, candidateId: "s1", summary: "Candidate S1" })
      const ac = new AbortController()
      ac.abort()
      const abortedRes = await tools9.tournament.execute(
        { action: "propose", sessionId: sidSig, candidateId: "s2", summary: "Should abort" },
        { signal: ac.signal },
      )
      assert.strictEqual(abortedRes.aborted, true)
      assert.strictEqual(abortedRes.phase, "CANCELLED")
      const sigRun = join(testDir9, ".opencode", "teamwork", sidSig)
      assert(existsSync(join(sigRun, "TOURNAMENT_REPORT.md")))
      assert(existsSync(join(sigRun, "interrupted.md")))
      const sigVerdict = JSON.parse(readFileSync(join(sigRun, "tournament", "verdict.json"), "utf8"))
      assert.strictEqual(sigVerdict.status, "PARTIAL")
      const sigState = JSON.parse(readFileSync(join(sigRun, "state.json"), "utf8"))
      assert.strictEqual(sigState.phase, "PRESENT_PARTIAL")
      const sigEvents = readFileSync(join(sigRun, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      assert(sigEvents.some((e) => e.event === "tournament_cancelled"), "must append tournament_cancelled event")
      for (let i = 1; i < sigEvents.length; i++) {
        assert(sigEvents[i].seq > sigEvents[i - 1].seq, "events seq must remain monotonic")
      }
      const refusedAfter = await tools9.tournament.execute({ action: "propose", sessionId: sidSig, candidateId: "s3", summary: "After cancel" })
      assert(refusedAfter.content.startsWith("refused:"), "subsequent dispatch must be refused after cancel")
      const fvSig = await tools9.final_verify.execute({ sessionId: sidSig })
      assert.strictEqual(fvSig.status, "FAIL")

      // (b) Explicit cancel + idempotency
      const sidCan = "20261018-190031-can"
      await tools9.tournament.execute({ action: "init", sessionId: sidCan, massiveProofOptIn: true, budgetUsd: 20 })
      await tools9.tournament.execute({ action: "propose", sessionId: sidCan, candidateId: "c1", summary: "Partial cand" })
      const c1 = await tools9.tournament.execute({ action: "cancel", sessionId: sidCan, reason: "User stopped early" })
      assert.strictEqual(c1.phase, "CANCELLED")
      assert.strictEqual(c1.alreadyFinalized, false)
      const c2 = await tools9.tournament.execute({ action: "cancel", sessionId: sidCan, reason: "Repeat" })
      assert.strictEqual(c2.phase, "CANCELLED")
      assert.strictEqual(c2.alreadyFinalized, true)
      assert.strictEqual(c2.verdict.generatedAt, c1.verdict.generatedAt, "idempotent cancel must preserve timestamp")

      // (c) Budget exhaustion -> BUDGET_HALTED
      const sidBud = "20261018-190032-bud"
      await tools9.tournament.execute({ action: "init", sessionId: sidBud, massiveProofOptIn: true, budgetUsd: 10 })
      await tools9.tournament.execute({ action: "propose", sessionId: sidBud, candidateId: "b1", summary: "Before halt" })
      const costRes = await tools9.cost.execute({ sessionId: sidBud, addUsd: 8.5, taskId: "tournament" })
      assert.strictEqual(costRes.shouldHalt, true)
      const haltedNext = await tools9.next.execute({ sessionId: sidBud })
      assert.strictEqual(haltedNext.status, "BUDGET_HALTED")
      assert.strictEqual(haltedNext.phase, "PRESENT_PARTIAL")
      const refusedBud = await tools9.tournament.execute({ action: "propose", sessionId: sidBud, candidateId: "b2", summary: "Over budget" })
      assert(refusedBud.content.startsWith("refused:"), "must refuse dispatch after BUDGET_HALTED")
    }

    // --- 9.5 Security & containment ---
    {
      const sidSec = "20261018-190040-sec"
      await tools9.tournament.execute({ action: "init", sessionId: sidSec, massiveProofOptIn: true, budgetUsd: 20 })
      for (const badId of ["../x", "a/b", ".hidden", "__proto__", "constructor", "prototype", "x".repeat(65)]) {
        const r = await tools9.tournament.execute({ action: "propose", sessionId: sidSec, candidateId: badId, summary: "bad id" })
        assert(r.content.startsWith("refused:"), `bad candidateId ${badId} must be refused: ${r.content}`)
      }
      assert.strictEqual(({}).polluted, undefined, "Object.prototype must remain clean")

      // Control chars in summary/reason cannot inject physical lines in events.jsonl or raw escapes in describeRun
      await tools9.tournament.execute({
        action: "propose",
        sessionId: sidSec,
        candidateId: "ctrl-1",
        summary: "Line1\r\nLine2\u2028Line3\u2029\x1b[31m",
      })
      const desc = describeRun(testDir9)
      assert(desc && desc.includes("Tournament: phase"), "describeRun must include sanitized tournament line")
      assert(!desc.includes(ESC_CHAR) && !/[\u2028\u2029]/.test(desc), "describeRun must never contain raw ESC or Unicode line separators")

      // Symlinked tournament/ dir and dangling symlinked report refused cleanly without throwing or touching outside files
      const sidSym = "20261018-190041-sym"
      await tools9.tournament.execute({ action: "init", sessionId: sidSym, massiveProofOptIn: true, budgetUsd: 20 })
      const symRun = join(testDir9, ".opencode", "teamwork", sidSym)
      const outsideTarget = join(testDir9, "outside-secret.txt")
      writeFileSync(outsideTarget, "ORIGINAL")
      rmSync(join(symRun, "TOURNAMENT_REPORT.md"), { force: true })
      symlinkSync(outsideTarget, join(symRun, "TOURNAMENT_REPORT.md"))
      const symCancel = await tools9.tournament.execute({ action: "cancel", sessionId: sidSym, reason: "Symlink check" })
      assert.strictEqual(symCancel.refused, "unsafe_path", `symlinked TOURNAMENT_REPORT.md must return refused: "unsafe_path": ${JSON.stringify(symCancel)}`)
      assert(/refused/i.test(symCancel.content), `symlinked TOURNAMENT_REPORT.md must be refused: ${symCancel.content}`)
      assert.strictEqual(readFileSync(outsideTarget, "utf8"), "ORIGINAL", "outside target must remain untouched")

      // teamwork_plan refuses before writing plan.dag.json/state.json/costs.json when tournament/ is a symlink
      const sidPlanSym = "20261018-190043-plansym"
      const planSymRun = join(testDir9, ".opencode", "teamwork", sidPlanSym)
      mkdirSync(planSymRun, { recursive: true })
      symlinkSync(join(testDir9, "nonexistent-outside-tournament"), join(planSymRun, "tournament"))
      const resPlanSym = await tools9.plan.execute({
        sessionId: sidPlanSym,
        topology: "massive-proof",
        massiveProofOptIn: true,
        budgetUsd: 20,
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert.strictEqual(resPlanSym.refused, "unsafe_path", `plan with symlinked tournament/ must return refused: "unsafe_path": ${JSON.stringify(resPlanSym)}`)
      assert(!existsSync(join(planSymRun, "plan.dag.json")), "must not write plan.dag.json when tournament/ is symlink")
      assert(!existsSync(join(planSymRun, "state.json")), "must not write state.json when tournament/ is symlink")
      assert(!existsSync(join(planSymRun, "costs.json")), "must not write costs.json when tournament/ is symlink")

      const sidSymDir = "20261018-190042-symdir"
      await tools9.tournament.execute({ action: "init", sessionId: sidSymDir, massiveProofOptIn: true, budgetUsd: 20 })
      const symDirRun = join(testDir9, ".opencode", "teamwork", sidSymDir)
      const outsideDir = join(testDir9, "outside-dir")
      mkdirSync(outsideDir, { recursive: true })
      writeFileSync(join(outsideDir, "manifest.json"), JSON.stringify({ phase: "COMPLETED", config: {} }))
      rmSync(join(symDirRun, "tournament"), { recursive: true, force: true })
      symlinkSync(outsideDir, join(symDirRun, "tournament"))
      const symStatus = await tools9.tournament.execute({ action: "status", sessionId: sidSymDir })
      assert.strictEqual(symStatus.refused, "unsafe_path")
      assert(/refused/i.test(symStatus.content), `symlinked tournament/ dir must be refused: ${symStatus.content}`)

      // teamwork_next (AbortSignal & budget_exhausted) and teamwork_final_verify (AbortSignal) return clean refused: "unsafe_path"
      // without throwing or touching symlink targets when TOURNAMENT_REPORT.md, interrupted.md, or tournament/verdict.json is a symlink
      for (const relTarget of ["TOURNAMENT_REPORT.md", "interrupted.md", join("tournament", "verdict.json")]) {
        const sidNextSig = `20261018-190044-${relTarget.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase()}`
        await tools9.tournament.execute({ action: "init", sessionId: sidNextSig, massiveProofOptIn: true, budgetUsd: 20 })
        const rDir = join(testDir9, ".opencode", "teamwork", sidNextSig)
        const canary = join(testDir9, `canary-${sidNextSig}.txt`)
        writeFileSync(canary, "DO_NOT_TOUCH")
        rmSync(join(rDir, relTarget), { force: true })
        symlinkSync(canary, join(rDir, relTarget))

        const acNext = new AbortController()
        acNext.abort()
        const nextSigRes = await tools9.next.execute({ sessionId: sidNextSig }, { signal: acNext.signal })
        assert.strictEqual(nextSigRes.status, "BLOCKED", `teamwork_next AbortSignal with symlinked ${relTarget} must return BLOCKED`)
        assert.strictEqual(nextSigRes.refused, "unsafe_path", `teamwork_next AbortSignal with symlinked ${relTarget} must return refused: unsafe_path`)
        assert(/refused/i.test(nextSigRes.content))
        assert.strictEqual(readFileSync(canary, "utf8"), "DO_NOT_TOUCH", "canary must remain untouched")

        const fvSigRes = await tools9.final_verify.execute({ sessionId: sidNextSig }, { signal: acNext.signal })
        assert.strictEqual(fvSigRes.status, "FAIL", `teamwork_final_verify AbortSignal with symlinked ${relTarget} must return FAIL`)
        assert.strictEqual(fvSigRes.refused, "unsafe_path", `teamwork_final_verify AbortSignal with symlinked ${relTarget} must return refused: unsafe_path`)
        assert(/refused/i.test(fvSigRes.content))
        assert.strictEqual(readFileSync(canary, "utf8"), "DO_NOT_TOUCH", "canary must remain untouched")
      }

      // teamwork_next budget_exhausted + teamwork_tournament locked costs.json symlink handling
      const sidNextBud = "20261018-190045-nbudsym"
      await tools9.tournament.execute({ action: "init", sessionId: sidNextBud, massiveProofOptIn: true, budgetUsd: 10 })
      const nBudDir = join(testDir9, ".opencode", "teamwork", sidNextBud)
      await tools9.cost.execute({ sessionId: sidNextBud, addUsd: 8.5, taskId: "tournament" })
      const budCanary = join(testDir9, "canary-nbud.txt")
      writeFileSync(budCanary, "DO_NOT_TOUCH")
      rmSync(join(nBudDir, "TOURNAMENT_REPORT.md"), { force: true })
      symlinkSync(budCanary, join(nBudDir, "TOURNAMENT_REPORT.md"))
      const nextBudRes = await tools9.next.execute({ sessionId: sidNextBud })
      assert.strictEqual(nextBudRes.status, "BLOCKED", "teamwork_next budget_exhausted with symlinked TOURNAMENT_REPORT.md must return BLOCKED")
      assert.strictEqual(nextBudRes.refused, "unsafe_path")
      assert.strictEqual(readFileSync(budCanary, "utf8"), "DO_NOT_TOUCH")

      // Locked teamwork_tournament propose with symlinked costs.json returns refused: "unsafe_path"
      const sidCostsSym = "20261018-190046-costsym"
      await tools9.tournament.execute({ action: "init", sessionId: sidCostsSym, massiveProofOptIn: true, budgetUsd: 20 })
      const costsSymDir = join(testDir9, ".opencode", "teamwork", sidCostsSym)
      const outsideCosts = join(testDir9, "outside-costs.json")
      writeFileSync(outsideCosts, JSON.stringify({ budgetUsd: 20, spentUsd: 0 }))
      rmSync(join(costsSymDir, "costs.json"), { force: true })
      symlinkSync(outsideCosts, join(costsSymDir, "costs.json"))
      const costsSymRes = await tools9.tournament.execute({ action: "propose", sessionId: sidCostsSym, candidateId: "c1", summary: "x" })
      assert.strictEqual(costsSymRes.refused, "unsafe_path", `symlinked costs.json in locked action must return refused: unsafe_path: ${JSON.stringify(costsSymRes)}`)
    }

    // --- 9.4 CodeRabbit review threads (tournament/PR #10).
    {
      const run9 = (id) => join(testDir9, ".opencode", "teamwork", id)
      const readJson9 = (file) => JSON.parse(readFileSync(file, "utf8"))

      // mF44: quoted examples are documentation, not consent (route + plan).
      const rQuoted = await tools9.route.execute({
        request: 'Prove this theorem. The example says “use a proof tournament”.',
      })
      assert.notStrictEqual(rQuoted.topology, "massive-proof", "quoted opt-in must not route to massive-proof")
      assert.strictEqual(rQuoted.massiveProofOptIn, false)
      const rAffirm = await tools9.route.execute({ request: "Use a proof tournament to prove this theorem" })
      assert.strictEqual(rAffirm.topology, "massive-proof", "unquoted opt-in must still route to massive-proof")
      assert.strictEqual(rAffirm.massiveProofOptIn, true)
      const sidQuoted = "20261018-190100-qconsent"
      const planQuoted = await tools9.plan.execute({
        sessionId: sidQuoted,
        topology: "massive-proof",
        request: 'Prove this theorem. The example says “use a proof tournament”.',
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert.strictEqual(planQuoted.refused, "opt_in_required", "quoted prose must not pass plan preflight")
      assert(!existsSync(run9(sidQuoted)), "refused plan must write nothing")
      const sidAffirm = "20261018-190101-affirm"
      const planAffirm = await tools9.plan.execute({
        sessionId: sidAffirm,
        topology: "massive-proof",
        request: "Use a proof tournament to prove this theorem",
        budgetUsd: 20,
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert(planAffirm.content.startsWith("Planned"), `unquoted opt-in must still plan: ${planAffirm.content}`)

      // mF4B: a NEW bare `massive-proof-swarm` run needs opt-in; an existing legacy run opens.
      const sidAliasNew = "20261018-190102-aliasnew"
      const aliasNew = await tools9.plan.execute({ sessionId: sidAliasNew, topology: "massive-proof-swarm", skipInterview: true, tasks: [{ id: "T1" }] })
      assert.strictEqual(aliasNew.refused, "opt_in_required", "new bare alias must be gated")
      assert(!existsSync(run9(sidAliasNew)), "gated alias must write nothing")
      const sidAliasLegacy = "20261018-190103-aliasold"
      mkdirSync(run9(sidAliasLegacy), { recursive: true })
      const aliasLegacy = await tools9.plan.execute({ sessionId: sidAliasLegacy, topology: "massive-proof-swarm", skipInterview: true, tasks: [{ id: "T1" }] })
      assert(aliasLegacy.content.startsWith("Planned"), `existing legacy alias run must still open: ${aliasLegacy.content}`)
      assert.strictEqual(readJson9(join(run9(sidAliasLegacy), "plan.dag.json")).topology, "massive-proof")
      assert(!existsSync(join(run9(sidAliasLegacy), "tournament", "manifest.json")), "legacy alias migration must not create tournament state")

      // mF4E: re-plans cannot change active bounds; omitting them retains the manifest config.
      const sidAffirmRun = run9(sidAffirm)
      const manifestBefore = readJson9(join(sidAffirmRun, "tournament", "manifest.json"))
      const boundsReplan = await tools9.plan.execute({
        sessionId: sidAffirm,
        topology: "massive-proof",
        massiveProofOptIn: true,
        budgetUsd: 20,
        skipInterview: true,
        tournament: { branchingFactor: 1 },
        tasks: [{ id: "T1" }],
      })
      assert.strictEqual(boundsReplan.refused, "invalid_tournament_config", "changing active bounds must be refused")
      const manifestAfter = readJson9(join(sidAffirmRun, "tournament", "manifest.json"))
      assert.strictEqual(manifestAfter.config.branchingFactor, manifestBefore.config.branchingFactor)
      const omittedReplan = await tools9.plan.execute({
        sessionId: sidAffirm,
        topology: "massive-proof",
        massiveProofOptIn: true,
        budgetUsd: 20,
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert(omittedReplan.content.startsWith("Planned"), `re-plan without bounds must succeed: ${omittedReplan.content}`)
      assert.strictEqual(readJson9(join(sidAffirmRun, "plan.dag.json")).tournament.config.branchingFactor, manifestBefore.config.branchingFactor, "plan must retain active bounds")

      // mF4H: init persists an approved budget override while preserving spend.
      const sidBudInit = "20261018-190104-budinit"
      const budRun = run9(sidBudInit)
      mkdirSync(budRun, { recursive: true })
      writeFileSync(join(budRun, "costs.json"), JSON.stringify({ sessionId: sidBudInit, budgetUsd: 10, spentUsd: 8, byTask: {}, byTaskTokens: {} }))
      const budInit = await tools9.tournament.execute({ action: "init", sessionId: sidBudInit, massiveProofOptIn: true, budgetUsd: 20 })
      assert(budInit.content.startsWith("Tournament initialized"), `init with larger budget must succeed: ${budInit.content}`)
      const budCosts = readJson9(join(budRun, "costs.json"))
      assert.strictEqual(budCosts.budgetUsd, 20, "init must persist the approved budget")
      assert.strictEqual(budCosts.spentUsd, 8, "init must preserve accumulated spend")
      const budNext = await tools9.next.execute({ sessionId: sidBudInit })
      assert.strictEqual(budNext.status, "TOURNAMENT_ACTIVE", "next must use the persisted budget, not halt")

      // mF4N: an init retry repairs a missing costs.json even when the plan exists.
      const sidRepair = "20261018-190105-repair"
      const repairRun = run9(sidRepair)
      mkdirSync(repairRun, { recursive: true })
      writeFileSync(join(repairRun, "plan.dag.json"), JSON.stringify({ sessionId: sidRepair, topology: "massive-proof", tasks: [], tournament: { config: {} } }))
      const repairInit = await tools9.tournament.execute({ action: "init", sessionId: sidRepair, massiveProofOptIn: true, budgetUsd: 20 })
      assert(repairInit.content.startsWith("Tournament initialized"), `retry init must succeed: ${repairInit.content}`)
      assert(existsSync(join(repairRun, "costs.json")), "retry init must repair a missing cost record")
      assert.strictEqual(readJson9(join(repairRun, "costs.json")).budgetUsd, 20)

      // mF4T: missing costs.json blocks tournament work instead of skipping the budget guard.
      const sidNoCosts = "20261018-190106-nocosts"
      await tools9.tournament.execute({ action: "init", sessionId: sidNoCosts, massiveProofOptIn: true, budgetUsd: 20 })
      rmSync(join(run9(sidNoCosts), "costs.json"))
      const noCostsNext = await tools9.next.execute({ sessionId: sidNoCosts })
      assert.strictEqual(noCostsNext.status, "BLOCKED", "missing costs.json must block next")
      assert(/costs\.json/i.test(noCostsNext.content))
      const noCostsPropose = await tools9.tournament.execute({ action: "propose", sessionId: sidNoCosts, candidateId: "c1", summary: "x" })
      assert.strictEqual(noCostsPropose.refused, "budget_preflight", "missing costs.json must refuse tournament work")

      // mF4X: a known non-referee caller cannot self-certify with the agent label.
      const sidTrust = "20261018-190107-trust"
      await tools9.tournament.execute({
        action: "init",
        sessionId: sidTrust,
        massiveProofOptIn: true,
        budgetUsd: 20,
        tournament: { levels: 1, branchingFactor: 1, maxCandidates: 4, maxIterations: 1 },
      })
      await tools9.tournament.execute({ action: "propose", sessionId: sidTrust, candidateId: "c1", summary: "Candidate" })
      await tools9.tournament.execute({ action: "falsify", sessionId: sidTrust, candidateId: "c1", verdict: "SURVIVES", reason: "Survives" })
      const originalSessionGet = ctx9.session.get
      ctx9.session.get = async () => ({ agent: "team/worker" })
      try {
        const selfCert = await tools9.tournament.execute(
          {
            action: "score",
            sessionId: sidTrust,
            agent: "team/referee",
            scores: [{ candidateId: "c1", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" }],
          },
          { sessionID: sidTrust },
        )
        assert(selfCert.content.startsWith("refused:"), "non-referee session identity must override the referee label")
      } finally {
        ctx9.session.get = originalSessionGet
      }

      // mF5O: score batches cannot repeat ids or exceed the candidate count.
      const duplicateScores = await tools9.tournament.execute({
        action: "score",
        sessionId: sidTrust,
        agent: "team/referee",
        scores: [
          { candidateId: "c1", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" },
          { candidateId: "c1", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" },
        ],
      })
      assert(duplicateScores.content.includes("duplicate candidateId"), `duplicate ids must be refused: ${duplicateScores.content}`)
      const oversizeScores = await tools9.tournament.execute({
        action: "score",
        sessionId: sidTrust,
        agent: "team/referee",
        scores: [
          { candidateId: "c1", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" },
          { candidateId: "c2", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" },
        ],
      })
      assert(oversizeScores.content.includes("exceeds the number of tournament candidates"), `oversize batch must be refused: ${oversizeScores.content}`)
      const validScore = await tools9.tournament.execute({
        action: "score",
        sessionId: sidTrust,
        agent: "team/referee",
        scores: [{ candidateId: "c1", soundness: 90, completeness: 90, clarity: 90, verdict: "PASS" }],
      })
      assert.strictEqual(validScore.phase, "VICTORY_AUDIT", "one score per candidate must still work")

      // mF4F: concurrent init calls cannot both publish a manifest.
      const sidRace = "20261018-190108-race"
      const [raceA, raceB] = await Promise.all([
        tools9.tournament.execute({ action: "init", sessionId: sidRace, massiveProofOptIn: true, budgetUsd: 20 }),
        tools9.tournament.execute({ action: "init", sessionId: sidRace, massiveProofOptIn: true, budgetUsd: 20, tournament: { maxIterations: 2 } }),
      ])
      const raceWins = [raceA, raceB].filter((r) => r.manifest)
      const raceLosses = [raceA, raceB].filter((r) => !r.manifest)
      assert.strictEqual(raceWins.length, 1, "exactly one concurrent init must win")
      assert.strictEqual(raceLosses.length, 1, "the other concurrent init must refuse")
      assert(/already exists/i.test(raceLosses[0].content), `losing init must explain: ${raceLosses[0].content}`)
      const raceManifest = readJson9(join(run9(sidRace), "tournament", "manifest.json"))
      assert.strictEqual(raceManifest.phase, "PROPOSE")

      // mF5I: malformed COMPLETED evidence is rejected, not read as .length on undefined.
      const sidBadEvidence = "20261018-190109-badev"
      const badRun = run9(sidBadEvidence)
      mkdirSync(join(badRun, "tournament"), { recursive: true })
      mkdirSync(join(badRun, "verify"), { recursive: true })
      writeFileSync(join(badRun, "plan.dag.json"), JSON.stringify({ sessionId: sidBadEvidence, topology: "massive-proof", tournament: { config: {} }, tasks: [{ id: "T1" }] }))
      writeFileSync(join(badRun, "state.json"), JSON.stringify({ sessionId: sidBadEvidence, phase: "DISPATCH", tasks: { T1: { status: "verified_pass" } } }))
      writeFileSync(join(badRun, "verify", "report-T1.json"), JSON.stringify({ status: "PASS" }))
      writeFileSync(join(badRun, "verify", "security-audit.json"), JSON.stringify({ status: "PASS" }))
      writeFileSync(
        join(badRun, "tournament", "manifest.json"),
        JSON.stringify({
          version: 1,
          sessionId: sidBadEvidence,
          phase: "COMPLETED",
          config: { levels: 2, branchingFactor: 4, maxCandidates: 16, maxIterations: 4, passScoreThreshold: 70, unitCostUsd: 0.25 },
          candidates: {},
        }),
      )
      const badEvidence = await tools9.final_verify.execute({ sessionId: sidBadEvidence })
      assert.strictEqual(badEvidence.status, "FAIL", "malformed completed evidence must fail closed")
      assert(/rankedCandidates|verdict/i.test(badEvidence.content), `schema failure must be named: ${badEvidence.content}`)

      // mF49/mF5B: max estimate counts referee calls per iteration and preflight
      // respects the same 80% dispatch halt threshold.
      const estMax = await tools9.tournament.execute({
        action: "estimate",
        budgetUsd: 20,
        tournament: { levels: 1, branchingFactor: 1, maxCandidates: 2, maxIterations: 2 },
      })
      assert.strictEqual(estMax.estimate.estimatedMinUsd, 1, "min estimate for width/level 1 should be $1.00")
      assert.strictEqual(estMax.estimate.estimatedMaxUsd, 1.75, "max estimate must count a referee call per iteration")
      const estTight = await tools9.tournament.execute({ action: "estimate", budgetUsd: 3.5 })
      assert.strictEqual(estTight.ok, false, "budget equal to the estimate must fail the 80% dispatch-halt preflight")
      const estSafe = await tools9.tournament.execute({ action: "estimate", budgetUsd: 4.5 })
      assert.strictEqual(estSafe.ok, true, "a budget above the 80% cap must be sufficient")

      // mF5V: a cancellation retry repairs state/artifacts without changing the reason/timestamp.
      const sidCancelRetry = "20261018-190110-caretry"
      await tools9.tournament.execute({ action: "init", sessionId: sidCancelRetry, massiveProofOptIn: true, budgetUsd: 20 })
      await tools9.tournament.execute({ action: "propose", sessionId: sidCancelRetry, candidateId: "c1", summary: "Cancel me" })
      const firstCancel = await tools9.tournament.execute({ action: "cancel", sessionId: sidCancelRetry, reason: "First reason" })
      assert.strictEqual(firstCancel.alreadyFinalized, false)
      const cancelRun = run9(sidCancelRetry)
      const cancelledManifest = readJson9(join(cancelRun, "tournament", "manifest.json"))
      const cancelledAt = cancelledManifest.cancelled.cancelledAt
      const stateBefore = readJson9(join(cancelRun, "state.json"))
      stateBefore.phase = "DISPATCH"
      writeFileSync(join(cancelRun, "state.json"), JSON.stringify(stateBefore))
      rmSync(join(cancelRun, "tournament", "verdict.json"))
      rmSync(join(cancelRun, "TOURNAMENT_REPORT.md"))
      rmSync(join(cancelRun, "interrupted.md"))
      const retryCancel = await tools9.tournament.execute({ action: "cancel", sessionId: sidCancelRetry, reason: "Second reason" })
      assert.strictEqual(retryCancel.alreadyFinalized, true, "retry must take the idempotent branch")
      assert.strictEqual(readJson9(join(cancelRun, "state.json")).phase, "PRESENT_PARTIAL", "retry must repair the checkpoint")
      assert(existsSync(join(cancelRun, "tournament", "verdict.json")), "retry must restore the verdict artifact")
      assert(existsSync(join(cancelRun, "TOURNAMENT_REPORT.md")), "retry must restore the partial report")
      assert(existsSync(join(cancelRun, "interrupted.md")), "retry must restore interrupted.md")
      const repairedManifest = readJson9(join(cancelRun, "tournament", "manifest.json"))
      assert.strictEqual(repairedManifest.cancelled.reason, cancelledManifest.cancelled.reason, "retry must preserve the original reason")
      assert.strictEqual(repairedManifest.cancelled.cancelledAt, cancelledAt, "retry must preserve the original timestamp")
      assert.strictEqual(readJson9(join(cancelRun, "tournament", "verdict.json")).generatedAt, cancelledAt, "restored verdict keeps original timestamp")
    }

    console.log("✓ Math/Proof tournament opt-in, preflight, E2E, cancellation & security verified")
  } finally {
    rmSync(testDir9, { recursive: true, force: true })
  }
}

// ==========================================
// Part 9: LEMMA / Lean 4 formal-proof route (#2)
// ==========================================
{
  console.log("Testing LEMMA / Lean 4 formal-proof route...")
  const repoRoot = fileURLToPath(new URL("..", import.meta.url))
  const savedPath = process.env.PATH ?? ""
  const lemmaTestDir = mkdtempSync(join(tmpdir(), "teamwork-lemma-test-"))

  // --- 9.0 Sentinel/orchestrator plan calls must record the verbatim request.
  {
    const sentinel = readFileSync(join(repoRoot, "agents/team/sentinel.md"), "utf8")
    const planStart = sentinel.indexOf("**Build the DAG.**")
    const planEnd = sentinel.indexOf("**Provision the sentinel worktree")
    assert(planStart >= 0 && planEnd > planStart, "sentinel must document the Build the DAG step")
    const planStep = sentinel.slice(planStart, planEnd)
    assert(/\brequest\b/.test(planStep), "sentinel Build the DAG step must pass the verbatim `request` to teamwork_plan")
    assert(planStep.includes("ORIGINAL_REQUEST.md"), "sentinel must state that request is recorded in ORIGINAL_REQUEST.md")
    assert(/verbatim/i.test(planStep), "sentinel must require the request verbatim")
    assert(
      /ORIGINAL_REQUEST\.md/.test(sentinel.slice(sentinel.indexOf("LEMMA bounded workflow"), sentinel.indexOf("The worker commits"))),
      "sentinel LEMMA workflow must point both formalization reviews at ORIGINAL_REQUEST.md",
    )

    const orchestrator = readFileSync(join(repoRoot, "agents/team/orchestrator.md"), "utf8")
    const orchPlan = orchestrator.slice(orchestrator.indexOf("**Plan**"), orchestrator.indexOf("**Propose**"))
    assert(/\brequest\b/.test(orchPlan), "orchestrator Plan step must pass the verbatim `request` to teamwork_plan")
    assert(orchPlan.includes("ORIGINAL_REQUEST.md"), "orchestrator must state that request is recorded in ORIGINAL_REQUEST.md")

    const indexSrc = readFileSync(join(repoRoot, "plugins/opencode-teamwork/index.ts"), "utf8")
    const teamworkCommand = indexSrc.slice(indexSrc.indexOf('name: "teamwork"'), indexSrc.indexOf('name: "teamwork-craft"'))
    assert(/teamwork_plan/.test(teamworkCommand), "the /teamwork template must mention teamwork_plan")
    assert(/\brequest\b/.test(teamworkCommand), "the /teamwork template must tell Sentinel to pass the verbatim request")
    assert(/ORIGINAL_REQUEST\.md/.test(teamworkCommand), "the /teamwork template must name ORIGINAL_REQUEST.md")
    console.log("✓ 9.0 sentinel/orchestrator teamwork_plan calls record the verbatim request")
  }

  const makeToolsFor = async (root) => {
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
    return tools
  }

  const writeStubBin = (dir, name, scriptBody) => {
    const p = join(dir, name)
    writeFileSync(p, `#!${process.execPath}\n${scriptBody}\n`, "utf8")
    chmodSync(p, 0o755)
    return p
  }

  const makeFullStubEnv = (label) => {
    const binDir = mkdtempSync(join(lemmaTestDir, `stubs-${label}-`))
    writeStubBin(
      binDir,
      "lean",
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Lean (version 4.14.0, commit stub)");
  process.exit(0);
}
const target = args[args.length - 1];
const src = target && fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
if (src.includes("SYNTAX_ERROR")) {
  console.error(target + ":1:0: error: expected command");
  process.exit(1);
}
const axiomMatch = src.match(/#print axioms\\s+([^\\s]+)/);
if (axiomMatch) {
  const name = axiomMatch[1];
  if (src.includes("AXIOM_SORRY_DEP")) {
    console.log("'" + name + "' depends on axioms: [sorryAx, Classical.choice, propext, Quot.sound]");
    process.exit(0);
  }
  if (src.includes("AXIOM_BAD_DEP")) {
    console.log("'" + name + "' depends on axioms: [my_evil_ax]");
    process.exit(0);
  }
  if (src.includes("AXIOM_CUSTOM_DEP")) {
    console.log("'" + name + "' depends on axioms: [my_custom_ax]");
    process.exit(0);
  }
  console.log("'" + name + "' does not depend on any axioms");
  process.exit(0);
}
if (src.includes("COMPILER_SORRY_WARN")) {
  process.stderr.write(target + ":1:0: warning: declaration uses 'sorry'\\n");
  process.exit(0);
}
if (src.includes("STDERR_SORRY_AX")) {
  process.stderr.write("uses sorryAx\\n");
  process.exit(0);
}
const codeOnly = src.replace(/--.*$/gm, "").replace(/\\\/-[\\s\\S]*?-\\\//g, "").replace(/"(?:\\\\.|[^"\\\\])*"/g, '""');
if (/\\bsorry\\b/.test(codeOnly)) {
  process.stderr.write(target + ":1:0: warning: declaration uses 'sorry'\\n");
}
process.exit(0);
`,
    )
    writeStubBin(
      binDir,
      "lake",
      `
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Lake version 5.0.0-stub");
  process.exit(0);
}
process.exit(0);
`,
    )
    writeStubBin(
      binDir,
      "leap",
      `
const args = process.argv.slice(2);
// The real leap CLI is an argparse CLI with a required subcommand and no
// --version flag, so --version exits non-zero and --help succeeds.
if (args.includes("--version")) {
  console.error("usage: leap [-h] {lean,doctor,config} ...");
  process.exit(2);
}
if (args.includes("--help")) {
  console.log("usage: leap [-h] {lean,doctor,config} ...");
  process.exit(0);
}
process.exit(0);
`,
    )
    return binDir
  }

  try {
    // --- 9.1 Pre-mkdir / pre-spending refusal ---
    {
      const probeEmpty = probeLemmaToolchain({ env: { PATH: "" } })
      assert.strictEqual(probeEmpty.ready, false, "empty PATH must not be ready")
      assert.strictEqual(probeEmpty.status, "MISSING")
      assert.deepStrictEqual(probeEmpty.missing, ["lean", "lake", LEAP_REQUIREMENT])

      const onlyLeanDir = mkdtempSync(join(lemmaTestDir, "only-lean-"))
      writeStubBin(onlyLeanDir, "lean", `console.log("Lean 4.14.0")`)
      writeStubBin(onlyLeanDir, "lake", `console.log("Lake 5.0")`)
      const probeNoLeap = probeLemmaToolchain({ env: { PATH: onlyLeanDir } })
      assert.strictEqual(probeNoLeap.ready, false, "missing LEAP CLI must fail probe")
      assert.deepStrictEqual(probeNoLeap.missing, [LEAP_REQUIREMENT])

      // `leap` is preferred; the legacy `leap-tools` name is still accepted.
      const legacyDir = mkdtempSync(join(lemmaTestDir, "legacy-leap-"))
      writeStubBin(legacyDir, "lean", `console.log("Lean 4.14.0")`)
      writeStubBin(legacyDir, "lake", `console.log("Lake 5.0")`)
      writeStubBin(legacyDir, "leap-tools", `console.log("leap-tools 0.1.0-stub")`)
      const probeLegacy = probeLemmaToolchain({ env: { PATH: legacyDir } })
      assert.strictEqual(probeLegacy.ready, true, "legacy leap-tools must satisfy the LEAP CLI requirement")
      assert.strictEqual(probeLegacy.leap.name, "leap-tools", "legacy binary must be reported as leap-tools")
      assert.strictEqual(probeLegacy.leap.path, join(legacyDir, "leap-tools"))

      const bothDir = mkdtempSync(join(lemmaTestDir, "both-leap-"))
      writeStubBin(bothDir, "lean", `console.log("Lean 4.14.0")`)
      writeStubBin(bothDir, "lake", `console.log("Lake 5.0")`)
      writeStubBin(bothDir, "leap", `if (process.argv.includes("--version")) process.exit(2); console.log("usage: leap ...")`)
      writeStubBin(bothDir, "leap-tools", `console.log("leap-tools 0.1.0-stub")`)
      const probeBoth = probeLemmaToolchain({ env: { PATH: bothDir } })
      assert.strictEqual(probeBoth.ready, true)
      assert.strictEqual(probeBoth.leap.name, "leap", "`leap` must be probed before legacy leap-tools")
      assert.strictEqual(probeBoth.leap.path, join(bothDir, "leap"))

      const outageDir = mkdtempSync(join(lemmaTestDir, "outage-"))
      writeStubBin(outageDir, "lean", `console.error("broken binary"); process.exit(2)`)
      writeStubBin(outageDir, "lake", `console.log("Lake 5.0")`)
      writeStubBin(outageDir, "leap", `console.error("broken binary"); process.exit(2)`)
      const probeOutage = probeLemmaToolchain({ env: { PATH: outageDir } })
      assert.strictEqual(probeOutage.ready, false)
      assert.strictEqual(probeOutage.status, "OUTAGE", "non-zero probe on existing binary must report OUTAGE")

      const refusalMsg = formatMissingToolchainRefusal(probeNoLeap)
      assert(refusalMsg.startsWith("refused:"), "refusal must start with refused:")
      assert(refusalMsg.includes("elan") && refusalMsg.includes("leanprover/lean4:stable"), "must include Lean 4 install instructions")
      assert(refusalMsg.includes("$HOME/.elan/bin") && refusalMsg.includes("lean --version && lake --version"), "must include PATH and verify command")
      assert(refusalMsg.includes(LEAP_REQUIREMENT), "refusal must name the real LEAP CLI requirement")
      assert(
        refusalMsg.split("\n").map((line) => line.trim()).includes("pipx install git+https://github.com/billkunghappy/LEAP-CLI@afc016d23579d8236050a157fe6cac8f17b13096"),
        "must include the pinned LEAP CLI git install as an exact instruction line",
      )
      assert(mentionsExactUrl(refusalMsg, "https://github.com/billkunghappy/LEAP-CLI"), "must include the LEAP-CLI repo URL")
      assert(refusalMsg.includes("leap --help"), "must verify the leap console script via --help")
      assert(!refusalMsg.includes("pipx install leap-tools"), "must not suggest the non-existent leap-tools PyPI package")
      assert(refusalMsg.includes("leap lean") && refusalMsg.includes("11 GB") && refusalMsg.includes("Mathlib"), "must describe optional `leap lean` Mathlib cost")
      assert(/no Mathlib|only core Lean/i.test(refusalMsg), "must state the E2E needs only core Lean")

      // teamwork_plan pre-mkdir refusal even with allowMissingInputs: true & skipInterview: true
      const rootNoTool = mkdtempSync(join(lemmaTestDir, "root-notool-"))
      const tools = await makeToolsFor(rootNoTool)
      process.env.PATH = onlyLeanDir
      const refusedPlan = await tools.plan.execute({
        sessionId: "20261018-000000-lemma-refuse",
        topology: "proof",
        lemmaMode: true,
        route: "lemma",
        skipInterview: true,
        allowMissingInputs: true,
        tasks: [{ id: "L1" }],
      })
      assert(refusedPlan.content.startsWith("refused:"), `missing toolchain must refuse plan: ${refusedPlan.content}`)
      assert(refusedPlan.content.includes(LEAP_REQUIREMENT), "plan refusal must name the real LEAP CLI requirement")
      assert(mentionsExactUrl(refusedPlan.content, "https://github.com/billkunghappy/LEAP-CLI"), "plan refusal must print install instructions for Lean 4 and the LEAP CLI")
      assert(!existsSync(join(rootNoTool, ".opencode", "teamwork", "20261018-000000-lemma-refuse")), "refused LEMMA plan must create zero dirs/files")

      const badTopo = await tools.plan.execute({
        sessionId: "20261018-000000-lemma-badtopo",
        topology: "distributed-coding",
        lemmaMode: true,
        skipInterview: true,
        tasks: [{ id: "L1" }],
      })
      assert(badTopo.content.startsWith("refused:"), "lemmaMode: true with non-proof topology must refuse before mkdir")
      assert(!existsSync(join(rootNoTool, ".opencode")), "bad topology refusal must write nothing")

      // V2.07: uppercase route: "LEMMA" must still trigger pre-mkdir probe
      const upperRoutePlan = await tools.plan.execute({
        sessionId: "20261018-000000-lemma-upper",
        topology: "proof",
        route: "LEMMA",
        skipInterview: true,
        tasks: [{ id: "L1" }],
      })
      assert(upperRoutePlan.content.startsWith("refused:"), `uppercase route LEMMA must refuse before mkdir: ${upperRoutePlan.content}`)
      assert(!existsSync(join(rootNoTool, ".opencode", "teamwork", "20261018-000000-lemma-upper")), "uppercase route refusal must create zero dirs")
      console.log("✓ 9.1 pre-mkdir / pre-spending refusal & install instructions verified")
    }

    // --- 9.2 Explicit opt-in gating ---
    {
      const rootRoute = mkdtempSync(join(lemmaTestDir, "root-route-"))
      const tools = await makeToolsFor(rootRoute)

      const positives = [
        "Prove Fermat's Little Theorem in Lean 4",
        "Verify src/Main.lean in Lean 4",
        "Verify Main.lean",
        "verify Foo.lean",
        "verify the proof in Foo.lean",
        "Formalize and prove this theorem in Lean",
        "Fill in the sorry in Lemma1.lean",
        "Fill in the `sorry` in Lemma1.lean",
      ]
      for (const req of positives) {
        const r = await tools.route.execute({ request: req })
        assert.strictEqual(r.route, "lemma", `expected lemma for "${req}", got ${r.route}`)
        assert.strictEqual(r.topology, "proof")
        assert.strictEqual(r.lemmaMode, true)
      }

      const nonOptInLean = [
        "Rename Lemma.lean to Helper.lean",
        "Explain what Foo.lean does",
        "Grep for sorry in src/Proof.lean",
        "Format and lint all .lean files",
        "Explain this snippet:\n```lean\n-- Prove theorem in Lean 4\ntheorem foo : 1 = 1 := by rfl\n```",
        "Explain:\n```lean\ntheorem foo : 1 = 1 := by rfl\n```",
        "import Mathlib\ntheorem t : 1 = 1 := by rfl",
        // V1.12–V1.17 regression cases
        "explain Foo.lean and also check the theorem statement in my notes",
        "check proof formatting in Foo.lean",
        "solve the build issue for Foo.lean",
        "prove that Foo.lean is in the repo",
        "Explain this partial snippet:\n```lean\n-- Prove theorem in Lean 4\ntheorem foo : 1 = 1 := by rfl",
        "Explain why the phrase `Prove this theorem in Lean 4` appears in Foo.lean",
        // N21 regression cases
        "verify Foo.lean formatting",
        "verify path/to/Bar.lean style",
        "check Foo.lean lint",
        "verify Foo.lean imports only",
        "verify the formatting of Foo.lean",
      ]
      for (const req of nonOptInLean) {
        const r = await tools.route.execute({ request: req })
        assert.strictEqual(r.route, "general", `non-opt-in Lean must route to general for "${req}", got ${r.route}`)
        assert.strictEqual(r.topology, "distributed-coding", `non-opt-in Lean must NOT route to proof: ${r.topology}`)
        assert.strictEqual(r.lemmaMode, false)
      }

      const lowercaseLean = await tools.route.execute({ request: "Build a lean microservice in Node.js" })
      assert.strictEqual(lowercaseLean.route, "general")
      assert.strictEqual(lowercaseLean.topology, "distributed-coding")
      assert.strictEqual(lowercaseLean.lemmaMode, false)

      const nlProof = await tools.route.execute({ request: "Prove that there are infinitely many primes" })
      assert.strictEqual(nlProof.route, "proof")
      assert.strictEqual(nlProof.topology, "proof")
      assert.strictEqual(nlProof.lemmaMode, false)

      // V1.18: natural-language proof with illustrative Lean fence stays `proof` (lemmaMode: false)
      const nlWithFence = await tools.route.execute({
        request: "Prove that ∀ n : Nat, n + 0 = n\n```lean\ntheorem helper : 1 = 1 := by rfl\n```",
      })
      assert.strictEqual(nlWithFence.route, "proof", `V1.18 must route to proof, got ${nlWithFence.route}`)
      assert.strictEqual(nlWithFence.topology, "proof")
      assert.strictEqual(nlWithFence.lemmaMode, false)

      const docReview = await tools.route.execute({
        request: "Review this Lean 4 formalization paper (paper.pdf)",
        document: { content: "A Lean 4 formalization paper about proofs." },
      })
      assert.strictEqual(docReview.route, "document-review")
      assert.strictEqual(docReview.topology, "document-review")
      assert.strictEqual(docReview.lemmaMode, false)
      const attachedDocReview = await tools.route.execute({
        request: "Summarize attached manuscript.tex on Lean proofs",
        document: { content: "A manuscript about Lean proofs." },
      })
      assert.strictEqual(attachedDocReview.route, "document-review")

      console.log("✓ 9.2 explicit opt-in gating & priority order verified")
    }

    // --- 9.3 Bounded lemma tree & formalization review gate ---
    {
      const stubBin = makeFullStubEnv("tree")
      process.env.PATH = `${stubBin}:${savedPath}`
      const rootTree = mkdtempSync(join(lemmaTestDir, "root-tree-"))
      const tools = await makeToolsFor(rootTree)
      const RUN = "20261018-000000-lemma-tree"

      const badBounds = await tools.plan.execute({
        sessionId: "20261018-000000-badbounds",
        topology: "proof",
        lemmaMode: true,
        lemmaBounds: { maxDepth: 99 },
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      assert(badBounds.content.startsWith("refused:"), "excessive lemmaBounds must be refused before mkdir")
      assert(!existsSync(join(rootTree, ".opencode")), "bad bounds refusal must create nothing")

      const okPlan = await tools.plan.execute({
        sessionId: RUN,
        topology: "proof",
        lemmaMode: true,
        route: "lemma",
        lemmaBounds: { maxDepth: 2, maxWidth: 2, maxNodes: 4, maxRetries: 2 },
        skipInterview: true,
        tasks: [{ id: "T1", agent: "team/proof-worker" }],
      })
      assert(okPlan.content.startsWith("Planned"), `stubbed LEMMA plan must succeed: ${okPlan.content}`)

      // Root node creation
      const rRoot = await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "root", statement: "main theorem" })
      assert(rRoot.node?.id === "root", `root create failed: ${rRoot.content}`)

      // Attempt before formalization APPROVE must fail
      const earlyAttempt = await tools.lemma_node.execute({
        sessionId: RUN,
        action: "attempt",
        lemmaId: "root",
        leanCode: "theorem main : 1 = 1 := by rfl",
      })
      assert(earlyAttempt.content.startsWith("refused:"), "attempt before Phase 0 APPROVE must be refused")

      // Failing draft blocks APPROVE
      const badDraft = await tools.lemma_formalize.execute({
        sessionId: RUN,
        action: "draft",
        leanCode: "SYNTAX_ERROR theorem bad",
      })
      assert.strictEqual(badDraft.compiled, false)
      const approveBad = await tools.lemma_formalize.execute({
        sessionId: RUN,
        action: "review_pre",
        verdict: "APPROVE",
        notes: "looks good",
      })
      assert(approveBad.content.startsWith("refused:"), "failed draft compilation must block APPROVE promotion")
      assert(!existsSync(join(rootTree, ".opencode", "teamwork", RUN, "lemma", "problem.lean")), "problem.lean must not exist before clean APPROVE")

      // Clean draft + REQUEST_CHANGES then APPROVE
      const okDraft = await tools.lemma_formalize.execute({
        sessionId: RUN,
        action: "draft",
        leanCode: "theorem main (n : Nat) : n + 0 = n := by sorry",
      })
      assert.strictEqual(okDraft.compiled, true)
      const reqChanges = await tools.lemma_formalize.execute({
        sessionId: RUN,
        action: "review_pre",
        verdict: "REQUEST_CHANGES",
        notes: "tighten type",
      })
      assert.strictEqual(reqChanges.promoted, false)
      const approveOk = await tools.lemma_formalize.execute({
        sessionId: RUN,
        action: "review_pre",
        verdict: "APPROVE",
        notes: "faithful",
      })
      assert.strictEqual(approveOk.promoted, true)
      assert(existsSync(join(rootTree, ".opencode", "teamwork", RUN, "lemma", "problem.lean")), "APPROVE must promote problem.lean")

      // Duplicate, unknown parent, width, depth, maxNodes, maxRetries checks
      const dup = await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "root" })
      assert(dup.content.startsWith("refused:"), "duplicate lemmaId must be refused")
      const unk = await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "c1", parentId: "missing" })
      assert(unk.content.startsWith("refused:"), "unknown parentId must be refused")

      await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "c1", parentId: "root" })
      await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "c2", parentId: "root" })
      const overWidth = await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "c3", parentId: "root" })
      assert(overWidth.content.startsWith("refused:"), "exceeding maxWidth must be refused")

      await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "d2", parentId: "c1" })
      const overNodes = await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "n5", parentId: "c2" })
      assert(overNodes.content.startsWith("refused:"), "exceeding maxNodes must be refused")

      // Check depth > maxDepth using a separate small run
      const RUN_D = "20261018-000000-lemma-depth"
      await tools.plan.execute({
        sessionId: RUN_D,
        topology: "proof",
        lemmaMode: true,
        lemmaBounds: { maxDepth: 1, maxWidth: 2, maxNodes: 6, maxRetries: 1 },
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      await tools.lemma_node.execute({ sessionId: RUN_D, action: "create", lemmaId: "root" })
      await tools.lemma_node.execute({ sessionId: RUN_D, action: "create", lemmaId: "d1", parentId: "root" })
      const overDepth = await tools.lemma_node.execute({ sessionId: RUN_D, action: "create", lemmaId: "d2", parentId: "d1" })
      assert(overDepth.content.startsWith("refused:"), "exceeding maxDepth must be refused")

      // Max retries check on RUN
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", leanCode: "theorem main : 1 = 1 := by rfl" })
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", leanCode: "theorem main : 1 = 1 := by rfl" })
      const overRetry = await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", leanCode: "theorem main : 1 = 1 := by rfl" })
      assert(overRetry.content.startsWith("refused:"), "exceeding maxRetries must be refused")

      // V3.14: verifyDraft: false after a compiled draft must invalidate draftVerification and refuse APPROVE
      const RUN_STALE = "20261018-000000-lemma-stale"
      await tools.plan.execute({
        sessionId: RUN_STALE,
        topology: "proof",
        lemmaMode: true,
        skipInterview: true,
        tasks: [{ id: "T1" }],
      })
      const goodFirst = await tools.lemma_formalize.execute({
        sessionId: RUN_STALE,
        action: "draft",
        leanCode: "theorem p : 1 = 1 := by sorry",
        verifyDraft: true,
      })
      assert.strictEqual(goodFirst.compiled, true)
      const unverifiedOverwrite = await tools.lemma_formalize.execute({
        sessionId: RUN_STALE,
        action: "draft",
        leanCode: "SYNTAX_ERROR theorem p : 1 = 1 := by sorry",
        verifyDraft: false,
      })
      assert.strictEqual(unverifiedOverwrite.compiled, false)
      const staleApproveRefused = await tools.lemma_formalize.execute({
        sessionId: RUN_STALE,
        action: "review_pre",
        verdict: "APPROVE",
        notes: "should refuse stale draft",
      })
      assert(staleApproveRefused.content.startsWith("refused:"), `stale draftVerification must refuse APPROVE: ${staleApproveRefused.content}`)

      // Out-of-band edit to problem_draft.lean after compiled draft must also refuse APPROVE (hash mismatch)
      await tools.lemma_formalize.execute({
        sessionId: RUN_STALE,
        action: "draft",
        leanCode: "theorem p : 1 = 1 := by sorry",
        verifyDraft: true,
      })
      writeFileSync(join(rootTree, ".opencode", "teamwork", RUN_STALE, "lemma", "problem_draft.lean"), "theorem tampered : False := by sorry\n", "utf8")
      const tamperRefused = await tools.lemma_formalize.execute({
        sessionId: RUN_STALE,
        action: "review_pre",
        verdict: "APPROVE",
        notes: "should refuse out-of-band edit",
      })
      assert(tamperRefused.content.startsWith("refused:"), `out-of-band problem_draft edit must refuse APPROVE: ${tamperRefused.content}`)

      console.log("✓ 9.3 bounded lemma tree & formalization review gate verified")
    }

    // --- 9.4 Stub-binary sorry/admit/axiom + exit-code + final_verify ---
    {
      // Unit check on comment & string stripping (nested block comments, line comments, string literals, axiom variants)
      const commented = `-- sorry\n/- outer /- sorry -/ admit -/\ntheorem ok : True := trivial`
      assert(!stripLeanComments(commented).includes("sorry"), "comments must be stripped cleanly")
      const cleanCommentHoles = detectLeanProofHoles(commented, "")
      assert.strictEqual(cleanCommentHoles.hasSorry, false)
      assert.strictEqual(cleanCommentHoles.hasAdmit, false)

      // V3.04: "sorry" inside string literals must NOT trigger a false positive
      const stringSorry = `def msg : String := "sorry, not a proof hole"\ntheorem ok : "sorry" = "sorry" := rfl`
      assert(!stripLeanCommentsAndStrings(stringSorry).includes("sorry"), "string literal contents must be stripped")
      const stringHoles = detectLeanProofHoles(stringSorry, "")
      assert.strictEqual(stringHoles.hasSorry, false, "string-literal 'sorry' must not trigger hasSorry")

      // V3.07–V3.12 + Auditor @[simp] axiom variants
      const axiomVariants = [
        "noncomputable axiom my_ax : False",
        "unsafe axiom my_ax : False",
        '@[extern "c_fn"] axiom my_ax : False',
        "@[simp] axiom my_ax : False",
        "def x := 1 axiom my_ax : False",
        "axiom «my_ax» : False",
        "axiom α_ax : False",
      ]
      for (const variant of axiomVariants) {
        const res = detectLeanProofHoles(variant, "")
        assert.strictEqual(res.hasUnauthorizedAxiom, true, `axiom variant must be flagged: ${variant}`)
      }
      assert.strictEqual(detectLeanProofHoles("axiom «my_ax» : False", "", ["my_ax"]).hasUnauthorizedAxiom, false, "allowedAxioms should normalize guillemets")

      const stubBin = makeFullStubEnv("verify")
      process.env.PATH = `${stubBin}:${savedPath}`
      const rootV = mkdtempSync(join(lemmaTestDir, "root-verify-"))
      const tools = await makeToolsFor(rootV)
      const RUN = "20261018-000000-lemma-verify"

      await tools.plan.execute({
        sessionId: RUN,
        topology: "proof",
        lemmaMode: true,
        lemmaBounds: { maxRetries: 4 },
        skipInterview: true,
        tasks: [{ id: "L1", agent: "team/proof-worker" }],
      })
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "review_pre", verdict: "APPROVE", notes: "ok" })
      await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "root", declaration: "t", statement: "1 = 1" })

      // V3.16: direct update to status: "disproved" without verification must be refused
      const directDisproved = await tools.lemma_node.execute({ sessionId: RUN, action: "update", lemmaId: "root", status: "disproved" })
      assert(directDisproved.content.startsWith("refused:"), `direct status=disproved must be refused: ${directDisproved.content}`)

      // (a) V3.01b / V3.02: stderr sorry/sorryAx warning on exit 0 with clean .lean text -> FAIL & stderr captured
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 1, leanCode: "-- COMPILER_SORRY_WARN\ntheorem t : 1 = 1 := by rfl" })
      const vSorry = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 1 })
      assert.strictEqual(vSorry.report.status, "FAIL", "stderr sorry warning on exit 0 must FAIL")
      assert.strictEqual(vSorry.report.exitCode, 0)
      assert.strictEqual(vSorry.report.hasSorry, true)
      assert(vSorry.report.stderr.includes("warning: declaration uses 'sorry'"), `stderr must be captured on exit 0: ${vSorry.report.stderr}`)

      const axTmpFile = join(rootV, "stderr-sorry-ax.lean")
      writeFileSync(axTmpFile, "-- STDERR_SORRY_AX\ntheorem t : 1 = 1 := by rfl\n", "utf8")
      const vSorryAx = verifyLeanFile({ filePath: axTmpFile, env: { ...process.env, PATH: `${stubBin}:${savedPath}` } })
      assert.strictEqual(vSorryAx.status, "FAIL", "stderr uses sorryAx on exit 0 must FAIL")
      assert.strictEqual(vSorryAx.hasSorry, true)
      assert(vSorryAx.stderr.includes("sorryAx"))

      // (b) admit & unauthorized axiom -> FAIL; a caller-supplied allowlist is refused.
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 2, leanCode: "@[simp] axiom bogus : False\ntheorem t : 1 = 1 := by admit" })
      const vAxWiden = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 2, allowedAxioms: ["other_ax"] })
      assert(vAxWiden.content.startsWith("refused:"), `caller-supplied allowedAxioms must be refused: ${vAxWiden.content}`)
      assert(!vAxWiden.report, "refused allowlist override must not emit a verify report")
      const vAx = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 2 })
      assert.strictEqual(vAx.report.status, "FAIL")
      assert.strictEqual(vAx.report.hasAdmit, true)
      assert.strictEqual(vAx.report.hasUnauthorizedAxiom, true)
      assert.deepStrictEqual(vAx.report.allowedAxioms, [], "legacy/no-policy manifest must record an empty configured allowlist (standard axioms only)")

      // (c) clean .lean text but lean exits 1 -> FAIL (never infer PASS from text!)
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 3, leanCode: "-- SYNTAX_ERROR\ntheorem t : 1 = 1 := by rfl" })
      const vExit1 = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 3 })
      assert.strictEqual(vExit1.report.status, "FAIL")
      assert.strictEqual(vExit1.report.exitCode, 1)

      // Satisfy DAG task + security audit so final_verify isolates LEMMA checks
      for (const st of ["worker_active", "worker_done", "verifier_active"]) {
        await tools.task_update.execute({ sessionId: RUN, taskId: "L1", status: st })
      }
      await tools.task_update.execute({ sessionId: RUN, taskId: "L1", status: "verified_pass", verification: { status: "PASS" } })
      const repFile = join(rootV, ".opencode", "teamwork", RUN, "verify", "report-L1.json")
      mkdirSync(dirname(repFile), { recursive: true })
      writeFileSync(repFile, JSON.stringify({ taskId: "L1", status: "PASS" }) + "\n")
      await tools.security_audit.execute({ sessionId: RUN, status: "PASS", findings: [] })

      // (d) clean .lean + exit 0 -> PASS, but without final FAITHFUL review final_verify must FAIL
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 4, leanCode: 'def msg : String := "sorry, not a hole"\ntheorem t : 1 = 1 := by rfl' })
      const vPass = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 4 })
      assert.strictEqual(vPass.report.status, "PASS", `string-literal sorry should PASS: ${JSON.stringify(vPass.report)}`)
      assert.strictEqual(vPass.report.executed, true)
      assert.strictEqual(vPass.report.exitCode, 0)

      const fvBeforeFaithful = await tools.final_verify.execute({ sessionId: RUN })
      assert.strictEqual(fvBeforeFaithful.status, "FAIL", "final_verify must FAIL without FAITHFUL final review")

      // (e) Tampering verify-4.json to executed: false -> final_verify FAIL
      const verify4File = join(rootV, ".opencode", "teamwork", RUN, "lemma", "nodes", "root", "verify-4.json")
      const savedVerify4 = readFileSync(verify4File, "utf8")
      const tampered = JSON.parse(savedVerify4)
      tampered.executed = false
      writeFileSync(verify4File, JSON.stringify(tampered, null, 2) + "\n")
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "review_final", verdict: "FAITHFUL", notes: "matches" })
      const fvTampered = await tools.final_verify.execute({ sessionId: RUN })
      assert.strictEqual(fvTampered.status, "FAIL", "unstamped executed:false verify report must FAIL final_verify")

      // Restore valid stamped verify-4.json
      writeFileSync(verify4File, savedVerify4)

      // V3.15: manifest.phase === "BLOCKED" must FAIL final_verify even when nodes & verify reports look clean
      const manifestFile = join(rootV, ".opencode", "teamwork", RUN, "lemma", "manifest.json")
      const savedManifest = readFileSync(manifestFile, "utf8")
      const blockedManifest = JSON.parse(savedManifest)
      blockedManifest.phase = "BLOCKED"
      writeFileSync(manifestFile, JSON.stringify(blockedManifest, null, 2) + "\n")
      const fvBlocked = await tools.final_verify.execute({ sessionId: RUN })
      assert.strictEqual(fvBlocked.status, "FAIL", "manifest.phase=BLOCKED must FAIL final_verify")

      // Restore valid manifest -> final_verify PASS with evidence.lemma
      writeFileSync(manifestFile, savedManifest)
      writeFileSync(verify4File, savedVerify4)
      const fvOk = await tools.final_verify.execute({ sessionId: RUN })
      assert.strictEqual(fvOk.status, "PASS", `valid LEMMA run must PASS final_verify: ${fvOk.content}`)
      const finalJson = JSON.parse(readFileSync(join(rootV, ".opencode", "teamwork", RUN, "verify", "final.json"), "utf8"))
      assert(finalJson.evidence?.lemma?.active === true, "verify/final.json must stamp evidence.lemma")
      assert.strictEqual(finalJson.evidence.lemma.finalVerdict, "FAITHFUL")

      // S6: final evidence must re-check stamped metadata against current nodes.
      const metaManifest = JSON.parse(savedManifest)
      metaManifest.nodes.root.statement = "2 = 2"
      writeFileSync(manifestFile, JSON.stringify(metaManifest, null, 2) + "\n")
      const fvMeta = await tools.final_verify.execute({ sessionId: RUN })
      assert.strictEqual(fvMeta.status, "FAIL", "changed node statement must FAIL final_verify")
      writeFileSync(manifestFile, savedManifest)

      for (const [label, mutate] of [
        ["declaration", (r) => (r.declaration = "other")],
        ["declarationType", (r) => (r.declarationType = "2 = 2")],
        ["axiomDependencies", (r) => (r.axiomDependencies = ["sorryAx"])],
        ["unauthorizedAxioms", (r) => (r.unauthorizedAxioms = ["evil_ax"])],
      ]) {
        const report = JSON.parse(savedVerify4)
        mutate(report)
        writeFileSync(verify4File, JSON.stringify(report, null, 2) + "\n")
        const fvReport = await tools.final_verify.execute({ sessionId: RUN })
        assert.strictEqual(fvReport.status, "FAIL", `tampered verify report ${label} must FAIL final_verify`)
        writeFileSync(verify4File, savedVerify4)
      }
      const fvRestored = await tools.final_verify.execute({ sessionId: RUN })
      assert.strictEqual(fvRestored.status, "PASS", "restored metadata must PASS final_verify again")
      console.log("✓ 9.4 stub-binary sorry/admit/axiom + exit-code + final_verify verified")
    }

    // --- 9.4b Proposition binding + transitive axiom dependencies ---
    {
      // Pure parsing/binding helper (no Lean required).
      const exactSrc = "theorem t : 1 = 1 := by rfl"
      const exactDecls = parseLeanDeclarations(exactSrc)
      assert.strictEqual(exactDecls.length, 1, "exactly one theorem declaration must be parsed")
      assert.strictEqual(exactDecls[0].name, "t")
      assert.strictEqual(exactDecls[0].normalizedType, "1 = 1")

      const exact = bindVerifiedDeclaration(exactSrc, { declaration: "t", statement: "1 = 1" })
      assert.strictEqual(exact.ok, true, `exact declaration must bind: ${exact.findings}`)

      const whitespace = bindVerifiedDeclaration("theorem t : 1   =   1 := by rfl", { declaration: "t", statement: "1 = 1" })
      assert.strictEqual(whitespace.ok, true, `whitespace-different type must bind: ${whitespace.findings}`)

      const multiline = parseLeanDeclarations("theorem add_zero_eq (n : Nat) :\n    n + 0 = n := by simp")
      assert.strictEqual(multiline[0].normalizedType, "(n : Nat) : n + 0 = n", "multiline type must keep binders and normalize newlines")
      assert.strictEqual(
        bindVerifiedDeclaration("theorem add_zero_eq (n : Nat) : n + 0 = n := by simp", {
          declaration: "add_zero_eq",
          statement: "(n : Nat) :\n  n + 0 = n",
        }).ok,
        true,
        "multiline whitespace differences must bind",
      )

      const wrongName = bindVerifiedDeclaration(exactSrc, { declaration: "other", statement: "1 = 1" })
      assert.strictEqual(wrongName.ok, false, "wrong declaration name must be rejected")
      assert(wrongName.findings.some((f) => f.includes("does not declare expected theorem/lemma")), wrongName.findings.join("; "))

      const wrongType = bindVerifiedDeclaration(exactSrc, { declaration: "t", statement: "2 = 2" })
      assert.strictEqual(wrongType.ok, false, "wrong statement type must be rejected")
      assert(wrongType.findings.some((f) => f.includes("does not match approved node statement")), wrongType.findings.join("; "))

      const missing = bindVerifiedDeclaration("def x : Nat := 1", { declaration: "t", statement: "1 = 1" })
      assert.strictEqual(missing.ok, false, "missing declaration must be rejected")
      assert(missing.findings.some((f) => f.includes("declares no theorem/lemma")), missing.findings.join("; "))

      const disproof = bindVerifiedDeclaration("theorem notP : ¬(1 = 2) := by omega", {
        declaration: "notP",
        statement: "1 = 2",
        disproof: true,
      })
      assert.strictEqual(disproof.ok, true, `disprove node must accept the declared negation: ${disproof.findings}`)
      assert.strictEqual(
        bindVerifiedDeclaration("theorem notP : ¬(1 = 2) := by omega", { declaration: "notP", statement: "1 = 2" }).ok,
        false,
        "disprove negation must not satisfy a proved node",
      )

      // Regression S1: declarations inside strings/quotations must not be seen.
      const stringSpoof = `def banner : String := "\ntheorem t : RH := by exact bogus\n"\ntheorem t : 1 = 1 := by rfl`
      const stringScan = analyzeLeanDeclarations(stringSpoof)
      assert.deepStrictEqual(stringScan.declarations.map((d) => d.name), ["t"], "only the real declaration may be parsed")
      assert.strictEqual(
        bindVerifiedDeclaration(stringSpoof, { declaration: "t", statement: "RH" }).ok,
        false,
        "a theorem inside a string literal must not satisfy binding",
      )
      assert.strictEqual(
        bindVerifiedDeclaration(stringSpoof, { declaration: "t", statement: "1 = 1" }).ok,
        true,
        "the real declaration must still bind",
      )

      const quoteSpoof = "`(theorem t : RH := by exact bogus)\ntheorem t : 1 = 1 := by rfl"
      assert.deepStrictEqual(
        analyzeLeanDeclarations(quoteSpoof).declarations.map((d) => d.name),
        ["t"],
        "a theorem inside a syntax quotation must not be parsed",
      )
      assert.strictEqual(bindVerifiedDeclaration(quoteSpoof, { declaration: "t", statement: "RH" }).ok, false)
      const tacticQuoteSpoof = "`(command| theorem t : RH := by exact bogus)\ntheorem t : 1 = 1 := by rfl"
      assert.deepStrictEqual(
        analyzeLeanDeclarations(tacticQuoteSpoof).declarations.map((d) => d.name),
        ["t"],
        "a category syntax quotation must not leak declarations",
      )
      assert.strictEqual(bindVerifiedDeclaration(tacticQuoteSpoof, { declaration: "t", statement: "RH" }).ok, false)
      assert.strictEqual(
        analyzeLeanDeclarations("`(theorem t : RH").errors.some((e) => e.includes("quotation")),
        true,
        "an undelimitable quotation must fail closed",
      )

      // Duplicate / namespace / private / protected declarations are ambiguous.
      const duplicateDecls = "theorem t : 1 = 1 := by rfl\ntheorem t : 2 = 2 := by rfl"
      const dupBind = bindVerifiedDeclaration(duplicateDecls, { declaration: "t", statement: "1 = 1" })
      assert.strictEqual(dupBind.ok, false, "duplicate declaration names must be rejected")
      assert(dupBind.findings.some((f) => f.includes("duplicate theorem/lemma")), dupBind.findings.join("; "))

      for (const source of [
        "namespace N\ntheorem t : 1 = 1 := by rfl\nend N",
        "section S\ntheorem t : 1 = 1 := by rfl\nend S",
        "private theorem t : 1 = 1 := by rfl",
        "private\ntheorem t : 1 = 1 := by rfl",
        "protected theorem t : 1 = 1 := by rfl",
      ]) {
        const res = bindVerifiedDeclaration(source, { declaration: "t", statement: "1 = 1" })
        assert.strictEqual(res.ok, false, `ambiguous scoped declaration must fail closed: ${source}`)
        assert(/namespace|section|private|protected/.test(res.findings.join(" ")), res.findings.join("; "))
      }

      // S8: negation spacing and binder/forall equivalence.
      const spacedNot = bindVerifiedDeclaration("theorem notP : ¬ (1 = 2) := by omega", {
        declaration: "notP",
        statement: "1 = 2",
        disproof: true,
      })
      assert.strictEqual(spacedNot.ok, true, `spaced negation must match: ${spacedNot.findings}`)
      const binderDisproof = bindVerifiedDeclaration(
        "theorem notAdd (n : Nat) : ¬ (n + 0 = n + 1) := by omega",
        { declaration: "notAdd", statement: "(n : Nat) : n + 0 = n + 1", disproof: true },
      )
      assert.strictEqual(binderDisproof.ok, true, `binder negation must match: ${binderDisproof.findings}`)
      const forallDisproof = bindVerifiedDeclaration(
        "theorem notForall : Not (∀ n : Nat, n = n + 1) := by omega",
        { declaration: "notForall", statement: "(n : Nat) : n = n + 1", disproof: true },
      )
      assert.strictEqual(forallDisproof.ok, true, `forall negation must match: ${forallDisproof.findings}`)
      assert.strictEqual(leanStatementMatches("(n : Nat) : n = n", "∀ n : Nat, n = n"), true)
      assert.strictEqual(
        bindVerifiedDeclaration("theorem refl (n : Nat) : n = n := by rfl", {
          declaration: "refl",
          statement: "∀ n : Nat, n = n",
        }).ok,
        true,
        "binder type must match its forall spelling",
      )

      // S2: only one exact-line report for the expected declaration is accepted.
      const noAx = parseLeanAxiomOutput("'t' does not depend on any axioms", [], "t")
      assert.strictEqual(noAx.recognized, true)
      assert.deepStrictEqual(noAx.unauthorized, [])
      const standardAx = parseLeanAxiomOutput("'t' depends on axioms: [propext, Classical.choice, Quot.sound]", [], "t")
      assert.deepStrictEqual(standardAx.unauthorized, [], "standard Lean axioms must be allowed")
      const sorryAllowed = parseLeanAxiomOutput("'t' depends on axioms: [sorryAx, propext]", ["sorryAx"], "t")
      assert.deepStrictEqual(sorryAllowed.unauthorized, ["sorryAx"], "sorryAx must never be allowlisted")
      assert.strictEqual(parseLeanAxiomOutput("'t' depends on axioms: [my_ax]", [], "t").unauthorized[0], "my_ax")
      assert.deepStrictEqual(parseLeanAxiomOutput("'t' depends on axioms: [my_ax]", ["my_ax"], "t").unauthorized, [])
      assert.strictEqual(parseLeanAxiomOutput("unparseable output", [], "t").recognized, false)
      assert.strictEqual(parseLeanAxiomOutput("'t' depends on axioms: [propext]", [], "").recognized, false, "missing declaration name must fail closed")

      const spoofedAx = parseLeanAxiomOutput(
        "'t' depends on axioms: [propext, Classical.choice, Quot.sound]\n't' depends on axioms: [sorryAx]",
        [],
        "t",
      )
      assert.strictEqual(spoofedAx.recognized, false, "a spoofed clean line before the real report must fail closed")
      assert(spoofedAx.findings.some((f) => /reports for "t"/.test(f)), spoofedAx.findings.join("; "))

      const foreignAx = parseLeanAxiomOutput("'u' depends on axioms: [propext]", [], "t")
      assert.strictEqual(foreignAx.recognized, false, "a report for a different declaration must fail closed")

      const duplicateAx = parseLeanAxiomOutput(
        "'t' depends on axioms: [propext]\n't' depends on axioms: [propext]",
        [],
        "t",
      )
      assert.strictEqual(duplicateAx.recognized, false, "multiple reports for the expected declaration must fail closed")

      const wrappedAx = parseLeanAxiomOutput("'t' depends on axioms: [propext,\n Classical.choice]", [], "t")
      assert.strictEqual(wrappedAx.recognized, false, "a malformed/wrapped report must fail closed")

      // Probe-hijacking commands are rejected before the probe is appended.
      for (const src of [
        '#eval "spoof"',
        "#check 1",
        "#print axioms t",
        "#exit",
        'def x := logInfo "spoof"',
        'def x := dbg_trace "spoof"',
        'def x := IO.println "spoof"',
        'def x := println "spoof"',
        "set_option trace.Meta true",
      ]) {
        const findings = detectAxiomProbeHijacks(src)
        assert(findings.length > 0, `hijack source must be rejected: ${src}`)
        assert(findings[0].includes("probe-hijacking"), findings[0])
      }
      assert.deepStrictEqual(detectAxiomProbeHijacks("theorem t : 1 = 1 := by rfl"), [], "a plain proof has no hijack")
      assert.deepStrictEqual(
        detectAxiomProbeHijacks('def msg : String := "#eval spoof"'),
        [],
        "hijack text inside a string literal must not trigger",
      )

      // Toolchain absent: the axiom probe must fail closed, never PASS.
      const axTmpDir = mkdtempSync(join(lemmaTestDir, "axiom-notool-"))
      const axTmpFile = join(axTmpDir, "attempt.lean")
      writeFileSync(axTmpFile, exactSrc + "\n", "utf8")
      const noToolAx = checkLeanAxiomDependencies({
        filePath: axTmpFile,
        declaration: "t",
        cwd: axTmpDir,
        env: { PATH: "" },
      })
      assert.strictEqual(noToolAx.executed, false, "axiom check must fail closed without lean")
      assert(noToolAx.check.findings.some((f) => f.includes("not found on PATH")), "missing toolchain must be reported")
      assert(!noToolAx.check.recognized, "failed axiom probe must not be treated as recognized")

      const stubBin = makeFullStubEnv("binding")
      process.env.PATH = `${stubBin}:${savedPath}`
      const rootB = mkdtempSync(join(lemmaTestDir, "root-binding-"))
      const tools = await makeToolsFor(rootB)
      const setupRun = async (RUN, { lemmaPolicy, maxRetries = 4 } = {}) => {
        await tools.plan.execute({
          sessionId: RUN,
          topology: "proof",
          lemmaMode: true,
          lemmaBounds: { maxRetries },
          ...(lemmaPolicy ? { lemmaPolicy } : {}),
          skipInterview: true,
          tasks: [{ id: "L1", agent: "team/proof-worker" }],
        })
        await tools.lemma_formalize.execute({ sessionId: RUN, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
        await tools.lemma_formalize.execute({ sessionId: RUN, action: "review_pre", verdict: "APPROVE", notes: "ok" })
        await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "root", declaration: "t", statement: "1 = 1" })
      }

      // The problem.lean fallback must be unique; ambiguous problems fail closed.
      const RUN_FALLBACK = "20261018-000000-lemma-fallback"
      await tools.plan.execute({
        sessionId: RUN_FALLBACK,
        topology: "proof",
        lemmaMode: true,
        skipInterview: true,
        tasks: [{ id: "L1", agent: "team/proof-worker" }],
      })
      await tools.lemma_formalize.execute({ sessionId: RUN_FALLBACK, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
      await tools.lemma_formalize.execute({ sessionId: RUN_FALLBACK, action: "review_pre", verdict: "APPROVE", notes: "ok" })
      await tools.lemma_node.execute({ sessionId: RUN_FALLBACK, action: "create", lemmaId: "root", statement: "1 = 1" })
      await tools.lemma_node.execute({ sessionId: RUN_FALLBACK, action: "attempt", lemmaId: "root", leanCode: "theorem t : 1 = 1 := by rfl" })
      const vFallback = await tools.lemma_verify.execute({ sessionId: RUN_FALLBACK, lemmaId: "root" })
      assert.strictEqual(vFallback.report.status, "PASS", `unique problem.lean fallback must bind: ${JSON.stringify(vFallback.report)}`)
      assert.strictEqual(vFallback.report.declaration, "t")

      const RUN_AMBIG = "20261018-000000-lemma-ambiguous-problem"
      await tools.plan.execute({
        sessionId: RUN_AMBIG,
        topology: "proof",
        lemmaMode: true,
        skipInterview: true,
        tasks: [{ id: "L1", agent: "team/proof-worker" }],
      })
      await tools.lemma_formalize.execute({
        sessionId: RUN_AMBIG,
        action: "draft",
        leanCode: "theorem a : 1 = 1 := by sorry\ntheorem b : 1 = 1 := by sorry",
      })
      await tools.lemma_formalize.execute({ sessionId: RUN_AMBIG, action: "review_pre", verdict: "APPROVE", notes: "ok" })
      await tools.lemma_node.execute({ sessionId: RUN_AMBIG, action: "create", lemmaId: "root", statement: "1 = 1" })
      await tools.lemma_node.execute({ sessionId: RUN_AMBIG, action: "attempt", lemmaId: "root", leanCode: "theorem a : 1 = 1 := by rfl" })
      const vAmbiguous = await tools.lemma_verify.execute({ sessionId: RUN_AMBIG, lemmaId: "root" })
      assert.strictEqual(vAmbiguous.report.status, "FAIL", "ambiguous problem.lean must fail closed")
      assert(
        vAmbiguous.report.findings.some((f) => f.includes("declares 2 theorem/lemmas")),
        `ambiguous fallback finding missing: ${JSON.stringify(vAmbiguous.report.findings)}`,
      )

      const RUN = "20261018-000000-lemma-binding"
      await setupRun(RUN)
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 1, leanCode: "theorem other : 1 = 1 := by rfl" })
      const vWrongName = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 1 })
      assert.strictEqual(vWrongName.report.status, "FAIL", "a valid but differently named theorem must not pass")
      assert(
        vWrongName.report.findings.some((f) => f.includes("does not declare expected theorem/lemma")),
        `wrong-name finding missing: ${JSON.stringify(vWrongName.report.findings)}`,
      )

      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 2, leanCode: "theorem t : 2 = 2 := by rfl" })
      const vWrongType = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 2 })
      assert.strictEqual(vWrongType.report.status, "FAIL", "a valid theorem with the wrong type must not pass")
      assert(
        vWrongType.report.findings.some((f) => f.includes("does not match approved node statement")),
        `wrong-type finding missing: ${JSON.stringify(vWrongType.report.findings)}`,
      )

      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 3, leanCode: "theorem t : 1  =  1 := by rfl" })
      const vWhitespace = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 3 })
      assert.strictEqual(vWhitespace.report.status, "PASS", `whitespace-only type difference must PASS: ${JSON.stringify(vWhitespace.report)}`)
      assert.strictEqual(vWhitespace.report.declaration, "t")
      assert.deepStrictEqual(vWhitespace.report.unauthorizedAxioms, [])
      assert(vWhitespace.node.status === "proved", "bound declaration must mark the node proved")

      // S6: metadata is immutable after a PASS; require an explicit reset first.
      const mutateStatement = await tools.lemma_node.execute({
        sessionId: RUN,
        action: "update",
        lemmaId: "root",
        statement: "2 = 2",
      })
      assert(mutateStatement.content.startsWith("refused:"), `statement mutation after PASS must be refused: ${mutateStatement.content}`)
      assert(/reset it to "formal"/i.test(mutateStatement.content), "refusal must explain the explicit reset")
      const mutateDeclaration = await tools.lemma_node.execute({
        sessionId: RUN,
        action: "update",
        lemmaId: "root",
        declaration: "other",
      })
      assert(mutateDeclaration.content.startsWith("refused:"), `declaration mutation after PASS must be refused: ${mutateDeclaration.content}`)
      const sameMetadata = await tools.lemma_node.execute({
        sessionId: RUN,
        action: "update",
        lemmaId: "root",
        statement: "1 = 1",
        declaration: "t",
      })
      assert(!sameMetadata.content.startsWith("refused:"), `rewriting identical metadata must stay allowed: ${sameMetadata.content}`)

      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 4, leanCode: "-- AXIOM_SORRY_DEP\ntheorem t : 1 = 1 := by rfl" })
      const vTransitiveSorry = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 4 })
      assert.strictEqual(vTransitiveSorry.report.status, "FAIL", "transitive sorryAx must FAIL even with a clean source text")
      assert.strictEqual(vTransitiveSorry.report.hasSorry, true, "transitive sorryAx must set hasSorry")
      assert(vTransitiveSorry.report.unauthorizedAxioms.includes("sorryAx"), "transitive sorryAx must be reported")

      const RUN_AX = "20261018-000000-lemma-axioms"
      await setupRun(RUN_AX, { lemmaPolicy: { allowedAxioms: ["my_custom_ax"] }, maxRetries: 2 })
      await tools.lemma_node.execute({ sessionId: RUN_AX, action: "attempt", lemmaId: "root", round: 1, leanCode: "-- AXIOM_BAD_DEP\ntheorem t : 1 = 1 := by rfl" })
      const vBadAx = await tools.lemma_verify.execute({ sessionId: RUN_AX, lemmaId: "root", round: 1 })
      assert.strictEqual(vBadAx.report.status, "FAIL", "unauthorized transitive axiom must FAIL")
      assert(vBadAx.report.unauthorizedAxioms.includes("my_evil_ax"), "unauthorized dependency must be reported")
      assert.strictEqual(vBadAx.report.hasUnauthorizedAxiom, true)

      await tools.lemma_node.execute({ sessionId: RUN_AX, action: "attempt", lemmaId: "root", round: 2, leanCode: "-- AXIOM_CUSTOM_DEP\ntheorem t : 1 = 1 := by rfl" })
      const vAllowedAx = await tools.lemma_verify.execute({
        sessionId: RUN_AX,
        lemmaId: "root",
        round: 2,
      })
      assert.strictEqual(vAllowedAx.report.status, "PASS", `manifest-allowlisted transitive axiom must PASS: ${JSON.stringify(vAllowedAx.report)}`)
      assert(vAllowedAx.report.axiomDependencies.includes("my_custom_ax"))
      assert.deepStrictEqual(vAllowedAx.report.unauthorizedAxioms, [])
      assert.deepStrictEqual(vAllowedAx.report.allowedAxioms, ["my_custom_ax"], "verify report must record the manifest-approved allowlist")

      // S2 E2E: a printing command in the attempt must stop the probe.
      const RUN_HIJACK = "20261018-000000-lemma-hijack"
      await setupRun(RUN_HIJACK, { maxRetries: 1 })
      await tools.lemma_node.execute({
        sessionId: RUN_HIJACK,
        action: "attempt",
        lemmaId: "root",
        round: 1,
        leanCode: '#eval "spoof"\ntheorem t : 1 = 1 := by rfl',
      })
      const vHijack = await tools.lemma_verify.execute({ sessionId: RUN_HIJACK, lemmaId: "root", round: 1 })
      assert.strictEqual(vHijack.report.status, "FAIL", "probe-hijacking command must FAIL")
      assert(
        vHijack.report.findings.some((f) => f.includes("probe-hijacking")),
        `hijack finding missing: ${JSON.stringify(vHijack.report.findings)}`,
      )

      console.log("✓ 9.4b declaration binding + transitive axiom dependencies verified")
    }

    // --- 9.4c Plan-time axiom policy owns the transitive-axiom allowlist ---
    {
      // Pure validation: dedupe/guillemets, cap, safe names, sorryAx.
      const goodPolicy = validateLemmaPolicy({ allowedAxioms: ["my_custom_ax", "my_custom_ax", "«other_ax»"] })
      assert.strictEqual(goodPolicy.error, undefined, `valid policy must pass: ${goodPolicy.error}`)
      assert.deepStrictEqual(goodPolicy.policy.allowedAxioms, ["my_custom_ax", "other_ax"], "policy must dedupe and strip guillemets")
      const badPolicies = [
        { label: "sorryAx", policy: { allowedAxioms: ["sorryAx"] }, pattern: /sorryAx/ },
        { label: "unsafe name", policy: { allowedAxioms: ["bad name"] }, pattern: /safe Lean axiom name/ },
        { label: "unsafe guillemet payload", policy: { allowedAxioms: ["«bad name»"] }, pattern: /safe Lean axiom name/ },
        { label: "empty entry", policy: { allowedAxioms: [""] }, pattern: /non-empty/ },
        { label: "over cap", policy: { allowedAxioms: Array.from({ length: 33 }, (_, i) => `ax_${i}`) }, pattern: /max 32/ },
      ]
      for (const { label, policy, pattern } of badPolicies) {
        const rejected = validateLemmaPolicy(policy)
        assert(rejected.error && pattern.test(rejected.error), `${label} policy must be rejected: ${rejected.error}`)
      }

      const stubBin = makeFullStubEnv("policy")
      process.env.PATH = `${stubBin}:${savedPath}`
      const rootP = mkdtempSync(join(lemmaTestDir, "root-policy-"))
      const tools = await makeToolsFor(rootP)
      const RUN = "20261018-000000-lemma-policy"
      const planPolicy = { allowedAxioms: ["my_custom_ax"] }
      const planArgs = {
        sessionId: RUN,
        topology: "proof",
        lemmaMode: true,
        lemmaPolicy: planPolicy,
        lemmaBounds: { maxRetries: 4 },
        skipInterview: true,
        tasks: [{ id: "L1", agent: "team/proof-worker" }],
      }
      const p1 = await tools.plan.execute(planArgs)
      assert(p1.content.startsWith("Planned"), `policy plan must succeed: ${p1.content}`)
      const manifestFile = join(rootP, ".opencode", "teamwork", RUN, "lemma", "manifest.json")
      const plannedManifest = JSON.parse(readFileSync(manifestFile, "utf8"))
      assert.deepStrictEqual(plannedManifest.policy, { version: 1, allowedAxioms: ["my_custom_ax"] }, "plan must persist the approved policy")

      // Re-plan with a different allowlist must refuse; the identical policy is idempotent.
      const replanDenied = await tools.plan.execute({ ...planArgs, lemmaPolicy: { allowedAxioms: ["other_ax"] } })
      assert(replanDenied.content.startsWith("refused:"), `different re-plan policy must be refused: ${replanDenied.content}`)
      assert(/lemmaPolicy conflicts/.test(replanDenied.content), "refusal must name the policy conflict")
      const replanSame = await tools.plan.execute({ ...planArgs })
      assert(!replanSame.content.startsWith("refused:"), `identical re-plan policy must be accepted: ${replanSame.content}`)
      const afterReplan = JSON.parse(readFileSync(manifestFile, "utf8"))
      assert.deepStrictEqual(afterReplan.policy, plannedManifest.policy, "re-plan must not silently change the persisted policy")

      // sorryAx can never be approved at plan time; refusal writes zero files.
      const RUN_SORRY = "20261018-000000-lemma-policy-sorry"
      const planSorry = await tools.plan.execute({
        ...planArgs,
        sessionId: RUN_SORRY,
        lemmaPolicy: { allowedAxioms: ["sorryAx"] },
      })
      assert(planSorry.content.startsWith("refused:"), `sorryAx policy must be refused: ${planSorry.content}`)
      assert(!existsSync(join(rootP, ".opencode", "teamwork", RUN_SORRY)), "refused policy plan must create zero dirs")

      // Legacy manifest (no policy) fails closed to the standard axiom set.
      const RUN_LEGACY = "20261018-000000-lemma-policy-legacy"
      await tools.plan.execute({
        ...planArgs,
        sessionId: RUN_LEGACY,
        lemmaPolicy: undefined,
      })
      const legacyManifestFile = join(rootP, ".opencode", "teamwork", RUN_LEGACY, "lemma", "manifest.json")
      const legacyManifest = JSON.parse(readFileSync(legacyManifestFile, "utf8"))
      delete legacyManifest.policy
      writeFileSync(legacyManifestFile, JSON.stringify(legacyManifest, null, 2) + "\n")
      await tools.lemma_formalize.execute({ sessionId: RUN_LEGACY, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
      await tools.lemma_formalize.execute({ sessionId: RUN_LEGACY, action: "review_pre", verdict: "APPROVE", notes: "ok" })
      await tools.lemma_node.execute({ sessionId: RUN_LEGACY, action: "create", lemmaId: "root", declaration: "t", statement: "1 = 1" })
      await tools.lemma_node.execute({ sessionId: RUN_LEGACY, action: "attempt", lemmaId: "root", round: 1, leanCode: "-- AXIOM_CUSTOM_DEP\ntheorem t : 1 = 1 := by rfl" })
      const legacyCustom = await tools.lemma_verify.execute({ sessionId: RUN_LEGACY, lemmaId: "root", round: 1 })
      assert.strictEqual(legacyCustom.report.status, "FAIL", "legacy manifest must not allow a configured custom axiom")
      assert(legacyCustom.report.unauthorizedAxioms.includes("my_custom_ax"), "legacy manifest must reject the custom axiom")
      await tools.lemma_node.execute({ sessionId: RUN_LEGACY, action: "attempt", lemmaId: "root", round: 2, leanCode: "theorem t : 1 = 1 := by rfl" })
      const legacyStandard = await tools.lemma_verify.execute({ sessionId: RUN_LEGACY, lemmaId: "root", round: 2 })
      assert.strictEqual(legacyStandard.report.status, "PASS", `standard axiom proof must PASS on a legacy manifest: ${JSON.stringify(legacyStandard.report)}`)
      assert.deepStrictEqual(legacyStandard.report.allowedAxioms, [], "legacy manifest must report an empty configured allowlist")

      // A forged verify report cannot widen the approved policy at final verification.
      const RUN_FINAL = "20261018-000000-lemma-policy-final"
      await tools.plan.execute({ ...planArgs, sessionId: RUN_FINAL })
      await tools.lemma_formalize.execute({ sessionId: RUN_FINAL, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
      await tools.lemma_formalize.execute({ sessionId: RUN_FINAL, action: "review_pre", verdict: "APPROVE", notes: "ok" })
      await tools.lemma_node.execute({ sessionId: RUN_FINAL, action: "create", lemmaId: "root", declaration: "t", statement: "1 = 1" })
      await tools.lemma_node.execute({ sessionId: RUN_FINAL, action: "attempt", lemmaId: "root", round: 1, leanCode: "-- AXIOM_CUSTOM_DEP\ntheorem t : 1 = 1 := by rfl" })
      const policyPass = await tools.lemma_verify.execute({ sessionId: RUN_FINAL, lemmaId: "root", round: 1 })
      assert.strictEqual(policyPass.report.status, "PASS", `approved custom axiom must PASS: ${JSON.stringify(policyPass.report)}`)

      // Task transitions are a serial state machine, so await each one in order.
      const advanceTask = (status) =>
        tools.task_update.execute({ sessionId: RUN_FINAL, taskId: "L1", status })
      await advanceTask("worker_active")
      await advanceTask("worker_done")
      await advanceTask("verifier_active")
      await tools.task_update.execute({ sessionId: RUN_FINAL, taskId: "L1", status: "verified_pass", verification: { status: "PASS" } })
      const finalRepFile = join(rootP, ".opencode", "teamwork", RUN_FINAL, "verify", "report-L1.json")
      mkdirSync(dirname(finalRepFile), { recursive: true })
      writeFileSync(finalRepFile, JSON.stringify({ taskId: "L1", status: "PASS" }) + "\n")
      await tools.security_audit.execute({ sessionId: RUN_FINAL, status: "PASS", findings: [] })
      await tools.lemma_formalize.execute({ sessionId: RUN_FINAL, action: "review_final", verdict: "FAITHFUL", notes: "matches" })
      const fvPolicyOk = await tools.final_verify.execute({ sessionId: RUN_FINAL })
      assert.strictEqual(fvPolicyOk.status, "PASS", `approved policy run must PASS final_verify: ${fvPolicyOk.content}`)

      const finalManifestFile = join(rootP, ".opencode", "teamwork", RUN_FINAL, "lemma", "manifest.json")
      const finalVerifyFile = join(rootP, ".opencode", "teamwork", RUN_FINAL, "lemma", "nodes", "root", "verify-1.json")
      const savedFinalManifest = readFileSync(finalManifestFile, "utf8")
      const savedFinalVerify = readFileSync(finalVerifyFile, "utf8")

      const widenedReport = JSON.parse(savedFinalVerify)
      widenedReport.allowedAxioms = ["my_custom_ax", "my_evil_ax"]
      writeFileSync(finalVerifyFile, JSON.stringify(widenedReport, null, 2) + "\n")
      const fvWidened = await tools.final_verify.execute({ sessionId: RUN_FINAL })
      assert.strictEqual(fvWidened.status, "FAIL", "a report that widens allowedAxioms must FAIL final_verify")

      const forgedDeps = JSON.parse(savedFinalVerify)
      forgedDeps.allowedAxioms = ["my_custom_ax", "my_evil_ax"]
      forgedDeps.axiomDependencies = ["my_evil_ax"]
      writeFileSync(finalVerifyFile, JSON.stringify(forgedDeps, null, 2) + "\n")
      const fvForgedDeps = await tools.final_verify.execute({ sessionId: RUN_FINAL })
      assert.strictEqual(fvForgedDeps.status, "FAIL", "forged axiomDependencies must FAIL final_verify")

      // Removing the policy from the manifest narrows the gate; the stamped
      // report (still listing the custom axiom) must no longer match.
      const manifestNoPolicy = JSON.parse(savedFinalManifest)
      delete manifestNoPolicy.policy
      writeFileSync(finalManifestFile, JSON.stringify(manifestNoPolicy, null, 2) + "\n")
      writeFileSync(finalVerifyFile, savedFinalVerify)
      const fvPolicyRemoved = await tools.final_verify.execute({ sessionId: RUN_FINAL })
      assert.strictEqual(fvPolicyRemoved.status, "FAIL", "removed manifest policy must invalidate the stamped allowlist")

      writeFileSync(finalManifestFile, savedFinalManifest)
      writeFileSync(finalVerifyFile, savedFinalVerify)
      const fvPolicyRestored = await tools.final_verify.execute({ sessionId: RUN_FINAL })
      assert.strictEqual(fvPolicyRestored.status, "PASS", "restored policy and report must PASS final_verify again")

      console.log("✓ 9.4c plan-time axiom policy owns the allowlist (caller overrides refused, legacy fails closed, forged reports rejected)")
    }

    // --- 9.5 Security containment ---
    {
      const stubBin = makeFullStubEnv("sec")
      process.env.PATH = `${stubBin}:${savedPath}`
      const rootSec = mkdtempSync(join(lemmaTestDir, "root-sec-"))
      const tools = await makeToolsFor(rootSec)
      const RUN = "20261018-000000-lemma-sec"
      await tools.plan.execute({
        sessionId: RUN,
        topology: "proof",
        lemmaMode: true,
        skipInterview: true,
        tasks: [{ id: "L1" }],
      })

      for (const badId of ["../escape", "a/b", ".", "..", "", "a".repeat(65)]) {
        const r = await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: badId })
        assert(r.content.startsWith("refused:"), `unsafe lemmaId ${JSON.stringify(badId)} must be refused: ${r.content}`)
      }

      // Control char sanitization in formalization notes
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "review_pre", verdict: "APPROVE", notes: "ok\x1b[31m\nline\u0085" })
      const rev = JSON.parse(readFileSync(join(rootSec, ".opencode", "teamwork", RUN, "lemma", "formalization-review.json"), "utf8"))
      assert(!/[\x00-\x1f\x7f-\x9f\u0085]/.test(rev.preSearch.notes), "control chars must be stripped from review notes")

      // Symlinked lemma/ dir refused
      const outside = mkdtempSync(join(lemmaTestDir, "outside-"))
      const RUN_SYM = "20261018-000000-lemma-sym"
      const runSymDir = join(rootSec, ".opencode", "teamwork", RUN_SYM)
      mkdirSync(runSymDir, { recursive: true })
      symlinkSync(outside, join(runSymDir, "lemma"))
      const symRes = await tools.lemma_node.execute({ sessionId: RUN_SYM, action: "create", lemmaId: "root" })
      assert(symRes.content.startsWith("refused:"), `symlinked lemma/ must be refused: ${symRes.content}`)

      // Reviewer Finding 4: symlinked cwd in lemma_verify must be refused via realpathSync/lstatSync containment
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "draft", leanCode: "theorem t : 1 = 1 := by sorry" })
      await tools.lemma_formalize.execute({ sessionId: RUN, action: "review_pre", verdict: "APPROVE", notes: "ok" })
      await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "root", declaration: "t", statement: "1 = 1" })
      await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 1, leanCode: "theorem t : 1 = 1 := by rfl" })
      symlinkSync(outside, join(rootSec, "escape-cwd"))
      const symCwdRes = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 1, cwd: "escape-cwd" })
      assert(symCwdRes.content.startsWith("refused:"), `symlinked cwd must be refused: ${symCwdRes.content}`)
      mkdirSync(join(rootSec, "lean-sub"), { recursive: true })
      const okCwdRes = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 1, cwd: "lean-sub" })
      assert.strictEqual(okCwdRes.report?.status, "PASS", `valid subdir cwd must succeed: ${okCwdRes.content}`)

      console.log("✓ 9.5 security containment (LEMMA_ID, symlink, sanitization) verified")
    }

    // --- 9.6 Loud-skipping real-toolchain E2E check ---
    {
      process.env.PATH = savedPath
      const hostProbe = probeLemmaToolchain({ env: { ...process.env, PATH: savedPath } })
      if (!hostProbe.ready) {
        console.log(`[SKIP] LEMMA live-toolchain E2E skipped: missing host binaries (${hostProbe.missing.join(", ")})`)
      } else {
        const rootLive = mkdtempSync(join(lemmaTestDir, "root-live-"))
        const tools = await makeToolsFor(rootLive)
        const RUN = "20261018-000000-lemma-live"
        const planLive = await tools.plan.execute({
          sessionId: RUN,
          topology: "proof",
          lemmaMode: true,
          skipInterview: true,
          tasks: [{ id: "L1", agent: "team/proof-worker" }],
        })
        assert(planLive.content.startsWith("Planned"))
        await tools.lemma_formalize.execute({ sessionId: RUN, action: "draft", leanCode: "theorem add_zero_eq (n : Nat) : n + 0 = n := by sorry" })
        await tools.lemma_formalize.execute({ sessionId: RUN, action: "review_pre", verdict: "APPROVE", notes: "faithful" })
        await tools.lemma_node.execute({ sessionId: RUN, action: "create", lemmaId: "root", declaration: "add_zero_eq", statement: "(n : Nat) : n + 0 = n" })
        await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 1, leanCode: "theorem add_zero_eq (n : Nat) : n + 0 = n := by sorry" })
        const liveSorry = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 1 })
        assert.strictEqual(liveSorry.report.status, "FAIL", "live Lean sorry must FAIL")
        await tools.lemma_node.execute({ sessionId: RUN, action: "attempt", lemmaId: "root", round: 2, leanCode: "theorem add_zero_eq (n : Nat) : n + 0 = n := by simp" })
        const liveOk = await tools.lemma_verify.execute({ sessionId: RUN, lemmaId: "root", round: 2 })
        assert.strictEqual(liveOk.report.status, "PASS", "live Lean proof must PASS")
        console.log("✓ 9.6 live Lean 4 E2E verification passed")
      }
    }
  } finally {
    process.env.PATH = savedPath
    rmSync(lemmaTestDir, { recursive: true, force: true })
  }
}

// Part 10: PR #10 review regressions
// ==========================================
{
  console.log("Testing PR #10 review regressions (FIFO refusal, tilde fences, clean, routing edges)...")

  // --- 10.1 readBoundedRunFile must refuse a FIFO instead of blocking forever.
  // A regression would hang the process synchronously, so run it in a child
  // with a hard timeout that kills the child and fails the suite.
  const tournamentUrl = new URL("../plugins/opencode-teamwork/tournament.ts", import.meta.url).href
  const fifoCode = [
    `import { readBoundedRunFile } from ${JSON.stringify(tournamentUrl)}`,
    `import { execFileSync } from "node:child_process"`,
    `import { mkdtempSync, rmSync } from "node:fs"`,
    `import { tmpdir } from "node:os"`,
    `import { join } from "node:path"`,
    `const dir = mkdtempSync(join(tmpdir(), "teamwork-fifo-"))`,
    `let made = true`,
    `try {`,
    `  execFileSync("mkfifo", [join(dir, "manifest.json")], { stdio: "ignore" })`,
    `} catch (err) {`,
    `  if (err && err.code === "ENOENT") made = false; else throw err`,
    `}`,
    `try {`,
    `  if (!made) {`,
    `    console.log("SKIP: mkfifo unavailable")`,
    `  } else {`,
    `    const res = readBoundedRunFile(dir, join(dir, "manifest.json"), 4096)`,
    `    if (res.status !== "error") throw new Error("expected refusal, got " + JSON.stringify(res))`,
    `    if (typeof res.error !== "string" || !/refused|not a regular file/i.test(res.error)) {`,
    `      throw new Error("refusal must name the reason: " + JSON.stringify(res))`,
    `    }`,
    `    console.log("REFUSED")`,
    `  }`,
    `} finally {`,
    `  rmSync(dir, { recursive: true, force: true })`,
    `}`,
  ].join("\n")
  const fifoRun = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", fifoCode], {
    encoding: "utf8",
    timeout: 15000,
  })
  if (fifoRun.error && fifoRun.error.code === "ETIMEDOUT") {
    assert.fail("readBoundedRunFile hung on a FIFO (timeout guard fired)")
  }
  assert.strictEqual(
    fifoRun.status,
    0,
    `FIFO child failed (status ${fifoRun.status}, signal ${fifoRun.signal}): ${fifoRun.stderr || ""}`,
  )
  assert(
    /REFUSED|SKIP/.test(fifoRun.stdout || ""),
    `FIFO child must report REFUSED or SKIP: ${fifoRun.stdout || ""} ${fifoRun.stderr || ""}`,
  )
  console.log("✓ readBoundedRunFile refuses a FIFO without hanging")

  // --- 10.2 ~~~ tilde fences are masked exactly like ``` fences.
  const tildeMasked = maskCodeAndQuotes("before\n~~~\nSECRET massive-proof 100+ searchers\n~~~\nafter")
  assert(tildeMasked.includes("before") && tildeMasked.includes("after"), "text outside a tilde fence must survive masking")
  assert(!tildeMasked.includes("SECRET") && !tildeMasked.includes("massive-proof"), "tilde-fenced text must be masked")
  const tildeUnclosed = maskCodeAndQuotes("keep\n~~~\nSECRET")
  assert(tildeUnclosed.includes("keep") && !tildeUnclosed.includes("SECRET"), "unclosed tilde fence must mask to end of input")
  const rTilde = classifyRoute("Prove this theorem.\n~~~\nuse massive-proof tournament with 100+ searchers\n~~~")
  assert.strictEqual(rTilde.topology, "proof", "tilde-fenced opt-in must be masked out")
  assert.strictEqual(rTilde.massiveProofOptIn, false, "tilde-fenced opt-in must not enable massive-proof")
  // mF4v: an inline ~~~ run inside a tilde block is content, not a closer.
  const tildeInlineCloser = maskCodeAndQuotes("~~~\ncode ~~~ still code\nuse a proof tournament\n~~~\nafter")
  assert(!tildeInlineCloser.includes("use a proof tournament"), "inline ~~~ must not close a tilde fence early")
  assert(tildeInlineCloser.includes("after"), "text after a real tilde closer must survive")
  // mF4y: trailing text on a ``` line is still fenced code, not a closer.
  const backtickTrailing = maskCodeAndQuotes("```\ncode\n```use a proof tournament\nstill code\n```\nafter")
  assert(!backtickTrailing.includes("use a proof tournament"), "trailing text must not close a backtick fence")
  assert(backtickTrailing.includes("after"), "text after a real backtick closer must survive")
  console.log("✓ ~~~ tilde fences mask their contents (closed and unclosed)")

  // --- 10.3 clean()/cleanBlock() accept primitives only and never throw on objects.
  assert.strictEqual(clean(["a"]), "", "arrays must be dropped by clean()")
  assert.strictEqual(clean({ toString: "x" }), "", "objects (even with a toString key) must be dropped by clean()")
  assert.doesNotThrow(() => clean({ toString: "x" }), "clean() must not invoke an object toString")
  assert.strictEqual(cleanBlock(["a"]), "", "arrays must be dropped by cleanBlock()")
  assert.strictEqual(cleanBlock({ toString: "x" }), "", "objects must be dropped by cleanBlock()")
  assert.doesNotThrow(() => cleanBlock({ toString: "x" }), "cleanBlock() must not invoke an object toString")
  assert.strictEqual(clean(42), "42", "numbers must still stringify")
  assert.strictEqual(clean("a\x00b\u0085c\u2028d"), "a b c d", "control chars and line separators must become spaces")
  assert.strictEqual(cleanBlock("a\nb\tc\r\nd"), "a\nb c \nd", "cleanBlock() must preserve only newline")
  assert.strictEqual(cleanBlock("a\u0085b"), "a b", "cleanBlock() must strip U+0085 like the rest of C1")
  console.log("✓ clean()/cleanBlock() drop objects/arrays and keep primitive/control-char behaviour")

  // --- 10.4 Routing regex edges.
  const rThisPr = classifyRoute({ request: "review thisPR", inputs: ["notes.md"] })
  assert.strictEqual(rThisPr.topology, "document-review", "review thisPR must not be treated as a PR review")
  const rMyCode = classifyRoute({ request: "review mycode", inputs: ["notes.md"] })
  assert.strictEqual(rMyCode.topology, "document-review", "review mycode must not be treated as a code review")
  const rRealPr = classifyRoute({ request: "review this PR", inputs: ["notes.md"] })
  assert.strictEqual(rRealPr.topology, "distributed-coding", "review this PR must still be treated as a PR review")

  const rCjkDoc = classifyRoute("review 论文.md and summarize it")
  assert.strictEqual(rCjkDoc.topology, "document-review", "non-ASCII filename must still count as a supplied document")

  const rLeanBackup = classifyRoute("open foo.lean-backup")
  assert.strictEqual(rLeanBackup.signals.leanBareMention, false, "foo.lean-backup must not be treated as a bare .lean file")

  const rLeanCross = classifyRoute("Formalize the theorem in Lean\nand then prove it")
  assert.strictEqual(rLeanCross.topology, "proof", "Lean explicit intent must survive a real cross-line gap")
  assert.strictEqual(rLeanCross.lemmaMode, true)

  const rLeanFalsePositive = classifyRoute("We run a lean manufacturing line and need to prove ROI")
  assert.strictEqual(rLeanFalsePositive.lemmaMode, false, "lowercase 'lean manufacturing' must not set lemmaMode")

  const rLeanLower = classifyRoute("Prove this theorem in lean")
  assert.strictEqual(rLeanLower.lemmaMode, true, "explicit 'in lean' must still set lemmaMode")
  console.log("✓ routing regex edges (PR/code review, non-ASCII docs, lean-backup, Lean proximity) hold")

  // --- 10.5 Atomic writes must not follow a planted temp-file symlink/hard link.
  {
    const run = mkdtempSync(join(tmpdir(), "teamwork-atomic-tr-"))
    try {
      const victim = join(run, "victim.txt")
      writeFileSync(victim, "ORIGINAL")
      const target = join(run, "manifest.json")
      symlinkSync(victim, `${target}.tmp`)
      writeSafeRunFile(run, target, "SAFE")
      assert.strictEqual(readFileSync(victim, "utf8"), "ORIGINAL", "tournament temp symlink must not overwrite the victim")
      assert.strictEqual(readFileSync(target, "utf8"), "SAFE", "tournament write must still land at the target")

      const victim2 = join(run, "victim2.txt")
      writeFileSync(victim2, "ORIGINAL2")
      const target2 = join(run, "verdict.json")
      linkSync(victim2, `${target2}.tmp`)
      writeSafeRunFile(run, target2, "SAFE2")
      assert.strictEqual(readFileSync(victim2, "utf8"), "ORIGINAL2", "tournament temp hard link must not overwrite the victim")
      assert.strictEqual(readFileSync(target2, "utf8"), "SAFE2", "tournament write must still land at the second target")
    } finally {
      rmSync(run, { recursive: true, force: true })
    }

    const root = mkdtempSync(join(tmpdir(), "teamwork-atomic-tools-"))
    try {
      const tools = {}
      const ctx = {
        tool: {
          transform: async (cb) =>
            cb({
              namespace: () => {},
              add: (tool) => {
                tools[tool.name] = tool
              },
            }),
        },
        session: { get: async () => undefined, hook: async () => {} },
      }
      await registerTeamworkTools(ctx, root)
      const sid = "20261018-200000-atom"
      const run = join(root, ".opencode", "teamwork", sid)
      mkdirSync(run, { recursive: true })
      const victim = join(root, "victim.txt")
      writeFileSync(victim, "ORIGINAL")
      for (const name of ["state.json", "costs.json", "plan.dag.json"]) symlinkSync(victim, join(run, `${name}.tmp`))
      const res = await tools.plan.execute({ sessionId: sid, topology: "iterative-coding", skipInterview: true, tasks: [{ id: "T1" }] })
      assert(res.content.startsWith("Planned"), `atomic-write plan must succeed: ${res.content}`)
      assert.strictEqual(readFileSync(victim, "utf8"), "ORIGINAL", "tools temp symlinks must not overwrite the victim")
      assert(existsSync(join(run, "state.json")), "tools write must still land at state.json")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    console.log("✓ atomic writes ignore planted temp symlinks/hard links and keep the victim intact")
  }

  // --- 10.6 describeRun must not read through symlinks or block on FIFOs.
  {
    const root = mkdtempSync(join(tmpdir(), "teamwork-desc-"))
    try {
      const sid = "20261018-200001-desc"
      const run = join(root, ".opencode", "teamwork", sid)
      mkdirSync(run, { recursive: true })
      const secretState = join(root, "secret-state.json")
      writeFileSync(secretState, JSON.stringify({ sessionId: sid, phase: "DONE", tasks: { leak: { status: "verified_pass" } } }))
      symlinkSync(secretState, join(run, "state.json"))
      assert.strictEqual(describeRun(root), undefined, "symlinked state.json must not populate run context")

      rmSync(join(run, "state.json"))
      writeFileSync(join(run, "state.json"), JSON.stringify({ sessionId: sid, phase: "DONE", tasks: {} }))
      const secretPitfalls = join(root, "secret-pitfalls.md")
      writeFileSync(secretPitfalls, "- LEAKED_PITFALL_FROM_OUTSIDE\n")
      symlinkSync(secretPitfalls, join(run, "pitfalls.md"))
      const desc = describeRun(root)
      assert(desc, "a valid state.json must still describe the run")
      assert(!desc.includes("LEAKED_PITFALL_FROM_OUTSIDE"), "symlinked pitfalls.md must not leak outside content")
      assert(desc.includes("Open pitfalls: 0"), "a refused pitfalls.md read counts as zero")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    const toolsUrl = new URL("../plugins/opencode-teamwork/tools.ts", import.meta.url).href
    const describeFifoCode = [
      `import { describeRun } from ${JSON.stringify(toolsUrl)}`,
      `import { execFileSync } from "node:child_process"`,
      `import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"`,
      `import { tmpdir } from "node:os"`,
      `import { join } from "node:path"`,
      `const root = mkdtempSync(join(tmpdir(), "teamwork-descfifo-"))`,
      `const run = join(root, ".opencode", "teamwork", "20261018-200002-fifo")`,
      `mkdirSync(run, { recursive: true })`,
      `let made = true`,
      `try {`,
      `  execFileSync("mkfifo", [join(run, "state.json")], { stdio: "ignore" })`,
      `} catch (err) {`,
      `  if (err && err.code === "ENOENT") made = false; else throw err`,
      `}`,
      `try {`,
      `  if (!made) {`,
      `    console.log("SKIP: mkfifo unavailable")`,
      `  } else {`,
      `    if (describeRun(root) !== undefined) throw new Error("FIFO state.json must not be read")`,
      `    rmSync(join(run, "state.json"))`,
      `    writeFileSync(join(run, "state.json"), JSON.stringify({ sessionId: "20261018-200002-fifo", phase: "DONE", tasks: {} }))`,
      `    execFileSync("mkfifo", [join(run, "pitfalls.md")], { stdio: "ignore" })`,
      `    const desc = describeRun(root)`,
      `    if (!desc || !desc.includes("Open pitfalls: 0")) throw new Error("FIFO pitfalls must count as zero: " + desc)`,
      `    console.log("REFUSED")`,
      `  }`,
      `} finally {`,
      `  rmSync(root, { recursive: true, force: true })`,
      `}`,
    ].join("\n")
    const describeFifoRun = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", describeFifoCode], {
      encoding: "utf8",
      timeout: 15000,
    })
    if (describeFifoRun.error && describeFifoRun.error.code === "ETIMEDOUT") {
      assert.fail("describeRun hung on a FIFO (timeout guard fired)")
    }
    assert.strictEqual(
      describeFifoRun.status,
      0,
      `describeRun FIFO child failed (status ${describeFifoRun.status}, signal ${describeFifoRun.signal}): ${describeFifoRun.stderr || ""}`,
    )
    assert(/REFUSED|SKIP/.test(describeFifoRun.stdout || ""), `describeRun FIFO child must report REFUSED or SKIP: ${describeFifoRun.stdout || ""}`)
    console.log("✓ describeRun refuses symlinked state/pitfalls and does not hang on FIFOs")
  }

  // --- 10.7 lib/team.mjs install/registration writes are atomic and no-follow.
  {
    const teamAgents = Object.keys(DEFAULT_MODELS).length
    const root = mkdtempSync(join(tmpdir(), "teamwork-install-"))
    try {
      // create: O_CREAT|O_EXCL, no temp files left behind
      const configDir = join(root, "config")
      const first = installAgents({ configDir })
      assert.strictEqual(first.created.length, teamAgents, `all ${teamAgents} agents must be created`)
      assert.deepStrictEqual(first.missing, [], "no source agents may be missing")
      assert.deepStrictEqual(first.updated, [], "a first install updates nothing")
      const targetDir = join(configDir, "agents", "team")
      const sentinel = join(targetDir, "sentinel.md")
      assert(readFileSync(sentinel, "utf8").includes(`model: ${DEFAULT_MODELS["team/sentinel"]}`), "default model must be injected")
      assert(!readdirSync(targetDir).some((name) => name.endsWith(".tmp")), "no temp files may be left behind")

      // idempotent re-run: unchanged, no backup
      const second = installAgents({ configDir })
      assert.strictEqual(second.unchanged.length, teamAgents, "a second identical install must be unchanged")
      assert.strictEqual(second.backupDir, undefined, "an unchanged install must not create backups")

      // update: backup holds the previous content and the mode is preserved.
      // Append (a single path operation) rather than read-then-write the same
      // path: there must be no check for the file to change between.
      const updatedAgent = join(targetDir, "worker.md")
      appendFileSync(updatedAgent, "\nLOCAL EDIT\n")
      chmodSync(updatedAgent, 0o640)
      const beforeUpdate = readFileSync(updatedAgent, "utf8")
      const updated = installAgents({ configDir, models: { "team/worker": "custom/new-model" } })
      assert.deepStrictEqual(updated.updated, ["worker.md"], "only worker.md must be updated")
      assert(updated.backupDir, "an update must report a backup dir")
      assert.strictEqual(readFileSync(join(updated.backupDir, "worker.md"), "utf8"), beforeUpdate, "the backup must hold the pre-update content")
      assert(readFileSync(updatedAgent, "utf8").includes("model: custom/new-model"), "the requested model must be injected")
      assert.strictEqual(statSync(updatedAgent).mode & 0o777, 0o640, "the existing file mode must be preserved")

      // refresh: adopt the shipped body, keep the chosen model, back up local edits
      const refreshDir = join(root, "refresh-config")
      installAgents({ configDir: refreshDir })
      const scout = join(refreshDir, "agents", "team", "scout.md")
      appendFileSync(scout, "\nLOCAL SCOUT EDIT\n")
      const refreshed = installAgents({ configDir: refreshDir, refresh: true, models: { "team/scout": "custom/scout" } })
      assert(refreshed.updated.includes("scout.md"), "refresh must update scout.md")
      const refreshedText = readFileSync(scout, "utf8")
      assert(!refreshedText.includes("LOCAL SCOUT EDIT"), "refresh must replace the local body")
      assert(refreshedText.includes("model: custom/scout"), "refresh must keep the chosen model line")
      assert(readFileSync(join(refreshed.backupDir, "scout.md"), "utf8").includes("LOCAL SCOUT EDIT"), "refresh must back up the local edit")

      // dry run: reports created but writes nothing at all
      const dryDir = join(root, "dry-config")
      const dry = installAgents({ configDir: dryDir, dryRun: true })
      assert.strictEqual(dry.created.length, teamAgents, "dry run must still report every would-be creation")
      assert(!existsSync(dryDir), "dry run must not create the config dir")

      // symlinked target: skipped, never followed or replaced
      const symDir = join(root, "sym-config")
      mkdirSync(join(symDir, "agents", "team"), { recursive: true })
      const outside = join(root, "outside-agent.md")
      writeFileSync(outside, "OUTSIDE AGENT\n")
      symlinkSync(outside, join(symDir, "agents", "team", "sentinel.md"))
      const sym = installAgents({ configDir: symDir })
      assert(sym.skipped.includes("sentinel.md"), "a symlinked target must be reported as skipped")
      assert(!sym.created.includes("sentinel.md"), "a symlinked target must not be created")
      assert.strictEqual(readFileSync(outside, "utf8"), "OUTSIDE AGENT\n", "a symlinked target must not be written through")
      assert(lstatSync(join(symDir, "agents", "team", "sentinel.md")).isSymbolicLink(), "the symlink must be left in place")

      // ensureAgents: create-only, no follow, idempotent
      const ensureDir = join(root, "ensure-config")
      const ensured = ensureAgents({ configDir: ensureDir })
      assert.strictEqual(ensured.length, teamAgents, "ensureAgents must create every missing agent")
      assert.deepStrictEqual(ensureAgents({ configDir: ensureDir }), [], "ensureAgents must create nothing on a second run")
      const ensureSymDir = join(root, "ensure-sym-config")
      mkdirSync(join(ensureSymDir, "agents", "team"), { recursive: true })
      const ensureOutside = join(root, "outside-ensure.md")
      writeFileSync(ensureOutside, "OUTSIDE ENSURE\n")
      symlinkSync(ensureOutside, join(ensureSymDir, "agents", "team", "sentinel.md"))
      const ensureSym = ensureAgents({ configDir: ensureSymDir })
      assert(!ensureSym.includes("sentinel.md"), "ensureAgents must skip a symlinked target")
      assert.strictEqual(readFileSync(ensureOutside, "utf8"), "OUTSIDE ENSURE\n", "ensureAgents must not write through a symlink")

      // registration: create, idempotence, backup, mode, dry run, symlink, JSONC
      const regDir = join(root, "reg-config")
      const reg = registerPlugin({ configDir: regDir })
      assert.strictEqual(reg.status, "added", "a first registration must add the plugin")
      const regFile = join(regDir, "opencode.json")
      assert(readFileSync(regFile, "utf8").includes("@heretek-ai/opencode-teamwork-v2"), "opencode.json must name the plugin")
      assert.strictEqual(registerPlugin({ configDir: regDir }).status, "already", "a second registration must be a no-op")

      const existingDir = join(root, "reg-existing")
      mkdirSync(existingDir, { recursive: true })
      const existingFile = join(existingDir, "opencode.json")
      writeFileSync(existingFile, '{"plugins":["other-plugin"]}\n')
      chmodSync(existingFile, 0o640)
      const beforeReg = readFileSync(existingFile, "utf8")
      assert.strictEqual(registerPlugin({ configDir: existingDir }).status, "added", "an existing config must get the plugin")
      assert(readFileSync(existingFile, "utf8").includes("other-plugin"), "existing plugins must be preserved")
      const backups = readdirSync(existingDir).filter((name) => name.startsWith("opencode.json.bak."))
      assert.strictEqual(backups.length, 1, "exactly one config backup must be written")
      assert.strictEqual(readFileSync(join(existingDir, backups[0]), "utf8"), beforeReg, "the config backup must hold the old content")
      assert.strictEqual(statSync(existingFile).mode & 0o777, 0o640, "the config mode must be preserved")

      const regDry = join(root, "reg-dry")
      assert.strictEqual(registerPlugin({ configDir: regDry, dryRun: true }).status, "added", "dry run must report added")
      assert(!existsSync(join(regDry, "opencode.json")), "dry run must not write the config")

      const regSym = join(root, "reg-sym")
      mkdirSync(regSym, { recursive: true })
      const regOutside = join(root, "outside-opencode.json")
      writeFileSync(regOutside, '{"plugins":[]}\n')
      symlinkSync(regOutside, join(regSym, "opencode.json"))
      assert.strictEqual(registerPlugin({ configDir: regSym }).status, "symlink", "a symlinked config must be refused")
      assert.strictEqual(readFileSync(regOutside, "utf8"), '{"plugins":[]}\n', "a symlinked config must not be written through")

      const jsoncDir = join(root, "reg-jsonc")
      mkdirSync(jsoncDir, { recursive: true })
      const jsoncFile = join(jsoncDir, "opencode.jsonc")
      writeFileSync(jsoncFile, '{\n  // keep me\n  "plugins": []\n}\n')
      const jsoncBefore = readFileSync(jsoncFile, "utf8")
      assert.strictEqual(registerPlugin({ configDir: jsoncDir }).status, "commented", "JSONC must not be rewritten")
      assert.strictEqual(readFileSync(jsoncFile, "utf8"), jsoncBefore, "JSONC comments must survive")

      // reference file: overwrite refuses a symlinked dest, keep-if-present is honoured
      const refDir = join(root, "ref-config")
      mkdirSync(join(refDir, "teamwork"), { recursive: true })
      const refOutside = join(root, "outside-artifacts.md")
      writeFileSync(refOutside, "ORIGINAL ARTIFACTS\n")
      symlinkSync(refOutside, join(refDir, "teamwork", "ARTIFACTS.md"))
      assert.strictEqual(writeReferenceFile({ configDir: refDir, overwrite: true }), false, "a symlinked ARTIFACTS dest must be refused")
      assert.strictEqual(readFileSync(refOutside, "utf8"), "ORIGINAL ARTIFACTS\n", "a symlinked ARTIFACTS dest must not be written through")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    console.log("✓ install/refresh/registration writes are atomic, create-only where required, and no-follow")
  }
}
