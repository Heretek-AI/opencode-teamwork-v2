// Shared test shim for the engine's tool registrations.
//
// OpenCode computes the name the model sees from the tool's `options.namespace`
// (`packages/core/src/tool/runtime.ts` effectiveName):
//
//   options.namespace === undefined
//     ? normalized(name)
//     : `${namespace.replaceAll(".", "_")}_${normalized(name)}`
//
// where normalized() replaces every character outside [a-zA-Z0-9_-] with "_".
// Tests must key registrations by that effective name, never by the bare
// `name` field, or a missing `options.namespace` would go unnoticed here while
// `teamwork_*` calls in the prompts fail in production.

/** Effective tool name exactly as OpenCode computes it. */
export function effectiveToolName(tool) {
  const normalized = String(tool?.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")
  const namespace = tool?.options?.namespace
  if (namespace === undefined) return normalized
  return `${String(namespace).replaceAll(".", "_")}_${normalized}`
}

/** Register one tool under its effective name, optionally wrapping it. */
export function registerTool(registry, tool, wrap = (value) => value) {
  registry[effectiveToolName(tool)] = wrap(tool)
  return registry
}
