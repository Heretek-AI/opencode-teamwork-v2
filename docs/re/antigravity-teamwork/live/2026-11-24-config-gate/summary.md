# 1.5.16 config-gate probe — observed

Binary: <binary>, 1.5.16, sha256 05245f43…934e785, 2026-11-24T19:32Z
Prompt: "/teamwork [skip-interview] Reply with exactly: PONG" (promptLength=51)

| Arm | Flags | expanded_commands | model turns | tokens |
|---|---|---|---|---|
| T   | none | `[{"name":"teamwork","type":"system"}]` | 0 | 0 |
| C1  | --disable-slash-commands | absent | 0 | 0 |
| C2  | /not-a-command prompt | absent | 0 | 0 |
| C3  | --settings '{"enable-teamwork-subagent":false}' | n/a | 0 | 0 |

C3 stderr (verbatim): `Error: --settings: unknown setting "enable-teamwork-subagent"`

Timing (T): starting 14:32:33.002; sending message 14:32:44.646; expanded 14:32:44.654 (8 ms later).
Kill-on-line prevented any model call; each stream result is `interrupted`, `num_turns:0`, all usage 0.

Conclusions (OBSERVED): the slash command is expanded at all and the instrument is
sensitive (C1) and specific (C2). The local settings key `enable-teamwork-subagent`
is rejected by 1.5.16, so S2/S3 cannot be exercised through --settings; S1/S6 remain
UNKNOWN on a consumer account.
