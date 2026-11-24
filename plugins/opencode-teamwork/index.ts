// @heretek-ai/opencode-teamwork-v2 — V2 port
//
// Original package: opencode-teamwork@0.2.1 (V1 plugin API)
// Ported to the OpenCode V2 plugin API (see https://opencode.ai/v2/docs/build/plugins).
//
// What changed vs the V1 plugin:
//   * Default export is now an object definition `{ id, setup }` instead of the
//     V1 async plugin function returning a `config` hook.
//   * Agent registration moved OUT of the plugin. The V2 AgentEditor has no
//     `add`, so plugins cannot create agents. The 15 `team/*` agents are
//     installed as markdown files under ~/.config/opencode/agents/team/.
//   * Commands are still registered by the plugin, via ctx.command.transform,
//     which is the V2 replacement for the V1 `config` hook's command injection.
//   * Command templates no longer use `{{ ... }}` handlebars (unsupported in V2)
//     and rely on `$ARGUMENTS` substitution.
//
// Deliberately dependency-free at runtime: no import of @opencode/plugin so the
// loader never has to resolve node_modules for this file. The object shape below
// is exactly what Plugin.define({ id, setup }) produces.

import { registerTeamworkTools, registerTeamworkHooks } from "./tools.ts"

type CommandSpec = {
  name: string
  description: string
  agent: string
  template: string
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "teamwork",
    description:
      "Sentinel — main dispatcher. Routes requests (explicit opt-in for massive-proof tournaments), provisions a worktree, builds the DAG, dispatches workers/verifiers/referees, iterates, merges. This is the user-facing /teamwork command.",
    agent: "team/sentinel",
    template: `$ARGUMENTS

Look in \`.opencode/teamwork/\` for a recent \`prompt_draft.md\`. If you find one, ask the user to confirm the session ID. If not, run \`teamwork_route\` first (which checks \`document-review\` BEFORE Math/Proof when a document is supplied for critique, while rejecting PR/code reviews, bare filenames without supplied docs, and theorem-solving/coding requests), then ask 1-2 short questions if ambiguous or run the crafter (via /teamwork-craft) or proceed.

Then:

0. Budget preflight: call \`teamwork_budget\`. If it reports console-credit budgeting applies (opencode/ models + opencode_console connected), call \`opencode_console_get_usage\`, compute \`remaining = min(limitDollars - spentDollars)\`, and ASK THE USER whether to use the FULL remaining budget or PARTIAL (half). Pass the choice to \`teamwork_plan\` or \`teamwork_document_triage\` as \`budgetUsd\` with \`budgetSource: "credits"\`.
1. Plan the run:
   - For \`document-review\`: call \`teamwork_document_triage\` with \`sessionId\`, the supplied \`document\` (\`path\` / \`url\` / \`content\`), \`request\`, \`fetchUrl: true\` (when a URL is supplied without inline \`content\`), and bounded tree shapes (\`maxSegments <= 8\`, \`reviewTreeShape <= [4,2,1]\`, \`synthTreeShape <= [4,1]\`). Skip git worktrees for \`document-review\`.
   - For coding / proof topologies: load the spec, then call \`teamwork_plan\` with the route's \`topology\` and the concrete task list \`tasks: [{ id, dependsOn, agent, maxRounds }]\` (both are required); pass the user's **verbatim** request (the text after /teamwork, before any spec rewrite) as \`request\` so \`<run>/ORIGINAL_REQUEST.md\` is written once, and pass the spec's numbered requirements as \`requirements: [{ id, text }]\` when it has acceptance criteria (otherwise the request-derived R1 is the baseline). Leave \`victoryAudit\` at its default \`required\`; only an explicit, recorded \`skip\` may bypass the final audit. Leave \`requireHandoffs\` at its default \`required\` when a request/requirements baseline exists; an explicit, recorded \`skip\` is allowed outside benchmark mode but is not the default. Pass \`verification: "strict"\` only when the user explicitly opts into strict verification (one falsifier challenge + one security-auditor audit per task); otherwise leave the \`standard\` default. It returns the canonical \`SESSION_ID\`. Never use a session id read from a file. Provision the sentinel worktree OUTSIDE the repo, quoting both args: \`git worktree add "\${TEAMWORK_WORKTREES_DIR:-../.teamwork-worktrees}/$SESSION_ID/sentinel" -b "teamwork/base-$SESSION_ID"\` (skip if not in a git repo).
2. Build / inspect the DAG in \`.opencode/teamwork/<session-id>/plan.dag.json\`. Independent tasks run in parallel; dependent ones in topological order.
3. Dispatch workers in topological order. Pass the run id (\`SESSION_ID\`) in every prompt and require each child to call \`teamwork_handoff({ sessionId: SESSION_ID, taskId, observation, logicChain, caveats, conclusion, verificationMethod })\` before reporting back; read \`.opencode/teamwork/<session-id>/handoffs/\` instead of replaying the child session.
   - For \`document-review\`: dispatch \`team/segment-reviewer\` per segment (\`seg-01\`..\`seg-0K\`) to persist bounded RSA nodes and \`unit-report.md\` via \`teamwork_document_record\`, then dispatch \`team/synthesizer\` on \`doc-synthesis\` to record \`synthesis/candidate-<I>.md\` and \`DOCUMENT_REVIEW_REPORT.md\` via \`teamwork_document_record\`.
   - For coding topologies: each worker gets its own worktree and scoped \`spec.json\`, returning \`patch.diff\` + \`summary.md\` + cost metrics.
   - On return: \`teamwork_cost({ taskId })\`, then \`teamwork_task_update\` with \`agent: "team/worker"\` (or \`"team/segment-reviewer"\` / \`"team/synthesizer"\`).
4. Dispatch verifiers (\`team/verifier\`) against each worker diff or document-review \`unit-report.md\` / \`DOCUMENT_REVIEW_REPORT.md\` vs \`DOCUMENT_TEXT_MAP.md\`. Aggregated results go in \`.opencode/teamwork/<session-id>/verify/summary.json\`. On each verifier report: \`teamwork_cost({ taskId })\`, then \`teamwork_task_update\` with \`agent: "team/verifier"\`.
5. If FAIL, send the verifier's \`feedback_for_worker.md\` back to the worker for the next round. Loop until PASS, maxRounds, or the advisory budget threshold is reached (stop non-essential dispatch yourself; only massive-proof tournaments refuse dispatch).
6. When all tasks PASS, run the mandatory pre-merge security audit via @team/security-auditor and teamwork_security_audit. Once approved (PASS), merge the sentinel worktree back to the user's branch. On partial, present the partial + the open verification reports.
7. After the run completes (full or partial), perform the independent final verification: spawn a \`team/verifier\` agent to check the final merged result against the spec's acceptance criteria, then have it call \`teamwork_final_verify\`. That tool computes the verdict from the per-task reports, the security audit, and the victory audit, stamps provenance, and writes \`.opencode/teamwork/$SESSION_ID/verify/final.json\` — it is the writer, so never hand-write that file. (\`teamwork_next\` only completes a run on a stamped report; a hand-written legacy report needs the explicit \`allowUnstamped: true\` bypass, which is recorded.) If the plan recorded \`verification: "strict"\`, then before \`teamwork_final_verify\` each task also needs a \`team/falsifier\` challenge (\`PASS\`) and a \`team/security-auditor\` audit (\`CLEAN\`) recorded via \`teamwork_wave_record\`; \`teamwork_next\` returns \`NEEDS_STRICT_WAVE\` until both exist, and a strict PASS writes \`GATE_STATUS.md\`. If \`teamwork_next\` returns \`NEEDS_HANDOFFS\` / \`BLOCKED_BY_HANDOFFS\`, dispatch the named \`taskId:agent\` pairs to call \`teamwork_handoff\`, then re-run \`teamwork_final_verify\`; \`final_verify\` rejects missing, stale, duplicate, unknown, or tampered handoffs but never parses handoff prose as a verdict.
8. Independent victory audit (mandatory fidelity gate): after the milestone gate PASS, dispatch a **fresh-session** \`team/victory-auditor\` with \`ORIGINAL_REQUEST.md\` and \`requirements.json\`. It must inspect the delivered artifacts and run/inspect the tests itself, then call \`teamwork_victory_audit\` with \`VICTORY CONFIRMED\` or \`VICTORY REJECTED\`, then call \`teamwork_handoff\` with the run id (omit \`taskId\`) so its run-level handoff cites \`verify/victory.json\`. Only report completion after \`CONFIRMED\` and \`teamwork_next\` returns \`ALL_PASSED\` (or the plan explicitly recorded \`victoryAudit: "skip"\`). On \`REJECTED\`, forward its findings and resume the team.

Hard caps (override in the spec if the user asks):
- 4 rounds per task (6 for proof, 1 for small-focused, 24h for massive-proof — explicit opt-in only, bounded tournament levels + budget preflight)
- Budget: derived from opencode_console credits when available (full or partial, per the user), else the default $20 session budget

When done, write \`.opencode/teamwork/<session-id>/final.md\` and present. Tell the user:
- Which topology you chose
- How many rounds each task took
- Total cost (estimated)
- Path to the final artifact
- Any unresolved verification reports`,
  },
  {
    name: "teamwork-craft",
    description:
      "Phase-1 prompt crafter. Runs the 9-step elicitation flow before a Teamwork run, produces prompt_draft.md. Use for any hard problem where you want a falsifiable spec before dispatching agents.",
    agent: "team/crafter",
    template: `$ARGUMENTS

The user wants to run a Teamwork session. Before dispatching agents, you need a spec.

Run the 9-step elicitation flow:

1. Elicit project idea (1-2 declarative sentences)
2. Identify ambiguity + scale (small-focused / iterative-coding / distributed-coding / proof / massive-proof / document-review)
3. Determine integrity mode (development / demo / benchmark)
4. Draft requirements $R_1 \\dots R_N$ (2-5 behavior-focused)
5. Design verification (forcing function — what makes the verifier say PASS)
6. Set acceptance criteria (markdown checkboxes for each $R_i$)
7. Configure model allocation (preset: anthropic/team/google/openai/free — or \`custom\` for per-role)
8. Set working directory
9. Assemble + validate (run the anti-pattern checks)

Save the spec to \`.opencode/teamwork/<session-id>/prompt_draft.md\`.

When the spec is approved by the user, they can run \`/teamwork <session-id>\` to dispatch the Sentinel.

If the user just wants speed, tell them: "Run \`/teamwork\` with your prompt. The Sentinel will ask the same 9 questions in compressed form. The wizard is the right tool for multi-hour / multi-day problems."`,
  },
  {
    name: "team-orchestrate",
    description:
      "Legacy v1 orchestrator loop. Use /teamwork (sentinel) for new runs. This is the original propose/falsify/synthesize/verify loop without DAG, worktrees, or cost tracking.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

You are the legacy v1 orchestrator. The user has explicitly requested the v1 loop (or is running a project that hasn't migrated to v2).

Follow the v1 run loop:

1. Scout first.
2. Propose 3-5 candidates in parallel.
3. Falsify each one. Mandatory.
4. Synthesize (unless iterative-coding).
5. Verify.
6. If FAIL, log a pitfall and re-propose.
7. Present the final artifact at \`.opencode/teamwork/<session-id>/final.md\`.

If you want the v2 features (DAG engine, git worktrees per agent, typed artifact bus, cost tracking, prompt-crafter wizard), use \`/teamwork\` instead.`,
  },
  {
    name: "team-propose",
    description:
      "Run only the propose step. Generates N candidate solutions in parallel and writes them under .opencode/teamwork/. Use when you want to inspect raw candidates before the falsifier step.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants raw candidates, not a full Teamwork run. Do this:

1. Pick a pattern from the prompt (default: distributed-coding).
2. Run scout first to gather context.
3. Dispatch \`@team/proposer\` N=3 times in parallel, each with a different strategy framing. If no strategy framing is obvious, use these defaults:
   - Candidate 1: "the textbook approach"
   - Candidate 2: "an unconventional / contrarian angle"
   - Candidate 3: "the minimal change that could work"
4. Write the candidates to \`.opencode/teamwork/<session-id>/candidates/cand-1.md\` through \`cand-3.md\`.
5. STOP after writing the candidates. Do not run falsifier, synthesizer, or verifier. The user will inspect and decide next.

Report back: where the candidates are, a 1-line summary of each, and any patterns you noticed across them (e.g. "all 3 candidates picked the same library — this might be the wrong choice").`,
  },
  {
    name: "team-falsify",
    description:
      "Run only the falsifier step on existing candidates. Use after /team-propose to get adversarial critique before deciding to synthesize.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants falsifier critiques of existing candidates. Do this:

1. List the candidates in \`.opencode/teamwork/<session-id>/candidates/\`.
2. For each candidate, dispatch \`@team/falsifier\`. Falsifiers run in parallel.
3. Write the critiques to \`.opencode/teamwork/<session-id>/critiques/crit-<n>.md\`.
4. After all critiques are in, write a meta-summary at \`.opencode/teamwork/<session-id>/critiques/summary.md\`:
   - How many candidates were killed (FATAL).
   - How many have SERIOUS findings.
   - How many pass with MINOR findings only.
   - Which failure modes appear across multiple candidates (these are likely real and the proposers should be told).
5. STOP. Do not synthesize. The user will decide.

Report back: the summary and a recommendation ("synthesis likely unnecessary, all 3 are broken in the same way" or "candidates diverge enough that synthesis will be hard" or "one clear winner, ready to verify").`,
  },
  {
    name: "team-synthesize",
    description:
      "Run the synthesizer on existing candidates + critiques. Use after /team-falsify when candidates have been critiqued and a merge is needed.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants a synthesis of existing candidates and their critiques. Do this:

1. Read all candidates in \`.opencode/teamwork/<session-id>/candidates/\`.
2. Read all critiques in \`.opencode/teamwork/<session-id>/critiques/\`.
3. Read the pitfall registry \`.opencode/teamwork/<session-id>/pitfalls.md\` if it exists.
4. Dispatch \`@team/synthesizer\` with all of the above.
5. Write the synthesis to \`.opencode/teamwork/<session-id>/synthesis/syn-1.md\`.
6. STOP. Do not verify. The user will run /teamwork or call the verifier directly.

Report back: where the synthesis is, what was kept from each source candidate, and any new failure modes the synthesizer flagged. If the synthesis was inconclusive, say so explicitly and explain why.`,
  },
  {
    name: "team-review",
    description:
      "Run the verifier on the current synthesis or candidate. Use after /team-synthesize (or directly on a candidate) to get a binary PASS/FAIL with evidence.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants verification of a specific artifact. Do this:

1. Find the artifact: the latest file in \`.opencode/teamwork/<session-id>/synthesis/\`, or fall back to the latest in \`candidates/\` if no synthesis exists.
2. Dispatch \`@team/verifier\` with the artifact and the relevant critiques.
3. Write the verification report to \`.opencode/teamwork/<session-id>/verify/v-<n>.md\`.
4. STOP. The user will read the report and decide.

Report back: PASS or FAIL, a 1-line summary of the checks, and (if FAIL) the specific commands to reproduce. Do not propose a fix.`,
  },
]

/**
 * The host version this port is verified against. `package.json` declares the
 * same window as `peerDependencies["@opencode/plugin"] = "^2.4"`; the peer is
 * optional so installs stay dependency-free (the plugin never imports it).
 */
export const OPENCODE_PLUGIN_PEER = "^2.4"
export const OPENCODE_TESTED_MAJOR = 2
export const OPENCODE_TESTED_MINOR = 4

/**
 * `ctx.app.version` check. A different major/minor than the verified pair is a
 * warning, not a refusal: the plugin still loads, because a hard failure in
 * `setup` would take the whole session down. Returns the parsed pair so tests
 * can assert the decision without capturing console output.
 */
export function checkOpencodeVersion(version: unknown): {
  ok: boolean
  major?: number
  minor?: number
  warning?: string
} {
  const raw = typeof version === "string" ? version.trim() : ""
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(raw)
  if (!match) {
    return {
      ok: false,
      warning: `could not determine the OpenCode version (ctx.app.version=${JSON.stringify(version)}); this port is verified against ${OPENCODE_TESTED_MAJOR}.${OPENCODE_TESTED_MINOR}.x (peer ${OPENCODE_PLUGIN_PEER})`,
    }
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major !== OPENCODE_TESTED_MAJOR || minor !== OPENCODE_TESTED_MINOR) {
    return {
      ok: false,
      major,
      minor,
      warning: `OpenCode ${major}.${minor}.x is outside the verified pair ${OPENCODE_TESTED_MAJOR}.${OPENCODE_TESTED_MINOR}.x (peer ${OPENCODE_PLUGIN_PEER}); tool registration and plugin hooks may have changed`,
    }
  }
  return { ok: true, major, minor }
}

// Agents are read by OpenCode's config-agent plugin before this plugin's
// `setup` runs, so writing them here could never make them visible in the
// current session (they would only appear after a restart). Installation
// therefore belongs to `init`/postinstall; `setup` only verifies and warns.
// The check is read-only and never fails the plugin load.
export async function warnMissingAgents(configDir?: string): Promise<{ configDir?: string; targetDir?: string; missing: string[] }> {
  try {
    const lib = await import("../../lib/team.mjs")
    const result = configDir ? lib.verifyAgents({ configDir }) : lib.verifyAgents()
    if (result.missing.length > 0) {
      console.warn(
        `[opencode-teamwork] ${result.missing.length}/${lib.TEAM_AGENTS.length} team agent file(s) missing in ${result.targetDir}: ${result.missing.join(", ")}. ` +
          "Run `npx @heretek-ai/opencode-teamwork-v2 init` (or reinstall the package) and restart OpenCode: agents are loaded when the config is read, so this plugin cannot install them mid-session.",
      )
    }
    return result
  } catch {
    // Vendored copy without lib/, or an unreadable config dir. Not fatal.
    return { missing: [] }
  }
}

export default {
  id: "opencode-teamwork",
  async setup(ctx: any) {
    const versionCheck = checkOpencodeVersion(ctx?.app?.version)
    if (!versionCheck.ok) console.warn(`[opencode-teamwork] ${versionCheck.warning}`)
    await warnMissingAgents()
    const root = (ctx?.location?.directory as string) || process.cwd()
    await registerTeamworkTools(ctx, root)
    await registerTeamworkHooks(ctx, root)
    await ctx.command.transform((editor: any) => {
      for (const cmd of COMMANDS) {
        editor.add({
          name: cmd.name,
          description: cmd.description,
          execute: async ({ sessionID, prompt, delivery }: any) => {
            // V1 commands selected an agent via frontmatter; V2 plugin commands
            // must switch the session agent explicitly.
            await ctx.session.switchAgent({ sessionID, agent: cmd.agent })
            const args = typeof prompt?.text === "string" ? prompt.text : ""
            const text = cmd.template.split("$ARGUMENTS").join(args)
            await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
          },
        })
      }
    })
  },
}
