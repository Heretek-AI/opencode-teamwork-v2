import { expect, test } from "bun:test"
import { createProject } from "../harness/project"
import { loadHost } from "../harness/load"

test("A5 permission hook: verifier edit denied, victory-auditor shell allowed/edit denied, other agents untouched", async () => {
  const project = createProject("a5-permission")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const session = await loaded.host.sessions.create({ location: { directory: project.root } })
    // Start from an explicit allow so the outcome is the plugin hook's, not the
    // agent markdown's own deny rule.
    await loaded.host.sessions.update({
      sessionID: session.id,
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })

    const assert = loaded.capture.assertPermission
    const act = (agent: string, action: string, resources: string[]) =>
      assert({ sessionID: session.id, agent, action, resources })

    await expect(act("team/verifier", "edit", ["src/index.ts"])).rejects.toThrow(
      /team\/verifier is restricted during a Teamwork run \(edit denied\)/,
    )

    await expect(act("team/victory-auditor", "shell", ["npm test"])).resolves.toBeUndefined()
    await expect(act("team/victory-auditor", "edit", ["src/index.ts"])).rejects.toThrow(
      /team\/victory-auditor is restricted during a Teamwork run \(edit denied\)/,
    )

    // An agent outside the read-only table is untouched by the hook.
    await expect(act("team/worker", "edit", ["src/index.ts"])).resolves.toBeUndefined()
    await expect(act("build", "edit", ["src/index.ts"])).resolves.toBeUndefined()
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
