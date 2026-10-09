"use strict";

const crypto = require("node:crypto");
const { hash, validId, publicMediaUrl, encryptToken, decryptToken } = require("./security");
const { MetaError, metaId } = require("./meta");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86400000;

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
    error_code: job.error_code, next_check_at: job.next_check_at, created_at: job.created_at
  };
}

function createPublishing({ db, meta, key, log }) {
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
    const result = await db.query("SELECT * FROM publisher_jobs WHERE id=$1", [id]);
    if (!result.rows.length) throw new AppError(404, "job_not_found");
    return result.rows[0];
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
      await db.query("UPDATE publisher_jobs SET status='failed',error_code=$1,updated_at=NOW() WHERE id=$2 AND status='processing'",
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
    const result = await db.query("SELECT * FROM publisher_jobs ORDER BY created_at DESC LIMIT 50");
    return result.rows.map(publicJob);
  }

  return { create, advance, list, usableAccount };
}

module.exports = { createPublishing, AppError, publicJob };
