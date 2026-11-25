#!/usr/bin/env node
// Env-gated NFS / multi-host lock harness (Issue #41).
//
// Gated by TEAMWORK_NFS_TEST_DIR. When unset, exits 0 with a clear skip line.
// Emits one JSONL object per case:
//   {"case":"...","status":"pass"|"fail"|"inconclusive","durationMs":...,"detail":"..."}
// Never counts `inconclusive` as `pass`.

import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  crossProcessLockPath,
  observeLockArtifact,
  withCrossProcessLock,
} from "../plugins/opencode-teamwork/locks.ts"

const baseDir = process.env.TEAMWORK_NFS_TEST_DIR?.trim()
if (!baseDir) {
  console.log(
    JSON.stringify({
      case: "nfs_harness",
      status: "inconclusive",
      durationMs: 0,
      detail: "TEAMWORK_NFS_TEST_DIR is not set; skipping opt-in NFS/multi-host harness cleanly",
    }),
  )
  process.exit(0)
}

const workDir = mkdtempSync(join(resolve(baseDir), "teamwork-nfs-"))
const locksUrl = pathToFileURL(resolve(new URL("../plugins/opencode-teamwork/locks.ts", import.meta.url).pathname)).href
const results = []

async function runCase(name, fn) {
  const start = Date.now()
  try {
    const out = await fn()
    const status = out?.status || "pass"
    const rec = { case: name, status, durationMs: Date.now() - start, detail: out?.detail || "ok" }
    results.push(rec)
    console.log(JSON.stringify(rec))
  } catch (err) {
    const rec = { case: name, status: "fail", durationMs: Date.now() - start, detail: String(err?.message || err) }
    results.push(rec)
    console.log(JSON.stringify(rec))
  }
}

function runNodeScript(code, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }))
  })
}

try {
  // 1. Two-process claim race
  await runCase("two_process_claim_race", async () => {
    const target = join(workDir, "race-counter.json")
    writeFileSync(target, JSON.stringify({ count: 0 }))
    const script = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { withCrossProcessLock } from ${JSON.stringify(locksUrl)};
      for (let i = 0; i < 20; i++) {
        await withCrossProcessLock(${JSON.stringify(target)}, () => {
          const cur = JSON.parse(readFileSync(${JSON.stringify(target)}, "utf8"));
          cur.count += 1;
          writeFileSync(${JSON.stringify(target)}, JSON.stringify(cur));
        }, { timeoutMs: 10000, leaseMs: 5000 });
      }
    `
    const [a, b] = await Promise.all([runNodeScript(script), runNodeScript(script)])
    if (a.code !== 0 || b.code !== 0) {
      throw new Error(`child failed: a=${a.code} (${a.stderr}), b=${b.code} (${b.stderr})`)
    }
    const final = JSON.parse(readFileSync(target, "utf8"))
    if (final.count !== 40) throw new Error(`expected count=40, got ${final.count}`)
    return { status: "pass", detail: "40/40 increments preserved across two processes" }
  })

  // 2. kill -9 holder -> reclaimed after lease expires
  await runCase("kill_9_holder", async () => {
    const target = join(workDir, "kill9.json")
    const lockPath = crossProcessLockPath(target)
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { withCrossProcessLock } from ${JSON.stringify(locksUrl)};
          await withCrossProcessLock(${JSON.stringify(target)}, async () => {
            console.log("LOCKED");
            await new Promise((r) => setTimeout(r, 60000));
          }, { leaseMs: 1000, timeoutMs: 5000 });
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("holder did not acquire lock")), 5000)
      holder.stdout.on("data", (d) => {
        if (String(d).includes("LOCKED")) {
          clearTimeout(timer)
          resolveReady()
        }
      })
    })
    holder.kill("SIGKILL")
    await new Promise((r) => holder.on("close", r))
    // Backdate mtime past short lease so reclaim runs without sleeping 30s.
    const past = new Date(Date.now() - 5000)
    utimesSync(lockPath, past, past)
    let acquired = false
    await withCrossProcessLock(
      target,
      () => {
        acquired = true
      },
      { leaseMs: 500, timeoutMs: 3000 },
    )
    if (!acquired) throw new Error("failed to reclaim lock after SIGKILL holder")
    return { status: "pass", detail: "dead SIGKILL holder reclaimed after lease expiry" }
  })

  // 3. Foreign claim never reclaimed
  await runCase("foreign_claim_never_reclaimed", async () => {
    const target = join(workDir, "foreign.json")
    const lockPath = crossProcessLockPath(target)
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, host: "foreign-host.invalid", at: new Date(Date.now() - 120000).toISOString(), nonce: "foreign-1" }),
    )
    const past = new Date(Date.now() - 120000)
    utimesSync(lockPath, past, past)
    let reclaimed = false
    try {
      await withCrossProcessLock(
        target,
        () => {
          reclaimed = true
        },
        { leaseMs: 100, timeoutMs: 250 },
      )
    } catch {
      // Expected timeout refusal.
    }
    if (reclaimed) throw new Error("foreign-host lock was reclaimed!")
    const obs = observeLockArtifact(lockPath)
    if (!obs || obs.owner?.host !== "foreign-host.invalid") throw new Error("foreign-host lock artifact was modified")
    return { status: "pass", detail: "foreign-host lock refused and untouched" }
  })

  // 4. Quarantine election under concurrent reclaimers
  await runCase("quarantine_election", async () => {
    const target = join(workDir, "quarantine.json")
    const lockPath = crossProcessLockPath(target)
    const host = process.env.OPENCODE_TEAMWORK_TEST_HOST || (await import("node:os")).hostname()
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999998, host, at: new Date(Date.now() - 120000).toISOString(), nonce: "dead-1" }),
    )
    const past = new Date(Date.now() - 120000)
    utimesSync(lockPath, past, past)
    const script = `
      import { withCrossProcessLock } from ${JSON.stringify(locksUrl)};
      await withCrossProcessLock(${JSON.stringify(target)}, async () => {
        await new Promise((r) => setTimeout(r, 30));
      }, { leaseMs: 100, timeoutMs: 5000 });
    `
    const [a, b] = await Promise.all([runNodeScript(script), runNodeScript(script)])
    if (a.code !== 0 || b.code !== 0) throw new Error(`quarantine election failed: a=${a.code}, b=${b.code}`)
    return { status: "pass", detail: "concurrent reclaimers elected cleanly without lock loss" }
  })

  // 5. Grace blocks cleanup (dead pid within lease window)
  await runCase("grace_blocks_cleanup", async () => {
    const target = join(workDir, "grace.json")
    const lockPath = crossProcessLockPath(target)
    const host = process.env.OPENCODE_TEAMWORK_TEST_HOST || (await import("node:os")).hostname()
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999997, host, at: new Date().toISOString(), nonce: "fresh-dead" }),
    )
    let reclaimed = false
    try {
      await withCrossProcessLock(
        target,
        () => {
          reclaimed = true
        },
        { leaseMs: 10_000, timeoutMs: 250 },
      )
    } catch {
      // Expected timeout while within lease grace window.
    }
    if (reclaimed) throw new Error("dead-pid lock within lease grace window was reclaimed prematurely")
    return { status: "pass", detail: "lease grace window blocked premature reclaim" }
  })
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

const failed = results.filter((r) => r.status === "fail").length
const inconclusive = results.filter((r) => r.status === "inconclusive").length
if (failed > 0 || inconclusive > 0) process.exit(1)
