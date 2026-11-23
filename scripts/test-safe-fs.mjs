// @heretek-ai/opencode-teamwork-v2 — shared safe-fs / ADR 0004 conformance suite
//
// Hermetic, zero-dependency coverage for plugins/opencode-teamwork/safe-fs.mjs
// and the root-aware read path in tournament.ts:
//   * static intermediate-directory symlink (no outside bytes)
//   * final-component symlink (no outside bytes)
//   * FIFO refusal without hanging (child-process timeout guard)
//   * deterministic fd containment matrix (inside/outside/unlinked/renamed)
//   * intermediate-directory swap race, plus a negative control that MUST leak
//     (a harness that cannot reproduce the bug proves nothing)
//
// fd-containment cases print an explicit SKIP line on platforms without a
// usable /proc/self/fd (macOS/Windows). The static symlink and FIFO cases still
// run there.

import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import assert from "node:assert"
import { readBoundedRunFile } from "../plugins/opencode-teamwork/tournament.ts"
import {
  fdContainmentMode,
  fdWithin,
  readRegularBounded,
  readWithinBounded,
  supportsFdContainment,
} from "../plugins/opencode-teamwork/safe-fs.mjs"

const SENTINEL = "SENTINEL_OUTSIDE_SAFE_FS"
const testDir = mkdtempSync(join(tmpdir(), "teamwork-safe-fs-"))
let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`✗ ${name}\n    ${err && err.message ? err.message : err}`)
  }
}

// A fresh fixture root with a real run directory and a sibling "outside" dir.
function makeFixture() {
  const root = mkdtempSync(join(testDir, "root-"))
  const run = join(root, "run")
  const outside = join(root, "outside")
  mkdirSync(run, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(run, "inside.txt"), "INSIDE\n")
  writeFileSync(join(outside, "secret.json"), SENTINEL + "\n")
  return { root, run, outside }
}

function assertNoSentinel(result, label) {
  const text = JSON.stringify(result)
  assert(!text.includes(SENTINEL), `${label} leaked the outside sentinel: ${text}`)
}

// ---------------------------------------------------------------- static cases

check("static intermediate symlink: run/verify -> outside is refused, no sentinel", () => {
  const { run, outside } = makeFixture()
  writeFileSync(join(outside, "report.json"), `{"status":"PASS","note":"${SENTINEL}"}\n`)
  symlinkSync(outside, join(run, "verify"))
  const res = readBoundedRunFile(run, join(run, "verify", "report.json"), 4096)
  assert.strictEqual(res.status, "error", `expected refusal: ${JSON.stringify(res)}`)
  assert(/refused|symlink|not a regular|outside|containment/i.test(res.error), `refusal must name a reason: ${res.error}`)
  assertNoSentinel(res, "intermediate symlink")
})

check("final symlink: run/report.json -> outside is refused, no sentinel", () => {
  const { run, outside } = makeFixture()
  writeFileSync(join(outside, "report.json"), SENTINEL + "\n")
  symlinkSync(join(outside, "report.json"), join(run, "report.json"))
  const res = readBoundedRunFile(run, join(run, "report.json"), 4096)
  assert.strictEqual(res.status, "error", `expected refusal: ${JSON.stringify(res)}`)
  assert(/refused|symlink|not a regular/i.test(res.error), `refusal must name a reason: ${res.error}`)
  assertNoSentinel(res, "final symlink")
})

check("regular file: readRegularBounded and readWithinBounded return exact inside bytes", () => {
  const { run } = makeFixture()
  const file = join(run, "inside.txt")
  const rootless = readRegularBounded(file, 4096)
  assert.deepStrictEqual(rootless, { status: "ok", text: "INSIDE\n" })
  if (!supportsFdContainment()) {
    console.log("SKIP: /proc/self/fd unavailable — readWithinBounded containment not asserted")
    return
  }
  const within = readWithinBounded(run, file, 4096)
  assert.deepStrictEqual(within, { status: "ok", text: "INSIDE\n" })
})

check("oversize: a file over the cap is reported, never read", () => {
  const { run } = makeFixture()
  writeFileSync(join(run, "big.json"), "x".repeat(64))
  const res = readRegularBounded(join(run, "big.json"), 16)
  assert.strictEqual(res.status, "oversize")
  assert.strictEqual(res.cap, 16)
  assert.strictEqual(res.size, 64)
})

// -------------------------------------------------------------------- FIFO

check("FIFO: readBoundedRunFile refuses without hanging (child timeout)", () => {
  const { run } = makeFixture()
  const fifo = join(run, "events.jsonl")
  const tournamentUrl = new URL("../plugins/opencode-teamwork/tournament.ts", import.meta.url).href
  const code = [
    `import { readBoundedRunFile } from ${JSON.stringify(tournamentUrl)}`,
    `import { execFileSync } from "node:child_process"`,
    `import { join } from "node:path"`,
    `const run = process.env.RUN`,
    `execFileSync("mkfifo", [join(run, "events.jsonl")], { stdio: "ignore" })`,
    `const res = readBoundedRunFile(run, join(run, "events.jsonl"), 4096)`,
    `if (res.status !== "error") throw new Error("expected refusal: " + JSON.stringify(res))`,
    `if (!/refused|not a regular file/i.test(res.error)) throw new Error("no named refusal: " + JSON.stringify(res))`,
    `console.log("REFUSED")`,
  ].join("\n")
  const child = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, RUN: run },
  })
  if (child.error && child.error.code === "ETIMEDOUT") assert.fail("readBoundedRunFile hung on a FIFO")
  if (child.status !== 0 && /mkfifo/.test(child.stderr || "") && /ENOENT/.test(child.stderr || "")) {
    console.log("SKIP: mkfifo unavailable")
    rmSync(fifo, { force: true })
    return
  }
  assert.strictEqual(child.status, 0, `FIFO child failed (${child.status}): ${child.stderr || ""}`)
  assert(/REFUSED/.test(child.stdout || ""), `FIFO child must report REFUSED: ${child.stdout || ""}`)
  rmSync(fifo, { force: true })
})

// ------------------------------------------------------- fd primitive matrix

if (!supportsFdContainment()) {
  console.log(`SKIP: /proc/self/fd unavailable (mode=${fdContainmentMode()}) — fd primitive and race harness not run`)
  check("static symlink/FIFO path still runs without fd containment (recorded)", () => {})
} else {
  check("fd primitive: inside fd is within, outside fd is not", () => {
    const { run, outside } = makeFixture()
    let insideFd = null
    let outsideFd = null
    try {
      insideFd = openSync(join(run, "inside.txt"), "r")
      outsideFd = openSync(join(outside, "secret.json"), "r")
      assert.strictEqual(fdWithin(run, insideFd), true, "inside fd must be within")
      assert.strictEqual(fdWithin(run, outsideFd), false, "outside fd must not be within")
    } finally {
      if (insideFd !== null) closeSync(insideFd)
      if (outsideFd !== null) closeSync(outsideFd)
    }
  })

  check("fd primitive: renamed-out fd is refused", () => {
    const { run, outside } = makeFixture()
    const file = join(run, "inside.txt")
    const fd = openSync(file, "r")
    try {
      renameSync(file, join(outside, "inside.txt"))
      assert.strictEqual(fdWithin(run, fd), false, "a file renamed outside the run must be refused")
    } finally {
      closeSync(fd)
    }
  })

  check("fd primitive: unlinked fd is refused (deleted)", () => {
    const { run } = makeFixture()
    const file = join(run, "inside.txt")
    const fd = openSync(file, "r")
    try {
      unlinkSync(file)
      assert.strictEqual(fdWithin(run, fd), false, "a deleted file must fail closed")
    } finally {
      closeSync(fd)
    }
  })

  check("fd primitive: old root after the run dir is renamed is refused", () => {
    const { root, run } = makeFixture()
    const fd = openSync(join(run, "inside.txt"), "r")
    try {
      renameSync(run, join(root, "run.moved"))
      assert.strictEqual(fdWithin(run, fd), false, "the old realpath must fail closed after a rename")
    } finally {
      closeSync(fd)
    }
  })

  // ------------------------------------------------------------ race harness

  const SWAPPER = `
    const fs = require("node:fs")
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    const SUB = process.env.SUB
    const OUTSIDE = process.env.OUTSIDE
    for (;;) {
      try {
        fs.renameSync(SUB, SUB + ".real")
        fs.symlinkSync(OUTSIDE, SUB)
        sleep(1)
        fs.renameSync(SUB, SUB + ".link")
        fs.renameSync(SUB + ".real", SUB)
        sleep(1)
        fs.unlinkSync(SUB + ".link")
      } catch {}
    }
  `

  function withSwapper(run, fn) {
    const sub = join(run, "sub")
    const outside = join(run, "..", "outside")
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, "secret.json"), "INSIDE_RACE\n")
    writeFileSync(join(outside, "secret.json"), SENTINEL + "\n")
    const child = spawn(process.execPath, ["-e", SWAPPER], {
      env: { ...process.env, SUB: sub, OUTSIDE: outside },
      stdio: "ignore",
    })
    try {
      return fn(child, sub)
    } finally {
      child.kill("SIGKILL")
    }
  }

  // The old pre-check-then-open sequence, with a deliberate delay between the
  // two. This is the negative control: if it cannot leak, the harness is not
  // sensitive to the bug class and a production pass would be meaningless.
  function vulnerableRead(file) {
    try {
      if (!lstatSync(dirname(file)).isDirectory()) return null
      if (!lstatSync(file).isFile()) return null
      const until = Date.now() + 1
      while (Date.now() < until) {}
      return readFileSync(file, "utf8")
    } catch {
      return null
    }
  }

  check("race: intermediate directory swap never returns outside bytes (production)", () => {
    const { run } = makeFixture()
    withSwapper(run, (_child, sub) => {
      const target = join(sub, "secret.json")
      let okInside = 0
      for (let i = 0; i < 2000; i++) {
        const res = readBoundedRunFile(run, target, 4096)
        if (res.status === "ok") {
          assert(!res.text.includes(SENTINEL), "production reader returned outside sentinel")
          okInside++
        }
      }
      assert(okInside > 0, "harness never read the legitimate inside file")
    })
  })

  check("race negative control: the old check-then-open sequence DOES leak", () => {
    const { run } = makeFixture()
    withSwapper(run, (_child, sub) => {
      const target = join(sub, "secret.json")
      let leaked = false
      for (let i = 0; i < 5000 && !leaked; i++) {
        const text = vulnerableRead(target)
        if (text !== null && text.includes(SENTINEL)) leaked = true
      }
      assert(leaked, "negative control never observed the bug; the race harness is not sensitive")
    })
  })
}

rmSync(testDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
