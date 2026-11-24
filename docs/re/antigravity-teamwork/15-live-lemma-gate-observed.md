# Live LEMMA Run — the Blocking Pre-flight Gate Observed (`MISSING`)

**Status: OBSERVED — one LEMMA-route attempt reached its blocking pre-flight audit, received the verdict `MISSING`, relayed the prerequisites notice and stopped before any Lean work. The process then hit its 10-minute print ceiling and exited `3`.** Recorded on **2026-11-23** against the installed Antigravity CLI **1.5.15** (binary SHA-256 `7b004d26…41fa2d`, 273,879,752 bytes). [OBSERVED — `agy --version`; the run's server log, `~/.gemini/antigravity-cli/log/cli-20261123_073544.log:3`, `Language server version: 1.5.15`] This is **not** the 1.5.14 build the static documents `00`–`06` and `09` analyse; see [`PROVENANCE.md`](PROVENANCE.md) *version axes*. The **control probe** recorded at `12:32:36Z`, three minutes earlier, ran on the previous **1.5.14** binary and is a **cross-version** control, not this run's identity (§8.3). This is the first runtime record in the set of the **LEMMA** route and of the **`teamwork_dependency` gate actually firing**. It is deliberately narrow: **one** run, one verdict, no route agent. It does not exercise the LEMMA pipeline, the `READY` path, or install mode.

The run is the reference sample for five things the corpus previously held only statically:

1. the **LEMMA** route label chosen for an explicit "prove in Lean 4" request, recorded in `ORIGINAL_REQUEST.md` and the sentinel briefing;
2. the pre-flight audit dispatched **before** the route agent, and the route agent never spawned;
3. `MISSING` as a **terminal** verdict with the notice relayed to the caller and nothing installed;
4. the workspace artifact for that verdict, `PREREQUISITES.md`, written in the working directory — not in the teamwork state root;
5. the **order** the sentinel records and audits in: `ORIGINAL_REQUEST.md` was written before `teamwork_dependency` was invoked, which `04` §3 previously carried as `INFERRED`.

What it does **not** show is any LEMMA work: no `teamwork_lean/`, no `problem.lean`, no formalization, no proof, no verification, no gate table. The run's terminal outcome is a timeout-plus-quota error (§8), not a Lean result.

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md): **OBSERVED** means read in a cited capture, transcript, log or state file; **INFERRED** means reasoned from stated observed premises; **UNKNOWN** means not measured. Paths are written relative to three placeholders, so this document carries no unrelated personal path:

| Placeholder | Resolves to |
|---|---|
| `<capture>` | `/tmp/opencode/re-0.9/` — **LOST** (absent on re-check, 2026-11-24). It held `lemma.stream.jsonl`, `lemma.err`, `lemma.exit`, `probe.*`; the surviving copies are the bundle's `stream-tail.jsonl` and the transcripts and logs cited below |
| `<state>` | `<appDataDir>/scratch/teamwork/9461e3b4-2958-43d9-80fd-685a850fc4af/.agents/teamwork/` — this run's teamwork state root (survives) |
| `<workspace>` | `/tmp/opencode/re-0.9/lemma-ws/` — **LOST** with the capture; it was the run's working directory (empty when the audit began). Its only file, `PREREQUISITES.md`, survives redacted in the bundle |

Three transcripts are cited: the **parent** (`<appDataDir>/brain/c9bb22c0-05b0-4674-a348-1c06fdf7ed91/.system_generated/logs/transcript_full.jsonl`, the top-level conversation), the **sentinel** (`<appDataDir>/brain/<coordinator>/.system_generated/logs/transcript_full.jsonl`), and the **auditor** (`<appDataDir>/brain/<auditor>/.system_generated/logs/transcript_full.jsonl`). The redacted evidence bundle is in [`live/2026-11-23-lemma-gate/`](live/2026-11-23-lemma-gate/).

---

## 1. Run identity

| Field | Value | Label |
|---|---|---|
| CLI | `agy` **1.5.15** | OBSERVED at run time — `agy --version` reported 1.5.15 then; the run's server log `~/.gemini/antigravity-cli/log/cli-20261123_073544.log:3` reads `Language server version: 1.5.15`. The installed binary is now **1.5.16**, so `agy --version` today does **not** name this run |
| Binary | SHA-256 `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d`, 273,879,752 bytes | OBSERVED at run time — `sha256sum` / `stat` on `/home/john/.local/bin/agy`. That file has since been replaced; no copy remains to re-hash, so the value is recorded, not re-verified |
| Control probe (separate, earlier) | `agy` **1.5.14**, SHA-256 `37873b80…97d8c94` | OBSERVED at run time — `<capture>/probe.meta` lines 2–3, written `2026-11-23T12:32:36Z` (the file is lost with the capture). This is a **cross-version** control on the previous binary, **not** the LEMMA run's identity (§8.3) |
| Host | Linux x86-64 (`fc46` kernel), UTC−05:00 local | OBSERVED — `<capture>/probe.meta` line 4; unchanged across the upgrade, and the run's server log timestamps are UTC−05:00 |
| Top-level conversation | `c9bb22c0-05b0-4674-a348-1c06fdf7ed91` | OBSERVED — `<capture>/lemma.stream.jsonl` `init`; parent transcript |
| Top-level model | `gemini-4-argon-medium` | OBSERVED — parent transcript step 1 `model` |
| Teamwork coordinator / sentinel | `9461e3b4-2958-43d9-80fd-685a850fc4af` | OBSERVED — stream `init`, subagent-created event, `<state>` path |
| Sentinel model | `gemini-4-hydrogen-tiered-high` | OBSERVED — sentinel transcript steps 1, 5, 7, 10 `model` |
| Pre-flight auditor | `21bbc95b-b754-42e0-8793-a648b7025a7c` | OBSERVED — sentinel transcript step 4; sentinel briefing |
| Request | `/teamwork [skip-interview] Prove in Lean 4 that 1 + 1 = 2 and check the proof. Use the LEMMA route.` | OBSERVED — parent transcript step 0; `ORIGINAL_REQUEST.md` |
| Working directory | `<workspace>`, empty at dispatch | OBSERVED — `init.init.cwd`; handoff §1 (`total 0`); no other file existed until the audit wrote one |
| Exit code | `3` | OBSERVED — `<capture>/lemma.exit` (`EXIT=3`) |
| Terminal reason | `print_timeout` after 10m0s, turn still in progress | OBSERVED — `<capture>/lemma.err`; `<capture>/lemma.stream.jsonl` final `result` |
| Result envelope | `status: "ERROR"`, `finished_reason: "print_timeout"`, error text = individual-quota message | OBSERVED — `<capture>/lemma.stream.jsonl` line 7 |
| Wall-clock span | 12:35:55Z (user input) → 12:45:55Z (capture written) | OBSERVED — parent transcript step 0; `<capture>/lemma.stream.jsonl` mtime |
| Main-conversation usage | 10,472 input / 139 output / 71 thinking; no cache read | OBSERVED — `result.result.usage`; agrees with parent transcript step 1 |
| Gate verdict | `MISSING` | OBSERVED — `<state>/dependency_preflight/handoff.md` §4; auditor message; sentinel briefing |

The run used the coordinator id as the state-root name under `scratch/teamwork/`, the **primary** root form recorded in `11-runtime-artifacts.md` §2.1 and observed again in `12` §6 (the `brain/<coordinator>/scratch/` form was not used here).

**Cross-version comparability.** The sentinel prompt slice this run obeyed is **byte-identical** in 1.5.14 and 1.5.15: 36,482 bytes, SHA-256 `3e8c347eb2db6059ef9f010873062c41bc7d95fd640746674b4caddd0fabf4c1`, at 1-based offset 113,241,709 in 1.5.14 and 113,300,479 in 1.5.15. So the prompt-level behaviour recorded here is comparable to the static 1.5.14 corpus; only the surrounding statics (builtin tree, literal offsets) moved. [OBSERVED — byte comparison of the two binaries, §9; offset arithmetic in `prompts/sentinel-routing.md`]

---

## 2. Command shape and prompt

No argv array is stored in the capture. The assembled line below is **INFERRED**; every component is separately observed.

```sh
agy -p='/teamwork [skip-interview] Prove in Lean 4 that 1 + 1 = 2 and check the proof. Use the LEMMA route.' \
    --dangerously-skip-permissions \
    --print-timeout 10m \
    --output-format stream-json \
    > <capture>/lemma.stream.jsonl 2> <capture>/lemma.err
```

| Component | Evidence | Label |
|---|---|---|
| Prompt text | `<capture>/lemma.stream.jsonl` `init` + subagent `initial_prompt`; parent transcript step 0 | OBSERVED |
| `/teamwork` expanded as a system command | `init.expanded_commands` = `[{"name":"teamwork","type":"system"}]` | OBSERVED |
| `--print` / `-p` | `--output-format`/stream schema only exists in print mode; `lemma.err` says "print timeout" | INFERRED (flag spelling); print mode OBSERVED from output |
| `--dangerously-skip-permissions` | `init.permission_mode` = `"always-proceed"`; the control probe without the flag recorded `"request-review"` | OBSERVED (mode); flag as its cause INFERRED |
| 10-minute ceiling | `lemma.err`: "print timeout after 10m0s"; `agy --help` records the default as `0` (wait indefinitely), and the capture mtime is 10m after the user input | OBSERVED (ceiling); exact flag spelling `10m` vs `600` INFERRED |
| `--output-format stream-json` and redirections | one JSON object per line; stderr separate | OBSERVED (files); flag spelling INFERRED |

The bracket token was split out into a `## Parameters` block exactly as the recovered prompt specifies; `ORIGINAL_REQUEST.md` is 223 bytes, eight lines, and quotes the task without the bracket:

```markdown
# Original User Request

## Parameters
[skip-interview]
How this run was launched; not part of the task.

## Initial Request — 2026-11-23T12:38:48Z
Prove in Lean 4 that 1 + 1 = 2 and check the proof. Use the LEMMA route.
```

[OBSERVED — `<state>/ORIGINAL_REQUEST.md`; a second runtime instance of A5, as in `12` §2.2 and `13` §2]

No interviewer folder or interview turn exists. As in `12` and `13`, the token → no-interview causality is `INFERRED`, not logged.

---

## 3. Timeline

All times UTC. Transcript timestamps are the client's; file mtimes are the host's.

| Time | Event | Evidence | Label |
|---|---|---|---|
| 12:32:36 | Control-probe metadata written (CLI **1.5.14**, binary hash, host — the previous binary, three minutes before the 1.5.15 upgrade) | `<capture>/probe.meta`; `cli-20261123_073238.log:3` (`1.5.14`) | OBSERVED |
| 12:32:36 → +167.6 s | Control probe returns `PONG` (settings override; §8.3) | `<capture>/probe.stream.jsonl`, `probe.exit` | OBSERVED |
| 12:35:55 | Top-level user input recorded | parent transcript step 0 | OBSERVED |
| 12:38:39 | Top-level planner calls `invoke_subagent` (`TypeName: teamwork`, role "Teamwork Coordinator") | parent transcript step 1 | OBSERVED |
| 12:38:46–48 | Subagent conversation created; workspace `file://<workspace>` | parent transcript step 2; stream line 5 | OBSERVED |
| 12:40:09 | Sentinel turn: writes `ORIGINAL_REQUEST.md` **and** a first `sentinel/BRIEFING.md`, then invokes `teamwork_dependency` — all in one planner response | sentinel transcript step 1 (`write_file` ×2, `invoke_subagent`) | OBSERVED |
| 12:40:21–28 | Auditor conversation created; sentinel turn ends: "Pre-flight dependency audit dispatched; waiting for `teamwork_dependency` verdict." | sentinel transcript steps 4–5 | OBSERVED |
| 12:41:49 | Auditor turn 1: writes `DISPATCH.md`, its own `BRIEFING.md` and `progress.md`; lists the (empty) workspace | auditor transcript step 1 | OBSERVED |
| 12:42:09–12:42:22 | Writes empty scratch `folder`/`problem`/`root` files; runs the LEMMA inputs check, the Step 1 CLI lookup and the Step 4 installer probe | auditor transcript steps 9, 13, 16 | OBSERVED |
| 12:42:30 | Removes its scratch temp directory | auditor transcript step 18 | OBSERVED |
| 12:42:34–12:42:57 | Writes `<workspace>/PREREQUISITES.md`, `handoff.md`, `progress.md` and its briefing; sends the verdict to the sentinel | auditor transcript steps 20, 25; file mtimes 12:42:54–12:42:57 | OBSERVED |
| 12:42:57–12:43:05 | Verdict message stamped `12:43:05` and delivered | auditor transcript steps 26–27; sentinel transcript step 6 | OBSERVED |
| 12:44:26 | Sentinel receives the verdict (client delivery timestamp) | sentinel transcript step 6 `created_at` | OBSERVED |
| 12:44:26–38 | Sentinel rewrites `BRIEFING.md` to "blocked on pre-flight audit MISSING", relays the notice verbatim to the caller, ends its turn awaiting the user | sentinel transcript steps 7–10; `<state>/sentinel/BRIEFING.md` | OBSERVED |
| 12:45:55 | 10m0s print timeout; stream and stderr written | `lemma.err`; capture mtimes | OBSERVED |
| 12:45:59 | Process exits `3` | `<capture>/lemma.exit` mtime | OBSERVED |

Three timestamp details are worth stating because they are easy to over-read:

- The auditor's message is stamped **12:43:05**, but the sentinel's transcript records delivery at **12:44:26** — an ~81 s gap. The sentinel's next turn begins at the delivery time, so the briefing's `12:43:05Z` stamp names the verdict, not the sentinel's receipt.
- The `## 2026-11-23T12:40:28Z` heading in `DISPATCH.md` is the dispatch message's timestamp, not the file's write time: the auditor wrote the log in its first turn (transcript step 1, 12:41:49; mtime 12:41:58). Likewise the auditor's briefing is headed `12:43:00Z` but was written at 12:42:34–12:42:57.
- The run's reported `duration_seconds` is **172.6**, while the timeout envelope is **10m0s** and the capture mtime is 10m after the user input. In `12` the reported duration tracked the envelope (1,713.85 s of 30m). How this field is computed for a timed-out turn is `UNKNOWN`; the 10m ceiling is taken from `lemma.err`, not from `duration_seconds`.

---

## 4. Artifact tree

Only these files were written. The sentinel wrote two (the request and its own briefing); the auditor wrote the other five, including `DISPATCH.md` — the audit's own log of the dispatch it received. That is the reverse of the common case in `11` §3, where the dispatching agent writes `DISPATCH.md`; here the file sits in the auditor's own folder and its heading carries the dispatch's timestamp, not the write's.

```text
<state>/
├── ORIGINAL_REQUEST.md                223 B   sentinel, 12:40:26
├── sentinel/
│   └── BRIEFING.md                  2,308 B   sentinel, rewritten 12:44:36
└── dependency_preflight/
    ├── BRIEFING.md                  2,030 B   auditor
    ├── DISPATCH.md                    829 B   auditor, first turn (heading stamped 12:40:28)
    ├── handoff.md                   4,182 B   auditor
    └── progress.md                    476 B   auditor

<workspace>/
└── PREREQUISITES.md                 2,892 B   auditor, 12:42:54
```

[OBSERVED — `find <state> -type d` returns exactly `sentinel/` and `dependency_preflight/`; `stat` for bytes and mtimes; auditor transcript step 1 shows the `write_file`/`run_command` calls that create the audit folder's first files]

Deliberately absent, checked by name and by `find`:

| Absent | Why it matters |
|---|---|
| `teamwork_lean/` (any `teamwork_*` route folder) | the route agent was never spawned |
| `problem.lean`, `problem.orig.lean`, any `*.lean` | no formalization or proof artifact exists |
| `sentinel/handoff.md` | the sentinel stopped awaiting the user; it did not close the run |
| `GATE_STATUS.md`, `PROJECT.md`, `SCOPE.md` | no milestone work ran |
| `interviewer/` | `[skip-interview]`; no interview turn |
| `teamwork_tmp/<auditor-id>/` | the auditor reports it cleaned its scratch directory, and it is absent at inspection |

The absence of a handoff and a gate is **not** a route property; it is the shape of a run that stopped on a pre-flight verdict (§7).

---

## 5. The verdict

### 5.1 The dispatch

`DISPATCH.md` is the `teamwork_dependency` dispatch. It names the route, the working directory, the state folder, the request file, and the verdict vocabulary (elided here with `…`; the whole file is in the bundle):

> Run a blocking pre-flight environment and dependency audit for the **Formal Math / Lean 4 (LEMMA)** (`teamwork_lean`) execution path.
> … Files, folders, and URLs named in the request: none (beyond the active workspace `<workspace>`).
> Request text:
> Prove in Lean 4 that 1 + 1 = 2 and check the proof. Use the LEMMA route.
> Return your verdict (READY, MISSING, or OUTAGE) with the full report/notice/diagnostics as required by your protocol.

[OBSERVED — `<state>/dependency_preflight/DISPATCH.md`, whole file quoted in the bundle]

The audit's own briefing carries the two constraints that shape the result: "Not in install mode: do not install anything", and "Never change the request's inputs (its folders, files, or names)". [OBSERVED — `<state>/dependency_preflight/BRIEFING.md` §Key Constraints]

### 5.2 The three missing inputs

The auditor ran the LEMMA inputs validation with empty `folder`, `problem` and `root` values. The exact strings, all three, are in `handoff.md` §1 and repeated in `PREREQUISITES.md` §1:

```text
missing: folder: no text in its file
missing: problem: no text in its file
missing: root: the theorem needs a plain name ([A-Za-z_][A-Za-z0-9_]*); ask the user to rename it
```

[OBSERVED — `<state>/dependency_preflight/handoff.md:8-10`; `<workspace>/PREREQUISITES.md` §1]

Note the semantics: the request named a **theorem to prove in prose** ("1 + 1 = 2") but not a run folder, a Lean problem file, or a theorem identifier. The audit does not synthesise any of them; all three are classed as "user-provided only". [OBSERVED — handoff §2.1; auditor message]

The validator also reads an optional `solution` input (default `<folder>/solution`); it is not in the `missing:` list because it is optional. [OBSERVED — auditor transcript step 13 command text]

### 5.3 The four missing tools

Step 1's CLI lookup returned four misses, with `timeout` itself working:

```text
missing: leap
missing: state_manager_bin
missing: lean_verifier_tool_bin
missing: lean_search_tool_bin
```

[OBSERVED — `handoff.md:11-16`; `progress.md`]

The installer probe then found every installer it needs:

| Probe | Result |
|---|---|
| `git` | `found: git` |
| `uv` | `found: uv` |
| `pipx` | `found: pipx` |
| `python3` | `found: python3`; `sys.version_info >= (3, 10)` → `True` (3.15) |
| `pip` | `pip 26.2.2` (Python 3.15) |

[OBSERVED — `handoff.md:17-23`; `progress.md`]

So the missing dependency is **not** the install path. The verdict is `MISSING` because the LEAP toolchain and Lean backend are absent and the request supplies none of the three inputs — not because the machine cannot install them. [OBSERVED premise; that reading of the verdict is INFERRED and matches the auditor's §2 logic chain]

### 5.4 Install mode and the workspace notice

The handoff says: "Because this audit was not dispatched in install mode, nothing was installed or modified (except writing `PREREQUISITES.md` as required for every `MISSING` verdict)." It concludes "Nothing was installed." `PREREQUISITES.md` states `Verdict: MISSING` and "Install mode: Not active (nothing was installed during this audit)." The audit wrote the full prerequisites document into the workspace root and ended with the five-part handoff. [OBSERVED — handoff §1, §2.4, §4; `<workspace>/PREREQUISITES.md`]

`PREREQUISITES.md` is a user-facing notice, not a state file: verdict, the three inputs with their exact `missing:` strings, the four commands, an `uv tool install` command pinned to a commit, troubleshooting by failure cause, and three Lean-backend options (`leap lean --yes --no-global`, `--project DIR`, `--kimina URL`). [OBSERVED — `<workspace>/PREREQUISITES.md`]

### 5.5 The relay

The sentinel did not act on the audit. It rewrote its briefing to:

> Root orchestrator: not started (blocked on pre-flight audit MISSING)
> Active orchestrator: none
> Pre-flight auditor (`teamwork_dependency`): `21bbc95b…` (kept open for potential install/re-check)
> **Phase**: stopped on pre-flight MISSING (awaiting user reply / changed inputs)

[OBSERVED — `<state>/sentinel/BRIEFING.md` §Active Orchestrator, §Project Status]

and sent the caller the notice **verbatim**, with the instruction to show it as-is, install nothing, and return the user's reply plus changed inputs. The relay ends with the offer "Just say \"Set it up for me\"" — an install path that requires a **further user turn**, not an automatic one. [OBSERVED — sentinel transcript step 7 `send_message`; parent transcript has no reply]

The first briefing draft, written before the audit, had said "Root orchestrator: TBD (waiting on pre-flight audit)". The final file is the post-verdict rewrite. Both are visible in the same transcript; only the second exists on disk. [OBSERVED]

---

## 6. What this settles

| Claim | Evidence | Label |
|---|---|---|
| A request that says "Use the LEMMA route" selects LEMMA, recorded as route `teamwork_lean` | `ORIGINAL_REQUEST.md`; `sentinel/BRIEFING.md` §Route; dispatch text | OBSERVED |
| The pre-flight audit is dispatched **before** any route agent | `teamwork_dependency` conversation exists; no `teamwork_lean/`, no `.lean` file, no orchestrator folder | OBSERVED |
| The gate is **BLOCKING** in practice, not only in prompt prose | the sentinel waited for the verdict, then stopped; no route work followed | OBSERVED |
| The request is recorded **before** the audit is dispatched | one sentinel turn writes `ORIGINAL_REQUEST.md`, the briefing and the dispatch call, in that tool order | OBSERVED — resolves `04` §3's previously `INFERRED` placement |
| `MISSING` is terminal for the run | no route agent, no install, no proof, no gate; sentinel "stopped … awaiting user reply" | OBSERVED |
| The verdict vocabulary is exactly `READY` / `MISSING` / `OUTAGE` | dispatch text; verdict `MISSING` | OBSERVED |
| `MISSING` distinguishes user inputs from tools | three `missing:` input lines + four `missing:` tool lines + installer probe | OBSERVED |
| The auditor writes `PREREQUISITES.md` **in the workspace root** for a `MISSING` verdict | `<workspace>/PREREQUISITES.md`; auditor briefing constraint | OBSERVED |
| The sentinel installs nothing and relays instead | briefing constraint; relay message; handoff "nothing was installed" | OBSERVED |
| Install is a separate, user-requested mode ("Set it up for me") | relay text; handoff §2.4 | OBSERVED (offer); the install-mode behaviour itself is UNKNOWN |
| `teamwork_dependency` is a prompt-level actor that runs as a real conversation and returns a real verdict | auditor conversation id; message; handoff; no registry row (already established in `02`) | OBSERVED (runtime); registration mechanism UNKNOWN |
| The pre-flight auditor is kept open after `MISSING` | "kept open for potential install/re-check" | OBSERVED (sentinel's belief); whether the conversation stays usable UNKNOWN |
| No LEMMA pipeline phase ran | empty artifact set; sentinel phase | OBSERVED |
| The workspace gains exactly one file and no state tree | `find <workspace>` → `PREREQUISITES.md` only | OBSERVED |

### 6.1 Effect on the A13 row

`08` A13 previously described the reference LEMMA route as "statically known only" and counted local's live CI E2E on core Lean as "stronger runtime evidence than the reference has". That comparison now carries a qualifier: the reference's **gate** is observed live (`MISSING`), its **pipeline** is not. `08` is updated accordingly in its A13 row (§2.4) and §4.8. Nothing in this run changes the local side, and it does not supply reference runtime evidence for any proof step.

The static claims it corroborates, without upgrading them, are `04` §2.3 L1 (route target), `04` §3 A1/A2/A6/A9 (pre-flight placement, route scope, `MISSING` terminality, stop-before-work), and `01` §3 (the three-verdict contract). It does **not** corroborate L2–L12, which are the pipeline edges.

---

## 7. What it does not settle

| Open question | Why this run cannot answer it | Label |
|---|---|---|
| The `READY` path | verdict was `MISSING`; no `READY` report exists | UNKNOWN |
| Install mode | "Not active"; the offer was never accepted in this capture | UNKNOWN |
| Whether the sentinel would re-dispatch the same auditor after an install | the briefing says it was kept open; no second dispatch is recorded | UNKNOWN |
| The five-phase LEMMA pipeline, `claim_next`, the 8-worker pool | no route agent started | UNKNOWN |
| The LEMMA gate composition (table vs. prose vs. kernel-only) | no proof was produced | UNKNOWN |
| Whether the gate is enforced in code or by prompt compliance | observed behaviour is consistent with prompt compliance; no code path was exercised | UNKNOWN |
| Whether every `MISSING` writes `PREREQUISITES.md`, or only LEMMA's | the auditor's briefing states it as a rule; only this route is observed | UNKNOWN (one instance) |
| Whether the sentinel eventually times out, fails, or accepts a late reply | the process was cut at 10m while the sentinel was idle; no later turn exists | UNKNOWN |
| Whether `folder`/`problem`/`root` would have been inferred from the prose with a human in the loop | no interview ran (`[skip-interview]`) | UNKNOWN |
| Whether a `MISSING` verdict always means no `/teamwork` artifacts beyond the audit | one run, one route | UNKNOWN |
| Document Review's gate | not exercised | UNKNOWN |

The most important limit: **this is a negative-path observation.** It shows the gate refusing to start work, which is exactly what the static corpus claimed, but a gate that never passes is indistinguishable from a route that cannot run. The `READY` path — the one that proves the LEMMA pipeline is reachable — remains unobserved.

---

## 8. Run outcome: timeout and individual quota

### 8.1 What the CLI reported

Stderr, verbatim:

```text
[agy] print timeout after 10m0s with turn in progress; returning partial output
error: print timeout after 10m0s with the turn still in progress; the response is partial
AGY_ERROR: {"short_error":"print timeout after 10m0s with the turn still in progress; the response is partial","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}
```

[OBSERVED — `<capture>/lemma.err`, 354 bytes]

The stream's final event additionally carries a quota sentence in `error`, with `status: "ERROR"`:

```json
{"event":"result","result":{
  "status":"ERROR",
  "response":"",
  "error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 127h44m31s.",
  "duration_seconds":172.600769903,
  "num_turns":1,
  "usage":{"input_tokens":10472,"output_tokens":139,"thinking_tokens":71,"cache_read_tokens":0,"total_tokens":10611},
  "finished_reason":"print_timeout"}}
```

[OBSERVED — `<capture>/lemma.stream.jsonl:7`, whitespace added here for readability]

There are therefore **two envelopes**, and they must not be collapsed:

| Envelope | Status | Error text | Label |
|---|---|---|---|
| stderr `AGY_ERROR` | `DEADLINE_EXCEEDED`, `retryable: false`, `reason: print_timeout` | print timeout, 10m0s | OBSERVED |
| stream `result` | `ERROR`, `finished_reason: print_timeout` | individual quota, reset `127h44m31s` | OBSERVED |

The stderr envelope is the process outcome; the stream envelope is the turn outcome. Which upstream call produced the quota sentence — the top-level planner turn, a child, or a retry — is not recorded. [UNKNOWN]

The `duration_seconds: 172.6` is inconsistent with the 600 s ceiling and the 600 s mtime span (§3). This document does not use it as the run length. [OBSERVED value; computation UNKNOWN]

### 8.2 Which model and which quota

- The top-level conversation records `gemini-4-argon-medium`; the sentinel records `gemini-4-hydrogen-tiered-high`. [OBSERVED — parent step 1; sentinel steps 1/5/7/10]
- The error names an **individual** quota. Its countdown is `127h44m31s` ≈ 5 d 7 h 44 m, far longer than the 429 windows `07` §3.5 recorded (`34m52s`, `6m57s`). That this long countdown is a different quota class from the 5-hour window is INFERRED. [OBSERVED text and duration]
- From the instant the countdown was emitted, **2026-11-23T12:38:48Z** (the run's request/step-1 timestamp; the 429 instant itself is not separately logged), `+127h44m31s` lands on **2026-11-28T20:23:19Z**: `12:38:48Z + 5d 07h 44m 31s = 2026-11-28T20:23:19Z`. The interview run independently lands on the same instant: `15:54:23.9Z + 124h28m56s = 2026-11-28T20:23:19.9Z`. The two countdowns therefore converge on **`2026-11-28T20:23:19Z`** (shared with `16` §8.3). An earlier draft used the capture mtime `12:45:55Z` and reported `20:29Z`; that anchor is ~7 min late, because the quota sentence is written at the print timeout rather than when the 429 fired. The CLI does not log the countdown start, so both the 12:38:48Z anchor and the reset instant are `INFERRED` arithmetic, not an observed server timestamp; the convergence of two independent countdowns is the evidence. [OBSERVED texts; arithmetic INFERRED]

### 8.3 The control probe, and what it does and does not prove

Earlier in the same window, a one-line probe returned `PONG`. It ran on the **previous 1.5.14 binary** and is therefore a **cross-version control**: it shows the account could complete a model call minutes before the upgrade, not that the 1.5.15 build behaves identically.

```sh
agy -p='Reply with exactly: PONG' --settings '{"model":"gemini-3.8-flash-low"}'
```

| Fact | Evidence | Label |
|---|---|---|
| Probe exited `0` and returned `PONG` | `<capture>/probe.exit` (`EXIT=0`); `probe.stream.jsonl` final `result` (`status: "SUCCESS"`, `response: "PONG\n"`) | OBSERVED |
| Probe took 167.6 s | `probe.stream.jsonl` final `result.duration_seconds` | OBSERVED |
| Probe ran before the LEMMA run | `probe.meta` 12:32:36Z; probe stream mtime 12:35:37Z; LEMMA user input 12:35:55Z | OBSERVED |
| Probe binary | **1.5.14** (`cli-20261123_073238.log:3`), the pre-upgrade build; the LEMMA run is **1.5.15** (`cli-20261123_073544.log:3`) | OBSERVED — **cross-version control** |
| The probe's argv included the settings override | supplied by the capture owner; **no argv record is stored** in `<capture>/probe.*` | UNKNOWN from the capture alone |
| `gemini-3.8-flash-low` answered | the stream records **no model field**; only `PONG` and success | INFERRED from the invocation, not observed in the stream |

The defensible conclusion is narrower than "the quota failure is model-specific": **a model call that the capture owner invoked with an explicit settings override succeeded in the same window in which the LEMMA run's top-level call reported an individual quota, so the quota failure was not a global transport or auth failure.** Whether the override was honoured, and whether it would rescue a `/teamwork` run, is not observed. [INFERRED]

That matters for the remaining live work: the interview and Document Review runs are blocked on the individual tier unless the settings override is accepted **for those runs**. This run supplies no evidence that it is, and `/teamwork` agents run on their own model string (`gemini-4-hydrogen-tiered-high`), which the probe did not exercise. [UNKNOWN]

### 8.4 Recording the outcome correctly

The gate verdict and the run outcome are separate facts:

- The **gate** returned `MISSING` at 12:43:05 and the sentinel relayed it at 12:44:38. That is a complete, successful execution of the pre-flight branch.
- The **run** then sat idle waiting for a user who could not reply inside a print-mode turn, and was cut at 12:45:55 with `print_timeout` and an accompanying individual-quota error.

Do not read the timeout as a failure of the gate, and do not read the gate's `MISSING` as a failure of the run. Neither is an inference about what would happen on the `READY` path.

---

## 9. Verification

Every quoted artifact is reproduced, redacted, in [`live/2026-11-23-lemma-gate/`](live/2026-11-23-lemma-gate/), with a `MANIFEST.sha256` covering the five evidence files (the prose README is excluded by rule — see that bundle's *Integrity*). **The working capture `/tmp/opencode/re-0.9/` is lost**: it was absent when re-checked on 2026-11-24, so `lemma.err`, `lemma.exit`, the full `lemma.stream.jsonl` and `probe.*` cannot be re-read. What survives is the bundle, the transcripts under `brain/<conv>/.system_generated/logs/`, the server logs, and the 1.5.14 archive. Re-check the primary evidence with (from the repository root):

```sh
bundle=docs/re/antigravity-teamwork/live/2026-11-23-lemma-gate
state=$HOME/.gemini/antigravity-cli/scratch/teamwork/9461e3b4-2958-43d9-80fd-685a850fc4af/.agents/teamwork

# bundle integrity (five evidence files; README excluded by rule)
(cd "$bundle" && sha256sum -c MANIFEST.sha256)          # all OK

# version identity: the RUN is 1.5.15; the INSTALLED binary is now 1.5.16
sed -n '3p' ~/.gemini/antigravity-cli/log/cli-20261123_073544.log   # 1.5.15 — the run's process
sed -n '3p' ~/.gemini/antigravity-cli/log/cli-20261123_073238.log   # 1.5.14 — control probe
agy --version                                                       # 1.5.16 today, NOT the run
sha256sum /home/john/.local/bin/agy                                 # 05245f43… (1.5.16)
sha256sum ~/Downloads/cli_linux_x64.tar.gz                          # d5838632… (1.5.14 archive)
# the run's recorded 1.5.15 hash (7b004d26…41fa2d) has no file on disk to re-hash

# run outcome (the .err/.exit files are lost; the bundle carries the result line)
cat "$bundle/stream-tail.jsonl"          # ERROR / individual quota / 127h44m31s / print_timeout

# verdict
grep -n 'missing:' "$bundle/handoff.md"
grep -n 'Verdict:\|Install mode' "$bundle/PREREQUISITES.md"
grep -n 'MISSING\|Install mode' "$bundle/sentinel-BRIEFING.md"

# what was NOT produced (state root still on disk)
find "$state" -type d
find "$state" -name '*.lean' -o -name 'problem*'
```

Expected: five `OK`; three `missing:` input lines and four `missing:` tool lines in the handoff; `Verdict: MISSING` and `Install mode: Not active` in the notice; exactly two state subdirectories (`sentinel/`, `dependency_preflight/`), no `*.lean` anywhere under the state root. The workspace itself was a temporary directory and is gone with the capture; `PREREQUISITES.md` is preserved in the bundle instead.

The auditor's transcript (`~/.gemini/antigravity-cli/brain/<auditor>/.system_generated/logs/transcript_full.jsonl`) shows the work order directly: step 1 writes `DISPATCH.md`, `BRIEFING.md` and `progress.md` and lists the workspace; step 9 writes the three empty scratch input files; step 13 runs the inputs check and the CLI lookup; step 16 runs the installer probe; step 18 removes the scratch directory; step 20 writes the workspace notice and the handoff; step 25 sends the verdict.

---

## 10. Cross-references

- Route and gate contract: [`01-command-contract.md`](01-command-contract.md) §3; [`04-pipeline-topologies.md`](04-pipeline-topologies.md) §2.3, §3.
- Registry and the LEMMA role set: [`02-agent-registry.md`](02-agent-registry.md) rows 21–26 and the `lemma_*` note; [`08-gap-analysis-opencode-teamwork-v2.md`](08-gap-analysis-opencode-teamwork-v2.md) A13.
- Artifact roots and document kinds: [`11-runtime-artifacts.md`](11-runtime-artifacts.md) §2.1, §3.
- Companion live runs: [`12-live-general-run.md`](12-live-general-run.md) (completed General, timeout-cut audit); [`13-live-swe-light-run.md`](13-live-swe-light-run.md) (SWE Light loop and prose verdict).
- Quota precedent: [`07-runtime-observed.md`](07-runtime-observed.md) §3.5 (429 → flash relaunch → inline fallback).
