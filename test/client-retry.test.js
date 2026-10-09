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

test("asset uploads survive a database restart window and reuse one upload key", async () => {
  const calls = [];
  let count = 0;
  const context = testContext(async (_path, options) => {
    calls.push(options);
    return ++count <= 10
      ? response(503, { error: "temporarily_unavailable" })
      : response(201, { asset: { asset_id: "asset-1" } });
  });
  const uploadAsset = loadFunction("uploadAsset", uploadCode, context.globals);
  const file = { name: "reel.mp4", size: 1024, type: "video/mp4", lastModified: 1 };
  const asset = await uploadAsset(file, "batch-attempt");

  assert.equal(asset.asset_id, "asset-1");
  assert.equal(calls.length, 11);
  assert.ok(calls.every((call) => call.headers["Idempotency-Key"] === "123e4567-e89b-42d3-a456-426614174000"));
  assert.deepEqual(context.delays, [1000, 2000, 4000, 8000, 12000, 15000, 15000, 15000, 15000, 15000]);
  assert.equal(context.delays.reduce((sum, delay) => sum + delay, 0), 102000);
});
