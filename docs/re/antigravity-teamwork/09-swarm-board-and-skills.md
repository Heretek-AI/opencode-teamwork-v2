# Swarm Board and Coordination Skills — Materialised Source

This document reconstructs the **native swarm** coordination layer from the shipped builtin tree

```text
/home/john/.gemini/antigravity-cli/builtin/     (read-only source of truth for this document)
```

as captured into [`assets/builtin/`](assets/builtin/) (see [`assets/PROVENANCE-ASSETS.md`](assets/PROVENANCE-ASSETS.md)). Every mechanical claim below is bound to a `file:line` in that tree. Unlike `00`–`08`, nothing here is inferred from stripped machine code: the sidecar JavaScript, the plugin manifests and the four skills are shipped *text*, so the reader's behaviour is directly readable.

**Version scope.** The captured tree in [`assets/builtin/`](assets/builtin/) is the **1.5.14** builtin (`.checksum` `builtin:f46b8917…`). The installed tree at `/home/john/.gemini/antigravity-cli/builtin/` is now **1.5.16** (`.checksum` `builtin:3499ad60…`, 46 files); at the **1.5.15** step (`.checksum` `builtin:930df4a7…`) five `swarm_board` sidecar files (`app.js`, `board_cache.mjs`, `hive.js`, `main.mjs`, `README.md`) differed and eleven skills were added (`agy-customizations`, `antigravity_guide`, `automation`, `conversations`, `generative_ui`, `mcp-app-development`, `migrate-agent-settings`, `migrate-workflows`, `permissioned-github`, `plugin`, `ui-plugin-navigation`). The `file:line` citations below were measured against the **1.5.14** capture and may drift in 1.5.15 or 1.5.16; where a cited line matters, re-read it in the capture, not the live tree. See [`live/VERSION-FORK.md`](live/VERSION-FORK.md). [OBSERVED — `diff -rq`]

**What this changes in the set.** `05-coordination-and-artifacts.md` recovered `board.Message` and `swarm.Member` from Go generic instantiations and had to leave the board's persistence location, ordering scope and channel semantics `UNKNOWN`. The materialised sidecar settles those: the persisted board is `board.jsonl`, one record per line, under a **per-conversation** swarm directory; `seq` is one number space per board; the channel model is `main` plus named channels with log-derived subscriptions. [OBSERVED]

**What this document does not prove.** The sidecar is a *reader*. It writes no file and messages no agent (`plugins/swarm/sidecars/swarm_board/main.mjs:12`, `plugins/swarm/sidecars/swarm_board/README.md:368-369`), and its HTTP surface is `GET` only (`main.mjs:1307-1421`). Everything below about the **writer** — who allocates `seq`, what lock serialises appends — is therefore out of reach of *this source* and is marked as such. One live swarm directory is now available as a second evidence class (§2.4): it shows the records one writer actually emitted, but not the code that emitted them, so it narrows the `UNKNOWN`s without closing them. Throughout, `[OBSERVED — disk]` marks a value read from that live directory and `[OBSERVED — source]` (or plain `[OBSERVED]` where the citation is a `file:line`) marks a value read from the shipped tree.

## Confidence Legend

| Label | Meaning |
|---|---|
| **OBSERVED** | Read directly in the materialised file at the cited `path:line`. (In this document a citation is a line in the builtin tree, not a byte offset in the binary; `00`–`08` keep the offset convention.) |
| **INFERRED** | Derived from OBSERVED code, with the premises stated. |
| **UNKNOWN** | Not settled by the materialised source. Written literally as `UNKNOWN`, never guessed. |

Path shorthand used throughout, relative to `builtin/`:

| Shorthand | Path |
|---|---|
| `SB/` | `plugins/swarm/sidecars/swarm_board/` |
| `S/` | `skills/` |

---

## 1. The materialised source set

| File | Lines | Role |
|---|---:|---|
| `SB/main.mjs` | 1,431 | Sidecar backend: swarm resolution, roster/transcript reads, snapshot build, HTTP routes |
| `SB/board_cache.mjs` | 463 | Incremental `board.jsonl` / `transcript.jsonl` readers and the derived-board cache |
| `SB/channels.mjs` | 240 | Pure mirrors of the Go board's mention, channel, visibility and unread rules |
| `SB/README.md` | 379 | Sidecar contract, file table, status derivation, Overview frame, HTTP API |
| `SB/sidecar.json` | 26 | Sidecar process definition, feature flags, aux-pane view |
| `plugins/swarm/plugin.json` | 6 | Plugin name, display name, description, logo |
| `plugins/swarm/README.md` | 1 | Title only (`# Swarm Plugin`) — no content |
| `S/native_swarm/SKILL.md` | 375 | Coordinator skill: the four board tools and the operating loop |
| `S/swarm_monitor/SKILL.md` | 117 | Stall-monitor worker skill: cron tick + `read_board{status:true}` |
| `S/swarm_narrator/SKILL.md` | 229 | Narrator worker skill: owns `view.json` / `view.html` |
| `S/swarm_pane/SKILL.md` | 52 | Coordinator skill for the built-in Overview: `plan.json` + screenshot lines |

The plugin is enabled only where native swarm is: "The plugin is enabled by default wherever native swarm is (`enable-native-swarm`); without it, the Language Server neither runs this sidecar nor lists the plugin." [OBSERVED — `SB/README.md:371-376`]

---

## 2. Where swarm state lives

### 2.1 The directory is derived from the coordinator's conversation

```js
const swarmDir = (appData, conv) => join(appData, 'brain', conv, '.system_generated', 'swarm');
```

[OBSERVED — `main.mjs:134`]

So the on-disk layout is:

```text
<appData>/brain/<coordinatorConv>/.system_generated/swarm/{board.jsonl,members.json,view.json,view.html,plan.json}
<appData>/brain/<memberConv>/.system_generated/logs/transcript.jsonl      (per member, one each)
<appData>/brain/<narratorConv>/swarm_view/{view.json,view.html,prefs.md}  (narrator fallback)
```

[OBSERVED — `main.mjs:134`, `main.mjs:297-298`, `main.mjs:640-648`; `SB/README.md:19-28`; `S/swarm_narrator/SKILL.md:26-39`]

There is **one board per swarm**, and a swarm is identified by the **coordinator's conversation id**: a conversation owns a swarm if `members.json` exists in its own `swarmDir` (`locate`, `main.mjs:220-225`), otherwise the pane scans rosters to find which conversation's swarm lists it (`resolve`, `main.mjs:268-288`; scan cache TTL 3 s at `main.mjs:238-262`). The API's `swarm` field is that coordinator conversation id, not a separate swarm id (`main.mjs:1392-1400`).

`appData` is the sidecar's own data dir, found by walking up from `ANTIGRAVITY_EXECUTABLE_DATA_DIR` to the `sidecar_data` component (`main.mjs:113-128`). Opened standalone it reads every `~/.gemini/<product>` that has a `brain/` (`main.mjs:125-127`; `SB/README.md:30-33`).

### 2.2 File contract

| File | Shape | Written by |
|---|---|---|
| `board.jsonl` | append-only JSONL, one message object per line | the Go board writer (`05` §4); sidecar reads only |
| `members.json` | `{"title","members":{name:{conversation_id,role,desired_state,desired_model,applied_model,workspace_mode,phase,wake_mode,wait_since,last_read_seq,last_nudged_seq,last_park_blocked_seq,killed,model}}}` — the README documents only the nine-key subset | the Go board writer |
| `view.json` | narrator Overview data (schema in §8) | the narrator worker |
| `view.html` | narrator Overview template, sandboxed | the narrator worker |
| `plan.json` | `{goal,tasks,threads}` for the built-in Overview | the coordinator (`S/swarm_pane/SKILL.md:19-37`) |
| `transcript.jsonl` (per member) | one step per line; `PLANNER_RESPONSE` steps carry `thinking`, `tool_calls` | the Language Server |
| `swarm.json` | versioned backend anchor. Remote: `{"backend","swarm_id","db"}`, no board. Local (live): `{"version":1,"backend":"local","swarm_id","created_at"}` | the board backend (remote *or* local) |

[OBSERVED — `SB/README.md:22-28`; `main.mjs:720-731`, `main.mjs:297-298`, `main.mjs:921-931`; `S/swarm_pane/SKILL.md:22-29`; the `members.json` and `swarm.json` rows additionally OBSERVED — disk at §2.4]

The **writers are not in this tree**. The "Written by" column is INFERRED from the consuming code and from the skills' statements of ownership; only the narrator's and coordinator's files are described as written by a member (`S/swarm_narrator/SKILL.md:24-44`, `S/swarm_pane/SKILL.md:19-37`). Who writes `board.jsonl` and `members.json`, and with what locking, is outside the materialised source (§3.3, §7.4).

One correction to the file contract above, forced by the live directory: `swarm.json` is **not** remote-only. §2.3 describes the remote anchor as `{"backend","swarm_id","db"}`; the live local swarm wrote `swarm.json` too, with `backend:"local"` and a `created_at` instead of a `db` (§2.4). So the file is present on both backends; its keys differ by backend.

`members.json` fields beyond the nine documented ones — `channels`, `workspace`, `workspace_mode` — are read when present (`main.mjs:744`, `main.mjs:839-840`). The live file adds four more that the sidecar never reads: `desired_state`, `desired_model`, `applied_model`, `phase` (§4). The roster's stored channel set is explicitly **a cache**: the authoritative subscriptions are rebuilt from control messages in the log (`channels.mjs:222-229`, "members.json is only a cache of the log, as in board.RebuildChannels").

### 2.3 Remote boards

A build may read swarms whose members span machines by placing `remote_board.json` next to `main.mjs` (`main.mjs:81-96`). Such a swarm's directory holds only `swarm.json`; roster and messages come from NDJSON on the board CLI's stdout (`main.mjs:887-904`, `main.mjs:1069-1121`). The JSON member/message shapes are the same (`main.mjs:976-992`: "Members carry the members.json keys … plus the owner LS"). **Two backends, one schema** — which is itself evidence that the file schema is the canonical one. [OBSERVED]

### 2.4 One live swarm directory (2026-11-22)

A live run on this machine left a complete local swarm directory, read here as `[OBSERVED — disk]`. It is **one** swarm: every concrete value below is a sample, not a default, and composition, member names, model ids and the presence of any given file must be treated as `UNKNOWN` for other swarms.

Path (the coordinator conversation is the swarm id):

```text
~/.gemini/antigravity-cli/brain/0e3db35c-47d2-4faf-98e6-a2a842cd4fc2/.system_generated/swarm/
```

| File | Size | Content observed |
|---|---:|---|
| `swarm.json` | 117 B | `{"version":1,"backend":"local","swarm_id":"0e3db35c-47d2-4faf-98e6-a2a842cd4fc2","created_at":"2026-11-22T00:30:52Z"}` |
| `plan.json` | 389 B | `{"goal":{"title":"Create and test FizzBuzz in JavaScript","line":"Implement fizzbuzz.js and test.js, then run the test suite."},"tasks":{"coder":"Implement fizzbuzz.js, write test.js, and run tests"},"threads":[{"id":"t-fizzbuzz","title":"FizzBuzz implementation and test","goal":"Create fizzbuzz.js and test.js and verify tests pass.","tasks":["coder"]}]}` |
| `members.json` | 1,593 B | `title:"FizzBuzz module and test suite"`; three members — `coordinator`, `coder`, `monitor` — each with fourteen keys (§4) |
| `board.jsonl` | 2,194 B | four lines, `seq` 1–4 (§3.5) |

Values are quoted exactly; `plan.json`'s whitespace is normalised to one line here (on disk it is pretty-printed across four).

Facts this directory settles, and their limits:

- **`swarm.json` is versioned and backend-tagged, and `swarm_id` equals the coordinator conversation id.** `version:1`, `backend:"local"`, `created_at` an ISO-8601 UTC instant. That is the concrete form of "a swarm is identified by the coordinator's conversation id" (§2.1). [OBSERVED — disk for this swarm; whether `swarm_id` is *always* the coordinator conversation id is INFERRED from §2.1's resolution rule]
- **`plan.json` carries `goal`, `tasks` and `threads` in the shape the pane skill specifies** (`S/swarm_pane/SKILL.md:19-37`), written at swarm creation time (its mtime precedes the board's last line by ~2 minutes). [OBSERVED — disk]
- **No `view.json` and no `view.html`.** This swarm had no narrator, so the built-in Overview files were absent. Absence here is a composition fact (no narrator member), not evidence that narrator files are optional for every swarm. [OBSERVED — disk; generality UNKNOWN]
- **No `channels`, `control` or `channel` key appears anywhere**, so this sample exercises only the `main` channel. [OBSERVED — disk; absence]

---

## 3. `board.jsonl` — record, append path, ordering and `seq`

### 3.1 The persisted record

The documented line is one object with four keys:

```json
{"seq":12,"agent":"parser","text":"@coordinator [done] tests pass","time":"2026-11-21 14:32:10"}
```

[OBSERVED — `SB/README.md:24`]

The reader consumes exactly those four and **two optional keys**:

```js
const seq   = Number(m.seq) || 0;          // board_cache.mjs:371
const agent = String(m.agent ?? '');       // :372
const text  = String(m.text ?? '');        // :373
const time  = m.time || '';                // :374
const channel = channelOf(m);              // :376  -> m.channel, ""/absent = "main"
const control = controlOf(m);              // :377  -> m.control object, else null
```

[OBSERVED — `board_cache.mjs:367-382`; field accessors at `channels.mjs:67`, `channels.mjs:70`]

Nothing in the sidecar **reads** `kind` or `request_id` (a full-text search for both returns only unrelated `failure.kind` uses at `main.mjs:571-575`, `main.mjs:795`, `main.mjs:866`). [OBSERVED — negative result, read path only]

**That negative result does not mean the writer omits them — the live board writes both.** All four lines of the live `board.jsonl` (§3.5) end with a `request_id`, and the two coordinator briefs (seq 1–2) additionally carry `kind:"brief"`. First line, with only its long `text` elided:

```json
{"seq":1,"agent":"coordinator","text":"@coder You own …","time":"2026-11-21 19:30:54","kind":"brief","request_id":"e20dee73-85ca-4027-8fdc-2ab40cd1c9ba"}
```

[OBSERVED — disk, §2.4] So the precise statement, which replaces an earlier inference in this document, is:

| Key | Read by the sidecar? | Written by the live board? |
|---|---|---|
| `seq`, `agent`, `text`, `time` | yes (`board_cache.mjs:371-374`) | yes, all four lines |
| `channel`, `control` | yes (`channels.mjs:67`, `channels.mjs:70`) | not exercised in this swarm (no channels) |
| `kind` | no | yes — `"brief"` on the two coordinator briefs (seq 1–2) |
| `request_id` | no | yes — on every line |

A reader that inspected only `board_cache.mjs` would conclude `kind`/`request_id` are dead fields. They are not dead; they are *written but unread by this sidecar*. Who consumes them, and what `kind` values exist besides `brief`, is `UNKNOWN` — the live file shows one value only.

**Reconciliation with `05` §2.** `05` recovered an 8-field `board.Message` from a Go instantiation: `seq`, `agent`, `text`, `time` without `omitempty`; `kind`, `request_id`, `channel`, `control` with `omitempty`. That is exactly what the live file shows: the four core keys on every line, `kind` and `request_id` on the lines that set them, and no `channel`/`control` in a channel-free swarm. The struct is the **in-memory superset**; the persisted line is its `omitempty` projection, and the writer *does* populate two of the four optional fields. [OBSERVED — tags (`05` §2), reader field set, and the live lines; INFERRED that `channel`/`control` serialise the same way when a writer sets them, since this sample had neither]

### 3.2 The append path, as far as a reader can see it

`readBoardCached` (`board_cache.mjs:192-212`) is the whole board read path:

1. `probeFile` stats the file; an exact `mtime+size+inode` hit returns the cached array; otherwise, if the file only grew, `readAppendedTail` reads from the last newline offset (`board_cache.mjs:147-162`).
2. A full read splits at the **last newline**: bytes before it are `completeBuf`; bytes after it are `remBuf` (`board_cache.mjs:164-185`).
3. Complete lines are parsed and concatenated onto the previous complete set; the remainder is parsed separately and appended if it already parses (`board_cache.mjs:202-206`).
4. The cache stores `readOffset`, a 64-byte head anchor, a 64-byte tail anchor, and the un-newlined remainder (`board_cache.mjs:209-210`).

[OBSERVED]

The file is therefore assumed **append-only and single-writer**. An append is parsed as "new complete lines at the tail"; a shrink, inode change, or changed anchor/prefix bytes forces a full re-read (`board_cache.mjs:78-117`, `board_cache.mjs:189-191`). The reader has no write path, no lock, and no repair. [OBSERVED]

### 3.3 `seq`: one number space per board

`seq` is not allocated, normalised or rewritten anywhere in the sidecar. It is taken from each line as-is (`board_cache.mjs:371`) and trusted as the board's position marker. Five independent consumers prove the **scope**:

| Evidence | What it proves |
|---|---|
| `const head = msgs.length ? Number(msgs[msgs.length - 1].seq) \|\| msgs.length : 0;` (`main.mjs:765`) | The board has **one head** — the `seq` of the last line — regardless of the message's channel. |
| `unread = Math.max(0, head - last)` (`main.mjs:808`), with one `last_read_seq` per member (`main.mjs:801`, `main.mjs:825`) | A member has **one read cursor**, not one per channel, so all channels share one position space. |
| Delta request: `known <= snap.messages.length && snap.messages[known - 1]?.seq === since` (`main.mjs:1407-1411`) | The client's cursor is a **message index into one interleaved array**, validated against the `seq` at that index. |
| Channel create/archive controls record `Number(m.seq)` and are compared against each message's `seq` (`channels.mjs:157-177`) | Control lines occupy the **same sequence axis** as posts and are ordered against them. |
| `channelsAt` replays the log in array order to derive each member's subscription "as of that message" (`channels.mjs:98-111`); `channelRegistry` scans the same log in order (`channels.mjs:203-220`) | Channel state is a **function of board order**, not of per-channel files or counters. |

[OBSERVED for every cited expression; INFERRED from them that `seq` is a single per-board sequence across channels]

Two further observations:

- **Order is file order, not `seq` order.** No code sorts messages: `computeDerivedBoard` iterates `msgs` in the order the file reader produced (`board_cache.mjs:367-369`, `main.mjs:772-777`). `seq` is carried as an identifier and cursor, and the reader *assumes* the file is in `seq` order rather than enforcing it. A board written out of order would display in file order with `head` taken from the last line. [OBSERVED — absence of a comparator; INFERRED consequence]
- **`seq` appears to start at 1 and be contiguous per board.** The `head` fallback is `|| msgs.length` (`main.mjs:765`), which is only equivalent to "last `seq`" if the sequence is 1-based with no gaps; and `last_read_seq` defaults to `0` (`main.mjs:801`) to mean "nothing read". [INFERRED from the fallback; not enforced by any code here]
- **The allocator is outside this source.** No file in the tree increments `seq` or appends a line. The writer is the Go `board` package whose `Post %d/%d (seq #%d by %s` format is recorded in `05` §4.1; its allocation site is `UNKNOWN` here. What is settled is the **scope** (one per board), not the mechanism (where the counter lives). [UNKNOWN for the allocator; OBSERVED for scope]

### 3.4 What the record does not carry

The reader has no edit or delete path, no thread/reply parent, no acknowledgement field, and no per-message recipient list: recipients are *derived* from the text at read time (`mentionsOf`, `channels.mjs:48-54`; the feed prints `→ @a @b` from that derivation, `SB/README.md:253-256`). `request_id` **is** persisted on every live line (§3.5) but has no reader anywhere in this tree, so its pairing role is `UNKNOWN`: the writer distinguishes posts by request id, yet nothing here pairs a reply to a request by it. Request/response pairing is therefore **not part of the board protocol as this source shows it**, even though the field is present on disk. [OBSERVED — writer emits it, no consumer; the "no pairing" reading is INFERRED from the absence of a consumer, not from absence of the field]

The board is documented as permanent: "The board outlives the turn. Everything said is on it, in order, forever" (`S/native_swarm/SKILL.md:351-352`). No compaction, rotation or trimming exists in the sidecar. [OBSERVED for the sidecar; `UNKNOWN` for the writer — see `05` §8]

### 3.5 The live board: four lines, one space

The live swarm's `board.jsonl` (§2.4) has four lines, `seq` 1–4, written across two agents in one sequence space — the first direct confirmation of §3.3's scope claim from a file rather than from a consumer.

| `seq` | `agent` | Role of the line | Keys beyond `seq`/`agent`/`text`/`time` |
|---:|---|---|---|
| 1 | `coordinator` | assigns file ownership: `@coder You own \`/tmp/opencode/agy-run2/fizzbuzz.js\` and \`/tmp/opencode/agy-run2/test.js\`. Do not touch any other files.` then five numbered instructions | `kind:"brief"`, `request_id` |
| 2 | `coordinator` | briefs the monitor: `@monitor You are this swarm's stall monitor. Load the swarm_monitor skill and follow it. Post only to break a stall.` | `kind:"brief"`, `request_id` |
| 3 | `coder` | reports: `@coordinator [done] Created … Verified with \`node /tmp/opencode/agy-run2/test.js\`: exited 0 with \`All fizzbuzz tests passed!\`.` | `request_id` only |
| 4 | `coordinator` | closes: `[done] Created fizzbuzz.js and test.js and verified all tests pass.` | `request_id` only |

[OBSERVED — disk] Observations that follow, each scoped to this sample:

- **`kind` is set on briefs, not on reports.** The only value seen is `"brief"`, on the two lines that assign work. Whether `kind` has other values (a report kind, a control kind) is `UNKNOWN`; line 3, a `[done]` report, carries no `kind` at all.
- **`request_id` is on every line**, including the coordinator's summary, and the four values differ. It looks like a per-post correlation id, not a thread key. Meaning and consumer `UNKNOWN`.
- **`time` is local time with no offset**, `2026-11-21 19:30:54` … `19:32:51`, matching the `YYYY-MM-DD HH:MM:SS` parser contract (§12) and *not* the UTC `created_at` in `swarm.json` (`2026-11-22T00:30:52Z`). The machine's offset is UTC−05:00, so line 1 is `00:30:54Z` — two seconds after `created_at`. The two clocks in one directory are in different zones; do not compare them naively.
- **The monitor never posted.** `seq` 2 briefs it and the coder finished before a stall, so a three-member swarm produced two speakers. Board traffic is not proportional to membership.
- **Ownership is stated in text, not in a field.** Line 1's `You own … Do not touch any other files.` is prose; there is no `owner` or `paths` key. Enforcement, if any, is elsewhere. [OBSERVED — absence]

---

## 4. `members.json` — the roster and its cursors

The sidecar README documents nine keys per member:

```text
{"title",
 "members": { name: { conversation_id, model, role, wake_mode, wait_since,
                      last_read_seq, last_nudged_seq, last_park_blocked_seq, killed } }}
```

[OBSERVED — `SB/README.md:25`; parsed at `main.mjs:171-179`; projected at `main.mjs:817-845`]

The live file carries **fourteen**, in this file order: `conversation_id`, `role`, `desired_state`, `desired_model`, `applied_model`, `workspace_mode`, `phase`, `wake_mode`, `wait_since`, `last_read_seq`, `last_nudged_seq`, `last_park_blocked_seq`, `killed`, `model`. [OBSERVED — disk, §2.4] **The README example is a subset, not the schema.** The sidecar reads the nine documented keys plus `channels`, `workspace` and `workspace_mode`; `desired_state`, `desired_model`, `applied_model` and `phase` are written and never read here. Do not model `members.json` from the README alone — a round-trip through the README's nine keys would drop five persisted fields.

| Field | What the source establishes | Confidence |
|---|---|---|
| `title` | Swarm title; may also arrive later from `agentapi` conversation metadata, which is why it is part of the ETag (`main.mjs:190-212`, `main.mjs:763-764`) | OBSERVED |
| `conversation_id` | The member's own conversation; used to locate its transcript (`main.mjs:297-298`, `main.mjs:768`), and validated against `ID_RE = /^[0-9a-f-]{8,}$/i` before being joined into a path (`main.mjs:33`, `main.mjs:640`, `main.mjs:1214-1216`) | OBSERVED |
| `model` | Model id shown per member (`main.mjs:820`); switching is a `swarm{action:"model"}` operation (`S/native_swarm/SKILL.md:355-370`). In the live file it is byte-identical to `applied_model` on all three members — a persisted duplication, not a separate value | OBSERVED |
| `role` | `coordinator` / `worker` / `narrator` / `monitor` are the roles the code discriminates on (`main.mjs:42-52`, `main.mjs:77`). Live: coordinator role `coordinator`; coder and monitor both role `worker` — the monitor is a *worker* that was briefed as a monitor, not a distinct role | OBSERVED — source + disk |
| `wake_mode` | Parking intent plus a `working` value — see §6.2. Live: coordinator `mentions`, monitor `mentions`, coder `working` (with `desired_state:"KILLED"`) | OBSERVED literals; semantics in §6 |
| `wait_since` | The `seq` the member parked after — see §6.3 | OBSERVED (exposed) + INFERRED (meaning, from monitor skill) |
| `last_read_seq` | The member's read cursor; `unread = head − last_read_seq` | OBSERVED |
| `last_nudged_seq` | Persisted and exposed (`main.mjs:827`); **no consumer** in the sidecar. Live: equals `last_read_seq` on all three members | Field OBSERVED, meaning `UNKNOWN` |
| `last_park_blocked_seq` | Persisted and exposed (`main.mjs:828`); **no consumer**. Live: `0` on all three members | Field OBSERVED, meaning `UNKNOWN` |
| `killed` | Terminal; overrides every other status (`main.mjs:502-503`). Live: `true` for the coder after its completion, `false` for coordinator and monitor | OBSERVED — source + disk |
| `desired_state` | Declarative member state. Live values `RUNNING` (coordinator, monitor) and `KILLED` (coder); not read anywhere in the sidecar | Field OBSERVED — disk; meaning INFERRED from the name; reader `UNKNOWN` |
| `desired_model` | Requested model. Live: `gemini-4-argon-medium` on all three; not read by the sidecar | Field OBSERVED — disk; divergence between desired and applied never exercised in this sample |
| `applied_model` | Model actually in force. Live: same string as `desired_model` and `model` on all three; not read by the sidecar | Field OBSERVED — disk; semantics `UNKNOWN` |
| `workspace_mode` | Live `inherit` on all three; surfaced to the UI when a string (`main.mjs:839-840`) | OBSERVED — disk for the value; other values `UNKNOWN` |
| `phase` | Live `RUNNING` / `KILLED`, tracking `desired_state` in this sample; not read by the sidecar | Field OBSERVED — disk; semantics and state machine `UNKNOWN` |
| `channels` | Optional stored subscription set; `null`/absent means the role default | OBSERVED (`main.mjs:744`, `channels.mjs:79-84`) |
| `workspace` | Optional; surfaced to the UI when a string (`main.mjs:839-840`) | OBSERVED |

The roster is **not** the same type as `swarm.Member` in `05` §3. `swarm.Member` is the CLI/UI model with `Name`, `ModelLabel`, `State`, `Failure`, `Openable`; `members.json` is the persisted board roster with cursors. The two agree on `conversation_id`, `model`, `role` and workspace naming, but they are distinct shapes and neither is proved to be the other's serialisation. [OBSERVED — both shapes; INFERRED that they are separate models]

Presentation order is derived, not stored: coordinator first, then alphabetical (`main.mjs:846-847`). The live file's member order is `coder`, `coordinator`, `monitor` — alphabetical, with the coordinator **not** first — which is consistent with storage order being irrelevant to presentation. [OBSERVED — disk + source]

---

## 5. Channels

### 5.1 Model

- The board always has an implicit channel `main`; a message's channel is `m.channel`, and `""`/absent means `main` (`channels.mjs:13`, `channels.mjs:66-67`).
- Named channels must match `^[a-z][a-z0-9-]{0,23}$`; `main`, `all` and `here` are reserved (`channels.mjs:119-120`).
- A channel exists only once a member creates one; until then the snapshot leaves out every channel field, so a one-channel swarm's snapshot is unchanged from the pre-channel shape (`board_cache.mjs:444-447`, `main.mjs:860`). [OBSERVED]

### 5.2 The registry is rebuilt from the log

`channelRegistry(msgs)` scans every message for a `control` object and returns `[{name, topic, created_by, archived}]` in creation order; `op:"create"` records topic and author, `op:"archive"` sets `archived` (`channels.mjs:203-220`). `activeAt` then computes, per message position, whether a channel is active: it exists in the registry, it has been created by that point, and — if archived at the head — the message predates the archive (`channels.mjs:152-177`). [OBSERVED]

This is why `members.json` can be a cache: subscriptions, topics and archives are all replayable from `board.jsonl` alone.

### 5.3 Defaults: `main` for workers, every channel for the three system roles

```js
const ALL_BY_ROLE = new Set(['coordinator', 'narrator', 'monitor']);
export function effectiveChannels(role, set, name) {
  if (Array.isArray(set)) return set;              // explicit stored set wins
  if (ALL_BY_ROLE.has(role)) return [ALL];         // ALL = '*'
  if ((!role || role === 'worker') && ROLE_WORKER_NAME.test(name)) return [ALL];
  return [];                                       // main only (implied)
}
```

[OBSERVED — `channels.mjs:77-84`]

| Member | Default channels |
|---|---|
| coordinator | all (`["*"]`) |
| narrator, monitor (by role, or by name on older boards) | all |
| worker / roleless | `main` only |
| any member with an explicit `channels` array | that array (`["*"]` means all) |

`main` is not stored in the set — it is implied by `seesIn` (§5.5). [OBSERVED — `channels.mjs:182-187`; INFERRED that `[]` therefore means "main only"]

In skill terms: "Everyone is always in `main`. A member sees `main` plus the channels it is subscribed to; you, the narrator and the monitor see every channel." [OBSERVED — `S/native_swarm/SKILL.md:260-263`]

### 5.4 How a post selects a channel

The selector is the message's own `channel` field (`channels.mjs:66-67`). It is set by the posting tool:

- `post_message{channel:"parser", text}` posts into `#parser`; `channel:"main"` posts to main (`S/native_swarm/SKILL.md:271-273`).
- A worker's brief "is posted in its first channel, which is also where its posts go by default" (`S/native_swarm/SKILL.md:266-268`).
- A helper a worker adds "joins its adder's channels unless `channels` says otherwise" (`S/native_swarm/SKILL.md:269-271`).
- `read_board{channel:"parser"}` reads one channel, `channel:"*"` everything, and no `channel` reads the member's own view (`S/native_swarm/SKILL.md:281-282`).

[OBSERVED for the tool contract as prose; the wire encoding is the `channel` key, OBSERVED at `channels.mjs:67`]

The channel is **not** encoded in `seq`: posts in different channels interleave in one log (§3.3).

### 5.5 Visibility and unread

```js
export function seesIn(name, set, msg, active) {
  const ch = channelOf(msg);
  if (ch === MAIN || msg?.agent === name) return true;   // main and own posts always
  if (set.includes(ALL) || set.includes(ch)) return true; // subscribed (or '*')
  return mentionsIn(msg?.text, name, set, active);        // or called on
}
```

[OBSERVED — `channels.mjs:179-187`]

Consequences, each OBSERVED in the cited function:

- **Control messages are never unread, and carry no addressing** — `countsUnread = !controlOf(msg)` (`channels.mjs:189-191`), and they are emitted with no mentions and no edge counts (`board_cache.mjs:379-382`). When a control line has no `channel` of its own it lands on `main` and is therefore visible to every member; `seesIn` decides that per line, so a control that did name a channel would be visible only under that channel's rule.
- **Unread is visibility-filtered and cursor-based**: `visibleUnread` counts messages the member sees with `seq > last_read_seq` (`channels.mjs:232-240`); the file-board snapshot uses it when channels exist, and the remote CLI supplies its own count (`main.mjs:804-816`).
- **Hidden messages feed the "New" divider.** `unseenBy` returns the `seq`s the pane's member cannot see, computed with the same rules (`main.mjs:1421-1429`); the feed uses the member's read cursor to place the divider (`SB/README.md:279-281`).

### 5.6 Subscriptions are log events with history

`subscribe` / `unsubscribe` controls carry `members` and a `prev`/`next` map of `name → set|null` (`channels.mjs:86-96`). `channelsAt` reconstructs each member's set *as of every message* by starting from the state before the first control that touches it and applying each touching control in order (`channels.mjs:98-111`). `currentChannels` returns the `next` of the last touching control, else the stored set (`channels.mjs:222-230`). [OBSERVED]

That is what makes "it sees the new channel's posts from then on, not earlier ones" true (`S/native_swarm/SKILL.md:273-277`): visibility is evaluated per message against the set in force at that message, not against the current set. [OBSERVED for the mechanism; the skill sentence is the contract]

### 5.7 Addressing: `@name`, `@all`, `@#channel`

- `@name` and `@all` are matched case-insensitively at a word start, not followed by another name character (`channels.mjs:22-39`, `channels.mjs:47-54`). A numbered group's prefix also matches: `@parser` reaches `parser-1`…`parser-k` via `^(.+)-\d+$` (`channels.mjs:41-45`; `S/native_swarm/SKILL.md:286-293`).
- **Mentions cross channels.** `mentionsIn` returns true for a direct mention (or `@all`) regardless of channel; channel addressing is the *additional* path (`channels.mjs:141-150`). Skill: "`@name` reaches its worker whatever channel the post is in, and `@all` is still everyone." (`S/native_swarm/SKILL.md:297-299`)
- **`@#channel` addresses a channel**: parsed as `@#` + a name, `main` accepted as a literal but then excluded by the caller (`channels.mjs:113-139`, `channels.mjs:145-150`). It calls every member whose set (as of that message) holds the channel or `*`, while the channel is active; `@#main` calls nobody (`S/native_swarm/SKILL.md:301-305`).
- `channelAddressees` in the snapshot computes those `@#` recipients and the `channel_mentions` / `via_channel` fields the UI and narrator see (`main.mjs:734-756`, `board_cache.mjs:384-389`). It returns `null` — no channel addressing at all — unless the board has channels **and** some message contains `"@#"` (`main.mjs:738-739`). So an ordinary channel post has no `via_channel` list; it reaches its audience through visibility (§5.5), not through an addressing field. [OBSERVED]

### 5.8 Cost note for the reader

The derived-board cache has an incremental fast path only when the roster shape is unchanged, there are no channels, the new messages are all on `main`, none is a control, and none contains `@#` (`board_cache.mjs:429-441`). Any channel traffic forces a full replay of the board (`board_cache.mjs:442-454`). This is a correctness choice, not a semantic one, but it explains why large channel boards are re-derived rather than appended. [OBSERVED]

### 5.9 Summary

| Question | Answer | Evidence |
|---|---|---|
| What channels exist? | `main` always; named channels only after a `create` control | `channels.mjs:13`, `channels.mjs:203-220` |
| Default subscriptions | coordinator/narrator/monitor all; workers main-only | `channels.mjs:77-84` |
| How a post selects one | the message's `channel` key; absent = main | `channels.mjs:66-67` |
| Who sees a channel post | subscribers, `*` holders, its author; plus anyone it @mentions | `channels.mjs:179-187` |
| What wakes a mentions-only waiter | `@name` / prefix / `@all` / `@#their-channel`, from any channel | `channels.mjs:141-150`; `S/native_swarm/SKILL.md:284-305` |
| What wakes an anything-waiter | any post it can see in its channels or main | `S/native_swarm/SKILL.md:297-300` |
| Per-channel ordering? | No — one log, one `seq` space | §3.3 |

---

## 6. Wake, park, nudge and member status

### 6.1 `swarm_wait` is the park, and parking ends the turn

The coordinator loop is `swarm{action:"status"}` → `post_message` → `swarm_wait{since:last}` → `read_board{since:last}` (`S/native_swarm/SKILL.md:131-138`, `S/native_swarm/SKILL.md:153-171`). Waiting is free: "a waiting agent is asleep on the board, costing nothing until somebody posts" (`S/native_swarm/SKILL.md:316-319`). Parking is not a separate call: "Ending a turn already parks you" (`S/native_swarm/SKILL.md:38-42`).

The reader confirms the turn boundary mechanically. `turnEnded` returns true when the newest step is:

- a final planner reply with no tool calls and no results after it (`main.mjs:453-455`), or
- the results of a tool batch that contained `swarm_wait`, once **`swarm_wait`'s own result is `DONE`** (`main.mjs:456-457`).

A sibling tool that went to the background is logged `RUNNING` and does **not** hold the turn; a failed or invalid `swarm_wait` (anything but `DONE`) leaves the turn running. A torn final line counts as mid-turn and is settled by the next read. [OBSERVED — `main.mjs:428-460`, reproduced in `SB/README.md:35-40`]

`summarizeLines` uses the same boundary to decide what activity to show: it walks back to the newest planner step of the current turn, and stops at `USER_INPUT` or at a `swarm_wait` call (`main.mjs:359-417`, especially `:392-395`). That is why a just-woken member shows no activity until its first new planner step lands (`SB/README.md:41-42`). [OBSERVED]

### 6.2 `wake_mode` — the parking intent, not the state

The code names three literal values (`main.mjs:497-505`):

| `wake_mode` | Meaning in the source | Confidence |
|---|---|---|
| `mentions` | parked waiting for a mention (`mentions_only:true`) | OBSERVED literal; INFERRED mapping |
| `anything` | parked waiting for any post (`mentions_only:false`) | OBSERVED literal; INFERRED mapping |
| `working` | a post has rung the member but its run has not resumed; also the fallback "not parked" | OBSERVED literal + comment |

The README is explicit that `wake_mode` is **not** the member's state: "a member parked in `swarm_wait` and woken by a background task stays `mentions` while it works"; it is used for the "for @mentions / any post" label and only as the fallback when a member has no transcript (`SB/README.md:42-45`). The comment above `statusOf` says the same and adds that a member a post has rung is still waiting until its run resumes (`main.mjs:495-501`). [OBSERVED]

The `mentions_only` mapping comes from the tool contract: `swarm_wait{mentions_only:false}` wakes for anything, the default `true` waits for a mention (`S/native_swarm/SKILL.md:322-324`). [INFERRED — the roster key is the persisted form of that argument; no code here writes it]

### 6.3 `wait_since` — the cursor the member parked on

`wait_since` is a plain number read from the roster (`main.mjs:824`) and rendered in the coordinator's status view. The monitor skill defines it: `status` gives "`wake_mode` and `wait_since` (what it is parked on: mentions or anything, after which seq)" (`S/swarm_monitor/SKILL.md:43-48`). So:

```text
wait_since = the `since` argument of the swarm_wait that parked the member
```

[INFERRED from `S/swarm_monitor/SKILL.md:44-48`; OBSERVED that it is persisted per member and numeric]

The UI uses it exactly that way when a member is working but has no activity yet: it looks for a post with `seq > max(wait_since, member's last post)` that mentions the member, reaches it via a channel, or is `@all`, and shows that post as the thing that woke it (`hive.js:978-990`). [OBSERVED — `hive.js:983-990`]

The monitor skill also warns against over-reading it: "Judge this from the board, not from `wait_since`: a turn that failed, or a member that read the post and parked without replying, moves `wait_since` past the mention." (`S/swarm_monitor/SKILL.md:66-71`) [OBSERVED]

### 6.4 `last_read_seq` — the read cursor

- `unread = head − last_read_seq` for a file board without channels (`main.mjs:801-808`); with channels it is `visibleUnread`, still keyed on the same cursor (`main.mjs:810-815`, `channels.mjs:232-240`).
- A new worker starts at the current board head: "Each worker receives its scoped brief directly in its first message with its board cursor set past the startup briefs" (`S/native_swarm/SKILL.md:347-350`). [OBSERVED as contract; INFERRED that `last_read_seq` is initialised to `head` at add time]
- `read_board{since:N}` reads forward from the cursor the caller supplies; the skill repeatedly insists on passing "the highest seq you have actually seen", never the head (`S/native_swarm/SKILL.md:316-320`, `S/swarm_narrator/SKILL.md:59-62`). That the persisted `last_read_seq` is what a read advances is **INFERRED**: the source proves the cursor exists and drives unread, not which call writes it.
- The divider and the member row use it (`SB/README.md:279-281`, `main.mjs:824-826`).

### 6.5 Nudges and the two unexplained cursors

A **nudge** here is not a separate tool: it is a post that addresses a parked member. "Every `@mention` wakes that agent and costs it a turn" (`S/native_swarm/SKILL.md:306-310`), and the coordinator hands out work by naming the worker rather than by any signal (`S/native_swarm/SKILL.md:142-151`, `:158-165`). The monitor's deliberate re-ping is the same mechanism used twice — "re-ping that member directly, which rings it: `@verifier [stall] #38 is for you.`" (`S/swarm_monitor/SKILL.md:66-73`). `@#channel` is the bulk form (§5.7). There is no acknowledgement: a nudge is delivered or it is not, and the sender learns the outcome only by reading the board. [OBSERVED — skill prose; INFERRED that no separate delivery channel exists, since none appears in the source]

The only trace of nudge-specific bookkeeping is `last_nudged_seq`. Both it and `last_park_blocked_seq` are persisted cursors, normalised to numbers and exposed in the snapshot (`main.mjs:827-828`), and nothing else in the materialised tree consumes them. The names support, but do not prove, these readings:

| Field | Plausible meaning | Status |
|---|---|---|
| `last_nudged_seq` | the last `seq` for which this member was nudged/woken, used to avoid nudging twice for the same post | INFERRED from the name; **mechanism UNKNOWN** |
| `last_park_blocked_seq` | the last `seq` at which a park was refused because unread posts remained (park returns immediately instead of sleeping) | INFERRED from the name + `swarm_wait` semantics; **mechanism UNKNOWN** |

They are worth naming precisely because they are *not* evidence of state: no status, unread count, wake decision or UI label in this tree reads them. [OBSERVED — negative result across `main.mjs`, `board_cache.mjs`, `channels.mjs`, `app.js`, `hive.js`]

### 6.6 Status derivation: `killed` / `waiting` / `working`

```js
function statusOf(m, tr) {
  if (m.killed) return 'killed';
  if (typeof tr?.idle === 'boolean') return tr.idle ? 'waiting' : 'working';
  if (m.wake_mode === 'mentions' || m.wake_mode === 'anything') return 'waiting';
  return 'working';
}
```

[OBSERVED — `main.mjs:495-507`]

So the precedence is: **killed** (roster flag) → **transcript** (`turnEnded`, §6.1) → **wake_mode fallback** when there is no transcript. The README states this as following `manage_swarm status` / `board.StateOf`: "`killed` if killed, `waiting` if the member's run has stopped, else `working`" (`SB/README.md:35-36`). [OBSERVED]

Additional derived signals, all from transcripts and the clock — never from narrator files:

| Signal | Rule | Evidence |
|---|---|---|
| failure `error` / `quota` | newest step is `ERROR_MESSAGE` (immediately), or a failed tool step that stayed newest ≥ 60 s; text matching `RESOURCE_EXHAUSTED`, `quota`, `429`, … becomes `quota` | `main.mjs:548-559`, `main.mjs:62` |
| stuck | `working` with a transcript that has not moved for > 10 min | `main.mjs:56-58`, `main.mjs:578-590` |
| narrator state | `absent` / `killed` / `paused` (failure) / `waiting` / `working` | `main.mjs:595-601` |

**Vocabulary mismatch, stated rather than smoothed.** The companion skill lists four statuses for `swarm{action:"status"}`: `waiting`, `working`, `stopped` ("not loaded, e.g. after a restart"), `killed` (`S/native_swarm/SKILL.md:140-151`), and the monitor skill repeats them (`S/swarm_monitor/SKILL.md:44-48`). The pane and `board.StateOf` expose three (`SB/README.md:35-36`, `SB/README.md:282-293`). The materialised source does **not** show how `stopped` maps onto the three-value set — whether the tool reports it as a fourth value or folds it into `waiting` is `UNKNOWN`. Do not assume the pane's `waiting` and the tool's `stopped` are the same condition. [OBSERVED for both vocabularies; UNKNOWN for the mapping]

**What the transcript contributes.** `summarizeLines` (`main.mjs:359-417`) yields `{steps, activity, activityKind, last, idle, replied, replyAsk, mtime}`:

- `steps` is the newest `step_index + 1`, so it is a line count rather than a call count; a tail window can infer it (`main.mjs:382-384`).
- `activity` is the newest planner step's `toolSummary`/`toolAction`, else a derived label (`Read app.js`, `Edit main.mjs`, `swarm add parser`), else the last bold heading in `thinking` (`main.mjs:329-352`, `:396-407`). Board tools are labelled explicitly: `swarm_wait` → "Waiting for posts", `read_board` → "Reading the board", `post_message` → "Posting to the board" (`main.mjs:301-305`).
- `idle` is `turnEnded` (§6.1); `last` is the newest step's `type`/`status`/`error`, which drives failure detection; `replied`/`replyAsk` come from a final reply with no tool calls (`main.mjs:461-493`).
- A member just woken has no activity until its first new planner step lands, because the previous turn's "Waiting for posts" is not shown (`main.mjs:368-373`, `SB/README.md:41-42`).

The file is tailed from the end: transcripts over 256 KB cold-start with an expanding EOF window that doubles only while the current turn boundary is still outside it, and fall back to a full read if `step_index` is missing (`board_cache.mjs:238-294`, `:329-365`). [OBSERVED]

### 6.8 Lifecycle, end to end

| Step | Mechanism | Evidence |
|---|---|---|
| `add` | creates a conversation, posts the brief (`@name <brief>`) to the board as the coordinator, sets the worker's cursor past startup briefs | `S/native_swarm/SKILL.md:59-82`, `:347-350` |
| brief arrives | delivered "in the worker's first message so the worker can start right away" | `S/native_swarm/SKILL.md:72-76` |
| work, then park | `swarm_wait{since:LAST}` → `DONE` → turn ends → `waiting` | `main.mjs:439-460`, `S/native_swarm/SKILL.md:314-324` |
| wake | a post that addresses it (§5.7) or any visible post if `anything`; recorded via `wake_mode`/`wait_since` | `main.mjs:497-505`, `hive.js:983-990` |
| report | `post_message`, usually `@coordinator [done] …` | `S/native_swarm/SKILL.md:158-165` |
| kill | terminal; "a killed worker cannot be revived" | `S/native_swarm/SKILL.md:327-330` |

---

## 7. Concurrency, torn reads and malformed lines

The reader is designed around one assumption — **the board only grows** — and verifies it on every incremental read. There is no lock on the read side because there is no write side. [OBSERVED — `main.mjs:12`, `SB/README.md:368-369`]

### 7.1 The incremental read protocol

`probeFile` (`board_cache.mjs:147-162`) classifies each poll:

| Status | Condition | Action |
|---|---|---|
| `hit` | `mtime+size+inode` unchanged | return the cached message array |
| `append` | same inode, `size ≥ cached size`, previous `readOffset > 0`, delta ≤ a caller-supplied cap | `readAppendedTail` |
| `miss` | anything else (deleted, replaced, shrunk, rewritten) | full read |

`readAppendedTail` (`board_cache.mjs:78-117`) then re-verifies, in order:

1. **inode equal** and **size not shrunk** and `readOffset ≤ size` (`:83`);
2. the **first 64 bytes** still equal the cached head anchor (`:84-87`);
3. the **64 bytes before `readOffset`** still equal the cached tail anchor (`:88-91`);
4. the **un-newlined remainder** seen last time is still there byte-for-byte (`:94-97`), which catches an in-place mutation of a trailing partial line.

Any failure returns `null` and the caller falls back to `readFullFile` (`board_cache.mjs:196-201`). This is what makes a poll that races the writer safe: you either get a strictly appended tail you can prove, or you re-read the whole file. [OBSERVED]

### 7.2 The epoch invalidates derived state

`readBoardCached` bumps `epoch` unless the append left the previously parsed set untouched (`board_cache.mjs:207-208`). That epoch is threaded into the derived-board key (`main.mjs:728-730`, `main.mjs:419-423`) and into an opaque `rosterKey` that also hashes the roster shape (`board_cache.mjs:455-456`, `main.mjs:883`, `main.mjs:1416`). A delta response is only served when the client's `since`/`known` still match the board prefix *and* the `rosterKey` matches (`main.mjs:1404-1413`); otherwise the full message array is returned. A channel-control message in the tail also disables the delta (`main.mjs:1413`), because it changes visibility retroactively. [OBSERVED]

### 7.3 Malformed lines

| Case | Behaviour | Evidence |
|---|---|---|
| blank line | skipped | `board_cache.mjs:37` |
| unparseable interior line | skipped, permanently — no repair, no warning | `board_cache.mjs:40-43` |
| torn final line (no newline, invalid JSON) | excluded from the complete set, cached as the remainder, picked up on the next read when it completes | `board_cache.mjs:41-42`, `:98-111`, `:205-206` |
| complete JSON object with no trailing newline | included in `msgs` but not in `completeMsgs`; completing or extending it bumps the epoch | `board_cache.mjs:205-208` |
| file truncated / replaced / rewritten in place | anchors or inode fail → full read; cached state discarded on miss | `board_cache.mjs:83-97`, `:196-201` |
| remote NDJSON watcher sends a bad line | the watcher is killed and restarted; its first line is a full snapshot | `main.mjs:1092-1104`, `main.mjs:1044-1054` |
| remote delta does not follow the held messages (`since > held`) | rejected; watcher restarted for a full snapshot | `main.mjs:1019-1031` |

The parse is explicitly documented as mirroring the Go side: "Mirrors board.parse: skip blank and unparseable lines" (`board_cache.mjs:33-34`). So the skip-on-error policy is not a sidecar convenience; it is the board's read contract. [OBSERVED for the comment and the JS; INFERRED that the Go reader behaves the same, as stated]

### 7.4 What remains open

- **Writer concurrency.** Whether two processes can append at once, whether a line is written with a single `O_APPEND` write, and what the Go `board.LockedStore` (`05` §4.3) actually locks are all outside this source. The reader's anchor checks make it *tolerant* of a torn tail, which is consistent with — but not proof of — a single-writer, append-only writer. [UNKNOWN]
- **Cross-feature writers.** A second writer to the same `board.jsonl` (if one exists) is not visible here. [UNKNOWN]
- **Sequence allocation under concurrency.** If two appends race, the reader would see whichever line landed first, with whatever `seq` it carries; nothing here validates monotonicity. [OBSERVED — no such check; consequence INFERRED]

---

## 8. The narrator and the Overview files

The board pane is not only a feed; it renders an AI-authored Overview from files the narrator maintains.

### 8.1 Contract

| File | Purpose | Cap / failure mode |
|---|---|---|
| `view.json` | facts: headline, phase, attention, workstreams, milestones, risks, goal, threads, `now`, `reel`, `feedback_ack` | 64 KB; unparseable or larger → last good parse kept, shown as stale (`main.mjs:55`, `main.mjs:603-631`) |
| `view.html` | optional custom page, rendered in a sandboxed frame | 64 KB; larger or empty → plain view (`main.mjs:649-653`) |
| `prefs.md` | the user's UI preferences, re-read after compaction | `S/swarm_narrator/SKILL.md:35-36` |

[OBSERVED — `SB/README.md:103-130`; `main.mjs:53-55`, `:603-674`]

The fallback location is the narrator's own brain dir: if `view.json` is absent from the swarm dir, the reader looks in `<appData>/brain/<narratorConv>/swarm_view/` after validating the conversation id against `ID_RE` (`main.mjs:633-648`; `S/swarm_narrator/SKILL.md:26-39`). [OBSERVED]

Who is the narrator: "any member with role `narrator`, or (on older boards where role was `worker`) named `narrator` or `narrator-<N>`"; the newest non-killed wins, else the newest killed one so the UI can say it stopped (`main.mjs:34-40`, `main.mjs:523-546`). [OBSERVED]

### 8.2 Untrusted by construction

`view.json` and `view.html` are treated as untrusted whoever wrote them: JSON is shape-checked in the backend (`main.mjs:606-631`) and re-validated in the page (`sanitizeView`, `SB/README.md:126-130`); HTML only runs in an iframe with `sandbox="allow-scripts"`, a `default-src 'none'` CSP, and a postMessage protocol that requires frame focus, user activation and no recent parent input (`SB/README.md:143-191`). `file` action targets are canonicalised and must `realpath` to an existing regular file under `<appData>/brain/` (`main.mjs:676-718`). [OBSERVED]

This matters for the coordination reading: narrator files are **presentation**, not control. No wake, status, unread or channel decision reads them; `systemAttention` is computed from rosters and transcripts only (`main.mjs:561-593`, `SB/README.md:132-141`). [OBSERVED]

### 8.3 Built-in Overview

Where `SWARM_OVERVIEW=true` (from `enable-swarm-overview`), the pane can draw an Overview without a narrator from the coordinator's `plan.json` and screenshot lines in worker posts (`main.mjs:69-73`, `main.mjs:778-787`, `main.mjs:1313-1338`; `S/swarm_pane/SKILL.md:11-52`). The skill is explicit that this replaces the narrator ("Don't add a narrator; this Overview replaces it", `S/swarm_pane/SKILL.md:16-17`). [OBSERVED]

---

## 9. The four skills

| Skill | Loaded by | Tools / artefacts | Key declarations |
|---|---|---|---|
| `native_swarm` (frontmatter `name: swarm`) | the coordinator of `/swarm` | `swarm` (`status`, `models`, `add`, `model`, `kill`, `title`; plus the conditional `channel` action at `:254-256`), `post_message`, `read_board`, `swarm_wait` | "(Preview & Quota Heavy)"; `disable-model-invocation: true` (`S/native_swarm/SKILL.md:1-12`, `:21-28`) |
| `swarm_monitor` | the worker briefed as monitor | `read_board{status:true}`, `schedule`, `manage_task`, `swarm_wait` | cron `*/3 * * * *`, `IsDaemon: true`; one post per stall (`S/swarm_monitor/SKILL.md:27-50`, `:88-108`) |
| `swarm_narrator` | the worker briefed as narrator | `read_board`, `swarm_wait`; writes `view.json` / `view.html` / `prefs.md` | never posts, never does work, atomic writes (`S/swarm_narrator/SKILL.md:15-44`) |
| `swarm_pane` | the coordinator when the built-in Overview is on | writes `plan.json`; workers flag `Screenshot:` lines | no narrator (`S/swarm_pane/SKILL.md:11-52`) |

Two skill-level facts that constrain any reconstruction:

- **The board tools are injected late.** "`post_message`, `read_board` and `swarm_wait` appear on your first turn *after* the first `swarm add`" (`S/native_swarm/SKILL.md:331-336`). So the coordinator's `swarm` tool must exist before the board tools do, and the board tools are not part of a static agent allowlist.
- **Workers can add and kill their own helpers**, but `title` is the coordinator's alone, and a worker may kill/model only what it added (`S/native_swarm/SKILL.md:337-346`). Authority is encoded in the tools, not in a role field on the board.

The coordinator's status vocabulary and the monitor's stall rules are reproduced in §6.6; the channel rules in §5.

---

## 10. Plugin and pane wiring

`plugins/swarm/plugin.json` is minimal: name `swarm`, display name `Swarm`, description "Unlock the power of agent swarms.", logo `assets/logo.svg`. [OBSERVED — `plugins/swarm/plugin.json:1-6`]

`SB/sidecar.json` runs `node main.mjs` with `restart_policy: "always"`, `has_web_ui: true`, `allows_user_interactions: false`, and an aux-pane view at `/` titled `Swarm`. It maps three feature flags into the environment:

```json
"SWARM_OVERVIEW":  "${flag:enable-swarm-overview}",
"SWARM_GRAPH_TAB": "${flag:enable-swarm-graph-tab}",
"SWARM_RAW_TAB":   "${flag:enable-swarm-raw-tab}"
```

[OBSERVED — `SB/sidecar.json:1-26`; consumed at `main.mjs:73-79`]

The HTTP surface is `GET`-only: the page `/`, the static assets in `STATIC`, `/api/frame` (progress-reel and screenshot bytes, path-checked under `<appData>/brain/`), `/api/swarm` (lazy raw, ETag, optional `since`/`known`/`rosterKey` delta) and `/api/swarm/raw` (`main.mjs:1305-1421`; `SB/README.md:193-226`). The sidecar registers no `POST` route and messages no agent (`SB/README.md:368-369`). [OBSERVED]

---

## 11. Relationship to `/teamwork-preview`

This section exists because the two multi-agent features share one binary and are easy to conflate. The materialised source separates them cleanly **at the tool surface**; the runtime relationship is no longer wholly unobserved — a `/teamwork-preview` invocation produced a *native swarm* on one occasion (`11` §1.6) — but the rule that selects one path over the other is still `UNKNOWN` (`11` §1.7).

### 11.1 What belongs to which feature

| Mechanism | Belongs to | Evidence |
|---|---|---|
| `swarm`, `post_message`, `read_board`, `swarm_wait` | native swarm | `S/native_swarm/SKILL.md:21-28` (the coordinator's "four tools") |
| `board.jsonl`, `members.json`, `swarm_wait` result states, `@#channel` | native swarm | §2–§5; `main.mjs:134`, `main.mjs:456-457` |
| `swarm_board` sidecar, `/swarm` pane | native swarm | `plugins/swarm/plugin.json`; `SB/README.md:3-15`, `:318-319` |
| `invoke_subagent`, `manage_subagents` | `/teamwork-preview` dispatch | `02` Appendix B — the pair appears in exactly 10 registry items (rows 14, 21, 22, 23, 24, 31, 42, 43, 46, 48), all orchestrator/sentinel/pipeline roles |
| `send_message` | `/teamwork-preview` (every registry item carries it) | `02` Appendix B; `05` §7 quotes the sentinel's `manage_subagents(Action="kill", …)` |
| `.agents/teamwork/*` handoff/artifact tree | `/teamwork-preview` | `05` §6 (binary literals) — no swarm skill mentions it |
| `ORIGINAL_REQUEST.md`, `BRIEFING.md`, `progress.md` | `/teamwork-preview` | `05` §6 |

The board's Go package name says whose it is: `cortex/core/native_swarm/board` (`05` §1), the same `native_swarm` as the skill and the enablement flag. [OBSERVED — package path in `05`; flag `native-swarm` in `06`]

### 11.2 The allowlist argument, and why it does not decide the question

The four swarm tools are **not** among the 17 tool names decoded from the 49 `/teamwork-preview` agent allowlists (`02` Appendix B). That is consistent with two different worlds:

1. `/teamwork-preview` agents simply cannot use the swarm board; or
2. the swarm tools are injected at runtime, as the skill says they are (`S/native_swarm/SKILL.md:331-336`), so they would never appear in a static allowlist anyway.

Because (2) is independently attested, **absence from the allowlist proves nothing**. What survives is the positive asymmetry: `manage_subagents`/`invoke_subagent` are statically present in ten teamwork agents and appear in no swarm skill; `swarm`/`post_message`/`read_board`/`swarm_wait` appear in the swarm skill and in no teamwork allowlist. The two features are documented with different verbs. [OBSERVED for both sets; INFERRED that they are separate subsystems]

### 11.3 The persistence question, corrected

`05` §1 and §6 previously called `board.jsonl` a *probable* `/teamwork` artifact, on the strength of a bare literal at binary offset 105,759,229 and no directory binding. The materialised source binds `board.jsonl` to the **native swarm** swarm directory (`main.mjs:134`, `main.mjs:724`). The earlier inference should therefore be withdrawn as unsupported. What changes that picture is runtime, not source: one `/teamwork-preview` invocation produced exactly this directory (`11` §1.6). That is an observed *outcome* of the command, not a binding of the teamwork orchestrator to the board — the `teamwork` path of run 1 never ran. The source binding remains native swarm; whether the command deliberately selects it is `UNKNOWN` (`11` §1.7). [OBSERVED for the source binding and for the one invocation; the selection mechanism is `UNKNOWN`]

### 11.4 Explicitly not claimed

- **Not claimed:** that `/teamwork-preview`'s orchestrator *uses* this board. The `teamwork` conversation observed in `11` §1 never produced a turn (`11` §1.3).
- **Not claimed:** that teamwork registry subagents (`teamwork_worker`, `teamwork_reviewer`, …) are swarm members. The one live swarm's members are `coordinator`, `coder`, `monitor` — native-swarm roles, not `AllAgents` registry types (`11` §1.6; `02`).
- **Not claimed:** that anything *reads* `board.Message.Kind` or `RequestID`. The live writer emits both (§3.1, §3.5); no consumer exists in this tree. An earlier edition of this document said "no consumer exists", which remains true, but was read as "not written" — that part was wrong.
- **OBSERVED once:** a `/teamwork-preview` invocation **did** create a swarm directory. The live run in `11` §1.6 entered through `/teamwork-preview` and left `.system_generated/swarm/` with no `.agents/teamwork/` anywhere. Whether the entry command itself starts the swarm, or the top-level agent chooses the native-swarm path while handling it, is `UNKNOWN`.
- **UNKNOWN:** whether the two features can be active in one conversation or turn; what makes one `/teamwork-preview` invocation dispatch a `teamwork` conversation and another produce a native swarm (`11` §1.7); whether any third consumer writes `board.jsonl`. Composition, member names and values observed in the one live swarm are also `UNKNOWN` as universals.

What *is* established is narrower and useful: the board, its file format, its channels and its wake protocol belong to the **native swarm** feature (`/swarm`), and the `teamwork` path of `/teamwork-preview` coordinates through parent/child subagent dispatch plus the `.agents/teamwork/` file tree (`11` §2–§5). One invocation of the same command took the native-swarm path instead; that divergence is a runtime selection this document does not explain and `11` §1.7 records without resolving. The two should still not be cited for each other.

---

## 12. What this document settles

| Claim | Status | Evidence |
|---|---|---|
| The board persists as `board.jsonl`, one JSON object per line | OBSERVED | `SB/README.md:24`, `main.mjs:724` |
| Its directory is `<appData>/brain/<coordinatorConv>/.system_generated/swarm/` | OBSERVED | `main.mjs:134`, `SB/README.md:19-20` |
| The roster persists as `members.json`; the README documents nine keys, the live file carries fourteen (adds `desired_state`, `desired_model`, `applied_model`, `workspace_mode`, `phase`; the sidecar reads the nine plus optional `channels`/`workspace*`) | OBSERVED — source + disk | `SB/README.md:25`, `main.mjs:744`, `main.mjs:839-840`, §2.4, §4 |
| `swarm.json` is versioned and backend-tagged on **both** backends; local form `{"version":1,"backend":"local","swarm_id","created_at"}`, with `swarm_id` = coordinator conversation id | OBSERVED — disk (one swarm); INFERRED as universal from the resolution rule (§2.1) | §2.2, §2.4 |
| `plan.json` carries `{goal{title,line},tasks,threads}` and is written at swarm creation | OBSERVED — disk + source | §2.2, §2.4; `S/swarm_pane/SKILL.md:19-37` |
| The writer **persists** `kind` and `request_id`; the sidecar does not read them | OBSERVED — disk + source (negative read path) | §3.1, §3.5 |
| One `seq` space covers coordinator and worker posts in a live file, 1–4 | OBSERVED — disk | §3.5 |
| The coordinator can kill a completed worker (`killed:true`, `desired_state`/`phase` `KILLED`, `wake_mode` still `working`) | OBSERVED — disk | §2.4; `11` §1.6 |
| `seq` is one number space per board, shared by all channels and control lines | OBSERVED (consumers) / INFERRED (scope) | §3.3 |
| Message order is file order; `seq` is a cursor, not a sort key | OBSERVED | §3.3 |
| The `seq` allocator and writer locking are outside this source | UNKNOWN | §3.3, §7.4 |
| `time` is `YYYY-MM-DD HH:MM:SS` in the LS host's local time | OBSERVED (parser contract) | `main.mjs:509-515` |
| Channels are `main` + named; subscriptions are log-replayable; defaults are role-based | OBSERVED | §5 |
| `@name`/`@all`/`@#channel` semantics, including cross-channel mentions | OBSERVED | `channels.mjs:22-54`, `:113-150` |
| `wake_mode`, `wait_since`, `last_read_seq` meanings | OBSERVED key + INFERRED mapping | §6.2–6.4 |
| `last_nudged_seq`, `last_park_blocked_seq` meanings | UNKNOWN (fields OBSERVED) | §6.5 |
| Status is killed → transcript → wake_mode | OBSERVED | `main.mjs:495-507` |
| `swarm_wait` parks only on `DONE`; `RUNNING` siblings do not hold the turn | OBSERVED | `main.mjs:428-460` |
| Reads are append-verified (inode + head/tail anchors + remainder) and fall back to a full read | OBSERVED | `board_cache.mjs:78-117`, `:147-162` |
| Malformed lines are skipped; a torn tail is retried | OBSERVED | `board_cache.mjs:33-46`, `:205-208` |
| `/teamwork-preview` uses this board | **PARTIAL** — one invocation produced a swarm directory (`11` §1.6); whether the command selects this path, and why, is `UNKNOWN` | §11, `11` §1.7 |

### Remaining UNKNOWN (this subject)

1. **`seq` allocation** — where the counter lives, and whether it is durable across a board rewrite.
2. **Writer serialisation** — the Go lock scope, `O_APPEND` atomicity per line, behaviour on two concurrent posters.
3. **`last_nudged_seq` / `last_park_blocked_seq`** — write-time meaning and readers, if any.
4. **`stopped` vs `waiting`** — how the coordinator tool's fourth status maps onto `board.StateOf`'s three.
5. **Retention** — whether `board.jsonl` is ever trimmed or compacted (the sidecar has no code for it).
6. **`kind` / `request_id`** — the writer emits both (`kind:"brief"` observed; `request_id` on every line), but nothing in this tree reads them. The full `kind` value set, the rule that decides when `kind` is set, and any external consumer are `UNKNOWN`.
7. **Channel-post delivery** — whether a channel post is pushed to subscribers or discovered on wake, and whether the writer rejects a post to an unknown or archived channel.
8. **`board.Control`'s Go declaration** — the key names are known from the mirror; the field types and tags are not.
9. **The live roster's state machine** — `desired_state`, `applied_model` and `phase` are persisted and unread; how they relate to `killed`, `wake_mode` and `board.StateOf` is `UNKNOWN`.
10. **Swarm composition and values as universals** — one swarm (`coordinator` + `coder` + `monitor`, model `gemini-4-argon-medium`, `workspace_mode:"inherit"`) is a sample, not a default.
11. **Any runtime relationship between native swarm and the `/teamwork-preview` teamwork path** — including why one invocation chose each (`11` §1.7).

---

## Appendix — Citation index

| Item | Location |
|---|---|
| Swarm directory derivation | `main.mjs:134` |
| Conversation → swarm resolution | `main.mjs:220-225`, `main.mjs:241-262`, `main.mjs:268-288` |
| App-data discovery | `main.mjs:113-128` |
| File contract (README table) | `SB/README.md:19-28` |
| `board.jsonl` read path | `main.mjs:720-731`, `board_cache.mjs:189-212` |
| Board line parse / skip policy | `board_cache.mjs:33-46` |
| Appended-tail verification | `board_cache.mjs:74-117`, `board_cache.mjs:144-162` |
| Board head and unread | `main.mjs:763-765`, `main.mjs:801-816` |
| `seq` consumption | `board_cache.mjs:367-409` |
| Delta cursor validation | `main.mjs:1383-1419` |
| Roster parse and projection | `main.mjs:171-179`, `main.mjs:799-845` |
| Channel accessors and defaults | `channels.mjs:13-14`, `channels.mjs:66-84` |
| Channel history reconstruction | `channels.mjs:98-111`, `channels.mjs:152-177`, `channels.mjs:203-230` |
| Visibility and unread | `channels.mjs:179-240` |
| Mentions and `@#channel` | `channels.mjs:22-60`, `channels.mjs:113-150` |
| `@#` addressees in the snapshot | `main.mjs:734-756` |
| Wake-mode comment and status fallback | `main.mjs:495-507` |
| Turn boundary / `swarm_wait` DONE | `main.mjs:428-460` |
| Activity summarisation | `main.mjs:354-417` |
| Failure and stuck detection | `main.mjs:56-62`, `main.mjs:548-593` |
| Wake-post display | `hive.js:978-990` |
| Narrator selection | `main.mjs:34-40`, `main.mjs:523-546` |
| `view.json` parse and fallback dir | `main.mjs:53-55`, `main.mjs:603-674` |
| Sandboxed narrator frame | `SB/README.md:143-191` |
| Sidecar definition and flags | `SB/sidecar.json:1-26`, `main.mjs:69-84` |
| Coordinator tool table | `S/native_swarm/SKILL.md:21-28` |
| Status vocabulary (four values) | `S/native_swarm/SKILL.md:140-151` |
| Channels section | `S/native_swarm/SKILL.md:254-282` |
| Addressing section | `S/native_swarm/SKILL.md:284-312` |
| Waiting section | `S/native_swarm/SKILL.md:314-324` |
| Board tools arrive late | `S/native_swarm/SKILL.md:331-336` |
| Monitor status fields | `S/swarm_monitor/SKILL.md:43-50` |
| Narrator file ownership | `S/swarm_narrator/SKILL.md:24-44` |
| Built-in Overview / `plan.json` | `S/swarm_pane/SKILL.md:11-52`, `main.mjs:778-787` |
| Teamwork dispatch pair in allowlists | `02-agent-registry.md` Appendix B (rows 14, 21, 22, 23, 24, 31, 42, 43, 46, 48) |
| Live swarm directory (sample) | §2.4 — `~/.gemini/antigravity-cli/brain/0e3db35c-47d2-4faf-98e6-a2a842cd4fc2/.system_generated/swarm/` |
| Live board lines, `kind`/`request_id` | §3.5 |
| Live member fields | §4 |
