/**
 * Measured surface wind from CoAgMet, Colorado's agricultural mesonet.
 *
 * Every anemometer this repository has scored against so far stands above the
 * layer the product is about: a RAWS at 6.1 m, an ASOS at 8.2-10.1 m. CoAgMet
 * is the first one inside it. 129 stations, 101 of them reporting, and the
 * height is published per station: 101 at 2.0 m, one at 2.2 m, 22 at 3.0 m,
 * two at 10 m, three that publish no height at all. Fifteen of them sit in
 * valley bottoms at the 2 km radius a two-mile map is about. Five-minute
 * averages, no account, no key, back to 1992 at the oldest station.
 *
 * That is what `docs/near-ground-wind.md` says is missing before a 0-3 m field
 * can be graded at all. It is not, on its own, evidence that such a field
 * works: these are irrigated farm sites chosen for agronomy, not for wind, and
 * `docs/observations.md` keeps the representativeness caveats.
 *
 * This module produces the records `observations.js` produces, so `verify.js`
 * and `tools/score-wind.js` cannot tell which network fed them.
 *
 * Six things about this service that produce a plausible wrong number:
 *
 * **The timestamp labels the END of the averaging interval, so a five-minute
 * observation is a mean of the five minutes before its label and an hourly one
 * is a mean of the hour before it.** Nothing in the response says so; it is
 * measured, in `tests/coagmet.test.js`, from two real captures — the hourly
 * value at 21:00 is the mean of the twelve five-minute values labelled 20:05
 * through 21:00 to the last decimal place, and is not the mean of the twelve
 * labelled 20:00 through 20:55. So a record's best single instant is the
 * *centre* of its interval, which is what `timeMs` carries: two and a half
 * minutes before the label at five minutes, and **thirty minutes before it at
 * an hour**. Scoring an hourly CoAgMet station at its label would be half an
 * hour out — the FEMS mistake in a different costume, and past the 10-minute
 * default pairing tolerance. `intervalEnd` keeps the label the service
 * actually sent.
 *
 * **A window before the station existed answers 200 with rows, and so does a
 * dead sensor, and so does asking an hourly-only station for five-minute
 * data.** The rows have `""` for the time and -999 for every value. Absence,
 * downtime and a wrong product are one reply, so a blank row is counted as
 * absence and never becomes an observation, and a station whose every row is
 * blank is a refusal rather than a quiet calm week. The third of those is the
 * one that will catch a careless run: 28 stations report hourly only, and
 * asking them for `5min` returns a full set of blanks rather than an error —
 * which is why `station()` is consulted for the station's own timestep and the
 * product is chosen from it.
 *
 * **An unknown station is the one absence this service states.** It answers
 * `400 {"error":"Bad Request: Unknown station id zzz99"}`, which is better than
 * both other readers manage, and it is mapped to `unknown-station` rather than
 * being lost in a generic HTTP failure.
 *
 * **-999 is a number.** Missing values are the sentinel, not null and not an
 * empty string, so a reader that only checks for null will average -999 into a
 * wind speed and report a hurricane blowing backwards. Every field is checked
 * against it before it is checked for anything else, and a -999 wind is
 * counted as missing rather than as an implausible measurement, because those
 * are different facts about the sensor.
 *
 * **Calm carries a direction, and it is a fill.** A row with `windSpeed 0.0`
 * reports `windDir 0.0` — while its `gustDir` on the same row keeps a real
 * azimuth, which is how you can tell the 0.0 is not a north wind. The record
 * is marked `calm` and given no direction, exactly as the other readers do.
 * The censoring beneath it is larger than a rounding: the two anemometers this
 * network uses start at 1.0 m/s (R.M. Young 05103) and 0.5 m/s (03002), and
 * the response does not say which mast has which, so `COAGMET_INSTRUMENT` uses
 * the larger of the two as a **ceiling on what a calm could have been** and the
 * larger of the two speed tolerances. Both are the safe direction and neither
 * is a station-specific fact.
 *
 * **Units and timezone are in the response, and both are negotiable.** The
 * default is mph and MST; `units=m` and `tz=utc` are asked for on every request
 * here — metric because CoAgMet stores m/s and converts *to* mph, so US units
 * are a rounding this reader would then have to undo, and UTC because a JSON
 * timestamp carries no offset field of its own and `2026-03-08T02:30` in
 * Colorado local time is a question about daylight saving that the service's
 * own documentation declines to guarantee. The reply states what it did, and
 * everything here is parsed from that statement rather than from the request:
 * a response that comes back in `us` or on the MST clock is refused, not
 * converted on an assumption.
 *
 * What this reader deliberately does not do: expose the raw (non-QC) product.
 * The documentation says to append `_raw` to the product name, and
 * `5min_raw/gun01.json` answers `"which":"qc"` — so either the URL is wrong or
 * the label is, and until that is settled a `raw: true` option here would be a
 * claim this repository cannot support. Every record carries the `which` the
 * response declared, and `qcChecked` is that and nothing more: CoAgMet's QC is
 * a daily pass over the whole network that blanks bad data, not a per-row
 * verdict, so a `true` here means "the archive says this product has been
 * through the pass", never "this observation was checked and passed".
 */

"use strict";

/** Where the service lives. No account, no key, no rate limit published. */
const COAGMET_ROOT = "https://coagmet.colostate.edu/data";

/** How many times a request that never reached the service is sent again. */
const DEFAULT_RETRIES = 2;

/** The value CoAgMet writes where there is no measurement. */
const MISSING = -999;

/**
 * How far below zero a value has to be before it is the sentinel rather than a
 * measurement. -999 is what the documentation states and what every capture
 * shows; the band exists so that a float that has been through a unit
 * conversion somewhere still reads as missing rather than as a wind blowing at
 * a thousand metres a second in reverse.
 */
const MISSING_CEILING = -900;

/**
 * What the archive rounds to before anybody reads it: two decimal places of a
 * metre per second, one of a degree.
 *
 * This is an order of magnitude finer than either RAWS reader — FEMS gives
 * whole miles per hour — so it is not the floor under a CoAgMet score. The
 * instrument below is.
 */
const COAGMET_QUANTISATION = { speedStepMps: 0.01, dirStepDeg: 0.1 };

/**
 * The two anemometers the network publishes, and what they are allowed.
 *
 * From the manufacturer's specifications for the sensors named on CoAgMet's
 * station description page. The station metadata does **not** say which mast
 * carries which, so nothing here may be attached to a station: this is a
 * statement about the network's hardware and it is kept as one.
 */
const ANEMOMETERS = {
  "rm-young-05103": {
    name: "R.M. Young 05103 Wind Monitor",
    speedToleranceMps: 0.3,
    dirToleranceDeg: 3,
    speedThresholdMps: 1.0
  },
  "rm-young-03002": {
    name: "R.M. Young 03002 Wind Sentry",
    speedToleranceMps: 0.5,
    dirToleranceDeg: 5,
    speedThresholdMps: 0.5
  }
};

/**
 * What a CoAgMet wind is allowed to be wrong by, as far as it is known.
 *
 * The worse of the two sensors on every line, because the response does not say
 * which one answered. Reading a 03002's tolerance onto a 05103 mast overstates
 * the slack, which makes a candidate harder to call significant rather than
 * easier — the safe direction, and the same reasoning that leaves the RAWS
 * readers a null rather than the airport's number.
 *
 * `calmCeilingMps` is the larger *starting threshold*: below 1.0 m/s a 05103's
 * cups may not turn at all, so a reported 0.0 means somewhere in 0-1.0 m/s.
 * That is a real censoring at the bottom of a network whose whole value here is
 * light near-ground wind, and `verify.js` reports what it could have done to
 * the bias without subtracting it from anything.
 */
const COAGMET_INSTRUMENT = {
  calmCeilingMps: ANEMOMETERS["rm-young-05103"].speedThresholdMps,
  speedToleranceMps: ANEMOMETERS["rm-young-03002"].speedToleranceMps,
  dirToleranceDeg: ANEMOMETERS["rm-young-03002"].dirToleranceDeg
};

/** Nothing on Earth's surface blows this hard; past it the row is broken. */
const MAX_PLAUSIBLE_MPS = 120;

/**
 * Colorado, with a degree of slack on every side.
 *
 * CoAgMet publishes no state field. Every station in it is in Colorado by
 * construction — it is the Colorado Agricultural Meteorological Network, and
 * the only other network id in the catalogue is Northern Water, a Colorado
 * district — and every one of the 129 published positions is inside the state.
 * `state` is therefore derived from the position and left null outside the box,
 * so that the day the network crosses a border the answer changes rather than
 * quietly staying "CO".
 */
const COLORADO = { south: 36.5, north: 41.5, west: -109.6, east: -101.5 };

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** True for the sentinel, for null, and for anything that is not a number. */
function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "number" || !isFinite(value)) return true;
  return value <= MISSING_CEILING;
}

/**
 * A bearing brought into [0, 360), without touching one that is already there.
 *
 * `x % 360` on a value in range is not the identity in floating point — 189.1
 * comes back 189.10000000000002 — and a reader comparing a parsed direction
 * with the number printed in the response should not have to know that.
 */
function inCircle(deg) {
  if (deg >= 0 && deg < 360) return deg;
  return ((deg % 360) + 360) % 360;
}

/** `2026-08-01T20:00` in the requested zone, which is the only format accepted. */
function stamp(when) {
  const ms = when instanceof Date ? when.getTime() : Number(when);
  if (!isFinite(ms)) throw fail("bad-window", "a window bound is not a time");
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 16);
}

/**
 * The product name for a station's own reporting interval.
 *
 * 300 s stations answer `5min`; 3600 s stations answer `hourly`, and answer
 * `5min` with a full set of blank rows. Anything else is a catalogue this
 * reader has not seen and is refused rather than rounded to the nearer product.
 */
function frequencyFor(timestepSeconds) {
  if (timestepSeconds === 300) return "5min";
  if (timestepSeconds === 3600) return "hourly";
  throw fail("bad-timestep",
    "CoAgMet reports at 300 or 3600 seconds and this station says " +
    JSON.stringify(timestepSeconds) + "; there is no product for it");
}

/** The catalogue URL. `inactive=yes` adds the stations that have stopped. */
function metadataUrl(opts) {
  const o = opts || {};
  const params = ["units=m"];
  if (o.inactive) params.push("inactive=yes");
  return COAGMET_ROOT + "/metadata.json?" + params.join("&");
}

/**
 * The observation URL, for one station or for several.
 *
 * The multi-station form shares one time axis between every station in it,
 * which is what makes a thirty-station run one request instead of thirty.
 */
function observationsUrl(query) {
  const q = query || {};
  const ids = Array.isArray(q.stationIds) ? q.stationIds : [q.stationId];
  const clean = ids.filter(function (id) { return typeof id === "string" && id !== ""; });
  if (!clean.length) throw fail("bad-query", "no station id to ask CoAgMet about");
  const frequency = q.frequency || "5min";
  const params = [
    "from=" + stamp(q.start),
    "to=" + stamp(q.end),
    "units=m",
    "tz=utc"
  ];
  if (clean.length === 1) {
    return COAGMET_ROOT + "/" + frequency + "/" + encodeURIComponent(clean[0]) +
      ".json?" + params.join("&");
  }
  return COAGMET_ROOT + "/" + frequency + ".json?stations=" +
    clean.map(encodeURIComponent).join(",") + "&" + params.join("&");
}

/**
 * Every station in the catalogue, in the shape `synoptic.js` produces.
 *
 * `anemometerHeight` is metres because the request asked for metric units; in
 * the service's default US units the same field is feet, and the two are not
 * labelled differently. The response says which it is and this refuses anything
 * that is not `m`, because a 6.6 read as 6.6 m instead of 6.6 ft is a station
 * three times higher than it is and still a plausible mast.
 *
 * A published height of 0 is not a height. Three active stations carry it, and
 * an anemometer at ground level is not a thing; it is the catalogue's way of
 * saying the height is unrecorded, so it becomes null and
 * `tools/score-wind.js` refuses to height-match the station rather than
 * scoring it at the surface.
 */
function parseStations(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw fail("bad-metadata", "the CoAgMet catalogue is not an object keyed by station id");
  }
  const ids = Object.keys(json);
  if (!ids.length) throw fail("bad-metadata", "the CoAgMet catalogue is empty");
  return ids.map(function (id) {
    const s = json[id];
    if (!s || typeof s !== "object") throw fail("bad-station", id + " has no entry body");
    if (s.units !== "m") {
      throw fail("bad-unit",
        id + " came back in " + JSON.stringify(s.units) + " units rather than \"m\"; " +
        "ask for units=m rather than converting feet that are not labelled as feet");
    }
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw fail("bad-station", id + " is not at a position on Earth");
    }
    const height = Number(s.anemometerHeight);
    const inColorado = lat >= COLORADO.south && lat <= COLORADO.north &&
      lon >= COLORADO.west && lon <= COLORADO.east;
    return {
      id: id,
      name: typeof s.name === "string" ? s.name : null,
      lat: lat,
      lon: lon,
      sensorHeightM: isFinite(height) && height > 0 ? height : null,
      elevationM: isFinite(Number(s.elevation)) ? Number(s.elevation) : null,
      demElevationM: null,
      network: typeof s.network === "string" ? s.network : null,
      status: typeof s.active === "string" ? s.active : null,
      state: inColorado ? "CO" : null,
      source: "coagmet",
      coagmet: {
        location: typeof s.location === "string" ? s.location : null,
        irrigation: typeof s.irrigation === "string" ? s.irrigation : null,
        timestepSeconds: isFinite(Number(s.timestep)) ? Number(s.timestep) : null,
        firstObs: typeof s.firstObs === "string" ? s.firstObs : null,
        lastObs: typeof s.lastObs === "string" ? s.lastObs : null,
        heightPublished: isFinite(height) ? height : null
      }
    };
  });
}

/**
 * The offset the response says its timestamps are on, in milliseconds.
 *
 * A CoAgMet JSON timestamp is `2026-08-01T20:00` with no zone on it, so
 * `Date.parse` would read it in whatever zone the machine running this happens
 * to be in — which is UTC on CI and something else on a laptop, and the
 * difference is a whole-hour scoring error that no test on CI would ever show.
 * The offset is taken from the response's own `tzOffset` and applied here.
 */
function offsetMsOf(json) {
  const raw = json.tzOffset;
  const m = typeof raw === "string" ? /^([+-])(\d{2}):(\d{2})$/.exec(raw) : null;
  if (!m) {
    throw fail("bad-timezone",
      "CoAgMet did not say what zone its timestamps are on (tzOffset " +
      JSON.stringify(raw) + "), and its timestamps carry no offset of their own");
  }
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return (m[1] === "-" ? -1 : 1) * minutes * 60000;
}

function requireMetric(json) {
  if (json.units !== "m") {
    throw fail("bad-unit",
      "CoAgMet answered in " + JSON.stringify(json.units) + " units rather than \"m\"; " +
      "its wind speeds would be miles per hour and every one of them is a plausible " +
      "metre per second");
  }
}

function timestepOf(json) {
  const step = Number(json.timestep);
  if (!isFinite(step) || step <= 0) {
    throw fail("bad-observations",
      "CoAgMet did not say how long its averaging interval is (timestep " +
      JSON.stringify(json.timestep) + "), and the timestamp is the end of it");
  }
  return step;
}

function columnFor(body, key, id, length) {
  const column = body[key];
  if (column === undefined) return null;
  if (!Array.isArray(column)) {
    throw fail("bad-observations", id + " reports " + key + " as something other than an array");
  }
  if (column.length !== length) {
    throw fail("bad-observations",
      id + " reports " + column.length + " " + key + " values against " + length +
      " timestamps; the columns do not line up and nothing here will guess which way");
  }
  return column;
}

/**
 * Turn one station's parallel arrays into records.
 *
 * `body` is the response itself for a single-station reply and the station's
 * sub-object for a multi-station one; the time axis, the units and the zone
 * always come from the response.
 */
function readStation(json, body, id, opts) {
  const o = opts || {};
  const offsetMs = offsetMsOf(json);
  const stepMs = timestepOf(json) * 1000;
  const which = typeof json.which === "string" ? json.which : null;
  const times = json.time;
  if (!Array.isArray(times)) {
    throw fail("bad-observations", (id || "a station") + " came back with no time axis");
  }

  const speeds = columnFor(body, "windSpeed", id, times.length);
  if (!speeds) {
    throw fail("bad-observations", (id || "a station") + " reports no windSpeed column");
  }
  const directions = columnFor(body, "windDir", id, times.length);
  const gusts = columnFor(body, "gustSpeed", id, times.length);

  const records = [];
  const rejected = [];
  let blank = 0;

  for (let i = 0; i < times.length; i++) {
    const label = times[i];
    if (typeof label !== "string" || label === "") {
      // The reply to a window before the station existed, to a dead sensor, and
      // to asking an hourly station for five-minute data. All three are absence.
      blank++;
      rejected.push({ time: null, code: "blank", reason: "a row with no timestamp and no values" });
      continue;
    }
    const endMs = Date.parse(label + "Z") - offsetMs;
    if (Number.isNaN(endMs)) {
      rejected.push({ time: label, code: "bad-time", reason: "unreadable timestamp" });
      continue;
    }
    // The label ends the averaging interval; the centre is the instant the mean
    // is about. Thirty minutes of it on the hourly product.
    const startMs = endMs - stepMs;
    const timeMs = endMs - stepMs / 2;
    const time = new Date(timeMs).toISOString();

    const speed = speeds[i];
    if (isMissing(speed)) {
      blank++;
      rejected.push({ time: time, code: "no-wind", reason: "the observation reports no wind speed" });
      continue;
    }
    if (speed < 0 || speed > MAX_PLAUSIBLE_MPS) {
      rejected.push({ time: time, code: "implausible", reason: speed.toFixed(1) + " m/s" });
      continue;
    }

    const calm = speed === 0;
    const rawDir = directions ? directions[i] : null;
    const dir = isMissing(rawDir) ? null : inCircle(rawDir);
    const rawGust = gusts ? gusts[i] : null;
    const gust = isMissing(rawGust) || rawGust < 0 || rawGust > MAX_PLAUSIBLE_MPS
      ? null
      : rawGust;

    records.push({
      stationId: id,
      time: time,
      timeMs: timeMs,
      speedMps: speed,
      fromDeg: calm ? null : dir,
      calm: calm,
      gustMps: gust,
      quality: null,
      // CoAgMet's QC is a nightly pass over the network that blanks bad data,
      // not a verdict on this row. This says which product answered and no more.
      qcChecked: which === "qc",
      raw: null,
      intervalEnd: new Date(endMs).toISOString(),
      intervalStartMs: startMs,
      intervalEndMs: endMs,
      averagingSeconds: stepMs / 1000
    });
  }

  records.sort(function (a, b) { return a.timeMs - b.timeMs; });

  if (!o.allowEmpty && times.length && blank === times.length) {
    throw fail("no-observations",
      "CoAgMet answered for station " + id + " with " + blank +
      " blank rows and nothing else, which is its reply to a window before the " +
      "station existed, to a dead sensor, and to asking an hourly-only station " +
      "for five-minute data");
  }

  return {
    stationId: id,
    which: which,
    frequency: typeof json.frequency === "string" ? json.frequency : null,
    averagingSeconds: stepMs / 1000,
    records: records,
    rejected: rejected,
    counts: {
      seen: times.length,
      kept: records.length,
      rejected: rejected.length,
      blank: blank,
      calm: records.filter(function (r) { return r.calm; }).length,
      withDirection: records.filter(function (r) { return r.fromDeg !== null; }).length
    }
  };
}

/** One station's observations, from either response shape. */
function parseObservations(json, opts) {
  const o = opts || {};
  if (!json || typeof json !== "object") {
    throw fail("bad-observations", "CoAgMet answered with something that is not an object");
  }
  requireMetric(json);
  if (Array.isArray(json.stations)) {
    const id = o.stationId || json.stations[0];
    const body = json[id];
    if (!body || typeof body !== "object") {
      throw fail("unknown-station",
        "CoAgMet answered a multi-station request without station " + id + " in it");
    }
    return readStation(json, body, id, o);
  }
  const id = typeof json.station === "string" ? json.station : o.stationId;
  if (!id) throw fail("bad-observations", "CoAgMet did not say which station answered");
  return readStation(json, json, id, o);
}

/** Every station in a multi-station response, keyed by id. */
function parseTimeseries(json, opts) {
  const o = opts || {};
  requireMetric(json);
  const ids = Array.isArray(json.stations)
    ? json.stations
    : (typeof json.station === "string" ? [json.station] : []);
  if (!ids.length) throw fail("bad-observations", "CoAgMet named no stations in its reply");
  const out = {};
  ids.forEach(function (id) {
    const body = Array.isArray(json.stations) ? json[id] : json;
    if (!body || typeof body !== "object") {
      throw fail("bad-observations", "CoAgMet named station " + id + " and then sent no columns for it");
    }
    out[id] = readStation(json, body, id, Object.assign({}, o, { allowEmpty: true }));
  });
  return out;
}

/**
 * A reader with the same three methods as `synoptic.js` and `fems.js`.
 *
 * `fetch` is injectable so the tests run against the captured fixtures rather
 * than against Fort Collins.
 */
function createCoagmetSource(opts) {
  const o = opts || {};
  const doFetch = o.fetch || globalThis.fetch;
  const includeInactive = !!o.inactive;
  const retries = o.retries === undefined ? DEFAULT_RETRIES : o.retries;
  const sleep = o.sleep || function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };
  let catalogue = null;
  const series = new Map();

  /**
   * The reply, or a refusal — never a dropped socket read as an empty station.
   *
   * A scoring run asks this service for one station, spends a minute solving
   * that station's domain, and asks for the next. CoAgMet closes an idle
   * keep-alive connection inside that minute and Node hands the closed socket
   * to the next request, which fails as `UND_ERR_SOCKET` before a byte is
   * sent. It killed a 32-station run at the third station. A request that
   * never reached the service is retried, the way `archive.js` retries one;
   * an answer, including a refusal, is not.
   */
  async function fetched(url, what) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await doFetch(url, { headers: { accept: "application/json" } });
      } catch (err) {
        if (attempt > retries) {
          throw fail("network", "no response from CoAgMet for " + what + " after " +
            attempt + " attempt(s): " + (err && err.message ? err.message : String(err)),
            { url: url, cause: err });
        }
        await sleep(500 * attempt);
      }
    }
  }

  async function getJson(url, what) {
    if (typeof doFetch !== "function") {
      throw fail("no-fetch", "no fetch available to read " + what + " from CoAgMet");
    }
    const res = await fetched(url, what);
    const text = await res.text();
    if (!res.ok) {
      // The one absence this service states out loud, and the only reader here
      // that gets to tell an unknown station apart from an empty one.
      if (/unknown station/i.test(text)) {
        throw fail("unknown-station", "CoAgMet does not know that station: " + text.trim(), {
          status: res.status
        });
      }
      throw fail("http-error",
        "CoAgMet answered " + res.status + " for " + what + ": " + text.slice(0, 200), {
          status: res.status
        });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw fail("bad-json",
        "CoAgMet answered " + what + " with " + text.length + " bytes that are not JSON: " +
        (err && err.message ? err.message : String(err)));
    }
  }

  async function catalogueOf() {
    if (!catalogue) {
      const json = await getJson(metadataUrl({ inactive: includeInactive }), "the station catalogue");
      catalogue = new Map();
      parseStations(json).forEach(function (s) { catalogue.set(s.id.toLowerCase(), s); });
    }
    return catalogue;
  }

  /**
   * A station by id, in whatever case the caller had it in.
   *
   * CoAgMet ids are lower case where every other network here is upper, and
   * `tools/score-wind.js` upper-cases the ids on its command line because a
   * METAR id is upper case on the ticket and lower case in a hurry. Keying the
   * catalogue case-insensitively is the cheaper half of that argument: the
   * published id is what the record carries, and `GUN01` finds `gun01` instead
   * of reading as a station that does not exist.
   */
  async function stationOf(id) {
    const found = (await catalogueOf()).get(String(id).toLowerCase());
    if (!found) {
      throw fail("unknown-station", "CoAgMet has no station " + JSON.stringify(id) +
        " in its catalogue");
    }
    return found;
  }

  return {
    /**
     * The catalogue, filtered by whatever the caller named.
     *
     * There is no search endpoint — the whole catalogue is one 50 KB request —
     * so the filtering happens here, on the station id, the name and the town.
     * A string filters on those three; the `{state, status, network}` form is
     * the one `tools/station-survey.js` sends to every catalogue, and a state
     * that is not Colorado comes back empty rather than ignored.
     */
    search: async function (query) {
      const all = Array.from((await catalogueOf()).values());
      if (query === undefined || query === null || query === "") return all;
      if (typeof query !== "object") {
        const q = String(query).trim().toLowerCase();
        return all.filter(function (s) {
          return s.id.toLowerCase().indexOf(q) >= 0 ||
            (s.name || "").toLowerCase().indexOf(q) >= 0 ||
            (s.coagmet.location || "").toLowerCase().indexOf(q) >= 0;
        });
      }
      const states = query.state
        ? String(query.state).toUpperCase().split(",").map(function (x) { return x.trim(); })
        : null;
      const network = query.network ? String(query.network).toLowerCase() : null;
      return all.filter(function (s) {
        if (states && states.indexOf(s.state) < 0) return false;
        if (query.status && s.status !== String(query.status)) return false;
        if (network && (s.coagmet.network || "").toLowerCase() !== network) return false;
        return true;
      });
    },

    station: async function (id) {
      return await stationOf(id);
    },

    /**
     * One station's wind over a window.
     *
     * The product comes from the station's own timestep rather than from the
     * caller, because asking an hourly-only station for five-minute data is
     * answered with blank rows rather than with an error.
     */
    observations: async function (id, window) {
      const w = window || {};
      const station = await stationOf(id);
      const frequency = frequencyFor(station.coagmet.timestepSeconds);
      // The catalogue's id, not the caller's. The lookup above accepts any
      // case; the service does not — `5min/GUN01.json` comes back as the bare
      // string "Invlid request" with no JSON and no error field in it.
      const url = observationsUrl({
        stationId: station.id,
        start: w.start,
        end: w.end,
        frequency: frequency
      });
      const cached = series.get(url);
      if (cached) return cached;
      const json = await getJson(url, "observations for " + station.id);
      const read = parseObservations(json, { stationId: station.id });
      series.set(url, read);
      return read;
    }
  };
}

module.exports = {
  COAGMET_ROOT,
  MISSING,
  COAGMET_QUANTISATION,
  COAGMET_INSTRUMENT,
  ANEMOMETERS,
  metadataUrl,
  observationsUrl,
  frequencyFor,
  parseStations,
  parseObservations,
  parseTimeseries,
  createCoagmetSource
};
