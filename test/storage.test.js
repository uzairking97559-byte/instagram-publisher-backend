"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mediaLimitFromEnv, MAX_MEDIA_BYTES } = require("../lib/publishing");

test("MEDIA_STORAGE_LIMIT_MB sets the video storage limit; anything invalid keeps the 500 MB default", () => {
  const MB = 1024 * 1024;
  assert.equal(mediaLimitFromEnv({}), 500 * MB);
  assert.equal(mediaLimitFromEnv(), 500 * MB);
  assert.equal(mediaLimitFromEnv({ MEDIA_STORAGE_LIMIT_MB: "2500" }), 2500 * MB);
  assert.equal(mediaLimitFromEnv({ MEDIA_STORAGE_LIMIT_MB: "1" }), 1 * MB);
  for (const bad of ["", "0", "-5", "2.5", "abc", "100001", " "]) {
    assert.equal(mediaLimitFromEnv({ MEDIA_STORAGE_LIMIT_MB: bad }), 500 * MB, `invalid value ${JSON.stringify(bad)}`);
  }
  assert.equal(MAX_MEDIA_BYTES, 50 * MB, "a single video is still limited to 50 MB");
});
