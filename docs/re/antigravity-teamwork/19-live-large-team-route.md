# Live Large Team Route — Math / Proof (`teamwork_proof`) on 1.5.16

**Status: OBSERVED — route selection only, no fan-out.** One interactive session on
the **1.5.16** CLI was given an explicit Math / Proof (Large Team) request. The
sentinel recorded the request, wrote its briefing, named the route
`teamwork_proof`, created an empty `teamwork_proof_1/` orchestrator folder, and
was stopped there. No explorer, layer, solver, referee, gate or proof artifact
exists. This document records that state and nothing downstream of it.

Evidence bundle: [`live/2026-11-24-large-team-route/`](live/2026-11-24-large-team-route/).

---

## 1. Identity and invocation

| Field | Value | Label |
|---|---|---|
| Date | 2026-11-24 (local −05:00) | OBSERVED — file mtimes |
| CLI | Antigravity Linux CLI **1.5.16** | OBSERVED — the session's own server log line, `server.go:2782 Language server version: 1.5.16` (`run.cli.txt`) |
| Binary | `/home/john/.local/bin/agy`, 275,067,592 B | OBSERVED — corpus live axis (`PROVENANCE.md`) |
| SHA-256 | `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` | OBSERVED — corpus live axis; the hash was **not** re-measured in this pass |
| Model | `Gemini 4 Hydrogen (Medium)` | OBSERVED — the session log's `model_config_manager.go:375 … label="Gemini 4 Hydrogen (Medium)"` (`run.cli.txt`), reported as **Gemini 4 Hydrogen Medium** |
| Interface | TUI session (not `--print`; no `print_timeout`) | OBSERVED — no print-mode lines in the session log |
| Permission flag | `--dangerously-skip-permissions` | REPORTED — session launch; the log excerpt is print-mode-free and does not repeat the flag |
| Working directory | `<workspace>` = `/tmp/opencode` | OBSERVED — briefing (redacted copy) |
| State root | `<appData>/scratch/teamwork/<run-id>/.agents/teamwork/` | OBSERVED — disk; the absolute run id is withheld |
| Outcome | route selected, `Phase: starting`, no fan-out | OBSERVED — state tree below |

**Identity caveat.** The version and model are bound by the session's own log
excerpt in the bundle. The binary hash and size are the corpus' live-axis values
for 1.5.16 (`PROVENANCE.md`), not a hash taken during this run; `agy --version`
was deliberately not run, and no hash was re-computed in this pass. The run is
therefore identified as 1.5.16 by the log line plus the installed file's known
identity, not by a per-run `sha256sum`. [OBSERVED — log line; INFERRED — the
installed bytes are the same file the corpus records]

**What was not done.** `agy` was not invoked again, no route agent was
re-launched, and no plugin code was touched. The evidence is the state tree the
run left on disk and a two-line excerpt of the session log.

---

## 2. The prompt, verbatim

Input to the TUI, as recorded in `ORIGINAL_REQUEST.md`:

```text
/teamwork [skip-interview] Prove that the sum of the first n odd numbers is n^2. Use the Math / Proof (Large Team) route: this is an explicit request for an extremely large team with many agents.
```

The recorded request file preserves the leading bracket as a `## Parameters`
block, exactly as `01` §7 specifies:

```markdown
# Original User Request

## Parameters
[skip-interview]
How this run was launched; not part of the task.

## Initial Request — 2026-11-24T21:31:37Z
Prove that the sum of the first n odd numbers is n^2. Use the Math / Proof (Large Team) route: this is an explicit request for an extremely large team with many agents.
```

[OBSERVED — disk, 319 B, verbatim]

**Argv context.** This was a TUI submission, not a one-shot `-p=` invocation: the
prompt was typed into an interactive session launched with
`--dangerously-skip-permissions`, so there is no `promptLength` field and no
print-mode timeout. The bracket is the only parameter; the rest of the prompt is
the task. The route phrase is carried twice — once in the natural-language
instruction and once in the rationale — so this run cannot separate "the phrase
`Math / Proof (Large Team)` selected the route" from "the phrase *extremely large
team with many agents* selected it". `01` §3 documents both as triggers for this
route. [INFERRED — from the prompt text and `01` §3]

---

## 3. Timeline

Local time is −05:00; the request's own UTC stamp is `2026-11-24T21:31:37Z`
(= `16:31:37` local). File mtimes are local.

| Time | Event | Label |
|---|---|---|
| 16:29 | capture marker file `start.marker` created in `/tmp/opencode/re-r3/` | OBSERVED — mtime |
| 16:31:05 | session's language server starts; logs `Language server version: 1.5.16` | OBSERVED — log excerpt |
| 16:31:16 | model override propagated: `label="Gemini 4 Hydrogen (Medium)"` | OBSERVED — log excerpt |
| 16:31:37 | request timestamp written into `ORIGINAL_REQUEST.md` and the briefing header | OBSERVED — file text |
| 16:31:59.950 | `ORIGINAL_REQUEST.md` written (319 B) | OBSERVED — mtime |
| 16:32:01.121 | `sentinel/BRIEFING.md` written (2,193 B before redaction) | OBSERVED — mtime |
| ~16:32 | `teamwork_proof_1/` exists and is empty; snapshot of the state root taken | OBSERVED — directory listing |
| after 16:32 | capture stopped; no further file appears under the root | OBSERVED — negative find |

The request is recorded **before** the route folder is populated and before any
agent is dispatched — the ordering the prompt requires (`ORIGINAL_REQUEST.md`
"written exactly once, before the chosen agent starts"). [OBSERVED — mtimes and
tree; ordering rule OBSERVED — `01` §7]

---

## 4. The state tree

Whole root (depth-first, directories before files):

```text
d         40 teamwork_proof_1
d         60 sentinel
f       2193 sentinel/BRIEFING.md
f        319 ORIGINAL_REQUEST.md
```

| Entry | Size | Contents | Label |
|---|---:|---|---|
| `ORIGINAL_REQUEST.md` | 319 B | header, `## Parameters`, `## Initial Request` with the prompt | OBSERVED — disk |
| `sentinel/BRIEFING.md` | 2,193 B | mission, identity, constraints, routing decision, active orchestrator, status, auditor status, artifact index | OBSERVED — disk |
| `teamwork_proof_1/` | 0 entries | route orchestrator folder, created but empty | OBSERVED — disk |

There is no `PROJECT.md`, no `SCOPE.md`, no `progress.md`, no `DISPATCH.md`, no
`handoff.md`, no `GATE_STATUS.md` and no agent folder other than `sentinel/`.
[OBSERVED — negative `find`]

---

## 5. The route decision, as written

Verbatim from `sentinel/BRIEFING.md` (paths redacted; emphasis is the file's):

| Field | Value |
|---|---|
| Mission | Route and monitor the proof task ("sum of the first n odd numbers is n^2") via Math / Proof (Large Team) (`teamwork_proof`), then verify and report completion. |
| Path | **Math / Proof (Large Team)** (`teamwork_proof`) |
| Rationale | Mathematical proof task with explicit request for an extremely large team with many agents (`[skip-interview]` parameter applied). |
| Active Orchestrator | Root orchestrator: `TBD`; Active orchestrator: `TBD`; orchestrator state folder `<appData>/scratch/teamwork/<run-id>/.agents/teamwork/teamwork_proof_1` |
| Phase | `starting` |
| Victory Audit — Auditor | `N/A (teamwork_proof verifies via its own verification phase)` |
| Victory Audit — Triggered / Verdict / Retry | `no` / `pending` / `0` |
| Route constraint | "On `teamwork_proof` path: grant extended timeouts (at least 60 minutes) to workers drafting dense mathematical structures, and if one must be terminated, relaunch with clean context rather than forcing a replacement to stitch partial output" |

[OBSERVED — disk; `sentinel-BRIEFING.md` in the bundle. `teamwork_proof` is the
route target `01` §3 and `04` §2.5 reconstruct from the Route Summary.]

Two things are worth separating in that table:

- **The `N/A` auditor is a runtime corroboration of a static claim.** `01` §6 and
  `04` T25 record that this route is verified by its own pipeline and that the
  sentinel spawns **no** `teamwork_victory_auditor`. The briefing writes exactly
  that, before any route work. It does **not** prove the route's own verification
  phase exists or runs; it proves the sentinel's policy for this route.
  [OBSERVED — policy; the phase remains UNKNOWN]
- **The extended-timeout constraint is the route-specific text recovered at
  113,243,471**, reproduced in the briefing almost verbatim. Static `04` T24 and
  this run agree. [OBSERVED — both sides]

---

## 6. Stopped before fan-out

The capture was stopped after the route folder appeared and before any route
agent was dispatched. The negative evidence, checked directly:

- `teamwork_proof_1/` is empty — no `BRIEFING.md`, no `progress.md`.
- There is no `teamwork_layer*/`, `teamwork_explorer*/`, `teamwork_outliner*/`,
  `teamwork_solver*/`, `teamwork_referee*/`, `teamwork_worker*/` or
  `teamwork_curator*/` folder anywhere under the root.
- There is no `final_proof.tex`, no `*.tex`, no `*.lean`, no `GATE_STATUS.md`.
- The sentinel's own briefing still reads `Phase: starting` and
  `Active orchestrator: TBD`.

[OBSERVED — disk, negative `find`]

Consequently **no fan-out occurred**. This is a statement about this run, not
about the route: the route's five phases, its `teamwork_layer` per tree level,
its `×32`/`×8` fan-outs and its `[8,5,1]` tournament trees are exactly as static
as they were before. `04` §2.5 remains the specification; this run did not
execute it.

---

## 7. What this run settles

1. **The route label is reachable at runtime on 1.5.16, and the explicit
   "extremely large team" trigger is honoured.** The sentinel wrote both
   `Math / Proof (Large Team)` and `teamwork_proof`, with the rationale naming
   the explicit team-size request. This corroborates `01` §3's trigger pair and
   `04` T1 at the level of *selection*, not pipeline execution. [OBSERVED]
2. **`[skip-interview]` was applied on this route.** No interviewer folder and
   no `prompt_draft.md`; routing happened on the first request. This is
   consistent with the token's contract (`01` §3) and with the other skip-token
   runs (`12`, `13`, `15`). [OBSERVED — absence; token→no-gate causality
   inferred, as in the earlier records]
3. **No sentinel victory auditor is attached to this route.** The briefing's
   `Auditor: N/A (teamwork_proof verifies via its own verification phase)` is the
   prompt's policy rendered at runtime, before any verdict. [OBSERVED — briefing]
4. **The route-specific ≥60-minute timeout constraint is real runtime text, not
   only a binary literal.** The briefing reproduces it in its constraints
   section. [OBSERVED]
5. **The recording order holds.** The request file and the sentinel briefing
   exist before the orchestrator folder has any content. [OBSERVED — mtimes]

---

## 8. What remains UNKNOWN

- **Layer and phase composition.** No `teamwork_layer` folder, no explorer,
  outliner, solver, referee or merger was created. Whether this route would have
  used the five phases exactly as `04` §2.5 describes, and how it would have
  sized the fan-outs, is **UNKNOWN** for this run.
- **The gate.** No `GATE_STATUS.md`, no gate round, no judge verdict. The
  Math / Proof route's gate shape is **UNKNOWN**; this run says nothing about
  whether it is a table, a phase verdict, or both.
- **`final_proof.tex` and the verification phase.** The briefing says the route
  verifies via its own verification phase; no `final_proof.tex`, referee report
  or `is_correct` verdict exists. Whether the route *always* self-verifies, and
  what its own phase actually checks, remains **UNKNOWN** — the static prompt
  asserts it and one briefing repeats it; neither is an execution.
- **Whether this route always fans out.** One stopped selection is not a
  frequency. The route may fan out on every run, or only after some condition;
  **UNKNOWN**.
- **Why the run stopped.** The capture was stopped deliberately; the CLI's
  behaviour if left running is **UNKNOWN**. This document does not treat the
  stop as a route failure, a quota event or a model decision.
- **Model-tier assignment.** The session ran `Gemini 4 Hydrogen (Medium)`. Which
  tier each route agent would receive, and whether the route's workers would be
  forced to flash (`06` S4/S5), is **UNKNOWN**.

The Large Team **gate** is not `X`; no gate was observed. The route is not shown
to **always** self-verify; only the sentinel's policy and the static prompt say
it does. And the absence of a sentinel auditor here does not prove the route's
own auditor always runs.

---

## 9. Relation to the static documents

- `04` §2.5 (T1, T24, T25) is corroborated at selection level; no static claim is
  revised. `04`'s runtime note points here.
- `01` §3's trigger pair and `01` §6's completion-verification row are unchanged.
- `07`/`11`'s native-swarm observation is a different 1.5.14 outcome and is not
  compared here; the command-version correction that governs the 2026-11-24
  repeats is in [`20-live-swarm-repeats.md`](20-live-swarm-repeats.md).
- The version axis is 1.5.16. No offset in this document is a binary offset; the
  one static offset cited (113,243,471) is a **1.5.14** offset quoted from `04`.

---

## 10. Limits

One session, one model tier, one interface (TUI), one prompt, one stop point.
The snapshot was taken seconds after the route folder appeared; a longer
observation could have produced a different tree. No transcript or tool trace
was captured, so the sentinel's exact call sequence is inferred from file order
and mtimes, not from a message log. The run id, the account identity and every
absolute UUID path are withheld; the bundle carries a redacted briefing and the
verbatim request, and nothing else.
