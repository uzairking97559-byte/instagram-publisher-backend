"use strict";

// Reel files are read from Postgres in small slices. Loading a whole 20 MB
// BYTEA in one query costs Postgres several times the file size in memory
// (detoasted value plus its hex text form), which exceeds a small instance
// when Meta fetches a video with HEAD and parallel range requests.
const MEDIA_CHUNK_BYTES = 1024 * 1024;

// Returns null to send the whole file, false when the range cannot be
// satisfied (416), or { start, end } with inclusive byte offsets. Only a
// single "bytes=" range is honoured; anything else is ignored, which HTTP
// allows, and the whole file is sent instead.
function parseByteRange(header, size) {
  if (typeof header !== "string" || !Number.isSafeInteger(size) || size < 1) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return false;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function waitForDrain(res) {
  if (res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
    res.once("drain", done);
    res.once("close", done);
  });
}

// Writes bytes start..end (inclusive) one slice at a time, respecting
// backpressure, and stops early if the client goes away.
async function streamChunks(res, { start, end, readChunk, chunkBytes = MEDIA_CHUNK_BYTES }) {
  let offset = start;
  while (offset <= end) {
    if (res.destroyed) return false;
    const length = Math.min(chunkBytes, end - offset + 1);
    const chunk = toBuffer(await readChunk(offset, length));
    // The client may have gone away during the read; its "close" event has then
    // already fired, so waiting for "drain" would never finish.
    if (res.destroyed) return false;
    if (!chunk || chunk.length !== length) throw new Error("media_chunk_unavailable");
    offset += length;
    if (!res.write(chunk)) await waitForDrain(res);
  }
  if (res.destroyed) return false;
  res.end();
  return true;
}

module.exports = { MEDIA_CHUNK_BYTES, parseByteRange, streamChunks, toBuffer };
