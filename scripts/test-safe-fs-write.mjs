// @heretek-ai/opencode-teamwork-v2 — pinned-fd write containment suite (ADR 0010)
//
// Hermetic, zero-dependency coverage for the write primitives in
// plugins/opencode-teamwork/safe-fs.mjs and the routed plugin writers:
//   1. exact bytes into run/run.verify/new nested dirs, and no fd leak
//   2. static intermediate symlink refusal + a leaking negative control
//   3. nested pin survives an intermediate swap (bytes stay in the real dir)
//   4. root rename after a pin (bytes in the renamed dir OR a clean refusal)
//   5. 1 ms swapper race, 2,000 writes, no marker ever outside
//   6. the same race against an append log
//   7. hardlinked events.jsonl is refused (nlink > 1) + leaking negative control
//   8. two processes x 100 appends through the pinned lock -> seq 1..200
//   9. concurrent ORIGINAL_REQUEST create-once -> exactly one winner
//  10. pre-planted temp-name and destination symlinks/hard links
//  11. non-Linux: static symlink/FIFO cases still run, pinned/race SKIP loudly
//  12. detective fallback post-write refusal + audit event
//
// Pinned/race cases print an explicit SKIP line on platforms without a usable
// /proc/self/fd (macOS/Windows). The static symlink and FIFO cases still run.

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs"
import { tmpdir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import assert from "node:assert"
import {
  appendLineWithin,
  assertSingleSegment,
  createDirWithin,
  fdContainmentMode,
  fdTraversalMode,
  openPinnedRoot,
  pinParent,
  recentWriteAnomalies,
  setFdContainmentModeForTest,
  setFdTraversalModeForTest,
  setIdentityUnavailableForTest,
  setWindowsLexicalModeForTest,
  supportsPinnedWrites,
  unlinkWithin,
  writeFileAtomicAt,
  writeFileAtomicWithin,
  writeOnceWithin,
} from "../plugins/opencode-teamwork/safe-fs.mjs"
import {
  crossProcessLockPath,
  observeLockArtifact,
  recentLockDiagnostics,
  setReleaseHookForTest,
  withCrossProcessLock,
  withPinnedCrossProcessLock,
} from "../plugins/opencode-teamwork/locks.ts"
import { nextEventSeqFromFd } from "../plugins/opencode-teamwork/tools.ts"

const MARKER = "OUTSIDE_WRITE_SENTINEL_DO_NOT_LEAK"
const SECRET = "OUTSIDE_SECRET_SENTINEL"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-safe-fs-write-"))
const PINNED = supportsPinnedWrites()
const safeFsUrl = new URL("../plugins/opencode-teamwork/safe-fs.mjs", import.meta.url).href
const toolsUrl = new URL("../plugins/opencode-teamwork/tools.ts", import.meta.url).href
const locksUrl = new URL("../plugins/opencode-teamwork/locks.ts", import.meta.url).href

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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`✗ ${name}\n    ${err && err.message ? err.message : err}`)
  }
}

function makeFixture() {
  const root = mkdtempSync(join(testDir, "root-"))
  const run = join(root, "run")
  const outside = join(root, "outside")
  mkdirSync(run, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(run, "inside.txt"), "INSIDE\n")
  writeFileSync(join(outside, "secret.json"), SECRET + "\n")
  return { root, run, outside }
}

function markerIn(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isDirectory()) {
      if (markerIn(p)) return true
    } else if (st.isFile()) {
      try {
        if (readFileSync(p, "utf8").includes(MARKER)) return true
      } catch {}
    }
  }
  return false
}

// The old path-based pattern. Kept in a child-process string on purpose: it is
// the vulnerability being demonstrated, not production code.
const VULNERABLE_WRITE = `
  import { mkdirSync, writeFileSync } from "node:fs"
  import { dirname } from "node:path"
  const dest = process.argv[1]
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, process.argv[2])
  console.log("LEAKED")
`

// ---------------------------------------------------------------- 1. basics

check("writes into run, run/verify, and a newly created nested dir land exact bytes", () => {
  const { run } = makeFixture()
  writeFileAtomicWithin(run, "a.txt", "A\n")
  writeFileAtomicWithin(run, "verify/b.txt", "B\n")
  writeFileAtomicWithin(run, "verify/wave/c.txt", "C\n")
  assert.strictEqual(readFileSync(join(run, "a.txt"), "utf8"), "A\n")
  assert.strictEqual(readFileSync(join(run, "verify", "b.txt"), "utf8"), "B\n")
  assert.strictEqual(readFileSync(join(run, "verify", "wave", "c.txt"), "utf8"), "C\n")
})

check("1,000 atomic writes leak no file descriptors", () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — fd-leak count not asserted`)
    return
  }
  const { run } = makeFixture()
  const fdCount = () => readdirSync("/proc/self/fd").length
  const before = fdCount()
  for (let i = 0; i < 1000; i++) writeFileAtomicWithin(run, "verify/report.json", `v${i}`)
  const after = fdCount()
  assert.strictEqual(after, before, `fd leak: ${before} -> ${after}`)
  assert.strictEqual(readFileSync(join(run, "verify", "report.json"), "utf8"), "v999")
})

// ------------------------------------------------- 2. static intermediate link

check("static intermediate symlink: pinned write refuses, outside gains nothing", () => {
  const { run, outside } = makeFixture()
  symlinkSync(outside, join(run, "verify"))
  assert.throws(
    () => writeFileAtomicWithin(run, "verify/report.json", "NOPE"),
    (err) => /refused/.test(String(err.message)),
  )
  assert.strictEqual(existsSync(join(outside, "report.json")), false)
})

check("negative control: the old path-based mkdir+write DOES escape through the symlink", () => {
  const { run, outside } = makeFixture()
  symlinkSync(outside, join(run, "verify"))
  const target = join(run, "verify", "report.json")
  const res = spawnSync(
    process.execPath,
    [...process.execArgv, "--input-type=module", "-e", VULNERABLE_WRITE, target, MARKER],
    { encoding: "utf8", timeout: 15000 },
  )
  assert.strictEqual(res.status, 0, `negative control failed: ${res.stderr || ""}`)
  assert.strictEqual(readFileSync(join(outside, "report.json"), "utf8"), MARKER, "negative control must deposit outside")
})

// -------------------------------------------------------------- 3. nested pin

check("nested pin: a swap of run/verify after the pin cannot redirect the write", () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — nested pin not asserted`)
    return
  }
  const { run, outside } = makeFixture()
  const pin = pinParent(run, "verify/report.json", { create: true })
  assert.strictEqual(pin.status, "ok")
  try {
    // Swap the name after the descriptor is pinned.
    renameSync(join(run, "verify"), join(run, "verify.real"))
    symlinkSync(outside, join(run, "verify"))
    writeFileAtomicAt(pin.dirFd, "report.json", "PINNED_BYTES")
    assert.strictEqual(readFileSync(join(run, "verify.real", "report.json"), "utf8"), "PINNED_BYTES")
    assert.strictEqual(existsSync(join(outside, "report.json")), false)
  } finally {
    closeSync(pin.dirFd)
  }
})

// ---------------------------------------------------------- 4. root rename

check("root rename after pin: bytes stay in the renamed dir, outside unchanged", () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — root rename not asserted`)
    return
  }
  const { run, outside } = makeFixture()
  const root = openPinnedRoot(run)
  assert.strictEqual(root.status, "ok")
  try {
    renameSync(run, join(run, "..", "run.moved"))
    // Through the pinned descriptor the write lands in the renamed directory.
    writeFileAtomicAt(root.fd, "moved.txt", "RENAMED_DIR")
    assert.strictEqual(readFileSync(join(run, "..", "run.moved", "moved.txt"), "utf8"), "RENAMED_DIR")
    // A fresh path-based call fails closed because the old root name is gone.
    assert.throws(() => writeFileAtomicWithin(run, "moved2.txt", "NO"), /refused/)
    assert.strictEqual(existsSync(join(outside, "moved.txt")), false)
  } finally {
    closeSync(root.fd)
  }
})

// ---------------------------------------------------------- 5/6. race harness

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
  writeFileSync(join(sub, "seed.json"), "INSIDE_RACE\n")
  writeFileSync(join(outside, "secret.json"), SECRET + "\n")
  const child = spawn(process.execPath, ["-e", SWAPPER], {
    env: { ...process.env, SUB: sub, OUTSIDE: outside },
    stdio: "ignore",
  })
  try {
    return fn(child, sub)
  } finally {
    child.kill("SIGKILL")
    // Normalise whatever half-swapped state the killed child left behind.
    try {
      if (lstatSync(sub).isSymbolicLink()) unlinkSync(sub)
    } catch {}
    try {
      if (existsSync(`${sub}.real`)) renameSync(`${sub}.real`, sub)
    } catch {}
  }
}

check("race: 2,000 writes to sub/report.json never land outside (<15s)", () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — write race harness not run`)
    return
  }
  const { run, outside } = makeFixture()
  const started = Date.now()
  let ok = 0
  withSwapper(run, () => {
    for (let i = 0; i < 2000; i++) {
      try {
        writeFileAtomicWithin(run, "sub/report.json", JSON.stringify({ i, marker: MARKER }))
        ok++
      } catch {
        // A refusal while the intermediate is a symlink is the correct outcome.
      }
    }
  })
  const elapsed = Date.now() - started
  assert(ok > 0, "harness never completed a legitimate inside write")
  assert.strictEqual(markerIn(outside), false, "a race write leaked the marker outside the run")
  assert(elapsed < 15000, `race harness took ${elapsed}ms (limit 15000ms)`)
})

check("race: append log under a swapped intermediate never writes outside", () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — append race harness not run`)
    return
  }
  const { run, outside } = makeFixture()
  let ok = 0
  withSwapper(run, () => {
    for (let i = 0; i < 500; i++) {
      try {
        appendLineWithin(run, "sub/events.jsonl", () => JSON.stringify({ i, marker: MARKER }) + "\n")
        ok++
      } catch {}
    }
  })
  assert(ok > 0, "harness never completed a legitimate inside append")
  assert.strictEqual(existsSync(join(outside, "events.jsonl")), false, "append race created a file outside")
  const log = join(run, "sub", "events.jsonl")
  assert(existsSync(log), "inside append log is missing after normalisation")
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
  assert(lines.length > 0, "inside append log has no lines")
  for (const line of lines) {
    const parsed = JSON.parse(line)
    assert.strictEqual(typeof parsed.i, "number", "inside append line is not well-formed JSON")
  }
})

// ------------------------------------------------------------- 7. hardlink

check("hardlinked events.jsonl: append refuses (nlink>1), outside unchanged", () => {
  const { run, outside } = makeFixture()
  linkSync(join(outside, "secret.json"), join(run, "events.jsonl"))
  assert.throws(
    () => appendLineWithin(run, "events.jsonl", () => JSON.stringify({ leak: MARKER }) + "\n"),
    (err) => err.reason === "hardlink" || /hard link|nlink/i.test(String(err.message)),
  )
  assert.strictEqual(readFileSync(join(outside, "secret.json"), "utf8"), SECRET + "\n")
})

check("negative control: a plain append through the hardlink DOES modify outside", () => {
  const { run, outside } = makeFixture()
  linkSync(join(outside, "secret.json"), join(run, "events.jsonl"))
  const code = `const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "LEAKED\\n"); console.log("LEAKED")`
  const res = spawnSync(process.execPath, ["-e", code, join(run, "events.jsonl")], { encoding: "utf8", timeout: 15000 })
  assert.strictEqual(res.status, 0, `negative control failed: ${res.stderr || ""}`)
  assert(/LEAKED/.test(readFileSync(join(outside, "secret.json"), "utf8")), "negative control must leak through the hard link")
})

// ------------------------------------------------ 8. two-process append lock

const APPEND_CHILD = `
  import { withPinnedCrossProcessLock } from ${JSON.stringify(locksUrl)}
  import { appendLineWithin } from ${JSON.stringify(safeFsUrl)}
  import { nextEventSeqFromFd } from ${JSON.stringify(toolsUrl)}
  const run = process.env.RUN
  for (let i = 0; i < 100; i++) {
    await withPinnedCrossProcessLock(run, "events.jsonl", () => {
      appendLineWithin(run, "events.jsonl", (fd) => JSON.stringify({ seq: nextEventSeqFromFd(fd), pid: process.pid }) + "\\n")
    })
  }
`

const LOCK_HOLDER = `
  import { withPinnedCrossProcessLock } from ${JSON.stringify(locksUrl)}
  import { writeFileSync } from "node:fs"
  const run = process.env.RUN
  await withPinnedCrossProcessLock(run, "events.jsonl", async () => {
    writeFileSync(process.env.READY, "1")
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
`

function runChild(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("exit", (status) => resolve({ status, stdout, stderr }))
  })
}

await checkAsync("two processes x 100 appends through the pinned lock -> seq 1..200", async () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — cross-process append lock not run`)
    return
  }
  const { run, outside } = makeFixture()
  // Observe the lock artifact inside the run while it is held.
  const ready = join(run, "LOCK_HELD")
  const holder = runChild(LOCK_HOLDER, { RUN: run, READY: ready })
  const deadline = Date.now() + 5000
  while (!existsSync(ready) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert(existsSync(ready), "lock holder never became ready")
  assert(existsSync(join(run, "events.jsonl.lock")), "the lock artifact must live inside the run")
  assert.strictEqual(existsSync(join(outside, "events.jsonl.lock")), false, "the lock artifact must not be created outside")
  const holderRes = await holder
  assert.strictEqual(holderRes.status, 0, holderRes.stderr)

  const [a, b] = await Promise.all([
    runChild(APPEND_CHILD, { RUN: run }),
    runChild(APPEND_CHILD, { RUN: run }),
  ])
  assert.strictEqual(a.status, 0, a.stderr)
  assert.strictEqual(b.status, 0, b.stderr)
  const lines = readFileSync(join(run, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
  assert.strictEqual(lines.length, 200, `expected 200 lines, got ${lines.length}`)
  const seqs = lines.map((line) => {
    const parsed = JSON.parse(line)
    assert.strictEqual(typeof parsed.seq, "number", "every line must carry a numeric seq")
    return parsed.seq
  })
  const unique = [...new Set(seqs)].sort((x, y) => x - y)
  assert.deepStrictEqual(unique, Array.from({ length: 200 }, (_, i) => i + 1), "seq must be exactly 1..200 with no duplicates")
})

// ----------------------------------------------------------- 9. write-once

const WRITE_ONCE_CHILD = `
  import { writeOnceWithin } from ${JSON.stringify(safeFsUrl)}
  try {
    writeOnceWithin(process.env.RUN, "ORIGINAL_REQUEST.md", process.env.BODY)
    console.log("OK")
  } catch (err) {
    if (err.code === "EEXIST") console.log("EEXIST")
    else { console.error(err && err.message); process.exit(2) }
  }
`

await checkAsync("write-once: concurrent ORIGINAL_REQUEST writes -> one wins, one EEXIST", async () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — write-once race not run`)
    return
  }
  const { run } = makeFixture()
  const [a, b] = await Promise.all([
    runChild(WRITE_ONCE_CHILD, { RUN: run, BODY: "REQ-A" }),
    runChild(WRITE_ONCE_CHILD, { RUN: run, BODY: "REQ-B" }),
  ])
  const outcomes = [a.stdout.trim(), b.stdout.trim()].sort()
  assert.deepStrictEqual(outcomes, ["EEXIST", "OK"], `unexpected outcomes: ${a.stdout}|${b.stdout}|${a.stderr}|${b.stderr}`)
  const body = readFileSync(join(run, "ORIGINAL_REQUEST.md"), "utf8")
  assert(body === "REQ-A" || body === "REQ-B", "the winning bytes must be one complete request")
})

// ------------------------------------------- 10. pre-planted temp / target links

check("pre-planted temp-name symlink/hard link: victim unchanged, target written", () => {
  const { run } = makeFixture()
  const victim = join(run, "victim.txt")
  writeFileSync(victim, "ORIGINAL")
  const target = join(run, "manifest.json")
  // The legacy predictable temp names (the pinned writer also uses O_EXCL).
  symlinkSync(victim, `${target}.tmp`)
  linkSync(victim, join(run, "lock.json.tmp"))
  writeFileAtomicWithin(run, "manifest.json", "SAFE")
  assert.strictEqual(readFileSync(victim, "utf8"), "ORIGINAL", "a planted temp link must not overwrite the victim")
  assert.strictEqual(readFileSync(target, "utf8"), "SAFE", "the write must still land at the target")

  // A symlink at the destination is replaced as a directory entry, never followed.
  const destVictim = join(run, "dest-victim.txt")
  writeFileSync(destVictim, "DEST_ORIGINAL")
  symlinkSync(destVictim, join(run, "verdict.json"))
  writeFileAtomicWithin(run, "verdict.json", "SAFE2")
  assert.strictEqual(readFileSync(destVictim, "utf8"), "DEST_ORIGINAL")
  assert.strictEqual(readFileSync(join(run, "verdict.json"), "utf8"), "SAFE2")
})

// -------------------------------------------- 11. non-Linux static + FIFO

check("static symlink refusal runs on every platform (recorded)", () => {
  const { run, outside } = makeFixture()
  symlinkSync(outside, join(run, "verify"))
  assert.throws(() => writeFileAtomicWithin(run, "verify/x.json", "NO"), /refused/)
  assert.strictEqual(existsSync(join(outside, "x.json")), false)
})

check("FIFO at the append target is refused without hanging (child timeout)", () => {
  const { run } = makeFixture()
  const fifo = join(run, "events.fifo")
  const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" })
  if (mk.status !== 0) {
    console.log("SKIP: mkfifo unavailable")
    return
  }
  const code = [
    `import { appendLineWithin } from ${JSON.stringify(safeFsUrl)}`,
    `const run = process.env.RUN`,
    `try { appendLineWithin(run, "events.fifo", () => "{}\\n"); console.log("WROTE") }`,
    `catch (err) { if (/refused|not a regular/i.test(String(err.message))) console.log("REFUSED"); else { console.error(err); process.exit(2) } }`,
  ].join("\n")
  const res = spawnSync(
    process.execPath,
    [...process.execArgv, "--input-type=module", "-e", code],
    { encoding: "utf8", timeout: 15000, env: { ...process.env, RUN: run } },
  )
  if (res.error && res.error.code === "ETIMEDOUT") assert.fail("appendLineWithin hung on a FIFO")
  assert.strictEqual(res.status, 0, `FIFO child failed: ${res.stderr || ""}`)
  assert(/REFUSED/.test(res.stdout || ""), `FIFO must be refused: ${res.stdout || ""}`)
  try {
    unlinkSync(fifo)
  } catch {}
})

// ----------------------------------------- 12. detective fallback post-check

await checkAsync("detective fallback: a post-rename swap is refused and audited", async () => {
  if (!PINNED) {
    console.log(`SKIP: pinned writes unavailable (mode=${fdTraversalMode()}) — deterministic detective hook not run`)
    return
  }
  const { run, outside } = makeFixture()
  assert.strictEqual(fdTraversalMode(), "pinned")
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "verify/report.json", "DETECTIVE", {
          afterRename: ({ destPath }) => {
            // Simulate a transient swap: the just-written bytes are moved
            // outside and a different inode is put back at the destination.
            renameSync(destPath, join(outside, "stolen.json"))
            writeFileSync(destPath, "REPLACED")
          },
        }),
      (err) => /post-write|identity|containment|refused/i.test(String(err.message)),
    )
    assert.strictEqual(readFileSync(join(outside, "stolen.json"), "utf8"), "DETECTIVE")
    const anomalies = recentWriteAnomalies().slice(before)
    assert(anomalies.some((a) => a.kind.startsWith("detective")), "the post-check must record an anomaly")
    // The tools module registers the audit sink; importing it above means a
    // write_anomaly line is best-effort appended to the run event log.
    const events = existsSync(join(run, "events.jsonl")) ? readFileSync(join(run, "events.jsonl"), "utf8") : ""
    assert(/write_anomaly/.test(events), "the anomaly must be recorded as an audit event")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

// In non-pinned mode, record the skip explicitly for every pinned block.
if (!PINNED) {
  console.log(`SKIP: pinned write containment unavailable (mode=${fdTraversalMode()}) — race/nested/root/write-once blocks skipped`)
}

// ------------------------------------------------- 13. detective lock/append
//
// macOS/Windows have no fd-to-path primitive. These cases exercise the
// path-based *detective* branches on this host (via the test overrides) so the
// fallback is covered on Linux instead of only by manual platform runs.

await checkAsync("detective mode: path-based cross-process lock acquires/runs/releases and records the anomaly", async () => {
  const { run } = makeFixture()
  setFdTraversalModeForTest("detective")
  try {
    const beforeAnomalies = recentWriteAnomalies().length
    const beforeDiagnostics = recentLockDiagnostics(50).length
    let ran = false
    await withPinnedCrossProcessLock(run, "verify/state.json", async () => {
      ran = true
      writeFileAtomicWithin(run, "verify/x.json", "DETECTIVE_LOCK")
    })
    assert(ran, "the detective lock body must run")
    assert.strictEqual(readFileSync(join(run, "verify", "x.json"), "utf8"), "DETECTIVE_LOCK")
    assert.strictEqual(existsSync(join(run, "verify", "state.json.lock")), false, "the detective lock must be released")
    const anomalies = recentWriteAnomalies().slice(beforeAnomalies)
    assert(anomalies.some((a) => a.kind === "detective-lock"), "the detective lock must record a detective-lock anomaly")
    const diagnostics = recentLockDiagnostics(50).slice(beforeDiagnostics)
    assert(diagnostics.some((d) => d.event === "detective_lock"), "the detective lock must record a lock diagnostic")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

await checkAsync("fail-closed mode: a path-based lock still refuses instead of silently falling back", async () => {
  const { run } = makeFixture()
  setFdTraversalModeForTest("fail-closed")
  try {
    await assert.rejects(
      withPinnedCrossProcessLock(run, "verify/state.json", () => "never"),
      /unavailable|refused/i,
      "fail-closed must throw, not degrade to detective",
    )
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("detective append: a static final-component symlink is refused and the victim is untouched", () => {
  const { run, outside } = makeFixture()
  const victim = join(outside, "bashrc")
  writeFileSync(victim, "ORIGINAL\n")
  symlinkSync(victim, join(run, "pitfalls.md"))
  setFdTraversalModeForTest("detective")
  try {
    assert.throws(
      () => appendLineWithin(run, "pitfalls.md", () => "{}\n"),
      (err) => /refused|symlink|ELOOP/i.test(String(err.message)),
    )
    assert.strictEqual(readFileSync(victim, "utf8"), "ORIGINAL\n", "the symlink target must not be appended")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("detective append: a post-write identity mismatch is refused and audited", () => {
  const { run, outside } = makeFixture()
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        appendLineWithin(run, "events.jsonl", () => JSON.stringify({ ok: 1 }) + "\n", {
          afterAppend: ({ dest }) => {
            renameSync(dest, join(outside, "stolen-append.jsonl"))
            writeFileSync(dest, "REPLACED\n")
          },
        }),
      (err) => /identity|refused/i.test(String(err.message)),
    )
    assert.strictEqual(readFileSync(join(outside, "stolen-append.jsonl"), "utf8"), JSON.stringify({ ok: 1 }) + "\n")
    const anomalies = recentWriteAnomalies().slice(before)
    assert(anomalies.some((a) => a.kind === "detective-append"), "the identity mismatch must record a detective-append anomaly")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("detective append: the fd-containment override exercises the non-Linux branch on Linux", () => {
  const { run } = makeFixture()
  setFdTraversalModeForTest("detective")
  setFdContainmentModeForTest("unsupported")
  try {
    assert.strictEqual(fdContainmentMode(), "unsupported")
    appendLineWithin(run, "events.jsonl", () => JSON.stringify({ branch: "unsupported" }) + "\n")
    assert.strictEqual(readFileSync(join(run, "events.jsonl"), "utf8").trim(), JSON.stringify({ branch: "unsupported" }))
  } finally {
    setFdContainmentModeForTest(null)
    setFdTraversalModeForTest(null)
  }
})

check("detective createDir: a post-create swap outside the run is refused and audited", () => {
  const { run, outside } = makeFixture()
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        createDirWithin(run, "sub", {
          afterCreate: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            symlinkSync(outside, join(run, "sub"))
          },
        }),
      (err) => /post-create|containment|refused/i.test(String(err.message)),
    )
    assert(recentWriteAnomalies().slice(before).some((a) => a.kind === "detective-create-dir"))
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("detective unlink: a post-unlink parent swap is refused, and a delete never creates parents", () => {
  const { run, outside } = makeFixture()
  mkdirSync(join(run, "sub"), { recursive: true })
  writeFileSync(join(run, "sub", "gone.txt"), "bye\n")
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        unlinkWithin(run, "sub/gone.txt", {
          afterUnlink: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            symlinkSync(outside, join(run, "sub"))
          },
        }),
      (err) => /post-unlink|containment|refused/i.test(String(err.message)),
    )
    assert(recentWriteAnomalies().slice(before).some((a) => a.kind === "detective-unlink"))
    assert.strictEqual(unlinkWithin(run, "never-created/gone.txt"), false, "a missing file is a no-op delete")
    assert.strictEqual(existsSync(join(run, "never-created")), false, "a delete must not create parent directories")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("identity: a filesystem reporting dev/ino 0 is refused by name", () => {
  const { run } = makeFixture()
  setIdentityUnavailableForTest(true)
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () => writeFileAtomicWithin(run, "identity.txt", "NOPE"),
      (err) => err.reason === "identity-unavailable" || /identity/i.test(String(err.message)),
    )
    assert(recentWriteAnomalies().slice(before).some((a) => a.kind === "identity-unavailable"))
  } finally {
    setIdentityUnavailableForTest(false)
  }
})

check("Windows lexical policy: trailing dot/space, reserved devices, colon, and non-round-trip names are refused", () => {
  setWindowsLexicalModeForTest(true)
  try {
    for (const bad of [".. ", "...", "CON", "a:b", "..\\", "foo.", "LPT9.log"]) {
      assert.throws(() => assertSingleSegment(bad), /invalid single path segment|refused/i, `"${bad}" must be refused`)
    }
    for (const good of ["name.txt", "a-b_c", "..foo", "report-1.json"]) {
      assert.strictEqual(assertSingleSegment(good), good, `"${good}" must be accepted`)
    }
  } finally {
    setWindowsLexicalModeForTest(null)
  }
  if (process.platform !== "win32") {
    assert.doesNotThrow(() => assertSingleSegment("CON"), "Linux behaviour must be unchanged")
  }
})

// ------------------------------------------------- 14. release / mkdir races

await checkAsync("release TOCTOU: a lock published immediately after release survives", async () => {
  const target = join(testDir, "release-target.json")
  const lockPath = crossProcessLockPath(target)
  let published = false
  setReleaseHookForTest(({ lockPath: path }) => {
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: "new-lock" }),
    )
    published = true
  })
  try {
    await withCrossProcessLock(target, () => undefined, { timeoutMs: 500 })
  } finally {
    setReleaseHookForTest(null)
  }
  assert(published, "the release seam must run")
  assert.strictEqual(observeLockArtifact(lockPath)?.nonce, "new-lock", "a lock published after quarantine must survive release")
  rmSync(lockPath, { force: true })
})

await checkAsync("mkdir fallback: an owner-write failure removes the directory and fails closed", async () => {
  const target = join(testDir, "mkdir-target.json")
  let ran = false
  await assert.rejects(
    withCrossProcessLock(
      target,
      () => {
        ran = true
      },
      { disableHardlinks: true, failOwnerWrite: true, timeoutMs: 200 },
    ),
    /could not publish the lock owner|refused/i,
  )
  assert.strictEqual(ran, false, "the critical section must not run without a published owner")
  assert.strictEqual(existsSync(crossProcessLockPath(target)), false, "the broken lock directory must be removed")
})

rmSync(testDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
