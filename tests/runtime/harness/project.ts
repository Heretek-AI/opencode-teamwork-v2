// L1 harness: a hermetic project root for one host.
//
// Every path the host or the plugin can write is redirected under the temp
// root: HOME, the XDG roots (set once in the preload), OPENCODE_CONFIG_DIR,
// OPENCODE_DB and TEAMWORK_WORKTREES_DIR. The temp root is removed on exit.
//
// This file deliberately imports no @opencode module: those read some of these
// variables once, at module evaluation, so the preload must set them before the
// first import. `load.ts` imports the SDK dynamically for the same reason.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveTrustedExecutable } from "../../../plugins/opencode-teamwork/safe-fs.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Repository root (`tests/runtime/harness/project.ts` -> four levels up). */
export const REPO_ROOT = resolve(HERE, "../../..")
/** The vendored plugin directory, loaded both in memory and from disk. */
export const PLUGIN_DIR = join(REPO_ROOT, "plugins", "opencode-teamwork")
/** The agent markdown the installer ships. */
export const AGENTS_DIR = join(REPO_ROOT, "agents", "team")

const roots = new Set<string>()

export interface Project {
  readonly root: string
  readonly home: string
  readonly configDir: string
  readonly worktreesDir: string
  readonly dbPath: string
  readonly pluginDir: string
  /** Point process.env at this project, so every subsequent host read is hermetic. */
  activate: () => void
  /** Write `<configDir>/opencode.json`; `plugins` is the config's `plugins` array. */
  writeConfig: (plugins?: ReadonlyArray<string | { package: string; options?: Record<string, unknown> }>) => void
  cleanup: () => void
}

function makeDir(...parts: string[]) {
  const path = join(...parts)
  mkdirSync(path, { recursive: true })
  return path
}

function git(root: string, args: string[]) {
  const gitBin = resolveTrustedExecutable("git")
  if (!gitBin) throw new Error("git executable not found")
  execFileSync(gitBin, args, {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "L1 Harness",
      GIT_AUTHOR_EMAIL: "l1@example.invalid",
      GIT_COMMITTER_NAME: "L1 Harness",
      GIT_COMMITTER_EMAIL: "l1@example.invalid",
    },
  })
}

/**
 * Create the shared, process-wide environment. Called once from the preload so
 * the XDG roots are fixed before any @opencode module is evaluated.
 */
export function createBaseEnvironment(): string {
  const base = mkdtempSync(join(tmpdir(), "teamwork-l1-"))
  roots.add(base)
  const home = makeDir(base, "home")
  makeDir(base, "xdg-config")
  makeDir(base, "xdg-data")
  makeDir(base, "xdg-cache")
  makeDir(base, "xdg-state")
  const privateTmp = join(base, "tmp")
  mkdirSync(privateTmp, { recursive: true, mode: 0o700 })
  process.env.HOME = home
  process.env.OPENCODE_TEST_HOME = home
  process.env.XDG_CONFIG_HOME = join(base, "xdg-config")
  process.env.XDG_DATA_HOME = join(base, "xdg-data")
  process.env.XDG_CACHE_HOME = join(base, "xdg-cache")
  process.env.XDG_STATE_HOME = join(base, "xdg-state")
  process.env.TMPDIR = privateTmp // NOSONAR (S5443): private 0o700 mkdtempSync subdir, never shared /tmp
  process.env.TEAMWORK_L1_BASE = base
  process.env.OPENCODE_DB = ":memory:"
  // The plugin mints an HMAC key on first use; a fixed key keeps that path
  // deterministic and keeps the test independent of the host key ring.
  process.env.OPENCODE_TEAMWORK_HMAC_KEY ??= Buffer.alloc(32, 7).toString("base64url")
  return base
}

/** Create a temp project root with one git commit and a copied agent set. */
export function createProject(name = "project"): Project {
  const base = process.env.TEAMWORK_L1_BASE ?? createBaseEnvironment()
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-")
  const root = mkdtempSync(join(base, `${safe}-`))
  roots.add(root)

  const home = makeDir(root, "home")
  const configDir = makeDir(root, "config")
  makeDir(configDir, "agents", "team")
  const worktreesDir = makeDir(root, "worktrees")
  const dbPath = join(root, "opencode.db")
  const pluginDir = PLUGIN_DIR

  cpSync(AGENTS_DIR, join(configDir, "agents", "team"), { recursive: true })

  writeFileSync(join(root, "README.md"), "# L1 harness project\n\nOne commit, no model.\n")
  git(root, ["init", "-q"])
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "l1 harness initial commit"])

  const project: Project = {
    root,
    home,
    configDir,
    worktreesDir,
    dbPath,
    pluginDir,
    activate() {
      process.env.HOME = home
      process.env.OPENCODE_TEST_HOME = home
      process.env.OPENCODE_CONFIG_DIR = configDir
      process.env.OPENCODE_DB = dbPath
      process.env.TEAMWORK_WORKTREES_DIR = worktreesDir
    },
    writeConfig(plugins = []) {
      const config = {
        $schema: "https://opencode.ai/config.json",
        plugins,
      }
      writeFileSync(join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`)
    },
    cleanup() {
      roots.delete(root)
      rmSync(root, { recursive: true, force: true })
    },
  }
  project.writeConfig([])
  project.activate()
  return project
}

/**
 * Re-open a project created in another process, from its root alone. Used by
 * the L3 claim-race child, which shares the parent's temp project and file DB
 * but must create its own embedded host.
 */
export function openProject(root: string): Project {
  const home = join(root, "home")
  const configDir = join(root, "config")
  const worktreesDir = join(root, "worktrees")
  const dbPath = join(root, "opencode.db")
  return {
    root,
    home,
    configDir,
    worktreesDir,
    dbPath,
    pluginDir: PLUGIN_DIR,
    activate() {
      process.env.HOME = home
      process.env.OPENCODE_TEST_HOME = home
      process.env.OPENCODE_CONFIG_DIR = configDir
      process.env.OPENCODE_DB = dbPath
      process.env.TEAMWORK_WORKTREES_DIR = worktreesDir
    },
    writeConfig(plugins = []) {
      writeFileSync(join(configDir, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins }, null, 2)}\n`)
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Remove every temp root. Registered on process exit from the preload. */
export function cleanupProjects() {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
  roots.clear()
}

export function projectExists(project: Project, path: string) {
  return existsSync(join(project.root, path))
}
