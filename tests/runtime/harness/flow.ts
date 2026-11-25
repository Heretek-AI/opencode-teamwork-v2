// L3 run driver: real sessions, real git worktrees, real evidence writers.
//
// Every step goes through a tool the plugin registered with the host, called as
// the session that is allowed to call it (Sentinel root, worker, verifier,
// falsifier, security auditor, victory auditor). The helpers throw with the
// tool's own refusal text, so a broken precondition fails the spec loudly
// instead of being papered over.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Project } from "./project"
import {
  commitInWorktree,
  readRunJson,
  readState,
  runFile,
  type RunFixture,
} from "./plan"
import { execute, type ToolResult } from "./run"

const WORKER_ACTIVE = "worker_active"
const WORKER_DONE = "worker_done"
const VERIFIER_ACTIVE = "verifier_active"

function failure(result: ToolResult, label: string): Error {
  return new Error(`${label}: ${result.status ?? "ERROR"} ${result.content || result.error || ""}`.trim())
}

function ok(result: ToolResult, label: string, needle?: string): ToolResult {
  if (result.status === "ERROR" || String(result.content).startsWith("refused:")) throw failure(result, label)
  if (needle && !String(result.content).includes(needle)) throw failure(result, `${label} (expected "${needle}")`)
  return result
}

/** Run one tool as `session`, naming the call in any thrown error. */
export async function call(
  fx: RunFixture,
  session: RunFixture["root"],
  tool: string,
  input: Record<string, unknown> = {},
): Promise<ToolResult> {
  return execute(fx.loaded, session, tool, { sessionId: fx.runId, ...input })
}

/** Sentinel `teamwork_next`, asserted to have answered at all. */
export async function next(fx: RunFixture, session: RunFixture["root"] = fx.root): Promise<ToolResult> {
  const result = await call(fx, session, "next", {})
  if (result.status === "ERROR") throw failure(result, "teamwork_next")
  return result
}

/** One lifecycle transition from the run root. */
export async function transition(
  fx: RunFixture,
  taskId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  return ok(await call(fx, fx.root, "task_update", { taskId, status, ...extra }), `task_update ${taskId} ${status}`, `status=${status}`)
}

/** Set up the task worktree through the plugin's own git manager. */
export async function setupWorktree(
  fx: RunFixture,
  taskId: string,
  role: "worker" | "verifier" = "worker",
): Promise<{ path: string; result: ToolResult }> {
  const result = ok(
    await call(fx, fx.root, "worktree", { action: "setup", role, taskId }),
    `worktree setup ${role} ${taskId}`,
    "worktree ready at:",
  )
  const path = String((result as any).worktreePath ?? taskWorktree(fx.project, fx.runId, taskId))
  return { path, result }
}

function taskWorktree(project: Project, runId: string, taskId: string): string {
  return join(project.worktreesDir, runId, taskId)
}

/** Commit one change in a task worktree; returns the commit sha. */
export function commitChange(worktree: string, relativePath: string, content: string, message: string): string {
  return commitInWorktree(worktree, relativePath, content, message)
}

export interface ReportOptions {
  readonly summary?: string
  readonly checks?: Array<Record<string, unknown>>
  readonly fatalFindings?: Array<Record<string, unknown>>
  readonly feedbackForWorker?: string
  readonly evidence?: string
}

/** A verifier report from the trusted verifier session. */
export async function verifierReport(
  fx: RunFixture,
  taskId: string,
  status: "PASS" | "FAIL",
  options: ReportOptions = {},
): Promise<ToolResult> {
  const input: Record<string, unknown> = {
    taskId,
    status,
    summary: options.summary ?? `${status === "PASS" ? "Fixture PASS" : "Fixture FAIL"} for ${taskId}.`,
    ...(options.checks ? { checks: options.checks } : {}),
    ...(options.fatalFindings ? { fatalFindings: options.fatalFindings } : {}),
    ...(options.feedbackForWorker ? { feedbackForWorker: options.feedbackForWorker } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
  }
  return ok(await call(fx, fx.verifier, "report", input), `report ${taskId} ${status}`, `VERIFIER REPORT WRITTEN: ${taskId} ${status}`)
}

export interface TaskCycleOptions {
  /** Round 1 FAIL then round 2 PASS (the "one retry" path). */
  readonly retry?: boolean
  /** Extra checks recorded on each verifier PASS. */
  readonly passChecks?: Array<Record<string, unknown>>
  /** File name the worker commits. */
  readonly fileName?: string
}

/**
 * Drive one claimed task through the real cycle. With `retry`, the first
 * verifier report is FAIL; the worker then takes round 2 and the second report
 * is PASS. Returns both report results and the worktree path.
 */
export async function taskCycle(
  fx: RunFixture,
  taskId: string,
  options: TaskCycleOptions = {},
): Promise<{ worktree: string; fail?: ToolResult; pass: ToolResult; commits: string[] }> {
  const fileName = options.fileName ?? `src/${taskId.toLowerCase()}.txt`
  await transition(fx, taskId, WORKER_ACTIVE)
  const { path: worktree } = await setupWorktree(fx, taskId)
  const commits: string[] = []

  commits.push(commitChange(worktree, fileName, `${taskId} round 1\n`, `feat(${taskId}): round 1`))
  await transition(fx, taskId, WORKER_DONE)
  await transition(fx, taskId, VERIFIER_ACTIVE)

  let fail: ToolResult | undefined
  if (options.retry) {
    fail = await verifierReport(fx, taskId, "FAIL", {
      fatalFindings: [{ where: fileName, why: "Fixture round-1 defect.", fix: "Address the defect." }],
      feedbackForWorker: "Round 1 defect: fix it and re-submit.",
    })
    await transition(fx, taskId, "verified_fail")
    await transition(fx, taskId, WORKER_ACTIVE)
    commits.push(commitChange(worktree, fileName, `${taskId} round 2\n`, `fix(${taskId}): round 2`))
    await transition(fx, taskId, WORKER_DONE)
    await transition(fx, taskId, VERIFIER_ACTIVE)
  }

  const pass = await verifierReport(fx, taskId, "PASS", {
    summary: `${taskId} meets the recorded acceptance criteria.`,
    checks: options.passChecks ?? [{ name: "fixture-check", type: "check", passed: true }],
  })
  await transition(fx, taskId, "verified_pass")
  return { worktree, ...(fail ? { fail } : {}), pass, commits }
}

/** Run-level security audit, recorded from the trusted auditor session. */
export async function securityAudit(fx: RunFixture, status: "PASS" | "FAIL" = "PASS"): Promise<ToolResult> {
  const result = await call(fx, fx.auditor, "security_audit", {
    status,
    findings: [],
    summary: "Fixture security audit: no findings.",
  })
  return ok(result, `security_audit ${status}`, status === "PASS" ? "SECURITY AUDIT PASSED" : "SECURITY AUDIT FAILED")
}

/** Record a strict wave verdict from the trusted role session. */
export async function waveRecord(
  fx: RunFixture,
  taskId: string,
  kind: "challenge" | "audit",
  cites: string[],
): Promise<ToolResult> {
  const session = kind === "challenge" ? fx.falsifier : fx.auditor
  const verdict = kind === "challenge" ? "PASS" : "CLEAN"
  const result = await call(fx, session, "wave_record", {
    taskId,
    kind,
    verdict,
    cites,
    notes: `Fixture ${kind} reviewed ${cites.join(", ")}.`,
  })
  return ok(result, `wave_record ${taskId} ${kind}`, `STRICT WAVE RECORDED: ${kind}=${verdict}`)
}

/** Write one verify/evidence artifact and return its run-relative path. */
export async function evidence(fx: RunFixture, name: string, content: string): Promise<string> {
  const result = await call(fx, fx.root, "evidence", { name, content })
  ok(result, `evidence ${name}`, "EVIDENCE RECORDED:")
  return `verify/evidence/${name}`
}

export interface VictoryOptions {
  readonly verdict?: "VICTORY CONFIRMED" | "VICTORY REJECTED"
  readonly unmet?: string[]
  readonly findings?: string[]
}

/** Independent victory audit through the trusted victory-auditor session. */
export async function victory(fx: RunFixture, options: VictoryOptions = {}): Promise<ToolResult> {
  const requirements = readRequirements(fx)
  const verdict = options.verdict ?? "VICTORY CONFIRMED"
  const unmet = new Set(options.unmet ?? [])
  const result = await call(fx, fx.victoryAuditor, "victory_audit", {
    verdict,
    requirements: requirements.map((item) => ({
      id: item.id,
      met: !unmet.has(item.id),
      evidence: unmet.has(item.id) ? `Fixture gap for ${item.id}.` : `Fixture evidence for ${item.id}.`,
    })),
    summary: `Fixture acceptance audit (${verdict}).`,
    ...(options.findings ? { findings: options.findings } : {}),
  })
  return ok(result, `victory_audit ${verdict}`, `VICTORY AUDIT RECORDED: ${verdict}`)
}

function readRequirements(fx: RunFixture): Array<{ id: string; text: string }> {
  const file = readRunJson<{ items: Array<{ id: string; text: string }> }>(fx.project, fx.runId, "requirements.json")
  return file?.items ?? []
}

/** Sentinel final verification; returns the structured result untouched. */
export async function finalVerify(fx: RunFixture): Promise<ToolResult> {
  const result = await call(fx, fx.root, "final_verify", {})
  if (result.status === "ERROR") throw failure(result, "final_verify")
  return result
}

export function readFinal(fx: RunFixture): any {
  return readRunJson(fx.project, fx.runId, "verify/final.json")
}

export function state(fx: RunFixture): any {
  return readState(fx.project, fx.runId)
}

function runPath(fx: RunFixture, relativePath: string): string {
  return runFile(fx.project, fx.runId, relativePath)
}

/** Write a file inside the run dir (fixture only; never through a tool). */
export function writeRunFile(fx: RunFixture, relativePath: string, content: string): string {
  const path = runPath(fx, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, "utf8")
  return path
}

export function readRunText(fx: RunFixture, relativePath: string): string {
  return readFileSync(runPath(fx, relativePath), "utf8")
}

/** True when the plan recorded an id for every task in `taskIds`. */
export function plannedTasks(fx: RunFixture): string[] {
  const plan = readRunJson<{ tasks: Array<{ id: string }> }>(fx.project, fx.runId, "plan.dag.json")
  return (plan?.tasks ?? []).map((task) => task.id)
}

/**
 * Drive a standard run end to end: claim, one clean task cycle per task, the
 * run-level security audit, the independent victory audit, and final_verify.
 */
export async function completeStandardRun(
  fx: RunFixture,
  options: { readonly retry?: boolean; readonly passChecks?: Array<Record<string, unknown>> } = {},
): Promise<ToolResult> {
  const claimed = await next(fx)
  if (!String(claimed.content).includes("READY FOR WORKER")) throw failure(claimed, "completeStandardRun claim")
  for (const taskId of plannedTasks(fx)) {
    await taskCycle(fx, taskId, {
      retry: options.retry === true,
      ...(options.passChecks ? { passChecks: options.passChecks } : {}),
    })
  }
  await securityAudit(fx, "PASS")
  await victory(fx, { verdict: "VICTORY CONFIRMED" })
  return finalVerify(fx)
}
