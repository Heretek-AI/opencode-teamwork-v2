# Evidence Bundle — Command Repeats and the Obsolete `/teamwork-preview`, 1.5.16, 2026-11-24

Redacted copies of the artifacts cited by
[`../../20-live-swarm-repeats.md`](../../20-live-swarm-repeats.md). Three
experiments are included:

1. **Experiment 1** — `/teamwork-preview` + a fizzbuzz task, N=2. Both runs
   executed **inline**; no swarm and no `.agents/teamwork` state appeared.
2. **The expansion probe** — `/teamwork-preview` vs `/teamwork` with a `PONG`
   prompt. Zero model turns in both arms. `/teamwork` expands; the old command
   does not.
3. **Experiment 2** — `/teamwork` + the same fizzbuzz task, N=2. Both runs
   dispatched teamwork and selected **SWE Light (`teamwork_swe`)**; neither
   created a `swarm/` board and neither produced an inline result at the
   snapshot.

The two experiments answer different questions. Experiment 1 is a
**command-deprecation** finding; Experiment 2 is a **selector observation for
these conditions** (1.5.16, `Gemini 4 Hydrogen (Medium)`, TUI, this prompt).

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.16`, 275,067,592 B, SHA-256 `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` |
| Version evidence | each run's own log line, `server.go:2782 Language server version: 1.5.16` (`probe-*.cli.txt`, `c-run.cli.txt`, `d-run.cli.txt`); `agy --version` was **not** run |
| Model | `Gemini 4 Hydrogen (Medium)` in every arm, from each log's model-override line |
| Interface | Experiments 1/2: TUI sessions with `--dangerously-skip-permissions`. Probe: print mode, `--dangerously-skip-permissions`, killed on the client-side line |
| Workspaces | `ws-a`, `ws-b`, `ws-c`, `ws-d` under the capture root; `ws-c`/`ws-d` were empty at their snapshots |
| Markers / request times | A/B markers 16:33/16:34 local; C `21:37:14Z`; D `21:38:47Z` (local −05:00) |
| Prompts | Experiment 1: `/teamwork-preview [skip-interview] Create fizzbuzz.js … Keep it small and cheap: a quick single self-contained change.` Experiment 2: the same with `/teamwork`. Probe: `/teamwork[-preview] [skip-interview] Reply with exactly: PONG` |
| Outcomes | Exp 1 **2/2 inline**; Exp 2 **2/2 teamwork (SWE Light), 0/2 swarm, 0/2 inline**; probe **zero turns, expansion only for `/teamwork`** |

## Method

**Experiment 1.** Each arm was a separate TUI session. A marker file was created
immediately before the prompt; after the run, `find <workspace> -newer <marker>`
was used to attribute files to that run, and the app-data directory was searched
for a `swarm.json` or `.agents/teamwork` root newer than the marker. Neither
existed. The product files were then re-executed in place with `node test.js`
(4/4 and 14/14, exit 0).

**Probe.** Each arm was a separate print-mode process. The driver watched the CLI
log for `Print mode: expanded slash command`. The `new` arm was killed on that
line; the `old` arm, which never produced it, was killed a few seconds after
`Print mode: … sending message`. Both streams report `num_turns:0`, an
`interrupted` result and all-zero usage, so the observed step precedes any model
call and is quota-independent.

**Experiment 2.** Same marker method as Experiment 1. Each capture copied the
`brain/<conversation>/scratch/.agents/teamwork/` tree after the route briefing
appeared. Both were still at `Phase: in progress`; no gate, product or native
swarm existed at the snapshot.

## Redaction

| Original pattern | Replacement |
|---|---|
| `/home/john/.gemini/antigravity-cli/brain/<conversation>` (C, D state roots) | `<appData>/brain/<conversation>` |
| `/tmp/opencode/re-r4/ws-c`, `/tmp/opencode/re-r4/ws-d` | `<workspace-C>`, `<workspace-D>` |
| D's caller conversation id | `<caller-conversation>` |
| the probe conversation ids | `<conversation-old>`, `<conversation-new>` |
| the probe trajectory ids | `<trajectory-old>`, `<trajectory-new>` |
| `/tmp/opencode` in the probe logs | `<workspace>` |
| the account email on `server_oauth.go:221` | `<account-email>` |

`probe-*.cli.txt` keep the logger's own prefixes so timestamps stay attributable;
only the substitutions above were applied. `probe-*.jsonl` are the two stream
lines each, re-serialised by the capture (no spaces after `:`/`,`), keys and
values unchanged. `probe-*.err` are the identical 19-byte line
`error: interrupted`. The request files are byte-identical (368 B each). The
briefings are 1,890 B (C) and 1,897 B (D) after path/id substitution; no content
was edited. `state-tree.txt` files are generated `find` listings.

The prose `README.md` is **excluded from the manifest by rule**: it names the
manifest and the files, so hashing it would make the manifest self-referential.

**Why `.txt`.** The capture's files are `old.log` and `new.log`. This
repository's `.gitignore` drops `*.log`, so the copied logs are named
`probe-old.cli.txt` and `probe-new.cli.txt` to keep the evidence tracked rather
than silently untracked. The bytes are the capture's log lines, unchanged apart
from the substitutions above. The two TUI excerpts (`c-run.cli.txt`,
`d-run.cli.txt`) are already `.txt` for the same reason.

## Files

| Path | Contents |
|---|---|
| `probe-old.cli.txt` / `probe-new.cli.txt` | the two print-mode session logs, whole, redacted; `old` has no expansion line, `new` has `expanded slash command "teamwork" (system)` |
| `probe-old.jsonl` / `probe-new.jsonl` | each arm's `init` and `result` stream lines; `new` carries `expanded_commands`, `old` does not; both `num_turns:0` |
| `probe-old.err` / `probe-new.err` | each arm's 19-byte stderr |
| `ws-a/fizzbuzz.js`, `ws-a/test.js` | Experiment 1 run A fixtures (284 B / 815 B) |
| `ws-b/fizzbuzz.js`, `ws-b/test.js` | Experiment 1 run B fixtures (291 B / 524 B) |
| `ws-a.ls.txt`, `ws-b.ls.txt` | the capture's workspace listings for A and B |
| `c-state/ORIGINAL_REQUEST.md` | run C's request, verbatim (368 B) |
| `c-state/sentinel-BRIEFING.md` | run C's briefing, paths redacted, whole file |
| `c-state/state-tree.txt` | C's state tree at capture (two files, no orchestrator folder) |
| `c-run.cli.txt` | C's two identity lines: `1.5.16` and `Gemini 4 Hydrogen (Medium)` |
| `d-state/ORIGINAL_REQUEST.md` | run D's request, verbatim (368 B) |
| `d-state/sentinel-BRIEFING.md` | run D's briefing, paths and caller id redacted |
| `d-state/state-tree.txt` | D's state tree at capture (adds the empty `teamwork_swe_1/`) |
| `d-run.cli.txt` | D's two identity lines |

## Deliberately absent

- the full probe logs are present; the full TUI logs are not — only the two
  identity lines per Experiment 2 run are copied (the TUI logs are host/MCP/auth
  churn and do not record the expansion step the same way);
- the `/tmp/opencode/re-r4/` capture root itself — only the cited files are
  copied, and workspace listings stand in for the empty directories;
- `teamwork_swe_1/` — it is empty in D and absent in C; the state trees record
  that;
- any transcript, `invoke_subagent` arguments or agent message — none was
  captured;
- the account email, conversation ids, caller id and absolute UUID paths;
- any completed route, gate, product or native-swarm artifact — none existed at
  either Experiment 2 snapshot.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of every **evidence** file in this directory
after redaction, with `README.md` excluded by rule. Verify with:

```sh
sha256sum -c MANIFEST.sha256
```

Every entry must report `OK`.

## Limits at capture time

- One build, one tier, one interface, one task per experiment. The 2/2 results
  are exact for this sample; they are not frequencies or defaults.
- Experiment 2 was snapshotted at `Phase: in progress`; a later state could add
  a gate, a product or a failure that this bundle does not contain.
- The probe establishes the expansion step and the absence of a model turn. It
  does not establish whether `/teamwork-preview` remains registered internally,
  nor why it stopped expanding.
- No claim is made about 1.5.14, 1.5.15 or any later build.
