// opencode-teamwork — artifact authenticity (Phase A + signer SPI)
//
// Zero runtime dependencies. Erasable TypeScript only (compatible with Node
// 22/24/26 `--experimental-strip-types`).
//
// What this module protects
// -------------------------
// A writer who can only touch the run directory (`.opencode/teamwork/<id>/`)
// cannot forge a PASS: every control-plane artifact (run manifest, verifier
// report, security audit, strict-wave verdict, victory verdict, final verdict)
// carries an `_auth` envelope over its own path + canonical payload, and a
// digest index lives in `ctx.storage`, outside the run directory.
//
// Two envelope algorithms are supported:
//   * `hmac-sha256` — the Phase A default. Verification needs the same secret
//     as signing, so it protects only against a run-dir-only writer.
//   * `ed25519` — the signer SPI. The run directory and the verifier need only
//     the public key (SPKI); signing needs the private key (PKCS#8) or an
//     external `command:` signer. Verification no longer requires key secrecy.
//
// Every signed run pins a 128-bit `runNonce` and a `runKeyId` in the signed
// `run.manifest.json`. Artifacts signed for that run carry the nonce in `_auth`
// and are indexed under `auth/run/<runId>/<relPath>`, so a copied/re-signed
// artifact from another run fails on nonce, key id, path, and index.
//
// What it does NOT protect
// ------------------------
// A same-UID shell with read access to `opencode.db` (or to the plugin KV file)
// can read a local HMAC/Ed25519 private key and compute a valid envelope, and
// can rewrite the digest index. Ed25519 makes verification possible with only a
// public key; it only becomes a boundary when the private key lives in a
// different privilege domain (separate UID, remote KMS/HSM, hardware token).
// See docs/adr/0005-artifact-authenticity.md,
// docs/adr/0006-artifact-trust-isolation.md and
// docs/adr/0008-signer-spi-and-trust-levels.md.
//
// Canonical JSON is deliberately tiny and opinionated: sorted object keys,
// stable array order, no `undefined`, no non-finite numbers, no cycles. The
// digest covers exactly that encoding, so two processes that wrote the same
// logical payload compute the same digest.

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto"
import { spawn } from "node:child_process"
import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import {
  AUTH_ED25519,
  artifactSignatureInput,
  canonicalJson,
  contentSha256Hex,
  payloadDigest,
  approvalKeyIdFromPublicKey,
  sha256Hex,
  signerApprovalSignatureInput,
  witnessSignatureInput,
} from "./approval-format.mjs"

export { canonicalJson, payloadDigest, sha256Hex }

const AUTH_ALG = "hmac-sha256"
export type AuthAlg = typeof AUTH_ALG | typeof AUTH_ED25519
export const KEY_RING_STORAGE_KEY = "auth/key/ring"
export const ENV_KEY = "OPENCODE_TEAMWORK_HMAC_KEY"
export const ENV_KEY_ID = "OPENCODE_TEAMWORK_HMAC_KEY_ID"
const ENV_ED25519_PRIVATE_KEY = "OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY"
const ENV_ED25519_PUBLIC_KEY = "OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY"
export const ENV_ED25519_KEY_ID = "OPENCODE_TEAMWORK_ED25519_KEY_ID"
const ENV_SIGNER = "OPENCODE_TEAMWORK_SIGNER"
const ENV_SIGNER_PUBLIC_KEY = "OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY"
const ENV_SIGNER_KEY_ID = "OPENCODE_TEAMWORK_SIGNER_KEY_ID"
const ENV_SIGNER_TIMEOUT_MS = "OPENCODE_TEAMWORK_SIGNER_TIMEOUT_MS"
const ENV_WITNESS = "OPENCODE_TEAMWORK_WITNESS"
const ENV_WITNESS_TIMEOUT_MS = "OPENCODE_TEAMWORK_WITNESS_TIMEOUT_MS"
/**
 * Verify-only witness key (0.14.0). When configured, final_verify requires a
 * signed witness receipt; when unset, a receipt is recorded as `unverified`.
 */
const ENV_WITNESS_PUBLIC_KEY = "OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY"
const ENV_WITNESS_KEY_ID = "OPENCODE_TEAMWORK_WITNESS_KEY_ID"
/**
 * Signer protocol v2 (0.14.0). When set, the command signer receives
 * `{v:2, op:"sign-artifact", runId, approvalRef, …}`; when unset, the exact v1
 * request is sent for byte-compatible back-compat.
 */
const ENV_SIGNER_APPROVAL_DIR = "OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR"
/**
 * Verify-only approval key (0.10.2). A human/CI approval must be signed by a
 * key distinct from the run's `runKeyId`; this public key is how the verifier
 * learns that key without making it the run's signing key.
 */
const ENV_APPROVAL_PUBLIC_KEY = "OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY"
const ENV_APPROVAL_KEY_ID = "OPENCODE_TEAMWORK_APPROVAL_KEY_ID"
const KEY_RING_MAX_KEYS = 3
const DEFAULT_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 60000

export type AuthFailureCode =
  | "AUTH_UNAVAILABLE"
  | "AUTH_KEY_CORRUPT"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "AUTH_UNKNOWN_KEY"
  | "AUTH_INDEX_MISSING"
  | "AUTH_STALE"
  | "AUTH_LEGACY"
  | "AUTH_SIGNER_UNAVAILABLE"
  | "AUTH_WITNESS_UNAVAILABLE"
  | "AUTH_TRUST_LEVEL"
  | "AUTH_APPROVAL_MISSING"
  | "AUTH_APPROVAL_DIR"
  | "AUTH_APPROVAL_UNTRUSTED"
  | "AUTH_APPROVAL_STALE"
  | "AUTH_APPROVAL_NOT_HUMAN"
  | "AUTH_APPROVAL_INCOMPLETE"
  | "AUTH_APPROVAL_REPLAY"
  | "AUTH_APPROVAL_SCOPE"

export interface AuthFailure {
  code: AuthFailureCode
  message: string
}

export interface AuthEnvelope {
  v: 1
  alg: AuthAlg
  keyId: string
  path: string
  digest: string
  /** HMAC envelope field; absent for ed25519. */
  mac?: string
  /** Ed25519 envelope field (base64url); absent for HMAC. */
  sig?: string
  /** Per-run nonce (base64url, 128-bit). Required for ed25519. */
  nonce?: string
  at: string
}

interface AuthIndexRecord {
  v: 1
  path: string
  digest: string
  keyId: string
  alg?: AuthAlg
  mac?: string
  sig?: string
  nonce?: string
  at: string
}

interface KeyRecord {
  keyId: string
  /** Defaults to `hmac-sha256` for pre-Ed25519 rings. */
  alg?: AuthAlg
  /** base64url-encoded 32-byte secret (hmac-sha256 only). */
  key?: string
  /** base64url PKCS#8 private key (ed25519 only, optional for verify-only). */
  privateKey?: string
  /** base64url SPKI public key (ed25519 only). */
  publicKey?: string
  createdAt: string
  retiredAt?: string
}

interface KeyRing {
  version: 1
  keys: KeyRecord[]
}

export interface StorageLike {
  get(key: string): unknown | Promise<unknown>
  set(key: string, value: unknown): unknown | Promise<unknown>
  remove?(key: string): unknown | Promise<unknown>
  scan?(...args: unknown[]): unknown | Promise<unknown>
}

export type AuthResult<T> = ({ ok: true } & T) | { ok: false; failure: AuthFailure }

export class AuthError extends Error {
  readonly failure: AuthFailure
  constructor(failure: AuthFailure) {
    super(`${failure.code}: ${failure.message}`)
    this.name = "AuthError"
    this.failure = failure
  }
}

function fail(code: AuthFailureCode, message: string): { ok: false; failure: AuthFailure } {
  return { ok: false, failure: { code, message } }
}

/** Convert a thrown AuthError (or unknown failure) into the public result shape. */
function failureFromError(err: unknown, fallback: AuthFailureCode = "AUTH_UNAVAILABLE"): { ok: false; failure: AuthFailure } {
  const candidate = err instanceof AuthError ? err.failure : (err as any)?.failure
  if (candidate && typeof candidate.code === "string") return { ok: false, failure: candidate }
  const message = String((err as any)?.message ?? err).slice(0, 200)
  return { ok: false, failure: { code: fallback, message } }
}

// ---------------------------------------------------------------------------
// HMAC helpers (canonical JSON / digests live in approval-format.mjs)
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

function decodeKey(key: unknown): Buffer | undefined {
  if (typeof key !== "string" || !BASE64URL.test(key)) return undefined
  try {
    const buf = Buffer.from(key, "base64url")
    return buf.length === 32 ? buf : undefined
  } catch {
    return undefined
  }
}

function decodeBase64Url(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL.test(value)) return undefined
  try {
    const buf = Buffer.from(value, "base64url")
    return buf.length > 0 ? buf : undefined
  } catch {
    return undefined
  }
}

function encodeKey(key: Buffer): string {
  return key.toString("base64url")
}

function hmacHex(key: string, payload: string): string | undefined {
  const buf = decodeKey(key)
  if (!buf) return undefined
  return createHmac("sha256", buf).update(payload, "utf8").digest("hex")
}

/** Length-safe comparison of two lowercase sha256 hex strings. */
function timingSafeEqualHex(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) return false
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

function macOver(envelope: Omit<AuthEnvelope, "mac">): string {
  return canonicalJson(envelope)
}

function keyAlg(key: KeyRecord): AuthAlg {
  return key.alg ?? AUTH_ALG
}

function ed25519PublicKeyObject(value: unknown) {
  const raw = decodeBase64Url(value)
  if (!raw) return undefined
  try {
    return createPublicKey({ key: raw, format: "der", type: "spki" })
  } catch {
    return undefined
  }
}

function ed25519PrivateKeyObject(value: unknown) {
  const raw = decodeBase64Url(value)
  if (!raw) return undefined
  try {
    return createPrivateKey({ key: raw, format: "der", type: "pkcs8" })
  } catch {
    return undefined
  }
}

function deriveKeyId(prefix: string, spki: string): string {
  return `${prefix}_${sha256Hex(spki).slice(0, 16)}`
}

function publicKeyFromPrivate(privateKey: string): string | undefined {
  const key = ed25519PrivateKeyObject(privateKey)
  if (!key) return undefined
  try {
    return (createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer).toString("base64url")
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Key ring
// ---------------------------------------------------------------------------

function makeKeyId(): string {
  return `k_${randomBytes(8).toString("hex")}`
}

/**
 * Key id of the configured verify-only approval key, or undefined when no
 * `OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY` is set. This key never signs run
 * artifacts; it only verifies human/CI approvals.
 */
export function approvalKeyIdFromEnv(env: Record<string, string | undefined>): string | undefined {
  return approvalKeyIdFromPublicKey(env[ENV_APPROVAL_PUBLIC_KEY], env[ENV_APPROVAL_KEY_ID])
}

function corruptRing(message: string): never {
  throw new AuthError({ code: "AUTH_KEY_CORRUPT", message })
}

/** Validate a persisted ring. Throws AuthError; success returns the ring only. */
function validateRing(raw: unknown): KeyRing {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    corruptRing("auth/key/ring is not an object")
  }
  const ring = raw as any
  if (ring.version !== 1) corruptRing(`auth/key/ring version must be 1 (got ${String(ring.version)})`)
  if (!Array.isArray(ring.keys) || ring.keys.length === 0) {
    corruptRing("auth/key/ring has no keys")
  }
  if (ring.keys.length > KEY_RING_MAX_KEYS) {
    corruptRing(`auth/key/ring has ${ring.keys.length} keys; the maximum is ${KEY_RING_MAX_KEYS}`)
  }
  const keys: KeyRecord[] = []
  const seen = new Set<string>()
  for (let i = 0; i < ring.keys.length; i++) {
    const entry = ring.keys[i]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      corruptRing(`auth/key/ring keys[${i}] is not an object`)
    }
    const keyId = entry.keyId
    if (typeof keyId !== "string" || keyId.trim() === "" || keyId.length > 128) {
      corruptRing(`auth/key/ring keys[${i}].keyId is invalid`)
    }
    if (seen.has(keyId)) corruptRing(`auth/key/ring has a duplicate keyId "${keyId}"`)
    seen.add(keyId)
    const alg = entry.alg === undefined ? AUTH_ALG : entry.alg
    if (alg !== AUTH_ALG && alg !== AUTH_ED25519) {
      corruptRing(`auth/key/ring keys[${i}].alg must be ${AUTH_ALG} or ${AUTH_ED25519}`)
    }
    if (alg === AUTH_ALG) {
      if (!decodeKey(entry.key)) {
        corruptRing(`auth/key/ring keys[${i}].key is not a base64url 32-byte key`)
      }
    } else {
      const publicKey = entry.publicKey ?? (typeof entry.privateKey === "string" ? publicKeyFromPrivate(entry.privateKey) : undefined)
      if (!ed25519PublicKeyObject(publicKey)) {
        corruptRing(`auth/key/ring keys[${i}].publicKey is not a base64url SPKI Ed25519 key`)
      }
      if (entry.privateKey !== undefined && !ed25519PrivateKeyObject(entry.privateKey)) {
        corruptRing(`auth/key/ring keys[${i}].privateKey is not a base64url PKCS#8 Ed25519 key`)
      }
    }
    if (typeof entry.createdAt !== "string" || entry.createdAt.trim() === "") {
      corruptRing(`auth/key/ring keys[${i}].createdAt is missing`)
    }
    if (entry.retiredAt !== undefined && (typeof entry.retiredAt !== "string" || entry.retiredAt.trim() === "")) {
      corruptRing(`auth/key/ring keys[${i}].retiredAt is invalid`)
    }
    keys.push({
      keyId,
      ...(entry.alg !== undefined ? { alg: entry.alg as AuthAlg } : {}),
      ...(alg === AUTH_ALG ? { key: entry.key } : {}),
      ...(alg === AUTH_ED25519
        ? {
            publicKey: entry.publicKey ?? publicKeyFromPrivate(entry.privateKey),
            ...(entry.privateKey !== undefined ? { privateKey: entry.privateKey } : {}),
          }
        : {}),
      createdAt: entry.createdAt,
      ...(entry.retiredAt !== undefined ? { retiredAt: entry.retiredAt } : {}),
    })
  }
  return { version: 1, keys }
}

// Shared across every AuthContext over the same storage object so a rotation
// performed by one caller is visible to the plugin's long-lived context.
const ringCache = new WeakMap<object, KeyRing>()

function envRing(env: Record<string, string | undefined>): { ring: KeyRing; source: "env" } {
  const raw = env[ENV_KEY]
  if (!raw) throw new AuthError({ code: "AUTH_UNAVAILABLE", message: `${ENV_KEY} is not set` })
  const key = raw.trim()
  if (!decodeKey(key)) {
    throw new AuthError({ code: "AUTH_KEY_CORRUPT", message: `${ENV_KEY} is not a base64url 32-byte key` })
  }
  const keyId = (env[ENV_KEY_ID] || "env").trim() || "env"
  const now = new Date().toISOString()
  return {
    ring: { version: 1, keys: [{ keyId, key, createdAt: now }] },
    source: "env",
  }
}

function envEd25519Ring(env: Record<string, string | undefined>): { ring: KeyRing; source: "env" } {
  const privateKey = env[ENV_ED25519_PRIVATE_KEY]?.trim()
  const declaredPublic = env[ENV_ED25519_PUBLIC_KEY]?.trim()
  const publicKey = declaredPublic || (privateKey ? publicKeyFromPrivate(privateKey) : undefined)
  if (!publicKey || !ed25519PublicKeyObject(publicKey)) {
    throw new AuthError({
      code: "AUTH_KEY_CORRUPT",
      message: `${ENV_ED25519_PUBLIC_KEY} is not a base64url SPKI Ed25519 key`,
    })
  }
  if (privateKey && !ed25519PrivateKeyObject(privateKey)) {
    throw new AuthError({
      code: "AUTH_KEY_CORRUPT",
      message: `${ENV_ED25519_PRIVATE_KEY} is not a base64url PKCS#8 Ed25519 key`,
    })
  }
  const keyId = (env[ENV_ED25519_KEY_ID] || deriveKeyId("ed25519", publicKey)).trim()
  const now = new Date().toISOString()
  return {
    ring: {
      version: 1,
      keys: [
        {
          keyId,
          alg: AUTH_ED25519,
          publicKey,
          ...(privateKey ? { privateKey } : {}),
          createdAt: now,
        },
      ],
    },
    source: "env",
  }
}

// ---------------------------------------------------------------------------
// External signer / witness configuration
// ---------------------------------------------------------------------------

interface CommandSigner {
  command: string
  publicKey: string
  keyId: string
  timeoutMs: number
  /** Optional v2 approval directory; when set the request is v2. */
  approvalDir?: string
}

let signerApprovalOwnerUidOverride: number | null = null

/**
 * Test-only seam. A signer approval directory must be owned by a principal
 * other than the workload; a single-UID test process cannot create one.
 * Production never calls this (the default is `process.geteuid()`).
 */
export function setSignerApprovalOwnerUidForTest(uid: number | null): void {
  signerApprovalOwnerUidOverride = typeof uid === "number" && Number.isFinite(uid) ? Math.trunc(uid) : null
}

function expectedSignerApprovalOwnerUid(): number | undefined {
  if (signerApprovalOwnerUidOverride !== null) return signerApprovalOwnerUidOverride
  try {
    return typeof process.geteuid === "function" ? process.geteuid() : undefined
  } catch {
    return undefined
  }
}

function commandPath(value: string): string | undefined {
  if (!value.startsWith("command:")) return undefined
  const path = value.slice("command:".length).trim()
  return path.startsWith("/") ? path : undefined
}

function timeoutFromEnv(env: Record<string, string | undefined>, name: string): number {
  const raw = Number(env[name])
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_TIMEOUT_MS)
}

/** Resolve the external signer. Throws AuthError for a configured-but-invalid setup. */
function resolveSigner(env: Record<string, string | undefined>): CommandSigner | undefined {
  const raw = env[ENV_SIGNER]?.trim()
  if (!raw) return undefined
  const command = commandPath(raw)
  if (!command) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER} must be command:<absolute path>`,
    })
  }
  const publicKey = env[ENV_SIGNER_PUBLIC_KEY]?.trim()
  if (!publicKey || !ed25519PublicKeyObject(publicKey)) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER_PUBLIC_KEY} must be a base64url SPKI Ed25519 key`,
    })
  }
  const configuredId = env[ENV_SIGNER_KEY_ID]?.trim()
  const keyId = configuredId || deriveKeyId("signer", publicKey)
  const approvalDir = resolveSignerApprovalDir(env)
  return {
    command,
    publicKey,
    keyId,
    timeoutMs: timeoutFromEnv(env, ENV_SIGNER_TIMEOUT_MS),
    ...(approvalDir ? { approvalDir } : {}),
  }
}

/**
 * Resolve the v2 signer approval directory. It is a policy input for the
 * *signer*, not the plugin: the plugin only derives the reference. It must be
 * absolute, a real directory, and owned by a principal other than this process.
 * A configured-but-unusable directory fails closed before any spawn.
 */
function resolveSignerApprovalDir(env: Record<string, string | undefined>): string | undefined {
  const raw = env[ENV_SIGNER_APPROVAL_DIR]?.trim()
  if (!raw) return undefined
  if (!isAbsolute(raw)) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER_APPROVAL_DIR} must be an absolute path`,
    })
  }
  let st
  try {
    st = lstatSync(raw)
  } catch (err: any) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER_APPROVAL_DIR} is not readable (${String(err?.code ?? err).slice(0, 40)})`,
    })
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER_APPROVAL_DIR} must be a real directory (not a symlink)`,
    })
  }
  const expected = expectedSignerApprovalOwnerUid()
  if (expected !== undefined && st.uid === expected) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER_APPROVAL_DIR} is owned by this process (uid ${st.uid}); a signer approval must come from a different principal`,
    })
  }
  try {
    return realpathSync(raw)
  } catch (err: any) {
    throw new AuthError({
      code: "AUTH_SIGNER_UNAVAILABLE",
      message: `${ENV_SIGNER_APPROVAL_DIR} cannot be resolved (${String(err?.code ?? err).slice(0, 40)})`,
    })
  }
}

interface WitnessConfig {
  kind: "command" | "http"
  target: string
  timeoutMs: number
  /** Verify-only SPKI Ed25519 key. Absent means receipts are `unverified`. */
  publicKey?: string
  keyId?: string
}

function resolveWitness(env: Record<string, string | undefined>): WitnessConfig | undefined {
  const raw = env[ENV_WITNESS]?.trim()
  const configuredKey = env[ENV_WITNESS_PUBLIC_KEY]?.trim()
  const configuredKeyId = env[ENV_WITNESS_KEY_ID]?.trim()
  if (!raw) {
    if (configuredKey || configuredKeyId) {
      throw new AuthError({
        code: "AUTH_WITNESS_UNAVAILABLE",
        message: `${ENV_WITNESS_PUBLIC_KEY} is set but ${ENV_WITNESS} is not; no witness can produce a receipt`,
      })
    }
    return undefined
  }
  const command = commandPath(raw)
  const base =
    command
      ? { kind: "command" as const, target: command, timeoutMs: timeoutFromEnv(env, ENV_WITNESS_TIMEOUT_MS) }
      : raw.startsWith("http://") || raw.startsWith("https://")
        ? { kind: "http" as const, target: raw, timeoutMs: timeoutFromEnv(env, ENV_WITNESS_TIMEOUT_MS) }
        : undefined
  if (!base) {
    throw new AuthError({
      code: "AUTH_WITNESS_UNAVAILABLE",
      message: `${ENV_WITNESS} must be command:<absolute path> or http(s)://<url>`,
    })
  }
  if (!configuredKey) return base
  if (!ed25519PublicKeyObject(configuredKey)) {
    throw new AuthError({
      code: "AUTH_WITNESS_UNAVAILABLE",
      message: `${ENV_WITNESS_PUBLIC_KEY} must be a base64url SPKI Ed25519 key`,
    })
  }
  const keyId = configuredKeyId || deriveKeyId("witness", configuredKey)
  return { ...base, publicKey: configuredKey, keyId }
}

function spawnJson(
  command: string,
  request: unknown,
  timeoutMs: number,
  failureCode: "AUTH_SIGNER_UNAVAILABLE" | "AUTH_WITNESS_UNAVAILABLE",
): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (message: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(new AuthError({ code: failureCode, message }))
    }
    const child = spawn(command, [], { shell: false, stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let stderr = ""
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
      fail(`${command} timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunks.reduce((n, b) => n + b.length, 0) + chunk.length > 256 * 1024) {
        try {
          child.kill("SIGKILL")
        } catch {}
        fail(`${command} produced too much output`)
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2048)
    })
    child.on("error", (err: any) => fail(`${command} could not start (${String(err?.message ?? err).slice(0, 120)})`))
    child.on("close", (code: number | null) => {
      if (settled) return
      const out = Buffer.concat(chunks).toString("utf8")
      if (code !== 0) {
        fail(`${command} exited ${String(code)}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`)
        return
      }
      let parsed: any
      try {
        parsed = JSON.parse(out)
      } catch {
        fail(`${command} did not return JSON`)
        return
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail(`${command} returned a non-object JSON response`)
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(parsed)
    })
    try {
      child.stdin?.end(JSON.stringify(request))
    } catch (err: any) {
      fail(`${command} stdin failed (${String(err?.message ?? err).slice(0, 120)})`)
    }
  })
}

async function httpWitness(target: string, request: unknown, timeoutMs: number): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof (timer as any).unref === "function") (timer as any).unref()
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new AuthError({ code: "AUTH_WITNESS_UNAVAILABLE", message: `${target} returned HTTP ${res.status}` })
    }
    const text = (await res.text()).slice(0, 64 * 1024)
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new AuthError({ code: "AUTH_WITNESS_UNAVAILABLE", message: `${target} did not return JSON` })
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthError({ code: "AUTH_WITNESS_UNAVAILABLE", message: `${target} returned a non-object JSON response` })
    }
    return parsed
  } catch (err) {
    if (err instanceof AuthError) throw err
    throw new AuthError({
      code: "AUTH_WITNESS_UNAVAILABLE",
      message: `${target} unavailable (${String((err as any)?.message ?? err).slice(0, 120)})`,
    })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------------

export interface ArtifactCheck {
  status: "signed" | "unsigned" | "unknown"
  auth?: AuthEnvelope
  keyId?: string
  failure?: AuthFailure
}

/**
 * Result of checking a stored witness receipt against a configured witness key.
 *   * `verified`   — a witness public key is configured and the receipt's
 *                    signature covers this run, path, digest, nonce and time.
 *   * `unverified` — no witness public key is configured; the receipt is a
 *                    detection-only record (never upgraded to verified).
 *   * `missing`    — no receipt was recorded (AUTH_WITNESS_UNAVAILABLE).
 *   * `invalid`    — the record is present but is forged/foreign/stale
 *                    (AUTH_INVALID).
 *   * `unknown`    — storage is unavailable; cannot tell.
 */
export interface WitnessCheck {
  status: "verified" | "unverified" | "missing" | "invalid" | "unknown"
  failure?: AuthFailure
  keyId?: string
  at?: string
}

export interface SignOptions {
  /** Per-run nonce. Required for ed25519 run artifacts. */
  nonce?: string
  /** Pin verification to this key id (a signed run's `runKeyId`). */
  expectedKeyId?: string
  /** Expected per-run nonce (a signed run's `runNonce`). */
  requireNonce?: string
  /**
   * Run id for the signer protocol. Optional and additive: `signRunArtifact`
   * supplies it; a bare `signArtifact` call without one keeps the v1 signer
   * request (and a v2 request without a run id is refused).
   */
  runId?: string
}

export interface AuthContext {
  /** True when a key source (storage, env, or signer) is configured. */
  readonly configured: boolean
  /** True when OPENCODE_TEAMWORK_SIGNER=command:<path> is configured. */
  readonly signerConfigured: boolean
  /** True when OPENCODE_TEAMWORK_WITNESS is configured. */
  readonly witnessConfigured: boolean
  /** Resolve/initialise the ring. Cached after the first success. */
  ready(): Promise<AuthResult<{ keyId: string; source: "storage" | "env" | "signer" }>>
  /** Current key id, or undefined before `ready()`. */
  currentKeyId(): string | undefined
  /** Current signing algorithm, or undefined before a key source is resolved. */
  signingAlg(): AuthAlg | undefined
  /** Sign a payload without touching the index. Throws AuthError. */
  signArtifact(relPath: string, payload: unknown, opts?: SignOptions): Promise<any>
  /** Sign and record the digest index entry for `<runId>/<relPath>`. */
  signRunArtifact(runId: string, relPath: string, payload: unknown, opts?: SignOptions): Promise<any>
  /** Verify a signed payload (key + path + digest + MAC/signature). */
  verifyArtifact(relPath: string, payload: unknown, opts?: SignOptions): Promise<AuthResult<{ auth: AuthEnvelope; keyId: string }>>
  /** Verify a payload and its persistent digest index entry. */
  verifyRunArtifact(runId: string, relPath: string, payload: unknown, opts?: SignOptions): Promise<ArtifactCheck>
  /** Write/refresh the index entry from an envelope (advances to new payload). */
  writeIndex(runId: string, relPath: string, auth: AuthEnvelope): Promise<AuthResult<{}>>
  /** Rotate to a fresh key (previous keys remain verifiable, max 3 total). */
  rotate(alg?: AuthAlg): Promise<AuthResult<{ keyId: string }>>
  /** Bind the per-run nonce. A different existing nonce fails AUTH_STALE. */
  bindRunNonce(runId: string, nonce: string): Promise<AuthResult<{}>>
  /** Read the per-run nonce, if one has been bound. */
  runNonce(runId: string): Promise<string | undefined>
  /** Pin the per-run signing key id. A different existing id fails AUTH_STALE. */
  bindRunKeyId(runId: string, keyId: string): Promise<AuthResult<{}>>
  /** Read the pinned per-run key id, if any. */
  runKeyId(runId: string): Promise<string | undefined>
  /** True when a witness receipt was recorded for `<runId>/<relPath>`. */
  hasWitnessReceipt(runId: string, relPath: string): Promise<boolean>
  /** Read the recorded witness receipt, if any. */
  witnessReceipt(runId: string, relPath: string): Promise<string | undefined>
  /**
   * Check a stored witness receipt. When `OPENCODE_TEAMWORK_WITNESS_PUBLIC_KEY`
   * is configured the signature must cover this run, path, digest and nonce;
   * otherwise the record is reported `unverified` (detection-only).
   */
  verifyWitnessReceipt(
    runId: string,
    relPath: string,
    expected?: { digest?: string; nonce?: string },
  ): Promise<WitnessCheck>
}

export function createAuthContext(storage: StorageLike | undefined, env: Record<string, string | undefined> = {}): AuthContext {
  const storageUsable =
    !!storage &&
    typeof storage.get === "function" &&
    typeof storage.set === "function"
  let cached: KeyRing | null = null
  let resolvedAlg: AuthAlg | undefined
  let signer: CommandSigner | undefined
  let signerResolved = false
  let witness: WitnessConfig | undefined
  let witnessResolved = false
  const nonceCache = new Map<string, string>()
  const keyIdCache = new Map<string, string>()

  const getSigner = (): CommandSigner | undefined => {
    if (!signerResolved) {
      signer = resolveSigner(env)
      signerResolved = true
    }
    return signer
  }

  const getWitness = (): WitnessConfig | undefined => {
    if (!witnessResolved) {
      witness = resolveWitness(env)
      witnessResolved = true
    }
    return witness
  }

  const pullRing = async (): Promise<{ ring: KeyRing; source: "storage" | "env" }> => {
    if (env[ENV_ED25519_PRIVATE_KEY] || env[ENV_ED25519_PUBLIC_KEY]) {
      return envEd25519Ring(env)
    }
    if (env[ENV_KEY]) {
      return envRing(env)
    }
    if (!storageUsable) {
      throw new AuthError({ code: "AUTH_UNAVAILABLE", message: "ctx.storage is unavailable and no env key is set" })
    }
    if (cached) return { ring: cached, source: "storage" }
    const shared = ringCache.get(storage as object)
    if (shared) {
      cached = shared
      return { ring: shared, source: "storage" }
    }
    let existing: unknown
    try {
      existing = await storage.get(KEY_RING_STORAGE_KEY)
    } catch (err: any) {
      throw new AuthError({
        code: "AUTH_UNAVAILABLE",
        message: `could not read auth/key/ring (${String(err?.message ?? err).slice(0, 120)})`,
      })
    }
    if (existing === undefined || existing === null) {
      const created: KeyRing = {
        version: 1,
        keys: [{ keyId: makeKeyId(), key: encodeKey(randomBytes(32)), createdAt: new Date().toISOString() }],
      }
      try {
        await storage.set(KEY_RING_STORAGE_KEY, created)
      } catch (err: any) {
        throw new AuthError({
          code: "AUTH_UNAVAILABLE",
          message: `could not write auth/key/ring (${String(err?.message ?? err).slice(0, 120)})`,
        })
      }
      // Re-read is authoritative. If another process won the create race we
      // adopt the persisted ring instead of silently using ours.
      let reread: unknown
      try {
        reread = await storage.get(KEY_RING_STORAGE_KEY)
      } catch (err: any) {
        throw new AuthError({
          code: "AUTH_UNAVAILABLE",
          message: `could not re-read auth/key/ring (${String(err?.message ?? err).slice(0, 120)})`,
        })
      }
      const checked = validateRing(reread ?? created)
      cached = checked
      ringCache.set(storage as object, checked)
      return { ring: checked, source: "storage" }
    }
    const checked = validateRing(existing)
    cached = checked
    ringCache.set(storage as object, checked)
    return { ring: checked, source: "storage" }
  }

  const ready = async (): Promise<AuthResult<{ keyId: string; source: "storage" | "env" | "signer" }>> => {
    try {
      const external = getSigner()
      if (external) {
        resolvedAlg = AUTH_ED25519
        return { ok: true as const, keyId: external.keyId, source: "signer" }
      }
      const res = await pullRing()
      resolvedAlg = keyAlg(res.ring.keys[0])
      return { ok: true as const, keyId: res.ring.keys[0].keyId, source: res.source }
    } catch (err) {
      return failureFromError(err)
    }
  }

  const signerEnvelope = async (
    external: CommandSigner,
    relPath: string,
    payload: unknown,
    nonce: string | undefined,
    at: string,
    runId: string | undefined,
  ): Promise<AuthEnvelope> => {
    if (!nonce) {
      throw new AuthError({
        code: "AUTH_INVALID",
        message: "an ed25519 run artifact requires a bound run nonce",
      })
    }
    const digest = payloadDigest(payload)
    const message = artifactSignatureInput(AUTH_ED25519, external.keyId, relPath, nonce, payload)
    let request: Record<string, unknown>
    if (external.approvalDir) {
      // Signer protocol v2. The approval reference is derived only from
      // trusted inputs: the configured directory, the run id, and the plain
      // SHA-256 of the run-relative path. The plugin does NOT read or verify
      // the approval; that decision belongs to the signer.
      if (!runId || !RUN_ID.test(runId)) {
        throw new AuthError({
          code: "AUTH_SIGNER_UNAVAILABLE",
          message: `${ENV_SIGNER_APPROVAL_DIR} is set but no valid run id is available for the v2 signer request`,
        })
      }
      const approvalRef = join(external.approvalDir, runId, `${contentSha256Hex(relPath)}.json`)
      request = {
        v: 2,
        op: "sign-artifact",
        runId,
        alg: AUTH_ED25519,
        keyId: external.keyId,
        path: relPath,
        digest,
        nonce,
        at,
        approvalRef,
        message: Buffer.from(message, "utf8").toString("base64url"),
      }
    } else {
      // Exact v1 request, byte-compatible with a pre-0.14 signer.
      request = {
        v: 1,
        alg: AUTH_ED25519,
        keyId: external.keyId,
        path: relPath,
        digest,
        nonce,
        at,
        message: Buffer.from(message, "utf8").toString("base64url"),
      }
    }
    const response = await spawnJson(external.command, request, external.timeoutMs, "AUTH_SIGNER_UNAVAILABLE")
    const sig = decodeBase64Url(response?.sig)
    if (
      response?.alg !== AUTH_ED25519 ||
      response?.keyId !== external.keyId ||
      !sig ||
      sig.length !== 64
    ) {
      throw new AuthError({
        code: "AUTH_SIGNER_UNAVAILABLE",
        message: "the command signer returned an invalid {alg,keyId,sig} response",
      })
    }
    const publicKey = ed25519PublicKeyObject(external.publicKey)
    if (!publicKey || !cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)) {
      throw new AuthError({
        code: "AUTH_SIGNER_UNAVAILABLE",
        message: "the command signer signature does not verify with the configured public key",
      })
    }
    return {
      v: 1,
      alg: AUTH_ED25519,
      keyId: external.keyId,
      path: relPath,
      digest,
      sig: sig.toString("base64url"),
      nonce,
      at,
    }
  }

  const signArtifact = async (relPath: string, payload: unknown, opts: SignOptions = {}): Promise<any> => {
    if (typeof relPath !== "string" || relPath.trim() === "") {
      throw new AuthError({ code: "AUTH_INVALID", message: "artifact path is empty" })
    }
    // An approval must be signed by the approver's own key holder, never by the
    // plugin signer or a command signer the agent can call. This is a static
    // refusal, so `AUTH_APPROVAL_SCOPE` cannot be bypassed by configuration.
    if (relPath === "approvals" || relPath.startsWith("approvals/") || relPath.startsWith("./approvals/")) {
      throw new AuthError({
        code: "AUTH_APPROVAL_SCOPE",
        message: `refusing to sign ${relPath}: approval artifacts are signed by the approver key (opencode-teamwork approve sign), never by the plugin signer`,
      })
    }
    let digest: string
    try {
      digest = payloadDigest(payload)
    } catch (err: any) {
      throw new AuthError({ code: "AUTH_INVALID", message: `payload is not canonicalisable (${String(err?.message ?? err)})` })
    }
    const at = new Date().toISOString()
    const external = getSigner()
    if (external) {
      resolvedAlg = AUTH_ED25519
      const envelope = await signerEnvelope(external, relPath, payload, opts.nonce, at, opts.runId)
      return { ...(payload as Record<string, unknown>), _auth: envelope }
    }
    const res = await pullRing()
    const key = res.ring.keys[0]
    const alg = keyAlg(key)
    resolvedAlg = alg
    if (alg === AUTH_ED25519) {
      const nonce = opts.nonce ?? randomBytes(16).toString("base64url")
      const privateKey = ed25519PrivateKeyObject(key.privateKey)
      if (!privateKey) {
        throw new AuthError({
          code: "AUTH_UNAVAILABLE",
          message: `key ${key.keyId} is verify-only; no Ed25519 private key is available`,
        })
      }
      const message = artifactSignatureInput(AUTH_ED25519, key.keyId, relPath, nonce, payload)
      const sig = cryptoSign(null, Buffer.from(message, "utf8"), privateKey)
      return {
        ...(payload as Record<string, unknown>),
        _auth: {
          v: 1,
          alg: AUTH_ED25519,
          keyId: key.keyId,
          path: relPath,
          digest,
          sig: sig.toString("base64url"),
          nonce,
          at,
        } satisfies AuthEnvelope,
      }
    }
    const base: Omit<AuthEnvelope, "mac"> = {
      v: 1,
      alg: AUTH_ALG,
      keyId: key.keyId,
      path: relPath,
      digest,
      ...(opts.nonce ? { nonce: opts.nonce } : {}),
      at,
    }
    const mac = hmacHex(key.key!, macOver(base))
    if (!mac) throw new AuthError({ code: "AUTH_KEY_CORRUPT", message: "current key cannot be decoded" })
    return { ...(payload as Record<string, unknown>), _auth: { ...base, mac } as AuthEnvelope }
  }

  const verifyEnvelopeDigest = (payload: unknown, auth: AuthEnvelope): string | undefined => {
    try {
      return payloadDigest(payload)
    } catch {
      return undefined
    }
  }

  const resolveEd25519Public = async (keyId: string) => {
    const candidates: Array<{ keyId: string; publicKey: string }> = []
    const external = getSigner()
    if (external) candidates.push({ keyId: external.keyId, publicKey: external.publicKey })
    const envPublic = env[ENV_ED25519_PUBLIC_KEY]?.trim()
    if (envPublic) {
      const id = (env[ENV_ED25519_KEY_ID] || deriveKeyId("ed25519", envPublic)).trim()
      candidates.push({ keyId: id, publicKey: envPublic })
    }
    // A verify-only approval key is a separate principal: it is never used to
    // sign run artifacts, only to verify the human/CI approval envelope.
    const approvalPublic = env[ENV_APPROVAL_PUBLIC_KEY]?.trim()
    if (approvalPublic) {
      const id = approvalKeyIdFromEnv(env)
      if (id) candidates.push({ keyId: id, publicKey: approvalPublic })
    }
    try {
      const res = await pullRing()
      for (const key of res.ring.keys) {
        if (keyAlg(key) === AUTH_ED25519 && key.publicKey) candidates.push({ keyId: key.keyId, publicKey: key.publicKey })
      }
    } catch {}
    const match = candidates.find((c) => c.keyId === keyId)
    if (!match) return undefined
    return ed25519PublicKeyObject(match.publicKey)
  }

  const verifyArtifact = async (
    relPath: string,
    payload: unknown,
    opts: SignOptions = {},
  ): Promise<AuthResult<{ auth: AuthEnvelope; keyId: string }>> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("AUTH_INVALID", "artifact is not an object")
    }
    const auth = (payload as any)._auth
    if (auth === undefined || auth === null) return fail("AUTH_MISSING", "artifact has no _auth envelope")
    if (typeof auth !== "object" || Array.isArray(auth)) return fail("AUTH_INVALID", "_auth is not an object")
    if (auth.v !== 1) return fail("AUTH_INVALID", `_auth.v must be 1 (got ${String(auth.v)})`)
    if (auth.alg !== AUTH_ALG && auth.alg !== AUTH_ED25519) {
      return fail("AUTH_INVALID", `_auth.alg must be ${AUTH_ALG} or ${AUTH_ED25519} (got ${String(auth.alg)})`)
    }
    if (auth.path !== relPath) {
      return fail("AUTH_INVALID", `_auth.path ${String(auth.path)} does not match ${relPath}`)
    }
    if (typeof auth.keyId !== "string" || auth.keyId.trim() === "") {
      return fail("AUTH_INVALID", "_auth.keyId is missing")
    }
    if (opts.expectedKeyId && auth.keyId !== opts.expectedKeyId) {
      return fail(
        "AUTH_INVALID",
        `_auth.keyId ${auth.keyId} does not match the signed run key id ${opts.expectedKeyId}`,
      )
    }
    if (!SHA256_HEX.test(String(auth.digest ?? ""))) {
      return fail("AUTH_INVALID", "_auth digest is not a sha256 hex string")
    }
    if (opts.requireNonce !== undefined && auth.nonce !== opts.requireNonce) {
      return fail("AUTH_INVALID", "artifact nonce does not match the run nonce")
    }
    const digest = verifyEnvelopeDigest(payload, auth)
    if (!digest) return fail("AUTH_INVALID", "payload is not canonicalisable")
    if (!timingSafeEqualHex(digest, auth.digest)) {
      return fail("AUTH_INVALID", "artifact digest does not match its _auth envelope")
    }
    const at = typeof auth.at === "string" ? auth.at : ""
    if (!at) return fail("AUTH_INVALID", "_auth.at is missing")

    if (auth.alg === AUTH_ALG) {
      if (!SHA256_HEX.test(String(auth.mac ?? ""))) {
        return fail("AUTH_INVALID", "_auth.mac is not a sha256 hex string")
      }
      let ring: KeyRing
      try {
        ring = (await pullRing()).ring
      } catch (err) {
        return failureFromError(err)
      }
      const key = ring.keys.find((k) => k.keyId === auth.keyId && keyAlg(k) === AUTH_ALG)
      if (!key) {
        return fail("AUTH_UNKNOWN_KEY", `_auth.keyId ${auth.keyId} is not an HMAC key in the current key ring`)
      }
      const expected = hmacHex(
        key.key!,
        macOver({
          v: 1,
          alg: AUTH_ALG,
          keyId: auth.keyId,
          path: auth.path,
          digest: auth.digest,
          ...(auth.nonce !== undefined ? { nonce: auth.nonce } : {}),
          at: auth.at,
        }),
      )
      if (!expected || !timingSafeEqualHex(expected, auth.mac)) {
        return fail("AUTH_INVALID", "artifact MAC is invalid")
      }
      return { ok: true, auth: auth as AuthEnvelope, keyId: key.keyId }
    }

    // Ed25519: verification needs the public key only.
    if (typeof auth.nonce !== "string" || auth.nonce === "") {
      return fail("AUTH_INVALID", "an ed25519 _auth envelope requires a nonce")
    }
    const sig = decodeBase64Url(auth.sig)
    if (!sig || sig.length !== 64) return fail("AUTH_INVALID", "_auth.sig is not a 64-byte base64url Ed25519 signature")
    const publicKey = await resolveEd25519Public(auth.keyId)
    if (!publicKey) {
      return fail("AUTH_UNKNOWN_KEY", `_auth.keyId ${auth.keyId} has no configured Ed25519 public key`)
    }
    const message = artifactSignatureInput(AUTH_ED25519, auth.keyId, auth.path, auth.nonce, payload)
    if (!cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)) {
      return fail("AUTH_INVALID", "artifact Ed25519 signature is invalid")
    }
    return { ok: true, auth: auth as AuthEnvelope, keyId: auth.keyId }
  }

  const indexKey = (runId: string, relPath: string) => `auth/run/${runId}/${relPath}`
  const nonceKey = (runId: string) => `auth/run/${runId}/.nonce`
  const keyIdKey = (runId: string) => `auth/run/${runId}/.keyid`
  const witnessKey = (runId: string, relPath: string) => `auth/witness/${runId}/${relPath}`

  const bindRunNonce = async (runId: string, nonce: string): Promise<AuthResult<{}>> => {
    if (typeof nonce !== "string" || !BASE64URL.test(nonce) || Buffer.from(nonce, "base64url").length < 16) {
      return fail("AUTH_INVALID", "run nonce must be at least 128 bits of base64url data")
    }
    const inMemory = nonceCache.get(runId)
    if (inMemory !== undefined && inMemory !== nonce) {
      return fail("AUTH_STALE", `run ${runId} already has a different nonce`)
    }
    if (storageUsable) {
      try {
        const existing = await storage.get(nonceKey(runId))
        if (existing !== undefined && existing !== null && existing !== nonce) {
          return fail("AUTH_STALE", `run ${runId} already has a different nonce`)
        }
        if (existing !== nonce) await storage.set(nonceKey(runId), nonce)
      } catch (err: any) {
        return fail("AUTH_UNAVAILABLE", `could not bind the run nonce (${String(err?.message ?? err).slice(0, 120)})`)
      }
    }
    nonceCache.set(runId, nonce)
    return { ok: true }
  }

  const runNonce = async (runId: string): Promise<string | undefined> => {
    const cachedNonce = nonceCache.get(runId)
    if (cachedNonce !== undefined) return cachedNonce
    if (!storageUsable) return undefined
    try {
      const value = await storage.get(nonceKey(runId))
      if (typeof value === "string" && value !== "") {
        nonceCache.set(runId, value)
        return value
      }
    } catch {}
    return undefined
  }

  const bindRunKeyId = async (runId: string, keyId: string): Promise<AuthResult<{}>> => {
    if (typeof keyId !== "string" || keyId.trim() === "" || keyId.length > 128) {
      return fail("AUTH_INVALID", "run key id is invalid")
    }
    const inMemory = keyIdCache.get(runId)
    if (inMemory !== undefined && inMemory !== keyId) {
      return fail("AUTH_STALE", `run ${runId} already has a different key id`)
    }
    if (storageUsable) {
      try {
        const existing = await storage.get(keyIdKey(runId))
        if (existing !== undefined && existing !== null && existing !== keyId) {
          return fail("AUTH_STALE", `run ${runId} already has a different key id`)
        }
        if (existing !== keyId) await storage.set(keyIdKey(runId), keyId)
      } catch (err: any) {
        return fail("AUTH_UNAVAILABLE", `could not pin the run key id (${String(err?.message ?? err).slice(0, 120)})`)
      }
    }
    keyIdCache.set(runId, keyId)
    return { ok: true }
  }

  const runKeyId = async (runId: string): Promise<string | undefined> => {
    const cachedId = keyIdCache.get(runId)
    if (cachedId !== undefined) return cachedId
    if (!storageUsable) return undefined
    try {
      const value = await storage.get(keyIdKey(runId))
      if (typeof value === "string" && value !== "") {
        keyIdCache.set(runId, value)
        return value
      }
    } catch {}
    return undefined
  }

  const appendWitness = async (runId: string, relPath: string, auth: AuthEnvelope): Promise<void> => {
    const config = getWitness()
    if (!config) return
    const nonce = auth.nonce ?? ""
    const record = {
      runId,
      path: relPath,
      digest: auth.digest,
      keyId: auth.keyId,
      nonce,
      at: auth.at,
    }
    const request = { v: 2, ...record }
    const response =
      config.kind === "command"
        ? await spawnJson(config.target, request, config.timeoutMs, "AUTH_WITNESS_UNAVAILABLE")
        : await httpWitness(config.target, request, config.timeoutMs)
    const receipt = response?.receipt
    if (typeof receipt !== "string" || receipt.trim() === "") {
      throw new AuthError({ code: "AUTH_WITNESS_UNAVAILABLE", message: "the witness did not return a receipt" })
    }
    let proven: { alg: "ed25519"; keyId: string; sig: string } | undefined
    if (config.publicKey) {
      const sig = decodeBase64Url(response?.sig)
      if (
        response?.alg !== AUTH_ED25519 ||
        response?.keyId !== config.keyId ||
        !sig ||
        sig.length !== 64
      ) {
        throw new AuthError({
          code: "AUTH_WITNESS_UNAVAILABLE",
          message: "the witness returned a receipt without a valid {alg,keyId,sig} response",
        })
      }
      const message = witnessSignatureInput(runId, relPath, auth.digest, nonce, auth.at)
      const publicKey = ed25519PublicKeyObject(config.publicKey)
      if (!publicKey || !cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)) {
        throw new AuthError({
          code: "AUTH_WITNESS_UNAVAILABLE",
          message: "the witness receipt signature does not verify with the configured witness public key",
        })
      }
      proven = { alg: AUTH_ED25519, keyId: config.keyId!, sig: sig.toString("base64url") }
    }
    if (!storageUsable) {
      throw new AuthError({ code: "AUTH_WITNESS_UNAVAILABLE", message: "ctx.storage is unavailable; cannot record the witness receipt" })
    }
    try {
      await storage.set(witnessKey(runId, relPath), {
        // v2 shape: {receipt, alg, keyId, sig, at} when a witness key is
        // configured; an unverified v1-style receipt otherwise.
        v: 2,
        receipt: receipt.slice(0, 4096),
        ...(proven ? { alg: proven.alg, keyId: proven.keyId, sig: proven.sig, at: auth.at } : { alg: "unverified", at: auth.at }),
        verified: !!proven,
        record,
        recordedAt: new Date().toISOString(),
      })
    } catch (err: any) {
      throw new AuthError({
        code: "AUTH_WITNESS_UNAVAILABLE",
        message: `could not record the witness receipt (${String(err?.message ?? err).slice(0, 120)})`,
      })
    }
  }

  const writeIndex = async (runId: string, relPath: string, auth: AuthEnvelope): Promise<AuthResult<{}>> => {
    if (!storageUsable) {
      return fail("AUTH_UNAVAILABLE", "ctx.storage is unavailable; cannot record the digest index")
    }
    const record: AuthIndexRecord = {
      v: 1,
      path: relPath,
      digest: auth.digest,
      keyId: auth.keyId,
      alg: auth.alg,
      ...(auth.mac !== undefined ? { mac: auth.mac } : {}),
      ...(auth.sig !== undefined ? { sig: auth.sig } : {}),
      ...(auth.nonce !== undefined ? { nonce: auth.nonce } : {}),
      at: auth.at,
    }
    try {
      await storage.set(indexKey(runId, relPath), record)
    } catch (err: any) {
      return fail("AUTH_UNAVAILABLE", `could not write ${indexKey(runId, relPath)} (${String(err?.message ?? err).slice(0, 120)})`)
    }
    return { ok: true }
  }

  const signRunArtifact = async (
    runId: string,
    relPath: string,
    payload: unknown,
    opts: SignOptions = {},
  ): Promise<any> => {
    const nonce = opts.nonce ?? (await runNonce(runId))
    const pinnedKeyId = await runKeyId(runId)
    const signed = await signArtifact(relPath, payload, { ...opts, nonce, runId })
    if (pinnedKeyId && signed._auth?.keyId !== pinnedKeyId) {
      throw new AuthError({
        code: "AUTH_INVALID",
        message: `signed envelope key ${String(signed._auth?.keyId)} does not match the run key ${pinnedKeyId}`,
      })
    }
    await appendWitness(runId, relPath, signed._auth as AuthEnvelope)
    const written = await writeIndex(runId, relPath, signed._auth)
    if (!written.ok) throw new AuthError(written.failure)
    return signed
  }

  const verifyRunArtifact = async (
    runId: string,
    relPath: string,
    payload: unknown,
    opts: SignOptions = {},
  ): Promise<ArtifactCheck> => {
    const requireNonce = opts.requireNonce ?? (await runNonce(runId))
    const expectedKeyId = opts.expectedKeyId ?? (await runKeyId(runId))
    const verified = await verifyArtifact(relPath, payload, { ...opts, requireNonce, expectedKeyId })
    if (!verified.ok) {
      if (verified.failure.code === "AUTH_MISSING") return { status: "unsigned" }
      return { status: "unknown", failure: verified.failure }
    }
    if (!storageUsable) {
      return {
        status: "unknown",
        auth: verified.auth,
        keyId: verified.keyId,
        failure: { code: "AUTH_UNAVAILABLE", message: "ctx.storage is unavailable; cannot verify the digest index" },
      }
    }
    let index: unknown
    try {
      index = await storage.get(indexKey(runId, relPath))
    } catch (err: any) {
      return {
        status: "unknown",
        auth: verified.auth,
        keyId: verified.keyId,
        failure: { code: "AUTH_UNAVAILABLE", message: `could not read the digest index (${String(err?.message ?? err).slice(0, 120)})` },
      }
    }
    if (index === undefined || index === null) {
      return {
        status: "unknown",
        auth: verified.auth,
        keyId: verified.keyId,
        failure: { code: "AUTH_INDEX_MISSING", message: `no digest index entry for ${relPath}; a signed run never auto-adopts old artifacts` },
      }
    }
    const rec = index as any
    const recAlg = rec?.alg === undefined ? AUTH_ALG : rec?.alg
    const stale =
      rec?.v !== 1 ||
      rec?.path !== relPath ||
      rec?.keyId !== verified.auth.keyId ||
      recAlg !== verified.auth.alg ||
      rec?.digest !== verified.auth.digest ||
      (rec?.nonce ?? undefined) !== (verified.auth.nonce ?? undefined) ||
      rec?.at !== verified.auth.at ||
      (verified.auth.alg === AUTH_ALG
        ? !timingSafeEqualHex(rec?.mac, verified.auth.mac)
        : rec?.sig !== verified.auth.sig)
    if (stale) {
      return {
        status: "unknown",
        auth: verified.auth,
        keyId: verified.keyId,
        failure: { code: "AUTH_STALE", message: `digest index for ${relPath} does not match the artifact` },
      }
    }
    return { status: "signed", auth: verified.auth, keyId: verified.keyId }
  }

  const rotate = async (alg: AuthAlg = AUTH_ALG): Promise<AuthResult<{ keyId: string }>> => {
    if (env[ENV_KEY] || env[ENV_ED25519_PRIVATE_KEY] || getSigner()) {
      return fail("AUTH_UNAVAILABLE", "an environment key/signer pins the signing key; rotation is a storage-key operation")
    }
    if (!storageUsable) return fail("AUTH_UNAVAILABLE", "ctx.storage is unavailable; cannot rotate")
    let res: { ring: KeyRing; source: "storage" | "env" }
    try {
      res = await pullRing()
    } catch (err) {
      return failureFromError(err)
    }
    const now = new Date().toISOString()
    const previous = res.ring.keys[0]
    let fresh: KeyRecord
    if (alg === AUTH_ED25519) {
      const pair = generateKeyPairSync("ed25519")
      fresh = {
        keyId: makeKeyId(),
        alg: AUTH_ED25519,
        publicKey: (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"),
        privateKey: (pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
        createdAt: now,
      }
    } else {
      fresh = { keyId: makeKeyId(), key: encodeKey(randomBytes(32)), createdAt: now }
    }
    const next: KeyRing = {
      version: 1,
      keys: [fresh, { ...previous, retiredAt: now }, ...res.ring.keys.slice(1)].slice(0, KEY_RING_MAX_KEYS),
    }
    try {
      await storage.set(KEY_RING_STORAGE_KEY, next)
    } catch (err: any) {
      return fail("AUTH_UNAVAILABLE", `could not write the rotated key ring (${String(err?.message ?? err).slice(0, 120)})`)
    }
    let reread: unknown
    try {
      reread = await storage.get(KEY_RING_STORAGE_KEY)
    } catch (err: any) {
      return fail("AUTH_UNAVAILABLE", `could not re-read the rotated key ring (${String(err?.message ?? err).slice(0, 120)})`)
    }
    try {
      const checked = validateRing(reread)
      cached = checked
      ringCache.set(storage as object, checked)
      resolvedAlg = alg
      return { ok: true, keyId: checked.keys[0].keyId }
    } catch (err) {
      return failureFromError(err, "AUTH_KEY_CORRUPT")
    }
  }

  const witnessReceipt = async (runId: string, relPath: string): Promise<string | undefined> => {
    if (!storageUsable) return undefined
    try {
      const value = await storage.get(witnessKey(runId, relPath))
      return typeof (value as any)?.receipt === "string" ? (value as any).receipt : undefined
    } catch {
      return undefined
    }
  }

  const verifyWitnessReceipt = async (
    runId: string,
    relPath: string,
    expected: { digest?: string; nonce?: string } = {},
  ): Promise<WitnessCheck> => {
    if (!storageUsable) {
      return {
        status: "unknown",
        failure: { code: "AUTH_UNAVAILABLE", message: "ctx.storage is unavailable; cannot read the witness receipt" },
      }
    }
    let value: any
    try {
      value = await storage.get(witnessKey(runId, relPath))
    } catch (err: any) {
      return {
        status: "unknown",
        failure: {
          code: "AUTH_UNAVAILABLE",
          message: `could not read the witness receipt (${String(err?.message ?? err).slice(0, 120)})`,
        },
      }
    }
    if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        status: "missing",
        failure: {
          code: "AUTH_WITNESS_UNAVAILABLE",
          message: `no witness receipt was recorded for ${relPath}`,
        },
      }
    }
    const config = (() => {
      try {
        return getWitness()
      } catch (err: any) {
        return { error: err } as any
      }
    })()
    if ((config as any)?.error) {
      const failure = (config as any).error?.failure as AuthFailure | undefined
      return {
        status: "invalid",
        failure: failure ?? {
          code: "AUTH_WITNESS_UNAVAILABLE",
          message: String((config as any).error?.message ?? "witness configuration is invalid").slice(0, 200),
        },
      }
    }
    // No verify key: today's detection-only behavior. Never call this verified.
    if (!config?.publicKey) {
      return { status: "unverified", ...(typeof value.at === "string" ? { at: value.at } : {}) }
    }
    const record = value.record
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {
        status: "invalid",
        failure: { code: "AUTH_INVALID", message: `the witness receipt for ${relPath} has no recorded request` },
      }
    }
    if (record.runId !== runId || record.path !== relPath) {
      return {
        status: "invalid",
        failure: {
          code: "AUTH_INVALID",
          message: `the witness receipt for ${relPath} was recorded for ${String(record.runId)}/${String(record.path)}; it is foreign`,
        },
      }
    }
    const digest = expected.digest ?? (typeof record.digest === "string" ? record.digest : undefined)
    const nonce = expected.nonce ?? (typeof record.nonce === "string" ? record.nonce : undefined)
    if (!digest || !SHA256_HEX.test(digest) || nonce === undefined) {
      return {
        status: "invalid",
        failure: { code: "AUTH_INVALID", message: `the witness receipt for ${relPath} does not bind a digest and nonce` },
      }
    }
    if (
      (expected.digest !== undefined && record.digest !== expected.digest) ||
      (expected.nonce !== undefined && record.nonce !== expected.nonce)
    ) {
      return {
        status: "invalid",
        failure: {
          code: "AUTH_INVALID",
          message: `the witness receipt for ${relPath} covers a different digest/nonce than the artifact`,
        },
      }
    }
    if (value.alg !== AUTH_ED25519 || value.keyId !== config.keyId) {
      return {
        status: "invalid",
        failure: {
          code: "AUTH_INVALID",
          message: `the witness receipt for ${relPath} is not a ${AUTH_ED25519} receipt from witness key ${String(config.keyId)}`,
        },
      }
    }
    const sig = decodeBase64Url(value.sig)
    if (!sig || sig.length !== 64) {
      return {
        status: "invalid",
        failure: { code: "AUTH_INVALID", message: `the witness receipt for ${relPath} has no 64-byte signature` },
      }
    }
    const at = typeof value.at === "string" ? value.at : undefined
    if (!at) {
      return {
        status: "invalid",
        failure: { code: "AUTH_INVALID", message: `the witness receipt for ${relPath} has no signed time` },
      }
    }
    const publicKey = ed25519PublicKeyObject(config.publicKey)
    const message = witnessSignatureInput(runId, relPath, digest, nonce, at)
    if (!publicKey || !cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)) {
      return {
        status: "invalid",
        failure: { code: "AUTH_INVALID", message: `the witness receipt signature for ${relPath} is invalid` },
      }
    }
    return { status: "verified", keyId: config.keyId, at }
  }

  return {
    configured: !!env[ENV_KEY] || !!env[ENV_ED25519_PRIVATE_KEY] || !!env[ENV_ED25519_PUBLIC_KEY] || !!env[ENV_SIGNER] || storageUsable,
    get signerConfigured() {
      return !!env[ENV_SIGNER]
    },
    get witnessConfigured() {
      return !!env[ENV_WITNESS]
    },
    ready,
    currentKeyId: () => cached?.keys?.[0]?.keyId ?? getSigner()?.keyId,
    signingAlg: () => resolvedAlg,
    signArtifact,
    signRunArtifact,
    verifyArtifact,
    verifyRunArtifact,
    writeIndex,
    rotate,
    bindRunNonce,
    runNonce,
    bindRunKeyId,
    runKeyId,
    hasWitnessReceipt: async (runId, relPath) => (await witnessReceipt(runId, relPath)) !== undefined,
    witnessReceipt,
    verifyWitnessReceipt,
  }
}
