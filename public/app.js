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
  upload_too_large: "Har video 50 MB se chhoti honi chahiye.",
  request_too_large: "Har video 50 MB se chhoti honi chahiye.",
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
  upload_timeout: "Video upload ka response time out hua. Activity check karo; batch entry na ho to hi same files retry karo."
};
let accounts = [];
let jobs = [];
let progress = [];
let storage = null;
// The account picked in the switcher ("all" for every account). Accounts,
// Create post and Activity all follow it. Remembered per browser only.
const ALL_ACCOUNTS = "all";
const VIEWS = ["connections", "composer", "activity"];
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
  actions.append(post, history, remove);
  card.append(actions);
  return card;
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
  select.value = busy && busyAccount ? busyAccount : usable ? selectedAccount : "";
  select.disabled = busy;
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
  if (!files.length) { $("file-summary").textContent = `1–20 MP4/MOV files. Har file 50 MB tak. ${storageText()}`.trim(); return; }
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
async function uploadAsset(file, attempt) {
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
    accounts = []; jobs = []; progress = []; accountsLoaded = false; jobsScope = null; renderAccounts(); renderJobs();
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
$("caption").addEventListener("input", () => {
  const length = [...$("caption").value].length;
  $("caption-count").textContent = `${length} / 2200`;
  $("caption").setCustomValidity(length > 2200 ? "Caption 2200 characters se chhota rakho." : "");
});
$("upload-mode").addEventListener("change", updatePublishMode);
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
      if (files.length < 1 || files.length > 20 || files.some((file) => file.size > 50 * 1024 * 1024)) {
        throw { code: files.some((file) => file.size > 50 * 1024 * 1024) ? "upload_too_large" : "invalid_batch" };
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
      const key = await requestKey(["batch", payload], attempt);
      $("publish-progress").textContent = "Batch server par save ho rahi hai… page khula rakho; button dobara mat dabao.";
      await api("/api/batches", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) });
      batchScheduled = true;
      clearBatchAttempt();
      $("publish-progress").textContent = "Batch queue mein save hai. Pehli Reel process hogi; baaki chune hue gap par. Ab phone band kar sakte ho—service schedule ko background mein process karegi.";
      $("publish-form").reset(); updateFileSummary(); updatePublishMode();
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
const status = new URLSearchParams(location.search).get("notice");
if (status && messages[status]) notice(messages[status], !["connected", "connection_processing", "connection_cancelled"].includes(status));
if (location.search) history.replaceState(null, "", location.pathname + location.hash);
// Open the tab in the address (#activity), else the last one used; after
// connecting an account, open Accounts so the result is visible.
const hashView = location.hash.slice(1);
const startView = status && (status.startsWith("connection") || ["connected", "no_accounts"].includes(status)) ? "connections"
  : VIEWS.includes(hashView) ? hashView : readSetting("publisher-view") || "connections";
void boot();
