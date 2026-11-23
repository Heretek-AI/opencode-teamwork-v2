# ADR 0009: Claim Protocol 2 — Fencing, Side-Effect Baselines and Explicit Recovery

- **Status:** Accepted (0.10.0)
- **Date:** 2026-11-23
- **Scope:** `plugins/opencode-teamwork/locks.ts`, `tools.ts`, `authorize.ts`
- **Extends:** [ADR 0005](0005-artifact-authenticity.md) (artifact authenticity), [ADR 0007](0007-signed-handoff-provenance.md) (signed index entries)

## 1. Context

0.8.0 added two coordination primitives: a cross-process `<artifact>.lock` and
a task claim stamped by `teamwork_next`. They stopped the common case (two
resumed Sentinels dispatching the same ready task) but left three silent
failure modes:

1. **Lock stranding.** Creation used one `O_CREAT|O_EXCL` write of the owner
   JSON. A crash between create and write left a zero-length lock. Staleness
   required a parseable owner, so the artifact stayed locked until manual
   cleanup. Age came from the owner's self-reported `at`, which a falsified
   timestamp could defeat. Reclaim read the nonce and then unlinked the live
   path, so a racing reclaimer could delete a lock that had just been taken.
2. **Silent reclaim of a crashed worker.** Any expired claim was reclaimed by
   the next `next`, with no evidence that the crashed worker had or had not
   changed the worktree. A second worker could start on top of uncommitted or
   partially committed work.
3. **Unbound verifier reports.** `verify/report-<task>.json` carried a verdict
   but not the round, branch head, or diff it was computed against. A report
   could be applied to a reworked task, and a branch that moved after `PASS`
   could still be merged.

The goal is to make crash recovery explicit, stop silent re-dispatch, and keep
legacy runs working. No runtime dependency and no portable distributed lock
service was acceptable.

## 2. Decision

### 2.1 Lock publication and reclaim (`locks.ts`)

- **Atomic publication.** Write the complete owner JSON to a unique temp
  `<lock>.<host>.<pid>.<nonce>.tmp` with `wx`, then `link(2)` it to the lock
  path. `EEXIST` means held. The temp is always unlinked. On a filesystem that
  rejects hard links (`EPERM`/`ENOTSUP`/`ENOSYS`/…), fall back to atomic
  `mkdir(2)` with `<lock>/owner.json`; detect once and cache.
- **Age from the filesystem.** `lstat(lockPath).mtimeMs`, never `owner.at`. An
  empty or unparseable lock older than the lease is stale and reclaimable, with
  an `unreadable_lock_reclaimed` diagnostic. Before the lease it may still be
  mid-publication and is left alone.
- **Single-winner reclaim.** Re-observe the artifact (inode + nonce), then
  `rename(2)` it to `<lock>.stale.<observedNonce>` and delete the quarantine.
  Exactly one reclaimer can rename; a replaced live lock is never unlinked by
  path. A lock from another host is never reclaimed from its pid.
- The in-process FIFO, bounded backoff, fail-closed timeout, and symlink refusal
  are unchanged. Locks remain short (30 s lease); claims carry the longer lease.

### 2.2 Claim protocol 2 (`tools.ts`)

A new plan writes `claimProtocol: 2`, `claimLeaseMs` (default 300000, bounded
60 s–60 m), `host`, and lock-storage diagnostics. A `state.json` without
`claimProtocol` is protocol 1 and keeps the 0.9.0 behaviour exactly.

- **Lease + grace.** 5 min lease then 5 min grace. Derived states: `live`,
  `expired` (not reclaimable), `stale`, `needs-inspection`, `cross-host`.
- **Fence.** A per-task monotonic counter incremented on claim, reclaim,
  release, explicit override, and round change. `next` returns it; `task_update`
  accepts an optional `fence` and refuses `STALE_FENCE` without changing state.
  Claim ownership is enforced on every transition: `CLAIM_OWNED_BY_OTHER` for a
  live claim held by a non-owner/non-descendant, `CLAIM_EXPIRED` for an expired
  claim the caller does not own.
- **Heartbeat.** The owner or a session descended from it renews
  `leaseUntil`/`heartbeatAt` without changing the fence. Tenure is bounded at
  60 min or 20 renewals; past that the claim is forced expired and
  `needs-inspection`.
- **Side-effect baseline.** Captured at `worker_active` (after worktree setup)
  and at worktree setup: git `baseSha`/`headSha`/`diffHash`/`statusHash` plus a
  bounded untracked digest, or a route-specific artifact scope for
  verifier/document-review/LEMMA claims. Untracked scans are capped at 1000
  files / 8 MiB and become `unknown` when exceeded.
- **Reclaim.** Only unchanged fingerprints reclaim (`fence++`,
  `previousClaimant` + bounded `history`). Changed/unknown/missing becomes
  `needs-inspection`, excluded from ready tasks. Cross-host is never reclaimed.
- **Recovery.** `teamwork_recover` (`team/sentinel`/`team/orchestrator`, root or
  descendant) supports `heartbeat`, `inspect`, `release`, `block`, `requeue`,
  `adopt`, `discard`. `inspect` issues a single-use 10-minute token stored only
  as SHA-256. `adopt`/`requeue`/`block` re-check the fingerprint and refuse
  `INSPECTION_STALE`. `adopt` accepts only a clean committed branch whose
  baseline head is an ancestor, writes `worker_done` + `checkpoint`, and makes no
  commit. `requeue` requires an unchanged fingerprint or explicit
  `force`+`confirm` discard.
- **Events.** `claim_renewed`, `claim_reclaimed`, `claim_released`,
  `claim_inspection_required`, `claim_recovered`, `claim_override`.

### 2.3 Verifier report binding and merge

`teamwork_report` records `round`, `fence`, `branch`, `baseSha`, `headSha`,
`diffHash`, and `bound`. `verified_pass` requires the report round to equal the
task round and refuses a moved head/diff with `BRANCH_MOVED`. `worktree merge`
refuses a verified report whose head no longer matches the branch. Legacy
reports without the fields are accepted with a `legacy_unbound_report` warning;
they are never silently current.

### 2.4 Worktree and cross-host guards

`worktree setup` records the baseline and renews the claim; `diff` returns
`HEAD`/`baseSha`/`diffHash`; `cleanup` refuses while any task has a live claim.
`setup`/`merge`/`resolve`/`cleanup` refuse when the run host differs from the
current host unless `allowSharedWorktrees: true`, and never when the plan set
`requireSameHost: true`. Claim release of a foreign-host claim is refused by
default; `TEAMWORK_ALLOW_CROSS_HOST=1` or `allowCrossHost: true` plus
`confirm: true` is the explicit opt-in.

## 2.5 0.10.1 amendment

The 0.10.0 implementation shipped four defects that this patch corrects without
changing the protocol version:

- **Release is a nonce-checked quarantine.** `releaseLock` no longer observes the
  live path and then unlinks it. It renames the lock to
  `<lock>.release.<nonce>`, reads the moved artifact, removes only a quarantine
  whose nonce is ours, and restores a foreign/replaced artifact with
  `link(2)` + `unlink(2)` (never a clobbering rename). A lock published
  immediately after release therefore survives.
- **`claim.host` means the claiming process.** New claims stamp
  `host = SELF_HOST` (the process doing the claiming) and `runHost` (the run's
  recorded host). Cross-host comparisons use `claim.host`. Protocol-2 claims
  written by 0.10.0 with the run host as `host` are read as local on a local run;
  there is no migration write. A claim whose `host` differs from the current
  process is `cross-host` and is never auto-reclaimed.
- **Grace and `needs-inspection` block cleanup.** `worktree cleanup` uses
  `deriveClaimState` and refuses on `live`, `expired` (inside grace),
  `needs-inspection`, and `cross-host`; only `stale` is recoverable. The same
  derived state replaces `claimIsLive` in `next`, `task_update`, and `recover`.
- **`needs-inspection` always wins.** A flagged claim with an unchanged
  fingerprint is still not reclaimed; `task_update` to `worker_active` returns
  `CLAIM_NEEDS_INSPECTION`.

Additional correctness fixes in the same patch:

- The fence increments only when the owner/epoch actually changes (or on a round
  change or release), so the fence returned by `next` is valid for the immediate
  `task_update`.
- Inspection tokens bind `(round, fence, claim.by)`; `recover` also accepts a
  `fence`, and a mismatch is `INSPECTION_STALE`.
- Release/adopt/requeue/block preserve a bounded task-level `claimHistory`, and
  a terminal `task_update` release emits `claim_released`.
- The `state.json` critical section no longer runs the full git fingerprint
  (tracked diff plus bounded untracked scan) or the verifier report's full diff.
  Full baselines/report evidence are captured before the lock; only a cheap
  `HEAD` + `status --porcelain` + tracked-diff hash is re-read under it. The
  default lock timeout is 30 s (equal to, never above, the 30 s lock lease), so
  worst-case recovery latency is one lease plus one timeout rather than an
  unbounded wait.
- The `mkdir` fallback publishes `owner.json` via temp + rename; an owner-write
  failure removes the directory and fails closed instead of reporting
  `"created"`.

## 3. Compatibility and migration

- Protocol 1 (`claimProtocol` absent) is untouched: 15-minute advisory lease,
  expired-claim reclaim, no fence enforcement, no baseline gate. A re-plan does
  not add `claimProtocol` to an existing legacy state.
- New plans are protocol 2 automatically. No new dependency; Node built-ins
  only.
- Legacy verifier reports load and complete with a warning, matching the
  `allowUnsignedLegacy` / `allowUnstamped` pattern: accepted explicitly and
  never silently upgraded to a current, bound verdict.
- A recovery token is stored in `state.json` only as a hash; the plaintext is
  returned once and never persisted.

## 4. Boundary and residual risk

- **No portable CAS on NFS.** `link`/`rename`/`mkdir` are not a reliable
  distributed mutex on every NFS deployment. Exactly-once dispatch is not
  achievable there; the fence, fingerprint gate, and explicit recovery reduce
  the window and make the failure visible rather than silent.
- **Direct writes after revocation.** A same-UID shell (or a worker that keeps
  editing) can write after its claim is released. Fencing governs the engine's
  transitions, not the filesystem.
- **Fingerprint blind spots.** A change reverted exactly, a build artifact
  outside the scoped paths, or an untracked scan over the cap (`unknown`) can be
  missed. `unknown` is treated as needs-inspection, never as clean.
- **Manual cost is not idempotent.** `teamwork_cost({ addUsd })` still has no
  snapshot digest; the claim protocol does not change that.
- **Adoption is evidence, not authorship.** `adopt` records the existing commit
  and checkpoint. It cannot prove the worker intended it, and it deliberately
  makes no commit.
