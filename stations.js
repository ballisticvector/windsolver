/**
 * The stations inside a box, and what they last measured.
 *
 * Every other answer this service gives is *modelled*: HRRR bent by 3DEP
 * terrain, `modelled: true`, `confidence: null`, and a `notice` saying nobody
 * has compared it with an anemometer. This route is the other kind. A station
 * is a measurement — the one thing on the map that is not a model output — and
 * the reason it is worth an endpoint of its own is that a map with both on it
 * shows the disagreement rather than describing it. `docs/downscaling.md` has
 * nine measurements saying HRRR is 43-70% fast over this network; this is the
 * same fact, on the ground, without a table.
 *
 * **The source is FEMS**, the Forest Service's RAWS archive that `fems.js`
 * already reads: 2,088 stations, anonymous, no token, and — unlike the airport
 * network `observations.js` reads — sited on ridges and in canyons, which is
 * the ground the downscaling is about. `docs/observations.md` has the survey.
 * The seam is deliberately a `source` object with `directory()` and
 * `latest()`, so a second network is a second adapter and not a rewrite: this
 * module does the boxing, the sorting, the caching and the honesty, and knows
 * nothing about CSV.
 *
 * Four things about this data that produce a plausible wrong marker:
 *
 * **All but eleven stations have no calibrated transmit minute, so their time
 * is an hour bin.** FEMS labels a row with the *nearest* whole hour and the
 * measured GOES slots run :08 to :58, so a marker's timestamp is up to half an
 * hour away from the measurement unless `tools/fems-stations.js` has measured
 * that station. `fems.js` refuses an uncalibrated station outright, which is
 * right for scoring and wrong for a map — a marker that is thirty minutes out
 * is still worth looking at, and a blank map is not. So this asks for
 * `hourBins` and carries `timeIsHourBin` out to the caller on every record,
 * and the page says so. What is not allowed is the middle option: showing the
 * hour label as if it were the observation time.
 *
 * **A near-real-time FEMS row has not been quality-controlled at all.** The
 * `WSflag` family is 0/1/2 in the historical record and *empty* in the last few
 * days, because QC is a later pass. Empty and 0 are both "no flag" to a reader
 * that only looks for a value, so `qcChecked` distinguishes "checked, passed"
 * from "nothing has looked at this yet". A marker from the last hour is always
 * the second.
 *
 * **A station in the box that answers nothing is not a calm.** FEMS replies to
 * an unknown station, a dead station and an hour that has not happened yet with
 * the same blank row. A station with no usable record keeps its marker and gets
 * `observation: null` with a reason, because a missing measurement is
 * information about the network and deleting it makes the map look healthier
 * than the data is.
 *
 * **The directory is kept when the network refuses, and says how old it is.**
 * A station list is quasi-static — 2,088 rows, 710 KB, and a new RAWS is a
 * quarterly event — so an expired copy is almost certainly still true, and
 * throwing it away at the moment the upstream fails is how a partial outage
 * becomes an empty map. `directory()` serves the retained copy with
 * `stale: true`, its age, and the error that caused it, and never silently:
 * this is the degraded mode argued for in `docs/history.md`, in the one place
 * where it costs nothing to have.
 */

"use strict";

const geo = require("./geo.js");
const fems = require("./fems.js");

/** A day. The list changes when a RAWS is commissioned, which is not hourly. */
const DEFAULT_DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How far back to look for "the last observation".
 *
 * A RAWS reports hourly, and misses hours: six of the thirteen study stations
 * had at least one gap in a two-day window. Six hours is long enough to survive
 * a gap and short enough that a marker is never a day old without the age
 * making that obvious.
 */
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Past this the answer is a dataset, not a map layer. */
const MAX_STATIONS = 200;
const DEFAULT_LIMIT = 50;

/** FEMS answers a weather query for at most this many stations at once. */
const BATCH = fems.MAX_STATIONS_PER_REQUEST;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/**
 * Great-circle distance in metres, so `limit` keeps the nearest stations rather
 * than the ones the provider happened to list first.
 */
function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The stations inside `box`, nearest to its centre first.
 *
 * Pure, and separate from the fetching, for the reason the rest of this
 * repository is: the interesting mistakes are in the boxing and the ordering,
 * and neither needs a network to get wrong.
 */
function stationsInBox(stations, box, opts) {
  const o = opts || {};
  const limit = o.limit === undefined ? DEFAULT_LIMIT : o.limit;
  const midLat = (box.north + box.south) / 2;
  const midLon = (box.west + box.east) / 2;

  const inside = [];
  for (const s of stations) {
    if (!s || typeof s.lat !== "number" || typeof s.lon !== "number") continue;
    if (!geo.containsPoint(box, s.lat, s.lon)) continue;
    inside.push(Object.assign({}, s, {
      distanceM: distanceM(midLat, midLon, s.lat, s.lon)
    }));
  }
  inside.sort(function (a, b) { return a.distanceM - b.distanceM; });
  const kept = limit === null ? inside : inside.slice(0, limit);
  return { stations: kept, matched: inside.length, truncated: inside.length > kept.length };
}

/**
 * The newest record in a read, or `null` with the reason there is none.
 *
 * A read with no records is never an empty series: `fems.js` counts why each
 * row was dropped, and "the station has no calibrated minute" and "the station
 * was down" reach a viewer as very different sentences.
 */
function latestOf(read) {
  if (!read || !Array.isArray(read.records) || !read.records.length) {
    const why = read && Array.isArray(read.rejected) && read.rejected.length
      ? read.rejected[read.rejected.length - 1]
      : null;
    return {
      observation: null,
      reason: why ? why.reason : "the station reported nothing in this window",
      reasonCode: why ? why.code : "no-observations"
    };
  }
  // The newest by time rather than the last in the list: FEMS returns a batch
  // grouped by station and there is nothing in the format that promises an
  // order, so trusting the position would show yesterday's wind on the day the
  // provider sorts differently.
  let r = read.records[0];
  for (const candidate of read.records) {
    const at = Number.isFinite(candidate.timeMs) ? candidate.timeMs : Date.parse(candidate.time);
    const best = Number.isFinite(r.timeMs) ? r.timeMs : Date.parse(r.time);
    if (Number.isFinite(at) && (!Number.isFinite(best) || at > best)) r = candidate;
  }
  return {
    observation: {
      time: r.time,
      // Never dropped, never defaulted: an uncalibrated station's time is the
      // nearest-hour label and may be half an hour from the measurement.
      timeIsHourBin: r.timeIsHourBin === true,
      transmitMinute: r.transmitMinute === undefined ? null : r.transmitMinute,
      hourLabel: r.hourLabel === undefined ? null : r.hourLabel,
      speedMps: r.speedMps,
      fromDeg: r.fromDeg,
      calm: r.calm === true,
      gustMps: r.gustMps === undefined ? null : r.gustMps,
      // "Nothing has checked this" and "checked and passed" are both an absent
      // flag to a reader that only looks for a value. See the header.
      qcChecked: r.qcChecked === true,
      qcFlags: r.quality === undefined ? null : r.quality
    },
    reason: null,
    reasonCode: null
  };
}

/** The FEMS adapter, behind the two calls this module makes of a network. */
function createFemsStationSource(opts) {
  const o = opts || {};
  const doFetch = o.fetch || globalThis.fetch;

  async function postJson(request) {
    const res = await doFetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request.body)
    });
    if (!res.ok) {
      throw fail("stations-unavailable",
        "FEMS answered " + res.status + " for the station directory",
        { status: res.status });
    }
    return await res.json();
  }

  async function getText(url) {
    const res = await doFetch(url, { headers: { accept: "text/csv" } });
    if (!res.ok) {
      throw fail("observations-unavailable",
        "FEMS answered " + res.status + " for the station observations",
        { status: res.status, url: url });
    }
    return await res.text();
  }

  return {
    network: "RAWS",
    provider: "fems",
    directory: async function () {
      const stations = fems.parseStations(await postJson(fems.metadataRequest({ all: true })));
      return stations.map(function (s) {
        return {
          id: s.id,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          elevationM: s.elevationM,
          // FEMS publishes no anemometer height. A RAWS is specified at 6.1 m
          // (20 ft) rather than the 10 m a METAR is at, but that is knowledge
          // about the network and not something this station said — and the
          // difference matters, because the model has to be moved to the sensor
          // before the two numbers are comparable at all.
          sensorHeightM: null,
          state: s.state,
          agency: s.agency,
          network: "RAWS",
          provider: "fems",
          wrccId: s.wrccId
        };
      });
    },
    latest: async function (ids, window) {
      const out = new Map();
      for (const batch of fems.batches(ids, BATCH)) {
        const text = await getText(fems.weatherUrl({
          stationIds: batch,
          start: window.start,
          end: window.end
        }));
        // `hourBins` on purpose: see the header. Every record this produces is
        // marked `timeIsHourBin` unless the station has a measured minute.
        const read = fems.parseWeatherCsv(text, {
          hourBins: true,
          transmitMinutes: o.transmitMinutes || {}
        });
        for (const [id, value] of read) out.set(id, value);
      }
      return out;
    }
  };
}

/**
 * The service the route calls.
 *
 * `now` and `fetch` are injected for the usual reason: a suite that needs FEMS
 * is a suite that fails on a train, and the caching this module does is about
 * time.
 */
function createStationService(opts) {
  const o = opts || {};
  const source = o.source || createFemsStationSource(o);
  const ttlMs = o.directoryTtlMs === undefined ? DEFAULT_DIRECTORY_TTL_MS : o.directoryTtlMs;
  const windowMs = o.windowMs === undefined ? DEFAULT_WINDOW_MS : o.windowMs;
  const now = o.now || Date.now;

  let held = null;      // { stations, atMs }
  let inFlight = null;

  /**
   * The station list, fresh if the upstream will give one and retained if it
   * will not.
   *
   * The retained answer is never silent. It carries `stale: true`, the age of
   * what is being served and the error that stopped it being refreshed, so a
   * caller can say "as of two days ago, FEMS is down" instead of showing an old
   * list as a current one — or an empty map, which is what discarding it gives.
   */
  async function directory() {
    const atMs = now();
    if (held && atMs - held.atMs < ttlMs) {
      return { stations: held.stations, retrievedAt: new Date(held.atMs).toISOString(),
        ageS: Math.round((atMs - held.atMs) / 1000), stale: false, error: null };
    }
    if (!inFlight) {
      inFlight = (async function () {
        const stations = await source.directory();
        if (!Array.isArray(stations) || !stations.length) {
          throw fail("no-stations", "the station directory came back empty");
        }
        held = { stations: stations, atMs: now() };
        return held;
      })().finally(function () { inFlight = null; });
    }
    try {
      const fresh = await inFlight;
      return { stations: fresh.stations, retrievedAt: new Date(fresh.atMs).toISOString(),
        ageS: 0, stale: false, error: null };
    } catch (err) {
      if (!held) throw err;
      return {
        stations: held.stations,
        retrievedAt: new Date(held.atMs).toISOString(),
        ageS: Math.round((now() - held.atMs) / 1000),
        stale: true,
        error: (err && err.message) || "the station directory could not be refreshed"
      };
    }
  }

  return {
    directory: directory,

    /**
     * The stations in a box, with their last measurement when asked for.
     *
     * The observations are optional because they cost a request per twenty
     * stations and the markers are useful without them: a map can draw where
     * the anemometers are while the wind is still solving, exactly as the
     * hillshade does.
     */
    inBox: async function (box, options) {
      const q = options || {};
      const limit = Math.min(q.limit === undefined ? DEFAULT_LIMIT : q.limit, MAX_STATIONS);
      const dir = await directory();
      const found = stationsInBox(dir.stations, box, { limit: limit });

      const result = {
        box: box,
        stations: found.stations.map(function (s) {
          return Object.assign({}, s, { observation: null, observationNote: null });
        }),
        matched: found.matched,
        returned: found.stations.length,
        truncated: found.truncated,
        observed: false,
        window: null,
        directory: {
          provider: source.provider || null,
          network: source.network || null,
          count: dir.stations.length,
          retrievedAt: dir.retrievedAt,
          ageS: dir.ageS,
          stale: dir.stale,
          error: dir.error
        },
        errors: []
      };

      if (!q.observed || !result.stations.length) return result;

      const end = new Date(now());
      const start = new Date(end.getTime() - windowMs);
      result.window = { start: start.toISOString(), end: end.toISOString() };
      result.observed = true;

      let reads;
      try {
        reads = await source.latest(result.stations.map(function (s) { return s.id; }),
          { start: start, end: end });
      } catch (err) {
        // The markers survive an observation outage: where the anemometers are
        // is a different fact from what they said, and losing the second is no
        // reason to lose the first.
        result.observed = false;
        result.errors.push({
          code: (err && err.code) || "observations-unavailable",
          error: (err && err.message) || "the observations could not be read"
        });
        return result;
      }

      for (const station of result.stations) {
        const latest = latestOf(reads.get(station.id));
        station.observation = latest.observation;
        station.observationNote = latest.reason;
        station.observationCode = latest.reasonCode;
        if (station.observation) {
          station.observation.ageS = Math.round(
            (now() - Date.parse(station.observation.time)) / 1000);
        }
      }
      return result;
    }
  };
}

module.exports = {
  DEFAULT_DIRECTORY_TTL_MS,
  DEFAULT_WINDOW_MS,
  DEFAULT_LIMIT,
  MAX_STATIONS,
  distanceM,
  stationsInBox,
  latestOf,
  createFemsStationSource,
  createStationService
};
