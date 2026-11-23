# ADR 0006: Artifact Trust Isolation — Can a Same-UID Shell Be Stopped?

- **Status:** Proposed (Phase B decision) — recommended: accept and document for Sprint 2.1
- **Date:** 2026-11-22
- **Scope:** ADR 0005, `plugins/opencode-teamwork/auth.ts`, plugin storage, permission hooks, deployment
- **Related:** ADR 0004, ADR 0005, `docs/spikes/auth-isolation-feasibility.md`

## 1. Context

ADR 0005 makes control-plane artifacts tamper-evident against a writer who is
limited to the run directory. It deliberately does **not** protect against a
same-UID process that can read the HMAC key from the OpenCode KV database
(`~/.local/share/opencode/opencode.db`). This ADR asks the Phase B question:

> Can Teamwork protect a completion verdict against a shell that runs as the
> same OS user as OpenCode, can read `opencode.db`, and can call the same tools
> the agent can call?

The answer is not a choice of HMAC vs. Ed25519. The hard part is that the
attacker and the agent share a UID. Any secret the agent can use, the shell can
read; any signer the agent can call, the shell can call; any gate the agent
runs, the shell can edit. This ADR evaluates the realistic ways to create a
*separate* decision domain, and decides whether any of them is worth shipping
now.

### Evidence labels

- **OBSERVED** — probed on the review host or read out of the OpenCode v2.3.2
  binary/API. Reproductions are in `docs/spikes/auth-isolation-feasibility.md`.
- **INFERRED** — reasoned from observed facts or documented behaviour, not
  directly executed.
- **UNKNOWN** — not verified; do not build a security claim on it.

### Host snapshot (2026-11-22)

| Fact | Value | Label |
| --- | --- | --- |
| OS / kernel | Fedora 46 (prerelease), Linux 7.4.0-rc3 | OBSERVED |
| OpenCode | v2.3.2 (`/home/linuxbrew/.linuxbrew/bin/opencode`) | OBSERVED |
| Node used by the binary | v26.13.1 | OBSERVED |
| User | `john`, UID/GID 1000 | OBSERVED |
| DB | `~/.local/share/opencode/opencode.db`, mode `0600`, owner `john:john` | OBSERVED |
| Plugin storage | `kv` table, plain `text` values, keys such as `plugin:<id>:...` | OBSERVED |
| `auth/key/ring` | absent (0 rows) on this host; no signed run has been created here | OBSERVED |
| `ptrace_scope` | `0` (classic ptrace; `/proc` is not `hidepid`) | OBSERVED |
| `sudo -n` | fails: "a password is required" | OBSERVED |
| systemd | 262, user manager active, `Linger=yes` for `john` | OBSERVED |
| Sandbox primitives | `bwrap`, `unshare`, `podman`, `docker`, user namespaces available | OBSERVED |

The practical conclusion is simple: on this host the key is readable by the
same user that runs the agents, and the shell is not a weaker principal than
the agent.

## 2. Threat Model

### 2.1 Attacker capabilities

The attacker is a shell (or small program) running as UID 1000. It may be the
user's own terminal, a prompt-injected sentinel with `shell`, a `git` hook, a
test process, or `opencode run --agent ...`.

| Capability | Evidence | Consequence |
| --- | --- | --- |
| Read `opencode.db` and the `kv` table | DB is mode `0600`, same UID; `kv.value` is `text` | Reads the HMAC key ring and the digest index |
| Read `/proc/<pid>/environ` and `/proc/<pid>/mem` of same-UID processes | `ptrace_scope=0`; `/proc` has no `hidepid` | Reads env secrets, in-memory keys, typed passphrases |
| Write `ctx.storage` | Same DB, same UID | Rewrites `auth/run/<run>/...` index entries |
| Edit user config and installed plugin files | `~/.config/opencode` is user-owned; config mode `0644` | Disables or rewrites the gate itself |
| Run `opencode run --agent` and `opencode run --auto` | `opencode run --help` lists both | Starts sessions and auto-approves permission requests |
| Create a child session through the API | `POST /api/session` accepts `parentID` and `agent` | Can manufacture a "descendant" verifier session |
| Read run artifacts | Run dir is user-owned | Learns `rootSessionId`, file paths, hashes |
| Delete or truncate the run | Same UID | Denial of service (out of authenticity scope) |

The `teamwork_report` gate (caller must be `team/verifier` and a descendant of
the plan-time `rootSessionId`) is a useful defence against a casual
`opencode run --agent team/victory-auditor`, but it is **not** a same-UID
boundary: a shell can read `rootSessionId` from `run.manifest.json` and create a
child session with `parentID=<root>` and `agent=team/verifier` [OBSERVED API
schema; INFERRED attack]. This ADR does not rely on session labels as a
security domain.

### 2.2 Attack paths

1. **Direct forgery.** Read the key ring from `kv`, canonicalise a payload, and
   mint a valid `_auth` envelope. Also rewrite the digest index so the artifact
   and index agree.
2. **Signing oracle.** If a helper, socket, or remote KMS signs whatever the
   agent asks, the shell asks it to sign the same payload. Moving the key out
   of the DB does not remove the ability to obtain a signature.
3. **Session spoof.** Create a child session under the recorded root, select
   `team/verifier`, and call `teamwork_report` with `PASS` [INFERRED from the
   observed `POST /api/session` shape].
4. **Gate tamper.** Edit `~/.config/opencode`, the plugin source, the agent
   prompt, or the installed package so `next`/`final_verify` no longer checks
   signatures. No in-process authenticity control survives this.
5. **Memory/env capture.** Read a passphrase or in-memory key from a same-UID
   process. This defeats "prompt for a passphrase at plan/final" as a
   same-UID defence on this host (`ptrace_scope=0`).

### 2.3 Goals and non-goals

**Goal:** a completion verdict (`victory.json`, `final.json`, and the plan
baseline) cannot be forged or downgraded by a process running as the agent's
UID, even if it can read the DB and call OpenCode tools.

**Non-goals:** protecting against root, a malicious kernel/OpenCode binary, a
compromised model provider, physical access, or deletion/DoS. Those are outside
any in-process artifact-authenticity control.

## 3. Options

Ratings are relative to the same-UID attacker above: **none**, **low**,
**medium**, **high**.

| Option | Feasible on this host | Effort | Portability | Stops same-UID shell? | Verdict |
| --- | --- | --- | --- | --- | --- |
| A. Separate-UID / external signer | Yes, with one-time admin (`sudo` password required) | M–L | Poor (systemd/launchd/Windows service) | **Low alone** (signing oracle); medium/high with a policy + human gate | Useful substrate, not a fix by itself |
| B. OS isolation / container / namespace | Primitives exist; plugin cannot place agents | L | Poor | High for DB/key reads; not for a reachable signer or writable repo | Deployment pattern, out of plugin scope |
| C. Remote / HSM / KMS signing | HTTP is portable; TPM exists but needs admin/group; no `ykman` | M–L | Good (HTTP), poor (local HSM) | **Medium/high only if** the credential/approval is outside the UID | Best cross-platform direction, conditional |
| D. Human-held approval/key | `ctx.permission.assert` exists; `--auto` auto-approves | S–M | Good (UI), platform-specific (hardware) | **Low alone**; medium/high with a hardware token + digest binding | Advisory only as-is; necessary complement |
| E. Accept + document | Trivial | S | N/A | None (by design) | **Selected for Sprint 2.1** |

### 3.1 Option A — Separate-UID / external signer

**Design.** A small signer runs as a different OS user (`teamwork-signer`),
owns an Ed25519 private key, and exposes `sign` over a Unix socket or a CLI.
The plugin reaches it with Node built-ins (`node:net` or `node:child_process`);
no runtime dependency is required. The run directory carries the public key, so
verification no longer needs the secret. An HMAC key cannot be isolated on its
own: verification needs the same key, so the agent would still hold it. Phase B
must switch to asymmetric signatures (or make every verification an IPC call to
the signer, which is a worse availability trade).

**Linux requirements.**

- A dedicated system user. `useradd --system --no-create-home --shell
  /usr/sbin/nologin teamwork-signer` requires root. On this host `sudo -n`
  fails and `useradd` is root-owned [OBSERVED], so this is a one-time
  administrator action, not something the plugin can do.
- A systemd **system** service, or a user service for the signer UID with
  lingering. A `systemd --user` unit owned by `john` is useless: John's shell
  can stop it, read its environment, or replace its unit file.
- Directories: `/var/lib/teamwork-signer` mode `0700` owned by the signer;
  private key mode `0600`. A socket under `/run/teamwork-signer/` mode `0660`
  owned `teamwork-signer:teamwork`, with the agent's user in `teamwork`.
  systemd socket activation (`teamwork-signer.socket` with `SocketMode=0660`,
  `SocketUser=`, `SocketGroup=`) is the cleanest way to create it with the
  right ownership; it does not solve the policy problem below.
- A `sudoers` `NOPASSWD` rule for a sign CLI is **not** a boundary: the shell
  can run the same command. Use sudo only for installation; per-signature sudo
  is a signing oracle.
- Hardening: `NoNewPrivileges=yes`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `PrivateTmp=yes`,
  `RestrictAddressFamilies=AF_UNIX`, `MemoryDenyWriteExecute`,
  `SystemCallFilter=@system-service`. A sample unit passes
  `systemd-analyze --user verify` [OBSERVED], but the real unit should be
  system-level.
- SELinux is `Enforcing` [OBSERVED]; a cross-UID socket and key directory need
  correct labels, or the signer will be denied.

**The blocking problem: a socket signer is a signing oracle.** The agent and
the shell are the same UID. If the socket admits the agent, it admits the
shell. Node's `net` module does not expose `SO_PEERCRED`
(`net.Socket.prototype.getPeerCredentials` is `undefined`) [OBSERVED], and
Linux peer credentials would only name UID 1000 for both processes anyway.
Default Unix socket mode from Node is `0755` (umask-dependent)
[OBSERVED], so it must be tightened, but no socket permission can distinguish
the agent from the shell. A signer that signs caller-supplied payloads simply
moves the key; it does not stop the forgery.

**What would make it work.** The signer must enforce a policy the shell cannot
satisfy:

- **Human-presence gate:** sign only after a human approves the exact
  `(runId, path, digest)` through a channel the agent does not control (a
  hardware token touch/PIN, a separate signer UI, or a remote KMS with MFA).
- **Independent verification:** the signer recomputes the verdict from evidence
  the agent UID cannot rewrite (for example, a read-only CI mirror or a
  separate test runner), rather than signing a caller-supplied verdict.

A signer that only checks the schema, path allowlist, and session label is
still forgeable by a prompt-injected verifier and by the shell.

**macOS / Windows.** macOS needs a LaunchDaemon (or a signed helper) and a
separate `_teamwork` user; the Keychain is not a UID boundary by itself. Windows
needs a service account and a named pipe with an ACL; peer identity is
available through the Win32 named-pipe API but not through Node's built-in
`net` module. Both require platform-specific packaging and admin installation.
**UNKNOWN:** no macOS/Windows probing was performed.

**Verdict.** Feasible on Linux with administrator help, but not sufficient
alone. It is the right *substrate* for a policy-enforcing signer, not a fix.

### 3.2 Option B — OS isolation (container, user namespace, read-only mounts)

**Primitives on this host.** `bwrap`, `unshare`, `podman`, and `docker` are
installed; `unshare --user --map-root-user --net true` and a `bwrap` smoke test
both exit 0; `/etc/subuid` and `/etc/subgid` have ranges [OBSERVED]. SELinux is
`Enforcing` [OBSERVED].

**The plugin cannot place agents.** OpenCode v2.3.2's plugin context exposes
`agent`, `command`, `event`, `integration`, `mcp`, `permission`, `plugin`,
`reference`, `rpc`, `skill`, `storage`, `tool`, `experimental.terminal`, and
similar hooks [OBSERVED from the binary], but no process-placement, sandbox,
namespace, or mount API. The plugin can deny `shell` for specific agents; it
cannot run them in a different namespace. OpenCode itself is launched by the
user, and the team agents run inside that process with the user's privileges
(`docs/GUARDRAILS.md`, "No sandbox for shell").

**A deployment pattern that could work.** Run the whole OpenCode process under
`bwrap`/`podman` with the home directory read-only, the OpenCode data directory
not mounted (or mounted read-only), and only the repo and
`.opencode/teamwork/` writable. The signer runs outside the sandbox. Then a
shell inside cannot read the host DB or key. Limits: the signer socket must be
reachable from inside, and the shell inside can call it; the repo is writable,
so the agent's evidence can still be changed; the UX and packaging burden is
large; and the plugin cannot enforce the pattern.

**macOS / Windows.** macOS `sandbox-exec` is deprecated and does not provide
the same mount story; containers are possible but heavier. Windows AppContainer
/ job objects are possible but not controllable from the plugin. **UNKNOWN**
for both.

**Verdict.** The strongest host-level containment, but a deployment/launcher
change, not a plugin change. Out of scope for this sprint; document it as an
option for high-assurance deployments.

### 3.3 Option C — Remote / HSM / KMS signing

**Design.** The signer is an HTTP service (cloud KMS or a small remote
service) holding an asymmetric key. The plugin sends the canonical digest and
receives a signature; verification uses the public key offline. Node's built-in
`fetch` means zero runtime dependencies.

**Trust, network, and availability costs.**

- **Network dependency.** Signing requires egress. If a run's
  `constraints.network` is `denied`, or the host is offline, signing fails. It
  must fail closed, which blocks completion; caching signatures defeats the
  point. This is an availability regression for a local-first tool.
- **Credential location.** If the KMS credential is in env/config, the
  same-UID shell can read it and call KMS directly. Instance roles on a cloud
  VM are available to every process on the VM, including the shell. A
  credential that is genuinely outside the UID (hardware token, MFA-backed
  session) is required; otherwise this is the same signing oracle over HTTPS.
- **Policy.** A KMS key policy can restrict algorithms and key IDs, but not
  "the verifier process". Unless the policy requires MFA/human presence, the
  shell can sign any digest the agent can. A remote CI verifier that
  independently runs tests and signs the result is stronger, but that is a
  different product surface.
- **Privacy/latency/cost.** Only digests leave the host, but every control
  plane write becomes a network round trip; outages and quotas become gate
  failures; per-signature cost and audit logs appear. That may be acceptable
  for `final.json`/`victory.json`, not for every report.
- **Local HSM/TPM.** `/dev/tpmrm0` exists (`root:tss`, mode `0660`) but `john`
  is not in `tss`; `tpm2_sign`, `pkcs11-tool`, `openssl`, `gpg`, `age`, and
  `ssh-keygen` are installed; `ykman` is missing [OBSERVED]. A TPM key can be
  non-exportable, but without a PIN/authorization policy the shell can use it
  too. A per-signing human PIN is the meaningful control, and that is Option D.
  Node has no TPM API; a CLI (`tpm2_sign`) or PKCS#11 module is needed, which
  adds a platform dependency.

**Verdict.** The best cross-platform direction **if** combined with an
MFA/human-presence policy or an independent remote verifier. As a plain
"sign this digest" API authenticated by a credential on the same host, it is
another signing oracle.

### 3.4 Option D — Human-held approval / key

**What is available.** OpenCode v2.3.2 exposes `ctx.permission.assert(...)` to
plugins [OBSERVED in the binary]. The schema is
`{sessionID, agent, action, resources, save, metadata, source}`. Core
`Permission.assert` denies on a deny rule (`Permission.BlockedError`), returns
on an allow rule, and otherwise creates a permission request and blocks until
the human replies; a decline raises `Permission.DeclinedError`, and a
correction path exists. `tool.execute` receives a `sessionID`, so a plugin can
call it at plan and final time.

**What it protects.** A human sees a request and must approve it. If the gate
requires an approval record bound to the exact artifact digest, a passive
forger cannot produce the approval, and a prompt-injected agent cannot complete
the run silently. It also gives the human a chance to inspect the verdict.

**What it does not protect.**

- `ctx.permission.assert` is not a secret. A same-UID shell can call it itself.
  The approval is a UI event, not a capability.
- `opencode run --auto` "auto-approve[s] permissions that are not explicitly
  denied" [OBSERVED help text], and the binary auto-replies
  `decision: "once"` when the auto flag is set [OBSERVED]. The UI also exposes
  a `session.permissions` mode of `autoaccept` [OBSERVED config strings]. A
  shell can therefore satisfy the prompt without a human.
- The approval record lives in the same DB/kv, or in memory; the shell can
  forge or rewrite it.
- A user can be socially engineered into approving a payload if the prompt
  shows only an action name. The request must display the run, path, and
  digest, and the approval must be bound to them.
- It does not protect the HMAC key. The shell can still mint envelopes; a gate
  that checks only "signed" still passes.
- A passphrase prompt at plan/final (if one were added) would be readable from
  process memory on this host (`ptrace_scope=0`) [OBSERVED], and it may be
  stored in shell history or the DB. A passphrase is not a strong same-UID
  boundary.
- It does not stop a shell that edits the plugin/config or bypasses the gate.

**What would make it meaningful.** A **non-auto-approvable** action (explicitly
denied by default, with a deliberate human override that the agent cannot
toggle), bound to `(runId, path, digest)`, surfaced with the digest in the
prompt, and recorded in a domain the agent UID cannot rewrite (for example, a
hardware token signature or a remote witness). Even then, replay must be
prevented by including a per-run nonce.

**Verdict.** As shipped, `ctx.permission.assert` is an advisory speed bump, not
a security boundary. It is a necessary complement to a signer, not a
replacement for one.

**Rejected variant: OS keychain.** libsecret/Secret Service, macOS Keychain,
and Windows Credential Manager protect secrets at rest, but a same-UID process
can usually ask the unlocked keychain for the secret. They do not create a
separate privilege domain and are not evaluated further.

### 3.5 Option E — Accept and document

State the boundary exactly: Phase A is tamper-evident against a run-dir-only
writer; it is not protection against a local user, a same-UID shell, a
prompt-injected agent with shell access, or a modified plugin. Do not claim
"tamper-proof", "trusted signature", or "safe against a local attacker". The
wording is in §7.

This costs nothing, adds no dependency, works on every platform, and is honest.
Its only "cost" is that the residual risk remains.

## 4. Decision

**Select Option E for Sprint 2.1: accept the Phase A boundary and document it.
Do not implement key isolation in this sprint.**

Specifically:

1. **Reject a bare separate-UID signing oracle.** A helper that signs arbitrary
   caller-supplied payloads is not a security improvement; it adds packaging
   and an availability dependency while leaving the same forgery possible.
2. **Reject `ctx.permission.assert` as a security control.** It is
   auto-approvable under `--auto`, is not a secret, and is recorded in the same
   privilege domain. It may be added later as an advisory prompt, clearly
   labelled.
3. **Reject the OS keychain as a same-UID boundary.** It protects at rest only.
4. **Keep the envelope Phase B-compatible.** ADR 0005's canonical JSON, path
   binding, digest index, and `_auth` shape are retained. A future Ed25519
   signer changes `alg`, `keyId`, and the signature field, not the artifact
   payloads.

**If Phase B is later funded, the only design worth building is:**

- an **asymmetric** (Ed25519) signature with the private key in a different
  privilege domain (separate UID or remote KMS/HSM), so the run directory and
  verifier only need the public key; **and**
- a signing policy that is not an oracle: a human-presence gate bound to
  `(runId, path, digest)` **or** an independent verifier that recomputes the
  verdict from evidence the agent UID cannot rewrite; **and**
- a fail-closed path when the signer is unavailable, with a named failure code
  (for example `AUTH_SIGNER_UNAVAILABLE`); **and**
- a cross-platform story (Linux systemd, macOS launchd, Windows service/pipe)
  or an explicit "Linux-only, fail closed elsewhere" statement.

A sensible order, if funded: (1) Ed25519 envelope and public-key verification
(small, useful, no deployment change); (2) an out-of-process signer interface
with a no-oracle policy and fail-closed behaviour; (3) a human-presence gate
for `victory.json`/`final.json`; (4) optional OS-isolation deployment docs.
Do not ship step (2) without the policy in step (3) or an independent verifier.

### Exact missing primitive

> **A signing decision the agent's UID cannot make.**

OpenCode v2.3.2 exposes no plugin API for process placement or sandboxing, no
per-process credential that a same-UID shell cannot read or replay, and no
non-auto-approvable human approval bound to an artifact digest. The missing
piece is either (a) a human-presence-gated signing operation bound to
`(runId, path, digest)`, or (b) a verifier in a different privilege domain that
independently derives the verdict from evidence the agent UID cannot rewrite.
Until one of those exists, moving the key is not enough.

## 5. Acceptance tests for a future implementation

These are specifications for the Phase B work, not tests added in this
docs-only sprint. Each test must run as the agent UID (UID 1000) unless stated.

1. **Same-UID forgery.** Read the DB/kv, extract the key (or call the signer
   socket), mint `verify/victory.json` with `VICTORY CONFIRMED`, and call
   `teamwork_next`. The gate must not return `ALL_PASSED`; it must name a
   refusal. Under Phase A this test currently demonstrates the documented
   residual (the forgery succeeds); the test records the expected Phase B
   change.
2. **Signing-oracle refusal.** Send an arbitrary digest for an unapproved
   `(runId, path)` to the signer. The signer must refuse; it may not sign just
   because the caller is UID 1000 or presents a valid session label.
3. **Auto-approval.** Run `opencode run --auto --agent team/verifier` (or set
   `session.permissions=autoaccept`) and attempt a final approval. The gate
   must not treat an auto-approved request as human approval. If the design
   uses `ctx.permission.assert`, the test documents that it is advisory only.
4. **Session spoof.** Create a child session with `parentID=<rootSessionId>`
   and `agent=team/verifier`, then call `teamwork_report` with `PASS`. A
   policy-enforcing signer must still refuse to sign a final verdict without
   its independent check or human approval.
5. **Signer unavailable.** Stop the signer and call `teamwork_plan` /
   `final_verify`. Both must fail closed with a named code and must not write
   an unsigned success artifact.
6. **Offline / network denied.** With the network denied or the host offline,
   signing fails closed; verification with the public key still succeeds for
   already-signed artifacts.
7. **Rotation.** Rotate the signer key; old artifacts verify with the old
   public key; new writes use the new key; the private key never appears in the
   DB, the run dir, or an environment variable visible to the agent.
8. **Index tamper.** Rewrite `auth/run/<runId>/<path>` in `kv` and present a
   matching artifact. A remote witness or signer-side state must detect it, or
   the test records the residual.
9. **Plugin tamper.** Modify the installed plugin/config as the agent UID and
   confirm the gate can be bypassed. This is expected to fail until the gate
   runs outside the agent's UID; the test documents the boundary.
10. **Cross-platform.** On macOS/Windows, a missing signer must fail closed
    with a named "unsupported" code; there must be no silent fallback to an
    in-process HMAC key.

## 6. Consequences

### Positive (Option E)

- No new runtime dependency, daemon, packaging, or deployment step.
- No false sense of security from a key that a same-UID shell can still use via
  a signing oracle.
- Works on every platform and in offline/air-gapped runs.
- The Phase A envelope and artifact shapes remain valid for a future Ed25519
  signer.

### Negative

- The same-UID residual remains: a local user can forge a verdict, rewrite the
  index, edit the plugin, or spoof a session.
- Users who need a real trust boundary must use OS isolation or an external
  verifier, which the plugin does not provide.
- Any future Phase B work is a larger product/deployment change than a
  key-store swap.

### Residual risks (all accepted under Option E)

- **DB/key readable.** `opencode.db` is mode `0600` but owned by the agent's
  UID; `kv` is plaintext. The key ring, when created, is readable. `-wal` and
  `-shm` files and backups have the same exposure.
- **Index rewritable.** `ctx.storage` is the same `kv` DB, not a separate
  privilege domain. An attacker can rewrite both artifact and index.
- **Plugin/config tamper.** The installed plugin, agent prompts, and
  `opencode.json` are user-owned. A same-UID shell can disable the gate.
- **Session spoof.** `POST /api/session` accepts `parentID` and `agent`
  [OBSERVED]; the descendant check is not a same-UID boundary.
- **Memory/env capture.** `ptrace_scope=0` and readable `/proc` let a same-UID
  process capture in-memory keys, passphrases, and env secrets.
- **Prompt-injected verifier.** A verifier agent that is itself compromised can
  call `teamwork_report` with `PASS`; key isolation does not fix agent
  integrity. The signer must independently verify or require a human.
- **Root/admin.** Root can read any key, ptrace any process, and edit any gate.
- **Model/provider and transcripts.** Untrusted content can exfiltrate secrets
  through prompts or tool output; this ADR is about verdict authenticity, not
  confidentiality.
- **Availability.** A same-UID shell can delete or truncate the run. Authenticity
  is about accepting a verdict, not keeping the service up.

## 7. Documentation wording

If Option E is ratified, use this text (or equivalent) so the boundary is not
softened by marketing.

**`docs/GUARDRAILS.md`, "Known gaps / non-goals":**

> **Artifact authenticity is tamper-evident, not local-user-proof.** The HMAC
> key is stored in the OpenCode KV database (`opencode.db`, mode `0600`) under
> the same UID that runs agents. Any same-UID shell can read the key, mint a
> valid `_auth` envelope, and rewrite the digest index. Phase A therefore stops
> a run-directory-only writer, not a local user or a prompt-injected agent with
> shell access. OpenCode v2.3.2 gives the plugin no process-placement/sandbox
> API, no per-process credential that a same-UID shell cannot read or replay,
> and no non-auto-approvable human approval bound to an artifact digest.
> Phase B options are assessed in ADR 0006, which selects "accept and document"
> until one of those primitives exists. Do not describe artifacts as
> tamper-proof, signed by a trusted authority, or safe against a local user.

**`README.md`, "Security":**

> Artifact authenticity is Phase A: signed control-plane artifacts are
> tamper-evident against a writer limited to the run directory. They are **not**
> protected against a same-UID process: the HMAC key lives in `opencode.db`
> (mode `0600`, same user) and a local shell can read it and mint valid
> envelopes. Phase B options and the decision to accept this boundary are in
> [`docs/adr/0006-artifact-trust-isolation.md`](docs/adr/0006-artifact-trust-isolation.md).

**`docs/ARTIFACTS.md`, the existing boundary note:** append "See ADR 0006 for
why key isolation is not a same-UID fix and for the accepted residual."

## 8. References

- ADR 0004: intermediate symlink races and the run-read containment boundary.
- ADR 0005: artifact authenticity, Phase A decision and Phase B options.
- `docs/GUARDRAILS.md`: controls, known gaps, "No sandbox for shell".
- `plugins/opencode-teamwork/auth.ts`: key ring, canonical JSON, HMAC envelope,
  digest index.
- `docs/spikes/auth-isolation-feasibility.md`: read-only host probes behind the
  OBSERVED claims in this ADR.
