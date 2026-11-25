# ADR 0016: Re-executable Verification

- **Status:** Accepted (0.16.0)
- **Date:** 2026-11-24
- **Scope:** `plugins/opencode-teamwork/tools.ts`, `lib/verify.mjs`,
  `bin/opencode-teamwork.mjs`, `scripts/test-verify.mjs`,
  `scripts/test-engine.mjs`, `docs/ARTIFACTS.md`, `SECURITY.md`, `README.md`
- **Extends:** [ADR 0015](0015-offline-verification.md) (offline relation
  verification), [ADR 0012](0012-evidence-binding-and-contradiction-detection.md)
  (evidence binding), [ADR 0005](0005-artifact-authenticity.md) (envelope)
- **Related:** [ADR 0013](0013-containment-parity-and-the-detective-boundary.md)
  (read/write containment), [ADR 0006](0006-artifact-trust-isolation.md) (one
  UID is not a boundary)

## 1. Context

0.15.0 could authenticate a verifier report and recompute every relation around
it, but a `PASS` check was still an observation: `output` plus `outputSha256`
could be invented and signed consistently. The documented residual was that a
false report passes every offline check because nothing re-executes it.

The obvious next step is not "make the engine run the verifier's commands". The
engine runs with the author's UID, inside the run's control plane, and a command
recorded by the verifier can write anywhere that UID can. That would move the
problem, not solve it. Re-execution belongs to the verifier, against a clean
checkout of the commit the verifier actually observed.

## 2. Decision

### 2.1 checks[] v2

A verifier report check may declare re-executable evidence:

```json
{
  "name": "npm test",
  "type": "programmatic",
  "passed": true,
  "exitCode": 0,
  "output": "73 suites green\n",
  "outputSha256": "<keyed digest of output>",
  "command": ["npm", "test", "--silent"],
  "cwd": ".",
  "commandSha256": "<unkeyed sha256 of canonical {argv,cwd}>",
  "outputBytes": 15,
  "outputTruncated": false,
  "durationMs": 8421
}
```

`command` is argv only, at most 32 arguments. A shell interpreter followed by
`-c` (or `cmd /c`) is refused: a shell line turns argv back into arbitrary code
and defeats the point of recording an argv. `cwd` is relative to the worktree.
The engine computes `commandSha256 = contentSha256Hex(canonicalJson({argv,
cwd}))`, `outputBytes`, `outputTruncated`, and the existing keyed
`outputSha256`. `passed` must equal `exitCode === 0`.

A check without `command` keeps the 0.15 shape. A `type: "review"` check is
prose and may omit one.

### 2.2 Manifest version 4

`run.manifest.json` version 4 adds `requiredProvenance: "declared" | "command"`.
Versions 1–3 are read as `declared`; their plan hash and meaning are unchanged.
A re-plan may upgrade `declared → command`, never downgrade it (`AUTH_STALE`),
and `final_verify` re-checks the signed value.

Under `command`:

- every `type: "programmatic"` check in a `PASS` report must declare a command;
- a `PASS` needs at least one untruncated programmatic command check;
- the report must carry `headSha`, because a command with no commit cannot be
  re-executed (`REPORT_UNBOUND`);
- `teamwork_report` writes a signed `verify/rerun.json`;
- `final_verify` stamps `evidence.rerunDigest`.

The engine never executes a command. `teamwork_report` records the verifier's
observation; `final_verify` checks the shape and the signed projection.

### 2.3 verify/rerun.json

```json
{
  "version": 1,
  "sessionId": "20261124-120000-abcd",
  "tasks": {
    "R1": {
      "checks": [
        {
          "name": "npm test",
          "argv": ["npm", "test", "--silent"],
          "cwd": ".",
          "expectedExit": 0,
          "outputSha256": "<unkeyed sha256 of stdout+stderr>",
          "outputBytes": 15,
          "timeoutMs": 120000
        }
      ]
    }
  },
  "generatedAt": "ISO8601",
  "_auth": { "v": 1, "alg": "ed25519", "keyId": "ed_...", "path": "verify/rerun.json", "digest": "sha256", "sig": "base64url", "nonce": "base64url", "at": "ISO8601" }
}
```

The record is merged per task and re-signed by `teamwork_report`; an existing
record's envelope is verified before it is extended, so a re-report cannot
launder a tampered re-execution record. A check whose capture is truncated is
kept as display evidence but is not recorded as re-executable.

`final_verify` refuses a missing record under `command`, an invalid envelope,
a record that no longer mirrors the report's command checks, or a task no report
claims (`AUTH_STALE`/`AUTH_INVALID`). It stamps `evidence.rerunDigest` (keyed
digest of the file bytes), so editing `verify/rerun.json` after the verdict is
`AUTH_STALE` offline.

### 2.4 verify --rerun

```
opencode-teamwork verify ... --rerun --repo <clean-checkout>
                       [--timeout <s>] [--keep-worktree]
```

1. Verify the signed manifest, the reports and `verify/rerun.json`. Before any
   worktree is created or any command is spawned, all four must hold: the
   manifest is present and authenticated; `verify/rerun.json` authenticates;
   every report the rerun record names authenticates; and the rerun record
   matches the report projection. A failure emits `rerun:trust` /
   `RERUN_UNTRUSTED` (or the underlying `AUTH_*`) and executes nothing.
   `--allow-unsigned` is a legacy-only concession and is refused as a usage
   error with `--rerun`.
2. For each recorded task, take `report.headSha` and create a detached worktree
   at that commit (`git worktree add --detach`). Missing `headSha` is
   `REPORT_UNBOUND`.
3. Run the recorded argv with `spawnSync` — no shell, `env` reduced to `PATH`,
   `HOME`/`TMPDIR` inside a scratch directory, `LANG`/`LC_ALL`/`TZ`.
   `cwd` is resolved and `realpath`-checked inside the worktree.
4. Enforce `timeoutMs` (capped by `--timeout <s>` with `SIGKILL`), capture
   stdout+stderr under an 8 MiB cap, and compute the unkeyed sha256.
5. Compare exit code and digest. The source checkout's working tree (excluding
   `.git`) is hashed before and after; a change is `source-tree-modified`.
6. Remove the worktree unless `--keep-worktree`; always remove the scratch
   directory otherwise.

Exit codes:

| Condition | Exit | Code |
| --- | --- | --- |
| exit 0, digest and byte count match | 0 | `PASS` |
| digest/byte count changed | 1 | `output-digest-mismatch` |
| non-zero exit, or exit differs from `expectedExit` | 1 | `command-failed` |
| binary cannot be executed | 2 | `command-unavailable` |
| timeout | 1 | `command-timeout` |
| shell line or escaping `cwd` | 1 | `command-refused` |
| manifest, rerun record or a named report is unauthenticated | 1 or 2 | `RERUN_UNTRUSTED` |
| source tree changed | 1 | `source-tree-modified` |

**The worktree is not a sandbox.** `--rerun` executes commands recorded by the
evidence author. The manifest and `verify/rerun.json` authenticate the record,
not the safety of the command; the child runs with the caller's UID and can
reach the rest of the machine. Use it only on evidence you are willing to
execute. 0.19.2 refuses `--rerun` with `--allow-unsigned` and requires the
signed manifest, its reports and the rerun links to authenticate before any
command runs.

Under `command`, `verify` without `--rerun` reports the claim as
`provenance: claimed` and returns `UNKNOWN` (exit 2): a claimed observation is
never promoted to `PASS`. Under `declared`, the 0.15 behaviour is unchanged with
a `provenance: declared` note; `--rerun` may still be used opportunistically.

## 3. Consequences

- A false `PASS` under `command` must now survive re-execution at the observed
  commit. The verifier does not need the run key, the plugin or the author's
  environment.
- The engine's contract is unchanged: it does not run commands, so the run
  control plane gains no new execution surface and `final_verify` remains
  deterministic.
- This is reproducibility, not semantic proof. A meaningless command (`true`),
  a test edited in the same commit, a non-deterministic command, or one whose
  output exceeds the capture still passes. Those are recorded as residuals in
  `SECURITY.md`.
- `command` provenance needs a commit per task report and a git checkout at
  verification time. `declared` remains the default so a 0.15 run keeps its
  meaning.
- The projection is deliberately small: argv, cwd, exit, output digest, bytes,
  timeout. It is not a build script and has no environment or network policy.
