#!/usr/bin/env node
/**
 * Do FEMS and Synoptic report the same wind, hour for hour?
 *
 * `tools/fems-stations.js` asks that question of a handful of hours in order to
 * decide a transmit minute, and stops as soon as the answer is good enough. This
 * asks it of everything in a window and reports the disagreement instead of a
 * verdict, which is the check to run when FEMS changes something: a service that
 * starts reporting in knots, or shifts its hour label, or quietly drops a
 * station, produces a complete and plausible archive either way.
 *
 *   SYNOPTIC_API_TOKEN=… node tools/fems-agree.js --days 5
 *   SYNOPTIC_API_TOKEN=… node tools/fems-agree.js --stations PCPC2,STOC2 --days 2
 *
 *   --stations   which of the map's stations to check (default: all of them)
 *   --map        the station map to check (default data/fems-stations.json)
 *   --days       how far back to compare (default 5; Synoptic's free window is
 *                about six days, and this is the whole reason FEMS is here)
 *   --json       write the full comparison as JSON to this path
 *
 * Measured on 2026-09-06 over the eleven calibrated Colorado stations and five
 * days: 1,318 hours shared, **every direction identical**, and every speed
 * within 0.0005 m/s — Synoptic rounds the mph conversion to 0.447 where this
 * reader uses 0.44704, and that rounding is the entire disagreement. Two hours
 * out of 1,320 exist in Synoptic and not in FEMS.
 *
 * What it does not settle: both services are downstream of the same WIMS feed,
 * so agreement means FEMS is being read correctly, not that either is right
 * about the wind. And Synoptic's window cannot reach the years FEMS is being
 * used for, so this grades the reader, not the archive.
 */

"use strict";

const fs = require("fs");

const fems = require("../fems.js");
const synoptic = require("../synoptic.js");

const HOUR_MS = 60 * 60 * 1000;
const ALLOWED = ["stations", "map", "days", "json"];
const DEFAULT_MAP = "data/fems-stations.json";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error("unrecognised argument " + JSON.stringify(argv[i]));
    if (m[2] !== undefined) { out[m[1]] = m[2]; continue; }
    const next = argv[i + 1];
    out[m[1]] = next !== undefined && !/^--/.test(next) ? argv[++i] : true;
  }
  for (const key of Object.keys(out)) {
    if (ALLOWED.indexOf(key) < 0) throw new Error("unrecognised option --" + key);
  }
  return out;
}

/** Smallest angle between two bearings, in degrees. */
function bearingGapDeg(a, b) {
  if (a === null || b === null) return a === b ? 0 : null;
  return Math.abs(((a - b + 540) % 360) - 180);
}

function compare(femsRecords, synopticRecords) {
  const byTime = new Map();
  for (const r of synopticRecords) byTime.set(r.time, r);
  const seen = new Set();
  const out = {
    shared: 0,
    speedGapMps: 0,
    bearingGapDeg: 0,
    calmDisagreements: 0,
    femsOnly: [],
    synopticOnly: [],
    worst: null
  };
  for (const r of femsRecords) {
    const other = byTime.get(r.time);
    if (!other) { out.femsOnly.push(r.time); continue; }
    seen.add(r.time);
    out.shared++;
    const speedGap = Math.abs(r.speedMps - other.speedMps);
    const gap = bearingGapDeg(r.fromDeg, other.fromDeg);
    if (gap === null) out.calmDisagreements++;
    out.speedGapMps = Math.max(out.speedGapMps, speedGap);
    out.bearingGapDeg = Math.max(out.bearingGapDeg, gap === null ? 180 : gap);
    if (!out.worst || speedGap > out.worst.speedGapMps) {
      out.worst = { time: r.time, fems: r.speedMps, synoptic: other.speedMps, speedGapMps: speedGap };
    }
  }
  for (const r of synopticRecords) if (!seen.has(r.time)) out.synopticOnly.push(r.time);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SYNOPTIC_API_TOKEN;
  if (!token) throw new Error("SYNOPTIC_API_TOKEN is required: it is the other half of the comparison");

  const where = args.map && args.map !== true ? String(args.map) : DEFAULT_MAP;
  if (!fs.existsSync(where)) {
    throw new Error("no station map at " + where + "; build it with tools/fems-stations.js");
  }
  const map = JSON.parse(fs.readFileSync(where, "utf8"));
  const ids = args.stations && args.stations !== true
    ? String(args.stations).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    : Object.keys(map);
  const missing = ids.filter(function (id) { return !map[id]; });
  if (missing.length) throw new Error(where + " has no entry for " + missing.join(","));

  const days = args.days ? Number(args.days) : 5;
  if (!isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  const end = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  const start = new Date(end.getTime() - days * 24 * HOUR_MS);
  const window = { start: start, end: end };

  const femsSource = fems.createFemsSource({ stations: map, stationIds: ids });
  const synopticSource = synoptic.createSynopticSource({ token: token, stids: ids });

  const stations = [];
  const totals = { shared: 0, speedGapMps: 0, bearingGapDeg: 0, femsOnly: 0, synopticOnly: 0 };
  for (const id of ids) {
    const a = await femsSource.observations(id, window);
    const b = await synopticSource.observations(id, window);
    const c = compare(a.records, b.records);
    stations.push(Object.assign({ id: id, femsId: map[id].femsId }, c));
    totals.shared += c.shared;
    totals.speedGapMps = Math.max(totals.speedGapMps, c.speedGapMps);
    totals.bearingGapDeg = Math.max(totals.bearingGapDeg, c.bearingGapDeg);
    totals.femsOnly += c.femsOnly.length;
    totals.synopticOnly += c.synopticOnly.length;
    process.stderr.write("  " + id.padEnd(8) + String(c.shared).padStart(5) + " hours" +
      "  worst speed " + c.speedGapMps.toFixed(4) + " m/s" +
      "  worst direction " + c.bearingGapDeg.toFixed(0) + "°" +
      "  fems only " + c.femsOnly.length + "  synoptic only " + c.synopticOnly.length + "\n");
  }

  // A FEMS row an hour outside the asked-for window is not a disagreement: the
  // reader widens the request because the label is not the observation time.
  const inside = function (t) {
    const ms = Date.parse(t);
    return ms >= start.getTime() && ms <= end.getTime();
  };
  const femsOnlyInside = stations.reduce(function (n, s) {
    return n + s.femsOnly.filter(inside).length;
  }, 0);

  process.stdout.write("\n" + ids.length + " stations, " + start.toISOString() + " to " +
    end.toISOString() + "\n");
  process.stdout.write(totals.shared + " hours in both services\n");
  process.stdout.write("worst speed disagreement     " + totals.speedGapMps.toFixed(4) + " m/s\n");
  process.stdout.write("worst direction disagreement " + totals.bearingGapDeg.toFixed(0) + "°\n");
  process.stdout.write("hours only FEMS has          " + femsOnlyInside + " inside the window (" +
    (totals.femsOnly - femsOnlyInside) + " more at its edges, which the reader widens on purpose)\n");
  process.stdout.write("hours only Synoptic has      " + totals.synopticOnly + "\n");

  if (args.json && args.json !== true) {
    fs.writeFileSync(String(args.json), JSON.stringify({
      window: { start: start.toISOString(), end: end.toISOString() },
      map: where,
      totals: totals,
      stations: stations
    }, null, 2) + "\n");
    process.stdout.write("wrote " + args.json + "\n");
  }
}

module.exports = { parseArgs, bearingGapDeg, compare };

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(1);
  });
}
