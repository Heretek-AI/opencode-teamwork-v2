import { expect, test } from "bun:test"
import { createProject } from "../harness/project"
import { importTeamwork, loadHost } from "../harness/load"

test("A3 commands: the 7 commands are registered, substitute $ARGUMENTS, switch agent, then prompt", async () => {
  const project = createProject("a3-commands")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const module = await importTeamwork(project)
    const specs: any[] = module.COMMANDS
    // ctx.command.list() is the HTTP endpoint adapter: { location, data }.
    const registered = (await loaded.capture.listCommands()).data
    const registeredNames = new Set(registered.map((command: any) => command.name))

    expect(specs).toHaveLength(7)
    for (const spec of specs) {
      const command = registered.find((item: any) => item.name === spec.name)
      expect(command, `missing /${spec.name}`).toBeDefined()
      expect(command.description).toBe(spec.description)
      expect(command.description.length).toBeGreaterThan(0)
      expect(spec.agent).toMatch(/^team\/[a-z-]+$/)
    }

    // The agent binding is a closure on the registered command, so invocation is
    // the observable proof: each command must switch the session to its agent
    // and admit the template with $ARGUMENTS substituted.
    for (const spec of specs) {
      const session = await loaded.host.sessions.create({ location: { directory: project.root } })
      const args = `args for /${spec.name}`
      await loaded.host.sessions.command({ sessionID: session.id, name: spec.name, text: args })

      const after = await loaded.host.sessions.get({ sessionID: session.id })
      expect(after.agent, `/${spec.name} must run as ${spec.agent}`).toBe(spec.agent)

      const inbox = await loaded.host.sessions.inbox.list({ sessionID: session.id })
      const user = inbox.find((item: any) => item.type === "user")
      expect(user, `/${spec.name} admitted no prompt`).toBeDefined()
      expect(user.payload.text.startsWith(args)).toBe(true)
      expect(user.payload.text).not.toContain("$ARGUMENTS")

      // No model is configured. Stop the (already model-less) wake so it never
      // outlives the test.
      await loaded.host.sessions.interrupt({ sessionID: session.id })
    }
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
