// @heretek-ai/opencode-teamwork-v2 — Document Review route engine module
//
// Zero runtime dependencies (Node built-ins only) and strictly erasable
// TypeScript syntax compatible with Node 22+ native type-stripping (no enum,
// no namespace, no constructor parameter properties).

import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { inflateRawSync, inflateSync } from "node:zlib"

export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
export const MAX_INLINE_BYTES = 512 * 1024
export const MAX_SEGMENTS = 8
export const DEFAULT_MAX_SEGMENTS = 6
export const MAX_RSA_DEPTH = 3
export const MAX_RSA_WIDTH = 4
export const DEFAULT_REVIEW_TREE_SHAPE = [4, 2, 1] as const
export const MAX_SYNTH_DEPTH = 2
export const MAX_SYNTH_WIDTH = 4
export const DEFAULT_SYNTH_TREE_SHAPE = [4, 1] as const
export const MAX_SEGMENT_CHARS = 32_000
export const MAX_TEXT_MAP_CHARS = 200_000
export const MAX_FINDINGS = 50
export const URL_FETCH_TIMEOUT_MS = 3000
export const MAX_PDF_INFLATE_BYTES = 4 * 1024 * 1024

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

export interface RouteClassification {
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

export function cleanDocText(value: unknown, max = 64): string {
  return String(value ?? "")
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
    .slice(0, max)
}

export function cleanDocBlock(value: unknown, max = 2000): string {
  const s = String(value ?? "").replace(/[\r\t\x00-\x09\x0b-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s
}

export function isSafeSegmentId(id: unknown): id is string {
  return typeof id === "string" && SEGMENT_ID.test(id) && id !== "." && id !== ".."
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

function trimToken(token: string): string {
  return token.replace(/^[([`"'<]+/, "").replace(/[)\]`"'>,.;:!?]+$/, "")
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
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) {
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
    if (!parentRel || parentRel.startsWith("..") || isAbsolute(parentRel)) {
      if (parent === absRoot) break
      break
    }
    cur = parent
  }

  try {
    const realRoot = realpathSync(absRoot)
    const realTarget = realpathSync(target)
    const realRel = relative(realRoot, realTarget)
    if (!realRel || isAbsolute(realRel) || realRel.startsWith("..")) {
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

function splitInstructionAndInlineDoc(request: string): { instructionText: string; hasInlineDoc: boolean } {
  let hasInlineDoc = false
  let working = request

  // 1. <<<DOCUMENT ... >>>
  const docTagMatches = [...working.matchAll(/<<<DOCUMENT\b[\s\S]*?>>>/gi)]
  if (docTagMatches.some((m) => m[0].replace(/<<<DOCUMENT|>>>/gi, "").trim().length >= 20)) {
    hasInlineDoc = true
    working = working.replace(/<<<DOCUMENT\b[\s\S]*?>>>/gi, " ")
  }

  // 2. Fenced code/document block >= 120 chars
  const fenceMatches = [...working.matchAll(/```[^\n]*\r?\n([\s\S]*?)```/g)]
  if (fenceMatches.some((m) => m[1].trim().length >= 120)) {
    hasInlineDoc = true
    working = working.replace(/```[^\n]*\r?\n[\s\S]*?```/g, " ")
  }

  // 3. Multi-line structured document >= 240 chars with headings or LaTeX structure
  if (!hasInlineDoc && working.length >= 240) {
    const lines = working.split(/\r?\n/)
    const hasHeading = /^#{1,3}\s+\S/m.test(working)
    const hasLatexDoc = /\\(?:part|chapter|section|subsection)\*?\{|\\begin\{(?:theorem|lemma|abstract|document)\}/.test(working)
    if (lines.length >= 3 && (hasHeading || hasLatexDoc)) {
      hasInlineDoc = true
      // Keep the leading non-heading instruction lines before the first heading/section
      const firstStructIdx = working.search(/(?:^|\n)(?:#{1,3}\s+\S|\\(?:part|chapter|section|subsection)\*?\{|\\begin\{(?:theorem|lemma|abstract|document)\})/)
      if (firstStructIdx > 0) {
        working = working.slice(0, firstStructIdx)
      } else {
        // Inline doc starts at line 0: preserve trailing non-structural instruction
        // lines/paragraph (e.g., "\n\nPlease critique this paper.") or text after \end{document}.
        const endDocMatch = [...working.matchAll(/\\end\{document\}/gi)].pop()
        if (endDocMatch && endDocMatch.index !== undefined) {
          working = working.slice(endDocMatch.index + endDocMatch[0].length).trim()
        } else {
          const paras = working
            .split(/\r?\n\s*\r?\n/)
            .map((p) => p.trim())
            .filter(Boolean)
          const lastPara = paras.length >= 2 ? paras[paras.length - 1] : ""
          const isStructPara =
            /^(?:#{1,3}\s+\S|\\(?:part|chapter|section|subsection)\*?\{|\\(?:begin|end)\{(?:theorem|lemma|abstract|document)\})/m.test(
              lastPara,
            )
          working = lastPara && !isStructPara ? lastPara : ""
        }
      }
    }
  }

  return { instructionText: working, hasInlineDoc }
}

export function classifyRoute(rawInput: RouteClassifyInput | string, root: string): RouteClassification {
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
    if (!checkPaths) return true
    return isContainedRegularFile(root, v).ok
  })

  const hasRequestUrl = URL_TOKEN_RE.test(instructionText)
  URL_TOKEN_RE.lastIndex = 0

  let hasExplicitRequestDocPath = false
  for (const rawTok of instructionText.split(/\s+/)) {
    const tok = trimToken(rawTok)
    if (!tok || /^https?:\/\//i.test(tok)) continue
    const hasExplicitPrefix =
      tok.startsWith("/") ||
      tok.startsWith("~/") ||
      tok.startsWith("file://") ||
      tok.startsWith("./") ||
      tok.includes("/")
    if (!hasExplicitPrefix || !DOC_EXT_RE.test(tok)) continue
    if (!checkPaths) {
      hasExplicitRequestDocPath = true
      break
    }
    if (isContainedRegularFile(root, tok).ok) {
      hasExplicitRequestDocPath = true
      break
    }
  }

  const hasSuppliedDocument = hasExplicitDocObj || hasDocInputs || hasRequestUrl || hasExplicitRequestDocPath || hasInlineDoc

  // Negative Trigger Guard A: PR / pull request / diff / patch / code review
  const rejectedAsPrOrCodeReview =
    /\b(?:review\s+(?:this|the|my|our|a)?\s*(?:pr|pull\s+request|diff|patch|commit|commits|codebase|code)|pr\s*#?\d+|pull\s+request\s*#?\d+|code\s+review|reviewing\s+(?:this|the)\s+(?:pr|diff|patch|code))\b/i.test(
      instructionText,
    )

  // Negative Trigger Guard B: primary deliverable is implementing, fixing/analyzing/debugging a bug, or solving/proving a problem
  const rejectedAsImplementOrSolve =
    /\b(?:implement|fix\s+(?:the\s+|this\s+|a\s+)?bug|fix\s+this|(?:analy[sz]e|investigate|debug|diagnose|troubleshoot|trace|reproduce)\s+(?:the\s+|this\s+|a\s+|an\s+)?(?:bug|issue|error|crash|failure|regression|exception|defect)|debug|diagnose|troubleshoot|refactor|write\s+(?:a\s+|the\s+)?(?:function|module|script|test|code|patch|class|cli)|build\s+(?:a|the)|add\s+(?:a|the)\s+(?:feature|flag|endpoint|test|option|command)|make\s+tests\s+pass|edit\s+(?:the\s+)?(?:file|code)|update\s+(?:the\s+)?(?:code|docs|readme)|solve\s+(?:problem|exercise|question|equation|this|the\s+problem)|answer\s+(?:problem|question|exercise)|prove\s+(?:theorem|lemma|conjecture|proposition|corollary|that\b|the\s+following|it\b)|disprove|find\s+(?:a\s+)?(?:proof|solution|counterexample)\s+(?:for|of|to))\b/i.test(
      instructionText,
    )

  // Positive critique/assessment intent
  const hasCritiqueIntent =
    (hasExplicitDocObj && instructionText.trim().length === 0) ||
    /\b(?:review|critique|assess|evaluate|audit|referee|peer[- ]?review|analy[sz]e|summari[sz]e|what\s+does\s+(?:this|the)\s+(?:paper|document|doc|preprint|manuscript|rfc|draft)\s+say|check\s+(?:this|the)\s+(?:paper|document|doc|preprint|manuscript|rfc|draft|design\s+doc))\b/i.test(
      instructionText,
    )

  // Priority 2+: other route signals evaluated on full instruction (or request if not inline doc)
  const routeEvalText = hasInlineDoc ? instructionText : request

  const leanExplicit =
    /\b(?:lean\s*4|lean4|leap-tools|(?:prove|verify|formalize|formalise|check)\s+(?:this|the|a|an)?\s*[\w\s]{0,30}\bin\s+lean)\b/i.test(
      routeEvalText,
    )
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

  // Priority 1: Document Review (MUST be checked BEFORE Lean/LEMMA, massive-proof, and proof)
  if (hasSuppliedDocument && hasCritiqueIntent && !rejectedAsPrOrCodeReview && !rejectedAsImplementOrSolve) {
    return {
      topology: "document-review",
      routingReason: "Priority 1: supplied document with critique/assessment intent (checked before Math/Proof).",
      documentDetected: true,
      signals,
    }
  }

  // Priority 2: Explicit Lean 4 formal proof/verification request
  if (leanExplicit) {
    return {
      topology: "proof",
      routingReason: "Priority 2: explicit Lean 4 formal proof/verification request.",
      documentDetected: hasSuppliedDocument,
      signals,
    }
  }

  // Priority 3: Math/proof with explicit massive-team opt-in
  if (mathSignal && massiveOptIn) {
    return {
      topology: "massive-proof",
      routingReason: "Priority 3: math/proof request with explicit large-team opt-in.",
      documentDetected: hasSuppliedDocument,
      signals,
    }
  }

  // Priority 4: Math/proof without large-team opt-in
  if (mathSignal) {
    return {
      topology: "proof",
      routingReason: "Priority 4: mathematical/proof problem-solving request.",
      documentDetected: hasSuppliedDocument,
      signals,
    }
  }

  // Priority 5: Explicit lightness signal
  if (lightnessSignal) {
    return {
      topology: "small-focused",
      routingReason: "Priority 5: single self-contained change with explicit lightness signal.",
      documentDetected: hasSuppliedDocument,
      signals,
    }
  }

  // Priority 6: Single-module TDD / bug-fix loop
  if (iterativeSignal) {
    return {
      topology: "iterative-coding",
      routingReason: "Priority 6: single-module bug-fix or TDD loop.",
      documentDetected: hasSuppliedDocument,
      signals,
    }
  }

  // Priority 7: General catch-all
  return {
    topology: "distributed-coding",
    routingReason: "Priority 7: default distributed-coding route.",
    documentDetected: hasSuppliedDocument,
    signals,
  }
}

function validateShape(
  value: unknown,
  label: string,
  maxDepth: number,
  maxWidth: number,
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
    if (w > maxWidth) {
      return { ok: false, error: `refused: ${label}[${i}] width ${w} exceeds ceiling ${maxWidth}` }
    }
    if (i > 0 && w > shape[i - 1]) {
      return { ok: false, error: `refused: ${label} must be monotonically non-increasing (${shape[i - 1]} -> ${w})` }
    }
    shape.push(w)
  }
  if (shape[shape.length - 1] !== 1) {
    return { ok: false, error: `refused: ${label} must end in 1 (single adjudicated/reduced output), got ${shape[shape.length - 1]}` }
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
  const reviewRes = validateShape(reviewRaw, "reviewTreeShape", MAX_RSA_DEPTH, MAX_RSA_WIDTH)
  if (!reviewRes.ok) return reviewRes

  const synthRaw = input?.synthTreeShape === undefined ? [...DEFAULT_SYNTH_TREE_SHAPE] : input.synthTreeShape
  const synthRes = validateShape(synthRaw, "synthTreeShape", MAX_SYNTH_DEPTH, MAX_SYNTH_WIDTH)
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

  if (hasUrl) {
    let parsed: URL
    try {
      parsed = new URL(doc.url!.trim())
    } catch {
      return { ok: false, error: "refused: invalid document.url" }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `refused: unsupported URL protocol "${cleanDocText(parsed.protocol, 16)}" (http/https only)` }
    }

    if (hasContent && doc.content!.trim().length > 0) {
      const byteLength = Buffer.byteLength(doc.content!, "utf8")
      if (byteLength > MAX_INLINE_BYTES) {
        return { ok: false, error: `refused: inline content exceeds ${MAX_INLINE_BYTES} byte limit (${byteLength} bytes)` }
      }
      return {
        ok: true,
        doc: {
          sourceType: "url",
          sourceLabel: cleanDocText(parsed.toString(), 240),
          format: inferFormat(doc.format, parsed.toString()),
          bufferOrText: doc.content!,
          byteLength,
        },
      }
    }

    if (opts.fetchUrl !== true) {
      return { ok: false, error: "refused: offline mode refuses live URL fetch unless fetchUrl: true or document.content is supplied" }
    }

    try {
      const res = await fetch(parsed.toString(), {
        method: "GET",
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
        redirect: "manual",
      })
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, error: `refused: URL redirect (HTTP ${res.status}) rejected` }
      }
      if (!res.ok) {
        return { ok: false, error: `refused: URL fetch failed with HTTP ${res.status}` }
      }
      const clHeader = res.headers.get("content-length")
      if (clHeader) {
        const cl = Number(clHeader)
        if (Number.isFinite(cl) && cl > MAX_DOCUMENT_BYTES) {
          return { ok: false, error: `refused: URL response exceeds ${MAX_DOCUMENT_BYTES} byte limit` }
        }
      }
      const chunks: Buffer[] = []
      let total = 0
      if (res.body) {
        const reader = res.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            if (total > MAX_DOCUMENT_BYTES) {
              try {
                await reader.cancel()
              } catch {}
              return { ok: false, error: `refused: URL response exceeds ${MAX_DOCUMENT_BYTES} byte limit` }
            }
            chunks.push(Buffer.from(value))
          }
        }
      }
      const full = Buffer.concat(chunks, total)
      const ct = res.headers.get("content-type") || ""
      return {
        ok: true,
        doc: {
          sourceType: "url",
          sourceLabel: cleanDocText(parsed.toString(), 240),
          format: inferFormat(doc.format, parsed.toString(), ct),
          bufferOrText: full,
          byteLength: full.byteLength,
        },
      }
    } catch (err: any) {
      return { ok: false, error: `refused: URL fetch error (${cleanDocText(err?.message || err?.name, 120)})` }
    }
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

function decodePdfLiteralBytes(raw: string): Buffer {
  const out: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== "\\") {
      out.push(raw.charCodeAt(i) & 0xff)
      continue
    }
    i++
    if (i >= raw.length) break
    const esc = raw[i]
    if (esc === "n") out.push(0x0a)
    else if (esc === "r") out.push(0x0d)
    else if (esc === "t") out.push(0x09)
    else if (esc === "b") out.push(0x08)
    else if (esc === "f") out.push(0x0c)
    else if (esc === "(" || esc === ")" || esc === "\\") out.push(esc.charCodeAt(0))
    else if (esc === "\r") {
      if (raw[i + 1] === "\n") i++
    } else if (esc === "\n") {
      // line continuation: emit nothing
    } else if (esc >= "0" && esc <= "7") {
      let oct = esc
      if (i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i]
      if (i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i]
      out.push(parseInt(oct, 8) & 0xff)
    } else {
      out.push(esc.charCodeAt(0) & 0xff)
    }
  }
  return Buffer.from(out)
}

function pdfBytesToText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = ""
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
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

function extractTextFromPdfContentStream(streamText: string): string {
  const out: string[] = []
  let i = 0
  let inTextObj = false

  const skipWhitespaceAndComments = () => {
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
  }

  const readLiteralString = (): string => {
    // Assumes streamText[i] === '('
    i++
    let depth = 1
    let raw = ""
    while (i < streamText.length && depth > 0) {
      const c = streamText[i]
      if (c === "\\") {
        raw += c
        if (i + 1 < streamText.length) raw += streamText[++i]
        i++
        continue
      }
      if (c === "(") {
        depth++
        raw += c
        i++
        continue
      }
      if (c === ")") {
        depth--
        if (depth === 0) {
          i++
          break
        }
        raw += c
        i++
        continue
      }
      raw += c
      i++
    }
    return pdfBytesToText(decodePdfLiteralBytes(raw))
  }

  const readHexString = (): string => {
    // Assumes streamText[i] === '<' and not '<<'
    i++
    let hex = ""
    while (i < streamText.length && streamText[i] !== ">") {
      hex += streamText[i++]
    }
    if (i < streamText.length && streamText[i] === ">") i++
    return decodePdfHexString(hex)
  }

  let recentOperands: string[] = []

  while (i < streamText.length) {
    skipWhitespaceAndComments()
    if (i >= streamText.length) break
    const c = streamText[i]

    if (c === "(") {
      recentOperands.push(readLiteralString())
      if (recentOperands.length > 8) recentOperands.shift()
      continue
    }

    if (c === "<" && streamText[i + 1] === "<") {
      i += 2
      recentOperands = []
      continue
    }

    if (c === "<") {
      recentOperands.push(readHexString())
      if (recentOperands.length > 8) recentOperands.shift()
      continue
    }

    if (c === "[") {
      i++
      let arrText = ""
      while (i < streamText.length && streamText[i] !== "]") {
        skipWhitespaceAndComments()
        if (i >= streamText.length || streamText[i] === "]") break
        if (streamText[i] === "(") {
          arrText += readLiteralString()
        } else if (streamText[i] === "<" && streamText[i + 1] !== "<") {
          arrText += readHexString()
        } else {
          // numeric kerning offset e.g. -180: add space if large negative kerning
          let num = ""
          while (i < streamText.length && !/[\s()<>[\]]/.test(streamText[i])) {
            num += streamText[i++]
          }
          const kerning = Number(num)
          if (Number.isFinite(kerning) && kerning <= -150 && !arrText.endsWith(" ")) {
            arrText += " "
          }
        }
      }
      if (i < streamText.length && streamText[i] === "]") i++
      recentOperands.push(arrText)
      if (recentOperands.length > 8) recentOperands.shift()
      continue
    }

    if (c === ">" && streamText[i + 1] === ">") {
      i += 2
      recentOperands = []
      continue
    }

    // Read word/operator/number
    let tok = ""
    while (i < streamText.length && !/[\s()<>[\]{}/%]/.test(streamText[i])) {
      tok += streamText[i++]
    }
    if (!tok) {
      i++
      continue
    }

    if (tok === "BT") {
      inTextObj = true
      recentOperands = []
    } else if (tok === "ET") {
      if (inTextObj) out.push("\n")
      inTextObj = false
      recentOperands = []
    } else if (inTextObj && (tok === "Tj" || tok === "TJ" || tok === "'" || tok === '"')) {
      const text = recentOperands.pop() || ""
      if (tok === "'" || tok === '"') out.push("\n")
      if (text) out.push(text)
      recentOperands = []
    } else if (inTextObj && (tok === "T*" || tok === "Td" || tok === "TD")) {
      out.push("\n")
      recentOperands = []
    } else if (tok === "Tm") {
      if (inTextObj && out.length > 0 && !out[out.length - 1].endsWith("\n")) {
        out.push("\n")
      }
      recentOperands = []
    } else {
      // ignore other operands/operators
    }
  }

  return out.join("")
}

function extractPdfTextPureNode(buf: Buffer): string {
  const latin = buf.toString("latin1")
  const chunks: string[] = []
  let pos = 0

  while (pos < latin.length) {
    const streamIdx = latin.indexOf("stream", pos)
    if (streamIdx === -1) break

    // Ensure "stream" is a keyword token, not part of "endstream" or another word
    const before = streamIdx > 0 ? latin[streamIdx - 1] : "\n"
    if (!/[\s>]/.test(before)) {
      pos = streamIdx + 6
      continue
    }

    let dataStart = streamIdx + 6
    if (latin[dataStart] === "\r" && latin[dataStart + 1] === "\n") {
      dataStart += 2
    } else if (latin[dataStart] === "\n") {
      dataStart += 1
    } else {
      pos = streamIdx + 6
      continue
    }

    const endIdx = latin.indexOf("endstream", dataStart)
    if (endIdx === -1) break

    // Look back up to 512 bytes for object dictionary << ... >>
    const dictSlice = latin.slice(Math.max(0, streamIdx - 512), streamIdx)
    const isFlate = /\/FlateDecode\b/.test(dictSlice)

    // Trim optional single EOL immediately preceding endstream
    let dataEnd = endIdx
    if (dataEnd >= dataStart + 2 && latin[dataEnd - 2] === "\r" && latin[dataEnd - 1] === "\n") {
      dataEnd -= 2
    } else if (dataEnd >= dataStart + 1 && (latin[dataEnd - 1] === "\n" || latin[dataEnd - 1] === "\r")) {
      dataEnd -= 1
    }

    const rawBytes = buf.subarray(dataStart, dataEnd)
    let streamBytes: Buffer | undefined
    if (isFlate) {
      try {
        streamBytes = inflateSync(rawBytes, { maxOutputLength: MAX_PDF_INFLATE_BYTES })
      } catch {
        try {
          streamBytes = inflateRawSync(rawBytes, { maxOutputLength: MAX_PDF_INFLATE_BYTES })
        } catch {
          streamBytes = undefined
        }
      }
    } else {
      streamBytes = rawBytes
    }

    if (streamBytes && streamBytes.length > 0) {
      const contentStr = streamBytes.toString("latin1")
      if (contentStr.includes("BT") && contentStr.includes("ET")) {
        const extracted = extractTextFromPdfContentStream(contentStr).trim()
        if (extracted) chunks.push(extracted)
      }
    }

    pos = endIdx + 9
  }

  return chunks.join("\n\n")
}

function stripBasicHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
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
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()

    if (!extracted) {
      try {
        const cliOut = execFileSync("pdftotext", ["-", "-"], {
          input: buf,
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: MAX_PDF_INFLATE_BYTES,
          stdio: ["pipe", "pipe", "pipe"],
        })
        if (cliOut && cliOut.trim()) {
          extracted = cliOut.replace(/\r\n/g, "\n").trim()
        }
      } catch {
        // pdftotext unavailable or failed — fall through cleanly to needs_ingestor
      }
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
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
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

  const lines = trimmed.split("\n")
  const rawSections: RawSection[] = []
  let currentTitle = "Document Preamble"
  let currentLines: string[] = []

  const headingRe = /^(#{1,3})\s+(.+?)\s*$/
  const latexSecRe = /^\\(?:part|chapter|section|subsection)\*?\{([^}]+)\}/

  for (const line of lines) {
    const mdMatch = headingRe.exec(line)
    const texMatch = !mdMatch ? latexSecRe.exec(line.trim()) : null
    if (mdMatch || texMatch) {
      if (currentLines.join("\n").trim()) {
        rawSections.push({ title: currentTitle, body: currentLines.join("\n").trim() })
      }
      currentTitle = cleanDocText((mdMatch ? mdMatch[2] : texMatch![1]).trim(), 120) || "Untitled Section"
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.join("\n").trim()) {
    rawSections.push({ title: currentTitle, body: currentLines.join("\n").trim() })
  }

  // If there was only 1 giant section without headings, split by paragraph blocks if needed
  let sections: RawSection[] = []
  if (rawSections.length <= 1 && trimmed.length > 1200) {
    const paras = trimmed.split(/\n{2,}/).filter((p) => p.trim().length > 0)
    if (paras.length > 1) {
      sections = paras.map((p, idx) => ({
        title: cleanDocText(p.split("\n")[0] || `Section ${idx + 1}`, 80),
        body: p.trim(),
      }))
    } else {
      sections = rawSections
    }
  } else {
    sections = rawSections
  }

  // Enforce MAX_SEGMENT_CHARS per section before packing
  const sizedSections: RawSection[] = []
  for (const sec of sections) {
    sizedSections.push(...splitLargeSection(sec.title, sec.body))
  }

  // Deterministically pack into <= limit segments
  let packed: RawSection[] = []
  if (sizedSections.length <= limit) {
    packed = sizedSections
  } else {
    const totalChars = sizedSections.reduce((acc, s) => acc + s.body.length, 0)
    const targetPerSeg = Math.max(1, Math.ceil(totalChars / limit))
    let curGroup: RawSection[] = []
    let curLen = 0

    for (let i = 0; i < sizedSections.length; i++) {
      const sec = sizedSections[i]
      const remainingSections = sizedSections.length - i
      const remainingSlots = limit - packed.length
      const nextLen = curLen + (curGroup.length ? 2 : 0) + sec.body.length

      // Must start new bucket if current bucket exceeds MAX_SEGMENT_CHARS or target threshold
      // while leaving enough remaining sections to fill if needed, OR stop splitting if on last slot.
      if (
        curGroup.length > 0 &&
        remainingSlots > 1 &&
        (nextLen > MAX_SEGMENT_CHARS || (curLen >= targetPerSeg && remainingSections >= remainingSlots))
      ) {
        const title =
          curGroup.length === 1
            ? curGroup[0].title
            : cleanDocText(`${curGroup[0].title} … ${curGroup[curGroup.length - 1].title}`, 120)
        packed.push({ title, body: curGroup.map((g) => g.body).join("\n\n").slice(0, MAX_SEGMENT_CHARS) })
        curGroup = [sec]
        curLen = sec.body.length
      } else if (curGroup.length > 0 && nextLen > MAX_SEGMENT_CHARS) {
        // On last slot or overflow: cap safely at MAX_SEGMENT_CHARS
        const title = cleanDocText(`${curGroup[0].title} … ${curGroup[curGroup.length - 1].title}`, 120)
        packed.push({ title, body: curGroup.map((g) => g.body).join("\n\n").slice(0, MAX_SEGMENT_CHARS) })
        curGroup = [sec]
        curLen = sec.body.length
      } else {
        curGroup.push(sec)
        curLen = nextLen
      }
    }
    if (curGroup.length > 0) {
      const title =
        curGroup.length === 1
          ? curGroup[0].title
          : cleanDocText(`${curGroup[0].title} … ${curGroup[curGroup.length - 1].title}`, 120)
      packed.push({ title, body: curGroup.map((g) => g.body).join("\n\n").slice(0, MAX_SEGMENT_CHARS) })
    }
    // In extreme overflow where even packing exceeded limit, merge tail safely into final slot
    while (packed.length > limit) {
      const last = packed.pop()!
      const prev = packed[packed.length - 1]
      prev.title = cleanDocText(`${prev.title} … ${last.title}`, 120)
      prev.body = `${prev.body}\n\n${last.body}`.slice(0, MAX_SEGMENT_CHARS)
    }
  }

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
