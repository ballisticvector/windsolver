"use strict";

/**
 * The U.S. Climate Reference Network, read for its 1.5 m wind.
 *
 * Every other observation source in this project measures *above* the layer the
 * product is about: FEMS RAWS at 6.1 m, ASOS at 8.2-10.1 m, CoAgMet at 2-3 m.
 * USCRN's sub-hourly product publishes `WIND_1_5`, and the documentation says
 * what it is rather than leaving it to be inferred — "average wind speed, in
 * meters per second, at a height of 1.5 meters", over the five-minute period
 * which *ends* at the timestamp shown. That is the first instrument here
 * standing inside a 0-3 m field, and it is the reason this reader exists.
 *
 * It is also the thinnest observation in the project, and the shape of what it
 * does not say matters as much as what it does:
 *
 * - **There is no direction.** The sub-hourly product carries speed and a flag
 *   and nothing else about the wind, so a score against USCRN is a speed score.
 *   `fromDeg` is null on every record, `verify.js` already refuses to compute a
 *   direction or a vector error from a null bearing, and nothing here invents
 *   one. Measurement 16 put HRRR's direction RMSE at 2 m at 53-62 degrees, so
 *   the quantity this network cannot grade is the one most in doubt.
 * - **The catalogue's elevation is in feet.** `stations.tsv` has no units row;
 *   Boulder reads 9828, and HOMR gives the same station 9828 ft / 2995.6 m. The
 *   conversion happens here, once, with the foot named.
 * - **The catalogue's position is two decimal places, and it truncates.** HOMR
 *   puts Boulder at 40.0354 and the catalogue says 40.03, not 40.04. Two
 *   decimals is up to ~700 m of slack on which HRRR cell a station sits in and
 *   which pixel of 3DEP is under it, so `refine` fetches the four-decimal
 *   position from HOMR and every station says which of the two it carries.
 *
 * ## The flag trap
 *
 * The product's README says, in Note E, that these derived fields "may be
 * assumed to always be good (unflagged) data, except when they are reported as
 * missing". **In the file, that is false in both directions.** In one Boulder
 * station-year: 24 rows carry the missing sentinel `-99.00` with `WIND_FLAG=0`,
 * and 19 rows carry an ordinary-looking 0.88-1.93 m/s with `WIND_FLAG=3`,
 * which the same README defines as erroneous data.
 *
 * So a reader that trusts the flag alone ingests a -99 m/s wind, and a reader
 * that trusts the sentinel alone ingests nineteen winds NCEI has marked bad.
 * Both rules are needed, and this reader applies both: the sentinel is absence,
 * a flag of 3 is a rejection, and neither is ever a calm.
 *
 * ## What is read
 *
 *   stations   https://www.ncei.noaa.gov/pub/data/uscrn/products/stations.tsv
 *   sub-hourly https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01/
 *              <year>/CRNS0101-05-<year>-<STATE>_<LOCATION>_<VECTOR>.txt
 *   position   https://www.ncei.noaa.gov/access/homr/services/station/search
 *
 * No account, no key, no rate limit published. One station-year is a single
 * ~10 MB fixed-width file of 105,120 five-minute rows.
 */

const FEET_PER_M = 0.3048;
const MPH_PER_MPS = 2.2369362920544;

const NCEI_ROOT = "https://www.ncei.noaa.gov/pub/data/uscrn/products/";
const STATIONS_URL = NCEI_ROOT + "stations.tsv";
const SUBHOURLY_ROOT = NCEI_ROOT + "subhourly01/";
const HOMR_ROOT = "https://www.ncei.noaa.gov/access/homr/services/station/search";

/** The documented height of `WIND_1_5`, and the whole point of this source. */
const USCRN_HEIGHT_M = 1.5;

/** Five minutes, ending at the label. Note D of the product README. */
const AVERAGING_SECONDS = 300;

/**
 * The sentinel, and the line under it.
 *
 * Note C: "missing data are indicated by the lowest possible integer for a
 * given column format". `WIND_1_5` is six characters with two decimals, so the
 * marker is -99.00 and nothing legitimate is anywhere near it.
 */
const MISSING = -99;
const MISSING_CEILING = -98;

/** Nothing on Earth's surface blows this hard; past it the row is broken. */
const MAX_PLAUSIBLE_MPS = 120;

/** What the file rounds to before anybody reads it: 0.01 m/s, and no bearing. */
const USCRN_QUANTISATION = { speedStepMps: 0.01, dirStepDeg: null };

/**
 * The anemometer USCRN documents for its wind measurement.
 *
 * Met One Instruments 014A, from the network's own sensor description at
 * `documentation/site/sensors/wind/Descriptions/Anemometer.pdf`. The accuracy
 * line reads "±0.25 mph or 1.5% FS" — 0.11 m/s or 0.67 m/s — and this takes the
 * larger, for the same reason `coagmet.js` takes the worse of two cups: a wider
 * tolerance makes a candidate harder to call significant rather than easier.
 */
const ANEMOMETER = {
  name: "Met One Instruments 014A cup anemometer",
  rangeMph: 100,
  startingThresholdMph: 1.0,
  accuracyMph: 0.25,
  accuracyFullScaleFraction: 0.015,
  distanceConstantFt: 15
};

/**
 * What a USCRN wind is allowed to be wrong by.
 *
 * `calmCeilingMps` is the cup's *starting threshold*, 1.0 mph = 0.447 m/s:
 * below it the cups may not turn at all, so a reported 0.00 means somewhere in
 * 0-0.447 m/s. On a 1.5 m mast in light wind that is not a rare corner — it is
 * the regime — so `verify.js` reports what the calms could have done to the
 * bias, and subtracts none of it.
 *
 * `dirToleranceDeg` is null because the product has no direction to be wrong
 * about, not because it is perfect.
 */
const USCRN_INSTRUMENT = {
  calmCeilingMps: ANEMOMETER.startingThresholdMph / MPH_PER_MPS,
  speedToleranceMps:
    Math.max(ANEMOMETER.accuracyMph,
      ANEMOMETER.rangeMph * ANEMOMETER.accuracyFullScaleFraction) / MPH_PER_MPS,
  dirToleranceDeg: null
};

/**
 * The columns this reader takes, 1-based and inclusive, as the README gives
 * them.
 *
 * The file is fixed width — every line is 134 characters — and the fields are
 * also space separated, so both readings are available. This one parses the
 * columns and *checks* them against the split, because a silently shifted
 * column is a wind at the wrong station and a shifted split is a wind that is
 * really a soil temperature. Neither would throw on its own.
 */
const COLUMNS = {
  wban: [1, 5],
  utcDate: [7, 14],
  utcTime: [16, 19],
  longitude: [42, 48],
  latitude: [50, 56],
  wind: [127, 132],
  windFlag: [134, 134]
};

const LINE_LENGTH = 134;
const FIELD_COUNT = 23;
const WIND_FIELD_INDEX = 21;
const WIND_FLAG_FIELD_INDEX = 22;

/** The catalogue's header, verbatim. A different one is a different file. */
const STATION_COLUMNS = [
  "WBAN", "COUNTRY", "STATE", "LOCATION", "VECTOR", "NAME", "LATITUDE",
  "LONGITUDE", "ELEVATION", "STATUS", "COMMISSIONING", "CLOSING", "OPERATION",
  "PAIRING", "NETWORK", "STATION_ID"
];

/** Two decimal places, so the published point is within half a step of truth. */
const CATALOGUE_POSITION_STEP_DEG = 0.01;

/** How far a HOMR position may sit from the catalogue's before it is refused. */
const POSITION_AGREEMENT_DEG = 0.011;

const DEFAULT_RETRIES = 2;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function slice(line, span) {
  return line.slice(span[0] - 1, span[1]).trim();
}

/** True for the sentinel, for null, and for anything that is not a number. */
function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "number" || !isFinite(value)) return true;
  return value <= MISSING_CEILING;
}

/** Metres of ground per degree, at a latitude, for the position slack. */
function positionUncertaintyM(lat) {
  const half = CATALOGUE_POSITION_STEP_DEG / 2;
  const north = half * 111320;
  const east = half * 111320 * Math.cos(lat * Math.PI / 180);
  return Math.round(Math.sqrt(north * north + east * east));
}

/** `CO_Boulder_14_W`, which is the only name the data files are keyed by. */
function fileStemOf(state, location, vector) {
  return [state, location, vector].join("_").replace(/\s+/g, "_");
}

function stationsUrl() {
  return STATIONS_URL;
}

/** One station-year of five-minute records. */
function subhourlyUrl(station, year) {
  const stem = typeof station === "string" ? station : station.uscrn.fileStem;
  const y = String(year);
  if (!/^\d{4}$/.test(y)) {
    throw fail("bad-request", "a USCRN year is four digits, not " + JSON.stringify(year));
  }
  return SUBHOURLY_ROOT + y + "/CRNS0101-05-" + y + "-" + stem + ".txt";
}

function homrUrl(wban) {
  return HOMR_ROOT + "?qid=WBAN:" + encodeURIComponent(String(wban)) +
    "&headersOnly=false";
}

/**
 * The catalogue, as stations.
 *
 * `stations.tsv` is the whole network in one 37 KB tab-separated file, closed
 * stations included. The header is checked against `STATION_COLUMNS` rather
 * than trusted by position, because the columns that matter here — the
 * elevation with no units on it, and the two-decimal position — are exactly the
 * ones a silent reordering would make wrong without making anything throw.
 */
function parseStations(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw fail("bad-metadata", "the USCRN catalogue is empty");
  }
  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
  const header = lines[0].split("\t").map(function (h) { return h.trim(); });
  if (header.join(",") !== STATION_COLUMNS.join(",")) {
    throw fail("bad-metadata",
      "stations.tsv is not the catalogue this reader knows: its header is " +
      JSON.stringify(header.join(",")) + " rather than " +
      JSON.stringify(STATION_COLUMNS.join(",")) + "; read the new columns rather " +
      "than assuming the old positions");
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split("\t");
    if (f.length !== STATION_COLUMNS.length) {
      throw fail("bad-station", "line " + (i + 1) + " of the USCRN catalogue has " +
        f.length + " fields, not " + STATION_COLUMNS.length);
    }
    const row = {};
    STATION_COLUMNS.forEach(function (name, n) { row[name] = f[n].trim(); });

    const lat = Number(row.LATITUDE);
    const lon = Number(row.LONGITUDE);
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 ||
        lon < -180 || lon > 180) {
      throw fail("bad-station", row.WBAN + " is not at a position on Earth");
    }
    const feet = Number(row.ELEVATION);

    out.push({
      id: row.WBAN,
      name: row.NAME || (row.LOCATION + " " + row.VECTOR),
      lat: lat,
      lon: lon,
      // Documented, not inferred, and the same for every station in the network.
      sensorHeightM: USCRN_HEIGHT_M,
      // The catalogue has no units row. These are feet: Boulder's 9828 is
      // 2995.6 m in HOMR, which is 9828 x 0.3048.
      elevationM: isFinite(feet) ? feet * FEET_PER_M : null,
      demElevationM: null,
      network: row.NETWORK || null,
      status: row.OPERATION || null,
      state: row.STATE || null,
      source: "uscrn",
      uscrn: {
        wban: row.WBAN,
        stationId: row.STATION_ID || null,
        country: row.COUNTRY || null,
        location: row.LOCATION,
        vector: row.VECTOR,
        siteName: row.NAME || null,
        commissioning: row.COMMISSIONING || null,
        closing: row.CLOSING || null,
        commissionStatus: row.STATUS || null,
        elevationFeet: isFinite(feet) ? feet : null,
        fileStem: fileStemOf(row.STATE, row.LOCATION, row.VECTOR),
        sensorHeightSource: "product specification: WIND_1_5 is at 1.5 m",
        positionSource: "catalogue",
        positionResolutionDeg: CATALOGUE_POSITION_STEP_DEG,
        positionUncertaintyM: positionUncertaintyM(lat)
      }
    });
  }
  if (!out.length) throw fail("bad-metadata", "the USCRN catalogue has no stations in it");
  return out;
}

/**
 * The four-decimal position HOMR holds for a WBAN.
 *
 * Returned rather than applied: the caller decides whether a position that
 * disagrees with the catalogue is a better number or a different station.
 */
function parseHomrStation(json) {
  const stations = json && json.stationCollection && json.stationCollection.stations;
  if (!Array.isArray(stations) || !stations.length) {
    throw fail("unknown-station", "HOMR knows no station with that identifier");
  }
  const loc = stations[0].location || {};
  const pair = Array.isArray(loc.latLonPairs) && loc.latLonPairs.length
    ? loc.latLonPairs[0] : null;
  const lat = pair ? Number(pair.latitude_dec) : NaN;
  const lon = pair ? Number(pair.longitude_dec) : NaN;
  if (!isFinite(lat) || !isFinite(lon)) {
    throw fail("bad-metadata", "HOMR gave no decimal position for that station");
  }
  const ground = (loc.elevations || []).filter(function (e) {
    return e && e.elevationType === "GROUND";
  })[0];
  const metres = ground ? Number(ground.elevationMeters) : NaN;
  return {
    lat: lat,
    lon: lon,
    elevationM: isFinite(metres) ? metres : null,
    precision: pair.precision || null,
    ncdcStnId: stations[0].ncdcStnId || null
  };
}

/**
 * One station-year of `WIND_1_5`.
 *
 * `opts.wban` names the station the caller believes it asked for, and a line
 * from a different one is refused rather than merged. `opts.startMs`/`endMs`
 * bound the interval end, inclusive of the start and exclusive of the end, so
 * that a day is a day and not a day and one row.
 */
function parseSubhourly(text, opts) {
  const o = opts || {};
  if (typeof text !== "string") {
    throw fail("bad-observations", "USCRN sub-hourly data is text, not " + typeof text);
  }
  // NCEI answers a station-year it does not have with HTTP 200 and an HTML 404
  // page. It put seven malformed lines of a "data file" into the ASOS
  // one-minute sample before anybody noticed; it does not get to do it twice.
  if (/^\s*</.test(text)) {
    throw fail("not-data",
      "NCEI answered with markup rather than a record file, which is how it says " +
      "a station-year does not exist");
  }
  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
  if (!lines.length) throw fail("bad-observations", "the USCRN file has no rows in it");

  const records = [];
  const rejected = [];
  let blank = 0;
  let flagged = 0;
  const keepFlagged = !!o.keepFlagged;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = "line " + (i + 1);
    if (line.length < LINE_LENGTH) {
      throw fail("bad-observations", where + " of the USCRN file is " + line.length +
        " characters, not " + LINE_LENGTH + "; the columns this reader takes are " +
        "fixed and a short line cannot be read as a wind");
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length !== FIELD_COUNT) {
      throw fail("bad-observations", where + " of the USCRN file splits into " +
        fields.length + " fields, not " + FIELD_COUNT);
    }
    const windText = slice(line, COLUMNS.wind);
    const flagText = slice(line, COLUMNS.windFlag);
    if (windText !== fields[WIND_FIELD_INDEX] || flagText !== fields[WIND_FLAG_FIELD_INDEX]) {
      throw fail("bad-observations", where + " of the USCRN file reads " +
        JSON.stringify(windText + " " + flagText) + " at the documented columns and " +
        JSON.stringify(fields[WIND_FIELD_INDEX] + " " + fields[WIND_FLAG_FIELD_INDEX]) +
        " as the last two fields; the layout has moved and no wind here is trustworthy");
    }

    const wban = slice(line, COLUMNS.wban);
    if (o.wban && wban !== String(o.wban)) {
      throw fail("wrong-station", where + " of the USCRN file is station " + wban +
        ", not " + o.wban);
    }

    const date = slice(line, COLUMNS.utcDate);
    const time = slice(line, COLUMNS.utcTime).padStart(4, "0");
    if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) {
      rejected.push({ time: null, code: "bad-time", reason: "unreadable UTC timestamp" });
      continue;
    }
    // UTC_DATE carries the label's own day, so 0000 on the 2nd is the interval
    // that ended at midnight — the README's "the last 5-minute period of the
    // previous day" is a statement about which air was measured, not an
    // instruction to move the date back.
    const endMs = Date.UTC(
      Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)),
      Number(time.slice(0, 2)), Number(time.slice(2, 4)));
    if (Number.isNaN(endMs)) {
      rejected.push({ time: null, code: "bad-time", reason: date + " " + time });
      continue;
    }
    if (o.startMs !== undefined && endMs < o.startMs) continue;
    if (o.endMs !== undefined && endMs >= o.endMs) continue;

    const startMs = endMs - AVERAGING_SECONDS * 1000;
    const timeMs = endMs - AVERAGING_SECONDS * 500;
    const stamp = new Date(timeMs).toISOString();

    const speed = Number(windText);
    if (isMissing(speed)) {
      blank++;
      rejected.push({ time: stamp, code: "no-wind", reason: "WIND_1_5 is " + windText });
      continue;
    }
    // Note E says a value that is present is good. Nineteen rows of one Boulder
    // station-year say otherwise, at 0.88-1.93 m/s with the flag that the same
    // README defines as erroneous. The flag wins.
    if (flagText !== "0") {
      flagged++;
      if (!keepFlagged) {
        rejected.push({
          time: stamp,
          code: "flagged",
          reason: "WIND_FLAG " + flagText + " (" +
            (flagText === "1" ? "field-length overflow" :
              flagText === "3" ? "erroneous data" : "undocumented") + ") on " +
            windText + " m/s"
        });
        continue;
      }
    }
    if (speed < 0 || speed > MAX_PLAUSIBLE_MPS) {
      rejected.push({ time: stamp, code: "implausible", reason: windText + " m/s" });
      continue;
    }

    records.push({
      stationId: wban,
      time: stamp,
      timeMs: timeMs,
      speedMps: speed,
      // The product has no direction. A null here is the difference between
      // "not measured" and "north", and `verify.js` scores neither a bearing
      // nor a vector error from it.
      fromDeg: null,
      calm: speed === 0,
      gustMps: null,
      quality: flagText,
      qcChecked: true,
      raw: null,
      intervalEnd: new Date(endMs).toISOString(),
      intervalStartMs: startMs,
      intervalEndMs: endMs,
      averagingSeconds: AVERAGING_SECONDS,
      sensorHeightM: USCRN_HEIGHT_M,
      // A reading under the cup's starting threshold is a bound, not a speed.
      belowThreshold: speed < USCRN_INSTRUMENT.calmCeilingMps
    });
  }

  records.sort(function (a, b) { return a.timeMs - b.timeMs; });

  return {
    stationId: o.wban ? String(o.wban) : (records.length ? records[0].stationId : null),
    averagingSeconds: AVERAGING_SECONDS,
    sensorHeightM: USCRN_HEIGHT_M,
    records: records,
    rejected: rejected,
    counts: {
      seen: lines.length,
      kept: records.length,
      rejected: rejected.length,
      blank: blank,
      flagged: flagged,
      calm: records.filter(function (r) { return r.calm; }).length,
      belowThreshold: records.filter(function (r) { return r.belowThreshold; }).length,
      withDirection: 0
    }
  };
}

/** Every UTC year a window touches, so a January run reads December too. */
function yearsBetween(startMs, endMs) {
  const first = new Date(startMs).getUTCFullYear();
  const last = new Date(endMs).getUTCFullYear();
  const out = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

function msOf(value, what) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw fail("bad-request", what + " is not a time: " + JSON.stringify(value));
  }
  return parsed;
}

/**
 * A USCRN source behind the same interface as `synoptic.js`, `fems.js` and
 * `coagmet.js`: `search`, `station`, `observations`.
 */
function createUscrnSource(opts) {
  const o = opts || {};
  const doFetch = o.fetch || globalThis.fetch;
  const retries = o.retries === undefined ? DEFAULT_RETRIES : o.retries;
  const refine = !!o.refine;
  const sleep = o.sleep || function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };
  let catalogue = null;
  const files = new Map();
  const refined = new Map();

  async function fetched(url, what) {
    if (typeof doFetch !== "function") {
      throw fail("no-fetch", "no fetch available to read " + what + " from NCEI");
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await doFetch(url, { headers: { accept: "text/plain,*/*" } });
      } catch (err) {
        if (attempt > retries) {
          throw fail("network", "no response from NCEI for " + what + " after " +
            attempt + " attempt(s): " + (err && err.message ? err.message : String(err)),
            { url: url, cause: err });
        }
        await sleep(500 * attempt);
      }
    }
  }

  async function getText(url, what) {
    const res = await fetched(url, what);
    const text = await res.text();
    if (!res.ok) {
      throw fail(res.status === 404 ? "not-found" : "http-error",
        "NCEI answered " + res.status + " for " + what, { status: res.status, url: url });
    }
    return text;
  }

  async function catalogueOf() {
    if (!catalogue) {
      const text = await getText(stationsUrl(), "the USCRN station catalogue");
      catalogue = new Map();
      parseStations(text).forEach(function (s) {
        catalogue.set(s.id.toLowerCase(), s);
        catalogue.set(s.uscrn.fileStem.toLowerCase(), s);
        if (s.uscrn.stationId) catalogue.set(s.uscrn.stationId.toLowerCase(), s);
      });
    }
    return catalogue;
  }

  /**
   * The catalogue's station, with HOMR's position on it when asked.
   *
   * A HOMR position more than a rounding step from the catalogue's is refused
   * rather than preferred: at that distance the two records are not obviously
   * the same mast, and a station in the wrong HRRR cell is a wind that looks
   * fine. The catalogue's own value truncates rather than rounds — Boulder is
   * 40.0354 in HOMR and 40.03 here — so the step, not half of it, is the test.
   */
  async function refinedStation(station) {
    if (!refine) return station;
    const key = station.id;
    if (refined.has(key)) return refined.get(key);
    let out = station;
    try {
      const text = await getText(homrUrl(station.uscrn.wban), "HOMR metadata for " + key);
      const homr = parseHomrStation(JSON.parse(text));
      const dLat = Math.abs(homr.lat - station.lat);
      const dLon = Math.abs(homr.lon - station.lon);
      if (dLat <= POSITION_AGREEMENT_DEG && dLon <= POSITION_AGREEMENT_DEG) {
        out = Object.assign({}, station, {
          lat: homr.lat,
          lon: homr.lon,
          elevationM: homr.elevationM === null ? station.elevationM : homr.elevationM,
          uscrn: Object.assign({}, station.uscrn, {
            positionSource: "homr",
            positionResolutionDeg: 0.0001,
            positionUncertaintyM: positionUncertaintyM(homr.lat) *
              (0.0001 / CATALOGUE_POSITION_STEP_DEG),
            cataloguePosition: { lat: station.lat, lon: station.lon },
            homrPrecision: homr.precision
          })
        });
      } else {
        out = Object.assign({}, station, {
          uscrn: Object.assign({}, station.uscrn, {
            positionSource: "catalogue",
            homrDisagreementDeg: Math.max(dLat, dLon)
          })
        });
      }
    } catch (err) {
      out = Object.assign({}, station, {
        uscrn: Object.assign({}, station.uscrn, {
          positionSource: "catalogue",
          homrError: err && err.message ? err.message : String(err)
        })
      });
    }
    refined.set(key, out);
    return out;
  }

  async function stationOf(id) {
    const found = (await catalogueOf()).get(String(id).trim().toLowerCase());
    if (!found) {
      throw fail("unknown-station", "USCRN has no station " + JSON.stringify(id) +
        " in its catalogue; name it by WBAN number or by its file stem, e.g. " +
        "94075 or CO_Boulder_14_W");
    }
    return await refinedStation(found);
  }

  async function yearText(station, year) {
    const url = subhourlyUrl(station, year);
    if (files.has(url)) return files.get(url);
    const text = await getText(url, station.id + " in " + year);
    files.set(url, text);
    return text;
  }

  return {
    search: async function (query) {
      const all = Array.from(new Set((await catalogueOf()).values()));
      if (query === undefined || query === null || query === "") return all;
      if (typeof query !== "object") {
        const q = String(query).trim().toLowerCase();
        return all.filter(function (s) {
          return s.id.toLowerCase().indexOf(q) >= 0 ||
            (s.name || "").toLowerCase().indexOf(q) >= 0 ||
            s.uscrn.fileStem.toLowerCase().indexOf(q) >= 0;
        });
      }
      const states = query.state
        ? String(query.state).toUpperCase().split(",").map(function (x) { return x.trim(); })
        : null;
      const network = query.network ? String(query.network).toUpperCase() : null;
      return all.filter(function (s) {
        if (states && states.indexOf(s.state) < 0) return false;
        if (network && (s.network || "").toUpperCase() !== network) return false;
        // "Operational"/"Closed" is the field a caller means by status here;
        // STATUS is the commissioning state and is kept under `uscrn`.
        if (query.status && s.status !== String(query.status)) return false;
        return true;
      });
    },

    station: async function (id) {
      return await stationOf(id);
    },

    /**
     * One station's wind over a window.
     *
     * The product is one file per station-year, so a window is read by fetching
     * the years it touches and filtering on the interval end. The files are
     * cached in the process because they are ~10 MB each and a scoring run asks
     * the same station for four separate days.
     */
    observations: async function (id, window) {
      const w = window || {};
      const station = await stationOf(id);
      const startMs = w.start === undefined ? undefined : msOf(w.start, "the window start");
      const endMs = w.end === undefined ? undefined : msOf(w.end, "the window end");
      if (startMs === undefined || endMs === undefined) {
        throw fail("bad-request",
          "USCRN is published as whole station-years, so a window needs both a " +
          "start and an end rather than reading a decade to answer for a day");
      }
      if (endMs <= startMs) {
        throw fail("bad-request", "the window ends before it starts");
      }

      const parts = [];
      for (const year of yearsBetween(startMs, endMs)) {
        let text;
        try {
          text = await yearText(station, year);
        } catch (err) {
          // A station-year before the station existed, or after it closed.
          if (err.code === "not-found") continue;
          throw err;
        }
        parts.push(parseSubhourly(text, {
          wban: station.uscrn.wban,
          startMs: startMs,
          endMs: endMs,
          keepFlagged: o.keepFlagged
        }));
      }
      if (!parts.length) {
        throw fail("no-observations", "USCRN has no station-year file for " + station.id +
          " over that window");
      }
      const records = [];
      const rejected = [];
      const counts = {
        seen: 0, kept: 0, rejected: 0, blank: 0, flagged: 0, calm: 0,
        belowThreshold: 0, withDirection: 0
      };
      parts.forEach(function (p) {
        p.records.forEach(function (r) { records.push(r); });
        p.rejected.forEach(function (r) { rejected.push(r); });
        Object.keys(counts).forEach(function (k) { counts[k] += p.counts[k]; });
      });
      records.sort(function (a, b) { return a.timeMs - b.timeMs; });
      // `seen` above counts every line of each year file; over a window the
      // honest denominator is what the window could have held.
      counts.seen = records.length + rejected.length;
      return {
        stationId: station.id,
        averagingSeconds: AVERAGING_SECONDS,
        sensorHeightM: USCRN_HEIGHT_M,
        records: records,
        rejected: rejected,
        counts: counts
      };
    }
  };
}

module.exports = {
  NCEI_ROOT,
  STATIONS_URL,
  SUBHOURLY_ROOT,
  HOMR_ROOT,
  MISSING,
  FEET_PER_M,
  USCRN_HEIGHT_M,
  AVERAGING_SECONDS,
  USCRN_QUANTISATION,
  USCRN_INSTRUMENT,
  ANEMOMETER,
  STATION_COLUMNS,
  COLUMNS,
  stationsUrl,
  subhourlyUrl,
  homrUrl,
  fileStemOf,
  parseStations,
  parseHomrStation,
  parseSubhourly,
  createUscrnSource
};
