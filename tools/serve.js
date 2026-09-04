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
 *   WINDSOLVER_MAX_CONCURRENT, WINDSOLVER_MAX_QUEUE, WINDSOLVER_STATIC_DIR,
 *   WINDSOLVER_PREWARM (lat,lon[,radiusMiles] entries separated by ;),
 *   WINDSOLVER_PREWARM_INTERVAL_MS,
 *   WINDSOLVER_API_KEYS (name:secret pairs; empty means no authentication),
 *   WINDSOLVER_PAGE_NEEDS_KEY (set to close /v1/ to the map page as well)
 *
 * The map page in `public/` is served by default, so one process is the whole
 * product and a deploy is one copy. `--no-static` turns it off for a box that
 * should answer the API and nothing else.
 *
 * The service is the *only* thing that fetches: it holds the terrain and
 * atmosphere caches, and a consumer reaches it over HTTP rather than importing
 * the solve into its own process.
 */

"use strict";

const nodePath = require("path");
const http = require("http");

const server = require("../server.js");
const auth = require("../auth.js");
const prewarm = require("../prewarm.js");

const BUNDLED_PAGE = nodePath.join(__dirname, "..", "public");

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

function truthy(value) {
  return value !== undefined && value !== "" && !/^(0|no|off|false)$/i.test(String(value));
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

const staticDir = a["no-static"] || process.env.WINDSOLVER_STATIC_DIR === ""
  ? null
  : (typeof a.static === "string" ? a.static : process.env.WINDSOLVER_STATIC_DIR || BUNDLED_PAGE);

// Refuse to start on a key list that does not parse, rather than starting open
// while an operator believes the service is closed. The message names the
// problem and never the secret.
let keys;
try {
  keys = auth.parseKeys(process.env.WINDSOLVER_API_KEYS);
} catch (err) {
  process.stderr.write(JSON.stringify({
    t: new Date().toISOString(),
    level: "error",
    message: "WINDSOLVER_API_KEYS: " + err.message
  }) + "\n");
  process.exit(1);
}

const gatekeeper = auth.createAuth({
  keys: keys,
  allowPage: !truthy(process.env.WINDSOLVER_PAGE_NEEDS_KEY)
});

const options = {
  auth: gatekeeper,
  origins: origins,
  staticDir: staticDir,
  timeoutMs: num(a.timeout, num(process.env.WINDSOLVER_TIMEOUT_MS, server.DEFAULT_TIMEOUT_MS)),
  maxConcurrent: num(a.concurrency, num(process.env.WINDSOLVER_MAX_CONCURRENT, server.DEFAULT_MAX_CONCURRENT)),
  maxQueue: num(a.queue, num(process.env.WINDSOLVER_MAX_QUEUE, server.DEFAULT_MAX_QUEUE)),
  log: function (entry) {
    process.stdout.write(JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + "\n");
  }
};

const places = prewarm.parsePlaces(a.prewarm === true ? "" : (a.prewarm || process.env.WINDSOLVER_PREWARM));

const srv = server.createServer(options);

srv.listen(port, host, function () {
  process.stdout.write(JSON.stringify({
    t: new Date().toISOString(),
    level: "info",
    message: "windsolver listening",
    host: host,
    port: port,
    origins: origins,
    staticDir: staticDir,
    // Names, never secrets. This line is the one place an operator can see
    // whether the service came up open or closed.
    apiKeys: gatekeeper.enabled ? gatekeeper.names : "none — /v1/ is open",
    pageNeedsKey: !gatekeeper.allowPage,
    timeoutMs: options.timeoutMs,
    maxConcurrent: options.maxConcurrent,
    maxQueue: options.maxQueue,
    routes: server.ROUTES,
    prewarm: places
  }) + "\n");

  // Warmed through the socket the service is already listening on, so the entry
  // left in the cache is the one a visitor's request looks up. See prewarm.js.
  if (places.length) {
    prewarm.start(places, {
      intervalMs: num(a["prewarm-interval"],
        num(process.env.WINDSOLVER_PREWARM_INTERVAL_MS, prewarm.DEFAULT_INTERVAL_MS)),
      log: options.log,
      fetchPath: function (path) {
        return new Promise(function (resolve, reject) {
          // The prewarm is a caller like any other, so once keys are on it
          // needs one: the first configured key, which is on this box already.
          // Without this the demo goes cold the moment the service is closed,
          // and the log says 401 rather than saying why.
          const headers = keys.length ? { authorization: "Bearer " + keys[0].secret } : {};
          const req = http.get({ host: host, port: port, path: path, headers: headers }, function (res) {
            res.resume();
            res.on("end", function () { resolve(res.statusCode); });
          });
          req.on("error", reject);
          // Outlast the service's own ceiling: a prewarm that gives up first
          // reports a failure for a solve that went on to succeed.
          req.setTimeout(options.timeoutMs + 15000, function () {
            req.destroy(new Error("prewarm request timed out"));
          });
        });
      }
    });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, function () {
    // Let a solve that is already running finish: a deploy that cuts a request
    // in half wastes the fetch it had already paid for.
    srv.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 10000).unref();
  });
}
