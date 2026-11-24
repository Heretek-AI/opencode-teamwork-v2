import { expect, test } from "bun:test"
import { createProject } from "../harness/project"
import { loadHost } from "../harness/load"

for (const mode of ["memory", "directory"] as const) {
  test(`A1 load (${mode}): plugin id, setup completes, state active, host 2.4.x`, async () => {
    const project = createProject(`a1-${mode}`)
    const loaded = await loadHost(project, { mode })
    try {
      const plugins = await loaded.pluginInfo()
      const plugin = plugins.find((item: any) => item.id === "opencode-teamwork")
      expect(plugin).toBeDefined()
      expect(plugin.state).toEqual({ status: "active" })
      expect(plugin.source.type).toBe(mode === "memory" ? "sdk" : "local")

      // ctx.app.version is recorded from the host, then checked against the
      // installed @opencode/core version (loadHost asserts both).
      expect(loaded.capture.hostVersion).toMatch(/^2\.4\.\d+$/)
      expect(loaded.capture.hostVersion).toBe(loaded.versions.core)
      expect(loaded.capture.app.name).toBe("opencode-l1")
      expect(loaded.capture.app.channel).toBe("unknown")
    } finally {
      await loaded.close()
      project.cleanup()
    }
  })
}
