// opencode-teamwork — LEMMA (Lean 4 formal-proof route) engine helpers
//
// Zero runtime dependencies (node:* built-ins only).
// Erasable TypeScript compatible with Node 22+ `--experimental-strip-types`.

import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  createDirWithin,
  readRegularBounded,
  readWithinBounded,
  resolveTrustedExecutable,
  unlinkWithin,
  writeFileAtomicWithin,
  writeOnceWithin,
} from "./safe-fs.mjs"
import { clean, cleanBlock } from "./text-utils.ts"

const MAX_LEMMA_DEPTH = 3
const MAX_LEMMA_WIDTH = 4
const MAX_LEMMA_NODES = 24
const MAX_LEMMA_RETRIES = 4
const MAX_FORMALIZATION_ROUNDS = 3
const MAX_LEMMA_ALLOWED_AXIOMS = 32
const LEMMA_POLICY_VERSION = 1
const MAX_LEMMA_FILE_BYTES = 1024 * 1024 // 1 MiB

const DEFAULT_LEMMA_BOUNDS = {
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

/**
 * Approved axiom policy for the LEMMA transitive-axiom gate. It is declared
 * once at plan/formalization time (from the user's spec) and persisted in
 * `lemma/manifest.json`; verification reads it from disk and never from the
 * tool caller. `allowedAxioms` extends (never replaces) the standard axioms.
 */
export interface LemmaPolicy {
  version: number
  allowedAxioms: string[]
}

export type ProbeStatus = "READY" | "MISSING" | "OUTAGE"
/**
 * `leap doctor --offline` verdict. `WARN` means the only failed check was
 * `LEAN_PROJECT_DIR`: the host has core Lean and a usable LEAP CLI but no local
 * Lake project, which LEMMA does not require (Mathlib and `leap lean` are
 * optional). Every other non-zero exit stays `OUTAGE`.
 */
export type LeapDoctorStatus = ProbeStatus | "WARN"
export type LemmaBinaryName = "lean" | "lake" | "leap" | "leap-tools"
/** The real LEAP requirement: the `leap` console script, with the legacy `leap-tools` alias. */
export const LEAP_REQUIREMENT = "leap (LEAP CLI) or legacy leap-tools"
export type LemmaRequirement = "lean" | "lake" | typeof LEAP_REQUIREMENT
/** The only `leap doctor` check whose failure is advisory for LEMMA. */
const LEAP_DOCTOR_PROJECT_CHECK = "LEAN_PROJECT_DIR"

export interface LeapDoctorResult {
  status: LeapDoctorStatus
  output: string
  error?: string
  /** Bounded, de-duplicated check names that printed a `[FAIL]` line. */
  failedChecks?: string[]
  /** `WARN` only: why the doctor verdict is advisory rather than blocking. */
  warning?: string
}

export interface BinaryProbeResult {
  name: LemmaBinaryName
  available: boolean
  status: ProbeStatus
  path: string | null
  version: string | null
  error?: string
  /** LEAP only: the result of `leap doctor` (the CLI's own environment check). */
  doctor?: LeapDoctorResult
}

export interface LemmaProbeResult {
  status: ProbeStatus
  ready: boolean
  lean: BinaryProbeResult
  lake: BinaryProbeResult
  /** Resolved LEAP CLI: `leap` when present, otherwise the legacy `leap-tools`. */
  leap: BinaryProbeResult
  missing: LemmaRequirement[]
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

export interface LemmaRouteClassification {
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

function isSafeLemmaId(id: unknown): id is string {
  return typeof id === "string" && LEMMA_ID.test(id) && id !== "." && id !== ".."
}

function asStr(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

/**
 * Validate a relative path inside `runDir`:
 * - Rejects empty/absolute paths or `..`/`.` segments
 * - Refuses any symlinked component along the path (including dangling target)
 * - Verifies `realpathSync` containment for existing ancestors and target
 */
function ensureSafeSubpath(runDir: string, relPath: string): { path?: string; runReal?: string; error?: string } {
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

  return { path: target, runReal }
}

/**
 * Read a regular file with O_NOFOLLOW | O_NONBLOCK and a strict byte cap
 * (default 1 MiB). Opens the descriptor first and runs fstatSync(fd) on the open
 * descriptor, so there is no TOCTOU check-then-open race on the final component;
 * EINTR is retried and every other read error fails closed. When `runReal` is
 * supplied (a run-root read) the shared primitive also checks the opened fd's
 * /proc/self/fd path on Linux (ADR 0004). Arbitrary non-run `options.filePath`
 * reads keep the rootless behavior.
 */
function readBoundedRegular(
  file: string,
  maxBytes = MAX_LEMMA_FILE_BYTES,
  runReal?: string,
): { text?: string; error?: string } {
  const r = runReal ? readWithinBounded(runReal, file, maxBytes) : readRegularBounded(file, maxBytes)
  if (r.status === "ok") return { text: r.text }
  if (r.status === "absent") return { error: `missing: "${basename(file)}" does not exist` }
  if (r.status === "oversize") return { error: `refused: "${basename(file)}" exceeds ${maxBytes} byte read cap` }
  return { error: r.message }
}

// Read a path previously validated by ensureSafeSubpath; use the root-aware
// primitive whenever the run's realpath is known.
function readSafeSubpath(
  safe: { path?: string; runReal?: string; error?: string },
  maxBytes = MAX_LEMMA_FILE_BYTES,
): { text?: string; error?: string } {
  if (safe.error || !safe.path) return { error: safe.error ?? "refused: unsafe path" }
  return readBoundedRegular(safe.path, maxBytes, safe.runReal)
}

function writeTextAtomicSafe(runDir: string, relPath: string, content: string): { path?: string; error?: string } {
  // Keep the path policy and its exact error text, then perform the write with
  // the pinned-fd primitive (ADR 0010). The parent directory is opened once and
  // the temp/create/rename/lstat never walk a path that a swap can divert.
  const safe = ensureSafeSubpath(runDir, relPath)
  if (safe.error || !safe.path) return { error: safe.error || "refused: unsafe path" }
  try {
    writeFileAtomicWithin(runDir, relPath, content)
  } catch (err: any) {
    return { error: clean(err?.message || "write failed", 200) }
  }
  return { path: safe.path }
}

function writeJsonAtomicSafe(runDir: string, relPath: string, value: unknown): { path?: string; error?: string } {
  return writeTextAtomicSafe(runDir, relPath, JSON.stringify(value, null, 2) + "\n")
}

function readJsonSafe<T>(runDir: string, relPath: string): { value?: T; error?: string } {
  const safe = ensureSafeSubpath(runDir, relPath)
  if (safe.error || !safe.path) return { error: safe.error }
  const r = readSafeSubpath(safe)
  if (r.error || r.text === undefined) return { error: r.error }
  try {
    return { value: JSON.parse(r.text) as T }
  } catch {
    return { error: `invalid JSON in ${clean(relPath, 80)}` }
  }
}

// ---------------------------------------------------------------------------
// Toolchain Probe (Lean 4: lean + lake, and the LEAP CLI: leap or legacy leap-tools)
// ---------------------------------------------------------------------------

function resolveExecutableOnPath(binName: string, pathEnv: string | undefined): string | null {
  // S4036: a binary found through an attacker-writable or relative PATH entry
  // can execute planted code. Reuse the trusted-directory resolver; set
  // fallbackToStandard: false so a probe that intentionally narrows PATH (for
  // example a fixture that simulates a missing toolchain) does not silently pick
  // up a host binary from /usr/bin.
  return resolveTrustedExecutable(binName, {
    env: { PATH: pathEnv, PATHEXT: process.env.PATHEXT },
    fallbackToStandard: false,
  })
}

function firstNonEmptyLine(text: unknown): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines[0] ?? ""
}

function probeBinary(
  name: LemmaBinaryName,
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

function buildInstallInstructions(): string {
  return [
    "Required toolchain installation instructions:",
    "1. Lean 4 (`lean` and `lake` via `elan`):",
    "   - Install elan (see https://lean-lang.org/install/):",
    "     curl https://elan.lean-lang.org/elan-init.sh -sSf | sh",
    "   - Set default Lean 4 toolchain and put elan on PATH:",
    "     export PATH=\"$HOME/.elan/bin:$PATH\"",
    "     elan default leanprover/lean4:stable",
    "   - Verify: lean --version && lake --version",
    "2. LEAP CLI (`leap`; the legacy `leap-tools` name is also accepted):",
    "   - The `leap-tools` PyPI package does not exist; install the pinned CLI from git:",
    "     pipx install git+https://github.com/billkunghappy/LEAP-CLI@afc016d23579d8236050a157fe6cac8f17b13096",
    "   - Source: https://github.com/billkunghappy/LEAP-CLI",
    "   - Verify: leap --help   # `leap` has no --version flag; --help proves it runs",
    "   - Optional full Mathlib setup: `leap lean` downloads Lean 4.34 + Mathlib",
    "     (~11 GB, 10-20 minutes). LEMMA's E2E needs only core Lean and never runs `leap lean`.",
  ].join("\n")
}

function runLeapDoctor(
  resolved: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): LeapDoctorResult {
  // `--offline` keeps the doctor check local: the full check probes/updates
  // Mathlib state over the network, which LEMMA does not require (Mathlib and
  // `leap lean` are optional). `--offline` still exits non-zero when no local
  // Lean project exists, so the FAIL set below decides WARN vs OUTAGE.
  try {
    const out = execFileSync(resolved, ["doctor", "--offline"], {
      env,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { status: "READY", output: cleanBlock(out, 2000).trim() }
  } catch (err: any) {
    const stderr = String(err?.stderr ?? "")
    const stdout = String(err?.stdout ?? "")
    const combined = [stdout, stderr].filter(Boolean).join("\n")
    const failedChecks = parseLeapDoctorFailures(combined)
    const output = cleanBlock(combined, 2000).trim()
    const detail =
      firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout) || err?.code || err?.message || "leap doctor failed"
    // WARN requires a real non-zero exit: a timeout, signal termination, spawn
    // failure (ENOENT), or output overflow is never downgraded, even when
    // partial output mentions LEAN_PROJECT_DIR.
    const executionError =
      err?.code === "ETIMEDOUT" ||
      err?.code === "ENOBUFS" ||
      err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      Boolean(err?.signal)
    const doctorExit = typeof err?.status === "number" ? err.status : null
    if (
      !executionError &&
      doctorExit !== null &&
      doctorExit !== 0 &&
      failedChecks.length > 0 &&
      failedChecks.every((c) => c === LEAP_DOCTOR_PROJECT_CHECK)
    ) {
      return {
        status: "WARN",
        output,
        failedChecks,
        warning:
          "only LEAN_PROJECT_DIR failed: no local Lean project; core Lean and the LEAP CLI are usable and Mathlib/`leap lean` is optional",
      }
    }
    return {
      status: "OUTAGE",
      output,
      failedChecks,
      error: err?.code === "ETIMEDOUT" ? `leap doctor timed out after ${timeoutMs}ms` : clean(detail, 180),
    }
  }
}

/**
 * Parse the check names from `[FAIL] <check>` lines in stdout/stderr. The
 * verdict only needs the set, but bounding the names keeps the probe result
 * small even when a hostile binary floods the pipe.
 */
function parseLeapDoctorFailures(text: string): string[] {
  const failures = new Set<string>()
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "")
  const re = /^\[FAIL\]\s+(\S+)/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(plain)) !== null) {
    if (failures.size >= 64) {
      // Overflow is treated as "not project-only" so the verdict fails closed.
      failures.add("…")
      break
    }
    const name = clean(match[1], 64)
    if (name) failures.add(name)
  }
  return [...failures].sort((a, b) => a.localeCompare(b))
}

function probeLeapCli(env: NodeJS.ProcessEnv, timeoutMs: number): BinaryProbeResult {
  // `leap` is the current console script; fall back to the legacy `leap-tools`
  // name only when `leap` is absent. A present-but-broken `leap` is an OUTAGE,
  // not a reason to silently use another binary.
  const leap = probeBinary("leap", env, timeoutMs, true)
  const chosen =
    leap.available || leap.path !== null ? leap : probeBinary("leap-tools", env, timeoutMs, true)
  if (!chosen.available && chosen.path === null) {
    return {
      ...chosen,
      doctor: { status: "MISSING", output: "", error: "leap doctor not run: the CLI is not on PATH" },
      error: "neither `leap` nor legacy `leap-tools` found on PATH",
    }
  }
  if (!chosen.available || chosen.path === null) {
    return {
      ...chosen,
      doctor: { status: "OUTAGE", output: "", error: "leap doctor not run: the CLI probe failed" },
    }
  }
  // A5/A7: `leap --help` only proves the console script starts. `leap doctor
  // --offline` is the CLI's own local environment check (toolchain, cache,
  // project state), so a failing doctor blocks the CLI for LEMMA unless the only
  // failed check is `LEAN_PROJECT_DIR` (no Lake project; Mathlib is optional).
  const doctor = runLeapDoctor(chosen.path, env, timeoutMs)
  if (doctor.status === "OUTAGE") {
    return {
      ...chosen,
      available: false,
      status: "OUTAGE",
      error: `leap doctor failed: ${doctor.error ?? "unhealthy LEAP environment"}`,
      doctor,
    }
  }
  // READY or WARN: the binary is usable and neither flips `available` to false.
  return { ...chosen, doctor }
}

export function probeLemmaToolchain(options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): LemmaProbeResult {
  const env = options?.env ?? process.env
  const timeoutMs = Math.max(250, Math.min(30000, Number(options?.timeoutMs) || 5000))

  const lean = probeBinary("lean", env, timeoutMs, false)
  const lake = probeBinary("lake", env, timeoutMs, false)
  const leap = probeLeapCli(env, timeoutMs)

  const missing: LemmaRequirement[] = []
  if (!lean.available) missing.push("lean")
  if (!lake.available) missing.push("lake")
  if (!leap.available) missing.push(LEAP_REQUIREMENT)

  // A doctor WARN (project-only) keeps `leap.available` true, so a core-only
  // host reports READY/ready here; only MISSING/OUTAGE verdicts block.
  const failedResults = [lean, lake, leap].filter((r) => !r.available)
  let status: ProbeStatus = "READY"
  if (failedResults.length > 0) {
    status = failedResults.some((r) => r.status === "MISSING") ? "MISSING" : "OUTAGE"
  }

  return {
    status,
    ready: missing.length === 0,
    lean,
    lake,
    leap,
    missing,
    installInstructions: buildInstallInstructions(),
  }
}

export function formatMissingToolchainRefusal(probe: LemmaProbeResult): string {
  const details = [
    `  - lean: ${describeProbe(probe.lean)}`,
    `  - lake: ${describeProbe(probe.lake)}`,
    `  - ${LEAP_REQUIREMENT}: ${describeProbe(probe.leap)}`,
    ...(probe.leap.doctor
      ? [
          `  - leap doctor: ${probe.leap.doctor.status}${probe.leap.doctor.output ? ` (${cleanBlock(probe.leap.doctor.output, 300).trim()})` : ""}${probe.leap.doctor.warning ? ` — warning: ${probe.leap.doctor.warning}` : ""}${probe.leap.doctor.error ? ` — ${probe.leap.doctor.error}` : ""}`,
        ]
      : []),
  ]
  return [
    `refused: LEMMA route requires Lean 4 (lean, lake) and a LEAP CLI binary (${LEAP_REQUIREMENT}), which are not ready (status: ${probe.status}; missing/unusable: ${probe.missing.join(", ")}). No run directory or plan artifact was created; zero budget spent.`,
    "Toolchain probe:",
    ...details,
    "",
    probe.installInstructions,
  ].join("\n")
}

function describeProbe(t: BinaryProbeResult): string {
  if (t.available) return `READY (${t.version ?? t.path})`
  const location = t.path ? ` at ${t.path}` : ""
  return `${t.status}${location} (${t.error ?? "unavailable"})`
}

// ---------------------------------------------------------------------------
// Priority-ordered explicit opt-in route classifier
// ---------------------------------------------------------------------------

function stripTrailingUnclosedFence(text: string, marker: string): string {
  const idx = text.indexOf(marker)
  if (idx === -1) return text
  return text.slice(0, idx) + " "
}

function maskFencedCodeBlocks(rawText: string): string {
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

function hasLeanSignal(rawText: string): boolean {
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

function hasExplicitLeanRequest(proseOnly: string): boolean {
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

export function classifyLemmaRoute(
  input: string | { request?: string; inputs?: string[]; hasDocument?: boolean },
  _root?: string,
): LemmaRouteClassification {
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

// ---------------------------------------------------------------------------
// Declaration binding (verified attempt must prove the approved proposition)
// ---------------------------------------------------------------------------

export interface LeanDeclaration {
  name: string
  type: string
  normalizedType: string
}

export interface DeclarationBindingExpectation {
  declaration?: string | null
  statement: string
  disproof?: boolean
}

export interface DeclarationBindingResult {
  ok: boolean
  declaration?: LeanDeclaration
  findings: string[]
}

const LEAN_DECL_START_RE =
  /(?:^|\n)[ \t]*(?:@\[[^\]]*\][ \t]*)*(?:(?:private|protected|noncomputable|unsafe|partial)[ \t]+)*(theorem|lemma)[ \t]+(«[^»]+»|[A-Za-z_][A-Za-z0-9_'.]*)/g

/** Collapse whitespace in a Lean statement/type so formatting differences do not matter. */
function normalizeLeanStatement(statement: unknown): string {
  return stripLeanComments(String(statement ?? ""))
    .replace(/\s+/g, " ")
    .trim()
}

interface LeanMaskResult {
  text?: string
  error?: string
}

function findLeanQuotationEnd(source: string, openParen: number): number {
  let depth = 0
  let i = openParen
  while (i < source.length) {
    const c = source[i]
    if (c === '"') {
      i++
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2
          continue
        }
        if (source[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === "-" && source[i + 1] === "-") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && source[i + 1] === "-") {
      let block = 1
      i += 2
      while (i < source.length && block > 0) {
        if (source[i] === "/" && source[i + 1] === "-") {
          block++
          i += 2
        } else if (source[i] === "-" && source[i + 1] === "/") {
          block--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    if (c === "'" && (i === 0 || !/[A-Za-z0-9_.'»]/.test(source[i - 1]))) {
      const charLit = source.slice(i).match(/^'(?:[^'\\\r\n]|\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[^\r\n]))'/)
      if (charLit) {
        i += charLit[0].length
        continue
      }
    }
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/**
 * Mask comments, string/char literals, and `( ... )` syntax quotations so a
 * declaration scan only sees real top-level commands. Line structure is kept.
 * Unreliable delimiters fail closed: a caller must not guess what a quotation
 * contains. This is a lexical defense, not a Lean parser.
 */
function maskLeanDeclarationsSource(source: string): LeanMaskResult {
  const src = String(source ?? "")
  let out = ""
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (c === "/" && src[i + 1] === "-") {
      let depth = 1
      out += "  "
      i += 2
      while (i < src.length && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "-") {
          depth++
          out += "  "
          i += 2
        } else if (src[i] === "-" && src[i + 1] === "/") {
          depth--
          out += "  "
          i += 2
        } else {
          out += src[i] === "\n" ? "\n" : " "
          i++
        }
      }
      if (depth > 0) return { error: "refused: unterminated block comment; cannot scan declarations" }
      continue
    }
    if (c === '"') {
      out += " "
      i++
      let closed = false
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i + 1] === "\n" ? "\n" : " "
          i += 2
          continue
        }
        if (src[i] === '"') {
          out += " "
          i++
          closed = true
          break
        }
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
      if (!closed) return { error: "refused: unterminated string literal; cannot scan declarations" }
      continue
    }
    if (c === "'" && (i === 0 || !/[A-Za-z0-9_.'»]/.test(src[i - 1]))) {
      const charLit = src.slice(i).match(/^'(?:[^'\\\r\n]|\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[^\r\n]))'/)
      if (charLit) {
        for (let k = 0; k < charLit[0].length; k++) out += charLit[0][k] === "\n" ? "\n" : " "
        i += charLit[0].length
        continue
      }
    }
    if (c === "`") {
      let j = i
      while (j < src.length && src[j] === "`") j++
      if (src[j] !== "(") {
        return { error: "refused: cannot delimit syntax quotation; declaration binding is unavailable" }
      }
      const end = findLeanQuotationEnd(src, j)
      if (end < 0) return { error: "refused: unterminated syntax quotation; cannot scan declarations" }
      for (let k = i; k < end; k++) out += src[k] === "\n" ? "\n" : " "
      i = end
      continue
    }
    out += c
    i++
  }
  return { text: out }
}

function findTopLevelBinderColon(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1)
    else if (c === ":" && depth === 0) return i
  }
  return -1
}

function stripSimpleBinderParens(binders: string): string | null {
  let rest = binders.trim()
  let out = ""
  while (rest) {
    const m = rest.match(/^[([{]([^()[\]{}]*)[)\]}]/)
    if (!m) return null
    out += (out ? " " : "") + m[1].trim()
    rest = rest.slice(m[0].length).trim()
  }
  return out || null
}

/**
 * Comparison forms for a Lean type. Text comparison alone would reject the
 * equivalent `(n : Nat) : P` and `∀ n : Nat, P` spellings, so binder forms are
 * expanded. This is still a syntactic comparison, never semantic equality.
 */
function leanStatementVariants(statement: unknown): string[] {
  const raw = normalizeLeanStatement(statement)
  const variants = new Set<string>()
  if (!raw) return []
  variants.add(raw)
  for (const base of [...variants]) {
    variants.add(base.replace(/¬\s+/g, "¬"))
    variants.add(base.replace(/\bNot\s+\(/g, "Not("))
  }
  if (/^[([{]/.test(raw)) {
    const idx = findTopLevelBinderColon(raw)
    if (idx > 0) {
      const binders = raw.slice(0, idx).trim()
      const body = raw.slice(idx + 1).trim()
      if (binders && body) {
        variants.add(normalizeLeanStatement(`∀ ${binders}, ${body}`))
        const simple = stripSimpleBinderParens(binders)
        if (simple) variants.add(normalizeLeanStatement(`∀ ${simple}, ${body}`))
      }
    }
  }
  const forall = raw.match(/^∀\s+([\s\S]+?),\s*([\s\S]+)$/)
  if (forall) {
    const simple = stripSimpleBinderParens(forall[1])
    if (simple) variants.add(normalizeLeanStatement(`∀ ${simple}, ${forall[2]}`))
  }
  return [...variants].filter(Boolean)
}

/** Syntactic proposition match, including binder and negation spelling forms. */
export function leanStatementMatches(actual: unknown, expected: unknown, disproof = false): boolean {
  const actualForms = new Set(leanStatementVariants(actual))
  const expectedForms = leanStatementVariants(expected)
  if (actualForms.size === 0 || expectedForms.length === 0) return false
  if (!disproof) return expectedForms.some((form) => actualForms.has(form))

  const candidates = new Set<string>()
  for (const statement of expectedForms) {
    for (const negated of [`Not (${statement})`, `¬(${statement})`, `¬ (${statement})`, `¬${statement}`, `Not ${statement}`]) {
      for (const form of leanStatementVariants(negated)) candidates.add(form)
    }
    // `(n : Nat) : ¬P n` proves `∀ n, ¬P n`, which implies `¬∀ n, P n`.
    // Binder-local negation is therefore a sound (stronger) disproof.
    if (/^[([{]/.test(statement)) {
      const idx = findTopLevelBinderColon(statement)
      if (idx > 0) {
        const binders = statement.slice(0, idx).trim()
        const body = statement.slice(idx + 1).trim()
        if (binders && body) {
          for (const negatedBody of [`¬(${body})`, `¬ (${body})`, `Not (${body})`]) {
            for (const form of leanStatementVariants(`${binders} : ${negatedBody}`)) candidates.add(form)
          }
        }
      }
    }
    const forall = statement.match(/^∀\s+([\s\S]+?),\s*([\s\S]+)$/)
    if (forall) {
      for (const negatedBody of [`¬(${forall[2]})`, `¬ (${forall[2]})`, `Not (${forall[2]})`]) {
        for (const form of leanStatementVariants(`∀ ${forall[1]}, ${negatedBody}`)) candidates.add(form)
      }
    }
  }
  return [...actualForms].some((form) => candidates.has(form))
}

export interface LeanDeclarationScan {
  declarations: LeanDeclaration[]
  errors: string[]
}

/**
 * Extract top-level `theorem`/`lemma` declarations from masked source. Rejects
 * ambiguous files (namespaces/sections, private/protected declarations, and
 * duplicate names) instead of taking a first match: the axiom probe resolves
 * one unqualified name, so a second declaration with the same name is unsafe.
 */
export function analyzeLeanDeclarations(source: string): LeanDeclarationScan {
  const masked = maskLeanDeclarationsSource(source)
  if (masked.error || masked.text === undefined) {
    return { declarations: [], errors: [masked.error ?? "refused: cannot scan declarations"] }
  }
  const code = masked.text
  const errors: string[] = []

  const scopeTokens = new Set<string>()
  for (const m of code.matchAll(/\b(namespace|section|private|protected)\b/g)) scopeTokens.add(m[1])
  for (const token of scopeTokens) {
    errors.push(`refused: ${token} declarations/blocks are not supported for declaration binding; flatten the attempt`)
  }

  const starts: Array<{ name: string; bodyStart: number; start: number }> = []
  for (const m of code.matchAll(LEAN_DECL_START_RE)) {
    const start = m.index ?? 0
    starts.push({ name: m[2], start, bodyStart: start + m[0].length })
  }

  const declarations: LeanDeclaration[] = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].start : code.length
    const rawBody = code.slice(starts[i].bodyStart, end)
    const proofIdx = rawBody.indexOf(":=")
    const rawSignature = (proofIdx >= 0 ? rawBody.slice(0, proofIdx) : rawBody).trim()
    // `theorem foo : P` -> the type is `P`; `theorem foo (n : Nat) : P` keeps
    // the binders so the recorded statement can be compared verbatim.
    const type = rawSignature.replace(/^:\s*/, "").trim()
    declarations.push({ name: starts[i].name, type, normalizedType: normalizeLeanStatement(type) })
  }

  const counts = new Map<string, number>()
  for (const d of declarations) {
    const name = stripGuillemets(d.name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  for (const [name, count] of counts) {
    if (count > 1) errors.push(`refused: duplicate theorem/lemma declaration name "${name}" (${count} declarations)`)
  }

  return { declarations, errors }
}

/** Declaration list from the hardened scan (errors are reported by analyzeLeanDeclarations). */
export function parseLeanDeclarations(source: string): LeanDeclaration[] {
  return analyzeLeanDeclarations(source).declarations
}

/**
 * Fail-closed binding check: the attempt's declaration name must be the
 * expected one (or the only theorem/lemma when no name is recorded) and its
 * type must match the approved node statement. Ambiguous scans (strings,
 * quotations, namespaces, private/protected, duplicate names, more than one
 * candidate) are rejected; there is no "first match".
 */
export function bindVerifiedDeclaration(
  source: string,
  expected: DeclarationBindingExpectation,
): DeclarationBindingResult {
  const scan = analyzeLeanDeclarations(source)
  if (scan.errors.length > 0) {
    return { ok: false, findings: scan.errors }
  }
  const declarations = scan.declarations
  const expectedName = stripGuillemets(clean(expected.declaration ?? "", 128).trim())
  const statement = normalizeLeanStatement(expected.statement)
  const findings: string[] = []

  if (declarations.length === 0) {
    return {
      ok: false,
      findings: ["verified attempt declares no theorem/lemma; cannot bind it to the approved statement"],
    }
  }
  if (!statement) {
    findings.push("approved node statement is empty; cannot bind the verified declaration to a proposition")
  }

  let declaration: LeanDeclaration | undefined
  if (expectedName) {
    const matches = declarations.filter((d) => stripGuillemets(d.name) === expectedName)
    if (matches.length > 1) {
      findings.push(`verified attempt declares ${matches.length} theorem/lemmas named "${expectedName}"; ambiguous binding is refused`)
    } else if (matches.length === 1) {
      declaration = matches[0]
    } else {
      const found = declarations.map((d) => d.name).join(", ")
      findings.push(
        `verified attempt does not declare expected theorem/lemma "${expectedName}" (found: ${found || "none"})`,
      )
    }
  } else if (declarations.length === 1) {
    declaration = declarations[0]
  } else {
    findings.push(
      `cannot bind proposition: verified attempt declares ${declarations.length} theorem/lemma candidates and no declaration name is recorded on the node`,
    )
  }

  if (declaration && statement) {
    if (!leanStatementMatches(declaration.normalizedType, statement, expected.disproof === true)) {
      const kind = expected.disproof ? "is not the required negation of" : "does not match"
      findings.push(
        `declared type "${clean(declaration.normalizedType, 240)}" ${kind} approved node statement "${clean(statement, 240)}"`,
      )
    }
  }

  return { ok: findings.length === 0, declaration, findings }
}

// ---------------------------------------------------------------------------
// Transitive axiom dependencies (`#print axioms <declName>`)
// ---------------------------------------------------------------------------

/** Axioms Lean itself and Mathlib treat as standard, non-proof-relevant trust. */
const STANDARD_LEAN_AXIOMS = ["Classical.choice", "propext", "Quot.sound"] as const

export interface AxiomDependencyCheck {
  recognized: boolean
  dependencies: string[]
  unauthorized: string[]
  findings: string[]
}

/**
 * Reject source that can print a spoofed `#print axioms` report before the
 * appended probe. This is a heuristic: it catches `#` commands, `logInfo`,
 * `dbg_trace`, `trace`, `run_cmd`, `println`/`eprintln`, `IO.`, and trace
 * options. It does not prove that no user-defined macro can print, so the line
 * parser below also anchors reports to the exact declaration name and requires
 * exactly one report.
 */
export function detectAxiomProbeHijacks(source: string): string[] {
  const masked = maskLeanDeclarationsSource(source)
  if (masked.error || masked.text === undefined) {
    return [`refused: cannot scan attempt for probe-hijacking commands: ${masked.error ?? "unknown"}`]
  }
  const code = masked.text
  const tokens = new Set<string>()
  for (const m of code.matchAll(/(^|[^\w])#\s*([A-Za-z_][A-Za-z0-9_']*)/g)) tokens.add(`#${m[2]}`)
  for (const m of code.matchAll(/\b(logInfo|dbg_trace|trace|run_cmd|run_elab|run_tac|println|eprintln)\b/g)) tokens.add(m[1])
  if (/\bIO\s*\./.test(code)) tokens.add("IO.")
  if (/\bset_option\s+trace\b/.test(code)) tokens.add("set_option trace")
  if (tokens.size === 0) return []
  return [
    `refused: attempt contains probe-hijacking command(s) ${[...tokens].join(", ")}; remove them and re-verify`,
  ]
}

interface AxiomDependencyEvaluation {
  dependencies: string[]
  unauthorized: string[]
  findings: string[]
}

/** Classify a dependency list against the standard axioms + caller allowlist. */
function evaluateAxiomDependencies(
  dependencies: string[],
  allowedAxioms: string[] = [],
): AxiomDependencyEvaluation {
  const allowed = new Set<string>(STANDARD_LEAN_AXIOMS)
  for (const a of allowedAxioms) {
    const name = stripGuillemets(String(a ?? "").trim())
    if (name) allowed.add(name)
  }

  const unauthorized: string[] = []
  for (const dep of dependencies) {
    const name = stripGuillemets(String(dep ?? "").trim())
    if (!name) continue
    if (name === "sorryAx" || !allowed.has(name)) unauthorized.push(name)
  }

  const uniqueDeps = [...new Set(dependencies.map((d) => stripGuillemets(String(d ?? "").trim())).filter(Boolean))]
  const uniqueUnauthorized = [...new Set(unauthorized)]
  const findings =
    uniqueUnauthorized.length > 0
      ? [`unauthorized transitive axiom dependency: ${uniqueUnauthorized.join(", ")}`]
      : []
  return { dependencies: uniqueDeps, unauthorized: uniqueUnauthorized, findings }
}

/**
 * Parse Lean's `#print axioms` output and reject anything outside the standard
 * axioms plus the caller's allowlist. Only complete lines of the form
 * `'<decl>' depends on axioms: [ ... ]` or `'<decl>' does not depend on any
 * axioms` count. Exactly one report must exist, and it must name `declaration`.
 * `sorryAx` is never allowed, even if a caller tries to allowlist it.
 */
export function parseLeanAxiomOutput(
  output: unknown,
  allowedAxioms: string[] = [],
  declarationName?: string,
): AxiomDependencyCheck {
  const expected = stripGuillemets(String(declarationName ?? "").trim())
  if (!expected) {
    return {
      recognized: false,
      dependencies: [],
      unauthorized: [],
      findings: ["refused: declaration name is required to parse axiom probe output (failing closed)"],
    }
  }

  const text = String(output ?? "").replace(/\r\n?/g, "\n")
  const reports: Array<{ name: string; dependencies: string[] | null }> = []
  const reportRe =
    /^[ \t]*'([^'\r\n]+)'[ \t]+(?:depends on axioms:[ \t]*\[([^\]\r\n]*)\]|does not depend on any axioms)[ \t]*$/gim
  for (const m of text.matchAll(reportRe)) {
    reports.push({
      name: stripGuillemets(m[1].trim()),
      dependencies: m[2] === undefined ? null : m[2].split(",").map((d) => stripGuillemets(d.trim())).filter(Boolean),
    })
  }

  const findings: string[] = []
  const foreign = reports.filter((r) => r.name !== expected)
  if (foreign.length > 0) {
    findings.push(
      `refused: axiom probe output contains a report for a different declaration (${foreign.map((r) => `"${r.name}"`).join(", ")})`,
    )
  }
  const matches = reports.filter((r) => r.name === expected)
  if (matches.length === 0) {
    findings.push(
      `could not find exactly one '#print axioms ${expected}' report in Lean output (failing closed)`,
    )
  } else if (matches.length > 1) {
    findings.push(
      `refused: axiom probe output contains ${matches.length} reports for "${expected}"; a spoofed or duplicated report cannot be trusted`,
    )
  }
  if (foreign.length > 0 || matches.length !== 1) {
    return { recognized: false, dependencies: [], unauthorized: [], findings }
  }

  const evaluated = evaluateAxiomDependencies(matches[0].dependencies ?? [], allowedAxioms)
  return {
    recognized: true,
    dependencies: evaluated.dependencies,
    unauthorized: evaluated.unauthorized,
    findings: [...findings, ...evaluated.findings],
  }
}

export interface LeanAxiomProbeOptions {
  filePath: string
  declaration: string
  /** Run root when `filePath` is a run artifact: pins the probe create/unlink. */
  runDir?: string
  cwd?: string
  mode?: "lean" | "lake-env-lean" | "lake-build"
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  allowedAxioms?: string[]
}

export interface LeanAxiomProbeResult {
  executed: boolean
  check: AxiomDependencyCheck
  stdout: string
  stderr: string
  error?: string
}

function isSafeLeanDeclarationName(name: unknown): name is string {
  return typeof name === "string" && /^(?:«[^»]+»|[A-Za-z_][A-Za-z0-9_'.]*)$/.test(name)
}

/**
 * Compile the attempt plus `#print axioms <declaration>` in a throwaway file
 * (same cwd/mode/timeout discipline as the attempt check) and parse the axiom
 * set. Fails closed when the toolchain is unavailable or the output cannot be
 * interpreted.
 */
export function checkLeanAxiomDependencies(options: LeanAxiomProbeOptions): LeanAxiomProbeResult {
  const empty: AxiomDependencyCheck = { recognized: false, dependencies: [], unauthorized: [], findings: [] }
  const declaration = options.declaration
  if (!isSafeLeanDeclarationName(declaration)) {
    return {
      executed: false,
      check: {
        ...empty,
        findings: [`refused: unsafe Lean declaration name "${clean(declaration, 80)}"; cannot check transitive axioms`],
      },
      stdout: "",
      stderr: "",
      error: "unsafe declaration name",
    }
  }

  const read = readBoundedRegular(options.filePath)
  if (read.error || read.text === undefined) {
    return {
      executed: false,
      check: { ...empty, findings: [read.error ?? "could not read Lean attempt for axiom check"] },
      stdout: "",
      stderr: "",
      error: read.error,
    }
  }

  const hijacks = detectAxiomProbeHijacks(read.text)
  if (hijacks.length > 0) {
    return {
      executed: false,
      check: { ...empty, findings: hijacks },
      stdout: "",
      stderr: "",
      error: hijacks[0],
    }
  }

  const env = options.env ?? process.env
  const timeoutMs = Math.max(500, Math.min(120000, Number(options.timeoutMs) || 30000))
  const mode = options.mode ?? "lean"
  const cwd = options.cwd ?? dirname(options.filePath)
  const binName = mode === "lean" ? "lean" : "lake"
  const binPath = resolveExecutableOnPath(binName, env.PATH)
  if (!binPath) {
    return {
      executed: false,
      check: {
        ...empty,
        findings: [`${binName} executable not found on PATH; cannot check transitive axiom dependencies (failing closed)`],
      },
      stdout: "",
      stderr: "",
      error: `${binName} not found on PATH`,
    }
  }

  const probePath = join(
    dirname(options.filePath),
    `.lemma-axioms-${process.pid}-${randomBytes(8).toString("hex")}.lean`,
  )
  const probeSource = `${read.text.endsWith("\n") ? read.text : read.text + "\n"}#print axioms ${declaration}\n`
  const probeRel =
    options.runDir && !relative(resolve(options.runDir), probePath).startsWith("..")
      ? relative(resolve(options.runDir), probePath)
      : ""
  const pinnedProbe = probeRel !== "" && !isAbsolute(probeRel) && options.runDir !== undefined
  try {
    // ADR 0010: inside a run, create the throwaway probe through the pinned
    // parent descriptor, so a swapped intermediate directory cannot redirect it.
    if (pinnedProbe) writeOnceWithin(options.runDir as string, probeRel, probeSource)
    else writeFileSync(probePath, probeSource, { encoding: "utf8", flag: "wx" })
  } catch (err: any) {
    return {
      executed: false,
      check: { ...empty, findings: [`could not write axiom probe: ${clean(err?.message, 160)}`] },
      stdout: "",
      stderr: "",
      error: clean(err?.message, 160),
    }
  }

  let stdout = ""
  let stderr = ""
  let error: string | undefined
  let executed = false
  try {
    const args = mode === "lean" ? [probePath] : ["env", "lean", probePath]
    const proc = spawnSync(binPath, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    stdout = typeof proc.stdout === "string" ? proc.stdout : String(proc.stdout ?? "")
    stderr = typeof proc.stderr === "string" ? proc.stderr : String(proc.stderr ?? "")
    const status = typeof proc.status === "number" ? proc.status : -1
    if (proc.error) {
      const code = (proc.error as any)?.code
      error = code === "ETIMEDOUT" ? `${binName} axiom probe timed out after ${timeoutMs}ms` : clean(proc.error.message || code, 200)
    } else if (proc.status === null) {
      error = `${binName} axiom probe terminated by signal ${proc.signal ?? "unknown"}`
    } else if (status !== 0) {
      error = `${binName} axiom probe exited with status ${status}`
    } else {
      executed = true
    }
  } finally {
    try {
      if (pinnedProbe) unlinkWithin(options.runDir as string, probeRel)
      else unlinkSync(probePath)
    } catch {}
  }

  const check = parseLeanAxiomOutput(`${stdout}\n${stderr}`, options.allowedAxioms ?? [], declaration)
  if (error) check.findings.unshift(error)
  return {
    executed: executed && check.recognized,
    check,
    stdout: cleanBlock(stdout, 4000),
    stderr: cleanBlock(stderr, 4000),
    ...(error ? { error } : {}),
  }
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

/**
 * Canonicalize an axiom allowlist for comparison: strip guillemets, drop
 * blanks, dedupe, and sort. Standard axioms are implicit; this list only
 * extends them.
 */
export function canonicalAxiomSet(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [
    ...new Set(
      values
        .map((value) => stripGuillemets(String(value ?? "").trim()))
        .filter(Boolean),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function sameAxiomSet(a: unknown, b: unknown): boolean {
  const left = canonicalAxiomSet(a)
  const right = canonicalAxiomSet(b)
  return left.length === right.length && left.every((name, i) => name === right[i])
}

/** Reject an unsupported policy schema version; absent/null means current. */
function validatePolicyVersion(raw: any): string | undefined {
  if (
    raw.version === undefined ||
    raw.version === null ||
    raw.version === LEMMA_POLICY_VERSION
  ) {
    return undefined
  }
  return `refused: unsupported lemmaPolicy.version "${clean(raw.version, 16)}" (expected ${LEMMA_POLICY_VERSION})`
}

function validatePolicyAxiomEntry(entry: unknown): { name?: string; error?: string } {
  if (typeof entry !== "string") {
    return { error: `refused: lemmaPolicy.allowedAxioms entry "${clean(entry, 80)}" must be a string` }
  }
  const trimmed = entry.trim()
  if (!trimmed) {
    return { error: "refused: lemmaPolicy.allowedAxioms entries must be non-empty" }
  }
  // `clean` both strips control characters and caps length; a mismatch means
  // the entry would have been silently rewritten, so refuse instead.
  if (clean(trimmed, 128) !== trimmed) {
    return { error: `refused: unsafe lemmaPolicy.allowedAxioms entry "${clean(entry, 80)}"` }
  }
  const name = stripGuillemets(trimmed)
  if (!name || !isSafeLeanDeclarationName(name)) {
    return {
      error: `refused: invalid lemmaPolicy.allowedAxioms entry "${clean(entry, 80)}" (must be a safe Lean axiom name)`,
    }
  }
  if (name === "sorryAx") {
    return { error: "refused: sorryAx can never be allowlisted as a transitive axiom" }
  }
  return { name }
}

function validatePolicyAxioms(rawAxioms: unknown): { allowedAxioms?: string[]; error?: string } {
  if (rawAxioms === undefined || rawAxioms === null) {
    return { allowedAxioms: [] }
  }
  if (!Array.isArray(rawAxioms)) {
    return { error: "refused: lemmaPolicy.allowedAxioms must be an array of Lean axiom names" }
  }
  if (rawAxioms.length > MAX_LEMMA_ALLOWED_AXIOMS) {
    return {
      error: `refused: lemmaPolicy.allowedAxioms has ${rawAxioms.length} entries (max ${MAX_LEMMA_ALLOWED_AXIOMS})`,
    }
  }

  const allowedAxioms: string[] = []
  const seen = new Set<string>()
  for (const entry of rawAxioms) {
    const checked = validatePolicyAxiomEntry(entry)
    if (checked.error) return { error: checked.error }
    const name = checked.name
    if (!name || seen.has(name)) continue
    seen.add(name)
    allowedAxioms.push(name)
  }
  return { allowedAxioms }
}

/**
 * Validate a plan-time `lemmaPolicy`. Every configured axiom must be a safe
 * Lean name, the list is deduped, `sorryAx` is always rejected, and the list
 * is capped. The standard axioms remain allowed implicitly; this list only
 * extends them.
 */
export function validateLemmaPolicy(raw?: any): { policy?: LemmaPolicy; error?: string } {
  if (raw === undefined || raw === null) {
    return { policy: { version: LEMMA_POLICY_VERSION, allowedAxioms: [] } }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "refused: lemmaPolicy must be an object" }
  }
  const versionError = validatePolicyVersion(raw)
  if (versionError) {
    return { error: versionError }
  }
  const checked = validatePolicyAxioms(raw.allowedAxioms)
  if (checked.error || !checked.allowedAxioms) {
    return { error: checked.error ?? "refused: invalid lemmaPolicy.allowedAxioms" }
  }
  return { policy: { version: LEMMA_POLICY_VERSION, allowedAxioms: checked.allowedAxioms } }
}

/**
 * Resolve the approved allowlist from a persisted manifest. A missing policy
 * (legacy run) is fail-closed: only the standard axioms are permitted. A
 * malformed or tampered policy is also fail-closed and reported as an error.
 */
export function resolveManifestAxiomAllowlist(manifest: unknown): { allowedAxioms: string[]; error?: string } {
  const policy = (manifest as any)?.policy
  if (policy === undefined || policy === null) {
    return { allowedAxioms: [] }
  }
  const checked = validateLemmaPolicy(policy)
  if (checked.error || !checked.policy) {
    return {
      allowedAxioms: [],
      error: checked.error ?? "refused: lemma/manifest.json policy is malformed (failing closed)",
    }
  }
  return { allowedAxioms: checked.policy.allowedAxioms }
}

export interface LemmaNodeRecord {
  id: string
  parentId: string | null
  depth: number
  statement: string
  declaration?: string | null
  status: "pending" | "informal" | "formal" | "disprove" | "review" | "proved" | "disproved" | "blocked"
  attempts: number
  verifiedRound: number | null
  latestVerify: string | null
  children: string[]
  updatedAt: string
}

interface LemmaManifest {
  version: number
  sessionId: string
  phase: "FORMALIZE" | "SOLVING" | "VERIFIED" | "BLOCKED"
  bounds: LemmaBounds & { maxFormalizationRounds: number }
  /** Approved plan-time axiom policy. Absent on legacy manifests (standard axioms only). */
  policy?: LemmaPolicy
  toolchain: {
    status: ProbeStatus
    lean: string | null
    lake: string | null
    /** LEAP CLI version (resolved from `leap`, or legacy `leap-tools`). */
    leapTools: string | null
  }
  formalizationRounds: number
  nodes: Record<string, LemmaNodeRecord>
  updatedAt: string
}

interface FormalizationReviewFile {
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

function emptyManifest(
  sessionId: string,
  bounds: LemmaBounds,
  probe: LemmaProbeResult,
  policy: LemmaPolicy,
): LemmaManifest {
  return {
    version: 1,
    sessionId: clean(sessionId, 64),
    phase: "FORMALIZE",
    bounds: { ...bounds, maxFormalizationRounds: MAX_FORMALIZATION_ROUNDS },
    policy: { version: LEMMA_POLICY_VERSION, allowedAxioms: [...policy.allowedAxioms] },
    toolchain: {
      status: probe.status,
      lean: probe.lean.version,
      lake: probe.lake.version,
      leapTools: probe.leap.version,
    },
    formalizationRounds: 0,
    nodes: {},
    updatedAt: new Date().toISOString(),
  }
}

function ensureManifestPolicyConsistency(runDir: string, policy: LemmaPolicy): { error?: string } {
  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json unreadable" }
  const persisted = resolveManifestAxiomAllowlist(mRead.value)
  if (persisted.error) return { error: persisted.error }
  if (mRead.value.policy === undefined || mRead.value.policy === null) {
    if (policy.allowedAxioms.length > 0) {
      return {
        error:
          "refused: existing lemma/manifest.json has no approved axiom policy (legacy run); start a new run instead of widening it",
      }
    }
    return {}
  }
  if (!sameAxiomSet(persisted.allowedAxioms, policy.allowedAxioms)) {
    return {
      error: "refused: lemmaPolicy conflicts with the approved policy in lemma/manifest.json; nothing was written.",
    }
  }
  return {}
}

function initManifestFile(
  runDir: string,
  sessionId: string,
  bounds: LemmaBounds,
  probe: LemmaProbeResult,
  policy: LemmaPolicy | null,
): { error?: string } {
  const existing = ensureSafeSubpath(runDir, "lemma/manifest.json")
  if (existing.error) return { error: existing.error }
  if (!existsSync(existing.path!)) {
    const initialPolicy = policy ?? { version: LEMMA_POLICY_VERSION, allowedAxioms: [] }
    const w1 = writeJsonAtomicSafe(runDir, "lemma/manifest.json", emptyManifest(sessionId, bounds, probe, initialPolicy))
    return w1.error ? { error: w1.error } : {}
  }
  return policy ? ensureManifestPolicyConsistency(runDir, policy) : {}
}

function initFormalizationReviewFile(runDir: string): { error?: string } {
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

/**
 * `policy` is the plan-time decision: `null` means the caller omitted it (a
 * re-plan keeps the persisted policy untouched), while an object is compared
 * with any existing manifest and refused on mismatch.
 */
export function initLemmaArtifacts(
  runDir: string,
  sessionId: string,
  bounds: LemmaBounds,
  probe: LemmaProbeResult,
  policy: LemmaPolicy | null = null,
): { error?: string } {
  const manifestInit = initManifestFile(runDir, sessionId, bounds, probe, policy)
  if (manifestInit.error) return manifestInit
  const reviewInit = initFormalizationReviewFile(runDir)
  if (reviewInit.error) return reviewInit
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
  const draftRead = readSafeSubpath(draftSafe)
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
    const probRead = readSafeSubpath(probSafe)
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
    declaration?: string
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
    if (params.declaration !== undefined && params.declaration.trim() && !isSafeLeanDeclarationName(params.declaration.trim())) {
      return { error: `refused: invalid declaration "${clean(params.declaration, 80)}" (must be a Lean theorem/lemma name)` }
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
      declaration: params.declaration ? clean(params.declaration, 128).trim() || null : null,
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

    // Pre-create the node directory at node-add (attack-surface reduction).
    createDirWithin(runDir, `lemma/nodes/${lemmaId}`)
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
      const existingRead = readSafeSubpath(attemptSafe)
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
  const wasVerified = node.status === "proved" || node.status === "disproved"
  let nextStatement: string | undefined
  if (typeof params.statement === "string") {
    nextStatement = cleanBlock(params.statement, 2000)
  }
  let nextDeclaration: string | null | undefined
  if (typeof params.declaration === "string") {
    const decl = params.declaration.trim()
    if (!decl) {
      nextDeclaration = null
    } else if (!isSafeLeanDeclarationName(decl)) {
      return { error: `refused: invalid declaration "${clean(params.declaration, 80)}" (must be a Lean theorem/lemma name)` }
    } else {
      nextDeclaration = clean(decl, 128)
    }
  }
  const statementChanged = nextStatement !== undefined && nextStatement !== node.statement
  const declarationChanged = nextDeclaration !== undefined && (nextDeclaration ?? null) !== (node.declaration ?? null)
  if (wasVerified && (statementChanged || declarationChanged)) {
    return {
      error: `refused: cannot change statement/declaration on a ${node.status} node; reset it to "formal" first and re-verify`,
    }
  }
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
  if (nextStatement !== undefined) node.statement = nextStatement
  if (nextDeclaration !== undefined) node.declaration = nextDeclaration
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
  declaration?: string
  declarationType?: string
  axiomDependencies?: string[]
  unauthorizedAxioms?: string[]
}

/**
 * Resolve what the attempt must prove: the node's recorded `declaration` and
 * `statement`, falling back to the single declaration in the approved
 * `lemma/problem.lean` when the node does not record them. A node statement
 * always wins over the fallback, so an approved informal statement cannot be
 * silently replaced by the formalization.
 */
function expectedDeclarationForNode(
  runDir: string,
  node: LemmaNodeRecord,
): { declaration: string | null; statement: string; error?: string } {
  const recorded = node.declaration ? stripGuillemets(clean(node.declaration, 128).trim()) : ""
  const statement = cleanBlock(node.statement ?? "", 2000).trim()
  if (recorded) return { declaration: recorded, statement }

  const probSafe = ensureSafeSubpath(runDir, "lemma/problem.lean")
  if (probSafe.error || !probSafe.path) {
    return { declaration: null, statement, error: "cannot bind declaration: node has no declaration and lemma/problem.lean is unavailable" }
  }
  const probRead = readSafeSubpath(probSafe)
  if (probRead.error || probRead.text === undefined) {
    return {
      declaration: null,
      statement,
      error: `cannot bind declaration: node has no declaration and lemma/problem.lean is unreadable (${probRead.error ?? "unknown"})`,
    }
  }
  const scan = analyzeLeanDeclarations(probRead.text)
  if (scan.errors.length > 0) {
    return {
      declaration: null,
      statement,
      error: `cannot infer expected declaration from lemma/problem.lean: ${scan.errors[0]}`,
    }
  }
  if (scan.declarations.length !== 1) {
    return {
      declaration: null,
      statement,
      error: `cannot infer expected declaration: lemma/problem.lean declares ${scan.declarations.length} theorem/lemmas; record declaration on the node`,
    }
  }
  return {
    declaration: stripGuillemets(scan.declarations[0].name),
    statement: statement || scan.declarations[0].type,
  }
}

export function verifyLemmaNodeAttempt(
  runDir: string,
  params: {
    lemmaId: string
    round?: number
    mode?: "lean" | "lake-env-lean" | "lake-build"
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
): { report?: StampedLemmaVerifyReport; verifyPath?: string; node?: LemmaNodeRecord; error?: string } {
  if (!isSafeLemmaId(params.lemmaId)) {
    return { error: `refused: invalid lemmaId "${clean(params.lemmaId, 32)}"` }
  }
  const mRead = readJsonSafe<LemmaManifest>(runDir, "lemma/manifest.json")
  if (mRead.error || !mRead.value) return { error: mRead.error ?? "refused: lemma/manifest.json missing" }
  const manifest = mRead.value
  // The allowlist is approved at plan time and read from the manifest. It is
  // never taken from the tool caller, so an agent cannot widen the gate.
  const approvedPolicy = resolveManifestAxiomAllowlist(manifest)
  if (approvedPolicy.error) return { error: approvedPolicy.error }
  const approvedAxioms = approvedPolicy.allowedAxioms
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
  const attemptRead = readSafeSubpath(attemptSafe)
  if (attemptRead.error || attemptRead.text === undefined) {
    return { error: attemptRead.error ?? `refused: cannot read ${attemptRel}` }
  }
  const attemptHash = createHash("sha256").update(attemptRead.text, "utf8").digest("hex")

  const res = verifyLeanFile({
    filePath: attemptSafe.path,
    cwd: params.cwd ?? dirname(attemptSafe.path),
    mode: params.mode ?? "lean",
    env: params.env,
    allowedAxioms: approvedAxioms,
  })

  const report: StampedLemmaVerifyReport = {
    lemmaId: params.lemmaId,
    round,
    attemptFile: attemptRel,
    attemptHash,
    allowedAxioms: approvedAxioms,
    ...res,
  }

  // Acceptance is not proof of the assignment: bind the verified declaration to
  // the approved proposition and check its transitive axiom dependencies before
  // the PASS branch can mark the node proved/disproved.
  if (report.status === "PASS") {
    const expected = expectedDeclarationForNode(runDir, node)
    const binding: DeclarationBindingResult = expected.error
      ? { ok: false, findings: [expected.error] }
      : bindVerifiedDeclaration(attemptRead.text, {
          declaration: expected.declaration,
          statement: expected.statement,
          disproof: node.status === "disprove" || node.status === "disproved",
        })
    if (!binding.ok || !binding.declaration) {
      report.status = "FAIL"
      report.findings.push(...binding.findings)
    } else {
      const declaration = stripGuillemets(binding.declaration.name)
      report.declaration = declaration
      report.declarationType = binding.declaration.normalizedType
      const axioms = checkLeanAxiomDependencies({
        filePath: attemptSafe.path,
        runDir,
        declaration,
        cwd: params.cwd ?? dirname(attemptSafe.path),
        mode: params.mode ?? "lean",
        env: params.env,
        allowedAxioms: approvedAxioms,
      })
      report.axiomDependencies = axioms.check.dependencies
      report.unauthorizedAxioms = axioms.check.unauthorized
      if (!axioms.executed || !axioms.check.recognized || axioms.check.unauthorized.length > 0) {
        report.status = "FAIL"
        if (axioms.check.unauthorized.length > 0) report.hasUnauthorizedAxiom = true
        if (axioms.check.unauthorized.includes("sorryAx")) report.hasSorry = true
        report.findings.push(...axioms.check.findings)
        if (axioms.check.findings.length === 0) {
          report.findings.push(axioms.error ?? "transitive axiom check failed (failing closed)")
        }
      }
    }
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
  // Final evidence re-derives the approved allowlist from the manifest; a
  // forged verify report cannot widen it by editing its own `allowedAxioms`.
  const approvedPolicy = resolveManifestAxiomAllowlist(manifest)
  if (approvedPolicy.error) {
    reasons.push(`lemma manifest policy invalid: ${approvedPolicy.error}`)
  }
  const approvedAxioms = approvedPolicy.allowedAxioms

  let problemLeanPresent = false
  let currentProblemHash: string | undefined
  const probSafe = ensureSafeSubpath(runDir, "lemma/problem.lean")
  if (probSafe.error || !probSafe.path) {
    reasons.push(`lemma/problem.lean: ${probSafe.error ?? "unsafe path"}`)
  } else {
    const probRead = readSafeSubpath(probSafe)
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
    } else {
      // The stamped report is only valid for the node metadata it was produced
      // against. A later statement/declaration edit (or a replaced report) must
      // invalidate final evidence rather than silently reusing the old PASS.
      const expected = expectedDeclarationForNode(runDir, n)
      const reportDeclaration = typeof vReport.declaration === "string" ? stripGuillemets(vReport.declaration.trim()) : ""
      const reportType = typeof vReport.declarationType === "string" ? vReport.declarationType : ""
      if (expected.error) {
        reasons.push(`lemma node ${id}: ${expected.error}`)
      }
      if (!reportDeclaration) {
        reasons.push(`lemma node ${id}: stamped verification does not record the bound declaration`)
      } else if (expected.declaration && reportDeclaration !== expected.declaration) {
        reasons.push(
          `lemma node ${id}: stamped declaration "${reportDeclaration}" does not match node declaration "${expected.declaration}"`,
        )
      }
      if (!reportType) {
        reasons.push(`lemma node ${id}: stamped verification does not record the bound declaration type`)
      } else if (expected.statement && !leanStatementMatches(reportType, expected.statement, nStatus === "disproved")) {
        reasons.push(
          `lemma node ${id}: stamped declaration type "${clean(reportType, 240)}" does not match node statement "${clean(expected.statement, 240)}"`,
        )
      }
      if (!Array.isArray(vReport.axiomDependencies)) {
        reasons.push(`lemma node ${id}: stamped verification does not record axiomDependencies`)
      } else {
        if (!Array.isArray(vReport.allowedAxioms)) {
          reasons.push(`lemma node ${id}: stamped verification does not record the approved axiom allowlist`)
        } else if (!sameAxiomSet(vReport.allowedAxioms, approvedAxioms)) {
          reasons.push(
            `lemma node ${id}: stamped axiom allowlist does not match the approved lemma/manifest.json policy`,
          )
        }
        const evaluated = evaluateAxiomDependencies(vReport.axiomDependencies.map(String), approvedAxioms)
        if (evaluated.unauthorized.length > 0) {
          reasons.push(
            `lemma node ${id}: stamped axiomDependencies contain unauthorized dependencies (${evaluated.unauthorized.join(", ")})`,
          )
        }
      }
      if (
        !Array.isArray(vReport.unauthorizedAxioms) ||
        vReport.unauthorizedAxioms.length > 0 ||
        vReport.hasUnauthorizedAxiom === true
      ) {
        reasons.push(`lemma node ${id}: stamped verification records unauthorized or missing axiom data`)
      }

      if (vReport.attemptHash && vReport.attemptFile) {
        const attSafe = ensureSafeSubpath(runDir, vReport.attemptFile)
        if (attSafe.error || !attSafe.path) {
          reasons.push(`lemma node ${id}: ${attSafe.error ?? "unsafe attemptFile"}`)
        } else {
          const attRead = readSafeSubpath(attSafe)
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
