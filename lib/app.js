"use strict";

const path = require("node:path");
const express = require("express");
const {
  hash, randomToken, validToken, validId, readConfig, encryptToken,
  passwordVerifier, cookieToken, sameOrigin, rateLimiter
} = require("./security");
const { createMetaClient, MetaError } = require("./meta");
const { initializeDatabase } = require("./database");
const { createPublishing, mediaLimitFromEnv, AppError, MAX_MEDIA_BYTES, PART_BYTES } = require("./publishing");
const { parseByteRange, streamChunks } = require("./media");
const { createFrames, MAX_IMAGE_BYTES } = require("./frames");
const { createDmSender } = require("./dm");
const { createTelegram } = require("./telegram");
const { createCreatorChecker } = require("./checks");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const COOKIE = "igpub_owner";
const DATABASE_CONNECTION_CODES = new Set([
  "57P01", "57P02", "57P03", "53300", "ECONNABORTED", "EPIPE",
  "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"
]);
function isDatabaseConnectionError(error) {
  const code = error?.code;
  return typeof code === "string" &&
    (/^08[A-Z0-9]{3}$/.test(code) || code.startsWith("ECONN") || DATABASE_CONNECTION_CODES.has(code));
}

async function createApp({ env = process.env, db = null, fetchImpl = fetch, logger = () => {}, metaTimeoutMs = 20000, frameOptions = {}, dmOptions = {}, checkOptions = {}, telegramOptions = {} } = {}) {
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
  function markDatabaseUnavailable(error) {
    if (!isDatabaseConnectionError(error)) return false;
    databaseReady = false;
    log("database_query_failed", { code: error.code });
    return true;
  }
  const publishing = db ? createPublishing({ db, meta, key: config.key, log, origin: config.origin, mediaLimitBytes: mediaLimitFromEnv(env) }) : null;
  const frames = publishing ? createFrames({ db, readAssetChunk: publishing.readAssetChunk, replaceAssetData: publishing.replaceAssetData, log, ...frameOptions }) : null;
  // The Telegram bot hears the DM worker's alerts and hands it the owner's answers.
  let telegram = null;
  const dm = db ? createDmSender({ db, env, fetchImpl, log, onEvent: (event, details) => telegram?.alert(event, details), ...dmOptions }) : null;
  telegram = db ? createTelegram({ db, env, fetchImpl, log, dm, kick: () => { void dmTick(); }, origin: config.origin || "", ...telegramOptions }) : null;
  const checks = db ? createCreatorChecker({ db, meta, key: config.key, env, log, ...checkOptions }) : null;
  const loginIP = rateLimiter({ limit: 5, windowMs: 15 * 60000 });
  const loginGlobal = rateLimiter({ limit: 30, windowMs: 60 * 60000 });
  const oauthLimit = rateLimiter({ limit: 40, windowMs: 60 * 60000 });
  const apiLimit = rateLimiter({ limit: 120, windowMs: 60000 });
  const partLimit = rateLimiter({ limit: 600, windowMs: 60000 });

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
  // DM campaign lists can hold up to 2,000 usernames; other requests stay small.
  const smallJson = express.json({ limit: "32kb" });
  const dmJson = express.json({ limit: "128kb" });
  // A creator list to check can hold up to 10,000 usernames or links.
  const checkJson = express.json({ limit: "1mb" });
  app.use((req, res, next) => (req.path.startsWith("/api/dm/") ? dmJson : req.path === "/api/checks" ? checkJson : smallJson)(req, res, next));

  function setCookie(res, token, clear = false) {
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: "lax", secure: config.secureCookie,
      path: "/", maxAge: clear ? 0 : 30 * 86400000
    });
  }
  function requireReady(_req, _res, next) {
    if (!configured()) throw new AppError(503, "setup_required");
    if (!databaseReady) throw new AppError(503, "temporarily_unavailable");
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

  app.locals.isDatabaseReady = () => databaseReady;
  app.locals.markDatabaseUnavailable = () => { databaseReady = false; };
  app.locals.initialize = async () => {
    if (!configured()) return false;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        if (databaseReady) await db.query("SELECT 1");
        else await initializeDatabase(db);
        databaseReady = true;
        return true;
      } catch (error) {
        databaseReady = false;
        if (isDatabaseConnectionError(error)) log("database_query_failed", { code: error.code });
        log("database_not_ready");
        return false;
      } finally { initializing = null; }
    })();
    return initializing;
  };
  await app.locals.initialize();
  let schedulerBusy = false, schedulerStopped = false, schedulerRun = null;
  const schedulerTick = async () => {
    if (!publishing || !ready() || schedulerBusy || schedulerStopped) return;
    schedulerBusy = true;
    schedulerRun = (async () => {
      try { await publishing.runScheduler(); }
      catch (error) {
        markDatabaseUnavailable(error);
        log("scheduled_worker_failed", { reason: error instanceof AppError ? error.code : "internal_error" });
      }
      finally { schedulerBusy = false; schedulerRun = null; }
    })();
    return schedulerRun;
  };
  app.locals.runPublishingScheduler = schedulerTick;
  const scheduler = setInterval(() => { void schedulerTick(); }, 15000);
  scheduler.unref();
  // Frames queued Reels one at a time, separately from publishing, so a long
  // render never delays a Reel that is already due. A render cut off by a
  // restart is started again by the next process (lib/frames.js).
  let framesBusy = false, framesRun = null;
  const frameTick = async () => {
    if (!frames || !ready() || framesBusy || schedulerStopped) return;
    framesBusy = true;
    framesRun = (async () => {
      try {
        // Keep going while there is work, then wait for the next tick.
        while (!schedulerStopped && ready() && await frames.renderNext()) { /* next one */ }
      } catch (error) {
        markDatabaseUnavailable(error);
        log("frame_worker_failed", { reason: error instanceof AppError ? error.code : "internal_error" });
      } finally { framesBusy = false; framesRun = null; }
    })();
    return framesRun;
  };
  app.locals.runFrameWorker = frameTick;
  const frameTimer = setInterval(() => { void frameTick(); }, 10000);
  frameTimer.unref();
  // DM Sender (lib/dm.js): sends at most one message per running campaign per tick.
  const dmTick = () => (dm && ready() && !schedulerStopped ? dm.runOnce() : Promise.resolve());
  app.locals.runDmWorker = dmTick;
  const dmTimer = dmOptions.intervalMs === 0 ? null : setInterval(() => { void dmTick(); }, dmOptions.intervalMs || 15000);
  dmTimer?.unref();
  // Telegram bot (lib/telegram.js): announces new replies and answer results.
  const telegramTick = () => (telegram && ready() && !schedulerStopped ? telegram.runOnce() : Promise.resolve());
  app.locals.runTelegram = telegramTick;
  const telegramTimer = telegramOptions.intervalMs === 0 ? null : setInterval(() => { void telegramTick(); }, telegramOptions.intervalMs || 20000);
  telegramTimer?.unref();
  if (telegram?.enabled() && ready() && telegramOptions.setup !== false) void telegram.setup();
  // Creator list check (lib/checks.js): paces itself, so a frequent tick is cheap.
  const checkTick = () => (checks && ready() && !schedulerStopped ? checks.runOnce() : Promise.resolve());
  app.locals.runCheckWorker = checkTick;
  const checkTimer = checkOptions.intervalMs === 0 ? null : setInterval(() => { void checkTick(); }, checkOptions.intervalMs || 5000);
  checkTimer?.unref();
  // Stops new runs and waits for one in progress, so a restart (e.g. a deploy)
  // never cuts a publish off between "publishing" and "published". Open DM
  // browsers are stopped, which also saves their Instagram login.
  app.locals.stopPublishingScheduler = async () => {
    schedulerStopped = true;
    clearInterval(scheduler);
    clearInterval(frameTimer);
    if (dmTimer) clearInterval(dmTimer);
    if (checkTimer) clearInterval(checkTimer);
    if (telegramTimer) clearInterval(telegramTimer);
    await Promise.all([schedulerRun, dm?.shutdown(), checks?.shutdown(), telegram?.shutdown()]);
  };

  app.get("/health", (_req, res) => res.json({ ok: true, service: "instagram-publisher-backend", secureStorageReady: ready() }));
  // Telegram's webhook: checked against the secret header inside handleUpdate.
  // Anything but a bad secret answers 200, so Telegram does not resend it.
  app.post("/telegram/webhook", wrap(async (req, res) => {
    if (!telegram || !ready()) throw new AppError(503, "temporarily_unavailable");
    try { await telegram.handleUpdate(req.body || {}, req.get("X-Telegram-Bot-Api-Secret-Token") || ""); }
    catch (error) {
      if (error instanceof AppError && error.status === 403) throw error;
      log("telegram_update_failed", { reason: error?.code || "error" });
    }
    res.json({ ok: true });
  }));
  app.get("/ready", wrap(async (_req, res) => {
    const ok = await app.locals.initialize();
    res.status(ok ? 200 : 503).json({ ok });
  }));
  app.get("/api/session", wrap(async (req, res) => {
    if (configured() && !databaseReady) throw new AppError(503, "temporarily_unavailable");
    res.json({
      ready: ready(), authenticated: Boolean(await session(req)),
      providers: { facebook: ready() && providerReady("facebook"), instagram: ready() && providerReady("instagram") }
    });
  }));
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
      // ?extra=insights also asks for the creator list check permission.
      res.redirect(303, meta.authorizationUrl(provider, state, req.query.extra === "insights" ? "insights" : null));
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
      // Why nothing was found: Pages seen, Pages with a linked Instagram account, granted permissions.
      if (!accounts.length) log("connection_no_accounts", { provider: claimed.provider, ...(accounts.seen || {}) });
      return finish(accounts.length ? "connected" : "no_accounts");
    } catch (error) {
      const missing = error instanceof MetaError ? error.missing : null;
      log("oauth_callback_failed", {
        ...(claimed ? { provider: claimed.provider } : {}),
        ...(error instanceof MetaError ? { code: error.code, subcode: error.subcode } : {}),
        ...(missing ? { missing } : {})
      });
      if (claimed) await db.query("UPDATE publisher_oauth_attempts SET status='failed',updated_at=NOW() WHERE state_hash=$1 AND status='processing'", [claimed.state_hash]).catch(() => {});
      return finish(missing ? "connection_permissions" : "connection_failed");
    }
  });

  app.use("/api", requireReady, requireSession, (req, _res, next) => {
    // Video parts have their own, larger allowance: a 250 MB video is 63 parts.
    const limiter = req.method === "PUT" && /^\/assets\/uploads\/[^/]+\/parts\//.test(req.path) ? partLimit : apiLimit;
    if (!limiter(req.sessionHash)) throw new AppError(429, "request_rate_limit");
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
  app.get("/api/progress", wrap(async (_req, res) => res.json({ progress: await publishing.listProgress() })));
  app.put("/api/accounts/:id/progress", wrap(async (req, res) => {
    const progress = await publishing.updateProgress(req.params.id, req.body || {});
    res.json({ progress });
  }));
  app.delete("/api/accounts/:id", wrap(async (req, res) => {
    if (!validId(req.params.id)) throw new AppError(400, "invalid_account");
    await publishing.removeAccount(req.params.id);
    res.json({ ok: true });
  }));
  app.post("/api/accounts/:id/refresh", wrap(async (req, res) => {
    if (!validId(req.params.id)) throw new AppError(400, "invalid_account");
    await publishing.usableAccount(req.params.id);
    res.json({ ok: true });
  }));
  app.get("/api/jobs", wrap(async (req, res) => {
    // ?connection_id=<account> limits Activity to the account picked in the dashboard.
    const accountId = req.query.connection_id;
    if (accountId !== undefined && !(validId(accountId) && accountId.length <= 18)) throw new AppError(400, "invalid_account");
    res.json({ jobs: await publishing.list(accountId ?? null) });
  }));
  app.get("/api/storage", wrap(async (_req, res) => res.json({ storage: await publishing.storageUsage() })));
  app.post("/api/assets", express.raw({ type: ["video/mp4", "video/quicktime", "application/octet-stream"], limit: MAX_MEDIA_BYTES }), wrap(async (req, res) => {
    let fileName = req.get("x-file-name") || "reel.mp4";
    try { fileName = decodeURIComponent(fileName); } catch { throw new AppError(400, "invalid_upload"); }
    const asset = await publishing.uploadAsset({ data: req.body, fileName, requestKey: req.get("idempotency-key") });
    res.status(201).json({ asset });
  }));
  // Videos over 50 MB are sent in 4 MB parts: start, send each part, complete.
  app.post("/api/assets/uploads", wrap(async (req, res) => {
    res.status(201).json({ upload: await publishing.startUpload(req.body || {}, req.get("idempotency-key")) });
  }));
  app.put("/api/assets/uploads/:id/parts/:part", express.raw({ type: () => true, limit: PART_BYTES }), wrap(async (req, res) => {
    res.json(await publishing.uploadPart(req.params.id, req.params.part, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
  }));
  app.post("/api/assets/uploads/:id/complete", wrap(async (req, res) => {
    res.json({ asset: await publishing.completeUpload(req.params.id) });
  }));
  app.post("/api/batches", wrap(async (req, res) => {
    const batch = await publishing.createBatch(req.body || {}, req.get("idempotency-key"));
    void frameTick();
    void schedulerTick();
    res.status(202).json({ batch });
  }));
  // Reel frame look per account (lib/frames.js).
  app.get("/api/accounts/:id/frame", wrap(async (req, res) => res.json({ frame: await frames.getSettings(req.params.id) })));
  app.put("/api/accounts/:id/frame", wrap(async (req, res) => res.json({ frame: await frames.updateSettings(req.params.id, req.body || {}) })));
  const imageBody = express.raw({ type: ["image/jpeg", "image/png", "image/webp", "application/octet-stream"], limit: MAX_IMAGE_BYTES });
  for (const kind of ["background", "art"]) {
    app.put(`/api/accounts/:id/frame/${kind}`, imageBody, wrap(async (req, res) => {
      res.json({ frame: await frames.setImage(req.params.id, kind, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) });
    }));
    app.delete(`/api/accounts/:id/frame/${kind}`, wrap(async (req, res) => {
      res.json({ frame: await frames.setImage(req.params.id, kind, null) });
    }));
  }
  app.get("/api/accounts/:id/frame/preview", wrap(async (req, res) => {
    const title = typeof req.query.title === "string" ? req.query.title.slice(0, 120) : "";
    const png = await frames.renderSettingsPreview(req.params.id, title);
    res.set({ "Content-Type": "image/png", "Cache-Control": "no-store" }).send(png);
  }));
  app.post("/api/batches/:id/resume", wrap(async (req, res) => {
    const batch = await publishing.resumeBatch(req.params.id);
    void schedulerTick();
    res.json({ batch });
  }));
  app.post("/api/batches/:id/cancel", wrap(async (req, res) => {
    res.json({ batch: await publishing.cancelBatch(req.params.id) });
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

  // DM Sender: campaigns of creators who asked for promotion details.
  app.get("/api/dm", wrap(async (_req, res) => res.json(await dm.status())));
  app.get("/api/dm/profiles", wrap(async (_req, res) => res.json({ profiles: await dm.listProfiles() })));
  app.post("/api/dm/campaigns", wrap(async (req, res) => res.status(201).json(await dm.createCampaign(req.body || {}))));
  app.get("/api/dm/campaigns/:id", wrap(async (req, res) => res.json(await dm.getCampaign(req.params.id))));
  app.put("/api/dm/campaigns/:id", wrap(async (req, res) => res.json(await dm.updateCampaign(req.params.id, req.body || {}))));
  app.delete("/api/dm/campaigns/:id", wrap(async (req, res) => res.json(await dm.deleteCampaign(req.params.id))));
  app.post("/api/dm/campaigns/:id/targets", wrap(async (req, res) => res.json(await dm.addTargets(req.params.id, req.body || {}))));
  app.post("/api/dm/campaigns/:id/start", wrap(async (req, res) => {
    const result = await dm.startCampaign(req.params.id, req.body || {});
    void dmTick();
    res.json(result);
  }));
  app.post("/api/dm/campaigns/:id/pause", wrap(async (req, res) => res.json(await dm.pauseCampaign(req.params.id))));
  app.post("/api/dm/campaigns/:id/retry-failed", wrap(async (req, res) => res.json(await dm.retryFailed(req.params.id))));
  // Telegram bot link and saved answers.
  app.get("/api/telegram", wrap(async (_req, res) => res.json(await telegram.status())));
  app.post("/api/telegram/link", wrap(async (_req, res) => res.json(await telegram.createLink())));
  app.delete("/api/telegram", wrap(async (_req, res) => res.json(await telegram.unlink())));
  app.get("/api/dm/templates", wrap(async (_req, res) => res.json({ templates: await telegram.templates() })));
  app.post("/api/dm/templates", wrap(async (req, res) => res.status(201).json(await telegram.addTemplate(req.body || {}))));
  app.delete("/api/dm/templates/:id", wrap(async (req, res) => res.json(await telegram.deleteTemplate(req.params.id))));
  // Replies, per Instagram account: who wrote back, and answers the owner types.
  app.get("/api/dm/replies", wrap(async (_req, res) => res.json(await dm.replies())));
  app.post("/api/dm/replies/check", wrap(async (req, res) => {
    const result = await dm.requestCheck(req.body || {});
    void dmTick();
    res.json(result);
  }));
  app.post("/api/dm/replies/:id/answer", wrap(async (req, res) => {
    const result = await dm.answerReply(req.params.id, req.body || {});
    void dmTick();
    res.json(result);
  }));
  app.post("/api/dm/replies/:id/done", wrap(async (req, res) => res.json(await dm.closeReply(req.params.id))));

  // Creator list check: which usernames are still professional accounts and post recently.
  app.get("/api/checks", wrap(async (_req, res) => res.json(await checks.status())));
  app.post("/api/checks", wrap(async (req, res) => {
    const result = await checks.createCheck(req.body || {});
    void checkTick();
    res.status(201).json(result);
  }));
  app.get("/api/checks/:id", wrap(async (req, res) => res.json(await checks.getCheck(req.params.id, String(req.query.filter || "all"), Number(req.query.limit) || 200))));
  app.get("/api/checks/:id/usernames", wrap(async (req, res) => res.json(await checks.usernames(req.params.id, String(req.query.filter || "active")))));
  app.post("/api/checks/:id/pause", wrap(async (req, res) => res.json(await checks.pauseCheck(req.params.id))));
  app.post("/api/checks/:id/start", wrap(async (req, res) => {
    const result = await checks.startCheck(req.params.id);
    void checkTick();
    res.json(result);
  }));
  app.delete("/api/checks/:id", wrap(async (req, res) => res.json(await checks.deleteCheck(req.params.id))));

  // Meta downloads Reels from here. HEAD reads no video bytes, and GET streams
  // 1 MB slices (with Range support) so Postgres never loads a whole video.
  const serveMedia = wrap(async (req, res) => {
    const asset = await publishing.publicAsset(req.params.id, req.params.token);
    if (!asset) return res.status(404).end();
    const size = asset.size_bytes;
    const fileName = encodeURIComponent(asset.file_name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set({
      "Content-Type": asset.content_type, "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename*=UTF-8''${fileName}`,
      "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex, nofollow, noarchive"
    });
    const range = parseByteRange(req.get("range"), size);
    if (range === false) {
      res.set("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    const { start, end } = range || { start: 0, end: size - 1 };
    res.status(range ? 206 : 200).set("Content-Length", String(end - start + 1));
    if (range) res.set("Content-Range", `bytes ${start}-${end}/${size}`);
    if (req.method === "HEAD") return res.end();
    try {
      await streamChunks(res, { start, end, readChunk: (offset, length) => publishing.readAssetChunk(asset.id, offset, length) });
    } catch (error) {
      if (!res.headersSent) {
        for (const header of ["Content-Type", "Accept-Ranges", "Content-Range", "Content-Disposition", "Content-Length"]) res.removeHeader(header);
        res.set("Cache-Control", "no-store");
        throw error;
      }
      markDatabaseUnavailable(error);
      log("media_stream_failed");
      res.destroy();
    }
  });
  app.get("/media/:id/:token", serveMedia);
  app.head("/media/:id/:token", serveMedia);

  const publicPath = path.join(__dirname, "../public");
  app.get(["/", "/studio"], (_req, res) => res.sendFile(path.join(publicPath, "index.html")));
  app.use(express.static(publicPath, { dotfiles: "deny", index: false, redirect: false }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, _req, res, _next) => {
    markDatabaseUnavailable(error);
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

module.exports = { createApp, isDatabaseConnectionError };
