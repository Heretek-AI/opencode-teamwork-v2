# Provenance — Antigravity `/teamwork` Reverse-Engineering Corpus

## What This Corpus Is [OBSERVED]

- This corpus is reverse-engineering notes plus recovered material about a third-party proprietary product (the Google Antigravity Linux CLI, focused on the `/teamwork` command). [OBSERVED]
- The core is static analysis of the archive and extracted binary. Two later evidence classes are labelled separately: shipped builtin source read directly (`09`) and runtime observation of the installed CLI (`07`, `11`, `12`, `13`, `15`, `16`). The runtime runs are **not** all on one binary: `07`/`12`/`13` ran 1.5.14; `15`/`16` ran 1.5.15. See *live axis vs static axis* below. [OBSERVED]

## Source Identity [OBSERVED]

Two binaries are in play, and this corpus now keeps them apart. The **static axis** is 1.5.14, the build the extracted archive and every offset in `00`–`06`, `09` and `prompts/` refer to. The **live axis** is 1.5.15, the binary installed for the 2026-11-23 runtime runs (`15`, `16`) and required for any new live capture.

| Axis | Version | Path | Bytes | SHA-256 |
|---|---|---|---|---|
| Static | 1.5.14 | re-extracted from the archived tarball, `/tmp/opencode/ver-fix-1.5.14/antigravity` | 273,240,776 | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` |
| Live | 1.5.15 | installed CLI, `/home/john/.local/bin/agy` | 273,879,752 | `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` |

- Source archive SHA-256 [OBSERVED]: `d58386322d2073e96b33f7cc32b4e9ae2db6228f58440369725967b2de48c7b5` (`/home/john/Downloads/cli_linux_x64.tar.gz`, 101,195,950 bytes) — this archive is the **1.5.14** build. [OBSERVED — `sha256sum`; extracting it yields the 1.5.14 binary above, `agy --version` = 1.5.14]
- Static binary SHA-256 [OBSERVED]: `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` (273,240,776 bytes), re-extracted on 2026-11-23 from the archived tarball at `/tmp/opencode/ver-fix-1.5.14/antigravity`. The older working path `/tmp/opencode/antigravity-re/antigravity` no longer exists on the host; the archive is the durable copy. [OBSERVED]
- Live binary SHA-256 [OBSERVED]: `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` (273,879,752 bytes), `/home/john/.local/bin/agy`, `agy --version` = `1.5.15`; corroborated by the run server logs `cli-20261123_073544.log:3`, `_104212.log:3`, `_105147.log:3`, `_105431.log:3`, `_110054.log:3` (`Language server version: 1.5.15`).
- Build ID [OBSERVED]: `e91180c5c4c28f0207cfcfbbe3a26508` (`.note.gnu.build-id`, NT_GNU_BUILD_ID, 16-byte) — measured on the **1.5.14** static binary; the 1.5.15 build ID is `UNKNOWN` (not measured in this pass).
- Go toolchain string [OBSERVED]: `go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringscrypto,nogolistexportnewformat` (an internal Google release-candidate Go 1.28 build, not a public release) — measured on the **1.5.14** static binary.

### Live axis vs static axis [OBSERVED / INFERRED]

- **1.5.15 is the live axis.** The 2026-11-23 runs `15` (LEMMA gate) and `16` (interview gate) executed 1.5.15. [OBSERVED — server log line 3 of each run's log, plus `agy --version`]
- **1.5.14 is the static axis.** Every decimal file offset in `00`–`06`, `09` and `prompts/sentinel-routing.md` is a 1.5.14 offset. On 1.5.15 the sentinel prompt starts at 113,300,479 instead of 113,241,709 (+58,770), and the builtin tree `.checksum` changed from `builtin:f46b8917…` to `builtin:930df4a7…`. [OBSERVED — byte comparison; `diff -rq` of the two builtin trees]
- **What does not change.** The sentinel prompt slice is **byte-identical** across the two binaries — 36,482 bytes, SHA-256 `3e8c347eb2db6059ef9f010873062c41bc7d95fd640746674b4caddd0fabf4c1` — so prompt-level behaviour observed on either version is comparable. [OBSERVED]
- **What does change.** The installed builtin tree differs: five `swarm_board` sidecar files (`app.js`, `board_cache.mjs`, `hive.js`, `main.mjs`, `README.md`) and eleven added skills; `.checksum` differs. Static offsets therefore do **not** carry across versions. [OBSERVED — `diff -rq`; see `live/VERSION-FORK.md`]
- **Runs are never pooled across versions.** `07` (2026-11-21) and `12`/`13` (2026-11-22) were recorded on 1.5.14; `15`/`16` (2026-11-23) on 1.5.15. Each run's identity table names its own CLI version and binary hash. [OBSERVED]

## Licensing and Redistribution Notice

Artifact facts in this section are [OBSERVED]; the licensing paragraph below is a project policy statement, not a legal opinion.

- The artifact is Google proprietary software. [OBSERVED — sourced from the google3 toolchain markers and module namespace; treated as observed artifact attribution]
- Verbatim material recovered from it (including any prompt text placed under `docs/re/antigravity-teamwork/prompts/`) is reproduced solely for interoperability analysis and is NOT covered by this repository's MIT license. [POLICY — project policy statement, not a legal opinion]
- `docs/re/` is excluded from the published npm package. [POLICY — project policy statement, not a legal opinion]
- Do not redistribute the recovered corpus commercially without independent legal review. [POLICY — project policy statement, not a legal opinion]

## Method Disclosure [OBSERVED]

- Static extraction [OBSERVED]: `readelf`, `strings`, `grep -aob`, `xxd`, `go1.27.4-X:nodwarf5`, `objdump`, `radare2`, and Ghidra were used for the artifact. Runtime evidence (`07`, `11`, `12`, `13`, `15`, `16`) was produced by executing the installed CLI in print mode; shipped-source evidence (`09`) was read from the materialised builtin tree (`assets/builtin/`, captured at 1.5.14). The evidence class is stated per claim. [OBSERVED]
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
mkdir -p /tmp/opencode/ver-fix-1.5.14 && cd /tmp/opencode/ver-fix-1.5.14
tar -xzf /home/john/Downloads/cli_linux_x64.tar.gz         # -> ./antigravity (1.5.14)
sha256sum antigravity                                      # 37873b80…97d8c94
readelf -h antigravity
readelf -SW antigravity
readelf -d antigravity
readelf -n antigravity
readelf -p .comment antigravity
xxd -s 0xd30d120 -l 144 antigravity
strings -a -n 5 antigravity > strings.txt

# live axis (1.5.15, installed)
agy --version                                              # 1.5.15
sha256sum /home/john/.local/bin/agy                        # 7b004d26…41fa2d
```
