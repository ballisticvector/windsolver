/**
 * Measured surface wind from FEMS, the Forest Service's own RAWS archive.
 *
 * `synoptic.js` reads the same stations and is better at the last few days.
 * What it cannot do on a free account is history: a window older than about six
 * days comes back `Account associated with this token does not have access to
 * the requested history`, and every question left open in
 * `docs/downscaling.md` — another season, another state, a station set chosen
 * for topographic position — needs a year at a time.
 *
 * FEMS (`fems.fs2c.usda.gov`) serves 2,088 RAWS back to about 2005, anonymously,
 * as bulk CSV: thirteen stations for a full year is 113,892 rows and 10 MB in
 * seven seconds. It is upstream of Synoptic rather than a competitor to it, and
 * where the two overlap they agree to the mile per hour — measured, in
 * `docs/observations.md`.
 *
 * This module produces the records `observations.js` produces, so `verify.js`
 * and `tools/score-wind.js` cannot tell which network fed them.
 *
 * Five things about this service that produce a plausible wrong number:
 *
 * **The timestamp is not the observation time, and it is not off by a fixed
 * amount either.** FEMS labels an observation with the *nearest* whole hour.
 * A RAWS transmits in a fixed GOES slot, and across eleven Colorado stations
 * those slots run from :08 to :58 — so the label is up to half an hour away
 * from the measurement, early for some stations and late for others.
 * `tools/score-wind.js` pairs on a 10-30 minute tolerance, which is smaller
 * than that, so a FEMS-fed run pairs some stations against the wrong model hour
 * and reports the diurnal cycle it thereby invents as a model error. Nothing in
 * the FEMS response says which minute a station transmits at, so this reader
 * takes the minutes as a calibration — `tools/fems-stations.js` measures them
 * against Synoptic inside its free window — and **refuses a station it has no
 * minute for** rather than treating the hour label as the truth. `hourBins:
 * true` is the deliberate opt-out, and it marks every record it produces.
 *
 * **An unknown station answers 200 with a blank row**, and so does an hour the
 * station was down, and so does a window in the future. Absence, downtime and
 * refusal are one reply — the same family as NOMADS' HTML-with-200 — so a blank
 * row is counted as absence and never becomes an observation, and a station
 * whose every row is blank is a refusal rather than a quiet calm week.
 *
 * **Units are in the column headings and nowhere else.** `WindSpeed(mph)` is
 * the only statement the response makes about what its numbers mean, `units=`
 * on the request is ignored, and the values are integers — so a 0 is a wind
 * below about a fifth of a metre per second and not a zero. The heading is
 * parsed and an unrecognised unit throws; nothing here assumes mph.
 *
 * **Calm carries a direction.** Unlike a METAR's 0/0, a FEMS row with
 * `WindSpeed 0` still reports the vane's last azimuth. At 0 whole mph the vane
 * is below its own threshold, so that azimuth is not evidence: the record is
 * marked `calm` and given no direction, exactly as the other two readers do.
 *
 * **The QC flags mean something undocumented.** `WSflag` and its family are 0,
 * 1 or 2 in the historical record and *empty* in the last few days, because QC
 * is a later pass — so a near-real-time FEMS observation is unchecked, which
 * every record says as `qcChecked` because an empty column and a `0` are both
 * "no flag" to a reader that only looks for a value. Nothing
 * published says what 1 and 2 are, so this reader keeps flagged rows, puts the
 * flag on the record and counts them, and drops them only when a caller names
 * the values to drop. Guessing that 2 means "bad" and silently shortening the
 * series would be a decision about the sample disguised as a parser detail.
 *
 * And one thing that is an assumption rather than a trap: **the metadata's
 * `elevation` carries no unit.** It is feet — it agrees to the foot with
 * Synoptic's published elevation at eight of the eleven stations checked, and
 * Kenosha Pass is not 10,200 m up — but FEMS does not say so, and if that ever
 * changes every station here moves 3 km into the sky. `verify.elevationCheck`
 * would catch it, which is the only reason this is tolerable.
 */

"use strict";

const FEMS_ROOT = "https://fems.fs2c.usda.gov/api/climatology";

/** The international foot, exactly 0.3048 m. */
const M_PER_FOOT = 0.3048;

/** Above this, an observation is a report of weather nobody should score against. */
const MAX_PLAUSIBLE_MPS = 60;

/**
 * What a RAWS observation is rounded to before anyone sees it.
 *
 * The same floor `synoptic.js` reports, arrived at from the other direction:
 * Synoptic converts the mph to three decimal places of metric, FEMS hands over
 * the whole mile per hour it was given.
 */
const RAWS_QUANTISATION = { speedStepMps: 0.44704, dirStepDeg: 1 };

/**
 * How many station ids may go in one request.
 *
 * Ninety-six ids in one GET is answered `400 Large requests must be sent as a
 * POST HTTP Protocol`; twenty in one request took ten seconds for thirty days.
 * The service refuses rather than truncating, which is the right failure, but a
 * run should not depend on discovering the limit — so the ids are batched, and
 * a batch is never quietly dropped.
 */
const MAX_STATIONS_PER_REQUEST = 20;

/** What the column headings are allowed to say, and what it means in SI. */
const SPEED_UNITS = {
  "mph": 0.44704,
  "mi/h": 0.44704,
  "m/s": 1,
  "mps": 1,
  "kph": 1 / 3.6,
  "km/h": 1 / 3.6,
  "kn": 0.514444,
  "knots": 0.514444
};

const DIRECTION_UNITS = ["degrees", "deg", "degree"];

/** The columns this reader cannot work without. */
const REQUIRED_COLUMNS = ["StationId", "DateTime", "ObservationType"];

/**
 * The row types FEMS emits, and which of them is a measurement.
 *
 * `O` is an observation. Everything else — and the empty string a dead hour
 * carries — is not, and is counted rather than parsed.
 */
const OBSERVED = "O";

const HOUR_MS = 3600 * 1000;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/**
 * The download URL for a set of stations over a window.
 *
 * Built rather than fetched, and exported, so the batching and the window
 * arithmetic are testable with no network.
 */
function weatherUrl(query) {
  const q = query || {};
  const ids = Array.isArray(q.stationIds) ? q.stationIds : [q.stationIds];
  const clean = ids.map(function (id) { return femsId(id); });
  if (!clean.length) throw fail("no-stations", "a weather request needs at least one station id");
  if (clean.length > MAX_STATIONS_PER_REQUEST) {
    throw fail("too-many-stations",
      clean.length + " stations in one request; FEMS answers more than about " +
      MAX_STATIONS_PER_REQUEST + " with `400 Large requests must be sent as a POST HTTP " +
      "Protocol`. Batch them rather than trimming the list.");
  }
  const url = new URL(FEMS_ROOT + "/download-weather");
  url.searchParams.set("stationIds", clean.join(","));
  url.searchParams.set("startDate", isoSecond(q.start, "start"));
  url.searchParams.set("endDate", isoSecond(q.end, "end"));
  url.searchParams.set("dataFormat", "csv");
  url.searchParams.set("dataset", "observation");
  return url.toString();
}

/** The metadata endpoint, and the query the public front-end uses. */
function metadataRequest(query) {
  const q = query || {};
  const all = q.all === true || q.stationIds === undefined;
  const ids = all
    ? undefined
    : (Array.isArray(q.stationIds) ? q.stationIds : [q.stationIds])
      .map(function (id) { return femsId(id); }).join(",");
  return {
    url: FEMS_ROOT + "/graphql",
    body: {
      query: "query($returnAll:Boolean,$ids:String){stationMetaData(returnAll:$returnAll," +
        "stationIds:$ids){_metadata{total_count} data{station_id wrcc_id station_name " +
        "latitude longitude elevation state agency network_name nesdis_id time_zone " +
        "period_record_start period_record_stop has_historic_data}}}",
      variables: { returnAll: all, ids: ids }
    }
  };
}

/** A FEMS station id is digits. Anything else is a name for one, not one. */
function femsId(id) {
  const text = String(id === undefined || id === null ? "" : id).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw fail("bad-station-id",
      JSON.stringify(id) + " is not a FEMS station id; FEMS keys on a number such as 53005. " +
      "A WRCC id or a Synoptic id needs the station map from tools/fems-stations.js.");
  }
  return text;
}

function isoSecond(when, where) {
  const date = when instanceof Date ? when : new Date(Date.parse(String(when)));
  if (Number.isNaN(date.getTime())) {
    throw fail("bad-time", where + " is not a time: " + JSON.stringify(when));
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * RFC 4180, as much of it as FEMS uses.
 *
 * Station names contain full stops and could contain a comma; the values are
 * bare. Splitting on commas works on every row in every capture taken so far,
 * which is exactly the kind of thing that stops being true once.
 */
function parseCsv(text) {
  if (typeof text !== "string") throw fail("bad-csv", "the CSV body is not text");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== "\"") { field += ch; continue; }
      if (text[i + 1] === "\"") { field += "\""; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === "\"") { quoted = true; started = true; continue; }
    if (ch === ",") { row.push(field); field = ""; started = true; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      continue;
    }
    field += ch;
    started = true;
  }
  if (started || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (quoted) throw fail("bad-csv", "the CSV body ends inside a quoted field");
  return rows;
}

/**
 * What the headings say the columns are.
 *
 * The unit is in the heading and nowhere else, so this is where a wind speed
 * stops being a number and becomes a quantity. An unknown unit throws rather
 * than defaulting to mph: the whole point of reading the heading is to not
 * assume what the request did not control.
 */
function parseHeader(cells) {
  const index = {};
  let speed = null;
  let gust = null;
  let direction = null;
  let gustDirection = null;
  for (let i = 0; i < cells.length; i++) {
    const name = cells[i].trim();
    index[name] = i;
    const match = /^([A-Za-z]+)\((.+)\)$/.exec(name);
    if (!match) continue;
    const what = match[1];
    const unit = match[2].trim().toLowerCase();
    if (what === "WindSpeed") speed = { column: i, unit: unit };
    if (what === "GustSpeed") gust = { column: i, unit: unit };
    if (what === "WindAzimuth") direction = { column: i, unit: unit };
    if (what === "GustAzimuth") gustDirection = { column: i, unit: unit };
  }
  for (const wanted of REQUIRED_COLUMNS) {
    if (index[wanted] === undefined) {
      throw fail("bad-csv", "the CSV has no " + wanted + " column: " + cells.join(","));
    }
  }
  if (!speed) throw fail("bad-csv", "the CSV has no WindSpeed column: " + cells.join(","));
  if (!direction) throw fail("bad-csv", "the CSV has no WindAzimuth column: " + cells.join(","));
  if (SPEED_UNITS[speed.unit] === undefined) {
    throw fail("bad-unit",
      "wind speed came back in " + JSON.stringify(speed.unit) + ", which this reader does not " +
      "know; add it rather than reading it as mph");
  }
  if (gust && SPEED_UNITS[gust.unit] === undefined) {
    throw fail("bad-unit", "gust speed came back in " + JSON.stringify(gust.unit));
  }
  if (DIRECTION_UNITS.indexOf(direction.unit) < 0) {
    throw fail("bad-unit",
      "wind direction came back in " + JSON.stringify(direction.unit) + " rather than degrees");
  }
  return {
    index: index,
    speed: speed,
    gust: gust,
    direction: direction,
    gustDirection: gustDirection,
    speedToMps: SPEED_UNITS[speed.unit],
    gustToMps: gust ? SPEED_UNITS[gust.unit] : null
  };
}

function cell(row, column) {
  if (column === undefined || column === null) return "";
  const value = row[column];
  return value === undefined ? "" : String(value).trim();
}

/**
 * When the observation labelled `hourLabel` was actually made.
 *
 * FEMS rounds to the nearest hour, so a station transmitting at :57 is labelled
 * an hour later than the hour it is in and one transmitting at :08 is labelled
 * within it. Measured over 48 hours at eleven stations: with this rule every
 * FEMS speed equals the Synoptic speed at the recovered minute exactly, and
 * with the "always round up" rule the three stations transmitting before :30
 * are wrong by a whole hour on every row.
 *
 * The tie at exactly :30 has not been observed and is assumed to round up, in
 * line with the eight stations at :35 and later.
 */
function observationTimeMs(labelMs, transmitMinute) {
  const carry = transmitMinute >= 30 ? -1 : 0;
  return labelMs + carry * HOUR_MS + transmitMinute * 60 * 1000;
}

/**
 * One CSV body, split into what is worth scoring and what is not.
 *
 * `transmitMinutes` maps a FEMS station id to the minute past the hour that
 * station transmits at. A station missing from it has no recoverable
 * observation time, and — unless `hourBins` says otherwise — every one of its
 * rows is rejected with the reason rather than being scored an unknown number
 * of minutes away from where it happened.
 */
function parseWeatherCsv(text, opts) {
  const o = opts || {};
  const maxMps = o.maxMps === undefined ? MAX_PLAUSIBLE_MPS : o.maxMps;
  const minutes = o.transmitMinutes || {};
  const hourBins = !!o.hourBins;
  const rejectFlags = o.rejectFlags || [];

  const rows = parseCsv(text);
  if (!rows.length) throw fail("bad-csv", "FEMS returned an empty body");
  const header = parseHeader(rows[0]);
  const out = new Map();

  function bucket(id) {
    if (!out.has(id)) {
      out.set(id, {
        stationId: id,
        records: [],
        rejected: [],
        counts: { seen: 0, kept: 0, rejected: 0, blank: 0, flagged: 0, calm: 0, withDirection: 0 }
      });
    }
    return out.get(id);
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === "") continue;
    const id = cell(row, header.index.StationId);
    if (!id) {
      throw fail("bad-csv", "row " + r + " of the CSV names no station");
    }
    const read = bucket(id);
    read.counts.seen++;

    const stamp = cell(row, header.index.DateTime);
    const type = cell(row, header.index.ObservationType);

    // The blank row: no time, no type, no measurement, and the id echoed back.
    // It is how FEMS says "no such station", "the station was down" and "that
    // hour has not happened yet", and none of the three is an observation.
    if (!stamp) {
      read.counts.blank++;
      read.rejected.push({ time: null, code: "no-data",
        reason: "FEMS answered with a blank row, which is its unknown-station, no-observation and future reply" });
      continue;
    }

    const timeMs = Date.parse(stamp);
    if (Number.isNaN(timeMs)) {
      read.rejected.push({ time: stamp, code: "bad-time", reason: "unreadable timestamp" });
      continue;
    }

    if (type !== OBSERVED) {
      read.counts.blank++;
      read.rejected.push({ time: stamp, code: type ? "not-an-observation" : "no-data",
        reason: type
          ? "row type " + JSON.stringify(type) + " is not an observation"
          : "the hour is present and empty, so the station reported nothing" });
      continue;
    }

    const minute = minutes[id];
    const known = typeof minute === "number" && isFinite(minute) && minute >= 0 && minute < 60;
    if (!known && !hourBins) {
      read.rejected.push({ time: stamp, code: "no-transmit-minute",
        reason: "FEMS labels this row with the nearest hour and no station transmits on the hour; " +
          "calibrate the minute with tools/fems-stations.js, or ask for hourBins and accept " +
          "a time that is up to 30 minutes out" });
      continue;
    }

    const rawSpeed = cell(row, header.speed.column);
    if (rawSpeed === "") {
      read.rejected.push({ time: stamp, code: "no-wind", reason: "the row reports no wind speed" });
      continue;
    }
    const speedValue = Number(rawSpeed);
    if (!isFinite(speedValue)) {
      read.rejected.push({ time: stamp, code: "bad-observation", reason: "wind speed is not a number" });
      continue;
    }
    const speed = speedValue * header.speedToMps;
    if (speed < 0 || speed > maxMps) {
      read.rejected.push({ time: stamp, code: "implausible", reason: speed.toFixed(1) + " m/s" });
      continue;
    }

    const speedFlag = cell(row, header.index.WSflag);
    const directionFlag = cell(row, header.index.WAflag);
    const flags = [];
    if (speedFlag && speedFlag !== "0") flags.push("WS=" + speedFlag);
    if (directionFlag && directionFlag !== "0") flags.push("WA=" + directionFlag);
    if (flags.length) read.counts.flagged++;
    if (flags.length && rejectFlags.length &&
        flags.some(function (f) { return rejectFlags.indexOf(f.split("=")[1]) >= 0; })) {
      read.rejected.push({ time: stamp, code: "bad-quality", reason: "flagged " + flags.join(",") });
      continue;
    }

    const rawDirection = cell(row, header.direction.column);
    const directionValue = rawDirection === "" ? null : Number(rawDirection);
    const direction = typeof directionValue === "number" && isFinite(directionValue)
      ? ((directionValue % 360) + 360) % 360
      : null;
    const rawGust = header.gust ? cell(row, header.gust.column) : "";
    const gust = rawGust === "" || !isFinite(Number(rawGust))
      ? null : Number(rawGust) * header.gustToMps;

    const calm = speed === 0;
    const observedMs = known ? observationTimeMs(timeMs, minute) : timeMs;

    read.records.push({
      stationId: id,
      time: new Date(observedMs).toISOString(),
      timeMs: observedMs,
      speedMps: speed,
      fromDeg: calm ? null : direction,
      calm: calm,
      gustMps: gust,
      quality: flags.length ? flags.join(",") : null,
      // Whether anything has looked at this row. QC is a later pass, so the
      // flag columns are empty in the last few days and 0/1/2 in the archive —
      // and an empty column and a `0` are both "no flag" to a reader that only
      // looks for a value. A near-real-time observation is unchecked, which is
      // a different claim from "checked and passed" and worth being able to
      // make.
      qcChecked: speedFlag !== "" || directionFlag !== "",
      // `raw` is the provider's own message, which is a METAR in
      // `observations.js` and does not exist here: a CSV row is this reader's
      // output re-encoded, and carrying a copy of it on 113,892 records a year
      // costs more than it explains. What cannot be reconstructed is below.
      raw: null,
      // What FEMS said, kept beside what this reader worked out, so a pairing
      // that looks wrong can be traced without re-fetching the year.
      hourLabel: new Date(timeMs).toISOString(),
      transmitMinute: known ? minute : null,
      timeIsHourBin: !known
    });
  }

  for (const read of out.values()) {
    read.records.sort(function (a, b) { return a.timeMs - b.timeMs; });
    read.counts.kept = read.records.length;
    read.counts.rejected = read.rejected.length;
    read.counts.calm = read.records.filter(function (r) { return r.calm; }).length;
    read.counts.withDirection = read.records.filter(function (r) { return r.fromDeg !== null; }).length;
  }

  return out;
}

function numberOf(value, where) {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) throw fail("bad-station", where + " is not a number: " + JSON.stringify(value));
  return n;
}

/**
 * Stations, from the GraphQL metadata response.
 *
 * `elevation` is feet. FEMS does not say so anywhere; see the header.
 */
function parseStations(json) {
  const data = json && json.data && json.data.stationMetaData;
  if (json && Array.isArray(json.errors) && json.errors.length) {
    throw fail("fems-refused",
      "FEMS refused the metadata query: " +
      json.errors.map(function (e) { return e && e.message; }).join("; "));
  }
  if (!data || !Array.isArray(data.data)) {
    throw fail("bad-response", "FEMS did not answer with stationMetaData");
  }
  return data.data.map(function (s) {
    const id = s.station_id === undefined || s.station_id === null ? null : String(s.station_id);
    if (!id) throw fail("bad-station", "a station has no station_id");
    const lat = numberOf(s.latitude, id + " latitude");
    const lon = numberOf(s.longitude, id + " longitude");
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw fail("bad-station", id + " is not at a position on Earth");
    }
    return {
      id: id,
      wrccId: typeof s.wrcc_id === "string" ? s.wrcc_id : null,
      nesdisId: typeof s.nesdis_id === "string" ? s.nesdis_id : null,
      name: typeof s.station_name === "string" ? s.station_name : null,
      lat: lat,
      lon: lon,
      // FEMS publishes no anemometer height. Synoptic surveys the same masts
      // and does, so `tools/fems-stations.js` carries the measured height into
      // the calibration map and `station()` below puts it back. A null here is
      // "FEMS did not say", never the 10 m default that would silently stop
      // the model being moved to the sensor.
      sensorHeightM: null,
      elevationM: s.elevation === null || s.elevation === undefined
        ? null : numberOf(s.elevation, id + " elevation") * M_PER_FOOT,
      elevationFt: s.elevation === null || s.elevation === undefined ? null : Number(s.elevation),
      state: typeof s.state === "string" ? s.state : null,
      agency: typeof s.agency === "string" ? s.agency : null,
      network: typeof s.network_name === "string" ? s.network_name : null,
      timeZone: typeof s.time_zone === "string" ? s.time_zone : null,
      recordStart: typeof s.period_record_start === "string" ? s.period_record_start : null,
      recordStop: typeof s.period_record_stop === "string" ? s.period_record_stop : null,
      hasHistoricData: s.has_historic_data === true,
      source: "fems"
    };
  });
}

/** The ids, in batches FEMS will answer. */
function batches(ids, size) {
  const step = size || MAX_STATIONS_PER_REQUEST;
  const out = [];
  for (let i = 0; i < ids.length; i += step) out.push(ids.slice(i, i + step));
  return out;
}

/**
 * Read FEMS over the network, behind the interface `score-wind.js` expects.
 *
 * `stations` is the calibration map `tools/fems-stations.js` writes: it turns
 * whatever id the caller already uses — a Synoptic id from an existing run, a
 * WRCC id, or the FEMS number itself — into a FEMS station and the minute past
 * the hour it transmits at. Without it this source will answer `station()` for
 * a numeric id and then refuse every observation, which is the intended
 * failure: see the header.
 */
function createFemsSource(opts) {
  const o = opts || {};
  const doFetch = o.fetch || globalThis.fetch;
  const map = o.stations || {};
  const hourBins = !!o.hourBins;
  const batchSize = o.batchSize || MAX_STATIONS_PER_REQUEST;
  const stations = new Map();
  const series = new Map();

  // Every id this source may be asked for, resolved once, so a window is one
  // request per batch rather than one per station.
  const wanted = (o.stationIds && o.stationIds.length ? o.stationIds : Object.keys(map))
    .map(function (id) { return resolve(id); });

  const transmitMinutes = {};
  for (const key of Object.keys(map)) {
    const entry = map[key];
    const id = entry && entry.femsId !== undefined ? femsId(entry.femsId) : femsId(key);
    if (entry && typeof entry.transmitMinute === "number") transmitMinutes[id] = entry.transmitMinute;
  }

  function resolve(id) {
    const key = String(id).trim();
    const entry = map[key] || map[key.toUpperCase()];
    if (entry && entry.femsId !== undefined) return femsId(entry.femsId);
    return femsId(key);
  }

  async function getText(url) {
    const res = await doFetch(url, { headers: { accept: "text/csv" } });
    if (!res.ok) {
      let body = null;
      try { body = (await res.text()).slice(0, 200); } catch (_err) { body = null; }
      throw fail("observations-unavailable",
        "FEMS answered " + res.status + " for " + url + (body ? ": " + body : ""),
        { status: res.status, url: url });
    }
    return await res.text();
  }

  async function getJson(request) {
    const res = await doFetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request.body)
    });
    if (!res.ok) {
      throw fail("observations-unavailable", "FEMS answered " + res.status + " for the metadata query",
        { status: res.status });
    }
    return await res.json();
  }

  async function loadStations(ids) {
    const missing = ids.filter(function (id) { return !stations.has(id); });
    if (!missing.length) return;
    for (const batch of batches(missing, batchSize)) {
      const parsed = parseStations(await getJson(metadataRequest({ stationIds: batch })));
      for (const station of parsed) stations.set(station.id, station);
    }
    for (const id of missing) {
      if (!stations.has(id)) throw fail("unknown-station", "FEMS has no station " + id);
    }
  }

  return {
    /** Every station FEMS has, for choosing a set by terrain rather than by name. */
    search: async function (query) {
      const parsed = parseStations(await getJson(metadataRequest(query || { all: true })));
      for (const station of parsed) stations.set(station.id, station);
      return parsed;
    },

    station: async function (id) {
      const key = resolve(id);
      await loadStations([key]);
      const station = stations.get(key);
      const entry = map[String(id)] || map[String(id).toUpperCase()] || null;
      return Object.assign({}, station, {
        // The id the caller asked with, so a report keeps saying PCPC2 when the
        // request said 50406.
        id: String(id),
        femsId: key,
        sensorHeightM: entry && typeof entry.sensorHeightM === "number"
          ? entry.sensorHeightM : null,
        sensorHeightSource: entry && entry.sensorHeightSource ? entry.sensorHeightSource : null,
        transmitMinute: transmitMinutes[key] === undefined ? null : transmitMinutes[key],
        calibratedAgainst: entry && entry.calibratedAgainst ? entry.calibratedAgainst : null
      });
    },

    observations: async function (id, window) {
      const key = resolve(id);
      // The label is up to an hour away from the observation, so the window has
      // to be widened before it is asked for or the first and last hours of a
      // run go missing after the times are corrected.
      const start = new Date(new Date(window.start).getTime() - HOUR_MS);
      const end = new Date(new Date(window.end).getTime() + HOUR_MS);
      const windowKey = start.toISOString() + "-" + end.toISOString();
      if (!series.has(windowKey)) {
        const ids = wanted.length ? wanted : [key];
        const merged = new Map();
        for (const batch of batches(ids, batchSize)) {
          const text = await getText(weatherUrl({ stationIds: batch, start: start, end: end }));
          const read = parseWeatherCsv(text, {
            transmitMinutes: transmitMinutes,
            hourBins: hourBins,
            maxMps: o.maxMps,
            rejectFlags: o.rejectFlags
          });
          for (const [stationId, value] of read) merged.set(stationId, value);
        }
        series.set(windowKey, merged);
      }
      const read = series.get(windowKey).get(key);
      if (!read) {
        throw fail("unknown-station",
          "FEMS returned no rows at all for station " + key + "; it answers an unknown station " +
          "with a blank row, so no row is a different failure again");
      }
      // Every row blank is FEMS' way of saying it has nothing, and it is the
      // same reply as an id that does not exist. A caller that treats it as an
      // empty series scores a station it never read.
      if (!read.records.length && read.counts.blank === read.counts.seen && read.counts.seen > 0) {
        throw fail("no-observations",
          "FEMS answered for station " + key + " with " + read.counts.seen + " blank rows and " +
          "nothing else, which is its reply to an unknown station as well as to a dead one");
      }
      return Object.assign({}, read, { stationId: String(id) });
    }
  };
}

module.exports = {
  FEMS_ROOT,
  M_PER_FOOT,
  MAX_PLAUSIBLE_MPS,
  MAX_STATIONS_PER_REQUEST,
  RAWS_QUANTISATION,
  SPEED_UNITS,
  weatherUrl,
  metadataRequest,
  parseCsv,
  parseHeader,
  parseWeatherCsv,
  parseStations,
  observationTimeMs,
  batches,
  createFemsSource
};
