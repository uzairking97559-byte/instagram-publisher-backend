"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");
const { PART_BYTES, MAX_LARGE_MEDIA_BYTES } = require("../lib/publishing");

// A recognisable "video": an MP4 header followed by bytes that encode their offset.
function bigVideo(size) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = (i * 7 + (i >> 11)) & 0xff;
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom")]).copy(data, 0);
  return data;
}

async function sendParts(h, cookie, upload, data, skip = new Set()) {
  const count = Math.ceil(data.length / upload.part_bytes);
  for (let part = 0; part < count; part++) {
    if (skip.has(part)) continue;
    const result = await h.requestRaw(`/api/assets/uploads/${upload.asset_id}/parts/${part}`, { method: "PUT", cookie,
      body: data.subarray(part * upload.part_bytes, Math.min(data.length, (part + 1) * upload.part_bytes)),
      headers: { "content-type": "application/octet-stream" } });
    assert.equal(result.status, 200, result.text);
  }
}

test("a video over 50 MB's single-request limit arrives in parts, resumes, and is served by range across parts", async (t) => {
  const videos = [];
  const h = await harness(t, { meta: (url, init) => {
    if (url.pathname.endsWith("/media")) { videos.push(new URLSearchParams(init.body).get("video_url")); return json({ id: "88100" }); }
    if (url.pathname.endsWith("/media_publish")) return json({ id: "99100" });
    return json({ status_code: "FINISHED" });
  } });
  const cookie = await h.login(), id = await h.account("instagram", "13001");
  const data = bigVideo(PART_BYTES * 2 + 12345);
  const key = crypto.randomUUID();
  const start = (body = { file_name: "big.mp4", size: data.length }) =>
    h.request("/api/assets/uploads", { method: "POST", cookie, headers: { "idempotency-key": key }, body });
  const started = await start();
  assert.equal(started.status, 201);
  const upload = started.data.upload;
  assert.equal(upload.part_bytes, PART_BYTES);
  assert.deepEqual(upload.parts_received, []);

  // Part 1 is "lost"; completing now is refused and the batch cannot use it.
  await sendParts(h, cookie, upload, data, new Set([1]));
  const early = await h.request(`/api/assets/uploads/${upload.asset_id}/complete`, { method: "POST", cookie, body: {} });
  assert.equal(early.data.error, "upload_incomplete");
  const blocked = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 15, asset_ids: [upload.asset_id] } });
  assert.equal(blocked.data.error, "asset_unavailable");

  // Starting again with the same key resumes and lists what already arrived.
  const resumed = (await start()).data.upload;
  assert.equal(resumed.asset_id, upload.asset_id);
  assert.deepEqual(resumed.parts_received, [0, 2]);
  assert.equal((await start({ file_name: "other.mp4", size: data.length })).status, 409);
  const wrongSize = await h.requestRaw(`/api/assets/uploads/${upload.asset_id}/parts/1`, { method: "PUT", cookie, body: Buffer.alloc(10), headers: { "content-type": "application/octet-stream" } });
  assert.equal(wrongSize.data.error, "invalid_upload_part");
  await sendParts(h, cookie, upload, data, new Set([0, 2]));
  await sendParts(h, cookie, upload, data, new Set([0, 2])); // a retried part just replaces itself
  const done = await h.request(`/api/assets/uploads/${upload.asset_id}/complete`, { method: "POST", cookie, body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.data.asset.size_bytes, data.length);
  assert.equal((await h.request(`/api/assets/uploads/${upload.asset_id}/complete`, { method: "POST", cookie, body: {} })).status, 200);

  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 15, asset_ids: [upload.asset_id] } });
  assert.equal(created.status, 202);
  for (let i = 0; i < 50 && !videos.length; i++) { await h.app.locals.runPublishingScheduler(); await new Promise((r) => setTimeout(r, 10)); }
  const url = videos[0];
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), data);
  const from = PART_BYTES - 100, to = PART_BYTES + 99;
  const ranged = await fetch(url, { headers: { range: `bytes=${from}-${to}` } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), data.subarray(from, to + 1));
});

test("part uploads check size, storage and the video format", async (t) => {
  const h = await harness(t, { env: { MEDIA_STORAGE_LIMIT_MB: "10" } });
  const cookie = await h.login();
  const start = (body) => h.request("/api/assets/uploads", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() }, body });
  assert.equal((await start({ file_name: "huge.mp4", size: MAX_LARGE_MEDIA_BYTES + 1 })).data.error, "upload_too_large");
  assert.equal((await start({ file_name: "full.mp4", size: 11 * 1024 * 1024 })).data.error, "upload_storage_full");
  assert.equal((await start({ file_name: "bad.mp4", size: 0 })).status, 400);
  assert.equal((await h.request("/api/assets/uploads", { method: "POST", cookie, body: { file_name: "a.mp4", size: 10 } })).data.error, "idempotency_key_required");

  const notVideo = Buffer.from("this is not a video file at all");
  const upload = (await start({ file_name: "fake.mp4", size: notVideo.length })).data.upload;
  await sendParts(h, cookie, upload, notVideo);
  const done = await h.request(`/api/assets/uploads/${upload.asset_id}/complete`, { method: "POST", cookie, body: {} });
  assert.equal(done.data.error, "invalid_video_format");
  assert.equal((await h.db.query("SELECT 1 FROM publisher_media_assets WHERE id=$1", [upload.asset_id])).rows.length, 0, "the rejected upload is removed");
  assert.equal((await h.request("/api/assets/uploads", { method: "POST", body: { file_name: "a.mp4", size: 10 } })).status, 401);
});
