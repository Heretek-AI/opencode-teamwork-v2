# Artifact Identity — Antigravity Linux CLI (`/teamwork` investigation)

This document set records the identity, provenance, and static-analysis findings for the Google Antigravity Linux CLI binary under investigation, focused on the `/teamwork` command. [OBSERVED] All facts were measured by static inspection of the archive and extracted binary. No execution of the target binary was performed for this document. [OBSERVED]

## Chain of Custody [OBSERVED]

| Stage | Path | Size (bytes) | SHA-256 |
|---|---|---:|---|
| Source archive [OBSERVED] | `/home/john/Downloads/cli_linux_x64.tar.gz` | 101,195,950 | `d58386322d2073e96b33f7cc32b4e9ae2db6228f58440369725967b2de48c7b5` |
| Archive member [OBSERVED] | `antigravity` (ELF, mode 0755, uid/gid root:root, mtime 2026-11-21 01:24) — exactly one member | unknown (member size not separately measured; archive contains exactly one member) [UNKNOWN] | unknown (member hash not separately computed) [UNKNOWN] |
| Extracted binary, read-only working copy [OBSERVED] | `/tmp/opencode/antigravity-re/antigravity` — the 1.5.14 static binary. The path no longer exists on the host; re-extract from `~/Downloads/cli_linux_x64.tar.gz` (see `PROVENANCE.md`) | 273,240,776 | `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94` |
| String dump (generated) [OBSERVED] | `/tmp/opencode/antigravity-re/` (`strings -a -n 5` dump) | 45,893,848 | unknown (generated artifact; hash not recorded) [UNKNOWN] |

## Build Identity [OBSERVED]

- Go build info (`.go.buildinfo`, file offset `0xd30d120`, magic `\xff Go buildinf:` then ptrSize=8, flags=2) [OBSERVED]:
  `go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringscrypto,nogolistexportnewformat`
- This is an internal Google release-candidate Go 1.28 build, not a public release. [INFERRED — version string format plus internal `cl/` changelist marker indicate an internal RC toolchain, not a public `goX.Y.Z` release]
- Public Go tooling rejects this file: local `go version -m` (go1.27.4) reports "not a Go executable" for it. [OBSERVED]
- `go tool nm` and `go tool objdump` both fail with "no symbol section". [OBSERVED]
- `.comment` section, verbatim [OBSERVED]:
  - `Linker: LLD google3-trunk`
  - `Ubuntu clang version 14.0.6`
  - `google3 clang version 9999.0.0 (80d7de963aa627fedec45b1cf7d7e483ba850fe6)`
  - `google3 clang version 9999.0.0 (b4b8d4e5d062438289c60a832ec783d34cc31fa4)`
  - `rustc version 1.102.0-nightly (d3622156f 2026-11-13)`
- Build ID (`.note.gnu.build-id`, NT_GNU_BUILD_ID, 16-byte) [OBSERVED]: `e91180c5c4c28f0207cfcfbbe3a26508`
- `.note.ABI-tag` [OBSERVED]: GNU, OS Linux, ABI 3.2.0
- Explicit note: because this binary was produced with an internal Google RC toolchain, public Go tooling (`go version -m`, `go tool nm`) rejects the file. [OBSERVED — the rejection was directly measured; the causal link to the internal toolchain is INFERRED]
- ELF header [OBSERVED]: ELF64, little-endian, version 1, System V, type DYN (Position-Independent Executable), machine AMD x86-64.
- Entry point [OBSERVED]: `0x72a5000`.
- Program headers [OBSERVED]: 17 at file offset 64; section headers: 55 at file offset 273,212,224; section-header string table index 50.
- Stripped [OBSERVED]: no `.symtab`, no `.symtab`-derived symbols, no DWARF.
- Go module namespace embedded in symbol paths [OBSERVED]: `google3/third_party/jetski/...` (the Antigravity / "jetski" CLI + language server).

## Section Map [OBSERVED]

Section numbers, names, addresses, offsets, and sizes are verbatim from `readelf -SW`. The "why it matters" column is analysis. [OBSERVED for the table data; INFERRED for the analysis column]

| # | Name | Address | File offset | Size | Why it matters [INFERRED] |
|---:|---|---|---|---|---|
| 4 | `.dynstr` | `0x6e4c` | `0x6e4c` | `0x3331` | Dynamic symbol string table; needed to resolve the DT_NEEDED imports below. |
| 5 | `.rela.dyn` | `0xa180` | `0xa180` | `0x1809558` | 1,050,072 RELA entries (RELACOUNT); unusually large — see anomalies. |
| 6 | `.rela.plt` | `0x18136d8` | `0x18136d8` | `0x1830` | PLT relocations; JMPREL `0x18136d8`, PLTRELSZ 6,192. |
| 7 | `.lrodata` | `0x1814f10` | `0x1814f10` | `0x4c0e900` | Large read-only data; hosts the embedded Go pclntab (`runtime.main` string at file offset 25,297,870 lies in this range). |
| 8 | `flags_help_cold` | `0x6423810` | `0x6423810` | `0x5b50` | Google-specific cold flag-help section. |
| 9 | `.rodata` | `0x6429380` | `0x6429380` | `0xe75c60` | Constant data, including embedded command/description strings. |
| 10 | `.text.hot` | `0x729efe0` | `0x729efe0` | `0` | Empty hot-text placeholder. |
| 11 | `google_malloc` | `0x729efe0` | `0x729efe0` | `0x5f63` | Google-specific allocator code. |
| 12 | `.text` | `0x72a5000` | `0x72a5000` | `0x43f5830` | Main executable code; entry point `0x72a5000` lies here. |
| 13 | `.text.split` | `0xb69a830` | `0xb69a830` | `0` | Empty split-text placeholder. |
| 14 | `.text.unlikely` | `0xb69a830` | `0xb69a830` | `0x4f19` | Cold/unlikely code. |
| 17 | `.text.startup` | `0xb69f770` | `0xb69f770` | `0x42ae` | Startup code. |
| 18 | `google_init_cold` | `0xb6a3a20` | `0xb6a3a20` | `0x781` | Google-specific cold init code. |
| 19 | `malloc_hook` | `0xb6a41b0` | `0xb6a41b0` | `0x7fa` | Allocator hook code. |
| 23 | `.init_array` | `0xb8a5a90` | `0xb6a5a90` | `0x3e8` | Static initializers. |
| 29 | `.data.rel.ro` | `0xb8a71c0` | `0xb6a71c0` | `0x1a2b540` | Relocated read-only data. |
| 31 | `.eh_frame` | `0xd4d2700` | `0xd0d2700` | `0x96074` | Exception unwinding frames. |
| 34 | `.data` | `0xd78d140` | `0xd18d140` | `0x114fc0` | Writable data. |
| 35 | `google_malloc_data` | `0xd8a2100` | `0xd2a2100` | `0x48` | Google allocator data. |
| 38 | `.go.buildinfo` | `0xdb0d120` | `0xd30d120` | `0x90` | Go build-info blob quoted above. |
| 39 | `.go.module` | `0xdb0d1c0` | `0xd30d1c0` | `0x238` | Go module metadata. |
| 40 | `.noptrdata` | `0xdb0d400` | `0xd30d400` | `0x30dcc41` | Go no-pointer data. |
| 43 | `pb_defaults` | `0x10bea100` | `0x103ea100` | `0x8` | Google protobuf-defaults section. |
| 44 | `filewrapper_toc` | `0x10bea108` | `0x103ea108` | `0x8` | Google filewrapper table of contents. |
| 45 | `.noptrbss` | `0x10bea120` | `0x103ea110` | `0x22496b0` (NOBITS) | Go no-pointer BSS. |
| 46 | `.ldata` | `0x13033800` | `0x10433800` | `0x4680` | Local data. |
| 48 | `protodesc_cold` | `0x1327a5e0` | `0x1047a5e0` | `0x139f8` | Cold protobuf descriptors. |
| 49 | `.comment` | `0x0` | `0x1048dfd8` | `0xff` | Toolchain version strings quoted above. |
| 51 | `.dynsym` | `0x1328e000` | `0x10490000` | `0x5268` | Dynamic symbol table. |

Total section count [OBSERVED]: 55 sections.

Three anomalies [OBSERVED facts; interpretation INFERRED]:

- No `.gopclntab` section exists, yet Go runtime metadata is present — the pclntab is embedded inside `.lrodata` (the string `runtime.main` occurs at file offset 25,297,870, which lies in `.lrodata`'s range). [OBSERVED] This is atypical for standard Go toolchain output and is consistent with a custom internal link layout. [INFERRED]
- Google-specific sections are present (`google_malloc`, `google_init_cold`, `malloc_hook`, `google_malloc_data`, `pb_defaults`, `filewrapper_toc`), plus a Rust nightly toolchain string in `.comment` — both atypical for a plain Go binary. [OBSERVED] They indicate a google3-internal build mixing runtimes/allocators. [INFERRED]
- The relocation table is unusually large: 1,050,072 RELA entries (RELASZ 25,204,056 at 0xa180). [OBSERVED] This increases load-time relocation work relative to a typical PIE Go binary. [INFERRED]

## Linking and Hardening [OBSERVED facts; hardening conclusions as labeled]

- Dynamic section [OBSERVED]: BIND_NOW; FLAGS_1 = NOW + PIE; RELA at `0xa180` with RELASZ 25,204,056 and RELACOUNT 1,050,072; JMPREL `0x18136d8`, PLTRELSZ 6,192.
- DT_NEEDED, complete and in order [OBSERVED]: `libresolv.so.2`, `libpthread.so.0`, `libm.so.6`, `libdl.so.2`, `librt.so.1`, `libc.so.6`, `ld-linux-x86-64.so.2`.
- PIE [OBSERVED]: ELF type DYN with FLAGS_1 PIE — position-independent executable.
- BIND_NOW is set [OBSERVED]; full RELRO is implied but was not directly verified — treat as INFERRED. [INFERRED]
- NX/stack-canary status [UNKNOWN]: not measured; unknown. [UNKNOWN]

## Where `/teamwork` Lives [OBSERVED]

- Implementation package [OBSERVED]: `third_party/jetski/cortex/customizations/builtin/teamwork`, with sub-packages `swe_light/`, `document_review/`, `colosseum/`, `external/`.
- The slash-command description string, embedded verbatim [OBSERVED]: "Preview the multi-agent teamwork workflow."

## Investigation Environment [OBSERVED]

- Working copy [OBSERVED]: `/tmp/opencode/antigravity-re/` (binary + `strings -a -n 5` dump, 45,893,848 bytes).
- Tools available and used [OBSERVED]: `readelf`, `strings`, `grep -aob`, `xxd`, `go1.27.4-X:nodwarf5`, `objdump`, `radare2`, Ghidra at `~/.local/bin/ghidra`.
- Not available [OBSERVED]: no `rea` CLI/MCP; no network/auth used at any point.
- What was NOT done [OBSERVED]: no execution of the target binary was performed for this document; no network access and no authentication were used at any point.
