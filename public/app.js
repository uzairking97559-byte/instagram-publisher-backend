"use strict";

const $ = (id) => document.getElementById(id);
const messages = {
  setup_required: "Secure setup abhi complete nahi hai.",
  connected: "Account connection save ho gaya. Neeche accounts check karo.",
  no_accounts: "Is authorization se koi eligible Instagram professional account nahi mila. Page linking aur permissions check karo.",
  connection_invalid: "Yeh connection link expire ho gaya ya doosre browser ka hai. Connect button se fresh login shuru karo.",
  connection_processing: "Yeh connection process ho raha hai. Thodi der baad Refresh dabao; callback ko dobara submit mat karo.",
  connection_cancelled: "Connection cancel hua. Jab ready ho tab dobara connect kar sakte ho.",
  connection_failed: "Connection complete nahi hua. Account list check karo, phir Connect se fresh attempt karo.",
  connection_permissions: "Meta ne Reel publish karne ki permission nahi di. Connect dobara dabao aur Meta ki screen par saari permissions allow karo, koi untick mat karo.",
  invalid_login: "Dashboard password sahi nahi hai.",
  sign_in_required: "Dashboard mein dobara sign in karo. Saved account connections safe hain.",
  reconnect_required: "Account ki authorization expire ya revoke hui hai. Official login se reconnect karo.",
  permission_required: "Meta ki required publishing permission nahi mili. App access aur account permissions check karo.",
  meta_rate_limit: "Meta ki request limit mili. Publishing rok do aur baad mein try karo.",
  meta_rejected: "Meta ne media request accept nahi ki. Format, account access aur permissions check karo.",
  meta_unavailable: "Meta se status nahi mila. Baad mein existing request ka status check karo.",
  creation_uncertain: "Media request ka result clear nahi hai. Is request ko automatically dobara nahi bheja jayega.",
  publish_uncertain: "Post publish hui ya nahi, abhi confirm nahi hai. Pehle Instagram check karo; nayi duplicate request mat banao.",
  media_processing_failed: "Meta media process nahi kar saka. Format aur public link check karo.",
  container_expired: "Ye Reel 24 ghante mein publish nahi ho payi, isliye Meta pe expire ho gayi. Account theek hai ya nahi check karo, phir video dobara upload karo.",
  origin_rejected: "Website ko uske configured HTTPS address par seedha kholo.",
  login_rate_limit: "Bahut login attempts hue. 15 minute baad try karo.",
  request_rate_limit: "Bahut requests hui. Ek minute rukkar try karo.",
  connection_rate_limit: "Connection attempts ki limit aa gayi. Baad mein try karo.",
  provider_not_configured: "Yeh login option abhi configure nahi hua hai.",
  invalid_post: "Account, HTTPS media link aur caption (maximum 2200 characters) check karo.",
  invalid_upload: "Video file ko dobara chuno aur upload try karo.",
  invalid_video_format: "MP4 ya MOV video select karo.",
  upload_too_large: "Har video 250 MB se chhoti honi chahiye.",
  request_too_large: "Video ka ek hissa server tak nahi pahuncha. Dobara try karo.",
  upload_incomplete: "Video ke saare hisse upload nahi hue. Same files dobara chuno, jo hissa reh gaya wahi jayega.",
  upload_not_found: "Ye upload expire ho gaya (3 ghante). Videos dobara chuno.",
  invalid_upload_part: "Video ka ek hissa kharab pahuncha. Same files dobara chuno.",
  upload_storage_full: "Storage limit bhar gayi. Queue ki Reels post hone do (har Reel post hote hi uski jagah khaali hoti hai), ya kam videos chuno.",
  invalid_batch: "1–20 videos, account, caption aur 5 minute se 1 ghante tak ka gap select karo.",
  invalid_progress_settings: "Target 1–10,000 aur pehle se ki ginti 0 se target ke beech rakho.",
  asset_unavailable: "Koi selected video upload nahi hui ya pehle se queue mein hai. Videos dobara select karke upload karo.",
  batch_cannot_resume: "Is batch ko continue nahi kar sakte. Pehle uncertain Reel ka status check karo.",
  batch_cannot_cancel: "Ye batch pehle hi poora ho chuka hai, cancel karne ko kuch nahi bacha.",
  batch_not_found: "Batch nahi mila. Activity refresh karo.",
  idempotency_conflict: "Is request ki details badal gayi hain. History check karke page refresh karo.",
  connection_removed: "Is job ka account connection remove ho gaya hai.",
  connection_changed: "Account connection change hua. Refresh karke dobara check karo.",
  account_not_found: "Account connection nahi mila. List refresh karo.",
  token_storage_unavailable: "Saved connection abhi read nahi ho raha. Setup check karna zaroori hai.",
  temporarily_unavailable: "Server se response nahi mila. Activity check karo; upload ya batch ka status clear hone tak use dobara submit mat karo.",
  upload_network_unreachable: "Phone se website ka connection toot gaya. Upload confirm nahi hua; Activity check karo, batch pending na ho tabhi same files retry karo.",
  upload_recovery_timeout: "5 minute tak service ready nahi hui. Activity check karo; batch entry na ho to hi same files retry karo.",
  upload_timeout: "Video upload ka response time out hua. Activity check karo; batch entry na ho to hi same files retry karo.",
  invalid_frame_settings: "Frame ki settings sahi nahi hain. Page refresh karke dobara save karo.",
  frame_art_missing: "Pehle apni photo upload karo, phir “Apni photo” chuno.",
  invalid_frame_image: "JPG, PNG ya WEBP photo chuno.",
  frame_image_too_large: "Photo 5 MB se chhoti honi chahiye.",
  frame_unavailable: "Preview abhi nahi ban saka. Thodi der baad dobara try karo."
};
const FRAME_COLOURS = { purple: "Purple", red: "Red", blue: "Blue", green: "Green", teal: "Teal", brown: "Brown" };
const frameSettings = new Map();
const frameEditors = new Map();
let frameTouched = false;
let captionTouched = false;
let accounts = [];
let jobs = [];
let progress = [];
let storage = null;
// The account picked in the switcher ("all" for every account). Accounts,
// Create post and Activity all follow it. Remembered per browser only.
const ALL_ACCOUNTS = "all";
const VIEWS = ["connections", "composer", "activity", "dms"];
let selectedAccount = /^\d{1,18}$/.test(readSetting("publisher-selected-account") || "") ? readSetting("publisher-selected-account") : ALL_ACCOUNTS;
let accountsLoaded = false;
let jobsScope = null;
const batchOpen = new Map();
let busy = false;
let busyAccount = null;
let pendingPollTimer = null;
let lastNoticeCode = null;
const timers = new Map();
const attempts = new Map();

function notice(text, error = false, code = null) {
  lastNoticeCode = error ? code : null;
  $("message").textContent = text;
  $("message").className = `notice${error ? " error" : ""}`;
  $("message").hidden = false;
}
function explain(error) {
  const code = error?.code || null;
  notice(error?.detail || messages[code] || "Request complete nahi hui. History check karke existing request dobara check karo.", true, code);
}
function clearTemporaryUnavailable() {
  if (lastNoticeCode !== "temporarily_unavailable") return;
  $("message").hidden = true;
  lastNoticeCode = null;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function readSetting(name) {
  try { return localStorage.getItem(name); } catch { return null; }
}
function writeSetting(name, value) {
  try { localStorage.setItem(name, value); } catch {}
}
function accountName(account) { return account.username || account.account_id; }
function currentAccount() { return accounts.find((account) => account.connection_id === selectedAccount) || null; }
function progressFor(account) { return progress.find((row) => row.connection_id === account.connection_id) || null; }
// Each account keeps the same avatar colour, so accounts are easy to tell apart.
function paintAvatar(node, name) {
  let hue = 0;
  for (const char of name || "") hue = (hue * 31 + char.codePointAt(0)) % 360;
  node.textContent = name ? name.slice(0, 1) : "∗";
  node.classList.toggle("all", !name);
  node.style.setProperty("--hue", String(hue));
}
function avatar(name, className = "avatar") {
  const node = element("span", undefined, className);
  node.setAttribute("aria-hidden", "true");
  paintAvatar(node, name);
  return node;
}
function showSignedOut() {
  $("workspace").hidden = true; $("signin").hidden = false; $("logout").hidden = true; $("independence").hidden = false;
}
function showView(name) {
  if (!VIEWS.includes(name)) name = "connections";
  for (const view of VIEWS) {
    const active = view === name;
    $(view).hidden = !active;
    $(`tab-${view}`).setAttribute("aria-selected", String(active));
    $(`tab-${view}`).tabIndex = active ? 0 : -1;
  }
  writeSetting("publisher-view", name);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `${location.pathname}#${name}`);
  if (name === "dms") void loadDm().catch(explain); else updateDmPolling();
  // Keep the account bar pinned and start the new view from its top.
  const top = $("workspace").getBoundingClientRect().top + window.scrollY;
  if (!$("workspace").hidden && window.scrollY > top) window.scrollTo({ top });
}
function selectAccount(id) {
  const next = accounts.some((account) => account.connection_id === id) ? id : ALL_ACCOUNTS;
  const changed = next !== selectedAccount;
  selectedAccount = next;
  writeSetting("publisher-selected-account", next);
  renderAccounts(); renderJobs();
  if (changed) void loadJobs().catch(explain);
}
function addAccountProgress(card, account) {
  const item = progressFor(account);
  if (!item) return;
  const target = item.target_count;
  const baseline = item.baseline_count;
  const counted = item.tracked_count;
  const remaining = item.remaining_count;
  const block = element("section", undefined, "account-progress");
  const title = element("div", undefined, "progress-heading");
  title.append(element("strong", `${counted} / ${target} posts`), element("span", `${remaining} baaki`));
  block.append(title);
  const bar = element("progress", undefined, "progress-bar");
  bar.max = target; bar.value = Math.min(target, counted);
  bar.setAttribute("aria-label", `@${accountName(account)}: ${counted} of ${target} posts tracked`);
  block.append(bar);
  const stats = element("div", undefined, "stats");
  for (const [value, label, tone] of [[item.published_count, "Posted", "good"], [item.scheduled_count, "Scheduled", ""],
    [item.failed_count, "Failed", item.failed_count ? "bad" : ""], [item.unknown_count, "Check needed", item.unknown_count ? "bad" : ""]]) {
    const stat = element("div", undefined, tone ? `stat ${tone}` : "stat");
    stat.append(element("strong", String(value)), element("span", label));
    stats.append(stat);
  }
  block.append(stats);
  if (baseline) block.append(element("p", `Is site se pehle ke ${baseline} posts bhi target mein gine gaye hain.`, "progress-details"));

  const details = document.createElement("details");
  details.className = "progress-settings";
  details.append(element("summary", "Target aur pehle se hui ginti set karo"));
  const form = element("form", undefined, "progress-form");
  const fields = element("div", undefined, "progress-fields");
  const targetLabel = element("label", "Total target");
  const targetInput = document.createElement("input");
  targetInput.type = "number"; targetInput.min = "1"; targetInput.max = "10000";
  targetInput.step = "1"; targetInput.required = true; targetInput.value = String(target);
  targetLabel.append(targetInput);
  const baselineLabel = element("label", "Site se pehle schedule/post");
  const baselineInput = document.createElement("input");
  baselineInput.type = "number"; baselineInput.min = "0"; baselineInput.max = String(target);
  baselineInput.step = "1"; baselineInput.required = true; baselineInput.value = String(baseline);
  targetInput.addEventListener("input", () => { baselineInput.max = targetInput.value || "10000"; });
  baselineLabel.append(baselineInput);
  fields.append(targetLabel, baselineLabel);
  const save = element("button", "Save progress target", "quiet");
  save.type = "submit";
  form.append(fields, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); save.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(account.connection_id)}/progress`, {
        method: "PUT", body: JSON.stringify({ target_count: Number(targetInput.value), baseline_count: Number(baselineInput.value) })
      });
      notice("Account ka progress target save ho gaya.");
      await refresh();
    } catch (error) { explain(error); }
    finally { save.disabled = false; }
  });
  details.append(form);
  block.append(details);
  card.append(block);
}
async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const readOnly = ["GET", "HEAD"].includes(method);
  const idempotencyKey = options.headers?.["Idempotency-Key"] || options.headers?.["idempotency-key"] || "";
  // Only batch creation is replayed as a write; its stable key makes the request idempotent.
  const idempotentBatch = method === "POST" && path === "/api/batches" && /^[0-9a-f-]{36}$/i.test(idempotencyKey);
  const retryable = readOnly || idempotentBatch;
  const retryDelays = [1000, 2000, 4000, 8000, 12000, 15000, 15000, 15000, 15000, 15000];
  const waitToRetry = async (delay) => {
    if (idempotentBatch) {
      $("publish-progress").textContent = "Batch ka server response abhi nahi mila. Page khula rakho; button dobara mat dabao.";
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  };
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...options,
        headers: { "Content-Type": "application/json", ...options.headers }, signal: AbortSignal.timeout(35000) });
    } catch (error) {
      if ((readOnly || idempotentBatch) && error?.name !== "TimeoutError" && attempt < retryDelays.length) {
        await waitToRetry(retryDelays[attempt]);
        continue;
      }
      throw { code: "temporarily_unavailable" };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && data.error === "sign_in_required") {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        showSignedOut();
      }
      const code = data.error || "temporarily_unavailable";
      if (retryable && response.status >= 500 && code === "temporarily_unavailable" && attempt < retryDelays.length) {
        await waitToRetry(retryDelays[attempt]);
        continue;
      }
      throw { code };
    }
    return data;
  }
}
function renderAccounts() {
  // A remembered account that was disconnected falls back to all accounts.
  if (accountsLoaded && selectedAccount !== ALL_ACCOUNTS && !currentAccount()) {
    selectedAccount = ALL_ACCOUNTS;
    writeSetting("publisher-selected-account", ALL_ACCOUNTS);
  }
  renderSwitcher();
  const account = currentAccount();
  const list = $("accounts");
  list.replaceChildren();
  list.classList.toggle("plain", Boolean(account) || !accounts.length);
  $("account-count").textContent = accounts.length;
  $("accounts-scope").textContent = !accounts.length ? "Abhi koi account connect nahi hai."
    : account ? "Upar switcher se doosra account chuno." : "Kisi account pe tap karo, sirf uski details dikhegi.";
  if (!accounts.length) list.append(element("p", "Pehla professional account connect karo. Neeche “Naya account connect karo” kholo.", "empty"));
  else if (account) {
    const back = element("button", "← Sabhi accounts", "link-button");
    back.type = "button";
    back.addEventListener("click", () => selectAccount(ALL_ACCOUNTS));
    list.append(back, accountCard(account));
  } else for (const item of accounts) list.append(accountRow(item));
  if (accountsLoaded && !accounts.length) $("add-account").open = true;
  renderComposerAccounts();
}
function accountStatus(account) {
  return account.needs_reconnect ? "Reconnect needed" : "Connected";
}
function renderSwitcher() {
  const select = $("account-filter");
  select.replaceChildren(element("option", `Sabhi accounts (${accounts.length})`));
  select.firstChild.value = ALL_ACCOUNTS;
  for (const account of accounts) {
    const option = element("option", `@${accountName(account)}${account.needs_reconnect ? " · reconnect needed" : ""}`);
    option.value = account.connection_id;
    select.append(option);
  }
  const account = currentAccount();
  select.value = account ? account.connection_id : ALL_ACCOUNTS;
  paintAvatar($("switcher-avatar"), account ? accountName(account) : "");
  if (account) {
    const item = progressFor(account);
    const parts = [accountStatus(account)];
    if (item) parts.push(`${item.tracked_count}/${item.target_count} posts`);
    if (item?.scheduled_count) parts.push(`${item.scheduled_count} scheduled`);
    $("switcher-name").textContent = `@${accountName(account)}`;
    $("switcher-meta").textContent = parts.join(" · ");
  } else {
    const scheduled = progress.reduce((sum, row) => sum + row.scheduled_count, 0);
    $("switcher-name").textContent = "Sabhi accounts";
    $("switcher-meta").textContent = accounts.length
      ? `${accounts.length} accounts${scheduled ? ` · ${scheduled} scheduled` : ""}`
      : "Pehle account connect karo";
  }
}
// One compact line per account; tapping it opens just that account.
function accountRow(account) {
  const name = accountName(account);
  const item = progressFor(account);
  const row = element("button", undefined, "account-row");
  row.type = "button";
  const parts = [accountStatus(account)];
  if (item?.scheduled_count) parts.push(`${item.scheduled_count} scheduled`);
  if (item?.failed_count) parts.push(`${item.failed_count} failed`);
  if (item?.unknown_count) parts.push(`${item.unknown_count} check needed`);
  const text = element("span", undefined, "account-row-text");
  text.append(element("strong", `@${name}`), element("span", parts.join(" · "), account.needs_reconnect ? "warn" : ""));
  row.append(avatar(name), text, element("span", item ? `${item.tracked_count}/${item.target_count}` : "", "account-row-count"),
    element("span", "›", "chevron"));
  row.addEventListener("click", () => selectAccount(account.connection_id));
  return row;
}
function accountCard(account) {
  const name = accountName(account);
  const card = element("article", undefined, "account-card");
  const head = element("div", undefined, "account-name");
  const title = element("div");
  title.append(element("h3", `@${name}`),
    element("p", `${account.provider === "facebook" ? "Facebook Login" : "Instagram Login"} · ${accountStatus(account)}`, account.needs_reconnect ? "warn" : ""));
  if (account.token_expires_at) title.append(element("p", `Authorization until ${new Date(account.token_expires_at).toLocaleDateString()}`));
  head.append(avatar(name, "avatar large"), title);
  card.append(head);
  if (account.needs_reconnect) {
    card.append(element("p", "Is account ki authorization khatam ho gayi. Neeche “Naya account connect karo” se isi account se dobara login karo.", "account-warning"));
  }
  addAccountProgress(card, account);
  card.append(captionEditor(account), frameEditor(account));
  const actions = element("div", undefined, "account-actions");
  const post = element("button", "Post banao", "quiet strong");
  post.type = "button"; post.disabled = account.needs_reconnect;
  post.addEventListener("click", () => showView("composer"));
  const history = element("button", "Activity dekho", "quiet");
  history.type = "button";
  history.addEventListener("click", () => showView("activity"));
  const remove = element("button", "Disconnect", "quiet danger");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    if (!confirm(`@${name} ka saved connection remove karna hai? Is account ki jo Reels abhi queue mein hain, wo cancel ho jayengi. Meta permission alag se revoke karni hogi.`)) return;
    remove.disabled = true;
    try { await api(`/api/accounts/${account.connection_id}`, { method: "DELETE" }); await refresh(); }
    catch (error) { explain(error); remove.disabled = false; }
  });
  actions.append(post, history);
  if (account.username) actions.append(profileLink(account.username));
  actions.append(remove);
  card.append(actions);
  return card;
}
// The account's Instagram page. On Android it opens straight in the Instagram
// app (or the website when the app is not installed); elsewhere in a new tab.
function profileLink(username) {
  const web = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const link = element("a", undefined, "quiet profile-link");
  if (/Android/i.test(navigator.userAgent)) {
    link.href = `intent://instagram.com/_u/${encodeURIComponent(username)}/#Intent;package=com.instagram.android;scheme=https;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  } else {
    link.href = web; link.target = "_blank"; link.rel = "noopener noreferrer";
  }
  const icon = element("span", "◎", "provider-icon instagram");
  icon.setAttribute("aria-hidden", "true");
  const arrow = element("span", "↗");
  arrow.setAttribute("aria-hidden", "true");
  link.append(icon, element("span", "Instagram pe profile kholo"), arrow);
  return link;
}
async function loadFrameSettings(id, fresh = false) {
  if (!fresh && frameSettings.has(id)) return frameSettings.get(id);
  const { frame } = await api(`/api/accounts/${encodeURIComponent(id)}/frame`);
  frameSettings.set(id, frame);
  return frame;
}
// Phone photos are shrunk before upload: backgrounds to a 1080 px wide JPEG,
// bottom pictures to a 1000 px wide PNG so a transparent background stays.
async function shrinkImage(file, kind) {
  const bitmap = await createImageBitmap(file);
  const maxWidth = kind === "art" ? 1000 : 1080, maxHeight = kind === "art" ? 1500 : 1920;
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = kind === "art" ? "image/png" : "image/jpeg";
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject({ code: "invalid_frame_image" }), type, 0.88));
}
// The account's frame look. Built once per account and reused, so the
// 30-second refresh that redraws the account card keeps unsaved edits.
function frameEditor(account) {
  const id = account.connection_id;
  if (frameEditors.has(id)) return frameEditors.get(id);
  const details = element("details", undefined, "frame-settings");
  details.append(element("summary", "Frame ka look · background, line, box size"));
  const body = element("div", undefined, "frame-form");
  body.append(element("p", "Load ho raha hai…", "hint"));
  details.append(body);
  let built = false;
  details.addEventListener("toggle", () => {
    if (!details.open || built) return;
    built = true;
    loadFrameSettings(id, true).then((settings) => buildFrameForm(body, account, settings))
      .catch((error) => { built = false; body.replaceChildren(element("p", messages[error?.code] || "Settings load nahi hui. Dobara kholo.", "hint")); });
  });
  frameEditors.set(id, details);
  return details;
}
function frameSelect(options, value) {
  const select = document.createElement("select");
  for (const [optionValue, label] of options) {
    const option = element("option", label); option.value = String(optionValue); select.append(option);
  }
  select.value = String(value);
  return select;
}
function frameCheck(text, checked) {
  const label = element("label", undefined, "check");
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked;
  label.append(input, element("span", text));
  return { label, input };
}
function buildFrameForm(body, account, settings) {
  const id = account.connection_id;
  const path = `/api/accounts/${encodeURIComponent(id)}/frame`;
  body.replaceChildren();
  const preview = document.createElement("img");
  preview.className = "frame-preview"; preview.alt = `@${accountName(account)} ke frame ka preview`;
  const previewStatus = element("p", "", "hint frame-preview-status");
  const showPreview = () => {
    previewStatus.textContent = "Preview ban raha hai…";
    preview.src = `${path}/preview?v=${Date.now()}`;
  };
  preview.addEventListener("load", () => { previewStatus.textContent = "Grey box mein video aayegi. Upar ki line har Reel pe badal sakti hai."; });
  preview.addEventListener("error", () => { previewStatus.textContent = messages.frame_unavailable; });
  body.append(preview, previewStatus);

  const colour = frameSelect(settings.options.background_presets.map((name) => [name, FRAME_COLOURS[name] || name]), settings.background_preset);
  const box = frameSelect(settings.options.box_percents.map((value) => [value, `${value}% chauda`]), settings.box_percent);
  const fields = element("div", undefined, "frame-fields");
  const colourLabel = element("label", "Background rang"); colourLabel.append(colour);
  const boxLabel = element("label", "Video box ka size"); boxLabel.append(box);
  fields.append(colourLabel, boxLabel);
  body.append(fields);

  function imageRow(kind, title, hasImage) {
    const wrap = element("div");
    wrap.append(element("label", title));
    const row = element("div", undefined, "frame-image-row");
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/jpeg,image/png,image/webp";
    const remove = element("button", "Hatao", "quiet"); remove.type = "button"; remove.hidden = !hasImage;
    row.append(input, remove);
    wrap.append(row);
    const note = element("p", hasImage ? "Apni photo lagi hai." : "", "hint");
    wrap.append(note);
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.disabled = true; note.textContent = "Photo upload ho rahi hai…";
      try {
        const blob = await shrinkImage(file, kind);
        const { frame } = await api(`${path}/${kind}`, { method: "PUT", headers: { "Content-Type": blob.type }, body: blob });
        frameSettings.set(id, frame); buildFrameForm(body, account, frame);
      } catch (error) { explain(error); note.textContent = ""; input.disabled = false; input.value = ""; }
    });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        const { frame } = await api(`${path}/${kind}`, { method: "DELETE" });
        frameSettings.set(id, frame); buildFrameForm(body, account, frame);
      } catch (error) { explain(error); remove.disabled = false; }
    });
    return wrap;
  }
  body.append(imageRow("background", "Apni background photo (optional, rang ki jagah lagegi)", settings.custom_background));

  const art = frameSelect([["default", "Phoolon wali ladki (default)"], ["custom", "Apni photo"], ["none", "Kuch nahi"]], settings.art_mode);
  art.options[1].disabled = !settings.custom_art;
  const artLabel = element("label", "Neeche ki photo"); artLabel.append(art);
  body.append(artLabel);
  body.append(imageRow("art", "Apni neeche wali photo (PNG bina background ke sabse achhi lagti hai)", settings.custom_art));

  const username = frameCheck("Box ke neeche account ka username dikhao", settings.show_username);
  const byDefault = frameCheck("Is account ki nayi batch mein “Frame lagao” pehle se ON rahe", settings.frame_by_default);
  body.append(username.label, byDefault.label);

  const lines = document.createElement("textarea");
  lines.id = `frame-lines-${id}`;
  lines.rows = 6; lines.value = settings.title_lines.join("\n");
  lines.placeholder = settings.options.default_title_lines.slice(0, 6).join("\n");
  const linesLabel = element("label", "Upar ki lines · ek row mein ek line"); linesLabel.htmlFor = lines.id;
  body.append(linesLabel, lines,
    element("p", `Har Reel pe in mein se koi ek line lagegi. Khaali chhodo to website ki apni ${settings.options.default_title_lines.length} lines use hongi. Hinglish likho; emoji aur Hindi lipi nahi dikhegi.`, "hint"));

  const buttons = element("div", undefined, "frame-buttons");
  const save = element("button", "Save look", "quiet strong"); save.type = "button";
  const again = element("button", "Naya preview", "quiet"); again.type = "button";
  buttons.append(save, again);
  body.append(buttons);
  again.addEventListener("click", showPreview);
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const { frame } = await api(path, { method: "PUT", body: JSON.stringify({
        background_preset: colour.value, box_percent: Number(box.value), art_mode: art.value,
        show_username: username.input.checked, frame_by_default: byDefault.input.checked,
        title_lines: lines.value.split("\n").map((line) => line.trim()).filter(Boolean)
      }) });
      frameSettings.set(id, frame);
      notice(`@${accountName(account)} ka frame look save ho gaya.`);
      buildFrameForm(body, account, frame);
      if ($("account").value === id) void syncFrameChoice();
    } catch (error) { explain(error); save.disabled = false; }
  });
  showPreview();
}
// The "Frame lagao" switch starts as the account's own default.
// The account's saved caption, editable on its card. Built once per account
// so the 30-second refresh does not drop unsaved typing.
const captionEditors = new Map();
function captionEditor(account) {
  const id = account.connection_id;
  if (captionEditors.has(id)) return captionEditors.get(id).details;
  const details = element("details", undefined, "frame-settings");
  details.append(element("summary", "Default caption · har batch mein apne aap"));
  const form = element("div", undefined, "frame-form");
  const text = document.createElement("textarea");
  text.rows = 5; text.maxLength = 4400; text.id = `default-caption-${id}`;
  text.placeholder = "Jo caption is account ki har Reel pe lagana hai, yahan likho. Hashtags bhi.";
  const label = element("label", "Is account ka caption"); label.htmlFor = text.id;
  const count = element("span", "0 / 2200", "muted"); label.append(count);
  const save = element("button", "Save caption", "quiet strong"); save.type = "button";
  const note = element("p", "Create post mein ye account chunte hi caption box mein ye aa jayega. Kisi batch ke liye wahan badal sakte ho; default tab tak wahi rahega jab tak yahan save na karo.", "hint");
  const buttons = element("div", undefined, "frame-buttons"); buttons.append(save);
  form.append(label, text, buttons, note);
  details.append(form);
  const showCount = () => { count.textContent = `${[...text.value].length} / 2200`; };
  text.addEventListener("input", showCount);
  let loaded = false;
  const load = () => loadFrameSettings(id, true).then((settings) => { text.value = settings.default_caption || ""; showCount(); loaded = true; })
    .catch((error) => { note.textContent = messages[error?.code] || "Caption load nahi hua. Dobara kholo."; });
  details.addEventListener("toggle", () => { if (details.open && !loaded) void load(); });
  save.addEventListener("click", async () => {
    if ([...text.value].length > 2200) { notice("Caption 2200 characters se chhota rakho.", true); return; }
    save.disabled = true;
    try {
      const { frame } = await api(`/api/accounts/${encodeURIComponent(id)}/frame`, { method: "PUT", body: JSON.stringify({ default_caption: text.value }) });
      frameSettings.set(id, frame);
      notice(`@${accountName(account)} ka default caption save ho gaya.`);
      if ($("account").value === id) { if (!captionTouched) setCaption(frame.default_caption); updateCaptionDefault(frame); }
    } catch (error) { explain(error); }
    finally { save.disabled = false; }
  });
  captionEditors.set(id, { details, reload: () => { loaded = false; if (details.open) void load(); } });
  return details;
}
function refreshCaptionEditor(id) { captionEditors.get(id)?.reload(); }
// The "Frame lagao" switch and the caption start as the account's own
// defaults, until the owner changes them for this batch.
async function syncFrameChoice() {
  const id = $("account").value;
  updateCaptionDefault(null);
  if (!id || (frameTouched && captionTouched)) { updateFrameExtra(); return; }
  try {
    const settings = await loadFrameSettings(id);
    if ($("account").value === id) {
      if (!frameTouched) $("frame-enabled").checked = settings.frame_by_default;
      if (!captionTouched) setCaption(settings.default_caption || "");
      updateCaptionDefault(settings);
    }
  } catch { /* keep the current choice */ }
  updateFrameExtra();
}
function setCaption(text) {
  $("caption").value = text;
  $("caption").dispatchEvent(new Event("input"));
  captionTouched = false;
}
function updateCaptionDefault(settings) {
  const saved = settings?.default_caption || "";
  const same = Boolean(settings) && $("caption").value === saved;
  $("caption-default").hidden = !settings;
  $("caption-default-note").textContent = !settings ? "" : !saved ? "Is account ka koi default caption nahi hai."
    : same ? "Ye is account ka default caption hai." : "Caption badla hai. Sirf is batch pe lagega, jab tak default save na karo.";
  $("caption-save-default").hidden = !settings || same;
  $("caption-use-default").hidden = !settings || !saved || same;
}
function updateFrameExtra() {
  $("frame-extra").hidden = !$("frame-enabled").checked;
}
// Create post follows the picked account; with "all" the owner chooses one here.
function renderComposerAccounts() {
  const select = $("account");
  select.replaceChildren(element("option", accounts.length ? "Account chuno" : "Pehle account connect karo"));
  select.firstChild.value = "";
  for (const account of accounts) {
    if (account.needs_reconnect) continue;
    const option = element("option", `@${accountName(account)} · ${account.provider === "facebook" ? "Facebook" : "Instagram"}`);
    option.value = account.connection_id; select.append(option);
  }
  const usable = accounts.some((account) => account.connection_id === selectedAccount && !account.needs_reconnect);
  // While a post is being sent, keep showing the account it is going to.
  const before = select.dataset.account || "";
  select.value = busy && busyAccount ? busyAccount : usable ? selectedAccount : "";
  select.disabled = busy;
  if (select.value !== before) { select.dataset.account = select.value; frameTouched = false; captionTouched = false; void syncFrameChoice(); }
  $("publish-button").disabled = busy || !accounts.some((account) => !account.needs_reconnect);
}
function summarizeBatch(group, totalCount) {
  const counts = { total: Number(totalCount) || group.length, published: 0, pending: 0, processing: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const job of group) {
    if (job.status === "published") counts.published++;
    else if (job.status === "queued") counts.pending++;
    else if (["creating", "processing", "publishing"].includes(job.status)) counts.processing++;
    else if (job.status === "failed") counts.failed++;
    else if (job.status === "unknown") counts.unknown++;
    else if (job.status === "cancelled") counts.cancelled++;
  }
  counts.unlisted = Math.max(0, counts.total - group.length);
  return counts;
}
// "9:03 AM" today, "12 Oct, 9:03 AM" on another day.
function formatWhen(value) {
  const date = new Date(value);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time
    : `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}
function renderJobs() {
  const account = currentAccount();
  // Until the picked account's own list arrives, show its part of what is loaded.
  const visible = account ? jobs.filter((job) => job.connection_id === account.connection_id) : jobs;
  $("activity-scope").textContent = account ? `@${accountName(account)} ki history` : "Sabhi accounts ki history";
  $("jobs").replaceChildren();
  if (!visible.length) {
    $("jobs").append(element("p", account
      ? `@${accountName(account)} ki abhi koi history nahi. Create post se pehli batch banao.`
      : "Your next idea starts here. Publish requests yahan dikhengi.", "empty"));
  }
  const names = { queued: "QUEUED", creating: "CREATING", processing: "PROCESSING", publishing: "CONFIRMING", published: "PUBLISHED", failed: "FAILED", unknown: "CHECK NEEDED", cancelled: "CANCELLED" };
  const batches = new Map();
  const singles = [];
  for (const job of visible) {
    if (!job.batch_id) singles.push(job);
    else { if (!batches.has(job.batch_id)) batches.set(job.batch_id, []); batches.get(job.batch_id).push(job); }
  }
  function addAction(card, job) {
    if (!["processing", "unknown", "publishing"].includes(job.status)) return;
    // The server finishes batch Reels on its own; only an uncertain one needs the owner.
    if (job.batch_id && job.status !== "unknown") return;
    const action = element("button", job.status === "processing" ? "Check & finish publishing" : "Check existing request", "job-action");
    action.type = "button";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try { await advance(job.id, false); await refresh(); }
      catch (error) { explain(error); action.disabled = false; }
    });
    card.append(action);
  }
  for (const group of batches.values()) {
    group.sort((a, b) => a.batch_position - b.batch_position);
    const card = element("article", undefined, "job-card batch-card");
    const first = group[0];
    const status = first.batch_status === "cancelled" ? "cancelled"
      : first.batch_status === "completed"
      ? (group.some((job) => job.status === "failed") ? "failed" : "published")
      : group.find((job) => job.status === "unknown")?.status || group.find((job) => job.status === "failed")?.status
        || group.find((job) => job.status === "processing" || job.status === "publishing" || job.status === "creating")?.status || "queued";
    const head = element("div", undefined, "job-head");
    // With one account picked, every batch is that account's; skip repeating its name.
    head.append(element("strong", account ? `${first.batch_count} reels` : `@${first.account}`),
      element("span", names[status] || status, `badge ${status}`));
    const meta = `${account ? "" : `${first.batch_count} reels · `}${first.interval_minutes} min gap · Shuru: ${formatWhen(first.created_at)}`;
    const counts = summarizeBatch(group, first.batch_count);
    const progress = element("section", undefined, "batch-progress");
    const summary = element("div", undefined, "batch-progress-heading");
    const summaryParts = [];
    if (counts.pending) summaryParts.push(`${counts.pending} pending`);
    if (counts.processing) summaryParts.push(`${counts.processing} processing`);
    if (counts.failed) summaryParts.push(`${counts.failed} failed`);
    if (counts.unknown) summaryParts.push(`${counts.unknown} check needed`);
    if (counts.cancelled) summaryParts.push(`${counts.cancelled} cancelled`);
    if (counts.unlisted) summaryParts.push(`${counts.unlisted} status missing`);
    summary.append(element("strong", `${counts.published}/${counts.total} reels posted`),
      element("span", summaryParts.join(" · ") || "All reels posted"));
    const progressBar = document.createElement("progress");
    progressBar.className = "progress-bar";
    progressBar.max = Math.max(1, counts.total);
    progressBar.value = counts.published;
    progressBar.setAttribute("aria-label", `${counts.published} of ${counts.total} reels posted`);
    progress.append(summary, progressBar);
    card.append(head, element("p", meta, "job-meta"), progress);
    // Each distinct problem is explained once for the batch, not under every Reel.
    const problems = [...new Set(group.filter((job) => job.error_code && job.status !== "cancelled").map((job) => job.error_code))];
    for (const code of problems) card.append(element("p", messages[code] || "History check karke request ka status dobara dekho.", "batch-error"));
    // While a batch runs, say when its next Reel goes out.
    const next = ["queued", "running"].includes(first.batch_status) && group.find((job) => job.status === "queued");
    if (next) card.append(element("p", `Agli Reel: ${next.batch_position}/${next.batch_count} · ${formatWhen(next.scheduled_at)}`, "next-reel"));
    // Each batch shows its summary; its Reels open on tap. A batch with an
    // uncertain Reel starts open, because that Reel needs the owner to check it.
    const details = element("details", undefined, "batch-details");
    // Stay as the owner left it across the 30-second refresh that re-renders this list.
    details.open = batchOpen.has(first.batch_id) ? batchOpen.get(first.batch_id) : group.some((job) => job.status === "unknown");
    details.addEventListener("toggle", () => batchOpen.set(first.batch_id, details.open));
    details.append(element("summary", `${group.length} Reels dekho`));
    card.append(details);
    for (const job of group) {
      const row = element("div", undefined, "batch-job-row");
      const label = job.media_name || `Reel ${job.batch_position}`;
      row.append(element("span", `Reel ${job.batch_position}/${job.batch_count} · ${label}`),
        element("span", names[job.status] || job.status, `badge ${job.status}`));
      details.append(row);
      const frameText = frameStateText(job);
      if (frameText) details.append(element("p", frameText, `frame-state${job.frame_status === "failed" ? " bad" : ""}`));
      if (job.status === "queued") details.append(element("p", `Publish target: ${formatWhen(job.scheduled_at)}`));
      addAction(details, job);
    }
    if (first.batch_status === "paused") {
      card.append(element("p", "Batch ruk gaya hai. Failed Reel check kar lo; baaki queue abhi publish nahi hogi."));
      const failed = group.find((job) => job.status === "failed");
      if (failed && !["publish_uncertain", "creation_uncertain"].includes(first.batch_pause_reason)) {
        const resume = element("button", "Continue with next reel", "job-action");
        resume.type = "button";
        resume.addEventListener("click", async () => {
          resume.disabled = true;
          try { await api(`/api/batches/${first.batch_id}/resume`, { method: "POST", body: "{}" }); await refresh(); }
          catch (error) { explain(error); resume.disabled = false; }
        });
        card.append(resume);
      }
    }
    if (first.batch_status === "cancelled") {
      // Say why when the batch was closed for the owner rather than by them.
      const reason = group.find((job) => job.status === "cancelled")?.error_code;
      const notes = {
        batch_expired: "Ye batch ek hafte mein poora nahi hua, isliye apne aap band ho gaya. Iski videos storage se hata di gayi.",
        connection_removed: "Is account ka connection hata diya gaya, isliye baaki Reels cancel ho gayi."
      };
      card.append(element("p", notes[reason] || "Ye batch cancel hai. Baaki Reels post nahi hongi."));
    }
    const cancellable = ["queued", "running", "paused"].includes(first.batch_status)
      && group.some((job) => ["queued", "creating", "processing"].includes(job.status));
    if (cancellable) {
      const cancel = element("button", "Cancel remaining reels", "job-action danger");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        const left = group.filter((job) => ["queued", "creating", "processing"].includes(job.status)).length;
        if (!window.confirm(`Is batch ki baaki ${left} Reel(s) cancel karein? Ye wapas start nahi hongi. Jo Reel is waqt publish ho rahi hai, wo nahi rukegi.`)) return;
        cancel.disabled = true;
        try {
          const { batch } = await api(`/api/batches/${first.batch_id}/cancel`, { method: "POST", body: "{}" });
          const stopped = batch.jobs.filter((job) => job.status === "cancelled").length;
          const still = batch.jobs.filter((job) => job.status === "publishing").length;
          notice(`${stopped} Reel(s) cancel ho gayi.${still ? " Ek Reel pehle hi publish ho rahi thi, wo post ho sakti hai." : ""}`);
          await refresh();
        } catch (error) { explain(error); cancel.disabled = false; }
      });
      card.append(cancel);
    }
    $("jobs").append(card);
  }
  for (const job of singles) {
    const card = element("article", undefined, "job-card");
    const head = element("div", undefined, "job-head");
    head.append(element("strong", `@${job.account}`), element("span", names[job.status] || job.status, `badge ${job.status}`));
    card.append(head, element("p", `${job.media_type === "image" ? "Photo" : "Reel"} · ${new Date(job.created_at).toLocaleString()}`));
    if (job.error_code) card.append(element("p", messages[job.error_code] || "History check karke request ka status dobara dekho."));
    if (job.published_media_id) card.append(element("p", `Published media: ${job.published_media_id}`));
    addAction(card, job);
    $("jobs").append(card);
  }
}
function frameStateText(job) {
  if (!job.frame_status || job.status === "cancelled") return "";
  if (job.frame_status === "pending") return "Frame: line mein hai, post hone se pehle lagega";
  if (job.frame_status === "rendering") return "Frame lag raha hai…";
  if (job.frame_status === "done") return `Frame laga ✓${job.frame_title ? ` · “${job.frame_title}”` : ""}`;
  return job.status === "queued" ? "Frame nahi lag paya, original video post hogi" : "Frame nahi lag paya, original video post hui";
}
function jobsPath(scope) {
  return scope === ALL_ACCOUNTS ? "/api/jobs" : `/api/jobs?connection_id=${encodeURIComponent(scope)}`;
}
function updatePolling() {
  // Keep refreshing while any account has Reels on the way, so counts stay live.
  const pending = jobs.some((job) => ["queued", "creating", "processing", "publishing"].includes(job.status))
    || progress.some((row) => row.scheduled_count > 0);
  if (pending && !pendingPollTimer) pendingPollTimer = setInterval(() => { void refresh().catch(explain); }, 30000);
  if (!pending && pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
}
// Activity for the picked account; a reply for an earlier pick is ignored.
async function loadJobs() {
  const scope = selectedAccount;
  const data = await api(jobsPath(scope));
  if (scope !== selectedAccount) return;
  jobs = data.jobs; jobsScope = scope;
  renderJobs(); updatePolling();
}
async function refresh() {
  const scope = selectedAccount;
  const [accountData, jobData, progressData, storageData] = await Promise.all([api("/api/accounts"), api(jobsPath(scope)), api("/api/progress"),
    api("/api/storage").catch(() => null)]);
  accounts = accountData.accounts; progress = progressData.progress; accountsLoaded = true;
  if (scope === selectedAccount) { jobs = jobData.jobs; jobsScope = scope; }
  storage = storageData?.storage || null;
  renderAccounts(); renderJobs(); updateFileSummary();
  clearTemporaryUnavailable();
  updatePolling();
  // The picked account changed meanwhile, or was disconnected (now all accounts).
  if (jobsScope !== selectedAccount) await loadJobs();
}
async function advance(id, automatic) {
  const data = await api(`/api/jobs/${id}/publish`, { method: "POST", body: "{}" });
  const index = jobs.findIndex((job) => job.id === id);
  if (index >= 0) jobs[index] = data.job; else jobs.unshift(data.job);
  renderJobs();
  if (data.job.status === "published") notice("Post publish hona confirm ho gaya.");
  if (automatic && data.job.status === "processing") {
    const count = (attempts.get(id) || 0) + 1; attempts.set(id, count);
    if (count < 5 && !timers.has(id)) {
      const wait = Math.max(60000, new Date(data.job.next_check_at).getTime() - Date.now() + 1000);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        advance(id, true).catch(explain);
      }, wait));
    }
  }
  return data.job;
}
async function requestKey(payload, salt = "") {
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(salt ? [payload, salt] : payload))))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Preserve retry identity after a lost response or page reload; no password,
  // token, caption or media URL is stored in browser storage.
  try {
    let saved = JSON.parse(localStorage.getItem("publisher-requests") || "[]");
    if (!Array.isArray(saved)) saved = [];
    const previous = saved.find((item) => item.fingerprint === fingerprint && /^[0-9a-f-]{36}$/.test(item.key));
    if (previous) return previous.key;
    const key = crypto.randomUUID();
    saved.push({ fingerprint, key });
    localStorage.setItem("publisher-requests", JSON.stringify(saved.slice(-100)));
    return key;
  } catch { throw { code: "browser_storage_required" }; }
}
messages.browser_storage_required = "Safe retry ke liye browser storage available honi chahiye. Normal Chrome tab mein website kholo.";

let fallbackBatchAttempt = null;
function batchAttemptId() {
  try {
    let value = sessionStorage.getItem("publisher-batch-attempt");
    if (!value) { value = crypto.randomUUID(); sessionStorage.setItem("publisher-batch-attempt", value); }
    return value;
  } catch {
    fallbackBatchAttempt ||= crypto.randomUUID();
    return fallbackBatchAttempt;
  }
}
function clearBatchAttempt() {
  fallbackBatchAttempt = null;
  try { sessionStorage.removeItem("publisher-batch-attempt"); } catch {}
}
function formatBytes(value) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function selectedFiles() { return [...($("reel-files").files || [])]; }
function storageText() {
  return storage ? `Storage: ${formatBytes(storage.used_bytes)} / ${formatBytes(storage.limit_bytes)} use, ${formatBytes(storage.free_bytes)} khaali.` : "";
}
function updateFileSummary() {
  const files = selectedFiles();
  if (!files.length) { $("file-summary").textContent = `1–20 MP4/MOV files. Har file 250 MB tak. ${storageText()}`.trim(); return; }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const room = storage ? ` · ${formatBytes(storage.free_bytes)} khaali` : "";
  $("file-summary").textContent = `${files.length} videos · total ${formatBytes(total)}${room} · ${files.map((file) => file.name).join(", ")}`;
}
function updatePublishMode() {
  const batch = $("upload-mode").value === "batch";
  $("batch-options").hidden = !batch;
  $("single-options").hidden = batch;
  $("reel-files").required = batch;
  $("media-url").required = !batch;
  $("caption").required = batch;
  $("confirm-label").textContent = batch
    ? "Maine account aur sab reels check ki hain. Ek caption ke saath batch schedule karo."
    : "Maine account aur content check kiya hai. Is post ko ab publish karna hai.";
  $("publish-button").firstChild.textContent = batch ? "Upload aur schedule batch " : "Publish post ";
}
// Videos over 45 MB go in 4 MB parts, so a big file never sits in the
// server's memory and a dropped connection only resends the missing parts.
async function uploadLargeAsset(file, attempt) {
  const key = await requestKey(["asset-parts", file.name, file.size, file.lastModified], attempt);
  const { upload } = await api("/api/assets/uploads", { method: "POST", headers: { "Idempotency-Key": key },
    body: JSON.stringify({ file_name: file.name, size: file.size }) });
  if (upload.complete) return upload;
  const partBytes = upload.part_bytes, count = Math.ceil(file.size / partBytes);
  const received = new Set(upload.parts_received);
  for (let part = 0; part < count; part++) {
    if (received.has(part)) continue;
    const body = file.slice(part * partBytes, Math.min(file.size, (part + 1) * partBytes));
    for (let retry = 0; ; retry++) {
      $("publish-progress").textContent = `${file.name}: ${Math.floor((part / count) * 100)}% upload hua… page band mat karo.`;
      let response;
      try {
        response = await fetch(`/api/assets/uploads/${encodeURIComponent(upload.asset_id)}/parts/${part}`, { method: "PUT", credentials: "same-origin",
          headers: { "Content-Type": "application/octet-stream" }, body, signal: AbortSignal.timeout(120000) });
      } catch (error) {
        if (retry < 5) { await new Promise((resolve) => setTimeout(resolve, [3000, 6000, 10000, 15000, 20000][retry])); continue; }
        throw { code: error?.name === "TimeoutError" ? "upload_timeout" : "upload_network_unreachable" };
      }
      if (response.ok) break;
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && data.error === "sign_in_required") showSignedOut();
      // Resending a part replaces it, so retrying after a server hiccup is safe.
      if ((response.status >= 500 || response.status === 429) && retry < 5) {
        await new Promise((resolve) => setTimeout(resolve, [3000, 6000, 10000, 15000, 20000][retry]));
        continue;
      }
      throw { code: data.error || "temporarily_unavailable" };
    }
  }
  $("publish-progress").textContent = `${file.name}: 100% upload hua, check ho raha hai…`;
  const { asset } = await api(`/api/assets/uploads/${encodeURIComponent(upload.asset_id)}/complete`, { method: "POST", body: "{}" });
  return asset;
}
async function uploadAsset(file, attempt) {
  if (file.size > 45 * 1024 * 1024) return uploadLargeAsset(file, attempt);
  const key = await requestKey(["asset", file.name, file.size, file.lastModified], attempt);
  const maxRecoveryChecks = 31;
  async function waitForDatabaseRecovery() {
    for (let check = 0; check < maxRecoveryChecks; check++) {
      const delay = check === 0 ? 5000 : 10000;
      $("publish-progress").textContent = `${file.name} ka upload confirm nahi hua. Server status check ${check + 1}/${maxRecoveryChecks}; page khula rakho, button dobara mat dabao.`;
      await new Promise((resolve) => setTimeout(resolve, delay));
      let readiness;
      try {
        // /ready actively reinitializes the database after a transient outage.
        // /health only reports the process-local readiness flag and cannot recover it.
        readiness = await fetch("/ready", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000) });
      } catch {
        // A browser/network failure is not evidence that Postgres is recovering.
        throw { code: "upload_network_unreachable" };
      }
      const status = await readiness.json().catch(() => ({}));
      if (readiness.ok && status.ok === true) return true;
      if (readiness.status !== 503) throw { code: "temporarily_unavailable" };
    }
    throw { code: "upload_recovery_timeout" };
  }
  for (let retry = 0; ; retry++) {
    let response;
    try {
      response = await fetch("/api/assets", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "Idempotency-Key": key },
        body: file, signal: AbortSignal.timeout(180000) });
    } catch (error) {
      if (retry < 2) {
        await waitForDatabaseRecovery();
        continue;
      }
      throw { code: error?.name === "TimeoutError" ? "upload_timeout" : "upload_network_unreachable" };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && data.error === "sign_in_required") showSignedOut();
      const code = data.error || "temporarily_unavailable";
      // Retry only after the service reports ready, preserving the same asset idempotency key.
      if (response.status >= 500 && code === "temporarily_unavailable" && retry < 2) {
        await waitForDatabaseRecovery();
        continue;
      }
      throw { code };
    }
    return data.asset;
  }
}
async function boot() {
  try {
    const session = await api("/api/session");
    $("loading").hidden = true;
    $("setup").hidden = session.ready;
    $("signin").hidden = !session.ready || session.authenticated;
    $("workspace").hidden = !session.authenticated;
    $("logout").hidden = !session.authenticated;
    $("independence").hidden = Boolean(session.authenticated);
    for (const provider of ["facebook", "instagram"]) {
      const link = $(`connect-${provider}`);
      link.setAttribute("aria-disabled", String(!session.providers[provider]));
      if (session.providers[provider]) link.removeAttribute("tabindex"); else link.setAttribute("tabindex", "-1");
    }
    if (session.authenticated) { showView(startView); await refresh(); }
  } catch (error) { $("loading").hidden = true; $("setup").hidden = false; explain(error); }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("login-button").disabled = true;
  try { await api("/auth/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) }); $("password").value = ""; $("message").hidden = true; lastNoticeCode = null; await boot(); }
  catch (error) { explain(error); }
  finally { $("login-button").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
    for (const timer of timers.values()) clearTimeout(timer); timers.clear();
    if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
    accounts = []; jobs = []; progress = []; accountsLoaded = false; jobsScope = null;
    frameSettings.clear(); frameEditors.clear(); captionEditors.clear(); renderAccounts(); renderJobs();
    dmState = null; checkState = null; dmProfilesLoaded = false; dmOpen.clear(); dmTargets.clear(); renderDm(); renderChecks();
    $("publish-form").reset(); await boot();
  } catch (error) { explain(error); }
});
$("reload").addEventListener("click", () => refresh().catch(explain));
$("setup-retry").addEventListener("click", () => boot());
$("account-filter").addEventListener("change", () => selectAccount($("account-filter").value));
$("account").addEventListener("change", () => { if ($("account").value) selectAccount($("account").value); });
for (const view of VIEWS) $(`tab-${view}`).addEventListener("click", () => showView(view));
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const current = VIEWS.findIndex((view) => $(`tab-${view}`).getAttribute("aria-selected") === "true");
  const next = event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length;
  event.preventDefault();
  showView(VIEWS[next]); $(`tab-${VIEWS[next]}`).focus();
});
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (VIEWS.includes(view) && !$("workspace").hidden) showView(view);
});
$("caption").addEventListener("input", (event) => {
  if (event.isTrusted) {
    captionTouched = true;
    const id = $("account").value;
    if (id && frameSettings.has(id)) updateCaptionDefault(frameSettings.get(id));
  }
  const length = [...$("caption").value].length;
  $("caption-count").textContent = `${length} / 2200`;
  $("caption").setCustomValidity(length > 2200 ? "Caption 2200 characters se chhota rakho." : "");
});
$("upload-mode").addEventListener("change", updatePublishMode);
$("caption-use-default").addEventListener("click", () => {
  const settings = frameSettings.get($("account").value);
  if (!settings) return;
  setCaption(settings.default_caption || ""); updateCaptionDefault(settings);
});
$("caption-save-default").addEventListener("click", async () => {
  const id = $("account").value;
  if (!id) return;
  const button = $("caption-save-default"); button.disabled = true;
  try {
    const { frame } = await api(`/api/accounts/${encodeURIComponent(id)}/frame`, { method: "PUT", body: JSON.stringify({ default_caption: $("caption").value }) });
    frameSettings.set(id, frame); captionTouched = false; updateCaptionDefault(frame);
    const account = accounts.find((item) => item.connection_id === id);
    notice(`${account ? `@${accountName(account)}` : "Account"} ka default caption save ho gaya. Agli baar ye apne aap lagega.`);
    refreshCaptionEditor(id);
  } catch (error) { explain(error); }
  finally { button.disabled = false; }
});
$("frame-enabled").addEventListener("change", () => { frameTouched = true; updateFrameExtra(); });
$("reel-files").addEventListener("change", updateFileSummary);
updatePublishMode();
$("publish-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  // Lock in the account now: switching accounts during the upload must not
  // move this batch to another account.
  const accountId = $("account").value;
  busy = true; busyAccount = accountId; $("publish-button").disabled = true; $("account").disabled = true;
  let batchScheduled = false;
  $("publish-progress").textContent = "Upload aur batch save complete hone tak page khula rakho. Uske baad phone band kar sakte ho.";
  try {
    if ($("upload-mode").value === "batch") {
      const files = selectedFiles();
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (files.length < 1 || files.length > 20 || files.some((file) => file.size > 250 * 1024 * 1024)) {
        throw { code: files.some((file) => file.size > 250 * 1024 * 1024) ? "upload_too_large" : "invalid_batch" };
      }
      // Check free space first so a too-large selection uploads nothing.
      // Uploads not yet in a batch are usually this same attempt's earlier
      // files, which are not stored twice, so they count as available here.
      const latest = await api("/api/storage").then((data) => data.storage).catch(() => null);
      if (latest) {
        storage = latest; updateFileSummary();
        if (totalBytes > latest.free_bytes + latest.unbatched_bytes) {
          throw { code: "upload_storage_full", detail: `Storage mein abhi ${formatBytes(latest.free_bytes)} khaali hai, aur chuni hui videos ${formatBytes(totalBytes)} ki hain. Kam videos chuno, ya queue ki Reels post hone do; har Reel post hote hi uski jagah khaali hoti hai.` };
        }
      }
      const attempt = batchAttemptId();
      const assetIds = [];
      for (let index = 0; index < files.length; index++) {
        $("publish-progress").textContent = `Video ${index + 1}/${files.length} upload ho rahi hai… upload ke dauran page band mat karo.`;
        const asset = await uploadAsset(files[index], attempt);
        assetIds.push(asset.asset_id);
      }
      const payload = { connection_id: accountId, caption: $("caption").value,
        interval_minutes: Number($("interval-minutes").value), asset_ids: assetIds };
      if ($("frame-enabled").checked) Object.assign(payload, { frame: true, frame_title: $("frame-title").value.trim().slice(0, 60) });
      const key = await requestKey(["batch", payload], attempt);
      $("publish-progress").textContent = "Batch server par save ho rahi hai… page khula rakho; button dobara mat dabao.";
      await api("/api/batches", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) });
      batchScheduled = true;
      clearBatchAttempt();
      $("publish-progress").textContent = "Batch queue mein save hai. Pehli Reel process hogi; baaki chune hue gap par. Ab phone band kar sakte ho—service schedule ko background mein process karegi.";
      $("publish-form").reset(); updateFileSummary(); updatePublishMode();
      frameTouched = false; captionTouched = false; void syncFrameChoice();
      notice("Batch queue mein save ho gayi. Pehli Reel abhi process hogi, baaki chune hue gap par. Ab phone band kar sakte ho.");
      selectAccount(accountId); showView("activity");
      await refresh();
    } else {
      const type = $("media-type").value;
      const payload = { connection_id: accountId, caption: $("caption").value,
        [type === "image" ? "image_url" : "video_url"]: $("media-url").value.trim() };
      const key = await requestKey([type, payload]);
      const { job } = await api(`/api/publish/${type === "image" ? "image" : "reels"}`, {
        method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload)
      });
      selectAccount(accountId); showView("activity");
      await refresh();
      if (job.status === "processing") await advance(job.id, true);
      $("publish-progress").textContent = "Request History mein save hai. Processing ke liye page khula rakho, ya baad mein Check & finish dabao.";
    }
    $("confirm-publish").checked = false;
  } catch (error) {
    explain(error);
    $("publish-progress").textContent = batchScheduled
      ? "Batch save ho gayi hai. History refresh nahi hui—button dobara dabane se pehle Refresh check karo."
      : (error?.detail || messages[error?.code] || "Batch schedule confirm nahi hui. Activity/History check karo; pending entry na ho tabhi dobara submit karo.");
  }
  finally { busy = false; busyAccount = null; renderAccounts(); }
});

// ---- DM Sender: messages creators who asked for promotion details, from the
// owner's own Instagram account (a Browser Use profile), one at a time.
const DM_DEFAULT_MESSAGE = "Hey! 👋 We're inviting Instagram page owners to join our Paid Logo Promotion Program! 💰 Earn ₹800 per 1 Million Views 💸 Weekly Payments 🚀 No Earning Limit 🎬 Keep Posting Your Regular Reels 📱 Multiple Instagram Pages Allowed Simply add our promotional logo to your Reels and earn based on your eligible views. We also have a dedicated bot for Reel submissions and view tracking. Interested? Reply YES and I'll share the details!";
const DM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DM_GAPS = [3, 5, 7, 9, 10, 12, 15, 20, 30, 45, 60];
const DM_BADGES = { running: "CHAL RAHA", paused: "RUKA HUA", completed: "POORA" };
const DM_TARGET_BADGES = { pending: "BAAKI", sending: "BHEJ RAHA", sent: "BHEJA", skipped: "SKIP", failed: "FAILED" };
const DM_PAUSES = {
  not_started: "Abhi shuru nahi hua. Pehle “Pehle 5 (test)” chunkar Start dabao.",
  owner: "Aapne pause kiya hai.",
  test_done: "Test poora hua. Instagram app mein ye DMs check karo; sab theek ho to “Sab baaki” chunkar Start dabao.",
  action_blocked: "Instagram ne warning di, isliye campaign ruk gaya. Kam se kam 24 ghante ruko, Instagram app mein account check karo, phir gap badhakar Start karo.",
  logged_out: "Is profile mein Instagram login nahi mila. Browser Use profile mein dobara login karo, phir Start.",
  challenge: "Instagram security check maang raha hai. Instagram app mein khud verify karo, phir Start.",
  too_many_errors: "Lagatar 3 DM fail hue, isliye ruk gaya. List kholkar wajah dekho."
};
const DM_PROBLEMS = new Set(["action_blocked", "logged_out", "challenge", "too_many_errors", "browser_use_key_invalid", "browser_use_no_credits", "browser_use_not_found"]);
const DM_REASONS = {
  already_in_thread: "Chat mein ye message pehle se hai",
  already_contacted: "Pehle kisi campaign se DM ja chuka",
  not_found: "Account nahi mila",
  no_message_button: "Message button nahi hai (DM band)",
  blocked_after_send: "Bhejte waqt Instagram warning aayi",
  profile_timeout: "Profile load nahi hui",
  message_button_lost: "Message button nahi dab paya",
  chat_not_opened: "Chat nahi khuli",
  chat_ambiguous: "Sahi chat pehchan nahi payi",
  focus_failed: "Message box nahi mila",
  typing_failed: "Message type nahi ho paya",
  send_unconfirmed: "Gaya ya nahi, confirm nahi hua · Instagram mein check karo",
  browser_lost: "Browser connection toot gaya",
  page_error: "Page mein error aaya"
};
Object.assign(messages, {
  dm_not_configured: "DM Sender ke liye Browser Use key set nahi hai. Render → Environment mein BROWSER_USE_API_KEY daalo (key kisi chat mein mat bhejo).",
  invalid_campaign: "Naam (60 akshar tak), profile, message (har version 1000 akshar tak, 10 versions tak), roz ki limit 1–200, gap 2–60 minute aur shuru/band ka alag time check karo.",
  contact_not_confirmed: "Neeche wala box tick karo: message sirf unhe jayega jinhone khud promotion ke liye comment/request kiya.",
  invalid_usernames: "Koi sahi Instagram username nahi mila. Ek line mein ek username ya profile link daalo.",
  too_many_usernames: "Ek campaign mein 2,000 se zyada creators nahi aa sakte.",
  profile_busy: "Is Instagram account ka doosra campaign already chal raha hai. Pehle use Pause karo.",
  nothing_to_send: "Is campaign mein bhejne ko koi creator nahi bacha.",
  campaign_running: "Chalte campaign ko badal ya delete nahi kar sakte. Pehle Pause karo.",
  campaign_not_found: "Campaign nahi mila. Refresh karo.",
  browser_use_key_invalid: "Browser Use ne API key reject ki. Render mein BROWSER_USE_API_KEY check karo.",
  browser_use_no_credits: "Browser Use account mein credits khatam ho gaye. Credits add karke Start karo.",
  browser_use_not_found: "Browser Use mein ye profile nahi mila. Campaign ka profile check karo.",
  browser_use_busy: "Browser Use abhi busy hai. Thodi der baad try karo.",
  browser_use_failed: "Browser Use se sahi jawab nahi mila. Thodi der baad try karo.",
  browser_use_unreachable: "Browser Use tak connection nahi hua. Thodi der baad try karo."
});
let dmState = null;
let dmLoading = null;
let dmPollTimer = null;
let dmProfilesLoaded = false;
let dmMessageTouched = false;
const dmOpen = new Map();
const dmTargets = new Map();

function rupees(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function hourLabel(hour) { return hour === 24 ? "24:00 (raat 12)" : `${String(hour).padStart(2, "0")}:00`; }
function dmPerDay(limit, gap, start, end) {
  const hours = (((end - start) % 24) + 24) % 24 || 24;
  return Math.max(1, Math.min(limit, Math.floor((hours * 60) / gap)));
}
function dmGapSelect(value) {
  const gaps = [...new Set([...DM_GAPS, value])].sort((a, b) => a - b);
  return frameSelect(gaps.map((gap) => [gap, gap === 60 ? "1 ghanta" : `${gap} minute`]), value);
}
function dmHourSelect(from, to, value) {
  const hours = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  return frameSelect(hours.map((hour) => [hour, hourLabel(hour)]), value);
}
const DM_PROXIES = [["in", "India proxy (data paid)"], ["none", "Bina proxy (sasta)"]];
const DM_PROXY_NOTES = {
  in: "Instagram ko login India se dikhta hai. Har DM pe Instagram ka page proxy se aata hai, jiska data ka kharcha lagta hai.",
  none: "Data ka kharcha nahi, sirf browser ka time. Instagram ko login doosre desh se dikhega, isliye wo security check maang sakta hai; tab campaign ruk jayega aur Instagram app mein “It was me” dabana hoga."
};
function proxyLabel(proxy) { return proxy === "none" ? "Bina proxy" : proxy === "in" ? "India proxy" : `${proxy.toUpperCase()} proxy`; }
function dmProxySelect(value) {
  const options = DM_PROXIES.some(([code]) => code === value) ? DM_PROXIES : [...DM_PROXIES, [value, proxyLabel(value)]];
  return frameSelect(options, value);
}
function fillSelect(target, source) {
  const value = source.value;
  target.replaceChildren(...source.options);
  target.value = value;
}

async function loadDm() {
  dmLoading ||= api("/api/dm").finally(() => { dmLoading = null; });
  dmState = await dmLoading;
  const latest = dmState.campaigns[0];
  if (!dmMessageTouched) { $("dm-message").value = latest?.message || DM_DEFAULT_MESSAGE; updateDmCounts(); }
  renderDm();
  clearTemporaryUnavailable();
  if (dmState.configured && !dmProfilesLoaded && $("dm-new").open) void loadDmProfiles();
  void loadChecks().catch(() => {});
}
function renderDm() {
  const list = $("dm-campaigns");
  list.replaceChildren();
  $("dm-setup").hidden = !dmState || dmState.configured;
  if (dmState) {
    if (!dmState.campaigns.length) list.append(element("p", "Abhi koi campaign nahi hai. Neeche “Naya DM campaign” kholo.", "empty"));
    for (const campaign of dmState.campaigns) list.append(dmCard(campaign));
  }
  updateDmPolling();
}
// While a campaign runs, its card refreshes every 20 seconds (only on this tab).
function updateDmPolling() {
  const active = !$("dms").hidden && !$("workspace").hidden && (Boolean(dmState?.campaigns.some((campaign) => campaign.status === "running")) ||
    Boolean(checkState?.checks.some((check) => check.status === "running")));
  if (active && !dmPollTimer) {
    dmPollTimer = setInterval(() => {
      if ($("workspace").hidden || $("dms").hidden) { updateDmPolling(); return; }
      // Don't redraw the cards while the owner is typing in one of them.
      const focused = document.activeElement;
      if (focused && $("dm-campaigns").contains(focused) && focused.matches("input, textarea, select")) return;
      void loadDm().catch(explain);
    }, 20000);
  }
  if (!active && dmPollTimer) { clearInterval(dmPollTimer); dmPollTimer = null; }
}
async function dmAction(button, path, body, done) {
  button.disabled = true;
  try {
    const data = await api(path, { method: body === null ? "DELETE" : "POST", ...(body === null ? {} : { body: JSON.stringify(body) }) });
    if (done) done(data);
    await loadDm();
  } catch (error) { explain(error); button.disabled = false; }
}
function dmCard(campaign) {
  const counts = campaign.counts;
  const card = element("article", undefined, "job-card dm-card");
  const head = element("div", undefined, "job-head");
  head.append(element("strong", campaign.name), element("span", DM_BADGES[campaign.status] || campaign.status, `badge ${campaign.status}`));
  const who = campaign.profile_name || `Profile ${campaign.profile_id.slice(0, 8)}`;
  card.append(head, element("p", `${who} · ${campaign.daily_limit}/din · ${campaign.gap_minutes} min gap · ${hourLabel(campaign.start_hour)}–${hourLabel(campaign.end_hour)} · ${proxyLabel(campaign.proxy || "in")}`, "job-meta"));

  const progress = element("section", undefined, "batch-progress");
  const heading = element("div", undefined, "batch-progress-heading");
  heading.append(element("strong", `${counts.sent}/${counts.total} ko DM gaya`), element("span", `${counts.pending} baaki`));
  const bar = document.createElement("progress");
  bar.className = "progress-bar"; bar.max = Math.max(1, counts.total); bar.value = counts.total - counts.pending;
  bar.setAttribute("aria-label", `${counts.sent} of ${counts.total} messaged`);
  progress.append(heading, bar);
  const stats = element("div", undefined, "stats");
  for (const [value, label, tone] of [[counts.sent, "Bheje", "good"], [counts.pending, "Baaki", ""], [counts.skipped, "Skip", ""], [counts.failed, "Failed", counts.failed ? "bad" : ""]]) {
    const stat = element("div", undefined, tone ? `stat ${tone}` : "stat");
    stat.append(element("strong", String(value)), element("span", label));
    stats.append(stat);
  }
  card.append(progress, stats);

  if (campaign.status === "running") {
    const parts = [`Aaj ${counts.sent_today}/${campaign.daily_limit}`];
    if (campaign.next_send_at) parts.push(`Agla DM: ${formatWhen(campaign.next_send_at)}`);
    if (campaign.stop_after) parts.push(`Test: ${campaign.sent_since_start}/${campaign.stop_after}`);
    card.append(element("p", parts.join(" · "), "next-reel"));
  } else if (counts.sent_today) {
    card.append(element("p", `Aaj ${counts.sent_today}/${campaign.daily_limit} DM gaye.`));
  }
  const cost = campaign.cost;
  card.append(element("p", `Kharcha: ${rupees(cost.inr)}${cost.per_dm_inr !== null ? ` · ${rupees(cost.per_dm_inr)} har DM` : ""} · ${cost.proxy_mb} MB data${campaign.browser_active ? " · browser abhi khula hai" : ""}`, "dm-cost"));
  if (campaign.status === "paused" && campaign.pause_reason) {
    const text = DM_PAUSES[campaign.pause_reason] || messages[campaign.pause_reason] || "Campaign ruka hua hai.";
    const detail = campaign.pause_detail ? ` Instagram ne likha: “${campaign.pause_detail}”` : "";
    card.append(element("p", text + detail, DM_PROBLEMS.has(campaign.pause_reason) ? "batch-error" : ""));
  }
  if (campaign.status === "completed") card.append(element("p", "Poori list ho gayi. Aur creators list kholkar jod sakte ho."));

  const actions = element("div", undefined, "dm-actions");
  if (campaign.status === "running") {
    const pause = element("button", "Pause karo", "quiet strong"); pause.type = "button";
    pause.addEventListener("click", () => dmAction(pause, `/api/dm/campaigns/${campaign.id}/pause`, {},
      () => notice("Campaign pause ho gaya. Jo DM is waqt ja raha tha, wo poora ho sakta hai.")));
    actions.append(pause);
  } else if (counts.pending) {
    const amount = frameSelect([[5, "Pehle 5 (test)"], [10, "Sirf 10"], [25, "Sirf 25"], [50, "Sirf 50"], ["", `Sab baaki (${counts.pending})`]], counts.sent ? "" : 5);
    amount.className = "dm-amount"; amount.setAttribute("aria-label", "Kitne DM bhejne hain");
    const start = element("button", "Start", "quiet strong"); start.type = "button"; start.disabled = !dmState.configured;
    start.addEventListener("click", () => {
      const stopAfter = amount.value ? Number(amount.value) : null;
      if (!stopAfter && !confirm(`${counts.pending} creators ko DM jayenge: roz maximum ${campaign.daily_limit}, har ~${campaign.gap_minutes} minute mein ek. Start karein?`)) return;
      void dmAction(start, `/api/dm/campaigns/${campaign.id}/start`, { stop_after: stopAfter },
        () => notice(stopAfter ? `Start ho gaya: ${stopAfter} DM ke baad apne aap rukega. Pehla DM ek-do minute mein jayega.` : "Start ho gaya. Page band kar sakte ho, DM server se jaate rahenge."));
    });
    actions.append(amount, start);
  }
  if (campaign.status !== "running" && counts.failed) {
    const retry = element("button", "Failed wale dobara list mein", "quiet"); retry.type = "button";
    retry.addEventListener("click", () => dmAction(retry, `/api/dm/campaigns/${campaign.id}/retry-failed`, {},
      (data) => notice(`${data.retried} creators wapas list mein. Start dabao; jinke chat mein message pehle se hai, unhe dobara nahi jayega.`)));
    actions.append(retry);
  }
  if (campaign.status !== "running") {
    const remove = element("button", "Delete", "quiet danger"); remove.type = "button";
    remove.addEventListener("click", () => {
      if (!confirm(`“${campaign.name}” campaign aur uski list delete karni hai? Jo DM ja chuke hain, wo Instagram pe rahenge.`)) return;
      void dmAction(remove, `/api/dm/campaigns/${campaign.id}`, null, () => { dmOpen.delete(campaign.id); dmTargets.delete(campaign.id); });
    });
    actions.append(remove);
  }
  card.append(actions);

  const details = element("details", undefined, "batch-details");
  details.open = dmOpen.get(campaign.id) || false;
  details.append(element("summary", `Message aur creators ki list (${counts.total})`));
  const body = element("div", undefined, "dm-detail");
  details.append(body);
  details.addEventListener("toggle", () => { dmOpen.set(campaign.id, details.open); if (details.open) void loadDmDetail(body, campaign); });
  if (details.open) void loadDmDetail(body, campaign);
  card.append(details);
  return card;
}
async function loadDmDetail(body, campaign) {
  const cached = dmTargets.get(campaign.id);
  renderDmDetail(body, campaign, cached);
  try {
    const data = await api(`/api/dm/campaigns/${encodeURIComponent(campaign.id)}`);
    dmTargets.set(campaign.id, data.targets);
    if (body.isConnected) renderDmDetail(body, data.campaign, data.targets);
  } catch (error) {
    if (!cached && body.isConnected) body.replaceChildren(element("p", messages[error?.code] || "List load nahi hui. Dobara kholo.", "hint"));
  }
}
function renderDmDetail(body, campaign, targets) {
  body.replaceChildren(element("p", "Message", "dm-label"), element("p", campaign.message, "dm-message"));
  if (!targets) body.append(element("p", "List load ho rahi hai…", "hint"));
  else {
    const list = element("div", undefined, "dm-targets");
    for (const target of targets) {
      const row = element("div", undefined, "dm-target");
      const left = element("span");
      const link = element("a", `@${target.username}`);
      link.href = `https://www.instagram.com/${encodeURIComponent(target.username)}/`; link.target = "_blank"; link.rel = "noopener noreferrer";
      left.append(link);
      const note = target.status === "sent" && target.sent_at ? `Bheja: ${formatWhen(target.sent_at)}`
        : target.reason ? DM_REASONS[target.reason] || messages[target.reason] || target.reason : "";
      if (note) left.append(element("small", note));
      row.append(left, element("span", DM_TARGET_BADGES[target.status] || target.status, `badge ${target.status}`));
      list.append(row);
    }
    body.append(list);
  }

  const add = document.createElement("textarea");
  add.id = `dm-add-${campaign.id}`; add.rows = 3; add.spellcheck = false;
  add.placeholder = "Aur usernames ya profile links, ek line mein ek";
  const addLabel = element("label", "Aur creators jodo"); addLabel.htmlFor = add.id;
  const addButton = element("button", "List mein jodo", "quiet strong"); addButton.type = "button";
  const addButtons = element("div", undefined, "frame-buttons"); addButtons.append(addButton);
  addButton.addEventListener("click", async () => {
    if (!add.value.trim()) return;
    addButton.disabled = true;
    try {
      const data = await api(`/api/dm/campaigns/${campaign.id}/targets`, { method: "POST", body: JSON.stringify({ usernames: add.value }) });
      const parts = [`${data.added} naye jode`];
      if (data.already_listed) parts.push(`${data.already_listed} pehle se list mein`);
      if (data.already_contacted) parts.push(`${data.already_contacted} ko pehle hi DM ja chuka`);
      if (data.invalid.length) parts.push(`${data.invalid.length} galat: ${data.invalid.slice(0, 5).join(", ")}`);
      notice(`${parts.join(" · ")}.`);
      dmTargets.delete(campaign.id);
      await loadDm();
    } catch (error) { explain(error); addButton.disabled = false; }
  });
  body.append(addLabel, add, addButtons);
  if (campaign.status !== "running") body.append(dmSettingsEditor(campaign));
}
function dmSettingsEditor(campaign) {
  const details = element("details", undefined, "frame-settings");
  details.append(element("summary", "Message ya speed badlo"));
  const form = element("div", undefined, "frame-form");
  const message = document.createElement("textarea");
  message.id = `dm-edit-message-${campaign.id}`; message.rows = 5; message.maxLength = 5000; message.value = campaign.message;
  const messageLabel = element("label", "Message"); messageLabel.htmlFor = message.id;
  const limit = document.createElement("input");
  limit.type = "number"; limit.min = "1"; limit.max = "200"; limit.step = "1"; limit.value = String(campaign.daily_limit);
  const gap = dmGapSelect(campaign.gap_minutes);
  const start = dmHourSelect(0, 23, campaign.start_hour);
  const end = dmHourSelect(1, 24, campaign.end_hour);
  const proxy = dmProxySelect(campaign.proxy || "in");
  const fields = element("div", undefined, "frame-fields");
  for (const [text, input] of [["Roz ke maximum DM", limit], ["Gap", gap], ["Kab se", start], ["Kab tak", end]]) {
    const label = element("label", text); label.append(input); fields.append(label);
  }
  const proxyLabelNode = element("label", "Internet connection"); proxyLabelNode.append(proxy);
  const proxyNote = element("p", DM_PROXY_NOTES[proxy.value] || "", "hint");
  proxy.addEventListener("change", () => { proxyNote.textContent = DM_PROXY_NOTES[proxy.value] || ""; });
  const save = element("button", "Save karo", "quiet strong"); save.type = "button";
  const buttons = element("div", undefined, "frame-buttons"); buttons.append(save);
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api(`/api/dm/campaigns/${campaign.id}`, { method: "PUT", body: JSON.stringify({
        message: message.value, daily_limit: Number(limit.value), gap_minutes: Number(gap.value),
        start_hour: Number(start.value), end_hour: Number(end.value), proxy: proxy.value }) });
      notice(`“${campaign.name}” ki settings save ho gayi.`);
      await loadDm();
    } catch (error) { explain(error); save.disabled = false; }
  });
  form.append(messageLabel, message, fields, proxyLabelNode, proxyNote, buttons);
  details.append(form);
  return details;
}

async function loadDmProfiles() {
  const select = $("dm-profile");
  const keep = select.value;
  let profiles = [];
  let failed = false;
  try { profiles = (await api("/api/dm/profiles")).profiles; } catch { failed = true; }
  select.replaceChildren(element("option", profiles.length ? "Profile chuno" : failed ? "Profiles load nahi hui · ID khud daalo" : "Koi profile nahi mili · ID khud daalo"));
  select.firstChild.value = "";
  for (const profile of profiles) {
    const option = element("option", `${profile.name || "Profile"} · ${profile.id.slice(0, 8)}`);
    option.value = profile.id; option.dataset.name = profile.name || "";
    select.append(option);
  }
  const manual = element("option", "Profile ID khud daalo…"); manual.value = "manual";
  select.append(manual);
  select.value = [...select.options].some((option) => option.value === keep && keep) ? keep : profiles.length === 1 ? profiles[0].id : "";
  dmProfilesLoaded = !failed;
  updateDmProfile();
}
function updateDmProfile() {
  const manual = $("dm-profile").value === "manual";
  $("dm-profile-manual").hidden = !manual;
  $("dm-profile-id").required = manual;
}
function countEntries(text) {
  return new Set(text.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)).size;
}
function updateDmCounts() {
  const versions = $("dm-message").value.split(/\n[ \t]*-{3,}[ \t]*(?:\n|$)/).map((part) => part.trim()).filter(Boolean);
  const longest = Math.max(0, ...versions.map((part) => [...part].length));
  $("dm-message-count").textContent = `${versions.length} version${versions.length === 1 ? "" : "s"} · sabse lamba ${longest}/1000`;
  const entries = countEntries($("dm-usernames").value);
  $("dm-usernames-count").textContent = entries
    ? `${entries} entries · duplicate aur galat entries save karte waqt hat jayengi. Jinhe pehle DM ja chuka hai, unhe dobara nahi jayega.`
    : "Duplicate apne aap hat jayenge. Jinhe pehle kisi campaign se message ja chuka hai, unhe dobara nahi jayega.";
  const limit = Math.min(200, Math.max(1, Number($("dm-limit").value) || 1));
  const gap = Number($("dm-gap").value), start = Number($("dm-start").value), end = Number($("dm-end").value);
  if (start === end % 24) { $("dm-estimate").textContent = "Shuru aur band ka time alag rakho."; return; }
  const perDay = dmPerDay(limit, gap, start, end);
  $("dm-estimate").textContent = `≈ ${perDay} DM roz (${hourLabel(start)}–${hourLabel(end)} India time, har ~${gap} minute mein ek).`
    + (entries ? ` ${entries} creators ≈ ${Math.ceil(entries / perDay)} din.` : "");
}
fillSelect($("dm-gap"), dmGapSelect(9));
fillSelect($("dm-start"), dmHourSelect(0, 23, 8));
fillSelect($("dm-end"), dmHourSelect(1, 24, 23));
$("dm-message").value = DM_DEFAULT_MESSAGE;
updateDmCounts();
$("dm-message").addEventListener("input", () => { dmMessageTouched = true; updateDmCounts(); });
for (const id of ["dm-usernames", "dm-limit", "dm-gap", "dm-start", "dm-end"]) $(id).addEventListener("input", updateDmCounts);
$("dm-profile").addEventListener("change", updateDmProfile);
const showDmProxyNote = () => { $("dm-proxy-note").textContent = DM_PROXY_NOTES[$("dm-proxy").value] || ""; };
$("dm-proxy").addEventListener("change", showDmProxyNote);
showDmProxyNote();
$("dm-new").addEventListener("toggle", () => { if ($("dm-new").open && !dmProfilesLoaded) void loadDmProfiles(); });
$("dm-reload").addEventListener("click", () => { dmProfilesLoaded = false; loadDm().catch(explain); });
$("dm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const select = $("dm-profile");
  const manual = select.value === "manual";
  const profileId = (manual ? $("dm-profile-id").value : select.value).trim();
  if (!DM_UUID.test(profileId)) { notice("Browser Use profile chuno, ya uski poori ID (36 akshar) daalo.", true); return; }
  const button = $("dm-save"); button.disabled = true;
  try {
    const data = await api("/api/dm/campaigns", { method: "POST", body: JSON.stringify({
      name: $("dm-name").value.trim(), profile_id: profileId, profile_name: manual ? null : select.selectedOptions[0]?.dataset.name || null,
      message: $("dm-message").value, usernames: $("dm-usernames").value,
      daily_limit: Number($("dm-limit").value), gap_minutes: Number($("dm-gap").value),
      start_hour: Number($("dm-start").value), end_hour: Number($("dm-end").value), proxy: $("dm-proxy").value,
      requested_contact: $("dm-consent").checked
    }) });
    const parts = [`${data.added} creators list mein`];
    if (data.already_contacted) parts.push(`${data.already_contacted} ko pehle hi DM ja chuka (skip)`);
    if (data.invalid.length) parts.push(`${data.invalid.length} galat entries chhodi: ${data.invalid.slice(0, 5).join(", ")}`);
    notice(`Campaign save ho gaya: ${parts.join(" · ")}. Ab card pe “Pehle 5 (test)” chunkar Start dabao.`);
    $("dm-name").value = ""; $("dm-usernames").value = ""; $("dm-consent").checked = false;
    $("dm-new").open = false;
    updateDmCounts();
    await loadDm();
  } catch (error) { explain(error); }
  finally { button.disabled = false; }
});
// ---- Creator list check: which usernames still exist and post recently ----
Object.assign(messages, {
  invalid_check: "List ka naam (60 akshar tak) aur 1–365 din daalo.",
  check_not_found: "Ye list check nahi mila. Refresh karo."
});
const CHECK_PAUSES = {
  owner: "Aapne roka hai.",
  permission_required: "Facebook wali permission chahiye. Upar “Facebook se permission do” dabao, phir Start.",
  reconnect_required: "Facebook connection ka login expire ho gaya. Upar wale button se dobara connect karo, phir Start.",
  token_storage_unavailable: "Saved connection padha nahi ja raha. Setup check karna hoga.",
  too_many_not_found: "Lagatar 40 naam “nahi mile” aaye. Kuch gadbad lagti hai, check ruka hai."
};
let checkState = null;
let checkFileText = "";
async function loadChecks() {
  checkState = await api("/api/checks");
  renderChecks();
}
function checkCard(check) {
  const counts = check.counts;
  const card = element("article", undefined, "job-card");
  const head = element("div", undefined, "job-head");
  const badge = { running: ["CHAL RAHA", "running"], paused: ["RUKA HUA", "paused"], done: ["POORA", "completed"] }[check.status] || [check.status, ""];
  head.append(element("strong", check.name), element("span", badge[0], `badge ${badge[1]}`));
  const checked = counts.total - counts.pending;
  card.append(head, element("p", `Active = aakhri post ${check.active_days} din ke andar`, "job-meta"));
  const progress = element("section", undefined, "batch-progress");
  const heading = element("div", undefined, "batch-progress-heading");
  const hours = check.eta_minutes >= 60 ? `~${Math.round(check.eta_minutes / 60)} ghante baaki` : `~${check.eta_minutes} min baaki`;
  heading.append(element("strong", `${checked}/${counts.total} check hue`), element("span", check.status === "done" ? "Poora" : hours));
  const bar = document.createElement("progress");
  bar.className = "progress-bar"; bar.max = Math.max(1, counts.total); bar.value = checked;
  progress.append(heading, bar);
  const stats = element("div", undefined, "stats");
  for (const [value, label, tone] of [[counts.active, "Active", "good"], [counts.old, "Purane", ""], [counts.not_found, "Nahi mile", counts.not_found ? "bad" : ""], [counts.pending, "Baaki", ""]]) {
    const stat = element("div", undefined, tone ? `stat ${tone}` : "stat");
    stat.append(element("strong", String(value)), element("span", label));
    stats.append(stat);
  }
  card.append(progress, stats);
  if (check.status === "paused" && check.pause_reason) {
    card.append(element("p", CHECK_PAUSES[check.pause_reason] || "Check ruka hua hai.", check.pause_reason === "owner" ? "" : "batch-error"));
  }
  const actions = element("div", undefined, "dm-actions");
  const button = (text, className, handler) => {
    const node = element("button", text, className); node.type = "button";
    node.addEventListener("click", async () => {
      node.disabled = true;
      try { await handler(); } catch (error) { explain(error); } finally { node.disabled = false; }
    });
    actions.append(node);
  };
  const activeNames = async () => (await api(`/api/checks/${check.id}/usernames?filter=active`)).usernames;
  if (counts.active) {
    button(`Active (${counts.active}) ko DM campaign mein daalo`, "quiet strong", async () => {
      const names = await activeNames();
      $("dm-usernames").value = names.slice(0, 2000).join("\n");
      $("dm-name").value ||= `${check.name} · active`.slice(0, 60);
      updateDmCounts();
      $("dm-new").open = true;
      $("dm-new").scrollIntoView({ behavior: "smooth", block: "start" });
      notice(`${Math.min(names.length, 2000)} active creators “Naya DM campaign” mein bhar diye (bade accounts pehle).${names.length > 2000 ? " Ek campaign mein 2,000 tak aate hain; baaki agle campaign mein." : ""} Profile chuno, box tick karo aur Save.`);
    });
    button("Active list copy karo", "quiet", async () => {
      const names = await activeNames();
      try { await navigator.clipboard.writeText(names.join("\n")); notice(`${names.length} active usernames copy ho gaye.`); }
      catch { notice("Copy nahi ho paya. “DM campaign mein daalo” wala button use karo.", true); }
    });
  }
  if (check.status === "running") button("Pause", "quiet", async () => { await api(`/api/checks/${check.id}/pause`, { method: "POST", body: "{}" }); await loadChecks(); });
  else if (counts.pending || counts.errors || check.status === "paused") button("Start", "quiet strong", async () => { await api(`/api/checks/${check.id}/start`, { method: "POST", body: "{}" }); await loadChecks(); });
  button("Delete", "quiet danger", async () => {
    if (!confirm(`“${check.name}” list check aur uske results delete karne hain?`)) return;
    await api(`/api/checks/${check.id}`, { method: "DELETE" }); await loadChecks();
  });
  card.append(actions);
  return card;
}
function renderChecks() {
  const list = $("check-list");
  list.replaceChildren();
  if (!checkState) return;
  $("check-rate").textContent = String(checkState.per_hour);
  $("check-connect").hidden = checkState.connected;
  for (const check of checkState.checks) list.append(checkCard(check));
  if (checkState.checks.some((check) => check.status === "running")) $("check-panel").open = true;
  updateDmPolling();
}
function updateCheckCount() {
  const text = checkFileText || $("check-text").value;
  const links = text.match(/instagram\.com\//gi)?.length || 0;
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
  $("check-count").textContent = text ? `${lines} lines${links ? ` · ${links} Instagram links` : ""}${checkFileText ? " (file se)" : ""}. Duplicate apne aap hat jayenge.` : "";
}
$("check-text").addEventListener("input", () => { checkFileText = ""; $("check-file").value = ""; updateCheckCount(); });
$("check-file").addEventListener("change", async () => {
  const file = $("check-file").files?.[0];
  checkFileText = file ? await file.text().catch(() => "") : "";
  updateCheckCount();
});
$("check-panel").addEventListener("toggle", () => { if ($("check-panel").open && !checkState) void loadChecks().catch(explain); });
$("check-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("check-save"); button.disabled = true;
  try {
    const data = await api("/api/checks", { method: "POST", body: JSON.stringify({
      name: $("check-name").value.trim(), usernames: checkFileText || $("check-text").value, active_days: Number($("check-days").value)
    }) });
    notice(`List check shuru: ${data.added} usernames${data.invalid.length ? `, ${data.invalid.length}+ galat entries chhodi` : ""}. Website ab khud check karti rahegi, page band kar sakte ho.`);
    $("check-name").value = ""; $("check-text").value = ""; $("check-file").value = ""; checkFileText = ""; updateCheckCount();
    await loadChecks();
  } catch (error) { explain(error); }
  finally { button.disabled = false; }
});
const status = new URLSearchParams(location.search).get("notice");
if (status && messages[status]) notice(messages[status], !["connected", "connection_processing", "connection_cancelled"].includes(status));
if (location.search) history.replaceState(null, "", location.pathname + location.hash);
// Open the tab in the address (#activity), else the last one used; after
// connecting an account, open Accounts so the result is visible.
const hashView = location.hash.slice(1);
const startView = status && (status.startsWith("connection") || ["connected", "no_accounts"].includes(status)) ? "connections"
  : VIEWS.includes(hashView) ? hashView : readSetting("publisher-view") || "connections";
void boot();
