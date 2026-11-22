// opencode-teamwork — LEMMA (Lean 4 formal-proof route) engine helpers
//
// Zero runtime dependencies (node:* built-ins only).
// Erasable TypeScript compatible with Node 22+ `--experimental-strip-types`.

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"

export const MAX_LEMMA_DEPTH = 3
export const MAX_LEMMA_WIDTH = 4
export const MAX_LEMMA_NODES = 24
export const MAX_LEMMA_RETRIES = 4
export const MAX_FORMALIZATION_ROUNDS = 3
export const MAX_LEMMA_FILE_BYTES = 1024 * 1024 // 1 MiB

export const DEFAULT_LEMMA_BOUNDS = {
  maxDepth: 3,
  maxWidth: 4,
  maxNodes: 16,
  maxRetries: 3,
}

export interface LemmaBounds {
  maxDepth: number
  maxWidth: number
  maxNodes: number
  maxRetries: number
}

export type ProbeStatus = "READY" | "MISSING" | "OUTAGE"
export type LemmaBinaryName = "lean" | "lake" | "leap-tools"

export interface BinaryProbeResult {
  name: LemmaBinaryName
  available: boolean
  status: ProbeStatus
  path: string | null
  version: string | null
  error?: string
}

export interface LemmaProbeResult {
  status: ProbeStatus
  ready: boolean
  lean: BinaryProbeResult
  lake: BinaryProbeResult
  leapTools: BinaryProbeResult
  missing: LemmaBinaryName[]
  installInstructions: string
}

export type RouteName =
  | "document-review"
  | "lemma"
  | "massive-proof"
  | "proof"
  | "small-focused"
  | "iterative-coding"
  | "general"

export type CanonicalTopology =
  | "small-focused"
  | "iterative-coding"
  | "distributed-coding"
  | "proof"
  | "massive-proof"
  | "document-review"

export interface RouteClassification {
  route: RouteName
  topology: CanonicalTopology
  lemmaMode: boolean
  reason: string
  signals: {
    hasDocumentReview: boolean
    hasLeanSignal: boolean
    hasExplicitLeanRequest: boolean
  }
}

export const LEMMA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isSafeLemmaId(id: unknown): id is string {
  return typeof id === "string" && LEMMA_ID.test(id) && id !== "." && id !== ".."
}

function asStr(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

export function clean(value: unknown, max = 64): string {
  return asStr(value)
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
    .slice(0, max)
}

export function cleanBlock(value: unknown, max = 2000): string {
  const s = asStr(value).replace(/[\r\x00-\x09\x0b-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s
}

export function refuseSymlink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`refused: refusing to access symlink "${basename(file)}"`)
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e
  }
}

/**
 * Validate a relative path inside `runDir`:
 * - Rejects empty/absolute paths or `..`/`.` segments
 * - Refuses any symlinked component along the path (including dangling target)
 * - Verifies `realpathSync` containment for existing ancestors and target
 */
export function ensureSafeSubpath(runDir: string, relPath: string): { path?: string; error?: string } {
  if (typeof relPath !== "string" || !relPath.trim()) {
    return { error: "refused: empty relative path" }
  }
  if (isAbsolute(relPath)) {
    return { error: "refused: absolute path is not permitted inside run directory" }
  }
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) {
    return { error: `refused: path traversal segment in "${clean(relPath, 80)}"` }
  }
  const absRun = resolve(runDir)
  const target = resolve(absRun, ...parts)
  const rel = relative(absRun, target)
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) {
    return { error: "refused: target path escapes run directory" }
  }

  let runReal: string
  try {
    if (lstatSync(absRun).isSymbolicLink()) {
      return { error: "refused: run directory is a symlink" }
    }
    runReal = realpathSync(absRun)
  } catch {
    return { error: "refused: run directory is not resolvable" }
  }

  let cur = absRun
  for (const part of parts) {
    cur = join(cur, part)
    try {
      const st = lstatSync(cur)
      if (st.isSymbolicLink()) {
        return { error: `refused: symlink encountered at "${clean(relative(absRun, cur), 120)}"` }
      }
      const curReal = realpathSync(cur)
      const relReal = relative(runReal, curReal)
      if (!relReal || isAbsolute(relReal) || relReal.startsWith("..")) {
        return { error: "refused: resolved path escapes run directory" }
      }
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // Non-existent suffix is allowed when preparing to write, provided no existing
        // ancestor was a symlink (checked above).
        continue
      }
      return { error: `refused: cannot inspect "${clean(relative(absRun, cur), 120)}"` }
    }
  }

  return { path: target }
}

/**
 * Read a regular file with O_NOFOLLOW and a strict byte cap (default 1 MiB).
 * Opens the descriptor first with O_NOFOLLOW and runs fstatSync(fd) on the open
 * descriptor so there is no TOCTOU check-then-open race.
 */
export function readBoundedRegular(file: string, maxBytes = MAX_LEMMA_FILE_BYTES): { text?: string; error?: string } {
  let fd: number | null = null
  try {
    const nofollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0
    fd = openSync(file, fsConstants.O_RDONLY | nofollow)
    const st = fstatSync(fd)
    if (!st.isFile()) return { error: `refused: "${basename(file)}" is not a regular file` }
    if (st.size > maxBytes) return { error: `refused: "${basename(file)}" exceeds ${maxBytes} byte read cap` }
    const cap = Math.min(st.size, maxBytes) + 1
    const buf = Buffer.alloc(cap)
    let total = 0
    while (total < cap) {
      const n = readSync(fd, buf, total, cap - total, null)
      if (n === 0) break
      total += n
    }
    if (total > maxBytes) return { error: `refused: "${basename(file)}" exceeds ${maxBytes} byte read cap` }
    return { text: buf.subarray(0, total).toString("utf8") }
  } catch (err: any) {
    if (err?.code === "ENOENT") return { error: `missing: "${basename(file)}" does not exist` }
    if (err?.code === "ELOOP" || err?.code === "EMLINK") return { error: `refused: symlinked file "${basename(file)}"` }
    return { error: `unreadable: "${basename(file)}" (${clean(err?.message, 80)})` }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function writeTextAtomicSafe(runDir: string, relPath: string, content: string): { path?: string; error?: string } {
  const safe = ensureSafeSubpath(runDir, relPath)
  if (safe.error || !safe.path) return { error: safe.error || "refused: unsafe path" }
  const target = safe.path
  refuseSymlink(target)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = target + ".tmp"
  refuseSymlink(tmp)
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, target)
  return { path: target }
}

function writeJsonAtomicSafe(runDir: string, relPath: string, value: unknown): { path?: string; error?: string } {
  return writeTextAtomicSafe(runDir, relPath, JSON.stringify(value, null, 2) + "\n")
}

function readJsonSafe<T>(runDir: string, relPath: string): { value?: T; error?: string } {
  const safe = ensureSafeSubpath(runDir, relPath)
  if (safe.error || !safe.path) return { error: safe.error }
  const r = readBoundedRegular(safe.path)
  if (r.error || r.text === undefined) return { error: r.error }
  try {
    return { value: JSON.parse(r.text) as T }
  } catch {
    return { error: `invalid JSON in ${clean(relPath, 80)}` }
  }
}

// ---------------------------------------------------------------------------
// Toolchain Probe (Lean 4: lean + lake, and leap-tools)
// ---------------------------------------------------------------------------

function resolveExecutableOnPath(binName: string, pathEnv: string | undefined): string | null {
  const dirs = String(pathEnv ?? "")
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, binName)
    try {
      const lst = lstatSync(candidate)
      if (lst.isSymbolicLink()) {
        // elan shims on PATH may be symlinks to the elan binary
        const targetStat = statSync(candidate)
        if (!targetStat.isFile()) continue
      } else if (!lst.isFile()) {
        continue
      }
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function firstNonEmptyLine(text: unknown): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines[0] ?? ""
}

function probeBinary(
  name: "lean" | "lake" | "leap-tools",
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  allowHelpFallback: boolean,
): BinaryProbeResult {
  const resolved = resolveExecutableOnPath(name, env.PATH)
  if (!resolved) {
    return {
      name,
      available: false,
      status: "MISSING",
      path: null,
      version: null,
      error: `${name} not found on PATH`,
    }
  }

  const runProbe = (arg: string): { ok: boolean; output: string; error?: string } => {
    try {
      const out = execFileSync(resolved, [arg], {
        env,
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      return { ok: true, output: out }
    } catch (err: any) {
      const stderr = String(err?.stderr ?? "")
      const stdout = String(err?.stdout ?? "")
      const detail = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout) || err?.code || err?.message || "probe failed"
      return {
        ok: false,
        output: stdout || stderr,
        error: err?.code === "ETIMEDOUT" ? `${name} ${arg} timed out after ${timeoutMs}ms` : clean(detail, 180),
      }
    }
  }

  const primary = runProbe("--version")
  if (primary.ok) {
    const verLine = clean(firstNonEmptyLine(primary.output) || `${name} ready`, 120)
    if (name === "lean" && /\bversion\s+[0-3]\./i.test(verLine)) {
      return {
        name,
        available: false,
        status: "OUTAGE",
        path: resolved,
        version: verLine,
        error: `Lean 4 is required, but ${resolved} reported "${verLine}"`,
      }
    }
    return {
      name,
      available: true,
      status: "READY",
      path: resolved,
      version: verLine,
    }
  }

  if (allowHelpFallback) {
    const fallback = runProbe("--help")
    if (fallback.ok) {
      return {
        name,
        available: true,
        status: "READY",
        path: resolved,
        version: clean(firstNonEmptyLine(fallback.output) || `${name} ready`, 120),
      }
    }
    return {
      name,
      available: false,
      status: "OUTAGE",
      path: resolved,
      version: null,
      error: fallback.error || primary.error || `${name} failed --version and --help`,
    }
  }

  return {
    name,
    available: false,
    status: "OUTAGE",
    path: resolved,
    version: null,
    error: primary.error || `${name} failed --version`,
  }
}

export function buildInstallInstructions(): string {
  return [
    "Required toolchain installation instructions:",
    "1. Lean 4 (`lean` and `lake` via `elan`):",
    "   - Install elan (see https://lean-lang.org/install/):",
    "     curl https://elan.lean-lang.org/elan-init.sh -sSf | sh",
    "   - Set default Lean 4 toolchain and put elan on PATH:",
    "     export PATH=\"$HOME/.elan/bin:$PATH\"",
    "     elan default leanprover/lean4:stable",
    "   - Verify: lean --version && lake --version",
    "2. `leap-tools`:",
    "   - Install leap-tools (via pipx/pip or your LEAP distribution) so `leap-tools` is executable on PATH:",
    "     pipx install leap-tools   # or: pip install leap-tools",
    "   - Verify: leap-tools --version",
  ].join("\n")
}

export function probeLemmaToolchain(options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): LemmaProbeResult {
  const env = options?.env ?? process.env
  const timeoutMs = Math.max(250, Math.min(30000, Number(options?.timeoutMs) || 5000))

  const lean = probeBinary("lean", env, timeoutMs, false)
  const lake = probeBinary("lake", env, timeoutMs, false)
  const leapTools = probeBinary("leap-tools", env, timeoutMs, true)

  const missing: Array<"lean" | "lake" | "leap-tools"> = []
  if (!lean.available) missing.push("lean")
  if (!lake.available) missing.push("lake")
  if (!leapTools.available) missing.push("leap-tools")

  const failedResults = [lean, lake, leapTools].filter((r) => !r.available)
  let status: ProbeStatus = "READY"
  if (failedResults.length > 0) {
    status = failedResults.some((r) => r.status === "MISSING") ? "MISSING" : "OUTAGE"
  }

  return {
    status,
    ready: missing.length === 0,
    lean,
    lake,
    leapTools,
    missing,
    installInstructions: buildInstallInstructions(),
  }
}

export function formatMissingToolchainRefusal(probe: LemmaProbeResult): string {
  const tools = [probe.lean, probe.lake, probe.leapTools]
  const details = tools.map((t) => {
    if (t.available) return `  - ${t.name}: READY (${t.version ?? t.path})`
    return `  - ${t.name}: ${t.status}${t.path ? ` at ${t.path}` : ""} (${t.error ?? "unavailable"})`
  })
  return [
    `refused: LEMMA route requires Lean 4 (lean, lake) and leap-tools, which are not ready (status: ${probe.status}; missing/unusable: ${probe.missing.join(", ")}). Nothing was written; zero budget spent.`,
    "Toolchain probe:",
    ...details,
    "",
    probe.installInstructions,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Priority-ordered explicit opt-in route classifier
// ---------------------------------------------------------------------------

function stripTrailingUnclosedFence(text: string, marker: string): string {
  const idx = text.indexOf(marker)
  if (idx === -1) return text
  return text.slice(0, idx) + " "
}

export function maskFencedCodeBlocks(rawText: string): string {
  const noPairedTicks = rawText.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ")
  const noUnclosedTicks = stripTrailingUnclosedFence(stripTrailingUnclosedFence(noPairedTicks, "```"), "~~~")
  return noUnclosedTicks
    .replace(/``[\s\S]*?``/g, " ")
    .replace(/`([^`\r\n]*)`/g, (_m, inner: string) => {
      const trimmed = inner.trim()
      if (/^(?:sorry|[A-Za-z0-9_./-]+\.lean)$/i.test(trimmed)) return trimmed
      return " "
    })
}

export function hasLeanSignal(rawText: string): boolean {
  if (!rawText) return false
  if (/\b[A-Za-z0-9_./-]+\.lean\b/i.test(rawText)) return true
  if (/\blean\s*4\b/i.test(rawText) || /\bleap-tools\b/i.test(rawText)) return true
  if (/\bLean\b(?!\s+(?:startup|manufacturing|agile|management|methodology|ux|product)\b)/.test(rawText)) return true
  if (
    /\bimport\s+Mathlib\b/.test(rawText) ||
    /:=\s*by\b/.test(rawText) ||
    /\blake\s+build\b/.test(rawText) ||
    /\blakefile\.(?:lean|toml)\b/i.test(rawText) ||
    /\b(?:theorem|lemma)\s+[A-Za-z_][A-Za-z0-9_'.]*[\s\S]{0,200}?:=[\s\S]{0,120}?\b(?:by|sorry|rfl|simp|omega|linarith|exact|apply|intro|cases|induction|ring|norm_num|decide)\b/.test(
      rawText,
    )
  ) {
    return true
  }
  return false
}

const LEAN_TARGET_STR = String.raw`(?:Lean\s*4|Lean(?!\s+(?:startup|manufacturing|agile|management|methodology|ux|product)\b)|[A-Za-z0-9_./-]+\.lean\b)`
const PROVE_IN_LEAN_RE = new RegExp(
  String.raw`\b(?:prove|formalize|formalise|disprove|refute)\b[\s\S]{0,80}?\b(?:in|using|with|via)\s+${LEAN_TARGET_STR}`,
  "i",
)
const CHECK_PROOF_IN_LEAN_RE = new RegExp(
  String.raw`\b(?:verify|typecheck|type-check|kernel[- ]check|check)\b[\s\S]{0,60}?\b(?:proof|theorem|lemma|formalization|formalisation)\b[\s\S]{0,60}?\b(?:in|with|using|via)\s+${LEAN_TARGET_STR}`,
  "i",
)
const NON_PROVE_STYLE_CLAUSE_RE =
  /\b(?:formatting|style|lint(?:ing)?|spelling|indentation|whitespace|syntax\s+highlighting|filename|names?|imports?\s+only)\b/i
const FILE_EXISTS_CLAUSE_RE =
  /\b(?:check|verify)\s+(?:if|whether)\s+[A-Za-z0-9_./-]+\.lean\s+(?:exists|is\s+(?:present|tracked|committed|in))\b/i
const EXPLAIN_ONLY_START_RE = /^\s*(?:what\s+is|how\s+is|explain|describe|summarize|summarise)\b/i

function clauseHasExplicitProofCheck(clause: string): boolean {
  if (NON_PROVE_STYLE_CLAUSE_RE.test(clause) || FILE_EXISTS_CLAUSE_RE.test(clause)) return false
  if (CHECK_PROOF_IN_LEAN_RE.test(clause)) return true
  if (
    /\b(?:verify|typecheck|type-check|kernel[- ]check)\s+(?:the\s+)?(?:(?:proof|theorem|lemma|formalization|formalisation)s?\s+(?:in|of)\s+)?[A-Za-z0-9_./-]*\.lean\b/i.test(
      clause,
    )
  ) {
    return true
  }
  return /\b(?:verify|typecheck|type-check|kernel[- ]check|check)\s+(?:(?:this|the|a)\s+)?[A-Za-z0-9_./-]*\.lean\s+(?:proof|theorem|lemma|formalization|formalisation)\b/i.test(
    clause,
  )
}

export function hasExplicitLeanRequest(proseOnly: string): boolean {
  if (!proseOnly || !proseOnly.trim()) return false

  const hasProseLeanTarget =
    /\blean\s*4\b/i.test(proseOnly) ||
    /\bLean\b(?!\s+(?:startup|manufacturing|agile|management|methodology|ux|product)\b)/.test(proseOnly) ||
    /\b[A-Za-z0-9_./-]+\.lean\b/i.test(proseOnly) ||
    /\bleap-tools\b/i.test(proseOnly) ||
    /\blake\s+build\b/i.test(proseOnly)

  if (!hasProseLeanTarget) return false

  const proveOrFormalize =
    PROVE_IN_LEAN_RE.test(proseOnly) ||
    (!EXPLAIN_ONLY_START_RE.test(proseOnly) &&
      /\b(?:write|produce|create|give|run|build|do)\s+(?:a\s+|the\s+)?(?:Lean\s*4|Lean)\s+(?:formalization|formalisation|proof|verification)\b/i.test(
        proseOnly,
      )) ||
    /\b(?:formalize|formalise)\s+(?:the\s+(?:theorem|lemma|proof|claim|statement)s?\s+(?:in|from)\s+)?[A-Za-z0-9_./-]+\.lean\b/i.test(
      proseOnly,
    )

  const clauses = proseOnly.split(/(?:[;\n]+|\.(?=\s|$)|,\s*(?:then|and\s+then)\s+)/)
  const checkProof = clauses.some((c) => clauseHasExplicitProofCheck(c))

  const completeOrFillSorry =
    /\b(?:complete|finish)\s+(?:the\s+)?(?:proof|formalization|formalisation)\b/i.test(proseOnly) ||
    /\b(?:fill(?:\s+in)?|replace|eliminate|remove|resolve|discharge)\s+(?:the\s+|all\s+)?`?sorry`?s?\b/i.test(
      proseOnly,
    )

  return proveOrFormalize || checkProof || completeOrFillSorry
}

function isDocumentReviewRequest(rawText: string, proseOnly: string, inputs: string[], hasDocument?: boolean): boolean {
  const textForReview = proseOnly || rawText
  if (/\b(?:review|critique)\s+(?:(?:this|the|my)\s+)?(?:pr|pull\s+request|diff|commit|patch|codebase)\b/i.test(textForReview)) {
    return false
  }
  const hasDeliverableVerb =
    /\b(?:review|critique|referee|peer[- ]review|evaluate|assess|summarize|summarise|proofread|annotate|give\s+feedback\s+on)\b/i.test(
      textForReview,
    )
  if (!hasDeliverableVerb) return false

  const docExtRe = /\.(?:pdf|tex|md|markdown|txt|docx|rst|html)\b/i
  const suppliedDocInInputs = inputs.some((item) => docExtRe.test(item) || /^https?:\/\//i.test(item))
  const suppliedDocInText =
    docExtRe.test(textForReview) ||
    /\b(?:this|the|attached|supplied)\s+(?:paper|manuscript|document|draft|report|essay|article|pdf|preprint|notes|spec)\b/i.test(
      textForReview,
    ) ||
    /https?:\/\/\S+/i.test(textForReview)

  return hasDocument === true || suppliedDocInInputs || suppliedDocInText
}

export function classifyRoute(
  input: string | { request?: string; inputs?: string[]; hasDocument?: boolean },
  _root?: string,
): RouteClassification {
  const rawText = typeof input === "string" ? input : String(input?.request ?? "")
  const inputs = typeof input === "string" ? [] : (Array.isArray(input?.inputs) ? input.inputs : []).map(String)
  const hasDocument = typeof input === "string" ? false : input?.hasDocument === true

  const proseOnly = maskFencedCodeBlocks(rawText)
  const docReview = isDocumentReviewRequest(rawText, proseOnly, inputs, hasDocument)
  const leanSignal = hasLeanSignal(proseOnly) || inputs.some((i) => /\.lean\b/i.test(i))
  const explicitLean = hasExplicitLeanRequest(proseOnly)

  // Priority 1: document-review FIRST (math/Lean papers submitted for critique stay document-review)
  if (docReview) {
    return {
      route: "document-review",
      topology: "document-review",
      lemmaMode: false,
      reason: "Priority 1: supplied document with review/critique deliverable.",
      signals: { hasDocumentReview: true, hasLeanSignal: leanSignal, hasExplicitLeanRequest: explicitLean },
    }
  }

  // Priority 2: LEMMA (Lean signal + explicit Lean prove/formalize/verify/check request in prose)
  if (leanSignal && explicitLean) {
    return {
      route: "lemma",
      topology: "proof",
      lemmaMode: true,
      reason: "Priority 2: explicit Lean 4 formal-proof/verification request.",
      signals: { hasDocumentReview: false, hasLeanSignal: true, hasExplicitLeanRequest: true },
    }
  }

  // Priority 3: Lean signal WITHOUT explicit Lean proof/verification request -> General (NOT proof!)
  if (leanSignal && !explicitLean) {
    return {
      route: "general",
      topology: "distributed-coding",
      lemmaMode: false,
      reason: "Priority 3: Lean/.lean reference without explicit Lean prove/verify opt-in -> general (distributed-coding).",
      signals: { hasDocumentReview: false, hasLeanSignal: true, hasExplicitLeanRequest: false },
    }
  }

  // Priority 4: massive-proof (explicit large-team opt-in)
  if (/\b(?:massive-proof|100\+\s*searchers|massively\s+parallel\s+proof|unlimited\s+budget)\b/i.test(proseOnly)) {
    return {
      route: "massive-proof",
      topology: "massive-proof",
      lemmaMode: false,
      reason: "Priority 4: explicit massive-proof large-team opt-in.",
      signals: { hasDocumentReview: false, hasLeanSignal: false, hasExplicitLeanRequest: false },
    }
  }

  // Priority 5: natural-language proof (lemmaMode: false)
  if (
    /\b(?:prove\s+that|show\s+that|conjecture|open\s+problem|coq|isabelle)\b/i.test(proseOnly) ||
    /[∀∃]/.test(proseOnly)
  ) {
    return {
      route: "proof",
      topology: "proof",
      lemmaMode: false,
      reason: "Priority 5: natural-language / non-Lean mathematical proof request.",
      signals: { hasDocumentReview: false, hasLeanSignal: false, hasExplicitLeanRequest: false },
    }
  }

  // Priority 6: small-focused / iterative-coding
  if (/\b(?:small-focused|typo|rename\s+this|one-liner|tweak\s+this\s+one\s+function)\b/i.test(proseOnly)) {
    return {
      route: "small-focused",
      topology: "small-focused",
      lemmaMode: false,
      reason: "Priority 6: small focused single-change task.",
      signals: { hasDocumentReview: false, hasLeanSignal: false, hasExplicitLeanRequest: false },
    }
  }
  if (/\b(?:iterative-coding|fix\s+bug|unit\s+test|tdd|tight\s+loop)\b/i.test(proseOnly)) {
    return {
      route: "iterative-coding",
      topology: "iterative-coding",
      lemmaMode: false,
      reason: "Priority 6: iterative single-module coding task.",
      signals: { hasDocumentReview: false, hasLeanSignal: false, hasExplicitLeanRequest: false },
    }
  }

  // Priority 7: general (distributed-coding)
  return {
    route: "general",
    topology: "distributed-coding",
    lemmaMode: false,
    reason: "Priority 7: default general engineering route (distributed-coding).",
    signals: { hasDocumentReview: false, hasLeanSignal: false, hasExplicitLeanRequest: false },
  }
}

// ---------------------------------------------------------------------------
// Lean 4 comment stripping, proof-hole detection, and real verification
// ---------------------------------------------------------------------------

/**
 * Lexical pass over Lean 4 source: strips `-- ...` line comments and nested
 * `/- ... -/` block comments, handles Char literals (`'"'`) so quotes inside
 * Char literals do not open strings, and optionally strips string literal
 * interiors (`"..."` -> `""`, preserving newlines).
 */
function scanLeanSource(source: string, stripStrings: boolean): string {
  let out = ""
  let blockDepth = 0
  let inLine = false
  let inString = false

  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const n = source[i + 1]

    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += "\n"
      }
      continue
    }

    if (blockDepth > 0) {
      if (c === "/" && n === "-") {
        blockDepth++
        i++
        continue
      }
      if (c === "-" && n === "/") {
        blockDepth--
        i++
        out += " "
        continue
      }
      out += c === "\n" ? "\n" : " "
      continue
    }

    if (inString) {
      if (c === "\\") {
        if (n !== undefined) {
          if (!stripStrings) out += c + n
          else if (n === "\n") out += "\n"
          i++
        } else if (!stripStrings) {
          out += c
        }
      } else if (c === '"') {
        inString = false
        out += '"'
      } else if (!stripStrings) {
        out += c
      } else if (c === "\n") {
        out += "\n"
      }
      continue
    }

    // Handle Lean 4 Char literals like `'"'` when `'` is not a trailing identifier prime.
    if (c === "'" && (i === 0 || !/[A-Za-z0-9_.'»]/.test(source[i - 1]))) {
      const charLit = source.slice(i).match(/^'(?:[^'\\\r\n]|\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[^\r\n]))'/)
      if (charLit) {
        out += stripStrings ? "' '" : charLit[0]
        i += charLit[0].length - 1
        continue
      }
    }

    if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && n === "-") {
      blockDepth = 1
      i++
      out += " "
    } else if (c === "-" && n === "-") {
      inLine = true
      i++
    } else {
      out += c
    }
  }

  return out
}

/**
 * Strip Lean 4 line comments (`-- ...`) and nested block comments (`/- ... -/`)
 * while preserving string literals (`"..."`) and line breaks.
 */
export function stripLeanComments(source: string): string {
  return scanLeanSource(source, false)
}

/**
 * Strip Lean 4 comments AND string literal interiors (`"..."` -> `""`) so
 * proof-hole and axiom scans never false-positive on strings or comments.
 */
export function stripLeanCommentsAndStrings(source: string): string {
  return scanLeanSource(source, true)
}

export interface ProofHoleCheck {
  hasSorry: boolean
  hasAdmit: boolean
  hasUnauthorizedAxiom: boolean
  findings: string[]
}

function stripGuillemets(name: string): string {
  return name.startsWith("«") && name.endsWith("»") && name.length >= 2 ? name.slice(1, -1) : name
}

export function detectLeanProofHoles(
  source: string,
  compilerOutput = "",
  allowedAxioms: string[] = [],
): ProofHoleCheck {
  const codeOnly = stripLeanCommentsAndStrings(source)
  const allowed = new Set<string>()
  for (const a of allowedAxioms) {
    const trimmed = String(a).trim()
    if (!trimmed) continue
    allowed.add(trimmed)
    allowed.add(stripGuillemets(trimmed))
  }
  const findings: string[] = []
  let hasSorry = false
  let hasAdmit = false
  let hasUnauthorizedAxiom = false

  if (/\bsorry\b/.test(codeOnly)) {
    hasSorry = true
    findings.push("source contains 'sorry'")
  }
  if (/\bsorryAx\b/.test(codeOnly)) {
    hasSorry = true
    findings.push("source references 'sorryAx'")
  }
  if (/\badmit\b/.test(codeOnly)) {
    hasAdmit = true
    findings.push("source contains 'admit'")
  }

  // Match `axiom <name>` anywhere outside comments/strings (handles noncomputable,
  // unsafe, @[extern ...], @[simp], same-line declarations, «guillemets», and Unicode).
  for (const m of codeOnly.matchAll(/\baxiom\b\s+(«[^»]+»|[^\s:({[]+)/g)) {
    const axName = m[1]
    if (!allowed.has(axName) && !allowed.has(stripGuillemets(axName))) {
      hasUnauthorizedAxiom = true
      findings.push(`unauthorized axiom declaration: ${clean(axName, 64)}`)
    }
  }

  if (/declaration uses 'sorry'/i.test(compilerOutput) || /\buses 'sorry'/i.test(compilerOutput) || /\bsorryAx\b/.test(compilerOutput)) {
    hasSorry = true
    if (!findings.some((f) => f.includes("compiler"))) {
      findings.push("compiler reported use of 'sorry'")
    }
  }
  if (/\badmit\b/i.test(compilerOutput) && /warning|error/i.test(compilerOutput)) {
    hasAdmit = true
    findings.push("compiler reported 'admit'")
  }

  return { hasSorry, hasAdmit, hasUnauthorizedAxiom, findings }
}

export interface LeanVerifyOptions {
  filePath: string
  cwd?: string
  mode?: "lean" | "lake-env-lean" | "lake-build"
  lakeTarget?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  allowedAxioms?: string[]
  allowSorry?: boolean
}

export interface LeanVerifyResult {
  executed: boolean
  status: "PASS" | "FAIL"
  exitCode: number
  hasSorry: boolean
  hasAdmit: boolean
  hasUnauthorizedAxiom: boolean
  findings: string[]
  stdout: string
  stderr: string
  toolVersion: string | null
  timestamp: string
  error?: string
}

export function verifyLeanFile(options: LeanVerifyOptions): LeanVerifyResult {
  const env = options.env ?? process.env
  const timeoutMs = Math.max(500, Math.min(120000, Number(options.timeoutMs) || 30000))
  const mode = options.mode ?? "lean"
  const timestamp = new Date().toISOString()

  const read = readBoundedRegular(options.filePath)
  if (read.error || read.text === undefined) {
    return {
      executed: false,
      status: "FAIL",
      exitCode: -1,
      hasSorry: false,
      hasAdmit: false,
      hasUnauthorizedAxiom: false,
      findings: [read.error ?? "could not read Lean file"],
      stdout: "",
      stderr: "",
      toolVersion: null,
      timestamp,
      error: read.error,
    }
  }

  const binName = mode === "lean" ? "lean" : "lake"
  const binPath = resolveExecutableOnPath(binName, env.PATH)
  if (!binPath) {
    return {
      executed: false,
      status: "FAIL",
      exitCode: -1,
      hasSorry: false,
      hasAdmit: false,
      hasUnauthorizedAxiom: false,
      findings: [`${binName} executable not found on PATH`],
      stdout: "",
      stderr: "",
      toolVersion: null,
      timestamp,
      error: `${binName} not found on PATH`,
    }
  }

  let toolVersion: string | null = null
  try {
    toolVersion = clean(
      firstNonEmptyLine(
        execFileSync(binPath, ["--version"], { env, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
      ),
      120,
    )
  } catch {}

  let args: string[]
  if (mode === "lean") {
    args = [options.filePath]
  } else if (mode === "lake-env-lean") {
    args = ["env", "lean", options.filePath]
  } else if (options.lakeTarget) {
    args = ["build", options.lakeTarget]
  } else {
    args = ["build"]
  }

  const runDirCwd = options.cwd ?? dirname(options.filePath)
  const proc = spawnSync(binPath, args, {
    cwd: runDirCwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  })

  let stdout = typeof proc.stdout === "string" ? proc.stdout : String(proc.stdout ?? "")
  let stderr = typeof proc.stderr === "string" ? proc.stderr : String(proc.stderr ?? "")
  let exitCode = typeof proc.status === "number" ? proc.status : -1
  let execFailed = false
  let execErrorMsg = ""

  if (proc.error) {
    execFailed = true
    exitCode = typeof proc.status === "number" ? proc.status : -1
    const errCode = (proc.error as any)?.code
    execErrorMsg =
      errCode === "ETIMEDOUT"
        ? `${binName} timed out after ${timeoutMs}ms`
        : clean(proc.error.message || errCode || `${binName} execution failed`, 200)
  } else if (proc.status === null) {
    execFailed = true
    exitCode = -1
    execErrorMsg = `${binName} terminated by signal ${proc.signal ?? "unknown"}`
  }

  // In lake-build mode without an explicit target covering the file, also check the exact file via `lake env lean`
  if (!execFailed && exitCode === 0 && mode === "lake-build" && !options.lakeTarget) {
    const fileProc = spawnSync(binPath, ["env", "lean", options.filePath], {
      cwd: runDirCwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    const fStdout = typeof fileProc.stdout === "string" ? fileProc.stdout : String(fileProc.stdout ?? "")
    const fStderr = typeof fileProc.stderr === "string" ? fileProc.stderr : String(fileProc.stderr ?? "")
    stdout = [stdout, fStdout].filter(Boolean).join("\n")
    stderr = [stderr, fStderr].filter(Boolean).join("\n")
    if (fileProc.error) {
      execFailed = true
      exitCode = typeof fileProc.status === "number" ? fileProc.status : -1
      const errCode = (fileProc.error as any)?.code
      execErrorMsg =
        errCode === "ETIMEDOUT"
          ? `lake env lean timed out after ${timeoutMs}ms`
          : clean(fileProc.error.message || errCode || "lake env lean execution failed", 200)
    } else if (fileProc.status === null) {
      execFailed = true
      exitCode = -1
      execErrorMsg = `lake env lean terminated by signal ${fileProc.signal ?? "unknown"}`
    } else if (typeof fileProc.status === "number" && fileProc.status !== 0) {
      exitCode = fileProc.status
    }
  }

  if (execFailed) {
    return {
      executed: false,
      status: "FAIL",
      exitCode,
      hasSorry: false,
      hasAdmit: false,
      hasUnauthorizedAxiom: false,
      findings: [execErrorMsg || `${binName} failed to execute`],
      stdout: cleanBlock(stdout, 4000),
      stderr: cleanBlock(stderr, 4000),
      toolVersion,
      timestamp,
      error: execErrorMsg,
    }
  }

  const combined = `${stdout}\n${stderr}`
  const holes = detectLeanProofHoles(read.text, combined, options.allowedAxioms ?? [])
  const findings = [...holes.findings]
  if (exitCode !== 0) {
    findings.unshift(`${binName} exited with status ${exitCode}`)
  }

  const holesBlocked = options.allowSorry ? (holes.hasAdmit || holes.hasUnauthorizedAxiom) : (holes.hasSorry || holes.hasAdmit || holes.hasUnauthorizedAxiom)
  const passed = exitCode === 0 && !holesBlocked

  return {
    executed: true,
    status: passed ? "PASS" : "FAIL",
    exitCode,
    hasSorry: holes.hasSorry,
    hasAdmit: holes.hasAdmit,
    hasUnauthorizedAxiom: holes.hasUnauthorizedAxiom,
    findings,
    stdout: cleanBlock(stdout, 4000),
    stderr: cleanBlock(stderr, 4000),
    toolVersion,
    timestamp,
  }
}

// ---------------------------------------------------------------------------
// Bounded lemma decomposition tree & formalization gate state
// ---------------------------------------------------------------------------

export function validateLemmaBounds(raw?: any): { bounds?: LemmaBounds; error?: string } {
  if (raw === undefined || raw === null) {
    return { bounds: { ...DEFAULT_LEMMA_BOUNDS } }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "refused: lemmaBounds must be an object" }
  }
  const checkInt = (val: unknown, fallback: number, max: number, label: string): number | string => {
    if (val === undefined || val === null) return fallback
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > max) {
      return `refused: invalid lemmaBounds.${label} "${clean(val, 24)}" (must be integer 1..${max})`
    }
    return val
  }

  const maxDepth = checkInt(raw.maxDepth, DEFAULT_LEMMA_BOUNDS.maxDepth, MAX_LEMMA_DEPTH, "maxDepth")
  if (typeof maxDepth === "string") return { error: maxDepth }
  const maxWidth = checkInt(raw.maxWidth, DEFAULT_LEMMA_BOUNDS.maxWidth, MAX_LEMMA_WIDTH, "maxWidth")
  if (typeof maxWidth === "string") return { error: maxWidth }
  const maxNodes = checkInt(raw.maxNodes, DEFAULT_LEMMA_BOUNDS.maxNodes, MAX_LEMMA_NODES, "maxNodes")
  if (typeof maxNodes === "string") return { error: maxNodes }
  const maxRetries = checkInt(raw.maxRetries, DEFAULT_LEMMA_BOUNDS.maxRetries, MAX_LEMMA_RETRIES, "maxRetries")
  if (typeof maxRetries === "string") return { error: maxRetries }

  return { bounds: { maxDepth, maxWidth, maxNodes, maxRetries } }
}

export interface LemmaNodeRecord {
  id: string
  parentId: string | null
  depth: number
  statement: string
  status: "pending" | "informal" | "formal" | "disprove" | "review" | "proved" | "disproved" | "blocked"
  attempts: number
  verifiedRound: number | null
  latestVerify: string | null
  children: string[]
  updatedAt: string
}

export interface LemmaManifest {
  version: number
  sessionId: string
  phase: "FORMALIZE" | "SOLVING" | "VERIFIED" | "BLOCKED"
  bounds: LemmaBounds & { maxFormalizationRounds: number }
  toolchain: {
    status: ProbeStatus
    lean: string | null
    lake: string | null
    leapTools: string | null
  }
  formalizationRounds: number
  nodes: Record<string, LemmaNodeRecord>
  updatedAt: string
}

export interface FormalizationReviewFile {
  rounds: Array<{
    round: number
    phase: "preSearch" | "final"
    verdict: string
    reviewer: string
    notes: string
    draftCompiled?: boolean
    timestamp: string
  }>
  draftVerification: {
    executed: boolean
    exitCode: number
    compiled: boolean
    draftHash?: string
    findings: string[]
    timestamp: string
  } | null
  preSearch: {
    verdict: "APPROVE" | "REQUEST_CHANGES"
    reviewer: string
    notes: string
    problemHash?: string
    timestamp: string
  } | null
  final: {
    verdict: "FAITHFUL" | "UNFAITHFUL" | "MISFORMALIZED"
    reviewer: string
    notes: string
    problemHash?: string
    timestamp: string
  } | null
}

function emptyManifest(sessionId: string, bounds: LemmaBounds, probe: LemmaProbeResult): LemmaManifest {
  return {
    version: 1,
    sessionId: clean(sessionId, 64),
    phase: "FORMALIZE",
    bounds: { ...bounds, maxFormalizationRounds: MAX_FORMALIZATION_ROUNDS },
    toolchain: {
      status: probe.status,
      lean: probe.lean.version,
      lake: probe.lake.version,
      leapTools: probe.leapTools.version,
    },
    formalizationRounds: 0,
    nodes: {},
    updatedAt: new Date().toISOString(),
  }
}

export function initLemmaArtifacts(
  runDir: string,
  sessionId: string,
  bounds: LemmaBounds,
  probe: LemmaProbeResult,
): { error?: string } {
  const existing = ensureSafeSubpath(runDir, "lemma/manifest.json")
  if (existing.error) return { error: existing.error }
  if (!existsSync(existing.path!)) {
    const w1 = writeJsonAtomicSafe(runDir, "lemma/manifest.json", emptyManifest(sessionId, bounds, probe))
    if (w1.error) return { error: w1.error }
  }
  const rev = ensureSafeSubpath(runDir, "lemma/formalization-review.json")
  if (rev.error) return { error: rev.error }
  if (!existsSync(rev.path!)) {
    const initRev: FormalizationReviewFile = {
      rounds: [],
      draftVerification: null,
      preSearch: null,
      final: null,
    }
    const w2 = writeJsonAtomicSafe(runDir, "lemma/formalization-review.json", initRev)
    if (w2.error) return { error: w2.error }
  }
  return {}
}

export function recordFormalizationDraft(
  runDir: string,
  leanCode: string,
  options?: { env?: NodeJS.ProcessEnv; verifyDraft?: boolean; cwd?: string; mode?: "lean" | "lake-env-lean" },
): { compiled?: boolean; exitCode?: number; error?: string; findings?: string[] } {
  if (typeof leanCode !== "string" || !leanCode.trim()) {
    return { error: "refused: leanCode must be non-empty" }
  }
  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json missing" }
  const manifest = mRead.value

  if (manifest.formalizationRounds >= (manifest.bounds.maxFormalizationRounds || MAX_FORMALIZATION_ROUNDS)) {
    return { error: `refused: formalization round limit (${MAX_FORMALIZATION_ROUNDS}) reached` }
  }

  const normalizedLean = leanCode.endsWith("\n") ? leanCode : leanCode + "\n"
  const wDraft = writeTextAtomicSafe(runDir, "lemma/problem_draft.lean", normalizedLean)
  if (wDraft.error || !wDraft.path) return { error: wDraft.error ?? "failed to write problem_draft.lean" }
  const draftHash = createHash("sha256").update(normalizedLean, "utf8").digest("hex")

  const rRead = readJsonSafe<FormalizationReviewFile>(runDir, "lemma/formalization-review.json")
  const review: FormalizationReviewFile = rRead.value ?? { rounds: [], draftVerification: null, preSearch: null, final: null }
  // Always invalidate any previous draft verification when writing a new draft.
  review.draftVerification = null

  let compiled = false
  let exitCode = -1
  let findings: string[] = ["draft verification skipped (verifyDraft=false)"]
  if (options?.verifyDraft !== false) {
    // Phase 0 formalization draft may contain placeholder `sorry` in the proof body;
    // it must elaborate/compile with exitCode === 0.
    const v = verifyLeanFile({
      filePath: wDraft.path,
      cwd: options?.cwd ?? dirname(wDraft.path),
      mode: options?.mode === "lake-env-lean" ? "lake-env-lean" : "lean",
      env: options?.env,
      allowSorry: true,
    })
    compiled = v.executed && v.exitCode === 0
    exitCode = v.exitCode
    findings = v.findings
    review.draftVerification = {
      executed: v.executed,
      exitCode: v.exitCode,
      compiled,
      draftHash,
      findings: v.findings.map((f) => clean(f, 200)),
      timestamp: v.timestamp,
    }
  }

  manifest.updatedAt = new Date().toISOString()
  const wRev = writeJsonAtomicSafe(runDir, "lemma/formalization-review.json", review)
  if (wRev.error) return { error: wRev.error }
  const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
  if (wMan.error) return { error: wMan.error }

  return { compiled, exitCode, findings }
}

export function recordFormalizationPreReview(
  runDir: string,
  verdict: string,
  notes: string,
  reviewer = "team/formalization-reviewer",
): { promoted?: boolean; phase?: string; error?: string } {
  const norm = clean(verdict, 32).toUpperCase()
  if (norm !== "APPROVE" && norm !== "REQUEST_CHANGES") {
    return { error: `refused: preSearch verdict must be APPROVE or REQUEST_CHANGES (got "${clean(verdict, 32)}")` }
  }
  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json missing" }
  const manifest = mRead.value

  const draftSafe = ensureSafeSubpath(runDir, "lemma/problem_draft.lean")
  if (draftSafe.error || !draftSafe.path) return { error: draftSafe.error }
  const draftRead = readBoundedRegular(draftSafe.path)
  if (draftRead.error || draftRead.text === undefined || !draftRead.text.trim()) {
    return { error: "refused: cannot review formalization without non-empty lemma/problem_draft.lean" }
  }

  const rRead = readJsonSafe<FormalizationReviewFile>(runDir, "lemma/formalization-review.json")
  const review: FormalizationReviewFile = rRead.value ?? { rounds: [], draftVerification: null, preSearch: null, final: null }

  if (norm === "APPROVE") {
    const currentDraftHash = createHash("sha256").update(draftRead.text, "utf8").digest("hex")
    if (!review.draftVerification) {
      return {
        error:
          "refused: cannot APPROVE promotion to lemma/problem.lean because problem_draft.lean has not been verified (re-run action=\"draft\" with verifyDraft=true)",
      }
    }
    if (review.draftVerification.draftHash !== currentDraftHash) {
      return {
        error:
          "refused: cannot APPROVE promotion to lemma/problem.lean because problem_draft.lean changed since last verified draft (re-run action=\"draft\" with verifyDraft=true)",
      }
    }
    if (!review.draftVerification.compiled) {
      return { error: "refused: cannot APPROVE promotion to lemma/problem.lean because problem_draft.lean failed Lean compilation" }
    }
  }

  if (manifest.formalizationRounds >= (manifest.bounds.maxFormalizationRounds || MAX_FORMALIZATION_ROUNDS)) {
    return { error: `refused: formalization round limit (${MAX_FORMALIZATION_ROUNDS}) exceeded` }
  }

  const nextRound = manifest.formalizationRounds + 1
  const now = new Date().toISOString()
  manifest.formalizationRounds = nextRound
  review.rounds.push({
    round: nextRound,
    phase: "preSearch",
    verdict: norm,
    reviewer: clean(reviewer, 64),
    notes: clean(notes, 500),
    draftCompiled: review.draftVerification?.compiled,
    timestamp: now,
  })
  review.preSearch = {
    verdict: norm as "APPROVE" | "REQUEST_CHANGES",
    reviewer: clean(reviewer, 64),
    notes: clean(notes, 500),
    timestamp: now,
  }

  let promoted = false
  if (norm === "APPROVE") {
    const promotedHash = createHash("sha256").update(draftRead.text, "utf8").digest("hex")
    const wProb = writeTextAtomicSafe(runDir, "lemma/problem.lean", draftRead.text)
    if (wProb.error) return { error: wProb.error }
    review.preSearch.problemHash = promotedHash
    // Promoting a new formalization invalidates any previous final faithfulness review for a different problem digest.
    if (review.final && review.final.problemHash !== promotedHash) {
      review.final = null
    }
    manifest.phase = "SOLVING"
    promoted = true
  } else if (nextRound >= (manifest.bounds.maxFormalizationRounds || MAX_FORMALIZATION_ROUNDS)) {
    manifest.phase = "BLOCKED"
  }

  manifest.updatedAt = now
  const wRev = writeJsonAtomicSafe(runDir, "lemma/formalization-review.json", review)
  if (wRev.error) return { error: wRev.error }
  const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
  if (wMan.error) return { error: wMan.error }

  return { promoted, phase: manifest.phase }
}

export function recordFormalizationFinalReview(
  runDir: string,
  verdict: string,
  notes: string,
  reviewer = "team/formalization-reviewer",
): { phase?: string; error?: string } {
  const norm = clean(verdict, 32).toUpperCase()
  if (norm !== "FAITHFUL" && norm !== "UNFAITHFUL" && norm !== "MISFORMALIZED") {
    return { error: `refused: final verdict must be FAITHFUL, UNFAITHFUL, or MISFORMALIZED (got "${clean(verdict, 32)}")` }
  }
  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json missing" }
  const manifest = mRead.value

  let problemHash: string | undefined
  const probSafe = ensureSafeSubpath(runDir, "lemma/problem.lean")
  if (!probSafe.error && probSafe.path) {
    const probRead = readBoundedRegular(probSafe.path)
    if (!probRead.error && probRead.text) {
      problemHash = createHash("sha256").update(probRead.text, "utf8").digest("hex")
    }
  }

  const rRead = readJsonSafe<FormalizationReviewFile>(runDir, "lemma/formalization-review.json")
  const review: FormalizationReviewFile = rRead.value ?? { rounds: [], draftVerification: null, preSearch: null, final: null }
  const now = new Date().toISOString()

  review.rounds.push({
    round: review.rounds.length + 1,
    phase: "final",
    verdict: norm,
    reviewer: clean(reviewer, 64),
    notes: clean(notes, 500),
    timestamp: now,
  })
  review.final = {
    verdict: norm as "FAITHFUL" | "UNFAITHFUL" | "MISFORMALIZED",
    reviewer: clean(reviewer, 64),
    notes: clean(notes, 500),
    ...(problemHash ? { problemHash } : {}),
    timestamp: now,
  }
  if (norm === "UNFAITHFUL" || norm === "MISFORMALIZED") {
    manifest.phase = "BLOCKED"
  }
  manifest.updatedAt = now
  const wRev = writeJsonAtomicSafe(runDir, "lemma/formalization-review.json", review)
  if (wRev.error) return { error: wRev.error }
  const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
  if (wMan.error) return { error: wMan.error }
  return { phase: manifest.phase }
}

const VALID_NODE_STATUSES = new Set(["pending", "informal", "formal", "disprove", "review", "proved", "disproved", "blocked"])

export function mutateLemmaNode(
  runDir: string,
  params: {
    action: "create" | "update" | "blueprint" | "attempt"
    lemmaId: string
    parentId?: string | null
    statement?: string
    status?: string
    blueprint?: string
    leanCode?: string
    round?: number
  },
): { node?: LemmaNodeRecord; attemptFile?: string; error?: string } {
  if (!isSafeLemmaId(params.lemmaId)) {
    return { error: `refused: invalid lemmaId "${clean(params.lemmaId, 32)}" (must match ${LEMMA_ID})` }
  }
  if (params.parentId !== undefined && params.parentId !== null && !isSafeLemmaId(params.parentId)) {
    return { error: `refused: invalid parentId "${clean(params.parentId, 32)}"` }
  }

  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json missing" }
  const manifest = mRead.value
  const nodes: Record<string, LemmaNodeRecord> = Object.assign(Object.create(null), manifest.nodes || {})
  const bounds = validateLemmaBounds(manifest.bounds).bounds ?? { ...DEFAULT_LEMMA_BOUNDS }
  const now = new Date().toISOString()
  const lemmaId = params.lemmaId

  if (params.action === "create") {
    if (Object.prototype.hasOwnProperty.call(nodes, lemmaId)) {
      return { error: `refused: duplicate lemmaId "${lemmaId}"` }
    }
    const existingCount = Object.keys(nodes).length
    if (existingCount >= bounds.maxNodes) {
      return { error: `refused: lemma node count (${existingCount}) already reached maxNodes (${bounds.maxNodes})` }
    }

    const parentId = params.parentId ?? null
    let depth = 0
    if (parentId !== null) {
      if (parentId === lemmaId) return { error: `refused: cycle detected (parentId === lemmaId "${lemmaId}")` }
      if (!Object.prototype.hasOwnProperty.call(nodes, parentId)) {
        return { error: `refused: unknown parentId "${parentId}"` }
      }
      const parent = nodes[parentId]
      // Cycle guard walking ancestors
      const seen = new Set<string>([lemmaId])
      let cur: string | null = parentId
      while (cur !== null) {
        if (seen.has(cur)) return { error: `refused: cycle detected at "${cur}"` }
        seen.add(cur)
        cur = nodes[cur]?.parentId ?? null
      }
      depth = parent.depth + 1
      if (depth > bounds.maxDepth) {
        return { error: `refused: lemma depth ${depth} exceeds maxDepth (${bounds.maxDepth})` }
      }
      if (parent.children.length >= bounds.maxWidth) {
        return { error: `refused: parent "${parentId}" already has ${parent.children.length} children (maxWidth ${bounds.maxWidth})` }
      }
      parent.children = [...parent.children, lemmaId]
      parent.updatedAt = now
    } else if (existingCount > 0) {
      return { error: `refused: parentId is required when root node already exists` }
    }

    const status = params.status ? clean(params.status, 32) : "pending"
    if (!VALID_NODE_STATUSES.has(status)) {
      return { error: `refused: invalid node status "${status}"` }
    }
    if (status === "proved" || status === "disproved") {
      return {
        error: `refused: use teamwork_lemma_verify to mark a node ${status} with executed kernel verification`,
      }
    }
    const node: LemmaNodeRecord = {
      id: lemmaId,
      parentId,
      depth,
      statement: cleanBlock(params.statement ?? "", 2000),
      status: status as LemmaNodeRecord["status"],
      attempts: 0,
      verifiedRound: null,
      latestVerify: null,
      children: [],
      updatedAt: now,
    }
    nodes[lemmaId] = node
    manifest.nodes = nodes
    if (manifest.phase === "VERIFIED") {
      manifest.phase = "SOLVING"
    }
    manifest.updatedAt = now

    const wNode = writeJsonAtomicSafe(runDir, `lemma/nodes/${lemmaId}/state.json`, node)
    if (wNode.error) return { error: wNode.error }
    if (parentId !== null) {
      const wParent = writeJsonAtomicSafe(runDir, `lemma/nodes/${parentId}/state.json`, nodes[parentId])
      if (wParent.error) return { error: wParent.error }
    }
    const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
    if (wMan.error) return { error: wMan.error }
    return { node }
  }

  if (!Object.prototype.hasOwnProperty.call(nodes, lemmaId)) {
    return { error: `refused: unknown lemmaId "${lemmaId}"` }
  }
  const node = nodes[lemmaId]

  if (params.action === "blueprint") {
    if (typeof params.blueprint !== "string" || !params.blueprint.trim()) {
      return { error: "refused: blueprint text must be non-empty" }
    }
    const wBp = writeTextAtomicSafe(runDir, `lemma/nodes/${lemmaId}/blueprint.md`, cleanBlock(params.blueprint, 16000) + "\n")
    if (wBp.error) return { error: wBp.error }
    if (node.status === "pending") node.status = "informal"
    node.updatedAt = now
    manifest.nodes = nodes
    manifest.updatedAt = now
    const wNode = writeJsonAtomicSafe(runDir, `lemma/nodes/${lemmaId}/state.json`, node)
    if (wNode.error) return { error: wNode.error }
    const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
    if (wMan.error) return { error: wMan.error }
    return { node }
  }

  if (params.action === "attempt") {
    // Formal proof attempts require Phase 0 preSearch APPROVE + problem.lean.
    const rRead = readJsonSafe<FormalizationReviewFile>(runDir, "lemma/formalization-review.json")
    const probSafe = ensureSafeSubpath(runDir, "lemma/problem.lean")
    if (rRead.value?.preSearch?.verdict !== "APPROVE" || probSafe.error || !probSafe.path || !existsSync(probSafe.path)) {
      return { error: "refused: cannot record proof attempt before Phase 0 formalization review APPROVE and lemma/problem.lean" }
    }
    if (typeof params.leanCode !== "string" || !params.leanCode.trim()) {
      return { error: "refused: leanCode must be non-empty for attempt" }
    }
    const round = params.round !== undefined ? Number(params.round) : node.attempts + 1
    if (!Number.isInteger(round) || round < 1 || round > bounds.maxRetries) {
      return { error: `refused: attempt round ${round} exceeds maxRetries (${bounds.maxRetries})` }
    }
    const relAttempt = `lemma/nodes/${lemmaId}/attempt-${round}.lean`
    const attemptSafe = ensureSafeSubpath(runDir, relAttempt)
    if (attemptSafe.error || !attemptSafe.path) return { error: attemptSafe.error }
    const normalizedAttempt = params.leanCode.endsWith("\n") ? params.leanCode : params.leanCode + "\n"
    if (existsSync(attemptSafe.path)) {
      const existingRead = readBoundedRegular(attemptSafe.path)
      if (!existingRead.error && existingRead.text !== undefined && existingRead.text !== normalizedAttempt) {
        return {
          error: `refused: attempt round ${round} (${relAttempt}) already exists and is immutable; submit the next round (${node.attempts + 1}) instead`,
        }
      }
    }
    const wAtt = writeTextAtomicSafe(runDir, relAttempt, normalizedAttempt)
    if (wAtt.error || !wAtt.path) return { error: wAtt.error ?? "failed to write attempt" }

    node.attempts = Math.max(node.attempts, round)
    if (node.status === "pending" || node.status === "informal") node.status = "formal"
    node.updatedAt = now
    manifest.nodes = nodes
    manifest.updatedAt = now

    const wNode = writeJsonAtomicSafe(runDir, `lemma/nodes/${lemmaId}/state.json`, node)
    if (wNode.error) return { error: wNode.error }
    const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
    if (wMan.error) return { error: wMan.error }
    return { node, attemptFile: wAtt.path }
  }

  // update
  if (params.status !== undefined) {
    const nextStatus = clean(params.status, 32)
    if (!VALID_NODE_STATUSES.has(nextStatus)) {
      return { error: `refused: invalid node status "${nextStatus}"` }
    }
    // Never allow jumping straight to "proved" or "disproved" without stamped verification.
    if (nextStatus === "proved" || nextStatus === "disproved") {
      return {
        error: `refused: use teamwork_lemma_verify to mark a node ${nextStatus} with executed kernel verification`,
      }
    }
    node.status = nextStatus as LemmaNodeRecord["status"]
  }
  if (typeof params.statement === "string") {
    node.statement = cleanBlock(params.statement, 2000)
  }
  node.updatedAt = now
  manifest.nodes = nodes
  manifest.updatedAt = now
  const wNode = writeJsonAtomicSafe(runDir, `lemma/nodes/${lemmaId}/state.json`, node)
  if (wNode.error) return { error: wNode.error }
  const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
  if (wMan.error) return { error: wMan.error }
  return { node }
}

export interface StampedLemmaVerifyReport extends LeanVerifyResult {
  lemmaId: string
  round: number
  attemptFile: string
  attemptHash?: string
  allowedAxioms: string[]
}

export function verifyLemmaNodeAttempt(
  runDir: string,
  params: {
    lemmaId: string
    round?: number
    mode?: "lean" | "lake-env-lean" | "lake-build"
    cwd?: string
    allowedAxioms?: string[]
    env?: NodeJS.ProcessEnv
  },
): { report?: StampedLemmaVerifyReport; verifyPath?: string; node?: LemmaNodeRecord; error?: string } {
  if (!isSafeLemmaId(params.lemmaId)) {
    return { error: `refused: invalid lemmaId "${clean(params.lemmaId, 32)}"` }
  }
  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json missing" }
  const manifest = mRead.value
  const nodes: Record<string, LemmaNodeRecord> = Object.assign(Object.create(null), manifest.nodes || {})
  if (!Object.prototype.hasOwnProperty.call(nodes, params.lemmaId)) {
    return { error: `refused: unknown lemmaId "${params.lemmaId}"` }
  }
  const node = nodes[params.lemmaId]
  const bounds = validateLemmaBounds(manifest.bounds).bounds ?? { ...DEFAULT_LEMMA_BOUNDS }
  const round = params.round !== undefined ? Number(params.round) : Math.max(1, node.attempts)
  if (!Number.isInteger(round) || round < 1 || round > bounds.maxRetries) {
    return { error: `refused: invalid verify round ${round} (must be 1..${bounds.maxRetries})` }
  }

  const attemptRel = `lemma/nodes/${params.lemmaId}/attempt-${round}.lean`
  const attemptSafe = ensureSafeSubpath(runDir, attemptRel)
  if (attemptSafe.error || !attemptSafe.path) return { error: attemptSafe.error }
  if (!existsSync(attemptSafe.path)) {
    return { error: `refused: attempt file ${attemptRel} does not exist` }
  }
  const attemptRead = readBoundedRegular(attemptSafe.path)
  if (attemptRead.error || attemptRead.text === undefined) {
    return { error: attemptRead.error ?? `refused: cannot read ${attemptRel}` }
  }
  const attemptHash = createHash("sha256").update(attemptRead.text, "utf8").digest("hex")

  const normalizedAllowedAxioms = Array.isArray(params.allowedAxioms)
    ? params.allowedAxioms.map((a) => clean(a, 128).trim()).filter(Boolean)
    : []

  const res = verifyLeanFile({
    filePath: attemptSafe.path,
    cwd: params.cwd ?? dirname(attemptSafe.path),
    mode: params.mode ?? "lean",
    env: params.env,
    allowedAxioms: normalizedAllowedAxioms,
  })

  const report: StampedLemmaVerifyReport = {
    lemmaId: params.lemmaId,
    round,
    attemptFile: attemptRel,
    attemptHash,
    allowedAxioms: normalizedAllowedAxioms,
    ...res,
  }
  const verifyRel = `lemma/nodes/${params.lemmaId}/verify-${round}.json`
  const wVer = writeJsonAtomicSafe(runDir, verifyRel, report)
  if (wVer.error || !wVer.path) return { error: wVer.error ?? "failed to write verify report" }

  const now = new Date().toISOString()
  node.latestVerify = verifyRel
  if (report.status === "PASS") {
    node.status = node.status === "disprove" ? "disproved" : "proved"
    node.verifiedRound = round
  } else if (round >= bounds.maxRetries) {
    node.status = "blocked"
  }
  node.updatedAt = now

  const revRead = readJsonSafe<FormalizationReviewFile>(runDir, "lemma/formalization-review.json")
  const finalVerdict = revRead.value?.final?.verdict
  const formalizationBlocked = finalVerdict === "UNFAITHFUL" || finalVerdict === "MISFORMALIZED"

  const allNodes = Object.values(nodes)
  if (formalizationBlocked) {
    manifest.phase = "BLOCKED"
  } else if (allNodes.length > 0 && allNodes.every((n) => n.status === "proved" || n.status === "disproved")) {
    manifest.phase = "VERIFIED"
  } else if (allNodes.some((n) => n.status === "blocked")) {
    manifest.phase = "BLOCKED"
  }
  manifest.nodes = nodes
  manifest.updatedAt = now

  const wNode = writeJsonAtomicSafe(runDir, `lemma/nodes/${params.lemmaId}/state.json`, node)
  if (wNode.error) return { error: wNode.error }
  const wMan = writeJsonAtomicSafe(runDir, "lemma/manifest.json", manifest)
  if (wMan.error) return { error: wMan.error }

  return { report, verifyPath: wVer.path, node }
}

export interface LemmaFinalEvidence {
  active: boolean
  manifestPath: string
  phase: string | null
  problemLeanPresent: boolean
  preSearchVerdict: string | null
  finalVerdict: string | null
  nodes: Array<{
    id: string
    status: string
    verifiedRound: number | null
    verifyReport: string | null
    verifyStatus: string
    executed: boolean
    exitCode: number | null
    hasSorry: boolean
    hasAdmit: boolean
    hasUnauthorizedAxiom: boolean
  }>
  reasons: string[]
}

export function evaluateLemmaFinalEvidence(runDir: string): LemmaFinalEvidence {
  const reasons: string[] = []
  const lemmaSub = ensureSafeSubpath(runDir, "lemma")
  if (lemmaSub.error) {
    reasons.push(`lemma dir invalid: ${lemmaSub.error}`)
    return {
      active: true,
      manifestPath: "lemma/manifest.json",
      phase: null,
      problemLeanPresent: false,
      preSearchVerdict: null,
      finalVerdict: null,
      nodes: [],
      reasons,
    }
  }

  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) {
    reasons.push(`lemma/manifest.json: ${mRead.error ?? "missing"}`)
    return {
      active: true,
      manifestPath: "lemma/manifest.json",
      phase: null,
      problemLeanPresent: false,
      preSearchVerdict: null,
      finalVerdict: null,
      nodes: [],
      reasons,
    }
  }
  const manifest = mRead.value
  const manifestPhase = typeof manifest.phase === "string" ? clean(manifest.phase, 32) : null
  if (manifestPhase !== "VERIFIED") {
    reasons.push(`lemma manifest phase is ${manifestPhase ?? "MISSING"} (must be VERIFIED)`)
  }
  const boundsCheck = validateLemmaBounds(manifest.bounds)
  if (boundsCheck.error) {
    reasons.push(`lemma bounds invalid: ${boundsCheck.error}`)
  }

  let problemLeanPresent = false
  let currentProblemHash: string | undefined
  const probSafe = ensureSafeSubpath(runDir, "lemma/problem.lean")
  if (probSafe.error || !probSafe.path) {
    reasons.push(`lemma/problem.lean: ${probSafe.error ?? "unsafe path"}`)
  } else {
    const probRead = readBoundedRegular(probSafe.path)
    if (probRead.error || !probRead.text?.trim()) {
      reasons.push(`lemma/problem.lean: ${probRead.error ?? "empty or missing"}`)
    } else {
      problemLeanPresent = true
      currentProblemHash = createHash("sha256").update(probRead.text, "utf8").digest("hex")
    }
  }

  const rRead = readJsonSafe<FormalizationReviewFile>(runDir, "lemma/formalization-review.json")
  const preSearchVerdict = rRead.value?.preSearch?.verdict ?? null
  const finalVerdict = rRead.value?.final?.verdict ?? null
  if (rRead.error || !rRead.value) {
    reasons.push(`lemma/formalization-review.json: ${rRead.error ?? "missing"}`)
  } else {
    if (preSearchVerdict !== "APPROVE") {
      reasons.push(`lemma formalization preSearch verdict is ${preSearchVerdict ?? "MISSING"} (must be APPROVE)`)
    }
    if (finalVerdict !== "FAITHFUL") {
      reasons.push(`lemma formalization final verdict is ${finalVerdict ?? "MISSING"} (must be FAITHFUL)`)
    } else if (
      currentProblemHash &&
      rRead.value.final?.problemHash &&
      rRead.value.final.problemHash !== currentProblemHash
    ) {
      reasons.push("lemma formalization final verdict does not match current lemma/problem.lean digest")
    }
  }

  const rawNodes = manifest.nodes && typeof manifest.nodes === "object" && !Array.isArray(manifest.nodes) ? manifest.nodes : {}
  const nodeIds = Object.keys(rawNodes)
  if (nodeIds.length === 0) {
    reasons.push("lemma manifest contains no lemma nodes")
  } else if (!nodeIds.some((id) => id === "root" || rawNodes[id]?.depth === 0)) {
    reasons.push("lemma manifest contains no root node")
  }

  const nodeSummaries: LemmaFinalEvidence["nodes"] = []
  for (const id of nodeIds) {
    if (!isSafeLemmaId(id)) {
      reasons.push(`unsafe lemma node id "${clean(id, 32)}"`)
      continue
    }
    const n = rawNodes[id]
    const nStatus = typeof n?.status === "string" ? clean(n.status, 32) : "pending"
    const vRound = typeof n?.verifiedRound === "number" && Number.isInteger(n.verifiedRound) ? n.verifiedRound : null
    const verifyPathRe = new RegExp(`^lemma/nodes/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/verify-\\d+\\.json$`)
    const verifyRel =
      typeof n?.latestVerify === "string" && verifyPathRe.test(n.latestVerify)
        ? n.latestVerify
        : vRound !== null && vRound >= 1
          ? `lemma/nodes/${id}/verify-${vRound}.json`
          : null

    let vReport: StampedLemmaVerifyReport | undefined
    if (verifyRel) {
      const vr = readJsonSafe<StampedLemmaVerifyReport>(runDir, verifyRel)
      if (vr.error) reasons.push(`lemma node ${id}: ${vr.error}`)
      else vReport = vr.value
    }

    const executed = vReport?.executed === true
    const exitCode = typeof vReport?.exitCode === "number" ? vReport.exitCode : null
    const hasSorry = vReport?.hasSorry === true
    const hasAdmit = vReport?.hasAdmit === true
    const hasUnauthorizedAxiom = vReport?.hasUnauthorizedAxiom === true
    const verifyStatus = vReport?.status === "PASS" ? "PASS" : vReport?.status === "FAIL" ? "FAIL" : "MISSING"

    if (nStatus !== "proved" && nStatus !== "disproved") {
      reasons.push(`lemma node ${id}: status ${nStatus} (not proved/disproved)`)
    }
    if (!vReport || verifyStatus !== "PASS" || !executed || exitCode !== 0 || hasSorry || hasAdmit || hasUnauthorizedAxiom) {
      reasons.push(
        `lemma node ${id}: invalid/missing stamped verification (status=${verifyStatus}, executed=${executed}, exitCode=${exitCode}, sorry=${hasSorry}, admit=${hasAdmit}, axiom=${hasUnauthorizedAxiom})`,
      )
    } else if (vReport.attemptHash && vReport.attemptFile) {
      const attSafe = ensureSafeSubpath(runDir, vReport.attemptFile)
      if (attSafe.error || !attSafe.path) {
        reasons.push(`lemma node ${id}: ${attSafe.error ?? "unsafe attemptFile"}`)
      } else {
        const attRead = readBoundedRegular(attSafe.path)
        if (attRead.error || attRead.text === undefined) {
          reasons.push(`lemma node ${id}: ${attRead.error ?? "cannot read attemptFile"}`)
        } else {
          const curAttHash = createHash("sha256").update(attRead.text, "utf8").digest("hex")
          if (curAttHash !== vReport.attemptHash) {
            reasons.push(`lemma node ${id}: attempt file ${vReport.attemptFile} modified since verification`)
          }
        }
      }
    }

    nodeSummaries.push({
      id,
      status: nStatus,
      verifiedRound: vRound,
      verifyReport: verifyRel,
      verifyStatus,
      executed,
      exitCode,
      hasSorry,
      hasAdmit,
      hasUnauthorizedAxiom,
    })
  }

  return {
    active: true,
    manifestPath: "lemma/manifest.json",
    phase: typeof manifest.phase === "string" ? clean(manifest.phase, 32) : null,
    problemLeanPresent,
    preSearchVerdict,
    finalVerdict,
    nodes: nodeSummaries,
    reasons,
  }
}
