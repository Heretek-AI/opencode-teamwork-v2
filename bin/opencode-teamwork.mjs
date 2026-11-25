#!/usr/bin/env node
// @heretek-ai/opencode-teamwork-v2 — installer CLI
//
//   opencode-teamwork init      pick models + install agents + register plugin
//   opencode-teamwork models    pick models + reinstall agents (no config edit)
//   opencode-teamwork install   non-interactive install using defaults/flags
//   opencode-teamwork status    show what is currently configured
//   opencode-teamwork help

import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync, constants as fsConstants } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  PACKAGE_NAME,
  TEAM_AGENTS,
  resolveConfigDir,
  readModelMap,
  readRawModelMap,
  writeModelMap,
  installAgents,
  registerPlugin,
  currentModels,
  findConfigFile,
  stripJsonComments,
  modelMapPath,
} from "../lib/team.mjs"
import { detectAvailableModels, pickModels, applyOverrides } from "../lib/picker.mjs"
import { listTeamworkRuns, inspectTeamworkRun, pruneTeamworkWorktrees } from "../lib/runs.mjs"
import { runDoctor, nextSteps } from "../lib/doctor.mjs"
import { inventoryLocks, unlockLock, formatLocksReport } from "../lib/locks-doctor.mjs"
import { collectSecurityReport, hardenedExitCode } from "../lib/security.mjs"
import { buildTimeline, renderTimeline, timelineWarnings } from "../lib/timeline.mjs"
import { buildExportData, renderExport } from "../lib/export.mjs"
import { verifyRun, renderVerify, verifyExitCode, VerifyUsageError } from "../lib/verify.mjs"

// Echo a user-supplied value in an error message: control characters become "?"
// and the value is capped, so a hostile argv cannot inject escapes or bloat stderr.
function safeEcho(value, max = 64) {
  const shown = String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "?")
  return shown.length > max ? `${shown.slice(0, max)}...` : shown
}

const HELP = `@heretek-ai/opencode-teamwork-v2

Usage: opencode-teamwork <command> [options]

Commands:
  init       Pick a model for each team agent, install agents, register the plugin
  models     Same as init but never edits opencode.json
  install    Non-interactive install using defaults / flags
  status     Show config dir, model map, installed agents and plugin state
  runs       List active and past Teamwork runs in .opencode/teamwork/
  inspect    Inspect DAG, task progress, security report and costs for a run
  timeline   Show per-task lifecycle timing, rounds, and cost for a run (--json for raw data)
  export     Render a run as an offline HTML report (default) or Markdown (-m)
  verify     Verify a run offline from bytes and a public key. Exit codes:
               0 verified, 1 fail, 2 unverifiable, 3 usage.
               verify --session <id> --public-key <b64url|@file>
                      [--key-id <id>] [--repo <path>] [--require-git]
                      [--require-index <snapshot>] [--allow-unsigned]
                      [--fail-on-warning] [--json]
               verify --run-dir <path> ...
               verify --session <id> --hmac-key <b64url> --hmac-key-id <id>
                      [--rerun --repo <clean-checkout> [--timeout <s>] [--keep-worktree]]
                      [--json]
  prune      Prune git worktrees for completed Teamwork runs
  doctor     Diagnose config, agents, model sync and git/worktree health
             (--security adds key source, signer/witness, ptrace, groups, DB,
             approval dir and containment; --require-hardened exits 2 on
             any fail/unknown security check)
  approve    Produce/verify an authenticated prompt approval:
               approve request --session <runId> [--json]
               approve sign --request <file|-> --draft <path> [--key <path>]
                            [--ttl 24h] [--approver uid:<name>|oidc:...|ci:...]
               approve verify --session <runId> [--json]
             Produce a signer approval for signer protocol v2:
               approve signer --session <runId> --path <relPath> --digest <64hex>
                              [--key <path>] [--ttl 1h] [--approver ...] [--out <dir>]
  help       Show this help

Options:
  -y, --yes              Accept current/default models without prompting
      --all <model>      Use one model for every agent (e.g. anthropic/claude-sonnet-4-5)
      --model <id>=<m>   Override one agent (repeatable), id may omit the "team/" prefix
      --session <id>     Target a specific session ID (for inspect, prune, export or verify)
      --json             Print doctor, timeline or verify output as raw JSON
      --run-dir <path>   Verify this run directory directly (instead of --session)
      --public-key <k>   Ed25519 verify key: base64url SPKI or @file
      --key-id <id>      Expected Ed25519 key id (defaults to the signed run key)
      --hmac-key <k>     HMAC-SHA256 secret (base64url, 32 bytes) for verify
      --hmac-key-id <id> Expected HMAC key id
      --repo <path>      Repository for optional branch head/diff checks, and the clean checkout for --rerun
      --rerun            Re-execute verify/rerun.json commands in a disposable worktree (exit 2 = unverifiable)
      --timeout <s>      Cap each re-executed command's recorded timeout
      --require-git      Fail as UNKNOWN when git/branch data is unavailable
      --require-index <snapshot>
                         Detect a whole-run rollback against a file snapshot
      --allow-unsigned   Analyse an unsigned legacy run (never upgrades to PASS)
      --fail-on-warning  Promote a warning to a failing exit code
      --witness-public-key <k>  Optional Ed25519 witness key for a receipt
      --witness-key-id <id>     Expected witness key id
      --witness-receipt <path>  Witness receipt JSON to verify
      --attestation-public-key <k>  Ed25519 CI attestation key (base64url SPKI or @file)
      --attestation-key-id <id>     Expected CI attestation key id
      --attestation-issuer <issuer> Expected CI OIDC issuer
      --force            With prune: remove a worktree even when a live/expired/
                         needs-inspection/cross-host claim still blocks it
      --reason <text>    Recorded reason for a forced prune
      --security         Add the artifact-trust security posture section
      --require-hardened With --security: exit 2 if any check is fail/unknown
      --html             Export as HTML (default for export)
  -m, --markdown         Export as Markdown (for export)
  -o, --output <file>    Export destination (for export); "-" streams to stdout
                         Default: .opencode/teamwork/<id>/report.html (or report.md)
      --no-color         Disable ANSI colours (for timeline)
      --no-register      Don't touch opencode.json(c)
      --refresh          Overwrite agent prompt bodies with the shipped versions
                         (keeps your model choices; backs up the old files)
      --config-dir <dir> Override the OpenCode config directory
      --dry-run          Print what would change without writing files
  -h, --help             Show this help
`

function parseArgs(argv) {
  const options = { command: undefined, yes: false, all: undefined, assignments: {}, register: true, dryRun: false, refresh: false, configDir: undefined, session: undefined, json: false, noColor: false, help: false, markdown: false, output: undefined, security: false, requireHardened: false, runDir: undefined, publicKey: undefined, keyId: undefined, hmacKey: undefined, hmacKeyId: undefined, repo: undefined, requireIndex: undefined, requireGit: false, allowUnsigned: false, failOnWarning: false, witnessPublicKey: undefined, witnessKeyId: undefined, witnessReceipt: undefined, attestationPublicKey: undefined, attestationKeyId: undefined, attestationIssuer: undefined }
  const rest = [...argv]
  options.command = rest.shift()
  while (rest.length) {
    const arg = rest.shift()
    switch (arg) {
      case "-y":
      case "--yes":
        options.yes = true
        break
      case "--all":
        options.all = rest.shift() || true
        break
      case "--session":
        options.session = rest.shift()
        break
      case "--model": {
        const pair = rest.shift() || ""
        const eq = pair.indexOf("=")
        if (eq > 0) options.assignments[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
        else console.warn(`Ignoring malformed --model "${pair}" (expected id=provider/model)`)
        break
      }
      case "--no-register":
        options.register = false
        break
      case "--config-dir":
        options.configDir = rest.shift()
        break
      case "--dry-run":
        options.dryRun = true
        break
      case "--refresh":
        options.refresh = true
        break
      case "--json":
        options.json = true
        break
      case "--no-color":
        options.noColor = true
        break
      case "--force":
        options.force = true
        break
      case "--reason":
        options.reason = rest.shift() ?? ""
        break
      case "--security":
        options.security = true
        break
      case "--locks":
        options.locks = true
        break
      case "--unlock":
        options.unlock = rest.shift() ?? ""
        break
      case "--confirm":
        options.confirm = true
        break
      case "--require-hardened":
        options.security = true
        options.requireHardened = true
        break
      case "--run-dir":
        options.runDir = rest.shift() ?? ""
        break
      case "--public-key":
        options.publicKey = rest.shift() ?? ""
        break
      case "--key-id":
        options.keyId = rest.shift() ?? ""
        break
      case "--hmac-key":
        options.hmacKey = rest.shift() ?? ""
        break
      case "--hmac-key-id":
        options.hmacKeyId = rest.shift() ?? ""
        break
      case "--repo":
        options.repo = rest.shift() ?? ""
        break
      case "--require-index": {
        const next = rest[0]
        if (next !== undefined && !next.startsWith("-")) options.requireIndex = rest.shift()
        else options.requireIndex = true
        break
      }
      case "--require-git":
        options.requireGit = true
        break
      case "--allow-unsigned":
        options.allowUnsigned = true
        break
      case "--fail-on-warning":
        options.failOnWarning = true
        break
      case "--rerun":
        options.rerun = true
        break
      case "--timeout":
        options.timeout = rest.shift() ?? ""
        break
      case "--keep-worktree":
        options.keepWorktree = true
        break
      case "--witness-public-key":
        options.witnessPublicKey = rest.shift() ?? ""
        break
      case "--witness-key-id":
        options.witnessKeyId = rest.shift() ?? ""
        break
      case "--witness-receipt":
        options.witnessReceipt = rest.shift() ?? ""
        break
      case "--attestation-public-key":
        options.attestationPublicKey = rest.shift() ?? ""
        break
      case "--attestation-key-id":
        options.attestationKeyId = rest.shift() ?? ""
        break
      case "--attestation-issuer":
        options.attestationIssuer = rest.shift() ?? ""
        break
      case "--html":
        options.markdown = false
        break
      case "-m":
      case "--markdown":
        options.markdown = true
        break
      case "-o":
      case "--output":
        // "" (missing value) is rejected by exportCommand; "-" means stdout.
        options.output = rest.shift() ?? ""
        break
      case "-h":
      case "--help":
        options.help = true
        break
      default:
        if (arg && !options.session && (options.command === "inspect" || options.command === "prune" || options.command === "timeline" || options.command === "export") && !arg.startsWith("-")) {
          options.session = arg
        } else if (arg) {
          console.warn(`Ignoring unknown argument: ${arg}`)
        }
    }
  }
  return options
}

function isInteractive(options) {
  return !options.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
}

function printSummary(configDir, models, install, registration, { init = false } = {}) {
  const changed = install.created.length + install.updated.length
  console.log("")
  console.log(`Config dir : ${configDir}`)
  console.log(`Agents     : ${TEAM_AGENTS.length} (${install.created.length} created, ${install.updated.length} updated, ${install.unchanged.length} unchanged)`)
  if (install.backupDir) console.log(`Backups    : ${install.backupDir}`)
  if (install.missing.length) console.log(`Missing    : ${install.missing.join(", ")}`)
  if (registration) {
    if (registration.status === "added") console.log(`Plugin     : added "${registration.entry}" to ${registration.file}`)
    else if (registration.status === "already") console.log(`Plugin     : already configured (${registration.entry}) in ${registration.file}`)
    else if (registration.status === "commented")
      console.log(`Plugin     : ${registration.file} has comments — not rewriting it. Add "${PACKAGE_NAME}" to "plugins" manually.`)
    else if (registration.status === "symlink")
      console.log(`Plugin     : ${registration.file} is a symlink — refusing to rewrite it. Add "${PACKAGE_NAME}" to "plugins" manually.`)
    else if (registration.status === "unparsed") console.log(`Plugin     : could not parse ${registration.file} — add "${PACKAGE_NAME}" to "plugins" manually`)
  }
  console.log("\nModel assignment:")
  for (const agent of TEAM_AGENTS) console.log(`  ${agent.id.padEnd(20)} ${models[agent.id]}`)
  if (changed === 0 && !registration) console.log("\nNothing changed.")
  console.log("\nRestart OpenCode (or run `opencode reload`) to pick up the changes.")
  if (init) {
    console.log("\nNext steps:")
    console.log("  opencode-teamwork models")
    console.log("  /teamwork-craft  (in OpenCode)")
  }
}

async function run(options, { register, init = false }) {
  const configDir = resolveConfigDir(options.configDir)
  const current = currentModels(configDir)

  let models = current
  if (isInteractive(options)) {
    const available = await detectAvailableModels()
    models = await pickModels({ current, available })
  }
  models = applyOverrides(models, { all: options.all, assignments: options.assignments })

  if (!options.dryRun) writeModelMap(configDir, models)
  const install = installAgents({ configDir, models, dryRun: options.dryRun, refresh: options.refresh === true })
  const registration = register ? registerPlugin({ configDir, dryRun: options.dryRun }) : undefined

  printSummary(configDir, models, install, registration, { init })
}

function status(options) {
  const configDir = resolveConfigDir(options.configDir)
  const hasMap = existsSync(modelMapPath(configDir))
  const models = hasMap ? readRawModelMap(configDir) : {}
  const configFile = findConfigFile(configDir)
  console.log(`Config dir : ${configDir}`)
  console.log(`Config file: ${configFile || "(none — would create opencode.json)"}`)
  if (configFile) {
    try {
      const data = JSON.parse(stripJsonComments(readFileSync(configFile, "utf8")))
      const entries = Array.isArray(data.plugins) ? data.plugins.filter((p) => typeof p === "string" && p.includes("opencode-teamwork")) : []
      console.log(`Plugin     : ${entries.length ? entries.join(", ") : "not registered"}`)
    } catch {
      console.log("Plugin     : (config not parsed)")
    }
  }
  console.log("\nAgents:")
  for (const agent of TEAM_AGENTS) {
    const file = join(configDir, "agents", "team", agent.file)
    const present = existsSync(file)
    const model = present ? (readFileSync(file, "utf8").match(/^model:\s*(.+?)\s*$/m)?.[1] ?? "?") : "not installed"
    console.log(`  ${agent.id.padEnd(20)} ${present ? "ok " : "-- "} ${model}${models[agent.id] && models[agent.id] !== model && present ? `  (teamwork.json: ${models[agent.id]})` : ""}`)
  }
  console.log(`\nModel map  : ${modelMapPath(configDir)} (${existsSync(modelMapPath(configDir)) ? "present" : "not written"})`)
}

function runsCommand() {
  const runs = listTeamworkRuns(process.cwd())
  if (!runs.length) {
    console.log("No Teamwork runs found in .opencode/teamwork/")
    return
  }

  console.log(`Teamwork Runs (${runs.length}):\n`)
  console.log(
    "SESSION ID".padEnd(26) +
    "PHASE".padEnd(16) +
    "TOPOLOGY".padEnd(20) +
    "TASKS".padEnd(12) +
    "SECURITY".padEnd(14) +
    "AUTH".padEnd(10) +
    "COST ($)"
  )
  console.log("-".repeat(106))

  for (const r of runs) {
    const tasks = `${r.tasksPassed}/${r.tasksTotal}${r.tasksBlocked ? ` (${r.tasksBlocked} blk)` : ""}`
    const cost = `$${r.spentUsd} / $${r.budgetUsd}`
    console.log(
      r.sessionId.padEnd(26) +
      r.phase.padEnd(16) +
      r.topology.padEnd(20) +
      tasks.padEnd(12) +
      r.securityStatus.padEnd(14) +
      (r.authenticity || "unknown").padEnd(10) +
      cost
    )
  }
}

function inspectCommand(options) {
  const result = inspectTeamworkRun(process.cwd(), options.session)
  if (result.error) {
    console.error(result.error)
    process.exitCode = 1
    return
  }

  const { run, tasks, costs, audit, pitfalls, conflicts, authenticity, auditAuthenticity } = result
  console.log(`Teamwork Run: ${run.sessionId}`)
  console.log(`Topology    : ${run.topology}`)
  console.log(`Phase       : ${run.phase}`)
  console.log(`Authenticity: ${authenticity || "unknown"} (envelope presence only; the CLI cannot verify)`)
  console.log(`Audit auth  : ${auditAuthenticity || "unknown"} (envelope presence only; the CLI cannot verify)`)
  console.log(`Cost        : $${run.spentUsd} / $${run.budgetUsd} (source: ${costs?.budgetSource || "default"})`)
  console.log(`Updated At  : ${run.updatedAt}`)

  console.log(`\nTasks (${Object.keys(tasks).length}):`)
  for (const [id, t] of Object.entries(tasks)) {
    const round = t?.round ? `round ${t.round}` : "round 0"
    const branch = t?.branch ? `[${t.branch}]` : ""
    console.log(`  ${id.padEnd(20)} : ${String(t?.status || "pending").padEnd(16)} (${round}) ${branch}`)
    if (t?.summary) console.log(`    Summary : ${t.summary}`)
    if (t?.feedback) console.log(`    Feedback: ${t.feedback}`)
  }

  console.log(`\nSecurity Audit:`)
  if (!audit) {
    console.log(`  Not yet run (phase: ${run.phase})`)
  } else {
    console.log(`  Status  : ${audit.status}`)
    console.log(`  Summary : ${audit.summary || "No summary"}`)
    if (audit.severityCounts) {
      console.log(`  Findings: ${audit.severityCounts.critical || 0} Critical, ${audit.severityCounts.high || 0} High, ${audit.severityCounts.medium || 0} Medium, ${audit.severityCounts.low || 0} Low`)
    }
  }

  if (conflicts.length) {
    console.log(`\nMerge Conflicts (${conflicts.length}):`)
    for (const c of conflicts) {
      console.log(`  - Task ${c.taskId}: ${c.conflictingFiles?.join(", ") || "conflicts recorded"}`)
    }
  }

  if (pitfalls.length) {
    console.log(`\nPitfalls (${pitfalls.length}):`)
    for (const p of pitfalls.slice(-5)) {
      console.log(`  ${p}`)
    }
  }
}

function timelineCommand(options) {
  const runs = listTeamworkRuns(process.cwd())
  if (!runs.length) {
    console.error("No Teamwork runs found.")
    process.exitCode = 1
    return
  }
  const target = options.session ? runs.find((r) => r.sessionId === options.session) : runs[0]
  if (!target) {
    console.error(`Run "${safeEcho(options.session)}" not found.`)
    process.exitCode = 1
    return
  }

  const timeline = buildTimeline(process.cwd(), target.sessionId)
  if (options.json) {
    // JSON.stringify escapes C0 only; escape DEL and C1 (incl. 0x9b CSI) too so
    // no raw control byte from a run file can reach the terminal.
    const json = JSON.stringify(timeline, null, 2).replace(
      /[\x7f-\x9f]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    )
    console.log(json)
    for (const warning of timelineWarnings(timeline)) console.error(`warning: ${warning}`)
    return
  }

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !options.noColor
  for (const line of renderTimeline(timeline, { color })) console.log(line)
}

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

// Resolve a path through symlinks where it exists; otherwise fall back to resolve().
function realOrResolved(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function isWithin(child, parent) {
  const rel = relative(parent, child)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

// Validate an explicit -o target. Returns { path } or { error }.
// Allowed: inside the project root or the OS temp dir. Traversal segments are refused outright.
function resolveExportOutput(rawOutput, root) {
  if (rawOutput === "") return { error: "-o / --output requires a file path (use -o - for stdout)" }
  if (rawOutput.startsWith("-")) return { error: `Refusing output path "${safeEcho(rawOutput, 200)}": paths starting with "-" are not accepted (use -o - for stdout)` }
  if (rawOutput.split(/[\\/]/).includes("..")) return { error: `Refusing output path "${safeEcho(rawOutput, 200)}": traversal segments ("..") are not allowed` }
  const target = resolve(root, rawOutput)
  const parent = realOrResolved(dirname(target))
  const candidate = join(parent, basename(target))
  try {
    if (lstatSync(candidate).isSymbolicLink()) return { error: `Refusing output path "${safeEcho(rawOutput, 200)}": target is a symlink` }
  } catch {}
  const allowedRoots = [realOrResolved(root), realOrResolved(tmpdir())]
  if (!allowedRoots.some((base) => isWithin(candidate, base))) {
    return { error: `Refusing output path "${safeEcho(rawOutput, 200)}": must be inside the project root or the temp directory (${safeEcho(allowedRoots[0], 200)}, ${safeEcho(allowedRoots[1], 200)})` }
  }
  return { path: candidate }
}

function exportCommand(options) {
  const root = process.cwd()
  let sessionId = options.session
  if (sessionId === undefined) {
    const runs = listTeamworkRuns(root)
    if (!runs.length) {
      console.error("No Teamwork runs found in .opencode/teamwork/ (nothing to export)")
      process.exitCode = 1
      return
    }
    sessionId = runs[0].sessionId
  }
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    console.error(`Invalid session id "${safeEcho(sessionId)}": must match ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`)
    process.exitCode = 1
    return
  }

  const format = options.markdown ? "markdown" : "html"
  const data = buildExportData(root, sessionId)
  if (data.error) {
    console.error(data.error)
    process.exitCode = 1
    return
  }
  const doc = renderExport(data, { format })

  if (options.output === "-") {
    // Ignore EPIPE when the reader (e.g. `| head`) closes early; report anything else.
    process.stdout.on("error", (err) => {
      if (err?.code === "EPIPE") return
      console.error(`Could not write to stdout: ${safeEcho(err?.code || err?.message, 120)}`)
      process.exitCode = 1
    })
    process.stdout.write(doc)
    return
  }

  let target
  if (options.output === undefined) {
    target = join(root, ".opencode", "teamwork", sessionId, format === "markdown" ? "report.md" : "report.html")
  } else {
    const resolved = resolveExportOutput(options.output, root)
    if (resolved.error) {
      console.error(resolved.error)
      process.exitCode = 1
      return
    }
    target = resolved.path
  }

  // O_NOFOLLOW refuses a symlinked final component at open time (ELOOP), while
  // a regular file is still allowed to be truncated and replaced. The fd is the
  // authority, so there is no lstat-then-write race.
  let fd = null
  try {
    fd = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
      0o666,
    )
    writeFileSync(fd, doc, { encoding: "utf8" })
  } catch (err) {
    if (err && (err.code === "ELOOP" || err.code === "EMLINK")) {
      console.error(`Refusing to write ${safeEcho(target, 200)}: target is a symlink`)
    } else {
      console.error(`Could not write ${safeEcho(target, 200)}: ${safeEcho(err?.code || err?.message, 120)}`)
    }
    process.exitCode = 1
    return
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
  console.log(target)
}

function pruneCommand(options) {
  const res = pruneTeamworkWorktrees(process.cwd(), {
    all: Boolean(options.all),
    sessionId: options.session,
    force: options.force === true,
    ...(options.reason ? { reason: options.reason } : {}),
  })
  if (res.refused.length) {
    for (const entry of res.refused) {
      console.error(`refused: ${entry.sessionId} still has ${entry.reason}; use --force only after confirming the claim is gone`)
    }
    process.exitCode = 1
  }
  if (res.forced.length) {
    for (const entry of res.forced) {
      console.error(`WARNING: --force pruned ${entry.sessionId} despite ${entry.reason}`)
    }
  }
  if (!res.count) {
    console.log("No worktrees were pruned.")
  } else {
    console.log(`Pruned ${res.count} worktree directory(s): ${res.removed.join(", ")}`)
  }
}

const DOCTOR_INDICATORS = { pass: "[✓]", warn: "[!]", fail: "[✗]" }

/** Read the plan's pinned-write flag for doctor (bounded, no symlink follow). */
function runPlanRequirePinnedWrites(runDir) {
  if (!runDir) return undefined
  try {
    const file = join(runDir, "plan.dag.json")
    const st = lstatSync(file)
    if (!st.isFile() || st.size > 64 * 1024) return undefined
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed?.requirePinnedWrites === true
  } catch {
    return undefined
  }
}

async function verifyCommand(options) {
  try {
    const result = await verifyRun({
      cwd: process.cwd(),
      session: options.session,
      runDir: options.runDir,
      publicKey: options.publicKey || undefined,
      keyId: options.keyId || undefined,
      hmacKey: options.hmacKey || undefined,
      hmacKeyId: options.hmacKeyId || undefined,
      repo: options.repo || undefined,
      requireIndex: options.requireIndex,
      requireGit: options.requireGit === true,
      allowUnsigned: options.allowUnsigned === true,
      failOnWarning: options.failOnWarning === true,
      rerun: options.rerun === true,
      timeout: options.timeout !== undefined && options.timeout !== "" ? Number(options.timeout) : undefined,
      keepWorktree: options.keepWorktree === true,
      witnessPublicKey: options.witnessPublicKey || undefined,
      witnessKeyId: options.witnessKeyId || undefined,
      witnessReceipt: options.witnessReceipt || undefined,
      attestationPublicKey: options.attestationPublicKey || undefined,
      attestationKeyId: options.attestationKeyId || undefined,
      attestationIssuer: options.attestationIssuer || undefined,
    })
    if (options.json) {
      // JSON.stringify escapes C0 only; escape DEL and C1 (incl. 0x9b CSI) too
      // so no raw control byte from a run file can reach the terminal.
      const json = JSON.stringify(result, null, 2).replace(
        /[\x7f-\x9f]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      )
      console.log(json)
    } else {
      const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !options.noColor
      for (const line of renderVerify(result, { color })) console.log(line)
    }
    process.exitCode = verifyExitCode(result, { failOnWarning: options.failOnWarning === true })
  } catch (err) {
    if (err instanceof VerifyUsageError) {
      console.error(`verify: ${safeEcho(err.message, 300)}`)
      process.exitCode = 3
      return
    }
    console.error(`verify: ${safeEcho(err?.message ?? err, 300)}`)
    process.exitCode = 2
  }
}

function doctorCommand(options) {
  if (options.unlock !== undefined) {
    const result = unlockLock(options.unlock, { confirm: options.confirm === true })
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else console.log(result.message)
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (options.locks) {
    const root = options.runDir ? resolve(options.runDir) : join(process.cwd(), ".opencode", "teamwork")
    const inventory = inventoryLocks(root)
    if (options.json) console.log(JSON.stringify(inventory, null, 2))
    else console.log(formatLocksReport(inventory))
    process.exitCode = 0
    return
  }
  const configDir = resolveConfigDir(options.configDir)
  const report = runDoctor({ configDir, cwd: process.cwd() })
  const steps = nextSteps(report.checks)
  const runDir =
    typeof options.session === "string" && /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(options.session)
      ? join(process.cwd(), ".opencode", "teamwork", options.session)
      : undefined
  const planRequirePinnedWrites = runPlanRequirePinnedWrites(runDir)
  const security =
    options.security || options.json
      ? collectSecurityReport({
          env: process.env,
          configDir,
          repoRoot: process.cwd(),
          ...(runDir ? { runDir } : {}),
          ...(planRequirePinnedWrites !== undefined ? { planRequirePinnedWrites } : {}),
        })
      : undefined

  if (options.json) {
    // Additive: existing consumers still see { ok, checks }; nextSteps and
    // (when requested or --json) the security section are new.
    console.log(
      JSON.stringify({ ...report, nextSteps: steps, ...(security ? { security } : {}) }, null, 2),
    )
    process.exitCode = options.requireHardened && security ? hardenedExitCode(security) : report.ok ? 0 : 1
    return
  }

  console.log("opencode-teamwork doctor")
  console.log(`Config dir: ${configDir}\n`)
  for (const check of report.checks) {
    const indicator = DOCTOR_INDICATORS[check.status] || DOCTOR_INDICATORS.fail
    console.log(`${indicator} ${check.name.padEnd(20)} ${check.message}`)
  }

  const failed = report.checks.filter((check) => check.status === "fail").length
  const warned = report.checks.filter((check) => check.status === "warn").length
  console.log("")
  if (report.ok) {
    console.log(warned ? `Environment looks healthy (${warned} warning(s)).` : "Environment looks healthy.")
  } else {
    console.log(`Environment has ${failed} failing check(s)${warned ? ` and ${warned} warning(s)` : ""}.`)
  }
  if (security) {
    console.log("\nArtifact-trust security posture (ADR 0006/0008):")
    for (const check of security.checks) {
      const indicator = DOCTOR_INDICATORS[check.status] || DOCTOR_INDICATORS.fail
      console.log(`${indicator} ${check.name.padEnd(20)} ${check.message}`)
    }
    const failedSecurity = security.failures.length
    const unknownSecurity = security.unknowns.length
    const securitySummary =
      failedSecurity || unknownSecurity
        ? `\n${failedSecurity} security failure(s), ${unknownSecurity} unknown check(s), ${security.warnings.length} warning(s).`
        : security.warnings.length
          ? `\n${security.warnings.length} security warning(s).`
          : "\nNo security warnings."
    console.log(
      `${securitySummary} Authenticity is tamper-evident against a run-dir-only writer; it is not a same-UID boundary (see SECURITY.md).`,
    )
  }
  if (steps.length) {
    console.log("\nNext steps:")
    for (const step of steps) console.log(`  → ${step}`)
  }
  if (options.requireHardened) {
    process.exitCode = security ? hardenedExitCode(security) : 2
    if (process.exitCode === 2) {
      console.log("\nHardened profile NOT satisfied: a fail or unknown security check is present.")
    }
    return
  }
  process.exitCode = report.ok ? 0 : 1
}

async function main() {
  // `approve` has its own argv grammar (a request file may be `-`), so it is
  // dispatched before the installer parser and never routes through `init`.
  if (process.argv[2] === "approve") {
    const { approveCommand } = await import("../lib/approve.mjs")
    process.exitCode = await approveCommand(process.argv.slice(3))
    return
  }
  const options = parseArgs(process.argv.slice(2))
  const command = options.command || (options.help ? "help" : "init")

  if (options.help || command === "help") {
    console.log(HELP)
    return
  }
  if (!["init", "models", "install", "status", "runs", "inspect", "timeline", "export", "prune", "doctor", "verify"].includes(command)) {
    console.error(`Unknown command: ${command}\n`)
    console.log(HELP)
    process.exitCode = 1
    return
  }

  if (command === "status") return status(options)
  if (command === "runs") return runsCommand()
  if (command === "inspect") return inspectCommand(options)
  if (command === "timeline") return timelineCommand(options)
  if (command === "export") return exportCommand(options)
  if (command === "prune") return pruneCommand(options)
  if (command === "doctor") return doctorCommand(options)
  if (command === "verify") return verifyCommand(options)
  if (command === "install") {
    options.yes = true
    return run(options, { register: options.register })
  }
  if (command === "models") {
    return run(options, { register: false })
  }
  return run(options, { register: options.register, init: true })
}

main().catch((error) => {
  console.error(`@heretek-ai/opencode-teamwork-v2: ${error?.message || error}`)
  process.exitCode = 1
})
