"use strict";

require("dotenv").config();
const { createApp } = require("./lib/app");
const { createDatabase } = require("./lib/database");

async function start() {
  const log = (entry) => process.stdout.write(JSON.stringify(entry) + "\n");
  const db = createDatabase(process.env, () => log({ event: "database_connection_error" }));
  const app = await createApp({ db, logger: log });
  const server = app.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => log({ event: "server_started" }));
  server.headersTimeout = 15000;
  server.requestTimeout = 180000;
  const retry = setInterval(() => { void app.locals.initialize(); }, 60000);
  retry.unref();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(retry);
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    server.close(async () => {
      await db?.close();
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  start().catch(() => {
    process.stderr.write('{"event":"startup_failed"}\n');
    process.exitCode = 1;
  });
}

module.exports = { createApp, start };
