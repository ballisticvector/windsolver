#!/usr/bin/env node
/**
 * Run the WindSolver HTTP service.
 *
 *   node tools/serve.js --port 8787 --origins https://ballisticvector.com
 *
 * Everything is a flag or an environment variable rather than a config file,
 * because the deployment target is a systemd unit and a unit file is where the
 * settings belong. Flags win over the environment.
 *
 *   PORT, HOST, WINDSOLVER_ORIGINS (comma-separated), WINDSOLVER_TIMEOUT_MS,
 *   WINDSOLVER_MAX_CONCURRENT, WINDSOLVER_MAX_QUEUE
 *
 * The service is the *only* thing that fetches: it holds the terrain and
 * atmosphere caches, and a consumer reaches it over HTTP rather than importing
 * the solve into its own process.
 */

"use strict";

const server = require("../server.js");

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const a = args(process.argv);
const port = num(a.port, num(process.env.PORT, server.DEFAULT_PORT));
const host = a.host || process.env.HOST || "127.0.0.1";
const originsRaw = a.origins || process.env.WINDSOLVER_ORIGINS || "";
const origins = String(originsRaw).split(",").map(function (s) { return s.trim(); }).filter(Boolean);

const options = {
  origins: origins,
  timeoutMs: num(a.timeout, num(process.env.WINDSOLVER_TIMEOUT_MS, server.DEFAULT_TIMEOUT_MS)),
  maxConcurrent: num(a.concurrency, num(process.env.WINDSOLVER_MAX_CONCURRENT, server.DEFAULT_MAX_CONCURRENT)),
  maxQueue: num(a.queue, num(process.env.WINDSOLVER_MAX_QUEUE, server.DEFAULT_MAX_QUEUE)),
  log: function (entry) {
    process.stdout.write(JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + "\n");
  }
};

const srv = server.createServer(options);

srv.listen(port, host, function () {
  process.stdout.write(JSON.stringify({
    t: new Date().toISOString(),
    level: "info",
    message: "windsolver listening",
    host: host,
    port: port,
    origins: origins,
    timeoutMs: options.timeoutMs,
    maxConcurrent: options.maxConcurrent,
    maxQueue: options.maxQueue,
    routes: server.ROUTES
  }) + "\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, function () {
    // Let a solve that is already running finish: a deploy that cuts a request
    // in half wastes the fetch it had already paid for.
    srv.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 10000).unref();
  });
}
