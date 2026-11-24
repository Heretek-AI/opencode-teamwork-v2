import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createProject } from "../harness/project"
import { loadHost } from "../harness/load"
import { openLocationTools, runtimeExecute, toolById } from "../harness/tools"

test("A4 schema rejection: a missing required property yields the runtime Tool.Error and writes nothing", async () => {
  const project = createProject("a4-schema-missing")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const tools = await openLocationTools(loaded, project.root)
    toolById(tools, "teamwork_plan")
    const session = await loaded.host.sessions.create({ location: { directory: project.root } })
    const target = { sessionID: session.id, agent: "team/sentinel" }

    const missing = runtimeExecute(tools, "teamwork_plan", { request: "do the thing" }, target)
    await expect(missing).rejects.toThrow(/Invalid arguments for tool "teamwork_plan"/)
    await expect(missing).rejects.toThrow(/topology/)
    await expect(missing).rejects.toThrow(/tasks/)

    // Input validation runs before execute: no run directory was created.
    expect(existsSync(join(project.root, ".opencode", "teamwork"))).toBe(false)
  } finally {
    await loaded.close()
    project.cleanup()
  }
})

// OBSERVED — host limitation: OpenCode 2.4.1 converts a tool's JSON Schema to an
// Effect codec with `onExcessProperty: "ignore"` (the decoder strips unknown
// keys). `additionalProperties: false` therefore does NOT produce a Tool.Error
// at the runtime boundary. This test records the behaviour the 2.4.1 host
// actually provides; the A4 expectation that an unknown property is rejected is
// not met by the host. See README.md.
test("A4 unknown property (OBSERVED — the 2.4.1 runtime strips it instead of failing)", async () => {
  const project = createProject("a4-schema-unknown")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const tools = await openLocationTools(loaded, project.root)
    toolById(tools, "teamwork_route")
    const session = await loaded.host.sessions.create({ location: { directory: project.root } })
    const target = { sessionID: session.id, agent: "team/sentinel" }

    // A read-only tool makes the write assertion meaningful even though the call
    // succeeds: the unknown key is dropped before execute.
    const result = await runtimeExecute(
      tools,
      "teamwork_route",
      { request: "Rename the files in this directory.", unexpectedProperty: true },
      target,
    )
    expect(result.content.map((part: any) => part.text).join("")).toContain("Route:")
    expect(existsSync(join(project.root, ".opencode", "teamwork"))).toBe(false)
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
