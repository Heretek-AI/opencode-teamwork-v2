// Two supported plugin load paths, both against the real 2.4.1 host.
//
//   memory     the plugin object passed to the host's `plugins` list
//   directory  opencode.json `plugins: [{ package: "<abs>/plugins/opencode-teamwork" }]`
//
// OBSERVED — internal: the public `@opencode/sdk` Promise `create()` builds the
// embedded host and then discards it, returning only an HTTP client. L1 needs
// the host's `runtime` to reach the real Tool service (and therefore
// Tool.Snapshot — the only executor that runs input validation). We therefore
// build the same host with its documented internal entrypoint
// `@opencode/sdk/dist/internal/host` (docs/OPENCODE-COMPATIBILITY.md §5.2 cites
// `packages/sdk/src/internal/host.ts`) and adapt plugins with
// `@opencode/core/plugin/promise`, exactly as `sdk/src/promise.ts` does.

import assert from "node:assert"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Project } from "./project"

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(HERE, "..")
const INTERNAL_HOST = join(RUNTIME_DIR, "node_modules", "@opencode", "sdk", "dist", "internal", "host.js")

export type LoadMode = "memory" | "directory"

export interface Versions {
  readonly core: string
  readonly sdk: string
  readonly plugin: string
  readonly ai: string
  readonly effect: string
}

export interface Capture {
  app: { name: string; version: string; channel: string }
  hostVersion: string
  listCommands: () => Promise<any>
  assertPermission: (input: any) => Promise<void>
  storage: any
}

export interface LoadedHost {
  readonly mode: LoadMode
  readonly project: Project
  /** HTTP client plus `runtime` (the embedded host's ManagedRuntime). */
  readonly host: any
  readonly capture: Capture
  readonly versions: Versions
  pluginInfo: () => Promise<any[]>
  close: () => Promise<void>
}

function readPackageVersion(name: string) {
  const path = join(RUNTIME_DIR, "node_modules", name, "package.json")
  return JSON.parse(readFileSync(path, "utf8")).version as string
}

/** The exact versions under test, read from the installed tree. */
export function installedVersions(): Versions {
  return {
    core: readPackageVersion("@opencode/core"),
    sdk: readPackageVersion("@opencode/sdk"),
    plugin: readPackageVersion("@opencode/plugin"),
    ai: readPackageVersion("@opencode/ai"),
    effect: readPackageVersion("effect"),
  }
}

export const teamPluginUrl = (project: Project) => pathToFileURL(join(project.pluginDir, "index.ts")).href

/** Import the plugin module directly (only for static export checks). */
export async function importTeamwork(project: Project) {
  return import(teamPluginUrl(project))
}

const probePlugin = (capture: Capture) => ({
  id: "l1-probe",
  async setup(ctx: any) {
    capture.app = ctx.app
    capture.hostVersion = ctx.app.version
    capture.listCommands = () => ctx.command.list()
    capture.assertPermission = (input: any) => ctx.permission.assert(input)
    capture.storage = ctx.storage
  },
})

export async function loadHost(
  project: Project,
  options: { mode?: LoadMode; extraPlugins?: any[]; includeTeamwork?: boolean } = {},
): Promise<LoadedHost> {
  const mode = options.mode ?? "memory"
  const includeTeamwork = options.includeTeamwork ?? true
  const versions = installedVersions()
  project.activate()

  // The directory path is the on-disk `plugins` entry; the memory path passes
  // the object to the host. Never both, or the host reports a duplicate id.
  if (mode === "directory") project.writeConfig([{ package: project.pluginDir }])
  else project.writeConfig([])

  const capture = {} as Capture
  const promisePlugins =
    mode === "memory" && includeTeamwork
      ? [(await importTeamwork(project)).default, probePlugin(capture)]
      : [probePlugin(capture)]
  promisePlugins.push(...(options.extraPlugins ?? []))

  const [{ EmbeddedHost }, { PluginPromise }, { OpenCode: Client }, { Effect }] = await Promise.all([
    import(pathToFileURL(INTERNAL_HOST).href),
    import("@opencode/core/plugin/promise"),
    import("@opencode/client"),
    import("effect"),
  ])

  const embedded = await Effect.runPromise(
    EmbeddedHost.create({
      // In the embedded host `config.directory` is the global *config* directory
      // (packages/server/src/routes.ts replaces Global.config with it). Sessions
      // still pin their own location to project.root below.
      database: { path: ":memory:" },
      app: { name: "opencode-l1", version: versions.core },
      config: { directory: project.configDir, project: false, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
      plugins: promisePlugins.map((plugin) => PluginPromise.fromPromise(plugin)),
    }),
  )

  const client = Client.make({ baseUrl: "http://opencode.local", fetch: embedded.fetch })
  const host: any = Object.assign(client, {
    sessions: client.session,
    events: client.event,
    close: embedded.close,
    runtime: embedded.runtime,
  })

  // Plugins and their setups are location-scoped: the location graph boots on
  // the first request and the supervisor activates plugins in a forked fiber.
  // Boot the location, then wait for every expected plugin to appear in the
  // inventory (entries exist only after activation, including failed setups).
  const location = { location: { directory: project.root } }
  await host.agent.list(location)
  const expectedIds = [
    ...(mode === "directory" ? ["opencode-teamwork"] : []),
    ...promisePlugins.map((plugin) => plugin.id),
  ]
  const deadline = Date.now() + 15_000
  for (;;) {
    const info = (await host.plugin.list(location)).data
    const ids = new Set(info.map((plugin: any) => plugin.id))
    if (expectedIds.every((id) => ids.has(id))) break
    if (Date.now() > deadline) {
      throw new Error(`plugins did not activate in time: expected [${expectedIds.join(", ")}], got [${[...ids].join(", ")}]`)
    }
    await Bun.sleep(10)
  }

  assert.match(String(capture.hostVersion), /^2\.4\./, `host version ${capture.hostVersion} is not 2.4.x`)
  assert.strictEqual(capture.hostVersion, versions.core, "ctx.app.version must be the installed @opencode/core version")

  console.log(
    `[l1] @opencode/core=${versions.core} sdk=${versions.sdk} plugin=${versions.plugin} ai=${versions.ai} ` +
      `effect=${versions.effect} host=${capture.hostVersion} mode=${mode}`,
  )

  return {
    mode,
    project,
    host,
    capture,
    versions,
    pluginInfo: async () => (await host.plugin.list(location)).data,
    close: async () => {
      await host.close()
    },
  }
}
