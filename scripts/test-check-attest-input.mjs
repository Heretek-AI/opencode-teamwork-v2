// test-check-attest-input — the CI attestation input/record guard.
//
// H4: `manifest_path` was an unvalidated workflow input written into
// `$GITHUB_ENV` and consumed by the job holding the attestation key. The
// workflow no longer accepts a path; `scripts/check-attest-input.mjs` derives it
// from the validated run id and rejects traversal, symlinks, malformed digests
// and an inconsistent test record. This test exercises every rejection.

import assert from "node:assert"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { payloadDigest } from "../plugins/opencode-teamwork/approval-format.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, "check-attest-input.mjs")
const WORK = mkdtempSync(join(tmpdir(), "teamwork-attest-input-"))
const REPO = join(WORK, "repo")
const RUN_ID = "20261125-000000-ci"
const COMMIT = "c".repeat(40)
const REF = "refs/heads/main"
const MANIFEST = {
  v: 1,
  runId: RUN_ID,
  planHash: "a".repeat(64),
  specHash: "b".repeat(64),
  runNonce: "nonce-fixture",
}
const DIGEST = payloadDigest(MANIFEST)
let outputCounter = 0

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function writeManifest(dir, name, body = MANIFEST) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`)
}

function runScript(args, env = {}, cwd = REPO) {
  const outputPath = join(WORK, `github-output-${outputCounter++}.txt`)
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      GITHUB_SHA: COMMIT,
      GITHUB_REF: REF,
      ...env,
    },
  })
  let output = ""
  try {
    output = readFileSync(outputPath, "utf8")
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output }
}

function expectFailure(label, args, env = {}) {
  const result = runScript(args, env)
  assert.notStrictEqual(result.status, 0, `${label}: expected a non-zero exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.ok(result.stderr.includes("check-attest-input:"), `${label}: expected a diagnostic on stderr`)
}

function makeRecord(name, overrides = {}) {
  const dir = join(WORK, `record-${name}`)
  mkdirSync(dir, { recursive: true })
  const output = overrides.output ?? "tests passed\n"
  const testExitCode = overrides.testExitCode ?? 0
  const commandExitCode = overrides.commandExitCode ?? testExitCode
  const manifest = overrides.manifest ?? MANIFEST
  const record = {
    runId: overrides.runId ?? RUN_ID,
    manifestDigest: overrides.manifestDigest ?? DIGEST,
    commit: overrides.commit ?? COMMIT,
    ref: overrides.ref ?? REF,
    testExitCode,
  }
  writeFileSync(join(dir, "test-record.json"), `${JSON.stringify(record, null, 2)}\n`)
  writeFileSync(join(dir, "test-output.txt"), output)
  const command = {
    argv: ["npm", "test"],
    cwd: ".",
    exitCode: commandExitCode,
    outputSha256: overrides.outputSha256 ?? sha256(Buffer.from(output, "utf8")),
    outputBytes: overrides.outputBytes ?? Buffer.byteLength(output),
  }
  writeFileSync(join(dir, "commands.json"), `${JSON.stringify([command], null, 2)}\n`)
  writeManifest(dir, "run.manifest.json", manifest)
  return dir
}

try {
  const expectedManifest = join(REPO, ".opencode", "teamwork", RUN_ID, "run.manifest.json")
  writeManifest(join(REPO, ".opencode", "teamwork", RUN_ID), "run.manifest.json")

  // ==========================================================================
  // 1. Valid fixed-path derivation and manifest checking
  // ==========================================================================
  {
    const result = runScript(["--require-manifest"], { RUN_ID, MANIFEST_DIGEST: DIGEST })
    assert.strictEqual(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(`manifest_path=${expectedManifest}`), result.stdout)
    assert.strictEqual(result.output.trim(), `manifest_path=${expectedManifest}`)
    console.log("✓ accepts a valid run id and fixed manifest path")
  }

  {
    const result = runScript([], { RUN_ID, MANIFEST_DIGEST: DIGEST.toUpperCase() })
    assert.strictEqual(result.status, 0, "the digest is normalized to lowercase like attest-sign")
    assert.strictEqual(result.output.trim(), `manifest_path=${expectedManifest}`)
    console.log("✓ normalizes an uppercase manifest digest")
  }

  // ==========================================================================
  // 2. Malformed scalars: no path, no control characters, no traversal
  // ==========================================================================
  expectFailure("missing run id", [], { RUN_ID: "", MANIFEST_DIGEST: DIGEST })
  expectFailure("traversal run id", [], { RUN_ID: "../../etc", MANIFEST_DIGEST: DIGEST })
  expectFailure("slash run id", [], { RUN_ID: "a/b", MANIFEST_DIGEST: DIGEST })
  expectFailure("newline run id", [], { RUN_ID: "run\nBAD=1", MANIFEST_DIGEST: DIGEST })
  expectFailure("overlong run id", [], { RUN_ID: `a${"b".repeat(64)}`, MANIFEST_DIGEST: DIGEST })
  expectFailure("short digest", [], { RUN_ID, MANIFEST_DIGEST: "a".repeat(63) })
  expectFailure("non-hex digest", [], { RUN_ID, MANIFEST_DIGEST: "z".repeat(64) })
  expectFailure("missing digest", [], { RUN_ID, MANIFEST_DIGEST: "" })
  console.log("✓ rejects traversal, separators, control characters and malformed digests")

  // ==========================================================================
  // 3. The manifest must be the fixed file, not a symlink or another file
  // ==========================================================================
  expectFailure("missing manifest", ["--require-manifest"], {
    RUN_ID: "20261125-000001-missing",
    MANIFEST_DIGEST: DIGEST,
  })
  {
    const runId = "20261125-000002-link"
    const dir = join(REPO, ".opencode", "teamwork", runId)
    mkdirSync(dir, { recursive: true })
    const outside = join(WORK, "outside-manifest.json")
    writeFileSync(outside, `${JSON.stringify(MANIFEST)}\n`)
    symlinkSync(outside, join(dir, "run.manifest.json"))
    expectFailure("symlinked manifest", ["--require-manifest"], { RUN_ID: runId, MANIFEST_DIGEST: DIGEST })
  }
  {
    const other = { ...MANIFEST, runNonce: "different-nonce" }
    const runId = "20261125-000003-wrong-digest"
    writeManifest(join(REPO, ".opencode", "teamwork", runId), "run.manifest.json", other)
    expectFailure("digest mismatch", ["--require-manifest"], { RUN_ID: runId, MANIFEST_DIGEST: DIGEST })
  }
  console.log("✓ rejects a missing, symlinked or digest-mismatched manifest")

  // ==========================================================================
  // 4. The test record handed to the signing job must be consistent
  // ==========================================================================
  {
    const record = makeRecord("valid")
    const result = runScript(["--verify-record", record], { RUN_ID, MANIFEST_DIGEST: DIGEST })
    assert.strictEqual(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes("record verified"), result.stdout)
    console.log("✓ accepts a consistent test record")
  }

  {
    const record = makeRecord("output")
    writeFileSync(join(record, "test-output.txt"), "tests passed\nforged trailing line\n")
    expectFailure("tampered output", ["--verify-record", record], { RUN_ID, MANIFEST_DIGEST: DIGEST })
  }
  expectFailure(
    "exit code mismatch",
    ["--verify-record", makeRecord("exit", { testExitCode: 1, commandExitCode: 0 })],
    { RUN_ID, MANIFEST_DIGEST: DIGEST },
  )
  expectFailure(
    "wrong output digest",
    ["--verify-record", makeRecord("sha", { outputSha256: "d".repeat(64) })],
    { RUN_ID, MANIFEST_DIGEST: DIGEST },
  )
  expectFailure(
    "wrong commit",
    ["--verify-record", makeRecord("commit", { commit: "d".repeat(40) })],
    { RUN_ID, MANIFEST_DIGEST: DIGEST },
  )
  expectFailure(
    "wrong ref",
    ["--verify-record", makeRecord("ref", { ref: "refs/heads/other" })],
    { RUN_ID, MANIFEST_DIGEST: DIGEST },
  )
  expectFailure(
    "record digest mismatch",
    ["--verify-record", makeRecord("digest", { manifestDigest: "e".repeat(64) })],
    { RUN_ID, MANIFEST_DIGEST: DIGEST },
  )
  {
    const record = makeRecord("manifest", { manifest: { ...MANIFEST, runNonce: "other" } })
    expectFailure("record manifest mismatch", ["--verify-record", record], {
      RUN_ID,
      MANIFEST_DIGEST: DIGEST,
    })
  }
  {
    const record = makeRecord("symlink")
    const outputPath = join(record, "test-output.txt")
    const outside = join(WORK, "outside-output.txt")
    writeFileSync(outside, "tests passed\n")
    rmSync(outputPath)
    symlinkSync(outside, outputPath)
    expectFailure("symlinked output", ["--verify-record", record], { RUN_ID, MANIFEST_DIGEST: DIGEST })
  }
  console.log("✓ rejects a tampered, mismatched or symlinked test record")

  // ==========================================================================
  // 5. Workflow guard: no path input and no privilege in the test job
  // ==========================================================================
  {
    const attestPath = join(HERE, "..", ".github", "workflows", "attest.yml")
    const publishPath = join(HERE, "..", ".github", "workflows", "publish.yml")
    if (!existsSync(attestPath) || !existsSync(publishPath)) {
      // The npm tarball ships scripts/ but not .github/; keep the suite usable
      // from an installed package and enforce this guard in the source repo.
      console.log("SKIP: workflow guard (workflows are not present in this checkout)")
    } else {
      const stripCommentLines = (text) =>
        text
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n")
      const attest = stripCommentLines(readFileSync(attestPath, "utf8"))
      assert.ok(!/^\s+manifest_path:/m.test(attest), "attest.yml must not accept a manifest_path input")
      assert.ok(!attest.includes("GITHUB_ENV"), "attest.yml must not write inputs to GITHUB_ENV")
      const signAt = attest.search(/^  sign:$/m)
      assert.ok(signAt > 0, "attest.yml must keep a separate sign job")
      const testJob = attest.slice(0, signAt)
      assert.ok(!testJob.includes("id-token"), "the test job must not request an OIDC token")
      assert.ok(!testJob.includes("ATTESTATION_PRIVATE_KEY"), "the test job must not see the attestation key")
      assert.strictEqual(
        (attest.match(/id-token:\s*write/g) || []).length,
        1,
        "only the sign job should request id-token: write",
      )

      const publish = stripCommentLines(readFileSync(publishPath, "utf8"))
      const publishAt = publish.search(/^  publish:$/m)
      assert.ok(publishAt > 0, "publish.yml must keep a separate publish job")
      const verifyJob = publish.slice(0, publishAt)
      const publishJob = publish.slice(publishAt)
      assert.ok(verifyJob.includes("npm test"), "the verify job should run the tests")
      assert.ok(!verifyJob.includes("id-token"), "the test job must not request an OIDC token")
      assert.ok(!verifyJob.includes("npm publish"), "the verify dry-run must never publish")
      assert.ok(publishJob.includes("npm publish"), "the publish job should publish the verified tarball")
      assert.match(
        publishJob,
        /^\s+if:\s+startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*$/m,
        "the publish job must be gated to refs/tags/v*",
      )
      // Explicitly document why the gate is enough for the workflow_dispatch case.
      for (const ref of ["refs/heads/main", "refs/heads/fix/ci-trust", "refs/pull/1/merge"]) {
        assert.ok(!ref.startsWith("refs/tags/v"), `${ref} must not pass the publish tag gate`)
      }
      assert.strictEqual(
        (publish.match(/id-token:\s*write/g) || []).length,
        1,
        "only the publish job should request id-token: write",
      )
      console.log("✓ workflow guard: fixed path only, test job has no OIDC/key, publish is tag-gated")
    }
  }

  console.log("✓ test-check-attest-input passed: fixed manifest path, strict scalars, verified record")
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
