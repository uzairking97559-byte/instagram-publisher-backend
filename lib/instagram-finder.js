"use strict";

// Creator finder (lib/finder.js) in a cloud browser logged in to a separate,
// dedicated Instagram account: reads one profile's public numbers and the
// accounts Instagram shows as similar to it.
//
// Cheapest first: inside the already-open Instagram page, the same JSON the
// web app uses for a profile (web_profile_info) and for "Similar accounts"
// (chaining) — a few kilobytes each. If that fails, the profile page itself:
// counts from its header, post dates from the post links, and the accounts
// that appear when "Similar accounts" is pressed.

const { CdpConnection, openPage, resolveWebSocketUrl, sleep } = require("./cdp");

// The web app's own ID, sent with its JSON requests (read from the page when it is there).
const DEFAULT_APP_ID = "936619743392459";
const NOT_PROFILES = new Set(["direct", "explore", "reels", "reel", "p", "tv", "stories", "accounts", "about", "legal", "developer", "m", "web", "challenge", "notifications", "your_activity"]);
const USERNAME = /^[a-z0-9._]{1,30}$/;
const TIMING = { navigation: 45000, settle: 2500, similar: 4000, poll: 500 };
const LABELS = {
  notFound: ["Sorry, this page isn't available", "this page isn't available", "यह पेज उपलब्ध नहीं है", "पेज उपलब्ध नहीं"],
  private: ["This account is private", "This Account is Private", "यह अकाउंट प्राइवेट है", "ये अकाउंट प्राइवेट है"],
  blocked: ["Try Again Later", "We restrict certain activity", "Please wait a few minutes", "कुछ मिनट रुकें", "हम कुछ गतिविधियों"],
  similar: ["Similar accounts", "Suggested for you", "Suggested", "मिलते-जुलते अकाउंट", "आपके लिए सुझाए गए"]
};

// ---- In the page ----

function detectAppId() {
  const html = document.documentElement ? document.documentElement.innerHTML : "";
  const match = html.match(/"(?:appId|app_id|X-IG-App-ID)"\s*:\s*"(\d{10,20})"/);
  return match ? match[1] : null;
}

// Where the page is: logged out, a security check, a limit warning, or fine.
function pageState(labels) {
  const path = location.pathname;
  const body = document.body ? document.body.innerText || "" : "";
  if (path.startsWith("/accounts/login") || document.querySelector('input[name="password"]')) return "logged_out";
  if (/^\/(challenge|checkpoint|accounts\/suspended|accounts\/disabled|suspended)/.test(path)) return "challenge";
  if (labels.blocked.some((phrase) => body.includes(phrase))) return "rate_limited";
  return "ok";
}

// The profile and similar accounts through the web app's own JSON.
async function profileApi(username, appId) {
  const headers = { "X-IG-App-ID": appId, "X-Requested-With": "XMLHttpRequest" };
  const read = async (url) => {
    const response = await fetch(url, { headers, credentials: "include", signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, url: response.url || "", text: text.slice(0, 300), data };
  };
  // Instagram's answers that stop the run: a security check, a limit, or no login.
  const problem = ({ status, url, text, data }) => {
    if (data?.message === "checkpoint_required" || data?.checkpoint_url || /\/(challenge|checkpoint)\//.test(url)) return "challenge";
    if (status === 429 || data?.message === "feedback_required" || data?.spam || /wait a few minutes|rate limit/i.test(text)) return "rate_limited";
    if (data?.message === "login_required" || data?.require_login || status === 401 || /\/accounts\/login/.test(url)) return "logged_out";
    return null;
  };
  try {
    const first = await read(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const stop = problem(first);
    if (stop) return { state: stop };
    if (first.status === 404) return { state: "not_found" };
    const user = first.data?.data?.user;
    if (!user) return { state: first.status === 200 && first.data ? "not_found" : "error", detail: `status ${first.status}` };
    const posts = (user.edge_owner_to_timeline_media?.edges || []).map((edge) => edge.node || {});
    const reels = (user.edge_felix_video_timeline?.edges || []).map((edge) => edge.node || {});
    const stamps = [...posts, ...reels].map((node) => node.taken_at_timestamp).filter(Number.isFinite);
    const views = [...posts, ...reels].map((node) => node.video_view_count ?? node.video_play_count).filter(Number.isFinite);
    let related = (user.edge_related_profiles?.edges || []).map((edge) => edge.node?.username).filter(Boolean);
    // "Similar accounts" (what the arrow beside Follow shows); none for a private account.
    if (!related.length && user.id && !user.is_private) {
      const chain = await read(`/api/v1/discover/chaining/?target_id=${encodeURIComponent(user.id)}`);
      const chainStop = problem(chain);
      if (chainStop) return { state: chainStop };
      related = (chain.data?.users || []).map((item) => item?.username).filter(Boolean);
    }
    return {
      state: "ok", source: "api", username: String(user.username || username).toLowerCase(), name: user.full_name || null,
      followers: user.edge_followed_by?.count ?? null, following: user.edge_follow?.count ?? null,
      posts: user.edge_owner_to_timeline_media?.count ?? null, private: Boolean(user.is_private),
      professional: Boolean(user.is_professional_account || user.is_business_account), verified: Boolean(user.is_verified),
      category: user.category_name || user.business_category_name || null, bio: user.biography ? String(user.biography).slice(0, 200) : null,
      last_post_at: stamps.length ? Math.max(...stamps) * 1000 : null,
      avg_views: views.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / views.length) : null,
      related
    };
  } catch (error) {
    return { state: "error", detail: String(error && error.message || error).slice(0, 80) };
  }
}

// The open profile page: counts from the header (or the page description),
// private / not found, and post dates from the post links' codes.
function profileDom(username, labels) {
  const body = document.body ? document.body.innerText || "" : "";
  const header = document.querySelector("header");
  const named = Boolean(header && (header.innerText || "").toLowerCase().includes(username));
  if (!named && labels.notFound.some((phrase) => body.includes(phrase))) return { state: "not_found" };
  const amount = (text) => {
    const match = String(text || "").replace(/,/g, "").match(/([\d.]+)\s*([KkMm]|हज़ार|लाख|मिलियन)?/);
    if (!match) return null;
    const value = Number(match[1]);
    const scale = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, "हज़ार": 1e3, "लाख": 1e5, "मिलियन": 1e6 }[match[2]] || 1;
    return Number.isFinite(value) ? Math.round(value * scale) : null;
  };
  // The shortest header text naming the count ("12.5K followers", not the row of all three).
  const pick = (patterns) => {
    const lines = [...(header ? header.querySelectorAll("li, span, a, div") : [])].map((el) => (el.innerText || "").trim())
      .filter((line) => line && line.length < 40 && /\d/.test(line) && patterns.test(line)).sort((a, b) => a.length - b.length);
    if (lines.length) return amount(lines[0]);
    // "12K Followers, 300 Following, 1,234 Posts - See Instagram photos…"
    const meta = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || "";
    for (const part of meta.split(/,\s+|\s+-\s+/)) if (patterns.test(part)) return amount(part);
    return null;
  };
  // Media codes carry their creation time (Instagram IDs: milliseconds since 2011-08-24 in the top bits).
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const posted = (code) => {
    if (!code || code.length > 12) return null;
    let id = 0n;
    for (const char of code) {
      const index = ALPHABET.indexOf(char);
      if (index < 0) return null;
      id = id * 64n + BigInt(index);
    }
    const ms = Number(id >> 23n) + 1314220021721;
    return ms > Date.UTC(2011, 0, 1) && ms < Date.now() + 86400000 ? ms : null;
  };
  const codes = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
    .map((link) => (link.getAttribute("href") || "").match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/)?.[1]).filter(Boolean);
  const stamps = codes.slice(0, 12).map(posted).filter(Boolean);
  return {
    state: "ok", source: "page", username,
    followers: pick(/followers|फ़ॉलोअर|फॉलोअर/i), following: pick(/following|फ़ॉलो कर रहे|फॉलो कर रहे/i), posts: pick(/posts|पोस्ट/i),
    private: labels.private.some((phrase) => body.includes(phrase)), professional: null, verified: null, category: null, bio: null, name: null,
    last_post_at: stamps.length ? Math.max(...stamps) : null, avg_views: null, related: []
  };
}

// Profile links on the page, outside the person's own header and the menu.
function profileLinks(own, notProfiles) {
  const found = new Set();
  for (const link of document.querySelectorAll("a[href]")) {
    const match = (link.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    const user = match && match[1].toLowerCase();
    if (!user || user === own || notProfiles.includes(user) || link.closest("nav")) continue;
    if (link.getClientRects().length === 0) continue;
    found.add(user);
  }
  return [...found];
}

// Presses "Similar accounts" (the arrow beside Follow); "missing" when there is none.
function openSimilar(labels) {
  const lower = labels.map((label) => label.toLowerCase());
  const icon = [...document.querySelectorAll("svg[aria-label]")].find((svg) => lower.includes(svg.getAttribute("aria-label").toLowerCase()));
  const button = icon ? icon.closest('[role="button"],button,a,div[tabindex]') || icon.parentElement
    : [...document.querySelectorAll('[role="button"],button')].find((el) => lower.includes((el.innerText || "").trim().toLowerCase()));
  if (!button) return "missing";
  button.click();
  return "clicked";
}

// ---- Node side ----

const STOPS = new Set(["logged_out", "challenge", "rate_limited"]);

// Result: { state: "ok", source: "api" | "page", username, name, followers,
// following, posts, private, professional, verified, category, bio,
// last_post_at (ms), avg_views, related[] }, or { state: "not_found" |
// "logged_out" | "challenge" | "rate_limited" | "error", detail? }.
async function readProfile(page, { username, baseUrl = "https://www.instagram.com", timing = TIMING, labels = LABELS }) {
  const here = await page.evaluate(() => location.href).catch(() => "");
  const openProfile = async () => {
    await page.navigate(`${baseUrl}/${encodeURIComponent(username)}/`, { timeoutMs: timing.navigation });
    await sleep(timing.settle);
    return page.evaluate(pageState, labels);
  };
  let onProfile = false;
  // The JSON needs an Instagram page open (same site, logged-in cookies): the
  // first profile's page, once per browser.
  if (!here.startsWith(baseUrl)) {
    const state = await openProfile();
    if (STOPS.has(state)) return { state };
    onProfile = true;
  }
  const appId = (await page.evaluate(detectAppId).catch(() => null)) || DEFAULT_APP_ID;
  const viaApi = await page.evaluate(profileApi, username, appId);
  if (viaApi.state !== "error") return viaApi;

  // The JSON failed: the profile page itself, and its "Similar accounts" button.
  const state = onProfile ? await page.evaluate(pageState, labels) : await openProfile();
  if (STOPS.has(state)) return { state };
  const result = await page.evaluate(profileDom, username, labels);
  if (result.state !== "ok") return result;
  result.detail = viaApi.detail || null;
  if (result.private) return result;
  const fresh = async (before) => (await page.evaluate(profileLinks, username, [...NOT_PROFILES])).filter((user) => !before.has(user));
  const before = new Set(await page.evaluate(profileLinks, username, [...NOT_PROFILES]));
  if (await page.evaluate(openSimilar, labels.similar) === "clicked") {
    const deadline = Date.now() + timing.similar;
    let added = [];
    while (Date.now() < deadline && added.length < 3) {
      await sleep(timing.poll);
      added = await fresh(before);
    }
    // The list fills in a few at a time.
    if (added.length) { await sleep(timing.poll); added = await fresh(before); }
    result.related = added;
  }
  return result;
}

function clean(result) {
  if (result.state !== "ok") return result;
  return { ...result, related: [...new Set(result.related.map((user) => String(user).toLowerCase()).filter((user) => USERNAME.test(user) && !NOT_PROFILES.has(user) && user !== result.username))].slice(0, 60) };
}

// A session in a Browser Use browser (its cdpUrl) for many profiles in a row.
function createFinderDriver({ fetchImpl = fetch, baseUrl, timing = TIMING } = {}) {
  return {
    async open(cdpUrl) {
      const connection = await CdpConnection.connect(await resolveWebSocketUrl(cdpUrl, fetchImpl));
      let page;
      try { page = await openPage(connection); } catch (error) { connection.close(); throw error; }
      return {
        alive: () => !connection.closed,
        readProfile: async (username) => clean(await readProfile(page, { username, baseUrl, timing })),
        usage: () => page.takeUsage(),
        close: () => connection.close()
      };
    }
  };
}

module.exports = { createFinderDriver, readProfile, profileApi, profileDom, detectAppId, LABELS, TIMING, DEFAULT_APP_ID };
