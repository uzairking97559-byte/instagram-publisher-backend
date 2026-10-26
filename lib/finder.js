"use strict";

// Creator finder: from a few creators the owner names (seeds), reads each
// profile's public numbers (followers, last post, average views) and the
// accounts Instagram shows as similar, then reads those, and so on, keeping
// the creators that fit the run's filters. It uses a separate Instagram login
// in its own Browser Use profile, never a DM account, and messages nobody:
// the result is a list to review and copy.
//
// Pacing: one profile every `gap` seconds (±30%), only inside the run's hours
// (India time), up to the account's daily limit (with warm-up for a new
// account). A logout, security check or limit warning pauses the run until the
// owner starts it again.

const crypto = require("node:crypto");
const { createBrowserUseClient, UUID } = require("./browser-use");
const { createFinderDriver } = require("./instagram-finder");
const { parseUsernames, inWindow, nextHourAt, istDayStart } = require("./dm");
const { AppError } = require("./publishing");
const { validId } = require("./security");

const DAY = 86400000;
const WEEK = 7 * DAY;
const MAX_SEEDS = 50;
const MAX_CANDIDATES = 3000;
const BROWSER_MINUTES = 180;
const BROWSER_ROTATE_MS = 165 * 60000;
// Keep the browser between profiles, not across a long wait.
const IDLE_CLOSE_MS = 15 * 60000;
const LEASE_MS = 3 * 60000;
const MAX_ERRORS = 5;
const RETRY_DELAY_MS = 2 * 60000;
// A profile read in any run this recently is copied, not read again.
const REUSE_MS = 14 * DAY;
const STOP_PAUSES = new Set(["browser_use_key_invalid", "browser_use_no_credits", "browser_use_not_found"]);
const STOPS = new Set(["logged_out", "challenge", "rate_limited"]);
const LOST = new Set(["cdp_closed", "cdp_timeout", "cdp_unavailable"]);
// Warm-up: profiles a day for the account, 50 in its first week, +50 a week;
// after an Instagram warning or security check, 25, +25 a week.
const WARMUP_START = 50;
const WARMUP_STEP = 50;
const WARMUP_AFTER_WARNING = 25;
const WARNINGS = new Set(["rate_limited", "challenge"]);
const PROXY = /^([a-z]{2}|none)$/;
const USERNAME = /^[a-z0-9._]{1,30}$/;

function integer(value, min, max) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

// Run settings from a request; `current` fills in fields left out.
function readSettings(body, current = null, defaultProxy = "in") {
  const pick = (key, fallback) => (body[key] !== undefined ? body[key] : fallback);
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const rawName = pick("profile_name", current?.profile_name ?? null);
  const rawMax = pick("max_followers", current ? current.max_followers : null);
  const settings = {
    name: text(pick("name", current?.name)),
    profileId: text(pick("profile_id", current?.profile_id)).toLowerCase(),
    profileName: typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 120) : null,
    minFollowers: integer(pick("min_followers", current?.min_followers ?? 10000), 0, 1e9),
    maxFollowers: rawMax === null || rawMax === "" || rawMax === 0 ? null : integer(rawMax, 1, 1e9),
    activeDays: integer(pick("active_days", current?.active_days ?? 30), 1, 365),
    depth: integer(pick("depth", current?.depth ?? 2), 1, 3),
    dailyLimit: integer(pick("daily_limit", current?.daily_limit ?? 100), 10, 300),
    gapSeconds: integer(pick("gap_seconds", current?.gap_seconds ?? 60), 30, 600),
    startHour: integer(pick("start_hour", current?.start_hour ?? 9), 0, 23),
    endHour: integer(pick("end_hour", current?.end_hour ?? 23), 1, 24),
    proxy: String(pick("proxy", current?.proxy ?? defaultProxy) ?? "").trim().toLowerCase(),
    warmup: pick("warmup", current?.warmup ?? true)
  };
  const maxOk = rawMax === null || rawMax === "" || rawMax === 0 || settings.maxFollowers !== null;
  if (!settings.name || settings.name.length > 60 || !UUID.test(settings.profileId) || !maxOk ||
      [settings.minFollowers, settings.activeDays, settings.depth, settings.dailyLimit, settings.gapSeconds, settings.startHour, settings.endHour].includes(null) ||
      (settings.maxFollowers !== null && settings.maxFollowers < settings.minFollowers) ||
      settings.startHour === settings.endHour % 24 || !PROXY.test(settings.proxy) || typeof settings.warmup !== "boolean") {
    throw new AppError(400, "invalid_finder");
  }
  return settings;
}

// Which candidates a results request asks for (fixed SQL, no input in it).
const FILTERS = {
  match: "c.status='done' AND c.match AND c.review IS DISTINCT FROM 'rejected'",
  approved: "c.review='approved'",
  rejected: "c.review='rejected'",
  other: "c.status='done' AND NOT c.match",
  queue: "c.status IN ('pending','reading')",
  missing: "c.status IN ('not_found','failed')",
  all: "TRUE"
};
const ORDER = {
  queue: "c.depth, c.mentions DESC, c.id",
  all: "c.depth, c.id"
};
const SORT = "c.review='approved' DESC NULLS LAST, c.avg_views DESC NULLS LAST, c.followers DESC NULLS LAST, c.id";

function usdInrRate(env) {
  const rate = Number(env.DM_USD_INR);
  return Number.isFinite(rate) && rate >= 50 && rate <= 200 ? rate : 96.5;
}

// onEvent(event, details): "finder_paused" { name, reason, detail } and
// "finder_completed" { name, found }, for alerts (lib/telegram.js).
function createCreatorFinder({ db, env = {}, fetchImpl = fetch, log = () => {}, driver = null, client = null, now = () => new Date(), random = Math.random, onEvent = () => {} }) {
  // The finder may run on its own Browser Use account (FINDER_BROWSER_USE_API_KEY,
  // e.g. a friend's, with its own credits and profiles); otherwise the DM one.
  const finderKey = typeof env.FINDER_BROWSER_USE_API_KEY === "string" ? env.FINDER_BROWSER_USE_API_KEY.trim() : "";
  const apiKey = finderKey || (typeof env.BROWSER_USE_API_KEY === "string" ? env.BROWSER_USE_API_KEY.trim() : "");
  const browserUse = client || (apiKey ? createBrowserUseClient({ apiKey, fetchImpl }) : null);
  const instagram = driver || createFinderDriver({ fetchImpl });
  const rate = usdInrRate(env);
  const defaultProxy = PROXY.test(String(env.DM_PROXY_COUNTRY || "").toLowerCase()) ? env.DM_PROXY_COUNTRY.toLowerCase() : "in";
  const owner = crypto.randomUUID();
  const browsers = new Map(); // profile id -> { id, runId, proxy, session, startedAt }
  const emit = (event, details) => { Promise.resolve().then(() => onEvent(event, details)).catch(() => {}); };
  let recovered = false;
  let stopping = false;
  let running = null;

  function requireClient() { if (!browserUse) throw new AppError(503, "finder_not_configured"); }
  // The Browser Use profiles of the finder's account (its own key, if set).
  async function listProfiles() {
    requireClient();
    try { return await browserUse.listProfiles(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, typeof error?.code === "string" && error.code.startsWith("browser_use_") ? error.code : "browser_use_failed");
    }
  }
  function runId(value) {
    if (!validId(value) || value.length > 18) throw new AppError(404, "finder_not_found");
    return value;
  }
  const inr = (usd) => Math.round(Number(usd || 0) * rate * 100) / 100;

  // ---- Owner-facing store ----

  async function summaries(onlyId = null) {
    const since = istDayStart(now());
    const result = await db.query(
      `SELECT r.id::text AS id,r.name,r.profile_id::text AS profile_id,r.profile_name,r.min_followers,r.max_followers,r.active_days,r.depth,
        r.daily_limit,r.gap_seconds,r.start_hour,r.end_hour,r.proxy,r.warmup,r.stop_after,r.read_since_start,r.status,r.pause_reason,
        r.pause_detail,r.next_read_at,r.created_at,
        COUNT(c.id)::int AS total,
        COUNT(c.id) FILTER (WHERE c.depth=0)::int AS seeds,
        COUNT(c.id) FILTER (WHERE c.status IN ('pending','reading'))::int AS pending,
        COUNT(c.id) FILTER (WHERE c.status='done')::int AS read,
        COUNT(c.id) FILTER (WHERE c.status='done' AND c.match AND c.review IS DISTINCT FROM 'rejected')::int AS matched,
        COUNT(c.id) FILTER (WHERE c.review='approved')::int AS approved,
        COUNT(c.id) FILTER (WHERE c.review='rejected')::int AS rejected,
        COUNT(c.id) FILTER (WHERE c.status IN ('not_found','failed'))::int AS missing,
        COUNT(c.id) FILTER (WHERE c.read_at>=$1 AND c.source<>'cache')::int AS read_today
       FROM finder_runs r LEFT JOIN finder_candidates c ON c.run_id=r.id
       WHERE ($2::bigint IS NULL OR r.id=$2::bigint)
       GROUP BY r.id ORDER BY r.created_at DESC, r.id DESC`, [since, onlyId]);
    const costs = new Map((await db.query(
      `SELECT run_id::text AS run_id, SUM(proxy_mb)::float8 AS proxy_mb, SUM(proxy_cost_usd)::float8 AS proxy_usd,
        SUM(CASE WHEN status='active' THEN GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz-started_at)),0)/3600*0.02 ELSE browser_cost_usd END)::float8 AS browser_usd,
        SUM(profiles_read)::int AS profiles_read, BOOL_OR(status='active') AS active
       FROM finder_browsers WHERE run_id IS NOT NULL GROUP BY run_id`, [now()])).rows.map((row) => [row.run_id, row]));
    const warmups = new Map();
    for (const row of result.rows) if (row.warmup && !warmups.has(row.profile_id)) warmups.set(row.profile_id, await warmupLimit(row.profile_id));
    return result.rows.map((row) => {
      const cost = costs.get(row.id) || { proxy_mb: 0, proxy_usd: 0, browser_usd: 0, profiles_read: 0, active: false };
      const total = inr(Number(cost.proxy_usd || 0) + Number(cost.browser_usd || 0));
      const warm = row.warmup ? warmups.get(row.profile_id) : null;
      return {
        id: row.id, name: row.name, profile_id: row.profile_id, profile_name: row.profile_name,
        min_followers: row.min_followers, max_followers: row.max_followers, active_days: row.active_days, depth: row.depth,
        daily_limit: row.daily_limit, today_limit: warm ? Math.min(row.daily_limit, warm.limit) : row.daily_limit, warmup: row.warmup,
        gap_seconds: row.gap_seconds, start_hour: row.start_hour, end_hour: row.end_hour, proxy: row.proxy,
        stop_after: row.stop_after, read_since_start: row.read_since_start, status: row.status,
        pause_reason: row.pause_reason, pause_detail: row.pause_detail, next_read_at: row.next_read_at, created_at: row.created_at,
        counts: { total: row.total, seeds: row.seeds, pending: row.pending, read: row.read, matched: row.matched, approved: row.approved,
          rejected: row.rejected, missing: row.missing, read_today: row.read_today },
        cost: { inr: total, proxy_mb: Math.round(Number(cost.proxy_mb || 0) * 10) / 10,
          per_100_inr: cost.profiles_read ? Math.round((total / cost.profiles_read) * 100 * 100) / 100 : null },
        browser_active: Boolean(cost.active)
      };
    });
  }

  async function summary(id) {
    const [row] = await summaries(id);
    if (!row) throw new AppError(404, "finder_not_found");
    return row;
  }

  // Seeds: depth 0, read first. A username already in the run becomes a seed.
  async function insertSeeds(tx, id, usernames) {
    const result = await tx.query(
      `INSERT INTO finder_candidates(run_id,username,depth,mentions)
       SELECT $1::bigint, u.username, 0, 0 FROM unnest($2::text[]) AS u(username)
       ON CONFLICT (run_id, username) DO UPDATE SET depth=0 WHERE finder_candidates.depth<>0
       RETURNING id`, [id, usernames]);
    return result.rows.length;
  }

  // A DM account stays a DM account: the finder uses its own login.
  async function checkProfile(q, profileId) {
    const dm = await q.query("SELECT 1 FROM dm_campaigns WHERE profile_id=$1 LIMIT 1", [profileId]);
    if (dm.rows.length) throw new AppError(409, "profile_is_dm");
  }

  async function createRun(body) {
    const settings = readSettings(body, null, defaultProxy);
    const { usernames, invalid } = parseUsernames(body.seeds);
    if (!usernames.length) throw new AppError(400, "invalid_seeds");
    if (usernames.length > MAX_SEEDS) throw new AppError(400, "too_many_seeds");
    await checkProfile(db, settings.profileId);
    const id = await db.transaction(async (tx) => {
      const row = (await tx.query(
        `INSERT INTO finder_runs(name,profile_id,profile_name,min_followers,max_followers,active_days,depth,daily_limit,gap_seconds,
          start_hour,end_hour,proxy,warmup,status,pause_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'paused','not_started') RETURNING id::text AS id`,
        [settings.name, settings.profileId, settings.profileName, settings.minFollowers, settings.maxFollowers, settings.activeDays,
          settings.depth, settings.dailyLimit, settings.gapSeconds, settings.startHour, settings.endHour, settings.proxy, settings.warmup])).rows[0];
      await insertSeeds(tx, row.id, usernames);
      return row.id;
    });
    log("finder_run_created", { run: id, seeds: usernames.length });
    return { run: await summary(id), seeds: usernames.length, invalid };
  }

  // Filters changed: which read profiles fit is worked out again.
  async function rematch(q, id, candidateId = null) {
    await q.query(
      `UPDATE finder_candidates c SET match=(c.status='done' AND NOT COALESCE(c.private,FALSE) AND c.followers IS NOT NULL
         AND c.followers>=r.min_followers AND (r.max_followers IS NULL OR c.followers<=r.max_followers)
         AND c.last_post_at IS NOT NULL AND c.last_post_at>=$2::timestamptz-make_interval(days => r.active_days))
       FROM finder_runs r WHERE r.id=c.run_id AND c.run_id=$1 AND ($3::bigint IS NULL OR c.id=$3::bigint)`, [id, now(), candidateId]);
  }

  async function updateRun(rawId, body) {
    const id = runId(rawId);
    await db.transaction(async (tx) => {
      const current = (await tx.query("SELECT * FROM finder_runs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!current) throw new AppError(404, "finder_not_found");
      if (current.status === "running") throw new AppError(409, "finder_running");
      const settings = readSettings(body, { ...current, profile_id: String(current.profile_id) }, defaultProxy);
      if (settings.profileId !== String(current.profile_id)) await checkProfile(tx, settings.profileId);
      await tx.query(
        `UPDATE finder_runs SET name=$2,profile_id=$3,profile_name=$4,min_followers=$5,max_followers=$6,active_days=$7,depth=$8,daily_limit=$9,
         gap_seconds=$10,start_hour=$11,end_hour=$12,proxy=$13,warmup=$14,updated_at=NOW() WHERE id=$1`,
        [id, settings.name, settings.profileId, settings.profileName, settings.minFollowers, settings.maxFollowers, settings.activeDays, settings.depth,
          settings.dailyLimit, settings.gapSeconds, settings.startHour, settings.endHour, settings.proxy, settings.warmup]);
      await rematch(tx, id);
    });
    return { run: await summary(id) };
  }

  async function addSeeds(rawId, body) {
    const id = runId(rawId);
    const { usernames, invalid } = parseUsernames(body.seeds);
    if (!usernames.length) throw new AppError(400, "invalid_seeds");
    if (usernames.length > MAX_SEEDS) throw new AppError(400, "too_many_seeds");
    const added = await db.transaction(async (tx) => {
      const row = (await tx.query("SELECT status FROM finder_runs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw new AppError(404, "finder_not_found");
      const count = await insertSeeds(tx, id, usernames);
      if (row.status === "completed") await tx.query("UPDATE finder_runs SET status='paused',pause_reason='not_started',updated_at=NOW() WHERE id=$1", [id]);
      return count;
    });
    return { run: await summary(id), added, invalid };
  }

  async function startRun(rawId, body = {}) {
    const id = runId(rawId);
    requireClient();
    const raw = body.stop_after;
    const stopAfter = raw === undefined || raw === null || raw === "" ? null : integer(raw, 1, 1000);
    if (stopAfter === null && raw !== undefined && raw !== null && raw !== "") throw new AppError(400, "invalid_finder");
    await db.transaction(async (tx) => {
      const current = (await tx.query("SELECT profile_id::text AS profile_id FROM finder_runs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!current) throw new AppError(404, "finder_not_found");
      await checkProfile(tx, current.profile_id);
      const busy = await tx.query("SELECT 1 FROM finder_runs WHERE profile_id=$1 AND status='running' AND id<>$2", [current.profile_id, id]);
      if (busy.rows.length) throw new AppError(409, "profile_busy");
      // Profiles that failed get another try.
      await tx.query("UPDATE finder_candidates SET status='pending',reason=NULL,attempts=0 WHERE run_id=$1 AND status='failed'", [id]);
      const pending = await tx.query("SELECT 1 FROM finder_candidates WHERE run_id=$1 AND status IN ('pending','reading') LIMIT 1", [id]);
      if (!pending.rows.length) throw new AppError(409, "nothing_to_read");
      await tx.query(
        `UPDATE finder_runs SET status='running',pause_reason=NULL,pause_detail=NULL,stop_after=$2,read_since_start=0,
         consecutive_errors=0,next_read_at=$3,updated_at=NOW() WHERE id=$1`, [id, stopAfter, now()]);
    });
    log("finder_run_started", { run: id, ...(stopAfter ? { stop_after: stopAfter } : {}) });
    return { run: await summary(id) };
  }

  async function pauseRun(rawId) {
    const id = runId(rawId);
    await db.query("UPDATE finder_runs SET status='paused',pause_reason='owner',pause_detail=NULL,updated_at=NOW() WHERE id=$1 AND status='running'", [id]);
    return { run: await summary(id) };
  }

  async function deleteRun(rawId) {
    const id = runId(rawId);
    const result = await db.query("DELETE FROM finder_runs WHERE id=$1 AND status<>'running' RETURNING id", [id]);
    if (!result.rows.length) {
      await summary(id);
      throw new AppError(409, "finder_running");
    }
    return { ok: true };
  }

  async function getRun(rawId, filter = "match", limit = 200) {
    const id = runId(rawId);
    const run = await summary(id);
    const where = FILTERS[filter] || FILTERS.match;
    const order = ORDER[filter] || SORT;
    const size = Math.max(1, Math.min(1000, Number(limit) || 200));
    const result = await db.query(
      `SELECT c.username,c.depth,c.mentions,c.via,c.status,c.reason,c.name,c.followers,c.following,c.posts,c.private,c.professional,c.verified,
        c.category,c.bio,c.last_post_at,c.avg_views,c.match,c.review,c.read_at,
        EXISTS (SELECT 1 FROM dm_targets t WHERE t.username=c.username AND t.status='sent') AS contacted
       FROM finder_candidates c WHERE c.run_id=$1 AND ${where} ORDER BY ${order} LIMIT $2`, [id, size]);
    return { run, filter: FILTERS[filter] ? filter : "match", candidates: result.rows };
  }

  async function review(rawId, body) {
    const id = runId(rawId);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase().replace(/^@/, "") : "";
    const value = body.review === null || body.review === "" ? null : body.review;
    if (!/^[a-z0-9._]{1,30}$/.test(username) || ![null, "approved", "rejected"].includes(value)) throw new AppError(400, "invalid_review");
    const result = await db.query("UPDATE finder_candidates SET review=$3 WHERE run_id=$1 AND username=$2 RETURNING username,review", [id, username, value]);
    if (!result.rows.length) throw new AppError(404, "finder_not_found");
    return { candidate: result.rows[0], run: await summary(id) };
  }

  // Usernames to copy: approved ones, or every fitting one not rejected.
  async function usernames(rawId, filter = "match") {
    const id = runId(rawId);
    await summary(id);
    const where = filter === "approved" ? FILTERS.approved : FILTERS.match;
    const result = await db.query(`SELECT c.username FROM finder_candidates c WHERE c.run_id=$1 AND ${where} ORDER BY ${SORT} LIMIT 5000`, [id]);
    return { usernames: result.rows.map((row) => row.username) };
  }

  async function today() {
    const since = istDayStart(now());
    const read = (await db.query("SELECT COUNT(*)::int AS count FROM finder_candidates WHERE read_at>=$1 AND source<>'cache'", [since])).rows[0].count;
    const cost = (await db.query(
      `SELECT COALESCE(SUM(proxy_cost_usd),0)::float8 AS proxy_usd,
        COALESCE(SUM(CASE WHEN status='active' THEN GREATEST(EXTRACT(EPOCH FROM ($2::timestamptz-started_at)),0)/3600*0.02 ELSE browser_cost_usd END),0)::float8 AS browser_usd
       FROM finder_browsers WHERE started_at>=$1`, [since, now()])).rows[0];
    return { read, cost_inr: inr(Number(cost.proxy_usd) + Number(cost.browser_usd)) };
  }

  async function status() {
    return { configured: Boolean(browserUse), own_account: Boolean(finderKey), usd_inr: rate, runs: await summaries(), today: await today() };
  }

  // ---- Warm-up ----

  async function warmupLimit(profileId) {
    const first = (await db.query(
      `SELECT MIN(c.read_at) AS first FROM finder_candidates c JOIN finder_runs r ON r.id=c.run_id
       WHERE r.profile_id=$1 AND c.read_at IS NOT NULL AND c.source<>'cache'`, [profileId])).rows[0]?.first;
    const warned = (await db.query("SELECT last_warning_at FROM finder_accounts WHERE profile_id=$1", [profileId])).rows[0]?.last_warning_at;
    const current = now();
    const reset = Boolean(warned && (!first || new Date(warned) >= new Date(first)));
    const since = reset ? new Date(warned) : first ? new Date(first) : current;
    const weeks = Math.max(0, Math.floor((current - since) / WEEK));
    return { limit: reset ? WARMUP_AFTER_WARNING * (weeks + 1) : WARMUP_START + WARMUP_STEP * weeks };
  }

  async function noteWarning(profileId, reason) {
    if (!WARNINGS.has(reason)) return;
    await db.query(
      `INSERT INTO finder_accounts(profile_id,last_warning_at) VALUES($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET last_warning_at=EXCLUDED.last_warning_at`, [profileId, now()]);
  }

  // ---- Worker ----

  async function acquireLease() {
    const current = now();
    const result = await db.query(
      `INSERT INTO finder_worker_lease(id,owner,expires_at) VALUES(1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
       WHERE finder_worker_lease.owner=$1 OR finder_worker_lease.expires_at<$3 RETURNING owner`,
      [owner, new Date(current.getTime() + LEASE_MS), current]);
    return result.rows.length > 0;
  }

  async function finishBrowser(id) {
    let final = null;
    try { final = await browserUse.stopBrowser(id); }
    catch (error) {
      if (error.code !== "browser_use_not_found") { log("finder_browser_stop_failed", { reason: error.code || "error" }); return; }
    }
    try { final = await browserUse.getBrowser(id); } catch { /* keep what stop returned */ }
    if (final) {
      await db.query(
        `UPDATE finder_browsers SET status='stopped',stopped_at=COALESCE(stopped_at,$2),proxy_mb=GREATEST(proxy_mb,$3),
         proxy_cost_usd=GREATEST(proxy_cost_usd,$4),browser_cost_usd=$5 WHERE id=$1`,
        [id, now(), final.proxyMb, final.proxyCostUsd, final.browserCostUsd]);
    } else {
      await db.query("UPDATE finder_browsers SET status='stopped',stopped_at=COALESCE(stopped_at,$2) WHERE id=$1", [id, now()]);
    }
  }

  async function closeBrowser(profileId) {
    const entry = browsers.get(profileId);
    if (!entry) return;
    browsers.delete(profileId);
    try { entry.session.close(); } catch { /* already closed */ }
    await finishBrowser(entry.id);
    log("finder_browser_stopped", { run: entry.runId });
  }

  async function ensureBrowser(run) {
    const current = browsers.get(run.profile_id);
    if (current && current.runId === run.id && current.proxy === run.proxy && current.session.alive() && now() - current.startedAt < BROWSER_ROTATE_MS) return current;
    if (current) await closeBrowser(run.profile_id);
    const created = await browserUse.createBrowser({
      profileId: run.profile_id, proxyCountryCode: run.proxy === "none" ? null : run.proxy, timeoutMinutes: BROWSER_MINUTES,
      metadata: { app: "creator-finder", run: run.id }
    });
    await db.query("INSERT INTO finder_browsers(id,profile_id,run_id,started_at) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
      [created.id, run.profile_id, run.id, now()]);
    let session;
    try { session = await instagram.open(created.cdpUrl); }
    catch (error) {
      await finishBrowser(created.id);
      throw Object.assign(new Error("browser_connect_failed"), { code: "browser_connect_failed", cause: error });
    }
    const entry = { id: created.id, runId: run.id, proxy: run.proxy, session, startedAt: now() };
    browsers.set(run.profile_id, entry);
    log("finder_browser_started", { run: run.id, proxy: run.proxy });
    return entry;
  }

  async function recordUsage(entry) {
    let info = null;
    try { info = await browserUse.getBrowser(entry.id); } catch { /* counted when it stops */ }
    if (info) await db.query("UPDATE finder_browsers SET profiles_read=profiles_read+1,proxy_mb=$2,proxy_cost_usd=$3 WHERE id=$1", [entry.id, info.proxyMb, info.proxyCostUsd]);
    else await db.query("UPDATE finder_browsers SET profiles_read=profiles_read+1 WHERE id=$1", [entry.id]);
  }

  const setNext = (id, date) => db.query("UPDATE finder_runs SET next_read_at=$2,updated_at=NOW() WHERE id=$1", [id, date]);
  const release = (candidate) => db.query("UPDATE finder_candidates SET status='pending',attempts=GREATEST(attempts-1,0) WHERE id=$1 AND status='reading'", [candidate.id]);
  const gapFrom = (run, current) => new Date(current.getTime() + Math.round(run.gap_seconds * 1000 * (0.7 + random() * 0.6)));

  async function pause(id, reason, detail = null) {
    const text = detail ? String(detail).slice(0, 200) : null;
    const row = (await db.query(
      "UPDATE finder_runs SET status='paused',pause_reason=$2,pause_detail=$3,updated_at=NOW() WHERE id=$1 AND status='running' RETURNING name,profile_id::text AS profile_id",
      [id, reason, text])).rows[0];
    log("finder_run_paused", { run: id, reason });
    if (row) {
      await noteWarning(row.profile_id, reason);
      emit("finder_paused", { name: row.name, reason, detail: text });
    }
  }

  async function countError(run, reason, next) {
    const row = (await db.query(
      "UPDATE finder_runs SET consecutive_errors=consecutive_errors+1,next_read_at=$2,updated_at=NOW() WHERE id=$1 RETURNING consecutive_errors",
      [run.id, next])).rows[0];
    if (row && row.consecutive_errors >= MAX_ERRORS) {
      await pause(run.id, "too_many_errors", reason);
      await closeBrowser(run.profile_id);
    }
  }

  // The similar accounts of a seed, or of a profile that fits, join the queue
  // one level deeper (up to the run's depth and size).
  async function expand(run, candidate, all) {
    const related = [...new Set((all || []).filter((user) => USERNAME.test(user) && user !== candidate.username))];
    if (!related.length || candidate.depth >= run.depth || (candidate.depth > 0 && !candidate.match)) return 0;
    const total = (await db.query("SELECT COUNT(*)::int AS count FROM finder_candidates WHERE run_id=$1", [run.id])).rows[0].count;
    const room = MAX_CANDIDATES - total;
    const known = new Set((await db.query("SELECT username FROM finder_candidates WHERE run_id=$1 AND username=ANY($2::text[])", [run.id, related])).rows.map((row) => row.username));
    const fresh = related.filter((user) => !known.has(user)).slice(0, Math.max(0, room));
    // Already listed: one more profile named it, so it moves up the queue.
    if (known.size) await db.query("UPDATE finder_candidates SET mentions=mentions+1 WHERE run_id=$1 AND username=ANY($2::text[])", [run.id, [...known]]);
    if (fresh.length) {
      await db.query(
        `INSERT INTO finder_candidates(run_id,username,depth,mentions,via)
         SELECT $1::bigint, u.username, $2::int, 1, $3 FROM unnest($4::text[]) AS u(username)
         ON CONFLICT (run_id, username) DO UPDATE SET mentions=finder_candidates.mentions+1`,
        [run.id, candidate.depth + 1, candidate.username, fresh]);
    }
    return fresh.length;
  }

  // Saves a profile's numbers, works out whether it fits, and queues its similar accounts.
  async function saveProfile(run, candidate, profile, source) {
    const current = now();
    const row = (await db.query(
      `UPDATE finder_candidates SET status='done',reason=NULL,name=$2,followers=$3,following=$4,posts=$5,private=$6,professional=$7,verified=$8,
        category=$9,bio=$10,last_post_at=$11,avg_views=$12,related=$13::text[],source=$14,read_at=$15 WHERE id=$1 RETURNING id`,
      [candidate.id, profile.name ?? null, profile.followers ?? null, profile.following ?? null, profile.posts ?? null, profile.private ?? null,
        profile.professional ?? null, profile.verified ?? null, profile.category ?? null, profile.bio ?? null,
        profile.last_post_at ? new Date(profile.last_post_at) : null, profile.avg_views ?? null, profile.related || [], source, current])).rows[0];
    if (!row) return;
    await rematch(db, run.id, candidate.id);
    const match = (await db.query("SELECT match FROM finder_candidates WHERE id=$1", [candidate.id])).rows[0]?.match;
    await expand(run, { ...candidate, match }, profile.related || []);
  }

  // A profile read in the last two weeks (any run) is copied, not read again.
  async function reuse(run, candidate) {
    const cached = (await db.query(
      `SELECT name,followers,following,posts,private,professional,verified,category,bio,last_post_at,avg_views,related
       FROM finder_candidates WHERE username=$1 AND status='done' AND source<>'cache' AND read_at>=$2 AND id<>$3
       ORDER BY read_at DESC LIMIT 1`, [candidate.username, new Date(now().getTime() - REUSE_MS), candidate.id])).rows[0];
    if (!cached) return false;
    await saveProfile(run, candidate, { ...cached, last_post_at: cached.last_post_at ? new Date(cached.last_post_at).getTime() : null }, "cache");
    return true;
  }

  async function applyResult(run, candidate, result) {
    const current = now();
    const next = gapFrom(run, current);
    if (result.state === "ok") {
      await saveProfile(run, candidate, result, result.source || "api");
      const row = (await db.query(
        `UPDATE finder_runs SET read_since_start=read_since_start+1,consecutive_errors=0,next_read_at=$2,updated_at=NOW()
         WHERE id=$1 RETURNING read_since_start,stop_after`, [run.id, next])).rows[0];
      log("finder_read", { run: run.id, source: result.source || "api", related: result.related?.length || 0, ...(result.usage || {}) });
      if (row?.stop_after && row.read_since_start >= row.stop_after) await pause(run.id, "test_done");
      return;
    }
    log("finder_not_read", { run: run.id, state: result.state, ...(result.detail ? { detail: String(result.detail).slice(0, 200) } : {}), ...(result.usage || {}) });
    if (result.state === "not_found") {
      await db.query("UPDATE finder_candidates SET status='not_found',reason=NULL,read_at=$2,source='api' WHERE id=$1", [candidate.id, current]);
      await db.query("UPDATE finder_runs SET consecutive_errors=0,next_read_at=$2,updated_at=NOW() WHERE id=$1", [run.id, next]);
      return;
    }
    if (STOPS.has(result.state)) {
      await release(candidate);
      await pause(run.id, result.state, result.detail);
      await closeBrowser(run.profile_id);
      return;
    }
    await db.query("UPDATE finder_candidates SET status='failed',reason=$2 WHERE id=$1", [candidate.id, String(result.reason || result.state || "failed").slice(0, 60)]);
    await countError(run, result.reason || result.state || "failed", next);
  }

  async function processRun(run) {
    const current = now();
    if (new Date(run.next_read_at) > current) return;
    if (!inWindow(current, run.start_hour, run.end_hour)) {
      await setNext(run.id, nextHourAt(current, run.start_hour));
      return;
    }
    const readToday = (await db.query(
      `SELECT COUNT(*)::int AS count FROM finder_candidates c JOIN finder_runs r ON r.id=c.run_id
       WHERE r.profile_id=$1 AND c.read_at>=$2 AND c.source<>'cache'`, [run.profile_id, istDayStart(current)])).rows[0].count;
    const limit = run.warmup ? Math.min(run.daily_limit, (await warmupLimit(run.profile_id)).limit) : run.daily_limit;
    if (readToday >= limit) {
      let next = new Date(istDayStart(current).getTime() + DAY);
      if (!inWindow(next, run.start_hour, run.end_hour)) next = nextHourAt(next, run.start_hour);
      await setNext(run.id, next);
      return;
    }
    const candidate = (await db.query(
      `UPDATE finder_candidates SET status='reading',attempts=attempts+1
       WHERE id=(SELECT id FROM finder_candidates WHERE run_id=$1 AND status='pending' ORDER BY depth, mentions DESC, id LIMIT 1)
       RETURNING id::text AS id,username,depth`, [run.id])).rows[0];
    if (!candidate) {
      const done = (await db.query(
        `UPDATE finder_runs SET status='completed',pause_reason=NULL,pause_detail=NULL,updated_at=NOW()
         WHERE id=$1 AND status='running' AND NOT EXISTS (SELECT 1 FROM finder_candidates WHERE run_id=$1 AND status IN ('pending','reading'))
         RETURNING name`, [run.id])).rows[0];
      await closeBrowser(run.profile_id);
      if (done) {
        const found = (await db.query("SELECT COUNT(*)::int AS count FROM finder_candidates WHERE run_id=$1 AND status='done' AND match", [run.id])).rows[0].count;
        log("finder_run_completed", { run: run.id, found });
        emit("finder_completed", { name: done.name, found });
      }
      return;
    }
    if (await reuse(run, candidate)) return;
    let entry;
    try { entry = await ensureBrowser(run); }
    catch (error) {
      await release(candidate);
      const code = error.code || "browser_failed";
      log("finder_browser_unavailable", { run: run.id, reason: code });
      if (STOP_PAUSES.has(code)) await pause(run.id, code);
      else await countError(run, code, new Date(current.getTime() + RETRY_DELAY_MS));
      return;
    }
    let result;
    try { result = await entry.session.readProfile(candidate.username); }
    catch (error) {
      log("finder_read_error", { run: run.id, reason: error.code || "error" });
      result = { state: "error", reason: LOST.has(error.code) ? "browser_lost" : "page_error" };
      await closeBrowser(run.profile_id);
    }
    const usage = entry.session.usage?.();
    if (usage && Number.isFinite(usage.bytes)) result.usage = { kb: Math.round(usage.bytes / 1024) };
    await recordUsage(entry);
    await applyResult(run, candidate, result);
  }

  async function closeIdle() {
    if (!browsers.size) return;
    const active = (await db.query("SELECT id::text AS id,profile_id::text AS profile_id,next_read_at FROM finder_runs WHERE status='running'")).rows;
    for (const [profileId, entry] of [...browsers]) {
      const run = active.find((row) => row.profile_id === profileId && row.id === entry.runId);
      if (!run || new Date(run.next_read_at) - now() > IDLE_CLOSE_MS || now() - entry.startedAt >= BROWSER_ROTATE_MS || !entry.session.alive()) {
        await closeBrowser(profileId);
      }
    }
  }

  async function tick() {
    if (!recovered) {
      await db.query("UPDATE finder_candidates SET status='pending' WHERE status='reading'");
      recovered = true;
    }
    const known = new Set([...browsers.values()].map((entry) => entry.id));
    for (const row of (await db.query("SELECT id::text AS id FROM finder_browsers WHERE status='active'")).rows) {
      if (!known.has(row.id)) await finishBrowser(row.id);
    }
    const runs = (await db.query(
      `SELECT id::text AS id,profile_id::text AS profile_id,depth,daily_limit,gap_seconds,start_hour,end_hour,proxy,warmup,next_read_at
       FROM finder_runs WHERE status='running' ORDER BY next_read_at,id`)).rows;
    for (const run of runs) {
      if (stopping || !await acquireLease()) break;
      await processRun(run);
    }
    await closeIdle();
  }

  function runOnce() {
    if (running) return running;
    if (stopping || !browserUse) return Promise.resolve();
    running = (async () => {
      try { if (await acquireLease()) await tick(); }
      catch (error) { log("finder_worker_failed", { reason: error instanceof AppError ? error.code : error?.code || "internal_error" }); }
      finally { running = null; }
    })();
    return running;
  }

  async function shutdown() {
    stopping = true;
    if (running) await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 8000))]);
    await Promise.all([...browsers.keys()].map((profileId) => closeBrowser(profileId).catch(() => {})));
    await db.query("DELETE FROM finder_worker_lease WHERE owner=$1", [owner]).catch(() => {});
  }

  return {
    configured: () => Boolean(browserUse), status, listProfiles, createRun, updateRun, addSeeds, startRun, pauseRun, deleteRun, getRun, review, usernames,
    runOnce, shutdown
  };
}

module.exports = { createCreatorFinder, readSettings };
