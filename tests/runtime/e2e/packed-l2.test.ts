// T4 L2 smoke: the packed npm artifact, loaded as a directory plugin, plans a
// run through the real host.
//
// The spec registers only when TEAMWORK_PACKED_PACKAGE points at an unpacked
// install of the tarball (scripts/test-packed-tarball.mjs). A normal
// `bun test` run therefore adds no test and, importantly, no extra skip.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadHost } from "../harness/load"
import { createProject } from "../harness/project"
import { createSession, execute } from "../harness/run"

const PACKED = process.env.TEAMWORK_PACKED_PACKAGE?.trim()

if (PACKED) {
  test("T4 packed L2: the installed tarball plans a run through the real host", async () => {
    const project = createProject("packed-l2")
    const loaded = await loadHost(project, { mode: "directory" })
    try {
      const config = JSON.parse(readFileSync(join(project.configDir, "opencode.json"), "utf8"))
      expect(config.plugins).toEqual([{ package: PACKED }])

      const root = await createSession(loaded, { agent: "team/sentinel" })
      const runId = "20261125-000000-packed"
      const result = await execute(loaded, root, "plan", {
        sessionId: runId,
        topology: "iterative-coding",
        request: "Ship the packed-tarball plan smoke with tests.",
        tasks: [{ id: "T1" }],
        skipInterview: true,
      })
      expect(result.content.startsWith("Planned ")).toBe(true)
      console.log(`[packed-l2] planned ${runId} from the installed tarball`)
      expect(result.content).toContain(runId)
    } finally {
      await loaded.close()
      project.cleanup()
    }
  })
}
