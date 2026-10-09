"use strict";

const { validId } = require("./security");
// Native JSON numbers above 2^53 can already be rounded. Never authorize or
// publish against an ID derived from such a value; Meta Graph IDs are strings.
const metaId = (value) => typeof value === "string" && validId(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const SCOPES = {
  facebook: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"],
  instagram: ["instagram_business_basic", "instagram_business_content_publish"]
};

class MetaError extends Error {
  constructor({ status = 502, code = null, subcode = null, uncertain = false } = {}) {
    super("Meta request failed");
    this.name = "MetaError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.uncertain = uncertain;
  }
}

function createMetaClient(config, fetchImpl = fetch, timeoutMs = 20000) {
  async function request(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["graph.facebook.com", "graph.instagram.com", "api.instagram.com"].includes(parsed.hostname)) {
      throw new MetaError();
    }
    try {
      const response = await fetchImpl(parsed, {
        ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await response.json();
      if (!data || typeof data !== "object") throw new MetaError({ uncertain: true });
      if (!response.ok || data.error) {
        throw new MetaError({
          status: response.status,
          code: Number.isInteger(data.error?.code) ? data.error.code : null,
          subcode: Number.isInteger(data.error?.error_subcode) ? data.error.error_subcode : null,
          uncertain: response.status >= 500 || !data.error
        });
      }
      return data;
    } catch (error) {
      // Never propagate a provider message, response body or URL containing credentials.
      if (error instanceof MetaError) throw error;
      throw new MetaError({ uncertain: true });
    }
  }

  async function graph(path, token, provider = "facebook", method = "GET", fields = {}) {
    if (!/^(me(?:\/accounts|\/permissions)?|\d+(?:\/media|\/media_publish)?)$/.test(path)) throw new MetaError();
    const host = provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    const url = new URL(`https://${host}/${config.version}/${path}`);
    const headers = { Authorization: `Bearer ${token}` };
    if (method === "GET") {
      for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
      return request(url, { headers });
    }
    return request(url, {
      method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields)
    });
  }

  function authorizationUrl(provider, state) {
    const credentials = config[provider];
    const url = provider === "facebook"
      ? new URL(`https://www.facebook.com/${config.version}/dialog/oauth`)
      : new URL("https://www.instagram.com/oauth/authorize");
    const params = {
      client_id: credentials.id, redirect_uri: config.callback, response_type: "code",
      state, scope: SCOPES[provider].join(",")
    };
    if (provider === "instagram") Object.assign(params, { enable_fb_login: "0", force_authentication: "1" });
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }

  async function exchange(provider, code) {
    const { id, secret } = config[provider];
    let short;
    if (provider === "facebook") {
      const url = new URL(`https://graph.facebook.com/${config.version}/oauth/access_token`);
      url.search = new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: config.callback, code });
      short = await request(url);
    } else {
      const response = await request("https://api.instagram.com/oauth/access_token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: config.callback, grant_type: "authorization_code", code })
      });
      short = response.access_token ? response : Array.isArray(response.data) && response.data.length === 1 ? response.data[0] : null;
    }
    if (typeof short?.access_token !== "string" || !short.access_token) throw new MetaError();
    const url = new URL(provider === "facebook"
      ? `https://graph.facebook.com/${config.version}/oauth/access_token`
      : "https://graph.instagram.com/access_token");
    const params = provider === "facebook"
      ? { grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token }
      : { grant_type: "ig_exchange_token", client_secret: secret, access_token: short.access_token };
    url.search = new URLSearchParams(params);
    const long = await request(url);
    if (typeof long.access_token !== "string" || !long.access_token) throw new MetaError();
    return { ...long, user_id: short.user_id, permissions: short.permissions };
  }

  async function discover(provider, token) {
    if (provider === "instagram") {
      const profile = await graph("me", token.access_token, provider, "GET", { fields: "user_id,username" });
      const id = metaId(profile.user_id) || metaId(profile.id) || metaId(token.user_id);
      if (!id || !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0) throw new MetaError();
      const scopes = typeof token.permissions === "string" ? token.permissions.split(",") : [];
      return [{ id, provider, username: profile.username, token: token.access_token, expires: Number(token.expires_in), scopes }];
    }
    const permissions = await graph("me/permissions", token.access_token);
    const scopes = (permissions.data || []).filter((p) => p.status === "granted").map((p) => p.permission);
    if (!SCOPES.facebook.every((scope) => scopes.includes(scope))) throw new MetaError({ status: 403, code: 200 });
    const accounts = new Map();
    const cursors = new Set();
    let after;
    for (let page = 0; page < 100; page++) {
      const fields = { fields: "id,name,access_token,tasks,instagram_business_account{id,username}", limit: "100" };
      if (after) fields.after = after;
      const result = await graph("me/accounts", token.access_token, "facebook", "GET", fields);
      if (!Array.isArray(result.data)) throw new MetaError();
      for (const item of result.data) {
        const account = item.instagram_business_account;
        if (!account || !metaId(account.id) || typeof item.access_token !== "string" || !item.access_token) continue;
        accounts.set(metaId(account.id), {
          id: metaId(account.id), provider, username: account.username, name: item.name,
          token: item.access_token, expires: null, scopes
        });
      }
      if (!result.paging?.next) return [...accounts.values()];
      after = result.paging?.cursors?.after;
      if (typeof after !== "string" || !after || cursors.has(after)) throw new MetaError();
      cursors.add(after);
      // Rebuild the next request on the trusted Graph host; never follow paging URLs.
    }
    throw new MetaError();
  }

  async function refreshInstagram(token) {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
    const refreshed = await request(url);
    if (typeof refreshed.access_token !== "string" || !Number.isFinite(Number(refreshed.expires_in)) || Number(refreshed.expires_in) <= 0) throw new MetaError();
    return refreshed;
  }

  return { authorizationUrl, exchange, discover, graph, refreshInstagram };
}

module.exports = { createMetaClient, MetaError, SCOPES, metaId };
