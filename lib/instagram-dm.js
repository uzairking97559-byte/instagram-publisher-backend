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
  // Direct inbox: the compose icon (or the empty inbox's button), the button that
  // opens the chat, and a dialog's close icon.
  newMessage: ["नया मैसेज", "New message", "New Message"],
  compose: ["Send message", "मैसेज भेजें", "Send Message"],
  chat: ["चैट करें", "Chat", "Next", "चैट", "आगे"],
  close: ["Close", "बंद करें"],
  // The New message search's own words: its title and the To: label. A search
  // showing nothing but these (no names, no "no results" line) did not run.
  searchFrame: ["To:", "प्रति:", "To", "प्रति", "Search...", "खोजें...", "Search", "खोजें"],
  // Instagram's answer in the search when it is limiting the account: a rate
  // limit, so the campaign pauses (searching on would only make it worse).
  searchError: ["Something went wrong", "Try again later", "कुछ गलत हो गया", "बाद में फिर से कोशिश करें", "बाद में दोबारा कोशिश करें"],
  noResults: ["No account found", "No results found", "No results", "No users found", "कोई परिणाम नहीं मिला", "कोई अकाउंट नहीं मिला", "कोई खाता नहीं मिला"],
  // Inbox list: a preview starting like this means this account wrote last.
  ownPreview: ["You:", "You sent", "You replied", "You reacted", "You liked", "You unsent", "आप:", "आपने", "Seen", "Sent", "Delivered", "देखा गया", "भेजा गया"],
  // Lines in a chat that are not messages (times, read receipts, typing).
  chatNoise: ["Seen", "Sent", "Delivered", "Typing...", "Typing…", "Today", "Yesterday", "Active now", "Edited", "देखा गया", "भेजा गया", "आज", "कल", "अभी सक्रिय", "संपादित"],
  // Instagram's notice in a chat when the message did not reach the person
  // (they take new messages only from people they follow, or limit messages).
  notDelivered: ["नहीं भेजा जा सकता", "नहीं भेजा जा सका", "भेजा नहीं जा सका", "मैसेज पाने की परमिशन", "can't be sent", "couldn't be sent",
    "can't receive your message", "isn't receiving messages", "not accepting messages", "allow new message requests", "couldn't send", "not delivered"]
};

// True when this text is Instagram's "message not delivered" notice.
function isUndelivered(text, labels = LABELS) {
  const lower = String(text || "").toLowerCase();
  return labels.notDelivered.some((phrase) => lower.includes(phrase.toLowerCase()));
}

// Paths that are Instagram pages, not people.
const NOT_PROFILES = ["direct", "explore", "reels", "reel", "p", "tv", "stories", "accounts", "about", "legal", "developer", "m", "web", "challenge", "notifications"];

// settle: pause after the Message button shows, so Instagram's code is ready
// for the click; reclick: press it again if no chat has opened by then.
// search: how long the inbox search may take to list the username.
// dialog: after pressing New message, how long to wait for its window before
// pressing again (the window's code downloads on first use).
// delivery: after a message shows in the chat, how long to watch for
// Instagram's "could not be sent" notice.
const TIMING = { navigation: 45000, profile: 30000, button: 6000, settle: 1500, reclick: 6000, chat: 30000, history: 2500, send: 12000, search: 12000, dialog: 8000, delivery: 2500, poll: 700 };

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

// The New message window is found by its search box: input name "queryBox",
// or (marked by openNewMessage) a search box in a window titled New message.
const SEARCH_BOX = '[role="dialog"] input[name="queryBox"],[role="dialog"] input[data-dm-search]';

// "open" when the New message window is up. Otherwise, when press is set,
// presses the compose icon (on later presses the empty inbox's Send message
// button, if there is one) and says "clicked"; "missing" when neither is shown.
function openNewMessage(labels, press, selector) {
  const visible = (el) => el.getClientRects().length > 0;
  for (const button of document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="button"]')) {
    if (labels.dismiss.includes((button.innerText || "").trim())) button.click();
  }
  if (document.querySelector(selector)) return "open";
  for (const dialog of document.querySelectorAll('[role="dialog"]')) {
    const text = (dialog.innerText || "").toLowerCase();
    if (!labels.newMessage.some((label) => text.includes(label.toLowerCase()))) continue;
    const input = [...dialog.querySelectorAll("input")].find((el) => visible(el) && !["checkbox", "radio", "hidden"].includes(el.type));
    if (input) { input.setAttribute("data-dm-search", "1"); return "open"; }
  }
  if (!press) return "waiting";
  const icons = [...document.querySelectorAll("svg[aria-label]")].filter((svg) => labels.newMessage.includes(svg.getAttribute("aria-label")));
  const targets = [];
  const icon = icons.find(visible) || icons[0];
  if (icon) targets.push(icon.closest('[role="button"],a,button,div[tabindex]') || icon.parentElement);
  const button = [...document.querySelectorAll('div[role="button"],button')].find((el) => visible(el) && labels.compose.includes((el.innerText || "").trim()));
  if (button) targets.push(button);
  if (!targets.length) return "missing";
  targets[(press - 1) % targets.length].click();
  return "clicked";
}

// What the inbox shows, for the log when the New message window does not open.
function inboxSnapshot(labels) {
  const visible = (el) => el.getClientRects().length > 0;
  const icons = [...document.querySelectorAll("svg[aria-label]")].filter((svg) => labels.newMessage.includes(svg.getAttribute("aria-label")));
  const compose = [...document.querySelectorAll('div[role="button"],button')].filter((el) => labels.compose.includes((el.innerText || "").trim()));
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((dialog) => {
    const inputs = [...dialog.querySelectorAll("input")].map((el) => `${el.type}:${el.name || "-"}:${el.placeholder || "-"}`).join(",");
    return (dialog.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80) + (inputs ? ` [${inputs}]` : "");
  });
  return `path=${location.pathname} icons=${icons.filter(visible).length}/${icons.length} compose=${compose.length} ` +
    `dialogs=${dialogs.length}${dialogs.length ? `: ${dialogs.join(" | ")}` : ""}`.slice(0, 400);
}

// Empties and focuses the search box, ready for typing.
function focusSearch(selector) {
  const input = document.querySelector(selector);
  if (!input) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return document.activeElement === input;
}

// Selects the search result whose username line is exactly this username.
// The text sits in plain elements; the row around it holds the checkbox (or is
// itself clickable), so walk up from the text to that row and press it.
function pickResult(username, selector) {
  const input = document.querySelector(selector);
  const dialog = input && input.closest('[role="dialog"]');
  if (!dialog) return "no_dialog";
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

// True when the search dialog shows nothing at all for the typed name: no
// names and no "no results" line. Instagram shows one of those for every real
// search, so a blank list means the search did not run (seen right after an
// action block), not that the account is gone.
function searchBlank(username, selector, labels) {
  const input = document.querySelector(selector);
  const dialog = input && input.closest('[role="dialog"]');
  if (!dialog) return false;
  const text = dialog.innerText || "";
  if (labels.noResults.some((phrase) => text.toLowerCase().includes(phrase.toLowerCase()))) return false;
  const frame = new Set([...labels.newMessage, ...labels.chat, ...labels.close, ...labels.searchFrame].map((word) => word.toLowerCase()));
  return text.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean)
    .every((line) => frame.has(line) || line === username);
}

// The line of the search dialog that says Instagram is limiting the account
// ("Something went wrong. Try again later."), or null.
function searchError(selector, labels) {
  const input = document.querySelector(selector);
  const dialog = input && input.closest('[role="dialog"]');
  if (!dialog) return null;
  const lines = (dialog.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const hit = lines.find((line) => labels.searchError.some((phrase) => line.toLowerCase().includes(phrase.toLowerCase())));
  return hit ? hit.slice(0, 200) : null;
}

// What the search dialog shows, for the log when a username is not found.
function searchSnapshot(selector) {
  const input = document.querySelector(selector);
  const dialog = input && input.closest('[role="dialog"]');
  if (!dialog) return "no_dialog";
  return `typed=${input.value} text=${(dialog.innerText || "").replace(/\s+/g, " ").slice(0, 160)}`;
}

function pressChat(labels, selector) {
  const input = document.querySelector(selector);
  const dialog = input && input.closest('[role="dialog"]');
  if (!dialog) return "no_dialog";
  const button = [...dialog.querySelectorAll('button,[role="button"]')].find((el) => labels.chat.includes((el.innerText || "").trim()));
  if (!button) return "missing";
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return "disabled";
  button.click();
  return "clicked";
}

function closeSearch(labels, selector) {
  const input = document.querySelector(selector);
  const dialog = input && input.closest('[role="dialog"]');
  if (!dialog) return true;
  const icon = [...dialog.querySelectorAll("svg[aria-label]")].find((svg) => labels.close.includes(svg.getAttribute("aria-label")));
  if (icon) (icon.closest('[role="button"],button,div[tabindex]') || icon.parentElement).click();
  return Boolean(icon);
}

// The chat opened from the dialog: dialog gone and a message box on screen.
function threadOpen(selector) {
  if (document.querySelector(selector)) return false;
  return [...document.querySelectorAll('div[role="textbox"][contenteditable="true"]')].some((el) => el.getClientRects().length > 0);
}

// ---- Replies: the inbox's chat list and one open chat ----

// The chat list's rows: name, last-message preview, and whether the other
// person wrote last (the preview does not start with "You:", "Seen", …).
// Rows are found by shape (clickable, two or more lines, stacked one under
// another at the same position), not by Instagram's class names. With
// clickKey, presses that row instead. own: this account's username, from the
// side menu's profile link.
function inboxRows(labels, clickKey, notProfiles) {
  const visible = (el) => el.getClientRects().length > 0;
  const lines = (el) => (el.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const box = [...document.querySelectorAll('div[role="textbox"][contenteditable="true"]')].find(visible);
  const paneLeft = box ? box.getBoundingClientRect().left - 60 : Infinity;
  const width = window.innerWidth;
  const found = [...document.querySelectorAll('a[href^="/direct/t/"],[role="button"],[role="link"],[role="listitem"]')].filter((el) => {
    if (!visible(el) || el.closest('[role="dialog"]') || (box && el.contains(box))) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 180 && rect.height >= 36 && rect.height <= 140 && rect.left < width * 0.6 && rect.left < paneLeft && lines(el).length >= 2;
  });
  const inner = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  // The list is the biggest group of rows sharing one position and width.
  const groups = new Map();
  for (const el of inner) {
    const rect = el.getBoundingClientRect();
    const id = `${Math.round(rect.left)}:${Math.round(rect.width)}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(el);
  }
  const score = (group) => group.length + group.filter((el) => (el.innerText || "").includes("·")).length / 2;
  const list = [...groups.values()].sort((a, b) => score(b) - score(a))[0] || [];
  const own = labels.ownPreview.map((item) => item.toLowerCase());
  // Instagram can put a label before the preview ("• AI-generated profile You: …"):
  // the preview starts at the first "You:"/"Seen"… within its first 50 characters.
  const ours = (preview) => {
    const lower = preview.toLowerCase();
    if (own.some((start) => lower.startsWith(start))) return true;
    if (!lower.startsWith("•")) return false;
    return own.some((start) => { const at = lower.indexOf(start); return at > 0 && at <= 50; });
  };
  const rows = list.map((el) => {
    const all = lines(el);
    const rest = all.slice(1).filter((line) => line !== "·" && !/^(active|सक्रिय)\b/i.test(line));
    // Drop the time at the end ("· 2h", or "2h" on its own line), so the row
    // reads the same at the next check.
    const preview = rest.join(" ").replace(/\s*·\s*[^·]{1,14}$/u, "")
      .replace(/\s+\d+\s?(s|m|h|d|w|y|min|mins|hr|hrs|sec|wk|सेकंड|मिनट|घंटे|घं|दिन|सप्ताह|हफ़्ते|वर्ष)$/iu, "").trim().slice(0, 200);
    const link = el.closest('a[href^="/direct/t/"]') || el.querySelector('a[href^="/direct/t/"]');
    return {
      el, name: all[0].slice(0, 80), preview, key: `${all[0]}|${preview}`.slice(0, 300),
      theirs: Boolean(preview) && !ours(preview),
      thread: link ? link.getAttribute("href") : null
    };
  });
  if (clickKey) {
    const row = rows.find((item) => item.key === clickKey);
    if (row) row.el.click();
    return { clicked: Boolean(row) };
  }
  let account = null;
  for (const link of document.querySelectorAll("a[href]")) {
    const match = (link.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]{1,30})\/$/);
    const rect = link.getBoundingClientRect();
    if (match && visible(link) && rect.right <= 90 && !notProfiles.includes(match[1].toLowerCase())) { account = match[1].toLowerCase(); break; }
  }
  return { account, rows: rows.map(({ el, ...row }) => row) };
}

// The open chat (address /direct/t/…/) and the username of the person in it,
// from a profile link in the chat's own column (its header or "View profile").
function threadPeer(notProfiles, account) {
  const visible = (el) => el.getClientRects().length > 0;
  const box = [...document.querySelectorAll('div[role="textbox"][contenteditable="true"]')].find(visible);
  if (!box || !location.pathname.startsWith("/direct/t/")) return { open: false, path: location.pathname, username: null };
  const limit = window.innerWidth * 0.8;
  for (let node = box.parentElement; node && node !== document.body; node = node.parentElement) {
    if (node.getBoundingClientRect().width > limit) break;
    for (const link of node.querySelectorAll("a[href]")) {
      const match = (link.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
      const user = match && match[1].toLowerCase();
      if (user && !notProfiles.includes(user) && user !== account) return { open: true, path: location.pathname, username: user };
    }
  }
  return { open: true, path: location.pathname, username: null };
}

// What the other person wrote after this account's last message: text on the
// left side of the chat, below our last message (found by its exact text in
// `ours`) and above the message box. matched=false when none of ours is there.
function threadIncoming(ours, name, noise, notDelivered) {
  const norm = (value) => (value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const visible = (el) => el.getClientRects().length > 0;
  const box = [...document.querySelectorAll('div[role="textbox"][contenteditable="true"]')].find(visible);
  if (!box) return { matched: false, messages: [] };
  const targets = new Set(ours.map(norm).filter(Boolean));
  const mine = [...document.querySelectorAll("div,span")].filter((el) => visible(el) && !box.contains(el) &&
    targets.has(norm(el.innerText)) && ![...el.children].some((child) => targets.has(norm(child.innerText))));
  if (!mine.length) return { matched: false, messages: [] };
  const last = mine[mine.length - 1];
  let pane = last.parentElement;
  while (pane && !pane.contains(box)) pane = pane.parentElement;
  if (!pane) return { matched: false, messages: [] };
  const area = pane.getBoundingClientRect();
  const lastTop = last.getBoundingClientRect().top;
  const boxTop = box.getBoundingClientRect().top;
  const skip = new Set(noise.map(norm));
  const notices = notDelivered.map((phrase) => phrase.toLowerCase());
  const clock = /^(\d{1,2}[:.]\d{2}\s*([ap]\.?\s?m\.?)?|\d+\s*[smhdw])$/i;
  const messages = [];
  let undelivered = false;
  for (const el of pane.querySelectorAll("div,span")) {
    if (!(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || last.contains(el) || box.contains(el) || el.contains(box)) continue;
    if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()) || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top <= lastTop || rect.bottom >= boxTop - 4) continue;
    // Instagram's own notice (our message did not reach them), wherever it sits.
    const said = (el.innerText || "").toLowerCase();
    if (notices.some((phrase) => said.includes(phrase))) { undelivered = true; continue; }
    // Their messages sit on the left; ours, and centred dates, do not.
    if (rect.left > area.left + area.width * 0.35 || rect.left + rect.width / 2 >= area.left + area.width / 2) continue;
    const text = (el.innerText || "").trim();
    if (!text || text === name || clock.test(text) || skip.has(norm(text)) || targets.has(norm(text))) continue;
    if (messages[messages.length - 1] !== text) messages.push(text.slice(0, 1000));
  }
  return { matched: true, messages: messages.slice(-10), undelivered };
}

// After a send: Instagram's "could not be sent" notice below our message, in
// the chat's own column (not a preview in the chat list beside it).
function deliveryProblem(sent, notDelivered) {
  const norm = (value) => (value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const visible = (el) => el.getClientRects().length > 0;
  const box = [...document.querySelectorAll('div[role="textbox"][contenteditable="true"]')].find(visible);
  if (!box) return false;
  const target = norm(sent);
  const mine = [...document.querySelectorAll("div,span")].filter((el) => visible(el) && !box.contains(el) &&
    norm(el.innerText) === target && ![...el.children].some((child) => norm(child.innerText) === target));
  if (!mine.length) return false;
  const last = mine[mine.length - 1];
  const lastTop = last.getBoundingClientRect().top;
  const boxRect = box.getBoundingClientRect();
  const notices = notDelivered.map((phrase) => phrase.toLowerCase());
  for (const el of document.querySelectorAll("div,span")) {
    if (!(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || last.contains(el) || box.contains(el) || el.contains(box) || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top < lastTop || rect.bottom > boxRect.top || rect.left < boxRect.left - 80) continue;
    const text = (el.innerText || "").toLowerCase();
    if (text.length < 400 && notices.some((phrase) => text.includes(phrase))) return true;
  }
  return false;
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
// repeat: an answer the owner typed may match an earlier message ("ok"), so it
// is sent anyway; only a campaign DM is skipped when already in the chat.
async function typeAndSend(page, { username, message, previous, labels, timing, inspect, repeat = false }) {
  // Give older messages a moment to load before checking for an earlier send.
  await sleep(timing.history);
  let probe = await page.evaluate(chatProbe, username, previous, message);
  if (!probe.found) return { status: "failed", reason: "chat_not_opened" };
  if (probe.count > 0 && !repeat) return { status: "skipped", reason: "already_in_thread" };
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
    if (probe.found && probe.typedEmpty && probe.count > before) break;
    if (Date.now() > sendDeadline) return { status: "failed", reason: "send_unconfirmed", attempted: true };
  }
  // The message shows in the chat even when Instagram then says it could not
  // reach the person (they take messages only from people they follow).
  const deliveryDeadline = Date.now() + timing.delivery;
  for (;;) {
    if (await page.evaluate(deliveryProblem, message, labels.notDelivered).catch(() => false)) return { status: "skipped", reason: "not_delivered" };
    if (Date.now() > deliveryDeadline) return { status: "sent" };
    await sleep(timing.poll);
  }
}

// Sends from the Direct inbox: New message → search the username → Chat.
// The inbox page loads once per browser; each later DM only fetches the
// search result and the chat, which uses far less data than a profile page.
// "inbox_unavailable" means this screen did not work and the profile route
// can be tried instead.
async function sendDmViaInbox(page, { username, message, previous = [message], baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING, repeat = false }) {
  const blocked = (state, text, attempted = false) => ({ status: "blocked", reason: stopReason(state), text: text || null, attempted });
  const here = await page.evaluate(() => location.href).catch(() => "");
  if (!here.startsWith(`${baseUrl}/direct/`)) {
    await page.navigate(`${baseUrl}/direct/inbox/`, { timeoutMs: timing.navigation });
    // Like the profile's Message button, the icon shows before it works.
    await sleep(timing.settle);
  }

  // Press New message, then give its window time to appear (its code may still
  // be downloading) before pressing again; at most 3 presses.
  const openDeadline = Date.now() + timing.profile;
  let presses = 0;
  let pressedAt = 0;
  for (;;) {
    const { state, text } = await page.evaluate(inspectPage, labels);
    if (stopReason(state)) return blocked(state, text);
    const press = presses < 3 && (presses === 0 || Date.now() - pressedAt >= timing.dialog) ? presses + 1 : 0;
    const step = await page.evaluate(openNewMessage, labels, press, SEARCH_BOX);
    if (step === "open") break;
    if (step === "clicked") { presses++; pressedAt = Date.now(); }
    const gaveUp = presses >= 3 && Date.now() - pressedAt >= timing.dialog;
    if (gaveUp || Date.now() > openDeadline) {
      // Not on the inbox any more: the profile route would only see a logged-out page.
      if (!(await page.evaluate(() => location.pathname).catch(() => "")).startsWith("/direct/")) return blocked("logged_out");
      const seen = await page.evaluate(inboxSnapshot, labels).catch(() => "");
      return { status: "failed", reason: "inbox_unavailable", detail: `new_message=${step} presses=${presses} ${seen}`.trim() };
    }
    await sleep(timing.poll);
  }
  if (!await page.evaluate(focusSearch, SEARCH_BOX)) return { status: "failed", reason: "inbox_unavailable", detail: "search_box" };
  await page.insertText(username);

  const searchDeadline = Date.now() + timing.search;
  for (;;) {
    await sleep(timing.poll);
    const picked = await page.evaluate(pickResult, username, SEARCH_BOX);
    if (picked === "picked") break;
    if (picked === "no_dialog") return { status: "failed", reason: "inbox_unavailable", detail: "dialog_closed" };
    const problem = await page.evaluate(searchError, SEARCH_BOX, labels).catch(() => null);
    if (problem) {
      await page.evaluate(closeSearch, labels, SEARCH_BOX).catch(() => false);
      return { status: "blocked", reason: "action_blocked", text: problem, attempted: false };
    }
    if (Date.now() > searchDeadline) {
      const detail = await page.evaluate(searchSnapshot, SEARCH_BOX).catch(() => null);
      const blank = await page.evaluate(searchBlank, username, SEARCH_BOX, labels).catch(() => false);
      await page.evaluate(closeSearch, labels, SEARCH_BOX).catch(() => false);
      // A blank search is a failure to try again later; only a search that
      // answered (other names, or "no results") means the account is gone.
      if (blank) return { status: "failed", reason: "search_empty", ...(detail ? { detail } : {}) };
      return { status: "skipped", reason: "not_found", ...(detail ? { detail } : {}) };
    }
  }
  const chatDeadline = Date.now() + timing.button;
  for (;;) {
    await sleep(timing.poll);
    const pressed = await page.evaluate(pressChat, labels, SEARCH_BOX);
    if (pressed === "clicked") break;
    if (Date.now() > chatDeadline) {
      await page.evaluate(closeSearch, labels, SEARCH_BOX).catch(() => false);
      return { status: "failed", reason: pressed === "missing" ? "inbox_unavailable" : "chat_not_opened", detail: `chat_button=${pressed}` };
    }
  }
  const threadDeadline = Date.now() + timing.chat;
  for (;;) {
    await sleep(timing.poll);
    const { state, text } = await page.evaluate(inspectPage, labels);
    if (stopReason(state)) return blocked(state, text);
    if (await page.evaluate(threadOpen, SEARCH_BOX)) break;
    if (Date.now() > threadDeadline) {
      const detail = await page.evaluate(describePage, labels).catch(() => null);
      return { status: "failed", reason: "chat_not_opened", ...(detail ? { detail } : {}) };
    }
  }
  return typeAndSend(page, { username, message, previous, labels, timing, inspect: inspectPage, repeat });
}

// Reads the chats where the other person wrote last. For each one not seen at
// an earlier check (known(key) says so), opens it, finds who it is and what
// they wrote after this account's last message (outgoing(username) lists the
// texts this account sent them). At most `limit` chats are opened per check.
// Result: { status: "ok", account, rows, waiting, skipped, replies: [{ key,
// name, username, thread, text, matched }], detail? } or a "blocked" result.
async function readReplies(page, { baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING, outgoing = async () => [], known = async () => false, limit = 10 } = {}) {
  const blocked = (state, text) => ({ status: "blocked", reason: stopReason(state), text: text || null, attempted: false });
  const here = await page.evaluate(() => location.pathname).catch(() => "");
  if (!here.startsWith("/direct/")) {
    await page.navigate(`${baseUrl}/direct/inbox/`, { timeoutMs: timing.navigation });
    await sleep(timing.settle);
  }
  const listDeadline = Date.now() + timing.profile;
  let list;
  for (;;) {
    const { state, text } = await page.evaluate(inspectPage, labels);
    if (stopReason(state)) return blocked(state, text);
    list = await page.evaluate(inboxRows, labels, null, NOT_PROFILES);
    if (list.rows.length) break;
    if (Date.now() > listDeadline) {
      // Sent away from the inbox (e.g. to "/" with "Continue as …"): no login, not an empty inbox.
      if (!(await page.evaluate(() => location.pathname).catch(() => "")).startsWith("/direct/")) return blocked("logged_out");
      const seen = await page.evaluate(inboxSnapshot, labels).catch(() => "");
      return { status: "ok", account: list.account, rows: 0, waiting: 0, skipped: 0, replies: [], detail: `no_rows ${seen}`.trim() };
    }
    await sleep(timing.poll);
  }
  // Rows keep arriving for a moment after the first ones show.
  await sleep(timing.history);
  list = await page.evaluate(inboxRows, labels, null, NOT_PROFILES);
  const waiting = list.rows.filter((row) => row.theirs);
  const replies = [];
  const notes = [];
  let skipped = 0;
  for (const row of waiting) {
    if (replies.length + notes.length >= limit) break;
    if (await known(row.key)) { skipped++; continue; }
    const before = await page.evaluate(() => location.pathname).catch(() => "");
    if (!(await page.evaluate(inboxRows, labels, row.key, NOT_PROFILES)).clicked) { notes.push("row_gone"); continue; }
    const clickedAt = Date.now();
    let peer = { open: false };
    for (;;) {
      await sleep(timing.poll);
      const { state, text } = await page.evaluate(inspectPage, labels);
      if (stopReason(state)) return blocked(state, text);
      peer = await page.evaluate(threadPeer, NOT_PROFILES, list.account);
      if (peer.open && (peer.path !== before || Date.now() - clickedAt > 2000)) break;
      if (Date.now() - clickedAt > timing.chat) break;
    }
    if (!peer.open) { notes.push("chat_not_opened"); continue; }
    // Older messages load a moment after the chat opens.
    await sleep(timing.history);
    if (!peer.username) peer = await page.evaluate(threadPeer, NOT_PROFILES, list.account);
    const ours = peer.username ? await outgoing(peer.username) : [];
    const read = await page.evaluate(threadIncoming, ours, row.name, labels.chatNoise, labels.notDelivered);
    // Our message is still the last one (the list's preview misled): not a reply.
    if (read.matched && !read.messages.length && !read.undelivered) { notes.push("ours_last"); continue; }
    const text = read.matched && read.messages.length ? read.messages.join("\n") : row.preview;
    // Only Instagram's "not delivered" notice after our message: no reply, our DM did not reach them.
    const undelivered = read.matched ? read.undelivered && !read.messages.length : isUndelivered(row.preview, labels);
    replies.push({ key: row.key, name: row.name, username: peer.username || null, thread: peer.path, text, matched: read.matched,
      kind: undelivered ? "undelivered" : "reply" });
  }
  // A short trace for the log: T/O per row (their or our message last) and
  // how each preview starts, so a misread list can be seen and fixed.
  const trace = list.rows.slice(0, 12).map((row) => `${row.theirs ? "T" : "O"}:${row.preview.slice(0, 12)}`).join(" | ");
  return {
    status: "ok", account: list.account, rows: list.rows.length, waiting: waiting.length, skipped, replies,
    detail: [notes.join(" "), trace].filter(Boolean).join(" ; ").slice(0, 400)
  };
}

// Sends an answer the owner typed: through the inbox search when the username
// is known, otherwise by opening the chat's address. Sent even when the same
// words are already in the chat, unless repeat is false (a send cut off by a
// restart: then words already there mean it went).
async function sendReply(page, { username, thread, message, repeat = true, baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  if (username) {
    const result = await sendDmViaInbox(page, { username, message, previous: [message], baseUrl, labels, timing, repeat });
    // Search did not work or did not list them (a renamed account): the chat's address still does.
    if (!["inbox_unavailable", "not_found", "search_empty"].includes(result.reason) || !thread) return result;
  }
  if (!thread || !/^\/direct\/t\/[A-Za-z0-9_-]+\/?$/.test(thread)) return { status: "failed", reason: "no_chat" };
  await page.navigate(`${baseUrl}${thread}`, { timeoutMs: timing.navigation });
  const deadline = Date.now() + timing.chat;
  for (;;) {
    await sleep(timing.poll);
    const { state, text } = await page.evaluate(inspectPage, labels);
    if (stopReason(state)) return { status: "blocked", reason: stopReason(state), text: text || null, attempted: false };
    if ((await page.evaluate(threadPeer, NOT_PROFILES, null)).open) break;
    if (Date.now() > deadline) return { status: "failed", reason: "chat_not_opened" };
  }
  return typeAndSend(page, { username: username || "", message, previous: [message], labels, timing, inspect: inspectPage, repeat });
}

// Connects to a Browser Use browser (its cdpUrl) and returns a session the
// DM worker reuses for many messages, so Instagram's code downloads once.
// method "inbox" (default) sends from the Direct inbox and falls back to the
// profile's Message button when the inbox screen does not work; after two
// such misses in a row the session keeps to the profile route, so the inbox
// is not loaded again for nothing.
const INBOX_MISSES = 2;

function createInstagramDriver({ fetchImpl = fetch, baseUrl, timing = TIMING, method = "inbox" } = {}) {
  return {
    async open(cdpUrl) {
      const connection = await CdpConnection.connect(await resolveWebSocketUrl(cdpUrl, fetchImpl));
      let page;
      try { page = await openPage(connection); } catch (error) { connection.close(); throw error; }
      let misses = 0;
      const useInbox = () => method === "inbox" && misses < INBOX_MISSES;
      return {
        alive: () => !connection.closed,
        sendDm: async ({ username, message, previous }) => {
          const options = { username, message, previous, baseUrl, timing };
          if (!useInbox()) return sendDm(page, options);
          const result = await sendDmViaInbox(page, options);
          if (result.reason !== "inbox_unavailable") { misses = 0; return result; }
          misses++;
          return { ...(await sendDm(page, options)), fallback: result.detail || "inbox" };
        },
        // Replies in the inbox, and the owner's typed answers (see readReplies, sendReply).
        readReplies: (options = {}) => readReplies(page, { ...options, baseUrl, timing }),
        sendReply: (options) => sendReply(page, { ...options, baseUrl, timing }),
        // Data the page downloaded since the last call (bytes, by resource type).
        usage: () => page.takeUsage(),
        // Staying in the inbox lets the next DM skip loading the whole app again;
        // anywhere else, a blank page stops Instagram from using data while waiting.
        idle: async () => {
          const path = await page.evaluate(() => location.pathname).catch(() => "");
          if (useInbox() && path.startsWith("/direct/")) return;
          await page.navigate("about:blank", { timeoutMs: 15000 }).catch(() => {});
        },
        close: () => connection.close()
      };
    }
  };
}

module.exports = { createInstagramDriver, sendDm, sendDmViaInbox, readReplies, sendReply, isUndelivered, LABELS, TIMING, inspectProfile, inspectPage, inboxSnapshot, inboxRows, threadPeer, threadIncoming, chatProbe, describePage };
