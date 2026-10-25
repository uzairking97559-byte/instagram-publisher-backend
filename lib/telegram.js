"use strict";

// Telegram bot for the owner (TELEGRAM_BOT_TOKEN, set in Render, never in a
// chat): new Instagram replies arrive as bot messages; the owner answers by
// replying to that message (or with a saved answer's button) and the DM worker
// sends it from the same Instagram account. Also alerts (a campaign stopped,
// a test finished), a short summary of the day at 22:00 India time, and a
// morning report of the day before at 09:00 (also on /kal).
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
const REPORT_HOUR = 9;
const DAY = 86400000;
// Pauses that need the owner (not his own pause, a finished test or a new campaign).
const PROBLEM_PAUSES = new Set(["action_blocked", "logged_out", "challenge", "too_many_errors", "browser_use_key_invalid", "browser_use_no_credits", "browser_use_not_found"]);
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
// Creator finder (lib/finder.js) pauses.
const FINDER_TEXT = {
  test_done: "Test poora hua. Website par results dekh lo; theek lage to “Sab baaki” chunkar Start.",
  rate_limited: "Instagram ne profiles kholne ki limit lagayi, isliye search ruk gaya. 24 ghante ruko, phir gap badhakar Start karo.",
  logged_out: "Finder wale browser profile mein Instagram login nahi mila. Dobara login karo, phir Start.",
  challenge: "Finder account se Instagram security check maang raha hai. Instagram app mein khud verify karo, phir Start.",
  too_many_errors: "Lagatar 5 profiles nahi khule, isliye search ruk gaya. Website par wajah dekho.",
  browser_use_key_invalid: "Browser Use ne API key reject ki. Render mein BROWSER_USE_API_KEY check karo.",
  browser_use_no_credits: "Browser Use ke credits khatam. Credits daal kar Start karo.",
  browser_use_not_found: "Browser Use mein finder ka profile nahi mila."
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

// reviewReel(id, approve): approves or rejects a creator's first Reel in the
// Workwithme bot (lib/creator-bot.js); its "first_reel" alert carries the buttons.
function createTelegram({ db, env = {}, fetchImpl = fetch, log = () => {}, dm = null, kick = () => {}, origin = "", now = () => new Date(), reviewReel = null }) {
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
    return (await db.query("SELECT chat_id::text AS chat_id,linked_at,digest_sent_on::text AS digest_sent_on,report_sent_on::text AS report_sent_on FROM telegram_settings WHERE id=1")).rows[0] || null;
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
      // The "Menu" button beside the message box lists these.
      await call("setMyCommands", { commands: COMMANDS });
      await call("setChatMenuButton", { menu_button: { type: "commands" } }).catch(() => {});
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
    if (/^\/kal\b/.test(text)) return send((await reportText())?.text || "Report nahi ban payi.");
    if (/^\/replies\b/.test(text)) return pendingReplies();
    if (/^\/campaigns\b/.test(text)) return campaignList();
    if (/^\/jawab\b/.test(text)) return templateList();
    if (/^\/(menu|help|start)\b/.test(text)) return menu();
    const about = message.reply_to_message?.message_id;
    const replyId = about ? (await db.query("SELECT reply_id::text AS reply_id FROM telegram_messages WHERE message_id=$1", [about])).rows[0]?.reply_id : null;
    if (!replyId) return menu("Jawab dene ke liye kisi creator wale message par Reply karke likho. Ya neeche se chuno:");
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
    await send("✅ Telegram jud gaya.\n\nNaye replies yahan aayenge. Jawab dene ke liye us message par Reply karo, ya uske neeche ke button dabao.");
    await menu();
  }

  const COMMANDS = [
    { command: "menu", description: "Main menu" },
    { command: "replies", description: "Jinka jawab baaki hai" },
    { command: "check", description: "Abhi inbox check karo (~₹2)" },
    { command: "aaj", description: "Aaj ka hisaab" },
    { command: "kal", description: "Kal ki report" },
    { command: "campaigns", description: "DM campaigns: chalu / band" },
    { command: "jawab", description: "Taiyaar jawab" }
  ];

  // The main menu: buttons under one message, like the bot's home screen.
  async function menu(title = "🏠 Main menu") {
    const waiting = (await db.query("SELECT COUNT(*)::int AS count FROM dm_replies WHERE status='new'")).rows[0].count;
    const keyboard = [
      [{ text: `💬 Baaki replies${waiting ? ` (${waiting})` : ""}`, callback_data: "m:replies" }],
      [{ text: "🔎 Inbox check", callback_data: "m:check" }, { text: "📊 Aaj ka hisaab", callback_data: "m:aaj" }],
      [{ text: "📅 Kal ki report", callback_data: "m:kal" }],
      [{ text: "📣 Campaigns", callback_data: "m:camps" }, { text: "📝 Taiyaar jawab", callback_data: "m:tpl" }],
      ...(origin.startsWith("https://") ? [[{ text: "🌐 Website kholo", url: `${origin}/#replies` }]] : [])
    ];
    return send(title, { reply_markup: { inline_keyboard: keyboard } });
  }

  // One message per reply still waiting for an answer, each with its buttons.
  async function pendingReplies() {
    const rows = (await db.query(`${REPLY_ROWS} WHERE r.status='new' ORDER BY r.received_at LIMIT 10`)).rows;
    if (!rows.length) return send("✅ Abhi kisi reply ka jawab baaki nahi hai.");
    const saved = await templates();
    for (const row of rows) await postReply(row, saved);
    return null;
  }

  async function campaignList() {
    if (!dm) return send("DM Sender abhi set nahi hai.");
    const { campaigns } = await dm.status();
    if (!campaigns.length) return send("Abhi koi DM campaign nahi hai. Website par Messages → Naya campaign.");
    for (const item of campaigns.slice(0, 8)) {
      const state = item.status === "running" ? "🟢 Chal raha" : item.status === "completed" ? "🏁 Poora" : "⏸ Ruka hua";
      const why = item.status === "paused" && item.pause_reason && PAUSE_TEXT[item.pause_reason] ? `\n${PAUSE_TEXT[item.pause_reason]}` : "";
      const text = `📣 ${item.name}\n${state}${why}\n\nAaj ${item.counts.sent_today}/${item.today_limit ?? item.daily_limit} · Bheje ${item.counts.sent} · Baaki ${item.counts.pending}` +
        `\nKharcha ₹${Number(item.cost.inr || 0).toFixed(2)}`;
      const buttons = item.status === "running" ? [{ text: "⏸ Pause karo", callback_data: `c:pause:${item.id}` }]
        : item.counts.pending ? [{ text: "▶ Start karo", callback_data: `c:ask:${item.id}` }] : [];
      await send(text, buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : {});
    }
    return null;
  }

  async function templateList() {
    const saved = await templates();
    if (!saved.length) return send("Abhi koi taiyaar jawab nahi hai. Website par Messages → Replies → “Taiyaar jawab” mein jodo.");
    return send(`📝 Taiyaar jawab (har reply ke neeche button bankar aate hain):\n\n${saved.map((item) => `• ${item.title}: ${item.text}`).join("\n\n")}`);
  }

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
    const item = data.match(/^m:(replies|check|aaj|kal|camps|tpl)$/);
    if (item) {
      await ack("");
      return { replies: pendingReplies, check: checkNow, aaj: async () => send(await todayText()),
        kal: async () => send((await reportText())?.text || "Report nahi ban payi."), camps: campaignList, tpl: templateList }[item[1]]();
    }
    const reel = data.match(/^r:(ok|no):(\d{1,18})$/);
    if (reel && reviewReel) {
      let result;
      try { result = await reviewReel(reel[2], reel[1] === "ok"); } catch { return ack("Ye Reel ab nahi mili"); }
      await ack(result.done ? (reel[1] === "ok" ? "Approve ✓" : "Reject ✓") : "Pehle hi ho chuka");
      const note = result.done ? (reel[1] === "ok" ? "✅ Approve kar diya. Creator ko advance ke liye UPI bhejne ko bola gaya." : "❌ Reject kar diya. Creator ko nayi Reel bhejne ko bola gaya.")
        : `Ye Reel pehle hi ${result.status === "approved" ? "approve" : "reject"} ho chuki hai.`;
      const keep = (press.message.reply_markup?.inline_keyboard || []).map((row) => row.filter((button) => button.url)).filter((row) => row.length);
      return call("editMessageText", { chat_id: press.message.chat.id, message_id: press.message.message_id,
        text: `${press.message.text || ""}\n\n${note}`.slice(0, 4000), reply_markup: { inline_keyboard: keep } }).catch(() => {});
    }
    const camp = data.match(/^c:(pause|ask|go|no):(\d{1,18})$/);
    if (camp) return campaignPress(press, camp[1], camp[2], ack);
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

  // Pause at once; Start only after a second "Haan" (it sends DMs).
  async function campaignPress(press, action, id, ack) {
    const edit = (text, keyboard = []) => call("editMessageText", { chat_id: press.message.chat.id, message_id: press.message.message_id, text,
      reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
    const current = (await dm.status()).campaigns.find((item) => item.id === id);
    if (!current) return ack("Ye campaign ab nahi mila");
    if (action === "pause") {
      await dm.pauseCampaign(id);
      await ack("Pause ho gaya");
      return edit(`⏸ “${current.name}” pause ho gaya. Jo DM is waqt ja raha tha, woh poora ho sakta hai.`);
    }
    if (action === "ask") {
      await ack("");
      return edit(`▶ “${current.name}” ke baaki ${current.counts.pending} creators ko DM shuru karne hain?\nAaj maximum ${current.today_limit ?? current.daily_limit}, har ~${current.gap_minutes} minute mein ek.`,
        [[{ text: "Haan, start karo", callback_data: `c:go:${id}` }, { text: "Nahi", callback_data: `c:no:${id}` }]]);
    }
    if (action === "no") { await ack(""); return edit(`“${current.name}” ruka hua hai.`); }
    try { await dm.startCampaign(id, {}); }
    catch (error) {
      await ack("");
      const why = { profile_busy: "is account ka doosra campaign chal raha hai", nothing_to_send: "bhejne ko koi creator nahi bacha", dm_not_configured: "Browser Use key set nahi hai" }[error.code] || error.code || "error";
      return edit(`❌ “${current.name}” start nahi hua: ${why}.`);
    }
    kick();
    await ack("Start ho gaya");
    return edit(`🟢 “${current.name}” chalu ho gaya. Aaj ${current.today_limit ?? current.daily_limit} DM tak, sirf ${String(current.start_hour).padStart(2, "0")}:00–${String(current.end_hour).padStart(2, "0")}:00 ke beech.`);
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

  const REPLY_ROWS = `SELECT r.id::text AS id,r.username,r.name,r.text,i.account,c.profile_name FROM dm_replies r
       LEFT JOIN dm_inboxes i ON i.profile_id=r.profile_id
       LEFT JOIN LATERAL (SELECT profile_name FROM dm_campaigns WHERE profile_id=r.profile_id ORDER BY created_at DESC LIMIT 1) c ON TRUE`;

  // A reply as a bot message: who, through which account, what they wrote,
  // and the saved answers as buttons. Replies to it are answers to them.
  async function postReply(row, saved) {
    const who = row.username ? `@${row.username}` : row.name || "Creator";
    const via = row.account ? `@${row.account}` : row.profile_name || "account";
    const buttons = saved.slice(0, 6).map((item) => ({ text: item.title, callback_data: `t:${row.id}:${item.id}` }));
    const keyboard = [];
    for (let index = 0; index < buttons.length; index += 2) keyboard.push(buttons.slice(index, index + 2));
    keyboard.push([{ text: "✓ Ho gaya", callback_data: `d:${row.id}` },
      ...(row.username ? [{ text: "Profile ↗", url: `https://www.instagram.com/${row.username}/` }] : [])]);
    const sent = await send(`💬 ${who}  (${via} par)\n\n${row.text}\n\n↩️ Jawab ke liye is message par Reply karo.`, { reply_markup: { inline_keyboard: keyboard } });
    if (sent?.message_id) await db.query("INSERT INTO telegram_messages(message_id,reply_id) VALUES($1,$2) ON CONFLICT (message_id) DO NOTHING", [sent.message_id, row.id]);
    return sent;
  }

  // A new reply (or a new message in a known chat): one bot message, with the
  // saved answers as buttons. The row is claimed first, so two copies of the
  // service never announce it twice.
  async function announceReplies(linkedAt) {
    const since = new Date(Math.max(new Date(linkedAt).getTime() - ANNOUNCE_WINDOW_MS, now().getTime() - ANNOUNCE_WINDOW_MS));
    const rows = (await db.query(
      `${REPLY_ROWS} WHERE r.status='new' AND r.announced_at IS NULL AND r.received_at>=$1 ORDER BY r.received_at LIMIT 10`, [since])).rows;
    const saved = await templates();
    for (const row of rows) {
      if (stopping) return;
      const claimed = await db.query("UPDATE dm_replies SET announced_at=$2 WHERE id=$1 AND announced_at IS NULL RETURNING id", [row.id, now()]);
      if (!claimed.rows.length) continue;
      const sent = await postReply(row, saved);
      if (!sent?.message_id) await db.query("UPDATE dm_replies SET announced_at=NULL WHERE id=$1", [row.id]);
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

  // Yesterday (India time): DMs, replies, answers, cost, each account, the
  // message version that did best, Instagram warnings, stopped campaigns and
  // the finder. `active` is false when there is nothing worth a message.
  async function reportText() {
    if (!dm) return null;
    const until = istDayStart(now());
    const since = new Date(until.getTime() - DAY);
    const day = since.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    const stats = await dm.stats({ since, until });
    const totals = stats.totals;
    const rupee = (value) => `₹${Number(value || 0).toFixed(2)}`;
    const name = (item) => (item.account ? `@${item.account}` : item.name || `Profile ${item.profile_id.slice(0, 8)}`);
    const lines = [`📅 Kal ki report (${day})`, "",
      totals.sent || totals.not_delivered ? `DM gaye: ${totals.sent}${totals.not_delivered ? ` (+${totals.not_delivered} nahi pahunche)` : ""}` : "Kal koi DM nahi gaya.",
      `Reply aaye: ${totals.replies_received} · Tumhare jawab gaye: ${totals.answers_sent}`,
      `Kharcha: ${rupee(totals.cost_inr)}${totals.per_reply_inr !== null ? ` · ek reply ${rupee(totals.per_reply_inr)}` : ""}`];
    const used = stats.accounts.filter((item) => item.sent || item.not_delivered);
    if (used.length > 1 || (used.length === 1 && totals.sent >= 5)) {
      lines.push("", "Account-wise:");
      for (const item of used.slice(0, 6)) {
        lines.push(`• ${name(item)}: ${item.sent} DM, ${item.replied} reply${item.reply_rate !== null ? ` (${item.reply_rate}%)` : ""}, ${rupee(item.cost_inr)}`);
      }
    }
    // The best message version, once at least two versions went to 5+ people.
    const tried = stats.versions.filter((item) => item.text && item.sent >= 5);
    if (tried.length >= 2) {
      const best = [...tried].sort((a, b) => b.reply_rate - a.reply_rate || b.sent - a.sent)[0];
      const short = best.text.length > 50 ? `${best.text.slice(0, 50)}…` : best.text;
      lines.push("", `🏆 Sabse achha message: “${short}” — ${best.replied}/${best.sent} ne reply kiya (${best.reply_rate}%)`);
    }
    const warned = stats.accounts.filter((item) => item.warned_at && new Date(item.warned_at) >= since && new Date(item.warned_at) < until);
    for (const item of warned) lines.push("", `⚠️ ${name(item)} par kal Instagram ne warning / security check diya. Warm-up dobara 10 DM se shuru hua.`);
    const { campaigns } = await dm.status();
    const stopped = campaigns.filter((item) => item.status === "paused" && PROBLEM_PAUSES.has(item.pause_reason));
    for (const item of stopped.slice(0, 4)) lines.push("", `⏸ “${item.name}” ruka hua hai: ${PAUSE_TEXT[item.pause_reason] || item.pause_reason}`);
    const finder = (await db.query(
      `SELECT COUNT(*)::int AS read, COUNT(*) FILTER (WHERE match)::int AS fit FROM finder_candidates
       WHERE read_at>=$1 AND read_at<$2 AND source<>'cache'`, [since, until])).rows[0];
    if (finder.read) lines.push("", `🔎 Finder: kal ${finder.read} profiles dekhe, ${finder.fit} filter mein fit.`);
    const joined = (await db.query(
      `SELECT COUNT(*) FILTER (WHERE created_at>=$1 AND created_at<$2)::int AS fresh,
        COUNT(*) FILTER (WHERE status='working')::int AS working, COUNT(*) FILTER (WHERE status IN ('new','talking','logo_sent'))::int AS ongoing
       FROM creator_leads`, [since, until])).rows[0];
    if (joined.fresh || joined.ongoing || joined.working) {
      lines.push("", `📇 Joined: kal ${joined.fresh} naye · ${joined.ongoing} se baat chal rahi · ${joined.working} ne kaam shuru kiya`);
    }
    // The owner's target (Creators → Joined), once he has set one.
    const goal = (await db.query("SELECT target,deadline::text AS deadline FROM lead_settings WHERE id=1")).rows[0];
    if (goal) {
      const by = goal.deadline ? ` (${new Date(`${goal.deadline}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })} tak)` : "";
      lines.push(`🎯 Target: ${joined.working}/${goal.target} kaam shuru${by}`);
    }
    const running = campaigns.some((item) => item.status === "running");
    const active = Boolean(totals.sent || totals.not_delivered || totals.replies_received || totals.answers_sent || warned.length || stopped.length || finder.read || joined.fresh || running);
    return { text: lines.join("\n"), active };
  }

  async function morning(row) {
    const current = now();
    if (istHour(current) < REPORT_HOUR || row.report_sent_on === istDate(current)) return;
    const claimed = await db.query(
      "UPDATE telegram_settings SET report_sent_on=$1 WHERE id=1 AND (report_sent_on IS NULL OR report_sent_on<$1) RETURNING id", [istDate(current)]);
    if (!claimed.rows.length) return;
    const report = await reportText();
    if (report?.active) await send(report.text);
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

  // Alerts from the DM worker (lib/dm.js onEvent) and the creator finder (lib/finder.js).
  async function alert(event, details = {}) {
    if (!enabled) return;
    try {
      if (event === "paused" && !QUIET_PAUSES.has(details.reason)) {
        const what = PAUSE_TEXT[details.reason] || `Campaign ruk gaya (${details.reason}).`;
        await send(`⚠️ “${details.name || "Campaign"}”: ${what}${details.detail ? `\nInstagram ne likha: “${details.detail}”` : ""}`);
      } else if (event === "completed") {
        await send(`🏁 “${details.name || "Campaign"}” ki poori list ho gayi.`);
      } else if (event === "finder_paused" && !QUIET_PAUSES.has(details.reason)) {
        const what = FINDER_TEXT[details.reason] || `Search ruk gaya (${details.reason}).`;
        await send(`🔎 Creator search “${details.name || "Search"}”: ${what}${details.detail ? `\nInstagram ne likha: “${details.detail}”` : ""}`);
      } else if (event === "finder_completed") {
        await send(`🔎 Creator search “${details.name || "Search"}” poora hua: ${details.found || 0} creators filter mein fit. Website par Creators → Finder mein dekho.`);
      } else if (event === "lead") {
        const ways = [details.phone ? `WhatsApp: ${details.phone}` : null, details.telegram ? `Telegram: @${details.telegram}` : null].filter(Boolean);
        const buttons = [
          ...(details.phone ? [{ text: "WhatsApp ↗", url: `https://wa.me/91${details.phone}` }] : []),
          ...(details.telegram ? [{ text: "Telegram ↗", url: `https://t.me/${details.telegram}` }] : [])];
        await send(`📇 @${details.username} ne contact bheja — Joined list mein daal diya.\n${ways.join("\n")}\n\nWebsite: Creators → Joined`,
          buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : undefined);
      } else if (event === "first_reel") {
        const who = details.username ? `@${details.username}` : details.name || "Creator";
        const lines = [`🎬 Pehli Reel approval ke liye: ${who}`];
        if (details.username && details.name) lines.push(details.name);
        if (details.referrer) lines.push(`Laya: ${details.referrer}`);
        lines.push("", "Reel dekho, logo sahi hai to Approve dabao.");
        await send(lines.join("\n"), { reply_markup: { inline_keyboard: [[{ text: "▶ Reel kholo", url: details.url }],
          [{ text: "✅ Approve", callback_data: `r:ok:${details.reel_id}` }, { text: "❌ Reject", callback_data: `r:no:${details.reel_id}` }]] } });
      } else if (event === "checked" && details.requested) {
        // The owner asked for this check: always say how it went.
        const where = details.account ? ` (@${details.account})` : "";
        if (details.outcome === "ok") {
          const fresh = details.fresh || 0;
          const waiting = details.waiting || 0;
          await send(fresh ? `✅ Inbox check ho gaya${where}: ${fresh} naya reply. Abhi yahan bhej raha hoon.`
            : `✅ Inbox check ho gaya${where}: koi naya reply nahi.${waiting ? ` ${waiting} purane reply ka jawab baaki hai.` : ""}`);
        } else if (PAUSE_TEXT[details.outcome]) {
          await send(`⚠️ Inbox check ruk gaya${where}: ${PAUSE_TEXT[details.outcome]}`);
        } else {
          await send(`❌ Inbox check nahi ho paya${where}. Thodi der baad /check dobara karo.`);
        }
      }
    } catch (error) { log("telegram_alert_failed", { reason: error.code || "error" }); }
  }

  async function tick() {
    const row = await settings();
    if (!row?.chat_id) return;
    await announceReplies(row.linked_at);
    await announceAnswers(row.linked_at);
    await digest(row);
    await morning(row);
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
