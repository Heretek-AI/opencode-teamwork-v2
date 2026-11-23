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
| **Read-only enforcement (per-agent deny list)** | `tools.ts` `registerTeamworkHooks` → `permission.hook("evaluate")` | `edit` for the verifier, falsifier, scout, security auditor, segment reviewer, formalization reviewer, referee, and victory auditor, so none can write through the `edit` tool; plus `shell` for the falsifier, segment reviewer, formalization reviewer, and referee, `webfetch` for the verifier, security auditor, segment reviewer, formalization reviewer, referee, and victory auditor, and `subagent` for all eight. `shell` remains available to the verifier, scout, security auditor, and victory auditor and **can modify files**, so only the falsifier, segment reviewer, formalization reviewer, and referee are left without a shell write path. Fail-closed: a hook that cannot register fails plugin load. |
| **Document Review containment & bounds** | `document-review.ts` + `tools.ts` (`teamwork_document_triage`, `teamwork_document_record`) | Segment-ID allowlist `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, `realpathSync` + `O_NOFOLLOW` symlink/escape refusal on source documents and `document-review/` artifacts, 16 MiB file / 512 KiB inline / 4 MiB PDF-inflate caps, and immutable RSA bounds (`maxSegments <= 8`, `reviewTreeShape <= [4,2,1]`, `synthTreeShape <= [4,1]`). URL ingestion goes through the SSRF guard below. |
| **Outbound URL SSRF guard** | `plugins/opencode-teamwork/url-guard.ts` + `document-review.ts` (`document.url`) and `tools.ts` (`teamwork_plan`/`teamwork_preflight` URL checks) | Only `http`/`https`; embedded credentials are refused. The hostname is resolved by the guard and **every** answer is checked; loopback, private, carrier-grade NAT, link-local (including cloud metadata `169.254.169.254`), unspecified, multicast, reserved, documentation, 6to4/Teredo, unique-local, and IPv4-mapped/compatible IPv6 addresses are rejected. The connection is pinned to the validated address (`lookup`) so a second DNS answer cannot rebind it. Redirects are never followed: a `Location` is validated before the call refuses the redirect, so a redirect cannot reach a blocked target. Timeouts (3 s), response-size caps (16 MiB), and `HEAD`-only preflight are unchanged. `OPENCODE_TEAMWORK_ALLOW_LOCALHOST=1` is an explicit test/development opt-in that permits **loopback only** (never private/link-local/metadata); default is deny. |
| **Control-plane tool authorization** | `plugins/opencode-teamwork/authorize.ts` + every run-mutating `teamwork_*` tool | Plugin tools are not mediated by the permission hook, so each control tool derives the caller from the trusted session (`ctx.session.get`, never a caller-supplied `agent` label) and applies a central role map: plan/triage to sentinel-orchestrator lanes, lifecycle updates to task owners, gates to their auditors, LEMMA/tournament actions to their specialists, and worktree setup/merge/resolve to the sentinel. A run-bound tool also requires the caller to descend from the plan-time `rootSessionId` (tools the sentinel must call may run in the root session; auditors/reporters/wave recorders must be strict descendants). Unresolved identity fails closed for mutating/control tools. Read-only `status`/`resume`/`cost` stay available to every installed `team/*` role. |
| **LEMMA path & process containment** | `plugins/opencode-teamwork/lemma.ts` + `tools.ts` | Validates `LEMMA_ID` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), refuses symlinks component-wise (`lstatSync` + `O_NOFOLLOW`), enforces `realpathSync` containment inside the run dir, executes `lean`/`lake` (and probes the LEAP CLI `leap`, legacy `leap-tools`) via `execFileSync` fixed argv (zero shell interpolation), and rejects `sorry`/`admit`/unauthorized `axiom` even on exit `0`. The transitive-axiom allowlist is approved once at plan time (`lemmaPolicy.allowedAxioms`) and persisted in `lemma/manifest.json`; `teamwork_lemma_verify` reads it from disk and refuses any caller-supplied `allowedAxioms`, so an agent that can call the tool cannot widen the gate. Missing (legacy) policies fail closed to the standard axioms. |
| **Sanitised run-state injection** — only whitelisted/enumerated fields, newlines stripped, id from the directory name | `tools.ts` `describeRun` → `session.hook("context")` | Stored prompt injection from an untrusted `state.json` into a system prompt. |
| **Run-artifact read containment (ADR 0004)** — shared leaf `safe-fs.mjs`; open → fstat → regular → size → **fd containment** → bounded read | `plugins/opencode-teamwork/safe-fs.mjs` + `tournament.ts`, `tools.ts`, `lemma.ts`, `lib/{bounded-read,export,timeline,runs}.mjs` | Intermediate-directory symlink swaps that redirect a run read outside `<run>/`. On Linux with a usable `/proc/self/fd` the opened descriptor's real path must stay under the run's realpath; bytes are never read from a refused fd. Rootless readers (`readRegularBounded` / `readBounded`) keep the final-component `O_NOFOLLOW` protection only. On Linux with unusable procfs, existing-file reads fail closed. On macOS/Windows the check is unavailable and the previous behavior (and residual risk) remains. |
| **Strict-wave identity, report binding & write-once** | `tools.ts` (`teamwork_wave_record` + `deriveCallerAgent`) and `strict.ts` | The trusted session identity is the only authorization source: `challenge` requires `team/falsifier`, `audit` requires `team/security-auditor`, and there is no caller-supplied agent label. The tool also refuses a task absent from `plan.dag.json`, a missing/non-PASS verifier report, any verdict other than `challenge: PASS` / `audit: CLEAN`, and a repeat recording for the same report hash. Each verdict stores the sha256 of the exact verifier report bytes it approved; the final gate requires a match, so a reworked task cannot reuse an earlier wave. A changed report is the only overwrite path (the old verdict is stale). `notes`/`evidence` are sanitised and bounded; the artifact is written atomically with symlink refusal and realpath containment, so a planted link cannot redirect it. |
| **Artifact authenticity (ADR 0005)** — canonical-JSON HMAC-SHA256 `_auth` envelopes + a storage-backed digest index + a signed `run.manifest.json` baseline | `plugins/opencode-teamwork/auth.ts`, `tools.ts`, `victory.ts`, `strict.ts` | A writer limited to the run directory forging a verifier report, security audit, strict-wave verdict, victory verdict, or final verdict; copying an `_auth` between files/runs; editing a signed verdict field; and downgrading `verification`/`victoryAudit`/`integrityMode`/plan/request/requirements/LEMMA policy after the plan. `teamwork_report` is the trusted writer for verifier reports, and `victory_audit`/`wave_record`/`report` require the caller session to descend from the plan-time `rootSessionId`. Legacy unsigned runs require an explicit, recorded `allowUnsignedLegacy` bypass at plan and completion. **Boundary:** a same-UID shell with read access to `opencode.db` / the plugin KV store can read the HMAC key; Phase B decides key isolation. The CLI readers only display `signed`/`unsigned`/`unknown` and never claim verification. |
| **Non-destructive installer** — `refresh` defaults to false; `--refresh` opts in with backup | `lib/team.mjs` `installAgents` | Silent overwrite of a user's edited agent prompts. |
| **Non-destructive config edits** — refuse symlinks, never rewrite commented (JSONC) configs | `lib/team.mjs` `registerPlugin` | Comment loss / value corruption / symlink write-through when editing `opencode.json(c)`. |
| **Load-time writes are create-only** | `lib/team.mjs` `ensureAgents` / `writeReferenceFile({overwrite:false})` | `ARTIFACTS.md` / agents being rewritten on every plugin load. |

## Known gaps / non-goals

- **No worktree/cwd confinement in code.** Worker/verifier prompts *say* "don't
  edit outside your worktree," but with `resource: "*"` nothing enforces it.
  `git worktree` isolation is prompt-level. (Mitigated only by the permission
  hook: for the verifier, scout, security auditor, and victory auditor it denies
  `edit` but not `shell`, which can write anywhere; the falsifier, segment
  reviewer, formalization reviewer, and referee also have `shell` denied.)
- **`constraints.network` is enforced for `webfetch` only.** When a run's
  `prompt_draft.md` or any per-task `spec.json` says `network: denied`, the
  permission hook denies `webfetch` for every `team/*` agent. `constraints.sandbox`
  remains descriptive, and `shell` can still reach the network: there is no
  sandbox for shell.
- **Plugin tool scoping is role-based, not capability isolation.** Every
  run-mutating `teamwork_*` tool checks the trusted session agent against
  `authorize.ts` and (for run-bound tools) descent from the plan-time
  `rootSessionId`. Read-only `status`/`resume`/`cost` remain available to every
  installed `team/*` role. This stops an arbitrary agent from calling
  `teamwork_security_audit`, `teamwork_final_verify`, `teamwork_victory_audit`,
  etc., but it is not an OS sandbox: a same-UID process outside the plugin can
  still write run files, and the artifact-trust boundary below still applies.
- **Victory-auditor independence is a fresh session, not capability
  isolation.** `team/victory-auditor` keeps `shell` (which can modify files) and
  is denied `edit`, `webfetch`, and `subagent`. Its independence comes from
  running in a fresh session that inspects the delivered artifacts and executes
  tests itself, not from a reduced capability set. There is no scoped
  test-runner tool; if one is added it must be role-scoped in `authorize.ts`
  and covered by the engine suite.
- **The SSRF guard covers plugin URL ingress, not shell.** `document.url` and
  preflight URL checks use `url-guard.ts`; an agent with `shell` or `webfetch`
  can still reach the network directly. `constraints.network: denied` remains a
  `webfetch`-only guard (see above).
- **Artifact authenticity is tamper-evident, not local-user-proof.**
  Control-plane artifacts carry an HMAC `_auth` envelope and a digest-index
  entry outside the run dir ([ADR 0005](adr/0005-artifact-authenticity.md)), so
  a run-dir-only writer can no longer forge a PASS, copy an envelope between
  files/runs, or downgrade the signed plan baseline. **This does not stop a
  same-UID shell:** with read access to `opencode.db` (or the plugin KV backing
  store) it can read the HMAC key and mint a valid envelope, and `ctx.storage`
  is in the same user account, so the digest index is not a separate privilege
  domain either. Moving the key to a
  same-UID helper, using the OS keychain, or gating on `ctx.permission.assert`
  does not fix this: a same-UID helper is a signing oracle, the keychain is
  same-UID accessible, and `assert` is auto-approvable under `--auto`. **No
  in-process, zero-dependency control fixes this.** Phase B options and the
  administrator-only requirements (separate UID/system service, TPM/`tss`
  access, SELinux labels) are assessed in
  [ADR 0006](adr/0006-artifact-trust-isolation.md), which recommends accepting
  and documenting this boundary for now; a real Phase B needs a different
  privilege domain and a non-oracle signing decision (a human-presence gate or
  an independent verifier). Until then, do not claim protection against a local
  user who can read the database, and do not describe artifacts as
  tamper-proof, signed by a trusted authority, or safe against a local user.
  Free-form inputs that are not control-plane verdicts (`state.json` task
  summaries, `pitfalls.md`, `prompt_draft.md`, spec text) remain untrusted and
  are sanitised before injection, not authenticated.
- **No sandbox for shell.** Agents run with full user privileges and network.
- **Read containment is platform-specific.** `safe-fs.mjs` enforces the
  post-open containment check only on Linux with a mounted, usable
  `/proc/self/fd`. If Linux procfs is unavailable, existing-file reads are
  refused (fail closed); absent files still read as absent. macOS and Windows
  have no pure-JS fd-to-path primitive, so they keep `O_NOFOLLOW`/lstat,
  `O_NONBLOCK`, `fstat` and the byte cap, and the intermediate-component symlink
  race remains a documented residual risk there.
- **Write-path containment is not claimed.** `writeSafeRunFile` (tournament)
  and `writeTextSafe`/`writeJsonSafe` (tools) validate by path and then
  create/mkdir/rename by path. A raced intermediate directory can still redirect
  a write; ADR 0004 fixes the read path only. The random `wx` temp plus rename
  does prevent a planted temp-path symlink from overwriting a victim.

## Running an audit

Use the `team/security-auditor` agent (clean context; `edit` denied, `shell`
available) or a fresh subagent. It is also wired into the prompt linter's
expectations; the guardrail invariants (session-id validation present, no stale
references) are checked in CI by `scripts/lint-prompts.mjs`.
