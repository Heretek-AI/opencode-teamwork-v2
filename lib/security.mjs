// @heretek-ai/opencode-teamwork-v2 — local security posture diagnostics
//
// `opencode-teamwork doctor --security` reports the environment facts that
// bound what artifact authenticity can promise (ADR 0006/0008):
//
//   * which key source and algorithm signs artifacts;
//   * whether an external signer / witness is configured;
//   * kernel ptrace_scope;
//   * root-equivalent group membership (docker, wheel, libvirt, ...);
//   * the OpenCode DB mode (the artifact key/index store, when it exists);
//   * config/plugin writability (a same-UID writer can edit the gate);
//   * SELinux mode.
//
// It is read-only, dependency-free, and never treats a missing probe as a
// finding: unknown host facts are reported as unknown, not safe.
//
// The overridable probes are exported for hermetic tests; the defaults read the
// real host. No shell interpolation is used anywhere.

import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT_EQUIVALENT_GROUPS = ["root", "wheel", "sudo", "docker", "libvirt", "lxd", "disk", "adm"]

function pass(name, message) {
  return { name, status: "pass", message }
}
function warn(name, message) {
  return { name, status: "warn", message }
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

function dbCheck(file) {
  try {
    const st = statSync(file)
    const mode = st.mode & 0o777
    const exposed = mode & 0o077
    if (exposed !== 0) {
      return warn("db_mode", `${file} mode ${mode.toString(8)}; group/other bits are set (expected 0600)`)
    }
    return pass("db_mode", `${file} mode ${mode.toString(8)} owner uid ${st.uid}`)
  } catch (err) {
    if (err?.code === "ENOENT") return pass("db_mode", `${file} does not exist yet`)
    return warn("db_mode", `could not stat ${file} (${err?.code || "error"})`)
  }
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
 * }} [options]
 */
export function collectSecurityReport(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const configDir = resolve(options.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode"))
  const ptraceScope =
    options.ptraceScope ?? (platform === "linux" ? readText("/proc/sys/kernel/yama/ptrace_scope") : undefined)
  const groups =
    options.groups ?? (options.groupFile ? [] : currentGroups())
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

  const signer = String(env.OPENCODE_TEAMWORK_SIGNER || "").trim()
  if (signer) {
    checks.push(
      signer.startsWith("command:/") && env.OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY
        ? pass("signer", `external signer ${signer.slice("command:".length)} with a verification public key`)
        : warn("signer", "OPENCODE_TEAMWORK_SIGNER is set but malformed or missing OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY"),
    )
  } else {
    checks.push(pass("signer", "no external signer configured (local key source)"))
  }

  const witness = String(env.OPENCODE_TEAMWORK_WITNESS || "").trim()
  if (!witness) {
    checks.push(pass("witness", "no witness configured (detection-only local index)"))
  } else if (witness.startsWith("command:/") || witness.startsWith("http://") || witness.startsWith("https://")) {
    checks.push(pass("witness", `witness ${witness}; receipts are stored per artifact`))
  } else {
    checks.push(warn("witness", "OPENCODE_TEAMWORK_WITNESS must be command:<absolute path> or http(s)://<url>"))
  }

  if (ptraceScope === "0") {
    checks.push(
      warn(
        "ptrace_scope",
        "ptrace_scope=0: a same-UID process can read this process's memory/environment, including in-memory keys",
      ),
    )
  } else if (ptraceScope === undefined) {
    checks.push(warn("ptrace_scope", "ptrace_scope is unavailable; same-UID memory isolation is unknown"))
  } else {
    checks.push(pass("ptrace_scope", `ptrace_scope=${ptraceScope}`))
  }

  const rootGroups = groupNames.filter((name) => ROOT_EQUIVALENT_GROUPS.includes(name))
  if (rootGroups.length > 0) {
    checks.push(
      warn(
        "privileged_groups",
        `member of root-equivalent group(s): ${rootGroups.join(", ")}; group access can read/write keys, containers or disks`,
      ),
    )
  } else {
    checks.push(pass("privileged_groups", "no root-equivalent group membership detected"))
  }

  checks.push(dbCheck(dbPath))
  checks.push(writeCheck("config_writable", configDir, "config dir"))
  checks.push(writeCheck("plugin_writable", options.pluginDir ?? pluginRoot(), "plugin dir"))

  if (selinux === "1") checks.push(pass("selinux", "SELinux enforcing"))
  else if (selinux === "0") checks.push(warn("selinux", "SELinux permissive"))
  else checks.push(pass("selinux", platform === "linux" ? "SELinux not present or disabled" : "SELinux not applicable"))

  try {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
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
    key: { source: key.source, alg: key.alg },
    signer: signer || null,
    witness: witness || null,
  }
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
  "selinux",
]
