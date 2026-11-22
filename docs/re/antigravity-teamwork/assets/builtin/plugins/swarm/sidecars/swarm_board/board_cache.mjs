/**
 * Incremental file readers and derived-board cache for the Swarm Board sidecar.
 *
 * Keeps board.jsonl and transcript.jsonl reads O(delta) across polls via
 * byte-offset tailing verified by inode, head, and tail anchors. Large
 * transcripts (> 256 KB) cold-start with an expanding EOF tail-read whenever
 * the newest step carries a numeric `step_index`, avoiding multi-gigabyte
 * full-file reads on startup. Derived board state (processed messages,
 * @mention edges, per-member post stats, channels, and screenshot frames) is
 * cached across transcript-only ticks and incrementally appended on
 * single-channel boards.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { channelOf, channelRegistry, controlOf, MAIN, mentionsOf } from './channels.mjs';

const ANCHOR_CHECK_BYTES = 64;
const TRANSCRIPT_TAIL_LINES = 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_TAIL_BYTES = 2 * 1024 * 1024;

let nextEpoch = 0;

export function statOf(path) {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size, ino: s.ino };
  } catch {
    return { mtime: 0, size: -1, ino: 0 };
  }
}

// Mirrors board.parse: skip blank and unparseable lines.
function parseBoard(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object') out.push(m);
    } catch {
      // A torn final line is picked up on the next read.
    }
  }
  return out;
}

function readExact(fd, length, position) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buf, total, length - total, position + total);
    if (n <= 0) return null;
    total += n;
  }
  return buf;
}

function nextTailAnchor(prevAnchor, slice, completeLen) {
  if (completeLen >= ANCHOR_CHECK_BYTES) {
    return Buffer.from(slice.subarray(completeLen - ANCHOR_CHECK_BYTES, completeLen));
  }
  const keep = Buffer.concat([prevAnchor, slice.subarray(0, completeLen)]);
  return Buffer.from(keep.subarray(Math.max(0, keep.length - ANCHOR_CHECK_BYTES)));
}

function nextHeadAnchor(prevHead, slice, completeLen) {
  if (prevHead.length >= ANCHOR_CHECK_BYTES || completeLen <= 0) return prevHead;
  const keep = Buffer.concat([prevHead, slice.subarray(0, completeLen)]);
  return Buffer.from(keep.subarray(0, Math.min(ANCHOR_CHECK_BYTES, keep.length)));
}

// Verifies inode, head anchor, tail anchor, and any previously seen un-newlined
// remainder before reading appended bytes past hit.readOffset. Returns null if
// the file was truncated, replaced, or rewritten so the caller falls back to a
// full read.
function readAppendedTail(path, hit) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const fs = fstatSync(fd);
    if (fs.ino !== hit.ino || fs.size < hit.size || hit.readOffset > fs.size) return null;
    if (hit.headAnchor.length > 0) {
      const head = readExact(fd, hit.headAnchor.length, 0);
      if (!head || !head.equals(hit.headAnchor)) return null;
    }
    if (hit.anchor.length > 0) {
      const tail = readExact(fd, hit.anchor.length, hit.readOffset - hit.anchor.length);
      if (!tail || !tail.equals(hit.anchor)) return null;
    }
    const slice = readExact(fd, fs.size - hit.readOffset, hit.readOffset);
    if (!slice) return null;
    // Detect in-place mutation of an un-newlined trailing line.
    if (hit.rem.length > 0 && (slice.length < hit.rem.length || !slice.subarray(0, hit.rem.length).equals(hit.rem))) {
      return null;
    }
    const lastNl = slice.lastIndexOf(0x0a);
    let readOffset = hit.readOffset;
    let anchor = hit.anchor;
    let headAnchor = hit.headAnchor;
    let completeBuf = null;
    if (lastNl >= 0) {
      const completeLen = lastNl + 1;
      completeBuf = slice.subarray(0, completeLen);
      readOffset = hit.readOffset + completeLen;
      anchor = nextTailAnchor(hit.anchor, slice, completeLen);
      headAnchor = nextHeadAnchor(hit.headAnchor, slice, completeLen);
    }
    const remBuf = Buffer.from(slice.subarray(lastNl + 1));
    return { size: fs.size, mtime: fs.mtimeMs, ino: fs.ino, readOffset, anchor, headAnchor, completeBuf, remBuf };
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

// Decodes each non-empty line directly from `buf` so cached tail lines are
// standalone strings rather than V8 SlicedStrings pinning a full-file string.
function nonEmptyLines(buf) {
  const out = [];
  for (let pos = 0; pos < buf.length;) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl < 0 ? buf.length : nl;
    if (end > pos) {
      const line = buf.toString('utf-8', pos, end);
      if (line.trim()) out.push(line);
    }
    pos = end + 1;
  }
  return out;
}

function touchCache(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function putCache(cache, key, entry, limit) {
  touchCache(cache, key, entry);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return entry;
}

function probeFile(cache, path, maxAppendBytes = Infinity) {
  const s = statOf(path);
  if (s.size < 0) {
    cache.delete(path);
    return { status: 'missing', s };
  }
  const hit = cache.get(path);
  if (hit && hit.size === s.size && hit.mtime === s.mtime && hit.ino === s.ino) {
    return { status: 'hit', s, hit: touchCache(cache, path, hit) };
  }
  if (hit && hit.readOffset > 0 && s.size >= hit.size && s.ino === hit.ino && s.size - hit.readOffset <= maxAppendBytes) {
    const delta = readAppendedTail(path, hit);
    if (delta) return { status: 'append', s, hit, delta };
  }
  return { status: 'miss', s, hit };
}

function readFullFile(path) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const fs = fstatSync(fd);
    const buf = readExact(fd, fs.size, 0);
    if (!buf) return null;
    const lastNl = buf.lastIndexOf(0x0a);
    const readOffset = lastNl >= 0 ? lastNl + 1 : 0;
    return {
      size: fs.size, mtime: fs.mtimeMs, ino: fs.ino, readOffset,
      anchor: Buffer.from(buf.subarray(Math.max(0, readOffset - ANCHOR_CHECK_BYTES), readOffset)),
      headAnchor: Buffer.from(buf.subarray(0, Math.min(ANCHOR_CHECK_BYTES, readOffset))),
      completeBuf: lastNl >= 0 ? buf.subarray(0, lastNl + 1) : null,
      remBuf: Buffer.from(buf.subarray(lastNl + 1)),
    };
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

const boardFileCache = new Map(); // path -> cached board state

// Reads and parses an append-only board.jsonl incrementally from the last
// newline offset, falling back to a full read (and bumping `epoch`) if the
// file shrank, changed inode, or its anchor/prefix bytes changed.
export function readBoardCached(path) {
  const p = probeFile(boardFileCache, path);
  if (p.status === 'missing') return { msgs: [], epoch: 0, ...p.s };
  if (p.status === 'hit') return { msgs: p.hit.msgs, epoch: p.hit.epoch, ...p.s };
  const isAppend = p.status === 'append';
  const chunk = isAppend ? p.delta : readFullFile(path);
  if (!chunk) {
    boardFileCache.delete(path);
    return { msgs: [], epoch: 0, ...p.s };
  }
  const added = chunk.completeBuf ? parseBoard(chunk.completeBuf.toString('utf-8')) : [];
  const base = isAppend ? p.hit.completeMsgs : [];
  const completeMsgs = added.length ? base.concat(added) : base;
  const remMsgs = chunk.remBuf.length ? parseBoard(chunk.remBuf.toString('utf-8')) : [];
  const msgs = remMsgs.length ? completeMsgs.concat(remMsgs) : completeMsgs;
  // Bump epoch if a previously parsed un-newlined trailing line was completed or extended.
  const epoch = isAppend && p.hit.msgs.length === p.hit.completeMsgs.length ? p.hit.epoch : ++nextEpoch;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = chunk;
  putCache(boardFileCache, path, { size, mtime, ino, readOffset, anchor, headAnchor, rem, completeMsgs, msgs, epoch }, 256);
  return { msgs, epoch, mtime, size, ino };
}

// Extracts total complete-line step count from the newest parseable step in
// `lines` if it carries a finite non-negative `step_index`. Returns
// `{ok: false, missingIndex: true}` when a parseable step lacks `step_index`
// (or its index is smaller than the tail window), signaling callers to skip
// further window doubling and fall back to a full read immediately.
function inferStepCountFromTail(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!step || typeof step !== 'object') continue;
    if (!Number.isFinite(step.step_index) || step.step_index < 0) {
      return { ok: false, missingIndex: true };
    }
    const inferred = Math.floor(step.step_index) + 1 + (lines.length - 1 - i);
    if (inferred < lines.length) return { ok: false, missingIndex: true };
    return { ok: true, count: inferred };
  }
  return { ok: false, missingIndex: false };
}

// Cold-start EOF tail-read for large transcripts (> TRANSCRIPT_TAIL_BYTES).
// Doubles the trailing window up to TRANSCRIPT_MAX_TAIL_BYTES if the newest
// turn boundary is not yet inside the window. Returns null whenever step_index
// is absent or the window is exhausted so the caller falls back cleanly to a
// full readFileSync.
function readTranscriptTailFromEOF(path, summarizeLines) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const fs = fstatSync(fd);
    if (fs.size <= TRANSCRIPT_TAIL_BYTES) return null;
    for (let windowBytes = TRANSCRIPT_TAIL_BYTES; windowBytes < fs.size && windowBytes <= TRANSCRIPT_MAX_TAIL_BYTES; windowBytes *= 2) {
      const startPos = fs.size - windowBytes;
      const buf = readExact(fd, windowBytes, startPos);
      if (!buf) return null;
      const firstNl = buf.indexOf(0x0a);
      if (firstNl < 0) continue; // Single trailing line larger than windowBytes.
      const tailBuf = buf.subarray(firstNl + 1);
      const lastNl = tailBuf.lastIndexOf(0x0a);
      if (lastNl < 0) continue; // No complete line after discarded partial line.
      const completeBuf = tailBuf.subarray(0, lastNl + 1);
      const remBuf = tailBuf.subarray(lastNl + 1);
      const completeLines = nonEmptyLines(completeBuf);
      if (!completeLines.length) continue;
      const rem = remBuf.toString('utf-8');
      const hasRem = Boolean(rem.trim());
      const workLines = hasRem ? completeLines.concat([rem]) : completeLines;
      const inferred = inferStepCountFromTail(workLines);
      if (!inferred.ok) {
        if (inferred.missingIndex) return null;
        continue;
      }
      const totalLines = inferred.count;
      const completeCount = totalLines - (hasRem ? 1 : 0);
      const summary = summarizeLines(workLines, totalLines, fs.mtimeMs, true);
      if (!summary) continue;

      const readOffset = startPos + firstNl + 1 + lastNl + 1;
      const inBufEnd = firstNl + 1 + lastNl + 1;
      const anchor = inBufEnd >= ANCHOR_CHECK_BYTES
        ? Buffer.from(buf.subarray(inBufEnd - ANCHOR_CHECK_BYTES, inBufEnd))
        : readExact(fd, Math.min(ANCHOR_CHECK_BYTES, readOffset), Math.max(0, readOffset - ANCHOR_CHECK_BYTES));
      const headAnchor = readExact(fd, Math.min(ANCHOR_CHECK_BYTES, readOffset), 0);
      if (!anchor || !headAnchor) return null;
      return {
        key: `${fs.mtimeMs}:${fs.size}:${fs.ino}`, size: fs.size, mtime: fs.mtimeMs, ino: fs.ino,
        readOffset, anchor, headAnchor, rem: Buffer.from(remBuf), completeCount,
        tailLines: completeLines.slice(-TRANSCRIPT_TAIL_LINES), isPartial: true, summary,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

const transcriptCache = new Map(); // path -> entry
export const NO_TRANSCRIPT = { key: '-', summary: null };

function applyTranscriptAppend(path, hit, app, summarizeLines) {
  let { completeCount, tailLines, isPartial } = hit;
  if (app.completeBuf) {
    const added = nonEmptyLines(app.completeBuf);
    if (added.length) {
      completeCount += added.length;
      tailLines = tailLines.concat(added);
      if (tailLines.length > TRANSCRIPT_TAIL_LINES) {
        tailLines = tailLines.slice(-TRANSCRIPT_TAIL_LINES);
        isPartial = true;
      }
    }
  }
  const remText = app.remBuf.toString('utf-8');
  const hasRem = Boolean(remText.trim());
  const workLines = hasRem ? tailLines.concat([remText]) : tailLines;
  const summary = summarizeLines(workLines, completeCount + (hasRem ? 1 : 0), app.mtime, isPartial);
  if (!summary) return null;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = app;
  return putCache(transcriptCache, path, {
    key: `${mtime}:${size}:${ino}`, size, mtime, ino, readOffset, anchor, headAnchor, rem,
    completeCount, tailLines, isPartial, summary,
  }, 500);
}

// Incrementally reads and summarizes a member's transcript.jsonl:
//   1. Exact mtime+size+inode cache hit -> O(1)
//   2. Small append (<= TRANSCRIPT_TAIL_BYTES) past readOffset -> O(delta)
//   3. Cold start or large append (> TRANSCRIPT_TAIL_BYTES) -> EOF tail-read
//   4. Missing step_index on large append -> incremental append, else full read
export function readTranscriptCached(path, summarizeLines) {
  const p = probeFile(transcriptCache, path, TRANSCRIPT_TAIL_BYTES);
  if (p.status === 'missing') return NO_TRANSCRIPT;
  if (p.status === 'hit') return p.hit;
  if (p.status === 'append') {
    const updated = applyTranscriptAppend(path, p.hit, p.delta, summarizeLines);
    if (updated) return updated;
  }
  if (p.s.size > TRANSCRIPT_TAIL_BYTES) {
    const tailed = readTranscriptTailFromEOF(path, summarizeLines);
    if (tailed) return putCache(transcriptCache, path, tailed, 500);
  }
  if (p.status === 'miss' && p.hit?.readOffset > 0 && p.s.size >= p.hit.size &&
      p.s.ino === p.hit.ino && p.s.size - p.hit.readOffset > TRANSCRIPT_TAIL_BYTES) {
    const delta = readAppendedTail(path, p.hit);
    if (delta) {
      const updated = applyTranscriptAppend(path, p.hit, delta, summarizeLines);
      if (updated) return updated;
    }
  }
  const full = readFullFile(path);
  if (!full) {
    transcriptCache.delete(path);
    return NO_TRANSCRIPT;
  }
  const completeLines = full.completeBuf ? nonEmptyLines(full.completeBuf) : [];
  const remText = full.remBuf.toString('utf-8');
  const allLines = remText.trim() ? completeLines.concat([remText]) : completeLines;
  const summary = summarizeLines(allLines, allLines.length, full.mtime, false);
  const isPartial = completeLines.length > TRANSCRIPT_TAIL_LINES;
  const tailLines = isPartial ? completeLines.slice(-TRANSCRIPT_TAIL_LINES) : completeLines;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = full;
  return putCache(transcriptCache, path, {
    key: `${mtime}:${size}:${ino}`, size, mtime, ino, readOffset, anchor, headAnchor, rem,
    completeCount: completeLines.length, tailLines, isPartial, summary,
  }, 500);
}

function processMessageSlice(roster, names, msgs, startIdx, byChannel, posts, edges, { isRoleWorker, boardTimeMs }) {
  const out = [];
  for (let i = startIdx; i < msgs.length; i++) {
    const m = msgs[i];
    const seq = Number(m.seq) || 0;
    const agent = String(m.agent ?? '');
    const text = String(m.text ?? '');
    const time = m.time || '';
    const ts = boardTimeMs(time);
    const channel = channelOf(m);
    const control = controlOf(m);
    const chanFields = { ...(channel !== MAIN ? { channel } : {}), ...(control ? { control } : {}) };
    // A channel change is a system line, not a post: no mentions, no counts.
    if (control) {
      out.push({ seq, agent, text, time, ts, mentions: [], all: false, ...chanFields });
      continue;
    }
    const { mentions, all } = mentionsOf(text, names);
    // channel_mentions: the active channels it addresses; via_channel: the
    // members they call on that it does not name.
    const ch = byChannel ? byChannel(i, text) : null;
    const viaChannel = ch ? ch.members.filter((n) => n !== agent && !mentions.includes(n)) : [];
    const chanMentionFields = ch?.channels.length ? { channel_mentions: ch.channels, via_channel: viaChannel } : {};
    const p = posts.get(agent) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
    posts.set(agent, { posts: p.posts + 1, lastPostSeq: seq, lastPostTime: time, lastPostTs: ts });
    if (!isRoleWorker(agent, roster.members[agent])) {
      const direct = new Set([...mentions, ...viaChannel]);
      const targets = new Set(all ? names : mentions);
      for (const n of direct) targets.add(n);
      targets.delete(agent);
      for (const to of targets) {
        if (isRoleWorker(to, roster.members[to])) continue;
        const key = `${agent}\0${to}`;
        const e = edges.get(key) || { from: agent, to, count: 0, direct: 0, viaAll: 0 };
        e.count++;
        if (direct.has(to)) e.direct++;
        else e.viaAll++;
        edges.set(key, e);
      }
    }
    out.push({ seq, agent, text, time, ts, mentions, all, ...chanFields, ...chanMentionFields });
  }
  return out;
}

// Derived board state (processed messages, @mention edges, per-member post
// stats, channel registry, and posted screenshot frames), cached across polls
// where only member transcripts or read cursors changed, and updated
// incrementally on single-channel message appends.
const derivedBoardCache = new Map(); // cacheId -> entry
export function computeDerivedBoard(cacheId, boardKey, boardEpoch, roster, names, msgs, remote, helpers) {
  const { roleOf, isRoleWorker, boardTimeMs, channelAddressees, appendPostedFrames, maxPostedFrames } = helpers;
  const rosterKey = names.map((n) => {
    const m = roster.members[n];
    return `${n}\x1f${roleOf(n, m)}\x1f${isRoleWorker(n, m) ? 1 : 0}\x1f${Array.isArray(m.channels) ? JSON.stringify(m.channels) : ''}`;
  }).join('\x1e');
  const fullKey = `${boardKey}\0${boardEpoch}\0${rosterKey}`;
  const prev = derivedBoardCache.get(cacheId);
  if (prev && prev.fullKey === fullKey && prev.messages.length === msgs.length) {
    return touchCache(derivedBoardCache, cacheId, prev);
  }

  // Incremental append fast-path for single-channel boards with unchanged roster.
  const sameShape = prev && prev.boardEpoch === boardEpoch && prev.rosterKey === rosterKey;
  const tail = sameShape && !prev.channels.length && !remote?.channels?.length && msgs.length > prev.messages.length
    ? msgs.slice(prev.messages.length) : null;
  let channels, posts, edges, messages, frameMap;
  if (tail?.every((m) => channelOf(m) === MAIN && !controlOf(m) && !String(m.text ?? '').includes('@#'))) {
    channels = prev.channels;
    posts = new Map(prev.posts);
    edges = new Map();
    for (const [k, e] of prev.edges) edges.set(k, { ...e });
    messages = prev.messages.concat(processMessageSlice(roster, names, msgs, prev.messages.length, null, posts, edges, { isRoleWorker, boardTimeMs }));
    frameMap = new Map(prev.frameMap);
    appendPostedFrames?.(frameMap, roster, tail);
  } else {
    posts = new Map();
    edges = new Map(); // "from\0to" -> edge
    // Channels exist only once a member created one; until then every new
    // field below is left out, so a one-channel swarm's snapshot is unchanged.
    channels = remote?.channels || channelRegistry(msgs);
    // "@#channel" calls on the members whose set as of the message holds the
    // channel (or "*"), while it is active then (channels.mjs mentionsIn).
    const byChannel = channelAddressees(roster, names, msgs, channels);
    messages = processMessageSlice(roster, names, msgs, 0, byChannel, posts, edges, { isRoleWorker, boardTimeMs });
    frameMap = new Map();
    appendPostedFrames?.(frameMap, roster, msgs);
  }
  // Compact opaque token binding boardEpoch and exact roster shape.
  const rosterToken = sameShape ? prev.rosterToken : `${boardEpoch}:${createHash('sha256').update(rosterKey).digest('hex').slice(0, 32)}`;
  const entry = {
    fullKey, boardEpoch, rosterKey, rosterToken,
    channels, messages, posts, edges, edgeList: [...edges.values()],
    frameMap, posted: appendPostedFrames ? [...frameMap.values()].slice(-maxPostedFrames) : [],
  };
  return putCache(derivedBoardCache, cacheId, entry, 64);
}
