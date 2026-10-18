"use strict";

// Sends one Instagram DM in an already logged-in cloud browser, with fixed
// steps instead of an AI agent: open the profile, press Message, type the
// text, press Enter and confirm the message shows up in the chat.

const { CdpConnection, openPage, resolveWebSocketUrl, sleep } = require("./cdp");

const LABELS = {
  message: ["Message", "Send message", "मैसेज भेजें", "मैसेज", "संदेश भेजें", "संदेश"],
  dismiss: ["Not Now", "Not now", "अभी नहीं"],
  // Shown anywhere on the page, these mean Instagram is limiting the account.
  blockedStrong: ["Try Again Later", "We restrict certain activity", "Action Blocked", "action was blocked", "temporarily blocked",
    "You can't send messages", "We limit how often", "हम कुछ गतिविधियों", "कुछ गतिविधियों को सीमित"],
  // Only counted inside a pop-up, because the words are common elsewhere.
  blockedDialog: ["try again later", "फिर से कोशिश करें", "प्रतिबंधित", "restricted"],
  notFound: ["Sorry, this page isn't available", "this page isn't available", "यह पेज उपलब्ध नहीं है", "पेज उपलब्ध नहीं"]
};

// settle: pause after the Message button shows, so Instagram's code is ready
// for the click; reclick: press it again if no chat has opened by then.
const TIMING = { navigation: 45000, profile: 30000, button: 6000, settle: 1500, reclick: 6000, chat: 30000, history: 2500, send: 12000, poll: 700 };

// ---- Functions below run inside the browser page (no Node variables). ----

function inspectProfile(labels, username) {
  const path = location.pathname;
  const body = document.body ? document.body.innerText || "" : "";
  if (path.startsWith("/accounts/login") || document.querySelector('input[name="password"]')) return { state: "logged_out" };
  if (/^\/(challenge|checkpoint|accounts\/suspended|accounts\/disabled|suspended)/.test(path)) return { state: "challenge" };
  for (const phrase of labels.blockedStrong) if (body.includes(phrase)) return { state: "blocked", text: phrase };
  const popups = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"]')]
    .map((el) => el.innerText || "").join("\n").toLowerCase();
  for (const phrase of labels.blockedDialog) if (popups.includes(phrase.toLowerCase())) return { state: "blocked", text: phrase };
  const header = document.querySelector("header");
  const named = Boolean(header && (header.innerText || "").toLowerCase().includes(username));
  if (!named && labels.notFound.some((phrase) => body.includes(phrase))) return { state: "not_found" };
  const button = [...document.querySelectorAll('div[role="button"],button')]
    .find((el) => labels.message.includes((el.innerText || "").trim()));
  if (button) return { state: "ready" };
  if (named || /followers|फ़ॉलोअर|फॉलोअर/i.test(body)) return { state: "profile" };
  return { state: "loading" };
}

function clickMessage(labels) {
  const button = [...document.querySelectorAll('div[role="button"],button')]
    .find((el) => labels.message.includes((el.innerText || "").trim()));
  if (!button) return false;
  button.click();
  return true;
}

function dismissDialogs(labels) {
  let clicked = 0;
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    for (const button of dialog.querySelectorAll('button,div[role="button"]')) {
      if (labels.dismiss.includes((button.innerText || "").trim())) { button.click(); clicked++; }
    }
  }
  return clicked;
}

// Finds this person's chat box, marks it, and counts how many messages in that
// chat read exactly like any of `messages` (so a repeat or a successful send can
// be seen); typedOk says the box holds exactly `typedMessage`.
function chatProbe(username, messages, typedMessage) {
  const selector = 'div[role="textbox"][contenteditable="true"]';
  const norm = (value) => (value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const visible = (el) => el.isConnected && el.getClientRects().length > 0;
  const scopeOf = (box) => {
    let scope = box;
    while (scope.parentElement && scope.parentElement !== document.body &&
      scope.parentElement.querySelectorAll(selector).length === 1) scope = scope.parentElement;
    return scope;
  };
  let box = document.querySelector('[data-dm-target="1"]');
  if (!box || !visible(box)) {
    const boxes = [...document.querySelectorAll(selector)].filter(visible);
    if (!boxes.length) return { found: false };
    const user = username.toLowerCase();
    const named = boxes.filter((item) => (scopeOf(item).innerText || "").toLowerCase().includes(user));
    box = named.length === 1 ? named[0] : boxes.length === 1 ? boxes[0] : null;
    if (!box) return { found: false, ambiguous: true };
    for (const old of document.querySelectorAll("[data-dm-target]")) old.removeAttribute("data-dm-target");
    box.setAttribute("data-dm-target", "1");
  }
  const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  const targets = new Set(list.map(norm));
  const shortest = Math.min(...list.map((item) => item.length));
  const longest = Math.max(...list.map((item) => item.length));
  let count = 0;
  for (const el of scopeOf(box).querySelectorAll("div,span")) {
    if (box.contains(el) || el.contains(box)) continue;
    const length = (el.textContent || "").length;
    if (length < shortest * 0.5 || length > longest * 2 + 40) continue;
    if (!targets.has(norm(el.innerText))) continue;
    if ([...el.children].some((child) => targets.has(norm(child.innerText)))) continue;
    count++;
  }
  const typed = norm(box.innerText);
  return { found: true, count, typedEmpty: typed.length === 0, typedOk: typed === norm(typedMessage ?? list[0]) };
}

function focusBox() {
  const box = document.querySelector('[data-dm-target="1"]');
  if (!box) return false;
  box.focus();
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return document.activeElement === box || box.contains(document.activeElement);
}

// A short description of the page for the log when a chat does not open.
function describePage(labels) {
  const count = (selector) => document.querySelectorAll(selector).length;
  const button = [...document.querySelectorAll('div[role="button"],button')].some((el) => labels.message.includes((el.innerText || "").trim()));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 2);
  return `path=${location.pathname} width=${window.innerWidth} editable=${count('[contenteditable="true"]')} ` +
    `textbox=${count('[role="textbox"]')} textarea=${count("textarea")} button=${button}` + (dialogs.length ? ` dialogs=${dialogs.join(" | ")}` : "");
}

function clearBox() {
  const box = document.querySelector('[data-dm-target="1"]');
  if (!box) return false;
  box.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
  return true;
}

// ---- Node side ----

function stopReason(state) {
  return state === "logged_out" || state === "challenge" ? state : state === "blocked" ? "action_blocked" : null;
}

// Result: { status: "sent" } or { status: "skipped" | "failed" | "blocked", reason, text?, attempted? }.
// "attempted" says Enter was pressed, so the message may have gone out.
// previous: every version of the message this person could have been sent; any
// of them already in the chat means skip.
async function sendDm(page, { username, message, previous = [message], baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  await page.navigate(`${baseUrl}/${encodeURIComponent(username)}/`, { timeoutMs: timing.navigation });
  const profileDeadline = Date.now() + timing.profile;
  let profileSeenAt = null;
  for (;;) {
    await page.evaluate(dismissDialogs, labels).catch(() => 0);
    const { state, text } = await page.evaluate(inspectProfile, labels, username);
    const stop = stopReason(state);
    if (stop) return { status: "blocked", reason: stop, text: text || null, attempted: false };
    if (state === "not_found") return { status: "skipped", reason: "not_found" };
    if (state === "ready") break;
    if (state === "profile") {
      profileSeenAt ??= Date.now();
      if (Date.now() - profileSeenAt > timing.button) return { status: "skipped", reason: "no_message_button" };
    }
    if (Date.now() > profileDeadline) return { status: "failed", reason: "profile_timeout" };
    await sleep(timing.poll);
  }
  // The button is drawn before Instagram's code is ready to handle a click, so
  // wait a moment, and press it again if no chat opens.
  // The page can redraw the button while it loads, so look for it a little
  // longer. On some profiles it then disappears for good (messages only from
  // people they follow): that is a skip, not an error.
  await sleep(timing.settle);
  const buttonDeadline = Date.now() + timing.button;
  while (!await page.evaluate(clickMessage, labels)) {
    if (Date.now() > buttonDeadline) return { status: "skipped", reason: "no_message_button" };
    await sleep(timing.poll);
  }
  let clicks = 1;
  let clickedAt = Date.now();

  const chatDeadline = Date.now() + timing.chat;
  let probe;
  for (;;) {
    await sleep(timing.poll);
    await page.evaluate(dismissDialogs, labels).catch(() => 0);
    const { state, text } = await page.evaluate(inspectProfile, labels, username);
    const stop = stopReason(state);
    if (stop) return { status: "blocked", reason: stop, text: text || null, attempted: false };
    probe = await page.evaluate(chatProbe, username, previous, message);
    if (probe.found) break;
    if (Date.now() > chatDeadline) {
      const detail = await page.evaluate(describePage, labels).catch(() => null);
      return { status: "failed", reason: probe.ambiguous ? "chat_ambiguous" : "chat_not_opened", ...(detail ? { detail: `${detail} clicks=${clicks}` } : {}) };
    }
    if (clicks < 3 && Date.now() - clickedAt >= timing.reclick && await page.evaluate(clickMessage, labels)) {
      clicks++;
      clickedAt = Date.now();
    }
  }
  // Give older messages a moment to load before checking for an earlier send.
  await sleep(timing.history);
  probe = await page.evaluate(chatProbe, username, previous, message);
  if (!probe.found) return { status: "failed", reason: "chat_not_opened" };
  if (probe.count > 0) return { status: "skipped", reason: "already_in_thread" };
  if (!probe.typedEmpty) await page.evaluate(clearBox);

  if (!await page.evaluate(focusBox)) return { status: "failed", reason: "focus_failed" };
  const lines = message.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]) await page.insertText(lines[index]);
    if (index < lines.length - 1) await page.pressEnter({ shift: true });
  }
  probe = await page.evaluate(chatProbe, username, [message], message);
  if (!probe.found || !probe.typedOk) {
    await page.evaluate(clearBox).catch(() => false);
    return { status: "failed", reason: "typing_failed" };
  }
  const before = probe.count;
  await page.pressEnter();

  const sendDeadline = Date.now() + timing.send;
  for (;;) {
    await sleep(timing.poll);
    const { state, text } = await page.evaluate(inspectProfile, labels, username);
    const stop = stopReason(state);
    if (stop) return { status: "blocked", reason: stop, text: text || null, attempted: true };
    probe = await page.evaluate(chatProbe, username, [message], message);
    if (probe.found && probe.typedEmpty && probe.count > before) return { status: "sent" };
    if (Date.now() > sendDeadline) return { status: "failed", reason: "send_unconfirmed", attempted: true };
  }
}

// Connects to a Browser Use browser (its cdpUrl) and returns a session the
// DM worker reuses for many messages, so Instagram's code downloads once.
function createInstagramDriver({ fetchImpl = fetch, baseUrl, timing = TIMING } = {}) {
  return {
    async open(cdpUrl) {
      const connection = await CdpConnection.connect(await resolveWebSocketUrl(cdpUrl, fetchImpl));
      let page;
      try { page = await openPage(connection); } catch (error) { connection.close(); throw error; }
      return {
        alive: () => !connection.closed,
        sendDm: ({ username, message, previous }) => sendDm(page, { username, message, previous, baseUrl, timing }),
        // Data the page downloaded since the last call (bytes, by resource type).
        usage: () => page.takeUsage(),
        // A blank page between messages stops Instagram from using data while waiting.
        idle: () => page.navigate("about:blank", { timeoutMs: 15000 }).catch(() => {}),
        close: () => connection.close()
      };
    }
  };
}

module.exports = { createInstagramDriver, sendDm, LABELS, TIMING, inspectProfile, chatProbe, describePage };
