"use strict";

// Account frame settings and the background worker that frames queued Reels.
// A batch created with `frame: true` gives each of its Reels frame_status
// 'pending'. This worker renders them one at a time, in the order they are
// due, and replaces the stored video with the framed one. The scheduler does
// not start a Reel until its frame is 'done' or 'failed' (then the original
// video is posted, and Activity says so).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const frame = require("./frame");
const { validId } = require("./security");
const { AppError } = require("./publishing");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 200;
const MAX_FRAMED_BYTES = 100 * 1024 * 1024;
const MAX_ATTEMPTS = 2;
const IMAGE_COLUMNS = { background: "background_image", art: "art_image" };

// Same error type as the rest of the API, so lib/app.js returns its status.
const FrameError = AppError;

function createFrames({ db, readAssetChunk, replaceAssetData, log = () => {}, render = frame.renderFrame, preview = frame.renderPreview,
  workRoot = path.join(os.tmpdir(), "igpub-frames"), random = Math.random }) {
  const startedAt = new Date();
  let recovered = false;

  async function accountRow(accountId) {
    if (!validId(accountId)) throw new FrameError(400, "invalid_account");
    const result = await db.query("SELECT id::text AS id,username,account_id FROM publisher_accounts WHERE id=$1", [accountId]);
    if (!result.rows.length) throw new FrameError(404, "account_not_found");
    return result.rows[0];
  }

  // Settings without the image bytes.
  async function loadSettings(accountId) {
    const result = await db.query(
      `SELECT frame_by_default,background_preset,background_image IS NOT NULL AS has_background,art_mode,
        art_image IS NOT NULL AS has_art,box_percent,show_username,title_lines,default_caption
       FROM publisher_frame_settings WHERE account_row_id=$1`, [accountId]);
    const row = result.rows[0] || {};
    return {
      frame_by_default: row.frame_by_default ?? true,
      background_preset: frame.backgroundPreset(row.background_preset, accountId),
      custom_background: Boolean(row.has_background),
      art_mode: row.art_mode ?? "default",
      custom_art: Boolean(row.has_art),
      box_percent: row.box_percent ?? frame.DEFAULT_BOX_PERCENT,
      show_username: row.show_username ?? true,
      title_lines: row.title_lines ?? [],
      default_caption: row.default_caption ?? ""
    };
  }

  async function getSettings(accountId) {
    await accountRow(accountId);
    return {
      ...(await loadSettings(accountId)),
      options: { background_presets: frame.BACKGROUND_PRESETS, box_percents: frame.BOX_PERCENTS,
        default_title_lines: frame.DEFAULT_TITLE_LINES, max_title_chars: frame.MAX_TITLE_CHARS, max_image_bytes: MAX_IMAGE_BYTES }
    };
  }

  async function ensureRow(accountId) {
    await db.query("INSERT INTO publisher_frame_settings(account_row_id) VALUES($1) ON CONFLICT DO NOTHING", [accountId]);
  }

  async function updateSettings(accountId, body = {}) {
    await accountRow(accountId);
    const current = await loadSettings(accountId);
    const next = { ...current };
    if (body.frame_by_default !== undefined) {
      if (typeof body.frame_by_default !== "boolean") throw new FrameError(400, "invalid_frame_settings");
      next.frame_by_default = body.frame_by_default;
    }
    if (body.background_preset !== undefined) {
      if (!frame.BACKGROUND_PRESETS.includes(body.background_preset)) throw new FrameError(400, "invalid_frame_settings");
      next.background_preset = body.background_preset;
    }
    if (body.art_mode !== undefined) {
      if (!["default", "custom", "none"].includes(body.art_mode)) throw new FrameError(400, "invalid_frame_settings");
      if (body.art_mode === "custom" && !current.custom_art) throw new FrameError(409, "frame_art_missing");
      next.art_mode = body.art_mode;
    }
    if (body.box_percent !== undefined) {
      if (!frame.BOX_PERCENTS.includes(Number(body.box_percent))) throw new FrameError(400, "invalid_frame_settings");
      next.box_percent = Number(body.box_percent);
    }
    if (body.show_username !== undefined) {
      if (typeof body.show_username !== "boolean") throw new FrameError(400, "invalid_frame_settings");
      next.show_username = body.show_username;
    }
    if (body.title_lines !== undefined) {
      if (!Array.isArray(body.title_lines) || body.title_lines.length > MAX_LINES || body.title_lines.some((line) => typeof line !== "string")) {
        throw new FrameError(400, "invalid_frame_settings");
      }
      next.title_lines = [...new Set(body.title_lines.map(frame.cleanTitle).filter(Boolean))];
    }
    if (body.default_caption !== undefined) {
      if (typeof body.default_caption !== "string" || [...body.default_caption].length > 2200) throw new FrameError(400, "invalid_frame_settings");
      next.default_caption = body.default_caption;
    }
    await ensureRow(accountId);
    await db.query(
      `UPDATE publisher_frame_settings SET default_caption=$8,frame_by_default=$2,background_preset=$3,art_mode=$4,box_percent=$5,
        show_username=$6,title_lines=$7,updated_at=NOW() WHERE account_row_id=$1`,
      [accountId, next.frame_by_default, next.background_preset, next.art_mode, next.box_percent, next.show_username, next.title_lines, next.default_caption]);
    return getSettings(accountId);
  }

  // kind: "background" or "art". data null removes the picture.
  async function setImage(accountId, kind, data) {
    await accountRow(accountId);
    const column = IMAGE_COLUMNS[kind];
    if (!column) throw new FrameError(404, "not_found");
    if (data !== null) {
      if (!Buffer.isBuffer(data) || !data.length) throw new FrameError(400, "invalid_frame_image");
      if (data.length > MAX_IMAGE_BYTES) throw new FrameError(413, "frame_image_too_large");
      if (!frame.detectImageType(data)) throw new FrameError(400, "invalid_frame_image");
    }
    await ensureRow(accountId);
    if (kind === "art") {
      // Uploading a picture switches to it; removing it falls back to the default one.
      await db.query(`UPDATE publisher_frame_settings SET art_image=$2,art_mode=$3,updated_at=NOW() WHERE account_row_id=$1`,
        [accountId, data, data ? "custom" : "default"]);
    } else {
      await db.query(`UPDATE publisher_frame_settings SET background_image=$2,updated_at=NOW() WHERE account_row_id=$1`, [accountId, data]);
    }
    return getSettings(accountId);
  }

  // Writes what a render needs (custom pictures) into dir; returns render options.
  async function lookFor(accountId, username, dir) {
    const settings = await loadSettings(accountId);
    let backgroundPath = frame.backgroundFile(settings.background_preset);
    let art = null;
    if (settings.custom_background || (settings.art_mode === "custom" && settings.custom_art)) {
      const images = await db.query("SELECT background_image,art_image FROM publisher_frame_settings WHERE account_row_id=$1", [accountId]);
      const row = images.rows[0] || {};
      if (row.background_image) {
        backgroundPath = path.join(dir, "background.img");
        fs.writeFileSync(backgroundPath, row.background_image);
      }
      if (settings.art_mode === "custom" && row.art_image) {
        art = { file: path.join(dir, "art.img"), width: 900, padding: 0 };
        fs.writeFileSync(art.file, row.art_image);
      }
    }
    if (!art && settings.art_mode === "default") art = frame.DEFAULT_ART;
    return { settings, backgroundPath, art, username: settings.show_username ? username : "" };
  }

  async function renderSettingsPreview(accountId, title) {
    const account = await accountRow(accountId);
    fs.mkdirSync(workRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(workRoot, "look-"));
    try {
      const look = await lookFor(accountId, account.username || account.account_id, dir);
      const line = frame.cleanTitle(title || "") || frame.pickTitle("", look.settings.title_lines, random);
      return await preview({ backgroundPath: look.backgroundPath, art: look.art, title: line, username: look.username,
        boxPercent: look.settings.box_percent, workRoot: dir });
    } catch (error) {
      if (error instanceof FrameError) throw error;
      log("frame_preview_failed", { reason: error.message });
      throw new FrameError(503, "frame_unavailable");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function recover() {
    // A render cut off by a restart (e.g. a deploy) starts again; a Reel that
    // has already used its attempts posts its original video.
    await db.query(
      `UPDATE publisher_jobs SET frame_status=CASE WHEN frame_attempts>=$2 THEN 'failed' ELSE 'pending' END,
        frame_error=CASE WHEN frame_attempts>=$2 THEN 'frame_interrupted' ELSE frame_error END,frame_claim=NULL
       WHERE frame_status='rendering' AND (frame_started_at<$1 OR frame_started_at<NOW()-INTERVAL '30 minutes')`,
      [recovered ? new Date(0) : startedAt, MAX_ATTEMPTS]);
    recovered = true;
  }

  async function claim() {
    return db.transaction(async (client) => {
      const due = await client.query(
        `SELECT j.id FROM publisher_jobs j JOIN publisher_batches b ON b.id=j.batch_id
         WHERE j.frame_status='pending' AND j.status='queued' AND b.status IN ('queued','running','paused')
         ORDER BY j.scheduled_at,j.batch_position LIMIT 1 FOR UPDATE OF j SKIP LOCKED`);
      if (!due.rows.length) return null;
      const token = crypto.randomUUID();
      const claimed = await client.query(
        `UPDATE publisher_jobs SET frame_status='rendering',frame_claim=$2,frame_started_at=NOW(),frame_attempts=frame_attempts+1
         WHERE id=$1 AND frame_status='pending' RETURNING id::text AS id,asset_id::text AS asset_id,batch_id::text AS batch_id,
           account_row_id::text AS account_id,account_name,frame_attempts`, [due.rows[0].id, token]);
      return claimed.rows.length ? { ...claimed.rows[0], token } : null;
    });
  }

  async function finish(job, status, fields = {}) {
    await db.query(
      `UPDATE publisher_jobs SET frame_status=$3,frame_claim=NULL,frame_error=$4,frame_title=COALESCE($5,frame_title)
       WHERE id=$1 AND frame_claim=$2`,
      [job.id, job.token, status, fields.error ?? null, fields.title ?? null]);
  }

  async function writeAsset(assetId, file) {
    const size = await db.query("SELECT size_bytes::text AS size FROM publisher_media_assets WHERE id=$1 AND expires_at>NOW()", [assetId]);
    if (!size.rows.length) throw new FrameError(409, "asset_unavailable");
    const total = Number(size.rows[0].size);
    const handle = fs.openSync(file, "w");
    try {
      for (let offset = 0; offset < total; offset += 1024 * 1024) {
        const length = Math.min(1024 * 1024, total - offset);
        const chunk = await readAssetChunk(assetId, offset, length);
        if (!chunk || chunk.length !== length) throw new FrameError(409, "asset_unavailable");
        fs.writeSync(handle, Buffer.from(chunk));
      }
    } finally { fs.closeSync(handle); }
  }

  // Frames the next due Reel. Returns the job id it worked on, or null.
  async function renderNext() {
    await recover();
    const job = await claim();
    if (!job) return null;
    fs.mkdirSync(workRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(workRoot, "job-"));
    try {
      if (!job.asset_id) throw new FrameError(409, "asset_unavailable");
      const batch = await db.query("SELECT frame_title FROM publisher_batches WHERE id=$1", [job.batch_id]);
      const look = job.account_id
        ? await lookFor(job.account_id, job.account_name, dir)
        : { settings: { title_lines: [], box_percent: frame.DEFAULT_BOX_PERCENT }, backgroundPath: frame.backgroundFile(null), art: frame.DEFAULT_ART, username: job.account_name };
      const title = frame.pickTitle(batch.rows[0]?.frame_title, look.settings.title_lines, random);
      const input = path.join(dir, "input"), output = path.join(dir, "framed.mp4");
      await writeAsset(job.asset_id, input);
      await render({ inputPath: input, outputPath: output, backgroundPath: look.backgroundPath, art: look.art,
        title, username: look.username, boxPercent: look.settings.box_percent });
      const data = fs.readFileSync(output);
      if (!data.length || data.length > MAX_FRAMED_BYTES) throw new FrameError(413, "frame_output_too_large");
      fs.rmSync(input, { force: true });
      // Replace the video only while this worker still holds the claim and the
      // Reel has not started; otherwise keep the original.
      const saved = await db.transaction(async (client) => {
        const held = await client.query(
          "SELECT 1 FROM publisher_jobs WHERE id=$1 AND frame_claim=$2 AND status='queued' FOR UPDATE", [job.id, job.token]);
        if (!held.rows.length) return false;
        // Stored in 4 MB parts, so no single query holds the whole video.
        if (!await replaceAssetData(client, job.asset_id, data)) return false;
        await client.query(
          "UPDATE publisher_jobs SET frame_status='done',frame_claim=NULL,frame_error=NULL,frame_title=$3 WHERE id=$1 AND frame_claim=$2",
          [job.id, job.token, title || null]);
        return true;
      });
      if (!saved) await finish(job, "failed", { error: "frame_skipped" });
      log("frame_rendered", { saved });
    } catch (error) {
      const code = error instanceof FrameError ? error.code : error.message === "ffmpeg_unavailable" ? "ffmpeg_unavailable" : "frame_render_failed";
      log("frame_render_failed", { reason: code, ...(error.detail ? { detail: String(error.detail).slice(-300) } : {}) });
      // One more try for a render error; a missing ffmpeg or video will not fix itself.
      const retry = code === "frame_render_failed" && job.frame_attempts < MAX_ATTEMPTS;
      await finish(job, retry ? "pending" : "failed", { error: code }).catch(() => {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return job.id;
  }

  return { getSettings, updateSettings, setImage, renderSettingsPreview, renderNext, recover, MAX_IMAGE_BYTES };
}

module.exports = { createFrames, FrameError, MAX_IMAGE_BYTES };
