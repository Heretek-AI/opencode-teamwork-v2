import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { planRun, readEvents, readManifest, readRunJson, runFile, snapshotTree, treeDiff, withHost, writeSpec, runDir } from "../harness/plan"
import {
  approvalEnv,
  makeApprovalDir,
  makeApprovalKeys,
  signDraftApproval,
  signHmacApproval,
  withApprovalOwner,
  withEnv,
} from "../harness/sign"
import { approvalFormat, isRefused } from "./helpers"

const EMPTY_DIFF = { added: [], removed: [], changed: [] }
const SPEC = "# Approved spec\n\n- Deliver the deterministic fixture.\n"

test("F20 approve sign then a human-approved plan is accepted; the manifest records the prompt binding", async () => {
  await withHost("f20-approved-plan", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-f20"
    writeSpec(project, runId, SPEC)
    const keys = makeApprovalKeys()
    const dir = makeApprovalDir(project, "f20")
    const approval = await signDraftApproval(project, runId, dir, { keys, approver: "uid:l2-reviewer" })

    await withApprovalOwner(async () => {
      await withEnv(approvalEnv(dir, keys), async () => {
        const result = await planRun(loaded, root, {
          sessionId: runId,
          request: "Ship the approved fixture.",
          tasks: [{ id: "T1" }],
          skipInterview: false,
          trustLevel: "human-approved",
        })
        expect(result.content.startsWith("Planned ")).toBe(true)
      })
    })

    const manifest = readManifest(project, runId)
    expect(manifest).toBeDefined()
    const { contentSha256Hex, payloadDigest } = await approvalFormat()
    const specBytes = Buffer.from(SPEC, "utf8")
    expect(manifest!.specHash).toBe(contentSha256Hex(specBytes))
    expect(manifest!.specBytes).toBe(specBytes.length)
    expect(manifest!.approvalDigest).toBe(payloadDigest(approval.artifact))
    expect(manifest!.approvalNonce).toBe(approval.artifact.approvalNonce)
    expect(manifest!.approvalBinding).toBe("prompt")
    expect(manifest!.approvedBy).toBe("uid:l2-reviewer")
    expect(manifest!.approvedAt).toBe(approval.artifact.approvedAt)
    expect(manifest!.approvalPolicy).toBe("external-dir")
    expect(manifest!.approvalKeyId).toBe(keys.keyId)
    expect(manifest!._auth.alg).toBe("hmac-sha256")

    const event = readEvents(project, runId).find((item) => item.event === "run_created")
    expect(event.approvalDigest).toBe(manifest!.approvalDigest)
    expect(event.approvedBy).toBe("uid:l2-reviewer")
    expect(event.binding).toBe("prompt")
    expect(event.promptDraftSha256).toBe(manifest!.specHash)
  })
})

test("F21 a one-byte draft edit after approval is AUTH_APPROVAL_STALE and writes nothing", async () => {
  await withHost("f21-stale-draft", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-f21"
    writeSpec(project, runId, SPEC)
    const keys = makeApprovalKeys()
    const dir = makeApprovalDir(project, "f21")
    await signDraftApproval(project, runId, dir, { keys })

    // One byte changed after the approval signed the exact draft bytes.
    writeFileSync(runFile(project, runId, "prompt_draft.md"), `${SPEC}!`, "utf8")
    const before = snapshotTree(runDir(project, runId))

    await withApprovalOwner(async () => {
      await withEnv(approvalEnv(dir, keys), async () => {
        const result = await planRun(loaded, root, {
          sessionId: runId,
          request: "Ship the approved fixture.",
          skipInterview: false,
          trustLevel: "human-approved",
        })
        expect(result.content).toContain("[AUTH_APPROVAL_STALE]")
        expect(isRefused(result)).toBe(true)
      })
    })

    expect(existsSync(runFile(project, runId, "plan.dag.json"))).toBe(false)
    expect(existsSync(runFile(project, runId, "run.manifest.json"))).toBe(false)
    expect(existsSync(runFile(project, runId, "ORIGINAL_REQUEST.md"))).toBe(false)
    expect(treeDiff(before, snapshotTree(runDir(project, runId)))).toEqual(EMPTY_DIFF)
  })
})

test("F22 reusing a fresh approval for a second plan of the same run is AUTH_APPROVAL_REPLAY", async () => {
  await withHost("f22-replay", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-f22"
    writeSpec(project, runId, SPEC)
    const keys = makeApprovalKeys()
    const dir = makeApprovalDir(project, "f22")

    await withApprovalOwner(async () => {
      await withEnv(approvalEnv(dir, keys), async () => {
        await signDraftApproval(project, runId, dir, { keys })
        const first = await planRun(loaded, root, {
          sessionId: runId,
          request: "Ship the approved fixture.",
          tasks: [{ id: "T1" }],
          skipInterview: false,
          trustLevel: "human-approved",
        })
        expect(first.content.startsWith("Planned ")).toBe(true)
        const manifestBefore = readFileSync(runFile(project, runId, "run.manifest.json"), "utf8")
        const requestBefore = readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")

        // A new nonce is a new approval, but the run already consumed one.
        await signDraftApproval(project, runId, dir, { keys })
        const replay = await planRun(loaded, root, {
          sessionId: runId,
          request: null,
          skipInterview: false,
        })
        expect(replay.content).toContain("[AUTH_APPROVAL_REPLAY]")
        expect(readFileSync(runFile(project, runId, "run.manifest.json"), "utf8")).toBe(manifestBefore)
        expect(readFileSync(runFile(project, runId, "ORIGINAL_REQUEST.md"), "utf8")).toBe(requestBefore)
      })
    })
  })
})

test("F23 an HMAC-signed approval is refused as AUTH_APPROVAL_NOT_HUMAN", async () => {
  await withHost("f23-hmac-approval", async ({ project, loaded, root }) => {
    const runId = "20261124-000000-f23"
    writeSpec(project, runId, SPEC)
    const keys = makeApprovalKeys()
    const dir = makeApprovalDir(project, "f23")
    const approval = await signHmacApproval(project, runId, dir)
    expect(approval.artifact._auth.alg).toBe("hmac-sha256")

    await withApprovalOwner(async () => {
      await withEnv(approvalEnv(dir, keys), async () => {
        const result = await planRun(loaded, root, {
          sessionId: runId,
          request: "Ship the approved fixture.",
          skipInterview: false,
          trustLevel: "human-approved",
        })
        expect(result.content).toContain("[AUTH_APPROVAL_NOT_HUMAN]")
        expect(result.content).toContain("is signed with hmac-sha256")
      })
    })
    expect(existsSync(runFile(project, runId, "plan.dag.json"))).toBe(false)
    expect(existsSync(runFile(project, runId, "run.manifest.json"))).toBe(false)
  })
})

test("F24 approvedBy: team/sentinel is refused; uid:... is accepted", async () => {
  await withHost("f24-approver", async ({ project, loaded, root }) => {
    const keys = makeApprovalKeys()
    const dir = makeApprovalDir(project, "f24")

    await withApprovalOwner(async () => {
      await withEnv(approvalEnv(dir, keys), async () => {
        const badRun = "20261124-000000-f24bad"
        writeSpec(project, badRun, SPEC)
        await signDraftApproval(project, badRun, dir, { keys, approver: "team/sentinel" })
        const bad = await planRun(loaded, root, {
          sessionId: badRun,
          request: "Ship the bad-approver fixture.",
          skipInterview: false,
          trustLevel: "human-approved",
        })
        expect(bad.content).toContain("[AUTH_APPROVAL_NOT_HUMAN]")
        expect(bad.content).toContain("approvedBy must be uid:<name>, oidc:<issuer>#<sub>, or ci:<workflow>")
        expect(existsSync(runFile(project, badRun, "run.manifest.json"))).toBe(false)

        const goodRun = "20261124-000000-f24uid"
        writeSpec(project, goodRun, SPEC)
        await signDraftApproval(project, goodRun, dir, { keys, approver: "uid:l2-reviewer" })
        const good = await planRun(loaded, root, {
          sessionId: goodRun,
          request: "Ship the uid-approver fixture.",
          skipInterview: false,
          trustLevel: "human-approved",
        })
        expect(good.content.startsWith("Planned ")).toBe(true)
        expect(readManifest(project, goodRun)?.approvedBy).toBe("uid:l2-reviewer")
        expect(readRunJson(project, goodRun, "requirements.json").items.length).toBeGreaterThan(0)
      })
    })
  })
})
