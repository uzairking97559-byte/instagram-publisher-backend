"use strict";

// Joined creators: people who answered a DM with a WhatsApp number or a
// Telegram ID, old creators the owner imports from his phone, and anyone he
// adds by hand. The DM worker hands every new reply to capture(); the owner
// follows up from Creators → Joined and moves each one through
// new → talking → logo_sent → working (or declined). "Kaun laya" (referrer)
// records which manager or creator brought a page, and a target (e.g. 50
// working by a date) shows how far there is to go.

const { AppError } = require("./publishing");
const { validId } = require("./security");
const { parseUsernames, istDayStart } = require("./dm");

const STATUSES = ["new", "talking", "logo_sent", "working", "declined"];
const TELEGRAM = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const PHONE = /(^|[^\d+])(?:\+?\s*91[\s-]*|0)?([6-9](?:[\s.-]?\d){9})(?!\d)/;
const HANDLE = "([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])";
const TELEGRAM_LINK = new RegExp(`(?:^|[^\\w.])(?:https?:\\/\\/)?(?:t\\.me|telegram\\.me|telegram\\.dog)\\/@?${HANDLE}`, "i");
const TELEGRAM_NAMED = [
  new RegExp(`\\b(?:telegram|tg)\\b[^@\\n]{0,30}@${HANDLE}`, "i"),
  new RegExp(`\\b(?:telegram|tg)(?:\\s*(?:id|username|user\\s?name|handle))?\\s*[:=–-]\\s*${HANDLE}`, "i")
];
const NOT_HANDLES = /^(joinchat|addstickers|addemoji|share|proxy|socks)$/i;
const MAX_NOTE = 300;
const MAX_IMPORT = 2000;
const DAY = 86400000;

function telegramIn(raw, { lone = true } = {}) {
  const patterns = [TELEGRAM_LINK, ...TELEGRAM_NAMED, ...(lone ? [new RegExp(`(?:^|\\n)\\s*@${HANDLE}\\s*(?=\\n|$)`)] : [])];
  const found = patterns.map((pattern) => raw.match(pattern)).find(Boolean);
  return found && !NOT_HANDLES.test(found[1]) ? found[1] : null;
}

// A WhatsApp number (Indian mobile: 10 digits from 6–9, with or without +91/0
// and spaces, or a wa.me link) or a Telegram ID (a t.me link, "Telegram … @name",
// "Telegram id: name", or a line that is only "@name") in a reply.
function extractContact(text) {
  const raw = String(text || "").slice(0, 4000);
  const number = raw.match(PHONE);
  return { phone: number ? number[2].replace(/\D/g, "") : null, telegram: telegramIn(raw) };
}

// One line of a pasted list of old creators: any order of a name, a number,
// an Instagram link or @username, and a t.me link. "@name" counts as the
// Instagram username here (these are Instagram pages); Telegram needs a link
// or the word "telegram".
function parseImportLine(line) {
  let rest = String(line || "").slice(0, 300);
  const number = rest.match(PHONE);
  const phone = number ? number[2].replace(/\D/g, "") : null;
  if (number) rest = rest.replace(number[0], number[1] + " ");
  const telegram = telegramIn(rest, { lone: false });
  rest = rest.replace(/(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/\S*/gi, " ")
    .replace(/\b(?:telegram|tg)\b(?:\s*(?:id|username|user\s?name|handle))?\s*[:=–-]?\s*@?[A-Za-z][A-Za-z0-9_]{4,31}/gi, " ");
  let username = null;
  const link = rest.match(/(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s,;|]+/i);
  if (link) {
    const { usernames } = parseUsernames(link[0]);
    username = usernames[0] || null;
    rest = rest.replace(link[0], " ");
  }
  const words = [];
  for (const token of rest.split(/[\s,;|\t]+/)) {
    if (!token) continue;
    if (token.startsWith("@") && !username) {
      const { usernames } = parseUsernames(token);
      if (usernames.length === 1) { username = usernames[0]; continue; }
    }
    if (/^[\p{L}\p{N}][\p{L}\p{N}._&'-]*$/u.test(token)) words.push(token);
  }
  const name = words.join(" ").slice(0, 80) || null;
  return { username, phone, telegram, name };
}

function cleanPhone(value) {
  if (value === null || value === undefined || value === "") return null;
  const { phone } = extractContact(String(value));
  if (!phone) throw new AppError(400, "invalid_lead");
  return phone;
}
function cleanTelegram(value) {
  if (value === null || value === undefined || value === "") return null;
  const handle = String(value).trim().replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, "").replace(/^@/, "").replace(/\/+$/, "");
  if (!TELEGRAM.test(handle)) throw new AppError(400, "invalid_lead");
  return handle;
}
function cleanUsername(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const { usernames } = parseUsernames(value);
  if (usernames.length !== 1) throw new AppError(400, "invalid_lead");
  return usernames[0];
}
function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || null;
}

function createLeads({ db, log = () => {}, now = () => new Date(), onEvent = () => {} }) {
  const emit = (event, details) => { Promise.resolve().then(() => onEvent(event, details)).catch(() => {}); };

  function leadId(value, code = "lead_not_found") {
    const id = String(value ?? "");
    if (!validId(id) || id.length > 18) throw new AppError(404, code);
    return id;
  }

  // A new reply from the DM worker: a number or Telegram ID in it makes (or
  // completes) that creator's lead. Never throws into the worker.
  async function capture(reply) {
    try {
      const username = typeof reply?.username === "string" ? reply.username : "";
      if (!/^[a-z0-9._]{1,30}$/.test(username)) return null;
      const { phone, telegram } = extractContact(reply.text);
      if (!phone && !telegram) return null;
      const old = (await db.query("SELECT id::text AS id,phone,telegram FROM creator_leads WHERE username=$1", [username])).rows[0];
      if (old && (!phone || old.phone === phone) && (!telegram || old.telegram === telegram)) return old.id;
      const current = now();
      const row = old
        ? (await db.query(
          `UPDATE creator_leads SET phone=COALESCE($2,phone),telegram=COALESCE($3,telegram),reply_id=COALESCE($4,reply_id),updated_at=$5
           WHERE id=$1 RETURNING id::text AS id`, [old.id, phone, telegram, reply.id || null, current])).rows[0]
        : (await db.query(
          `INSERT INTO creator_leads(username,name,profile_id,reply_id,phone,telegram,source,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,'dm',$7,$7) ON CONFLICT (username) DO NOTHING RETURNING id::text AS id`,
          [username, reply.name ? String(reply.name).slice(0, 80) : null, reply.profile_id || null, reply.id || null, phone, telegram, current])).rows[0];
      log("lead_captured", { phone: Boolean(phone), telegram: Boolean(telegram), updated: Boolean(old) });
      emit("lead", { username, phone, telegram });
      return row?.id || null;
    } catch (error) {
      log("lead_capture_failed", { reason: error.code || "error" });
      return null;
    }
  }

  // Adds a creator or completes the one already there (same Instagram
  // username, else same number). `prefer`: "new" lets the given values
  // replace old ones (the owner typed them); "old" only fills gaps (imports).
  async function upsert(fields, source, prefer) {
    const old = (await db.query(
      `SELECT id::text AS id,username,phone,telegram,name,referrer,profile_id::text AS profile_id,reply_id::text AS reply_id FROM creator_leads
       WHERE ($1::text IS NOT NULL AND username=$1) OR ($2::text IS NOT NULL AND phone=$2)
       ORDER BY (username IS NOT DISTINCT FROM $1) DESC, id LIMIT 1`, [fields.username, fields.phone])).rows[0];
    const current = now();
    if (!old) {
      await db.query(
        `INSERT INTO creator_leads(username,name,profile_id,reply_id,phone,telegram,referrer,source,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [fields.username, fields.name, fields.profile_id || null, fields.reply_id || null, fields.phone, fields.telegram, fields.referrer, source, current]);
      return "added";
    }
    const merged = {};
    for (const key of ["username", "phone", "telegram", "name", "referrer", "profile_id", "reply_id"]) {
      const given = fields[key] ?? null;
      merged[key] = prefer === "new" ? given ?? old[key] : old[key] ?? given;
    }
    if (Object.keys(merged).every((key) => merged[key] === old[key])) return "same";
    await db.query(
      `UPDATE creator_leads SET username=$2,phone=$3,telegram=$4,name=$5,referrer=$6,profile_id=$7,reply_id=$8,updated_at=$9 WHERE id=$1`,
      [old.id, merged.username, merged.phone, merged.telegram, merged.name, merged.referrer, merged.profile_id, merged.reply_id, current]);
    return "updated";
  }

  async function settings() {
    const row = (await db.query("SELECT target,deadline::text AS deadline FROM lead_settings WHERE id=1")).rows[0];
    return { target: row?.target ?? 50, deadline: row?.deadline ?? null, saved: Boolean(row) };
  }

  async function list(status = "all", referrer = "") {
    const current = now();
    const since = istDayStart(current);
    const counts = (await db.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at>=$1)::int AS today,
        ${STATUSES.map((name) => `COUNT(*) FILTER (WHERE status='${name}')::int AS "${name}"`).join(",")}
       FROM creator_leads`, [since])).rows[0];
    const filter = STATUSES.includes(status) ? status : null;
    const by = cleanText(referrer, 60);
    const leads = (await db.query(
      `SELECT l.id::text AS id,l.username,l.name,l.phone,l.telegram,l.note,l.referrer,l.status,l.source,l.created_at,l.updated_at,
        l.profile_id::text AS profile_id,i.account
       FROM creator_leads l LEFT JOIN dm_inboxes i ON i.profile_id=l.profile_id
       WHERE ($1::text IS NULL OR l.status=$1) AND ($2::text IS NULL OR lower(l.referrer)=lower($2))
       ORDER BY l.created_at DESC, l.id DESC LIMIT 1000`, [filter, by])).rows;
    const referrers = (await db.query(
      `SELECT (array_agg(referrer ORDER BY id))[1] AS name, COUNT(*)::int AS pages, COUNT(*) FILTER (WHERE status='working')::int AS working
       FROM creator_leads WHERE referrer IS NOT NULL GROUP BY lower(referrer) ORDER BY COUNT(*) DESC, lower(referrer) LIMIT 100`)).rows;
    // The target: how many are working, and how many a day are still needed.
    const goal = await settings();
    let daysLeft = null;
    if (goal.deadline) daysLeft = Math.max(0, Math.ceil((Date.parse(`${goal.deadline}T00:00:00+05:30`) + DAY - current.getTime()) / DAY));
    const remaining = Math.max(0, goal.target - counts.working);
    const target = { ...goal, working: counts.working, logo_sent: counts.logo_sent, remaining, days_left: daysLeft,
      per_day: daysLeft ? Math.ceil(remaining / daysLeft) : null };
    return { counts, leads, referrers, target };
  }

  // The owner adds someone by hand, or from a reply ("Joined mein daalo").
  async function add(body) {
    const replyId = body.reply_id === undefined || body.reply_id === null || body.reply_id === "" ? null : leadId(body.reply_id, "reply_not_found");
    const reply = replyId ? (await db.query(
      "SELECT id::text AS id,profile_id::text AS profile_id,username,name,text FROM dm_replies WHERE id=$1", [replyId])).rows[0] : null;
    if (replyId && !reply) throw new AppError(404, "reply_not_found");
    const found = reply ? extractContact(reply.text) : { phone: null, telegram: null };
    const fields = {
      username: cleanUsername(body.username || reply?.username || ""),
      phone: cleanPhone(body.phone) || found.phone,
      telegram: cleanTelegram(body.telegram) || found.telegram,
      name: cleanText(body.name, 80) || (reply?.name ? String(reply.name).slice(0, 80) : null),
      referrer: cleanText(body.referrer, 60),
      profile_id: reply?.profile_id || null,
      reply_id: reply?.id || null
    };
    if (!fields.username && !fields.phone && !fields.telegram) throw new AppError(400, "invalid_lead");
    try { await upsert(fields, reply ? "dm" : "manual", "new"); }
    catch (error) { if (error.code === "23505") throw new AppError(409, "lead_exists"); throw error; }
    log("lead_added", { from_reply: Boolean(reply) });
    return list();
  }

  // Old creators pasted from the phone, one per line (a name and a number, or
  // an Instagram link/@username). Already-listed ones are only completed.
  async function importLeads(body) {
    const lines = String(body.text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new AppError(400, "invalid_import");
    if (lines.length > MAX_IMPORT) throw new AppError(400, "too_many_leads");
    const referrer = cleanText(body.referrer, 60);
    const result = { added: 0, updated: 0, same: 0, invalid: [] };
    const seen = new Set();
    for (const line of lines) {
      const fields = parseImportLine(line);
      if (!fields.username && !fields.phone) { if (result.invalid.length < 20) result.invalid.push(line.slice(0, 60)); else result.invalid_more = true; continue; }
      const key = fields.username || fields.phone;
      if (seen.has(key)) { result.same++; continue; }
      seen.add(key);
      try { result[await upsert({ ...fields, referrer }, "import", "old")]++; }
      catch (error) { if (error.code !== "23505") throw error; result.same++; }
    }
    log("leads_imported", { added: result.added, updated: result.updated, same: result.same, invalid: result.invalid.length });
    return { ...result, ...(await list()) };
  }

  async function update(rawId, body) {
    const id = leadId(rawId);
    const fields = [];
    const values = [id];
    const set = (column, value) => { values.push(value); fields.push(`${column}=$${values.length}`); };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new AppError(400, "invalid_lead");
      set("status", body.status);
    }
    if (body.username !== undefined) set("username", cleanUsername(body.username));
    if (body.phone !== undefined) set("phone", cleanPhone(body.phone));
    if (body.telegram !== undefined) set("telegram", cleanTelegram(body.telegram));
    if (body.name !== undefined) set("name", cleanText(body.name, 80));
    if (body.referrer !== undefined) set("referrer", cleanText(body.referrer, 60));
    if (body.note !== undefined) {
      const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : null;
      set("note", note || null);
    }
    if (!fields.length) throw new AppError(400, "invalid_lead");
    set("updated_at", now());
    let row;
    try { row = (await db.query(`UPDATE creator_leads SET ${fields.join(",")} WHERE id=$1 RETURNING id`, values)).rows[0]; }
    catch (error) { if (error.code === "23505") throw new AppError(409, "lead_exists"); throw error; }
    if (!row) throw new AppError(404, "lead_not_found");
    return list();
  }

  async function remove(rawId) {
    const id = leadId(rawId);
    const row = (await db.query("DELETE FROM creator_leads WHERE id=$1 RETURNING id", [id])).rows[0];
    if (!row) throw new AppError(404, "lead_not_found");
    return list();
  }

  // The target: e.g. 50 creators working by a date (India time).
  async function saveTarget(body) {
    const target = Number(body.target);
    if (!Number.isInteger(target) || target < 1 || target > 100000) throw new AppError(400, "invalid_target");
    let deadline = null;
    if (body.deadline !== undefined && body.deadline !== null && body.deadline !== "") {
      deadline = String(body.deadline);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(`${deadline}T00:00:00Z`)) ||
          new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) !== deadline) throw new AppError(400, "invalid_target");
    }
    await db.query(
      `INSERT INTO lead_settings(id,target,deadline) VALUES(1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET target=EXCLUDED.target,deadline=EXCLUDED.deadline`, [target, deadline]);
    return list();
  }

  return { capture, list, add, importLeads, update, remove, saveTarget, settings };
}

module.exports = { createLeads, extractContact, parseImportLine, STATUSES };
