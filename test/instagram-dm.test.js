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
const FAST = { navigation: 15000, profile: 8000, button: 1500, settle: 100, reclick: 700, chat: 4000, history: 300, send: 4000, search: 1500, poll: 100 };

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script>${SCRIPT}</script></body></html>`;
}
// Opens a chat panel like Instagram's: a header with the username, the old
// messages, and a contenteditable box where Enter sends.
const SCRIPT = `
function bubble(list, text) { const b = document.createElement('div'); b.className = 'bubble'; const s = document.createElement('span'); s.textContent = text; b.append(s); list.append(b); }
function openChat(user, old) {
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
if (window.INBOX) {
  const users = window.INBOX;
  document.querySelector('[data-compose]').addEventListener('click', () => setTimeout(() => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<div>New message</div><div>To:</div><input name="queryBox" placeholder="Search..."><div class="results"></div>' +
      '<div role="button" aria-disabled="true" class="go">Chat</div><div role="button" class="x"><svg aria-label="Close" width="10" height="10"></svg></div>';
    const input = dialog.querySelector('input'), results = dialog.querySelector('.results'), go = dialog.querySelector('.go');
    let chosen = null;
    input.addEventListener('input', () => setTimeout(() => {
      results.innerHTML = '';
      const query = input.value.trim().toLowerCase();
      for (const [name, info] of Object.entries(users)) {
        if (!query || !name.startsWith(query)) continue;
        const row = document.createElement('label');
        row.innerHTML = '<div>' + info.name + '</div><div>' + name + '</div><input type="checkbox">';
        row.addEventListener('click', () => { chosen = name; go.setAttribute('aria-disabled', 'false'); });
        results.append(row);
      }
    }, 150));
    go.addEventListener('click', () => {
      if (go.getAttribute('aria-disabled') === 'true') return;
      dialog.remove();
      for (const old of document.querySelectorAll('section')) old.remove();
      history.pushState(null, '', '/direct/t/' + chosen + '/');
      setTimeout(() => openChat(users[chosen].name, users[chosen].old), 150);
    });
    dialog.querySelector('.x').addEventListener('click', () => dialog.remove());
    document.body.append(dialog);
  }, 100));
}
`;
function profile(user, { button = true, extra = "", setup = "" } = {}) {
  return page(`<script>${setup}</script><header><h2>${user}</h2><span>1,234 followers</span></header>
    ${button ? `<div role="button" tabindex="0" data-open="${user}">मैसेज भेजें</div>` : '<div role="button">Follow</div>'}
    <img src="/picture.png" alt="">${extra}`);
}

function site(requests) {
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
    "/direct/inbox/": page(`<script>window.INBOX = ${JSON.stringify({ alice3: { name: "Alice Three", old: [] }, bob3: { name: "Bob Three", old: [MESSAGE] } })};</script>` +
      '<nav><div role="button" tabindex="0" data-compose><svg aria-label="New message" role="img" width="24" height="24"></svg></div></nav><img src="/picture.png" alt="">')
  };
  return http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/login/") { res.writeHead(302, { location: "/accounts/login/" }); return res.end(); }
    if (req.url === "/picture.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.alloc(64)); }
    const html = pages[req.url];
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
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 20000);
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
  assert.deepEqual(await send("carol3"), { status: "skipped", reason: "not_found" }, "no such account in the search");
  assert.deepEqual(await send("alice3", "A second short hello for alice3"), { status: "sent" });
  await session.idle();
  assert.equal(requests.filter((url) => url === "/direct/inbox/").length, 1, "the inbox page loads once");
  assert.equal(requests.includes("/picture.png"), false);
});
