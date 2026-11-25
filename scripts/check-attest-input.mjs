#!/usr/bin/env node
// CI attestation input and record guard.
//
// `.github/workflows/attest.yml` accepts exactly two scalars from
// `workflow_dispatch`: a run id and a manifest payload digest. This guard
// validates both before any step uses them and derives the manifest path from
// the validated run id. No caller-supplied path is accepted, and the value
// never reaches `$GITHUB_ENV`.
//
// The test job and the signing job are separate privilege domains. The
// unprivileged test job uploads `test-record.json`, `commands.json`,
// `test-output.txt` and a snapshot of `run.manifest.json`; the privileged
// signing job calls `--verify-record` to prove the record is internally
// consistent and that the manifest hashes to the dispatcher-supplied digest
// before the signing key is loaded.
//
// Usage:
//   RUN_ID=... MANIFEST_DIGEST=... node scripts/check-attest-input.mjs \
//     [--repo-root DIR] [--require-manifest]
//   RUN_ID=... MANIFEST_DIGEST=... node scripts/check-attest-input.mjs \
//     --verify-record DIR [--commit SHA] [--ref REF]
//
// Exit 0 and print `manifest_path=<absolute path>` when the inputs are valid.
// Exit 1 on any malformed input, missing/unsafe manifest, or inconsistent
// record. This script never executes a command and never uses the network.

import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { payloadDigest } from "../plugins/opencode-teamwork/approval-format.mjs"

// A run id is one path segment: start alphanumeric, then letters, digits, dot,
// underscore or hyphen. The same shape the plugin uses for run directories.
const RUN_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

function fail(message) {
  console.error(`check-attest-input: ${message}`)
  return 1
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case "--require-manifest":
        options.requireManifest = true
        break
      case "--verify-record":
        options.verifyRecord = argv[index + 1]
        index += 1
        if (!options.verifyRecord) throw new Error("--verify-record needs a directory")
        break
      case "--repo-root":
        options.repoRoot = argv[index + 1]
        index += 1
        if (!options.repoRoot) throw new Error("--repo-root needs a directory")
        break
      case "--commit":
        options.commit = argv[index + 1]
        index += 1
        if (!options.commit) throw new Error("--commit needs a git commit")
        break
      case "--ref":
        options.ref = argv[index + 1]
        index += 1
        if (!options.ref) throw new Error("--ref needs a git ref")
        break
      case "--help":
        options.help = true
        break
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return options
}

function validateInputs(env) {
  const runId = String(env.RUN_ID ?? "")
  if (!RUN_ID_RE.test(runId)) {
    throw new Error("RUN_ID must match ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
  }
  const manifestDigest = String(env.MANIFEST_DIGEST ?? "")
    .trim()
    .toLowerCase()
  if (!SHA256_RE.test(manifestDigest)) {
    throw new Error("MANIFEST_DIGEST must be 64 hex characters")
  }
  return { runId, manifestDigest }
}

function fixedManifestPath(repoRoot, runId) {
  const root = resolve(repoRoot)
  const rel = join(".opencode", "teamwork", runId, "run.manifest.json")
  const absolute = resolve(root, rel)
  const fromRoot = relative(root, absolute)
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error("derived manifest path escapes the repository root")
  }
  return absolute
}

/** Reject symlinks, special files, and files above the size cap. */
function plainFile(path, label, maxBytes) {
  let stat
  try {
    stat = lstatSync(path)
  } catch (err) {
    throw new Error(`${label} is missing (${err?.code ?? "error"})`)
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  return stat
}

function readJson(path, label, maxBytes) {
  plainFile(path, label, maxBytes)
  let value
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`${label} is not valid JSON (${err?.message ?? err})`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value
}

function checkManifestDigest(path, manifestDigest) {
  const manifest = readJson(path, "run.manifest.json", MAX_MANIFEST_BYTES)
  const digest = payloadDigest(manifest)
  if (digest !== manifestDigest) {
    throw new Error(`run.manifest.json payload digest ${digest} does not match MANIFEST_DIGEST`)
  }
  return manifest
}

/**
 * The in-checkout manifest must live at the fixed path and must not resolve
 * anywhere else: a symlink in any component is rejected, not followed.
 */
function checkRepoManifest(repoRoot, runId, manifestDigest) {
  const root = realpathSync(resolve(repoRoot))
  const expected = join(root, ".opencode", "teamwork", runId, "run.manifest.json")
  plainFile(expected, "run.manifest.json", MAX_MANIFEST_BYTES)
  let real
  try {
    real = realpathSync(expected)
  } catch (err) {
    throw new Error(`run.manifest.json cannot be resolved (${err?.code ?? "error"})`)
  }
  if (real !== expected) {
    throw new Error("run.manifest.json resolves outside the fixed path (symlink component)")
  }
  return { path: expected, manifest: checkManifestDigest(real, manifestDigest) }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function verifyRecord(recordDir, inputs, expectedCommit, expectedRef) {
  const dir = resolve(recordDir)
  let stat
  try {
    stat = lstatSync(dir)
  } catch (err) {
    throw new Error(`record directory is missing (${err?.code ?? "error"})`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("record directory must be a real directory")
  }

  const record = readJson(join(dir, "test-record.json"), "test-record.json", MAX_RECORD_BYTES)
  if (record.runId !== inputs.runId) throw new Error("test-record.json runId does not match RUN_ID")
  if (record.manifestDigest !== inputs.manifestDigest) {
    throw new Error("test-record.json manifestDigest does not match MANIFEST_DIGEST")
  }
  if (typeof record.commit !== "string" || !GIT_SHA_RE.test(record.commit)) {
    throw new Error("test-record.json commit must be a full git SHA")
  }
  if (expectedCommit && record.commit !== expectedCommit) {
    throw new Error(`test-record.json commit ${record.commit} does not match ${expectedCommit}`)
  }
  if (typeof record.ref !== "string" || record.ref === "") {
    throw new Error("test-record.json ref must be a non-empty string")
  }
  if (expectedRef && record.ref !== expectedRef) {
    throw new Error(`test-record.json ref ${record.ref} does not match ${expectedRef}`)
  }
  if (!Number.isInteger(record.testExitCode) || record.testExitCode < 0 || record.testExitCode > 255) {
    throw new Error("test-record.json testExitCode must be an integer in 0..255")
  }

  const outputPath = join(dir, "test-output.txt")
  plainFile(outputPath, "test-output.txt", MAX_OUTPUT_BYTES)
  const output = readFileSync(outputPath)

  const commandsPath = join(dir, "commands.json")
  plainFile(commandsPath, "commands.json", MAX_RECORD_BYTES)
  let commands
  try {
    commands = JSON.parse(readFileSync(commandsPath, "utf8"))
  } catch (err) {
    throw new Error(`commands.json is not valid JSON (${err?.message ?? err})`)
  }
  if (!Array.isArray(commands) || commands.length !== 1) {
    throw new Error("commands.json must contain exactly the one `npm test` command")
  }
  const command = commands[0]
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("commands.json[0] must be an object")
  }
  if (
    !Array.isArray(command.argv) ||
    command.argv.length !== 2 ||
    command.argv[0] !== "npm" ||
    command.argv[1] !== "test"
  ) {
    throw new Error('commands.json[0].argv must be ["npm", "test"]')
  }
  if (command.cwd !== ".") throw new Error('commands.json[0].cwd must be "."')
  if (command.exitCode !== record.testExitCode) {
    throw new Error("commands.json[0].exitCode does not match test-record.json")
  }
  if (typeof command.outputSha256 !== "string" || !SHA256_RE.test(command.outputSha256)) {
    throw new Error("commands.json[0].outputSha256 must be 64 lowercase hex characters")
  }
  if (command.outputBytes !== output.length) {
    throw new Error("commands.json[0].outputBytes does not match test-output.txt")
  }
  const digest = sha256(output)
  if (command.outputSha256 !== digest) {
    throw new Error("commands.json[0].outputSha256 does not match test-output.txt")
  }

  checkManifestDigest(join(dir, "run.manifest.json"), inputs.manifestDigest)
  return { commands: commands.length, bytes: output.length }
}

function appendGitHubOutput(line) {
  const target = process.env.GITHUB_OUTPUT
  if (target) appendFileSync(target, `${line}\n`)
  console.log(line)
}

function run(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log("Usage: RUN_ID=... MANIFEST_DIGEST=... node scripts/check-attest-input.mjs [--require-manifest] [--verify-record DIR]")
    return 0
  }
  const inputs = validateInputs(process.env)

  if (options.verifyRecord) {
    const expectedCommit = options.commit ?? process.env.GITHUB_SHA ?? ""
    const expectedRef = options.ref ?? process.env.GITHUB_REF ?? ""
    if (expectedCommit && !GIT_SHA_RE.test(expectedCommit)) {
      throw new Error("--commit must be a full git SHA")
    }
    const verified = verifyRecord(options.verifyRecord, inputs, expectedCommit, expectedRef)
    console.log(
      `check-attest-input: record verified (${verified.commands} command, ${verified.bytes} output bytes)`,
    )
    return 0
  }

  const repoRoot = options.repoRoot ?? process.cwd()
  const manifestPath = fixedManifestPath(repoRoot, inputs.runId)
  if (options.requireManifest) {
    checkRepoManifest(repoRoot, inputs.runId, inputs.manifestDigest)
  }
  appendGitHubOutput(`manifest_path=${manifestPath}`)
  return 0
}

try {
  process.exitCode = run(process.argv.slice(2))
} catch (err) {
  process.exitCode = fail(err?.message ?? String(err))
}
