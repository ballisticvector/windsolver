/**
 * The HTTP service: the boundary a consumer actually reaches WindSolver across.
 *
 * Everything under this file is a library, and a library is the wrong shape for
 * the boundary. A consumer that `require`s the solve holds the terrain cache,
 * the atmosphere cache and the CPU cost inside its own process, and a second
 * consumer holds a second copy of all three. The engine is a service; this is
 * the service.
 *
 * Three properties are deliberate.
 *
 * **The general answer is the endpoint, and the line is a view over it.**
 * `/v1/field` takes a coordinate and a box and returns east/north over the
 * ground, which is what a map, a fire crew or a sailor wants. `/v1/line` and
 * `/v1/windprofile` cut a line out of the same field. There is no bearing in
 * the general route and no rifle in any of them — the same rule the cache key
 * follows.
 *
 * **The engine's refusals survive the trip.** Every module below refuses
 * carefully and names the reason; mapping all of that onto "500 internal error"
 * would throw away the most useful thing the engine produces. A caller's
 * mistake comes back as a 4xx carrying the engine's own code, an upstream
 * outage as a 5xx worth retrying.
 *
 * **The limits are in the service, not in the operator's hope.** A cold solve
 * is seconds and NOMADS has been measured at 53 s on a bad minute, so requests
 * are gated to a small number of concurrent solves, queued behind that, refused
 * with `busy` past the queue, and abandoned with `timeout` past the deadline.
 * Without those, the first slow upstream minute turns into every socket on the
 * box waiting on the same fetch.
 *
 * The field service is injected, so this module can be tested with no network:
 * `nomads.js` remains the only place that fetches.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const nodePath = require("path");

const geo = require("./geo.js");
const downscale = require("./downscale.js");
const slice = require("./slice.js");
const profile = require("./profile.js");

const API_VERSION = 1;

const ROUTES = ["/healthz", "/v1/field", "/v1/line", "/v1/windprofile"];

const DEFAULT_PORT = 8787;

// Two concurrent solves on a 2-core box: a solve is CPU-bound in the terrain
// derivatives, so more workers than cores buys nothing and lengthens every
// request rather than serving more of them.
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUE = 8;

// 45 s, chosen against the measured worst case rather than a round number: a
// cold NOMADS fetch has been seen at 53 s, so this deliberately refuses one
// rather than holding a socket for a minute. A caller that wants the slow answer
// asks again and gets the cache.
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_RETRY_AFTER_S = 5;

// 40,000 cells is ~2 MB of JSON with five values a cell. The ceiling is on the
// answer, not on the domain: a large box at a coarse output grid is cheap.
const DEFAULT_MAX_CELLS = 40000;
const DEFAULT_COLS = 48;

const DEFAULT_RADIUS_MILES = 1;
const MAX_RADIUS_MILES = 30;
const MAX_LENGTH_M = 100000;
const MAX_STATIONS = 2000;
const MAX_HEIGHTS = 40;

// HRRR's grid spacing, reported so a consumer can display what the field was
// downscaled from rather than inferring it.
const MODEL_RESOLUTION_M = 3000;

const NOTICE =
  "Modelled, not measured: HRRR downscaled onto 3DEP terrain. No comparison " +
  "with an observed wind has been made.";

/**
 * How an engine code reaches the caller.
 *
 * 4xx means the request was wrong and repeating it will fail the same way; 5xx
 * means WindSolver or something upstream of it failed and the same request may
 * work later. A code absent from this table is a defect here, and becomes a 500
 * that says nothing — see `respondError`.
 */
const STATUS_BY_CODE = {
  // The caller's request.
  "no-domain": 400,
  "bad-domain": 400,
  "bad-request": 400,
  "bad-bearing": 400,
  "bad-origin": 400,
  "bad-distance": 400,
  "bad-length": 400,
  "bad-step": 400,
  "bad-heights": 400,
  "bad-height": 400,
  "bad-level": 400,
  "bad-roughness": 400,
  "box-crosses-antimeridian": 400,
  "outside-domain": 400,
  "no-shelter": 400,
  "no-height": 400,
  "too-large": 413,

  // The ground or the air is not there to be had.
  "no-terrain": 502,
  "no-grids": 502,
  "no-georeference": 502,
  "not-a-dem": 502,
  "too-void": 502,
  "empty-volume": 502,
  "empty-response": 502,
  "no-wind": 502,
  "no-such-parameter": 502,
  "no-such-level": 502,

  // Upstream answered, and what it said cannot be trusted.
  "html-response": 502,
  "not-grib": 502,
  "subregion-ignored": 502,
  "mixed-grid": 502,
  "http-error": 502,
  "tiff-directory": 502,
  "tiff-type": 502,
  "not-tiff": 502,
  "tile-short": 502,
  "bad-chunk": 502,
  "lzw": 502,
  "predictor": 502,
  "raster-rotated": 502,

  // Upstream has nothing for this hour yet.
  "no-cycle": 503,
  "aborted": 504
};

// Served from `staticDir` when one is configured. Anything not named here is
// refused rather than sent as a guessed type: a page is a small, known set of
// files, and an unknown extension in that directory is a mistake worth seeing.
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

/**
 * The file a request path names inside `root`, or `null` if it names none.
 *
 * The check is on the *resolved* path rather than on the request text, because
 * `..` is only one of the ways out of a directory — an encoded separator or an
 * absolute path both read as ordinary requests. Resolving first and then asking
 * whether the answer is still under the root is the form of the check that does
 * not depend on enumerating the tricks. A symlink out of the directory survives
 * this one, so `serveStatic` repeats it against the real path on disk.
 */
function resolveStatic(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.indexOf("\u0000") !== -1) return null;

  const relative = decoded.replace(/^\/+/, "");
  const candidate = nodePath.resolve(root, relative === "" ? "index.html" : relative);
  const rootResolved = nodePath.resolve(root);
  if (candidate !== rootResolved &&
      !candidate.startsWith(rootResolved + nodePath.sep)) {
    return null;
  }
  return candidate;
}

function badParameter(name, message, extra) {
  const err = new Error(message);
  err.code = "bad-parameter";
  err.parameter = name;
  err.status = 400;
  if (extra) Object.assign(err, extra);
  return err;
}

function serviceError(code, status, message, extra) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

/** A required or optional number, refused by name rather than coerced. */
function numberParam(params, name, opts) {
  const o = opts || {};
  const raw = params.get(name);
  if (raw === null || raw === "") {
    if (o.required) throw badParameter(name, name + " is required");
    return o.default;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw badParameter(name, name + " must be a number, not " + JSON.stringify(raw));
  }
  if (o.min !== undefined && value < o.min) {
    throw badParameter(name, name + " must be at least " + o.min + ", not " + value);
  }
  if (o.max !== undefined && value > o.max) {
    throw badParameter(name, name + " must be at most " + o.max + ", not " + value);
  }
  if (o.above !== undefined && !(value > o.above)) {
    throw badParameter(name, name + " must be greater than " + o.above + ", not " + value);
  }
  return value;
}

/** An ascending, strictly increasing list of heights above ground, in metres. */
function heightsParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw === "") return null;
  const parts = raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) throw badParameter(name, name + " must be a comma-separated list of heights in metres");
  if (parts.length > MAX_HEIGHTS) {
    throw badParameter(name, name + " may name at most " + MAX_HEIGHTS + " heights, not " + parts.length);
  }
  const heights = [];
  for (const part of parts) {
    const h = Number(part);
    if (!Number.isFinite(h) || h <= 0) {
      throw badParameter(name, name + " must be positive metres above ground, not " + JSON.stringify(part));
    }
    heights.push(h);
  }
  for (let i = 1; i < heights.length; i++) {
    if (!(heights[i] > heights[i - 1])) {
      throw badParameter(name,
        name + " must ascend strictly: " + heights[i - 1] + " then " + heights[i]);
    }
  }
  return heights;
}

/** The coordinate every route starts from. */
function originParam(params) {
  return {
    lat: numberParam(params, "lat", { required: true, min: -90, max: 90 }),
    lon: numberParam(params, "lon", { required: true, min: -180, max: 180 })
  };
}

/**
 * A valid time as an ISO string.
 *
 * The engine carries `validTime` as a `Date`. `JSON.stringify` turns that into
 * ISO on its own, but string concatenation does not — an unconverted `Date` in
 * a source line reads `Thu Sep 03 2026 22:00:00 GMT+0000 (Coordinated Universal
 * Time)`, which is a valid time nobody can parse. Convert once, here.
 */
function isoTime(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** What the field was assembled from, in one sentence a consumer can display. */
function sourceLine(field) {
  const model = field.reference && field.reference.source ? field.reference.source : "HRRR";
  const dataset = field.terrain && field.terrain.dataset ? field.terrain.dataset : "3DEP";
  return "WindSolver " + model + " " + isoTime(field.validTime) + " + 3DEP " + dataset;
}

/** The provenance block that rides on every answer, because it is not optional. */
function provenanceOf(field) {
  return {
    validTime: isoTime(field.validTime),
    source: sourceLine(field),
    modelled: true,
    notice: NOTICE,
    reference: field.reference
      ? {
        source: field.reference.source === undefined ? null : field.reference.source,
        speedMps: Math.hypot(field.reference.east, field.reference.north),
        east: field.reference.east,
        north: field.reference.north,
        heightAglM: field.reference.heightAglM,
        level: field.reference.level,
        resolutionM: MODEL_RESOLUTION_M,
        cellsAcross: field.reference.cellsAcross
      }
      : null,
    terrain: field.terrain || null,
    offset: field.offset === undefined ? null : field.offset
  };
}

/**
 * The native field resampled onto a regular lat/long grid.
 *
 * The native grid is UTM — metres, square on the ground, and the shape the
 * derivatives are computed on. Almost every consumer of an HTTP answer wants
 * lat/long, so this resamples rather than making each of them carry a
 * projection. `native` goes out alongside it so nobody mistakes the answer for
 * the field's own shape.
 */
function gridOver(field, box, cols, rows) {
  const lats = new Array(rows);
  const lons = new Array(cols);
  for (let r = 0; r < rows; r++) {
    // Row 0 is the north edge: the order a raster consumer already assumes.
    lats[r] = rows === 1
      ? (box.north + box.south) / 2
      : box.north - (r * (box.north - box.south)) / (rows - 1);
  }
  for (let c = 0; c < cols; c++) {
    lons[c] = cols === 1
      ? (box.west + box.east) / 2
      : box.west + (c * (box.east - box.west)) / (cols - 1);
  }

  const n = rows * cols;
  const east = new Array(n);
  const north = new Array(n);
  const speed = new Array(n);
  const fromDeg = new Array(n);
  const elevation = new Array(n);
  let covered = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const wind = downscale.windAt(field, lats[r], lons[c]);
      if (wind) {
        covered++;
        east[i] = wind.east;
        north[i] = wind.north;
        speed[i] = wind.speedMps;
        fromDeg[i] = wind.fromDeg;
      } else {
        east[i] = null;
        north[i] = null;
        speed[i] = null;
        fromDeg[i] = null;
      }
      elevation[i] = slice.elevationAt(field, lats[r], lons[c]);
    }
  }

  return {
    cols: cols,
    rows: rows,
    order: "row-major, north to south, west to east",
    lats: lats,
    lons: lons,
    eastMps: east,
    northMps: north,
    speedMps: speed,
    fromDeg: fromDeg,
    elevationM: elevation,
    coveredFraction: n ? covered / n : 0
  };
}

/** Rows that keep an output cell about as tall as it is wide. */
function rowsFor(box, cols) {
  const midLat = (box.north + box.south) / 2;
  const spanNS = (box.north - box.south) * geo.METERS_PER_DEG_LAT;
  const spanEW = (box.east - box.west) * geo.metersPerDegLon(midLat);
  if (!(spanEW > 0)) return cols;
  return Math.max(2, Math.round((cols * spanNS) / spanEW));
}

/**
 * A gate in front of the solve.
 *
 * Not a rate limiter: the thing worth bounding is how many terrain solves run
 * at once, because they are CPU-bound and a queue of them makes every caller
 * slower rather than any caller served. Past the queue the honest answer is
 * `busy` with a `Retry-After`, which a client can act on, rather than a socket
 * held open until it gives up.
 */
function createGate(maxConcurrent, maxQueue) {
  let inFlight = 0;
  const waiting = [];

  function next() {
    if (!waiting.length || inFlight >= maxConcurrent) return;
    const resolve = waiting.shift();
    inFlight++;
    resolve();
  }

  return {
    get inFlight() { return inFlight; },
    get queued() { return waiting.length; },
    acquire: function () {
      if (inFlight < maxConcurrent) {
        inFlight++;
        return Promise.resolve();
      }
      if (waiting.length >= maxQueue) {
        return Promise.reject(serviceError("busy", 503,
          "WindSolver is at capacity: " + inFlight + " solves running and " +
          waiting.length + " queued"));
      }
      return new Promise(function (resolve) { waiting.push(resolve); });
    },
    release: function () {
      inFlight--;
      next();
    }
  };
}

/**
 * The handler.
 *
 * `field` is the field service — injected so the suite is offline, and so an
 * operator can hand in a service with different cache budgets without this file
 * knowing about caches.
 */
function createHandler(opts) {
  const o = opts || {};
  const fieldService = o.field || require("./field.js").createFieldService(o);
  const timeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs;
  const maxCells = o.maxCells === undefined ? DEFAULT_MAX_CELLS : o.maxCells;
  const retryAfterS = o.retryAfterSeconds === undefined ? DEFAULT_RETRY_AFTER_S : o.retryAfterSeconds;
  const origins = o.origins || [];
  const log = typeof o.log === "function" ? o.log : null;
  const startedAt = Date.now();

  // Through `realpath` at construction, so the per-request check below compares
  // two real paths: a root that is itself a symlink would fail every request.
  const staticDir = o.staticDir ? realDir(o.staticDir) : null;

  const gate = createGate(
    o.maxConcurrent === undefined ? DEFAULT_MAX_CONCURRENT : o.maxConcurrent,
    o.maxQueue === undefined ? DEFAULT_MAX_QUEUE : o.maxQueue
  );

  function send(res, status, body, headers) {
    // NaN and Infinity are not JSON. `JSON.stringify` turns NaN into `null`
    // quietly, which is the right answer arrived at by accident; this makes it
    // the decision, and catches Infinity too.
    const text = JSON.stringify(body, function (key, value) {
      return typeof value === "number" && !Number.isFinite(value) ? null : value;
    });
    const head = Object.assign({
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text)
    }, headers || {});
    res.writeHead(status, head);
    res.end(text);
  }

  function respondError(res, err, headers) {
    const code = err && err.code ? err.code : null;
    const status = (err && err.status) || STATUS_BY_CODE[code] || null;

    if (!status) {
      // Unmapped: a defect here or a bug below, and either way the message may
      // carry a path or an internal shape. Log it, say nothing.
      if (log) log({ level: "error", code: code, message: err && err.message, stack: err && err.stack });
      return send(res, 500, { ok: false, code: "internal", error: "Internal error." }, headers);
    }

    const body = { ok: false, code: code, error: err.message };
    for (const key of ["parameter", "distanceM", "lat", "lon", "maxCells", "timeoutMs", "voidFraction"]) {
      if (err[key] !== undefined) body[key] = err[key];
    }
    const extra = Object.assign({}, headers);
    if (status === 503) extra["retry-after"] = String(retryAfterS);
    return send(res, status, body, extra);
  }

  /**
   * A file from `staticDir`, or `false` if the request names nothing there.
   *
   * `false` rather than a 404 so the caller can fall through to the JSON
   * "no such route" answer: an API request that misspells a route should be
   * told so in the language it asked in, not handed a page.
   */
  async function serveStatic(method, urlPath, res, headers) {
    if (!staticDir) return false;
    const candidate = resolveStatic(staticDir, urlPath);
    if (!candidate) return false;

    let real;
    let stat;
    try {
      // The realpath is what actually gets read, so it is what has to be inside
      // the root: `resolveStatic` cannot see a symlink pointing out of it.
      real = await fs.promises.realpath(candidate);
      if (real !== staticDir && !real.startsWith(staticDir + nodePath.sep)) return false;
      stat = await fs.promises.stat(real);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const type = CONTENT_TYPES[nodePath.extname(real).toLowerCase()];
    if (!type) return false;

    const head = Object.assign({
      "content-type": type,
      "content-length": stat.size,
      // Short, because the page is edited far more often than it is hit, and a
      // stale map that quietly calls a route that has moved is worse than a
      // second request.
      "cache-control": "public, max-age=300"
    }, headers);

    if (method === "HEAD") {
      res.writeHead(200, head);
      res.end();
      return true;
    }

    res.writeHead(200, head);
    fs.createReadStream(real).pipe(res);
    return true;
  }

  /** Run a solve behind the gate and the deadline. */
  async function solve(worker) {
    await gate.acquire();
    let timer = null;
    try {
      const work = (async function () { return worker(); })();
      // The solve is not cancellable — a fetch already in flight will finish and
      // warm the cache — so the deadline abandons the wait rather than the work.
      // That is the useful half: the next caller gets the answer this one paid
      // for, instead of both waiting on one slow NOMADS minute.
      const deadline = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(serviceError("timeout", 504,
            "the solve did not finish within " + timeoutMs + " ms; it is still running and " +
            "the same request shortly should be served from cache",
            { timeoutMs: timeoutMs }));
        }, timeoutMs);
      });
      work.catch(function () { /* handled by the race, or abandoned by the deadline */ });
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      gate.release();
    }
  }

  async function handleField(params, res, headers) {
    const from = originParam(params);
    const radiusMiles = numberParam(params, "radiusMiles",
      { default: DEFAULT_RADIUS_MILES, above: 0, max: MAX_RADIUS_MILES });
    const resolutionM = numberParam(params, "resolutionM", { default: undefined, above: 0, max: 1000 });
    const cols = numberParam(params, "cols", { default: DEFAULT_COLS, min: 2, max: 4096 });

    const requested = geo.boundingBox(from.lat, from.lon, radiusMiles);
    const rows = rowsFor(requested, Math.round(cols));
    const cells = Math.round(cols) * rows;
    if (cells > maxCells) {
      throw serviceError("too-many-cells", 413,
        "a " + Math.round(cols) + " x " + rows + " grid is " + cells + " cells; this service " +
        "returns at most " + maxCells + ". Ask for fewer columns or a smaller radius.",
        { maxCells: maxCells, cells: cells });
    }

    const spec = { lat: from.lat, lon: from.lon, radiusMiles: radiusMiles };
    if (resolutionM !== undefined) spec.targetResolutionM = resolutionM;

    const field = await solve(function () { return fieldService.get(spec); });
    const box = field.domain || requested;

    return send(res, 200, Object.assign({
      ok: true,
      schemaVersion: API_VERSION,
      domain: box,
      heightAglM: field.heightAglM === undefined ? null : field.heightAglM,
      grid: gridOver(field, box, Math.round(cols), rows),
      native: {
        crs: field.crs && field.crs.name ? field.crs.name : (field.crs && field.crs.epsg
          ? "EPSG:" + field.crs.epsg
          : null),
        epsg: field.crs ? field.crs.epsg : null,
        width: field.width,
        height: field.height,
        resolutionM: field.resolutionM
      }
    }, provenanceOf(field)), headers);
  }

  /** The line both `/v1/line` and `/v1/windprofile` are cut from. */
  async function cutLine(params, opts2) {
    const from = originParam(params);
    const bearingName = opts2.bearingName;
    const lengthName = opts2.lengthName;

    const bearingDeg = numberParam(params, bearingName, { required: true, min: 0, max: 360 });
    const lengthM = numberParam(params, lengthName, { required: true, above: 0, max: MAX_LENGTH_M });
    const defaultStep = Math.max(10, lengthM / 20);
    const stepM = numberParam(params, "stepM", { default: defaultStep, above: 0, max: MAX_LENGTH_M });
    if (lengthM / stepM > MAX_STATIONS) {
      throw badParameter("stepM",
        "a " + lengthM + " m line every " + stepM + " m is more than " + MAX_STATIONS + " stations");
    }
    const heightsAglM = heightsParam(params, "heightsM");
    const resolutionM = numberParam(params, "resolutionM", { default: undefined, above: 0, max: 1000 });

    const spec = { box: slice.boxFor(from, bearingDeg, lengthM, { stepM: stepM }) };
    if (resolutionM !== undefined) spec.targetResolutionM = resolutionM;

    const field = await solve(function () { return fieldService.get(spec); });
    const cut = { from: from, bearingDeg: bearingDeg, lengthM: lengthM, stepM: stepM };
    const result = heightsAglM
      ? slice.plane(field, Object.assign({ heightsAglM: heightsAglM }, cut))
      : slice.transect(field, cut);

    return { field: field, result: result, heightsAglM: heightsAglM, bearingDeg: bearingDeg };
  }

  async function handleLine(params, res, headers) {
    const cut = await cutLine(params, { bearingName: "bearingDeg", lengthName: "lengthM" });
    const r = cut.result;

    const body = Object.assign({
      ok: true,
      schemaVersion: API_VERSION,
      from: r.from,
      bearingDeg: r.bearingDeg,
      lengthM: r.lengthM,
      stepM: r.stepM,
      convergenceDeg: r.convergenceDeg,
      heightAglM: r.heightAglM,
      units: { distance: "m", speed: "m/s", elevation: "m" },
      frame: "track: along is positive downrange, cross is positive to the right, up is positive",
      stations: r.stations.map(function (s) {
        return {
          distanceM: s.distanceM,
          lat: s.lat,
          lon: s.lon,
          forwardDeg: s.forwardDeg,
          elevationM: s.elevationM,
          speedMps: s.speedMps,
          fromDeg: s.fromDeg,
          eastMps: s.east,
          northMps: s.north,
          alongMps: s.alongMps,
          crossMps: s.crossMps
        };
      })
    }, provenanceOf(cut.field));

    if (cut.heightsAglM) {
      body.plane = {
        heightsAglM: r.heightsAglM,
        referenceHeightAglM: r.referenceHeightAglM,
        roughnessM: r.roughnessM,
        factors: r.factors,
        order: "[height][station]",
        alongMps: r.alongMps,
        crossMps: r.crossMps,
        upMps: r.upMps,
        speedMps: r.speedMps
      };
    }

    return send(res, 200, body, headers);
  }

  async function handleWindProfile(params, res, headers) {
    const cut = await cutLine(params, { bearingName: "azimuthDeg", lengthName: "rangeM" });
    if (!cut.heightsAglM) {
      throw badParameter("heightsM",
        "heightsM is required for a windProfile: the contract is a range x height grid");
    }
    const field = cut.field;
    const windProfile = slice.toWindProfile(cut.result, {
      source: sourceLine(field),
      terrainResolutionM: field.terrain ? field.terrain.resolutionM : null,
      windSourceResolutionM: MODEL_RESOLUTION_M
    });

    // Never emit a field the published contract would refuse. If this fires it
    // is a defect here, and shipping it would land in a consumer as an
    // `azimuth-mismatch` or worse, as a wind quietly applied.
    const check = profile.validateWindProfile(windProfile, { shotAzimuthDeg: cut.bearingDeg });
    if (!check.ok) {
      throw serviceError("contract-invalid", 500,
        "WindSolver produced a windProfile its own contract refuses: " + check.error);
    }

    return send(res, 200, Object.assign({
      ok: true,
      schemaVersion: API_VERSION,
      windProfile: windProfile,
      convergenceDeg: cut.result.convergenceDeg,
      elevationM: cut.result.stations.map(function (s) { return s.elevationM; })
    }, provenanceOf(field)), headers);
  }

  return function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://windsolver.invalid");
    } catch {
      return send(res, 400, { ok: false, code: "bad-url", error: "the request line is not a URL" });
    }

    const origin = req.headers.origin;
    const headers = {};
    if (origin && origins.indexOf(origin) !== -1) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "Origin";
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, Object.assign({
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-max-age": "600"
      }, headers));
      return res.end();
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { ok: false, code: "bad-method", error: "only GET is served here" },
        Object.assign({ allow: "GET" }, headers));
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The page, when one is configured, and only for paths the API does not
    // own: a route is a route whether or not a file happens to share its name.
    if (staticDir && ROUTES.indexOf(path) === -1) {
      return serveStatic(req.method, path, res, headers).then(function (served) {
        if (served) return;
        return send(res, 404, {
          ok: false,
          code: "no-such-route",
          error: "no route " + path,
          routes: ROUTES
        }, headers);
      }, function (err) {
        if (log) log({ level: "error", path: path, message: err && err.message });
        return send(res, 500, { ok: false, code: "internal", error: "Internal error." }, headers);
      });
    }

    if (path === "/healthz" || path === "/") {
      return send(res, 200, {
        ok: true,
        service: "windsolver",
        version: API_VERSION,
        uptimeS: Math.round((Date.now() - startedAt) / 1000),
        inFlight: gate.inFlight,
        queued: gate.queued,
        routes: ROUTES
      }, headers);
    }

    const route = path === "/v1/field" ? handleField
      : path === "/v1/line" ? handleLine
        : path === "/v1/windprofile" ? handleWindProfile
          : null;

    if (!route) {
      return send(res, 404, {
        ok: false,
        code: "no-such-route",
        error: "no route " + path,
        routes: ROUTES
      }, headers);
    }

    const startedMs = Date.now();
    route(url.searchParams, res, headers).then(function () {
      if (log) log({ level: "info", path: path, query: url.search, ms: Date.now() - startedMs });
    }, function (err) {
      if (log && err && err.code) {
        log({ level: "warn", path: path, code: err.code, ms: Date.now() - startedMs });
      }
      try {
        respondError(res, err, headers);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  };
}

/** A directory as it really is on disk, so symlinked roots still compare. */
function realDir(dir) {
  const resolved = nodePath.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** An `http.Server` around the handler, so it is deployed like any node service. */
function createServer(opts) {
  const server = http.createServer(createHandler(opts));
  // A request that arrives while a solve is queued should not be closed by the
  // default 5 s header timeout, and a client that walks away should not hold a
  // worker: both are longer than the deadline, not unlimited.
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  server.requestTimeout = timeoutMs + 15000;
  server.headersTimeout = timeoutMs + 20000;
  return server;
}

module.exports = {
  API_VERSION,
  ROUTES,
  DEFAULT_PORT,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CELLS,
  NOTICE,
  STATUS_BY_CODE,
  createGate,
  createHandler,
  createServer
};
