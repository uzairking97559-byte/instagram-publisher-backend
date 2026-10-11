"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { BATCH_INTERVALS } = require("../lib/publishing");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("the dashboard, server and database offer the same gaps, 5 minutes to 1 hour", () => {
  assert.deepEqual(BATCH_INTERVALS, [5, 10, 15, 20, 30, 45, 60]);
  const select = read("public/index.html").match(/<select id="interval-minutes">([\s\S]*?)<\/select>/)[1];
  const offered = [...select.matchAll(/<option value="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(offered, BATCH_INTERVALS);
  assert.match(select, /<option value="10" selected>/, "10 minutes stays the default");
  const checks = [...read("schema.sql").matchAll(/interval_minutes IN \(([^)]*)\)/g)].map((match) => match[1].split(",").map(Number));
  assert.ok(checks.length >= 2, "both the table definition and the migration list the gaps");
  for (const values of checks) assert.deepEqual(values, BATCH_INTERVALS);
});
