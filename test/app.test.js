"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json, facebookMeta, TEST_PASSWORD } = require("./helpers");
const { decryptToken } = require("../lib/security");

test("missing setup fails closed while health remains compatible", async (t) => {
  const h = await harness(t, { noDb: true });
  assert.equal((await h.request("/health")).data.secureStorageReady, false);
  assert.equal((await h.request("/ready")).status, 503);
  assert.equal((await h.request("/auth/meta/start")).status, 503);
  assert.equal((await h.request("/api/accounts")).status, 503);
  assert.equal((await h.request("/auth/meta/callback?code=test-sensitive-code")).location, "/?notice=setup_required");
  assert.equal(h.calls.length, 0);
});

test("database connection loss fails safely and the readiness check restores service", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const query = h.db.query;
  let failNextQuery = true;
  h.db.query = async (...args) => {
    if (failNextQuery) {
      failNextQuery = false;
      const error = new Error("connection reset");
      error.code = "ECONNRESET";
      throw error;
    }
    return query(...args);
  };
  const unavailable = await h.request("/api/accounts", { cookie });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.error, "temporarily_unavailable");
  assert.equal(h.app.locals.isDatabaseReady(), false);
  h.db.query = query;
  const recovered = await h.request("/ready");
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, { ok: true });
  assert.equal(h.app.locals.isDatabaseReady(), true);
  assert.equal((await h.request("/api/accounts", { cookie })).status, 200);
});

test("dashboard authentication rejects fixation, cross-origin writes and anonymous publishing", async (t) => {
  const h = await harness(t);
  assert.equal((await h.request("/api/accounts")).status, 401);
  const fixed = `igpub_owner=${crypto.randomBytes(32).toString("base64url")}`;
  assert.equal((await h.request("/api/accounts", { cookie: fixed })).status, 401);
  assert.equal((await h.request("/auth/login", { method: "POST", body: { password: TEST_PASSWORD }, originHeader: "https://evil.example" })).status, 403);
  assert.equal((await h.request("/auth/login", { method: "POST", body: { password: TEST_PASSWORD }, originHeader: null })).status, 403);
  const signedIn = await h.request("/auth/login", { method: "POST", body: { password: TEST_PASSWORD }, cookie: fixed });
  assert.notEqual(signedIn.cookie, fixed);
  assert.match(signedIn.response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(signedIn.response.headers.get("set-cookie"), /SameSite=Lax/);
  assert.equal((await h.request("/auth/logout", { method: "POST", cookie: signedIn.cookie, originHeader: "https://evil.example" })).status, 403);
  const page = await h.request("/");
  assert.match(page.response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.response.headers.get("cache-control"), "no-store");
});

test("OAuth is browser-bound, exchanges once under concurrent replay, and persists 30 accounts through logout", async (t) => {
  const h = await harness(t, { meta: facebookMeta(30) });
  const cookie = await h.login();
  const start = await h.request("/auth/meta/start", { cookie });
  const state = new URL(start.location).searchParams.get("state");
  const other = await h.login();
  const callback = `/auth/meta/callback?state=${state}&code=test-sensitive-code`;
  assert.equal((await h.request(callback, { cookie: other })).location, "/?notice=connection_invalid");
  assert.equal(h.calls.length, 0);
  const results = await Promise.all([h.request(callback, { cookie }), h.request(callback, { cookie })]);
  assert.ok(results.some((r) => r.location === "/?notice=connected"));
  assert.equal((await h.request(callback, { cookie })).location, "/?notice=connected");
  assert.equal(h.calls.filter((c) => c.url.searchParams.has("code")).length, 1);
  assert.equal(h.calls.filter((c) => c.url.pathname.endsWith("/me/accounts")).length, 2);
  assert.ok(h.calls.every((c) => c.url.hostname === "graph.facebook.com"));
  const list = await h.request("/api/accounts", { cookie });
  assert.equal(list.data.accounts.length, 30);
  assert.doesNotMatch(list.text, /test-page-token|encrypted_token|access_token/);
  const saved = (await h.db.query("SELECT * FROM publisher_accounts ORDER BY id LIMIT 1")).rows[0];
  assert.equal(decryptToken(saved.encrypted_token, h.key, `${saved.provider}:${saved.account_id}`), "test-page-token-0");
  assert.equal(saved.token_expires_at, null, "Page expiry must not be guessed from the user token");
  assert.equal((await h.request("/auth/logout", { method: "POST", cookie })).status, 200);
  assert.equal((await h.request("/api/accounts", { cookie })).status, 401);
  const relogin = await h.login();
  assert.equal((await h.request("/api/accounts", { cookie: relogin })).data.accounts.length, 30);
});

test("cancelled, expired and duplicate-query OAuth callbacks never exchange a code", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  async function state() { return new URL((await h.request("/auth/meta/start", { cookie })).location).searchParams.get("state"); }
  let s = await state();
  assert.equal((await h.request(`/auth/meta/callback?state=${s}&error=access_denied&error_description=private`, { cookie })).location, "/?notice=connection_cancelled");
  await h.request(`/auth/meta/callback?state=${s}&code=test`, { cookie });
  s = await state();
  await h.db.query("UPDATE publisher_oauth_attempts SET expires_at=NOW()-INTERVAL '1 second'");
  assert.equal((await h.request(`/auth/meta/callback?state=${s}&code=test`, { cookie })).location, "/?notice=connection_invalid");
  s = await state();
  assert.equal((await h.request(`/auth/meta/callback?state=${s}&state=extra&code=test`, { cookie })).location, "/?notice=connection_invalid");
  assert.equal(h.calls.length, 0);
});

test("direct Instagram flow uses its own credentials and saves encrypted long-lived authorization", async (t) => {
  const h = await harness(t, { meta: (url, init) => {
    if (url.hostname === "api.instagram.com") {
      assert.equal(init.body.get("client_id"), "test-instagram-app");
      assert.equal(init.body.get("client_secret"), "test-instagram-secret");
      return json({ data: [{ access_token: "test-short-ig", user_id: "50001", permissions: "instagram_business_basic,instagram_business_content_publish" }] });
    }
    if (url.pathname === "/access_token") {
      assert.equal(url.searchParams.get("client_secret"), "test-instagram-secret");
      return json({ access_token: "test-long-ig", expires_in: 5184000 });
    }
    assert.match(init.headers.Authorization, /^Bearer /);
    return json({ user_id: "50001", username: "test_direct" });
  } });
  const cookie = await h.login();
  const start = await h.request("/auth/instagram/start", { cookie });
  const authorize = new URL(start.location);
  assert.equal(authorize.searchParams.get("client_id"), "test-instagram-app");
  const callback = await h.request(`/auth/meta/callback?state=${authorize.searchParams.get("state")}&code=test-ig-code`, { cookie });
  assert.equal(callback.location, "/?notice=connected");
  const saved = (await h.db.query("SELECT * FROM publisher_accounts")).rows[0];
  assert.equal(saved.provider, "instagram");
  assert.equal(decryptToken(saved.encrypted_token, h.key, "instagram:50001"), "test-long-ig");
  assert.ok(new Date(saved.token_expires_at).getTime() > Date.now());
});

test("OAuth provider errors never leak codes, tokens, secrets or raw provider messages", async (t) => {
  const h = await harness(t, { meta: () => json({ error: { message: "test-private-token test-private-secret", code: 100, error_subcode: 36009 } }, 400) });
  const cookie = await h.login();
  const state = new URL((await h.request("/auth/meta/start", { cookie })).location).searchParams.get("state");
  const result = await h.request(`/auth/meta/callback?state=${state}&code=test-private-code`, { cookie });
  assert.equal(result.location, "/?notice=connection_failed");
  assert.doesNotMatch(result.text + JSON.stringify(h.logs), /test-private|test-facebook-secret/);
  assert.equal(h.logs[0].code, 100);
  await h.request(`/auth/meta/callback?state=${state}&code=test-private-code`, { cookie });
  assert.equal(h.calls.length, 1);
});

test("known legacy browser-owned data blocks schema adoption and is never deleted", async (t) => {
  const h = await harness(t, { env: { DASHBOARD_PASSWORD: "" } });
  await h.db.exec("CREATE TABLE connected_accounts(id INTEGER); INSERT INTO connected_accounts VALUES (1)");
  const { initializeDatabase } = require("../lib/database");
  await assert.rejects(initializeDatabase(h.db), /migration requires owner review/);
  assert.equal((await h.db.query("SELECT * FROM connected_accounts")).rows.length, 1);
});

test("login attempts are bounded", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 5; i++) assert.equal((await h.request("/auth/login", { method: "POST", body: { password: "wrong" } })).status, 401);
  assert.equal((await h.request("/auth/login", { method: "POST", body: { password: TEST_PASSWORD } })).status, 429);
});

test("per-account progress counts publishing states and saves a carry-over count", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const id = await h.account("instagram", "50031");

  let result = await h.request("/api/progress", { cookie });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.progress[0], {
    connection_id: id, username: "test_creator", account_id: "50031",
    target_count: 200, baseline_count: 0, published_count: 0,
    scheduled_count: 0, failed_count: 0, unknown_count: 0,
    tracked_count: 0, remaining_count: 200
  });

  for (const status of ["published", "published", "queued", "processing", "publishing", "failed", "unknown"]) {
    await h.db.query(
      `INSERT INTO publisher_jobs(id,request_key,payload_hash,account_row_id,account_name,media_type,status)
       VALUES($1,$2,$3,$4,'test_creator','reel',$5)`,
      [crypto.randomUUID(), crypto.randomUUID(), `hash-${crypto.randomUUID()}`, id, status]);
  }
  result = await h.request("/api/progress", { cookie });
  assert.equal(result.data.progress[0].published_count, 2);
  assert.equal(result.data.progress[0].scheduled_count, 3);
  assert.equal(result.data.progress[0].failed_count, 1);
  assert.equal(result.data.progress[0].unknown_count, 1);
  assert.equal(result.data.progress[0].tracked_count, 5);
  assert.equal(result.data.progress[0].remaining_count, 195);

  result = await h.request(`/api/accounts/${id}/progress`, {
    method: "PUT", cookie, body: { target_count: 200, baseline_count: 130 }
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.progress.baseline_count, 130);
  assert.equal(result.data.progress.target_count, 200);
  assert.equal(result.data.progress.tracked_count, 135);
  assert.equal(result.data.progress.remaining_count, 65);
  assert.equal((await h.request(`/api/accounts/${id}/progress`, {
    method: "PUT", cookie, body: { target_count: 100, baseline_count: 130 }
  })).status, 400);
  assert.equal((await h.request("/api/progress")).status, 401);
});
