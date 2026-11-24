import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  planInput,
  planRun,
  readEvents,
  readManifest,
  readPlan,
  readRunJson,
  runDir,
  runFile,
  snapshotTree,
  teamworkRoot,
  treeDiff,
  withHost,
  withStorageHost,
  writeSpec,
} from "../harness/plan"
import { execute, executeViaRuntime } from "../harness/run"
import { APPROVAL_ENV_DIR, APPROVAL_ENV_KEY_ID, APPROVAL_ENV_PUBLIC_KEY, assertSignedManifest, assertManifestStable, readStorageKeyRing, withEnv, withoutSigningEnv } from "../harness/sign"
import { approvalFormat } from "./helpers"

test("B1 teamwork_plan without a spec refuses and creates no run dir", async () => {
  await withHost("b1-no-spec", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b1"
    const before = snapshotTree(project.root)
    const result = await planRun(loaded, root, { sessionId: runId, skipInterview: false })
    expect(result.content).toContain("refused: no spec found")
    expect(existsSync(runDir(project, runId))).toBe(false)
    expect(treeDiff(before, snapshotTree(project.root))).toEqual({ added: [], removed: [], changed: [] })

    // The same refusal through the host's snapshot executor: the runtime path
    // decodes the schema and runs the same registered tool.
    const viaRuntime = await executeViaRuntime(loaded, root, "plan", planInput({ sessionId: runId, skipInterview: false }))
    expect(viaRuntime.content).toContain("refused: no spec found")
    expect(existsSync(runDir(project, runId))).toBe(false)
  })
})

test("B2 a whitespace-only draft still refuses and writes no plan artifacts", async () => {
  await withHost("b2-whitespace-spec", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b2"
    writeSpec(project, runId, "   \n\t\n  \n")
    const before = snapshotTree(runDir(project, runId))
    const result = await planRun(loaded, root, { sessionId: runId, skipInterview: false })
    expect(result.content).toContain("refused: no spec found")
    expect(existsSync(runFile(project, runId, "plan.dag.json"))).toBe(false)
    expect(existsSync(runFile(project, runId, "ORIGINAL_REQUEST.md"))).toBe(false)
    expect(existsSync(runFile(project, runId, "run.manifest.json"))).toBe(false)
    // Only prompt_draft.md existed before the call and that is all that exists now.
    expect(treeDiff(before, snapshotTree(runDir(project, runId)))).toEqual({ added: [], removed: [], changed: [] })
  })
})

test("B3 skipInterview records specGate: bypassed in events.jsonl", async () => {
  await withHost("b3-skip-interview", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b3"
    const result = await planRun(loaded, root, { sessionId: runId })
    expect(result.content.startsWith("Planned ")).toBe(true)
    const created = readEvents(project, runId).find((event) => event.event === "run_created")
    expect(created).toBeDefined()
    expect(created.specGate).toBe("bypassed")
    expect(readPlan(project, runId)?.sessionId).toBe(runId)
  })
})

test("B4 a signed plan writes manifest v4 with the run key, nonce, hashes, signed handoffs and planAgent", async () => {
  await withHost("b4-manifest", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b4"
    const request = "Ship a deterministic two-task change with tests."
    const requirements = [
      { id: "R1", text: "The two-task change is delivered." },
      { id: "R2", text: "The tests pass." },
    ]
    const result = await planRun(loaded, root, { sessionId: runId, request, requirements })
    expect(result.content.startsWith("Planned ")).toBe(true)

    const manifest = assertSignedManifest(project, runId, { planAgent: "team/sentinel", requiredProvenance: "declared" })
    expect(manifest._auth.alg).toBe("hmac-sha256")
    expect(manifest.runNonce).toHaveLength(22)
    expect(Buffer.from(String(manifest.runNonce), "base64url")).toHaveLength(16)

    const { sha256Hex, canonicalJson } = await approvalFormat()
    const requestText = readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")
    expect(manifest.requestHash).toBe(sha256Hex(requestText))
    const requirementsFile = readRunJson(project, runId, "requirements.json")
    expect(manifest.requirementsHash).toBe(sha256Hex(canonicalJson(requirementsFile)))
    const plan = readPlan(project, runId)
    const planHash = sha256Hex(
      canonicalJson({
        topology: plan.topology ?? null,
        integrityMode: plan.integrityMode ?? null,
        verification: plan.verification ?? null,
        victoryAudit: plan.victoryAudit ?? null,
        ...(typeof plan.victorySkipReason === "string" && plan.victorySkipReason !== ""
          ? { victorySkipReason: plan.victorySkipReason }
          : {}),
        ...(plan.requireHandoffs !== undefined && plan.requireHandoffsSource !== "legacy"
          ? { requireHandoffs: plan.requireHandoffs }
          : {}),
        route: plan.route ?? null,
        lemmaBounds: plan.lemmaBounds ?? null,
        ...(plan.requireSameHost === true ? { requireSameHost: true } : {}),
        tasks: Array.isArray(plan.tasks) ? plan.tasks : [],
      }),
    )
    expect(manifest.planHash).toBe(planHash)
  })
})

test("B4b the plugin's own storage key ring signs the manifest when no signing env is set", async () => {
  await withStorageHost("b4b-storage-ring", async ({ project, loaded, root, storage }) => {
    const runId = "20261124-000000-b4b"
    await withoutSigningEnv(async () => {
      const result = await planRun(loaded, root, { sessionId: runId })
      expect(result.content.startsWith("Planned ")).toBe(true)
    })
    const ring = await readStorageKeyRing(storage)
    const manifest = assertSignedManifest(project, runId, { planAgent: "team/sentinel" })
    expect(manifest.runKeyId).toBe(ring.keys[0].keyId)
    expect(manifest._auth.keyId).toBe(ring.keys[0].keyId)
    expect(manifest._auth.alg).toBe("hmac-sha256")
  })
})

test("B5 human-approved without an approval directory refuses AUTH_APPROVAL_DIR and writes nothing", async () => {
  await withHost("b5-approval-dir", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b5"
    await withEnv(
      {
        [APPROVAL_ENV_DIR]: undefined,
        [APPROVAL_ENV_PUBLIC_KEY]: undefined,
        [APPROVAL_ENV_KEY_ID]: undefined,
      },
      async () => {
        const before = snapshotTree(project.root)
        const result = await planRun(loaded, root, { sessionId: runId, trustLevel: "human-approved" })
        expect(result.content).toContain("[AUTH_APPROVAL_DIR]")
        expect(existsSync(runDir(project, runId))).toBe(false)
        expect(treeDiff(before, snapshotTree(project.root))).toEqual({ added: [], removed: [], changed: [] })
      },
    )
  })
})

test("B6 benchmark refuses mode downgrades: strict→standard, required→skip, victory skip, local-hmac", async () => {
  await withHost("b6-benchmark", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b6"
    const base = await planRun(loaded, root, {
      sessionId: runId,
      integrityMode: "benchmark",
      verification: "strict",
      requireHandoffs: "required",
      request: "Benchmark fixture.",
    })
    expect(base.content.startsWith("Planned ")).toBe(true)
    const baseline = readManifest(project, runId)

    const strictToStandard = await planRun(loaded, root, { sessionId: runId, request: null, verification: "standard" })
    expect(strictToStandard.content).toContain('verification is already persisted as "strict"')

    const requiredToSkip = await planRun(loaded, root, { sessionId: runId, request: null, requireHandoffs: "skip" })
    expect(requiredToSkip.content).toContain('requireHandoffs is already persisted as "required"')

    const victorySkip = await planRun(loaded, root, { sessionId: runId, request: null, victoryAudit: "skip", victorySkipReason: "fixture downgrade" })
    expect(victorySkip.content).toContain('victoryAudit is already persisted as "required"')

    // A fresh benchmark run cannot record a victory skip at all.
    const freshSkip = await planRun(loaded, root, {
      sessionId: "20261124-000000-b6s",
      integrityMode: "benchmark",
      victoryAudit: "skip",
      victorySkipReason: "fixture skip",
    })
    expect(freshSkip.content).toContain("benchmark mode requires the independent victory audit")

    // And an explicit local-hmac trust level is refused by benchmark.
    const explicitHmac = await planRun(loaded, root, {
      sessionId: "20261124-000000-b6h",
      integrityMode: "benchmark",
      trustLevel: "local-hmac",
      request: "Benchmark fixture.",
    })
    expect(explicitHmac.content).toContain("[AUTH_TRUST_LEVEL]")

    assertManifestStable(baseline!, readManifest(project, runId), "B6 re-plan refusals")
  })
})

test("B7 a re-plan keeps verification, victoryAudit, requireHandoffs and provenance, and upgrades declared→command", async () => {
  await withHost("b7-replan", async ({ project, loaded, root }) => {
    const strictRun = "20261124-000000-b7"
    const base = await planRun(loaded, root, {
      sessionId: strictRun,
      request: "Re-plan fixture.",
      verification: "strict",
      victoryAudit: "required",
      requireHandoffs: "required",
      requiredProvenance: "command",
    })
    expect(base.content.startsWith("Planned ")).toBe(true)
    const baseline = readManifest(project, strictRun)

    const verificationDowngrade = await planRun(loaded, root, { sessionId: strictRun, request: null, verification: "standard" })
    expect(verificationDowngrade.content).toContain('verification is already persisted as "strict"')

    const victoryDowngrade = await planRun(loaded, root, {
      sessionId: strictRun,
      request: null,
      victoryAudit: "skip",
      victorySkipReason: "fixture downgrade",
    })
    expect(victoryDowngrade.content).toContain('victoryAudit is already persisted as "required"')

    const handoffDowngrade = await planRun(loaded, root, { sessionId: strictRun, request: null, requireHandoffs: "skip" })
    expect(handoffDowngrade.content).toContain('requireHandoffs is already persisted as "required"')

    const provenanceDowngrade = await planRun(loaded, root, { sessionId: strictRun, request: null, requiredProvenance: "declared" })
    expect(provenanceDowngrade.content).toContain("[AUTH_STALE]")
    expect(provenanceDowngrade.content).toContain('requiredProvenance is already persisted as "command"')

    assertManifestStable(baseline!, readManifest(project, strictRun), "B7 refused downgrades")

    // Declared → command is an allowed upgrade on a fresh run.
    const upgradeRun = "20261124-000000-b7u"
    const declared = await planRun(loaded, root, { sessionId: upgradeRun, request: "Provenance upgrade fixture." })
    expect(declared.content.startsWith("Planned ")).toBe(true)
    expect(readManifest(project, upgradeRun)?.requiredProvenance).toBe("declared")
    const upgraded = await planRun(loaded, root, { sessionId: upgradeRun, request: null, requiredProvenance: "command" })
    expect(upgraded.content.startsWith("Planned ")).toBe(true)
    const manifest = assertSignedManifest(project, upgradeRun, { requiredProvenance: "command" })
    expect(manifest.version).toBe(4)
  })
})

test("B8 ORIGINAL_REQUEST.md is write-once: a second plan with a different request refuses", async () => {
  await withHost("b8-request-once", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-b8"
    const first = await planRun(loaded, root, { sessionId: runId, request: "First request body." })
    expect(first.content.startsWith("Planned ")).toBe(true)
    const requestPath = runFile(project, runId, "ORIGINAL_REQUEST.md")
    const recorded = readFileSync(requestPath, "utf8")
    const planBefore = snapshotTree(runDir(project, runId))
    const second = await planRun(loaded, root, { sessionId: runId, request: "A different request body." })
    expect(second.content).toContain("already records this run's request and is write-once")
    expect(readFileSync(requestPath, "utf8")).toBe(recorded)
    expect(treeDiff(planBefore, snapshotTree(runDir(project, runId)))).toEqual({ added: [], removed: [], changed: [] })
  })
})

test("B9 route table: eight representative requests return their topology/route and write nothing", async () => {
  await withHost("b9-routes", async ({ project, loaded, root }) => {
    const before = snapshotTree(project.root)
    const cases: Array<{ request: string; document?: Record<string, string>; topology: string; route: string }> = [
      { request: "Fix the typo in the README.", topology: "small-focused", route: "small-focused" },
      { request: "Fix the bug in src/parser.ts with a unit test.", topology: "iterative-coding", route: "iterative-coding" },
      { request: "Build a distributed event pipeline across three services.", topology: "distributed-coding", route: "general" },
      { request: "Prove that there are infinitely many primes", topology: "proof", route: "proof" },
      { request: "Prove Fermat's Little Theorem in Lean 4", topology: "proof", route: "lemma" },
      { request: "Use a proof tournament to prove this theorem", topology: "massive-proof", route: "massive-proof" },
      {
        request: "Critique this paper and identify weaknesses in its methodology.",
        document: { content: "# A Paper\n\nThe method is questionable.\n", format: "markdown" },
        topology: "document-review",
        route: "document-review",
      },
      // Negative gate: naming a .lean file is not an explicit Lean proof request.
      { request: "Explain what Foo.lean does", topology: "distributed-coding", route: "general" },
    ]
    for (const item of cases) {
      const result = await execute(loaded, root, "route", {
        request: item.request,
        ...(item.document ? { document: item.document } : {}),
      })
      expect({ request: item.request, topology: result.topology, route: result.route }).toEqual({
        request: item.request,
        topology: item.topology,
        route: item.route,
      })
      expect(result.content).toContain(`Route: ${item.topology}`)
    }
    expect(existsSync(teamworkRoot(project))).toBe(false)
    expect(treeDiff(before, snapshotTree(project.root))).toEqual({ added: [], removed: [], changed: [] })

    // One call through the host's snapshot executor proves the runtime boundary
    // decodes and runs the same registered route tool.
    const viaRuntime = await executeViaRuntime(loaded, root, "route", { request: "Fix the typo in the README." })
    expect(viaRuntime.content).toContain("Route: small-focused")
  })
})
