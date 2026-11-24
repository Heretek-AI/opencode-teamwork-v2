import { expect, test } from "bun:test"
import { createProject } from "../harness/project"
import { loadHost } from "../harness/load"
import { openLocationTools, rawExecute, resultText, runtimeExecute, toolById } from "../harness/tools"

test("A8 tool result shape: teamwork_route returns a text content and no output without an output schema", async () => {
  const project = createProject("a8-shape")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const tools = await openLocationTools(loaded, project.root)
    const route = toolById(tools, "teamwork_route")
    expect(route.output).toBeUndefined()

    const session = await loaded.host.sessions.create({ location: { directory: project.root } })
    const input = { request: "Rename the files in this directory and update the imports." }
    const target = { sessionID: session.id, agent: "team/sentinel" }

    // The raw registered executor returns the plugin's own object: content is a
    // string and there is no `output` key (returning one would make the runtime
    // die with "Tool result declared output without an output schema").
    const raw = await rawExecute(route, input, target)
    expect(typeof raw.content).toBe("string")
    expect("output" in raw).toBe(false)

    // Through the runtime executor the same call succeeds and content is
    // normalized into text parts; no output schema means output is undefined.
    const result = await runtimeExecute(tools, "teamwork_route", input, target)
    expect(result.output).toBeUndefined()
    expect(Array.isArray(result.content)).toBe(true)
    const text = resultText(result)
    expect(typeof text).toBe("string")
    expect(text).toContain("Route:")
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
