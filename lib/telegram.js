"use strict";

// Telegram bot for the owner (TELEGRAM_BOT_TOKEN, set in Render, never in a
// chat): new Instagram replies arrive as bot messages; the owner answers by
// replying to that message (or with a saved answer's button) and the DM worker
// sends it from the same Instagram account. Also alerts (a campaign stopped,
// a test finished) and a short summary of the day at 22:00 India time.
//
// Only one Telegram chat is linked: the owner opens a one-time link from the
// website (t.me/<bot>?start=<code>). Every other chat is ignored. Updates
// arrive on a webhook that checks Telegram's secret header.

const crypto = require("node:crypto");
const { AppError } = require("./publishing");
const { validId } = require("./security");

const IST = 330 * 60000;
const LINK_MS = 15 * 60000;
const DIGEST_HOUR = 22;
const MAX_TEMPLATES = 8;
const MAX_TITLE = 24;
const MAX_ANSWER = 1000;
// Replies are announced once each; older than this when the bot is linked, they are skipped.
const ANNOUNCE_WINDOW_MS = 3 * 86400000;
const QUIET_PAUSES = new Set(["owner", "not_started"]);
const PAUSE_TEXT = {
  test_done: "Test poora hua. Instagram mein DMs dekh lo; sab theek ho to website par “Sab baaki” chunkar Start.",
  action_blocked: "Instagram ne warning di, isliye campaign ruk gaya. Kam se kam 24 ghante ruko, phir gap badhakar Start karo.",
  logged_out: "Browser profile mein Instagram login nahi mila. Dobara login karo, phir Start.",
  challenge: "Instagram security check maang raha hai. Instagram app mein khud verify karo, phir Start.",
  too_many_errors: "Lagatar 3 DM nahi gaye, isliye campaign ruk gaya. Website par wajah dekho.",
  browser_use_key_invalid: "Browser Use ne API key reject ki. Render mein BROWSER_USE_API_KEY check karo.",
  browser_use_no_credits: "Browser Use ke credits khatam. Credits daal kar Start karo.",
  browser_use_not_found: "Browser Use mein campaign ka profile nahi mila."
};
const ANSWER_FAIL = {
  not_found: "account nahi mila", not_delivered: "DM nahi pahuncha (sirf followers se message leta hai)", no_chat: "chat nahi mili",
  chat_not_opened: "chat nahi khuli", typing_failed: "type nahi ho paya", send_unconfirmed: "gaya ya nahi, pakka nahi",
  browser_lost: "browser connection toota", page_error: "page mein error", logged_out: "Instagram login nahi mila",
  challenge: "Instagram security check", action_blocked: "Instagram ne warning di", blocked_after_send: "bhejte waqt Instagram warning"
};

const istDayStart = (date) => {
  const shifted = new Date(date.getTime() + IST);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST);
};
const istDate = (date) => new Date(date.getTime() + IST).toISOString().slice(0, 10);
const istHour = (date) => new Date(date.getTime() + IST).getUTCHours();
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const render = (text, username) => String(text).replace(/\{\s*(?:username|name)\s*\}/gi, username || "");

function createTelegram({ db, env = {}, fetchImpl = fetch, log = () => {}, dm = null, kick = () => {}, origin = "", now = () => new Date() }) {
  const token = typeof env.TELEGRAM_BOT_TOKEN === "string" ? env.TELEGRAM_BOT_TOKEN.trim() : "";
  const enabled = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token);
  // Telegram sends this back on every webhook call; derived from the token so
  // there is nothing more to configure.
  const secret = enabled ? crypto.createHmac("sha256", token).update("telegram-webhook").digest("hex").slice(0, 48) : "";
  let botName = typeof env.TELEGRAM_BOT_USERNAME === "string" ? env.TELEGRAM_BOT_USERNAME.replace(/^@/, "").trim() : "";
  let running = null;
  let stopping = false;

  async function call(method, body) {
    let response;
    try {
      response = await fetchImpl(new URL(`https://api.telegram.org/bot${token}/${method}`), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw Object.assign(new Error("telegram_unreachable"), { code: "telegram_unreachable" });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw Object.assign(new Error("telegram_failed"), { code: "telegram_failed", status: response.status });
    return data.result;
  }

  async function settings() {
    return (await db.query("SELECT chat_id::text AS chat_id,linked_at,digest_sent_on::text AS digest_sent_on FROM telegram_settings WHERE id=1")).rows[0] || null;
  }
  async function chatId() { return (await settings())?.chat_id || null; }

  async function send(text, extra = {}) {
    const chat = await chatId();
    if (!enabled || !chat) return null;
    try { return await call("sendMessage", { chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }); }
    catch (error) { log("telegram_send_failed", { reason: error.code || "error" }); return null; }
  }

  // ---- Website side ----

  async function setup() {
    if (!enabled) return;
    try {
      const me = await call("getMe", {});
      if (me?.username) botName = me.username;
      if (origin.startsWith("https://")) {
        await call("setWebhook", { url: `${origin}/telegram/webhook`, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
      }
      log("telegram_ready", {});
    } catch (error) { log("telegram_setup_failed", { reason: error.code || "error" }); }
  }

  async function status() {
    const row = await settings();
    return { configured: enabled, bot: botName || null, linked: Boolean(row?.chat_id), linked_at: row?.linked_at || null };
  }

  // A one-time link (15 minutes) that ties the owner's Telegram chat to the bot.
  async function createLink() {
    if (!enabled) throw new AppError(503, "telegram_not_configured");
    if (!botName) await setup();
    if (!botName) throw new AppError(502, "telegram_failed");
    const code = crypto.randomBytes(18).toString("base64url");
    await db.query(
      `INSERT INTO telegram_settings(id,link_code_hash,link_expires_at) VALUES(1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET link_code_hash=EXCLUDED.link_code_hash,link_expires_at=EXCLUDED.link_expires_at`,
      [sha256(code), new Date(now().getTime() + LINK_MS)]);
    return { url: `https://t.me/${botName}?start=${code}` };
  }

  async function unlink() {
    const chat = await chatId();
    await db.query("UPDATE telegram_settings SET chat_id=NULL,linked_at=NULL,link_code_hash=NULL WHERE id=1");
    if (chat && enabled) await call("sendMessage", { chat_id: chat, text: "Website se Telegram hata diya gaya. Ab yahan messages nahi aayenge." }).catch(() => {});
    log("telegram_unlinked", {});
    return status();
  }

  // ---- Saved answers ("Taiyaar jawab") ----

  async function templates() {
    return (await db.query("SELECT id::text AS id,title,text FROM dm_templates ORDER BY position,id")).rows;
  }
  async function addTemplate(body) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : "";
    if (!title || [...title].length > MAX_TITLE || !text || [...text].length > MAX_ANSWER) throw new AppError(400, "invalid_template");
    const count = (await db.query("SELECT COUNT(*)::int AS count FROM dm_templates")).rows[0].count;
    if (count >= MAX_TEMPLATES) throw new AppError(409, "too_many_templates");
    await db.query("INSERT INTO dm_templates(title,text,position) VALUES($1,$2,$3)", [title, text, count]);
    return { templates: await templates() };
  }
  async function deleteTemplate(rawId) {
    if (!validId(rawId) || rawId.length > 18) throw new AppError(404, "template_not_found");
    await db.query("DELETE FROM dm_templates WHERE id=$1", [rawId]);
    return { templates: await templates() };
  }

  // ---- Webhook: messages and button presses from the linked chat ----

  async function handleUpdate(update, headerSecret) {
    if (!enabled || headerSecret !== secret) throw new AppError(403, "forbidden");
    const message = update?.message;
    const press = update?.callback_query;
    const chat = String(message?.chat?.id ?? press?.message?.chat?.id ?? "");
    if (!chat) return;
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    // Linking: "/start <code>" from the one-time link.
    const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{10,64})$/);
    if (start) return message?.chat?.type === "private" ? link(chat, start[1]) : undefined;
    const linked = await chatId();
    if (!linked || linked !== chat || message?.chat?.type && message.chat.type !== "private") return;
    if (press) return handlePress(press);
    if (!message) return;
    if (/^\/check\b/.test(text)) return checkNow();
    if (/^\/aaj\b/.test(text)) return send(await todayText());
    if (/^\/(help|start)\b/.test(text)) return send(HELP);
    const about = message.reply_to_message?.message_id;
    const replyId = about ? (await db.query("SELECT reply_id::text AS reply_id FROM telegram_messages WHERE message_id=$1", [about])).rows[0]?.reply_id : null;
    if (!replyId) return send("Jawab dene ke liye kisi creator wale message par Reply karke likho.\n\n" + HELP);
    if (!text) return send("Abhi sirf likha hua jawab jata hai (photo/voice nahi).");
    return queueAnswer(replyId, text, message.message_id);
  }

  async function link(chat, code) {
    const row = await settings();
    const valid = row && (await db.query("SELECT 1 FROM telegram_settings WHERE id=1 AND link_code_hash=$1 AND link_expires_at>$2", [sha256(code), now()])).rows.length;
    if (!valid) {
      await call("sendMessage", { chat_id: chat, text: "Ye link purana ho gaya ya galat hai. Website par Messages → Replies → “Telegram jodo” dobara dabao." }).catch(() => {});
      return;
    }
    await db.query("UPDATE telegram_settings SET chat_id=$1,linked_at=$2,link_code_hash=NULL,link_expires_at=NULL WHERE id=1", [chat, now()]);
    log("telegram_linked", {});
    await send("✅ Telegram jud gaya.\n\nNaye replies yahan aayenge. Jawab dene ke liye us message par Reply karo, ya neeche ke button dabao.\n\n" + HELP);
  }

  const HELP = "/check: abhi inbox check karo (~₹2)\n/aaj: aaj ka hisaab";

  async function checkNow() {
    if (!dm) return send("DM Sender abhi set nahi hai.");
    const profiles = (await db.query("SELECT DISTINCT profile_id::text AS profile_id FROM dm_campaigns")).rows;
    if (!profiles.length) return send("Abhi koi DM campaign nahi hai, isliye check karne ko inbox nahi hai.");
    for (const row of profiles) {
      try { await dm.requestCheck({ profile_id: row.profile_id }); }
      catch (error) { return send(`Check shuru nahi hua: ${error.code || "error"}`); }
    }
    kick();
    return send(`🔎 Inbox check shuru (${profiles.length} account). Naye reply 1–3 minute mein yahan aayenge.`);
  }

  async function queueAnswer(replyId, text, sourceId) {
    try { await dm.answerReply(replyId, { message: text }); }
    catch (error) {
      const why = { invalid_answer: "jawab 1 se 1000 akshar ka ho", answers_waiting: "is creator ke 3 jawab pehle se line mein hain", reply_not_found: "ye reply ab nahi mila" }[error.code] || error.code || "error";
      return send(`❌ Jawab line mein nahi laga: ${why}.`, sourceId ? { reply_parameters: { message_id: sourceId } } : {});
    }
    kick();
    return send("⏳ Line mein hai, 1–2 minute mein chala jayega.", sourceId ? { reply_parameters: { message_id: sourceId } } : {});
  }

  async function handlePress(press) {
    const data = String(press.data || "");
    const ack = (text) => call("answerCallbackQuery", { callback_query_id: press.id, text }).catch(() => {});
    const done = data.match(/^d:(\d{1,18})$/);
    if (done) {
      try { await dm.closeReply(done[1]); } catch { return ack("Ye reply ab nahi mila"); }
      await call("editMessageReplyMarkup", { chat_id: press.message.chat.id, message_id: press.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return ack("Ho gaya ✓");
    }
    const saved = data.match(/^t:(\d{1,18}):(\d{1,18})$/);
    if (!saved) return ack("");
    const template = (await db.query("SELECT text FROM dm_templates WHERE id=$1", [saved[2]])).rows[0];
    const reply = (await db.query("SELECT username FROM dm_replies WHERE id=$1", [saved[1]])).rows[0];
    if (!template || !reply) return ack("Ye jawab ya reply ab nahi mila");
    await ack("Line mein ✓");
    return queueAnswer(saved[1], render(template.text, reply.username), press.message.message_id);
  }

  // ---- What the bot sends on its own ----

  async function todayText() {
    const since = istDayStart(now());
    const dms = (await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='sent')::int AS sent, COUNT(*) FILTER (WHERE reason='not_delivered')::int AS undelivered
       FROM dm_targets WHERE sent_at>=$1`, [since])).rows[0];
    const replies = (await db.query("SELECT COUNT(*)::int AS count FROM dm_replies WHERE status<>'undelivered' AND received_at>=$1", [since])).rows[0].count;
    const answered = (await db.query("SELECT COUNT(*)::int AS count FROM dm_outbox WHERE status='sent' AND sent_at>=$1", [since])).rows[0].count;
    const waiting = (await db.query("SELECT COUNT(*)::int AS count FROM dm_replies WHERE status='new'")).rows[0].count;
    const cost = dm ? (await dm.status()).today?.cost_inr ?? 0 : 0;
    const lines = [`📊 Aaj ka hisaab`, `DM gaye: ${dms.sent}${dms.undelivered ? ` (${dms.undelivered} nahi pahunche)` : ""}`,
      `Naye reply: ${replies}`, `Tumhare jawab gaye: ${answered}`, `Kharcha: ₹${cost.toFixed(2)}`];
    if (waiting) lines.push(`\n${waiting} reply ka jawab baaki hai.`);
    return lines.join("\n");
  }

  // A new reply (or a new message in a known chat): one bot message, with the
  // saved answers as buttons. The row is claimed first, so two copies of the
  // service never announce it twice.
  async function announceReplies(linkedAt) {
    const since = new Date(Math.max(new Date(linkedAt).getTime() - ANNOUNCE_WINDOW_MS, now().getTime() - ANNOUNCE_WINDOW_MS));
    const rows = (await db.query(
      `SELECT r.id::text AS id,r.username,r.name,r.text,i.account,c.profile_name FROM dm_replies r
       LEFT JOIN dm_inboxes i ON i.profile_id=r.profile_id
       LEFT JOIN LATERAL (SELECT profile_name FROM dm_campaigns WHERE profile_id=r.profile_id ORDER BY created_at DESC LIMIT 1) c ON TRUE
       WHERE r.status='new' AND r.announced_at IS NULL AND r.received_at>=$1 ORDER BY r.received_at LIMIT 10`, [since])).rows;
    const saved = await templates();
    for (const row of rows) {
      if (stopping) return;
      const claimed = await db.query("UPDATE dm_replies SET announced_at=$2 WHERE id=$1 AND announced_at IS NULL RETURNING id", [row.id, now()]);
      if (!claimed.rows.length) continue;
      const who = row.username ? `@${row.username}` : row.name || "Creator";
      const via = row.account ? `@${row.account}` : row.profile_name || "account";
      const buttons = saved.slice(0, 6).map((item) => ({ text: item.title, callback_data: `t:${row.id}:${item.id}` }));
      const keyboard = [];
      for (let index = 0; index < buttons.length; index += 2) keyboard.push(buttons.slice(index, index + 2));
      keyboard.push([{ text: "✓ Ho gaya", callback_data: `d:${row.id}` },
        ...(row.username ? [{ text: "Profile ↗", url: `https://www.instagram.com/${row.username}/` }] : [])]);
      const sent = await send(`💬 ${who}  (${via} par)\n\n${row.text}\n\n↩️ Jawab ke liye is message par Reply karo.`, { reply_markup: { inline_keyboard: keyboard } });
      if (sent?.message_id) await db.query("INSERT INTO telegram_messages(message_id,reply_id) VALUES($1,$2) ON CONFLICT (message_id) DO NOTHING", [sent.message_id, row.id]);
      else await db.query("UPDATE dm_replies SET announced_at=NULL WHERE id=$1", [row.id]);
    }
  }

  // Each answer's result, once: sent, or why not.
  async function announceAnswers(linkedAt) {
    const rows = (await db.query(
      `SELECT o.id::text AS id,o.status,o.reason,o.message,r.username,r.name FROM dm_outbox o JOIN dm_replies r ON r.id=o.reply_id
       WHERE o.status IN ('sent','failed') AND o.announced_at IS NULL AND o.updated_at>=$1 ORDER BY o.id LIMIT 10`, [linkedAt])).rows;
    for (const row of rows) {
      const claimed = await db.query("UPDATE dm_outbox SET announced_at=$2 WHERE id=$1 AND announced_at IS NULL RETURNING id", [row.id, now()]);
      if (!claimed.rows.length) continue;
      const who = row.username ? `@${row.username}` : row.name || "creator";
      const short = row.message.length > 80 ? `${row.message.slice(0, 80)}…` : row.message;
      await send(row.status === "sent" ? `✅ ${who} ko jawab gaya: “${short}”`
        : `❌ ${who} ko jawab nahi gaya (${ANSWER_FAIL[row.reason] || row.reason || "pata nahi"}): “${short}”`);
    }
  }

  async function digest(row) {
    const current = now();
    if (istHour(current) < DIGEST_HOUR || row.digest_sent_on === istDate(current)) return;
    const claimed = await db.query(
      "UPDATE telegram_settings SET digest_sent_on=$1 WHERE id=1 AND (digest_sent_on IS NULL OR digest_sent_on<$1) RETURNING id", [istDate(current)]);
    if (!claimed.rows.length) return;
    const since = istDayStart(current);
    const active = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM dm_targets WHERE sent_at>=$1) OR EXISTS (SELECT 1 FROM dm_replies WHERE received_at>=$1 AND status<>'undelivered') AS any`, [since])).rows[0];
    if (active.any) await send(await todayText());
  }

  // Alerts from the DM worker (lib/dm.js onEvent).
  async function alert(event, details = {}) {
    if (!enabled) return;
    try {
      if (event === "paused" && !QUIET_PAUSES.has(details.reason)) {
        const what = PAUSE_TEXT[details.reason] || `Campaign ruk gaya (${details.reason}).`;
        await send(`⚠️ “${details.name || "Campaign"}”: ${what}${details.detail ? `\nInstagram ne likha: “${details.detail}”` : ""}`);
      } else if (event === "completed") {
        await send(`🏁 “${details.name || "Campaign"}” ki poori list ho gayi.`);
      }
    } catch (error) { log("telegram_alert_failed", { reason: error.code || "error" }); }
  }

  async function tick() {
    const row = await settings();
    if (!row?.chat_id) return;
    await announceReplies(row.linked_at);
    await announceAnswers(row.linked_at);
    await digest(row);
  }

  function runOnce() {
    if (running) return running;
    if (!enabled || stopping) return Promise.resolve();
    running = (async () => {
      try { await tick(); }
      catch (error) { log("telegram_worker_failed", { reason: error.code || "error" }); }
      finally { running = null; }
    })();
    return running;
  }

  async function shutdown() {
    stopping = true;
    if (running) await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  return { enabled: () => enabled, setup, status, createLink, unlink, templates, addTemplate, deleteTemplate, handleUpdate, alert, runOnce, shutdown };
}

module.exports = { createTelegram };
