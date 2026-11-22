# Coordination and Artifacts — Antigravity `/teamwork`

Static-analysis reconstruction of how the Google Antigravity Linux CLI's `/teamwork` subsystem coordinates multiple agents, and what it leaves on disk. [OBSERVED] Every fact labelled OBSERVED below was measured either from the extracted binary identified in `00-artifact-identity.md` (SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`) by string and offset inspection, or — where marked **OBSERVED — source** — from the shipped builtin tree at a cited `file:line`. No part of the binary was executed, and no network or authentication was used. [OBSERVED]

Companion documents: `00-artifact-identity.md` (binary identity, section map), `01-command-contract.md` (command surface), `02-agent-registry.md` (the 49-entry agent roster, now fully bound name → runtime type → description → tool allowlist via pclntab + RELA decoding; the remaining unknowns are per-agent model tiers, cascade config and the `indexByName` key), `09-swarm-board-and-skills.md` (the coordination layer re-derived from the materialised builtin source: board files, ordering, channels, wake/park/nudge, concurrency), `PROVENANCE.md` (chain of custody, licensing, method limits), `prompts/sentinel-routing.md` (recovered routing prompt text).

**Reconciliation with the materialised source.** This edition is cross-checked against the shipped builtin tree under `/home/john/.gemini/antigravity-cli/builtin` (captured into `assets/builtin/`). Statements taken from it are cited as `path:line` and analysed in `09-swarm-board-and-skills.md`; the binary-offset citations of this document are unchanged. The two evidence kinds are labelled separately: **OBSERVED** with a decimal offset means read from the binary, **OBSERVED — source** with `file:line` means read from the shipped text. Where the binary left the board's storage, ordering or channel semantics `UNKNOWN`, the sidecar that reads those files settles them; the Go struct shapes below remain the **in-memory superset**, and the persisted record is the subset that survives `omitempty` (§2.1).

## Confidence Legend

| Label | Meaning |
|---|---|
| **OBSERVED** | Directly read from the artifact: a byte sequence at a measured file offset, or a type/function path present in the binary. Earned by quoting the value and its offset. |
| **OBSERVED — source** | Read directly in the shipped builtin tree at a cited `path:line` (sidecar JavaScript, manifests, skills). Used for statements about the board files and the Swarm feature that the binary cannot show; `09-swarm-board-and-skills.md` owns the full analysis. |
| **INFERRED** | Derived by reasoning over observed data (field names, JSON tags, function-name morphology, prompt prose). Earned by stating the premises. |
| **UNKNOWN** | Not measured, or not determinable from the available evidence. Written literally as `UNKNOWN`; never guessed. |

Reading note: a field's **existence, name, type, and JSON tag** are OBSERVED when reproduced inside a Go generic-instantiation string; what the field *does at runtime* is usually INFERRED from its name and is marked as such. [POLICY — definitions]

---

## 1. Coordination model overview

The `/teamwork` subsystem uses three coordination mechanisms that are visible in the binary as (a) a Go message type, (b) a member-registry type, and (c) a set of on-disk path literals. [OBSERVED for the types and paths; INFERRED for the composition] The board's file format, location and ordering are now read from the shipped sidecar that consumes it (§2.1, §4.3, §6.2), which is why its entry below carries source citations as well as binary ones.

**A shared, append-ordered board.** [OBSERVED type: `board.Message`] The `cortex/core/native_swarm/board` package defines a `Message` with a `Seq uint64` sequence field, an `Agent` author field, a `Text` body, a `Channel`, and a `RequestID`. A `View` type with `Since` and `Unread`/`AnyUnread` operations sits over it. [OBSERVED — `board.(*View).Since` at file offset 40,762,550; `board.View.AnyUnread` at 40,757,786] The board is now established as an append-only JSONL log, one record per line, addressed by agent name and optionally by channel: the materialised sidecar reads `board.jsonl`, derives recipients from `@name`/`@all`/`@#channel` in the text, and replays channel controls in file order (`09` §§3–5). What remains **INFERRED** is request/response correlation: `request_id` has no consumer in the native-swarm reader, so this document does not claim it as part of the swarm protocol.

**A member registry with lifecycle state.** [OBSERVED type: `swarm.Member`] The `cli/swarm` package defines a `Member` carrying `Name`, `Role`, `Model`, `State`, `ConversationID`, `Workspace`, and an `Openable bool`. A separate `board.Member` type exists in the native-swarm board package with methods `Live`, `Killed`, `MarkKilled`, `SetState`, `State`, `Sees`, `EffectiveChannels`, and `HomeChannelIn`. [OBSERVED — e.g. `board.(*Member).MarkKilled` at 40,759,106; `board.(*Member).Sees` at 40,756,473; `board.(*Lifecycle).Note` at 40,755,746] That the registry tracks per-agent liveness and channel membership is **INFERRED from those method names**.

**Per-task artifact files on disk.** [OBSERVED path literals] The prompts direct every agent to write into a `.agents/teamwork/` state tree: a single `ORIGINAL_REQUEST.md`, per-agent `BRIEFING.md` / `handoff.md` / `progress.md`, per-segment `handoff_<index>.md`, and per-synthesis `candidate_<index>.md`. Scratch work goes to a `teamwork_tmp` directory. [OBSERVED — offsets tabulated in §6] Separately, the **native swarm** board persists as `board.jsonl` in `<appData>/brain/<coordinatorConv>/.system_generated/swarm/`, beside a `members.json` roster. [OBSERVED — source: `plugins/swarm/sidecars/swarm_board/main.mjs:134`, `:724`; `09` §§2–3] That binding is proven for the Swarm feature; it is **not** proven for `/teamwork-preview`, and no recovered `/teamwork-preview` prompt or symbol binds it to `board.jsonl` (`09` §11). The earlier reading of `board.jsonl` as a probable `/teamwork` artifact is withdrawn as unsupported.

The mechanisms are complementary rather than redundant [INFERRED]: the board carries agent-to-agent **traffic** (posts, channel controls, wake cursors) and belongs to the native-swarm feature; the registry carries **presence** (who is alive, on which model, in which channel); and the `.agents/teamwork/` filesystem carries **durable per-task handoff state** for `/teamwork-preview` that survives context loss and succession. The board and the teamwork file tree are not shown to be the same substrate, and this document does not merge them.

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
| 1 | `Seq` | `uint64` | `seq` | Per-board sequence number, assigned per post. The board's head is the last line's `seq` and unread is `head − last_read_seq`; the reader displays file order and does not sort by `seq` (§2.1, §4.3). [OBSERVED field+tag; OBSERVED — source for use; allocation site UNKNOWN] |
| 2 | `Agent` | `string` | `agent` | Author's registered name; the address used for `@name` posts. [INFERRED from name + prompt's `@%s` usage] |
| 3 | `Text` | `string` | `text` | Message body. [INFERRED from name] |
| 4 | `Time` | `string` | `time` | Timestamp. Stored as `string`. **Settled** from the reader: `"YYYY-MM-DD HH:MM:SS"` in the Language Server host's local time, parsed by replacing the space with `T` (`main.mjs:509-515`; `09` §3.1). [OBSERVED type; OBSERVED — source layout] |
| 5 | `Kind` | `board.MessageKind` | `kind,omitempty` | Message-class enum (e.g. ordinary post vs. control). No consumer in the native-swarm reader and no value observed on disk, so whether native swarm emits it, and the enum's members, are UNKNOWN (`09` §3.1). [OBSERVED field; INFERRED purpose; UNKNOWN values] |
| 6 | `RequestID` | `string` | `request_id,omitempty` | Plausible correlation key pairing a request with its response(s), but not established: the native-swarm reader never consults it and the board pairs nothing (`09` §3.4). [INFERRED from name; usage UNKNOWN] |
| 7 | `Channel` | `string` | `channel,omitempty` | Channel/topic the post belongs to; absent or `""` means `main`, and a named channel exists only after a `create` control. **Established** from the materialised source (`channels.mjs:66-67`, `:203-220`; `09` §5). [OBSERVED field and semantics] |
| 8 | `Control` | `*board.Control` | `control,omitempty` | Optional control payload (the board also exposes `board.ApplyControl` at 40,757,947 and `board.HasControl`). The **key names are now established** from the reader's mirror: `{op, channel, topic, members, prev, next}`, with `op ∈ create, archive, subscribe, unsubscribe`; `prev`/`next` map a member name to its stored set or `null` (`channels.mjs:8-10`, `:86-96`, `:203-220`; `09` §5). The Go struct's own field types and tags remain unrecovered. [OBSERVED field+accessors; OBSERVED — source for keys and ops; UNKNOWN Go layout] |

Tag-level observations [OBSERVED]:

- `seq`, `agent`, `text`, and `time` have **no** `omitempty`; `kind`, `request_id`, `channel`, and `control` do. This means the first four are always serialized and the last four are dropped when zero-valued. [OBSERVED — read from the tags]
- `Seq` is `uint64`, not `int64` or a string, which is consistent with a monotonic counter rather than a timestamp-derived identifier. [OBSERVED type; INFERRED intent]
- `RequestID` is present on the **message**, not on a separate envelope, so *if* request/response correlation exists it is a per-post property. [OBSERVED layout; INFERRED consequence; whether it is used at all is UNKNOWN — §2.1]

The `board.MessageKind` type name appears in the same blob at file offset 40,757,481. [OBSERVED]

### 2.1 In-memory superset vs persisted record

The sidecar reads each line of `board.jsonl` for `seq`, `agent`, `text` and `time`, plus two optional keys, `channel` and `control`. Nothing in the tree reads `kind` or `request_id`. [OBSERVED — source: `board_cache.mjs:367-382`; `channels.mjs:66-70`; negative result for `kind`/`request_id`]

| Field | On disk? | Evidence |
|---|---|---|
| `seq` | always | read at `board_cache.mjs:371`; tag has no `omitempty` |
| `agent` | always | read at `board_cache.mjs:372`; tag has no `omitempty` |
| `text` | always | read at `board_cache.mjs:373`; tag has no `omitempty` |
| `time` | always | read at `board_cache.mjs:374`; tag has no `omitempty` |
| `channel` | only when not `main` | `channels.mjs:66-67`; `omitempty` |
| `control` | only on control lines | `channels.mjs:70`; `omitempty` |
| `kind` | never observed | no consumer in this tree |
| `request_id` | never observed | no consumer in this tree |

[OBSERVED — source for the left and middle columns; INFERRED that the persisted line is exactly the `omitempty` projection of `board.Message`]

The four always-present keys are precisely the four tags without `omitempty`, and the two optional keys are two of the four tags that carry it. That is a direct structural match, not a naming coincidence: the Go struct printed at 40,757,180 is the **in-memory superset**, and `board.jsonl` stores the subset that survives encoding. [INFERRED from the tag set (OBSERVED at 40,757,180) and the reader's field access (OBSERVED at `board_cache.mjs:367-382`); premises both stated]

Two further settlements for §8:

- **`time` encoding.** The reader documents and implements `"YYYY-MM-DD HH:MM:SS"` in the Language Server host's local time, parsed by replacing the space with `T`; an unparseable value becomes `null` rather than a guessed instant (`main.mjs:509-515`). [OBSERVED — source; the comment states the writer's format and the parser accepts exactly that shape]
- **Board identity.** A board is one `board.jsonl` under the coordinator's conversation, and workers' panes resolve to it by roster membership (`main.mjs:220-225`, `:268-288`; `09` §2.1). It is not a per-run or per-agent file. [OBSERVED — source]

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
- **A second, distinct member type exists.** `board.Member` (package `cortex/core/native_swarm/board`) is *not* the same type as `swarm.Member`. `board.Member` exposes methods `Live` (40,758,947), `Killed` (40,758,866), `MarkKilled` (40,759,106), `SetState` (40,759,730), `State` (40,759,650), `Sees` (40,756,473), `EffectiveChannels` (40,756,060), `HomeChannelIn` (40,756,314), plus free functions `board.RoleOf`, `board.StateOf`, `board.AddedByOf`, and `board.(*Roster).SortedNames`. [OBSERVED symbol names] Its field layout was not recovered as an instantiation string, so the `board.Member` struct is still **UNKNOWN**; only its method surface is OBSERVED. Do not conflate the two `Member` types.

**The persisted roster is a third shape.** `members.json` — the file the pane reads — is

```text
{"title","members":{name:{conversation_id,model,role,wake_mode,wait_since,
                         last_read_seq,last_nudged_seq,last_park_blocked_seq,killed}}}
```

with optional `channels`, `workspace` and `workspace_mode`. [OBSERVED — source: `plugins/swarm/sidecars/swarm_board/README.md:25`; `main.mjs:817-845`; `09` §4] It is neither `swarm.Member` (the CLI/UI model above) nor `board.Member`: it stores four cursors (`wait_since`, `last_read_seq`, `last_nudged_seq`, `last_park_blocked_seq`) that neither Go shape shows, and it omits `ModelLabel`, `State`, `Failure`, `AddedBy` and `Openable`. The three shapes share `role`, `model` and `conversation_id` naming but are distinct models; this document does not treat one as another's serialisation.

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
| `read swarm board head: %w` | 106,837,128 | Error-wrapper for reading the board's **head**. In this product the head is the *newest* position — the `seq` of the last line (`main.mjs:765`), from which unread is measured as `head − last_read_seq` (`main.mjs:808`). The earlier reading of "head" as the oldest end is withdrawn; the sidecar's vocabulary is unambiguous. [OBSERVED string; OBSERVED — source for the meaning] |
| `open swarm %s: %w` | 106,303,574 | Error-wrapper for opening a named swarm (`%s`), typically when rehydrating from disk. [OBSERVED string; INFERRED purpose] |

`read ... head:` is consistent with reading the log up to its current position, which is exactly what the sidecar does: a full read of `board.jsonl` from offset 0, then a verified tail read on each poll (`board_cache.mjs:164-212`). The literal `read %s: %w` also occurs adjacent to `board.jsonl` at 105,759,229, which is consistent with a single read routine used for the board file. [OBSERVED adjacency; INFERRED — and now corroborated by the reader]

### 4.3 Ordering and sequencing — now settled as to scope

- **Within a message, ordering is carried by `Seq uint64`.** [OBSERVED field] That `Seq` is monotonic in practice is **INFERRED** from its type, the `seq #%d` format, and the view operations `board.(*View).Since`, `board.View.Latest`, `board.View.Unread`, and `board.View.AnyUnread`. [OBSERVED symbols]
- **`seq` is one number space per board, shared by every channel.** This is now established from how the file is consumed: the board head is the last line's `seq` regardless of channel (`main.mjs:765`); a member has one `last_read_seq` and `unread = head − last_read_seq` (`main.mjs:801-808`); the delta cursor is a message index validated against the `seq` at that index (`main.mjs:1407-1411`); channel `create`/`archive` controls carry `seq` into the same axis (`channels.mjs:157-177`); and subscription state is replayed from the log in array order (`channels.mjs:98-111`, `:203-220`). [OBSERVED — source expressions; INFERRED that the scope follows]
- **Message order is file order, not a `seq` sort.** No reader sorts messages; `seq` is an identifier and cursor, and the file is assumed to be written in order. A line written out of order would display in file order while `head` follows the last line. [OBSERVED — absence of a comparator; INFERRED consequence]
- **`seq` allocation is not established.** The sidecar neither appends nor increments `seq`; it reads whatever each line carries (`board_cache.mjs:371`; `main.mjs:12`). Where the Go writer keeps its counter, and whether it survives a board rewrite, is outside the materialised source and remains UNKNOWN (§8). The `head` fallback `|| msgs.length` (`main.mjs:765`) is consistent with a 1-based contiguous board but does not prove one. [OBSERVED — source; UNKNOWN allocator]
- **Per-viewer read position is established.** `board.(*MemberState).CatchUp` (40,759,813) and `board.(*MemberState).FastForwardAuthor` (40,759,900) suggested it; the roster's `last_read_seq` and the unread computation prove the concept, and the skill's "set its board cursor past the startup briefs" (`skills/native_swarm/SKILL.md:347-350`) shows it is advanced on `add`. [OBSERVED — source; the free functions' own rules remain UNKNOWN]
- **Concurrency is guarded on both ends, by different means.** The binary has a `board.LockedStore` type (method value `board.LockedStore.ChannelActive-fm` at 40,782,928) and a rate limiter (`board.NewRateLimiter` 40,755,277, `board.(*RateLimiter).Allow` 40,759,565). [OBSERVED symbols; their policy INFERRED from names, UNKNOWN] The read side needs no lock because it only reads: it verifies inode, head anchor, tail anchor and the unremembered trailing bytes, and falls back to a full read on any mismatch (`board_cache.mjs:78-117`, `:147-162`; `09` §7). What the writer's lock protects, and whether a line append is one atomic write, remains UNKNOWN.
- **Write-path validation exists, and one rule is now known.** `board.ValidatePost` (40,760,158), `board.ValidatePostChannel`, `board.validateAuthor`, `board.ValidateChannelName`, and `board.NormalizeChannel` (40,756,847) are OBSERVED symbol names. [OBSERVED] The channel-name rule is established from the reader's mirror: `^[a-z][a-z0-9-]{0,23}$`, with `main`, `all` and `here` reserved (`channels.mjs:119-120`). The remaining validation rules are UNKNOWN.

---

## 5. Channel model — established from the reader's mirror

The binary gave only symbol names. The materialised sidecar carries an explicit, pure-JS mirror of the board package's channel rules, and states that it is tested against the same table as the Go code:

> "Mentions and channel visibility for the Swarm pane, mirroring the native_swarm board package (board/mentions.go, board.ChannelsAt and board.Member.Sees). Pure functions, no I/O … the Go test runs them against the same table as the Go code, board/testdata/sees_cases.json, so the two cannot drift."

[OBSERVED — source: `plugins/swarm/sidecars/swarm_board/channels.mjs:1-11`]

That makes the rules below **OBSERVED — source**, with one honest caveat: the Go implementation is the original and the JavaScript is the mirror, so a mirror bug would show up as a rule stated here that the writer does not implement. The mirror's own README and tests are the defence, not this document.

| Symbol (binary offset) | What the mirror establishes | Evidence |
|---|---|---|
| `board.DefaultChannels` (40,756,142) / `board.EffectiveChannels` (40,756,060) | A member's set is explicit if stored; otherwise coordinator/narrator/monitor get `["*"]` and workers get `main` only. `main` is implied, never stored. | `channels.mjs:72-84` |
| `board.InheritChannels` (40,758,402) | A helper added by a worker "joins its adder's channels unless `channels` says otherwise" (skill prose, not mirror code). | `skills/native_swarm/SKILL.md:269-271` [INFERRED] |
| `board.ChannelMentions` (40,755,356) / `board.MentionsIn` (40,755,436) | `@#name` parses at a word start, lowercases, must match the channel grammar, and addresses every member whose set (as of that message) holds the channel or `*`, while the channel is active. `@#main` is parsed but calls nobody. | `channels.mjs:113-150` |
| `board.SeesIn` (40,756,402) | A message is visible if it is on `main`, the member's own post, a channel the set holds (or `*`), or a post that calls on the member. | `channels.mjs:179-187` |
| `board.NormalizeChannel` (40,756,847) / `board.ValidateChannelName` (40,760,484) | Channel names are `^[a-z][a-z0-9-]{0,23}$`; `main`, `all`, `here` are reserved. | `channels.mjs:119-120` |
| `board.(*Member).HomeChannelIn` (40,756,314) | The brief is posted in the worker's first channel, which is where its posts go by default (skill prose). | `skills/native_swarm/SKILL.md:266-268` [INFERRED] |
| `board.PrepareChannelOp` (40,758,167) / `board.SubscribeOp` (40,758,091) | Subscription changes are log controls (`subscribe`/`unsubscribe`) carrying `members` and `prev`/`next` maps; each takes effect from its own message onward. | `channels.mjs:86-111` |

The model in full:

- **One `main`, plus named channels created on demand.** `main` is the absence of a `channel` value (`channels.mjs:66-67`); a named channel exists only after an `op:"create"` control, and `op:"archive"` stops it without deleting history (`channels.mjs:203-220`).
- **Broadcast scope is subscription-based, not sender-based.** The sender writes a channel name; the reader decides who can see it from each member's set *as of that message* (`channels.mjs:98-111`, `:179-187`). It is therefore possible for a post in `#parser` to be invisible to a worker who was moved out of `#parser` later, and visible to one who was moved in before it — the history is positional.
- **Mentions cross channels; channel posts do not.** `@name`/`@all` reach a member regardless of channel (`channels.mjs:141-150`); an unaddressed post in `#parser` reaches only `#parser`'s subscribers, plus the roles that see every channel (`skills/native_swarm/SKILL.md:297-300`, `:352-355`).
- **"Unread" means "visible and after my cursor".** Control messages never count, and a message the member cannot see is not unread even if its `seq` is newer (`channels.mjs:189-191`, `:232-240`).
- **Channels are per board.** One channel registry serves the whole swarm; the board itself is rooted at the coordinator's conversation (§2.1), so a worker's pane resolves to the same channels as the coordinator's.
- **Ordering is not per channel.** One log, one `seq` space (§4.3).

What remains open about channels is not the visibility rule but its **enforcement and delivery**: whether the writer rejects a post to an unknown/archived channel at post time (`board.ValidatePostChannel` exists; its rule is not recovered), and whether delivery is push-to-subscriber inside the Language Server or pull by each member on wake. The mirror proves what a member *sees*; it does not prove what wakes a parked member for a channel post. The skill's contract says an `anything` waiter wakes for its own channels and `main`, and a `mentions` waiter only for a name/`@all`/`@#its-channel` (`skills/native_swarm/SKILL.md:297-305`, `:322-324`), and that is the best available statement of delivery. [OBSERVED — source for visibility; INFERRED for delivery]

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
| `board.jsonl` | The **native-swarm** board log: append-only JSONL, one message per line, under `<appData>/brain/<coordinatorConv>/.system_generated/swarm/`. Its directory binding is proven for the Swarm feature; it is not part of `.agents/teamwork/` and is not proven for `/teamwork-preview` (`09` §11). | Literal at 105,759,229, 111,917,078, 112,244,999 [OBSERVED literal]; binding OBSERVED — source: `main.mjs:134`, `main.mjs:724`; `SB/README.md:19-24` |

### 6.1 The `.agents/` versus `agents/` discrepancy — flagged

The evidence brief listed several paths **without** the leading dot: `agents/teamwork/ORIGINAL_REQUEST.md`, `agents/teamwork/segment_segment4/handoff_1.md`, and `agents/teamwork/synthesis/candidate_1.md`. The measured bytes disagree in a specific, explainable way:

- A leading-dot literal `.agents/teamwork/ORIGINAL_REQUEST.md` **does exist** at 113,252,859. The dotless match at 113,252,860 is the **same bytes minus the leading byte** — i.e. a substring of the dotted literal, not a separate string. [OBSERVED — `xxd` confirms byte `0x2e` (`.`) at 113,252,859 and `a` at 113,252,860]
- The same holds for the segment and synthesis paths: `.agents/teamwork/segment_...` exists at 115,094,780 and the dotless form at 115,094,867 is its substring. At 115,099,834 the dotted synthesis path is the literal. [OBSERVED]
- A search for a standalone dotless `agents/teamwork/...` literal (one not preceded by `.`) found **none**. [OBSERVED — negative result]

**Conclusion:** the canonical form in the prompts is **`.agents/teamwork/`**; the dotless forms in the brief were substring artefacts of a `grep -F` match landing one byte into the same literal. This is a reporting inconsistency in the evidence summary, not two competing path conventions in the product. Separately, the prompt makes the `.agents/` tree *relocatable*: it may resolve to `<appDataDir>/scratch/teamwork/<run_id>/.agents/teamwork/` rather than a workspace-relative directory (`<appDataDir>/scratch/teamwork` literal at 111,756,294; `<run_id>` at 111,756,307). [OBSERVED prompt prose; consequence INFERRED] An unrelated literal `agents/*.md` at 105,656,027 is a glob for agent markdown files and is **not** part of the task-artifact set.

### 6.2 Native-swarm state files (not `/teamwork-preview` artifacts)

Beside the task tree, the Swarm feature writes its own coordination state. These files are **not** `.agents/teamwork/` artifacts and no recovered `/teamwork-preview` prompt names them; they are listed here so the two on-disk footprints are not confused (`09` §§2–5).

| File | Shape | Purpose |
|---|---|---|
| `.system_generated/swarm/board.jsonl` | JSONL, one message per line | the append-only board |
| `.system_generated/swarm/members.json` | `{title, members:{name:{…}}}` | roster + wake/read cursors (§3) |
| `.system_generated/swarm/view.json` | narrator Overview data | presentation only; never read for control |
| `.system_generated/swarm/view.html` | narrator template, sandboxed | presentation only |
| `.system_generated/swarm/plan.json` | `{goal,tasks,threads}` | built-in Overview input |
| `.system_generated/logs/transcript.jsonl` (per member) | one step per line | step counts, activity, failure/stuck detection |
| `.system_generated/swarm/swarm.json` (remote) | `{backend,swarm_id,db}` | anchor for a multi-machine board; no local log |

[OBSERVED — source: `SB/README.md:22-28`; `main.mjs:297-298`, `:720-731`, `:921-931`; `skills/swarm_pane/SKILL.md:22-29`]

---

## 7. Roles in coordination

Each entry names the source-file provenance string for the role's implementation and summarises what the role does in the coordination layer. File-provenance strings are OBSERVED; behavioural descriptions are INFERRED from naming plus prompt text unless quoted.

**Conductor** — `pipeline_conductor.go` at file offset 48,231,081. [OBSERVED] The name identifies it as the pipeline's sequencing component. [INFERRED] Plausibly it walks pipeline stages and dispatches stages in order; the exact state machine is UNKNOWN.

**Pipeline blackboard updater** — `pipeline_blackboard_updater.go` at 48,230,992. [OBSERVED] A blackboard is a shared state area; this component presumably writes pipeline state into it. [INFERRED] Whether "blackboard" here means the same `board.Message` store or a different structure is UNKNOWN.

**Swarm blackboard updater** — `swarm_blackboard_updater.go` at 48,232,193. [OBSERVED] The swarm equivalent of the pipeline blackboard updater: it maintains shared swarm state for follower/orchestrator coordination. [INFERRED] The two updaters being distinct files implies two coordination substrates or two writers for different states. [INFERRED]

**Sentinel agent** — `pipeline_sentinel_agent.go` at 48,231,161. [OBSERVED] The sentinel is the top-level router and monitor: the recovered prompt (`prompts/sentinel-routing.md`) has it record `ORIGINAL_REQUEST.md`, spawn the orchestrator, and run two crons. [OBSERVED prompt text] "Agent" in the filename may denote the sentinel's own agent definition rather than a separate worker. [INFERRED]

**Follower** — `swarm_follower.go` at 48,232,279; role text at 108,449,168. [OBSERVED] Verbatim: "coordinate on the board, and do not repeat @%s's work." [OBSERVED] This is direct evidence that followers are told to coordinate through a board and are addressed by `@name`, and that duplicate-work avoidance is delegated to the follower itself rather than enforced centrally. **Caution:** the sentence is `/teamwork-preview` prompt prose and uses "the board" as a teamwork concept. No recovered teamwork file writes `board.jsonl`, and the persisted board is bound to the native-swarm feature (`09` §11). The quote proves the instruction, not the substrate.

**Assembler / synthesizer** — `swarm_synthesizer.go` at 48,232,435, with the sibling `swarm_orchestrator.go` at 48,232,355. [OBSERVED] The synthesizer writes `synthesis/candidate_<index>.md` and later levels reduce candidates. [OBSERVED prompt text at 115,099,834] "Assembler" is not an observed name; it is the prompt's aggregation/reduction concept. [INFERRED]

**Sentinel monitoring and cleanup crons** — `Sentinel Monitoring` at 113,255,263; `Cron 1 — Progress Reporting` (`*/8 * * * *`) at 113,255,357 with `Read the active orchestrator` at 113,255,406; `Cron 2 — Liveness Check` (`*/20 * * * *`) at 113,255,858; `*/8` at 113,255,391 and `*/20` at 113,255,888. [OBSERVED] Cron 1 reads the orchestrator's `progress.md` and `BRIEFING.md` and, "when progress changed", scans recently modified workspace files and reports to the user; Cron 2 kills and re-spawns a dead orchestrator via `manage_subagents(Action="kill", ...)` and never `kill_all`. [OBSERVED prompt text] A `Cleanup` step cancels crons and timers before killing subagents, and is explicitly withheld on mid-run pauses and on `VICTORY REJECTED`. [OBSERVED prompt text]

---

## 8. What is not established (UNKNOWN)

The first edition's ten unknowns were partly a consequence of static-only evidence. The materialised sidecar settles six of them without disassembly, because it reads the same files the Go writer produces. Those are listed first as **closed**; the table after them is everything that remains open.

| Was unknown | Now | Evidence |
|---|---|---|
| Board persistence format and location | `board.jsonl` (one JSON message per line) plus `members.json`, under `<appData>/brain/<coordinatorConv>/.system_generated/swarm/` | §2.1, §6.2; `main.mjs:134`, `:724` |
| Reader-side concurrency and malformed lines | Append-verified tail read (inode + 64-byte head/tail anchors + remainder), full-read fallback, epoch invalidation; malformed lines skipped, torn tail retried | §4.3, `09` §7 |
| Channel semantics | `main` + named channels; role-based defaults; log-replayed subscriptions; visibility, unread and `@#` rules | §5 |
| `board.Control` schema | Key names and ops established: `{op, channel, topic, members, prev, next}`; `op ∈ create, archive, subscribe, unsubscribe` | §5; `channels.mjs:8-10`, `:86-96` |
| Whether `seq` is global or per-channel | One number space per board, shared by all channels and control lines; display order is file order | §4.3, `09` §3.3 |
| `Time` encoding | `"YYYY-MM-DD HH:MM:SS"` in the LS host's local time | §2.1; `main.mjs:509-515` |

Remaining unknowns:

| # | Unknown | Why it remains unknown |
|---:|---|---|
| 1 | **`seq` allocation.** Where the counter lives, how it is made monotonic, and whether it survives a board rewrite or reset. | The reader consumes `seq` and never writes or increments it (`board_cache.mjs:371`; `main.mjs:12`). Only a writer-side read or a live run can settle it. |
| 2 | **Writer serialisation and conflict policy.** What `board.LockedStore` locks, whether a line append is one atomic write, and what happens to a rejected post. | Symbol names only; `board.ValidatePost`/`board.NewRateLimiter` are not disassembled here. The reader's anchor checks make it *tolerant* of a torn tail, not proof of a writer policy. |
| 3 | **`board.Control` Go layout.** Field types, JSON tags, and whether `Kind` participates in control dispatch. | The JavaScript mirror gives key names and operations, not the struct declaration. |
| 4 | **Retention and compaction.** Whether `board.jsonl` is ever trimmed, rotated, or compacted, and what `Seq` does after any reset. | No such code exists in the sidecar; the skill says the board is permanent (`skills/native_swarm/SKILL.md:351-352`), which is a contract, not a writer implementation. |
| 5 | **`board.Member` field layout and enumerations.** Concrete values of `swarm.Member.State`, `board.Member.State` and `board.MessageKind`. | Method surface OBSERVED, struct not recovered; the persisted roster is a different shape and does not carry `State`. |
| 6 | **`kind` / `request_id` usage.** Whether native swarm ever emits them, and whether another consumer pairs requests by `request_id`. | No consumer in the materialised tree; both are dropped by `omitempty` and never observed on disk. |
| 7 | **Channel-post delivery.** Whether a channel post is pushed to subscribers or each member discovers it on wake, and whether the writer rejects a post to an unknown/archived channel. | The mirror proves visibility and unread; it does not prove delivery. Skill prose is the only evidence for wake scope. |
| 8 | **Whether `/teamwork-preview` uses this board.** | The board is bound to the native-swarm feature (`main.mjs:134`; package `cortex/core/native_swarm/board`); no recovered `/teamwork-preview` file names it, and the two features use different tool verbs and flags (`09` §11). Coexistence in one binary does not establish composition. |
| 9 | **Rendering of the post-progress line.** | The format string still has no closing `)` byte at 106,837,153; whether one is appended at runtime is UNKNOWN. |
| 10 | **Runtime behaviour of `/teamwork-preview` generally.** | No execution of the workflow was performed (`07` is quota-blocked). Every "does X" statement about teamwork remains prompt text or INFERRED from symbols. |

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

Materialised-source citations added in this edition (all relative to the builtin tree; see `09` for the full index):

| Item | Location | Section |
|---|---|---|
| Swarm state directory | `plugins/swarm/sidecars/swarm_board/main.mjs:134` | §2.1, §6.2 |
| `board.jsonl` read | `plugins/swarm/sidecars/swarm_board/main.mjs:724` | §2.1 |
| Board head / unread | `main.mjs:765`, `main.mjs:801-816` | §2.1, §4.3 |
| Roster projection | `main.mjs:817-845`; `plugins/swarm/sidecars/swarm_board/README.md:25` | §3, §6.2 |
| Delta cursor validation | `main.mjs:1407-1413` | §4.3 |
| Board parse / skip policy | `plugins/swarm/sidecars/swarm_board/board_cache.mjs:33-46` | §2.1, §4.3 |
| Append-verified tail read | `board_cache.mjs:78-117`, `:147-162` | §4.3 |
| `seq` consumption | `board_cache.mjs:367-382` | §2.1, §4.3 |
| Channel accessors / defaults | `plugins/swarm/sidecars/swarm_board/channels.mjs:66-84` | §5 |
| Channel history / registry | `channels.mjs:98-111`, `:203-230` | §5 |
| Visibility / unread | `channels.mjs:179-240` | §5 |
| Mentions / `@#channel` | `channels.mjs:22-60`, `:113-150` | §5 |
| `wake_mode` / status fallback | `main.mjs:495-507` | §3, §8 |
| `swarm_wait` DONE boundary | `main.mjs:428-460` | §4.3, §8 |
| `time` format | `main.mjs:509-515` | §2.1, §8 |
| Status vocabulary (four values) | `skills/native_swarm/SKILL.md:140-151` | §8 |
| Board tools injected late | `skills/native_swarm/SKILL.md:331-336` | §8 |
| Sidecar flags | `plugins/swarm/sidecars/swarm_board/sidecar.json:1-26` | §6.2 |

Reproduce offsets with, for example:

```sh
grep -aobF 'Post %d/%d (seq #%d by %s' /tmp/opencode/antigravity-re/antigravity
xxd -s 106837153 -l 26 /tmp/opencode/antigravity-re/antigravity
dd if=/tmp/opencode/antigravity-re/antigravity bs=1 skip=40757180 count=900 2>/dev/null \
  | tr -c '[:print:]\n' '.'
```
