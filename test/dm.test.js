"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");
const { parseUsernames, inWindow, nextHourAt } = require("../lib/dm");

const KEY = "test-browser-use-key";
const PROFILE = "35a603c8-5ea3-415e-a626-eb4d530cdcb4";
const MESSAGE = "Hey! 👋 We're inviting Instagram page owners to join our Paid Logo Promotion Program! Reply YES for details.";
const NOON_IST = "2026-10-18T06:30:00.000Z";

// Browser Use's REST API: browsers cost a little proxy data each, and stopping
// one settles its browser time.
function browserUseFake() {
  const browsers = new Map();
  const calls = [];
  const run = async (url, init = {}) => {
    assert.equal(url.hostname, "api.browser-use.com", "only Browser Use is called");
    calls.push(`${init.method || "GET"} ${url.pathname}`);
    if (init.headers?.["X-Browser-Use-API-Key"] !== KEY) return json({ detail: "invalid key" }, 401);
    if (url.pathname === "/api/v4/profiles") {
      return json({ items: [{ id: PROFILE, name: "Personal Profile", lastUsedAt: null }, { id: "not-a-uuid", name: "x" }] });
    }
    if (url.pathname === "/api/v4/browsers" && init.method === "POST") {
      const id = crypto.randomUUID();
      browsers.set(id, { body: JSON.parse(init.body), status: "active" });
      return json({ id, status: "active", cdpUrl: `wss://cdp.test/${id}`, proxyUsedMb: "0", proxyCost: "0", browserCost: "0.06" }, 201);
    }
    const match = url.pathname.match(/^\/api\/v4\/browsers\/([0-9a-f-]{36})$/);
    if (match) {
      const browser = browsers.get(match[1]);
      if (!browser) return json({ detail: "not found" }, 404);
      if (init.method === "PATCH") {
        assert.deepEqual(JSON.parse(init.body), { action: "stop" });
        browser.status = "stopped";
      }
      return json({ id: match[1], status: browser.status, proxyUsedMb: "2", proxyCost: "0.01",
        browserCost: browser.status === "stopped" ? "0.002" : "0.06" });
    }
    throw new Error(`Unexpected Browser Use route ${url.pathname}`);
  };
  return { run, browsers, calls };
}

// Stands in for lib/instagram-dm.js: answers per username, "sent" by default.
// inbox: what a reply check finds (replies, the account's username, or a
// "blocked" result) and how typed answers go (by message text).
function fakeDriver(results = {}) {
  const sent = [];
  const opened = [];
  const checks = [];
  const answers = [];
  const inbox = { account: "aiglow.artlab", replies: [], blocked: null, answerResults: {} };
  return {
    sent, opened, results, checks, answers, inbox,
    async open(cdpUrl) {
      opened.push(cdpUrl);
      let alive = true;
      return {
        alive: () => alive,
        sendDm: async ({ username, message, previous }) => {
          sent.push({ username, message, previous });
          return results[username] || { status: "sent" };
        },
        readReplies: async ({ outgoing, known }) => {
          if (inbox.blocked) { checks.push({ blocked: true }); return inbox.blocked; }
          const found = [];
          const ours = {};
          let skipped = 0;
          for (const reply of inbox.replies) {
            if (await known(reply.key)) { skipped++; continue; }
            ours[reply.username] = await outgoing(reply.username);
            found.push(reply);
          }
          checks.push({ ours, found: found.length });
          return { status: "ok", account: inbox.account, rows: inbox.replies.length + 2, waiting: inbox.replies.length, skipped, replies: found, detail: "T:x" };
        },
        sendReply: async (item) => {
          answers.push(item);
          return inbox.answerResults[item.message] || { status: "sent" };
        },
        idle: async () => {},
        close: () => { alive = false; }
      };
    }
  };
}

async function setup(t, { results = {}, now = NOON_IST, env = { BROWSER_USE_API_KEY: KEY } } = {}) {
  const fake = browserUseFake();
  const driver = fakeDriver(results);
  const clock = { now: new Date(now) };
  const h = await harness(t, { env, meta: fake.run, dmOptions: { driver, now: () => clock.now, random: () => 0.5, intervalMs: 0 } });
  const cookie = await h.login();
  const advance = (ms) => { clock.now = new Date(clock.now.getTime() + ms); };
  const create = (overrides = {}) => h.request("/api/dm/campaigns", { method: "POST", cookie, body: {
    name: "Commenters", profile_id: PROFILE, profile_name: "Personal Profile", message: MESSAGE, usernames: "one\ntwo",
    daily_limit: 100, gap_minutes: 9, start_hour: 8, end_hour: 23, requested_contact: true, ...overrides } });
  const campaign = async (id) => (await h.request(`/api/dm/campaigns/${id}`, { cookie })).data;
  const start = (id, body = {}) => h.request(`/api/dm/campaigns/${id}/start`, { method: "POST", cookie, body });
  const tick = () => h.app.locals.runDmWorker();
  return { h, fake, driver, clock, cookie, advance, create, campaign, start, tick };
}

test("usernames come from lines, @names and Instagram links; hours follow India time", () => {
  const { usernames, invalid } = parseUsernames(
    "@Shobhajee1\nhttps://www.instagram.com/shinchan_edits.01/?igsh=abc\ninstagram.com/daily_jokes7738, itz_sanashaikh.143 shobhajee1\n" +
    "https://www.instagram.com/reel/xyz/\nnot-valid!\n");
  assert.deepEqual(usernames, ["shobhajee1", "shinchan_edits.01", "daily_jokes7738", "itz_sanashaikh.143"]);
  assert.deepEqual(invalid, ["https://www.instagram.com/reel/xyz/", "not-valid!"]);
  assert.equal(inWindow(new Date(NOON_IST), 8, 23), true);
  assert.equal(inWindow(new Date("2026-10-18T18:00:00Z"), 8, 23), false, "23:30 in India is outside 8–23");
  assert.equal(inWindow(new Date("2026-10-18T18:00:00Z"), 22, 2), true, "overnight hours");
  assert.equal(nextHourAt(new Date("2026-10-18T18:00:00Z"), 8).toISOString(), "2026-10-19T02:30:00.000Z");
});

test("DM Sender needs sign-in and a Browser Use key", async (t) => {
  const { h, cookie, create } = await setup(t, { env: {} });
  assert.equal((await h.request("/api/dm")).status, 401);
  const status = await h.request("/api/dm", { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.data.configured, false);
  assert.deepEqual(status.data.campaigns, []);
  assert.equal((await h.request("/api/dm/profiles", { cookie })).data.error, "dm_not_configured");
  const created = await create();
  assert.equal(created.status, 201, "a list can be prepared before the key is set");
  assert.equal((await h.request(`/api/dm/campaigns/${created.data.campaign.id}/start`, { method: "POST", cookie, body: {} })).data.error, "dm_not_configured");
});

test("a campaign saves its list once, without duplicates, and only for people who asked", async (t) => {
  const { h, cookie, create, campaign } = await setup(t);
  const profiles = await h.request("/api/dm/profiles", { cookie });
  assert.deepEqual(profiles.data.profiles, [{ id: PROFILE, name: "Personal Profile", last_used_at: null }]);

  assert.equal((await create({ requested_contact: false })).data.error, "contact_not_confirmed");
  assert.equal((await create({ profile_id: "nope" })).data.error, "invalid_campaign");
  assert.equal((await create({ message: "" })).data.error, "invalid_campaign");
  assert.equal((await create({ gap_minutes: 1 })).data.error, "invalid_campaign");
  assert.equal((await create({ proxy: "india" })).data.error, "invalid_campaign");
  assert.equal((await create({ usernames: "!!!" })).data.error, "invalid_usernames");

  const created = await create({ usernames: "one\ntwo\ntwo\n@three bad!name" });
  assert.equal(created.status, 201);
  assert.equal(created.data.added, 3);
  assert.deepEqual(created.data.invalid, ["bad!name"]);
  const item = created.data.campaign;
  assert.equal(item.status, "paused");
  assert.equal(item.pause_reason, "not_started");
  assert.equal(item.gap_minutes, 9);
  assert.equal(item.proxy, "in", "India proxy unless the campaign says otherwise");
  assert.deepEqual(item.counts, { total: 3, pending: 3, sent: 0, skipped: 0, failed: 0, sent_today: 0 });
  const detail = await campaign(item.id);
  assert.deepEqual(detail.targets.map((row) => [row.username, row.status]), [["one", "pending"], ["two", "pending"], ["three", "pending"]]);

  const more = await h.request(`/api/dm/campaigns/${item.id}/targets`, { method: "POST", cookie, body: { usernames: "three\nfour" } });
  assert.equal(more.data.added, 1);
  assert.equal(more.data.already_listed, 1);

  // Lists bigger than the usual 32 KB request still fit (up to 2,000 names).
  const long = Array.from({ length: 1500 }, (_, index) => `creator_account_number_${String(index).padStart(4, "0")}`).join("\n");
  const big = await create({ usernames: long });
  assert.equal(big.status, 201);
  assert.equal(big.data.added, 1500);
  const tooMany = await h.request(`/api/dm/campaigns/${big.data.campaign.id}/targets`, { method: "POST", cookie,
    body: { usernames: Array.from({ length: 501 }, (_, index) => `extra_${index}`).join("\n") } });
  assert.equal(tooMany.data.error, "too_many_usernames");
});

test("the worker sends one message per gap, stops after a test run and reports the cost", async (t) => {
  const { h, fake, driver, cookie, advance, create, campaign, start, tick } = await setup(t, {
    results: { two: { status: "skipped", reason: "already_in_thread" } }
  });
  const created = await create({ usernames: "one\ntwo\nthree\nfour" });
  const id = created.data.campaign.id;
  const started = await start(id, { stop_after: 2 });
  assert.equal(started.status, 200);
  assert.equal(started.data.campaign.status, "running");
  await tick();
  assert.deepEqual(driver.sent.map((item) => item.username), ["one"]);
  assert.equal(driver.sent[0].message, MESSAGE);
  const [browser] = [...fake.browsers.values()];
  assert.equal(browser.body.profileId, PROFILE);
  assert.equal(browser.body.proxyCountryCode, "in", "same country as the saved login");

  let detail = await campaign(id);
  assert.equal(detail.campaign.counts.sent, 1);
  assert.equal(new Date(detail.campaign.next_send_at).getTime(), new Date(NOON_IST).getTime() + 9 * 60000);
  await tick();
  assert.equal(driver.sent.length, 1, "nothing more before the gap");

  advance(9 * 60000 + 1000);
  await tick();
  advance(16000);
  await tick();
  assert.deepEqual(driver.sent.map((item) => item.username), ["one", "two", "three"]);
  detail = await campaign(id);
  assert.equal(detail.campaign.status, "paused");
  assert.equal(detail.campaign.pause_reason, "test_done");
  assert.deepEqual(detail.campaign.counts, { total: 4, pending: 1, sent: 2, skipped: 1, failed: 0, sent_today: 2 });
  assert.deepEqual(detail.targets.map((row) => [row.username, row.status, row.reason]),
    [["one", "sent", null], ["two", "skipped", "already_in_thread"], ["three", "sent", null], ["four", "pending", null]]);
  assert.equal(driver.opened.length, 1, "one browser for the whole run");
  assert.equal(browser.status, "stopped", "the browser stops when the campaign pauses");
  assert.equal(detail.campaign.browser_active, false);
  assert.equal(detail.campaign.cost.proxy_mb, 2);
  assert.equal(detail.campaign.cost.inr, 1.16);
  assert.equal(detail.campaign.cost.per_dm_inr, 0.58);

  // Starting again finishes the list; then the campaign completes.
  assert.equal((await start(id)).status, 200);
  await tick();
  advance(10 * 60000);
  await tick();
  detail = await campaign(id);
  assert.deepEqual(driver.sent.map((item) => item.username), ["one", "two", "three", "four"]);
  assert.equal(detail.campaign.status, "completed");
  assert.equal([...fake.browsers.values()].every((item) => item.status === "stopped"), true);

  // Someone already messaged is never messaged again from another campaign.
  const second = await create({ name: "Next", usernames: "one\nfive" });
  assert.equal(second.data.already_contacted, 1);
  assert.equal(second.data.added, 1);
  assert.equal((await h.request("/api/dm", { cookie })).data.campaigns.length, 2);
});

test("an Instagram warning or logout pauses the campaign and closes the browser", async (t) => {
  const { h, fake, driver, cookie, create, campaign, start, tick } = await setup(t, {
    results: {
      one: { status: "blocked", reason: "action_blocked", text: "Try Again Later", attempted: true },
      two: { status: "blocked", reason: "logged_out", text: null, attempted: false }
    }
  });
  const id = (await create({ usernames: "one\ntwo\nthree" })).data.campaign.id;
  await start(id);
  await tick();
  let detail = await campaign(id);
  assert.equal(detail.campaign.status, "paused");
  assert.equal(detail.campaign.pause_reason, "action_blocked");
  assert.equal(detail.campaign.pause_detail, "Try Again Later");
  assert.deepEqual(detail.targets[0], { ...detail.targets[0], status: "failed", reason: "blocked_after_send" });
  assert.equal([...fake.browsers.values()][0].status, "stopped");

  await start(id);
  await tick();
  detail = await campaign(id);
  assert.equal(detail.campaign.pause_reason, "logged_out");
  assert.equal(detail.targets[1].status, "pending", "nothing was sent, so it stays in the list");
  assert.equal(detail.targets[1].attempts, 0);
  assert.deepEqual(driver.sent.map((item) => item.username), ["one", "two"]);

  const retried = await h.request(`/api/dm/campaigns/${id}/retry-failed`, { method: "POST", cookie, body: {} });
  assert.equal(retried.data.retried, 1);
  assert.equal(retried.data.campaign.counts.pending, 3);
});

test("messages wait for the campaign's hours and its daily limit", async (t) => {
  const { driver, advance, create, campaign, start, tick } = await setup(t, { now: "2026-10-18T18:00:00Z" });
  const id = (await create({ usernames: "one\ntwo", daily_limit: 1 })).data.campaign.id;
  await start(id);
  await tick();
  assert.equal(driver.sent.length, 0, "23:30 in India is outside 8–23");
  assert.equal(new Date((await campaign(id)).campaign.next_send_at).toISOString(), "2026-10-19T02:30:00.000Z");

  advance(8.5 * 3600000);
  await tick();
  assert.deepEqual(driver.sent.map((item) => item.username), ["one"]);
  advance(10 * 60000);
  await tick();
  assert.equal(driver.sent.length, 1, "daily limit reached");
  const detail = await campaign(id);
  assert.equal(detail.campaign.counts.sent_today, 1);
  assert.equal(new Date(detail.campaign.next_send_at).toISOString(), "2026-10-20T02:30:00.000Z", "next day at 8:00 in India");
});

test("a campaign can send without a proxy, and its proxy can be changed while paused", async (t) => {
  const { h, fake, cookie, create, campaign, start, tick } = await setup(t);
  const id = (await create({ usernames: "one\ntwo", proxy: "none" })).data.campaign.id;
  assert.equal((await campaign(id)).campaign.proxy, "none");
  await start(id, { stop_after: 1 });
  await tick();
  const [first] = [...fake.browsers.values()];
  assert.equal(first.body.proxyCountryCode, null, "no proxy: Browser Use's own connection");

  const updated = await h.request(`/api/dm/campaigns/${id}`, { method: "PUT", cookie, body: { proxy: "in" } });
  assert.equal(updated.data.campaign.proxy, "in");
  assert.equal(updated.data.campaign.gap_minutes, 9, "other settings stay");
  await start(id);
  await tick();
  const second = [...fake.browsers.values()][1];
  assert.equal(second.body.proxyCountryCode, "in");
});

test("each DM uses one version of the message with the creator's username in it", async (t) => {
  const { driver, create, start, tick } = await setup(t);
  const message = "Hi {username}, short offer A\n---\nHello {USERNAME}! short offer B\n  ---  \nHey { name } short offer C";
  const id = (await create({ usernames: "one", message })).data.campaign.id;
  await start(id);
  await tick();
  assert.equal(driver.sent.length, 1);
  assert.equal(driver.sent[0].message, "Hello one! short offer B", "random 0.5 picks the middle version");
  assert.deepEqual(driver.sent[0].previous, ["Hi one, short offer A", "Hello one! short offer B", "Hey one short offer C"]);
  assert.equal((await create({ message: Array.from({ length: 11 }, (_, i) => `v${i}`).join("\n---\n") })).data.error, "invalid_campaign");
});

test("one account runs one campaign at a time; a running campaign cannot be deleted", async (t) => {
  const { h, cookie, create, start } = await setup(t);
  const first = (await create()).data.campaign.id;
  const second = (await create({ name: "Other" })).data.campaign.id;
  assert.equal((await start(first)).status, 200);
  const busy = await start(second);
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error, "profile_busy");
  assert.equal((await h.request(`/api/dm/campaigns/${first}`, { method: "DELETE", cookie })).data.error, "campaign_running");
  assert.equal((await h.request(`/api/dm/campaigns/${first}`, { method: "PUT", cookie, body: { daily_limit: 50 } })).data.error, "campaign_running");
  await h.request(`/api/dm/campaigns/${first}/pause`, { method: "POST", cookie, body: {} });
  await h.app.locals.runDmWorker();
  const updated = await h.request(`/api/dm/campaigns/${first}`, { method: "PUT", cookie, body: { daily_limit: 50, gap_minutes: 12 } });
  assert.equal(updated.data.campaign.daily_limit, 50);
  assert.equal(updated.data.campaign.gap_minutes, 12);
  assert.deepEqual(await h.request(`/api/dm/campaigns/${first}`, { method: "DELETE", cookie }).then((res) => res.data), { ok: true });
  assert.equal((await h.request(`/api/dm/campaigns/${first}`, { cookie })).status, 404);
});

test("after a restart, leftover browsers are stopped and only one copy of the service sends", async (t) => {
  const { h, fake, driver, clock, create, start, tick } = await setup(t);
  const id = (await create({ usernames: "one\ntwo" })).data.campaign.id;
  // An earlier run of the service left a browser open and a message half-done.
  const leftover = crypto.randomUUID();
  fake.browsers.set(leftover, { body: {}, status: "active" });
  await h.db.query("INSERT INTO dm_browsers(id,profile_id,campaign_id) VALUES($1,$2,$3)", [leftover, PROFILE, id]);
  await h.db.query("UPDATE dm_targets SET status='sending' WHERE username='one'");
  // Another copy (the old one during a deploy) still holds the worker lease.
  await h.db.query("INSERT INTO dm_worker_lease(id,owner,expires_at) VALUES(1,'old-copy',$1)", [new Date(clock.now.getTime() + 60000)]);
  await start(id);
  await tick();
  assert.equal(driver.sent.length, 0, "waits while the other copy holds the lease");

  await h.db.query("UPDATE dm_worker_lease SET expires_at=$1", [new Date(clock.now.getTime() - 1000)]);
  await tick();
  assert.equal(fake.browsers.get(leftover).status, "stopped");
  assert.ok(fake.calls.includes(`PATCH /api/v4/browsers/${leftover}`));
  const row = (await h.db.query("SELECT status,proxy_mb::float8 AS mb FROM dm_browsers WHERE id=$1", [leftover])).rows[0];
  assert.deepEqual(row, { status: "stopped", mb: 2 });
  assert.deepEqual(driver.sent.map((item) => item.username), ["one"], "the half-done message is tried again");
});

test("replies: read per account between DMs, answered from the website, checked on request", async (t) => {
  const { h, fake, driver, cookie, advance, create, start, tick } = await setup(t);
  const id = (await create({ usernames: "one\ntwo\nthree", message: "Hi {username}, want details?" })).data.campaign.id;
  const replies = async () => (await h.request("/api/dm/replies", { cookie })).data;
  const account = async () => (await replies()).accounts[0];
  driver.inbox.replies = [{ key: "One|Yes please", name: "One", username: "one", thread: "/direct/t/111/", text: "Yes please", matched: true }];

  // The first DM, then a look at the inbox in the same open browser.
  await start(id);
  await tick();
  assert.deepEqual(driver.sent.map((item) => item.username), ["one"]);
  assert.equal(driver.checks.length, 1);
  assert.deepEqual(driver.checks[0].ours, { one: ["Hi one, want details?"] }, "our DM marks where their reply starts");
  let data = await replies();
  assert.equal(data.accounts.length, 1);
  const { profile_id, name, account: handle, new: fresh, answering, check_status, checking } = data.accounts[0];
  assert.deepEqual({ profile_id, name, handle, fresh, answering, check_status, checking },
    { profile_id: PROFILE, name: "Personal Profile", handle: "aiglow.artlab", fresh: 1, answering: 0, check_status: "ok", checking: false });
  assert.deepEqual(data.replies.map(({ username, text, status, answers }) => ({ username, text, status, answers })),
    [{ username: "one", text: "Yes please", status: "new", answers: [] }]);
  const replyId = data.replies[0].id;

  // The owner answers; the worker sends it from the same account.
  const answer = (message, reply = replyId) => h.request(`/api/dm/replies/${reply}/answer`, { method: "POST", cookie, body: { message } });
  assert.equal((await answer("   ")).data.error, "invalid_answer");
  assert.equal((await answer("x".repeat(1001))).data.error, "invalid_answer");
  assert.equal((await answer("hi", "999999")).data.error, "reply_not_found");
  assert.equal((await answer("Great, here are the details")).status, 200);
  assert.equal((await account()).answering, 1);
  await tick();
  assert.deepEqual(driver.answers, [{ username: "one", thread: "/direct/t/111/", message: "Great, here are the details", repeat: true }]);
  data = await replies();
  assert.equal(data.replies[0].status, "answered");
  assert.deepEqual(data.replies[0].answers.map((item) => [item.message, item.status]), [["Great, here are the details", "sent"]]);
  assert.equal(driver.checks.length, 2, "read again after sending");
  assert.equal(driver.checks[1].found, 0, "a chat that looks the same is not opened again");

  // They write again; the owner asks for a check.
  driver.inbox.replies = [{ key: "One|How much?", name: "One", username: "one", thread: "/direct/t/111/", text: "How much?", matched: true }];
  assert.equal((await h.request("/api/dm/replies/check", { method: "POST", cookie, body: { profile_id: "nope" } })).data.error, "invalid_profile");
  assert.equal((await h.request("/api/dm/replies/check", { method: "POST", cookie, body: { profile_id: crypto.randomUUID() } })).data.error, "profile_not_found");
  const asked = await h.request("/api/dm/replies/check", { method: "POST", cookie, body: { profile_id: PROFILE } });
  assert.equal(asked.data.accounts[0].checking, true);
  await tick();
  assert.deepEqual(driver.checks[2].ours, { one: ["Hi one, want details?", "Great, here are the details"] });
  data = await replies();
  assert.deepEqual([data.replies.length, data.replies[0].text, data.replies[0].status, data.accounts[0].checking], [1, "How much?", "new", false]);

  // An answer that cannot be delivered says why.
  driver.inbox.answerResults["Not found answer"] = { status: "skipped", reason: "not_found" };
  await answer("Not found answer");
  await tick();
  assert.deepEqual((await replies()).replies[0].answers.map((item) => [item.status, item.reason]), [["sent", null], ["failed", "not_found"]]);

  // "Ho gaya" hides it from the new ones.
  const done = await h.request(`/api/dm/replies/${replyId}/done`, { method: "POST", cookie, body: {} });
  assert.deepEqual([done.data.replies[0].status, done.data.accounts[0].new], ["done", 0]);

  // With the campaign paused its browser closes; a check opens one just for
  // replies (same India connection), which closes 3 minutes after.
  await h.request(`/api/dm/campaigns/${id}/pause`, { method: "POST", cookie, body: {} });
  await tick();
  assert.equal([...fake.browsers.values()][0].status, "stopped");
  await h.request("/api/dm/replies/check", { method: "POST", cookie, body: { profile_id: PROFILE } });
  await tick();
  assert.equal(driver.opened.length, 2);
  const second = [...fake.browsers.values()][1];
  assert.deepEqual([second.body.proxyCountryCode, second.body.metadata.purpose, second.status], ["in", "replies", "active"]);
  advance(3 * 60000 + 1000);
  await tick();
  assert.equal(second.status, "stopped");
  assert.ok((await account()).cost_inr > 0, "reply checks show their own cost");

  // A logout seen while reading the inbox stops the account's campaign too.
  await start(id);
  await tick();
  assert.deepEqual(driver.sent.map((item) => item.username), ["one", "two"]);
  driver.inbox.blocked = { status: "blocked", reason: "logged_out", text: null, attempted: false };
  await h.request("/api/dm/replies/check", { method: "POST", cookie, body: { profile_id: PROFILE } });
  await tick();
  const detail = (await h.request(`/api/dm/campaigns/${id}`, { cookie })).data;
  assert.deepEqual([detail.campaign.status, detail.campaign.pause_reason], ["paused", "logged_out"]);
  assert.equal((await account()).check_status, "logged_out");
  assert.equal([...fake.browsers.values()].every((item) => item.status === "stopped"), true);
});
