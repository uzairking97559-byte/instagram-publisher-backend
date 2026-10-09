"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const { createApp } = require("../server");
const { encryptToken } = require("../lib/security");
const { SCOPES } = require("../lib/meta");
const TEST_PASSWORD = "test-only-owner-password-42";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function adapter(pg) {
  return {
    query: async (sql, params) => {
      const result = await pg.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn(adapter(tx))),
    close: () => pg.close()
  };
}

async function harness(t, options = {}) {
  const pg = new PGlite();
  const db = adapter(pg);
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const key = crypto.randomBytes(32);
  const env = {
    REDIRECT_URI: origin + "/auth/meta/callback", TOKEN_ENCRYPTION_KEY: key.toString("base64"),
    DASHBOARD_PASSWORD: TEST_PASSWORD,
    META_APP_ID: "test-facebook-app", META_APP_SECRET: "test-facebook-secret",
    INSTAGRAM_APP_ID: "test-instagram-app", INSTAGRAM_APP_SECRET: "test-instagram-secret",
    ...options.env
  };
  const calls = [];
  const logs = [];
  const handler = { run: options.meta || (() => { throw new Error("Unexpected outbound call"); }) };
  const app = await createApp({ env, db: options.noDb ? null : db, logger: (entry) => logs.push(entry), metaTimeoutMs: options.timeout || 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return handler.run(new URL(url), init);
    } });
  server.on("request", app);
  t?.after(async () => { await new Promise((resolve) => server.close(resolve)); await pg.close(); });
  const request = async (path, { method = "GET", body, cookie, originHeader = origin, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, redirect: "manual", headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(originHeader ? { origin: originHeader } : {}), ...(cookie ? { cookie } : {}), ...headers
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch {}
    return { response, data, text, status: response.status, location: response.headers.get("location"), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const requestRaw = async (path, { method = "POST", body, cookie, originHeader = origin, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, redirect: "manual", headers: {
      ...(originHeader ? { origin: originHeader } : {}), ...(cookie ? { cookie } : {}), ...headers
    }, ...(body !== undefined ? { body } : {}) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch {}
    return { response, data, text, status: response.status, location: response.headers.get("location") };
  };
  const login = async (cookie) => (await request("/auth/login", { method: "POST", body: { password: TEST_PASSWORD }, cookie })).cookie;
  async function account(provider = "facebook", id = "10001", overrides = {}) {
    const record = { username: "test_creator", token: "test-only-page-token", expires: null, ...overrides };
    const result = await db.query(
      "INSERT INTO publisher_accounts(provider,account_id,username,encrypted_token,token_expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id::text AS id",
      [provider, id, record.username, encryptToken(record.token, key, `${provider}:${id}`), record.expires]);
    return result.rows[0].id;
  }
  return { app, db, pg, env, key, origin, request, requestRaw, login, calls, logs, handler, account, server };
}

function facebookMeta(total = 2) {
  return (url) => {
    if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: url.searchParams.has("grant_type") ? "test-long-token" : "test-short-token", expires_in: 5184000 });
    if (url.pathname.endsWith("/me/permissions")) return json({ data: SCOPES.facebook.map((permission) => ({ permission, status: "granted" })) });
    if (url.pathname.endsWith("/me/accounts")) {
      const start = url.searchParams.has("after") ? 20 : 0;
      const data = Array.from({ length: Math.max(0, Math.min(20, total-start)) }, (_, index) => ({
        id: String(90000+start+index), name: "Test Page", access_token: `test-page-token-${start+index}`,
        instagram_business_account: { id: String(10000+start+index), username: `test_creator_${start+index}` }
      }));
      return json({ data, ...(start+20 < total ? { paging: { next: "https://untrusted.invalid/steal", cursors: { after: "next-page" } } } : {}) });
    }
    throw new Error("Unexpected Meta route");
  };
}

module.exports = { harness, adapter, json, facebookMeta, TEST_PASSWORD };
