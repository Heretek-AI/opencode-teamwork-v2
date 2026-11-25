// Strict tool input validation (ADR 0019).
//
// OpenCode 2.4.1 compiles a raw JSON-Schema tool input into an Effect codec and
// decodes with `onExcessProperty: "ignore"`, so `additionalProperties: false`
// does not reject unknown keys: they are stripped before `execute`
// (`packages/core/src/tool/runtime.ts:88-98,115-121,187-201`; the A4 harness
// recorded this as a host limitation).
//
// The host does accept a Standard Schema as `Tool.ValueSchema`
// (`packages/schema/src/tool.ts:82`) and routes it through a different path:
//
//   * `validateInput` calls `validateStandard` for anything with a `~standard`
//     key (`runtime.ts:88`, `:148-149`), which invokes
//     `schema["~standard"].validate(value)` (`runtime.ts:155-161`).
//   * Validation issues become `Tool.Error("Invalid arguments for tool ...")`
//     with every issue path rendered (`runtime.ts:76-82`, `:101-113`).
//   * The model-facing JSON Schema is taken from
//     `schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })`
//     (`runtime.ts:169-174`, `:181-185`), so the raw schema is preserved.
//
// This module supplies that Standard Schema. It has no dependencies and
// deliberately implements a small, explicit JSON-Schema subset. `strictInput`
// asserts the subset at registration: a schema that uses a construct this
// validator does not enforce fails loudly instead of silently accepting input.
//
// Strictness is JSON-Schema-faithful: an object rejects undeclared keys unless
// it explicitly opts into them with `additionalProperties: true` (or a schema).
// The eight open maps in the tool set are deliberate (tournament config, extra
// task/check fields) and stay open; every object that lists `properties`
// without that opt-in rejects unknown keys, at any nesting depth.

/** Marker so `scripts/test-catalog.mjs` can prove every registration is wrapped. */
const STRICT_INPUT = Symbol.for("opencode-teamwork.strictInput")

/**
 * Every keyword this validator understands. `description`/`title` are
 * annotations (never validated); everything else has an enforcement path in
 * `validateValue`. Keep this list and that code in lockstep.
 */
export const SUPPORTED_KEYWORDS = Object.freeze([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  // Numeric bounds
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  // String bounds
  "minLength",
  "maxLength",
  "pattern",
  // Array bounds
  "minItems",
  "maxItems",
  "uniqueItems",
  // Annotations
  "description",
  "title",
])

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

const pathText = (path) =>
  path.reduce((text, segment) => (typeof segment === "number" ? `${text}[${segment}]` : text ? `${text}.${segment}` : String(segment)), "") || "root"

/**
 * Assert that `schema` uses only keywords this validator enforces, and that
 * each keyword has the shape the validator expects. Throws on the first
 * unsupported construct so a registration failure is loud and locatable.
 */
function assertSupportedSchema(schema, path = []) {
  if (!isRecord(schema)) throw new Error(`strictInput: schema at ${pathText(path)} must be an object`)
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new Error(
        `strictInput: unsupported keyword "${key}" at ${pathText(path)}; ` +
          `supported: ${SUPPORTED_KEYWORDS.join(", ")} (ADR 0019)`,
      )
    }
  }

  if (schema.type !== undefined && !TYPES.has(schema.type)) {
    throw new Error(`strictInput: unsupported type ${JSON.stringify(schema.type)} at ${pathText(path)}`)
  }
  if (schema.type === undefined && schema.anyOf === undefined) {
    throw new Error(`strictInput: schema at ${pathText(path)} must declare "type" or "anyOf"`)
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`strictInput: "enum" at ${pathText(path)} must be a non-empty array`)
  }
  if (schema.const !== undefined && schema.enum !== undefined) {
    throw new Error(`strictInput: "const" and "enum" cannot both appear at ${pathText(path)}`)
  }

  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`strictInput: "properties" at ${pathText(path)} must be an object`)
    for (const [name, child] of Object.entries(schema.properties)) {
      assertSupportedSchema(child, [...path, name])
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) {
      throw new Error(`strictInput: "required" at ${pathText(path)} must be an array of strings`)
    }
    for (const name of schema.required) {
      if (schema.properties !== undefined && !Object.prototype.hasOwnProperty.call(schema.properties, name)) {
        throw new Error(`strictInput: required property "${name}" at ${pathText(path)} is not declared in properties`)
      }
    }
  }
  if (schema.type === "object" && schema.properties === undefined && schema.additionalProperties === undefined) {
    throw new Error(
      `strictInput: object schema at ${pathText(path)} must declare "properties" or "additionalProperties"; ` +
        `an unconstrained object cannot be validated strictly`,
    )
  }
  if (schema.additionalProperties !== undefined) {
    if (typeof schema.additionalProperties === "boolean") {
      // fine
    } else if (isRecord(schema.additionalProperties)) {
      assertSupportedSchema(schema.additionalProperties, [...path, "*"])
    } else {
      throw new Error(`strictInput: "additionalProperties" at ${pathText(path)} must be a boolean or a schema`)
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) throw new Error(`strictInput: "items" at ${pathText(path)} must be a schema object`)
    assertSupportedSchema(schema.items, [...path, "[]"])
  }
  if (schema.type === "array" && schema.items === undefined) {
    throw new Error(`strictInput: array schema at ${pathText(path)} must declare "items"`)
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new Error(`strictInput: "anyOf" at ${pathText(path)} must be a non-empty array`)
    }
    schema.anyOf.forEach((child, index) => assertSupportedSchema(child, [...path, `anyOf[${index}]`]))
  }

  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) {
      throw new Error(`strictInput: "${key}" at ${pathText(path)} must be a finite number`)
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      throw new Error(`strictInput: "${key}" at ${pathText(path)} must be a non-negative integer`)
    }
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== "string") {
    throw new Error(`strictInput: "pattern" at ${pathText(path)} must be a string`)
  }
  return schema
}

const sameValue = (a, b) => {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const fail = (issues, path, message) => issues.push({ path: [...path], message })

const describe = (value) => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Validate `value` against the supported schema subset, appending issues. */
function validateValue(schema, value, path, issues) {
  // `undefined` is not JSON; treat it as an absent optional property.
  if (value === undefined) return

  if (schema.enum !== undefined && !schema.enum.some((candidate) => sameValue(candidate, value))) {
    fail(issues, path, `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`)
    return
  }
  if (schema.const !== undefined && !sameValue(schema.const, value)) {
    fail(issues, path, `must equal ${JSON.stringify(schema.const)}`)
    return
  }
  if (schema.anyOf !== undefined) {
    const branchFailures = []
    const matches = schema.anyOf.some((child, index) => {
      const nested = []
      validateValue(child, value, path, nested)
      if (nested.length === 0) return true
      const label = child.title || child.type || `branch[${index}]`
      // Name every failing field in the branch (up to 4), not just the first:
      // a conditional schema such as teamwork_plan's plan/follow-up pair must
      // tell the caller that BOTH topology and tasks are missing.
      const detail = nested
        .slice(0, 4)
        .map((issue) => {
          const relPath = issue.path.slice(path.length)
          const loc = relPath.length > 0 ? `${pathText(relPath)}: ` : ""
          return `${loc}${issue.message}`
        })
        .join(", ")
      const more = nested.length > 4 ? `, ...and ${nested.length - 4} more` : ""
      branchFailures.push(`branch ${index} (${label}): ${detail}${more}`)
      return false
    })
    if (!matches) {
      const detail = branchFailures.slice(0, 4).join("; ")
      const more = branchFailures.length > 4 ? `; ...and ${branchFailures.length - 4} more branch(es)` : ""
      fail(issues, path, `must match one of the allowed shapes (${detail}${more})`)
      return
    }
  }

  switch (schema.type) {
    case "object": {
      if (!isRecord(value)) {
        fail(issues, path, `expected object, received ${describe(value)}`)
        return
      }
      for (const name of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
          fail(issues, [...path, name], "required property is missing")
        }
      }
      for (const [name, item] of Object.entries(value)) {
        if (item === undefined) continue
        const declared = schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, name)
        if (declared) {
          validateValue(schema.properties[name], item, [...path, name], issues)
          continue
        }
        if (schema.additionalProperties === true) continue
        if (isRecord(schema.additionalProperties)) {
          validateValue(schema.additionalProperties, item, [...path, name], issues)
          continue
        }
        // `false` or absent (with `properties`) is strict.
        fail(issues, [...path, name], "unknown property")
      }
      return
    }
    case "array": {
      if (!Array.isArray(value)) {
        fail(issues, path, `expected array, received ${describe(value)}`)
        return
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        fail(issues, path, `must contain at least ${schema.minItems} item(s)`)
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        fail(issues, path, `must contain at most ${schema.maxItems} item(s)`)
      }
      if (schema.uniqueItems === true) {
        const seen = new Set()
        for (const item of value) {
          const key = JSON.stringify(item)
          if (seen.has(key)) fail(issues, path, "items must be unique")
          seen.add(key)
        }
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => validateValue(schema.items, item, [...path, index], issues))
      }
      return
    }
    case "string": {
      if (typeof value !== "string") {
        fail(issues, path, `expected string, received ${describe(value)}`)
        return
      }
      const length = [...value].length
      if (schema.minLength !== undefined && length < schema.minLength) {
        fail(issues, path, `must be at least ${schema.minLength} character(s)`)
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        fail(issues, path, `must be at most ${schema.maxLength} character(s)`)
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        fail(issues, path, `must match pattern ${schema.pattern}`)
      }
      return
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(issues, path, `expected ${schema.type}, received ${describe(value)}`)
        return
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        fail(issues, path, "expected integer")
        return
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        fail(issues, path, `must be >= ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        fail(issues, path, `must be <= ${schema.maximum}`)
      }
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        fail(issues, path, `must be > ${schema.exclusiveMinimum}`)
      }
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
        fail(issues, path, `must be < ${schema.exclusiveMaximum}`)
      }
      return
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(issues, path, `expected boolean, received ${describe(value)}`)
      return
    }
    case "null": {
      if (value !== null) fail(issues, path, `expected null, received ${describe(value)}`)
      return
    }
    default:
      return
  }
}

/**
 * Attach non-enumerable repair guards to every strict object node.
 *
 * OpenCode 2.4.1's built-in `opencode.tool.input.repair` plugin runs in
 * `execute.before` before our Standard Schema validator and deletes undeclared
 * keys whenever `schema.additionalProperties === false && !patterned && !composed`
 * (`packages/core/src/plugin/tool-input-repair.ts:161-173`).
 *
 * Attaching both non-enumerable `patternProperties: {}` AND `allOf: []` keeps
 * the serialized model-facing JSON Schema byte-identical while surviving even
 * if a future host stops checking `patternProperties` alone. When host repair
 * is absent or disabled, `~standard.validate` enforces strictness directly.
 *
 * `$ref` and `oneOf` remain intentionally unsupported and are refused loudly
 * at registration time (`assertSupportedSchema`) rather than weakening
 * validation or pulling in an external JSON Schema resolver.
 */
function guardRepairPass(schema) {
  if (!isRecord(schema)) return
  if (schema.type === "object" && schema.additionalProperties === false) {
    if (!("patternProperties" in schema)) {
      Object.defineProperty(schema, "patternProperties", {
        value: Object.freeze({}),
        enumerable: false,
        configurable: true,
      })
    }
    if (!("allOf" in schema)) {
      Object.defineProperty(schema, "allOf", {
        value: Object.freeze([]),
        enumerable: false,
        configurable: true,
      })
    }
  }
  for (const child of Object.values(schema.properties ?? {})) guardRepairPass(child)
  if (isRecord(schema.items)) guardRepairPass(schema.items)
  if (isRecord(schema.additionalProperties)) guardRepairPass(schema.additionalProperties)
  for (const child of schema.anyOf ?? []) guardRepairPass(child)
}

/**
 * Wrap a JSON Schema in a Standard Schema that validates strictly and exposes
 * the schema unchanged to the host/model. The schema is asserted first, so an
 * unsupported construct fails registration instead of weakening validation.
 */
export function strictInput(jsonSchema) {
  assertSupportedSchema(jsonSchema)
  // OpenCode 2.4.1 runs a built-in `opencode.tool.input.repair` pass before the
  // runtime validator. When a schema says `additionalProperties: false`, that
  // pass DELETES undeclared keys (`repairObject`, plugin
  // `opencode.tool.input.repair` in @opencode/core 2.4.1), so the strict
  // validator would never see the key it must reject. The repair pass skips
  // that deletion when `patternProperties` is present. An empty map declares no
  // pattern, so it changes no validation semantics; it is non-enumerable, so
  // the model-facing catalog still serializes the schema byte-for-byte.
  guardRepairPass(jsonSchema)
  const standard = {
    "~standard": {
      version: 1,
      vendor: "opencode-teamwork",
      validate(value) {
        const issues = []
        validateValue(jsonSchema, value, [], issues)
        return issues.length > 0 ? { issues } : { value }
      },
      jsonSchema: {
        // The runtime calls this to build the model-facing catalog
        // (runtime.ts:181-185). Returning the same object keeps the catalog
        // byte-identical to the pre-0.18.1 schema.
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  }
  Object.defineProperty(standard, STRICT_INPUT, { value: true })
  return standard
}

/** True when `value` came from `strictInput` in this process. */
export function isStrictInput(value) {
  return typeof value === "object" && value !== null && value[STRICT_INPUT] === true
}
