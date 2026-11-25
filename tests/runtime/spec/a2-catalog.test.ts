import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENTS_DIR, createProject } from "../harness/project"
import { importTeamwork, loadHost } from "../harness/load"
import { openLocationTools } from "../harness/tools"

// The contract pinned by scripts/test-catalog.mjs. Kept explicit so a removal or
// an accidental addition fails until the prompt references are updated too.
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

function markdownFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

function toolTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(/\bteamwork_[a-z0-9_]+/g)) {
    const index = match.index ?? 0
    // ~/teamwork_projects/... is a path literal, not a tool reference.
    if (text[index - 1] === "/" || text[index - 1] === "\\") continue
    tokens.push(match[0])
  }
  return tokens
}

test("A2 catalog: exactly 26 effective teamwork_* ids with namespace + codemode + object input", async () => {
  const project = createProject("a2-catalog")
  const loaded = await loadHost(project, { mode: "memory" })
  try {
    const { list } = await openLocationTools(loaded, project.root)
    const tools = new Map(list.map((tool: any) => [String(tool.id), tool]))
    const ids = [...tools.keys()].sort()
    const teamwork = ids.filter((id) => id.startsWith("teamwork_"))

    expect(teamwork).toEqual([...EXPECTED_TOOLS].sort())
    expect(ids).not.toContain("plan")
    expect(ids).not.toContain("next")

    for (const [id, tool] of tools) {
      if (!id.startsWith("teamwork_")) continue
      expect(tool.id).toBe(id)
      expect(id).toBe(`teamwork_${tool.name}`)
      expect(tool.options).toEqual({ namespace: "teamwork", codemode: false })
      expect(tool.input).toBeDefined()
      expect(typeof tool.input["~standard"]?.validate).toBe("function")
      const jsonSchema = tool.input["~standard"].jsonSchema.input({ target: "draft-2020-12" })
      expect(jsonSchema.type).toBe("object")
      expect(jsonSchema.additionalProperties).toBe(false)
    }

    // Every tool reference in the shipped prompts resolves to a registered id.
    const module = await importTeamwork(project)
    const sources = [
      ...markdownFiles(AGENTS_DIR).map((file) => ({
        label: file,
        text: readFileSync(file, "utf8"),
      })),
      ...module.COMMANDS.map((command: any) => ({ label: `command ${command.name}`, text: command.template })),
    ]
    const referenced = new Map<string, string>()
    for (const source of sources) {
      for (const token of toolTokens(source.text)) {
        if (!referenced.has(token)) referenced.set(token, source.label)
      }
    }
    expect(referenced.size).toBeGreaterThan(0)
    for (const [token, label] of referenced) {
      expect(EXPECTED_TOOLS, `${label} references ${token}`).toContain(token)
    }
  } finally {
    await loaded.close()
    project.cleanup()
  }
})
