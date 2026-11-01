"use strict";

// DM Sender: sends the owner's message to Instagram creators who asked for
// promotion details (they commented on a Reel), from the owner's own account
// that is logged in inside a Browser Use profile. No AI model runs per message:
// lib/instagram-dm.js clicks through Instagram with fixed steps.
//
// Pacing: one message per campaign every `gap` minutes (±20%), only inside the
// campaign's hours (India time), up to its daily limit. Any Instagram warning,
// logout or security check pauses the campaign until the owner starts it again.

const crypto = require("node:crypto");
const { createBrowserUseClient, UUID } = require("./browser-use");
const { createInstagramDriver, isUndelivered } = require("./instagram-dm");
const { AppError } = require("./publishing");
const { validId } = require("./security");

const IST = 330 * 60000;
const DAY = 86400000;
const USERNAME = /^[a-z0-9._]{1,30}$/;
const NOT_PROFILES = new Set(["p", "reel", "reels", "stories", "explore", "direct", "accounts", "tv", "about", "developer", "legal", "m"]);
const MAX_TARGETS = 2000;
const MAX_MESSAGE = 1000;
const MAX_VARIANTS = 10;

// A campaign message can hold several versions, separated by a line with ---;
// each DM uses one of them. {username} becomes the creator's username.
function messageVariants(message) {
  return String(message || "").split(/\n[ \t]*-{3,}[ \t]*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
}
function renderMessage(text, username) {
  return text.replace(/\{\s*(?:username|name)\s*\}/gi, username);
}
const BROWSER_MINUTES = 180;
const BROWSER_ROTATE_MS = 165 * 60000;
// Keep the browser between messages (Instagram's code stays cached), but not
// across a long wait such as the night. Reopening loads Instagram again
// (~4.5 MB of India proxy, about ₹2), while an hour of open browser costs
// about ₹2 as well, so any wait under an hour keeps it open; varied gaps
// (up to 1.6x the campaign's gap) no longer close it between DMs.
const IDLE_CLOSE_MS = 60 * 60000;
const MAX_ERRORS = 3;
const SKIP_DELAY_MS = 15000;
// Skips in a row after which the next DM waits a normal gap instead.
const SKIP_STREAK = 3;
const RETRY_DELAY_MS = 2 * 60000;
const LEASE_MS = 3 * 60000;
const STOP_PAUSES = new Set(["browser_use_key_invalid", "browser_use_no_credits", "browser_use_not_found"]);
const LOST = new Set(["cdp_closed", "cdp_timeout", "cdp_unavailable"]);
// Replies: while a campaign's browser is open, its inbox is read every 30
// minutes between DMs, and once more before the browser closes. A browser
// opened just for replies (owner's "check now", or an answer to send) closes
// 10 minutes after its last job, so answers typed one after another share
// it. An answer is tried up to 3 times.
const REPLY_CHECK_MS = 30 * 60000;
const REPLY_FINAL_MS = 10 * 60000;
const REPLY_IDLE_MS = 10 * 60000;
const REPLY_RETRY_MS = 2 * 60000;
// Fixed check hours (India time): each account that sent DMs in the last 3 days
// has its inbox read once at each of these, within an hour of it, so replies
// that came after its browser closed don't wait till the next day.
// DM_CHECK_HOURS="16,19,22" (default) or "none".
const DEFAULT_CHECK_HOURS = [16, 19, 22];
const CHECK_SLOT_MS = 60 * 60000;
const CHECK_RECENT_MS = 3 * DAY;
// An account in one of these states is not opened on a schedule (the owner fixes it first).
const ACCOUNT_PROBLEMS = ["logged_out", "challenge", "action_blocked", "browser_use_key_invalid", "browser_use_no_credits", "browser_use_not_found"];
const REPLY_LIMIT = 10;
const MAX_ANSWER = 1000;
const MAX_ANSWER_TRIES = 3;
const MAX_WAITING_ANSWERS = 3;
// Warm-up: a campaign with it on sends at most this many a day for its
// account (never more than its own daily limit). 20 in the account's first
// week of DMs, +10 each week; after a warning or security check, 10, +10 a week.
const WARMUP_START = 20;
const WARMUP_STEP = 10;
const WARMUP_AFTER_WARNING = 10;
const WEEK = 7 * DAY;
const WARNINGS = new Set(["action_blocked", "challenge"]);

// Usernames from pasted text: one per line (or separated by spaces/commas),
// with or without @, or as instagram.com links.
function parseUsernames(text) {
  const usernames = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/[\s,;]+/)) {
    const original = raw.trim();
    if (!original) continue;
    let token = original.replace(/^["'(<]+|[>)"']+$/g, "");
    if (/(^|\.|\/)(instagram\.com|instagr\.am|ig\.me)(\/|$)/i.test(token)) {
      try {
        const url = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`);
        const parts = url.pathname.split("/").filter(Boolean);
        token = /ig\.me$/i.test(url.hostname) && parts[0] === "m" ? parts[1] : parts[0];
      } catch { token = ""; }
    }
    token = (token || "").replace(/^@+/, "").toLowerCase();
    if (!USERNAME.test(token) || NOT_PROFILES.has(token) || token.endsWith(".") || token.startsWith(".")) {
      if (invalid.length < 50) invalid.push(original.slice(0, 60));
      continue;
    }
    if (!seen.has(token)) { seen.add(token); usernames.push(token); }
  }
  return { usernames, invalid };
}

// Each gap differs: from 0.4× to 1.6× the campaign's gap, averaging the gap
// itself, so the day's total stays the same (random() 0.5 gives the set gap).
function gapFactor(r) {
  return r < 0.5 ? 0.4 + 1.2 * r : 1 + 1.2 * (r - 0.5);
}

function checkHours(env) {
  const raw = String(env.DM_CHECK_HOURS ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_CHECK_HOURS;
  if (raw === "none" || raw === "off") return [];
  const hours = [...new Set(raw.split(/[\s,]+/).map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b);
  return hours.length ? hours : DEFAULT_CHECK_HOURS;
}

function istDayStart(date) {
  const shifted = new Date(date.getTime() + IST);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST);
}
function inWindow(date, start, end) {
  const hour = new Date(date.getTime() + IST).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
// The next moment after `date` when the clock in India shows hour:00.
function nextHourAt(date, hour) {
  const candidate = istDayStart(date).getTime() + hour * 3600000;
  return new Date(candidate > date.getTime() ? candidate : candidate + DAY);
}

function integer(value, min, max) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

// Campaign settings from a request; `current` fills in fields left out.
// proxy: a two-letter country for Browser Use's residential proxy, or "none".
const PROXY = /^([a-z]{2}|none)$/;
function readSettings(body, current = null, defaultProxy = "in") {
  const pick = (key, fallback) => (body[key] !== undefined ? body[key] : fallback);
  const name = typeof pick("name", current?.name) === "string" ? pick("name", current?.name).trim() : "";
  const profileId = typeof pick("profile_id", current?.profile_id) === "string" ? pick("profile_id", current?.profile_id).trim().toLowerCase() : "";
  const rawProfileName = pick("profile_name", current?.profile_name ?? null);
  const message = typeof pick("message", current?.message) === "string" ? pick("message", current?.message).replace(/\r\n?/g, "\n").trim() : "";
  const settings = {
    name, profileId, message,
    profileName: typeof rawProfileName === "string" && rawProfileName.trim() ? rawProfileName.trim().slice(0, 120) : null,
    dailyLimit: integer(pick("daily_limit", current?.daily_limit ?? 100), 1, 200),
    gapMinutes: integer(pick("gap_minutes", current ? Math.round(current.gap_seconds / 60) : 9), 2, 60),
    startHour: integer(pick("start_hour", current?.start_hour ?? 8), 0, 23),
    endHour: integer(pick("end_hour", current?.end_hour ?? 23), 1, 24),
    proxy: String(pick("proxy", current?.proxy ?? defaultProxy) ?? "").trim().toLowerCase(),
    warmup: pick("warmup", current?.warmup ?? true)
  };
  const variants = messageVariants(message);
  const messageOk = variants.length >= 1 && variants.length <= MAX_VARIANTS && [...message].length <= MAX_VARIANTS * 500 &&
    variants.every((variant) => [...renderMessage(variant, "x".repeat(30))].length <= MAX_MESSAGE);
  if (!name || name.length > 60 || !UUID.test(profileId) || !messageOk || !PROXY.test(settings.proxy) || typeof settings.warmup !== "boolean" ||
      settings.dailyLimit === null || settings.gapMinutes === null || settings.startHour === null ||
      settings.endHour === null || settings.startHour === settings.endHour % 24) {
    throw new AppError(400, "invalid_campaign");
  }
  return settings;
}

// Kilobytes a DM downloaded, and the biggest resource types, for the log.
function summarizeUsage(usage) {
  if (!usage || !Number.isFinite(usage.bytes)) return null;
  const types = Object.entries(usage.byType || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([type, bytes]) => [type, Math.round(bytes / 1024)]);
  return { kb: Math.round(usage.bytes / 1024), kb_by_type: Object.fromEntries(types) };
}

// What the browser said when a step failed (e.g. "net::ERR_TUNNEL_CONNECTION_FAILED"
// for a page that would not load), for the log; never anything typed or read from a chat.
function errorDetail(error) {
  const text = String(error?.message || "");
  const detail = error?.code && text.startsWith(`${error.code}: `) ? text.slice(error.code.length + 2) : "";
  return detail ? { detail: detail.slice(0, 200) } : {};
}

function usdInrRate(env) {
  const rate = Number(env.DM_USD_INR);
  return Number.isFinite(rate) && rate >= 50 && rate <= 200 ? rate : 96.5;
}

// onEvent(event, details): "paused" { name, reason, detail }, "completed"
// { name }, and "checked" { requested, outcome, account, fresh, waiting } after
// an inbox check, for alerts (lib/telegram.js). Never awaited by the worker.
// onReply({ id, profile_id, username, name, text }) gets each new or changed
// reply (lib/leads.js picks up WhatsApp numbers and Telegram IDs from it).
function createDmSender({ db, env = {}, fetchImpl = fetch, log = () => {}, driver = null, client = null, now = () => new Date(), random = Math.random, onEvent = () => {}, onReply = null }) {
  const apiKey = typeof env.BROWSER_USE_API_KEY === "string" ? env.BROWSER_USE_API_KEY.trim() : "";
  const browserUse = client || (apiKey ? createBrowserUseClient({ apiKey, fetchImpl }) : null);
  // DM_SEND_METHOD=profile goes back to opening each profile (more data per DM).
  const instagram = driver || createInstagramDriver({ fetchImpl, method: env.DM_SEND_METHOD === "profile" ? "profile" : "inbox" });
  const rate = usdInrRate(env);
  const scheduledHours = checkHours(env);
  // The proxy a new campaign starts with (each campaign can change it).
  const defaultProxy = PROXY.test(String(env.DM_PROXY_COUNTRY || "").toLowerCase()) ? env.DM_PROXY_COUNTRY.toLowerCase() : "in";
  const owner = crypto.randomUUID();
  const browsers = new Map(); // profile id -> { id, campaignId (null: opened for replies), proxy, session, startedAt, usedAt }
  let recovered = false;
  let stopping = false;
  const emit = (event, details) => { Promise.resolve().then(() => onEvent(event, details)).catch(() => {}); };
  let running = null;

  function requireClient() { if (!browserUse) throw new AppError(503, "dm_not_configured"); }
  function campaignId(value) {
    if (!validId(value) || value.length > 18) throw new AppError(400, "campaign_not_found");
    return value;
  }
  function upstream(error) {
    if (error instanceof AppError) return error;
    return new AppError(502, typeof error?.code === "string" && error.code.startsWith("browser_use_") ? error.code : "browser_use_failed");
  }

  // ---- Owner-facing store ----

  async function summaries(onlyId = null) {
    const since = istDayStart(now());
    const result = await db.query(
      `SELECT c.id::text AS id,c.name,c.profile_id::text AS profile_id,c.profile_name,c.message,c.daily_limit,c.gap_seconds,c.warmup,
        c.start_hour,c.end_hour,c.proxy,c.stop_after,c.sent_since_start,c.status,c.pause_reason,c.pause_detail,c.next_send_at,c.created_at,
        COUNT(t.id)::int AS total,
        COUNT(t.id) FILTER (WHERE t.status IN ('pending','sending'))::int AS pending,
        COUNT(t.id) FILTER (WHERE t.status='sent')::int AS sent,
        COUNT(t.id) FILTER (WHERE t.status='skipped')::int AS skipped,
        COUNT(t.id) FILTER (WHERE t.status='failed')::int AS failed,
        COUNT(t.id) FILTER (WHERE t.status='sent' AND t.sent_at>=$1)::int AS sent_today
       FROM dm_campaigns c LEFT JOIN dm_targets t ON t.campaign_id=c.id
       WHERE ($2::bigint IS NULL OR c.id=$2::bigint)
       GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`, [since, onlyId]);
    const costs = await db.query(
      `SELECT campaign_id::text AS campaign_id, SUM(proxy_mb)::float8 AS proxy_mb, SUM(proxy_cost_usd)::float8 AS proxy_usd,
        SUM(CASE WHEN status='active' THEN GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz-started_at)),0)/3600*0.02 ELSE browser_cost_usd END)::float8 AS browser_usd,
        BOOL_OR(status='active') AS active
       FROM dm_browsers WHERE campaign_id IS NOT NULL GROUP BY campaign_id`, [now()]);
    const byCampaign = new Map(costs.rows.map((row) => [row.campaign_id, row]));
    const warmups = new Map();
    for (const row of result.rows) if (row.warmup && !warmups.has(row.profile_id)) warmups.set(row.profile_id, await warmupLimit(row.profile_id));
    return result.rows.map((row) => {
      const warm = row.warmup ? warmups.get(row.profile_id) : null;
      const cost = byCampaign.get(row.id) || { proxy_mb: 0, proxy_usd: 0, browser_usd: 0, active: false };
      const usd = Number(cost.proxy_usd || 0) + Number(cost.browser_usd || 0);
      const inr = Math.round(usd * rate * 100) / 100;
      return {
        id: row.id, name: row.name, profile_id: row.profile_id, profile_name: row.profile_name, message: row.message,
        daily_limit: row.daily_limit, gap_minutes: Math.round(row.gap_seconds / 60), start_hour: row.start_hour, end_hour: row.end_hour,
        // With warm-up: today's real limit, and when it next goes up (and to what).
        warmup: row.warmup, today_limit: warm ? Math.min(row.daily_limit, warm.limit) : row.daily_limit,
        warmup_next: warm && warm.limit < row.daily_limit ? { at: warm.next_at, limit: Math.min(row.daily_limit, warm.limit + WARMUP_STEP) } : null,
        warmup_reset: Boolean(warm?.warned),
        proxy: row.proxy, stop_after: row.stop_after, sent_since_start: row.sent_since_start, status: row.status,
        pause_reason: row.pause_reason, pause_detail: row.pause_detail, next_send_at: row.next_send_at, created_at: row.created_at,
        counts: { total: row.total, pending: row.pending, sent: row.sent, skipped: row.skipped, failed: row.failed, sent_today: row.sent_today },
        cost: {
          inr, usd: Math.round(usd * 10000) / 10000, proxy_mb: Math.round(Number(cost.proxy_mb || 0) * 10) / 10,
          per_dm_inr: row.sent ? Math.round((inr / row.sent) * 100) / 100 : null
        },
        browser_active: Boolean(cost.active)
      };
    });
  }

  async function summary(id) {
    const [row] = await summaries(id);
    if (!row) throw new AppError(404, "campaign_not_found");
    return row;
  }

  // Adds usernames at the end of the list. Anyone already messaged from any
  // campaign is listed as skipped instead of being messaged again.
  async function insertTargets(tx, id, usernames) {
    const last = await tx.query("SELECT COALESCE(MAX(position),0)::int AS last FROM dm_targets WHERE campaign_id=$1", [id]);
    const result = await tx.query(
      `INSERT INTO dm_targets(campaign_id,username,position,status,reason)
       SELECT $1::bigint, u.username, $2::int + u.ord::int,
         CASE WHEN EXISTS (SELECT 1 FROM dm_targets s WHERE s.username=u.username AND s.status='sent') THEN 'skipped' ELSE 'pending' END,
         CASE WHEN EXISTS (SELECT 1 FROM dm_targets s WHERE s.username=u.username AND s.status='sent') THEN 'already_contacted' ELSE NULL END
       FROM unnest($3::text[]) WITH ORDINALITY AS u(username, ord)
       ON CONFLICT (campaign_id, username) DO NOTHING
       RETURNING status`, [id, last.rows[0].last, usernames]);
    return {
      added: result.rows.filter((row) => row.status === "pending").length,
      already_contacted: result.rows.filter((row) => row.status === "skipped").length,
      already_listed: usernames.length - result.rows.length
    };
  }

  async function createCampaign(body) {
    const settings = readSettings(body, null, defaultProxy);
    if (body.requested_contact !== true) throw new AppError(400, "contact_not_confirmed");
    const { usernames, invalid } = parseUsernames(body.usernames);
    if (!usernames.length) throw new AppError(400, "invalid_usernames");
    if (usernames.length > MAX_TARGETS) throw new AppError(400, "too_many_usernames");
    const created = await db.transaction(async (tx) => {
      const row = (await tx.query(
        `INSERT INTO dm_campaigns(name,profile_id,profile_name,message,daily_limit,gap_seconds,start_hour,end_hour,proxy,warmup,status,pause_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paused','not_started') RETURNING id::text AS id`,
        [settings.name, settings.profileId, settings.profileName, settings.message, settings.dailyLimit,
          settings.gapMinutes * 60, settings.startHour, settings.endHour, settings.proxy, settings.warmup])).rows[0];
      return { id: row.id, ...(await insertTargets(tx, row.id, usernames)) };
    });
    log("dm_campaign_created", { campaign: created.id, targets: usernames.length });
    return { campaign: await summary(created.id), added: created.added, already_contacted: created.already_contacted, invalid };
  }

  async function addTargets(rawId, body) {
    const id = campaignId(rawId);
    const { usernames, invalid } = parseUsernames(body.usernames);
    if (!usernames.length) throw new AppError(400, "invalid_usernames");
    const result = await db.transaction(async (tx) => {
      const row = (await tx.query("SELECT status FROM dm_campaigns WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new AppError(404, "campaign_not_found");
      const total = (await tx.query("SELECT COUNT(*)::int AS count FROM dm_targets WHERE campaign_id=$1", [id])).rows[0].count;
      if (total + usernames.length > MAX_TARGETS) throw new AppError(400, "too_many_usernames");
      const added = await insertTargets(tx, id, usernames);
      if (row.status === "completed" && added.added) {
        await tx.query("UPDATE dm_campaigns SET status='paused',pause_reason='not_started',updated_at=NOW() WHERE id=$1", [id]);
      }
      return added;
    });
    return { campaign: await summary(id), ...result, invalid };
  }

  async function updateCampaign(rawId, body) {
    const id = campaignId(rawId);
    await db.transaction(async (tx) => {
      const current = (await tx.query("SELECT * FROM dm_campaigns WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!current) throw new AppError(404, "campaign_not_found");
      if (current.status === "running") throw new AppError(409, "campaign_running");
      const settings = readSettings(body, { ...current, profile_id: String(current.profile_id) }, defaultProxy);
      await tx.query(
        `UPDATE dm_campaigns SET name=$2,profile_id=$3,profile_name=$4,message=$5,daily_limit=$6,gap_seconds=$7,start_hour=$8,end_hour=$9,
         proxy=$10,warmup=$11,updated_at=NOW() WHERE id=$1`, [id, settings.name, settings.profileId, settings.profileName, settings.message, settings.dailyLimit,
          settings.gapMinutes * 60, settings.startHour, settings.endHour, settings.proxy, settings.warmup]);
    });
    return { campaign: await summary(id) };
  }

  async function startCampaign(rawId, body) {
    const id = campaignId(rawId);
    requireClient();
    const stopAfter = body.stop_after === undefined || body.stop_after === null || body.stop_after === "" ? null : integer(body.stop_after, 1, 1000);
    if (stopAfter === null && body.stop_after !== undefined && body.stop_after !== null && body.stop_after !== "") throw new AppError(400, "invalid_campaign");
    await db.transaction(async (tx) => {
      const current = (await tx.query("SELECT profile_id::text AS profile_id FROM dm_campaigns WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!current) throw new AppError(404, "campaign_not_found");
      const busy = await tx.query("SELECT 1 FROM dm_campaigns WHERE profile_id=$1 AND status='running' AND id<>$2", [current.profile_id, id]);
      if (busy.rows.length) throw new AppError(409, "profile_busy");
      // The creator finder's own login never sends DMs.
      const finder = await tx.query("SELECT 1 FROM finder_runs WHERE profile_id=$1 LIMIT 1", [current.profile_id]);
      if (finder.rows.length) throw new AppError(409, "profile_is_finder");
      const pending = await tx.query("SELECT 1 FROM dm_targets WHERE campaign_id=$1 AND status IN ('pending','sending') LIMIT 1", [id]);
      if (!pending.rows.length) throw new AppError(409, "nothing_to_send");
      await tx.query(
        `UPDATE dm_campaigns SET status='running',pause_reason=NULL,pause_detail=NULL,stop_after=$2,sent_since_start=0,
         consecutive_errors=0,next_send_at=$3,updated_at=NOW() WHERE id=$1`, [id, stopAfter, now()]);
    });
    log("dm_campaign_started", { campaign: id, ...(stopAfter ? { stop_after: stopAfter } : {}) });
    return { campaign: await summary(id) };
  }

  async function pauseCampaign(rawId) {
    const id = campaignId(rawId);
    await db.query("UPDATE dm_campaigns SET status='paused',pause_reason='owner',pause_detail=NULL,updated_at=NOW() WHERE id=$1 AND status='running'", [id]);
    return { campaign: await summary(id) };
  }

  async function retryFailed(rawId) {
    const id = campaignId(rawId);
    await summary(id);
    const result = await db.query("UPDATE dm_targets SET status='pending',reason=NULL,updated_at=NOW() WHERE campaign_id=$1 AND status='failed' RETURNING id", [id]);
    if (result.rows.length) {
      await db.query("UPDATE dm_campaigns SET status='paused',pause_reason='not_started',updated_at=NOW() WHERE id=$1 AND status='completed'", [id]);
    }
    return { campaign: await summary(id), retried: result.rows.length };
  }

  async function deleteCampaign(rawId) {
    const id = campaignId(rawId);
    const result = await db.query("DELETE FROM dm_campaigns WHERE id=$1 AND status<>'running' RETURNING id", [id]);
    if (!result.rows.length) {
      await summary(id);
      throw new AppError(409, "campaign_running");
    }
    return { ok: true };
  }

  async function getCampaign(rawId) {
    const id = campaignId(rawId);
    const campaign = await summary(id);
    const targets = await db.query(
      "SELECT username,status,reason,attempts,sent_at,updated_at FROM dm_targets WHERE campaign_id=$1 ORDER BY position", [id]);
    return { campaign, targets: targets.rows };
  }

  // Today in India: DMs sent and what every DM browser (campaigns and replies)
  // started today has cost so far.
  async function today() {
    const since = istDayStart(now());
    const sent = (await db.query("SELECT COUNT(*)::int AS count FROM dm_targets WHERE status='sent' AND sent_at>=$1", [since])).rows[0].count;
    const cost = (await db.query(
      `SELECT COALESCE(SUM(proxy_cost_usd),0)::float8 AS proxy_usd,
        COALESCE(SUM(CASE WHEN status='active' THEN GREATEST(EXTRACT(EPOCH FROM ($2::timestamptz-started_at)),0)/3600*0.02 ELSE browser_cost_usd END),0)::float8 AS browser_usd
       FROM dm_browsers WHERE started_at>=$1`, [since, now()])).rows[0];
    return { sent, cost_inr: Math.round((Number(cost.proxy_usd) + Number(cost.browser_usd)) * rate * 100) / 100 };
  }

  async function status() {
    return { configured: Boolean(browserUse), usd_inr: rate, campaigns: await summaries(), today: await today() };
  }

  // ---- Hisaab: how each account and each message version is doing ----

  const percent = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
  const rupees = (usd) => Math.round(Number(usd || 0) * rate * 100) / 100;

  // DMs sent between since and until (since null: from the start), per account
  // and per message version: how many reached the person, how many of those
  // people replied (at any time since), and what the account's browsers cost.
  async function stats({ since = null, until = null } = {}) {
    const from = since ? new Date(since) : new Date(0);
    const to = until ? new Date(until) : now();
    const groups = (await db.query(
      `SELECT profile_id, campaign_id, campaign_name, message, variant,
         COUNT(*) FILTER (WHERE status='sent')::int AS sent,
         COUNT(*) FILTER (WHERE reason='not_delivered')::int AS not_delivered,
         COUNT(*) FILTER (WHERE status='sent' AND replied)::int AS replied
       FROM (SELECT COALESCE(t.sent_profile,c.profile_id)::text AS profile_id, c.id::text AS campaign_id, c.name AS campaign_name, c.message,
               t.variant, t.status, t.reason,
               EXISTS (SELECT 1 FROM dm_replies r WHERE r.profile_id=COALESCE(t.sent_profile,c.profile_id) AND r.username=t.username
                 AND r.status<>'undelivered') AS replied
             FROM dm_targets t JOIN dm_campaigns c ON c.id=t.campaign_id
             WHERE t.sent_at>=$1 AND t.sent_at<$2 AND (t.status='sent' OR t.reason='not_delivered')) x
       GROUP BY profile_id, campaign_id, campaign_name, message, variant`, [from, to])).rows;
    const costs = (await db.query(
      `SELECT profile_id::text AS profile_id, COALESCE(SUM(proxy_cost_usd),0)::float8 AS proxy_usd,
         COALESCE(SUM(CASE WHEN status='active' THEN GREATEST(EXTRACT(EPOCH FROM ($3::timestamptz-started_at)),0)/3600*0.02 ELSE browser_cost_usd END),0)::float8 AS browser_usd
       FROM dm_browsers WHERE started_at>=$1 AND started_at<$2 GROUP BY profile_id`, [from, to, now()])).rows;
    const names = new Map((await db.query(
      `SELECT p.profile_id, i.account, i.last_warning_at,
         (SELECT profile_name FROM dm_campaigns WHERE profile_id::text=p.profile_id AND profile_name IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS profile_name
       FROM (SELECT DISTINCT profile_id::text AS profile_id FROM dm_campaigns UNION SELECT profile_id::text FROM dm_inboxes UNION SELECT profile_id::text FROM dm_browsers) p
       LEFT JOIN dm_inboxes i ON i.profile_id::text=p.profile_id`)).rows.map((row) => [row.profile_id, row]));
    const received = (await db.query("SELECT COUNT(*)::int AS count FROM dm_replies WHERE status<>'undelivered' AND received_at>=$1 AND received_at<$2", [from, to])).rows[0].count;
    const answered = (await db.query("SELECT COUNT(*)::int AS count FROM dm_outbox WHERE status='sent' AND sent_at>=$1 AND sent_at<$2", [from, to])).rows[0].count;

    const accounts = new Map();
    const account = (profileId) => {
      if (!accounts.has(profileId)) {
        const info = names.get(profileId) || {};
        accounts.set(profileId, { profile_id: profileId, account: info.account || null, name: info.profile_name || null,
          warned_at: info.last_warning_at || null, sent: 0, not_delivered: 0, replied: 0, cost_inr: 0 });
      }
      return accounts.get(profileId);
    };
    const versions = new Map();
    for (const row of groups) {
      const item = account(row.profile_id);
      item.sent += row.sent; item.not_delivered += row.not_delivered; item.replied += row.replied;
      const key = `${row.campaign_id}\u0000${row.variant ?? ""}`;
      if (!versions.has(key)) {
        versions.set(key, { campaign_id: row.campaign_id, campaign_name: row.campaign_name, text: row.variant,
          current: row.variant !== null && messageVariants(row.message).includes(row.variant), sent: 0, not_delivered: 0, replied: 0 });
      }
      const version = versions.get(key);
      version.sent += row.sent; version.not_delivered += row.not_delivered; version.replied += row.replied;
    }
    for (const row of costs) account(row.profile_id).cost_inr = rupees(Number(row.proxy_usd) + Number(row.browser_usd));
    const finish = (item) => ({ ...item, reply_rate: percent(item.replied, item.sent), ...(item.cost_inr !== undefined ? { per_reply_inr: item.replied ? Math.round((item.cost_inr / item.replied) * 100) / 100 : null } : {}) });
    const list = [...accounts.values()].map(finish).sort((a, b) => b.sent - a.sent || b.cost_inr - a.cost_inr);
    const totals = list.reduce((sum, item) => ({ sent: sum.sent + item.sent, not_delivered: sum.not_delivered + item.not_delivered,
      replied: sum.replied + item.replied, cost_inr: Math.round((sum.cost_inr + item.cost_inr) * 100) / 100 }), { sent: 0, not_delivered: 0, replied: 0, cost_inr: 0 });
    return {
      since: since ? from : null, until: to,
      totals: { ...finish(totals), replies_received: received, answers_sent: answered },
      accounts: list,
      versions: [...versions.values()].map((item) => ({ ...item, reply_rate: percent(item.replied, item.sent) }))
        .sort((a, b) => b.sent - a.sent)
    };
  }

  // The website's Hisaab: "1" (today in India), "7", "30" days, or everything.
  async function statsFor(period) {
    const current = now();
    const since = period === "1" ? istDayStart(current) : period === "7" || period === "30" ? new Date(current.getTime() - Number(period) * DAY) : null;
    return { period: since ? period : "all", ...(await stats({ since, until: current })) };
  }

  // Browser Use profiles. Campaigns and finder runs keep the profile's name from
  // when they were saved, so a profile renamed in Browser Use gets its new name
  // here too ("renamed" counts the rows changed, so the website can refresh).
  async function listProfiles() {
    requireClient();
    let profiles;
    try { profiles = await browserUse.listProfiles(); } catch (error) { throw upstream(error); }
    let renamed = 0;
    for (const profile of profiles) {
      if (!profile.name || !profile.name.trim()) continue;
      for (const table of ["dm_campaigns", "finder_runs"]) {
        renamed += (await db.query(`UPDATE ${table} SET profile_name=$2 WHERE profile_id=$1 AND profile_name IS DISTINCT FROM $2`,
          [profile.id, profile.name.trim()])).rowCount;
      }
    }
    if (renamed) log("dm_profiles_renamed", { rows: renamed });
    return { profiles, renamed };
  }

  // ---- Replies (owner side): per Instagram account ----

  function replyId(value) {
    if (!validId(value) || value.length > 18) throw new AppError(404, "reply_not_found");
    return value;
  }

  // Accounts (any profile with a campaign or a checked inbox), each with its
  // last check, new replies and what reply checks cost; then the replies
  // (new first) with the answers typed for each.
  async function replies() {
    const accounts = new Map();
    const add = (profileId) => {
      if (!accounts.has(profileId)) {
        accounts.set(profileId, { profile_id: profileId, name: null, account: null, checked_at: null, checking: false,
          check_status: null, check_detail: null, new: 0, answering: 0, cost_inr: 0, browser_active: false });
      }
      return accounts.get(profileId);
    };
    for (const row of (await db.query("SELECT profile_id::text AS profile_id,profile_name FROM dm_campaigns ORDER BY created_at,id")).rows) {
      const item = add(row.profile_id);
      item.name = row.profile_name || item.name;
    }
    for (const row of (await db.query(
      "SELECT profile_id::text AS profile_id,account,check_requested_at,checked_at,check_status,check_detail FROM dm_inboxes")).rows) {
      Object.assign(add(row.profile_id), { account: row.account, checked_at: row.checked_at, checking: Boolean(row.check_requested_at),
        check_status: row.check_status, check_detail: row.check_detail });
    }
    for (const row of (await db.query(
      "SELECT profile_id::text AS profile_id,COUNT(*) FILTER (WHERE status='new')::int AS fresh FROM dm_replies GROUP BY profile_id")).rows) {
      add(row.profile_id).new = row.fresh;
    }
    for (const row of (await db.query(
      "SELECT profile_id::text AS profile_id,COUNT(*)::int AS count FROM dm_outbox WHERE status IN ('pending','sending') GROUP BY profile_id")).rows) {
      add(row.profile_id).answering = row.count;
    }
    const costs = await db.query(
      `SELECT profile_id::text AS profile_id, SUM(proxy_cost_usd)::float8 AS proxy_usd,
        SUM(CASE WHEN status='active' THEN GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz-started_at)),0)/3600*0.02 ELSE browser_cost_usd END)::float8 AS browser_usd,
        BOOL_OR(status='active') AS active
       FROM dm_browsers WHERE campaign_id IS NULL GROUP BY profile_id`, [now()]);
    for (const row of costs.rows) {
      const item = add(row.profile_id);
      item.cost_inr = Math.round((Number(row.proxy_usd || 0) + Number(row.browser_usd || 0)) * rate * 100) / 100;
      item.browser_active = Boolean(row.active);
    }
    const list = (await db.query(
      `SELECT r.id::text AS id,r.profile_id::text AS profile_id,r.username,r.name,r.text,r.status,r.received_at,
        EXISTS (SELECT 1 FROM creator_leads l WHERE l.username=r.username) AS joined
       FROM dm_replies r WHERE r.status<>'undelivered' ORDER BY (r.status='new') DESC, r.received_at DESC, r.id DESC LIMIT 300`)).rows;
    const answers = list.length ? (await db.query(
      `SELECT id::text AS id,reply_id::text AS reply_id,message,status,reason,created_at,sent_at FROM dm_outbox
       WHERE reply_id = ANY($1::bigint[]) ORDER BY id`, [list.map((row) => row.id)])).rows : [];
    for (const row of list) add(row.profile_id);
    return {
      configured: Boolean(browserUse),
      accounts: [...accounts.values()],
      replies: list.map((row) => ({ ...row, answers: answers.filter((answer) => answer.reply_id === row.id).map(({ reply_id, ...answer }) => answer) }))
    };
  }

  async function requestCheck(body) {
    requireClient();
    const profileId = typeof body.profile_id === "string" ? body.profile_id.trim().toLowerCase() : "";
    if (!UUID.test(profileId)) throw new AppError(400, "invalid_profile");
    const known = await db.query(
      "SELECT 1 FROM dm_campaigns WHERE profile_id=$1 UNION ALL SELECT 1 FROM dm_inboxes WHERE profile_id=$1 LIMIT 1", [profileId]);
    if (!known.rows.length) throw new AppError(404, "profile_not_found");
    await db.query(
      `INSERT INTO dm_inboxes(profile_id,check_requested_at) VALUES($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET check_requested_at=EXCLUDED.check_requested_at,retry_at=NULL`, [profileId, now()]);
    log("dm_replies_check_requested", {});
    return replies();
  }

  // The owner's answer to someone who wrote back; the worker sends it from the
  // same account. Never more than 3 waiting per person.
  async function answerReply(rawId, body) {
    requireClient();
    const id = replyId(rawId);
    const message = typeof body.message === "string" ? body.message.replace(/\r\n?/g, "\n").trim() : "";
    if (!message || [...message].length > MAX_ANSWER) throw new AppError(400, "invalid_answer");
    const reply = (await db.query("SELECT profile_id::text AS profile_id FROM dm_replies WHERE id=$1 AND status<>'undelivered'", [id])).rows[0];
    if (!reply) throw new AppError(404, "reply_not_found");
    const waiting = (await db.query("SELECT COUNT(*)::int AS count FROM dm_outbox WHERE reply_id=$1 AND status IN ('pending','sending')", [id])).rows[0];
    if (waiting.count >= MAX_WAITING_ANSWERS) throw new AppError(409, "answers_waiting");
    await db.query("INSERT INTO dm_outbox(reply_id,profile_id,message,created_at,updated_at) VALUES($1,$2,$3,$4,$4)",
      [id, reply.profile_id, message, now()]);
    await db.query("UPDATE dm_inboxes SET retry_at=NULL WHERE profile_id=$1", [reply.profile_id]);
    log("dm_answer_queued", {});
    return replies();
  }

  async function closeReply(rawId) {
    const id = replyId(rawId);
    const result = await db.query("UPDATE dm_replies SET status='done',updated_at=NOW() WHERE id=$1 RETURNING id", [id]);
    if (!result.rows.length) throw new AppError(404, "reply_not_found");
    return replies();
  }

  // ---- Warm-up ----

  // This account's warm-up limit today: counted in whole weeks from its first
  // DM, or from its last Instagram warning (which starts again lower).
  async function warmupLimit(profileId) {
    const first = (await db.query(
      `SELECT MIN(t.sent_at) AS first FROM dm_targets t JOIN dm_campaigns c ON c.id=t.campaign_id
       WHERE c.profile_id=$1 AND t.sent_at IS NOT NULL`, [profileId])).rows[0]?.first;
    const warned = (await db.query("SELECT last_warning_at FROM dm_inboxes WHERE profile_id=$1", [profileId])).rows[0]?.last_warning_at;
    const current = now();
    const reset = Boolean(warned && (!first || new Date(warned) >= new Date(first)));
    const since = reset ? new Date(warned) : first ? new Date(first) : current;
    const weeks = Math.max(0, Math.floor((current - since) / WEEK));
    return { limit: (reset ? WARMUP_AFTER_WARNING : WARMUP_START) + WARMUP_STEP * weeks, next_at: new Date(since.getTime() + (weeks + 1) * WEEK), warned: reset };
  }

  async function noteWarning(profileId, reason) {
    if (!WARNINGS.has(reason)) return;
    await db.query(
      `INSERT INTO dm_inboxes(profile_id,last_warning_at) VALUES($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET last_warning_at=EXCLUDED.last_warning_at`, [profileId, now()]);
    log("dm_warmup_reset", { reason });
  }

  // ---- Worker ----

  async function acquireLease() {
    const current = now();
    const result = await db.query(
      `INSERT INTO dm_worker_lease(id,owner,expires_at) VALUES(1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
       WHERE dm_worker_lease.owner=$1 OR dm_worker_lease.expires_at<$3 RETURNING owner`,
      [owner, new Date(current.getTime() + LEASE_MS), current]);
    return result.rows.length > 0;
  }

  async function finishBrowser(id) {
    let final = null;
    try { final = await browserUse.stopBrowser(id); }
    catch (error) {
      // Try again on a later tick unless Browser Use no longer knows it.
      if (error.code !== "browser_use_not_found") { log("dm_browser_stop_failed", { reason: error.code || "error" }); return; }
    }
    try { final = await browserUse.getBrowser(id); } catch { /* keep what stop returned */ }
    if (final) {
      await db.query(
        `UPDATE dm_browsers SET status='stopped',stopped_at=COALESCE(stopped_at,$2),proxy_mb=GREATEST(proxy_mb,$3),
         proxy_cost_usd=GREATEST(proxy_cost_usd,$4),browser_cost_usd=$5 WHERE id=$1`,
        [id, now(), final.proxyMb, final.proxyCostUsd, final.browserCostUsd]);
    } else {
      await db.query("UPDATE dm_browsers SET status='stopped',stopped_at=COALESCE(stopped_at,$2) WHERE id=$1", [id, now()]);
    }
  }

  async function closeBrowser(profileId) {
    const entry = browsers.get(profileId);
    if (!entry) return;
    browsers.delete(profileId);
    try { entry.session.close(); } catch { /* already closed */ }
    await finishBrowser(entry.id);
    log("dm_browser_stopped", { campaign: entry.campaignId });
  }

  async function openBrowser(profileId, campaignId, proxy) {
    const purpose = campaignId ? { campaign: campaignId } : { purpose: "replies" };
    const created = await browserUse.createBrowser({
      profileId, proxyCountryCode: proxy === "none" ? null : proxy, timeoutMinutes: BROWSER_MINUTES,
      metadata: { app: "dm-sender", ...purpose }
    });
    await db.query("INSERT INTO dm_browsers(id,profile_id,campaign_id,started_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
      [created.id, profileId, campaignId, now()]);
    let session;
    try { session = await instagram.open(created.cdpUrl); }
    catch (error) {
      await finishBrowser(created.id);
      throw Object.assign(new Error("browser_connect_failed"), { code: "browser_connect_failed", cause: error });
    }
    const entry = { id: created.id, campaignId, proxy, session, startedAt: now(), usedAt: now() };
    browsers.set(profileId, entry);
    log("dm_browser_started", { ...purpose, proxy });
    return entry;
  }

  const usable = (entry) => entry.session.alive() && now() - entry.startedAt < BROWSER_ROTATE_MS;

  async function ensureBrowser(campaign) {
    const current = browsers.get(campaign.profile_id);
    if (current && current.proxy === campaign.proxy && usable(current)) {
      if (current.campaignId === campaign.id) return current;
      // A browser opened for replies carries on with the campaign (no second load).
      if (current.campaignId === null) {
        current.campaignId = campaign.id;
        await db.query("UPDATE dm_browsers SET campaign_id=$2 WHERE id=$1", [current.id, campaign.id]);
        return current;
      }
    }
    if (current) await closeBrowser(campaign.profile_id);
    return openBrowser(campaign.profile_id, campaign.id, campaign.proxy);
  }

  async function recordUsage(entry, sent) {
    let info = null;
    try { info = await browserUse.getBrowser(entry.id); } catch { /* counted when it stops */ }
    if (info) {
      await db.query("UPDATE dm_browsers SET dms_sent=dms_sent+$2,proxy_mb=$3,proxy_cost_usd=$4 WHERE id=$1",
        [entry.id, sent ? 1 : 0, info.proxyMb, info.proxyCostUsd]);
    } else if (sent) {
      await db.query("UPDATE dm_browsers SET dms_sent=dms_sent+1 WHERE id=$1", [entry.id]);
    }
  }

  const setNext = (id, date) => db.query("UPDATE dm_campaigns SET next_send_at=$2,updated_at=NOW() WHERE id=$1", [id, date]);
  const settle = (target, state, reason) => db.query("UPDATE dm_targets SET status=$2,reason=$3,updated_at=NOW() WHERE id=$1", [target.id, state, reason]);
  const release = (target) => db.query("UPDATE dm_targets SET status='pending',attempts=GREATEST(attempts-1,0),updated_at=NOW() WHERE id=$1 AND status='sending'", [target.id]);

  async function pause(id, reason, detail = null) {
    const text = detail ? String(detail).slice(0, 200) : null;
    const row = (await db.query(
      "UPDATE dm_campaigns SET status='paused',pause_reason=$2,pause_detail=$3,updated_at=NOW() WHERE id=$1 AND status='running' RETURNING name,profile_id::text AS profile_id",
      [id, reason, text])).rows[0];
    log("dm_campaign_paused", { campaign: id, reason });
    if (row) {
      await noteWarning(row.profile_id, reason);
      emit("paused", { name: row.name, reason, detail: text });
    }
  }

  async function countError(campaign, reason, next) {
    const row = (await db.query(
      "UPDATE dm_campaigns SET consecutive_errors=consecutive_errors+1,next_send_at=$2,updated_at=NOW() WHERE id=$1 RETURNING consecutive_errors",
      [campaign.id, next])).rows[0];
    if (row && row.consecutive_errors >= MAX_ERRORS) {
      await pause(campaign.id, "too_many_errors", reason);
      await closeBrowser(campaign.profile_id);
    }
  }

  async function applyResult(campaign, target, result) {
    const current = now();
    const gap = new Date(current.getTime() + Math.round(campaign.gap_seconds * 1000 * gapFactor(random())));
    if (result.status === "sent") {
      await db.query("UPDATE dm_targets SET status='sent',reason=NULL,sent_at=$2,variant=$3,sent_profile=$4,updated_at=NOW() WHERE id=$1",
        [target.id, current, result.variant ?? null, campaign.profile_id]);
      const row = (await db.query(
        `UPDATE dm_campaigns SET sent_since_start=sent_since_start+1,consecutive_errors=0,next_send_at=$2,updated_at=NOW()
         WHERE id=$1 RETURNING sent_since_start,stop_after`, [campaign.id, gap])).rows[0];
      log("dm_sent", { campaign: campaign.id, ...(result.fallback ? { fallback: String(result.fallback).slice(0, 60) } : {}), ...(result.usage || {}) });
      if (row?.stop_after && row.sent_since_start >= row.stop_after) await pause(campaign.id, "test_done");
      return;
    }
    // Every message not sent is logged with its reason (and what the page
    // looked like, for a chat that did not open), so problems show in the log.
    log("dm_not_sent", { campaign: campaign.id, status: result.status, reason: result.reason || null,
      ...(result.detail ? { detail: String(result.detail).slice(0, 300) } : {}),
      ...(result.fallback ? { fallback: String(result.fallback).slice(0, 60) } : {}), ...(result.usage || {}) });
    // Instagram took the message but could not deliver it: no DM reached them,
    // yet for pacing and the daily limit it counts like one sent.
    if (result.status === "skipped" && result.reason === "not_delivered") {
      await db.query("UPDATE dm_targets SET status='skipped',reason='not_delivered',sent_at=$2,variant=$3,sent_profile=$4,updated_at=NOW() WHERE id=$1",
        [target.id, current, result.variant ?? null, campaign.profile_id]);
      await db.query("UPDATE dm_campaigns SET consecutive_errors=0,next_send_at=$2,updated_at=NOW() WHERE id=$1", [campaign.id, gap]);
      return;
    }
    if (result.status === "skipped") {
      await settle(target, "skipped", result.reason || "skipped");
      // Each skip searched Instagram; after a few in a row the next one waits a
      // normal gap, so a run of renamed accounts is not a burst of searches.
      const recent = (await db.query(
        `SELECT status FROM dm_targets WHERE campaign_id=$1 AND status IN ('sent','skipped','failed')
           AND COALESCE(reason,'') <> 'already_contacted' ORDER BY updated_at DESC, id DESC LIMIT $2`,
        [campaign.id, SKIP_STREAK])).rows;
      const streak = recent.length === SKIP_STREAK && recent.every((row) => row.status === "skipped");
      await setNext(campaign.id, streak ? gap : new Date(current.getTime() + SKIP_DELAY_MS));
      return;
    }
    if (result.status === "blocked") {
      if (result.attempted) await settle(target, "failed", "blocked_after_send"); else await release(target);
      await pause(campaign.id, result.reason || "action_blocked", result.text);
      await closeBrowser(campaign.profile_id);
      return;
    }
    await settle(target, "failed", result.reason || "failed");
    await countError(campaign, result.reason || "failed", gap);
  }

  async function processCampaign(campaign) {
    const current = now();
    if (new Date(campaign.next_send_at) > current) return;
    if (!inWindow(current, campaign.start_hour, campaign.end_hour)) {
      await setNext(campaign.id, nextHourAt(current, campaign.start_hour));
      return;
    }
    const today = (await db.query(
      "SELECT COUNT(*)::int AS count FROM dm_targets WHERE campaign_id=$1 AND (status='sent' OR reason='not_delivered') AND sent_at>=$2",
      [campaign.id, istDayStart(current)])).rows[0].count;
    const limit = campaign.warmup ? Math.min(campaign.daily_limit, (await warmupLimit(campaign.profile_id)).limit) : campaign.daily_limit;
    if (today >= limit) {
      let next = new Date(istDayStart(current).getTime() + DAY);
      if (!inWindow(next, campaign.start_hour, campaign.end_hour)) next = nextHourAt(next, campaign.start_hour);
      await setNext(campaign.id, next);
      return;
    }
    const target = (await db.query(
      `UPDATE dm_targets SET status='sending',attempts=attempts+1,updated_at=NOW()
       WHERE id=(SELECT id FROM dm_targets WHERE campaign_id=$1 AND status='pending' ORDER BY position LIMIT 1)
       RETURNING id::text AS id,username`, [campaign.id])).rows[0];
    if (!target) {
      const done = (await db.query(
        `UPDATE dm_campaigns SET status='completed',pause_reason=NULL,pause_detail=NULL,updated_at=NOW()
         WHERE id=$1 AND status='running' AND NOT EXISTS (SELECT 1 FROM dm_targets WHERE campaign_id=$1 AND status IN ('pending','sending'))
         RETURNING name`, [campaign.id])).rows[0];
      log("dm_campaign_completed", { campaign: campaign.id });
      if (done) emit("completed", { name: done.name });
      return;
    }
    const earlier = await db.query("SELECT 1 FROM dm_targets WHERE username=$1 AND status='sent' AND id<>$2 LIMIT 1", [target.username, target.id]);
    if (earlier.rows.length) {
      await settle(target, "skipped", "already_contacted");
      return;
    }
    let entry;
    try { entry = await ensureBrowser(campaign); }
    catch (error) {
      await release(target);
      const code = error.code || "browser_failed";
      log("dm_browser_unavailable", { campaign: campaign.id, reason: code });
      if (STOP_PAUSES.has(code)) await pause(campaign.id, code);
      else await countError(campaign, code, new Date(current.getTime() + RETRY_DELAY_MS));
      return;
    }
    let result;
    // One version of the message for this person; all of them count as "already sent".
    const variants = messageVariants(campaign.message);
    const previous = variants.map((variant) => renderMessage(variant, target.username));
    const pick = Math.min(previous.length - 1, Math.floor(random() * previous.length));
    const message = previous[pick];
    try { result = await entry.session.sendDm({ username: target.username, message, previous }); }
    catch (error) {
      log("dm_send_error", { campaign: campaign.id, reason: error.code || "error", ...errorDetail(error) });
      result = { status: "failed", reason: ["cdp_closed", "cdp_timeout", "cdp_unavailable"].includes(error.code) ? "browser_lost" : "page_error" };
      await closeBrowser(campaign.profile_id);
    }
    if (browsers.get(campaign.profile_id) === entry) await entry.session.idle();
    result.usage = summarizeUsage(entry.session.usage?.());
    result.variant = variants[pick];
    await recordUsage(entry, result.status === "sent");
    await applyResult(campaign, target, result);
  }

  // ---- Replies (worker side) ----

  async function setInbox(profileId, fields) {
    const keys = Object.keys(fields);
    await db.query(
      `INSERT INTO dm_inboxes(profile_id,${keys.join(",")}) VALUES($1,${keys.map((_, index) => `$${index + 2}`).join(",")})
       ON CONFLICT (profile_id) DO UPDATE SET ${keys.map((key) => `${key}=EXCLUDED.${key}`).join(",")}`,
      [profileId, ...keys.map((key) => fields[key])]);
  }

  // True when this account's inbox was last read longer than `ms` ago (or never).
  async function inboxStale(profileId, ms) {
    const row = (await db.query("SELECT checked_at FROM dm_inboxes WHERE profile_id=$1", [profileId])).rows[0];
    return !row?.checked_at || now() - new Date(row.checked_at) >= ms;
  }

  // An answer waiting or a check asked for on this account.
  async function inboxBusy(profileId) {
    const row = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM dm_outbox WHERE profile_id=$1 AND status='pending') OR
         EXISTS (SELECT 1 FROM dm_inboxes WHERE profile_id=$1 AND check_requested_at IS NOT NULL) AS busy`, [profileId])).rows[0];
    return Boolean(row?.busy);
  }

  async function replyBrowser(profileId) {
    const current = browsers.get(profileId);
    if (current && usable(current)) return current;
    if (current) await closeBrowser(profileId);
    // Same connection as the account's campaign, so Instagram sees one place.
    const row = (await db.query(
      "SELECT proxy FROM dm_campaigns WHERE profile_id=$1 ORDER BY (status='running') DESC, updated_at DESC LIMIT 1", [profileId])).rows[0];
    return openBrowser(profileId, null, row?.proxy || defaultProxy);
  }

  // Instagram showed a warning, a logout or a security check: everything on
  // this account stops until the owner starts it again.
  async function stopAccount(profileId, reason, text) {
    const detail = text ? String(text).slice(0, 200) : null;
    const paused = await db.query(
      `UPDATE dm_campaigns SET status='paused',pause_reason=$2,pause_detail=$3,updated_at=NOW()
       WHERE profile_id=$1 AND status='running' RETURNING id::text AS id,name`, [profileId, reason, detail]);
    for (const row of paused.rows) {
      log("dm_campaign_paused", { campaign: row.id, reason });
      emit("paused", { name: row.name, reason, detail });
    }
    await noteWarning(profileId, reason);
    await setInbox(profileId, { check_status: reason, check_detail: detail, check_requested_at: null, retry_at: null });
    await closeBrowser(profileId);
  }

  // Sends the answers the owner typed, oldest first. "stop" when the browser
  // is gone or the account was stopped.
  async function sendAnswers(profileId, entry) {
    const items = (await db.query(
      `SELECT o.id::text AS id,o.message,o.attempts,o.resume,r.id::text AS reply_id,r.username,r.thread
       FROM dm_outbox o JOIN dm_replies r ON r.id=o.reply_id
       WHERE o.profile_id=$1 AND o.status='pending' ORDER BY o.id LIMIT 10`, [profileId])).rows;
    for (const item of items) {
      if (stopping) return "stop";
      await db.query("UPDATE dm_outbox SET status='sending',attempts=attempts+1,updated_at=NOW() WHERE id=$1", [item.id]);
      let result;
      try { result = await entry.session.sendReply({ username: item.username, thread: item.thread, message: item.message, repeat: !item.resume }); }
      catch (error) {
        log("dm_answer_error", { reason: error.code || "error" });
        result = { status: "failed", reason: LOST.has(error.code) ? "browser_lost" : "page_error" };
        await closeBrowser(profileId);
      }
      entry.usedAt = now();
      // A send cut off by a restart that is already in the chat did go out.
      if (result.status === "sent" || (item.resume && result.reason === "already_in_thread")) {
        await db.query("UPDATE dm_outbox SET status='sent',reason=NULL,resume=FALSE,sent_at=$2,updated_at=NOW() WHERE id=$1", [item.id, now()]);
        await db.query("UPDATE dm_replies SET status='answered',updated_at=NOW() WHERE id=$1 AND status='new'", [item.reply_id]);
        log("dm_answer_sent", {});
        continue;
      }
      log("dm_answer_not_sent", { status: result.status, reason: result.reason || null,
        ...(result.detail ? { detail: String(result.detail).slice(0, 200) } : {}) });
      if (result.status === "blocked") {
        await db.query("UPDATE dm_outbox SET status='failed',reason=$2,updated_at=NOW() WHERE id=$1",
          [item.id, result.attempted ? "blocked_after_send" : result.reason || "action_blocked"]);
        await stopAccount(profileId, result.reason || "action_blocked", result.text);
        return "stop";
      }
      const final = result.status === "skipped" || item.attempts + 1 >= MAX_ANSWER_TRIES;
      await db.query("UPDATE dm_outbox SET status=$2,reason=$3,updated_at=NOW() WHERE id=$1",
        [item.id, final ? "failed" : "pending", result.reason || "failed"]);
      if (!final) await setInbox(profileId, { retry_at: new Date(now().getTime() + REPLY_RETRY_MS) });
      if (browsers.get(profileId) !== entry) return "stop";
      if (!final) return "retry";
    }
    return "ok";
  }

  // Instagram's "could not be sent" notice in a chat: our DM never reached that
  // person. Kept (hidden) so the chat is not opened again, and the campaign
  // stops counting it as sent.
  async function markUndelivered(profileId, reply, text) {
    const username = USERNAME.test(reply.username || "") ? reply.username : null;
    await db.query(
      `INSERT INTO dm_replies(profile_id,thread,username,name,row_key,text,status,received_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'undelivered',$7,$7)
       ON CONFLICT (profile_id,thread) DO UPDATE SET username=COALESCE(EXCLUDED.username,dm_replies.username),name=EXCLUDED.name,
         row_key=EXCLUDED.row_key,text=EXCLUDED.text,status='undelivered',updated_at=EXCLUDED.updated_at`,
      [profileId, String(reply.thread).slice(0, 200), username, reply.name ? String(reply.name).slice(0, 80) : null,
        String(reply.key || "").slice(0, 300), text, now()]);
    if (username) await targetsUndelivered(profileId, username);
  }
  async function targetsUndelivered(profileId, username) {
    const fixed = await db.query(
      `UPDATE dm_targets t SET status='skipped',reason='not_delivered',updated_at=NOW() FROM dm_campaigns c
       WHERE c.id=t.campaign_id AND c.profile_id=$1 AND t.username=$2 AND t.status='sent' RETURNING t.id`, [profileId, username]);
    if (fixed.rows.length) log("dm_not_delivered", { found: fixed.rows.length });
  }

  // Reads the inbox and saves who wrote back (see readReplies in instagram-dm.js).
  async function checkReplies(profileId, entry) {
    const startedAt = now();
    // Asked for by the owner (website or Telegram): the result is reported back.
    const inbox = (await db.query("SELECT account,check_requested_at FROM dm_inboxes WHERE profile_id=$1", [profileId])).rows[0];
    const report = (outcome, extra = {}) => emit("checked", { requested: Boolean(inbox?.check_requested_at), outcome, account: inbox?.account || null, ...extra });
    // Every message this account sent them: where their reply starts.
    const outgoing = async (username) => {
      const campaigns = await db.query(
        `SELECT DISTINCT c.message FROM dm_targets t JOIN dm_campaigns c ON c.id=t.campaign_id
         WHERE t.username=$1 AND t.status='sent' AND c.profile_id=$2`, [username, profileId]);
      const answers = await db.query(
        `SELECT o.message FROM dm_outbox o JOIN dm_replies r ON r.id=o.reply_id
         WHERE r.profile_id=$2 AND r.username=$1 AND o.status='sent' ORDER BY o.id DESC LIMIT 20`, [username, profileId]);
      return [...campaigns.rows.flatMap((row) => messageVariants(row.message).map((variant) => renderMessage(variant, username))),
        ...answers.rows.map((row) => row.message)];
    };
    // A chat whose list row looks just as it did at an earlier check is not opened again.
    const known = async (key) =>
      (await db.query("SELECT 1 FROM dm_replies WHERE profile_id=$1 AND row_key=$2 LIMIT 1", [profileId, key])).rows.length > 0;
    let result;
    try { result = await entry.session.readReplies({ outgoing, known, limit: REPLY_LIMIT }); }
    catch (error) {
      log("dm_replies_failed", { reason: error.code || "error", ...errorDetail(error) });
      if (LOST.has(error.code)) await closeBrowser(profileId);
      // Counted as a check, so the next try waits its turn instead of every tick.
      await setInbox(profileId, { checked_at: now(), check_status: "check_failed", check_detail: null, check_requested_at: null, retry_at: null });
      report("check_failed");
      return;
    }
    entry.usedAt = now();
    if (result.status === "blocked") {
      await stopAccount(profileId, result.reason || "action_blocked", result.text);
      report(result.reason || "action_blocked");
      return;
    }
    let fresh = 0;
    for (const reply of result.replies) {
      if (!reply.thread) continue;
      const text = String(reply.text || "").slice(0, 2000);
      if (reply.kind === "undelivered") { await markUndelivered(profileId, reply, text); continue; }
      const old = (await db.query("SELECT text FROM dm_replies WHERE profile_id=$1 AND thread=$2", [profileId, reply.thread])).rows[0];
      const changed = !old || old.text !== text;
      if (changed) fresh++;
      const saved = await db.query(
        `INSERT INTO dm_replies(profile_id,thread,username,name,row_key,text,status,received_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'new',$7,$7)
         ON CONFLICT (profile_id,thread) DO UPDATE SET username=COALESCE(EXCLUDED.username,dm_replies.username),name=EXCLUDED.name,
           row_key=EXCLUDED.row_key,
           status=CASE WHEN dm_replies.text=EXCLUDED.text THEN dm_replies.status ELSE 'new' END,
           received_at=CASE WHEN dm_replies.text=EXCLUDED.text THEN dm_replies.received_at ELSE EXCLUDED.received_at END,
           announced_at=CASE WHEN dm_replies.text=EXCLUDED.text THEN dm_replies.announced_at ELSE NULL END,
           text=EXCLUDED.text,updated_at=EXCLUDED.updated_at
         RETURNING id::text AS id,username`,
        [profileId, String(reply.thread).slice(0, 200), USERNAME.test(reply.username || "") ? reply.username : null,
          reply.name ? String(reply.name).slice(0, 80) : null, String(reply.key || "").slice(0, 300), text, now()]);
      if (changed && onReply && saved.rows[0]?.username) {
        try {
          await onReply({ id: saved.rows[0].id, profile_id: profileId, username: saved.rows[0].username,
            name: reply.name ? String(reply.name).slice(0, 80) : null, text });
        } catch (error) { log("dm_on_reply_failed", { reason: error.code || "error" }); }
      }
    }
    const detail = result.detail ? String(result.detail).slice(0, 400) : null;
    await setInbox(profileId, {
      ...(USERNAME.test(result.account || "") ? { account: result.account } : {}),
      checked_at: now(), check_status: "ok", check_detail: detail, retry_at: null
    });
    await db.query("UPDATE dm_inboxes SET check_requested_at=NULL WHERE profile_id=$1 AND check_requested_at<=$2", [profileId, startedAt]);
    await entry.session.idle();
    const usage = summarizeUsage(entry.session.usage?.());
    log("dm_replies_checked", { rows: result.rows, waiting: result.waiting, skipped: result.skipped, read: result.replies.length, fresh,
      ...(detail ? { detail: detail.slice(0, 300) } : {}), ...(usage || {}) });
    const waiting = (await db.query("SELECT COUNT(*)::int AS count FROM dm_replies WHERE profile_id=$1 AND status='new'", [profileId])).rows[0].count;
    report("ok", { account: USERNAME.test(result.account || "") ? result.account : inbox?.account || null, fresh, waiting });
    await recordUsage(entry, false);
  }

  // Answers to send and the inbox to read for one account, in one browser.
  async function serveInbox(profileId) {
    let entry;
    try { entry = await replyBrowser(profileId); }
    catch (error) {
      const code = error.code || "browser_failed";
      log("dm_inbox_unavailable", { reason: code });
      const asked = (await db.query("SELECT 1 FROM dm_inboxes WHERE profile_id=$1 AND check_requested_at IS NOT NULL", [profileId])).rows.length > 0;
      if (asked) emit("checked", { requested: true, outcome: code, account: null });
      if (STOP_PAUSES.has(code)) {
        await db.query("UPDATE dm_outbox SET status='failed',reason=$2,updated_at=NOW() WHERE profile_id=$1 AND status='pending'", [profileId, code]);
        await setInbox(profileId, { check_status: code, check_requested_at: null, retry_at: null });
      } else {
        await setInbox(profileId, { check_status: code, retry_at: new Date(now().getTime() + REPLY_RETRY_MS) });
      }
      return;
    }
    entry.session.usage?.();
    if (await sendAnswers(profileId, entry) === "stop") return;
    await checkReplies(profileId, entry);
  }

  // The latest fixed check hour today at or before `current`, if within the hour.
  function checkSlot(current) {
    const day = istDayStart(current).getTime();
    for (const hour of [...scheduledHours].reverse()) {
      const slot = day + hour * 3600000;
      if (slot <= current.getTime()) return current.getTime() - slot < CHECK_SLOT_MS ? new Date(slot) : null;
    }
    return null;
  }

  // Accounts whose inbox is due at this check hour: DMs sent in the last 3
  // days, not read since the hour began, not waiting to retry, and not stopped
  // by an Instagram problem.
  async function scheduledChecks(current) {
    const slot = checkSlot(current);
    if (!slot) return [];
    const rows = (await db.query(
      `SELECT p.profile_id FROM (
         SELECT DISTINCT COALESCE(t.sent_profile,c.profile_id)::text AS profile_id
         FROM dm_targets t JOIN dm_campaigns c ON c.id=t.campaign_id WHERE t.sent_at>=$1) p
       LEFT JOIN dm_inboxes i ON i.profile_id::text=p.profile_id
       WHERE (i.checked_at IS NULL OR i.checked_at<$2) AND (i.retry_at IS NULL OR i.retry_at<=$3)
         AND (i.check_status IS NULL OR NOT (i.check_status=ANY($4::text[])))
         AND NOT (EXISTS (SELECT 1 FROM dm_campaigns d WHERE d.profile_id::text=p.profile_id AND d.status='paused' AND d.pause_reason=ANY($4::text[]))
              AND NOT EXISTS (SELECT 1 FROM dm_campaigns d WHERE d.profile_id::text=p.profile_id AND d.status='running'))`,
      [new Date(current.getTime() - CHECK_RECENT_MS), slot, current, ACCOUNT_PROBLEMS])).rows;
    return rows.map((row) => row.profile_id);
  }

  async function inboxWork() {
    const current = now();
    const due = new Set((await db.query(
      `SELECT DISTINCT q.profile_id::text AS profile_id FROM (
         SELECT profile_id FROM dm_outbox WHERE status='pending'
         UNION SELECT profile_id FROM dm_inboxes WHERE check_requested_at IS NOT NULL) q
       LEFT JOIN dm_inboxes i ON i.profile_id=q.profile_id
       WHERE i.retry_at IS NULL OR i.retry_at<=$1`, [current])).rows.map((row) => row.profile_id));
    for (const profileId of await scheduledChecks(current)) due.add(profileId);
    // Between a campaign's DMs (at least a minute before the next one), a look
    // at its inbox every 30 minutes, in the browser that is already open.
    for (const [profileId, entry] of browsers) {
      if (due.has(profileId) || entry.campaignId === null || !entry.session.alive()) continue;
      const campaign = (await db.query("SELECT next_send_at FROM dm_campaigns WHERE id=$1 AND status='running'", [entry.campaignId])).rows[0];
      if (campaign && new Date(campaign.next_send_at) - current >= 60000 && await inboxStale(profileId, REPLY_CHECK_MS)) due.add(profileId);
    }
    for (const profileId of due) {
      if (stopping || !await acquireLease()) break;
      await serveInbox(profileId);
    }
  }

  async function closeIdle() {
    if (!browsers.size) return;
    const active = (await db.query("SELECT id::text AS id,profile_id::text AS profile_id,next_send_at FROM dm_campaigns WHERE status='running'")).rows;
    for (const [profileId, entry] of [...browsers]) {
      const current = now();
      if (entry.campaignId === null) {
        if (!usable(entry) || (current - entry.usedAt >= REPLY_IDLE_MS && !await inboxBusy(profileId))) await closeBrowser(profileId);
        continue;
      }
      const campaign = active.find((row) => row.profile_id === profileId && row.id === entry.campaignId);
      if (!campaign || new Date(campaign.next_send_at) - current > IDLE_CLOSE_MS ||
          current - entry.startedAt >= BROWSER_ROTATE_MS || !entry.session.alive()) {
        // One more look at the inbox before the browser closes.
        if (!stopping && entry.session.alive() && await inboxStale(profileId, REPLY_FINAL_MS) && await acquireLease()) await serveInbox(profileId);
        if (browsers.get(profileId) === entry) await closeBrowser(profileId);
      }
    }
  }

  async function tick() {
    if (!recovered) {
      // A message cut off by a restart is tried again; the chat check stops a repeat.
      await db.query("UPDATE dm_targets SET status='pending',updated_at=NOW() WHERE status='sending'");
      // An answer cut off the same way is retried only if it is not in the chat yet.
      await db.query("UPDATE dm_outbox SET status='pending',resume=TRUE,updated_at=NOW() WHERE status='sending'");
      // Notices saved as replies by an earlier version.
      for (const row of (await db.query("SELECT id::text AS id,profile_id::text AS profile_id,username,text FROM dm_replies WHERE status<>'undelivered'")).rows) {
        if (!isUndelivered(row.text)) continue;
        await db.query("UPDATE dm_replies SET status='undelivered',updated_at=NOW() WHERE id=$1", [row.id]);
        if (row.username) await targetsUndelivered(row.profile_id, row.username);
      }
      recovered = true;
    }
    // Browsers left by an earlier run of the service (or whose stop failed).
    const known = new Set([...browsers.values()].map((entry) => entry.id));
    for (const row of (await db.query("SELECT id::text AS id FROM dm_browsers WHERE status='active'")).rows) {
      if (!known.has(row.id)) await finishBrowser(row.id);
    }
    const campaigns = (await db.query(
      `SELECT id::text AS id,profile_id::text AS profile_id,message,daily_limit,gap_seconds,start_hour,end_hour,proxy,warmup,next_send_at
       FROM dm_campaigns WHERE status='running' ORDER BY next_send_at,id`)).rows;
    for (const campaign of campaigns) {
      if (stopping || !await acquireLease()) break;
      await processCampaign(campaign);
    }
    if (!stopping && await acquireLease()) await inboxWork();
    await closeIdle();
  }

  function runOnce() {
    if (running) return running;
    if (stopping || !browserUse) return Promise.resolve();
    running = (async () => {
      try { if (await acquireLease()) await tick(); }
      catch (error) { log("dm_worker_failed", { reason: error instanceof AppError ? error.code : error?.code || "internal_error" }); }
      finally { running = null; }
    })();
    return running;
  }

  async function shutdown() {
    stopping = true;
    if (running) await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 8000))]);
    await Promise.all([...browsers.keys()].map((profileId) => closeBrowser(profileId).catch(() => {})));
    await db.query("DELETE FROM dm_worker_lease WHERE owner=$1", [owner]).catch(() => {});
  }

  return {
    configured: () => Boolean(browserUse), status, stats, statsFor, listProfiles, createCampaign, addTargets, updateCampaign,
    startCampaign, pauseCampaign, retryFailed, deleteCampaign, getCampaign, replies, requestCheck, answerReply, closeReply,
    runOnce, shutdown
  };
}

module.exports = { createDmSender, parseUsernames, inWindow, nextHourAt, istDayStart, messageVariants, renderMessage, gapFactor };
