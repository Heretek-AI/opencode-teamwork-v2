#!/usr/bin/env node
// Security-claim lint.
//
// Artifact authenticity in this package is tamper-evident against a writer
// limited to the run directory. It is not a same-UID boundary, and the docs
// must not imply otherwise. This guard fails on four marketing phrases in
// README/SECURITY/docs unless the surrounding paragraph explicitly negates the
// claim ("do not claim ...", "never describe ...").
//
// Usage:
//   node scripts/lint-security-claims.mjs              # default README/docs set
//   node scripts/lint-security-claims.mjs <file> [...] # explicit files (tests)

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")

const FORBIDDEN = [
  { label: "tamper-proof", re: /\btamper[- ]proof\b/i },
  { label: "trusted signature", re: /\btrusted\s+signature\b/i },
  { label: "safe against a local user", re: /\bsafe\s+against\s+(?:a\s+)?local\s+(?:user|attacker|shell)\b/i },
  { label: "signed by a trusted authority", re: /\bsigned\s+by\s+a\s+trusted\s+authority\b/i },
]

// A paragraph that negates the claim is documentation of the boundary, not a
// claim itself (ADR 0006 §3.5 and GUARDRAILS use exactly that wording).
const NEGATION =
  /\b(?:do not|don't|does not|never|must not|mustn't|should not|shouldn't|cannot|can't)\s+(?:claim|describe|say|state|imply|suggest)\b/i

function collectMarkdown(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "re") continue
      collectMarkdown(full, out)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full)
    }
  }
}

function defaultFiles() {
  const files = []
  for (const name of ["README.md", "SECURITY.md"]) {
    const full = join(root, name)
    try {
      if (statSync(full).isFile()) files.push(full)
    } catch {}
  }
  collectMarkdown(join(root, "docs"), files)
  return files
}

function scan(file) {
  const text = readFileSync(file, "utf8")
  const hits = []
  const paragraphs = text.split(/\r?\n\s*\r?\n/)
  let line = 1
  for (const paragraph of paragraphs) {
    const paragraphStart = line
    line += paragraph.split(/\r?\n/).length + 1
    if (NEGATION.test(paragraph)) continue
    for (const { label, re } of FORBIDDEN) {
      if (re.test(paragraph)) hits.push({ file, line: paragraphStart, label })
    }
  }
  return hits
}

const explicit = process.argv.slice(2)
const files = explicit.length > 0 ? explicit.map((file) => resolve(file)) : defaultFiles()
const hits = []
for (const file of files) {
  try {
    hits.push(...scan(file))
  } catch (err) {
    if (err?.code === "ENOENT") continue
    throw err
  }
}

if (hits.length > 0) {
  console.error("lint-security-claims: forbidden security claims found:")
  for (const hit of hits) {
    console.error(`  ${relative(root, hit.file)}:${hit.line}  "${hit.label}"`)
  }
  console.error("Describe artifacts as tamper-evident, not tamper-proof, and name the same-UID residual.")
  process.exit(1)
}

console.log(`lint-security-claims: ${files.length} file(s) clean`)
