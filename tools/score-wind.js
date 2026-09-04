#!/usr/bin/env node
/**
 * How far the solved wind is from the measured one.
 *
 * The engine reports `confidence: null` because nothing in it has ever been
 * compared with an anemometer. This is the comparison: real stations, real
 * HRRR, the real downscaling, and a score with its exclusions and its
 * quantisation floor written next to it.
 *
 *   node tools/score-wind.js --stations KBDU,KFNL,KGXY --hours 12
 *   node tools/score-wind.js --stations KBDU --hours 24 --forecast 6 --out score.json
 *
 * Options:
 *   --stations   comma-separated NWS/ICAO station ids (required)
 *   --hours      how many whole hours back from --end (default 12)
 *   --end        the newest hour to score, ISO 8601 (default: three hours ago,
 *                which is comfortably behind the HRRR availability lag)
 *   --forecast   HRRR lead time in hours (default 0, the analysis)
 *   --radius     domain radius in miles around each station (default 0.5)
 *   --resolution target terrain resolution in metres (default 30)
 *   --tolerance  observation-to-valid-time tolerance in minutes (default 10)
 *   --out        write the full result as JSON to this path
 *
 * **It costs one HRRR subset per station per hour** — a few KB each, but each
 * one is a NOMADS round trip — plus one 3DEP terrain read per station, which is
 * the slow part and is cached across the hours. Twelve hours at three stations
 * is 36 subsets and three terrain domains.
 *
 * **The analysis has seen the stations.** NCEP assimilates surface
 * observations, so `--forecast 0` grades a field that has already been told
 * what the answer is at these very sites. The score is still worth having — the
 * downscaling on top of it has not seen them, and the terrain classes separate
 * where it does work from where it does not — but a claim about *forecast*
 * skill needs `--forecast 6` or more, and NOMADS only keeps about two days of
 * files to run it over.
 *
 * **ASOS stations are on airfields.** Flat, open, deliberately unobstructed:
 * the terrain where a 3 km model is already close and the downscaling has
 * almost nothing to do. A score dominated by airports understates both the
 * problem and the fix. RAWS through Synoptic sits where the terrain matters and
 * needs a token; this tool takes its observations from an injected source, so
 * pointing it at that network is a new reader and not a new scorer.
 */

"use strict";

const fs = require("fs");

const cog = require("../cog.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const fieldModule = require("../field.js");
const observationsModule = require("../observations.js");
const verify = require("../verify.js");

const HOUR_MS = 3600 * 1000;

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
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
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!isFinite(n)) throw new Error("--" + name + " must be a number, got " + JSON.stringify(value));
  return n;
}

/** The whole hours in the window, oldest first. */
function hoursIn(endMs, count) {
  const top = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  const times = [];
  for (let i = count - 1; i >= 0; i--) times.push(new Date(top - i * HOUR_MS));
  return times;
}

/** The 3DEP ground under a coordinate, from an already-derived domain. */
function elevationAt(derived, lat, lon) {
  return cog.sampleElevation({
    crs: derived.crs,
    width: derived.width,
    height: derived.height,
    transform: derived.transform,
    values: derived.elevation
  }, lat, lon);
}

/** The bearing a wind is coming from, from its east/north components. */
function bearingFrom(east, north) {
  return (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360;
}

function round(value, places) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

function tidy(score) {
  return {
    n: score.n,
    distinctSamples: score.distinctSamples,
    speed: {
      biasMps: round(score.speed.biasMps, 3),
      maeMps: round(score.speed.maeMps, 3),
      rmseMps: round(score.speed.rmseMps, 3),
      observedMeanMps: round(score.speed.observedMeanMps, 3),
      modelledMeanMps: round(score.speed.modelledMeanMps, 3)
    },
    direction: {
      n: score.direction.n,
      biasDeg: round(score.direction.biasDeg, 1),
      maeDeg: round(score.direction.maeDeg, 1),
      rmseDeg: round(score.direction.rmseDeg, 1),
      within30Deg: round(score.direction.within30Deg, 3)
    },
    vectorRmseMps: round(score.vectorRmseMps, 3),
    excluded: score.excluded,
    floor: {
      speedRmseMps: round(score.floor.speedRmseMps, 3),
      dirRmseDeg: round(score.floor.dirRmseDeg, 2)
    }
  };
}

/**
 * The whole run, with both services injected.
 *
 * Separated from `main` so the report — the pairing, the accounting for hours
 * that failed, the stratification, the table — can be graded offline against
 * stub services. The fetching is the uninteresting half and is tested where it
 * lives, in `observations.js` and `field.js`.
 */
async function buildReport(options) {
  const o = options || {};
  const source = o.source;
  const service = o.service;
  const ids = o.stations;
  const hours = o.hours === undefined ? 12 : o.hours;
  const forecastHour = o.forecastHour === undefined ? 0 : o.forecastHour;
  const radiusMiles = o.radiusMiles === undefined ? 0.5 : o.radiusMiles;
  const resolutionM = o.resolutionM === undefined ? 30 : o.resolutionM;
  const toleranceMs = o.toleranceMs === undefined ? verify.DEFAULT_TOLERANCE_MS : o.toleranceMs;
  const now = o.now || Date.now;

  if (!isFinite(o.endMs)) throw new Error("endMs is required: the newest hour to score");
  const validTimes = hoursIn(o.endMs, hours);
  const started = now();
  const stations = [];
  const allPairs = [];
  const failures = [];

  for (const id of ids) {
    const station = await source.station(id);
    const read = await source.observations(id, {
      start: new Date(validTimes[0].getTime() - HOUR_MS),
      end: new Date(validTimes[validTimes.length - 1].getTime() + HOUR_MS)
    });

    const samples = [];
    let terrain = null;

    for (const validTime of validTimes) {
      let field;
      try {
        field = await service.get({
          lat: station.lat,
          lon: station.lon,
          radiusMiles: radiusMiles,
          targetResolutionM: resolutionM,
          validTime: validTime,
          forecastHour: forecastHour
        });
      } catch (err) {
        // One bad hour is a fact about NOMADS or about The National Map, not a
        // reason to lose the other eleven. It is counted, because a score over
        // "the hours that worked" is a different claim if half of them did not.
        failures.push({ station: id, validTime: validTime.toISOString(), code: err.code || null, error: err.message });
        continue;
      }

      const fine = downscale.windAt(field, station.lat, station.lon);
      const reference = field.reference;

      if (!terrain) {
        terrain = {
          slopeDeg: derive.fieldAt(field.derived, "slopeDeg", station.lat, station.lon),
          tpi: derive.fieldAt(field.derived, "tpi", station.lat, station.lon),
          demElevationM: elevationAt(field.derived, station.lat, station.lon),
          modelOffsetM: field.offset ? round(field.offset.meanM, 1) : null,
          dataset: field.terrain.dataset,
          resolutionM: field.terrain.resolutionM,
          heightAglM: field.heightAglM === undefined ? null : field.heightAglM
        };
        terrain.class = verify.classifyTerrain(terrain);
      }

      samples.push({
        timeMs: validTime.getTime(),
        // The downscaled wind at the station, which is what the service answers.
        fine: fine ? { speedMps: fine.speedMps, fromDeg: fine.fromDeg } : { speedMps: null, fromDeg: null },
        // The single HRRR wind the whole domain was downscaled from: the
        // baseline this engine has to beat to be worth running.
        model: {
          speedMps: Math.hypot(reference.east, reference.north),
          fromDeg: bearingFrom(reference.east, reference.north)
        }
      });
    }

    const paired = verify.pair(read.records, samples, { toleranceMs: toleranceMs });
    for (const p of paired.pairs) {
      p.station = station;
      p.terrain = terrain;
      allPairs.push(p);
    }

    stations.push({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      elevationM: station.elevationM,
      terrain: terrain,
      observations: read.counts,
      rejected: read.rejected.length,
      samples: samples.length,
      paired: paired.pairs.length,
      unmatched: paired.unmatched.length,
      model: tidy(verify.score(paired.pairs, { read: function (p) { return p.sample.model; } })),
      downscaled: tidy(verify.score(paired.pairs, { read: function (p) { return p.sample.fine; } }))
    });
  }

  const byTerrain = {};
  for (const [label, scored] of Object.entries(
    verify.stratify(allPairs, function (p) { return p.terrain ? p.terrain.class : "unknown"; },
      { read: function (p) { return p.sample.fine; } })
  )) byTerrain[label] = tidy(scored);

  const report = {
    schemaVersion: 1,
    generated: new Date(started).toISOString(),
    window: {
      from: validTimes[0].toISOString(),
      to: validTimes[validTimes.length - 1].toISOString(),
      hours: hours,
      forecastHour: forecastHour,
      toleranceMinutes: toleranceMs / 60000
    },
    domain: { radiusMiles: radiusMiles, targetResolutionM: resolutionM },
    source: {
      observations: "NWS api.weather.gov station observations (ASOS/AWOS METAR)",
      model: "HRRR via NOMADS",
      terrain: "USGS 3DEP",
      independence: forecastHour === 0
        ? "NONE from HRRR: the analysis assimilates these stations. Downscaling is independent of them."
        : "partial: an f" + forecastHour + " forecast has not seen the observations at its own valid hour."
    },
    stations: stations,
    overall: {
      model: tidy(verify.score(allPairs, { read: function (p) { return p.sample.model; } })),
      downscaled: tidy(verify.score(allPairs, { read: function (p) { return p.sample.fine; } }))
    },
    byTerrain: byTerrain,
    failures: failures,
    elapsedMs: now() - started
  };

  return report;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!args.stations || args.stations === true) {
    process.stderr.write("--stations KBDU,KFNL is required; see the header of this file\n");
    process.exit(2);
  }

  // Three hours back by default: HRRR's availability lag is assumed to be 75
  // minutes and a station's observation has to have been published too, so the
  // newest hour that reliably has both sides is not the current one.
  const endMs = args.end ? Date.parse(String(args.end)) : Date.now() - 3 * HOUR_MS;
  if (Number.isNaN(endMs)) throw new Error("--end is not a time: " + args.end);

  const report = await buildReport({
    source: observationsModule.createObservationSource({}),
    service: fieldModule.createFieldService({}),
    stations: String(args.stations).split(",")
      .map(function (s) { return s.trim().toUpperCase(); })
      .filter(Boolean),
    hours: number(args.hours, 12, "hours"),
    forecastHour: number(args.forecast, 0, "forecast"),
    radiusMiles: number(args.radius, 0.5, "radius"),
    resolutionM: number(args.resolution, 30, "resolution"),
    toleranceMs: number(args.tolerance, 10, "tolerance") * 60 * 1000,
    endMs: endMs
  });

  if (args.out && args.out !== true) {
    fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2) + "\n");
  }

  process.stdout.write(summarise(report) + "\n");
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function line(label, score) {
  return [
    label.padEnd(14),
    String(score.n).padStart(5),
    String(score.distinctSamples).padStart(5),
    fixed(score.speed.biasMps, 2).padStart(9),
    fixed(score.speed.rmseMps, 2).padStart(9),
    fixed(score.direction.biasDeg, 1).padStart(9),
    fixed(score.direction.rmseDeg, 1).padStart(9),
    fixed(score.vectorRmseMps, 2).padStart(9)
  ].join(" ");
}

function fixed(value, places) {
  return value === null || value === undefined ? "—" : value.toFixed(places);
}

function summarise(report) {
  const head = ["candidate".padEnd(14), "obs".padStart(5), "hrs".padStart(5), "spd bias".padStart(9),
    "spd rmse".padStart(9), "dir bias".padStart(9), "dir rmse".padStart(9),
    "vec rmse".padStart(9)].join(" ");

  const out = [
    "WindSolver against measured wind",
    report.window.from + " to " + report.window.to + "  f" + report.window.forecastHour,
    report.source.independence,
    "",
    head,
    line("HRRR alone", report.overall.model),
    line("downscaled", report.overall.downscaled),
    "",
    "speed and vector errors are m/s, direction degrees; a perfect model scores " +
      fixed(report.overall.downscaled.floor.speedRmseMps, 2) + " m/s and " +
      fixed(report.overall.downscaled.floor.dirRmseDeg, 1) + "° against a rounded METAR",
    "obs is observations scored; hrs is the model hours behind them — a station " +
      "reporting every five minutes contributes several obs to one sample",
    ""
  ];

  if (Object.keys(report.byTerrain).length > 1) {
    out.push("downscaled, by the terrain under the station:");
    out.push(head);
    for (const [label, score] of Object.entries(report.byTerrain)) out.push(line(label, score));
    out.push("");
  }

  out.push("by station (downscaled):");
  out.push(head);
  for (const s of report.stations) {
    out.push(line(s.id + " " + (s.terrain ? s.terrain.class : "?"), s.downscaled));
  }

  if (report.failures.length) {
    out.push("");
    out.push(report.failures.length + " hour(s) could not be solved:");
    for (const f of report.failures.slice(0, 10)) {
      out.push("  " + f.station + " " + f.validTime + " " + (f.code || "") + " " + f.error);
    }
  }

  return out.join("\n");
}

module.exports = { hoursIn, bearingFrom, buildReport, summarise };

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(1);
  });
}
