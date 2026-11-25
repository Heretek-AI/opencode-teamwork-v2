// text-utils.ts — shared control-character sanitisation for artifact fields
//
// One implementation for the lemma and tournament writers (and their callers),
// so a persisted field cannot drift between routes. Erasable TypeScript only:
// zero runtime dependencies and compatible with Node `--experimental-strip-types`.
//
// `clean` is the single-line form: every C0/C1 control character and Unicode
// line/paragraph separator becomes a space, then the result is capped.
// `cleanBlock` keeps "\n" so one line can hold one round, and marks truncation
// with "…" while staying within `max`.
//
// Both accept only primitives: objects, arrays, symbols and functions become
// "" instead of being stringified, so a hostile `toString` cannot inject text.

function asStr(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

export function clean(value: unknown, max = 64): string {
  return asStr(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .slice(0, max)
}

export function cleanBlock(value: unknown, max = 2000): string {
  const s = asStr(value).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s
}
