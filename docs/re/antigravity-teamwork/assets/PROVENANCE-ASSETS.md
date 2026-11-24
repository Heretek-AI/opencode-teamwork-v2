# Provenance — Materialised Antigravity `builtin` Assets

## What This Directory Is [OBSERVED]

- `assets/builtin/` holds verbatim copies of the files the Google Antigravity Linux CLI materialises from its embedded "builtin" fixtures into its app-data directory. [OBSERVED]
- The copy was made for interoperability analysis of the Antigravity teamwork/swarm surface, alongside the notes in `docs/re/antigravity-teamwork/`. [POLICY — project purpose statement]
- Files are byte-identical to the installed originals **at capture time (1.5.14)**: copied with `cp -a`, with no reformatting, normalisation, or edits. [OBSERVED — verified with `diff -r`, below] The current install is **1.5.15** and its tree differs; see *Version fork* below.
- Captured payload: 24 files, 612 KB (`du -sh`), covering:
  - `plugins/swarm/` — the whole plugin subtree (16 files), including `sidecars/swarm_board/`.
  - `skills/native_swarm/` (2 files), `skills/swarm_pane/`, `skills/swarm_monitor/`, `skills/swarm_narrator/`, `skills/run-workflow/` (1 file each).
  - `.manifest` and `.checksum` — the materialiser's own bookkeeping files.
- Deliberately **not** copied (out of scope for the teamwork question): the unrelated builtin skills `agy-customizations`, `antigravity_guide`, `automation`, `conversations`, `generative_ui`, `mcp-app-development`, `migrate-agent-settings`, `migrate-workflows`, `permissioned-github`, `plugin`, `ui-plugin-navigation`, and the zero-byte `keep.txt` sentinel. [OBSERVED — they exist in the source tree but are absent here]

## Source and Capture [OBSERVED]

- Absolute source path: `/home/john/.gemini/antigravity-cli/builtin` (the CLI's app-data directory is `~/.gemini/antigravity-cli`).
- Capture date: 2026-11-21 (UTC), from the local installation on this machine.
- CLI version at capture time: `1.5.14` (`agy --version`).

## Same Binary as the Analysed Artifact [OBSERVED — at capture time, 1.5.14]

The fixture tree was produced by the exact binary analysed in `00-artifact-identity.md`, not by a different build:

- Installed binary `/home/john/.local/bin/agy` **on 2026-11-21**: 273,240,776 bytes; SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`.
- Analysed artifact, re-extracted from the archived tarball to `/tmp/opencode/ver-fix-1.5.14/antigravity`: 273,240,776 bytes; same SHA-256.
- `cmp` against that 1.5.14 copy exits 0. (The old working path `/tmp/opencode/antigravity-re/antigravity` no longer exists; the archive `~/Downloads/cli_linux_x64.tar.gz` is the durable copy.)

### Version fork (2026-11-23, extended 2026-11-24) [OBSERVED]

The installed CLI was **1.5.15** on 2026-11-23 — `/home/john/.local/bin/agy`, 273,879,752 bytes, SHA-256 `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d`, since replaced. Its materialised builtin tree differed from this capture:

- `.checksum` was `builtin:930df4a72b3ebb9547221dbd601535185717e8e73bac68ca96713e69832d3aaa` (vs this capture's `builtin:f46b8917…`).
- Five `plugins/swarm/sidecars/swarm_board/` files differed: `app.js`, `board_cache.mjs`, `hive.js`, `main.mjs`, `README.md`.
- That tree had 46 files (vs 24 here) because it includes `keep.txt` and the eleven unrelated skills listed above.

On 2026-11-24 the install auto-updated to **1.5.16** (275,067,592 bytes, SHA-256 `05245f43…430934e785`). Its tree's `.checksum` is `builtin:3499ad6076a126f6e771af72116f855fe25dd61709f7fc2565ac0aba63701e4446`, and it has 46 files, 13 of them under `plugins/swarm/sidecars/swarm_board/`. The 1.5.16 tree was **not** diffed against 1.5.15 — that tree is gone — so the changed-file set for the second step is `UNKNOWN`. [OBSERVED — `.checksum`, `find`; diff UNKNOWN]

This directory remains the **1.5.14** capture and is intentionally not re-captured; `09` cites it by `file:line` and those are 1.5.14 line numbers. See [`../live/VERSION-FORK.md`](../live/VERSION-FORK.md).

## How Materialisation Is Triggered [OBSERVED / INFERRED]

- The binary contains the Go symbols `builtin.PopulateBuiltins`, `builtin.collectEmbeddedAssets`, and `builtin.syncEmbeddedAsset` (verbatim string matches: `google3/third_party/jetski/cortex/customizations/builtin/builtin.PopulateBuiltins`, `.../builtin.collectEmbeddedAssets`, `.../builtin.syncEmbeddedAsset`). [OBSERVED]
- Following that path, the CLI writes the embedded fixture bytes under its app-data directory (`~/.gemini/antigravity-cli/builtin/`). [OBSERVED — the resulting tree exists there; the exact write ordering is INFERRED from the symbol names]
- `.manifest` is the materialiser's list of managed files. Observed: 44 newline-terminated entries, 1,657 bytes, SHA-256 `a7afed630119dafad6f35c11ee0621b0411a54523b149bacdfddc1d75d8fd225`. It enumerates every builtin fixture, including the unrelated skills that this corpus does not copy. [OBSERVED]
- `.checksum` covers the managed set. Full contents (single line, no trailing newline beyond the file's one line): [OBSERVED]

```text
builtin:f46b8917adf35c9c4c091259cf2bb7ca77245389ad3255b371389cf5c7a75a7c
```

- `.checksum` file SHA-256: `216b878287dff1bca474b6d1e4edbe368a6463633fdf0de8406ba3693e060b67`. [OBSERVED]
- The source tree also contains `keep.txt` (0 bytes), which is manifest-listed but not part of this scope. [OBSERVED]

## Licensing and Redistribution Notice

The same boundary applies as in `docs/re/antigravity-teamwork/PROVENANCE.md`:

- The materialised files are Google proprietary software, recovered from the Antigravity CLI. [OBSERVED — artifact attribution]
- These verbatim copies are reproduced solely for interoperability analysis and are **NOT** covered by this repository's MIT licence. [POLICY — project policy statement, not a legal opinion]
- `docs/re/` is excluded from the published npm package via the `!docs/re/**` entry in `package.json`. [OBSERVED for the pattern; POLICY for the intent]
- Do not redistribute this material commercially without independent legal review. [POLICY — project policy statement, not a legal opinion]

## Verify / Re-derive the Copy [OBSERVED]

Commands run from the repository root; pasted output is from the finalised directory (it includes this provenance file, hence the file count is 25 rather than 24).

```console
$ find docs/re/antigravity-teamwork/assets -type f | wc -l
25
$ du -sh docs/re/antigravity-teamwork/assets
624K
# Against the 1.5.14 install (2026-11-21), the swarm subtree was identical:
$ diff -r ~/.gemini/antigravity-cli/builtin/plugins/swarm docs/re/antigravity-teamwork/assets/builtin/plugins/swarm && echo "swarm subtree identical"
swarm subtree identical
$ cat ~/.gemini/antigravity-cli/builtin/.checksum
builtin:f46b8917adf35c9c4c091259cf2bb7ca77245389ad3255b371389cf5c7a75a7c
```

> **2026-11-23:** re-running the same `diff` against the now-installed 1.5.15 tree reports five differing `swarm_board` files and additional skills, and `.checksum` reads `builtin:930df4a7…`. This block documents the 1.5.14 capture, not the current install. [OBSERVED — `diff -rq`]

Skill subtrees are checked the same way:

```sh
for s in native_swarm swarm_pane swarm_monitor swarm_narrator run-workflow; do
  diff -r ~/.gemini/antigravity-cli/builtin/skills/"$s" \
          docs/re/antigravity-teamwork/assets/builtin/skills/"$s"
done
diff ~/.gemini/antigravity-cli/builtin/.manifest docs/re/antigravity-teamwork/assets/builtin/.manifest
diff ~/.gemini/antigravity-cli/builtin/.checksum docs/re/antigravity-teamwork/assets/builtin/.checksum
```

All commands above exit 0 with no output (no differences).

Per-file integrity check — compare the corpus's own hashes against the source:

```sh
cd docs/re/antigravity-teamwork/assets/builtin
find . -type f | sort | xargs sha256sum
```

Expected hashes for the copied payload:

| File | SHA-256 |
| --- | --- |
| `.checksum` | `216b878287dff1bca474b6d1e4edbe368a6463633fdf0de8406ba3693e060b67` |
| `.manifest` | `a7afed630119dafad6f35c11ee0621b0411a54523b149bacdfddc1d75d8fd225` |
| `plugins/swarm/assets/logo.svg` | `424d3cd0c6765a1d4cf2a7ebcd62bceb7e9ca1cbfa8429696618e708f73cf11a` |
| `plugins/swarm/plugin.json` | `376e9002b623b8040310496fd65942a256ffdfd41dbac902146d7485c21510d7` |
| `plugins/swarm/README.md` | `c68343f0d00d128571ef601acd6e9b0704847e10fb5962512868874c5eddcb7d` |
| `plugins/swarm/sidecars/swarm_board/app.js` | `a6673359dad4f8c2fecb31221797ea66b5bf3fe9a9910418a208ab711ce4f8ed` |
| `plugins/swarm/sidecars/swarm_board/board_cache.mjs` | `a196d485a2b9398d4df2f9ac9dadb478026c461533a5d4d852d1696a279bf535` |
| `plugins/swarm/sidecars/swarm_board/channels.mjs` | `30d0a8f646ef69fa3e07a16197e95dae9f90bd4002fc2be09ef3f78ab16bfc02` |
| `plugins/swarm/sidecars/swarm_board/gif.js` | `ee8000859d39fffd31d97a2b34c309855140b3358cf0860fcee1f9a2f722e26f` |
| `plugins/swarm/sidecars/swarm_board/hive.css` | `9c02e9d3e09a55ff26e964abd95a0307012b8c1f44b4e636a8437c5a238fb7ad` |
| `plugins/swarm/sidecars/swarm_board/hive.js` | `3f2704cd36252675bf4746091385ac3b7b74f72364724ca6284b76adc380f13d` |
| `plugins/swarm/sidecars/swarm_board/index.html` | `1b91d4a62ce50203c4a2199fbf4c1dfe131e663cc69a9d8b2f81bdf2d5a9399e` |
| `plugins/swarm/sidecars/swarm_board/main.mjs` | `3e93eac982328b30197a7a665e30e70dab2be1dcbdcce695a215fc6e18816197` |
| `plugins/swarm/sidecars/swarm_board/narrator_bootstrap.js` | `1a31f8c2f623a0f05eccccc588d9fabb0a6bc088ca77caf3806ce1854c41c4a7` |
| `plugins/swarm/sidecars/swarm_board/package.json` | `3fd619df42459ea6537017d4d0a67a8d1e5ebc889c2bcc82fd151dc893559d34` |
| `plugins/swarm/sidecars/swarm_board/README.md` | `e73767190a721bb1303da39a081fd88b28c1e49f8e79f4fda1c2217bef5e52d2` |
| `plugins/swarm/sidecars/swarm_board/sidecar.json` | `025741e4fcff65af30ef0be5fd823a77387d636827e9582e7ff715242a8c2ca4` |
| `plugins/swarm/sidecars/swarm_board/styles.css` | `d9c85ed05b1237409618c540ea5c6b3f1ebceb654b121a572acc73c5d7c82637` |
| `skills/native_swarm/logo.svg` | `424d3cd0c6765a1d4cf2a7ebcd62bceb7e9ca1cbfa8429696618e708f73cf11a` |
| `skills/native_swarm/SKILL.md` | `9193e18e748c351bfee97cabe95bd563f08dcde802670e37eb0b29c73d980032` |
| `skills/run-workflow/SKILL.md` | `4a524107cb6173d75a54c2a7de3addeb413d7bdb868c8279682ded74672beb1e` |
| `skills/swarm_monitor/SKILL.md` | `eec457f3f332db4b7d472a29dc61a8140304a9058aabcceb624e3e8b12b2894f` |
| `skills/swarm_narrator/SKILL.md` | `99b3200be99796e6377d3d8f32a283439f2d42afd3f1a418f49d1222bf5b289f` |
| `skills/swarm_pane/SKILL.md` | `64d9281a62c2568a54dffb5b446a93e580250611faeeb8fb0482f461e504e361` |

To re-materialise from the installed CLI instead of copying, run the CLI once so `builtin.PopulateBuiltins` repopulates `~/.gemini/antigravity-cli/builtin/`, then re-run the `diff -r` checks above.
