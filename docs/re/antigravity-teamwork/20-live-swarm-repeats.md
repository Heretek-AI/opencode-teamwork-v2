# Live Repeats — Obsolete `/teamwork-preview` vs Registered `/teamwork` on 1.5.16

**Status: OBSERVED — two inline repeats under an obsolete command, one zero-token
expansion probe, and two correct-command runs that both took teamwork.** Under
`/teamwork-preview` on 1.5.16 the result is **2/2 inline** because the command no
longer expands. Under `/teamwork` on the same build, same task, same tier and
same interface, the result is **2/2 teamwork (SWE Light), 0/2 swarm, 0/2
inline**. The two inline runs are a **command-deprecation finding**, not a
selector result; the two correct-command runs are a selector observation for
these conditions only.

Evidence bundle: [`live/2026-11-24-swarm-repeats/`](live/2026-11-24-swarm-repeats/).

> **Scope guard.** "2/2 teamwork" means two TUI runs on 1.5.16 at the
> `Gemini 4 Hydrogen (Medium)` tier with this exact fizzbuzz prompt. It does not
> establish a default, a frequency, or a rule. The 2026-11-22 native swarm
> remains a valid 1.5.14 observation and is not a baseline for this build.

---

## 1. Identity

| Item | Value | Label |
|---|---|---|
| CLI | Antigravity Linux CLI **1.5.16**, 275,067,592 B, SHA-256 `05245f4346d16b679fd059a73081af0161607a76b4a164642bd007430934e785` | OBSERVED — the runs' own log lines (`Language server version: 1.5.16`) plus the corpus live axis; the hash was not re-measured in this pass |
| Model | `Gemini 4 Hydrogen (Medium)` in every run | OBSERVED — each session log's model-override line |
| Interface | TUI sessions (Experiment 1 and C/D), `--dangerously-skip-permissions`; the probe is print mode | OBSERVED — no print-mode lines in the TUI logs; `Print mode: starting` in the probe logs; the permission flag is REPORTED for the TUI launches |
| Workspaces | `ws-a` (A), `ws-b` (B), `ws-c` (C), `ws-d` (D) under the capture root | OBSERVED — directories; normalised in the bundle |
| Probe | `/tmp/opencode/re-expand/{old,new}.{log,jsonl,err}` | OBSERVED — bundle copies |
| Date | 2026-11-24, 16:32–16:38 local (−05:00) | OBSERVED — mtimes and log stamps |

Three different things are being measured, and they must not be pooled:

1. **Experiment 1** — `/teamwork-preview` + the fizzbuzz task, N=2 (runs A, B).
2. **The expansion probe** — `/teamwork-preview` vs `/teamwork` with a
   `PONG` prompt, zero model turns (arms `old`, `new`).
3. **Experiment 2** — `/teamwork` + the same fizzbuzz task, N=2 (runs C, D).

---

## 2. Correction: why the original question changed

The first brief for this document proposed to compare "2/2 inline" against the
2026-11-22 native swarm and report a recurrence. That comparison assumed both
runs entered the same command. The probe falsifies the assumption for 1.5.16:

- `/teamwork-preview [skip-interview] Reply with exactly: PONG` produced **no**
  `expanded slash command` line and **no** `expanded_commands` key in the
  stream's `init`. The message was forwarded as one item.
- `/teamwork [skip-interview] Reply with exactly: PONG` produced
  `Print mode: expanded slash command "teamwork" (system)` and
  `expanded_commands:[{"name":"teamwork","type":"system"}]`. The message was
  forwarded as two items.

Both arms were killed on the client-side line, took **zero model turns**, and
recorded `num_turns:0` with all-zero usage. [OBSERVED — `probe-*.cli.txt`,
`probe-*.jsonl`]

So in 1.5.16 the old command is **ordinary text**, not a slash command. A model
handed `/teamwork-preview …` sees no system command and no teamwork instruction;
doing the small task itself is the expected consequence. That is a
**command-deprecation finding**, not evidence that the swarm path was rejected.
[OBSERVED — no expansion; INFERRED — the model received plain text and acted
inline; no transcript of the model's input was captured]

---

## 3. Experiment 1 — `/teamwork-preview`, N=2 (obsolete command)

### 3.1 Prompt, verbatim

```text
/teamwork-preview [skip-interview] Create fizzbuzz.js in this workspace with a function fizzbuzz(n) returning the FizzBuzz string, plus a test file test.js that checks it, and run the test. Keep it small and cheap: a quick single self-contained change.
```

### 3.2 Results

| Dimension | Run A (`ws-a`) | Run B (`ws-b`) | Label |
|---|---|---|---|
| Marker | `a.marker` 16:33 | `b.marker` 16:34 | OBSERVED — mtime |
| Product | `fizzbuzz.js` 284 B; `test.js` 815 B | `fizzbuzz.js` 291 B; `test.js` 524 B | OBSERVED — disk |
| Test file shape | 4 `node:test` tests, 12 `assert.equal` calls | one table of 14 cases in a loop | OBSERVED — file contents |
| Test invocation | `node test.js` by the agent | `node test.js` by the agent | REPORTED — capture; no console log retained |
| Test result | 4/4 tests pass, exit 0 | `All 14 fizzbuzz tests passed.`, exit 0 | REPORTED at run time; OBSERVED — the committed fixtures re-execute with those results (see §3.4) |
| Files created after marker | only the two product files | only the two product files | OBSERVED — `find -newer` |
| `swarm/` state | none | none | OBSERVED — negative find |
| `.agents/teamwork/` root | none created | none created | OBSERVED — negative find |
| Dispatch | none observed | none observed | OBSERVED — absence |
| Outcome | **inline** | **inline** | OBSERVED — product written and tested, no subagent state |

The two files differ only in style: A's test file uses `node:test` blocks, B's a
case table; the implementations are the same modulo a comment. Nothing in the
workspaces names a route, a model or a subagent.

### 3.3 Discriminator checks

The point of the markers is to distinguish "this run wrote it" from "it was
already there". For each run:

- `find <workspace> -newer <marker>` returned only `fizzbuzz.js` and `test.js`.
- No `brain/<conversation>/.system_generated/swarm/swarm.json` newer than the
  marker; no `members.json`, `plan.json` or `board.jsonl` either.
- No new `.agents/teamwork/` root under the app-data directory.
- No `invoke_subagent`, `teamwork_` or `swarm` line in the session logs for the
  two windows.

[OBSERVED — capture's `find` results and negative listings. The two session logs
are not in the bundle; the negative state checks are.]

### 3.4 Re-execution of the fixtures

The committed files were re-run in place, without touching the CLI:

```text
ws-a: node test.js  ->  tests 4, pass 4, fail 0, exit 0
ws-b: node test.js  ->  All 14 fizzbuzz tests passed., exit 0
```

[OBSERVED — re-execution in this pass] This proves the fixtures are valid and
the reported results are reproducible. It does **not** prove the 2026-11-24 run
itself invoked them; that half is the capture's report.

### 3.5 What Experiment 1 means

**2/2 inline for `/teamwork-preview` on 1.5.16 — but the command did not
expand, so this is a consequence of the command being obsolete, not a selector
result.** The runs never entered the `/teamwork` subsystem, never dispatched a
teamwork agent, and never started a native swarm. They are useful as a
deprecation check and as an example of what an unexpanded slash command looks
like on disk; they are **not** evidence for "the swarm is never used" or for any
teamwork-vs-swarm rule.

---

## 4. Experiment 2 — `/teamwork`, N=2 (correct command)

### 4.1 Prompt, verbatim

```text
/teamwork [skip-interview] Create fizzbuzz.js in this workspace with a function fizzbuzz(n) returning the FizzBuzz string, plus a test file test.js that checks it, and run the test. Keep it small and cheap: a quick single self-contained change.
```

This is Experiment 1's task with only the command changed.

### 4.2 Results

| Dimension | Run C (`ws-c`) | Run D (`ws-d`) | Label |
|---|---|---|---|
| Request time | `2026-11-24T21:37:14Z` | `2026-11-24T21:38:47Z` | OBSERVED — each `ORIGINAL_REQUEST.md` |
| State root | `<appData>/brain/<conversation>/scratch/.agents/teamwork/` | same form, a different conversation | OBSERVED — each briefing; absolute ids withheld |
| Files at capture | `ORIGINAL_REQUEST.md` 368 B; `sentinel/BRIEFING.md` 1,890 B | 368 B; 1,897 B | OBSERVED — disk snapshots |
| Route | **SWE Light (`teamwork_swe`)** | **SWE Light (`teamwork_swe`)** | OBSERVED — C's `Routing Decision`; D's `Route chosen` constraint line |
| Rationale | single self-contained code change with an explicit lightness signal ("Keep it small and cheap: a quick single self-contained change.") | same: "single self-contained change with explicit lightness/cheapness request" | OBSERVED — briefings |
| Phase | `in progress` | `in progress (spawning teamwork_swe)` | OBSERVED — briefings |
| `teamwork_swe_1/` | referenced, not yet created at the snapshot | created, empty at the snapshot | OBSERVED — disk |
| Native swarm | none | none | OBSERVED — negative find |
| Inline product | none at the snapshot | none at the snapshot | OBSERVED — `ws-c`/`ws-d` empty |
| Outcome | **teamwork; SWE Light; no swarm; no inline** | **teamwork; SWE Light; no swarm; no inline** | OBSERVED — at each snapshot |

Both briefings are quoted (paths redacted) in the bundle. C's route line is
under `## Routing Decision`:

```text
- Path: SWE Light (`teamwork_swe`)
```

D's is a constraint, because D's briefing did not open a separate routing
section:

```text
- Route chosen: SWE Light (`teamwork_swe`) — single self-contained change with explicit lightness/cheapness request ("Keep it small and cheap: a quick single self-contained change.")
```

**This is 2/2 teamwork (SWE Light), 0/2 swarm, 0/2 inline.** Both runs were still
at `Phase: in progress` when their state roots were copied: D's orchestrator
folder existed but was empty, C's did not exist yet, both workspaces were empty,
and no gate or product had appeared. What is observed is the **selection** — the
correct command reached the teamwork subsystem and both sentinels chose SWE
Light — not a completed route.

### 4.3 What Experiment 2 establishes

- **`/teamwork` expands on 1.5.16** (probe arm `new`) and, in both runs, the
  expanded command **dispatched the teamwork subsystem** rather than inline
  execution or a native swarm. [OBSERVED — probe + both state roots]
- **The same task that was done inline under `/teamwork-preview` was routed to
  SWE Light under `/teamwork`.** The difference is the command, not the task
  text: the task body is identical. [OBSERVED — all four request files]
- **Both runs chose SWE Light, not General and not Large Team**, with the
  rationale quoting the lightness signal. This is consistent with `13`'s two SWE
  Light runs, which used an explicit lightness signal on the same route.
  [OBSERVED — both briefings]
- **Both runs used the `brain/<conversation>/scratch/` root form.** Neither
  created a `scratch/teamwork/<run-id>/` root and neither created a `swarm/`
  board. [OBSERVED — state roots]
- **No swarm and no inline outcome occurred under the correct command in this
  sample.** Two runs cannot show that the swarm path is gone, rare or
  unreachable on 1.5.16. [UNKNOWN]

### 4.4 What the 2/2 does not mean

The two correct-command runs are not a general frequency claim. They hold the
task, tier and interface constant and vary only the command against Experiment
1. A native swarm is still an observed outcome of `/teamwork-preview` on
**1.5.14** (`11` §1.6); whether it remains an outcome on 1.5.16, under another
prompt, another tier, print mode, or a larger team request, is **UNKNOWN**.
"0/2 swarm" is an observation about this sample, not a closed path.

---

## 5. The version finding

| Axis | `/teamwork` | `/teamwork-preview` | Evidence |
|---|---|---|---|
| **1.5.14** (static axis) | routed (`12`, `13`) | routed and dispatched (`07`, `11`); stored identifier literal is `teamwork-preview` (`01`, `06`, `10`) | OBSERVED — client + disk; literal offsets are 1.5.14 |
| **1.5.15** (historical live axis) | entered (`15` routed LEMMA; `16` entered the interview gate) | **UNKNOWN** — not probed | OBSERVED for `/teamwork`; no probe for the old form |
| **1.5.16** (current live axis) | **expands** — `Print mode: expanded slash command "teamwork" (system)` + `expanded_commands` | **does not expand** — no line, no key, one forwarded item | OBSERVED — zero-token probe |

**Statement.** On 1.5.16, `/teamwork` is the registered slash command that
expands client-side, and `/teamwork-preview` does not expand. This is a
**version-scoped** finding: the 1.5.14 binary's stored identifier is
`teamwork-preview`, and that form demonstrably reached the subsystem in the
2026-11-21/22 runs. The alias set narrowed at or before 1.5.16; the exact version
of the change is **UNKNOWN**, because 1.5.15 was not probed. Do not generalise
this to 1.5.14, 1.5.15, or any later build.

What the probe does **not** establish: whether `teamwork-preview` was removed
from the registry or merely stops expanding; whether a hidden alias remains;
whether `/teamwork-preview` would still be recognised in a different interface.
[UNKNOWN]

---

## 6. Comparison with the 2026-11-22 native swarm

The prior swarm is recorded in `11` §1.6 and `09` §2.4/§3.5/§4. It is a real
native-swarm observation, and the correction does not weaken it — it changes
what can be compared.

| Dimension | 2026-11-22 swarm | 2026-11-24 Experiment 1 | 2026-11-24 Experiment 2 (C, D) |
|---|---|---|---|
| CLI | 1.5.14 | 1.5.16 | 1.5.16 |
| Command | `/teamwork-preview` | `/teamwork-preview` | `/teamwork` |
| Command recognised? | **yes** — the subsystem was entered | **no** — ordinary text | **yes** (probe) |
| Interface | print mode, `-p=` | TUI | TUI |
| Model | `gemini-4-argon-medium` (swarm members) | `Gemini 4 Hydrogen (Medium)` | `Gemini 4 Hydrogen (Medium)` |
| Task | fizzbuzz + test + run | **identical** | **identical** |
| Outcome | native swarm (`coordinator` + `coder` + `monitor`), product, exit 0 | inline, product, tests pass | teamwork, `teamwork_swe` selected, no swarm, no inline |
| State | `brain/<coordinator>/.system_generated/swarm/` | none | `brain/<conversation>/scratch/.agents/teamwork/` |

**The 2026-11-22 run and Experiment 1 are not a recurrence.** The command was
live then and is not live now; the version, the command set and the interface
all differ. The 2026-11-22 swarm remains valid evidence that a native swarm can
occur on 1.5.14. It is not evidence about 1.5.16.

**Experiment 2 is the 1.5.16 comparison that holds the command constant at a
live command.** Both runs show teamwork being selected. They do not show the
swarm path is closed on 1.5.16 — two runs cannot.

---

## 7. What settles, what does not

**Settled (OBSERVED):**

1. `/teamwork` expands client-side on 1.5.16 and injects
   `expanded_commands:[{"name":"teamwork","type":"system"}]`; `/teamwork-preview`
   does neither. Both probe arms took zero model turns.
2. The two `/teamwork-preview` repeats executed inline, wrote two files each and
   ran the test; no swarm directory and no `.agents/teamwork` root appeared. The
   fixtures re-execute cleanly.
3. Two `/teamwork` repeats dispatched teamwork and selected SWE Light
   (`teamwork_swe`), with no swarm and no inline product at either snapshot.
4. The 2026-11-22 swarm used a command that was live on 1.5.14; it is not a
   baseline for the 1.5.16 repeats.

**Not settled (UNKNOWN):**

1. **The swarm-vs-teamwork selector on 1.5.16.** The sample is 2/2 teamwork
   under one prompt, one tier and one interface. The cause of any path choice
   remains `UNKNOWN` — task shape, model output, enabled flags, quota state or
   chance.
2. **Whether the native-swarm path is reachable at all on 1.5.16 with a correct
   command.** No 1.5.16 run has produced a swarm directory.
3. **The exact version at which `/teamwork-preview` stopped expanding.**
   1.5.15 was not probed.
4. **Whether the route choice generalises.** Both runs chose SWE Light; another
   prompt, a larger team request or a different tier may choose General, Large
   Team or another route.
5. **Why C and D used the `brain/<conversation>/scratch/` root while the Large
   Team run (`19`) used `scratch/teamwork/<run-id>/`.** The root-form selector is
   `UNKNOWN` (see `11` §2.1).
6. **Whether the TUI matters.** All repeats here are TUI; the 2026-11-22 swarm
   and the 1.5.14 teamwork runs were print mode. Interface is a confound, not a
   demonstrated cause.

**Explicitly not claimed.** "The swarm is never used", "the swarm is dead on
1.5.16", "the selector is the command", "2/2 inline is the swarm answer", "2/2
teamwork is the rule", and "the Large Team gate is X" are all outside the
evidence. The command finding explains Experiment 1; the 2/2 teamwork result is
an observation for these conditions, not a general selector rule.

---

## 8. Confounds

- **Version.** 1.5.14 → 1.5.16 changes both the command set and the builtin tree
  (`.checksum` `f46b8917…` → `3499ad60…`).
- **Command.** `/teamwork-preview` was recognised on 1.5.14 and does not expand on
  1.5.16. This is the dominant difference for Experiment 1.
- **Interface.** TUI here; print mode in the 2026-11-22 swarm.
- **Model tier.** `gemini-4-argon-medium` in the 1.5.14 swarm; `Gemini 4
  Hydrogen (Medium)` here. `06` does not settle per-agent tier assignment.
- **Task.** Identical text across A, B, C and the 2026-11-22 run apart from the
  command and the workspace path — so task shape is **not** a confound for the
  A/B vs C comparison, but it is held constant, not varied.
- **Stop time.** C and D were snapshotted at `Phase: in progress`; later state is
  not in this record. A/B were snapshotted after their tests passed.
- **Sample size.** Two runs per experiment. The 2/2 split is exact for this
  sample and says nothing about frequency, ordering or a default.

---

## 9. Bundle and method

The bundle carries the six probe files (`probe-old.*`, `probe-new.*`), the four
fixture files (`ws-a/`, `ws-b/`), both workspace listings, C's and D's request
files, redacted briefings, state trees and two-line identity log excerpts.
`README.md` documents the redaction and is excluded from `MANIFEST.sha256` by
rule.

The probe arms were separate print-mode processes, killed on the client-side
expansion line (or, for the old arm, a few seconds after `sending message` when
no expansion line appeared). No model request was made for the claim being
tested, so a quota refusal cannot manufacture or mask the result. The TUI runs
were not re-executed.
