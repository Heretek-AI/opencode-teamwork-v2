# Provenance — Antigravity `/teamwork` Reverse-Engineering Corpus

## What This Corpus Is [OBSERVED]

- This corpus is reverse-engineering notes plus recovered material about a third-party proprietary product (the Google Antigravity Linux CLI, focused on the `/teamwork` command). [OBSERVED]
- The core is static analysis of the archive and extracted binary. Two later evidence classes are labelled separately: shipped builtin source read directly (`09`) and runtime observation of the installed CLI (`07`, `11`, `12`, `13`, `14`, `15`, `16`, `17`, `18`, `19`, `20`). The runtime runs are **not** all on one binary: `07`/`12`/`13` ran 1.5.14; `15`/`16` ran 1.5.15; `17` is a **zero-turn probe on 1.5.16** (slash-command expansion only, no model call); `18` is a **completed Document Review workflow run on 1.5.16** (a `.tex` critique with a `VICTORY CONFIRMED` audit); `19` is a 1.5.16 **route selection** that stopped before fan-out; `20` is a 1.5.16 **command/repeat experiment** (two inline runs under the obsolete command, one expansion probe, two teamwork runs); `14` ran a version that is `UNKNOWN` because it predates the earliest surviving server log. See *version axes* below. [OBSERVED]

## Source Identity [OBSERVED]

Three binaries are in play, and this corpus keeps all three apart. They form **three axes**, not two: **1.5.16** is the current live axis (installed on 2026-11-24); **1.5.15** is the historical live axis that produced the 2026-11-23 gate runs; **1.5.14** is the static axis, the build the extracted archive and every offset in `00`–`06`, `09` and `prompts/` refer to. No run is pooled across axes.

| Axis | Version | Path / status | Bytes | SHA-256 | Sentinel slice start (1-based) | `### Route Summary` (0-based) |
|---|---|---|---:|---|---|---:|
| Live | 1.5.16 | installed CLI, `/home/john/.local/bin/agy` | 275,067,592 | `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` | 113,868,721 | 113,892,679 |
| Historical (previous live) | 1.5.15 | no longer on disk in this pass; recorded from the 2026-11-23 runs | 273,879,752 | `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` | 113,300,479 | 113,324,437 |
| Historical (static) | 1.5.14 | re-extracted from the archived tarball, `~/Downloads/cli_linux_x64.tar.gz` | 273,240,776 | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` | 113,241,709 | 113,265,667 |

- Source archive SHA-256 [OBSERVED]: `d58386322d2073e96b33f7cc32b4e9ae2db6228f58440369725967b2de48c7b5` (`/home/john/Downloads/cli_linux_x64.tar.gz`, 101,195,950 bytes) — this archive is the **1.5.14** build. [OBSERVED — `sha256sum`; extracting it reproduces the 1.5.14 binary hash below, and the 1.5.14 version was recorded from `agy --version` before the upgrade]
- Static binary SHA-256 [OBSERVED]: `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` (273,240,776 bytes), re-extracted on 2026-11-24 from the archived tarball. The older working paths `/tmp/opencode/antigravity-re/antigravity` and `/tmp/opencode/ver-fix-1.5.14/` no longer exist on the host; the archive is the durable copy. [OBSERVED — re-extracted and re-hashed in this pass]
- Live binary SHA-256 [OBSERVED]: `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` (275,067,592 bytes), `/home/john/.local/bin/agy`; the file mtime is `2026-11-24 14:02:08 -05:00`, the instant the auto-update replaced the 1.5.15 build. The version string `1.5.16` is read from the host server logs `cli-20261124_142128.log:3` and `cli-20261124_142542.log:3` (`Language server version: 1.5.16`); `agy --version` was **not** re-run in this corrections pass, so the hash and the log line are the earners here. [OBSERVED — `sha256sum`, `stat`, log line 3]
- Previous live binary [OBSERVED at run time; not re-verifiable now]: `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` (273,879,752 bytes), `agy --version` = `1.5.15`; corroborated by the run server logs `cli-20261123_073544.log:3`, `_104212.log:3`, `_105147.log:3`, `_105431.log:3`, `_110054.log:3` (`Language server version: 1.5.15`). The preserved copy the run notes named, `/home/john/.local/bin/agy.1795546924480305380.old`, is **not present** on 2026-11-24; the 1.5.15 hash and size therefore rest on the earlier measurement and the run logs, not on a file that can be re-hashed in this pass. [OBSERVED then; absence OBSERVED now]
- Build ID [OBSERVED]: `e91180c5c4c28f0207cfcfbbe3a26508` (`.note.gnu.build-id`, NT_GNU_BUILD_ID, 16-byte) — measured on the **1.5.14** static binary; the 1.5.15 and 1.5.16 build IDs are `UNKNOWN` (not measured).
- Go toolchain string [OBSERVED]: `go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringscrypto,nogolistexportnewformat` (an internal Google release-candidate Go 1.28 build, not a public release) — measured on the **1.5.14** static binary; the 1.5.15/1.5.16 strings are `UNKNOWN`.

### Version axes [OBSERVED / INFERRED]

- **1.5.16 is the live axis.** It is the installed binary from 2026-11-24 14:02:08 −05:00 onward and is the only build a new live capture can run. `17` records a **zero-turn config-gate probe** that binds the hash, size and version line to one observed process and observes the slash-command expansion, but takes no model turn, starts no route and writes no state tree. `18` records the first **workflow** run on this axis: a completed Document Review critique of a `.tex` paper, with a `READY` pre-flight, three `[4,2,1]` segment trees, a `[4,1]` synthesis, no gate table and a `VICTORY CONFIRMED` audit. `19` records a **route selection** that reached `teamwork_proof` and stopped before any route agent, layer, gate or proof. `20` records two inline runs under `/teamwork-preview` (which does not expand on this build), the zero-token expansion probe, and two `/teamwork` runs that took `teamwork_swe` and stopped at `Phase: in progress`. The axis therefore has one probe, one completed workflow run and two selection-level experiments; the run is one route on one input, not a general behaviour sample. [OBSERVED — `sha256sum`, `stat`, run log line; `18` §1–§11]
- **The command identifier narrowed by 1.5.16.** On **1.5.14** both `/teamwork` (`12`, `13`) and `/teamwork-preview` (`07`, `11`) reached the subsystem, and the stored identifier literal is `teamwork-preview`. On **1.5.16** a zero-token probe shows `/teamwork` expanding to a client-side `system` command and `/teamwork-preview` not expanding at all (no line, no `expanded_commands`, one forwarded item). Both arms took zero model turns. The exact build where the alias stopped expanding is `UNKNOWN`, because 1.5.15 was not probed; the finding is scoped to 1.5.16. [OBSERVED — `20` §2, §5]
- **1.5.15 is a historical axis.** The 2026-11-23 runs `15` (LEMMA gate) and `16` (interview gate) executed 1.5.15. [OBSERVED — server log line 3 of each run's log, plus the `agy --version` recorded then]
- **1.5.14 is the static axis.** Every decimal file offset in `00`–`06`, `09` and `prompts/sentinel-routing.md` is a 1.5.14 offset. On 1.5.15 the sentinel prompt started at 113,300,479 (+58,770); on 1.5.16 it starts at 113,868,721 (+627,012 against 1.5.14, +568,242 against 1.5.15). The builtin tree `.checksum` changed at each step. [OBSERVED — byte comparison; `diff -rq` for the builtin tree where both trees were present]
- **What does not change.** The sentinel prompt slice is **byte-identical** across all three binaries — 36,482 bytes, SHA-256 `3e8c347eb2db6059ef9f010873062c41bc7d95fd640746674b4caddd0fabf4c1` — so prompt-level behaviour observed on any of the three versions is comparable. [OBSERVED — sliced 1.5.14 and 1.5.16 in this pass; the 1.5.15 slice was compared in the earlier pass and the digest matches the recorded one]
- **What does change.** The installed builtin tree differs at each version: 1.5.14 `.checksum` `builtin:f46b8917…`; 1.5.15 `builtin:930df4a7…` (five changed `swarm_board` sidecars, eleven added skills); 1.5.16 `builtin:3499ad60…` (recorded, contents not diffed against 1.5.15 because that tree is gone). Static offsets therefore do **not** carry across versions. [OBSERVED — `.checksum` reads; see `live/VERSION-FORK.md`]
- **Runs are never pooled across versions.** `07` (2026-11-21) and `12`/`13` (2026-11-22) were recorded on 1.5.14; `15`/`16` (2026-11-23) on 1.5.15; `18` (2026-11-24) on 1.5.16, the same axis as the zero-turn probe `17`; `14` (a 2026-11-15/16 completed prior run) on a version that is `UNKNOWN`. Each run's identity table names its own CLI version and binary hash, or writes `UNKNOWN` and says why. [OBSERVED]
- **`14`'s version is `UNKNOWN` by construction.** The run predates the earliest surviving server log (`cli-20261117_180830.log`, 1.5.9), its transcripts carry no `Language server version:` line, and its binary is gone; no hash can be bound to it. This is why `14` is runtime evidence of the interview gate but not evidence about any particular build. [OBSERVED — absence]

### Version identity rule [POLICY]

A run's identity is established by three measurements, and they answer different questions:

1. `agy --version` — what the **installed file** reports when asked now.
2. SHA-256 of the binary — **which bytes were on disk**.
3. The server log line `Language server version: <v>` (`~/.gemini/antigravity-cli/log/cli-<stamp>.log:3` or its current line number) — what the **process that wrote that log loaded** at start.

They can disagree, and the disagreement is evidence, not noise. The **hash is authoritative for what executed**: if a stored binary and a log disagree, believe the bytes only for the run whose process wrote the log, and never transfer a `--version` reading taken later onto an earlier run. **A server-log line belongs only to the process that wrote it** — it does not describe a sibling process, a later process, or the current install. [POLICY — method rule, derived from the observations below]

**An auto-update can land mid-process.** Observed on 2026-11-24: a language-server process started at `14:02:04` local (−05:00) logged `Language server version: 1.5.15` (`cli-20261124_140204.log:3`), while `/home/john/.local/bin/agy` carries mtime `14:02:08` local and hashes to the 1.5.16 value. The process that started four seconds earlier was running the old bytes; the file on disk was replaced under it. A later `agy --version` or `sha256sum` would describe 1.5.16 and be wrong for that process. This is why the rule above puts the log and the hash on the same process, and why a capture must record the log line and the hash of the binary **that process** launched. [OBSERVED — log line 3, file mtime, `sha256sum`]

## Licensing and Redistribution Notice

Artifact facts in this section are [OBSERVED]; the licensing paragraph below is a project policy statement, not a legal opinion.

- The artifact is Google proprietary software. [OBSERVED — sourced from the google3 toolchain markers and module namespace; treated as observed artifact attribution]
- Verbatim material recovered from it (including any prompt text placed under `docs/re/antigravity-teamwork/prompts/`) is reproduced solely for interoperability analysis and is NOT covered by this repository's MIT license. [POLICY — project policy statement, not a legal opinion]
- `docs/re/` is excluded from the published npm package. [POLICY — project policy statement, not a legal opinion]
- Do not redistribute the recovered corpus commercially without independent legal review. [POLICY — project policy statement, not a legal opinion]

## Method Disclosure [OBSERVED]

- Static extraction [OBSERVED]: `readelf`, `strings`, `grep -aob`, `xxd`, `go1.27.4-X:nodwarf5`, `objdump`, `radare2`, and Ghidra were used for the artifact. Runtime evidence (`07`, `11`, `12`, `13`, `14`, `15`, `16`, `17`, `18`, `19`, `20`) was produced by executing the installed CLI (`07`–`13` in print mode; `18` and `19` in TUI sessions, `18` resumed after an interruption; `20`'s two valid runs in TUI sessions and its probe in print mode; `14` is an exception: it reads a completed prior run's state tree and transcripts, and its CLI version is `UNKNOWN`; `17` and the `20` probe are killed on the expansion line, before any model call); shipped-source evidence (`09`) was read from the materialised builtin tree (`assets/builtin/`, captured at 1.5.14). The evidence class is stated per claim. [OBSERVED]
- What `strings` can prove [OBSERVED]: it can prove that a byte sequence is present in the binary at a given file offset.
- What `strings` cannot prove [INFERRED]: merged string literals mean recovered prompt boundaries can be imprecise — adjacent literals may be concatenated or truncated, so the exact original source text cannot be reconstructed from the dump alone.
- Every recovered prompt must therefore carry a fidelity note stating how precisely its boundaries are known. [POLICY — project policy statement]

## Confidence Legend [POLICY — definitions]

- OBSERVED: directly read from the artifact (e.g. a byte string, hash, header field, or section entry seen in tool output). Earned by quoting or citing the measured value. [POLICY]
- INFERRED: derived by reasoning over observed data (e.g. toolchain attribution from version strings, layout conclusions from offsets). Earned by stating the observed premises it follows from. [POLICY]
- UNKNOWN: the fact was not measured or cannot be determined from the available data; written literally as `unknown` rather than guessed. [POLICY]

## Reproduction Steps [OBSERVED]

Exact commands to re-derive identity and the string dump. Paths refer to the investigation environment. [OBSERVED]

```sh
sha256sum /home/john/Downloads/cli_linux_x64.tar.gz        # 1.5.14 source archive
mkdir -p /tmp/opencode/axis116-1.5.14 && cd /tmp/opencode/axis116-1.5.14
tar -xzf /home/john/Downloads/cli_linux_x64.tar.gz         # -> ./antigravity (1.5.14)
sha256sum antigravity                                      # 37873b80…97d8c94
readelf -h antigravity
readelf -SW antigravity
readelf -d antigravity
readelf -n antigravity
readelf -p .comment antigravity
xxd -s 0xd30d120 -l 144 antigravity
strings -a -n 5 antigravity > strings.txt

# the 36,482-byte sentinel slice is identical on every axis
tail -c +113241709 antigravity | head -c 36482 | sha256sum   # 3e8c347e…f0fabf4c1
grep -aob '### Route Summary' antigravity                     # 113265667 (0-based)

# live axis (1.5.16, installed; one zero-turn probe in 17, one completed Document Review run in 18, one route selection in 19 and command repeats in 20)
agy --version                                              # 1.5.16 (not re-run in the corrections pass)
sha256sum /home/john/.local/bin/agy                        # 05245f43…430934e785
stat -c '%s %y' /home/john/.local/bin/agy                  # 275067592, mtime 2026-11-24 14:02:08
sed -n '3p' ~/.gemini/antigravity-cli/log/cli-20261124_142128.log   # Language server version: 1.5.16
sed -n '3p' ~/.gemini/antigravity-cli/log/cli-20261124_160951.log   # Language server version: 1.5.16 (run 18)
tail -c +113868721 /home/john/.local/bin/agy | head -c 36482 | sha256sum   # same 3e8c347e…
grep -aob '### Route Summary' /home/john/.local/bin/agy     # 113892679 (0-based)
sed -n '3p' ~/.gemini/antigravity-cli/log/cli-20261124_142128.log   # 1.5.16
```

The 1.5.15 measurements (273,879,752 B; `7b004d26…41fa2d`; slice at 113,300,479; `### Route Summary` at 113,324,437) are reproduced from the 2026-11-23 records, not re-run here: that binary is no longer on disk, and its preserved `.old` copy is absent in this pass. [OBSERVED — absence]
