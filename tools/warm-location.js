#!/usr/bin/env node
/**
 * Solve a saved place once, so the service never has to.
 *
 *   node tools/warm-location.js --location whittington
 *   node tools/warm-location.js --all --out data/basis
 *
 * **The solver is synchronous and it blocks the event loop.** Warming the
 * Whittington Center took 7 minutes 28 seconds, and for all of it `/healthz`
 * did not answer — not slowly, at all. So this is a build step and not a
 * request: it runs here, writes a file, and `server.js` loads the file.
 *
 * What it writes is the two basis fields — a unit east wind and a unit north
 * wind — and the ground they were solved over. The solve is linear in the wind,
 * so those two answer every wind afterwards as `east * E + north * N`. One file
 * per place, and every speed, every bearing, every height is free from then on.
 *
 * Options:
 *   --location   a location id from data/locations.json
 *   --all        every location in that file
 *   --out        directory to write into (default data/basis)
 *   --layers     vertical layers in the solve (default 12)
 *   --stretch    geometric ratio between them (default 1.25)
 *   --r          stability: 1 lets the flow over a hill, small sends it around
 *   --force      re-solve a place whose file is already current
 */

"use strict";

const fs = require("fs");
const nodePath = require("path");

const basisFile = require("../basis.js");
const derive = require("../derive.js");
const fieldModule = require("../field.js");
const mass = require("../mass.js");

const locations = require("../data/locations.json");

const DEFAULT_OUT = nodePath.join(__dirname, "..", "data", "basis");
const FLAGS = ["location", "all", "out", "layers", "stretch", "r", "force"];

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const name = argv[i].slice(2);
    if (!FLAGS.includes(name)) throw new Error("unknown option --" + name);
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

/** Where a place's basis lives. One file per place, named by its id. */
function pathFor(dir, id) {
  return nodePath.join(dir, id + ".basis");
}

function specFor(loc) {
  const spec = { lat: loc.lat, lon: loc.lon, radiusMiles: loc.radiusMiles };
  if (loc.resolutionM !== undefined) spec.targetResolutionM = loc.resolutionM;
  return spec;
}

async function warm(loc, opts, dir, force) {
  const spec = specFor(loc);
  const key = basisFile.keyFor(spec, opts);
  const file = pathFor(dir, loc.id);

  if (!force && fs.existsSync(file)) {
    try {
      basisFile.load(file, key);
      process.stdout.write("  " + loc.id.padEnd(14) + "already current\n");
      return;
    } catch (err) {
      // A stale or unreadable file is replaced, not trusted and not left.
      process.stdout.write("  " + loc.id.padEnd(14) + "re-solving (" + err.code + ")\n");
    }
  }

  process.stdout.write("  " + loc.id.padEnd(14) + "reading terrain...");
  const ground = await fieldModule.groundOnly(spec);
  const grid = ground.grid;
  const spacing = derive.spacingAt(grid, Math.floor(grid.height / 2));
  process.stdout.write(" " + grid.width + " x " + grid.height + " at " +
    Math.round(spacing.x) + " m, solving...");

  const started = Date.now();
  const solved = mass.solveBasis({
    width: grid.width, height: grid.height,
    spacingM: { x: spacing.x, y: spacing.y }, elevation: grid.values
  }, opts);
  const elapsed = Date.now() - started;

  if (!(solved.east.converged && solved.north.converged)) {
    // Written anyway would be a place that looks saved and is not solved.
    throw new Error(loc.id + ": the solve did not converge in " + opts.maxIterations +
      " sweeps; raise it rather than shipping a field with mass appearing in it");
  }

  fs.mkdirSync(dir, { recursive: true });
  basisFile.save(file, {
    key: key,
    spec: spec,
    options: opts,
    location: { id: loc.id, name: loc.name, region: loc.region || null },
    dataset: ground.dataset ? ground.dataset.label : null,
    filledFrom: ground.filledFrom,
    grid: grid,
    basis: solved
  });

  const bytes = fs.statSync(file).size;
  process.stdout.write(" done\n");
  process.stdout.write("  " + " ".repeat(14) + solved.kind + ", " +
    solved.maxSlopeDeg.toFixed(1) + " deg at its steepest, " +
    Math.max(solved.east.iterations, solved.north.iterations) + " sweeps, " +
    (elapsed / 1000).toFixed(1) + " s, " + (bytes / 1048576).toFixed(1) + " MB\n");
}

async function main() {
  const args = parse(process.argv.slice(2));
  const dir = args.out && args.out !== true ? String(args.out) : DEFAULT_OUT;
  const opts = {
    layers: number(args.layers, 12, "layers"),
    stretch: number(args.stretch, 1.25, "stretch"),
    r: number(args.r, mass.DEFAULT_R, "r"),
    maxIterations: 60000
  };

  let chosen;
  if (args.all) {
    chosen = locations.locations;
  } else if (args.location && args.location !== true) {
    chosen = locations.locations.filter(function (l) { return l.id === String(args.location); });
    if (!chosen.length) {
      throw new Error("no saved location " + args.location + "; have " +
        locations.locations.map(function (l) { return l.id; }).join(", "));
    }
  } else {
    throw new Error("give --location <id> or --all");
  }

  process.stdout.write("warming " + chosen.length + " place(s) into " + dir + "\n");
  for (const loc of chosen) {
    await warm(loc, opts, dir, !!args.force);
  }
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  });
}

module.exports = { pathFor, specFor, warm };
