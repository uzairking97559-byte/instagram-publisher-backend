"use strict";

// Joined creators: people who answered a DM with a WhatsApp number or a
// Telegram ID (or whom the owner added). The DM worker hands every new reply
// to capture(); the owner follows up from Creators → Joined and moves each one
// through new → talking → logo_sent → working (or declined).

const { AppError } = require("./publishing");
const { validId } = require("./security");
const { parseUsernames, istDayStart } = require("./dm");

const STATUSES = ["new", "talking", "logo_sent", "working", "declined"];
const TELEGRAM = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const MAX_NOTE = 300;

// A WhatsApp number (Indian mobile: 10 digits from 6–9, with or without +91/0
// and spaces, or a wa.me link) or a Telegram ID (a t.me link, "Telegram … @name",
// "Telegram id: name", or a line that is only "@name") in a reply.
function extractContact(text) {
  const raw = String(text || "").slice(0, 4000);
  let phone = null;
  const number = raw.match(/(^|[^\d+])(?:\+?\s*91[\s-]*|0)?([6-9](?:[\s.-]?\d){9})(?!\d)/);
  if (number) phone = number[2].replace(/\D/g, "");
  let telegram = null;
  const handle = "([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])";
  const found = [
    new RegExp(`(?:^|[^\\w.])(?:t\\.me|telegram\\.me|telegram\\.dog)\\/@?${handle}`, "i"),
    new RegExp(`\\b(?:telegram|tg)\\b[^@\\n]{0,30}@${handle}`, "i"),
    new RegExp(`\\b(?:telegram|tg)(?:\\s*(?:id|username|user\\s?name|handle))?\\s*[:=–-]\\s*${handle}`, "i"),
    new RegExp(`(?:^|\\n)\\s*@${handle}\\s*(?=\\n|$)`)
  ].map((pattern) => raw.match(pattern)).find(Boolean);
  if (found && !/^(joinchat|addstickers|addemoji|share|proxy|socks)$/i.test(found[1])) telegram = found[1];
  return { phone, telegram };
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

  async function list(status = "all") {
    const since = istDayStart(now());
    const counts = (await db.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at>=$1)::int AS today,
        ${STATUSES.map((name) => `COUNT(*) FILTER (WHERE status='${name}')::int AS "${name}"`).join(",")}
       FROM creator_leads`, [since])).rows[0];
    const filter = STATUSES.includes(status) ? status : null;
    const leads = (await db.query(
      `SELECT l.id::text AS id,l.username,l.name,l.phone,l.telegram,l.note,l.status,l.source,l.created_at,l.updated_at,
        l.profile_id::text AS profile_id,i.account
       FROM creator_leads l LEFT JOIN dm_inboxes i ON i.profile_id=l.profile_id
       WHERE ($1::text IS NULL OR l.status=$1) ORDER BY l.created_at DESC, l.id DESC LIMIT 500`, [filter])).rows;
    return { counts, leads };
  }

  // The owner adds someone by hand, or from a reply ("Joined mein daalo").
  async function add(body) {
    const replyId = body.reply_id === undefined || body.reply_id === null || body.reply_id === "" ? null : leadId(body.reply_id, "reply_not_found");
    const reply = replyId ? (await db.query(
      "SELECT id::text AS id,profile_id::text AS profile_id,username,name,text FROM dm_replies WHERE id=$1", [replyId])).rows[0] : null;
    if (replyId && !reply) throw new AppError(404, "reply_not_found");
    const { usernames } = parseUsernames(body.username || reply?.username || "");
    if (usernames.length !== 1) throw new AppError(400, "invalid_lead");
    const phone = cleanPhone(body.phone);
    const telegram = cleanTelegram(body.telegram);
    const found = reply ? extractContact(reply.text) : { phone: null, telegram: null };
    const current = now();
    await db.query(
      `INSERT INTO creator_leads(username,name,profile_id,reply_id,phone,telegram,source,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (username) DO UPDATE SET phone=COALESCE(EXCLUDED.phone,creator_leads.phone),
         telegram=COALESCE(EXCLUDED.telegram,creator_leads.telegram),reply_id=COALESCE(EXCLUDED.reply_id,creator_leads.reply_id),updated_at=EXCLUDED.updated_at`,
      [usernames[0], reply?.name || null, reply?.profile_id || null, reply?.id || null, phone || found.phone, telegram || found.telegram,
        reply ? "dm" : "manual", current]);
    log("lead_added", { from_reply: Boolean(reply) });
    return list();
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
    if (body.phone !== undefined) set("phone", cleanPhone(body.phone));
    if (body.telegram !== undefined) set("telegram", cleanTelegram(body.telegram));
    if (body.note !== undefined) {
      const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : null;
      set("note", note || null);
    }
    if (!fields.length) throw new AppError(400, "invalid_lead");
    set("updated_at", now());
    const row = (await db.query(`UPDATE creator_leads SET ${fields.join(",")} WHERE id=$1 RETURNING id`, values)).rows[0];
    if (!row) throw new AppError(404, "lead_not_found");
    return list();
  }

  async function remove(rawId) {
    const id = leadId(rawId);
    const row = (await db.query("DELETE FROM creator_leads WHERE id=$1 RETURNING id", [id])).rows[0];
    if (!row) throw new AppError(404, "lead_not_found");
    return list();
  }

  return { capture, list, add, update, remove };
}

module.exports = { createLeads, extractContact, STATUSES };
