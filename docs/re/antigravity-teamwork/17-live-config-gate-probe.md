# Live Config-Gate Probe on 1.5.16 — Slash-Command Expansion Without a Model Turn

**Status: OBSERVED — four print-mode invocations on the installed 1.5.16 binary, killed before any model turn. In the baseline the `/teamwork` prompt expands to a client-side `system` command; with `--disable-slash-commands` it does not; with an unregistered `/not-a-command` it does not; and `--settings '{"enable-teamwork-subagent":false}'` is rejected at argument parsing as an unknown setting. Every arm took zero model turns and zero tokens.** Recorded on **2026-11-24** against `agy` **1.5.16**, SHA-256 `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785`, 275,067,592 bytes. This is an **expansion-step observation, not an enforcement observation**: no disabled state was produced, no admin control was applied, and no route, gate or agent ran. The redacted evidence bundle is [`live/2026-11-24-config-gate/`](live/2026-11-24-config-gate/).

The question this probe was built to answer is whether the config gate can be exercised **without spending model tokens**. It can, for the half of the gate that is client-side: the slash command is resolved by `printmode.go` before the conversation message is forwarded, so the expansion is visible in the stream's `init` event and in one log line even when the turn never starts. That makes the instrument useful. What it does **not** do is reach the admin-disabled states, which remain `UNKNOWN` (§7).

Confidence labels follow [`PROVENANCE.md`](PROVENANCE.md). One placeholder is used and is substituted throughout the bundle:

| Placeholder | Resolves to |
|---|---|
| `<binary>` | the installed CLI, `/home/john/.local/bin/agy`; not re-run or re-copied in this pass, only hashed and `stat`ed |

---

## 1. Run identity

| Field | Value | Label |
|---|---|---|
| CLI version | **1.5.16** — the run's own server log line `server.go:2782 … Language server version: 1.5.16` (`T.cli.txt`; the same line in the C1 and C2 logs) | OBSERVED — the process that wrote the log |
| Binary | `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785`, 275,067,592 bytes, mtime `2026-11-24 14:02:08 −05:00` | OBSERVED — `sha256sum`, `stat` at capture time |
| Version cross-check | `agy --version` was **not** run for this record. Identity rests on the hash plus the per-process log line, which is the rule in [`PROVENANCE.md`](PROVENANCE.md) *version identity rule* | POLICY — deliberate |
| Date and time | 2026-11-24, 14:32:33–14:33:21 local (−05:00) ≈ 19:32:33–19:33:21Z | OBSERVED — log timestamps; UTC conversion arithmetic |
| Account | `authMethod=consumer` on keyring auth; the same log line also carries an account email, withheld here | OBSERVED — `server_oauth.go:221 … applyAuthResult: authMethod=consumer` (email elided); all three authenticated arms |
| Admin-control applicability | `Failed to refresh cache in background: admin controls not applicable` (twice per authenticated arm) | OBSERVED — log text; meaning INFERRED |
| Workspace | `<workspace>`, an empty scratch directory | OBSERVED — `init.init.cwd`; `ls -la` |
| Prompt (T, C1, C3) | `/teamwork [skip-interview] Reply with exactly: PONG` | OBSERVED — `promptLength=51` in the T and C1 logs; arithmetic agrees; C3 by construction, unlogged (§4) |
| Prompt (C2) | `/not-a-command Reply with exactly: PONG` | OBSERVED — `promptLength=39` in the C2 log; arithmetic agrees |
| Terminal state (T, C1, C2) | `ERROR`, `error:"interrupted"`, `num_turns:0`, `usage` all `0` | OBSERVED — stream `result`; `T.err`/`C1.err`/`C2.err` = 19 B `error: interrupted` |
| Terminal state (C3) | exit at argument parsing; **no stream, no CLI log** | OBSERVED — 0-byte `C3.stream.jsonl`; stderr quoted in §4 |

**At the time of this probe, this was the corpus's first recorded 1.5.16 invocation (the earlier 1.5.16 log lines come from host sessions), and it did not lift the then-current "no `/teamwork` workflow run on 1.5.16" statement.** It exercises the slash-command expansion path only: no coordinator was dispatched, no model turn occurred, no state tree exists. Identity-wise it is useful — the 1.5.16 hash, size and log line are now bound to one observed process — but behaviourally it is a probe, not a run. **`18` later records the first 1.5.16 workflow run** (Document Review), so read the "no workflow run" statement as true of this probe, not of the axis; `17` itself remains expansion evidence and zero model turns. [OBSERVED — `17`; `18` §1]

---

## 2. Argv and prompt shape

The capture stores no argv array. The block below is **assembled**; each component's evidence is in the table.

```sh
# T — baseline (the instrument's positive arm)
agy -p='/teamwork [skip-interview] Reply with exactly: PONG' \
    --dangerously-skip-permissions \
    --output-format stream-json \
    > T.stream.jsonl 2> T.err

# C1 — expansion disabled (sensitivity control)
agy -p='/teamwork [skip-interview] Reply with exactly: PONG' \
    --disable-slash-commands \
    --dangerously-skip-permissions \
    --output-format stream-json \
    > C1.stream.jsonl 2> C1.err

# C2 — unregistered command (specificity control)
agy -p='/not-a-command Reply with exactly: PONG' \
    --dangerously-skip-permissions \
    --output-format stream-json \
    > C2.stream.jsonl 2> C2.err

# C3 — local settings override
agy -p='/teamwork [skip-interview] Reply with exactly: PONG' \
    --settings '{"enable-teamwork-subagent":false}' \
    --dangerously-skip-permissions \
    --output-format stream-json \
    > C3.stream.jsonl 2> C3.err
```

| Component | Evidence | Label |
|---|---|---|
| Prompt text and length 51 | `Print mode: starting (promptLength=51, model="", conversationID="")`; `"/teamwork "` (10) + `"[skip-interview] "` (17) + `"Reply with exactly: PONG"` (24) = 51 | OBSERVED — log + arithmetic |
| Prompt text and length 39 (C2) | `promptLength=39`; `"/not-a-command "` (15) + the same 24-byte tail = 39 | OBSERVED — log + arithmetic |
| `-p` / print mode | `Print mode:` log family, one JSON object per line on stdout, stderr separate; the `-p=<text>` spelling is the form `07` §2 observed | OBSERVED (print mode and lengths); spelling INFERRED |
| `--dangerously-skip-permissions` | `Print mode: --dangerously-skip-permissions set, auto-approving all tool permissions`; `init.permission_mode = "always-proceed"` | OBSERVED |
| `--output-format stream-json` | two-line JSONL stream with `event:"init"` and `event:"result"`; redirects separate stdout/stderr | OBSERVED (shape); flag spelling INFERRED |
| `--disable-slash-commands` | the literal exists in the 1.5.16 binary at 107,188,882, 108,585,052 and 117,418,993 (`grep -aob`); C1 logs `printmode.go:939 … slash command expansion disabled` and its stream has no `expanded_commands` | OBSERVED (literal and effect); that the flag caused it INFERRED (one arm, no repeat) |
| `--settings '{"enable-teamwork-subagent":false}'` | C3 stderr, verbatim: `Error: --settings: unknown setting "enable-teamwork-subagent"` | OBSERVED — the flag spelling **and** the key are in the error text |

Nothing else was passed. In particular there was no `--conversation`, no `--model`, and no `[skip-interview]`-less variant; the bracket is present in T/C1/C3 only to keep the request text identical to the earlier gate runs, and no coordinator was ever reached to read it.

---

## 3. Method, and why it is quota-independent

Each arm was a separate process. The driver script is **not preserved** in the capture, so the method below is as it was run; the log and stream files are what can be re-read, and they are consistent with it. The driver polled the CLI log for the line

```text
Print mode: expanded slash command
```

and, when it did not appear, waited **3 s after** `Print mode: conversation=…, sending message` and then sent `SIGTERM`. [INFERRED — method as reported by the operator; the fallback's rationale is that C1 and C2 have no expansion line to poll for, and that a probe waiting for the prompt to be answered would spend the tokens it is trying to avoid]

The prompt is a `PONG` fixture: had a turn run to completion, the stream `response` would read `PONG`. No arm's `response` is non-empty, and every `result` is `interrupted` with `num_turns:0` and all five usage counters `0`.

**Why this is independent of quota.** The claim under test is about a step that happens *before* the model call, and the log ordering proves the step's position:

| Time (T) | Line | Position |
|---|---|---|
| 14:32:44.646487 | `session.go:201 Print mode: conversation=…, sending message` | the turn is being assembled |
| 14:32:44.654409 | `printmode.go:962 Print mode: expanded slash command "teamwork" (system)` | **the step under test** |
| 14:32:44.654845 | `conversation_manager.go:1080 Forwarding user message to conversation … (items=2, media=0)` | the message is handed to the conversation |

The stream's `init` event carries the same fact (`expanded_commands`), and the `init` is emitted before any turn. Since the process is killed on the expansion line, no model request is issued for the observation, so a 429 or a quota refusal cannot mask a positive result — and did not: the account authenticated successfully in every arm (`Print mode: silent auth succeeded`) and the result envelope reports zero usage rather than an error from the provider.

The kill also means the probe cannot speak to what the model would have done with the expanded command. That is the deliberate trade: all of the evidence, none of the tokens.

---

## 4. Results

| Arm | Difference from T | Expansion log line | `init.expanded_commands` | Model turns | Tokens | Terminal state |
|---|---|---|---|---|---|---|
| **T** | none | `Print mode: expanded slash command "teamwork" (system)` | `[{"name":"teamwork","type":"system"}]` | 0 | 0 | `ERROR`, `interrupted` |
| **C1** | `--disable-slash-commands` | `Print mode: slash command expansion disabled` | **absent** (key not present in `init`) | 0 | 0 | `ERROR`, `interrupted` |
| **C2** | `/not-a-command …` prompt | **no expansion line at all** | **absent** | 0 | 0 | `ERROR`, `interrupted` |
| **C3** | `--settings '{"enable-teamwork-subagent":false}'` | n/a — no server started | n/a — 0-byte stream | 0 | 0 | argument-parsing failure, exit before turn |

C3's stderr, verbatim (62 bytes, whole file):

```text
Error: --settings: unknown setting "enable-teamwork-subagent"
```

Three details deserve to be stated rather than inferred from the table:

- **C1's `init` does not contain the key at all.** The difference is not an empty list; `expanded_commands` is missing, exactly as in C2. So the two controls reach the same `init` shape by different mechanisms, which is what makes them independent checks.
- **C2 produced no expansion line, but also no "disabled" line.** The `printmode.go:939` message is specific to the flag; an unregistered command simply falls through, which is the client behaving as a parser rather than as a gate.
- **C3 has no stream because it never got that far.** `C3.stream.jsonl` is 0 bytes and no CLI log exists; the rejection happens while flags are parsed. Its `promptLength` is therefore not recorded, only implied by the identical prompt.

The stream `result` for T, C1 and C2 is the same shape, quoted here from T:

```json
{"event":"result","result":{"conversation_id":"<conversation-T>","status":"ERROR","response":"","error":"interrupted","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"interrupted"}}
```

[OBSERVED — `T.stream.jsonl` line 2; the bundle's copy is redacted and re-serialised without whitespace, the capture's is 1,676 B for two lines]

The capture's own `summary.md` says "each stream result is `interrupted`, `num_turns:0`, all usage 0". That holds for **T, C1 and C2**; C3 produced no stream, so it is not an exception to the zero-token claim but a different failure point. The bundle keeps the summary whole and notes the scope here rather than editing the capture.

---

## 5. Timing

All times local (−05:00), from `T.cli.txt`. `t = 0` is the `Print mode: starting` line; the language server itself started 58 ms earlier (`server.go:2723` at 14:32:32.945246, with `Language server version: 1.5.16` at 14:32:32.946169).

| Offset from start | Event | Evidence |
|---:|---|---|
| 0.000 s | `Print mode: starting (promptLength=51, …)` | `printmode.go:209` |
| +10.012 s | `Print mode: not authenticated, trying silent auth` | `printmode.go:410` |
| +10.070 s | `applyAuthResult: authMethod=consumer`; keyring token loaded | `server_oauth.go:221`; `keyring.go:64` |
| +10.822 s | `Print mode: silent auth succeeded` | `printmode.go:412` |
| **+11.644 s** | **`sending message`** | `session.go:201` |
| **+11.652 s** | **`expanded slash command "teamwork" (system)`** — **8 ms later** | `printmode.go:962` |
| +11.652 s | `Forwarding user message … (items=2, media=0)` | `conversation_manager.go:1080` |
| +11.692 s | `Got signal terminated, shutting down` | `server.go:4557` |
| +11.706 s | `Stream goroutine exited … sending completion signal` | `server.go:1351` |

The 8 ms figure is the difference between the two log timestamps (44.654409 − 44.646487 = 7.922 ms), rounded in the prose. The same ordering holds in C1 and C2: their `sending message` lines are followed immediately by either the `expansion disabled` line (C1) or the forwarding line (C2), with no expansion in between.

**Relation to the earlier "60–170 s before the first model call" statement.** That figure is a working-note estimate of the distance from process start to a model request; it is not recorded anywhere in this corpus, and `07` §3 O3 instead measures the turn being sent at about **+11 s** for its 1.5.14 process. The two are not in conflict — the earlier figure describes a real run's first model call, this probe measures the step that precedes one. The new observation is tighter in the only direction it can be: expansion is **8 ms after the turn is sent**, and the turn is sent ~11.6 s after process start, so expansion necessarily precedes the first model call by at least the time the model request would have taken. Nothing here shortens the earlier figure for a real run; it fixes the ordering at the front of it.

One caveat on the 8 ms: it is a single observation of a code path that does no I/O beyond a `Slash commands unchanged, skipping update` check. Whether the gap is stable across machines and cold caches is `UNKNOWN`.

---

## 6. What this settles

| Claim | Evidence | Label |
|---|---|---|
| Slash-command expansion is **client-side** and observable **without a model turn** | the expansion line precedes `Forwarding user message`, the `init` event carries `expanded_commands`, the `result` reports `num_turns:0` and zero usage | OBSERVED |
| The instrument is **sensitive**: suppressing expansion removes the signal | C1 `--disable-slash-commands` → `printmode.go:939 … expansion disabled` and no `expanded_commands` key | OBSERVED (effect); flag→effect causality INFERRED |
| The instrument is **specific**: an unregistered command does not expand | C2 `/not-a-command` → no expansion line, no `expanded_commands` key | OBSERVED |
| The **local settings key** `enable-teamwork-subagent` is **not accepted by `--settings`** on 1.5.16 | C3 stderr `unknown setting "enable-teamwork-subagent"`, exit before a server starts | OBSERVED |
| Therefore **S2/S3 cannot be exercised through `--settings`** | S2 is "local experiment flag off", S3 "subagent mode off" (`06` §4); the only local surface tested rejects the key before any gate is read | INFERRED from the observed rejection |
| The probe **does not** demonstrate enforcement | nothing was disabled; T's expansion is the *enabled* path, and C3 never reached a gate | OBSERVED (absence) |
| 1.5.16's expansion path still knows `teamwork` | `expanded_commands: [{"name":"teamwork","type":"system"}]` | OBSERVED |

### 6.1 The key is rejected as a *setting*, not absent from the binary

The rejection must not be over-read. `enable-teamwork-subagent` is **still a string in the 1.5.16 binary**: `grep -aob` finds it at 107,357,003 and again four times inside the embedded preset blob (224,846,062 / 224,846,450 / 224,846,840 / 224,847,677). On the 1.5.14 static axis the same flag sat at 106,772,317 with its preset copies around 223,052,805 (`06` §1), so it moved with the build and survived the 1.5.15 and 1.5.16 upgrades.

What the probe refutes is narrower and more useful: **that key is not part of the `--settings` override schema in 1.5.16.** The CLI knows the flag internally — it appears in the enterprise preset, which `06` already records as per-surface flag objects — but the command-line settings surface refuses it as an unknown key. So the flag may still exist as a server- or experiment-controlled setting while being unreachable from the local flag the way `--settings '{"model":"…"}'` is reachable (`16` §2 records that form being accepted).

That distinction matters for S2 and S3:

- **S2** needs the flag off. The probe shows one local surface cannot turn it off; it does **not** show the flag has no effect.
- **S3** needs the subagent mode off, via `TeamworkSubagentEnabled` or the per-customization `enable_teamwork_subagent` bool. Neither is a `--settings` key in this build either, so nothing about S3 was exercised.
- **A different key syntax may exist.** Whether `--settings` is a closed schema, and which keys it accepts, is `UNKNOWN`; only this one key is refuted.

---

## 7. What remains UNKNOWN

| Open question | Why this capture cannot answer it |
|---|---|
| **S1** — behaviour when `teamwork_preview_command_disabled = true` from either admin family | no admin control was delivered; the client logged `admin controls not applicable` for this account |
| **S6** — admin-disabled ∧ local-enabled precedence | same reason: one side of the conjunction could not be produced |
| Whether admin-vs-local precedence is "admin wins" | `06` §4 marks it `UNKNOWN` and this probe does not move it |
| Whether the key exists **server-side** and can be set by an experiment or enterprise preset | the string survives in the preset blob, but the preset is not shown to be loaded for this `consumer` account (`06` §1 *Embedded preset evidence*) |
| Whether an admin-managed account shows a different `init` (e.g. the command absent from the palette) | a consumer account cannot produce the state; needs an org with the flag |
| Which keys `--settings` accepts, and whether it is a closed schema | only one key was tested, and only for rejection |
| Whether expansion is stable at 8 ms | one arm, one machine, warm keyring |
| Whether the TUI expands the same way | no TUI run |
| What a completed turn would have done with the expanded command | deliberately killed before the call |
| Whether `[skip-interview]` was parsed at all before expansion | no coordinator was reached; the bracket is in the request text only |

The probe's boundary is the same one `06` §4 draws: **a client-side expansion is not a gate.** It shows that the front of the pipeline is observable cheaply and that one local override route is closed on this build. It does not show any disabled state, any precedence rule, or any server-side control.

---

## 8. Verification

Every quoted artifact is reproduced, redacted, in [`live/2026-11-24-config-gate/`](live/2026-11-24-config-gate/), with a `MANIFEST.sha256` covering the five evidence files (the prose README is excluded by rule — see that bundle's *Integrity*). Re-check from the repository root:

```sh
bundle=docs/re/antigravity-teamwork/live/2026-11-24-config-gate
binary=/home/john/.local/bin/agy

# bundle integrity (five evidence files; README excluded by rule)
(cd "$bundle" && sha256sum -c MANIFEST.sha256)                 # all OK

# identity of the installed binary and the run's own version line
sha256sum "$binary"                                            # 05245f43…430934e785
stat -c '%s %y' "$binary"                                      # 275067592, mtime 2026-11-24 14:02:08
grep -n 'Language server version' "$bundle/T.cli.txt"          # 1.5.16 (first line of the excerpt)

# the three-line log excerpt and the two-line stream
wc -l "$bundle/T.cli.txt" "$bundle/T.stream.jsonl"             # 3 and 2
grep -c 'expanded slash command "teamwork" (system)' "$bundle/T.cli.txt"   # 1
grep -c '"expanded_commands"' "$bundle/T.stream.jsonl"         # 1 (init only)
grep -c '"num_turns":0' "$bundle/T.stream.jsonl"               # 1

# the controls
grep -n 'expansion disabled' "$bundle/controls.cli.txt"        # C1 line
grep -c 'expanded slash command' "$bundle/controls.cli.txt"    # 0 (C2 has none)

# the rejected key, verbatim and whole
wc -c "$bundle/C3.err"                                         # 62
cat "$bundle/C3.err"                                           # Error: --settings: unknown setting "enable-teamwork-subagent"

# the key is present in the binary even though --settings rejects it
grep -aob 'enable-teamwork-subagent' "$binary" | head         # 107357003, then the preset copies
grep -aob 'disable-slash-commands' "$binary" | head           # 107188882, 108585052, 117418993
```

Expected: five `OK`; the hash and size above; three log lines and two stream lines; one `expanded_commands` occurrence and one `num_turns:0`; one `expansion disabled` line and no expansion line in `controls.cli.txt`; 62 bytes of C3 stderr; and the key present in the binary at 107,357,003 despite being rejected by `--settings`.

---

## 9. Cross-references

- Gates, states S1–S7 and the settlement table: [`06-config-gates-and-model-tiers.md`](06-config-gates-and-model-tiers.md) §1, §4, §5.
- Expansion as seen in a real run's `init`: [`16-live-interview-gate-print-mode.md`](16-live-interview-gate-print-mode.md) §2 (`expanded_commands` = `teamwork`, `type: system`); [`15-live-lemma-gate-observed.md`](15-live-lemma-gate-observed.md) §1.
- Print-mode timing and the model-override surface: [`07-runtime-observed.md`](07-runtime-observed.md) §3 O3, §3.5.
- Version axes and the identity rule: [`PROVENANCE.md`](PROVENANCE.md) *version axes*, *version identity rule*; [`live/VERSION-FORK.md`](live/VERSION-FORK.md).
- Gap-analysis row on gating: [`08-gap-analysis-opencode-teamwork-v2.md`](08-gap-analysis-opencode-teamwork-v2.md) A18.
