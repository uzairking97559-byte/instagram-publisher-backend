"use strict";

// Browser Use Cloud REST API (v4): start/stop a cloud browser that loads a
// saved profile (the Instagram login), and list those profiles.
// https://docs.browser-use.com/cloud/api-v4-overview

const BASE_URL = "https://api.browser-use.com/api/v4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BrowserUseError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

function errorCode(status) {
  if (status === 401 || status === 403) return "browser_use_key_invalid";
  if (status === 402) return "browser_use_no_credits";
  if (status === 404) return "browser_use_not_found";
  if (status === 429) return "browser_use_busy";
  return "browser_use_failed";
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

function usage(browser = {}) {
  return {
    id: browser.id, status: browser.status, cdpUrl: browser.cdpUrl || null,
    proxyMb: number(browser.proxyUsedMb), proxyCostUsd: number(browser.proxyCost), browserCostUsd: number(browser.browserCost)
  };
}

function createBrowserUseClient({ apiKey, fetchImpl = fetch, baseUrl = BASE_URL, timeoutMs = 30000 }) {
  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(baseUrl + path, {
        method,
        headers: { "X-Browser-Use-API-Key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch { throw new BrowserUseError("browser_use_unreachable"); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new BrowserUseError(errorCode(response.status), response.status);
    return data;
  }

  return {
    // Proxy in India by default: the profile's Instagram login was saved there.
    // null: no proxy (Browser Use's own connection, no proxy data billed).
    async createBrowser({ profileId, proxyCountryCode = "in", timeoutMinutes = 180, metadata = {} }) {
      const data = await call("POST", "/browsers", { profileId, proxyCountryCode, timeout: timeoutMinutes, metadata });
      if (!data.id || !data.cdpUrl) throw new BrowserUseError("browser_use_failed");
      return usage(data);
    },
    async getBrowser(id) { return usage(await call("GET", `/browsers/${encodeURIComponent(id)}`)); },
    // Stopping also saves the profile (cookies) and refunds unused browser time.
    async stopBrowser(id) { return usage(await call("PATCH", `/browsers/${encodeURIComponent(id)}`, { action: "stop" })); },
    async listProfiles() {
      let data;
      try { data = await call("GET", "/profiles?pageSize=50"); }
      catch (error) {
        if (error.code !== "browser_use_failed") throw error;
        data = await call("GET", "/profiles");
      }
      const items = Array.isArray(data) ? data : data.items || data.profiles || data.data || [];
      return items.filter((item) => UUID.test(item?.id || "")).map((item) => ({
        id: item.id, name: typeof item.name === "string" ? item.name.slice(0, 120) : null,
        last_used_at: item.lastUsedAt || null
      }));
    }
  };
}

module.exports = { createBrowserUseClient, BrowserUseError, UUID };
