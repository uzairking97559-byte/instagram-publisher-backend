"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { harness, json } = require("./helpers");
const { extractContact, parseImportLine } = require("../lib/leads");

const TOKEN = "1234567890:AAH-test_only_token_for_the_bot_0123456";
const SECRET = crypto.createHmac("sha256", TOKEN).update("telegram-webhook").digest("hex").slice(0, 48);
const PROFILE = "35a603c8-5ea3-415e-a626-eb4d530cdcb4";
const OWNER = 555001;
const NOON_IST = "2026-10-18T06:30:00.000Z";

test("a WhatsApp number or Telegram ID is picked out of a reply", () => {
  const cases = [
    ["Mera WhatsApp 98765 43210 hai", { phone: "9876543210", telegram: null }],
    ["+91-98765-43210", { phone: "9876543210", telegram: null }],
    ["919876543210", { phone: "9876543210", telegram: null }],
    ["call 09876543210", { phone: "9876543210", telegram: null }],
    ["https://wa.me/919876543210", { phone: "9876543210", telegram: null }],
    ["Telegram id: @rahul_edits", { phone: null, telegram: "rahul_edits" }],
    ["telegram pe aa jao @Rahul_123 yahan", { phone: null, telegram: "Rahul_123" }],
    ["Telegram id - rahul_edits", { phone: null, telegram: "rahul_edits" }],
    ["t.me/rahul_edits", { phone: null, telegram: "rahul_edits" }],
    ["Yes bro\n@rahul_edits", { phone: null, telegram: "rahul_edits" }],
    ["WhatsApp 7012345678, telegram @memes_hub", { phone: "7012345678", telegram: "memes_hub" }],
    // Not contacts: views, prices, short words, invite links, a handle inside a sentence.
    ["Yes please, how much for 1M views?", { phone: null, telegram: null }],
    ["Mere 1234567890 views hain", { phone: null, telegram: null }],
    ["98765432101234", { phone: null, telegram: null }],
    ["Telegram nahi hai", { phone: null, telegram: null }],
    ["t.me/joinchat/abcdef", { phone: null, telegram: null }],
    ["follow @rahul_edits on insta bhai", { phone: null, telegram: null }],
    ["@abc", { phone: null, telegram: null }]
  ];
  for (const [text, expected] of cases) assert.deepEqual(extractContact(text), expected, text);
});

test("a pasted line of an old creator gives a name, a number, an Instagram page or a Telegram ID", () => {
  const cases = [
    ["Rahul Memes 98765 43210", { username: null, phone: "9876543210", telegram: null, name: "Rahul Memes" }],
    ["+91 70123-45678, Sana edits", { username: null, phone: "7012345678", telegram: null, name: "Sana edits" }],
    ["@Funny.Page 91234 56789", { username: "funny.page", phone: "9123456789", telegram: null, name: null }],
    ["https://www.instagram.com/edits_hub/?igsh=abc 70123 45678", { username: "edits_hub", phone: "7012345678", telegram: null, name: null }],
    ["Aman | 9988776655 | t.me/aman_memes", { username: null, phone: "9988776655", telegram: "aman_memes", name: "Aman" }],
    ["@meme.wala", { username: "meme.wala", phone: null, telegram: null, name: null }],
    ["Naam, Number", { username: null, phone: null, telegram: null, name: "Naam Number" }]
  ];
  for (const [line, expected] of cases) assert.deepEqual(parseImportLine(line), expected, line);
});

function fakes() {
  const sent = [];
  const run = async (url, init = {}) => {
    if (url.hostname === "api.telegram.org") {
      const method = url.pathname.split("/").pop();
      const body = JSON.parse(init.body || "{}");
      if (method === "getMe") return json({ ok: true, result: { username: "creatordeskk_bot" } });
      if (method === "sendMessage") { const message = { message_id: 900 + sent.length, ...body }; sent.push(message); return json({ ok: true, result: message }); }
      return json({ ok: true, result: true });
    }
    if (url.hostname === "api.browser-use.com" && url.pathname === "/api/v4/browsers" && init.method === "POST") {
      return json({ id: crypto.randomUUID(), status: "active", cdpUrl: "wss://cdp.test/x", proxyUsedMb: "0", proxyCost: "0", browserCost: "0" }, 201);
    }
    if (url.hostname === "api.browser-use.com") return json({ id: crypto.randomUUID(), status: "stopped", proxyUsedMb: "1", proxyCost: "0.01", browserCost: "0.002" });
    throw new Error(`Unexpected call ${url.href}`);
  };
  return { run, sent };
}

function driver(inbox) {
  return {
    async open() {
      let alive = true;
      return {
        alive: () => alive,
        sendDm: async () => ({ status: "sent" }),
        readReplies: async () => ({ status: "ok", account: "aiglow.artlab", rows: inbox.length, waiting: inbox.length, skipped: 0, replies: inbox.splice(0) }),
        sendReply: async () => ({ status: "sent" }),
        idle: async () => {},
        close: () => { alive = false; }
      };
    }
  };
}

test("joined: a number or Telegram ID in a DM reply makes a lead, with an alert; the owner moves it along", async (t) => {
  const fake = fakes();
  const inbox = [];
  const clock = { now: new Date(NOON_IST) };
  const h = await harness(t, {
    env: { BROWSER_USE_API_KEY: "test-browser-use-key", TELEGRAM_BOT_TOKEN: TOKEN }, meta: fake.run,
    dmOptions: { driver: driver(inbox), now: () => clock.now, random: () => 0.5, intervalMs: 0 },
    telegramOptions: { intervalMs: 0, setup: false, now: () => clock.now, kick: () => {} }
  });
  const cookie = await h.login();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const leads = async (status = "") => (await h.request(`/api/leads${status ? `?status=${status}` : ""}`, { cookie })).data;

  // Telegram linked, and a campaign that DMs one, two and three.
  const link = (await h.request("/api/telegram/link", { method: "POST", cookie, body: {} })).data.url;
  await h.request("/telegram/webhook", { method: "POST", originHeader: null, headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: { update_id: 1, message: { message_id: 1, chat: { id: OWNER, type: "private" }, text: `/start ${link.split("start=")[1]}` } } });
  const campaign = (await h.request("/api/dm/campaigns", { method: "POST", cookie, body: {
    name: "Commenters", profile_id: PROFILE, profile_name: "Personal Profile", message: "Hi {username}", usernames: "one\ntwo\nthree",
    daily_limit: 100, gap_minutes: 9, start_hour: 8, end_hour: 23, requested_contact: true } })).data.campaign;
  assert.deepEqual((await leads()).counts, { total: 0, today: 0, new: 0, talking: 0, logo_sent: 0, working: 0, declined: 0 });

  // The first DM, then a look at the inbox: one sent a number, two just said yes.
  inbox.push(
    { key: "One|wa", name: "One", username: "one", thread: "/direct/t/1/", text: "Haan bhai, WhatsApp 98765 43210", matched: true },
    { key: "Two|yes", name: "Two", username: "two", thread: "/direct/t/2/", text: "Yes, details?", matched: true });
  await h.request(`/api/dm/campaigns/${campaign.id}/start`, { method: "POST", cookie, body: {} });
  await h.app.locals.runDmWorker();
  await settle();

  let data = await leads();
  assert.deepEqual(data.leads.map(({ username, name, phone, telegram, status, source, account }) => ({ username, name, phone, telegram, status, source, account })),
    [{ username: "one", name: "One", phone: "9876543210", telegram: null, status: "new", source: "dm", account: "aiglow.artlab" }]);
  assert.deepEqual([data.counts.total, data.counts.today, data.counts.new], [1, 1, 1]);
  const alert = fake.sent.find((message) => message.text.startsWith("📇"));
  assert.match(alert.text, /^📇 @one ne contact bheja — Joined list mein daal diya\.\nWhatsApp: 9876543210/);
  assert.deepEqual(alert.reply_markup.inline_keyboard[0], [{ text: "WhatsApp ↗", url: "https://wa.me/919876543210" }]);
  const replies = (await h.request("/api/dm/replies", { cookie })).data.replies;
  assert.deepEqual(replies.map((item) => [item.username, item.joined]).sort(), [["one", true], ["two", false]]);

  // The same text again is not a new lead; a Telegram ID later fills it in.
  inbox.push({ key: "One|tg", name: "One", username: "one", thread: "/direct/t/1/", text: "Haan bhai, WhatsApp 98765 43210\nTelegram: @one_edits", matched: true });
  await h.request("/api/dm/replies/check", { method: "POST", cookie, body: { profile_id: PROFILE } });
  await h.app.locals.runDmWorker();
  await settle();
  data = await leads();
  assert.deepEqual([data.leads.length, data.leads[0].phone, data.leads[0].telegram], [1, "9876543210", "one_edits"]);
  assert.equal(fake.sent.filter((message) => message.text.startsWith("📇")).length, 2);

  // "Joined mein daalo" from a reply without a contact, and a hand-added one.
  const two = replies.find((item) => item.username === "two");
  assert.equal((await h.request("/api/leads", { method: "POST", cookie, body: { reply_id: "999999" } })).data.error, "reply_not_found");
  assert.equal((await h.request("/api/leads", { method: "POST", cookie, body: { reply_id: two.id, phone: "12345" } })).data.error, "invalid_lead");
  assert.equal((await h.request("/api/leads", { method: "POST", cookie, body: { reply_id: two.id } })).status, 201);
  assert.equal((await h.request("/api/leads", { method: "POST", cookie, body: { username: "not a name!" } })).data.error, "invalid_lead");
  const added = await h.request("/api/leads", { method: "POST", cookie, body: { username: "@Four.Pages", telegram: "https://t.me/four_pages" } });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.leads.map((item) => [item.username, item.source, item.telegram]),
    [["four.pages", "manual", "four_pages"], ["two", "dm", null], ["one", "dm", "one_edits"]]);

  // Status, note and contact changes; a filter by status; delete.
  const id = data.leads[0].id;
  assert.equal((await h.request(`/api/leads/${id}`, { method: "PUT", cookie, body: { status: "boss" } })).data.error, "invalid_lead");
  assert.equal((await h.request(`/api/leads/${id}`, { method: "PUT", cookie, body: {} })).data.error, "invalid_lead");
  assert.equal((await h.request("/api/leads/123456", { method: "PUT", cookie, body: { status: "talking" } })).data.error, "lead_not_found");
  const moved = await h.request(`/api/leads/${id}`, { method: "PUT", cookie, body: { status: "working", note: "  Logo lag gaya, 2 Reels  " } });
  assert.deepEqual([moved.data.counts.working, moved.data.counts.new], [1, 2]);
  const one = moved.data.leads.find((item) => item.id === id);
  assert.deepEqual([one.status, one.note], ["working", "Logo lag gaya, 2 Reels"]);
  assert.deepEqual((await leads("working")).leads.map((item) => item.username), ["one"]);
  await h.request(`/api/leads/${id}`, { method: "PUT", cookie, body: { phone: "" } });
  assert.equal((await leads("working")).leads[0].phone, null);
  const removed = await h.request(`/api/leads/${id}`, { method: "DELETE", cookie });
  assert.deepEqual(removed.data.leads.map((item) => item.username), ["four.pages", "two"]);
  assert.equal((await h.request(`/api/leads/${id}`, { method: "DELETE", cookie })).data.error, "lead_not_found");
  assert.equal((await h.request("/api/leads")).status, 401, "owner only");

  // The morning report counts them.
  clock.now = new Date("2026-10-19T03:35:00.000Z");
  await h.app.locals.runTelegram();
  const report = fake.sent.find((message) => message.text.startsWith("📅"));
  assert.match(report.text, /📇 Joined: kal 2 naye · 2 se baat chal rahi · 0 ne kaam shuru kiya/);
});

test("joined: old creators imported in one go, who brought whom, and the target", async (t) => {
  const clock = { now: new Date(NOON_IST) };
  const h = await harness(t, { env: { BROWSER_USE_API_KEY: "test-browser-use-key" }, dmOptions: { now: () => clock.now, intervalMs: 0 } });
  const cookie = await h.login();
  const get = async (query = "") => (await h.request(`/api/leads${query}`, { cookie })).data;
  const imp = (text, referrer) => h.request("/api/leads/import", { method: "POST", cookie, body: { text, referrer } });

  // Nothing set yet: target 50, no date.
  let data = await get();
  assert.deepEqual(data.target, { target: 50, deadline: null, saved: false, working: 0, logo_sent: 0, remaining: 50, days_left: null, per_day: null });
  assert.deepEqual(data.referrers, []);

  assert.equal((await imp("   \n ")).data.error, "invalid_import");
  assert.equal((await imp(Array.from({ length: 2001 }, (_, i) => `x ${i}`).join("\n"))).data.error, "too_many_leads");
  let result = (await imp("Rahul Memes 98765 43210\n@funny.page 91234 56789\nheader line\nRahul again 98765 43210\n@funny.page")).data;
  assert.deepEqual([result.added, result.updated, result.same, result.invalid], [2, 0, 2, ["header line"]]);
  assert.deepEqual(result.leads.map(({ username, name, phone, source, status }) => ({ username, name, phone, source, status })), [
    { username: "funny.page", name: null, phone: "9123456789", source: "import", status: "new" },
    { username: null, name: "Rahul Memes", phone: "9876543210", source: "import", status: "new" }]);

  // A second paste completes the ones already there and adds the rest, all brought by one manager.
  result = (await imp("@rahul.memes 98765 43210\nSana 70123 45678", "Ali Agency")).data;
  assert.deepEqual([result.added, result.updated, result.same], [1, 1, 0]);
  data = await get();
  const rahul = data.leads.find((lead) => lead.phone === "9876543210");
  assert.deepEqual([rahul.username, rahul.name, rahul.referrer], ["rahul.memes", "Rahul Memes", "Ali Agency"], "gaps filled, old values kept");

  // By hand: a number alone is enough; a referrer typed in another case groups with the same one.
  assert.equal((await h.request("/api/leads", { method: "POST", cookie, body: { name: "Only a name" } })).data.error, "invalid_lead");
  const added = await h.request("/api/leads", { method: "POST", cookie, body: { name: "Kiran", phone: "99887 76655", referrer: "ali agency" } });
  assert.equal(added.status, 201);
  const kiran = added.data.leads.find((lead) => lead.name === "Kiran");
  assert.equal(kiran.source, "manual");
  const sana = added.data.leads.find((lead) => lead.name === "Sana");
  assert.equal((await h.request(`/api/leads/${sana.id}`, { method: "PUT", cookie, body: { username: "@funny.page" } })).data.error, "lead_exists");
  await h.request(`/api/leads/${sana.id}`, { method: "PUT", cookie, body: { status: "working", username: "sana.edits" } });
  await h.request(`/api/leads/${kiran.id}`, { method: "PUT", cookie, body: { status: "logo_sent" } });
  data = await get();
  assert.deepEqual(data.referrers, [{ name: "Ali Agency", pages: 3, working: 1 }]);
  assert.deepEqual((await get("?referrer=ALI%20AGENCY")).leads.map((lead) => lead.username || lead.name).sort(), ["Kiran", "rahul.memes", "sana.edits"]);

  // The target: 3 working by Friday 23 Oct, set on Sunday 18 Oct (India time) = 6 days left.
  assert.equal((await h.request("/api/leads/target", { method: "PUT", cookie, body: { target: 0 } })).data.error, "invalid_target");
  assert.equal((await h.request("/api/leads/target", { method: "PUT", cookie, body: { target: 3, deadline: "2026-02-30" } })).data.error, "invalid_target");
  data = (await h.request("/api/leads/target", { method: "PUT", cookie, body: { target: 3, deadline: "2026-10-23" } })).data;
  assert.deepEqual(data.target, { target: 3, deadline: "2026-10-23", saved: true, working: 1, logo_sent: 1, remaining: 2, days_left: 6, per_day: 1 });
  clock.now = new Date("2026-10-24T06:30:00.000Z");
  assert.deepEqual([(await get()).target.days_left, (await get()).target.per_day], [0, null]);
});
