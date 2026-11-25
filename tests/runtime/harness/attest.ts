// L2/L3 CI attestation fixtures (0.18.0).
//
// The attestation is produced exactly as a CI job would produce it: a local
// Ed25519 test key signs the same `_auth` envelope via the shared
// `plugins/opencode-teamwork/attestation.mjs` leaf. No network and no private
// key outside the fixture process.

import { generateKeyPairSync } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { PLUGIN_DIR } from "./project"
import { readManifest, readRunJson, type RunFixture } from "./plan"

export const ATTESTATION_ENV_PUBLIC_KEY = "OPENCODE_TEAMWORK_ATTESTATION_PUBLIC_KEY"
export const ATTESTATION_ENV_KEY_ID = "OPENCODE_TEAMWORK_ATTESTATION_KEY_ID"
export const ATTESTATION_ENV_ISSUER = "OPENCODE_TEAMWORK_ATTESTATION_ISSUER"
export const ATTESTATION_ISSUER = "https://ci.example.invalid/issuer"

export interface AttestationKeys {
  readonly publicKey: string
  readonly privateKey: string
  readonly keyId: string
  readonly pair: ReturnType<typeof generateKeyPairSync>
}

async function attestationModule() {
  return import(pathToFileURL(join(PLUGIN_DIR, "attestation.mjs")).href)
}

export async function makeAttestationKeys(): Promise<AttestationKeys> {
  const pair = generateKeyPairSync("ed25519")
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
  const { attestationKeyIdFromPublicKey } = await attestationModule()
  return {
    pair,
    publicKey,
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    keyId: attestationKeyIdFromPublicKey(publicKey),
  }
}

export interface AttestationOptions {
  readonly taskId?: string
  readonly keys?: AttestationKeys
  readonly planHash?: string
  readonly commitSha?: string
  readonly runId?: string
  readonly issuer?: string
  readonly nonce?: string
}

export interface AttestationResult {
  readonly artifact: any
  readonly payload: any
  readonly path: string
  readonly keys: AttestationKeys
}

/**
 * Build and sign an attestation for a produced run. The default binds the
 * report's headSha and command/output digest for `taskId`.
 */
export async function signFixtureAttestation(
  fx: RunFixture,
  options: AttestationOptions = {},
): Promise<AttestationResult> {
  const keys = options.keys ?? (await makeAttestationKeys())
  const taskId = options.taskId ?? "T1"
  const manifest = readManifest(fx.project, fx.runId)
  if (!manifest) throw new Error(`run.manifest.json is missing for ${fx.runId}`)
  const report = readRunJson<any>(fx.project, fx.runId, `verify/report-${taskId}.json`)
  if (!report) throw new Error(`verify/report-${taskId}.json is missing`)
  const check = Array.isArray(report.checks)
    ? report.checks.find((entry: any) => Array.isArray(entry?.command))
    : undefined
  const { contentSha256Hex, payloadDigest } = await import(
    pathToFileURL(join(PLUGIN_DIR, "approval-format.mjs")).href
  )
  const commands = check
    ? [
        {
          argv: check.command,
          cwd: check.cwd ?? ".",
          exitCode: check.exitCode,
          outputSha256: contentSha256Hex(check.output ?? ""),
          outputBytes: Buffer.byteLength(check.output ?? "", "utf8"),
        },
      ]
    : []
  const payload = {
    v: 1,
    provider: "github-actions",
    workflow: "ci-attestation",
    runId: options.runId ?? fx.runId,
    runAttempt: 1,
    repository: "example/repo",
    commitSha: options.commitSha ?? report.headSha,
    baseSha: "",
    promptHash: typeof manifest.specHash === "string" ? manifest.specHash : contentSha256Hex(""),
    planHash: options.planHash ?? manifest.planHash,
    manifestDigest: payloadDigest(manifest),
    commands,
    oidc: {
      issuer: options.issuer ?? ATTESTATION_ISSUER,
      subject: "repo:example/repo:ref:refs/heads/main",
      audience: "opencode-teamwork",
    },
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }
  const { signAttestation } = await attestationModule()
  const artifact = signAttestation(payload, {
    privateKey: keys.pair.privateKey,
    keyId: keys.keyId,
    nonce: options.nonce ?? manifest.runNonce,
  })
  const path = join(fx.runDir, "verify", "ci", "attestation.json")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
  return { artifact, payload, path, keys }
}

/** Re-sign a modified payload (a tamper fixture) with the same test key. */
export async function signAttestationPayload(
  fx: RunFixture,
  payload: any,
  keys: AttestationKeys,
  options: { nonce?: string } = {},
): Promise<any> {
  const manifest = readManifest(fx.project, fx.runId)
  const { signAttestation } = await attestationModule()
  const artifact = signAttestation(payload, {
    privateKey: keys.pair.privateKey,
    keyId: keys.keyId,
    nonce: options.nonce ?? manifest?.runNonce,
  })
  mkdirSync(join(fx.runDir, "verify", "ci"), { recursive: true })
  writeFileSync(join(fx.runDir, "verify", "ci", "attestation.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
  return artifact
}

export function readReportHead(fx: RunFixture, taskId = "T1"): string {
  const report = readRunJson<any>(fx.project, fx.runId, `verify/report-${taskId}.json`)
  return String(report?.headSha ?? "")
}
