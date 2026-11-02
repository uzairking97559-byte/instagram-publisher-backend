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
  // Login page (a new account's first login): Instagram saying the username or
  // password is wrong, asking for a code or another check, the Log in button,
  // and "Save your login info?".
  loginWrong: ["password was incorrect", "password you entered is incorrect", "login information you entered is incorrect", "incorrect password",
    "doesn't belong to an account", "check your username", "पासवर्ड गलत", "गलत पासवर्ड", "पासवर्ड सही नहीं", "जानकारी गलत"],
  loginCheck: ["Enter the code", "Enter confirmation code", "security code", "Check your email", "Check your messages", "Confirm it's you",
    "Help us confirm", "suspicious login", "unusual login", "We suspended your account", "कोड डालें", "कोड दर्ज करें", "सुरक्षा कोड",
    "पुष्टि करें कि यह आप हैं", "संदिग्ध"],
  logIn: ["Log in", "Log In", "लॉग इन करें", "लॉग इन"],
  // Instagram turning a login away for now (too many tries): wait, don't retry.
  loginLater: ["problem logging you into Instagram", "try again soon", "Please wait a few minutes", "too many attempts", "कुछ मिनट रुकें", "थोड़ी देर बाद"],
  // Forgot password: the reset page's button, Instagram saying it sent a link,
  // or found no such account; the new-password page's button and its complaints.
  resetSend: ["Send login link", "Send Login Link", "Send reset link", "Send", "Continue", "Next", "लॉगिन लिंक भेजें", "लॉग इन लिंक भेजें", "भेजें", "जारी रखें", "आगे"],
  resetSent: ["We sent an email", "We sent a link", "sent you a link", "sent a login link", "sent an SMS", "Check your email", "हमने ईमेल भेजा", "लिंक भेजा", "ईमेल भेजा"],
  resetNoUser: ["No users found", "No user found", "couldn't find your account", "can't find an account", "कोई यूज़र नहीं मिला", "अकाउंट नहीं मिला"],
  newPasswordSubmit: ["Reset password", "Reset Password", "Change password", "Change Password", "Save", "Next", "Continue", "पासवर्ड रीसेट करें", "पासवर्ड बदलें", "सेव करें", "आगे"],
  newPasswordWeak: ["at least 6", "too easy", "too common", "don't match", "do not match", "choose a different password", "can't use", "मेल नहीं", "आसान"],
  // A check's code box: its button, and Instagram saying the code is wrong.
  codeSubmit: ["Confirm", "Submit", "Next", "Continue", "Verify", "पुष्टि करें", "सबमिट करें", "आगे", "जारी रखें", "वेरिफ़ाई करें"],
  codeWrong: ["code isn't right", "code is incorrect", "check the code", "code you entered", "invalid code", "कोड गलत", "कोड सही नहीं"],
  saveInfo: ["Save info", "Save Info", "Save login info", "जानकारी सेव करें", "जानकारी सहेजें", "सेव करें"],
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
// login: after pressing Log in, how long to wait for Instagram's answer.
const TIMING = { login: 30000, navigation: 45000, profile: 30000, button: 6000, settle: 1500, reclick: 6000, chat: 30000, history: 2500, send: 12000, search: 12000, dialog: 8000, delivery: 2500, poll: 700 };

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

// ---- Login: a new account's first login, typed by the website ----

const LOGIN_USER = 'input[name="username"],input[name="email"],input[type="text"],input[type="email"],input[type="tel"],input:not([type])';
// The reset page's box for the username, email or phone, and new-password boxes.
const RESET_BOX = 'input[name="cppEmailOrUsername"],input[name="email_or_username"],input[name="username"],input[type="text"],input[type="email"],input[type="tel"],input:not([type])';
const NEW_PASSWORD = 'input[name="new_password1"],input[name="new_password2"],input[autocomplete="new-password"]';
// The box where a check's code (sent by SMS, email or an app) goes.
const CODE_BOX = 'input[name="verificationCode"],input[name="security_code"],input[name="approvals_code"],input[name="code"],' +
  'input[autocomplete="one-time-code"],input[inputmode="numeric"]';

// "ready" when the login page shows its password box and a username box.
function loginForm(userSelector) {
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (!password) return "missing";
  const user = [...(password.closest("form") || document).querySelectorAll(userSelector)].find((el) => el !== password && visible(el));
  return user ? "ready" : "missing";
}

// Focuses the username ("user") or password box with its text selected, so
// typing replaces anything already in it.
function focusLoginField(kind, userSelector) {
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (!password) return false;
  const field = kind === "password" ? password
    : [...(password.closest("form") || document).querySelectorAll(userSelector)].find((el) => el !== password && visible(el));
  if (!field) return false;
  field.focus();
  if (typeof field.select === "function") field.select();
  return document.activeElement === field;
}

// Presses the login form's Log in button.
function submitLogin(labels) {
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  const form = password && password.closest("form");
  const buttons = [...(form || document).querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible);
  const button = buttons.find((el) => el.type === "submit") || buttons.find((el) => labels.logIn.includes((el.innerText || el.value || "").trim()));
  if (button) { button.click(); return "clicked"; }
  if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return "submitted"; }
  return "missing";
}

// After Log in: { kind: "wrong" } when Instagram says the username or password
// is wrong, { kind: "check", code } when it asks for a code (code: its box is
// on the page), a captcha or another check (the owner does those), else null.
function loginProblem(labels, codeSelector) {
  const codeBox = Boolean(codeSelector && document.querySelector(codeSelector)) && !document.querySelector('input[type="password"]');
  if (codeBox) return { kind: "check", text: "code", code: true };
  const text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  if (/^\/(challenge|two_factor|auth_platform|accounts\/suspended)/.test(location.pathname)) return { kind: "check", text: location.pathname.slice(0, 60) };
  if (document.querySelector('iframe[src*="captcha"],iframe[title*="captcha" i],#recaptcha')) return { kind: "check", text: "captcha" };
  const wrong = labels.loginWrong.find((phrase) => lower.includes(phrase.toLowerCase()));
  if (wrong) return { kind: "wrong", text: wrong };
  const check = labels.loginCheck.find((phrase) => lower.includes(phrase.toLowerCase()));
  return check ? { kind: "check", text: check } : null;
}

// Lengths of what the login boxes hold (never their text), and whether the
// Log in button is disabled.
function loginFilled(userSelector, labels) {
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  const form = password && password.closest("form");
  const user = password && [...(form || document).querySelectorAll(userSelector)].find((el) => el !== password && visible(el));
  const buttons = [...(form || document).querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible);
  const button = buttons.find((el) => el.type === "submit") || buttons.find((el) => labels.logIn.includes((el.innerText || el.value || "").trim()));
  return { user: user ? user.value.length : -1, password: password ? password.value.length : -1,
    disabled: Boolean(button && (button.disabled || button.getAttribute("aria-disabled") === "true")) };
}

// Puts text into a login box the way the page's own code sees typing, for a
// page whose framework missed the typed text.
function setLoginValue(kind, userSelector, value) {
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (!password) return false;
  const field = kind === "password" ? password
    : [...(password.closest("form") || document).querySelectorAll(userSelector)].find((el) => el !== password && visible(el));
  if (!field) return false;
  field.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return field.value.length === value.length;
}

// The page's input boxes as name:type:visible, for the log (never their text).
function loginInputs() {
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  return [...document.querySelectorAll("input")].slice(0, 12)
    .map((el) => `${el.name || "-"}:${el.type}:${visible(el) ? 1 : 0}`).join(",");
}

// A short note of what the page says: its alert line, else the start of its text.
function pageNote() {
  const alert = document.querySelector('[role="alert"],#slfErrorAlert');
  const text = (alert && alert.innerText) || (document.body ? document.body.innerText : "");
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

// "Save your login info?": presses Save.
function pressSaveInfo(labels) {
  const button = [...document.querySelectorAll('button,[role="button"]')].find((el) => labels.saveInfo.includes((el.innerText || "").trim()));
  if (!button) return false;
  button.click();
  return true;
}

// True when the browser holds an Instagram login (its session cookie; only the
// cookie's presence is read, never its value).
async function hasSession(page, baseUrl = "https://www.instagram.com") {
  const result = await page.send("Network.getCookies", { urls: [`${baseUrl}/`] }).catch(() => null);
  return Boolean(result && Array.isArray(result.cookies) && result.cookies.some((cookie) => cookie.name === "sessionid" && cookie.value));
}

// Logs in on Instagram's login page with the username and password the owner
// typed on the website. The password is typed once and kept nowhere. Any check
// Instagram asks for stops here: the owner does it himself in the live view.
// Result: { status: "logged_in", already? } | { status: "wrong_password" }
//   | { status: "needs_check", text } | { status: "failed", reason, detail? }
async function logIn(page, { username, password, baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  await page.navigate(`${baseUrl}/accounts/login/`, { timeoutMs: timing.navigation });
  const formDeadline = Date.now() + timing.profile;
  for (;;) {
    // Instagram sends a logged-in browser away from the login page.
    const path = await page.evaluate(() => location.pathname).catch(() => "");
    if (!path.startsWith("/accounts/login") && await hasSession(page, baseUrl)) return { status: "logged_in", already: true };
    if (await page.evaluate(loginForm, LOGIN_USER) === "ready") {
      // The login page shows, so any session cookie left in the profile is dead.
      await page.send("Network.deleteCookies", { name: "sessionid", url: `${baseUrl}/` }).catch(() => {});
      break;
    }
    const problem = await page.evaluate(loginProblem, labels, CODE_BOX).catch(() => null);
    if (problem && problem.kind === "check") return { status: "needs_check", text: problem.text, code: Boolean(problem.code) };
    if (Date.now() > formDeadline) return { status: "failed", reason: "login_form_missing", detail: await page.evaluate(describePage, labels).catch(() => null) };
    await sleep(timing.poll);
  }
  await sleep(timing.settle);
  // The page may still be redrawing its form: each box is looked up again
  // until it takes focus. If one never does, the browser stays open with a
  // screenshot for the owner (what the page shows goes to the log).
  const focus = async (kind) => {
    const until = Date.now() + timing.button;
    for (;;) {
      if (await page.evaluate(focusLoginField, kind, LOGIN_USER).catch(() => false)) return true;
      if (Date.now() > until) return false;
      await sleep(timing.poll);
    }
  };
  const stuck = async (kind) => ({ status: "needs_check", text: await page.evaluate(pageNote).catch(() => null), code: false, timeout: true,
    detail: `focus=${kind} inputs=${await page.evaluate(loginInputs).catch(() => "")}` });
  if (!await focus("user")) return stuck("user");
  await page.insertText(username);
  if (!await focus("password")) return stuck("password");
  await page.insertText(password);
  await sleep(timing.settle);
  // The boxes must hold what was typed (only their lengths are read back); if
  // the page's code missed it, the text is put in again the way it sees typing.
  let filled = await page.evaluate(loginFilled, LOGIN_USER, labels).catch(() => null);
  if (filled && (filled.user !== username.length || filled.password !== password.length || filled.disabled)) {
    await page.evaluate(setLoginValue, "user", LOGIN_USER, username).catch(() => false);
    await page.evaluate(setLoginValue, "password", LOGIN_USER, password).catch(() => false);
    await sleep(timing.settle);
    filled = await page.evaluate(loginFilled, LOGIN_USER, labels).catch(() => null);
  }
  const typed = filled ? `user=${filled.user === username.length} password=${filled.password === password.length} button=${filled.disabled ? "disabled" : "ok"}` : "unknown";
  if (await page.evaluate(submitLogin, labels) === "missing") await page.pressEnter();
  const deadline = Date.now() + (timing.login || TIMING.login);
  for (;;) {
    await sleep(timing.poll);
    if (await hasSession(page, baseUrl)) {
      // "Save your login info?" shows next; Save keeps the login for later starts.
      const saveDeadline = Date.now() + timing.button;
      while (Date.now() < saveDeadline && !await page.evaluate(pressSaveInfo, labels).catch(() => false)) await sleep(timing.poll);
      await sleep(timing.settle);
      return { status: "logged_in" };
    }
    const problem = await page.evaluate(loginProblem, labels, CODE_BOX).catch(() => null);
    if (problem && problem.kind === "wrong") return { status: "wrong_password" };
    if (problem && problem.kind === "check") return { status: "needs_check", text: problem.text, code: Boolean(problem.code) };
    if (await page.evaluate(pageHas, labels.loginLater).catch(() => false)) return { status: "try_later", text: await page.evaluate(pageNote).catch(() => null) };
    // No answer from Instagram: the browser stays open so the owner sees the
    // page (a screenshot on the website) and can tap Log in himself.
    if (Date.now() > deadline) {
      return { status: "needs_check", text: await page.evaluate(pageNote).catch(() => null), code: false, timeout: true,
        detail: `typed ${typed} inputs=${await page.evaluate(loginInputs).catch(() => "")} ${await page.evaluate(describePage, labels).catch(() => "")}`.trim() };
    }
  }
}

// The new-password page: how many boxes take the new password (0: not here).
function newPasswordBoxes(selector) {
  const named = document.querySelectorAll(selector).length;
  const passwords = document.querySelectorAll('input[type="password"]').length;
  return named || (passwords >= 2 ? passwords : 0);
}

// Focuses new-password box number `index` with its text selected.
function focusNewPassword(index, selector) {
  let boxes = [...document.querySelectorAll(selector)];
  if (!boxes.length) boxes = [...document.querySelectorAll('input[type="password"]')];
  const box = boxes[index];
  if (!box) return false;
  box.focus();
  if (typeof box.select === "function") box.select();
  return document.activeElement === box;
}

// Presses a page's main button: the form's submit button, else one of `names`.
function pressFormButton(names, boxSelector) {
  const box = document.querySelector(boxSelector);
  const scope = (box && box.closest("form")) || document;
  const buttons = [...scope.querySelectorAll('button,[role="button"],input[type="submit"]')];
  const button = buttons.find((el) => el.type === "submit") || buttons.find((el) => names.includes((el.innerText || el.value || "").trim()));
  if (button) { button.click(); return "clicked"; }
  return "missing";
}

function pageHas(phrases) {
  const lower = (document.body ? document.body.innerText : "").toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase.toLowerCase()));
}

// Where a reset, a link or a new password has led: logged in, a code box,
// the new-password page, the login page, or another check.
async function afterStep(page, { baseUrl, labels }) {
  const path = await page.evaluate(() => location.pathname).catch(() => "");
  if (!path.startsWith("/accounts/login") && !path.startsWith("/accounts/password") && await hasSession(page, baseUrl)) return { status: "logged_in" };
  if (await page.evaluate(newPasswordBoxes, NEW_PASSWORD).catch(() => 0)) return { status: "new_password" };
  const problem = await page.evaluate(loginProblem, labels, CODE_BOX).catch(() => null);
  if (problem && problem.code) return { status: "needs_check", text: "code", code: true };
  if (path.startsWith("/accounts/login") && await page.evaluate(loginForm, LOGIN_USER).catch(() => "missing") === "ready") return { status: "login_page" };
  if (problem) return { status: "needs_check", text: problem.text, code: false };
  return null;
}

// Logged in: press "Save info" when Instagram offers it, then settle.
async function saveLogin(page, { labels, timing }) {
  const saveDeadline = Date.now() + timing.button;
  while (Date.now() < saveDeadline && !await page.evaluate(pressSaveInfo, labels).catch(() => false)) await sleep(timing.poll);
  await sleep(timing.settle);
}

// Forgot password: asks Instagram to send a reset (a link or a code) for this
// username, email or phone. Result: { status: "code_sent" } (a code box shows)
// | { status: "link_sent" } | { status: "new_password" } | { status: "no_account" }
// | { status: "needs_check", text, code } | { status: "failed", reason }.
async function requestReset(page, { username, baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  await page.navigate(`${baseUrl}/accounts/password/reset/`, { timeoutMs: timing.navigation });
  const boxDeadline = Date.now() + timing.profile;
  while (!await page.evaluate(focusCodeBox, RESET_BOX).catch(() => false)) {
    if (Date.now() > boxDeadline) return { status: "failed", reason: "reset_form_missing", detail: await page.evaluate(describePage, labels).catch(() => null) };
    await sleep(timing.poll);
  }
  await page.insertText(username);
  await sleep(timing.settle);
  if (await page.evaluate(pressFormButton, labels.resetSend, RESET_BOX) === "missing") await page.pressEnter();
  const deadline = Date.now() + (timing.login || TIMING.login);
  for (;;) {
    await sleep(timing.poll);
    const step = await afterStep(page, { baseUrl, labels });
    if (step && step.status === "logged_in") { await saveLogin(page, { labels, timing }); return step; }
    if (step && step.status === "new_password") return step;
    if (step && step.status === "needs_check" && step.code) return { status: "code_sent" };
    if (await page.evaluate(pageHas, labels.resetNoUser).catch(() => false)) return { status: "no_account" };
    if (await page.evaluate(pageHas, labels.resetSent).catch(() => false)) return { status: "link_sent" };
    if (step && step.status === "needs_check") return step;
    if (Date.now() > deadline) return { status: "needs_check", text: null, code: false };
  }
}

// Opens the link Instagram sent (login or reset link) in this browser.
// Result: { status: "logged_in" } | { status: "new_password" } | { status: "needs_check", text, code }.
async function openLink(page, { url, baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  await page.navigate(url, { timeoutMs: timing.navigation });
  const deadline = Date.now() + (timing.login || TIMING.login);
  for (;;) {
    await sleep(timing.poll);
    const step = await afterStep(page, { baseUrl, labels });
    if (step && step.status === "logged_in") { await saveLogin(page, { labels, timing }); return step; }
    if (step && step.status !== "login_page") return step;
    if (Date.now() > deadline) return { status: "needs_check", text: step ? "login_page" : null, code: false };
  }
}

// Types the new password into the new-password page's boxes and saves it.
// Result: { status: "logged_in" } | { status: "login_page" } (log in with it next)
// | { status: "weak_password" } | { status: "no_password_box" } | { status: "needs_check", text, code }.
async function setNewPassword(page, { password, baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  const boxes = await page.evaluate(newPasswordBoxes, NEW_PASSWORD).catch(() => 0);
  if (!boxes) return { status: "no_password_box" };
  for (let index = 0; index < boxes; index++) {
    if (!await page.evaluate(focusNewPassword, index, NEW_PASSWORD)) return { status: "no_password_box" };
    await page.insertText(password);
  }
  await sleep(timing.settle);
  const pageText = () => page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
  const before = await pageText();
  if (await page.evaluate(pressFormButton, labels.newPasswordSubmit, 'input[type="password"]') === "missing") await page.pressEnter();
  const deadline = Date.now() + (timing.login || TIMING.login);
  for (;;) {
    await sleep(timing.poll);
    const path = await page.evaluate(() => location.pathname).catch(() => "");
    if (!path.startsWith("/accounts/password") || !await page.evaluate(newPasswordBoxes, NEW_PASSWORD).catch(() => 0)) {
      const step = await afterStep(page, { baseUrl, labels });
      if (step && step.status === "logged_in") { await saveLogin(page, { labels, timing }); return step; }
      if (step && step.status !== "new_password") return step;
    }
    if (await pageText() !== before && await page.evaluate(pageHas, labels.newPasswordWeak).catch(() => false)) return { status: "weak_password" };
    if (Date.now() > deadline) return { status: "needs_check", text: null, code: false };
  }
}

// Focuses the check's code box with its text selected.
function focusCodeBox(codeSelector) {
  const box = document.querySelector(codeSelector);
  if (!box) return false;
  box.focus();
  if (typeof box.select === "function") box.select();
  return document.activeElement === box;
}

// Presses the code box's button (Confirm, Submit, …).
function submitCode(labels, codeSelector) {
  const box = document.querySelector(codeSelector);
  const scope = (box && box.closest("form")) || document;
  const buttons = [...scope.querySelectorAll('button,[role="button"],input[type="submit"]')];
  const button = buttons.find((el) => el.type === "submit") || buttons.find((el) => labels.codeSubmit.includes((el.innerText || el.value || "").trim()));
  if (button) { button.click(); return "clicked"; }
  return "missing";
}

// True when Instagram says the code typed was wrong.
function codeRejected(labels) {
  const lower = (document.body ? document.body.innerText : "").toLowerCase();
  return labels.codeWrong.some((phrase) => lower.includes(phrase.toLowerCase()));
}

// Types the code the owner got (SMS, email or app) into the check's code box
// and waits for Instagram's answer. The code is typed once and kept nowhere.
// Result: { status: "logged_in" } | { status: "wrong_code" } | { status: "no_code_box" }
//   | { status: "needs_check", text, code } (another step) .
async function enterCode(page, { code, baseUrl = "https://www.instagram.com", labels = LABELS, timing = TIMING }) {
  if (await hasSession(page, baseUrl)) return { status: "logged_in" };
  if (!await page.evaluate(focusCodeBox, CODE_BOX)) return { status: "no_code_box" };
  await page.insertText(code);
  await sleep(timing.settle);
  // An earlier wrong code's message may still show: only a page that changed
  // after this code counts as Instagram's answer to it.
  const pageText = () => page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
  const before = await pageText();
  if (await page.evaluate(submitCode, labels, CODE_BOX) === "missing") await page.pressEnter();
  const deadline = Date.now() + (timing.login || TIMING.login);
  for (;;) {
    await sleep(timing.poll);
    if (await hasSession(page, baseUrl)) {
      const saveDeadline = Date.now() + timing.button;
      while (Date.now() < saveDeadline && !await page.evaluate(pressSaveInfo, labels).catch(() => false)) await sleep(timing.poll);
      await sleep(timing.settle);
      return { status: "logged_in" };
    }
    if (await pageText() !== before && await page.evaluate(codeRejected, labels).catch(() => false)) return { status: "wrong_code" };
    if (await page.evaluate(newPasswordBoxes, NEW_PASSWORD).catch(() => 0)) return { status: "new_password" };
    if (Date.now() > deadline) {
      const problem = await page.evaluate(loginProblem, labels, CODE_BOX).catch(() => null);
      return { status: "needs_check", text: problem ? problem.text : null, code: Boolean(problem && problem.code) };
    }
  }
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
    // block: resource types refused before they download (default: pictures,
    // videos, fonts); a login browser loads everything, so a captcha shows.
    async open(cdpUrl, { block } = {}) {
      const connection = await CdpConnection.connect(await resolveWebSocketUrl(cdpUrl, fetchImpl));
      let page;
      try { page = await openPage(connection, block ? { block } : undefined); } catch (error) { connection.close(); throw error; }
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
        // A new account's first login, and whether this browser is logged in.
        login: (options) => logIn(page, { ...options, baseUrl, timing }),
        enterCode: (options) => enterCode(page, { ...options, baseUrl, timing }),
        requestReset: (options) => requestReset(page, { ...options, baseUrl, timing }),
        openLink: (options) => openLink(page, { ...options, baseUrl, timing }),
        setNewPassword: (options) => setNewPassword(page, { ...options, baseUrl, timing }),
        loggedIn: () => hasSession(page, baseUrl),
        // The owner's own tap and typing during Instagram's check, relayed from
        // the website: x and y are where he tapped on the screenshot (0–1).
        tap: async ({ x, y }) => {
          const metrics = await page.send("Page.getLayoutMetrics");
          const view = (metrics && (metrics.cssVisualViewport || metrics.visualViewport || metrics.layoutViewport)) || {};
          const left = Math.round(x * (view.clientWidth || 1366)), top = Math.round(y * (view.clientHeight || 900));
          await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left, y: top });
          await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: left, y: top, button: "left", clickCount: 1 });
          await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: left, y: top, button: "left", clickCount: 1 });
        },
        type: (text) => page.insertText(text),
        // A picture of what the page shows now (JPEG), so the owner sees a check.
        screenshot: async () => {
          const shot = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
          return Buffer.from(String(shot && shot.data || ""), "base64");
        },
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

module.exports = { createInstagramDriver, sendDm, sendDmViaInbox, readReplies, sendReply, logIn, enterCode, requestReset, openLink, setNewPassword, isUndelivered, LABELS, TIMING, inspectProfile, inspectPage, inboxSnapshot, inboxRows, threadPeer, threadIncoming, chatProbe, describePage };
