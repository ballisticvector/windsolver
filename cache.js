/**
 * What a volume is filed under, and how long it is worth keeping.
 *
 * **The key is `(source, bbox, level set, valid time)` and nothing else.** Not
 * an azimuth, not a range list, not a consumer's identity. A shooter facing
 * north and a sailor two miles away asking about the same hour want the same
 * bytes, and they only get them if what was stored is the general field. Once a
 * fetch layer has picked its key, changing it is a rewrite rather than an edit,
 * which is why this module is small and early.
 *
 * Three decisions worth knowing before changing anything here:
 *
 * **Boxes are snapped outward onto a grid.** Two requests for the same hillside
 * differ in the sixth decimal place and would otherwise never share an entry.
 * Snapping *outward* is the safe direction: the cached box always contains the
 * box that was asked for, so a hit can never serve a field that fails to cover
 * the request. Snapping to the nearest edge would sometimes serve a field with
 * a sliver of the domain missing, which is invisible until it is a wrong answer
 * at the edge of a domain.
 *
 * **Freshness is measured from the data's valid time, not from when it was
 * fetched.** An analysis valid at 20:00Z is superseded at 21:00Z whether it was
 * fetched a minute or an hour ago. A time-to-live counted from insertion keeps
 * a stale field alive precisely when the service is busy enough to have been
 * fetching late.
 *
 * **Concurrent misses on the same key make one request.** NOMADS asks for a
 * pause between requests and the throttle in `nomads.js` serialises them, so
 * ten simultaneous callers without this would queue ten identical fetches and
 * the tenth would wait ten seconds for bytes the first already had.
 */

"use strict";

const volumeModule = require("./volume.js");

/**
 * Snap resolution for cache keys, in degrees. 0.01 degrees is roughly 1.1 km
 * north-south — a third of an HRRR cell, so snapping outward costs at most one
 * extra row or column of a grid that is already kilobytes.
 */
const DEFAULT_SNAP_DEG = 0.01;

/** Entries kept. Deliberately small: a volume is kilobytes, but so is a leak. */
const DEFAULT_MAX_ENTRIES = 256;

/**
 * How long past its valid time a field is still served.
 *
 * An hour, because HRRR is hourly and that is when a newer field exists, plus
 * the 75-minute availability lag, because during that window the newer field
 * cannot be fetched yet and the older one is genuinely the best there is.
 * Expiring at the hour would evict a usable field and replace it with a 404.
 */
const DEFAULT_STALE_AFTER_MS = (60 + 75) * 60 * 1000;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

function snapDown(value, step) {
  return Math.floor(value / step + 1e-9) * step;
}

function snapUp(value, step) {
  return Math.ceil(value / step - 1e-9) * step;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The smallest box on the snap grid that contains `box`.
 *
 * Outward only — see the note at the top. A degenerate box (west >= east) is
 * refused rather than snapped into a valid-looking one.
 */
function snapBox(box, stepDeg) {
  const step = stepDeg === undefined ? DEFAULT_SNAP_DEG : stepDeg;
  if (!box || !isFinite(box.west) || !isFinite(box.east) || !isFinite(box.south) || !isFinite(box.north)) {
    throw fail("bad-box", "a box {west, south, east, north} of finite degrees is required");
  }
  if (box.west >= box.east || box.south >= box.north) {
    throw fail("bad-box", "box is empty or transposed");
  }
  return {
    west: round6(snapDown(box.west, step)),
    south: round6(snapDown(box.south, step)),
    east: round6(snapUp(box.east, step)),
    north: round6(snapUp(box.north, step))
  };
}

function validTimeMs(validTime) {
  const t = validTime instanceof Date ? validTime.getTime() : Date.parse(validTime);
  if (!isFinite(t)) throw fail("bad-time", "validTime must be a Date or an ISO string");
  return t;
}

/**
 * The cache key. A string rather than a tuple so it can be a Map key, a Redis
 * key or a filename without being re-derived differently in three places.
 */
function cacheKey(spec) {
  const s = spec || {};
  const box = snapBox(s.box, s.snapDeg);
  const levels = volumeModule.sortLevels((s.levels || []).map(volumeModule.levelKey));
  if (levels.length === 0) throw fail("bad-levels", "a level set is required; a volume with no levels is not a volume");
  return [
    s.source || "HRRR",
    [box.west, box.south, box.east, box.north].join(","),
    levels.join("+"),
    new Date(validTimeMs(s.validTime)).toISOString()
  ].join("|");
}

/**
 * Rough heap cost of a volume, for sizing.
 *
 * Reported rather than estimated in a spreadsheet: the droplet question is how
 * many domains fit in memory, and the honest answer needs a measured number
 * from real fetches. Counts the float arrays only — 8 bytes per value per
 * field, which dominates a volume by three orders of magnitude.
 */
function approximateBytes(volume) {
  // Two components per wind level, one array per scalar level.
  let fields = 2 * Object.keys(volume.wind || {}).length;
  for (const byLevel of Object.values(volume.scalars || {})) {
    fields += Object.keys(byLevel).length;
  }
  // Two coordinate arrays are carried alongside the fields.
  return (fields + 2) * (volume.pointCount || 0) * 8;
}

/**
 * An in-process LRU with valid-time freshness.
 *
 * `now` is injected. A cache that reads the clock itself cannot be tested for
 * the behaviour that matters — what it does at the moment an entry goes stale.
 */
function createCache(opts) {
  const o = opts || {};
  const maxEntries = o.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : o.maxEntries;
  const staleAfterMs = o.staleAfterMs === undefined ? DEFAULT_STALE_AFTER_MS : o.staleAfterMs;
  const now = o.now || Date.now;

  // Map iterates in insertion order, so the first key is the least recently
  // used as long as a hit deletes and re-inserts.
  const entries = new Map();
  const stats = { hits: 0, misses: 0, stale: 0, evictions: 0, stored: 0 };

  function expiryOf(volume) {
    return validTimeMs(volume.validTime) + staleAfterMs;
  }

  function get(key) {
    const entry = entries.get(key);
    if (!entry) {
      stats.misses++;
      return null;
    }
    if (now() >= entry.expiresAt) {
      entries.delete(key);
      stats.stale++;
      stats.misses++;
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    stats.hits++;
    return entry.volume;
  }

  function set(key, volume) {
    const expiresAt = expiryOf(volume);
    // A field that is already stale is not stored. Storing it would let a
    // caller that never re-reads keep serving it, and it evicts something live.
    if (now() >= expiresAt) {
      stats.stale++;
      return false;
    }
    if (entries.has(key)) entries.delete(key);
    entries.set(key, { volume: volume, expiresAt: expiresAt, bytes: approximateBytes(volume) });
    stats.stored++;
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      stats.evictions++;
    }
    return true;
  }

  function prune() {
    const t = now();
    let removed = 0;
    for (const [key, entry] of entries) {
      if (t >= entry.expiresAt) {
        entries.delete(key);
        removed++;
      }
    }
    stats.stale += removed;
    return removed;
  }

  function summary() {
    let bytes = 0;
    let points = 0;
    for (const entry of entries.values()) {
      bytes += entry.bytes;
      points += entry.volume.pointCount || 0;
    }
    return Object.assign({
      entries: entries.size,
      maxEntries: maxEntries,
      points: points,
      approximateBytes: bytes
    }, stats);
  }

  return {
    get: get,
    set: set,
    prune: prune,
    has: function (key) { return entries.has(key); },
    delete: function (key) { return entries.delete(key); },
    clear: function () { entries.clear(); },
    keys: function () { return Array.from(entries.keys()); },
    summary: summary
  };
}

/**
 * A cache in front of something that produces volumes.
 *
 * `load(spec)` is injected rather than imported so this stays offline-testable
 * and so a caller can put an archive, a file or a different model behind the
 * same key. `nomads.js` plus `volume.buildVolume` is the live one.
 *
 * The single-flight map is keyed identically to the cache, so the deduplication
 * and the storage can never disagree about what "the same request" means.
 */
function createVolumeSource(opts) {
  const o = opts || {};
  if (typeof o.load !== "function") throw fail("no-loader", "load(spec) is required");
  const cache = o.cache || createCache(o);
  const inFlight = new Map();
  const stats = { coalesced: 0, loads: 0 };

  async function get(spec) {
    const key = cacheKey(spec);
    const hit = cache.get(key);
    if (hit) return hit;

    const pending = inFlight.get(key);
    if (pending) {
      stats.coalesced++;
      return pending;
    }

    const promise = (async function () {
      stats.loads++;
      const volume = await o.load(spec);
      // The loader answers with whatever valid time the model had; the key
      // carries the one that was asked for. Storing under the key that was
      // asked for is what makes the next identical request a hit, and the
      // volume itself still reports the time it really has.
      cache.set(key, volume);
      return volume;
    })();

    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    get: get,
    key: cacheKey,
    cache: cache,
    summary: function () { return Object.assign({ inFlight: inFlight.size }, stats, cache.summary()); }
  };
}

/**
 * The live wiring: NOMADS in, volume out, cached.
 *
 * Kept thin on purpose. Everything interesting is in the modules it composes —
 * `nomads.js` refuses what the filter answers with, `volume.js` refuses what
 * does not belong in one instant, and this decides only what the request was
 * and where the answer is filed.
 *
 * **Every fetch is for one named valid time**, which is what keeps the key and
 * the data honest: `get` is handed the hour it wants, asks for the analysis
 * that is valid then, and refuses a field that came back valid at a different
 * instant. Nothing is ever filed under a time it does not have.
 *
 * `getLatest` is then a loop over `get` rather than a separate path: it starts
 * at the newest cycle the availability lag says should exist and walks back an
 * hour at a time over "not there yet". Each attempt is a normal keyed request,
 * so the hour that answers is cached under its own valid time and the next
 * caller hits it.
 *
 * The box handed to NOMADS is the *snapped* box, not the caller's, so the field
 * that lands in the cache covers the whole of the key it is stored under.
 * Fetching the caller's box and filing it under a larger one would leave a
 * field in the cache that does not reach the edges of its own key.
 */
function createHrrrVolumeSource(opts) {
  const o = opts || {};
  const nomads = o.nomads || require("./nomads.js");
  const hrrr = o.hrrr || require("./hrrr.js");

  const source = createVolumeSource(Object.assign({}, o, {
    load: async function (spec) {
      const box = snapBox(spec.box, o.snapDeg);
      const validTime = new Date(validTimeMs(spec.validTime));
      const got = await nomads.fetchHrrrBox(Object.assign({}, o, {
        box: box,
        cycle: hrrr.analysisCycleFor(validTime),
        forecastHour: 0,
        levels: (spec.levels || hrrr.DEFAULT_LEVEL_KEYS).map(hrrr.filterLevel),
        variables: spec.variables || o.variables
      }));

      const built = volumeModule.buildVolume(got.records, { source: "HRRR" });
      if (built.validTime.getTime() !== validTime.getTime()) {
        throw fail(
          "time-mismatch",
          "asked NOMADS for the analysis valid at " + validTime.toISOString() + " and it answered with " +
          built.validTime.toISOString() + "; filing that under the requested hour would put the wrong " +
          "wind in the cache under a key that looks right",
          { requested: validTime, returned: built.validTime, url: got.url }
        );
      }
      built.bytes = got.bytes;
      return built;
    }
  }));

  /**
   * The newest hour that has actually landed, at or before `at`.
   *
   * `maxCyclesBack` bounds the walk: the availability lag is an assumption, but
   * an unbounded walk turns a genuinely broken service into a slow one.
   */
  async function getLatest(spec) {
    const s = spec || {};
    const at = s.at || new Date();
    const maxCyclesBack = s.maxCyclesBack === undefined ? 3 : s.maxCyclesBack;
    const cycle = hrrr.latestAvailableCycle(at, o.lagMinutes);
    const newest = hrrr.cycleValidTime(cycle, 0).getTime();
    const attempted = [];

    for (let back = 0; back <= maxCyclesBack; back++) {
      const validTime = new Date(newest - back * 3600 * 1000);
      try {
        const volume = await source.get(Object.assign({}, s, { validTime: validTime }));
        volume.lagMinutes = Math.round((at.getTime() - validTime.getTime()) / 60000);
        return volume;
      } catch (err) {
        // Only "the file is not on the server yet" is walked past. A 403, a 500
        // or a bad box is a defect in the request, and it is just as wrong an
        // hour earlier.
        attempted.push({ validTime: validTime, code: err.code, status: err.status });
        if (!(err.code === "http-error" && err.status === 404) || back === maxCyclesBack) {
          err.attemptedTimes = attempted;
          throw err;
        }
      }
    }
    /* c8 ignore next */
    throw fail("no-cycle", "no HRRR cycle was available", { attemptedTimes: attempted });
  }

  return Object.assign({}, source, { getLatest: getLatest });
}

module.exports = {
  DEFAULT_SNAP_DEG,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_STALE_AFTER_MS,
  snapBox,
  cacheKey,
  approximateBytes,
  createCache,
  createVolumeSource,
  createHrrrVolumeSource
};
