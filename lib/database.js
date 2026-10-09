"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const schema = fs.readFileSync(path.join(__dirname, "../schema.sql"), "utf8");

function createDatabase(env, onError = () => {}) {
  if (!env.DATABASE_URL) return null;
  const url = new URL(env.DATABASE_URL);
  // Connection-string flags must not silently override certificate verification.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  const pool = new Pool({
    connectionString: url.href,
    ssl: env.PGSSL === "disable" ? false : { rejectUnauthorized: true },
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000
  });
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

module.exports = { createDatabase, initializeDatabase };
