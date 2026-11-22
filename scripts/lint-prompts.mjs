#!/usr/bin/env node
// Prompt/agent linter for @heretek-ai/opencode-teamwork-v2.
//
// Guards the invariants we keep breaking by hand:
//   * one canonical artifact root (.opencode/teamwork/<session-id>/)
//   * one canonical topology enum (parsed from docs/ARTIFACTS.md)
//   * no duplicated "run-time reminder" blocks / self-referential "agent file"
//   * no stale references (Antigravity, defaults.ts, agent.team/*)
//   * no `effect: ask` in agents that run in parallel (would stall a run)
//   * every command template consumes $ARGUMENTS
//
// Usage: node scripts/lint-prompts.mjs   (exit 1 on any violation)

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const agentsDir = join(root, "agents", "team")
const pluginFile = join(root, "plugins", "opencode-teamwork", "index.ts")
const artifactsFile = join(root, "docs", "ARTIFACTS.md")

const errors = []
const fail = (file, msg) => errors.push(`${basename(file)}: ${msg}`)

const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"))
const read = (p) => readFileSync(p, "utf8")

// Canonical topologies, parsed from docs/ARTIFACTS.md so there is one source.
// The table lives in the level-2 "Topologies" section; scoping the parse to that
// section keeps unrelated documentation tables (feedbackLog fields, plan inputs,
// …) from being mistaken for topologies.
const EXPECTED_TOPOLOGIES = [
  "small-focused",
  "iterative-coding",
  "distributed-coding",
  "proof",
  "massive-proof",
  "document-review",
]

// Text of the level-2 "Topologies" section, up to the next level-2 heading.
function topologySection(md) {
  const heading = /^##[ \t]+Topologies[ \t]*$/m.exec(md)
  if (!heading) return null
  const rest = md.slice(heading.index + heading[0].length)
  const next = /^##[ \t]+\S/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

let canonical = []
if (!existsSync(artifactsFile)) {
  errors.push("docs/ARTIFACTS.md is missing")
} else {
  const md = read(artifactsFile)
  const section = topologySection(md)
  if (section === null) {
    errors.push("docs/ARTIFACTS.md: topology section not found")
  } else {
    canonical = [...section.matchAll(/^\| `([a-z][a-z-]+)` \|/gm)].map((m) => m[1])
    if (canonical.length < 6) errors.push(`docs/ARTIFACTS.md: expected >=6 topologies, found ${canonical.length}`)

    // The parsed set must be exactly the canonical six. This catches a misparse
    // with a message about the document, not about the agent prompts.
    const found = new Set(canonical)
    const missing = EXPECTED_TOPOLOGIES.filter((t) => !found.has(t))
    const extra = [...found].filter((t) => !EXPECTED_TOPOLOGIES.includes(t))
    const duplicates = canonical.filter((t, i) => canonical.indexOf(t) !== i)
    if (missing.length) errors.push(`docs/ARTIFACTS.md: topology section missing canonical topologies: ${missing.join(", ")}`)
    if (extra.length) errors.push(`docs/ARTIFACTS.md: topology section has unknown entries: ${extra.join(", ")}`)
    if (duplicates.length) errors.push(`docs/ARTIFACTS.md: topology section has duplicate entries: ${duplicates.join(", ")}`)
  }
}

const LEGACY = ["large-swarm", "doc-review", "long-proof", "massive-proof-swarm"]
const FORBIDDEN = [
  ["Antigravity", "attribution removed; describe behavior, don't name-drop"],
  ["defaults.ts", "stale path — models live in agent frontmatter / teamwork.json"],
  ["agent.team/*", "stale V1 config key"],
  ["run-time reminder", "duplicated prompt block"],
  ["are in your agent file", "self-referential instruction"],
  ["in your agent file", "self-referential instruction"],
  [".teamwork-runs", "old artifact root"],
  ["<run-id>", "old id terminology"],
]

const PARALLEL_AGENTS = new Set([
  "proposer.md", "synthesizer.md", "worker.md", "proof-worker.md",
  "falsifier.md", "scout.md", "verifier.md",
  "segment-reviewer.md", "formalization-reviewer.md", "referee.md",
])

for (const file of agents) {
  const path = join(agentsDir, file)
  const text = read(path)

  // Frontmatter
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) { fail(path, "missing frontmatter"); continue }
  for (const key of ["description", "mode", "model"]) {
    if (!new RegExp(`^${key}:`, "m").test(fm[1])) fail(path, `frontmatter missing '${key}'`)
  }

  // Forbidden references
  for (const [needle, why] of FORBIDDEN) {
    if (text.includes(needle)) fail(path, `contains '${needle}' (${why})`)
  }

  // Legacy topology names allowed only on an alias-mapping line (contains '→')
  for (const line of text.split("\n")) {
    if (line.includes("→")) continue
    for (const legacy of LEGACY) {
      if (line.includes(legacy)) fail(path, `uses legacy topology '${legacy}'`)
    }
  }

  // Parallel agents must not block on 'ask'
  if (PARALLEL_AGENTS.has(file) && /effect:\s*ask/.test(text)) {
    fail(path, "uses 'effect: ask' but runs in parallel (would stall the run)")
  }
}

// Plugin: commands must consume $ARGUMENTS and not use old paths
const plugin = read(pluginFile)
if (plugin.includes(".teamwork-runs")) fail(pluginFile, "old artifact root")
const argCount = (plugin.match(/\$ARGUMENTS/g) || []).length
const cmdCount = (plugin.match(/name:\s*"/g) || []).length
if (argCount < 1) fail(pluginFile, "no $ARGUMENTS substitution found")
if (argCount < cmdCount - 1) fail(pluginFile, `only ${argCount} $ARGUMENTS for ~${cmdCount} commands`)

// Canonical topology names must appear in the agents that route on them
for (const file of ["sentinel.md", "crafter.md"]) {
  const text = read(join(agentsDir, file))
  const missing = canonical.filter((t) => !text.includes(`\`${t}\``))
  if (missing.length) fail(join(agentsDir, file), `missing canonical topologies: ${missing.join(", ")}`)
}

// Guardrail invariants (see docs/GUARDRAILS.md)
if (!existsSync(join(root, "docs", "GUARDRAILS.md"))) errors.push("docs/GUARDRAILS.md is missing")
if (!agents.includes("security-auditor.md")) errors.push("agents/team/security-auditor.md is missing")

// Continuity protocol: handoffs use five fixed sections, and the shared run
// briefing's section names are documented. Both are contract text, so drift
// here is a silent loss of continuity for the next agent.
const HANDOFF_SECTIONS = [
  "1. Observation",
  "2. Logic Chain",
  "3. Caveats",
  "4. Conclusion",
  "5. Verification Method",
]
const HANDOFF_AGENTS = ["worker.md", "verifier.md", "falsifier.md", "security-auditor.md", "victory-auditor.md"]
for (const file of HANDOFF_AGENTS) {
  const path = join(agentsDir, file)
  if (!existsSync(path)) {
    errors.push(`agents/team/${file} is missing`)
    continue
  }
  const text = read(path)
  const missing = HANDOFF_SECTIONS.filter((section) => !text.includes(section))
  if (missing.length) fail(path, `handoff.md missing sections: ${missing.join(", ")}`)
}
const briefingSections = ["## Mission", "## Identity", "## Key Constraints", "## Project Status", "## Artifact Index", "## Succession"]
if (existsSync(artifactsFile)) {
  const md = read(artifactsFile)
  const missingHandoff = HANDOFF_SECTIONS.filter((section) => !md.includes(section))
  if (missingHandoff.length) fail(artifactsFile, `handoff.md contract missing sections: ${missingHandoff.join(", ")}`)
  if (!/handoff\.md/.test(md)) fail(artifactsFile, "handoff.md contract is not documented")
  const missingBriefing = briefingSections.filter((section) => !md.includes(section))
  if (missingBriefing.length) fail(artifactsFile, `BRIEFING.md contract missing sections: ${missingBriefing.join(", ")}`)
  if (!/BRIEFING\.md/.test(md)) fail(artifactsFile, "BRIEFING.md is not documented")
}

const toolsFile = join(root, "plugins", "opencode-teamwork", "tools.ts")
if (existsSync(toolsFile)) {
  const t = read(toolsFile)
  if (!/SESSION_ID/.test(t)) fail(toolsFile, "no session-id allowlist found")
  if (!/relative\(/.test(t) || !/startsWith\("\.\."\)/.test(t)) fail(toolsFile, "no path-containment check found")
  if (!/realpathSync\(/.test(t)) fail(toolsFile, "no realpath containment check (symlink escape)")
  if (!/lstatSync\(/.test(t)) fail(toolsFile, "no lstat check (symlinked run dir)")
  if (!/permission\?\.hook|permission\.hook/.test(t)) fail(toolsFile, "no permission hook found")
}

// No unquoted session-id / command substitution in a git command (injection).
// Scans the agent files AND the plugin's command templates.
const shellScanFiles = [...agents.map((f) => join(agentsDir, f)), pluginFile]
for (const path of shellScanFiles) {
  // Join backslash line-continuations so a split command can't slip through.
  for (const line of read(path).replace(/\\\r?\n/g, " ").split("\n")) {
    if (!/\bgit\s/.test(line)) continue
    if (line.includes("<session-id>")) fail(path, "unquoted <session-id> in a git command (command-injection risk)")
    if (line.includes("$(")) fail(path, "command substitution in a git command")
  }
}

if (errors.length) {
  console.error(`✗ prompt lint failed (${errors.length}):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`✓ prompt lint passed (${agents.length} agents, ${canonical.length} topologies)`)
