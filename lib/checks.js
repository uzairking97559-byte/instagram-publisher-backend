"use strict";

// Creator list check: for each username, asks Instagram (Business Discovery,
// through one of the owner's connected accounts) whether it is still a
// professional account, how many followers it has and when it last posted.
// It runs in the background, one username at a time, at a pace Instagram
// allows (about 180 an hour by default), so a list of thousands takes a day or two.

const { MetaError } = require("./meta");
const { AppError } = require("./publishing");
const { decryptToken, validId } = require("./security");
const { parseUsernames } = require("./dm");

const SCOPE = "instagram_manage_insights";
const MAX_ITEMS = 10000;
// So many "not found" in a row means something is wrong with the setup, not the list.
const NOT_FOUND_STREAK = 40;
const MAX_ATTEMPTS = 3;
const RATE_BACKOFF_MS = 30 * 60000;
const RETRY_MS = 2 * 60000;
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

// Usernames from pasted text or a file. When the text has instagram.com links,
// only the links count: a sheet's name column would otherwise add junk names.
function readList(text) {
  const raw = String(text ?? "");
  const links = raw.match(/(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s,;"'<>]+/gi);
  return links && links.length ? parseUsernames(links.join("\n")) : parseUsernames(raw);
}

function gapFromEnv(env) {
  const seconds = Number(env.CHECK_INTERVAL_SECONDS);
  return Number.isFinite(seconds) && seconds >= 5 && seconds <= 600 ? seconds * 1000 : 20000;
}

// Which part of a check's results a request asks for (fixed SQL, no input in it).
const FILTERS = {
  active: "i.status='found' AND i.last_post_at >= $2::timestamptz - make_interval(days => c.active_days)",
  old: "i.status='found' AND (i.last_post_at IS NULL OR i.last_post_at < $2::timestamptz - make_interval(days => c.active_days))",
  not_found: "i.status='not_found'",
  pending: "i.status='pending'",
  error: "i.status='error'",
  all: "TRUE"
};

function createCreatorChecker({ db, meta, key, env = {}, log = () => {}, now = () => new Date() }) {
  const gapMs = gapFromEnv(env);
  let running = null;
  let stopping = false;

  function checkId(value) {
    if (!validId(value) || value.length > 18) throw new AppError(400, "check_not_found");
    return value;
  }

  // The newest Facebook-connected account that granted the insights permission.
  async function connection() {
    const result = await db.query(
      `SELECT id::text AS id, account_id, username, encrypted_token FROM publisher_accounts
       WHERE provider='facebook' AND $1 = ANY(scopes) AND NOT needs_reconnect
         AND (token_expires_at IS NULL OR token_expires_at > NOW())
       ORDER BY updated_at DESC, id DESC LIMIT 1`, [SCOPE]);
    return result.rows[0] || null;
  }

  async function summaries(onlyId = null) {
    const result = await db.query(
      `SELECT c.id::text AS id, c.name, c.active_days, c.status, c.pause_reason, c.next_check_at, c.created_at,
        COUNT(i.id)::int AS total,
        COUNT(i.id) FILTER (WHERE i.status='pending')::int AS pending,
        COUNT(i.id) FILTER (WHERE ${FILTERS.active.replace("$2", "$1")})::int AS active,
        COUNT(i.id) FILTER (WHERE ${FILTERS.old.replace("$2", "$1")})::int AS old,
        COUNT(i.id) FILTER (WHERE i.status='not_found')::int AS not_found,
        COUNT(i.id) FILTER (WHERE i.status='error')::int AS errors
       FROM creator_checks c LEFT JOIN creator_check_items i ON i.check_id=c.id
       WHERE ($2::bigint IS NULL OR c.id=$2::bigint)
       GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC`, [now(), onlyId]);
    return result.rows.map((row) => ({
      id: row.id, name: row.name, active_days: row.active_days, status: row.status, pause_reason: row.pause_reason,
      next_check_at: row.next_check_at, created_at: row.created_at,
      counts: { total: row.total, pending: row.pending, active: row.active, old: row.old, not_found: row.not_found, errors: row.errors },
      eta_minutes: row.status === "done" ? 0 : Math.ceil((row.pending * gapMs) / 60000)
    }));
  }

  async function summary(id) {
    const [row] = await summaries(id);
    if (!row) throw new AppError(404, "check_not_found");
    return row;
  }

  async function status() {
    const account = await connection();
    return {
      connected: Boolean(account), account: account ? account.username : null,
      per_hour: Math.floor(3600000 / gapMs), checks: await summaries()
    };
  }

  async function createCheck(body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const days = body.active_days === undefined || body.active_days === "" ? 30 : Number(body.active_days);
    if (!name || name.length > 60 || !Number.isInteger(days) || days < 1 || days > 365) throw new AppError(400, "invalid_check");
    const { usernames, invalid } = readList(body.usernames);
    if (!usernames.length) throw new AppError(400, "invalid_usernames");
    if (usernames.length > MAX_ITEMS) throw new AppError(400, "too_many_usernames");
    const id = await db.transaction(async (tx) => {
      const row = (await tx.query("INSERT INTO creator_checks(name,active_days,next_check_at) VALUES($1,$2,$3) RETURNING id::text AS id",
        [name, days, now()])).rows[0];
      await tx.query(
        `INSERT INTO creator_check_items(check_id,username,position)
         SELECT $1::bigint, u.username, u.ord::int FROM unnest($2::text[]) WITH ORDINALITY AS u(username, ord)
         ON CONFLICT (check_id, username) DO NOTHING`, [row.id, usernames]);
      return row.id;
    });
    log("creator_check_created", { check: id, usernames: usernames.length });
    return { check: await summary(id), added: usernames.length, invalid };
  }

  // Results, biggest accounts first; `limit` keeps the page light.
  async function getCheck(rawId, filter = "all", limit = 200) {
    const id = checkId(rawId);
    const check = await summary(id);
    const where = FILTERS[filter] || FILTERS.all;
    const items = await db.query(
      `SELECT i.username, i.status, i.followers, i.media_count, i.last_post_at, i.checked_at
       FROM creator_check_items i JOIN creator_checks c ON c.id=i.check_id
       WHERE i.check_id=$1 AND $2::timestamptz IS NOT NULL AND ${where}
       ORDER BY i.followers DESC NULLS LAST, i.position LIMIT $3`, [id, now(), Math.max(1, Math.min(MAX_ITEMS, limit))]);
    return { check, items: items.rows };
  }

  async function usernames(rawId, filter = "active") {
    const { items } = await getCheck(rawId, FILTERS[filter] ? filter : "active", MAX_ITEMS);
    return { usernames: items.map((item) => item.username) };
  }

  async function pauseCheck(rawId) {
    const id = checkId(rawId);
    await db.query("UPDATE creator_checks SET status='paused',pause_reason='owner',updated_at=NOW() WHERE id=$1 AND status='running'", [id]);
    return { check: await summary(id) };
  }

  async function startCheck(rawId) {
    const id = checkId(rawId);
    await summary(id);
    await db.query(
      `UPDATE creator_checks SET status='running',pause_reason=NULL,not_found_streak=0,next_check_at=$2,updated_at=NOW()
       WHERE id=$1 AND status<>'running'`, [id, now()]);
    // Errors get one more try when the check is started again.
    await db.query("UPDATE creator_check_items SET status='pending',attempts=0 WHERE check_id=$1 AND status='error'", [id]);
    return { check: await summary(id) };
  }

  async function deleteCheck(rawId) {
    const id = checkId(rawId);
    const result = await db.query("DELETE FROM creator_checks WHERE id=$1 RETURNING id", [id]);
    if (!result.rows.length) throw new AppError(404, "check_not_found");
    return { ok: true };
  }

  // ---- Worker: at most one username per `gapMs` across all checks ----

  const pause = (id, reason) => db.query(
    "UPDATE creator_checks SET status='paused',pause_reason=$2,updated_at=NOW() WHERE id=$1 AND status='running'", [id, reason])
    .then(() => log("creator_check_paused", { check: id, reason }));
  const later = (id, ms) => db.query("UPDATE creator_checks SET next_check_at=$2,updated_at=NOW() WHERE id=$1",
    [id, new Date(now().getTime() + ms)]);

  async function tick() {
    const current = now();
    // Taking the slot moves next_check_at forward, so two copies of the
    // service (during a deploy) never check at the same time.
    const claimed = (await db.query(
      `UPDATE creator_checks SET next_check_at=$2,updated_at=NOW()
       WHERE id=(SELECT id FROM creator_checks WHERE status='running' AND next_check_at<=$1 ORDER BY created_at,id LIMIT 1)
         AND status='running' AND next_check_at<=$1
       RETURNING id::text AS id`, [current, new Date(current.getTime() + gapMs)])).rows[0];
    if (!claimed) return;
    const item = (await db.query(
      "SELECT id::text AS id, username, attempts FROM creator_check_items WHERE check_id=$1 AND status='pending' ORDER BY position LIMIT 1",
      [claimed.id])).rows[0];
    if (!item) {
      await db.query("UPDATE creator_checks SET status='done',pause_reason=NULL,updated_at=NOW() WHERE id=$1 AND status='running'", [claimed.id]);
      log("creator_check_done", { check: claimed.id });
      return;
    }
    const account = await connection();
    if (!account) return pause(claimed.id, "permission_required");
    let token;
    try { token = decryptToken(account.encrypted_token, key, `facebook:${account.account_id}`); }
    catch { return pause(claimed.id, "token_storage_unavailable"); }

    try {
      const found = await meta.businessDiscovery(account.account_id, token, item.username);
      await db.query(
        `UPDATE creator_check_items SET status='found',followers=$2,media_count=$3,last_post_at=$4,attempts=attempts+1,checked_at=$5
         WHERE id=$1`, [item.id, found.followers, found.mediaCount, found.lastPostAt, current]);
      await db.query("UPDATE creator_checks SET not_found_streak=0 WHERE id=$1", [claimed.id]);
    } catch (error) {
      if (!(error instanceof MetaError)) throw error;
      const { code, subcode } = error;
      if (code === 110 || subcode === 2207013) {
        // Renamed, deleted, or no longer a professional account.
        await db.query("UPDATE creator_check_items SET status='not_found',attempts=attempts+1,checked_at=$2 WHERE id=$1", [item.id, current]);
        const streak = (await db.query(
          "UPDATE creator_checks SET not_found_streak=not_found_streak+1 WHERE id=$1 RETURNING not_found_streak", [claimed.id])).rows[0];
        if (streak && streak.not_found_streak >= NOT_FOUND_STREAK) await pause(claimed.id, "too_many_not_found");
      } else if (RATE_LIMIT_CODES.has(code) || (code >= 80001 && code <= 80014)) {
        await later(claimed.id, RATE_BACKOFF_MS);
        log("creator_check_rate_limited", { check: claimed.id, code });
      } else if (code === 190 || code === 102) {
        await db.query("UPDATE publisher_accounts SET needs_reconnect=TRUE WHERE id=$1", [account.id]);
        await pause(claimed.id, "reconnect_required");
      } else if (code === 10 || code === 200 || code === 3) {
        await pause(claimed.id, "permission_required");
      } else {
        const failed = item.attempts + 1 >= MAX_ATTEMPTS;
        await db.query("UPDATE creator_check_items SET status=$2,attempts=attempts+1,checked_at=$3 WHERE id=$1",
          [item.id, failed ? "error" : "pending", current]);
        if (!failed) await later(claimed.id, RETRY_MS);
        log("creator_check_error", { check: claimed.id, code, subcode });
      }
    }
  }

  function runOnce() {
    if (running) return running;
    if (stopping) return Promise.resolve();
    running = (async () => {
      try { await tick(); }
      catch (error) { log("creator_check_failed", { reason: error instanceof AppError ? error.code : error?.code || "internal_error" }); }
      finally { running = null; }
    })();
    return running;
  }

  async function shutdown() {
    stopping = true;
    if (running) await running;
  }

  return { status, createCheck, getCheck, usernames, pauseCheck, startCheck, deleteCheck, runOnce, shutdown };
}

module.exports = { createCreatorChecker, readList };
