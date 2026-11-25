// I6 — the offline verifier on produced runs.
//
// `opencode-teamwork verify` reads only run bytes plus a key. This spec produces
// real runs through the runtime and then:
//   * Ed25519 run, `--public-key @file`            -> PASS, exit 0
//   * the same run, chmod -R a-w copy              -> PASS and no bytes changed
//   * one-byte flip of a copied artifact           -> FAIL, exit 1
//   * HMAC run, `--hmac-key`                       -> PASS, exit 0
//   * requiredProvenance "command" run             -> UNKNOWN exit 2 without
//     --rerun; PASS exit 0 with --rerun against a clean checkout.

import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPO_ROOT } from "../harness/project"
import { snapshotTree, treeDiff, withRun } from "../harness/plan"
import { completeStandardRun, readFinal } from "../harness/flow"
import { ENV_ED25519_KEY_ID, ENV_ED25519_PRIVATE, ENV_ED25519_PUBLIC, hmacKey, makeApprovalKeys, withEnv } from "../harness/sign"

const CLI = join(REPO_ROOT, "bin", "opencode-teamwork.mjs")

interface VerifyRun {
  code: number | null
  json?: any
  stdout: string
  stderr: string
}

function cliVerify(args: string[]): VerifyRun {
  const result = spawnSync("node", [CLI, "verify", ...args, "--json"], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  })
  let json: any
  try {
    json = JSON.parse(result.stdout)
  } catch {}
  return { code: result.status, json, stdout: result.stdout, stderr: result.stderr }
}

function readOnlyCopy(source: string, runId: string): string {
  const parent = mkdtempSync(join(tmpdir(), "teamwork-i6-copy-"))
  const target = join(parent, runId)
  cpSync(source, target, { recursive: true, preserveTimestamps: true })
  execFileSync("chmod", ["-R", "a-w", target])
  return target
}

function makeWritable(path: string) {
  execFileSync("chmod", ["-R", "u+w", path])
}

function flipFirstByte(path: string) {
  const bytes = readFileSync(path)
  bytes[0] = bytes[0] ^ 0x01
  writeFileSync(path, bytes)
}

const requirement = [{ id: "R1", text: "The fixture change is delivered and verified." }]

test("I6 verifier: public-key PASS, byte flip FAIL, read-only run untouched, HMAC PASS and command provenance", async () => {
  // --- Ed25519 run --------------------------------------------------------
  const keys = makeApprovalKeys("i6-ed25519")

  await withEnv(
    {
      [ENV_ED25519_PRIVATE]: keys.privateKey,
      [ENV_ED25519_PUBLIC]: keys.publicKey,
      [ENV_ED25519_KEY_ID]: keys.keyId,
    },
    async () => {
      await withRun(
        "i6-ed25519-run",
        {
          sessionId: "20261124-000000-i6a",
          request: "Deliver one fixture change that the offline verifier can check.",
          requirements: requirement,
          requireHandoffs: "skip",
          tasks: [{ id: "T1" }],
        },
        async (fx) => {
          const manifest = JSON.parse(readFileSync(join(fx.runDir, "run.manifest.json"), "utf8"))
          expect(manifest._auth.alg).toBe("ed25519")
          expect(manifest._auth.keyId).toBe(keys.keyId)

          const final = await completeStandardRun(fx)
          expect(final.status).toBe("PASS")
          expect(readFinal(fx).status).toBe("PASS")

          const publicKeyFile = join(mkdtempSync(join(tmpdir(), "teamwork-i6-key-")), "i6.pub")
          writeFileSync(publicKeyFile, `${keys.publicKey}\n`)

          const clean = cliVerify(["--run-dir", fx.runDir, "--public-key", `@${publicKeyFile}`])
          expect({ code: clean.code, stderr: clean.stderr }).toEqual({ code: 0, stderr: "" })
          expect(clean.json?.verdict).toBe("PASS")
          expect(clean.json?.trust).toEqual({
            alg: "ed25519",
            keyId: keys.keyId,
            source: "public-key",
            runTrustLevel: "local-hmac",
            approval: { status: "NOT_REQUIRED" },
            witness: { status: "NOT_REQUIRED" },
          })
          expect(clean.json?.runId).toBe(fx.runId)
          expect(clean.json?.counts.fail).toBe(0)

          // The verifier writes nothing: verify a read-only copy and compare
          // every byte before and after.
          const readOnly = readOnlyCopy(fx.runDir, fx.runId)
          try {
            const before = snapshotTree(readOnly)
            const readOnlyVerify = cliVerify(["--run-dir", readOnly, "--public-key", `@${publicKeyFile}`])
            expect({ code: readOnlyVerify.code, stderr: readOnlyVerify.stderr }).toEqual({ code: 0, stderr: "" })
            expect(readOnlyVerify.json?.verdict).toBe("PASS")
            expect(treeDiff(before, snapshotTree(readOnly))).toEqual({ added: [], removed: [], changed: [] })
          } finally {
            makeWritable(readOnly)
            rmSync(readOnly, { recursive: true, force: true })
          }

          // --- one byte flip on a copy -------------------------------------
          // The copy keeps the run id, so the only difference is the flip.
          const tamperParent = mkdtempSync(join(tmpdir(), "teamwork-i6-tamper-"))
          const tamperedRun = join(tamperParent, fx.runId)
          cpSync(fx.runDir, tamperedRun, { recursive: true, preserveTimestamps: true })
          flipFirstByte(join(tamperedRun, "verify", "report-T1.json"))
          try {
            const flipped = cliVerify(["--run-dir", tamperedRun, "--public-key", `@${publicKeyFile}`])
            expect(flipped.code).toBe(1)
            expect(flipped.json?.verdict).toBe("FAIL")
            expect(flipped.json?.reasons.length).toBeGreaterThan(0)
            expect(
              flipped.json.reasons.some(
                (reason: string) => reason.includes("AUTH_STALE") || reason.includes("AUTH_INVALID"),
              ),
            ).toBe(true)
          } finally {
            makeWritable(tamperedRun)
            rmSync(tamperParent, { recursive: true, force: true })
          }
        },
      )
    },
  )


  // --- HMAC run -----------------------------------------------------------
  await withRun(
    "i6-hmac-run",
    {
      sessionId: "20261124-000000-i6b",
      request: "Deliver one fixture change verified with the run HMAC key.",
      requirements: requirement,
      requireHandoffs: "skip",
      tasks: [{ id: "T1" }],
    },
    async (fx) => {
      const final = await completeStandardRun(fx)
      expect(final.status).toBe("PASS")
      const manifest = JSON.parse(readFileSync(join(fx.runDir, "run.manifest.json"), "utf8"))
      expect(manifest._auth.alg).toBe("hmac-sha256")

      const verified = cliVerify(["--run-dir", fx.runDir, "--hmac-key", hmacKey(), "--hmac-key-id", String(manifest.runKeyId)])
      expect({ code: verified.code, stderr: verified.stderr }).toEqual({ code: 0, stderr: "" })
      expect(verified.json?.verdict).toBe("PASS")
      expect(verified.json?.trust.source).toBe("hmac-key")
    },
  )

  // --- command provenance ------------------------------------------------
  await withRun(
    "i6-command-run",
    {
      sessionId: "20261124-000000-i6c",
      request: "Deliver one fixture change whose verifier check is re-executable.",
      requirements: requirement,
      requireHandoffs: "skip",
      requiredProvenance: "command",
      tasks: [{ id: "T1" }],
    },
    async (fx) => {
      const final = await completeStandardRun(fx, {
        passChecks: [
          {
            name: "node-arithmetic",
            type: "programmatic",
            passed: true,
            command: ["node", "-p", "1+1"],
            output: "2\n",
            exitCode: 0,
            durationMs: 1,
          },
        ],
      })
      expect(final.status).toBe("PASS")
      const report = JSON.parse(readFileSync(join(fx.runDir, "verify", "report-T1.json"), "utf8"))
      expect(report.round).toBe(1)
      expect(report.headSha).toMatch(/^[0-9a-f]{40}$/)
      expect(report.checks[0].type).toBe("programmatic")
      expect(report.checks[0].command).toEqual(["node", "-p", "1+1"])
      expect(report.checks[0].outputTruncated).toBe(false)
      const rerun = JSON.parse(readFileSync(join(fx.runDir, "verify", "rerun.json"), "utf8"))
      expect(rerun.tasks.T1.checks[0].argv).toEqual(["node", "-p", "1+1"])
      expect(rerun._auth).toBeDefined()

      // Without re-execution the claim is advisory, never a PASS.
      const advisory = cliVerify(["--run-dir", fx.runDir, "--hmac-key", hmacKey(), "--hmac-key-id", "env"])
      expect(advisory.code).toBe(2)
      expect(advisory.json?.verdict).toBe("UNKNOWN")
      expect(
        advisory.json.checks.some((entry: any) => entry.status === "unknown" && entry.id === "provenance:required"),
      ).toBe(true)

      // On a clean checkout the recorded command re-executes inside a
      // disposable worktree and the claim is promoted to PASS.
      const before = snapshotTree(fx.runDir)
      const rerunVerify = cliVerify([
        "--run-dir",
        fx.runDir,
        "--hmac-key",
        hmacKey(),
        "--hmac-key-id",
        "env",
        "--rerun",
        "--repo",
        fx.project.root,
      ])
      expect({ code: rerunVerify.code, stderr: rerunVerify.stderr }).toEqual({ code: 0, stderr: "" })
      expect(rerunVerify.json?.verdict).toBe("PASS")
      expect(
        rerunVerify.json.checks.some(
          (entry: any) => entry.status === "pass" && String(entry.id).startsWith("rerun:T1:"),
        ),
      ).toBe(true)
      expect(rerunVerify.json.checks.some((entry: any) => entry.status === "fail")).toBe(false)
      // `--rerun` must not write into the run either.
      expect(treeDiff(before, snapshotTree(fx.runDir))).toEqual({ added: [], removed: [], changed: [] })
      expect(statSync(fx.runDir).isDirectory()).toBe(true)
      expect(readdirSync(fx.runDir).length).toBeGreaterThan(0)
    },
  )
})
