# Evidence Bundle — Live Document Review Run, 2026-11-24

Redacted copies of the artifacts cited by [`../../18-live-document-review.md`](../../18-live-document-review.md). One TUI run of the **1.5.16** CLI took a `.tex` paper through the Document Review (`teamwork_document`) route and returned a verified critique.

The run **completed and delivered**. The final sentinel state records `Phase: complete`, `Verdict: VICTORY CONFIRMED` and `Delivered results: startup notice sent; progress updates sent; final verified critique report ready for delivery`. The auditor handoff is the source for the verdict phases (A/B/C). The earlier mid-audit snapshot of the sentinel briefing (`Phase: auditing`, verdict pending) is **not** reproduced here; `sentinel-BRIEFING.md` is the final state.

This is one run on one build. It does not establish that every Document Review run uses this layout, and it does not establish that the route never writes a gate table in another run.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.16` |
| Version evidence | the run's own server log line, `server.go:2782 Language server version: 1.5.16` (`<appDataDir>/log/cli-20261124_160951.log:3`); `agy --version` was **not** run for this capture |
| Binary | `<homeDir>/.local/bin/agy`, 275,067,592 B, SHA-256 `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` (re-hashed after the run; mtime `2026-11-24 14:02:08 −05:00`) |
| Capture | `2026-11-24`, 21:07:48Z–21:29:54Z (16:07:48–16:29:54 local, −05:00) |
| Account | `authMethod=consumer`; the account email in the log is withheld |
| Method | local TUI session; the first invocation was interrupted and the caller conversation was resumed |
| Workspace | `<workspace>`, containing `paper.tex` (328 B) and the generated `DOCUMENT_TEXT_MAP.md` (353 B) |
| State roots | `<run-root-1>` (the interrupted attempt: 2 files) and `<run-root-2>` (the resumed attempt: 154 files at final inspection, 149 before the auditor's four files and the sentinel handoff) |
| Route | `teamwork_document`, with a blocking `teamwork_dependency` pre-flight (`READY`) |
| Terminal state | final sentinel briefing `Phase: complete`, `Verdict: VICTORY CONFIRMED`; the TUI process received `SIGINT` at 21:29:54Z after the final sentinel writes |

## Method

1. A TUI session ran `/teamwork` (expanded client-side) with `[skip-interview]` and the request in `ORIGINAL_REQUEST.md`.
2. The first attempt created `<run-root-1>` and wrote only `ORIGINAL_REQUEST.md` and `sentinel/BRIEFING.md` before the process exited. The caller conversation was then **resumed**; the resume created a **second** run root, `<run-root-2>`, rather than continuing the first (see `18` §2).
3. The resumed sentinel dispatched `teamwork_dependency`; the auditor returned `READY` because the input is a `.tex` file, so the Document Review row's PDF-only probe condition is false.
4. `teamwork_document` wrote `ANALYSIS_PARTITION.md`, split the paper into `Claim`, `Method` and `Conclusion`, ran one `[4,2,1]` RSA tree per segment, then a `[4,1]` synthesis tree and a reducer.
5. The sentinel dispatched `teamwork_document_victory_auditor`; the auditor returned `VICTORY CONFIRMED` (Phase A PASS, Phase B PASS, Phase C 4/4).
6. The sentinel cancelled its crons and terminated subagents. The final briefing and handoff record completion.

No source file was rewritten and no problem in the paper was solved; the report is a critique only.

## Redaction

Every file below is a complete copy of the named source document with only these normalisations. Substitutions are consistent across the bundle.

| Original pattern | Replacement |
|---|---|
| the run's absolute state-root prefix (home + app-data + run id) | `<state>` |
| the interrupted attempt's absolute state-root prefix | `<state-first>` |
| the app-data brain directory, `<appDataDir>/brain` | `<brain>` |
| the app-data root, `<homeDir>/.gemini/antigravity-cli` | `<appDataDir>` |
| the run workspace | `<workspace>` |
| the capture root | `<capture>` |
| any remaining home-directory prefix | `<homeDir>` |
| the caller / top-level conversation id | `<caller-conv>` |
| the interrupted attempt's sentinel conversation/root id | `<run-root-1>` |
| the resumed sentinel conversation/root id | `<run-root-2>` |
| the Document Review orchestrator conversation id | `<document-orch>` |
| the pre-flight auditor conversation id | `<dependency-auditor>` |
| the Claim / Method / Conclusion group conversation ids | `<claim-group>`, `<method-group>`, `<conclusion-group>` |
| the synthesis group conversation id | `<synthesis-group>` |
| the victory auditor conversation id | `<victory-auditor>` |
| any other captured conversation id | `<conversation>` |
| the account email | `<email>` (and withheld from the prose) |

The report's line and section citations into `paper.tex` and `DOCUMENT_TEXT_MAP.md` are unchanged. The bundle preserves headings, lists and table shapes; it does not preserve project content beyond the corpus' own ten-line paper. No credentials, tokens or unrelated personal paths are present.

**Why some files are shorter than their sources.** Path substitution shortens the byte counts in the file table. The redacted `unit_report_conclusion.md` is 13,204 B against 13,531 B source; `DOCUMENT_REVIEW_REPORT.md` is 7,518 B against 7,792 B. The content is otherwise complete.

## Files

| Path | Bytes | Source document |
|---|---:|---|
| `ORIGINAL_REQUEST.md` | 327 | `<state>/ORIGINAL_REQUEST.md` (verbatim request with `## Parameters`) |
| `sentinel-BRIEFING.md` | 2,176 | `<state>/sentinel/BRIEFING.md` (final: `Phase: complete`, `Verdict: VICTORY CONFIRMED`) |
| `dependency-DISPATCH.md` | 563 | `<state>/teamwork_dependency_r1/DISPATCH.md` |
| `dependency-handoff.md` | 2,860 | `<state>/teamwork_dependency_r1/handoff.md` (verdict `READY`; the PDF row's `When` is confirmed false) |
| `document-DISPATCH.md` | 538 | `<state>/teamwork_document_r1/DISPATCH.md` (pre-flight verdict relayed) |
| `document-handoff.md` | 2,587 | `<state>/teamwork_document_r1/handoff.md` (phases 1–4, all subagents killed) |
| `ANALYSIS_PARTITION.md` | 2,399 | `<state>/teamwork_document_r1/ANALYSIS_PARTITION.md` |
| `DOCUMENT_TEXT_MAP.md` | 353 | `<workspace>/DOCUMENT_TEXT_MAP.md` |
| `unit_report_claim.md` | 12,675 | `<brain>/<claim-group>/unit_report_claim.md` |
| `unit_report_method.md` | 5,568 | `<state>/teamwork_group_method/unit_report_method.md` |
| `unit_report_conclusion.md` | 13,204 | `<state>/teamwork_group_conclusion/unit_report_conclusion.md` |
| `candidate_1.md` | 6,342 | `<state>/teamwork_group_synthesis/synthesis/candidate_1.md` |
| `CANDIDATES.md` | — | index of all four candidates; only candidate 1 is reproduced |
| `DOCUMENT_REVIEW_REPORT.md` | 7,518 | `<brain>/<synthesis-group>/DOCUMENT_REVIEW_REPORT.md`; byte-identical to `final_reduced_report.md` before redaction |
| `auditor-DISPATCH.md` | 1,334 | `<state>/teamwork_document_victory_auditor_r1/DISPATCH.md` |
| `auditor-BRIEFING.md` | 3,263 | `<state>/teamwork_document_victory_auditor_r1/BRIEFING.md` |
| `auditor-handoff.md` | 7,293 | `<state>/teamwork_document_victory_auditor_r1/handoff.md` (verdict, Phase A/B/C, caveat) |
| `state-files.tsv` | — | both roots: `<run-root-1>` (2 files) and `<run-root-2>` (154 files), with local mtimes and sizes |

Sizes are post-redaction. The run root also contains the per-agent state (`BRIEFING.md`, `DISPATCH.md`, `progress.md`, `handoff.md`) for each of the 26 RSA agents and the intermediate `handoff_N.md` / `agg_l*.md` / `evolved_l*.md` files; `state-files.tsv` inventories them all.

## Deliberately absent

- the full CLI log and the TUI transcript — only the version line and the on-disk artifacts are quoted;
- the other three synthesis candidates and the intermediate segment aggregations, except as hashes/sizes in `CANDIDATES.md` and as rows in `state-files.tsv`;
- the per-agent `BRIEFING.md` / `DISPATCH.md` / `progress.md` bodies for the 26 RSA agents — their paths and sizes are in `state-files.tsv`, and the two group handoffs that narrate the trees are included;
- `<state>/sentinel/handoff.md` — the sentinel's own completion handoff; it is cited in `18` §1 and listed in `state-files.tsv`, but not reproduced;
- the account email, keyring/token lines, MCP connection churn and any unrelated personal path;
- any `GATE_STATUS.md` — **none was written in this run**; the victory auditor is the verification mechanism (`18` §8).

## Integrity

`MANIFEST.sha256` lists the SHA-256 of every **evidence** file in this directory after redaction. The prose `README.md` is **excluded by rule**: it names the manifest and the file list, so including it makes the manifest self-referential and any edit to the README would break its own digest. Verify with `sha256sum -c MANIFEST.sha256`; every entry must be `OK`.

## Limits

- One run, one `.tex` input, one build, one account. The artifact-placement inconsistency recorded in `18` §7 is a property of **this** run; whether it recurs is `UNKNOWN`.
- The pre-flight row was not probed because its condition was false for a `.tex` input. The PDF path (`python:pypdfium2`, `python:Pillow`) is therefore **not exercised** here.
- No `GATE_STATUS.md` was written in this run. That is an observed absence for this route instance, not a claim that Document Review never writes one.
- The victory auditor's `stat` could not read the `brain/` paths under its sandbox, though `read_file` could; the handoff records that caveat (`auditor-handoff.md` §3).
