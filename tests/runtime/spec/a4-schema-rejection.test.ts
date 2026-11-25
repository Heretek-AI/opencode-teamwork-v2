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

test("A4 an unknown top-level property is refused by the plugin's strict schema", async () => {
  const project = createProject("a4-schema-unknown")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const tools = await openLocationTools(loaded, project.root)
    toolById(tools, "teamwork_route")
    const session = await loaded.host.sessions.create({ location: { directory: project.root } })
    const target = { sessionID: session.id, agent: "team/sentinel" }

    // A read-only tool makes the write assertion meaningful: the call must fail
    // (not silently strip the key and succeed), and nothing is written.
    const refused = runtimeExecute(
      tools,
      "teamwork_route",
      { request: "Rename the files in this directory.", unexpectedProperty: true },
      target,
    )
    await expect(refused).rejects.toThrow(/Invalid arguments for tool "teamwork_route"/)
    await expect(refused).rejects.toThrow(/unexpectedProperty: unknown property/)
    expect(existsSync(join(project.root, ".opencode", "teamwork"))).toBe(false)

    // The same tool with only declared properties still works.
    const accepted = await runtimeExecute(
      tools,
      "teamwork_route",
      { request: "Rename the files in this directory." },
      target,
    )
    expect(accepted.content.map((part: any) => part.text).join("")).toContain("Route:")
    expect(existsSync(join(project.root, ".opencode", "teamwork"))).toBe(false)
  } finally {
    await loaded.close()
    project.cleanup()
  }
})

test("A4 an unknown nested property is refused and names its path", async () => {
  const project = createProject("a4-schema-unknown-nested")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const tools = await openLocationTools(loaded, project.root)
    const session = await loaded.host.sessions.create({ location: { directory: project.root } })
    const target = { sessionID: session.id, agent: "team/sentinel" }

    const refused = runtimeExecute(
      tools,
      "teamwork_plan",
      {
        request: "do the thing",
        topology: "iterative-coding",
        tasks: [{ id: "T1" }],
        skipInterview: true,
        requirements: [{ id: "R1", text: "delivered", bogus: true }],
      },
      target,
    )
    await expect(refused).rejects.toThrow(/requirements\[0\]\.bogus: unknown property/)
    expect(existsSync(join(project.root, ".opencode", "teamwork"))).toBe(false)
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
