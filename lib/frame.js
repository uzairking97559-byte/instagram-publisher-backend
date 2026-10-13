"use strict";

// Reel frame: puts an uploaded video in a square box on a textured
// background, with a line of text above it, the account's username below it
// and an optional picture at the bottom. Rendering uses ffmpeg (see
// scripts/install-ffmpeg.js) in a child process, one video at a time.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ASSETS = path.join(__dirname, "../assets/frame");
const WIDTH = 1080, HEIGHT = 1920;
const BOX_TOP = 330;
// Space between the top line and the video box's border.
const TITLE_GAP = 26;
const BOX_PERCENTS = [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
const DEFAULT_BOX_PERCENT = 60;
const BACKGROUND_PRESETS = ["purple", "red", "blue", "green", "teal", "brown"];
const DEFAULT_ART = { file: path.join(ASSETS, "art/girl.png"), width: 980, padding: 40 };
const FONT_BOLD = path.join(ASSETS, "fonts/Lora-Bold.ttf");
const FONT_ITALIC = path.join(ASSETS, "fonts/Lora-MediumItalic.ttf");
const MAX_TITLE_CHARS = 60;
const RENDER_TIMEOUT_MS = 20 * 60000;

// Used when an account has no lines of its own: a random one is picked for
// each Reel. The owner can replace them per account in the dashboard.
const DEFAULT_TITLE_LINES = [
  "Kadwa sach..!!", "Perfect line..!!", "Zindagi ka sach..!!", "Dil se suno..!!",
  "Sach hi to hai..!!", "Ek baar zaroor socho..!!", "Aaj ki baat..!!", "Waqt sab sikha deta hai..!!",
  "Log badal jaate hain..!!", "Ye baat yaad rakhna..!!", "Duniya ka dastoor..!!", "Rishton ka sach..!!",
  "Bas itna samajh lo..!!", "Dil ko chhoo gayi..!!", "Kabhi socha hai..??", "Sabse badi seekh..!!",
  "Zindagi ki kitaab..!!", "Apno ka sach..!!", "Dil ki baat..!!", "Gehri baat..!!",
  "Samajhdar ke liye ishara..!!", "Maa baap ki keemat..!!", "Paisa aur log..!!", "Asli dost kaun..??",
  "Ek line, poori zindagi..!!", "Sunne layak baat..!!", "Waqt ki keemat..!!", "Khamoshi ka sach..!!"
];

function ffmpegPath(env = process.env) {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  const bundled = path.join(__dirname, "../bin/ffmpeg");
  return fs.existsSync(bundled) ? bundled : "ffmpeg";
}

function backgroundPreset(name, accountId) {
  if (BACKGROUND_PRESETS.includes(name)) return name;
  // Every account gets its own colour by default, in the order they connect.
  const index = Number.isSafeInteger(Number(accountId)) ? Math.abs(Number(accountId)) % BACKGROUND_PRESETS.length : 0;
  return BACKGROUND_PRESETS[index];
}

function backgroundFile(name) {
  return path.join(ASSETS, `backgrounds/${BACKGROUND_PRESETS.includes(name) ? name : BACKGROUND_PRESETS[0]}.jpg`);
}

// The bundled fonts draw Latin text (Hinglish). Emoji and other scripts would
// show as empty boxes, so they are removed; spacing is tidied.
function cleanTitle(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\p{Extended_Pictographic}‍️⃣]/gu, "")
    .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}₹$+=<>^`|~]/gu, "")
    .replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS).trim();
}

// The top line is always a single line; a longer line gets a smaller font so
// it still fits the width (about 0.55 x font size per character in Lora Bold).
function wrapTitle(text) {
  const clean = cleanTitle(text);
  return clean ? [clean] : [];
}

function titleFontSize(lines) {
  const longest = Math.max(1, ...lines.map((line) => line.length));
  return Math.max(32, Math.min(80, Math.floor(1800 / longest)));
}

// drawtext filters for the top line, sitting just above the video box.
function titleFilters(lines, L, workDir, extra = "") {
  if (!lines.length) return [];
  const size = titleFontSize(lines);
  const file = path.join(workDir, "title-0.txt");
  fs.writeFileSync(file, lines[0]);
  return [`drawtext=fontfile=${FONT_BOLD}:textfile=${file}:fontsize=${size}:fontcolor=0xFFFAF0:` +
    `shadowcolor=black@0.65:shadowx=3:shadowy=5:x=(w-text_w)/2:y=${L.y - TITLE_GAP}-th${extra}`];
}

function cleanUsername(value) {
  const name = typeof value === "string" ? value.replace(/[^A-Za-z0-9._]/g, "").slice(0, 30) : "";
  return name ? `@${name}` : "";
}

function layout(boxPercent) {
  const percent = BOX_PERCENTS.includes(Number(boxPercent)) ? Number(boxPercent) : DEFAULT_BOX_PERCENT;
  const box = Math.round(WIDTH * percent / 100 / 2) * 2;
  const x = (WIDTH - box) / 2, y = BOX_TOP;
  return { percent, box, x, y, bottom: y + box, usernameY: y + box + 30, artTop: y + box + 85 };
}

// Pass 1 draws everything that does not move (background, box border, bottom
// picture, username) into one still image. Pass 2 only overlays the video and
// the fading top line on that still. Splitting it keeps ffmpeg's memory low
// enough for a 512 MB instance. Text is passed through files so nothing typed
// by the owner is ever parsed as filter syntax.
function buildStillArgs({ background, art, username, boxPercent, workDir, output }) {
  const L = layout(boxPercent);
  const name = cleanUsername(username);
  const inputs = ["-i", background];
  if (art) inputs.push("-i", art.file);
  const shadow = [[18, 0.10], [12, 0.16], [6, 0.22]].map(([grow, alpha]) =>
    `drawbox=x=${L.x - grow + 10}:y=${L.y - grow + 18}:w=${L.box + grow * 2}:h=${L.box + grow * 2}:color=black@${alpha}:t=fill`);
  const filters = [`[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,format=rgb24,` +
    `${shadow.join(",")},drawbox=x=${L.x - 5}:y=${L.y - 5}:w=${L.box + 10}:h=${L.box + 10}:color=0xEBD7AA:t=fill[bg]`];
  let last = "bg";
  if (art) {
    filters.push(`[1:v]scale=${art.width}:-2[art]`);
    filters.push(`[bg][art]overlay=(W-w)/2:${L.artTop - art.padding}:format=rgb[withart]`);
    last = "withart";
  }
  let tail = "";
  if (name) {
    const file = path.join(workDir, "username.txt");
    fs.writeFileSync(file, name);
    tail = `drawtext=fontfile=${FONT_ITALIC}:textfile=${file}:fontsize=44:fontcolor=0xFAEEDC:` +
      `shadowcolor=black@0.55:shadowx=2:shadowy=3:x=(w-text_w)/2:y=${L.usernameY},`;
  }
  filters.push(`[${last}]${tail}format=rgb24[out]`);
  const script = path.join(workDir, "still.txt");
  fs.writeFileSync(script, filters.join(";\n"));
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputs,
    "-filter_complex_script", script, "-map", "[out]", "-frames:v", "1", output];
}

function buildVideoArgs({ input, still, title, boxPercent, workDir, output }) {
  const L = layout(boxPercent);
  const lines = wrapTitle(title);
  const filters = [
    `[1:v]crop='min(iw,ih)':'min(iw,ih)',scale=${L.box}:${L.box}:flags=lanczos,setsar=1,fps=30,format=yuv420p[vid]`,
    `[0:v]format=yuv420p[bg]`,
    `[bg][vid]overlay=${L.x}:${L.y}:shortest=1[m0]`
  ];
  const text = titleFilters(lines, L, workDir, ":alpha='if(lt(t,0.2),0,min(1,(t-0.2)/0.8))'");
  filters.push(`[m0]${text.length ? text.join(",") + "," : ""}format=yuv420p[out]`);
  const script = path.join(workDir, "video.txt");
  fs.writeFileSync(script, filters.join(";\n"));
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_complex_threads", "1",
    // One decoder thread per input keeps memory low; the still is decoded once.
    "-threads", "1", "-loop", "1", "-framerate", "30", "-i", still,
    "-threads", "1", "-i", input,
    "-filter_complex_script", script,
    "-map", "[out]", "-map", "1:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-maxrate", "10M", "-bufsize", "20M", "-profile:v", "high", "-pix_fmt", "yuv420p",
    // No lookahead, two reference frames and one B-frame: about 180 MB for a
    // 1080x1920 encode instead of ~340 MB with the preset's defaults.
    "-r", "30", "-g", "60", "-threads", "1", "-x264-params", "rc-lookahead=0:ref=2:bframes=1",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
    "-shortest", "-movflags", "+faststart", "-max_muxing_queue_size", "1024",
    output
  ];
}

function run(binary, args, timeoutMs = RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(Object.assign(new Error("ffmpeg_unavailable"), { cause: error })); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(signal ? "frame_render_timeout" : "frame_render_failed"), { detail: stderr.slice(-600) }));
    });
  });
}

// Renders inputPath to outputPath. `background` and `art` may be bundled
// presets or image files written by the caller (the owner's uploads).
async function renderFrame({ inputPath, outputPath, backgroundPath, art, title, username, boxPercent, binary = ffmpegPath(), timeoutMs }) {
  const workDir = fs.mkdtempSync(path.join(path.dirname(outputPath), "frame-"));
  try {
    const still = path.join(workDir, "still.png");
    await run(binary, buildStillArgs({ background: backgroundPath, art, username, boxPercent, workDir, output: still }), 120000);
    await run(binary, buildVideoArgs({ input: inputPath, still, title, boxPercent, workDir, output: outputPath }), timeoutMs);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// A small still of the look (the box shows where the video goes), for the
// dashboard's account settings. Returns PNG bytes.
async function renderPreview({ backgroundPath, art, title, username, boxPercent, binary = ffmpegPath(), workRoot }) {
  const workDir = fs.mkdtempSync(path.join(workRoot, "preview-"));
  try {
    const still = path.join(workDir, "still.png"), output = path.join(workDir, "preview.png");
    await run(binary, buildStillArgs({ background: backgroundPath, art, username, boxPercent, workDir, output: still }), 60000);
    const L = layout(boxPercent);
    const lines = wrapTitle(title);
    const label = path.join(workDir, "label.txt");
    fs.writeFileSync(label, "VIDEO");
    const parts = [`drawbox=x=${L.x}:y=${L.y}:w=${L.box}:h=${L.box}:color=0x2A2A2A:t=fill`,
      `drawtext=fontfile=${FONT_BOLD}:textfile=${label}:fontsize=${Math.min(64, Math.round(L.box / 5))}:fontcolor=0x9A9A9A:x=(w-text_w)/2:y=${L.y + L.box / 2}-th/2`];
    parts.push(...titleFilters(lines, L, workDir));
    parts.push("scale=540:960");
    const script = path.join(workDir, "preview.txt");
    fs.writeFileSync(script, `[0:v]${parts.join(",")}[out]`);
    await run(binary, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", still,
      "-filter_complex_script", script, "-map", "[out]", "-frames:v", "1", output], 60000);
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function pickTitle(batchTitle, accountLines, random = Math.random) {
  const own = cleanTitle(batchTitle || "");
  if (own) return own;
  const lines = (Array.isArray(accountLines) && accountLines.length ? accountLines : DEFAULT_TITLE_LINES)
    .map(cleanTitle).filter(Boolean);
  return lines.length ? lines[Math.floor(random() * lines.length)] : "";
}

// Image uploads for a custom background or bottom picture.
function detectImageType(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.toString("hex", 0, 8) === "89504e470d0a1a0a") return "image/png";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

module.exports = {
  BACKGROUND_PRESETS, BOX_PERCENTS, DEFAULT_BOX_PERCENT, DEFAULT_ART, DEFAULT_TITLE_LINES, MAX_TITLE_CHARS,
  ffmpegPath, backgroundPreset, backgroundFile, cleanTitle, wrapTitle, titleFontSize, cleanUsername,
  layout, buildStillArgs, buildVideoArgs, renderFrame, renderPreview, pickTitle, detectImageType
};
