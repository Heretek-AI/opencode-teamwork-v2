// Tool access for L1, using the host's real location-scoped Tool service.
//
// Listing: `Tool.Service.list()` for the project Location, reached through the
// embedded host's runtime and `LocationServiceMap`. The public HTTP client has
// no tool-catalog endpoint. OBSERVED — internal: this reaches the same Tool
// service the request path uses, instead of a re-implementation.
//
// Execution: `Tool.Service.snapshot().execute(...)`, the host's own executor:
// it decodes the JSON Schema, runs execute.before/after hooks, enforces the
// output-schema rule, and normalizes content. This is the path A4/A8 assert
// against.
//
// Raw execution uses the registered tool's `execute` effect directly, only to
// observe the plugin's return object before runtime normalization.

import { Effect } from "effect"

export interface ToolTarget {
  readonly sessionID: string
  readonly agent?: string
  readonly messageID?: string
  readonly id?: string
  /** Propagated to `Tool.Context.signal` so abort specs can cancel mid-run. */
  readonly signal?: AbortSignal
  /** The host's cancellation Effect; the Promise adapter turns it into `signal`. */
  readonly cancel?: unknown
}

const context = (target: ToolTarget) => ({
  sessionID: target.sessionID,
  agent: target.agent ?? "build",
  messageID: target.messageID ?? "msg_l1_harness",
  id: target.id ?? "call_l1_harness",
  ...(target.signal ? { signal: target.signal } : {}),
  ...(target.cancel !== undefined ? { cancel: target.cancel } : {}),
})

export interface LocationTools {
  readonly list: any[]
  readonly snapshot: any
}

/** The exact Tool service for `directory`, plus its snapshot executor. */
export async function openLocationTools(loaded: any, directory: string): Promise<LocationTools> {
  const [{ LocationServiceMap }, { Tool }, { Location }, { AbsolutePath }] = await Promise.all([
    import("@opencode/core/location-service-map"),
    import("@opencode/core/tool"),
    import("@opencode/core/location"),
    import("@opencode/core/schema"),
  ])
  return loaded.host.runtime.runPromise(
    Effect.gen(function* () {
      const map = yield* LocationServiceMap.Service
      const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      return yield* Effect.gen(function* () {
        const tools = yield* Tool.Service
        return { list: yield* tools.list(), snapshot: yield* tools.snapshot() }
      }).pipe(Effect.provide(map.get(ref)))
    }),
  )
}

export function toolById(tools: LocationTools, id: string) {
  const tool = tools.list.find((item: any) => item.id === id)
  if (!tool) throw new Error(`tool ${id} is not registered`)
  return tool
}

/** Call a tool exactly as the host's snapshot executor would (runtime validation included). */
export async function runtimeExecute(
  tools: LocationTools,
  id: string,
  input: unknown,
  target: ToolTarget,
): Promise<any> {
  return Effect.runPromise(
    tools.snapshot.execute({
      ...context(target),
      call: { type: "tool-call", id: target.id ?? "call_l1_harness", name: id, input },
    }),
  )
}

/** Call the registered executor directly; returns the plugin's raw result object. */
export async function rawExecute(tool: any, input: unknown, target: ToolTarget): Promise<any> {
  return Effect.runPromise(
    tool.execute(input, {
      ...context(target),
      progress: () => Effect.void,
    }),
  )
}

/** Concatenated text parts of a runtime-normalized result. */
export function resultText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .map((part: any) => (part && part.type === "text" ? String(part.text ?? "") : ""))
    .join("")
}
