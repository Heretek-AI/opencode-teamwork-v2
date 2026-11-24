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
//   * every input schema is an object schema;
//   * every teamwork_* token referenced by agents/team/**/*.md and the command
//     templates resolves to a registered id (path literals such as
//     ~/teamwork_projects are not tool references).
//
// It also pins the version contract: the root and vendored plugin versions stay
// in lockstep and the optional @opencode/plugin peer is declared.

import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { COMMANDS } from "../plugins/opencode-teamwork/index.ts"
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

for (const [id, tool] of registered) {
  assert(id.startsWith("teamwork_"), `bare-name registration "${id}" — add options.namespace`)
  assert.deepStrictEqual(
    tool.options,
    { namespace: "teamwork", codemode: false },
    `${id} must declare options {namespace:"teamwork", codemode:false}`,
  )
  assert(!tool.input || tool.input.type === "object", `${id} must use an object input schema`)
  assert(tool.input && typeof tool.input === "object", `${id} must declare an input schema`)
}

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

console.log(
  `✓ test-catalog passed: ${ids.length} teamwork_* tools, namespace/codemode/input contract, ${referenced.size} prompt token(s) all resolve, version ${rootPackage.version}`,
)
