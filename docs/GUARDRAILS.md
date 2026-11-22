# Guardrails

The security model for `@heretek-ai/opencode-teamwork-v2`, and how each control is enforced
(in code, not just in a prompt).

## Threat model

An agent that can **read untrusted content** (repo files, `prompt_draft.md`,
`state.json`, web pages, issues) and also **run shell / edit / fetch** is one
indirect-prompt-injection away from exfiltration or destruction. Teamwork agents
run with the user's full privileges by default, so the controls below exist to
remove the sharpest edges.

## Controls

| Control | Where | What it stops |
| --- | --- | --- |
| **Session-id allowlist** `^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$` + containment assert | `plugins/opencode-teamwork/tools.ts` (`resolveRun`) | Path traversal / arbitrary file write or append via `sessionId` in any `teamwork_*` tool. |
| **Server-derived session id** — `teamwork_plan` generates and returns the id; prompts must use it, never a value read from a file | `tools.ts` + `agents/team/sentinel.md` | Command injection through a malicious `prompt_draft.md` session id interpolated into `git worktree` shell lines. |
| **Read-only enforcement (per-agent deny list)** | `tools.ts` `registerTeamworkHooks` → `permission.hook("evaluate")` | `edit` for the verifier, falsifier, scout, security auditor, segment reviewer, formalization reviewer, and referee, so none can write through the `edit` tool; plus `shell` for the falsifier, segment reviewer, formalization reviewer, and referee, `webfetch` for the verifier, security auditor, segment reviewer, formalization reviewer, and referee, and `subagent` for all seven. `shell` remains available to the verifier, scout and security auditor and **can modify files**, so only the falsifier, segment reviewer, formalization reviewer, and referee are left without a shell write path. Fail-closed: a hook that cannot register fails plugin load. |
| **Document Review containment & bounds** | `document-review.ts` + `tools.ts` (`teamwork_document_triage`, `teamwork_document_record`) | Segment-ID allowlist `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, `realpathSync` + `O_NOFOLLOW` symlink/escape refusal on source documents and `document-review/` artifacts, 16 MiB file / 512 KiB inline / 4 MiB PDF-inflate caps, and immutable RSA bounds (`maxSegments <= 8`, `reviewTreeShape <= [4,2,1]`, `synthTreeShape <= [4,1]`). |
| **LEMMA path & process containment** | `plugins/opencode-teamwork/lemma.ts` + `tools.ts` | Validates `LEMMA_ID` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), refuses symlinks component-wise (`lstatSync` + `O_NOFOLLOW`), enforces `realpathSync` containment inside the run dir, executes `lean`/`lake` (and probes the LEAP CLI `leap`, legacy `leap-tools`) via `execFileSync` fixed argv (zero shell interpolation), and rejects `sorry`/`admit`/unauthorized `axiom` even on exit `0`. The transitive-axiom allowlist is approved once at plan time (`lemmaPolicy.allowedAxioms`) and persisted in `lemma/manifest.json`; `teamwork_lemma_verify` reads it from disk and refuses any caller-supplied `allowedAxioms`, so an agent that can call the tool cannot widen the gate. Missing (legacy) policies fail closed to the standard axioms. |
| **Sanitised run-state injection** — only whitelisted/enumerated fields, newlines stripped, id from the directory name | `tools.ts` `describeRun` → `session.hook("context")` | Stored prompt injection from an untrusted `state.json` into a system prompt. |
| **Non-destructive installer** — `refresh` defaults to false; `--refresh` opts in with backup | `lib/team.mjs` `installAgents` | Silent overwrite of a user's edited agent prompts. |
| **Non-destructive config edits** — refuse symlinks, never rewrite commented (JSONC) configs | `lib/team.mjs` `registerPlugin` | Comment loss / value corruption / symlink write-through when editing `opencode.json(c)`. |
| **Load-time writes are create-only** | `lib/team.mjs` `ensureAgents` / `writeReferenceFile({overwrite:false})` | `ARTIFACTS.md` / agents being rewritten on every plugin load. |

## Known gaps / non-goals

- **No worktree/cwd confinement in code.** Worker/verifier prompts *say* "don't
  edit outside your worktree," but with `resource: "*"` nothing enforces it.
  `git worktree` isolation is prompt-level. (Mitigated only by the permission
  hook: for the verifier, scout and security auditor it denies `edit` but not
  `shell`, which can write anywhere; the falsifier, segment reviewer, and
  formalization reviewer also have `shell` denied.)
- **`constraints.network` / `constraints.sandbox`** in `docs/ARTIFACTS.md` are
  descriptive; they are not enforced. "Network: denied" is honor-system.
- **Plugin tools are not agent-scoped.** The permission layer does not mediate
  `teamwork_*` tool calls, so a read-only agent can still call `teamwork_cost`
  etc. The session-id allowlist bounds the damage.
- **Run artifacts are trusted inputs.** `state.json` / `plan.dag.json` /
  `prompt_draft.md` living in the repo are treated as control data (now
  sanitised before injection, but still unauthenticated).
- **No sandbox for shell.** Agents run with full user privileges and network.

## Running an audit

Use the `team/security-auditor` agent (clean context; `edit` denied, `shell`
available) or a fresh subagent. It is also wired into the prompt linter's
expectations; the guardrail invariants (session-id validation present, no stale
references) are checked in CI by `scripts/lint-prompts.mjs`.
