// @heretek-ai/opencode-teamwork-v2 — local security posture diagnostics
//
// `opencode-teamwork doctor --security` reports the environment facts that
// bound what artifact authenticity can promise (ADR 0006/0008):
//
//   * which key source and algorithm signs artifacts;
//   * whether an external signer / witness is configured, and whether the
//     configured signer path is owned or writable by this UID;
//   * kernel ptrace_scope;
//   * root-equivalent group membership (docker, wheel, libvirt, ...);
//   * the OpenCode DB mode (the artifact key/index store, when it exists),
//     including its -wal/-shm siblings;
//   * config/plugin writability (a same-UID writer can edit the gate);
//   * a configured approval directory (owner, location, writability);
//   * write-containment mode (`pinned` vs detective);
//   * SELinux mode.
//
// It is read-only, dependency-free, and never treats a missing probe as a
// finding: unknown host facts are reported as `unknown`, not safe.
//
// `doctor --security --require-hardened` exits 2 when any check is `fail` or
// `unknown`; plain `doctor --security` stays advisory (exit 0 with warnings).
//
// The overridable probes are exported for hermetic tests; the defaults read the
// real host. No shell interpolation is used anywhere.

import { accessSync, constants as fsConstants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createPublicKey } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  REQUIRE_PINNED_WRITES_ENV,
  fdTraversalMode,
  listContainmentIncidents,
  readRegularBounded,
  requirePinnedWritesEnabled,
  resolveRunPolicy,
  supportsFdContainment,
  unacknowledgedWriteAnomalies,
} from "../plugins/opencode-teamwork/safe-fs.mjs"

const ROOT_EQUIVALENT_GROUPS = ["root", "wheel", "sudo", "docker", "libvirt", "lxd", "disk", "adm"]
const APPROVAL_DIR_ENV = "OPENCODE_TEAMWORK_APPROVAL_DIR"
const SIGNER_APPROVAL_DIR_ENV = "OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR"
const ATTESTATION_PUBLIC_ENV = "OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY"
const ATTESTATION_KEY_ID_ENV = "OPENCODE_TEAMWORK_ATTESTATION_KEY_ID"
const ATTESTATION_PRIVATE_ENV = "OPENCODE_TEAMWORK_ATTESTATION_PRIVATE_KEY"
const ATTESTATION_KEY_FILE_ENV = "OPENCODE_TEAMWORK_ATTESTATION_KEY_FILE"

function pass(name, message) {
  return { name, status: "pass", message }
}
function warn(name, message) {
  return { name, status: "warn", message }
}
function fail(name, message) {
  return { name, status: "fail", message }
}
function unknown(name, message) {
  return { name, status: "unknown", message }
}

function keySource(env) {
  const signer = String(env.OPENCODE_TEAMWORK_SIGNER || "").trim()
  if (signer) {
    const ok = signer.startsWith("command:/")
    return {
      source: "command-signer",
      alg: "ed25519",
      configured: ok,
      message: ok
        ? `external signer ${signer.slice("command:".length)} (verification public key ${env.OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY ? "set" : "MISSING"})`
        : `OPENCODE_TEAMWORK_SIGNER is malformed (expected command:<absolute path>)`,
    }
  }
  if (env.OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY || env.OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY) {
    const privateKey = !!env.OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY
    return {
      source: privateKey ? "env-ed25519-private" : "env-ed25519-public",
      alg: "ed25519",
      configured: true,
      message: privateKey
        ? "Ed25519 signing key from OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY (private key is readable by this UID)"
        : "Ed25519 public key from OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY (verification only)",
    }
  }
  if (env.OPENCODE_TEAMWORK_HMAC_KEY) {
    return {
      source: "env-hmac",
      alg: "hmac-sha256",
      configured: true,
      message: "HMAC key from OPENCODE_TEAMWORK_HMAC_KEY (verification needs the same secret)",
    }
  }
  return {
    source: "plugin-storage",
    alg: "hmac-sha256",
    configured: true,
    message: "HMAC key ring in plugin storage (opencode.db / KV; same-UID readable)",
  }
}

function normalizeGroupNames(groups, groupFile) {
  const names = new Set()
  const byGid = new Map()
  let readable = false
  try {
    for (const line of readFileSync(groupFile, "utf8").split("\n")) {
      const parts = line.split(":")
      if (parts.length < 4) continue
      const [name, , gid, members] = parts
      if (name && gid) byGid.set(String(gid), name)
      for (const member of members.split(",")) {
        if (member.trim()) names.add(member.trim())
      }
    }
    readable = true
  } catch {
    // Fail closed: a numeric GID cannot be mapped without the group file, so
    // the caller must report UNKNOWN rather than PASS for privileged_groups.
  }
  for (const g of groups) {
    if (g === null || g === undefined) continue
    const id = String(g)
    const name = byGid.get(id) ?? (typeof g === "string" ? g : undefined)
    if (name) names.add(name)
  }
  return { names: [...names], readable }
}

function currentGroups() {
  try {
    const ids = new Set(process.getgroups?.() ?? [])
    if (typeof process.getgid === "function") ids.add(process.getgid())
    return [...ids]
  } catch {
    return []
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8").trim()
  } catch {
    return undefined
  }
}

const UNSCOPED_CHANNELS = new Set(["latest", "dev", "beta", "next", "prod"])

function channelSafe(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-")
}

function opencodeDatabaseFilename(channel, env) {
  if (env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true") {
    return "opencode.db"
  }
  if (UNSCOPED_CHANNELS.has(channel)) return "opencode.db"
  return `opencode-${channelSafe(channel)}.db`
}

function opencodeDataRoots(env) {
  const home = env.HOME ? resolve(env.HOME) : homedir()
  const raw = [
    env.XDG_DATA_HOME ? join(resolve(env.XDG_DATA_HOME), "opencode") : null,
    join(home, ".local", "share", "opencode"),
    join(home, "Library", "Application Support", "opencode"),
    env.LOCALAPPDATA ? join(resolve(env.LOCALAPPDATA), "opencode") : null,
    join(home, "AppData", "Local", "opencode"),
  ].filter(Boolean)
  return [...new Set(raw)]
}

function dbCandidatesFor(env) {
  const roots = opencodeDataRoots(env)
  const override = String(env.OPENCODE_DB ?? "").trim()
  if (override) {
    if (override === ":memory:") return { memory: true, candidates: [] }
    return {
      memory: false,
      candidates: [isAbsolute(override) ? override : resolve(roots[0], override)],
    }
  }
  const channel = String(env.OPENCODE_CHANNEL ?? "").trim() || "local"
  const names = [...new Set([opencodeDatabaseFilename(channel, env), "opencode.db"])]
  return {
    memory: false,
    candidates: roots.flatMap((root) => names.map((name) => join(root, name))),
  }
}

/** `opencode.db` (or channel-specific DB) plus its WAL/SHM siblings; any group/other bit is a fail. */
function dbCheck(spec) {
  const resolved = typeof spec === "string" ? { memory: false, candidates: [spec] } : spec
  if (resolved?.memory) {
    return pass("db_mode", "OPENCODE_DB is :memory: (in-memory database; no on-disk file)")
  }
  const candidates = Array.isArray(resolved?.candidates) ? resolved.candidates : []
  if (candidates.length === 0) return pass("db_mode", "no database path configured")

  for (const file of candidates) {
    const exposed = []
    const seen = []
    let unknownReason
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        const st = statSync(candidate)
        const mode = st.mode & 0o777
        seen.push(`${candidate} mode ${mode.toString(8)}`)
        if ((mode & 0o077) !== 0) exposed.push(`${candidate} mode ${mode.toString(8)}`)
      } catch (err) {
        if (err?.code === "ENOENT") continue
        unknownReason = unknownReason ?? `${candidate} (${err?.code || "error"})`
      }
    }
    if (exposed.length > 0) {
      return fail(
        "db_mode",
        `${exposed.join("; ")}; group/other bits are set (expected 0600 on the DB and its -wal/-shm files)`,
      )
    }
    if (unknownReason) return unknown("db_mode", `could not stat ${unknownReason}`)
    if (seen.length > 0) return pass("db_mode", seen.join("; "))
  }
  return pass("db_mode", `${candidates[0]} does not exist yet`)
}

function writeCheck(name, dir, label) {
  try {
    accessSync(dir, fsConstants.W_OK)
    return warn(name, `${label} ${dir} is writable by this UID; a same-UID process can modify the gate, prompts or plugin`)
  } catch (err) {
    if (err?.code === "ENOENT") return pass(name, `${label} ${dir} does not exist`)
    return pass(name, `${label} ${dir} is not writable (${err?.code || "denied"})`)
  }
}

function pluginRoot() {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..")
  } catch {
    return process.cwd()
  }
}

function pathWithinOrEqual(parent, child) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function callerOwnsOrCanWrite(st, euid) {
  const owned = st.uid === euid
  const ownerWrite = (st.mode & 0o200) !== 0
  const groupOrOtherWrite = (st.mode & 0o022) !== 0
  return (owned && ownerWrite) || groupOrOtherWrite
}

function signerCheck(env, euid) {
  const signer = String(env.OPENCODE_TEAMWORK_SIGNER || "").trim()
  if (!signer) return pass("signer", "no external signer configured (local key source)")
  if (!signer.startsWith("command:/")) {
    return warn("signer", "OPENCODE_TEAMWORK_SIGNER is set but malformed (expected command:<absolute path>)")
  }
  const signerPath = signer.slice("command:".length)
  let st
  try {
    st = statSync(signerPath)
  } catch (err) {
    return fail("signer", `configured signer path ${signerPath} is not readable (${err?.code || "error"})`)
  }
  if (!st.isFile()) return fail("signer", `configured signer path ${signerPath} is not a regular file`)
  const owned = st.uid === euid
  const writable = callerOwnsOrCanWrite(st, euid)
  if (owned || writable) {
    return fail(
      "signer",
      `configured signer ${signerPath} is ${owned ? "owned" : "writable"} by this UID (uid ${st.uid}); it is a signing oracle, not a privilege boundary`,
    )
  }
  if (!env.OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY) {
    return warn("signer", `external signer ${signerPath} has no OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY`)
  }
  return pass("signer", `external signer ${signerPath} (uid ${st.uid}) with a verification public key`)
}

function approvalKeyCheck(env, euid) {
  const publicKey = String(env.OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY || "").trim()
  const privateKey = String(env.OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY || "").trim()
  const keyFile = String(env.OPENCODE_TEAMWORK_APPROVAL_KEY_FILE || "").trim()
  const keyId = String(env.OPENCODE_TEAMWORK_APPROVAL_KEY_ID || "").trim()
  if (!publicKey && !privateKey && !keyFile) {
    return warn(
      "approval_key",
      "no approver key configured; human-approved/ci-attested refuse at plan time (the run key is not an approver key)",
    )
  }
  // The approver private key must be usable only from the `approve` CLI under a
  // different principal. Seeing it from this process is a failure, not a note:
  // a same-principal process could mint an approval the gate would accept.
  const visible = []
  if (privateKey) visible.push("inline OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY")
  if (keyFile) {
    let readable = false
    try {
      accessSync(keyFile, fsConstants.R_OK)
      readable = true
    } catch {}
    if (readable) visible.push(`key file ${keyFile}`)
  }
  if (visible.length > 0) {
    return fail(
      "approval_key",
      `approver private material is visible to this process${euid >= 0 ? ` (uid ${euid})` : ""}: ${visible.join(", ")}; the approver key must be usable only from the approve CLI under a different principal`,
    )
  }
  if (!publicKey) {
    return warn(
      "approval_key",
      `an approver key source is configured${keyId ? ` (id ${keyId})` : ""} but OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY is missing; the plugin cannot verify approvals`,
    )
  }
  return pass(
    "approval_key",
    `verify-only Ed25519 approval key configured${keyId ? ` (id ${keyId})` : " (id derived from the public key)"}; no approver private material is readable by this UID`,
  )
}

/**
 * The policy recorded in `run.manifest.json`, for the "required but no key"
 * warning. Doctor does not verify the envelope here; it reports the recorded
 * policy and the local key posture. A missing/unsigned manifest is `unknown`.
 */
function recordedAttestationPolicy(runDir) {
  if (!runDir) return undefined
  try {
    const read = readRegularBounded(join(runDir, "run.manifest.json"), 512 * 1024)
    if (read.status !== "ok") return undefined
    const parsed = JSON.parse(read.text)
    if (Number(parsed?.version) < 5) return "off"
    if (parsed?.attestationPolicy === "required") return "required"
    if (parsed?.attestationPolicy === "optional") return "optional"
    return "off"
  } catch {
    return undefined
  }
}

function isEd25519PublicKey(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return false
  try {
    const key = raw.includes("BEGIN")
      ? createPublicKey(raw)
      : createPublicKey({ key: Buffer.from(raw, "base64url"), format: "der", type: "spki" })
    return key.asymmetricKeyType === "ed25519"
  } catch {
    return false
  }
}

/**
 * CI attestation posture (0.18.0). A verify-only public key is the useful
 * configuration; the private key must not be visible to the agent's UID, and a
 * `required` run with no key is a warning (final_verify will refuse it).
 */
function attestationKeyCheck(env, euid, runDir) {
  const publicKey = String(env[ATTESTATION_PUBLIC_ENV] || "").trim()
  const keyId = String(env[ATTESTATION_KEY_ID_ENV] || "").trim()
  const privateKey = String(env[ATTESTATION_PRIVATE_ENV] || "").trim()
  const keyFile = String(env[ATTESTATION_KEY_FILE_ENV] || "").trim()
  const policy = recordedAttestationPolicy(runDir)
  const visible = []
  if (privateKey) visible.push(`inline ${ATTESTATION_PRIVATE_ENV}`)
  if (keyFile) {
    let readable = false
    try {
      accessSync(keyFile, fsConstants.R_OK)
      readable = true
    } catch {}
    if (readable) visible.push(`key file ${keyFile}`)
  }
  if (visible.length > 0) {
    return fail(
      "attestation_key",
      `CI attestation private material is visible to this process${euid >= 0 ? ` (uid ${euid})` : ""}: ${visible.join(", ")}; the CI signer key must live only in the CI principal, never the agent's environment`,
    )
  }
  if (!publicKey) {
    if (policy === "required") {
      return warn(
        "attestation_key",
        `${ATTESTATION_PUBLIC_ENV} is not configured but the run records attestationPolicy "required"; final_verify will refuse the missing key`,
      )
    }
    return pass(
      "attestation_key",
      `no CI attestation key configured${policy ? ` (policy ${policy})` : ""}; a required policy will fail closed`,
    )
  }
  if (!isEd25519PublicKey(publicKey)) {
    return fail("attestation_key", `${ATTESTATION_PUBLIC_ENV} is not a base64url SPKI / PEM Ed25519 public key`)
  }
  return pass(
    "attestation_key",
    `verify-only Ed25519 CI attestation key configured${keyId ? ` (id ${keyId})` : " (id derived from the public key)"}${policy ? `; policy ${policy}` : ""}`,
  )
}

/**
 * Whether a configured signer could be asked to sign an `approvals/` path. The
 * plugin signer always refuses it (AUTH_APPROVAL_SCOPE). An external command
 * signer is outside this process, so its policy is reported as unknown rather
 * than assumed.
 */
function approvalScopeCheck(env) {
  const signer = String(env.OPENCODE_TEAMWORK_SIGNER || "").trim()
  if (signer) {
    return warn(
      "approval_signer_scope",
      "a command signer is configured; its external policy is not inspectable here. The plugin signer itself refuses approvals/ paths with AUTH_APPROVAL_SCOPE; a same-UID command signer that accepts them is not an approval boundary",
    )
  }
  return pass(
    "approval_signer_scope",
    "no command signer configured; the plugin signer refuses approvals/ paths with AUTH_APPROVAL_SCOPE",
  )
}

function approvalDirCheck(env, euid, repoRoot, runDir) {
  const raw = String(env[APPROVAL_DIR_ENV] || "").trim()
  if (!raw) return pass("approval_dir", `${APPROVAL_DIR_ENV} is not configured (human-approved/ci-attested will refuse at plan time)`)
  if (!isAbsolute(raw)) return fail("approval_dir", `${APPROVAL_DIR_ENV} must be an absolute path (got ${raw})`)
  let st
  try {
    st = lstatSync(raw)
  } catch (err) {
    return fail("approval_dir", `${APPROVAL_DIR_ENV} ${raw} is not readable (${err?.code || "error"})`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return fail("approval_dir", `${APPROVAL_DIR_ENV} ${raw} must be a real directory (not a symlink)`)
  }
  let real
  try {
    real = realpathSync(raw)
  } catch (err) {
    return fail("approval_dir", `${APPROVAL_DIR_ENV} ${raw} cannot be resolved (${err?.code || "error"})`)
  }
  let repoReal = resolve(repoRoot ?? process.cwd())
  try {
    repoReal = realpathSync(repoRoot ?? process.cwd())
  } catch {}
  if (pathWithinOrEqual(repoReal, real)) {
    return fail("approval_dir", `${APPROVAL_DIR_ENV} ${real} is inside the repository`)
  }
  if (runDir) {
    let runReal = resolve(runDir)
    try {
      runReal = realpathSync(runDir)
    } catch {}
    if (pathWithinOrEqual(runReal, real)) {
      return fail("approval_dir", `${APPROVAL_DIR_ENV} ${real} is inside the run directory`)
    }
  }
  if (callerOwnsOrCanWrite(st, euid)) {
    return fail(
      "approval_dir",
      `${APPROVAL_DIR_ENV} ${real} is owned or writable by this UID (uid ${st.uid}); approval must come from a different principal`,
    )
  }
  return pass("approval_dir", `${APPROVAL_DIR_ENV} ${real} (uid ${st.uid}) is external to the run and repo`)
}

function signerApprovalDirCheck(env, euid, repoRoot, runDir) {
  const raw = String(env[SIGNER_APPROVAL_DIR_ENV] || "").trim()
  if (!raw) {
    return pass(
      "signer_approval_dir",
      `${SIGNER_APPROVAL_DIR_ENV} is not configured (the plugin keeps the v1 signer request)`,
    )
  }
  if (!isAbsolute(raw)) return fail("signer_approval_dir", `${SIGNER_APPROVAL_DIR_ENV} must be an absolute path (got ${raw})`)
  let st
  try {
    st = lstatSync(raw)
  } catch (err) {
    return fail("signer_approval_dir", `${SIGNER_APPROVAL_DIR_ENV} ${raw} is not readable (${err?.code || "error"})`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return fail("signer_approval_dir", `${SIGNER_APPROVAL_DIR_ENV} ${raw} must be a real directory (not a symlink)`)
  }
  let real
  try {
    real = realpathSync(raw)
  } catch (err) {
    return fail("signer_approval_dir", `${SIGNER_APPROVAL_DIR_ENV} ${raw} cannot be resolved (${err?.code || "error"})`)
  }
  let repoReal = resolve(repoRoot ?? process.cwd())
  try {
    repoReal = realpathSync(repoRoot ?? process.cwd())
  } catch {}
  if (pathWithinOrEqual(repoReal, real)) {
    return fail("signer_approval_dir", `${SIGNER_APPROVAL_DIR_ENV} ${real} is inside the repository`)
  }
  if (runDir) {
    let runReal = resolve(runDir)
    try {
      runReal = realpathSync(runDir)
    } catch {}
    if (pathWithinOrEqual(runReal, real)) {
      return fail("signer_approval_dir", `${SIGNER_APPROVAL_DIR_ENV} ${real} is inside the run directory`)
    }
  }
  if (callerOwnsOrCanWrite(st, euid)) {
    return fail(
      "signer_approval_dir",
      `${SIGNER_APPROVAL_DIR_ENV} ${real} is owned or writable by this UID (uid ${st.uid}); signer approvals must come from a different principal and the signer decides whether to accept them`,
    )
  }
  return pass(
    "signer_approval_dir",
    `${SIGNER_APPROVAL_DIR_ENV} ${real} (uid ${st.uid}) is external to the run and repo; expected layout <dir>/<runId>/<sha256(path)>.json`,
  )
}

function containmentCheck(options, trustClaim) {
  const mode = options.containmentMode ?? fdTraversalMode()
  const readSupport = options.readContainment ?? supportsFdContainment()
  // The per-run plan flag must be visible to doctor even when the env is off.
  // `runDir` is resolved through the shared resolver (realpath + (dev, ino),
  // plan hydrated from plan.dag.json), and the CLI also passes the flag it read
  // so a doctor run outside the plugin process reports the same policy.
  const envAsserted = requirePinnedWritesEnabled(options.env ?? process.env)
  const planPolicy =
    typeof options.planRequirePinnedWrites === "boolean"
      ? options.planRequirePinnedWrites
      : options.runDir
        ? resolveRunPolicy(options.runDir).planAsserted
        : false
  const policy =
    typeof options.requirePinnedWrites === "boolean" ? options.requirePinnedWrites : envAsserted || planPolicy
  const detail = `fdTraversalMode=${mode}; fd containment ${readSupport ? "enforced" : "unavailable"}; ${REQUIRE_PINNED_WRITES_ENV}=${
    envAsserted ? "1" : "0"
  }; planRequirePinnedWrites=${planPolicy ? "1" : "0"}${policy ? " (asserted)" : ""}`
  if (mode === "pinned") return pass("containment", `pinned write containment (${detail})`)
  if (policy) {
    return fail(
      "containment",
      `requirePinnedWrites is asserted but write containment is ${mode} (${detail}); control-plane writes will be refused with containment-mode`,
    )
  }
  if (trustClaim) {
    return fail(
      "containment",
      `approval/witness trust level asserted but write containment is ${mode} (${detail}); only pinned containment is preventive`,
    )
  }
  return warn("containment", `write containment is ${mode} (detective only; ${detail})`)
}

/**
 * Collect the security posture. All probes can be overridden so tests never
 * depend on the host.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   configDir?: string,
 *   platform?: string,
 *   ptraceScope?: string,
 *   groups?: string[],
 *   groupFile?: string,
 *   dbPath?: string,
 *   selinux?: string,
 *   pluginDir?: string,
 *   euid?: number,
 *   repoRoot?: string,
 *   runDir?: string,
 *   containmentMode?: "pinned" | "detective" | "fail-closed",
 *   readContainment?: boolean,
 *   requirePinnedWrites?: boolean,
 *   planRequirePinnedWrites?: boolean,
 * }} [options]
 */
export function collectSecurityReport(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const euid =
    typeof options.euid === "number"
      ? options.euid
      : typeof process.geteuid === "function"
        ? process.geteuid()
        : typeof process.getuid === "function"
          ? process.getuid()
          : -1
  const configDir = resolve(options.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode"))
  const ptraceScope =
    options.ptraceScope ?? (platform === "linux" ? readText("/proc/sys/kernel/yama/ptrace_scope") : undefined)
  const groups = options.groups ?? (options.groupFile ? [] : currentGroups())
  const groupFile = options.groupFile ?? "/etc/group"
  const groupInfo = normalizeGroupNames(groups, groupFile)
  const groupNames = groupInfo.names
  const dbSpec = options.dbPath ? { memory: false, candidates: [options.dbPath] } : dbCandidatesFor(env)
  const selinux = options.selinux ?? (platform === "linux" ? readText("/sys/fs/selinux/enforce") : undefined)
  const checks = []
  const warnings = []

  const key = keySource(env)
  checks.push(
    key.configured
      ? pass("key_source", `${key.source}; alg ${key.alg}; ${key.message}`)
      : warn("key_source", "no signing key or signer is configured"),
  )

  checks.push(signerCheck(env, euid))

  const witness = String(env.OPENCODE_TEAMWORK_WITNESS || "").trim()
  if (!witness) {
    checks.push(pass("witness", "no witness configured (detection-only local index)"))
  } else if (witness.startsWith("command:/") || witness.startsWith("http://") || witness.startsWith("https://")) {
    checks.push(pass("witness", `witness ${witness}; receipts are stored per artifact`))
  } else {
    checks.push(warn("witness", "OPENCODE_TEAMWORK_WITNESS must be command:<absolute path> or http(s)://<url>"))
  }

  if (platform !== "linux") {
    checks.push(unknown("ptrace_scope", `ptrace_scope is not inspectable on ${platform}; same-UID memory isolation is unknown`))
  } else if (ptraceScope === "0") {
    checks.push(
      fail(
        "ptrace_scope",
        "ptrace_scope=0: a same-UID process can read this process's memory/environment, including in-memory keys",
      ),
    )
  } else if (ptraceScope === undefined) {
    checks.push(unknown("ptrace_scope", "ptrace_scope is unavailable; same-UID memory isolation is unknown"))
  } else {
    checks.push(pass("ptrace_scope", `ptrace_scope=${ptraceScope}`))
  }

  const rootGroups = groupNames.filter((name) => ROOT_EQUIVALENT_GROUPS.includes(name))
  if (rootGroups.length > 0) {
    checks.push(
      fail(
        "privileged_groups",
        `member of root-equivalent group(s): ${rootGroups.join(", ")}; group access can read/write keys, containers or disks`,
      ),
    )
  } else if (platform !== "linux") {
    checks.push(unknown("privileged_groups", `group membership is not inspected on ${platform}`))
  } else if (!groupInfo.readable) {
    checks.push(
      unknown(
        "privileged_groups",
        `group file ${groupFile} is unreadable; root-equivalent membership cannot be verified`,
      ),
    )
  } else {
    checks.push(pass("privileged_groups", "no root-equivalent group membership detected"))
  }

  checks.push(dbCheck(dbSpec))
  checks.push(writeCheck("config_writable", configDir, "config dir"))
  checks.push(writeCheck("plugin_writable", options.pluginDir ?? pluginRoot(), "plugin dir"))
  checks.push(approvalKeyCheck(env, euid))
  checks.push(attestationKeyCheck(env, euid, options.runDir))
  checks.push(approvalScopeCheck(env))
  checks.push(approvalDirCheck(env, euid, options.repoRoot, options.runDir))
  checks.push(signerApprovalDirCheck(env, euid, options.repoRoot, options.runDir))
  // A5: unacknowledged write anomalies are a security event, not a warning.
  // The durable audit lives under the config dir (never the run), so doctor is
  // not blocked by the write policy that refused the artifact.
  const pendingAnomalies = unacknowledgedWriteAnomalies(options.runDir, {
    auditPath: join(configDir, "teamwork", "write-anomalies.jsonl"),
    env,
  })
  const incidents = listContainmentIncidents(options.runDir, {
    incidentDir: join(configDir, "teamwork", "incidents"),
    env,
  })
  if (pendingAnomalies.length > 0) {
    checks.push(
      fail(
        "write_anomalies",
        `${pendingAnomalies.length} unacknowledged write anomaly(ies) (${incidents.length} incident manifest(s)): ${pendingAnomalies
          .slice(-5)
          .map((entry) => `${entry.kind}${entry.run ? ` (${String(entry.run).split(/[\\/]/).pop()})` : ""}`)
          .join(", ")}; runs with one report needs-inspection and final_verify refuses them`,
      ),
    )
  } else {
    checks.push(pass("write_anomalies", "no unacknowledged write anomalies recorded"))
  }
  checks.push(
    containmentCheck(
      options,
      !!String(env[APPROVAL_DIR_ENV] || "").trim() ||
        !!String(env[SIGNER_APPROVAL_DIR_ENV] || "").trim() ||
        !!witness,
    ),
  )

  if (selinux === "1") checks.push(pass("selinux", "SELinux enforcing"))
  else if (selinux === "0") checks.push(warn("selinux", "SELinux permissive"))
  else checks.push(pass("selinux", platform === "linux" ? "SELinux not present or disabled" : "SELinux not applicable"))

  try {
    if (euid === 0) {
      checks.push(warn("uid", "running as root: every artifact key and gate is trivially writable"))
    }
  } catch {}

  for (const check of checks) {
    if (check.status === "warn") warnings.push(`${check.name}: ${check.message}`)
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    warnings,
    failures: checks.filter((check) => check.status === "fail"),
    unknowns: checks.filter((check) => check.status === "unknown"),
    key: { source: key.source, alg: key.alg },
    signer: String(env.OPENCODE_TEAMWORK_SIGNER || "").trim() || null,
    witness: witness || null,
  }
}

/**
 * Exit code for `doctor --security --require-hardened`: 2 when any posture
 * check is `fail` or `unknown`, otherwise 0. Nothing is "hardened" by default.
 */
export function hardenedExitCode(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  return checks.some((check) => check.status === "fail" || check.status === "unknown") ? 2 : 0
}

export const SECURITY_CHECK_NAMES = [
  "key_source",
  "signer",
  "witness",
  "ptrace_scope",
  "privileged_groups",
  "db_mode",
  "config_writable",
  "plugin_writable",
  "approval_key",
  "attestation_key",
  "approval_signer_scope",
  "approval_dir",
  "signer_approval_dir",
  "write_anomalies",
  "containment",
  "selinux",
]
