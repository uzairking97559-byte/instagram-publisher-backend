"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, json } = require("./helpers");
const { readList } = require("../lib/checks");

const IG_ID = "17841400000000001";
const DAY = 86400000;

// Instagram Business Discovery: answers per username.
function instagram(clock, calls) {
  let slowSeen = false;
  return (url, init) => {
    assert.equal(url.hostname, "graph.facebook.com");
    assert.match(url.pathname, new RegExp(`^/v[\\d.]+/${IG_ID}$`));
    assert.equal(init.headers.Authorization, "Bearer test-only-page-token");
    const username = url.searchParams.get("fields").match(/^business_discovery\.username\(([a-z0-9._]+)\)\{/)[1];
    calls.push(username);
    const posts = (...days) => ({ data: days.map((d) => ({ timestamp: new Date(clock.now.getTime() - d * DAY).toISOString(), id: String(d) })) });
    const found = (followers, media) => json({ business_discovery: { username, followers_count: followers, media_count: 10, media, id: "1" }, id: IG_ID });
    if (username === "fresh") return found(5000, posts(40, 2, 9)); // a pinned old post comes first
    if (username === "stale") return found(800, posts(60, 75));
    if (username === "empty") return found(100, { data: [] });
    if (username === "slow" && !slowSeen) { slowSeen = true; return json({ error: { code: 4, message: "Application request limit reached" } }, 400); }
    if (username === "slow") return found(9000, posts(1));
    if (username === "expired") return json({ error: { code: 190, message: "Session has expired" } }, 400);
    return json({ error: { code: 110, error_subcode: 2207013, message: "Invalid user id" } }, 400);
  };
}

async function setup(t) {
  const calls = [];
  const clock = { now: new Date("2026-10-18T06:00:00Z") };
  const h = await harness(t, { meta: instagram(clock, calls), checkOptions: { now: () => clock.now, intervalMs: 0 } });
  const cookie = await h.login();
  const tick = () => h.app.locals.runCheckWorker();
  const advance = (ms) => { clock.now = new Date(clock.now.getTime() + ms); };
  const get = async (id, query = "") => (await h.request(`/api/checks/${id}${query}`, { cookie })).data;
  const grant = async () => {
    const id = await h.account("facebook", IG_ID);
    await h.db.query("UPDATE publisher_accounts SET scopes=ARRAY['instagram_manage_insights'] WHERE id=$1", [id]);
    return id;
  };
  return { h, cookie, calls, clock, tick, advance, get, grant };
}

test("a pasted sheet counts only its profile links", () => {
  assert.deepEqual(readList("Itz Fresh,https://www.instagram.com/fresh?igsh=x,10k\nName Two,instagram.com/stale/,1k\n,https://www.instagram.com/stories/abc/123,").usernames,
    ["fresh", "stale"]);
  assert.deepEqual(readList("fresh\n@stale\nfresh").usernames, ["fresh", "stale"]);
});

test("the list check finds active, old and missing creators at Instagram's pace", async (t) => {
  const { h, cookie, calls, tick, advance, get, grant } = await setup(t);
  let status = (await h.request("/api/checks", { cookie })).data;
  assert.equal(status.connected, false);
  assert.equal(status.per_hour, 180);
  // The connect link for the check also asks for the insights permission.
  const start = new URL((await h.request("/auth/meta/start?extra=insights", { cookie })).location);
  assert.equal(start.searchParams.get("scope").split(",").includes("instagram_manage_insights"), true);
  const plain = new URL((await h.request("/auth/meta/start", { cookie })).location);
  assert.equal(plain.searchParams.get("scope").includes("instagram_manage_insights"), false);

  assert.equal((await h.request("/api/checks", { method: "POST", cookie, body: { name: "", usernames: "fresh" } })).data.error, "invalid_check");
  assert.equal((await h.request("/api/checks", { method: "POST", cookie, body: { name: "Sheet", usernames: "!!!" } })).data.error, "invalid_usernames");
  const created = await h.request("/api/checks", { method: "POST", cookie, body: { name: "Sheet", usernames:
    "Fresh,https://www.instagram.com/fresh?igsh=x\nStale,https://instagram.com/stale/\nAgain,https://www.instagram.com/fresh/\n" +
    ",https://www.instagram.com/gone\n,https://www.instagram.com/empty\n,https://www.instagram.com/slow" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.added, 5);
  const id = created.data.check.id;

  // Without a connection that granted the permission, the check waits for it.
  await tick();
  assert.equal((await get(id)).check.pause_reason, "permission_required");
  await grant();
  status = (await h.request("/api/checks", { cookie })).data;
  assert.equal(status.connected, true);
  assert.equal((await h.request(`/api/checks/${id}/start`, { method: "POST", cookie, body: {} })).data.check.status, "running");

  await tick();
  await tick();
  assert.deepEqual(calls, ["fresh"], "one username per 20 seconds");
  for (let step = 0; step < 4; step++) { advance(20000); await tick(); }
  assert.deepEqual(calls, ["fresh", "stale", "gone", "empty", "slow"]);
  // Instagram's limit: wait half an hour, then the same username again.
  advance(20000); await tick();
  assert.equal(calls.length, 5);
  advance(30 * 60000); await tick();
  assert.deepEqual(calls.slice(5), ["slow"]);
  advance(20000); await tick();

  const done = await get(id);
  assert.equal(done.check.status, "done");
  assert.deepEqual(done.check.counts, { total: 5, pending: 0, active: 2, old: 2, not_found: 1, errors: 0 });
  assert.deepEqual((await get(id, "/usernames")).usernames, ["slow", "fresh"], "biggest accounts first");
  assert.deepEqual((await get(id, "/usernames?filter=old")).usernames, ["stale", "empty"]);
  const missing = await get(id, "?filter=not_found");
  assert.deepEqual(missing.items.map((item) => [item.username, item.status]), [["gone", "not_found"]]);
  const fresh = (await get(id, "?filter=active")).items.find((item) => item.username === "fresh");
  assert.equal(fresh.followers, 5000);
  assert.equal(new Date(fresh.last_post_at).toISOString(), "2026-10-16T06:00:00.000Z", "newest post, not the pinned one");
});

test("an expired connection pauses the check and asks for a reconnect", async (t) => {
  const { h, cookie, tick, get, grant } = await setup(t);
  const account = await grant();
  const id = (await h.request("/api/checks", { method: "POST", cookie, body: { name: "One", usernames: "expired\nfresh" } })).data.check.id;
  await tick();
  const check = await get(id);
  assert.equal(check.check.status, "paused");
  assert.equal(check.check.pause_reason, "reconnect_required");
  assert.equal(check.check.counts.pending, 2, "nothing is marked when the token fails");
  const row = (await h.db.query("SELECT needs_reconnect FROM publisher_accounts WHERE id=$1", [account])).rows[0];
  assert.equal(row.needs_reconnect, true);
  assert.equal((await h.request(`/api/checks/${id}/pause`, { method: "POST", cookie, body: {} })).data.check.status, "paused");
  assert.deepEqual((await h.request(`/api/checks/${id}`, { method: "DELETE", cookie })).data, { ok: true });
  assert.equal((await h.request(`/api/checks/${id}`, { cookie })).status, 404);
});
