// H — signed CI attestation on produced runs (0.18.0).
//
// A real L3 run is driven to FINAL_VERIFICATION, a fixture attestation is
// signed by a local test key distinct from the run key, and:
//   * final_verify PASSes with `evidence.attestation.status === "ATTESTED"`;
//   * `verify` reports `attested: true` with --attestation-public-key;
//   * the same run without the attestation under `required` FAILs by name;
//   * tampering a bound field (re-signed, so the envelope is valid) yields the
//     named COMMIT_MISMATCH / STALE code.

import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO_ROOT } from "../harness/project"
import { readManifest, withRun } from "../harness/plan"
import { finalVerify, next, plannedTasks, readFinal, securityAudit, taskCycle } from "../harness/flow"
import {
  ATTESTATION_ENV_ISSUER,
  ATTESTATION_ENV_KEY_ID,
  ATTESTATION_ENV_PUBLIC_KEY,
  ATTESTATION_ISSUER,
  makeAttestationKeys,
  readReportHead,
  signAttestationPayload,
  signFixtureAttestation,
} from "../harness/attest"
import { hmacKey, withEnv } from "../harness/sign"

const CLI = join(REPO_ROOT, "bin", "opencode-teamwork.mjs")
const COMMAND = ["node", "-p", "1+1"]
const COMMAND_OUTPUT = "2\n"

const attestationEnv = (publicKey?: string): Record<string, string | undefined> => ({
  [ATTESTATION_ENV_PUBLIC_KEY]: publicKey,
  [ATTESTATION_ENV_KEY_ID]: undefined,
  [ATTESTATION_ENV_ISSUER]: undefined,
})

function commandCheck(): Record<string, unknown> {
  return {
    name: "node-arithmetic",
    type: "programmatic",
    passed: true,
    command: COMMAND,
    output: COMMAND_OUTPUT,
    exitCode: 0,
    durationMs: 1,
  }
}

async function driveToFinal(fx: Parameters<typeof next>[0]): Promise<void> {
  const claimed = await next(fx)
  expect(claimed.content).toContain("READY FOR WORKER")
  for (const taskId of plannedTasks(fx)) {
    await taskCycle(fx, taskId, { passChecks: [commandCheck()] })
  }
  await securityAudit(fx, "PASS")
}

function planOptions(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    request: "Deliver one fixture change and attest it in CI.",
    requirements: [{ id: "R1", text: "The fixture change is delivered and attested." }],
    requireHandoffs: "skip",
    victoryAudit: "skip",
    victorySkipReason: "The fixture exercises the CI attestation, not the victory audit.",
    attestationPolicy: "required",
    attestationIssuer: ATTESTATION_ISSUER,
    tasks: [{ id: "T1" }],
  }
}

function cliVerify(fx: any, publicKey: string, issuer?: string) {
  const manifest = readManifest(fx.project, fx.runId)
  return spawnSync(
    "node",
    [
      CLI,
      "verify",
      "--run-dir",
      fx.runDir,
      "--hmac-key",
      hmacKey(),
      "--hmac-key-id",
      String(manifest?.runKeyId),
      "--attestation-public-key",
      publicKey,
      ...(issuer ? ["--attestation-issuer", issuer] : []),
      "--json",
    ],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env } },
  )
}

test("H1 required + CI attestation -> final_verify PASS, verify attested:true; missing and tampering fail by name", async () => {
  const keys = await makeAttestationKeys()

  await withEnv(attestationEnv(undefined), async () => {
    await withRun("h1-attested", planOptions("20261124-000000-h1a"), async (fx) => {
      await driveToFinal(fx)
      const signed = await signFixtureAttestation(fx, { taskId: "T1", keys })
      expect(readReportHead(fx, "T1")).toMatch(/^[0-9a-f]{40}$/)

      const passed = await withEnv(attestationEnv(keys.publicKey), () => finalVerify(fx))
      expect(passed.status).toBe("PASS")
      const final = readFinal(fx)
      expect(final.status).toBe("PASS")
      expect(final.evidence.attestation.policy).toBe("required")
      expect(final.evidence.attestation.status).toBe("ATTESTED")
      expect(final.evidence.attestation.commitSha).toBe(readReportHead(fx, "T1"))
      expect(final.evidence.attestation.keyId).toBe(keys.keyId)
      expect(final.evidence.attestation.issuer).toBe(ATTESTATION_ISSUER)

      // `verify` sees the same bytes and reports the attestation, not just a
      // PASS from the final verdict.
      const cli = cliVerify(fx, keys.publicKey, ATTESTATION_ISSUER)
      expect({ code: cli.status, stderr: cli.stderr }).toEqual({ code: 0, stderr: "" })
      const parsed = JSON.parse(cli.stdout)
      expect(parsed.verdict).toBe("PASS")
      expect(parsed.attested).toBe(true)
      expect(parsed.attestation).toEqual({
        status: "ATTESTED",
        commitSha: readReportHead(fx, "T1"),
        keyId: keys.keyId,
        issuer: ATTESTATION_ISSUER,
      })

      // Without the public key the verifier must never promote an attestation.
      const noKey = spawnSync(
        "node",
        [
          CLI,
          "verify",
          "--run-dir",
          fx.runDir,
          "--hmac-key",
          hmacKey(),
          "--hmac-key-id",
          String(readManifest(fx.project, fx.runId)?.runKeyId),
          "--json",
        ],
        { encoding: "utf8", timeout: 120_000, env: { ...process.env } },
      )
      expect(noKey.status).toBe(2)
      expect(JSON.parse(noKey.stdout).verdict).toBe("UNKNOWN")
      expect(JSON.parse(noKey.stdout).attestation.status).toBe("UNKNOWN")

      // Tamper a bound field and re-sign with the test key: the envelope is
      // valid, so the failure must be the named binding code.
      const tampered = JSON.parse(JSON.stringify(signed.payload))
      tampered.planHash = "f".repeat(64)
      await signAttestationPayload(fx, tampered, keys)
      const stale = await withEnv(attestationEnv(keys.publicKey), () => finalVerify(fx))
      expect(stale.status).toBe("FAIL")
      expect(stale.reasons?.some((reason: string) => reason.includes("AUTH_ATTESTATION_STALE"))).toBe(true)

      const wrongCommit = JSON.parse(JSON.stringify(signed.payload))
      wrongCommit.commitSha = "d".repeat(40)
      await signAttestationPayload(fx, wrongCommit, keys)
      const commit = await withEnv(attestationEnv(keys.publicKey), () => finalVerify(fx))
      expect(commit.status).toBe("FAIL")
      expect(
        commit.reasons?.some((reason: string) => reason.includes("AUTH_ATTESTATION_COMMIT_MISMATCH")),
      ).toBe(true)

      const wrongCommand = JSON.parse(JSON.stringify(signed.payload))
      wrongCommand.commands[0].argv = ["node", "-p", "2+2"]
      await signAttestationPayload(fx, wrongCommand, keys)
      const command = await withEnv(attestationEnv(keys.publicKey), () => finalVerify(fx))
      expect(command.status).toBe("FAIL")
      expect(command.reasons?.some((reason: string) => reason.includes("AUTH_ATTESTATION_STALE"))).toBe(true)

      // Restoring the exact payload restores the PASS and the evidence.
      await signAttestationPayload(fx, signed.payload, keys)
      const restored = await withEnv(attestationEnv(keys.publicKey), () => finalVerify(fx))
      expect(restored.status).toBe("PASS")
      expect(readFinal(fx).evidence.attestation.status).toBe("ATTESTED")
      expect(readFileSync(signed.path, "utf8")).toContain('"_auth"')
    })

    // Required policy with no attestation artifact fails closed.
    await withRun("h1-missing", planOptions("20261124-000000-h1b"), async (fx) => {
      await driveToFinal(fx)
      const failed = await withEnv(attestationEnv(keys.publicKey), () => finalVerify(fx))
      expect(failed.status).toBe("FAIL")
      expect(failed.reasons?.some((reason: string) => reason.includes("AUTH_ATTESTATION_MISSING"))).toBe(true)
      expect(readFinal(fx).evidence.attestation.status).toBe("MISSING")
    })
  })
})
