# Runtime findings (L2/L3)

## L2: no genuine plugin defects

**No genuine plugin defects were found.** All 24 L2 scenarios pass against the
real plugin on OpenCode 2.4.1 without changing plugin code, so no spec is
skipped.

The three notes below are behaviour the specs had to interpret or route around.
They are recorded here so a later reader does not mistake them for missing
coverage or for a silently weakened assertion.

## 1. Structured tool results are invisible after runtime normalization

**Observed.** No Teamwork tool declares an output schema. The 2.4.1 snapshot
executor keeps only `content` and drops the plugin's other keys
(`plugins/opencode-teamwork/tools.ts` returns `status`, `fence`, `token`,
`report`, ...; `packages/core/src/tool/runtime.ts` returns `{output: undefined,
content}` when no output schema is declared). L1 A8 already records this at the
result-shape level.

**How L2 handles it.** `harness/run.ts` executes the tool object the host
registered (`rawExecute`) when a spec needs the plugin's structured result, and
adds `executeViaRuntime` for representative calls (B1 no-spec plan, B9 route)
that cross the snapshot executor. Both paths use the host's real location tool
service and the same registered executors; no plugin code or tool schema is
changed.

## 2. "A second root Sentinel" cannot reach a run-bound tool

**Observed.** The control plane requires the caller to be the run's recorded
root session or a strict descendant (`authorize.ts`, `requireDescendantSession`).
A second, unrelated root session is refused before `next` or `task_update` can
run at all:

```text
refused: next must be called from the run root or a session that descends from
the run root (<root>); session <other> has no parent, so it does not descend from
<root> (fail closed); nothing was written
```

**How L2 handles it.** C11 asserts that unrelated-root refusal, then exercises
the reachable contention case: two Sentinel sessions created under the run root.
The first claims; the second gets no `readyForWorker` entry and its update is
`CLAIM_OWNED_BY_OTHER`. This is the same claim-ownership rule the literal spec
describes, with a caller the authorization layer can actually admit.

## 3. `teamwork_wave_record` refuses `cites: []` at write time

**Observed.** The writer refuses an explicitly empty cite list:

```text
refused: cites is present but empty; a strict verdict must cite at least one
verify/ artifact it reviewed; nothing was written
```

The strict gate, however, distinguishes a pre-existing artifact with
`cites: []` ("unbound") from one with no `cites` key at all
(`legacy_unbound_wave`), because those files can predate 0.12.0.

**How L2 handles it.** D18b asserts the write-time refusal, then writes the
empty-cites artifact directly (the same fixture technique
`scripts/test-engine.mjs` uses) and asserts the gate reports "cites is empty; the
verdict is unbound". D18c writes an artifact with no `cites` key and asserts
`verify/final.json` carries the `legacy_unbound_wave` warning. The gate is the
real tool; only the on-disk artifact is hand-built, as in the engine suite.

---

# L3 findings

## 4. The run budget is advisory outside the massive-proof tournament (documented limitation, resolved in 0.17.2)

**Observed — documented limitation, not a missing gate.** `teamwork_plan`
records `budgetUsd` and `teamwork_cost` computes the percentage and returns
`shouldHalt: true` at the explicit 80% threshold, but no non-tournament consumer
of that signal exists. Only `teamwork_tournament` cancels or halts on
`budget <= 0 || spent >= budget || pct >= 80`
(`plugins/opencode-teamwork/tools.ts:8402` for the tournament tool, `:8788` for
`next`'s tournament branch). A standard run keeps dispatching after the budget
is exhausted.

Reproduced on this branch with a real plan (`budgetUsd: 0.5`, one task),
`costs.json` at `spentUsd: 5`, and a real `teamwork_cost` read followed by
`teamwork_next`:

```text
COST: Budget: $0.5 · spent: $5 (1000%)
⚠ 1000% of budget used — advisory: halt non-essential workers and ask the user. The budget is enforced only by the massive-proof tournament.
SHOULD_HALT: true PCT: 1000 THRESHOLD: 80
NEXT_STATUS: undefined
NEXT_HAS_ALL_PASSED: false
NEXT_READY_COUNT: 1        # the task is still dispatched
PHASE: DISPATCH
```

**Documentation is the authority here.** The shipped docs promise a warning and
an agent instruction, not an engine gate: `README.md` says `teamwork_cost`
"warns at 80%", `docs/ARTIFACTS.md` calls `costs.json` a "budget tracker" and
puts the only budget preflight/halt under "Tournament artifacts", and
`agents/team/sentinel.md` tells the Sentinel to "halt non-essential workers"
without claiming `next` refuses. The gap analysis already recorded
"Halt non-essential workers at 80% budget" as **prompt prose only (not
enforced)**: `teamwork_cost` returns `shouldHalt` but nothing enforces a halt
(`docs/re/antigravity-teamwork/08-gap-analysis-opencode-teamwork-v2.md` §1.6).
Adding a global gate would invent a product promise the docs never made.

**0.17.2 resolution.** The limitation is now stated plainly in `README.md` and
`docs/ARTIFACTS.md`; the 80% threshold is one exported constant
(`BUDGET_HALT_PCT` in `plugins/opencode-teamwork/budget.ts`) shared by the cost
warning and the tournament halt; `teamwork_cost` returns `thresholdPct: 80`;
`budgetUsd: 0` is documented and tested as unlimited; and I4b is unskipped to
assert the advisory behaviour (dispatch at 1000%, no `blocked`, no
`PRESENT_PARTIAL`). The cost accounting itself is unchanged.

## 5. A bare `next` claim appends no event (observation, not a defect)

**Observed.** `teamwork_next` records claims in `state.json` but does not append
`events.jsonl`; only transitions and evidence writers append events. I5 asserts
the event sequence space under real concurrency, so each racing child performs
its claimed `worker_active` transition after `next`. The claim-once assertion
uses the two tool results and `state.json`; the `seq` assertion uses the two
concurrent transitions. No plugin change was made.

## 6. `BLOCKED_BY_VICTORY_AUDIT` needs a pre-existing stamped PASS (spec wording)

**Observed.** `teamwork_final_verify` cannot stamp PASS while the recorded
verdict is `VICTORY REJECTED`, and a `CONFIRMED` verdict is write-once, so a
well-formed run cannot reach `next`'s `BLOCKED_BY_VICTORY_AUDIT` branch from a
rejection alone. The branch is reachable only when a stamped PASS already exists
(for example, a PASS that predates the rejection).

**How L3 handles it.** I3 asserts the rejection → `final_verify` FAIL path with
the real writer, then seeds a stamped PASS through the plugin's own
`createAuthContext` (the teamwork plugin's captured `ctx.storage`, the manifest
nonce, and the run HMAC key), which writes both a valid envelope and the digest
index entry. That models the pre-existing PASS exactly as `scripts/test-engine.mjs`
does with `writeSignedFixture`. The fixture is then observed as
`BLOCKED_BY_VICTORY_AUDIT`; repeated `next` reads change no bytes; a fresh
trusted `victory_audit CONFIRMED` resumes the run; `final_verify` then stamps a
new PASS (the generated session is no longer the fixture's).

## 7. A request derives a requirements baseline, so victory and handoffs are required by default

**Observed.** `teamwork_plan` derives `requirements.json` from a `request` when
no explicit `requirements` are passed, which sets `requireHandoffs` and
`victoryAudit` to `required` by default. This is intended baseline behaviour, not
a defect, but it makes a "minimal" plan carry two extra gates.

**How L3 handles it.** Every L3 plan sets `requireHandoffs: "skip"` explicitly
when the continuity matrix is not the subject (I1–I4, I6), and I2/I3 still run
the victory gate because the baseline is present. I1 asserts the resulting
`verify/final.json.evidence.handoffs` object is the recorded explicit skip.

## Flake policy

No L3 spec was quarantined. I5 (two OS processes, file DB, cross-process locks)
was run 10 consecutive times and passed 10/10; the L3 file as a whole was run
three consecutive times after the suite was green. There is no retry wrapper in
the harness: a failure fails the spec.

