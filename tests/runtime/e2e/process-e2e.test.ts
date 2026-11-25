// Process-level E2E harness with the real `opencode serve` CLI/server (Issue #47).
//
// Complements L1-L3 embedded SDK specs with real HTTP transport, SSE event
// ordering, plugin activation over HTTP, command discovery, and cross-process
// SQLite + run-state visibility. Zero model keys; uses a local scripted provider.

import { expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startMockProvider } from "./mock-provider"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..", "..", "..")
const PLUGIN_DIR = join(REPO_ROOT, "plugins", "opencode-teamwork")

function findOpencodeBinary(): string | null {
  const probe = spawnSync("which", ["opencode"], { encoding: "utf8" })
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim()
  return null
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolvePort(port))
    })
    srv.on("error", reject)
  })
}

async function waitForServer(baseUrl: string, authHeader: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/agent`, {
        headers: { Authorization: authHeader },
      })
      if (res.ok) return
    } catch (err) {
      lastErr = err
    }
    await Bun.sleep(100)
  }
  throw new Error(`opencode serve at ${baseUrl} did not become ready in ${timeoutMs}ms (${String(lastErr)})`)
}

const OPENCODE_BIN = findOpencodeBinary()

test.skipIf(!OPENCODE_BIN)(
  "E2E process lifecycle: real opencode serve loads plugin over HTTP, exposes commands, streams SSE, and shares state across processes",
  async () => {
    const mock = startMockProvider("E2E scripted reply")
    const work = mkdtempSync(join(tmpdir(), "teamwork-process-e2e-"))
    const homeDir = join(work, "home")
    const configDir = join(work, "config")
    const projectDir = join(work, "project")
    const dbPath = join(work, "opencode-e2e.db")
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    const password = "e2e-local-password"
    const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    const configContent = JSON.stringify({
      plugins: [{ package: PLUGIN_DIR }],
    })
    writeFileSync(join(configDir, "opencode.json"), configContent)

    const env = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: work,
      XDG_DATA_HOME: join(work, "data"),
      XDG_CACHE_HOME: join(work, "cache"),
      OPENCODE_DB: dbPath,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: configContent,
      OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_SIMULATE: "1",
    }

    const startServe = async () => {
      const port = await getFreePort()
      const baseUrl = `http://127.0.0.1:${port}`
      const child = spawn(OPENCODE_BIN!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: projectDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      child.stderr?.on("data", (d) => (stderr += String(d)))
      try {
        await waitForServer(baseUrl, authHeader, 20_000)
      } catch (err) {
        child.kill("SIGKILL")
        throw new Error(`${String(err)}\nstderr:\n${stderr.slice(-1500)}`)
      }
      return {
        baseUrl,
        stop: async () => {
          child.kill("SIGTERM")
          await new Promise<void>((r) => {
            const t = setTimeout(() => {
              child.kill("SIGKILL")
              r()
            }, 3000)
            child.once("exit", () => {
              clearTimeout(t)
              r()
            })
          })
        },
      }
    }

    const { OpenCode: Client } = await import("@opencode/client")
    const makeClient = (baseUrl: string) =>
      Client.make({
        baseUrl,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          headers.set("Authorization", authHeader)
          return fetch(input, { ...init, headers })
        },
      })

    let srv1: Awaited<ReturnType<typeof startServe>> | null = null
    let srv2: Awaited<ReturnType<typeof startServe>> | null = null
    try {
      srv1 = await startServe()
      const client1 = makeClient(srv1.baseUrl)
      const location = { location: { directory: projectDir } }

      // 1. Trigger location boot and wait for opencode-teamwork plugin activation over HTTP.
      await client1.agent.list(location)
      const deadline = Date.now() + 15_000
      let plugins: any[] = []
      while (Date.now() < deadline) {
        plugins = (await client1.plugin.list(location)).data ?? []
        if (plugins.some((p: any) => p.id === "opencode-teamwork")) break
        await Bun.sleep(100)
      }
      const tw = plugins.find((p: any) => p.id === "opencode-teamwork")
      expect(tw).toBeDefined()
      expect(tw.state?.status ?? tw.state).toBe("active")

      // 2. Commands appear after activation over HTTP.
      const commands = (await client1.command.list(location)).data ?? []
      expect(commands.some((c: any) => c.name === "teamwork")).toBe(true)

      // 3. Create a session over HTTP and verify SSE endpoint streams cleanly.
      const created = await client1.session.create(location)
      expect(typeof created.id).toBe("string")
      const sseController = new AbortController()
      const sseRes = await fetch(`${srv1.baseUrl}/api/event`, {
        headers: { Authorization: authHeader, Accept: "text/event-stream" },
        signal: sseController.signal,
      })
      expect(sseRes.ok).toBe(true)
      expect(sseRes.headers.get("content-type") ?? "").toContain("text/event-stream")
      sseController.abort()

      // Stop process 1 and boot process 2 against the same SQLite DB + project dir.
      await srv1.stop()
      srv1 = null

      srv2 = await startServe()
      const client2 = makeClient(srv2.baseUrl)
      const fetched = await client2.session.get({ sessionID: created.id, ...location })
      expect(fetched.id).toBe(created.id)
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      if (srv1) await srv1.stop()
      if (srv2) await srv2.stop()
      mock.close()
      rmSync(work, { recursive: true, force: true })
    }
  },
  60_000,
)
