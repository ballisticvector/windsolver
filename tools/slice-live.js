#!/usr/bin/env node
/**
 * One line through a live field, and the profile a consumer would be handed.
 *
 * `tools/field-live.js` answers whether the two services compose over a box.
 * This is the next question and the one a consumer actually asks: cut a line
 * out of that box, resolve the wind onto it, stack it over a few heights, and
 * check the result against the published contract rather than against itself.
 * Numbers quoted about the view should come from a run of this.
 *
 *   node tools/slice-live.js --lat 40.0150 --lon -105.2705 --bearing 90 --range 1000
 *
 * `--range` and `--step` are in yards and `--heights` in feet, because that is
 * what the first consumer speaks; everything inside is metres. Other options:
 * --resolution (metres, default 10), --shelter, --json.
 */

"use strict";

const field = require("../field.js");
const profile = require("../profile.js");
const slice = require("../slice.js");

const YARDS_TO_M = 0.9144;
const FEET_TO_M = 0.3048;

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

async function main() {
  const args = parse(process.argv.slice(2));
  const from = {
    lat: Number(args.lat === undefined ? 40.015 : args.lat),
    lon: Number(args.lon === undefined ? -105.2705 : args.lon)
  };
  const bearingDeg = Number(args.bearing === undefined ? 90 : args.bearing);
  const rangeYards = Number(args.range === undefined ? 1000 : args.range);
  const stepYards = Number(args.step === undefined ? 100 : args.step);
  const heightsFt = (args.heights === undefined ? "2,5,10,20,50" : args.heights)
    .split(",").map(Number);

  const lengthM = rangeYards * YARDS_TO_M;
  const stepM = stepYards * YARDS_TO_M;
  const heightsAglM = heightsFt.map(function (ft) { return ft * FEET_TO_M; });

  const service = field.createFieldService({});
  const spec = {
    box: slice.boxFor(from, bearingDeg, lengthM, { stepM: stepM }),
    targetResolutionM: Number(args.resolution === undefined ? 10 : args.resolution),
    shelter: args.shelter ? true : undefined
  };

  const started = Date.now();
  const live = await service.get(spec);
  const fieldMs = Date.now() - started;

  const cutStarted = Date.now();
  const plane = slice.plane(live, {
    from: from,
    bearingDeg: bearingDeg,
    lengthM: lengthM,
    stepM: stepM,
    heightsAglM: heightsAglM
  });
  const cutMs = Date.now() - cutStarted;

  const sent = slice.toWindProfile(plane, {
    source: "WindSolver HRRR " + new Date(live.validTime).toISOString() +
      " + 3DEP " + live.terrain.resolutionM + " m",
    terrainResolutionM: live.terrain.resolutionM,
    windSourceResolutionM: 3000
  });
  const check = profile.validateWindProfile(sent, { shotAzimuthDeg: bearingDeg });

  if (args.json) {
    console.log(JSON.stringify({
      spec: spec, validTime: live.validTime, plane: plane, windProfile: sent, check: check,
      timing: { fieldMs: fieldMs, cutMs: cutMs }
    }, null, 2));
    return;
  }

  const mph = (m) => (m * 2.23694).toFixed(2);
  const at10 = heightsFt.indexOf(10) === -1 ? 0 : heightsFt.indexOf(10);

  console.log("valid          " + new Date(live.validTime).toISOString() +
    ", field " + live.width + " x " + live.height + " at " +
    live.weights.spacingM.x.toFixed(2) + " x " + live.weights.spacingM.y.toFixed(2) +
    " m of " + live.terrain.dataset);
  console.log("line           " + rangeYards + " yd on " + bearingDeg + "°, " +
    plane.stations.length + " stations, " + heightsFt.length + " heights");
  console.log("model wind     " + mph(Math.hypot(live.reference.east, live.reference.north)) +
    " mph, " + live.reference.cellsAcross.toFixed(2) + " HRRR cells across the box");
  console.log("convergence    " + plane.convergenceDeg.toFixed(4) +
    "° between the muzzle's bearing and the target's");
  console.log("contract       " + (check.ok ? "valid v1 windProfile" : check.code + ": " + check.reason));
  console.log("");
  console.log("  yards   ground   wind        from   along    cross   (at " + heightsFt[at10] + " ft)");
  for (let i = 0; i < plane.stations.length; i++) {
    const s = plane.stations[i];
    const f = plane.factors[at10];
    console.log(
      "  " + (s.distanceM / YARDS_TO_M).toFixed(0).padStart(5) +
      "   " + (s.elevationM === null ? "     -" : s.elevationM.toFixed(0).padStart(6)) +
      "   " + (mph(s.speedMps * f) + " mph").padStart(9) +
      "   " + s.fromDeg.toFixed(0).padStart(4) + "°" +
      "   " + mph(s.alongMps * f).padStart(6) +
      "   " + mph(s.crossMps * f).padStart(6)
    );
  }
  console.log("");
  console.log("  cross-wind in fps, [height][range] as the contract indexes it");
  console.log("        " + plane.distancesM.map(function (d) {
    return (d / YARDS_TO_M).toFixed(0).padStart(7);
  }).join(""));
  for (let j = 0; j < heightsFt.length; j++) {
    console.log("  " + (heightsFt[j] + " ft").padStart(6) +
      sent.vFps[j].map(function (v) { return v.toFixed(2).padStart(7); }).join(""));
  }
  console.log("");
  console.log("timing         " + fieldMs + " ms for the field, " + cutMs + " ms to cut the line");
}

main().catch((err) => {
  console.error(err.code ? err.code + ": " + err.message : err);
  process.exitCode = 1;
});
