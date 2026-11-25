// @heretek-ai/opencode-teamwork-v2 — Document Review route engine module
//
// Zero runtime dependencies (Node built-ins only) and strictly erasable
// TypeScript syntax compatible with Node 22+ native type-stripping (no enum,
// no namespace, no constructor parameter properties).

import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { inflateRawSync, inflateSync } from "node:zlib"
import { resolveTrustedExecutable } from "./safe-fs.mjs"
import { assertSafeUrl, safeFetch } from "./url-guard.mjs"

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_INLINE_BYTES = 512 * 1024
const MAX_SEGMENTS = 8
const DEFAULT_MAX_SEGMENTS = 6
const MAX_RSA_DEPTH = 3
const MAX_RSA_WIDTH = 4
const DEFAULT_REVIEW_TREE_SHAPE = [4, 2, 1] as const
const MAX_SYNTH_DEPTH = 2
const MAX_SYNTH_WIDTH = 4
const DEFAULT_SYNTH_TREE_SHAPE = [4, 1] as const
export const MAX_SEGMENT_CHARS = 32_000
export const MAX_TEXT_MAP_CHARS = 200_000
export const MAX_FINDINGS = 50
const URL_FETCH_TIMEOUT_MS = 3000
const MAX_PDF_INFLATE_BYTES = 4 * 1024 * 1024

export const SEGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

const DOC_EXT_RE = /\.(?:md|markdown|pdf|tex|txt|rst|html?|adoc)$/i
const URL_TOKEN_RE = /https?:\/\/[^\s)>\]}"']+/gi

export interface DocumentInput {
  path?: string
  url?: string
  content?: string
  format?: string
}

export interface RouteClassifyInput {
  request?: string
  document?: DocumentInput
  inputs?: string[]
  checkPaths?: boolean
}

export interface DocumentRouteClassification {
  topology: string
  routingReason: string
  documentDetected: boolean
  signals: {
    hasSuppliedDocument: boolean
    hasCritiqueIntent: boolean
    rejectedAsPrOrCodeReview: boolean
    rejectedAsImplementOrSolve: boolean
    leanExplicit: boolean
    mathSignal: boolean
    massiveOptIn: boolean
    lightnessSignal: boolean
    iterativeSignal: boolean
  }
}

export interface TreeBounds {
  maxSegments: number
  reviewTreeShape: number[]
  synthTreeShape: number[]
}

export interface ResolvedDocument {
  sourceType: "path" | "url" | "content"
  sourceLabel: string
  format: string
  bufferOrText: Buffer | string
  byteLength: number
}

export interface IngestedDocument {
  ok: true
  format: string
  text: string
  extractionStatus: "extracted" | "needs_ingestor"
  warning?: string
}

export interface DocumentSegment {
  id: string
  title: string
  charCount: number
  sha256: string
  content: string
}

function cleanDocText(value: unknown, max = 64): string {
  return String(value ?? "")
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
    .slice(0, max)
}

function cleanDocBlock(value: unknown, max = 2000): string {
  const s = String(value ?? "").replace(/[\r\x00-\x09\x0b-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s
}

export function isSafeSegmentId(id: unknown): id is string {
  return typeof id === "string" && SEGMENT_ID.test(id) && id !== "." && id !== ".."
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

const TRIM_LEAD_CHARS = new Set(["(", "[", "`", '"', "'", "<"])
const TRIM_TRAIL_CHARS = new Set([")", "]", "`", '"', "'", ">", ",", ".", ";", ":", "!", "?"])

function trimToken(token: string): string {
  let start = 0
  let end = token.length
  while (start < end && TRIM_LEAD_CHARS.has(token[start])) start++
  while (end > start && TRIM_TRAIL_CHARS.has(token[end - 1])) end--
  return token.slice(start, end)
}

function escapesRel(rel: string): boolean {
  return !rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")
}

function resolveUserPath(root: string, rawPath: string): string {
  let p = rawPath.trim()
  if (p.startsWith("file://")) {
    p = p.slice("file://".length)
    try {
      p = decodeURIComponent(p)
    } catch {}
  }
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(root, p)
}

function isContainedRegularFile(root: string, candidatePath: string): { ok: true; resolved: string } | { ok: false; error: string } {
  const absRoot = resolve(root)
  const target = resolveUserPath(absRoot, candidatePath)
  const rel = relative(absRoot, target)
  if (escapesRel(rel)) {
    return { ok: false, error: "refused: document path escapes workspace root" }
  }

  // Check every existing path segment from root down to target for symlinks.
  let cur = target
  while (true) {
    try {
      const st = lstatSync(cur)
      if (st.isSymbolicLink()) {
        return { ok: false, error: `refused: document path contains a symlink ("${cur}")` }
      }
      if (cur === target && !st.isFile()) {
        return { ok: false, error: "refused: document path is not a regular file" }
      }
    } catch (err: any) {
      if (cur === target) {
        return { ok: false, error: `refused: document path does not exist (${cleanDocText(err?.code || err?.message, 64)})` }
      }
    }
    const parent = dirname(cur)
    if (parent === cur || cur === absRoot) break
    const parentRel = relative(absRoot, parent)
    if (escapesRel(parentRel)) {
      break
    }
    cur = parent
  }

  try {
    const realRoot = realpathSync(absRoot)
    const realTarget = realpathSync(target)
    const realRel = relative(realRoot, realTarget)
    if (escapesRel(realRel)) {
      return { ok: false, error: "refused: document path escapes workspace root via realpath" }
    }
  } catch {
    return { ok: false, error: "refused: document path is not resolvable" }
  }

  return { ok: true, resolved: target }
}

function inferFormat(formatHint: unknown, label = "", contentType = ""): string {
  const hint = typeof formatHint === "string" ? formatHint.trim().toLowerCase().replace(/^\./, "") : ""
  if (hint) {
    if (hint === "markdown") return "md"
    if (hint === "latex") return "tex"
    if (hint === "text" || hint === "plain") return "txt"
    if (hint === "htm") return "html"
    return hint
  }
  const ct = contentType.toLowerCase()
  if (ct.includes("application/pdf")) return "pdf"
  if (ct.includes("text/html")) return "html"
  if (ct.includes("text/markdown")) return "md"
  if (ct.includes("application/x-tex") || ct.includes("text/x-tex")) return "tex"

  let pathForExt = label
  if (/^https?:\/\//i.test(label)) {
    try {
      pathForExt = new URL(label).pathname
    } catch {}
  }
  const ext = extname(pathForExt).toLowerCase().replace(/^\./, "")
  if (ext === "markdown") return "md"
  if (ext === "htm") return "html"
  return ext || "md"
}

interface TextSpan {
  start: number
  end: number
}

interface LineInfo {
  text: string
  start: number
  end: number
}

const MD_HEADING_LINE_RE = /^[ \t]*#{1,3}[ \t]+\S/
const LATEX_ENV_SET = new Set(["document", "abstract", "theorem", "lemma", "proposition", "corollary", "definition", "proof", "remark"])
const LATEX_CMD_SET = new Set(["title", "author", "date", "maketitle", "newcommand", "renewcommand", "newtheorem", "DeclareMathOperator"])
const LATEX_SEC_SET = new Set(["part", "chapter", "section", "subsection", "part*", "chapter*", "section*", "subsection*"])
const LATEX_PKG_SET = new Set(["documentclass", "documentstyle", "usepackage", "RequirePackage"])

function isLatexStructLine(line: string): boolean {
  const s = line.trimStart()
  if (!s.startsWith("\\")) return false
  let i = 1
  while (i < s.length && ((s[i] >= "a" && s[i] <= "z") || (s[i] >= "A" && s[i] <= "Z") || s[i] === "*")) i++
  const cmd = s.slice(1, i)
  if (!cmd) return false
  if (LATEX_CMD_SET.has(cmd)) return true
  if (LATEX_SEC_SET.has(cmd) && s[i] === "{") return true
  if (LATEX_PKG_SET.has(cmd)) {
    if (s[i] === "{") return true
    if (s[i] === "[") {
      const close = s.indexOf("]", i + 1)
      return close !== -1 && s[close + 1] === "{"
    }
    return false
  }
  if (cmd === "begin" && s[i] === "{") {
    const close = s.indexOf("}", i + 1)
    return close !== -1 && LATEX_ENV_SET.has(s.slice(i + 1, close))
  }
  return false
}

const YAML_FM_OPEN_RE = /^---[ \t]*$/
const YAML_FM_CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/
const YAML_FM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*[ \t]*:/

const STRUCT_PARA_CMDS = new Set([
  "part", "chapter", "section", "subsection", "begin", "end",
  "documentclass", "documentstyle", "usepackage", "RequirePackage",
  "title", "author", "date", "maketitle", "item",
])

function hasStructParaLine(paraText: string): boolean {
  for (const rawLine of paraText.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trimStart()
    if (!line) continue
    if (/^#{1,6}[ \t]+\S/.test(line)) return true
    if (line.startsWith("```") || line.startsWith("~~~") || line.startsWith("---") || line.startsWith("...") || line.startsWith("|")) return true
    if (line.startsWith(">") && (line[1] === " " || line[1] === "\t")) return true
    if (line.startsWith("\\")) {
      let i = 1
      while (i < line.length && ((line[i] >= "a" && line[i] <= "z") || (line[i] >= "A" && line[i] <= "Z"))) i++
      if (STRUCT_PARA_CMDS.has(line.slice(1, i))) return true
    }
  }
  return false
}

const EXPLICIT_ASSISTANT_PHRASES = [
  "please", "can you", "could you", "would you", "will you",
  "help me", "tell me", "let me know", "i want you to", "i need you to",
]

function hasExplicitAssistantPhrase(text: string): boolean {
  const norm = text.toLowerCase().replace(/\s+/g, " ")
  return EXPLICIT_ASSISTANT_PHRASES.some((p) => new RegExp(`\\b${p}\\b`).test(norm))
}

const QUESTION_ABOUT_DOC_NOUNS = [
  "paper", "document", "doc", "draft", "spec", "rfc",
  "manuscript", "preprint", "proof", "theorem", "lemma", "section",
]

function isQuestionAboutDoc(trimmed: string): boolean {
  if (!trimmed.endsWith("?")) return false
  const norm = trimmed.toLowerCase().replace(/\s+/g, " ")
  const lastQ = norm.slice(Math.max(0, norm.lastIndexOf(".", norm.length - 2) + 1, norm.lastIndexOf("!", norm.length - 2) + 1))
  if (/\bthe above\b/.test(lastQ)) return true
  return QUESTION_ABOUT_DOC_NOUNS.some((n) => new RegExp(`\\bthis ${n}\\b`).test(lastQ))
}

const IMPERATIVE_LEAD_ADVERBS = new Set(["now", "then", "also", "finally", "next"])
const IMPERATIVE_VERBS = new Set([
  "review", "critique", "assess", "evaluate", "audit", "referee", "peer-review",
  "analyze", "analyse", "summarize", "summarise", "check", "inspect", "explain",
  "prove", "disprove", "solve", "answer", "verify", "formalize", "formalise",
  "fix", "debug", "diagnose", "troubleshoot", "implement", "refactor", "write",
  "build", "add", "edit", "update", "test", "make",
])

function hasImperativeStart(trimmed: string): boolean {
  const norm = trimmed.toLowerCase().replace(/^[,:\s]+/, "")
  const tokens = norm.split(/[\s,:]+/).filter(Boolean)
  if (tokens.length === 0) return false
  let idx = 0
  if (IMPERATIVE_LEAD_ADVERBS.has(tokens[0])) idx = 1
  const first = tokens[idx] || ""
  const second = tokens[idx + 1] || ""
  if (first === "peer" && second === "review") return true
  return IMPERATIVE_VERBS.has(first)
}

const NARRATION_SECTION_NOUNS = new Set(["section", "chapter", "part", "appendix", "table", "figure"])
const NARRATION_THIS_NOUNS = new Set(["paper", "section", "article", "note", "draft", "work", "study"])
const NARRATION_WE_VERBS = new Set([
  "review", "analyze", "analyse", "evaluate", "summarize", "summarise",
  "prove", "show", "present", "conclude", "observe", "find", "note",
  "discuss", "describe", "propose", "report", "compare", "demonstrate",
])

function isBodyNarration(trimmed: string): boolean {
  const tokens = trimmed.toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length < 2) return false
  if (tokens[0] === "in") {
    if (NARRATION_SECTION_NOUNS.has(tokens[1])) return true
    if (tokens[1] === "this" && NARRATION_THIS_NOUNS.has(tokens[2] || "")) return true
  }
  if (["here", "below", "above", "finally", "overall"].includes(tokens[0]) && tokens[1] === "we") return true
  if (tokens[0] === "we" && NARRATION_WE_VERBS.has(tokens[1])) return true
  return false
}

function isTrailingUserInstruction(paraText: string): boolean {
  const trimmed = paraText.trim()
  if (!trimmed) return false
  if (hasStructParaLine(trimmed)) return false
  if (isBodyNarration(trimmed)) return false
  if (hasExplicitAssistantPhrase(trimmed)) return true
  return hasImperativeStart(trimmed) || isQuestionAboutDoc(trimmed)
}

function getLineInfos(text: string): LineInfo[] {
  const lines: LineInfo[] = []
  let pos = 0
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos)
    if (nl === -1) {
      lines.push({ text: text.slice(pos), start: pos, end: text.length })
      break
    }
    const lineEnd = nl > pos && text[nl - 1] === "\r" ? nl - 1 : nl
    lines.push({ text: text.slice(pos, lineEnd), start: pos, end: lineEnd })
    pos = nl + 1
    if (pos === text.length) break
  }
  return lines
}

function findYamlFrontmatterStart(lines: LineInfo[], beforeLine: number): number {
  for (let i = 0; i < beforeLine; i++) {
    if (!YAML_FM_OPEN_RE.test(lines[i].text)) continue
    let hasKey = false
    for (let j = i + 1; j < beforeLine; j++) {
      const ln = lines[j].text
      if (YAML_FM_CLOSE_RE.test(ln)) {
        if (hasKey) return i
        break
      }
      const trimmed = ln.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      if (YAML_FM_KEY_RE.test(trimmed)) {
        hasKey = true
      } else if (!/^\s+\S/.test(ln) && !/^-\s+/.test(trimmed)) {
        break
      }
    }
  }
  return -1
}

function overlapsAny(spans: TextSpan[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start)
}

function mergeSpans(spans: TextSpan[]): TextSpan[] {
  if (spans.length <= 1) return [...spans]
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const merged: TextSpan[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged.at(-1)!
    const cur = sorted[i]
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end)
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

function maskSpansPreservingLines(text: string, spans: TextSpan[]): string {
  if (spans.length === 0) return text
  const chars = text.split("")
  for (const sp of spans) {
    for (let k = sp.start; k < sp.end; k++) {
      if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " "
    }
  }
  return chars.join("")
}

function scanFencedSpans(request: string, rawLines: LineInfo[], spans: TextSpan[]): void {
  let i = 0
  while (i < rawLines.length) {
    const ln = rawLines[i].text.trimStart()
    const fenceChar = ln.startsWith("```") ? "`" : ln.startsWith("~~~") ? "~" : ""
    if (!fenceChar || overlapsAny(spans, rawLines[i].start, rawLines[i].end)) {
      i++
      continue
    }
    let fenceLen = 0
    while (fenceLen < ln.length && ln[fenceLen] === fenceChar) fenceLen++
    const info = ln.slice(fenceLen)
    if (fenceChar === "`" && info.includes("`")) {
      i++
      continue
    }
    const closePrefix = fenceChar.repeat(fenceLen)
    let closeIdx = -1
    for (let j = i + 1; j < rawLines.length; j++) {
      const cand = rawLines[j].text.trim()
      if (cand.startsWith(closePrefix) && cand.replaceAll(fenceChar, "").length === 0) {
        closeIdx = j
        break
      }
    }
    if (closeIdx === -1) {
      i++
      continue
    }
    const bodyStart = rawLines[i].end
    const bodyEnd = rawLines[closeIdx].start
    if (request.slice(bodyStart, bodyEnd).trim().length >= 120) {
      const spanStart = rawLines[i].start
      const spanEnd = rawLines[closeIdx].end
      if (!overlapsAny(spans, spanStart, spanEnd)) {
        spans.push({ start: spanStart, end: spanEnd })
      }
    }
    i = closeIdx + 1
  }

  let searchFrom = 0
  while (searchFrom < request.length) {
    const open = request.indexOf("```", searchFrom)
    if (open === -1) break
    const nl = request.indexOf("\n", open + 3)
    if (nl === -1) break
    const close = request.indexOf("```", nl + 1)
    if (close === -1) break
    if (request.slice(nl + 1, close).trim().length >= 120 && !overlapsAny(spans, open, close + 3)) {
      spans.push({ start: open, end: close + 3 })
    }
    searchFrom = close + 3
  }
}

function collectParagraphSpans(request: string, rawLines: LineInfo[], startLine: number): { start: number; end: number; text: string }[] {
  const paras: { start: number; end: number; text: string }[] = []
  let pStartIdx = -1
  for (let k = startLine; k < rawLines.length; k++) {
    const nonBlank = rawLines[k].text.trim().length > 0
    if (nonBlank && pStartIdx === -1) {
      pStartIdx = k
    } else if (!nonBlank && pStartIdx !== -1) {
      const sOff = rawLines[pStartIdx].start
      const eOff = rawLines[k - 1].end
      paras.push({ start: sOff, end: eOff, text: request.slice(sOff, eOff) })
      pStartIdx = -1
    }
  }
  if (pStartIdx !== -1) {
    const sOff = rawLines[pStartIdx].start
    const eOff = rawLines.at(-1)!.end
    paras.push({ start: sOff, end: eOff, text: request.slice(sOff, eOff) })
  }
  return paras
}

function peelTrailingInstructions(
  masked: string,
  docStart: number,
  paras: { start: number; end: number; text: string }[],
  defaultEnd: number,
): number {
  let keepCount = paras.length
  let peeled = 0
  while (keepCount >= 2 && peeled < 2 && isTrailingUserInstruction(paras[keepCount - 1].text)) {
    const candidateEnd = paras[keepCount - 2].end
    const remLines = masked.slice(docStart, candidateEnd).split(/\r?\n/)
    const stillStructured = remLines.some((l) => MD_HEADING_LINE_RE.test(l) || isLatexStructLine(l))
    if (!stillStructured) break
    keepCount--
    peeled++
  }
  return keepCount < paras.length ? paras[keepCount - 1].end : defaultEnd
}

function findStructuredDocSpan(request: string, masked: string, rawLines: LineInfo[]): TextSpan | null {
  if (masked.replace(/[ \t]+/g, " ").trim().length < 240) return null
  const lines = getLineInfos(masked)
  if (lines.length < 3) return null
  const firstMdIdx = lines.findIndex((ln) => MD_HEADING_LINE_RE.test(ln.text))
  const firstLatexIdx = lines.findIndex((ln) => isLatexStructLine(ln.text))
  if (firstMdIdx === -1 && firstLatexIdx === -1) return null

  let mdStartLine = firstMdIdx
  if (firstMdIdx !== -1) {
    const fmStart = findYamlFrontmatterStart(lines, firstMdIdx)
    if (fmStart !== -1) mdStartLine = fmStart
  }
  let latexStartLine = firstLatexIdx
  if (firstLatexIdx !== -1) {
    while (latexStartLine > 0 && /^[ \t]*%/.test(lines[latexStartLine - 1].text)) {
      latexStartLine--
    }
  }
  let startLine = latexStartLine
  if (mdStartLine !== -1 && latexStartLine !== -1) startLine = Math.min(mdStartLine, latexStartLine)
  else if (mdStartLine !== -1) startLine = mdStartLine

  const docStart = lines[startLine].start
  const endDocMatches = [...masked.matchAll(/\\end\{document\}/gi)].filter(
    (m) => m.index !== undefined && m.index >= docStart,
  )
  let docEnd = request.length
  const lastEnd = endDocMatches.at(-1)
  if (lastEnd?.index !== undefined) {
    docEnd = lastEnd.index + lastEnd[0].length
  } else {
    const paras = collectParagraphSpans(request, rawLines, startLine)
    docEnd = peelTrailingInstructions(masked, docStart, paras, request.length)
  }
  return { start: docStart, end: docEnd }
}

export function splitInstructionAndInlineDoc(request: string): {
  leadingInstruction: string
  inlineDoc: string
  trailingInstruction: string
  instructionText: string
  hasInlineDoc: boolean
} {
  const spans: TextSpan[] = []
  let hasExplicitDocTag = false

  for (const m of request.matchAll(/<<<DOCUMENT\b([\s\S]*?)>>>/gi)) {
    if (m.index !== undefined && m[1].trim().length >= 20) {
      hasExplicitDocTag = true
      spans.push({ start: m.index, end: m.index + m[0].length })
    }
  }

  const rawLines = getLineInfos(request)
  scanFencedSpans(request, rawLines, spans)

  if (!hasExplicitDocTag) {
    const masked = maskSpansPreservingLines(request, spans)
    const structSpan = findStructuredDocSpan(request, masked, rawLines)
    if (structSpan) spans.push(structSpan)
  }

  if (spans.length === 0) {
    return {
      leadingInstruction: request,
      inlineDoc: "",
      trailingInstruction: "",
      instructionText: request,
      hasInlineDoc: false,
    }
  }

  const merged = mergeSpans(spans)
  const outerParts: string[] = []
  const docParts: string[] = []
  let cursor = 0
  for (const sp of merged) {
    outerParts.push(request.slice(cursor, sp.start))
    docParts.push(request.slice(sp.start, sp.end))
    cursor = sp.end
  }
  outerParts.push(request.slice(cursor))

  const leadingInstruction = outerParts[0].trim()
  const trailingInstruction = (outerParts.at(-1) ?? "").trim()
  const inlineDoc = docParts.join("\n\n")
  const instructionText = outerParts.map((p) => p.trim()).filter(Boolean).join("\n\n")

  return { leadingInstruction, inlineDoc, trailingInstruction, instructionText, hasInlineDoc: true }
}

const DOC_NOUN_PHRASE = String.raw`(?:(?:this|the|that|these|my|our|attached|supplied|provided|following|above)\s+){0,2}(?:(?!(?:bugs?|defects?|issues?|errors?|faults?|glitches?|crash(?:es)?|failures?|regressions?|exceptions?|leaks?|bottlenecks?)\b)[a-z0-9_-]+\s+){0,2}(?:papers?|documents?|docs?|preprints?|manuscripts?|rfcs?|drafts?|spec(?:ification)?s?|design\s+docs?|proposals?|whitepapers?|reports?|theses|thesis|articles?)`

const STRONG_CRITIQUE_RE = new RegExp(
  String.raw`\b(?:review|critique|assess|evaluate|audit|referee|peer[- ]?review|summari[sz]e|what\s+does\s+${DOC_NOUN_PHRASE}\s+say)\b`,
  "i",
)

const DOC_TARGETED_ANALYZE_CHECK_RE = new RegExp(
  String.raw`\b(?:analy[sz]e|check)\s+(?:of\s+)?(?:__DOC_REF__|${DOC_NOUN_PHRASE})\b`,
  "i",
)

const DEFECT_HEAD_NOUN_BODY =
  String.raw`bugs?|defects?|issues?|errors?|faults?|glitches?|crash(?:es)?|failures?|outages?|panics?|hangs?|freezes?|deadlocks?|timeouts?|regressions?|exceptions?|stack\s*traces?|tracebacks?|core\s*dumps?|leaks?|bottlenecks?|slowdowns?|spikes?|contentions?|race\s+conditions?|races?`
const NON_MODIFIER_GUARD =
  String.raw`(?!(?:for|in|of|on|to|with|about|from|into|by|and|or|covering|regarding|concerning|paper|document|doc|preprint|manuscript|rfc|draft|spec|specification|article|report)\b)`
const DEFECT_ANALYSIS_RE = new RegExp(
  String.raw`\b(?:analy[sz]e|check|investigate|trace|inspect|examine|profile|fix|resolve)\s+(?:(?:the|this|that|these|those|a|an|some|any|my|our|your|their|several|multiple|recent|intermittent|recurring|new|existing)\s+)?(?:${NON_MODIFIER_GUARD}[a-z0-9_-]+\s+){0,3}(?:${DEFECT_HEAD_NOUN_BODY})\b` +
    String.raw`|\btroubleshoot\s+(?:(?:the|this|that|these|those|a|an)\s+)?(?:${NON_MODIFIER_GUARD}[a-z0-9_-]+\s+){0,3}(?:${DEFECT_HEAD_NOUN_BODY})\s+(?:in|of|on|for)\s+__DOC_REF__\b` +
    String.raw`|\b(?:analy[sz]e|investigate|trace|reproduce|root[- ]?cause)\s+why\b` +
    String.raw`|\breproduce\s+(?:(?:the|this|that|these|those|a|an)\s+)?(?:${NON_MODIFIER_GUARD}[a-z0-9_-]+\s+){0,3}(?:${DEFECT_HEAD_NOUN_BODY}|behavior|problem)\b`,
  "i",
)

const DIAGNOSTIC_VERB_RE = /\b(debug|diagnose|troubleshoot|root[- ]?cause)\b/gi
const TOPIC_INTRO_WORDS = new Set([
  "covering", "about", "regarding", "concerning", "discussing",
  "explaining", "documenting", "describing", "detailing", "outlining", "mentioning",
])
const TOPIC_DET_WORDS = new Set(["the", "a", "an", "its", "their", "our", "these", "those", "new", "all"])

function hasTopicIntroBefore(beforeComma: string): boolean {
  const tokens = beforeComma.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  let idx = tokens.length - 1
  while (idx >= 0 && TOPIC_DET_WORDS.has(tokens[idx])) idx--
  return idx >= 0 && TOPIC_INTRO_WORDS.has(tokens[idx])
}

const DEBUG_ATTR_NOUNS = new Set([
  "flag", "flags", "mode", "modes", "option", "options", "output", "outputs",
  "log", "logs", "logging", "level", "levels", "info", "information", "symbol", "symbols",
  "build", "builds", "config", "configs", "configuration", "configurations", "setting", "settings",
  "command", "commands", "menu", "menus", "panel", "panels", "endpoint", "endpoints",
  "header", "headers", "tool", "tools", "tooling", "feature", "features",
  "workflow", "workflows", "guide", "guides", "section", "sections", "chapter", "chapters",
  "doc", "docs", "documentation", "assertion", "assertions", "statement", "statements",
  "print", "prints", "message", "messages", "coverage",
])

function hasDebugAttrNounAfter(after: string): boolean {
  if (!/^\s+/.test(after)) return false
  const tokens = after.trimStart().toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (DEBUG_ATTR_NOUNS.has(tokens[0])) return true
  if (tokens[0] === "and" || tokens[0] === "or") {
    if (DEBUG_ATTR_NOUNS.has(tokens[1] || "")) return true
    if (DEBUG_ATTR_NOUNS.has(tokens[2] || "")) return true
  }
  return false
}

function extractHowToListTail(beforeHard: string): string | null {
  const lower = beforeHard.toLowerCase()
  const idx = lower.lastIndexOf("how to ")
  if (idx === -1) return null
  if (idx > 0 && /[a-z0-9_]/i.test(lower[idx - 1])) return null
  let pos = idx + "how to ".length
  while (pos < lower.length && /\s/.test(lower[pos])) pos++
  const tail = beforeHard.slice(pos)
  if (!tail) return ""
  // Verify tail consists only of `<word>(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)` items
  let rem = tail.toLowerCase()
  while (rem.length > 0) {
    const m = /^([a-z-]+)(,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)/.exec(rem)
    if (!m) return null
    rem = rem.slice(m[0].length)
  }
  return tail
}

function isHowToTopicContinuation(beforeHard: string, word: string, after: string): boolean {
  const tail = extractHowToListTail(beforeHard)
  if (tail === null) return false
  const commaCount = tail.split(",").length - 1
  if (/,\s*(?:and|or)\s+$/i.test(tail) && commaCount < 2) {
    return false
  }
  if (/(?:and|or)\s+[a-z-]+\s*,\s*(?:and|or)\s+$/i.test(tail)) {
    return false
  }
  if (/^\s+(?:(?:the|this|that)\s+)?__DOC_REF__\b/i.test(after)) {
    return false
  }
  const normTail = tail.toLowerCase().replaceAll("-", " ").replace(/\s+/g, " ")
  const normWord = word.toLowerCase().replaceAll("-", " ").replace(/\s+/g, " ")
  if (normTail && new RegExp(String.raw`\b${normWord}\b`).test(normTail)) {
    return false
  }
  return true
}

function hasDebuggingOrDiagnosticIntent(intentText: string): boolean {
  if (DEFECT_ANALYSIS_RE.test(intentText)) return true
  DIAGNOSTIC_VERB_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DIAGNOSTIC_VERB_RE.exec(intentText)) !== null) {
    const idx = m.index
    const word = m[1].toLowerCase()
    const rawPrefix = intentText.slice(0, idx)
    const hardBoundary = Math.max(
      rawPrefix.lastIndexOf("."),
      rawPrefix.lastIndexOf(";"),
      rawPrefix.lastIndexOf("!"),
      rawPrefix.lastIndexOf("\n"),
      rawPrefix.lastIndexOf("("),
    )
    const commaBoundary = Math.max(hardBoundary, rawPrefix.lastIndexOf(","))
    const beforeHard = rawPrefix.slice(hardBoundary + 1)
    const beforeComma = rawPrefix.slice(commaBoundary + 1)
    const after = intentText.slice(idx + m[0].length)
    const isTopicIntro = hasTopicIntroBefore(beforeComma) || isHowToTopicContinuation(beforeHard, word, after)
    const isAttrDebug =
      word === "debug" &&
      (hasDebugAttrNounAfter(after) ||
        (/\b(?:on|about|for)\s+$/i.test(beforeComma) && /^\s*(?:[.,;!?)]|$)/.test(after)))
    if (!isTopicIntro && !isAttrDebug) return true
  }
  return false
}

const CODE_REVIEW_VERBS = new Set(["review", "critique", "audit", "evaluate", "assess", "reviewing", "critiquing", "auditing", "evaluating", "assessing"])
const CODE_TARGET_NOUNS = new Set([
  "pr", "diff", "patch", "commit", "commits", "codebase", "code", "implementation",
  "function", "method", "class", "module", "script", "snippet", "component",
])
const CODE_TARGET_QUALIFIERS = new Set([
  "this", "the", "my", "our", "a", "an",
  "typescript", "ts", "javascript", "js", "python", "py", "rust", "go", "golang",
  "java", "c", "cpp", "c++", "csharp", "c#", "ruby", "php", "swift", "kotlin",
  "scala", "sql", "shell", "bash", "sh", "react", "vue", "node", "helper", "utility",
])

function isPrOrCodeReviewIntent(intentText: string): boolean {
  const norm = intentText.toLowerCase().replace(/\s+/g, " ")
  if (/\b(?:pr|pull request)\s*#?\d+\b/.test(norm) || /\bcode review\b/.test(norm)) return true
  const words = norm.split(/[^a-z0-9#+-]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (!CODE_REVIEW_VERBS.has(words[i])) continue
    let j = i + 1
    let steps = 0
    while (j < words.length && steps < 3 && CODE_TARGET_QUALIFIERS.has(words[j])) {
      j++
      steps++
    }
    const target = words[j] || ""
    const next = words[j + 1] || ""
    if (CODE_TARGET_NOUNS.has(target)) return true
    if (target === "pull" && next === "request") return true
  }
  return false
}

const WRITE_MODIFIERS = new Set([
  "a", "an", "the", "some", "more", "new", "unit", "integration", "e2e", "regression", "smoke", "failing", "automated",
])
const WRITE_TARGETS = new Set(["function", "module", "script", "test", "tests", "code", "patch", "class", "cli"])
const ADD_TARGETS = new Set(["feature", "flag", "endpoint", "test", "option", "command"])
const DOC_MUTATE_VERBS = new Set(["edit", "update", "fix", "modify", "patch", "rewrite"])

function hasImplementOrEditAction(intentText: string): boolean {
  const norm = intentText.toLowerCase().replace(/\s+/g, " ")
  // Match "implement" / "refactor" unless preceded by "how to " or "explains/describes/discusses how to "
  for (const m of norm.matchAll(/\b(implement|refactor)\b/g)) {
    const idx = m.index ?? 0
    const before = norm.slice(Math.max(0, idx - 40), idx)
    if (/\b(?:how\s+to|explains?\s+how\s+to|describes?\s+how\s+to|about\s+how\s+to|covering\s+how\s+to)\s+$/.test(before)) {
      continue
    }
    return true
  }
  if (/\b(?:build\s+(?:a|the)|make\s+tests\s+pass|edit\s+(?:the\s+)?(?:file|code)|update\s+(?:the\s+)?(?:code|docs|readme)|fix\s+(?:this|that|it))\b/.test(norm)) {
    return true
  }
  const words = norm.split(/[^a-z0-9_-]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === "write") {
      let j = i + 1
      let steps = 0
      while (j < words.length && steps < 3 && WRITE_MODIFIERS.has(words[j])) {
        j++
        steps++
      }
      if (WRITE_TARGETS.has(words[j] || "")) return true
    } else if (w === "add" && (words[i + 1] === "a" || words[i + 1] === "the") && ADD_TARGETS.has(words[i + 2] || "")) {
      return true
    } else if (DOC_MUTATE_VERBS.has(w)) {
      let j = i + 1
      if (words[j] === "the" || words[j] === "this" || words[j] === "that" || words[j] === "a" || words[j] === "an") j++
      if (words[j] === "__doc_ref__") return true
      if (words[j] && ["in", "of", "on"].includes(words[j + 1] || "") && words[j + 2] === "__doc_ref__") return true
    }
  }
  return false
}

function hasExplicitLeanAction(routeEvalText: string): boolean {
  const norm = routeEvalText.toLowerCase().replace(/\s+/g, " ")
  if (/\b(?:lean\s*4|lean4|leap-tools)\b/.test(norm)) return true
  for (const m of norm.matchAll(/\b(prove|verify|formalize|formalise|check)\b/g)) {
    const start = (m.index ?? 0) + m[0].length
    const windowText = norm.slice(start, start + 45)
    if (/\bin lean\b/.test(windowText)) return true
  }
  return false
}

function selectRouteDecision(
  signals: DocumentRouteClassification["signals"],
  hasSuppliedDocument: boolean,
): { topology: string; routingReason: string; documentDetected: boolean } {
  if (
    signals.hasSuppliedDocument &&
    signals.hasCritiqueIntent &&
    !signals.rejectedAsPrOrCodeReview &&
    !signals.rejectedAsImplementOrSolve
  ) {
    return {
      topology: "document-review",
      routingReason: "Priority 1: supplied document with critique/assessment intent (checked before Math/Proof).",
      documentDetected: true,
    }
  }
  if (signals.leanExplicit) {
    return {
      topology: "proof",
      routingReason: "Priority 2: explicit Lean 4 formal proof/verification request.",
      documentDetected: hasSuppliedDocument,
    }
  }
  if (signals.mathSignal && signals.massiveOptIn) {
    return {
      topology: "massive-proof",
      routingReason: "Priority 3: math/proof request with explicit large-team opt-in.",
      documentDetected: hasSuppliedDocument,
    }
  }
  if (signals.mathSignal) {
    return {
      topology: "proof",
      routingReason: "Priority 4: mathematical/proof problem-solving request.",
      documentDetected: hasSuppliedDocument,
    }
  }
  if (signals.lightnessSignal) {
    return {
      topology: "small-focused",
      routingReason: "Priority 5: single self-contained change with explicit lightness signal.",
      documentDetected: hasSuppliedDocument,
    }
  }
  if (signals.iterativeSignal) {
    return {
      topology: "iterative-coding",
      routingReason: "Priority 6: single-module bug-fix or TDD loop.",
      documentDetected: hasSuppliedDocument,
    }
  }
  return {
    topology: "distributed-coding",
    routingReason: "Priority 7: default distributed-coding route.",
    documentDetected: hasSuppliedDocument,
  }
}

export function classifyDocumentRoute(rawInput: RouteClassifyInput | string, root: string): DocumentRouteClassification {
  const input: RouteClassifyInput = typeof rawInput === "string" ? { request: rawInput } : rawInput || {}
  const request = typeof input.request === "string" ? input.request : ""
  const doc = input.document && typeof input.document === "object" ? input.document : undefined
  const inputs = Array.isArray(input.inputs) ? input.inputs.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []
  const checkPaths = input.checkPaths !== false

  const { instructionText, hasInlineDoc } = splitInstructionAndInlineDoc(request)

  const hasExplicitDocObj = Boolean(
    doc && (isNonEmptyString(doc.path) || isNonEmptyString(doc.url) || isNonEmptyString(doc.content)),
  )

  const hasDocInputs = inputs.some((entry) => {
    const v = entry.trim()
    if (/^https?:\/\//i.test(v)) return true
    if (!DOC_EXT_RE.test(v)) return false
    return !checkPaths || isContainedRegularFile(root, v).ok
  })

  const hasRequestUrl = URL_TOKEN_RE.test(instructionText)
  URL_TOKEN_RE.lastIndex = 0

  let hasExplicitRequestDocPath = false
  const isSuppliedDocToken = (tok: string): boolean => {
    if (!tok) return false
    if (/^https?:\/\//i.test(tok)) return true
    const hasExplicitPrefix =
      tok.startsWith("/") ||
      tok.startsWith("~/") ||
      tok.startsWith("file://") ||
      tok.startsWith("./") ||
      tok.includes("/")
    if (!hasExplicitPrefix || !DOC_EXT_RE.test(tok)) return false
    return !checkPaths || isContainedRegularFile(root, tok).ok
  }

  const intentText = instructionText.replace(/\S+/g, (rawTok) => {
    const tok = trimToken(rawTok)
    if (!isSuppliedDocToken(tok)) return rawTok
    if (!/^https?:\/\//i.test(tok)) hasExplicitRequestDocPath = true
    return rawTok.replace(tok, "__DOC_REF__")
  })

  const hasSuppliedDocument = hasExplicitDocObj || hasDocInputs || hasRequestUrl || hasExplicitRequestDocPath || hasInlineDoc
  const rejectedAsPrOrCodeReview = isPrOrCodeReviewIntent(intentText)
  const hasImplementOrEditIntent = hasImplementOrEditAction(intentText)
  const hasMathOrSolveIntent =
    /\b(?:solve\s+(?:problem|exercise|question|equation|this|the\s+problem)|answer\s+(?:problem|question|exercise)|prove\s+(?:theorem|lemma|conjecture|proposition|corollary|that\b|the\s+following|it\b)|disprove|find\s+(?:a\s+)?(?:proof|solution|counterexample)\s+(?:for|of|to))\b/i.test(
      intentText,
    )
  const rejectedAsImplementOrSolve =
    hasImplementOrEditIntent || hasMathOrSolveIntent || hasDebuggingOrDiagnosticIntent(intentText)

  const trimmedInstr = instructionText.trim()
  const hasCritiqueIntent =
    (hasExplicitDocObj &&
      (trimmedInstr.length === 0 || /^(?:please\s+)?(?:analy[sz]e|check)(?:\s+(?:this|it))?[.!?]?$/i.test(trimmedInstr))) ||
    STRONG_CRITIQUE_RE.test(intentText) ||
    DOC_TARGETED_ANALYZE_CHECK_RE.test(intentText)

  const routeEvalText = hasInlineDoc ? instructionText : request
  const leanExplicit = hasExplicitLeanAction(routeEvalText)
  const mathSignal =
    /\b(?:prove|theorem|lemma|conjecture|corollary|proposition|open\s+problem|math(?:ematical)?\s+proof|formal\s+proof|solve\s+(?:problem|exercise|question)|infinitely\s+many)\b|[∀∃⊢]|\\begin\{(?:theorem|lemma|proof)\}/i.test(
      routeEvalText,
    )
  const massiveOptIn =
    /\b(?:massive[- ]?proof|very\s+large\s+team|100\+?\s*searchers|very\s+many\s+agents|massively\s+parallel)\b/i.test(
      routeEvalText,
    )
  const lightnessSignal =
    /\b(?:small[- ]?focused|quick\s+fix|small\s+change|tiny\s+fix|minor\s+tweak|keep\s+it\s+cheap|don'?t\s+spin\s+up\s+a\s+big\s+team|single\s+small\s+fix|tweak\s+this\s+one|rename\s+this)\b/i.test(
      routeEvalText,
    )
  const iterativeSignal =
    /\b(?:iterative[- ]?coding|fix\s+(?:the\s+|a\s+)?bug|failing\s+test|make\s+tests\s+pass|tdd|tight\s+loop|single\s+(?:file|module)|unit\s+test)\b/i.test(
      routeEvalText,
    )

  const signals = {
    hasSuppliedDocument,
    hasCritiqueIntent,
    rejectedAsPrOrCodeReview,
    rejectedAsImplementOrSolve,
    leanExplicit,
    mathSignal,
    massiveOptIn,
    lightnessSignal,
    iterativeSignal,
  }

  const decision = selectRouteDecision(signals, hasSuppliedDocument)
  return {
    ...decision,
    signals,
  }
}

function validateShape(
  value: unknown,
  label: string,
  maxDepth: number,
  maxWidth: number,
  perLevelCeiling?: readonly number[],
): { ok: true; shape: number[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: `refused: ${label} must be a non-empty array of positive integers` }
  }
  if (value.length > maxDepth) {
    return { ok: false, error: `refused: ${label} depth ${value.length} exceeds ceiling ${maxDepth}` }
  }
  const shape: number[] = []
  for (let i = 0; i < value.length; i++) {
    const w = value[i]
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1) {
      return { ok: false, error: `refused: ${label}[${i}] must be a positive integer` }
    }
    const levelCap = perLevelCeiling && i < perLevelCeiling.length ? Math.min(maxWidth, perLevelCeiling[i]) : maxWidth
    if (w > levelCap) {
      return { ok: false, error: `refused: ${label}[${i}] width ${w} exceeds ceiling ${levelCap}` }
    }
    if (i > 0 && w > shape[i - 1]) {
      return { ok: false, error: `refused: ${label} must be monotonically non-increasing (${shape[i - 1]} -> ${w})` }
    }
    shape.push(w)
  }
  if (shape.at(-1) !== 1) {
    return { ok: false, error: `refused: ${label} must end in 1 (single adjudicated/reduced output), got ${shape.at(-1)}` }
  }
  return { ok: true, shape }
}

export function validateTreeBounds(input?: {
  maxSegments?: unknown
  reviewTreeShape?: unknown
  synthTreeShape?: unknown
}): { ok: true; bounds: TreeBounds } | { ok: false; error: string } {
  const maxSegmentsRaw = input?.maxSegments === undefined ? DEFAULT_MAX_SEGMENTS : input.maxSegments
  if (typeof maxSegmentsRaw !== "number" || !Number.isInteger(maxSegmentsRaw) || maxSegmentsRaw < 1 || maxSegmentsRaw > MAX_SEGMENTS) {
    return {
      ok: false,
      error: `refused: maxSegments must be an integer between 1 and ${MAX_SEGMENTS}, got ${cleanDocText(maxSegmentsRaw, 32)}`,
    }
  }

  const reviewRaw = input?.reviewTreeShape === undefined ? [...DEFAULT_REVIEW_TREE_SHAPE] : input.reviewTreeShape
  const reviewRes = validateShape(reviewRaw, "reviewTreeShape", MAX_RSA_DEPTH, MAX_RSA_WIDTH, DEFAULT_REVIEW_TREE_SHAPE)
  if (!reviewRes.ok) return reviewRes

  const synthRaw = input?.synthTreeShape === undefined ? [...DEFAULT_SYNTH_TREE_SHAPE] : input.synthTreeShape
  const synthRes = validateShape(synthRaw, "synthTreeShape", MAX_SYNTH_DEPTH, MAX_SYNTH_WIDTH, DEFAULT_SYNTH_TREE_SHAPE)
  if (!synthRes.ok) return synthRes

  return {
    ok: true,
    bounds: {
      maxSegments: maxSegmentsRaw,
      reviewTreeShape: reviewRes.shape,
      synthTreeShape: synthRes.shape,
    },
  }
}

const CREDENTIAL_QUERY_RE = /^(?:token|access_token|auth|api[_-]?key|key|secret|password|passwd|sig|signature)$/i

function redactUrlForDisplay(parsed: URL): string {
  const safe = new URL(parsed.toString())
  safe.username = ""
  safe.password = ""
  for (const k of [...safe.searchParams.keys()]) {
    if (CREDENTIAL_QUERY_RE.test(k)) {
      safe.searchParams.set(k, "[REDACTED]")
    }
  }
  return cleanDocText(safe.toString(), 240)
}

function readPathDocument(
  root: string,
  doc: DocumentInput,
): { ok: true; doc: ResolvedDocument } | { ok: false; error: string } {
  const check = isContainedRegularFile(root, doc.path!)
  if (!check.ok) return check

  let fd: number | undefined
  try {
    const nofollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0
    fd = openSync(check.resolved, fsConstants.O_RDONLY | nofollow)
    const st = fstatSync(fd)
    if (!st.isFile()) {
      return { ok: false, error: "refused: document path is not a regular file" }
    }
    if (st.size > MAX_DOCUMENT_BYTES) {
      return { ok: false, error: `refused: document exceeds ${MAX_DOCUMENT_BYTES} byte limit (${st.size} bytes)` }
    }
    const chunks: Buffer[] = []
    let total = 0
    const buf = Buffer.allocUnsafe(65536)
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      total += n
      if (total > MAX_DOCUMENT_BYTES) {
        return { ok: false, error: `refused: document exceeds ${MAX_DOCUMENT_BYTES} byte limit` }
      }
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    const full = Buffer.concat(chunks, total)
    return {
      ok: true,
      doc: {
        sourceType: "path",
        sourceLabel: cleanDocText(doc.path, 240),
        format: inferFormat(doc.format, check.resolved),
        bufferOrText: full,
        byteLength: full.byteLength,
      },
    }
  } catch (err: any) {
    return { ok: false, error: `refused: could not read document (${cleanDocText(err?.message || err?.code, 120)})` }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

async function readUrlDocument(
  doc: DocumentInput,
  hasContent: boolean,
  fetchUrl: boolean,
): Promise<{ ok: true; doc: ResolvedDocument } | { ok: false; error: string }> {
  let parsed: URL
  try {
    parsed = new URL(doc.url!.trim())
  } catch {
    return { ok: false, error: "refused: invalid document.url" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `refused: unsupported URL protocol "${cleanDocText(parsed.protocol, 16)}" (http/https only)` }
  }

  const displayLabel = redactUrlForDisplay(parsed)
  if (hasContent && doc.content!.trim().length > 0) {
    const byteLength = Buffer.byteLength(doc.content!, "utf8")
    if (byteLength > MAX_INLINE_BYTES) {
      return { ok: false, error: `refused: inline content exceeds ${MAX_INLINE_BYTES} byte limit (${byteLength} bytes)` }
    }
    return {
      ok: true,
      doc: {
        sourceType: "url",
        sourceLabel: displayLabel,
        format: inferFormat(doc.format, displayLabel),
        bufferOrText: doc.content!,
        byteLength,
      },
    }
  }

  if (!fetchUrl) {
    return { ok: false, error: "refused: offline mode refuses live URL fetch unless fetchUrl: true or document.content is supplied" }
  }

  try {
    // SSRF guard: resolve and validate the address before connecting, then pin
    // the connection to that address (no DNS rebinding). Redirects are not
    // followed; a Location is validated so a redirect cannot point at a blocked
    // address.
    const fetched = await safeFetch(parsed.toString(), {
      method: "GET",
      timeoutMs: URL_FETCH_TIMEOUT_MS,
      maxBytes: MAX_DOCUMENT_BYTES,
    })
    if (!fetched.ok) {
      if (fetched.code === "URL_TOO_LARGE") {
        return { ok: false, error: `refused: URL response exceeds ${MAX_DOCUMENT_BYTES} byte limit` }
      }
      if (fetched.code === "URL_BLOCKED_ADDRESS") {
        return { ok: false, error: `refused: URL blocked by SSRF guard (${cleanDocText(fetched.error, 180)})` }
      }
      if (fetched.code === "URL_TIMEOUT") {
        return { ok: false, error: "refused: URL fetch error (timeout)" }
      }
      return { ok: false, error: `refused: URL fetch error (${cleanDocText(fetched.error, 120)})` }
    }
    const status = fetched.status
    if (status >= 300 && status < 400) {
      const location = fetched.headers?.location
      if (location) {
        try {
          const next = new URL(String(location), parsed)
          const target = await assertSafeUrl(next.toString())
          if (!target.ok) {
            return {
              ok: false,
              error: `refused: URL redirect to a blocked address (${cleanDocText(target.error, 160)})`,
            }
          }
        } catch {
          return { ok: false, error: "refused: URL redirect with an invalid Location" }
        }
      }
      return { ok: false, error: `refused: URL redirect (HTTP ${status}) rejected` }
    }
    if (status < 200 || status >= 300) {
      return { ok: false, error: `refused: URL fetch failed with HTTP ${status}` }
    }
    const full = fetched.body ?? Buffer.alloc(0)
    if (full.byteLength > MAX_DOCUMENT_BYTES) {
      return { ok: false, error: `refused: URL response exceeds ${MAX_DOCUMENT_BYTES} byte limit` }
    }
    const ct = String(fetched.headers?.["content-type"] || "")
    return {
      ok: true,
      doc: {
        sourceType: "url",
        sourceLabel: displayLabel,
        format: inferFormat(doc.format, displayLabel, ct),
        bufferOrText: full,
        byteLength: full.byteLength,
      },
    }
  } catch (err: any) {
    return { ok: false, error: `refused: URL fetch error (${cleanDocText(err?.message || err?.name, 120)})` }
  }
}

export async function resolveAndReadDocument(
  root: string,
  doc: DocumentInput | undefined,
  opts: { fetchUrl?: boolean } = {},
): Promise<{ ok: true; doc: ResolvedDocument } | { ok: false; error: string }> {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "refused: document object is required" }
  }

  const hasPath = isNonEmptyString(doc.path)
  const hasUrl = isNonEmptyString(doc.url)
  const hasContent = typeof doc.content === "string"

  if (hasPath && (hasUrl || (hasContent && doc.content!.trim().length > 0))) {
    return { ok: false, error: "refused: document.path cannot be combined with document.url or document.content" }
  }

  if (hasPath) {
    return readPathDocument(root, doc)
  }

  if (hasUrl) {
    return readUrlDocument(doc, hasContent, opts.fetchUrl === true)
  }

  if (hasContent) {
    if (!doc.content!.trim()) {
      return { ok: false, error: "refused: inline document.content is empty" }
    }
    const byteLength = Buffer.byteLength(doc.content!, "utf8")
    if (byteLength > MAX_INLINE_BYTES) {
      return { ok: false, error: `refused: inline document.content exceeds ${MAX_INLINE_BYTES} byte limit (${byteLength} bytes)` }
    }
    return {
      ok: true,
      doc: {
        sourceType: "content",
        sourceLabel: "inline-content",
        format: inferFormat(doc.format, "inline.md"),
        bufferOrText: doc.content!,
        byteLength,
      },
    }
  }

  return { ok: false, error: "refused: document must supply one of path, url, or non-empty content" }
}

const PDF_ESCAPE_BYTES: Record<string, number> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  b: 0x08,
  f: 0x0c,
  "(": 0x28,
  ")": 0x29,
  "\\": 0x5c,
}

function decodePdfLiteralBytes(raw: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== "\\") {
      out.push((raw.codePointAt(i) ?? 0) & 0xff)
      continue
    }
    i++
    if (i >= raw.length) break
    const esc = raw[i]
    const mapped = PDF_ESCAPE_BYTES[esc]
    if (mapped !== undefined) {
      out.push(mapped)
    } else if (esc === "\r") {
      if (raw[i + 1] === "\n") i++
    } else if (esc === "\n") {
      // line continuation: emit nothing
    } else if (esc >= "0" && esc <= "7") {
      let oct = esc
      if (i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i]
      if (i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i]
      out.push(Number.parseInt(oct, 8) & 0xff)
    } else {
      out.push((esc.codePointAt(0) ?? 0) & 0xff)
    }
  }
  return Buffer.from(out)
}

function pdfBytesToText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = ""
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      s += String.fromCodePoint((bytes[i] << 8) | bytes[i + 1])
    }
    return s
  }
  return bytes.toString("latin1")
}

function decodePdfHexString(hex: string): string {
  const cleaned = hex.replace(/\s+/g, "")
  const padded = cleaned.length % 2 === 1 ? cleaned + "0" : cleaned
  if (!padded) return ""
  return pdfBytesToText(Buffer.from(padded, "hex"))
}

function skipPdfWhitespace(streamText: string, pos: number): number {
  let i = pos
  while (i < streamText.length) {
    const c = streamText[i]
    if (c === "%") {
      while (i < streamText.length && streamText[i] !== "\n" && streamText[i] !== "\r") i++
    } else if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0") {
      i++
    } else {
      break
    }
  }
  return i
}

function readPdfLiteralAt(streamText: string, start: number): { text: string; next: number } {
  let i = start + 1
  let depth = 1
  let raw = ""
  while (i < streamText.length && depth > 0) {
    const c = streamText[i]
    if (c === "\\") {
      raw += c
      if (i + 1 < streamText.length) raw += streamText[++i]
      i++
    } else if (c === "(") {
      depth++
      raw += c
      i++
    } else if (c === ")") {
      depth--
      if (depth > 0) raw += c
      i++
    } else {
      raw += c
      i++
    }
  }
  return { text: pdfBytesToText(decodePdfLiteralBytes(raw)), next: i }
}

function readPdfHexAt(streamText: string, start: number): { text: string; next: number } {
  let i = start + 1
  const close = streamText.indexOf(">", i)
  if (close === -1) {
    return { text: decodePdfHexString(streamText.slice(i)), next: streamText.length }
  }
  return { text: decodePdfHexString(streamText.slice(i, close)), next: close + 1 }
}

function readPdfArrayAt(streamText: string, start: number): { text: string; next: number } {
  let i = start + 1
  let arrText = ""
  while (i < streamText.length && streamText[i] !== "]") {
    i = skipPdfWhitespace(streamText, i)
    if (i >= streamText.length || streamText[i] === "]") break
    if (streamText[i] === "(") {
      const lit = readPdfLiteralAt(streamText, i)
      arrText += lit.text
      i = lit.next
    } else if (streamText[i] === "<" && streamText[i + 1] !== "<") {
      const hx = readPdfHexAt(streamText, i)
      arrText += hx.text
      i = hx.next
    } else {
      const prev = i
      let num = ""
      while (i < streamText.length && !/[\s()<>[\]]/.test(streamText[i])) {
        num += streamText[i++]
      }
      if (i === prev) {
        // Advance past unexpected delimiter (e.g. '<<', '>', '(') so loop always terminates
        i++
        continue
      }
      const kerning = Number(num)
      if (Number.isFinite(kerning) && kerning <= -150 && !arrText.endsWith(" ")) {
        arrText += " "
      }
    }
  }
  if (i < streamText.length && streamText[i] === "]") i++
  return { text: arrText, next: i }
}

function applyPdfOperator(tok: string, state: { inTextObj: boolean; recentOperands: string[]; out: string[] }): void {
  if (tok === "BT") {
    state.inTextObj = true
    state.recentOperands = []
    return
  }
  if (tok === "ET") {
    if (state.inTextObj) state.out.push("\n")
    state.inTextObj = false
    state.recentOperands = []
    return
  }
  if (!state.inTextObj) return
  if (tok === "Tj" || tok === "TJ" || tok === "'" || tok === '"') {
    const text = state.recentOperands.pop() || ""
    if (tok === "'" || tok === '"') state.out.push("\n")
    if (text) state.out.push(text)
    state.recentOperands = []
  } else if (tok === "T*" || tok === "Td" || tok === "TD") {
    state.out.push("\n")
    state.recentOperands = []
  } else if (tok === "Tm") {
    if (state.out.length > 0 && !(state.out.at(-1) ?? "").endsWith("\n")) {
      state.out.push("\n")
    }
    state.recentOperands = []
  }
}

function extractTextFromPdfContentStream(streamText: string): string {
  const state = { inTextObj: false, recentOperands: [] as string[], out: [] as string[] }
  let i = 0
  const pushOperand = (val: string) => {
    state.recentOperands.push(val)
    if (state.recentOperands.length > 8) state.recentOperands.shift()
  }

  while (i < streamText.length) {
    i = skipPdfWhitespace(streamText, i)
    if (i >= streamText.length) break
    const c = streamText[i]

    if (c === "(") {
      const lit = readPdfLiteralAt(streamText, i)
      pushOperand(lit.text)
      i = lit.next
    } else if (c === "<" && streamText[i + 1] === "<") {
      i += 2
      state.recentOperands = []
    } else if (c === "<") {
      const hx = readPdfHexAt(streamText, i)
      pushOperand(hx.text)
      i = hx.next
    } else if (c === "[") {
      const arr = readPdfArrayAt(streamText, i)
      pushOperand(arr.text)
      i = arr.next
    } else if (c === ">" && streamText[i + 1] === ">") {
      i += 2
      state.recentOperands = []
    } else {
      let tok = ""
      while (i < streamText.length && !/[\s()<>[\]{}/%]/.test(streamText[i])) {
        tok += streamText[i++]
      }
      if (!tok) {
        i++
      } else {
        applyPdfOperator(tok, state)
      }
    }
  }

  return state.out.join("")
}

function currentStreamIsFlate(latin: string, streamIdx: number): boolean {
  const windowStart = Math.max(0, streamIdx - 512)
  const slice = latin.slice(windowStart, streamIdx)
  // Scope to the current object's dictionary after any preceding `endobj` or `endstream`.
  const afterEndObj = Math.max(slice.lastIndexOf("endobj"), slice.lastIndexOf("endstream"))
  const currentDict = afterEndObj !== -1 ? slice.slice(afterEndObj) : slice
  const openDict = currentDict.lastIndexOf("<<")
  const dictBody = openDict !== -1 ? currentDict.slice(openDict) : currentDict
  return /\/FlateDecode\b/.test(dictBody)
}

function inflatePdfStream(rawBytes: Buffer, isFlate: boolean): Buffer | undefined {
  if (!isFlate) return rawBytes
  try {
    return inflateSync(rawBytes, { maxOutputLength: MAX_PDF_INFLATE_BYTES })
  } catch {
    try {
      return inflateRawSync(rawBytes, { maxOutputLength: MAX_PDF_INFLATE_BYTES })
    } catch {
      return undefined
    }
  }
}

function extractPdfTextPureNode(buf: Buffer): string {
  const latin = buf.toString("latin1")
  const chunks: string[] = []
  let totalChars = 0
  let pos = 0

  while (pos < latin.length && totalChars < MAX_TEXT_MAP_CHARS) {
    const streamIdx = latin.indexOf("stream", pos)
    if (streamIdx === -1) break

    const before = streamIdx > 0 ? latin[streamIdx - 1] : "\n"
    if (!/[\s>]/.test(before)) {
      pos = streamIdx + 6
      continue
    }

    let dataStart = streamIdx + 6
    if (latin[dataStart] === "\r" && latin[dataStart + 1] === "\n") dataStart += 2
    else if (latin[dataStart] === "\n") dataStart += 1
    else {
      pos = streamIdx + 6
      continue
    }

    const endIdx = latin.indexOf("endstream", dataStart)
    if (endIdx === -1) break

    let dataEnd = endIdx
    if (dataEnd >= dataStart + 2 && latin[dataEnd - 2] === "\r" && latin[dataEnd - 1] === "\n") dataEnd -= 2
    else if (dataEnd >= dataStart + 1 && (latin[dataEnd - 1] === "\n" || latin[dataEnd - 1] === "\r")) dataEnd -= 1

    const isFlate = currentStreamIsFlate(latin, streamIdx)
    const streamBytes = inflatePdfStream(buf.subarray(dataStart, dataEnd), isFlate)
    if (streamBytes && streamBytes.length > 0) {
      const contentStr = streamBytes.toString("latin1")
      if (contentStr.includes("BT") && contentStr.includes("ET")) {
        const extracted = extractTextFromPdfContentStream(contentStr).trim()
        if (extracted) {
          chunks.push(extracted)
          totalChars += extracted.length
        }
      }
    }

    pos = endIdx + 9
  }

  return chunks.join("\n\n")
}

function removeHtmlTagBlock(text: string, tagName: string): string {
  let out = text
  const lowerTag = `<${tagName}`
  const closePrefix = `</${tagName}`
  while (true) {
    const lower = out.toLowerCase()
    const open = lower.indexOf(lowerTag)
    if (open === -1) break
    const afterOpen = lower[open + lowerTag.length] || ""
    if (afterOpen && !/[\s>/]/.test(afterOpen)) {
      out = out.slice(0, open) + " " + out.slice(open + lowerTag.length)
      continue
    }
    const closeIdx = lower.indexOf(closePrefix, open + lowerTag.length)
    if (closeIdx === -1) {
      out = out.slice(0, open)
      break
    }
    const closeEnd = lower.indexOf(">", closeIdx + closePrefix.length)
    if (closeEnd === -1) {
      out = out.slice(0, open)
      break
    }
    out = out.slice(0, open) + " " + out.slice(closeEnd + 1)
  }
  return out
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
}

function stripBasicHtml(html: string): string {
  let text = removeHtmlTagBlock(html, "script")
  text = removeHtmlTagBlock(text, "style")
  text = text
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote)\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>\r\n]{1,500}>/g, " ")
  // Single-pass entity decoding prevents double-unescaping (CodeQL js/double-escaping)
  return text.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (m) => HTML_ENTITY_MAP[m.toLowerCase()] ?? m)
}

const SAFE_PDFTOTEXT_BINS = ["/usr/bin/pdftotext", "/usr/local/bin/pdftotext", "/opt/homebrew/bin/pdftotext"]

function tryPdftotextFallback(buf: Buffer): string {
  for (const bin of SAFE_PDFTOTEXT_BINS) {
    try {
      const st = lstatSync(bin)
      if (!st.isFile() && !st.isSymbolicLink()) continue
      const cliOut = execFileSync(bin, ["-", "-"], {
        input: buf,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: MAX_PDF_INFLATE_BYTES,
        stdio: ["pipe", "pipe", "pipe"],
      })
      if (cliOut?.trim()) {
        return cliOut.replaceAll("\r\n", "\n").trim()
      }
    } catch {
      // Binary absent or failed — continue
    }
  }
  return ""
}

// A7 PDF pre-flight: image-only PDFs need a real renderer. pypdfium2 renders
// each page; Pillow is the raster dependency the extractor is allowed to use.
// The script is a constant and reads the document bytes from stdin, so no path
// or caller text is ever interpolated into Python source.
const PYTHON_PDF_SCRIPT = [
  "import sys, json",
  "try:",
  "    import pypdfium2 as pdfium",
  "    from PIL import Image  # noqa: F401",
  "except Exception as exc:",
  '    print(json.dumps({"ok": False, "status": "MISSING", "detail": "pypdfium2/Pillow import failed: %s" % (exc,)}))',
  "    raise SystemExit(0)",
  "try:",
  "    payload = sys.stdin.buffer.read()",
  "    document = pdfium.PdfDocument(payload)",
  "except Exception as exc:",
  '    print(json.dumps({"ok": False, "status": "OUTAGE", "detail": "PDF open failed: %s" % (exc,)}))',
  "    raise SystemExit(0)",
  "pages = []",
  "for index in range(len(document)):",
  "    text = ''",
  "    try:",
  "        page = document[index]",
  "        text_page = page.get_textpage()",
  "        text = text_page.get_text_range()",
  "    except Exception:",
  "        text = ''",
  "    pages.append(text or '')",
  'print(json.dumps({"ok": True, "pages": pages}))',
].join("\n")

export type PdfPythonIngestResult =
  | { ok: true; text: string }
  | { ok: false; status: "MISSING" | "OUTAGE"; detail: string }

/**
 * Ingest an image-only PDF with `python3` + pypdfium2 + Pillow. The executable
 * is resolved through the trusted-directory resolver (never a raw PATH join);
 * the PDF bytes go in on stdin and a single JSON line comes back on stdout.
 * Any failure is classified: an import failure is MISSING, an engine/runtime
 * failure or empty extraction is OUTAGE. The caller records PREREQUISITES.md.
 */
export function ingestPdfWithPython(
  buf: Buffer,
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): PdfPythonIngestResult {
  const env = options?.env ?? process.env
  // A probe must reflect the PATH the caller narrowed (tests and hardened
  // hosts), so no silent fallback to /usr/bin when that PATH lacks python3.
  const python = resolveTrustedExecutable("python3", {
    env: { PATH: env.PATH, PATHEXT: env.PATHEXT },
    fallbackToStandard: false,
  })
  if (!python) {
    return { ok: false, status: "MISSING", detail: "python3 was not found on a trusted PATH entry" }
  }
  let stdout = ""
  let stderr = ""
  try {
    stdout = execFileSync(python, ["-c", PYTHON_PDF_SCRIPT], {
      input: buf,
      encoding: "utf8",
      timeout: Math.max(1000, Math.min(30000, Number(options?.timeoutMs) || 10000)),
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    })
  } catch (err: any) {
    stderr = String(err?.stderr ?? "")
    stdout = String(err?.stdout ?? "")
    const detail = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || cleanPdfDetail(err?.message) || "python3 PDF extraction failed"
    if (err?.code === "ETIMEDOUT") {
      return { ok: false, status: "OUTAGE", detail: "python3 PDF extraction timed out" }
    }
    const missingDep = /ModuleNotFoundError|No module named|ImportError/i.test(`${stderr}\n${stdout}`)
    return { ok: false, status: missingDep ? "MISSING" : "OUTAGE", detail }
  }
  const jsonLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop()
  let parsed: any
  try {
    parsed = JSON.parse(jsonLine ?? "")
  } catch {
    return { ok: false, status: "OUTAGE", detail: "python3 returned an unrecognised PDF extraction payload" }
  }
  if (parsed?.ok !== true || !Array.isArray(parsed?.pages)) {
    const status = parsed?.status === "MISSING" ? "MISSING" : "OUTAGE"
    return { ok: false, status, detail: cleanPdfDetail(parsed?.detail) || "pypdfium2 could not extract text from the PDF" }
  }
  const text = parsed.pages
    .filter((page: unknown): page is string => typeof page === "string")
    .join("\n\n")
    .replaceAll("\r\n", "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!text) {
    return { ok: false, status: "OUTAGE", detail: "pypdfium2 extracted no text from any page" }
  }
  return { ok: true, text: cleanDocBlock(text, MAX_TEXT_MAP_CHARS) }
}

function cleanPdfDetail(value: unknown): string {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
}

export function ingestDocument(
  bufferOrText: Buffer | string,
  formatHint?: string,
): IngestedDocument | { ok: false; error: string } {
  const format = inferFormat(formatHint)

  if (format === "pdf") {
    const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(bufferOrText, "latin1")
    const header = buf.subarray(0, 16).toString("latin1").trimStart()
    if (!header.startsWith("%PDF-")) {
      return { ok: false, error: "refused: corrupt or forged PDF (missing %PDF- header)" }
    }

    let extracted = extractPdfTextPureNode(buf)
      .replaceAll("\r\n", "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()

    if (!extracted) {
      extracted = tryPdftotextFallback(buf)
    }

    if (!extracted) {
      return {
        ok: true,
        format: "pdf",
        text: "",
        extractionStatus: "needs_ingestor",
        warning: "PDF yielded no extractable text (image-only or unsupported encoding); external PDF/OCR ingestor required.",
      }
    }

    return {
      ok: true,
      format: "pdf",
      text: cleanDocBlock(extracted, MAX_TEXT_MAP_CHARS),
      extractionStatus: "extracted",
    }
  }

  let text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString("utf8") : String(bufferOrText)
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  if (format === "html") {
    text = stripBasicHtml(text)
  }
  const normalized = cleanDocBlock(text, MAX_TEXT_MAP_CHARS).trim()
  if (!normalized) {
    return { ok: false, error: "refused: document contains no readable text" }
  }

  return {
    ok: true,
    format,
    text: normalized,
    extractionStatus: "extracted",
  }
}

interface RawSection {
  title: string
  body: string
}

function splitLargeSection(title: string, body: string): RawSection[] {
  if (body.length <= MAX_SEGMENT_CHARS) return [{ title, body }]
  const out: RawSection[] = []
  const paragraphs = body.split(/\n{2,}/)
  let buf = ""
  let part = 1

  const flush = () => {
    if (!buf.trim()) return
    out.push({ title: `${title} (part ${part})`, body: buf.trim() })
    part++
    buf = ""
  }

  for (const para of paragraphs) {
    if (para.length > MAX_SEGMENT_CHARS) {
      flush()
      for (let i = 0; i < para.length; i += MAX_SEGMENT_CHARS) {
        out.push({
          title: `${title} (part ${part})`,
          body: para.slice(i, i + MAX_SEGMENT_CHARS),
        })
        part++
      }
      continue
    }
    const candidate = buf ? `${buf}\n\n${para}` : para
    if (candidate.length > MAX_SEGMENT_CHARS) {
      flush()
      buf = para
    } else {
      buf = candidate
    }
  }
  flush()
  return out
}

function parseLineHeading(line: string): string | null {
  if (line.startsWith("#")) {
    let hashes = 0
    while (hashes < line.length && line[hashes] === "#") hashes++
    if (hashes >= 1 && hashes <= 3 && (line[hashes] === " " || line[hashes] === "\t")) {
      const rest = line.slice(hashes).trim()
      if (rest) return cleanDocText(rest, 120) || "Untitled Section"
    }
  }
  const trimmed = line.trim()
  const latexMatch = /^\\(?:part|chapter|section|subsection)\*?\{([^}]{1,200})\}/.exec(trimmed)
  if (latexMatch) {
    return cleanDocText(latexMatch[1].trim(), 120) || "Untitled Section"
  }
  return null
}

function extractRawSections(trimmed: string): RawSection[] {
  const lines = trimmed.split("\n")
  const rawSections: RawSection[] = []
  let currentTitle = "Document Preamble"
  let currentLines: string[] = []

  for (const line of lines) {
    const nextHeading = parseLineHeading(line)
    if (nextHeading !== null) {
      const body = currentLines.join("\n").trim()
      if (body) rawSections.push({ title: currentTitle, body })
      currentTitle = nextHeading
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  const tailBody = currentLines.join("\n").trim()
  if (tailBody) rawSections.push({ title: currentTitle, body: tailBody })

  if (rawSections.length <= 1 && trimmed.length > 1200) {
    const paras = trimmed.split(/\n{2,}/).filter((p) => p.trim().length > 0)
    if (paras.length > 1) {
      return paras.map((p, idx) => ({
        title: cleanDocText(p.split("\n")[0] || `Section ${idx + 1}`, 80),
        body: p.trim(),
      }))
    }
  }
  return rawSections
}

function formatGroupTitle(group: RawSection[]): string {
  if (group.length === 1) return group[0].title
  return cleanDocText(`${group[0].title} … ${(group.at(-1) ?? group[0]).title}`, 120)
}

function packSizedSections(sizedSections: RawSection[], limit: number): RawSection[] {
  if (sizedSections.length <= limit) return sizedSections
  const totalChars = sizedSections.reduce((acc, s) => acc + s.body.length, 0)
  const targetPerSeg = Math.max(1, Math.floor(totalChars / limit))
  const packed: RawSection[] = []
  let curGroup: RawSection[] = []
  let curLen = 0

  for (let i = 0; i < sizedSections.length; i++) {
    const sec = sizedSections[i]
    const remainingSections = sizedSections.length - i
    const remainingSlots = limit - packed.length
    const nextLen = curLen + (curGroup.length ? 2 : 0) + sec.body.length
    const mustReserveSlots = curGroup.length > 0 && remainingSlots > 1 && remainingSections <= remainingSlots - 1
    const shouldSplit =
      curGroup.length > 0 &&
      (mustReserveSlots ||
        (remainingSlots > 1 && (nextLen > MAX_SEGMENT_CHARS || (curLen >= targetPerSeg && remainingSections >= remainingSlots))) ||
        nextLen > MAX_SEGMENT_CHARS)

    if (shouldSplit) {
      packed.push({ title: formatGroupTitle(curGroup), body: curGroup.map((g) => g.body).join("\n\n").slice(0, MAX_SEGMENT_CHARS) })
      curGroup = [sec]
      curLen = sec.body.length
    } else {
      curGroup.push(sec)
      curLen = nextLen
    }
  }
  if (curGroup.length > 0) {
    packed.push({ title: formatGroupTitle(curGroup), body: curGroup.map((g) => g.body).join("\n\n").slice(0, MAX_SEGMENT_CHARS) })
  }

  // Rebalance adjacent buckets within MAX_SEGMENT_CHARS when packed exceeds limit
  while (packed.length > limit) {
    let mergedIdx = -1
    let bestCombined = Infinity
    for (let k = 0; k + 1 < packed.length; k++) {
      const combinedLen = packed[k].body.length + 2 + packed[k + 1].body.length
      if (combinedLen <= MAX_SEGMENT_CHARS && combinedLen < bestCombined) {
        bestCombined = combinedLen
        mergedIdx = k
      }
    }
    if (mergedIdx !== -1) {
      const a = packed[mergedIdx]
      const b = packed[mergedIdx + 1]
      packed.splice(mergedIdx, 2, {
        title: cleanDocText(`${a.title} … ${b.title}`, 120),
        body: `${a.body}\n\n${b.body}`,
      })
    } else {
      const last = packed.pop()!
      const prev = packed.at(-1)!
      prev.title = cleanDocText(`${prev.title} … ${last.title}`, 120)
      prev.body = `${prev.body}\n\n${last.body}`.slice(0, MAX_SEGMENT_CHARS)
    }
  }
  return packed
}

export function segmentDocument(text: string, maxSegments = DEFAULT_MAX_SEGMENTS): DocumentSegment[] {
  const limit = Math.max(1, Math.min(MAX_SEGMENTS, Math.floor(maxSegments || DEFAULT_MAX_SEGMENTS)))
  const trimmed = text.trim()
  if (!trimmed) {
    return [
      {
        id: "seg-01",
        title: "Unextracted Document Content",
        charCount: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        content: "",
      },
    ]
  }

  const sections = extractRawSections(trimmed)
  const sizedSections: RawSection[] = []
  for (const sec of sections) {
    sizedSections.push(...splitLargeSection(sec.title, sec.body))
  }
  const packed = packSizedSections(sizedSections, limit)

  return packed.map((sec, idx) => {
    const id = `seg-${String(idx + 1).padStart(2, "0")}`
    const content = cleanDocBlock(sec.body, MAX_SEGMENT_CHARS)
    return {
      id,
      title: cleanDocText(sec.title, 120) || `Segment ${idx + 1}`,
      charCount: content.length,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      content,
    }
  })
}
