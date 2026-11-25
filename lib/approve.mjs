// lib/approve.mjs — authenticated prompt-approval producer/verifier
//
//   opencode-teamwork approve request --session <runId> [--json]
//   opencode-teamwork approve sign --request <file|-> --draft <path> [--key <path>]
//                                  [--ttl 24h] [--approver uid:<name>|oidc:...|ci:...]
//   opencode-teamwork approve verify --session <runId> [--json]
//
// What this establishes
// ---------------------
// The approval is an Ed25519 signature by a key the *agent's process does not
// hold* over the exact bytes of `prompt_draft.md`, the run id, and a one-use
// nonce. The plugin verifies it with a public key, refuses an HMAC or run-key
// signature, and refuses to sign `approvals/` itself (AUTH_APPROVAL_SCOPE).
//
// What it does NOT establish
// --------------------------
// That a human read the draft, that the text displayed to the approver matched
// the bytes hashed, or that the approver understood it. This CLI also cannot
// see the plugin's in-memory digest index; it verifies the cryptographic
// binding and the manifest record, not the plan-time nonce consumption. Treat
// the approval as provenance, not comprehension.
//
// Zero runtime dependencies. Node >= 18 (`node:crypto` only; the canonical
// format lives in plugins/opencode-teamwork/approval-format.mjs so the plugin
// and this CLI cannot drift).

import { createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs"
import { userInfo } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import {
  approvalKeyIdFromPublicKey,
  artifactSignatureInput,
  canonicalJson,
  contentSha256Hex,
  isApprovalNonce,
  payloadDigest,
  signerApprovalSignatureInput,
} from "../plugins/opencode-teamwork/approval-format.mjs"
import { readBounded, readBoundedWithin } from "./bounded-read.mjs"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const APPROVAL_DIR_ENV = "OPENCODE_TEAMWORK_APPROVAL_DIR"
const SIGNER_APPROVAL_DIR_ENV = "OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR"
const APPROVAL_PUBLIC_ENV = "OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY"
const APPROVAL_KEY_ID_ENV = "OPENCODE_TEAMWORK_APPROVAL_KEY_ID"
const APPROVAL_PRIVATE_ENV = "OPENCODE_TEAMWORK_APPROVAL_PRIVATE_KEY"
const APPROVAL_KEY_FILE_ENV = "OPENCODE_TEAMWORK_APPROVAL_KEY_FILE"
const APPROVER_ID_RE =
  /^(?:uid:[A-Za-z0-9._-]{1,64}|oidc:[^\s#\u0000-\u001f]{1,200}#[^\s#\u0000-\u001f]{1,200}|ci:[A-Za-z0-9._/-]{1,120})$/
const SIGNER_APPROVAL_KIND = "teamwork.signer-approval"
const ARTIFACT_DIGEST_RE = /^[0-9a-f]{64}$/
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_SIGNER_TTL_MS = 60 * 60 * 1000
const MAX_DRAFT_BYTES = 512 * 1024
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_REQUEST_BYTES = 256 * 1024

function echo(value, max = 120) {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "?")
    .slice(0, max)
}

function fail(message) {
  return { ok: false, error: message }
}

function pathWithin(parent, child) {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function realOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Resolve an existing run directory without following a symlink. */
export function resolveRunForApproval(root, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return fail(`invalid session id "${echo(sessionId, 64)}": must match ${SESSION_ID}`)
  }
  const run = join(root, ".opencode", "teamwork", sessionId)
  let st
  try {
    st = lstatSync(run)
  } catch {
    return fail(`run ${sessionId} does not exist (${run}); create prompt_draft.md first`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return fail(`run ${run} is not a real directory`)
  return { ok: true, run, runReal: realpathSync(run), runId: sessionId }
}

function parseTtl(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TTL_MS
  const text = String(raw).trim().toLowerCase()
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(text)
  if (!match) return undefined
  const n = Number(match[1])
  const unit = match[2] ?? "h"
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  const ms = n * factor
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, MAX_TTL_MS)
}

function countOpenGaps(text) {
  const matches = text.match(/\[OPEN:/g)
  return matches ? matches.length : 0
}

/** Read and hash `prompt_draft.md` through the bounded no-follow reader. */
export function readDraftDigest(runReal, runDir) {
  const file = join(runDir, "prompt_draft.md")
  const res = readBoundedWithin(runReal, file, MAX_DRAFT_BYTES)
  if (res.status === "absent") return fail(`prompt_draft.md is missing: ${file}`)
  if (res.status !== "ok") return fail(`prompt_draft.md cannot be read (${res.status}): ${file}`)
  const bytes = res.bytes ?? Buffer.from(res.text, "utf8")
  return {
    ok: true,
    file,
    bytes,
    sha256: contentSha256Hex(bytes),
    size: bytes.length,
    openGaps: countOpenGaps(bytes.toString("utf8")),
    text: bytes.toString("utf8"),
  }
}

export function readManifestForApproval(runReal, runDir) {
  const file = join(runDir, "run.manifest.json")
  const res = readBoundedWithin(runReal, file, MAX_MANIFEST_BYTES)
  if (res.status !== "ok") return undefined
  let data
  try {
    data = JSON.parse(res.text)
  } catch {
    return undefined
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  return { data, digest: payloadDigest(data), version: Number(data.version) }
}

/**
 * Resolve the external approval directory. It must be absolute, an existing
 * real directory outside the repository and the run. Ownership is reported
 * separately: a same-UID directory is visible but the plan gate will refuse it.
 */
export function resolveApprovalDirForCli(root, runDir, env = process.env) {
  const raw = String(env[APPROVAL_DIR_ENV] ?? "").trim()
  if (!raw) return fail(`${APPROVAL_DIR_ENV} is not set; nothing can be produced or verified`)
  if (!isAbsolute(raw)) return fail(`${APPROVAL_DIR_ENV} must be absolute (got "${echo(raw, 200)}")`)
  let st
  try {
    st = lstatSync(raw)
  } catch (err) {
    return fail(`${APPROVAL_DIR_ENV} is not readable (${err?.code ?? "error"}): ${echo(raw, 200)}`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return fail(`${APPROVAL_DIR_ENV} must be a real directory: ${echo(raw, 200)}`)
  const dir = realpathSync(raw)
  if (pathWithin(realOrSelf(root), dir)) return fail(`approval directory ${echo(dir, 200)} is inside the repository`)
  if (runDir && pathWithin(realOrSelf(runDir), dir)) return fail(`approval directory ${echo(dir, 200)} is inside the run directory`)
  let euid
  try {
    euid = typeof process.geteuid === "function" ? process.geteuid() : undefined
  } catch {}
  return { ok: true, dir, uid: st.uid, euid, sameUid: euid !== undefined && st.uid === euid }
}

function defaultApprover(trustLevel) {
  if (trustLevel === "ci-attested") return undefined
  let user = "unknown"
  try {
    user = userInfo().username || user
  } catch {}
  const safe = String(user).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "unknown"
  return `uid:${safe}`
}

function approverField(trustLevel) {
  return trustLevel === "ci-attested" ? "attestedBy" : "approvedBy"
}

/**
 * The unsigned approval payload. `openGaps` is recorded, never hidden: an
 * approval with gaps can be signed with --allow-open but the plan refuses it.
 */
export function buildApprovalRequest({ runId, draft, trustLevel, approver, ttlMs, manifestDigest, planHash, now = Date.now() }) {
  const field = approverField(trustLevel)
  const approvedAt = new Date(now).toISOString()
  const expiresAt = new Date(now + ttlMs).toISOString()
  return {
    v: 1,
    runId,
    trustLevel,
    binding: "prompt",
    promptDraftSha256: draft.sha256,
    promptDraftBytes: draft.size,
    openGaps: draft.openGaps,
    approvalNonce: randomBytes(32).toString("base64url"),
    approvedAt,
    expiresAt,
    [field]: approver,
    // Optional pre-commitment. A re-plan may pin the existing plan baseline;
    // null means "any plan for this exact draft". It is signed, so a tamper is
    // an invalid envelope, and a valid-but-different plan is AUTH_APPROVAL_STALE.
    planHash: planHash ?? null,
    // Informational only (the v3 manifest records approvalDigest instead, so
    // this cannot be circular). It is NOT part of the trust decision.
    ...(manifestDigest ? { observedManifestDigest: manifestDigest } : {}),
  }
}

export function payloadFileFor(dir, runId) {
  return join(dir, `${runId}.json`)
}

/** Sign an approval payload with the approver key directly (never the plugin signer). */
export function signApprovalArtifact(payload, { privateKey, keyId, at = new Date().toISOString() }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("approval payload must be an object")
  const relPath = `approvals/${payload.runId}.json`
  // A v3 (prompt-bound) approval carries its one-use nonce in the payload and
  // the envelope. A legacy v2 approval has no payload nonce; the envelope still
  // needs one for Ed25519, so generate a random 256-bit value.
  const nonce = payload.approvalNonce ?? randomBytes(32).toString("base64url")
  if (!isApprovalNonce(nonce)) throw new Error("approvalNonce must be >=128 bits of base64url")
  const signedPayload = { ...payload }
  delete signedPayload._auth
  const digest = payloadDigest(signedPayload)
  const message = artifactSignatureInput("ed25519", keyId, relPath, nonce, signedPayload)
  const sig = cryptoSign(null, Buffer.from(message, "utf8"), privateKey)
  return {
    ...signedPayload,
    _auth: {
      v: 1,
      alg: "ed25519",
      keyId,
      path: relPath,
      digest,
      sig: sig.toString("base64url"),
      nonce,
      at,
    },
  }
}

/** Verify an approval envelope with only the SPKI public key. */
export function verifyApprovalArtifact(artifact, { publicKey, expectedKeyId } = {}) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return fail("approval is not an object")
  const auth = artifact._auth
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return fail("approval has no _auth envelope")
  if (auth.v !== 1) return fail("_auth.v must be 1")
  if (auth.alg !== "ed25519") return fail(`approval must be Ed25519 (got ${echo(auth.alg, 32)})`)
  if (typeof artifact.runId !== "string" || !SESSION_ID.test(artifact.runId)) return fail("approval.runId is invalid")
  const relPath = `approvals/${artifact.runId}.json`
  if (auth.path !== relPath) return fail(`_auth.path ${echo(auth.path, 80)} does not match ${relPath}`)
  if (typeof auth.keyId !== "string" || auth.keyId === "") return fail("_auth.keyId is missing")
  if (expectedKeyId && auth.keyId !== expectedKeyId) {
    return fail(`_auth.keyId ${echo(auth.keyId, 96)} is not the configured approval key (${echo(expectedKeyId, 96)})`)
  }
  if (!isApprovalNonce(auth.nonce)) return fail("_auth.nonce must be >=128 bits of base64url")
  if (artifact.approvalNonce !== auth.nonce) return fail("_auth.nonce does not equal approvalNonce")
  if (payloadDigest(artifact) !== auth.digest) return fail("approval digest does not match its _auth envelope")
  if (!publicKey) return fail(`${APPROVAL_PUBLIC_ENV} is not set; cannot verify the approver signature`)
  const message = artifactSignatureInput("ed25519", auth.keyId, auth.path, auth.nonce, artifact)
  const sig = Buffer.from(String(auth.sig ?? ""), "base64url")
  if (sig.length !== 64) return fail("_auth.sig is not a 64-byte base64url Ed25519 signature")
  let ok = false
  try {
    ok = cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)
  } catch {
    ok = false
  }
  if (!ok) return fail("approval Ed25519 signature is invalid")
  return { ok: true, keyId: auth.keyId }
}

function decodePublicKey(value) {
  const text = String(value ?? "").trim()
  if (!text) return undefined
  try {
    if (text.includes("BEGIN")) return createPublicKey(text)
    return createPublicKey({ key: Buffer.from(text, "base64url"), format: "der", type: "spki" })
  } catch {
    return undefined
  }
}

/** Load the approver private key from --key, env base64url, or a key file. */
export function loadApproverKey({ keyPath, env = process.env } = {}) {
  let source = keyPath
  let material
  if (source) {
    try {
      material = readFileSync(source, "utf8").trim()
    } catch (err) {
      return fail(`approver key ${echo(source, 200)} is not readable (${err?.code ?? "error"})`)
    }
  } else if (String(env[APPROVAL_PRIVATE_ENV] ?? "").trim()) {
    material = String(env[APPROVAL_PRIVATE_ENV]).trim()
    source = APPROVAL_PRIVATE_ENV
  } else if (String(env[APPROVAL_KEY_FILE_ENV] ?? "").trim()) {
    source = String(env[APPROVAL_KEY_FILE_ENV]).trim()
    try {
      material = readFileSync(source, "utf8").trim()
    } catch (err) {
      return fail(`approver key ${echo(source, 200)} is not readable (${err?.code ?? "error"})`)
    }
  } else {
    return fail(
      `no approver key: pass --key <path> or set ${APPROVAL_PRIVATE_ENV} / ${APPROVAL_KEY_FILE_ENV} (the agent process must not hold it)`,
    )
  }
  let privateKey
  try {
    if (material.includes("BEGIN")) privateKey = createPrivateKey(material)
    else privateKey = createPrivateKey({ key: Buffer.from(material, "base64url"), format: "der", type: "pkcs8" })
  } catch (err) {
    return fail(`approver key ${echo(source, 200)} could not be parsed (${echo(err?.message, 120)})`)
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    return fail(`approver key ${echo(source, 200)} is ${privateKey.asymmetricKeyType}, not ed25519`)
  }
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url")
  const configured = String(env[APPROVAL_KEY_ID_ENV] ?? "").trim()
  const keyId = approvalKeyIdFromPublicKey(spki, configured)
  return { ok: true, privateKey, publicKey: spki, keyId, source }
}

/**
 * Write the approval atomically with 0600, refusing a symlinked target. The
 * template lives in the same directory and is renamed into place, so a reader
 * never observes a partial approval.
 */
export function writeApprovalAtomically(dir, runId, artifact) {
  const target = payloadFileFor(dir, runId)
  try {
    if (lstatSync(target).isSymbolicLink()) return fail(`refusing to replace symlink ${echo(target, 200)}`)
  } catch {}
  const temp = join(dir, `.${runId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
  let fd
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
    closeSync(fd)
    fd = undefined
    renameSync(temp, target)
    return { ok: true, path: target }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(temp)
    } catch {}
    return fail(`could not write ${echo(target, 200)} (${err?.code ?? echo(err?.message, 80)})`)
  }
}

// ---------------------------------------------------------------------------
// Signer approvals (signer protocol v2)
// ---------------------------------------------------------------------------

/** A run-relative artifact path the signer may be asked to sign. */
export function isSignerApprovalPath(value) {
  if (typeof value !== "string" || value === "" || value.length > 1024) return false
  if (value.includes("\0") || value.includes("\\")) return false
  if (value.startsWith("/")) return false
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false
  if (segments[0] === "approvals") return false
  return true
}

/**
 * The unsigned signer-approval payload. Deliberately shares no field names with
 * the prompt approval: this artifact authorizes one `(runId, path, digest)` for
 * a signer policy decision, not a plan or a prompt draft. `nonce` is the run
 * nonce from the signed manifest, so the approval matches the signer request.
 */
export function buildSignerApprovalPayload({ runId, path, digest, nonce, approver, ttlMs, now = Date.now() }) {
  const approvedAt = new Date(now).toISOString()
  return {
    v: 1,
    kind: SIGNER_APPROVAL_KIND,
    runId,
    path,
    digest,
    nonce,
    approvedAt,
    expiresAt: new Date(now + ttlMs).toISOString(),
    approvedBy: approver,
    approvalId: randomBytes(32).toString("base64url"),
  }
}

/** Sign a signer approval with the approver key over the distinct v1 domain. */
export function signSignerApproval(payload, { privateKey, keyId }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("signer approval payload must be an object")
  const unsigned = { ...payload }
  delete unsigned._auth
  const input = signerApprovalSignatureInput({
    runId: unsigned.runId,
    path: unsigned.path,
    digest: unsigned.digest,
    nonce: unsigned.nonce,
    expiresAt: unsigned.expiresAt,
    payload: unsigned,
  })
  const sig = cryptoSign(null, Buffer.from(input, "utf8"), privateKey)
  return { ...unsigned, _auth: { alg: "ed25519", keyId, sig: sig.toString("base64url") } }
}

/** `<dir>/<runId>/<plain sha256(path)>.json` — the one-file-per-(run,path) layout. */
export function signerApprovalFileFor(dir, runId, path) {
  return join(dir, runId, `${contentSha256Hex(path)}.json`)
}

/**
 * Resolve the output directory for `approve signer`. `--out` may name the
 * directory directly; when both it and the env are set they must be the same
 * real directory, so the producer cannot silently write where the signer will
 * never look. The directory must be absolute, real, and outside the repo/run.
 */
export function resolveSignerApprovalDirForCli(root, runDir, outDir, env = process.env) {
  const envDir = String(env[SIGNER_APPROVAL_DIR_ENV] ?? "").trim()
  const raw = outDir !== undefined ? String(outDir).trim() : envDir
  if (!raw) {
    return fail(
      `${SIGNER_APPROVAL_DIR_ENV} is not set and --out was not passed; a signer approval must be written to the signer's approval directory`,
    )
  }
  if (!isAbsolute(raw)) return fail(`${SIGNER_APPROVAL_DIR_ENV}/--out must be absolute (got "${echo(raw, 200)}")`)
  let st
  try {
    st = lstatSync(raw)
  } catch (err) {
    return fail(`signer approval directory is not readable (${err?.code ?? "error"}): ${echo(raw, 200)}`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return fail(`signer approval directory must be a real directory: ${echo(raw, 200)}`)
  const dir = realpathSync(raw)
  if (outDir !== undefined && envDir) {
    const envReal = realOrSelf(envDir)
    if (envReal !== dir) {
      return fail(`--out ${echo(dir, 200)} does not match ${SIGNER_APPROVAL_DIR_ENV} ${echo(envReal, 200)}; the signer reads only the configured directory`)
    }
  }
  if (runDir && pathWithin(realOrSelf(runDir), dir)) {
    return fail(`signer approval directory ${echo(dir, 200)} is inside the run directory`)
  }
  if (pathWithin(realOrSelf(root), dir)) return fail(`signer approval directory ${echo(dir, 200)} is inside the repository`)
  return { ok: true, dir, uid: st.uid }
}

/**
 * Create `<dir>/<runId>/` (never following a symlink) and atomically write the
 * approval with mode 0600. The target filename is derived from the path, not
 * chosen by the caller.
 */
export function writeSignerApprovalAtomically(dir, runId, path, artifact) {
  const targetDir = join(dir, runId)
  try {
    const existing = lstatSync(targetDir)
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      return fail(`refusing to write through ${echo(targetDir, 200)}: not a real directory`)
    }
  } catch (err) {
    if (err?.code !== "ENOENT") return fail(`could not stat ${echo(targetDir, 200)} (${err?.code ?? "error"})`)
    try {
      mkdirSync(targetDir, { mode: 0o750 })
    } catch (mkdirErr) {
      return fail(`could not create ${echo(targetDir, 200)} (${mkdirErr?.code ?? "error"})`)
    }
    try {
      const created = lstatSync(targetDir)
      if (created.isSymbolicLink() || !created.isDirectory()) {
        return fail(`refusing to write through ${echo(targetDir, 200)}: not a real directory`)
      }
    } catch {
      return fail(`could not verify ${echo(targetDir, 200)}`)
    }
  }
  const target = signerApprovalFileFor(dir, runId, path)
  try {
    if (lstatSync(target).isSymbolicLink()) return fail(`refusing to replace symlink ${echo(target, 200)}`)
  } catch {}
  const temp = join(targetDir, `.${contentSha256Hex(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`)
  let fd
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
    closeSync(fd)
    fd = undefined
    renameSync(temp, target)
    return { ok: true, path: target }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(temp)
    } catch {}
    return fail(`could not write ${echo(target, 200)} (${err?.code ?? echo(err?.message, 80)})`)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `opencode-teamwork approve — authenticated prompt approval

Usage:
  opencode-teamwork approve request --session <runId> [--json]
      Print the draft digest, byte count, [OPEN:] count, observed manifest
      digest, and the exact payload that will be signed. Writes nothing trusted.

  opencode-teamwork approve sign --request <file|-> --draft <path> [options]
      Hash the draft's raw bytes, require a typed 8-hex confirmation and the
      word "approve", then write the Ed25519 approval atomically (0600) into
      OPENCODE_TEAMWORK_APPROVAL_DIR.
      Options: --key <path>, --ttl 24h, --approver uid:<name>|oidc:...|ci:...,
               --allow-open (record unresolved [OPEN:] gaps; the plan refuses).

  opencode-teamwork approve verify --session <runId> [--json]
      Re-run the binding checks and print what the approval covers. Never
      claims a human read the draft.

  opencode-teamwork approve signer --session <runId> --path <relPath>
                                   --digest <64hex> [options]
      Produce a signer approval (kind "teamwork.signer-approval") for the
      signer protocol v2, bound to one (runId, path, digest). Writes
      <SIGNER_APPROVAL_DIR>/<runId>/<sha256(path)>.json with mode 0600. The
      file is policy input for the signer; the plugin never reads it.
      Options: --key <path>, --ttl 1h, --approver uid:<name>|oidc:...,
               --out <dir> (must match the configured directory if both are set).

Environment:
  ${APPROVAL_DIR_ENV}        absolute directory outside the repo/run
  ${SIGNER_APPROVAL_DIR_ENV} absolute signer approval directory
  ${APPROVAL_PUBLIC_ENV}  SPKI Ed25519 public key (verification)
  ${APPROVAL_PRIVATE_ENV} PKCS#8 Ed25519 private key, base64url (signing)
  ${APPROVAL_KEY_FILE_ENV}  path to a PEM/base64url private key
  ${APPROVAL_KEY_ID_ENV}      optional key id (defaults to a digest)
`

function parseArgs(argv) {
  const options = { _: [] }
  const rest = [...argv]
  while (rest.length) {
    const arg = rest.shift()
    if (arg === "--json") options.json = true
    else if (arg === "--allow-open") options.allowOpen = true
    else if (arg === "-h" || arg === "--help") options.help = true
    else if (arg === "--session" || arg === "--request" || arg === "--draft" || arg === "--key" || arg === "--ttl" || arg === "--approver" || arg === "--trust" || arg === "--out" || arg === "--path" || arg === "--digest") {
      const name = arg.slice(2)
      const value = rest.shift()
      if (value === undefined) options[`_missing_${name}`] = true
      else options[name] = value
    } else if (arg.startsWith("-") && arg !== "-") {
      options[`_unknown_${arg}`] = true
    } else {
      options._.push(arg)
    }
  }
  return options
}

function readRequestFile(path) {
  let text
  if (path === "-") {
    try {
      text = readFileSync(0, "utf8")
    } catch (err) {
      return fail(`could not read the request from stdin (${err?.code ?? "error"})`)
    }
  } else {
    const res = readBounded(resolve(path), MAX_REQUEST_BYTES)
    if (res.status !== "ok") return fail(`request ${echo(path, 200)} is not readable (${res.status})`)
    text = res.text
  }
  if (text.length > MAX_REQUEST_BYTES) return fail("request is too large")
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return fail(`request ${echo(path, 200)} is not valid JSON`)
  }
  if (data && typeof data === "object" && data.payload && typeof data.payload === "object") data = data.payload
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("request is not an approval payload object")
  return { ok: true, data }
}

/**
 * `--request -` consumes stdin for the JSON payload, so confirmation must come
 * from the controlling terminal. Returns undefined when there is no tty (the
 * caller refuses rather than silently accepting an unconfirmed signature).
 */
function ttyInputStream() {
  try {
    const fd = openSync("/dev/tty", "r")
    return createReadStream("", { fd, autoClose: true })
  } catch {
    return undefined
  }
}

/**
 * Ask two questions on ONE readline interface. A fresh interface per question
 * loses buffered piped input when the first one is closed (and a TUI operator
 * would see the second prompt before the interface was ready).
 */
async function askPair(first, second, inputStream = process.stdin) {
  const rl = createInterface({ input: inputStream, output: process.stdout })
  const lines = []
  let wake
  rl.on("line", (line) => {
    lines.push(line)
    if (wake) wake()
  })
  const next = () =>
    new Promise((resolveAnswer) => {
      const check = () => {
        if (lines.length > 0) {
          wake = undefined
          resolveAnswer(lines.shift())
        } else {
          wake = check
        }
      }
      check()
    })
  try {
    // Written manually (rather than rl.question) so a piped second line that
    // arrives while the first prompt is pending is queued, not dropped.
    process.stdout.write(first)
    const one = await next()
    process.stdout.write(second)
    const two = await next()
    return [one, two]
  } finally {
    rl.close()
  }
}

function printHumanRequest({ runId, draft, manifest, request, trustLevel }) {
  console.log(`Run          : ${runId}`)
  console.log(`Draft        : ${draft.file}`)
  console.log(`Draft sha256 : ${draft.sha256}`)
  console.log(`Draft bytes  : ${draft.size}`)
  console.log(`[OPEN:] gaps : ${draft.openGaps}${draft.openGaps > 0 ? " (sign with --allow-open records them; the plan refuses)" : ""}`)
  console.log(`Manifest     : ${manifest ? `v${manifest.version} (digest ${manifest.digest} — observed, unverified)` : "absent (plan not written yet)"}`)
  console.log(`Trust level  : ${trustLevel}`)
  console.log(`Approver     : ${request[approverField(trustLevel)]}`)
  console.log(`Nonce        : ${request.approvalNonce}`)
  console.log(`Plan hash    : ${request.planHash ?? "null (any plan for this draft)"}`)
  console.log(`Expires      : ${request.expiresAt}`)
  console.log("\nPayload to sign (canonical JSON before _auth):")
  console.log(canonicalJson(request))
  console.log("\nThis payload is what the approver signs; the plugin records its digest in run.manifest.json.")
  console.log("Writing it to a file with --out is an untrusted convenience, not an approval.")
}

async function commandRequest(options, root) {
  const resolved = resolveRunForApproval(root, options.session)
  if (!resolved.ok) return { code: 1, error: resolved.error }
  const draft = readDraftDigest(resolved.runReal, resolved.run)
  if (!draft.ok) return { code: 1, error: draft.error }
  const manifest = readManifestForApproval(resolved.runReal, resolved.run)
  const trustLevel =
    options.trust ??
    (manifest && ["human-approved", "ci-attested"].includes(manifest.data.trustLevel)
      ? manifest.data.trustLevel
      : "human-approved")
  if (trustLevel !== "human-approved" && trustLevel !== "ci-attested") {
    return { code: 1, error: `--trust must be human-approved or ci-attested (got "${echo(trustLevel, 32)}")` }
  }
  const approver = options.approver ?? defaultApprover(trustLevel)
  if (!approver || !APPROVER_ID_RE.test(String(approver).trim())) {
    return {
      code: 1,
      error: `--approver must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow> (got "${echo(approver, 80)}")`,
    }
  }
  const ttlMs = parseTtl(options.ttl)
  if (ttlMs === undefined) return { code: 1, error: "--ttl must look like 30m, 24h, or 7d (max 7d)" }
  const request = buildApprovalRequest({
    runId: resolved.runId,
    draft,
    trustLevel,
    approver: String(approver).trim(),
    ttlMs,
    manifestDigest: manifest?.digest,
    planHash: typeof manifest?.data?.planHash === "string" ? manifest.data.planHash : null,
  })
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          runId: resolved.runId,
          draftPath: draft.file,
          promptDraftSha256: draft.sha256,
          promptDraftBytes: draft.size,
          openGaps: draft.openGaps,
          manifestDigest: manifest?.digest ?? null,
          manifestVersion: manifest?.version ?? null,
          planHash: request.planHash,
          trustLevel,
          payload: request,
        },
        null,
        2,
      ),
    )
  } else {
    printHumanRequest({ runId: resolved.runId, draft, manifest, request, trustLevel })
  }
  if (options.out) {
    const target = resolve(options.out)
    try {
      const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
      writeFileSync(fd, `${JSON.stringify(request, null, 2)}\n`, "utf8")
      closeSync(fd)
    } catch (err) {
      return { code: 1, error: `could not write ${echo(target, 200)} (${err?.code ?? "error"})` }
    }
  }
  return { code: 0 }
}

async function commandSign(options, root) {
  if (!options.request) return { code: 1, error: "approve sign needs --request <file|->" }
  if (!options.draft) return { code: 1, error: "approve sign needs --draft <path> (the exact prompt_draft.md)" }
  if (options._missing_request || options._missing_draft) return { code: 1, error: "an option is missing its value" }
  const read = readRequestFile(options.request)
  if (!read.ok) return { code: 1, error: read.error }
  const payload = { ...read.data }
  delete payload._auth
  const runId = payload.runId
  if (typeof runId !== "string" || !SESSION_ID.test(runId)) {
    return { code: 1, error: "request.runId is missing or invalid" }
  }
  if (payload.binding !== "prompt") return { code: 1, error: 'request.binding must be "prompt"' }
  if (!isApprovalNonce(payload.approvalNonce)) {
    return { code: 1, error: "request.approvalNonce must be >=128 bits of base64url" }
  }
  const draftPath = resolve(options.draft)
  const draftRes = readBounded(draftPath, MAX_DRAFT_BYTES)
  if (draftRes.status !== "ok") return { code: 1, error: `draft ${echo(draftPath, 200)} is not readable (${draftRes.status})` }
  const bytes = draftRes.bytes ?? Buffer.from(draftRes.text, "utf8")
  const sha256 = contentSha256Hex(bytes)
  const openGaps = countOpenGaps(bytes.toString("utf8"))
  if (payload.promptDraftSha256 !== sha256 || payload.promptDraftBytes !== bytes.length) {
    return {
      code: 1,
      error: `the request was built for ${echo(payload.promptDraftSha256, 64)} (${echo(payload.promptDraftBytes, 16)} bytes), but ${draftPath} is ${sha256} (${bytes.length} bytes); re-run approve request`,
    }
  }
  if (openGaps > 0 && !options.allowOpen) {
    return {
      code: 1,
      error: `prompt_draft.md still has ${openGaps} [OPEN:] gap(s); resolve them first, or pass --allow-open to record them (the plan will refuse that approval)`,
    }
  }
  const trustLevel = payload.trustLevel
  if (trustLevel !== "human-approved" && trustLevel !== "ci-attested") {
    return { code: 1, error: "request.trustLevel must be human-approved or ci-attested" }
  }
  const field = approverField(trustLevel)
  if (options.approver) {
    if (!APPROVER_ID_RE.test(String(options.approver).trim())) {
      return { code: 1, error: `--approver must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow> (got "${echo(options.approver, 80)}")` }
    }
    const other = field === "approvedBy" ? "attestedBy" : "approvedBy"
    delete payload[other]
    payload[field] = String(options.approver).trim()
  }
  if (typeof payload[field] !== "string" || !APPROVER_ID_RE.test(payload[field].trim())) {
    return { code: 1, error: `request.${field} must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow>` }
  }
  payload[field] = payload[field].trim()
  // An approval granted with unresolved gaps is recorded, not hidden; the plan
  // refuses it (AUTH_APPROVAL_INCOMPLETE).
  payload.openGaps = openGaps
  const approvedAtMs = Date.parse(payload.approvedAt)
  const baseMs = Number.isFinite(approvedAtMs) && approvedAtMs <= Date.now() ? approvedAtMs : Date.now()
  if (options.ttl !== undefined) {
    const ttlMs = parseTtl(options.ttl)
    if (ttlMs === undefined) return { code: 1, error: "--ttl must look like 30m, 24h, or 7d (max 7d)" }
    payload.approvedAt = new Date(baseMs).toISOString()
    payload.expiresAt = new Date(baseMs + ttlMs).toISOString()
  } else {
    // Preserve the request's approvedAt/expiresAt unless --ttl was passed. A
    // request built with a short TTL must not be silently extended at signing.
    const requestedExpires = Date.parse(payload.expiresAt)
    payload.approvedAt = new Date(baseMs).toISOString()
    if (!Number.isFinite(requestedExpires)) {
      payload.expiresAt = new Date(baseMs + DEFAULT_TTL_MS).toISOString()
    }
  }

  const approvalDir = resolveApprovalDirForCli(root, undefined)
  if (!approvalDir.ok) return { code: 1, error: approvalDir.error }
  const key = loadApproverKey({ keyPath: options.key })
  if (!key.ok) return { code: 1, error: key.error }

  if (openGaps > 0) {
    console.error(
      `warning: ${openGaps} unresolved [OPEN:] gap(s) are recorded; the plan refuses this approval (AUTH_APPROVAL_INCOMPLETE).`,
    )
  }
  console.log(`Run          : ${runId}`)
  console.log(`Draft        : ${draftPath}`)
  console.log(`Draft sha256 : ${sha256}`)
  console.log(`Draft bytes  : ${bytes.length}`)
  console.log(`Manifest     : ${payload.observedManifestDigest ? `${payload.observedManifestDigest} (observed)` : "absent"}`)
  console.log(`Approver key : ${key.keyId} (${key.source})`)
  console.log(`Identity     : ${payload[field]}`)
  const confirmInput = options.request === "-" ? ttyInputStream() : process.stdin
  if (!confirmInput) {
    return {
      code: 1,
      error: "with --request - stdin is the JSON payload and no terminal is available for confirmation; write the request to a file instead",
    }
  }
  const [typedDigestRaw, typedApproveRaw] = await askPair(
    `Type the first 8 hex characters of the draft digest (${sha256.slice(0, 8)}): `,
    'Type "approve" to sign: ',
    confirmInput,
  )
  const typedDigest = String(typedDigestRaw ?? "").trim().toLowerCase()
  if (typedDigest !== sha256.slice(0, 8)) {
    return { code: 1, error: "the typed draft prefix does not match; nothing was signed" }
  }
  const typedApprove = String(typedApproveRaw ?? "").trim()
  if (typedApprove !== "approve") {
    return { code: 1, error: 'confirmation failed (expected "approve"); nothing was signed' }
  }
  let artifact
  try {
    artifact = signApprovalArtifact(payload, { privateKey: key.privateKey, keyId: key.keyId })
  } catch (err) {
    return { code: 1, error: `could not sign the approval (${echo(err?.message, 120)})` }
  }
  const written = writeApprovalAtomically(approvalDir.dir, runId, artifact)
  if (!written.ok) return { code: 1, error: written.error }
  console.log(`\nWrote ${written.path} (mode 0600)`)
  console.log(`Approval digest: ${payloadDigest(artifact)}`)
  console.log(`Nonce          : ${payload.approvalNonce} (one use)`)
  console.log("The plugin records this digest in run.manifest.json at plan time.")
  return { code: 0 }
}

async function commandSigner(options, root) {
  if (!options.session) return { code: 1, error: "approve signer needs --session <runId>" }
  if (!options.path) return { code: 1, error: "approve signer needs --path <run-relative artifact path>" }
  if (!options.digest) return { code: 1, error: "approve signer needs --digest <64 hex characters>" }
  const runId = String(options.session)
  if (!SESSION_ID.test(runId)) return { code: 1, error: `invalid session id "${echo(runId, 64)}"` }
  const relPath = String(options.path)
  if (!isSignerApprovalPath(relPath)) {
    return {
      code: 1,
      error: `--path must be a run-relative artifact path (no leading /, no . or .. segment, not approvals/): "${echo(relPath, 200)}"`,
    }
  }
  const digest = String(options.digest).trim().toLowerCase()
  if (!ARTIFACT_DIGEST_RE.test(digest)) {
    return { code: 1, error: `--digest must be 64 lowercase hex characters (got "${echo(options.digest, 80)}")` }
  }
  const ttlMs = options.ttl === undefined ? DEFAULT_SIGNER_TTL_MS : parseTtl(options.ttl)
  if (ttlMs === undefined) return { code: 1, error: "--ttl must look like 30m, 1h, or 7d (max 7d)" }
  const approver = String(options.approver ?? defaultApprover("human-approved")).trim()
  if (!APPROVER_ID_RE.test(approver)) {
    return {
      code: 1,
      error: `--approver must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow> (got "${echo(approver, 80)}")`,
    }
  }
  // The request nonce is the run nonce pinned in the signed manifest. Read it
  // from the run; never invent one (a random nonce could not match the plugin's
  // request, and the signer would rightly refuse the approval).
  const resolvedRun = resolveRunForApproval(root, runId)
  if (!resolvedRun.ok) return { code: 1, error: resolvedRun.error }
  const manifest = readManifestForApproval(resolvedRun.runReal, resolvedRun.run)
  if (!manifest) {
    return { code: 1, error: `run.manifest.json is missing or invalid in ${resolvedRun.run}; plan the run before approving a signer artifact` }
  }
  const runNonce = manifest.data.runNonce
  if (!isApprovalNonce(runNonce)) {
    return { code: 1, error: "run.manifest.json has no >=128-bit runNonce; signer approvals must bind the signed run nonce" }
  }
  const out = resolveSignerApprovalDirForCli(root, resolvedRun.run, options.out)
  if (!out.ok) return { code: 1, error: out.error }
  const key = loadApproverKey({ keyPath: options.key })
  if (!key.ok) return { code: 1, error: key.error }
  const payload = buildSignerApprovalPayload({ runId, path: relPath, digest, nonce: runNonce, approver, ttlMs })
  let artifact
  try {
    artifact = signSignerApproval(payload, { privateKey: key.privateKey, keyId: key.keyId })
  } catch (err) {
    return { code: 1, error: `could not sign the signer approval (${echo(err?.message, 120)})` }
  }
  const written = writeSignerApprovalAtomically(out.dir, runId, relPath, artifact)
  if (!written.ok) return { code: 1, error: written.error }
  console.log(`Run          : ${runId}`)
  console.log(`Path         : ${relPath}`)
  console.log(`Digest       : ${digest}`)
  console.log(`Approver     : ${approver}`)
  console.log(`Approver key : ${key.keyId} (${key.source})`)
  console.log(`Expires      : ${payload.expiresAt}`)
  console.log(`Approval id  : ${payload.approvalId}`)
  console.log(`\nWrote ${written.path} (mode 0600)`)
  console.log("This file is input to the signer's policy check; the plugin does not read or verify it.")
  console.log("It authorizes one (runId, path, digest) until expiresAt. Provenance, not comprehension.")
  return { code: 0 }
}

async function commandVerify(options, root) {
  const resolved = resolveRunForApproval(root, options.session)
  if (!resolved.ok) return { code: 1, error: resolved.error }
  const draft = readDraftDigest(resolved.runReal, resolved.run)
  if (!draft.ok) return { code: 1, error: draft.error }
  const manifest = readManifestForApproval(resolved.runReal, resolved.run)
  if (!manifest) return { code: 1, error: "run.manifest.json is missing; the approval is only checked after a plan" }
  const approvalDir = resolveApprovalDirForCli(root, resolved.run)
  if (!approvalDir.ok) return { code: 1, error: approvalDir.error }
  const file = payloadFileFor(approvalDir.dir, resolved.runId)
  const read = readBounded(file, MAX_MANIFEST_BYTES)
  if (read.status === "absent") return { code: 1, error: `no approval artifact at ${file}` }
  if (read.status !== "ok") return { code: 1, error: `${file} is not a regular file` }
  let artifact
  try {
    artifact = JSON.parse(read.text)
  } catch {
    return { code: 1, error: `${file} is not valid JSON` }
  }
  const env = process.env
  const publicKey = decodePublicKey(env[APPROVAL_PUBLIC_ENV])
  const configuredKeyId = String(env[APPROVAL_KEY_ID_ENV] ?? "").trim() || undefined
  const verified = verifyApprovalArtifact(artifact, { publicKey, expectedKeyId: configuredKeyId })
  if (!verified.ok) return { code: 1, error: verified.error }

  const reasons = []
  if (Number(manifest.version) < 3 || manifest.data.approvalBinding !== "prompt") {
    reasons.push("run.manifest.json is not version 3 with approvalBinding: prompt")
  }
  if (artifact.runId !== resolved.runId) reasons.push(`approval is bound to run ${echo(artifact.runId, 64)}`)
  if (artifact.binding !== "prompt") reasons.push('approval has no binding: "prompt"')
  if (artifact.promptDraftSha256 !== draft.sha256) reasons.push("approval is bound to a different draft digest")
  if (artifact.promptDraftBytes !== draft.size) reasons.push("approval is bound to a different draft byte count")
  if (artifact.openGaps !== 0) reasons.push(`approval records ${echo(artifact.openGaps, 16)} open gap(s)`)
  if (draft.openGaps > 0) reasons.push(`draft still has ${draft.openGaps} [OPEN:] gap(s)`)
  if (manifest.data.specHash !== draft.sha256) reasons.push("manifest specHash does not match the draft")
  if (manifest.data.specBytes !== draft.size) reasons.push("manifest specBytes does not match the draft")
  if (manifest.data.approvalDigest !== payloadDigest(artifact)) reasons.push("manifest approvalDigest does not match the approval")
  if (manifest.data.approvalNonce !== artifact.approvalNonce) reasons.push("manifest approvalNonce does not match the approval")
  const field = artifact.trustLevel === "ci-attested" ? "attestedBy" : "approvedBy"
  if (artifact.trustLevel !== manifest.data.trustLevel) reasons.push("approval trustLevel does not match the manifest")
  if (manifest.data.approvedBy !== artifact[field]) reasons.push("manifest approvedBy does not match the approver")
  if (manifest.data.approvedAt !== artifact.approvedAt) reasons.push("manifest approvedAt does not match the approval")
  const approvedAtMs = Date.parse(artifact.approvedAt)
  const expiresAtMs = Date.parse(artifact.expiresAt)
  if (!Number.isFinite(approvedAtMs)) reasons.push("approvedAt is not a valid ISO timestamp")
  if (!Number.isFinite(expiresAtMs)) reasons.push("expiresAt is not a valid ISO timestamp")
  else if (Date.now() > expiresAtMs) reasons.push("approval is expired")
  else if (Number.isFinite(approvedAtMs) && expiresAtMs > approvedAtMs + MAX_TTL_MS) reasons.push("approval lifetime exceeds 7 days")
  if (approvalDir.sameUid) {
    console.error("warning: the approval directory is owned by this UID; the plan gate refuses a same-UID approver")
  }

  const binding = {
    runId: resolved.runId,
    draftPath: draft.file,
    promptDraftSha256: draft.sha256,
    promptDraftBytes: draft.size,
    openGaps: draft.openGaps,
    approvalPath: file,
    approvalDigest: payloadDigest(artifact),
    approvalNonce: artifact.approvalNonce,
    approvalKeyId: verified.keyId,
    approver: artifact[field],
    approvedAt: artifact.approvedAt,
    expiresAt: artifact.expiresAt,
    binding: artifact.binding,
    trustLevel: artifact.trustLevel,
    approvalDirUid: approvalDir.uid,
    sameUidDirectory: approvalDir.sameUid === true,
  }
  const ok = reasons.length === 0
  if (options.json) {
    console.log(JSON.stringify({ ok, ...binding, reasons }, null, 2))
  } else {
    console.log(`Run          : ${binding.runId}`)
    console.log(`Draft        : ${draft.file}`)
    console.log(`Draft sha256 : ${draft.sha256} (${draft.size} bytes, ${draft.openGaps} [OPEN:] gap(s))`)
    console.log(`Approval     : ${file}`)
    console.log(`Digest       : ${binding.approvalDigest}`)
    console.log(`Nonce        : ${binding.approvalNonce}`)
    console.log(`Approver key : ${verified.keyId}`)
    console.log(`Identity     : ${binding.approver}`)
    console.log(`Approved at  : ${binding.approvedAt} (expires ${binding.expiresAt})`)
    console.log(`Binding      : ${binding.binding} (manifest v${manifest.version})`)
    if (approvalDir.sameUid) console.log("Owner        : same UID — the plan gate refuses this")
    if (ok) {
      console.log("\nBINDING OK: the approval verifies over these exact draft bytes and this run.")
    } else {
      console.log("\nBINDING FAILED:")
      for (const reason of reasons) console.log(`  - ${reason}`)
    }
    console.log("This does not establish that a human read the draft, that the displayed text matched")
    console.log("the bytes hashed, or that the approver understood it. Provenance, not comprehension.")
  }
  return { code: ok ? 0 : 1 }
}

/**
 * Entry point used by bin/opencode-teamwork.mjs. Returns a process exit code.
 * `argv` excludes the leading `approve`.
 */
export async function approveCommand(argv, { root = process.cwd() } = {}) {
  const action = argv[0]
  const options = parseArgs(argv.slice(1))
  if (!action || action === "help" || options.help) {
    console.log(HELP)
    return action ? 0 : 1
  }
  if (options._missing_session || options._missing_request || options._missing_draft || options._missing_key || options._missing_path || options._missing_digest) {
    console.error("approve: an option is missing its value")
    return 1
  }
  const unknown = Object.keys(options).find((key) => key.startsWith("_unknown_"))
  if (unknown) {
    console.error(`approve: unknown option ${unknown.slice("_unknown_".length)}`)
    return 1
  }
  let result
  if (action === "request") result = await commandRequest(options, root)
  else if (action === "sign") result = await commandSign(options, root)
  else if (action === "signer") result = await commandSigner(options, root)
  else if (action === "verify") result = await commandVerify(options, root)
  else {
    console.error(`approve: unknown action "${echo(action, 32)}"\n`)
    console.log(HELP)
    return 1
  }
  if (result?.error) {
    console.error(`approve: ${result.error}`)
    return 1
  }
  return result?.code ?? 0
}

/** Exported for tests: the env names the CLI and doctor share. */
export const APPROVAL_ENV = {
  dir: APPROVAL_DIR_ENV,
  publicKey: APPROVAL_PUBLIC_ENV,
  keyId: APPROVAL_KEY_ID_ENV,
  privateKey: APPROVAL_PRIVATE_ENV,
  keyFile: APPROVAL_KEY_FILE_ENV,
}

export const APPROVAL_LIMITS = { defaultTtlMs: DEFAULT_TTL_MS, maxTtlMs: MAX_TTL_MS, maxDraftBytes: MAX_DRAFT_BYTES }
