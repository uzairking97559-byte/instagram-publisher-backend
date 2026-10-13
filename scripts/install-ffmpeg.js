"use strict";

// Downloads the pinned static ffmpeg build used to frame Reels (lib/frame.js)
// into bin/ffmpeg during `npm install`. The download is checked against a
// SHA-256 hash. A failure only disables framing; it never fails the install.
// Set FFMPEG_PATH to use another ffmpeg, or SKIP_FFMPEG_DOWNLOAD=1 to skip.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const URL = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64.gz";
const SHA256 = "17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f";
const target = path.join(__dirname, "../bin/ffmpeg");
const stamp = `${target}.sha256`;
const say = (message) => process.stdout.write(`[ffmpeg] ${message}\n`);

async function main() {
  if (process.env.SKIP_FFMPEG_DOWNLOAD === "1" || process.env.FFMPEG_PATH) return say("download skipped");
  if (process.platform !== "linux" || process.arch !== "x64") return say(`no build for ${process.platform}-${process.arch}; install ffmpeg and set FFMPEG_PATH`);
  if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === SHA256) return say("already installed");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(URL, { redirect: "follow", signal: AbortSignal.timeout(5 * 60000) });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  const packed = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash("sha256").update(packed).digest("hex");
  if (digest !== SHA256) throw new Error("download hash mismatch");
  const temporary = `${target}.download`;
  fs.writeFileSync(temporary, zlib.gunzipSync(packed), { mode: 0o755 });
  fs.renameSync(temporary, target);
  fs.writeFileSync(stamp, SHA256);
  say("installed bin/ffmpeg (6.0 static)");
}

main().catch((error) => {
  say(`not installed (${error.message}); Reel frames are unavailable until ffmpeg is present`);
});
