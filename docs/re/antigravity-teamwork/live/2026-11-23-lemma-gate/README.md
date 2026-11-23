# Evidence Bundle — LEMMA Blocking Pre-flight Gate, 2026-11-23

Redacted copies of the state documents cited by [`../../15-live-lemma-gate-observed.md`](../../15-live-lemma-gate-observed.md). The run took the **LEMMA** route, was stopped by its blocking pre-flight audit with the verdict `MISSING`, and produced no Lean work.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.14` (binary `37873b80…97d8c94`) |
| Capture | `2026-11-23`, 12:32:36Z–12:45:59Z |
| Top-level conversation | `<top-level>` |
| Coordinator / sentinel | `<coordinator>` |
| Pre-flight auditor | `<auditor>` |
| Run state root | `<appDataDir>/scratch/teamwork/<coordinator>/.agents/teamwork/` |
| Workspace | `<workspace>` |
| Request | `/teamwork [skip-interview] Prove in Lean 4 that 1 + 1 = 2 and check the proof. Use the LEMMA route.` |
| Gate verdict | `MISSING` (12:43:05Z) |
| Terminal state | exit `3`; `print_timeout` at 10m0s; stream `status: "ERROR"` with an individual-quota message |

## Redaction

Conversation ids and absolute host paths are replaced consistently. Nothing was reordered, summarised or content-edited beyond the substitutions below; `stream-tail.jsonl` is an explicit excerpt (see *Files*).

| Original pattern | Replacement |
|---|---|
| the run's teamwork state root (home + app-data + coordinator id) | `<state>` |
| the auditor's scratch directory (home + app-data + auditor id) | `<auditorScratch>` |
| the app-data root | `<appDataDir>` |
| the run's absolute workspace path | `<workspace>` |
| the Python/pip interpreter prefix under the host's Linuxbrew tree | `<pythonPrefix>` |
| the top-level conversation id | `<top-level>` |
| the coordinator conversation id | `<coordinator>` |
| the auditor conversation id | `<auditor>` |
| any remaining home-directory prefix | `<homeDir>` |

No secrets, credentials, email addresses, tokens or unrelated project content are reproduced. The install command in `PREREQUISITES.md` is the auditor's own quoted command, not a credential.

## Files

| Path | Bytes | Source document |
|---|---:|---|
| `DISPATCH.md` | 597 | `<state>/dependency_preflight/DISPATCH.md` — the `teamwork_dependency` dispatch |
| `handoff.md` | 3,906 | `<state>/dependency_preflight/handoff.md` — the five-part audit report |
| `sentinel-BRIEFING.md` | 1,828 | `<state>/sentinel/BRIEFING.md` — post-verdict rewrite (whole file) |
| `PREREQUISITES.md` | 2,874 | `<workspace>/PREREQUISITES.md` — the user-facing notice (whole file) |
| `stream-tail.jsonl` | 1,083 | `<capture>/lemma.stream.jsonl` lines 5–7 **only** |

`stream-tail.jsonl` is an excerpt of three consecutive events — the subagent-creation step, the error step, and the final `result` — chosen because they carry the gate's dispatch, the workspace and the run outcome. The other four lines (the `init` object, the user-input step, the first agent response, and the subagent `ACTIVE` step) are not reproduced, to keep the initial prompt and tool inventory out of the bundle. The excerpt is byte-verbatim after redaction, and each line remains valid JSON.

## Deliberately absent

- `dependency_preflight/BRIEFING.md` and `progress.md` — not needed to support a cited claim; their content is represented in `handoff.md`;
- `ORIGINAL_REQUEST.md` — its full eight lines are quoted in `15` §2;
- the sentinel transcript and the parent transcript — cited by step number in `15`, not reproduced;
- the full `lemma.stream.jsonl` and `lemma.err` — the outcome text is quoted in `15` §8;
- the control probe (`probe.*`) — not part of the run being recorded;
- any `teamwork_lean/`, `problem.lean`, proof, gate or verification artifact — **none exist** for this run.

Do not read the absence of a route artifact as a route property: it is the documented shape of a run stopped on a pre-flight verdict.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of each file in this directory after redaction.
