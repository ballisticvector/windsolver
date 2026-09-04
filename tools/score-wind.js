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
 *   node tools/score-wind.js --source synoptic --stations BLPC2,BHRC2 --hours 24
 *
 * Options:
 *   --stations   comma-separated station ids (required)
 *   --source     nws (default) or synoptic; synoptic needs $SYNOPTIC_API_TOKEN
 *   --hours      how many whole hours back from --end (default 12)
 *   --end        the newest hour to score, ISO 8601 (default: three hours ago,
 *                which is comfortably behind the HRRR availability lag)
 *   --forecast   HRRR lead time in hours (default 0, the analysis)
 *   --radius     domain radius in miles around each station (default 0.5)
 *   --resolution target terrain resolution in metres (default 30)
 *   --tolerance  observation-to-valid-time tolerance in minutes (default 10)
 *   --elevation  how far a station's published elevation may sit from the 3DEP
 *                ground under its coordinate before it is dropped, in metres
 *                (default 50)
 *   --roughness  roughness length for the sensor-height correction, in metres
 *                (default 0.03, short grass)
 *   --no-height  score the model at its own level instead of moving it to the
 *                anemometer's height
 *   --ablate     score the downscaling's terms one at a time as well as together
 *   --shelter    derive Winstral sheltering, so the third term is not inert
 *   --scales     also score the downscaling normalised against fixed physical
 *                scales instead of against each domain's own extremes, as
 *                `slopeDeg,curvature` (default 40,0.13 with a bare --scales)
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
 *
 * **A RAWS anemometer is 6.1 m up and HRRR's surface wind is at 10 m.** 20 ft
 * is the NFDRS standard height for a fire-weather station, and Synoptic
 * publishes the position of every sensor, so this is a measurable difference
 * rather than an assumption: over short grass (z0 0.03 m) the log law puts 8.5%
 * of the wind between the two heights, all of it in the direction that makes the
 * model look too fast. The model wind is brought down to whatever height the station says
 * before it is scored, and the factor is in the report. An ASOS is at 10 m and
 * moves by nothing, which is why the airport scores in #28 did not need this.
 *
 * **A combined score cannot say which term is paying.** `W = (1 + Ws*Os +
 * Wc*Oc) * (1 - Wx*Ox)`, plus a diverting angle applied to the direction, is
 * four independent claims about the ground reported as one number, and the
 * first RAWS run said only that the four of them together were worse than
 * leaving the model alone. `--ablate` scores each of them on the *same*
 * observations and the same solved domains: the terrain weighting is computed
 * once per station and every candidate is a re-weighting of it, so a fifth
 * candidate costs arithmetic over a 90 x 90 grid and no network at all.
 *
 * **Sheltering is off unless it is asked for.** `derive` only computes Winstral
 * Sx when the spec says so, so `Wx*Ox` was identically zero in every score run
 * so far: what has been graded is the two speed-*up* terms with the one term
 * that can slow the wind down switched off. `--shelter` turns it on, at the
 * cost of a wider terrain read and the sector search.
 *
 * **A station is dropped if its published elevation disagrees with the ground
 * under its published coordinate.** One of the two is then wrong, and the
 * coordinate is the one that decides which hillside the model is sampled on. A
 * station in the wrong canyon does not fail — it produces a terrain class, a
 * pairing and a score, all of them about somewhere else.
 */

"use strict";

const fs = require("fs");

const cog = require("../cog.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const fieldModule = require("../field.js");
const observationsModule = require("../observations.js");
const synoptic = require("../synoptic.js");
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

/** Score options: which candidate wind to read, and the observer's rounding. */
function reading(floor, which) {
  return {
    read: function (p) { return p.sample.byCandidate[which]; },
    speedStepMps: floor.speedStepMps,
    dirStepDeg: floor.dirStepDeg
  };
}

/**
 * The candidate winds a run scores, in the order they are printed.
 *
 * `model` is the single HRRR wind the domain was downscaled from and is the
 * thing everything else has to beat. The rest are the same downscaling with
 * different gains, so the difference between two rows is one term and not one
 * term plus a different domain, a different hour or a different pairing.
 */
function candidatesFor(opts) {
  const o = opts || {};
  const list = [
    { key: "model", label: "HRRR alone", short: "hrrr", reference: true },
    { key: "downscaled", label: "downscaled", short: "down", options: {} }
  ];
  if (!o.ablate) return list;

  list.push(
    // One gain at a time. `shelter: 0` is explicit rather than assumed: on a
    // domain derived with sheltering the default gain is 0.5, and a row called
    // "slope only" that quietly carried it would be the same conflation this
    // whole option exists to undo.
    { key: "slopeOnly", label: "slope only", short: "slope",
      options: { weights: { curvature: 0, shelter: 0 } } },
    { key: "curvatureOnly", label: "curvature only", short: "curv",
      options: { weights: { slope: 0, shelter: 0 } } },
    // The speed weighting with the turning switched off, and the turning with
    // the speed weighting switched off. Direction and speed are scored
    // separately anyway, but the diverting angle is a function of the slope
    // term, so "is the turning helping" is not answerable from the gains alone.
    { key: "noDivert", label: "no diverting", short: "nodiv", options: { divert: false } },
    { key: "divertOnly", label: "diverting only", short: "divert",
      options: { weights: { slope: 0, curvature: 0, shelter: 0 } } }
  );
  if (o.shelter) {
    list.push(
      { key: "shelterOnly", label: "shelter only", short: "shelt",
        options: { weights: { slope: 0, curvature: 0 } } },
      { key: "noShelter", label: "no shelter", short: "noshelt",
        options: { weights: { shelter: 0 } } }
    );
  }
  // The same downscaling with the divisor held still. By default each term is
  // scaled by the largest value inside the requested box, so the wind at a
  // station is partly a fact about how much ground was asked for; these rows
  // say whether taking that out helps, hurts, or does nothing measurable.
  if (o.scales) {
    list.push(
      { key: "fixedScales", label: "fixed scales", short: "fixed", options: {}, scales: o.scales },
      { key: "fixedCurvatureOnly", label: "fixed curvature only", short: "fixcurv",
        options: { weights: { slope: 0, shelter: 0 } }, scales: o.scales }
    );
  }
  return list;
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
    scale: round(score.scale, 4),
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
  const elevationToleranceM = o.elevationToleranceM === undefined ? 50 : o.elevationToleranceM;
  const positionRadiusM = o.positionRadiusM === undefined
    ? derive.DEFAULT_POSITION_RADIUS_M : o.positionRadiusM;
  const roughnessM = o.roughnessM === undefined
    ? downscale.DEFAULT_ROUGHNESS_M : o.roughnessM;
  const useSensorHeight = o.sensorHeight === undefined ? true : !!o.sensorHeight;
  const useShelter = !!o.shelter;
  const candidates = o.candidates || candidatesFor({
    ablate: o.ablate, shelter: useShelter, scales: o.scales });

  // The ruler the observations were written with. A METAR is a whole knot and
  // 10°; a RAWS is a whole mile per hour and 1°. Scoring RAWS against a METAR's
  // floor would credit the model with 2.9° of the observer's rounding that this
  // observer did not do.
  const floor = o.floor || {};
  const now = o.now || Date.now;

  if (!isFinite(o.endMs)) throw new Error("endMs is required: the newest hour to score");
  const validTimes = hoursIn(o.endMs, hours);
  const started = now();
  const stations = [];
  const allPairs = [];
  const failures = [];
  const dropped = [];

  for (const id of ids) {
    const station = await source.station(id);
    const read = await source.observations(id, {
      start: new Date(validTimes[0].getTime() - HOUR_MS),
      end: new Date(validTimes[validTimes.length - 1].getTime() + HOUR_MS)
    });

    const samples = [];
    const rescaled = {};
    // How much each candidate multiplied the model wind at this station's own
    // coordinate. The score says whether a term helped; this says what it did,
    // and the two answer different questions — a term can be harmless on
    // average and still be multiplying a ridge by 1.3.
    const gains = {};
    let terrain = null;

    // The model is asked for a level; the station measures at whatever height
    // its mast is. Where those differ the log law moves the model to the
    // station rather than the station to the model, because the observation is
    // the thing being treated as true. Speed only: a log law is a statement
    // about a neutral profile's magnitude and says nothing about the veering a
    // real profile does between 6 m and 10 m.
    let height = {
      sensorHeightM: typeof station.sensorHeightM === "number" ? station.sensorHeightM : null,
      fieldHeightAglM: null,
      roughnessM: roughnessM,
      factor: 1,
      applied: false
    };

    for (const validTime of validTimes) {
      let field;
      try {
        field = await service.get({
          lat: station.lat,
          lon: station.lon,
          radiusMiles: radiusMiles,
          targetResolutionM: resolutionM,
          validTime: validTime,
          forecastHour: forecastHour,
          shelter: useShelter ? true : undefined
        });
      } catch (err) {
        // One bad hour is a fact about NOMADS or about The National Map, not a
        // reason to lose the other eleven. It is counted, because a score over
        // "the hours that worked" is a different claim if half of them did not.
        failures.push({ station: id, validTime: validTime.toISOString(), code: err.code || null, error: err.message });
        continue;
      }

      const reference = field.reference;
      const referenceSpeed = Math.hypot(reference.east, reference.north);

      if (height.fieldHeightAglM === null) {
        const fieldHeight = typeof field.heightAglM === "number" ? field.heightAglM : null;
        const wanted = useSensorHeight ? height.sensorHeightM : null;
        const factor = fieldHeight !== null && wanted !== null
          ? downscale.heightFactor(fieldHeight, wanted, roughnessM)
          : 1;
        height = Object.assign({}, height, {
          fieldHeightAglM: fieldHeight,
          factor: factor,
          applied: factor !== 1
        });
      }

      if (!terrain) {
        // The landform the station sits in, measured over a disc rather than
        // over the three pixels either side of it. `tpi` is kept alongside it
        // to show the difference: on a named ridge the 3 x 3 index reads a
        // fraction of a metre, which is why it classified everything as flat.
        const position = derive.positionIndexAt(
          field.derived, station.lat, station.lon, { radiusM: positionRadiusM });
        terrain = {
          slopeDeg: derive.fieldAt(field.derived, "slopeDeg", station.lat, station.lon),
          tpi: derive.fieldAt(field.derived, "tpi", station.lat, station.lon),
          positionIndexM: position ? round(position.tpiM, 1) : null,
          positionRadiusM: position ? position.radiusM : positionRadiusM,
          positionCoverage: position ? round(position.coverage, 3) : null,
          demElevationM: elevationAt(field.derived, station.lat, station.lon),
          modelOffsetM: field.offset ? round(field.offset.meanM, 1) : null,
          dataset: field.terrain.dataset,
          resolutionM: field.terrain.resolutionM,
          heightAglM: field.heightAglM === undefined ? null : field.heightAglM
        };
        terrain.class = verify.classifyTerrain(terrain);
      }

      // Every candidate is the same domain re-weighted, so the terrain read and
      // the HRRR subset are paid once and the comparison between two rows is
      // one gain and nothing else.
      const byCandidate = {};
      for (const candidate of candidates) {
        // Re-weighting against fixed scales is a second pass over the
        // curvature, so it is done once per candidate per domain rather than
        // once per hour; the derived domain is the same object all hour.
        let weights = field.weights;
        if (candidate.scales) {
          if (!rescaled[candidate.key]) {
            rescaled[candidate.key] = downscale.terrainWeights(field.derived, Object.assign(
              { curvatureLengthM: field.weights.curvatureLengthM }, candidate.scales));
          }
          weights = rescaled[candidate.key];
        }
        const at = candidate.reference
          ? { speedMps: referenceSpeed, fromDeg: bearingFrom(reference.east, reference.north) }
          : downscale.windAt(
            Object.keys(candidate.options).length === 0 && weights === field.weights
              ? field
              : downscale.downscale(weights, reference,
                Object.assign({ heightAglM: field.heightAglM }, candidate.options)),
            station.lat, station.lon);
        byCandidate[candidate.key] = at
          ? { speedMps: at.speedMps * height.factor, fromDeg: at.fromDeg }
          : { speedMps: null, fromDeg: null };
        if (at && referenceSpeed > 0) {
          const g = gains[candidate.key] || { sum: 0, n: 0 };
          gains[candidate.key] = { sum: g.sum + at.speedMps / referenceSpeed, n: g.n + 1 };
        }
      }

      samples.push({ timeMs: validTime.getTime(), byCandidate: byCandidate });
    }

    // The published elevation against the 3DEP ground under the published
    // coordinate. A disagreement means one of them is wrong and the score built
    // on the pair is about the wrong hillside, so the station is dropped and
    // counted rather than quietly weighted into a terrain class. A station with
    // no elevation on one side or the other cannot be checked; it is scored,
    // and the report says the check did not run.
    const elevation = verify.elevationCheck(
      station.elevationM, terrain ? terrain.demElevationM : null, { toleranceM: elevationToleranceM });

    if (elevation.code === "elevation-disagrees") {
      dropped.push({
        station: station.id,
        name: station.name,
        code: elevation.code,
        publishedM: round(station.elevationM, 1),
        demElevationM: round(terrain ? terrain.demElevationM : null, 1),
        differenceM: round(elevation.differenceM, 1)
      });
      continue;
    }

    const paired = verify.pair(read.records, samples, { toleranceMs: toleranceMs });

    // How close the tolerance came to admitting the observations it refused.
    // A RAWS station transmits once an hour on a minute of its own — :27 at
    // Keyser Ridge, :35 at Rampart Range — so a window tuned to METAR's :53
    // excludes the whole station, and an empty row looks like a station that
    // reported nothing rather than one the window missed by seventeen minutes.
    let nearestUnmatchedMs = null;
    for (const u of paired.unmatched) {
      if (u.offsetMs === null) continue;
      if (nearestUnmatchedMs === null || u.offsetMs < nearestUnmatchedMs) nearestUnmatchedMs = u.offsetMs;
    }

    for (const p of paired.pairs) {
      p.station = station;
      p.terrain = terrain;
      allPairs.push(p);
    }

    const stationScores = {};
    const stationGains = {};
    for (const candidate of candidates) {
      stationScores[candidate.key] = tidy(verify.score(paired.pairs, reading(floor, candidate.key)));
      const g = gains[candidate.key];
      stationGains[candidate.key] = g && g.n ? round(g.sum / g.n, 3) : null;
    }

    stations.push(Object.assign({
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      elevationM: station.elevationM,
      elevation: elevation,
      terrain: terrain,
      height: Object.assign({}, height, { factor: round(height.factor, 4) }),
      observations: read.counts,
      rejected: read.rejected.length,
      samples: samples.length,
      paired: paired.pairs.length,
      unmatched: paired.unmatched.length,
      nearestUnmatchedMinutes: nearestUnmatchedMs === null ? null : round(nearestUnmatchedMs / 60000, 1),
      // What each candidate did to the model wind here, as a multiplier.
      gain: stationGains
    }, stationScores));
  }

  // Every candidate is stratified, not just the downscaled one. "The
  // downscaling scores 6.2 on slopes" is unreadable on its own: the question is
  // whether it beat the model it started from on that terrain, and that needs
  // the same split on both sides.
  const classOf = function (p) { return p.terrain ? p.terrain.class : "unknown"; };
  const byTerrain = {};
  for (const candidate of candidates) {
    for (const [label, scored] of Object.entries(
      verify.stratify(allPairs, classOf, reading(floor, candidate.key))
    )) {
      if (!byTerrain[label]) byTerrain[label] = {};
      byTerrain[label][candidate.key] = tidy(scored);
    }
  }

  const overall = {};
  for (const candidate of candidates) {
    overall[candidate.key] = tidy(verify.score(allPairs, reading(floor, candidate.key)));
  }

  // The same candidates with each one's own mean speed error divided out.
  //
  // A run carrying a bias that is not about the ground — the model's own, the
  // roughness the height correction assumed, the brush a RAWS tower stands in —
  // grades every multiplicative term on its sign: against a model that is too
  // fast, a term that slows the wind wins over any terrain and a term that
  // speeds it up loses over any terrain. These rows ask the other question,
  // which is whether a term puts the wind in the right place. Each scale is
  // fitted on the observations it is then scored against, so the rows are
  // comparable with each other and not with the ones above.
  const debiased = {};
  for (const candidate of candidates) {
    const opts = reading(floor, candidate.key);
    debiased[candidate.key] = tidy(verify.score(allPairs,
      Object.assign({}, opts, { scale: verify.debiasScale(allPairs, opts) })));
  }

  const report = {
    schemaVersion: 3,
    generated: new Date(started).toISOString(),
    window: {
      from: validTimes[0].toISOString(),
      to: validTimes[validTimes.length - 1].toISOString(),
      hours: hours,
      forecastHour: forecastHour,
      toleranceMinutes: toleranceMs / 60000
    },
    domain: {
      radiusMiles: radiusMiles,
      targetResolutionM: resolutionM,
      // The scale the terrain class was read at. A ridge measured over 100 m
      // and a ridge measured over 500 m are different claims, so the number
      // travels with the report rather than living in someone's memory.
      positionRadiusM: positionRadiusM,
      positionThresholdM: verify.DEFAULT_POSITION_THRESHOLD_M,
      roughnessM: roughnessM,
      // Null means every term was divided by the largest value inside the box,
      // which makes the answer partly a fact about the request. Two reports
      // cannot be compared without knowing which of the two this was.
      fixedScales: o.scales || null
    },
    source: {
      observations: o.observationSource ||
        "NWS api.weather.gov station observations (ASOS/AWOS METAR)",
      model: "HRRR via NOMADS",
      terrain: "USGS 3DEP",
      independence: forecastHour === 0
        ? "NONE from HRRR: the analysis assimilates these stations. Downscaling is independent of them."
        : "partial: an f" + forecastHour + " forecast has not seen the observations at its own valid hour."
    },
    stations: stations,
    candidates: candidates.map(function (c) {
      return {
        key: c.key,
        label: c.label,
        short: c.short || c.key,
        weights: c.reference ? null : Object.assign({}, downscale.DEFAULT_WEIGHTS,
          (c.options && c.options.weights) || {}),
        divert: c.reference ? null : !(c.options && c.options.divert === false)
      };
    }),
    shelter: useShelter,
    overall: overall,
    debiased: debiased,
    byTerrain: byTerrain,
    droppedStations: dropped,
    elevationToleranceM: elevationToleranceM,
    failures: failures,
    elapsedMs: now() - started
  };

  return report;
}

/**
 * `--scales`, as `slopeDeg,curvature`.
 *
 * The bare flag takes the middle of what thirteen Colorado RAWS domains
 * actually reported for their own extremes — 31 to 55 degrees of slope and
 * 0.097 to 0.174 of curvature over boxes of the same 1.6 km width — so the
 * default is a measured middle rather than a round number.
 */
function fixedScales(value) {
  if (!value) return null;
  const parts = value === true ? [40, 0.13] : String(value).split(",").map(Number);
  if (parts.length !== 2 || !parts.every(function (n) { return n > 0; })) {
    throw new Error("--scales is slopeDeg,curvature, both positive: " + value);
  }
  return { slopeScaleRad: (parts[0] * Math.PI) / 180, curvatureScale: parts[1] };
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

  const ids = String(args.stations).split(",")
    .map(function (s) { return s.trim().toUpperCase(); })
    .filter(Boolean);
  const chosen = sourceFor(args.source, ids);

  const report = await buildReport({
    source: chosen.source,
    observationSource: chosen.label,
    floor: chosen.floor,
    service: fieldModule.createFieldService({}),
    stations: ids,
    hours: number(args.hours, 12, "hours"),
    forecastHour: number(args.forecast, 0, "forecast"),
    radiusMiles: number(args.radius, 0.5, "radius"),
    resolutionM: number(args.resolution, 30, "resolution"),
    toleranceMs: number(args.tolerance, 10, "tolerance") * 60 * 1000,
  positionRadiusM: number(args.position, derive.DEFAULT_POSITION_RADIUS_M, "position"),
    elevationToleranceM: number(args.elevation, 50, "elevation"),
    roughnessM: number(args.roughness, downscale.DEFAULT_ROUGHNESS_M, "roughness"),
    sensorHeight: !args["no-height"],
    ablate: !!args.ablate,
    shelter: !!args.shelter,
    scales: fixedScales(args.scales),
    endMs: endMs
  });

  if (args.out && args.out !== true) {
    fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2) + "\n");
  }

  process.stdout.write(summarise(report) + "\n");
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

/**
 * The reader named on the command line.
 *
 * The token comes from the environment and never from an argument: an argument
 * is in the shell history, in `ps`, and in the transcript of whatever ran it.
 */
function sourceFor(name, ids) {
  const which = name === undefined || name === true ? "nws" : String(name).toLowerCase();
  if (which === "nws") {
    return {
      source: observationsModule.createObservationSource({}),
      label: "NWS api.weather.gov station observations (ASOS/AWOS METAR)",
      floor: {}
    };
  }
  if (which === "synoptic") {
    const token = process.env.SYNOPTIC_API_TOKEN;
    if (!token) throw new Error("--source synoptic needs SYNOPTIC_API_TOKEN in the environment");
    return {
      source: synoptic.createSynopticSource({ token: token, stids: ids }),
      label: "Synoptic Data stations (RAWS and other mesonets), 1° directions, QC-flagged rows dropped",
      floor: synoptic.RAWS_QUANTISATION
    };
  }
  throw new Error("--source is nws or synoptic, not " + JSON.stringify(name));
}

function line(label, score) {
  return [
    label.padEnd(16),
    String(score.n).padStart(5),
    String(score.distinctSamples).padStart(5),
    fixed(score.speed.biasMps, 2).padStart(9),
    fixed(score.speed.rmseMps, 2).padStart(9),
    fixed(score.direction.biasDeg, 1).padStart(9),
    fixed(score.direction.rmseDeg, 1).padStart(9),
    fixed(score.vectorRmseMps, 2).padStart(9)
  ].join(" ");
}

/** The mean multiplier a candidate applied, over the stations that scored. */
function meanGain(report, key) {
  let sum = 0;
  let n = 0;
  for (const s of report.stations) {
    const g = s.gain && s.gain[key];
    if (typeof g !== "number") continue;
    sum += g;
    n++;
  }
  return n ? sum / n : null;
}

function fixed(value, places) {
  return value === null || value === undefined ? "—" : value.toFixed(places);
}

/**
 * One line about the height the model was moved to, per height in the run.
 *
 * Grouped rather than per station because a whole network shares a standard —
 * every RAWS is at 6.1 m, every ASOS at 10 m — and fifteen identical lines
 * would bury the one station that is different.
 */
function heights(report) {
  const groups = new Map();
  for (const s of report.stations) {
    const h = s.height || {};
    const key = h.sensorHeightM === null || h.sensorHeightM === undefined
      ? "unpublished" : String(h.sensorHeightM);
    if (!groups.has(key)) groups.set(key, { height: h, ids: [] });
    groups.get(key).ids.push(s.id);
  }

  const parts = [];
  for (const group of groups.values()) {
    const h = group.height;
    if (h.sensorHeightM === null || h.sensorHeightM === undefined) {
      parts.push(group.ids.length +
        " publish no sensor height, scored at the model's own level");
    } else {
      parts.push(group.ids.length + " at " + h.sensorHeightM + " m AGL, model moved by x" +
        fixed(h.factor, 3));
    }
  }
  if (!parts.length) return "measurement height: no stations scored";
  return "measurement height: " + parts.join("; ") +
    " (log law, z0 " + report.domain.roughnessM + " m; speed only, no veering)";
}

/** The candidates the report scored, oldest reports first. */
function candidatesOf(report) {
  if (report.candidates && report.candidates.length) return report.candidates;
  return [
    { key: "model", label: "HRRR alone", short: "hrrr" },
    { key: "downscaled", label: "downscaled", short: "down" }
  ];
}

function summarise(report) {
  const head = ["candidate".padEnd(16), "obs".padStart(5), "hrs".padStart(5), "spd bias".padStart(9),
    "spd rmse".padStart(9), "dir bias".padStart(9), "dir rmse".padStart(9),
    "vec rmse".padStart(9)].join(" ");
  const candidates = candidatesOf(report);

  const out = [
    "WindSolver against measured wind",
    report.window.from + " to " + report.window.to + "  f" + report.window.forecastHour,
    report.source.independence,
    "",
    head
  ];
  for (const c of candidates) {
    if (report.overall[c.key]) out.push(line(c.label, report.overall[c.key]));
  }
  out.push("",
    "speed and vector errors are m/s, direction degrees; a perfect model scores " +
      fixed(report.overall.downscaled.floor.speedRmseMps, 2) + " m/s and " +
      fixed(report.overall.downscaled.floor.dirRmseDeg, 1) + "° against these " +
      "observations' rounding alone",
    "obs is observations scored; hrs is the model hours behind them — a station " +
      "reporting every five minutes contributes several obs to one sample",
    heights(report),
    ""
  );

  // What each term did, as distinct from whether it helped. A candidate that
  // multiplies the wind at every station by 1.2 and scores the same as the
  // model is not a term that does nothing; it is a term whose damage is hidden
  // inside a bias that was already there.
  if (candidates.length > 2) {
    out.push("what each term did to the model wind at the stations' own coordinates:");
    for (const c of candidates) {
      if (c.key === "model") continue;
      const gain = meanGain(report, c.key);
      if (gain === null) continue;
      out.push("  " + c.label.padEnd(16) + " x" + fixed(gain, 3) +
        (c.weights
          ? "   slope " + c.weights.slope + ", curvature " + c.weights.curvature +
            ", shelter " + (report.shelter ? c.weights.shelter : c.weights.shelter + " (inert, no Sx derived)") +
            ", diverting " + (c.divert ? "on" : "off")
          : ""));
    }
    out.push("");
  }

  // A term is only doing terrain work if it survives having its own mean error
  // taken away. Without this, "the downscaling is worse" and "the run is too
  // fast and the downscaling multiplies" are the same table.
  if (report.debiased && candidates.length > 1) {
    out.push("the same candidates with each one's own speed bias divided out, so a term is " +
      "graded on where it puts the wind rather than on which way it pushes the mean:");
    out.push(head);
    for (const c of candidates) {
      if (report.debiased[c.key]) {
        out.push(line(c.label, report.debiased[c.key]) +
          "   x" + fixed(report.debiased[c.key].scale, 3));
      }
    }
    out.push("each scale is fitted on the same observations it is then scored against, so " +
      "these are not scores to quote — only to compare with each other");
    out.push("");
  }

  if (Object.keys(report.byTerrain).length > 1) {
    out.push("by the terrain under the station, model then downscaled" +
      " (position read over a " + report.domain.positionRadiusM + " m disc, ±" +
      report.domain.positionThresholdM + " m separates ridge and valley from slope):");
    out.push(head);
    for (const [label, scores] of Object.entries(report.byTerrain)) {
      for (const c of candidates) {
        if (scores[c.key]) out.push(line(label + " " + (c.short || c.key), scores[c.key]));
      }
    }
    out.push("");
  }

  if (report.droppedStations && report.droppedStations.length) {
    out.push(report.droppedStations.length + " station(s) dropped, published elevation against 3DEP:");
    for (const d of report.droppedStations) {
      out.push("  " + d.station + " " + (d.name || "") + " published " + d.publishedM +
        " m, ground " + d.demElevationM + " m, out by " + d.differenceM + " m");
    }
    out.push("");
  }

  out.push("by station (downscaled):");
  out.push(head);
  for (const s of report.stations) {
    const t = s.terrain;
    out.push(line(s.id + " " + (t ? t.class : "?"), s.downscaled) +
      (t ? "   tpi" + report.domain.positionRadiusM + " " + fixed(t.positionIndexM, 1) +
        " m, tpi3x3 " + fixed(t.tpi, 2) + " m" : ""));
  }

  const missed = report.stations.filter(function (s) {
    return !s.paired && s.nearestUnmatchedMinutes !== null;
  });
  if (missed.length) {
    out.push("");
    out.push(missed.length + " station(s) reported, and none of it landed inside the " +
      report.window.toleranceMinutes + " minute window:");
    for (const s of missed) {
      out.push("  " + s.id + " " + (s.name || "") + " — nearest model hour " +
        s.nearestUnmatchedMinutes + " minutes away; --tolerance " +
        Math.ceil(s.nearestUnmatchedMinutes) + " or more would score it");
    }
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
