# Provenance — Antigravity `/teamwork` Reverse-Engineering Corpus

## What This Corpus Is [OBSERVED]

- This corpus is reverse-engineering notes plus recovered material about a third-party proprietary product (the Google Antigravity Linux CLI, focused on the `/teamwork` command). [OBSERVED]
- The core is static analysis of the archive and extracted binary. Two later evidence classes are labelled separately: shipped builtin source read directly (`09`) and runtime observation of the installed, byte-identical CLI (`07`, `11`, `12`, `13`, `15`, `16`). [OBSERVED]

## Source Identity [OBSERVED]

- Source archive SHA-256 [OBSERVED]: `d58386322d2073e96b33f7cc32b4e9ae2db6228f58440369725967b2de48c7b5` (`/home/john/Downloads/cli_linux_x64.tar.gz`, 101,195,950 bytes).
- Extracted binary SHA-256 [OBSERVED]: `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` (`/tmp/opencode/antigravity-re/antigravity`, 273,240,776 bytes).
- Build ID [OBSERVED]: `e91180c5c4c28f0207cfcfbbe3a26508` (`.note.gnu.build-id`, NT_GNU_BUILD_ID, 16-byte).
- Go toolchain string [OBSERVED]: `go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringscrypto,nogolistexportnewformat` (an internal Google release-candidate Go 1.28 build, not a public release).

## Licensing and Redistribution Notice

Artifact facts in this section are [OBSERVED]; the licensing paragraph below is a project policy statement, not a legal opinion.

- The artifact is Google proprietary software. [OBSERVED — sourced from the google3 toolchain markers and module namespace; treated as observed artifact attribution]
- Verbatim material recovered from it (including any prompt text placed under `docs/re/antigravity-teamwork/prompts/`) is reproduced solely for interoperability analysis and is NOT covered by this repository's MIT license. [POLICY — project policy statement, not a legal opinion]
- `docs/re/` is excluded from the published npm package. [POLICY — project policy statement, not a legal opinion]
- Do not redistribute the recovered corpus commercially without independent legal review. [POLICY — project policy statement, not a legal opinion]

## Method Disclosure [OBSERVED]

- Static extraction [OBSERVED]: `readelf`, `strings`, `grep -aob`, `xxd`, `go1.27.4-X:nodwarf5`, `objdump`, `radare2`, and Ghidra were used for the artifact. Runtime evidence (`07`, `11`, `12`, `13`, `15`, `16`) was produced by executing the installed CLI in print mode; shipped-source evidence (`09`) was read from the materialised builtin tree (`assets/builtin/`). The evidence class is stated per claim. [OBSERVED]
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
sha256sum /home/john/Downloads/cli_linux_x64.tar.gz
sha256sum /tmp/opencode/antigravity-re/antigravity
readelf -h /tmp/opencode/antigravity-re/antigravity
readelf -SW /tmp/opencode/antigravity-re/antigravity
readelf -d /tmp/opencode/antigravity-re/antigravity
readelf -n /tmp/opencode/antigravity-re/antigravity
readelf -p .comment /tmp/opencode/antigravity-re/antigravity
xxd -s 0xd30d120 -l 144 /tmp/opencode/antigravity-re/antigravity
strings -a -n 5 /tmp/opencode/antigravity-re/antigravity > strings.txt
```
