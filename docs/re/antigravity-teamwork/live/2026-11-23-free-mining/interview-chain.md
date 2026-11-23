# Interview Gate — Structural Excerpts from a Completed Prior Run

**Purpose.** Stable, redacted excerpts for [`../../14-interview-gate-observed.md`](../../14-interview-gate-observed.md). The source root is a completed run's state tree under `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/`. The task body is withheld; only structural lines, generic question/answer text and the approval envelope are reproduced.

| Placeholder | Meaning |
|---|---|
| `<appDataDir>` | `~/.gemini/antigravity-cli` |
| `<state>` | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` |
| `<run-conv>` | run/sentinel conversation |
| `<relay-conv>` | caller/relay conversation |
| `<interviewer-conv>` | `teamwork_interviewer` conversation |
| `<orchestrator-conv>` | `teamwork_orchestrator` conversation |
| `<workspace>` | user project directory |
| `<task body>` | approved task text, withheld |

## 1. State-file mtimes

| File | mtime (UTC−05:00) | Bytes |
|---|---|---:|
| `interviewer/prompt_draft.md` | `2026-11-15 21:23:50` | 2,089 |
| `ORIGINAL_REQUEST.md` | `2026-11-15 21:26:56` | 2,159 |
| `sentinel/BRIEFING.md` | `2026-11-15 23:20:05` (last edit) | 2,174 |
| `orchestrator/DISPATCH.md` | `2026-11-15 21:27:39` | 2,450 |
| `TEST_INFRA.md` | `2026-11-15 21:41:39` | 1,685 |
| `TEST_READY.md` | `2026-11-15 22:06:53` | 2,669 |

## 2. Dispatch of the interviewer

`<run-conv>` step 1, `PLANNER_RESPONSE` (`02:20:04Z`). Tool call, structural fields only:

```json
{
  "name": "invoke_subagent",
  "args": {
    "Model": "inherit",
    "Role": "Task Interviewer",
    "TypeName": "teamwork_interviewer",
    "Workspace": "inherit"
  }
}
```

The prompt named the interviewer state folder and `Relay to: <relay-conv>`; the request body is replaced by `<task body — initial request, withheld>`. The same turn wrote `sentinel/BRIEFING.md` with:

```text
- **Last user request**: <request summary, withheld> (Task interview in progress)
- **Pending clarifications**: Interview underway
```

## 3. First draft: unresolved placeholders

`<interviewer-conv>` step 7 wrote `interviewer/prompt_draft.md`. The first version contained five explicit slots, in this form:

```text
[OPEN: What is the primary purpose of this port (production, showcase, exploration)?]
[OPEN: Where should the Godot project live (e.g. continue in <workspace> or a new directory)?]
[OPEN: Which restrictions should be placed on the team, if any?]
[OPEN: Which Godot version should the project target?]
[OPEN: What specific verification mechanism, test suites, or rubrics should be used ...?]
```

This version was overwritten; its content survives only in the transcript write.

## 4. Answers

`<interviewer-conv>` step 12, a `SYSTEM_MESSAGE` from `<relay-conv>` (`02:23:28Z`), reproduced with the path normalised:

```text
User answers:
1. (a) Production: A complete, fully playable 100% port matching the original game
2. (a) <workspace> (continue and verify the existing port in this workspace)
3. (a) Godot 4.x (matching the existing project's Godot 4.7 configuration)
4. (e) None of these: no restrictions, any approach that works
5. (a) Use and expand existing tools/tests in the repository (e.g. make test, make audit, extraction tools) against the original Steam install at <source-directory>
```

## 5. Final draft and relay instruction

`<interviewer-conv>` step 13 overwrote the draft with the resolved text (mtime `21:23:50`). Step 15 sent the relay a message containing the draft path and a `BEGIN PROMPT` / `END PROMPT` block, with this instruction (excerpt):

```text
If your user approves the draft as is, send the text between the markers verbatim to the Teamwork run, ... as one message whose first line is `Approved task prompt:`, tell your user the team is starting, and send me nothing more; any change, however small, comes back to me ...
```

The same message also told the relay it could answer and approve for itself if it had nobody to ask. That clause is why the approval is procedural, not authenticated.

## 6. Approval envelope

`<run-conv>` step 6, `SYSTEM_MESSAGE` (`02:26:15Z`), from `<relay-conv>`. First lines:

```text
Approved task prompt:
<task body — identical to the final prompt_draft.md body, withheld>
```

The sentinel then killed `<interviewer-conv>` and wrote `ORIGINAL_REQUEST.md`.

## 7. Recorded request: no `## Parameters`

`<state>/ORIGINAL_REQUEST.md` headings:

```text
# Original User Request

## Initial Request — 2026-11-16T02:26:15Z
```

There is no `## Parameters` section. The body matches the final draft; the request file adds only the two headings above.

## 8. Routing decision

`<run-conv>` step 7 `thinking` contains the classification (excerpt):

```text
Initial routing analysis concluded that the current task ... falls under "General" categorization ... The determination led to the decision to route the task to the `teamwork_orchestrator` ...
```

`<run-conv>` step 10 then called `invoke_subagent` with `TypeName:"teamwork_orchestrator"`, and `<state>/orchestrator/DISPATCH.md` exists from `21:27:39`.

## 9. Redaction rule

Only the task body, project paths and unrelated project values were replaced. Record structure, step numbers, UTC timestamps, mtimes, file sizes, the generic interview questions/answers and the approval envelope are unchanged. No transcript file, secret or email is included.
