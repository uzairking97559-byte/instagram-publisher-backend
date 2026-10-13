"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const frame = require("../lib/frame");

test("top line: emoji and other scripts are removed, long lines wrap into two balanced lines", () => {
  assert.equal(frame.cleanTitle("Kadwa sach..!! 🥀"), "Kadwa sach..!!");
  assert.equal(frame.cleanTitle("  Dil   ki baat  ❤️ "), "Dil ki baat");
  assert.equal(frame.cleanTitle("आप कौन"), "");
  assert.equal(frame.cleanTitle(null), "");
  assert.deepEqual(frame.wrapTitle("Perfect line..!!"), ["Perfect line..!!"]);
  assert.deepEqual(frame.wrapTitle("Waqt sab sikha deta hai dost"), ["Waqt sab sikha deta hai dost"], "always one line");
  assert.ok(frame.titleFontSize(["x".repeat(60)]) * 0.55 * 60 <= 1080, "a long line still fits the width");
  assert.ok(frame.wrapTitle("x".repeat(200)).join("").length <= frame.MAX_TITLE_CHARS);
  assert.ok(frame.titleFontSize(["Kadwa sach..!!"]) <= 86);
  assert.ok(frame.titleFontSize(["a very long line of text here"]) >= 32);
});

test("each account gets its own background colour; usernames are cleaned", () => {
  assert.equal(frame.backgroundPreset("teal", "1"), "teal");
  assert.notEqual(frame.backgroundPreset(null, "1"), frame.backgroundPreset(null, "2"));
  assert.ok(frame.BACKGROUND_PRESETS.includes(frame.backgroundPreset("nope", "7")));
  assert.equal(frame.cleanUsername("yzairr_"), "@yzairr_");
  assert.equal(frame.cleanUsername("bad name;drawtext"), "@badnamedrawtext");
  assert.equal(frame.cleanUsername(""), "");
  for (const name of frame.BACKGROUND_PRESETS) assert.ok(fs.existsSync(frame.backgroundFile(name)), name);
  assert.ok(fs.existsSync(frame.DEFAULT_ART.file));
});

test("box size follows the chosen percentage and stays centred", () => {
  const sixty = frame.layout(60);
  assert.equal(sixty.box, 648); assert.equal(sixty.x, 216); assert.equal(sixty.y, 330);
  assert.equal(frame.layout(999).percent, frame.DEFAULT_BOX_PERCENT);
  assert.equal(frame.layout(80).box, 864);
  assert.equal(frame.layout(25).box, 270);
});

test("typed text never reaches the ffmpeg filter graph", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-test-"));
  try {
    const args = frame.buildVideoArgs({ input: "in.mp4", still: "still.png", title: "x:y,[z]'; drawtext=evil", boxPercent: 60, workDir: dir, output: "out.mp4" });
    const script = fs.readFileSync(args[args.indexOf("-filter_complex_script") + 1], "utf8");
    assert.doesNotMatch(script, /evil/);
    assert.match(script, /textfile=/);
    const lines = fs.readdirSync(dir).filter((name) => name.startsWith("title-")).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join(" ");
    assert.match(lines, /evil/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pickTitle prefers the batch line, then the account's lines, then the built-in ones", () => {
  assert.equal(frame.pickTitle("Mera line", ["a"], () => 0), "Mera line");
  assert.equal(frame.pickTitle("", ["Pehli", "Doosri"], () => 0.99), "Doosri");
  assert.ok(frame.DEFAULT_TITLE_LINES.includes(frame.pickTitle("", [], () => 0.5)));
});

test("image uploads are recognised by their bytes", () => {
  assert.equal(frame.detectImageType(Buffer.from("89504e470d0a1a0a0000000000", "hex")), "image/png");
  assert.equal(frame.detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.equal(frame.detectImageType(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
  assert.equal(frame.detectImageType(Buffer.from("<svg>not an image</svg>")), null);
});

const binary = frame.ffmpegPath();
const hasFfmpeg = spawnSync(binary, ["-version"]).status === 0;

test("a real render produces a 1080x1920 H.264 Reel with the source audio", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-render-"));
  try {
    const input = path.join(dir, "in.mp4"), output = path.join(dir, "out.mp4");
    const made = spawnSync(binary, ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=720x1280:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", input]);
    assert.equal(made.status, 0, String(made.stderr));
    await frame.renderFrame({ inputPath: input, outputPath: output, backgroundPath: frame.backgroundFile("purple"), art: frame.DEFAULT_ART,
      title: "Kadwa sach..!! 🥀", username: "yzairr_", boxPercent: 60 });
    const probe = spawnSync(binary, ["-hide_banner", "-i", output]);
    const info = String(probe.stderr);
    assert.match(info, /Video: h264/); assert.match(info, /1080x1920/); assert.match(info, /Audio: aac/);
    const preview = await frame.renderPreview({ backgroundPath: frame.backgroundFile("teal"), art: null, title: "Perfect line", username: "x", boxPercent: 70, workRoot: dir });
    assert.equal(frame.detectImageType(preview), "image/png");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
