"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { readConfig, encryptToken, decryptToken, passwordVerifier, publicMediaUrl, sameOrigin } = require("../lib/security");
const { metaId } = require("../lib/meta");

test("large Meta IDs remain strings and rounded numeric IDs fail closed", () => {
  assert.equal(metaId("17841405822304915"), "17841405822304915");
  assert.equal(metaId(17841405822304915), null);
  assert.equal(metaId(12345), "12345");
});

test("AES-GCM detects tampering, wrong keys and moving tokens to a different account", () => {
  const key = crypto.randomBytes(32);
  const saved = encryptToken("test-token", key, "instagram:123");
  assert.equal(decryptToken(saved, key, "instagram:123"), "test-token");
  assert.throws(() => decryptToken(saved, key, "instagram:456"));
  assert.throws(() => decryptToken(saved, crypto.randomBytes(32), "instagram:123"));
  const parts = saved.split("."); parts[2] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptToken(parts.join("."), key, "instagram:123"));
  assert.notEqual(saved, encryptToken("test-token", key, "instagram:123"));
});
test("production requires canonical HTTPS callback and a real 32-byte encryption key", () => {
  const base = { NODE_ENV: "production", REDIRECT_URI: "https://publisher.example/auth/meta/callback", TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") };
  assert.equal(readConfig(base).origin, "https://publisher.example");
  for (const REDIRECT_URI of ["http://publisher.example/auth/meta/callback", "https://evil:secret@publisher.example/auth/meta/callback", "https://publisher.example/auth/meta/callback?x=1", "https://publisher.example/other", "http://localhost/auth/meta/callback"]) {
    assert.equal(readConfig({ ...base, REDIRECT_URI }).origin, null);
  }
  assert.equal(readConfig({ ...base, TOKEN_ENCRYPTION_KEY: "x" }).key, null);
  assert.equal(readConfig({ ...base, DASHBOARD_PASSWORD: "short" }).password, null);
  assert.equal(sameOrigin({ get: (name) => ({ origin: "http://publisher.example", host: "publisher.example" })[name] }, "https://publisher.example"), false);
});
test("owner password verifier rotates session version on password or key change", async () => {
  const key = crypto.randomBytes(32);
  const first = await passwordVerifier("test-only-password", key);
  assert.equal(await first.verify("test-only-password"), true);
  assert.equal(await first.verify("wrong"), false);
  assert.equal(await first.verify({}), false);
  assert.equal(first.version, (await passwordVerifier("test-only-password", key)).version);
  assert.notEqual(first.version, (await passwordVerifier("new-test-only-password", key)).version);
  assert.notEqual(first.version, (await passwordVerifier("test-only-password", crypto.randomBytes(32))).version);
});
test("media validation rejects local/IP/credential URLs; no media URL is fetched by this server", () => {
  for (const url of ["http://cdn.example/p.jpg", "https://127.0.0.1/x", "https://[::1]/x", "https://2130706433/x", "https://localhost/x", "https://a.local/x", "https://u:p@cdn.example/x", "https://cdn.example:444/x"]) assert.equal(publicMediaUrl(url), null);
  assert.equal(publicMediaUrl("https://cdn.example/photo.jpg"), "https://cdn.example/photo.jpg");
});
