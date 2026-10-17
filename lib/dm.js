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
const { createInstagramDriver } = require("./instagram-dm");
const { AppError } = require("./publishing");
const { validId } = require("./security");

const IST = 330 * 60000;
const DAY = 86400000;
const USERNAME = /^[a-z0-9._]{1,30}$/;
const NOT_PROFILES = new Set(["p", "reel", "reels", "stories", "explore", "direct", "accounts", "tv", "about", "developer", "legal", "m"]);
const MAX_TARGETS = 2000;
const MAX_MESSAGE = 1000;
const BROWSER_MINUTES = 180;
const BROWSER_ROTATE_MS = 165 * 60000;
// Keep the browser between messages (Instagram's code stays cached), but not
// across a long wait such as the night.
const IDLE_CLOSE_MS = 20 * 60000;
const MAX_ERRORS = 3;
const SKIP_DELAY_MS = 15000;
const RETRY_DELAY_MS = 2 * 60000;
const LEASE_MS = 3 * 60000;
const STOP_PAUSES = new Set(["browser_use_key_invalid", "browser_use_no_credits", "browser_use_not_found"]);

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
function readSettings(body, current = null) {
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
    endHour: integer(pick("end_hour", current?.end_hour ?? 23), 1, 24)
  };
  const messageLength = [...message].length;
  if (!name || name.length > 60 || !UUID.test(profileId) || !messageLength || messageLength > MAX_MESSAGE ||
      settings.dailyLimit === null || settings.gapMinutes === null || settings.startHour === null ||
      settings.endHour === null || settings.startHour === settings.endHour % 24) {
    throw new AppError(400, "invalid_campaign");
  }
  return settings;
}

function usdInrRate(env) {
  const rate = Number(env.DM_USD_INR);
  return Number.isFinite(rate) && rate >= 50 && rate <= 200 ? rate : 96.5;
}

function createDmSender({ db, env = {}, fetchImpl = fetch, log = () => {}, driver = null, client = null, now = () => new Date(), random = Math.random }) {
  const apiKey = typeof env.BROWSER_USE_API_KEY === "string" ? env.BROWSER_USE_API_KEY.trim() : "";
  const browserUse = client || (apiKey ? createBrowserUseClient({ apiKey, fetchImpl }) : null);
  const instagram = driver || createInstagramDriver({ fetchImpl });
  const rate = usdInrRate(env);
  const proxyCountry = /^[a-z]{2}$/i.test(env.DM_PROXY_COUNTRY || "") ? env.DM_PROXY_COUNTRY.toLowerCase() : "in";
  const owner = crypto.randomUUID();
  const browsers = new Map(); // profile id -> { id, campaignId, session, startedAt }
  let recovered = false;
  let stopping = false;
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
      `SELECT c.id::text AS id,c.name,c.profile_id::text AS profile_id,c.profile_name,c.message,c.daily_limit,c.gap_seconds,
        c.start_hour,c.end_hour,c.stop_after,c.sent_since_start,c.status,c.pause_reason,c.pause_detail,c.next_send_at,c.created_at,
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
    return result.rows.map((row) => {
      const cost = byCampaign.get(row.id) || { proxy_mb: 0, proxy_usd: 0, browser_usd: 0, active: false };
      const usd = Number(cost.proxy_usd || 0) + Number(cost.browser_usd || 0);
      const inr = Math.round(usd * rate * 100) / 100;
      return {
        id: row.id, name: row.name, profile_id: row.profile_id, profile_name: row.profile_name, message: row.message,
        daily_limit: row.daily_limit, gap_minutes: Math.round(row.gap_seconds / 60), start_hour: row.start_hour, end_hour: row.end_hour,
        stop_after: row.stop_after, sent_since_start: row.sent_since_start, status: row.status,
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
    const settings = readSettings(body);
    if (body.requested_contact !== true) throw new AppError(400, "contact_not_confirmed");
    const { usernames, invalid } = parseUsernames(body.usernames);
    if (!usernames.length) throw new AppError(400, "invalid_usernames");
    if (usernames.length > MAX_TARGETS) throw new AppError(400, "too_many_usernames");
    const created = await db.transaction(async (tx) => {
      const row = (await tx.query(
        `INSERT INTO dm_campaigns(name,profile_id,profile_name,message,daily_limit,gap_seconds,start_hour,end_hour,status,pause_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'paused','not_started') RETURNING id::text AS id`,
        [settings.name, settings.profileId, settings.profileName, settings.message, settings.dailyLimit,
          settings.gapMinutes * 60, settings.startHour, settings.endHour])).rows[0];
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
      const settings = readSettings(body, { ...current, profile_id: String(current.profile_id) });
      await tx.query(
        `UPDATE dm_campaigns SET name=$2,profile_id=$3,profile_name=$4,message=$5,daily_limit=$6,gap_seconds=$7,start_hour=$8,end_hour=$9,updated_at=NOW()
         WHERE id=$1`, [id, settings.name, settings.profileId, settings.profileName, settings.message, settings.dailyLimit,
          settings.gapMinutes * 60, settings.startHour, settings.endHour]);
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

  async function status() {
    return { configured: Boolean(browserUse), usd_inr: rate, campaigns: await summaries() };
  }

  async function listProfiles() {
    requireClient();
    try { return await browserUse.listProfiles(); } catch (error) { throw upstream(error); }
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

  async function ensureBrowser(campaign) {
    const current = browsers.get(campaign.profile_id);
    if (current && current.campaignId === campaign.id && current.session.alive() && now() - current.startedAt < BROWSER_ROTATE_MS) return current;
    if (current) await closeBrowser(campaign.profile_id);
    const created = await browserUse.createBrowser({
      profileId: campaign.profile_id, proxyCountryCode: proxyCountry, timeoutMinutes: BROWSER_MINUTES,
      metadata: { app: "dm-sender", campaign: campaign.id }
    });
    await db.query("INSERT INTO dm_browsers(id,profile_id,campaign_id,started_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
      [created.id, campaign.profile_id, campaign.id, now()]);
    let session;
    try { session = await instagram.open(created.cdpUrl); }
    catch (error) {
      await finishBrowser(created.id);
      throw Object.assign(new Error("browser_connect_failed"), { code: "browser_connect_failed", cause: error });
    }
    const entry = { id: created.id, campaignId: campaign.id, session, startedAt: now() };
    browsers.set(campaign.profile_id, entry);
    log("dm_browser_started", { campaign: campaign.id });
    return entry;
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
    await db.query("UPDATE dm_campaigns SET status='paused',pause_reason=$2,pause_detail=$3,updated_at=NOW() WHERE id=$1 AND status='running'",
      [id, reason, detail ? String(detail).slice(0, 200) : null]);
    log("dm_campaign_paused", { campaign: id, reason });
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
    const gap = new Date(current.getTime() + Math.round(campaign.gap_seconds * 1000 * (0.8 + random() * 0.4)));
    if (result.status === "sent") {
      await db.query("UPDATE dm_targets SET status='sent',reason=NULL,sent_at=$2,updated_at=NOW() WHERE id=$1", [target.id, current]);
      const row = (await db.query(
        `UPDATE dm_campaigns SET sent_since_start=sent_since_start+1,consecutive_errors=0,next_send_at=$2,updated_at=NOW()
         WHERE id=$1 RETURNING sent_since_start,stop_after`, [campaign.id, gap])).rows[0];
      log("dm_sent", { campaign: campaign.id });
      if (row?.stop_after && row.sent_since_start >= row.stop_after) await pause(campaign.id, "test_done");
      return;
    }
    // Every message not sent is logged with its reason (and what the page
    // looked like, for a chat that did not open), so problems show in the log.
    log("dm_not_sent", { campaign: campaign.id, status: result.status, reason: result.reason || null,
      ...(result.detail ? { detail: String(result.detail).slice(0, 300) } : {}) });
    if (result.status === "skipped") {
      await settle(target, "skipped", result.reason || "skipped");
      await setNext(campaign.id, new Date(current.getTime() + SKIP_DELAY_MS));
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
    const today = (await db.query("SELECT COUNT(*)::int AS count FROM dm_targets WHERE campaign_id=$1 AND status='sent' AND sent_at>=$2",
      [campaign.id, istDayStart(current)])).rows[0].count;
    if (today >= campaign.daily_limit) {
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
      await db.query(
        `UPDATE dm_campaigns SET status='completed',pause_reason=NULL,pause_detail=NULL,updated_at=NOW()
         WHERE id=$1 AND status='running' AND NOT EXISTS (SELECT 1 FROM dm_targets WHERE campaign_id=$1 AND status IN ('pending','sending'))`,
        [campaign.id]);
      log("dm_campaign_completed", { campaign: campaign.id });
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
    try { result = await entry.session.sendDm({ username: target.username, message: campaign.message }); }
    catch (error) {
      log("dm_send_error", { campaign: campaign.id, reason: error.code || "error" });
      result = { status: "failed", reason: ["cdp_closed", "cdp_timeout", "cdp_unavailable"].includes(error.code) ? "browser_lost" : "page_error" };
      await closeBrowser(campaign.profile_id);
    }
    if (browsers.get(campaign.profile_id) === entry) await entry.session.idle();
    await recordUsage(entry, result.status === "sent");
    await applyResult(campaign, target, result);
  }

  async function closeIdle() {
    if (!browsers.size) return;
    const active = (await db.query("SELECT id::text AS id,profile_id::text AS profile_id,next_send_at FROM dm_campaigns WHERE status='running'")).rows;
    for (const [profileId, entry] of [...browsers]) {
      const campaign = active.find((row) => row.profile_id === profileId && row.id === entry.campaignId);
      const current = now();
      if (!campaign || new Date(campaign.next_send_at) - current > IDLE_CLOSE_MS ||
          current - entry.startedAt >= BROWSER_ROTATE_MS || !entry.session.alive()) {
        await closeBrowser(profileId);
      }
    }
  }

  async function tick() {
    if (!recovered) {
      // A message cut off by a restart is tried again; the chat check stops a repeat.
      await db.query("UPDATE dm_targets SET status='pending',updated_at=NOW() WHERE status='sending'");
      recovered = true;
    }
    // Browsers left by an earlier run of the service (or whose stop failed).
    const known = new Set([...browsers.values()].map((entry) => entry.id));
    for (const row of (await db.query("SELECT id::text AS id FROM dm_browsers WHERE status='active'")).rows) {
      if (!known.has(row.id)) await finishBrowser(row.id);
    }
    const campaigns = (await db.query(
      `SELECT id::text AS id,profile_id::text AS profile_id,message,daily_limit,gap_seconds,start_hour,end_hour,next_send_at
       FROM dm_campaigns WHERE status='running' ORDER BY next_send_at,id`)).rows;
    for (const campaign of campaigns) {
      if (stopping || !await acquireLease()) break;
      await processCampaign(campaign);
    }
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
    configured: () => Boolean(browserUse), status, listProfiles, createCampaign, addTargets, updateCampaign,
    startCampaign, pauseCampaign, retryFailed, deleteCampaign, getCampaign, runOnce, shutdown
  };
}

module.exports = { createDmSender, parseUsernames, inWindow, nextHourAt, istDayStart };
