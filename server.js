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
 * `/v1/windprofile` cut a line out of the same field, `/v1/hillshade`
 * draws the ground it was solved over, and `/v1/stations` says what the
 * anemometers in the same box actually measured. There is no bearing in the
 * general route and no rifle in any of them — the same rule the cache key
 * follows.
 *
 * **One route answers `modelled: false`, and it is the only one.**
 * `/v1/stations` returns measurements rather than a solve, so it does not
 * carry the field's provenance block and must never be merged into one: the
 * whole value of putting the two on a map together is that the reader can see
 * which is which.
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

const auth = require("./auth.js");
const geo = require("./geo.js");
const downscale = require("./downscale.js");
const hillshade = require("./hillshade.js");
const png = require("./png.js");
const slice = require("./slice.js");
const profile = require("./profile.js");
const stationsLib = require("./stations.js");
const terrainLib = require("./terrain.js");
const volumeLib = require("./volume.js");

const API_VERSION = 1;

const ROUTES = ["/healthz", "/v1/field", "/v1/hillshade", "/v1/line", "/v1/stations",
  "/v1/windprofile"];

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

// 512 px over a two-mile box is about 6 m a pixel, which is finer than the 30 m
// terrain a large domain falls back to and coarse enough to send over a phone.
// The ceiling is on the pixels rather than the side, for the same reason the
// field's ceiling is on cells: a wide, short strip is cheap.
const DEFAULT_HILLSHADE_WIDTH = 512;
const DEFAULT_MAX_HILLSHADE_PIXELS = 2000000;

const DEFAULT_RADIUS_MILES = 1;
const MAX_RADIUS_MILES = 30;

// Stations are sparse where the model is interesting: 2,088 RAWS over the
// whole country is about one per 1,500 square miles, and a one-mile box —
// the default everywhere else here — contains none almost everywhere. A
// station search is also cheap, since it is a filter over a cached list rather
// than a solve, so its own radius is larger and allowed to go much further.
const DEFAULT_STATION_RADIUS_MILES = 25;
const MAX_STATION_RADIUS_MILES = 250;

// The model beside the measurement costs an HRRR subset over the whole box,
// where the markers alone cost a filter over a cached list. 150 miles is about
// 100 x 100 HRRR cells, which the NOMADS filter serves in one small request; a
// 250-mile search still answers, without the comparison and saying so, rather
// than pulling most of a continent because someone zoomed out.
const MAX_MODEL_RADIUS_MILES = 150;

const MAX_LENGTH_M = 100000;
const MAX_STATIONS = 2000;
const MAX_HEIGHTS = 40;

// HRRR's grid spacing, reported so a consumer can display what the field was
// downscaled from rather than inferring it.
const MODEL_RESOLUTION_M = 3000;

// The station comparison is drawn from the 10 m wind alone: the 80 m level and
// the surface scalars are what a downscale needs, and this does not downscale.
const STATION_MODEL_LEVEL = "heightAboveGround:10";

// The opposite sentence, and the only route that gets to say it.
const MEASURED_NOTICE =
  "Measured, not modelled: these are station observations, reported as the " +
  "network published them. Nothing here has been corrected, interpolated or " +
  "compared with the modelled field.";

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
  // The picture: an illumination, a raster size, or a PNG that cannot be made.
  "bad-azimuth": 400,
  "bad-altitude": 400,
  "bad-width": 400,
  "bad-filter": 400,
  "bad-size": 400,
  "bad-transparent": 400,
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
  "aborted": 504,

  // The station network, which is a different upstream from the model and the
  // ground and fails on its own schedule.
  "no-stations": 502,
  "stations-unavailable": 502,
  "observations-unavailable": 502,
  "unknown-station": 404,
  "no-observations": 502,
  "bad-csv": 502,
  "bad-station": 502,
  "bad-response": 502,
  "fems-refused": 502
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

/**
 * A flag, refused rather than coerced.
 *
 * `observed=0` and `observed=false` both mean no; anything else that is not
 * empty is a caller who thinks they have turned something off and has not.
 */
function boolParam(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const text = String(raw).toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  throw badParameter(name, name + " must be true or false, not " + JSON.stringify(raw));
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
 * What HRRR says at each station, for the map that draws both.
 *
 * One volume over the whole box and a bilinear sample per station, rather than
 * a solve per station: a solve would read 3DEP under sixty coordinates to
 * produce a number that `docs/downscaling.md` measures as indistinguishable
 * from this one once the bias is removed. The raw model is also the honest
 * thing to put beside a measurement while the downscaling is still under
 * investigation — the disagreement on display is HRRR's, and attributing it to
 * a correction that has not been shown to help would be a claim.
 */
function createStationModel(atmosphere) {
  return {
    windAt: async function (box, points) {
      // A station on the edge of the box is inside it and can still fall
      // outside the volume: the grid is Lambert and the box is not.
      const air = geo.expand(box, MODEL_RESOLUTION_M / geo.METERS_PER_MILE);
      const volume = await atmosphere.getLatest({
        box: air,
        levels: [STATION_MODEL_LEVEL],
        variables: ["UGRD", "VGRD"]
      });

      const notes = [];
      const winds = points.map(function (p, i) {
        try {
          return volumeLib.sampleWind(volume, p.lat, p.lon, STATION_MODEL_LEVEL);
        } catch (err) {
          // One station off the edge of the grid is not an outage. It loses its
          // comparison and keeps everything else.
          notes[i] = (err && err.message) || "the model has no wind at this coordinate";
          return null;
        }
      });

      return {
        source: volume.source || "HRRR",
        validTime: volume.validTime instanceof Date
          ? volume.validTime.toISOString()
          : volume.validTime,
        heightAglM: 10,
        winds: winds,
        notes: notes
      };
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
  // Separate from the field service because it is a different upstream with a
  // different failure mode: FEMS being down must not stop a wind solve, and a
  // NOMADS outage must not empty the map of stations.
  // The stations' model half shares the field service's atmosphere cache, so a
  // map that has already solved a pin does not pull a second HRRR subset to
  // colour the markers over the same ground.
  const stationModel = o.stationModel === undefined
    ? createStationModel(fieldService.atmosphere)
    : o.stationModel;
  const stationService = o.stations ||
    stationsLib.createStationService(Object.assign({}, o, { model: stationModel }));
  const timeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs;
  const maxCells = o.maxCells === undefined ? DEFAULT_MAX_CELLS : o.maxCells;
  const maxHillshadePixels = o.maxHillshadePixels === undefined
    ? DEFAULT_MAX_HILLSHADE_PIXELS
    : o.maxHillshadePixels;
  const retryAfterS = o.retryAfterSeconds === undefined ? DEFAULT_RETRY_AFTER_S : o.retryAfterSeconds;
  const origins = o.origins || [];
  const log = typeof o.log === "function" ? o.log : null;
  // Off unless keys are configured, so a checkout and the suite are open and
  // there is no default credential to forget to change.
  const gatekeeper = o.auth || auth.createAuth({
    keys: o.apiKeys || [],
    allowPage: o.allowPageWithoutKey
  });
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

  /**
   * Bytes rather than JSON, for the one route whose answer is an image.
   *
   * The metadata rides in headers because the body cannot hold it: a caller
   * needs the bounds to place the picture, and a picture placed on the box the
   * caller asked for rather than the box the service snapped to is off by the
   * padding. `access-control-expose-headers` is not optional — without it a
   * cross-origin reader gets the image and none of the headers that say where
   * it goes, which is a silent misplacement rather than an error.
   */
  function sendBytes(res, status, buffer, headers) {
    const head = Object.assign({ "content-length": buffer.length }, headers || {});
    const exposed = Object.keys(head).filter(function (k) { return k.startsWith("x-windsolver-"); });
    if (head["access-control-allow-origin"] && exposed.length) {
      head["access-control-expose-headers"] = exposed.join(", ");
    }
    res.writeHead(status, head);
    res.end(buffer);
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
    for (const key of ["parameter", "distanceM", "lat", "lon", "maxCells", "maxPixels", "pixels",
      "timeoutMs", "voidFraction"]) {
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

  /**
   * Shaded relief over the same ground `/v1/field` answers for, as a PNG.
   *
   * A separate route rather than a bigger field response, for three reasons
   * that all point the same way. A raster belongs in an image, not in a JSON
   * array of a million numbers. A hillshade needs no atmosphere, so this pays
   * for no NOMADS fetch and answers while the wind is still solving. And the
   * ground does not change, so this answer is cacheable for a day where the
   * wind's is cacheable for an hour — putting them in one response would give
   * the pair the shorter of the two lifetimes.
   *
   * The picture is greyscale on purpose. Colour belongs to the wind drawn over
   * it; a hillshade that competes for the same hues makes the field harder to
   * read, which is the opposite of why it is here.
   */
  async function handleHillshade(params, res, headers) {
    const from = originParam(params);
    const radiusMiles = numberParam(params, "radiusMiles",
      { default: DEFAULT_RADIUS_MILES, above: 0, max: MAX_RADIUS_MILES });
    const resolutionM = numberParam(params, "resolutionM", { default: undefined, above: 0, max: 1000 });
    const width = Math.round(numberParam(params, "width",
      { default: DEFAULT_HILLSHADE_WIDTH, min: 2, max: hillshade.MAX_RASTER_SIDE }));
    const azimuthDeg = numberParam(params, "azimuthDeg",
      { default: hillshade.DEFAULT_AZIMUTH_DEG, min: 0, max: 360 });
    const altitudeDeg = numberParam(params, "altitudeDeg",
      { default: hillshade.DEFAULT_ALTITUDE_DEG, above: 0, max: 90 });

    const requested = geo.boundingBox(from.lat, from.lon, radiusMiles);
    const pixels = width * rowsFor(requested, width);
    if (pixels > maxHillshadePixels) {
      throw serviceError("too-many-pixels", 413,
        "a " + width + " px wide picture of this box is about " + pixels + " pixels; this " +
        "service returns at most " + maxHillshadePixels + ". Ask for a narrower picture or a " +
        "smaller radius.",
        { maxPixels: maxHillshadePixels, pixels: pixels });
    }

    const spec = { lat: from.lat, lon: from.lon, radiusMiles: radiusMiles };
    if (resolutionM !== undefined) spec.targetResolutionM = resolutionM;

    const land = await solve(function () { return fieldService.terrain(spec); });
    const box = land.domain.box;
    // The cached derivatives, not a second pass over the terrain: the slope and
    // aspect the wind is bent by are the slope and aspect the picture is lit
    // by, so the two can never disagree about the ground.
    const shade = hillshade.shade(land.derived, { azimuthDeg: azimuthDeg, altitudeDeg: altitudeDeg });
    const raster = hillshade.toGeographic(shade, box, { width: width });
    const image = png.greyscalePng(hillshade.toBytes(raster), raster.width, raster.height);
    // Which tiles cover this box was answered out of the cache because The
    // National Map would not answer it. The picture is still the ground; the
    // choice of product behind it is as old as this header says.
    const kept = terrainLib.agedListing(land.listing);

    return sendBytes(res, 200, image, Object.assign(kept ? {
      "x-windsolver-terrain-listing": "retained," + kept.storedAt + "," + kept.ageS
    } : {}, {
      "content-type": "image/png",
      // A day: the ground under a box does not move, and the URL carries
      // everything that changes the picture.
      "cache-control": "public, max-age=86400",
      "x-windsolver-bounds": [box.south, box.west, box.north, box.east].join(","),
      "x-windsolver-size": raster.width + "," + raster.height,
      "x-windsolver-resolution-m": String(Math.round(raster.resolutionM * 100) / 100),
      "x-windsolver-terrain-resolution-m": String(land.grid.resolutionM),
      "x-windsolver-terrain-dataset": String(land.dataset || "unknown"),
      // What the picture cannot show: ground inside the box with no terrain
      // under it is transparent, and a caller that draws it over a basemap
      // would otherwise read a hole as flat ground.
      "x-windsolver-covered": String(Math.round(raster.coveredFraction * 1000) / 1000),
      "x-windsolver-sun": azimuthDeg + "," + altitudeDeg,
      "x-windsolver-modelled": "shaded relief of 3DEP terrain; no wind in this image"
    }, headers));
  }

  /**
   * The anemometers in a box, and what they last measured.
   *
   * Not a solve, so it does not go through `solve()`: there is no terrain to
   * read and no CPU to contend for, and holding a station lookup behind the
   * gate would make the markers wait on whatever cold field is in front of
   * them — the opposite of the point, which is that the page can draw the
   * measurements while the model is still coming.
   *
   * `observed=false` returns the markers alone, off a cached list, with no
   * network at all in the usual case.
   */
  async function handleStations(params, res, headers) {
    const from = originParam(params);
    const radiusMiles = numberParam(params, "radiusMiles",
      { default: DEFAULT_STATION_RADIUS_MILES, above: 0, max: MAX_STATION_RADIUS_MILES });
    const limit = Math.round(numberParam(params, "limit",
      { default: stationsLib.DEFAULT_LIMIT, min: 1, max: stationsLib.MAX_STATIONS }));
    const observed = boolParam(params, "observed", true);
    const wantModel = boolParam(params, "model", false);
    const tooWideForModel = wantModel && radiusMiles > MAX_MODEL_RADIUS_MILES;

    const box = geo.boundingBox(from.lat, from.lon, radiusMiles);
    const found = await stationService.inBox(box, {
      observed: observed,
      limit: limit,
      model: wantModel && !tooWideForModel
    });

    // Refused rather than served slowly, and refused by name: the markers and
    // their observations are unaffected, so this is a missing comparison and
    // never a failed request.
    const modelBlock = tooWideForModel
      ? {
        source: null, validTime: null, heightAglM: null, downscaled: false,
        notice: null, code: "model-box-too-large",
        error: "the model is only sampled beside the stations within " +
          MAX_MODEL_RADIUS_MILES + " miles, and this search is " + radiusMiles +
          "; the stations and their observations are unaffected"
      }
      : (found.model || null);

    return send(res, 200, {
      ok: true,
      schemaVersion: API_VERSION,
      from: from,
      radiusMiles: radiusMiles,
      box: box,
      // The inverse of every other route's provenance, and deliberately not the
      // same block: a station is the measurement the modelled field is graded
      // against, and a reader has to be able to tell them apart at a glance.
      modelled: false,
      notice: MEASURED_NOTICE,
      units: { speed: "m/s", direction: "degrees the wind blows from", elevation: "m" },
      matched: found.matched,
      returned: found.returned,
      truncated: found.truncated,
      observed: found.observed,
      window: found.window,
      // Present only when it was asked for, and carrying its own notice: the
      // model number is the one thing in this answer that is not a measurement,
      // and `modelled: false` above is about the stations.
      model: modelBlock,
      directory: found.directory,
      errors: found.errors,
      stations: found.stations.map(function (s) {
        return {
          id: s.id,
          name: s.name,
          network: s.network,
          provider: s.provider,
          lat: s.lat,
          lon: s.lon,
          elevationM: s.elevationM,
          sensorHeightM: s.sensorHeightM,
          state: s.state,
          agency: s.agency,
          distanceM: Math.round(s.distanceM),
          observation: s.observation,
          observationNote: s.observationNote === undefined ? null : s.observationNote,
          observationCode: s.observationCode === undefined ? null : s.observationCode,
          model: s.model === undefined ? null : s.model,
          modelNote: s.modelNote === undefined ? null : s.modelNote
        };
      })
    }, headers);
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
      : path === "/v1/hillshade" ? handleHillshade
        : path === "/v1/line" ? handleLine
          : path === "/v1/stations" ? handleStations
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

    // Only `/v1/` — `/healthz` and the page are answered above, because a
    // monitor that needs a credential is a monitor that stops being run.
    const who = gatekeeper.check(req.headers);
    if (!who.ok) {
      if (log) log({ level: "warn", path: path, code: who.code });
      return send(res, who.status, { ok: false, code: who.code, error: who.error },
        Object.assign({ "www-authenticate": "Bearer realm=\"windsolver\"" }, headers));
    }

    const startedMs = Date.now();
    route(url.searchParams, res, headers).then(function () {
      if (log) log({ level: "info", path: path, query: redactQuery(url.search), caller: who.caller, ms: Date.now() - startedMs });
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

/**
 * A query string with anything key-shaped taken out of it.
 *
 * The service does not accept a key in the URL, but a caller who tries is a
 * caller who has just put their secret somewhere this log, nginx's log and
 * every proxy in between will keep. Redact rather than store it.
 */
function redactQuery(search) {
  return String(search || "").replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&]*/gi, "$1[redacted]");
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
  DEFAULT_HILLSHADE_WIDTH,
  DEFAULT_MAX_HILLSHADE_PIXELS,
  DEFAULT_STATION_RADIUS_MILES,
  MAX_STATION_RADIUS_MILES,
  MAX_MODEL_RADIUS_MILES,
  NOTICE,
  MEASURED_NOTICE,
  STATUS_BY_CODE,
  createGate,
  createStationModel,
  createHandler,
  redactQuery,
  createServer
};
