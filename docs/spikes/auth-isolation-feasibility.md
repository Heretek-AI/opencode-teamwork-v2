# Spike: Artifact-Trust Isolation Feasibility

- **Date:** 2026-11-22
- **Host:** Fedora Linux 46 (prerelease), kernel `7.4.0-0.rc3...fc46.x86_64`
- **OpenCode:** v2.3.2
- **Node (bundled with OpenCode):** v26.13.1
- **User:** `john`, UID/GID 1000
- **Purpose:** collect read-only evidence for
  `docs/adr/0006-artifact-trust-isolation.md`. No runtime code was changed and
  no system configuration was modified.

Labels: **OBSERVED** = directly probed; **INFERRED** = reasoned from the probe;
**UNKNOWN** = not verified.

## 1. OpenCode data and plugin storage

Commands:

```sh
opencode --version
opencode debug paths
stat -c '%A %U:%G %s %n' ~/.local/share/opencode/opencode.db
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" ".tables"
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
  "SELECT count(*) FROM kv;"
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
  "SELECT key, length(value) FROM kv;"
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
  "SELECT typeof(value), length(value) FROM kv WHERE key LIKE 'plugin:%' LIMIT 3;"
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
  "SELECT count(*) FROM kv WHERE key LIKE '%auth/key/ring%';"
```

Results:

- `opencode v2.3.2`; data dir `/home/john/.local/share/opencode`; DB
  `/home/john/.local/share/opencode/opencode.db`. **OBSERVED**
- DB mode `-rw------- john:john`, 13,349,199,872 bytes; `-wal` and `-shm` are
  also `john:john`. **OBSERVED**
- Tables include `kv`, `permission`, `session`, `message`, `part`, `blob`,
  `worktree`. **OBSERVED**
- `kv` has 8 rows. Plugin-scoped keys use the form
  `plugin:<UTF-16LE hex plugin id>:<storage key>`; three rows for one plugin's
  session state are present. Values are `text` (522/552/906 bytes in the
  sampled rows). **OBSERVED**
- `auth/key/ring` is absent: 0 matching rows. No Teamwork signed run has been
  created on this host, so the ring has not been lazily created. **OBSERVED**
- **INFERRED:** when a signed run is created, `auth/key/ring` will be stored as
  a plaintext `text` value in `kv` under the Teamwork plugin namespace, which is
  readable by the same UID that runs the agents. The code path is
  `createAuthContext(ctx.storage)` → `storage.set("auth/key/ring", ring)`.

No key value was read or printed.

## 2. Same-UID process access

Commands:

```sh
cat /proc/sys/kernel/yama/ptrace_scope
mount | grep ' /proc '
tr '\0' '\n' </proc/$$/environ | grep -E '^(HOME|USER|PATH)='
```

Results:

- `ptrace_scope` is `0` (classic ptrace). **OBSERVED**
- `/proc` is mounted `rw,nosuid,nodev,noexec,relatime` with no `hidepid`.
  **OBSERVED**
- A same-UID shell can read its own `/proc/<pid>/environ`; with
  `ptrace_scope=0` it can ptrace other same-UID processes. **OBSERVED /
  INFERRED**
- Consequence: a passphrase or in-memory key held by the OpenCode process is
  not a same-UID secret on this host. **INFERRED**

## 3. Permission API (`ctx.permission.assert`)

Probe: inspected the OpenCode v2.3.2 binary for the plugin context and the
permission service (no plugin was loaded, to avoid creating sessions).

Observed strings (paraphrased from the bundled JS):

```js
permission: {
  hook: (event, fn) => ...,
  list: ..., get: ..., reply: ...,
  assert: (input) => validate(Vce, input).pipe(e.permission.assert)
}
```

- The plugin context exposes `permission.assert` in v2.3.2. **OBSERVED**
- The accepted input shape is
  `{sessionID, agent, action, resources, save, metadata, source}`.
  **OBSERVED**
- Core `Permission.assert` semantics: deny → `Permission.BlockedError`;
  allow → returns; otherwise creates a permission request and blocks until a
  reply; decline → `Permission.DeclinedError`; a correction path exists.
  **OBSERVED** (binary).
- `opencode run --help` lists `--auto` with the text "Auto-approve permissions
  that are not explicitly denied". The binary's auto-reply path uses
  `decision: "once"` when the auto flag is set; the UI also exposes
  `session.permissions` values `prompt` and `autoaccept`. **OBSERVED**
- **INFERRED:** a permission gate built only on `ctx.permission.assert` is
  auto-approvable by `opencode run --auto` unless the action is explicitly
  denied, and the user config that holds the deny rule is same-UID writable.
  It is an advisory prompt, not a secret or a separate privilege domain.

## 4. Session API and the descendant check

Probe: inspected the API schema in the v2.3.2 binary. No session was created.

Observed:

- `POST /api/session` payload includes `id`, `parentID`, `agent`, and location
  fields. The schema text says: "Set parentID to create a subagent session at
  the parent's location; set agent to choose its agent ... start it with
  session.prompt." **OBSERVED**
- The Teamwork run manifest records `rootSessionId`; the artifact is readable
  by the same UID. **OBSERVED** (ADR 0005 design and run dir permissions).
- **INFERRED:** a same-UID shell can read `rootSessionId` and create a child
  session with `parentID=<root>` and `agent=team/verifier`, satisfying the
  `requireDescendantSession` check. The check blocks a top-level
  `opencode run --agent` invocation; it is not a same-UID boundary.

## 5. systemd and separate-UID feasibility

Commands:

```sh
systemctl --user --version
systemctl --user is-system-running
loginctl show-user john -p Linger
ls -ld ~/.config/systemd/user /etc/systemd/user
systemd-analyze --user verify /tmp/opencode/isolation-probe/teamwork-signer-probe.service
sudo -n -l
command -v useradd; ls -l "$(command -v useradd)"
```

Results:

- systemd 262; user manager is reachable, state `degraded`; `Linger=yes` for
  `john`. **OBSERVED**
- `~/.config/systemd/user` exists and is user-owned; a sample signer unit
  (`Type=simple`, `NoNewPrivileges=yes`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `PrivateTmp=yes`, `ReadWritePaths=...`) passes
  `systemd-analyze --user verify` (exit 0). **OBSERVED**
- `sudo -n -l` fails with "a password is required" (exit 1). **OBSERVED**
- `/usr/bin/useradd` is root-owned and mode `0755`; the current user has no
  effective `CAP_SETUID`/`CAP_SETGID` (only `cap_wake_alarm` in the current
  capability set). **OBSERVED**
- **INFERRED:** a separate-UID signer is feasible only with a one-time
  administrator action (create the user, install a system unit or a signer-user
  unit, create/label the key directory and socket). A `systemd --user` unit
  owned by `john` is not a security boundary: John's shell can control it.
- SELinux is `Enforcing`; cross-UID socket/key paths need labels.
  **OBSERVED / INFERRED.**

## 6. Unix socket feasibility

Probe: a small Node script created a Unix socket under `/tmp/opencode`,
listened, connected, and inspected the accepted socket.

Results:

```json
{"listening":true,"mode":"755","uid":1000,"gid":1000}
{"accepted":true,"peerCredMethods":["_getpeername"],"hasGetPeerCredentials":false}
```

- Node can create and connect a Unix socket with no dependency. **OBSERVED**
- The default socket mode was `0755` (umask-dependent), so a signer must set
  `chmod 0660` or tighter explicitly. **OBSERVED**
- `net.Socket` exposes `_getpeername` but not `getPeerCredentials`; pure Node
  has no `SO_PEERCRED`. **OBSERVED**
- Even with `SO_PEERCRED`, the agent and the shell are both UID 1000, so peer
  credentials cannot distinguish them. **INFERRED**
- Consequence: a socket signer that accepts the agent's UID is a signing
  oracle for the shell. It needs a policy gate (human approval or independent
  verification), not just a different key holder. **INFERRED**

## 7. OS isolation primitives

Commands:

```sh
for c in bwrap unshare nsenter podman docker setpriv runuser; do command -v "$c"; done
unshare --user --map-root-user --net true
bwrap --ro-bind / / --dev /dev --unshare-net true
grep -E '^john:' /etc/subuid /etc/subgid
getenforce
```

Results:

- `bwrap`, `unshare`, `nsenter`, `podman`, `docker`, `setpriv`, `runuser` are
  installed. **OBSERVED**
- `unshare --user --map-root-user --net true` exits 0. **OBSERVED**
- `bwrap --ro-bind / / --dev /dev --unshare-net true` exits 0. **OBSERVED**
- `/etc/subuid` and `/etc/subgid` have a 65,536-ID range for `john`.
  **OBSERVED**
- SELinux is `Enforcing`. **OBSERVED**
- The OpenCode plugin context has no process-placement/sandbox/mount API
  (observed context keys: `agent`, `command`, `event`, integration, MCP,
  permission, plugin, reference, rpc, skill, storage, tool, and
  `experimental.terminal`). **OBSERVED**
- **INFERRED:** isolation is a launcher/deployment change (run the whole
  OpenCode process under `bwrap`/`podman` with a read-only home and no host
  DB), not something this plugin can enforce.

## 8. TPM / HSM / crypto tooling

Commands:

```sh
ls -l /dev/tpm*
id
for c in tpm2_sign pkcs11-tool openssl gpg age ssh-keygen ykman; do command -v "$c"; done
```

Results:

- `/dev/tpm0` and `/dev/tpmrm0` exist, `root:tss` mode `0660`; `john` is not in
  `tss`. **OBSERVED**
- `tpm2_sign`, `pkcs11-tool`, `openssl`, `gpg`, `age`, `ssh-keygen` are
  installed; `ykman` is missing. **OBSERVED**
- **INFERRED:** a TPM key is feasible after an administrator grants `tss`
  access and provisions a non-exportable key. Without a PIN/authorization
  policy, a same-UID shell can use the key too. A per-signing human PIN is
  Option D, not a property of the TPM alone.
- **UNKNOWN:** whether this TPM has a usable endorsement hierarchy / PCR policy
  for the intended design; no key was created.

## 9. Probes not run

These were intentionally skipped to avoid system changes, external accounts, or
side effects:

- **Actual separate-UID signer service.** Requires root to create the user,
  install a system unit, and label the key/socket (`sudo` needs a password).
- **Key extraction from `opencode.db`.** The ring is absent on this host; no
  signed run was created. Reading a real key would add no evidence beyond the
  file mode and plaintext `kv` schema.
- **Session spoof / `POST /api/session`.** Would create sessions and prompt a
  model. The schema is observed in the binary; the attack is inferred.
- **Runtime plugin call to `ctx.permission.assert`.** Would require loading a
  probe plugin and creating a session. The API is observed in the binary; the
  auto-approve behaviour is observed from the flag/schema.
- **Remote KMS/HSM.** No endpoint or credentials; would require an external
  account and network trust decision.
- **macOS / Windows.** No such host available; all claims there are INFERRED
  from platform documentation.
- **Container isolation run.** Would change the runtime/launcher and is a
  deployment experiment, not a read-only probe.
- **SELinux policy test.** Would require writing policy/booleans; only the
  enforcing state was observed.

## 10. Bottom line

On this host, the key store, the index, the plugin, and the shell are all in the
same UID. A separate UID, a socket, a remote KMS, or a TPM only helps if the
signing decision is gated by something the shell cannot obtain (a human
presence check) or independently recomputed by a verifier the shell cannot
rewrite. None of those primitives exists in OpenCode v2.3.2 today. The honest
Sprint 2.1 outcome is to accept and document the Phase A boundary; see ADR 0006.
