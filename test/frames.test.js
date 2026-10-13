"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { harness, json } = require("./helpers");

function mp4(marker = "clip") {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from(marker)]);
}
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("test-image-bytes")]);

async function uploadVideo(h, cookie, name, data) {
  const result = await h.requestRaw("/api/assets", { cookie, body: data, headers: {
    "content-type": "video/mp4", "x-file-name": name, "idempotency-key": crypto.randomUUID()
  } });
  return result.data.asset.asset_id;
}

// A stand-in for ffmpeg: writes a recognisable "framed" video, or fails.
function fakeRenderer() {
  const calls = [];
  const control = { fail: false, gate: null };
  const render = async (options) => {
    calls.push({ ...options, input: fs.readFileSync(options.inputPath) });
    if (control.gate) await control.gate;
    if (control.fail) throw Object.assign(new Error("frame_render_failed"), { detail: "test failure" });
    fs.writeFileSync(options.outputPath, mp4(`framed:${options.title}:${options.username}`));
  };
  return { render, calls, control };
}

function metaRecorder() {
  const videos = [];
  return { videos, run: (url, init) => {
    if (url.pathname.endsWith("/media")) {
      videos.push(new URLSearchParams(init.body).get("video_url"));
      return json({ id: String(88000 + videos.length) });
    }
    if (url.pathname.endsWith("/media_publish")) return json({ id: "99001" });
    return json({ status_code: "FINISHED" });
  } };
}

const jobRow = async (h, batchId, position = 1) =>
  (await h.db.query("SELECT status,frame_status,frame_title,frame_error,frame_attempts FROM publisher_jobs WHERE batch_id=$1 AND batch_position=$2", [batchId, position])).rows[0];

test("a framed Reel waits for its frame, then Meta gets the framed video with the account's username", async (t) => {
  const fake = fakeRenderer();
  let release;
  fake.control.gate = new Promise((resolve) => { release = resolve; });
  const meta = metaRecorder();
  const h = await harness(t, { meta: meta.run, frameOptions: { render: fake.render } });
  const cookie = await h.login(), id = await h.account("instagram", "12001", { username: "yzairr_" });
  const asset = await uploadVideo(h, cookie, "one.mp4", mp4("original"));
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "caption", interval_minutes: 15, asset_ids: [asset], frame: true, frame_title: "Kadwa sach..!!" } });
  assert.equal(created.status, 202);
  const batchId = created.data.batch.id;
  assert.equal(created.data.batch.jobs[0].frame_status, "pending");

  // While the frame renders, the scheduler must not start the Reel.
  for (let i = 0; i < 20 && !fake.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.calls.length, 1);
  await h.app.locals.runPublishingScheduler();
  assert.equal(meta.videos.length, 0, "nothing is sent to Meta before the frame is ready");
  assert.equal((await jobRow(h, batchId)).frame_status, "rendering");

  release();
  for (let i = 0; i < 50 && (await jobRow(h, batchId)).frame_status !== "done"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const done = await jobRow(h, batchId);
  assert.equal(done.frame_status, "done");
  assert.equal(done.frame_title, "Kadwa sach..!!");
  assert.deepEqual(fake.calls[0].input, mp4("original"));
  assert.equal(fake.calls[0].username, "yzairr_");
  assert.equal(fake.calls[0].boxPercent, 60);

  await h.app.locals.runPublishingScheduler();
  assert.equal(meta.videos.length, 1);
  assert.deepEqual(Buffer.from(await (await fetch(meta.videos[0])).arrayBuffer()), mp4("framed:Kadwa sach..!!:yzairr_"));
  const listed = (await h.request("/api/jobs", { cookie })).data.jobs[0];
  assert.equal(listed.frame_status, "done");
  assert.equal(listed.frame_title, "Kadwa sach..!!");
});

test("a frame that cannot be rendered is retried once, then the original video is posted", async (t) => {
  const fake = fakeRenderer();
  fake.control.fail = true;
  const meta = metaRecorder();
  const h = await harness(t, { meta: meta.run, frameOptions: { render: fake.render } });
  const cookie = await h.login(), id = await h.account("instagram", "12002");
  const asset = await uploadVideo(h, cookie, "one.mp4", mp4("original"));
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "caption", interval_minutes: 15, asset_ids: [asset], frame: true } });
  const batchId = created.data.batch.id;
  for (let i = 0; i < 50 && (await jobRow(h, batchId)).frame_status !== "failed"; i++) {
    await h.app.locals.runFrameWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const failed = await jobRow(h, batchId);
  assert.equal(failed.frame_status, "failed");
  assert.equal(failed.frame_error, "frame_render_failed");
  assert.equal(Number(failed.frame_attempts), 2);
  assert.equal(fake.calls.length, 2);
  await h.app.locals.runPublishingScheduler();
  assert.equal(meta.videos.length, 1);
  assert.deepEqual(Buffer.from(await (await fetch(meta.videos[0])).arrayBuffer()), mp4("original"));
});

test("an unframed batch is unchanged and a frame line needs the frame turned on", async (t) => {
  const fake = fakeRenderer();
  const meta = metaRecorder();
  const h = await harness(t, { meta: meta.run, frameOptions: { render: fake.render } });
  const cookie = await h.login(), id = await h.account("instagram", "12003");
  const asset = await uploadVideo(h, cookie, "one.mp4", mp4("plain"));
  const bad = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 15, asset_ids: [asset], frame_title: "line" } });
  assert.equal(bad.status, 400);
  const notBool = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 15, asset_ids: [asset], frame: "yes" } });
  assert.equal(notBool.status, 400);
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 15, asset_ids: [asset] } });
  assert.equal(created.data.batch.jobs[0].frame_status, null);
  for (let i = 0; i < 50 && !meta.videos.length; i++) { await h.app.locals.runPublishingScheduler(); await new Promise((r) => setTimeout(r, 10)); }
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(Buffer.from(await (await fetch(meta.videos[0])).arrayBuffer()), mp4("plain"));
});

test("frame settings: defaults per account, validation, pictures and lines", async (t) => {
  const fake = fakeRenderer();
  const h = await harness(t, { frameOptions: { render: fake.render, preview: async () => png } });
  const cookie = await h.login();
  const first = await h.account("instagram", "12004"), second = await h.account("instagram", "12005");
  const a = (await h.request(`/api/accounts/${first}/frame`, { cookie })).data.frame;
  const b = (await h.request(`/api/accounts/${second}/frame`, { cookie })).data.frame;
  assert.equal(a.frame_by_default, true);
  assert.equal(a.box_percent, 60);
  assert.equal(a.art_mode, "default");
  assert.notEqual(a.background_preset, b.background_preset, "two accounts get different colours");
  assert.ok(a.options.default_title_lines.length > 10);

  const put = (id, body) => h.request(`/api/accounts/${id}/frame`, { method: "PUT", cookie, body });
  assert.equal((await put(first, { box_percent: 63 })).status, 400);
  assert.equal((await put(first, { background_preset: "pink" })).status, 400);
  assert.equal((await put(first, { art_mode: "custom" })).data.error, "frame_art_missing");
  assert.equal((await put(first, { title_lines: "one" })).status, 400);
  const saved = (await put(first, { box_percent: 55, background_preset: "red", show_username: false, frame_by_default: false,
    title_lines: ["Pehli line 🥀", "  ", "Pehli line", "Doosri line"] })).data.frame;
  assert.equal(saved.box_percent, 55); assert.equal(saved.background_preset, "red");
  assert.equal(saved.show_username, false); assert.equal(saved.frame_by_default, false);
  assert.deepEqual(saved.title_lines, ["Pehli line", "Doosri line"]);

  const image = (kind, body, type = "image/png", method = "PUT") => h.requestRaw(`/api/accounts/${first}/frame/${kind}`, { method, cookie, body, headers: { "content-type": type } });
  assert.equal((await image("art", Buffer.from("<svg/>"), "image/png")).data.error, "invalid_frame_image");
  const withArt = (await image("art", png)).data.frame;
  assert.equal(withArt.custom_art, true); assert.equal(withArt.art_mode, "custom");
  assert.equal((await image("background", png)).data.frame.custom_background, true);
  const removed = (await h.requestRaw(`/api/accounts/${first}/frame/art`, { method: "DELETE", cookie })).data.frame;
  assert.equal(removed.custom_art, false); assert.equal(removed.art_mode, "default");
  assert.equal((await h.requestRaw(`/api/accounts/${first}/frame/art`, { method: "PUT", cookie, body: png, headers: { "content-type": "image/png" }, originHeader: "https://evil.example" })).status, 403);

  const preview = await h.requestRaw(`/api/accounts/${first}/frame/preview`, { method: "GET", cookie });
  assert.equal(preview.status, 200);
  assert.equal(preview.response.headers.get("content-type"), "image/png");
  assert.equal((await h.request(`/api/accounts/99999/frame`, { cookie })).status, 404);
  assert.equal((await h.request(`/api/accounts/${first}/frame`)).status, 401);
});

test("a framed Reel uses the account's saved look and lines", async (t) => {
  const fake = fakeRenderer();
  const meta = metaRecorder();
  const h = await harness(t, { meta: meta.run, frameOptions: { render: fake.render, random: () => 0 } });
  const cookie = await h.login(), id = await h.account("instagram", "12006", { username: "page_two" });
  await h.request(`/api/accounts/${id}/frame`, { method: "PUT", cookie, body: { box_percent: 70, background_preset: "blue", art_mode: "none",
    show_username: false, title_lines: ["Meri apni line"] } });
  await h.requestRaw(`/api/accounts/${id}/frame/background`, { method: "PUT", cookie, body: png, headers: { "content-type": "image/png" } });
  const asset = await uploadVideo(h, cookie, "one.mp4", mp4("original"));
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 15, asset_ids: [asset], frame: true } });
  for (let i = 0; i < 50 && (await jobRow(h, created.data.batch.id)).frame_status !== "done"; i++) {
    await h.app.locals.runFrameWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const call = fake.calls[0];
  assert.equal(call.title, "Meri apni line");
  assert.equal(call.username, "");
  assert.equal(call.boxPercent, 70);
  assert.equal(call.art, null);
  assert.match(call.backgroundPath, /background\.img$/, "the uploaded background is used");
});
