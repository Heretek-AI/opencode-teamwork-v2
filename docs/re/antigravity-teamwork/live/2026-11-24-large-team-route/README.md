# Evidence Bundle — Large Team Route Selection, 1.5.16, 2026-11-24

Redacted copies of the artifacts cited by
[`../../19-live-large-team-route.md`](../../19-live-large-team-route.md). One
interactive (TUI) session on the **1.5.16** CLI was given an explicit Math /
Proof (Large Team) request. The sentinel recorded the request, wrote its
briefing, named the route `teamwork_proof`, created an empty
`teamwork_proof_1/` folder, and was stopped there.

This is **route-selection evidence**. No route agent ran, no layer or phase
exists, no gate was written and no proof artifact was produced.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.16`, `/home/john/.local/bin/agy`, 275,067,592 B, SHA-256 `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` |
| Version evidence | the session's own log line, `server.go:2782 Language server version: 1.5.16` (`run.cli.txt`); `agy --version` was **not** run and the hash was not re-measured for this run |
| Model | `Gemini 4 Hydrogen (Medium)`, from the session log's model-override line (`run.cli.txt`) |
| Interface | TUI session with `--dangerously-skip-permissions`; no `--print`, no `print_timeout`, no `promptLength` |
| Workspace | `/tmp/opencode` (normalised to `<workspace>` in the redacted briefing) |
| State root | `<appData>/scratch/teamwork/<run-id>/.agents/teamwork/` (absolute run id withheld) |
| Request time | `2026-11-24T21:31:37Z` (local `16:31:37`, −05:00) |
| Prompt | `/teamwork [skip-interview] Prove that the sum of the first n odd numbers is n^2. Use the Math / Proof (Large Team) route: this is an explicit request for an extremely large team with many agents.` |
| Outcome | route `teamwork_proof` recorded, `Phase: starting`, empty route folder, no fan-out |

## Method

The prompt was typed into one TUI session. After the request file, sentinel
briefing and empty route folder appeared, the capture was stopped and the state
root was snapshotted with `find`. No agent was re-launched and no CLI command was
re-run to produce this bundle. The negative claims (no layer, no gate, no proof)
come from listing the whole root, not from reading a transcript.

The two-line `run.cli.txt` is an excerpt of the session's language-server log,
copied **only** for identity: the version line and the first model-override line.
It is not a capture of the session and is not used for any behavioural claim.

## Redaction

| Original pattern | Replacement |
|---|---|
| `/home/john/.gemini/antigravity-cli/scratch/teamwork/<run-id>` (the original run id is withheld) | `<appData>/scratch/teamwork/<run-id>` |
| `/tmp/opencode` (the working directory) | `<workspace>` |

`ORIGINAL_REQUEST.md` is byte-identical to the original (319 B); it contains no
path, account or run identifier. `sentinel-BRIEFING.md` is 1,979 B against the
original 2,193 B — the difference is exactly the path substitutions above, with
no content edit. `state-files.txt` and `state-tree.txt` are the original
listing and a generated `find` listing, both relative to the state root. The
account email, the run id and every absolute UUID path are withheld. The binary
path appears only in this README.

The prose `README.md` is **excluded from the manifest by rule**: it names the
manifest and the files, so hashing it would make the manifest self-referential.

## Files

| Path | Contents |
|---|---|
| `ORIGINAL_REQUEST.md` | the recorded request, verbatim: `## Parameters` with `[skip-interview]`, then the initial request |
| `sentinel-BRIEFING.md` | the sentinel briefing, whole file, paths redacted: mission, route decision, rationale, `TBD` orchestrator, `Phase: starting`, `Auditor: N/A`, the ≥60-minute constraint, artifact index |
| `state-files.txt` | the capture's `stat`-style listing of the three files it saw, with local mtimes and byte counts |
| `state-tree.txt` | `find . -mindepth 1 -printf '%y %10s %P\n' | sort` over the state root — two directories, two files |
| `run.cli.txt` | two lines from the session log: the `1.5.16` version line and the `Gemini 4 Hydrogen (Medium)` override |

## Deliberately absent

- the full session log (29 KB of host/MCP/auth churn) — only the two identity
  lines are copied;
- any transcript, message store, `invoke_subagent` call or tool trace — none was
  captured, so the sentinel's call order is read from file mtimes, not quoted;
- `teamwork_proof_1/` itself — it is empty; `state-tree.txt` records it as a
  directory with no entries;
- the account email, run id, absolute UUID paths and the workspace path;
- any route, layer, phase, gate, `final_proof.tex` or Lean artifact — none
  existed at capture time.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of every **evidence** file in this directory
after redaction, with `README.md` excluded by rule. Verify with:

```sh
sha256sum -c MANIFEST.sha256
```

Every entry must report `OK`.

## Limits at capture time

- One session, one model tier, one interface. Nothing here is a statement about
  print mode, another tier, 1.5.14/1.5.15, or a completed Large Team run.
- The run was stopped deliberately. The absence of fan-out is a property of this
  capture, not evidence that the route never fans out.
- The `N/A` auditor line is the sentinel's policy for this route, not proof that
  the route's own verification phase executed.
