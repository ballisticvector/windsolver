/**
 * A disk cache for The National Map's product listings.
 *
 * **The slow part of a cold terrain solve is not the terrain.** A window out of
 * a 449 MB 3DEP tile is five range requests and about 1.3 MB; asking
 * `tnmaccess.nationalmap.gov/api/v1/products` *which* tiles cover the box has
 * been measured at 29 s, and at 504 for minutes at a time. That question is
 * also the one whose answer barely changes: tile footprints move when USGS
 * publishes a new lidar project, which is monthly at best.
 *
 * So the listing is worth keeping on disk rather than in memory. The in-memory
 * terrain source in `cache.js` already spares a *running* process the second
 * ask; this is what spares the first visitor after a deploy, and it is the only
 * cache here that survives a restart.
 *
 * The decisions worth knowing before changing anything:
 *
 * **A failure is never stored.** A 503 from The National Map is a fact about
 * this minute, and remembering it would turn a bad afternoon into a cached
 * "there is no terrain here" — the exact confident-wrong-answer this repo
 * refuses everywhere else. Only a body that parsed is written.
 *
 * **An expired entry is kept, and offered only when the network refuses.** The
 * TTL is when a listing stops being trusted without asking, not when it stops
 * being true; deleting it at expiry would throw the fallback away at exactly
 * the moment TNM has just declined to replace it, which is the one moment it is
 * worth anything. A retained listing is a fresh read's second choice and is
 * always dated — see `getRetained`.
 *
 * **An unreadable entry is a miss, not an error.** A half-written file from a
 * killed process, a truncated disk, a file from a future format: all of them
 * read as "ask again". The cache is an optimisation, and an optimisation that
 * can fail a request is a liability.
 *
 * **A directory that cannot be written is reported once.** A cache that silently
 * does nothing is indistinguishable from one that is working, and the first
 * deployment of this module spent every request re-asking TNM because the unit
 * carried `ProtectHome=read-only` and every write failed into the `catch`
 * below. Failing the request over it would still be wrong; saying so would not.
 *
 * **Entries are written atomically.** Write to a temporary name in the same
 * directory and rename over the target, because rename within a filesystem is
 * atomic and a reader can therefore only ever see a whole file. Two processes
 * warming the same box race harmlessly: last rename wins, and both wrote the
 * same bytes.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * How long a listing is trusted, in milliseconds.
 *
 * Fourteen days. 3DEP publishes new lidar projects on a monthly-ish cadence and
 * a footprint that already exists does not move, so the cost of being stale is
 * that a newly published finer product is missed for up to a fortnight — while
 * the cost of being cold is 29 s of user-visible wait, or a refusal when TNM is
 * down. The asymmetry is why this is days rather than hours.
 */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Entries kept before the oldest are dropped.
 *
 * A listing for one dataset over one snapped box is a few kilobytes to a few
 * hundred; 2048 of them is tens of megabytes, which is nothing against the
 * droplet's disk and enough to hold every box a demo or a busy day touches.
 */
const DEFAULT_MAX_ENTRIES = 2048;

/**
 * How long an expired listing is still worth offering when TNM will not answer,
 * in milliseconds.
 *
 * Six months. A stale listing errs in one direction — it can only be missing a
 * product published since, never wrong about a footprint it has, because a 3DEP
 * tile that exists does not move — so serving it during an outage risks coarser
 * terrain, while refusing it means no terrain at all. Past about two publishing
 * seasons that stops being a good bet, and "we have nothing recent for this
 * box" is the more honest answer than ground chosen from a listing nobody has
 * been able to confirm since.
 */
const DEFAULT_RETAIN_MS = 180 * 24 * 60 * 60 * 1000;

/** Written into every entry, so a format change cannot be read as old data. */
const FORMAT = 1;

/**
 * Where entries live.
 *
 * Under the user's cache directory rather than the system temporary directory,
 * because a temporary directory is exactly what a reboot or a snapshot throws
 * away, and a cache that empties on restart does not solve the problem this
 * module exists for.
 */
function defaultDir() {
  if (process.env.WINDSOLVER_CACHE_DIR) return path.join(process.env.WINDSOLVER_CACHE_DIR, "tnm");
  const home = os.homedir();
  if (home) return path.join(home, ".cache", "windsolver", "tnm");
  /* c8 ignore next */
  return path.join(os.tmpdir(), "windsolver-cache", "tnm");
}

/** A filename for a URL: hashed, because a URL is not a filename. */
function fileNameFor(url) {
  return crypto.createHash("sha256").update(String(url)).digest("hex") + ".json";
}

/**
 * The default report for a cache directory that will not take a write: one
 * line on stderr, in the shape `tools/serve.js` logs.
 */
function writeWarning(detail) {
  process.stderr.write(JSON.stringify(Object.assign({
    t: new Date().toISOString(),
    level: "warn",
    message: "listing cache is not writable; every solve will re-ask The National Map"
  }, detail)) + "\n");
}

/**
 * A listing cache over a directory.
 *
 * `now` is injectable so expiry can be tested without waiting a fortnight, and
 * every method resolves rather than throwing: see the note above about an
 * optimisation that must not be able to fail a request.
 */
function createListingCache(options) {
  const o = options || {};
  const dir = o.dir || defaultDir();
  const ttlMs = o.ttlMs === undefined ? DEFAULT_TTL_MS : o.ttlMs;
  const maxEntries = o.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : o.maxEntries;
  const retainMs = o.retainMs === undefined ? DEFAULT_RETAIN_MS : o.retainMs;
  const now = o.now || function () { return Date.now(); };
  const stats = {
    hits: 0, misses: 0, stale: 0, writes: 0, unreadable: 0, evicted: 0, writeFails: 0, retained: 0
  };
  const warn = o.onWriteError === undefined ? writeWarning : o.onWriteError;
  // Reported once, because the failure is a property of the directory rather
  // than of the request: a read-only home would otherwise write the same line
  // for every listing of every solve, and that is a warning nobody reads.
  let warned = false;

  function pathFor(url) {
    return path.join(dir, fileNameFor(url));
  }

  /** The entry on disk, whatever its age, or null if there is nothing usable. */
  async function read(url) {
    let text;
    try {
      text = await fs.promises.readFile(pathFor(url), "utf8");
    } catch {
      stats.misses++;
      return null;
    }
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      stats.unreadable++;
      return null;
    }
    if (!entry || entry.format !== FORMAT || !isFinite(entry.storedAt) || entry.body === undefined) {
      stats.unreadable++;
      return null;
    }
    return {
      body: entry.body,
      storedAt: entry.storedAt,
      ageMs: now() - entry.storedAt,
      url: entry.url || null
    };
  }

  async function get(url) {
    const entry = await read(url);
    if (!entry) return null;
    // A negative age means the clock moved backwards, not that the entry is
    // fresh for a fortnight plus however far it moved. Treat it as expired.
    if (entry.ageMs < 0 || entry.ageMs > ttlMs) {
      stats.stale++;
      return null;
    }
    stats.hits++;
    return entry;
  }

  /**
   * The entry past its TTL, for a caller that has just been refused a fresh one.
   *
   * Separate from `get` rather than a flag on it, because the two answers mean
   * different things and only one of them may be served without saying so:
   * this one is dated, marked `stale`, and is the caller's job to carry through
   * to whatever a person reads. A clock that moved backwards is still not an
   * answer, and neither is an entry older than `retainMs`.
   */
  async function getRetained(url) {
    const entry = await read(url);
    if (!entry) return null;
    if (entry.ageMs < 0 || entry.ageMs > retainMs) return null;
    stats.retained++;
    return Object.assign({ stale: entry.ageMs > ttlMs }, entry);
  }

  /**
   * Drop the oldest entries once there are too many.
   *
   * By modification time, which is when the entry was written, so the least
   * recently *warmed* box goes first. Read time would be better and costs a
   * write per read, which is the wrong trade for a cache whose entries are
   * cheap to rebuild.
   */
  async function prune() {
    let names;
    try {
      names = (await fs.promises.readdir(dir)).filter(function (n) { return n.endsWith(".json"); });
    } catch {
      /* c8 ignore next */
      return;
    }
    if (names.length <= maxEntries) return;
    const withTimes = [];
    for (const name of names) {
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        withTimes.push({ name: name, at: st.mtimeMs });
      } catch { /* raced with another prune; it is gone either way */ }
    }
    withTimes.sort(function (a, b) { return a.at - b.at; });
    for (const entry of withTimes.slice(0, withTimes.length - maxEntries)) {
      try {
        await fs.promises.unlink(path.join(dir, entry.name));
        stats.evicted++;
      } catch { /* likewise */ }
    }
  }

  async function put(url, body) {
    const target = pathFor(url);
    const temp = target + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify({
        format: FORMAT,
        url: String(url),
        storedAt: now(),
        body: body
      }));
      await fs.promises.rename(temp, target);
      stats.writes++;
    } catch (err) {
      // A cache that cannot write is a cache that is not helping, not a
      // request that failed. Clean up if we can, say so once, and carry on.
      stats.writeFails++;
      try { await fs.promises.unlink(temp); } catch { /* nothing to clean */ }
      if (warn && !warned) {
        warned = true;
        warn({ dir: dir, error: String(err && err.message || err), fails: stats.writeFails });
      }
      return false;
    }
    await prune();
    return true;
  }

  return {
    dir: dir,
    ttlMs: ttlMs,
    retainMs: retainMs,
    path: pathFor,
    get: get,
    getRetained: getRetained,
    put: put,
    prune: prune,
    stats: function () { return Object.assign({}, stats); }
  };
}

/**
 * A `fetchJson(url)` that consults the cache first, and last.
 *
 * Wrapping rather than teaching `dem.js` about disks keeps discovery a pure
 * function of its fetcher, which is what makes its whole suite offline. The
 * wrapper is also where in-flight collapsing lives: two concurrent solves over
 * the same ground ask The National Map once, which matters most exactly when it
 * is slow enough for a second request to arrive during the first.
 *
 * **Fresh entry, then the network, then an expired entry.** The third step is
 * the degraded mode: TNM answering 503 — or answering HTTP 200 with an error
 * object, which is what it did for hours during the hillshade testing — is a
 * fact about this minute, and a fortnight-old list of which tiles cover Boulder
 * is still very likely true. What it must not do is arrive unannounced, so a
 * reader that fell back records it and `retained()` hands the dated list to the
 * caller, which carries it out to whatever a person reads.
 */
function cachingJsonReader(fetchJson, cache) {
  if (typeof fetchJson !== "function") {
    throw new Error("cachingJsonReader needs a fetchJson(url) to fall back to");
  }
  const store = cache || createListingCache();
  const inFlight = new Map();
  const fellBack = [];

  const reader = async function (url) {
    const hit = await store.get(url);
    if (hit) return hit.body;

    const pending = inFlight.get(url);
    if (pending) return pending;

    const work = (async function () {
      let body;
      try {
        body = await fetchJson(url);
      } catch (err) {
        const kept = await store.getRetained(url);
        // Nothing kept means the refusal stands: an outage over ground nobody
        // has visited is still "we cannot find out", and inventing terrain for
        // it would be the confident wrong answer this whole module avoids.
        if (!kept) throw err;
        fellBack.push({
          url: String(url),
          storedAt: kept.storedAt,
          ageMs: kept.ageMs,
          stale: kept.stale,
          error: String(err && err.message || err)
        });
        return kept.body;
      }
      await store.put(url, body);
      return body;
    })();
    inFlight.set(url, work);
    try {
      return await work;
    } finally {
      inFlight.delete(url);
    }
  };

  /** The retained listings this reader has served, oldest first, or null. */
  reader.retained = function () {
    return fellBack.length ? fellBack.slice() : null;
  };
  return reader;
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETAIN_MS,
  FORMAT,
  defaultDir,
  fileNameFor,
  createListingCache,
  cachingJsonReader
};
