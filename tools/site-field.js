#!/usr/bin/env node
/**
 * One wind, one place, and what the ground does to it along a line.
 *
 *   node tools/site-field.js --lat 36.77 --lon -104.49 --speed 6 --from 135 \
 *     --bearing 45 --length 3520 --height 2
 *
 * **The wind comes from the caller, not from a model.** That is the whole point
 * of this tool and the reason it touches no weather service at all: somebody
 * standing on the ground with an anemometer has a better wind at their own
 * position than a 3 km forecast cell does, and what they cannot get is the wind
 * two thousand yards away over ground they cannot walk to. Terrain is the only
 * thing fetched, so this also works during a NOMADS outage and over a cached
 * domain with no connectivity at all.
 *
 * Options:
 *   --lat --lon   where the wind was measured, decimal degrees
 *   --speed       measured wind speed in mph
 *   --from        measured bearing the wind comes from, degrees true
 *   --height      height above ground the wind was measured at, metres
 *                 (default 2 — about chest height on a tripod)
 *   --bearing     the line to report along, degrees true from --lat/--lon
 *   --length      how far along it, yards (default 3520, two miles)
 *   --radius      domain radius in miles (default 2). **The domain has to hold
 *                 the landform**: a half-mile box in a canyon contains no
 *                 canyon walls and the solve has nothing to act on.
 *   --resolution  target terrain resolution in metres (default 30)
 *   --layers      vertical layers in the solve (default 16)
 *   --stretch     geometric ratio between them (default 1.25)
 *   --r           stability: 1 lets the flow over a hill, small sends it around
 *   --json        write the transect as JSON to this path
 *
 * **What this does not do, and it is the thing most likely to be assumed.** The
 * measured wind is used as the *domain* wind — the free stream the terrain then
 * bends — and not as a constraint the solved field has to match at the
 * measuring point. If the anemometer is standing somewhere sheltered, the whole
 * field is seeded too slow and every number downrange inherits it. Matching a
 * solved field to an observation at one coordinate is an inverse problem
 * (WindNinja calls it point initialisation); it is not implemented here and
 * this tool says so on every run rather than in a comment nobody reads.
 *
 * And nothing here is validated. `docs/downscaling.md` is the standing record:
 * no candidate in this project has yet beaten raw HRRR on any station set, and
 * `confidence` is `null` for that reason. What the measurements do support is
 * the *shape* — a valley turned a 45 degree wind 48 degrees onto its axis and
 * that survived a six-fold change in domain height, where the speed magnitude
 * moved 28% over the same range. Read the turning, not the number.
 */

"use strict";

const fs = require("fs");

const dem = require("../dem.js");
const derive = require("../derive.js");
const fieldModule = require("../field.js");
const mass = require("../mass.js");
const proj = require("../proj.js");
const slice = require("../slice.js");
const terrainModule = require("../terrain.js");

const MPS_PER_MPH = 0.44704;
const M_PER_YARD = 0.9144;

const FLAGS = ["lat", "lon", "speed", "from", "height", "bearing", "length",
  "radius", "resolution", "layers", "stretch", "r", "json"];

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    if (!FLAGS.includes(name)) {
      throw new Error("unknown option --" + name + "; see the header of this file");
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[name] = true; continue; }
    out[name] = next;
    i++;
  }
  return out;
}

function number(value, fallback, name) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("--" + name + " must be a number");
  return n;
}

/**
 * The elevation grid alone: no derivatives, no weather, one terrain read.
 *
 * **With the same backfill `field.js` does, and for the same reason.** A hole is
 * not a rare event at 1 m — TNM reports coverage from tile footprints and a void
 * is a property of the pixels — so the fine product can be chosen and then be
 * nodata over half the box. Without this the first run over the Whittington
 * Center lost every point past 660 yards to "no terrain here" on ground that is
 * plainly there.
 */
async function groundUnder(spec) {
  const domain = fieldModule.domainOf(spec);
  // **`mosaic` needs the box, or it keeps the first tile's own extent.** Without
  // it the canvas is `blankLike(base)` — whatever rectangle 3DEP happened to
  // return — and the coordinate that was asked about can land anywhere in it.
  // Over the Whittington Center it landed 16 rows from the north edge of a
  // 129-row grid, so a line running north-east left the domain at 880 yards and
  // every point past it read "no terrain here" over ground that is plainly
  // there.
  const onBox = Object.assign({}, spec, { box: domain.box });
  const read = await terrainModule.readTerrain(domain.readBox, spec);
  let grid = fieldModule.mosaic(read.grids, onBox);
  let filledFrom = null;
  if (grid.voidFraction > 0) {
    const only = dem.coarserThan(read.dataset ? read.dataset.id : null);
    if (only.length) {
      const coarse = await terrainModule.readTerrain(domain.readBox,
        Object.assign({}, spec, { only: only }));
      grid = fieldModule.mosaic([grid].concat(coarse.grids), onBox);
      filledFrom = coarse.dataset ? coarse.dataset.label : null;
    }
  }
  return { domain: domain, grid: grid, dataset: read.dataset, filledFrom: filledFrom };
}

/** Fractional column and row of a coordinate on the grid it was read onto. */
function pixelOf(grid, lat, lon) {
  const m = proj.fromGeographic(grid.crs, lat, lon);
  return {
    x: (m.x - grid.transform.originX) / grid.transform.scaleX - 0.5,
    y: (m.y - grid.transform.originY) / grid.transform.scaleY - 0.5
  };
}

/** Bilinear through east and north, never through bearings. */
function windAtCoord(grid, solved, lat, lon, heightAglM) {
  const p = pixelOf(grid, lat, lon);
  const i0 = Math.floor(p.x);
  const j0 = Math.floor(p.y);
  const fx = p.x - i0;
  const fy = p.y - j0;
  const corners = [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy], [1, 1, fx * fy]];
  let east = 0;
  let north = 0;
  let weight = 0;
  for (const c of corners) {
    if (!(c[2] > 0)) continue;
    const at = mass.sampleAt(solved, i0 + c[0], j0 + c[1], heightAglM);
    if (!at) continue;
    east += at.east * c[2];
    north += at.north * c[2];
    weight += c[2];
  }
  if (!(weight > 0)) return null;
  east /= weight;
  north /= weight;
  let from = (Math.atan2(-east, -north) * 180) / Math.PI;
  if (from < 0) from += 360;
  return { east: east, north: north, speedMps: Math.hypot(east, north), fromDeg: from };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const lat = number(args.lat, NaN, "lat");
  const lon = number(args.lon, NaN, "lon");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("--lat and --lon are required");
  }
  const speedMph = number(args.speed, NaN, "speed");
  const fromDeg = number(args.from, NaN, "from");
  if (!Number.isFinite(speedMph) || !Number.isFinite(fromDeg)) {
    throw new Error("--speed (mph) and --from (degrees) are required: this tool has no model behind it");
  }
  const heightM = number(args.height, 2, "height");
  const bearingDeg = number(args.bearing, NaN, "bearing");
  const lengthYd = number(args.length, 3520, "length");
  const radiusMiles = number(args.radius, 2, "radius");
  const resolutionM = number(args.resolution, 30, "resolution");
  const layers = number(args.layers, 16, "layers");
  const stretch = number(args.stretch, 1.25, "stretch");
  const r = number(args.r, mass.DEFAULT_R, "r");

  const spec = { lat: lat, lon: lon, radiusMiles: radiusMiles, targetResolutionM: resolutionM };
  process.stderr.write("reading terrain...\n");
  const ground = await groundUnder(spec);
  const grid = ground.grid;
  const mid = Math.floor(grid.height / 2);
  const sp = derive.spacingAt(grid, mid);

  const terrain = {
    width: grid.width,
    height: grid.height,
    spacingM: { x: sp.x, y: sp.y },
    elevation: grid.values
  };

  process.stderr.write("solving...\n");
  const started = Date.now();
  const solved = mass.solveFor(terrain, { speedMps: speedMph * MPS_PER_MPH, fromDeg: fromDeg },
    { layers: layers, stretch: stretch, r: r, referenceHeightM: heightM, maxIterations: 40000 });
  const elapsed = Date.now() - started;

  const out = [];
  out.push("A measured wind over " + ground.dataset.label + ", at " + lat.toFixed(5) + ", " + lon.toFixed(5));
  out.push("");
  out.push("  measured        " + speedMph.toFixed(1) + " mph from " + fromDeg.toFixed(0) +
    " deg, at " + heightM + " m above ground");
  out.push("  domain          " + radiusMiles + " mile radius, " + grid.width + " x " + grid.height +
    " cells at " + Math.round(sp.x) + " m" +
    (ground.filledFrom ? "  (voids filled from " + ground.filledFrom + ")" : ""));
  if (grid.voidFraction > 0) {
    out.push("  holes           " + (grid.voidFraction * 100).toFixed(1) +
      "% of the box has no ground at all, and carries no wind");
  }
  out.push("  ground          " + solved.maxSlopeDeg.toFixed(1) + " deg at its steepest, " +
    (solved.steepFraction * 100).toFixed(1) + "% of it past 45");
  out.push("  mesh            " + solved.kind +
    (solved.kind === "staircase"
      ? "  (the ground is too steep for a terrain-following coordinate; this one has no slope limit and a coarser near-ground layer)"
      : "  (layers follow the ground, so " + heightM + " m is " + heightM + " m in every column)"));
  out.push("  solve           " + solved.field.iterations + " sweeps, " +
    (solved.field.converged ? "converged" : "DID NOT CONVERGE") + ", " + elapsed + " ms");
  out.push("  divergence      " + solved.field.maxDivergenceBefore.toExponential(2) + " -> " +
    solved.field.maxDivergenceAfter.toExponential(2));
  out.push("");

  const rows = [];
  if (Number.isFinite(bearingDeg)) {
    const lengthM = lengthYd * M_PER_YARD;
    const step = lengthM / 16;
    out.push("along " + bearingDeg.toFixed(0) + " deg true, at " + heightM + " m above the ground under each point:");
    out.push("");
    out.push("   range     ground     speed      from    across the line   along it");
    for (let d = 0; d <= lengthM + 1e-6; d += step) {
      const at = slice.destination({ lat: lat, lon: lon }, bearingDeg, d);
      const w = windAtCoord(grid, solved, at.lat, at.lon, heightM);
      const p = pixelOf(grid, at.lat, at.lon);
      const i = Math.round(p.x);
      const j = Math.round(p.y);
      const z = i >= 0 && j >= 0 && i < grid.width && j < grid.height
        ? grid.values[j * grid.width + i] : NaN;
      if (!w) {
        out.push(("" + Math.round(d / M_PER_YARD)).padStart(8) + " yd   (no terrain here)");
        continue;
      }
      // Components in the line's own frame: positive across is left-to-right
      // looking along the bearing, positive along is a tailwind.
      const b = (bearingDeg * Math.PI) / 180;
      const along = w.north * Math.cos(b) + w.east * Math.sin(b);
      const across = w.east * Math.cos(b) - w.north * Math.sin(b);
      rows.push({ rangeYards: Math.round(d / M_PER_YARD), groundM: z,
        speedMph: w.speedMps / MPS_PER_MPH, fromDeg: w.fromDeg,
        acrossMph: across / MPS_PER_MPH, alongMph: along / MPS_PER_MPH });
      out.push(("" + Math.round(d / M_PER_YARD)).padStart(8) + " yd" +
        (Number.isFinite(z) ? (Math.round(z) + " m").padStart(10) : "         -") +
        ((w.speedMps / MPS_PER_MPH).toFixed(1) + " mph").padStart(11) +
        (w.fromDeg.toFixed(0) + " deg").padStart(10) +
        ((across / MPS_PER_MPH).toFixed(1) + " mph").padStart(18) +
        ((along / MPS_PER_MPH).toFixed(1) + " mph").padStart(11));
    }
    out.push("");
  }

  out.push("Read the turning, not the number. A valley turned a 45 degree wind 48 degrees onto");
  out.push("its axis in the synthetic cases and that survived a six-fold change in domain");
  out.push("height; the speed magnitude moved 28% over the same range. Nothing in this engine");
  out.push("has yet beaten raw HRRR against an anemometer, which is why confidence is null.");
  out.push("");
  out.push("And the measured wind is used as the free stream the terrain bends, NOT as a value");
  out.push("the solved field is made to match where it was measured. If the anemometer stood");
  out.push("somewhere sheltered, every number above inherits that. Point initialisation is not");
  out.push("implemented.");

  process.stdout.write(out.join("\n") + "\n");
  if (args.json && args.json !== true) {
    fs.writeFileSync(String(args.json), JSON.stringify({
      site: { lat: lat, lon: lon }, measured: { speedMph: speedMph, fromDeg: fromDeg, heightM: heightM },
      dataset: ground.dataset.label, mesh: solved.kind, maxSlopeDeg: solved.maxSlopeDeg,
      converged: solved.field.converged, transect: rows
    }, null, 2) + "\n");
  }
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}

module.exports = { pixelOf, windAtCoord, groundUnder };
