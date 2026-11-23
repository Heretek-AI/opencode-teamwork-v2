# Version Fork — 1.5.14 (static axis) vs 1.5.15 (live axis)

A note for readers who move between the static documents and the 2026-11-23 live runs. It records **which binary produced which evidence** and **what the upgrade does and does not change**. It is a scoping note, not a re-extraction of the corpus.

## The two binaries

| Axis | Version | Path | Bytes | SHA-256 | Used by |
|---|---|---|---|---|---|
| Static | 1.5.14 | archived tarball, re-extracted to `/tmp/opencode/ver-fix-1.5.14/antigravity` | 273,240,776 | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` | `00`–`06`, `09`, `prompts/`; runtime `07` (2026-11-21), `12`/`13` (2026-11-22) |
| Live | 1.5.15 | `/home/john/.local/bin/agy` | 273,879,752 | `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` | runtime `15` (LEMMA gate), `16` (interview gate), 2026-11-23 |

[OBSERVED — `sha256sum`, `stat`, `agy --version`; the 1.5.14 archive is `/home/john/Downloads/cli_linux_x64.tar.gz`, SHA-256 `d5838632…c7b5`, 101,195,950 bytes, extracted to the 1.5.14 binary above.]

## How each run's version was established

The version is taken from the CLI's own server log, **not** from `probe.meta`, which is a separate control:

- 1.5.15 LEMMA run: `~/.gemini/antigravity-cli/log/cli-20261123_073544.log:3` → `Language server version: 1.5.15` (07:35:44 EST).
- 1.5.15 interview runs: `cli-20261123_104212.log:3`, `_105147.log:3`, `_105431.log:3`, `_110054.log:3` → all `Language server version: 1.5.15`.
- 1.5.14 control probe: `~/.gemini/antigravity-cli/log/cli-20261123_073238.log:3` → `Language server version: 1.5.14`; `probe.meta` (12:32:36Z) records `1.5.14`.

[OBSERVED] An earlier draft of `15`/`16` cited `probe.meta` for the run identity; that conflated a 1.5.14 control probe three minutes earlier with the 1.5.15 run. Corrected in both documents.

## What does NOT change

- **The sentinel prompt text is byte-identical.** 36,482 bytes, SHA-256 `3e8c347eb2db6059ef9f010873062c41bc7d95fd640746674b4caddd0fabf4c1`, at 1-based offset 113,241,709 (1.5.14) and 113,300,479 (1.5.15). The routing table, interview gate, pre-flight audit contract and completion rules are the same bytes. [OBSERVED — sliced both binaries and compared]
- **Behavioural evidence is therefore comparable.** A gate observed on 1.5.15 exercised the same prompt as the 1.5.14 static reading. This is what licenses citing `15`/`16` against the static contract in `01`/`04`. [INFERRED from byte identity]

## What DOES change

- **Static offsets shift.** The whole prompt moved by **+58,770** bytes: slice start 113,241,709 → 113,300,479; `### Route Summary` 113,265,667 → 113,324,437. Every decimal offset in `00`–`06`, `09` and `prompts/sentinel-routing.md` is a 1.5.14 offset and does **not** resolve in 1.5.15 without adding the shift or re-anchoring. [OBSERVED — `grep -aob` in both binaries]
- **The builtin tree differs.** `.checksum` `builtin:f46b8917…` (1.5.14) vs `builtin:930df4a7…` (1.5.15); five `plugins/swarm/sidecars/swarm_board/` files differ (`app.js`, `board_cache.mjs`, `hive.js`, `main.mjs`, `README.md`); eleven skills were added (`agy-customizations`, `antigravity_guide`, `automation`, `conversations`, `generative_ui`, `mcp-app-development`, `migrate-agent-settings`, `migrate-workflows`, `permissioned-github`, `plugin`, `ui-plugin-navigation`); the live tree also carries `keep.txt` and 46 files against the capture's 24. [OBSERVED — `diff -rq`]
- **`09`'s `file:line` citations are 1.5.14 line numbers.** The swarm sidecar changed, so a line cited from the capture may point at different text in the live 1.5.15 tree. Read the capture (`assets/builtin/`), which is preserved byte-for-byte. [INFERRED from the diff]

## What is UNKNOWN

- Whether the changed swarm sidecar behaviour is substantive or cosmetic: the five files differ, but this pass did not diff their content line by line. [UNKNOWN]
- The 1.5.15 build ID and Go toolchain string (only the 1.5.14 values were measured). [UNKNOWN]
- Whether any prompt literal elsewhere (outside the byte-identical 36,482-byte slice) changed wording between versions. The slice was compared; the rest of the binary was not. [UNKNOWN]
