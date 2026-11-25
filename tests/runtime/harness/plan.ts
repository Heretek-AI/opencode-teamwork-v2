// L2 plan fixtures and run-artifact readers.
//
// Every helper here works inside the fixture project handed out by `withHost`:
// its own temp git repository, its own temp HOME/XDG/config, its own
// `TEAMWORK_WORKTREES_DIR`, and the host's real KV storage. Nothing reads or
// writes outside that project.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { resolveTrustedExecutable } from "../../../plugins/opencode-teamwork/safe-fs.mjs"
import type { LoadedHost } from "./load"
import { importTeamwork, loadHost } from "./load"
import { createProject, type Project } from "./project"
import { createSession, execute, type RunSession, type ToolResult } from "./run"

const DEFAULT_RUN_ID = "20261124-000000-l2"
const DEFAULT_REQUEST = "Ship a deterministic two-task change with tests."

export interface PlanOptions {
  readonly sessionId?: string
  readonly topology?: string
  /** `null` omits the request (a re-plan must omit it: the file is write-once). */
  readonly request?: string | null
  readonly tasks?: Array<Record<string, unknown>>
  readonly skipInterview?: boolean
  readonly requireSpec?: boolean
  readonly requirements?: Array<{ id: string; text: string }>
  readonly victoryAudit?: string
  readonly victorySkipReason?: string
  readonly verification?: string
  readonly requireHandoffs?: string
  readonly requiredProvenance?: string
  readonly trustLevel?: string
  readonly integrityMode?: string
  readonly allowUnsignedLegacy?: boolean
  readonly [key: string]: unknown
}

export interface HostFixture {
  readonly project: Project
  readonly loaded: LoadedHost
  readonly root: RunSession
  /** Create a child session under `parent` (default: the run root). */
  child: (agent: string, parent?: RunSession) => Promise<RunSession>
}

export interface RunFixture extends HostFixture {
  readonly runId: string
  readonly runDir: string
  readonly plan: ToolResult
  readonly worker: RunSession
  readonly verifier: RunSession
  readonly falsifier: RunSession
  readonly auditor: RunSession
  readonly victoryAuditor: RunSession
}

/** A project + host + root Sentinel, cleaned up on exit. */
export async function withHost<T>(label: string, fn: (fixture: HostFixture) => Promise<T>): Promise<T> {
  const project = createProject(label)
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const root = await createSession(loaded, { agent: "team/sentinel", title: `${label} sentinel` })
    const child = (agent: string, parent: RunSession = root) => createSession(loaded, { agent, parent })
    return await fn({ project, loaded, root, child })
  } finally {
    await loaded.close()
    project.cleanup()
  }
}

/**
 * The same fixture, but the teamwork plugin is loaded through a thin wrapper
 * that keeps `ctx.storage` — the plugin's own KV namespace, not the probe
 * plugin's. Used by the storage-key-ring spec.
 */
export async function withStorageHost<T>(
  label: string,
  fn: (fixture: HostFixture & { storage: any }) => Promise<T>,
): Promise<T> {
  const project = createProject(label)
  const module = await importTeamwork(project)
  let storage: any
  const wrapper = {
    id: "opencode-teamwork",
    async setup(ctx: any) {
      storage = ctx.storage
      return module.default.setup(ctx)
    },
  }
  const loaded = await loadHost(project, { mode: "memory", includeTeamwork: false, extraPlugins: [wrapper] })
  try {
    const root = await createSession(loaded, { agent: "team/sentinel", title: `${label} sentinel` })
    const child = (agent: string, parent: RunSession = root) => createSession(loaded, { agent, parent })
    return await fn({ project, loaded, root, child, storage })
  } finally {
    await loaded.close()
    project.cleanup()
  }
}

/** The minimal two-task plan fixture. Every field can be overridden. */
export function planInput(overrides: PlanOptions = {}): Record<string, unknown> {
  const {
    sessionId = DEFAULT_RUN_ID,
    topology = "iterative-coding",
    request = DEFAULT_REQUEST,
    tasks = [{ id: "T1" }, { id: "T2" }],
    skipInterview = true,
    ...rest
  } = overrides
  return {
    sessionId,
    topology,
    ...(request === null ? {} : { request }),
    tasks,
    skipInterview,
    ...rest,
  }
}

export async function planRun(
  loaded: LoadedHost,
  root: RunSession,
  overrides: PlanOptions = {},
): Promise<ToolResult> {
  return execute(loaded, root, "plan", planInput(overrides))
}

/** A planned run plus one child session per evidence role. */
export async function withRun<T>(
  label: string,
  options: PlanOptions | undefined,
  fn: (fixture: RunFixture) => Promise<T>,
): Promise<T> {
  return withHost(label, async (base) => {
    const fixture = await buildRunFixture(base, label, options)
    return fn(fixture)
  })
}

/**
 * The same planned fixture, but with the teamwork plugin's own `ctx.storage`
 * captured. Used when a spec must write a signed fixture artifact and therefore
 * needs the same digest-index namespace the plugin verifies against.
 */
export async function withStorageRun<T>(
  label: string,
  options: PlanOptions | undefined,
  fn: (fixture: RunFixture & { storage: any }) => Promise<T>,
): Promise<T> {
  return withStorageHost(label, async (base) => {
    const fixture = await buildRunFixture(base, label, options)
    return fn({ ...fixture, storage: base.storage })
  })
}

async function buildRunFixture(base: HostFixture, label: string, options?: PlanOptions): Promise<RunFixture> {
  const overrides = { ...(options ?? {}) }
  // A spec fixture is written before the plan, into the run directory the
  // plan will use. Tests that need a refusal pass `expectRefusal` and do not
  // use this path.
  if (typeof overrides.spec === "string") {
    writeSpec(base.project, String(overrides.sessionId ?? DEFAULT_RUN_ID), overrides.spec)
    delete overrides.spec
  }
  const plan = await planRun(base.loaded, base.root, overrides)
  if (!plan.content.startsWith("Planned ")) {
    throw new Error(`withRun(${label}): plan did not succeed: ${plan.content || plan.error}`)
  }
  const runId = String(plan.content.match(/SESSION_ID: (\S+)/)?.[1] ?? overrides.sessionId ?? DEFAULT_RUN_ID)
  return {
    ...base,
    runId,
    runDir: runDir(base.project, runId),
    plan,
    worker: await base.child("team/worker"),
    verifier: await base.child("team/verifier"),
    falsifier: await base.child("team/falsifier"),
    auditor: await base.child("team/security-auditor"),
    victoryAuditor: await base.child("team/victory-auditor"),
  }
}

// ---------------------------------------------------------------------------
// Run artifacts
// ---------------------------------------------------------------------------

export function runDir(project: Project, runId = DEFAULT_RUN_ID): string {
  return join(project.root, ".opencode", "teamwork", runId)
}

export function teamworkRoot(project: Project): string {
  return join(project.root, ".opencode", "teamwork")
}

export function runFile(project: Project, runId: string, relativePath: string): string {
  return join(runDir(project, runId), relativePath)
}

function readJson<T = any>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

export function readRunJson<T = any>(project: Project, runId: string, relativePath: string): T | undefined {
  return readJson<T>(runFile(project, runId, relativePath))
}

export function readPlan(project: Project, runId: string): any {
  return readRunJson(project, runId, "plan.dag.json")
}

export function readState(project: Project, runId: string): any {
  return readRunJson(project, runId, "state.json")
}

export type RunManifest = Record<string, any> & { _auth?: Record<string, any> }
export function readManifest(project: Project, runId: string): RunManifest | undefined {
  return readRunJson<RunManifest>(project, runId, "run.manifest.json")
}

export function readVictory(project: Project, runId: string): any {
  return readRunJson(project, runId, "verify/victory.json")
}

/** Parse `<run>/events.jsonl`; malformed tail lines are skipped. */
export function readEvents(project: Project, runId: string): any[] {
  let text = ""
  try {
    text = readFileSync(runFile(project, runId, "events.jsonl"), "utf8")
  } catch {
    return []
  }
  const out: any[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

export function writeSpec(project: Project, runId: string, text: string): string {
  const dir = runDir(project, runId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "prompt_draft.md")
  writeFileSync(file, text, "utf8")
  return file
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Sorted relative path -> sha256 for every regular file under `dir`. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const path = join(current, entry)
      let fd: number | null = null
      let isDir = false
      try {
        fd = openSync(path, fsConstants.O_RDONLY)
        const st = fstatSync(fd)
        if (st.isDirectory()) {
          isDir = true
        } else if (st.isFile()) {
          out[relative(dir, path).split("\\").join("/")] = sha256(readFileSync(fd))
        }
      } catch (err: any) {
        if (err?.code === "EISDIR") isDir = true
        else continue
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd)
          } catch {}
        }
      }
      if (isDir) walk(path)
    }
  }
  walk(dir)
  return out
}

/** Assertion-friendly difference between two snapshots. */
export function treeDiff(before: Record<string, string>, after: Record<string, string>): {
  added: string[]
  removed: string[]
  changed: string[]
} {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const added = Object.keys(after).filter((key) => !(key in before)).sort(cmp)
  const removed = Object.keys(before).filter((key) => !(key in after)).sort(cmp)
  const changed = Object.keys(before)
    .filter((key) => key in after && before[key] !== after[key])
    .sort(cmp)
  return { added, removed, changed }
}

// ---------------------------------------------------------------------------
// Real git fixtures
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const gitBin = resolveTrustedExecutable("git")
  if (!gitBin) throw new Error("git executable not found")
  return execFileSync(gitBin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "L2 Harness",
      GIT_AUTHOR_EMAIL: "l2@example.invalid",
      GIT_COMMITTER_NAME: "L2 Harness",
      GIT_COMMITTER_EMAIL: "l2@example.invalid",
    },
  }).trim()
}

export function gitHead(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"])
}

export function gitCommitCount(cwd: string): number {
  return Number(git(cwd, ["rev-list", "--count", "HEAD"]))
}

const baseBranch = (runId: string) => `teamwork/base-${runId}`
const taskBranch = (runId: string, taskId: string) => `teamwork/${runId}-${taskId}`

/**
 * Create the run's base branch and one clean worktree for `taskId` at the
 * project's `TEAMWORK_WORKTREES_DIR/<runId>/<taskId>` (the location the engine
 * discovers on its own).
 */
export function createTaskWorktree(project: Project, runId: string, taskId: string): string {
  const base = baseBranch(runId)
  try {
    git(project.root, ["rev-parse", "--verify", base])
  } catch {
    git(project.root, ["branch", base, "HEAD"])
  }
  const path = join(project.worktreesDir, runId, taskId)
  mkdirSync(dirname(path), { recursive: true })
  git(project.root, ["worktree", "add", "-q", path, "-b", taskBranch(runId, taskId), base])
  return path
}

/** Commit one file in a worktree; returns the new head. */
export function commitInWorktree(
  worktree: string,
  relativePath: string,
  content: string,
  message = "L2 fixture commit",
): string {
  const file = join(worktree, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, "utf8")
  git(worktree, ["add", "--", relativePath])
  git(worktree, ["commit", "-qm", message])
  return gitHead(worktree)
}
