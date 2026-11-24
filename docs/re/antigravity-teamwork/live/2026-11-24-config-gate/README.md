# Evidence Bundle — 1.5.16 Config-Gate Probe, 2026-11-24

Redacted copies of the artifacts cited by [`../../17-live-config-gate-probe.md`](../../17-live-config-gate-probe.md). Four print-mode invocations of the **1.5.16** CLI probed the `/teamwork` slash command's client-side expansion. Every arm was killed before a model turn, so the bundle records **zero tokens and zero model turns** in all four arms.

This is an **observation of the expansion step**, not of enforcement. No disabled or admin-gated state was produced, and no route, gate or agent ran.

## Source

| Item | Value |
|---|---|
| CLI | Antigravity Linux CLI `1.5.16`, binary `<binary>`, 275,067,592 B, SHA-256 `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` |
| Version evidence | the run's own server log line, `server.go:2782 Language server version: 1.5.16` (`T.cli.txt`, and the same line in the C1/C2 logs). `agy --version` was **not** run in this pass |
| Capture | `2026-11-24`, 14:32:33–14:33:21 local (−05:00) ≈ 19:32:33–19:33:21Z |
| Account | `authMethod=consumer`, keyring auth. The `server_oauth.go:221` line also carries an account email; that field is **withheld** here and in `17` |
| Admin controls | the client logged `Failed to refresh cache in background: admin controls not applicable` twice per authenticated arm — a consumer account, not an admin-managed one |
| Workspace | `<workspace>` — an empty scratch directory |
| Arms | T (baseline), C1 (`--disable-slash-commands`), C2 (`/not-a-command` prompt), C3 (`--settings '{"enable-teamwork-subagent":false}'`) |
| Prompt | `/teamwork [skip-interview] Reply with exactly: PONG` — `promptLength=51`; C2 uses `/not-a-command Reply with exactly: PONG` — `promptLength=39` |
| Outcome | T expands `teamwork`; C1 and C2 do not; C3 is rejected at argument parsing; all four take zero turns |

## Method

Each arm was a separate print-mode process. The driver polled the CLI log for `Print mode: expanded slash command`; when that line did not appear, it waited three seconds after `Print mode: … sending message` and sent `SIGTERM`. The prompt was chosen so that a surviving model turn would have produced the single word `PONG`; none did.

The method is quota-independent because the observed step precedes the model call. The expansion line is written by `printmode.go:962` after `session.go:201 … sending message` and **before** `conversation_manager.go:1080 … Forwarding user message`, and the stream's `init` event reports `expanded_commands` while the final `result` reports `num_turns:0` and an all-zero `usage`. No model request is made for the claim being tested, so a quota refusal cannot manufacture or mask it.

## Redaction

Conversation ids, the workspace and the binary path are replaced consistently. Nothing was reordered or content-edited beyond the substitutions below.

| Original pattern | Replacement |
|---|---|
| the binary path `/home/john/.local/bin/agy` | `<binary>` |
| the T conversation id | `<conversation-T>` |
| the C1 conversation id | `<conversation-C1>` |
| the C2 conversation id | `<conversation-C2>` |
| the run workspace `/tmp/opencode/re-1.5.16/ws` | `<workspace>` |
| the account email on `server_oauth.go:221` | withheld — not reproduced in any file in this bundle |

`T.cli.txt` keeps the logger's own prefix (`I1124 14:32:44.646487       1 session.go:201]`) so the timestamps stay attributable. `T.stream.jsonl` was re-serialised with no spaces after `:` and `,`; its keys, values, tool order and line count are unchanged. `C3.err` is byte-identical to the capture. No secrets, credentials, tokens or unrelated project content are reproduced; the task text and the `PONG` fixture are this corpus' own.

**Why `.txt`.** The capture's files are `T.cli.log`, `C1.cli.log` and `C2.cli.log`. This repository's `.gitignore` drops `*.log`, so the copied excerpts are named `.txt` to keep the evidence tracked rather than silently untracked. The bytes are the capture's log lines, unchanged apart from the substitutions above.

## Files

| Path | Contents |
|---|---|
| `T.cli.txt` | the three relevant log lines of the T arm, whole lines: `Print mode: starting (promptLength=51, …)`, `… sending message`, `… expanded slash command "teamwork" (system)` |
| `controls.cli.txt` | the C1 and C2 control lines: each `… sending message`, C1's `slash command expansion disabled`, and each `Forwarding user message … (items=1, media=0)` |
| `T.stream.jsonl` | the T arm's two stream lines only: the `init` event (with `expanded_commands`) and the final `result` event |
| `C3.err` | the C3 arm's stderr, verbatim, 62 bytes |
| `summary.md` | the capture's own summary, whole file, with the binary path substituted. Its line "each stream result is `interrupted`" refers to the three arms that produced a stream; C3 has none (see `17` §4) |

## Deliberately absent

- the full `T.cli.txt` (18,881 B) and the full `C1`/`C2` logs (18,146 B / 18,092 B) — only the lines a claim rests on are copied, and the rest is MCP/auth churn;
- `C1.stream.jsonl` and `C2.stream.jsonl` — both are two-line files like `T.stream.jsonl`; the absence of `expanded_commands` in their `init` is stated in `17` §4 and is the whole of their evidentiary value;
- `T.err`, `C1.err`, `C2.err` — each is the identical 19-byte line `error: interrupted`;
- `C3.stream.jsonl` — **empty (0 bytes)**, because the process exits during argument parsing, before any server starts; no `C3.cli.log` was produced for the same reason;
- the account email and the keyring expiry line — identity of the machine's user, irrelevant to the claim;
- the TUI, any route, gate, agent, transcript or state tree — none exists in these arms.

Do not read the absence of a model turn as a model failure: the process was killed on purpose at a line that precedes the call.

## Integrity

`MANIFEST.sha256` lists the SHA-256 of every **evidence** file in this directory after redaction. The prose `README.md` is **excluded by rule**, not by oversight: it names the manifest and the file list, so including it makes the manifest self-referential — any edit to the README (including this note) would break its own digest and `sha256sum -c` would fail. Verify this bundle with `sha256sum -c MANIFEST.sha256`; every entry must be `OK`.

## Limits at capture time

- One binary, one account, one machine, one afternoon. Nothing here is a statement about the TUI, about 1.5.14 or 1.5.15, or about an admin-managed account.
- No disabled state was induced. `--disable-slash-commands` suppresses expansion; it is not the admin gate.
- `--settings '{"enable-teamwork-subagent":false}'` was **rejected as an unknown setting**, so the local flag was never exercised — in either direction.
