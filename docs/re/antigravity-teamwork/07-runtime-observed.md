# Runtime Observation — Antigravity `/teamwork` (print mode, partial)

**Status: PARTIAL — dispatched, orchestrator quota-blocked; inline fallback observed.** Observed on **2026-11-21** against `agy --version` **1.5.14** [OBSERVED], in two phases: 18:36–18:48 local (UTC−05:00), three print-mode attempts that were cut short by the client-side print timeout and by HTTP 429 quota (§3, O1–O7); and 19:11–19:17 local, a live `/teamwork-preview` print-mode run that **dispatched** a `teamwork` subagent, had it refused twice by quota, and saw the sentinel **complete the work inline** (§3.5). The slash command is therefore no longer unexercised. What is still missing from **this run** is an **orchestrator turn**: neither dispatched conversation produced content, so route selection, per-role dispatch, gate evaluation and artifact writes by a live `/teamwork-preview` orchestrator remain `UNKNOWN` here. The interview gate is observed separately in a completed prior run (`14`), not in this run. [OBSERVED for dispatch and fallback; UNKNOWN for this run's workflow]

The document remains split into what was measured (O1–O7 plus §3.5), what it cannot support, and the exact commands that would resume the work after quota resets. The state tree that completed prior runs wrote is documented separately in [`11-runtime-artifacts.md`](11-runtime-artifacts.md), because this run produced none of it — the artifacts live in the app-data directory, not the workspace.

---

## 1. Artifact provenance

The executed binary is **byte-identical** to the artifact analysed throughout this corpus. This is the load-bearing fact of the document: the observations below are not "a similar version", they are this artifact.

| Check | Installed CLI | Analysed copy (`00-artifact-identity.md`) | Result |
|---|---|---|---|
| Path | `/home/john/.local/bin/agy` | `/tmp/opencode/antigravity-re/antigravity` | different files, different inodes |
| Size | 273,240,776 bytes | 273,240,776 bytes | equal [OBSERVED] |
| SHA-256 | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` | equal [OBSERVED] |
| Build ID (`.note.gnu.build-id`) | `e91180c5c4c28f0207cfcfbbe3a26508` | `e91180c5c4c28f0207cfcfbbe3a26508` | equal [OBSERVED] |
| ELF type | ELF64 LSB, PIE, x86-64, dynamically linked, stripped | ELF64 LSB, PIE, x86-64 | equal [OBSERVED] |
| Byte comparison | — | — | `cmp -s` reports identical [OBSERVED] |

Additional provenance, measured for this document without executing the binary:

- `file /home/john/.local/bin/agy` → `ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, BuildID[md5/uuid]=e91180c5c4c28f0207cfcfbbe3a26508, stripped`. [OBSERVED]
- The two files have different mtimes (2026-11-21 14:22 vs 01:24) and different inodes; only their contents are identical. [OBSERVED]
- Version reported by the CLI: `1.5.14` [OBSERVED], corroborated independently in the runtime log: `Language server version: 1.5.14` (`agy-run.log:3`, `agy2.log:3`).

**Why it matters.** No version-skew caveat is available to excuse a divergence between this document and the static corpus: any disagreement is a disagreement about behaviour of the same bytes. Conversely, nothing observed here can be attributed to a different build.

---

## 2. Environment

| Item | Value | Label |
|---|---|---|
| Host | Fedora Linux 46 (KDE Plasma Desktop Edition Prerelease), kernel `7.4.0-0.rc3.261119g4405c18c95d2.29.fc46.x86_64`, x86-64, 32 logical CPUs, 62 GiB RAM | OBSERVED |
| CLI | `/home/john/.local/bin/agy`, version `1.5.14` | OBSERVED |
| Surface | Headless **print mode** (`-p`); the TUI was not used. A `/teamwork-preview` prompt is recognised and dispatches a `teamwork` subagent (§3.5) | OBSERVED |
| Workspace | `/tmp/opencode/agy-lab` (created empty for the attempts); log records `workspaceDirs=[/tmp/opencode/agy-lab]` (`agy-run.log:50`, `agy2.log:48`) | OBSERVED |
| CLI app-data directory | `/home/john/.gemini/antigravity-cli` (`agy-run.log:49`); this is *not* `~/.config/antigravity` | OBSERVED |
| Antigravity config directory | `~/.config/antigravity/` contained exactly one file, `credential-user-scope` (17 bytes, mode `0600`); the log also names a secret-storage path `~/.config/antigravity/plugin-secrets.json` (`agy-run.log:14`) that did not exist at inspection time | OBSERVED |
| Authentication | Consumer Google account, keyring token; email redacted here. Log: `keyringAuth: loaded token … expired=false` (`agy-run.log:74`), `applyAuthResult: … authMethod=consumer` (`agy-run.log:76`) | OBSERVED |
| Default model when `--model` is omitted | Resolved label `"Gemini 4 Argon (Medium)"` (`agy-run.log:83`, `agy2.log:82`) — the CLI default, not evidence about the `/teamwork` default | OBSERVED |
| MCP configured | `agy mcp list` reported **18 configured servers, 3 enabled**: `codebase-memory-mcp`, `memory`, `sequential-thinking` | OBSERVED (operator run) |
| MCP actually attempted | Log shows attempts/teardown for `chaturbate-mcp`, `codebase-memory-mcp`, `context7`, `fetch`, `firecrawl`, `github`, `juicyads`, `magicuidesign`, `memory`, `mobile-mcp`, `opencode`, `sequential-thinking`, `sonarqube`, `bitwarden`, `twitter` — a set larger than the 3 "enabled" entries | OBSERVED (names); the set-relationship is INFERRED |
| Flags exercised | `-p=…`, `--print-timeout`, `--model`, `--effort`, `--output-format`, `--log-file`; the live run added `--dangerously-skip-permissions` | OBSERVED |
| Network | `https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` and `…:fetchAvailableModels` (`agy-run.log:81-82`) | OBSERVED |

### Observation records

The raw records are retained under `/tmp/opencode/`. Their hashes are reproduced so a reader can confirm that the quoted lines below come from the files named, and that a later retry does not silently overwrite them.

| Record | Bytes | Lines | SHA-256 |
|---|---:|---:|---|
| `agy-run.log` (attempt 1, `--log-file`) | 21,818 | 182 | `61b6de7f4a4d9226a81f6436b10b1c24f37410031e0f5c6d923e5dde2bda07a1` |
| `agy2.log` (attempt 2, `--log-file`) | 19,325 | 154 | `9bee61e308231fcf7d5284dc5f9e219eddc1ee8d63c7b914ca7ee57f8264a108` |
| `agy-out2.log` (partial-output turn) | 351 | 3 | `dcc831235429a42fc9bdf38560773f148a7b06b71f377b342763c6fed05c4159` |
| `agy-out3.log` (quota refusal) | 406 | 2 | `514162c6a6c1ca89a4ee82cf116649b7fa950c712d650c9c045cb837b9bdd0a7` |
| `agy-smoke2.log` (`-p` parse error) | 213 | 2 | `1f289cc229ea0d68f641e1fc05b3553bba33d5209d5e00ad4ddcbd0df766a7d7` |

Times inside the logs are `I1121 hh:mm:ss.microseconds` local (UTC−05:00) on 2026-11-21.

---

## 3. Observations

Each item states what was measured, quotes the exact string where one exists, and carries a confidence label. Inferences that go beyond the quote are separated from it.

### O1 — Print mode takes the prompt as the flag's own value

`agy -p "prompt"` misparses. The flag consumes the next token, so a following option becomes the prompt and the intended text is left unused. Verbatim output (`agy-smoke2.log`):

```text
Error: -p took "--output-format" as its prompt, so the intended prompt was left as an argument and ignored.
Attach the prompt to the flag (-p='your prompt') and move --output-format elsewhere on the command line.
```

Correct form: `agy -p='your prompt'`, with any other flags placed elsewhere on the command line. [OBSERVED]

This is a CLI usability fact, not a `/teamwork` fact. It matters only because it invalidates naive retry scripts, including the commands in §5 of this document if copied without the `=`.

### O2 — `--print-timeout` requires a Go duration with a unit

`--print-timeout 120` is rejected (verbatim):

```text
invalid value "120" for flag -print-timeout: time: missing unit in duration "120"
```

`--print-timeout 120s` is accepted. [OBSERVED] The default is `0s`, reported by the flag's own help text as waiting until the turn completes. [OBSERVED — flag help during the session; the help text itself was not retained] The unit requirement is Go's `time.ParseDuration`, so `90s`, `2m`, `1h30m` are all valid and a bare integer never is. [INFERRED — from the error text]

Operational consequence: a multi-agent `/teamwork` run needs a timeout in the hundreds of seconds. `2m` expired with `printed=0` on a one-line prompt (O4); whether more time would have produced content is `UNKNOWN`, so the timeout must be sized for the slowest expected run rather than for the fastest observed failure.

### O3 — MCP connection attempts dominate the first two minutes of every process

Two verbatim watchdog lines from two independent processes (`agy-run.log:139,159`; `agy2.log:138,139,140`):

```text
MCP: 6 server(s) still connecting after 30s: chaturbate-mcp, firecrawl, github, juicyads, opencode, sonarqube
MCP: 5 server(s) still connecting after 1m0s: chaturbate-mcp, firecrawl, github, juicyads, sonarqube
```

The named servers are entries that `agy mcp list` reports as **disabled** on this machine. The process nevertheless waits on them, and names a wider set than the 3 enabled entries in teardown messages (`fetch`, `magicuidesign`, `context7`, `sequential-thinking`, `mobile-mcp`, `memory`, `bitwarden`, `twitter`; `agy-run.log:149-158`). [OBSERVED for the names and the warning lines; INFERRED that the effective connection set is not the "enabled" column of `agy mcp list`, and UNKNOWN whether it is all 18 configured servers, a project-scoped set, or a defaults-plus-plugins set]

**Timeline, measured.** One process, with timestamps from `agy2.log`:

| Offset | Event |
|---:|---|
| +0.000 s | language server starts; `Language server version: 1.5.14` |
| +0.047 s | `Print mode: starting (promptLength=24, model="", conversationID="")` |
| +10.008 s | `Print mode: not authenticated, trying silent auth` |
| +10.590 s | `Propagating selected model override … label="Gemini 4 Argon (Medium)"` |
| +11.313 s | turn sent (`SEND_USER_CASCADE_MESSAGE_LATENCY … status:OK`) |
| +29.960 s | MCP watchdog: 6 servers still connecting after 30s |
| +59.959 s | MCP watchdog: 5 servers still connecting after 1m0s |
| +107.763 s | MCP watchdog: 6 servers still connecting after 30s (a second manager cycle — INFERRED, no log line states it) |
| +131.316 s | `Print mode: print timeout after 2m0s with turn in progress after 4750 polls (printed=0)` |

The same ~10 s pre-auth wait appears in the other process (`agy-run.log`: print mode starts at 18:42:03.315, silent auth at 18:42:13.321).

**Correction to one briefing-level inference.** The claim that startup blocks for about a minute *before any model call* is not what these logs show. The model turn was sent at about **+11 s**; the 30 s and 60 s MCP lines are watchdog reports from connection attempts that continue **concurrently** with the turn. What is real and costly is: (a) a reproducible ~10 s wait between "print mode starting" and silent auth, and (b) one to two minutes of MCP connection churn and teardown around the turn, which inflates wall-clock time and produces `context canceled` teardown errors. [OBSERVED for the timeline; INFERRED for the ~10 s as an MCP initialisation wait — no log line states the cause]

This distinction matters for the retry plan: a `--print-timeout` that expires before any token is rendered is indistinguishable from quota trouble at the CLI, so the budget must be generous and the log's `printed=` counter must be read before drawing a conclusion.

### O4 — Quota exhaustion blocked the run

The final attempt used `--model gemini-3.8-flash-low --effort low --print-timeout 240s` and returned exit code **3** with this output (`agy-out3.log`):

```text
error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 34m52s.
AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 34m52s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"0be439d5-a65a-422e-9041-f85e9e24e532-1"}
```

[OBSERVED] The reset interval is the one the server printed at that moment; it is not a durable fact.

An earlier attempt, with a 2-minute print timeout, produced the client-side terminal state rather than a server error (`agy-out2.log`, and `agy2.log:141`):

```text
[agy] print timeout after 2m0s with turn in progress; returning partial output
error: print timeout after 2m0s with the turn still in progress; the response is partial
AGY_ERROR: {"short_error":"print timeout after 2m0s with the turn still in progress; the response is partial","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}
```

[OBSERVED] So with a print timeout set, print mode terminates with partial output plus a structured error rather than hanging indefinitely. Whether that turn would eventually have returned content or the same 429 is `UNKNOWN`; the log shows `printed=0` and 4,750 polls, so no token was rendered before the deadline. [OBSERVED]

The two terminal states are distinct and should not be merged: `DEADLINE_EXCEEDED` / `print_timeout` is a local timeout with `retryable:false`; `RESOURCE_EXHAUSTED` / HTTP 429 is a provider refusal with `retryable:true`.

### O5 — The model catalog is visible without a model turn

`agy models` printed lines of the form `id<TAB>Display Name`, without requiring a prompt. The identifiers observed included: [OBSERVED]

```text
gemini-4-neon-low          gemini-4-neon-medium       gemini-4-neon-high       gemini-4-neon-xhigh
gemini-4-argon-low         gemini-4-argon-medium      gemini-4-argon-high
gemini-4-hydrogen-low      gemini-4-hydrogen-medium   gemini-4-hydrogen-high   gemini-4-hydrogen-xhigh
gemini-pro-orchestrator-neon
gemini-pro-orchestrator-g1-pro
gemini-3.8-flash-low       gemini-3.8-flash-medium    gemini-3.8-flash-high
claude-opus-5-5-low        claude-opus-5-5-medium     claude-opus-5-5-high
```

This is the list quoted to this document by the operator; the exact display names and the full line count were not retained, so only the ids are asserted.

**Refinement, measured for this document.** "Server-provided" is supported but not exclusive. The log shows a real catalog fetch after authentication — `GET https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (`agy-run.log:82`, `agy2.log:81`) — which is `OBSERVED`. The same identifiers also exist as **literals inside the binary**: `gemini-4-neon-low` at 106,231,885, `gemini-4-neon-high` at 106,311,559, `gemini-4-neon-xhigh` at 106,388,332, `gemini-4-neon-medium` at 106,462,239 and `gemini-3.8-flash-low` at 106,462,259, all inside `.rodata`, fused with neighbours; and the settings key `orchestrator-model-roles` at 106,769,725 whose value is an embedded JSON blob at 222,978,396 listing `"orchestrators": ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "claude-opus-5-5"]` and `"executors": ["gemini-4-hydrogen", "claude-sonnet-5-5"]`. [OBSERVED — offsets and quoted JSON] Therefore the binary is not ignorant of model ids; whether `agy models` renders the fetched catalog, a local table, or a merge of both is `UNKNOWN`. [UNKNOWN]

What this does **not** show is the mapping from the local `MODEL_TIER_*` enum (`MODEL_TIER_UNSPECIFIED/INHERIT/FLASH_LITE/FLASH/PRO`, documented in `06-config-gates-and-model-tiers.md`) to any concrete id. The tier→model mapping remained unobserved. The conclusion that the enum is a **local** classification while concrete ids come from the catalog is **INFERRED**, not measured: the enum is a Go proto enum with no model id beside it, and the catalog is fetched at runtime, but no code path or request payload was observed translating one into the other. [INFERRED]

Also observed and relevant to `06`'s "teamwork defaults to flash" inference: with `--model` omitted, the CLI's own default resolved to `"Gemini 4 Argon (Medium)"` (O2 timeline). That is the **CLI** default for print mode, not the `/teamwork` route default, and it neither confirms nor refutes the static claim. [OBSERVED for the label; the scope limitation is INFERRED]

### O6 — `agy agents` printed nothing

On this install, `agy agents` completed and printed no rows. [OBSERVED] It is `UNKNOWN` whether the subcommand lists only user-defined agents (none are defined here) or requires a project context that print mode did not supply. No conclusion is drawn from the empty output, and it is not evidence that the 49 `teamwork.AllAgents` registry entries are absent at runtime.

### O7 — Authentication was not the blocker

The session reached a real model turn and returned a provider quota error (O4), which means credentials and transport worked. [OBSERVED] The log sequence is explicit: a keyring token was loaded with `expired=false` (`agy-run.log:74`), `applyAuthResult` recorded `authMethod=consumer` (`agy-run.log:76`), and the process then called `loadCodeAssist` and `fetchAvailableModels` successfully enough to resolve a model label (`agy-run.log:81-83`). [OBSERVED]

`~/.config/antigravity/` contained only `credential-user-scope` at inspection time. [OBSERVED] Two adjacent filesystem facts, stated so they are not mistaken for materialisation:

- The log declares `Using file-based secret storage at /home/john/.config/antigravity/plugin-secrets.json` (`agy-run.log:14`), but no such file existed in the directory listing afterwards. Whether the declaration names a path used only when a secret is written is `UNKNOWN`; nothing was written during these attempts. [OBSERVED absence; UNKNOWN cause]
- The CLI's actual app-data tree is `~/.gemini/antigravity-cli`, and it contains a `builtin/` directory with materialised skills (`native_swarm`, `swarm_monitor`, `swarm_pane`, `agy-customizations`, …). Its mtime is **14:32**, more than four hours before these attempts (18:36–18:48), so it pre-existed and nothing in it was created by these runs; no `teamwork` payload was found in it. [OBSERVED] `~/.config/antigravity/` is therefore not the materialisation target — the app-data directory is. [INFERRED]

---

## 3.5 Live `/teamwork-preview` observation (quota-partial)

A second phase was run later the same day, after the quota window moved. This is the only attempt in this document that invoked the slash command and got past command recognition.

### 3.5.1 Command and result

```sh
agy -p='/teamwork-preview [skip-interview] Create a file hello.txt containing exactly: hello. Keep it small and cheap: this is a quick, single, self-contained change.' \
    --dangerously-skip-permissions --print-timeout 880s --output-format text
```

Workspace `/tmp/opencode/agy-lab`, empty at start. Exit code **0**, ~6 minutes wall-clock. Result: `hello.txt`, **5 bytes**, content exactly `hello`. [OBSERVED — client output and disk]

`hello` (5 bytes) is *not* a file a teamwork agent wrote: no agent turn ran (§3.5.4), and the output says the sentinel created it directly. [OBSERVED]

### 3.5.2 Output text, verbatim

Three paragraphs, in order:

```text
I have handed your request over to the `teamwork` multi-agent team ([Teamwork Orchestrator](conversation://dbeb883c-80f3-415e-86d3-37dffaa41ba4)). I will forward any updates or final results as soon as the team reports back.

The first Teamwork orchestrator (`dbeb883c-...`) hit an individual model quota limit (`RESOURCE_EXHAUSTED (code 429)`). I have re-launched the Teamwork orchestrator on the `flash` model ([Teamwork Orchestrator](conversation://62c78193-...)) and will update you as soon as it reports back.

The `teamwork` subagent (`62c78193-...`) is temporarily unavailable due to a model quota limit (`RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 6m57s.`). To ensure your task is completed right away, I created [hello.txt](file:///tmp/opencode/agy-lab/hello.txt) directly containing `hello`.
```

[OBSERVED — client] The `6m57s` reset value is the server's value at that moment, not a durable fact.

### 3.5.3 Findings

| Finding | Evidence | Label |
|---|---|---|
| The slash command is recognised in print mode and **dispatches** to a separate conversation | the output links `conversation://dbeb883c…`; the parent message store records `invoke_subagent` with `TypeName:"teamwork"`, `Role:"Teamwork Orchestrator"` | OBSERVED — client + disk |
| The orchestrator is addressable by `conversation://<id>` | both ids exist as `~/.gemini/antigravity-cli/brain/<id>/` directories | OBSERVED — disk |
| After the first 429, a **new planner turn** chose `flash` and issued a second `invoke_subagent` | parent transcript step 22 has no `Model`; step 26 is the 429 system message; step 32 is a fresh `PLANNER_RESPONSE` whose thinking selects `flash` and whose call carries `"Model":"flash"`; step 35 narrates it | OBSERVED — disk (transcript) |
| The relaunched orchestrator was also quota-refused | parent transcript step 36 is the second 429 system message; step 40 narrates it with the same reset window | OBSERVED — disk + client |
| When the orchestrator stayed unavailable, the sentinel **completed the work inline** | paragraph 3 states it; `hello.txt` matches the request | OBSERVED — client + disk |
| No orchestrator turn produced content | both child conversations contain no `.agents/` tree — only empty `scratch/`, `.user_uploaded/` and `.system_generated/` stubs (570-byte transcripts, message JSON) | OBSERVED — disk |

The observed sequence is a **model decision in a new planner turn**, not a deterministic client retry. The parent conversation's `transcript_full.jsonl` records the phases by `step_index`:

| Step | Record | What it shows |
|---:|---|---|
| 22 | `PLANNER_RESPONSE`, model `gemini-4-argon-medium` | `invoke_subagent` for `TypeName:"teamwork"`, `Role:"Teamwork Orchestrator"`, child `dbeb883c…`; **no `Model` field** |
| 26 | `SYSTEM_MESSAGE` | first refusal: `RESOURCE_EXHAUSTED (code 429) … Resets in 10m7s` for `dbeb883c…` |
| 32 | `PLANNER_RESPONSE`, same parent model | fresh thinking selects `flash`; the next `invoke_subagent` carries `"Model":"flash"` and child `62c78193…` |
| 35 | `PLANNER_RESPONSE` | narration: re-launched on `flash` |
| 36 | `SYSTEM_MESSAGE` | second refusal: same 429 text, `Resets in 6m57s`, for `62c78193…` |
| 40 | `PLANNER_RESPONSE` | narrates the second 429 and the inline completion |

[OBSERVED — disk, read from the parent transcript on 2026-11-23] Step 40 is the narration; the second 429 itself is step 36. The decision line, quoted from step 32's `thinking`:

> Initial hypothesis: The "teamwork" model's quota exhaustion suggests a possible rate limit issue. Testing a different model ("flash") with the same "teamwork" type could bypass this limitation. If the "flash" model succeeds, this confirms the original quota constraint was the problem.

[OBSERVED — disk] The override is therefore authored **inside a model response**, together with the reasoning and the call. Nothing in the record separates a client-generated retry from the model's next tool call, because there was no separate client retry record: the 429 became a system message, then the next planner turn wrote the modified call. [INFERRED from the response structure: the call is attributable to the planner turn in which it appears.] Whether the client also has a retry/fallback policy that can act without a model turn is `UNKNOWN`; that is a **static-RE question**, not something this transcript can settle.

The flash relaunch is the live counterpart of the model-tier material in [`06-config-gates-and-model-tiers.md`](06-config-gates-and-model-tiers.md): `TeamworkDefaultsToFlash` (33,572,314), `teamwork.RootAgentWithDefaultTier` (34,566,022), the `MODEL_TIER_*` enum (116,298,796) and the `disable-teamwork-forced-flash-model` setting (107,270,651) together describe a *forced/default* flash policy. This run shows an **explicit per-dispatch override** carried in the tool call after a quota failure. It does **not** show that the shipped client automatically retries on 429, and it does not identify the selector behind the first call's absent `Model` field. [OBSERVED — disk for the call and the decision; default/retry policy `UNKNOWN`]

One correction to a natural reading of the dispatch: the observed `TypeName` is `teamwork`, not `teamwork_orchestrator`, and the role label "Teamwork Orchestrator" is not the prompt's vocabulary ("Project Orchestrator", `prompts/sentinel-routing.md:326`). This is the command's **entry dispatch** — the print-mode turn handing off to a `teamwork`-typed agent — not a route dispatch. No route decision was emitted, so inferring "General route" from it would be unjustified. [OBSERVED for the call shape; route UNKNOWN]

The inline fallback is worth stating plainly because the recovered prompt does not sanction it: the sentinel is told to manage failures and, on a terminal non-victory stop, to **relay the status plainly and never report project completion** (`prompts/sentinel-routing.md:670-676`). There is no instruction to do the work itself. The run did not claim a teamwork victory — it said the subagent was unavailable and that it created the file directly — but it did act outside the recovered prompt. Whether that is a client-side fallback or the model's own choice is `UNKNOWN`. [OBSERVED behaviour; cause UNKNOWN]

### 3.5.4 Artifacts: the negative result

The workspace `/tmp/opencode/agy-lab` contained **no** `.agents/teamwork/` directory, no `ORIGINAL_REQUEST.md`, no `plan.md` and no `progress.md` at the end of the run. [OBSERVED — disk, `find`]

That is expected rather than mysterious: teamwork state is specified to live in the per-run/per-conversation state folder under the app-data directory, and the dispatch text explicitly forbids writing `.agents/teamwork/` into the project directory. The artifact contract, its root, its ten document kinds and a redacted gate template are recorded in [`11-runtime-artifacts.md`](11-runtime-artifacts.md). This run could not have produced them anyway — the orchestrator never took a turn — so "no artifacts" is a statement about this run, not about `/teamwork-preview` in general.

---

## 4. What this does not establish

Stated plainly, because the temptation to read a quota error as a partial success is real:

- **No `/teamwork-preview` orchestrator turn completed.** The command was recognised and dispatched (§3.5), but both dispatched conversations were refused with HTTP 429 before producing content. So the command's *entry* behaviour is observed; its workflow behaviour is not.
- **The interview gate was not exercised in this run.** The live run passed `[skip-interview]` through to the dispatch prompt, but no interviewer turn occurred, so the token's effect is untested here. A completed prior run's interview chain — interviewer dispatch, draft, answers, approval and `ORIGINAL_REQUEST.md` — is recorded in [`14-interview-gate-observed.md`](14-interview-gate-observed.md); whether it can be answered in print mode is still `UNKNOWN`.
- **The routing decision is unobserved for this run.** No route was selected, so the six-route decision table in `01` and the per-route DAGs in `04` were not exercised. The observed dispatch used `TypeName:"teamwork"` with a "Teamwork Orchestrator" label — the entry handoff, not a route dispatch (§3.5.3). A separate prior run's General routing is recorded in `14` §2.
- **Subagent dispatch is partially observed.** One `invoke_subagent` call and one model-override relaunch were recorded (§3.5.3), but no `teamwork` child ever ran, so the 49-agent registry was not instantiated into working agents and per-role dispatch remains `UNKNOWN`.
- **No artifact was created — and none should have been, in the workspace.** `ORIGINAL_REQUEST.md`, `BRIEFING.md`, `handoff.md` and every other state document belong under the app-data state root, not the project; the dispatch text forbids `.agents/teamwork/` in the workspace (§3.5.4). Prior completed runs *did* write the ten document kinds, documented in `11`.
- **The swarm board is unobserved.** No `board.jsonl`, `members.json`, `Post %d/%d (seq #%d by %s` notification, or board rendering was produced.
- **The inline fallback is not a teamwork completion.** It produced the requested file, but no orchestrator, gate or auditor verified it, and the recovered prompt does not describe the behaviour. It is not evidence for any completion rule.
- **Per-route completion verification is unobserved.**
- **The embedded-fixture materialisation path was not exercised during these attempts.** The pre-existing `builtin/` tree under `~/.gemini/antigravity-cli` has an older mtime and no `teamwork` content was found in it; whether a `/teamwork` run would add files there is `UNKNOWN`.
- **The tier→model mapping is unobserved** (O5).
- **Disabled and admin-gated behaviour is unobserved.** No `teamwork_preview_command_disabled`, `enable-teamwork-subagent`, `native-swarm` or `clamped` path was reached, so `06`'s states S1–S7 remain untested.
- **`agy agents` semantics are unobserved** (O6).
- **One behaviour sits outside the recovered prompt.** The inline fallback is not described by the sentinel prompt, which tells a failed run to relay status rather than act (§3.5.3); that is a divergence in behaviour, not a contradiction of a binary claim, because the prompt governs instructions and nothing observed enforces compliance. Apart from that, runtime did not contradict a static finding — but it tested very few of them, and absence of contradiction is not confirmation. This document must not be cited as if it validated `01`, `04` or `05`.

---

## 5. Retry plan

Preconditions: quota reset (the server's own window), and a willingness to spend quota on a bounded run. Run each step in order and stop at the first failure; do not batch them, because the failure modes in O1–O4 are indistinguishable from a script's point of view.

Use a fresh, empty workspace so that any artifact is attributable:

```sh
mkdir -p /tmp/opencode/agy-lab/rt1
cd /tmp/opencode/agy-lab/rt1
```

**Step 0 — confirm the quota window has actually reset, cheaply.** A one-line turn with a hard ceiling. `-p=` is mandatory (O1); the timeout carries a unit (O2).

```sh
agy -p='Reply with exactly: OK' \
    --print-timeout 240s \
    --model gemini-3.8-flash-low --effort low \
    --output-format json \
    --log-file /tmp/opencode/agy-retry0.log
echo "exit=$?"
```

A clear `RESOURCE_EXHAUSTED` means "not yet"; wait and repeat. A `DEADLINE_EXCEEDED` is **inconclusive** — O4 shows a timeout can mask a blocked turn — so raise the ceiling once, and if it still prints nothing, treat the quota window as unconfirmed rather than as "quota is fine".

**Step 1 — confirm the orchestrator can take a turn at all.** Slash-command recognition is now `OBSERVED` (§3.5): print mode dispatches a `teamwork` subagent. What has never been observed is that subagent **producing content**. Keep this step, but read its result for the orchestrator, not for the command. The log line `Reloading system slash commands` (`agy-run.log`) was suggestive; the `invoke_subagent` record is the proof.

```sh
agy -p='/teamwork-preview Create hello.txt containing exactly: hello from teamwork. Then stop.' \
    --print-timeout 900s \
    --model gemini-3.8-flash-low --effort low \
    --output-format json \
    --log-file /tmp/opencode/agy-retry1.log
echo "exit=$?"
```

Use `900s`, not `240s`. O3 shows a ~10 s pre-auth wait and MCP connection attempts that keep the process busy for 1–2 minutes (watchdog lines at 60 s; teardown at about 2 minutes), and a real multi-agent run adds model turns on top. The print timeout is measured from the turn being sent, not from process start — in `agy2.log` it expired exactly 120 s after `SEND_USER_CASCADE_MESSAGE` — so size it for the slowest expected run. If the run fails with `print timeout`, the partial output and the log's `printed=` counter distinguish "no tokens" from "cut mid-stream"; if `printed=0` and the MCP watchdog lines are present, the run may still have been in startup rather than in the workflow.

**Step 2 — capture what the run wrote, in both places, before anything else touches them.** The workspace is for work products; the teamwork state tree is under the app-data directory (`11` §2). Capture both, plus the newborn conversation tree.

```sh
find /tmp/opencode/agy-lab/rt1 -type f -printf '%s\t%p\n' | sort -k2
find ~/.gemini/antigravity-cli/brain -newermt '2026-11-21 19:17' -path '*scratch*' -type f -printf '%s\t%p\n' 2>/dev/null
find ~/.gemini/antigravity-cli/builtin -newermt '2026-11-21 19:17' -type f 2>/dev/null
grep -RIl -e 'ORIGINAL_REQUEST' -e 'BRIEFING' -e 'GATE_STATUS' /tmp/opencode/agy-lab/rt1 2>/dev/null
```

The second command is the one that matters: a completed run writes `ORIGINAL_REQUEST.md`, `BRIEFING.md`, `progress.md`, `DISPATCH.md`, `handoff.md`, `SCOPE.md` and `GATE_STATUS.md` under `<conv>/scratch/.agents/teamwork/` (`11` §3). An empty `scratch/` is what the quota-blocked run left (§3.5.4). The third command still tests the materialisation question: any file newer than the previous attempts was created by this run. If `builtin/` is unchanged, the embedded-fixture path still has not been exercised.

**Step 3 — interview gate, in both directions.** Two short runs against the same tiny task: one without the bypass, to see the questions; one with `[skip-interview]`, to see whether it is honoured.

```sh
agy -p='/teamwork-preview Create a file named gate.txt containing the word gate.' \
    --print-timeout 900s --model gemini-3.8-flash-low --effort low \
    --output-format json --log-file /tmp/opencode/agy-retry2a.log
agy -p='/teamwork-preview [skip-interview] Create a file named gate.txt containing the word gate.' \
    --print-timeout 900s --model gemini-3.8-flash-low --effort low \
    --output-format json --log-file /tmp/opencode/agy-retry2b.log
```

Record whether the first run blocks for input (and what it asks), and whether the second proceeds without asking. The literal `[skip-interview]` from `01` is now confirmed as the spelling the dispatcher forwards verbatim (§3.5); whether it suppresses the interview is still untested, because no interviewer turn has run.

**Step 4 — one non-default route.** Only after Steps 1–3 succeed. Pick the cheapest of `04`'s six routes that still exercises a distinct DAG — `document_review` or `swe_light` — and run it against a single small input file in its own workspace, again with a 900 s ceiling and a `--log-file`. Record the route actually chosen versus the route `01`'s decision table predicts; a mismatch is the most valuable possible result and must be reconciled back into `01` and `04` as runtime evidence.

**Budget note.** Each step is at least one model turn and probably several; a `/teamwork` run dispatches multiple agents. On a consumer quota that has just reset, Steps 0–2 are affordable, Step 3 is two runs, and Step 4 should be treated as a separate decision. Do not attempt all six routes in one session.

**Bookkeeping.** Preserve each `--log-file` with `sha256sum` alongside its stdout, as was done in §2, so a later reader can tell which attempt produced which quote. Do not overwrite `agy-run.log`/`agy2.log`/`agy-out2.log`/`agy-out3.log`.

---

## 6. Implications for the static report

Runtime did not contradict a static finding, but it exercised few of them: no route, gate or per-role dispatch was reached, and no live orchestrator wrote an artifact. What runtime *did* add is a command-surface fact the static corpus could not settle — print mode recognises `/teamwork-preview` and dispatches a `teamwork` subagent, and **after a 429 the next planner turn chose `flash`** in its tool call. That is the live counterpart of `06`'s forced/default-flash material, and it should be cited as a model-authored override observed once — not as proof that teamwork always runs on flash, and not as evidence of an automatic client retry.

Two further implications. First, the **artifact contract is real but relocated**: a completed run writes the ten document kinds into `<appDataDir>/brain/<conv>/scratch/.agents/teamwork/`, and the dispatch text forbids writing them into the project; `05` §6's `.agents/teamwork/…` paths should be read as paths inside that root (`11` §2, §6). Second, the **sentinel has a fallback the prompt does not describe**: rather than relaying a terminal non-victory stop, it completed a small task inline. That is a behavioural fact about the entry turn, and it does not upgrade any route or gate claim — but a reimplementation that treats "dispatch only" as an invariant should know the shipped client did otherwise.

The operational observations static analysis could not produce are unchanged: print mode's `-p=` parsing, the mandatory duration unit, the ~10 s pre-auth wait plus one to two minutes of MCP connection churn against servers listed as disabled, and the two distinguishable failure envelopes (`print_timeout` versus HTTP 429). None of these is visible in `.rodata`; the model ids, by contrast, *are* partly visible there, so the corpus should say "the catalog is fetched at runtime and its ids also exist as literals" rather than "the ids are server-provided". The static corpus stands unchanged in its claims; this document fixes the boundary between what was executed and what was not, and `11` records where the state goes when an orchestrator does run.
