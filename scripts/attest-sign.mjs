#!/usr/bin/env node
// attest-sign.mjs — produce a signed CI attestation (0.18.0)
//
// This is the dev/CI-only producer for `verify/ci/attestation.json`. It runs
// OUTSIDE the agent's process, holds an Ed25519 private key the run does not
// have, and signs what a CI job actually observed:
//
//   --run-id          the Teamwork run id
//   --manifest-digest digest of run.manifest.json (payload digest)
//   --commit          the commit the CI checked out and tested
//   --base            the base commit of the change (optional value allowed)
//   --prompt-hash     manifest.specHash (sha256 of prompt_draft.md)
//   --plan-hash       manifest.planHash
//   --commands        JSON array of {argv,cwd,exitCode,outputSha256,outputBytes}
//                     (an entry may carry `output`; the digest is computed)
//   --key             Ed25519 PKCS#8 private key (PEM or base64url)
//   --out             destination path (written atomically, mode 0600)
//
// The run nonce binds the attestation to the signed manifest. Pass `--nonce`
// or `--manifest <run.manifest.json>`; one of them is required.
//
// No runtime dependencies. It never executes a command and never uses the
// network; the CI job runs the command and hands over its output digest.

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants as fsConstants } from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, resolve } from "node:path"
import {
  ATTESTATION_PATH,
  attestationKeyIdFromPublicKey,
  loadAttestationPrivateKey,
  publicKeyFromAttestationPrivateKey,
  signAttestation,
} from "../plugins/opencode-teamwork/attestation.mjs"
import { contentSha256Hex, payloadDigest } from "../plugins/opencode-teamwork/approval-format.mjs"

const SHA256_HEX = /^[0-9a-f]{64}$/
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const MAX_COMMANDS = 64
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

function usage(message) {
  if (message) console.error(`attest-sign: ${message}`)
  console.error(`Usage: attest-sign --run-id <id> --manifest-digest <hex> --commit <sha>
                      [--base <sha>] --prompt-hash <hex> --plan-hash <hex>
                      --commands <json|@file> (--nonce <b64url> | --manifest <path>)
                      --key <path> --out <path> [--key-id <id>] [--run-key-id <id>]
                      [--provider github-actions] [--workflow <name>]
                      [--run-attempt 1] [--repository owner/repo]
                      [--oidc-issuer <issuer>] [--oidc-subject <subject>]
                      [--oidc-audience <audience>] [--issued-at <iso>]
                      [--expires-at <iso>] [--expires-in 1h] [--json]`)
  return 1
}

function parseArgs(argv) {
  const options = {}
  const rest = [...argv]
  while (rest.length) {
    const arg = rest.shift()
    if (arg === "--json") {
      options.json = true
      continue
    }
    if (!arg.startsWith("--")) return { error: `unexpected argument ${arg}` }
    const value = rest.shift()
    if (value === undefined) return { error: `${arg} is missing its value` }
    options[arg.slice(2)] = value
  }
  return { options }
}

function readJsonInput(value, label) {
  let text = value
  if (value === "-") {
    try {
      text = readFileSync(0, "utf8")
    } catch (err) {
      throw new Error(`${label} could not be read from stdin (${err?.code ?? "error"})`)
    }
  } else if (value.startsWith("@")) {
    try {
      text = readFileSync(resolve(value.slice(1)), "utf8")
    } catch (err) {
      throw new Error(`${label} file ${value.slice(1)} is not readable (${err?.code ?? "error"})`)
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`)
  if (parsed.length > MAX_COMMANDS) throw new Error(`${label} has ${parsed.length} entries (cap ${MAX_COMMANDS})`)
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] is not an object`)
    }
    const command = {
      argv: entry.argv,
      cwd: entry.cwd ?? ".",
      exitCode: entry.exitCode,
    }
    if (typeof entry.outputSha256 === "string") {
      command.outputSha256 = entry.outputSha256.trim().toLowerCase()
      command.outputBytes = entry.outputBytes
    } else if (typeof entry.output === "string" || typeof entry.stdout === "string") {
      const output = String(entry.output ?? entry.stdout)
      const bytes = Buffer.from(output, "utf8")
      if (bytes.length > MAX_OUTPUT_BYTES) throw new Error(`${label}[${index}] output exceeds ${MAX_OUTPUT_BYTES} bytes`)
      command.outputSha256 = createHash("sha256").update(bytes).digest("hex")
      command.outputBytes = bytes.length
    } else {
      throw new Error(`${label}[${index}] needs outputSha256/outputBytes or an output string`)
    }
    return command
  })
}

function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(String(text ?? "").trim().toLowerCase())
  if (!match) return undefined
  const n = Number(match[1])
  const unit = match[2] ?? "h"
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return n * factor
}

function isoOrUndefined(value, label) {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`${label} is not an ISO timestamp`)
  return new Date(ms).toISOString()
}

function readManifest(path) {
  let text
  try {
    text = readFileSync(resolve(path), "utf8")
  } catch (err) {
    throw new Error(`manifest ${path} is not readable (${err?.code ?? "error"})`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`manifest ${path} is not valid JSON`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`manifest ${path} is not an object`)
  return value
}

function writeAtomically(target, text) {
  const path = resolve(target)
  const dir = dirname(path)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new Error(`could not create ${dir} (${err?.code ?? "error"})`)
  }
  let existing
  try {
    existing = lstatSync(path)
  } catch (err) {
    if (err?.code !== "ENOENT") throw new Error(`could not stat ${path} (${err?.code ?? "error"})`)
  }
  if (existing?.isSymbolicLink()) throw new Error(`refusing to replace symlink ${path}`)
  const temp = `${dir}/.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`
  let fd
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, text, "utf8")
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(temp)
    } catch {}
    throw new Error(`could not write ${path} (${err?.code ?? err?.message ?? "error"})`)
  }
  return path
}

function run(argv) {
  const parsed = parseArgs(argv)
  if (parsed.error) return usage(parsed.error)
  const o = parsed.options
  const required = ["run-id", "manifest-digest", "commit", "commands", "key", "out"]
  if (!o.manifest) required.push("prompt-hash", "plan-hash")
  const missing = required.filter((name) => typeof o[name] !== "string" || o[name] === "")
  if (missing.length) return usage(`missing ${missing.map((name) => `--${name}`).join(", ")}`)

  try {
    if (!RUN_ID.test(o["run-id"])) return usage(`--run-id is not a valid run id`)
    const manifestDigest = o["manifest-digest"].trim().toLowerCase()
    if (!SHA256_HEX.test(manifestDigest)) return usage("--manifest-digest must be 64 lowercase hex characters")
    const commit = o.commit.trim().toLowerCase()
    if (!GIT_SHA.test(commit)) return usage("--commit must be a 40/64-hex git id")
    const base = String(o.base ?? "").trim().toLowerCase()
    if (base && !GIT_SHA.test(base)) return usage("--base must be a 40/64-hex git id")
    const promptHash = o["prompt-hash"] ? o["prompt-hash"].trim().toLowerCase() : undefined
    if (promptHash !== undefined && !SHA256_HEX.test(promptHash)) {
      return usage("--prompt-hash must be 64 lowercase hex characters")
    }
    const planHash = o["plan-hash"] ? o["plan-hash"].trim().toLowerCase() : undefined
    if (planHash !== undefined && !SHA256_HEX.test(planHash)) {
      return usage("--plan-hash must be 64 lowercase hex characters")
    }

    const commands = readJsonInput(o.commands, "--commands")
    const privateKey = loadAttestationPrivateKey(readFileSync(resolve(o.key), "utf8"))
    if (!privateKey) return usage("--key is not a PKCS#8 Ed25519 private key (PEM or base64url)")
    const spki = publicKeyFromAttestationPrivateKey(privateKey)
    const keyId = attestationKeyIdFromPublicKey(spki, o["key-id"])
    if (!keyId) return usage("could not derive a key id from --key")
    if (o["run-key-id"] && o["run-key-id"] === keyId) {
      return usage("the attestation key is the run key; a CI attestation must use a distinct key")
    }

    let nonce = o.nonce
    let effectivePlanHash = planHash
    let effectivePromptHash = promptHash
    if (o.manifest) {
      const manifest = readManifest(o.manifest)
      const digest = payloadDigest(manifest)
      if (digest !== manifestDigest) {
        return usage(`--manifest-digest does not match ${o.manifest} (expected ${digest})`)
      }
      if (!nonce) nonce = manifest.runNonce
      if (typeof manifest.planHash !== "string" || !SHA256_HEX.test(manifest.planHash)) {
        return usage(`${o.manifest} has no valid planHash`)
      }
      // A run planned with skipInterview has no prompt_draft.md and therefore
      // `specHash: null`. The canonical "no draft" prompt hash is the unkeyed
      // sha256 of the empty input; `verify` skips the prompt binding when the
      // manifest records null, so this does not claim a draft existed.
      const manifestPromptHash =
        typeof manifest.specHash === "string" && SHA256_HEX.test(manifest.specHash)
          ? manifest.specHash
          : contentSha256Hex("")
      if (effectivePlanHash !== undefined && manifest.planHash !== effectivePlanHash) {
        return usage(`--plan-hash does not match ${o.manifest}.planHash`)
      }
      if (effectivePromptHash !== undefined && manifestPromptHash !== effectivePromptHash) {
        return usage(`--prompt-hash does not match ${o.manifest}.specHash`)
      }
      effectivePlanHash = manifest.planHash
      effectivePromptHash = manifestPromptHash
    }
    if (effectivePlanHash === undefined || effectivePromptHash === undefined) {
      return usage("--manifest is needed (or pass --plan-hash and --prompt-hash) to bind the run")
    }
    if (typeof nonce !== "string" || nonce === "") {
      return usage("--nonce or --manifest is required so the attestation binds the run manifest nonce")
    }

    const issuedAtMs = o["issued-at"] ? Date.parse(o["issued-at"]) : Date.now()
    if (!Number.isFinite(issuedAtMs)) return usage("--issued-at is not an ISO timestamp")
    const duration = o["expires-in"] === undefined ? 60 * 60 * 1000 : parseDuration(o["expires-in"])
    if (duration === undefined || duration <= 0) return usage("--expires-in must look like 30m, 1h or 1d")
    const expiresAtMs = o["expires-at"] ? Date.parse(o["expires-at"]) : issuedAtMs + Math.min(duration, 24 * 60 * 60 * 1000)
    if (!Number.isFinite(expiresAtMs)) return usage("--expires-at is not an ISO timestamp")

    const repository = String(o.repository ?? "").trim()
    const provider = String(o.provider ?? "github-actions").trim()
    const workflow = String(o.workflow ?? "attest").trim()
    const runAttempt = o["run-attempt"] === undefined ? 1 : Number(o["run-attempt"])
    if (!Number.isInteger(runAttempt) || runAttempt < 1) return usage("--run-attempt must be a positive integer")

    let oidcToken
    if (typeof o["oidc-token"] === "string" && o["oidc-token"].trim() !== "") {
      const raw = o["oidc-token"].trim()
      oidcToken = raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8").trim() : raw
    }
    const payload = {
      v: 1,
      provider,
      workflow,
      runId: o["run-id"],
      runAttempt,
      repository: repository || "unknown/unknown",
      commitSha: commit,
      baseSha: base,
      promptHash: effectivePromptHash,
      planHash: effectivePlanHash,
      manifestDigest,
      commands,
      oidc: {
        issuer: String(o["oidc-issuer"] ?? "https://token.actions.githubusercontent.com").trim(),
        subject: String(
          o["oidc-subject"] ?? (repository ? `repo:${repository}:ref:${String(o.ref ?? "refs/heads/main")}` : "unknown"),
        ).trim(),
        audience: String(o["oidc-audience"] ?? "opencode-teamwork").trim(),
        ...(o["oidc-ref"] ? { ref: String(o["oidc-ref"]).trim() } : {}),
        ...(oidcToken ? { token: oidcToken } : {}),
      },
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
    const artifact = signAttestation(payload, {
      privateKey,
      keyId,
      nonce,
      at: new Date(issuedAtMs).toISOString(),
      path: ATTESTATION_PATH,
    })
    const out = writeAtomically(o.out, `${JSON.stringify(artifact, null, 2)}\n`)
    if (o.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            path: out,
            keyId,
            runId: payload.runId,
            commitSha: payload.commitSha,
            planHash: payload.planHash,
            nonce,
            commands: payload.commands.length,
            expiresAt: payload.expiresAt,
          },
          null,
          2,
        ),
      )
    } else {
      console.log(`Wrote ${out} (mode 0600)`)
      console.log(`Run ${payload.runId} at ${payload.commitSha} (plan ${payload.planHash})`)
      console.log(`Key ${keyId}; ${payload.commands.length} command(s); expires ${payload.expiresAt}`)
    }
    return 0
  } catch (err) {
    console.error(`attest-sign: ${err?.message ?? err}`)
    return 1
  }
}

process.exitCode = run(process.argv.slice(2))
