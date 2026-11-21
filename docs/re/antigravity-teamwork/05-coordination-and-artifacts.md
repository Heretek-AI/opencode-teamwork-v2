# Coordination and Artifacts — Antigravity `/teamwork`

Static-analysis reconstruction of how the Google Antigravity Linux CLI's `/teamwork` subsystem coordinates multiple agents, and what it leaves on disk. [OBSERVED] Every fact labelled OBSERVED below was measured from the extracted binary identified in `00-artifact-identity.md` (SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`) by string and offset inspection. No part of the binary was executed, and no network or authentication was used. [OBSERVED]

Companion documents: `00-artifact-identity.md` (binary identity, section map), `01-command-contract.md` (command surface), `02-agent-registry.md` (the 49-entry agent roster, now fully bound name → runtime type → description → tool allowlist via pclntab + RELA decoding; the remaining unknowns are per-agent model tiers, cascade config and the `indexByName` key), `PROVENANCE.md` (chain of custody, licensing, method limits), `prompts/sentinel-routing.md` (recovered routing prompt text).

## Confidence Legend

| Label | Meaning |
|---|---|
| **OBSERVED** | Directly read from the artifact: a byte sequence at a measured file offset, or a type/function path present in the binary. Earned by quoting the value and its offset. |
| **INFERRED** | Derived by reasoning over observed data (field names, JSON tags, function-name morphology, prompt prose). Earned by stating the premises. |
| **UNKNOWN** | Not measured, or not determinable from the available evidence. Written literally as `UNKNOWN`; never guessed. |

Reading note: a field's **existence, name, type, and JSON tag** are OBSERVED when reproduced inside a Go generic-instantiation string; what the field *does at runtime* is usually INFERRED from its name and is marked as such. [POLICY — definitions]

---

## 1. Coordination model overview

The `/teamwork` subsystem uses three coordination mechanisms that are visible in the binary as (a) a Go message type, (b) a member-registry type, and (c) a set of on-disk path literals. [OBSERVED for the types and paths; INFERRED for the composition]

**A shared, append-ordered board.** [OBSERVED type: `board.Message`] The `cortex/core/native_swarm/board` package defines a `Message` with a `Seq uint64` sequence field, an `Agent` author field, a `Text` body, a `Channel`, and a `RequestID`. A `View` type with `Since` and `Unread`/`AnyUnread` operations sits over it. [OBSERVED — `board.(*View).Since` at file offset 40,762,550; `board.View.AnyUnread` at 40,757,786] The prose model that follows — that posts are append-only and addressed by agent name, with channels and request/response correlation — is **INFERRED from the field set and the accessor names**, not proven by control-flow analysis.

**A member registry with lifecycle state.** [OBSERVED type: `swarm.Member`] The `cli/swarm` package defines a `Member` carrying `Name`, `Role`, `Model`, `State`, `ConversationID`, `Workspace`, and an `Openable bool`. A separate `board.Member` type exists in the native-swarm board package with methods `Live`, `Killed`, `MarkKilled`, `SetState`, `State`, `Sees`, `EffectiveChannels`, and `HomeChannelIn`. [OBSERVED — e.g. `board.(*Member).MarkKilled` at 40,759,106; `board.(*Member).Sees` at 40,756,473; `board.(*Lifecycle).Note` at 40,755,746] That the registry tracks per-agent liveness and channel membership is **INFERRED from those method names**.

**Per-task artifact files on disk.** [OBSERVED path literals] The prompts direct every agent to write into a `.agents/teamwork/` state tree: a single `ORIGINAL_REQUEST.md`, per-agent `BRIEFING.md` / `handoff.md` / `progress.md`, per-segment `handoff_<index>.md`, and per-synthesis `candidate_<index>.md`. Scratch work goes to a `teamwork_tmp` directory. [OBSERVED — offsets tabulated in §6] The board itself is plausibly persisted alongside as `board.jsonl`. [OBSERVED that the literal `board.jsonl` exists at 105,759,229; INFERRED that it is this board's backing file — the binding is not proven; see §8]

The three mechanisms are complementary rather than redundant [INFERRED]: the board carries agent-to-agent **traffic** (posts, requests, control), the registry carries **presence** (who is alive, on which model, in which channel), and the filesystem carries **durable per-task handoff state** that survives context loss and succession.

---

## 2. Board message schema (`board.Message`)

The complete type is recoverable because Go emits generic instantiations (here of `slices.Reverse`) that print the full struct shape. The literal begins at **file offset 40,757,180**, package `google3/third_party/jetski/cortex/core/native_swarm/board`. [OBSERVED]

```text
struct {
    Seq       uint64            `json:"seq"`
    Agent     string            `json:"agent"`
    Text      string            `json:"text"`
    Time      string            `json:"time"`
    Kind      board.MessageKind `json:"kind,omitempty"`
    RequestID string            `json:"request_id,omitempty"`
    Channel   string            `json:"channel,omitempty"`
    Control   *board.Control    `json:"control,omitempty"`
}
```

| # | Field | Go type | JSON key | Inferred purpose |
|---:|---|---|---|---|
| 1 | `Seq` | `uint64` | `seq` | Monotonic sequence number, assigned per post and used to order the board. [OBSERVED field+tag; INFERRED purpose] |
| 2 | `Agent` | `string` | `agent` | Author's registered name; the address used for `@name` posts. [INFERRED from name + prompt's `@%s` usage] |
| 3 | `Text` | `string` | `text` | Message body. [INFERRED from name] |
| 4 | `Time` | `string` | `time` | Timestamp. Stored as `string`, so the wire format is not constrained by the type. Actual layout is UNKNOWN. [OBSERVED type; INFERRED purpose] |
| 5 | `Kind` | `board.MessageKind` | `kind,omitempty` | Message-class enum (e.g. ordinary post vs. control). The enum's member values are UNKNOWN. [OBSERVED field; INFERRED purpose; UNKNOWN values] |
| 6 | `RequestID` | `string` | `request_id,omitempty` | Correlation key pairing a request with its response(s) across agents. [INFERRED from name] |
| 7 | `Channel` | `string` | `channel,omitempty` | Channel/topic the post belongs to. Optional in JSON. Semantics are UNKNOWN (§8). [OBSERVED field; UNKNOWN semantics] |
| 8 | `Control` | `*board.Control` | `control,omitempty` | Optional pointer to a control payload (the board also exposes `board.ApplyControl` at 40,757,947 and `board.HasControl`). **The `board.Control` struct itself is UNKNOWN** — no instantiation-printing literal for it was recovered. [OBSERVED field+accessors; UNKNOWN schema] |

Tag-level observations [OBSERVED]:

- `seq`, `agent`, `text`, and `time` have **no** `omitempty`; `kind`, `request_id`, `channel`, and `control` do. This means the first four are always serialized and the last four are dropped when zero-valued. [OBSERVED — read from the tags]
- `Seq` is `uint64`, not `int64` or a string, which is consistent with a monotonic counter rather than a timestamp-derived identifier. [OBSERVED type; INFERRED intent]
- `RequestID` is present on the **message**, not on a separate envelope, so request/response correlation is a per-post property. [OBSERVED layout; INFERRED consequence]

The `board.MessageKind` type name appears in the same blob at file offset 40,757,481. [OBSERVED]

---

## 3. Member schema (`swarm.Member`)

Recovered from the `slices.ContainsFunc` generic instantiation beginning at **file offset 47,248,753**, package `google3/third_party/jetski/cli/swarm`. [OBSERVED]

```text
struct {
    Name           string
    Role           string
    Model          string
    ModelLabel     string
    State          string
    Failure        string
    ConversationID string
    Workspace      string
    AddedBy        string
    Openable       bool
}
```

| # | Field | Go type | Inferred purpose |
|---:|---|---|---|
| 1 | `Name` | `string` | Member identifier; the address targeted by `@name` and the key used by the TUI roster. [INFERRED] |
| 2 | `Role` | `string` | Agent role/archetype (e.g. follower, synthesizer). [INFERRED from name] |
| 3 | `Model` | `string` | Model identifier backing the member. [INFERRED] |
| 4 | `ModelLabel` | `string` | Human-readable display label for the model. [INFERRED] |
| 5 | `State` | `string` | Lifecycle state of the member. Permitted values are UNKNOWN. [OBSERVED type; UNKNOWN values] |
| 6 | `Failure` | `string` | Failure detail populated when the member is in a failed state. [INFERRED] |
| 7 | `ConversationID` | `string` | Identifier of the member's underlying conversation/session. [INFERRED] |
| 8 | `Workspace` | `string` | Workspace (directory/root) the member operates in. [INFERRED] |
| 9 | `AddedBy` | `string` | Name of the agent or user that added the member to the swarm. [INFERRED] |
| 10 | `Openable` | `bool` | **INFERRED** boolean UI affordance — whether the member's conversation can be opened from the roster view. Not evidenced beyond the name and its co-location with `cli/swarm/tui`. [INFERRED] |

Two structural observations [OBSERVED, consequences INFERRED]:

- **No JSON tags.** Unlike `board.Message`, `swarm.Member`'s instantiation carries no struct tags. This is consistent with `swarm.Member` being an in-process/UI model rather than the board wire format. It is a negative observation, so the conclusion is INFERRED.
- **A second, distinct member type exists.** `board.Member` (package `cortex/core/native_swarm/board`) is *not* the same type as `swarm.Member`. `board.Member` exposes methods `Live` (40,758,947), `Killed` (40,758,866), `MarkKilled` (40,759,106), `SetState` (40,759,730), `State` (40,759,650), `Sees` (40,756,473), `EffectiveChannels` (40,756,060), `HomeChannelIn` (40,756,314), plus free functions `board.RoleOf`, `board.StateOf`, `board.AddedByOf`, and `board.(*Roster).SortedNames`. [OBSERVED symbol names] Its field layout was not recovered as an instantiation string, so the `board.Member` struct is **UNKNOWN**; only its method surface is OBSERVED. Do not conflate the two `Member` types.

### 3.1 Live-swarm state (`cli/swarm/live`)

The `live` package holds the CLI's current view of a swarm behind an atomic pointer. The generic instantiations at **file offset 47,256,373** print the payload type verbatim [OBSERVED]:

```text
struct {
    convID string
    key    string
    snap   *swarm.Snapshot
}
```

| Field | Type | Inferred purpose |
|---|---|---|
| `convID` | `string` | Conversation the live snapshot belongs to. [INFERRED] |
| `key` | `string` | Cache/lookup key for the snapshot. [INFERRED] |
| `snap` | `*swarm.Snapshot` | Pointer to the current swarm snapshot. The `swarm.Snapshot` struct itself was not recovered; its fields are UNKNOWN. [OBSERVED type; UNKNOWN fields] |

The payload is read and written through `sync/atomic.(*Pointer[...]).Load`, `.Store`, `.CompareAndSwap`, and `.Swap`. [OBSERVED symbol names] This is consistent with lock-free publication of an immutable snapshot to the TUI, but the concurrency guarantees are **INFERRED** from the atomic API surface.

---

## 4. Posting and sequencing

### 4.1 The post-progress format string

The byte sequence at **file offset 106,837,153** is, verbatim [OBSERVED]:

```text
Post %d/%d (seq #%d by %s
```

Argument roles [INFERRED from placeholder order]:

| Placeholder | Meaning |
|---|---|
| `%d/%d` | Post index out of a total — i.e. "post *i* of *n*", a batch/progress counter rather than an identifier. |
| `seq #%d` | The board's sequence number for this post. |
| `by %s` | The authoring agent's name. |

**Precision note.** The evidence brief rendered this string with a trailing `)`. The measured bytes do **not** contain a closing parenthesis: the byte immediately after the 25-byte literal is `a`, the first character of the adjacent literal `available_commands_update` at 106,837,178. The literal is therefore exactly 25 bytes, `Post %d/%d (seq #%d by %s`. [OBSERVED — re-verified with `xxd -s 106837153 -l 26`] Whether a `)` is appended elsewhere at render time is **UNKNOWN**; it was not observed. This is an instance of the merged-literal layout documented in `02-agent-registry.md`: adjacent literals share a run with no NUL separator, so a suffix can appear to belong to a neighbouring format string.

### 4.2 Head read and open operations

| Literal (verbatim) | File offset | Reading |
|---|---:|---|
| `read swarm board head: %w` | 106,837,128 | Error-wrapper for a **head-read** operation: the board is read from its head (oldest end) and a failure is wrapped as `read swarm board head: <err>`. [OBSERVED string; INFERRED direction from "head"] |
| `open swarm %s: %w` | 106,303,574 | Error-wrapper for opening a named swarm (`%s`), typically when rehydrating from disk. [OBSERVED string; INFERRED purpose] |

The `read ... head:` phrasing implies a file-backed log read from the beginning rather than a random-access query. [INFERRED] The literal `read %s: %w` also occurs adjacent to `board.jsonl` at 105,759,229, which is consistent with a single read routine used for the board file. [OBSERVED adjacency; INFERRED]

### 4.3 Ordering — what is and is not established

- **Within a message, ordering is carried by `Seq uint64`.** [OBSERVED field] That `Seq` is assigned monotonically and used to sort the board is **INFERRED** from its type, the `seq #%d` format, and the presence of view operations `board.(*View).Since`, `board.View.Latest`, `board.View.Unread`, and `board.View.AnyUnread`. [OBSERVED symbols]
- **Whether `seq` is global across the whole board or allocated per-channel is UNKNOWN.** No evidence recovered distinguishes the two. The coexistence of a single `Seq` field with a `Channel` field is compatible with either scheme. [UNKNOWN]
- **Per-viewer read position is plausible.** `board.(*MemberState).CatchUp` (40,759,813) and `board.(*MemberState).FastForwardAuthor` (40,759,900) suggest each member tracks how far it has consumed the board and can advance past a specific author; `board.(*View).Since` (40,762,550) suggests a "give me everything after position *x*" query. [OBSERVED symbols; INFERRED semantics] This is *consistent with* a single monotonic sequence space, but is **not proof** of one.
- **Concurrency is guarded.** A `board.LockedStore` type exists; its method value `board.LockedStore.ChannelActive-fm` is spelled out at 40,782,928. `board.NewRateLimiter` and `board.(*RateLimiter).Allow` exist at 40,755,277 and 40,759,565. [OBSERVED symbols] That a lock protects the board store and that a rate limiter throttles posting is **INFERRED from names**. The actual conflict-resolution policy is UNKNOWN (§8).
- **Write-path validation exists.** `board.ValidatePost` (40,760,158), `board.ValidatePostChannel`, `board.validateAuthor`, `board.ValidateChannelName`, and `board.NormalizeChannel` (40,756,847) are all OBSERVED symbol names. [OBSERVED] Their rules are UNKNOWN.

---

## 5. Channel model — existence only

Channels are more than a vestigial field, but their rules are not recovered. [OBSERVED names; UNKNOWN semantics]

| Symbol | File offset | Inference |
|---|---:|---|
| `board.DefaultChannels` | 40,756,142 | A default channel set exists. [INFERRED] |
| `board.EffectiveChannels` / `board.(*Member).EffectiveChannels` | 40,756,060 | A member's channels are computed, not just stored — likely defaults + inheritance + explicit subscriptions. [INFERRED] |
| `board.InheritChannels` | 40,758,402 | Channels can be inherited (e.g. child agents from a parent). [INFERRED] |
| `board.ChannelMentions` / `board.MentionsIn` / `board.SeesIn` | 40,755,356 / 40,755,436 / 40,756,402 | `@name` addressing is channel-scoped. [INFERRED] |
| `board.NormalizeChannel` / `board.ValidateChannelName` | 40,756,847 / 40,760,484 | Channel names are canonicalised and validated. [INFERRED] |
| `board.(*Member).HomeChannelIn` | 40,756,314 | A member has a "home" channel within a context. [INFERRED] |
| `board.PrepareChannelOp` / `board.SubscribeOp` | 40,758,167 / 40,758,091 | Channel membership changes are explicit operations. [INFERRED] |

What a channel *does* — broadcast scope, delivery ordering, whether posts are visible only to members whose effective channels include the message's channel, whether channels are per-conversation or per-swarm — is **UNKNOWN**. [UNKNOWN]

---

## 6. On-disk task artifacts

All paths below are OBSERVED literals unless a row says otherwise. Templated segments (`<...>`, `*`) are the binary's own placeholders, not editorial.

| Path pattern | Purpose | Evidence |
|---|---|---|
| `.agents/teamwork/ORIGINAL_REQUEST.md` | The routed/dispatched request, recorded **once**, before the chosen agent starts. Prompt text: "record the text you route on ... once, before that agent starts, in `.agents/teamwork/ORIGINAL_REQUEST.md` (not the workspace root)". | Literal at 113,252,859 and 113,276,556. [OBSERVED] |
| `BRIEFING.md` | Per-agent mission/identity file that the agent re-reads when it leaves context (sentinel monitors with it). | Literal at 108,360,964. [OBSERVED] |
| `handoff.md` | Per-agent handoff report following the 5-part protocol (Observation, Logic Chain, Caveats, Conclusion, Verification Method). | Literal at 108,613,368; `Verification Method` at 108,613,447. [OBSERVED] |
| `.agents/teamwork/segment_<segment_name>/handoff_<candidate_index>.md` | Candidate review written by an analyst for one segment, read by the group orchestrator. | Literal `.agents/teamwork/segment_<segment_name>/handoff_<candidate_index>.md` at 115,094,780; concrete example at 115,094,866. [OBSERVED] |
| `.agents/teamwork/synthesis/candidate_<index>.md` | Candidate report written by a level-0 synthesizer before reduction. | Literal at 115,099,834; example at 115,099,895. [OBSERVED] |
| `teamwork_tmp` (scratch) | Per-run scratch area; prompt: use `<appDataDir>/scratch/teamwork_tmp/<conversation-id>` (or `<appDataDir>/brain/<conversation-id>/scratch/teamwork_tmp` when unwritable) and "delete only that directory" before handoff. | Literal `teamwork_tmp` at 111,760,275. [OBSERVED] |
| `board.jsonl` | Probable board persistence file (JSONL = one JSON object per line, matching an append-only board). Its directory binding is not proven. | Literal at 105,759,229, 111,917,078, 112,244,999. [OBSERVED literal; INFERRED purpose] |

### 6.1 The `.agents/` versus `agents/` discrepancy — flagged

The evidence brief listed several paths **without** the leading dot: `agents/teamwork/ORIGINAL_REQUEST.md`, `agents/teamwork/segment_segment4/handoff_1.md`, and `agents/teamwork/synthesis/candidate_1.md`. The measured bytes disagree in a specific, explainable way:

- A leading-dot literal `.agents/teamwork/ORIGINAL_REQUEST.md` **does exist** at 113,252,859. The dotless match at 113,252,860 is the **same bytes minus the leading byte** — i.e. a substring of the dotted literal, not a separate string. [OBSERVED — `xxd` confirms byte `0x2e` (`.`) at 113,252,859 and `a` at 113,252,860]
- The same holds for the segment and synthesis paths: `.agents/teamwork/segment_...` exists at 115,094,780 and the dotless form at 115,094,867 is its substring. At 115,099,834 the dotted synthesis path is the literal. [OBSERVED]
- A search for a standalone dotless `agents/teamwork/...` literal (one not preceded by `.`) found **none**. [OBSERVED — negative result]

**Conclusion:** the canonical form in the prompts is **`.agents/teamwork/`**; the dotless forms in the brief were substring artefacts of a `grep -F` match landing one byte into the same literal. This is a reporting inconsistency in the evidence summary, not two competing path conventions in the product. Separately, the prompt makes the `.agents/` tree *relocatable*: it may resolve to `<appDataDir>/scratch/teamwork/<run_id>/.agents/teamwork/` rather than a workspace-relative directory (`<appDataDir>/scratch/teamwork` literal at 111,756,294; `<run_id>` at 111,756,307). [OBSERVED prompt prose; consequence INFERRED] An unrelated literal `agents/*.md` at 105,656,027 is a glob for agent markdown files and is **not** part of the task-artifact set.

---

## 7. Roles in coordination

Each entry names the source-file provenance string for the role's implementation and summarises what the role does in the coordination layer. File-provenance strings are OBSERVED; behavioural descriptions are INFERRED from naming plus prompt text unless quoted.

**Conductor** — `pipeline_conductor.go` at file offset 48,231,081. [OBSERVED] The name identifies it as the pipeline's sequencing component. [INFERRED] Plausibly it walks pipeline stages and dispatches stages in order; the exact state machine is UNKNOWN.

**Pipeline blackboard updater** — `pipeline_blackboard_updater.go` at 48,230,992. [OBSERVED] A blackboard is a shared state area; this component presumably writes pipeline state into it. [INFERRED] Whether "blackboard" here means the same `board.Message` store or a different structure is UNKNOWN.

**Swarm blackboard updater** — `swarm_blackboard_updater.go` at 48,232,193. [OBSERVED] The swarm equivalent of the pipeline blackboard updater: it maintains shared swarm state for follower/orchestrator coordination. [INFERRED] The two updaters being distinct files implies two coordination substrates or two writers for different states. [INFERRED]

**Sentinel agent** — `pipeline_sentinel_agent.go` at 48,231,161. [OBSERVED] The sentinel is the top-level router and monitor: the recovered prompt (`prompts/sentinel-routing.md`) has it record `ORIGINAL_REQUEST.md`, spawn the orchestrator, and run two crons. [OBSERVED prompt text] "Agent" in the filename may denote the sentinel's own agent definition rather than a separate worker. [INFERRED]

**Follower** — `swarm_follower.go` at 48,232,279; role text at 108,449,168. [OBSERVED] Verbatim: "coordinate on the board, and do not repeat @%s's work." [OBSERVED] This is direct evidence that followers communicate through the board and are addressed by `@name`, and that duplicate-work avoidance is delegated to the follower itself rather than enforced centrally.

**Assembler / synthesizer** — `swarm_synthesizer.go` at 48,232,435, with the sibling `swarm_orchestrator.go` at 48,232,355. [OBSERVED] The synthesizer writes `synthesis/candidate_<index>.md` and later levels reduce candidates. [OBSERVED prompt text at 115,099,834] "Assembler" is not an observed name; it is the prompt's aggregation/reduction concept. [INFERRED]

**Sentinel monitoring and cleanup crons** — `Sentinel Monitoring` at 113,255,263; `Cron 1 — Progress Reporting` (`*/8 * * * *`) at 113,255,357 with `Read the active orchestrator` at 113,255,406; `Cron 2 — Liveness Check` (`*/20 * * * *`) at 113,255,858; `*/8` at 113,255,391 and `*/20` at 113,255,888. [OBSERVED] Cron 1 reads the orchestrator's `progress.md` and `BRIEFING.md` and, "when progress changed", scans recently modified workspace files and reports to the user; Cron 2 kills and re-spawns a dead orchestrator via `manage_subagents(Action="kill", ...)` and never `kill_all`. [OBSERVED prompt text] A `Cleanup` step cancels crons and timers before killing subagents, and is explicitly withheld on mid-run pauses and on `VICTORY REJECTED`. [OBSERVED prompt text]

---

## 8. What is not established (UNKNOWN)

The following are not determinable from the recovered static evidence. Each is written literally as UNKNOWN; none is inferred past the point the evidence supports.

| # | Unknown | Why it remains unknown |
|---:|---|---|
| 1 | **Board persistence format and location.** A `board.jsonl` literal exists (105,759,229) and `open swarm %s: %w` / `read swarm board head: %w` exist, but no literal binds `board.jsonl` to a directory, and no serialisation schema beyond the `Message` JSON tags was recovered. Whether one board file exists per swarm, per conversation, or per run is UNKNOWN. |
| 2 | **Concurrency control and conflict handling.** `board.LockedStore` and `board.RateLimiter` exist as names, but the lock scope, contention policy, and what happens on a rejected post are not recoverable. Whether posting is optimistic, serialised, or best-effort is UNKNOWN. |
| 3 | **Channel semantics.** `DefaultChannels`, `EffectiveChannels`, `InheritChannels`, `ChannelMentions`, `NormalizeChannel`, `PrepareChannelOp`, and `SubscribeOp` exist as names, but broadcast scope, visibility rules, and per-channel ordering are not established. |
| 4 | **`board.Control` schema.** It is observed only as a `*board.Control` field plus the accessors `board.ApplyControl` and `board.HasControl`. Its fields, its `Kind` values, and the operations it can command are UNKNOWN. |
| 5 | **Retention and compaction.** No trimming, compaction, or rotation literal was found (`Trim*`, `Compact*`, and `Rotate*` scans returned nothing attributable to the board). Whether boards grow unbounded, and what `Seq` does after any reset, is UNKNOWN. |
| 6 | **Whether `seq` is global or per-board/per-channel.** Only a single `uint64` field is observed; its allocation scope is not evidenced. This directly blocks any claim about cross-channel total order. |
| 7 | **`board.Member` field layout and `State`/`Kind` enumerations.** The method surface is OBSERVED, the struct is not. Concrete values of `swarm.Member.State`, `board.Member.State`, and `board.MessageKind` are UNKNOWN. |
| 8 | **`Time` encoding.** The field is `string`; RFC 3339 versus another layout, and whether it is UTC, are UNKNOWN. (Prompt prose asks agents to "Use UTC timestamps" for request records at 113,277,215, but that is prompt policy, not board encoding.) |
| 9 | **Rendering of the post-progress line.** The format string has no closing `)` byte at 106,837,153; whether one is appended at runtime is UNKNOWN. |
| 10 | **Runtime behaviour generally.** No execution was performed. Every "does X" statement in this document is either quoted prompt text or INFERRED from symbol/field names. |

---

## Appendix — Citation index

| Item | File offset | Section |
|---|---:|---|
| `board.Message` struct instantiation | 40,757,180 | §2 |
| `board.MessageKind` type name | 40,757,481 | §2 |
| `swarm.Member` struct instantiation | 47,248,753 | §3 |
| `live` state struct (`convID`, `key`, `snap *swarm.Snapshot`) | 47,256,373 | §3.1 |
| `pipeline_conductor.go` | 48,231,081 | §7 |
| `pipeline_blackboard_updater.go` | 48,230,992 | §7 |
| `pipeline_sentinel_agent.go` | 48,231,161 | §7 |
| `swarm_orchestrator.go` | 48,232,355 | §7 |
| `swarm_follower.go` | 48,232,279 | §7 |
| `swarm_synthesizer.go` | 48,232,435 | §7 |
| `swarm_blackboard_updater.go` | 48,232,193 | §7 |
| `board.jsonl` | 105,759,229 / 111,917,078 / 112,244,999 | §6, §8 |
| `open swarm %s: %w` | 106,303,574 | §4 |
| `read swarm board head: %w` | 106,837,128 | §4 |
| `Post %d/%d (seq #%d by %s` | 106,837,153 | §4 |
| `BRIEFING.md` | 108,360,964 | §6 |
| `coordinate on the board, and do not repeat` | 108,449,168 | §7 |
| `handoff.md` | 108,613,368 | §6 |
| `teamwork_tmp` | 111,760,275 | §6 |
| `.agents/teamwork/ORIGINAL_REQUEST.md` | 113,252,859 / 113,276,556 | §6 |
| `Sentinel Monitoring` | 113,255,263 | §7 |
| `Cron 1 — Progress Reporting` | 113,255,357 | §7 |
| `Cron 2 — Liveness Check` | 113,255,858 | §7 |
| `*/8` / `*/20` | 113,255,391 / 113,255,888 | §7 |
| `## Parameters` | 113,276,951 | §6 (request recording) |
| `How this run was launched; not part of the task.` | 113,277,002 | §6 |
| `.agents/teamwork/segment_*/handoff_*.md` | 115,094,780 | §6 |
| `.agents/teamwork/synthesis/candidate_*.md` | 115,099,834 | §6 |

Reproduce offsets with, for example:

```sh
grep -aobF 'Post %d/%d (seq #%d by %s' /tmp/opencode/antigravity-re/antigravity
xxd -s 106837153 -l 26 /tmp/opencode/antigravity-re/antigravity
dd if=/tmp/opencode/antigravity-re/antigravity bs=1 skip=40757180 count=900 2>/dev/null \
  | tr -c '[:print:]\n' '.'
```
