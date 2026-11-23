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
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { fdTraversalMode, supportsFdContainment } from "../plugins/opencode-teamwork/safe-fs.mjs"

const ROOT_EQUIVALENT_GROUPS = ["root", "wheel", "sudo", "docker", "libvirt", "lxd", "disk", "adm"]
const APPROVAL_DIR_ENV = "OPENCODE_TEAMWORK_APPROVAL_DIR"

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
  } catch {}
  for (const g of groups) {
    const id = typeof g === "number" ? String(g) : String(g)
    const name = byGid.get(id) ?? (typeof g === "string" ? g : undefined)
    if (name) names.add(name)
  }
  return [...names]
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

function dbPathFor(env) {
  const base = env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(homedir(), ".local", "share")
  return join(base, "opencode", "opencode.db")
}

/** `opencode.db` plus its WAL/SHM siblings; any group/other bit is a fail. */
function dbCheck(file) {
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
  if (seen.length === 0) return pass("db_mode", `${file} does not exist yet`)
  return pass("db_mode", seen.join("; "))
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

function approvalKeyCheck(env) {
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
  if (!publicKey) {
    return warn(
      "approval_key",
      `an approver private key is configured${keyId ? ` (id ${keyId})` : ""} but OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY is missing; the plugin cannot verify approvals`,
    )
  }
  const sources = [privateKey ? "inline private" : "", keyFile ? "key file" : ""].filter(Boolean)
  return pass(
    "approval_key",
    `verify-only Ed25519 approval key configured${keyId ? ` (id ${keyId})` : " (id derived from the public key)"}${sources.length ? `; signer material: ${sources.join(", ")}` : ""}`,
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

function containmentCheck(options, trustClaim) {
  const mode = options.containmentMode ?? fdTraversalMode()
  const readSupport = options.readContainment ?? supportsFdContainment()
  const detail = `fdTraversalMode=${mode}; fd containment ${readSupport ? "enforced" : "unavailable"}`
  if (mode === "pinned") return pass("containment", `pinned write containment (${detail})`)
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
  const groupNames = normalizeGroupNames(groups, options.groupFile ?? "/etc/group")
  const dbPath = options.dbPath ?? dbPathFor(env)
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
  } else {
    checks.push(pass("privileged_groups", "no root-equivalent group membership detected"))
  }

  checks.push(dbCheck(dbPath))
  checks.push(writeCheck("config_writable", configDir, "config dir"))
  checks.push(writeCheck("plugin_writable", options.pluginDir ?? pluginRoot(), "plugin dir"))
  checks.push(approvalKeyCheck(env))
  checks.push(approvalScopeCheck(env))
  checks.push(approvalDirCheck(env, euid, options.repoRoot, options.runDir))
  checks.push(containmentCheck(options, !!String(env[APPROVAL_DIR_ENV] || "").trim() || !!witness))

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
  "approval_signer_scope",
  "approval_dir",
  "containment",
  "selinux",
]
