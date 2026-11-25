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
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs"
import { tmpdir, hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import assert from "node:assert"
import {
  appendLineWithin,
  assertPinnedWritePolicy,
  assertSingleSegment,
  createDirWithin,
  fdContainmentMode,
  fdTraversalMode,
  listContainmentIncidents,
  openPinnedRoot,
  pinParent,
  recentWriteAnomalies,
  setIncidentDirForTest,
  setMaxIncidentFilesForTest,
  setDarwinRootFdCheckForTest,
  setFdContainmentModeForTest,
  setFdTraversalModeForTest,
  setIdentityUnavailableForTest,
  setRequirePinnedWritesForTest,
  setRunRequirePinnedWrites,
  setWindowsLexicalModeForTest,
  setWriteAnomalyAuditPathForTest,
  supportsPinnedWrites,
  unacknowledgedWriteAnomalies,
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
import { assertRunRootIdentity, writeSafeRunJson } from "../plugins/opencode-teamwork/tournament.ts"

const MARKER = "OUTSIDE_WRITE_SENTINEL_DO_NOT_LEAK"
const SECRET = "OUTSIDE_SECRET_SENTINEL"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-safe-fs-write-"))
// Keep the durable anomaly audit hermetic: never write to the real config dir.
setWriteAnomalyAuditPathForTest(join(testDir, "write-anomalies.jsonl"))
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
  if (!makeTestLink(outside, join(run, "verify"), "dir")) return
  assert.throws(
    () => writeFileAtomicWithin(run, "verify/report.json", "NOPE"),
    (err) => /refused/.test(String(err.message)),
  )
  assert.strictEqual(existsSync(join(outside, "report.json")), false)
})

check("negative control: the old path-based mkdir+write DOES escape through the symlink", () => {
  const { run, outside } = makeFixture()
  if (!makeTestLink(outside, join(run, "verify"), "dir")) return
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
    if (!makeTestLink(outside, join(run, "verify"), "dir")) return
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
  if (!makeTestLink(victim, `${target}.tmp`, "file")) return
  linkSync(victim, join(run, "lock.json.tmp"))
  writeFileAtomicWithin(run, "manifest.json", "SAFE")
  assert.strictEqual(readFileSync(victim, "utf8"), "ORIGINAL", "a planted temp link must not overwrite the victim")
  assert.strictEqual(readFileSync(target, "utf8"), "SAFE", "the write must still land at the target")

  // A symlink at the destination is replaced as a directory entry, never followed.
  const destVictim = join(run, "dest-victim.txt")
  writeFileSync(destVictim, "DEST_ORIGINAL")
  if (!makeTestLink(destVictim, join(run, "verdict.json"), "file")) return
  writeFileAtomicWithin(run, "verdict.json", "SAFE2")
  assert.strictEqual(readFileSync(destVictim, "utf8"), "DEST_ORIGINAL")
  assert.strictEqual(readFileSync(join(run, "verdict.json"), "utf8"), "SAFE2")
})

// -------------------------------------------- 11. non-Linux static + FIFO

check("static symlink refusal runs on every platform (recorded)", () => {
  const { run, outside } = makeFixture()
  if (!makeTestLink(outside, join(run, "verify"), "dir")) return
  assert.throws(() => writeFileAtomicWithin(run, "verify/x.json", "NO"), /refused/)
  assert.strictEqual(existsSync(join(outside, "x.json")), false)
})

check("FIFO at the append target is refused without hanging (child timeout)", () => {
  if (process.platform === "win32") {
    console.log("SKIP: named pipes (mkfifo) are unavailable on this runner; FIFO append refusal recorded")
    return
  }
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
  // This case runs on every platform: on Linux it injects detective mode, and
  // on macOS/Windows detective is the real mode already.
  const { run, outside } = makeFixture()
  if (PINNED) {
    assert.strictEqual(fdTraversalMode(), "pinned")
    setFdTraversalModeForTest("detective")
  }
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

// ------------------------------------- 12b. detective temp/rename evidence

check("detective temp/rename failure: evidence is recorded, never a bare ENOENT/EISDIR", () => {
  const { run } = makeFixture()
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    mkdirSync(join(run, "verify"), { recursive: true })
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "verify/leak.json", "LEAKED_BYTES", {
          afterTemp: ({ dest }) => {
            // The destination is replaced by a directory after the temp write,
            // so the rename fails while the temp bytes already exist.
            mkdirSync(dest)
          },
        }),
      (err) => err?.reason === "postcheck" && /could not be written atomically/.test(String(err.message)),
      "a rename failure after the temp write must refuse with reason postcheck",
    )
    const anomalies = recentWriteAnomalies().slice(before)
    const temp = anomalies.find((a) => a.kind === "detective-temp")
    assert(temp, `a detective-temp anomaly must be recorded: ${JSON.stringify(anomalies)}`)
    assert.strictEqual(temp.phase, "rename")
    assert.strictEqual(temp.bytesWritten, "LEAKED_BYTES".length)
    assert(/^[0-9a-f]{64}$/.test(temp.intendedSha256), "the intended sha256 must be recorded")
    assert(typeof temp.tempPath === "string" && temp.tempPath.includes("leak.json."))
    assert.strictEqual(existsSync(join(run, "verify", "leak.json.tmp")), false, "no bare temp name may remain")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("detective post-check: a same-inode overwrite is refused by re-hashing the bytes", () => {
  const { run } = makeFixture()
  setFdTraversalModeForTest("detective")
  try {
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "verify/same-inode.json", "ORIGINAL", {
          afterRename: ({ destPath }) => {
            // Truncate/write keeps the inode; only the bytes change.
            writeFileSync(destPath, "TAMPERED")
          },
        }),
      (err) => err?.reason === "identity" && /byte-identity/.test(String(err.message)),
      "a byte mismatch on the same inode must be an identity refusal",
    )
  } finally {
    setFdTraversalModeForTest(null)
  }
})

check("detective afterRename swap: exactly one anomaly and the destination is never deleted", () => {
  const { run, outside } = makeFixture()
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    const dest = join(run, "verify", "swapped.json")
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "verify/swapped.json", "PAYLOAD", {
          afterRename: ({ destPath }) => {
            renameSync(destPath, join(outside, "stolen.json"))
            writeFileSync(destPath, "REPLACEMENT")
          },
        }),
      (err) => /identity|post-write|refused/i.test(String(err.message)),
    )
    const anomalies = recentWriteAnomalies().slice(before).filter((a) => a.kind.startsWith("detective"))
    // The intent record is not a refusal; only the post-check refusal counts.
    const refusals = anomalies.filter((a) => a.kind !== "detective_mode")
    assert.strictEqual(refusals.length, 1, `exactly one anomaly must be recorded: ${JSON.stringify(refusals)}`)
    assert.strictEqual(existsSync(dest), true, "the destination must not be unlinked after a containment refusal")
    assert.strictEqual(readFileSync(dest, "utf8"), "REPLACEMENT")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

await checkAsync("detective SIGKILL between rename and post-check leaves an uncommitted intent", async () => {
  const { run } = makeFixture()
  const audit = join(testDir, "sigkill-anomalies.jsonl")
  const code = [
    `import { writeFileAtomicWithin, setFdTraversalModeForTest, setWriteAnomalyAuditPathForTest } from ${JSON.stringify(safeFsUrl)}`,
    `setWriteAnomalyAuditPathForTest(process.env.AUDIT)`,
    `setFdTraversalModeForTest("detective")`,
    `writeFileAtomicWithin(process.env.RUN, "killed.json", "KILLED_BYTES", { afterRename: () => process.kill(process.pid, "SIGKILL") })`,
    `console.log("WRITE_DONE")`,
  ].join("\n")
  const res = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, RUN: run, AUDIT: audit },
  })
  if (process.platform === "win32") {
    // TerminateProcess does not report a POSIX signal: the child exits
    // non-zero with signal null. The marker proves it never reached the
    // post-check; a completed write is a hard failure, never a silent pass.
    const completed = /WRITE_DONE/.test(res.stdout ?? "")
    const exitedNonZero = typeof res.status === "number" && res.status !== 0
    const terminated = res.signal !== null
    assert(
      !completed,
      `the child must die between rename and post-check, not complete: status=${res.status} signal=${res.signal} ${res.stderr || ""}`,
    )
    assert(
      exitedNonZero || terminated,
      `the child must be terminated on win32 (status=${res.status}, signal=${res.signal}): ${res.stderr || ""}`,
    )
  } else {
    assert.strictEqual(res.signal, "SIGKILL", `the child must die between rename and post-check: ${res.stderr || ""}`)
  }
  setWriteAnomalyAuditPathForTest(audit)
  try {
    const pending = unacknowledgedWriteAnomalies(run)
    assert(
      pending.some((a) => a.kind === "detective-temp"),
      `the uncommitted intent must surface as detective-temp: ${JSON.stringify(pending)}`,
    )
  } finally {
    setWriteAnomalyAuditPathForTest(join(testDir, "write-anomalies.jsonl"))
  }
})

// ------------------------------------- 12c. unlocked-writer policy (ADR 0013)

await checkAsync("policy: a fresh process refuses an unlocked tournament write from the plan flag", async () => {
  const { run } = makeFixture()
  writeFileSync(join(run, "plan.dag.json"), JSON.stringify({ requirePinnedWrites: true }, null, 2))
  const code = [
    `import { writeSafeRunJson } from ${JSON.stringify(new URL("../plugins/opencode-teamwork/tournament.ts", import.meta.url).href)}`,
    `import { setFdTraversalModeForTest } from ${JSON.stringify(safeFsUrl)}`,
    `import { join } from "node:path"`,
    `setFdTraversalModeForTest("detective")`,
    `try { writeSafeRunJson(process.env.RUN, join(process.env.RUN, "tournament", "candidates", "x.json"), { ok: true }); console.log("WROTE") }`,
    `catch (err) { console.log("REFUSED:" + (err.reason || "") + ":" + String(err.message)) }`,
  ].join("\n")
  const res = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, RUN: run },
  })
  assert.strictEqual(res.status, 0, `child failed: ${res.stderr}`)
  assert(/REFUSED:containment-mode:/.test(res.stdout), `the write must be refused by name: ${res.stdout}`)
  assert(res.stdout.includes(basename(run)), "the refusal must name the run id")
  assert.strictEqual(existsSync(join(run, "tournament", "candidates", "x.json")), false)
})

check("policy: a case-varied run path resolves to the same assertion", () => {
  const { run } = makeFixture()
  setRunRequirePinnedWrites(run, true)
  setFdTraversalModeForTest("detective")
  try {
    const variant = run.replace(/[a-z]/g, (c) => c.toUpperCase())
    if (variant === run || !existsSync(variant)) {
      console.log("RECORD: case-varied run path is not resolvable on this case-sensitive volume")
      return
    }
    assert.throws(
      () => assertPinnedWritePolicy(variant),
      (err) => err?.reason === "containment-mode",
      "a case-varied spelling of the same run must inherit the policy",
    )
  } finally {
    setFdTraversalModeForTest(null)
    setRunRequirePinnedWrites(run, false)
  }
})

await checkAsync("policy: the lock-layer refusal carries reason containment-mode and the run id", async () => {
  const { run } = makeFixture()
  setRunRequirePinnedWrites(run, true)
  setFdTraversalModeForTest("detective")
  try {
    await assert.rejects(
      withPinnedCrossProcessLock(run, "state.json", () => "never"),
      (err) => err?.reason === "containment-mode" && String(err.message).includes(basename(run)),
      "the lock refusal must be the shared containment-mode error",
    )
  } finally {
    setFdTraversalModeForTest(null)
    setRunRequirePinnedWrites(run, false)
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
  if (!makeTestLink(victim, join(run, "pitfalls.md"), "file")) return
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
    // The per-run detective_mode diagnostic is itself an audit event in
    // events.jsonl, so compare the last non-anomaly line.
    const eventLog = readFileSync(join(outside, "stolen-append.jsonl"), "utf8").trim().split("\n")
    assert.strictEqual(eventLog[eventLog.length - 1], JSON.stringify({ ok: 1 }), "the append line must be the last line")
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
    const lines = readFileSync(join(run, "events.jsonl"), "utf8").trim().split("\n")
    assert.strictEqual(lines[lines.length - 1], JSON.stringify({ branch: "unsupported" }))
  } finally {
    setFdContainmentModeForTest(null)
    setFdTraversalModeForTest(null)
  }
})

check("detective createDir: a post-create swap outside the run is refused and audited", () => {
  const { run, outside } = makeFixture()
  if (!makeTestLink(outside, join(run, "sub.swap"), "dir")) return
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        createDirWithin(run, "sub", {
          afterCreate: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            renameSync(join(run, "sub.swap"), join(run, "sub"))
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
  if (!makeTestLink(outside, join(run, "sub.swap"), "dir")) return
  setFdTraversalModeForTest("detective")
  try {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        unlinkWithin(run, "sub/gone.txt", {
          afterUnlink: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            renameSync(join(run, "sub.swap"), join(run, "sub"))
          },
        }),
      (err) => /post-unlink|containment|identity|refused/i.test(String(err.message)),
    )
    assert(
      recentWriteAnomalies()
        .slice(before)
        .some((a) => a.kind === "detective-unlink" || a.kind === "detective-identity-changed"),
      "the post-unlink swap must record an anomaly",
    )
    assert.strictEqual(unlinkWithin(run, "never-created/gone.txt"), false, "a missing file is a no-op delete")
    assert.strictEqual(existsSync(join(run, "never-created")), false, "a delete must not create parent directories")
  } finally {
    setFdTraversalModeForTest(null)
  }
})

// ------------------------------------- 13b. ancestor identity pin (ADR 0013)

function withDetectiveMode(fn) {
  if (PINNED) setFdTraversalModeForTest("detective")
  try {
    return fn()
  } finally {
    if (PINNED) setFdTraversalModeForTest(null)
  }
}

function makeTestLink(target, path, kind = "file") {
  try {
    symlinkSync(target, path, process.platform === "win32" ? (kind === "dir" ? "junction" : "file") : kind)
    return true
  } catch (err) {
    console.log(`SKIP: symlink fixture unsupported on this runner (${err?.code || err?.message}); recorded`)
    return false
  }
}

check("detective identity pin: an ancestor swap after the pin refuses with identity-changed", () => {
  const { run, outside } = makeFixture()
  mkdirSync(join(run, "sub"), { recursive: true })
  if (!makeTestLink(outside, join(run, "sub.swap"), "dir")) return
  withDetectiveMode(() => {
    const before = recentWriteAnomalies().length
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "sub/report.json", "NOPE", {
          afterTarget: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            renameSync(join(run, "sub.swap"), join(run, "sub"))
          },
        }),
      (err) => err.reason === "identity-changed" && /pre-create|identity/i.test(String(err.message)),
    )
    assert.strictEqual(existsSync(join(outside, "report.json")), false, "the swapped ancestor must receive nothing")
    assert(
      recentWriteAnomalies()
        .slice(before)
        .some((a) => a.kind === "detective-identity-changed"),
      "the ancestor mismatch must be audited",
    )
  })
})

check("detective identity pin: a symlinked ancestor above the run still pins the real subdirectory", () => {
  // macOS /var -> /private/var and Windows 8.3 short names make the lexical run
  // path differ from its realpath. The ancestor chain must be re-rooted at the
  // real path, or a swapped subdirectory would not be detected.
  const base = mkdtempSync(join(testDir, "symroot-"))
  const real = join(base, "real")
  const outside = join(base, "outside")
  mkdirSync(real, { recursive: true })
  mkdirSync(outside, { recursive: true })
  if (!makeTestLink(real, join(base, "link"), "dir")) return
  const run = join(base, "link", "run")
  mkdirSync(join(run, "sub"), { recursive: true })
  if (!makeTestLink(outside, join(run, "sub.swap"), "dir")) return
  withDetectiveMode(() => {
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "sub/report.json", "NOPE", {
          afterTarget: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            renameSync(join(run, "sub.swap"), join(run, "sub"))
          },
        }),
      (err) => err.reason === "identity-changed",
    )
    assert.strictEqual(existsSync(join(outside, "report.json")), false)
  })
})

check("detective identity pin: an ancestor swapped after the temp create refuses before the rename", () => {
  const { run, outside } = makeFixture()
  mkdirSync(join(run, "sub"), { recursive: true })
  if (!makeTestLink(outside, join(run, "sub.swap"), "dir")) return
  withDetectiveMode(() => {
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "sub/report.json", "NOPE", {
          afterTemp: () => {
            renameSync(join(run, "sub"), join(run, "sub.real"))
            renameSync(join(run, "sub.swap"), join(run, "sub"))
          },
        }),
      (err) => err.reason === "identity-changed" && /pre-rename/i.test(String(err.message)),
    )
    assert.strictEqual(existsSync(join(outside, "report.json")), false)
  })
})

check("detective identity pin: a legitimately renamed run root refuses (fail closed)", () => {
  const { root, run, outside } = makeFixture()
  withDetectiveMode(() => {
    assert.throws(
      () =>
        writeFileAtomicWithin(run, "verify/report.json", "NOPE", {
          afterRename: () => renameSync(run, join(root, "run.moved")),
        }),
      (err) => err.reason === "identity-changed",
    )
    assert.strictEqual(existsSync(join(outside, "report.json")), false)
  })
})

check("detective identity pin: appending through a renamed run root refuses in the post-check", () => {
  if (process.platform === "win32") {
    console.log(
      "SKIP: win32 does not permit renaming a directory while an open append descriptor is inside it; the post-append identity mismatch case covers the check",
    )
    return
  }
  const { root, run } = makeFixture()
  withDetectiveMode(() => {
    assert.throws(
      () =>
        appendLineWithin(run, "events.jsonl", () => JSON.stringify({ ok: 1 }) + "\n", {
          afterAppend: () => renameSync(run, join(root, "run.moved")),
        }),
      (err) => err.reason === "identity-changed" && /post-append/i.test(String(err.message)),
    )
  })
})

check("detective identity pin: the darwin run-root fd check is consulted when enabled", () => {
  const { root, run } = makeFixture()
  setDarwinRootFdCheckForTest(true)
  try {
    withDetectiveMode(() => {
      writeFileAtomicWithin(run, "fd-ok.txt", "OK")
      assert.strictEqual(readFileSync(join(run, "fd-ok.txt"), "utf8"), "OK")
      assert.throws(
        () =>
          writeFileAtomicWithin(run, "fd-bad.txt", "NOPE", {
            afterTarget: () => renameSync(run, join(root, "run.moved")),
          }),
        (err) => err.reason === "identity-changed",
      )
    })
  } finally {
    setDarwinRootFdCheckForTest(false)
  }
})

check("containment-mode policy: REQUIRE_PINNED_WRITES=1 refuses control-plane writes in detective mode", () => {
  const { run } = makeFixture()
  const envKey = "OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES"
  const previous = process.env[envKey]
  process.env[envKey] = "1"
  try {
    withDetectiveMode(() => {
      for (const rel of ["run.manifest.json", "state.json", "costs.json", "verify/final.json"]) {
        assert.throws(
          () => writeFileAtomicWithin(run, rel, "{}\n"),
          (err) => err.reason === "containment-mode" && /detective/.test(String(err.message)),
          `${rel} must be refused by the policy`,
        )
        assert.strictEqual(existsSync(join(run, rel)), false, `${rel} must not be written`)
      }
      assert.throws(
        () => createDirWithin(run, "newdir"),
        (err) => err.reason === "containment-mode",
      )
      assert.throws(
        () => appendLineWithin(run, "events.jsonl", () => "{}\n"),
        (err) => err.reason === "containment-mode",
      )
    })
  } finally {
    if (previous === undefined) delete process.env[envKey]
    else process.env[envKey] = previous
  }
})

check("containment-mode policy: default off keeps detective writes working", () => {
  const { run } = makeFixture()
  withDetectiveMode(() => {
    writeFileAtomicWithin(run, "a.txt", "A")
    writeFileAtomicWithin(run, "verify/b.json", "{}")
    assert.strictEqual(readFileSync(join(run, "a.txt"), "utf8"), "A")
  })
})

check("containment-mode policy: a per-run plan assertion refuses only that run", () => {
  const first = makeFixture()
  const second = makeFixture()
  setRunRequirePinnedWrites(first.run, true)
  try {
    withDetectiveMode(() => {
      assert.throws(
        () => writeFileAtomicWithin(first.run, "state.json", "{}"),
        (err) => err.reason === "containment-mode",
      )
      writeFileAtomicWithin(second.run, "state.json", "{}")
      assert.strictEqual(readFileSync(join(second.run, "state.json"), "utf8"), "{}")
    })
  } finally {
    setRunRequirePinnedWrites(first.run, false)
  }
})

check("containment-mode policy: pinned mode satisfies the assertion", () => {
  if (!PINNED) {
    console.log("SKIP: pinned mode is unavailable on this host — policy success path not asserted")
    return
  }
  const { run } = makeFixture()
  const envKey = "OPENCODE_TEAMWORK_REQUIRE_PINNED_WRITES"
  const previous = process.env[envKey]
  process.env[envKey] = "1"
  try {
    writeFileAtomicWithin(run, "state.json", "{}\n")
    assert.strictEqual(readFileSync(join(run, "state.json"), "utf8"), "{}\n")
  } finally {
    if (previous === undefined) delete process.env[envKey]
    else process.env[envKey] = previous
  }
})

check("containment-mode diagnostic: detective_mode is recorded once per run, not per write", () => {
  const { run } = makeFixture()
  withDetectiveMode(() => {
    const before = recentWriteAnomalies().length
    writeFileAtomicWithin(run, "one.txt", "1")
    writeFileAtomicWithin(run, "two.txt", "2")
    writeFileAtomicWithin(run, "three.txt", "3")
    const modes = recentWriteAnomalies()
      .slice(before)
      .filter((a) => a.kind === "detective_mode" && a.run === run)
    assert.strictEqual(modes.length, 1, `expected exactly one detective_mode diagnostic, got ${modes.length}`)
    assert.strictEqual(modes[0].mode, "detective")
  })
})

check("run-root identity: a signed manifest pins the root and a renamed/replaced root fails closed", () => {
  const { root, run } = makeFixture()
  const st = lstatSync(run)
  writeFileSync(
    join(run, "run.manifest.json"),
    JSON.stringify({ version: 3, runRootIdentity: { dev: st.dev, ino: st.ino } }) + "\n",
  )
  assert.doesNotThrow(() => assertRunRootIdentity(run), "the matching root must pass")
  renameSync(run, join(root, "run.moved"))
  mkdirSync(run)
  assert.throws(
    () => assertRunRootIdentity(run),
    (err) => err.reason === "identity-changed" && /run\.manifest|identity/i.test(String(err.message)),
    "a replaced root must refuse the control-plane write",
  )
})

check("run-root identity: a legacy manifest without the field is a no-op", () => {
  const { run } = makeFixture()
  writeFileSync(join(run, "run.manifest.json"), JSON.stringify({ version: 3 }) + "\n")
  assert.doesNotThrow(() => assertRunRootIdentity(run))
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

// ------------------------------------------- 13c. platform-native parity cases

function writeThroughRunCaseVariant(label) {
  const { root, run } = makeFixture()
  const variant = join(root, basename(run).toUpperCase())
  let caseInsensitive = false
  try {
    // Compare case-insensitively: some platforms canonicalise the on-disk case
    // in realpath, others echo the caller's spelling.
    caseInsensitive =
      existsSync(variant) && realpathSync(variant).toLowerCase() === realpathSync(run).toLowerCase()
  } catch {}
  if (!caseInsensitive) {
    console.log(`SKIP: ${label} — this runner's filesystem is case-sensitive; recorded`)
    return
  }
  writeFileAtomicWithin(variant, "case-variant.txt", "CASE\n")
  assert.strictEqual(readFileSync(join(run, "case-variant.txt"), "utf8"), "CASE\n")
}

if (process.platform === "darwin") {
  check("darwin: a case-insensitive run spelling still writes through the real run", () => {
    writeThroughRunCaseVariant("case-insensitive run spelling")
  })

  check("darwin: /tmp (symlink to /private/tmp) as the fixture root writes through the realpath", () => {
    let tmpSymlinked = false
    try {
      tmpSymlinked = lstatSync("/tmp").isSymbolicLink()
    } catch {}
    console.log(
      tmpSymlinked
        ? "RECORD: /tmp is a symlink to /private/tmp; exercising the symlinked-root realpath"
        : "RECORD: /tmp is not a symlink on this runner; the fixture still exercises a temp root",
    )
    const base = mkdtempSync(join("/tmp", "teamwork-safe-fs-tmp-"))
    const run = join(base, "run")
    mkdirSync(run, { recursive: true })
    try {
      writeFileAtomicWithin(run, "verify/report.json", "TMP\n")
      assert.strictEqual(readFileSync(join(run, "verify", "report.json"), "utf8"), "TMP\n")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  check("darwin: append through a final symlink is refused and the victim is untouched", () => {
    const { run, outside } = makeFixture()
    const victim = join(outside, "victim.md")
    writeFileSync(victim, "ORIGINAL\n")
    if (!makeTestLink(victim, join(run, "pitfalls.md"), "file")) return
    assert.throws(() => appendLineWithin(run, "pitfalls.md", () => "{}\n"), /refused|symlink/i)
    assert.strictEqual(readFileSync(victim, "utf8"), "ORIGINAL\n")
  })

  check("darwin: the run root reports non-zero dev/ino", () => {
    const { run } = makeFixture()
    const runStat = lstatSync(run)
    assert.notStrictEqual(runStat.dev, 0, "run root dev must be reported")
    assert.notStrictEqual(runStat.ino, 0, "run root ino must be reported")
    writeFileAtomicWithin(run, "identity.json", "{}\n")
    const fileStat = lstatSync(join(run, "identity.json"))
    assert.notStrictEqual(fileStat.dev, 0)
    assert.notStrictEqual(fileStat.ino, 0)
  })
} else if (process.platform === "win32") {
  check("win32: a junction to an outside directory is refused by the writer", () => {
    const { run, outside } = makeFixture()
    if (!makeTestLink(outside, join(run, "verify"), "dir")) return
    assert.throws(() => writeFileAtomicWithin(run, "verify/x.json", "NO"), /refused/)
    assert.strictEqual(existsSync(join(outside, "x.json")), false)
  })

  check("win32: '.. ', CON, and ADS segments are refused by the lexical policy", () => {
    const { run } = makeFixture()
    for (const bad of [".. ", "CON", "LPT1.txt", "file.txt:stream", "trailing."]) {
      assert.throws(() => assertSingleSegment(bad), /invalid single path segment|refused/i, `"${bad}" must be refused`)
    }
    assert.throws(() => writeFileAtomicWithin(run, "CON", "NO"), /invalid single path segment|refused/i)
    assert.strictEqual(existsSync(join(run, "CON")), false)
  })

  check("win32: a case-varied run path still writes", () => {
    writeThroughRunCaseVariant("case-varied run path")
  })

  check("win32: the run root reports non-zero dev/ino", () => {
    const { run } = makeFixture()
    const runStat = lstatSync(run)
    assert.notStrictEqual(runStat.dev, 0, "run root dev must be reported")
    assert.notStrictEqual(runStat.ino, 0, "run root ino must be reported")
    writeFileAtomicWithin(run, "identity.json", "{}\n")
    const fileStat = lstatSync(join(run, "identity.json"))
    assert.notStrictEqual(fileStat.dev, 0)
    assert.notStrictEqual(fileStat.ino, 0)
  })
} else {
  console.log("SKIP: platform-native darwin/win32 containment cases are not applicable on linux (recorded)")
}

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

// ------------------------------------------------- 15. durable incident manifests (#42)

check("detective swap leaves one structured incident manifest outside the run and prunes to cap", () => {
  const { run } = makeFixture()
  const incidentDir = join(testDir, "incidents-42")
  const auditFile = join(testDir, "audit-42.jsonl")
  setWriteAnomalyAuditPathForTest(auditFile)
  setIncidentDirForTest(incidentDir)
  setMaxIncidentFilesForTest(3)
  setFdTraversalModeForTest("detective")
  try {
    // Force 4 detective-mode post-rename inode swaps; each must refuse and write
    // one structured manifest, then prune down to the cap of 3.
    for (let i = 0; i < 4; i++) {
      assert.throws(
        () =>
          writeFileAtomicWithin(run, `swap-${i}.json`, JSON.stringify({ n: i }), {
            afterRename: ({ destPath }) => {
              unlinkSync(destPath)
              writeFileSync(destPath, JSON.stringify({ n: -1 }))
            },
          }),
        (err) => err.reason === "identity",
      )
    }
    const files = readdirSync(incidentDir).filter((f) => f.endsWith(".json"))
    assert.strictEqual(files.length, 3, `incident dir must be pruned to cap 3, got ${files.length}`)
    const incidents = listContainmentIncidents(run, { incidentDir })
    assert.strictEqual(incidents.length, 3)
    const last = incidents[incidents.length - 1]
    assert.strictEqual(last.v, 1)
    assert.strictEqual(last.kind, "detective-identity")
    assert.strictEqual(last.mode, "detective")
    assert.strictEqual(last.platform, process.platform)
    assert.strictEqual(last.phase, "post-write")
    assert.strictEqual(last.run, run)
    assert.ok(typeof last.targetRealpathBefore === "string" && last.targetRealpathBefore.length > 0)
    assert.ok(typeof last.targetRealpathAfter === "string" && last.targetRealpathAfter.length > 0)
    assert.ok(last.pinnedIdentity && Number.isFinite(last.pinnedIdentity.ino))
    assert.ok(last.observedIdentity && Number.isFinite(last.observedIdentity.ino))
    assert.notStrictEqual(last.pinnedIdentity.ino, last.observedIdentity.ino)
    assert.match(String(last.intendedDigest), /^[0-9a-f]{64}$/)
    assert.ok(Number.isFinite(last.intendedBytes) && last.intendedBytes > 0)
    assert.ok(typeof last.tempName === "string" && last.tempName.endsWith(".tmp"))
    assert.strictEqual(last.rollbackAttempted, false)
    assert.match(String(last.note), /already happened/)
    // Unacknowledged anomalies block final_verify / surface needs-inspection.
    const pending = unacknowledgedWriteAnomalies(run, { auditPath: auditFile })
    assert.ok(pending.length >= 4)
  } finally {
    setFdTraversalModeForTest(null)
    setMaxIncidentFilesForTest(null)
    setIncidentDirForTest(null)
    setWriteAnomalyAuditPathForTest(null)
  }
})

rmSync(testDir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
