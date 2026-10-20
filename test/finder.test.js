"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");

const KEY = "test-browser-use-key";
const FINDER = "6b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const DM_PROFILE = "35a603c8-5ea3-415e-a626-eb4d530cdcb4";
const DAY = 86400000;

// Browser Use's REST API: each browser costs a little proxy data, and stopping
// one settles its browser time.
function browserUseFake() {
  const browsers = new Map();
  const calls = [];
  const run = async (url, init = {}) => {
    assert.equal(url.hostname, "api.browser-use.com", "only Browser Use is called");
    calls.push(`${init.method || "GET"} ${url.pathname}`);
    if (init.headers?.["X-Browser-Use-API-Key"] !== KEY) return json({ detail: "invalid key" }, 401);
    if (url.pathname === "/api/v4/browsers" && init.method === "POST") {
      const id = crypto.randomUUID();
      browsers.set(id, { body: JSON.parse(init.body), status: "active" });
      return json({ id, status: "active", cdpUrl: `wss://cdp.test/${id}`, proxyUsedMb: "0", proxyCost: "0", browserCost: "0.06" }, 201);
    }
    const match = url.pathname.match(/^\/api\/v4\/browsers\/([0-9a-f-]{36})$/);
    if (match) {
      const browser = browsers.get(match[1]);
      if (!browser) return json({ detail: "not found" }, 404);
      if (init.method === "PATCH") browser.status = "stopped";
      return json({ id: match[1], status: browser.status, proxyUsedMb: "1", proxyCost: "0.005", browserCost: browser.status === "stopped" ? "0.003" : "0.06" });
    }
    throw new Error(`Unexpected Browser Use route ${url.pathname}`);
  };
  return { run, browsers, calls };
}

// Stands in for lib/instagram-finder.js: answers per username.
function fakeFinder(clock, profiles) {
  const reads = [];
  const opened = [];
  return {
    reads, opened,
    async open(cdpUrl) {
      opened.push(cdpUrl);
      let alive = true;
      return {
        alive: () => alive,
        readProfile: async (username) => {
          reads.push(username);
          const profile = profiles[username];
          if (!profile) return { state: "not_found" };
          if (profile.state) return { ...profile };
          const { daysAgo, ...rest } = profile;
          return { state: "ok", source: "api", username, name: username.toUpperCase(), following: 10, posts: 50, private: false,
            professional: true, verified: false, category: null, bio: null, avg_views: null, related: [],
            last_post_at: daysAgo === undefined ? null : clock.now.getTime() - daysAgo * DAY, ...rest };
        },
        usage: () => ({ bytes: 30 * 1024, byType: {} }),
        close: () => { alive = false; }
      };
    }
  };
}

const PROFILES = {
  seed1: { followers: 50000, daysAgo: 2, avg_views: 9000, related: ["a1", "a2", "a3", "small", "shared"] },
  seed2: { followers: 20000, daysAgo: 1, related: ["shared", "b1"] },
  shared: { followers: 15000, daysAgo: 5, avg_views: 12000, related: ["seed1"] },
  a1: { followers: 30000, daysAgo: 3, related: ["deep1", "shared"] },
  a2: { followers: 5000, daysAgo: 1, related: ["never"] }, // too small: its similar accounts are not followed
  a3: { followers: 40000, daysAgo: 90 }, // has not posted in a while
  small: { followers: 900, private: true },
  deep1: { followers: 12000, daysAgo: 1, related: ["deeper"] }, // the run's last level: not followed further
  limited_seed: { state: "rate_limited" }
};

async function setup(t) {
  const clock = { now: new Date("2026-10-20T06:30:00.000Z") }; // 12:00 in India
  const fake = browserUseFake();
  const driver = fakeFinder(clock, PROFILES);
  const events = [];
  const h = await harness(t, {
    env: { BROWSER_USE_API_KEY: KEY },
    meta: fake.run,
    dmOptions: { intervalMs: 0, now: () => clock.now },
    finderOptions: { intervalMs: 0, driver, now: () => clock.now, random: () => 0.5, onEvent: (event, details) => events.push([event, details]) }
  });
  const cookie = await h.login();
  const call = (path, method = "GET", body) => h.request(path, { method, cookie, ...(body !== undefined ? { body } : {}) });
  const tick = () => h.app.locals.runFinderWorker();
  const advance = (ms) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { h, clock, fake, driver, events, call, tick, advance };
}

const RUN = { name: "Memes", profile_id: FINDER, profile_name: "Finder", min_followers: 10000, max_followers: "", active_days: 30, depth: 2,
  daily_limit: 100, gap_seconds: 60, start_hour: 9, end_hour: 23, proxy: "in", warmup: true };

test("the finder reads seeds, follows similar accounts of the ones that fit, and keeps a list to review", async (t) => {
  const { call, tick, advance, driver, fake, h } = await setup(t);
  assert.equal((await call("/api/finder", "POST", { ...RUN, name: "" , seeds: "seed1" })).data.error, "invalid_finder");
  assert.equal((await call("/api/finder", "POST", { ...RUN, max_followers: 500, seeds: "seed1" })).data.error, "invalid_finder");
  assert.equal((await call("/api/finder", "POST", { ...RUN, seeds: "!!!" })).data.error, "invalid_seeds");
  const created = await call("/api/finder", "POST", { ...RUN, seeds: "seed1\n@seed2\nhttps://www.instagram.com/seed1/" });
  assert.equal(created.status, 201);
  assert.equal(created.data.seeds, 2);
  const run = created.data.run;
  assert.deepEqual([run.status, run.pause_reason, run.counts.total, run.counts.seeds, run.max_followers], ["paused", "not_started", 2, 2, null]);
  // Warm-up: a new finder account reads at most 50 profiles a day.
  assert.equal(run.today_limit, 50);
  const id = run.id;

  // A test of 4 profiles: seeds first, then the most-mentioned similar account.
  const started = await call(`/api/finder/${id}/start`, "POST", { stop_after: 4 });
  assert.equal(started.data.run.status, "running");
  await tick();
  assert.deepEqual(driver.reads, ["seed1"]);
  assert.equal(fake.calls.filter((item) => item === "POST /api/v4/browsers").length, 1);
  const browser = [...fake.browsers.values()][0].body;
  assert.deepEqual([browser.profileId, browser.proxyCountryCode, browser.metadata.app], [FINDER, "in", "creator-finder"]);
  await tick();
  assert.deepEqual(driver.reads, ["seed1"], "waits the gap between profiles");
  for (let index = 0; index < 3; index++) { advance(61000); await tick(); }
  assert.deepEqual(driver.reads, ["seed1", "seed2", "shared", "a1"]);
  let detail = (await call(`/api/finder/${id}`)).data;
  assert.equal(detail.run.status, "paused");
  assert.equal(detail.run.pause_reason, "test_done");
  assert.equal(detail.run.counts.read_today, 4);
  // The browser closes once the run stops (its login is saved).
  assert.ok(fake.calls.some((item) => item.startsWith("PATCH /api/v4/browsers/")));
  assert.ok(detail.run.cost.inr > 0);
  assert.notEqual(detail.run.cost.per_100_inr, null);
  // Fitting creators, most average views first.
  assert.deepEqual(detail.candidates.map((row) => row.username), ["shared", "seed1", "a1", "seed2"]);
  assert.deepEqual(detail.candidates.map((row) => row.match), [true, true, true, true]);
  const queue = (await call(`/api/finder/${id}?filter=queue`)).data.candidates;
  assert.deepEqual(queue.map((row) => [row.username, row.depth]), [["a2", 1], ["a3", 1], ["small", 1], ["b1", 1], ["deep1", 2]]);
  const shared = (await call(`/api/finder/${id}?filter=all`)).data.candidates.find((row) => row.username === "shared");
  assert.deepEqual([shared.mentions, shared.via], [3, "seed1"]);

  // The rest of the list: a profile that does not fit is kept but not followed further.
  await call(`/api/finder/${id}/start`, "POST", {});
  for (let index = 0; index < 8; index++) { advance(61000); await tick(); }
  assert.deepEqual(driver.reads, ["seed1", "seed2", "shared", "a1", "a2", "a3", "small", "b1", "deep1"]);
  detail = (await call(`/api/finder/${id}`)).data;
  assert.equal(detail.run.status, "completed");
  assert.deepEqual({ ...detail.run.counts, read_today: 0 }, { total: 9, seeds: 2, pending: 0, read: 8, matched: 5, approved: 0, rejected: 0, missing: 1, read_today: 0 });
  assert.deepEqual((await call(`/api/finder/${id}?filter=other`)).data.candidates.map((row) => row.username).sort(), ["a2", "a3", "small"]);
  assert.deepEqual((await call(`/api/finder/${id}?filter=missing`)).data.candidates.map((row) => row.username), ["b1"]);

  // Review: approved first, rejected ones leave the list to copy.
  assert.equal((await call(`/api/finder/${id}/review`, "POST", { username: "a1", review: "maybe" })).data.error, "invalid_review");
  await call(`/api/finder/${id}/review`, "POST", { username: "@a1", review: "approved" });
  const reviewed = await call(`/api/finder/${id}/review`, "POST", { username: "shared", review: "rejected" });
  assert.deepEqual([reviewed.data.run.counts.matched, reviewed.data.run.counts.approved, reviewed.data.run.counts.rejected], [4, 1, 1]);
  assert.deepEqual((await call(`/api/finder/${id}/usernames?filter=approved`)).data.usernames, ["a1"]);
  assert.deepEqual((await call(`/api/finder/${id}/usernames`)).data.usernames, ["a1", "seed1", "seed2", "deep1"]);

  // Changing the filters works out again which read profiles fit.
  const updated = await call(`/api/finder/${id}`, "PUT", { min_followers: 25000 });
  assert.equal(updated.data.run.counts.matched, 2);
  assert.deepEqual((await call(`/api/finder/${id}/usernames`)).data.usernames, ["a1", "seed1"]);

  // Status and today's numbers.
  const status = (await call("/api/finder")).data;
  assert.equal(status.configured, true);
  assert.equal(status.runs.length, 1);
  assert.equal(status.today.read, 9);
  assert.ok(status.today.cost_inr > 0);
  assert.ok(h.logs.some((entry) => entry.event === "finder_run_completed" && entry.found === 5));
});

test("a recent reading is reused, and an Instagram limit pauses the search and lowers the warm-up", async (t) => {
  const { call, tick, advance, driver, events } = await setup(t);
  const first = (await call("/api/finder", "POST", { ...RUN, seeds: "a1" })).data.run.id;
  await call(`/api/finder/${first}/start`, "POST", { stop_after: 1 });
  await tick();
  assert.deepEqual(driver.reads, ["a1"]);
  assert.deepEqual(events.map(([event, details]) => [event, details.reason]), [["finder_paused", "test_done"]]);

  // Another search with the same account: a1 is copied from the first one.
  const second = (await call("/api/finder", "POST", { ...RUN, name: "Second", seeds: "a1\nlimited_seed" })).data.run.id;
  // One search at a time per account (the first, running outside its hours, reads nothing).
  await call(`/api/finder/${first}`, "PUT", { start_hour: 0, end_hour: 1 });
  assert.equal((await call(`/api/finder/${first}/start`, "POST", {})).status, 200);
  await tick();
  assert.equal((await call(`/api/finder/${second}/start`, "POST", {})).data.error, "profile_busy");
  await call(`/api/finder/${first}/pause`, "POST", {});
  await call(`/api/finder/${second}/start`, "POST", {});
  advance(61000);
  await tick();
  await tick();
  assert.deepEqual(driver.reads, ["a1", "limited_seed"], "a1 was not read again");
  const detail = (await call(`/api/finder/${second}?filter=all`)).data;
  assert.equal(detail.run.status, "paused");
  assert.equal(detail.run.pause_reason, "rate_limited");
  const rows = Object.fromEntries(detail.candidates.map((row) => [row.username, row]));
  assert.deepEqual([rows.a1.status, rows.a1.match, rows.limited_seed.status], ["done", true, "pending"]);
  // a1 is a seed here, so its similar accounts joined this search too.
  assert.deepEqual([rows.deep1?.depth, rows.shared?.depth], [1, 1]);
  assert.deepEqual(events.at(-1), ["finder_paused", { name: "Second", reason: "rate_limited", detail: null }]);
  // After an Instagram warning the account starts again lower.
  assert.equal(detail.run.today_limit, 25);
  // A running search cannot be deleted; a paused one can.
  await call(`/api/finder/${first}/start`, "POST", {});
  await tick();
  assert.equal((await call(`/api/finder/${first}`, "DELETE")).data.error, "finder_running");
  assert.equal((await call(`/api/finder/${second}`, "DELETE")).data.ok, true);
  assert.deepEqual(driver.reads, ["a1", "limited_seed"]);
});

test("the finder and the DM sender never share an Instagram login", async (t) => {
  const { call } = await setup(t);
  const campaign = await call("/api/dm/campaigns", "POST", { name: "DMs", profile_id: DM_PROFILE, message: "Hi {username}", usernames: "someone",
    daily_limit: 20, gap_minutes: 9, start_hour: 9, end_hour: 23, proxy: "in", requested_contact: true });
  assert.equal(campaign.status, 201);
  assert.equal((await call("/api/finder", "POST", { ...RUN, profile_id: DM_PROFILE, seeds: "seed1" })).data.error, "profile_is_dm");
  const run = (await call("/api/finder", "POST", { ...RUN, seeds: "seed1" })).data.run;
  assert.equal((await call(`/api/finder/${run.id}`, "PUT", { profile_id: DM_PROFILE })).data.error, "profile_is_dm");
  const other = await call("/api/dm/campaigns", "POST", { name: "Wrong", profile_id: FINDER, message: "Hi {username}", usernames: "someone",
    daily_limit: 20, gap_minutes: 9, start_hour: 9, end_hour: 23, proxy: "in", requested_contact: true });
  assert.equal((await call(`/api/dm/campaigns/${other.data.campaign.id}/start`, "POST", {})).data.error, "profile_is_finder");
});
