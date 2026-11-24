// opencode-teamwork — signer SPI / Ed25519 envelope tests
//
// Hermetic, zero-dependency coverage for `plugins/opencode-teamwork/auth.ts`:
// Ed25519 sign/verify with a public-key-only verifier, nonce and key-id
// pinning, cross-run replay, the command signer protocol (happy path and every
// fail-closed branch), the command/HTTP witness, and rotation.
//
// Run with plain Node (no test framework): an uncaught assertion exits non-zero.

import { createAuthContext, sha256Hex } from "../plugins/opencode-teamwork/auth.ts"
import { generateKeyPairSync } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-auth-test-"))
const NONCE_A = "AAAAAAAAAAAAAAAAAAAAAA"
const NONCE_B = "BBBBBBBBBBBBBBBBBBBBBB"

function makeStorage() {
  const map = new Map()
  return {
    map,
    shim: {
      get: async (key) => map.get(key),
      set: async (key, value) => {
        map.set(key, value)
      },
      remove: async (key) => {
        map.delete(key)
      },
      scan: async () => ({ entries: [], hasMore: false }),
    },
  }
}

function generatedEd25519() {
  const pair = generateKeyPairSync("ed25519")
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  }
}

function signerKeyId(publicKey) {
  return `signer_${sha256Hex(publicKey).slice(0, 16)}`
}

function writeScript(name, body) {
  const file = join(testDir, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

function signerScript(privateKey) {
  return writeScript(
    "signer.mjs",
    `#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { createPrivateKey, sign } from "node:crypto"
const request = JSON.parse(readFileSync(0, "utf8"))
const message = Buffer.from(request.message, "base64url")
const key = createPrivateKey({ key: Buffer.from(${JSON.stringify(privateKey)}, "base64url"), format: "der", type: "pkcs8" })
process.stdout.write(JSON.stringify({ alg: "ed25519", keyId: request.keyId, sig: sign(null, message, key).toString("base64url") }))
`,
  )
}

function witnessScript(mode) {
  return writeScript(
    `witness-${mode}.mjs`,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs"
const request = JSON.parse(readFileSync(0, "utf8"))
if (${JSON.stringify(mode)} === "missing") process.stdout.write("{}")
else process.stdout.write(JSON.stringify({ receipt: "fixture-receipt:" + request.runId + ":" + request.path }))
`,
  )
}

const created = []
function context(env, storage = makeStorage()) {
  created.push(storage)
  return { auth: createAuthContext(storage.shim, env), storage }
}

try {
  // ==========================================================================
  // 1. Ed25519: sign locally, verify with the public key only
  // ==========================================================================
  {
    console.log("Testing Ed25519 sign/verify with a public-key-only verifier...")
    const keys = generatedEd25519()
    const shared = makeStorage()
    const signer = context(
      {
        OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: keys.privateKey,
        OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: keys.publicKey,
        OPENCODE_TEAMWORK_ED25519_KEY_ID: "fixture-ed25519",
      },
      shared,
    ).auth
    const verifier = context(
      {
        OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: keys.publicKey,
        OPENCODE_TEAMWORK_ED25519_KEY_ID: "fixture-ed25519",
      },
      shared,
    ).auth

    const bound = await signer.bindRunNonce("run-ed", NONCE_A)
    assert.strictEqual(bound.ok, true, `nonce binding must succeed: ${JSON.stringify(bound)}`)
    const signed = await signer.signRunArtifact("run-ed", "verify/report-A1.json", { status: "PASS" })
    assert.strictEqual(signed._auth.alg, "ed25519", "the envelope must be Ed25519")
    assert.strictEqual(signed._auth.keyId, "fixture-ed25519")
    assert.strictEqual(signed._auth.nonce, NONCE_A, "the run nonce must be in the envelope")
    assert(typeof signed._auth.mac === "undefined", "an Ed25519 envelope has no mac")
    assert.strictEqual(typeof signed._auth.sig, "string")

    const verified = await verifier.verifyRunArtifact("run-ed", "verify/report-A1.json", signed)
    assert.strictEqual(verified.status, "signed", `public-key-only verification must pass: ${JSON.stringify(verified)}`)
    assert.strictEqual(verifier.signingAlg(), undefined, "the verifier never resolves a signing algorithm without a source")

    // A verifier with the wrong public key must fail the signature check.
    const otherKeys = generatedEd25519()
    const wrongKey = context(
      {
        OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: otherKeys.publicKey,
        OPENCODE_TEAMWORK_ED25519_KEY_ID: "fixture-ed25519",
      },
      shared,
    ).auth
    const wrong = await wrongKey.verifyArtifact("verify/report-A1.json", signed)
    assert.strictEqual(wrong.ok, false)
    assert.strictEqual(wrong.failure.code, "AUTH_INVALID", `a wrong public key must fail: ${JSON.stringify(wrong)}`)

    // Tampered payload fails the digest before the signature.
    const tampered = { ...signed, status: "FAIL" }
    const bad = await verifier.verifyArtifact("verify/report-A1.json", tampered)
    assert.strictEqual(bad.ok, false)
    assert.strictEqual(bad.failure.code, "AUTH_INVALID")

    // A verify-only key source cannot sign.
    const verifyOnly = context({
      OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: keys.publicKey,
      OPENCODE_TEAMWORK_ED25519_KEY_ID: "fixture-ed25519",
    }).auth
    const ready = await verifyOnly.ready()
    assert.strictEqual(ready.ok, true, "a public key alone is enough to load the ring")
    let refused = false
    try {
      await verifyOnly.signArtifact("verify/x.json", { x: 1 })
    } catch (err) {
      refused = err?.failure?.code === "AUTH_UNAVAILABLE"
    }
    assert(refused, "signing without a private key must fail AUTH_UNAVAILABLE")

    console.log("✓ Ed25519 signs locally and verifies with only the SPKI public key; wrong key and tampering fail")
  }

  // ==========================================================================
  // 2. HMAC backward compatibility + nonce/key-id pinning
  // ==========================================================================
  {
    console.log("Testing HMAC compatibility, nonce replay, key-id pinning, and cross-run copies...")
    const { auth } = context({})
    // Legacy shape: signArtifact with no nonce and no run binding.
    const legacy = await auth.signArtifact("verify/legacy.json", { n: 1 })
    assert.strictEqual(legacy._auth.alg, "hmac-sha256")
    assert.strictEqual(typeof legacy._auth.mac, "string")
    assert(typeof legacy._auth.nonce === "undefined")
    const legacyCheck = await auth.verifyArtifact("verify/legacy.json", legacy)
    assert.strictEqual(legacyCheck.ok, true, "a pre-nonce HMAC envelope must still verify")

    await auth.bindRunNonce("run-a", NONCE_A)
    await auth.bindRunKeyId("run-a", legacy._auth.keyId)
    await auth.bindRunNonce("run-b", NONCE_B)
    await auth.bindRunKeyId("run-b", legacy._auth.keyId)

    const signed = await auth.signRunArtifact("run-a", "verify/report-A1.json", { status: "PASS" })
    assert.strictEqual(signed._auth.nonce, NONCE_A)
    const signedCheck = await auth.verifyRunArtifact("run-a", "verify/report-A1.json", signed)
    assert.strictEqual(signedCheck.status, "signed", JSON.stringify(signedCheck))

    // Cross-run replay: same artifact, different run nonce and index.
    const replay = await auth.verifyRunArtifact("run-b", "verify/report-A1.json", signed)
    assert.strictEqual(replay.status, "unknown")
    assert.strictEqual(replay.failure.code, "AUTH_INVALID")
    assert(/nonce does not match/.test(replay.failure.message))

    // Key-id mismatch against the pinned run key.
    const rekeyed = JSON.parse(JSON.stringify(signed))
    rekeyed._auth.keyId = "k_someone_else"
    const keyFail = await auth.verifyRunArtifact("run-a", "verify/report-A1.json", rekeyed)
    assert.strictEqual(keyFail.status, "unknown")
    assert.strictEqual(keyFail.failure.code, "AUTH_INVALID")
    assert(/key id/.test(keyFail.failure.message), `the key-id mismatch must be named: ${JSON.stringify(keyFail)}`)

    // A different nonce cannot overwrite an existing binding.
    const conflict = await auth.bindRunNonce("run-a", NONCE_B)
    assert.strictEqual(conflict.ok, false)
    assert.strictEqual(conflict.failure.code, "AUTH_STALE")

    console.log("✓ HMAC envelopes stay compatible; nonce replay, key-id mismatch, and nonce rebinding fail")
  }

  // ==========================================================================
  // 3. Command signer: happy path and every fail-closed branch
  // ==========================================================================
  {
    if (process.platform === "win32") {
      console.log(
        "SKIP: the command signer protocol needs a shebang-executable script; this runner cannot execute one. Recorded; Linux/macOS cover the protocol.",
      )
    } else {
    console.log("Testing the command signer protocol...")
    const keys = generatedEd25519()
    const keyId = signerKeyId(keys.publicKey)
    const signerPath = signerScript(keys.privateKey)
    const signerEnv = {
      OPENCODE_TEAMWORK_SIGNER: `command:${signerPath}`,
      OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY: keys.publicKey,
      OPENCODE_TEAMWORK_SIGNER_TIMEOUT_MS: "2000",
    }
    const signerStorage = makeStorage()
    const signer = context(signerEnv, signerStorage).auth
    await signer.bindRunNonce("run-cmd", NONCE_A)
    const signed = await signer.signRunArtifact("run-cmd", "verify/final.json", { status: "PASS" })
    assert.strictEqual(signed._auth.alg, "ed25519")
    assert.strictEqual(signed._auth.keyId, keyId, "the signer key id must be derived from the configured public key")
    assert.strictEqual(signed._auth.nonce, NONCE_A)

    // The verifier has no signer and no private key, only the public key.
    const verifier = context(
      {
        OPENCODE_TEAMWORK_ED25519_PUBLIC_KEY: keys.publicKey,
        OPENCODE_TEAMWORK_ED25519_KEY_ID: keyId,
      },
      signerStorage,
    ).auth
    const checked = await verifier.verifyRunArtifact("run-cmd", "verify/final.json", signed)
    assert.strictEqual(checked.status, "signed", `a signer envelope must verify publicly: ${JSON.stringify(checked)}`)

    const expectUnavailable = async (env, label) => {
      const auth = context(env).auth
      await auth.bindRunNonce("run-fail", NONCE_A)
      let code
      try {
        await auth.signRunArtifact("run-fail", "verify/final.json", { status: "PASS" })
      } catch (err) {
        code = err?.failure?.code
      }
      assert.strictEqual(code, "AUTH_SIGNER_UNAVAILABLE", `${label} must fail AUTH_SIGNER_UNAVAILABLE (got ${code})`)
    }

    const malformed = writeScript("signer-malformed.mjs", `#!/usr/bin/env node\nprocess.stdout.write('{"alg":"ed25519"}')\n`)
    await expectUnavailable(
      { ...signerEnv, OPENCODE_TEAMWORK_SIGNER: `command:${malformed}` },
      "a malformed response",
    )
    const badSig = writeScript(
      "signer-bad-sig.mjs",
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({alg:"ed25519",keyId:${JSON.stringify(keyId)},sig:Buffer.alloc(64).toString("base64url")}))\n`,
    )
    await expectUnavailable(
      { ...signerEnv, OPENCODE_TEAMWORK_SIGNER: `command:${badSig}` },
      "a signature that does not verify",
    )
    const hanging = writeScript(
      "signer-hang.mjs",
      `#!/usr/bin/env node\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)\n`,
    )
    await expectUnavailable(
      { ...signerEnv, OPENCODE_TEAMWORK_SIGNER: `command:${hanging}`, OPENCODE_TEAMWORK_SIGNER_TIMEOUT_MS: "150" },
      "a timeout",
    )
    await expectUnavailable(
      { ...signerEnv, OPENCODE_TEAMWORK_SIGNER: `command:${join(testDir, "does-not-exist")}` },
      "an unavailable executable",
    )
    await expectUnavailable(
      { ...signerEnv, OPENCODE_TEAMWORK_SIGNER: "command:relative/path" },
      "a relative signer path",
    )
    await expectUnavailable(
      { OPENCODE_TEAMWORK_SIGNER: `command:${signerPath}` },
      "a missing signer public key",
    )

    console.log("✓ command signer happy path verifies publicly; malformed, bad-sig, timeout, missing, and relative paths fail closed")
    }
  }

  // ==========================================================================
  // 4. Witness: command and HTTP receipts, missing receipt fails closed
  // ==========================================================================
  {
    console.log("Testing the witness adapter...")
    const keys = generatedEd25519()
    if (process.platform === "win32") {
      console.log("SKIP: a command witness needs a shebang-executable script; this runner cannot execute one. Recorded.")
    } else {
    const witnessPath = witnessScript("ok")
    const witnessAuth = context({
      OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: keys.privateKey,
      OPENCODE_TEAMWORK_WITNESS: `command:${witnessPath}`,
    })
    await witnessAuth.auth.bindRunNonce("run-w", NONCE_A)
    const signed = await witnessAuth.auth.signRunArtifact("run-w", "run.manifest.json", { n: 1 })
    assert.strictEqual(signed._auth.alg, "ed25519")
    const receipt = await witnessAuth.auth.witnessReceipt("run-w", "run.manifest.json")
    assert(receipt?.startsWith("fixture-receipt:run-w:"), `the witness receipt must be stored: ${receipt}`)

    const missingAuth = context({
      OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: keys.privateKey,
      OPENCODE_TEAMWORK_WITNESS: `command:${witnessScript("missing")}`,
    }).auth
    await missingAuth.bindRunNonce("run-w2", NONCE_A)
    let missingCode
    try {
      await missingAuth.signRunArtifact("run-w2", "run.manifest.json", { n: 1 })
    } catch (err) {
      missingCode = err?.failure?.code
    }
    assert.strictEqual(missingCode, "AUTH_WITNESS_UNAVAILABLE", "a witness without a receipt must fail closed")
    }

    // HTTP witness: a tiny loopback server returns a receipt.
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        const request = JSON.parse(body)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ receipt: `http:${request.runId}:${request.path}` }))
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    try {
      const httpAuth = context({
        OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY: keys.privateKey,
        OPENCODE_TEAMWORK_WITNESS: `http://127.0.0.1:${port}/witness`,
      }).auth
      await httpAuth.bindRunNonce("run-http", NONCE_A)
      await httpAuth.signRunArtifact("run-http", "run.manifest.json", { n: 1 })
      const httpReceipt = await httpAuth.witnessReceipt("run-http", "run.manifest.json")
      assert.strictEqual(httpReceipt, "http:run-http:run.manifest.json")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }

    console.log("✓ command and HTTP witnesses record receipts; a missing receipt fails AUTH_WITNESS_UNAVAILABLE")
  }

  // ==========================================================================
  // 5. Rotation to an Ed25519 ring keeps old HMAC artifacts verifiable
  // ==========================================================================
  {
    console.log("Testing key rotation...")
    const { auth } = context({})
    const old = await auth.signRunArtifact("run-r", "verify/old.json", { n: 1 })
    const rotated = await auth.rotate("ed25519")
    assert.strictEqual(rotated.ok, true, `Ed25519 rotation must succeed: ${JSON.stringify(rotated)}`)
    const fresh = await auth.signRunArtifact("run-r", "verify/new.json", { n: 2 })
    assert.strictEqual(fresh._auth.alg, "ed25519", "new writes must use the rotated Ed25519 key")
    assert.notStrictEqual(fresh._auth.keyId, old._auth.keyId)
    const oldCheck = await auth.verifyRunArtifact("run-r", "verify/old.json", old)
    assert.strictEqual(oldCheck.status, "signed", `the retired HMAC key must still verify old artifacts: ${JSON.stringify(oldCheck)}`)
    console.log("✓ rotation to Ed25519 keeps prior HMAC artifacts verifiable")
  }

  console.log("All signer-SPI tests passed")
} finally {
  for (const entry of created) {
    try {
      rmSync(entry, { recursive: true, force: true })
    } catch {}
  }
  rmSync(testDir, { recursive: true, force: true })
}
