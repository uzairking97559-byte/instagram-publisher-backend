"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");
const { decryptToken } = require("../lib/security");

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
