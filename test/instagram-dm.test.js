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
const FAST = { navigation: 15000, profile: 8000, button: 1500, chat: 5000, history: 300, send: 4000, poll: 100 };

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
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => setTimeout(() => openChat(button.dataset.open, window.OLD), 200));
for (const button of document.querySelectorAll('[data-dismiss]')) button.addEventListener('click', () => button.closest('[role=dialog]').remove());
if (window.PRE_OPEN) openChat(window.PRE_OPEN, []);
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
    "/accounts/login/": page('<form><input name="username"><input name="password" type="password"></form>')
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
  const session = await createInstagramDriver({ baseUrl, timing: FAST }).open(await launchChrome(t));
  t.after(() => session.close());
  const send = (username, message = MESSAGE) => session.sendDm({ username, message });

  // The notification pop-up is closed, the inbox preview ("आप: …") is not taken
  // for an earlier send, and the message lands in the chat.
  assert.deepEqual(await send("alice"), { status: "sent" });
  // Pictures are refused before they download.
  assert.equal(requests.includes("/picture.png"), false);
  assert.deepEqual(await send("bob"), { status: "skipped", reason: "already_in_thread" });
  assert.deepEqual(await send("carol"), { status: "skipped", reason: "no_message_button" });
  assert.deepEqual(await send("ghost"), { status: "skipped", reason: "not_found" });
  assert.deepEqual(await send("twopanel"), { status: "sent" });
  assert.deepEqual(await send("multi", "Line one here please\nLine two here please"), { status: "sent" });
  assert.deepEqual(await send("blockme"), { status: "blocked", reason: "action_blocked", text: "Try Again Later", attempted: true });
  assert.deepEqual(await send("login"), { status: "blocked", reason: "logged_out", text: null, attempted: false });
  await session.idle();
  assert.equal(session.alive(), true);
});
