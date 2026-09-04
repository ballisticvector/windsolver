/**
 * Measured surface wind, from stations this engine did not fit to.
 *
 * Everything else in this repository produces a *modelled* wind: HRRR through
 * NOMADS, bent by 3DEP terrain, reported with `confidence: null` because
 * nothing here has ever been compared with an anemometer. This module is the
 * other half of that sentence — it reads what the ground actually measured, so
 * `verify.js` can say by how much the model missed.
 *
 * **The source is the NWS API's station observations** (`api.weather.gov`):
 * ASOS/AWOS METAR, mostly airports, hourly with specials in between, no API key
 * and no account. It is not the best network for this — RAWS through Synoptic
 * sits on ridges and in canyons where the terrain effect is largest, and needs
 * a token — but it is the one that can be read today, and the arithmetic in
 * `verify.js` does not care which network fed it.
 *
 * These stations are independent of the model in the sense that matters here:
 * nothing in this repository is tuned to them, and the downscaling weights are
 * physics with fixed coefficients rather than a regression. They are **not**
 * independent of HRRR — NCEP assimilates surface observations, so a station
 * that fed the 00Z analysis is being asked to grade a forecast that has already
 * seen it. That inflates skill, it is not removable from outside NCEP, and the
 * honest form is to say so and to prefer forecast hours over analysis hours.
 *
 * Four things about this data that produce a plausible wrong number:
 *
 * **Calm is `windDirection: 0`, not `null`.** `00000KT` in the METAR comes back
 * as speed 0 and direction 0, which reads exactly like a 0 km/h wind out of
 * true north. Over two days at Boulder Municipal 37 of 144 observations are
 * calm, so scoring direction against them would put a quarter of the sample at
 * a direction that was never measured. `parseObservations` marks them `calm`
 * and refuses to give them a direction.
 *
 * **Direction is rounded to 10° and speed to a whole knot.** A METAR is
 * quantised before anyone sees it, so a perfect model still scores about 2.9°
 * of direction RMSE and about 0.27 kt of speed RMSE against it. That is the
 * floor; `verify.js` reports it alongside the score so nobody reads 3° of error
 * as a model that is 3° wrong.
 *
 * **The observation feature's own coordinates are rounded to 0.01°.** That is
 * up to about 1.1 km — a different hillside at 1 m terrain resolution. The
 * station endpoint carries the surveyed position to 7 decimals, so a station's
 * location comes from `parseStation` and never from an observation.
 *
 * **The anemometer is at 10 m, and only nominally.** ASOS is specified at 10 m
 * above ground, but sited on airfields — flat, open, deliberately unobstructed
 * ground, which is the terrain WindSolver's downscaling has least to do to. A
 * score built only from airports measures the model where it is least
 * interesting, and that is a limitation of the network, not of the arithmetic.
 */

"use strict";

/** km/h to m/s. The NWS API reports wind in `wmoUnit:km_h-1`. */
const MPS_PER_KMH = 1000 / 3600;

/** Knots to m/s: the international nautical mile, 1852 m, over 3600 s. */
const MPS_PER_KNOT = 1852 / 3600;

/**
 * Quality-control flags whose observations are kept.
 *
 * The NWS API's `qualityControl` is MADIS's: `V` validated, `S` subjective
 * good, `G` coarse-pass good, `C` (coarse pass) and `Z` preliminary — no QC
 * applied — against `X` failed, `Q` questionable and `B` subjective bad. Only
 * the ones that have passed something are kept: `Z` is the flag on a special
 * observation that nothing has checked, and grading a model against unchecked
 * data is how a bad sensor becomes a bad score.
 *
 * Source: MADIS QC levels, as surfaced by api.weather.gov's observation
 * `qualityControl` field.
 */
const DEFAULT_QUALITY = ["V", "S", "G", "C"];

/** Above this, an observation is a report of weather nobody should score against. */
const MAX_PLAUSIBLE_MPS = 60;

const NWS_ROOT = "https://api.weather.gov";

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/**
 * A value in a unit this module knows, in m/s.
 *
 * An unrecognised `unitCode` throws rather than being assumed to be km/h. The
 * NWS API changed the unit strings once already (`unit:km_h-1` to
 * `wmoUnit:km_h-1`), and the failure mode of assuming is a wind field that is
 * wrong by 3.6 and looks entirely ordinary.
 */
function speedToMps(quantity, where) {
  if (!quantity || typeof quantity !== "object") return null;
  const value = quantity.value;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !isFinite(value)) {
    throw fail("bad-observation", where + " is not a number: " + JSON.stringify(value));
  }

  switch (quantity.unitCode) {
    case "wmoUnit:km_h-1":
    case "unit:km_h-1":
      return value * MPS_PER_KMH;
    case "wmoUnit:m_s-1":
    case "unit:m_s-1":
      return value;
    case "wmoUnit:kt":
    case "unit:kt":
      return value * MPS_PER_KNOT;
    default:
      throw fail("bad-unit",
        where + " is in " + JSON.stringify(quantity.unitCode) +
        ", which this reader does not know; add it rather than assuming km/h");
  }
}

function degreesOf(quantity, where) {
  if (!quantity || typeof quantity !== "object") return null;
  const value = quantity.value;
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !isFinite(value)) {
    throw fail("bad-observation", where + " is not a number: " + JSON.stringify(value));
  }
  if (quantity.unitCode !== "wmoUnit:degree_(angle)" && quantity.unitCode !== "unit:degree_(angle)") {
    throw fail("bad-unit",
      where + " is in " + JSON.stringify(quantity.unitCode) + ", not degrees");
  }
  return value;
}

/** 360 is north in a METAR; the rest of this repository writes north as 0. */
function normaliseDeg(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** The URL of one station's metadata. */
function stationUrl(id) {
  return NWS_ROOT + "/stations/" + encodeURIComponent(String(id).toUpperCase());
}

/**
 * The URL of a station's observations over a window.
 *
 * The API takes ISO 8601 instants and returns everything in between, newest
 * first, with no paging: a two-day window at a 20-minute-special airport is 144
 * features and about 600 KB.
 */
function observationsUrl(id, opts) {
  const o = opts || {};
  const url = new URL(stationUrl(id) + "/observations");
  if (o.start) url.searchParams.set("start", isoOf(o.start, "start"));
  if (o.end) url.searchParams.set("end", isoOf(o.end, "end"));
  if (o.limit !== undefined) url.searchParams.set("limit", String(o.limit));
  return url.toString();
}

function isoOf(when, where) {
  if (when instanceof Date) {
    if (Number.isNaN(when.getTime())) throw fail("bad-time", where + " is an invalid Date");
    return when.toISOString();
  }
  if (typeof when === "string") {
    const ms = Date.parse(when);
    if (Number.isNaN(ms)) throw fail("bad-time", where + " is not a time: " + JSON.stringify(when));
    return new Date(ms).toISOString();
  }
  throw fail("bad-time", where + " must be a Date or an ISO 8601 string");
}

/**
 * Station metadata: the surveyed position, which is the only position worth
 * sampling a 1 m terrain field at.
 */
function parseStation(json) {
  const feature = json && typeof json === "object" ? json : null;
  const props = feature && feature.properties;
  const geometry = feature && feature.geometry;

  if (!props || !geometry || geometry.type !== "Point" || !Array.isArray(geometry.coordinates)) {
    throw fail("bad-station", "a station is a GeoJSON Point feature with properties");
  }

  const lon = geometry.coordinates[0];
  const lat = geometry.coordinates[1];
  if (typeof lat !== "number" || typeof lon !== "number" ||
      !isFinite(lat) || !isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw fail("bad-station", "the station's coordinates are not a position on Earth");
  }

  const id = props.stationIdentifier;
  if (typeof id !== "string" || !id) throw fail("bad-station", "the station has no stationIdentifier");

  return {
    id: id,
    name: typeof props.name === "string" ? props.name : null,
    lat: lat,
    lon: lon,
    elevationM: props.elevation ? elevationMetres(props.elevation) : null,
    // api.weather.gov does not publish the height of the anemometer. An ASOS
    // is 10 m by federal standard and so happens to match HRRR's surface
    // level, but that is knowledge about the network rather than something
    // this station said, and writing 10 here would make the two
    // indistinguishable.
    sensorHeightM: null
  };
}

function elevationMetres(quantity) {
  const value = quantity.value;
  if (value === null || value === undefined) return null;
  if (quantity.unitCode !== "wmoUnit:m" && quantity.unitCode !== "unit:m") {
    throw fail("bad-unit", "the station elevation is in " + JSON.stringify(quantity.unitCode) + ", not metres");
  }
  return value;
}

/**
 * A station's observations, split into the ones worth scoring and the ones not.
 *
 * Every record that is dropped is counted and given a reason, because "1,000
 * observations, RMSE 1.2 m/s" and "1,000 observations of which 900 were
 * dropped, RMSE 1.2 m/s" are different claims and only one of them is
 * defensible.
 *
 * A record kept always has a speed. It has a direction only when the wind was
 * blowing and the sensor said which way: a calm carries `fromDeg: null` and
 * `calm: true`, and a variable-direction report carries `fromDeg: null` with
 * `calm: false`. Both are usable for speed.
 */
function parseObservations(json, opts) {
  const o = opts || {};
  const quality = o.quality || DEFAULT_QUALITY;
  const maxMps = o.maxMps === undefined ? MAX_PLAUSIBLE_MPS : o.maxMps;

  if (!json || typeof json !== "object" || !Array.isArray(json.features)) {
    throw fail("bad-observations", "an observation collection is GeoJSON with a features array");
  }

  const records = [];
  const rejected = [];
  let stationId = null;

  for (const feature of json.features) {
    const p = feature && feature.properties;
    if (!p || typeof p !== "object") {
      rejected.push({ time: null, code: "bad-feature", reason: "a feature with no properties" });
      continue;
    }

    if (!stationId && typeof p.stationId === "string") stationId = p.stationId;

    const timeMs = Date.parse(p.timestamp);
    if (Number.isNaN(timeMs)) {
      rejected.push({ time: p.timestamp || null, code: "bad-time", reason: "unreadable timestamp" });
      continue;
    }
    const time = new Date(timeMs).toISOString();

    const speedQc = p.windSpeed && p.windSpeed.qualityControl;
    if (speedQc !== undefined && quality.indexOf(speedQc) < 0) {
      rejected.push({ time: time, code: "bad-quality", reason: "wind speed flagged " + speedQc });
      continue;
    }

    const speedMps = speedToMps(p.windSpeed, "windSpeed at " + time);
    if (speedMps === null) {
      rejected.push({ time: time, code: "no-wind", reason: "the observation reports no wind speed" });
      continue;
    }
    if (speedMps < 0 || speedMps > maxMps) {
      rejected.push({ time: time, code: "implausible", reason: speedMps.toFixed(1) + " m/s" });
      continue;
    }

    const calm = speedMps === 0;
    const dirQc = p.windDirection && p.windDirection.qualityControl;
    const dirTrusted = dirQc === undefined || quality.indexOf(dirQc) >= 0;
    const rawDir = dirTrusted ? degreesOf(p.windDirection, "windDirection at " + time) : null;

    records.push({
      stationId: typeof p.stationId === "string" ? p.stationId : stationId,
      time: time,
      timeMs: timeMs,
      speedMps: speedMps,
      // A calm has no direction to report, whatever the field says. See the
      // header: `00000KT` arrives as 0°, which is indistinguishable from a
      // northerly if it is taken at face value.
      fromDeg: calm || rawDir === null ? null : normaliseDeg(rawDir),
      calm: calm,
      gustMps: speedToMps(p.windGust, "windGust at " + time),
      quality: speedQc === undefined ? null : speedQc,
      raw: typeof p.rawMessage === "string" ? p.rawMessage : null
    });
  }

  records.sort(function (a, b) { return a.timeMs - b.timeMs; });

  return {
    stationId: stationId,
    records: records,
    rejected: rejected,
    counts: {
      seen: json.features.length,
      kept: records.length,
      rejected: rejected.length,
      calm: records.filter(function (r) { return r.calm; }).length,
      withDirection: records.filter(function (r) { return r.fromDeg !== null; }).length
    }
  };
}

/**
 * Read a station and its observations over the network.
 *
 * `fetch` is injected for the same reason it is in `nomads.js`: the interesting
 * bugs are in the parsing, and a suite that needs api.weather.gov is a suite
 * that fails on a train. Nothing above this function touches the network.
 *
 * The NWS API requires a `User-Agent` identifying the caller and returns 403
 * without one.
 */
function createObservationSource(opts) {
  const o = opts || {};
  const doFetch = o.fetch || globalThis.fetch;
  const userAgent = o.userAgent || "(windsolver.com, wind-verification)";

  async function getJson(url) {
    const res = await doFetch(url, {
      headers: { "user-agent": userAgent, accept: "application/geo+json" }
    });
    if (!res.ok) {
      throw fail("observations-unavailable",
        "the weather service answered " + res.status + " for " + url,
        { status: res.status, url: url });
    }
    return await res.json();
  }

  return {
    station: async function (id) {
      return parseStation(await getJson(stationUrl(id)));
    },
    observations: async function (id, window) {
      return parseObservations(await getJson(observationsUrl(id, window)), o);
    }
  };
}

module.exports = {
  MPS_PER_KMH,
  MPS_PER_KNOT,
  DEFAULT_QUALITY,
  MAX_PLAUSIBLE_MPS,
  NWS_ROOT,
  speedToMps,
  normaliseDeg,
  stationUrl,
  observationsUrl,
  parseStation,
  parseObservations,
  createObservationSource
};
