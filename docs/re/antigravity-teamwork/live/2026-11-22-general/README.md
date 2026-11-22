# Evidence Bundle — General Live Run, 2026-11-22

**Purpose.** Redacted copies of the ten state documents cited by [`../../12-live-general-run.md`](../../12-live-general-run.md). They are the stable citation targets for that run; the machine-local state root may be pruned by the CLI.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.14` |
| Capture | `2026-11-22`, 22:17:18Z–22:47:18Z |
| Top-level conversation | `9d81af51-373c-4f2e-b6b8-11f53d18f6f6` |
| Teamwork coordinator / sentinel | `d9f5d6b1-be80-4411-830b-4fa5df298ff0` |
| Project orchestrator | `e62b1c3e-a5d2-42e2-bbbb-d93eceecdbe5` |
| Victory auditor | `3c0737cb-489c-462e-aa02-2604ef773348` |
| Source state root | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` |
| Terminal state | exit `3`, `print_timeout` at 30m0s |

## Redaction

Every file below is a **complete** copy of the named source document, with only these normalisations applied:

| Original pattern | Replacement |
|---|---|
| the absolute shared-root prefix (home + app-data + run id) | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork` |
| the app-data root | `<appDataDir>` |
| the run's absolute workspace path | `<workspace>` |
| the Homebrew prefix | `<homeDir>/.linuxbrew` |
| any remaining home-directory prefix | `<homeDir>` |
| the file-owner column | `<user> <user>` |

No other edit, truncation or reordering was made. Conversation ids are retained because they are the run identity, not unrelated personal data. The fixture project is the corpus' own two-file `hello` example; it contains no user project content. No transcript file is included.

## Files

| Path | Bytes | Source document |
|---|---:|---|
| `ORIGINAL_REQUEST.md` | 267 | `<state>/ORIGINAL_REQUEST.md` |
| `sentinel/BRIEFING.md` | 2,021 | `<state>/sentinel/BRIEFING.md` |
| `orchestrator/BRIEFING.md` | 4,773 | `<state>/orchestrator/BRIEFING.md` |
| `orchestrator/DISPATCH.md` | 725 | `<state>/orchestrator/DISPATCH.md` |
| `orchestrator/GATE_STATUS.md` | 800 | `<state>/orchestrator/GATE_STATUS.md` |
| `orchestrator/progress.md` | 1,258 | `<state>/orchestrator/progress.md` |
| `teamwork_worker_m1/handoff.md` | 3,837 | `<state>/teamwork_worker_m1/handoff.md` |
| `teamwork_reviewer_m1/handoff.md` | 7,926 | `<state>/teamwork_reviewer_m1/handoff.md` |
| `teamwork_challenger_m1/handoff.md` | 6,759 | `<state>/teamwork_challenger_m1/handoff.md` |
| `teamwork_auditor_m1/handoff.md` | 7,289 | `<state>/teamwork_auditor_m1/handoff.md` |

Sizes are post-redaction. The source set was 10 of the run's 31 state files; the bundle is not the whole state tree.

## What is not here

- the full `main-transcript.jsonl`, `coordinator-transcript.jsonl`, `orchestrator-transcript.jsonl` or stream logs;
- the empty `teamwork_victory_auditor_1/` folder (the timeout residue);
- the unmodified `teamwork_*.md` siblings (`BRIEFING.md`, `DISPATCH.md`, `progress.md`) for the four gate agents, because their content is not cited by `12`;
- any unrelated personal path, environment dump or project content.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of each file in this directory after redaction.
