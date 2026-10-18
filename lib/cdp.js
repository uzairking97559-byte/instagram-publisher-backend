"use strict";

// A small Chrome DevTools Protocol client on Node's built-in WebSocket. The DM
// sender drives a cloud browser with it directly, so no AI model (and no extra
// npm package) is involved in sending a message.

class CdpError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

// Accepts a ws(s):// DevTools URL, or an http(s):// endpoint whose /json/version
// names the browser's WebSocket URL.
async function resolveWebSocketUrl(cdpUrl, fetchImpl = fetch) {
  let url;
  try { url = new URL(cdpUrl); } catch { throw new CdpError("cdp_unavailable", "invalid url"); }
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CdpError("cdp_unavailable", "unsupported url");
  let data = null;
  try {
    const response = await fetchImpl(new URL("/json/version", url).href, { signal: AbortSignal.timeout(15000) });
    if (response.ok) data = await response.json();
  } catch { /* fall back to the endpoint itself */ }
  const fallback = new URL(url.href);
  fallback.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (!data?.webSocketDebuggerUrl) return fallback.href;
  const ws = new URL(data.webSocketDebuggerUrl);
  // A proxied browser can report its own internal address; reach it through
  // the public host that answered instead.
  if (LOCAL_HOSTS.has(ws.hostname) && !LOCAL_HOSTS.has(url.hostname)) {
    ws.protocol = fallback.protocol; ws.host = url.host;
  }
  return ws.href;
}

class CdpConnection {
  static async connect(wsUrl, { timeoutMs = 30000 } = {}) {
    if (typeof WebSocket !== "function") throw new CdpError("cdp_unavailable", "WebSocket missing (Node 22+ needed)");
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new CdpError("cdp_timeout", "connect")); }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError("cdp_unavailable", "connect")); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener("message", (event) => this.receive(event.data));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new CdpError("cdp_closed")); }
      this.pending.clear();
    });
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); } catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError("cdp_command_failed", `${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result || {});
      return;
    }
    if (message.method) for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new CdpError("cdp_closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError("cdp_timeout", method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new CdpError("cdp_closed")); }
    });
  }

  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { try { this.ws.close(); } catch {} }
}

class CdpPage {
  constructor(connection, sessionId) { this.connection = connection; this.sessionId = sessionId; }
  send(method, params, timeoutMs) { return this.connection.send(method, params, this.sessionId, timeoutMs); }
  get closed() { return this.connection.closed; }

  // Runs fn(...args) in the page and returns its JSON result. fn must not use
  // anything from Node: only its own source is sent to the browser.
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new CdpError("page_script_failed", result.exceptionDetails.exception?.description?.slice(0, 200) || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { stop(); resolve(false); }, timeoutMs);
      const stop = this.connection.on((message) => {
        if (message.sessionId === this.sessionId && message.method === method) { clearTimeout(timer); stop(); resolve(true); }
      });
    });
  }

  async navigate(url, { timeoutMs = 45000 } = {}) {
    const loaded = this.waitForEvent("Page.domContentEventFired", timeoutMs);
    const result = await this.send("Page.navigate", { url }, timeoutMs);
    if (result.errorText) throw new CdpError("navigation_failed", result.errorText);
    await loaded;
  }

  insertText(text) { return this.send("Input.insertText", { text }); }

  async pressEnter({ shift = false } = {}) {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r", unmodifiedText: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
}

// Attaches to the browser's first tab (or opens one). Pictures, videos and
// fonts are refused before they download, which keeps proxy data (billed per
// GB) small; everything a page needs to work still loads.
// The page is sized like a laptop screen so sites show their desktop layout
// (on a narrow window Instagram switches to its phone layout).
async function openPage(connection, { block = ["Image", "Media", "Font"], viewport = { width: 1366, height: 900 } } = {}) {
  const { targetInfos = [] } = await connection.send("Target.getTargets");
  const existing = targetInfos.find((target) => target.type === "page");
  const targetId = existing ? existing.targetId : (await connection.send("Target.createTarget", { url: "about:blank" })).targetId;
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new CdpPage(connection, sessionId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  if (viewport) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  }
  // Service workers could otherwise fetch blocked files on the page's behalf.
  await page.send("Network.enable", { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 256 * 1024 }).catch(() => {});
  await page.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => {});
  // Counts downloaded bytes by resource type, to see where proxy data goes.
  let usage = { bytes: 0, byType: {} };
  const types = new Map();
  connection.on((message) => {
    if (message.sessionId !== sessionId) return;
    const params = message.params || {};
    if (message.method === "Network.responseReceived") types.set(params.requestId, params.type || "Other");
    else if (message.method === "Network.loadingFailed") types.delete(params.requestId);
    else if (message.method === "Network.loadingFinished") {
      const size = Number(params.encodedDataLength) || 0;
      const type = types.get(params.requestId) || "Other";
      types.delete(params.requestId);
      usage.bytes += size;
      usage.byType[type] = (usage.byType[type] || 0) + size;
    }
  });
  page.takeUsage = () => { const taken = usage; usage = { bytes: 0, byType: {} }; return taken; };
  if (block.length) {
    connection.on((message) => {
      if (message.sessionId === sessionId && message.method === "Fetch.requestPaused") {
        page.send("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
      }
    });
    await page.send("Fetch.enable", { patterns: block.map((resourceType) => ({ urlPattern: "*", resourceType, requestStage: "Request" })) });
  }
  return page;
}

module.exports = { CdpConnection, CdpPage, CdpError, openPage, resolveWebSocketUrl, sleep };
