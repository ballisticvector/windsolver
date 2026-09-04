/**
 * Measured surface wind from Synoptic Data, which is where RAWS lives.
 *
 * `observations.js` reads the NWS API: no key, no account, and almost entirely
 * airports. An ASOS is sited on an airfield — flat, open, deliberately
 * unobstructed — which is the ground a 3 km model already gets right and the
 * ground the downscaling has least to do to. Scoring only there measures the
 * engine where it is least interesting.
 *
 * **RAWS is the network on the terrain.** The Remote Automated Weather Station
 * programme is run by the land-management agencies for fire behaviour, so its
 * stations are on ridges, in canyons and on passes by design. Synoptic Data
 * (formerly MesoWest) redistributes it — network id 2 — behind a token.
 *
 * This module produces the same normalised records `observations.js` does, so
 * `verify.js` and `tools/score-wind.js` do not know which network fed them.
 * What changes is where the stations are, and that is the whole point.
 *
 * The independence caveat is unchanged and is worth repeating, because RAWS
 * does not fix it: **NCEP assimilates surface observations, RAWS included**, so
 * an analysis hour has already seen these stations. The downscaling has not.
 *
 * Five things about this API that produce a plausible wrong number:
 *
 * **A refusal arrives as HTTP 200.** An unknown station id, a window outside
 * the account's history allowance, and an over-quota request all return 200
 * with `SUMMARY.RESPONSE_CODE` 2 or an HTTP status *inside* the body and no
 * `STATION` array at all. Only `RESPONSE_CODE === 1` is an answer. This is the
 * same family as NOMADS returning its HTML form with a 200, and it is checked
 * the same way.
 *
 * **The units depend on the request, and not in the way the parameter reads.**
 * `units=metric` returns positions in metres and elevations in *feet*; adding
 * `speed|mps` to the same parameter moves positions to feet as well. Every
 * response carries a `UNITS` block, so every quantity here is converted from
 * what the payload says it is and an unknown unit throws. Assuming metres for
 * an elevation in feet puts a station 1,000 m below the mountain it is on.
 *
 * **A QC flag is an array parallel to the observations, not a field on one.**
 * `STATION[i].QC.wind_speed_set_1[k]` is `null` or a list of check ids for
 * `OBSERVATIONS.date_time[k]`. Ignoring it keeps readings like the 50.96 m/s
 * spike in `tests/fixtures/synoptic-timeseries-flagged.json` — 114 mph, inside
 * any plausible range check, caught only by comparison with its neighbours.
 *
 * **Calm is 0 m/s with a direction of 0°**, exactly as in a METAR, and means
 * the same thing: no direction was measured. It is marked `calm` and given no
 * direction rather than being read as a northerly.
 *
 * **RAWS is not an ASOS.** A 10 m tower in brush on a ridge is a harder site
 * than a mown airfield: the sensor sees the vegetation as well as the terrain,
 * and part of the extra error against these stations belongs to the site rather
 * than to the model. That is a reason to report the terrain classes separately,
 * not a reason to prefer the airports.
 */

"use strict";

const SYNOPTIC_ROOT = "https://api.synopticdata.com/v2";

/** Synoptic's network id for RAWS. `stations/networks` lists the rest. */
const RAWS_NETWORK_ID = 2;

/** The international foot, exactly 0.3048 m. */
const M_PER_FOOT = 0.3048;

/** Above this, an observation is a report of weather nobody should score against. */
const MAX_PLAUSIBLE_MPS = 60;

/**
 * What a RAWS observation is rounded to before anyone sees it.
 *
 * Synoptic hands the speed over as metric to three decimals, which reads like a
 * millimetre-per-second instrument. It is a conversion: every value in
 * `tests/fixtures/synoptic-timeseries-raws.json` is a whole number of miles per
 * hour — 5.812, 1.788, 0.447, 3.129 are 13, 4, 1 and 7 mph — because the RAWS
 * standard (NWCG PMS 426-3) specifies mph and Synoptic converts on the way out.
 *
 * So the floor a perfect model could score against RAWS is 1 mph and 1°, not a
 * METAR's whole knot and 10°. It is a tighter ruler than the airports, which is
 * the second reason to prefer these stations: the RWIS feed that was the
 * alternative quantises direction to 45°, a 13° floor before the model is
 * even wrong.
 */
const RAWS_QUANTISATION = { speedStepMps: 0.44704, dirStepDeg: 1 };

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/**
 * A URL with the token taken out of it.
 *
 * Every error here quotes the request that produced it, and the token is a
 * credential: one thrown error in a log or a CI transcript is a leaked key.
 */
function redactToken(url) {
  return String(url).replace(/([?&]token=)[^&]*/g, "$1REDACTED");
}

function buildUrl(path, params, token) {
  if (typeof token !== "string" || !token) {
    throw fail("no-token", "Synoptic needs an API token; get one at customer.synopticdata.com");
  }
  const url = new URL(SYNOPTIC_ROOT + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("token", token);
  return url.toString();
}

/** Station metadata for a set of ids, or for a whole network in a state. */
function metadataUrl(query, token) {
  const q = query || {};
  return buildUrl("/stations/metadata", {
    stid: Array.isArray(q.stids) ? q.stids.join(",") : q.stids,
    state: q.state,
    network: q.network,
    status: q.status,
    bbox: Array.isArray(q.bbox) ? q.bbox.join(",") : q.bbox
  }, token);
}

/**
 * Wind over a window.
 *
 * `qc_remove_data=off` keeps the flagged rows in the response and flags them,
 * rather than silently shortening the series: a reader that cannot see what was
 * removed cannot report how much of its sample survived.
 */
function timeseriesUrl(query, token) {
  const q = query || {};
  return buildUrl("/stations/timeseries", {
    stid: Array.isArray(q.stids) ? q.stids.join(",") : q.stids,
    state: q.state,
    network: q.network,
    start: compactTime(q.start, "start"),
    end: compactTime(q.end, "end"),
    vars: q.vars || "wind_speed,wind_direction,wind_gust",
    obtimezone: "UTC",
    units: "metric",
    qc: "on",
    qc_checks: "all",
    qc_flags: "on",
    qc_remove_data: "off"
  }, token);
}

/** Synoptic takes `YYYYMMDDhhmm`, in UTC because `obtimezone` says so. */
function compactTime(when, where) {
  if (when === undefined || when === null) return undefined;
  const date = when instanceof Date ? when : new Date(Date.parse(String(when)));
  if (Number.isNaN(date.getTime())) {
    throw fail("bad-time", where + " is not a time: " + JSON.stringify(when));
  }
  const iso = date.toISOString();
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16);
}

/**
 * The response, if it is one.
 *
 * `RESPONSE_CODE` 1 is the only value that means the request was answered. The
 * rest — an unknown station, a window the account may not read, a quota — come
 * back as 200 with a message and no data, and read downstream as a station that
 * simply had no wind.
 */
function requireAnswer(json, url) {
  if (!json || typeof json !== "object" || !json.SUMMARY || typeof json.SUMMARY !== "object") {
    throw fail("bad-response", "Synoptic did not answer with a SUMMARY: " + redactToken(url));
  }
  const summary = json.SUMMARY;
  if (summary.RESPONSE_CODE !== 1) {
    throw fail("synoptic-refused",
      "Synoptic refused " + redactToken(url) + ": " +
      (summary.RESPONSE_MESSAGE || "response code " + summary.RESPONSE_CODE),
      { responseCode: summary.RESPONSE_CODE, responseMessage: summary.RESPONSE_MESSAGE || null });
  }
  return json;
}

/**
 * The units this response is in.
 *
 * A timeseries carries the variable units at the top and the position and
 * elevation units on each station; a metadata response carries only the
 * station's. Neither block is complete on its own, so they are merged with the
 * station's winning, and an absent block is an error rather than a default.
 */
function unitsOf(json, station) {
  const top = json && typeof json.UNITS === "object" && json.UNITS ? json.UNITS : null;
  const own = station && typeof station.UNITS === "object" && station.UNITS ? station.UNITS : null;
  if (!top && !own) {
    throw fail("no-units", "the response carries no UNITS block, so nothing in it can be converted");
  }
  return Object.assign({}, top, own);
}

function metresFrom(value, unit, where) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) throw fail("bad-station", where + " is not a number: " + JSON.stringify(value));
  switch (unit) {
    case "m":
    case "meters":
    case "metres":
      return n;
    case "ft":
    case "feet":
      return n * M_PER_FOOT;
    default:
      throw fail("bad-unit",
        where + " is in " + JSON.stringify(unit) + ", which this reader does not know; " +
        "add it rather than assuming metres");
  }
}

function numberOf(value, where) {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) throw fail("bad-station", where + " is not a number: " + JSON.stringify(value));
  return n;
}

/**
 * Stations, with their surveyed position and their published elevation.
 *
 * `demElevationM` is Synoptic's own reading of a DEM under the coordinate. It
 * is not used to place anything — the published position is — but a station
 * whose two elevations disagree by hundreds of metres has one of them wrong,
 * and `verify.elevationCheck` is what decides whether to score it.
 */
function parseStations(json) {
  const answered = requireAnswer(json, "the station metadata");
  const list = Array.isArray(answered.STATION) ? answered.STATION : [];
  return list.map(function (s) {
    const units = unitsOf(answered, s);
    const id = typeof s.STID === "string" ? s.STID : null;
    if (!id) throw fail("bad-station", "a station has no STID");
    const lat = numberOf(s.LATITUDE, id + " latitude");
    const lon = numberOf(s.LONGITUDE, id + " longitude");
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw fail("bad-station", id + " is not at a position on Earth");
    }
    return {
      id: id,
      name: typeof s.NAME === "string" ? s.NAME : null,
      lat: lat,
      lon: lon,
      elevationM: metresFrom(s.ELEVATION, units.elevation, id + " elevation"),
      demElevationM: metresFrom(s.ELEV_DEM, units.elevation, id + " DEM elevation"),
      network: s.MNET_ID === undefined ? null : Number(s.MNET_ID),
      status: typeof s.STATUS === "string" ? s.STATUS : null,
      state: typeof s.STATE === "string" ? s.STATE : null,
      source: "synoptic"
    };
  });
}

function requireUnit(units, key, expected, where) {
  const unit = units[key];
  if (expected.indexOf(unit) < 0) {
    throw fail("bad-unit",
      where + " came back in " + JSON.stringify(unit) + " rather than " + expected.join(" or ") +
      "; convert it rather than reading it as " + expected[0]);
  }
}

/** The QC check ids flagged against observation `index`, or null. */
function flagsAt(qc, variable, index) {
  if (!qc || typeof qc !== "object") return null;
  const series = qc[variable];
  if (!Array.isArray(series)) return null;
  const at = series[index];
  if (!at) return null;
  const list = Array.isArray(at) ? at : [at];
  return list.length ? list : null;
}

/**
 * One station's wind, split into what is worth scoring and what is not.
 *
 * The shape is `observations.parseObservations`': a record always has a speed,
 * and has a direction only when the wind was blowing and the sensor said which
 * way. Everything dropped is counted with a reason, because a sample size means
 * nothing without the number that did not survive.
 */
function parseStationSeries(station, units, opts) {
  const o = opts || {};
  const maxMps = o.maxMps === undefined ? MAX_PLAUSIBLE_MPS : o.maxMps;
  const obs = station.OBSERVATIONS;
  const id = typeof station.STID === "string" ? station.STID : null;

  if (!obs || typeof obs !== "object" || !Array.isArray(obs.date_time)) {
    throw fail("bad-observations", (id || "a station") + " has no date_time series");
  }

  requireUnit(units, "wind_speed", ["m/s"], "wind speed");
  requireUnit(units, "wind_direction", ["Degrees", "degrees"], "wind direction");

  const speeds = obs.wind_speed_set_1;
  const directions = obs.wind_direction_set_1;
  const gusts = obs.wind_gust_set_1;
  if (!Array.isArray(speeds)) {
    throw fail("bad-observations", (id || "a station") + " reports no wind_speed_set_1");
  }

  const records = [];
  const rejected = [];

  for (let i = 0; i < obs.date_time.length; i++) {
    const stamp = obs.date_time[i];
    const timeMs = Date.parse(stamp);
    if (Number.isNaN(timeMs)) {
      rejected.push({ time: stamp || null, code: "bad-time", reason: "unreadable timestamp" });
      continue;
    }
    const time = new Date(timeMs).toISOString();

    const speedFlags = flagsAt(station.QC, "wind_speed_set_1", i);
    if (speedFlags) {
      rejected.push({ time: time, code: "bad-quality", reason: "wind speed flagged " + speedFlags.join(",") });
      continue;
    }

    const speed = speeds[i];
    if (speed === null || speed === undefined) {
      rejected.push({ time: time, code: "no-wind", reason: "the observation reports no wind speed" });
      continue;
    }
    if (typeof speed !== "number" || !isFinite(speed)) {
      rejected.push({ time: time, code: "bad-observation", reason: "wind speed is not a number" });
      continue;
    }
    if (speed < 0 || speed > maxMps) {
      rejected.push({ time: time, code: "implausible", reason: speed.toFixed(1) + " m/s" });
      continue;
    }

    const calm = speed === 0;
    const dirFlags = flagsAt(station.QC, "wind_direction_set_1", i);
    const rawDir = dirFlags || !Array.isArray(directions) ? null : directions[i];
    const dir = typeof rawDir === "number" && isFinite(rawDir) ? ((rawDir % 360) + 360) % 360 : null;
    const gust = Array.isArray(gusts) && typeof gusts[i] === "number" && isFinite(gusts[i]) ? gusts[i] : null;

    records.push({
      stationId: id,
      time: time,
      timeMs: timeMs,
      speedMps: speed,
      fromDeg: calm ? null : dir,
      calm: calm,
      gustMps: gust,
      quality: speedFlags ? speedFlags.join(",") : null,
      raw: null
    });
  }

  records.sort(function (a, b) { return a.timeMs - b.timeMs; });

  return {
    stationId: id,
    records: records,
    rejected: rejected,
    counts: {
      seen: obs.date_time.length,
      kept: records.length,
      rejected: rejected.length,
      calm: records.filter(function (r) { return r.calm; }).length,
      withDirection: records.filter(function (r) { return r.fromDeg !== null; }).length
    }
  };
}

/** Every station in a timeseries response, keyed by station id. */
function parseTimeseries(json, opts) {
  const answered = requireAnswer(json, "the timeseries");
  const list = Array.isArray(answered.STATION) ? answered.STATION : [];
  const out = new Map();
  for (const station of list) {
    const units = unitsOf(answered, station);
    const read = parseStationSeries(station, units, opts);
    if (read.stationId) out.set(read.stationId, read);
  }
  return out;
}

/**
 * Read Synoptic over the network, behind the interface `score-wind.js` expects.
 *
 * `fetch` is injected for the same reason it is everywhere else here: the
 * interesting bugs are in the parsing, and a suite that needs a credential is a
 * suite that only one machine can run.
 *
 * One window is fetched once. A verification run asks for the same hours at
 * every station, and Synoptic answers for a whole list of stations in one
 * request — so the series are read together and handed out per station, which
 * is one round trip instead of one per station.
 */
function createSynopticSource(opts) {
  const o = opts || {};
  const token = o.token;
  const doFetch = o.fetch || globalThis.fetch;
  const stations = new Map();
  const series = new Map();

  async function getJson(url) {
    const res = await doFetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      let message = null;
      try {
        const body = await res.json();
        message = body && body.SUMMARY ? body.SUMMARY.RESPONSE_MESSAGE : null;
      } catch (_err) {
        message = null;
      }
      throw fail("observations-unavailable",
        "Synoptic answered " + res.status + " for " + redactToken(url) + (message ? ": " + message : ""),
        { status: res.status, url: redactToken(url) });
    }
    return await res.json();
  }

  async function loadStations(ids) {
    const missing = ids.filter(function (id) { return !stations.has(id); });
    if (!missing.length) return;
    const parsed = parseStations(await getJson(metadataUrl({ stids: missing }, token)));
    for (const station of parsed) stations.set(station.id, station);
    for (const id of missing) {
      if (!stations.has(id)) throw fail("unknown-station", "Synoptic has no station " + id);
    }
  }

  return {
    /** Every station in a network, for choosing a set by terrain rather than by name. */
    search: async function (query) {
      const parsed = parseStations(await getJson(metadataUrl(query, token)));
      for (const station of parsed) stations.set(station.id, station);
      return parsed;
    },

    station: async function (id) {
      await loadStations([String(id).toUpperCase()]);
      return stations.get(String(id).toUpperCase());
    },

    observations: async function (id, window) {
      const key = String(id).toUpperCase();
      const windowKey = compactTime(window.start, "start") + "-" + compactTime(window.end, "end");
      if (!series.has(windowKey)) {
        const wanted = o.stids && o.stids.length ? o.stids : [key];
        series.set(windowKey, parseTimeseries(
          await getJson(timeseriesUrl({ stids: wanted, start: window.start, end: window.end }, token)), o
        ));
      }
      const read = series.get(windowKey);
      return read.get(key) || {
        stationId: key,
        records: [],
        rejected: [],
        counts: { seen: 0, kept: 0, rejected: 0, calm: 0, withDirection: 0 }
      };
    }
  };
}

module.exports = {
  SYNOPTIC_ROOT,
  RAWS_NETWORK_ID,
  M_PER_FOOT,
  MAX_PLAUSIBLE_MPS,
  RAWS_QUANTISATION,
  redactToken,
  metadataUrl,
  timeseriesUrl,
  compactTime,
  parseStations,
  parseTimeseries,
  createSynopticSource
};
