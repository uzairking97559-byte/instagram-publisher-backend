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
  container_expired: "Media container expire ho gaya. Content check karke naya request bana sakte ho.",
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
  upload_storage_full: "Pending uploads ki storage limit bhar gayi. History mein purane reels complete hone do.",
  invalid_batch: "1–20 videos, account, caption aur 10/15/30 minute ka gap select karo.",
  invalid_progress_settings: "Target 1–10,000 aur pehle se ki ginti 0 se target ke beech rakho.",
  asset_unavailable: "Koi selected video upload nahi hui ya pehle se queue mein hai. Videos dobara select karke upload karo.",
  batch_cannot_resume: "Is batch ko continue nahi kar sakte. Pehle uncertain Reel ka status check karo.",
  idempotency_conflict: "Is request ki details badal gayi hain. History check karke page refresh karo.",
  connection_removed: "Is job ka account connection remove ho gaya hai.",
  connection_changed: "Account connection change hua. Refresh karke dobara check karo.",
  account_not_found: "Account connection nahi mila. List refresh karo.",
  token_storage_unavailable: "Saved connection abhi read nahi ho raha. Setup check karna zaroori hai.",
  temporarily_unavailable: "Service abhi available nahi hai. Thodi der baad dobara check karo."
};
let accounts = [];
let jobs = [];
let progress = [];
let busy = false;
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
  notice(messages[code] || "Request complete nahi hui. History check karke existing request dobara check karo.", true, code);
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
function addAccountProgress(card, account) {
  const item = progress.find((row) => row.connection_id === account.connection_id);
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
  bar.setAttribute("aria-label", `@${account.username || account.account_id}: ${counted} of ${target} posts tracked`);
  block.append(bar);
  block.append(element("p", `Pehle se ${baseline} · Is site se ${item.published_count} posted, ${item.scheduled_count} scheduled · ${item.failed_count} failed · ${item.unknown_count} check needed`, "progress-details"));

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
  const readOnly = ["GET", "HEAD"].includes((options.method || "GET").toUpperCase());
  const retryDelays = [500, 1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...options,
        headers: { "Content-Type": "application/json", ...options.headers }, signal: AbortSignal.timeout(35000) });
    } catch (error) {
      if (readOnly && error?.name !== "TimeoutError" && attempt < retryDelays.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw { code: "temporarily_unavailable" };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && data.error === "sign_in_required") {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        $("workspace").hidden = true; $("signin").hidden = false; $("logout").hidden = true;
      }
      const code = data.error || "temporarily_unavailable";
      if (readOnly && response.status >= 500 && code === "temporarily_unavailable" && attempt < retryDelays.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw { code };
    }
    return data;
  }
}
function renderAccounts() {
  const selected = $("account").value;
  $("accounts").replaceChildren();
  $("account").replaceChildren(element("option", "Account chuno"));
  $("account").firstChild.value = "";
  $("account-count").textContent = accounts.length;
  if (!accounts.length) $("accounts").append(element("p", "Pehla professional account connect karo. Facebook se accessible linked accounts ek saath mil sakte hain.", "empty"));
  for (const account of accounts) {
    const card = element("article", undefined, "account-card");
    const head = element("div", undefined, "account-name");
    const name = account.username || account.account_id;
    head.append(element("span", name.slice(0, 1), "avatar"), element("h3", `@${name}`));
    card.append(head, element("p", `${account.provider === "facebook" ? "Facebook Login" : "Instagram Login"} · ${account.needs_reconnect ? "Reconnect needed" : "Connected"}`));
    if (account.token_expires_at) card.append(element("p", `Authorization until ${new Date(account.token_expires_at).toLocaleDateString()}`));
    addAccountProgress(card, account);
    const remove = element("button", "Disconnect", "quiet");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!confirm(`@${name} ka saved connection remove karna hai? In-progress publishing pehle check kar lo. Meta permission alag se revoke karni hogi.`)) return;
      remove.disabled = true;
      try { await api(`/api/accounts/${account.connection_id}`, { method: "DELETE" }); await refresh(); }
      catch (error) { explain(error); remove.disabled = false; }
    });
    card.append(remove); $("accounts").append(card);
    if (!account.needs_reconnect) {
      const option = element("option", `@${name} · ${account.provider === "facebook" ? "Facebook" : "Instagram"}`);
      option.value = account.connection_id; $("account").append(option);
    }
  }
  if (accounts.some((a) => a.connection_id === selected && !a.needs_reconnect)) $("account").value = selected;
  $("publish-button").disabled = busy || !accounts.some((a) => !a.needs_reconnect);
}
function renderJobs() {
  $("jobs").replaceChildren();
  if (!jobs.length) $("jobs").append(element("p", "Your next idea starts here. Publish requests yahan dikhengi.", "empty"));
  const names = { queued: "QUEUED", creating: "CREATING", processing: "PROCESSING", publishing: "CONFIRMING", published: "PUBLISHED", failed: "FAILED", unknown: "CHECK NEEDED" };
  const batches = new Map();
  const singles = [];
  for (const job of jobs) {
    if (!job.batch_id) singles.push(job);
    else { if (!batches.has(job.batch_id)) batches.set(job.batch_id, []); batches.get(job.batch_id).push(job); }
  }
  function addAction(card, job) {
    if (!["processing", "unknown", "publishing"].includes(job.status)) return;
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
    const status = first.batch_status === "completed"
      ? (group.some((job) => job.status === "failed") ? "failed" : "published")
      : group.find((job) => job.status === "unknown")?.status || group.find((job) => job.status === "failed")?.status
        || group.find((job) => job.status === "processing" || job.status === "publishing" || job.status === "creating")?.status || "queued";
    const head = element("div", undefined, "job-head");
    head.append(element("strong", `@${first.account} · ${first.batch_count} reels · ${first.interval_minutes} min gap`),
      element("span", names[status] || status, `badge ${status}`));
    card.append(head);
    for (const job of group) {
      const row = element("div", undefined, "batch-job-row");
      const label = job.media_name || `Reel ${job.batch_position}`;
      row.append(element("span", `Reel ${job.batch_position}/${job.batch_count} · ${label}`),
        element("span", names[job.status] || job.status, `badge ${job.status}`));
      card.append(row);
      if (job.status === "queued") card.append(element("p", `Publish target: ${new Date(job.scheduled_at).toLocaleString()}`));
      if (job.error_code) card.append(element("p", messages[job.error_code] || "History check karke request ka status dobara dekho."));
      if (job.published_media_id) card.append(element("p", `Published media: ${job.published_media_id}`));
      addAction(card, job);
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
async function refresh() {
  const [accountData, jobData, progressData] = await Promise.all([api("/api/accounts"), api("/api/jobs"), api("/api/progress")]);
  accounts = accountData.accounts; jobs = jobData.jobs; progress = progressData.progress;
  renderAccounts(); renderJobs();
  clearTemporaryUnavailable();
  const pending = jobs.some((job) => ["queued", "creating", "processing", "publishing"].includes(job.status));
  if (pending && !pendingPollTimer) pendingPollTimer = setInterval(() => { void refresh().catch(explain); }, 30000);
  if (!pending && pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
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
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function selectedFiles() { return [...($("reel-files").files || [])]; }
function updateFileSummary() {
  const files = selectedFiles();
  if (!files.length) { $("file-summary").textContent = "1–20 MP4/MOV files. Har file 50 MB tak; pending uploads ke liye total storage limit 500 MB hai."; return; }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  $("file-summary").textContent = `${files.length} videos · total ${formatBytes(total)} · ${files.map((file) => file.name).join(", ")}`;
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
  const retryDelays = [500, 1000, 2000, 4000];
  for (let retry = 0; ; retry++) {
    let response;
    try {
      response = await fetch("/api/assets", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "Idempotency-Key": key },
        body: file, signal: AbortSignal.timeout(180000) });
    } catch (error) {
      if (error?.name !== "TimeoutError" && retry < retryDelays.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[retry]));
        continue;
      }
      throw { code: "temporarily_unavailable" };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && data.error === "sign_in_required") {
        $("workspace").hidden = true; $("signin").hidden = false; $("logout").hidden = true;
      }
      const code = data.error || "temporarily_unavailable";
      // Asset uploads use a stable idempotency key; retrying this step cannot publish a duplicate Reel.
      if (response.status >= 500 && code === "temporarily_unavailable" && retry < retryDelays.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[retry]));
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
    for (const provider of ["facebook", "instagram"]) {
      const link = $(`connect-${provider}`);
      link.setAttribute("aria-disabled", String(!session.providers[provider]));
      if (session.providers[provider]) link.removeAttribute("tabindex"); else link.setAttribute("tabindex", "-1");
    }
    if (session.authenticated) await refresh();
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
    accounts = []; jobs = []; progress = []; renderAccounts(); renderJobs();
    $("publish-form").reset(); await boot();
  } catch (error) { explain(error); }
});
$("reload").addEventListener("click", () => refresh().catch(explain));
$("setup-retry").addEventListener("click", () => boot());
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
  busy = true; $("publish-button").disabled = true;
  let batchScheduled = false;
  $("publish-progress").textContent = "Request save ho rahi hai. Response na aaye to pehle History check karo.";
  try {
    if ($("upload-mode").value === "batch") {
      const files = selectedFiles();
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (files.length < 1 || files.length > 20 || files.some((file) => file.size > 50 * 1024 * 1024) || totalBytes > 500 * 1024 * 1024) {
        throw { code: files.some((file) => file.size > 50 * 1024 * 1024) ? "upload_too_large" : "invalid_batch" };
      }
      const attempt = batchAttemptId();
      const assetIds = [];
      for (let index = 0; index < files.length; index++) {
        $("publish-progress").textContent = `Video ${index + 1}/${files.length} upload ho rahi hai… upload ke dauran page band mat karo.`;
        const asset = await uploadAsset(files[index], attempt);
        assetIds.push(asset.asset_id);
      }
      const payload = { connection_id: $("account").value, caption: $("caption").value,
        interval_minutes: Number($("interval-minutes").value), asset_ids: assetIds };
      const key = await requestKey(["batch", payload], attempt);
      await api("/api/batches", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) });
      batchScheduled = true;
      clearBatchAttempt();
      $("publish-progress").textContent = "Batch queue mein save hai. Pehli reel start hogi; baaki chune hue gap par. Page khula rakho—Free service soyi to delay ho sakta hai.";
      $("publish-form").reset(); updateFileSummary(); updatePublishMode();
      await refresh();
    } else {
      const type = $("media-type").value;
      const payload = { connection_id: $("account").value, caption: $("caption").value,
        [type === "image" ? "image_url" : "video_url"]: $("media-url").value.trim() };
      const key = await requestKey([type, payload]);
      const { job } = await api(`/api/publish/${type === "image" ? "image" : "reels"}`, {
        method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload)
      });
      await refresh();
      if (job.status === "processing") await advance(job.id, true);
      $("publish-progress").textContent = "Request History mein save hai. Processing ke liye page khula rakho, ya baad mein Check & finish dabao.";
    }
    $("confirm-publish").checked = false;
  } catch (error) {
    explain(error);
    $("publish-progress").textContent = batchScheduled
      ? "Batch save ho gayi hai. History refresh nahi hui—button dobara dabane se pehle Refresh check karo."
      : "Batch schedule nahi hui. Pehle History check karo; agar upload beech mein ruki, to dobara submit karne par upload safely retry hoga.";
  }
  finally { busy = false; renderAccounts(); }
});
const status = new URLSearchParams(location.search).get("notice");
if (status && messages[status]) notice(messages[status], !["connected", "connection_processing", "connection_cancelled"].includes(status));
if (location.search) history.replaceState(null, "", location.pathname + location.hash);
void boot();
