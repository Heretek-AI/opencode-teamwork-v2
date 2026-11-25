#!/usr/bin/env node
// Compare the live registered Teamwork tool catalog and command set against
// the pinned contract, emitting a machine-readable JSON summary for the
// nightly OpenCode host-drift job (Issue #39).

import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { COMMANDS } from "../plugins/opencode-teamwork/index.ts"
import { effectiveToolName } from "./tool-registry.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function sha256(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16)
}

const tools = []
await registerTeamworkTools(
  {
    tool: {
      transform: async (cb) => {
        await cb({
          namespace: () => {},
          add: (tool) => {
            const schema = tool.input?.["~standard"]?.jsonSchema?.input?.({ target: "draft-2020-12" }) ?? tool.input
            tools.push({
              id: effectiveToolName(tool),
              name: tool.name,
              namespace: tool.options?.namespace ?? null,
              codemode: tool.options?.codemode ?? null,
              required: Array.isArray(schema?.required)
                ? [...schema.required].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
                : [],
              schemaDigest: sha256(schema ?? {}),
            })
          },
        })
      },
    },
  },
  ROOT,
)
tools.sort((a, b) => a.id.localeCompare(b.id))

const commands = COMMANDS.map((c) => c.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const snapshot = { tools, commands, toolCount: tools.length, commandCount: commands.length }

const outIdx = process.argv.indexOf("--out")
if (outIdx !== -1 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], JSON.stringify(snapshot, null, 2) + "\n")
} else {
  console.log(JSON.stringify(snapshot, null, 2))
}
