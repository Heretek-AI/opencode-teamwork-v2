import { expect, test } from "bun:test"
import { createProject } from "../harness/project"
import { importTeamwork, loadHost } from "../harness/load"

test("A6 storage namespacing: two plugin instances with different ids keep separate JSON KV spaces", async () => {
  const project = createProject("a6-storage")
  const module = await importTeamwork(project)

  // Two real instances of the plugin. Different plugin ids give the host two
  // KV namespaces (`plugin:<hex-id>:`), even though both setups are identical.
  const stores: Record<string, any> = {}
  const instance = (id: string) => ({
    id,
    async setup(ctx: any) {
      stores[id] = ctx.storage
      return module.default.setup(ctx)
    },
  })

  const loaded = await loadHost(project, {
    mode: "memory",
    includeTeamwork: false,
    extraPlugins: [instance("teamwork-a"), instance("teamwork-b")],
  })
  try {
    const a = stores["teamwork-a"]
    const b = stores["teamwork-b"]
    expect(a).toBeDefined()
    expect(b).toBeDefined()

    const value = { n: 1, s: "round-trip", nested: { ok: true }, list: [1, null, "x"] }
    await a.set("l1/roundtrip", value)
    await b.set("l1/roundtrip", { n: 2, s: "other" })

    expect(await a.get("l1/roundtrip")).toEqual(value)
    expect(await b.get("l1/roundtrip")).toEqual({ n: 2, s: "other" })

    await a.set("l1/a-only", "A")
    expect(await a.get("l1/a-only")).toBe("A")
    expect(await b.get("l1/a-only")).toBeUndefined()

    const scanned = await a.scan({ prefix: "l1/" })
    expect(scanned.entries.map((entry: any) => entry.key).sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(["l1/a-only", "l1/roundtrip"])
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
