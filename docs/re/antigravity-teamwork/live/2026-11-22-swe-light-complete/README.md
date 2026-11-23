# Evidence Bundle — Completed SWE Light Run, 2026-11-23

Redacted copies of the eight state documents cited by [`../../13-live-swe-light-run.md`](../../13-live-swe-light-run.md) §12. This is the **completed** successor to the interrupted SWE Light run; the earlier bundle is [`../2026-11-22-swe-light/`](../2026-11-22-swe-light/).

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.14` |
| Capture | `2026-11-23`, 02:07:34Z–02:34:13Z |
| Top-level conversation | `8d162c43-ff84-4298-8c7b-f698da82192c` |
| Coordinator / sentinel | `5a2f01f1-a0f2-46cc-97fa-8967ba123f7c` |
| SWE Light orchestrator | `93eb99f5-eecf-4690-b4dd-191b3766e852` |
| Implementer | `43fa897d-fcc1-465e-aed6-c67eb5008db8` |
| Reviewer | `f2ac7b04-e4c3-4b11-a43a-892c4d111efa` |
| Victory auditor | `054a14c2-6ecb-48d3-96d3-29f7b0559c73` |
| Run state root | `<appDataDir>/brain/<coordinator>/scratch/.agents/teamwork/` |
| Auditor scratch | `<appDataDir>/brain/<auditor>/scratch/` |
| Terminal state | exit `0`; `VICTORY CONFIRMED` (prose) |

## Redaction

Complete copies with only path normalisation:

| Original pattern | Replacement |
|---|---|
| the coordinator brain state root (home + app-data + coordinator id) | `<appDataDir>/brain/<coordinator>/scratch/.agents/teamwork` |
| the auditor brain scratch (home + app-data + auditor id) | `<appDataDir>/brain/<auditor>/scratch` |
| the app-data root | `<appDataDir>` |
| the run's absolute workspace path | `<workspace>` |
| any remaining home-directory prefix | `<homeDir>` |

No truncation, reordering or content edit. Conversation ids outside the path prefixes are retained where they identify the run. The fixture is the corpus' own two-file `hello` example.

## Files

| Path | Bytes | Source document |
|---|---:|---|
| `ORIGINAL_REQUEST.md` | 441 | `<state>/ORIGINAL_REQUEST.md` |
| `sentinel/BRIEFING.md` | 2,586 | `<state>/sentinel/BRIEFING.md` |
| `sentinel/handoff.md` | 2,457 | `<state>/sentinel/handoff.md` |
| `teamwork_swe_1/BRIEFING.md` | 4,212 | `<state>/teamwork_swe_1/BRIEFING.md` |
| `teamwork_swe_1/DISPATCH.md` | 1,161 | `<state>/teamwork_swe_1/DISPATCH.md` |
| `teamwork_swe_1/progress.md` | 1,278 | `<state>/teamwork_swe_1/progress.md` |
| `teamwork_swe_1/handoff.md` | 2,562 | `<state>/teamwork_swe_1/handoff.md` |
| `teamwork_victory_auditor_1/handoff.md` | 4,916 | `<appDataDir>/brain/<auditor>/scratch/handoff.md` |

The auditor handoff is filed under `teamwork_victory_auditor_1/` for citation symmetry, but it was written in the auditor's **own** brain scratch, not the run root. The run-root `teamwork_victory_auditor_1/` folder was empty because of the `write_file` sandbox.

## Deliberately absent

- implementer and reviewer handoffs — **none exist**; those folders are empty and the agents reported by `send_message`;
- `GATE_STATUS.md`, `PROJECT.md`, `SCOPE.md`, `verify/victory.json` — none were written by this route;
- the full `stream.jsonl` / `agy.log` and brain transcripts;
- any unrelated personal path or project content.

Do not infer a structured verdict from the absence of JSON: the verdict is prose in the sentinel/SWE handoffs and the auditor's report.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of each file after redaction.
