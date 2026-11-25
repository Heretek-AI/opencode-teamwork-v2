// L2 spot-check for the strict input boundary (ADR 0019).
//
// The host's JSON-Schema decoder ignores excess properties, so the plugin's
// Standard Schema is what refuses `teamwork_plan { bogus: 1 }`. This spec calls
// the tool through the host's real snapshot executor (decode + validation +
// execute), not the registered executor directly, so it proves the refusal and
// the valid path both survive the runtime boundary.

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { planInput, teamworkRoot, withHost } from "../harness/plan"
import { executeViaRuntime } from "../harness/run"

test("L2 strict input: teamwork_plan with an unknown property is refused before any write", async () => {
  await withHost("j-strict-input-unknown", async ({ project, loaded, root }) => {
    const result = await executeViaRuntime(loaded, root, "plan", { ...planInput(), bogus: 1 })

    expect(result.status).toBe("ERROR")
    expect(result.error).toContain('Invalid arguments for tool "teamwork_plan"')
    expect(result.error).toContain("bogus: unknown property")
    expect(existsSync(teamworkRoot(project))).toBe(false)
  })
})

test("L2 strict input: teamwork_plan with a valid minimal body still succeeds", async () => {
  await withHost("j-strict-input-valid", async ({ project, loaded, root }) => {
    const result = await executeViaRuntime(loaded, root, "plan", planInput())

    expect(result.status).not.toBe("ERROR")
    expect(result.content.startsWith("Planned ")).toBe(true)
    expect(existsSync(teamworkRoot(project))).toBe(true)
  })
})
