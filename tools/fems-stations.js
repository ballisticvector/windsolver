#!/usr/bin/env node
/**
 * Build the station map `fems.js` needs, and prove it against a second source.
 *
 * FEMS labels an observation with the nearest whole hour and throws the minute
 * away. A RAWS transmits in a fixed GOES slot, and those slots are spread right
 * across the hour — :08 at Lost Park, :24 at Estes Park, :58 at Storm King — so
 * the label is up to half an hour from the measurement, early for some stations
 * and late for others. `tools/score-wind.js` pairs on 10-30 minutes. Reading
 * FEMS without the minutes therefore pairs part of the sample against the wrong
 * model hour and reports the diurnal cycle it invents as a model error.
 *
 * Synoptic keeps the minute, and its free window reaches back about six days —
 * far too short to score a season, long enough to learn a slot that has been
 * the same for years. So: match each station to its FEMS id by position,
 * recover the minute from Synoptic, and then **check** it by asking FEMS for
 * the same hours and requiring the two services to report the same wind. A map
 * entry is only written for a station where they agree.
 *
 *   SYNOPTIC_API_TOKEN=… node tools/fems-stations.js \
 *     --stations PCPC2,STOC2,KSHC2 --days 2 --out data/fems-stations.json
 *
 *   --stations   Synoptic station ids, comma separated (required)
 *   --days       how much of Synoptic's window to calibrate against (default 2)
 *   --max-km     how far a FEMS station may be and still be the same mast (default 0.5)
 *   --min-agree  fraction of hours the two services must agree on (default 0.95)
 *   --out        where to write the map; omitted prints it
 *
 * What this does not settle: the slot is measured this week and applied to
 * 2005. A station whose GOES assignment was changed at some point carries an
 * hour of error before the change and none after it, and nothing in either
 * service announces that. The map records when it was calibrated so a
 * disagreement can be dated; testing it needs MADIS, whose archive keeps the
 * minute back years. Until then, treat a decade-long FEMS run as calibrated at
 * one end.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const synoptic = require("../synoptic.js");
const fems = require("../fems.js");

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    // An unknown flag is refused rather than ignored: a value that arrives as
    // its own word and is silently dropped produces a complete, plausible
    // report with one option quietly absent, which reads exactly like a report
    // where that option had nothing to say.
    if (!m) throw new Error("unrecognised argument " + JSON.stringify(argv[i]));
    if (m[2] !== undefined) { out[m[1]] = m[2]; continue; }
    const next = argv[i + 1];
    out[m[1]] = next !== undefined && !/^--/.test(next) ? argv[++i] : true;
  }
  for (const key of Object.keys(out)) {
    if (["stations", "days", "max-km", "min-agree", "out"].indexOf(key) < 0) {
      throw new Error("unrecognised option --" + key);
    }
  }
  return out;
}

function distanceKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** The whole hour a time is nearest to — FEMS' own label, worked out here. */
function nearestHourMs(ms) {
  return Math.round(ms / HOUR_MS) * HOUR_MS;
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return { value: best, count: bestCount, total: values.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.stations || args.stations === true) {
    throw new Error("--stations is required, e.g. --stations PCPC2,STOC2,KSHC2");
  }
  const token = process.env.SYNOPTIC_API_TOKEN;
  if (!token) throw new Error("SYNOPTIC_API_TOKEN is required: the minute comes from Synoptic");

  const ids = String(args.stations).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const days = args.days ? Number(args.days) : 2;
  const maxKm = args["max-km"] ? Number(args["max-km"]) : 0.5;
  const minAgree = args["min-agree"] ? Number(args["min-agree"]) : 0.95;
  if (!isFinite(days) || days <= 0) throw new Error("--days must be a positive number");

  const end = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  const start = new Date(end.getTime() - days * 24 * HOUR_MS);

  const source = synoptic.createSynopticSource({ token: token, stids: ids });
  const femsSource = fems.createFemsSource({});

  process.stderr.write("listing FEMS stations…\n");
  const all = await femsSource.search({ all: true });
  process.stderr.write("  " + all.length + " stations\n");

  const map = {};
  const report = [];
  for (const id of ids) {
    const station = await source.station(id);
    let nearest = null;
    for (const candidate of all) {
      const km = distanceKm(station, candidate);
      if (!nearest || km < nearest.km) nearest = { km: km, station: candidate };
    }
    if (!nearest || nearest.km > maxKm) {
      report.push({ id: id, ok: false,
        why: "nearest FEMS station is " + (nearest ? nearest.km.toFixed(2) : "?") +
          " km away, further than --max-km " + maxKm });
      continue;
    }

    const read = await source.observations(id, { start: start, end: end });
    const minutes = read.records.map(function (r) { return new Date(r.timeMs).getUTCMinutes(); });
    const slot = mode(minutes);
    if (!slot.total) {
      report.push({ id: id, ok: false, why: "Synoptic returned no observations in the window" });
      continue;
    }
    const slotShare = slot.count / slot.total;

    // The check. Ask FEMS for the same hours, line each row up with the
    // Synoptic observation nearest its label, and require the wind to be the
    // same wind. Speed is compared at FEMS' own resolution — a whole mile per
    // hour — because that is the coarser of the two rulers.
    const femsOnly = fems.createFemsSource({
      stations: { [id]: { femsId: nearest.station.id, transmitMinute: slot.value } }
    });
    const femsRead = await femsOnly.observations(id, { start: start, end: end });
    const byTime = new Map();
    for (const r of read.records) byTime.set(r.timeMs, r);

    let checked = 0;
    let agreed = 0;
    let labelWrong = 0;
    const offsets = [];
    for (const r of femsRead.records) {
      const label = Date.parse(r.hourLabel);
      let best = null;
      for (const s of read.records) {
        const off = Math.abs(s.timeMs - label);
        if (off <= 31 * MINUTE_MS && (!best || off < Math.abs(best.timeMs - label))) best = s;
      }
      if (!best) continue;
      checked++;
      offsets.push(Math.round((best.timeMs - label) / MINUTE_MS));
      if (best.timeMs !== r.timeMs) { labelWrong++; continue; }
      if (Math.abs(best.speedMps - r.speedMps) < fems.RAWS_QUANTISATION.speedStepMps / 2) agreed++;
    }
    const agreement = checked ? agreed / checked : 0;
    const ok = checked >= 12 && agreement >= minAgree && slotShare >= 0.9;

    report.push({
      id: id, ok: ok, femsId: nearest.station.id, wrcc: nearest.station.wrccId,
      km: Number(nearest.km.toFixed(3)), minute: slot.value,
      slotShare: Number(slotShare.toFixed(3)), checked: checked,
      agreement: Number(agreement.toFixed(3)), labelWrong: labelWrong,
      offsets: mode(offsets).value,
      why: ok ? null : "the two services do not agree often enough to trust the minute"
    });
    if (!ok) continue;

    map[id] = {
      femsId: nearest.station.id,
      wrccId: nearest.station.wrccId,
      name: nearest.station.name,
      transmitMinute: slot.value,
      // FEMS publishes no anemometer height, and scoring a 6.1 m RAWS against a
      // 10 m model level without moving one to the other is an 8.5% error in
      // the direction that makes the model look fast. Synoptic surveyed this
      // very sensor and the calibration run has it in hand, so it is carried
      // here as a measurement with its provenance rather than re-assumed at
      // scoring time. A station that publishes none stays null.
      sensorHeightM: typeof station.sensorHeightM === "number" ? station.sensorHeightM : null,
      sensorHeightSource: typeof station.sensorHeightM === "number" ? "synoptic" : null,
      calibratedAgainst: {
        source: "synoptic",
        start: start.toISOString(),
        end: end.toISOString(),
        hoursChecked: checked,
        agreement: Number(agreement.toFixed(3)),
        separationKm: Number(nearest.km.toFixed(3))
      }
    };
  }

  for (const r of report) {
    process.stderr.write(
      (r.ok ? "  ok   " : "  SKIP ") + String(r.id).padEnd(8) +
      (r.femsId ? String(r.femsId).padEnd(10) : "".padEnd(10)) +
      (r.minute === undefined ? "" :
        ":" + String(r.minute).padStart(2, "0") + "  " + r.km + " km  " +
        r.checked + " hours  agree " + r.agreement) +
      (r.why ? "  — " + r.why : "") + "\n");
  }

  const kept = Object.keys(map).length;
  process.stderr.write(kept + " of " + ids.length + " stations calibrated\n");
  const text = JSON.stringify(map, null, 2) + "\n";
  if (args.out && args.out !== true) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, text);
    process.stderr.write("wrote " + args.out + "\n");
  } else {
    process.stdout.write(text);
  }
  if (kept < ids.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(1);
  });
}

module.exports = { distanceKm, nearestHourMs, mode };
