"use strict";

const path = require("node:path");
const express = require("express");
const {
  hash, randomToken, validToken, validId, readConfig, encryptToken,
  passwordVerifier, cookieToken, sameOrigin, rateLimiter
} = require("./security");
const { createMetaClient, MetaError } = require("./meta");
const { initializeDatabase } = require("./database");
const { createPublishing, AppError, MAX_MEDIA_BYTES } = require("./publishing");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const COOKIE = "igpub_owner";

async function createApp({ env = process.env, db = null, fetchImpl = fetch, logger = () => {}, metaTimeoutMs = 20000 } = {}) {
  const config = readConfig(env);
  const owner = await passwordVerifier(config.password, config.key);
  const meta = createMetaClient(config, fetchImpl, metaTimeoutMs);
  const app = express();
  let databaseReady = false;
  let initializing = null;
  const log = (event, details = {}) => logger({ event, ...details });
  const configured = () => Boolean(db && config.key && owner.version && config.origin);
  const ready = () => configured() && databaseReady;
  const providerReady = (provider) => Boolean(config[provider].id && config[provider].secret);
  const publishing = db ? createPublishing({ db, meta, key: config.key, log, origin: config.origin }) : null;
  const loginIP = rateLimiter({ limit: 5, windowMs: 15 * 60000 });
  const loginGlobal = rateLimiter({ limit: 30, windowMs: 60 * 60000 });
  const oauthLimit = rateLimiter({ limit: 40, windowMs: 60 * 60000 });
  const apiLimit = rateLimiter({ limit: 120, windowMs: 60000 });

  app.disable("x-powered-by");
  if (env.RENDER === "true") app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    });
    if (config.secureCookie) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  function setCookie(res, token, clear = false) {
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: "lax", secure: config.secureCookie,
      path: "/", maxAge: clear ? 0 : 30 * 86400000
    });
  }
  function requireReady(_req, _res, next) {
    if (!ready()) throw new AppError(503, "setup_required");
    next();
  }
  function requireOrigin(req, _res, next) {
    if (!sameOrigin(req, config.origin)) throw new AppError(403, "origin_rejected");
    next();
  }
  async function session(req) {
    const token = cookieToken(req, COOKIE);
    if (!token || !ready()) return null;
    const sessionHash = hash(token);
    const result = await db.query(
      "SELECT session_hash FROM publisher_sessions WHERE session_hash=$1 AND auth_version=$2 AND expires_at>NOW()",
      [sessionHash, owner.version]);
    return result.rows.length ? sessionHash : null;
  }
  const requireSession = wrap(async (req, _res, next) => {
    req.sessionHash = await session(req);
    if (!req.sessionHash) throw new AppError(401, "sign_in_required");
    next();
  });

  app.locals.initialize = async () => {
    if (!configured()) return false;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        if (databaseReady) await db.query("SELECT 1");
        else await initializeDatabase(db);
        databaseReady = true;
        return true;
      } catch {
        databaseReady = false;
        log("database_not_ready");
        return false;
      } finally { initializing = null; }
    })();
    return initializing;
  };
  await app.locals.initialize();
  let schedulerBusy = false;
  const schedulerTick = async () => {
    if (!publishing || !ready() || schedulerBusy) return;
    schedulerBusy = true;
    try { await publishing.runScheduler(); }
    catch (error) { log("scheduled_worker_failed", { reason: error instanceof AppError ? error.code : "internal_error" }); }
    finally { schedulerBusy = false; }
  };
  app.locals.runPublishingScheduler = schedulerTick;
  const scheduler = setInterval(() => { void schedulerTick(); }, 15000);
  scheduler.unref();
  app.locals.stopPublishingScheduler = () => clearInterval(scheduler);

  app.get("/health", (_req, res) => res.json({ ok: true, service: "instagram-publisher-backend", secureStorageReady: ready() }));
  app.get("/ready", wrap(async (_req, res) => {
    const ok = await app.locals.initialize();
    res.status(ok ? 200 : 503).json({ ok });
  }));
  app.get("/api/session", wrap(async (req, res) => res.json({
    ready: ready(), authenticated: Boolean(await session(req)),
    providers: { facebook: ready() && providerReady("facebook"), instagram: ready() && providerReady("instagram") }
  })));
  app.post("/auth/login", requireReady, requireOrigin, wrap(async (req, res) => {
    if (!loginGlobal("owner") || !loginIP(req.ip)) throw new AppError(429, "login_rate_limit");
    if (!await owner.verify(req.body?.password)) throw new AppError(401, "invalid_login");
    const token = randomToken();
    await db.transaction(async (client) => {
      const old = cookieToken(req, COOKIE);
      if (old) await client.query("DELETE FROM publisher_sessions WHERE session_hash=$1", [hash(old)]);
      await client.query("DELETE FROM publisher_sessions WHERE expires_at<=NOW() OR auth_version<>$1", [owner.version]);
      await client.query("INSERT INTO publisher_sessions(session_hash,auth_version,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')", [hash(token), owner.version]);
    });
    setCookie(res, token);
    res.json({ ok: true });
  }));
  app.post("/auth/logout", requireReady, requireOrigin, requireSession, wrap(async (req, res) => {
    await db.query("DELETE FROM publisher_sessions WHERE session_hash=$1", [req.sessionHash]);
    setCookie(res, "", true);
    res.json({ ok: true });
  }));

  function beginOAuth(provider) {
    return wrap(async (req, res) => {
      if (!providerReady(provider)) throw new AppError(503, "provider_not_configured");
      if (req.get("sec-fetch-site") === "cross-site") throw new AppError(403, "origin_rejected");
      if (!oauthLimit(req.sessionHash)) throw new AppError(429, "connection_rate_limit");
      const state = randomToken();
      await db.query("DELETE FROM publisher_oauth_attempts WHERE expires_at<NOW()-INTERVAL '1 day'");
      await db.query(
        "INSERT INTO publisher_oauth_attempts(state_hash,provider,session_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')",
        [hash(state), provider, req.sessionHash]);
      res.redirect(303, meta.authorizationUrl(provider, state));
    });
  }
  app.get("/auth/meta/start", requireReady, requireSession, beginOAuth("facebook"));
  app.get("/auth/instagram/start", requireReady, requireSession, beginOAuth("instagram"));
  app.get("/auth/meta/login", (_req, res) => res.redirect(303, "/auth/meta/start"));

  app.get("/auth/meta/callback", async (req, res) => {
    let claimed;
    const finish = (notice) => res.redirect(303, `/?notice=${notice}`);
    try {
      if (!ready()) return finish("setup_required");
      const sessionHash = await session(req);
      const state = req.query.state;
      if (!sessionHash || !validToken(state)) return finish("connection_invalid");
      const result = await db.query(
        `UPDATE publisher_oauth_attempts SET status='processing',updated_at=NOW()
         WHERE state_hash=$1 AND session_hash=$2 AND status='pending' AND expires_at>NOW() RETURNING *`, [hash(state), sessionHash]);
      claimed = result.rows[0];
      if (!claimed) {
        const previous = await db.query("SELECT status FROM publisher_oauth_attempts WHERE state_hash=$1 AND session_hash=$2 AND expires_at>NOW()", [hash(state), sessionHash]);
        const status = previous.rows[0]?.status;
        return finish(status === "complete" ? "connected" : status === "processing" ? "connection_processing" : "connection_invalid");
      }
      if (typeof req.query.error === "string") {
        await db.query("UPDATE publisher_oauth_attempts SET status='cancelled',updated_at=NOW() WHERE state_hash=$1", [claimed.state_hash]);
        return finish("connection_cancelled");
      }
      if (typeof req.query.code !== "string" || !req.query.code || req.query.code.length > 4096 || !providerReady(claimed.provider)) {
        throw new AppError(400, "connection_invalid");
      }
      const token = await meta.exchange(claimed.provider, req.query.code);
      const accounts = await meta.discover(claimed.provider, token);
      await db.transaction(async (client) => {
        const active = await client.query("SELECT 1 FROM publisher_sessions WHERE session_hash=$1 AND auth_version=$2 AND expires_at>NOW() FOR UPDATE", [sessionHash, owner.version]);
        if (!active.rows.length) throw new AppError(401, "sign_in_required");
        for (const account of accounts) {
          await client.query(
            `INSERT INTO publisher_accounts(provider,account_id,username,display_name,encrypted_token,token_expires_at,scopes)
             VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider,account_id) DO UPDATE SET
             username=EXCLUDED.username,display_name=EXCLUDED.display_name,encrypted_token=EXCLUDED.encrypted_token,
             token_expires_at=EXCLUDED.token_expires_at,scopes=EXCLUDED.scopes,needs_reconnect=FALSE,token_refreshed_at=NOW(),updated_at=NOW()`,
            [account.provider, account.id, account.username || null, account.name || null,
              encryptToken(account.token, config.key, `${account.provider}:${account.id}`),
              account.expires ? new Date(Date.now()+account.expires*1000) : null, account.scopes]);
        }
        await client.query("UPDATE publisher_oauth_attempts SET status='complete',updated_at=NOW() WHERE state_hash=$1", [claimed.state_hash]);
      });
      return finish(accounts.length ? "connected" : "no_accounts");
    } catch (error) {
      log("oauth_callback_failed", error instanceof MetaError ? { code: error.code, subcode: error.subcode } : {});
      if (claimed) await db.query("UPDATE publisher_oauth_attempts SET status='failed',updated_at=NOW() WHERE state_hash=$1 AND status='processing'", [claimed.state_hash]).catch(() => {});
      return finish("connection_failed");
    }
  });

  app.use("/api", requireReady, requireSession, (req, _res, next) => {
    if (!apiLimit(req.sessionHash)) throw new AppError(429, "request_rate_limit");
    if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(req, config.origin)) throw new AppError(403, "origin_rejected");
    next();
  });
  app.get("/api/accounts", wrap(async (_req, res) => {
    const result = await db.query(
      `SELECT id::text AS connection_id,provider,account_id,username,display_name,token_expires_at,
       (needs_reconnect OR (token_expires_at IS NOT NULL AND token_expires_at<=NOW())) AS needs_reconnect,
       scopes,updated_at FROM publisher_accounts ORDER BY username NULLS LAST,id`);
    res.json({ accounts: result.rows });
  }));
  app.delete("/api/accounts/:id", wrap(async (req, res) => {
    if (!validId(req.params.id)) throw new AppError(400, "invalid_account");
    const result = await db.query("DELETE FROM publisher_accounts WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows.length) throw new AppError(404, "account_not_found");
    res.json({ ok: true });
  }));
  app.post("/api/accounts/:id/refresh", wrap(async (req, res) => {
    if (!validId(req.params.id)) throw new AppError(400, "invalid_account");
    await publishing.usableAccount(req.params.id);
    res.json({ ok: true });
  }));
  app.get("/api/jobs", wrap(async (_req, res) => res.json({ jobs: await publishing.list() })));
  app.post("/api/assets", express.raw({ type: ["video/mp4", "video/quicktime", "application/octet-stream"], limit: MAX_MEDIA_BYTES }), wrap(async (req, res) => {
    let fileName = req.get("x-file-name") || "reel.mp4";
    try { fileName = decodeURIComponent(fileName); } catch { throw new AppError(400, "invalid_upload"); }
    const asset = await publishing.uploadAsset({ data: req.body, fileName, requestKey: req.get("idempotency-key") });
    res.status(201).json({ asset });
  }));
  app.post("/api/batches", wrap(async (req, res) => {
    const batch = await publishing.createBatch(req.body || {}, req.get("idempotency-key"));
    void schedulerTick();
    res.status(202).json({ batch });
  }));
  app.post("/api/batches/:id/resume", wrap(async (req, res) => {
    const batch = await publishing.resumeBatch(req.params.id);
    void schedulerTick();
    res.json({ batch });
  }));
  for (const [route, type] of [["image", "image"], ["reels", "reel"]]) {
    app.post(`/api/publish/${route}`, wrap(async (req, res) => {
      const job = await publishing.create(type, req.body || {}, req.get("idempotency-key"));
      res.status(job.status === "published" ? 200 : 202).json({ job });
    }));
  }
  app.post("/api/jobs/:id/publish", wrap(async (req, res) => {
    const job = await publishing.advance(req.params.id);
    if (["published", "failed", "unknown"].includes(job.status)) {
      await publishing.settleBatch(job.id, job.status, job.error_code);
    }
    res.status(["published", "failed", "unknown"].includes(job.status) ? 200 : 202).json({ job });
  }));

  const serveMedia = wrap(async (req, res) => {
    const asset = await publishing.publicAsset(req.params.id, req.params.token);
    if (!asset) return res.status(404).end();
    const fileName = encodeURIComponent(asset.file_name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({
      "Content-Type": asset.content_type, "Content-Length": String(asset.size_bytes),
      "Content-Disposition": `inline; filename*=UTF-8''${fileName}`,
      "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex, nofollow, noarchive"
    });
    if (req.method === "HEAD") return res.status(200).end();
    res.status(200).send(Buffer.from(asset.data));
  });
  app.get("/media/:id/:token", serveMedia);
  app.head("/media/:id/:token", serveMedia);

  const publicPath = path.join(__dirname, "../public");
  app.get(["/", "/studio"], (_req, res) => res.sendFile(path.join(publicPath, "index.html")));
  app.use(express.static(publicPath, { dotfiles: "deny", index: false, redirect: false }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, _req, res, _next) => {
    const status = error instanceof AppError ? error.status : error.type === "entity.parse.failed" ? 400
      : error.type === "entity.too.large" ? 413 : 503;
    const code = error instanceof AppError ? error.code : status === 400 ? "invalid_json"
      : status === 413 ? "request_too_large" : "temporarily_unavailable";
    if (status === 429) res.set("Retry-After", "60");
    log("request_rejected", { status, reason: code });
    res.status(status).json({ error: code });
  });
  return app;
}

module.exports = { createApp };
