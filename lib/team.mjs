// @heretek-ai/opencode-teamwork-v2 — installer library
//
// Dependency-free helpers shared by the `opencode-teamwork` CLI and the
// postinstall hook. Responsible for:
//   * locating the OpenCode config directory
//   * reading/writing the team model map (~/.config/opencode/teamwork.json)
//   * installing the 15 `team/*` agent markdown files with the chosen models
//   * registering the plugin in opencode.json(c)
//
// Nothing here imports OpenCode APIs, so it is safe to run under plain Node,
// Bun, npm, or the OpenCode plugin loader.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_NAME = "@heretek-ai/opencode-teamwork-v2"

// Package root, i.e. the directory containing package.json / agents/ / lib/.
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url))

export const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version
  } catch {
    return "0.0.0"
  }
})()

/**
 * The 15 agents shipped by the package. `id` matches the OpenCode agent name
 * (`team/<file>`), `defaultModel` matches the frontmatter in `agents/team/*.md`.
 */
export const TEAM_AGENTS = [
  { id: "team/crafter", file: "crafter.md", role: "Phase-1 prompt crafter (elicitation wizard)", defaultModel: "deepseek/deepseek-flash" },
  { id: "team/sentinel", file: "sentinel.md", role: "Main dispatcher for /teamwork", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/orchestrator", file: "orchestrator.md", role: "Legacy v1 loop coordinator", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/scout", file: "scout.md", role: "Read-only context gatherer", defaultModel: "deepseek/deepseek-flash" },
  { id: "team/worker", file: "worker.md", role: "Implementation worker", defaultModel: "deepseek/deepseek-flash" },
  { id: "team/proof-worker", file: "proof-worker.md", role: "Formal-proof worker", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/formalization-reviewer", file: "formalization-reviewer.md", role: "Read-only Lean 4 formalization faithfulness reviewer", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/proposer", file: "proposer.md", role: "Candidate generator", defaultModel: "deepseek/deepseek-flash" },
  { id: "team/falsifier", file: "falsifier.md", role: "Adversarial critic", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/synthesizer", file: "synthesizer.md", role: "Candidate merger", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/verifier", file: "verifier.md", role: "Verification forcing function", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/security-auditor", file: "security-auditor.md", role: "Read-only security auditor", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/segment-reviewer", file: "segment-reviewer.md", role: "Read-only document segment reviewer", defaultModel: "deepseek/deepseek-flash" },
  { id: "team/referee", file: "referee.md", role: "Read-only math/proof tournament referee", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "team/victory-auditor", file: "victory-auditor.md", role: "Independent final acceptance auditor", defaultModel: "deepseek/deepseek-v4-pro" },
]

export const DEFAULT_MODELS = Object.fromEntries(TEAM_AGENTS.map((a) => [a.id, a.defaultModel]))

/** Resolve the OpenCode config directory. */
export function resolveConfigDir(override) {
  if (override) return override
  if (process.env.OPENCODE_TEAMWORK_CONFIG) return process.env.OPENCODE_TEAMWORK_CONFIG
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode")
}

/** Replace (or insert) the `model:` frontmatter line in an agent markdown file. */
export function applyModel(content, model) {
  if (!model) return content
  if (/^model:.*$/m.test(content)) return content.replace(/^model:.*$/m, `model: ${model}`)
  // No model line yet: insert one right after the opening frontmatter fence.
  if (/^---\r?\n/.test(content)) return content.replace(/^(---\r?\n)/, `$1model: ${model}\n`)
  return `---\nmodel: ${model}\n---\n\n${content}`
}

function modelFromText(content) {
  const m = content.match(/^model:\s*(.+?)\s*$/m)
  return m ? m[1] : undefined
}

/** Read the `model:` value out of an existing agent markdown file, if any. */
export function readModelFromFile(file) {
  try {
    return modelFromText(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

export function modelMapPath(configDir) {
  return join(configDir, "teamwork.json")
}

/** Read only raw models from teamwork.json without defaults fallback. */
export function readRawModelMap(configDir) {
  try {
    const data = JSON.parse(readFileSync(modelMapPath(configDir), "utf8"))
    if (data && typeof data.models === "object" && data.models) {
      return data.models
    }
  } catch {
    /* no map yet */
  }
  return {}
}

/** Load the persisted model map, merged over the shipped defaults. */
export function readModelMap(configDir) {
  const raw = readRawModelMap(configDir)
  return { ...DEFAULT_MODELS, ...raw }
}

/** Persist the model map next to the agents so re-runs and the plugin can read it. */
export function writeModelMap(configDir, models) {
  mkdirSync(configDir, { recursive: true })
  const payload = {
    $comment: "Generated by @heretek-ai/opencode-teamwork-v2. Maps each team agent to its model. Edit and re-run `opencode-teamwork init` (or `opencode reload`).",
    version: PACKAGE_VERSION,
    models,
  }
  writeFileSync(modelMapPath(configDir), JSON.stringify(payload, null, 2) + "\n")
  return modelMapPath(configDir)
}

/**
 * Seed the current model map from whatever is already on disk:
 * defaults -> installed agent frontmatter -> teamwork.json (highest user priority).
 */
export function currentModels(configDir) {
  const merged = { ...DEFAULT_MODELS }
  for (const agent of TEAM_AGENTS) {
    const fromFile = readModelFromFile(join(configDir, "agents", "team", agent.file))
    if (fromFile) merged[agent.id] = fromFile
  }
  const rawStored = readRawModelMap(configDir)
  for (const [k, v] of Object.entries(rawStored)) {
    if (v) merged[k] = v
  }
  return merged
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
}

// --- no-follow, race-free file primitives --------------------------------
//
// Every write below either creates the target with O_CREAT|O_EXCL (which fails
// with EEXIST on a symlink instead of following it) or writes a sibling temp
// file opened the same way and renames it over the target (rename never follows
// a symlink). Check-then-use on the target path is therefore gone: the only
// pre-write `lstat` is used to copy the mode and to refuse a symlink, and the
// actual replacement is atomic.

const TMP_RETRIES = 5

function symlinkRefusal(target) {
  const err = new Error(`refusing to write ${target}: target is a symlink`)
  err.code = "ELOOP"
  return err
}

function lstatOrNull(target) {
  try {
    return lstatSync(target)
  } catch (err) {
    if (err && err.code === "ENOENT") return null
    throw err
  }
}

/** Read a regular file without following a final-component symlink. */
function readRegularFile(file) {
  const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      const err = new Error(`${file} is not a regular file`)
      err.code = "EISDIR"
      throw err
    }
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}

/** Read a target if it is a regular file: { status: ok|absent|symlink, text? }. */
function readTarget(target) {
  try {
    return { status: "ok", text: readRegularFile(target) }
  } catch (err) {
    if (err && err.code === "ENOENT") return { status: "absent" }
    if (err && (err.code === "ELOOP" || err.code === "EMLINK")) return { status: "symlink" }
    throw err
  }
}

/**
 * Create `target` only if it does not exist. Throws EEXIST (a symlink also
 * yields EEXIST, so it is never followed). Used where the old code did
 * `existsSync` + `writeFileSync`; callers treat EEXIST as "already present".
 */
function writeFileExclusive(target, data) {
  const fd = openSync(target, "wx", 0o666)
  let ok = false
  try {
    writeFileSync(fd, data)
    ok = true
  } finally {
    closeSync(fd)
    if (!ok) {
      try {
        unlinkSync(target)
      } catch {}
    }
  }
}

/**
 * Atomically replace `target` with `data`: write a uniquely named sibling temp
 * file with O_CREAT|O_EXCL (never follows a symlink), preserve the old file
 * mode when the target already existed, then rename the temp over the target.
 * A symlinked target is refused instead of being followed.
 */
function writeFileAtomic(target, data) {
  const before = lstatOrNull(target)
  if (before && before.isSymbolicLink()) throw symlinkRefusal(target)
  if (before && !before.isFile()) {
    const err = new Error(`refusing to write ${target}: target is not a regular file`)
    err.code = "EISDIR"
    throw err
  }

  let fd = null
  let tmp = null
  for (let attempt = 0; attempt < TMP_RETRIES && fd === null; attempt++) {
    const candidate = `${target}.${randomBytes(8).toString("hex")}.tmp`
    try {
      fd = openSync(candidate, "wx", 0o666)
      tmp = candidate
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err
    }
  }
  if (fd === null) {
    const err = new Error(`could not create a temporary file for ${target}`)
    err.code = "EEXIST"
    throw err
  }

  try {
    // Preserve the existing target's permission bits (mode of a brand new file
    // still respects the process umask, like writeFileSync did).
    if (before) fchmodSync(fd, before.mode & 0o7777)
    writeFileSync(fd, data)
    closeSync(fd)
    fd = null
    renameSync(tmp, target)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * Install (or update) the agent markdown files into the config dir.
 *
 * Existing files are never overwritten wholesale — only their `model:` line is
 * rewritten — so any local edits the user made are preserved. A one-time backup
 * of every touched file is written under `<configDir>/.opencode-teamwork-backup`.
 */
export function installAgents({ configDir, models = {}, packageRoot = PACKAGE_ROOT, dryRun = false, refresh = false }) {
  const targetDir = join(configDir, "agents", "team")
  const sourceDir = join(packageRoot, "agents", "team")
  const result = { created: [], updated: [], unchanged: [], missing: [], skipped: [], backupDir: undefined }

  if (!existsSync(sourceDir)) {
    result.missing.push(sourceDir)
    return result
  }

  if (!dryRun) mkdirSync(targetDir, { recursive: true })

  const backupRoot = join(configDir, ".opencode-teamwork-backup", timestamp())

  for (const agent of TEAM_AGENTS) {
    const source = join(sourceDir, agent.file)
    let sourceText
    try {
      sourceText = readFileSync(source, "utf8")
    } catch (err) {
      if (err && err.code === "ENOENT") {
        result.missing.push(agent.file)
        continue
      }
      throw err
    }
    const target = join(targetDir, agent.file)
    const fallbackModel = models[agent.id] || agent.defaultModel

    // Create-only path: O_CREAT|O_EXCL, so an existing file or symlink wins and
    // is never followed. A dry run reports the same outcome without writing.
    if (!dryRun) {
      try {
        writeFileExclusive(target, applyModel(sourceText, fallbackModel))
        result.created.push(agent.file)
        continue
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err
      }
    }

    const snapshot = readTarget(target)
    if (snapshot.status === "symlink") {
      // Never follow or replace a symlinked target.
      result.skipped.push(agent.file)
      continue
    }
    if (snapshot.status === "absent") {
      if (dryRun) {
        result.created.push(agent.file)
        continue
      }
      // The target disappeared between the exclusive write and this read.
      const err = new Error(`lost a race while installing ${target}`)
      err.code = "ENOENT"
      throw err
    }

    // Prefer an explicit override, then the model already installed, then the
    // shipped default — so a refresh never resets the user's chosen model.
    const existing = snapshot.text
    const model = models[agent.id] || modelFromText(existing) || agent.defaultModel
    // refresh=true (opt-in via --refresh): adopt the shipped prompt
    // body while keeping the user's chosen model line. Default is false so an
    // npm install / plugin load never clobbers local edits. Backup on change.
    const base = refresh ? sourceText : existing
    const next = applyModel(base, model)
    if (next === existing) {
      result.unchanged.push(agent.file)
      continue
    }
    if (!dryRun) {
      try {
        mkdirSync(backupRoot, { recursive: true })
        copyFileSync(target, join(backupRoot, agent.file))
        result.backupDir = backupRoot
        writeFileAtomic(target, next)
      } catch (err) {
        if (err && (err.code === "ELOOP" || err.code === "EMLINK")) {
          result.skipped.push(agent.file)
          continue
        }
        throw err
      }
    }
    result.updated.push(agent.file)
  }

  if (!dryRun) writeReferenceFile({ configDir, packageRoot })

  return result
}

/**
 * Copy the artifacts reference (docs/ARTIFACTS.md) next to the agents so the
 * installed prompts can point at it. Best-effort.
 */
export function writeReferenceFile({ configDir, packageRoot = PACKAGE_ROOT, dryRun = false, overwrite = true } = {}) {
  const src = join(packageRoot, "docs", "ARTIFACTS.md")
  if (!existsSync(src)) return false
  const dest = join(configDir, "teamwork", "ARTIFACTS.md")

  if (!dryRun) {
    try {
      mkdirSync(join(configDir, "teamwork"), { recursive: true })
      if (overwrite) {
        writeFileAtomic(dest, readFileSync(src, "utf8"))
      } else {
        try {
          writeFileExclusive(dest, readFileSync(src, "utf8"))
        } catch (err) {
          // EEXIST (including a symlinked dest) means "already present": keep it.
          if (!err || err.code !== "EEXIST") throw err
        }
      }
    } catch (err) {
      if (err && (err.code === "ELOOP" || err.code === "EMLINK")) return false
      throw err
    }
  }
  return true
}

/**
 * Best-effort, non-interactive install used by the plugin loader: creates only
 * the agent files that are completely missing and leaves every existing file
 * untouched (so a user's `init` choices are never clobbered). Returns the list
 * of created agent files, which is empty when nothing needed doing.
 */
export function ensureAgents({ configDir = resolveConfigDir(), packageRoot = PACKAGE_ROOT, models } = {}) {
  const targetDir = join(configDir, "agents", "team")
  const sourceDir = join(packageRoot, "agents", "team")
  const map = models || readModelMap(configDir)
  const created = []

  for (const agent of TEAM_AGENTS) {
    const target = join(targetDir, agent.file)
    // Any existing entry (regular file or symlink) is left untouched; the write
    // below is O_CREAT|O_EXCL, so a symlink can never be followed or replaced.
    if (lstatOrNull(target)) continue
    const source = join(sourceDir, agent.file)
    let body
    try {
      body = readFileSync(source, "utf8")
    } catch (err) {
      if (err && err.code === "ENOENT") continue
      throw err
    }
    mkdirSync(targetDir, { recursive: true })
    try {
      writeFileExclusive(target, applyModel(body, map[agent.id] || agent.defaultModel))
    } catch (err) {
      // Lost a create race (or a symlink appeared): the file is already there.
      if (!err || err.code !== "EEXIST") throw err
      continue
    }
    created.push(agent.file)
  }

  try { writeReferenceFile({ configDir, packageRoot, overwrite: false }) } catch {}
  return created
}

// --- opencode.json(c) registration -----------------------------------------

/**
 * Strip // and block comments plus trailing commas, fully string-aware.
 * (The previous trailing-comma pass used a regex that corrupted string values
 * containing `, }` / `, ]`.)
 */
export function stripJsonComments(input) {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const n = input[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && n === "/") {
      inLine = true
      i++
    } else if (c === "/" && n === "*") {
      inBlock = true
      i++
    } else {
      out += c
    }
  }
  // Remove trailing commas before } or ], string-aware.
  let res = ""
  inString = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inString) {
      res += c
      if (c === "\\") {
        res += out[i + 1] ?? ""
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      res += c
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === "}" || out[j] === "]") continue
    }
    res += c
  }
  return res
}

/** True if the raw text contains a comment token outside of a string. */
export function hasJsonComments(raw) {
  let inString = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const n = raw[i + 1]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "/" && (n === "/" || n === "*")) return true
  }
  return false
}

function isTeamworkEntry(entry) {
  const value = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.package : undefined
  if (typeof value !== "string" || value.trim() === "") return false
  // The npm name, this repo's directory, and a hand-vendored directory named
  // `teamwork` all count as "already registered"; init must not add the npm
  // name beside a vendored copy.
  if (value.includes("opencode-teamwork")) return true
  return basename(value.replace(/[\\/]+$/, "")) === "teamwork"
}

/** Read a project-scoped opencode.json(c), if any, and look for a teamwork entry. */
function projectConfigHasTeamwork(cwd) {
  if (!cwd) return undefined
  for (const rel of [".opencode/opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.json5", "opencode.jsonc", "opencode.json", "opencode.json5"]) {
    const file = join(cwd, rel)
    if (!existsSync(file)) continue
    try {
      const data = JSON.parse(stripJsonComments(readFileSync(file, "utf8")))
      const entries = Array.isArray(data.plugins) ? data.plugins : []
      const found = entries.find(isTeamworkEntry)
      if (found !== undefined) return { file, entry: found }
    } catch {}
  }
  return undefined
}

/**
 * Check that every shipped agent exists in the config dir. Read-only: the
 * plugin loader calls this after the config agent plugin has already loaded
 * its documents, so writing here would be invisible until a restart.
 */
export function verifyAgents({ configDir = resolveConfigDir() } = {}) {
  const targetDir = join(configDir, "agents", "team")
  const missing = TEAM_AGENTS.filter((agent) => !lstatOrNull(join(targetDir, agent.file))).map((agent) => agent.file)
  return { configDir, targetDir, missing }
}

/** Find the active opencode.json(c) in a config dir. */
export function findConfigFile(configDir) {
  for (const name of ["opencode.jsonc", "opencode.json", "opencode.json5"]) {
    const file = join(configDir, name)
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * Add `@heretek-ai/opencode-teamwork-v2` to the `plugins` array in opencode.json(c), unless
 * some existing entry already points at an opencode-teamwork plugin.
 */
export function registerPlugin({ configDir, packageName = PACKAGE_NAME, dryRun = false, cwd = process.cwd() }) {
  // A vendored plugin is typically registered in the project's own config.
  // Adding the npm name to the global config beside it would load two copies.
  const vendored = projectConfigHasTeamwork(cwd)
  if (vendored) return { status: "vendored", file: vendored.file, entry: vendored.entry }

  const file = findConfigFile(configDir) || join(configDir, "opencode.json")

  // Never follow a symlinked config, and never rewrite a commented (JSONC)
  // config — JSON.stringify would drop comments and (previously) corrupt values.
  // The read is O_NOFOLLOW, so the check and the read are the same operation.
  let exists = true
  let raw
  try {
    raw = readRegularFile(file)
  } catch (err) {
    if (err && err.code === "ENOENT") {
      exists = false
      raw = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
    } else if (err && (err.code === "ELOOP" || err.code === "EMLINK")) {
      return { status: "symlink", file }
    } else {
      throw err
    }
  }

  if (exists && hasJsonComments(raw)) {
    return { status: /opencode-teamwork/.test(raw) ? "already" : "commented", file }
  }

  let data
  try {
    data = JSON.parse(stripJsonComments(raw))
  } catch (error) {
    return { status: "unparsed", file, error }
  }

  data.plugins = Array.isArray(data.plugins) ? data.plugins : []
  const existing = data.plugins.find(isTeamworkEntry)
  if (existing !== undefined) return { status: "already", file, entry: existing }

  data.plugins.push(packageName)
  if (!dryRun) {
    try {
      mkdirSync(configDir, { recursive: true })
      if (exists) copyFileSync(file, `${file}.bak.${timestamp()}`)
      writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n")
    } catch (err) {
      // A config swapped for a symlink after the read must not be followed.
      if (err && (err.code === "ELOOP" || err.code === "EMLINK")) return { status: "symlink", file }
      throw err
    }
  }
  return { status: "added", file, entry: packageName }
}
