// opencode-teamwork — Bounded massive-proof tournament engine & explicit opt-in routing
//
// Zero runtime dependencies. Uses erasable TypeScript only (compatible with
// Node 22/24/26 `--experimental-strip-types`).
//
// Security & containment:
//   * CANDIDATE_ID strict single-segment allowlist (no `/`, `\`, `.`, `..`)
//   * Segment-wise `lstatSync` symlink refusal + `realpathSync` containment
//   * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` bounded reads (lstat fallback), with
//     post-open `/proc/self/fd` containment on Linux via ./safe-fs.mjs (ADR 0004)
//   * Null-prototype dictionaries (`nullMap`) preventing prototype collisions
//   * Control-character / line-separator stripping (`clean`, `cleanBlock`)

import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { readRegularBounded, readWithinBounded } from "./safe-fs.mjs"
import type { SafeFsRead } from "./safe-fs.mjs"

export const TOURNAMENT_LIMITS = {
  MAX_LEVELS: 4,
  MAX_WIDTH: 8,
  MAX_CANDIDATES: 64,
  MAX_ITERATIONS: 32,
  MAX_REFUTATIONS: 8,
  MIN_UNIT_COST_USD: 0.05,
  DEFAULT_UNIT_COST_USD: 0.25,
  DEFAULT_LEVELS: 2,
  DEFAULT_WIDTH: 4,
  DEFAULT_CANDIDATES: 16,
  DEFAULT_ITERATIONS: 4,
  DEFAULT_PASS_THRESHOLD: 70,
} as const

export const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

export const TOURNAMENT_ACTIVE_PHASES = new Set([
  "PROPOSE",
  "FALSIFY_PRUNE",
  "MERGE",
  "REFEREE_SCORE",
  "VICTORY_AUDIT",
])
export const TOURNAMENT_TERMINAL_PHASES = new Set(["COMPLETED", "FAILED", "CANCELLED", "BUDGET_HALTED"])
export const TOURNAMENT_PHASES = new Set([...TOURNAMENT_ACTIVE_PHASES, ...TOURNAMENT_TERMINAL_PHASES])

export type TournamentPhase =
  | "PROPOSE"
  | "FALSIFY_PRUNE"
  | "MERGE"
  | "REFEREE_SCORE"
  | "VICTORY_AUDIT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "BUDGET_HALTED"

export type CandidateStatus = "proposed" | "survives" | "weakened" | "pruned" | "merged" | "winner"
export type RefutationVerdict = "SURVIVES" | "WEAKENED" | "FALSIFIED"
export type RefereeVerdict = "PASS" | "NEEDS_REVISION" | "FAIL"

export interface TournamentConfig {
  levels: number
  branchingFactor: number
  maxCandidates: number
  maxIterations: number
  passScoreThreshold: number
  unitCostUsd: number
}

export interface BudgetEstimate {
  proposeCalls: number
  mergeCalls: number
  falsifyCalls: number
  refereeCalls: number
  victoryAuditCalls: number
  dispatchesPerIteration: number
  estimatedMinUsd: number
  estimatedMaxUsd: number
  unitCostUsd: number
  budgetUsd: number
  existingSpentUsd: number
  remainingUsd: number
  spentPct: number
  sufficient: boolean
  refusalReason?: string
}

export interface RefutationEntry {
  agent: string
  verdict: RefutationVerdict
  reason: string
  counterexample?: string
  at: string
}

export interface CandidateNode {
  id: string
  iteration: number
  level: number
  parentIds: string[]
  agent: string
  status: CandidateStatus
  summary: string
  proofSketch: string
  refutations: RefutationEntry[]
  score: number | null
  rubric: { soundness: number; completeness: number; clarity: number } | null
  refereeVerdict: RefereeVerdict | null
  refereeNotes?: string
  prunedReason?: string
  createdAt: string
  updatedAt: string
}

export interface RankedCandidate {
  rank: number
  id: string
  iteration: number
  level: number
  status: CandidateStatus
  score: number | null
  refereeVerdict: RefereeVerdict | null
  survivalsCount: number
  refutationsCount: number
  agent: string
}

export interface TournamentVerdict {
  version: 1
  sessionId: string
  status: "PASS" | "FAIL" | "PARTIAL"
  verdict: "ACCEPT" | "REJECT" | "PARTIAL"
  refereeAgent: string | null
  phase: TournamentPhase
  winnerId: string | null
  summary: string
  trigger?: "signal" | "explicit" | "budget_exhausted"
  reason?: string
  totalCandidates: number
  survivingCandidates: number
  iterationsCompleted: number
  rankedCandidates: RankedCandidate[]
  generatedAt: string
}

export interface CancellationRecord {
  reason: string
  trigger: "signal" | "explicit" | "budget_exhausted"
  cancelledBy: string | null
  cancelledAt: string
}

export interface TournamentManifest {
  version: 1
  sessionId: string
  phase: TournamentPhase
  iteration: number
  currentLevel: number
  optInProof: {
    explicitFlag: boolean
    explicitRequestSignal: boolean
    recordedAt: string
  }
  config: TournamentConfig
  budgetEstimate: BudgetEstimate
  candidates: Record<string, CandidateNode>
  rankedCandidates: RankedCandidate[]
  verdict: TournamentVerdict | null
  cancelled: CancellationRecord | null
  createdAt: string
  updatedAt: string
}

export interface RouteResult {
  route: string
  topology: string
  massiveProofOptIn: boolean
  lemmaMode: boolean
  routingReason: string
  reason: string
  signals: {
    documentReview: boolean
    leanExplicit: boolean
    leanBareMention: boolean
    mathProofIntent: boolean
    explicitLargeTeamOptIn: boolean
    negatedLargeTeam: boolean
  }
}

export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
export const MAX_CANDIDATE_BYTES = 1 * 1024 * 1024
export const MAX_REPORT_BYTES = 2 * 1024 * 1024

export function clean(value: unknown, max = 64): string {
  const s = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : ""
  // \x00-\x1f already covers \t (0x09), \n (0x0a) and \r (0x0d); \x7f-\x9f
  // already covers U+0085. Listing them again is redundant (Sonar S5869).
  return s
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .slice(0, max)
}

export function cleanBlock(value: unknown, max = 2000): string {
  const raw = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : ""
  // \r (0x0d) is inside \x0b-\x1f and U+0085 is inside \x7f-\x9f; the ranges
  // already skip \n (0x0a) intentionally so one line can hold one round.
  const s = raw.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s
}

export function nullMap<T = any>(src?: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null)
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const k of Object.keys(src as object)) {
      if (RESERVED_KEYS.has(k)) continue
      out[k] = (src as Record<string, T>)[k]
    }
  }
  return out
}

export function isSafeCandidateId(id: unknown): id is string {
  return typeof id === "string" && !RESERVED_KEYS.has(id) && CANDIDATE_ID.test(id)
}

function ownHas(obj: unknown, key: string): boolean {
  return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key)
}

// ---------------------------------------------------------------------------
// Containment & Symlink-Safe File I/O
// ---------------------------------------------------------------------------

/**
 * Verify that `targetPath` stays strictly inside `run` both lexically and
 * physically, refusing any symlink along every segment from `run` down to
 * `targetPath`.
 */
export function ensureSafeRunSubpath(
  run: string,
  targetPath: string,
): { ok: true; path: string; runReal: string } | { ok: false; error: string } {
  let runReal: string
  try {
    const st = lstatSync(run)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, error: "refused: run directory is missing or is a symlink" }
    }
    runReal = realpathSync(run)
  } catch {
    return { ok: false, error: "refused: run directory is not accessible" }
  }

  const resolvedTarget = resolve(targetPath)
  const rel = relative(resolve(run), resolvedTarget)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `refused: path escapes run directory (${clean(targetPath, 120)})` }
  }

  const segments = rel.split(/[\\/]/).filter(Boolean)
  let cur = resolve(run)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === "." || seg === "..") {
      return { ok: false, error: `refused: invalid path segment "${clean(seg, 32)}"` }
    }
    cur = join(cur, seg)
    try {
      const st = lstatSync(cur)
      if (st.isSymbolicLink()) {
        return { ok: false, error: `refused: symlink detected at "${clean(seg, 64)}"` }
      }
      if (i < segments.length - 1 && !st.isDirectory()) {
        return { ok: false, error: `refused: intermediate path "${clean(seg, 64)}" is not a directory` }
      }
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // Remaining segments do not exist yet; verify last existing parent stays inside runReal.
        break
      }
      return { ok: false, error: `refused: unable to inspect path segment "${clean(seg, 64)}"` }
    }
  }

  const parentDir = dirname(resolvedTarget)
  // Only ENOENT means "absent": a dangling symlink at the parent must be
  // refused, and existsSync() would follow it and report false.
  let parentStat: ReturnType<typeof lstatSync> | null = null
  try {
    parentStat = lstatSync(parentDir)
  } catch (err: any) {
    if (err?.code !== "ENOENT") return { ok: false, error: "refused: target parent is not resolvable" }
  }
  if (parentStat) {
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      return { ok: false, error: "refused: target parent is not a directory" }
    }
    try {
      const parentReal = realpathSync(parentDir)
      const relParent = relative(runReal, parentReal)
      if (relParent.startsWith("..") || isAbsolute(relParent)) {
        return { ok: false, error: "refused: target parent escapes run realpath" }
      }
    } catch {
      return { ok: false, error: "refused: target parent is not resolvable" }
    }
  }

  try {
    const st = lstatSync(resolvedTarget)
    if (st.isSymbolicLink()) {
      return { ok: false, error: `refused: target "${basename(resolvedTarget)}" is a symlink` }
    }
    const targetReal = realpathSync(resolvedTarget)
    const relTarget = relative(runReal, targetReal)
    if (!relTarget || relTarget.startsWith("..") || isAbsolute(relTarget)) {
      return { ok: false, error: "refused: target escapes run realpath" }
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      return { ok: false, error: `refused: target "${basename(resolvedTarget)}" is unreadable` }
    }
  }

  return { ok: true, path: resolvedTarget, runReal }
}

export type BoundedReadResult =
  | { status: "ok"; text: string }
  | { status: "absent" }
  | { status: "error"; error: string }

/**
 * Read a bounded view of `file`, refusing symlinks and non-regular files.
 *
 * This is the rootless primitive: it delegates to the shared
 * `readRegularBounded` in `./safe-fs.mjs` (O_NOFOLLOW makes the open fail on a
 * final symlink, O_NONBLOCK keeps a FIFO from blocking open(), fstat on the
 * returned fd is authoritative, EINTR is retried, EAGAIN and every other error
 * fail closed). It cannot enforce run containment because it has no root; use
 * `readBoundedRunFile` / `readWithinBounded` for run artifacts.
 *
 * ADR 0004 boundary: `readBoundedRunFile` additionally checks the opened fd's
 * `/proc/self/fd` path on Linux. macOS/Windows keep the checks above and the
 * documented intermediate-component residual risk.
 */
export function readBoundedFileNoFollow(file: string, maxBytes: number): BoundedReadResult {
  return toBoundedResult(readRegularBounded(file, maxBytes), file, maxBytes)
}

function toBoundedResult(r: SafeFsRead, file: string, maxBytes: number): BoundedReadResult {
  if (r.status === "ok") return { status: "ok", text: r.text }
  if (r.status === "absent") return { status: "absent" }
  if (r.status === "oversize") {
    return { status: "error", error: `refused: "${basename(file)}" exceeds ${maxBytes} byte read cap` }
  }
  return { status: "error", error: r.message }
}

export function readBoundedRunFile(run: string, targetPath: string, maxBytes: number): BoundedReadResult {
  const check = ensureSafeRunSubpath(run, targetPath)
  if (!check.ok) return { status: "error", error: check.error }
  // ADR 0004: exact order open -> fstat -> regular -> size -> fd containment ->
  // read. On Linux the opened fd's real path must stay under runReal.
  return toBoundedResult(readWithinBounded(check.runReal, check.path, maxBytes), check.path, maxBytes)
}

export function readBoundedRunJson<T = any>(
  run: string,
  targetPath: string,
  maxBytes: number,
): { status: "ok"; value: T } | { status: "absent" } | { status: "error"; error: string } {
  const res = readBoundedRunFile(run, targetPath, maxBytes)
  if (res.status !== "ok") return res
  try {
    const parsed = JSON.parse(res.text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "error", error: `refused: "${basename(targetPath)}" is not a JSON object` }
    }
    return { status: "ok", value: parsed as T }
  } catch {
    return { status: "error", error: `refused: "${basename(targetPath)}" is malformed JSON` }
  }
}

export function writeSafeRunFile(run: string, targetPath: string, content: string): void {
  const check = ensureSafeRunSubpath(run, targetPath)
  if (!check.ok) throw new Error(check.error)
  const file = check.path
  const dir = dirname(file)
  if (resolve(dir) !== resolve(run)) {
    const dirCheck = ensureSafeRunSubpath(run, dir)
    if (!dirCheck.ok) throw new Error(dirCheck.error)
  }
  mkdirSync(dir, { recursive: true })
  // Never reuse a predictable temp path: a symlink/hard link planted at
  // `<file>.tmp` would make writeFileSync follow it and overwrite a victim.
  // A fresh random suffix plus O_CREAT|O_EXCL (`wx`, which also refuses an
  // existing symlink) keeps the write inside a brand-new inode; the rename then
  // replaces the destination entry itself, never a target it points at.
  //
  // Write-path residual (ADR 0004): this validation is by path, before the
  // create/rename. An intermediate directory swapped for a symlink after the
  // checks can still redirect the write; mkdir/rename have no fd-relative
  // primitive in Node core, so only the read path has the /proc/self/fd check.
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    const tmpCheck = ensureSafeRunSubpath(run, tmp)
    if (!tmpCheck.ok) throw new Error(tmpCheck.error)
    try {
      writeFileSync(tmpCheck.path, content, { encoding: "utf8", flag: "wx" })
    } catch (err: any) {
      if (err?.code === "EEXIST") continue
      throw err
    }
    renameSync(tmpCheck.path, file)
    return
  }
  throw new Error(`refused: could not create a unique temp file for "${basename(file)}"`)
}

export function writeSafeRunJson(run: string, targetPath: string, value: unknown): void {
  writeSafeRunFile(run, targetPath, JSON.stringify(value, null, 2) + "\n")
}

// ---------------------------------------------------------------------------
// Explicit Opt-In Detection & Priority-Ordered Routing
// ---------------------------------------------------------------------------

/**
 * Mask fenced code blocks (```...```, ~~~...~~~) and Markdown inline code spans
 * (`...`, ``...``, ```...```) into spaces using CommonMark backtick-run-length
 * matching so code/quoted examples cannot accidentally trigger routing.
 */
function isLineStart(s: string, idx: number): boolean {
  let p = idx - 1
  let indent = 0
  while (p >= 0 && (s[p] === " " || s[p] === "\t")) {
    indent += s[p] === "\t" ? 4 : 1
    if (indent > 3) return false
    p--
  }
  return p < 0 || s[p] === "\n"
}

/** True when only spaces/tabs remain before the end of the current line. */
function onlySpacesToLineEnd(s: string, from: number): boolean {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\n" || s[j] === "\r") return true
    if (s[j] !== " " && s[j] !== "\t") return false
  }
  return true
}

function hasBacktickBeforeNewline(s: string, from: number): boolean {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\n" || s[j] === "\r") return false
    if (s[j] === "`") return true
  }
  return false
}

function countRunAt(s: string, idx: number, ch: string): number {
  let n = 0
  while (idx + n < s.length && s[idx + n] === ch) n++
  return n
}

function isBlankLineAfter(s: string, k: number): boolean {
  if (s[k] !== "\n" && !(s[k] === "\r" && s[k + 1] === "\n")) return false
  let p = s[k] === "\r" ? k + 2 : k + 1
  while (p < s.length && (s[p] === " " || s[p] === "\t")) p++
  return p < s.length && (s[p] === "\n" || (s[p] === "\r" && s[p + 1] === "\n"))
}

function consumeTildeFence(s: string, i: number): number {
  const n = countRunAt(s, i, "~")
  let k = i + n
  while (k < s.length) {
    if (s[k] === "~") {
      const run = countRunAt(s, k, "~")
      // CommonMark: a closing fence is a line of its own, same marker family,
      // at least as long as the opener, with no trailing info text.
      if (run >= n && isLineStart(s, k) && onlySpacesToLineEnd(s, k + run)) return k + run
      k += run
    } else {
      k++
    }
  }
  return s.length
}

function consumeBacktickSpan(s: string, i: number, out: string[]): number {
  const n = countRunAt(s, i, "`")
  const isFence = n >= 3 && isLineStart(s, i) && !hasBacktickBeforeNewline(s, i + n)
  let k = i + n
  while (k < s.length) {
    if (!isFence && isBlankLineAfter(s, k)) break
    if (s[k] === "`") {
      const run = countRunAt(s, k, "`")
      if (isFence ? isLineStart(s, k) && run >= n && onlySpacesToLineEnd(s, k + run) : run === n) {
        out.push(" ")
        return k + run
      }
      k += run
    } else {
      k++
    }
  }
  if (isFence) {
    out.push(" ")
    return s.length
  }
  out.push(s.slice(i, i + n))
  return i + n
}

export function maskCodeAndQuotes(text: string): string {
  const s = typeof text === "string" ? text : ""
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "~" && s.startsWith("~~~", i)) {
      out.push(" ")
      i = consumeTildeFence(s, i)
    } else if (ch === "`") {
      i = consumeBacktickSpan(s, i, out)
    } else {
      out.push(ch)
      i++
    }
  }
  return out.join("")
}

/**
 * Mask double-quoted and curly-quoted prose for *consent* detection only. A
 * request that merely quotes an example ("the docs say \"use a proof
 * tournament\"") must not opt in; an unquoted affirmative request still does.
 * Not applied globally: quoting only matters where a phrase grants authority.
 */
export function maskQuotedExamples(text: string): string {
  const s = typeof text === "string" ? text : ""
  let out = ""
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"' || ch === "“" || ch === "”") {
      const closer = ch === "“" ? "”" : '"'
      const end = s.indexOf(closer, i + 1)
      if (end !== -1) {
        out += " ".repeat(end - i + 1)
        i = end + 1
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

const MATH_PROOF_INTENT_RE =
  /\b(?:prove|disprove|conjecture|theorem|lemma|corollary|proposition|open\s+problem|(?:math(?:ematical)?|normal|formal)\s+proof|proof\s+search)\b|[∀∃⊢]/i

const EXPLICIT_LARGE_TEAM_OPT_IN_RE =
  /\b(?:massive[- ]?proof(?:-swarm)?|(?:very|extremely)\s+large\s+team|very\s+many\s+agents|100\+?\s*searchers|massively\s+parallel(?:\s+proof)?|large[- ]team\s+(?:proof|tournament)|proof\s+tournament|tournament\s+search)\b/i

const NEGATED_LARGE_TEAM_RE =
  /\b(?:do\s+not|don'?t|never|without|no|avoid|skip|not)\s+(?:(?:using|running|spinning\s+up|triggering|enabling|trying|use|run|spin\s+up|trigger|enable|try|want\s+to\s+(?:use|run|spin\s+up|trigger|enable|try)|want)\s+)?(?:(?:a|an|the)\s+)?(?:massive[- ]?proof(?:-swarm)?|(?:very\s+|extremely\s+)?large[- ]?team(?:\s+(?:proof|tournament))?|(?:very\s+)?big\s+team|massively\s+parallel(?:\s+proof)?|(?:proof\s+)?tournament(?:\s+search)?|100\+?\s*searchers|very\s+many\s+agents)\b/i

export function hasMathProofIntent(proseOnly: string): boolean {
  return MATH_PROOF_INTENT_RE.test(proseOnly)
}

export function hasExplicitLargeTeamOptIn(proseOnly: string): boolean {
  return EXPLICIT_LARGE_TEAM_OPT_IN_RE.test(proseOnly)
}

export function hasNegatedLargeTeam(proseOnly: string): boolean {
  return NEGATED_LARGE_TEAM_RE.test(proseOnly)
}

export function hasExplicitMassiveProofOptIn(text: string): boolean {
  // Only unquoted prose can grant consent; quoted examples are documentation.
  const proseOnly = maskQuotedExamples(maskCodeAndQuotes(text))
  return hasMathProofIntent(proseOnly) && hasExplicitLargeTeamOptIn(proseOnly) && !hasNegatedLargeTeam(proseOnly)
}

const PR_OR_CODE_REVIEW_RE =
  /\b(?:review\s+(?:(?:this|the|my|our)\s+)?(?:pull\s+request|pr|diff|patch|commit|code|codebase|branch|mr)|(?:code|pr|pull\s+request)\s+review)\b/i

const DOC_INPUT_EXT_RE = /\.(?:md|markdown|txt|pdf|rst|adoc|docx|tex)$/i
const SUPPLIED_DOC_PROSE_RE =
  /\b(?:this\s+(?:paper|document|doc|spec|specification|report|article|manuscript|draft)|attached\s+(?:paper|document|doc|report)|supplied\s+(?:paper|document|doc|report))\b|\S+\.(?:md|markdown|txt|pdf|rst|adoc|docx)\b/i
const DOC_REVIEW_DELIVERABLE_RE =
  /\b(?:review|summarize|summarise|critique|analyze|analyse|what\s+does\s+this\s+(?:paper|document|doc|report)\s+say)\b/i

// "Lean" the language must be a real token, not the ordinary adjective in
// "lean manufacturing": accept a capitalised `Lean` or an explicit
// `in/using/with/via lean`, and require a proof word within 80 chars in either
// direction (which still spans a newline, unlike the old same-line lookahead).
const LEAN_STRONG_RE = /\b(?:lean\s*4|lean4|lake\s+build|mathlib)\b/i
const LEAN_LANGUAGE_TOKEN_RE = /\bLean\b|\b(?:[Ii]n|[Uu]sing|[Ww]ith|[Vv]ia)\s+lean\b/
const LEAN_PROOF_WORD_RE = /\b(?:prove|disprove|formalize|formalise|verify|theorem|lemma|proof)\b/i
function hasExplicitLeanProveIntent(proseOnly: string): boolean {
  if (LEAN_STRONG_RE.test(proseOnly)) return true
  const token = proseOnly.match(LEAN_LANGUAGE_TOKEN_RE)
  if (!token || token.index === undefined) return false
  const before = proseOnly.slice(Math.max(0, token.index - 80), token.index)
  const after = proseOnly.slice(token.index + token[0].length, token.index + token[0].length + 80)
  return LEAN_PROOF_WORD_RE.test(before) || LEAN_PROOF_WORD_RE.test(after)
}
const LEAN_BARE_EXT_RE = /(?:^|[\s"'(\[])[^\s"'`]+\.lean(?:$|[\s"')\].,:;!?])/i

export function classifyRoute(
  input: string | { request?: string; inputs?: string[]; hasDocument?: boolean; cwd?: string },
  _root?: string,
): RouteResult {
  const raw = typeof input === "string" ? input : String(input?.request ?? "")
  const inputs = typeof input === "string" ? [] : Array.isArray(input?.inputs) ? input.inputs.map(String) : []
  const hasDocFlag = typeof input === "string" ? false : input?.hasDocument === true
  const proseOnly = maskCodeAndQuotes(raw)

  const mathProofIntent = hasMathProofIntent(proseOnly)
  const consentOnly = maskQuotedExamples(proseOnly)
  const explicitLargeTeamOptIn = hasExplicitLargeTeamOptIn(consentOnly)
  const negatedLargeTeam = hasNegatedLargeTeam(consentOnly)

  const hasDocInput = hasDocFlag || inputs.some((x) => DOC_INPUT_EXT_RE.test(x.trim()))
  const hasSuppliedDoc = hasDocInput || SUPPLIED_DOC_PROSE_RE.test(proseOnly)
  const isPrCodeReview = PR_OR_CODE_REVIEW_RE.test(proseOnly)
  const hasReviewDeliverable = DOC_REVIEW_DELIVERABLE_RE.test(proseOnly)
  const isSolvePrompt = /\b(?:prove|disprove|solve)\s+(?:this|the)\s+(?:conjecture|theorem|lemma|open\s+problem)\b/i.test(proseOnly)

  const documentReview = hasSuppliedDoc && hasReviewDeliverable && !isPrCodeReview && !isSolvePrompt

  const leanExplicit =
    hasExplicitLeanProveIntent(proseOnly) &&
    !/^\s*(?:format|lint|style|rename|indent)\b/i.test(proseOnly.trim()) &&
    !/\b(?:format|lint|style)\s+(?:only|check|this)?\b/i.test(proseOnly)
  const leanBareMention = !leanExplicit && (LEAN_BARE_EXT_RE.test(proseOnly) || inputs.some((x) => /\.lean$/i.test(x.trim())))

  const signals = {
    documentReview,
    leanExplicit,
    leanBareMention,
    mathProofIntent,
    explicitLargeTeamOptIn,
    negatedLargeTeam,
  }

  // Priority 1: document-review
  if (documentReview) {
    return {
      route: "document-review",
      topology: "document-review",
      massiveProofOptIn: false,
      lemmaMode: false,
      routingReason: "supplied document with review/critique deliverable",
      reason: "Priority 1: supplied document + review/critique deliverable routes to document-review.",
      signals,
    }
  }

  // Priority 2: Explicit Lean / .lean guard (never massive-proof)
  if (leanExplicit) {
    return {
      route: "proof",
      topology: "proof",
      massiveProofOptIn: false,
      lemmaMode: true,
      routingReason: "explicit Lean 4 proof/formalization request (lemmaMode: true)",
      reason: "Priority 2: explicit Lean 4 proof request routes to proof (lemmaMode: true; never massive-proof).",
      signals,
    }
  }
  if (leanBareMention) {
    return {
      route: "distributed-coding",
      topology: "distributed-coding",
      massiveProofOptIn: false,
      lemmaMode: false,
      routingReason: "bare .lean formatting/lint/non-proving task",
      reason: "Priority 2: bare .lean non-proving task routes to distributed-coding (never massive-proof).",
      signals,
    }
  }

  // Priority 3: massive-proof (explicit opt-in ONLY)
  if (mathProofIntent && explicitLargeTeamOptIn && !negatedLargeTeam) {
    return {
      route: "massive-proof",
      topology: "massive-proof",
      massiveProofOptIn: true,
      lemmaMode: false,
      routingReason: "math/proof intent with explicit large-team/tournament opt-in",
      reason: "Priority 3: explicit large-team/tournament opt-in with math/proof intent routes to massive-proof.",
      signals,
    }
  }

  // Priority 4: proof
  if (mathProofIntent) {
    return {
      route: "proof",
      topology: "proof",
      massiveProofOptIn: false,
      lemmaMode: false,
      routingReason: negatedLargeTeam
        ? "math/proof intent with explicit large-team opt-out"
        : "math/proof intent without explicit large-team opt-in",
      reason: "Priority 4: math/proof intent without explicit large-team opt-in routes to proof.",
      signals,
    }
  }

  // Priority 5: small-focused / iterative-coding
  if (/\b(?:single\s+small\s+fix|rename\s+this|tweak\s+this\s+one\s+function|one[- ]line\s+fix|typo)\b/i.test(proseOnly)) {
    return {
      route: "small-focused",
      topology: "small-focused",
      massiveProofOptIn: false,
      lemmaMode: false,
      routingReason: "small focused single-change task",
      reason: "Priority 5: small focused change routes to small-focused.",
      signals,
    }
  }

  if (/\b(?:fix\s+(?:the\s+)?bug|test[- ]driven|tdd|tight\s+loop|single\s+(?:file|module)|unit\s+test)\b/i.test(proseOnly)) {
    return {
      route: "iterative-coding",
      topology: "iterative-coding",
      massiveProofOptIn: false,
      lemmaMode: false,
      routingReason: "iterative single-module/test-driven coding task",
      reason: "Priority 5: iterative coding task routes to iterative-coding.",
      signals,
    }
  }

  // Priority 6: distributed-coding default
  return {
    route: "distributed-coding",
    topology: "distributed-coding",
    massiveProofOptIn: false,
    lemmaMode: false,
    routingReason: "default general/distributed coding route",
    reason: "Priority 6: general/multi-file coding default routes to distributed-coding.",
    signals,
  }
}

// ---------------------------------------------------------------------------
// Config Validation & Budget Estimation
// ---------------------------------------------------------------------------

export function validateTournamentConfig(
  raw?: unknown,
): { ok: true; config: TournamentConfig } | { ok: false; error: string } {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, error: "tournament config must be a plain object" }
  }
  const obj = (raw ?? {}) as Record<string, unknown>

  const checkInt = (name: string, val: unknown, fallback: number, min: number, max: number): number | string => {
    if (val === undefined || val === null) return fallback
    if (typeof val !== "number" || !Number.isInteger(val) || val < min || val > max) {
      return `${name} must be an integer in [${min}, ${max}] (got ${clean(val, 32)})`
    }
    return val
  }

  const levels = checkInt("levels", obj.levels, TOURNAMENT_LIMITS.DEFAULT_LEVELS, 1, TOURNAMENT_LIMITS.MAX_LEVELS)
  if (typeof levels === "string") return { ok: false, error: levels }

  if (
    obj.branchingFactor !== undefined &&
    obj.width !== undefined &&
    obj.branchingFactor !== obj.width
  ) {
    return { ok: false, error: "branchingFactor and width disagree; provide only one or identical values" }
  }
  const rawWidth = obj.branchingFactor !== undefined ? obj.branchingFactor : obj.width
  const branchingFactor = checkInt(
    "branchingFactor",
    rawWidth,
    TOURNAMENT_LIMITS.DEFAULT_WIDTH,
    1,
    TOURNAMENT_LIMITS.MAX_WIDTH,
  )
  if (typeof branchingFactor === "string") return { ok: false, error: branchingFactor }

  const maxCandidates = checkInt(
    "maxCandidates",
    obj.maxCandidates,
    TOURNAMENT_LIMITS.DEFAULT_CANDIDATES,
    1,
    TOURNAMENT_LIMITS.MAX_CANDIDATES,
  )
  if (typeof maxCandidates === "string") return { ok: false, error: maxCandidates }

  const maxIterations = checkInt(
    "maxIterations",
    obj.maxIterations,
    TOURNAMENT_LIMITS.DEFAULT_ITERATIONS,
    1,
    TOURNAMENT_LIMITS.MAX_ITERATIONS,
  )
  if (typeof maxIterations === "string") return { ok: false, error: maxIterations }

  let unitCostUsd: number = TOURNAMENT_LIMITS.DEFAULT_UNIT_COST_USD
  if (obj.unitCostUsd !== undefined && obj.unitCostUsd !== null) {
    if (
      typeof obj.unitCostUsd !== "number" ||
      !Number.isFinite(obj.unitCostUsd) ||
      obj.unitCostUsd < TOURNAMENT_LIMITS.MIN_UNIT_COST_USD
    ) {
      return {
        ok: false,
        error: `unitCostUsd must be a finite number >= ${TOURNAMENT_LIMITS.MIN_UNIT_COST_USD} (got ${clean(obj.unitCostUsd, 32)})`,
      }
    }
    unitCostUsd = obj.unitCostUsd
  }

  let passScoreThreshold: number = TOURNAMENT_LIMITS.DEFAULT_PASS_THRESHOLD
  if (obj.passScoreThreshold !== undefined && obj.passScoreThreshold !== null) {
    if (
      typeof obj.passScoreThreshold !== "number" ||
      !Number.isFinite(obj.passScoreThreshold) ||
      obj.passScoreThreshold < 0 ||
      obj.passScoreThreshold > 100
    ) {
      return {
        ok: false,
        error: `passScoreThreshold must be a finite number in [0, 100] (got ${clean(obj.passScoreThreshold, 32)})`,
      }
    }
    passScoreThreshold = obj.passScoreThreshold
  }

  return {
    ok: true,
    config: {
      levels,
      branchingFactor,
      maxCandidates,
      maxIterations,
      passScoreThreshold,
      unitCostUsd,
    },
  }
}

export function tournamentConfigsEqual(a: TournamentConfig, b: TournamentConfig): boolean {
  return (
    a.levels === b.levels &&
    a.branchingFactor === b.branchingFactor &&
    a.maxCandidates === b.maxCandidates &&
    a.maxIterations === b.maxIterations &&
    a.passScoreThreshold === b.passScoreThreshold &&
    a.unitCostUsd === b.unitCostUsd
  )
}

export function resolveAndValidateTournamentConfig(
  tournamentInput: unknown,
  boundsInput: unknown,
): { ok: true; config: TournamentConfig } | { ok: false; error: string; conflict?: boolean } {
  if (tournamentInput !== undefined && boundsInput !== undefined) {
    const tRes = validateTournamentConfig(tournamentInput)
    if (!tRes.ok) return tRes
    const bRes = validateTournamentConfig(boundsInput)
    if (!bRes.ok) return bRes
    if (!tournamentConfigsEqual(tRes.config, bRes.config)) {
      return { ok: false, error: "pass either tournament or tournamentBounds, not conflicting values", conflict: true }
    }
    return tRes
  }
  return validateTournamentConfig(tournamentInput ?? boundsInput)
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100
}

export function estimateTournamentBudget(
  config: TournamentConfig,
  existingSpentUsd = 0,
  budgetUsd = 20,
): BudgetEstimate {
  const spent = typeof existingSpentUsd === "number" && Number.isFinite(existingSpentUsd) && existingSpentUsd >= 0
    ? existingSpentUsd
    : 0
  const budget = typeof budgetUsd === "number" && Number.isFinite(budgetUsd) ? budgetUsd : -1

  const w = Math.min(config.branchingFactor, config.maxCandidates)
  const proposeCalls = w
  let mergeCalls = 0
  let nodes = w
  let totalSlots = w
  for (let lvl = 1; lvl < config.levels; lvl++) {
    if (nodes <= 1 || totalSlots >= config.maxCandidates) break
    const merged = Math.min(Math.ceil(nodes / 2), config.maxCandidates - totalSlots)
    if (merged <= 0) break
    mergeCalls += merged
    totalSlots += merged
    nodes = merged
  }
  const falsifyCalls = proposeCalls + mergeCalls
  const dispatchesPerIteration = proposeCalls + falsifyCalls + mergeCalls
  const refereeCalls = 1
  const victoryAuditCalls = 1

  const estimatedMinUsd = roundUsd((dispatchesPerIteration + refereeCalls + victoryAuditCalls) * config.unitCostUsd)
  // Every iteration that reaches scoring gets one referee call (max case), while
  // the victory audit happens only once.
  const estimatedMaxUsd = roundUsd(
    (dispatchesPerIteration * config.maxIterations + config.maxIterations + victoryAuditCalls) * config.unitCostUsd,
  )

  const remainingUsd = roundUsd(budget - spent)
  const spentPct = budget > 0 ? Math.floor((spent / budget) * 100) : 100
  // Dispatch halts at >= 80% of budget, so a budget is only sufficient when the
  // estimated completion (including the final audit) still fits under that cap.
  const dispatchCapUsd = budget > 0 ? roundUsd(budget * 0.8) : 0
  const estimatedCompletionUsd = roundUsd(spent + estimatedMinUsd)

  let refusalReason: string | undefined
  if (budget <= 0) {
    refusalReason = "massive-proof tournament requires a positive budgetUsd (> 0)"
  } else if (spentPct >= 80) {
    refusalReason = `existing spend is already ${spentPct}% of $${budget} (>= 80% halt threshold)`
  } else if (remainingUsd < estimatedMinUsd) {
    refusalReason = `insufficient remaining budget ($${remainingUsd.toFixed(2)} < minimum 1-iteration estimate $${estimatedMinUsd.toFixed(2)})`
  } else if (estimatedCompletionUsd > dispatchCapUsd) {
    refusalReason = `budget cannot reach the last required action before the 80% dispatch halt (estimated completion $${estimatedCompletionUsd.toFixed(2)} > 80% cap $${dispatchCapUsd.toFixed(2)} of $${budget})`
  }

  return {
    proposeCalls,
    mergeCalls,
    falsifyCalls,
    refereeCalls,
    victoryAuditCalls,
    dispatchesPerIteration,
    estimatedMinUsd,
    estimatedMaxUsd,
    unitCostUsd: config.unitCostUsd,
    budgetUsd: budget,
    existingSpentUsd: spent,
    remainingUsd,
    spentPct,
    sufficient: refusalReason === undefined,
    ...(refusalReason ? { refusalReason } : {}),
  }
}

// ---------------------------------------------------------------------------
// Deterministic Candidate Comparator & Ranking
// ---------------------------------------------------------------------------

function verdictRank(v: RefereeVerdict | null): number {
  if (v === "PASS") return 3
  if (v === "NEEDS_REVISION") return 2
  if (v === null) return 1
  return 0 // FAIL
}

function survivalsCountOf(c: CandidateNode): number {
  return Array.isArray(c.refutations) ? c.refutations.filter((r) => r.verdict === "SURVIVES").length : 0
}

export function compareCandidates(a: CandidateNode, b: CandidateNode): number {
  const prunedA = a.status === "pruned" ? 1 : 0
  const prunedB = b.status === "pruned" ? 1 : 0
  if (prunedA !== prunedB) return prunedA - prunedB

  const vA = verdictRank(a.refereeVerdict)
  const vB = verdictRank(b.refereeVerdict)
  if (vA !== vB) return vB - vA

  const sA = typeof a.score === "number" && Number.isFinite(a.score) ? a.score : -1
  const sB = typeof b.score === "number" && Number.isFinite(b.score) ? b.score : -1
  if (sA !== sB) return sB - sA

  const survA = survivalsCountOf(a)
  const survB = survivalsCountOf(b)
  if (survA !== survB) return survB - survA

  if (a.level !== b.level) return b.level - a.level

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function rankCandidates(candidatesMap: Record<string, CandidateNode>): RankedCandidate[] {
  const list: CandidateNode[] = []
  for (const key of Object.keys(candidatesMap)) {
    if (RESERVED_KEYS.has(key)) continue
    const c = candidatesMap[key]
    if (c && typeof c === "object") list.push(c)
  }
  list.sort(compareCandidates)
  return list.map((c, idx) => ({
    rank: idx + 1,
    id: c.id,
    iteration: c.iteration,
    level: c.level,
    status: c.status,
    score: c.score,
    refereeVerdict: c.refereeVerdict,
    survivalsCount: survivalsCountOf(c),
    refutationsCount: Array.isArray(c.refutations) ? c.refutations.length : 0,
    agent: c.agent,
  }))
}

// ---------------------------------------------------------------------------
// Manifest & Report Helpers
// ---------------------------------------------------------------------------

export function tournamentDir(run: string): string {
  return join(run, "tournament")
}

export function manifestPathOf(run: string): string {
  return join(run, "tournament", "manifest.json")
}

export function verdictPathOf(run: string): string {
  return join(run, "tournament", "verdict.json")
}

export function reportPathOf(run: string): string {
  return join(run, "TOURNAMENT_REPORT.md")
}

function validRankedCandidates(value: unknown, allowEmpty = false): boolean {
  if (!Array.isArray(value)) return false
  if (value.length === 0) return allowEmpty
  return value.every(
    (r: any) => !!r && typeof r === "object" && typeof r.id === "string" && r.id.length > 0 && typeof r.rank === "number" && Number.isFinite(r.rank),
  )
}

export function readTournamentManifest(
  run: string,
): { status: "ok"; manifest: TournamentManifest } | { status: "absent" } | { status: "error"; error: string } {
  const res = readBoundedRunJson<TournamentManifest>(run, manifestPathOf(run), MAX_MANIFEST_BYTES)
  if (res.status === "absent") return { status: "absent" }
  if (res.status === "error") return { status: "error", error: res.error }
  const m = res.value
  if (!m || typeof m !== "object" || !TOURNAMENT_PHASES.has(m.phase) || !m.config) {
    return { status: "error", error: "refused: tournament/manifest.json has invalid schema" }
  }
  // A COMPLETED phase is a claim of evidence. Validate it here so consumers do
  // not crash (or silently pass) when rankings/verdict are missing, e.g. after
  // an artifact was deleted or hand-edited.
  if (m.phase === "COMPLETED") {
    if (!validRankedCandidates(m.rankedCandidates)) {
      return { status: "error", error: "refused: completed tournament/manifest.json has no valid rankedCandidates" }
    }
    const v: any = m.verdict
    if (
      !v ||
      typeof v !== "object" ||
      typeof v.status !== "string" ||
      typeof v.verdict !== "string" ||
      !validRankedCandidates(v.rankedCandidates)
    ) {
      return { status: "error", error: "refused: completed tournament/manifest.json has no valid verdict" }
    }
  }
  m.candidates = nullMap<CandidateNode>(m.candidates)
  return { status: "ok", manifest: m }
}

export function readTournamentVerdict(
  run: string,
): { status: "ok"; verdict: TournamentVerdict } | { status: "absent" } | { status: "error"; error: string } {
  const res = readBoundedRunJson<TournamentVerdict>(run, verdictPathOf(run), MAX_MANIFEST_BYTES)
  if (res.status === "absent") return { status: "absent" }
  if (res.status === "error") return { status: "error", error: res.error }
  const v = res.value
  if (
    !v ||
    typeof v !== "object" ||
    typeof v.status !== "string" ||
    typeof v.verdict !== "string" ||
    !validRankedCandidates(v.rankedCandidates, true)
  ) {
    return { status: "error", error: "refused: tournament/verdict.json has invalid schema" }
  }
  return { status: "ok", verdict: v }
}

export function writeTournamentManifest(run: string, manifest: TournamentManifest): void {
  writeSafeRunJson(run, manifestPathOf(run), manifest)
}

export function initTournamentManifest(opts: {
  run: string
  sessionId: string
  config: TournamentConfig
  budgetEstimate: BudgetEstimate
  explicitFlag: boolean
  explicitRequestSignal: boolean
  now?: string
}): TournamentManifest {
  const now = opts.now ?? new Date().toISOString()
  const manifest: TournamentManifest = {
    version: 1,
    sessionId: clean(opts.sessionId, 64),
    phase: "PROPOSE",
    iteration: 1,
    currentLevel: 0,
    optInProof: {
      explicitFlag: opts.explicitFlag,
      explicitRequestSignal: opts.explicitRequestSignal,
      recordedAt: now,
    },
    config: opts.config,
    budgetEstimate: opts.budgetEstimate,
    candidates: nullMap<CandidateNode>(),
    rankedCandidates: [],
    verdict: null,
    cancelled: null,
    createdAt: now,
    updatedAt: now,
  }
  writeTournamentManifest(opts.run, manifest)
  return manifest
}

function renderTournamentReportMd(manifest: TournamentManifest, verdict: TournamentVerdict): string {
  const lines: string[] = [
    `# Tournament Report — ${clean(manifest.sessionId, 64)}`,
    "",
    `- **Phase:** ${manifest.phase}`,
    `- **Status:** ${verdict.status} (${verdict.verdict})`,
    `- **Iterations completed:** ${verdict.iterationsCompleted}`,
    `- **Candidates:** ${verdict.totalCandidates} total (${verdict.survivingCandidates} surviving)`,
    `- **Winner:** ${verdict.winnerId ?? "none"}`,
    `- **Referee:** ${verdict.refereeAgent ?? "none"}`,
    `- **Generated at:** ${verdict.generatedAt}`,
  ]
  if (manifest.cancelled) {
    lines.push(
      `- **Cancellation trigger:** ${manifest.cancelled.trigger}`,
      `- **Cancellation reason:** ${clean(manifest.cancelled.reason, 300)}`,
    )
  }
  lines.push("", "## Summary", "", cleanBlock(verdict.summary, 1500), "", "## Ranked Candidates", "")
  if (verdict.rankedCandidates.length === 0) {
    lines.push("_No candidates were proposed._")
  } else {
    lines.push(
      "| Rank | Candidate | Iteration | Level | Status | Referee Verdict | Score | Survivals |",
      "|---:|---|---:|---:|---|---|---:|---:|",
    )
    for (const r of verdict.rankedCandidates) {
      lines.push(
        `| ${r.rank} | ${clean(r.id, 64)} | ${r.iteration} | ${r.level} | ${r.status} | ${r.refereeVerdict ?? "—"} | ${r.score !== null ? r.score : "—"} | ${r.survivalsCount} |`,
      )
    }
  }
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

function candidatesAt(manifest: TournamentManifest, iteration: number, level: number): CandidateNode[] {
  const out: CandidateNode[] = []
  for (const k of Object.keys(manifest.candidates)) {
    const c = manifest.candidates[k]
    if (c && c.iteration === iteration && c.level === level) out.push(c)
  }
  return out
}

function totalCandidateCount(manifest: TournamentManifest): number {
  return Object.keys(manifest.candidates).length
}

function writeCandidateArtifacts(run: string, cand: CandidateNode): void {
  writeSafeRunJson(run, join(tournamentDir(run), "candidates", `${cand.id}.json`), cand)
  const md = [
    `# Candidate ${cand.id}`,
    "",
    `- **Iteration:** ${cand.iteration}`,
    `- **Level:** ${cand.level}`,
    `- **Agent:** ${cand.agent}`,
    `- **Status:** ${cand.status}`,
    `- **Parents:** ${cand.parentIds.length ? cand.parentIds.join(", ") : "none"}`,
    "",
    "## Summary",
    "",
    cand.summary,
    "",
    "## Proof Sketch",
    "",
    cand.proofSketch,
    "",
  ].join("\n")
  writeSafeRunFile(run, join(tournamentDir(run), "candidates", `${cand.id}.md`), md)
}

export function proposeCandidate(
  run: string,
  manifest: TournamentManifest,
  input: { candidateId: unknown; summary?: unknown; proofSketch?: unknown; agent?: unknown; closeRound?: boolean },
): { ok: true; candidate: CandidateNode; manifest: TournamentManifest } | { ok: false; error: string } {
  if (manifest.phase !== "PROPOSE") {
    return { ok: false, error: `refused: cannot propose during phase ${manifest.phase} (expected PROPOSE)` }
  }
  if (!isSafeCandidateId(input.candidateId)) {
    return {
      ok: false,
      error: `refused: invalid candidateId "${clean(input.candidateId, 32)}" (must match ${CANDIDATE_ID})`,
    }
  }
  const id = input.candidateId
  if (ownHas(manifest.candidates, id)) {
    return { ok: false, error: `refused: candidateId "${id}" already exists` }
  }

  const agent = input.agent !== undefined && input.agent !== null ? clean(input.agent, 64).trim() : "team/proposer"
  if (agent !== "team/proposer" && agent !== "team/proof-worker") {
    return { ok: false, error: `refused: propose requires agent team/proposer or team/proof-worker (got "${agent}")` }
  }

  const total = totalCandidateCount(manifest)
  if (total >= manifest.config.maxCandidates) {
    return { ok: false, error: `refused: maxCandidates cap (${manifest.config.maxCandidates}) reached` }
  }

  const atLevel0 = candidatesAt(manifest, manifest.iteration, 0)
  if (atLevel0.length >= manifest.config.branchingFactor) {
    return {
      ok: false,
      error: `refused: branchingFactor (${manifest.config.branchingFactor}) reached for iteration ${manifest.iteration}`,
    }
  }

  const summary = clean(input.summary, 500).trim()
  if (!summary) {
    return { ok: false, error: "refused: summary is required for propose" }
  }
  const proofSketch = cleanBlock(input.proofSketch ?? summary, 4000)
  const now = new Date().toISOString()

  const cand: CandidateNode = {
    id,
    iteration: manifest.iteration,
    level: 0,
    parentIds: [],
    agent,
    status: "proposed",
    summary,
    proofSketch,
    refutations: [],
    score: null,
    rubric: null,
    refereeVerdict: null,
    createdAt: now,
    updatedAt: now,
  }

  manifest.candidates[id] = cand
  writeCandidateArtifacts(run, cand)

  const newAtLevel0 = atLevel0.length + 1
  const newTotal = total + 1
  if (
    newAtLevel0 >= manifest.config.branchingFactor ||
    newTotal >= manifest.config.maxCandidates ||
    input.closeRound === true
  ) {
    manifest.phase = "FALSIFY_PRUNE"
  }
  manifest.rankedCandidates = rankCandidates(manifest.candidates)
  manifest.updatedAt = now
  writeTournamentManifest(run, manifest)
  return { ok: true, candidate: cand, manifest }
}

export function falsifyCandidate(
  run: string,
  manifest: TournamentManifest,
  input: {
    candidateId: unknown
    verdict: unknown
    reason?: unknown
    counterexample?: unknown
    agent?: unknown
  },
): { ok: true; candidate: CandidateNode; manifest: TournamentManifest } | { ok: false; error: string } {
  if (manifest.phase !== "FALSIFY_PRUNE") {
    return { ok: false, error: `refused: cannot falsify during phase ${manifest.phase} (expected FALSIFY_PRUNE)` }
  }
  if (!isSafeCandidateId(input.candidateId)) {
    return { ok: false, error: `refused: invalid candidateId "${clean(input.candidateId, 32)}"` }
  }
  const id = input.candidateId
  if (!ownHas(manifest.candidates, id)) {
    return { ok: false, error: `refused: candidate "${id}" not found` }
  }
  const cand = manifest.candidates[id]
  if (cand.iteration !== manifest.iteration || cand.level !== manifest.currentLevel) {
    return {
      ok: false,
      error: `refused: candidate "${id}" is at (iter=${cand.iteration}, level=${cand.level}), expected (iter=${manifest.iteration}, level=${manifest.currentLevel})`,
    }
  }
  if (cand.status === "pruned") {
    return { ok: false, error: `refused: candidate "${id}" is already pruned` }
  }

  const agent = input.agent !== undefined && input.agent !== null ? clean(input.agent, 64).trim() : "team/falsifier"
  if (agent !== "team/falsifier") {
    return { ok: false, error: `refused: falsify requires agent team/falsifier (got "${agent}")` }
  }

  const verdict = clean(input.verdict, 32).trim().toUpperCase()
  if (verdict !== "SURVIVES" && verdict !== "WEAKENED" && verdict !== "FALSIFIED") {
    return { ok: false, error: `refused: invalid falsifier verdict "${verdict}" (expected SURVIVES | WEAKENED | FALSIFIED)` }
  }
  if (cand.refutations.length >= TOURNAMENT_LIMITS.MAX_REFUTATIONS) {
    return { ok: false, error: `refused: max refutations (${TOURNAMENT_LIMITS.MAX_REFUTATIONS}) reached for "${id}"` }
  }

  const reason = clean(input.reason ?? verdict, 500).trim()
  const counterexample =
    typeof input.counterexample === "string" && input.counterexample.trim()
      ? cleanBlock(input.counterexample, 1000)
      : undefined
  const now = new Date().toISOString()

  cand.refutations.push({
    agent,
    verdict,
    reason,
    ...(counterexample ? { counterexample } : {}),
    at: now,
  })
  cand.status = verdict === "FALSIFIED" ? "pruned" : verdict === "WEAKENED" ? "weakened" : "survives"
  if (verdict === "FALSIFIED") cand.prunedReason = clean(reason, 200)
  cand.updatedAt = now

  writeCandidateArtifacts(run, cand)
  writeSafeRunJson(run, join(tournamentDir(run), "critiques", `${id}-falser.json`), {
    candidateId: id,
    iteration: cand.iteration,
    level: cand.level,
    refutations: cand.refutations,
    status: cand.status,
    updatedAt: now,
  })

  // Check whether every node at (iteration, currentLevel) has been falsified >= 1 time.
  const nodesHere = candidatesAt(manifest, manifest.iteration, manifest.currentLevel)
  const allChecked = nodesHere.length > 0 && nodesHere.every((n) => n.refutations.length >= 1)
  if (allChecked) {
    const survivors = nodesHere.filter((n) => n.status === "survives" || n.status === "weakened")
    const total = totalCandidateCount(manifest)
    if (
      survivors.length > 1 &&
      manifest.currentLevel + 1 < manifest.config.levels &&
      total < manifest.config.maxCandidates
    ) {
      manifest.phase = "MERGE"
    } else if (survivors.length >= 1) {
      manifest.phase = "REFEREE_SCORE"
    } else if (manifest.iteration < manifest.config.maxIterations && total < manifest.config.maxCandidates) {
      manifest.iteration += 1
      manifest.currentLevel = 0
      manifest.phase = "PROPOSE"
    } else {
      manifest.phase = "REFEREE_SCORE"
    }
  }

  manifest.rankedCandidates = rankCandidates(manifest.candidates)
  manifest.updatedAt = now
  writeTournamentManifest(run, manifest)
  return { ok: true, candidate: cand, manifest }
}

export function mergeCandidates(
  run: string,
  manifest: TournamentManifest,
  input: {
    candidateId: unknown
    parentIds: unknown
    summary?: unknown
    proofSketch?: unknown
    agent?: unknown
    closeLevel?: boolean
  },
): { ok: true; candidate: CandidateNode; manifest: TournamentManifest } | { ok: false; error: string } {
  if (manifest.phase !== "MERGE") {
    return { ok: false, error: `refused: cannot merge during phase ${manifest.phase} (expected MERGE)` }
  }
  if (!isSafeCandidateId(input.candidateId)) {
    return { ok: false, error: `refused: invalid candidateId "${clean(input.candidateId, 32)}"` }
  }
  const id = input.candidateId
  if (ownHas(manifest.candidates, id)) {
    return { ok: false, error: `refused: candidateId "${id}" already exists` }
  }

  const agent = input.agent !== undefined && input.agent !== null ? clean(input.agent, 64).trim() : "team/synthesizer"
  if (agent !== "team/synthesizer") {
    return { ok: false, error: `refused: merge requires agent team/synthesizer (got "${agent}")` }
  }

  const total = totalCandidateCount(manifest)
  if (total >= manifest.config.maxCandidates) {
    return { ok: false, error: `refused: maxCandidates cap (${manifest.config.maxCandidates}) reached` }
  }

  if (!Array.isArray(input.parentIds) || input.parentIds.length < 2) {
    return { ok: false, error: "refused: merge requires at least 2 parentIds" }
  }
  const uniqueParents: string[] = []
  for (const rawPid of input.parentIds) {
    if (!isSafeCandidateId(rawPid)) {
      return { ok: false, error: `refused: invalid parentId "${clean(rawPid, 32)}"` }
    }
    if (!uniqueParents.includes(rawPid)) uniqueParents.push(rawPid)
  }
  if (uniqueParents.length < 2) {
    return { ok: false, error: "refused: merge requires at least 2 distinct parentIds" }
  }

  for (const pid of uniqueParents) {
    if (!ownHas(manifest.candidates, pid)) {
      return { ok: false, error: `refused: parent candidate "${pid}" not found` }
    }
    const p = manifest.candidates[pid]
    if (p.iteration !== manifest.iteration || p.level !== manifest.currentLevel) {
      return {
        ok: false,
        error: `refused: parent "${pid}" is at (iter=${p.iteration}, level=${p.level}), expected (iter=${manifest.iteration}, level=${manifest.currentLevel})`,
      }
    }
    if (p.status === "pruned") {
      return { ok: false, error: `refused: cannot merge pruned candidate "${pid}"` }
    }
  }

  const summary = clean(input.summary, 500).trim()
  if (!summary) {
    return { ok: false, error: "refused: summary is required for merge" }
  }
  const proofSketch = cleanBlock(input.proofSketch ?? summary, 4000)
  const nextLevel = manifest.currentLevel + 1
  const now = new Date().toISOString()

  const merged: CandidateNode = {
    id,
    iteration: manifest.iteration,
    level: nextLevel,
    parentIds: uniqueParents,
    agent,
    status: "merged",
    summary,
    proofSketch,
    refutations: [],
    score: null,
    rubric: null,
    refereeVerdict: null,
    createdAt: now,
    updatedAt: now,
  }

  manifest.candidates[id] = merged
  writeCandidateArtifacts(run, merged)
  writeSafeRunJson(run, join(tournamentDir(run), "merges", `L${nextLevel}-${id}.json`), {
    candidateId: id,
    iteration: manifest.iteration,
    level: nextLevel,
    parentIds: uniqueParents,
    agent,
    summary,
    createdAt: now,
  })

  const survivorsAtCurrent = candidatesAt(manifest, manifest.iteration, manifest.currentLevel).filter(
    (c) => c.status === "survives" || c.status === "weakened",
  )
  const expectedMerges = Math.ceil(survivorsAtCurrent.length / 2)
  const mergesAtNext = candidatesAt(manifest, manifest.iteration, nextLevel)
  const newTotal = total + 1
  if (mergesAtNext.length >= expectedMerges || newTotal >= manifest.config.maxCandidates || input.closeLevel === true) {
    manifest.currentLevel = nextLevel
    manifest.phase = "FALSIFY_PRUNE"
  }

  manifest.rankedCandidates = rankCandidates(manifest.candidates)
  manifest.updatedAt = now
  writeTournamentManifest(run, manifest)
  return { ok: true, candidate: merged, manifest }
}

function applySingleScoreItem(item: unknown, manifest: TournamentManifest, run: string, now: string): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return "refused: each score entry must be an object"
  }
  const entry = item as Record<string, unknown>
  const cid = entry.candidateId
  if (!isSafeCandidateId(cid) || !ownHas(manifest.candidates, cid)) {
    return `refused: candidate "${clean(cid, 32)}" not found`
  }
  const clamp = (v: unknown, name: string): number | string => {
    if (typeof v !== "number" || !Number.isFinite(v)) return `refused: ${name} must be a finite number`
    return Math.max(0, Math.min(100, v))
  }
  const soundness = clamp(entry.soundness, "soundness")
  if (typeof soundness === "string") return soundness
  const completeness = clamp(entry.completeness, "completeness")
  if (typeof completeness === "string") return completeness
  const clarity = clamp(entry.clarity, "clarity")
  if (typeof clarity === "string") return clarity

  const verdict = clean(entry.verdict, 32).trim().toUpperCase()
  if (verdict !== "PASS" && verdict !== "NEEDS_REVISION" && verdict !== "FAIL") {
    return `refused: invalid referee verdict "${verdict}" (expected PASS | NEEDS_REVISION | FAIL)`
  }

  const cand = manifest.candidates[cid]
  cand.rubric = { soundness, completeness, clarity }
  cand.score = Math.round((0.5 * soundness + 0.35 * completeness + 0.15 * clarity) * 100) / 100
  cand.refereeVerdict = verdict as RefereeVerdict
  if (typeof entry.notes === "string" && entry.notes.trim()) {
    cand.refereeNotes = clean(entry.notes, 500)
  }
  cand.updatedAt = now
  writeCandidateArtifacts(run, cand)
  return null
}

export function scoreCandidates(
  run: string,
  manifest: TournamentManifest,
  input: {
    scores: unknown
    agent?: unknown
    finalize?: boolean
  },
): { ok: true; manifest: TournamentManifest } | { ok: false; error: string } {
  if (manifest.phase !== "REFEREE_SCORE") {
    return { ok: false, error: `refused: cannot score during phase ${manifest.phase} (expected REFEREE_SCORE)` }
  }
  const agent = input.agent !== undefined && input.agent !== null ? clean(input.agent, 64).trim() : "team/referee"
  if (agent !== "team/referee") {
    return { ok: false, error: `refused: score requires agent team/referee (got "${agent}")` }
  }

  if (!Array.isArray(input.scores) || input.scores.length === 0) {
    return { ok: false, error: "refused: scores must be a non-empty array" }
  }
  const candidateCount = totalCandidateCount(manifest)
  const seenScoreIds = new Set<string>()
  for (const item of input.scores) {
    const cid = item && typeof item === "object" && !Array.isArray(item) ? (item as any).candidateId : undefined
    if (typeof cid === "string") {
      if (seenScoreIds.has(cid)) return { ok: false, error: `refused: duplicate candidateId "${clean(cid, 32)}" in scores batch` }
      seenScoreIds.add(cid)
    }
  }
  if (input.scores.length > candidateCount) {
    return {
      ok: false,
      error: `refused: scores batch (${input.scores.length}) exceeds the number of tournament candidates (${candidateCount})`,
    }
  }

  const now = new Date().toISOString()
  for (const item of input.scores) {
    const err = applySingleScoreItem(item, manifest, run, now)
    if (err) return { ok: false, error: err }
  }

  manifest.rankedCandidates = rankCandidates(manifest.candidates)
  const top = manifest.rankedCandidates[0]
  const topPasses =
    !!top &&
    top.status !== "pruned" &&
    top.refereeVerdict === "PASS" &&
    typeof top.score === "number" &&
    top.score >= manifest.config.passScoreThreshold
  const total = totalCandidateCount(manifest)

  if (
    topPasses ||
    manifest.iteration >= manifest.config.maxIterations ||
    total >= manifest.config.maxCandidates ||
    input.finalize === true
  ) {
    manifest.phase = "VICTORY_AUDIT"
  } else {
    manifest.iteration += 1
    manifest.currentLevel = 0
    manifest.phase = "PROPOSE"
  }

  manifest.updatedAt = now
  writeTournamentManifest(run, manifest)
  return { ok: true, manifest }
}

export function auditTournament(
  run: string,
  manifest: TournamentManifest,
  input: { verdict: unknown; summary?: unknown; winnerId?: unknown; agent?: unknown },
): { ok: true; verdict: TournamentVerdict; manifest: TournamentManifest } | { ok: false; error: string } {
  if (manifest.phase !== "VICTORY_AUDIT") {
    return { ok: false, error: `refused: cannot audit during phase ${manifest.phase} (expected VICTORY_AUDIT)` }
  }
  const agent = input.agent !== undefined && input.agent !== null ? clean(input.agent, 64).trim() : "team/referee"
  if (agent !== "team/referee") {
    return { ok: false, error: `refused: audit requires agent team/referee (got "${agent}")` }
  }

  const verdictStr = clean(input.verdict, 16).trim().toUpperCase()
  if (verdictStr !== "PASS" && verdictStr !== "FAIL") {
    return { ok: false, error: `refused: invalid audit verdict "${verdictStr}" (expected PASS | FAIL)` }
  }

  manifest.rankedCandidates = rankCandidates(manifest.candidates)
  let winnerId: string | null = null
  if (input.winnerId !== undefined && input.winnerId !== null && input.winnerId !== "") {
    if (!isSafeCandidateId(input.winnerId) || !ownHas(manifest.candidates, input.winnerId)) {
      return { ok: false, error: `refused: winnerId "${clean(input.winnerId, 32)}" not found` }
    }
    winnerId = input.winnerId
  } else {
    const firstNonPruned = manifest.rankedCandidates.find((c) => c.status !== "pruned")
    winnerId = firstNonPruned ? firstNonPruned.id : null
  }

  const totalCandidates = totalCandidateCount(manifest)
  const survivingCandidates = manifest.rankedCandidates.filter((c) => c.status !== "pruned").length

  if (verdictStr === "PASS") {
    if (!winnerId || survivingCandidates === 0) {
      return {
        ok: false,
        error: "refused: cannot audit tournament as PASS when all candidates were falsified or none survived",
      }
    }
    const winNode = manifest.candidates[winnerId]
    if (!winNode || winNode.status === "pruned") {
      return { ok: false, error: `refused: cannot designate pruned candidate "${winnerId}" as PASS winner` }
    }
    if (
      winNode.refereeVerdict !== "PASS" ||
      typeof winNode.score !== "number" ||
      winNode.score < manifest.config.passScoreThreshold
    ) {
      return {
        ok: false,
        error: `refused: winner "${winnerId}" must have refereeVerdict === "PASS" and score >= ${manifest.config.passScoreThreshold}`,
      }
    }
    winNode.status = "winner"
    winNode.updatedAt = new Date().toISOString()
    writeCandidateArtifacts(run, winNode)
    manifest.rankedCandidates = rankCandidates(manifest.candidates)
  }

  const now = new Date().toISOString()
  manifest.phase = verdictStr === "PASS" ? "COMPLETED" : "FAILED"
  const summary = clean(input.summary ?? (verdictStr === "PASS" ? `Winner ${winnerId} passed audit.` : "Tournament failed victory audit."), 1500)

  const verdictObj: TournamentVerdict = {
    version: 1,
    sessionId: manifest.sessionId,
    status: verdictStr,
    verdict: verdictStr === "PASS" ? "ACCEPT" : "REJECT",
    refereeAgent: agent,
    phase: manifest.phase,
    winnerId: verdictStr === "PASS" ? winnerId : null,
    summary,
    totalCandidates,
    survivingCandidates,
    iterationsCompleted: manifest.iteration,
    rankedCandidates: manifest.rankedCandidates,
    generatedAt: now,
  }

  manifest.verdict = verdictObj
  manifest.updatedAt = now

  writeSafeRunJson(run, verdictPathOf(run), verdictObj)
  writeSafeRunFile(run, reportPathOf(run), renderTournamentReportMd(manifest, verdictObj))
  writeTournamentManifest(run, manifest)
  return { ok: true, verdict: verdictObj, manifest }
}

// ---------------------------------------------------------------------------
// Unified Idempotent Cancellation & Partial-Report Finalizer
// ---------------------------------------------------------------------------

export function finalizeTournamentPartial(
  run: string,
  manifest: TournamentManifest,
  opts: {
    trigger: "signal" | "explicit" | "budget_exhausted"
    reason: string
    phase: "CANCELLED" | "BUDGET_HALTED"
    cancelledBy?: string | null
  },
): { manifest: TournamentManifest; verdict: TournamentVerdict; alreadyFinalized: boolean; reportPath: string } {
  const reportFile = reportPathOf(run)

  // Idempotent: do not overwrite an already cancelled/halted run's timestamps.
  if (manifest.phase === "CANCELLED" || manifest.phase === "BUDGET_HALTED") {
    const existingVerdict = readTournamentVerdict(run)
    const fallbackVerdict: TournamentVerdict =
      existingVerdict.status === "ok"
        ? existingVerdict.verdict
        : manifest.verdict ?? {
            version: 1,
            sessionId: manifest.sessionId,
            status: "PARTIAL",
            verdict: "PARTIAL",
            refereeAgent: null,
            phase: manifest.phase,
            winnerId: manifest.rankedCandidates[0]?.id ?? null,
            summary: manifest.cancelled?.reason ?? opts.reason,
            trigger: manifest.cancelled?.trigger ?? opts.trigger,
            reason: manifest.cancelled?.reason ?? opts.reason,
            totalCandidates: totalCandidateCount(manifest),
            survivingCandidates: manifest.rankedCandidates.filter((c) => c.status !== "pruned").length,
            iterationsCompleted: manifest.iteration,
            rankedCandidates: manifest.rankedCandidates,
            generatedAt: manifest.updatedAt,
          }
    const interruptedPath = join(run, "interrupted.md")
    const statePath = join(run, "state.json")
    // Repair a retry that previously saved the manifest but failed before
    // writing the checkpoint/artifacts. Preserve the original cancellation
    // reason and timestamp (manifest.cancelled / fallbackVerdict.generatedAt).
    if (existingVerdict.status !== "ok") {
      writeSafeRunJson(run, verdictPathOf(run), fallbackVerdict)
    }
    const reportRes = readBoundedRunFile(run, reportFile, MAX_REPORT_BYTES)
    if (reportRes.status !== "ok" || !reportRes.text.trim()) {
      writeSafeRunFile(run, reportFile, renderTournamentReportMd(manifest, fallbackVerdict))
    }
    const interruptedRes = readBoundedRunFile(run, interruptedPath, MAX_REPORT_BYTES)
    if (interruptedRes.status !== "ok" || !interruptedRes.text.trim()) {
      const cancelledAt = manifest.cancelled?.cancelledAt ?? fallbackVerdict.generatedAt
      writeSafeRunFile(
        run,
        interruptedPath,
        `# Interrupted Run — ${clean(manifest.sessionId, 64)}\n\n- **Phase:** ${manifest.phase}\n- **Trigger:** ${manifest.cancelled?.trigger ?? opts.trigger}\n- **Reason:** ${clean(manifest.cancelled?.reason ?? opts.reason, 300)}\n- **Recorded:** ${cancelledAt}\n- **Partial report:** TOURNAMENT_REPORT.md\n`,
      )
    }
    const stateRes = readBoundedRunJson<any>(run, statePath, MAX_MANIFEST_BYTES)
    if (stateRes.status === "ok") {
      if (stateRes.value?.phase !== "PRESENT_PARTIAL") {
        stateRes.value.phase = "PRESENT_PARTIAL"
        stateRes.value.updatedAt = fallbackVerdict.generatedAt
        writeSafeRunJson(run, statePath, stateRes.value)
      }
    } else if (stateRes.status === "absent") {
      writeSafeRunJson(run, statePath, {
        version: 1,
        sessionId: manifest.sessionId,
        phase: "PRESENT_PARTIAL",
        tasks: {},
        updatedAt: fallbackVerdict.generatedAt,
      })
    }
    return { manifest, verdict: fallbackVerdict, alreadyFinalized: true, reportPath: reportFile }
  }

  const now = new Date().toISOString()
  const reason = clean(opts.reason || "Tournament halted before completion", 300)
  const ranked = rankCandidates(manifest.candidates)
  const survivingCount = ranked.filter((c) => c.status !== "pruned").length
  const bestNonPruned = ranked.find((c) => c.status !== "pruned")

  manifest.phase = opts.phase
  manifest.rankedCandidates = ranked
  manifest.cancelled = {
    reason,
    trigger: opts.trigger,
    cancelledBy: opts.cancelledBy ? clean(opts.cancelledBy, 64) : null,
    cancelledAt: now,
  }

  const verdictObj: TournamentVerdict = {
    version: 1,
    sessionId: manifest.sessionId,
    status: "PARTIAL",
    verdict: "PARTIAL",
    refereeAgent: null,
    phase: opts.phase,
    winnerId: bestNonPruned?.id ?? null,
    summary: `Partial tournament result (${opts.phase}): ${reason}`,
    trigger: opts.trigger,
    reason,
    totalCandidates: totalCandidateCount(manifest),
    survivingCandidates: survivingCount,
    iterationsCompleted: manifest.iteration,
    rankedCandidates: ranked,
    generatedAt: now,
  }

  manifest.verdict = verdictObj
  manifest.updatedAt = now

  const reportMd = renderTournamentReportMd(manifest, verdictObj)
  const interruptedPath = join(run, "interrupted.md")
  const statePath = join(run, "state.json")
  for (const target of [verdictPathOf(run), reportFile, interruptedPath, manifestPathOf(run), statePath]) {
    const check = ensureSafeRunSubpath(run, target)
    if (!check.ok) throw new Error(check.error)
  }
  writeSafeRunJson(run, verdictPathOf(run), verdictObj)
  writeSafeRunFile(run, reportFile, reportMd)
  writeSafeRunFile(
    run,
    interruptedPath,
    `# Interrupted Run — ${clean(manifest.sessionId, 64)}\n\n- **Phase:** ${opts.phase}\n- **Trigger:** ${opts.trigger}\n- **Reason:** ${reason}\n- **Recorded:** ${now}\n- **Partial report:** TOURNAMENT_REPORT.md\n`,
  )
  writeTournamentManifest(run, manifest)

  // Update state.json phase to PRESENT_PARTIAL safely.
  const stateRes = readBoundedRunJson<any>(run, statePath, MAX_MANIFEST_BYTES)
  if (stateRes.status === "ok") {
    const state = stateRes.value
    state.phase = "PRESENT_PARTIAL"
    state.updatedAt = now
    writeSafeRunJson(run, statePath, state)
  }

  return { manifest, verdict: verdictObj, alreadyFinalized: false, reportPath: reportFile }
}
