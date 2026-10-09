"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { postgresPoolOptions } = require("../lib/database");

test("Postgres TLS mode is explicit and URL SSL flags cannot override it", () => {
  const databaseUrl = "postgres://localhost/publisher?sslmode=disable&sslcert=%2Ftmp%2Fcert&sslkey=%2Ftmp%2Fkey&sslrootcert=%2Ftmp%2Froot";
  const required = postgresPoolOptions({ DATABASE_URL: databaseUrl, PGSSL: "require" });
  assert.deepEqual(required.ssl, { rejectUnauthorized: false });
  const cleanedUrl = new URL(required.connectionString);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) assert.equal(cleanedUrl.searchParams.has(key), false);

  assert.deepEqual(postgresPoolOptions({ DATABASE_URL: databaseUrl, PGSSL: "verify-full" }).ssl, { rejectUnauthorized: true });
  assert.deepEqual(postgresPoolOptions({ DATABASE_URL: databaseUrl }).ssl, { rejectUnauthorized: true });
  assert.equal(postgresPoolOptions({ DATABASE_URL: databaseUrl, PGSSL: "disable" }).ssl, false);
  assert.throws(() => postgresPoolOptions({ DATABASE_URL: databaseUrl, PGSSL: "yes" }), /PGSSL must be one of/);
});
