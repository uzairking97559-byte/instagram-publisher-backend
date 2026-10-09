"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const validToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const validId = (value) => typeof value === "string" && /^\d{1,30}$/.test(value);

function readConfig(env) {
  let origin = null;
  let callback = null;
  const production = env.NODE_ENV === "production" || env.RENDER === "true";
  try {
    const url = new URL(env.REDIRECT_URI);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        url.pathname !== "/auth/meta/callback" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production))) {
      throw new Error("Invalid callback");
    }
    origin = url.origin;
    callback = url.href;
  } catch { /* Invalid configuration disables sign-in rather than trusting Host. */ }
  let key = null;
  const raw = env.TOKEN_ENCRYPTION_KEY || "";
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32 && decoded.toString("base64") === raw) key = decoded;
  }
  const password = typeof env.DASHBOARD_PASSWORD === "string" &&
    env.DASHBOARD_PASSWORD.length >= 16 && env.DASHBOARD_PASSWORD.length <= 256
    ? env.DASHBOARD_PASSWORD : null;
  const version = /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || "")
    ? env.META_GRAPH_VERSION : "v24.0";
  return {
    origin, callback, key, password, version, production,
    secureCookie: production || Boolean(origin?.startsWith("https:")),
    facebook: { id: env.META_APP_ID, secret: env.META_APP_SECRET },
    // Instagram Login credentials are distinct from the Facebook app credentials.
    instagram: { id: env.INSTAGRAM_APP_ID, secret: env.INSTAGRAM_APP_SECRET }
  };
}

function encryptToken(value, key, context) {
  if (!key || typeof value !== "string" || !value) throw new Error("Invalid token storage input");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptToken(value, key, context) {
  const parts = typeof value === "string" ? value.split(".") : [];
  if (!key || parts.length !== 3) throw new Error("Invalid stored token");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid stored token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function passwordVerifier(password, key) {
  if (!password || !key) return { version: null, verify: async () => false };
  const salt = crypto.randomBytes(16);
  const expected = await scrypt(password, salt, 32);
  return {
    // A password change invalidates all older sessions without deleting accounts.
    version: crypto.createHmac("sha256", key).update(`publisher-owner-v1:${password}`).digest("hex"),
    async verify(input) {
      if (typeof input !== "string" || input.length > 256) return false;
      const actual = await scrypt(input, salt, 32);
      return crypto.timingSafeEqual(expected, actual);
    }
  };
}

function cookieToken(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const split = part.indexOf("=");
    if (part.slice(0, split).trim() === name) {
      const value = part.slice(split + 1).trim();
      return validToken(value) ? value : null;
    }
  }
  return null;
}

function sameOrigin(req, origin) {
  if (!origin) return false;
  try {
    return req.get("origin") === origin && new URL(origin).host === req.get("host");
  } catch { return false; }
}

function publicMediaUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    // Meta fetches media; this server never fetches arbitrary submitted URLs.
    // Reject credentials, local destinations and all literal IPs up front.
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        (url.port && url.port !== "443") || net.isIP(hostname.replace(/^\[|\]$/g, "")) ||
        !hostname.includes(".") || /\.(localhost|local|internal|test|invalid)$/.test(hostname) ||
        hostname.endsWith(".localhost") || hostname.endsWith(".onion")) return null;
    return url.href;
  } catch { return null; }
}

function rateLimiter({ limit, windowMs, maxKeys = 5000 }) {
  const entries = new Map();
  return (key, now = Date.now()) => {
    let entry = entries.get(key);
    if (!entry || entry.until <= now) {
      for (const [k, v] of entries) if (v.until <= now) entries.delete(k);
      if (entries.size >= maxKeys && !entry) return false;
      entry = { count: 0, until: now + windowMs };
      entries.set(key, entry);
    }
    entry.count++;
    return entry.count <= limit;
  };
}

module.exports = {
  hash, randomToken, validToken, validId, readConfig, encryptToken, decryptToken,
  passwordVerifier, cookieToken, sameOrigin, publicMediaUrl, rateLimiter
};

