#!/usr/bin/env node
/**
 * Which stations stand in which landform, before any of them is scored.
 *
 *   node tools/station-survey.js --state CO --out co-stations.json
 *   node tools/station-survey.js --state CO,WY --class valley --limit 10
 *
 * Options:
 *   --state      comma-separated two-letter states (default CO)
 *   --network    Synoptic network id (default 2, RAWS)
 *   --limit      stop after this many stations have been read (default 60)
 *   --radius     domain radius in miles around each station (default 0.5)
 *   --resolution target terrain resolution in metres (default 30)
 *   --position   radius of the landform index, in metres (default 500)
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
 */

"use strict";

const derive = require("../derive.js");
const field = require("../field.js");
const synoptic = require("../synoptic.js");
const verify = require("../verify.js");
const cog = require("../cog.js");

const DEFAULT_LIMIT = 60;
const DEFAULT_POSITION_RADIUS_M = 500;
const DEFAULT_ELEVATION_TOLERANCE_M = 50;

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
  return out;
}

function round(value, places) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
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
    demElevationM: demElevationM
  };
  terrain.class = verify.classifyTerrain(terrain);
  return terrain;
}

async function survey(opts) {
  const o = opts || {};
  const source = o.source;
  const service = o.service || field.createFieldService(o);
  const limit = o.limit === undefined ? DEFAULT_LIMIT : o.limit;
  const positionRadiusM = o.positionRadiusM === undefined
    ? DEFAULT_POSITION_RADIUS_M : o.positionRadiusM;
  const elevationToleranceM = o.elevationToleranceM === undefined
    ? DEFAULT_ELEVATION_TOLERANCE_M : o.elevationToleranceM;

  const found = await source.search({
    state: o.states, network: o.network, status: "active"
  });
  // Whether a station has an anemometer at all is not decided here: the
  // metadata's sensor list says only what position was published, and a wind
  // sensor with no published height reads the same as no wind sensor. The
  // timeseries is what settles it, and that is the scorer's business.
  const candidates = found.filter(function (s) {
    return Number.isFinite(s.lat) && Number.isFinite(s.lon);
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

    const terrain = landformAt(land.derived, station, { positionRadiusM: positionRadiusM });
    const disagreementM = station.elevationM === null || terrain.demElevationM === null ||
      Number.isNaN(terrain.demElevationM)
      ? null
      : Math.abs(station.elevationM - terrain.demElevationM);

    stations.push({
      id: station.id,
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
      class: terrain.class,
      dataset: land.dataset
    });
  }

  const byClass = {};
  for (const s of stations) {
    if (s.suspect) continue;
    byClass[s.class] = (byClass[s.class] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    query: {
      states: o.states,
      network: o.network === undefined ? null : o.network,
      radiusMiles: o.radiusMiles,
      resolutionM: o.resolutionM,
      positionRadiusM: positionRadiusM,
      elevationToleranceM: elevationToleranceM,
      limit: limit
    },
    listed: found.length,
    read: stations.length,
    byClass: byClass,
    stations: stations,
    failures: failures
  };
}

function summarise(report, opts) {
  const o = opts || {};
  const lines = [];
  lines.push(
    report.listed + " stations listed, " + report.read + " read over " +
    report.query.positionRadiusM + " m of ground" +
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

  lines.push("");
  lines.push("posM is the 500 m position index: the station's ground minus the mean of the");
  lines.push("disc around it. A class is only comparable with one measured at the same radius.");
  return lines.join("\n");
}

async function main(argv) {
  const args = parseArgs(argv);
  const token = process.env.SYNOPTIC_API_TOKEN;
  if (!token) throw new Error("SYNOPTIC_API_TOKEN is required in the environment");

  const report = await survey({
    source: synoptic.createSynopticSource({ token: token }),
    states: args.state ? String(args.state).toUpperCase() : "CO",
    network: args.network === undefined ? synoptic.RAWS_NETWORK_ID : Number(args.network),
    limit: args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit),
    radiusMiles: args.radius === undefined ? 0.5 : Number(args.radius),
    resolutionM: args.resolution === undefined ? 30 : Number(args.resolution),
    positionRadiusM: args.position === undefined
      ? DEFAULT_POSITION_RADIUS_M : Number(args.position),
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

module.exports = { landformAt, survey, summarise, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}
