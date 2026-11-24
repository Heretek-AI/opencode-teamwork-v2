import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { AGENTS_DIR, createProject } from "../harness/project"
import { loadHost } from "../harness/load"

test("A7 agents decode: every shipped agent is a config agent with id/name/description and no stray AD lines", async () => {
  const project = createProject("a7-agents")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const files = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"))
    expect(files.length).toBeGreaterThan(0)

    const agents = (await loaded.host.agent.list({ location: { directory: project.root } })).data as any[]
    for (const file of files) {
      const id = `team/${basename(file, ".md")}`
      const agent = agents.find((item) => item.id === id)
      expect(agent, `config agent ${id} was skipped`).toBeDefined()
      expect(agent.id).toBe(id)
      expect(agent.name).toBe(id)
      expect(typeof agent.description).toBe("string")
      expect(agent.description.length).toBeGreaterThan(0)

      const text = readFileSync(join(AGENTS_DIR, file), "utf8")
      const stray = text.split(/\r?\n/).filter((line) => line.trim() === "AD")
      expect(stray, `${file} still contains a stray AD line`).toEqual([])
    }
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
