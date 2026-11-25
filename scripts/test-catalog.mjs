// test-catalog — the tool contract the model actually sees.
//
// OpenCode's effective tool id is
//   options.namespace ? namespace + "_" + name : name
// (packages/core/src/tool/runtime.ts). A registration that forgets
// options.namespace is called `plan`, `next`, … while every prompt calls
// `teamwork_plan`, `teamwork_next`, …; nothing else in the suite would notice.
//
// This test registers the real tool set through the same effective-name shim
// the other tests use and asserts:
//   * exactly EXPECTED_TOOLS teamwork_* ids, no bare-name registration;
//   * options.namespace === "teamwork" and options.codemode === false;
//   * every input schema is the strict Standard-Schema wrapper (ADR 0019), its
//     model-facing JSON Schema is still an object schema, and every keyword it
//     uses is in the validator's supported set;
//   * every teamwork_* token referenced by agents/team/**/*.md and the command
//     templates resolves to a registered id (path literals such as
//     ~/teamwork_projects are not tool references).
//
// It also pins the version contract: the root and vendored plugin versions stay
// in lockstep and the optional @opencode/plugin peer is declared.

import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { COMMANDS } from "../plugins/opencode-teamwork/index.ts"
import { SUPPORTED_KEYWORDS, isStrictInput, strictInput } from "../plugins/opencode-teamwork/tool-schema.mjs"
import { effectiveToolName } from "./tool-registry.mjs"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert"

const ROOT = fileURLToPath(new URL("../", import.meta.url))

// The real registrations, listed explicitly so an accidental removal or a new
// tool both fail until the contract (and the prompt references) are updated.
const EXPECTED_TOOLS = [
  "teamwork_budget",
  "teamwork_cost",
  "teamwork_document_record",
  "teamwork_document_triage",
  "teamwork_evidence",
  "teamwork_final_verify",
  "teamwork_handoff",
  "teamwork_lemma_formalize",
  "teamwork_lemma_node",
  "teamwork_lemma_probe",
  "teamwork_lemma_verify",
  "teamwork_next",
  "teamwork_pitfall",
  "teamwork_plan",
  "teamwork_preflight",
  "teamwork_recover",
  "teamwork_report",
  "teamwork_resume",
  "teamwork_route",
  "teamwork_security_audit",
  "teamwork_status",
  "teamwork_task_update",
  "teamwork_tournament",
  "teamwork_victory_audit",
  "teamwork_wave_record",
  "teamwork_worktree",
]

const registered = new Map()
await registerTeamworkTools(
  {
    tool: {
      transform: async (cb) => {
        await cb({
          namespace: () => {},
          add: (tool) => registered.set(effectiveToolName(tool), tool),
        })
      },
    },
  },
  ROOT,
)

const ids = [...registered.keys()].sort()
assert.deepStrictEqual(
  ids,
  [...EXPECTED_TOOLS].sort(),
  `the registered teamwork_* ids drifted.\nregistered: ${ids.join(", ")}\nexpected:   ${[...EXPECTED_TOOLS].sort().join(", ")}`,
)

// The validator enforces exactly this subset; a schema using anything else
// must fail registration rather than be silently under-validated. Walk the
// model-facing schema independently of `strictInput`'s own assertion so a
// keyword the wrapper forgot to reject is still caught here.
function assertSupportedKeywords(schema, id, path = id) {
  assert(schema && typeof schema === "object" && !Array.isArray(schema), `${path}: schema must be an object`)
  for (const key of Object.keys(schema)) {
    assert(SUPPORTED_KEYWORDS.includes(key), `${path}: unsupported schema keyword "${key}" (ADR 0019)`)
  }
  if (schema.properties) {
    for (const [name, child] of Object.entries(schema.properties)) assertSupportedKeywords(child, id, `${path}.${name}`)
  }
  if (schema.items) assertSupportedKeywords(schema.items, id, `${path}[]`)
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    assertSupportedKeywords(schema.additionalProperties, id, `${path}.*`)
  }
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    assertSupportedKeywords(child, id, `${path}.anyOf[${index}]`)
  }
}

for (const [id, tool] of registered) {
  assert(id.startsWith("teamwork_"), `bare-name registration "${id}" — add options.namespace`)
  assert.deepStrictEqual(
    tool.options,
    { namespace: "teamwork", codemode: false },
    `${id} must declare options {namespace:"teamwork", codemode:false}`,
  )
  assert(isStrictInput(tool.input), `${id} input must be wrapped in strictInput (ADR 0019)`)
  const jsonSchema = tool.input["~standard"].jsonSchema.input({ target: "draft-2020-12" })
  assert(jsonSchema && jsonSchema.type === "object", `${id} must expose an object input schema to the model`)
  assert.strictEqual(jsonSchema.additionalProperties, false, `${id} root object must reject unknown properties`)
  assertSupportedKeywords(jsonSchema, id)
}

// The guard itself must be able to fail: an unsupported keyword is refused at
// registration time, not treated as an annotation.
let unsupportedRefused = false
try {
  strictInput({ type: "object", properties: { x: { type: "string", format: "email" } }, additionalProperties: false })
} catch (error) {
  unsupportedRefused = /unsupported keyword "format"/.test(String(error?.message))
}
assert(unsupportedRefused, "strictInput must refuse an unsupported keyword (format)")


function markdownFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

function toolTokens(text) {
  const tokens = []
  for (const match of text.matchAll(/\bteamwork_[a-z0-9_]+/g)) {
    const index = match.index ?? 0
    // ~/teamwork_projects/{name} is a filesystem path, not a tool.
    if (text[index - 1] === "/" || text[index - 1] === "\\") continue
    tokens.push(match[0])
  }
  return tokens
}

const sources = [
  ...markdownFiles(join(ROOT, "agents", "team")).map((file) => ({
    label: file.slice(ROOT.length),
    text: readFileSync(file, "utf8"),
  })),
  ...COMMANDS.map((command) => ({ label: `command ${command.name}`, text: command.template })),
]

const referenced = new Map()
for (const source of sources) {
  for (const token of toolTokens(source.text)) {
    if (!referenced.has(token)) referenced.set(token, source.label)
  }
}

assert(referenced.size > 0, "the prompts must reference at least one teamwork_* tool")
for (const [token, label] of referenced) {
  assert(EXPECTED_TOOLS.includes(token), `${label} references ${token}, but no such tool is registered`)
}

const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const pluginPackage = JSON.parse(readFileSync(join(ROOT, "plugins", "opencode-teamwork", "package.json"), "utf8"))
assert.strictEqual(pluginPackage.version, rootPackage.version, "the vendored plugin package must track the root version")
assert.strictEqual(rootPackage.peerDependencies?.["@opencode/plugin"], "^2.4", "the optional peer window must be ^2.4")
assert.strictEqual(
  rootPackage.peerDependenciesMeta?.["@opencode/plugin"]?.optional,
  true,
  "the @opencode/plugin peer must stay optional (dependency-free installs)",
)

// The published package stays dependency-free: all harness dependencies live in
// tests/runtime/package.json, and tests/ is excluded from the tarball by
// omission. The CI packaging guard checks the actual pack listing too.
const dependencies = rootPackage.dependencies ?? {}
assert.strictEqual(Object.keys(dependencies).length, 0, "the root package must declare no runtime dependencies")
const files = rootPackage.files ?? []
assert(
  !files.some((entry) => entry === "tests" || entry.startsWith("tests/")),
  "tests/ must never be listed in package.json files",
)

console.log(
  `✓ test-catalog passed: ${ids.length} teamwork_* tools, namespace/codemode/strict-input contract, ${referenced.size} prompt token(s) all resolve, version ${rootPackage.version}`,
)
