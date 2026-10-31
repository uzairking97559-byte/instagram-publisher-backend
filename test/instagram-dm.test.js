"use strict";

// Drives a real Chromium through lib/cdp.js against small pages that copy how
// Instagram's profile page and chat panel behave. Needs a Chrome/Chromium
// binary: set DM_TEST_CHROME=/path/to/chrome to run it (skipped otherwise).

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInstagramDriver } = require("../lib/instagram-dm");

const CHROME = process.env.DM_TEST_CHROME;
const MESSAGE = "Hey! 👋 We're inviting Instagram page owners to join our Paid Logo Promotion Program! 💰 Earn ₹800 per 1 Million Views. Interested? Reply YES and I'll share the details!";
const FAST = { navigation: 15000, profile: 8000, button: 1500, settle: 100, reclick: 700, chat: 4000, history: 300, send: 4000, search: 1500, dialog: 1000, delivery: 800, poll: 100 };
// Instagram's notice when a message cannot reach someone.
const NOTICE = "This account can't receive your message because they don't allow new message requests from everyone.";

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script>${SCRIPT}</script></body></html>`;
}
// Opens a chat panel like Instagram's: a header with the username, the old
// messages, and a contenteditable box where Enter sends.
const SCRIPT = `
function bubble(list, text) { const b = document.createElement('div'); b.className = 'bubble'; const s = document.createElement('span'); s.textContent = text; b.append(s); list.append(b); }
// closed: the person takes messages only from people they follow; Instagram
// shows the message, then its "can't receive" notice under it.
function openChat(user, old, closed) {
  const panel = document.createElement('section');
  panel.innerHTML = '<div class="chat-head"></div><div class="list"></div><div><div role="textbox" contenteditable="true" aria-label="Message"></div></div>';
  panel.querySelector('.chat-head').textContent = user + ' · Instagram';
  const list = panel.querySelector('.list');
  for (const text of old || []) bubble(list, text);
  const box = panel.querySelector('[role=textbox]');
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const text = box.innerText.trim();
    if (window.BLOCK_ON_SEND) {
      const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'Try Again Later. We restrict certain activity to protect our community.';
      document.body.append(dialog); return;
    }
    setTimeout(() => { bubble(list, text); box.textContent = ''; }, 150);
    if (closed) setTimeout(() => { const n = document.createElement('div'); n.className = 'notice'; n.textContent = window.NOTICE; list.append(n); }, 450);
  });
  document.body.append(panel);
}
// LAZY: like Instagram while its code loads, a click does nothing at first.
// NEVER: the button never opens a chat.
for (const button of document.querySelectorAll('[data-open]')) {
  const attach = () => button.addEventListener('click', () => setTimeout(() => openChat(button.dataset.open, window.OLD), 200));
  if (window.VANISH) setTimeout(() => button.remove(), 50);
  if (window.NEVER) continue;
  if (window.LAZY) setTimeout(attach, 600); else attach();
}
for (const button of document.querySelectorAll('[data-dismiss]')) button.addEventListener('click', () => button.closest('[role=dialog]').remove());
if (window.PRE_OPEN) openChat(window.PRE_OPEN, []);
// INBOX: a Direct inbox whose "New message" dialog searches these users, and
// whose Chat button opens the chat in place (the address changes, no reload).
// Pressing New message again while its window is still loading cancels it.
// INBOX_MODE "dead": the icon does nothing; "slow": the window takes 700 ms
// and its search box has no name; "blank": the search never lists anything.
if (window.INBOX) {
  const users = window.INBOX, mode = window.INBOX_MODE || 'ok';
  let loading = null;
  document.querySelector('[data-compose]').addEventListener('click', () => {
    if (mode === 'dead') return;
    if (loading) { clearTimeout(loading); loading = null; return; }
    loading = setTimeout(() => { loading = null; showDialog(); }, mode === 'slow' ? 700 : 100);
  });
  const showDialog = () => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<div>New message</div><div>To:</div>' + (mode === 'slow' ? '<input placeholder="Search...">' : '<input name="queryBox" placeholder="Search...">') +
      '<div class="results"></div><div role="button" aria-disabled="true" class="go">Chat</div><div role="button" class="x"><svg aria-label="Close" width="10" height="10"></svg></div>';
    const input = dialog.querySelector('input'), results = dialog.querySelector('.results'), go = dialog.querySelector('.go');
    let chosen = null;
    input.addEventListener('input', () => setTimeout(() => {
      results.innerHTML = '';
      const query = input.value.trim().toLowerCase();
      // Like Instagram: a search with no match says so; "blank" mode shows nothing at all.
      if (mode === 'blank') return;
      if (query && !Object.keys(users).some((name) => name.startsWith(query))) { results.innerHTML = '<div>No account found.</div>'; return; }
      for (const [name, info] of Object.entries(users)) {
        if (!query || !name.startsWith(query)) continue;
        // Like Instagram: the names sit in plain divs, the checkbox in its own empty label.
        const row = document.createElement('div');
        row.innerHTML = '<div><div><span>' + info.name + '</span></div><div><span>' + name + '</span></div></div><label><input type="checkbox"></label>';
        row.querySelector('input').addEventListener('change', () => { chosen = name; go.setAttribute('aria-disabled', 'false'); });
        results.append(row);
      }
    }, 150));
    go.addEventListener('click', () => {
      if (go.getAttribute('aria-disabled') === 'true') return;
      dialog.remove();
      if (window.THREADS) { const thread = window.THREADS.find((item) => item.user === chosen); setTimeout(() => openThread(thread.id), 150); return; }
      for (const old of document.querySelectorAll('section')) old.remove();
      history.pushState(null, '', '/direct/t/' + chosen + '/');
      setTimeout(() => openChat(users[chosen].name, users[chosen].old, users[chosen].closed), 150);
    });
    dialog.querySelector('.x').addEventListener('click', () => dialog.remove());
    document.body.append(dialog);
  };
}
// THREADS: Instagram's desktop inbox: a side menu, the chat list (rows of name
// and last-message preview) and the open chat's column, whose header links to
// the person's profile; their messages on the left, ours on the right.
function rowPreview(thread) {
  const last = thread.msgs[thread.msgs.length - 1];
  const text = thread.seen ? 'Seen' : last.me && !thread.plain ? 'You: ' + last.text : last.text;
  return (thread.label ? '• ' + thread.label + ' ' : '') + text + ' · 5m';
}
function renderList() {
  const list = document.querySelector('.list');
  list.querySelectorAll('.row').forEach((row) => row.remove());
  for (const thread of window.THREADS) {
    const row = document.createElement('div'); row.className = 'row'; row.setAttribute('role', 'button'); row.tabIndex = 0;
    row.innerHTML = '<div class="avatar"></div><div><div class="n"></div><div class="pv"></div></div>';
    row.querySelector('.n').textContent = thread.name; row.querySelector('.pv').textContent = rowPreview(thread);
    row.addEventListener('click', () => setTimeout(() => openThread(thread.id), 120));
    list.append(row);
  }
}
function openThread(id) {
  const thread = window.THREADS.find((item) => item.id === id);
  if (location.pathname !== '/direct/t/' + id + '/') history.pushState(null, '', '/direct/t/' + id + '/');
  const pane = document.querySelector('.pane');
  pane.innerHTML = '<div class="head"></div><div class="msgs"></div><div class="composer"><div role="textbox" contenteditable="true" aria-label="Message"></div><div class="ph">Message...</div></div>';
  if (thread.link !== false) pane.querySelector('.head').innerHTML = '<a role="link" href="/' + thread.user + '/"><div>' + thread.name + '</div><div>Active 5m ago</div></a>';
  else pane.querySelector('.head').textContent = thread.name;
  const msgs = pane.querySelector('.msgs');
  const add = (text, me, extra) => { const b = document.createElement('div'); b.className = 'b ' + (me ? 'me' : 'them') + (extra || ''); const t = document.createElement('div'); t.setAttribute('dir', 'auto'); t.textContent = text; b.append(t); msgs.append(b); };
  if (thread.link === false) msgs.innerHTML = '<div class="card"><div>' + thread.name + '</div><a href="/' + thread.user + '/" role="link">View profile</a></div>';
  thread.msgs.forEach((m, i) => {
    if (i === 1) { const d = document.createElement('div'); d.className = 'date'; d.textContent = 'Today 10:45 PM'; msgs.append(d); }
    if (m.notice) { const n = document.createElement('div'); n.className = 'date'; n.textContent = m.text; msgs.append(n); return; }
    add(m.text, m.me);
    if (m.me && i === thread.msgs.length - 1) { const s = document.createElement('div'); s.className = 'seen'; s.textContent = 'Seen'; msgs.append(s); }
  });
  const box = pane.querySelector('[role=textbox]');
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const text = box.innerText.trim();
    setTimeout(() => { thread.msgs.push({ me: true, text }); thread.seen = false; add(text, true); box.textContent = ''; renderList(); }, 150);
  });
}
if (window.THREADS) {
  renderList();
  const parts = location.pathname.split('/');
  if (parts[1] === 'direct' && parts[2] === 't') setTimeout(() => openThread(parts[3]), 200);
}
`;
function profile(user, { button = true, extra = "", setup = "" } = {}) {
  return page(`<script>${setup}</script><header><h2>${user}</h2><span>1,234 followers</span></header>
    ${button ? `<div role="button" tabindex="0" data-open="${user}">मैसेज भेजें</div>` : '<div role="button">Follow</div>'}
    <img src="/picture.png" alt="">${extra}`);
}

// The threads inbox (see THREADS above): who wrote last decides the preview.
const OURS = (user) => `Hi ${user} 👋 You commented on our reel. Want the details?`;
const THREADS = [
  { id: "1", user: "carol", name: "Carol C", msgs: [{ me: true, text: OURS("carol") }, { text: "Yes interested" }, { text: "How to join?" }] },
  { id: "2", user: "dave", name: "Dave D", msgs: [{ me: true, text: OURS("dave") }] },
  { id: "3", user: "erin", name: "Erin E", link: false, msgs: [{ text: "Hello? Anyone there" }] },
  { id: "4", user: "frank", name: "Frank F", msgs: [{ me: true, text: OURS("frank") }, { text: "ok" }] },
  { id: "5", user: "gina", name: "Gina G", seen: true, msgs: [{ me: true, text: OURS("gina") }] },
  { id: "6", user: "hana", name: "Hana H", msgs: [{ me: true, text: OURS("hana") }, { notice: true, text: NOTICE }] },
  // Instagram's label before the preview: still our message last.
  { id: "7", user: "ivy", name: "Ivy I", label: "AI-generated profile", msgs: [{ me: true, text: OURS("ivy") }] },
  // A preview without "You:" although our message is last: opened, then not taken for a reply.
  { id: "8", user: "jack", name: "Jack J", plain: true, msgs: [{ me: true, text: OURS("jack") }] }
];
const THREADS_PAGE = page(`<style>
  body { margin: 0; display: flex; height: 100vh; font: 14px sans-serif; }
  .nav { width: 72px; } .nav a { display: block; width: 40px; height: 40px; margin: 12px; }
  .list { width: 380px; } .list .top { height: 60px; } .row { display: flex; height: 64px; align-items: center; } .avatar { width: 44px; height: 44px; margin: 0 12px; }
  .pane { flex: 1; display: flex; flex-direction: column; } .head { height: 60px; } .head a { display: block; width: 300px; }
  .msgs { flex: 1; display: flex; flex-direction: column; padding: 12px; } .b { max-width: 60%; padding: 8px; margin: 4px 0; }
  .me, .seen { align-self: flex-end; } .them { align-self: flex-start; } .date { align-self: center; } .card { align-self: center; }
  .composer { position: relative; margin: 12px; } .composer [role=textbox] { min-height: 20px; } .ph { position: absolute; left: 4px; top: 0; pointer-events: none; }
</style><script>window.INBOX = ${JSON.stringify(Object.fromEntries(THREADS.map((thread) => [thread.user, { name: thread.name, old: [] }])))};` +
  `window.INBOX_MODE = "ok"; window.THREADS = ${JSON.stringify(THREADS)};</script>` +
  '<div class="nav"><a href="/aiglow.test/" role="link"><span>P</span></a></div>' +
  '<div class="list"><div class="top"><div>aiglow.test</div><div role="button" tabindex="0" data-compose><svg aria-label="New message" role="img" width="24" height="24"></svg></div></div></div>' +
  '<div class="pane"></div>');

function site(requests, inbox = "ok") {
  const pages = {
    "/alice/": profile("alice", {
      extra: `<div role="dialog"><p>Turn on notifications</p><button data-dismiss>Not Now</button></div>
        <div class="inbox-preview">आप: ${MESSAGE}</div>`
    }),
    "/bob/": profile("bob", { setup: `window.OLD = [${JSON.stringify(MESSAGE)}];` }),
    "/carol/": profile("carol", { button: false }),
    "/ghost/": page("<h2>Sorry, this page isn't available.</h2><p>The link you followed may be broken.</p>"),
    "/blockme/": profile("blockme", { setup: "window.BLOCK_ON_SEND = true;" }),
    "/twopanel/": profile("twopanel", { setup: "window.PRE_OPEN = 'someone_else';" }),
    "/multi/": profile("multi"),
    "/lazy/": profile("lazy", { setup: "window.LAZY = true;" }),
    "/nochat/": profile("nochat", { setup: "window.NEVER = true;" }),
    "/vanish/": profile("vanish", { setup: "window.VANISH = true;" }),
    "/accounts/login/": page('<form><input name="username"><input name="password" type="password"></form>'),
    // Instagram's home page for a saved account whose login ended: no password box.
    "/": page('<main><p>aiglow.test</p><button>Continue as aiglow.test</button><a href="/accounts/login/">Switch accounts</a></main>'),
    "/direct/inbox/": page(`<script>window.INBOX = ${JSON.stringify({ alice3: { name: "Alice Three", old: [] }, bob3: { name: "Bob Three", old: [MESSAGE] },
      closed3: { name: "Closed Three", old: [], closed: true } })}; window.NOTICE = ${JSON.stringify(NOTICE)};` +
      `window.INBOX_MODE = ${JSON.stringify(inbox)};</script>` +
      '<nav><div role="button" tabindex="0" data-compose><svg aria-label="New message" role="img" width="24" height="24"></svg></div></nav><img src="/picture.png" alt="">')
  };
  return http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/login/") { res.writeHead(302, { location: "/accounts/login/" }); return res.end(); }
    if (inbox === "gone" && req.url.startsWith("/direct/")) { res.writeHead(302, { location: "/" }); return res.end(); }
    if (req.url === "/picture.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.alloc(64)); }
    const html = inbox === "threads" && req.url.startsWith("/direct/") ? THREADS_PAGE : pages[req.url];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html || "not found");
  });
}

async function launchChrome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-chrome-"));
  const child = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-sandbox",
    "--disable-gpu", "--no-proxy-server", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    // Chrome's helper processes can write to the profile for a moment longer;
    // a leftover temporary folder is harmless.
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

test("sends, skips and stops like the DM worker expects", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const requests = [];
  const server = site(requests);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = await createInstagramDriver({ baseUrl, timing: FAST, method: "profile" }).open(await launchChrome(t));
  t.after(() => session.close());
  const send = (username, message = MESSAGE) => session.sendDm({ username, message });

  // The notification pop-up is closed, the inbox preview ("आप: …") is not taken
  // for an earlier send, and the message lands in the chat.
  assert.deepEqual(await send("alice"), { status: "sent" });
  // Pictures are refused before they download.
  assert.equal(requests.includes("/picture.png"), false);
  assert.deepEqual(await send("bob"), { status: "skipped", reason: "already_in_thread" });
  // Another version of the message is still a repeat when an earlier version is in the chat.
  assert.deepEqual(await session.sendDm({ username: "bob", message: "A different short version", previous: [MESSAGE, "A different short version"] }),
    { status: "skipped", reason: "already_in_thread" });
  assert.deepEqual(await send("carol"), { status: "skipped", reason: "no_message_button" });
  assert.deepEqual(await send("ghost"), { status: "skipped", reason: "not_found" });
  assert.deepEqual(await send("twopanel"), { status: "sent" });
  assert.deepEqual(await send("multi", "Line one here please\nLine two here please"), { status: "sent" });
  // A first click before the page's code is ready is pressed again.
  assert.deepEqual(await send("lazy"), { status: "sent" });
  // A button that disappears as the page loads means no messages: skipped.
  assert.deepEqual(await send("vanish"), { status: "skipped", reason: "no_message_button" });
  // A chat that never opens fails with a description of the page for the log.
  const none = await send("nochat");
  assert.equal(none.status, "failed");
  assert.equal(none.reason, "chat_not_opened");
  assert.match(none.detail, /^path=\/nochat\/ width=1366 editable=0 textbox=0 textarea=0 button=true clicks=3$/);
  assert.deepEqual(await send("blockme"), { status: "blocked", reason: "action_blocked", text: "Try Again Later", attempted: true });
  assert.deepEqual(await send("login"), { status: "blocked", reason: "logged_out", text: null, attempted: false });
  await session.idle();
  assert.equal(session.alive(), true);
  // Downloaded data is counted by type, and the count starts again after reading it.
  const usage = session.usage();
  assert.ok(usage.bytes > 0 && usage.byType.Document > 0);
  assert.equal(session.usage().bytes, 0);
});

test("sends from the Direct inbox, loading the inbox page only once", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const requests = [];
  const server = site(requests);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());
  const send = (username, message = MESSAGE) => session.sendDm({ username, message });

  assert.deepEqual(await send("alice3"), { status: "sent" });
  assert.deepEqual(await send("bob3"), { status: "skipped", reason: "already_in_thread" });
  const missing = await send("carol3");
  assert.deepEqual([missing.status, missing.reason], ["skipped", "not_found"], "no such account in the search");
  assert.match(missing.detail, /^typed=carol3 text=New message/);
  assert.deepEqual(await send("alice3", "A second short hello for alice3"), { status: "sent" });
  // The message shows, then Instagram says it cannot reach them: not a sent DM.
  assert.deepEqual(await send("closed3"), { status: "skipped", reason: "not_delivered" });
  await session.idle();
  assert.equal(requests.filter((url) => url === "/direct/inbox/").length, 1, "the inbox page loads once");
  assert.equal(requests.includes("/picture.png"), false);
});

async function serve(t, inbox) {
  const requests = [];
  const server = site(requests, inbox);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("inbox: waits for a slow New message window and finds a search box with another name", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const { baseUrl } = await serve(t, "slow");
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());

  assert.deepEqual(await session.sendDm({ username: "alice3", message: MESSAGE }), { status: "sent" });
  const missing = await session.sendDm({ username: "carol3", message: MESSAGE });
  assert.deepEqual([missing.status, missing.reason], ["skipped", "not_found"]);
  assert.match(missing.detail, /^typed=carol3 text=New message/);
});

test("inbox: a search that shows nothing at all is a failure to retry, not a missing account", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const { baseUrl } = await serve(t, "blank");
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());

  const blank = await session.sendDm({ username: "alice3", message: MESSAGE });
  assert.deepEqual([blank.status, blank.reason], ["failed", "search_empty"]);
  assert.match(blank.detail, /^typed=alice3 text=New message To: Chat$/);
});

test("inbox: falls back to the profile when New message does not open, and stops trying after two misses", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const { requests, baseUrl } = await serve(t, "dead");
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());
  const send = (username) => session.sendDm({ username, message: MESSAGE });

  const first = await send("alice");
  assert.equal(first.status, "sent");
  // The log says what the inbox showed.
  assert.match(first.fallback, /^new_message=waiting presses=3 path=\/direct\/inbox\/ icons=1\/1 compose=0 dialogs=0$/);
  const second = await send("bob");
  assert.deepEqual([second.status, second.reason, Boolean(second.fallback)], ["skipped", "already_in_thread", true]);
  // Two misses in a row: the profile route straight away.
  assert.deepEqual(await send("twopanel"), { status: "sent" });
  assert.equal(requests.filter((url) => url === "/direct/inbox/").length, 2);
  await session.idle();
  assert.equal(session.alive(), true);
});

test("replies: reads who wrote back and what, and sends the owner's answers", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const { requests, baseUrl } = await serve(t, "threads");
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());
  const sentTo = { carol: [OURS("carol")], frank: [OURS("frank")], hana: [OURS("hana")], ivy: [OURS("ivy")], jack: [OURS("jack")] };

  const check = await session.readReplies({
    outgoing: async (username) => sentTo[username] || [],
    known: async (key) => key.startsWith("Frank F|")
  });
  assert.equal(check.status, "ok");
  assert.equal(check.account, "aiglow.test");
  // Carol, Erin and Frank wrote last, Hana's chat ends in Instagram's notice;
  // Dave's preview is ours, Gina's says Seen, Ivy's has a label before "You:";
  // Jack's looks like theirs until the chat shows our message last.
  assert.deepEqual([check.rows, check.waiting, check.skipped], [8, 5, 1]);
  assert.match(check.detail, /ours_last/);
  assert.match(check.detail, /^O:You: Hi dave \| T:Yes interes|T:How to join/);
  assert.deepEqual(check.replies.map(({ key, ...reply }) => reply), [
    // Only what came after our message: not the date, our "Seen" or the box's placeholder.
    { name: "Carol C", username: "carol", thread: "/direct/t/1/", text: "Yes interested\nHow to join?", matched: true, kind: "reply" },
    // No message of ours to start from: the list's preview. Username from "View profile".
    { name: "Erin E", username: "erin", thread: "/direct/t/3/", text: "Hello? Anyone there", matched: false, kind: "reply" },
    // Not a reply: our DM never reached Hana.
    { name: "Hana H", username: "hana", thread: "/direct/t/6/", text: NOTICE, matched: true, kind: "undelivered" }
  ]);
  assert.equal(check.replies[0].key, "Carol C|How to join?");

  // An answer goes by the chat's address when the username is not known, and
  // is sent even if the same words are already there ("ok")…
  assert.deepEqual(await session.sendReply({ thread: "/direct/t/4/", message: "ok" }), { status: "sent" });
  // …and through the inbox search when it is (no page load).
  assert.deepEqual(await session.sendReply({ username: "carol", message: "Great! Here are the details" }), { status: "sent" });
  assert.equal(requests.filter((url) => url.startsWith("/direct/")).length, 2, "the inbox once, then the chat address");

  // After our answer Carol's chat shows our message last and is not listed again.
  const again = await session.readReplies({ outgoing: async (username) => sentTo[username] || [], known: async () => false });
  assert.deepEqual(again.replies.map((reply) => reply.username), ["erin", "hana"]);
});

test("inbox: sent away to the home page means no login, not an empty inbox", { skip: !CHROME && "set DM_TEST_CHROME to run" }, async (t) => {
  const { requests, baseUrl } = await serve(t, "gone");
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());

  assert.deepEqual(await session.readReplies({ outgoing: async () => [], known: async () => false }),
    { status: "blocked", reason: "logged_out", text: null, attempted: false });
  // A campaign stops too, instead of trying the profile route on a logged-out page.
  assert.deepEqual(await session.sendDm({ username: "alice", message: MESSAGE }),
    { status: "blocked", reason: "logged_out", text: null, attempted: false });
  assert.equal(requests.includes("/alice/"), false);
});
