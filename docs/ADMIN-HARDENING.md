# Admin hardening runbook: a policy-enforcing signer

**Status:** deployment documentation for the 0.14.0 artifact-trust boundary
(plugin side unchanged through 0.19.2). This is a runbook for an administrator.
**None of these steps was executed on the host that wrote this document.** The
commands are templates; substitute your identities and paths, review every
line, and test on a disposable host first.

**The Rust reference signer is in [`signer/`](../signer/) but is not shipped
with the npm package.** It is a non-oracle reference implementation of
[docs/SIGNER-PROTOCOL.md](SIGNER-PROTOCOL.md), not a turnkey hardened service:
review it, build it, and own its policy. The plugin can call
`OPENCODE_TEAMWORK_SIGNER=command:<path>` and, with a signer approval
directory, send a v2 request; the program at that path is yours. It must be
built and installed as root-owned code in Step 7 below. Do not describe a
deployment as hardened because the plugin is configured; the signer's policy is
the boundary.

This runbook builds the deployment that the package cannot build in-process: a
signer in a different UID, root-owned signer code, a policy that refuses
arbitrary signing requests, OS controls that make the key harder to reach, and
detection for the remaining paths. It does not make the plugin, the prompts or
the model trustworthy. See [SECURITY.md](../SECURITY.md) for the boundary and
[docs/SIGNER-PROTOCOL.md](SIGNER-PROTOCOL.md) for the signer contract.

> **Version gate.** This runbook describes the **v2** policy signer. 0.14.0
> sends `v: 2` with `runId` and `approvalRef` only when
> `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` is set; without it the plugin sends
> the exact v1 request for back-compat. A v2-only signer will refuse a v1
> request, and the write fails `AUTH_SIGNER_UNAVAILABLE`; a v1-only signer with
> the directory set refuses the v2 request the same way. There is no fallback
> to the local HMAC key. Deploy the signer with the matching plugin, or keep
> the previous key source. Do not point a v1-only signer at a configured v2
> directory and call the result hardened.

> **What "policy-enforcing" means here.** A bare command signer that signs any
> well-formed `(path, digest)` is a signing oracle: a same-UID shell can ask it
> for the same signature the agent can. A policy-enforcing signer refuses to
> sign unless a separate principal has approved the exact run, path and digest,
> or unless the signer itself recomputes the verdict from evidence the agent
> cannot rewrite. The policy, not the socket permission, is the boundary.

---

## 1. Scope and threat model

### 1.1 What this runbook is meant to change

The base package's `local-hmac` and local-key modes are tamper-evident against a
writer limited to the run directory. They are not a boundary against a process
running as the agent's UID: that process can read `opencode.db` (or the plugin
KV store), read a local private key, mint an envelope, and rewrite the digest
index. A same-UID `command:` signer is callable by the same shell.

The hardened deployment in this runbook is intended to make the following
attacks fail **against an external verifier that trusts only the signer's public
key**:

| Attack | What the deployment changes |
| --- | --- |
| A same-UID shell reads the artifact key from `opencode.db` and mints a verdict | The verifier accepts only Ed25519 signatures from the signer key; the database key is not the signer key. |
| A run-directory writer forges or copies a signed verdict | Path, digest, run nonce, key id and signature are bound; the signer will not sign an unapproved digest. |
| A shell asks a command signer to sign an arbitrary `(path, digest)` | The v2 signer requires a separate approval bound to the exact `runId`, `path`, `digest`, `nonce` and expiry, and refuses without it. |
| The workload user reads the signer private key | The key is in a `0700` directory owned by the signer UID; `ptrace_scope=2` blocks same-UID memory access; the key is not in the environment. |
| The workload user replaces the signer executable | The signer and its client are root-owned, in a root-owned path, with no group/other write. |
| A forged approval file | The approval is an Ed25519 artifact owned by a different principal, opened with `O_NOFOLLOW`, and checked against the request. |

### 1.2 What it cannot change

- **A kernel exploit, root, `wheel`/`sudo`, or another root-equivalent group.**
  Root can read the key, ptrace the signer, edit the unit, and rewrite the audit
  log.
- **A compromised signer process or signer key.** The signer is the trust
  anchor. If it signs without its policy, or its key is stolen, the artifacts
  are signed by that key.
- **A compromised approver key or approval process.** The approval establishes
  that a configured key signed these fields. It does not establish that a human
  read the draft, that the displayed text matched the bytes hashed, or that the
  approver understood the consequence.
- **A prompt-injected agent.** The agent can still write false evidence, call
  tools, exfiltrate content, and ask for approval. The signer can refuse a
  signature for an unapproved digest; it cannot make the approved content true.
- **A modified plugin, config, prompt or model.** The plugin and
  `opencode.json` remain user-owned. A same-UID writer can disable the local
  gate. The external verifier and the signer's refusal are what remain. This
  runbook does not make the plugin trustworthy.
- **Availability and confidentiality.** The workload can delete runs, and run
  artifacts are not encrypted.
- **A human-presence proof.** The approval artifact is provenance for a
  configured key, not evidence that a person was present.

### 1.3 Trust boundary in one sentence

> A completion artifact is accepted by the external verifier only when it
> carries a signature from the signer key; the signer signs only after its
> policy checks the exact `(runId, path, digest, nonce)` against an approval
> owned by a different principal. Everything the workload UID can do before
> that point is still possible.

---

## 2. Preconditions

### 2.1 Accounts and access

1. **A separate administrator account** with working `sudo`. Do not use the
   workload account for administration, and do not use the human's daily login
   as the workload user.
2. **A workload user** that runs OpenCode and every agent. The recommended name
   is `opencode`. This user is the "agent UID" throughout this document.
3. **A signer user** (recommended `teamwork-signer`) that owns the signer key
   and runs the signer service. It is not the workload user and has no shell
   login.
4. **An approver user** (recommended `teamwork-approver`) that owns the
   approval directory and the approver private key. It is not the workload user
   and not the signer user.
5. **`openssl` 1.1.1 or later** on the host that creates the keys; `systemd`
   with socket activation; `auditd` (or an equivalent remote audit sink) if you
   want detection; SELinux tooling only if the host uses SELinux.

### 2.2 Values used below

Review and export these in your admin shell. They are examples, not a
requirement.

```sh
WORKLOAD_USER=opencode
SIGNER_USER=teamwork-signer
APPROVER_USER=teamwork-approver
SIGNER_GROUP=teamwork-signer
CLIENT_GROUP=teamwork-clients
APPROVAL_GROUP=teamwork-approvals
SIGNER_APPROVAL_GROUP=teamwork-signer-approvals

KEY_DIR=/var/lib/teamwork-signer/keys
KEY_FILE=$KEY_DIR/signer.pem
APPROVER_KEY_DIR=/var/lib/teamwork-approver/keys
APPROVAL_DIR=/var/lib/teamwork-approvals
SIGNER_APPROVAL_DIR=$APPROVAL_DIR/signer

SIGNER=/usr/local/libexec/teamwork/signer
CLIENT=/usr/local/libexec/teamwork/signer-client
PUBLIC_KEY=/etc/teamwork/signer-ed25519.pub
APPROVER_PUBLIC_KEY=/etc/teamwork/approver-ed25519.pub
SOCKET=/run/teamwork-signer/sign.sock
SOCKET_UNIT=teamwork-signer.socket
SERVICE_UNIT=teamwork-signer@.service

export WORKLOAD_USER SIGNER_USER APPROVER_USER SIGNER_GROUP CLIENT_GROUP APPROVAL_GROUP SIGNER_APPROVAL_GROUP
export KEY_DIR KEY_FILE APPROVER_KEY_DIR APPROVAL_DIR SIGNER_APPROVAL_DIR
export SIGNER CLIENT PUBLIC_KEY APPROVER_PUBLIC_KEY SOCKET SOCKET_UNIT SERVICE_UNIT
```

### 2.3 Back up the current posture before changing anything

The backup is read-only output plus copies of the policy files. It is not a
secret backup: do not copy private keys into it.

```sh
umask 077
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=/var/backups/teamwork-posture-$STAMP
sudo install -d -m 0700 -o root -g root "$BACKUP"

# Policy files that a rollback may need.
sudo cp -a /etc/group /etc/gshadow "$BACKUP"/ 2>/dev/null || true
sudo cp -a /etc/sudoers "$BACKUP"/sudoers 2>/dev/null || true
sudo cp -a /etc/sysctl.d "$BACKUP"/sysctl.d 2>/dev/null || true
sudo cp -a /etc/audit/rules.d "$BACKUP"/audit-rules.d 2>/dev/null || true
sudo cp -a /etc/systemd/system "$BACKUP"/systemd-system 2>/dev/null || true
sudo cp -a /etc/fstab "$BACKUP"/fstab 2>/dev/null || true

# Read-only baseline: identities, groups, kernel, mounts, units, SELinux, audit.
{
  date -u
  printf '\n== id ==\n'; id
  printf '\n== workload identity ==\n'; getent passwd "$WORKLOAD_USER" || true
  printf '\n== workload groups ==\n'; id -Gn "$WORKLOAD_USER" 2>/dev/null || true
  printf '\n== root-equivalent groups ==\n'
  getent group root wheel sudo docker libvirt lxd disk adm systemd-journal 2>/dev/null || true
  printf '\n== ptrace ==\n'; sysctl -n kernel.yama.ptrace_scope 2>/dev/null || true
  printf '\n== /proc mount ==\n'; findmnt -no TARGET,OPTIONS /proc 2>/dev/null || true
  printf '\n== paths ==\n'
  stat -c '%A %a %U:%G %n' "$KEY_DIR" "$KEY_FILE" "$APPROVAL_DIR" "$SIGNER" "$PUBLIC_KEY" "$SOCKET" 2>&1 || true
  printf '\n== auditd ==\n'; systemctl show -p LoadState -p ActiveState auditd.service 2>/dev/null || true
  printf '\n== audit rules ==\n'; sudo auditctl -l 2>&1 || true
  printf '\n== SELinux ==\n'; getenforce 2>&1 || true
  printf '\n== units ==\n'
  sudo systemctl cat "$SOCKET_UNIT" "$SERVICE_UNIT" 2>&1 || true
  printf '\n== doctor (as workload, if installed) ==\n'
  sudo -u "$WORKLOAD_USER" sh -c 'command -v opencode-teamwork >/dev/null 2>&1 && opencode-teamwork doctor --security --json' 2>&1 || true
} | sudo tee "$BACKUP/baseline.txt" >/dev/null

sudo sha256sum "$BACKUP/baseline.txt" | sudo tee "$BACKUP/baseline.sha256" >/dev/null
sudo chmod 0600 "$BACKUP/baseline.txt" "$BACKUP/baseline.sha256"
```

**Proof.**

```sh
sudo test -s "$BACKUP/baseline.txt" && echo baseline-present
sudo sha256sum -c "$BACKUP/baseline.sha256"
sudo sed -n '1,60p' "$BACKUP/baseline.txt"
```

**Rollback.** Nothing was changed. Keep the directory until the deployment is
accepted; archive it if you need an audit trail. Delete it only with the
administrator's approval.

**Honest limit.** The baseline is a point-in-time read by a privileged process
on the host. A compromised kernel or a lying `sudo` can produce a false
baseline. The backup contains policy, not secrets; do not add private keys.

---

## 3. Step 1 — Capture and understand the baseline

**Purpose.** Establish what "before" means for every later rollback: UID/GID,
supplementary groups, socket modes, Yama `ptrace_scope`, `/proc` mount options,
`auditd` state, SELinux mode and the paths you are about to create.

**Commands.** Use the block in §2.3. Additionally record the exact facts the
verification script will later probe:

```sh
id
id -Gn
sysctl -n kernel.yama.ptrace_scope
findmnt -no OPTIONS /proc
systemctl show -p LoadState -p ActiveState auditd.service
getenforce 2>/dev/null || true
stat -c '%A %a %U:%G %n' /run /var/lib /etc 2>/dev/null || true
```

**Proof.** `id -u` is non-zero; `id -Gn` lists the groups you will change;
`sysctl -n` and `findmnt` return values or an empty/error line that you record;
`systemctl show` returns `LoadState` and `ActiveState`; `getenforce` returns
`Enforcing`, `Permissive`, `Disabled`, or an error (non-SELinux host).

**Rollback.** None; this step is read-only.

**Honest limit.** `id`, `sysctl`, `stat` and `systemctl` report the host's
current view. They do not prove that a process already running has the same
view, and they do not detect a kernel-level liar.

---

## 4. Step 2 — Remove root-equivalent groups from the workload user

**Purpose.** A member of `docker`, `libvirt`, `lxd`, `disk`, `adm` or
`systemd-journal` can often read the key, the database, the journal, or a block
device without becoming root. Remove those memberships from the workload user
before the signer exists.

`wheel` and `sudo` are a **policy decision**, not an automatic removal. If the
workload user can run arbitrary commands as root, no file mode in this runbook
matters. Removing `wheel`/`sudo` from the workload is recommended only when a
separate administrator account exists and the workload does not need
administrative commands. Otherwise, restrict `sudoers` and accept that the
workload is root-equivalent; the signer cannot fix that.

**Commands.**

```sh
# Show what is actually present before removing anything.
id -Gn "$WORKLOAD_USER"
getent group docker libvirt lxd disk adm systemd-journal 2>/dev/null || true
sudo -l -U "$WORKLOAD_USER" 2>/dev/null || true

# Remove the hard set. `gpasswd -d` fails on a primary group; do not remove a
# primary group here.
for g in docker libvirt lxd disk adm systemd-journal; do
  if id -nG "$WORKLOAD_USER" | tr ' ' '\n' | grep -qx "$g"; then
    sudo gpasswd -d "$WORKLOAD_USER" "$g"
  fi
done

# Policy decision only. Keep a separate admin account first.
# sudo gpasswd -d "$WORKLOAD_USER" wheel
# sudo gpasswd -d "$WORKLOAD_USER" sudo

# Terminate existing sessions so supplementary groups are not frozen.
sudo loginctl terminate-user "$WORKLOAD_USER" 2>/dev/null || true
```

**Proof.** A fresh login is required because supplementary groups are frozen in
existing processes. Do not trust a new shell started by the old process.

```sh
sudo -iu "$WORKLOAD_USER" -- id -Gn
sudo -n -u "$WORKLOAD_USER" -- id -Gn
```

Both must show the reduced set. Then inspect a running process's
`/proc/<pid>/status` `Groups:` line if any process survived; it still has the
old set until it is restarted. Restart OpenCode and its terminal (or reboot) and
re-check.

**Rollback.**

```sh
sudo gpasswd -a "$WORKLOAD_USER" docker     # repeat for each removed group
sudo loginctl terminate-user "$WORKLOAD_USER" 2>/dev/null || true
```

**Honest limit.** Group removal is not a complete privilege review. Check for
other root-equivalent paths: `podman` sockets, device ACLs, capabilities
(`getcap -r /` on the workload's binaries), sudoers rules with wildcards,
`/etc/sudoers.d`, polkit rules, and services that run commands on behalf of the
workload. `systemd-journal` removal can reduce log access; use an administrator
account or a scoped ACL rather than re-adding the workload. A process that is
already running keeps its old groups until it is restarted.

---

## 5. Step 3 — Set `kernel.yama.ptrace_scope=2`

**Purpose.** Stop a same-UID process from attaching to the OpenCode or signer
process and reading its memory or environment. `ptrace_scope=1` is **not
enough** for this threat: Yama level 1 permits a process to trace its
**descendants**, and the shell that launched OpenCode is an ancestor. That shell
can therefore trace OpenCode under level 1. Level 2 permits only a process with
`CAP_SYS_PTRACE` (root/admin); level 3 disables attach entirely and is also
acceptable for a dedicated signer host, though it makes debugging harder.

**Commands.**

```sh
printf '%s\n' 'kernel.yama.ptrace_scope = 2' \
  | sudo tee /etc/sysctl.d/90-teamwork-ptrace.conf >/dev/null
sudo chmod 0644 /etc/sysctl.d/90-teamwork-ptrace.conf
sudo sysctl --system
```

**Proof.** Start a disposable process as the workload user and attempt the two
reads as that same user.

```sh
sudo -u "$WORKLOAD_USER" sleep 300 &
TEST_PID=$!
sleep 0.2

sysctl -n kernel.yama.ptrace_scope
sudo -u "$WORKLOAD_USER" gdb -p "$TEST_PID" -batch -ex 'info proc' 2>&1 || true
sudo -u "$WORKLOAD_USER" cat "/proc/$TEST_PID/mem" >/dev/null 2>&1; echo "mem_exit=$?"
sudo -u "$WORKLOAD_USER" head -c 1 "/proc/$TEST_PID/environ" >/dev/null 2>&1; echo "environ_exit=$?"

kill "$TEST_PID" 2>/dev/null || true
```

Expected: the `gdb` attach fails with an operation-not-permitted error (or
`gdb` is absent), `mem_exit` is non-zero, and **`environ_exit` is 0**. That last
result is the honest limit: `/proc/<pid>/environ` remains readable by the same
UID even with `ptrace_scope=2`. Keys must not live in environment variables or
argv. The signer key must be a `0600` file in the signer's `0700` directory, not
in `OPENCODE_TEAMWORK_ED25519_PRIVATE_KEY` in the workload's environment.

If `gdb` is not installed, the `/proc/<pid>/mem` read is the proof; if that read
succeeds, stop and investigate the kernel/Yama state.

**Rollback.**

```sh
sudo rm -f /etc/sysctl.d/90-teamwork-ptrace.conf
sudo sysctl -w kernel.yama.ptrace_scope=0   # or the baseline value
```

**Honest limit.** `ptrace_scope` is a Yama feature, not a universal kernel
control. It does not stop root, a process with `CAP_SYS_PTRACE`, a kernel
exploit, a process reading its own memory, or a debugger that was already
attached before the setting changed. It does **not** make
`/proc/<pid>/environ` unreadable to the same UID. It also does not protect
against a same-UID process that reads a key file the file mode allows; that is
why the key has a different owner and mode.

---

## 6. Step 4 — Consider `hidepid` (marginal; not a same-UID control)

**Purpose.** `hidepid=2` on `/proc` hides other users' processes from `ps` and
`/proc`. It is a cross-user visibility control. It does **not** hide processes
from the same UID, so it is not a control for the threat in this runbook. Mark
it marginal and skip it if it risks monitoring or container behavior.

**Commands (optional).**

```sh
# Runtime test first.
sudo mount -o remount,hidepid=2 /proc
findmnt -no OPTIONS /proc

# Persist only after testing. Keep a backup of /etc/fstab.
printf '%s\n' 'proc /proc proc defaults,hidepid=2 0 0' | sudo tee -a /etc/fstab >/dev/null
sudo systemctl daemon-reload
```

On systems where `/proc` is mounted by an early systemd unit rather than
`fstab`, the persistent form may need a reviewed `proc.mount` drop-in instead.
Test the reboot path on a disposable host.

**Proof.**

```sh
findmnt -no OPTIONS /proc
sudo -u "$WORKLOAD_USER" ps -eo user,pid,comm | grep -v "^$WORKLOAD_USER" || true
sudo -u "$WORKLOAD_USER" ls -ld /proc/1 2>&1 || true
# Same-UID visibility remains:
sudo -u "$WORKLOAD_USER" sh -c 'sleep 30 & p=$!; ls -ld /proc/$p; kill $p'
```

The last command succeeding is the point: same-UID processes remain visible.
`/proc/1` may be hidden from the workload; that is cross-user hiding, not key
protection.

**Rollback.**

```sh
sudo mount -o remount,hidepid=0 /proc
# Remove the line you added to /etc/fstab, then:
sudo systemctl daemon-reload
```

**Honest limit.** `hidepid` is not a same-UID control and must not be described
as one. It can break `ps`, monitoring agents, and container tooling. It adds no
protection against a shell running as the workload user.

---

## 7. Step 5 — Audit the key directory, signer code, approvals and socket

**Purpose.** Record access to the assets that matter, and send the record to a
destination outside the workload's write domain. Auditing is detection after
the fact, not prevention.

> **Ordering note.** `auditctl` refuses a watch on a path that does not exist.
> Create the rules file here, but **load it at the end of step 8**, after steps
> 6–8 have created the key, approval, signer and socket paths. Loading now with
> missing paths makes the load fail; an unloaded rule file is inert.

**Commands.** Create `/etc/audit/rules.d/90-teamwork.rules`:

```sh
sudo tee /etc/audit/rules.d/90-teamwork.rules >/dev/null <<'EOF'
## Teamwork signer assets. Load after steps 6-8: sudo augenrules --load
## Key directory and private key.
-w /var/lib/teamwork-signer/keys -p rwxa -k teamwork_key
-w /var/lib/teamwork-signer/keys/signer.pem -p rwxa -k teamwork_key
## Signer code and the transport client.
-w /usr/local/libexec/teamwork/signer -p rwxa -k teamwork_signer_code
-w /usr/local/libexec/teamwork/signer-client -p rwxa -k teamwork_signer_code
## Approval directory and signer approvals (directory watches do not recurse).
-w /var/lib/teamwork-approvals -p rwxa -k teamwork_approval
-w /var/lib/teamwork-approvals/signer -p rwxa -k teamwork_approval
## Socket directory (creation/removal and metadata changes).
-w /run/teamwork-signer -p rwxa -k teamwork_socket
## Execute of the signer binary.
-a always,exit -F arch=b64 -S execve -F path=/usr/local/libexec/teamwork/signer -F perm=x -k teamwork_signer_exec
## connect(2): broad; filter the resulting records by saddr/path downstream.
-a always,exit -F arch=b64 -S connect -k teamwork_connect
EOF

# Do not load yet. The paths do not exist until steps 6-8.
# After step 8: sudo augenrules --load && sudo auditctl -l | grep teamwork
```

Add `arch=b32` variants only if the host runs 32-bit binaries you care about;
an unsupported `b32` rule can make `auditctl` fail. The `connect` rule logs
every `connect(2)` on the host and is intentionally broad: auditd cannot filter
a Unix-socket `connect` by pathname. Correlate with the socket record or ship
the log to a collector that can parse `saddr`.

> **Deferred load.** The two commands above are shown for reference. Run them
> **after step 8**, when every watched path exists. If you run them here, expect
> an error for a missing path and no active watch. The proof below is also a
> post-step-8 proof.

**Log destination.** Confirm the audit log is root-owned and not writable by
the workload, and configure a remote sink for the cases that matter:

```sh
sudo stat -c '%A %a %U:%G %n' /var/log/audit/audit.log
sudo grep -E '^(log_file|space_left_action|disk_full_action|admin_space_left_action)' /etc/audit/auditd.conf
```

`space_left_action = syslog`, a remote `audisp-remote` target, or a forwarded
journal is preferred. Do not set `disk_full_action = halt` on a production host
without testing the failover behavior.

**Proof.** Generate one read event and one connection event, then search:

```sh
sudo -u "$WORKLOAD_USER" cat "$KEY_FILE" >/dev/null 2>&1 || true
# A privileged read proves the watch is active without printing the key.
sudo head -c 1 "$KEY_FILE" >/dev/null 2>&1 || true
sudo ausearch -i -k teamwork_key -ts recent | tail -n 20

# A v2 request is expected to be refused; the connect is still audited.
printf '%s\n' '{"v":2,"op":"sign-artifact","runId":"audit-probe","alg":"ed25519","keyId":"probe","path":"verify/victory.json","digest":"00","nonce":"probe","at":"2026-01-01T00:00:00Z","approvalRef":"/nonexistent","message":"eA"}' \
  | sudo -u "$WORKLOAD_USER" "$CLIENT" 2>/dev/null || true
sudo ausearch -i -k teamwork_connect -ts recent | tail -n 20
```

The key read should be denied and still produce a record (if the watch is on
the key directory; a denied read may produce a `PATH` record). The connect
record should name the signer socket's `saddr` after `ausearch -i`.

**Rollback.**

```sh
sudo rm -f /etc/audit/rules.d/90-teamwork.rules
sudo augenrules --load
sudo auditctl -l | grep teamwork || true
```

For individual rules, use `sudo auditctl -W <path> -p rwxa -k <key>` to remove a
watch, and `sudo auditctl -d always,exit -F arch=b64 -S connect -k
teamwork_connect` for the syscall rule. Do not use `auditctl -D` on a host with
other audit policy.

**Honest limit.** Auditd is detection, not prevention. Root can stop it or edit
the log. A path watch is attached to the inode/path at load time; a file
replaced afterwards may evade a watch on the old inode, which is why the
directory and the exec rule are also present. The `connect` rule is noisy and
does not by itself prove which process connected. The audit log is only as
trustworthy as its destination; a local root-owned file is not a remote witness.

---

## 8. Step 6 — Create the system users, key directory and approval directory

**Purpose.** Put the signer key in a `0700` directory owned by the signer UID,
put prompt approvals in a `0750` directory owned by a **different** principal
and readable by the workload for verification, and put signer approvals in a
separate `0750` subdirectory readable only by the signer. Publish only public
keys in `/etc/teamwork`.

**Commands.**

```sh
# Groups and users. `getent` guards make the block re-runnable.
for g in "$SIGNER_GROUP" "$CLIENT_GROUP" "$APPROVAL_GROUP" "$SIGNER_APPROVAL_GROUP"; do
  getent group "$g" >/dev/null 2>&1 || sudo groupadd --system "$g"
done

NOLOGIN=$(command -v nologin || echo /usr/sbin/nologin)
getent passwd "$SIGNER_USER" >/dev/null 2>&1 || \
  sudo useradd --system --no-create-home --home-dir /var/lib/teamwork-signer \
    --shell "$NOLOGIN" --gid "$SIGNER_GROUP" "$SIGNER_USER"
getent passwd "$APPROVER_USER" >/dev/null 2>&1 || \
  sudo useradd --system --no-create-home --home-dir /var/lib/teamwork-approver \
    --shell "$NOLOGIN" --gid "$APPROVAL_GROUP" "$APPROVER_USER"

# The workload must read prompt approvals; the directory mode is read-only.
sudo usermod -aG "$CLIENT_GROUP" "$WORKLOAD_USER"
sudo usermod -aG "$APPROVAL_GROUP" "$WORKLOAD_USER"
# The signer traverses the parent and reads the signer-approval subdirectory.
sudo usermod -aG "$APPROVAL_GROUP" "$SIGNER_USER"
sudo usermod -aG "$SIGNER_APPROVAL_GROUP" "$SIGNER_USER"
# The workload must not read signer approvals.
if id -nG "$WORKLOAD_USER" | tr ' ' '\n' | grep -qx "$SIGNER_APPROVAL_GROUP"; then
  sudo gpasswd -d "$WORKLOAD_USER" "$SIGNER_APPROVAL_GROUP"
fi

# Directories.
sudo install -d -m 0700 -o "$SIGNER_USER" -g "$SIGNER_GROUP" "$KEY_DIR"
sudo install -d -m 0700 -o "$APPROVER_USER" -g "$APPROVAL_GROUP" "$APPROVER_KEY_DIR"
sudo install -d -m 0750 -o "$APPROVER_USER" -g "$APPROVAL_GROUP" "$APPROVAL_DIR"
sudo install -d -m 0750 -o "$APPROVER_USER" -g "$SIGNER_APPROVAL_GROUP" "$SIGNER_APPROVAL_DIR"
sudo install -d -m 0755 -o root -g root /etc/teamwork
```

**Generate the signer key as the signer UID, not as root and not as the
workload.**

```sh
sudo -u "$SIGNER_USER" sh -c 'umask 077; openssl genpkey -algorithm ED25519 -out "$1"' sh "$KEY_FILE"
sudo chmod 0600 "$KEY_FILE"

# SPKI public key, base64url (no padding), mode 0644.
sudo -u "$SIGNER_USER" openssl pkey -in "$KEY_FILE" -pubout -outform DER \
  | openssl base64 -A | tr '+/' '-_' | tr -d '=' \
  | sudo tee "$PUBLIC_KEY" >/dev/null
sudo chmod 0644 "$PUBLIC_KEY"
```

**Generate the approver key as the approver UID.**

```sh
sudo -u "$APPROVER_USER" sh -c 'umask 077; openssl genpkey -algorithm ED25519 -out "$1"' sh "$APPROVER_KEY_DIR/approver.pem"
sudo chmod 0600 "$APPROVER_KEY_DIR/approver.pem"

sudo -u "$APPROVER_USER" openssl pkey -in "$APPROVER_KEY_DIR/approver.pem" -pubout -outform DER \
  | openssl base64 -A | tr '+/' '-_' | tr -d '=' \
  | sudo tee "$APPROVER_PUBLIC_KEY" >/dev/null
sudo chmod 0644 "$APPROVER_PUBLIC_KEY"
```

**Approval file modes.** The shipped `approve sign` CLI writes its prompt
approval with mode `0600` (ADR 0011), but the workload must read that file for
the `human-approved` trust level. After producing it, the approver must make it
group-readable without making it writable:

```sh
# Prompt approval (human-approved/ci-attested); run as the approver.
RUN_ID=r-01J8Z5K8V6Q9W2M4N7P3S6T8X0
PROMPT_APPROVAL="$APPROVAL_DIR/$RUN_ID.json"
chgrp "$APPROVAL_GROUP" "$PROMPT_APPROVAL"
chmod 0640 "$PROMPT_APPROVAL"
```

For a v2 signer approval, the signer (not the workload) must read the file. The
layout is **one file per `(runId, path)`**, derived by both the producer and the
plugin from trusted inputs:

```text
$SIGNER_APPROVAL_DIR/<runId>/<sha256(run-relative path)>.json
```

The hash is a **plain SHA-256** of the UTF-8 path (`contentSha256Hex` in
`plugins/opencode-teamwork/approval-format.mjs`), not the keyed artifact digest.
Put the file in the separate subdirectory and give it the signer-approval group:

```sh
# Example after producing one signer approval with `approve signer`; run as the approver.
RUN_ID=r-01J8Z5K8V6Q9W2M4N7P3S6T8X0
PATH_HASH=$(printf '%s' "verify/victory.json" | sha256sum | cut -d' ' -f1)
SIGNER_APPROVAL_FILE="$SIGNER_APPROVAL_DIR/$RUN_ID/$PATH_HASH.json"
chgrp "$SIGNER_APPROVAL_GROUP" "$SIGNER_APPROVAL_FILE"
chmod 0640 "$SIGNER_APPROVAL_FILE"
```

Read access is required for verification and is not the boundary; write access
is. Do not make either directory `0770`, and do not add the workload to
`teamwork-signer-approvals`.

**Proof.**

```sh
stat -c '%A %a %U:%G %n' "$KEY_DIR" "$KEY_FILE" "$APPROVER_KEY_DIR" \
  "$APPROVAL_DIR" "$SIGNER_APPROVAL_DIR" "$PUBLIC_KEY" "$APPROVER_PUBLIC_KEY"

sudo -u "$WORKLOAD_USER" test -r "$KEY_FILE";  echo "workload_key_read=$?"   # expect 1
sudo -u "$WORKLOAD_USER" test -r "$APPROVAL_DIR"; echo "workload_approval_read=$?" # expect 0
sudo -u "$WORKLOAD_USER" test -w "$APPROVAL_DIR"; echo "workload_approval_write=$?" # expect 1
sudo -u "$WORKLOAD_USER" test -r "$SIGNER_APPROVAL_DIR"; echo "workload_signer_approval_read=$?" # expect 1
sudo -u "$SIGNER_USER" test -r "$SIGNER_APPROVAL_DIR"; echo "signer_approval_read=$?" # expect 0
sudo -u "$SIGNER_USER" test -r "$APPROVER_PUBLIC_KEY"; echo "signer_pub_read=$?" # expect 0
id -nG "$WORKLOAD_USER" | tr ' ' '\n' | grep -x "$SIGNER_APPROVAL_GROUP" && echo "BAD: workload in signer-approval group" || true
```

**Rollback.**

```sh
# Archive keys and approvals first. Deleting the signer key stops new
# signatures; old signatures remain verifiable with the archived public key.
sudo gpasswd -d "$WORKLOAD_USER" "$APPROVAL_GROUP" 2>/dev/null || true
sudo gpasswd -d "$WORKLOAD_USER" "$SIGNER_APPROVAL_GROUP" 2>/dev/null || true
sudo userdel "$SIGNER_USER" 2>/dev/null || true
sudo userdel "$APPROVER_USER" 2>/dev/null || true
sudo groupdel "$SIGNER_GROUP" 2>/dev/null || true
sudo groupdel "$CLIENT_GROUP" 2>/dev/null || true
sudo groupdel "$APPROVAL_GROUP" 2>/dev/null || true
sudo groupdel "$SIGNER_APPROVAL_GROUP" 2>/dev/null || true
sudo rm -rf "$KEY_DIR" "$APPROVER_KEY_DIR" "$APPROVAL_DIR" /etc/teamwork
```

**Honest limit.** A different owner and a `0700`/`0750` mode are necessary but
not sufficient. The workload is in the prompt-approval group so it can read the
file it must verify; read access is not write access, but it does mean the
approval contents are visible to the workload. The signer is in both approval
groups and can read every approval it is asked to check; a compromised signer
can misuse that. The approver key holder can sign any approval; a script with
the key can reproduce the CLI's typed confirmation. The approval directory
owner is a claimed deployment fact, not an identity proof. The key file is only
as secret as the signer UID; root can read it.

---

## 9. Step 7 — Install root-owned signer code

**Purpose.** A signer executable that the workload can write is replaceable: the
workload can substitute a program that reads the request, ignores the policy,
and returns a signature. Root-owned code in a root-owned path removes that
specific path. It does **not** make the local plugin trustworthy; a same-UID
writer can still edit the plugin to call a different path, which is why the
external verifier must pin the public key.

**Commands.**

```sh
sudo install -d -m 0755 -o root -g root /usr/local/libexec/teamwork
sudo install -m 0755 -o root -g root ./target/release/teamwork-signer "$SIGNER"
sudo install -m 0755 -o root -g root ./signer-client "$CLIENT"
sudo chown root:root /usr/local/libexec/teamwork "$SIGNER" "$CLIENT"
sudo chmod 0755 /usr/local/libexec/teamwork "$SIGNER" "$CLIENT"

# No parent may be writable by the workload or by group/other.
namei -l "$SIGNER"
```

The client is a transport, not a policy. It must be root-owned so the workload
cannot replace it to lie about a signature. A malicious client can deny service
or replay bytes; it cannot forge a signature that the plugin verifies against
the pinned public key.

**Proof.**

```sh
stat -c '%A %a %U:%G %n' "$SIGNER" "$CLIENT"
namei -l "$SIGNER"
sudo -u "$WORKLOAD_USER" test -w "$SIGNER"; echo "workload_signer_write=$?" # expect 1
find /usr/local/libexec/teamwork -maxdepth 1 \( -perm -002 -o -perm -020 \) -print # expect no output
```

**Rollback.** Restore the previous binary from the baseline or package
manager, or remove the files. Do not leave a user-writable copy earlier in
`PATH`; the plugin uses an absolute path, but an operator command may not.

**Honest limit.** Root-owned code does not stop root, a package manager, or a
root compromise. It does not stop a same-UID writer from editing the
user-owned plugin, the agent prompts, or `opencode.json`; the local gate can be
disabled. It does not stop the workload from calling the signer socket, which
is intended. The external verifier's public-key pin and the signer's policy are
the remaining checks. A signer whose key is in an environment variable readable
by the workload is not protected by root-owned code.

---

## 10. Step 8 — Run the signer as a systemd system socket + service

**Purpose.** The plugin's `command:` signer is spawned as the workload UID. A
root-owned executable alone does not change UID, so the key-holding signer must
run as a separate system service. The plugin reaches it through a small
root-owned client that connects to a Unix socket. systemd creates the socket
with the right owner and mode and applies service sandboxing.

### 10.1 Socket unit

```sh
sudo tee /etc/systemd/system/teamwork-signer.socket >/dev/null <<'EOF'
[Unit]
Description=Teamwork policy signer socket

[Socket]
ListenStream=/run/teamwork-signer/sign.sock
SocketMode=0660
SocketUser=teamwork-signer
SocketGroup=teamwork-clients
DirectoryMode=0755
Accept=yes
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
EOF
```

`DirectoryMode=0755` lets the workload traverse `/run/teamwork-signer`; the
socket's `0660` mode and `teamwork-clients` group control who can connect. The
directory is not the boundary, and the socket group is not identity: every
process with the workload UID can connect.

### 10.2 Service unit

```sh
sudo tee /etc/systemd/system/teamwork-signer@.service >/dev/null <<'EOF'
[Unit]
Description=Teamwork policy signer (per connection)
Requires=teamwork-signer.socket
After=teamwork-signer.socket

[Service]
ExecStart=/usr/local/libexec/teamwork/signer --stdio
StandardInput=socket
StandardOutput=socket
StandardError=journal
User=teamwork-signer
Group=teamwork-signer
SupplementaryGroups=teamwork-approvals teamwork-signer-approvals
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
CapabilityBoundingSet=
AmbientCapabilities=
EOF
```

`ReadWritePaths` is intentionally absent: the signer reads the key and the
approval and writes its audit line to the journal. If you add a consumed-approval
ledger, create a separate `0700` state directory and add a narrowly scoped
`ReadWritePaths=` for it; do not make the key directory writable just for logs.

`MemoryDenyWriteExecute=yes` is incompatible with a JavaScript engine's JIT.
Use a Rust/Go signer, or a Node signer started with `node --jitless`, and test
the actual binary. Node also does not expose `SO_PEERCRED`, so a Node signer
cannot verify the peer UID from the socket; it can still compare the approval
file owner to a configured workload UID. A Rust/Go signer can do both. Do not
assume `--jitless` is enough on every Node/V8 build; if the service fails to
start, use a non-JS signer.

### 10.3 The root-owned client

The plugin's `command:` SPI writes one JSON request to stdin and reads one JSON
response from stdout. The client must forward bytes without parsing them. A
small Python client with an absolute interpreter path avoids a `PATH` hijack:

```sh
sudo tee "$CLIENT" >/dev/null <<'EOF'
#!/usr/bin/python3
import socket, sys

SOCKET = "/run/teamwork-signer/sign.sock"
TIMEOUT = 10

try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(TIMEOUT)
        s.connect(SOCKET)
        s.sendall(sys.stdin.buffer.read())
        s.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
except Exception as exc:
    print(f"signer-client: {exc}", file=sys.stderr)
    raise SystemExit(1)

sys.stdout.buffer.write(b"".join(chunks))
EOF
sudo chown root:root "$CLIENT"
sudo chmod 0755 "$CLIENT"
```

Use a compiled client if the host cannot guarantee `/usr/bin/python3` is
root-owned; the client only has to connect, half-close, and copy. It must not
add fields, retry with a different digest, or log the request.

### 10.4 Workload configuration

```sh
OPENCODE_TEAMWORK_SIGNER=command:/usr/local/libexec/teamwork/signer-client
OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY=$(cat /etc/teamwork/signer-ed25519.pub)
OPENCODE_TEAMWORK_APPROVAL_DIR=/var/lib/teamwork-approvals
OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY=$(cat /etc/teamwork/approver-ed25519.pub)
OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1
# After the v2 plugin change ships, also set the signer-approval directory:
# OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR=/var/lib/teamwork-approvals/signer
```

Put these in a root-owned environment file used by the OpenCode launcher if
possible. A workload-owned shell profile can be edited by the workload; the
external verifier's key pin, not the local environment, is what makes a
signature meaningful.

### 10.5 Enable and prove refusal

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now teamwork-signer.socket
systemctl is-active teamwork-signer.socket
ss -xl | grep /run/teamwork-signer/sign.sock
sudo systemd-analyze security teamwork-signer@.service --no-pager | tail -n 25

# The watched paths now exist. Load the rules prepared in step 5.
sudo augenrules --load
# If augenrules is unavailable:
# sudo auditctl -R /etc/audit/rules.d/90-teamwork.rules
sudo auditctl -l | grep teamwork
```

Send a v2 request with no valid approval. The signer must **refuse**, not sign:

```sh
printf '%s\n' '{"v":2,"op":"sign-artifact","runId":"probe-run","alg":"ed25519","keyId":"signer_test","path":"verify/victory.json","digest":"00","nonce":"probe-nonce","at":"2026-01-01T00:00:00Z","approvalRef":"/var/lib/teamwork-approvals/signer/probe-run/missing.json","message":"eA"}' \
  | sudo -u "$WORKLOAD_USER" "$CLIENT"
echo "client_exit=$?"
```

Expected: a JSON error such as `{"ok":false,"code":"E_APPROVAL_OPEN",...}` or an
earlier `E_KEYID`/`E_MESSAGE` if you did not substitute the configured key id
and a valid message. **Any named `E_*` refusal is acceptable; a `sig` is not.**
If you receive a `sig`, the signer is a bare oracle; stop and fix it before
pointing the plugin at it. To exercise the approval path specifically, use the
exact test vector in
[SIGNER-PROTOCOL.md §3.3](SIGNER-PROTOCOL.md#33-test-vector) with your
configured key id and an approval that does not exist. Also send `{"v":1,...}`
and expect `E_VERSION`; a v2 signer must refuse v1 (see
[SIGNER-PROTOCOL.md](SIGNER-PROTOCOL.md)).

```sh
journalctl -u 'teamwork-signer@*' -n 30 --no-pager
sudo systemctl reset-failed 'teamwork-signer@*' 2>/dev/null || true
```

**Rollback.**

```sh
sudo systemctl disable --now teamwork-signer.socket
sudo systemctl stop 'teamwork-signer@*' 2>/dev/null || true
sudo rm -f /etc/systemd/system/teamwork-signer.socket /etc/systemd/system/teamwork-signer@.service
sudo systemctl daemon-reload
sudo systemctl reset-failed 'teamwork-signer@*' 2>/dev/null || true
sudo rmdir /run/teamwork-signer 2>/dev/null || true
```

**Honest limit.** Socket mode and group are connect controls, not identity: any
same-UID process can connect. systemd hardening is best effort and does not stop
root. `MemoryDenyWriteExecute` breaks a Node JIT unless `--jitless` is used and
tested; a Node signer cannot get peer credentials from the core `net` module. A
compromised signer can sign anything its policy allows; the audit journal is not
immutable. The service is an availability dependency: if it is down, signing
fails closed and the run cannot complete.

> **Version note.** 0.14.0 sends the `v:2` signer request with `runId` and
> `approvalRef` when `OPENCODE_TEAMWORK_SIGNER_APPROVAL_DIR` is set; without it
> the plugin sends the exact v1 request. The v2 signer in
> [SIGNER-PROTOCOL.md](SIGNER-PROTOCOL.md) requires that directory and refuses
> v1 with `E_VERSION`, which the plugin reports as
> `AUTH_SIGNER_UNAVAILABLE`. A v1-only signer with the directory set refuses the
> v2 request the same way. The plugin never falls back to a local HMAC key.

---

## 11. Step 9 — SELinux labels (and what Enforcing does not do)

**Purpose.** Under SELinux Enforcing, a mislabeled key directory, socket or
executable is denied access. Correct labels are required for the service to
work, and a confined signer domain can reduce what a compromised signer
reaches. Labels are defense in depth, not a UID boundary.

**Commands (labels only).**

```sh
getenforce
sudo semanage fcontext -a -t bin_t "$SIGNER"
sudo semanage fcontext -a -t bin_t "$CLIENT"
sudo semanage fcontext -a -t var_lib_t "$KEY_DIR(/.*)?"
sudo semanage fcontext -a -t var_lib_t "$APPROVAL_DIR(/.*)?"
sudo semanage fcontext -a -t etc_t "/etc/teamwork(/.*)?"
sudo restorecon -Rv "$KEY_DIR" "$APPROVAL_DIR" "$SIGNER" "$CLIENT" /etc/teamwork

ls -Z "$KEY_DIR" "$APPROVAL_DIR" "$SIGNER" "$CLIENT" /etc/teamwork
```

These standard types let the service run; they do **not** confine it. A systemd
service running a `bin_t` executable commonly ends up in an unconfined service
domain. To confine the signer, add a reviewed policy module with a dedicated
`teamwork_signer_t` domain, `init_daemon_domain`, and only the allows the service
needs. Draft with the AVCs from a test run, review every allow, and never ship a
blanket `allow` or `permissive` domain:

```sh
sudo ausearch -m avc -ts recent
# sudo audit2allow -a          # inspect, do not install blindly
```

Install only after review:

```sh
# sudo semodule -i teamwork_signer.pp
sudo semodule -l | grep teamwork_signer || true
sudo ausearch -m avc -ts recent | tail -n 40
```

**Proof.** `getenforce` is `Enforcing`; `ls -Z` shows the expected types;
`ausearch -m avc -ts recent` shows no new denials during a refused/valid request;
`ps -eZ | grep teamwork` shows the signer's domain. A denial is a named failure,
not a reason to set permissive.

**Rollback.**

```sh
sudo semodule -r teamwork_signer 2>/dev/null || true
sudo semanage fcontext -d "$SIGNER" 2>/dev/null || true
sudo semanage fcontext -d "$CLIENT" 2>/dev/null || true
sudo semanage fcontext -d "$KEY_DIR(/.*)?" 2>/dev/null || true
sudo semanage fcontext -d "$APPROVAL_DIR(/.*)?" 2>/dev/null || true
sudo restorecon -Rv "$KEY_DIR" "$APPROVAL_DIR" "$SIGNER" "$CLIENT" 2>/dev/null || true
```

**Honest limit.** Enforcing does not separate two same-UID `unconfined_t`
processes. The OpenCode process is usually unconfined; a confined signer domain
does not stop an unconfined same-UID process from calling the socket, and
confining OpenCode itself is a much larger policy project outside this runbook.
Labels are not a substitute for the separate UID, the `0700` key directory, the
approval policy, or `ptrace_scope`. Do not use `setenforce 0` as a fix.

---

## 12. Step 10 — Verify with the read-only script and the doctor

**Purpose.** Check the host posture without changing it. The script prints
`PASS`/`FAIL`/`UNKNOWN` for each probe and exits non-zero on any `FAIL`. The
doctor reports what the plugin itself can see.

**Commands.** Run as the administrator, not root.

```sh
scripts/hardening-check.sh --help

scripts/hardening-check.sh --sudo \
  --agent-user "$WORKLOAD_USER" \
  --signer-user "$SIGNER_USER" \
  --approver-user "$APPROVER_USER" \
  --key-dir "$KEY_DIR" \
  --key-file "$KEY_FILE" \
  --approval-dir "$APPROVAL_DIR" \
  --signer "$SIGNER" \
  --public-key "$PUBLIC_KEY" \
  --socket "$SOCKET"

scripts/hardening-check.sh --json --sudo ... | python3 -m json.tool
```

The script never modifies the host. `--sudo` only enables
`sudo -n -u <workload> test ...` probes; without it those probes are `UNKNOWN`,
not assumed safe. `UNKNOWN` is not a pass. A non-root administrator may be
unable to `stat` the signer's `0700` key directory or the approver's `0750`
directory; those probes, and the SELinux context probe, then report `UNKNOWN`.
Use the root proof in step 6, or run the script from an account that is already
allowed to traverse the path. Do not add the administrator to the signer group
just to turn a check green.

Then run the plugin's own posture check as the workload:

```sh
sudo -u "$WORKLOAD_USER" env \
  OPENCODE_TEAMWORK_SIGNER=command:/usr/local/libexec/teamwork/signer-client \
  OPENCODE_TEAMWORK_SIGNER_PUBLIC_KEY="$(cat /etc/teamwork/signer-ed25519.pub)" \
  OPENCODE_TEAMWORK_APPROVAL_DIR=/var/lib/teamwork-approvals \
  OPENCODE_TEAMWORK_APPROVAL_PUBLIC_KEY="$(cat /etc/teamwork/approver-ed25519.pub)" \
  OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES=1 \
  "$(command -v opencode-teamwork)" doctor --security --require-hardened
echo "doctor_exit=$?"
```

`doctor --security --require-hardened` exits `0` when no check is `fail` or
`unknown`; `unknown` refuses with exit `2`. A `warn` result does **not** change
the exit code, so exit `0` is not a claim that every probe passed. Plain
`doctor --security` is advisory. The doctor checks the key source, signer and
witness configuration, `ptrace_scope`, root-equivalent groups, the DB mode,
config/plugin writability, the approval key and directory, containment mode and
SELinux. It does not inspect the signer's policy or the audit rules.

**Proof.** Record the exit codes and the full output. A non-zero script exit
means at least one `FAIL`; fix it or record why it is acceptable. A `PASS` with
`UNKNOWN` elsewhere is not a hardened host.

**Rollback.** None; both commands are read-only.

**Honest limit.** The script reads host facts; it can be fooled by root, and it
does not execute the signer, verify an approval, parse audit rules, or prove
that the plugin, prompts, model or signer binary are unmodified. The doctor sees
the environment of the process that runs it; a different environment at agent
startup is not inspected. Neither tool turns a warning into protection.

---

## 13. What a passing check does and does not mean

`doctor --security --require-hardened` exits `0` only when no security check is
`fail` or `unknown`. `unknown` refuses with exit `2`. It does not exit `0`
because the deployment is "secure"; a `warn` (for example, a plugin directory
that is writable by this UID) stays at exit `0`. Read the check list, not only
the status.

A passing result means:

- the named host facts were inspectable and matched the probe;
- the key source and signer configuration are present as the plugin sees them;
- the approval directory, if configured, was external and owned by another UID
  at the time of the check;
- `ptrace_scope` was not `0` and no root-equivalent group from the list was
  detected.

It does **not** mean:

- the plugin, agent prompts, `opencode.json`, model or signer binary are
  unmodified;
- the signer enforced its policy on the artifacts you care about;
- a human read the approval, or that the approval content is true;
- an artifact accepted earlier is still true;
- a same-UID process cannot deny service, delete a run, or exfiltrate content;
- a macOS or Windows host has the same properties.

## 14. macOS and Windows notes

The closest equivalents are listed for orientation. **Do not claim parity.**
The Linux probes and the script are Linux-specific; a macOS or Windows host will
report `UNKNOWN`/`FAIL` for several checks, and that is not a hardened result.

| Step | macOS (closest equivalent) | Windows (closest equivalent) |
| --- | --- | --- |
| 1. Baseline | `id`, `sysctl`, `launchctl print system`, `csrutil status`, `spctl --status`, `log show` | `whoami /all`, `Get-LocalGroupMember`, `auditpol /get /category:*`, `Get-Service`, `wevtutil` |
| 2. Groups | Remove the workload from `admin`; inspect `dscl . -read /Groups/admin GroupMembership`; Docker Desktop groups. There is no `wheel`. | Remove from Administrators, Backup Operators, Hyper-V Administrators, docker-users, Device Owners; `net localgroup`. UAC is not a same-user boundary for an already-elevated process. |
| 3. ptrace | No Yama equivalent. SIP, the hardened runtime, entitlements and `taskgated` restrict some tracing; there is no `ptrace_scope=2`. Same-UID `vm_read`/debugging is not separated the same way. | No Yama. `OpenProcess` with `PROCESS_VM_READ` is governed by DACLs and integrity level; `SeDebugPrivilege` and protected-process light (PPL) exist. There is no equivalent guarantee. |
| 4. hidepid | No `hidepid`; process visibility is not a same-UID control. | No `hidepid`; process access is ACL/integrity based, not a same-UID hide. |
| 5. Audit | OpenBSM audit is deprecated/absent on current macOS; Unified Logging and EndpointSecurity are the closest. EndpointSecurity needs an entitlement and a privileged helper; no path-watch parity. | Advanced Audit Policy, file SACLs, Event Log and Windows Event Forwarding (WEF). Enable a SACL on the key/approval paths; forward the log. No auditd `-w` parity. |
| 6. Users/dirs | `sysadminctl -addUser`, `dscl`, `chmod`/`chown`; place the key in a `0700` directory owned by a dedicated user. The Keychain is same-UID accessible and is not a boundary. | Create a service account or gMSA; use `icacls` to give only the service SID access to the key directory; a different principal owns the approval directory. DPAPI user scope is same-UID, not a boundary. |
| 7. Root-owned code | Root-owned files under `/Library/...` or `/usr/local/...`; codesign and SIP help; a user-writable helper is replaceable. | Program Files ACLs, a service account that cannot write its own binary, code signing and WDAC/AppLocker. SYSTEM is root-equivalent. |
| 8. Service | LaunchDaemon in `/Library/LaunchDaemons` (root-owned), launchd socket activation, a `Sandbox` profile or Hardened Runtime. No systemd directives and no `MemoryDenyWriteExecute`. | Windows service plus a named pipe with a security descriptor/ACL; service SID, restricted token, job object or AppContainer. There is no `MemoryDenyWriteExecute`; the named-pipe ACL is transport, not policy. |
| 9. SELinux | No SELinux. App Sandbox, TCC and EndpointSecurity are different mechanisms; TCC is user consent, not a same-UID separation. | No SELinux. AppLocker/WDAC and integrity levels are the closest; a same-user, same-integrity process can still open the object. |
| 10. Verification | `scripts/hardening-check.sh` is Linux/POSIX sh; on macOS the Linux-only probes are `UNKNOWN`. Do not claim it passed. | POSIX sh in WSL is a Linux guest, not the Windows host boundary. Use native PowerShell checks; do not claim parity with this script. |

A macOS or Windows deployment can be hardened in its own terms, with its own
probes and its own policy-enforcing signer. It cannot inherit the Linux
guarantees above, and this runbook does not provide a parity claim.

## 15. Rollback order (reverse of the deployment)

Roll back in reverse dependency order: stop the thing that uses a path before
removing the path. There is one deliberate exception to a strict numeric
reverse: remove the audit rules **before** deleting the watched key, approval
and signer paths, because `augenrules --load` refuses a watch on a missing path.

1. **Verification (step 10):** nothing to roll back.
2. **SELinux (step 9):** remove the custom module and fcontext entries, then
   `restorecon`; do not use `setenforce 0`.
3. **Units (step 8):** disable the socket, stop instances, remove the unit
   files, `daemon-reload`, `reset-failed`, remove `/run/teamwork-signer`.
4. **Signer code (step 7):** restore the previous binaries or remove them; do
   not leave a user-writable copy.
5. **Audit (step 5):** remove the rules file and reload **before** deleting the
   watched paths; export the log first if it is evidence.
6. **Users/directories (step 6):** archive keys and approvals, then remove the
   users/groups and directories. Keep the public keys and old signatures for
   verification.
7. **hidepid (step 4):** remount with the baseline options and remove the
   `fstab` line.
8. **ptrace (step 3):** remove the sysctl file and restore the baseline value.
9. **Groups (step 2):** re-add only the groups the workload actually needs,
   then terminate sessions and log in again.

### If you must undo

Remove the signer configuration from the workload first: point it back at its
previous key source, or unset `OPENCODE_TEAMWORK_SIGNER`. A configured but
unavailable signer fails every signed write closed.

```sh
# 9. SELinux (only if you added the module/labels).
sudo semodule -r teamwork_signer 2>/dev/null || true
sudo semanage fcontext -d "$SIGNER" 2>/dev/null || true
sudo semanage fcontext -d "$CLIENT" 2>/dev/null || true
sudo semanage fcontext -d "$KEY_DIR(/.*)?" 2>/dev/null || true
sudo semanage fcontext -d "$APPROVAL_DIR(/.*)?" 2>/dev/null || true
sudo restorecon -Rv "$KEY_DIR" "$APPROVAL_DIR" "$SIGNER" "$CLIENT" 2>/dev/null || true

# 8. Units.
sudo systemctl disable --now teamwork-signer.socket
sudo systemctl stop 'teamwork-signer@*' 2>/dev/null || true
sudo rm -f /etc/systemd/system/teamwork-signer.socket /etc/systemd/system/teamwork-signer@.service
sudo systemctl daemon-reload
sudo systemctl reset-failed 'teamwork-signer@*' 2>/dev/null || true
sudo rmdir /run/teamwork-signer 2>/dev/null || true

# 7. Signer code: restore the previous binaries, or remove the installed ones.
# sudo install -m 0755 -o root -g root /path/to/previous-signer "$SIGNER"
sudo rm -f "$SIGNER" "$CLIENT"
sudo rmdir /usr/local/libexec/teamwork 2>/dev/null || true

# 5. Audit (before deleting the watched paths).
sudo rm -f /etc/audit/rules.d/90-teamwork.rules
sudo augenrules --load
sudo auditctl -l | grep teamwork || true

# 6. Users and directories. Archive first; deleting keys stops new signatures.
sudo gpasswd -d "$WORKLOAD_USER" "$CLIENT_GROUP" 2>/dev/null || true
sudo gpasswd -d "$WORKLOAD_USER" "$APPROVAL_GROUP" 2>/dev/null || true
sudo gpasswd -d "$WORKLOAD_USER" "$SIGNER_APPROVAL_GROUP" 2>/dev/null || true
sudo userdel "$SIGNER_USER" 2>/dev/null || true
sudo userdel "$APPROVER_USER" 2>/dev/null || true
sudo groupdel "$SIGNER_GROUP" 2>/dev/null || true
sudo groupdel "$CLIENT_GROUP" 2>/dev/null || true
sudo groupdel "$APPROVAL_GROUP" 2>/dev/null || true
sudo groupdel "$SIGNER_APPROVAL_GROUP" 2>/dev/null || true
sudo rm -rf "$KEY_DIR" "$APPROVER_KEY_DIR" "$APPROVAL_DIR" /etc/teamwork

# 4. hidepid.
sudo mount -o remount,hidepid=0 /proc
# remove the proc line from /etc/fstab, then:
sudo systemctl daemon-reload

# 3. ptrace.
sudo rm -f /etc/sysctl.d/90-teamwork-ptrace.conf
sudo sysctl -w kernel.yama.ptrace_scope=0   # use the baseline value

# 2. Groups: re-add only what you removed; a fresh login is mandatory.
# sudo gpasswd -a "$WORKLOAD_USER" docker
sudo loginctl terminate-user "$WORKLOAD_USER" 2>/dev/null || true
```

**If you must undo, read this first.**

- **Remove the signer configuration before you disable the service.** A
  configured but unavailable signer fails every signed write closed with
  `AUTH_SIGNER_UNAVAILABLE`; that is by design, not a bug. Point the plugin back
  at its previous key source, or unset `OPENCODE_TEAMWORK_SIGNER`, before the
  service goes away.
- **Do not delete the public keys.** Old artifacts verify with the public key
  after the private key is gone. Deleting the public key removes the ability to
  verify history.
- **A rollback does not un-sign artifacts.** Artifacts already signed remain
  valid to a verifier that trusts the signer key. If you rotate or discard the
  key, update the verifier's trust store deliberately.
- **Restoring group membership needs a fresh login.** Running processes retain
  the old supplementary groups; `loginctl terminate-user` or a reboot is the
  reliable reset.
- **Restoring `ptrace_scope=0` reopens memory/environment exposure.** Do it
  only because you are returning to the lower-assurance profile, not as a
  debugging shortcut.
- **Removing audit rules removes detection.** Export or forward the audit log
  before deleting rules if it is evidence.
- **Do not use `setenforce 0` as a rollback.** Fix the label or remove the
  custom policy; permissive mode hides the problem.
- **A signer policy is not undone by removing a unit.** Approvals and signatures
  remain. If the approval private key was compromised, rotate the approver key
  and re-issue approvals; removing the service does not make old approvals
  invalid.

## 16. What this runbook still does not verify

- That the signer binary is the reviewed binary. Root-owned code is not a
  reproducible-build proof; compare a hash or signature out of band.
- That the signer's policy is correct. Read the source and run the tests in
  [SIGNER-PROTOCOL.md](SIGNER-PROTOCOL.md).
- That the approval key holder is a human, or that the human read the bytes.
- That the plugin, prompts, model or external verifier are unmodified.
- That an artifact accepted today is still true tomorrow. Re-execution and
  external review remain necessary.

**Again: no step in this document was executed on the documentation host.**
