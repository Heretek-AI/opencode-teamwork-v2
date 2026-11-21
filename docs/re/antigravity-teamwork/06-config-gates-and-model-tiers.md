# Configuration Gates and Model-Tier Behaviour — Antigravity `/teamwork`

Static-evidence reconstruction of the configuration gates that can enable, disable, or re-model the `/teamwork` subsystem in the Google Antigravity Linux CLI (extracted binary `antigravity`, SHA-256 `37873b8062391b6202a3d3199ec012abc9e53aab720d26cd65699441497d8c94`, 273,240,776 bytes). [OBSERVED] No part of the binary was executed; no network access and no authentication were used. [OBSERVED]

Companion documents: `00-artifact-identity.md` (identity, section map, toolchain), `01-command-contract.md` (command surface), `02-agent-registry.md` (roster, registry builders, and the string-layout limitation), `PROVENANCE.md` (method limits).

## Confidence Legend

| Label | Meaning |
|---|---|
| **OBSERVED** | A byte string was read at a measured file offset in the extracted binary. Offsets are decimal file offsets of the quoted literal's first byte; they are not virtual addresses. |
| **INFERRED** | Derived by reasoning over observed names or structures; the premises are stated in the same row or paragraph. |
| **UNKNOWN** | Not measured, or not determinable from the available evidence. Written literally `UNKNOWN`; never guessed. |

**Rule for this document: a flag string proves the flag exists. It does not prove where, when, or whether it is enforced.** Every row therefore carries `UNKNOWN` in its Enforcement column unless a call path was actually read, and no call path was read for any of these gates — the binary has no symbol table, only a surviving `pclntab` function-name table (see `02-agent-registry.md`). [OBSERVED]

## Naming Note — the shipped command is `/teamwork-preview`

Three independent literals establish the shipped name. [OBSERVED]

- Slash-command description, verbatim: `Preview the multi-agent teamwork workflow.` @ 107,480,810.
- Admin-control field JSON name `teamworkPreviewCommandDisabled` @ 206,785,570; proto field `teamwork_preview_command_disabled` @ 111,240,388.
- Embedded changelog, verbatim, under heading `## 1.1.17`: ``Fixed `/teamwork-preview` and some other slash commands disappearing for some users.`` @ 116,708,658.

Task framing says `/teamwork`; the artifact says `/teamwork-preview`. This document uses the artifact's name in all evidence rows. [OBSERVED]

## 1. Gate Inventory

Kind vocabulary: **admin proto control** = a field in an admin-controls protobuf; **settings flag** = a hyphenated feature-flag string; **runtime config accessor** = a Go function symbol in `cortex/config`. [OBSERVED for each kind; the name→kind mapping is INFERRED from naming and package path]

| Flag / identifier | Kind | What it appears to control [INFERRED] | Evidence (package path + confirmed offset) | Enforcement |
|---|---|---|---|---|
| `teamwork_preview_command_disabled` | admin proto control (bool) | Availability of the `/teamwork-preview` command | `google.cloud.businessaicode.v1beta.AdminControls.FeatureControls.MultiagentControls` rawDesc @ 111,240,388; `exa.language_server_pb.FetchAdminControlsResponse.FeatureControls.MultiagentControls` rawDesc @ 115,834,241 | UNKNOWN |
| `TeamworkPreviewCommandDisabled` | admin proto control (generated Go getter) | Same field, two generated Go families | Language server: method-expression literal @ 30,308,561, `GetTeamworkPreviewCommandDisabled` token @ 30,308,651. Management service: literal @ 34,011,186, `GetTeamworkPreviewCommandDisabled` token @ 34,011,273. Compiled name in `pclntab` @ 204,669,338 | UNKNOWN |
| `teamwork_preview_command_disabled` (wire tag) | admin proto control (wire form) | Declared `varint,2,opt` — proto3 bool, field 2 | Go struct tags @ 212,954,391 and 213,820,127 (JSON-name tag @ 206,785,570) | UNKNOWN |
| `boost_command_disabled` | admin proto control (sibling) | Sibling command gate in the same message; **not** teamwork | rawDesc @ 111,240,321 and 115,834,187; Go struct tag @ 210,459,713 | UNKNOWN |
| `teamworkDisabled` | runtime code (Go func, `admin_controls/admincontrols`) | Computes teamwork disablement from admin settings | `admincontrols.teamworkDisabled` @ 34,055,619 (sibling symbol `admincontrols.boostDisabled` @ 34,055,692) | UNKNOWN |
| `enable-teamwork-subagent` | settings flag | Enables teamwork-as-subagent mode | string pool @ 106,772,317; enterprise preset @ 223,052,805 (repeats per surface) | UNKNOWN |
| `enable-owl-slash-command` | settings flag (sibling) | Enables the `owl` slash command | string pool @ 106,772,341; enterprise preset @ 223,052,765 | UNKNOWN |
| `disable-teamwork-forced-flash-model` | settings flag (kill-switch) | Turns off forcing teamwork agents onto the flash tier | string pool @ 107,270,651; enterprise preset @ 223,052,618 | UNKNOWN |
| `enable_teamwork_subagent` | per-customization proto3 bool (`oneof`, field 19) | Per-customization switch for teamwork subagent | `exa.cortex_pb.CustomizationConfig` rawDesc @ 116,177,264; struct tag @ 212,807,603; getter `(*CustomizationConfig).GetEnableTeamworkSubagent` @ 27,805,854 | UNKNOWN |
| `TeamworkDefaultsToFlash` | runtime config accessor (exported func) | Whether teamwork defaults to the flash tier | `third_party/jetski/cortex/config/config.TeamworkDefaultsToFlash` @ 33,572,314 | UNKNOWN |
| `teamworkDefaultsToFlash` | runtime config accessor (unexported func) | Implementation behind the above | `third_party/jetski/cortex/config/config.teamworkDefaultsToFlash` @ 33,572,386 | UNKNOWN |
| `TeamworkSubagentEnabled` | runtime config accessor (exported func) | Whether teamwork runs in subagent mode | `third_party/jetski/cortex/config/config.TeamworkSubagentEnabled` @ 40,984,326 | UNKNOWN |
| `disableNativeSwarm` / `native-swarm*` | runtime code + settings flags (adjacent family) | A different multi-agent switch; relation to teamwork UNKNOWN | `admincontrols.disableNativeSwarm` @ 34,056,566; flag strings `native-swarm` @ 106,392,234, `enable-swarm-monitor` @ 106,479,479 | UNKNOWN |

Two adjacency caveats, because they are easy to over-read. [OBSERVED for the facts; INFERRED for the explanation]

- `enable-teamwork-subagent` and `enable-owl-slash-command` sit next to each other in the *string pool* (106,772,317 / 106,772,341) because their lengths match their bucket. Pool adjacency is a storage artefact and carries no semantic weight (see `02-agent-registry.md` Known Limitation).
- The semantic evidence for those two flags is instead the embedded preset, where both appear as keys of the same per-surface object.

### Embedded preset evidence

One embedded JSON preset object contains top-level sections `os` @ 222,989,494, `model_profiles` @ 222,989,600, `models` @ 223,048,758 and `enterprise` @ 223,052,576. [OBSERVED] Under `enterprise`, each key is `<surface>,<os>` and each value is a flag object; the `CLI,linux` value holds these keys in this order: `disable-teamwork-forced-flash-model` (`true`), `enable-auto-permission-preset` (`true`), `enable-orchestrator-model-selection` (`null`), `enable-owl-slash-command` (`true`), `enable-teamwork-subagent` (`true`), `enable-voice-relay` (`null`), `orchestrator-model-roles` (`null`), `permission-v2` (`true`), `voice-engine-addr` (`null`) — the same shape repeats for `CLI,macos`, `CLI,windows`, `IDE,*` and `SDK,*`. [OBSERVED]

Two consequences, both bounded. First, the preset shows these flags are *organised* per tenant tier and per surface; the tier seen here is `enterprise`. [OBSERVED] Second, nothing in the binary proves this preset is loaded for a given account, nor what a `null` override resolves to — `null` may mean "inherit the default" or "explicitly unset". [UNKNOWN]

Separately, the default flag map at 222,976,477–222,989,493 does **not** contain `disable-teamwork-forced-flash-model` or either teamwork enable flag; the first occurrence of the kill-switch inside the preset blob is 223,052,618, in the `enterprise` block. [OBSERVED — exhaustive string search; absence of a key in a map is observable, its meaning is not]

## 2. Admin-Control Path

The same logical admin model exists as **two** protobuf families, and both carry the teamwork gate. [OBSERVED]

| Family | Message path (from rawDesc) | Go package | Anchor offsets |
|---|---|---|---|
| Language server — what the client receives | `exa.language_server_pb.FetchAdminControlsResponse.FeatureControls.MultiagentControls` | `google3/third_party/jetski/language_server_pb/language_server_go_proto` | type ref 115,834,068; message def 115,834,165; field literal 115,834,241; getter symbol 30,308,651 (literal @ 30,308,561) |
| Management service — what an org admin configures | `google.cloud.businessaicode.v1beta.AdminControls.FeatureControls.MultiagentControls` | `google3/google/cloud/businessaicode/v1beta_management_service_go_proto` | type ref 111,240,243; message def 111,240,299; field literal 111,240,388; getter symbol 34,011,273 (literal @ 34,011,186) |

Two different artifacts carry the two families, and their offsets are not interchangeable. [OBSERVED] The `115,834,xxx` / `111,240,xxx` numbers fall in the serialized descriptor (`rawDesc`) inside `.rodata`: 115,834,165 and 111,240,299 are the `MultiagentControls` **message definition** entries, and the field itself is declared in the same entry at 115,834,241 and 111,240,388. The `30,308,xxx` / `34,011,xxx` numbers fall in the generated Go binding names instead: the `GetTeamworkPreviewCommandDisabled` token resolves at 30,308,651 and 34,011,273 (`grep -aob` against the binary), inside method-expression literals that begin at 30,308,561 and 34,011,186. The management-service literal is sometimes cited as 34,011,193 — that is the same literal minus its 7-byte `v1beta_` qualifier, not a different site. The compiled getter survives once more in `pclntab` as `!GetTeamworkPreviewCommandDisabled` @ 204,669,338.

Why the distinction matters: the management-service type is the **admin-editable resource**; the language-server type is the **response the client fetches**. A deployment could therefore disable the command server-side (management) while a stale client copy still reports the older value (language-server response). Whether either side caches, and for how long, is `UNKNOWN`. [OBSERVED for the two types; INFERRED for the split's implication]

Structural details readable directly from the descriptors [OBSERVED]:

- `FeatureControls` has a `multiagent_controls` field of type `MultiagentControls`, plus a `remote_control_enabled` bool (`remote_control_enabled` @ 115,834,110).
- `MultiagentControls` contains exactly `boost_command_disabled` and `teamwork_preview_command_disabled` in both families, in that order — that is the whole message.
- Polarity is mixed: the two command gates are negative (`*_disabled`) while the neighbouring remote-control gate is positive (`*_enabled`).
- `FeatureControls` also carries `BrowserControls` (`browser_enabled` @ 115,833,605; `javascript_execution_policy` @ 115,833,647; `actuation_allowed_urls`) and `PluginControls` (`plugins_disabled` @ 115,834,334; `marketplace_disabled`), plus `McpControls` in the language-server variant — neighbouring families this document does not cover.

Client-side plumbing is named but not traced [OBSERVED symbols; behaviour UNKNOWN]:

- Lifecycle: `admincontrols.NewManager` @ 34,043,238, `NewManagerWithSettings` @ 34,043,865, `(*Manager).SetFlagChecker` @ 34,043,391.
- Fetch: `(*Manager).FetchAdminControls` @ 34,043,793 and `(*Manager).fetchAdminControls` @ 34,043,958 — a public/private pair with a refresh shape. Transport (RPC vs local state), refresh cadence, retry policy and cache lifetime are all `UNKNOWN`; none of them is visible in the recovered names.
- Applicability: `(*Manager).IsAdminControlApplicable` @ 34,044,216, `withBAICFeatureDefaults` @ 34,044,125, `isNilBAICClient` @ 34,043,305 (**BAIC** = `businessaicode`, the management service above).
- Enforcement wrapper: `(*Manager).WrapFeatureProviderFactory` @ 34,055,776 → `(*adminControlsFactory).NewProvider` @ 34,055,950 → `(*adminControlsProvider).IsEnabled` @ 34,056,129, `.clamped` @ 34,056,220, `.GetBool` @ 34,056,309, `.Loaded` @ 34,056,398, plus `(*Manager).flagDisabled` @ 34,055,870.

What the wrapper implies is limited but useful: admin controls are applied by **wrapping the feature-provider factory so flag reads can be clamped**, not by editing each call site. [INFERRED — from the `clamped`/`GetBool`/`flagDisabled` names; the clamp rule itself was not read] Whether `teamwork_preview_command_disabled` is one of the clamped flags is `UNKNOWN`: there is **no** `IsTeamworkPreviewCommandDisabled` method anywhere in the binary (searched; zero occurrences), only the unexported `admincontrols.teamworkDisabled` @ 34,055,619 and an override hook `(*Manager).overrideMultiagentControls` @ 34,056,486. [OBSERVED]

## 3. Model-Tier Behaviour

### 3.1 What is observed

| Fact | Evidence | Label |
|---|---|---|
| A general model-tier enum exists: `MODEL_TIER_UNSPECIFIED`, `MODEL_TIER_INHERIT`, `MODEL_TIER_FLASH_LITE`, `MODEL_TIER_FLASH`, `MODEL_TIER_PRO` | Enum rendering: `ModelTier` followed by five values, first value @ 116,298,796; a second rendering without `INHERIT` @ 110,515,713; enum type methods `cortex_pb/cortex_go_proto.ModelTier.*` @ 27,577,369 | OBSERVED |
| Tiers are resolved into concrete models by a dedicated package | source-path table `cortex/modelutils/model_tier.go` @ 48,234,033 and `catalog.go` @ 48,234,084; symbols `ParseModelTier` @ 34,788,125, `modelIDForTier` @ 34,788,419, `ResolveModelForTier` @ 34,788,490, `ResolveModelTierFromConfig` @ 34,788,336, `CatalogKeyForTier` @ 34,788,733, `TierModelNameFromConfig` @ 34,789,249, `ResolveModelFromTierConfig` @ 34,789,329 | OBSERVED |
| Resolution failure has a named error | `unsupported concrete model tier: %v` @ 107,270,301 | OBSERVED |
| A resolved model is applied differently to planner, subagent, and custom agent | `(*ResolvedModel).ApplyToPlanner` @ 34,789,499, `(*ResolvedModel).ApplyToSubagent` @ 34,789,587, `ResolvedModel.applyToCustomAgentSpec` @ 34,788,032, `PlannerResolvedModel` @ 34,787,708, `ResolveCatalogModel` @ 34,787,945 | OBSERVED |
| Subagent model options are derived from the available-model list | `SubagentModelsFromAvailableModels` @ 34,788,807 (+ `.func1` @ 34,788,897), `SubagentModelOption_builder.Build` @ 34,789,001, `FetchAvailableModels` @ 34,788,185, `FetchTieredModels` @ 34,788,273 | OBSERVED |
| Teamwork builds its root agent *with a default tier* | `teamwork.RootAgentWithDefaultTier` @ 34,566,022, `teamwork.buildAgentItemWithDefaultTier` @ 34,566,209, `teamwork.buildCascadeConfig` @ 34,566,314, `teamwork.RootAgent` @ 34,573,399 | OBSERVED |
| A single embedded model alias map exists | `models` section @ 223,048,758; e.g. `"MODEL_PLACEHOLDER_M50": "MODEL_GOOGLE_GEMINI_2_5_FLASH"` @ 223,051,448 | OBSERVED |

### 3.2 What is inferred — and only inferred

- **Teamwork defaults to a lower-latency "flash" tier.** Premises: the exported accessor `config.TeamworkDefaultsToFlash` @ 33,572,314, the teamwork builders that take a *default tier*, an existing `MODEL_TIER_FLASH` value, and a settings flag whose only apparent purpose is to *disable forcing* that tier. That the default is `FLASH` rather than `FLASH_LITE`, or a per-surface choice, is **not** proven. [INFERRED]
- **A kill-switch for the forcing exists.** `disable-teamwork-forced-flash-model` is the negative of a forcing behaviour, so the forcing behaviour is presumed to be the default state and to be switched off in the enterprise preset. Whether an absent key means "forcing on" is `UNKNOWN`. [OBSERVED absence from the default map; INFERRED meaning]
- **Teamwork can run as a subagent mode.** Premises: `config.TeamworkSubagentEnabled` @ 40,984,326, the settings flag `enable-teamwork-subagent`, the per-customization bool `enable_teamwork_subagent` on `CustomizationConfig`, `agents.TeamworkAgentWithConfig` @ 34,573,207 (with `agents.teamworkAgentWithConfig` @ 34,573,302), and `agents.CalculateAllowedSubagents` @ 34,566,564. The last name indicates the *set of permitted subagents is computed*, i.e. gating likely happens on the subagent list rather than at the slash command. [INFERRED]
- **Admin controls may override the cascade (model) configuration.** Premise: `(*Manager).OverrideCascadeConfig` @ 34,044,297 exists on the admin-controls manager (an inlined defer wrapper of it sits at 34,057,299). It does not follow that teamwork's tier is among the overridden settings. [INFERRED]

### 3.3 Explicit UNKNOWN table

| Question | Status | Why it cannot be settled from strings |
|---|---|---|
| Numeric values / wire numbers of the tier enum | UNKNOWN | RawDesc rendering lists names only; no numbers recovered |
| Tier vocabulary beyond the five enum identifiers | UNKNOWN | Only `UNSPECIFIED/INHERIT/FLASH_LITE/FLASH/PRO` render as enum values; other tier vocabularies are not excluded |
| Tier → concrete model mapping | UNKNOWN | Needs the bodies of `modelIDForTier` / `TierModelNameFromConfig`; the embedded alias map maps placeholders to models but carries no tier key |
| Which tier each teamwork agent receives | UNKNOWN | `buildAgentItemWithDefaultTier` body not read; the name says "default tier", not which |
| Cascade / fallback rules when a tier is unavailable | UNKNOWN | `teamwork.buildCascadeConfig` @ 34,566,314 and `cortex/core/components/config/config.defaultCascadeConfig` @ 40,984,613 are names only |
| Whether admin controls override local/teamwork config | UNKNOWN | `overrideMultiagentControls` @ 34,056,486 and `OverrideCascadeConfig` exist; inputs, precedence and effect unread |
| Whether `INHERIT` means "inherit the parent agent's model" | UNKNOWN | Plausible from the name only |

Related negative finding: `cortex/config` exposes generic resolvers (`getResolvedModel` @ 33,575,092, `PlannerModel` @ 33,491,730, `maybeResolveRequestedModel` @ 33,575,218) and per-subagent accessors (`BrowserSubagentWebviewModel` @ 33,574,938), but there is **no** `TeamworkModel`, `TeamworkSubagentModel` or `TeamworkConfig` symbol (searched; zero occurrences). Teamwork appears to reuse the generic resolution path rather than owning one. [OBSERVED absence; INFERRED interpretation]

Terminology caution: the `License`-family messages in both admin protos also carry `user_tier` @ 115,834,914 and `tier_display_name` @ 115,834,943. That is an **account/licence** tier, not a model tier; the two must not be conflated when reading a capture. [OBSERVED — distinct message, distinct field names]

## 4. Disablement Semantics

Each row is a *plausible* configuration state. The observable behaviour of a disabled `/teamwork-preview` was **not** established statically, so the "What the CLI would have to do" column is a specification of possible behaviours, not a finding. [UNKNOWN for every behaviour]

| # | State | Gate that produces it | What the CLI would have to do | Established? |
|---|---|---|---|---|
| S1 | Admin-disabled | `teamwork_preview_command_disabled = true`, from either admin family | hide the command from the slash palette, or reject invocation with a permission message | UNKNOWN |
| S2 | User/experiment flag off | `enable-teamwork-subagent` absent or false | run the command without subagent fan-out, or hide it entirely — statically indistinguishable | UNKNOWN |
| S3 | Subagent mode off, command present | `TeamworkSubagentEnabled` false, or `enable_teamwork_subagent` unset on the customization | single-agent execution, or refusal; no string distinguishes these | UNKNOWN |
| S4 | Forced-flash on (presumed default) | `disable-teamwork-forced-flash-model` absent/false | rewrite every teamwork agent's model to the flash tier before dispatch | UNKNOWN |
| S5 | Forced-flash disabled | `disable-teamwork-forced-flash-model` true | honour configured/user-selected tiers, subject to `ResolveModelForTier` | UNKNOWN |
| S6 | Conflict: admin disabled + local flag enabled | S1 ∧ S2 | admin wins (most likely given the `clamped` provider), or the command exists but fails at dispatch | UNKNOWN |
| S7 | Command absent, then restored by an upgrade | release `## 1.1.17` records commands "disappearing for some users" and being fixed | implies a registration/ordering defect, i.e. suppression may be client-side rather than server-side | UNKNOWN |

The only recorded behavioural datum is the changelog line quoted in the Naming Note. It proves the *phenomenon* — a slash command can be absent for a user — without proving which gate caused it. [OBSERVED text / UNKNOWN cause]

## 5. How to Settle Each UNKNOWN

Every item needs one of two things: a runtime observation against a controlled account, or one disassembly target. The disassembly route additionally needs the `pclntab` → PC mapping this session lacked (see `02-agent-registry.md`). [OBSERVED]

| UNKNOWN | Cheapest runtime observation | Disassembly / analysis target |
|---|---|---|
| Is `teamwork_preview_command_disabled` enforced? | Sign in with an org whose admin sets the flag; compare the slash palette and an explicit `/teamwork-preview` invocation before/after | `admincontrols.teamworkDisabled` @ 34,055,619 and `(*Manager).overrideMultiagentControls` @ 34,056,486 — look for the `GetTeamworkPreviewCommandDisabled` read and its branch |
| Admin vs local precedence (S6) | Same account: admin toggles the flag while a local flag is enabled; observe the winner | `(*Manager).WrapFeatureProviderFactory` @ 34,055,776 and `(*adminControlsProvider).clamped` @ 34,056,220 |
| Fetch / refresh / caching of admin controls | Change an admin setting and time how long the client takes to honour it; toggle network to test cache | `(*Manager).FetchAdminControls` @ 34,043,793 / `fetchAdminControls` @ 34,043,958 |
| Which tier teamwork receives by default | No command isolates it; needs a traffic capture of the model id on one `/teamwork-preview` run | `config.TeamworkDefaultsToFlash` @ 33,572,314, then `teamwork.RootAgentWithDefaultTier` @ 34,566,022 and `buildAgentItemWithDefaultTier` @ 34,566,209 |
| Tier → model mapping | Run one command per selectable tier; read the model id each dispatch uses | `modelutils.modelIDForTier` @ 34,788,419, `ResolveModelForTier` @ 34,788,490, `CatalogKeyForTier` @ 34,788,733, `TierModelNameFromConfig` @ 34,789,249 |
| Per-agent tier assignment | Compare per-agent model in a dispatched trajectory or telemetry payload | `SubagentModelsFromAvailableModels` @ 34,788,807 + `(*ResolvedModel).ApplyToSubagent` @ 34,789,587 |
| Cascade / fallback rules | Force an unavailable model (if the client allows) and observe the substitute | `teamwork.buildCascadeConfig` @ 34,566,314 and `(*Manager).OverrideCascadeConfig` @ 34,044,297 |
| Semantics of `INHERIT` | Run a subagent whose parent model differs from its own; see which model is used | `ParseModelTier` @ 34,788,125 and the `ApplyToPlanner` / `ApplyToSubagent` pair |
| `enable-teamwork-subagent` vs `TeamworkSubagentEnabled` | Toggle the flag through server-side experiment control; diff the agent list | `config.TeamworkSubagentEnabled` @ 40,984,326 — does it read the flag literal? |
| Effect of `disable-teamwork-forced-flash-model` | Select a non-flash model and run; observe whether dispatch is flash in both flag states | the reader of the literal @ 107,270,651: locate the code that loads it, then read the branch |
| Whether the `enterprise` preset is applied at all | Run as an enterprise account and as a non-enterprise account; diff effective flags | the preset consumer — no reader identified yet |

Method note: a flag string's offset is a *data* offset. Locating its reader needs an xref from data to code, which requires the PC table described in `02-agent-registry.md`; no reader is claimed here. [OBSERVED]

## 6. What This Document Does Not Claim

- That any gate above is enforced, or in what order. [UNKNOWN]
- That the embedded `enterprise` preset applies to any particular account. [UNKNOWN]
- That `/teamwork-preview` is the only teamwork entry point — `teamwork.AllAgents` @ 34,565,937 and `agents.CalculateAllowedSubagents` @ 34,566,564 suggest subagent-mode dispatch exists independently of the slash command. [INFERRED]
