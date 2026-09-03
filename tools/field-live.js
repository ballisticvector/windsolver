#!/usr/bin/env node
/**
 * One field over real ground, from the two live services.
 *
 * The suite grades the arithmetic with fixtures and no network; this is the
 * other question — whether a 3DEP window, a NOMADS subset and the downscaling
 * actually compose over a real coordinate, and what the answer costs in bytes,
 * requests and seconds. Numbers quoted anywhere about this path should come
 * from a run of this, not from an estimate.
 *
 *   node tools/field-live.js --lat 40.0150 --lon -105.2705 --radius 1
 *
 * Options: --resolution (metres, default 10), --shelter, --level, --json.
 */

"use strict";

const cog = require("../cog.js");
const downscale = require("../downscale.js");
const field = require("../field.js");
const proj = require("../proj.js");

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

/** The bearing the wind is coming from, from east/north components. */
function bearingFrom(east, north) {
  return (Math.atan2(-east, -north) * 180 / Math.PI + 360) % 360;
}

/**
 * How much of the box the caller asked for is undefined.
 *
 * The grid covers the padded read box, whose border is undefined by
 * construction — that is what the padding is for. The number worth reporting is
 * the one inside the requested box, which should be zero.
 */
function insideDomain(f) {
  let total = 0;
  let missing = 0;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const at = cog.pixelCentre(f.weights, x, y);
      const ll = proj.toGeographic(f.weights.crs, at.x, at.y);
      if (ll.lat < f.domain.south || ll.lat > f.domain.north) continue;
      if (ll.lon < f.domain.west || ll.lon > f.domain.east) continue;
      total++;
      if (Number.isNaN(f.speedMps[y * f.width + x])) missing++;
    }
  }
  return total ? missing / total : NaN;
}

function stats(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  return { min: min, max: max, mean: n ? sum / n : NaN, defined: n };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const lat = Number(args.lat === undefined ? 40.015 : args.lat);
  const lon = Number(args.lon === undefined ? -105.2705 : args.lon);
  const radiusMiles = Number(args.radius === undefined ? 1 : args.radius);
  const targetResolutionM = Number(args.resolution === undefined ? 10 : args.resolution);

  const service = field.createFieldService({});
  const spec = {
    lat: lat,
    lon: lon,
    radiusMiles: radiusMiles,
    targetResolutionM: targetResolutionM,
    level: args.level || field.DEFAULT_LEVEL,
    shelter: args.shelter ? true : undefined
  };

  const started = Date.now();
  const cold = await service.get(spec);
  const coldMs = Date.now() - started;

  const warmStarted = Date.now();
  await service.get(spec);
  const warmMs = Date.now() - warmStarted;

  const speed = stats(cold.speedMps);
  const inside = insideDomain(cold);
  const factor = stats(cold.factor);
  const elevation = stats(cold.weights.elevation);
  const centre = downscale.windAt(cold, lat, lon);

  const report = {
    at: { lat: lat, lon: lon, radiusMiles: radiusMiles },
    validTime: cold.validTime,
    reference: {
      east: cold.reference.east,
      north: cold.reference.north,
      speedMps: Math.hypot(cold.reference.east, cold.reference.north),
      fromDeg: bearingFrom(cold.reference.east, cold.reference.north),
      heightAglM: cold.reference.heightAglM,
      cellsAcross: cold.reference.cellsAcross
    },
    terrain: cold.terrain,
    grid: { width: cold.width, height: cold.height, spacingM: cold.terrain.spacingM },
    elevationM: elevation,
    speedMps: speed,
    factor: factor,
    undefinedFraction: cold.stats.undefinedFraction,
    undefinedInsideDomain: inside,
    centre: centre,
    offset: cold.offset,
    timing: { coldMs: coldMs, warmMs: warmMs },
    caches: service.summary()
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const mph = (m) => (m * 2.23694).toFixed(2);
  console.log("valid          " + new Date(cold.validTime).toISOString() +
    "  (" + cold.reference.heightAglM + " m AGL)");
  console.log("model wind     " + mph(report.reference.speedMps) + " mph, " +
    "east " + cold.reference.east.toFixed(2) + " north " + cold.reference.north.toFixed(2) + " m/s, " +
    cold.reference.cellsAcross.toFixed(2) + " HRRR cells across the box");
  console.log("terrain        " + cold.terrain.dataset + ", " + cold.width + " x " + cold.height +
    " at " + cold.terrain.resolutionM + " m, " + (cold.terrain.voidFraction * 100).toFixed(2) + "% void, " +
    (cold.terrain.bytesRead / 1048576).toFixed(2) + " MB in " + cold.terrain.requests + " requests" +
    (cold.terrain.coarserDataset
      ? ", " + (cold.terrain.filledFromCoarser / (cold.width * cold.height) * 100).toFixed(2) +
        "% filled from " + cold.terrain.coarserDataset
      : ""));
  console.log("elevation      " + elevation.min.toFixed(0) + " to " + elevation.max.toFixed(0) +
    " m, mean " + elevation.mean.toFixed(0));
  if (cold.offset) {
    console.log("model ground   " + cold.offset.modelElevationM.toFixed(0) + " m, real ground is " +
      cold.offset.minM.toFixed(0) + " to +" + cold.offset.maxM.toFixed(0) + " m of that");
  }
  console.log("downscaled     " + mph(speed.min) + " to " + mph(speed.max) + " mph, mean " +
    mph(speed.mean) + "; factor " + factor.min.toFixed(3) + " to " + factor.max.toFixed(3));
  console.log("at the centre  " + mph(centre.speedMps) + " mph from " + centre.fromDeg.toFixed(0) +
    "°, model says " + mph(report.reference.speedMps) + " mph");
  console.log("undefined      " + (cold.stats.undefinedFraction * 100).toFixed(1) + "% of the read grid, " +
    (inside * 100).toFixed(1) + "% inside the box that was asked for");
  console.log("timing         " + coldMs + " ms cold, " + warmMs + " ms warm");
  console.log("caches         ground " + report.caches.ground.loads + " loads / " +
    report.caches.ground.hits + " hits / " + report.caches.ground.rejected + " too big for the budget (" +
    (report.caches.ground.maxBytes / 1048576).toFixed(0) + " MB), air " +
    report.caches.atmosphere.loads + " loads / " + report.caches.atmosphere.hits + " hits");
}

main().catch((err) => {
  console.error(err.code ? err.code + ": " + err.message : err);
  process.exitCode = 1;
});
