"use strict";

// Drives a real Chromium through lib/instagram-finder.js against a small site
// that answers like Instagram's web app (profile JSON, "Similar accounts" JSON
// and profile pages). Needs Chrome: set DM_TEST_CHROME=/path/to/chrome.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createFinderDriver } = require("../lib/instagram-finder");

const CHROME = process.env.DM_TEST_CHROME;
const FAST = { navigation: 15000, settle: 100, similar: 3000, poll: 150 };
const APP_ID = "1234567890123";
const DAY = 86400000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// A post's link code for a moment in time, the way Instagram makes them.
function shortcode(ms) {
  let id = BigInt(ms - 1314220021721) << 23n;
  let code = "";
  while (id > 0n) { code = ALPHABET[Number(id % 64n)] + code; id /= 64n; }
  return code;
}

const now = Date.now();
const recent = Math.floor((now - 2 * DAY) / 1000);
const older = Math.floor((now - 20 * DAY) / 1000);
const media = (count, ...nodes) => ({ count, edges: nodes.map((node) => ({ node })) });
const USERS = {
  alice: { id: "111", username: "alice", full_name: "Alice Memes", biography: "Daily memes 😂", is_private: false, is_professional_account: true, is_verified: false,
    category_name: "Digital creator", edge_followed_by: { count: 52000 }, edge_follow: { count: 120 },
    edge_owner_to_timeline_media: media(340, { taken_at_timestamp: older, is_video: true, video_view_count: 1000 },
      { taken_at_timestamp: recent, is_video: true, video_view_count: 3000 }, { taken_at_timestamp: older, is_video: false }),
    edge_related_profiles: { edges: [] } },
  bob: { id: "222", username: "bob", full_name: "Bob", is_private: false, is_business_account: true, edge_followed_by: { count: 8000 }, edge_follow: { count: 10 },
    edge_owner_to_timeline_media: media(12), edge_related_profiles: { edges: [{ node: { username: "dave" } }, { node: { username: "Erin" } }] } },
  secret: { id: "333", username: "secret", is_private: true, edge_followed_by: { count: 900 }, edge_follow: { count: 50 }, edge_owner_to_timeline_media: media(4) }
};
const CHAIN = { 111: ["bob", "carol", "alice", "explore", "bad name!"] };

function page(title, body, head = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}
// A profile page like Instagram's: header with the counts, a grid of post
// links and the "Similar accounts" arrow, whose list appears when pressed.
function profilePage(user, codes) {
  return page(`${user} • Instagram`,
    `<nav><a href="/explore/">Explore</a><a href="/${user}/">Profile</a></nav>
     <main><header><h2>${user}</h2><ul><li><span>1,234</span> posts</li><li><span>12.5K</span> followers</li><li><span>300</span> following</li></ul>
       <div role="button" tabindex="0" id="similar"><svg aria-label="Similar accounts" width="10" height="10"></svg></div>
       <a href="/friend_in_bio/">@friend_in_bio</a></header>
       <div id="list"></div>
       <div class="grid">${codes.map((code) => `<a href="/${user}/p/${code}/">post</a>`).join("")}</div></main>
     <script>
       document.getElementById('similar').addEventListener('click', () => setTimeout(() => {
         document.getElementById('list').innerHTML = ['sim_one', 'sim_two', 'sim_three', '${user}', 'sim_four'].map((name) => '<a href="/' + name + '/">' + name + '</a>').join('');
       }, 200));
     </script>`,
    `<meta property="og:description" content="12K Followers, 300 Following, 1,234 Posts - See Instagram photos">`);
}

function site(requests) {
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ path: url.pathname + url.search, appId: req.headers["x-ig-app-id"] || null });
    if (url.pathname === "/api/v1/users/web_profile_info/") {
      const username = url.searchParams.get("username");
      if (USERS[username]) return json(res, 200, { data: { user: USERS[username] }, status: "ok" });
      if (username === "limited") return json(res, 429, { message: "Please wait a few minutes before you try again.", status: "fail" });
      if (username === "gone") return json(res, 401, { message: "login_required", status: "fail" });
      if (username === "checkme") return json(res, 400, { message: "checkpoint_required", checkpoint_url: "/challenge/123/", status: "fail" });
      if (username === "broken") { res.writeHead(500, { "content-type": "text/html" }); return res.end("<html>oops</html>"); }
      return json(res, 404, {});
    }
    if (url.pathname === "/api/v1/discover/chaining/") return json(res, 200, { users: (CHAIN[url.searchParams.get("target_id")] || []).map((username) => ({ username })) });
    if (url.pathname === "/alice/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(profilePage("alice", []).replace("</head>", `<script type="application/json">{"appId":"${APP_ID}"}</script></head>`));
    }
    if (url.pathname === "/broken/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(profilePage("broken", [shortcode(now - 30 * DAY), shortcode(now - 3 * DAY), shortcode(now - 10 * DAY)]));
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Page not found • Instagram", "<h2>Sorry, this page isn't available.</h2>"));
  });
}

async function launchChrome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finder-chrome-"));
  const child = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-sandbox",
    "--disable-gpu", "--no-proxy-server", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 60000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}

test("reads profiles and similar accounts from Instagram's own JSON, and the page when that fails", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const requests = [];
  const server = site(requests);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = await createFinderDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());

  // The first profile opens its page once; its numbers come from the JSON,
  // sent with the app ID the page carries, and similar accounts from "chaining".
  const alice = await session.readProfile("alice");
  assert.deepEqual(alice, {
    state: "ok", source: "api", username: "alice", name: "Alice Memes", followers: 52000, following: 120, posts: 340,
    private: false, professional: true, verified: false, category: "Digital creator", bio: "Daily memes 😂",
    last_post_at: recent * 1000, avg_views: 2000, related: ["bob", "carol"]
  });
  assert.ok(requests.filter((item) => item.path.startsWith("/api/")).every((item) => item.appId === APP_ID));

  // Similar accounts already in the profile JSON need no second request.
  const bob = await session.readProfile("bob");
  assert.deepEqual([bob.followers, bob.professional, bob.last_post_at, bob.avg_views, bob.related], [8000, true, null, null, ["dave", "erin"]]);
  assert.equal(requests.some((item) => item.path === "/api/v1/discover/chaining/?target_id=222"), false);
  const secret = await session.readProfile("secret");
  assert.deepEqual([secret.state, secret.private, secret.related], ["ok", true, []]);
  assert.deepEqual(await session.readProfile("ghost"), { state: "not_found" });
  assert.deepEqual(await session.readProfile("limited"), { state: "rate_limited" });
  assert.deepEqual(await session.readProfile("gone"), { state: "logged_out" });
  assert.deepEqual(await session.readProfile("checkme"), { state: "challenge" });
  // Only alice's page loaded: everything else was a few kilobytes of JSON.
  assert.deepEqual(requests.filter((item) => !item.path.startsWith("/api/") && item.path !== "/favicon.ico").map((item) => item.path), ["/alice/"]);

  // The JSON fails: the profile page gives the counts, the newest post's date
  // (from its link) and, after pressing the arrow, the similar accounts.
  const broken = await session.readProfile("broken");
  assert.equal(broken.state, "ok");
  assert.equal(broken.source, "page");
  assert.deepEqual([broken.followers, broken.following, broken.posts, broken.private], [12500, 300, 1234, false]);
  assert.ok(Math.abs(broken.last_post_at - (now - 3 * DAY)) < 1000, "newest post from the link codes");
  assert.deepEqual(broken.related, ["sim_one", "sim_two", "sim_three", "sim_four"]);
  assert.equal(broken.detail, "status 500");

  assert.equal(session.alive(), true);
  assert.ok(session.usage().bytes > 0);
});
