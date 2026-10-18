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
  notFound: ["Sorry, this page isn't available", "this page isn't available", "यह पेज उपलब्ध नहीं है", "पेज उपलब्ध नहीं"],
  // Direct inbox: the compose icon, the button that opens the chat, and a dialog's close icon.
  newMessage: ["नया मैसेज", "New message", "New Message"],
  chat: ["चैट करें", "Chat", "Next", "चैट", "आगे"],
  close: ["Close", "बंद करें"]
};

// settle: pause after the Message button shows, so Instagram's code is ready
// for the click; reclick: press it again if no chat has opened by then.
// search: how long the inbox search may take to list the username.
const TIMING = { navigation: 45000, profile: 30000, button: 6000, settle: 1500, reclick: 6000, chat: 30000, history: 2500, send: 12000, search: 12000, poll: 700 };

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

// ---- Direct inbox (the "New message" dialog) ----

// Login, security check or limit warning, wherever Instagram shows them.
function inspectPage(labels) {
  const path = location.pathname;
  const body = document.body ? document.body.innerText || "" : "";
  if (path.startsWith("/accounts/login") || document.querySelector('input[name="password"]')) return { state: "logged_out" };
  if (/^\/(challenge|checkpoint|accounts\/suspended|accounts\/disabled|suspended)/.test(path)) return { state: "challenge" };
  for (const phrase of labels.blockedStrong) if (body.includes(phrase)) return { state: "blocked", text: phrase };
  const popups = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"]')]
    .map((el) => el.innerText || "").join("\n").toLowerCase();
  for (const phrase of labels.blockedDialog) if (popups.includes(phrase.toLowerCase())) return { state: "blocked", text: phrase };
  return { state: "ok" };
}

function searchDialog() {
  return [...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.querySelector('input[name="queryBox"]')) || null;
}

// "open" when the New message dialog is up; otherwise presses the compose icon.
function openNewMessage(labels) {
  for (const button of document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="button"]')) {
    if (labels.dismiss.includes((button.innerText || "").trim())) button.click();
  }
  if ([...document.querySelectorAll('[role="dialog"]')].some((d) => d.querySelector('input[name="queryBox"]'))) return "open";
  const icon = [...document.querySelectorAll("svg[aria-label]")].find((svg) => labels.newMessage.includes(svg.getAttribute("aria-label")));
  if (!icon) return "missing";
  (icon.closest('[role="button"],a,button,div[tabindex]') || icon.parentElement).click();
  return "clicked";
}

// Empties and focuses the search box, ready for typing.
function focusSearch() {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[name="queryBox"]'));
  const input = dialog && dialog.querySelector('input[name="queryBox"]');
  if (!input) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return document.activeElement === input;
}

// Selects the search result whose username line is exactly this username.
// The text sits in plain elements; the row around it holds the checkbox (or is
// itself clickable), so walk up from the text to that row and press it.
function pickResult(username) {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[name="queryBox"]'));
  if (!dialog) return "no_dialog";
  const input = dialog.querySelector('input[name="queryBox"]');
  const texts = [...dialog.querySelectorAll("*")]
    .filter((el) => !el.contains(input) && (el.innerText || "").split("\n").some((line) => line.trim().toLowerCase() === username));
  if (!texts.length) return "none";
  texts.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
  const toggle = 'input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]';
  for (let row = texts[0]; row && row !== dialog; row = row.parentElement) {
    if (row.contains(input)) break;
    const box = row.querySelector(toggle);
    if (box) { (box.closest("label") || box).click(); return "picked"; }
    if (row.matches('[role="button"],button,label,[tabindex]')) { row.click(); return "picked"; }
  }
  texts[0].click();
  return "picked";
}

// What the search dialog shows, for the log when a username is not found.
function searchSnapshot() {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[name="queryBox"]'));
  if (!dialog) return "no_dialog";
  const input = dialog.querySelector('input[name="queryBox"]');
  return `typed=${input.value} text=${(dialog.innerText || "").replace(/\s+/g, " ").slice(0, 160)}`;
}

function pressChat(labels) {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[name="queryBox"]'));
  if (!dialog) return "no_dialog";
  const button = [...dialog.querySelectorAll('button,[role="button"]')].find((el) => labels.chat.includes((el.innerText || "").trim()));
  if (!button) return "missing";
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return "disabled";
  button.click();
  return "clicked";
}

function closeSearch(labels) {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[name="queryBox"]'));
  if (!dialog) return true;
  const icon = [...dialog.querySelectorAll("svg[aria-label]")].find((svg) => labels.close.includes(svg.getAttribute("aria-label")));
  if (icon) (icon.closest('[role="button"],button,div[tabindex]') || icon.parentElement).click();
  return Boolean(icon);
}

// The chat opened from the dialog: dialog gone and a message box on screen.
function threadOpen() {
  if ([...document.querySelectorAll('[role="dialog"]')].some((d) => d.querySelector('input[name="queryBox"]'))) return false;
  return [...document.querySelectorAll('div[role="textbox"][contenteditable="true"]')].some((el) => el.getClientRects().length > 0);
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
  return typeAndSend(page, { username, message, previous, labels, timing, inspect: inspectProfile });
}

// With this person's chat open: skips if any version is already there,
// otherwise types the message, presses Enter and waits to see it in the chat.
async function typeAndSend(page, { username, message, previous, labels, timing, inspect }) {
  // Give older messages a moment to load before checking for an earlier send.
  await sleep(timing.history);
  let probe = await page.evaluate(chatProbe, username, previous, message);
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
    const { state, text } = await page.evaluate(inspect, labels, username);
    const stop = stopReason(state);
    if (stop) return { status: "blocked", reason: stop, text: text || null, attempted: true };
    probe = await page.evaluate(chatProbe, username, [message], message);
    if (probe.found && probe.typedEmpty && probe.count > before) return { status: "sent" };
    if (Date.now() > sendDeadline) return { status: "failed", reason: "send_unconfirmed", attempted: true };
  }
}

// Sends from the Direct inbox: New message → search the username → Chat.
// The inbox page loads once per browser; each later DM only fetches the
// search result and the chat, which uses far less data than a profile page.
// "inbox_unavailable" means this screen did not work and the profile route
// can be tried instead.
async function sendDmViaInbox(page, { username, message, previous = [message], baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  const blocked = (state, text, attempted = false) => ({ status: "blocked", reason: stopReason(state), text: text || null, attempted });
  const here = await page.evaluate(() => location.href).catch(() => "");
  if (!here.startsWith(`${baseUrl}/direct/`)) await page.navigate(`${baseUrl}/direct/inbox/`, { timeoutMs: timing.navigation });

  const openDeadline = Date.now() + timing.profile;
  let presses = 0;
  for (;;) {
    const { state, text } = await page.evaluate(inspectPage, labels);
    if (stopReason(state)) return blocked(state, text);
    const step = await page.evaluate(openNewMessage, labels);
    if (step === "open") break;
    if (step === "clicked") presses++;
    if (presses > 3 || Date.now() > openDeadline) return { status: "failed", reason: "inbox_unavailable", detail: `new_message=${step}` };
    await sleep(step === "clicked" ? Math.max(timing.poll, 1500) : timing.poll);
  }
  if (!await page.evaluate(focusSearch)) return { status: "failed", reason: "inbox_unavailable", detail: "search_box" };
  await page.insertText(username);

  const searchDeadline = Date.now() + timing.search;
  for (;;) {
    await sleep(timing.poll);
    const picked = await page.evaluate(pickResult, username);
    if (picked === "picked") break;
    if (picked === "no_dialog") return { status: "failed", reason: "inbox_unavailable", detail: "dialog_closed" };
    if (Date.now() > searchDeadline) {
      const detail = await page.evaluate(searchSnapshot).catch(() => null);
      await page.evaluate(closeSearch, labels).catch(() => false);
      return { status: "skipped", reason: "not_found", ...(detail ? { detail } : {}) };
    }
  }
  const chatDeadline = Date.now() + timing.button;
  for (;;) {
    await sleep(timing.poll);
    const pressed = await page.evaluate(pressChat, labels);
    if (pressed === "clicked") break;
    if (Date.now() > chatDeadline) {
      await page.evaluate(closeSearch, labels).catch(() => false);
      return { status: "failed", reason: pressed === "missing" ? "inbox_unavailable" : "chat_not_opened", detail: `chat_button=${pressed}` };
    }
  }
  const threadDeadline = Date.now() + timing.chat;
  for (;;) {
    await sleep(timing.poll);
    const { state, text } = await page.evaluate(inspectPage, labels);
    if (stopReason(state)) return blocked(state, text);
    if (await page.evaluate(threadOpen)) break;
    if (Date.now() > threadDeadline) {
      const detail = await page.evaluate(describePage, labels).catch(() => null);
      return { status: "failed", reason: "chat_not_opened", ...(detail ? { detail } : {}) };
    }
  }
  return typeAndSend(page, { username, message, previous, labels, timing, inspect: inspectPage });
}

// Connects to a Browser Use browser (its cdpUrl) and returns a session the
// DM worker reuses for many messages, so Instagram's code downloads once.
// method "inbox" (default) sends from the Direct inbox and falls back to the
// profile's Message button when the inbox screen does not work.
function createInstagramDriver({ fetchImpl = fetch, baseUrl, timing = TIMING, method = "inbox" } = {}) {
  return {
    async open(cdpUrl) {
      const connection = await CdpConnection.connect(await resolveWebSocketUrl(cdpUrl, fetchImpl));
      let page;
      try { page = await openPage(connection); } catch (error) { connection.close(); throw error; }
      return {
        alive: () => !connection.closed,
        sendDm: async ({ username, message, previous }) => {
          const options = { username, message, previous, baseUrl, timing };
          if (method !== "inbox") return sendDm(page, options);
          const result = await sendDmViaInbox(page, options);
          if (result.reason !== "inbox_unavailable") return result;
          return { ...(await sendDm(page, options)), fallback: result.detail || "inbox" };
        },
        // Data the page downloaded since the last call (bytes, by resource type).
        usage: () => page.takeUsage(),
        // Profile method: a blank page between messages stops Instagram from using
        // data while waiting. Inbox method: stay in the inbox, so the next DM
        // does not load the whole app again.
        idle: () => (method === "inbox" ? Promise.resolve() : page.navigate("about:blank", { timeoutMs: 15000 }).catch(() => {})),
        close: () => connection.close()
      };
    }
  };
}

module.exports = { createInstagramDriver, sendDm, sendDmViaInbox, LABELS, TIMING, inspectProfile, inspectPage, chatProbe, describePage };
