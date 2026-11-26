// opencode-teamwork — offline verifier
//
// Recomputes every named relation in a Teamwork run from bytes on disk and a
// public key (Ed25519) or an HMAC secret. It is read-only: it never writes into
// the run directory and never needs `ctx.storage`. With `--rerun` it
// re-executes the commands recorded in the signed `verify/rerun.json` inside a
// disposable git worktree; without it, a check is authenticated, never run.
//
// What it can prove
// -----------------
//   * every signed artifact's `_auth` envelope: path, canonical payload digest,
//     run nonce, key id and algorithm, pinned to the signed `run.manifest.json`;
//   * the manifest's request/requirements/plan/LEMMA/spec baseline hashes;
//   * victory `evidenceDigests`, audit `ruleChecks`/`reviewedDigests`, wave
//     `cites` (sha256 + bytes), handoff index auth/body/header/cites, and the
//     final verdict's `reportDigests`/`auditDigest`/`requirementsHash`;
//   * the four named `INCONSISTENT_*` contradictions;
//   * an optional git branch head/diff binding;
//   * an optional whole-run index snapshot (rollback detection);
//   * with `--rerun`, the signed `verify/rerun.json` commands re-executed in a
//     disposable worktree: exit code and stdout+stderr digest must match.
//
// What it cannot prove
// --------------------
// A verifier holding only the public key can recompute every byte digest,
// citation, branch binding and cross-artifact relation. It cannot prove an
// observation: a consistently authored false report passes every check. A
// whole-run rollback to an earlier signed set is undetectable without a
// snapshot or witness. See ADR 0015 and SECURITY.md.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import {
  artifactSignatureInput,
  canonicalJson,
  contentSha256Hex,
  payloadDigest,
  sha256Hex,
  witnessSignatureInput,
} from "../plugins/opencode-teamwork/approval-format.mjs"
import {
  ATTESTATION_PATH,
  attestationKeyIdFromPublicKey,
  attestationPolicyRank,
  evaluateAttestation,
  loadAttestationPublicKey,
  manifestAttestationPolicy,
  normalizeAttestationPolicy,
} from "../plugins/opencode-teamwork/attestation.mjs"
import {
  readWithinBounded,
  resolveTrustedExecutable,
  supportsFdContainment,
} from "../plugins/opencode-teamwork/safe-fs.mjs"

const VERIFY_SCHEMA_VERSION = 1

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}
const TOOL_VERSION = packageVersion()

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const WAVE_CITE_PATH = /^verify\/(?:evidence\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HANDOFF_CITE_PATH = /^(?:verify\/[A-Za-z0-9._-]+\.json|handoffs\/[A-Za-z0-9._-]+\.md)$/
const HANDOFF_PATH = /^handoffs\/[A-Za-z0-9._-]+\.md$/
const HANDOFF_HEADER = /^# HANDOFF — ([^\s—]+) — (team\/[a-z][a-z0-9-]{0,31})$/u

const MAX = {
  artifact: 8 * 1024 * 1024,
  report: 1024 * 1024,
  audit: 1024 * 1024,
  victory: 512 * 1024,
  final: 1024 * 1024,
  plan: 8 * 1024 * 1024,
  state: 8 * 1024 * 1024,
  request: 1024 * 1024,
  requirements: 256 * 1024,
  handoff: 64 * 1024,
  handoffIndex: 256 * 1024,
  evidence: 1024 * 1024,
  spec: 1024 * 1024,
  snapshot: 8 * 1024 * 1024,
  witness: 256 * 1024,
  rerun: 512 * 1024,
  attestation: 512 * 1024,
}

const INTEGRITY_MODES = ["development", "demo", "benchmark"]
const INTEGRITY_RULES = {
  fabricated_output: "development",
  core_logic_copied: "demo",
  delegated_core_work: "demo",
  test_source_read: "demo",
  external_dependency_used: "benchmark",
}
const INTEGRITY_RULE_IDS = Object.keys(INTEGRITY_RULES)
const CONTRADICTION_CODES = [
  "INCONSISTENT_VICTORY_TASK",
  "INCONSISTENT_REPORT_BRANCH",
  "INCONSISTENT_AUDIT_HIGH",
  "INCONSISTENT_WAVE_REPORT",
]
const TASK_SCOPED_ROLES = [
  "team/worker",
  "team/proof-worker",
  "team/segment-reviewer",
  "team/synthesizer",
  "team/verifier",
  "team/falsifier",
  "team/security-auditor",
]
const RUN_LEVEL_ROLES = ["team/victory-auditor", "team/sentinel", "team/orchestrator"]
const RUN_LEVEL_TASK_ID = "_run"

const WAVE_KINDS = {
  challenge: { agent: "team/falsifier", verdict: "PASS" },
  audit: { agent: "team/security-auditor", verdict: "CLEAN" },
}

export class VerifyUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = "VerifyUsageError"
    this.exitCode = 3
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function isWithin(child, parent) {
  const rel = relative(parent, child)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

function isSafeTaskId(value) {
  return typeof value === "string" && SAFE_TASK_ID.test(value)
}

function isPassStatus(status) {
  return status === "pass" || status === "verified_pass"
}

// ---------------------------------------------------------------------------
// Re-execution vocabulary (0.16.0)
// ---------------------------------------------------------------------------

const PROVENANCE_MODES = ["declared", "command"]
const COMMAND_MAX_ARGS = 32
const COMMAND_MAX_ARG_BYTES = 4096
const RERUN_DEFAULT_TIMEOUT_MS = 120000
const RERUN_MAX_TIMEOUT_MS = 600000
const RERUN_OUTPUT_CAP = 8 * 1024 * 1024
const SHELL_NAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "pdksh",
  "fish",
  "csh",
  "tcsh",
  "busybox",
  "ash",
  "powershell",
  "pwsh",
  "cmd",
  "cmd.exe",
  "sh.exe",
  "bash.exe",
])

/**
 * A manifest version before 4 cannot assert `command`; the field is additive
 * but the version gate keeps a 0.15 run's meaning stable.
 */
function manifestProvenance(manifest) {
  if (!manifest || Number(manifest.version) < 4) return "declared"
  return manifest.requiredProvenance === "command" ? "command" : "declared"
}

/**
 * A recorded command is argv only. Shell interpreters defeat re-execution
 * (they turn a string into arbitrary code), so a token naming a shell followed
 * by `-c` (or `cmd /c`) is refused. A wrapper script can still exec a shell;
 * that is a documented residual, not a parsing gap here.
 */
function commandShellRefusal(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const name = basename(String(argv[i])).toLowerCase()
    if (!SHELL_NAMES.has(name)) continue
    for (let j = i + 1; j < argv.length; j += 1) {
      const arg = String(argv[j]).toLowerCase()
      if (arg === "-c" || arg === "/c" || arg === "-command" || arg.startsWith("-command:")) {
        return `uses a shell interpreter (${name} ${String(argv[j])})`
      }
    }
  }
  return undefined
}

/** Normalise a recorded cwd to a relative, worktree-contained POSIX path. */
function normaliseCheckCwd(raw) {
  if (raw === undefined || raw === null || raw === "") return { cwd: "." }
  if (typeof raw !== "string") return { error: "cwd is not a string" }
  if (raw.includes("\0")) return { error: "cwd contains a NUL byte" }
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return { error: "cwd is absolute" }
  if (raw.startsWith("~")) return { error: "cwd starts with ~" }
  const segments = raw.split("/")
  for (const segment of segments) {
    if (segment === "..") return { error: "cwd escapes the worktree (..)" }
  }
  const cwd = segments.filter((segment) => segment !== "" && segment !== ".").join("/")
  return { cwd: cwd === "" ? "." : cwd }
}

function commandArgvProblem(argv) {
  if (!Array.isArray(argv)) return "command is not an array"
  if (argv.length === 0) return "command is empty"
  if (argv.length > COMMAND_MAX_ARGS) return `command has ${argv.length} args (cap ${COMMAND_MAX_ARGS})`
  for (const arg of argv) {
    if (typeof arg !== "string" || arg === "") return "command contains a non-string or empty arg"
    if (arg.includes("\0")) return "command contains a NUL byte"
    if (Buffer.byteLength(arg, "utf8") > COMMAND_MAX_ARG_BYTES) {
      return `command arg exceeds ${COMMAND_MAX_ARG_BYTES} bytes`
    }
  }
  const shell = commandShellRefusal(argv)
  if (shell) return `command ${shell}; record argv, not a shell line`
  return undefined
}

function commandDigest(command, cwd) {
  return contentSha256Hex(canonicalJson({ argv: command, cwd }))
}

/**
 * Validate one check under the checks[] v2 schema. `provenance` is the signed
 * manifest's requirement: under `command` a programmatic check must declare a
 * re-executable argv, while a `review` check is prose and may omit it.
 */
function verifierCheckProblems(check, index, provenance) {
  const problems = []
  const name = typeof check?.name === "string" && check.name ? check.name : `#${index + 1}`
  if (!check || typeof check !== "object" || check.passed !== true) problems.push(`check ${name} did not pass`)
  const output = typeof check?.output === "string" ? check.output : ""
  if (output !== "") {
    const expected = typeof check?.outputSha256 === "string" ? check.outputSha256 : ""
    if (expected !== sha256Hex(output)) problems.push(`check ${name} outputSha256 does not match its output`)
  } else if (check?.outputSha256 !== undefined) {
    problems.push(`check ${name} has outputSha256 without output`)
  }
  if (check?.exitCode !== undefined && check?.exitCode !== null) {
    const exitCode = Number(check.exitCode)
    if (!Number.isInteger(exitCode)) problems.push(`check ${name} exitCode is not an integer`)
    else if (check.passed === true && exitCode !== 0) {
      problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=true but exitCode=${exitCode}`)
    } else if (check.passed !== true && exitCode === 0) {
      problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=false but exitCode=0`)
    }
  }

  const hasCommand = check?.command !== undefined
  if (!hasCommand) {
    if (check?.commandSha256 !== undefined || check?.cwd !== undefined) {
      problems.push(`check ${name} records cwd/commandSha256 without a command`)
    }
    if (provenance === "command" && check?.type === "programmatic") {
      problems.push(`CHECK_COMMAND_MISSING: programmatic check ${name} has no command under requiredProvenance "command"`)
    }
    return { problems, command: false }
  }

  const argvProblem = commandArgvProblem(check.command)
  if (argvProblem) problems.push(`check ${name} ${argvProblem}`)
  const cwdCheck = normaliseCheckCwd(check.cwd)
  if (cwdCheck.error) problems.push(`check ${name} ${cwdCheck.error}`)
  if (!Number.isInteger(Number(check.exitCode))) {
    problems.push(`check ${name} with a command must record an integer exitCode`)
  } else if (check.passed === true && Number(check.exitCode) !== 0) {
    problems.push(`CHECK_EXIT_CONFLICT: check ${name} passed=true but exitCode=${Number(check.exitCode)}`)
  }
  if (!Number.isInteger(Number(check.outputBytes)) || Number(check.outputBytes) < 0) {
    problems.push(`check ${name} must record a non-negative integer outputBytes`)
  }
  if (typeof check.outputTruncated !== "boolean") {
    problems.push(`check ${name} must record a boolean outputTruncated`)
  }
  if (!Number.isInteger(Number(check.durationMs)) || Number(check.durationMs) < 0) {
    problems.push(`check ${name} must record a non-negative integer durationMs`)
  }
  if (!cwdCheck.error && Array.isArray(check.command)) {
    let expected
    try {
      expected = commandDigest(check.command, cwdCheck.cwd)
    } catch {
      expected = undefined
    }
    if (!SHA256_HEX.test(String(check.commandSha256 ?? ""))) {
      problems.push(`check ${name} commandSha256 is missing or invalid`)
    } else if (expected && check.commandSha256 !== expected) {
      problems.push(`check ${name} commandSha256 does not match {argv,cwd}`)
    }
  }
  if (check.outputTruncated === false && Number.isInteger(Number(check.outputBytes)) && output !== "") {
    if (Number(check.outputBytes) !== Buffer.byteLength(output, "utf8")) {
      problems.push(`check ${name} outputBytes does not match its untruncated output`)
    }
  }
  return { problems, command: true }
}

function hasRerunnableCommand(check) {
  return (
    check &&
    typeof check === "object" &&
    check.type === "programmatic" &&
    Array.isArray(check.command) &&
    check.command.length > 0 &&
    check.outputTruncated === false
  )
}


function integrityRank(mode) {
  return INTEGRITY_MODES.indexOf(mode)
}

function forbiddenRules(mode) {
  const rank = integrityRank(mode)
  return INTEGRITY_RULE_IDS.filter((rule) => rank >= integrityRank(INTEGRITY_RULES[rule]))
}

function parseIntegrityMode(text) {
  if (typeof text !== "string") return "development"
  const splitAt = text.indexOf("\n## Request")
  const header = splitAt === -1 ? text : text.slice(0, splitAt)
  const m = header.match(/^- Integrity mode:[ \t]*(\S+)[ \t]*$/m)
  return m && INTEGRITY_MODES.includes(m[1]) ? m[1] : "development"
}

function handoffSlug(agent) {
  if (typeof agent !== "string") return undefined
  const m = /^team\/([a-z][a-z0-9-]{0,31})$/.exec(agent.trim())
  return m ? m[1] : undefined
}

function handoffRelativePath(taskKey, slug) {
  return `handoffs/${taskKey}-${slug}.md`
}

function handoffCiteRelativePath(agent, taskId) {
  if (taskId) {
    if (agent === "team/verifier") return `verify/report-${taskId}.json`
    if (agent === "team/falsifier") return `verify/challenge-${taskId}.json`
    if (agent === "team/security-auditor") return `verify/audit-${taskId}.json`
    return undefined
  }
  if (agent === "team/security-auditor") return "verify/security-audit.json"
  if (agent === "team/victory-auditor") return "verify/victory.json"
  return undefined
}

function handoffAuthPayload(runId, entry) {
  return {
    kind: "teamwork.handoff",
    v: 1,
    runId,
    ...(typeof entry.runKeyId === "string" ? { runKeyId: entry.runKeyId } : {}),
    taskId: entry.taskId,
    agent: entry.agent,
    agentSessionId: entry.agentSessionId,
    round: entry.round,
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    generatedAt: entry.generatedAt,
    cites: entry.cites,
    ...(entry._auth !== undefined ? { _auth: entry._auth } : {}),
  }
}

function planBaselineHash(plan) {
  return sha256Hex(
    canonicalJson({
      topology: plan?.topology ?? null,
      integrityMode: plan?.integrityMode ?? null,
      verification: plan?.verification ?? null,
      victoryAudit: plan?.victoryAudit ?? null,
      ...(typeof plan?.victorySkipReason === "string" && plan.victorySkipReason !== ""
        ? { victorySkipReason: plan.victorySkipReason }
        : {}),
      ...(plan?.requireHandoffs !== undefined && plan?.requireHandoffsSource !== "legacy"
        ? { requireHandoffs: plan.requireHandoffs }
        : {}),
      route: plan?.route ?? null,
      lemmaBounds: plan?.lemmaBounds ?? null,
      ...(plan?.requireSameHost === true ? { requireSameHost: true } : {}),
      ...(plan?.attestationPolicy && plan.attestationPolicy !== "off"
        ? {
            attestationPolicy: plan.attestationPolicy,
            ...(typeof plan.attestationKeyId === "string" && plan.attestationKeyId !== ""
              ? { attestationKeyId: plan.attestationKeyId }
              : {}),
            ...(typeof plan.attestationIssuer === "string" && plan.attestationIssuer !== ""
              ? { attestationIssuer: plan.attestationIssuer }
              : {}),
          }
        : {}),
      tasks: Array.isArray(plan?.tasks) ? plan.tasks : [],
    }),
  )
}

function normalizeRequirements(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  if (raw.version !== 1) return undefined
  if (raw.source !== "caller" && raw.source !== "request") return undefined
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 50) return undefined
  const seen = new Set()
  const items = []
  for (const entry of raw.items) {
    if (!entry || typeof entry !== "object") return undefined
    const id = entry.id
    const text = entry.text
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id) || seen.has(id)) return undefined
    if (typeof text !== "string" || text.trim() === "" || text.length > 2000) return undefined
    seen.add(id)
    items.push({ id, text })
  }
  return { version: 1, source: raw.source, items }
}

export function computePlanHash(plan) {
  return planBaselineHash(plan)
}

export function computeRequirementsHash(raw) {
  const normalized = normalizeRequirements(raw)
  return normalized ? sha256Hex(canonicalJson(normalized)) : null
}

// ---------------------------------------------------------------------------
// Bounded, symlink-refusing reads (read-only)
// ---------------------------------------------------------------------------

function readRunFile(runRoot, relPath, maxBytes) {
  if (typeof relPath !== "string" || relPath === "" || relPath.includes("\0")) {
    return { status: "error", error: "unsafe path" }
  }
  const abs = join(runRoot, ...relPath.split("/"))
  if (!isWithin(abs, runRoot)) return { status: "error", error: "path escapes the run root" }
  let runReal
  try {
    runReal = realpathSync(runRoot)
  } catch (err) {
    return { status: "error", error: `realpath failed (${err?.code ?? "unknown"})` }
  }
  const r = readWithinBounded(runReal, abs, maxBytes)
  if (r.status === "absent") return { status: "absent" }
  if (r.status === "oversize") return { status: "error", error: `over the ${maxBytes}-byte cap` }
  if (r.status === "refused") return { status: "error", error: r.message }
  if (!supportsFdContainment()) {
    try {
      const real = realpathSync(abs)
      if (!isWithin(real, runReal)) return { status: "error", error: "real path escapes the run root" }
    } catch (err) {
      return { status: "error", error: `realpath failed (${err?.code ?? "unknown"})` }
    }
  }
  const bytes = r.bytes ?? Buffer.from(r.text, "utf8")
  return { status: "ok", bytes, text: r.text, size: bytes.length }
}

function readRunJson(runRoot, relPath, maxBytes) {
  const raw = readRunFile(runRoot, relPath, maxBytes)
  if (raw.status !== "ok") return raw
  let value
  try {
    value = JSON.parse(raw.text)
  } catch {
    return { status: "error", error: "malformed JSON" }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "error", error: "JSON value is not an object" }
  }
  return { ...raw, value }
}

// ---------------------------------------------------------------------------
// Envelope verification
// ---------------------------------------------------------------------------

function decodeBase64Url(value) {
  if (typeof value !== "string" || value === "" || !BASE64URL.test(value)) return undefined
  try {
    const buf = Buffer.from(value, "base64url")
    return buf.length > 0 ? buf : undefined
  } catch {
    return undefined
  }
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) return false
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

function envelopeMacInput(auth) {
  return canonicalJson({
    v: 1,
    alg: auth.alg,
    keyId: auth.keyId,
    path: auth.path,
    digest: auth.digest,
    ...(auth.nonce !== undefined ? { nonce: auth.nonce } : {}),
    at: auth.at,
  })
}

/**
 * Verify one artifact envelope. `pin` carries the signed manifest's alg/
 * keyId/nonce. `material` is `{kind:"ed25519",key:KeyObject}`,
 * `{kind:"hmac-sha256",key:Buffer}` or undefined (unverifiable).
 */
function checkEnvelope(relPath, payload, pin, material) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "AUTH_INVALID", message: "artifact is not an object" }
  }
  const auth = payload._auth
  if (auth === undefined || auth === null) {
    return { ok: false, code: "AUTH_MISSING", message: "artifact has no _auth envelope" }
  }
  if (typeof auth !== "object" || Array.isArray(auth)) {
    return { ok: false, code: "AUTH_INVALID", message: "_auth is not an object" }
  }
  if (auth.v !== 1) return { ok: false, code: "AUTH_INVALID", message: `_auth.v must be 1 (got ${String(auth.v)})` }
  if (auth.alg !== "hmac-sha256" && auth.alg !== "ed25519") {
    return { ok: false, code: "AUTH_INVALID", message: `_auth.alg is not recognised (${String(auth.alg)})` }
  }
  if (auth.path !== relPath) {
    return { ok: false, code: "AUTH_INVALID", message: `_auth.path ${String(auth.path)} does not match ${relPath}` }
  }
  if (typeof auth.keyId !== "string" || auth.keyId.trim() === "") {
    return { ok: false, code: "AUTH_INVALID", message: "_auth.keyId is missing" }
  }
  if (!SHA256_HEX.test(String(auth.digest ?? ""))) {
    return { ok: false, code: "AUTH_INVALID", message: "_auth.digest is not a sha256 hex string" }
  }
  if (typeof auth.at !== "string" || auth.at === "") {
    return { ok: false, code: "AUTH_INVALID", message: "_auth.at is missing" }
  }
  if (pin.alg && auth.alg !== pin.alg) {
    return {
      ok: false,
      code: "AUTH_INVALID",
      message: `_auth.alg ${auth.alg} does not match the signed run algorithm ${pin.alg}`,
    }
  }
  if (pin.keyId && auth.keyId !== pin.keyId) {
    return {
      ok: false,
      code: "AUTH_INVALID",
      message: `_auth.keyId ${auth.keyId} does not match the signed run key id ${pin.keyId}`,
    }
  }
  if (pin.nonce !== null && pin.nonce !== undefined && auth.nonce !== pin.nonce) {
    return { ok: false, code: "AUTH_INVALID", message: "artifact nonce does not match the run nonce" }
  }
  let digest
  try {
    digest = payloadDigest(payload)
  } catch {
    return { ok: false, code: "AUTH_INVALID", message: "payload is not canonicalisable" }
  }
  if (!safeEqualHex(digest, auth.digest)) {
    return { ok: false, code: "AUTH_INVALID", message: "artifact digest does not match its _auth envelope" }
  }
  if (!material) {
    return {
      ok: false,
      unknown: true,
      code: "AUTH_UNAVAILABLE",
      message: "no key material was supplied for this algorithm",
      auth,
    }
  }
  if (auth.alg === "hmac-sha256") {
    if (material.kind !== "hmac-sha256") {
      return {
        ok: false,
        unknown: true,
        code: "AUTH_UNAVAILABLE",
        message: "the artifact is HMAC-signed but no HMAC key was supplied",
        auth,
      }
    }
    if (!SHA256_HEX.test(String(auth.mac ?? ""))) {
      return { ok: false, code: "AUTH_INVALID", message: "_auth.mac is not a sha256 hex string" }
    }
    const expected = createHmac("sha256", material.key).update(envelopeMacInput(auth), "utf8").digest("hex")
    if (!safeEqualHex(expected, auth.mac)) {
      return { ok: false, code: "AUTH_INVALID", message: "artifact MAC is invalid" }
    }
    return { ok: true, auth }
  }
  if (material.kind !== "ed25519") {
    return {
      ok: false,
      unknown: true,
      code: "AUTH_UNAVAILABLE",
      message: "the artifact is Ed25519-signed but no public key was supplied",
      auth,
    }
  }
  if (typeof auth.nonce !== "string" || auth.nonce === "") {
    return { ok: false, code: "AUTH_INVALID", message: "an ed25519 _auth envelope requires a nonce" }
  }
  const sig = decodeBase64Url(auth.sig)
  if (!sig || sig.length !== 64) {
    return { ok: false, code: "AUTH_INVALID", message: "_auth.sig is not a 64-byte base64url Ed25519 signature" }
  }
  const message = artifactSignatureInput("ed25519", auth.keyId, auth.path, auth.nonce, payload)
  if (!cryptoVerify(null, Buffer.from(message, "utf8"), material.key, sig)) {
    return { ok: false, code: "AUTH_INVALID", message: "artifact Ed25519 signature is invalid" }
  }
  return { ok: true, auth }
}

function checkWitnessReceipt(record, runId, manifestAuth, publicKey, expectedKeyId) {
  if (!record || typeof record !== "object") return { ok: false, code: "AUTH_INVALID", message: "receipt is not an object" }
  const inner = record.record && typeof record.record === "object" ? record.record : record
  if (inner.runId !== runId) return { ok: false, code: "AUTH_INVALID", message: "witness record is for another run" }
  if (inner.path !== "run.manifest.json") {
    return { ok: false, code: "AUTH_INVALID", message: "witness record is for another artifact" }
  }
  if (!manifestAuth || inner.digest !== manifestAuth.digest) {
    return { ok: false, code: "AUTH_INVALID", message: "witness record digest does not match the signed manifest" }
  }
  if (manifestAuth.nonce && inner.nonce !== manifestAuth.nonce) {
    return { ok: false, code: "AUTH_INVALID", message: "witness record nonce does not match the signed manifest" }
  }
  if (expectedKeyId && record.keyId !== expectedKeyId) {
    return { ok: false, code: "AUTH_INVALID", message: "witness key id does not match --witness-key-id" }
  }
  if (record.alg !== "ed25519") {
    return { ok: false, code: "AUTH_INVALID", message: "witness receipt is not an Ed25519 signature" }
  }
  const sig = decodeBase64Url(record.sig)
  if (!sig || sig.length !== 64) return { ok: false, code: "AUTH_INVALID", message: "witness signature is malformed" }
  const message = witnessSignatureInput(runId, inner.path, inner.digest, inner.nonce ?? "", inner.at)
  if (!cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)) {
    return { ok: false, code: "AUTH_INVALID", message: "witness signature is invalid" }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

function readKeySource(value, label) {
  const raw = String(value ?? "").trim()
  if (raw === "") throw new VerifyUsageError(`${label} is empty`)
  if (!raw.startsWith("@")) return raw
  const path = raw.slice(1)
  try {
    return readFileSync(resolve(path), "utf8").trim()
  } catch (err) {
    throw new VerifyUsageError(`cannot read ${label} file ${path} (${err?.code ?? "unknown"})`)
  }
}

function loadPublicKey(value) {
  const raw = readKeySource(value, "--public-key")
  try {
    if (raw.includes("BEGIN PUBLIC KEY")) return createPublicKey(raw)
    const der = Buffer.from(raw, "base64url")
    return createPublicKey({ key: der, format: "der", type: "spki" })
  } catch {
    throw new VerifyUsageError("--public-key is not a base64url SPKI Ed25519 public key")
  }
}

function loadHmacKey(value) {
  const raw = readKeySource(value, "--hmac-key")
  if (!BASE64URL.test(raw)) throw new VerifyUsageError("--hmac-key must be base64url")
  let buf
  try {
    buf = Buffer.from(raw, "base64url")
  } catch {
    throw new VerifyUsageError("--hmac-key must be base64url")
  }
  if (buf.length !== 32) throw new VerifyUsageError("--hmac-key must decode to 32 bytes")
  return buf
}

// ---------------------------------------------------------------------------
// Git helpers (optional)
// ---------------------------------------------------------------------------

function gitCapture(cwd, args) {
  const gitBin = resolveTrustedExecutable("git")
  if (!gitBin) return undefined
  try {
    return execFileSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    return undefined
  }
}

function gitAvailable(repo) {
  return gitCapture(repo, ["rev-parse", "--git-dir"]) !== undefined
}

// ---------------------------------------------------------------------------
// Run-root resolution
// ---------------------------------------------------------------------------

function resolveRunRoot(options) {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd()
  let target
  if (options.runDir !== undefined && options.session !== undefined) {
    throw new VerifyUsageError("use --session or --run-dir, not both")
  }
  if (options.runDir !== undefined) {
    target = resolve(String(options.runDir))
  } else if (options.session !== undefined) {
    if (typeof options.session !== "string" || !SESSION_ID.test(options.session)) {
      throw new VerifyUsageError("--session must match ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
    }
    const root = options.repo ? resolve(options.repo) : cwd
    target = join(root, ".opencode", "teamwork", options.session)
  } else {
    throw new VerifyUsageError("verify needs --session <id> or --run-dir <path>")
  }

  let st
  try {
    st = lstatSync(target)
  } catch {
    throw new VerifyUsageError(`run directory not found: ${target}`)
  }
  if (st.isSymbolicLink()) return { error: "run root is a symlink", given: target }
  if (!st.isDirectory()) return { error: "run root is not a directory", given: target }
  const runRoot = realpathSync(target)
  const verifyPath = join(runRoot, "verify")
  try {
    const vst = lstatSync(verifyPath)
    if (vst.isSymbolicLink()) return { error: "verify root is a symlink", given: target, runRoot }
    if (!vst.isDirectory()) return { error: "verify root is not a directory", given: target, runRoot }
  } catch (err) {
    if (err?.code !== "ENOENT") return { error: "verify root is unreadable", given: target, runRoot }
  }
  return { runRoot, given: target }
}

// ---------------------------------------------------------------------------
// Re-execution (`verify --rerun`), 0.16.0
// ---------------------------------------------------------------------------

/** Unkeyed hash of a checkout's working tree (excludes `.git`). */
function hashSourceTree(root) {
  const files = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of entries) {
      if (prefix === "" && dirent.name === ".git") continue
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      const abs = join(dir, dirent.name)
      if (dirent.isSymbolicLink()) {
        try {
          files.push([rel, "symlink", readlinkSync(abs)])
        } catch {
          files.push([rel, "symlink", null])
        }
        continue
      }
      if (dirent.isDirectory()) {
        walk(abs, rel)
        continue
      }
      let fd = null
      try {
        fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0))
        const fst = fstatSync(fd)
        if (fst.isDirectory()) {
          closeSync(fd)
          fd = null
          walk(abs, rel)
        } else if (fst.isFile()) {
          files.push([rel, "file", fst.size, contentSha256Hex(readFileSync(fd))])
        }
      } catch (err) {
        if (err?.code === "ELOOP" || err?.code === "EMLINK") {
          try {
            files.push([rel, "symlink", readlinkSync(abs)])
          } catch {
            files.push([rel, "symlink", null])
          }
        } else {
          files.push([rel, "unreadable", null])
        }
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd)
          } catch {}
        }
      }
    }
  }
  walk(root, "")
  return contentSha256Hex(canonicalJson(files))
}

function rerunEnv(scratchRoot) {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(scratchRoot, "home"),
    TMPDIR: join(scratchRoot, "tmp"),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TZ: "UTC",
  }
  mkdirSync(env.HOME, { recursive: true })
  mkdirSync(env.TMPDIR, { recursive: true })
  return env
}

/**
 * Execute recorded argv in disposable detached worktrees. Nothing touches the
 * source checkout; a best-effort before/after hash of its working tree refuses
 * a command that wrote outside its worktree (the `.git` admin directory is
 * excluded because `git worktree add/remove` legitimately writes there).
 */
function executeRerunCommands({ repo, planned, timeoutSeconds, keepWorktree }) {
  const results = []
  const worktrees = []
  const scratchRoot = mkdtempSync(join(tmpdir(), "teamwork-rerun-"))
  const env = rerunEnv(scratchRoot)
  const before = hashSourceTree(repo)
  const bySha = new Map()
  try {
    for (const task of planned) {
      for (const check of task.checks) {
        const label = `rerun:${task.taskId}:${check.index}`
        if (!task.headSha) {
          results.push({
            id: label,
            status: "fail",
            code: "REPORT_UNBOUND",
            detail: `${task.taskId} check ${check.name} has no report.headSha; the command cannot be re-executed against a commit`,
            artifacts: [`verify/report-${task.taskId}.json`],
            taskId: task.taskId,
          })
          continue
        }
        const argv = check.argv
        const shell = commandShellRefusal(Array.isArray(argv) ? argv : [])
        if (shell) {
          results.push({
            id: label,
            status: "fail",
            code: "command-refused",
            detail: `${task.taskId} check ${check.name}: ${shell}; refusing to re-execute a shell line`,
            artifacts: ["verify/rerun.json"],
            taskId: task.taskId,
          })
          continue
        }
        const cwdCheck = normaliseCheckCwd(check.cwd)
        if (cwdCheck.error) {
          results.push({
            id: label,
            status: "fail",
            code: "command-refused",
            detail: `${task.taskId} check ${check.name}: ${cwdCheck.error}; refusing a cwd outside the worktree`,
            artifacts: ["verify/rerun.json"],
            taskId: task.taskId,
          })
          continue
        }
        let worktree = bySha.get(task.headSha)
        if (!worktree) {
          const dir = join(scratchRoot, `wt-${bySha.size}`)
          try {
            const gitBin = resolveTrustedExecutable("git")
            if (!gitBin) throw new Error("git unavailable")
            execFileSync(gitBin, ["-C", repo, "worktree", "add", "--detach", dir, task.headSha], {
              encoding: "utf8",
              timeout: 60000,
              stdio: ["ignore", "pipe", "pipe"],
            })
            worktree = dir
            bySha.set(task.headSha, dir)
            worktrees.push(dir)
          } catch {
            results.push({
              id: label,
              status: "unknown",
              code: "command-unavailable",
              detail: `${task.taskId} check ${check.name}: cannot create a worktree at ${String(task.headSha).slice(0, 12)} in ${repo}`,
              artifacts: ["verify/rerun.json"],
              taskId: task.taskId,
            })
            continue
          }
        }
        let cwdAbs
        try {
          cwdAbs = resolve(worktree, cwdCheck.cwd)
          if (!isWithin(cwdAbs, worktree)) throw new Error("escapes")
          const realCwd = realpathSync(cwdAbs)
          const realWt = realpathSync(worktree)
          if (!isWithin(realCwd, realWt)) throw new Error("escapes")
          if (!lstatSync(realCwd).isDirectory()) throw new Error("not a directory")
          cwdAbs = realCwd
        } catch {
          results.push({
            id: label,
            status: "fail",
            code: "command-refused",
            detail: `${task.taskId} check ${check.name}: cwd ${cwdCheck.cwd} is not a directory inside the worktree`,
            artifacts: ["verify/rerun.json"],
            taskId: task.taskId,
          })
          continue
        }
        const recordedTimeout = Number.isInteger(Number(check.timeoutMs))
          ? Math.min(Math.max(Number(check.timeoutMs), 1), RERUN_MAX_TIMEOUT_MS)
          : RERUN_DEFAULT_TIMEOUT_MS
        const timeoutMs =
          timeoutSeconds !== undefined ? Math.min(recordedTimeout, Math.max(1, Math.trunc(timeoutSeconds * 1000))) : recordedTimeout
        const started = process.hrtime.bigint()
        const spawned = spawnSync(argv[0], argv.slice(1), {
          cwd: cwdAbs,
          env,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: RERUN_OUTPUT_CAP,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
        const durationMs = Number((process.hrtime.bigint() - started) / 1000000n)
        const stdout = Buffer.isBuffer(spawned.stdout) ? spawned.stdout : Buffer.alloc(0)
        const stderr = Buffer.isBuffer(spawned.stderr) ? spawned.stderr : Buffer.alloc(0)
        const output = Buffer.concat([stdout, stderr])
        const outputSha256 = contentSha256Hex(output)
        const base = { taskId: task.taskId, name: check.name, argv, cwd: cwdCheck.cwd, durationMs }
        if (spawned.error?.code === "ETIMEDOUT" || spawned.signal === "SIGKILL") {
          results.push({
            ...base,
            id: label,
            status: "fail",
            code: "command-timeout",
            detail: `${task.taskId} check ${check.name} exceeded ${timeoutMs} ms`,
            artifacts: ["verify/rerun.json"],
          })
          continue
        }
        if (spawned.error) {
          results.push({
            ...base,
            id: label,
            status: "unknown",
            code: "command-unavailable",
            detail: `${task.taskId} check ${check.name}: cannot execute ${basename(String(argv[0]))} (${spawned.error.code ?? "spawn error"})`,
            artifacts: ["verify/rerun.json"],
          })
          continue
        }
        const exitCode = Number.isInteger(spawned.status) ? spawned.status : 1
        if (exitCode !== check.expectedExit || exitCode !== 0) {
          results.push({
            ...base,
            id: label,
            status: "fail",
            code: "command-failed",
            detail: `${task.taskId} check ${check.name} exited ${exitCode} (recorded ${check.expectedExit}); the claim is not reproducible`,
            artifacts: ["verify/rerun.json"],
          })
          continue
        }
        if (outputSha256 !== check.outputSha256 || output.length !== check.outputBytes) {
          results.push({
            ...base,
            id: label,
            status: "fail",
            code: "output-digest-mismatch",
            detail: `${task.taskId} check ${check.name} produced ${output.length} bytes (sha256 ${outputSha256.slice(0, 12)}), not the recorded ${check.outputBytes} (${String(check.outputSha256).slice(0, 12)})`,
            artifacts: ["verify/rerun.json"],
          })
          continue
        }
        results.push({
          ...base,
          id: label,
          status: "pass",
          code: null,
          detail: `${task.taskId} check ${check.name} re-executed with exit 0 and matching output digest (${output.length} bytes)`,
          artifacts: ["verify/rerun.json"],
        })
      }
    }
  } finally {
    if (!keepWorktree) {
      const gitBin = resolveTrustedExecutable("git")
      for (const dir of [...worktrees].reverse()) {
        if (gitBin) {
          try {
            execFileSync(gitBin, ["-C", repo, "worktree", "remove", "--force", dir], {
              encoding: "utf8",
              timeout: 30000,
              stdio: ["ignore", "pipe", "pipe"],
            })
            continue
          } catch {
            // Fall through to the direct removal below.
          }
        }
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {}
      }
      if (worktrees.length > 0 && gitBin) {
        try {
          execFileSync(gitBin, ["-C", repo, "worktree", "prune"], {
            encoding: "utf8",
            timeout: 30000,
            stdio: ["ignore", "pipe", "pipe"],
          })
        } catch {}
      }
      try {
        rmSync(scratchRoot, { recursive: true, force: true })
      } catch {}
    }
  }
  const after = hashSourceTree(repo)
  if (before !== after) {
    results.push({
      id: "rerun:source-tree",
      status: "fail",
      code: "source-tree-modified",
      detail: `the source checkout at ${repo} changed while re-executing recorded commands; a command wrote outside its worktree`,
      artifacts: [],
      taskId: null,
    })
  }
  return {
    results,
    worktrees,
    scratchRoot: keepWorktree ? scratchRoot : undefined,
  }
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

function buildPageDigestIndex(pages) {
  const index = new Map()
  if (!Array.isArray(pages)) return index
  for (const entry of pages) {
    if (typeof entry?.file === "string" && typeof entry?.sha256 === "string") {
      index.set(entry.file, entry.sha256.toLowerCase())
    }
  }
  return index
}

function verifyDocumentVisualAudit(runRoot, pass, fail) {
  const docManifestRead = readRunJson(runRoot, "document-review/manifest.json", MAX.artifact)
  if (docManifestRead.status !== "ok") return
  const docManifest = docManifestRead.value
  if (docManifest?.format !== "pdf" || docManifest?.pageImageStatus !== "rendered") return

  const visualRead = readRunJson(runRoot, "document-review/visual-audit.json", MAX.artifact)
  if (visualRead.status !== "ok") {
    fail(
      "document-review:visualAudit",
      "VISUAL_AUDIT_MISSING",
      "document-review/visual-audit.json is missing or unreadable on a rendered PDF run",
      ["document-review/manifest.json", "document-review/visual-audit.json"],
    )
    return
  }
  const audit = visualRead.value
  if (audit?.verdict !== "PASS") {
    fail(
      "document-review:visualAudit",
      "VISUAL_AUDIT_FAILED",
      `document-review/visual-audit.json verdict is ${String(audit?.verdict ?? "unknown")} (expected PASS)`,
      ["document-review/visual-audit.json"],
    )
    return
  }
  const inspected = Array.isArray(audit?.inspectedImages) ? audit.inspectedImages : []
  if (inspected.length === 0) {
    fail(
      "document-review:visualAudit",
      "VISUAL_AUDIT_FAILED",
      "document-review/visual-audit.json cites no inspectedImages",
      ["document-review/visual-audit.json"],
    )
    return
  }
  const pageManifestRead = readRunJson(runRoot, "document-review/page_images/manifest.json", MAX.artifact)
  if (pageManifestRead.status !== "ok") {
    fail(
      "document-review:visualAudit",
      "VISUAL_AUDIT_STALE",
      "document-review/page_images/manifest.json is missing or unreadable",
      ["document-review/page_images/manifest.json"],
    )
    return
  }
  const pageIndex = buildPageDigestIndex(pageManifestRead.value?.pages)
  for (const item of inspected) {
    const file = typeof item?.file === "string" ? item.file : ""
    const sha = typeof item?.sha256 === "string" ? item.sha256.toLowerCase() : ""
    if (!file || pageIndex.get(file) !== sha) {
      fail(
        "document-review:visualAudit",
        "VISUAL_AUDIT_STALE",
        `document-review/visual-audit.json image "${file}" does not match page_images/manifest.json`,
        ["document-review/visual-audit.json", "document-review/page_images/manifest.json"],
      )
      return
    }
  }
  pass(
    "document-review:visualAudit",
    `document-review/visual-audit.json passed with ${inspected.length} manifest-verified page image(s)`,
    ["document-review/visual-audit.json", "document-review/page_images/manifest.json"],
  )
}

export async function verifyRun(options = {}) {
  if (options.timeout !== undefined && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0)) {
    throw new VerifyUsageError("--timeout must be a positive number of seconds")
  }
  if (options.rerun === true && options.repo === undefined) {
    throw new VerifyUsageError("--rerun needs --repo <clean-checkout>")
  }
  if (options.rerun === true && options.allowUnsigned === true) {
    throw new VerifyUsageError(
      "--allow-unsigned cannot be combined with --rerun: re-execution requires an authenticated manifest, verify/rerun.json and reports",
    )
  }
  const checks = []
  const relations = []
  const reasons = []

  const addCheck = (id, level, status, detail, artifacts = []) => {
    checks.push({ id, level, status, detail, artifacts })
  }
  const pass = (id, detail, artifacts, level = "required") => addCheck(id, level, "pass", detail, artifacts)
  const fail = (id, code, detail, artifacts) => {
    addCheck(id, "required", "fail", `[${code}] ${detail}`, artifacts)
    reasons.push(`[${code}] ${detail}`)
  }
  const warn = (id, code, detail, artifacts) => {
    addCheck(id, "warning", "warn", `[${code}] ${detail}`, artifacts)
  }
  const unknownCheck = (id, code, detail, artifacts) => {
    addCheck(id, "required", "unknown", `[${code}] ${detail}`, artifacts)
    reasons.push(`[${code}] ${detail}`)
  }
  const skip = (id, detail, artifacts, level = "info") => addCheck(id, level, "skip", detail, artifacts)
  const relate = (from, to, kind, expected, actual) => relations.push({ from, to, kind, expected, actual })

  const resolved = resolveRunRoot(options)
  if (resolved.error) {
    fail("run-root", "RUN_ROOT", `${resolved.error}: ${resolved.given ?? ""}`.trim(), [])
    return finish({
      runId: resolved.runRoot ? basename(resolved.runRoot) : basename(resolved.given ?? "unknown"),
      runPath: resolved.runRoot ?? resolved.given ?? "",
      trust: {
        alg: null,
        keyId: null,
        source: "none",
        runTrustLevel: null,
        approval: { status: "UNAVAILABLE" },
        witness: { status: "UNAVAILABLE" },
      },
      checks,
      relations,
      reasons,
      failOnWarning: options.failOnWarning === true,
    })
  }
  const runRoot = resolved.runRoot
  const runId = basename(runRoot)
  if (!RUN_ID.test(runId)) {
    throw new VerifyUsageError(`run directory name is not a valid run id: ${runId}`)
  }

  // --- key material -------------------------------------------------------
  let publicKey
  let hmacKey
  if (options.publicKey !== undefined && options.hmacKey !== undefined) {
    throw new VerifyUsageError("use --public-key or --hmac-key, not both")
  }
  if (options.publicKey !== undefined) publicKey = loadPublicKey(options.publicKey)
  if (options.hmacKey !== undefined) hmacKey = loadHmacKey(options.hmacKey)
  if (hmacKey && !options.hmacKeyId) {
    // The manifest pins the key id; a caller may still pass the id explicitly.
    // Without either we cannot name the trust anchor.
  }
  let witnessKey
  if (options.witnessPublicKey !== undefined) {
    try {
      const raw = readKeySource(options.witnessPublicKey, "--witness-public-key")
      witnessKey = raw.includes("BEGIN PUBLIC KEY")
        ? createPublicKey(raw)
        : createPublicKey({ key: Buffer.from(raw, "base64url"), format: "der", type: "spki" })
    } catch (err) {
      if (err instanceof VerifyUsageError) throw err
      throw new VerifyUsageError("--witness-public-key is not a valid Ed25519 public key")
    }
  }
  let attestationKey
  let attestationKeyRaw
  if (options.attestationPublicKey !== undefined) {
    attestationKeyRaw = readKeySource(options.attestationPublicKey, "--attestation-public-key")
    attestationKey = loadAttestationPublicKey(attestationKeyRaw)
    if (!attestationKey) {
      throw new VerifyUsageError("--attestation-public-key is not a valid Ed25519 public key")
    }
  }
  if (options.requireIndex === true || options.requireIndex === "") {
    // A rollback check was requested without a snapshot: the verifier cannot
    // establish the relation, so it must not report PASS.
  }
  if (options.requireGit === true && options.repo === undefined) {
    throw new VerifyUsageError("--require-git needs --repo <path>")
  }

  // --- manifest -----------------------------------------------------------
  const manifestRead = readRunJson(runRoot, "run.manifest.json", MAX.artifact)
  let manifest
  let manifestAuth
  let manifestEnvelopeOk = false
  let runNonce = null
  let runKeyId = null
  let runAlg = null
  let signedRun = false
  let material
  // H1: --allow-unsigned is a legacy-run concession only. A manifest on disk,
  // signed or not, never downgrades a missing envelope to a warning: the run
  // claimed to have a trust anchor, and the missing envelope breaks it.
  const allowedUnsigned = options.allowUnsigned === true && manifestRead.status === "absent"

  if (manifestRead.status === "absent") {
    if (allowedUnsigned) {
      unknownCheck(
        "manifest:envelope",
        "UNSIGNED_LEGACY_ALLOWED",
        "no signed run.manifest.json; relations were recomputed for an unsigned legacy run, but authenticity is not established and it cannot be reported PASS.",
        ["run.manifest.json"],
      )
    } else {
      unknownCheck(
        "manifest:envelope",
        "UNSIGNED_LEGACY",
        "no signed run.manifest.json; this is an unsigned legacy run and cannot be verified. Pass --allow-unsigned to recompute relations only.",
        ["run.manifest.json"],
      )
    }
    if (hmacKey) material = { kind: "hmac-sha256", key: hmacKey }
    else if (publicKey) material = { kind: "ed25519", key: publicKey }
    runAlg = hmacKey ? "hmac-sha256" : publicKey ? "ed25519" : null
    runKeyId = options.hmacKeyId ?? options.keyId ?? null
  } else if (manifestRead.status !== "ok") {
    fail("manifest:envelope", "AUTH_INVALID", `run.manifest.json is unreadable (${manifestRead.error})`, [
      "run.manifest.json",
    ])
    signedRun = true
  } else {
    manifest = manifestRead.value
    signedRun = true
    const declaredAlg = manifest?._auth?.alg
    const declaredKeyId = typeof manifest?.runKeyId === "string" ? manifest.runKeyId : null
    const declaredNonce = typeof manifest?.runNonce === "string" && manifest.runNonce !== "" ? manifest.runNonce : null
    if (hmacKey) material = { kind: "hmac-sha256", key: hmacKey }
    else if (publicKey) material = { kind: "ed25519", key: publicKey }
    if (options.keyId !== undefined && declaredKeyId && options.keyId !== declaredKeyId) {
      fail(
        "manifest:envelope",
        "AUTH_INVALID",
        `--key-id ${options.keyId} does not match run.manifest.json runKeyId ${declaredKeyId}`,
        ["run.manifest.json"],
      )
    }
    if (options.hmacKeyId !== undefined && declaredKeyId && options.hmacKeyId !== declaredKeyId) {
      fail(
        "manifest:envelope",
        "AUTH_INVALID",
        `--hmac-key-id ${options.hmacKeyId} does not match run.manifest.json runKeyId ${declaredKeyId}`,
        ["run.manifest.json"],
      )
    }
    if (material && declaredAlg && declaredAlg !== material.kind) {
      warn(
        "manifest:envelope",
        "KEY_ALG_MISMATCH",
        `the run is signed with ${declaredAlg} but the supplied key is ${material.kind}; signatures cannot be checked`,
        ["run.manifest.json"],
      )
      material = undefined
    }
    runNonce = declaredNonce
    runKeyId = declaredKeyId ?? options.keyId ?? options.hmacKeyId ?? null
    runAlg = declaredAlg ?? (hmacKey ? "hmac-sha256" : publicKey ? "ed25519" : null)
    if (!declaredNonce || !declaredKeyId) {
      unknownCheck(
        "manifest:pin",
        "AUTH_UNPINNED",
        "the signed manifest records no runNonce/runKeyId pair; artifacts cannot be pinned against a cross-run copy offline",
        ["run.manifest.json"],
      )
    }
    const check = checkEnvelope(
      "run.manifest.json",
      manifest,
      { alg: declaredAlg ?? null, keyId: declaredKeyId, nonce: declaredNonce },
      material,
    )
    manifestAuth = check.auth
    if (check.ok) {
      manifestEnvelopeOk = true
      pass("manifest:envelope", "signed manifest verifies against the supplied key", ["run.manifest.json"])
      relate("run.manifest.json", `key:${runKeyId}`, "keyId", runKeyId, check.auth.keyId)
      relate("run.manifest.json", "run", "runNonce", runNonce, check.auth.nonce ?? null)
    } else if (check.unknown) {
      unknownCheck("manifest:envelope", check.code, check.message, ["run.manifest.json"])
    } else {
      fail("manifest:envelope", check.code, check.message, ["run.manifest.json"])
    }
    if (manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3 && manifest.version !== 4 && manifest.version !== 5) {
      fail("manifest:schema", "AUTH_INVALID", `run.manifest.json version ${String(manifest.version)} is not supported`, [
        "run.manifest.json",
      ])
    }
    if (manifest.version >= 4 && manifest.requiredProvenance !== undefined) {
      if (!PROVENANCE_MODES.includes(manifest.requiredProvenance)) {
        fail(
          "manifest:requiredProvenance",
          "AUTH_INVALID",
          `run.manifest.json requiredProvenance ${String(manifest.requiredProvenance)} is not declared|command`,
          ["run.manifest.json"],
        )
      }
    }
    if (manifest.version >= 5 && manifest.attestationPolicy !== undefined) {
      if (normalizeAttestationPolicy(manifest.attestationPolicy) === undefined) {
        fail(
          "manifest:attestationPolicy",
          "AUTH_INVALID",
          `run.manifest.json attestationPolicy ${String(manifest.attestationPolicy)} is not off|optional|required`,
          ["run.manifest.json"],
        )
      }
    }
    if (typeof manifest.sessionId === "string" && manifest.sessionId !== runId) {
      fail(
        "manifest:sessionId",
        "AUTH_INVALID",
        `run.manifest.json sessionId ${manifest.sessionId} does not match the run directory ${runId}`,
        ["run.manifest.json"],
      )
    }
    if (declaredKeyId && material && !check.ok && !check.unknown) {
      // already failed above; keep the relation visible.
    }
  }

  const trust = {
    alg: runAlg,
    keyId: runKeyId,
    source: hmacKey ? "hmac-key" : publicKey ? "public-key" : "none",
    // H2: additive trust-level projection. `approval`/`witness` are computed
    // fail-closed below: an unverified claim is never rendered as satisfied.
    runTrustLevel: typeof manifest?.trustLevel === "string" ? manifest.trustLevel : null,
    approval: { status: manifest ? "UNKNOWN" : "NO_MANIFEST" },
    witness: { status: manifest ? "UNKNOWN" : "NO_MANIFEST" },
  }

  // --- plan, state, request, requirements, policy -------------------------
  const planRead = readRunJson(runRoot, "plan.dag.json", MAX.plan)
  const stateRead = readRunJson(runRoot, "state.json", MAX.state)
  const plan = planRead.status === "ok" ? planRead.value : undefined
  const state = stateRead.status === "ok" ? stateRead.value : undefined
  const requestRead = readRunFile(runRoot, "ORIGINAL_REQUEST.md", MAX.request)
  const requestText = requestRead.status === "ok" ? requestRead.text : undefined
  const integrityMode = parseIntegrityMode(requestText)
  const requirementsRaw = (() => {
    const r = readRunJson(runRoot, "requirements.json", MAX.requirements)
    return r.status === "ok" ? r.value : undefined
  })()
  const requirements = normalizeRequirements(requirementsRaw)
  const currentRequirementsHash = requirements ? sha256Hex(canonicalJson(requirements)) : null
  const currentRequestHash = requestText !== undefined ? sha256Hex(requestText) : null

  if (planRead.status === "error") {
    warn("plan:read", "PLAN_UNREADABLE", `plan.dag.json is unreadable (${planRead.error})`, ["plan.dag.json"])
  }
  if (stateRead.status === "error") {
    warn("state:read", "STATE_UNREADABLE", `state.json is unreadable (${stateRead.error})`, ["state.json"])
  }

  const taskIds = (() => {
    const ids = new Set()
    if (plan && Array.isArray(plan.tasks)) {
      for (const task of plan.tasks) if (isSafeTaskId(task?.id)) ids.add(task.id)
    }
    if (state && state.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks)) {
      for (const id of Object.keys(state.tasks)) if (isSafeTaskId(id)) ids.add(id)
    }
    return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  })()

  // C-1: task evidence is required. A run with no task ids has no reports to
  // recompute, so an empty plan/state must never be the base of a PASS verdict.
  if (taskIds.length === 0) {
    unknownCheck(
      "tasks:present",
      "TASKS_MISSING",
      "plan.dag.json and state.json record no tasks; there is no task evidence to verify",
      ["plan.dag.json", "state.json"],
    )
  } else {
    pass("tasks:present", `${taskIds.length} task(s) recorded in plan/state`, ["plan.dag.json", "state.json"])
  }

  if (manifest) {
    // Baseline hashes recorded by the signed plan.
    if (manifest.requestHash !== undefined && manifest.requestHash !== null) {
      if (currentRequestHash === null) {
        fail("manifest:requestHash", "AUTH_STALE", "ORIGINAL_REQUEST.md is missing but the manifest pins a requestHash", [
          "run.manifest.json",
          "ORIGINAL_REQUEST.md",
        ])
      } else if (manifest.requestHash !== currentRequestHash) {
        fail("manifest:requestHash", "AUTH_STALE", "ORIGINAL_REQUEST.md changed since the signed plan", [
          "run.manifest.json",
          "ORIGINAL_REQUEST.md",
        ])
      } else {
        pass("manifest:requestHash", "request baseline matches the signed manifest", [
          "run.manifest.json",
          "ORIGINAL_REQUEST.md",
        ])
        relate("run.manifest.json", "ORIGINAL_REQUEST.md", "requestHash", manifest.requestHash, currentRequestHash)
      }
    }
    if (manifest.requirementsHash !== undefined && manifest.requirementsHash !== null) {
      if (manifest.requirementsHash !== currentRequirementsHash) {
        fail(
          "manifest:requirementsHash",
          "AUTH_STALE",
          requirements ? "requirements.json changed since the signed plan" : "requirements.json is missing or malformed",
          ["run.manifest.json", "requirements.json"],
        )
      } else {
        pass("manifest:requirementsHash", "requirements baseline matches the signed manifest", [
          "run.manifest.json",
          "requirements.json",
        ])
        relate(
          "run.manifest.json",
          "requirements.json",
          "requirementsHash",
          manifest.requirementsHash,
          currentRequirementsHash,
        )
      }
    }
    if (typeof manifest.planHash === "string") {
      const current = plan ? planBaselineHash(plan) : null
      if (current === null) {
        fail("manifest:planHash", "AUTH_STALE", "plan.dag.json is missing or unreadable; the signed planHash cannot be recomputed", [
          "run.manifest.json",
          "plan.dag.json",
        ])
      } else if (manifest.planHash !== current) {
        fail("manifest:planHash", "AUTH_STALE", "plan.dag.json changed since the signed plan", [
          "run.manifest.json",
          "plan.dag.json",
        ])
      } else {
        pass("manifest:planHash", "semantic plan matches the signed planHash", ["run.manifest.json", "plan.dag.json"])
        relate("run.manifest.json", "plan.dag.json", "planHash", manifest.planHash, current)
      }
    }
    if (manifest.lemmaPolicyHash !== undefined && manifest.lemmaPolicyHash !== null) {
      const lemmaRead = readRunJson(runRoot, "lemma/manifest.json", MAX.artifact)
      const policy = lemmaRead.status === "ok" ? lemmaRead.value?.policy : undefined
      const current = policy === undefined || policy === null ? null : sha256Hex(canonicalJson(policy))
      if (manifest.lemmaPolicyHash !== current) {
        fail("manifest:lemmaPolicyHash", "AUTH_STALE", "the LEMMA policy changed since the signed plan", [
          "run.manifest.json",
          "lemma/manifest.json",
        ])
      } else {
        pass("manifest:lemmaPolicyHash", "LEMMA policy matches the signed manifest", [
          "run.manifest.json",
          "lemma/manifest.json",
        ])
        relate("run.manifest.json", "lemma/manifest.json", "lemmaPolicyHash", manifest.lemmaPolicyHash, current)
      }
    }
    const specRead = readRunFile(runRoot, "prompt_draft.md", MAX.spec)
    if (manifest.specHash !== undefined && manifest.specHash !== null) {
      if (specRead.status !== "ok") {
        fail("manifest:specHash", "AUTH_STALE", "prompt_draft.md is missing but the manifest pins its exact hash", [
          "run.manifest.json",
          "prompt_draft.md",
        ])
      } else {
        const current = contentSha256Hex(specRead.bytes)
        if (current !== manifest.specHash || (typeof manifest.specBytes === "number" && specRead.size !== manifest.specBytes)) {
          fail("manifest:specHash", "AUTH_STALE", "prompt_draft.md changed since the signed plan", [
            "run.manifest.json",
            "prompt_draft.md",
          ])
        } else {
          pass("manifest:specHash", "prompt draft bytes match the signed manifest", [
            "run.manifest.json",
            "prompt_draft.md",
          ])
          relate("run.manifest.json", "prompt_draft.md", "specHash", manifest.specHash, current)
        }
      }
    } else if (specRead.status === "ok" && manifest.version >= 3) {
      fail(
        "manifest:specHash",
        "AUTH_STALE",
        "prompt_draft.md exists but the version-3 manifest records no specHash; the draft appeared after the plan",
        ["run.manifest.json", "prompt_draft.md"],
      )
    }

    // Modes are part of the signed baseline; a plan/state downgrade is stale.
    const modePairs = [
      ["integrityMode", plan?.integrityMode ?? state?.integrityMode],
      ["verification", plan?.verification ?? state?.verification],
      ["victoryAudit", plan?.victoryAudit ?? state?.victoryAudit],
      ["requireHandoffs", plan?.requireHandoffs ?? state?.requireHandoffs],
    ]
    let modesOk = true
    for (const [field, current] of modePairs) {
      if (current === undefined || current === null) continue
      if (manifest[field] !== undefined && manifest[field] !== current) {
        modesOk = false
        fail(
          `manifest:${field}`,
          "AUTH_STALE",
          `${field} drifted from the signed baseline (manifest=${String(manifest[field])} current=${String(current)})`,
          ["run.manifest.json", "plan.dag.json", "state.json"],
        )
      }
    }
    if (modesOk) pass("manifest:modes", "plan/state modes match the signed baseline", ["run.manifest.json", "plan.dag.json", "state.json"])
    // 0.16.0: re-execution is a sticky requirement. A re-plan that drops
    // command provenance is a downgrade; a declared→command upgrade is allowed.
    const manifestProv = manifestProvenance(manifest)
    const currentProv =
      (plan?.requiredProvenance ?? state?.requiredProvenance) === "command" ? "command" : "declared"
    if (manifestProv === "command" && currentProv !== "command") {
      fail(
        "manifest:requiredProvenance",
        "AUTH_STALE",
        "requiredProvenance downgraded from command to declared in plan/state",
        ["run.manifest.json", "plan.dag.json", "state.json"],
      )
    } else {
      pass(
        "manifest:requiredProvenance",
        `re-execution requirement: ${manifestProv} (provenance: ${manifestProv})`,
        ["run.manifest.json", "plan.dag.json", "state.json"],
      )
    }
    relate("run.manifest.json", "plan.dag.json", "requiredProvenance", manifestProv, currentProv)
    // 0.18.0: the CI attestation requirement is sticky and its pinned identity
    // is part of the signed baseline. A plan/state downgrade is AUTH_STALE.
    const manifestAttPolicy = manifestAttestationPolicy(manifest)
    const currentAttPolicy =
      manifest.version >= 5
        ? normalizeAttestationPolicy(plan?.attestationPolicy ?? state?.attestationPolicy) ?? "off"
        : "off"
    if (attestationPolicyRank(currentAttPolicy) < attestationPolicyRank(manifestAttPolicy)) {
      fail(
        "manifest:attestationPolicy",
        "AUTH_STALE",
        `attestationPolicy downgraded from ${manifestAttPolicy} to ${currentAttPolicy} in plan/state`,
        ["run.manifest.json", "plan.dag.json", "state.json"],
      )
    } else {
      pass(
        "manifest:attestationPolicy",
        `CI attestation policy: ${manifestAttPolicy} (plan/state: ${currentAttPolicy})`,
        ["run.manifest.json", "plan.dag.json", "state.json"],
      )
    }
    relate("run.manifest.json", "plan.dag.json", "attestationPolicy", manifestAttPolicy, currentAttPolicy)
    if (manifest.version >= 5) {
      for (const field of ["attestationKeyId", "attestationIssuer"]) {
        const recorded = typeof manifest[field] === "string" && manifest[field] !== "" ? manifest[field] : null
        const current =
          (typeof plan?.[field] === "string" && plan[field] !== "" ? plan[field] : undefined) ??
          (typeof state?.[field] === "string" && state[field] !== "" ? state[field] : undefined) ??
          null
        if (recorded && recorded !== current) {
          fail(
            `manifest:${field}`,
            "AUTH_STALE",
            `${field} changed from the signed attestation identity`,
            ["run.manifest.json", "plan.dag.json", "state.json"],
          )
        } else {
          pass(`manifest:${field}`, `${field} matches the signed attestation identity`, [
            "run.manifest.json",
            "plan.dag.json",
            "state.json",
          ])
        }
      }
    }
  }

  // --- artifact registry --------------------------------------------------
  const reports = new Map()
  const waves = new Map()
  const artifactReads = new Map()
  let audit
  let victory
  let final
  let rerun
  let handoffIndex

  const registerJson = (relPath, maxBytes, kind, taskId, waveKind) => {
    const read = readRunJson(runRoot, relPath, maxBytes)
    artifactReads.set(relPath, read)
    if (read.status === "ok") {
      const entry = { path: relPath, value: read.value, text: read.text, bytes: read.bytes, kind, taskId, waveKind }
      if (kind === "report") reports.set(taskId, entry)
      else if (kind === "wave") waves.set(`${taskId}:${waveKind}`, entry)
      else if (kind === "audit") audit = entry
      else if (kind === "victory") victory = entry
      else if (kind === "final") final = entry
      else if (kind === "rerun") rerun = entry
      return entry
    }
    if (read.status === "error") {
      const label = { report: "report", wave: "wave verdict", audit: "security audit", victory: "victory", final: "final" }[kind]
      warn(`${kind}:read:${relPath}`, "ARTIFACT_UNREADABLE", `${label} ${relPath} is unreadable (${read.error})`, [relPath])
    }
    return undefined
  }

  for (const id of taskIds) {
    registerJson(`verify/report-${id}.json`, MAX.report, "report", id)
  }
  for (const id of taskIds) {
    for (const kind of Object.keys(WAVE_KINDS)) {
      registerJson(`verify/${kind}-${id}.json`, MAX.artifact, "wave", id, kind)
    }
  }
  registerJson("verify/security-audit.json", MAX.audit, "audit")
  registerJson("verify/victory.json", MAX.victory, "victory")
  registerJson("verify/final.json", MAX.final, "final")
  registerJson("verify/rerun.json", MAX.rerun, "rerun")

  const handoffRead = readRunJson(runRoot, "handoffs/index.json", MAX.handoffIndex)
  if (handoffRead.status === "ok") {
    if (handoffRead.value.version !== 1 || !Array.isArray(handoffRead.value.entries)) {
      fail("handoff:index", "HANDOFF_INVALID", "handoffs/index.json has an unsupported schema", ["handoffs/index.json"])
    } else {
      handoffIndex = handoffRead.value
    }
  } else if (handoffRead.status === "error") {
    fail("handoff:index", "HANDOFF_INVALID", `handoffs/index.json is unreadable (${handoffRead.error})`, [
      "handoffs/index.json",
    ])
  }

  const authLabel = (label) => `auth:${label}`
  const artifactAuth = new Map()

  const verifyArtifact = (entry, label) => {
    if (!entry) return
    const required = signedRun || manifestRead.status !== "absent"
    const check = checkEnvelope(
      entry.path,
      entry.value,
      { alg: runAlg, keyId: runKeyId, nonce: runNonce },
      material,
    )
    artifactAuth.set(entry.path, check)
    if (check.ok) {
      pass(authLabel(label), `${entry.path} envelope verifies`, [entry.path])
      relate(entry.path, `key:${runKeyId}`, "keyId", runKeyId, check.auth.keyId)
      relate(entry.path, "run", "runNonce", runNonce, check.auth.nonce ?? null)
    } else if (check.code === "AUTH_MISSING") {
      if (required && !allowedUnsigned) {
        fail(authLabel(label), "AUTH_MISSING", `${entry.path} has no _auth envelope on a signed run`, [entry.path])
      } else {
        warn(authLabel(label), "AUTH_MISSING", `${entry.path} is unsigned`, [entry.path])
      }
    } else if (check.unknown) {
      unknownCheck(authLabel(label), check.code, `${entry.path}: ${check.message}`, [entry.path])
    } else {
      fail(authLabel(label), check.code, `${entry.path}: ${check.message}`, [entry.path])
    }
  }

  for (const entry of reports.values()) verifyArtifact(entry, entry.path)
  for (const entry of waves.values()) verifyArtifact(entry, entry.path)
  verifyArtifact(audit, "verify/security-audit.json")
  verifyArtifact(victory, "verify/victory.json")
  verifyArtifact(final, "verify/final.json")
  verifyArtifact(rerun, "verify/rerun.json")

  // --- helper: digests on disk -------------------------------------------
  const keyedDigest = (relPath, maxBytes) => {
    const read = readRunFile(runRoot, relPath, maxBytes)
    return read.status === "ok" ? sha256Hex(read.text) : null
  }
  const finalDigestOnDisk = () => {
    const read = readRunJson(runRoot, "verify/final.json", MAX.final)
    if (read.status !== "ok" || read.value?.status !== "PASS") return null
    return sha256Hex(read.text)
  }
  const evidenceDigestsOnDisk = () => {
    const reportDigests = {}
    for (const id of taskIds) {
      const digest = keyedDigest(`verify/report-${id}.json`, MAX.report)
      if (digest !== null) reportDigests[id] = digest
    }
    return {
      reports: reportDigests,
      securityAudit: keyedDigest("verify/security-audit.json", MAX.audit),
      final: finalDigestOnDisk(),
    }
  }

  // --- report checks ------------------------------------------------------
  const reportStatus = (id) => {
    const entry = reports.get(id)
    return entry?.value?.status === "PASS" ? "PASS" : entry?.value?.status === "FAIL" ? "FAIL" : "MISSING"
  }

  const handoffMode = (() => {
    const raw = manifest?.requireHandoffs ?? plan?.requireHandoffs ?? state?.requireHandoffs
    return raw === "required" ? "required" : "skip"
  })()
  const verificationMode = (() => {
    const raw = manifest?.verification ?? plan?.verification ?? state?.verification
    return raw === "strict" ? "strict" : "standard"
  })()
  const victoryMode = (() => {
    const raw = manifest?.victoryAudit ?? plan?.victoryAudit ?? state?.victoryAudit
    if (raw === "required" || raw === "skip") return raw
    return requestText !== undefined || requirements ? "required" : "skip"
  })()
  const requireReportBinding = plan?.requireReportBinding === true || state?.requireReportBinding === true

  const indexEntriesFor = (taskId, agent) =>
    (handoffIndex?.entries ?? []).filter((e) => e?.taskId === taskId && e?.agent === agent)

  for (const id of taskIds) {
    const entry = reports.get(id)
    const reportPath = `verify/report-${id}.json`
    const reportRead = artifactReads.get(reportPath)
    // C-1: a missing or unreadable report is a named failure, not a silent skip.
    if (!entry) {
      if (reportRead?.status === "error") {
        fail(`report:${id}:present`, "REPORT_UNREADABLE", `${reportPath} is unreadable (${reportRead.error})`, [reportPath])
      } else if (signedRun) {
        fail(`report:${id}:present`, "REPORT_MISSING", `${reportPath} is missing; task ${id} has no verifier report`, [
          reportPath,
        ])
      } else {
        unknownCheck(
          `report:${id}:present`,
          "REPORT_MISSING",
          `${reportPath} is missing; this unsigned legacy run has no verifier report for ${id} and cannot be reported PASS`,
          [reportPath],
        )
      }
      continue
    }
    pass(`report:${id}:present`, `${reportPath} is present`, [entry.path])
    const report = entry.value
    if (report.status === "PASS") {
      pass(`report:${id}:status`, `report ${entry.path} records PASS`, [entry.path])
    } else if (report.status === "FAIL") {
      fail(`report:${id}:status`, "REPORT_FAILED", `report ${entry.path} records FAIL; task ${id} is not verified`, [
        entry.path,
      ])
    }
    if (report.taskId !== id) {
      fail(`report:${id}:schema`, "REPORT_INVALID", `report taskId ${String(report.taskId)} does not match ${id}`, [
        entry.path,
      ])
    }
    if (report.status !== "PASS" && report.status !== "FAIL") {
      fail(`report:${id}:schema`, "REPORT_INVALID", `report status ${String(report.status)} is not PASS|FAIL`, [
        entry.path,
      ])
    }
    if (report.status === "PASS") {
      const problems = []
      const reportChecks = Array.isArray(report.checks) ? report.checks : []
      if (report.checks !== undefined && !Array.isArray(report.checks)) problems.push("checks is not an array")
      const provenance = manifestProvenance(manifest)
      let commandChecks = 0
      reportChecks.forEach((check, index) => {
        const result = verifierCheckProblems(check, index, provenance)
        problems.push(...result.problems)
        if (result.command && check?.type === "programmatic" && check?.outputTruncated === false) commandChecks += 1
      })
      if (provenance === "command" && commandChecks === 0) {
        problems.push(
          'CHECK_COMMAND_MISSING: requiredProvenance "command" needs at least one programmatic check with a re-executable command',
        )
      }
      if (Array.isArray(report.fatalFindings) && report.fatalFindings.length > 0) {
        problems.push("fatalFindings is non-empty")
      }
      const summary = typeof report.summary === "string" ? report.summary.trim() : ""
      if (summary === "" && reportChecks.length === 0) problems.push("no summary and no checks")
      if (problems.length > 0) {
        const exitConflict = problems.some((p) => p.startsWith("CHECK_EXIT_CONFLICT"))
        const commandMissing = problems.some((p) => p.startsWith("CHECK_COMMAND_MISSING"))
        fail(
          `report:${id}:schema`,
          exitConflict ? "CHECK_EXIT_CONFLICT" : commandMissing ? "CHECK_COMMAND_MISSING" : "REPORT_INVALID",
          `PASS report ${entry.path} is not valid: ${problems.join("; ")}`,
          [entry.path],
        )
      } else {
        pass(`report:${id}:schema`, `PASS report ${entry.path} is structurally valid`, [entry.path])
      }

      if (provenance === "command") {
        const bound = typeof report.headSha === "string" && report.headSha.trim() !== ""
        if (!bound) {
          fail(
            `report:${id}:provenance-binding`,
            "REPORT_UNBOUND",
            `requiredProvenance is "command" but ${entry.path} records no headSha; the command cannot be re-executed against a commit`,
            [entry.path],
          )
        } else {
          pass(
            `report:${id}:provenance-binding`,
            `report ${entry.path} binds its commands to head ${report.headSha}`,
            [entry.path],
          )
        }
      }

      if (requireReportBinding) {
        const bound =
          typeof report.headSha === "string" &&
          report.headSha !== "" &&
          typeof report.diffHash === "string" &&
          report.diffHash !== ""
        if (!bound) {
          fail(
            `report:${id}:binding`,
            "REPORT_UNBOUND",
            `requireReportBinding is asserted but ${entry.path} carries no headSha/diffHash`,
            [entry.path],
          )
        } else {
          pass(`report:${id}:binding`, `report ${entry.path} is bound to a branch head and diff`, [entry.path])
          relate(entry.path, "branch", "headSha", report.headSha, report.headSha)
        }
      }

      const binding = report.workerHandoff
      if (binding && typeof binding === "object" && typeof binding.agent === "string") {
        const entries = indexEntriesFor(id, binding.agent)
        if (entries.length !== 1) {
          fail(
            `report:${id}:handoff`,
            "REPORT_HANDOFF_STALE",
            `report ${entry.path} binds ${String(binding.path)}, but handoffs/index.json has ${entries.length} entries for ${binding.agent} ${id}`,
            [entry.path, "handoffs/index.json"],
          )
        } else {
          const indexed = entries[0]
          const body = readRunFile(runRoot, indexed.path, MAX.handoff)
          const actual = body.status === "ok" ? sha256Hex(body.text) : null
          if (
            indexed.path !== binding.path ||
            indexed.sha256 !== binding.sha256 ||
            actual !== binding.sha256
          ) {
            fail(
              `report:${id}:handoff`,
              "REPORT_HANDOFF_STALE",
              `report ${entry.path} binds ${String(binding.path)} ${String(binding.sha256)}, but the worker handoff is now ${indexed.path} ${String(actual)}; re-record the report after the handoff`,
              [entry.path, indexed.path, "handoffs/index.json"],
            )
          } else {
            pass(`report:${id}:handoff`, `report binds the current worker handoff ${indexed.path}`, [
              entry.path,
              indexed.path,
            ])
            relate(entry.path, indexed.path, "workerHandoff", binding.sha256, actual)
          }
        }
      } else if (handoffMode === "required") {
        fail(
          `report:${id}:handoff`,
          "REPORT_HANDOFF_MISSING",
          `requireHandoffs is required but PASS report ${entry.path} has no workerHandoff binding`,
          [entry.path],
        )
      }
    }
  }

  // --- re-execution claims and verify/rerun.json --------------------------
  // The signed manifest decides whether a claim must be re-executable. A
  // pre-0.16 manifest (version < 4) is always `declared`, so a 0.15 report
  // keeps its meaning. Under `command` a PASS that was not re-executed is a
  // claim, never a PASS: `--rerun` is required for a real verdict.
  const provenance = manifestProvenance(manifest)
  const rerunRepo = options.rerun === true ? (options.repo ? resolve(String(options.repo)) : undefined) : undefined
  if (options.rerun === true && !rerunRepo) {
    throw new VerifyUsageError("--rerun needs --repo <clean-checkout>")
  }
  const expectedRerun = new Map()
  for (const id of taskIds) {
    const entry = reports.get(id)
    if (!entry || entry.value?.status !== "PASS") continue
    const list = (Array.isArray(entry.value.checks) ? entry.value.checks : [])
      .filter((check) => check && typeof check === "object" && Array.isArray(check.command) && check.command.length > 0 && check.outputTruncated === false)
      .map((check) => ({
        name: typeof check.name === "string" ? check.name : "",
        argv: check.command,
        cwd: normaliseCheckCwd(check.cwd).cwd ?? ".",
        expectedExit: Number(check.exitCode),
        // M-1: the rerun record binds the *unkeyed* digest of the captured
        // output (matching the engine's stdout+stderr digest). Two different
        // same-length outputs must not compare equal via argv/exit/bytes alone.
        outputSha256: contentSha256Hex(typeof check.output === "string" ? check.output : ""),
        outputBytes: Number(check.outputBytes),
      }))
    if (list.length > 0) expectedRerun.set(id, list)
  }

  let rerunRecorded = false
  let rerunLinksOk = false
  let rerunInfo
  if (rerun) {
    const value = rerun.value
    const problems = []
    if (value.version !== 1) problems.push("version must be 1")
    if (value.sessionId !== runId) problems.push(`sessionId does not match ${runId}`)
    if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
      problems.push("generatedAt is missing or invalid")
    }
    const recordedTasks = value.tasks
    if (!recordedTasks || typeof recordedTasks !== "object" || Array.isArray(recordedTasks)) {
      problems.push("tasks is not an object")
    } else {
      for (const [taskId, task] of Object.entries(recordedTasks)) {
        if (!isSafeTaskId(taskId)) {
          problems.push(`tasks names an invalid task id ${taskId}`)
          continue
        }
        if (!task || typeof task !== "object" || !Array.isArray(task.checks)) {
          problems.push(`tasks.${taskId}.checks is not an array`)
          continue
        }
        if (task.checks.length > 100) problems.push(`tasks.${taskId}.checks exceeds 100 entries`)
        task.checks.forEach((check, index) => {
          const label = `tasks.${taskId}.checks[${index}]`
          if (!check || typeof check !== "object") {
            problems.push(`${label} is not an object`)
            return
          }
          if (typeof check.name !== "string" || check.name === "") problems.push(`${label}.name is missing`)
          const argvProblem = commandArgvProblem(check.argv)
          if (argvProblem) problems.push(`${label} ${argvProblem}`)
          const cwdCheck = normaliseCheckCwd(check.cwd)
          if (cwdCheck.error) problems.push(`${label} ${cwdCheck.error}`)
          if (!Number.isInteger(Number(check.expectedExit))) problems.push(`${label}.expectedExit is not an integer`)
          if (!SHA256_HEX.test(String(check.outputSha256 ?? ""))) problems.push(`${label}.outputSha256 is invalid`)
          if (!Number.isInteger(Number(check.outputBytes)) || Number(check.outputBytes) < 0) {
            problems.push(`${label}.outputBytes is not a non-negative integer`)
          }
          if (
            !Number.isInteger(Number(check.timeoutMs)) ||
            Number(check.timeoutMs) < 1 ||
            Number(check.timeoutMs) > RERUN_MAX_TIMEOUT_MS
          ) {
            problems.push(`${label}.timeoutMs is outside 1..${RERUN_MAX_TIMEOUT_MS}`)
          }
        })
      }
    }
    if (problems.length > 0) {
      fail("rerun:schema", "RERUN_INVALID", `verify/rerun.json is not valid: ${problems.join("; ")}`, [
        "verify/rerun.json",
      ])
    } else {
      rerunRecorded = true
      pass("rerun:schema", "verify/rerun.json is structurally valid", ["verify/rerun.json"])
    }
  }

  const rerunChecksMatch = (taskId, recorded) =>
    canonicalJson(
      recorded
        .map((check) => ({
          name: check.name,
          argv: check.argv,
          cwd: normaliseCheckCwd(check.cwd).cwd ?? ".",
          expectedExit: Number(check.expectedExit),
          outputSha256: check.outputSha256,
          outputBytes: Number(check.outputBytes),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    )

  if (rerunRecorded) {
    let linksOk = true
    const recordedTasks = rerun.value.tasks
    for (const [taskId, expected] of expectedRerun) {
      const recorded = recordedTasks[taskId]?.checks
      if (!Array.isArray(recorded)) {
        linksOk = false
        fail(
          `rerun:${taskId}:link`,
          "AUTH_STALE",
          `verify/rerun.json has no recorded command for PASS report ${taskId}, which records ${expected.length} command check(s)`,
          ["verify/rerun.json", `verify/report-${taskId}.json`],
        )
        continue
      }
      if (rerunChecksMatch(taskId, recorded) !== rerunChecksMatch(taskId, expected)) {
        linksOk = false
        fail(
          `rerun:${taskId}:link`,
          "AUTH_STALE",
          `verify/rerun.json does not match the command checks recorded in verify/report-${taskId}.json`,
          ["verify/rerun.json", `verify/report-${taskId}.json`],
        )
      } else {
        pass(
          `rerun:${taskId}:link`,
          `verify/rerun.json matches the ${expected.length} command check(s) in ${taskId}'s report`,
          ["verify/rerun.json", `verify/report-${taskId}.json`],
        )
        relate("verify/rerun.json", `verify/report-${taskId}.json`, "commandChecks", String(expected.length), String(recorded.length))
      }
    }
    for (const taskId of Object.keys(recordedTasks)) {
      if (!expectedRerun.has(taskId)) {
        linksOk = false
        fail(
          `rerun:${taskId}:link`,
          "AUTH_STALE",
          `verify/rerun.json records commands for ${taskId}, but no PASS report records them`,
          ["verify/rerun.json"],
        )
      }
    }
    if (linksOk) pass("rerun:link", "verify/rerun.json is bound to the current reports", ["verify/rerun.json"])
    rerunLinksOk = linksOk
  }

  const rerunPlanned = []
  if (rerunRecorded) {
    for (const [taskId, task] of Object.entries(rerun.value.tasks)) {
      const report = reports.get(taskId)?.value
      rerunPlanned.push({
        taskId,
        headSha: typeof report?.headSha === "string" && report.headSha !== "" ? report.headSha : undefined,
        checks: (Array.isArray(task.checks) ? task.checks : []).map((check, index) => ({
          index,
          name: typeof check.name === "string" ? check.name : `#${index + 1}`,
          argv: check.argv,
          cwd: normaliseCheckCwd(check.cwd).cwd ?? ".",
          expectedExit: Number(check.expectedExit),
          outputSha256: check.outputSha256,
          outputBytes: Number(check.outputBytes),
          timeoutMs: Number(check.timeoutMs),
        })),
      })
    }
  }

  const rerunTrustProblems = []
  if (rerunRecorded) {
    if (manifestRead.status !== "ok" || !manifestAuth || !manifestEnvelopeOk) {
      rerunTrustProblems.push("run.manifest.json is absent or its envelope does not authenticate")
    }
    const rerunAuth = artifactAuth.get("verify/rerun.json")
    if (!rerunAuth?.ok) {
      rerunTrustProblems.push(
        `verify/rerun.json does not authenticate (${rerunAuth?.code ?? "no envelope result"})`,
      )
    }
    for (const taskId of Object.keys(rerun.value.tasks)) {
      const entry = reports.get(taskId)
      if (!entry) {
        rerunTrustProblems.push(`report for ${taskId} is missing`)
        continue
      }
      const reportAuth = artifactAuth.get(entry.path)
      if (!reportAuth?.ok) {
        rerunTrustProblems.push(`${entry.path} does not authenticate (${reportAuth?.code ?? "no envelope result"})`)
      }
    }
    if (!rerunLinksOk) rerunTrustProblems.push("verify/rerun.json does not match the reports it names")
  }

  if (provenance === "command" && expectedRerun.size > 0 && !rerunRecorded) {
    fail(
      "rerun:present",
      "AUTH_STALE",
      "requiredProvenance is \"command\" and the reports record commands, but verify/rerun.json is missing",
      ["run.manifest.json", "verify/rerun.json"],
    )
  }

  if (options.rerun === true) {
    if (!rerunRecorded) {
      skip("rerun:absent", "no verify/rerun.json; there is nothing to re-execute", ["verify/rerun.json"])
      if (provenance === "command") {
        unknownCheck(
          "provenance:required",
          "PROVENANCE_CLAIMED",
          'provenance: claimed — requiredProvenance is "command" but no re-executable record exists; the claim cannot be promoted to PASS',
          ["run.manifest.json"],
        )
      }
    } else if (rerunTrustProblems.length > 0) {
      unknownCheck(
        "rerun:trust",
        "RERUN_UNTRUSTED",
        `refusing to create a worktree or execute recorded commands: ${rerunTrustProblems.join("; ")}`,
        ["run.manifest.json", "verify/rerun.json"],
      )
    } else if (!gitAvailable(rerunRepo)) {
      unknownCheck(
        "rerun:repo",
        "command-unavailable",
        `cannot use git in ${rerunRepo}; recorded commands cannot be re-executed`,
        ["verify/rerun.json"],
      )
    } else {
      pass(
        "rerun:trust",
        "the signed manifest, verify/rerun.json, its reports and the rerun link authenticate",
        ["run.manifest.json", "verify/rerun.json"],
      )
      const executed = executeRerunCommands({
        repo: rerunRepo,
        planned: rerunPlanned,
        timeoutSeconds: options.timeout !== undefined ? Number(options.timeout) : undefined,
        keepWorktree: options.keepWorktree === true,
      })
      for (const result of executed.results) {
        if (result.status === "pass") pass(result.id, result.detail, result.artifacts)
        else if (result.status === "unknown") unknownCheck(result.id, result.code, result.detail, result.artifacts)
        else fail(result.id, result.code, result.detail, result.artifacts)
      }
      const failed = executed.results.filter((result) => result.status !== "pass").length
      rerunInfo = {
        repo: rerunRepo,
        worktrees: executed.worktrees,
        checks: executed.results.map((result) => ({
          id: result.id,
          status: result.status,
          ...(result.code ? { code: result.code } : {}),
        })),
      }
      if (executed.results.length > 0 && failed === 0) {
        const commandCount = executed.results.length
        if (provenance === "command") {
          pass(
            "provenance:required",
            `provenance: command — re-executed ${commandCount} recorded command check(s) in a disposable worktree; exit code and output digest matched`,
            ["verify/rerun.json", "run.manifest.json"],
          )
        } else {
          skip(
            "provenance:declared",
            `provenance: declared — re-executed ${commandCount} recorded command check(s) on request; the verdict does not depend on it`,
            ["verify/rerun.json"],
          )
        }
      }
      if (options.keepWorktree === true && executed.worktrees.length > 0) {
        skip(
          "rerun:worktrees",
          `--keep-worktree: left ${executed.worktrees.length} disposable worktree(s) under ${executed.scratchRoot}`,
          [],
        )
      }
    }
  } else if (provenance === "command") {
    unknownCheck(
      "provenance:required",
      "PROVENANCE_CLAIMED",
      'provenance: claimed — requiredProvenance is "command"; recorded commands are advisory until re-executed with verify --rerun --repo <clean-checkout>',
      ["run.manifest.json", "verify/rerun.json"],
    )
  } else {
    skip(
      "provenance:declared",
      "provenance: declared — checks are authenticated, not re-executed; pass verify --rerun --repo <clean-checkout> to re-run recorded commands",
      ["run.manifest.json"],
    )
  }

  // --- security audit -----------------------------------------------------
  // C-1: the audit is required, not conditionally checked behind a PASS final.
  const auditRead = artifactReads.get("verify/security-audit.json")
  if (!audit) {
    if (auditRead?.status === "error") {
      fail(
        "audit:present",
        "AUDIT_UNREADABLE",
        `verify/security-audit.json is unreadable (${auditRead.error})`,
        ["verify/security-audit.json"],
      )
    } else if (signedRun) {
      fail(
        "audit:present",
        "AUDIT_MISSING",
        "verify/security-audit.json is missing; a signed run requires a PASS security audit",
        ["verify/security-audit.json"],
      )
    } else {
      unknownCheck(
        "audit:present",
        "AUDIT_MISSING",
        "verify/security-audit.json is missing; this unsigned legacy run has no security audit and cannot be reported PASS",
        ["verify/security-audit.json"],
      )
    }
  } else {
    pass("audit:present", "verify/security-audit.json is present", [audit.path])
    const value = audit.value
    if (value.status === "PASS") {
      pass("audit:status", "security audit reports PASS", [audit.path])
    } else if (value.status === "FAIL") {
      fail("audit:status", "AUDIT_FAILED", "security audit reports FAIL; the run is not verified", [audit.path])
    } else {
      fail("audit:status", "AUDIT_INVALID", `security audit status ${String(value.status)} is not PASS|FAIL`, [
        audit.path,
      ])
    }
    const violations = Array.isArray(value.integrityViolations) ? value.integrityViolations : []
    if (value.status === "PASS" && violations.length > 0) {
      fail("audit:integrity", "AUDIT_VIOLATION", "a PASS security audit records integrityViolations", [audit.path])
    }
    if (value.status === "PASS") {
      const checksList = Array.isArray(value.ruleChecks) ? value.ruleChecks : []
      if (!Array.isArray(value.ruleChecks)) {
        fail(
          "audit:ruleChecks",
          "AUDIT_RULE_MISSING",
          `ruleChecks is missing; a PASS must cover ${forbiddenRules(integrityMode).join(", ")} at mode ${integrityMode}`,
          [audit.path],
        )
      } else {
        const seen = new Map()
        let coverageOk = true
        for (const check of checksList) {
          const rule = check && typeof check === "object" ? check.rule : undefined
          if (typeof rule !== "string" || !Object.prototype.hasOwnProperty.call(INTEGRITY_RULES, rule)) {
            coverageOk = false
            fail("audit:ruleChecks", "AUDIT_RULE_UNKNOWN", `ruleChecks names an unknown rule ${String(rule)}`, [
              audit.path,
            ])
            continue
          }
          seen.set(rule, (seen.get(rule) ?? 0) + 1)
          if (check.result !== "clean" && check.result !== "violation") {
            coverageOk = false
            fail(
              "audit:ruleChecks",
              "AUDIT_RULE_INVALID",
              `ruleChecks[${rule}].result must be clean | violation`,
              [audit.path],
            )
          }
          if (check.result === "violation") {
            coverageOk = false
            fail(
              "audit:ruleChecks",
              "AUDIT_VIOLATION",
              `ruleChecks records a violation for ${rule} while the audit reports PASS`,
              [audit.path],
            )
          }
        }
        for (const rule of forbiddenRules(integrityMode)) {
          const count = seen.get(rule) ?? 0
          relate(audit.path, `rule:${rule}`, "ruleCoverage", "exactly once", count === 0 ? "missing" : String(count))
          if (count === 0) {
            coverageOk = false
            fail(
              "audit:ruleChecks",
              "AUDIT_RULE_MISSING",
              `ruleChecks is missing the forbidden rule ${rule} at mode ${integrityMode}`,
              [audit.path, "ORIGINAL_REQUEST.md"],
            )
          } else if (count > 1) {
            coverageOk = false
            fail(
              "audit:ruleChecks",
              "AUDIT_RULE_DUPLICATE",
              `ruleChecks records ${rule} ${count} times (expected exactly once)`,
              [audit.path],
            )
          }
        }
        if (coverageOk) {
          pass("audit:ruleChecks", `audit covers every rule forbidden at mode ${integrityMode}`, [
            audit.path,
            "ORIGINAL_REQUEST.md",
          ])
        }
      }

      const reviewed = value.reviewedDigests
      if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) {
        fail(
          "audit:reviewedDigests",
          "AUTH_STALE",
          "security audit has no reviewedDigests; it is not bound to the reports it reviewed",
          [audit.path],
        )
      } else {
        const current = evidenceDigestsOnDisk()
        const recordedReports =
          reviewed.reports && typeof reviewed.reports === "object" && !Array.isArray(reviewed.reports)
            ? reviewed.reports
            : null
        let reviewedOk = true
        if (!recordedReports) {
          reviewedOk = false
          fail("audit:reviewedDigests", "AUTH_STALE", "security audit reviewedDigests.reports is missing or malformed", [
            audit.path,
          ])
        } else {
          for (const [id, digest] of Object.entries(recordedReports)) {
            if (!isSafeTaskId(id)) {
              reviewedOk = false
              fail("audit:reviewedDigests", "AUTH_STALE", `reviewedDigests names an invalid task id ${id}`, [audit.path])
              continue
            }
            if (current.reports[id] !== digest) {
              reviewedOk = false
              fail(
                "audit:reviewedDigests",
                "AUTH_STALE",
                `report ${id} changed since the security audit reviewed it`,
                [audit.path, `verify/report-${id}.json`],
              )
            }
            relate(audit.path, `verify/report-${id}.json`, "reviewedDigest", digest, current.reports[id] ?? null)
          }
          for (const id of Object.keys(current.reports)) {
            if (!Object.prototype.hasOwnProperty.call(recordedReports, id)) {
              reviewedOk = false
              fail(
                "audit:reviewedDigests",
                "AUTH_STALE",
                `report ${id} was never reviewed by this security audit`,
                [audit.path, `verify/report-${id}.json`],
              )
            }
          }
        }
        const recordedFinal = reviewed.final ?? null
        if (recordedFinal !== null && recordedFinal !== current.final) {
          const currentFinalAt =
            final && typeof final.value.generatedAt === "string" ? Date.parse(final.value.generatedAt) : NaN
          const auditAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN
          const writtenAfterAudit =
            Number.isFinite(currentFinalAt) && Number.isFinite(auditAt) && currentFinalAt > auditAt
          if (!writtenAfterAudit) {
            reviewedOk = false
            fail("audit:reviewedDigests", "AUTH_STALE", "verify/final.json changed since the audit reviewed it", [
              audit.path,
              "verify/final.json",
            ])
          }
        }
        if (reviewedOk) {
          pass("audit:reviewedDigests", "audit is bound to the reports and final it reviewed", [audit.path])
        }
      }
    }
  }

  // --- victory ------------------------------------------------------------
  // C-1: when the run requires victory, absence or rejection is a named
  // failure whether or not a PASS final was written.
  if (victoryMode === "required") {
    if (!victory) {
      if (signedRun) {
        fail("victory:required", "VICTORY_MISSING", "verify/victory.json is missing; this run requires VICTORY CONFIRMED", [
          "verify/victory.json",
        ])
      } else {
        unknownCheck(
          "victory:required",
          "VICTORY_MISSING",
          "verify/victory.json is missing; this unsigned legacy run requires VICTORY CONFIRMED and cannot be reported PASS",
          ["verify/victory.json"],
        )
      }
    } else if (victory.value.verdict === "VICTORY CONFIRMED") {
      pass("victory:required", "victory audit is VICTORY CONFIRMED", [victory.path])
    } else if (victory.value.verdict === "VICTORY REJECTED") {
      fail("victory:required", "VICTORY_REJECTED", "victory audit is VICTORY REJECTED; the run is not verified", [
        victory.path,
      ])
    } else {
      fail(
        "victory:required",
        "VICTORY_INVALID",
        `victory verdict ${String(victory.value.verdict)} is not VICTORY CONFIRMED`,
        [victory.path],
      )
    }
  } else {
    skip(
      "victory:required",
      `victory audit is not required (${victoryMode})`,
      victory ? [victory.path] : [],
    )
  }

  if (victory) {
    const value = victory.value
    if (value.verdict !== "VICTORY CONFIRMED" && value.verdict !== "VICTORY REJECTED") {
      fail("victory:schema", "VICTORY_INVALID", `victory verdict ${String(value.verdict)} is not recognised`, [
        victory.path,
      ])
    }
    if (value.auditor !== "team/victory-auditor") {
      fail("victory:schema", "VICTORY_INVALID", `victory auditor must be team/victory-auditor (got ${String(value.auditor)})`, [
        victory.path,
      ])
    }
    if (typeof value.auditorSessionId !== "string" || value.auditorSessionId.trim() === "") {
      fail("victory:schema", "VICTORY_INVALID", "victory auditorSessionId is missing", [victory.path])
    }

    const recorded = value.evidenceDigests
    if (recorded === undefined || recorded === null) {
      fail(
        "victory:evidenceDigests",
        "AUTH_STALE",
        "legacy victory verdict has no evidenceDigests; it is not bound to the reports it claims to have reviewed",
        [victory.path],
      )
    } else if (typeof recorded !== "object" || Array.isArray(recorded)) {
      fail("victory:evidenceDigests", "AUTH_STALE", "victory evidenceDigests is malformed", [victory.path])
    } else {
      const current = evidenceDigestsOnDisk()
      const recordedReports =
        recorded.reports && typeof recorded.reports === "object" && !Array.isArray(recorded.reports)
          ? recorded.reports
          : null
      let evidenceOk = true
      if (!recordedReports) {
        evidenceOk = false
        fail("victory:evidenceDigests", "AUTH_STALE", "victory evidenceDigests.reports is missing or malformed", [
          victory.path,
        ])
      } else {
        for (const [id, digest] of Object.entries(recordedReports)) {
          if (!isSafeTaskId(id)) {
            evidenceOk = false
            fail("victory:evidenceDigests", "AUTH_STALE", `evidenceDigests names an invalid task id ${id}`, [
              victory.path,
            ])
            continue
          }
          if (current.reports[id] !== digest) {
            evidenceOk = false
            fail(
              "victory:evidenceDigests",
              "AUTH_STALE",
              `report ${id} changed since the victory audit reviewed it`,
              [victory.path, `verify/report-${id}.json`],
            )
          }
          relate(victory.path, `verify/report-${id}.json`, "evidenceDigest", digest, current.reports[id] ?? null)
        }
        for (const id of Object.keys(current.reports)) {
          if (!Object.prototype.hasOwnProperty.call(recordedReports, id)) {
            evidenceOk = false
            fail(
              "victory:evidenceDigests",
              "AUTH_STALE",
              `report ${id} appeared after the victory audit and was never reviewed`,
              [victory.path, `verify/report-${id}.json`],
            )
          }
        }
      }
      const recordedAudit = recorded.securityAudit ?? null
      if (recordedAudit !== current.securityAudit) {
        evidenceOk = false
        fail(
          "victory:evidenceDigests",
          "AUTH_STALE",
          recordedAudit === null
            ? "security-audit.json appeared after the victory audit reviewed the run"
            : "security-audit.json changed since the victory audit reviewed it",
          [victory.path, "verify/security-audit.json"],
        )
      }
      relate(victory.path, "verify/security-audit.json", "evidenceDigest", recordedAudit, current.securityAudit)
      const recordedFinal = recorded.final ?? null
      if (recordedFinal !== null && recordedFinal !== current.final) {
        const currentFinalAt =
          final && typeof final.value.generatedAt === "string" ? Date.parse(final.value.generatedAt) : NaN
        const victoryAt = typeof value.generatedAt === "string" ? Date.parse(value.generatedAt) : NaN
        const writtenAfterAudit =
          Number.isFinite(currentFinalAt) && Number.isFinite(victoryAt) && currentFinalAt > victoryAt
        if (!writtenAfterAudit) {
          evidenceOk = false
          fail("victory:evidenceDigests", "AUTH_STALE", "verify/final.json changed since the victory audit reviewed it", [
            victory.path,
            "verify/final.json",
          ])
        }
      }
      if (evidenceOk) {
        pass("victory:evidenceDigests", "victory is bound to the current reports and audit", [victory.path])
      }
    }

    if (value.verdict === "VICTORY CONFIRMED" && typeof recorded?.reports === "object") {
      if (Object.keys(recorded.reports).length === 0) {
        fail(
          "victory:evidenceDigests",
          "AUTH_STALE",
          "VICTORY CONFIRMED records an empty reports map; it reviewed no verifier report",
          [victory.path],
        )
      }
    }

    if (typeof value.requirementsHash === "string") {
      if (value.requirementsHash !== currentRequirementsHash) {
        fail("victory:requirementsHash", "AUTH_STALE", "victory requirementsHash does not match the current requirements.json", [
          victory.path,
          "requirements.json",
        ])
      } else {
        pass("victory:requirementsHash", "victory requirementsHash matches the current baseline", [
          victory.path,
          "requirements.json",
        ])
        relate(victory.path, "requirements.json", "requirementsHash", value.requirementsHash, currentRequirementsHash)
      }
    } else if (victoryMode === "required") {
      fail("victory:requirementsHash", "AUTH_STALE", "victory verdict has no requirementsHash", [victory.path])
    }
    if (typeof value.requestHash === "string") {
      if (value.requestHash !== currentRequestHash) {
        fail("victory:requestHash", "AUTH_STALE", "victory requestHash does not match the current ORIGINAL_REQUEST.md", [
          victory.path,
          "ORIGINAL_REQUEST.md",
        ])
      } else {
        pass("victory:requestHash", "victory requestHash matches the current request", [victory.path])
        relate(victory.path, "ORIGINAL_REQUEST.md", "requestHash", value.requestHash, currentRequestHash)
      }
    } else if (value.verdict === "VICTORY CONFIRMED") {
      fail("victory:requestHash", "AUTH_STALE", "VICTORY CONFIRMED has no requestHash", [victory.path])
    }

    if (Array.isArray(value.requirements)) {
      const baselineIds = new Set((requirements?.items ?? []).map((item) => item.id))
      const seen = new Set()
      let requirementsOk = true
      for (const entry of value.requirements) {
        const id = entry?.id
        if (typeof id !== "string" || !baselineIds.has(id) || seen.has(id)) {
          requirementsOk = false
          fail("victory:requirements", "VICTORY_INVALID", `victory requirement ${String(id)} is unknown or duplicated`, [
            victory.path,
          ])
          continue
        }
        seen.add(id)
        if (typeof entry.met !== "boolean") {
          requirementsOk = false
          fail("victory:requirements", "VICTORY_INVALID", `victory requirement ${id} has no boolean met`, [victory.path])
        } else if (entry.met === true && (typeof entry.evidence !== "string" || entry.evidence.trim() === "")) {
          requirementsOk = false
          fail("victory:requirements", "VICTORY_INVALID", `victory requirement ${id} is met but has no evidence`, [
            victory.path,
          ])
        }
      }
      for (const id of baselineIds) {
        if (!seen.has(id)) {
          requirementsOk = false
          fail("victory:requirements", "VICTORY_INVALID", `victory audit is missing requirement ${id}`, [victory.path])
        }
      }
      if (requirementsOk) pass("victory:requirements", "victory covers every baseline requirement", [victory.path])
    } else {
      fail("victory:requirements", "VICTORY_INVALID", "victory requirements list is missing", [victory.path])
    }
  }

  // --- strict waves -------------------------------------------------------
  for (const id of taskIds) {
    for (const kind of Object.keys(WAVE_KINDS)) {
      const expected = WAVE_KINDS[kind]
      const entry = waves.get(`${id}:${kind}`)
      const label = `verify/${kind}-${id}.json`
      if (!entry) {
        if (verificationMode === "strict") {
          fail(`strict:${kind}:${id}`, "STRICT_MISSING", `strict run is missing ${label}`, [label])
        }
        continue
      }
      const value = entry.value
      // The strict wave binds report bytes with an unkeyed sha256.
      const reportRaw = readRunFile(runRoot, `verify/report-${id}.json`, MAX.report)
      const reportPlain = reportRaw.status === "ok" ? createHash("sha256").update(reportRaw.bytes).digest("hex") : null
      const schemaProblems = []
      if (value.version !== 1) schemaProblems.push("version must be 1")
      if (value.sessionId !== runId) schemaProblems.push(`sessionId does not match ${runId}`)
      if (value.taskId !== id) schemaProblems.push(`taskId does not match ${id}`)
      if (value.kind !== kind) schemaProblems.push(`kind does not match ${kind}`)
      if (value.verdict !== expected.verdict) schemaProblems.push(`verdict must be ${expected.verdict}`)
      if (value.agent !== expected.agent) schemaProblems.push(`agent must be ${expected.agent}`)
      if (typeof value.agentSessionId !== "string" || value.agentSessionId.trim() === "") {
        schemaProblems.push("agentSessionId is missing")
      }
      if (typeof value.generatedAt !== "string" || value.generatedAt === "") schemaProblems.push("generatedAt is missing")
      if (!SHA256_HEX.test(String(value.reportHash ?? ""))) {
        schemaProblems.push("reportHash is missing or invalid")
      } else if (reportPlain && value.reportHash !== reportPlain) {
        schemaProblems.push("reportHash does not match the current report bytes")
      }
      if (schemaProblems.length > 0) {
        const stale = schemaProblems.some((p) => p.startsWith("reportHash does not match"))
        fail(
          `wave:${kind}:${id}:schema`,
          stale ? "AUTH_STALE" : "WAVE_INVALID",
          `${label}: ${schemaProblems.join("; ")}`,
          [label, `verify/report-${id}.json`],
        )
      } else {
        pass(`wave:${kind}:${id}:schema`, `${label} is bound to the current report`, [label])
        relate(label, `verify/report-${id}.json`, "reportHash", value.reportHash, reportPlain)
      }

      if (value.cites === undefined) {
        warn(
          `wave:${kind}:${id}:cites`,
          "legacy_unbound_wave",
          `${label} has no cites (recorded before 0.12.0); re-record it to bind reviewed evidence`,
          [label],
        )
      } else if (!Array.isArray(value.cites)) {
        fail(`wave:${kind}:${id}:cites`, "WAVE_INVALID", `${label}: cites must be an array`, [label])
      } else if (value.cites.length === 0) {
        fail(
          `wave:${kind}:${id}:cites`,
          "WAVE_UNBOUND",
          `${label}: cites is empty; the verdict is unbound (cite at least one verify/ artifact)`,
          [label],
        )
      } else {
        let citesOk = true
        for (const cite of value.cites) {
          if (
            !cite ||
            typeof cite !== "object" ||
            typeof cite.path !== "string" ||
            !WAVE_CITE_PATH.test(cite.path) ||
            !SHA256_HEX.test(String(cite.sha256 ?? ""))
          ) {
            citesOk = false
            fail(`wave:${kind}:${id}:cites`, "WAVE_INVALID", `${label}: cites contains an invalid entry`, [label])
            continue
          }
          const cited = readRunFile(runRoot, cite.path, MAX.evidence)
          if (cited.status !== "ok") {
            citesOk = false
            fail(`wave:${kind}:${id}:cites`, "AUTH_STALE", `${label}: cited evidence ${cite.path} is missing or unreadable`, [
              label,
              cite.path,
            ])
            continue
          }
          const actual = createHash("sha256").update(cited.bytes).digest("hex")
          const actualBytes = cited.size
          if (actual !== cite.sha256) {
            citesOk = false
            fail(`wave:${kind}:${id}:cites`, "AUTH_STALE", `${label}: cited evidence ${cite.path} changed since it was recorded`, [
              label,
              cite.path,
            ])
          } else if (Number.isFinite(cite.bytes) && Number(cite.bytes) !== actualBytes) {
            citesOk = false
            fail(
              `wave:${kind}:${id}:cites`,
              "AUTH_STALE",
              `${label}: cited evidence ${cite.path} byte length changed since it was recorded`,
              [label, cite.path],
            )
          }
          relate(label, cite.path, "citeSha256", cite.sha256, actual)
        }
        if (citesOk) pass(`wave:${kind}:${id}:cites`, `${label} cites match current bytes`, [label])
      }
    }
  }

  // --- handoff index ------------------------------------------------------
  const handoffBodies = new Map()
  if (handoffIndex) {
    const entries = handoffIndex.entries
    if (entries.length > 200) {
      fail("handoff:index", "HANDOFF_INVALID", `handoffs/index.json has ${entries.length} entries (cap 200)`, [
        "handoffs/index.json",
      ])
    }
    let indexOk = true
    for (const entry of entries) {
      const label = `${String(entry?.taskId)}:${String(entry?.agent)}`
      const problems = []
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        indexOk = false
        fail("handoff:index", "HANDOFF_INVALID", "handoffs/index.json has a non-object entry", ["handoffs/index.json"])
        continue
      }
      if (typeof entry.taskId !== "string" || (entry.taskId !== RUN_LEVEL_TASK_ID && !isSafeTaskId(entry.taskId))) {
        problems.push("invalid taskId")
      }
      const slug = handoffSlug(entry.agent)
      if (!slug) problems.push("invalid agent")
      if (typeof entry.agentSessionId !== "string" || entry.agentSessionId.trim() === "") problems.push("missing agentSessionId")
      if (!Number.isFinite(entry.round) || Number(entry.round) < 0) problems.push("invalid round")
      if (typeof entry.path !== "string" || !HANDOFF_PATH.test(entry.path)) problems.push("invalid path")
      else if (slug && entry.path !== handoffRelativePath(entry.taskId, slug)) problems.push("path does not match task/agent")
      if (!SHA256_HEX.test(String(entry.sha256 ?? ""))) problems.push("invalid sha256")
      if (!Number.isFinite(entry.bytes) || Number(entry.bytes) < 0) problems.push("invalid bytes")
      if (typeof entry.generatedAt !== "string" || Number.isNaN(Date.parse(entry.generatedAt))) problems.push("invalid generatedAt")
      if (!Array.isArray(entry.cites)) problems.push("cites is not an array")
      if (problems.length > 0) {
        indexOk = false
        fail(`handoff:index:${label}`, "HANDOFF_INVALID", `index entry ${label}: ${problems.join("; ")}`, [
          "handoffs/index.json",
        ])
        continue
      }

      const body = readRunFile(runRoot, entry.path, MAX.handoff)
      if (body.status !== "ok") {
        indexOk = false
        fail(`handoff:${label}`, "HANDOFF_INVALID", `handoff file ${entry.path} is missing or unreadable`, [
          "handoffs/index.json",
          entry.path,
        ])
        continue
      }
      const actual = sha256Hex(body.text)
      if (actual !== entry.sha256) {
        indexOk = false
        fail(`handoff:${label}`, "HANDOFF_STALE", `handoff ${entry.path} sha256 does not match handoffs/index.json`, [
          "handoffs/index.json",
          entry.path,
        ])
      }
      if (body.size !== entry.bytes) {
        indexOk = false
        fail(`handoff:${label}`, "HANDOFF_STALE", `handoff ${entry.path} byte length does not match handoffs/index.json`, [
          "handoffs/index.json",
          entry.path,
        ])
      }
      const header = HANDOFF_HEADER.exec(body.text.split("\n", 1)[0] ?? "")
      if (!header) {
        indexOk = false
        fail(`handoff:${label}`, "HANDOFF_INVALID", `handoff ${entry.path} has no canonical HANDOFF header`, [entry.path])
      } else if (header[1] !== entry.taskId || header[2] !== entry.agent) {
        indexOk = false
        fail(
          `handoff:${label}`,
          "HANDOFF_INVALID",
          `handoff ${entry.path} header claims ${header[1]}/${header[2]}, not ${entry.taskId}/${entry.agent}`,
          [entry.path],
        )
      }
      handoffBodies.set(`${entry.taskId}\u0000${entry.agent}`, { entry, body })

      for (const cite of entry.cites) {
        if (
          !cite ||
          typeof cite !== "object" ||
          typeof cite.path !== "string" ||
          !HANDOFF_CITE_PATH.test(cite.path) ||
          !SHA256_HEX.test(String(cite.sha256 ?? ""))
        ) {
          indexOk = false
          fail(`handoff:${label}`, "HANDOFF_INVALID", `handoff ${entry.path} cites contains an invalid entry`, [
            entry.path,
          ])
          continue
        }
        const cited = readRunFile(runRoot, cite.path, MAX.artifact)
        if (cited.status !== "ok") {
          indexOk = false
          fail(
            `handoff:${label}`,
            "HANDOFF_STALE",
            `handoff ${entry.path} cites ${cite.path}, which is missing or unreadable`,
            [entry.path, cite.path],
          )
          continue
        }
        const current = sha256Hex(cited.text)
        if (current !== cite.sha256) {
          indexOk = false
          fail(
            `handoff:${label}`,
            "HANDOFF_STALE",
            `handoff ${entry.path} is stale: ${cite.path} changed since the handoff was recorded`,
            [entry.path, cite.path],
          )
        }
        relate(entry.path, cite.path, "citeSha256", cite.sha256, current)
      }

      const check = checkEnvelope(
        entry.path,
        handoffAuthPayload(runId, entry),
        { alg: runAlg, keyId: runKeyId, nonce: runNonce },
        material,
      )
      if (check.ok) {
        if (typeof entry.runKeyId !== "string" || entry.runKeyId !== check.auth.keyId) {
          indexOk = false
          fail(
            `handoff:auth:${label}`,
            "AUTH_INVALID",
            `handoff index entry ${entry.path} runKeyId ${String(entry.runKeyId)} does not match the signing key ${check.auth.keyId}`,
            ["handoffs/index.json", entry.path],
          )
        } else {
          pass(`handoff:auth:${label}`, `handoff index entry ${entry.path} verifies`, ["handoffs/index.json", entry.path])
        }
      } else if (check.code === "AUTH_MISSING") {
        if (handoffMode === "required" && manifest?.handoffAuth === "signed" && !allowedUnsigned) {
          indexOk = false
          fail(
            `handoff:auth:${label}`,
            "AUTH_MISSING",
            `handoff index entry ${entry.path} has no _auth envelope on a signed run`,
            ["handoffs/index.json", entry.path],
          )
        } else {
          warn(`handoff:auth:${label}`, "AUTH_MISSING", `handoff index entry ${entry.path} is unsigned`, [entry.path])
        }
      } else if (check.unknown) {
        unknownCheck(`handoff:auth:${label}`, check.code, `${entry.path}: ${check.message}`, [entry.path])
      } else {
        indexOk = false
        fail(`handoff:auth:${label}`, check.code, `${entry.path}: ${check.message}`, ["handoffs/index.json", entry.path])
      }
    }
    if (indexOk && entries.length > 0) {
      pass("handoff:index", `handoffs/index.json has ${entries.length} valid entries`, ["handoffs/index.json"])
    }
  }

  // --- continuity matrix (required mode) ----------------------------------
  const requiredPairs = []
  if (handoffMode === "required") {
    const requirementsList = []
    const pushReq = (taskId, agents, label) => {
      const key = `${taskId}\u0000${agents.join("|")}`
      if (requirementsList.some((r) => r.key === key)) return
      requirementsList.push({ key, taskId, agents, label })
    }
    for (const id of taskIds) {
      const task = Array.isArray(plan?.tasks) ? plan.tasks.find((t) => t?.id === id) : undefined
      const assigned = typeof task?.agent === "string" && task.agent.trim() ? task.agent.trim() : "team/worker"
      if (TASK_SCOPED_ROLES.includes(assigned)) pushReq(id, [assigned], `task ${id} worker`)
      pushReq(id, ["team/verifier"], `task ${id} verifier`)
      if (verificationMode === "strict") {
        pushReq(id, ["team/falsifier"], `task ${id} falsifier`)
        pushReq(id, ["team/security-auditor"], `task ${id} security auditor`)
      }
    }
    pushReq(RUN_LEVEL_TASK_ID, ["team/sentinel", "team/orchestrator"], "run-level sentinel/orchestrator")
    if (victoryMode === "required") pushReq(RUN_LEVEL_TASK_ID, ["team/victory-auditor"], "run-level victory auditor")

    const byPair = new Map()
    for (const entry of handoffIndex?.entries ?? []) {
      if (!entry || typeof entry.taskId !== "string" || typeof entry.agent !== "string") continue
      const key = `${entry.taskId}\u0000${entry.agent}`
      const list = byPair.get(key) ?? []
      list.push(entry)
      byPair.set(key, list)
    }
    let matrixOk = true
    if (!handoffIndex) {
      matrixOk = false
      fail(
        "handoff:matrix",
        "HANDOFF_MISSING",
        "requireHandoffs is required but handoffs/index.json is missing",
        ["handoffs/index.json"],
      )
    } else {
      for (const req of requirementsList) {
        for (const agent of req.agents) requiredPairs.push({ taskId: req.taskId, agent })
        const candidates = []
        for (const agent of req.agents) candidates.push(...(byPair.get(`${req.taskId}\u0000${agent}`) ?? []))
        if (candidates.length === 0) {
          matrixOk = false
          fail(
            `handoff:matrix:${req.taskId}:${req.agents.join("|")}`,
            "HANDOFF_MISSING",
            `handoff missing: ${req.taskId} ${req.agents.join(" or ")} (${req.label})`,
            ["handoffs/index.json"],
          )
          continue
        }
        if (candidates.length > 1) {
          matrixOk = false
          fail(
            `handoff:matrix:${req.taskId}:${req.agents.join("|")}`,
            "HANDOFF_DUPLICATE",
            `handoff duplicate: ${req.label} has ${candidates.length} entries (expected exactly one)`,
            ["handoffs/index.json"],
          )
          continue
        }
        const entry = candidates[0]
        const slug = handoffSlug(entry.agent)
        const citePath = handoffCiteRelativePath(entry.agent, entry.taskId === RUN_LEVEL_TASK_ID ? undefined : entry.taskId)
        if (citePath && Array.isArray(entry.cites) && !entry.cites.some((c) => c?.path === citePath)) {
          matrixOk = false
          fail(
            `handoff:matrix:${entry.taskId}:${entry.agent}`,
            "HANDOFF_INVALID",
            `handoff ${entry.path} does not cite ${citePath}`,
            [entry.path],
          )
        }
        if (slug && entry.path !== handoffRelativePath(entry.taskId, slug)) {
          matrixOk = false
          fail(
            `handoff:matrix:${entry.taskId}:${entry.agent}`,
            "HANDOFF_INVALID",
            `handoff ${entry.path} is not the derived path for ${entry.taskId}/${entry.agent}`,
            [entry.path],
          )
        }
      }
      for (const entry of handoffIndex.entries) {
        if (!entry || typeof entry.taskId !== "string" || typeof entry.agent !== "string") continue
        const allowed =
          entry.taskId === RUN_LEVEL_TASK_ID
            ? RUN_LEVEL_ROLES.includes(entry.agent) || entry.agent === "team/security-auditor"
            : TASK_SCOPED_ROLES.includes(entry.agent)
        if (!allowed) {
          matrixOk = false
          fail(
            `handoff:matrix:${entry.taskId}:${entry.agent}`,
            "HANDOFF_INVALID",
            `handoff index has an unsupported role ${entry.agent} for ${entry.taskId}`,
            ["handoffs/index.json"],
          )
        }
        if (entry.taskId !== RUN_LEVEL_TASK_ID && !taskIds.includes(entry.taskId)) {
          matrixOk = false
          fail(
            `handoff:matrix:${entry.taskId}:${entry.agent}`,
            "HANDOFF_INVALID",
            `handoff index names unknown task ${entry.taskId}`,
            ["handoffs/index.json"],
          )
        }
      }
    }
    if (matrixOk) {
      pass("handoff:matrix", `continuity matrix is complete (${requiredPairs.length} required pairs)`, [
        "handoffs/index.json",
      ])
    }
  }

  // --- CI attestation (0.18.0) ---------------------------------------------
  // Policy comes from the signed manifest. `off` ignores the artifact; without
  // a supplied public key a present attestation is UNKNOWN, never PASS.
  let attestationInfo = { status: "OFF", commitSha: null, keyId: null, issuer: null }
  const attestationPolicy = manifest ? manifestAttestationPolicy(manifest) : "off"
  if (attestationPolicy !== "off") {
    const attRead = readRunJson(runRoot, ATTESTATION_PATH, MAX.attestation)
    let attArtifact
    if (attRead.status === "ok") attArtifact = attRead.value
    else if (attRead.status === "error") attArtifact = {}
    const attReports = [...reports.entries()].map(([taskId, entry]) => ({
      taskId,
      headSha:
        typeof entry.value?.headSha === "string" && entry.value.headSha !== "" ? entry.value.headSha : undefined,
      checks: Array.isArray(entry.value?.checks)
        ? entry.value.checks
            .filter((check) => Array.isArray(check?.command))
            .map((check) => ({
              argv: check.command,
              cwd: typeof check.cwd === "string" ? check.cwd : ".",
              exitCode: Number.isInteger(check.exitCode) ? check.exitCode : undefined,
              output: typeof check.output === "string" ? check.output : "",
              outputTruncated: check.outputTruncated === true,
            }))
        : [],
    }))
    const expectedKeyId =
      (typeof manifest?.attestationKeyId === "string" && manifest.attestationKeyId !== ""
        ? manifest.attestationKeyId
        : undefined) ??
      options.attestationKeyId ??
      (attestationKeyRaw ? attestationKeyIdFromPublicKey(attestationKeyRaw, options.attestationKeyId) : undefined)
    const expectedIssuer =
      (typeof manifest?.attestationIssuer === "string" && manifest.attestationIssuer !== ""
        ? manifest.attestationIssuer
        : undefined) ?? options.attestationIssuer
    const evaluated = evaluateAttestation({
      artifact: attArtifact,
      policy: attestationPolicy,
      publicKey: attestationKey,
      expectedKeyId,
      expectedIssuer,
      expectedAudience: options.attestationAudience,
      expectedRepository: options.attestationRepository,
      expectedRef: options.attestationRef,
      oidcJwks: options.oidcJwks,
      requireOidcToken: options.requireOidcToken === true,
      runId,
      runNonce: typeof manifest?.runNonce === "string" ? manifest.runNonce : undefined,
      runKeyId: typeof manifest?.runKeyId === "string" ? manifest.runKeyId : undefined,
      planHash: typeof manifest?.planHash === "string" ? manifest.planHash : undefined,
      promptHash: typeof manifest?.specHash === "string" ? manifest.specHash : undefined,
      reports: attReports,
    })
    attestationInfo = {
      status: evaluated.status,
      commitSha: evaluated.commitSha ?? null,
      keyId: evaluated.keyId ?? null,
      issuer: evaluated.issuer ?? null,
    }
    const detail = `attestation (policy ${attestationPolicy}): ${evaluated.status}${
      evaluated.code ? ` [${evaluated.code}] ${evaluated.message ?? ""}` : ""
    }`
    if (evaluated.status === "ATTESTED") {
      pass("attestation", detail, [ATTESTATION_PATH])
    } else if (attestationPolicy === "required") {
      if (evaluated.status === "UNKNOWN") {
        unknownCheck("attestation", evaluated.code ?? "AUTH_ATTESTATION_UNTRUSTED", detail, [ATTESTATION_PATH])
      } else {
        fail("attestation", evaluated.code ?? "AUTH_ATTESTATION_UNTRUSTED", detail, [ATTESTATION_PATH])
      }
    } else if (evaluated.status !== "MISSING") {
      warn("attestation", evaluated.code ?? "AUTH_ATTESTATION_UNTRUSTED", detail, [ATTESTATION_PATH])
    } else {
      skip("attestation", detail, [ATTESTATION_PATH])
    }
  } else {
    skip("attestation", "attestationPolicy is off; any CI attestation is ignored", [ATTESTATION_PATH])
  }

  // --- final verdict ------------------------------------------------------
  // C-1: the final verdict is required. Missing, unreadable, unsigned or FAIL
  // is named here instead of silently skipping the final block.
  const finalRead = artifactReads.get("verify/final.json")
  const finalAuth = artifactAuth.get("verify/final.json")
  if (!final) {
    if (finalRead?.status === "error") {
      fail("final:present", "FINAL_UNREADABLE", `verify/final.json is unreadable (${finalRead.error})`, [
        "verify/final.json",
      ])
    } else if (signedRun) {
      fail("final:present", "FINAL_MISSING", "verify/final.json is missing; a signed run has no final verdict to verify", [
        "verify/final.json",
      ])
    } else {
      unknownCheck(
        "final:present",
        "FINAL_MISSING",
        "verify/final.json is missing; this unsigned legacy run has no final verdict and cannot be reported PASS",
        ["verify/final.json"],
      )
    }
  } else if (signedRun) {
    if (finalAuth?.ok) {
      pass("final:present", "verify/final.json is present and authenticated", [final.path])
    } else if (finalAuth?.unknown) {
      unknownCheck(
        "final:present",
        finalAuth.code ?? "AUTH_UNAVAILABLE",
        `verify/final.json is present but cannot be authenticated: ${finalAuth.message ?? "no key material"}`,
        [final.path],
      )
    } else {
      fail(
        "final:present",
        finalAuth?.code ?? "AUTH_INVALID",
        `verify/final.json is present but not authenticated on a signed run: ${finalAuth?.message ?? "no envelope result"}`,
        [final.path],
      )
    }
  } else {
    pass("final:present", "verify/final.json is present", [final.path])
  }

  if (final) {
    const value = final.value
    if (value.status === "PASS") {
      pass("final:status", "final verdict is PASS", ["verify/final.json"])
    } else if (value.status === "FAIL") {
      fail("final:status", "FINAL_FAILED", "verify/final.json records FAIL; the run is not verified", [
        "verify/final.json",
      ])
    } else {
      fail("final:status", "FINAL_INVALID", `final verdict status ${String(value.status)} is not PASS|FAIL`, [
        "verify/final.json",
      ])
    }
    const digests = value.evidence?.reportDigests
    if (digests && typeof digests === "object" && !Array.isArray(digests)) {
      const current = evidenceDigestsOnDisk()
      let digestOk = true
      for (const [id, digest] of Object.entries(digests)) {
        if (!isSafeTaskId(id)) {
          digestOk = false
          fail("final:reportDigests", "AUTH_STALE", `final reportDigests names an invalid task id ${id}`, [
            "verify/final.json",
          ])
          continue
        }
        if (current.reports[id] !== digest) {
          digestOk = false
          fail("final:reportDigests", "AUTH_STALE", `report ${id} changed since final verification`, [
            "verify/final.json",
            `verify/report-${id}.json`,
          ])
        }
        if (digest === null && reportStatus(id) === "PASS") {
          digestOk = false
          fail(
            "final:reportDigests",
            "REPORT_DIGEST",
            `final reportDigests records a null digest for PASS report ${id}`,
            ["verify/final.json", `verify/report-${id}.json`],
          )
        }
        relate("verify/final.json", `verify/report-${id}.json`, "reportDigest", digest, current.reports[id] ?? null)
      }
      for (const id of Object.keys(current.reports)) {
        if (!Object.prototype.hasOwnProperty.call(digests, id)) {
          digestOk = false
          fail("final:reportDigests", "AUTH_STALE", `final verdict has no digest for report ${id}`, [
            "verify/final.json",
            `verify/report-${id}.json`,
          ])
        }
      }
      if (digestOk) pass("final:reportDigests", "final report digests match the current report bytes", ["verify/final.json"])
    } else if (value.status === "PASS") {
      fail("final:reportDigests", "REPORT_DIGEST", "final PASS has no evidence.reportDigests", ["verify/final.json"])
    }

    if (Object.prototype.hasOwnProperty.call(value.evidence ?? {}, "auditDigest")) {
      const recorded = value.evidence.auditDigest
      const current = keyedDigest("verify/security-audit.json", MAX.audit)
      if (recorded !== current) {
        fail("final:auditDigest", "AUTH_STALE", "security audit changed since final verification", [
          "verify/final.json",
          "verify/security-audit.json",
        ])
      } else {
        pass("final:auditDigest", "final audit digest matches the current security audit", ["verify/final.json"])
      }
      relate("verify/final.json", "verify/security-audit.json", "auditDigest", recorded, current)
    }
    if (Object.prototype.hasOwnProperty.call(value.evidence ?? {}, "rerunDigest")) {
      const recorded = value.evidence.rerunDigest
      const current = keyedDigest("verify/rerun.json", MAX.rerun)
      if (recorded !== current) {
        fail("final:rerunDigest", "AUTH_STALE", "verify/rerun.json changed since final verification", [
          "verify/final.json",
          "verify/rerun.json",
        ])
      } else {
        pass("final:rerunDigest", "final rerun digest matches the current re-execution record", ["verify/final.json"])
      }
      relate("verify/final.json", "verify/rerun.json", "rerunDigest", recorded, current)
    } else if (value.status === "PASS" && provenance === "command") {
      fail("final:rerunDigest", "AUTH_STALE", 'final PASS has no evidence.rerunDigest under requiredProvenance "command"', [
        "verify/final.json",
      ])
    }
    if (Object.prototype.hasOwnProperty.call(value, "requirementsHash")) {
      if (value.requirementsHash !== currentRequirementsHash) {
        fail("final:requirementsHash", "AUTH_STALE", "requirements baseline changed since final verification", [
          "verify/final.json",
          "requirements.json",
        ])
      } else {
        pass("final:requirementsHash", "final requirementsHash matches the current baseline", ["verify/final.json"])
        relate("verify/final.json", "requirements.json", "requirementsHash", value.requirementsHash, currentRequirementsHash)
      }
    } else if (value.status === "PASS") {
      fail("final:requirementsHash", "AUTH_STALE", "final PASS has no requirementsHash", ["verify/final.json"])
    }

    if (value.status === "PASS") {
      const problems = []
      const taskStates = state?.tasks && typeof state.tasks === "object" ? state.tasks : {}
      for (const id of taskIds) {
        const status = taskStates[id]?.status
        if (!isPassStatus(status)) problems.push(`task ${id} is ${String(status ?? "missing")}`)
        if (reportStatus(id) !== "PASS") problems.push(`report ${id} is ${reportStatus(id)}`)
      }
      if (audit?.value?.status !== "PASS") problems.push("security audit is not PASS")
      if (victoryMode === "required" && victory?.value?.verdict !== "VICTORY CONFIRMED") {
        problems.push("victory audit is not CONFIRMED")
      }
      if (handoffMode === "required") {
        const failed = checks.some((c) => c.id === "handoff:matrix" && c.status !== "pass")
        if (failed) problems.push("the continuity matrix is not complete")
      }
      if (value.evidence?.allTasksVerifiedPass !== true) problems.push("evidence.allTasksVerifiedPass is not true")
      if (problems.length > 0) {
        fail("final:claim", "FINAL_INCONSISTENT", `final.json claims PASS but ${problems.join("; ")}`, [
          "verify/final.json",
        ])
      } else {
        pass("final:claim", "final PASS agrees with the recomputed task/report/audit/victory evidence", [
          "verify/final.json",
        ])
      }
    }
  }

  // --- contradictions -----------------------------------------------------
  const taskStates = state?.tasks && typeof state.tasks === "object" ? state.tasks : {}
  if (victory?.value?.verdict === "VICTORY CONFIRMED") {
    for (const id of taskIds) {
      const status = taskStates[id]?.status
      if (status === "verified_fail" || status === "failed" || reportStatus(id) === "FAIL") {
        fail(
          `contradiction:INCONSISTENT_VICTORY_TASK`,
          "INCONSISTENT_VICTORY_TASK",
          `VICTORY CONFIRMED while task ${id} is ${String(status ?? "unknown")}${
            reportStatus(id) === "FAIL" ? " and its report is FAIL" : ""
          }`,
          ["verify/victory.json", `verify/report-${id}.json`, "state.json"],
        )
      }
    }
  }

  if (audit?.value?.status === "PASS") {
    const counts = audit.value.severityCounts ?? {}
    const high = Number(counts.high) || 0
    const critical = Number(counts.critical) || 0
    const highFinding = Array.isArray(audit.value.findings)
      ? audit.value.findings.find((f) => ["high", "critical"].includes(String(f?.severity).toLowerCase()))
      : undefined
    if (high > 0 || critical > 0 || highFinding) {
      fail(
        "contradiction:INCONSISTENT_AUDIT_HIGH",
        "INCONSISTENT_AUDIT_HIGH",
        `security audit reports PASS with ${critical} Critical / ${high} High finding(s)`,
        ["verify/security-audit.json"],
      )
    }
  }

  if (verificationMode === "strict") {
    for (const id of taskIds) {
      if (reportStatus(id) !== "FAIL") continue
      const raw = readRunFile(runRoot, `verify/report-${id}.json`, MAX.report)
      const digest = raw.status === "ok" ? createHash("sha256").update(raw.bytes).digest("hex") : null
      if (!digest) continue
      for (const kind of Object.keys(WAVE_KINDS)) {
        const wave = waves.get(`${id}:${kind}`)
        if (wave && typeof wave.value?.reportHash === "string" && wave.value.reportHash === digest) {
          fail(
            "contradiction:INCONSISTENT_WAVE_REPORT",
            "INCONSISTENT_WAVE_REPORT",
            `task ${id}: verify/${kind}-${id}.json records ${String(wave.value.verdict)} against the current FAIL report`,
            [`verify/${kind}-${id}.json`, `verify/report-${id}.json`],
          )
        }
      }
    }
  }

  // --- optional git branch binding ---------------------------------------
  const repo = options.repo !== undefined ? resolve(String(options.repo)) : undefined
  let gitReady = false
  if (repo) {
    gitReady = gitAvailable(repo)
    if (!gitReady) {
      if (options.requireGit) {
        unknownCheck("git:available", "GIT_UNAVAILABLE", `cannot use git in ${repo}; a branch check was required`, [])
      } else {
        skip("git:available", `git is unavailable in ${repo}; branch checks were skipped`, [])
      }
    }
  } else if (options.requireGit) {
    throw new VerifyUsageError("--require-git needs --repo <path>")
  }

  if (repo && gitReady) {
    const baseBranch = `teamwork/base-${runId}`
    const baseHead = gitCapture(repo, ["rev-parse", "--verify", baseBranch])
    for (const id of taskIds) {
      const entry = reports.get(id)
      if (!entry || entry.value?.status !== "PASS") continue
      const report = entry.value
      const branch =
        typeof report.branch === "string" && report.branch ? report.branch : `teamwork/${runId}-${id}`
      const head = gitCapture(repo, ["rev-parse", "--verify", branch])
      if (!head) {
        skip(`git:report:${id}`, `branch ${branch} does not exist in ${repo}; nothing to compare`, [entry.path])
        continue
      }
      let branchOk = true
      if (typeof report.headSha === "string" && report.headSha !== "") {
        relate(entry.path, branch, "headSha", report.headSha, head)
        if (report.headSha !== head) {
          branchOk = false
          fail(
            `contradiction:INCONSISTENT_REPORT_BRANCH`,
            "INCONSISTENT_REPORT_BRANCH",
            `task ${id}: PASS report names head ${report.headSha.slice(0, 12)}, but ${branch} is ${head.slice(0, 12)}`,
            [entry.path, branch],
          )
        }
      }
      if (typeof report.diffHash === "string" && report.diffHash !== "") {
        if (!baseHead) {
          skip(`git:report:${id}:diff`, `base branch ${baseBranch} does not exist; the diff was not recomputed`, [
            entry.path,
          ])
        } else {
          const diff = gitCapture(repo, ["diff", "--no-color", `${baseHead}..${head}`])
          const actual = diff === undefined ? null : sha256Hex(diff)
          relate(entry.path, `${baseBranch}..${branch}`, "diffHash", report.diffHash, actual)
          if (actual === null || actual !== report.diffHash) {
            branchOk = false
            fail(
              `contradiction:INCONSISTENT_REPORT_BRANCH`,
              "INCONSISTENT_REPORT_BRANCH",
              `task ${id}: PASS report's diffHash does not match the current ${branch} diff`,
              [entry.path, branch],
            )
          }
        }
      }
      if (branchOk) {
        pass(`git:report:${id}`, `report ${entry.path} is bound to the current ${branch}`, [entry.path, branch])
      }
    }
  } else if (!repo) {
    skip("git:available", "no --repo supplied; branch head/diff checks were skipped", [])
  }

  // --- document-review PDF visual audit completeness ---------------------
  verifyDocumentVisualAudit(runRoot, pass, fail)

  // --- optional witness receipt ------------------------------------------
  let witnessVerified = false
  if (witnessKey) {
    const receiptPath = options.witnessReceipt
    if (!receiptPath) {
      unknownCheck(
        "witness:receipt",
        "AUTH_WITNESS_UNAVAILABLE",
        "a witness public key was supplied but no --witness-receipt file was given",
        [],
      )
    } else {
      const read = readRunJson(dirname(resolve(receiptPath)), basename(receiptPath), MAX.witness)
      if (read.status !== "ok") {
        fail("witness:receipt", "AUTH_INVALID", `witness receipt is unreadable (${read.error ?? read.status})`, [])
      } else {
        const check = checkWitnessReceipt(
          read.value,
          runId,
          manifestAuth,
          witnessKey,
          options.witnessKeyId,
        )
        if (check.ok) {
          witnessVerified = manifestEnvelopeOk
          pass("witness:receipt", "witness receipt verifies the signed manifest", [])
        } else fail("witness:receipt", check.code, check.message, [])
      }
    }
  }

  // --- trust level, approval and witness (fail closed) --------------------
  // Offline verify has no approval enforcement and cannot establish that a
  // human or CI approver read the draft. A manifest that claims an approval
  // level is UNKNOWN here, never PASS. Likewise a required witness with no
  // usable receipt is UNKNOWN.
  if (manifest) {
    if (manifest.trustLevel === "human-approved" || manifest.trustLevel === "ci-attested") {
      trust.approval = { status: "UNVERIFIED" }
      unknownCheck(
        "trust:approval",
        "AUTH_APPROVAL_UNVERIFIED",
        `run.manifest.json records trustLevel ${manifest.trustLevel}, but this offline verifier has no approval enforcement; the approval cannot be established`,
        ["run.manifest.json"],
      )
    } else {
      trust.approval = { status: "NOT_REQUIRED" }
    }
    if (manifest.requireWitness === true) {
      if (witnessVerified) {
        trust.witness = { status: "VERIFIED" }
        pass("trust:witness", "the required witness receipt verifies the signed manifest", ["run.manifest.json"])
      } else {
        trust.witness = { status: "UNVERIFIED" }
        unknownCheck(
          "trust:witness",
          "AUTH_WITNESS_UNVERIFIED",
          "run.manifest.json requires a witness, but no usable witness receipt was verified",
          ["run.manifest.json"],
        )
      }
    } else {
      trust.witness = { status: "NOT_REQUIRED" }
    }
  }

  // --- optional index snapshot (rollback detection) -----------------------
  const snapshotSpec = options.requireIndex
  if (snapshotSpec === true || snapshotSpec === "") {
    unknownCheck(
      "index:snapshot",
      "INDEX_SNAPSHOT_REQUIRED",
      "--require-index was given without a snapshot path; a whole-run rollback cannot be ruled out",
      [],
    )
  } else if (typeof snapshotSpec === "string" && snapshotSpec !== "") {
    const snapshotAbs = resolve(snapshotSpec)
    const read = readRunJson(dirname(snapshotAbs), basename(snapshotAbs), MAX.snapshot)
    if (read.status !== "ok") {
      unknownCheck(
        "index:snapshot",
        "INDEX_SNAPSHOT_MISSING",
        `--require-index snapshot is unreadable (${read.error ?? read.status})`,
        [],
      )
    } else {
      const files = read.value.files && typeof read.value.files === "object" ? read.value.files : undefined
      if (!files) {
        fail("index:snapshot", "INDEX_SNAPSHOT_INVALID", "snapshot has no files map", [])
      } else if (read.value.runId !== undefined && read.value.runId !== runId) {
        fail("index:snapshot", "INDEX_SNAPSHOT_INVALID", `snapshot is for run ${String(read.value.runId)}, not ${runId}`, [])
      } else {
        let snapshotOk = true
        for (const [relPath, digest] of Object.entries(files)) {
          if (typeof relPath !== "string" || typeof digest !== "string") {
            snapshotOk = false
            fail("index:snapshot", "INDEX_SNAPSHOT_INVALID", "snapshot contains an invalid entry", [])
            continue
          }
          const file = readRunFile(runRoot, relPath, MAX.artifact)
          const actual = file.status === "ok" ? createHash("sha256").update(file.bytes).digest("hex") : null
          relate("snapshot", relPath, "fileSha256", digest, actual)
          if (actual !== digest) {
            snapshotOk = false
            fail(
              "index:snapshot",
              "INDEX_ROLLBACK",
              `snapshot entry ${relPath} does not match the current bytes (rollback or edit)`,
              [relPath],
            )
          }
        }
        const currentFiles = listRunFiles(runRoot).filter(
          (relPath) =>
            relPath !== basename(snapshotAbs) &&
            (/^verify\//.test(relPath) ||
              /^handoffs\//.test(relPath) ||
              /^(?:run\.manifest\.json|plan\.dag\.json|state\.json|requirements\.json|ORIGINAL_REQUEST\.md|prompt_draft\.md|lemma\/manifest\.json|tournament\/manifest\.json)$/.test(
                relPath,
              )),
        )
        for (const relPath of currentFiles) {
          if (!Object.prototype.hasOwnProperty.call(files, relPath)) {
            snapshotOk = false
            fail(
              "index:snapshot",
              "INDEX_ROLLBACK",
              `run contains ${relPath}, which is absent from the snapshot`,
              [relPath],
            )
          }
        }
        if (snapshotOk) pass("index:snapshot", "the current run matches the index snapshot", [])
      }
    }
  }

  const result = finish({
    runId,
    runPath: runRoot,
    trust,
    checks,
    relations,
    reasons,
    attestation: attestationInfo,
    failOnWarning: options.failOnWarning === true,
  })
  if (rerunInfo) result.rerun = rerunInfo
  return result
}

// Recursively list regular files, relative POSIX paths. Used only by the
// optional snapshot check; a symlink is reported as a path but never followed.
function listRunFiles(runRoot) {
  const out = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of entries) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      let st
      try {
        st = lstatSync(join(dir, dirent.name))
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        out.push(rel)
        continue
      }
      if (st.isDirectory()) walk(join(dir, dirent.name), rel)
      else if (st.isFile()) out.push(rel)
    }
  }
  walk(runRoot, "")
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function finish({ runId, runPath, trust, checks, relations, reasons, failOnWarning, attestation }) {
  // C-1: an empty check set is not evidence. It must never yield PASS.
  if (checks.length === 0) {
    checks.push({
      id: "verify:checks",
      level: "required",
      status: "unknown",
      detail: "[VERIFY_EMPTY] the verifier produced no checks; an empty check set cannot be PASS",
      artifacts: [],
    })
    reasons.push("[VERIFY_EMPTY] the verifier produced no checks; an empty check set cannot be PASS")
  }
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0, unknown: 0, total: checks.length }
  for (const check of checks) {
    if (Object.prototype.hasOwnProperty.call(counts, check.status)) counts[check.status] += 1
  }
  let verdict = counts.fail > 0 ? "FAIL" : counts.unknown > 0 ? "UNKNOWN" : "PASS"
  if (failOnWarning && counts.warn > 0 && verdict !== "FAIL") {
    verdict = "FAIL"
    reasons.push(`[WARN_PROMOTED] ${counts.warn} warning(s) promoted to a failure by --fail-on-warning`)
  } else if (failOnWarning && counts.warn > 0 && verdict === "FAIL") {
    reasons.push(`[WARN_PROMOTED] ${counts.warn} warning(s) present; --fail-on-warning is asserted`)
  }
  const attestationInfo = attestation ?? { status: "OFF", commitSha: null, keyId: null, issuer: null }
  return {
    schemaVersion: VERIFY_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    runId,
    runPath,
    trust,
    attestation: attestationInfo,
    attested: attestationInfo.status === "ATTESTED",
    verdict,
    counts,
    checks,
    relations,
    reasons,
    generatedAt: new Date().toISOString(),
  }
}

export function verifyExitCode(result, { failOnWarning = false } = {}) {
  if (result.verdict === "FAIL") return 1
  if (result.verdict === "UNKNOWN") return 2
  if (failOnWarning && result.counts.warn > 0) return 1
  return 0
}

/** Render the human table from the JSON result. */
export function renderVerify(result, { color = false } = {}) {
  const useColor = Boolean(color)
  const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
  const statusText = {
    pass: paint("32", "PASS"),
    warn: paint("33", "WARN"),
    fail: paint("31", "FAIL"),
    skip: paint("2", "SKIP"),
    unknown: paint("35", "UNKNOWN"),
  }
  const lines = []
  lines.push(`opencode-teamwork verify ${result.runId}`)
  lines.push(`Run:   ${result.runPath}`)
  lines.push(
    `Trust: ${result.trust.alg ?? "none"}${result.trust.keyId ? ` (${result.trust.keyId})` : ""} via ${result.trust.source}`,
  )
  if (result.attestation) {
    lines.push(
      `Attestation: ${result.attestation.status}${
        result.attestation.commitSha ? ` (commit ${String(result.attestation.commitSha).slice(0, 12)})` : ""
      }`,
    )
  }
  lines.push(
    `Checks: ${result.counts.pass} pass, ${result.counts.fail} fail, ${result.counts.warn} warn, ${result.counts.skip} skip, ${result.counts.unknown} unknown`,
  )
  lines.push("")
  lines.push(`Verdict: ${statusText[result.verdict.toLowerCase()] ?? result.verdict}`)
  if (result.checks.length) {
    lines.push("")
    for (const check of result.checks) {
      const label = statusText[check.status] ?? check.status
      lines.push(`  ${label.padEnd(8)} ${check.id}`)
      lines.push(`           ${check.detail}`)
    }
  }
  if (result.reasons.length) {
    lines.push("")
    lines.push("Reasons:")
    for (const reason of result.reasons) lines.push(`  - ${reason}`)
  }
  return lines
}
