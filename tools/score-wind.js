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
 *   --source     nws (default), synoptic, fems, coagmet or uscrn; synoptic needs
 *                $SYNOPTIC_API_TOKEN, and fems needs --fems-map, the station map
 *                tools/fems-stations.js writes. FEMS is the one that reaches back
 *                years; read the header of fems.js before trusting a run older
 *                than Synoptic's window. coagmet is Colorado only and measures at
 *                2-3 m; uscrn is national, measures at a documented 1.5 m and has
 *                no direction at all, so a score against it is a speed score —
 *                read the notes in sourceFor() before reading either one.
 *   --fems-map   path to the FEMS station map (default data/fems-stations.json)
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
 *   --anomaly    also score the downscaling driven by the terrain the model
 *                could not resolve — the DEM minus a wide DEM smoothed to the
 *                model's own scale — as a radius in metres (default 3000)
 *   --anomaly-resolution  metres for the wide read the smoothing runs over
 *   --mass       also score a mass-consistent solve — a wind that satisfies
 *                continuity over the ground rather than one weighted by its
 *                shape. Two rows, r = 1 and r = 0.1, because stability is the
 *                one knob and nothing here estimates it. **Slow**: the solve is
 *                the expensive thing in this tool, seconds a station-hour
 *                against milliseconds for every other row, and a station whose
 *                ground passes 45 degrees is refused and counted rather than
 *                solved on a coordinate that cannot carry it.
 *   --mass-layers   vertical layers in that solve (default 16)
 *   --mass-stretch  geometric ratio between them (default 1.2; 1 is uniform)
 *                (default 100)
 *   --exposure   also score the model wind brought to the station over a rougher
 *                surface than the national 0.03 m, one-step and through
 *                Wieringa's blending height, using HRRR's own SFCR as the
 *                model's surface
 *   --archive    read HRRR from the AWS Open Data archive instead of NOMADS, so
 *                a cycle older than about two days can be scored
 *   --out        write the full result as JSON to this path
 *   --pairs      write every model/observation pair to this path, as the
 *                artefact a correction can be refitted from
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
 * **`Wc*Oc` is two claims, not one.** The curvature term speeds the wind up
 * over convex ground and slows it down over concave ground with a single gain,
 * and the strata say those cannot be graded together: HRRR is about right on
 * ridges and roughly 2 m/s fast everywhere else. `--ablate` therefore scores
 * the sign of `Oc` apart — `no convex speed-up`, `no concave slow-down`, and
 * each half on its own — through `curvatureConvex` and `curvatureConcave`,
 * which default to `curvature` so an ordinary run is unchanged.
 *
 * **Sheltering is off unless it is asked for.** `derive` only computes Winstral
 * Sx when the spec says so, so `Wx*Ox` was identically zero in every score run
 * so far: what has been graded is the two speed-*up* terms with the one term
 * that can slow the wind down switched off. `--shelter` turns it on, at the
 * cost of a wider terrain read and the sector search.
 *
 * **The height correction is a surface as well as a height.** `--exposure`
 * scores the same model wind moved to the station over surfaces rougher than
 * the national 0.03 m, and — through Wieringa's two-step correction — between
 * HRRR's *own* roughness and the site's. The two-step rows are the only
 * candidate in this tool that can move a wind by the size of the observed bias:
 * a one-step correction from 10 m to 6.1 m is between 0.79 and 0.92 over any
 * plausible surface, and the bias is 1.7. They are candidates and nothing more —
 * the site roughness is a Davenport class chosen for the whole sample, not a
 * measurement of any one mast's fetch.
 *
 * **`--out` is a summary, and a summary cannot be refitted.** A per-station
 * *offset* can be scored on a day it was not fitted on out of the stored mean
 * and RMSE alone — `tools/site-factor.js` does exactly that — but a per-station
 * *scale* cannot, because `mean(model^2)` is nowhere in the summary. The
 * evidence says the bias is proportional, so the form that cannot be scored is
 * the form the correction probably has. `--pairs` writes the pairs themselves:
 * one row per observation with the modelled wind from every candidate beside
 * it, which is the smallest artefact any later fit can be graded on and about
 * 90 KB for a 13-station day.
 *
 * It is deliberately not part of `--out`. The summary is a document people read
 * and diff; the pairs are input to arithmetic, they are two orders of magnitude
 * larger, and a reader who opens the wrong one should be able to tell
 * immediately which they have. It is written on one line for the same reason
 * `--out` is indented: this file is read by a program and grows with the
 * station set, and pretty-printing it triples a size that is already the
 * awkward part.
 *
 * **`--archive` is how a second date happens at all.** NOMADS keeps about two
 * days, which is why every run so far is one date and the note in
 * `docs/downscaling.md` cannot say whether anything repeats. The archive keeps
 * every cycle since 2014; `archive.createArchiveSource` presents it with
 * `nomads.js`'s interface, so nothing downstream of the volume changes, and the
 * live service still reaches for NOMADS.
 *
 * **Every ranking in this tool comes with the stations it stands on.** Twice
 * now a result here has turned out to be one mast — STOC2 carries half the
 * terrain correlation in measurement 11 — and both times it was found by hand,
 * measurements after the claim. The report therefore carries a `leverage`
 * block: each candidate rescored with each station's pairs removed and its
 * debias refitted on the survivors, reported as the spread of the change and
 * the station that costs the most. `leverage.stable` is the part to read first,
 * because if the winning candidate changes with which station is held out then
 * the run did not produce a ranking, whatever the pooled table says. It is
 * arithmetic over pairs already in memory — one rescore per station per
 * candidate, no network — so it is not behind a flag; below
 * `MIN_LEVERAGE_STATIONS` stations it is null, because leaving one out of two
 * is not a distribution.
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
const geo = require("../geo.js");
const mass = require("../mass.js");
const proj = require("../proj.js");
const archive = require("../archive.js");
const observationsModule = require("../observations.js");
const roughness = require("../roughness.js");
const synoptic = require("../synoptic.js");
const fems = require("../fems.js");
const coagmet = require("../coagmet.js");
const uscrn = require("../uscrn.js");
const verify = require("../verify.js");

const HOUR_MS = 3600 * 1000;

/** Where tools/fems-stations.js writes by convention. */
const DEFAULT_FEMS_MAP = "data/fems-stations.json";

// Below three stations, leaving one out is not a distribution — it is two
// numbers, and the spread between them says more about which two stations
// answered than about the candidate. The table is omitted rather than printed
// with a caveat under it.
const MIN_LEVERAGE_STATIONS = 3;

// Every flag this tool answers to. A misspelling is checked against it rather
// than ignored: an unknown flag leaves the candidate it was meant to add out of
// the report, and a report with a row missing reads exactly like a report where
// that row had nothing to say.
const FLAGS = [
  "stations", "source", "fems-map", "end", "hours", "forecast", "radius", "resolution",
  "tolerance", "position", "elevation", "roughness", "no-height", "ablate",
  "shelter", "scales", "anomaly", "anomaly-resolution", "exposure", "archive",
  "mass", "mass-layers", "mass-stretch",
  "out", "pairs", "json"
];

// HRRR's own surface roughness, which the exposure candidates need and the live
// field never asks for. It is two more KB on a subset that is already fetched.
const EXPOSURE_VARIABLES = fieldModule.DEFAULT_VARIABLES.concat(["SFCR"]);

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (!FLAGS.includes(name)) {
      throw new Error("unknown option --" + name + "; "
        + (name.includes("=")
          ? "a value is a separate word, not --name=value"
          : "see the header of this file"));
    }
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

/**
 * Score options: which candidate wind to read, and what the observer's own
 * instrument does to the number before anybody scores it.
 *
 * Two different things, and the second is the larger: the rounding is a tenth
 * of a m/s and the sensor's stated tolerance is a whole one. Both ride out on
 * every score so that neither can be quoted without the other.
 */
function reading(floor, which) {
  return {
    read: function (p) { return p.sample.byCandidate[which]; },
    speedStepMps: floor.speedStepMps,
    dirStepDeg: floor.dirStepDeg,
    calmCeilingMps: floor.calmCeilingMps,
    speedToleranceMps: floor.speedToleranceMps,
    dirToleranceDeg: floor.dirToleranceDeg
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
  const anomaly = o.anomaly;
  const list = [
    { key: "model", label: "HRRR alone", short: "hrrr", reference: true },
    { key: "downscaled", label: "downscaled", short: "down", options: {} }
  ];
  // The same downscaled wind, brought to the station over a different surface.
  // These rows do not touch the terrain weighting at all: they replace the
  // height correction, which is the one place in this tool where a national
  // 0.03 m is asserted about thirteen masts standing in sage and scrub oak.
  //
  // The one-step rows only say what a rougher surface does to the *height*
  // change, and where a station is already at the model's height they do
  // nothing whatever. The `exposure` rows are the two-step correction and are
  // the ones with a mechanism big enough to matter: they treat HRRR's SFCR as
  // the surface the model's wind belongs to and the class as the surface the
  // mast stands on, and they move the wind even when the heights agree.
  if (o.exposure) {
    list.push(
      { key: "z0Rough", label: "site z0 0.25 m", short: "z0r",
        options: {}, exposure: { site: "rough" } },
      { key: "z0Closed", label: "site z0 1.0 m", short: "z0c",
        options: {}, exposure: { site: "closed" } },
      { key: "z0Model", label: "site z0 = SFCR", short: "z0m",
        options: {}, exposure: { site: "model" } },
      { key: "exposureRough", label: "exposure rough", short: "expr",
        options: {}, exposure: { site: "rough", model: true } },
      { key: "exposureVeryRough", label: "exposure v.rough", short: "expvr",
        options: {}, exposure: { site: "very-rough", model: true } },
      { key: "exposureClosed", label: "exposure closed", short: "expc",
        options: {}, exposure: { site: "closed", model: true } }
    );
  }
  // A different family altogether, and the reason it is a candidate rather than
  // a replacement: everything else in this table weights the model wind by a
  // function of the ground, and this one solves for a wind that conserves mass
  // over it. `mass.js` has the argument. Two rows, because the one physical
  // knob is stability: `r` near 1 lets the flow go over a hill, small `r` makes
  // vertical displacement expensive and sends it around, which is what a stable
  // nocturnal layer does. Nothing here estimates `r`, so both are scored.
  if (o.mass) {
    list.push(
      { key: "mass", label: "mass-consistent", short: "mass", options: {}, mass: { r: 1 } },
      { key: "massStable", label: "mass, stable", short: "mstab", options: {}, mass: { r: 0.1 } }
    );
  }

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
    // The curvature term's two claims, taken apart. It speeds the wind up over
    // convex ground and slows it down over concave ground, and the ablation so
    // far grades those together while the strata say they cannot be the same:
    // HRRR is already about right on ridges and roughly 2 m/s fast in valleys,
    // flats and on slopes. `noConvex` is the row that tests "the correction is
    // re-adding acceleration the model already has"; if the ridge penalty is
    // that, it goes away here and nowhere else.
    { key: "noConvex", label: "no convex speed-up", short: "noconv",
      options: { weights: { curvatureConvex: 0 } } },
    { key: "noConcave", label: "no concave slow-down", short: "noconc",
      options: { weights: { curvatureConcave: 0 } } },
    // And the same two halves with nothing else on, so a change cannot be the
    // slope term moving underneath them.
    { key: "convexOnly", label: "convex curvature only", short: "conv",
      options: { weights: { slope: 0, shelter: 0, curvatureConcave: 0 } } },
    { key: "concaveOnly", label: "concave curvature only", short: "conc",
      options: { weights: { slope: 0, shelter: 0, curvatureConvex: 0 } } },
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
  // The same downscaling over the ground the model does not already have. If
  // the ridge penalty is a double-count, this is the row where it goes away;
  // if the penalty survives it, the correction is wrong about ridges for some
  // other reason and subtracting the model's terrain is not the fix.
  if (anomaly) {
    list.push(
      { key: "anomaly", label: "terrain anomaly", short: "anom", options: {}, anomaly: true },
      // Slope is the term the subtraction actually moves: a 3 km surface
      // carries a mountainside and carries almost none of the 500 m curvature,
      // so the pair says which half of the change did anything.
      { key: "anomalySlopeOnly", label: "anomaly slope only", short: "anomslope",
        options: { weights: { curvature: 0, shelter: 0 } }, anomaly: true }
    );
    // With the divisor taken from the domain's own extremes, subtracting a
    // regional surface moves every terrain value and the largest of them
    // together, so the normalised weight barely changes and the row says
    // nothing about the hypothesis. Held still against a physical scale, the
    // subtraction is visible.
    if (o.scales) {
      list.push({ key: "anomalyFixed", label: "anomaly, fixed scales", short: "anomfix",
        options: {}, anomaly: true, scales: o.scales });
    }
  }
  return list;
}

/**
 * The factor a candidate applies for height and surface, at one station.
 *
 * The default is `downscale.heightFactor` over the run's single roughness, and
 * every candidate without an `exposure` block gets exactly that, so an
 * `--exposure` run's other rows are bit for bit what they were without it.
 *
 * Where the station's height is unpublished the correction is computed *to the
 * model's own height* rather than skipped. For a one-step row that is a factor
 * of 1 and changes nothing; for a two-step row it is the honest question —
 * "whose surface does this 10 m wind belong to" — which does not need the mast
 * to be anywhere in particular.
 *
 * Returns null when the candidate needs HRRR's roughness and the volume did not
 * carry it. A missing surface is not a smooth one, and a row silently scored at
 * 0.03 m under the name of the model's own roughness is the failure this whole
 * tool keeps finding elsewhere.
 */
function exposureFactorFor(candidate, ctx) {
  // A mass-consistent candidate is sampled at the sensor's own height on a mesh
  // that resolves it, so there is no second profile to apply on top. That is
  // the point of it: `docs/near-ground-wind.md` prices the 10 m to 2 m step at
  // about x0.72 and records that nothing here has tested it below 6.1 m, and
  // every other row in this table carries that step as a multiplier afterwards.
  // This one carries it inside the guess the solve then adjusts, which is a
  // weaker dependence rather than none.
  if (candidate.mass) return 1;
  if (!candidate.exposure) return ctx.defaultFactor;
  const from = ctx.fieldHeightAglM;
  if (from === null) return null;
  const to = ctx.sensorHeightM === null ? from : ctx.sensorHeightM;
  const needsModel = candidate.exposure.model || candidate.exposure.site === "model";
  if (needsModel && !(ctx.modelRoughnessM > 0)) return null;
  const site = candidate.exposure.site === "model"
    ? ctx.modelRoughnessM
    : roughness.roughnessOf(candidate.exposure.site);
  return roughness.exposureFactor({
    fromHeightM: from,
    toHeightM: to,
    siteRoughnessM: site,
    modelRoughnessM: candidate.exposure.model ? ctx.modelRoughnessM : null
  });
}

/**
 * A mass-consistent solve over the same ground the downscaling is weighted on.
 *
 * The mesh is a property of the terrain and the wind is not, so the mesh and
 * its faces are built once per domain and only the fluxes and the solve are
 * paid per hour. That matters: the solve is the expensive thing in this tool by
 * two orders of magnitude.
 *
 * Returns `null` with a reason when the ground is too steep for a
 * terrain-following coordinate — `mass.js` refuses above 45 degrees, measured
 * against its own staircase oracle — because a refused station is a fact about
 * the method and belongs in the report rather than in a crash.
 */
function massSolve(cache, derived, reference, fieldHeightAglM, candidate, opts) {
  const o = opts || {};
  if (cache.derived !== derived) {
    const mid = Math.floor(derived.height / 2);
    const sp = derive.spacingAt(gridOf(derived), mid);
    cache.derived = derived;
    cache.terrain = {
      width: derived.width,
      height: derived.height,
      spacingM: { x: sp.x, y: sp.y },
      elevation: derived.elevation
    };
    cache.mesh = null;
    cache.refusal = null;
    try {
      cache.mesh = mass.buildTerrainMesh(cache.terrain, o);
      if (cache.mesh.maxSlopeDeg > mass.DEFAULT_MAX_SLOPE_DEG) {
        cache.refusal = "ground reaches " + cache.mesh.maxSlopeDeg.toFixed(1)
          + " deg, past the " + mass.DEFAULT_MAX_SLOPE_DEG + " deg a terrain-following solve is trusted to";
        cache.mesh = null;
      } else {
        cache.faces = mass.terrainFaces(cache.mesh, o);
      }
    } catch (err) {
      cache.refusal = err.message;
      cache.mesh = null;
    }
  }
  if (!cache.mesh) return { field: null, refusal: cache.refusal };

  const r = candidate.mass && candidate.mass.r !== undefined ? candidate.mass.r : mass.DEFAULT_R;
  const faces = r === mass.DEFAULT_R
    ? cache.faces
    : mass.terrainFaces(cache.mesh, Object.assign({}, o, { r: r }));
  const guess = mass.terrainFluxes(cache.mesh, faces,
    { east: reference.east, north: reference.north },
    Object.assign({}, o, { referenceHeightM: fieldHeightAglM }));
  const solved = mass.solveTerrain2(cache.mesh, faces, guess, o);
  return { mesh: cache.mesh, faces: faces, field: solved, refusal: null };
}

/**
 * The solved wind at a station, bilinear through the components.
 *
 * Through east and north rather than through bearings, for the reason
 * `downscale.windAt` gives: averaging 350 and 10 degrees is 180, and a wind
 * that points backwards between two columns is the same class of bug as an
 * averaged aspect.
 */
function massSampleAt(derived, solved, lat, lon, heightAglM, roughnessM) {
  if (!solved || !solved.field) return null;
  const m = proj.fromGeographic(derived.crs, lat, lon);
  const px = (m.x - derived.transform.originX) / derived.transform.scaleX - 0.5;
  const py = (m.y - derived.transform.originY) / derived.transform.scaleY - 0.5;
  const i0 = Math.floor(px);
  const j0 = Math.floor(py);
  const fx = px - i0;
  const fy = py - j0;
  const corners = [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy], [1, 1, fx * fy]];
  let east = 0;
  let north = 0;
  let weight = 0;
  for (const c of corners) {
    if (!(c[2] > 0)) continue;
    // The same roughness the height correction on every other row uses, so a
    // difference between two rows is the method and not two different z0.
    const at = mass.terrainWindAt(solved.mesh, solved.faces, solved.field,
      i0 + c[0], j0 + c[1], heightAglM, { roughnessM: roughnessM });
    if (!at) continue;
    east += at.east * c[2];
    north += at.north * c[2];
    weight += c[2];
  }
  // A corner that is a hole drops out rather than being counted as calm; if
  // every corner is a hole there is no wind here and the station says so.
  if (!(weight > 0)) return null;
  return { speedMps: Math.hypot(east / weight, north / weight),
    fromDeg: bearingFrom(east / weight, north / weight) };
}

/** The elevation grid a derived domain was built from, in the shape a reader wants. */
function gridOf(derived) {
  return {
    crs: derived.crs,
    width: derived.width,
    height: derived.height,
    transform: derived.transform,
    bounds: derived.bounds,
    resolutionM: derived.resolutionM,
    values: derived.elevation
  };
}

/**
 * The domain re-derived from the landform a coarse model could not resolve.
 *
 * A wide, coarse DEM is smoothed with a disc of `radiusM` — that is the ground
 * a model with cells that size effectively stands on — and subtracted from the
 * fine domain. The wide read has to reach a full radius beyond the fine box or
 * the disc does not fit around its edge cells and the anomaly is void there,
 * which is why the read is a good deal wider than the domain it serves.
 *
 * Returns null when the wide ground cannot be read. A failed read is not a flat
 * anomaly: scoring the station against uncorrected terrain and calling the row
 * "anomaly" would put a candidate's name on the candidate it is being compared
 * with.
 */
async function anomalyWeightsFor(ground, station, spec) {
  const wideRadiusMiles = spec.radiusMiles + (spec.radiusM * 1.05) / geo.METERS_PER_MILE;
  const domain = fieldModule.domainOf({
    lat: station.lat,
    lon: station.lon,
    radiusMiles: wideRadiusMiles
  });
  const wide = await ground.get({
    box: domain.readBox,
    targetResolutionM: spec.resolutionM,
    resolutionM: spec.resolutionM
  });

  const regional = derive.smooth(wide.grid, { radiusM: spec.radiusM });
  const residual = derive.anomaly(gridOf(spec.derived), regional);
  if (!residual.definedCount) {
    throw fail("anomaly-void", "the smoothed wide terrain does not cover this domain");
  }

  const derived = derive.derive(residual, { curvatureLengthM: spec.curvatureLengthM });
  return {
    weights: downscale.terrainWeights(derived, { curvatureLengthM: spec.curvatureLengthM }),
    fixedWeights: spec.scales
      ? downscale.terrainWeights(derived, Object.assign(
        { curvatureLengthM: spec.curvatureLengthM }, spec.scales))
      : null,
    derived: derived,
    regional: regional,
    wideDataset: wide.dataset,
    wideResolutionM: spec.resolutionM,
    radiusM: spec.radiusM,
    definedFraction: residual.definedCount / (residual.width * residual.height)
  };
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
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
    vectorN: score.vectorN,
    scale: round(score.scale, 4),
    excluded: score.excluded,
    // What a calm was worth at most, and how far the calms in this sample could
    // have moved the bias if every one of them sat on that ceiling.
    calmCeilingMps: round(score.calmCeilingMps, 3),
    biasCensoringMps: round(score.speed.biasCensoringMps, 3),
    floor: {
      speedRmseMps: round(score.floor.speedRmseMps, 3),
      dirRmseDeg: round(score.floor.dirRmseDeg, 2)
    },
    instrument: {
      speedToleranceMps: round(score.instrument.speedToleranceMps, 3),
      dirToleranceDeg: round(score.instrument.dirToleranceDeg, 1)
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
  const anomaly = o.anomaly || null;
  const useExposure = !!o.exposure;
  const candidates = o.candidates || candidatesFor({
    ablate: o.ablate, shelter: useShelter, scales: o.scales, anomaly: !!anomaly,
    exposure: useExposure, mass: !!o.mass });
  const wantsAnomaly = candidates.some(function (c) { return c.anomaly; });
  // The wide, coarse read the smoothing runs over. It is the same terrain cache
  // the fine domains come from, so a second station in the same valley pays for
  // it once.
  const ground = o.ground || (service && service.ground) || null;
  if (wantsAnomaly && !ground) {
    throw new Error("an anomaly candidate needs a terrain source to read the wider ground from");
  }

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
  // A station whose ground is too steep for a terrain-following coordinate is
  // refused once and counted, not once an hour. The count is a result: it says
  // how much of a real station set this method can be asked about at all.
  const massRefusals = {};
  const massOptions = {
    layers: o.massLayers === undefined ? 16 : o.massLayers,
    stretch: o.massStretch === undefined ? 1.2 : o.massStretch,
    roughnessM: o.roughnessM === undefined ? downscale.DEFAULT_ROUGHNESS_M : o.roughnessM
  };
  const dropped = [];

  for (const id of ids) {
    const station = await source.station(id);
    const read = await source.observations(id, {
      start: new Date(validTimes[0].getTime() - HOUR_MS),
      end: new Date(validTimes[validTimes.length - 1].getTime() + HOUR_MS)
    });

    const samples = [];
    const rescaled = {};
    // The mesh belongs to the ground and the solve belongs to the hour.
    const massCache = {};
    // How much each candidate multiplied the model wind at this station's own
    // coordinate. The score says whether a term helped; this says what it did,
    // and the two answer different questions — a term can be harmless on
    // average and still be multiplying a ridge by 1.3.
    const gains = {};
    let terrain = null;
    let residual = null;
    let residualFailed = false;

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
      applied: false,
      // The same correction per candidate, because an exposure candidate is a
      // different surface and not a different terrain weighting: two rows here
      // can share every gain in the downscaling and still differ.
      byCandidate: {},
      modelRoughnessM: null
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
          shelter: useShelter ? true : undefined,
          // Asked for only when a candidate reads it, so an ordinary run sends
          // the request it always sent and its numbers stay comparable with
          // every run in `docs/downscaling.md`.
          variables: useExposure ? EXPOSURE_VARIABLES : undefined
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
        const ctx = {
          defaultFactor: factor,
          fieldHeightAglM: fieldHeight,
          sensorHeightM: wanted,
          modelRoughnessM: typeof field.modelRoughnessM === "number" ? field.modelRoughnessM : null
        };
        const byCandidate = {};
        for (const candidate of candidates) {
          byCandidate[candidate.key] = round(exposureFactorFor(candidate, ctx), 4);
        }
        height = Object.assign({}, height, {
          fieldHeightAglM: fieldHeight,
          factor: factor,
          applied: factor !== 1,
          byCandidate: byCandidate,
          modelRoughnessM: round(ctx.modelRoughnessM, 3)
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

      if (wantsAnomaly && !residual && !residualFailed) {
        try {
          residual = await anomalyWeightsFor(ground, station, {
            derived: field.derived,
            radiusMiles: radiusMiles,
            radiusM: anomaly.radiusM,
            resolutionM: anomaly.resolutionM,
            curvatureLengthM: field.weights.curvatureLengthM,
            scales: o.scales || null
          });
          terrain.anomalyM = round(elevationAt(residual.derived, station.lat, station.lon), 1);
          terrain.anomalySlopeDeg = derive.fieldAt(
            residual.derived, "slopeDeg", station.lat, station.lon);
          terrain.anomalyRadiusM = residual.radiusM;
          terrain.anomalyDataset = residual.wideDataset;
        } catch (err) {
          // A terrain read that failed is not an anomaly of zero. The station
          // keeps its other rows and its anomaly rows stay empty, so a gap in
          // 3DEP cannot be read later as the candidate having nothing to say.
          residualFailed = true;
          failures.push({
            station: id, validTime: validTime.toISOString(), stage: "anomaly",
            code: err.code || null, error: err.message
          });
        }
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
        if (candidate.anomaly) {
          if (!residual) {
            byCandidate[candidate.key] = { speedMps: null, fromDeg: null };
            continue;
          }
          weights = candidate.scales ? residual.fixedWeights : residual.weights;
        }
        if (candidate.scales && !candidate.anomaly) {
          if (!rescaled[candidate.key]) {
            rescaled[candidate.key] = downscale.terrainWeights(field.derived, Object.assign(
              { curvatureLengthM: field.weights.curvatureLengthM }, candidate.scales));
          }
          weights = rescaled[candidate.key];
        }
        let at;
        if (candidate.reference) {
          at = { speedMps: referenceSpeed, fromDeg: bearingFrom(reference.east, reference.north) };
        } else if (candidate.mass) {
          // Sampled at the sensor's own height, on a mesh whose lowest layer
          // resolves it, rather than at the field height and corrected
          // afterwards. That is the one structural difference between this row
          // and every other row in the table.
          const wanted = useSensorHeight && height.sensorHeightM !== null
            ? height.sensorHeightM : field.heightAglM;
          const solved = massSolve(massCache, field.derived, reference,
            field.heightAglM, candidate, massOptions);
          if (solved.refusal) {
            if (!massRefusals[id]) {
              massRefusals[id] = solved.refusal;
              failures.push({
                station: id, validTime: validTime.toISOString(), stage: "mass",
                code: "too-steep", error: solved.refusal
              });
            }
            at = null;
          } else {
            at = massSampleAt(field.derived, solved, station.lat, station.lon, wanted, roughnessM);
          }
        } else {
          at = downscale.windAt(
            Object.keys(candidate.options).length === 0 && weights === field.weights
              ? field
              : downscale.downscale(weights, reference,
                Object.assign({ heightAglM: field.heightAglM }, candidate.options)),
            station.lat, station.lon);
        }
        const factor = height.byCandidate[candidate.key];
        byCandidate[candidate.key] = at && factor !== null && factor !== undefined
          ? { speedMps: at.speedMps * factor, fromDeg: at.fromDeg }
          : { speedMps: null, fromDeg: null };
        if (at && factor !== null && factor !== undefined && referenceSpeed > 0) {
          const g = gains[candidate.key] || { sum: 0, n: 0 };
          // The gain is what the candidate did to the model wind in total, so
          // for an exposure row it is the surface correction and not the
          // terrain weighting, which is exactly the comparison being made.
          gains[candidate.key] = {
            sum: g.sum + (at.speedMps * factor) / (referenceSpeed * height.factor), n: g.n + 1
          };
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

  // The stratified split, with each candidate's *overall* speed bias taken out
  // first. This is the cell the other two tables leave empty, and the ridge
  // result turns on it.
  //
  // `byTerrain` grades a term on a stratum while the run's gain is still in it,
  // so against a model that is too fast it ranks terms by which way they push
  // the mean. `debiased` takes the gain out but pools every stratum, so it
  // cannot see a term that helps in a hollow and hurts on a crest. Only the two
  // together ask: once a candidate's overall gain is granted, does it still put
  // the wind in the wrong place on convex ground?
  //
  // **The scale is fitted over every pair and then applied to each stratum. It
  // is never refitted inside one.** A per-stratum fit would divide out the
  // difference between strata, which is the difference this table exists to
  // show — every row would come back with a speed bias near zero and a ridge
  // penalty would be invisible. The rows are therefore comparable with each
  // other, and, like `debiased`, are not scores to quote.
  const debiasedByTerrain = {};
  for (const candidate of candidates) {
    const opts = reading(floor, candidate.key);
    const scale = verify.debiasScale(allPairs, opts);
    for (const [label, scored] of Object.entries(
      verify.stratify(allPairs, classOf, Object.assign({}, opts, { scale: scale }))
    )) {
      if (!debiasedByTerrain[label]) debiasedByTerrain[label] = {};
      debiasedByTerrain[label][candidate.key] = tidy(scored);
    }
  }

  // What the ranking above is standing on.
  //
  // Every table in this tool is one number per candidate over whatever stations
  // the run happened to include, and twice now a result has turned out to be a
  // single mast — found by hand, measurements after the claim. The
  // Communications Earth & Environment station study does this as a matter of
  // course, reporting removal sensitivity as a distribution rather than a
  // score, and it costs one rescore per station per candidate over pairs that
  // are already in memory.
  //
  // The scale is refitted on the surviving stations for each leave-one-out,
  // because a debias fitted on a station that is no longer scored is that
  // station still voting. `winners` is the part to read first: if the best
  // candidate changes when one station leaves, there was no ranking.
  const stationOf = function (p) { return p.station ? p.station.id : "unknown"; };
  const distinctStations = new Set(allPairs.map(stationOf)).size;
  let leverage = null;
  if (distinctStations >= MIN_LEVERAGE_STATIONS) {
    leverage = { minStations: MIN_LEVERAGE_STATIONS, stations: distinctStations, candidates: {} };
    // Which candidate wins with each station held out. One name is a ranking;
    // several is a sample too small to have produced one. Decided on the
    // unrounded scores — the reported ones are rounded to a millimetre per
    // second, and a tie created by rounding would read as a ranking that held.
    const bestAt = new Map();
    for (const candidate of candidates) {
      const opts = Object.assign({ debias: true }, reading(floor, candidate.key));
      const jack = verify.jackknife(allPairs, stationOf, opts);
      for (const g of jack.groups) {
        if (g.metric === null) continue;
        const best = bestAt.get(g.group);
        if (!best || g.metric < best.metric) bestAt.set(g.group, { key: candidate.key, metric: g.metric });
      }
      leverage.candidates[candidate.key] = {
        fullRmseMps: round(jack.full, 3),
        minDeltaMps: round(jack.minDeltaMps, 3),
        medianDeltaMps: round(jack.medianDeltaMps, 3),
        maxDeltaMps: round(jack.maxDeltaMps, 3),
        carrying: jack.carrying,
        carryingDeltaMps: round(jack.carryingDeltaMps, 3),
        stations: jack.groups.map(function (g) {
          return { id: g.group, n: g.n, rmseMps: round(g.metric, 3), deltaMps: round(g.deltaMps, 3) };
        })
      };
    }
    const winners = {};
    for (const [id, best] of bestAt) winners[id] = best.key;
    leverage.winners = winners;
    leverage.winnerKeys = Array.from(new Set(Object.values(winners))).sort();
    leverage.stable = leverage.winnerKeys.length === 1;
  }

  const report = {
    schemaVersion: 4,
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
      // The height the two-step exposure candidates assume the two surfaces
      // have stopped mattering by. It is a choice of Wieringa's and it changes
      // the answer, so it travels with the report.
      blendingHeightM: useExposure ? roughness.DEFAULT_BLENDING_HEIGHT_M : null,
      // Null means every term was divided by the largest value inside the box,
      // which makes the answer partly a fact about the request. Two reports
      // cannot be compared without knowing which of the two this was.
      fixedScales: o.scales || null,
      // The scale the anomaly candidates called "the model's own terrain". It
      // is a choice, not a measurement: HRRR's cells are 3 km and the ground
      // its dynamics feel is some multiple of that, so a row scored at 3 km and
      // a row scored at 7.5 km are answers to different questions.
      anomaly: anomaly
    },
    source: {
      observations: o.observationSource ||
        "NWS api.weather.gov station observations (ASOS/AWOS METAR)",
      model: o.archive ? "HRRR via the AWS Open Data archive" : "HRRR via NOMADS",
      terrain: "USGS 3DEP",
      independence: independenceOf(forecastHour, o.assimilated)
    },
    stations: stations,
    candidates: candidates.map(function (c) {
      return {
        key: c.key,
        label: c.label,
        short: c.short || c.key,
        weights: c.reference ? null : Object.assign({}, downscale.DEFAULT_WEIGHTS,
          (c.options && c.options.weights) || {}),
        divert: c.reference ? null : !(c.options && c.options.divert === false),
        terrain: c.anomaly ? "anomaly" : "absolute",
        // Null for every row that uses the run's own single roughness, which is
        // all of them unless --exposure was given.
        exposure: c.exposure || null
      };
    }),
    shelter: useShelter,
    overall: overall,
    debiased: debiased,
    byTerrain: byTerrain,
    debiasedByTerrain: debiasedByTerrain,
    // Null below MIN_LEVERAGE_STATIONS stations, which is a statement about the
    // run and not a missing field.
    leverage: leverage,
    droppedStations: dropped,
    massRefusals: massRefusals,
    elevationToleranceM: elevationToleranceM,
    failures: failures,
    elapsedMs: now() - started
  };

  // The pairs are handed to a writer rather than added to the report, because
  // they are a different kind of thing: the report is read by a person and the
  // pairs are read by arithmetic. Nothing above this line changes when they are
  // not asked for.
  if (o.writePairs) o.writePairs(pairsDocument(report, allPairs, candidates));

  return report;
}

/**
 * Every pair that was scored, with the modelled wind from each candidate beside
 * the observation, as its own document.
 *
 * The summary answers "how did the run do". This answers "what happened", which
 * is the only form a later fit can be graded on: a per-station *scale* needs
 * `mean(model^2)` and a per-hour or per-direction condition needs the hour and
 * the direction, and averaging has destroyed all three by the time `--out` is
 * written. `tools/site-factor.js` reconstructs an additive correction from the
 * summary exactly and cannot reconstruct a multiplicative one at all, which is
 * the immediate reason this exists — measurement 8 says the bias is
 * proportional, so the form that could not be scored is the likely one.
 *
 * **The observation is stored as the station published it**, unrounded and
 * before any candidate touched it, so a reader can tell the measurement from
 * the arithmetic done to it. Modelled speeds carry the sensor-height factor
 * already applied, because that is the wind that was actually scored; the
 * factor is in `stations[].heightFactor` so it can be taken back out.
 *
 * Terrain travels per station rather than per pair — it does not change between
 * hours — and the position radius it was measured at travels with it, because a
 * ridge at 500 m and a ridge at 3 km are different claims.
 */
function pairsDocument(report, pairs, candidates) {
  const keys = candidates.map(function (c) { return c.key; });
  return {
    schemaVersion: 1,
    kind: "score-wind-pairs",
    generated: report.generated,
    window: report.window,
    domain: report.domain,
    source: report.source,
    candidates: report.candidates,
    stations: report.stations.map(function (s) {
      return {
        id: s.id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        elevationM: s.elevationM,
        heightFactor: s.height ? s.height.factor : null,
        terrain: s.terrain
      };
    }),
    pairs: pairs.map(function (p) {
      const modelled = {};
      for (const key of keys) {
        const m = p.sample && p.sample.byCandidate ? p.sample.byCandidate[key] : null;
        modelled[key] = m && typeof m.speedMps === "number"
          ? { speedMps: round(m.speedMps, 4), fromDeg: round(m.fromDeg, 2) }
          : null;
      }
      return {
        station: p.station.id,
        time: p.time,
        // The model hour this observation was matched to, and how far it was
        // from the measurement. A run whose pairs all sit 25 minutes apart is
        // measuring something different from one whose pairs sit on the hour,
        // and only this column can say which happened.
        sampleTimeMs: p.sample ? p.sample.timeMs : null,
        offsetMinutes: round(p.offsetMs / 60000, 1),
        observed: {
          speedMps: p.observed.speedMps,
          fromDeg: p.observed.calm ? null : p.observed.fromDeg,
          calm: !!p.observed.calm
        },
        modelled: modelled
      };
    })
  };
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

/**
 * `--anomaly`, as the radius in metres of the disc that stands for the model's
 * own terrain, with `--anomaly-resolution` for the wide read under it.
 *
 * 3 km by default because that is HRRR's cell, which is the smallest scale it
 * could possibly resolve and so the most conservative claim about what it has
 * already applied. A model does not resolve a feature it can only just sample —
 * four to six cells is the usual figure — so the honest test is a range and not
 * this number, and the report carries whichever was used.
 */
function anomalyOf(args) {
  if (!args.anomaly) return null;
  const radiusM = args.anomaly === true ? 3000 : Number(args.anomaly);
  const resolutionM = args["anomaly-resolution"] === undefined
    ? 100 : Number(args["anomaly-resolution"]);
  if (!(radiusM > 0)) throw new Error("--anomaly is a radius in metres: " + args.anomaly);
  if (!(resolutionM > 0)) {
    throw new Error("--anomaly-resolution is metres: " + args["anomaly-resolution"]);
  }
  return { radiusM: radiusM, resolutionM: resolutionM };
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
  const chosen = sourceFor(args.source, ids, args);

  const report = await buildReport({
    source: chosen.source,
    observationSource: chosen.label,
    assimilated: chosen.assimilated,
    floor: chosen.floor,
    service: fieldModule.createFieldService(args.archive
      ? { nomads: archive.createArchiveSource({}) }
      : {}),
    archive: !!args.archive,
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
    anomaly: anomalyOf(args),
    exposure: !!args.exposure,
    mass: !!args.mass,
    massLayers: args["mass-layers"] === undefined
      ? undefined : number(args["mass-layers"], 16, "mass-layers"),
    massStretch: args["mass-stretch"] === undefined
      ? undefined : number(args["mass-stretch"], 1.2, "mass-stretch"),
    endMs: endMs,
    writePairs: args.pairs && args.pairs !== true
      ? function (doc) { fs.writeFileSync(String(args.pairs), JSON.stringify(doc) + "\n"); }
      : null
  });

  if (args.out && args.out !== true) {
    fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2) + "\n");
  }

  process.stdout.write(summarise(report) + "\n");
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

/**
 * How independent the score is of the observations it is scored against.
 *
 * At f0 an ASOS is inside the analysis that is being graded, which is the
 * reason `--forecast 0` is not a verdict. It is not a fact about every network:
 * whether HRRR assimilates a given mesonet is a question about NCEP's use list
 * and its rejection list, and nobody here has read either for CoAgMet. An
 * unknown says so rather than borrowing the airport's answer in the direction
 * that flatters the score.
 */
function independenceOf(forecastHour, assimilated) {
  if (forecastHour !== 0) {
    return "partial: an f" + forecastHour +
      " forecast has not seen the observations at its own valid hour.";
  }
  if (assimilated === false) {
    return "these stations are not assimilated, so the analysis has not seen them.";
  }
  if (assimilated === null) {
    return "UNKNOWN: nobody has read NCEP's use list for this network, so assume the " +
      "analysis may have seen these stations. Downscaling is independent of them either way.";
  }
  return "NONE from HRRR: the analysis assimilates these stations. " +
    "Downscaling is independent of them.";
}

/**
 * Below this the log law is being extrapolated rather than applied.
 *
 * Every anemometer this project has scored against stands at 6.1 m or higher,
 * so the surface-layer profile that moves a 10 m model wind down to a mast has
 * only ever been used inside a factor of two. CoAgMet's 2 m masts are outside
 * that, in the layer `docs/near-ground-wind.md` says is worth ±15% on its own,
 * and a run there says so in its own summary.
 */
const NEAR_GROUND_CEILING_M = 3;

/**
 * What a RAWS does to a wind before it is scored, as far as it is known.
 *
 * `verify.js` defaults to the ASOS specification because that is what the first
 * runs were scored against, and a RAWS is not an ASOS: no equivalent of the
 * ASOS User's Guide has been read for this network, so the tolerances are left
 * null rather than borrowed. A null says "nobody has looked this up", which is
 * true, where 1.03 m/s would say the wrong thing with a citation attached.
 *
 * The calm ceiling is the one figure that can be derived rather than cited: a
 * speed rounded to a whole mile per hour reports 0 for anything under half of
 * one. That is a **lower bound on the censoring** — the cup's own starting
 * threshold is larger and unmeasured here — so a run that leans on it is
 * understating the effect, which is the safe direction.
 */
const RAWS_INSTRUMENT = {
  calmCeilingMps: 0.44704 / 2,
  speedToleranceMps: null,
  dirToleranceDeg: null
};

/**
 * The reader named on the command line.
 *
 * The token comes from the environment and never from an argument: an argument
 * is in the shell history, in `ps`, and in the transcript of whatever ran it.
 */
function sourceFor(name, ids, args) {
  const which = name === undefined || name === true ? "nws" : String(name).toLowerCase();
  if (which === "nws") {
    return {
      source: observationsModule.createObservationSource({}),
      label: "NWS api.weather.gov station observations (ASOS/AWOS METAR), " +
        "2-minute means at 33 or 27 ft, ±2 kt, calm at or below 2 kt",
      // The empty object takes verify.js's ASOS defaults, which is the right
      // instrument for this reader and the wrong one for the three below.
      floor: {},
      assimilated: true
    };
  }
  if (which === "synoptic") {
    const token = process.env.SYNOPTIC_API_TOKEN;
    if (!token) throw new Error("--source synoptic needs SYNOPTIC_API_TOKEN in the environment");
    return {
      source: synoptic.createSynopticSource({ token: token, stids: ids }),
      label: "Synoptic Data stations (RAWS and other mesonets), 1° directions, QC-flagged rows dropped",
      floor: Object.assign({}, synoptic.RAWS_QUANTISATION, RAWS_INSTRUMENT),
      // Conservative, not verified: RAWS reach NCEP through MADIS and the
      // caveat that costs us something is the one to keep.
      assimilated: true
    };
  }
  if (which === "fems") {
    // The map is required rather than optional. Without it every FEMS row is
    // refused for having no recoverable observation time — which is the
    // designed failure, but it fails a hundred station-hours at a time and the
    // reason belongs here, before the fetching starts.
    const where = args && args["fems-map"] && args["fems-map"] !== true
      ? String(args["fems-map"]) : DEFAULT_FEMS_MAP;
    if (!fs.existsSync(where)) {
      throw new Error("--source fems needs the station map " + where + "; build it with " +
        "SYNOPTIC_API_TOKEN=… node tools/fems-stations.js --stations " + ids.join(",") +
        " --out " + where + ". FEMS labels an observation with the nearest whole hour and " +
        "the map carries the minute each station actually transmits at.");
    }
    let map = null;
    try {
      map = JSON.parse(fs.readFileSync(where, "utf8"));
    } catch (err) {
      throw new Error(where + " is not readable as the JSON fems-stations.js writes: " +
        (err && err.message ? err.message : String(err)));
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error(where + " is not a station map: it should be an object keyed by station id");
    }
    const missing = ids.filter(function (id) { return !map[id]; });
    if (missing.length) {
      throw new Error(where + " has no entry for " + missing.join(",") +
        "; calibrate them or leave them out of --stations rather than scoring them " +
        "against an hour label");
    }
    return {
      source: fems.createFemsSource({ stations: map, stationIds: ids }),
      label: "USDA FEMS RAWS archive, 1 mph speeds and 1° directions, observation times " +
        "recovered from " + where,
      floor: Object.assign({}, fems.RAWS_QUANTISATION, RAWS_INSTRUMENT),
      assimilated: true
    };
  }
  // CoAgMet is the first network here standing *inside* the layer the product
  // is about, and that is also what makes a score from it easy to over-read:
  // the model is brought from 10 m to 2 m by a profile no measurement in this
  // project has ever tested below 6.1 m, and it is doing more work (x0.72 over
  // short grass, x0.56 over scrub) than every terrain candidate combined. The
  // instrument figures below are the network's, not the station's — the API
  // names no anemometer per site, so the worse of the two cups CoAgMet
  // documents is used, and a reported 0.0 is censored at the larger of the two
  // starting thresholds rather than at either sensor's own.
  //
  // Whether the analysis has seen these masts is left unknown rather than
  // assumed either way: an agricultural 2 m wind is the kind of observation a
  // mesonet rejection list exists for, and nobody here has read NCEP's.
  if (which === "coagmet") {
    return {
      source: coagmet.createCoagmetSource({}),
      label: "CoAgMet Colorado mesonet, 5-minute or hourly means at a published " +
        "2-3 m, timestamps ending the averaging interval, R.M. Young cups " +
        "(±0.3-0.5 m/s, ±3-5°, starting at 0.5-1.0 m/s)",
      floor: Object.assign({}, coagmet.COAGMET_QUANTISATION, coagmet.COAGMET_INSTRUMENT),
      assimilated: null
    };
  }
  // USCRN is the only instrument in this project inside the 0-3 m layer the
  // product is about, and the only one whose height is a specification rather
  // than a survey: `WIND_1_5` is documented as a 5-minute mean at 1.5 m.
  //
  // Two things about a score from it. **It has no direction**, so `verify.js`
  // returns speed only and the direction and vector columns are empty — and
  // measurement 16 put HRRR's direction RMSE at 2 m at 53-62 degrees, so the
  // quantity most in doubt down there is the one this network cannot grade.
  // **And the profile step is bigger here than anywhere else**: bringing the
  // model from 10 m to 1.5 m over short grass is x0.673, against x0.723 to a
  // 2 m mast and x0.915 to a 6.1 m one, so more of the answer is the log law
  // and less of it is HRRR than in any earlier run.
  //
  // Whether NCEP assimilates USCRN is not known here, so independence is
  // reported UNKNOWN rather than assumed either way.
  if (which === "uscrn") {
    return {
      source: uscrn.createUscrnSource({ refine: true }),
      label: "USCRN sub-hourly, 5-minute mean speed at a documented 1.5 m, no " +
        "direction in the product, timestamps ending the averaging interval, " +
        "Met One 014A cups (±0.25 mph or 1.5% FS, starting at 1.0 mph), " +
        "positions refined from HOMR where they agree with the catalogue",
      floor: Object.assign({}, uscrn.USCRN_QUANTISATION, uscrn.USCRN_INSTRUMENT),
      assimilated: null
    };
  }
  throw new Error("--source is nws, synoptic, fems, coagmet or uscrn, not " +
    JSON.stringify(name));
}

/**
 * The vector error, or a dash where it would not be over the sample.
 *
 * A pair only has a vector error if the observation has a bearing, and USCRN
 * publishes none at all — so the only pairs contributing one there are the
 * calms, whose observed vector is the zero one. Printed unqualified in a column
 * beside `n`, an RMS over one calm out of 192 observations reads exactly like
 * an RMS over all 192, which is why a network with no vane gets a dash here
 * however many calms it reported. Where the network does measure a bearing the
 * number is a real subsample and stays, with `bearingNote` saying how much of
 * the run it covers.
 */
function vectorCell(score) {
  if (!score.vectorN) return fixed(null, 2).padStart(9);
  if (!score.direction || !score.direction.n) return fixed(null, 2).padStart(9);
  return fixed(score.vectorRmseMps, 2).padStart(9);
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
    vectorCell(score)
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

/** The same, with the sign kept — a leverage of +0.02 and one of -0.02 are
 * opposite findings and a bare `0.02` hides which. */
function signed(value) {
  if (value === null || value === undefined) return "—";
  return (value >= 0 ? "+" : "") + value.toFixed(3);
}

/**
 * The tolerance the anemometer is allowed, beside the score it is judged with.
 *
 * This is the sentence that stops a 0.06 m/s spread between candidates being
 * read as a result: the ASOS User's Guide allows the instrument ±2 kt, which is
 * 1.03 m/s, seventeen times that spread. It is not subtracted from anything —
 * a tolerance is not an error — it is printed where the errors are.
 */
function instrumentNote(report) {
  const inst = (report.overall.downscaled || {}).instrument || {};
  if (inst.speedToleranceMps === null || inst.speedToleranceMps === undefined) {
    return "this network's instrument tolerance has not been looked up, so a difference " +
      "smaller than the sensor's own accuracy cannot be ruled out here";
  }
  return "the sensor is allowed ±" + fixed(inst.speedToleranceMps, 2) + " m/s and ±" +
    fixed(inst.dirToleranceDeg, 0) + "° by its own specification: a difference smaller " +
    "than that is not evidence about the model";
}

/**
 * Which of the scored observations had a bearing at all.
 *
 * Three of the four columns to the right of the speed need one, and a source
 * can simply not have it: USCRN's sub-hourly product publishes a 1.5 m speed
 * and no direction, so a run against it is a speed run with three empty
 * columns, and the emptiness is the finding rather than a formatting accident.
 * Measurement 16 put HRRR's direction RMSE at 2 m at 53-62°, which is the
 * quantity a direction-less network leaves ungraded.
 */
function bearingNote(report) {
  const s = report.overall.downscaled || {};
  const withBearing = (s.direction && s.direction.n) || 0;
  if (withBearing === s.n) return null;
  if (!withBearing) {
    return "no observation in this run carried a direction, so this is a speed score: " +
      "the direction and vector columns are empty because the network does not " +
      "measure a bearing, not because the model got it right";
  }
  return withBearing + " of " + s.n + " observations carried a direction; the " +
    "direction and vector columns are over those and the speed columns are over all of them";
}

/**
 * How far the calms in this run could have moved the speed bias.
 *
 * A reported calm is censored, not measured — ASOS declares one at or below
 * 2 kt — so scoring it as 0.0 makes every model look faster than it is. The
 * arithmetic keeps the reported 0 and this line says what that cost, which is
 * the honest way round: an invented value would be in the numbers, where this
 * is only beside them.
 */
function censoringNote(report) {
  const s = report.overall.downscaled || {};
  const calms = (s.excluded && s.excluded.calm) || 0;
  if (!calms) return "no observation in this run was reported calm, so none of the speed " +
    "bias is the censoring at the bottom of the instrument's range";
  return calms + " observation(s) were reported calm and scored as 0.0, which the " +
    "instrument censors at " + fixed(s.calmCeilingMps, 2) + " m/s: at most " +
    fixed(s.biasCensoringMps, 3) + " m/s of every speed bias above is that and not the model";
}

/**
 * One line about the height the model was moved to, per height in the run.
 *
 * Grouped rather than per station because a whole network shares a standard —
 * every RAWS is nominally at 6.1 m — and fifteen identical lines would bury the
 * one station that is different. ASOS is the network that does *not* share one:
 * the User's Guide says 33 ft or 27 ft "depending on local site-specific
 * criteria", so an airport run is grouped for a reason and not by convention.
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
      // A mast below 3 m is outside the range the log law has ever been
      // checked against here, and the correction there is large: 10 m to 2 m
      // over short grass is x0.72, and over scrub it is x0.56. Naming it is
      // the whole difference between a score and a claim.
      const extrapolated = h.sensorHeightM < NEAR_GROUND_CEILING_M
        ? ", below anything this profile has been checked at" : "";
      parts.push(group.ids.length + " at " + h.sensorHeightM + " m AGL, model moved by x" +
        fixed(h.factor, 3) + extrapolated);
    }
  }
  if (!parts.length) return "measurement height: no stations scored";
  return "measurement height: " + parts.join("; ") +
    " (log law, z0 " + report.domain.roughnessM + " m; speed only, no veering)";
}

/**
 * What surface each exposure candidate stood the station on, and what that did.
 *
 * Printed only when a run asked for them. The model's own roughness is a
 * measurement and is reported as a range across the stations, because a single
 * mean over thirteen sites would hide that HRRR already thinks some of them are
 * six times rougher than the downscaler's national assumption.
 */
function surfaces(report) {
  const candidates = candidatesOf(report).filter(function (c) { return c.exposure; });
  if (!candidates.length) return [];

  const model = [];
  for (const s of report.stations) {
    const z = s.height && s.height.modelRoughnessM;
    if (typeof z === "number") model.push(z);
  }
  const out = [
    "HRRR's own surface roughness at these stations (SFCR): " + (model.length
      ? fixed(Math.min.apply(null, model), 3) + "–" + fixed(Math.max.apply(null, model), 3) +
        " m over " + model.length + " stations, against the downscaler's " +
        report.domain.roughnessM + " m"
      : "not carried by the volume; the rows that need it are empty"),
    "what each surface did to the model wind, as a factor on the height correction:"
  ];
  for (const c of candidates) {
    const factors = [];
    for (const s of report.stations) {
      const f = s.height && s.height.byCandidate && s.height.byCandidate[c.key];
      if (typeof f === "number") factors.push(f);
    }
    out.push("  " + c.label.padEnd(16) + (factors.length
      ? " x" + fixed(Math.min.apply(null, factors), 3) + "–" +
        fixed(Math.max.apply(null, factors), 3)
      : " not scored") +
      "   site " + c.exposure.site +
      (c.exposure.model
        ? ", blended from SFCR at " + report.domain.blendingHeightM + " m"
        : ", one step"));
  }
  out.push("a site roughness is a Davenport class asserted over the whole sample, not a " +
    "measurement of any one mast's fetch");
  out.push("");
  return out;
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
    instrumentNote(report),
    censoringNote(report)
  );
  const bearing = bearingNote(report);
  if (bearing) out.push(bearing);
  out.push(heights(report), "");
  for (const row of surfaces(report)) out.push(row);

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

  // The same split, with the run's own gain taken out. `byTerrain` above ranks
  // terms partly by which way they push the mean; this asks whether a term is
  // in the right place on that ground once its gain is granted.
  if (report.debiasedByTerrain && Object.keys(report.debiasedByTerrain).length > 1
      && candidates.length > 1) {
    out.push("the same split with each candidate's overall speed bias divided out — one " +
      "scale fitted over every pair, not refitted inside a stratum, so a term that helps " +
      "in a hollow and hurts on a crest still shows both:");
    out.push(head);
    for (const [label, scores] of Object.entries(report.debiasedByTerrain)) {
      for (const c of candidates) {
        if (scores[c.key]) out.push(line(label + " " + (c.short || c.key), scores[c.key]));
      }
    }
    out.push("fitted on the observations they are then scored against — compare these with " +
      "each other, do not quote them");
    out.push("");
  }

  // How much of the ranking above is one station. Printed after the debiased
  // table because it is that table's error bar, and read before it because a
  // ranking that changes when one mast leaves was never a ranking.
  if (report.leverage && candidates.length > 1) {
    const lev = report.leverage;
    out.push("leave one station out, debiased speed RMSE refitted on the survivors (" +
      lev.stations + " stations):");
    out.push(["candidate".padEnd(16), "rmse".padStart(7), "worst".padStart(7),
      "median".padStart(7), "best".padStart(7), "  carried by"].join(" "));
    for (const c of candidates) {
      const l = lev.candidates[c.key];
      if (!l) continue;
      out.push([c.label.padEnd(16), fixed(l.fullRmseMps, 3).padStart(7),
        signed(l.maxDeltaMps).padStart(7), signed(l.medianDeltaMps).padStart(7),
        signed(l.minDeltaMps).padStart(7),
        "  " + (l.carrying || "-") + " " + signed(l.carryingDeltaMps)].join(" "));
    }
    out.push("worst/median/best are the change in RMSE when one station is removed — a " +
      "positive number is a station whose removal makes the candidate look worse, so it " +
      "was carrying it");
    out.push(lev.stable
      ? "the same candidate wins with every station held out: " + lev.winnerKeys[0]
      : "the winning candidate changes with which station is held out (" +
        lev.winnerKeys.join(", ") + ") — this sample has not produced a ranking");
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

module.exports = { parse, hoursIn, bearingFrom, buildReport, pairsDocument, summarise, sourceFor };

if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write((err && err.stack ? err.stack : String(err)) + "\n");
    process.exit(1);
  });
}
