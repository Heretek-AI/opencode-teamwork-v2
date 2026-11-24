// L2 authenticity helpers: signed-run inspection and the Ed25519 prompt
// approval producer.
//
// The run signer uses OPENCODE_TEAMWORK_HMAC_KEY (set by the preload) for
// speed. One spec deletes it before the plan so the plugin's own `ctx.storage`
// key ring is the source instead. The approval path uses the same
// `lib/approve.mjs` functions the `opencode-teamwork approve sign` CLI calls:
// buildApprovalRequest -> signApprovalArtifact -> writeApprovalAtomically.

import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { LoadedHost } from "./load"
import { PLUGIN_DIR } from "./project"
import type { Project } from "./project"
import { runDir, readManifest, type RunManifest } from "./plan"

const ENV_KEY = "OPENCODE_TEAMWORK_HMAC_KEY"
const ENV_KEY_ID = "OPENCODE_TEAMWORK_HMAC_KEY_ID"
export const ENV_ED25519_PRIVATE = "OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY"
export const ENV_ED25519_PUBLIC = "OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY"
export const ENV_ED25519_KEY_ID = "OPENCODE_TEAMWORK_ED25519_KEY_ID"
const KEY_RING_STORAGE_KEY = "auth/key/ring"

export const APPROVAL_ENV_DIR = "OPENCODE_TEAMWORK_APPROVAL_DIR"
export const APPROVAL_ENV_PUBLIC_KEY = "OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY"
export const APPROVAL_ENV_KEY_ID = "OPENCODE_TEAMWORK_APPROVAL_KEY_ID"

const BASE64URL = /^[A-Za-z0-9_-]+$/

export function hmacKey(): string {
  const value = process.env[ENV_KEY]
  if (!value) throw new Error("OPENCODE_TEAMWORK_HMAC_KEY is not set; the preload should have set it")
  return value
}

/** Temporarily set/delete env vars; the previous values are restored. */
export async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Delete every run-signing env source so the plugin uses `ctx.storage`. */
export function withoutSigningEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv(
    {
      [ENV_KEY]: undefined,
      [ENV_KEY_ID]: undefined,
      [ENV_ED25519_PRIVATE]: undefined,
      [ENV_ED25519_PUBLIC]: undefined,
      [ENV_ED25519_KEY_ID]: undefined,
    },
    fn,
  )
}

/** The host KV value the plugin persists under `auth/key/ring`. */
export async function readStorageKeyRing(source: LoadedHost | { get: (key: string) => Promise<unknown> }): Promise<{ version: number; keys: Array<Record<string, any>> }> {
  const storage = "capture" in source ? (source as LoadedHost).capture.storage : (source as { get: (key: string) => Promise<unknown> })
  const value = await storage.get(KEY_RING_STORAGE_KEY)
  if (!value || typeof value !== "object") throw new Error("the plugin did not persist a storage key ring")
  return value as any
}

export function isBase64UrlBytes(value: unknown, bytes?: number): boolean {
  if (typeof value !== "string" || !BASE64URL.test(value)) return false
  const decoded = Buffer.from(value, "base64url")
  return bytes === undefined ? decoded.length > 0 : decoded.length === bytes
}

export interface ManifestExpectations {
  readonly version?: number
  readonly handoffAuth?: string
  readonly planAgent?: string | null
  readonly requiredProvenance?: string
}

/**
 * Assert the signed-baseline shape the plan writes: manifest v4, a 128-bit run
 * nonce, the three baseline hashes, signed handoffs, the run key and planAgent.
 */
export function assertSignedManifest(
  project: Project,
  runId: string,
  expected: ManifestExpectations = {},
): RunManifest {
  const manifest = readManifest(project, runId)
  if (!manifest) throw new Error(`run.manifest.json is missing for ${runId}`)
  const version = expected.version ?? 5
  if (manifest.version !== version) throw new Error(`manifest.version is ${manifest.version}, expected ${version}`)
  if (manifest.integrityMode === undefined) throw new Error("manifest.integrityMode is missing")
  if (typeof manifest.runKeyId !== "string" || manifest.runKeyId === "") throw new Error("manifest.runKeyId is missing")
  if (!isBase64UrlBytes(manifest.runNonce, 16)) throw new Error("manifest.runNonce is not 128 bits of base64url")
  for (const field of ["planHash", "requestHash", "requirementsHash"]) {
    if (typeof manifest[field] !== "string" || !/^[0-9a-f]{64}$/.test(manifest[field])) {
      throw new Error(`manifest.${field} is not a sha256 hex digest`)
    }
  }
  const handoffAuth = expected.handoffAuth ?? "signed"
  if (manifest.handoffAuth !== handoffAuth) throw new Error(`manifest.handoffAuth is ${manifest.handoffAuth}, expected ${handoffAuth}`)
  if (expected.planAgent !== undefined && manifest.planAgent !== expected.planAgent) {
    throw new Error(`manifest.planAgent is ${manifest.planAgent}, expected ${expected.planAgent}`)
  }
  if (expected.requiredProvenance !== undefined && manifest.requiredProvenance !== expected.requiredProvenance) {
    throw new Error(`manifest.requiredProvenance is ${manifest.requiredProvenance}, expected ${expected.requiredProvenance}`)
  }
  if (!manifest._auth || manifest._auth.v !== 1) throw new Error("manifest._auth envelope is missing")
  return manifest
}

/** Assert the manifest stays signed with the same key/nonce/hashes. */
export function assertManifestStable(before: RunManifest, after: RunManifest | undefined, label: string): void {
  if (!after) throw new Error(`${label}: run.manifest.json disappeared`)
  for (const field of ["version", "runKeyId", "runNonce", "planHash", "requestHash", "requirementsHash", "handoffAuth", "createdAt"]) {
    if (before[field] !== after[field]) throw new Error(`${label}: manifest.${field} changed`)
  }
  const beforeDigest = before._auth?.digest
  const afterDigest = after._auth?.digest
  if (!beforeDigest || beforeDigest !== afterDigest) throw new Error(`${label}: manifest _auth digest changed`)
}

// ---------------------------------------------------------------------------
// Prompt approvals (the `approve sign` producer)
// ---------------------------------------------------------------------------

export interface ApprovalKeys {
  readonly publicKey: string
  readonly privateKey: string
  readonly keyId: string
  readonly pair: ReturnType<typeof generateKeyPairSync>
}

export function makeApprovalKeys(keyId = "l2-approver"): ApprovalKeys {
  const pair = generateKeyPairSync("ed25519")
  return {
    pair,
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    keyId,
  }
}

/** A real directory outside the project and the run (sibling of the root). */
export function makeApprovalDir(project: Project, label: string): string {
  const dir = join(dirname(project.root), `approvals-${label}-${basename(project.root)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function approvalEnv(dir: string, keys: ApprovalKeys): Record<string, string> {
  return {
    [APPROVAL_ENV_DIR]: dir,
    [APPROVAL_ENV_PUBLIC_KEY]: keys.publicKey,
    [APPROVAL_ENV_KEY_ID]: keys.keyId,
  }
}

/**
 * The plugin's ownership seam. A real approval directory is owned by another
 * principal; a single-UID test process cannot create one, so the plugin exports
 * this test-only override. It is the same seam `scripts/test-approval.mjs`
 * uses.
 */
export async function withApprovalOwner<T>(fn: () => Promise<T>): Promise<T> {
  const { setApprovalOwnerUidForTest } = await import(pathToFileURL(join(PLUGIN_DIR, "tools.ts")).href)
  const owner = typeof process.geteuid === "function" ? process.geteuid() : 1000
  setApprovalOwnerUidForTest(owner + 1)
  try {
    return await fn()
  } finally {
    setApprovalOwnerUidForTest(null)
  }
}

async function approveLib() {
  return import(pathToFileURL(join(PLUGIN_DIR, "..", "..", "lib", "approve.mjs")).href)
}

async function approvalFormat() {
  return import(pathToFileURL(join(PLUGIN_DIR, "approval-format.mjs")).href)
}

export interface SignDraftOptions {
  readonly keys?: ApprovalKeys
  readonly approver?: string
  readonly trustLevel?: "human-approved" | "ci-attested"
  readonly ttlMs?: number
  readonly now?: number
}

export interface SignedApproval {
  readonly artifact: any
  readonly path: string
  readonly payload: any
  readonly dir: string
}

/**
 * Produce one prompt-bound approval over the exact `prompt_draft.md` bytes.
 * Mirrors `opencode-teamwork approve request` + `approve sign`.
 */
export async function signDraftApproval(
  project: Project,
  runId: string,
  dir: string,
  options: SignDraftOptions = {},
): Promise<SignedApproval> {
  const keys = options.keys ?? makeApprovalKeys()
  const trustLevel = options.trustLevel ?? "human-approved"
  const approver = options.approver ?? (trustLevel === "ci-attested" ? "ci:l2-harness" : "uid:l2-reviewer")
  const { buildApprovalRequest, signApprovalArtifact, writeApprovalAtomically, readDraftDigest } = await approveLib()
  const run = runDir(project, runId)
  const runReal = realpathSync(run)
  const draft = readDraftDigest(runReal, run)
  if (!draft.ok) throw new Error(`approve request: ${draft.error}`)
  const payload = buildApprovalRequest({
    runId,
    draft,
    trustLevel,
    approver,
    ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000,
    manifestDigest: undefined,
    planHash: null,
    now: options.now,
  })
  const artifact = signApprovalArtifact(payload, { privateKey: keys.pair.privateKey, keyId: keys.keyId })
  const written = writeApprovalAtomically(dir, runId, artifact)
  if (!written.ok) throw new Error(`approve sign: ${written.error}`)
  return { artifact, path: written.path, payload, dir }
}

export interface HmacApprovalOptions {
  readonly approver?: string
  readonly trustLevel?: "human-approved" | "ci-attested"
  readonly key?: string
  readonly keyId?: string
}

/**
 * A syntactically valid approval envelope signed with the run's HMAC key. The
 * plugin verifies it successfully and must then refuse it as NOT_HUMAN.
 */
export async function signHmacApproval(
  project: Project,
  runId: string,
  dir: string,
  options: HmacApprovalOptions = {},
): Promise<SignedApproval> {
  const { payloadDigest, canonicalJson, contentSha256Hex } = await approvalFormat()
  const run = runDir(project, runId)
  const draft = readFileSync(join(run, "prompt_draft.md"))
  const trustLevel = options.trustLevel ?? "human-approved"
  const now = Date.now()
  const payload = {
    v: 1,
    runId,
    trustLevel,
    binding: "prompt",
    promptDraftSha256: contentSha256Hex(draft),
    promptDraftBytes: draft.length,
    openGaps: 0,
    approvalNonce: randomBytes(32).toString("base64url"),
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    ...(trustLevel === "ci-attested" ? { attestedBy: options.approver ?? "ci:l2-harness" } : { approvedBy: options.approver ?? "uid:l2-reviewer" }),
    planHash: null,
  }
  const digest = payloadDigest(payload)
  const keyId = options.keyId ?? process.env[ENV_KEY_ID] ?? "env"
  const envelope = {
    v: 1,
    alg: "hmac-sha256",
    keyId,
    path: `approvals/${runId}.json`,
    digest,
    nonce: payload.approvalNonce,
    at: new Date().toISOString(),
  }
  const key = Buffer.from(options.key ?? hmacKey(), "base64url")
  const mac = createHmac("sha256", key).update(canonicalJson(envelope), "utf8").digest("hex")
  const artifact = { ...payload, _auth: { ...envelope, mac } }
  const path = join(dir, `${runId}.json`)
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
  return { artifact, path, payload, dir }
}

export function approvalExists(dir: string, runId: string): boolean {
  return existsSync(join(dir, `${runId}.json`))
}

/** Read a run's `_auth`-wrapped artifact (e.g. handoffs/index.json). */
export function readSignedJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Sign a fixture payload with the same auth context the plugin uses (env HMAC
 * key by default). Used when a spec must model a stamped artifact that the
 * tools cannot produce in that state (L3 I3's pre-rejection PASS), mirroring
 * `scripts/test-engine.mjs`'s `writeSignedFixture`.
 */
export async function signFixtureArtifact(
  project: Project,
  runId: string,
  relativePath: string,
  payload: unknown,
  storage?: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<unknown> },
): Promise<any> {
  const module = await import(pathToFileURL(join(PLUGIN_DIR, "auth.ts")).href)
  const kv = storage ?? { get: async () => undefined, set: async () => undefined }
  const auth = module.createAuthContext(kv, process.env)
  // The plugin binds the run nonce in ctx.storage at plan time; a fixture
  // signer takes it from the manifest so the envelope pins the same run.
  const manifest = readManifest(project, runId)
  const nonce = typeof manifest?.runNonce === "string" ? manifest.runNonce : undefined
  return auth.signRunArtifact(runId, relativePath, payload, nonce ? { nonce } : {})
}

