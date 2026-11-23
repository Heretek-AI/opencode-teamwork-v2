// opencode-teamwork — artifact authenticity (Phase A)
//
// Zero runtime dependencies. Erasable TypeScript only (compatible with Node
// 22/24/26 `--experimental-strip-types`).
//
// What this module protects
// -------------------------
// A writer who can only touch the run directory (`.opencode/teamwork/<id>/`)
// cannot forge a PASS: every control-plane artifact (run manifest, verifier
// report, security audit, strict-wave verdict, victory verdict, final verdict)
// carries an HMAC-SHA256 envelope over its own path + canonical payload, and a
// digest index lives in `ctx.storage`, outside the run directory.
//
// What it does NOT protect
// ------------------------
// A same-UID shell with read access to `opencode.db` (or to the plugin KV file)
// can read the key and compute a valid MAC. This phase makes the run-dir-only
// forgery tamper-evident; it does not isolate the key from the user account.
// See docs/adr/0005-artifact-authenticity.md for the exact boundary and the
// Phase B options.
//
// Canonical JSON is deliberately tiny and opinionated: sorted object keys,
// stable array order, no `undefined`, no non-finite numbers, no cycles. The
// digest covers exactly that encoding, so two processes that wrote the same
// logical payload compute the same digest.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const AUTH_ALG = "hmac-sha256"
export const AUTH_VERSION = 1
export const KEY_RING_STORAGE_KEY = "auth/key/ring"
export const ENV_KEY = "OPENCODE_TEAMWORK_HMAC_KEY"
export const ENV_KEY_ID = "OPENCODE_TEAMWORK_HMAC_KEY_ID"
const KEY_RING_MAX_KEYS = 3

export type AuthFailureCode =
  | "AUTH_UNAVAILABLE"
  | "AUTH_KEY_CORRUPT"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "AUTH_UNKNOWN_KEY"
  | "AUTH_INDEX_MISSING"
  | "AUTH_STALE"
  | "AUTH_LEGACY"

export interface AuthFailure {
  code: AuthFailureCode
  message: string
}

export interface AuthEnvelope {
  v: 1
  alg: "hmac-sha256"
  keyId: string
  path: string
  digest: string
  mac: string
  at: string
}

export interface AuthIndexRecord {
  v: 1
  path: string
  digest: string
  keyId: string
  mac: string
  at: string
}

export interface KeyRecord {
  keyId: string
  /** base64url-encoded 32-byte secret. */
  key: string
  createdAt: string
  retiredAt?: string
}

export interface KeyRing {
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

// ---------------------------------------------------------------------------
// Canonical JSON / hashing / HMAC
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, arrays in order, no whitespace. Throws on
 * `undefined`, non-finite numbers, bigints, functions, symbols, and cycles.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const walk = (v: unknown): string => {
    if (v === null) return "null"
    const t = typeof v
    if (t === "string") return JSON.stringify(v)
    if (t === "boolean") return v ? "true" : "false"
    if (t === "number") {
      if (!Number.isFinite(v as number)) throw new Error("canonicalJson: non-finite number")
      return JSON.stringify(v)
    }
    if (t === "undefined") throw new Error("canonicalJson: undefined is not allowed")
    if (t === "bigint") throw new Error("canonicalJson: bigint is not allowed")
    if (t === "function" || t === "symbol") throw new Error(`canonicalJson: ${t} is not allowed`)
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error("canonicalJson: cyclic value")
      seen.add(v)
      const out = `[${v.map((item) => walk(item)).join(",")}]`
      seen.delete(v)
      return out
    }
    if (t === "object") {
      const obj = v as Record<string, unknown>
      if (seen.has(obj)) throw new Error("canonicalJson: cyclic value")
      if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
        throw new Error("canonicalJson: only plain objects are allowed")
      }
      seen.add(obj)
      const keys = Object.keys(obj).sort()
      const parts: string[] = []
      for (const key of keys) {
        const item = obj[key]
        if (item === undefined) throw new Error(`canonicalJson: undefined at key "${key}"`)
        parts.push(`${JSON.stringify(key)}:${walk(item)}`)
      }
      seen.delete(obj)
      return `{${parts.join(",")}}`
    }
    throw new Error(`canonicalJson: unsupported type ${t}`)
  }
  return walk(value)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function decodeKey(key: string): Buffer | undefined {
  try {
    const buf = Buffer.from(key, "base64url")
    return buf.length === 32 ? buf : undefined
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
export function timingSafeEqualHex(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) return false
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  } catch {
    return false
  }
}

function withoutAuth(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("artifact payload must be an object")
  }
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (k !== "_auth") copy[k] = v
  }
  return copy
}

/** Digest of an artifact payload with `_auth` excluded. */
export function payloadDigest(payload: unknown): string {
  return sha256Hex(canonicalJson(withoutAuth(payload)))
}

function macOver(envelope: Omit<AuthEnvelope, "mac">): string {
  return canonicalJson(envelope)
}

// ---------------------------------------------------------------------------
// Key ring
// ---------------------------------------------------------------------------

function makeKeyId(): string {
  return `k_${randomBytes(8).toString("hex")}`
}

function validateRing(raw: unknown): { ok: true; ring: KeyRing } | { ok: false; failure: AuthFailure } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("AUTH_KEY_CORRUPT", "auth/key/ring is not an object")
  }
  const ring = raw as any
  if (ring.version !== 1) return fail("AUTH_KEY_CORRUPT", `auth/key/ring version must be 1 (got ${String(ring.version)})`)
  if (!Array.isArray(ring.keys) || ring.keys.length === 0) {
    return fail("AUTH_KEY_CORRUPT", "auth/key/ring has no keys")
  }
  if (ring.keys.length > KEY_RING_MAX_KEYS) {
    return fail("AUTH_KEY_CORRUPT", `auth/key/ring has ${ring.keys.length} keys; the maximum is ${KEY_RING_MAX_KEYS}`)
  }
  const keys: KeyRecord[] = []
  const seen = new Set<string>()
  for (let i = 0; i < ring.keys.length; i++) {
    const entry = ring.keys[i]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return fail("AUTH_KEY_CORRUPT", `auth/key/ring keys[${i}] is not an object`)
    }
    const keyId = entry.keyId
    if (typeof keyId !== "string" || keyId.trim() === "" || keyId.length > 128) {
      return fail("AUTH_KEY_CORRUPT", `auth/key/ring keys[${i}].keyId is invalid`)
    }
    if (seen.has(keyId)) return fail("AUTH_KEY_CORRUPT", `auth/key/ring has a duplicate keyId "${keyId}"`)
    seen.add(keyId)
    if (typeof entry.key !== "string" || !decodeKey(entry.key)) {
      return fail("AUTH_KEY_CORRUPT", `auth/key/ring keys[${i}].key is not a base64url 32-byte key`)
    }
    if (typeof entry.createdAt !== "string" || entry.createdAt.trim() === "") {
      return fail("AUTH_KEY_CORRUPT", `auth/key/ring keys[${i}].createdAt is missing`)
    }
    if (entry.retiredAt !== undefined && (typeof entry.retiredAt !== "string" || entry.retiredAt.trim() === "")) {
      return fail("AUTH_KEY_CORRUPT", `auth/key/ring keys[${i}].retiredAt is invalid`)
    }
    keys.push({
      keyId,
      key: entry.key,
      createdAt: entry.createdAt,
      ...(entry.retiredAt !== undefined ? { retiredAt: entry.retiredAt } : {}),
    })
  }
  return { ok: true, ring: { version: 1, keys } }
}

// Shared across every AuthContext over the same storage object so a rotation
// performed by one caller is visible to the plugin's long-lived context.
const ringCache = new WeakMap<object, KeyRing>()

function envRing(env: Record<string, string | undefined>): AuthResult<{ ring: KeyRing; source: "env" }> {
  const raw = env[ENV_KEY]
  if (!raw) return fail("AUTH_UNAVAILABLE", `${ENV_KEY} is not set`)
  const key = raw.trim()
  if (!decodeKey(key)) return fail("AUTH_KEY_CORRUPT", `${ENV_KEY} is not a base64url 32-byte key`)
  const keyId = (env[ENV_KEY_ID] || "env").trim() || "env"
  const now = new Date().toISOString()
  return {
    ok: true,
    ring: { version: 1, keys: [{ keyId, key, createdAt: now }] },
    source: "env",
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

export interface AuthContext {
  /** True when a key source (storage or env) is configured. */
  readonly configured: boolean
  /** Resolve/initialise the ring. Cached after the first success. */
  ready(): Promise<AuthResult<{ keyId: string; source: "storage" | "env" }>>
  /** Current key id, or undefined before `ready()`. */
  currentKeyId(): string | undefined
  /** Sign a payload without touching the index. Throws AuthError. */
  signArtifact(relPath: string, payload: unknown): Promise<any>
  /** Sign and record the digest index entry for `<runId>/<relPath>`. */
  signRunArtifact(runId: string, relPath: string, payload: unknown): Promise<any>
  /** Verify a signed payload (key + path + digest + MAC). */
  verifyArtifact(relPath: string, payload: unknown): Promise<AuthResult<{ auth: AuthEnvelope; keyId: string }>>
  /** Verify a payload and its persistent digest index entry. */
  verifyRunArtifact(runId: string, relPath: string, payload: unknown): Promise<ArtifactCheck>
  /** Write/refresh the index entry from an envelope (advances to new payload). */
  writeIndex(runId: string, relPath: string, auth: AuthEnvelope): Promise<AuthResult<{}>>
  /** Rotate to a fresh key (previous keys remain verifiable, max 3 total). */
  rotate(): Promise<AuthResult<{ keyId: string }>>
}

export function createAuthContext(storage: StorageLike | undefined, env: Record<string, string | undefined> = {}): AuthContext {
  const storageUsable =
    !!storage &&
    typeof storage.get === "function" &&
    typeof storage.set === "function"
  let cached: KeyRing | null = null
  let source: "storage" | "env" = env[ENV_KEY] ? "env" : "storage"

  const pull = async (): Promise<AuthResult<{ ring: KeyRing; source: "storage" | "env" }>> => {
    if (env[ENV_KEY]) {
      source = "env"
      return envRing(env)
    }
    source = "storage"
    if (!storageUsable) {
      return fail("AUTH_UNAVAILABLE", "ctx.storage is unavailable and no env HMAC key is set")
    }
    if (cached) return { ok: true, ring: cached, source: "storage" }
    const shared = ringCache.get(storage as object)
    if (shared) {
      cached = shared
      return { ok: true, ring: shared, source: "storage" }
    }
    let existing: unknown
    try {
      existing = await storage.get(KEY_RING_STORAGE_KEY)
    } catch (err: any) {
      return fail("AUTH_UNAVAILABLE", `could not read auth/key/ring (${String(err?.message ?? err).slice(0, 120)})`)
    }
    if (existing === undefined || existing === null) {
      const created: KeyRing = {
        version: 1,
        keys: [{ keyId: makeKeyId(), key: encodeKey(randomBytes(32)), createdAt: new Date().toISOString() }],
      }
      try {
        await storage.set(KEY_RING_STORAGE_KEY, created)
      } catch (err: any) {
        return fail("AUTH_UNAVAILABLE", `could not write auth/key/ring (${String(err?.message ?? err).slice(0, 120)})`)
      }
      // Re-read is authoritative. If another process won the create race we
      // adopt the persisted ring instead of silently using ours.
      let reread: unknown
      try {
        reread = await storage.get(KEY_RING_STORAGE_KEY)
      } catch (err: any) {
        return fail("AUTH_UNAVAILABLE", `could not re-read auth/key/ring (${String(err?.message ?? err).slice(0, 120)})`)
      }
      const checked = validateRing(reread ?? created)
      if (!checked.ok) return checked
      cached = checked.ring
      ringCache.set(storage as object, checked.ring)
      return { ok: true, ring: checked.ring, source: "storage" }
    }
    const checked = validateRing(existing)
    if (!checked.ok) return checked
    cached = checked.ring
    ringCache.set(storage as object, checked.ring)
    return { ok: true, ring: checked.ring, source: "storage" }
  }

  const ready = async () => {
    const res = await pull()
    if (!res.ok) return res
    return { ok: true as const, keyId: res.ring.keys[0].keyId, source: res.source }
  }

  const signArtifact = async (relPath: string, payload: unknown): Promise<any> => {
    const res = await pull()
    if (!res.ok) throw new AuthError(res.failure)
    if (typeof relPath !== "string" || relPath.trim() === "") {
      throw new AuthError({ code: "AUTH_INVALID", message: "artifact path is empty" })
    }
    const key = res.ring.keys[0]
    let digest: string
    try {
      digest = payloadDigest(payload)
    } catch (err: any) {
      throw new AuthError({ code: "AUTH_INVALID", message: `payload is not canonicalisable (${String(err?.message ?? err)})` })
    }
    const base: Omit<AuthEnvelope, "mac"> = {
      v: 1,
      alg: AUTH_ALG,
      keyId: key.keyId,
      path: relPath,
      digest,
      at: new Date().toISOString(),
    }
    const mac = hmacHex(key.key, macOver(base))
    if (!mac) throw new AuthError({ code: "AUTH_KEY_CORRUPT", message: "current key cannot be decoded" })
    return { ...(payload as Record<string, unknown>), _auth: { ...base, mac } as AuthEnvelope }
  }

  const verifyArtifact = async (
    relPath: string,
    payload: unknown,
  ): Promise<AuthResult<{ auth: AuthEnvelope; keyId: string }>> => {
    const res = await pull()
    if (!res.ok) return res
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("AUTH_INVALID", "artifact is not an object")
    }
    const auth = (payload as any)._auth
    if (auth === undefined || auth === null) return fail("AUTH_MISSING", "artifact has no _auth envelope")
    if (typeof auth !== "object" || Array.isArray(auth)) return fail("AUTH_INVALID", "_auth is not an object")
    if (auth.v !== 1) return fail("AUTH_INVALID", `_auth.v must be 1 (got ${String(auth.v)})`)
    if (auth.alg !== AUTH_ALG) return fail("AUTH_INVALID", `_auth.alg must be ${AUTH_ALG} (got ${String(auth.alg)})`)
    if (auth.path !== relPath) {
      return fail("AUTH_INVALID", `_auth.path ${String(auth.path)} does not match ${relPath}`)
    }
    if (typeof auth.keyId !== "string" || auth.keyId.trim() === "") {
      return fail("AUTH_INVALID", "_auth.keyId is missing")
    }
    if (!SHA256_HEX.test(String(auth.digest ?? "")) || !SHA256_HEX.test(String(auth.mac ?? ""))) {
      return fail("AUTH_INVALID", "_auth digest/mac is not a sha256 hex string")
    }
    const key = res.ring.keys.find((k) => k.keyId === auth.keyId)
    if (!key) {
      return fail("AUTH_UNKNOWN_KEY", `_auth.keyId ${auth.keyId} is not in the current key ring`)
    }
    let digest: string
    try {
      digest = payloadDigest(payload)
    } catch (err: any) {
      return fail("AUTH_INVALID", `payload is not canonicalisable (${String(err?.message ?? err)})`)
    }
    if (!timingSafeEqualHex(digest, auth.digest)) {
      return fail("AUTH_INVALID", "artifact digest does not match its _auth envelope")
    }
    const expected = hmacHex(
      key.key,
      macOver({
        v: 1,
        alg: AUTH_ALG,
        keyId: auth.keyId,
        path: auth.path,
        digest: auth.digest,
        at: auth.at,
      }),
    )
    if (!expected || !timingSafeEqualHex(expected, auth.mac)) {
      return fail("AUTH_INVALID", "artifact MAC is invalid")
    }
    return { ok: true, auth: auth as AuthEnvelope, keyId: key.keyId }
  }

  const indexKey = (runId: string, relPath: string) => `auth/run/${runId}/${relPath}`

  const writeIndex = async (runId: string, relPath: string, auth: AuthEnvelope): Promise<AuthResult<{}>> => {
    if (!storageUsable) {
      return fail("AUTH_UNAVAILABLE", "ctx.storage is unavailable; cannot record the digest index")
    }
    const record: AuthIndexRecord = {
      v: 1,
      path: relPath,
      digest: auth.digest,
      keyId: auth.keyId,
      mac: auth.mac,
      at: auth.at,
    }
    try {
      await storage.set(indexKey(runId, relPath), record)
    } catch (err: any) {
      return fail("AUTH_UNAVAILABLE", `could not write ${indexKey(runId, relPath)} (${String(err?.message ?? err).slice(0, 120)})`)
    }
    return { ok: true }
  }

  const signRunArtifact = async (runId: string, relPath: string, payload: unknown): Promise<any> => {
    const signed = await signArtifact(relPath, payload)
    const written = await writeIndex(runId, relPath, signed._auth)
    if (!written.ok) throw new AuthError(written.failure)
    return signed
  }

  const verifyRunArtifact = async (runId: string, relPath: string, payload: unknown): Promise<ArtifactCheck> => {
    const verified = await verifyArtifact(relPath, payload)
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
    const stale =
      rec?.v !== 1 ||
      rec?.path !== relPath ||
      rec?.keyId !== verified.auth.keyId ||
      rec?.digest !== verified.auth.digest ||
      !timingSafeEqualHex(rec?.mac, verified.auth.mac) ||
      rec?.at !== verified.auth.at
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

  const rotate = async (): Promise<AuthResult<{ keyId: string }>> => {
    if (env[ENV_KEY]) {
      return fail("AUTH_UNAVAILABLE", `${ENV_KEY} pins a single key; rotation is a storage-key operation`)
    }
    if (!storageUsable) return fail("AUTH_UNAVAILABLE", "ctx.storage is unavailable; cannot rotate")
    const res = await pull()
    if (!res.ok) return res
    const now = new Date().toISOString()
    const previous = res.ring.keys[0]
    const next: KeyRing = {
      version: 1,
      keys: [
        { keyId: makeKeyId(), key: encodeKey(randomBytes(32)), createdAt: now },
        { ...previous, retiredAt: now },
        ...res.ring.keys.slice(1),
      ].slice(0, KEY_RING_MAX_KEYS),
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
    const checked = validateRing(reread)
    if (!checked.ok) return checked
    cached = checked.ring
    ringCache.set(storage as object, checked.ring)
    return { ok: true, keyId: checked.ring.keys[0].keyId }
  }

  return {
    configured: !!env[ENV_KEY] || storageUsable,
    ready,
    currentKeyId: () => cached?.keys?.[0]?.keyId,
    signArtifact,
    signRunArtifact,
    verifyArtifact,
    verifyRunArtifact,
    writeIndex,
    rotate,
  }
}
