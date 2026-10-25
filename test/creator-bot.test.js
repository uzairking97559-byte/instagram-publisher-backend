"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");
const { reelCode } = require("../lib/creator-bot");

const OWNER_TOKEN = "1234567890:AAH-test_only_token_for_the_bot_0123456";
const BOT_TOKEN = "9876543210:BBH-test_only_token_for_workwithme_0123";
const OWNER_SECRET = crypto.createHmac("sha256", OWNER_TOKEN).update("telegram-webhook").digest("hex").slice(0, 48);
const BOT_SECRET = crypto.createHmac("sha256", BOT_TOKEN).update("workwithme-webhook").digest("hex").slice(0, 48);
const OWNER = 555001;
const NOON_IST = "2026-10-18T06:30:00.000Z";

test("reel links: reel, reels, post and tv links give the code; profiles do not", () => {
  assert.equal(reelCode("https://www.instagram.com/reel/AbC123xyz/?igsh=q"), "AbC123xyz");
  assert.equal(reelCode("instagram.com/reels/AbC123xyz"), "AbC123xyz");
  assert.equal(reelCode("https://instagram.com/meme.page/reel/XyZ987abc/"), "XyZ987abc");
  assert.equal(reelCode("https://www.instagram.com/p/Qw3rty_-12/"), "Qw3rty_-12");
  assert.equal(reelCode("https://www.instagram.com/meme.page/"), null);
  assert.equal(reelCode("bhai reel daal di"), null);
});

function fakes() {
  const sent = { owner: [], bot: [] };
  let nextId = 100;
  const run = async (url, init = {}) => {
    assert.equal(url.hostname, "api.telegram.org", "only Telegram is called");
    const [, botPart, method] = url.pathname.split("/");
    const who = botPart === `bot${OWNER_TOKEN}` ? "owner" : botPart === `bot${BOT_TOKEN}` ? "bot" : null;
    assert.ok(who, "a known token");
    const body = JSON.parse(init.body || "{}");
    if (method === "getMe") return json({ ok: true, result: { username: who === "owner" ? "creatordeskk_bot" : "workwithme_test_bot" } });
    if (/^send/.test(method)) { const message = { message_id: nextId++, method, ...body }; sent[who].push(message); return json({ ok: true, result: message }); }
    sent[who].push({ method, ...body });
    return json({ ok: true, result: true });
  };
  return { run, sent };
}

test("workwithme: join with a manager's link, page, logo and rules, first Reel approved by the owner, UPI, Reels", async (t) => {
  const fake = fakes();
  const clock = { now: new Date(NOON_IST) };
  const h = await harness(t, {
    env: { TELEGRAM_BOT_TOKEN: OWNER_TOKEN, WORKWITHME_BOT_TOKEN: BOT_TOKEN }, meta: fake.run,
    dmOptions: { now: () => clock.now, intervalMs: 0 },
    telegramOptions: { intervalMs: 0, setup: false, now: () => clock.now, kick: () => {} }
  });
  const cookie = await h.login();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const ownerHook = (update) => h.request("/telegram/webhook", { method: "POST", body: { update_id: 1, ...update }, originHeader: null,
    headers: { "X-Telegram-Bot-Api-Secret-Token": OWNER_SECRET } });
  const botHook = (update, secret = BOT_SECRET) => h.request("/telegram/workwithme", { method: "POST", body: { update_id: 1, ...update }, originHeader: null,
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret } });
  const person = (id, username, name) => ({ id, username, first_name: name });
  const say = (who, text, extra = {}) => botHook({ message: { message_id: 1, from: who, chat: { id: who.id, type: "private" }, text, ...extra } });
  const press = (who, data) => botHook({ callback_query: { id: `cb-${data}`, from: who, data, message: { message_id: 1, chat: { id: who.id, type: "private" } } } });
  const lastTo = (chat) => fake.sent.bot.filter((m) => String(m.chat_id) === String(chat)).at(-1);
  const textsTo = (chat) => fake.sent.bot.filter((m) => String(m.chat_id) === String(chat)).map((m) => m.text || m.caption || "");

  // The owner's own bot is linked (that is also how the bot knows the owner).
  const link = (await h.request("/api/telegram/link", { method: "POST", cookie, body: {} })).data.url;
  await ownerHook({ message: { message_id: 1, chat: { id: OWNER, type: "private" }, text: `/start ${link.split("start=")[1]}` } });
  assert.equal((await botHook({ message: { chat: { id: 1, type: "private" }, text: "hi" } }, "wrong")).status, 403);

  // Website settings: support account, rules, the note that goes once with the first Reel.
  assert.equal((await h.request("/api/creator-bot", { method: "PUT", cookie, body: { support_username: "no" } })).data.error, "invalid_support");
  let status = (await h.request("/api/creator-bot", { method: "PUT", cookie, body: {
    support_username: "https://t.me/owner_support", rules: "Logo upar right corner mein.", first_reel_note: "Caption mein #brand likhna." } })).data;
  assert.deepEqual([status.configured, status.settings.support_username, status.settings.logo], [true, "owner_support", false]);

  // The owner sends the logo from his own Telegram (caption /logo).
  const owner = person(OWNER, "owner_support", "Owner");
  await say(owner, undefined, { caption: "/logo", photo: [{ file_id: "logo-small" }, { file_id: "logo-big" }] });
  assert.match(lastTo(OWNER).text, /Logo save ho gaya/);
  assert.equal((await h.request("/api/creator-bot", { cookie })).data.settings.logo, true);

  // A manager gets a link; a creator joins through it.
  const manager = person(700, "ali_agency", "Ali");
  await say(manager, "/start");
  assert.match(lastTo(700).text, /Workwithme mein swagat/);
  assert.deepEqual(lastTo(700).reply_markup.inline_keyboard.flat().map((b) => b.callback_data || b.url),
    ["w:join", "w:pay", "w:rules", "w:manager", "https://t.me/owner_support"]);
  await press(manager, "w:manager");
  const code = lastTo(700).text.match(/start=m_([a-z0-9]{6})/)[1];
  assert.match(lastTo(700).text, /https:\/\/t\.me\/workwithme_test_bot\?start=m_/);

  const creator = person(800, "rahul_memes", "Rahul");
  await say(creator, `/start m_${code}`);
  await press(creator, "w:join");
  assert.match(lastTo(800).text, /profile link/);
  await say(creator, "meme.page");
  assert.match(lastTo(800).text, /profile link nahi laga/);
  await say(creator, "https://www.instagram.com/Meme.Page/?igsh=abc");
  const joined = textsTo(800).slice(-4);
  assert.deepEqual([joined[0], joined[1]], ["✅ Page jud gaya: @meme.page", "Ye hai logo. Ise apni Reels par lagana hai."]);
  assert.equal(fake.sent.bot.find((m) => m.method === "sendPhoto").photo, "logo-big");
  assert.match(joined[2], /Rules[\s\S]*Logo upar right corner mein\./);
  assert.match(joined[3], /^Caption mein #brand likhna\.\n\nAb logo lagakar apni pehli Reel/);
  let leads = (await h.request("/api/leads", { cookie })).data;
  const lead = leads.leads.find((item) => item.username === "meme.page");
  assert.deepEqual([lead.status, lead.source, lead.telegram, lead.referrer], ["logo_sent", "bot", "rahul_memes", `@ali_agency (M-${code})`]);

  // The first Reel goes to the owner's bot with Approve / Reject.
  await say(creator, "https://www.instagram.com/reel/AbC123xyz/?igsh=q");
  assert.match(lastTo(800).text, /approval ke liye bhej di/);
  await settle();
  const ask = fake.sent.owner.filter((m) => /Pehli Reel approval/.test(m.text || "")).at(-1);
  assert.match(ask.text, /^🎬 Pehli Reel approval ke liye: @meme\.page\nRahul\nLaya: @ali_agency/);
  const [open, [approve]] = ask.reply_markup.inline_keyboard;
  assert.equal(open[0].url, "https://www.instagram.com/reel/AbC123xyz/");
  await say(creator, "bhai approve karo");
  assert.match(lastTo(800).text, /approval ke liye bhej di/, "waiting: nothing else is taken");
  await ownerHook({ callback_query: { id: "cb9", data: approve.callback_data,
    message: { message_id: ask.message_id, chat: { id: OWNER, type: "private" }, text: ask.text, reply_markup: ask.reply_markup } } });
  const edited = fake.sent.owner.filter((m) => m.method === "editMessageText").at(-1);
  assert.match(edited.text, /✅ Approve kar diya/);
  assert.deepEqual(edited.reply_markup.inline_keyboard, [[{ text: "▶ Reel kholo", url: "https://www.instagram.com/reel/AbC123xyz/" }]], "only the link stays");
  assert.match(lastTo(800).text, /approve ho gayi[\s\S]*UPI ID bhejo/);
  leads = (await h.request("/api/leads", { cookie })).data;
  assert.equal(leads.leads.find((item) => item.username === "meme.page").status, "working");

  // UPI, then every Reel; a link is taken once.
  await say(creator, "rahul upi");
  assert.match(lastTo(800).text, /UPI ID sahi nahi/);
  await say(creator, "rahul@okaxis");
  assert.match(lastTo(800).text, /UPI ID save ho gayi/);
  await say(creator, "https://www.instagram.com/p/XyZ987abc/");
  assert.equal(lastTo(800).text, "✅ Reel jud gayi. Aaj 2 · is hafte 2 · kul 2");
  await say(creator, "https://www.instagram.com/reel/AbC123xyz/");
  assert.match(lastTo(800).text, /pehle hi use ho chuka/);
  await press(creator, "w:mine");
  assert.match(lastTo(800).text, /Aaj: 2\nIs hafte \(Mon se\): 2\nKul: 2\n\nUPI: rahul@okaxis/);

  // The manager sees his page.
  await press(manager, "w:manager");
  assert.match(lastTo(700).text, /Aapke pages: 1 · kaam shuru: 1/);

  // A second creator: rejected on the website, sends another Reel.
  const second = person(900, null, "Sana");
  await press(second, "w:join");
  await say(second, "https://instagram.com/sana.edits");
  await say(second, "https://www.instagram.com/reel/Sana111aaa/");
  status = (await h.request("/api/creator-bot", { cookie })).data;
  assert.deepEqual(status.pending.map((item) => [item.username, item.url]), [["sana.edits", "https://www.instagram.com/reel/Sana111aaa/"]]);
  assert.equal((await h.request("/api/creator-bot/reels/999999/review", { method: "POST", cookie, body: { approve: true } })).data.error, "reel_not_found");
  status = (await h.request(`/api/creator-bot/reels/${status.pending[0].id}/review`, { method: "POST", cookie, body: { approve: false } })).data;
  assert.deepEqual(status.pending, []);
  assert.match(lastTo(900).text, /approve nahi hui/);
  await say(second, "https://www.instagram.com/reel/Sana222bbb/");
  assert.match(lastTo(900).text, /approval ke liye bhej di/);
  // Another account cannot claim a page that is already joined.
  await press(person(901, null, "X"), "w:join");
  await say(person(901, null, "X"), "https://www.instagram.com/meme.page/");
  assert.match(lastTo(901).text, /pehle se kisi aur Telegram account se juda/);

  status = (await h.request("/api/creator-bot", { cookie })).data;
  assert.deepEqual(status.counts, { users: 5, pages: 2, approved: 1, managers: 1, reels: 2 });
  assert.equal((await h.request("/api/creator-bot")).status, 401, "owner only");
});

test("workwithme: without a token the website says so and the webhook refuses", async (t) => {
  const h = await harness(t, { env: {} });
  const cookie = await h.login();
  const status = (await h.request("/api/creator-bot", { cookie })).data;
  assert.deepEqual([status.configured, status.bot, status.pending], [false, null, []]);
  assert.equal((await h.request("/telegram/workwithme", { method: "POST", body: {}, originHeader: null })).status, 403);
});
