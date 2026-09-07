/**
 * ASOS one-minute wind, and how far the wind moves while nobody is looking.
 *
 * Every measurement in `docs/downscaling.md` pairs a model valid at a whole
 * hour against an anemometer that reported at some other minute, inside a
 * tolerance chosen by judgement — `--tolerance 30` for FEMS, because a RAWS
 * transmits in a GOES slot up to half an hour from the label FEMS puts on it.
 * Nothing in the project has ever separated "the model was wrong" from "the
 * wind changed between :00 and :23", and the second is charged to the model
 * every time.
 *
 * NCEI's ASOS one-minute page 1 (DSI-6405) is the record that settles it: the
 * same 2-minute mean wind an ASOS reports in a METAR, written out **every
 * minute** for about a thousand stations back to 2000, with the 5-second peak
 * beside it. Pairing an anemometer against itself at two times measures the
 * wind's own change over that gap and nothing else — no model, no downscaling,
 * no siting argument.
 *
 * `tools/wind-decorrelation.js` runs it. What this module is careful about:
 *
 * **The wind is in page 1, not page 2.** DSI-6406 is the page with pressure and
 * temperature on it and no wind at all, which is a wasted download and an
 * afternoon.
 *
 * **The record is fixed-width and the columns do not move**, but the fields
 * before them do: a station with two visibility sensors and runway visual range
 * fills columns the next station leaves blank. Parse by column, never by
 * splitting on whitespace, or a foggy airport reads its visibility as a wind.
 *
 * **The date is local standard time and the clock is given twice.** Columns
 * 14-25 are the LST year, month, day, hour and minute; columns 26-29 are the
 * same instant's UTC hour and minute, and there is no UTC *date* anywhere. The
 * offset the two clocks imply is what carries the day over, which is why it is
 * recomputed per record rather than looked up from a time zone.
 *
 * **A missing wind is the letter `M`, and it is not a calm.** Over one Raton
 * station-month 479 of 35,893 minutes report `M` for speed and direction; a
 * reader that coerces them to zero invents four hundred calm minutes and drags
 * every mean down with them. They are counted as absent and never become
 * records — the same rule `fems.js` applies to a blank row.
 *
 * **A reported 0 is not a zero either.** The ASOS starting threshold is 2 kt
 * and anything at or below it is reported calm, so a 0 here means "at most
 * 1.03 m/s" exactly as it does in a METAR. `verify.js` holds the citation.
 * These records carry `calm: true` and keep the reported number, because the
 * difference between two censored minutes is still a real bound.
 *
 * **The speed is a 2-minute running mean, so consecutive minutes overlap by
 * half.** A one-minute difference is therefore smaller than the wind's true
 * one-minute change, and the first two lags of any curve computed here are
 * partly the averaging window rather than the atmosphere. Everything from about
 * 3 minutes out is clean.
 *
 * **The peak is a 5-second mean, not a gust field.** It is present at every
 * speed, unlike the METAR gust that is blank below 14 kt, so it is the better
 * of the two for anything about gustiness — but it is not the same quantity.
 */

"use strict";

/** One knot in m/s. The record is published in whole knots. */
const KNOT_MPS = 1852 / 3600;

/**
 * Where the wind sits in a page-1 record, as zero-based JavaScript slices.
 *
 * Taken from the NCEI documentation's own example and confirmed against the
 * column occupancy of 27 station-months: every record is 112 characters and
 * the four wind fields are right-justified in these four windows.
 */
const COLUMNS = {
  wban: [0, 5],
  callSign: [5, 9],
  stationId: [9, 13],
  localStamp: [13, 25],
  utcClock: [25, 29],
  dirDeg: [70, 74],
  speedKt: [74, 79],
  peakDirDeg: [79, 84],
  peakKt: [84, 89]
};

/** Shortest record that can still carry a wind. */
const MIN_RECORD_LENGTH = COLUMNS.peakKt[1];

/** At or below this an ASOS reports calm; see `verify.js` for the citation. */
const CALM_CEILING_MPS = 2 * KNOT_MPS;

/** Above this the record is a transmission fault rather than weather. */
const MAX_PLAUSIBLE_KT = 250;

function field(line, span) {
  return line.slice(span[0], span[1]).trim();
}

/**
 * Read a page-1 file.
 *
 * Returns the records that carry a wind, and counts of what did not: `absent`
 * for the minutes the station reported `M` or left blank, `malformed` for lines
 * that are not page-1 records at all. Absence is never a value.
 */
function parsePageOne(text, opts) {
  const o = opts || {};
  const records = [];
  let absent = 0;
  let malformed = 0;
  let station = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (line.length < MIN_RECORD_LENGTH) { malformed++; continue; }
    const stamp = field(line, COLUMNS.localStamp);
    const utc = field(line, COLUMNS.utcClock);
    if (!/^\d{12}$/.test(stamp) || !/^\d{4}$/.test(utc)) { malformed++; continue; }
    const dir = field(line, COLUMNS.dirDeg);
    const speed = field(line, COLUMNS.speedKt);
    if (!/^\d+$/.test(speed) || !/^\d+$/.test(dir)) { absent++; continue; }
    if (Number(speed) > MAX_PLAUSIBLE_KT) { malformed++; continue; }
    if (station === null) station = field(line, COLUMNS.callSign) || null;
    const peakDir = field(line, COLUMNS.peakDirDeg);
    const peak = field(line, COLUMNS.peakKt);
    const speedMps = Number(speed) * KNOT_MPS;
    records.push({
      time: utcTime(stamp, utc),
      station: station,
      speedMps: speedMps,
      dirDeg: Number(dir),
      // A calm carries whatever azimuth the vane was last showing, and below
      // the starting threshold that azimuth is not evidence. The direction is
      // kept so the record is not lossy, and `calm` is what a caller filters on.
      calm: speedMps <= CALM_CEILING_MPS,
      peakMps: /^\d+$/.test(peak) ? Number(peak) * KNOT_MPS : null,
      peakDirDeg: /^\d+$/.test(peakDir) ? Number(peakDir) : null,
      source: "ncei-asos-1min-pg1"
    });
  }
  if (o.requireRecords && !records.length) {
    throw new Error("asos1min: no page-1 wind records in " + (o.what || "input") +
      " (" + absent + " absent, " + malformed + " malformed)");
  }
  return { station: station, records: records, absent: absent, malformed: malformed };
}

/** The instant a record describes, from its local date and its UTC clock. */
function utcTime(stamp, utc) {
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const localMinutes = Number(stamp.slice(8, 10)) * 60 + Number(stamp.slice(10, 12));
  const utcMinutes = Number(utc.slice(0, 2)) * 60 + Number(utc.slice(2, 4));
  let offset = utcMinutes - localMinutes;
  if (offset < -720) offset += 1440;
  if (offset > 720) offset -= 1440;
  return new Date(Date.UTC(year, month - 1, day, 0, 0) + (localMinutes + offset) * 60000);
}

/** East and north components, from a direction the wind is coming from. */
function toVector(r) {
  const rad = (r.dirDeg * Math.PI) / 180;
  return { east: -r.speedMps * Math.sin(rad), north: -r.speedMps * Math.cos(rad) };
}

/** Signed difference between two bearings, in [-180, 180). */
function bearingDifference(a, b) {
  return ((a - b + 180) % 360 + 360) % 360 - 180;
}

function fromVector(east, north) {
  let deg = (Math.atan2(-east, -north) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return { speedMps: Math.hypot(east, north), dirDeg: deg };
}

/** Records by whole minute since the epoch, so a gap is a missing key. */
function index(records) {
  const map = new Map();
  for (const r of records) map.set(Math.round(r.time.getTime() / 60000), r);
  return map;
}

/**
 * How far apart the same anemometer is from itself, at every lag.
 *
 * `minDirectionMps` gates the direction statistic only. A bearing reported
 * beside a censored speed is not a measurement of a direction, so pairs where
 * either minute is at or below the calm ceiling are left out of the direction
 * column and kept in the speed one.
 */
function decorrelation(records, opts) {
  const o = opts || {};
  const maxLag = o.maxLagMin === undefined ? 90 : o.maxLagMin;
  const minDir = o.minDirectionMps === undefined ? CALM_CEILING_MPS : o.minDirectionMps;
  const map = index(records);
  const acc = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    acc.push({ n: 0, speed2: 0, vector2: 0, nDir: 0, dir2: 0 });
  }
  for (const [minute, a] of map) {
    const va = toVector(a);
    for (let lag = 0; lag <= maxLag; lag++) {
      const b = map.get(minute + lag);
      if (!b) continue;
      const s = acc[lag];
      const vb = toVector(b);
      const ds = b.speedMps - a.speedMps;
      s.n++;
      s.speed2 += ds * ds;
      s.vector2 += (vb.east - va.east) ** 2 + (vb.north - va.north) ** 2;
      if (a.speedMps > minDir && b.speedMps > minDir) {
        const dd = bearingDifference(b.dirDeg, a.dirDeg);
        s.nDir++;
        s.dir2 += dd * dd;
      }
    }
  }
  return acc.map(function (s, lag) {
    return {
      lagMin: lag,
      n: s.n,
      speedRmsMps: s.n ? Math.sqrt(s.speed2 / s.n) : null,
      vectorRmsMps: s.n ? Math.sqrt(s.vector2 / s.n) : null,
      nDirection: s.nDir,
      dirRmsDeg: s.nDir ? Math.sqrt(s.dir2 / s.nDir) : null
    };
  });
}

/**
 * The curve read as one number: the cost of a pairing tolerance.
 *
 * A run that accepts any observation within `minutes` of the model hour draws
 * an offset from somewhere in 1..`minutes`, so the error it adds is the root
 * mean square of the curve over that range rather than its value at the end.
 */
function overWindow(curve, minutes) {
  let speed2 = 0, vector2 = 0, dir2 = 0, n = 0, nDir = 0;
  for (let lag = 1; lag <= minutes && lag < curve.length; lag++) {
    const c = curve[lag];
    if (!c || c.speedRmsMps === null) continue;
    speed2 += c.speedRmsMps ** 2;
    vector2 += c.vectorRmsMps ** 2;
    n++;
    if (c.dirRmsDeg !== null) { dir2 += c.dirRmsDeg ** 2; nDir++; }
  }
  return {
    toleranceMin: minutes,
    speedRmsMps: n ? Math.sqrt(speed2 / n) : null,
    vectorRmsMps: n ? Math.sqrt(vector2 / n) : null,
    dirRmsDeg: nDir ? Math.sqrt(dir2 / nDir) : null
  };
}

/**
 * The curve read against the offsets a run actually drew.
 *
 * `overWindow` assumes a pairing tolerance is used uniformly, which it is not:
 * a station transmits on its own minute, so a real run's offsets pile up
 * wherever that minute falls. Given the offsets a `--pairs` document recorded,
 * this is what the clock cost that run rather than what it could have cost.
 */
function atOffsets(curve, offsets) {
  let speed2 = 0, vector2 = 0, dir2 = 0, n = 0, nDir = 0, sum = 0, max = 0;
  for (const raw of offsets) {
    const lag = Math.abs(Math.round(raw));
    const c = curve[lag];
    if (!c || c.speedRmsMps === null) continue;
    speed2 += c.speedRmsMps ** 2;
    vector2 += c.vectorRmsMps ** 2;
    sum += lag;
    if (lag > max) max = lag;
    n++;
    if (c.dirRmsDeg !== null) { dir2 += c.dirRmsDeg ** 2; nDir++; }
  }
  return {
    n: n,
    meanOffsetMin: n ? sum / n : null,
    maxOffsetMin: n ? max : null,
    speedRmsMps: n ? Math.sqrt(speed2 / n) : null,
    vectorRmsMps: n ? Math.sqrt(vector2 / n) : null,
    dirRmsDeg: nDir ? Math.sqrt(dir2 / nDir) : null
  };
}

/** The lag at which the curve first reaches `level`, interpolated. */
function crossing(curve, level) {
  for (let lag = 1; lag < curve.length; lag++) {
    const here = curve[lag];
    if (!here || here.speedRmsMps === null) continue;
    if (here.speedRmsMps >= level) {
      const before = curve[lag - 1] && curve[lag - 1].speedRmsMps !== null
        ? curve[lag - 1].speedRmsMps : 0;
      if (here.speedRmsMps === before) return lag;
      return lag - 1 + (level - before) / (here.speedRmsMps - before);
    }
  }
  return null;
}

/**
 * Averages over `minutes`, stamped at the end of the block.
 *
 * A RAWS reports a 10-minute mean and an ASOS a 2-minute one, so a curve
 * measured on ASOS minutes overstates what a RAWS would have seen. Averaging
 * first is how much of that difference is the averaging.
 */
function blockMean(records, minutes) {
  const map = index(records);
  const out = [];
  for (const [minute] of map) {
    let east = 0, north = 0, n = 0;
    for (let k = 0; k < minutes; k++) {
      const r = map.get(minute - k);
      if (!r) { n = -1; break; }
      const v = toVector(r);
      east += v.east; north += v.north; n++;
    }
    if (n !== minutes) continue;
    const mean = fromVector(east / minutes, north / minutes);
    out.push({
      time: new Date(minute * 60000),
      station: map.get(minute).station,
      speedMps: mean.speedMps,
      dirDeg: mean.dirDeg,
      calm: mean.speedMps <= CALM_CEILING_MPS,
      peakMps: null,
      peakDirDeg: null,
      source: "ncei-asos-1min-pg1-mean" + minutes
    });
  }
  out.sort(function (a, b) { return a.time - b.time; });
  return out;
}

/**
 * Score every minute against the whole hour a model would carry, two ways.
 *
 * `nearest` is what a pairing tolerance does: take the observation and the
 * model hour it falls closest to. `interpolated` is the best a smarter pairing
 * could do — linear in the vector components between the hours either side —
 * and it is measured on the observations themselves, so it is an upper bound on
 * what interpolating the model in time could ever recover. Whatever is left
 * after it is sub-hourly variability that no hourly field contains.
 */
function againstWholeHour(records, opts) {
  const o = opts || {};
  const minDir = o.minDirectionMps === undefined ? CALM_CEILING_MPS : o.minDirectionMps;
  const map = index(records);
  let n = 0, near2 = 0, interp2 = 0, nearVec2 = 0, interpVec2 = 0;
  let nDir = 0, nearDir2 = 0, interpDir2 = 0;
  let nInterp = 0, nInterpDir = 0;
  for (const [minute, r] of map) {
    const v = toVector(r);
    const past = Math.floor(minute / 60) * 60;
    const next = past + 60;
    const a = map.get(past);
    const b = map.get(next);
    const closest = (minute - past) < 30 ? a : b;
    if (closest) {
      const ds = r.speedMps - closest.speedMps;
      const vc = toVector(closest);
      n++; near2 += ds * ds;
      nearVec2 += (v.east - vc.east) ** 2 + (v.north - vc.north) ** 2;
      if (r.speedMps > minDir && closest.speedMps > minDir) {
        nDir++; nearDir2 += bearingDifference(r.dirDeg, closest.dirDeg) ** 2;
      }
    }
    if (a && b) {
      const f = (minute - past) / 60;
      const va = toVector(a), vb = toVector(b);
      const mid = fromVector(va.east + f * (vb.east - va.east), va.north + f * (vb.north - va.north));
      const ds = r.speedMps - mid.speedMps;
      const vm = toVector(mid);
      nInterp++; interp2 += ds * ds;
      interpVec2 += (v.east - vm.east) ** 2 + (v.north - vm.north) ** 2;
      if (r.speedMps > minDir && mid.speedMps > minDir) {
        nInterpDir++; interpDir2 += bearingDifference(r.dirDeg, mid.dirDeg) ** 2;
      }
    }
  }
  return {
    n: n,
    nInterpolated: nInterp,
    nearest: {
      speedRmsMps: n ? Math.sqrt(near2 / n) : null,
      vectorRmsMps: n ? Math.sqrt(nearVec2 / n) : null,
      dirRmsDeg: nDir ? Math.sqrt(nearDir2 / nDir) : null
    },
    interpolated: {
      speedRmsMps: nInterp ? Math.sqrt(interp2 / nInterp) : null,
      vectorRmsMps: nInterp ? Math.sqrt(interpVec2 / nInterp) : null,
      dirRmsDeg: nInterpDir ? Math.sqrt(interpDir2 / nInterpDir) : null
    }
  };
}

/**
 * The same difference, split by how hard the wind was blowing.
 *
 * The model's speed bias is proportional rather than additive
 * (`docs/downscaling.md`), so the question is whether its timing noise is too.
 */
function bySpeed(records, opts) {
  const o = opts || {};
  const lag = o.lagMin === undefined ? 30 : o.lagMin;
  const edges = o.edgesMps || [0, 2, 4, 6, Infinity];
  const map = index(records);
  const acc = edges.slice(0, -1).map(function () {
    return { n: 0, speed2: 0, vector2: 0, sum: 0 };
  });
  for (const [minute, a] of map) {
    const b = map.get(minute + lag);
    if (!b) continue;
    const mean = (a.speedMps + b.speedMps) / 2;
    let i = -1;
    for (let k = 0; k < acc.length; k++) if (mean >= edges[k] && mean < edges[k + 1]) i = k;
    if (i < 0) continue;
    const ds = b.speedMps - a.speedMps;
    const va = toVector(a), vb = toVector(b);
    acc[i].n++;
    acc[i].speed2 += ds * ds;
    acc[i].vector2 += (vb.east - va.east) ** 2 + (vb.north - va.north) ** 2;
    acc[i].sum += mean;
  }
  return acc.map(function (s, i) {
    return {
      fromMps: edges[i],
      toMps: edges[i + 1],
      n: s.n,
      meanSpeedMps: s.n ? s.sum / s.n : null,
      speedRmsMps: s.n ? Math.sqrt(s.speed2 / s.n) : null,
      vectorRmsMps: s.n ? Math.sqrt(s.vector2 / s.n) : null,
      relative: s.n && s.sum ? Math.sqrt(s.speed2 / s.n) / (s.sum / s.n) : null
    };
  });
}

/** Where NCEI keeps a station-month of page 1. */
function monthUrl(station, year, month) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  return "https://www.ncei.noaa.gov/data/automated-surface-observing-system-one-minute-pg1/" +
    "access/" + yyyy + "/" + mm + "/asos-1min-pg1-" + String(station).toUpperCase() +
    "-" + yyyy + mm + ".dat";
}

/**
 * Refuse a body that is not a page-1 file, wherever it came from.
 *
 * NCEI answers a station-month it does not hold with **HTTP 200 and an empty
 * body** — measured, at KRTN for 2025-09, where the directory listing shows the
 * file at zero bytes — and answers a station it has never heard of with a 404
 * HTML page. Either can end up on disk as a plausible-looking `.dat`, so the
 * check belongs here rather than beside the fetch: a cache is exactly where an
 * error page goes to be mistaken for weather.
 */
function refuseNonRecords(text, where) {
  if (!String(text).trim()) {
    throw new Error("asos1min: empty body for " + where +
      " — the station-month is listed but holds nothing");
  }
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error("asos1min: HTML rather than page-1 records for " + where);
  }
}

/** Fetch one station-month. */
async function fetchMonth(spec) {
  const s = spec || {};
  const doFetch = s.fetch || globalThis.fetch;
  const url = monthUrl(s.station, s.year, s.month);
  const res = await doFetch(url, { headers: { accept: "text/plain" } });
  if (!res.ok) {
    throw new Error("asos1min: NCEI answered " + res.status + " for " + url);
  }
  const text = await res.text();
  refuseNonRecords(text, url);
  const parsed = parsePageOne(text, { requireRecords: true, what: url });
  // The text comes back with the records so a caller can keep the file it read
  // and never ask NCEI the same question twice.
  return Object.assign({ url: url, text: text }, parsed);
}

module.exports = {
  KNOT_MPS,
  CALM_CEILING_MPS,
  COLUMNS,
  parsePageOne,
  utcTime,
  toVector,
  fromVector,
  bearingDifference,
  decorrelation,
  overWindow,
  atOffsets,
  crossing,
  blockMean,
  againstWholeHour,
  bySpeed,
  monthUrl,
  refuseNonRecords,
  fetchMonth
};
