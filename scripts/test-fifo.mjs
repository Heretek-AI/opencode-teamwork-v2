// scripts/test-fifo.mjs — shared FIFO no-hang probe for the read-only suites.
//
// Creates a FIFO at a run's events.jsonl in a child process, imports the module
// under test there, and asserts the module returns instead of blocking. The
// child (with a timeout guard) is what proves "no hang": a regression cannot
// wedge the parent suite.

import { spawnSync } from "node:child_process"
import assert from "node:assert"

/**
 * Run `assertionLines` in a child after replacing `<run>/events.jsonl` with a
 * FIFO. `importNames` is the named-import list for `moduleUrl`.
 */
export function runFifoProbe({ root, session, moduleUrl, importNames, assertionLines, failureLabel, timeoutMessage }) {
  const code = [
    `import { ${importNames} } from ${JSON.stringify(moduleUrl)}`,
    `import { execFileSync } from "node:child_process"`,
    `import { join } from "node:path"`,
    `const root = process.argv[1]`,
    `const events = join(root, ".opencode", "teamwork", ${JSON.stringify(session)}, "events.jsonl")`,
    `try {`,
    `  execFileSync("mkfifo", [events], { stdio: "ignore" })`,
    `} catch (err) {`,
    `  if (err && err.code === "ENOENT") { console.log("SKIP: mkfifo unavailable"); process.exit(0) }`,
    `  throw err`,
    `}`,
    ...assertionLines,
    `console.log("REFUSED")`,
  ].join("\n")

  const res = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", code, root], {
    encoding: "utf8",
    timeout: 15000,
  })
  if (res.error && res.error.code === "ETIMEDOUT") assert.fail(timeoutMessage)
  assert.strictEqual(res.status, 0, `${failureLabel} failed (status ${res.status}): ${res.stderr || ""}`)
  assert(/REFUSED|SKIP/.test(res.stdout || ""), `FIFO child must report REFUSED or SKIP: ${res.stdout || ""}`)
}
