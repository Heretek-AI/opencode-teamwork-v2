// Unit coverage for the strict tool input validator (ADR 0019).
//
// The host's own decoder ignores excess properties (OpenCode 2.4.1), so the
// plugin's Standard Schema is now the only boundary that refuses them. These
// tests pin that boundary directly: rejection is only useful if the issue path
// names the key the model must fix, because the runtime renders paths into the
// `Tool.Error` text (packages/core/src/tool/runtime.ts:101-113).
//
// Run: node scripts/test-tool-schema.mjs (part of `npm test`).

import assert from "node:assert"
import { SUPPORTED_KEYWORDS, isStrictInput, strictInput } from "../plugins/opencode-teamwork/tool-schema.mjs"

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`✗ ${name}`)
    console.error(error)
  }
}

const schema = {
  type: "object",
  properties: {
    request: { type: "string", minLength: 1, maxLength: 20 },
    mode: { type: "string", enum: ["small", "large"] },
    count: { type: "number", minimum: 0, maximum: 10 },
    flags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["request", "mode"],
  additionalProperties: false,
}

const validate = (value, candidate = schema) => strictInput(candidate)["~standard"].validate(value)

const issuePaths = (result) => (result.issues ?? []).map((issue) => issue.path.join("."))
const issueAt = (result, path) => (result.issues ?? []).find((issue) => issue.path.join(".") === path)

check("valid input passes through unchanged", () => {
  const input = {
    request: "do it",
    mode: "small",
    count: 2,
    flags: ["a"],
    requirements: [{ id: "R1", text: "delivered" }],
  }
  const result = validate(input)
  assert.deepStrictEqual(result.issues, undefined)
  assert.strictEqual(result.value, input)
})

check("unknown top-level key is rejected at its path", () => {
  const result = validate({ request: "x", mode: "small", bogus: 1 })
  assert.deepStrictEqual(issuePaths(result), ["bogus"])
  assert.match(issueAt(result, "bogus").message, /unknown property/)
})

check("unknown nested key is rejected at its path", () => {
  const result = validate({
    request: "x",
    mode: "small",
    requirements: [{ id: "R1", text: "t", bogus: true }],
  })
  assert.deepStrictEqual(issuePaths(result), ["requirements.0.bogus"])
  assert.match(issueAt(result, "requirements.0.bogus").message, /unknown property/)
})

check("missing required property is rejected at its path", () => {
  const result = validate({ mode: "small" })
  assert.deepStrictEqual(issuePaths(result), ["request"])
  assert.match(issueAt(result, "request").message, /required property is missing/)
})

check("wrong type is rejected at its path", () => {
  const result = validate({ request: "x", mode: "small", count: "two" })
  assert.deepStrictEqual(issuePaths(result), ["count"])
  assert.match(issueAt(result, "count").message, /expected number, received string/)
})

check("enum is enforced at its path", () => {
  const result = validate({ request: "x", mode: "medium" })
  assert.deepStrictEqual(issuePaths(result), ["mode"])
  assert.match(issueAt(result, "mode").message, /must be one of "small", "large"/)
})

check("array item type is enforced at its index", () => {
  const result = validate({ request: "x", mode: "small", flags: ["ok", 7] })
  assert.deepStrictEqual(issuePaths(result), ["flags.1"])
  assert.match(issueAt(result, "flags.1").message, /expected string, received number/)
})

check("declared bounds are enforced", () => {
  assert.deepStrictEqual(issuePaths(validate({ request: "", mode: "small" })), ["request"])
  assert.deepStrictEqual(issuePaths(validate({ request: "x".repeat(21), mode: "small" })), ["request"])
  assert.deepStrictEqual(issuePaths(validate({ request: "x", mode: "small", count: 11 })), ["count"])
  assert.deepStrictEqual(issuePaths(validate({ request: "x", mode: "small", flags: [] })), ["flags"])
  assert.deepStrictEqual(issuePaths(validate({ request: "x", mode: "small", flags: ["a", "b", "c"] })), ["flags"])
})

check("non-object root and array root are rejected", () => {
  assert.deepStrictEqual(issuePaths(validate(42)), [""])
  assert.match(validate(42).issues[0].message, /expected object, received number/)
})

check("explicit additionalProperties: true allows extra keys", () => {
  const open = {
    type: "object",
    properties: { note: { type: "string" } },
    additionalProperties: true,
  }
  assert.deepStrictEqual(validate({ note: "n", extra: { any: "thing" } }, open).issues, undefined)
})

check("the model-facing JSON Schema is returned unchanged", () => {
  const wrapped = strictInput(schema)
  assert.ok(isStrictInput(wrapped))
  assert.strictEqual(wrapped["~standard"].jsonSchema.input({ target: "draft-2020-12" }), schema)
  assert.strictEqual(wrapped["~standard"].jsonSchema.output({ target: "draft-2020-12" }), schema)
  assert.strictEqual(wrapped["~standard"].vendor, "opencode-teamwork")
  assert.strictEqual(wrapped["~standard"].version, 1)
})

check("every supported keyword listed is accepted", () => {
  const all = {
    type: "object",
    title: "t",
    description: "d",
    properties: {
      s: { type: "string", minLength: 0, maxLength: 5, pattern: "^a", enum: ["a"], title: "s" },
      c: { type: "string", const: "fixed" },
      n: { type: "number", minimum: 0, maximum: 1, exclusiveMinimum: -1, exclusiveMaximum: 2 },
      i: { type: "integer" },
      b: { type: "boolean" },
      z: { type: "null" },
      a: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 2, uniqueItems: true },
      o: { type: "object", additionalProperties: true },
      u: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
    required: ["s"],
    additionalProperties: false,
  }
  assert.deepStrictEqual(validate({ s: "a", a: ["x"], o: { any: 1 }, u: 3 }, all).issues, undefined)
  for (const keyword of Object.keys(all)) {
    assert(SUPPORTED_KEYWORDS.includes(keyword), `${keyword} must be declared supported`)
  }
})

check("unsupported constructs fail loudly at registration", () => {
  const cases = [
    { type: "object", properties: { x: { type: "string", format: "email" } }, additionalProperties: false },
    { type: "object", oneOf: [{ type: "object", properties: {}, additionalProperties: false }] },
    { type: "object", properties: { x: { $ref: "#/$defs/x" } }, additionalProperties: false },
    { type: "object", patternProperties: { "^x": { type: "string" } } },
    { type: "object", properties: {}, additionalProperties: false, not: { type: "string" } },
    { type: "object" },
  ]
  for (const candidate of cases) {
    assert.throws(() => strictInput(candidate), /strictInput:/)
  }
})

check("an object with no properties is only valid with explicit additionalProperties", () => {
  assert.throws(() => strictInput({ type: "object" }), /additionalProperties/)
  assert.doesNotThrow(() => strictInput({ type: "object", additionalProperties: false }))
  assert.doesNotThrow(() => strictInput({ type: "object", additionalProperties: true }))
})

check("a required key absent from properties fails registration", () => {
  assert.throws(
    () => strictInput({ type: "object", properties: { a: { type: "string" } }, required: ["b"], additionalProperties: false }),
    /required property "b"/,
  )
})

check("anyOf failure names the attempted branches and their reasons", () => {
  const unionSchema = {
    type: "object",
    properties: {
      finding: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        ],
      },
    },
    additionalProperties: false,
  }
  const result = validate({ finding: { id: "F1", bogus: true } }, unionSchema)
  assert.deepStrictEqual(issuePaths(result), ["finding"])
  const msg = issueAt(result, "finding").message
  assert.match(msg, /branch 0 \(string\): expected string, received object/)
  assert.match(msg, /branch 1 \(object\): bogus: unknown property/)
})

check("host-repair independence: unknown keys are rejected even without patternProperties or repair pass", () => {
  const plain = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  }
  const wrapped = strictInput(plain)
  // Both non-enumerable guards exist and are invisible to JSON serialization.
  assert.deepStrictEqual(Object.keys(plain).sort(), ["additionalProperties", "properties", "type"])
  assert.ok("patternProperties" in plain && "allOf" in plain)
  // Even if a future host deletes patternProperties before calling validate, strictness holds.
  delete plain.patternProperties
  const result = wrapped["~standard"].validate({ a: "ok", extra: 1 })
  assert.deepStrictEqual(issuePaths(result), ["extra"])
  assert.match(issueAt(result, "extra").message, /unknown property/)
})

if (failed > 0) {
  console.error(`\n${failed} strict input test(s) failed`)
  process.exit(1)
}
console.log(`\n✓ test-tool-schema passed: ${passed} checks, ${SUPPORTED_KEYWORDS.length} supported keywords`)
