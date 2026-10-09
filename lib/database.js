"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const schema = fs.readFileSync(path.join(__dirname, "../schema.sql"), "utf8");

function postgresSslOptions(mode = "verify-full") {
  switch (mode.trim().toLowerCase()) {
    case "disable": return false;
    // Render's internal Postgres certificates are self-signed. This keeps
    // TLS mandatory while allowing that documented private-network setup.
    case "require": return { rejectUnauthorized: false };
    case "verify-full": return { rejectUnauthorized: true };
    default: throw new Error("PGSSL must be one of: verify-full, require, disable");
  }
}

function postgresPoolOptions(env) {
  const url = new URL(env.DATABASE_URL);
  // Connection-string flags must not silently override the explicit PGSSL policy.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  return {
    connectionString: url.href,
    ssl: postgresSslOptions(env.PGSSL ?? "verify-full"),
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000
  };
}

function createDatabase(env, onError = () => {}) {
  if (!env.DATABASE_URL) return null;
  const pool = new Pool(postgresPoolOptions(env));
  pool.on("error", onError);
  return {
    query: (sql, values) => pool.query(sql, values),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end()
  };
}

async function initializeDatabase(db) {
  // The preceding PR was not deployed. Never silently claim data from its
  // browser-owned prototype if someone has nevertheless used that schema.
  const legacy = await db.query("SELECT to_regclass('public.connected_accounts') AS legacy");
  if (legacy.rows[0].legacy) {
    const existing = await db.query("SELECT 1 FROM connected_accounts LIMIT 1");
    if (existing.rows.length) throw new Error("Legacy account migration requires owner review");
  }
  await db.exec(schema);
  await db.query("DELETE FROM publisher_sessions WHERE expires_at <= NOW()");
  await db.query("DELETE FROM publisher_oauth_attempts WHERE expires_at < NOW() - INTERVAL '1 day'");
}

module.exports = { createDatabase, initializeDatabase, postgresSslOptions, postgresPoolOptions };
