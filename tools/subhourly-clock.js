#!/usr/bin/env node
/**
 * Does moving the model to the observation's own minute recover the clock term?
 *
 * Usage:
 *
 *   node tools/subhourly-clock.js --stations gun01,fc001 --date 2026-09-01 --start 12 --hours 6
 *   node tools/subhourly-clock.js --stations gun01 --date 2026-09-01 --hours 12 --out clock.json
 *
 * Options:
 *
 *   --stations   comma-separated CoAgMet station ids (required)
 *   --date       the UTC day to read, YYYY-MM-DD (required)
 *   --start      the first UTC hour of the window (default 12)
 *   --hours      how many whole hours (default 6)
 *   --tolerance  observation-to-valid-time tolerance in minutes (default 30, the
 *                widest the hourly arm can need)
 *   --average    the observation mean's width in minutes for the third arm
 *                (default 10)
 *   --out        write the whole result as JSON to this path
 *
 * ## What this measures, and what it cannot
 *
 * Measurement 13 priced the pairing clock from a one-minute ASOS record: at the
 * offsets the FEMS runs actually drew, pairing an hourly model with an
 * anemometer costs about 0.85 m/s of speed RMSE and 23° of direction *before the
 * model is wrong about anything*. That is fourteen times the spread of the whole
 * terrain ablation table, and it left one thing unknown — whether a model that
 * runs faster than hourly recovers any of it, or whether an hourly model simply
 * does not contain the wind's sub-hourly variation and there is nothing there to
 * recover.
 *
 * HRRR publishes `wrfsubhf`, the same surface fields every 15 minutes.
 * `archive.js` reads it. This tool scores the same observations three ways over
 * the same window and prints the differences:
 *
 * - **hourly** — each observation against the nearest hourly analysis, which is
 *   what every run in `docs/downscaling.md` has done. Offsets up to 30 minutes.
 * - **quarter** — each observation against the nearest 15-minute instant.
 *   Offsets up to 7.5 minutes.
 * - **quarter+avg** — a vector mean of the observations inside `--average`
 *   minutes of each 15-minute instant, against that instant.
 *
 * **The three arms score the same observations**, which is the only reason the
 * differences mean anything: an arm that dropped a station's light-wind hours
 * would score better for that reason alone.
 *
 * **Averaging the measured side is not interpolating it.** Every value in the
 * mean was measured, and the mean is over an interval that contains the model's
 * instant. An interpolated observation is a modelled observation and does not
 * appear here. What is missing is the other half: the model side cannot be
 * averaged to match, because the only pre-averaged fields HRRR publishes
 * sub-hourly are five-minute means covering minutes 10-15, 25-30, 40-45 and
 * 55-60 — twenty minutes of the hour, not an hour of it. So the third arm is a
 * one-sided pre-average, and measurement 13's ~30% was for both sides.
 *
 * **A quarter-hourly field is a forecast and the hourly one is an analysis.**
 * The instants at :15, :30 and :45 are 15-, 30- and 45-minute lead times from
 * the same cycle, and the analysis at :00 has just been told what the
 * observations said. Any gain in the quarter arm is therefore net of whatever
 * the lead costs, and the `lead` block prices that separately: at the same valid
 * times, the analysis against the 60-minute forecast that reaches them.
 *
 * **CoAgMet only.** It is the only source here that reports faster than hourly,
 * and a clock experiment against hourly observations would be measuring its own
 * setup. Its masts are at 2-3 m and the model is read at 10 m with no height
 * correction: a single least-squares scale is fitted per arm and the debiased
 * numbers are the ones to read, because the height gap is a constant across all
 * three arms and the question is the difference between them.
 *
 * **Leverage before ranking**, as everywhere else in this project: the headline
 * difference is recomputed with each station's pairs removed, and a difference
 * that changes sign when one mast leaves is not a result.
 */

"use strict";

const fs = require("fs");

const archive = require("../archive.js");
const coagmet = require("../coagmet.js");
const geo = require("../geo.js");
const verify = require("../verify.js");
const volume = require("../volume.js");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LEVEL = { name: "heightAboveGround", value: 10 };
const LEVEL_NAME = "10_m_above_ground";
const VARIABLES = ["UGRD", "VGRD"];

/** Margin around the station set, in miles, so a crop cannot clip a corner. */
const BOX_MARGIN_MILES = 6;

/**
 * What a CoAgMet score is allowed to be read against.
 *
 * The network's own quantisation and its own anemometer specification, never
 * the ASOS defaults `verify.js` carries: those are a different instrument on a
 * different network, and 1.03 m/s of airport tolerance quoted under a 2 m
 * agricultural mast is a number about nothing.
 */
const COAGMET_FLOOR = Object.assign({}, coagmet.COAGMET_QUANTISATION, coagmet.COAGMET_INSTRUMENT);

const FLAGS = ["stations", "date", "start", "hours", "tolerance", "average", "out"];

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (FLAGS.indexOf(name) < 0) {
      throw new Error("unknown option --" + name + "; known: " + FLAGS.join(", ") +
        (name.indexOf("=") >= 0 ? " (a value is a separate word, not --name=value)" : ""));
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[name] = true;
      continue;
    }
    out[name] = next;
    i++;
  }
  return out;
}

function number(value, fallback, name) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!isFinite(n)) throw new Error("--" + name + " must be a number, got " + JSON.stringify(value));
  return n;
}

/** The UTC midnight of a `YYYY-MM-DD`, refusing anything else. */
function dayMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
  if (!m) throw new Error("--date must be YYYY-MM-DD in UTC, got " + JSON.stringify(text));
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function round(value, places) {
  if (value === null || value === undefined || !isFinite(value)) return null;
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

/** Speed and bearing from east/north components, in the `from` convention. */
function windOf(east, north) {
  const speed = Math.sqrt(east * east + north * north);
  if (speed === 0) return { speedMps: 0, fromDeg: null };
  const toward = (Math.atan2(east, north) * 180) / Math.PI;
  return { speedMps: speed, fromDeg: (toward + 180 + 360) % 360 };
}

/**
 * The union of the station coordinates, with a margin.
 *
 * One box for the whole run rather than one per station: the archive answers
 * with a CONUS message either way and crops on the way past, so a wider crop is
 * free and a second station costs nothing.
 */
function boxOver(stations) {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const s of stations) {
    south = Math.min(south, s.lat);
    north = Math.max(north, s.lat);
    west = Math.min(west, s.lon);
    east = Math.max(east, s.lon);
  }
  const mid = geo.boundingBox((south + north) / 2, (west + east) / 2, BOX_MARGIN_MILES);
  const pad = { lat: (mid.north - mid.south) / 2, lon: (mid.east - mid.west) / 2 };
  return {
    south: south - pad.lat,
    north: north + pad.lat,
    west: west - pad.lon,
    east: east + pad.lon
  };
}

/**
 * One model instant, sampled at every station.
 *
 * `forecastMinutes` is required by `archive.js` for the sub-hourly product,
 * because four instants of the same field live in one object and taking the
 * first is a valid wind at the wrong minute.
 */
async function instantAt(source, opts) {
  const got = await source.fetchHrrrBox({
    box: opts.box,
    cycle: opts.cycle,
    forecastMinutes: opts.forecastMinutes,
    variables: VARIABLES,
    levels: [LEVEL_NAME]
  });
  const vol = volume.buildVolume(got.records);
  const samples = new Map();
  for (const station of opts.stations) {
    const w = volume.sampleWind(vol, station.lat, station.lon, LEVEL);
    const wind = windOf(w.east, w.north);
    const validTimeMs = vol.validTime.getTime();
    samples.set(station.id, {
      stationId: station.id,
      timeMs: validTimeMs,
      time: vol.validTime.toISOString(),
      speedMps: wind.speedMps,
      fromDeg: wind.fromDeg,
      forecast: got.forecast,
      leadMinutes: opts.forecastMinutes
    });
  }
  return { samples: samples, bytes: got.bytes, validTimeMs: vol.validTime.getTime() };
}

/**
 * Pair, fit one scale over the run's own pairs, and score twice.
 *
 * The raw score carries the 2 m/10 m height gap and the model's own bias; the
 * debiased one does not, and it is the same fit in every arm, so the arms are
 * comparable to each other and neither is comparable with a published RMSE.
 */
function arm(name, byStation, opts) {
  const o = opts || {};
  const pairs = [];
  let unmatched = 0;
  for (const [id, side] of byStation) {
    const paired = verify.pair(side.observations, side.samples, { toleranceMs: o.toleranceMs });
    unmatched += paired.unmatched.length;
    for (const p of paired.pairs) {
      pairs.push(Object.assign({}, p, { stationId: p.stationId === null ? id : p.stationId }));
    }
  }
  const scale = verify.debiasScale(pairs);
  return {
    name: name,
    pairs: pairs,
    unmatched: unmatched,
    scale: scale,
    raw: verify.score(pairs, COAGMET_FLOOR),
    debiased: verify.score(pairs, Object.assign({ scale: scale }, COAGMET_FLOOR)),
    offsets: offsetsOf(pairs)
  };
}

/** How far the pairs actually reached, which is the thing being varied. */
function offsetsOf(pairs) {
  const minutes = pairs.map(function (p) { return Math.abs(p.offsetMs) / MINUTE_MS; });
  if (!minutes.length) return { n: 0, meanMinutes: null, maxMinutes: null };
  let sum = 0;
  let max = 0;
  for (const m of minutes) {
    sum += m;
    max = Math.max(max, m);
  }
  return { n: minutes.length, meanMinutes: sum / minutes.length, maxMinutes: max };
}

/** The single record closest to one instant, or none inside the window. */
function nearestTo(records, timeMs, halfWidthMs) {
  let best = null;
  for (const r of records) {
    const d = Math.abs(r.timeMs - timeMs);
    if (d > halfWidthMs) continue;
    if (!best || d < Math.abs(best.timeMs - timeMs)) best = r;
  }
  return best;
}

/**
 * A vector mean of the observations around one instant.
 *
 * Vector, not scalar: averaging speeds and averaging bearings separately turns a
 * wind that backed through north into a wind from the south. A mean with no
 * observation in it is not a zero wind, it is absent, and is dropped.
 */
function averageAround(records, timeMs, halfWidthMs) {
  let east = 0;
  let north = 0;
  let n = 0;
  for (const r of records) {
    if (Math.abs(r.timeMs - timeMs) > halfWidthMs) continue;
    const c = r.fromDeg === null
      ? { east: 0, north: 0 }
      : verify.componentsOf(r.speedMps, r.fromDeg);
    east += c.east;
    north += c.north;
    n++;
  }
  if (!n) return null;
  const wind = windOf(east / n, north / n);
  return {
    stationId: records.length ? records[0].stationId : null,
    time: new Date(timeMs).toISOString(),
    timeMs: timeMs,
    speedMps: wind.speedMps,
    fromDeg: wind.fromDeg,
    calm: wind.speedMps === 0,
    averagedFrom: n
  };
}

/**
 * The headline difference, recomputed with each station's pairs left out.
 *
 * Two candidates over one set of stations is the shape that has produced a wrong
 * answer twice in this project, both times because one mast carried it.
 */
function leverage(arms, stationIds, opts) {
  if (stationIds.length < 3) return null;
  const held = [];
  for (const id of stationIds) {
    const row = { without: id };
    for (const a of arms) {
      const kept = a.pairs.filter(function (p) { return p.stationId !== id; });
      if (!kept.length) {
        row[a.name] = null;
        continue;
      }
      const scale = verify.debiasScale(kept);
      const s = verify.score(kept, Object.assign({ scale: scale }, COAGMET_FLOOR));
      row[a.name] = { vectorRmseMps: s.vectorRmseMps, directionRmseDeg: s.direction.rmseDeg };
    }
    held.push(row);
  }
  // One contrast per arm against the hourly one, each judged on its own: the
  // quarter arm and the averaged arm can move in opposite directions, and
  // pooling their signs would call that instability when it is the result.
  const base = arms[0].name;
  const contrasts = arms.slice(1).map(function (a) {
    const changes = [];
    for (const row of held) {
      if (!row[base] || !row[a.name]) continue;
      changes.push(row[a.name].vectorRmseMps - row[base].vectorRmseMps);
    }
    const signs = new Set(changes.map(function (d) { return d < 0 ? "-" : (d > 0 ? "+" : "0"); }));
    return {
      arm: a.name,
      against: base,
      minChangeMps: changes.length ? Math.min.apply(null, changes) : null,
      maxChangeMps: changes.length ? Math.max.apply(null, changes) : null,
      stable: changes.length > 0 && signs.size === 1
    };
  });
  const unstable = contrasts.filter(function (c) { return !c.stable; });
  return {
    heldOut: held,
    contrasts: contrasts,
    stable: unstable.length === 0,
    note: unstable.length === 0
      ? "every arm's difference from " + base + " keeps its sign with any one station left out"
      : "the sign of " + unstable.map(function (c) { return c.arm; }).join(" and ") +
        " against " + base + " changes when a station is left out; this run has not " +
        "measured that difference",
    minStations: opts && opts.minStations
  };
}

function fmt(value, places) {
  const r = round(value, places === undefined ? 3 : places);
  return r === null ? "    -" : String(r);
}

function summarise(report) {
  const lines = [];
  lines.push("");
  lines.push("HRRR sub-hourly against " + report.stations.length + " CoAgMet mast(s), " +
    report.hours + " h from " + report.windows.map(function (w) { return w.start; }).join(", "));
  lines.push("");
  lines.push("arm            n   offset mean/max min   scale   speed RMSE   dir RMSE   vector RMSE");
  for (const a of report.arms) {
    lines.push(
      a.name.padEnd(13) +
      String(a.debiased.n).padStart(5) +
      (fmt(a.offsets.meanMinutes, 1) + " / " + fmt(a.offsets.maxMinutes, 1)).padStart(19) +
      fmt(a.scale, 3).padStart(8) +
      fmt(a.debiased.speed.rmseMps, 3).padStart(13) +
      fmt(a.debiased.direction.rmseDeg, 1).padStart(11) +
      fmt(a.debiased.vectorRmseMps, 3).padStart(14));
  }
  lines.push("");
  lines.push("(debiased: one least-squares speed scale per arm, over that arm's own pairs)");
  if (report.lead) {
    lines.push("");
    lines.push("the lead a quarter-hourly field costs, at the same valid times:");
    lines.push("  analysis        speed RMSE " + fmt(report.lead.analysis.speed.rmseMps) +
      "   dir RMSE " + fmt(report.lead.analysis.direction.rmseDeg, 1) +
      "   vector RMSE " + fmt(report.lead.analysis.vectorRmseMps));
    lines.push("  60 min forecast speed RMSE " + fmt(report.lead.forecast.speed.rmseMps) +
      "   dir RMSE " + fmt(report.lead.forecast.direction.rmseDeg, 1) +
      "   vector RMSE " + fmt(report.lead.forecast.vectorRmseMps));
  }
  if (report.model) {
    lines.push("");
    lines.push("what the model itself does inside an hour, at these stations: " +
      "median " + fmt(report.model.medianSpeedChangeMps, 3) + " m/s and " +
      fmt(report.model.medianDirectionChangeDeg, 1) + "° between one 15-minute " +
      "instant and the next (n = " + report.model.n + ")");
  }
  if (report.leverage) {
    lines.push("");
    lines.push("leverage, one station left out at a time:");
    for (const c of report.leverage.contrasts) {
      lines.push("  " + (c.arm + " - " + c.against).padEnd(24) +
        "vector RMSE change " + fmt(c.minChangeMps) + " to " + fmt(c.maxChangeMps) +
        "   " + (c.stable ? "sign holds" : "SIGN FLIPS"));
    }
    lines.push("  " + report.leverage.note);
  }
  lines.push("");
  return lines.join("\n");
}

/** How far the model's own wind moves from one 15-minute instant to the next. */
function modelMotion(series) {
  const speeds = [];
  const directions = [];
  for (const [, samples] of series) {
    const sorted = samples.slice().sort(function (a, b) { return a.timeMs - b.timeMs; });
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timeMs - sorted[i - 1].timeMs !== 15 * MINUTE_MS) continue;
      speeds.push(Math.abs(sorted[i].speedMps - sorted[i - 1].speedMps));
      if (sorted[i].fromDeg === null || sorted[i - 1].fromDeg === null) continue;
      directions.push(Math.abs(verify.angleDifferenceDeg(sorted[i].fromDeg, sorted[i - 1].fromDeg)));
    }
  }
  function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  return {
    n: speeds.length,
    medianSpeedChangeMps: median(speeds),
    medianDirectionChangeDeg: median(directions)
  };
}

async function buildReport(options) {
  const ids = String(options.stations || "").split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  if (!ids.length) throw new Error("--stations is required: comma-separated CoAgMet ids");

  const hours = number(options.hours, 6, "hours");
  if (!(hours >= 1)) throw new Error("--hours must be at least 1");
  const toleranceMs = number(options.tolerance, 30, "tolerance") * MINUTE_MS;
  const averageMs = number(options.average, 10, "average") * MINUTE_MS;
  const startHour = number(options.start, 12, "start");
  // Several days rather than one, because a light overnight hour and a windy
  // afternoon are different weather and a clock term measured on one of them is
  // a statement about that day.
  const days = String(options.date === true ? "" : (options.date || "")).split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  if (!days.length) throw new Error("--date is required: one or more UTC days, YYYY-MM-DD");
  const windows = days.map(function (day) {
    const startMs = dayMs(day) + startHour * HOUR_MS;
    return { day: day, startMs: startMs, endMs: startMs + hours * HOUR_MS };
  });

  const source = coagmet.createCoagmetSource();
  const stations = [];
  for (const id of ids) {
    const s = await source.station(id);
    stations.push({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      sensorHeightM: s.sensorHeightM
    });
  }

  const box = boxOver(stations);
  const modelSource = archive.createArchiveSource({ product: archive.SUBHOURLY_PRODUCT });

  const observations = new Map();
  const hourly = new Map();
  const quarter = new Map();
  const leadSamples = new Map();
  for (const station of stations) {
    observations.set(station.id, []);
    hourly.set(station.id, []);
    quarter.set(station.id, []);
    leadSamples.set(station.id, []);
  }
  let bytes = 0;
  const gaps = [];

  // The measured side first, and all of it: a station that was down on one of
  // the days should cost a note rather than four minutes of archive reads.
  for (const window of windows) {
    for (const station of stations) {
      let read;
      try {
        read = await source.observations(station.id, {
          start: new Date(window.startMs - averageMs),
          end: new Date(window.endMs + averageMs)
        });
      } catch (err) {
        // A window before the station existed, or a sensor that was down, comes
        // back as blank rows and `coagmet.js` refuses it by name. That is one
        // station-day absent, not a broken run — but it is recorded, because a
        // silently smaller sample is how a difference gets attributed to the
        // clock instead of to which masts answered.
        if (err && err.code === "no-observations") {
          gaps.push({ stationId: station.id, day: window.day, code: err.code });
          continue;
        }
        throw err;
      }
      if (read.averagingSeconds > 15 * 60) {
        throw new Error("station " + station.id + " reports every " + read.averagingSeconds +
          " s, which is not faster than the model; this experiment needs a five-minute station");
      }
      // A five-minute label ends its interval, so the record centred on the last
      // instant needs a window that reaches past it.
      const kept = read.records.filter(function (r) {
        return r.timeMs >= window.startMs - averageMs && r.timeMs <= window.endMs + averageMs;
      });
      observations.get(station.id).push.apply(observations.get(station.id), kept);
    }
  }

  const silent = stations.filter(function (s) { return !observations.get(s.id).length; });
  if (silent.length === stations.length) {
    throw new Error("no station reported over any of these days: " +
      gaps.map(function (g) { return g.stationId + " " + g.day; }).join(", "));
  }

  for (const window of windows) {
    // The model side: every quarter hour from the window's first instant to its
    // last, each read from the cycle it is a short lead time from.
    for (let t = window.startMs; t <= window.endMs; t += 15 * MINUTE_MS) {
      const minute = new Date(t).getUTCMinutes();
      const cycle = new Date(t - minute * MINUTE_MS);
      const got = await instantAt(modelSource, {
        box: box, cycle: cycle, forecastMinutes: minute, stations: stations
      });
      bytes += got.bytes;
      for (const station of stations) {
        const sample = got.samples.get(station.id);
        quarter.get(station.id).push(sample);
        if (minute === 0) hourly.get(station.id).push(sample);
      }
    }

    // The same valid times again, reached as a 60-minute forecast instead of an
    // analysis, so the lead a quarter-hourly field carries has a price on it.
    for (let t = window.startMs; t <= window.endMs; t += HOUR_MS) {
      const got = await instantAt(modelSource, {
        box: box, cycle: new Date(t - HOUR_MS), forecastMinutes: 60, stations: stations
      });
      bytes += got.bytes;
      for (const station of stations) leadSamples.get(station.id).push(got.samples.get(station.id));
    }
  }

  const armInput = function (samples, records) {
    const byStation = new Map();
    for (const station of stations) {
      byStation.set(station.id, {
        observations: records.get(station.id),
        samples: samples.get(station.id)
      });
    }
    return byStation;
  };

  // Two measured sides over the same instants: the mean of the records around
  // each one, and the single record nearest it. Comparing the averaged arm with
  // the hourly one would compare an averaging window with a smaller sample as
  // well; comparing it with this one varies only the averaging.
  const averaged = new Map();
  const nearest = new Map();
  for (const station of stations) {
    const records = observations.get(station.id);
    const means = [];
    const singles = [];
    for (const sample of quarter.get(station.id)) {
      const mean = averageAround(records, sample.timeMs, averageMs / 2);
      if (!mean) continue;
      const one = nearestTo(records, sample.timeMs, averageMs / 2);
      if (!one) continue;
      means.push(Object.assign(mean, { stationId: station.id }));
      singles.push(Object.assign({}, one, { stationId: station.id }));
    }
    averaged.set(station.id, means);
    nearest.set(station.id, singles);
  }

  // The hourly and quarter arms must see the same observations; the averaged arm
  // cannot, because it is one observation per instant by construction.
  const scored = observations;
  const arms = [
    arm("hourly", armInput(hourly, scored), { toleranceMs: toleranceMs }),
    arm("quarter", armInput(quarter, scored), { toleranceMs: toleranceMs }),
    arm("quarter+one", armInput(quarter, nearest), { toleranceMs: toleranceMs }),
    arm("quarter+avg", armInput(quarter, averaged), { toleranceMs: toleranceMs })
  ];

  const onTheHour = new Map();
  for (const station of stations) {
    onTheHour.set(station.id, observations.get(station.id).filter(function (r) {
      const m = new Date(r.timeMs).getUTCMinutes();
      return m >= 57 || m <= 3;
    }));
  }
  const leadArms = [
    arm("analysis", armInput(hourly, onTheHour), { toleranceMs: 5 * MINUTE_MS }),
    arm("forecast", armInput(leadSamples, onTheHour), { toleranceMs: 5 * MINUTE_MS })
  ];

  return {
    generatedAt: new Date().toISOString(),
    source: "coagmet",
    product: archive.SUBHOURLY_PRODUCT,
    windows: windows.map(function (w) {
      return { start: new Date(w.startMs).toISOString(), end: new Date(w.endMs).toISOString() };
    }),
    hours: hours,
    toleranceMinutes: toleranceMs / MINUTE_MS,
    averageMinutes: averageMs / MINUTE_MS,
    box: box,
    bytes: bytes,
    stations: stations,
    observations: stations.map(function (s) {
      return { stationId: s.id, kept: observations.get(s.id).length };
    }),
    gaps: gaps,
    arms: arms.map(function (a) {
      return {
        name: a.name,
        scale: a.scale,
        unmatched: a.unmatched,
        offsets: a.offsets,
        raw: a.raw,
        debiased: a.debiased
      };
    }),
    lead: { analysis: leadArms[0].debiased, forecast: leadArms[1].debiased },
    model: modelMotion(quarter),
    leverage: leverage(arms, stations.map(function (s) { return s.id; }), { minStations: 3 }),
    caveats: [
      "the model is read at 10 m and the masts are at 2-3 m; no height correction is applied, " +
        "and the debias absorbs the gap identically in every arm",
      "the quarter arm's :15, :30 and :45 fields are forecasts, not analyses; the lead block " +
        "prices that at the same valid times",
      "the averaged arm averages the measured side only, because HRRR publishes no hour-long " +
        "sub-hourly mean; measurement 13's ~30% was for both sides",
      "the averaged arm is one pair per model instant and the hourly and quarter arms are one " +
        "per observation, so read it against quarter+one, which is the same instants and the " +
        "same count with no averaging",
      "CoAgMet's own five-minute record is already an average, so the averaged arm is a mean " +
        "of means rather than of samples"
    ]
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const report = await buildReport(options);
  if (options.out && options.out !== true) {
    fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n");
  }
  process.stdout.write(summarise(report));
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.code ? err.code + ": " : "") +
      (err && err.message ? err.message : String(err)) + "\n");
    process.exit(1);
  });
}

module.exports = { parse, dayMs, boxOver, windOf, averageAround, nearestTo, offsetsOf, modelMotion,
  leverage, arm, summarise, buildReport };
