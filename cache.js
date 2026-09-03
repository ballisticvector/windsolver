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
const derive = require("./derive.js");
const downscale = require("./downscale.js");

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
    // A volume fetched for wind alone would otherwise answer a request that
    // also needs the model's surface height, and the missing parameter reads
    // downstream as "the model has no terrain here" rather than as a miss.
    s.variables ? s.variables.slice().sort().join(",") : "default",
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

/**
 * Snap resolution for terrain keys, in degrees.
 *
 * A tenth of the atmospheric one. Snapping outward is free for a 3 km HRRR
 * cell and expensive for terrain: 0.01° added to each side of a two-mile box is
 * another 2.2 km of ground, which at 1 m is fifty times the pixels actually
 * wanted. 0.001° is about 111 m, so the padding stays a small fraction of a
 * domain while two requests for the same hillside still share an entry.
 */
const DEFAULT_TERRAIN_SNAP_DEG = 0.001;

/** Derived terrain kept, in bytes. Set from measured domains, not guessed. */
const DEFAULT_TERRAIN_MAX_BYTES = 512 * 1024 * 1024;

/**
 * What a set of terrain derivatives is filed under.
 *
 * **No time in it, and that is the point.** Terrain is static, so a derived
 * domain is valid until the ground moves or USGS reflies it, and the dataset
 * tag in the key is what changes when they do. Everything that changes the
 * *numbers* is in the key instead: the resolution they were computed at, and
 * the sheltering parameters, because an Sx computed to 300 m is a different
 * answer from one computed to 1000 m and filing them together would serve the
 * wrong horizon under a key that looks right.
 */
function terrainKey(spec) {
  const s = spec || {};
  const box = snapBox(s.box, s.snapDeg === undefined ? DEFAULT_TERRAIN_SNAP_DEG : s.snapDeg);
  return [
    s.dataset || "3DEP",
    [box.west, box.south, box.east, box.north].join(","),
    s.resolutionM === undefined ? "auto" : String(s.resolutionM),
    shelterKey(s.shelter)
  ].join("|");
}

/**
 * The key for the downscaling weights over a domain: the terrain key, plus the
 * only two things about `downscale.terrainWeights` that change the numbers.
 *
 * Separate from `terrainKey` rather than folded into it because the weights are
 * derived *from* the derivatives and a caller may well hold one and not the
 * other. The curvature length has to be in it: 300 m weights and 500 m weights
 * over the same mountain are different fields, and serving one for the other is
 * the kind of mistake that produces a perfectly plausible wind. The gains are
 * not, because they are applied per wind, not per domain.
 */
function weightsKey(spec) {
  const s = spec || {};
  const length = s.curvatureLengthM === undefined
    ? downscale.DEFAULT_CURVATURE_LENGTH_M
    : s.curvatureLengthM;
  return terrainKey(s) + "|w" + length + "/" + (s.spacingM === undefined ? "row" : s.spacingM);
}

/** What one `terrainWeights` result costs: four fields plus the elevation. */
function weightsBytes(weights) {
  const cells = (weights.width || 0) * (weights.height || 0);
  let fields = 5;
  if (weights.shelter) fields += weights.shelter.sectors.length;
  return fields * cells * 4;
}

/**
 * The sheltering half of a terrain key, with the defaults filled in.
 *
 * `{shelter: true}` and `{shelter: {sectors: 16, maxDistanceM: 300}}` are the
 * same computation, so they have to be the same key: leaving the defaults
 * unwritten would compute a domain twice and hold both copies. Sector centres
 * given explicitly are sorted, because the order they arrive in changes the
 * order of the output fields and nothing else.
 */
function shelterKey(shelter) {
  if (!shelter) return "no-sx";
  const s = shelter === true ? {} : shelter;
  const sectors = Array.isArray(s.sectors)
    ? s.sectors.slice().sort(function (a, b) { return a - b; }).join("/")
    : String(s.sectors === undefined ? derive.DEFAULT_SECTORS : s.sectors);
  const max = s.maxDistanceM === undefined ? derive.DEFAULT_MAX_SHELTER_DISTANCE_M : s.maxDistanceM;
  return "sx" + sectors + "@" + max + "/" + (s.stepM === undefined ? "pixel" : s.stepM);
}

/**
 * Rough heap cost of a derived domain.
 *
 * Terrain derivatives are the first thing here big enough for a count to
 * matter: ten float32 fields plus the elevation over a 432 x 421 domain is 7 MB
 * before any sheltering, and sixteen sectors is another 11 MB. A cache of 256
 * of those is not 100 MB, it is five gigabytes, which is why this cache is
 * bounded in bytes and the volume cache is bounded in entries.
 */
function derivedBytes(derived) {
  const cells = (derived.width || 0) * (derived.height || 0);
  let fields = Object.keys(derived.fields || {}).length + 1;
  if (derived.shelter) fields += derived.shelter.sectors.length;
  return fields * cells * 4;
}

/**
 * An LRU with no expiry, bounded by bytes.
 *
 * Nothing static needs a time-to-live, and giving it one would evict a
 * mountain's slope on the hour to recompute exactly the same numbers. What it
 * does need is a ceiling in bytes rather than in entries, because one domain
 * can be four orders of magnitude larger than another.
 */
function createStaticCache(opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes === undefined ? DEFAULT_TERRAIN_MAX_BYTES : o.maxBytes;
  const sizeOf = o.sizeOf || derivedBytes;
  const entries = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, stored: 0, rejected: 0 };
  let bytes = 0;

  function get(key) {
    const entry = entries.get(key);
    if (!entry) {
      stats.misses++;
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    stats.hits++;
    return entry.value;
  }

  function set(key, value) {
    const size = sizeOf(value);
    // One domain larger than the whole cache would evict everything and then
    // itself. Refusing is honest: the caller still has the value it just
    // computed, and the next request recomputes rather than thrashing.
    if (size > maxBytes) {
      stats.rejected++;
      return false;
    }
    if (entries.has(key)) bytes -= entries.get(key).bytes;
    entries.delete(key);
    entries.set(key, { value: value, bytes: size });
    bytes += size;
    stats.stored++;
    while (bytes > maxBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).bytes;
      entries.delete(oldest);
      stats.evictions++;
    }
    return true;
  }

  return {
    get: get,
    set: set,
    has: function (key) { return entries.has(key); },
    delete: function (key) {
      const entry = entries.get(key);
      if (!entry) return false;
      bytes -= entry.bytes;
      return entries.delete(key);
    },
    clear: function () { entries.clear(); bytes = 0; },
    keys: function () { return Array.from(entries.keys()); },
    summary: function () {
      return Object.assign({ entries: entries.size, bytes: bytes, maxBytes: maxBytes }, stats);
    }
  };
}

/**
 * A cache in front of something that derives terrain.
 *
 * Same shape as `createVolumeSource`, and single-flight for the same reason
 * with more force behind it: two callers arriving together over one hillside
 * would otherwise both range-read the tile and both spend the geometry, and the
 * geometry is the expensive half.
 */
function createTerrainSource(opts) {
  const o = opts || {};
  if (typeof o.load !== "function") throw fail("no-loader", "load(spec) is required");
  const cache = o.cache || createStaticCache(o);
  // `key` because what is cached is not always the derivatives: a caller that
  // also prepares the downscaling weights has a wider identity (`weightsKey`),
  // and sharing one key between the two would hand back a domain missing half
  // of what was asked for.
  const keyOf = o.key || terrainKey;
  const inFlight = new Map();
  const stats = { coalesced: 0, loads: 0 };

  async function get(spec) {
    const key = keyOf(spec);
    const hit = cache.get(key);
    if (hit) return hit;

    const pending = inFlight.get(key);
    if (pending) {
      stats.coalesced++;
      return pending;
    }

    const promise = (async function () {
      stats.loads++;
      const derived = await o.load(spec);
      cache.set(key, derived);
      return derived;
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
    key: keyOf,
    cache: cache,
    summary: function () { return Object.assign({ inFlight: inFlight.size }, stats, cache.summary()); }
  };
}

module.exports = {
  DEFAULT_SNAP_DEG,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_TERRAIN_SNAP_DEG,
  DEFAULT_TERRAIN_MAX_BYTES,
  snapBox,
  cacheKey,
  terrainKey,
  weightsKey,
  approximateBytes,
  derivedBytes,
  weightsBytes,
  createCache,
  createStaticCache,
  createVolumeSource,
  createTerrainSource,
  createHrrrVolumeSource
};
