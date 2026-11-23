# Evidence Bundle — Free Mining, 2026-11-23

**Purpose.** Redacted excerpts for two unknowns settled from existing state on 2026-11-23, with no live run:

1. the 429 → `flash` chain in the parent transcript of the 2026-11-21/22 quota-partial `/teamwork-preview` run, cited by [`../../07-runtime-observed.md`](../../07-runtime-observed.md) §3.5.3 and [`../../11-runtime-artifacts.md`](../../11-runtime-artifacts.md) §1.4;
2. the interview gate in a completed prior run, cited by [`../../14-interview-gate-observed.md`](../../14-interview-gate-observed.md).

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.14` |
| 429 source | `<appDataDir>/brain/<parent-conv>/.system_generated/logs/transcript_full.jsonl`, steps 22/26/32/35/36/40 |
| Interview source | `<appDataDir>/scratch/teamwork/<run-id>/.agents/teamwork/`, plus `<appDataDir>/brain/<run-conv>/` and `<appDataDir>/brain/<interviewer-conv>/` transcripts |
| Observation date | 2026-11-23 |
| Live run | **none** — read-only mining of existing records |

## Files

| Path | What it is |
|---|---|
| `429-chain.jsonl` | Selected transcript records, one JSON object per line, steps 22–40. `read_file` calls and unrelated tool results are omitted. |
| `interview-chain.md` | Structural excerpts of the interviewer dispatch, draft placeholders, answers, approval envelope, `ORIGINAL_REQUEST.md` headings and routing decision. Task body withheld. |

## Redaction

`429-chain.jsonl` is a **selection**, not a contiguous transcript: it keeps only the six records named above and, within steps 22 and 32, only the `invoke_subagent` call (the step-22 `read_file` and all tool outputs are removed). No other field was edited. The prompt in those calls is the corpus' own tiny `hello` task.

`interview-chain.md` replaces the task body and project paths with `<task body>`, `<workspace>`, `<source-directory>` and `<appDataDir>`. Conversation ids are placeheld. The generic interview questions, the five lettered answers, the approval envelope, timestamps, mtimes and file sizes are unchanged.

No secret, token, email, environment dump or unrelated project content is included. No full transcript is included.

## What is not here

- the full parent transcript or its tool outputs;
- the interviewer's full task body or any project requirement text;
- any user project file;
- the second 429's separate tool result (the inline `write_file` at step 37), which would add only the `hello.txt` write already quoted in `07` §3.5.2.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of each file in this directory after redaction.
