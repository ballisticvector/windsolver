/**
 * Keep a named place's field in the cache, so the first person to ask is not
 * the one who pays for it.
 *
 * A cold field over new ground is a 3DEP product search, a set of COG window
 * reads and an HRRR cycle pull. Measured on the live droplet that is 23-33 s on
 * a good minute and past the service's own 45 s ceiling on a bad one, because
 * The National Map's product search has been observed taking 29 s and answering
 * 504 outright. Warm, the same field is ~0.6 s. Nothing here makes the cold path
 * faster; it moves who waits for it from a visitor to a timer.
 *
 * Two decisions worth keeping.
 *
 * **It warms over HTTP, against the service's own port, rather than calling the
 * field library.** The whole point is to leave the cache holding the entry a
 * real request will look up, and the only way to be sure of that is to send the
 * request a real caller sends. A second code path that builds a box out of a
 * coordinate is a second chance to key it differently, and the failure is
 * invisible: everything works, and nothing is ever a hit.
 *
 * **Places are warmed one at a time, and a failure is logged rather than
 * thrown.** The service runs two solves at once; a prewarm that fires them all
 * at start-up occupies the whole gate and the first visitor queues behind the
 * thing meant to help them. USGS and NOMADS both fail from time to time — that
 * is why the cache is being warmed at all — so a refusal is a log line and the
 * next tick tries again.
 */

"use strict";

// Not a cache TTL: the HRRR cycle. A new cycle lands hourly and gives every
// cached field a new valid time, so a place warmed once is cold again within
// the hour however large the cache is.
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

// A 504 from the service means the solve outlived its own ceiling, not that it
// stopped: the fetch carries on and lands in the cache. Coming back in a minute
// finds the work already done, where waiting out the full interval would let a
// new HRRR cycle undo it first.
const DEFAULT_STILL_RUNNING_MS = 60 * 1000;

/**
 * Read `lat,lon[,radiusMiles]` entries separated by `;`.
 *
 * Refused by name rather than skipped: a typo in a unit file that silently
 * warms nothing looks exactly like a prewarm that is working.
 */
function parsePlaces(spec) {
  const out = [];
  if (spec === undefined || spec === null) return out;

  const entries = String(spec).split(";")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  for (const entry of entries) {
    const parts = entry.split(",").map(function (s) { return s.trim(); });
    if (parts.length < 2 || parts.length > 3) {
      throw new Error("prewarm place '" + entry + "' is not lat,lon[,radiusMiles]");
    }

    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new Error("prewarm place '" + entry + "' has a latitude that is not -90 to 90");
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new Error("prewarm place '" + entry + "' has a longitude that is not -180 to 180");
    }

    const place = { lat: lat, lon: lon };
    if (parts.length === 3) {
      const radiusMiles = Number(parts[2]);
      if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
        throw new Error("prewarm place '" + entry + "' has a radius that is not a positive number");
      }
      place.radiusMiles = radiusMiles;
    }
    out.push(place);
  }

  return out;
}

/** The request a visitor's browser would send for this place. */
function requestPath(place) {
  const q = new URLSearchParams();
  q.set("lat", String(place.lat));
  q.set("lon", String(place.lon));
  if (place.radiusMiles !== undefined) q.set("radiusMiles", String(place.radiusMiles));
  return "/v1/field?" + q.toString();
}

/**
 * Warm each place once, in order.
 *
 * `fetchPath` is injected so this is testable without a socket, and so the
 * caller decides where the service is listening.
 */
async function warmOnce(places, options) {
  const o = options || {};
  const fetchPath = o.fetchPath;
  const log = o.log || function () {};
  const results = [];

  for (const place of places) {
    const started = Date.now();
    try {
      const status = await fetchPath(requestPath(place));
      const ok = status >= 200 && status < 300;
      const stillRunning = status === 504;
      results.push({
        place: place, status: status, ok: ok, stillRunning: stillRunning,
        ms: Date.now() - started
      });
      log({
        level: ok ? "info" : "warn",
        message: ok ? "prewarmed" : (stillRunning ? "prewarm still running" : "prewarm refused"),
        lat: place.lat, lon: place.lon, status: status, ms: Date.now() - started
      });
    } catch (err) {
      results.push({ place: place, ok: false, error: err.message, ms: Date.now() - started });
      log({
        level: "warn",
        message: "prewarm failed",
        lat: place.lat, lon: place.lon, error: err.message, ms: Date.now() - started
      });
    }
  }

  return results;
}

/**
 * Warm now, then keep warming.
 *
 * The default interval is 30 minutes, under the HRRR cycle without being
 * wasteful; the terrain half is keyed on the ground and survives the rollover
 * either way.
 *
 * Returns a `stop()` so a test, or a shutdown, can end it.
 */
function start(places, options) {
  const o = options || {};
  const intervalMs = o.intervalMs === undefined ? DEFAULT_INTERVAL_MS : o.intervalMs;
  const stillRunningMs = o.stillRunningMs === undefined
    ? Math.min(DEFAULT_STILL_RUNNING_MS, intervalMs)
    : o.stillRunningMs;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    const results = await warmOnce(places, o);
    if (stopped) return;
    const soon = results.some(function (r) { return r.stillRunning; });
    timer = setTimeout(tick, soon ? stillRunningMs : intervalMs);
    if (timer.unref) timer.unref();
  }

  const ran = tick();

  return {
    ran: ran,
    stop: function () {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

module.exports = {
  parsePlaces: parsePlaces,
  requestPath: requestPath,
  warmOnce: warmOnce,
  start: start,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  DEFAULT_STILL_RUNNING_MS: DEFAULT_STILL_RUNNING_MS
};
