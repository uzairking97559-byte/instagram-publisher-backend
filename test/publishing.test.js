"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");
const { decryptToken } = require("../lib/security");

function mp4(marker = "clip") {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from(marker)]);
}

async function uploadVideo(h, cookie, name, data = mp4(), key = crypto.randomUUID()) {
  const result = await h.requestRaw("/api/assets", { cookie, body: data, headers: {
    "content-type": "video/mp4", "x-file-name": name, "idempotency-key": key
  } });
  return { ...result, key };
}

async function waitFor(predicate, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the batch worker");
}

function createRequest(h, cookie, connection_id, type = "image", key = crypto.randomUUID()) {
  return {
    key,
    body: { connection_id, caption: "Test caption", [type === "image" ? "image_url" : "video_url"]: "https://cdn.example/test-media" },
    send(body) { return h.request(`/api/publish/${type === "image" ? "image" : "reels"}`, { method: "POST", cookie, headers: { "idempotency-key": key }, body: body || this.body }); }
  };
}
const check = (h, cookie, id) => h.request(`/api/jobs/${id}/publish`, { method: "POST", body: {}, cookie });
const allowCheck = (h, id) => h.db.query("UPDATE publisher_jobs SET next_check_at=NOW()-INTERVAL '1 second' WHERE id=$1", [id]);

test("concurrent photo submissions create and publish once; replay returns the original receipt", async (t) => {
  let createCalls = 0, publishCalls = 0;
  const h = await harness(t, { meta: (url, init) => {
    assert.equal(url.searchParams.has("access_token"), false);
    assert.equal(init.headers.Authorization, "Bearer test-only-page-token");
    if (url.pathname.endsWith("/media")) { createCalls++; return json({ id: "88001" }); }
    if (url.pathname.endsWith("/media_publish")) { publishCalls++; return json({ id: "99001" }); }
    return json({ status_code: "FINISHED" });
  } });
  const cookie = await h.login(), id = await h.account();
  const request = createRequest(h, cookie, id);
  const submitted = await Promise.all(Array.from({ length: 5 }, () => request.send()));
  assert.ok(submitted.every((result) => result.status === 202));
  assert.equal(createCalls, 1);
  const jobId = submitted[0].data.job.id;
  assert.ok(submitted.every((result) => result.data.job.id === jobId));
  assert.equal((await request.send({ ...request.body, caption: "Changed" })).status, 409);
  await Promise.all(Array.from({ length: 5 }, () => check(h, cookie, jobId)));
  const replay = await request.send();
  assert.equal(replay.status, 200);
  assert.equal(replay.data.job.status, "published");
  assert.equal(replay.data.job.published_media_id, "99001");
  assert.equal(createCalls, 1); assert.equal(publishCalls, 1);
  assert.equal((await h.request("/api/jobs", { cookie })).data.jobs.length, 1);
});

test("reels wait for processing and database throttling prevents repeated status calls", async (t) => {
  let status = "IN_PROGRESS", checks = 0, published = 0;
  const h = await harness(t, { meta: (url, init) => {
    if (url.pathname.endsWith("/media")) { assert.equal(init.body.get("media_type"), "REELS"); return json({ id: "88002" }); }
    if (url.pathname.endsWith("/media_publish")) { published++; return json({ id: "99002" }); }
    checks++; return json({ status_code: status });
  } });
  const cookie = await h.login(), id = await h.account();
  const job = (await createRequest(h, cookie, id, "reel").send()).data.job;
  assert.equal((await check(h, cookie, job.id)).data.job.status, "processing");
  await check(h, cookie, job.id);
  assert.equal(checks, 1); assert.equal(published, 0);
  status = "FINISHED"; await allowCheck(h, job.id);
  assert.equal((await check(h, cookie, job.id)).data.job.status, "published");
  assert.equal(published, 1);
});

test("ambiguous publish failure is read-only on retry and recovers from PUBLISHED without posting twice", async (t) => {
  let status = "FINISHED", publishCalls = 0;
  const h = await harness(t, { meta: (url) => {
    if (url.pathname.endsWith("/media")) return json({ id: "88003" });
    if (url.pathname.endsWith("/media_publish")) { publishCalls++; return json({ error: { code: 2, message: "test-private-token" } }, 503); }
    return json({ status_code: status });
  } });
  const cookie = await h.login(), id = await h.account();
  const job = (await createRequest(h, cookie, id).send()).data.job;
  const uncertain = await check(h, cookie, job.id);
  assert.equal(uncertain.data.job.status, "unknown");
  await allowCheck(h, job.id); await check(h, cookie, job.id);
  assert.equal(publishCalls, 1, "FINISHED after an uncertain response must not trigger a second publish");
  status = "PUBLISHED"; await allowCheck(h, job.id);
  const recovered = await check(h, cookie, job.id);
  assert.equal(recovered.data.job.status, "published");
  assert.equal(recovered.data.job.published_media_id, null, "do not invent a media ID from the container ID");
  assert.equal(publishCalls, 1);
  assert.doesNotMatch(JSON.stringify(h.logs) + uncertain.text, /test-private-token/);
});

test("container timeout retains its request key across logout and never blindly repeats the side effect", async (t) => {
  const h = await harness(t, { timeout: 20, meta: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("test-private-timeout-url")), { once: true });
  }) });
  let cookie = await h.login(); const id = await h.account();
  const request = createRequest(h, cookie, id);
  const first = await request.send();
  assert.equal(first.data.job.status, "unknown");
  assert.equal(first.data.job.error_code, "creation_uncertain");
  await h.request("/auth/logout", { method: "POST", cookie }); cookie = await h.login();
  const duplicate = await createRequest(h, cookie, id, "image", request.key).send();
  assert.equal(duplicate.data.job.id, first.data.job.id);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(h.logs) + duplicate.text, /test-private-timeout/);
});

test("expiry blocks publishing and an invalidated token marks its connection for reconnect", async (t) => {
  const h = await harness(t, { meta: () => json({ error: { code: 190, message: "test-token-value" } }, 400) });
  const cookie = await h.login();
  const expired = await h.account("instagram", "10002", { expires: new Date(Date.now()-1000) });
  assert.equal((await createRequest(h, cookie, expired).send()).data.error, "reconnect_required");
  assert.equal(h.calls.length, 0);
  const revoked = await h.account();
  const result = await createRequest(h, cookie, revoked).send();
  assert.equal(result.data.job.status, "failed");
  assert.equal(result.data.job.error_code, "reconnect_required");
  const saved = (await h.request("/api/accounts", { cookie })).data.accounts;
  assert.equal(saved.find((a) => a.connection_id === revoked).needs_reconnect, true);
});

test("disconnect selects one connection, preserves history, and blocks unfinished publishing", async (t) => {
  const h = await harness(t, { meta: () => json({ id: "88004" }) });
  const cookie = await h.login();
  const fb = await h.account("facebook", "10004"), ig = await h.account("instagram", "10004");
  const job = (await createRequest(h, cookie, fb).send()).data.job;
  assert.equal((await h.request(`/api/accounts/${fb}`, { method: "DELETE", cookie })).status, 200);
  assert.equal((await check(h, cookie, job.id)).data.error, "connection_removed");
  const saved = (await h.request("/api/accounts", { cookie })).data.accounts;
  assert.equal(saved.length, 1); assert.equal(saved[0].connection_id, ig);
  const history = (await h.request("/api/jobs", { cookie })).data.jobs;
  assert.equal(history[0].connection_id, null); assert.equal(history[0].id, job.id);
});

test("eligible direct Instagram token refresh is encrypted and used for the following request", async (t) => {
  let refreshes = 0;
  const h = await harness(t, { meta: (url, init) => {
    if (url.pathname === "/refresh_access_token") { refreshes++; return json({ access_token: "test-refreshed-token", expires_in: 5184000 }); }
    assert.equal(init.headers.Authorization, "Bearer test-refreshed-token");
    return json({ id: "88005" });
  } });
  const cookie = await h.login();
  const id = await h.account("instagram", "10005", { expires: new Date(Date.now()+2*86400000) });
  await h.db.query("UPDATE publisher_accounts SET token_refreshed_at=NOW()-INTERVAL '2 days' WHERE id=$1", [id]);
  assert.equal((await createRequest(h, cookie, id).send()).data.job.status, "processing");
  const stored = (await h.db.query("SELECT * FROM publisher_accounts WHERE id=$1", [id])).rows[0];
  assert.equal(decryptToken(stored.encrypted_token, h.key, "instagram:10005"), "test-refreshed-token");
  assert.equal(refreshes, 1);
  await h.request(`/api/accounts/${id}/refresh`, { method: "POST", cookie });
  assert.equal(refreshes, 1);
});

test("lost database write after Meta publishes preserves uncertainty and does not publish again", async (t) => {
  let publishCalls = 0, published = false;
  const h = await harness(t, { meta: (url) => {
    if (url.pathname.endsWith("/media")) return json({ id: "88006" });
    if (url.pathname.endsWith("/media_publish")) { publishCalls++; published = true; return json({ id: "99006" }); }
    return json({ status_code: published ? "PUBLISHED" : "FINISHED" });
  } });
  const cookie = await h.login(), id = await h.account();
  const job = (await createRequest(h, cookie, id).send()).data.job;
  const query = h.db.query;
  let reject = true;
  h.db.query = async (sql, values) => {
    if (reject && sql.includes("published_media_id=$1")) { reject = false; throw new Error("Simulated lost database acknowledgement"); }
    return query(sql, values);
  };
  assert.equal((await check(h, cookie, job.id)).data.job.status, "unknown");
  await allowCheck(h, job.id);
  assert.equal((await check(h, cookie, job.id)).data.job.status, "published");
  assert.equal(publishCalls, 1);
});

test("unsafe media and missing idempotency key are rejected before any Meta call", async (t) => {
  const h = await harness(t), cookie = await h.login(), id = await h.account();
  const request = createRequest(h, cookie, id);
  assert.equal((await request.send({ ...request.body, image_url: "https://127.0.0.1/secrets" })).status, 400);
  assert.equal((await h.request("/api/publish/image", { method: "POST", cookie, body: request.body })).status, 400);
  assert.equal(h.calls.length, 0);
});

test("uploaded Reel files are private to the owner except through their expiring signed Meta URL", async (t) => {
  const h = await harness(t), cookie = await h.login();
  const data = mp4("signed-media");
  const key = crypto.randomUUID();
  assert.equal((await uploadVideo(h, null, "clip.mp4", data, key)).status, 401);
  const uploaded = await uploadVideo(h, cookie, "clip.mp4", data, key);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.asset.file_name, "clip.mp4");
  const replay = await uploadVideo(h, cookie, "clip.mp4", data, key);
  assert.equal(replay.data.asset.asset_id, uploaded.data.asset.asset_id);
  assert.equal((await uploadVideo(h, cookie, "other.mp4", mp4("different"), key)).status, 409);

  const assetId = uploaded.data.asset.asset_id;
  const token = crypto.createHmac("sha256", h.key).update(`publisher-media-v1:${assetId}`).digest("base64url");
  const response = await fetch(`${h.origin}/media/${assetId}/${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  const invalid = await fetch(`${h.origin}/media/${assetId}/${"x".repeat(43)}`);
  assert.equal(invalid.status, 404);
  await h.db.query("UPDATE publisher_media_assets SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [assetId]);
  const expired = await fetch(`${h.origin}/media/${assetId}/${token}`);
  assert.equal(expired.status, 404);
});

test("Meta's video download is streamed in slices: HEAD reads no bytes, Range works, the whole video is never selected", async (t) => {
  const h = await harness(t), cookie = await h.login();
  const data = Buffer.concat([mp4("large-reel"), crypto.randomBytes(2 * 1024 * 1024 + 4321)]);
  const uploaded = await uploadVideo(h, cookie, "large.mp4", data);
  assert.equal(uploaded.status, 201);
  const assetId = uploaded.data.asset.asset_id;
  const token = crypto.createHmac("sha256", h.key).update(`publisher-media-v1:${assetId}`).digest("base64url");
  const url = `${h.origin}/media/${assetId}/${token}`;
  const storage = await h.db.query("SELECT attstorage FROM pg_attribute WHERE attrelid='publisher_media_assets'::regclass AND attname='data'");
  assert.equal(storage.rows[0].attstorage, "e", "videos are stored uncompressed so slices are cheap");

  const query = h.db.query;
  const mediaQueries = [];
  h.db.query = async (sql, values) => {
    if (sql.includes("publisher_media_assets")) mediaQueries.push(sql);
    return query(sql, values);
  };
  const slices = () => mediaQueries.filter((sql) => sql.includes("substring(data")).length;

  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(data.length));
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(slices(), 0, "HEAD reads no video bytes");

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), data);
  assert.equal(slices(), 3, "a 2 MB+ video is read as three 1 MB slices");

  const start = 1024 * 1024 - 10, end = 1024 * 1024 + 20;
  const partial = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes ${start}-${end}/${data.length}`);
  assert.equal(partial.headers.get("content-length"), String(end - start + 1));
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), data.subarray(start, end + 1));

  const tail = await fetch(url, { headers: { range: "bytes=-100" } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), data.subarray(data.length - 100));

  const beyond = await fetch(url, { headers: { range: `bytes=${data.length}-` } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), `bytes */${data.length}`);
  await beyond.arrayBuffer();

  const wholeVideo = mediaQueries.filter((sql) => /^\s*SELECT\b/i.test(sql) && /\bdata\b/.test(sql) && !sql.includes("substring(data"));
  assert.deepEqual(wholeVideo, [], "no query loads the whole video column");
});


test("20-Reel batch is accepted, counted for the account, and 21 is rejected", async (t) => {
  const h = await harness(t, { meta: (url) => json({ id: url.pathname.endsWith("/media") ? "88020" : "99020" }) });
  const cookie = await h.login(), id = await h.account("instagram", "11020");
  const assetIds = [];
  for (let index = 0; index < 20; index++) {
    const assetId = crypto.randomUUID();
    assetIds.push(assetId);
    await h.db.query(
      `INSERT INTO publisher_media_assets(id,upload_key,payload_hash,access_token_hash,file_name,content_type,size_bytes,data,expires_at)
       VALUES($1,$2,$3,$4,$5,'video/mp4',16,$6,NOW()+INTERVAL '7 days')`,
      [assetId, crypto.randomUUID(), `payload-${index}`, `token-hash-${index}`, `reel-${index + 1}.mp4`, mp4(`clip-${index}`)]);
  }
  const payload = { connection_id: id, caption: "One caption", interval_minutes: 30, asset_ids: assetIds };
  const created = await h.request("/api/batches", { method: "POST", cookie,
    headers: { "idempotency-key": crypto.randomUUID() }, body: payload });
  assert.equal(created.status, 202);
  assert.equal(created.data.batch.jobs.length, 20);
  const accountProgress = (await h.request("/api/progress", { cookie })).data.progress[0];
  assert.equal(accountProgress.scheduled_count, 20);
  assert.equal(accountProgress.tracked_count, 20);
  assert.equal(accountProgress.remaining_count, 180);
  assert.equal((await h.request("/api/batches", { method: "POST", cookie,
    headers: { "idempotency-key": crypto.randomUUID() }, body: { ...payload, asset_ids: [...assetIds, crypto.randomUUID()] } })).status, 400);
});

test("batch shares one caption and publishes Reels in order at the configured interval", async (t) => {
  const mediaRequests = [], published = [];
  const h = await harness(t, { meta: (url, init) => {
    if (url.pathname.endsWith("/media")) {
      const fields = new URLSearchParams(init.body);
      mediaRequests.push({ caption: fields.get("caption"), video_url: fields.get("video_url") });
      return json({ id: String(88000 + mediaRequests.length) });
    }
    if (url.pathname.endsWith("/media_publish")) {
      published.push(new URLSearchParams(init.body).get("creation_id"));
      return json({ id: String(99000 + published.length) });
    }
    return json({ status_code: "FINISHED" });
  } });
  const cookie = await h.login(), id = await h.account("instagram", "11001");
  const first = await uploadVideo(h, cookie, "one.mp4", mp4("first"));
  const second = await uploadVideo(h, cookie, "two.mp4", mp4("second"));
  const payload = { connection_id: id, caption: "Same caption for every Reel", interval_minutes: 10,
    asset_ids: [first.data.asset.asset_id, second.data.asset.asset_id] };
  const batchKey = crypto.randomUUID();
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": batchKey }, body: payload });
  assert.equal(created.status, 202);
  assert.equal(created.data.batch.jobs.length, 2);
  assert.ok(["queued", "processing"].includes(created.data.batch.jobs[0].status));
  assert.equal((await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": batchKey }, body: payload })).data.batch.id,
    created.data.batch.id);
  assert.equal((await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": batchKey }, body: { ...payload, caption: "Changed" } })).status, 409);

  await waitFor(async () => mediaRequests.length === 1);
  await waitFor(async () => (await h.db.query("SELECT status FROM publisher_jobs WHERE batch_id=$1 AND batch_position=1", [created.data.batch.id])).rows[0].status === "processing");
  assert.equal(mediaRequests.length, 1, "only the first Reel starts immediately");
  assert.equal(mediaRequests[0].caption, "Same caption for every Reel");
  const url = new URL(mediaRequests[0].video_url);
  assert.equal(url.pathname.startsWith("/media/"), true);
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), mp4("first"));

  await h.db.query("UPDATE publisher_jobs SET next_check_at=NOW()-INTERVAL '1 second' WHERE batch_id=$1 AND batch_position=1", [created.data.batch.id]);
  await h.app.locals.runPublishingScheduler();
  assert.deepEqual(published, ["88001"]);
  const batchAfterFirst = await h.db.query("SELECT status,next_position FROM publisher_batches WHERE id=$1", [created.data.batch.id]);
  assert.equal(batchAfterFirst.rows[0].status, "queued");
  assert.equal(Number(batchAfterFirst.rows[0].next_position), 2);
  assert.equal(mediaRequests.length, 1, "the second Reel waits for the chosen gap");

  await h.db.query("UPDATE publisher_batches SET next_publish_at=NOW()-INTERVAL '1 second' WHERE id=$1", [created.data.batch.id]);
  await h.app.locals.runPublishingScheduler();
  await waitFor(async () => mediaRequests.length === 2);
  assert.equal(mediaRequests[1].caption, mediaRequests[0].caption);
  assert.notEqual(mediaRequests[1].video_url, mediaRequests[0].video_url);
  await h.db.query("UPDATE publisher_jobs SET next_check_at=NOW()-INTERVAL '1 second' WHERE batch_id=$1 AND batch_position=2", [created.data.batch.id]);
  await h.app.locals.runPublishingScheduler();
  const final = await h.db.query("SELECT status FROM publisher_batches WHERE id=$1", [created.data.batch.id]);
  assert.equal(final.rows[0].status, "completed");
  assert.deepEqual(published, ["88001", "88002"]);
});

test("a definitively failed Reel pauses its batch until the owner continues", async (t) => {
  const h = await harness(t, { meta: (url) => url.pathname.endsWith("/media")
    ? json({ error: { code: 10, message: "test rejection" } }, 400)
    : json({ status_code: "FINISHED" }) });
  const cookie = await h.login(), id = await h.account("instagram", "11002");
  const first = await uploadVideo(h, cookie, "bad.mp4", mp4("bad"));
  const second = await uploadVideo(h, cookie, "next.mp4", mp4("next"));
  const payload = { connection_id: id, caption: "caption", interval_minutes: 15,
    asset_ids: [first.data.asset.asset_id, second.data.asset.asset_id] };
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() }, body: payload });
  await waitFor(async () => (await h.db.query("SELECT status FROM publisher_jobs WHERE batch_id=$1 AND batch_position=1", [created.data.batch.id])).rows[0].status === "failed");
  const paused = await h.db.query("SELECT status,next_position,pause_reason FROM publisher_batches WHERE id=$1", [created.data.batch.id]);
  assert.equal(paused.rows[0].status, "paused");
  assert.equal(Number(paused.rows[0].next_position), 2);
  assert.equal(paused.rows[0].pause_reason, "permission_required");
  await waitFor(async () => {
    await h.app.locals.runPublishingScheduler();
    return !(await h.db.query("SELECT 1 FROM publisher_media_assets WHERE id=$1", [first.data.asset.asset_id])).rows.length;
  }, 200);
  const kept = (await h.db.query("SELECT id::text AS id FROM publisher_media_assets")).rows.map((row) => row.id);
  assert.deepEqual(kept, [second.data.asset.asset_id], "the failed Reel's video is freed; the waiting Reel keeps its own");
  assert.equal((await h.request(`/api/batches/${created.data.batch.id}/resume`, { method: "POST", cookie, body: {} })).status, 200);
  await waitFor(async () => (await h.db.query("SELECT status FROM publisher_jobs WHERE batch_id=$1 AND batch_position=2", [created.data.batch.id])).rows[0].status === "failed");
});

const jobStatus = async (h, id) => (await h.db.query("SELECT status FROM publisher_jobs WHERE id=$1", [id])).rows[0].status;

test("a published Reel's video is deleted while Activity keeps its file name", async (t) => {
  const h = await harness(t, { meta: (url) => {
    if (url.pathname.endsWith("/media")) return json({ id: "88200" });
    if (url.pathname.endsWith("/media_publish")) return json({ id: "99200" });
    return json({ status_code: "FINISHED" });
  } });
  const cookie = await h.login(), id = await h.account("instagram", "11200");
  const first = await uploadVideo(h, cookie, "keep-name.mp4", mp4("one"));
  const second = await uploadVideo(h, cookie, "waits.mp4", mp4("two"));
  const loose = await uploadVideo(h, cookie, "never-batched.mp4", mp4("three"));
  const expiresInHours = async (assetId) => Number((await h.db.query(
    "SELECT EXTRACT(EPOCH FROM expires_at-NOW())/3600 AS hours FROM publisher_media_assets WHERE id=$1", [assetId])).rows[0].hours);
  assert.ok(Math.abs(await expiresInHours(loose.data.asset.asset_id) - 24) < 1, "an upload outside a batch expires after a day");

  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 30, asset_ids: [first.data.asset.asset_id, second.data.asset.asset_id] } });
  assert.equal(created.status, 202);
  assert.ok(Math.abs(await expiresInHours(second.data.asset.asset_id) - 24 * 7) < 1, "videos in a batch are kept up to a week");
  const jobId = created.data.batch.jobs[0].id;
  await waitFor(async () => (await jobStatus(h, jobId)) === "processing", 200);
  await allowCheck(h, jobId);
  await waitFor(async () => { await h.app.locals.runPublishingScheduler(); return (await jobStatus(h, jobId)) === "published"; }, 200);
  await waitFor(async () => {
    await h.app.locals.runPublishingScheduler();
    return !(await h.db.query("SELECT 1 FROM publisher_media_assets WHERE id=$1", [first.data.asset.asset_id])).rows.length;
  }, 200);

  const kept = (await h.db.query("SELECT id::text AS id FROM publisher_media_assets")).rows.map((row) => row.id).sort();
  assert.deepEqual(kept, [second.data.asset.asset_id, loose.data.asset.asset_id].sort(), "only the published video is freed");
  const jobs = (await h.request("/api/jobs", { cookie })).data.jobs;
  assert.equal(jobs.find((job) => job.id === jobId).media_name, "keep-name.mp4");
  assert.equal(jobs.find((job) => job.id === jobId).published_media_id, "99200");
});

test("stopping the scheduler waits for an in-flight publish to be recorded", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await harness(t, { meta: async (url) => {
    if (url.pathname.endsWith("/media")) return json({ id: "88300" });
    if (url.pathname.endsWith("/media_publish")) { await gate; return json({ id: "99300" }); }
    return json({ status_code: "FINISHED" });
  } });
  const cookie = await h.login(), id = await h.account("instagram", "11300");
  const video = await uploadVideo(h, cookie, "drain.mp4", mp4("drain"));
  const created = await h.request("/api/batches", { method: "POST", cookie, headers: { "idempotency-key": crypto.randomUUID() },
    body: { connection_id: id, caption: "c", interval_minutes: 10, asset_ids: [video.data.asset.asset_id] } });
  const jobId = created.data.batch.jobs[0].id;
  await waitFor(async () => (await jobStatus(h, jobId)) === "processing", 200);
  await allowCheck(h, jobId);
  await waitFor(async () => { void h.app.locals.runPublishingScheduler(); return (await jobStatus(h, jobId)) === "publishing"; }, 200);

  let stopped = false;
  const stopping = h.app.locals.stopPublishingScheduler().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, false, "stop waits while the publish call is in flight");
  release();
  await stopping;
  assert.equal(await jobStatus(h, jobId), "published", "the publish is recorded before shutdown continues");
  assert.equal(await h.app.locals.runPublishingScheduler(), undefined, "no new run starts after stop");
});
