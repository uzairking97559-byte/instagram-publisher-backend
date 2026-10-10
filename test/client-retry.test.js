"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

function extractFunction(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end).trim();
}

function loadFunction(name, code, globals) {
  return vm.runInNewContext(`${code}\n${name};`, vm.createContext(globals));
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function testContext(fetch, delays = []) {
  const progress = { textContent: "" };
  return {
    progress,
    delays,
    globals: {
      fetch,
      AbortSignal: { timeout: () => ({}) },
      setTimeout(callback, delay) { delays.push(delay); callback(); return delay; },
      clearTimeout() {},
      timers: new Map(),
      $(selector) { assert.equal(selector, "publish-progress"); return progress; },
      requestKey: async () => "123e4567-e89b-42d3-a456-426614174000"
    }
  };
}

const apiCode = extractFunction("async function api(path, options = {}) {", "\nfunction renderAccounts() {");
const uploadCode = extractFunction("async function uploadAsset(file, attempt) {", "\nasync function boot() {");
const batchSummaryCode = extractFunction("function summarizeBatch(group, totalCount) {", "\nfunction renderJobs() {");

test("batch creation retries transient failures with the same idempotency key", async () => {
  const calls = [];
  let count = 0;
  const context = testContext(async (_path, options) => {
    calls.push(options);
    return ++count < 3 ? response(503, { error: "temporarily_unavailable" }) : response(202, { batch: { id: "batch-1" } });
  });
  const api = loadFunction("api", apiCode, context.globals);
  const result = await api("/api/batches", {
    method: "POST",
    headers: { "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000" },
    body: "{}"
  });

  assert.equal(result.batch.id, "batch-1");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.headers["Idempotency-Key"]), [
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000"
  ]);
  assert.deepEqual(context.delays, [1000, 2000]);
});

test("an uncertain single-post request is never automatically retried", async () => {
  let calls = 0;
  const context = testContext(async () => {
    calls++;
    return response(503, { error: "temporarily_unavailable" });
  });
  const api = loadFunction("api", apiCode, context.globals);
  await assert.rejects(api("/api/publish/reels", {
    method: "POST",
    headers: { "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000" },
    body: "{}"
  }), (error) => error.code === "temporarily_unavailable");
  assert.equal(calls, 1);
  assert.deepEqual(context.delays, []);
});

test("batch creation without a valid idempotency key is never retried", async () => {
  let calls = 0;
  const context = testContext(async () => {
    calls++;
    return response(503, { error: "temporarily_unavailable" });
  });
  const api = loadFunction("api", apiCode, context.globals);
  await assert.rejects(api("/api/batches", { method: "POST", body: "{}" }),
    (error) => error.code === "temporarily_unavailable");
  assert.equal(calls, 1);
  assert.deepEqual(context.delays, []);
});

test("asset upload waits for the database before retrying the same file", async () => {
  const uploads = [];
  const readinessChecks = [];
  const context = testContext(async (path, options) => {
    if (path === "/ready") {
      readinessChecks.push(options);
      return readinessChecks.length >= 2
        ? response(200, { ok: true })
        : response(503, { ok: false });
    }
    uploads.push(options);
    return uploads.length === 1
      ? response(503, { error: "temporarily_unavailable" })
      : response(201, { asset: { asset_id: "asset-1" } });
  });
  const uploadAsset = loadFunction("uploadAsset", uploadCode, context.globals);
  const file = { name: "reel.mp4", size: 1024, type: "video/mp4", lastModified: 1 };
  const asset = await uploadAsset(file, "batch-attempt");

  assert.equal(asset.asset_id, "asset-1");
  assert.equal(uploads.length, 2);
  assert.equal(readinessChecks.length, 2);
  assert.ok(uploads.every((call) => call.headers["Idempotency-Key"] === "123e4567-e89b-42d3-a456-426614174000"));
  assert.deepEqual(context.delays, [5000, 10000]);
});

test("asset upload stops after bounded database recovery wait without resending the video", async () => {
  let uploads = 0;
  let readinessChecks = 0;
  const context = testContext(async (path) => {
    if (path === "/ready") {
      readinessChecks++;
      return response(503, { ok: false });
    }
    uploads++;
    return response(503, { error: "temporarily_unavailable" });
  });
  const uploadAsset = loadFunction("uploadAsset", uploadCode, context.globals);
  const file = { name: "reel.mp4", size: 1024, type: "video/mp4", lastModified: 1 };

  await assert.rejects(uploadAsset(file, "batch-attempt"),
    (error) => error.code === "temporarily_unavailable");
  assert.equal(uploads, 1);
  assert.equal(readinessChecks, 31);
  assert.equal(context.delays.length, 31);
  assert.equal(context.delays.reduce((sum, delay) => sum + delay, 0), 305000);
});
test("batch history shows one posted reel and the remaining reels as pending", () => {
  const summarizeBatch = loadFunction("summarizeBatch", batchSummaryCode, {});
  const group = [
    { status: "published" },
    ...Array.from({ length: 11 }, () => ({ status: "queued" }))
  ];
  const counts = summarizeBatch(group, 12);

  assert.equal(counts.total, 12);
  assert.equal(counts.published, 1);
  assert.equal(counts.pending, 11);
  assert.equal(counts.processing, 0);
  assert.equal(counts.failed, 0);
  assert.equal(counts.unknown, 0);
  assert.equal(counts.unlisted, 0);
});

test("batch progress keeps processing, failed, unknown, and missing statuses distinct", () => {
  const summarizeBatch = loadFunction("summarizeBatch", batchSummaryCode, {});
  const counts = summarizeBatch([
    { status: "published" }, { status: "creating" }, { status: "queued" },
    { status: "failed" }, { status: "unknown" }
  ], 6);

  assert.equal(counts.published, 1);
  assert.equal(counts.processing, 1);
  assert.equal(counts.pending, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.unknown, 1);
  assert.equal(counts.unlisted, 1);
});
