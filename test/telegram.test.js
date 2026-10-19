"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");

const TOKEN = "1234567890:AAH-test_only_token_for_the_bot_0123456";
const SECRET = crypto.createHmac("sha256", TOKEN).update("telegram-webhook").digest("hex").slice(0, 48);
const PROFILE = "35a603c8-5ea3-415e-a626-eb4d530cdcb4";
const OWNER = 555001;
const NOON_IST = "2026-10-18T06:30:00.000Z";

// Telegram's Bot API and Browser Use, as far as these tests need them.
function fakes() {
  const sent = [];
  const calls = [];
  let nextId = 900;
  const run = async (url, init = {}) => {
    if (url.hostname === "api.telegram.org") {
      const method = url.pathname.split("/").pop();
      const body = JSON.parse(init.body || "{}");
      assert.ok(url.pathname.startsWith(`/bot${TOKEN}/`), "the token only goes to Telegram");
      calls.push({ method, body });
      if (method === "getMe") return json({ ok: true, result: { username: "creatordeskk_bot" } });
      if (method === "sendMessage") { const message = { message_id: nextId++, ...body }; sent.push(message); return json({ ok: true, result: message }); }
      return json({ ok: true, result: true });
    }
    if (url.hostname === "api.browser-use.com" && url.pathname === "/api/v4/browsers" && init.method === "POST") {
      return json({ id: crypto.randomUUID(), status: "active", cdpUrl: "wss://cdp.test/x", proxyUsedMb: "0", proxyCost: "0", browserCost: "0" }, 201);
    }
    if (url.hostname === "api.browser-use.com") return json({ id: crypto.randomUUID(), status: "stopped", proxyUsedMb: "1", proxyCost: "0.01", browserCost: "0.002" });
    throw new Error(`Unexpected call ${url.href}`);
  };
  return { run, sent, calls };
}

function driver() {
  return {
    async open() {
      let alive = true;
      return {
        alive: () => alive,
        sendDm: async () => ({ status: "sent" }),
        readReplies: async () => ({ status: "ok", account: "aiglow.artlab", rows: 0, waiting: 0, skipped: 0, replies: [] }),
        sendReply: async () => ({ status: "sent" }),
        idle: async () => {},
        close: () => { alive = false; }
      };
    }
  };
}

async function setup(t) {
  const fake = fakes();
  const clock = { now: new Date(NOON_IST) };
  const h = await harness(t, {
    env: { BROWSER_USE_API_KEY: "test-browser-use-key", TELEGRAM_BOT_TOKEN: TOKEN }, meta: fake.run,
    dmOptions: { driver: driver(), now: () => clock.now, random: () => 0.5, intervalMs: 0 },
    // kick: the DM worker is run by the test itself, so answers stay queued until it does.
    telegramOptions: { intervalMs: 0, setup: false, now: () => clock.now, kick: () => {} }
  });
  const cookie = await h.login();
  const hook = (update, secret = SECRET) => h.request("/telegram/webhook", { method: "POST", body: { update_id: 1, ...update },
    originHeader: null, headers: { "X-Telegram-Bot-Api-Secret-Token": secret } });
  const say = (text, extra = {}) => hook({ message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: OWNER, type: "private" }, text, ...extra } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { h, fake, clock, cookie, hook, say, settle, tick: () => h.app.locals.runTelegram(), worker: () => h.app.locals.runDmWorker() };
}

test("telegram: linked once from the website, then replies come in and answers go out", async (t) => {
  const { h, fake, clock, cookie, hook, say, settle, tick, worker } = await setup(t);
  let status = (await h.request("/api/telegram", { cookie })).data;
  assert.deepEqual([status.configured, status.linked], [true, false]);

  // The website hands out a one-time link to the bot.
  const link = (await h.request("/api/telegram/link", { method: "POST", cookie, body: {} })).data.url;
  const code = link.match(/^https:\/\/t\.me\/creatordeskk_bot\?start=([A-Za-z0-9_-]+)$/)[1];

  // Updates without Telegram's secret are refused; others' chats are ignored.
  assert.equal((await hook({ message: { chat: { id: OWNER, type: "private" }, text: `/start ${code}` } }, "wrong")).status, 403);
  await hook({ message: { message_id: 1, chat: { id: 777, type: "group" }, text: `/start ${code}` } });
  assert.equal((await h.request("/api/telegram", { cookie })).data.linked, false, "only a private chat can link");
  await say(`/start ${code}`);
  status = (await h.request("/api/telegram", { cookie })).data;
  assert.equal(status.linked, true);
  assert.match(fake.sent.at(-1).text, /Telegram jud gaya/);
  // The code works once.
  await hook({ message: { message_id: 2, chat: { id: 777, type: "private" }, text: `/start ${code}` } });
  assert.match(fake.sent.at(-1).text, /purana ho gaya ya galat/);
  assert.equal(String(fake.sent.at(-1).chat_id), "777");
  const before = fake.sent.length;
  await hook({ message: { message_id: 3, chat: { id: 777, type: "private" }, text: "/check" } });
  assert.equal(fake.sent.length, before, "another chat gets nothing");

  // A saved answer, a campaign and a reply from a creator.
  assert.equal((await h.request("/api/dm/templates", { method: "POST", cookie, body: { title: "Details", text: "Hi {username}, details: ₹800 per 1M views." } })).status, 201);
  assert.equal((await h.request("/api/dm/templates", { method: "POST", cookie, body: { title: "x".repeat(25), text: "y" } })).data.error, "invalid_template");
  const template = (await h.request("/api/dm/templates", { cookie })).data.templates[0];
  const campaign = (await h.request("/api/dm/campaigns", { method: "POST", cookie, body: {
    name: "Commenters", profile_id: PROFILE, profile_name: "Personal Profile", message: "Hi {username}", usernames: "one\ntwo",
    daily_limit: 100, gap_minutes: 9, start_hour: 8, end_hour: 23, requested_contact: true } })).data.campaign;
  const reply = (await h.db.query(
    "INSERT INTO dm_replies(profile_id,thread,username,name,row_key,text,received_at) VALUES($1,'/direct/t/1/','one','One','One|Yes',$2,$3) RETURNING id::text AS id",
    [PROFILE, "Yes interested, how to join?", clock.now])).rows[0].id;

  // The bot announces it once, with the saved answer as a button.
  await tick();
  const announced = fake.sent.at(-1);
  assert.match(announced.text, /^💬 @one {2}\(Personal Profile par\)\n\nYes interested, how to join\?/);
  assert.deepEqual(announced.reply_markup.inline_keyboard[0], [{ text: "Details", callback_data: `t:${reply}:${template.id}` }]);
  assert.equal(announced.reply_markup.inline_keyboard[1][0].callback_data, `d:${reply}`);
  await tick();
  assert.equal(fake.sent.at(-1), announced, "announced once");

  // Replying to that message queues the answer for the DM worker.
  await say("Hello ji, bataiye", { reply_to_message: { message_id: announced.message_id } });
  assert.match(fake.sent.at(-1).text, /Line mein hai/);
  // The saved-answer button queues it with the creator's username filled in.
  await hook({ callback_query: { id: "cb1", data: `t:${reply}:${template.id}`, message: { message_id: announced.message_id, chat: { id: OWNER, type: "private" } } } });
  const outbox = (await h.db.query("SELECT id::text AS id,message,status FROM dm_outbox ORDER BY id")).rows;
  assert.deepEqual(outbox.map((row) => [row.message, row.status]), [["Hello ji, bataiye", "pending"], ["Hi one, details: ₹800 per 1M views.", "pending"]]);
  assert.ok(fake.calls.some((call) => call.method === "answerCallbackQuery" && call.body.text === "Line mein ✓"));

  // A message that is not a reply to a creator gets the help.
  await say("hello?");
  assert.match(fake.sent.at(-1).text, /kisi creator wale message par Reply/);

  // When the worker has sent it, the bot says so once.
  await h.db.query("UPDATE dm_outbox SET status='sent',sent_at=$2,updated_at=$2 WHERE id=$1", [outbox[0].id, clock.now]);
  await h.db.query("UPDATE dm_outbox SET status='failed',reason='not_delivered',updated_at=$2 WHERE id=$1", [outbox[1].id, clock.now]);
  await tick();
  const results = fake.sent.slice(-2).map((message) => message.text);
  assert.deepEqual(results, ["✅ @one ko jawab gaya: “Hello ji, bataiye”", "❌ @one ko jawab nahi gaya (DM nahi pahuncha (sirf followers se message leta hai)): “Hi one, details: ₹800 per 1M views.”"]);

  // "Ho gaya" closes it and removes the buttons.
  await hook({ callback_query: { id: "cb2", data: `d:${reply}`, message: { message_id: announced.message_id, chat: { id: OWNER, type: "private" } } } });
  assert.equal((await h.db.query("SELECT status FROM dm_replies WHERE id=$1", [reply])).rows[0].status, "done");
  assert.ok(fake.calls.some((call) => call.method === "editMessageReplyMarkup"));

  // /check asks every account's inbox to be read.
  await say("/check");
  assert.match(fake.sent.at(-1).text, /Inbox check shuru \(1 account\)/);
  assert.ok((await h.db.query("SELECT check_requested_at FROM dm_inboxes WHERE profile_id=$1", [PROFILE])).rows[0]?.check_requested_at);

  // A finished test run is an alert.
  await h.request(`/api/dm/campaigns/${campaign.id}/start`, { method: "POST", cookie, body: { stop_after: 1 } });
  await worker();
  await settle();
  assert.ok(fake.sent.some((message) => /“Commenters”: Test poora hua/.test(message.text)));
  // The /check asked earlier is answered even when nothing is new.
  assert.ok(fake.sent.some((message) => message.text === "✅ Inbox check ho gaya (@aiglow.artlab): koi naya reply nahi."));

  // The day's summary after 22:00 India time, once.
  clock.now = new Date("2026-10-18T17:00:00.000Z");
  await tick();
  const digest = fake.sent.at(-1).text;
  assert.match(digest, /^📊 Aaj ka hisaab\nDM gaye: 1\nNaye reply: 1\nTumhare jawab gaye: 1\nKharcha: ₹/);
  await tick();
  assert.equal(fake.sent.at(-1).text, digest);

  // Unlinking from the website stops it.
  assert.equal((await h.request("/api/telegram", { method: "DELETE", cookie })).data.linked, false);
  const count = fake.sent.length;
  await say("/aaj");
  assert.equal(fake.sent.length, count);
});

test("telegram: without a token the website works and the bot parts say so", async (t) => {
  const h = await harness(t, { env: {} });
  const cookie = await h.login();
  assert.deepEqual((await h.request("/api/telegram", { cookie })).data, { configured: false, bot: null, linked: false, linked_at: null });
  assert.equal((await h.request("/api/telegram/link", { method: "POST", cookie, body: {} })).data.error, "telegram_not_configured");
  assert.equal((await h.request("/telegram/webhook", { method: "POST", body: { update_id: 1 }, headers: { "X-Telegram-Bot-Api-Secret-Token": "x" } })).status, 403);
});
