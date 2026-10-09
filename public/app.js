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
  idempotency_conflict: "Is request ki details badal gayi hain. History check karke page refresh karo.",
  connection_removed: "Is job ka account connection remove ho gaya hai.",
  connection_changed: "Account connection change hua. Refresh karke dobara check karo.",
  account_not_found: "Account connection nahi mila. List refresh karo.",
  token_storage_unavailable: "Saved connection abhi read nahi ho raha. Setup check karna zaroori hai.",
  temporarily_unavailable: "Service abhi available nahi hai. Thodi der baad dobara check karo."
};
let accounts = [];
let jobs = [];
let busy = false;
const timers = new Map();
const attempts = new Map();

function notice(text, error = false) {
  $("message").textContent = text;
  $("message").className = `notice${error ? " error" : ""}`;
  $("message").hidden = false;
}
function explain(error) { notice(messages[error.code] || "Request complete nahi hui. History check karke existing request dobara check karo.", true); }
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options,
      headers: { "Content-Type": "application/json", ...options.headers }, signal: AbortSignal.timeout(35000) });
  } catch { throw { code: "temporarily_unavailable" }; }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && data.error === "sign_in_required") {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      $("workspace").hidden = true; $("signin").hidden = false; $("logout").hidden = true;
    }
    throw { code: data.error || "temporarily_unavailable" };
  }
  return data;
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
  const names = { creating: "CREATING", processing: "PROCESSING", publishing: "CONFIRMING", published: "PUBLISHED", failed: "FAILED", unknown: "CHECK NEEDED" };
  for (const job of jobs) {
    const card = element("article", undefined, "job-card");
    const head = element("div", undefined, "job-head");
    head.append(element("strong", `@${job.account}`), element("span", names[job.status] || job.status, `badge ${job.status}`));
    card.append(head, element("p", `${job.media_type === "image" ? "Photo" : "Reel"} · ${new Date(job.created_at).toLocaleString()}`));
    if (job.error_code) card.append(element("p", messages[job.error_code] || "History check karke request ka status dobara dekho."));
    if (job.published_media_id) card.append(element("p", `Published media: ${job.published_media_id}`));
    if (!["published", "failed"].includes(job.status)) {
      const action = element("button", job.status === "processing" ? "Check & finish publishing" : "Check existing request", "job-action");
      action.type = "button";
      action.addEventListener("click", async () => {
        action.disabled = true;
        try { await advance(job.id, false); }
        catch (error) { explain(error); action.disabled = false; }
      });
      card.append(action);
    }
    $("jobs").append(card);
  }
}
async function refresh() {
  const [accountData, jobData] = await Promise.all([api("/api/accounts"), api("/api/jobs")]);
  accounts = accountData.accounts; jobs = jobData.jobs;
  renderAccounts(); renderJobs();
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
async function requestKey(payload) {
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))))]
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
  try { await api("/auth/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) }); $("password").value = ""; $("message").hidden = true; await boot(); }
  catch (error) { explain(error); }
  finally { $("login-button").disabled = false; }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
    for (const timer of timers.values()) clearTimeout(timer); timers.clear();
    accounts = []; jobs = []; renderAccounts(); renderJobs();
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
$("publish-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  busy = true; $("publish-button").disabled = true;
  $("publish-progress").textContent = "Request save ho rahi hai. Response na aaye to pehle History check karo.";
  const type = $("media-type").value;
  const payload = { connection_id: $("account").value, caption: $("caption").value,
    [type === "image" ? "image_url" : "video_url"]: $("media-url").value.trim() };
  try {
    const key = await requestKey([type, payload]);
    const { job } = await api(`/api/publish/${type === "image" ? "image" : "reels"}`, {
      method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload)
    });
    await refresh();
    if (job.status === "processing") await advance(job.id, true);
    $("publish-progress").textContent = "Request History mein save hai. Media processing ke liye is page ko khula rakho, ya baad mein Check & finish dabao.";
    $("confirm-publish").checked = false;
  } catch (error) { explain(error); $("publish-progress").textContent = "Pehle History check karo. Same details dobara submit karne par purana request hi use hoga."; }
  finally { busy = false; renderAccounts(); }
});
const status = new URLSearchParams(location.search).get("notice");
if (status && messages[status]) notice(messages[status], !["connected", "connection_processing", "connection_cancelled"].includes(status));
if (location.search) history.replaceState(null, "", location.pathname + location.hash);
void boot();
