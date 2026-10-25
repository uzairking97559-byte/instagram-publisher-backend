"use strict";

// Workwithme: the creators' Telegram bot (WORKWITHME_BOT_TOKEN, set in Render,
// never in a chat). A creator presses Start, sends the link of his Instagram
// page, gets the logo and the rules, and sends the link of his first Reel.
// The owner approves or rejects that Reel with one tap in his own bot
// (lib/telegram.js) or on the website. After approval the creator sends his
// UPI ID once and then the link of every Reel he posts (each link is taken
// once, by anyone). Anyone can become a manager: the bot gives a link, and
// pages that join through it carry the manager's name as "kaun laya".
//
// Every message reads as the bot's own; the owner's name never appears. The
// owner's Telegram account (the chat linked to his own bot) can send the bot
// a logo (photo or file, caption /logo) and a guide video (caption /video).

const crypto = require("node:crypto");
const { AppError } = require("./publishing");
const { validId } = require("./security");
const { parseUsernames } = require("./dm");

const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const REEL = /(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,40})/i;
const PROFILE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/[A-Za-z0-9._]{1,30}\/?(?:[?#]\S*)?/i;
const UPI = /^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/;
const TG_USER = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const MAX_RULES = 1500;

const TEXT = {
  welcome: "👋 Workwithme mein swagat hai!\n\nApni Instagram Reels par hamara logo lagao aur kamao:\n💰 ₹800 har 1M views par\n✅ Approval ke baad advance\n✅ Har hafte payment\n\nShuru karne ke liye neeche “✅ Kaam shuru karo” dabao.",
  askProfile: "Apne Instagram page ka **profile link** bhejo (username nahi).\n\nInstagram mein apne profile par jao → ⋯ ya Share profile → Copy link, phir yahan paste karo.\nJaise: https://www.instagram.com/your_page/",
  needProfileLink: "Ye profile link nahi laga. Instagram profile ka poora link bhejo, jaise https://www.instagram.com/your_page/",
  firstReelAsk: "Ab logo lagakar apni **pehli Reel** post karo, aur us Reel ka link yahan bhejo.\n\nReel par ⋯ ya Share → Copy link.",
  needReelLink: "Ye Reel ka link nahi laga. Reel ka link bhejo, jaise https://www.instagram.com/reel/ABC123/",
  linkUsed: "❌ Ye Reel link pehle hi use ho chuka hai. Har Reel ka link sirf ek baar chalta hai.",
  pending: "⏳ Aapki pehli Reel approval ke liye bhej di gayi hai. Approve hote hi yahan message aayega.",
  approved: "✅ Badhai ho! Aapki pehli Reel approve ho gayi.\n\nAb **advance** ke liye apni UPI ID bhejo (jaise name@okaxis).",
  rejected: "❌ Ye Reel approve nahi hui. Logo saaf dikhna chahiye. Logo sahi lagakar nayi Reel post karo aur uska link bhejo.",
  upiSaved: "✅ UPI ID save ho gayi.\n\nAb se jo bhi Reel post karo, uska link yahan bhejte raho. Jo Reel yahan nahi bheji, uska payment nahi hoga.",
  needUpi: "Ye UPI ID sahi nahi lagi. Aisi bhejo: name@okaxis",
  payment: "💰 Payment kaise milega\n\n• ₹800 har 1M views par\n• Approval ke baad advance\n• Kaam 7 din chalta hai. Pehle hafte ki payment 14 din baad, phir har hafte Tuesday–Thursday.\n• Views har Friday gine jaate hain, aur aapko yahin batayenge.\n• Sirf wahi Reels ginenge jinka link yahan bheja hai.",
  baseRules: "📋 Rules\n\n1. Har Reel par logo saaf dikhna chahiye.\n2. Har Reel ka link yahan bhejo. Jo Reel yahan nahi bheji, uska payment nahi.\n3. Ek Reel ka link sirf ek baar chalta hai.\n4. Din mein kitni bhi Reels bhej sakte ho.",
  noSupport: "Support jaldi shuru hoga. Tab tak apna sawal yahin likh do.",
  managerIntro: "🤝 Aap manager ban gaye!\n\nJo pages aap laoge, unke liye:\n• Har page par ₹200, us page ki pehli payment par\n• Aapke 20 se zyada pages chal gaye, to un pages ki kamai ka 10% bhi\n\nApna link pages ko bhejo. Jo is link se judega, wo aapka page ginega:"
};

function reelCode(text) {
  const match = String(text || "").match(REEL);
  return match ? match[1] : null;
}

function createCreatorBot({ db, env = {}, fetchImpl = fetch, log = () => {}, origin = "", now = () => new Date(), onEvent = () => {} }) {
  const token = typeof env.WORKWITHME_BOT_TOKEN === "string" ? env.WORKWITHME_BOT_TOKEN.trim() : "";
  const enabled = TOKEN.test(token);
  const secret = enabled ? crypto.createHmac("sha256", token).update("workwithme-webhook").digest("hex").slice(0, 48) : "";
  let botName = typeof env.WORKWITHME_BOT_USERNAME === "string" ? env.WORKWITHME_BOT_USERNAME.replace(/^@/, "").trim() : "";
  const emit = (event, details) => { Promise.resolve().then(() => onEvent(event, details)).catch(() => {}); };

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
  async function say(chat, text, extra = {}) {
    try {
      return await call("sendMessage", { chat_id: chat, text: String(text).replace(/\*\*/g, "").slice(0, 4000), disable_web_page_preview: true, ...extra });
    } catch (error) { log("workwithme_send_failed", { reason: error.code || "error" }); return null; }
  }

  async function settings() {
    return (await db.query(
      "SELECT support_username,rules,first_reel_note,logo_file_id,logo_kind,guide_file_id FROM creator_bot_settings WHERE id=1")).rows[0] || {};
  }
  async function ownerChat() {
    return (await db.query("SELECT chat_id::text AS chat_id FROM telegram_settings WHERE id=1")).rows[0]?.chat_id || null;
  }

  async function setup() {
    if (!enabled) return;
    try {
      const me = await call("getMe", {});
      if (me?.username) botName = me.username;
      await call("setMyCommands", { commands: [{ command: "start", description: "Shuru karo / menu" }, { command: "menu", description: "Menu" }] });
      if (origin.startsWith("https://")) {
        await call("setWebhook", { url: `${origin}/telegram/workwithme`, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
      }
      log("workwithme_ready", {});
    } catch (error) { log("workwithme_setup_failed", { reason: error.code || "error" }); }
  }

  // ---- Creator side ----

  async function user(from, chat) {
    const tgUsername = TG_USER.test(from?.username || "") ? from.username : null;
    const tgName = [from?.first_name, from?.last_name].filter(Boolean).join(" ").slice(0, 80) || null;
    return (await db.query(
      `INSERT INTO creator_bot_users(chat_id,tg_username,tg_name,created_at,updated_at) VALUES($1,$2,$3,$4,$4)
       ON CONFLICT (chat_id) DO UPDATE SET tg_username=COALESCE(EXCLUDED.tg_username,creator_bot_users.tg_username),
         tg_name=COALESCE(EXCLUDED.tg_name,creator_bot_users.tg_name)
       RETURNING chat_id::text AS chat_id,tg_username,tg_name,lead_id::text AS lead_id,state,ref_code,manager_code,manager_label,upi`,
      [chat, tgUsername, tgName, now()])).rows[0];
  }
  async function setState(chat, state, extra = {}) {
    const fields = ["state=$2", "updated_at=$3"];
    const values = [chat, state, now()];
    for (const [column, value] of Object.entries(extra)) { values.push(value); fields.push(`${column}=$${values.length}`); }
    await db.query(`UPDATE creator_bot_users SET ${fields.join(",")} WHERE chat_id=$1`, values);
  }

  async function menu(chat, me, title = TEXT.welcome) {
    const set = await settings();
    const working = me.state === "approved" || me.state === "await_upi";
    const rows = [
      working ? [{ text: "📊 Meri Reels", callback_data: "w:mine" }] : [{ text: "✅ Kaam shuru karo", callback_data: "w:join" }],
      [{ text: "💰 Payment kab?", callback_data: "w:pay" }, { text: "📋 Rules", callback_data: "w:rules" }],
      [{ text: "🤝 Manager bano", callback_data: "w:manager" },
        set.support_username ? { text: "🆘 Support", url: `https://t.me/${set.support_username}` } : { text: "🆘 Support", callback_data: "w:support" }]
    ];
    return say(chat, title, { reply_markup: { inline_keyboard: rows } });
  }

  async function start(chat, me, payload) {
    // A manager's link: t.me/<bot>?start=m_<code>. Kept until the page joins.
    const code = (payload || "").match(/^m_([a-z0-9]{6})$/)?.[1];
    if (code && !me.lead_id && code !== me.manager_code) {
      const manager = (await db.query("SELECT manager_code FROM creator_bot_users WHERE manager_code=$1", [code])).rows[0];
      if (manager) await db.query("UPDATE creator_bot_users SET ref_code=$2 WHERE chat_id=$1", [chat, code]);
    }
    const set = await settings();
    if (set.guide_file_id) {
      await call("sendVideo", { chat_id: chat, video: set.guide_file_id, caption: "▶ 1 minute mein samjho: kaise shuru karein aur Reel kaise bhejein." })
        .catch((error) => log("workwithme_send_failed", { reason: error.code || "error" }));
    }
    return menu(chat, me);
  }

  async function join(chat, me) {
    if (me.state === "approved" || me.state === "await_upi") return mine(chat, me);
    if (me.state === "pending") return say(chat, TEXT.pending);
    if (me.state === "await_first_reel") return say(chat, TEXT.firstReelAsk);
    await setState(chat, "await_profile");
    return say(chat, TEXT.askProfile);
  }

  // The creator's Instagram page: matched with Creators → Joined (or added there).
  async function profile(chat, me, text) {
    const link = text.match(PROFILE);
    const { usernames } = link ? parseUsernames(link[0]) : { usernames: [] };
    if (usernames.length !== 1 || reelCode(text)) return say(chat, TEXT.needProfileLink);
    const username = usernames[0];
    const taken = (await db.query(
      `SELECT u.chat_id::text AS chat_id FROM creator_bot_users u JOIN creator_leads l ON l.id=u.lead_id
       WHERE l.username=$1 AND u.chat_id<>$2 LIMIT 1`, [username, chat])).rows[0];
    if (taken) return say(chat, "Ye page pehle se kisi aur Telegram account se juda hai. Galti lag rahi ho to Support se baat karo.");
    let referrer = null;
    if (me.ref_code) referrer = (await db.query("SELECT manager_label FROM creator_bot_users WHERE manager_code=$1", [me.ref_code])).rows[0]?.manager_label || null;
    const current = now();
    const lead = (await db.query(
      `INSERT INTO creator_leads(username,name,telegram,referrer,status,source,created_at,updated_at)
       VALUES($1,$2,$3,$4,'logo_sent','bot',$5,$5)
       ON CONFLICT (username) DO UPDATE SET telegram=COALESCE(creator_leads.telegram,EXCLUDED.telegram),
         name=COALESCE(creator_leads.name,EXCLUDED.name),referrer=COALESCE(creator_leads.referrer,EXCLUDED.referrer),
         status=CASE WHEN creator_leads.status IN ('new','talking') THEN 'logo_sent' ELSE creator_leads.status END,updated_at=EXCLUDED.updated_at
       RETURNING id::text AS id`, [username, me.tg_name, me.tg_username, referrer, current])).rows[0];
    await setState(chat, "await_first_reel", { lead_id: lead.id });
    log("workwithme_joined", { referred: Boolean(referrer) });
    emit("creator_joined", { username, referrer });
    const set = await settings();
    await say(chat, `✅ Page jud gaya: @${username}`);
    if (set.logo_file_id) {
      const method = set.logo_kind === "photo" ? "sendPhoto" : "sendDocument";
      await call(method, { chat_id: chat, [set.logo_kind === "photo" ? "photo" : "document"]: set.logo_file_id, caption: "Ye hai logo. Ise apni Reels par lagana hai." })
        .catch((error) => log("workwithme_send_failed", { reason: error.code || "error" }));
    }
    const rules = [TEXT.baseRules, set.rules].filter(Boolean).join("\n\n");
    await say(chat, rules);
    // The bio link or hashtag goes out once, with the first Reel's step.
    return say(chat, [set.first_reel_note, TEXT.firstReelAsk].filter(Boolean).join("\n\n"));
  }

  async function saveReel(chat, me, text, first) {
    const code = reelCode(text);
    if (!code) return { ok: false, reply: TEXT.needReelLink };
    const row = (await db.query(
      `INSERT INTO creator_reels(chat_id,lead_id,shortcode,url,first,status,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (shortcode) DO NOTHING RETURNING id::text AS id`,
      [chat, me.lead_id, code, `https://www.instagram.com/reel/${code}/`, first, first ? "pending" : "submitted", now()])).rows[0];
    if (!row) return { ok: false, reply: TEXT.linkUsed };
    return { ok: true, id: row.id, code };
  }

  async function firstReel(chat, me, text) {
    const saved = await saveReel(chat, me, text, true);
    if (!saved.ok) return say(chat, saved.reply);
    await setState(chat, "pending");
    const lead = (await db.query("SELECT username,name,referrer FROM creator_leads WHERE id=$1", [me.lead_id])).rows[0] || {};
    log("workwithme_first_reel", {});
    emit("first_reel", { reel_id: saved.id, url: `https://www.instagram.com/reel/${saved.code}/`, username: lead.username || null,
      name: lead.name || me.tg_name, referrer: lead.referrer || null });
    return say(chat, TEXT.pending);
  }

  async function reel(chat, me, text) {
    const saved = await saveReel(chat, me, text, false);
    if (!saved.ok) return say(chat, saved.reply);
    const counts = await reelCounts(chat);
    await db.query("UPDATE creator_bot_users SET updated_at=$2 WHERE chat_id=$1", [chat, now()]);
    return say(chat, `✅ Reel jud gayi. Aaj ${counts.today} · is hafte ${counts.week} · kul ${counts.total}`);
  }

  async function reelCounts(chat) {
    const current = now();
    const IST = 330 * 60000;
    const shifted = new Date(current.getTime() + IST);
    const today = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST);
    const week = new Date(today.getTime() - ((shifted.getUTCDay() + 6) % 7) * 86400000);
    return (await db.query(
      `SELECT COUNT(*) FILTER (WHERE submitted_at>=$2)::int AS today, COUNT(*) FILTER (WHERE submitted_at>=$3)::int AS week, COUNT(*)::int AS total
       FROM creator_reels WHERE chat_id=$1 AND status IN ('approved','submitted')`, [chat, today, week])).rows[0];
  }

  async function mine(chat, me) {
    const counts = await reelCounts(chat);
    return say(chat, `📊 Aapki Reels\n\nAaj: ${counts.today}\nIs hafte (Mon se): ${counts.week}\nKul: ${counts.total}${me.upi ? `\n\nUPI: ${me.upi}` : ""}\n\nNayi Reel post karo to uska link yahan bhejo.`);
  }

  async function manager(chat, me) {
    let code = me.manager_code;
    if (!code) {
      const label = me.tg_username ? `@${me.tg_username}` : me.tg_name || "Manager";
      for (let tries = 0; tries < 5 && !code; tries++) {
        const candidate = crypto.randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(6, "x").slice(0, 6);
        const done = await db.query(
          "UPDATE creator_bot_users SET manager_code=$2,manager_label=$3 WHERE chat_id=$1 AND manager_code IS NULL AND NOT EXISTS (SELECT 1 FROM creator_bot_users WHERE manager_code=$2) RETURNING manager_code",
          [chat, candidate, `${label} (M-${candidate})`]);
        if (done.rows.length) code = candidate;
      }
      if (!code) return say(chat, "Abhi code nahi ban paya. Thodi der baad dobara dabao.");
      log("workwithme_manager", {});
    }
    if (!botName) await setup();
    const link = botName ? `https://t.me/${botName}?start=m_${code}` : `Code: M-${code}`;
    const label = (await db.query("SELECT manager_label FROM creator_bot_users WHERE chat_id=$1", [chat])).rows[0]?.manager_label;
    const pages = label ? (await db.query(
      `SELECT COUNT(*)::int AS pages, COUNT(*) FILTER (WHERE status='working')::int AS working FROM creator_leads WHERE lower(referrer)=lower($1)`,
      [label])).rows[0] : { pages: 0, working: 0 };
    return say(chat, `${TEXT.managerIntro}\n\n${link}\n\nAapke pages: ${pages.pages} · kaam shuru: ${pages.working}`);
  }

  // The owner's own account sends the logo or the guide video (caption /logo, /video).
  async function ownerFile(message) {
    const caption = String(message.caption || "").trim().toLowerCase();
    const chat = String(message.chat.id);
    if (/^\/logo\b/.test(caption)) {
      const photo = Array.isArray(message.photo) && message.photo.length ? message.photo.at(-1).file_id : null;
      const file = photo || message.document?.file_id;
      if (!file) return say(chat, "Logo ki photo ya file bhejo, caption mein /logo likh kar.");
      await db.query(
        `INSERT INTO creator_bot_settings(id,logo_file_id,logo_kind) VALUES(1,$1,$2)
         ON CONFLICT (id) DO UPDATE SET logo_file_id=EXCLUDED.logo_file_id,logo_kind=EXCLUDED.logo_kind`, [file, photo ? "photo" : "document"]);
      log("workwithme_logo_set", {});
      return say(chat, "✅ Logo save ho gaya. Naye creators ko page judte hi ye milega.");
    }
    if (/^\/video\b/.test(caption)) {
      const file = message.video?.file_id || (message.document?.mime_type?.startsWith("video/") ? message.document.file_id : null);
      if (!file) return say(chat, "Guide video bhejo, caption mein /video likh kar.");
      await db.query(
        `INSERT INTO creator_bot_settings(id,guide_file_id) VALUES(1,$1)
         ON CONFLICT (id) DO UPDATE SET guide_file_id=EXCLUDED.guide_file_id`, [file]);
      log("workwithme_video_set", {});
      return say(chat, "✅ Guide video save ho gayi. Start dabane par sabko milegi.");
    }
    return null;
  }

  async function handleUpdate(update, headerSecret) {
    if (!enabled || headerSecret !== secret) throw new AppError(403, "forbidden");
    const message = update?.message;
    const press = update?.callback_query;
    const chatInfo = message?.chat || press?.message?.chat;
    if (!chatInfo || chatInfo.type !== "private") return;
    const chat = String(chatInfo.id);
    if (!/^\d{1,15}$/.test(chat)) return;
    const me = await user(message?.from || press?.from, chat);
    if (press) {
      const data = String(press.data || "");
      await call("answerCallbackQuery", { callback_query_id: press.id }).catch(() => {});
      if (data === "w:join") return join(chat, me);
      if (data === "w:pay") return say(chat, TEXT.payment);
      if (data === "w:rules") { const set = await settings(); return say(chat, [TEXT.baseRules, set.rules].filter(Boolean).join("\n\n")); }
      if (data === "w:manager") return manager(chat, me);
      if (data === "w:mine") return mine(chat, me);
      if (data === "w:support") return say(chat, TEXT.noSupport);
      return null;
    }
    if (!message) return null;
    const owner = await ownerChat();
    if (owner && owner === String(message.from?.id ?? "") && (message.photo || message.document || message.video)) {
      const handled = await ownerFile(message);
      if (handled !== null) return handled;
    }
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const startCommand = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/);
    if (startCommand) return start(chat, me, startCommand[1]);
    if (/^\/menu\b/.test(text)) return menu(chat, me, "Menu:");
    if (!text) return say(chat, "Abhi sirf likha hua message ya link chalta hai.");
    if (me.state === "await_profile") return profile(chat, me, text);
    if (me.state === "await_first_reel") return firstReel(chat, me, text);
    if (me.state === "pending") return say(chat, TEXT.pending);
    if (me.state === "await_upi") {
      if (reelCode(text)) return reel(chat, me, text);
      const upi = text.replace(/\s+/g, "");
      if (!UPI.test(upi)) return say(chat, TEXT.needUpi);
      await setState(chat, "approved", { upi });
      emit("creator_upi", {});
      return say(chat, TEXT.upiSaved);
    }
    if (me.state === "approved") {
      if (reelCode(text)) return reel(chat, me, text);
      const upi = text.replace(/\s+/g, "");
      if (UPI.test(upi)) { await setState(chat, "approved", { upi }); return say(chat, "✅ UPI ID badal di gayi."); }
      return menu(chat, me, "Nayi Reel ka link bhejo, ya neeche se chuno:");
    }
    if (reelCode(text)) return say(chat, "Pehle apna page jodo: “✅ Kaam shuru karo” dabao.");
    return menu(chat, me, "Neeche se chuno:");
  }

  // ---- Owner side: the first Reel's approval ----

  async function review(rawId, approve) {
    const id = String(rawId ?? "");
    if (!validId(id) || id.length > 18) throw new AppError(404, "reel_not_found");
    const reelRow = (await db.query(
      `UPDATE creator_reels SET status=$2,reviewed_at=$3 WHERE id=$1 AND first AND status='pending'
       RETURNING chat_id::text AS chat_id,lead_id::text AS lead_id,url`, [id, approve ? "approved" : "rejected", now()])).rows[0];
    if (!reelRow) {
      const old = (await db.query("SELECT status FROM creator_reels WHERE id=$1", [id])).rows[0];
      if (!old) throw new AppError(404, "reel_not_found");
      return { done: false, status: old.status };
    }
    const lead = reelRow.lead_id ? (await db.query("SELECT username FROM creator_leads WHERE id=$1", [reelRow.lead_id])).rows[0] : null;
    if (approve) {
      await setState(reelRow.chat_id, "await_upi", { approved_at: now() });
      if (reelRow.lead_id) await db.query("UPDATE creator_leads SET status='working',updated_at=$2 WHERE id=$1", [reelRow.lead_id, now()]);
      await say(reelRow.chat_id, TEXT.approved);
    } else {
      await setState(reelRow.chat_id, "await_first_reel");
      await say(reelRow.chat_id, TEXT.rejected);
    }
    log("workwithme_reviewed", { approved: Boolean(approve) });
    return { done: true, status: approve ? "approved" : "rejected", username: lead?.username || null };
  }

  // ---- Website ----

  async function status() {
    const set = await settings();
    const counts = (await db.query(
      `SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE lead_id IS NOT NULL)::int AS pages,
        COUNT(*) FILTER (WHERE state IN ('approved','await_upi'))::int AS approved, COUNT(*) FILTER (WHERE manager_code IS NOT NULL)::int AS managers
       FROM creator_bot_users`)).rows[0];
    const reels = (await db.query(
      "SELECT COUNT(*) FILTER (WHERE status IN ('approved','submitted'))::int AS total FROM creator_reels")).rows[0];
    const pending = (await db.query(
      `SELECT r.id::text AS id,r.url,r.submitted_at,l.username,l.name,l.referrer FROM creator_reels r LEFT JOIN creator_leads l ON l.id=r.lead_id
       WHERE r.first AND r.status='pending' ORDER BY r.submitted_at LIMIT 30`)).rows;
    return {
      configured: enabled, bot: botName || null,
      settings: { support_username: set.support_username || "", rules: set.rules || "", first_reel_note: set.first_reel_note || "",
        logo: Boolean(set.logo_file_id), guide: Boolean(set.guide_file_id) },
      counts: { ...counts, reels: reels.total }, pending
    };
  }

  async function saveSettings(body) {
    const support = String(body.support_username ?? "").trim().replace(/^(https?:\/\/)?(t\.me\/)?@?/i, "");
    if (support && !TG_USER.test(support)) throw new AppError(400, "invalid_support");
    const text = (value) => (typeof value === "string" ? value.trim().slice(0, MAX_RULES) : "") || null;
    await db.query(
      `INSERT INTO creator_bot_settings(id,support_username,rules,first_reel_note) VALUES(1,$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET support_username=EXCLUDED.support_username,rules=EXCLUDED.rules,first_reel_note=EXCLUDED.first_reel_note`,
      [support || null, text(body.rules), text(body.first_reel_note)]);
    return status();
  }

  return { enabled: () => enabled, setup, handleUpdate, review, status, saveSettings };
}

module.exports = { createCreatorBot, reelCode };
