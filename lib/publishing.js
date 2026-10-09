"use strict";

const crypto = require("node:crypto");
const { hash, validId, publicMediaUrl, encryptToken, decryptToken } = require("./security");
const { MetaError, metaId } = require("./meta");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_MEDIA_BYTES = 500 * 1024 * 1024;

class AppError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function metaErrorCode(error) {
  if ([102, 190].includes(error.code)) return "reconnect_required";
  if ([10, 200].includes(error.code)) return "permission_required";
  if ([4, 17, 32, 613].includes(error.code)) return "meta_rate_limit";
  return error.uncertain ? "meta_unavailable" : "meta_rejected";
}

function publicJob(job) {
  return {
    id: job.id, connection_id: job.account_row_id ? String(job.account_row_id) : null,
    account: job.account_name, media_type: job.media_type, status: job.status,
    creation_id: job.creation_id, published_media_id: job.published_media_id,
    error_code: job.error_code, next_check_at: job.next_check_at, created_at: job.created_at,
    scheduled_at: job.scheduled_at, batch_id: job.batch_id, batch_position: job.batch_position,
    batch_count: job.batch_count, interval_minutes: job.interval_minutes,
    batch_status: job.batch_status, batch_pause_reason: job.batch_pause_reason,
    media_name: job.media_name
  };
}

function createPublishing({ db, meta, key, log, origin }) {
  function mediaAccessToken(assetId) {
    return crypto.createHmac("sha256", key).update(`publisher-media-v1:${assetId}`).digest("base64url");
  }

  function mediaUrl(assetId) {
    return new URL(`/media/${assetId}/${mediaAccessToken(assetId)}`, origin).href;
  }

  function validMediaToken(assetId, token) {
    if (!UUID.test(assetId || "") || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const expected = Buffer.from(mediaAccessToken(assetId));
    const received = Buffer.from(token);
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  }

  function safeFileName(value) {
    const leaf = typeof value === "string" ? value.split(/[\\/]/).pop() : "";
    const clean = (leaf || "reel.mp4").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
    return clean || "reel.mp4";
  }

  function detectVideoType(data) {
    if (!Buffer.isBuffer(data) || data.length < 12 || data.toString("ascii", 4, 8) !== "ftyp") return null;
    const brand = data.toString("ascii", 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash", "MSNV", "F4V ", "3gp4"].includes(brand)) {
      return "video/mp4";
    }
    return null;
  }

  async function uploadAsset({ data, fileName, requestKey }) {
    if (!UUID.test(requestKey || "")) throw new AppError(400, "idempotency_key_required");
    if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, "invalid_upload");
    if (data.length > MAX_MEDIA_BYTES) throw new AppError(413, "upload_too_large");
    const contentType = detectVideoType(data);
    if (!contentType) throw new AppError(400, "invalid_video_format");
    const name = safeFileName(fileName);
    const payloadHash = hash(JSON.stringify([contentType, name, data.length, hash(data)]));
    const previous = await db.query("SELECT id::text AS id, payload_hash, file_name, size_bytes::text FROM publisher_media_assets WHERE upload_key=$1", [requestKey]);
    if (previous.rows.length) {
      if (previous.rows[0].payload_hash !== payloadHash) throw new AppError(409, "idempotency_conflict");
      return { asset_id: previous.rows[0].id, file_name: previous.rows[0].file_name, size_bytes: Number(previous.rows[0].size_bytes) };
    }
    const usage = await db.query("SELECT COALESCE(SUM(size_bytes),0)::text AS bytes FROM publisher_media_assets WHERE expires_at>NOW()");
    if (Number(usage.rows[0]?.bytes || 0) + data.length > MAX_ACTIVE_MEDIA_BYTES) throw new AppError(413, "upload_storage_full");
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO publisher_media_assets(id,upload_key,payload_hash,access_token_hash,file_name,content_type,size_bytes,data,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+INTERVAL '7 days')`,
      [id, requestKey, payloadHash, hash(mediaAccessToken(id)), name, contentType, data.length, data]);
    return { asset_id: id, file_name: name, size_bytes: data.length };
  }

  async function publicAsset(assetId, token) {
    if (!validMediaToken(assetId, token)) return null;
    const result = await db.query(
      "SELECT content_type,file_name,size_bytes,data FROM publisher_media_assets WHERE id=$1 AND access_token_hash=$2 AND expires_at>NOW()",
      [assetId, hash(token)]);
    return result.rows[0] || null;
  }
  async function noteMetaError(account, error) {
    if (error instanceof MetaError) {
      log("meta_request_failed", { code: error.code, subcode: error.subcode });
      if ([102, 190].includes(error.code)) {
        await db.query("UPDATE publisher_accounts SET needs_reconnect=TRUE WHERE id=$1", [account.id]);
      }
    }
  }

  async function usableAccount(id) {
    const result = await db.query("SELECT * FROM publisher_accounts WHERE id=$1", [id]);
    const account = result.rows[0];
    if (!account) throw new AppError(404, "account_not_found");
    if (account.needs_reconnect || (account.token_expires_at && new Date(account.token_expires_at).getTime() <= Date.now())) {
      throw new AppError(409, "reconnect_required");
    }
    let token;
    try { token = decryptToken(account.encrypted_token, key, `${account.provider}:${account.account_id}`); }
    catch { throw new AppError(503, "token_storage_unavailable"); }
    if (account.provider === "instagram" && account.token_expires_at &&
        new Date(account.token_expires_at).getTime() - Date.now() < 7 * DAY &&
        Date.now() - new Date(account.token_refreshed_at).getTime() > DAY) {
      try {
        const refreshed = await meta.refreshInstagram(token);
        const updated = await db.query(
          `UPDATE publisher_accounts SET encrypted_token=$1, token_expires_at=$2,
            token_refreshed_at=NOW(), updated_at=NOW() WHERE id=$3 AND encrypted_token=$4 RETURNING id`,
          [encryptToken(refreshed.access_token, key, `${account.provider}:${account.account_id}`),
            new Date(Date.now() + refreshed.expires_in * 1000), account.id, account.encrypted_token]);
        if (!updated.rows.length) throw new AppError(409, "connection_changed");
        token = refreshed.access_token;
      } catch (error) {
        await noteMetaError(account, error);
        throw error instanceof MetaError ? new AppError(502, metaErrorCode(error)) : error;
      }
    }
    return { ...account, token };
  }

  async function getJob(id) {
    const result = await db.query(
      `SELECT j.*,b.item_count AS batch_count,b.interval_minutes,b.status AS batch_status,
        b.pause_reason AS batch_pause_reason,a.file_name AS media_name
       FROM publisher_jobs j
       LEFT JOIN publisher_batches b ON b.id=j.batch_id
       LEFT JOIN publisher_media_assets a ON a.id=j.asset_id
       WHERE j.id=$1`, [id]);
    if (!result.rows.length) throw new AppError(404, "job_not_found");
    return result.rows[0];
  }

  async function getBatch(id) {
    const result = await db.query(
      `SELECT j.*,b.item_count AS batch_count,b.interval_minutes,b.status AS batch_status,
        b.pause_reason AS batch_pause_reason,a.file_name AS media_name
       FROM publisher_jobs j
       JOIN publisher_batches b ON b.id=j.batch_id
       LEFT JOIN publisher_media_assets a ON a.id=j.asset_id
       WHERE b.id=$1 ORDER BY j.batch_position`, [id]);
    if (!result.rows.length) throw new AppError(404, "batch_not_found");
    const first = result.rows[0];
    return {
      id, account: first.account_name, interval_minutes: first.interval_minutes,
      status: first.batch_status, pause_reason: first.batch_pause_reason,
      item_count: first.batch_count, jobs: result.rows.map(publicJob)
    };
  }

  async function createBatch(body, requestKey) {
    if (!UUID.test(requestKey || "")) throw new AppError(400, "idempotency_key_required");
    const accountId = typeof body.connection_id === "string" ? body.connection_id : "";
    const caption = body.caption ?? "";
    const interval = Number(body.interval_minutes);
    const assetIds = body.asset_ids;
    if (!validId(accountId) || typeof caption !== "string" || [...caption].length > 2200 ||
        ![10, 15, 30].includes(interval) || !Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 10 ||
        assetIds.some((id) => !UUID.test(id)) || new Set(assetIds).size !== assetIds.length) {
      throw new AppError(400, "invalid_batch");
    }
    const payloadHash = hash(JSON.stringify([accountId, caption, interval, assetIds]));
    const prior = await db.query("SELECT id::text AS id,payload_hash FROM publisher_batches WHERE request_key=$1", [requestKey]);
    if (prior.rows.length) {
      if (prior.rows[0].payload_hash !== payloadHash) throw new AppError(409, "idempotency_conflict");
      return getBatch(prior.rows[0].id);
    }
    const account = await usableAccount(accountId);
    let batchId;
    await db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO publisher_batches(id,request_key,payload_hash,account_row_id,account_name,caption,interval_minutes,item_count,next_position,next_publish_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,NOW()) ON CONFLICT(request_key) DO NOTHING RETURNING id::text AS id`,
        [crypto.randomUUID(), requestKey, payloadHash, account.id, account.username || account.account_id, caption, interval, assetIds.length]);
      if (!inserted.rows.length) {
        const existing = await client.query("SELECT id::text AS id,payload_hash FROM publisher_batches WHERE request_key=$1", [requestKey]);
        if (!existing.rows.length || existing.rows[0].payload_hash !== payloadHash) throw new AppError(409, "idempotency_conflict");
        batchId = existing.rows[0].id;
        return;
      }
      batchId = inserted.rows[0].id;
      const assets = await client.query(
        `SELECT id::text AS id FROM publisher_media_assets
         WHERE id=ANY($1::uuid[]) AND expires_at>NOW() AND assigned_batch_id IS NULL FOR UPDATE`, [assetIds]);
      if (assets.rows.length !== assetIds.length) throw new AppError(409, "asset_unavailable");
      await client.query("UPDATE publisher_media_assets SET assigned_batch_id=$1 WHERE id=ANY($2::uuid[])", [batchId, assetIds]);
      for (let index = 0; index < assetIds.length; index++) {
        const position = index + 1;
        await client.query(
          `INSERT INTO publisher_jobs(id,request_key,payload_hash,account_row_id,account_name,media_type,batch_id,batch_position,asset_id,scheduled_at,status,next_check_at)
           VALUES($1,$2,$3,$4,$5,'reel',$6,$7,$8,NOW()+($9::int * INTERVAL '1 minute'),'queued',NOW())`,
          [crypto.randomUUID(), crypto.randomUUID(), hash(JSON.stringify([batchId, position, assetIds[index]])), account.id,
            account.username || account.account_id, batchId, position, assetIds[index], interval * index]);
      }
    });
    return getBatch(batchId);
  }

  async function resumeBatch(id) {
    if (!UUID.test(id || "")) throw new AppError(400, "invalid_batch");
    await db.transaction(async (client) => {
      const result = await client.query(
        `UPDATE publisher_batches SET status='queued',pause_reason=NULL,next_publish_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND status='paused' AND active_job_id IS NULL AND next_position<=item_count
           AND pause_reason IS NOT NULL AND pause_reason<>'publish_uncertain' AND pause_reason<>'creation_uncertain'
         RETURNING next_position,interval_minutes`, [id]);
      if (!result.rows.length) throw new AppError(409, "batch_cannot_resume");
      const { next_position: nextPosition, interval_minutes: interval } = result.rows[0];
      await client.query(
        `UPDATE publisher_jobs SET scheduled_at=NOW()+((batch_position-$2)::int * $3::int * INTERVAL '1 minute')
         WHERE batch_id=$1 AND batch_position >= $2 AND status='queued'`, [id, nextPosition, Number(interval)]);
    });
    return getBatch(id);
  }

  async function settleBatch(jobId, status, errorCode = null) {
    const found = await db.query("SELECT id::text AS id,batch_id::text AS batch_id,batch_position FROM publisher_jobs WHERE id=$1", [jobId]);
    const job = found.rows[0];
    if (!job?.batch_id) return;
    await db.transaction(async (client) => {
      const result = await client.query("SELECT * FROM publisher_batches WHERE id=$1 FOR UPDATE", [job.batch_id]);
      const batch = result.rows[0];
      if (!batch || batch.active_job_id !== jobId) return;
      if (status === "unknown") {
        await client.query("UPDATE publisher_batches SET status='paused',pause_reason=$1,updated_at=NOW() WHERE id=$2", [errorCode || "publish_uncertain", job.batch_id]);
        return;
      }
      const nextPosition = Number(job.batch_position) + 1;
      if (status === "failed") {
        const state = nextPosition > batch.item_count ? "completed" : "paused";
        await client.query(
          `UPDATE publisher_batches SET status=$1,pause_reason=$2,active_job_id=NULL,
            next_position=$3,next_publish_at=NOW()+interval_minutes*INTERVAL '1 minute',updated_at=NOW() WHERE id=$4`,
          [state, state === "paused" ? (errorCode || "publish_failed") : null, nextPosition, job.batch_id]);
        return;
      }
      const state = nextPosition > batch.item_count ? "completed" : "queued";
      await client.query(
        `UPDATE publisher_batches SET status=$1,pause_reason=NULL,active_job_id=NULL,
          next_position=$2,next_publish_at=CASE WHEN $1='completed' THEN NOW() ELSE NOW()+interval_minutes*INTERVAL '1 minute' END,
          updated_at=NOW() WHERE id=$3`, [state, nextPosition, job.batch_id]);
      if (state === "queued") {
        await client.query(
          `UPDATE publisher_jobs SET scheduled_at=NOW()+((batch_position-$2)::int * $3::int * INTERVAL '1 minute')
           WHERE batch_id=$1 AND batch_position >= $2 AND status='queued'`,
          [job.batch_id, nextPosition, Number(batch.interval_minutes)]);
      }
    });
  }

  async function create(type, body, requestKey) {
    if (!UUID.test(requestKey || "")) throw new AppError(400, "idempotency_key_required");
    const id = typeof body.connection_id === "string" ? body.connection_id : "";
    const url = publicMediaUrl(type === "image" ? body.image_url : body.video_url);
    const caption = body.caption ?? "";
    if (!validId(id) || !url || typeof caption !== "string" || [...caption].length > 2200) {
      throw new AppError(400, "invalid_post");
    }
    const payloadHash = hash(JSON.stringify([id, type, url, caption]));
    const previous = await db.query("SELECT * FROM publisher_jobs WHERE request_key=$1", [requestKey]);
    if (previous.rows.length) {
      if (previous.rows[0].payload_hash !== payloadHash) throw new AppError(409, "idempotency_conflict");
      return publicJob(previous.rows[0]);
    }
    const account = await usableAccount(id);
    const inserted = await db.query(
      `INSERT INTO publisher_jobs(id,request_key,payload_hash,account_row_id,account_name,media_type)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_key) DO NOTHING RETURNING *`,
      [crypto.randomUUID(), requestKey, payloadHash, account.id, account.username || account.account_id, type]);
    if (!inserted.rows.length) {
      const duplicate = await db.query("SELECT * FROM publisher_jobs WHERE request_key=$1", [requestKey]);
      if (duplicate.rows[0].payload_hash !== payloadHash) throw new AppError(409, "idempotency_conflict");
      return publicJob(duplicate.rows[0]);
    }
    const job = inserted.rows[0];
    try {
      const fields = type === "image" ? { image_url: url, caption }
        : { media_type: "REELS", video_url: url, caption, share_to_feed: "true" };
      const container = await meta.graph(`${account.account_id}/media`, account.token, account.provider, "POST", fields);
      if (!metaId(container.id)) throw new MetaError({ uncertain: true });
      await db.query(
        "UPDATE publisher_jobs SET creation_id=$1,status='processing',updated_at=NOW() WHERE id=$2 AND status='creating'",
        [metaId(container.id), job.id]);
    } catch (error) {
      // A lost response or database write is ambiguous. Do not create another container.
      const uncertain = !(error instanceof MetaError) || error.uncertain;
      await db.query("UPDATE publisher_jobs SET status=$1,error_code=$2,updated_at=NOW() WHERE id=$3 AND status='creating'",
        [uncertain ? "unknown" : "failed", uncertain ? "creation_uncertain" : metaErrorCode(error), job.id]);
      await noteMetaError(account, error);
    }
    return publicJob(await getJob(job.id));
  }

  async function startQueued(jobId) {
    const result = await db.query(
      `SELECT j.*,b.caption FROM publisher_jobs j JOIN publisher_batches b ON b.id=j.batch_id
       WHERE j.id=$1 AND j.status='creating'`, [jobId]);
    const job = result.rows[0];
    if (!job) return null;
    let account;
    try {
      if (!job.asset_id) throw new AppError(409, "asset_unavailable");
      account = await usableAccount(String(job.account_row_id));
      const asset = await db.query(
        "SELECT 1 FROM publisher_media_assets WHERE id=$1 AND assigned_batch_id=$2 AND expires_at>NOW()",
        [job.asset_id, job.batch_id]);
      if (!asset.rows.length) throw new AppError(409, "asset_unavailable");
      const fields = { media_type: "REELS", video_url: mediaUrl(job.asset_id), caption: job.caption, share_to_feed: "true" };
      const container = await meta.graph(`${account.account_id}/media`, account.token, account.provider, "POST", fields);
      if (!metaId(container.id)) throw new MetaError({ uncertain: true });
      await db.query(
        "UPDATE publisher_jobs SET creation_id=$1,status='processing',next_check_at=NOW()+INTERVAL '60 seconds',error_code=NULL,updated_at=NOW() WHERE id=$2 AND status='creating'",
        [metaId(container.id), job.id]);
    } catch (error) {
      const uncertain = error instanceof MetaError ? error.uncertain : !(error instanceof AppError);
      const errorCode = error instanceof AppError ? error.code
        : uncertain ? "creation_uncertain" : metaErrorCode(error);
      await db.query("UPDATE publisher_jobs SET status=$1,error_code=$2,updated_at=NOW() WHERE id=$3 AND status='creating'",
        [uncertain ? "unknown" : "failed", errorCode, job.id]);
      if (account) await noteMetaError(account, error);
    }
    const updated = publicJob(await getJob(job.id));
    if (["failed", "unknown"].includes(updated.status)) await settleBatch(job.id, updated.status, updated.error_code);
    return updated;
  }

  async function claimNextBatchJob() {
    return db.transaction(async (client) => {
      const due = await client.query(
        `SELECT b.id::text AS batch_id,j.id::text AS job_id
         FROM publisher_batches b JOIN publisher_jobs j ON j.batch_id=b.id AND j.batch_position=b.next_position
         WHERE b.status='queued' AND b.active_job_id IS NULL AND b.next_publish_at<=NOW()
           AND b.next_position<=b.item_count AND j.status='queued'
         ORDER BY b.next_publish_at,b.created_at LIMIT 1 FOR UPDATE OF b SKIP LOCKED`);
      if (!due.rows.length) return null;
      const { batch_id: batchId, job_id: jobId } = due.rows[0];
      const claim = await client.query("UPDATE publisher_jobs SET status='creating',updated_at=NOW() WHERE id=$1 AND status='queued' RETURNING id", [jobId]);
      if (!claim.rows.length) return null;
      await client.query("UPDATE publisher_batches SET status='running',active_job_id=$1,updated_at=NOW() WHERE id=$2", [jobId, batchId]);
      return jobId;
    });
  }

  async function runScheduler() {
    // Keep the active upload footprint bounded and remove only assets no job can use.
    await db.query(
      `DELETE FROM publisher_media_assets a WHERE a.expires_at<=NOW()
       AND NOT EXISTS (SELECT 1 FROM publisher_jobs j WHERE j.asset_id=a.id AND j.status IN ('queued','creating','processing','publishing','unknown'))`);
    const next = await claimNextBatchJob();
    if (next) await startQueued(next);
    const due = await db.query(
      `SELECT j.id::text AS id FROM publisher_jobs j JOIN publisher_batches b ON b.id=j.batch_id
       WHERE b.status='running' AND b.active_job_id=j.id AND (
         (j.status IN ('processing','publishing','unknown') AND j.next_check_at<=NOW() AND j.creation_id IS NOT NULL)
         OR (j.status='creating' AND j.updated_at<=NOW()-INTERVAL '5 minutes'))
       ORDER BY j.next_check_at LIMIT 1`);
    if (due.rows.length) {
      const job = await advance(due.rows[0].id);
      if (["published", "failed", "unknown"].includes(job.status)) await settleBatch(job.id, job.status, job.error_code);
    }
  }

  async function advance(id) {
    if (!UUID.test(id)) throw new AppError(400, "invalid_job");
    let job = await getJob(id);
    if (["published", "failed"].includes(job.status)) return publicJob(job);
    if (!job.creation_id) {
      if (Date.now() - new Date(job.updated_at).getTime() > 5 * 60000) {
        await db.query("UPDATE publisher_jobs SET status='unknown',error_code='creation_uncertain' WHERE id=$1 AND status='creating'", [id]);
      }
      return publicJob(await getJob(id));
    }
    if (!job.account_row_id) throw new AppError(409, "connection_removed");
    // This claim throttles checks across tabs and service instances as well as in the UI.
    const check = await db.query(
      `UPDATE publisher_jobs SET next_check_at=NOW()+INTERVAL '60 seconds'
       WHERE id=$1 AND next_check_at<=NOW() AND status IN ('processing','publishing','unknown') RETURNING *`, [id]);
    if (!check.rows.length) return publicJob(await getJob(id));
    job = check.rows[0];
    const account = await usableAccount(String(job.account_row_id));
    let status;
    try {
      const data = await meta.graph(job.creation_id, account.token, account.provider, "GET", { fields: "status_code" });
      status = data.status_code;
    } catch (error) {
      await noteMetaError(account, error);
      if (error instanceof MetaError) {
        await db.query("UPDATE publisher_jobs SET error_code=$1 WHERE id=$2", [metaErrorCode(error), id]);
        return publicJob(await getJob(id));
      }
      throw error;
    }
    if (status === "PUBLISHED") {
      // Recovery uses the existing container only. Its ID is not the published media ID.
      await db.query("UPDATE publisher_jobs SET status='published',error_code=NULL,updated_at=NOW() WHERE id=$1", [id]);
      return publicJob(await getJob(id));
    }
    if (["ERROR", "EXPIRED"].includes(status)) {
      await db.query("UPDATE publisher_jobs SET status='failed',error_code=$1,updated_at=NOW() WHERE id=$2 AND status IN ('processing','unknown')",
        [status === "EXPIRED" ? "container_expired" : "media_processing_failed", id]);
      return publicJob(await getJob(id));
    }
    if (job.status !== "processing") {
      await db.query("UPDATE publisher_jobs SET status='unknown',error_code='publish_uncertain',updated_at=NOW() WHERE id=$1 AND status='publishing'", [id]);
      return publicJob(await getJob(id));
    }
    if (status !== "FINISHED") return publicJob(await getJob(id));
    // Persist intent before the side effect. Only this atomic winner can publish.
    const claim = await db.query(
      "UPDATE publisher_jobs SET status='publishing',error_code=NULL,updated_at=NOW() WHERE id=$1 AND status='processing' RETURNING id", [id]);
    if (!claim.rows.length) return publicJob(await getJob(id));
    try {
      const published = await meta.graph(`${account.account_id}/media_publish`, account.token, account.provider,
        "POST", { creation_id: job.creation_id });
      if (!metaId(published.id)) throw new MetaError({ uncertain: true });
      await db.query("UPDATE publisher_jobs SET status='published',published_media_id=$1,error_code=NULL,updated_at=NOW() WHERE id=$2",
        [metaId(published.id), id]);
    } catch (error) {
      const uncertain = !(error instanceof MetaError) || error.uncertain;
      await db.query("UPDATE publisher_jobs SET status=$1,error_code=$2,updated_at=NOW() WHERE id=$3 AND status='publishing'",
        [uncertain ? "unknown" : "failed", uncertain ? "publish_uncertain" : metaErrorCode(error), id]);
      await noteMetaError(account, error);
    }
    return publicJob(await getJob(id));
  }

  async function list() {
    const result = await db.query(
      `SELECT j.*,b.item_count AS batch_count,b.interval_minutes,b.status AS batch_status,
        b.pause_reason AS batch_pause_reason,a.file_name AS media_name
       FROM publisher_jobs j
       LEFT JOIN publisher_batches b ON b.id=j.batch_id
       LEFT JOIN publisher_media_assets a ON a.id=j.asset_id
       ORDER BY j.created_at DESC,j.batch_position LIMIT 100`);
    return result.rows.map(publicJob);
  }

  return { create, createBatch, uploadAsset, publicAsset, resumeBatch, settleBatch, runScheduler, advance, list, usableAccount };
}

module.exports = { createPublishing, AppError, publicJob, MAX_MEDIA_BYTES };
