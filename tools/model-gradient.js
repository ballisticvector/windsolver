#!/usr/bin/env node
/**
 * What does one reference wind for the whole box cost, in metres per second?
 *
 *   node tools/model-gradient.js --source coagmet --stations gun01,ftc03 \
 *     --date 2026-08-31 --hours 24
 *
 * Options:
 *   --source      coagmet (2-3 m masts) or fems (6.1 m RAWS)
 *   --stations    comma-separated ids; without it, --state picks the catalogue
 *   --state       two-letter state, used when no ids are named
 *   --limit       most stations to read when picking by state (default 12)
 *   --date        archive date, repeatable, YYYY-MM-DD, the 24 hours from 00Z
 *   --end         newest hour to score, repeatable, ISO; the form
 *                 `tools/score-wind.js` takes, so a run here can cover exactly
 *                 the hours a scoring run covered
 *   --hours       hours in each window (default 24)
 *   --tolerance   minutes between the model hour and the observation (default 30)
 *   --level       atmospheric level (default the field's own)
 *   --fems-map    FEMS station map (default data/fems-stations.json); FEMS
 *                 labels an observation with the nearest whole hour, so the
 *                 transmit minute has to come from the map before a pair means
 *                 anything
 *   --offsets     displacement distances in miles (default 0.5,1,2)
 *   --out         write the full report as JSON
 *
 * `field.js` takes **one** vector from HRRR at the centre of the box and hands
 * it to every cell of the terrain grid. That is the reason a two-mile map's
 * arrows all point the same way, and the per-cell reference removes it. But
 * "the map now varies" is not evidence that the variation is right: HRRR is a
 * 3 km model, a two-mile box is 1.3 cells across, and everything the per-cell
 * path draws inside it is a bilinear ramp between neighbouring cells. The ramp
 * is either information the centre sample was throwing away, or it is noise
 * being drawn with more conviction than before.
 *
 * This measures which, without any terrain in the way. For a station with an
 * anemometer on it, take the model **at the station** and the model **at a
 * point d away** — which is exactly what the centre-only reference hands to a
 * cell d from the pin — and score both against the same observation. If the
 * displaced sample is measurably worse, the gradient is real and the centre
 * sample is losing it. If the two score the same, HRRR has no usable structure
 * at that separation and a per-cell reference is drawing detail it does not
 * have.
 *
 * **The distances are fixed in advance and not chosen from the answer**: half a
 * mile, one mile (the half-width of the two-mile box, so the worst case for a
 * pin at the centre) and two miles. Eight bearings at each, pooled, so the
 * result is not a statement about one upwind direction.
 *
 * Three things this deliberately does not do. It does not run the terrain
 * downscaling — the question is about the model's own field, and a terrain
 * factor at the station would be common to both samples anyway. It does not
 * fit anything per station: the speed columns are reported raw and after a
 * single multiplicative debias fitted over the whole sample, because HRRR runs
 * fast over these networks and an uncorrected RMSE is mostly that bias. And it
 * says nothing about 0-3 m; the model is scored at the sensor's height through
 * the same log law the rest of the project uses, which is unvalidated below
 * 6.1 m and applies equally to both samples.
 */

"use strict";

const fs = require("fs");

const archive = require("../archive.js");
const cache = require("../cache.js");
const downscale = require("../downscale.js");
const fieldModule = require("../field.js");
const geo = require("../geo.js");
const hrrr = require("../hrrr.js");
const volumeModule = require("../volume.js");

/** Displacements scored, in miles. Fixed here, not chosen from a result. */
const DEFAULT_OFFSET_MILES = [0.5, 1, 2];

/** Bearings each displacement is taken along, so no one direction decides it. */
const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

function parse(argv) {
  const out = { date: [], end: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) i++;
    if (name === "date" || name === "end") out[name].push(value);
    else out[name] = value;
  }
  return out;
}

function number(value, fallback, what) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("--" + what + " must be a number");
  return n;
}

/** The bearing the wind is coming from, from east/north components. */
function bearingFrom(east, north) {
  return (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360;
}

/** A difference of bearings, folded into -180..180. */
function wrapDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * A point `metres` from a coordinate along a bearing, on the sphere.
 *
 * Small distances over a 3 km grid, so the spherical form is far more accuracy
 * than the question needs; it is here rather than a flat-earth step because the
 * longitude scaling at 40° is a 23% error and would quietly shrink every
 * east-west displacement.
 */
function displace(lat, lon, metres, bearingDeg) {
  const R = 6371008.8;
  const d = metres / R;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2)
  );
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

/**
 * Sums enough to report a speed score raw and after one fitted scale.
 *
 * The scale is the least-squares one, `sum(obs*model)/sum(model^2)`, which is
 * the same family measurement 10 found transfers between days. Fitted and
 * scored on the same sample here, and labelled as such: it is not a claim about
 * a held-out day, it is the way to compare two samples of the same model
 * without the shared bias dominating both.
 */
function accumulator() {
  return { n: 0, se: 0, sm: 0, smm: 0, som: 0, sd: 0, sdd: 0, nd: 0, sv: 0 };
}

function addSpeed(acc, obs, model) {
  acc.n++;
  acc.se += (model - obs) * (model - obs);
  acc.sm += model - obs;
  acc.smm += model * model;
  acc.som += obs * model;
  acc.sv += obs;
}

function addDirection(acc, obsDeg, modelDeg) {
  const d = wrapDeg(modelDeg - obsDeg);
  acc.nd++;
  acc.sd += d;
  acc.sdd += d * d;
}

function summarise(acc) {
  if (!acc.n) return null;
  const scale = acc.smm > 0 ? acc.som / acc.smm : 1;
  // mean((s*m - o)^2) expanded over the stored sums, so the debiased score
  // costs no second pass and no stored pairs.
  const debiased = (scale * scale * acc.smm - 2 * scale * acc.som + sumsq(acc)) / acc.n;
  return {
    pairs: acc.n,
    observedMeanMps: acc.sv / acc.n,
    speedBiasMps: acc.sm / acc.n,
    speedRmseMps: Math.sqrt(acc.se / acc.n),
    scale: scale,
    speedRmseDebiasedMps: Math.sqrt(Math.max(0, debiased)),
    directionPairs: acc.nd,
    directionBiasDeg: acc.nd ? acc.sd / acc.nd : null,
    directionRmseDeg: acc.nd ? Math.sqrt(acc.sdd / acc.nd) : null
  };
}

/** sum(obs^2), recovered from the stored sums: se = sum((m-o)^2). */
function sumsq(acc) {
  return acc.se - acc.smm + 2 * acc.som;
}

function sourceFor(name, ids, args) {
  const key = String(name || "coagmet").toLowerCase();
  if (key === "coagmet") {
    return { label: "CoAgMet", source: require("../coagmet.js").createCoagmetSource({}) };
  }
  if (key === "fems") {
    // Same requirement as tools/score-wind.js, and for the same reason: without
    // the transmit minute every FEMS row is dated by an hour label that is a
    // station-dependent hour out, which is larger than the whole effect being
    // measured here.
    const where = args && args["fems-map"] && args["fems-map"] !== true
      ? String(args["fems-map"]) : "data/fems-stations.json";
    if (!fs.existsSync(where)) {
      throw new Error("--source fems needs the station map " + where +
        "; build it with tools/fems-stations.js");
    }
    const map = JSON.parse(fs.readFileSync(where, "utf8"));
    const missing = (ids || []).filter(function (id) { return !map[id]; });
    if (missing.length) {
      throw new Error(where + " has no entry for " + missing.join(",") +
        "; calibrate them or leave them out of --stations");
    }
    return {
      label: "FEMS",
      source: require("../fems.js").createFemsSource({ stations: map, stationIds: ids })
    };
  }
  throw new Error("--source must be coagmet or fems");
}

/** The observation nearest a model hour, or null when none is close enough. */
function nearest(records, atMs, toleranceMs) {
  let best = null;
  let bestGap = Infinity;
  for (const r of records) {
    const gap = Math.abs(r.timeMs - atMs);
    if (gap <= toleranceMs && gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const namedIds = args.stations && args.stations !== true
    ? String(args.stations).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    : [];
  const chosen = sourceFor(args.source, namedIds, args);
  const hours = number(args.hours, 24, "hours");
  const toleranceMs = number(args.tolerance, 30, "tolerance") * 60 * 1000;
  const level = args.level && args.level !== true ? String(args.level) : fieldModule.DEFAULT_LEVEL;
  const offsetsMiles = args.offsets && args.offsets !== true
    ? String(args.offsets).split(",").map(Number)
    : DEFAULT_OFFSET_MILES;
  const roughnessM = number(args.roughness, downscale.DEFAULT_ROUGHNESS_M, "roughness");

  if (!args.date.length && !args.end.length) throw new Error("--date or --end is required");

  let stations;
  if (namedIds.length) {
    stations = [];
    for (const id of namedIds) stations.push(await chosen.source.station(id));
  } else {
    const limit = number(args.limit, 12, "limit");
    const found = await chosen.source.search({ state: String(args.state || "CO").toUpperCase(), status: "active" });
    stations = found.slice(0, limit);
  }
  if (!stations.length) throw new Error("no stations to read");

  const validTimes = [];
  for (const date of args.date) {
    const start = Date.parse(date + "T00:00:00Z");
    if (Number.isNaN(start)) throw new Error("unreadable --date " + date);
    for (let h = 0; h < hours; h++) validTimes.push(new Date(start + h * 3600 * 1000));
  }
  for (const iso of args.end) {
    const endMs = Date.parse(iso);
    if (Number.isNaN(endMs)) throw new Error("unreadable --end " + iso);
    const top = Math.floor(endMs / 3600000) * 3600000;
    for (let i = hours - 1; i >= 0; i--) validTimes.push(new Date(top - i * 3600000));
  }
  validTimes.sort(function (a, b) { return a - b; });

  // One box for every station and every displacement, plus a model cell, so the
  // bilinear sample at the furthest offset still has four corners around it.
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const s of stations) {
    south = Math.min(south, s.lat); north = Math.max(north, s.lat);
    west = Math.min(west, s.lon); east = Math.max(east, s.lon);
  }
  const padMiles = Math.max.apply(null, offsetsMiles) + 3000 / geo.METERS_PER_MILE;
  const box = geo.expand({ south: south, north: north, west: west, east: east }, padMiles);

  const air = cache.createHrrrVolumeSource({ nomads: archive.createArchiveSource({}) });

  // One accumulator per displacement, and one for the station's own cell.
  const buckets = new Map();
  buckets.set(0, accumulator());
  for (const miles of offsetsMiles) buckets.set(miles, accumulator());
  // How far apart the two samples are from each other, observations aside.
  const disagreement = new Map();
  for (const miles of offsetsMiles) disagreement.set(miles, { n: 0, ss: 0, sdd: 0, sq: 0, dq: 0 });

  const observations = new Map();
  const failures = [];

  // Contiguous runs of hours, so each becomes one observation request.
  const windows = [];
  for (const t of validTimes) {
    const last = windows[windows.length - 1];
    if (last && t.getTime() - last.endMs <= 2 * 3600 * 1000) {
      last.endMs = t.getTime();
      continue;
    }
    windows.push({ startMs: t.getTime(), endMs: t.getTime() });
  }
  const requestWindows = windows.map(function (w) {
    return {
      start: new Date(w.startMs - 2 * 3600 * 1000),
      end: new Date(w.endMs + 2 * 3600 * 1000)
    };
  });

  for (const station of stations) {
    // One read per window rather than one spanning them all: four archive
    // dates six months apart would otherwise ask CoAgMet for half a year of
    // five-minute data to use four days of it.
    const records = [];
    for (const window of requestWindows) {
      try {
        const read = await chosen.source.observations(station.id, window);
        for (const r of read.records) records.push(r);
      } catch (err) {
        failures.push({ station: station.id, code: err.code || null, error: err.message });
      }
    }
    if (records.length) observations.set(station.id, records);
  }

  for (const validTime of validTimes) {
    let volume;
    try {
      volume = await air.get({
        box: box,
        validTime: validTime,
        levels: hrrr.DEFAULT_LEVEL_KEYS,
        variables: fieldModule.DEFAULT_VARIABLES
      });
    } catch (err) {
      failures.push({ validTime: validTime.toISOString(), code: err.code || null, error: err.message });
      continue;
    }

    for (const station of stations) {
      const records = observations.get(station.id);
      if (!records) continue;
      const obs = nearest(records, validTime.getTime(), toleranceMs);
      if (!obs) continue;

      const heightM = typeof station.sensorHeightM === "number" ? station.sensorHeightM : null;
      const here = volumeModule.sampleWind(volume, station.lat, station.lon, level);
      const factor = heightM === null
        ? 1
        : downscale.heightFactor(fieldModule.heightOf(level), heightM, roughnessM);

      addSpeed(buckets.get(0), obs.speedMps, Math.hypot(here.east, here.north) * factor);
      if (obs.fromDeg !== null) addDirection(buckets.get(0), obs.fromDeg, bearingFrom(here.east, here.north));

      for (const miles of offsetsMiles) {
        const metres = miles * geo.METERS_PER_MILE;
        for (const bearing of BEARINGS) {
          const at = displace(station.lat, station.lon, metres, bearing);
          const there = volumeModule.sampleWind(volume, at.lat, at.lon, level);
          const speed = Math.hypot(there.east, there.north) * factor;
          addSpeed(buckets.get(miles), obs.speedMps, speed);
          if (obs.fromDeg !== null) addDirection(buckets.get(miles), obs.fromDeg, bearingFrom(there.east, there.north));
          const d = disagreement.get(miles);
          const bearingDiff = wrapDeg(bearingFrom(there.east, there.north) - bearingFrom(here.east, here.north));
          const speedDiff = speed - Math.hypot(here.east, here.north) * factor;
          d.n++;
          d.ss += Math.hypot(there.east - here.east, there.north - here.north);
          d.sdd += Math.abs(bearingDiff);
          d.sq += speedDiff * speedDiff;
          d.dq += bearingDiff * bearingDiff;
        }
      }
    }
  }

  const at0 = summarise(buckets.get(0));
  const report = {
    source: chosen.label,
    level: level,
    stations: stations.map(function (s) {
      return { id: s.id, lat: s.lat, lon: s.lon, sensorHeightM: s.sensorHeightM || null };
    }),
    validTimes: validTimes.length,
    toleranceMinutes: toleranceMs / 60000,
    offsetsMiles: offsetsMiles,
    bearings: BEARINGS,
    atTheStation: at0,
    displaced: offsetsMiles.map(function (miles) {
      const d = disagreement.get(miles);
      return Object.assign({ offsetMiles: miles }, summarise(buckets.get(miles)), {
        modelVsModel: d.n
          ? {
            samples: d.n,
            vectorMeanMps: d.ss / d.n,
            bearingMeanDeg: d.sdd / d.n,
            speedRmsMps: Math.sqrt(d.sq / d.n),
            bearingRmsDeg: Math.sqrt(d.dq / d.n)
          }
          : null,
        // What the displaced column would score if the model's difference over
        // that distance were pure added error — the station's own error and the
        // displacement in quadrature. The displaced score coming out **at** this
        // is the null: the gradient is indistinguishable from noise at that
        // separation. Coming out **below** it is the only evidence available
        // here that the gradient carries real structure.
        ifTheGradientWereNoise: d.n
          ? {
            speedRmseMps: Math.sqrt(at0.speedRmseMps * at0.speedRmseMps + d.sq / d.n),
            directionRmseDeg: at0.directionRmseDeg === null
              ? null
              : Math.sqrt(at0.directionRmseDeg * at0.directionRmseDeg + d.dq / d.n)
          }
          : null
      });
    }),
    failures: failures
  };

  if (args.out && args.out !== true) {
    fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2) + "\n");
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const at = report.atTheStation;
  if (!at) {
    console.log("no pairs; " + failures.length + " failures");
    return;
  }
  console.log(chosen.label + ", " + stations.length + " stations, " + validTimes.length +
    " model hours, " + at.pairs + " pairs, observed mean " + at.observedMeanMps.toFixed(2) + " m/s");
  console.log("");
  console.log("where the model is read      speed RMSE   debiased   direction RMSE   model-vs-model");
  console.log("                             (m/s)        (m/s)                       (mean vector, bearing)");
  console.log("at the station               " +
    at.speedRmseMps.toFixed(3).padStart(9) + "   " +
    at.speedRmseDebiasedMps.toFixed(3).padStart(8) + "   " +
    at.directionRmseDeg.toFixed(1).padStart(12) + "°");
  for (const row of report.displaced) {
    console.log((row.offsetMiles + " miles away").padEnd(29) +
      row.speedRmseMps.toFixed(3).padStart(9) + "   " +
      row.speedRmseDebiasedMps.toFixed(3).padStart(8) + "   " +
      row.directionRmseDeg.toFixed(1).padStart(12) + "°   " +
      row.modelVsModel.vectorMeanMps.toFixed(3) + " m/s, " +
      row.modelVsModel.bearingMeanDeg.toFixed(1) + "°");
  }
  console.log("");
  console.log("the null: what each row would score if that displacement were pure noise");
  for (const row of report.displaced) {
    console.log((row.offsetMiles + " miles away").padEnd(29) +
      row.ifTheGradientWereNoise.speedRmseMps.toFixed(3).padStart(9) + "   " +
      "       -   " +
      row.ifTheGradientWereNoise.directionRmseDeg.toFixed(1).padStart(12) + "°");
  }
  if (failures.length) console.log("\n" + failures.length + " failures, first: " + JSON.stringify(failures[0]));
}

main().catch(function (err) {
  console.error(err.code ? err.code + ": " + err.message : err);
  process.exitCode = 1;
});
