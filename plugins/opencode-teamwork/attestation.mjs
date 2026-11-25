// attestation.mjs — signed CI attestation artifact + policy evaluation (0.18.0)
//
// A CI attestation is an `_auth`-signed JSON document at
// `verify/ci/attestation.json` produced outside the agent's process by a CI
// principal holding a private key the run does not have. It records what the
// CI actually observed — the repository, commit, base, plan, prompt digest and
// the argv/exit/output digest of every command it ran — and is signed with a
// key that must be distinct from the run's `runKeyId`.
//
// This module is the single leaf implementation shared by:
//   * `lib/verify.mjs` (offline verifier / `verify` CLI),
//   * `plugins/opencode-teamwork/tools.ts` (`final_verify`), and
//   * `scripts/attest-sign.mjs` (the CI/dev producer).
//
// It deliberately imports only `node:crypto` and the same canonical format the
// rest of the envelope code uses, so the producer and both verifiers cannot
// drift. It does not execute anything and makes no network calls.
//
// What a valid attestation proves
// -------------------------------
// A holder of the distinct attestation key signed this exact payload, for this
// run nonce, this plan hash, this commit, and that every command it lists was
// observed with the recorded argv/cwd/exit/output digest that a verifier report
// also records.
//
// What it does NOT prove
// ----------------------
// That the suite is meaningful, that a test was not edited in the same commit,
// that the CI host was not compromised, or that the key holder is independent
// of the agent's UID. See SECURITY.md.

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto"
import {
  attestationSignatureInput,
  contentSha256Hex,
  isApprovalNonce,
  payloadDigest,
  sha256Hex,
  withoutAuth,
} from "./approval-format.mjs"

export const ATTESTATION_PATH = "verify/ci/attestation.json"
const ATTESTATION_VERSION = 1
const ATTESTATION_ALG = "ed25519"
const ATTESTATION_MAX_COMMANDS = 64
const ATTESTATION_MAX_ARGV = 32
const ATTESTATION_MAX_ARG_BYTES = 4096

/**
 * Manifest `attestationPolicy`. `off` is the default and ignores any artifact;
 * `optional` records a status but never fails the run; `required` makes a
 * missing/invalid attestation a named refusal. The order is the downgrade
 * ladder: a re-plan may move right (upgrade) but never left.
 */
const ATTESTATION_POLICY_MODES = ["off", "optional", "required"]

export const ENV_ATTESTATION_PUBLIC_KEY = "OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY"
export const ENV_ATTESTATION_KEY_ID = "OPENCODE_TEAMWORK_ATTESTATION_KEY_ID"
export const ENV_ATTESTATION_ISSUER = "OPENCODE_TEAMWORK_ATTESTATION_ISSUER"

const OIDC_SUPPORTED_ALGS = new Set(["RS256", "ES256", "EdDSA"])
const DEFAULT_OIDC_CLOCK_SKEW_MS = 60_000

const SHA256_HEX = /^[0-9a-f]{64}$/
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

export const ATTESTATION_CODES = {
  missing: "AUTH_ATTESTATION_MISSING",
  stale: "AUTH_ATTESTATION_STALE",
  untrusted: "AUTH_ATTESTATION_UNTRUSTED",
  commitMismatch: "AUTH_ATTESTATION_COMMIT_MISMATCH",
  replay: "AUTH_ATTESTATION_REPLAY",
}

export function normalizeAttestationPolicy(value) {
  return ATTESTATION_POLICY_MODES.includes(value) ? value : undefined
}

export function attestationPolicyRank(value) {
  const index = ATTESTATION_POLICY_MODES.indexOf(value)
  return index < 0 ? 0 : index
}

/** Manifest authority for the policy: versions before 5 are always `off`. */
export function manifestAttestationPolicy(manifest) {
  if (!manifest || Number(manifest.version) < 5) return "off"
  return normalizeAttestationPolicy(manifest.attestationPolicy) ?? "off"
}

function safeDecodeBase64Url(value) {
  if (typeof value !== "string" || value === "" || !BASE64URL.test(value)) return undefined
  try {
    const buf = Buffer.from(value, "base64url")
    return buf.length > 0 ? buf : undefined
  } catch {
    return undefined
  }
}

function keyObjectFromSpki(value) {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return undefined
  try {
    if (raw.includes("BEGIN")) return createPublicKey(raw)
    const der = safeDecodeBase64Url(raw)
    if (!der) return undefined
    return createPublicKey({ key: der, format: "der", type: "spki" })
  } catch {
    return undefined
  }
}

function spkiOf(publicKey) {
  try {
    return publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  } catch {
    return undefined
  }
}

/** Load a verify-only SPKI Ed25519 public key (base64url or PEM). */
export function loadAttestationPublicKey(value) {
  const key = keyObjectFromSpki(value)
  if (!key || key.asymmetricKeyType !== "ed25519") return undefined
  return key
}

/** Load a PKCS#8 Ed25519 private key (base64url or PEM). Producer/test only. */
export function loadAttestationPrivateKey(value) {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return undefined
  try {
    const key = raw.includes("BEGIN")
      ? createPrivateKey(raw)
      : createPrivateKey({ key: safeDecodeBase64Url(raw) ?? Buffer.alloc(0), format: "der", type: "pkcs8" })
    return key.asymmetricKeyType === "ed25519" ? key : undefined
  } catch {
    return undefined
  }
}

/** Base64url SPKI for a private key, for key-id derivation and output. */
export function publicKeyFromAttestationPrivateKey(privateKey) {
  try {
    return spkiOf(createPublicKey(privateKey))
  } catch {
    return undefined
  }
}

/**
 * Key id for a verify-only CI key. A configured id wins; otherwise it is a
 * digest of the SPKI bytes, matching the approval/witness convention.
 */
export function attestationKeyIdFromPublicKey(publicKey, configured) {
  const id = String(configured ?? "").trim()
  if (id) return id
  const raw = typeof publicKey === "string" ? publicKey.trim() : ""
  if (!raw) return undefined
  return `attestation_${sha256Hex(raw).slice(0, 16)}`
}

function fail(code, message) {
  return { ok: false, code, message }
}

function normalizeCwd(value) {
  if (value === undefined || value === null || value === "") return { cwd: "." }
  if (typeof value !== "string") return { error: "cwd is not a string" }
  if (value.includes("\0")) return { error: "cwd contains a NUL byte" }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return { error: "cwd is absolute" }
  if (value.startsWith("~")) return { error: "cwd starts with ~" }
  const segments = value.split("/")
  if (segments.includes("..")) return { error: "cwd escapes the worktree (..)" }
  const cwd = segments.filter((segment) => segment !== "" && segment !== ".").join("/")
  return { cwd: cwd === "" ? "." : cwd }
}

function checkArgv(argv) {
  if (!Array.isArray(argv)) return "argv is not an array"
  if (argv.length === 0) return "argv is empty"
  if (argv.length > ATTESTATION_MAX_ARGV) return `argv has ${argv.length} args (cap ${ATTESTATION_MAX_ARGV})`
  for (const arg of argv) {
    if (typeof arg !== "string" || arg === "") return "argv contains a non-string or empty arg"
    if (arg.includes("\0")) return "argv contains a NUL byte"
    if (Buffer.byteLength(arg, "utf8") > ATTESTATION_MAX_ARG_BYTES) {
      return `argv arg exceeds ${ATTESTATION_MAX_ARG_BYTES} bytes`
    }
  }
  return undefined
}

function isoTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Validate the unsigned attestation payload shape. Returns [] for a valid
 * document; every string names a field, never echoes attacker-controlled data.
 */
function attestationPayloadProblems(payload) {
  const problems = []
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["attestation is not an object"]
  }
  if (payload.v !== ATTESTATION_VERSION) problems.push("v must be 1")
  if (typeof payload.provider !== "string" || payload.provider.trim() === "") problems.push("provider is missing")
  if (typeof payload.workflow !== "string" || payload.workflow.trim() === "") problems.push("workflow is missing")
  if (typeof payload.runId !== "string" || payload.runId.trim() === "") problems.push("runId is missing")
  if (!Number.isInteger(payload.runAttempt) || payload.runAttempt < 1) problems.push("runAttempt must be a positive integer")
  if (typeof payload.repository !== "string" || payload.repository.trim() === "") problems.push("repository is missing")
  if (!GIT_SHA.test(String(payload.commitSha ?? ""))) problems.push("commitSha is not a 40/64-hex git id")
  if (payload.baseSha !== undefined && payload.baseSha !== "" && !GIT_SHA.test(String(payload.baseSha))) {
    problems.push("baseSha is not a 40/64-hex git id")
  }
  if (!SHA256_HEX.test(String(payload.promptHash ?? ""))) problems.push("promptHash is not a sha256 hex digest")
  if (!SHA256_HEX.test(String(payload.planHash ?? ""))) problems.push("planHash is not a sha256 hex digest")
  if (payload.manifestDigest !== undefined && !SHA256_HEX.test(String(payload.manifestDigest))) {
    problems.push("manifestDigest is not a sha256 hex digest")
  }
  if (!Array.isArray(payload.commands)) {
    problems.push("commands is not an array")
  } else if (payload.commands.length > ATTESTATION_MAX_COMMANDS) {
    problems.push(`commands has ${payload.commands.length} entries (cap ${ATTESTATION_MAX_COMMANDS})`)
  } else {
    payload.commands.forEach((command, index) => {
      if (!command || typeof command !== "object" || Array.isArray(command)) {
        problems.push(`commands[${index}] is not an object`)
        return
      }
      const argvProblem = checkArgv(command.argv)
      if (argvProblem) problems.push(`commands[${index}] ${argvProblem}`)
      const cwd = normalizeCwd(command.cwd)
      if (cwd.error) problems.push(`commands[${index}] ${cwd.error}`)
      if (!Number.isInteger(command.exitCode)) problems.push(`commands[${index}] exitCode is not an integer`)
      if (!SHA256_HEX.test(String(command.outputSha256 ?? ""))) {
        problems.push(`commands[${index}] outputSha256 is not a sha256 hex digest`)
      }
      if (!Number.isInteger(command.outputBytes) || command.outputBytes < 0) {
        problems.push(`commands[${index}] outputBytes is not a non-negative integer`)
      }
    })
  }
  if (!payload.oidc || typeof payload.oidc !== "object" || Array.isArray(payload.oidc)) {
    problems.push("oidc is not an object")
  } else {
    for (const field of ["issuer", "subject", "audience"]) {
      if (typeof payload.oidc[field] !== "string" || payload.oidc[field].trim() === "") {
        problems.push(`oidc.${field} is missing`)
      }
    }
    if (payload.oidc.token !== undefined && (typeof payload.oidc.token !== "string" || payload.oidc.token.trim() === "")) {
      problems.push("oidc.token must be a non-empty string when present")
    }
    if (payload.oidc.ref !== undefined && (typeof payload.oidc.ref !== "string" || payload.oidc.ref.trim() === "")) {
      problems.push("oidc.ref must be a non-empty string when present")
    }
  }
  if (isoTimestamp(payload.issuedAt) === undefined) problems.push("issuedAt is not an ISO timestamp")
  if (isoTimestamp(payload.expiresAt) === undefined) problems.push("expiresAt is not an ISO timestamp")
  return problems
}

/**
 * Sign an attestation payload with a CI private key. The envelope is the same
 * v1 `_auth` shape as every Teamwork artifact, under the attestation domain.
 * `nonce` must be the run manifest nonce; a producer that cannot read it must
 * not sign.
 */
export function signAttestation(payload, { privateKey, keyId, nonce, at = new Date().toISOString(), path = ATTESTATION_PATH } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("attestation payload must be an object")
  }
  if (!privateKey) throw new Error("an Ed25519 private key is required")
  if (typeof keyId !== "string" || keyId.trim() === "") throw new Error("a key id is required")
  if (!isApprovalNonce(nonce)) throw new Error("the attestation nonce must be the run manifest nonce (>=128 bits base64url)")
  const unsigned = { ...payload }
  delete unsigned._auth
  const problems = attestationPayloadProblems(unsigned)
  if (problems.length > 0) throw new Error(`invalid attestation payload: ${problems.join("; ")}`)
  const digest = payloadDigest(unsigned)
  const message = attestationSignatureInput(ATTESTATION_ALG, keyId, path, nonce, unsigned)
  const sig = cryptoSign(null, Buffer.from(message, "utf8"), privateKey)
  return {
    ...unsigned,
    _auth: {
      v: 1,
      alg: ATTESTATION_ALG,
      keyId,
      path,
      digest,
      sig: sig.toString("base64url"),
      nonce,
      at,
    },
  }
}

/**
 * Verify only the envelope (path/digest/nonce/key/signature). Used by callers
 * that need to distinguish an untrusted signature from a binding failure.
 */
function verifyAttestationEnvelope(artifact, { publicKey, expectedKeyId, requireNonce } = {}) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return fail(ATTESTATION_CODES.missing, "attestation is not an object")
  }
  const auth = artifact._auth
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return fail(ATTESTATION_CODES.missing, "attestation has no _auth envelope")
  }
  if (auth.v !== 1) return fail(ATTESTATION_CODES.untrusted, "_auth.v must be 1")
  if (auth.alg !== ATTESTATION_ALG) return fail(ATTESTATION_CODES.untrusted, `_auth.alg must be ${ATTESTATION_ALG}`)
  if (auth.path !== ATTESTATION_PATH) {
    return fail(ATTESTATION_CODES.untrusted, `_auth.path must be ${ATTESTATION_PATH}`)
  }
  if (typeof auth.keyId !== "string" || auth.keyId.trim() === "") {
    return fail(ATTESTATION_CODES.untrusted, "_auth.keyId is missing")
  }
  if (expectedKeyId && auth.keyId !== expectedKeyId) {
    return fail(ATTESTATION_CODES.untrusted, `_auth.keyId does not match the configured attestation key (${expectedKeyId})`)
  }
  if (!SHA256_HEX.test(String(auth.digest ?? ""))) {
    return fail(ATTESTATION_CODES.untrusted, "_auth.digest is not a sha256 hex digest")
  }
  if (!isApprovalNonce(auth.nonce)) {
    return fail(ATTESTATION_CODES.untrusted, "_auth.nonce is not >=128 bits of base64url")
  }
  if (requireNonce !== undefined && auth.nonce !== requireNonce) {
    return fail(ATTESTATION_CODES.replay, "_auth.nonce does not bind the signed run nonce")
  }
  let digest
  try {
    digest = payloadDigest(artifact)
  } catch {
    return fail(ATTESTATION_CODES.untrusted, "attestation payload is not canonicalisable")
  }
  if (digest !== auth.digest) {
    return fail(ATTESTATION_CODES.untrusted, "attestation digest does not match its _auth envelope")
  }
  if (!publicKey) {
    return fail(ATTESTATION_CODES.untrusted, "no attestation public key is configured")
  }
  const sig = safeDecodeBase64Url(auth.sig)
  if (!sig || sig.length !== 64) {
    return fail(ATTESTATION_CODES.untrusted, "_auth.sig is not a 64-byte base64url Ed25519 signature")
  }
  const message = attestationSignatureInput(ATTESTATION_ALG, auth.keyId, auth.path, auth.nonce, artifact)
  let verified = false
  try {
    verified = cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig)
  } catch {
    verified = false
  }
  if (!verified) return fail(ATTESTATION_CODES.untrusted, "attestation Ed25519 signature is invalid")
  return { ok: true, auth }
}

/**
 * Parse a JWKS JSON string or object `{ keys: [...] }` into an array of JWKs.
 * Returns `undefined` when absent or malformed.
 */
function parseOidcJwks(input) {
  if (!input) return undefined
  let parsed = input
  if (typeof input === "string") {
    const trimmed = input.trim()
    if (!trimmed) return undefined
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  const keys = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : undefined
  if (!keys || keys.length === 0) return undefined
  return keys.filter((k) => k && typeof k === "object" && typeof k.kty === "string")
}

function jwkMatchesAlg(jwk, alg) {
  if (jwk.alg && jwk.alg !== alg) return false
  if (alg === "RS256") return jwk.kty === "RSA"
  if (alg === "ES256") return jwk.kty === "EC" && (!jwk.crv || jwk.crv === "P-256")
  if (alg === "EdDSA") return jwk.kty === "OKP" && (!jwk.crv || jwk.crv === "Ed25519")
  return false
}

/**
 * Cryptographically verify a compact OIDC JWT (RS256 / ES256 / EdDSA) against
 * pinned JWKS trust material and bind issuer, audience, subject, repository,
 * ref, commit SHA, and expiry/nbf to the attestation and policy.
 *
 * Strictly offline: never performs network requests. Returns status "UNKNOWN"
 * when no JWKS trust material is supplied.
 */
function verifyOidcToken(
  token,
  {
    jwks,
    expectedIssuer,
    expectedAudience,
    expectedSubject,
    expectedRepository,
    expectedRef,
    expectedCommitSha,
    now = Date.now(),
    clockSkewMs = DEFAULT_OIDC_CLOCK_SKEW_MS,
  } = {},
) {
  if (typeof token !== "string" || token.trim() === "") {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token is missing; a claimed issuer string alone is not sufficient" }
  }
  const parts = token.trim().split(".")
  if (parts.length !== 3) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token is not a 3-part compact JWS" }
  }
  const [headerB64, payloadB64, sigB64] = parts
  const headerBuf = safeDecodeBase64Url(headerB64)
  const payloadBuf = safeDecodeBase64Url(payloadB64)
  const sigBuf = safeDecodeBase64Url(sigB64)
  if (!headerBuf || !payloadBuf || !sigBuf) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token contains invalid base64url encoding" }
  }
  let header
  let claims
  try {
    header = JSON.parse(headerBuf.toString("utf8"))
    claims = JSON.parse(payloadBuf.toString("utf8"))
  } catch {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token header or payload is not valid JSON" }
  }
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object") {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token header/payload must be JSON objects" }
  }
  const alg = header.alg
  if (typeof alg !== "string" || !OIDC_SUPPORTED_ALGS.has(alg)) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: `OIDC token alg ${JSON.stringify(alg ?? null)} is not supported (expected RS256, ES256, or EdDSA)` }
  }

  const keys = parseOidcJwks(jwks)
  if (!keys || keys.length === 0) {
    return { ok: false, status: "UNKNOWN", code: ATTESTATION_CODES.untrusted, message: "no OIDC issuer trust material (JWKS) is configured; cannot verify OIDC token" }
  }

  const candidates = keys.filter((k) => {
    if (!jwkMatchesAlg(k, alg)) return false
    if (header.kid !== undefined && k.kid !== undefined && k.kid !== header.kid) return false
    return true
  })
  if (candidates.length === 0) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: `no matching key in OIDC JWKS for alg=${alg} kid=${JSON.stringify(header.kid ?? null)}` }
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8")
  let verified = false
  for (const jwk of candidates) {
    try {
      const pubKey = createPublicKey({ key: jwk, format: "jwk" })
      if (alg === "RS256") {
        verified = cryptoVerify("sha256", signingInput, pubKey, sigBuf)
      } else if (alg === "ES256") {
        verified = cryptoVerify("sha256", signingInput, { key: pubKey, dsaEncoding: "ieee-p1363" }, sigBuf)
      } else if (alg === "EdDSA") {
        verified = cryptoVerify(null, signingInput, pubKey, sigBuf)
      }
      if (verified) break
    } catch {
      // Try next candidate key.
    }
  }
  if (!verified) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token signature failed cryptographic verification against pinned JWKS" }
  }

  if (typeof claims.iss !== "string" || claims.iss.trim() === "") {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token is missing iss claim" }
  }
  if (expectedIssuer && claims.iss !== expectedIssuer) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: `OIDC token iss ${JSON.stringify(claims.iss)} does not match ${JSON.stringify(expectedIssuer)}` }
  }

  const audList = Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === "string" ? [claims.aud] : []
  if (audList.length === 0) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token is missing aud claim" }
  }
  if (expectedAudience && !audList.includes(expectedAudience)) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: `OIDC token aud does not include ${JSON.stringify(expectedAudience)}` }
  }

  if (typeof claims.sub !== "string" || claims.sub.trim() === "") {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.untrusted, message: "OIDC token is missing sub claim" }
  }
  if (expectedSubject && claims.sub !== expectedSubject) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.replay, message: `OIDC token sub ${JSON.stringify(claims.sub)} does not match ${JSON.stringify(expectedSubject)}` }
  }

  if (!Number.isFinite(claims.exp) || claims.exp * 1000 + clockSkewMs <= now) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.stale, message: "OIDC token is expired or missing exp" }
  }
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 - clockSkewMs > now)) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.stale, message: "OIDC token is not yet valid (nbf)" }
  }

  if (expectedRepository) {
    const tokenRepo = typeof claims.repository === "string" ? claims.repository : undefined
    const subRepoMatch = claims.sub.startsWith(`repo:${expectedRepository}:`)
    if (tokenRepo !== undefined && tokenRepo !== expectedRepository) {
      return { ok: false, status: "INVALID", code: ATTESTATION_CODES.replay, message: `OIDC token repository ${JSON.stringify(tokenRepo)} does not match ${JSON.stringify(expectedRepository)}` }
    }
    if (tokenRepo === undefined && !subRepoMatch) {
      return { ok: false, status: "INVALID", code: ATTESTATION_CODES.replay, message: `OIDC token does not bind repository ${JSON.stringify(expectedRepository)}` }
    }
  }

  if (expectedRef) {
    const tokenRef = typeof claims.ref === "string" ? claims.ref : undefined
    const subRefMatch = claims.sub.includes(`:ref:${expectedRef}`)
    if (tokenRef !== undefined && tokenRef !== expectedRef) {
      return { ok: false, status: "INVALID", code: ATTESTATION_CODES.replay, message: `OIDC token ref ${JSON.stringify(tokenRef)} does not match ${JSON.stringify(expectedRef)}` }
    }
    if (tokenRef === undefined && !subRefMatch) {
      return { ok: false, status: "INVALID", code: ATTESTATION_CODES.replay, message: `OIDC token does not bind ref ${JSON.stringify(expectedRef)}` }
    }
  }

  if (expectedCommitSha && typeof claims.sha === "string" && claims.sha !== expectedCommitSha) {
    return { ok: false, status: "INVALID", code: ATTESTATION_CODES.commitMismatch, message: `OIDC token sha does not match attestation commitSha` }
  }

  return { ok: true, claims }
}

/**
 * Full policy evaluation: envelope, expiry, run binding, commit binding,
 * OIDC claim verification (when enabled or token present), and command/output
 * binding against the verifier reports.
 *
 * Returns:
 *   { status: "OFF" | "MISSING" | "UNKNOWN" | "ATTESTED" | "INVALID",
 *     code?, message?, policy, commitSha?, keyId?, issuer? }
 *
 * `status` is the reporting status; `code` is the named refusal. A caller that
 * enforces the policy fails on status !== "ATTESTED" with `code`.
 */
export function evaluateAttestation({
  artifact,
  policy = "off",
  publicKey,
  expectedKeyId,
  expectedIssuer,
  expectedAudience,
  expectedRepository,
  expectedRef,
  oidcJwks,
  requireOidcToken = false,
  runId,
  runNonce,
  runKeyId,
  planHash,
  promptHash,
  reports = [],
  now = Date.now(),
} = {}) {
  const mode = normalizeAttestationPolicy(policy) ?? "off"
  if (mode === "off") {
    return { status: "OFF", policy: mode }
  }
  const reportHeads = (Array.isArray(reports) ? reports : [])
    .filter((report) => report && typeof report.headSha === "string" && report.headSha !== "")
    .map((report) => ({ taskId: String(report.taskId ?? "?"), headSha: report.headSha }))
  const reportChecks = []
  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || !Array.isArray(report.checks)) continue
    for (const check of report.checks) {
      if (!check || !Array.isArray(check.argv)) continue
      const cwd = normalizeCwd(check.cwd)
      if (cwd.error) continue
      reportChecks.push({
        taskId: String(report.taskId ?? "?"),
        argv: check.argv,
        cwd: cwd.cwd,
        exitCode: Number.isInteger(check.exitCode) ? check.exitCode : undefined,
        output: typeof check.output === "string" ? check.output : "",
        outputTruncated: check.outputTruncated === true,
      })
    }
  }
  const base = { policy: mode }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return {
      ...base,
      status: "MISSING",
      code: ATTESTATION_CODES.missing,
      message: `${ATTESTATION_PATH} is missing`,
    }
  }
  const keyId = typeof artifact._auth?.keyId === "string" ? artifact._auth.keyId : undefined
  const issuer = typeof artifact.oidc?.issuer === "string" ? artifact.oidc.issuer : undefined
  const commitSha = typeof artifact.commitSha === "string" ? artifact.commitSha : undefined
  const reported = { ...base, commitSha, keyId, issuer }

  const payloadProblems = attestationPayloadProblems(withoutAuthSafe(artifact))
  if (payloadProblems.length > 0) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.untrusted,
      message: `attestation payload is malformed: ${payloadProblems.join("; ")}`,
    }
  }
  // The run key is never an attestation identity: a CI attestation signed by
  // the same key as the run is a self-assertion, not a second principal.
  if (runKeyId && keyId === runKeyId) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.untrusted,
      message: "attestation is signed by the run key; a CI attestation must use a distinct key",
    }
  }
  const envelope = verifyAttestationEnvelope(artifact, {
    publicKey,
    expectedKeyId,
    requireNonce: runNonce,
  })
  if (!envelope.ok) {
    return {
      ...reported,
      status: envelope.code === ATTESTATION_CODES.replay ? "INVALID" : publicKey ? "INVALID" : "UNKNOWN",
      code: envelope.code,
      message: envelope.message,
    }
  }
  if (typeof runId === "string" && artifact.runId !== runId) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.replay,
      message: `attestation is for run ${JSON.stringify(artifact.runId)}, not ${JSON.stringify(runId)}`,
    }
  }
  if (expectedIssuer && issuer !== expectedIssuer) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.untrusted,
      message: `attestation issuer ${JSON.stringify(issuer ?? null)} does not match ${JSON.stringify(expectedIssuer)}`,
    }
  }
  const hasOidcToken = typeof artifact.oidc?.token === "string" && artifact.oidc.token.trim() !== ""
  if (requireOidcToken || hasOidcToken || oidcJwks !== undefined) {
    const oidcCheck = verifyOidcToken(artifact.oidc?.token, {
      jwks: oidcJwks,
      expectedIssuer: expectedIssuer ?? issuer,
      expectedAudience: expectedAudience ?? artifact.oidc?.audience,
      expectedSubject: artifact.oidc?.subject,
      expectedRepository: expectedRepository ?? (artifact.repository && artifact.repository !== "unknown/unknown" ? artifact.repository : undefined),
      expectedRef: expectedRef ?? artifact.oidc?.ref,
      expectedCommitSha: artifact.commitSha,
      now,
    })
    if (!oidcCheck.ok) {
      return {
        ...reported,
        status: oidcCheck.status,
        code: oidcCheck.code,
        message: oidcCheck.message,
      }
    }
    if (oidcCheck.claims.iss !== artifact.oidc.issuer) {
      return {
        ...reported,
        status: "INVALID",
        code: ATTESTATION_CODES.untrusted,
        message: "OIDC token iss does not match attestation oidc.issuer",
      }
    }
    if (expectedRepository && artifact.repository !== expectedRepository) {
      return {
        ...reported,
        status: "INVALID",
        code: ATTESTATION_CODES.replay,
        message: `attestation repository ${JSON.stringify(artifact.repository)} does not match ${JSON.stringify(expectedRepository)}`,
      }
    }
  }
  const expiresAt = isoTimestamp(artifact.expiresAt)
  if (expiresAt === undefined || expiresAt <= now) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.stale,
      message: "attestation is expired or has no valid expiresAt",
    }
  }
  if (typeof planHash === "string" && artifact.planHash !== planHash) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.stale,
      message: "attestation planHash does not match the signed manifest planHash",
    }
  }
  if (typeof promptHash === "string" && promptHash !== "" && artifact.promptHash !== promptHash) {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.stale,
      message: "attestation promptHash does not match the signed prompt_draft.md digest",
    }
  }
  for (const report of reportHeads) {
    if (artifact.commitSha !== report.headSha) {
      return {
        ...reported,
        status: "INVALID",
        code: ATTESTATION_CODES.commitMismatch,
        message: `attestation commitSha does not match report ${report.taskId} headSha`,
      }
    }
  }
  for (const command of artifact.commands) {
    const cwd = normalizeCwd(command.cwd)
    const match = reportChecks.find(
      (check) =>
        !check.outputTruncated &&
        check.argv.length === command.argv.length &&
        check.argv.every((arg, index) => arg === command.argv[index]) &&
        check.cwd === cwd.cwd &&
        (check.exitCode === undefined || check.exitCode === command.exitCode) &&
        contentSha256Hex(check.output) === command.outputSha256 &&
        Buffer.byteLength(check.output, "utf8") === command.outputBytes,
    )
    if (!match) {
      return {
        ...reported,
        status: "INVALID",
        code: ATTESTATION_CODES.stale,
        message: `attestation command ${JSON.stringify(command.argv[0] ?? "")} does not match a verifier report check (argv/cwd/exit/output digest)`,
      }
    }
  }
  if (artifact.commands.length === 0 && reportChecks.length > 0 && mode === "required") {
    return {
      ...reported,
      status: "INVALID",
      code: ATTESTATION_CODES.stale,
      message: "attestation records no commands but the verifier report records re-executable checks",
    }
  }
  return { ...reported, status: "ATTESTED" }
}

function withoutAuthSafe(value) {
  try {
    return withoutAuth(value)
  } catch {
    return value
  }
}
