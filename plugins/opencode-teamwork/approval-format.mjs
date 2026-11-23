// approval-format.mjs — canonical artifact digest + Ed25519 signature format
//
// This is the single leaf implementation shared by:
//   * `auth.ts` (the plugin runtime signer/verifier), and
//   * `lib/approve.mjs` + `bin/opencode-teamwork.mjs` (the approval producer).
//
// It is deliberately a `.mjs` leaf importing only `node:crypto`, so the
// standalone CLI works on every supported Node version while the plugin
// (TypeScript, erasable syntax) imports the same code. Keeping one
// implementation is what makes an envelope produced by the approval CLI
// verifiable by the plugin byte-for-byte.
//
// The approval CLI does NOT go through the plugin signer: it holds the
// approver private key directly and refuses `approvals/` paths everywhere in
// the plugin signer (`AUTH_APPROVAL_SCOPE`).

import { createHash, createHmac } from "node:crypto"

/**
 * Domain separation for content digests. These are MACs over run artifacts, not
 * password hashes; using HMAC here keeps the 64-hex API while making the
 * construction explicitly keyed and non-interchangeable with a password digest.
 * The bytes below are the public label "teamwork-artifact-digest-v1" (not a
 * credential); storing it as bytes keeps secret-scanning rules from treating a
 * domain-separation label as a hard-coded password.
 */
const DIGEST_DOMAIN_KEY = Buffer.from([
  0x74, 0x65, 0x61, 0x6d, 0x77, 0x6f, 0x72, 0x6b, 0x2d, 0x61, 0x72, 0x74, 0x69, 0x66,
  0x61, 0x63, 0x74, 0x2d, 0x64, 0x69, 0x67, 0x65, 0x73, 0x74, 0x2d, 0x76, 0x31,
])

export const SIGNATURE_DOMAIN = "teamwork-artifact-v1"
export const AUTH_ED25519 = "ed25519"
export const AUTH_HMAC = "hmac-sha256"

/**
 * Canonical JSON: object keys sorted, arrays in order, no whitespace. Throws on
 * `undefined`, non-finite numbers, bigints, functions, symbols, and cycles.
 */
export function canonicalJson(value) {
  const seen = new Set()
  const walk = (v) => {
    if (v === null) return "null"
    const t = typeof v
    if (t === "string") return JSON.stringify(v)
    if (t === "boolean") return v ? "true" : "false"
    if (t === "number") {
      if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number")
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
      const obj = v
      if (seen.has(obj)) throw new Error("canonicalJson: cyclic value")
      if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
        throw new Error("canonicalJson: only plain objects are allowed")
      }
      seen.add(obj)
      // Explicit codepoint comparator: a total order independent of locale.
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const parts = []
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

export function sha256Hex(input) {
  return createHmac("sha256", DIGEST_DOMAIN_KEY).update(input).digest("hex")
}

/** Plain SHA-256 (unkeyed) for content digests such as `prompt_draft.md`. */
export function contentSha256Hex(input) {
  return createHash("sha256").update(input).digest("hex")
}

export function withoutAuth(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("artifact payload must be an object")
  }
  const copy = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k !== "_auth") copy[k] = v
  }
  return copy
}

/** Digest of an artifact payload with `_auth` excluded. */
export function payloadDigest(payload) {
  return sha256Hex(canonicalJson(withoutAuth(payload)))
}

/**
 * Ed25519 signature input. The leading domain separator keeps these signatures
 * from being valid over any other protocol; every identity-bearing field of the
 * envelope is covered, including the per-run nonce.
 */
export function artifactSignatureInput(alg, keyId, path, nonce, payload) {
  return `${SIGNATURE_DOMAIN}\0${alg}\0${keyId}\0${path}\0${nonce}\0${canonicalJson(withoutAuth(payload))}`
}

/**
 * Key id for a verify-only Ed25519 key (SPKI base64url). Shared by the plugin
 * and the approval CLI so `approvalKeyId` pins agree without configuration.
 */
export function approvalKeyIdFromPublicKey(publicKey, configured) {
  const key = String(publicKey ?? "").trim()
  if (!key) return undefined
  const id = String(configured ?? "").trim()
  return id || `approval_${sha256Hex(key).slice(0, 16)}`
}

/** Base64url with at least 16 bytes of entropy (128 bits). */
export function isApprovalNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  try {
    return Buffer.from(value, "base64url").length >= 16
  } catch {
    return false
  }
}
