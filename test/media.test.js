"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Writable } = require("node:stream");
const test = require("node:test");
const { MEDIA_CHUNK_BYTES, parseByteRange, streamChunks, toBuffer } = require("../lib/media");

test("byte ranges: single ranges are honoured, odd ones ignored, impossible ones rejected", () => {
  assert.equal(parseByteRange(undefined, 100), null);
  assert.equal(parseByteRange("", 100), null);
  assert.deepEqual(parseByteRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange(" bytes=10- ", 100), { start: 10, end: 99 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { start: 90, end: 99 }, "end is clamped to the file");
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 }, "suffix range");
  assert.deepEqual(parseByteRange("bytes=-500", 100), { start: 0, end: 99 }, "long suffix is the whole file");
  assert.deepEqual(parseByteRange("bytes=99-99", 100), { start: 99, end: 99 });
  assert.equal(parseByteRange("bytes=100-", 100), false, "start past the end is unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 100), false);
  assert.equal(parseByteRange("bytes=9-0", 100), null, "reversed range is ignored");
  assert.equal(parseByteRange("bytes=0-1,5-6", 100), null, "multiple ranges are ignored");
  assert.equal(parseByteRange("items=0-1", 100), null);
  assert.equal(parseByteRange("bytes=-", 100), null);
  assert.equal(parseByteRange("bytes=0-1", 0), null, "empty file has no ranges");
});

function sink({ highWaterMark = 16 * 1024 } = {}) {
  const parts = [];
  const res = new Writable({ highWaterMark, write(chunk, _encoding, callback) { parts.push(Buffer.from(chunk)); setImmediate(callback); } });
  res.body = () => Buffer.concat(parts);
  return res;
}

function fileReader(file, reads) {
  return async (offset, length) => {
    reads.push({ offset, length });
    return new Uint8Array(file.subarray(offset, offset + length));
  };
}

test("whole file is streamed in fixed slices, never in one read", async () => {
  const file = crypto.randomBytes(2 * MEDIA_CHUNK_BYTES + 12345);
  const reads = [], res = sink();
  const finished = new Promise((resolve) => res.on("finish", resolve));
  assert.equal(await streamChunks(res, { start: 0, end: file.length - 1, readChunk: fileReader(file, reads) }), true);
  await finished;
  assert.deepEqual(res.body(), file);
  assert.deepEqual(reads.map((read) => read.length), [MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES, 12345]);
  assert.deepEqual(reads.map((read) => read.offset), [0, MEDIA_CHUNK_BYTES, 2 * MEDIA_CHUNK_BYTES]);
});

test("a range across a slice boundary returns exactly the requested bytes", async () => {
  const file = crypto.randomBytes(3000);
  const reads = [], res = sink({ highWaterMark: 16 });
  const finished = new Promise((resolve) => res.on("finish", resolve));
  await streamChunks(res, { start: 900, end: 2100, chunkBytes: 1000, readChunk: fileReader(file, reads) });
  await finished;
  assert.deepEqual(res.body(), file.subarray(900, 2101));
  assert.deepEqual(reads, [{ offset: 900, length: 1000 }, { offset: 1900, length: 201 }]);
});

test("streaming stops when the client disconnects and fails loudly on a missing slice", async () => {
  const file = crypto.randomBytes(5000);
  const reads = [], res = sink();
  const readChunk = async (offset, length) => {
    reads.push(offset);
    if (reads.length === 2) res.destroy();
    return file.subarray(offset, offset + length);
  };
  assert.equal(await streamChunks(res, { start: 0, end: 4999, chunkBytes: 1000, readChunk }), false);
  assert.ok(reads.length <= 3, "no further database reads after the client is gone");

  // The client leaves while a slow database read is in flight; "close" has
  // already fired by the time the slice arrives. This must not hang.
  const gone = sink({ highWaterMark: 1 });
  const slowRead = async (offset, length) => {
    gone.destroy();
    await new Promise((resolve) => gone.once("close", resolve));
    return file.subarray(offset, offset + length);
  };
  const outcome = await Promise.race([
    streamChunks(gone, { start: 0, end: 4999, chunkBytes: 1000, readChunk: slowRead }),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1000).unref())
  ]);
  assert.equal(outcome, false);

  await assert.rejects(streamChunks(sink(), { start: 0, end: 4999, chunkBytes: 1000, readChunk: async () => null }), /media_chunk_unavailable/);
  await assert.rejects(streamChunks(sink(), { start: 0, end: 4999, chunkBytes: 1000, readChunk: async () => Buffer.alloc(10) }), /media_chunk_unavailable/);
});

test("database values become Buffers without copying", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
  const converted = toBuffer(bytes);
  assert.equal(Buffer.isBuffer(converted), true);
  assert.deepEqual([...converted], [2, 3]);
  assert.equal(converted.buffer, bytes.buffer);
  assert.equal(toBuffer("not bytes"), null);
});
