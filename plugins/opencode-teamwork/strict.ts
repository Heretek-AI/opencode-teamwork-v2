// opencode-teamwork — opt-in strict verification wave
//
// Zero runtime dependencies. Erasable TypeScript only (compatible with Node
// 22/24/26 `--experimental-strip-types`).
//
// Standard verification is unchanged: a task is verified by the verifier
// report alone. Strict verification additionally requires one adversarial
// challenge (`team/falsifier`) and one independent security audit
// (`team/security-auditor`) per task. The wave is exactly one challenge and
// one audit per task; it scales by adding tasks and iterations (rounds), never
// by hardcoding a fixed 2+2+1 row count.
//
// Security & containment:
//   * Both wave tools derive the caller from the trusted session identity in
//     `tools.ts`; no caller-supplied agent label can self-authorize.
//   * Files are bounded and symlink-safe reads, and atomically written through
//     the tournament containment helpers (`O_NOFOLLOW`, realpath containment).
//   * A verdict binds to the verifier report it approved (sha256). Recording
//     again for the same report hash is write-once; a changed report makes the
//     old verdict stale and is the only overwrite path.
//   * The gate is recomputed from artifacts on every read; it never trusts the
//     caller or a cached summary.

import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import {
  clean,
  cleanBlock,
  readBoundedRunFile,
  readBoundedRunJson,
  writeSafeRunJson,
} from "./tournament.ts"
import type { AuthContext, AuthEnvelope, AuthFailure } from "./auth.ts"

export const VERIFICATION_MODES = ["standard", "strict"] as const
export type VerificationMode = (typeof VERIFICATION_MODES)[number]
export const DEFAULT_VERIFICATION_MODE: VerificationMode = "standard"

export const CHALLENGE_AGENT = "team/falsifier"
export const AUDIT_AGENT = "team/security-auditor"

export const WAVE_KINDS = ["challenge", "audit"] as const
export type WaveKind = (typeof WAVE_KINDS)[number]

export const WAVE_AGENTS: Record<WaveKind, string> = {
  challenge: CHALLENGE_AGENT,
  audit: AUDIT_AGENT,
}

export const WAVE_VERDICTS: Record<WaveKind, string> = {
  challenge: "PASS",
  audit: "CLEAN",
}

const STRICT_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_PLAN_BYTES = 8 * 1024 * 1024
const MAX_REPORT_BYTES = 1024 * 1024
const MAX_WAVE_BYTES = 256 * 1024
const NOTES_MAX = 1000
const EVIDENCE_MAX = 2000
const REPORT_HASH = /^[0-9a-f]{64}$/

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** True when `value` is a recognised verification mode. */
export function normalizeVerificationMode(value: unknown): VerificationMode | undefined {
  return value === "standard" || value === "strict" ? value : undefined
}

/** True when `value` is one of the two strict-wave kinds. */
export function normalizeWaveKind(value: unknown): WaveKind | undefined {
  return value === "challenge" || value === "audit" ? value : undefined
}

/** True when `id` is safe as one run-relative path segment. */
export function isSafeStrictTaskId(id: unknown): id is string {
  return typeof id === "string" && STRICT_TASK_ID.test(id)
}

/**
 * Resolve the run's verification mode from persisted plan/state. A legacy run
 * with no field is standard; strict is never inferred.
 */
export function resolveVerificationMode(
  plan: any,
  state: any,
): { mode: VerificationMode; source: "plan" | "state" | "default" } {
  const fromPlan = normalizeVerificationMode(plan?.verification)
  if (fromPlan) return { mode: fromPlan, source: "plan" }
  const fromState = normalizeVerificationMode(state?.verification)
  if (fromState) return { mode: fromState, source: "state" }
  return { mode: DEFAULT_VERIFICATION_MODE, source: "default" }
}

export interface WaveVerdictFile {
  version: 1
  sessionId: string
  taskId: string
  kind: WaveKind
  verdict: string
  agent: string
  agentSessionId: string
  /** sha256 of the exact verify/report-<taskId>.json bytes this verdict saw. */
  reportHash: string
  notes: string
  evidence: string
  generatedAt: string
  _auth?: AuthEnvelope
}

export type RecordWaveResult =
  | { ok: true; verdict: WaveVerdictFile; artifact: string }
  | { ok: false; error: string }

/**
 * Validate and record one strict-wave verdict. The caller identity is supplied
 * by `tools.ts` from `deriveCallerAgent`; this function enforces the expected
 * agent for the kind as a second boundary.
 */
export async function recordVerificationWave(
  run: string,
  sessionId: string,
  input: {
    taskId: unknown
    kind: unknown
    verdict: unknown
    notes?: unknown
    evidence?: unknown
    agent: string
    agentSessionId: string
  },
  auth?: AuthContext,
): Promise<RecordWaveResult> {
  const kind = normalizeWaveKind(input.kind)
  if (!kind) {
    return {
      ok: false,
      error: `refused: invalid strict-wave kind "${clean(input.kind, 32)}" (expected ${WAVE_KINDS.join(" | ")})`,
    }
  }
  const expectedAgent = WAVE_AGENTS[kind]
  if (input.agent !== expectedAgent) {
    return {
      ok: false,
      error: `refused: a ${kind} verdict must be recorded by ${expectedAgent} (trusted caller: ${clean(input.agent, 64) || "unknown"})`,
    }
  }
  if (!isSafeStrictTaskId(input.taskId)) {
    return {
      ok: false,
      error: `refused: invalid task id "${clean(input.taskId, 32)}" (must be a single segment matching ${STRICT_TASK_ID})`,
    }
  }
  const taskId = input.taskId
  const expectedVerdict = WAVE_VERDICTS[kind]
  if (input.verdict !== expectedVerdict) {
    return {
      ok: false,
      error: `refused: invalid ${kind} verdict "${clean(input.verdict, 32)}" (expected ${expectedVerdict}); nothing was written`,
    }
  }

  // The task must exist in the plan, and its verifier report must already be a
  // PASS: the wave supplements the review, it never replaces it.
  const planRes = readBoundedRunJson<any>(run, join(run, "plan.dag.json"), MAX_PLAN_BYTES)
  if (planRes.status === "absent") {
    return { ok: false, error: `refused: plan.dag.json is missing for run ${basename(run)}; nothing was written` }
  }
  if (planRes.status === "error") {
    return { ok: false, error: `${planRes.error}; nothing was written` }
  }
  const planIds = Array.isArray(planRes.value?.tasks)
    ? planRes.value.tasks.map((t: any) => t?.id).filter((id: unknown) => typeof id === "string")
    : []
  if (!planIds.includes(taskId)) {
    return {
      ok: false,
      error: `refused: task "${clean(taskId, 64)}" is not in plan.dag.json; nothing was written`,
    }
  }
  const reportPath = `verify/report-${taskId}.json`
  const reportRes = readBoundedRunFile(run, join(run, reportPath), MAX_REPORT_BYTES)
  if (reportRes.status === "absent") {
    return {
      ok: false,
      error: `refused: ${reportPath} is missing; a strict ${kind} needs a PASS verifier report first; nothing was written`,
    }
  }
  if (reportRes.status === "error") {
    return { ok: false, error: `${reportRes.error}; nothing was written` }
  }
  let report: any
  try {
    report = JSON.parse(reportRes.text)
  } catch {
    return { ok: false, error: `refused: ${reportPath} is malformed JSON; nothing was written` }
  }
  if (report?.status !== "PASS") {
    return {
      ok: false,
      error: `refused: ${reportPath} reports ${clean(report?.status, 32) || "no status"} (expected PASS); nothing was written`,
    }
  }
  const reportHash = sha256Hex(reportRes.text)

  const relativePath = `verify/${kind}-${taskId}.json`
  const target = join(run, relativePath)
  // Report-bound write-once: the same verifier report may not be re-approved,
  // but a changed report (a reworked task) makes the old verdict stale, and
  // replacing that stale verdict is the only overwrite path.
  const existing = readBoundedRunJson<any>(run, target, MAX_WAVE_BYTES)
  if (existing.status === "ok") {
    const previousHash = typeof existing.value?.reportHash === "string" ? existing.value.reportHash : null
    if (previousHash === reportHash) {
      return {
        ok: false,
        error: `refused: ${relativePath} already records this task's ${kind} verdict for the current verifier report and is write-once; rework the task and re-verify to record a new verdict`,
      }
    }
  }
  if (existing.status === "error") {
    return {
      ok: false,
      error: `refused: ${relativePath} already exists but is unreadable or unsafe (${clean(existing.error, 120)}); it will not be overwritten`,
    }
  }

  const verdict: WaveVerdictFile = {
    version: 1,
    sessionId,
    taskId,
    kind,
    verdict: expectedVerdict,
    agent: expectedAgent,
    agentSessionId: input.agentSessionId,
    reportHash,
    notes: typeof input.notes === "string" ? cleanBlock(input.notes, NOTES_MAX).trim() : "",
    evidence: typeof input.evidence === "string" ? cleanBlock(input.evidence, EVIDENCE_MAX).trim() : "",
    generatedAt: new Date().toISOString(),
  }
  let toWrite: WaveVerdictFile = verdict
  if (auth) {
    try {
      toWrite = await auth.signRunArtifact(basename(run), relativePath, verdict)
    } catch (err: any) {
      const failure = err?.failure as AuthFailure | undefined
      return {
        ok: false,
        error: `refused: could not sign ${relativePath} (${failure ? failure.code : "signing failed"}: ${clean(err?.message, 160)}); nothing was written`,
      }
    }
  }
  try {
    writeSafeRunJson(run, target, toWrite)
  } catch (err: any) {
    return {
      ok: false,
      error: `refused: could not write ${relativePath} (${clean(err?.message, 120)})`,
    }
  }
  return { ok: true, verdict: toWrite, artifact: target }
}

export interface WaveEvidence {
  path: string
  present: boolean
  /** The recorded verdict, or MISSING / INVALID / the bad value found. */
  verdict: string
  agent: string | null
  reportHash: string | null
  ok: boolean
  reasons: string[]
}

export interface StrictTaskEvidence {
  id: string
  workerStatus: string
  reportStatus: "PASS" | "FAIL" | "MISSING"
  challenge: WaveEvidence
  audit: WaveEvidence
}

export interface StrictGate {
  mode: VerificationMode
  skipped: boolean
  ok: boolean
  status: "SKIPPED" | "PASS" | "MISSING" | "FAIL"
  reasons: string[]
  missing: Array<{ taskId: string; kind: WaveKind }>
  tasks: StrictTaskEvidence[]
}

function emptyWave(path: string, verdict: string): WaveEvidence {
  return { path, present: false, verdict, agent: null, reportHash: null, ok: false, reasons: [] }
}

/** Read and validate one wave artifact. Reasons name the task and the file. */
function readWaveEvidence(
  run: string,
  taskId: string,
  kind: WaveKind,
  sessionId: string,
  currentReportHash: string | null,
): WaveEvidence {
  const relativePath = `verify/${kind}-${taskId}.json`
  const path = join(run, relativePath)
  const expectedAgent = WAVE_AGENTS[kind]
  const expectedVerdict = WAVE_VERDICTS[kind]
  const label = `strict ${kind} ${taskId}`
  const res = readBoundedRunJson<any>(run, path, MAX_WAVE_BYTES)
  if (res.status === "absent") {
    return {
      ...emptyWave(relativePath, "MISSING"),
      reasons: [`${label}: ${relativePath} missing`],
    }
  }
  if (res.status === "error") {
    return {
      ...emptyWave(relativePath, "INVALID"),
      reasons: [`${label}: ${clean(res.error, 200)}`],
    }
  }
  const value = res.value
  const reasons: string[] = []
  const rawVerdict = typeof value?.verdict === "string" ? clean(value.verdict, 48) : ""
  const verdict = rawVerdict || "INVALID"
  const agent = typeof value?.agent === "string" ? clean(value.agent, 64) : null
  const reportHash = typeof value?.reportHash === "string" ? value.reportHash : null
  const evidence: WaveEvidence = {
    path: relativePath,
    present: true,
    verdict,
    agent,
    reportHash,
    ok: false,
    reasons,
  }
  if (value?.version !== 1) reasons.push(`${label}: version must be 1 (got ${clean(value?.version, 16) || "none"})`)
  if (value?.sessionId !== sessionId) {
    reasons.push(`${label}: sessionId ${clean(value?.sessionId, 64) || "missing"} does not match ${sessionId}`)
  }
  if (value?.taskId !== taskId) {
    reasons.push(`${label}: taskId ${clean(value?.taskId, 64) || "missing"} does not match ${taskId}`)
  }
  if (value?.kind !== kind) {
    reasons.push(`${label}: kind ${clean(value?.kind, 32) || "missing"} does not match ${kind}`)
  }
  if (rawVerdict !== expectedVerdict) {
    reasons.push(`${label}: verdict ${verdict} (expected ${expectedVerdict})`)
  }
  if (agent !== expectedAgent) {
    reasons.push(`${label}: agent ${agent || "missing"} (expected ${expectedAgent})`)
  }
  if (!reportHash || !REPORT_HASH.test(reportHash)) {
    reasons.push(`${label}: reportHash missing or invalid`)
  } else if (currentReportHash && reportHash !== currentReportHash) {
    reasons.push(`strict ${kind} for ${taskId} is stale (report changed since it was recorded)`)
  }
  if (typeof value?.agentSessionId !== "string" || value.agentSessionId.trim() === "") {
    reasons.push(`${label}: agentSessionId is missing`)
  }
  if (typeof value?.generatedAt !== "string" || value.generatedAt.trim() === "") {
    reasons.push(`${label}: generatedAt is missing`)
  }
  evidence.ok = reasons.length === 0
  return evidence
}

/**
 * Recompute the strict gate from disk. Standard mode is a no-op. Strict mode
 * requires, per task: the verifier report PASS, the challenge PASS from
 * team/falsifier, and the audit CLEAN from team/security-auditor. Both wave
 * verdicts must also bind (reportHash) to the current verifier report bytes.
 */
export function evaluateStrictGate(
  run: string,
  tasks: Array<{ id: string; status: string }>,
  mode: VerificationMode,
): StrictGate {
  if (mode !== "strict") {
    return {
      mode,
      skipped: true,
      ok: true,
      status: "SKIPPED",
      reasons: [],
      missing: [],
      tasks: [],
    }
  }
  const sessionId = basename(run)
  const reasons: string[] = []
  const missing: Array<{ taskId: string; kind: WaveKind }> = []
  const evidence: StrictTaskEvidence[] = []
  for (const task of tasks) {
    const reportRes = readBoundedRunFile(run, join(run, `verify/report-${task.id}.json`), MAX_REPORT_BYTES)
    let reportStatus: StrictTaskEvidence["reportStatus"] = "MISSING"
    let currentReportHash: string | null = null
    if (reportRes.status === "ok") {
      currentReportHash = sha256Hex(reportRes.text)
      try {
        const parsed = JSON.parse(reportRes.text)
        reportStatus = parsed?.status === "PASS" ? "PASS" : parsed?.status === "FAIL" ? "FAIL" : "MISSING"
      } catch {
        reportStatus = "MISSING"
      }
    }
    if (reportStatus !== "PASS") {
      reasons.push(`strict verifier report ${task.id}: ${reportStatus}`)
    }
    const challenge = readWaveEvidence(run, task.id, "challenge", sessionId, currentReportHash)
    if (!challenge.ok) {
      reasons.push(...challenge.reasons)
      missing.push({ taskId: task.id, kind: "challenge" })
    }
    const audit = readWaveEvidence(run, task.id, "audit", sessionId, currentReportHash)
    if (!audit.ok) {
      reasons.push(...audit.reasons)
      missing.push({ taskId: task.id, kind: "audit" })
    }
    evidence.push({
      id: task.id,
      workerStatus: clean(task.status, 32) || "unknown",
      reportStatus,
      challenge,
      audit,
    })
  }
  const anyFileMissing = evidence.some(
    (task) => !task.challenge.present || !task.audit.present,
  )
  const status: StrictGate["status"] =
    reasons.length === 0 ? "PASS" : anyFileMissing ? "MISSING" : "FAIL"
  return {
    mode,
    skipped: false,
    ok: reasons.length === 0,
    status,
    reasons,
    missing,
    tasks: evidence,
  }
}

/**
 * Strict gate with artifact authenticity enforced. Wave verdicts on a signed
 * run must carry a valid `_auth` envelope and digest-index entry. The semantic
 * verdict is still computed so a forged file reports both problems.
 */
export async function evaluateStrictGateChecked(
  run: string,
  tasks: Array<{ id: string; status: string }>,
  mode: VerificationMode,
  opts: { auth?: AuthContext; requireSigned?: boolean } = {},
): Promise<StrictGate> {
  const gate = evaluateStrictGate(run, tasks, mode)
  if (mode !== "strict" || !opts.requireSigned) return gate
  const reasons = [...gate.reasons]
  const missing = [...gate.missing]
  for (const task of tasks) {
    for (const kind of WAVE_KINDS) {
      const relativePath = `verify/${kind}-${task.id}.json`
      const res = readBoundedRunJson<any>(run, join(run, relativePath), MAX_WAVE_BYTES)
      if (res.status !== "ok") continue
      const check = opts.auth
        ? await opts.auth.verifyRunArtifact(basename(run), relativePath, res.value)
        : {
            status: "unknown" as const,
            failure: { code: "AUTH_UNAVAILABLE" as const, message: "no authenticity context is wired for this run" },
          }
      if (check.status === "unsigned") {
        reasons.push(`strict ${kind} ${task.id}: [AUTH_MISSING] ${relativePath} has no _auth envelope (a signed run requires one)`)
      } else if (check.status !== "signed") {
        const failure = check.failure ?? { code: "AUTH_INVALID" as const, message: "wave artifact failed verification" }
        reasons.push(`strict ${kind} ${task.id}: [${failure.code}] ${failure.message}`)
      }
    }
  }
  if (reasons.length === gate.reasons.length) return gate
  const anyFileMissing = gate.tasks.some((task) => !task.challenge.present || !task.audit.present)
  return {
    ...gate,
    ok: false,
    status: anyFileMissing ? "MISSING" : "FAIL",
    reasons,
    missing,
  }
}

function cell(value: unknown): string {
  return clean(value, 200).replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
}

/** Verdict cell: a stale/invalid present artifact is a FAIL, not its old label. */
function gateVerdict(wave: WaveEvidence): string {
  if (wave.ok) return wave.verdict
  return wave.present ? "FAIL" : "MISSING"
}

/**
 * Render the sanitized, human-readable `GATE_STATUS.md` table. One four-row
 * group per task; Source cites the artifact the verdict came from.
 */
export function renderGateStatus(input: {
  sessionId: string
  finalStatus: "PASS" | "FAIL"
  gate: StrictGate
  reasons: string[]
  generatedAt?: string
  handoffs?: {
    mode: "required" | "skip"
    status: string
    entries: Array<{ taskId: string; agent: string; path: string; sha256: string }>
  }
}): string {
  const lines: string[] = [
    "# Verification Gate",
    "",
    `- Session: \`${cell(input.sessionId)}\``,
    `- Mode: strict`,
    `- Generated: ${cell(input.generatedAt ?? new Date().toISOString())}`,
    "",
    "| Agent | Role | Verdict | Source |",
    "| --- | --- | --- | --- |",
  ]
  for (const task of input.gate.tasks) {
    lines.push(
      `| ${cell("team/worker")} | worker | ${cell(task.workerStatus)} | ${cell(`state.json#tasks.${task.id}`)} |`,
    )
    lines.push(
      `| ${cell("team/verifier")} | verifier | ${cell(task.reportStatus)} | ${cell(`verify/report-${task.id}.json`)} |`,
    )
    lines.push(
      `| ${cell(WAVE_AGENTS.challenge)} | challenger | ${cell(gateVerdict(task.challenge))} | ${cell(task.challenge.path)} |`,
    )
    lines.push(
      `| ${cell(WAVE_AGENTS.audit)} | auditor | ${cell(gateVerdict(task.audit))} | ${cell(task.audit.path)} |`,
    )
  }
  lines.push("", `Gate Result: **${input.finalStatus}**`)
  if (input.handoffs) {
    lines.push("", "## Continuity", "")
    if (input.handoffs.mode === "skip") {
      lines.push("Handoffs: **SKIPPED (explicit)**")
    } else {
      lines.push(`Handoffs: **${cell(input.handoffs.status)}** (required)`, "")
      lines.push("| Task | Agent | Handoff | sha256 |")
      lines.push("| --- | --- | --- | --- |")
      for (const entry of input.handoffs.entries) {
        lines.push(
          `| ${cell(entry.taskId)} | ${cell(entry.agent)} | ${cell(entry.path)} | ${cell(entry.sha256)} |`,
        )
      }
    }
  }
  if (input.finalStatus === "FAIL" && input.reasons.length > 0) {
    lines.push("", "## Reasons", "")
    for (const reason of input.reasons.slice(0, 100)) {
      lines.push(`- ${cleanBlock(reason, 300)}`)
    }
  }
  return lines.join("\n") + "\n"
}
