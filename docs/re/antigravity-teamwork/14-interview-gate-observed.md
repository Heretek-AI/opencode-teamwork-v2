# Interview Gate Observed — One Completed Prior Run

**Status: OBSERVED — disk and transcript, one prior completed run (2026-11-15/16), not a controlled live invocation.** This document records the interview gate as it actually ran in a state root left by the user's own completed `/teamwork` run. It supplies the chain the live quota-partial run could not (`07` §3.5, `11` §1.5): a `teamwork_interviewer` was dispatched, wrote a draft, received answers, resolved the draft's placeholders, and the run routed only after a message beginning `Approved task prompt:`. The approval is **procedural, not authenticated** — see §5.

Paths are normalised to placeholders so no unrelated project content or machine-local path is reproduced. The project body of the task is withheld; only structural and generic lines are quoted. The redacted evidence excerpt is in [`live/2026-11-23-free-mining/`](live/2026-11-23-free-mining/).

| Placeholder | Resolves to |
|---|---|
| `<appDataDir>` | `~/.gemini/antigravity-cli` |
| `<state>` | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` |
| `<run-conv>` | the run/sentinel conversation id (also the run-id directory) |
| `<relay-conv>` | the caller/relay conversation that delivered the request and the approval |
| `<interviewer-conv>` | the dispatched `teamwork_interviewer` conversation |
| `<orchestrator-conv>` | the dispatched `teamwork_orchestrator` conversation |
| `<workspace>` | the user project directory |

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md). `OBSERVED — transcript` means a `step_index` in `<appDataDir>/brain/<conv>/.system_generated/logs/transcript_full.jsonl`; `OBSERVED — disk` means a state file read under `<state>`; `INFERRED` means reasoned from those observations.

**CLI version: `UNKNOWN`.** [OBSERVED — absence] This run is dated 2026-11-15/16, which **predates the earliest surviving server log** on the host (`~/.gemini/antigravity-cli/log/cli-20261117_180830.log`, which reports `Language server version: 1.5.9`). The run's transcripts survive, but a transcript carries no `Language server version:` line, and the binary that executed it was replaced by later auto-updates. So neither of the two identity readings that could name the version — the server-log line or a hashable copy of the binary — exists for this run. The document therefore records `UNKNOWN` and does not assign it to 1.5.14, 1.5.15 or 1.5.16. See [`PROVENANCE.md`](PROVENANCE.md) *version axes* and the version identity rule.

---

## 1. Why this run is usable

The root satisfies all five conditions the question needs:

| Condition | Observation | Label |
|---|---|---|
| an interviewer folder and a draft exist | `<state>/interviewer/prompt_draft.md`, 2,089 B, mtime `2026-11-15 21:23:50 -05:00` | OBSERVED — disk |
| the sentinel recorded the interview as in progress | `<state>/sentinel/BRIEFING.md`: `**Last user request**: … (Task interview in progress)` and `**Pending clarifications**: Interview underway` | OBSERVED — disk |
| an approval message arrived | `<run-conv>` transcript step 6, a `SYSTEM_MESSAGE` whose body begins `Approved task prompt:` | OBSERVED — transcript |
| the request was recorded without a `## Parameters` block | `<state>/ORIGINAL_REQUEST.md` headings: `# Original User Request`, `## Initial Request — 2026-11-16T02:26:15Z`, then `## Requirements`; no `## Parameters` | OBSERVED — disk |
| the run routed and completed | transcript steps 7/10 route to `teamwork_orchestrator`; the sentinel's final briefing records `Verdict: VICTORY CONFIRMED` | OBSERVED — transcript + disk |

One completed run is an existence proof of the gate, not a general rule. The sequence below is the whole of what this root witnesses.

---

## 2. The artifact chain

All times are the same event in two clocks: transcript `created_at` is UTC (`Z`); state-file mtimes are local (UTC−05:00). The order is the proof, and every adjacent pair is consistent with the next.

| # | Time (UTC / local mtime) | Event | Artifact or record | Label |
|---:|---|---|---|---|
| 1 | `02:20:04Z` | the request reaches the sentinel from `<relay-conv>`; no bracket parameter | `<run-conv>` step 0 `SYSTEM_MESSAGE` | OBSERVED — transcript |
| 2 | `02:20:04Z` | sentinel dispatches `teamwork_interviewer`, `Model:"inherit"`, with the state folder and `Relay to: <relay-conv>` | `<run-conv>` step 1 `invoke_subagent`, `TypeName:"teamwork_interviewer"`, `Role:"Task Interviewer"` | OBSERVED — transcript |
| 3 | `02:20:15Z` | sentinel writes its briefing with `Task interview in progress` | `<state>/sentinel/BRIEFING.md` (first write; later edited) | OBSERVED — transcript + disk |
| 4 | `02:21:40Z` | interviewer writes a **draft with unresolved `[OPEN: …]` placeholders** | `<state>/interviewer/prompt_draft.md` (first version, later overwritten) | OBSERVED — transcript (`<interviewer-conv>` step 7) |
| 5 | `02:22:20Z` | interviewer asks the relay to put the questions to the user | `<interviewer-conv>` step 9 `send_message` to `<relay-conv>` | OBSERVED — transcript |
| 6 | `02:23:28Z` | the relay returns `User answers:` with five lettered choices | `<interviewer-conv>` step 12 `SYSTEM_MESSAGE` | OBSERVED — transcript |
| 7 | `02:23:50Z` | interviewer rewrites the draft with the placeholders resolved | `<state>/interviewer/prompt_draft.md`, final mtime `21:23:50`, 2,089 B | OBSERVED — transcript (`<interviewer-conv>` step 13) + disk |
| 8 | `02:23:50Z` | interviewer sends the draft path and a `BEGIN PROMPT` / `END PROMPT` block to the relay, instructing that approval be sent as a message whose first line is `Approved task prompt:` | `<interviewer-conv>` step 15 `send_message` | OBSERVED — transcript |
| 9 | **`02:26:15Z`** | **approval arrives**: a message from `<relay-conv>` whose body begins `Approved task prompt:` and carries the task text | `<run-conv>` step 6 `SYSTEM_MESSAGE` | OBSERVED — transcript |
| 10 | `02:26:56Z` (mtime `21:26:56`) | sentinel writes `ORIGINAL_REQUEST.md` with the approved text; it kills `<interviewer-conv>` and routes **General** | `<run-conv>` step 7: `manage_subagents(Action="kill", …)`, `write_file` `ORIGINAL_REQUEST.md`; thinking names the General classification and `teamwork_orchestrator` | OBSERVED — transcript + disk |
| 11 | `02:26:56Z` (mtime `21:26:56`) | sentinel briefing updated to `Last user request: Approved task prompt received`, phase `in progress` | `<state>/sentinel/BRIEFING.md` | OBSERVED — transcript + disk |
| 12 | `02:27:39Z` (mtime `21:27:39`) | sentinel dispatches `teamwork_orchestrator` with the approved prompt and the `ORIGINAL_REQUEST.md` path | `<run-conv>` step 10 `invoke_subagent`, `TypeName:"teamwork_orchestrator"`; `<state>/orchestrator/DISPATCH.md` | OBSERVED — transcript + disk |
| 13 | later, same run | the run completes; victory auditor returns `VICTORY CONFIRMED` | final sentinel briefing and handoff | OBSERVED — disk |

The **approval precedes both `ORIGINAL_REQUEST.md` and the orchestrator dispatch**, and follows the final draft by 2 min 25 s. The routing decision is not a separate file: it is the sentinel's step-7 thinking plus the step-10 dispatch, and the dispatch target is the only operational proof of the route. [OBSERVED — transcript; "the thinking caused the dispatch" INFERRED from adjacency]

---

## 3. What proves an interviewer actually ran

An `interviewer/` folder alone could be a template. Four independent records make this an execution:

1. **The dispatch names the interviewer type.** `<run-conv>` step 1 calls `invoke_subagent` with `TypeName:"teamwork_interviewer"` and `Role:"Task Interviewer"`. [OBSERVED — transcript]
2. **The interviewer's own conversation contains the work.** `<interviewer-conv>` step 7 writes `prompt_draft.md`; step 9 sends the questions; step 12 receives the answers; step 13 overwrites the draft; step 15 sends the `BEGIN PROMPT` / `END PROMPT` block. [OBSERVED — transcript]
3. **The draft on disk matches the last write, not the first.** Its final content is the resolved version (no `[OPEN:` markers), and its mtime `21:23:50` matches the step-13 write, not the step-7 draft. [OBSERVED — disk + transcript]
4. **The sentinel cleans the interviewer up after approval.** `<run-conv>` step 7 kills `<interviewer-conv>` in the same turn that writes `ORIGINAL_REQUEST.md`, which is the protocol's stated post-routing action. [OBSERVED — transcript]

The declared `Model:"inherit"` is also observed, but it is not evidence that the interviewer ran on a particular model; that field says only what the dispatcher requested. [OBSERVED for the field; child model resolution `UNKNOWN`]

---

## 4. Placeholder resolution

The interviewer did not receive a ready prompt. Its first draft contained five explicit `[OPEN: …]` slots; the relay's answers filled them; the final draft replaced every slot.

| Slot (generic, from the first draft) | Final value observed | Evidence |
|---|---|---|
| purpose of the work | `Production: A complete, fully playable 100% port matching the original game` | `<interviewer-conv>` step 12 answer 1 |
| working directory | `<workspace>`, continue and verify the existing project | step 12 answer 2 |
| target engine version | `Godot 4.x (matching the existing project's Godot 4.7 configuration)` | step 12 answer 3 |
| restrictions / integrity mode | answer `None of these: no restrictions, any approach that works`; the draft line becomes `Integrity mode: development` | step 12 answer 4; final draft line 4 |
| verification mechanism | `Use and expand existing tools/tests in the repository (e.g. make test, make audit, extraction tools)` | step 12 answer 5 |

The final draft's body is **byte-identical to the body written into `ORIGINAL_REQUEST.md`**, apart from the recording frame: the request file adds `# Original User Request` at the top and a `## Initial Request — 2026-11-16T02:26:15Z` heading before the task text. A `diff` of the draft against the request body shows only that added heading and a trailing newline. [OBSERVED — disk (`diff`, `cmp`); the identity is a file fact, not an inference]

This is why the absence of `[OPEN:` in the request file is meaningful: it is not that the draft never had placeholders, but that they were **resolved before approval**. The initial draft with placeholders is not preserved on disk (it was overwritten); its content is known only from the step-7 write in the interviewer transcript. [OBSERVED — transcript; the overwrite is OBSERVED from the mtime/step correspondence]

---

## 5. Approval evidence versus mere spec presence

The recovered prompt says the sentinel routes on the first message beginning `Approved task prompt:` (`prompts/sentinel-routing.md`, interview section). That is a **specification of a string convention**. The run shows the convention was followed; it does not show that a human approved, or that the sender was authenticated.

| Claim | Evidence | Label |
|---|---|---|
| The prompt specifies `Approved task prompt:` as the routing trigger | recovered prompt text, cited in `01` | OBSERVED — source |
| A message with that first line reached the sentinel after the draft relay | `<run-conv>` step 6, timestamp `02:26:15Z`, sender `<relay-conv>` | OBSERVED — transcript |
| The approved text matches the final draft | `ORIGINAL_REQUEST.md` body equals `prompt_draft.md`, modulo the recording heading | OBSERVED — disk |
| The sentinel treated it as approval and routed | step 7 kills the interviewer and writes the request; step 10 dispatches the orchestrator | OBSERVED — transcript |
| A human being read and approved the draft | no signature, no user-authored token, no second channel; the only evidence is the relay's message | **UNKNOWN** — the record cannot distinguish a human approval from a relay/agent self-approval |
| The approval is authenticated | no mechanism is present: the protocol matches a literal first line, and the relay's own instructions permit it to answer and approve for itself when it has nobody to ask | **OBSERVED absence; conclusion INFERRED** |

The interviewer's step-9 relay instructions make the last row concrete: they tell the relay to answer and approve for itself if it has nobody to ask, and to name the answers it gave itself. That instruction is part of the shipped workflow, so an `Approved task prompt:` message is **procedural evidence that the gate was traversed**, not proof of human sign-off. [OBSERVED — transcript; the trust consequence INFERRED]

This distinction matters for any reimplementation: matching the prefix is enough to unlock routing in the observed client, and the record cannot be used as an audit trail of who approved what.

**0.11.0 note (this repository).** The gap this record names is addressed for
the plugin's own gate by [ADR 0011](../../adr/0011-authenticated-prompt-approval.md):
`human-approved`/`ci-attested` now require an external Ed25519 approval bound to
the exact `prompt_draft.md` bytes, the run id, and a one-use nonce, verified
before the plan writes anything. That still does not establish that a human read
the draft; it makes the procedural string match insufficient, not the approval
comprehended. This research document remains a record of the observed
Antigravity client, not of the plugin's gate.

---

## 6. The `## Parameters` absence

`ORIGINAL_REQUEST.md` has no `## Parameters` section. The request arrived without a bracket, and the prompt's rule is to emit that section only when the request began with a counting bracket. The file's headings are:

```text
# Original User Request

## Initial Request — 2026-11-16T02:26:15Z
```

[OBSERVED — disk] By contrast, the 2026-11-22 General run's bracket-led request has `## Parameters` / `[skip-interview]` / `How this run was launched; not part of the task.` before the same heading (`12` §2.2). The two files therefore show the conditional block in both states, from two runs. [OBSERVED — disk; the conditionality is INFERRED from the prompt rule plus the two files]

---

## 7. What remains UNKNOWN

- **Whether a human approved.** The message proves the gate ran; it does not prove who sent it. The relay is explicitly allowed to self-approve. [UNKNOWN]
- **Whether this is the only sequence.** One completed run. The timing (draft → questions → answers → final draft → approval) may vary; no second run was read for this chain. [UNKNOWN]
- **Whether approval is ever cryptographically or session-authenticated.** No such check appears in the observed path; the client may have one outside the transcript. [UNKNOWN; static-RE only]
- **Whether the interview can be answered in print mode.** This run was not the print-mode quota experiment; the answers arrived by message. The print-mode question remains as stated in `07` §5 step 3. [UNKNOWN]
- **The interviewer's effective model.** `Model:"inherit"` is a request, not a resolved value. [UNKNOWN]
- **Whether every route uses the same approval string.** Only the General route follows this approval in the sample. [UNKNOWN]

---

## 8. Evidence

The redacted excerpt bundle is [`live/2026-11-23-free-mining/`](live/2026-11-23-free-mining/): the `429` decision chain (documented in `07` §3.5.3 and `11` §1.4) and a structural interview-chain excerpt with the project body withheld. Each file carries its redaction rule and a SHA-256 manifest.
