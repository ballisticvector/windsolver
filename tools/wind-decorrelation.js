#!/usr/bin/env node
/**
 * How much of a scored "model error" is only the clock.
 *
 *   node tools/wind-decorrelation.js --stations KRTN,KCOS --month 2026-03
 *   node tools/wind-decorrelation.js --stations KRTN --month 2024-09 --cache ~/asos1min
 *   node tools/wind-decorrelation.js --files tests/fixtures/asos-1min-pg1-KRTN-20260315.dat
 *
 * Options:
 *   --stations  comma-separated ICAO call signs (KRTN, KDEN, ...)
 *   --month     YYYY-MM, or several comma-separated
 *   --files     read these page-1 files instead of fetching anything
 *   --cache     directory to keep downloads in, so a rerun costs nothing
 *   --tolerance the pairing window to price, in minutes (default 30)
 *   --block     also run the curve on this many minutes of averaging (default 10)
 *   --max-lag   longest lag to measure, in minutes (default 90)
 *   --offsets   price the pairing offsets a score-wind --pairs document recorded
 *   --out       write the whole report as JSON to this path
 *
 * Every measurement in `docs/downscaling.md` pairs an hourly model against an
 * observation at some other minute and charges the whole difference to the
 * model. This prices that pairing by asking one anemometer how far it moves
 * from itself over the same gap: no model, no downscaling, no siting argument,
 * so whatever it reports is a floor under every RMSE in the note.
 *
 * **It is an airport record, and that is a limit on what it licenses.** ASOS
 * sits on flat open ground by design, so this measures temporal variability in
 * the easiest terrain there is. A RAWS on a ridge is unlikely to be steadier.
 * Nothing here re-opens the terrain question; it only says how much of the
 * error bar was never the model's to answer for.
 *
 * **It measures a 2-minute mean against a 2-minute mean.** A RAWS reports a
 * 10-minute mean, which is smoother, so `--block 10` is the honest comparison
 * for a FEMS-fed run and the unaveraged curve is the honest one for a METAR.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const asos1min = require("../asos1min.js");

/** What the pairing tolerance in `tools/score-wind.js` currently defaults to. */
const DEFAULT_TOLERANCE_MIN = 30;

/** ASOS speed accuracy, from the User's Guide: a difference below this is not evidence. */
const INSTRUMENT_TOLERANCE_MPS = 2 * asos1min.KNOT_MPS;

/** Fewer minutes than this and a station-month's curve is noise. */
const MIN_RECORDS = 5000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else { out[name] = next; i++; }
  }
  return out;
}

function months(spec) {
  return String(spec).split(",").map(function (m) {
    const match = /^(\d{4})-?(\d{2})$/.exec(m.trim());
    if (!match) throw new Error("--month wants YYYY-MM, not " + JSON.stringify(m));
    return { year: Number(match[1]), month: Number(match[2]) };
  });
}

/** One station-month, from the cache if it is there and NCEI if it is not. */
async function load(spec) {
  const s = spec || {};
  const url = asos1min.monthUrl(s.station, s.year, s.month);
  const file = s.cache
    ? path.join(s.cache, path.basename(url))
    : null;
  if (file && fs.existsSync(file) && fs.statSync(file).size > 0) {
    const text = fs.readFileSync(file, "latin1");
    asos1min.refuseNonRecords(text, file);
    const parsed = asos1min.parsePageOne(text, { requireRecords: true, what: file });
    return Object.assign({ url: file, cached: true }, parsed);
  }
  const fetched = await asos1min.fetchMonth(s);
  if (file) {
    fs.mkdirSync(s.cache, { recursive: true });
    fs.writeFileSync(file, fetched.text === undefined ? "" : fetched.text);
  }
  return Object.assign({ cached: false }, fetched);
}

/** Everything this tool has to say about one series of records. */
function analyse(records, opts) {
  const o = opts || {};
  const tolerance = o.toleranceMin === undefined ? DEFAULT_TOLERANCE_MIN : o.toleranceMin;
  const maxLag = o.maxLagMin === undefined ? 90 : o.maxLagMin;
  const blockMin = o.blockMin === undefined ? 10 : o.blockMin;
  const curve = asos1min.decorrelation(records, { maxLagMin: maxLag });
  const blockedRecords = blockMin > 1 ? asos1min.blockMean(records, blockMin) : null;
  const blocked = blockedRecords
    ? asos1min.decorrelation(blockedRecords, { maxLagMin: maxLag })
    : null;
  const calm = records.filter(function (r) { return r.calm; }).length;
  let sum = 0;
  for (const r of records) sum += r.speedMps;
  return {
    n: records.length,
    meanSpeedMps: records.length ? sum / records.length : null,
    calmFraction: records.length ? calm / records.length : null,
    curve: curve,
    blockCurve: blocked,
    window: [10, tolerance, 60].map(function (m) { return asos1min.overWindow(curve, m); }),
    blockMin: blockMin,
    blockWindow: blocked
      ? [10, tolerance, 60].map(function (m) { return asos1min.overWindow(blocked, m); })
      : null,
    toleranceCrossingMin: asos1min.crossing(curve, INSTRUMENT_TOLERANCE_MPS),
    hourly: asos1min.againstWholeHour(records),
    byRegime: asos1min.bySpeed(records, { lagMin: Math.min(tolerance, maxLag) })
  };
}

function round(value, places) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function right(text, width) {
  const s = String(text);
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** The report as a person reads it. */
function summarise(report) {
  const lines = [];
  lines.push("ASOS one-minute wind, NCEI DSI-6405 page 1");
  lines.push("");
  lines.push(pad("station", 10) + right("n", 8) + right("mean", 7) + right("calm", 7) +
    right("t+10", 7) + right("t+" + report.toleranceMin, 7) + right("t+60", 7) +
    right("+/-2kt", 8) + right("hour", 7) + right("interp", 7));
  for (const s of report.stations) {
    lines.push(pad(s.station + " " + s.month, 10) +
      right(s.n, 8) +
      right(round(s.meanSpeedMps, 2), 7) +
      right(round(100 * s.calmFraction, 1) + "%", 7) +
      right(round(s.window[0].speedRmsMps, 2), 7) +
      right(round(s.window[1].speedRmsMps, 2), 7) +
      right(round(s.window[2].speedRmsMps, 2), 7) +
      right(s.toleranceCrossingMin === null ? "-" : round(s.toleranceCrossingMin, 1), 8) +
      right(round(s.hourly.nearest.speedRmsMps, 2), 7) +
      right(round(s.hourly.interpolated.speedRmsMps, 2), 7));
  }
  lines.push("");
  lines.push("speed in m/s; t+N is the RMS change over a pairing window of N minutes;");
  lines.push("+/-2kt is the lag at which the wind's own change reaches the ASOS speed");
  lines.push("tolerance; hour/interp are nearest-whole-hour and time-interpolated pairing.");
  const p = report.pooled;
  if (p) {
    lines.push("");
    lines.push("pooled over " + report.stations.length + " station-months:");
    lines.push("                                        speed  vector  direction");
    lines.push(cost("  a " + report.toleranceMin + " minute pairing window", p.window));
    lines.push(cost("  the same, averaged over " + report.blockMin + " min first", p.blockWindow));
    lines.push(cost("  the nearest whole hour", p.hourly.nearest));
    lines.push(cost("  interpolated between the two hours", p.hourly.interpolated));
    lines.push("  the wind's own change reaches +/-2 kt after " +
      round(p.toleranceCrossingMin, 1) + " minutes");
    lines.push("");
    lines.push("  by wind speed, over " + report.toleranceMin + " minutes:");
    for (const bin of p.byRegime) {
      if (!bin.n) continue;
      lines.push("    " + pad(bin.fromMps + "-" + (bin.toMps === null ? "" : bin.toMps) + " m/s", 12) +
        right(bin.n, 9) + right(round(bin.speedRmsMps, 2), 7) + right(round(bin.vectorRmsMps, 2), 8) +
        right(round(100 * bin.relative, 0) + "%", 8) + " of the wind");
    }
  }
  if (report.runs && report.runs.length) {
    lines.push("");
    lines.push("at the offsets these runs actually drew:");
    lines.push("                                        speed  vector  direction");
    for (const r of report.runs) {
      lines.push(cost("  " + r.file + " (mean " + round(r.meanOffsetMin, 1) +
        " min, max " + r.maxOffsetMin + ")", r));
      if (r.averaged) {
        lines.push(cost("    the same over " + r.blockMin + "-minute means", r.averaged));
      }
    }
  }
  return lines.join("\n");
}

/** One row of the pooled table: what a way of pairing costs. */
function cost(label, stat) {
  return pad(label, 38) + right(round(stat.speedRmsMps, 2), 7) +
    right(round(stat.vectorRmsMps, 2), 8) +
    right(round(stat.dirRmsDeg, 0) + " deg", 11);
}

/** Root mean square of a field across station-months, weighted by sample size. */
function pool(stations, pick) {
  let sum = 0, n = 0;
  for (const s of stations) {
    const value = pick(s);
    if (value === null || value === undefined) continue;
    sum += s.n * value * value;
    n += s.n;
  }
  return n ? Math.sqrt(sum / n) : null;
}

function poolReport(stations) {
  if (!stations.length) return null;
  const regimes = stations[0].byRegime.map(function (bin, i) {
    let count = 0, sum2 = 0, vec2 = 0, speed = 0;
    for (const s of stations) {
      const b = s.byRegime[i];
      if (!b || !b.n) continue;
      count += b.n;
      sum2 += b.n * b.speedRmsMps * b.speedRmsMps;
      vec2 += b.n * b.vectorRmsMps * b.vectorRmsMps;
      speed += b.n * b.meanSpeedMps;
    }
    return {
      fromMps: bin.fromMps,
      toMps: Number.isFinite(bin.toMps) ? bin.toMps : null,
      n: count,
      meanSpeedMps: count ? speed / count : null,
      speedRmsMps: count ? Math.sqrt(sum2 / count) : null,
      vectorRmsMps: count ? Math.sqrt(vec2 / count) : null,
      relative: count && speed ? Math.sqrt(sum2 / count) / (speed / count) : null
    };
  });
  return {
    window: {
      speedRmsMps: pool(stations, function (s) { return s.window[1].speedRmsMps; }),
      vectorRmsMps: pool(stations, function (s) { return s.window[1].vectorRmsMps; }),
      dirRmsDeg: pool(stations, function (s) { return s.window[1].dirRmsDeg; })
    },
    blockWindow: {
      speedRmsMps: pool(stations, function (s) { return s.blockWindow && s.blockWindow[1].speedRmsMps; }),
      vectorRmsMps: pool(stations, function (s) { return s.blockWindow && s.blockWindow[1].vectorRmsMps; }),
      dirRmsDeg: pool(stations, function (s) { return s.blockWindow && s.blockWindow[1].dirRmsDeg; })
    },
    hourly: {
      nearest: {
        speedRmsMps: pool(stations, function (s) { return s.hourly.nearest.speedRmsMps; }),
        vectorRmsMps: pool(stations, function (s) { return s.hourly.nearest.vectorRmsMps; }),
        dirRmsDeg: pool(stations, function (s) { return s.hourly.nearest.dirRmsDeg; })
      },
      interpolated: {
        speedRmsMps: pool(stations, function (s) { return s.hourly.interpolated.speedRmsMps; }),
        vectorRmsMps: pool(stations, function (s) { return s.hourly.interpolated.vectorRmsMps; }),
        dirRmsDeg: pool(stations, function (s) { return s.hourly.interpolated.dirRmsDeg; })
      }
    },
    toleranceCrossingMin: median(stations.map(function (s) { return s.toleranceCrossingMin; })),
    curve: pooledCurve(stations, "curve"),
    blockCurve: pooledCurve(stations, "blockCurve"),
    byRegime: regimes
  };
}

/** One decorrelation curve for the whole sample, weighted by station-month size. */
function pooledCurve(stations, key) {
  const have = stations.filter(function (s) { return s[key]; });
  const longest = have.reduce(function (max, s) {
    return Math.max(max, s[key].length);
  }, 0);
  const out = [];
  for (let lag = 0; lag < longest; lag++) {
    const at = have.filter(function (s) { return s[key][lag]; });
    out.push({
      lagMin: lag,
      n: at.reduce(function (sum, s) { return sum + s[key][lag].n; }, 0),
      speedRmsMps: pool(at, function (s) { return s[key][lag].speedRmsMps; }),
      vectorRmsMps: pool(at, function (s) { return s[key][lag].vectorRmsMps; }),
      dirRmsDeg: pool(at, function (s) { return s[key][lag].dirRmsDeg; })
    });
  }
  return out;
}

function median(values) {
  const kept = values.filter(function (v) { return typeof v === "number"; }).sort(function (a, b) { return a - b; });
  if (!kept.length) return null;
  const mid = Math.floor(kept.length / 2);
  return kept.length % 2 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2;
}

/** Read every station-month asked for, and analyse each one. */
async function run(spec) {
  const s = spec || {};
  const toleranceMin = s.toleranceMin === undefined ? DEFAULT_TOLERANCE_MIN : s.toleranceMin;
  const blockMin = s.blockMin === undefined ? 10 : s.blockMin;
  const stations = [];
  const skipped = [];
  for (const source of s.sources) {
    let parsed = null;
    try {
      parsed = source.records
        ? source
        : await load(Object.assign({ cache: s.cache, fetch: s.fetch }, source));
    } catch (err) {
      // A station-month NCEI does not hold is a hole in the sample, not a
      // reason to lose the other twenty-seven. It is named rather than dropped.
      skipped.push({
        station: source.station || "?",
        n: 0,
        url: null,
        refused: err && err.message ? err.message : String(err)
      });
      continue;
    }
    if (parsed.records.length < (s.minRecords === undefined ? MIN_RECORDS : s.minRecords)) {
      skipped.push({
        station: parsed.station || source.station || "?",
        n: parsed.records.length,
        url: parsed.url || null,
        refused: null
      });
      continue;
    }
    stations.push(Object.assign({
      station: parsed.station || source.station || "?",
      month: source.year ? String(source.year) + String(source.month).padStart(2, "0") : "",
      url: parsed.url || null,
      absent: parsed.absent,
      malformed: parsed.malformed
    }, analyse(parsed.records, {
      toleranceMin: toleranceMin,
      blockMin: blockMin,
      maxLagMin: s.maxLagMin
    })));
  }
  return {
    source: "NCEI DSI-6405 page 1",
    toleranceMin: toleranceMin,
    blockMin: blockMin,
    instrumentToleranceMps: INSTRUMENT_TOLERANCE_MPS,
    stations: stations,
    skipped: skipped,
    pooled: poolReport(stations)
  };
}

/**
 * What the clock cost a run that has already happened.
 *
 * A `tools/score-wind.js --pairs` document records the offset it accepted for
 * every pair. Reading the pooled curve at exactly those offsets turns "a
 * 30 minute tolerance could cost this much" into "this run paid this much".
 */
function priceRun(report, files) {
  const pooled = report.pooled;
  if (!pooled || !pooled.curve) return [];
  return files.map(function (file) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const offsets = (doc.pairs || []).map(function (p) { return p.offsetMinutes; })
      .filter(function (v) { return typeof v === "number"; });
    return Object.assign({ file: path.basename(file) },
      asos1min.atOffsets(pooled.curve, offsets),
      {
        // The same offsets read off a series averaged the way a RAWS averages,
        // which is the comparable number when the run was fed by FEMS.
        blockMin: report.blockMin,
        averaged: pooled.blockCurve && pooled.blockCurve.length
          ? asos1min.atOffsets(pooled.blockCurve, offsets)
          : null
      });
  });
}

function sourcesOf(args) {
  if (args.files) {
    return String(args.files).split(",").map(function (file) {
      const parsed = asos1min.parsePageOne(fs.readFileSync(file.trim(), "latin1"),
        { requireRecords: true, what: file });
      return Object.assign({ url: file.trim() }, parsed);
    });
  }
  if (!args.stations || !args.month) {
    throw new Error("wind-decorrelation: give --stations and --month, or --files");
  }
  const out = [];
  for (const month of months(args.month)) {
    for (const station of String(args.stations).split(",")) {
      out.push({ station: station.trim().toUpperCase(), year: month.year, month: month.month });
    }
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const report = await run({
    sources: sourcesOf(args),
    cache: args.cache ? String(args.cache) : null,
    toleranceMin: args.tolerance === undefined ? undefined : Number(args.tolerance),
    blockMin: args.block === undefined ? undefined : Number(args.block),
    maxLagMin: args["max-lag"] === undefined ? undefined : Number(args["max-lag"]),
    minRecords: args.files ? 0 : undefined
  });
  if (args.offsets) {
    report.runs = priceRun(report, String(args.offsets).split(",").map(function (f) {
      return f.trim();
    }));
  }
  if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2));
  process.stdout.write(summarise(report) + "\n");
}

module.exports = { parseArgs, months, analyse, run, summarise, poolReport, priceRun, load };

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}
