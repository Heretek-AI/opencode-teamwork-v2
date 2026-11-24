// Shared spec helpers. Kept here so each spec group imports the same canonical
// file locations and handoff text instead of drifting copies.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PLUGIN_DIR } from "../harness/project"
import { runFile } from "../harness/plan"
import { execute, type ToolResult } from "../harness/run"

/** The plugin's canonical artifact digest + canonical JSON implementation. */
export async function approvalFormat() {
  return import(pathToFileURL(join(PLUGIN_DIR, "approval-format.mjs")).href)
}

export const HANDOFF = {
  observation: "Observed the fixture artifact on disk.",
  logicChain: "The artifact exists and its hash matched when recorded.",
  caveats: "Fixture narrative only; it is continuity evidence, never a verdict.",
  conclusion: "Done; the next agent can proceed.",
  verificationMethod: "Read the cited artifact and compare its sha256 with handoffs/index.json.",
}

export function isRefused(result: ToolResult): boolean {
  return result.content.startsWith("refused:") || result.status === "ERROR"
}

/** Claim every ready task (root Sentinel). */
export async function claimTasks(fx: any) {
  return execute(fx.loaded, fx.root, "next", { sessionId: fx.runId })
}

/** Record the canonical five-section worker handoff for a task. */
export async function recordWorkerHandoff(fx: any, taskId: string, overrides: Record<string, unknown> = {}) {
  return execute(fx.loaded, fx.worker, "handoff", { sessionId: fx.runId, taskId, ...HANDOFF, ...overrides })
}

/**
 * Drive one claimed task to verified_pass through the real tools:
 * worker_active -> worker handoff -> worker_done -> verifier_active ->
 * verifier PASS report -> verified_pass.
 */
export async function passTask(fx: any, taskId: string, options: { handoff?: boolean } = {}) {
  const active = await execute(fx.loaded, fx.root, "task_update", {
    sessionId: fx.runId,
    taskId,
    status: "worker_active",
  })
  if (!String(active.content).includes("status=worker_active")) throw new Error(`passTask(${taskId}) worker_active: ${active.content}`)
  if (options.handoff !== false) {
    const handoff = await recordWorkerHandoff(fx, taskId)
    if (!handoff.content.startsWith("Handoff recorded:")) throw new Error(`passTask(${taskId}) handoff: ${handoff.content}`)
  }
  for (const status of ["worker_done", "verifier_active"]) {
    const step = await execute(fx.loaded, fx.root, "task_update", { sessionId: fx.runId, taskId, status })
    if (!String(step.content).includes(`status=${status}`)) throw new Error(`passTask(${taskId}) ${status}: ${step.content}`)
  }
  const report = await execute(fx.loaded, fx.verifier, "report", {
    sessionId: fx.runId,
    taskId,
    status: "PASS",
    summary: `Fixture PASS for ${taskId}.`,
    checks: [{ name: "fixture", type: "check", passed: true }],
  })
  if (!String(report.content).includes("VERIFIER REPORT WRITTEN")) throw new Error(`passTask(${taskId}) report: ${report.content}`)
  const pass = await execute(fx.loaded, fx.root, "task_update", {
    sessionId: fx.runId,
    taskId,
    status: "verified_pass",
    verification: { status: "PASS" },
  })
  if (!String(pass.content).includes("status=verified_pass")) throw new Error(`passTask(${taskId}) verified_pass: ${pass.content}`)
  return { report, pass }
}

/** Record a PASS security audit through the trusted auditor session. */
export async function passSecurityAudit(fx: any) {
  return execute(fx.loaded, fx.auditor, "security_audit", { sessionId: fx.runId, status: "PASS", findings: [] })
}

/** Record VICTORY CONFIRMED with one met result per requirement. */
export async function confirmVictory(fx: any) {
  const requirementsFile = JSON.parse(readFileSync(runFile(fx.project, fx.runId, "requirements.json"), "utf8"))
  return execute(fx.loaded, fx.victoryAuditor, "victory_audit", {
    sessionId: fx.runId,
    verdict: "VICTORY CONFIRMED",
    requirements: requirementsFile.items.map((item: any) => ({
      id: item.id,
      met: true,
      evidence: `Fixture evidence for ${item.id}`,
    })),
    summary: "Fixture acceptance audit.",
  })
}
