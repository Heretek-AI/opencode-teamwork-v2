// opencode-teamwork — control-plane tool authorization
//
// Plugin tools are not mediated by the permission hook: unless a tool checks
// the calling session itself, any agent (or any session) can call it. The
// victory audit, strict-wave recorders, and verifier report already derive the
// caller from the trusted session and require descent from the run root. This
// module extends that discipline to the rest of the control plane.
//
// Rules:
//   * Authorization uses the trusted session agent (`ctx.session.get`), never a
//     caller-supplied `agent` input.
//   * Mutating/control tools fail closed when the identity cannot be resolved.
//   * A run-bound tool additionally requires the caller to descend from the
//     run's recorded root session (the plan-time Sentinel). Tools that the
//     Sentinel itself must call may run in the root session.
//   * Read-only tools stay available to every installed `team/*` role and do
//     not require a resolvable identity (they cannot change run state).
//
// Zero runtime dependencies. Erasable TypeScript only.

export const INSTALLED_TEAM_ROLES = new Set([
  "team/crafter",
  "team/sentinel",
  "team/orchestrator",
  "team/scout",
  "team/worker",
  "team/proof-worker",
  "team/formalization-reviewer",
  "team/proposer",
  "team/falsifier",
  "team/synthesizer",
  "team/verifier",
  "team/security-auditor",
  "team/segment-reviewer",
  "team/referee",
  "team/victory-auditor",
])

const SENTINEL = ["team/sentinel", "team/orchestrator"]
const SENTINEL_ONLY = ["team/sentinel"]
const ALL_TEAM = Array.from(INSTALLED_TEAM_ROLES)

type RoleSpec = {
  /** Roles allowed for `action`, keyed by action. `*` is the default. */
  actions: Record<string, string[]>
  /**
   * Strict descendants only (the root session itself is refused). Tools the
   * Sentinel must call should leave this false.
   */
  descendantOnly?: boolean
  /** Read-only: an unresolved identity is allowed. */
  readOnly?: boolean
  /** When true, no recorded root means the call is refused (run-backed tool). */
  requireRoot?: boolean
  /** Actions that may run before the run root exists (e.g. tournament init). */
  noRootActions?: string[]
}

const RULES: Record<string, RoleSpec> = {
  // Creation / planning. The run root does not exist yet on the first plan.
  plan: { actions: { "*": ["team/sentinel", "team/crafter"] } },
  document_triage: { actions: { "*": SENTINEL } },
  route: { actions: { "*": ALL_TEAM }, readOnly: true },

  // Read-only inspection.
  status: { actions: { "*": ALL_TEAM }, readOnly: true },
  resume: { actions: { "*": ALL_TEAM }, readOnly: true },
  cost: { actions: { "*": ALL_TEAM }, readOnly: true },
  preflight: { actions: { "*": SENTINEL } },
  budget: { actions: { "*": SENTINEL } },

  // Lifecycle / gates.
  next: { actions: { "*": SENTINEL } },
  task_update: {
    actions: {
      "*": [
        "team/sentinel",
        "team/orchestrator",
        "team/worker",
        "team/proof-worker",
        "team/segment-reviewer",
        "team/synthesizer",
        "team/verifier",
      ],
    },
  },
  pitfall: { actions: { "*": ALL_TEAM } },
  security_audit: { actions: { "*": ["team/security-auditor"] }, descendantOnly: true, requireRoot: true },
  final_verify: { actions: { "*": ["team/verifier", "team/sentinel"] } },
  victory_audit: { actions: { "*": ["team/victory-auditor"] }, descendantOnly: true, requireRoot: true },
  wave_record: {
    actions: {
      challenge: ["team/falsifier"],
      audit: ["team/security-auditor"],
    },
    descendantOnly: true,
    requireRoot: true,
  },
  report: { actions: { "*": ["team/verifier"] }, descendantOnly: true, requireRoot: true },
  handoff: {
    actions: {
      "*": [
        "team/worker",
        "team/proof-worker",
        "team/verifier",
        "team/falsifier",
        "team/security-auditor",
        "team/victory-auditor",
        "team/sentinel",
        "team/orchestrator",
      ],
    },
    requireRoot: true,
  },

  // Git worktrees.
  worktree: {
    actions: {
      setup: SENTINEL_ONLY,
      cleanup: SENTINEL_ONLY,
      merge: SENTINEL_ONLY,
      resolve: SENTINEL_ONLY,
      diff: ["team/sentinel", "team/worker", "team/verifier"],
    },
    requireRoot: true,
  },

  // Document review.
  document_record: {
    actions: {
      segment_analysis: ["team/segment-reviewer"],
      segment_aggregate: ["team/segment-reviewer"],
      segment_report: ["team/segment-reviewer"],
      synthesis_candidate: ["team/synthesizer"],
      final_report: ["team/synthesizer"],
    },
    descendantOnly: true,
    requireRoot: true,
  },

  // LEMMA.
  lemma_probe: { actions: { "*": SENTINEL } },
  lemma_formalize: { actions: { "*": ["team/formalization-reviewer", "team/proof-worker"] }, descendantOnly: true, requireRoot: true },
  lemma_node: { actions: { "*": ["team/proof-worker"] }, descendantOnly: true, requireRoot: true },
  lemma_verify: { actions: { "*": ["team/verifier"] }, descendantOnly: true, requireRoot: true },

  // Bounded tournament.
  tournament: {
    actions: {
      init: SENTINEL,
      estimate: SENTINEL,
      cancel: SENTINEL,
      status: SENTINEL,
      propose: ["team/proposer", "team/proof-worker"],
      falsify: ["team/falsifier"],
      merge: ["team/synthesizer"],
      score: ["team/referee"],
      audit: ["team/referee"],
    },
    requireRoot: true,
    noRootActions: ["init", "estimate", "status"],
  },
}

export type AuthorizationFailureCode =
  | "AUTHZ_UNKNOWN_TOOL"
  | "AUTHZ_UNKNOWN_ACTION"
  | "AUTHZ_IDENTITY_UNRESOLVED"
  | "AUTHZ_ROLE_DENIED"
  | "AUTHZ_ROOT_REQUIRED"
  | "AUTHZ_SESSION_TREE"

export type AuthorizationDecision =
  | { ok: true }
  | { ok: false; error: string; code: AuthorizationFailureCode }

export interface AuthorizationOptions {
  /** Resolved run directory, when the tool operates on a run. */
  run?: string
  /** The run's recorded root session (plan-time Sentinel). */
  rootSessionId?: string
  /** Calling session, used for the descendant check. */
  sessionID?: string
  /** Trusted session-lookup surface (`ctx.session.get`). */
  ctx?: any
  /**
   * Skip the descendant check. Only for tools that run before a root exists
   * (the initial plan) or that are explicitly read-only.
   */
  skipSessionTree?: boolean
}

/** Normalize `teamwork_*` tool names to their namespace-local name. */
function normalizeToolName(toolName: string): string {
  const raw = String(toolName || "").trim().toLowerCase()
  return raw.startsWith("teamwork_") ? raw.slice("teamwork_".length) : raw
}

function normalizeAction(action: string | undefined): string {
  return String(action || "").trim().toLowerCase()
}

function describeRoles(roles: string[]): string {
  return roles.length === 1 ? roles[0] : roles.join(" | ")
}

function deny(code: AuthorizationFailureCode, error: string): AuthorizationDecision {
  return { ok: false, code, error }
}

const SESSION_TREE_MAX_DEPTH = 32

function cleanId(value: unknown): string {
  if (value === undefined || value === null) return ""
  return String(value).replace(/[^0-9A-Za-z._:-]/g, "").slice(0, 80)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

/**
 * Session-tree binding: the caller must be the run root (only when the tool
 * permits it) or a strict descendant of it. Fails closed when ancestry cannot
 * be resolved.
 */
export async function requireDescendantSession(
  ctx: any,
  rootSessionId: string | undefined,
  sessionID: string | undefined,
  opts: { allowRoot?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!sessionID) return { ok: false, reason: "no session identity was supplied" }
  if (!rootSessionId) return { ok: false, reason: "the run has no recorded rootSessionId (fail closed)" }
  if (sessionID === rootSessionId) {
    if (opts.allowRoot) return { ok: true }
    return { ok: false, reason: "the caller is the root session, not a descendant (fail closed)" }
  }
  let current = sessionID
  for (let depth = 0; depth < SESSION_TREE_MAX_DEPTH; depth++) {
    let info: any
    try {
      if (typeof ctx?.session?.get !== "function") {
        return { ok: false, reason: "ctx.session.get is unavailable, so session ancestry cannot be resolved (fail closed)" }
      }
      info = await withTimeout(Promise.resolve(ctx.session.get({ sessionID: current })), 2000)
    } catch {
      return { ok: false, reason: `session ${cleanId(current)} could not be resolved (fail closed)` }
    }
    const parent = info?.parentID ?? info?.parentId ?? info?.parent_id
    if (typeof parent !== "string" || parent.trim() === "") {
      return {
        ok: false,
        reason: `session ${cleanId(current)} has no parent, so it does not descend from ${cleanId(rootSessionId)} (fail closed)`,
      }
    }
    if (parent === rootSessionId) return { ok: true }
    current = parent
  }
  return { ok: false, reason: `session ancestry exceeds ${SESSION_TREE_MAX_DEPTH} levels (fail closed)` }
}

/**
 * Authorize one control-plane call. The caller agent must be the trusted agent
 * resolved for the calling session; `action` selects an action-specific role
 * set where the tool has one. Returns a refusal message ready for the tool's
 * `content` field.
 */
export async function authorizeToolCall(
  toolName: string,
  action: string | undefined,
  callerAgent: string | undefined,
  opts: AuthorizationOptions = {},
): Promise<AuthorizationDecision> {
  const tool = normalizeToolName(toolName)
  const rule = RULES[tool]
  if (!rule) return deny("AUTHZ_UNKNOWN_TOOL", `refused: ${tool} has no authorization rule (fail closed); nothing was written`)

  const act = normalizeAction(action)
  const roles = rule.actions[act] ?? rule.actions["*"]
  if (!roles) {
    const allowed = Object.keys(rule.actions).filter((key) => key !== "*")
    return deny(
      "AUTHZ_UNKNOWN_ACTION",
      `refused: unknown ${tool} action "${act || "(missing)"}" (allowed: ${allowed.join(" | ")}); nothing was written`,
    )
  }

  const agent = typeof callerAgent === "string" ? callerAgent.trim() : ""
  if (!agent) {
    if (rule.readOnly) return { ok: true }
    return deny(
      "AUTHZ_IDENTITY_UNRESOLVED",
      `refused: ${tool} needs a trusted session identity (no calling-session agent could be resolved; fail closed); nothing was written`,
    )
  }
  if (!INSTALLED_TEAM_ROLES.has(agent) || !roles.includes(agent)) {
    const actionLabel = act ? ` action "${act}"` : ""
    return deny(
      "AUTHZ_ROLE_DENIED",
      `refused: ${tool}${actionLabel} is restricted to ${describeRoles(roles)} (trusted session agent: ${cleanId(agent)}); nothing was written`,
    )
  }

  if (rule.readOnly) return { ok: true }
  if (opts.skipSessionTree) return { ok: true }

  const root = typeof opts.rootSessionId === "string" && opts.rootSessionId.trim() ? opts.rootSessionId : undefined
  if (!root) {
    if (rule.requireRoot && !(rule.noRootActions ?? []).includes(act)) {
      return deny(
        "AUTHZ_ROOT_REQUIRED",
        `refused: ${tool} requires the run's recorded rootSessionId, but none was found (fail closed); nothing was written`,
      )
    }
    return { ok: true }
  }

  const ancestry = await requireDescendantSession(opts.ctx, root, opts.sessionID, {
    allowRoot: !rule.descendantOnly,
  })
  if (!ancestry.ok) {
    return deny(
      "AUTHZ_SESSION_TREE",
      `refused: ${tool} must be called from ${rule.descendantOnly ? "a session that descends from" : "the run root or a session that descends from"} the run root (${cleanId(root)}); ${ancestry.reason}; nothing was written`,
    )
  }
  return { ok: true }
}
