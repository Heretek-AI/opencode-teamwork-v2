# Evidence Bundle — Live Task-Interview Gate in Print Mode, 2026-11-23

Redacted copies of the documents cited by [`../../16-live-interview-gate-print-mode.md`](../../16-live-interview-gate-print-mode.md). Two print-mode conversations entered the task-interview gate without `[skip-interview]`; one interviewer wrote a gap-marked draft. Neither run passed the gate: the default conversation was refused by an individual-quota 429 on resume, and the flash-low conversation hit its 6-minute print ceiling six seconds after the draft appeared.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.15` (binary `7b004d26…41fa2d`, 273,879,752 B) — server logs `cli-20261123_104212.log`, `_105147.log`, `_105431.log`, `_110054.log`; the `12:32:36Z` probe was `1.5.14`, a cross-version control |
| Capture | `2026-11-23`, 15:42:23Z–16:07:05Z |
| Request | `/teamwork Use the SWE Light route for this small, quick, single-file task: create gate.txt containing exactly: gate. Then stop.` |
| Top-level, default model | `<top-level-default>` on `gemini-4-argon-medium` |
| Coordinator, default model | `<coordinator-default>`; state root `<appDataDir>/brain/<coordinator-default>/scratch/.agents/teamwork/` |
| Interviewer, default model | `<interviewer-default>`; no planner turn, no draft |
| Top-level, flash-low | `<top-level-flash>` on `gemini-4-neon-high` (selected as `gemini-3.8-flash-low`) |
| Coordinator, flash-low | `<coordinator-flash>`; state root `<appDataDir>/scratch/teamwork/<coordinator-flash>/.agents/teamwork/` |
| Interviewer, flash-low | `<interviewer-flash>`; wrote `prompt_draft.md` |
| Workspaces | `<workspace-default>`, `<workspace-flash>` — both empty |
| Gate outcome | draft exists; no approval, no route, no `ORIGINAL_REQUEST.md` |
| Terminal states | default: `ERROR` 429, `Resets in 124h28m56s`; flash-low: `ERROR`, `print_timeout` at 6m0s |

## Redaction

Conversation ids and absolute host paths are replaced consistently. Nothing was reordered or content-edited beyond the substitutions below. `parent-notice.txt` is an assembled excerpt of labelled verbatim blocks; `stream-tail.jsonl` is three `result` lines, one per resumed conversation.

| Original pattern | Replacement |
|---|---|
| the default run's teamwork state root (home + app-data + coordinator id) | `<appDataDir>/brain/<coordinator-default>/scratch/.agents/teamwork/` |
| the flash run's teamwork state root | `<appDataDir>/scratch/teamwork/<coordinator-flash>/.agents/teamwork/` |
| the app-data root | `<appDataDir>` |
| the two workspaces | `<workspace-default>`, `<workspace-flash>` |
| the two top-level conversation ids | `<top-level-default>`, `<top-level-flash>` |
| the two coordinator conversation ids | `<coordinator-default>`, `<coordinator-flash>` |
| the two interviewer conversation ids | `<interviewer-default>`, `<interviewer-flash>` |
| the server error id in the quota envelope | `<redacted>` |

No secrets, credentials, email addresses, tokens or unrelated project content are reproduced. The task text and fixture (`gate.txt` containing `gate`) are this corpus' own.

## Files

| Path | Bytes | Source document |
|---|---:|---|
| `sentinel-BRIEFING.md` | 1,043 | `<state-flash>/sentinel/BRIEFING.md` — the flash coordinator's briefing (whole file) |
| `prompt_draft.md` | 1,189 | `<state-flash>/interviewer/prompt_draft.md` — the draft, whole file, seven `[OPEN: …]` gaps |
| `parent-notice.txt` | 2,834 | both coordinator `send_message` calls, both parent relays, both user resume turns, the server-restart notice and the parent's revive request, as labelled blocks |
| `stream-tail.jsonl` | 1,850 | the last `result` line of `interview2`, `interview3` and `interview4` |

The two `.md` files are byte-identical to the originals **after** the substitutions above; the draft is 1,206 B on disk and 1,189 B here because the normalised workspace placeholder is shorter than the path. Timestamps, headings, blank lines and the file's final newline are preserved.

`stream-tail.jsonl` contains exactly three lines, each a valid JSON object:

1. default resume — `status:"ERROR"`, `error:"Individual quota reached … Resets in 124h28m56s."`, `finished_reason:"error"`;
2. flash-low first turn — `status:"SUCCESS"`, the preparation notice in `response`;
3. flash-low resume — `status:"ERROR"`, `error:"print timeout after 6m0s …"`, `finished_reason:"print_timeout"`.

## Deliberately absent

- the full `interview*.stream.jsonl` — the `init` object, tool inventory and per-step deltas are not needed for any claim in `16`; the dispatch and notice are quoted there;
- the parent and coordinator transcripts — cited by step number in `16` §3, not reproduced;
- the default `sentinel/BRIEFING.md` — its differing fields are tabulated in `16` §4;
- the quota stderr (`interview2.err`) — quoted in `16` §8.1;
- any `ORIGINAL_REQUEST.md`, `PROJECT.md`, `SCOPE.md`, `GATE_STATUS.md`, handoff or orchestrator folder — **none exist** for either run;
- the probe (`probe.*`) — it belongs to the earlier LEMMA capture and is cited, not copied.

Do not read the absence of a route artifact as a route property: it is the shape of a run held at its interview gate.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of every **evidence** file in this directory after redaction. The prose `README.md` is **excluded by rule**, not by oversight: it names the manifest and the file list, so including it makes the manifest self-referential — any edit to the README (including this note) would break its own digest and `sha256sum -c` would fail. Verify this bundle with `sha256sum -c MANIFEST.sha256`; every entry in it must be `OK`. The exclusion applies to evidence bundles in this corpus whose README is prose commentary rather than captured bytes.

## Limits at capture time

- The remaining planned live runs are **pending**: Document Review (`teamwork_document`), the configuration/disabled-command gate, and a native-swarm composition beyond the single 2026-11-22 capture. None is represented here.
- The quota state at capture was reported as **weekly Gemini-models ≈10.86 % remaining**; the individual/default tier then refused further caller turns (`15:54:23Z`). Those percentages are not recorded in any capture file and are labelled `REPORTED` in `16` §8.4.
- No TUI run exists in this bundle. Every statement about print mode is about print mode only.
- No human approval is recorded. The draft was written at 16:06:59Z and the turn ended at 16:07:05Z; it was never sent to the user.
