# Prerequisites — Formal Math / Lean 4 (LEMMA)

**Verdict:** `MISSING`  
**Install mode:** Not active (nothing was installed during this audit).

## 1. Missing Request Inputs (User Action Required)

The LEMMA execution path requires explicit inputs in the request. None were provided, and the active workspace `<workspace>` is empty:

- **`folder`** (`missing: folder: no text in its file`): A dedicated run folder (new, empty, or holding an earlier compatible LEMMA run).
- **`problem`** (`missing: problem: no text in its file`): Path to a readable Lean 4 `.lean` problem file (must not be the run folder's own `problem.lean` or `problem.orig.lean`).
- **`root`** (`missing: root: the theorem needs a plain name ([A-Za-z_][A-Za-z0-9_]*); ask the user to rename it`): The plain identifier of the theorem to prove as declared in the problem file.

## 2. Missing CLI Tools (`leap-tools`)

The following required commands were not found on `PATH`:

- `leap`
- `state_manager_bin`
- `lean_verifier_tool_bin`
- `lean_search_tool_bin`

(GNU `timeout`, `git`, `uv`, `pipx`, `python3` >= 3.10, and `pip` are all available on this machine.)

### Install Command

If an older `leap-cli` package is installed, uninstall it first (it provides the same `leap` package and commands), then install the pinned `leap-tools` build with `uv`:

```bash
uv tool uninstall leap-cli 2>/dev/null || true
uv tool install "git+https://github.com/billkunghappy/LEAP-CLI@f81ebec994884aba7dd78f903e403e3716b3787c#subdirectory=packaging/leap-tools"
```

### Troubleshooting if Installation Fails

Usual causes if the install command fails:
- GitHub or the pinned commit (`f81ebec994884aba7dd78f903e403e3716b3787c`) is unreachable.
- `git` is missing or not on `PATH`.
- `python3` is older than 3.10 (when using `pipx`/`pip`; `uv` brings its own).
- `pip` refuses an `externally-managed-environment` (use `uv` instead).
- The installer's bin directory (`uv tool dir --bin`, `pipx environment --value PIPX_BIN_DIR`, or `bin` under `python3 -m site --user-base`) is not on `PATH` (run `uv tool update-shell` or `pipx ensurepath`, then open a new shell).

## 3. Lean Backend Setup (Required After Installing `leap-tools`)

Because `leap` is not yet installed, no Lean backend is usable yet. After installing `leap-tools`, configure a Lean backend using one of the following options:

- **Default local Lean + Mathlib (~11 GB, 10–20 minutes):**
  ```bash
  leap lean --yes --no-global
  ```
  (Installs Lean v4.34.0 and a matching Mathlib under `~/.leap/leap_lean`; `--no-global` leaves the default Lean toolchain alone.)
- **Existing Lake project on Mathlib v4.34.0 (whose default targets build):**
  ```bash
  leap lean --project DIR
  ```
- **Remote/local `kimina-lean-server`:**
  ```bash
  leap lean --kimina URL
  ```
  (Uses a running `kimina-lean-server` while it answers, local Lean otherwise.)
