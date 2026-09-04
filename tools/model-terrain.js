#!/usr/bin/env node
/**
 * What ground does the model think it is blowing over?
 *
 *   node tools/model-terrain.js --stations PCPC2,KSHC2 --at 2026-09-04T18:00:00Z
 *   node tools/model-terrain.js --survey co-stations.json --forecast 6
 *
 * Options:
 *   --stations   comma-separated Synoptic station ids
 *   --survey     read the ids out of a `station-survey.js` JSON file instead
 *   --at         valid time, ISO (default: the last whole hour)
 *   --forecast   forecast hour of the cycle to read (default 6)
 *   --radius     domain radius in miles for the 3DEP read (default 0.5)
 *   --resolution target terrain resolution in metres (default 30)
 *   --position   radius of the fine landform index, in metres (default 500)
 *   --model      radius of the model's own landform index, in km (default 7.5)
 *   --out        write the comparison as JSON to this path
 *
 * **A 3 km model has its own mountains, and they are not the ones under the
 * station.** Every terrain correction in `downscale.js` is applied on top of a
 * wind that was already computed over HRRR's smoothed orography, so the part of
 * the landform the model can already see is counted twice and the part it
 * cannot see is all that is missing. Which of those dominates decides whether
 * the correction should be applied to the terrain or to the terrain *anomaly*,
 * and that is a question about the two elevation fields alone — no wind, no
 * observations, nothing to fit.
 *
 * So this fetches HRRR's surface orography over a box and, at each station,
 * prints it beside the 3DEP ground: the difference, the fine landform index the
 * downscaling reacts to, and the model's own landform index at its own scale.
 *
 * **It measures a disagreement, not an error.** Neither field is wrong: HRRR's
 * orography is the ground its dynamics ran over and is exactly right for that
 * purpose. A large difference means the correction has real work to do there; a
 * small one means it is redoing work already done.
 */

"use strict";

const fs = require("fs");
const cog = require("../cog.js");
const derive = require("../derive.js");
const field = require("../field.js");
const hrrr = require("../hrrr.js");
const nomads = require("../nomads.js");
const synoptic = require("../synoptic.js");

const DEFAULT_FORECAST_HOUR = 6;
const DEFAULT_RADIUS_MILES = 0.5;
const DEFAULT_RESOLUTION_M = 30;
const DEFAULT_POSITION_RADIUS_M = 500;

/**
 * Radius of the model's own landform index, in km.
 *
 * HRRR's grid is 3 km, so a disc of 7.5 km is the smallest one that holds a
 * meaningful number of neighbouring cells (roughly 20) rather than the eight
 * touching it. It is a scale chosen to match the grid, not a physical length.
 */
const DEFAULT_MODEL_RADIUS_KM = 7.5;

/** Degrees of latitude to leave around the stations, so no station is on an edge. */
const BOX_MARGIN_DEG = 0.3;

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

/** A box that holds every station with room to spare. */
function boxAround(stations, marginDeg) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const s of stations) {
    if (s.lon < west) west = s.lon;
    if (s.lon > east) east = s.lon;
    if (s.lat < south) south = s.lat;
    if (s.lat > north) north = s.lat;
  }
  return {
    west: west - marginDeg,
    east: east + marginDeg,
    south: south - marginDeg,
    north: north + marginDeg
  };
}

/**
 * The grid point nearest a coordinate, by flat distance with longitude
 * shortened for latitude. Over a 3 km grid the curvature of the earth across
 * one cell is far below the cell, so the cheap metric picks the same point the
 * expensive one would.
 */
function nearestPoint(record, lat, lon) {
  let index = -1;
  let best = Infinity;
  const scale = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < record.values.length; i++) {
    const dLat = record.latitudes[i] - lat;
    const dLon = (record.longitudes[i] - lon) * scale;
    const d = dLat * dLat + dLon * dLon;
    if (d < best) { best = d; index = i; }
  }
  if (index < 0) return null;
  return { index: index, distanceKm: Math.sqrt(best) * 111.32 };
}

/**
 * The model's own landform index: its ground at a point, against the mean of
 * its ground within `radiusKm`. Deliberately the same measurement
 * `derive.positionIndexAt` makes on the DEM, so the two numbers can be read
 * side by side — one at the model's scale, one at the station's.
 */
function modelPositionIndex(record, index, radiusKm) {
  const lat0 = record.latitudes[index];
  const lon0 = record.longitudes[index];
  const scale = Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < record.values.length; i++) {
    const dLat = (record.latitudes[i] - lat0) * 111.32;
    const dLon = (record.longitudes[i] - lon0) * 111.32 * scale;
    if (dLat * dLat + dLon * dLon > radiusKm * radiusKm) continue;
    if (record.values[i] === null || Number.isNaN(record.values[i])) continue;
    sum += record.values[i];
    n++;
  }
  return n > 1 ? record.values[index] - sum / n : null;
}

async function compare(opts) {
  const o = opts || {};
  const source = o.source;
  const service = o.service || field.createFieldService(o);
  const positionRadiusM = o.positionRadiusM === undefined
    ? DEFAULT_POSITION_RADIUS_M : o.positionRadiusM;
  const modelRadiusKm = o.modelRadiusKm === undefined
    ? DEFAULT_MODEL_RADIUS_KM : o.modelRadiusKm;

  const stations = [];
  for (const id of o.ids) {
    const station = await source.station(id);
    if (Number.isFinite(station.lat) && Number.isFinite(station.lon)) stations.push(station);
  }
  if (!stations.length) throw new Error("no stations with usable coordinates");

  const box = boxAround(stations, BOX_MARGIN_DEG);
  const forecastHour = o.forecastHour === undefined ? DEFAULT_FORECAST_HOUR : o.forecastHour;
  const validTime = o.at || new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const cycle = hrrr.analysisCycleFor(
    new Date(validTime.getTime() - forecastHour * 3600 * 1000)
  );
  const fetchBox = o.fetchHrrrBox || nomads.fetchHrrrBox;
  const got = await fetchBox(Object.assign({}, o, {
    box: box,
    cycle: cycle,
    forecastHour: forecastHour,
    variables: ["HGT"],
    levels: ["surface"]
  }));
  const orography = got.records.find(function (r) {
    return r.parameter === "HGT" && r.level && r.level.name === "surface";
  });
  if (!orography) throw new Error("the cycle carried no surface HGT record");

  const rows = [];
  const failures = [];
  for (const station of stations) {
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

    const demElevationM = cog.sampleElevation({
      crs: land.derived.crs,
      width: land.derived.width,
      height: land.derived.height,
      transform: land.derived.transform,
      values: land.derived.elevation
    }, station.lat, station.lon);
    const position = derive.positionIndexAt(land.derived, station.lat, station.lon, {
      radiusM: positionRadiusM
    });
    const at = nearestPoint(orography, station.lat, station.lon);
    const modelElevationM = orography.values[at.index];

    rows.push({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      demElevationM: round(demElevationM, 1),
      modelElevationM: round(modelElevationM, 1),
      modelMinusDemM: round(modelElevationM - demElevationM, 1),
      gridDistanceKm: round(at.distanceKm, 2),
      positionIndexM: position ? round(position.tpiM, 1) : null,
      positionRadiusM: positionRadiusM,
      modelPositionIndexM: round(modelPositionIndex(orography, at.index, modelRadiusKm), 1),
      modelRadiusKm: modelRadiusKm,
      dataset: land.dataset
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    model: {
      source: "HRRR",
      cycle: cycle,
      forecastHour: forecastHour,
      validTime: hrrr.cycleValidTime(cycle, forecastHour).toISOString(),
      url: got.url,
      points: orography.values.length
    },
    query: {
      box: box,
      radiusMiles: o.radiusMiles,
      resolutionM: o.resolutionM,
      positionRadiusM: positionRadiusM,
      modelRadiusKm: modelRadiusKm
    },
    stations: rows,
    failures: failures
  };
}

function formatReport(report) {
  const lines = [];
  lines.push("HRRR surface orography, cycle " +
    report.model.validTime + " f" + String(report.model.forecastHour).padStart(2, "0") +
    ", " + report.model.points + " points");
  lines.push("");
  lines.push(
    "station".padEnd(9) + "3DEP m".padStart(8) + "model m".padStart(9) +
    "model-3DEP".padStart(12) +
    ("tpi" + report.query.positionRadiusM + "m").padStart(11) +
    ("model tpi" + report.query.modelRadiusKm + "km").padStart(20));
  for (const s of report.stations) {
    lines.push(
      s.id.padEnd(9) +
      String(s.demElevationM === null ? "null" : s.demElevationM.toFixed(0)).padStart(8) +
      String(s.modelElevationM === null ? "null" : s.modelElevationM.toFixed(0)).padStart(9) +
      String(s.modelMinusDemM === null ? "null" : s.modelMinusDemM.toFixed(0)).padStart(12) +
      String(s.positionIndexM === null ? "null" : s.positionIndexM.toFixed(1)).padStart(11) +
      String(s.modelPositionIndexM === null ? "null" : s.modelPositionIndexM.toFixed(1)).padStart(20));
  }
  if (report.failures.length) {
    lines.push("");
    lines.push("terrain could not be read at " + report.failures.length + " station(s):");
    for (const f of report.failures) {
      lines.push("  " + f.id + "  " + (f.code || "") + "  " + f.message);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let ids = [];
  if (args.survey && args.survey !== true) {
    const survey = JSON.parse(fs.readFileSync(args.survey, "utf8"));
    ids = (survey.stations || []).map(function (s) { return s.id; });
  }
  if (args.stations && args.stations !== true) {
    ids = ids.concat(String(args.stations).split(",").map(function (s) { return s.trim(); }));
  }
  ids = ids.filter(function (id, i) { return id && ids.indexOf(id) === i; });
  if (!ids.length) throw new Error("--stations or --survey is required");

  const token = process.env.SYNOPTIC_API_TOKEN;
  if (!token) throw new Error("SYNOPTIC_API_TOKEN is not set");

  const report = await compare({
    ids: ids,
    source: synoptic.createSynopticSource({ token: token }),
    at: args.at && args.at !== true ? new Date(args.at) : undefined,
    forecastHour: args.forecast && args.forecast !== true
      ? Number(args.forecast) : DEFAULT_FORECAST_HOUR,
    radiusMiles: args.radius && args.radius !== true
      ? Number(args.radius) : DEFAULT_RADIUS_MILES,
    resolutionM: args.resolution && args.resolution !== true
      ? Number(args.resolution) : DEFAULT_RESOLUTION_M,
    positionRadiusM: args.position && args.position !== true
      ? Number(args.position) : DEFAULT_POSITION_RADIUS_M,
    modelRadiusKm: args.model && args.model !== true
      ? Number(args.model) : DEFAULT_MODEL_RADIUS_KM
  });

  if (args.out && args.out !== true) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  }
  console.log(formatReport(report));
}

if (require.main === module) {
  main().catch(function (err) {
    console.error(err.code ? err.code + ": " + err.message : err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MODEL_RADIUS_KM,
  boxAround,
  nearestPoint,
  modelPositionIndex,
  compare,
  formatReport
};
