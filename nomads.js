/**
 * The network side of ingestion: the only module here that makes a request.
 *
 * `hrrr.js` decides what to ask for and `grib2.js` reads what comes back; both
 * are testable with no network because neither of them touches one. This module
 * is the seam between them, and it exists mostly to refuse.
 *
 * The reason it is worth its own file is that NOMADS does not fail the way an
 * API is expected to fail. Measured against filter_hrrr_2d.pl on 2026-08-27,
 * with a two-mile box over Boulder:
 *
 *   request defect            status  content-type              bytes  what arrives
 *   ------------------------  ------  ------------------------  -----  ----------------------------
 *   (none)                       200  application/octet-stream   1529  8 messages on a 2x2 grid
 *   var_NOTAVAR=on               500  text/html                   292  "invalid parameter: var_..."
 *   wrfsfcf99 (no such hour)     404  text/html                   412  "Data file is not present"
 *   cycle older than the archive 403  text/html                   681  "Request for Old Data"
 *   no file= parameter           200  text/html                111291  the filter's own HTML form
 *   no var_ selected             200  octet-stream              10295  every variable at those levels
 *   no lev_ selected             200  octet-stream               6074  every level for those variables
 *   no subregion key             200  octet-stream           13463212  the whole CONUS grid
 *   subregion off the grid       200  octet-stream           20243631  the whole CONUS grid, 1799x1059
 *
 * Only three of those are ordinary HTTP errors. The last four are HTTP 200, and
 * the last two are *valid GRIB* — they decode perfectly, they are simply not
 * what was asked for, and a 20 MB answer to a 1.5 KB question is the kind of
 * thing that is noticed as a bandwidth bill rather than as a bug. So this module
 * checks three things beyond the status code: that the body is not HTML, that it
 * does not exceed a byte ceiling (enforced while reading, so an unexpected
 * full-domain file is dropped rather than buffered), and that the grid that
 * comes back covers the box that was requested rather than the continent.
 *
 * Retries are deliberately narrow. A 500 here means "you sent a bad parameter",
 * so retrying it just sends the same bad parameter again; only transport
 * failures and 502/503/504 are retried.
 */

"use strict";

const hrrr = require("./hrrr.js");
const grib2 = require("./grib2.js");

/** NOMADS asks users to pause between requests; one per second is the usual courtesy. */
const DEFAULT_MIN_INTERVAL_MS = 1000;

/**
 * A subset for a small box is kilobytes. The failure this guards against is not
 * a large legitimate answer but the full CONUS field arriving under HTTP 200 —
 * 13 MB for these variables and levels, and hundreds of MB for the unfiltered
 * file. Generous enough for a whole forecast series over a county, small enough
 * that the continent does not fit through it.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;

/** Transport-level hiccups. Everything else NOMADS returns is a verdict on the request. */
const RETRYABLE_STATUS = [502, 503, 504, 429];

/**
 * How far outside the requested box the returned grid may reach before it is
 * treated as "the filter ignored the subregion". The filter returns whole grid
 * cells, so a small overhang is normal: HRRR's 3 km spacing is under 0.03° of
 * latitude, and two cells of slack on each side is still four hundred times
 * smaller than the CONUS domain it is meant to catch.
 */
const DEFAULT_BOX_MARGIN_DEG = 0.2;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

function isHtml(buffer) {
  const head = buffer.toString("latin1", 0, Math.min(buffer.length, 200)).trim();
  return /^<(!doctype|html|\?xml)/i.test(head);
}

/**
 * The one useful sentence in a NOMADS error page.
 *
 * Every one of them is titled either "Error" or the complaint itself, with the
 * detail in the first centred paragraph: `<title>Error</title>` plus
 * "invalid parameter: var_NOTAVAR". Reporting the status code alone throws that
 * away and leaves the caller guessing which parameter was wrong.
 */
function summarizeHtml(buffer) {
  const text = buffer.toString("latin1", 0, Math.min(buffer.length, 4096));
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  const para = /<p[^>]*>([\s\S]*?)(?:<\/p>|<p[^>]*>|$)/i.exec(text);
  const clean = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const parts = [];
  if (title && clean(title[1])) parts.push(clean(title[1]));
  if (para && clean(para[1]) && (!title || clean(para[1]) !== clean(title[1]))) parts.push(clean(para[1]));
  const summary = parts.join(" — ").slice(0, 300);
  return summary || clean(text).slice(0, 300);
}

/**
 * Read a response body, giving up once it exceeds `maxBytes`.
 *
 * Reads the stream rather than awaiting arrayBuffer() so that the 20 MB answer
 * to a two-mile question is abandoned in flight. Falls back to buffering whole
 * when the response has no readable body stream, which is what a hand-written
 * test double usually is.
 */
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > maxBytes) {
      throw fail("too-large", "response is " + whole.length + " bytes, over the " + maxBytes +
        " byte ceiling; a subset request that returns this much has usually been widened to the " +
        "whole domain — check the subregion parameters");
    }
    return whole;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw fail("too-large", "response exceeded the " + maxBytes + " byte ceiling and was abandoned " +
        "after " + total + " bytes; a subset request that returns this much has usually been widened " +
        "to the whole domain — check the subregion parameters");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * A gate that lets one request through per interval.
 *
 * Serialised on a promise chain rather than a timestamp check, so ten calls
 * started at once are spaced out instead of all seeing an idle clock and going
 * together.
 */
function createThrottle(intervalMs, sleep) {
  let tail = Promise.resolve();
  let last = -Infinity;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  return function throttle(now) {
    const clock = now || Date.now;
    const mine = tail.then(async () => {
      const due = last + intervalMs;
      const t = clock();
      if (t < due) await wait(due - t);
      last = clock();
    });
    tail = mine.catch(() => {});
    return mine;
  };
}

const defaultThrottle = createThrottle(DEFAULT_MIN_INTERVAL_MS);

function resolveOptions(opts) {
  const o = opts || {};
  return {
    fetchImpl: o.fetch === undefined ? globalThis.fetch : o.fetch,
    maxBytes: o.maxBytes === undefined ? DEFAULT_MAX_BYTES : o.maxBytes,
    timeoutMs: o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs,
    retries: o.retries === undefined ? DEFAULT_RETRIES : o.retries,
    throttle: o.throttle === undefined ? defaultThrottle : o.throttle,
    sleep: o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    signal: o.signal
  };
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.indexOf(status) >= 0;
}

/**
 * Fetch one GRIB subset and hand back the bytes, or throw saying why not.
 *
 * Codes: `http-error` (a status NOMADS uses to reject the request),
 * `html-response` (HTTP 200 and an HTML page — the filter's form, which is what
 * a missing `file=` produces), `too-large`, `empty-response`, `not-grib`,
 * `network` (transport failure after the retries were spent).
 */
async function fetchGrib(url, opts) {
  const o = resolveOptions(opts);
  if (typeof o.fetchImpl !== "function") {
    throw fail("no-fetch", "no fetch implementation: pass opts.fetch on a runtime without a global one");
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (o.throttle) await o.throttle();

    let res;
    let buffer;
    // The timeout covers reading the body as well as getting the headers: a
    // stalled transfer holds a connection open just as effectively as a stalled
    // handshake, and NOMADS under load does the former.
    const controller = new AbortController();
    const timer = o.timeoutMs > 0 ? setTimeout(() => controller.abort(), o.timeoutMs) : null;
    if (timer && typeof timer.unref === "function") timer.unref();
    const onAbort = () => controller.abort();
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });
    try {
      res = await o.fetchImpl(url, { redirect: "follow", signal: controller.signal });
      buffer = await readCapped(res, o.maxBytes);
    } catch (err) {
      // A ceiling breach is a verdict on the request, not a flaky connection.
      if (err.code === "too-large") throw err;
      if (o.signal && o.signal.aborted) {
        throw fail("aborted", "the request was cancelled by the caller", { url: url, cause: err });
      }
      if (attempt > o.retries) {
        const timedOut = controller.signal.aborted;
        throw fail(timedOut ? "timeout" : "network",
          timedOut
            ? "NOMADS did not answer within " + o.timeoutMs + " ms, after " + attempt + " attempt(s)"
            : "no response from NOMADS after " + attempt + " attempt(s): " + err.message,
          { url: url, cause: err });
      }
      await o.sleep(500 * attempt);
      continue;
    } finally {
      if (timer) clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
    }

    const contentType = (res.headers && res.headers.get && res.headers.get("content-type")) || "";

    if (res.status !== 200) {
      const html = isHtml(buffer);
      if (isRetryableStatus(res.status) && attempt <= o.retries) {
        await o.sleep(500 * attempt);
        continue;
      }
      throw fail("http-error",
        "NOMADS answered " + res.status + (html ? ": " + summarizeHtml(buffer) : ""),
        { url: url, status: res.status, contentType: contentType, body: buffer });
    }

    if (buffer.length === 0) {
      throw fail("empty-response", "NOMADS answered 200 with an empty body", { url: url });
    }

    if (isHtml(buffer)) {
      throw fail("html-response",
        "NOMADS answered 200 with an HTML page rather than GRIB — this is how the filter reports a " +
        "malformed request: " + summarizeHtml(buffer),
        { url: url, status: 200, contentType: contentType, body: buffer });
    }

    if (buffer.toString("ascii", 0, 4) !== "GRIB") {
      throw fail("not-grib", "response is neither HTML nor GRIB; first bytes: " +
        JSON.stringify(buffer.toString("latin1", 0, Math.min(buffer.length, 40))),
        { url: url, contentType: contentType });
    }

    return {
      url: url,
      status: res.status,
      contentType: contentType,
      bytes: buffer.length,
      attempts: attempt,
      buffer: buffer
    };
  }
}

function gridBounds(record) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (let i = 0; i < record.latitudes.length; i++) {
    const lat = record.latitudes[i];
    const lon = record.longitudes[i];
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  return { west: west, east: east, south: south, north: north };
}

/**
 * Refuse a field that is not the field that was asked for.
 *
 * The expensive NOMADS failure is not an error page: it is a subregion the
 * filter did not apply, which comes back as the entire CONUS grid under HTTP 200
 * and decodes cleanly. A box check is the only thing that separates it from a
 * legitimate answer, because everything else about it is well-formed.
 */
function assertCoversBox(records, box, marginDeg) {
  const margin = marginDeg === undefined ? DEFAULT_BOX_MARGIN_DEG : marginDeg;
  const bounds = gridBounds(records[0]);
  const over =
    Math.max(0, box.west - bounds.west) + Math.max(0, bounds.east - box.east) +
    Math.max(0, box.south - bounds.south) + Math.max(0, bounds.north - box.north);
  if (over > margin) {
    throw fail("subregion-ignored",
      "the grid returned spans " + bounds.west.toFixed(2) + ".." + bounds.east.toFixed(2) + " by " +
      bounds.south.toFixed(2) + ".." + bounds.north.toFixed(2) + " for a box of " +
      box.west.toFixed(2) + ".." + box.east.toFixed(2) + " by " +
      box.south.toFixed(2) + ".." + box.north.toFixed(2) + " — NOMADS serves the whole domain, with " +
      "HTTP 200 and valid GRIB, when the subregion does not intersect the grid",
      { bounds: bounds, box: box, points: records[0].latitudes.length });
  }
}

/**
 * Fetch and decode one HRRR cycle and forecast hour over a box.
 *
 * Returns `{ url, cycle, forecastHour, bytes, records }`. The records are
 * grib2's, unrotated: `toEarthRelativeWind` is the caller's job, because
 * whether the wind wants to be earth-relative depends on what it is for.
 */
async function fetchHrrrBox(opts) {
  const o = opts || {};
  if (!o.box) throw fail("bad-request", "box is required");
  if (!o.cycle) throw fail("bad-request", "cycle is required");
  const forecastHour = o.forecastHour || 0;
  const url = hrrr.filterUrl({
    cycle: o.cycle,
    forecastHour: forecastHour,
    box: o.box,
    variables: o.variables,
    levels: o.levels
  });

  const got = await fetchGrib(url, o);
  const records = grib2.decode(got.buffer);
  assertCoversBox(records, o.box, o.boxMarginDeg);

  return {
    url: url,
    cycle: o.cycle,
    forecastHour: forecastHour,
    bytes: got.bytes,
    attempts: got.attempts,
    records: records
  };
}

/**
 * Walk back from the newest cycle that should exist until one does.
 *
 * The 75-minute availability lag in `hrrr.js` is an assumption, not a
 * measurement, so treating it as a fact produces a 404 at exactly the times a
 * live service is most wanted. Trying the cycles behind it turns that guess into
 * an observation, and `lagMinutes` in the result is the real figure for the
 * cycle that answered — the first honest number this codebase has had for it.
 *
 * Only "the file is not there yet" is walked past. A 403, a 500 or a bad box is
 * a defect in the request and will be just as wrong an hour earlier.
 */
async function fetchLatestHrrrBox(opts) {
  const o = opts || {};
  const at = o.at || new Date();
  const maxCyclesBack = o.maxCyclesBack === undefined ? 3 : o.maxCyclesBack;
  const attempted = [];

  for (let back = 0; back <= maxCyclesBack; back++) {
    const cycleAt = new Date(at.getTime() - back * 3600 * 1000);
    const cycle = hrrr.latestAvailableCycle(cycleAt, o.lagMinutes);
    try {
      const got = await fetchHrrrBox(Object.assign({}, o, { cycle: cycle }));
      const cycleTime = Date.UTC(cycle.year, cycle.month - 1, cycle.day, cycle.hour);
      got.attemptedCycles = attempted;
      got.lagMinutes = Math.round((at.getTime() - cycleTime) / 60000);
      return got;
    } catch (err) {
      const missing = err.code === "http-error" && err.status === 404;
      attempted.push({ cycle: cycle, code: err.code, status: err.status });
      if (!missing || back === maxCyclesBack) {
        err.attemptedCycles = attempted;
        throw err;
      }
    }
  }
  /* c8 ignore next */
  throw fail("no-cycle", "no HRRR cycle was available", { attemptedCycles: attempted });
}

module.exports = {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_BOX_MARGIN_DEG,
  RETRYABLE_STATUS,
  isHtml,
  summarizeHtml,
  createThrottle,
  gridBounds,
  assertCoversBox,
  fetchGrib,
  fetchHrrrBox,
  fetchLatestHrrrBox
};
