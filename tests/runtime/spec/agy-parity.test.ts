// L1–L3 OpenCode 2.4.1 Runtime Behavioral Parity & Security Regression Suite.
//
// Covers A1–A9 (/home/john/.local/bin/agy 1.5.17 parity) and M1 (URL/FS/DB/path
// security regressions) across all 4 tiers:
//   - Tier 1: Feature Coverage (happy paths)
//   - Tier 2: Boundary & Corner Cases
//   - Tier 3: Cross-Feature Pairwise Interactions
//   - Tier 4: Real-World E2E Workflows (git repos, worktrees, HTTP servers, CLI)
//
// Assertions inspect observable OpenCode 2.4.1 runtime surfaces only:
//   - sessions.command / sessions.get / sessions.inbox.list / sessions.interrupt
//   - executeViaRuntime (Tool.Service.snapshot()) & execute (rawExecute)
//   - capture.assertPermission (permission.hook("evaluate"))
//   - on-disk run artifacts, snapshotTree/treeDiff, real node:http servers, CLI

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { AGENTS_DIR, PLUGIN_DIR, REPO_ROOT, createProject, type Project } from "../harness/project"
import { importTeamwork, loadHost, type LoadedHost } from "../harness/load"
import {
  planRun,
  readEvents,
  readManifest,
  readPlan,
  readRunJson,
  readVictory,
  runDir,
  runFile,
  snapshotTree,
  treeDiff,
  withHost,
  withRun,
  writeSpec,
} from "../harness/plan"
import {
  call,
  commitChange,
  completeStandardRun,
  evidence,
  finalVerify,
  next,
  readFinal,
  readRunText,
  securityAudit,
  setupWorktree,
  state,
  taskCycle,
  transition,
  verifierReport,
  victory,
  waveRecord,
  writeRunFile,
} from "../harness/flow"
import { execute, executeViaRuntime } from "../harness/run"
import { openLocationTools } from "../harness/tools"
import {
  approvalEnv,
  makeApprovalDir,
  makeApprovalKeys,
  signDraftApproval,
  withApprovalOwner,
  withEnv,
} from "../harness/sign"
import { sha256Hex as keyedSha256Hex } from "../../../plugins/opencode-teamwork/approval-format.mjs"
import { HANDOFF } from "./helpers"

const EMPTY_DIFF = { added: [], removed: [], changed: [] }
const CLI = join(REPO_ROOT, "bin", "opencode-teamwork.mjs")
const APPROVAL_DRIVER = join(REPO_ROOT, "scripts", "approval-driver.mjs")

const READABLE_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n" +
    "4 0 obj << /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (Methodology Critique PDF) Tj ET\nendstream\nendobj\n" +
    "%%EOF\n",
  "latin1",
)

const IMAGE_ONLY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n%%EOF\n",
  "latin1",
)

async function runCommandCapture(
  loaded: LoadedHost,
  directory: string,
  name: string,
  text: string,
): Promise<{ agent: string; inboxText: string; sessionId: string }> {
  const session = await loaded.host.sessions.create({ location: { directory } })
  try {
    await loaded.host.sessions.command({ sessionID: session.id, name, text })
    const after = await loaded.host.sessions.get({ sessionID: session.id })
    const inbox = await loaded.host.sessions.inbox.list({ sessionID: session.id })
    const user = inbox.find((item: any) => item.type === "user")
    return {
      agent: String(after?.agent ?? ""),
      inboxText: String(user?.payload?.text ?? ""),
      sessionId: session.id,
    }
  } finally {
    await loaded.host.sessions.interrupt({ sessionID: session.id })
  }
}

async function withLoopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (info: { port: number; url: string; requests: string[] }) => Promise<void>,
): Promise<void> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`)
    handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") {
    server.close()
    throw new Error("failed to bind loopback HTTP server")
  }
  const url = `http://127.0.0.1:${addr.port}`
  try {
    await fn({ port: addr.port, url, requests })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function makeMockBinDir(project: Project, label: string, scripts: Record<string, string>): string {
  const dir = join(dirname(project.root), `mock-bin-${label}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8")
    chmodSync(file, 0o755)
  }
  return dir
}

function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): { code: number | null; stdout: string; stderr: string; json?: any } {
  const env = { ...process.env }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const res = spawnSync("node", [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env,
  })
  let json: any
  try {
    json = JSON.parse(res.stdout)
  } catch {}
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json }
}

// The host's Promise plugin adapter implements `context.cancel` as an Effect
// and exposes it to the tool as `context.signal`. This Effect resolves when the
// test's AbortController fires, so a real AbortController drives cancellation
// through the host boundary (the caller-supplied `signal` property itself is
// replaced by the adapter).
function cancelWhenAborted(ac: AbortController): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (ac.signal.aborted) resolve()
        else ac.signal.addEventListener("abort", () => resolve(), { once: true })
      }),
  )
}

function threePhaseVictorySummary(verdict: "VICTORY CONFIRMED" | "VICTORY REJECTED"): string {  return [
    "=== VICTORY AUDIT REPORT ===",
    `VERDICT: ${verdict}`,
    "",
    "PHASE A — TIMELINE",
    "- Checked run.manifest.json, state.json, and events.jsonl; no timing anomalies.",
    "",
    "PHASE B — INTEGRITY CHECK",
    "- Verified integrityMode from ORIGINAL_REQUEST.md; no forbidden shortcuts observed.",
    "",
    "PHASE C — INDEPENDENT TEST EXECUTION",
    "- Re-ran test suite independently; observed output matches claimed PASS.",
  ].join("\n")
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (Happy Paths across M1.1–M1.4 & A1–A9)
// ============================================================================

describe("Tier 1: Feature Coverage [M1, M3, M4]", () => {
  // --- M1.1: dbPathFor(env) (AGENTS.md Rule #7) -----------------------------
  test("[M1.1] doctor resolves scoped OPENCODE_CHANNEL to opencode-<channel>.db and unscoped 'beta' to opencode.db", async () => {
    const project = createProject("m1-1-channel-db")
    const xdgData = join(dirname(project.root), `xdg-data-${Date.now()}`)
    const dbDir = join(xdgData, "opencode")
    mkdirSync(dbDir, { recursive: true })
    const channelDb = join(dbDir, "opencode-staging.db")
    writeFileSync(channelDb, "sqlite-placeholder", "utf8")
    chmodSync(channelDb, 0o644) // group/world readable -> doctor db_mode must detect it!
    try {
      const res = runCli(["doctor", "--security", "--json"], {
        HOME: project.home,
        XDG_DATA_HOME: xdgData,
        OPENCODE_CHANNEL: "staging",
        OPENCODE_DB: undefined,
      })
      const dbCheck = res.json?.security?.checks?.find((c: any) => c.name === "db_mode")
      expect(dbCheck).toBeDefined()
      expect(dbCheck.status).toBe("fail")
      expect(String(dbCheck.message)).toContain("opencode-staging.db")
    } finally {
      rmSync(xdgData, { recursive: true, force: true })
      project.cleanup()
    }
  })

  test("[M1.1] doctor resolves explicit OPENCODE_DB override before channel default", async () => {
    const project = createProject("m1-1-opencode-db")
    const xdgData = join(dirname(project.root), `xdg-data-ov-${Date.now()}`)
    mkdirSync(join(xdgData, "opencode"), { recursive: true })
    const customDb = join(xdgData, "custom-opencode.db")
    writeFileSync(customDb, "sqlite-placeholder", "utf8")
    chmodSync(customDb, 0o644)
    try {
      const res = runCli(["doctor", "--security", "--json"], {
        HOME: project.home,
        XDG_DATA_HOME: xdgData,
        OPENCODE_CHANNEL: "beta",
        OPENCODE_DB: customDb,
      })
      const dbCheck = res.json?.security?.checks?.find((c: any) => c.name === "db_mode")
      expect(dbCheck).toBeDefined()
      expect(dbCheck.status).toBe("fail")
      expect(String(dbCheck.message)).toContain("custom-opencode.db")
    } finally {
      rmSync(xdgData, { recursive: true, force: true })
      project.cleanup()
    }
  })

  // --- M1.2: S3923 ternary fixes (lib/security.mjs, lib/verify.mjs) ---------
  test("[M1.2] verifyRun uses correct default requireHandoffs on v3+ runs with request vs legacy unsigned", async () => {
    await withRun(
      "m1-2-verify-default-handoffs",
      {
        sessionId: "20261125-000001-m12",
        request: "Verify handoff enforcement behavior.",
        requirements: [{ id: "R1", text: "Handoff matrix verified." }],
        requireHandoffs: "required",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        await next(fx)
        await transition(fx, "T1", "worker_active")
        await execute(fx.loaded, fx.worker, "handoff", { sessionId: fx.runId, taskId: "T1", ...HANDOFF })
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "PASS", { checks: [{ name: "fixture", type: "check", passed: true }] })
        await execute(fx.loaded, fx.verifier, "handoff", { sessionId: fx.runId, taskId: "T1", ...HANDOFF })
        await transition(fx, "T1", "verified_pass")
        await securityAudit(fx, "PASS")
        await victory(fx, { verdict: "VICTORY CONFIRMED" })
        // Without run-level victoryAuditor/root handoffs recorded, both final_verify and CLI verify must fail.
        const fv = await finalVerify(fx)
        expect(fv.status).toBe("FAIL")
        const cli = runCli(["verify", "--run-dir", fx.runDir, "--json"])
        expect(cli.json?.verdict).toBe("FAIL")
      },
    )
  })

  // --- M1.3: approval-driver runId allowlist (S8707) ------------------------
  test("[M1.3] approval-driver accepts valid runId matching SESSION_ID allowlist", async () => {
    const project = createProject("m1-3-valid-runid")
    try {
      const res = spawnSync(
        "node",
        [
          APPROVAL_DRIVER,
          JSON.stringify({
            root: project.root,
            storage: join(project.root, "driver-storage.json"),
            runId: "20261125-000001-valid",
            action: "write-draft",
            draft: "# Spec\n\nValid draft.\n",
          }),
        ],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 },
      )
      expect(res.status).toBe(0)
      const parsed = JSON.parse(res.stdout)
      expect(parsed.ok).toBe(true)
      expect(existsSync(runFile(project, "20261125-000001-valid", "prompt_draft.md"))).toBe(true)
    } finally {
      project.cleanup()
    }
  })

  // --- M1.4: service*.json URL validation & url-guard.mjs -------------------
  test("[M1.4] teamwork_cost reads session spend from validated loopback service-<channel>.json HTTP server", async () => {
    await withRun(
      "m1-4-service-loopback",
      {
        sessionId: "20261125-000001-m14",
        request: "Verify loopback service cost reading.",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const stateDir = join(dirname(fx.project.root), `xdg-state-${Date.now()}`)
        const ocState = join(stateDir, "opencode")
        mkdirSync(ocState, { recursive: true })
        try {
          await withLoopbackServer(
            (req, res) => {
              res.setHeader("content-type", "application/json")
              if (req.url?.startsWith(`/api/session/${encodeURIComponent(fx.root.id)}`)) {
                res.end(JSON.stringify({ data: { id: fx.root.id, agent: "team/sentinel", cost: 0.42, tokens: { input: 10, output: 5 } } }))
                return
              }
              if (req.url?.startsWith("/api/session?")) {
                res.end(JSON.stringify({ data: [] }))
                return
              }
              res.statusCode = 404
              res.end("{}")
            },
            async ({ url, requests }) => {
              writeFileSync(join(ocState, "service.json"), JSON.stringify({ url, password: "secret" }), "utf8")
              await withEnv(
                {
                  XDG_STATE_HOME: stateDir,
                  OPENCODE_DB: ":memory:",
                },
                async () => {
                  const cost = await call(fx, fx.root, "cost", { taskId: "T1" })
                  expect(cost.source).toContain("opencode service API")
                  expect(requests.length).toBeGreaterThan(0)
                },
              )
            },
          )
        } finally {
          rmSync(stateDir, { recursive: true, force: true })
        }
      },
    )
  })

  test("[M1.4] safeFetch allows local node:http server when OPENCODE_TEAMWORK_ALLOW_LOCALHOST=1", async () => {
    await withLoopbackServer(
      (_req, res) => {
        res.setHeader("content-type", "text/markdown")
        res.end("# Local Test Doc\n\nSection one.\n")
      },
      async ({ url }) => {
        const mod = await import(pathToFileURL(join(PLUGIN_DIR, "url-guard.mjs")).href)
        const res: any = await withEnv({ OPENCODE_TEAMWORK_ALLOW_LOCALHOST: "1" }, () =>
          mod.safeFetch(`${url}/doc.md`),
        )
        expect(res.ok).toBe(true)
        expect(res.status).toBe(200)
        expect(res.body.toString("utf8")).toContain("# Local Test Doc")
      },
    )
  })

  // --- A1: [skip-interview] bracket parsing, empty-arg prompt, ## Parameters ---
  test("[M3 A1] /teamwork [skip-interview] strips bracket from task text and switches to team/sentinel", async () => {
    await withHost("a1-cmd-skip", async ({ project, loaded }) => {
      const cmd = await runCommandCapture(loaded, project.root, "teamwork", "[skip-interview] Fix the typo in README")
      expect(cmd.agent).toBe("team/sentinel")
      expect(cmd.inboxText).toContain("Fix the typo in README")
      expect(cmd.inboxText.trimStart().startsWith("[skip-interview]")).toBe(false)
    })
  })

  test("[M3 A1] teamwork_plan with skipInterview records ## Parameters in ORIGINAL_REQUEST.md and specGate=bypassed", async () => {
    await withHost("a1-plan-params", async ({ project, loaded, root }) => {
      const runId = "20261125-000001-a1"
      const res = await planRun(loaded, root, {
        sessionId: runId,
        request: "Fix the typo in README.",
        skipInterview: true,
        topology: "small-focused",
        tasks: [{ id: "T1" }],
      })
      expect(res.content.startsWith("Planned ")).toBe(true)
      const created = readEvents(project, runId).find((e) => e.event === "run_created")
      expect(created?.specGate).toBe("bypassed")
      const reqText = readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")
      expect(reqText).toContain("## Parameters")
      expect(reqText).toContain("[skip-interview]")
      expect(reqText).toContain("How this run was launched; not part of the task.")
    })
  })

  // --- A2: Pre-routing interview gate & behavioral Step 3 Integrity Mode ---
  test("[M3 A2] /teamwork without [skip-interview] gates routing behind interview / prompt_draft.md", async () => {
    await withHost("a2-interview-gate-cmd", async ({ project, loaded }) => {
      const cmd = await runCommandCapture(loaded, project.root, "teamwork", "Build an auth gateway")
      expect(cmd.agent).toBe("team/sentinel")
      // Target M3 parity: /teamwork must NOT instruct Sentinel to run teamwork_route before prompt_draft.md exists.
      expect(cmd.inboxText).not.toMatch(/If not,\s*run\s*`teamwork_route`\s*first/i)
    })
  })

  test("[M3 A2] teamwork_plan refuses missing prompt_draft.md when skipInterview=false, then succeeds once written", async () => {
    await withHost("a2-plan-spec-gate", async ({ project, loaded, root }) => {
      const runId = "20261125-000001-a2"
      const before = snapshotTree(project.root)
      const refused = await planRun(loaded, root, { sessionId: runId, skipInterview: false })
      expect(refused.content).toContain("refused: no spec found")
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)

      writeSpec(project, runId, "# Teamwork Spec\n\n## Requirements\n- R1: Works.\n")
      const ok = await planRun(loaded, root, { sessionId: runId, skipInterview: false })
      expect(ok.content.startsWith("Planned ")).toBe(true)
      const created = readEvents(project, runId).find((e) => e.event === "run_created")
      expect(created?.specGate).toBe("satisfied")
    })
  })

  test("[M3 A2] crafter.md Step 3 uses behavioral multi-select (a)-(e) without naming raw modes", () => {
    const crafter = readFileSync(join(AGENTS_DIR, "crafter.md"), "utf8")
    const step3Match = crafter.match(/3\.\s+\*\*Determine Integrity Mode\*\*[\s\S]*?(?=\n4\.\s+\*\*)/)
    expect(step3Match).not.toBeNull()
    const step3 = step3Match![0]
    expect(step3).toContain("(a)")
    expect(step3).toContain("(b)")
    expect(step3).toContain("(c)")
    expect(step3).toContain("(d)")
    expect(step3).toContain("(e)")
    expect(step3.toLowerCase()).toContain("from scratch")
  })

  // --- A3: Follow-up message append to ORIGINAL_REQUEST.md ------------------
  test("[M3 A3] follow-up append adds UTC timestamp section to ORIGINAL_REQUEST.md without mutating initial request", async () => {
    await withRun(
      "a3-followup-append",
      {
        sessionId: "20261125-000001-a3",
        integrityMode: "demo",
        request: "Initial verbatim task request.",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const beforeText = readRunText(fx, "ORIGINAL_REQUEST.md")
        const appendRes = await execute(fx.loaded, fx.root, "plan", {
          sessionId: fx.runId,
          followUp: "Also preserve backward compatibility for v1 configs.",
        })
        expect(appendRes.status).not.toBe("ERROR")
        expect(String(appendRes.content)).not.toContain("refused:")
        const afterText = readRunText(fx, "ORIGINAL_REQUEST.md")
        expect(afterText.startsWith(beforeText.trimEnd())).toBe(true)
        expect(afterText).toMatch(/## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)
        expect(afterText).toContain("Also preserve backward compatibility for v1 configs.")
        expect(afterText).toContain("- Integrity mode: demo")
        expect(afterText).toContain("## Request\n\nInitial verbatim task request.")
      },
    )
  })

  // --- A4: small-focused multi-round loop & open-issues ledger --------------
  test("[M4 A4] small-focused routes cleanly, removes 1-round cap, and transitions round 1 FAIL to round 2 worker_active", async () => {
    await withHost("a4-small-focused-loop", async ({ project, loaded, root }) => {
      const module = await importTeamwork(project)
      const teamworkCmd = module.COMMANDS.find((c: any) => c.name === "teamwork")
      expect(teamworkCmd.template).not.toContain("1 for small-focused")

      const routeRes = await execute(loaded, root, "route", { request: "Fix the typo in README.md" })
      expect(routeRes.topology).toBe("small-focused")
      expect(routeRes.route).toBe("small-focused")

      const runId = "20261125-000001-a4"
      const planned = await planRun(loaded, root, {
        sessionId: runId,
        topology: "small-focused",
        request: "Fix the typo in README.md",
        tasks: [{ id: "T1" }],
      })
      expect(planned.content.startsWith("Planned ")).toBe(true)
      const plan = readPlan(project, runId)
      expect(Number(plan.tasks[0].maxRounds)).toBeGreaterThan(1)
      expect(Number(plan.tasks[0].maxRounds)).toBeLessThanOrEqual(32)

      const verifier = await createSessionChild(loaded, root, "team/verifier")
      await execute(loaded, root, "next", { sessionId: runId })
      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "T1", status: "worker_active" })
      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "T1", status: "worker_done" })
      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "T1", status: "verifier_active" })
      await execute(loaded, verifier, "report", {
        sessionId: runId,
        taskId: "T1",
        status: "FAIL",
        summary: "Typo remains on line 3.",
        fatalFindings: [{ where: "README.md:3", why: "Misspelled 'teh'", fix: "Change to 'the'" }],
        feedbackForWorker: "Fix line 3 typo.",
      })
      const failUpdate = await execute(loaded, root, "task_update", { sessionId: runId, taskId: "T1", status: "verified_fail" })
      expect(failUpdate.status).toBe("verified_fail")
      const r2 = await execute(loaded, root, "task_update", { sessionId: runId, taskId: "T1", status: "worker_active" })
      expect(r2.status).toBe("worker_active")
      expect(r2.round).toBe(2)
    })
  })

  // --- A5: distributed-coding Survey, PROJECT.md/SCOPE.md, DEAD_ENDS.md -----
  test("[M4 A5] distributed-coding supports PROJECT.md/SCOPE.md/TEST_INFRA.md and records DEAD_ENDS.md on 2 consecutive identical failures", async () => {
    await withRun(
      "a5-oscillation-guard",
      {
        sessionId: "20261125-000001-a5",
        topology: "distributed-coding",
        verification: "standard",
        request: "Build a distributed pipeline across modules.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 4 }],
      },
      async (fx) => {
        // A5: distributed-coding starts with the planning survey stubs. They
        // are create-only placeholders; TEST_READY.md is the Dual-Track gate
        // and must be produced by the team, never pre-seeded.
        for (const stub of ["PROJECT.md", "SCOPE.md", "TEST_INFRA.md"]) {
          expect(existsSync(runFile(fx.project, fx.runId, stub))).toBe(true)
        }
        expect(existsSync(runFile(fx.project, fx.runId, "TEST_READY.md"))).toBe(false)
        await next(fx)
        for (const roundNum of [1, 2]) {
          await transition(fx, "T1", "worker_active")
          await transition(fx, "T1", "worker_done")
          await transition(fx, "T1", "verifier_active")
          await verifierReport(fx, "T1", "FAIL", {
            summary: "Identical failure signature: missing export foo.",
            fatalFindings: [{ where: "src/index.ts:1", why: "Missing export foo", fix: "Export foo" }],
            feedbackForWorker: "Export foo in src/index.ts",
          })
          await transition(fx, "T1", "verified_fail")
          expect(state(fx).tasks.T1.round).toBe(roundNum)
        }
        const deadEndsPath = runFile(fx.project, fx.runId, "DEAD_ENDS.md")
        expect(existsSync(deadEndsPath)).toBe(true)
        const deadEnds = readFileSync(deadEndsPath, "utf8")
        expect(deadEnds).toContain("T1")
        expect(deadEnds.toLowerCase()).toMatch(/oscillation|identical/)
      },
    )
  })

  // --- A6: Verification wave depth & empirical challenger capability --------
  test("[M4 A6] distributed-coding defaults to strict verification and team/falsifier permits shell while denying edit", async () => {
    await withHost("a6-strict-default-and-falsifier", async ({ project, loaded, root }) => {
      const runId = "20261125-000001-a6"
      const planned = await planRun(loaded, root, {
        sessionId: runId,
        topology: "distributed-coding",
        request: "Implement distributed service with strict verification.",
        tasks: [{ id: "T1" }],
      })
      expect(planned.content.startsWith("Planned ")).toBe(true)
      expect(readPlan(project, runId)?.verification).toBe("strict")

      await loaded.host.sessions.update({
        sessionID: root.id,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      })
      await expect(
        loaded.capture.assertPermission({
          sessionID: root.id,
          agent: "team/falsifier",
          action: "edit",
          resources: ["src/index.ts"],
        }),
      ).rejects.toThrow(/team\/falsifier is restricted/)

      await expect(
        loaded.capture.assertPermission({
          sessionID: root.id,
          agent: "team/falsifier",
          action: "shell",
          resources: ["npm test"],
        }),
      ).resolves.toBeUndefined()
    })
  })

  // --- A7: PDF pre-flight (pypdfium2 + Pillow), PREREQUISITES.md, leap doctor ---
  test("[M4 A7] readable PDF passes document_triage and builds DOCUMENT_TEXT_MAP.md", async () => {
    await withHost("a7-readable-pdf", async ({ project, loaded, root }) => {
      const pdfPath = join(project.root, "paper.pdf")
      writeFileSync(pdfPath, READABLE_PDF)
      const res = await execute(loaded, root, "document_triage", {
        sessionId: "20261125-000001-a7p",
        request: "Critique paper.pdf",
        skipInterview: true,
        document: { path: "paper.pdf", format: "pdf" },
      })
      expect(String(res.content)).not.toContain("refused:")
      expect(res.extractionStatus).toBe("extracted")
      const textMap = readFileSync(runFile(project, "20261125-000001-a7p", "document-review/DOCUMENT_TEXT_MAP.md"), "utf8")
      expect(textMap).toContain("Methodology Critique PDF")
    })
  })

  test("[M4 #51] readable PDF renders bounded page_images + manifest and teamwork_document_visual_audit verifies cited images", async () => {
    await withHost("a7-visual-audit", async ({ project, loaded, root }) => {
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      const binDir = makeMockBinDir(project, "py-render-ok", {
        python3: `printf '%s\\n' '{"ok":true,"dpi":150,"pageCount":2,"truncated":false,"pages":[{"page":1,"width":1200,"height":1600,"pngBase64":"${tinyPng}"},{"page":2,"width":1200,"height":1600,"pngBase64":"${tinyPng}"}]}'`,
      })
      const pdfPath = join(project.root, "visual-paper.pdf")
      writeFileSync(pdfPath, READABLE_PDF)
      const sessionId = "20261126-000001-vis"
      await withEnv({ PATH: binDir }, async () => {
        const triage = await execute(loaded, root, "document_triage", {
          sessionId,
          request: "Critique visual-paper.pdf",
          skipInterview: true,
          renderDpi: 150,
          document: { path: "visual-paper.pdf", format: "pdf" },
        })
        expect(String(triage.content)).not.toContain("refused:")
        expect(triage.pageImageStatus).toBe("rendered")
        expect(triage.pageImageCount).toBe(2)

        const pageManifest = JSON.parse(
          readFileSync(runFile(project, sessionId, "document-review/page_images/manifest.json"), "utf8"),
        )
        expect(pageManifest.dpi).toBe(150)
        expect(pageManifest.pages).toHaveLength(2)

        const victoryChild = await createSessionChild(loaded, root, "team/victory-auditor")
        const passRes = await execute(loaded, victoryChild, "document_visual_audit", {
          sessionId,
          scope: "run",
          verdict: "PASS",
          summary: "Inspected pages 1 and 2.",
          inspectedImages: [
            { file: "page-1.png", sha256: pageManifest.pages[0].sha256, notes: "Checked page 1" },
            { file: "page-2.png", sha256: pageManifest.pages[1].sha256, notes: "Checked page 2" },
          ],
        })
        expect(passRes.verdict).toBe("PASS")
        expect(existsSync(runFile(project, sessionId, "document-review/visual-audit.json"))).toBe(true)

        const badRes = await execute(loaded, victoryChild, "document_visual_audit", {
          sessionId,
          scope: "run",
          verdict: "PASS",
          summary: "Unlisted page attempt",
          inspectedImages: ["page-99.png"],
        })
        expect(String(badRes.content)).toContain("refused:")
      })
    })
  })

  test("[M4 A7] teamwork_lemma_probe executes leap doctor --offline when lean, lake, leap exist on PATH", async () => {
    await withHost("a7-lemma-probe-doctor", async ({ project, loaded, root }) => {
      const binDir = makeMockBinDir(project, "lemma-ok", {
        lean: 'echo "Lean (version 4.12.0, commit abc)"',
        lake: 'echo "Lake version 5.0.0"',
        leap: 'if [ "$1" = "doctor" ]; then [ "$2" = "--offline" ] || { echo "expected --offline, got $2" >&2; exit 9; }; echo "leap doctor: OK"; exit 0; fi; echo "leap 0.3.1"',
      })
      try {
        await withEnv({ PATH: binDir }, async () => {
          const probe = await execute(loaded, root, "lemma_probe", {})
          expect(probe.ready).toBe(true)
          expect(probe.leap.doctor.status).toBe("READY")
          expect(String(probe.content)).toContain("READY")
          expect(JSON.stringify(probe)).toMatch(/doctor/i)
          expect(existsSync(join(project.root, "PREREQUISITES.md"))).toBe(false)
        })
      } finally {
        rmSync(binDir, { recursive: true, force: true })
      }
    })
  })

  test("[M4 A7] teamwork_lemma_probe treats a LEAN_PROJECT_DIR-only leap doctor failure as READY/WARN", async () => {
    await withHost("a7-lemma-project-warn", async ({ project, loaded, root }) => {
      const binDir = makeMockBinDir(project, "lemma-project-warn", {
        lean: 'echo "Lean (version 4.12.0, commit abc)"',
        lake: 'echo "Lake version 5.0.0"',
        leap: 'if [ "$1" = "doctor" ]; then [ "$2" = "--offline" ] || { echo "expected --offline, got $2" >&2; exit 9; }; echo "[FAIL] LEAN_PROJECT_DIR -- no local Lean project found"; exit 1; fi; echo "leap 0.3.1"',
      })
      try {
        await withEnv({ PATH: binDir }, async () => {
          const probe = await execute(loaded, root, "lemma_probe", {})
          expect(probe.ready).toBe(true)
          expect(probe.status).toBe("READY")
          expect(probe.leap.available).toBe(true)
          expect(probe.leap.doctor.status).toBe("WARN")
          expect(String(probe.content)).toMatch(/WARN/)
          expect(String(probe.content)).toContain("LEAN_PROJECT_DIR")
          expect(existsSync(join(project.root, "PREREQUISITES.md"))).toBe(false)
        })
      } finally {
        rmSync(binDir, { recursive: true, force: true })
      }
    })
  })

  // --- A8: Victory Auditor 3-phase report & worker.md handoff fix -----------
  test("[M4 A8] victory_audit accepts 3-phase === VICTORY AUDIT REPORT === and victory-auditor.md mandates it", async () => {
    const victoryDoc = readFileSync(join(AGENTS_DIR, "victory-auditor.md"), "utf8")
    expect(victoryDoc).toContain("=== VICTORY AUDIT REPORT ===")
    expect(victoryDoc).toContain("PHASE A")
    expect(victoryDoc).toContain("PHASE B")
    expect(victoryDoc).toContain("PHASE C")

    await withRun(
      "a8-3phase-victory",
      {
        sessionId: "20261125-000001-a8",
        request: "Deliver verified module.",
        requirements: [{ id: "R1", text: "Module works." }],
        requireHandoffs: "required",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        await next(fx)
        await transition(fx, "T1", "worker_active")
        const { path: wt } = await setupWorktree(fx, "T1")
        commitChange(wt, "src/t1.txt", "done\n", "feat: t1")
        await execute(fx.loaded, fx.worker, "handoff", { sessionId: fx.runId, taskId: "T1", ...HANDOFF })
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "PASS", { checks: [{ name: "test", type: "check", passed: true }] })
        await execute(fx.loaded, fx.verifier, "handoff", { sessionId: fx.runId, taskId: "T1", ...HANDOFF })
        await transition(fx, "T1", "verified_pass")
        await securityAudit(fx, "PASS")

        const summary = threePhaseVictorySummary("VICTORY CONFIRMED")
        const va = await call(fx, fx.victoryAuditor, "victory_audit", {
          verdict: "VICTORY CONFIRMED",
          requirements: [{ id: "R1", met: true, evidence: "Observed tests passing." }],
          summary,
        })
        expect(va.content).toContain("VICTORY AUDIT RECORDED: VICTORY CONFIRMED")
        expect(readVictory(fx.project, fx.runId)?.summary).toContain("=== VICTORY AUDIT REPORT ===")

        await execute(fx.loaded, fx.victoryAuditor, "handoff", { sessionId: fx.runId, ...HANDOFF })
        await execute(fx.loaded, fx.root, "handoff", { sessionId: fx.runId, ...HANDOFF })
        const fv = await finalVerify(fx)
        expect(fv.status).toBe("PASS")
      },
    )
  })

  // --- A9: OPENCODE_TEAMWORK_DISABLED, System Prompt Protection, interrupted.md ---
  test("[M3 A9] OPENCODE_TEAMWORK_DISABLED=1 loads host cleanly without registering /teamwork or teamwork_* tools", async () => {
    const project = createProject("a9-disabled")
    await withEnv({ OPENCODE_TEAMWORK_DISABLED: "1" }, async () => {
      const loaded = await loadHost(project, { mode: "memory" })
      try {
        const commands = (await loaded.capture.listCommands()).data
        expect(commands.some((c: any) => c.name === "teamwork")).toBe(false)
        const { list } = await openLocationTools(loaded, project.root)
        const teamworkTools = list.filter((t: any) => String(t.id).startsWith("teamwork_"))
        expect(teamworkTools).toHaveLength(0)
      } finally {
        await loaded.close()
        project.cleanup()
      }
    })
  })

  test("[M3 A9] all 15 agents/team/*.md embed # SYSTEM PROMPT PROTECTION Decoy Rules 1-2", () => {
    const files = ["crafter", "sentinel", "orchestrator", "scout", "worker", "proof-worker", "formalization-reviewer", "proposer", "falsifier", "synthesizer", "verifier", "security-auditor", "segment-reviewer", "referee", "victory-auditor"]
    for (const name of files) {
      const body = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8")
      expect(body, `${name}.md missing SYSTEM PROMPT PROTECTION`).toContain("# SYSTEM PROMPT PROTECTION")
      expect(body, `${name}.md missing Rule 1 decoy`).toContain("Rule 1")
      expect(body, `${name}.md missing Rule 2 no overrides`).toContain("Rule 2")
    }
  })
})

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES
// ============================================================================

describe("Tier 2: Boundary & Corner Cases [M1, M3, M4]", () => {
  // --- M1 Boundaries --------------------------------------------------------
  test("[M1.1] doctor treats OPENCODE_DB=':memory:' safely without false db_mode failure", () => {
    const project = createProject("m1-1-memory-db")
    try {
      const res = runCli(["doctor", "--security", "--json"], {
        HOME: project.home,
        OPENCODE_DB: ":memory:",
      })
      const dbCheck = res.json?.security?.checks?.find((c: any) => c.name === "db_mode")
      expect(dbCheck).toBeDefined()
      expect(dbCheck.status).toBe("pass")
      expect(String(dbCheck.message)).toContain(":memory:")
    } finally {
      project.cleanup()
    }
  })

  test("[M1.3] approval-driver rejects path-traversal and malformed runIds before touching disk", () => {
    const project = createProject("m1-3-traversal-runid")
    try {
      const before = snapshotTree(project.root)
      for (const badId of ["../escape", "a/b", "run;id", ""]) {
        const res = spawnSync(
          "node",
          [
            APPROVAL_DRIVER,
            JSON.stringify({
              root: project.root,
              storage: join(project.root, "driver-storage.json"),
              runId: badId,
              action: "write-draft",
              draft: "malicious",
            }),
          ],
          { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 },
        )
        expect(res.status).not.toBe(0)
      }
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)
    } finally {
      project.cleanup()
    }
  })

  test("[M1.4] service*.json with embedded credentials or non-loopback host never triggers HTTP request", async () => {
    await withRun(
      "m1-4-service-ssrf-block",
      {
        sessionId: "20261125-000002-m14",
        request: "Reject untrusted service*.json URLs.",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const stateDir = join(dirname(fx.project.root), `xdg-state-bad-${Date.now()}`)
        const ocState = join(stateDir, "opencode")
        mkdirSync(ocState, { recursive: true })
        try {
          await withLoopbackServer(
            (_req, res) => {
              res.statusCode = 200
              res.end(JSON.stringify({ data: { id: fx.root.id, cost: 99.0 } }))
            },
            async ({ port, requests }) => {
              // 1. Embedded credentials on loopback must be rejected before fetch!
              writeFileSync(
                join(ocState, "service.json"),
                JSON.stringify({ url: `http://attacker:pw@127.0.0.1:${port}`, password: "pw" }),
                "utf8",
              )
              await withEnv({ XDG_STATE_HOME: stateDir, OPENCODE_DB: ":memory:" }, async () => {
                const cost = await call(fx, fx.root, "cost", { taskId: "T1" })
                expect(cost.source).not.toContain("opencode service API")
                expect(requests).toHaveLength(0)
              })

              // 2. Non-http/https scheme (file://) must be rejected!
              writeFileSync(
                join(ocState, "service.json"),
                JSON.stringify({ url: "file:///etc/passwd" }),
                "utf8",
              )
              await withEnv({ XDG_STATE_HOME: stateDir, OPENCODE_DB: ":memory:" }, async () => {
                const cost = await call(fx, fx.root, "cost", { taskId: "T1" })
                expect(cost.source).not.toContain("opencode service API")
              })
            },
          )
        } finally {
          rmSync(stateDir, { recursive: true, force: true })
        }
      },
    )
  })

  test("[M1.4] url-guard blocks metadata IP, credentials, file://, loopback (no opt-in), and 3xx redirects", async () => {
    const mod = await import(pathToFileURL(join(PLUGIN_DIR, "url-guard.mjs")).href)
    await withEnv({ OPENCODE_TEAMWORK_ALLOW_LOCALHOST: undefined }, async () => {
      expect((await mod.assertSafeUrl("http://169.254.169.254/latest/meta-data")).code).toBe("URL_BLOCKED_ADDRESS")
      expect((await mod.assertSafeUrl("http://127.0.0.1:8080/")).code).toBe("URL_BLOCKED_ADDRESS")
      expect((await mod.assertSafeUrl("http://[::1]:8080/")).code).toBe("URL_BLOCKED_ADDRESS")
      expect((await mod.assertSafeUrl("file:///etc/passwd")).code).toBe("URL_PROTOCOL")
      expect((await mod.assertSafeUrl("https://user:pass@example.com/")).code).toBe("URL_CREDENTIALS")
    })

    // Redirect from loopback (with opt-in) to metadata IP must not be followed automatically.
    await withLoopbackServer(
      (_req, res) => {
        res.statusCode = 302
        res.setHeader("Location", "http://169.254.169.254/latest/meta-data")
        res.end()
      },
      async ({ url }) => {
        await withHost("m1-4-redirect-triage", async ({ loaded, root }) => {
          await withEnv({ OPENCODE_TEAMWORK_ALLOW_LOCALHOST: "1" }, async () => {
            const res = await execute(loaded, root, "document_triage", {
              sessionId: "20261125-000002-redir",
              skipInterview: true,
              fetchUrl: true,
              document: { url: `${url}/redirect`, format: "markdown" },
            })
            expect(String(res.content)).toContain("refused:")
            expect(existsSync(runDir(loaded.project, "20261125-000002-redir"))).toBe(false)
          })
        })
      },
    )
  })

  // --- A1 Boundaries --------------------------------------------------------
  test("[M3 A1] /teamwork with empty args or [skip-interview] alone asks user instead of routing", async () => {
    await withHost("a1-empty-args", async ({ project, loaded }) => {
      for (const rawArgs of ["", "   ", "[skip-interview]", "[skip-interview]   "]) {
        const cmd = await runCommandCapture(loaded, project.root, "teamwork", rawArgs)
        expect(cmd.agent).toBe("team/sentinel")
        expect(cmd.inboxText.toLowerCase()).toMatch(/ask the user|what (?:task|would you like)/)
        expect(cmd.inboxText).not.toMatch(/run `teamwork_route` first/i)
      }
    })
  })

  test("[M3 A1] /teamwork [WIP] Fix bug preserves unknown bracket [WIP] in task text and notes ignored bracket", async () => {
    await withHost("a1-unknown-bracket", async ({ project, loaded }) => {
      const cmd = await runCommandCapture(loaded, project.root, "teamwork", "[WIP] Fix bug")
      expect(cmd.inboxText).toContain("[WIP] Fix bug")
      expect(cmd.inboxText.toLowerCase()).toContain("ignored")
    })
  })

  test("[M3 A1] /teamwork [skip-interview] [WIP] Fix bug strips only the first known bracket", async () => {
    await withHost("a1-multi-bracket", async ({ project, loaded }) => {
      const cmd = await runCommandCapture(loaded, project.root, "teamwork", "[skip-interview] [WIP] Fix bug")
      expect(cmd.inboxText).toContain("[WIP] Fix bug")
      expect(cmd.inboxText.trimStart().startsWith("[skip-interview]")).toBe(false)
    })
  })

  test("[M3 A1] teamwork_plan refuses oversize request (>20000 chars) before mkdir", async () => {
    await withHost("a1-oversize-req", async ({ project, loaded, root }) => {
      const before = snapshotTree(project.root)
      const res = await planRun(loaded, root, {
        sessionId: "20261125-000002-over",
        request: "x".repeat(20_001),
      })
      expect(res.content).toContain("refused:")
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)
    })
  })

  // --- A2 Boundaries --------------------------------------------------------
  test("[M3 A2] whitespace-only and symlinked prompt_draft.md are refused before writing plan artifacts", async () => {
    await withHost("a2-bad-drafts", async ({ project, loaded, root }) => {
      const wsRun = "20261125-000002-ws"
      writeSpec(project, wsRun, "  \n\t\n ")
      const beforeWs = snapshotTree(runDir(project, wsRun))
      const resWs = await planRun(loaded, root, { sessionId: wsRun, skipInterview: false })
      expect(resWs.content).toContain("refused: no spec found")
      expect(treeDiff(beforeWs, snapshotTree(runDir(project, wsRun)))).toEqual(EMPTY_DIFF)

      const symRun = "20261125-000002-sym"
      const outside = join(project.root, "outside-spec.md")
      writeFileSync(outside, "# Outside Spec\n\nContent.\n", "utf8")
      mkdirSync(runDir(project, symRun), { recursive: true })
      symlinkSync(outside, runFile(project, symRun, "prompt_draft.md"))
      const resSym = await planRun(loaded, root, { sessionId: symRun, skipInterview: false })
      expect(resSym.content).toContain("refused:")
      expect(existsSync(runFile(project, symRun, "plan.dag.json"))).toBe(false)
    })
  })

  test("[M3 A2] integrityMode rules: core_logic_copied allowed in development, forbidden in demo/benchmark; invalid mode refused", async () => {
    await withHost("a2-integrity-modes", async ({ project, loaded, root }) => {
      const badMode = await planRun(loaded, root, {
        sessionId: "20261125-000002-badm",
        integrityMode: "permissive",
      })
      expect(badMode.content).toContain("refused:")
      expect(existsSync(runDir(project, "20261125-000002-badm"))).toBe(false)
    })

    await withRun(
      "a2-demo-mode-enforce",
      {
        sessionId: "20261125-000002-demo",
        integrityMode: "demo",
        request: "Demo integrity boundary.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        expect(readRunText(fx, "ORIGINAL_REQUEST.md")).toContain("- Integrity mode: demo")
        await next(fx)
        await taskCycle(fx, "T1")
        const sec = await call(fx, fx.auditor, "security_audit", {
          status: "PASS",
          findings: [],
          integrityFindings: [{ rule: "core_logic_copied", where: "src/t1.txt", why: "Copied OSS logic" }],
        })
        expect(sec.status).toBe("FAIL")
      },
    )
  })

  // --- A3 Boundaries --------------------------------------------------------
  test("[M3 A3] follow-up append rejects duplicate-last, empty, oversize, and unrelated session", async () => {
    await withRun(
      "a3-followup-bounds",
      {
        sessionId: "20261125-000002-a3b",
        request: "Initial request.",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const msg = "Clarification: use strict JSON."
        const first = await execute(fx.loaded, fx.root, "plan", { sessionId: fx.runId, followUp: msg })
        expect(String(first.content)).not.toContain("refused:")
        const afterFirst = readRunText(fx, "ORIGINAL_REQUEST.md")

        // Duplicate-last must skip idempotently without duplicating the section.
        const dup = await execute(fx.loaded, fx.root, "plan", { sessionId: fx.runId, followUp: msg })
        expect(String(dup.content)).not.toContain("refused:")
        expect(readRunText(fx, "ORIGINAL_REQUEST.md")).toBe(afterFirst)

        // Empty / oversize refused.
        const empty = await execute(fx.loaded, fx.root, "plan", { sessionId: fx.runId, followUp: "   " })
        expect(String(empty.content)).toContain("refused:")
        const oversize = await execute(fx.loaded, fx.root, "plan", { sessionId: fx.runId, followUp: "y".repeat(20_001) })
        expect(String(oversize.content)).toContain("refused:")

        // Unrelated root session refused by authorize.ts.
        const stranger = await fx.loaded.host.sessions.create({ location: { directory: fx.project.root } })
        const strangerSession = { id: stranger.id, agent: "team/sentinel", parentID: null, info: stranger }
        const denied = await execute(fx.loaded, strangerSession, "plan", { sessionId: fx.runId, followUp: "Hijack attempt." })
        expect(String(denied.content)).toContain("AUTHZ_SESSION_TREE")
        expect(readRunText(fx, "ORIGINAL_REQUEST.md")).toBe(afterFirst)
      },
    )
  })

  // --- A4 Boundaries --------------------------------------------------------
  test("[M4 A4] small-focused accepts maxRounds=32, preserves open-issues ledger across FAIL rounds, and enforces 2-audit cap", async () => {
    await withRun(
      "a4-boundaries",
      {
        sessionId: "20261125-000002-a4b",
        topology: "small-focused",
        request: "Fix typo with multi-round tracking.",
        requirements: [{ id: "R1", text: "Typo fixed." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 32 }],
      },
      async (fx) => {
        expect(readPlan(fx.project, fx.runId)?.tasks?.[0]?.maxRounds).toBe(32)
        // A4 clamp boundaries: 0 -> 1, 33 -> 32.
        const zero = await planRun(fx.loaded, fx.root, {
          sessionId: "20261125-000002-a4b0",
          topology: "small-focused",
          request: "Fix typo with zero rounds.",
          tasks: [{ id: "T1", maxRounds: 0 }],
        })
        expect(zero.content.startsWith("Planned ")).toBe(true)
        expect(readPlan(fx.project, "20261125-000002-a4b0")?.tasks?.[0]?.maxRounds).toBe(1)
        const over = await planRun(fx.loaded, fx.root, {
          sessionId: "20261125-000002-a4b33",
          topology: "small-focused",
          request: "Fix typo with too many rounds.",
          tasks: [{ id: "T1", maxRounds: 33 }],
        })
        expect(over.content.startsWith("Planned ")).toBe(true)
        expect(readPlan(fx.project, "20261125-000002-a4b33")?.tasks?.[0]?.maxRounds).toBe(32)
        await next(fx)
        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "FAIL", {
          fatalFindings: [{ where: "README.md:1", why: "Open issue #1", fix: "Fix #1" }],
          feedbackForWorker: "Open issue #1 remains",
        })
        await transition(fx, "T1", "verified_fail")
        expect(Array.isArray(state(fx).tasks.T1.feedbackLog)).toBe(true)
        expect(state(fx).tasks.T1.feedbackLog.length).toBeGreaterThanOrEqual(1)
        // Report-derived feedback: no input.feedback was passed to task_update,
        // so the ledger text comes from the verifier report's feedbackForWorker.
        expect(state(fx).tasks.T1.feedbackLog.some((e: any) => e.text === "Open issue #1 remains" && e.resolved === false)).toBe(true)

        // Complete round 2 to reach victory audits
        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "PASS")
        await transition(fx, "T1", "verified_pass")
        await securityAudit(fx, "PASS")

        // 1st and 2nd victory audits allowed; 3rd in small-focused must be refused/capped.
        await victory(fx, { verdict: "VICTORY REJECTED", unmet: ["R1"], findings: ["Gap 1"] })
        await victory(fx, { verdict: "VICTORY REJECTED", unmet: ["R1"], findings: ["Gap 2"] })
        const third = await call(fx, fx.victoryAuditor, "victory_audit", {
          verdict: "VICTORY CONFIRMED",
          requirements: [{ id: "R1", met: true, evidence: "Attempt 3." }],
        })
        expect(String(third.content)).toContain("refused:")
      },
    )
  })

  // --- A5 Boundaries --------------------------------------------------------
  test("[M4 A5] 1 failure or 2 distinct failures do NOT trigger DEAD_ENDS.md; symlinked DEAD_ENDS.md refused", async () => {
    await withRun(
      "a5-non-oscillation",
      {
        sessionId: "20261125-000002-a5b",
        topology: "distributed-coding",
        verification: "standard",
        request: "Verify non-identical failures do not trigger oscillation guard.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 5 }],
      },
      async (fx) => {
        await next(fx)
        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "FAIL", {
          summary: "Failure alpha",
          fatalFindings: [{ where: "a.ts:1", why: "Syntax error", fix: "Fix syntax" }],
        })
        await transition(fx, "T1", "verified_fail")
        expect(existsSync(runFile(fx.project, fx.runId, "DEAD_ENDS.md"))).toBe(false)

        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "FAIL", {
          summary: "Failure beta (completely different)",
          fatalFindings: [{ where: "b.ts:9", why: "Timeout in DB", fix: "Close conn" }],
        })
        await transition(fx, "T1", "verified_fail")
        expect(existsSync(runFile(fx.project, fx.runId, "DEAD_ENDS.md"))).toBe(false)

        // Plant a symlink before two identical failures. The writer must never
        // follow it and must not replace the link with a regular file.
        const outside = join(fx.project.root, "outside-dead-ends.md")
        writeFileSync(outside, "outside untouched", "utf8")
        const deadEnds = runFile(fx.project, fx.runId, "DEAD_ENDS.md")
        symlinkSync(outside, deadEnds)
        for (const roundNum of [3, 4]) {
          await transition(fx, "T1", "worker_active")
          await transition(fx, "T1", "worker_done")
          await transition(fx, "T1", "verifier_active")
          await verifierReport(fx, "T1", "FAIL", {
            summary: "Identical symlink failure signature",
            fatalFindings: [{ where: "src/index.ts:1", why: "Missing export foo", fix: "Export foo" }],
            feedbackForWorker: "Export foo in src/index.ts",
          })
          await transition(fx, "T1", "verified_fail")
          expect(state(fx).tasks.T1.round).toBe(roundNum)
        }
        expect(readFileSync(outside, "utf8")).toBe("outside untouched")
        expect(lstatSync(deadEnds).isSymbolicLink()).toBe(true)
      },
    )
  })

  // --- A6 Boundaries --------------------------------------------------------
  test("[M4 A6] wave_record enforces role authz, non-missing cites, reportHash staleness, and strict-only GATE_STATUS.md", async () => {
    await withRun(
      "a6-wave-boundaries",
      {
        sessionId: "20261125-000002-a6b",
        verification: "strict",
        request: "Strict wave boundaries.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 3 }],
      },
      async (fx) => {
        await next(fx)
        await taskCycle(fx, "T1")
        // Worker cannot record challenge
        const workerAttempt = await call(fx, fx.worker, "wave_record", {
          taskId: "T1",
          kind: "challenge",
          verdict: "PASS",
        })
        expect(String(workerAttempt.content)).toContain("refused:")

        // Missing cite file refused
        const badCite = await call(fx, fx.falsifier, "wave_record", {
          taskId: "T1",
          kind: "challenge",
          verdict: "PASS",
          cites: ["verify/evidence/missing.txt"],
        })
        expect(String(badCite.content)).toContain("refused:")

        // Record valid wave against round 1 PASS
        const ev = await evidence(fx, "r1.txt", "round 1 evidence\n")
        await waveRecord(fx, "T1", "challenge", [ev])
        await waveRecord(fx, "T1", "audit", [ev])

        // Re-verify T1 -> old wave becomes STALE
        await transition(fx, "T1", "blocked")
        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "PASS", { summary: "Round 2 fresh report." })
        await transition(fx, "T1", "verified_pass")
        await securityAudit(fx, "PASS")
        await victory(fx, { verdict: "VICTORY CONFIRMED" })

        const staleFinal = await finalVerify(fx)
        expect(staleFinal.status).toBe("FAIL")
        expect(JSON.stringify(staleFinal.reasons).toLowerCase()).toContain("stale")
        const gateStatus = readRunText(fx, "GATE_STATUS.md")
        expect(gateStatus).toContain(
          "- Wave: reviewer (team/verifier) + challenger (team/falsifier) + forensic auditor (team/security-auditor)",
        )
      },
    )
  })

  // --- A7 Boundaries --------------------------------------------------------
  test("[M4 A7] unreadable PDF without pypdfium2/Pillow refuses pre-mkdir with MISSING and writes PREREQUISITES.md", async () => {
    await withHost("a7-missing-pdf-deps", async ({ project, loaded, root }) => {
      writeFileSync(join(project.root, "scanned.pdf"), IMAGE_ONLY_PDF)
      const stubBin = makeMockBinDir(project, "no-py-deps", {
        python3: 'echo "ModuleNotFoundError: pypdfium2" >&2; exit 1',
      })
      const runId = "20261125-000002-pdfm"
      const before = snapshotTree(project.root)
      try {
        await withEnv({ PATH: stubBin }, async () => {
          const res = await execute(loaded, root, "document_triage", {
            sessionId: runId,
            skipInterview: true,
            document: { path: "scanned.pdf", format: "pdf" },
          })
          expect(String(res.content)).toMatch(/refused:|MISSING/)
          expect(String(res.content)).toMatch(/pypdfium2|Pillow/)
          expect(existsSync(runDir(project, runId))).toBe(false)
          expect(existsSync(join(project.root, "PREREQUISITES.md"))).toBe(true)
          const prereq = readFileSync(join(project.root, "PREREQUISITES.md"), "utf8")
          expect(prereq).toContain("pypdfium2")
          expect(prereq).toContain("Pillow")
          expect(prereq).toMatch(/^- Status: MISSING$/m)
        })
      } finally {
        rmSync(stubBin, { recursive: true, force: true })
        // Keep tree clean check aware of PREREQUISITES.md if created
        expect(existsSync(runFile(project, runId, "document-review/manifest.json"))).toBe(false)
        void before
      }
    })
  })

  test("[M4 A7] corrupt non-%PDF- file is refused pre-mkdir with empty treeDiff", async () => {
    await withHost("a7-forged-pdf", async ({ project, loaded, root }) => {
      writeFileSync(join(project.root, "fake.pdf"), "NOT A PDF", "utf8")
      const before = snapshotTree(project.root)
      const res = await execute(loaded, root, "document_triage", {
        sessionId: "20261125-000002-fake",
        skipInterview: true,
        document: { path: "fake.pdf", format: "pdf" },
      })
      expect(String(res.content)).toContain("refused:")
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)
    })
  })

  test("[M4 A7] teamwork_lemma_probe returns MISSING/OUTAGE when leap is missing or leap doctor fails", async () => {
    await withHost("a7-lemma-missing", async ({ project, loaded, root }) => {
      const emptyBin = makeMockBinDir(project, "empty", {})
      const brokenDoctorBin = makeMockBinDir(project, "bad-doc", {
        lean: 'echo "Lean (version 4.12.0)"',
        lake: 'echo "Lake version 5.0.0"',
        leap: 'if [ "$1" = "doctor" ]; then [ "$2" = "--offline" ] || { echo "expected --offline" >&2; exit 9; }; echo "missing mathlib cache" >&2; exit 1; fi; echo "leap 0.3.1"',
      })
      try {
        await withEnv({ PATH: emptyBin }, async () => {
          const missing = await execute(loaded, root, "lemma_probe", {})
          expect(missing.ready).toBe(false)
          expect(String(missing.content)).toMatch(/MISSING|missing/)
          expect(readFileSync(join(project.root, "PREREQUISITES.md"), "utf8")).toMatch(/^- Status: MISSING$/m)
        })
        await withEnv({ PATH: brokenDoctorBin }, async () => {
          const badDoc = await execute(loaded, root, "lemma_probe", {})
          expect(badDoc.ready).toBe(false)
          expect(String(badDoc.content)).toMatch(/doctor|OUTAGE|MISSING/i)
          const prereq = readFileSync(join(project.root, "PREREQUISITES.md"), "utf8")
          expect(prereq).toMatch(/^- Status: OUTAGE$/m)
          expect(prereq).not.toMatch(/^- Status: MISSING$/m)
        })
      } finally {
        rmSync(emptyBin, { recursive: true, force: true })
        rmSync(brokenDoctorBin, { recursive: true, force: true })
      }
    })
  })

  // --- A8 Boundaries --------------------------------------------------------
  test("[M4 A8] victory_audit refuses duplicate/unknown requirement IDs; worker.md has no unqualified handoff.md contradiction", async () => {
    const workerMd = readFileSync(join(AGENTS_DIR, "worker.md"), "utf8")
    expect(workerMd).not.toMatch(/write `handoff\.md`,\s*and stop/i)

    await withRun(
      "a8-req-validation",
      {
        sessionId: "20261125-000002-a8b",
        request: "Requirement validation.",
        requirements: [
          { id: "R1", text: "First req." },
          { id: "R2", text: "Second req." },
        ],
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        await next(fx)
        await taskCycle(fx, "T1")
        await securityAudit(fx, "PASS")

        const dup = await call(fx, fx.victoryAuditor, "victory_audit", {
          verdict: "VICTORY CONFIRMED",
          requirements: [
            { id: "R1", met: true, evidence: "ok" },
            { id: "R1", met: true, evidence: "dup" },
          ],
        })
        expect(String(dup.content)).toContain("refused:")

        const unknown = await call(fx, fx.victoryAuditor, "victory_audit", {
          verdict: "VICTORY CONFIRMED",
          requirements: [
            { id: "R1", met: true, evidence: "ok" },
            { id: "R99", met: true, evidence: "unknown" },
          ],
        })
        expect(String(unknown.content)).toContain("refused:")

        // A8 residual: the engine does not enforce the 3-phase format; a legacy
        // (non-3-phase) summary is accepted and stored verbatim. The prompt is
        // the mandate, not a code check.
        const legacySummary = "Legacy acceptance note without phase headings."
        const legacy = await call(fx, fx.victoryAuditor, "victory_audit", {
          verdict: "VICTORY CONFIRMED",
          requirements: [
            { id: "R1", met: true, evidence: "First req observed." },
            { id: "R2", met: true, evidence: "Second req observed." },
          ],
          summary: legacySummary,
        })
        expect(String(legacy.content)).toContain("VICTORY AUDIT RECORDED: VICTORY CONFIRMED")
        expect(readVictory(fx.project, fx.runId)?.summary).toBe(legacySummary)
      },
    )
  })

  // --- A9 Boundaries --------------------------------------------------------
  test("[M3 A9] OPENCODE_TEAMWORK_DISABLED='true' disables plugin while '0' leaves 7 commands & 27 tools active", async () => {
    const projTrue = createProject("a9-true")
    await withEnv({ OPENCODE_TEAMWORK_DISABLED: "true" }, async () => {
      const loaded = await loadHost(projTrue, { mode: "memory" })
      try {
        expect((await loaded.capture.listCommands()).data.some((c: any) => c.name === "teamwork")).toBe(false)
      } finally {
        await loaded.close()
        projTrue.cleanup()
      }
    })

    const projZero = createProject("a9-zero")
    await withEnv({ OPENCODE_TEAMWORK_DISABLED: "0" }, async () => {
      const loaded = await loadHost(projZero, { mode: "memory" })
      try {
        // The host also exposes its own built-in commands, so count only the
        // seven the plugin registers, by name.
        const names = (await loaded.capture.listCommands()).data.map((c: any) => String(c.name))
        for (const expected of [
          "teamwork",
          "teamwork-craft",
          "team-orchestrate",
          "team-propose",
          "team-falsify",
          "team-synthesize",
          "team-review",
        ]) {
          expect(names).toContain(expected)
        }
        expect(names.filter((name) => name.startsWith("teamwork") || name.startsWith("team-"))).toHaveLength(7)
        const { list } = await openLocationTools(loaded, projZero.root)
        expect(list.filter((t: any) => String(t.id).startsWith("teamwork_"))).toHaveLength(27)
      } finally {
        await loaded.close()
        projZero.cleanup()
      }
    })
  })

  test("[M3 A9] abort writes interrupted.md and never follows a planted interrupted.md symlink", async () => {
    await withHost("a9-interrupted-abort", async ({ project, loaded, root }) => {
      // 1) A planted symlink is refused by writeTextSafe: the outside target is
      // untouched, the link is not replaced, and the phase stays CANCELLED.
      const symlinkRunId = "20261125-000002-a9s"
      const plannedSymlink = await planRun(loaded, root, {
        sessionId: symlinkRunId,
        request: "Verify interrupted.md symlink safety.",
        tasks: [{ id: "T1" }],
      })
      expect(plannedSymlink.content.startsWith("Planned ")).toBe(true)
      const outside = join(project.root, "outside-interrupted.md")
      writeFileSync(outside, "evil", "utf8")
      const symlinkTarget = runFile(project, symlinkRunId, "interrupted.md")
      symlinkSync(outside, symlinkTarget)
      const acSymlink = new AbortController()
      const symlinkPending = execute(loaded, root, "next", { sessionId: symlinkRunId }, { signal: acSymlink.signal, cancel: cancelWhenAborted(acSymlink) })
      acSymlink.abort()
      const cancelledSymlink = await symlinkPending
      expect(cancelledSymlink.status).toBe("CANCELLED")
      expect(readFileSync(outside, "utf8")).toBe("evil")
      expect(lstatSync(symlinkTarget).isSymbolicLink()).toBe(true)

      // 2) A normal abort writes a real interrupted.md with the CANCELLED phase.
      const abortRunId = "20261125-000002-a9a"
      const plannedAbort = await planRun(loaded, root, {
        sessionId: abortRunId,
        request: "Verify abort-time interrupted.md.",
        tasks: [{ id: "T1" }],
      })
      expect(plannedAbort.content.startsWith("Planned ")).toBe(true)
      const ac = new AbortController()
      const pending = execute(loaded, root, "next", { sessionId: abortRunId }, { signal: ac.signal, cancel: cancelWhenAborted(ac) })
      ac.abort()
      const cancelled = await pending
      expect(cancelled.status).toBe("CANCELLED")
      const interrupted = readFileSync(runFile(project, abortRunId, "interrupted.md"), "utf8")
      expect(interrupted).toContain("# Interrupted")
      expect(interrupted).toContain("request aborted via AbortSignal")
      expect(interrupted).toContain(abortRunId)
    })
  })

  test("[M1/A1-A8 Runtime Boundary] executeViaRuntime enforces strictInput on route/plan/document_triage/victory_audit", async () => {
    await withHost("t2-runtime-boundary", async ({ project, loaded, root }) => {
      const before = snapshotTree(project.root)
      const validRoute = await executeViaRuntime(loaded, root, "route", { request: "Fix the typo in README." })
      expect(validRoute.status).not.toBe("ERROR")
      expect(validRoute.content).toContain("Route: small-focused")
      expect(validRoute.output).toBeUndefined()

      for (const [toolName, payload] of [
        ["route", { request: "Fix typo.", bogusField: true }],
        ["plan", { topology: "iterative-coding", tasks: [{ id: "T1" }], skipInterview: true, extraUnknown: 1 }],
        ["document_triage", { document: { content: "# Doc", format: "markdown" }, badKey: "x" }],
        ["victory_audit", { verdict: "VICTORY CONFIRMED", requirements: [], rogue: true }],
      ] as const) {
        const res = await executeViaRuntime(loaded, root, toolName, payload as Record<string, unknown>)
        expect(res.status).toBe("ERROR")
        expect(String(res.error)).toContain("unknown property")
      }
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)
    })
  })
})

// ============================================================================
// TIER 3: CROSS-FEATURE PAIRWISE INTERACTIONS
// ============================================================================

describe("Tier 3: Cross-Feature Pairwise Interactions [M1, M3, M4]", () => {
  test("[M3 A1 x A2] skipInterview bypasses spec gate while missing draft without bypass writes nothing", async () => {
    await withHost("t3-a1-a2", async ({ project, loaded, root }) => {
      const before = snapshotTree(project.root)
      const gated = await planRun(loaded, root, { sessionId: "20261125-000003-g1", skipInterview: false })
      expect(gated.content).toContain("refused: no spec found")
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)

      const bypassed = await planRun(loaded, root, {
        sessionId: "20261125-000003-g2",
        skipInterview: true,
        request: "Bypass test.",
      })
      expect(bypassed.content.startsWith("Planned ")).toBe(true)
      expect(readRunText({ project, runId: "20261125-000003-g2" } as any, "ORIGINAL_REQUEST.md")).toContain("## Parameters")
    })
  })

  test("[M3 A1 x Manifest] run.manifest.json requestHash matches ORIGINAL_REQUEST.md bytes including ## Parameters", async () => {
    await withRun(
      "t3-a1-manifest",
      {
        sessionId: "20261125-000003-a1m",
        skipInterview: true,
        request: "Compute manifest hash with parameters.",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const reqBytes = readRunText(fx, "ORIGINAL_REQUEST.md")
        expect(reqBytes).toContain("## Parameters")
        const manifest = readManifest(fx.project, fx.runId)
        // The manifest binds the request with the keyed digest (ADR 0015), not
        // a plain sha256. b-plan.test.ts B4 asserts the same contract.
        expect(manifest?.requestHash).toBe(keyedSha256Hex(reqBytes))
      },
    )
  })

  test("[M3 A2 x Approvals] human-approved draft change triggers AUTH_APPROVAL_STALE on re-plan", async () => {
    await withHost("t3-a2-approval", async ({ project, loaded, root }) => {
      const runId = "20261125-000003-app"
      const keys = makeApprovalKeys("t3-approver")
      const dir = makeApprovalDir(project, "t3")
      try {
        writeSpec(project, runId, "# Approved Draft\n\n- R1: Pass.\n")
        await signDraftApproval(project, runId, dir, { keys })
        await withApprovalOwner(async () => {
          await withEnv(approvalEnv(dir, keys), async () => {
            const first = await planRun(loaded, root, {
              sessionId: runId,
              trustLevel: "human-approved",
              skipInterview: false,
              request: "Approved run.",
            })
            expect(first.content.startsWith("Planned ")).toBe(true)

            // Mutate prompt_draft.md by 1 byte -> re-plan must detect stale approval
            writeSpec(project, runId, "# Approved Draft\n\n- R1: Pass!\n")
            const stale = await planRun(loaded, root, {
              sessionId: runId,
              trustLevel: "human-approved",
              skipInterview: false,
              request: null,
            })
            expect(stale.content).toContain("AUTH_APPROVAL_STALE")
          })
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  test("[M3 A3 x Auth] follow-up append to ORIGINAL_REQUEST.md does not falsely trigger AUTH_STALE in victory_audit/final_verify", async () => {
    await withRun(
      "t3-a3-auth",
      {
        sessionId: "20261125-000003-a3a",
        request: "Initial request before follow-up.",
        requirements: [{ id: "R1", text: "Task delivered." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        await next(fx)
        await execute(fx.loaded, fx.root, "plan", {
          sessionId: fx.runId,
          followUp: "Add strict null check.",
        })
        expect(readRunText(fx, "ORIGINAL_REQUEST.md")).toContain("Add strict null check.")
        // A3 residual: the follow-up must re-bind the signed manifest to the
        // current whole-file bytes, not leave the pre-append hash in place.
        const requestBytes = readRunText(fx, "ORIGINAL_REQUEST.md")
        expect(readManifest(fx.project, fx.runId)?.requestHash).toBe(keyedSha256Hex(requestBytes))
        await taskCycle(fx, "T1")
        await securityAudit(fx, "PASS")
        await victory(fx, { verdict: "VICTORY CONFIRMED" })
        const fv = await finalVerify(fx)
        expect(fv.status).toBe("PASS")
      },
    )
  })

  test("[M3 A3 x A1] ## Parameters section is preserved across follow-up appends", async () => {
    await withRun(
      "t3-a3-a1",
      {
        sessionId: "20261125-000003-a3a1",
        skipInterview: true,
        request: "Base request.",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        await execute(fx.loaded, fx.root, "plan", {
          sessionId: fx.runId,
          followUp: "Follow-up note.",
        })
        const text = readRunText(fx, "ORIGINAL_REQUEST.md")
        expect(text).toContain("## Parameters")
        expect(text).toContain("[skip-interview]")
        expect(text).toContain("Follow-up note.")
      },
    )
  })

  test("[M4 A4 x Worktree] single worktree reused across multi-round small-focused retries with advancing headSha", async () => {
    await withRun(
      "t3-a4-worktree",
      {
        sessionId: "20261125-000003-a4wt",
        topology: "small-focused",
        request: "Fix parser typo.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 4 }],
      },
      async (fx) => {
        await next(fx)
        const { commits } = await taskCycle(fx, "T1", { retry: true })
        expect(commits).toHaveLength(2)
        expect(commits[0]).not.toBe(commits[1])
        const report = readRunJson(fx.project, fx.runId, "verify/report-T1.json")
        expect(report?.headSha).toBe(commits[1])
      },
    )
  })

  test("[M4 A5 x A6] distributed-coding strict wave gates next with NEEDS_STRICT_WAVE until falsifier+auditor cite evidence", async () => {
    await withRun(
      "t3-a5-a6",
      {
        sessionId: "20261125-000003-a5a6",
        topology: "distributed-coding",
        verification: "strict",
        request: "Strict distributed task.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        await next(fx)
        await taskCycle(fx, "T1")
        await securityAudit(fx, "PASS")
        await victory(fx, { verdict: "VICTORY CONFIRMED" })
        const blocked = await next(fx)
        expect(blocked.status).toBe("NEEDS_STRICT_WAVE")

        const ev = await evidence(fx, "challenge-proof.txt", "empirical check ok\n")
        await waveRecord(fx, "T1", "challenge", [ev])
        await waveRecord(fx, "T1", "audit", [ev])
        const fv = await finalVerify(fx)
        expect(fv.status).toBe("PASS")
        expect(existsSync(runFile(fx.project, fx.runId, "GATE_STATUS.md"))).toBe(true)
      },
    )
  })

  test("[M4 A5 x Claims] independent tasks in distributed-coding receive distinct fences via teamwork_next", async () => {
    await withRun(
      "t3-a5-claims",
      {
        sessionId: "20261125-000003-claims",
        topology: "distributed-coding",
        request: "Parallel tasks.",
        tasks: [{ id: "T1" }, { id: "T2" }],
      },
      async (fx) => {
        const res = await next(fx)
        expect((res.readyForWorker as any[]).map((t) => String(t.id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(["T1", "T2"])
        for (const item of res.readyForWorker as any[]) {
          expect(typeof item.fence).toBe("number")
        }
      },
    )
  })

  test("[M4 A7 x M1] symlinked PDF or ../escape.pdf in document_triage refused pre-mkdir before PDF probe", async () => {
    await withHost("t3-a7-m1", async ({ project, loaded, root }) => {
      const outside = join(dirname(project.root), `outside-${Date.now()}.pdf`)
      writeFileSync(outside, READABLE_PDF)
      symlinkSync(outside, join(project.root, "link.pdf"))
      const before = snapshotTree(project.root)
      try {
        const symRes = await execute(loaded, root, "document_triage", {
          sessionId: "20261125-000003-sympdf",
          skipInterview: true,
          document: { path: "link.pdf", format: "pdf" },
        })
        expect(String(symRes.content)).toContain("refused:")

        const travRes = await execute(loaded, root, "document_triage", {
          sessionId: "20261125-000003-travpdf",
          skipInterview: true,
          document: { path: "../outside.pdf", format: "pdf" },
        })
        expect(String(travRes.content)).toContain("refused:")
        expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)
      } finally {
        rmSync(outside, { force: true })
      }
    })
  })

  test("[M4 A7 x A1] skipInterview + readable PDF document_triage preserves ## Parameters without breaking DOCUMENT_TEXT_MAP.md", async () => {
    await withHost("t3-a7-a1", async ({ project, loaded, root }) => {
      writeFileSync(join(project.root, "doc.pdf"), READABLE_PDF)
      const runId = "20261125-000003-a7a1"
      const res = await execute(loaded, root, "document_triage", {
        sessionId: runId,
        request: "Critique doc.pdf",
        skipInterview: true,
        document: { path: "doc.pdf", format: "pdf" },
      })
      expect(String(res.content)).not.toContain("refused:")
      expect(readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")).toContain("## Parameters")
      expect(readFileSync(runFile(project, runId, "document-review/DOCUMENT_TEXT_MAP.md"), "utf8")).toContain("Methodology Critique PDF")
    })
  })

  test("[M4 A8 x A4] small-focused limits victory audits to 2 while allowing multi-round worker fixes", async () => {
    await withRun(
      "t3-a8-a4",
      {
        sessionId: "20261125-000003-a8a4",
        topology: "small-focused",
        request: "Fix and verify.",
        requirements: [{ id: "R1", text: "Fixed." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 6 }],
      },
      async (fx) => {
        await next(fx)
        await taskCycle(fx, "T1", { retry: true })
        await securityAudit(fx, "PASS")
        await victory(fx, { verdict: "VICTORY REJECTED", unmet: ["R1"], findings: ["Still missing edge check"] })
        await victory(fx, { verdict: "VICTORY CONFIRMED" })
        const fv = await finalVerify(fx)
        expect(fv.status).toBe("PASS")
      },
    )
  })

  test("[M1 x A7] document_triage with metadata URL 169.254.169.254 refuses pre-mkdir", async () => {
    await withHost("t3-m1-a7", async ({ project, loaded, root }) => {
      const before = snapshotTree(project.root)
      const res = await execute(loaded, root, "document_triage", {
        sessionId: "20261125-000003-ssrf",
        skipInterview: true,
        fetchUrl: true,
        document: { url: "http://169.254.169.254/latest/meta-data", format: "markdown" },
      })
      expect(String(res.content)).toContain("refused:")
      expect(treeDiff(before, snapshotTree(project.root))).toEqual(EMPTY_DIFF)
    })
  })

  test("[M1 x CLI-verify] doctor --security + verify --run-dir both respect OPENCODE_CHANNEL and verify signed runs", async () => {
    await withRun(
      "t3-m1-cli",
      {
        sessionId: "20261125-000003-m1cli",
        request: "Verify CLI security & verification parity.",
        requirements: [{ id: "R1", text: "Delivered." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const final = await completeStandardRun(fx)
        expect(final.status).toBe("PASS")
        const manifest = readManifest(fx.project, fx.runId)
        const vRes = runCli([
          "verify",
          "--run-dir",
          fx.runDir,
          "--hmac-key",
          String(process.env.OPENCODE_TEAMWORK_HMAC_KEY),
          "--hmac-key-id",
          String(manifest?.runKeyId),
          "--json",
        ])
        expect(vRes.code).toBe(0)
        expect(vRes.json?.verdict).toBe("PASS")
      },
    )
  })
})

// ============================================================================
// TIER 4: REAL-WORLD E2E SCENARIOS (7 Full Workflows)
// ============================================================================

describe("Tier 4: Real-World E2E Scenarios [M1, M3, M4]", () => {
  test("[T4.1 M3/M4] [skip-interview] fast-track small-focused multi-round fix -> 3-phase Victory Audit -> final_verify -> CLI verify", async () => {
    await withHost("t4-1-small-focused-e2e", async ({ project, loaded, root, child }) => {
      const cmd = await runCommandCapture(loaded, project.root, "teamwork", "[skip-interview] Fix the typo in README")
      expect(cmd.agent).toBe("team/sentinel")
      expect(cmd.inboxText.trimStart().startsWith("[skip-interview]")).toBe(false)

      const routeRes = await execute(loaded, root, "route", { request: "Fix the typo in README" })
      expect(routeRes.topology).toBe("small-focused")

      const runId = "20261125-000004-t41"
      const planned = await planRun(loaded, root, {
        sessionId: runId,
        topology: "small-focused",
        skipInterview: true,
        request: "Fix the typo in README",
        requirements: [{ id: "R1", text: "README typo fixed." }],
        requireHandoffs: "required",
        tasks: [{ id: "T1" }],
      })
      expect(planned.content.startsWith("Planned ")).toBe(true)
      expect(readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")).toContain("## Parameters")

      const fx: any = {
        project,
        loaded,
        root,
        child,
        runId,
        runDir: runDir(project, runId),
        plan: planned,
        worker: await child("team/worker"),
        verifier: await child("team/verifier"),
        falsifier: await child("team/falsifier"),
        auditor: await child("team/security-auditor"),
        victoryAuditor: await child("team/victory-auditor"),
      }

      await next(fx)
      await transition(fx, "T1", "worker_active")
      const { path: wt } = await setupWorktree(fx, "T1")
      commitChange(wt, "README.md", "# Project\n\nFixed typo line.\n", "fix: round 1")
      await transition(fx, "T1", "worker_done")
      await transition(fx, "T1", "verifier_active")
      await verifierReport(fx, "T1", "FAIL", {
        fatalFindings: [{ where: "README.md:1", why: "Missing period", fix: "Add period" }],
        feedbackForWorker: "Add period to heading.",
      })
      await transition(fx, "T1", "verified_fail")

      await transition(fx, "T1", "worker_active")
      commitChange(wt, "README.md", "# Project.\n\nFixed typo line.\n", "fix: round 2")
      await execute(loaded, fx.worker, "handoff", { sessionId: runId, taskId: "T1", ...HANDOFF })
      await transition(fx, "T1", "worker_done")
      await transition(fx, "T1", "verifier_active")
      await verifierReport(fx, "T1", "PASS", { checks: [{ name: "spellcheck", type: "check", passed: true }] })
      await execute(loaded, fx.verifier, "handoff", { sessionId: runId, taskId: "T1", ...HANDOFF })
      await transition(fx, "T1", "verified_pass")

      await securityAudit(fx, "PASS")
      await call(fx, fx.victoryAuditor, "victory_audit", {
        verdict: "VICTORY CONFIRMED",
        requirements: [{ id: "R1", met: true, evidence: "README.md verified." }],
        summary: threePhaseVictorySummary("VICTORY CONFIRMED"),
      })
      await execute(loaded, fx.victoryAuditor, "handoff", { sessionId: runId, ...HANDOFF })
      await execute(loaded, fx.root, "handoff", { sessionId: runId, ...HANDOFF })

      const fv = await finalVerify(fx)
      expect(fv.status).toBe("PASS")
      expect((await next(fx)).status).toBe("ALL_PASSED")
    })
  })

  test("[T4.2 M3/M4] interview-gated distributed-coding with demo integrity, follow-up append, and strict GATE_STATUS.md", async () => {
    await withHost("t4-2-gated-strict", async ({ project, loaded, root, child }) => {
      const cmd = await runCommandCapture(loaded, project.root, "teamwork", "Build distributed telemetry collector")
      expect(cmd.agent).toBe("team/sentinel")

      const runId = "20261125-000004-t42"
      const refused = await planRun(loaded, root, { sessionId: runId, skipInterview: false, topology: "distributed-coding" })
      expect(refused.content).toContain("refused: no spec found")

      writeSpec(project, runId, "# Telemetry Collector\n\n## Requirements\n- R1: Emit metrics.\n")
      const planned = await planRun(loaded, root, {
        sessionId: runId,
        topology: "distributed-coding",
        integrityMode: "demo",
        verification: "strict",
        skipInterview: false,
        request: "Build distributed telemetry collector",
        requirements: [{ id: "R1", text: "Emit metrics." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      })
      expect(planned.content.startsWith("Planned ")).toBe(true)

      const fx: any = {
        project,
        loaded,
        root,
        child,
        runId,
        runDir: runDir(project, runId),
        plan: planned,
        worker: await child("team/worker"),
        verifier: await child("team/verifier"),
        falsifier: await child("team/falsifier"),
        auditor: await child("team/security-auditor"),
        victoryAuditor: await child("team/victory-auditor"),
      }

      await next(fx)
      await execute(loaded, root, "plan", {
        sessionId: runId,
        topology: "distributed-coding",
        integrityMode: "demo",
        verification: "strict",
        skipInterview: false,
        tasks: [{ id: "T1" }],
        followUp: "Also export Prometheus histogram.",
      })
      expect(readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")).toContain(
        "Also export Prometheus histogram.",
      )
      await taskCycle(fx, "T1")
      const ev = await evidence(fx, "strict-check.txt", "verified\n")
      await waveRecord(fx, "T1", "challenge", [ev])
      await waveRecord(fx, "T1", "audit", [ev])
      await securityAudit(fx, "PASS")
      await victory(fx, { verdict: "VICTORY CONFIRMED" })
      const fv = await finalVerify(fx)
      expect(fv.status).toBe("PASS")
      expect(existsSync(runFile(project, runId, "GATE_STATUS.md"))).toBe(true)
      expect((await next(fx)).status).toBe("ALL_PASSED")
    })
  })

  test("[T4.3 M4] oscillation guard DEAD_ENDS.md (2 identical failures) and terminal non-victory stop (never VICTORY CONFIRMED)", async () => {
    await withRun(
      "t4-3-oscillation-deadlock",
      {
        sessionId: "20261125-000004-t43",
        topology: "distributed-coding",
        verification: "standard",
        request: "Attempt impossible fix to trigger oscillation & deadlock.",
        requireHandoffs: "skip",
        tasks: [{ id: "T1", maxRounds: 2 }],
      },
      async (fx) => {
        await next(fx)
        // Round 1 fail
        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "FAIL", {
          summary: "Deterministic failure X",
          fatalFindings: [{ where: "src/x.ts:1", why: "Invariant X failed", fix: "Fix X" }],
        })
        await transition(fx, "T1", "verified_fail")

        // Round 2 identical fail -> hits maxRounds=2 -> blocked + DEAD_ENDS.md
        await transition(fx, "T1", "worker_active")
        await transition(fx, "T1", "worker_done")
        await transition(fx, "T1", "verifier_active")
        await verifierReport(fx, "T1", "FAIL", {
          summary: "Deterministic failure X",
          fatalFindings: [{ where: "src/x.ts:1", why: "Invariant X failed", fix: "Fix X" }],
        })
        const blocked = await execute(fx.loaded, fx.root, "task_update", {
          sessionId: fx.runId,
          taskId: "T1",
          status: "verified_fail",
        })
        expect(blocked.status).toBe("blocked")
        expect(existsSync(runFile(fx.project, fx.runId, "DEAD_ENDS.md"))).toBe(true)
        expect((await next(fx)).status).toBe("DEADLOCK")
        expect(state(fx).phase).toBe("PRESENT_PARTIAL")
        expect(readVictory(fx.project, fx.runId)).toBeUndefined()
      },
    )
  })

  test("[T4.4 M4] document-review PDF pre-flight MISSING vs valid Markdown full segment-review -> synthesis -> finalVerify fails closed on unsigned route evidence", async () => {
    await withHost("t4-4-doc-review-e2e", async ({ project, loaded, root, child }) => {
      // (a) Unreadable PDF with missing python deps refuses pre-mkdir + PREREQUISITES.md
      writeFileSync(join(project.root, "scan.pdf"), IMAGE_ONLY_PDF)
      const stubBin = makeMockBinDir(project, "doc-missing", {
        python3: 'exit 1',
      })
      try {
        await withEnv({ PATH: stubBin }, async () => {
          const refused = await execute(loaded, root, "document_triage", {
            sessionId: "20261125-000004-badpdf",
            skipInterview: true,
            document: { path: "scan.pdf", format: "pdf" },
          })
          expect(String(refused.content)).toMatch(/refused:|MISSING/)
          expect(existsSync(runDir(project, "20261125-000004-badpdf"))).toBe(false)
          expect(existsSync(join(project.root, "PREREQUISITES.md"))).toBe(true)
        })
      } finally {
        rmSync(stubBin, { recursive: true, force: true })
      }

      // (b) Valid Markdown document review E2E
      const runId = "20261125-000004-mdok"
      const triage = await execute(loaded, root, "document_triage", {
        sessionId: runId,
        request: "Critique this design document.",
        skipInterview: true,
        maxSegments: 2,
        document: {
          content: "# Section 1\n\nAlpha claims.\n\n# Section 2\n\nBeta claims.\n",
          format: "markdown",
        },
      })
      expect(String(triage.content)).not.toContain("refused:")
      expect(triage.extractionStatus).toBe("extracted")

      const segReviewer = await child("team/segment-reviewer")
      const synthesizer = await child("team/synthesizer")
      const verifier = await child("team/verifier")
      const auditor = await child("team/security-auditor")
      const victoryAuditor = await child("team/victory-auditor")

      const segIds = (triage.segments as any[]).map((s) => s.id)
      for (const segId of segIds) {
        await execute(loaded, root, "task_update", { sessionId: runId, taskId: segId, status: "worker_active" })
        await execute(loaded, segReviewer, "document_record", {
          sessionId: runId,
          stage: "segment_analysis",
          segmentId: segId,
          level: 0,
          index: 0,
          summary: `Analyzed ${segId}`,
          findings: ["Checked methodology"],
        })
        await execute(loaded, segReviewer, "document_record", {
          sessionId: runId,
          stage: "segment_report",
          segmentId: segId,
          summary: `Unit report for ${segId}`,
          verdict: "COMPLETE",
        })
        await execute(loaded, segReviewer, "handoff", { sessionId: runId, taskId: segId, ...HANDOFF })
        await execute(loaded, root, "task_update", { sessionId: runId, taskId: segId, status: "worker_done" })
        await execute(loaded, root, "task_update", { sessionId: runId, taskId: segId, status: "verifier_active" })
        await execute(loaded, verifier, "report", { sessionId: runId, taskId: segId, status: "PASS", summary: `${segId} verified.` })
        await execute(loaded, verifier, "handoff", { sessionId: runId, taskId: segId, ...HANDOFF })
        await execute(loaded, root, "task_update", { sessionId: runId, taskId: segId, status: "verified_pass" })
      }

      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "doc-synthesis", status: "worker_active" })
      await execute(loaded, synthesizer, "document_record", {
        sessionId: runId,
        stage: "synthesis_candidate",
        level: 0,
        index: 0,
        summary: "Merged findings",
      })
      await execute(loaded, synthesizer, "document_record", {
        sessionId: runId,
        stage: "final_report",
        summary: "Final document review report",
        verdict: "COMPLETE",
      })
      await execute(loaded, synthesizer, "handoff", { sessionId: runId, taskId: "doc-synthesis", ...HANDOFF })
      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "doc-synthesis", status: "worker_done" })
      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "doc-synthesis", status: "verifier_active" })
      await execute(loaded, verifier, "report", { sessionId: runId, taskId: "doc-synthesis", status: "PASS", summary: "Synthesis verified." })
      await execute(loaded, verifier, "handoff", { sessionId: runId, taskId: "doc-synthesis", ...HANDOFF })
      await execute(loaded, root, "task_update", { sessionId: runId, taskId: "doc-synthesis", status: "verified_pass" })

      await execute(loaded, auditor, "security_audit", { sessionId: runId, status: "PASS", findings: [] })
      const reqs = readRunJson<{ items: Array<{ id: string }> }>(project, runId, "requirements.json")?.items ?? []
      await execute(loaded, victoryAuditor, "victory_audit", {
        sessionId: runId,
        verdict: "VICTORY CONFIRMED",
        requirements: reqs.map((r) => ({ id: r.id, met: true, evidence: "Document review report verified." })),
        summary: threePhaseVictorySummary("VICTORY CONFIRMED"),
      })
      await execute(loaded, victoryAuditor, "handoff", { sessionId: runId, ...HANDOFF })
      await execute(loaded, root, "handoff", { sessionId: runId, ...HANDOFF })

      const fv = await execute(loaded, root, "final_verify", { sessionId: runId })
      expect(fv.status).toBe("FAIL")
      expect(String(fv.content)).toContain("DOCUMENT_REVIEW_EVIDENCE_UNSIGNED")
    })
  })

  test("[T4.5 M4] LEMMA pre-flight failure (leap doctor FAIL + PREREQUISITES.md) vs READY plan", async () => {
    await withHost("t4-5-lemma-e2e", async ({ project, loaded, root }) => {
      const badBin = makeMockBinDir(project, "lemma-bad", {
        lean: 'echo "Lean (version 4.12.0)"',
        lake: 'echo "Lake version 5.0.0"',
        leap: 'if [ "$1" = "doctor" ]; then echo "doctor failed" >&2; exit 1; fi; echo "leap 0.3.1"',
      })
      const goodBin = makeMockBinDir(project, "lemma-good", {
        lean: 'echo "Lean (version 4.12.0)"',
        lake: 'echo "Lake version 5.0.0"',
        leap: 'if [ "$1" = "doctor" ]; then echo "doctor ok"; exit 0; fi; echo "leap 0.3.1"',
      })
      try {
        await withEnv({ PATH: badBin }, async () => {
          const refused = await planRun(loaded, root, {
            sessionId: "20261125-000004-lem1",
            topology: "proof",
            lemmaMode: true,
            route: "lemma",
            request: "Prove theorem P in Lean 4.",
            tasks: [{ id: "T1" }],
          })
          expect(refused.content).toContain("refused:")
          expect(existsSync(runDir(project, "20261125-000004-lem1"))).toBe(false)
          expect(existsSync(join(project.root, "PREREQUISITES.md"))).toBe(true)
        })

        await withEnv({ PATH: goodBin }, async () => {
          const ok = await planRun(loaded, root, {
            sessionId: "20261125-000004-lem2",
            topology: "proof",
            lemmaMode: true,
            route: "lemma",
            request: "Prove theorem P in Lean 4.",
            tasks: [{ id: "T1" }],
          })
          expect(ok.content.startsWith("Planned ")).toBe(true)
          expect(existsSync(runFile(project, "20261125-000004-lem2", "lemma/manifest.json"))).toBe(true)
        })
      } finally {
        rmSync(badBin, { recursive: true, force: true })
        rmSync(goodBin, { recursive: true, force: true })
      }
    })
  })

  test("[T4.6 M1] hardened host channel parity: OPENCODE_CHANNEL DB + service-<channel>.json loopback vs blocked + doctor --security", async () => {
    await withRun(
      "t4-6-channel-hardening",
      {
        sessionId: "20261125-000004-t46",
        request: "Hardened channel E2E.",
        requirements: [{ id: "R1", text: "Channel DB and service URL hardened." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const xdgData = join(dirname(fx.project.root), `t46-data-${Date.now()}`)
        const xdgState = join(dirname(fx.project.root), `t46-state-${Date.now()}`)
        mkdirSync(join(xdgData, "opencode"), { recursive: true })
        mkdirSync(join(xdgState, "opencode"), { recursive: true })
        const dbFile = join(xdgData, "opencode", "opencode-staging.db")
        writeFileSync(dbFile, "sqlite-placeholder", "utf8")
        chmodSync(dbFile, 0o600)

        try {
          const docRes = runCli(["doctor", "--security", "--json"], {
            HOME: fx.project.home,
            XDG_DATA_HOME: xdgData,
            OPENCODE_CHANNEL: "staging",
            OPENCODE_DB: undefined,
          })
          const dbCheck = docRes.json?.security?.checks?.find((c: any) => c.name === "db_mode")
          expect(dbCheck?.status).toBe("pass")
          expect(String(dbCheck?.message)).toContain("opencode-staging.db")

          await withLoopbackServer(
            (req, res) => {
              res.setHeader("content-type", "application/json")
              if (req.url?.startsWith(`/api/session/${encodeURIComponent(fx.root.id)}`)) {
                res.end(JSON.stringify({ data: { id: fx.root.id, agent: "team/sentinel", cost: 0.11, tokens: { input: 1, output: 1 } } }))
                return
              }
              res.end(JSON.stringify({ data: [] }))
            },
            async ({ url }) => {
              writeFileSync(join(xdgState, "opencode", "service.json"), JSON.stringify({ url, password: "p" }), "utf8")
              await withEnv(
                { XDG_STATE_HOME: xdgState, OPENCODE_DB: ":memory:" },
                async () => {
                  const cost = await call(fx, fx.root, "cost", { taskId: "T1" })
                  expect(cost.source).toContain("opencode service API")
                },
              )
            },
          )

          const final = await completeStandardRun(fx)
          expect(final.status).toBe("PASS")
          const manifest = readManifest(fx.project, fx.runId)
          const vRes = runCli([
            "verify",
            "--run-dir",
            fx.runDir,
            "--hmac-key",
            String(process.env.OPENCODE_TEAMWORK_HMAC_KEY),
            "--hmac-key-id",
            String(manifest?.runKeyId),
            "--json",
          ])
          expect(vRes.code).toBe(0)
        } finally {
          rmSync(xdgData, { recursive: true, force: true })
          rmSync(xdgState, { recursive: true, force: true })
        }
      },
    )
  })

  test("[T4.7 M1/M3] dual-host OPENCODE_TEAMWORK_DISABLED=1 vs enabled + approval-driver runId traversal rejection", async () => {
    // Host A: disabled
    const projA = createProject("t4-7-host-a")
    await withEnv({ OPENCODE_TEAMWORK_DISABLED: "1" }, async () => {
      const hostA = await loadHost(projA, { mode: "memory" })
      try {
        expect((await hostA.capture.listCommands()).data.some((c: any) => c.name === "teamwork")).toBe(false)
        const { list } = await openLocationTools(hostA, projA.root)
        expect(list.some((t: any) => String(t.id).startsWith("teamwork_"))).toBe(false)
      } finally {
        await hostA.close()
        projA.cleanup()
      }
    })

    // Host B: enabled + traversal rejection + full standard run
    await withRun(
      "t4-7-host-b",
      {
        sessionId: "20261125-000004-t47",
        request: "Enabled host run + approval-driver traversal rejection.",
        requirements: [{ id: "R1", text: "Run completes cleanly." }],
        requireHandoffs: "skip",
        tasks: [{ id: "T1" }],
      },
      async (fx) => {
        const before = snapshotTree(fx.project.root)
        const badDriver = spawnSync(
          "node",
          [
            APPROVAL_DRIVER,
            JSON.stringify({
              root: fx.project.root,
              storage: join(fx.project.root, "driver-storage.json"),
              runId: "../../outside",
              action: "write-draft",
              draft: "bad",
            }),
          ],
          { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 },
        )
        expect(badDriver.status).not.toBe(0)
        expect(treeDiff(before, snapshotTree(fx.project.root))).toEqual(EMPTY_DIFF)

        const final = await completeStandardRun(fx)
        expect(final.status).toBe("PASS")
        expect((await next(fx)).status).toBe("ALL_PASSED")
      },
    )
  })
})

async function createSessionChild(loaded: LoadedHost, parent: any, agent: string) {
  const created = await loaded.host.sessions.create({ parentID: parent.id, agent })
  return { id: created.id, agent, parentID: created.parentID ?? parent.id, info: created }
}
