# Version Axes — 1.5.16 (live) vs 1.5.15 and 1.5.14 (historical)

A note for readers who move between the static documents and the live runs. It records **which binary produced which evidence**, **what each upgrade does and does not change**, and **how a run's version is established**. It is a scoping note, not a re-extraction of the corpus.

There are **three axes**, and they are never pooled:

| Axis | Version | Path / status | Bytes | SHA-256 | Sentinel slice start (1-based) | `### Route Summary` (0-based) | Used by |
|---|---|---|---:|---|---|---:|---|
| Static (historical) | 1.5.14 | archived tarball, re-extracted for this pass | 273,240,776 | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` | 113,241,709 | 113,265,667 | `00`–`06`, `09`, `prompts/`; runtime `07` (2026-11-21), `12`/`13` (2026-11-22) |
| Previous live (historical) | 1.5.15 | not on disk in this pass; recorded from the 2026-11-23 runs | 273,879,752 | `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` | 113,300,479 | 113,324,437 | runtime `15` (LEMMA gate), `16` (interview gate), 2026-11-23 |
| Live | 1.5.16 | `/home/john/.local/bin/agy`, mtime 2026-11-24 14:02:08 −05:00 | 275,067,592 | `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` | 113,868,721 | 113,892,679 | `17` — zero-turn config-gate probe; `19` — Large Team route selection (stopped before fan-out); `20` — command repeats (2026-11-24); **no completed workflow run** |

[OBSERVED — `sha256sum`, `stat`, byte-slice hashing. The 1.5.14 archive is `/home/john/Downloads/cli_linux_x64.tar.gz`, SHA-256 `d5838632…c7b5`, 101,195,950 bytes, re-extracted and hashed in this pass. The 1.5.15 row is reproduced from the 2026-11-23 records: that binary is no longer on disk, and the `.old` copy named in the run notes (`/home/john/.local/bin/agy.1795546924480305380.old`) is absent on 2026-11-24, so its size and hash cannot be re-measured here.]

The slice start is 1-based (the convention of `prompts/sentinel-routing.md`); the `### Route Summary` offset is 0-based (the convention of `grep -aob`). Within the slice the heading sits at 0-based 23,959 on all three axes — the prompt is the same bytes, only its file position moved. [OBSERVED]

## How each run's version was established

The version is taken from the CLI's own server log, **not** from `probe.meta`, which is a separate control:

- 1.5.15 LEMMA run: `~/.gemini/antigravity-cli/log/cli-20261123_073544.log:3` → `Language server version: 1.5.15` (07:35:44 EST).
- 1.5.15 interview runs: `cli-20261123_104212.log:3`, `_105147.log:3`, `_105431.log:3`, `_110054.log:3` → all `Language server version: 1.5.15`.
- 1.5.14 control probe: `~/.gemini/antigravity-cli/log/cli-20261123_073238.log:3` → `Language server version: 1.5.14`; `probe.meta` (12:32:36Z) records `1.5.14`.
- 1.5.16 host processes: `cli-20261124_142128.log:3` and `cli-20261124_142542.log:3` → `Language server version: 1.5.16`. These are host sessions, **not** a `/teamwork` run.
- 1.5.16 probe: the four arms of `17` each wrote `server.go:2782 … Language server version: 1.5.16` into the capture's own CLI logs (`T.cli.txt` line 1, and the C1/C2 logs). No model turn was taken, so this binds the version to a process without producing run behaviour.
- 1.5.16 route selection and repeats: `cli-20261124_163105.log:3` (`19`), `_163652.log:3` (run C) and `_163759.log:3` (run D) each report `1.5.16`; the bundle's `run.cli.txt` / `c-run.cli.txt` / `d-run.cli.txt` are two-line excerpts. The two expansion arms each report `1.5.16` in `probe-*.cli.txt:3`. [OBSERVED]
- `14`'s 2026-11-15/16 prior run: `UNKNOWN` — it predates the earliest surviving server log (`cli-20261117_180830.log`, which reports 1.5.9), so no server-log line survives for it.

[OBSERVED] An earlier draft of `15`/`16` cited `probe.meta` for the run identity; that conflated a 1.5.14 control probe three minutes earlier with the 1.5.15 run. Corrected in both documents.

## Version identity rule

Identity needs three readings, and they answer different questions:

1. `agy --version` — what the **installed file** reports when asked now.
2. SHA-256 of the binary — **which bytes were on disk**.
3. The server-log line `Language server version: <v>` — what the **process that wrote the log loaded** at start.

When they disagree, the **hash is authoritative for what executed**. A server-log line belongs only to the process that wrote it; it does not describe a sibling process, a later process, or the current install, and a `--version` reading taken after a run must never be transferred back onto it. [POLICY — method rule]

**An auto-update can land mid-process.** On 2026-11-24 a language-server process started at `14:02:04` local (−05:00) and logged `Language server version: 1.5.15` (`cli-20261124_140204.log:3`), while the binary's mtime is `14:02:08` local and its hash is the 1.5.16 value: the process that started four seconds earlier was executing the replaced 1.5.15 bytes. Every run record must therefore bind its log line to the hash of the binary that process launched, not to whatever is installed at reading time. [OBSERVED — log line, mtime, `sha256sum`]

## What does NOT change

- **The sentinel prompt text is byte-identical across all three axes.** 36,482 bytes, SHA-256 `3e8c347eb2db6059ef9f010873062c41bc7d95fd640746674b4caddd0fabf4c1`, at 1-based 113,241,709 (1.5.14), 113,300,479 (1.5.15) and 113,868,721 (1.5.16). The routing table, interview gate, pre-flight audit contract and completion rules are the same bytes. [OBSERVED — sliced 1.5.14 and 1.5.16 in this pass; the 1.5.15 slice was compared in the earlier pass and matches]
- **Behavioural evidence is therefore comparable.** A gate observed on 1.5.15 exercised the same prompt as the 1.5.14 static reading and the 1.5.16 install. This is what licenses citing `15`/`16` against the static contract in `01`/`04`. [INFERRED from byte identity]

## What DOES change

- **Static offsets shift.** Against 1.5.14 the slice start moves +58,770 on 1.5.15 and +627,012 on 1.5.16; `### Route Summary` moves by the same amounts (113,265,667 → 113,324,437 → 113,892,679). Every decimal offset in `00`–`06`, `09` and `prompts/sentinel-routing.md` is a 1.5.14 offset and does **not** resolve on either later build. Only the sentinel slice position was re-anchored on 1.5.16; whether every other literal moved by the same delta is `UNKNOWN`, so do not apply the shift to a static offset without re-measuring it. [OBSERVED — `grep -aob`; uniform-shift assumption INFERRED away]
- **The builtin tree differs.** `.checksum`: `builtin:f46b8917…` (1.5.14) → `builtin:930df4a7…` (1.5.15) → `builtin:3499ad60…` (1.5.16). The 1.5.14→1.5.15 delta is recorded in detail: five `plugins/swarm/sidecars/swarm_board/` files differ (`app.js`, `board_cache.mjs`, `hive.js`, `main.mjs`, `README.md`) and eleven skills were added (`agy-customizations`, `antigravity_guide`, `automation`, `conversations`, `generative_ui`, `mcp-app-development`, `migrate-agent-settings`, `migrate-workflows`, `permissioned-github`, `plugin`, `ui-plugin-navigation`). The 1.5.16 tree was not diffed against 1.5.15 because that tree no longer exists; only its `.checksum` and its 46-file / 13-file `swarm_board` counts were read. [OBSERVED — `diff -rq` for 1.5.14→1.5.15; `.checksum` and `find` for 1.5.16]
- **`09`'s `file:line` citations are 1.5.14 line numbers.** The swarm sidecar changed, so a line cited from the capture may point at different text in either later tree. Read the capture (`assets/builtin/`), which is preserved byte-for-byte. [INFERRED from the diff]
- **The slash-command identifier narrowed by 1.5.16.** On 1.5.14 both `/teamwork` (`12`, `13`) and `/teamwork-preview` (`07`, `11`) reached the subsystem. On 1.5.16, a zero-token probe shows `/teamwork` expanding to a client-side `system` command and `/teamwork-preview` producing no expansion line and no `expanded_commands`, with one forwarded item instead of two; both arms took zero model turns (`20` §2, §5). The exact build where the old form stopped expanding is `UNKNOWN` (1.5.15 was not probed). [OBSERVED — probe logs/streams]

## What is UNKNOWN

- Whether the changed swarm sidecar behaviour is substantive or cosmetic: the five 1.5.14→1.5.15 files differ, but this pass did not diff their content line by line; the 1.5.16 tree was not compared at all. [UNKNOWN]
- The 1.5.15 and 1.5.16 build IDs and Go toolchain strings (only the 1.5.14 values were measured). [UNKNOWN]
- Whether any prompt literal elsewhere (outside the byte-identical 36,482-byte slice) changed wording between versions. The slice was compared; the rest of each binary was not. [UNKNOWN]
- Anything about `/teamwork` workflow behaviour on 1.5.16: that axis has **no completed workflow run** in this corpus. Its execution evidence is `17`'s zero-turn probe (client-side slash-command expansion and one `--settings` rejection), `19`'s route selection (a `teamwork_proof` briefing and an empty route folder, stopped before fan-out) and `20`'s repeats (two inline runs under the obsolete command, two `teamwork_swe` selections at `Phase: in progress`). None of them is a route, gate, dispatch or verdict. [UNKNOWN]
