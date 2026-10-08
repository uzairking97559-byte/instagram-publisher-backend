require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const PORT = process.env.PORT || 3000;
const VERSION = process.env.META_GRAPH_VERSION || "v24.0";
const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const KEY_TEXT = process.env.TOKEN_ENCRYPTION_KEY;
const COOKIE = "igpub_session";
const SESSION_AGE_DAYS = 30;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 5000
    })
  : null;
let databaseReady = false;

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

function encryptionKey() {
  try {
    const key = Buffer.from(KEY_TEXT || "", "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function encryptToken(value) {
  const key = encryptionKey();
  if (!key) throw new Error("Token encryption is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptToken(value) {
  const key = encryptionKey();
  if (!key) throw new Error("Token encryption is not configured");
  const [iv, tag, ciphertext] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function readCookies(req) {
  const result = {};
  for (const item of (req.headers.cookie || "").split(";")) {
    const split = item.indexOf("=");
    if (split < 1) continue;
    try {
      result[item.slice(0, split).trim()] = decodeURIComponent(item.slice(split + 1).trim());
    } catch {}
  }
  return result;
}

function setSessionCookie(res, token, clear = false) {
  const secure = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
  const age = clear ? 0 : SESSION_AGE_DAYS * 24 * 60 * 60;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`
  );
}

function storageReady() {
  return Boolean(pool && databaseReady && encryptionKey());
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      session_hash TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('facebook', 'instagram')),
      session_hash TEXT NOT NULL REFERENCES app_sessions(session_hash) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connected_accounts (
      id BIGSERIAL PRIMARY KEY,
      session_hash TEXT NOT NULL REFERENCES app_sessions(session_hash) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('facebook', 'instagram')),
      account_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      encrypted_token TEXT NOT NULL,
      token_expires_at TIMESTAMPTZ,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_hash, provider, account_id)
    );
    CREATE INDEX IF NOT EXISTS connected_accounts_session_idx
      ON connected_accounts(session_hash);
    CREATE TABLE IF NOT EXISTS publish_jobs (
      id BIGSERIAL PRIMARY KEY,
      session_hash TEXT NOT NULL REFERENCES app_sessions(session_hash) ON DELETE CASCADE,
      account_row_id BIGINT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
      creation_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'publishing', 'published', 'failed')),
      published_media_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  databaseReady = true;
}

function requireStorage(_req, res, next) {
  if (!storageReady()) {
    return res.status(503).json({
      error: "Secure storage is not ready. Configure DATABASE_URL and a base64 32-byte TOKEN_ENCRYPTION_KEY."
    });
  }
  next();
}

async function requireSession(req, res, next) {
  const token = readCookies(req)[COOKIE];
  if (!token) return res.status(401).json({ error: "Connect an account first." });
  try {
    const sessionHash = hash(token);
    const result = await pool.query(
      "SELECT 1 FROM app_sessions WHERE session_hash = $1 AND expires_at > NOW()",
      [sessionHash]
    );
    if (!result.rowCount) return res.status(401).json({ error: "Session expired. Connect again." });
    req.sessionHash = sessionHash;
    next();
  } catch {
    res.status(503).json({ error: "Secure storage is temporarily unavailable." });
  }
}

function requireSameOrigin(req, res, next) {
  try {
    if (!req.get("origin") || new URL(req.get("origin")).host !== req.get("host")) {
      return res.status(403).json({ error: "Origin check failed." });
    }
    next();
  } catch {
    res.status(403).json({ error: "Origin check failed." });
  }
}

async function metaRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error("Meta API request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function graphRequest(path, token, provider = "facebook", method = "GET", fields = {}) {
  const host = provider === "instagram" ? "https://graph.instagram.com/" : "https://graph.facebook.com/";
  const url = new URL(`${VERSION}/${path}`, host);
  const params = { ...fields, access_token: token };
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return metaRequest(url);
  }
  return metaRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
}

async function getAllManagedPages(token) {
  const pages = [];
  let after;
  for (let requestCount = 0; requestCount < 100; requestCount++) {
    const fields = {
      fields: "id,name,access_token,instagram_business_account{id,username}"
    };
    if (after) fields.after = after;
    const result = await graphRequest("me/accounts", token, "facebook", "GET", fields);
    pages.push(...(result.data || []));
    after = result.paging && result.paging.cursors && result.paging.cursors.after;
    if (!result.paging || !result.paging.next || !after) return pages;
  }
  throw new Error("Managed Page list exceeded the safe pagination limit");
}

async function beginOAuth(provider, req, res) {
  if (!APP_ID || !APP_SECRET || !REDIRECT_URI || !storageReady()) {
    return res.status(503).send("Secure storage is not configured yet.");
  }
  try {
    const sessionToken = readCookies(req)[COOKIE] || randomToken();
    const sessionHash = hash(sessionToken);
    await pool.query(
      `INSERT INTO app_sessions(session_hash, expires_at)
       VALUES ($1, NOW() + INTERVAL '30 days')
       ON CONFLICT (session_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [sessionHash]
    );
    setSessionCookie(res, sessionToken);

    const state = randomToken();
    await pool.query(
      `INSERT INTO oauth_states(state_hash, provider, session_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [hash(state), provider, sessionHash]
    );

    const url = provider === "facebook"
      ? new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`)
      : new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", APP_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (provider === "facebook") {
      url.searchParams.set("scope", "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement");
    } else {
      url.searchParams.set("scope", "instagram_business_basic,instagram_business_content_publish");
      url.searchParams.set("enable_fb_login", "0");
      url.searchParams.set("force_authentication", "1");
    }
    res.redirect(url.toString());
  } catch {
    res.status(503).send("Could not start secure sign-in. Please try again.");
  }
}

async function exchangeFacebookCode(code) {
  const shortUrl = new URL(`https://graph.facebook.com/${VERSION}/oauth/access_token`);
  for (const [key, value] of Object.entries({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    redirect_uri: REDIRECT_URI,
    code
  })) shortUrl.searchParams.set(key, value);
  const shortToken = await metaRequest(shortUrl);

  const longUrl = new URL(`https://graph.facebook.com/${VERSION}/oauth/access_token`);
  for (const [key, value] of Object.entries({
    grant_type: "fb_exchange_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    fb_exchange_token: shortToken.access_token
  })) longUrl.searchParams.set(key, value);
  return metaRequest(longUrl);
}

async function exchangeInstagramCode(code) {
  const body = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code
  });
  const shortToken = await metaRequest("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const longUrl = new URL("https://graph.instagram.com/access_token");
  for (const [key, value] of Object.entries({
    grant_type: "ig_exchange_token",
    client_secret: APP_SECRET,
    access_token: shortToken.access_token
  })) longUrl.searchParams.set(key, value);
  return { ...(await metaRequest(longUrl)), user_id: shortToken.user_id };
}

async function saveAccount(sessionHash, account) {
  await pool.query(
    `INSERT INTO connected_accounts
      (session_hash, provider, account_id, username, display_name, encrypted_token, token_expires_at, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (session_hash, provider, account_id) DO UPDATE SET
       username=EXCLUDED.username, display_name=EXCLUDED.display_name,
       encrypted_token=EXCLUDED.encrypted_token, token_expires_at=EXCLUDED.token_expires_at,
       scopes=EXCLUDED.scopes, updated_at=NOW()`,
    [
      sessionHash,
      account.provider,
      String(account.id),
      account.username || null,
      account.name || null,
      encryptToken(account.token),
      account.expires ? new Date(Date.now() + Number(account.expires) * 1000) : null,
      account.scopes
    ]
  );
}

async function oauthCallback(req, res) {
  if (!storageReady()) return res.status(503).send("Secure storage is not configured yet.");
  const { code, state, error } = req.query;
  if (error) return res.status(400).send("Sign-in was cancelled or declined.");
  if (typeof code !== "string" || typeof state !== "string") {
    return res.status(400).send("Sign-in response is incomplete. Start again.");
  }

  try {
    const browserHash = hash(readCookies(req)[COOKIE] || "");
    const claimed = await pool.query(
      `DELETE FROM oauth_states WHERE state_hash=$1 AND session_hash=$2 AND expires_at>NOW()
       RETURNING provider, session_hash`,
      [hash(state), browserHash]
    );
    const transaction = claimed.rows[0];
    if (!transaction) {
      return res.status(400).send("This sign-in expired or was already used. Start again.");
    }

    if (transaction.provider === "facebook") {
      const token = await exchangeFacebookCode(code);
      const pages = await getAllManagedPages(token.access_token);
      let saved = 0;
      for (const page of pages) {
        const account = page.instagram_business_account;
        if (!account || !page.access_token) continue;
        await saveAccount(transaction.session_hash, {
          provider: "facebook", id: account.id, username: account.username, name: page.name,
          token: page.access_token, expires: token.expires_in,
          scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"]
        });
        saved++;
      }
      if (!saved) return res.status(400).send("No Instagram professional account linked to an accessible Facebook Page was found.");
    } else {
      const token = await exchangeInstagramCode(code);
      const profile = await graphRequest("me", token.access_token, "instagram", "GET", { fields: "user_id,username,name" });
      await saveAccount(transaction.session_hash, {
        provider: "instagram", id: profile.user_id || token.user_id || profile.id,
        username: profile.username, name: profile.name, token: token.access_token,
        expires: token.expires_in,
        scopes: ["instagram_business_basic", "instagram_business_content_publish"]
      });
    }
    res.redirect("/?connected=1");
  } catch (error) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    res.status(status).send("Meta sign-in failed. Start a fresh sign-in. Access tokens are never displayed or logged.");
  }
}

function publicMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "instagram-publisher-backend", secureStorageReady: storageReady() });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>Instagram Publisher</title>
    <style>*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 20% 0%,#392751,transparent 42%),#10131b;color:#f4f6fb;font:16px system-ui;min-height:100vh}main{max-width:860px;margin:auto;padding:36px 20px}.brand{color:#b7a4ef;letter-spacing:.14em;text-transform:uppercase;font-size:13px}h1{font-size:clamp(34px,7vw,56px);margin:18px 0 10px}.sub{color:#aab1c1;line-height:1.6}.card{margin-top:26px;padding:24px;border:1px solid #2a3040;border-radius:20px;background:#171c27;box-shadow:0 18px 70px #0004}.buttons{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.button{display:inline-block;padding:13px 17px;border-radius:12px;text-decoration:none;font-weight:700;background:#9b7cf6;color:#17121f}.button.alt{background:#252c3b;color:#fff}.item{padding:14px 0;border-top:1px solid #2b3140;display:flex;justify-content:space-between;gap:10px}.muted{color:#9ba4b7;font-size:13px}</style></head>
    <body><main><div class="brand">Creator tools</div><h1>Instagram Publisher</h1>
    <p class="sub">Connect a professional account through official Meta authorization. Access tokens stay on the server and are encrypted before storage.</p>
    <section class="card"><h2>Connect an account</h2><div class="buttons">
    <a class="button" href="/auth/meta/start">Continue with Facebook</a>
    <a class="button alt" href="/auth/instagram/start">Continue with Instagram</a>
    <a class="button alt" href="/studio">Open publishing studio</a></div>
    <div id="notice">Loading connected accounts…</div><div id="accounts"></div></section></main>
    <script>(async()=>{const n=document.getElementById('notice'),a=document.getElementById('accounts');try{const r=await fetch('/api/accounts'),d=await r.json();if(!r.ok){n.textContent=d.error||'Connect an account to start.';return}n.textContent=d.accounts.length?d.accounts.length+' account(s) connected.':'No accounts connected yet.';a.innerHTML=d.accounts.map(x=>'<div class="item"><div><b>'+esc(x.username||'Instagram account')+'</b><div class="muted">'+esc(x.display_name||'')+'</div></div><span class="muted">'+(x.provider==='instagram'?'Instagram Login':'Facebook Login')+'</span></div>').join('')}catch{n.textContent='Could not load accounts.'}function esc(s){return String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}})()</script></body></html>`);
});

app.get("/studio", (_req, res) => {
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>Publishing Studio</title>
    <style>*{box-sizing:border-box}body{margin:0;background:#10131b;color:#f4f6fb;font:16px system-ui}main{max-width:760px;margin:auto;padding:28px 18px}.muted{color:#aab1c1;line-height:1.55}.card{margin-top:20px;padding:22px;border:1px solid #2a3040;border-radius:18px;background:#171c27}label{display:block;margin:16px 0 7px;font-weight:650}input,select,textarea{width:100%;padding:12px;border-radius:10px;border:1px solid #3a4152;background:#10131b;color:#fff;font:inherit}textarea{min-height:100px;resize:vertical}button,.link{display:inline-block;margin-top:16px;padding:12px 16px;border:0;border-radius:10px;background:#9b7cf6;color:#17121f;font-weight:700;font:inherit;text-decoration:none;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}#status{white-space:pre-wrap;margin-top:16px;color:#c7cde0}.small{font-size:13px}</style></head>
    <body><main><a class="link" href="/">← Dashboard</a><h1>Publishing Studio</h1>
    <p class="muted">Authorized account par image ya reel publish karo. Media URL HTTPS par publicly reachable hona chahiye, taaki Meta file fetch kar sake.</p>
    <section class="card"><form id="publishForm"><label for="account">Instagram account</label><select id="account" required><option value="">Accounts load ho rahe hain…</option></select>
    <label for="kind">Post type</label><select id="kind"><option value="image">Photo</option><option value="reel">Reel</option></select>
    <label for="mediaUrl">Public HTTPS media URL</label><input id="mediaUrl" type="url" placeholder="https://..." required>
    <label for="caption">Caption</label><textarea id="caption" maxlength="2200" placeholder="Caption likho…"></textarea>
    <div class="row"><button id="publishButton" type="submit">Publish</button><button id="checkButton" type="button" hidden>Check reel and publish</button><button id="disconnectButton" type="button" class="link">Remove selected account</button><button id="logoutButton" type="button" class="link">Disconnect this browser</button></div>
    <div id="status" role="status" aria-live="polite">Account list loading…</div></form></section></main>
    <script>
      const accountSelect=document.getElementById('account'),kind=document.getElementById('kind'),mediaUrl=document.getElementById('mediaUrl'),caption=document.getElementById('caption'),statusBox=document.getElementById('status'),publishButton=document.getElementById('publishButton'),checkButton=document.getElementById('checkButton');
      let creationId='';
      async function loadAccounts(){try{const r=await fetch('/api/accounts'),d=await r.json();accountSelect.replaceChildren();if(!r.ok){accountSelect.add(new Option('Connect an account from the dashboard',''));statusBox.textContent=d.error||'No connected accounts.';return}if(!d.accounts.length){accountSelect.add(new Option('No connected accounts',''));statusBox.textContent='Pehle dashboard se Instagram account connect karo.';return}accountSelect.add(new Option('Choose account',''));for(const x of d.accounts){const label=(x.username?'@'+x.username:'Instagram account')+' · '+(x.provider==='instagram'?'Instagram Login':'Facebook Login');accountSelect.add(new Option(label,x.account_id))}statusBox.textContent='Ready. Photo/reel ka public HTTPS URL paste karo.'}catch{statusBox.textContent='Account list load nahi hui. Dashboard se dobara try karo.'}}
      document.getElementById('publishForm').addEventListener('submit',async e=>{e.preventDefault();if(!accountSelect.value){statusBox.textContent='Pehle connected account select karo.';return}publishButton.disabled=true;checkButton.hidden=true;creationId='';statusBox.textContent='Meta ko publish request bhej rahe hain…';try{const isReel=kind.value==='reel';const r=await fetch(isReel?'/api/publish/reels':'/api/publish/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:accountSelect.value,[isReel?'video_url':'image_url']:mediaUrl.value,caption:caption.value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Publish request fail hui.');if(!isReel){statusBox.textContent='Photo publish ho gayi. Media ID: '+d.published_media_id;return}creationId=d.creation_id;checkButton.hidden=false;statusBox.textContent='Reel processing mein hai. Meta ready bataye to “Check reel and publish” dabao. Container: '+creationId}catch(err){statusBox.textContent=err.message}finally{publishButton.disabled=false}});
      checkButton.addEventListener('click',async()=>{if(!creationId)return;checkButton.disabled=true;statusBox.textContent='Reel status check ho raha hai…';try{const r=await fetch('/api/publish/reels/'+encodeURIComponent(creationId)+'/publish',{method:'POST'});const d=await r.json();if(r.ok&&d.success){statusBox.textContent='Reel publish ho gayi. Media ID: '+d.published_media_id;checkButton.hidden=true;return}if(r.status===202){statusBox.textContent='Reel abhi processing mein hai ('+(d.status||'processing')+'). Thodi der baad dobara check karo.';return}statusBox.textContent=d.error||d.status||'Publish fail hui.'}catch{statusBox.textContent='Status check nahi hua. Thodi der baad phir try karo.'}finally{checkButton.disabled=false}});
      document.getElementById('disconnectButton').addEventListener('click',async()=>{const id=accountSelect.value;if(!id){statusBox.textContent='Pehle account select karo.';return}if(!confirm('Is account ko app se remove kar doon? Meta app permission revoke nahi hogi.'))return;try{const r=await fetch('/api/accounts/'+encodeURIComponent(id),{method:'DELETE'});const d=await r.json();if(!r.ok){statusBox.textContent=d.error||'Account remove nahi hua.';return}statusBox.textContent='Account app se remove ho gaya. Meta permission alag se revoke hoti hai.';await loadAccounts()}catch{statusBox.textContent='Account remove nahi ho paya.'}});
      document.getElementById('logoutButton').addEventListener('click',async()=>{if(!confirm('Is browser se connected accounts aur session remove kar doon?'))return;try{const r=await fetch('/auth/logout',{method:'POST'});if(r.ok){location.href='/';return}statusBox.textContent='Disconnect nahi ho paya.'}catch{statusBox.textContent='Disconnect nahi ho paya.'}});
      loadAccounts();
    </script></body></html>`);
});

app.get("/auth/meta/start", (req, res) => beginOAuth("facebook", req, res));
app.get("/auth/instagram/start", (req, res) => beginOAuth("instagram", req, res));
app.get("/auth/meta/callback", oauthCallback);

app.get("/api/accounts", requireStorage, requireSession, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,provider,account_id,username,display_name,token_expires_at,updated_at
       FROM connected_accounts WHERE session_hash=$1 ORDER BY updated_at DESC`,
      [req.sessionHash]
    );
    res.json({ accounts: result.rows });
  } catch {
    res.status(503).json({ error: "Could not load connected accounts." });
  }
});

app.delete("/api/accounts/:accountId", requireSameOrigin, requireStorage, requireSession, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM connected_accounts WHERE session_hash=$1 AND account_id=$2 RETURNING id",
      [req.sessionHash, String(req.params.accountId)]
    );
    if (!result.rowCount) return res.status(404).json({ error: "That account is not connected to this session." });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Could not remove this account." });
  }
});

app.post("/auth/logout", requireSameOrigin, requireStorage, requireSession, async (req, res) => {
  try {
    await pool.query("DELETE FROM app_sessions WHERE session_hash=$1", [req.sessionHash]);
    setSessionCookie(res, "", true);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Could not end this session." });
  }
});

app.post("/api/publish/image", requireSameOrigin, requireStorage, requireSession, async (req, res) => {
  const { account_id, image_url, caption = "" } = req.body || {};
  if (!account_id || typeof caption !== "string" || !publicMediaUrl(image_url)) {
    return res.status(400).json({ error: "account_id and a public HTTPS image_url are required." });
  }
  try {
    const found = await pool.query(
      `SELECT account_id,provider,encrypted_token FROM connected_accounts
       WHERE session_hash=$1 AND account_id=$2`,
      [req.sessionHash, String(account_id)]
    );
    if (!found.rowCount) return res.status(404).json({ error: "That account is not connected to this session." });
    const account = found.rows[0];
    const token = decryptToken(account.encrypted_token);
    const container = await graphRequest(`${account.account_id}/media`, token, account.provider, "POST", { image_url, caption });
    const published = await graphRequest(`${account.account_id}/media_publish`, token, account.provider, "POST", { creation_id: container.id });
    res.json({ success: true, published_media_id: published.id });
  } catch {
    res.status(502).json({ error: "Publishing failed. Check media URL, account eligibility, and granted permissions." });
  }
});

app.post("/api/publish/reels", requireSameOrigin, requireStorage, requireSession, async (req, res) => {
  const { account_id, video_url, caption = "" } = req.body || {};
  if (!account_id || typeof caption !== "string" || !publicMediaUrl(video_url)) {
    return res.status(400).json({ error: "account_id and a public HTTPS video_url are required." });
  }
  try {
    const found = await pool.query(
      `SELECT id,account_id,provider,encrypted_token FROM connected_accounts
       WHERE session_hash=$1 AND account_id=$2`,
      [req.sessionHash, String(account_id)]
    );
    if (!found.rowCount) return res.status(404).json({ error: "That account is not connected to this session." });
    const account = found.rows[0];
    const token = decryptToken(account.encrypted_token);
    const container = await graphRequest(`${account.account_id}/media`, token, account.provider, "POST", {
      media_type: "REELS", video_url, caption, share_to_feed: "true"
    });
    await pool.query(
      "INSERT INTO publish_jobs(session_hash,account_row_id,creation_id) VALUES($1,$2,$3)",
      [req.sessionHash, account.id, container.id]
    );
    res.status(202).json({ status: "processing", creation_id: container.id });
  } catch {
    res.status(502).json({ error: "Could not create the reel container." });
  }
});

app.post("/api/publish/reels/:creationId/publish", requireSameOrigin, requireStorage, requireSession, async (req, res) => {
  try {
    const found = await pool.query(
      `SELECT j.id,j.status,j.published_media_id,a.account_id,a.provider,a.encrypted_token
       FROM publish_jobs j JOIN connected_accounts a ON a.id=j.account_row_id
       WHERE j.session_hash=$1 AND j.creation_id=$2`,
      [req.sessionHash, req.params.creationId]
    );
    if (!found.rowCount) return res.status(404).json({ error: "Reel container not found." });
    const job = found.rows[0];
    if (job.status === "published") return res.json({ success: true, published_media_id: job.published_media_id });
    if (job.status === "publishing") return res.status(202).json({ status: "publishing" });
    if (job.status === "failed") return res.status(422).json({ status: "failed" });
    const token = decryptToken(job.encrypted_token);
    const status = await graphRequest(`${req.params.creationId}?fields=status_code`, token, job.provider);
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      await pool.query("UPDATE publish_jobs SET status='failed',updated_at=NOW() WHERE id=$1", [job.id]);
      return res.status(422).json({ status: status.status_code });
    }
    if (status.status_code !== "FINISHED") return res.status(202).json({ status: status.status_code || "processing" });
    const claimed = await pool.query(
      "UPDATE publish_jobs SET status='publishing',updated_at=NOW() WHERE id=$1 AND status='processing' RETURNING id",
      [job.id]
    );
    if (!claimed.rowCount) return res.status(202).json({ status: "publishing" });
    const result = await graphRequest(`${job.account_id}/media_publish`, token, job.provider, "POST", { creation_id: req.params.creationId });
    await pool.query("UPDATE publish_jobs SET status='published',published_media_id=$2,updated_at=NOW() WHERE id=$1", [job.id, result.id]);
    res.json({ success: true, published_media_id: result.id });
  } catch {
    res.status(502).json({ error: "Could not publish this reel." });
  }
});

app.use((_err, _req, res, _next) => res.status(500).json({ error: "Unexpected server error." }));

app.listen(PORT, async () => {
  if (pool) {
    try {
      await initializeDatabase();
      console.log("Secure token storage connected.");
    } catch {
      databaseReady = false;
      console.error("Secure token storage unavailable; OAuth and publishing are disabled.");
    }
  } else {
    console.log("Secure token storage is not configured; OAuth and publishing are disabled.");
  }
  console.log(`Instagram publisher backend running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
});
