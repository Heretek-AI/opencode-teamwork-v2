// L2 run helpers: real sessions, real agent selection, and direct tool calls.
//
// Every session here is created (and, for children, parented) through the
// embedded host's own Session service. Tool calls reach the tool object the
// real plugin registered with the host (`Tool.Service.list()`), executed with
// the host's context shape.
//
// Result shape note (OBSERVED — OpenCode 2.4.1): no Teamwork tool declares an
// output schema, and the host's snapshot executor keeps only `content`
// (runtime.ts:74-83). The plugin's structured fields (`status`, `fence`,
// `token`, ...) are therefore invisible after normalization. L1 A8 already
// proves the raw-vs-normalized contract; L2 uses the registered executor
// (`rawExecute`) so its assertions can read the structured result the plugin
// actually produced, while a handful of specs still cross the snapshot
// executor to prove the runtime boundary. Both paths execute the same
// registered tool with the same host context.

import type { LoadedHost } from "./load"
import { openLocationTools, rawExecute, runtimeExecute, resultText, toolById } from "./tools"

export interface RunSession {
  readonly id: string
  readonly agent: string
  readonly parentID: string | null
  readonly info: any
}

export interface CreateSessionOptions {
  readonly agent: string
  readonly parent?: RunSession
  readonly title?: string
}

export interface ToolResult {
  readonly name: string
  readonly status?: string
  readonly content: string
  readonly output?: unknown
  readonly error?: string
  /** Every other structured field the plugin returned (fence, token, report, ...). */
  readonly [field: string]: unknown
}

const locationTools = new WeakMap<object, Promise<any>>()

/** The project location's registered tool list + snapshot, cached per host. */
export function toolsFor(loaded: LoadedHost): Promise<any> {
  let cached = locationTools.get(loaded as object)
  if (!cached) {
    cached = openLocationTools(loaded, loaded.project.root)
    locationTools.set(loaded as object, cached)
  }
  return cached
}

/** `plan` -> `teamwork_plan`; an already-effective id is kept as-is. */
export function effectiveToolName(name: string): string {
  const raw = String(name ?? "").trim()
  return raw.startsWith("teamwork_") ? raw : `teamwork_${raw}`
}

export async function createSession(loaded: LoadedHost, options: CreateSessionOptions): Promise<RunSession> {
  const parent = options.parent
  const created = parent
    ? await loaded.host.sessions.create({ parentID: parent.id, agent: options.agent, ...(options.title ? { title: options.title } : {}) })
    : await loaded.host.sessions.create({
        location: { directory: loaded.project.root },
        agent: options.agent,
        ...(options.title ? { title: options.title } : {}),
      })
  return {
    id: created.id,
    agent: options.agent,
    parentID: created.parentID ?? parent?.id ?? null,
    info: created,
  }
}

/** Switch the session's agent through the host API, as a command would. */
export async function selectAgent(loaded: LoadedHost, session: RunSession, agent: string): Promise<RunSession> {
  await loaded.host.sessions.switchAgent({ sessionID: session.id, agent })
  const info = await loaded.host.sessions.get({ sessionID: session.id })
  return { id: session.id, agent, parentID: info?.parentID ?? session.parentID, info }
}

function normalize(name: string, raw: any): ToolResult {
  const content =
    typeof raw?.content === "string" ? raw.content : Array.isArray(raw?.content) ? resultText(raw) : String(raw?.content ?? "")
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  return {
    ...source,
    name,
    ...(typeof source.status === "string" ? { status: source.status } : {}),
    content,
  }
}

function failure(name: string, error: unknown): ToolResult {
  return {
    name,
    status: "ERROR",
    content: "",
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  }
}

/**
 * Execute one registered tool by effective name with the calling session's
 * trusted identity. Returns the plugin's structured result (status/content/...).
 */
export async function execute(
  loaded: LoadedHost,
  session: RunSession,
  name: string,
  input: Record<string, unknown> = {},
): Promise<ToolResult> {
  const effective = effectiveToolName(name)
  try {
    const tools = await toolsFor(loaded)
    const tool = toolById(tools, effective)
    const raw = await rawExecute(tool, input, { sessionID: session.id, agent: session.agent })
    return normalize(effective, raw)
  } catch (error) {
    return failure(effective, error)
  }
}

/**
 * Execute through the host's snapshot executor (JSON-Schema decode, hooks,
 * result normalization). Use when the spec is about the runtime boundary.
 */
export async function executeViaRuntime(
  loaded: LoadedHost,
  session: RunSession,
  name: string,
  input: Record<string, unknown> = {},
): Promise<ToolResult> {
  const effective = effectiveToolName(name)
  try {
    const tools = await toolsFor(loaded)
    const result = await runtimeExecute(tools, effective, input, { sessionID: session.id, agent: session.agent })
    return {
      name: effective,
      content: resultText(result),
      ...(result?.output !== undefined ? { output: result.output } : {}),
    }
  } catch (error) {
    return failure(effective, error)
  }
}
