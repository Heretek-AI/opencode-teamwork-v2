# Evidence Bundle — SWE Light Live Run, 2026-11-22

Redacted copies of the five state documents cited by [`../../13-live-swe-light-run.md`](../../13-live-swe-light-run.md). The run was killed by a server restart in Round 2; the bundle therefore contains **no handoffs and no gate file**, because none were written.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.14` |
| Capture | `2026-11-22`, 23:03:50Z–23:18:38Z |
| Top-level conversation | `8e6decab-d1a6-433e-871e-8ae98e551663` |
| Coordinator / sentinel | `de4caef3-434f-4591-9b19-7e13439cc095` |
| SWE Light orchestrator | `23ea31fc-c92d-4b47-a88f-93616700c53b` |
| Round 1 implementer | `005eec9e-d2ab-408f-89e8-bdc4fa483260` |
| Round 2 reviewer | `1ebc2d4e-b0a1-4ccb-8934-ed3ab4933fdf` |
| Source state root | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/` |
| Terminal state | no exit file, no final result; server restart |

## Redaction

Complete copies with only path normalisation:

| Original pattern | Replacement |
|---|---|
| the absolute shared-root prefix (home + app-data + run id) | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork` |
| the app-data root | `<appDataDir>` |
| the run's absolute workspace path | `<workspace>` |
| any remaining home-directory prefix | `<homeDir>` |

No truncation, reordering or content edit. Conversation ids are retained as the run identity. The fixture is the corpus' own two-file `hello` example.

## Files

| Path | Bytes | Source document |
|---|---:|---|
| `ORIGINAL_REQUEST.md` | 332 | `<state>/ORIGINAL_REQUEST.md` |
| `sentinel/BRIEFING.md` | 1,853 | `<state>/sentinel/BRIEFING.md` |
| `swe_light/BRIEFING.md` | 3,615 | `<state>/swe_light/BRIEFING.md` |
| `swe_light/DISPATCH.md` | 625 | `<state>/swe_light/DISPATCH.md` |
| `swe_light/progress.md` | 879 | `<state>/swe_light/progress.md` |

## Deliberately absent

- `teamwork_implementer_r1/handoff.md` — **does not exist**; the folder contains only `progress.md`.
- `teamwork_reviewer_r2/handoff.md` — **does not exist**; the folder contains only `progress.md`.
- `GATE_STATUS.md`, `PROJECT.md`, `SCOPE.md`, `TEST_INFRA.md`, `TEST_READY.md` — none were written by this route.
- the full `stream.jsonl` / `agy.log` and brain transcripts;
- the victory-auditor folder — it was never created.

Do not infer a verdict from this bundle. The implementer's and reviewer's completion evidence is in transcript messages and `progress.md`, not in a handoff.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of each file after redaction.
