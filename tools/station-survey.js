#!/usr/bin/env node
/**
 * Which stations stand in which landform, before any of them is scored.
 *
 *   node tools/station-survey.js --state CO --out co-stations.json
 *   node tools/station-survey.js --state CO,WY --class valley --limit 10
 *   node tools/station-survey.js --source fems --state CO --limit 200 --spread 30
 *
 * Options:
 *   --source     synoptic (default) or fems, the catalogue the stations come from
 *   --state      comma-separated two-letter states (default CO)
 *   --network    Synoptic network id (default 2, RAWS)
 *   --limit      stop after this many stations have been read (default 60)
 *   --spread     also choose this many stations spaced evenly across the
 *                position index, and print them as a set
 *   --radius     domain radius in miles around each station (default 0.5)
 *   --resolution target terrain resolution in metres (default 30)
 *   --position   radius of the landform index, in metres (default 500)
 *   --threshold  how far the index must be from zero before a station is
 *                called ridge or valley, in metres (default 15)
 *   --elevation  how far the published elevation may sit from the 3DEP ground
 *                under the coordinate before the station is called suspect,
 *                in metres (default 50)
 *   --class      print only stations in this class (ridge/valley/slope/flat)
 *   --out        write the full survey as JSON to this path
 *
 * **The station set is the experiment, and picking it by name is how you get
 * the answer you expected.** `tools/score-wind.js` reports a class per station,
 * but it reports it *after* paying an HRRR subset per station per hour — so
 * discovering that fifteen stations contain no valley costs the whole run. This
 * reads the ground alone: no atmosphere, no observations, one 3DEP window per
 * station, and it says what the stratum would be before anything is scored.
 *
 * **It also cannot tell you the set is representative.** A survey of every RAWS
 * in a state is a survey of where the land-management agencies put towers,
 * which is fire-prone ground with road access. Stations chosen from it are
 * still a convenience sample; what this removes is only the worse problem of
 * choosing them by their names.
 *
 * **A published coordinate can be wrong**, and a station whose elevation
 * disagrees with the 3DEP ground beneath it is one of the two. It is printed
 * as `suspect` rather than dropped, because at survey time the interesting
 * thing about it is that it exists — `score-wind.js` is where it is excluded.
 *
 * **`--source fems` is the one that can widen a sample.** Synoptic lists the
 * same masts and is easier to query, but its observation history stops about
 * six days back, so a station discovered through it still cannot be scored on
 * a past season. FEMS lists 2,088 RAWS with 2005 behind them and no account.
 * What a FEMS station then costs is a transmit minute — `tools/fems-stations.js`
 * against Synoptic's free window — so this prints the FEMS id a calibration
 * run needs beside the ground.
 *
 * **A class is a statement about a radius, and `--position` is that radius.**
 * Measurement 14 read the same Colorado RAWS twice. Over the 87 stations
 * readable at both, a 500 m disc gives 33 flat, 33 ridge, 19 slope and **2
 * valley**; a 2 km disc gives 15 flat, 51 ridge, 6 slope and **15 valley**, over
 * an index that reaches -185.7 m where the smaller disc bottomed out at -30.8.
 * Thirty-four of the 87 change class and fourteen change sign. Neither radius is
 * wrong: 500 m describes the bank a mast stands on, 2 km describes the valley
 * that bank is in. PICKLE GULCH sits 22.4 m above its own 500 m surroundings and
 * 22.6 m below its 2 km ones, which is a knoll inside a gulch, and both numbers
 * say so. **Compare a class only with one measured at the same radius, and say
 * the radius whenever a count is quoted** — `positionRadiusM` and
 * `positionThresholdM` ride on every station for that reason.
 *
 * **`--spread` chooses the set, and choosing it is the experiment.** Taking the
 * first N of a listing takes N stations sorted by whatever the service sorts
 * by; taking N spaced evenly across the position index puts stations at both
 * ends of the landform range on purpose. It does not make the sample random,
 * and it cannot: the ground a station is *on* is now chosen, so a difference
 * between the two ends is a difference between two chosen groups.
 */

"use strict";

const derive = require("../derive.js");
const field = require("../field.js");
const synoptic = require("../synoptic.js");
const fems = require("../fems.js");
const verify = require("../verify.js");
const cog = require("../cog.js");

const DEFAULT_LIMIT = 60;
const DEFAULT_POSITION_RADIUS_M = 500;
const DEFAULT_ELEVATION_TOLERANCE_M = 50;
const OPTIONS = [
  "source", "state", "network", "limit", "spread", "radius", "resolution",
  "position", "threshold", "elevation", "class", "out"
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[name] = true;
    } else {
      out[name] = next;
      i++;
    }
  }
  // An unrecognised flag is refused rather than ignored. A value that arrives
  // as its own word and is dropped produces a complete, plausible report with
  // one option quietly absent, which reads exactly like a report where that
  // option had nothing to say.
  for (const key of Object.keys(out)) {
    if (OPTIONS.indexOf(key) < 0) throw new Error("unrecognised option --" + key);
  }
  return out;
}

function round(value, places) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

/** Is this station in one of the states asked for? An unstated state is not. */
function inStates(station, states) {
  if (!states) return true;
  const wanted = String(states).toUpperCase().split(",")
    .map(function (s) { return s.trim(); }).filter(Boolean);
  if (!wanted.length) return true;
  if (typeof station.state !== "string" || !station.state) return false;
  return wanted.indexOf(station.state.toUpperCase()) >= 0;
}

/**
 * N stations spaced evenly across the position index, rather than the first N.
 *
 * The stations are ordered by landform and one is taken from each of N equal
 * slices of the ordering, so both ends of the range are in the set by
 * construction. Suspect coordinates and stations with no readable position are
 * not eligible — a set chosen on a landform nobody has measured is the thing
 * this is meant to prevent.
 */
function spread(stations, count) {
  const eligible = stations
    .filter(function (s) { return !s.suspect && Number.isFinite(s.positionIndexM); })
    .sort(function (a, b) { return a.positionIndexM - b.positionIndexM; });

  if (!count || count >= eligible.length) return eligible;
  if (count === 1) return [eligible[Math.floor((eligible.length - 1) / 2)]];

  const chosen = [];
  for (let i = 0; i < count; i++) {
    const at = Math.round((i * (eligible.length - 1)) / (count - 1));
    if (chosen.indexOf(eligible[at]) < 0) chosen.push(eligible[at]);
  }
  return chosen;
}

/**
 * The landform under one station, from a terrain read and nothing else.
 *
 * This is deliberately the same measurement `score-wind.js` makes, taken from
 * the same `derive` output, so that a station surveyed as `valley` here cannot
 * arrive in the score as something else.
 */
function landformAt(derived, station, opts) {
  const o = opts || {};
  const positionThresholdM = o.positionThresholdM === undefined
    ? verify.DEFAULT_POSITION_THRESHOLD_M : o.positionThresholdM;
  const position = derive.positionIndexAt(derived, station.lat, station.lon, {
    radiusM: o.positionRadiusM
  });
  const demElevationM = cog.sampleElevation({
    crs: derived.crs,
    width: derived.width,
    height: derived.height,
    transform: derived.transform,
    values: derived.elevation
  }, station.lat, station.lon);

  const terrain = {
    slopeDeg: derive.fieldAt(derived, "slopeDeg", station.lat, station.lon),
    tpi: derive.fieldAt(derived, "tpi", station.lat, station.lon),
    positionIndexM: position ? round(position.tpiM, 1) : null,
    positionRadiusM: position ? position.radiusM : o.positionRadiusM,
    positionCoverage: position ? round(position.coverage, 3) : null,
    positionThresholdM: positionThresholdM,
    demElevationM: demElevationM
  };
  terrain.class = verify.classifyTerrain(terrain, { positionIndexM: positionThresholdM });
  return terrain;
}

async function survey(opts) {
  const o = opts || {};
  const source = o.source;
  const service = o.service || field.createFieldService(o);
  const limit = o.limit === undefined ? DEFAULT_LIMIT : o.limit;
  const positionRadiusM = o.positionRadiusM === undefined
    ? DEFAULT_POSITION_RADIUS_M : o.positionRadiusM;
  const positionThresholdM = o.positionThresholdM === undefined
    ? verify.DEFAULT_POSITION_THRESHOLD_M : o.positionThresholdM;
  const elevationToleranceM = o.elevationToleranceM === undefined
    ? DEFAULT_ELEVATION_TOLERANCE_M : o.elevationToleranceM;

  const found = await source.search({
    state: o.states, network: o.network, status: "active", all: true
  });
  // Whether a station has an anemometer at all is not decided here: the
  // metadata's sensor list says only what position was published, and a wind
  // sensor with no published height reads the same as no wind sensor. The
  // timeseries is what settles it, and that is the scorer's business.
  //
  // The state is filtered here rather than in the query because FEMS' metadata
  // endpoint does not take one: it answers with every station it has or with
  // the ids it is given, so a state filter left to the service silently
  // becomes no filter at all.
  //
  // Nor is a dead mast filtered out, because FEMS does not say which they are:
  // `period_record_stop` reads `2024-12-31` for all 96 Colorado stations, live
  // and dead alike, so it dates the historic record and not the station. What
  // settles it is asking for observations, which is `tools/fems-stations.js`
  // and the scorer.
  const candidates = found.filter(function (s) {
    return Number.isFinite(s.lat) && Number.isFinite(s.lon) && inStates(s, o.states);
  });

  const stations = [];
  const failures = [];
  for (const station of candidates) {
    if (stations.length >= limit) break;
    let land;
    try {
      land = await service.ground.get({
        box: field.domainOf({
          lat: station.lat, lon: station.lon, radiusMiles: o.radiusMiles
        }).readBox,
        targetResolutionM: o.resolutionM,
        resolutionM: o.resolutionM
      });
    } catch (err) {
      failures.push({ id: station.id, code: err.code || null, message: err.message });
      continue;
    }

    const terrain = landformAt(land.derived, station, {
      positionRadiusM: positionRadiusM,
      positionThresholdM: positionThresholdM
    });
    const disagreementM = station.elevationM === null || terrain.demElevationM === null ||
      Number.isNaN(terrain.demElevationM)
      ? null
      : Math.abs(station.elevationM - terrain.demElevationM);

    stations.push({
      id: station.id,
      // The ids a later step needs: a FEMS run keys on the number, and
      // `tools/fems-stations.js` matches the two catalogues on the WRCC id.
      wrccId: station.wrccId === undefined ? null : station.wrccId,
      source: station.source === undefined ? null : station.source,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      elevationM: round(station.elevationM, 1),
      sensorHeightM: station.sensorHeightM === undefined ? null : station.sensorHeightM,
      demElevationM: round(terrain.demElevationM, 1),
      disagreementM: round(disagreementM, 1),
      suspect: disagreementM === null ? true : disagreementM > elevationToleranceM,
      slopeDeg: round(terrain.slopeDeg, 1),
      tpi: round(terrain.tpi, 2),
      positionIndexM: terrain.positionIndexM,
      positionCoverage: terrain.positionCoverage,
      // The radius and the threshold travel with the class, because the class
      // means nothing without them: the same Colorado catalogue is 3 valleys
      // over a 500 m disc and 15 over a 2 km one.
      positionRadiusM: terrain.positionRadiusM,
      positionThresholdM: terrain.positionThresholdM,
      class: terrain.class,
      dataset: land.dataset
    });
  }

  const byClass = {};
  for (const s of stations) {
    if (s.suspect) continue;
    byClass[s.class] = (byClass[s.class] || 0) + 1;
  }

  const chosen = o.spread ? spread(stations, o.spread) : null;

  return {
    generatedAt: new Date().toISOString(),
    query: {
      states: o.states,
      network: o.network === undefined ? null : o.network,
      radiusMiles: o.radiusMiles,
      resolutionM: o.resolutionM,
      positionRadiusM: positionRadiusM,
      positionThresholdM: positionThresholdM,
      elevationToleranceM: elevationToleranceM,
      limit: limit,
      spread: o.spread === undefined ? null : o.spread
    },
    listed: found.length,
    eligible: candidates.length,
    read: stations.length,
    byClass: byClass,
    stations: stations,
    spread: chosen ? chosen.map(function (s) { return s.id; }) : null,
    failures: failures
  };
}

function summarise(report, opts) {
  const o = opts || {};
  const lines = [];
  lines.push(
    report.listed + " stations listed, " + report.read + " read over " +
    report.query.positionRadiusM + " m of ground, ridge and valley beyond " +
    report.query.positionThresholdM + " m" +
    (report.failures.length ? ", " + report.failures.length + " unreadable" : ""));
  lines.push("");
  lines.push(Object.entries(report.byClass).map(function (e) {
    return e[1] + " " + e[0];
  }).join(", ") + "   (suspect coordinates excluded from these counts)");
  lines.push("");
  lines.push("id       class   posM  slope   elev   3DEP   diff  name");

  for (const s of report.stations) {
    if (o.onlyClass && s.class !== o.onlyClass) continue;
    lines.push(
      s.id.padEnd(8) +
      (s.suspect ? "SUSPECT" : s.class).padEnd(8) +
      String(s.positionIndexM === null ? "-" : s.positionIndexM).padStart(5) +
      String(s.slopeDeg === null ? "-" : s.slopeDeg).padStart(7) +
      String(s.elevationM === null ? "-" : Math.round(s.elevationM)).padStart(7) +
      String(s.demElevationM === null ? "-" : Math.round(s.demElevationM)).padStart(7) +
      String(s.disagreementM === null ? "-" : Math.round(s.disagreementM)).padStart(7) +
      "  " + (s.name || ""));
  }

  if (report.spread && report.spread.length) {
    const chosen = report.stations.filter(function (s) {
      return report.spread.indexOf(s.id) >= 0;
    }).sort(function (a, b) { return a.positionIndexM - b.positionIndexM; });
    lines.push("");
    lines.push(chosen.length + " chosen across the position index, " +
      chosen[0].positionIndexM + " m to " +
      chosen[chosen.length - 1].positionIndexM + " m:");
    lines.push("");
    lines.push(chosen.map(function (s) { return s.id; }).join(","));
    if (chosen.some(function (s) { return s.wrccId; })) {
      lines.push("");
      lines.push("WRCC ids, for calibrating a transmit minute:");
      lines.push(chosen.map(function (s) { return s.wrccId || s.id; }).join(","));
    }
  }

  lines.push("");
  lines.push("posM is the 500 m position index: the station's ground minus the mean of the");
  lines.push("disc around it. A class is only comparable with one measured at the same radius.");
  return lines.join("\n");
}

/** The catalogue the stations are listed from. */
function sourceOf(name) {
  if (name === undefined || name === "synoptic") {
    const token = process.env.SYNOPTIC_API_TOKEN;
    if (!token) throw new Error("SYNOPTIC_API_TOKEN is required in the environment");
    return synoptic.createSynopticSource({ token: token });
  }
  if (name === "fems") return fems.createFemsSource({});
  throw new Error("unknown --source " + JSON.stringify(name) + "; use synoptic or fems");
}

async function main(argv) {
  const args = parseArgs(argv);

  const report = await survey({
    source: sourceOf(args.source === undefined ? undefined : String(args.source)),
    states: args.state ? String(args.state).toUpperCase() : "CO",
    spread: args.spread === undefined ? null : Number(args.spread),
    network: args.network === undefined ? synoptic.RAWS_NETWORK_ID : Number(args.network),
    limit: args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit),
    radiusMiles: args.radius === undefined ? 0.5 : Number(args.radius),
    resolutionM: args.resolution === undefined ? 30 : Number(args.resolution),
    positionRadiusM: args.position === undefined
      ? DEFAULT_POSITION_RADIUS_M : Number(args.position),
    positionThresholdM: args.threshold === undefined
      ? verify.DEFAULT_POSITION_THRESHOLD_M : Number(args.threshold),
    elevationToleranceM: args.elevation === undefined
      ? DEFAULT_ELEVATION_TOLERANCE_M : Number(args.elevation)
  });

  if (args.out) {
    require("fs").writeFileSync(String(args.out), JSON.stringify(report, null, 2));
  }
  process.stdout.write(summarise(report, {
    onlyClass: typeof args.class === "string" ? args.class : null
  }) + "\n");
}

module.exports = { landformAt, survey, summarise, spread, inStates, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}
