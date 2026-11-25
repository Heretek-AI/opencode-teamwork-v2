# ADR 0019: Strict Tool Input Validation

- **Status:** Accepted (0.18.1)
- **Date:** 2026-11-24
- **Scope:** `plugins/opencode-teamwork/tool-schema.mjs`,
  `plugins/opencode-teamwork/tools.ts`, `scripts/test-catalog.mjs`,
  `scripts/test-tool-schema.mjs`, `tests/runtime/spec/a{2,4}-*.test.ts`,
  `tests/runtime/spec/j-strict-input.test.ts`, `tests/runtime/README.md`
- **Related:** [ADR 0017](0017-opencode-plugin-contract-and-test-strategy.md)
  (host contract and test layers)

## 1. Context

Every Teamwork tool declares `additionalProperties: false`. On OpenCode 2.4.1
that keyword did not reject an unknown key: the key vanished before the tool
ever saw it. Two host passes caused it, and the second is the load-bearing one.

1. **Raw JSON Schema decode.** The runtime compiles a JSON-Schema input into an
   Effect codec and decodes with `onExcessProperty: "ignore"`
   (`packages/core/src/tool/runtime.ts:115-121`, `:187-201`), so excess keys are
   stripped rather than reported.
2. **The input-repair plugin runs first.** `opencode.tool.input.repair`
   (`packages/core/src/plugin/tool-input-repair.ts:32,41-58`) executes on
   `execute.before` and calls `repairObject` when the model-facing schema is an
   object. `repairObject` deletes every undeclared key when
   `additionalProperties === false` (`:161-171`). This happens before the
   runtime's input decode, so a Standard Schema would receive an input with the
   unknown key already gone.

The L1 harness recorded the old behaviour as `OBSERVED — host limitation` in
`tests/runtime/spec/a4-schema-rejection.test.ts` and `tests/runtime/README.md`.
Tools still sanitise their own values, but the schema contract the model was
given ("closed object") was not what the host enforced.

## 2. Decision

### 2.1 The validated route is a Standard Schema

`Tool.ValueSchema` accepts `Schema.Codec | StandardSchemaV1 | JsonSchema`
(`packages/schema/src/tool.ts:82`). The runtime gives a Standard Schema its own
path:

- `validateInput` detects `"~standard" in schema` and calls `validateStandard`
  (`runtime.ts:88`, `:148-149`), which invokes
  `schema["~standard"].validate(value)` and awaits a promise result
  (`runtime.ts:155-167`).
- Issues become `Tool.Error` with `Invalid arguments for tool "<name>"` and one
  line per issue; the path is rendered as `a.b[0].c` (`runtime.ts:76-82`,
  `:101-113`).
- The model-facing parameter schema is
  `schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })`
  (`runtime.ts:169-174`, `:181-185`), not a codec derived from the schema.

`strictInput(jsonSchema)` returns exactly that object: version `1`, vendor
`opencode-teamwork`, a synchronous `validate`, and `jsonSchema.input/output`
returning the original schema object. No dependency is added; the Standard
Schema type is structural.

### 2.2 Keep the model-facing schema byte-identical

The repair plugin reads the same `definition(tool).inputSchema` the model does,
so it cannot be given a different schema. To stop it deleting unknown keys while
leaving the catalog untouched, `strictInput` attaches a **non-enumerable, empty
`patternProperties`** to every closed object node:

- `repairObject` sets `patterned = Predicate.isObject(schema.patternProperties)`
  and skips the delete when `patterned` is true
  (`tool-input-repair.ts:161-171`).
- An empty pattern map declares no pattern, so it changes no JSON-Schema
  validation result; the plugin validator still rejects every undeclared key.
- The property is non-enumerable, so serialization (the model catalog, the
  `ToolDefinition` decode, and `JSON.stringify`) does not emit it. L1 A2 asserts
  the catalog schema and A4 asserts the runtime refusal, so a host change that
  starts serializing it fails the suite rather than silently drifting the
  prompt.

Coercion of *declared* properties (for example `"20"` → `20`) still happens;
only the unknown-key deletion is disabled.

### 2.3 Validate strictly, over a declared subset

`tool-schema.mjs` validates `object`, `array`, `string`, `number`, `integer`,
`boolean`, `null`, `enum`, `const`, `anyOf`, `required`,
`additionalProperties` (boolean or schema), `items`, the numeric bounds
(`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`), the string
bounds (`minLength`, `maxLength`, `pattern`), and the array bounds (`minItems`,
`maxItems`, `uniqueItems`). `description`/`title` are annotations.

Rules:

- An object rejects undeclared keys at every depth unless it explicitly opts
  into them with `additionalProperties: true` or a schema. The eight open maps
  in the tool set (tournament configuration and a few pass-through records) are
  deliberate and stay open.
- `required` reports at the missing property's path; `type`, `enum`, array
  items, and bounds report at their own path.
- Issues are `{ path, message }`; no value transformation is performed.

`assertSupportedSchema` runs inside `strictInput`, so registration fails loudly
on any keyword outside this list (`format`, `$ref`, `oneOf`, `not`,
`patternProperties` in the source literal, …), on an untyped schema node, on an
object with neither `properties` nor `additionalProperties`, on an array without
`items`, and on `required` naming an undeclared property. A construct that
cannot be enforced cannot enter the catalog. `scripts/test-catalog.mjs` walks
the same keyword set independently, asserts each of the 26 registrations is the
strict wrapper, and asserts the wrapper itself refuses an unsupported keyword.

## 3. Consequences

- Unknown top-level and nested keys now produce a `Tool.Error` naming the exact
  path, before `execute` and therefore before any run directory is written.
- The tool catalog, prompt cache inputs, and agent instructions are unchanged.
- The validator is the authority for closed-object strictness. If a future host
  removes the repair pass, the validator still rejects unknown keys; if a host
  resumes stripping them, L1 A4 and the L2 spot check fail.
- Residual: `additionalProperties: true` records remain open by design; an
  `anyOf` mismatch reports one generic issue at the union's path rather than a
  branch-specific diagnosis; and `strictInput` mutates the schema object it is
  given (non-enumerable guard) rather than returning a copy.
