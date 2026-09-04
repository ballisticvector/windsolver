/**
 * Scoring a modelled wind against a measured one.
 *
 * `field.js` produces a wind over ground. `observations.js` reads what a
 * station measured over the same ground. This module is the arithmetic in
 * between, and it is deliberately pure: it fetches nothing, it samples nothing,
 * and every function here can be run against numbers typed into a test.
 *
 * It exists because `confidence` in the published contract is `null`, and the
 * only honest way to make it a number is to have missed by a measured amount
 * first. Until then this is a report, not an endpoint — see `tools/score-wind.js`.
 *
 * Five decisions that are the difference between a score and a number:
 *
 * **Direction error is circular, and it is not the difference of two bearings.**
 * 350° and 10° are 20° apart, not 340°. Every direction statistic here goes
 * through `angleDifferenceDeg`, and the bias is a circular mean — the arithmetic
 * mean of signed differences is fine near zero and wrong the moment the sample
 * straddles the wrap.
 *
 * **A light wind has no direction worth grading.** At 1 m/s an anemometer vane
 * is chasing eddies and the METAR rounds what is left to 10°, so a direction
 * error there says nothing about the model. Observations below
 * `DEFAULT_MIN_DIRECTION_MPS` are counted and kept out of the direction
 * statistics, and out of them only.
 *
 * **Speed and direction hide each other, so the vector error is reported too.**
 * A model that has the speed exactly right and the direction 180° wrong scores
 * a perfect speed bias. `vectorRmseMps` is the RMS length of the difference of
 * the two wind vectors, which cannot be gamed that way, and it is the number to
 * quote if only one is quoted.
 *
 * **Bias is signed and reported separately from RMSE.** A model 2 m/s too fast
 * everywhere and a model with 2 m/s of scatter have the same RMSE and want
 * completely different fixes.
 *
 * **The observation has a floor.** A METAR is rounded to a whole knot and 10°
 * before anybody reads it, so a *perfect* model cannot score better than about
 * 0.15 m/s and 2.9° against one. `quantisationFloor` computes that, and a score
 * that quotes an error without it invites the reader to attribute the rounding
 * to the model.
 */

"use strict";

const DEG = Math.PI / 180;

/**
 * Below this speed a measured direction is not evidence about the model.
 *
 * 1 m/s, just under 2 kt. ASOS reports calm below 3 kt in the METAR
 * (AC 00-45H / FMH-1), and between calm and about 5 kt a vane's reading is
 * dominated by eddies rather than by the mean wind.
 */
const DEFAULT_MIN_DIRECTION_MPS = 1.0;

/**
 * How far an observation may sit from a model valid time and still be paired.
 *
 * Ten minutes. HRRR is hourly and a METAR is on the hour with specials in
 * between, so a tolerance shorter than this drops most of the sample; much
 * longer and the wind has genuinely changed, which scores the weather rather
 * than the model.
 */
const DEFAULT_TOLERANCE_MS = 10 * 60 * 1000;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/** The signed shortest way from `b` to `a`, in (-180, 180]. */
function angleDifferenceDeg(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * A wind's east and north components, from the direction it blows *from*.
 *
 * A wind from 270° blows toward the east, so east is positive. This is the same
 * convention as `downscale.readWind`, inverted; if the two ever disagree the
 * scores here are meaningless and every test in this file passes.
 */
function componentsOf(speedMps, fromDeg) {
  const rad = fromDeg * DEG;
  return {
    east: -speedMps * Math.sin(rad),
    north: -speedMps * Math.cos(rad)
  };
}

/**
 * Pair each observation with the model sample nearest in time.
 *
 * Both sides are matched, not interpolated: a wind is not linear in time and an
 * interpolated observation is a modelled observation, which is the one thing
 * that must not appear on the measured side of a comparison.
 *
 * A sample may be claimed by several observations — a specials-heavy hour has
 * three METARs against one hourly field — so `pairs` can be longer than
 * `samples`. That is a correlated sample and it makes the effective count
 * smaller than `n`; `verify` reports `distinctSamples` so the reader can see it.
 */
function pair(observations, samples, opts) {
  const o = opts || {};
  const toleranceMs = o.toleranceMs === undefined ? DEFAULT_TOLERANCE_MS : o.toleranceMs;
  if (!Array.isArray(observations)) throw fail("bad-observations", "observations must be an array");
  if (!Array.isArray(samples)) throw fail("bad-samples", "samples must be an array");

  const pairs = [];
  const unmatched = [];

  for (const observed of observations) {
    let best = null;
    let bestOffset = Infinity;
    for (const sample of samples) {
      const offset = Math.abs(sample.timeMs - observed.timeMs);
      if (offset < bestOffset) {
        bestOffset = offset;
        best = sample;
      }
    }

    if (!best || bestOffset > toleranceMs) {
      unmatched.push({ time: observed.time, code: "no-sample", offsetMs: best ? bestOffset : null });
      continue;
    }

    pairs.push({
      stationId: observed.stationId === undefined ? null : observed.stationId,
      time: observed.time,
      timeMs: observed.timeMs,
      offsetMs: best.timeMs - observed.timeMs,
      observed: observed,
      sample: best
    });
  }

  return { pairs: pairs, unmatched: unmatched };
}

function rms(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The circular mean of a set of signed differences, which is where a bias lives. */
function circularMeanDeg(differences) {
  if (!differences.length) return null;
  let sin = 0;
  let cos = 0;
  for (const d of differences) {
    sin += Math.sin(d * DEG);
    cos += Math.cos(d * DEG);
  }
  if (Math.abs(sin) < 1e-12 && Math.abs(cos) < 1e-12) return null;
  return Math.atan2(sin, cos) / DEG;
}

/**
 * The best score a perfect model could get against a quantised observation.
 *
 * A value rounded to a step of `s` carries an error uniform on ±s/2, whose RMS
 * is s/√12. A METAR is a whole knot and 10°, which is 0.148 m/s and 2.89°.
 */
function quantisationFloor(opts) {
  const o = opts || {};
  const speedStepMps = o.speedStepMps === undefined ? 1852 / 3600 : o.speedStepMps;
  const dirStepDeg = o.dirStepDeg === undefined ? 10 : o.dirStepDeg;
  const twelve = Math.sqrt(12);
  return {
    speedRmseMps: speedStepMps / twelve,
    dirRmseDeg: dirStepDeg / twelve,
    note: "the RMS of rounding alone: a model that is exactly right cannot score below this"
  };
}

/**
 * Score one candidate wind against the measured one, over a set of pairs.
 *
 * `read` pulls the candidate out of a pair's sample, so the same pairs can be
 * scored twice — once for the raw model wind and once for the downscaled one —
 * with no chance of the two runs seeing different observations. That comparison
 * is the point: an error of 2 m/s means nothing on its own, and "2.0 m/s where
 * the model alone was 2.6" is a claim about this engine.
 */
function score(pairs, opts) {
  const o = opts || {};
  const read = o.read || function (p) { return p.sample; };
  const minDirectionMps = o.minDirectionMps === undefined
    ? DEFAULT_MIN_DIRECTION_MPS
    : o.minDirectionMps;

  const speedErrors = [];
  const dirErrors = [];
  const vectorErrors = [];
  const observedSpeeds = [];
  const modelledSpeeds = [];
  const distinct = new Set();

  let missingSample = 0;
  let calm = 0;
  let belowDirectionThreshold = 0;
  let noObservedDirection = 0;

  for (const p of pairs) {
    const observed = p.observed;
    const modelled = read(p);
    // A sample belongs to one station at one hour, so counting hours alone
    // would collapse five stations into one and understate the evidence.
    distinct.add(p.stationId + "@" + (p.sample && p.sample.timeMs));

    if (!modelled || typeof modelled.speedMps !== "number" || !isFinite(modelled.speedMps)) {
      missingSample++;
      continue;
    }

    speedErrors.push(modelled.speedMps - observed.speedMps);
    observedSpeeds.push(observed.speedMps);
    modelledSpeeds.push(modelled.speedMps);
    if (observed.calm) calm++;

    // The vector error needs a direction on both sides. A calm observation has
    // no direction, but it does have a vector — the zero one — so it is
    // included here and excluded from the direction statistics. That is not an
    // inconsistency: the model claiming 6 m/s over a calm station is an error
    // the vector norm should carry, and an angle it should not.
    const observedVector = observed.calm
      ? { east: 0, north: 0 }
      : (observed.fromDeg === null ? null : componentsOf(observed.speedMps, observed.fromDeg));

    if (observedVector && typeof modelled.fromDeg === "number") {
      const m = componentsOf(modelled.speedMps, modelled.fromDeg);
      const de = m.east - observedVector.east;
      const dn = m.north - observedVector.north;
      vectorErrors.push(Math.sqrt(de * de + dn * dn));
    }

    if (observed.calm) continue;
    if (observed.fromDeg === null) {
      noObservedDirection++;
      continue;
    }
    if (observed.speedMps < minDirectionMps) {
      belowDirectionThreshold++;
      continue;
    }
    if (typeof modelled.fromDeg !== "number" || !isFinite(modelled.fromDeg)) {
      noObservedDirection++;
      continue;
    }

    dirErrors.push(angleDifferenceDeg(modelled.fromDeg, observed.fromDeg));
  }

  const absDir = dirErrors.map(Math.abs);

  return {
    n: speedErrors.length,
    distinctSamples: distinct.size,
    speed: {
      biasMps: mean(speedErrors),
      maeMps: mean(speedErrors.map(Math.abs)),
      rmseMps: rms(speedErrors),
      observedMeanMps: mean(observedSpeeds),
      modelledMeanMps: mean(modelledSpeeds)
    },
    direction: {
      n: dirErrors.length,
      biasDeg: circularMeanDeg(dirErrors),
      maeDeg: mean(absDir),
      rmseDeg: rms(dirErrors),
      within30Deg: absDir.length
        ? absDir.filter(function (d) { return d <= 30; }).length / absDir.length
        : null
    },
    vectorRmseMps: rms(vectorErrors),
    excluded: {
      missingSample: missingSample,
      calm: calm,
      belowDirectionThreshold: belowDirectionThreshold,
      noDirection: noObservedDirection
    },
    minDirectionMps: minDirectionMps,
    floor: quantisationFloor(o)
  };
}

/**
 * Terrain under a station, in the four words that change what the wind does.
 *
 * Slope and topographic position come from `derive.js`, which is the same
 * arithmetic the downscaling reads, so a station is classified by the terrain
 * the model saw rather than by a label somebody typed. The thresholds are
 * conventional rather than derived: Weiss's TPI classification uses ±1 standard
 * deviation of TPI to separate ridge and valley from slope, and 5° separates
 * flat from sloping in the same scheme. Both are choices, and a score
 * stratified by them is only as meaningful as they are.
 *
 * The point of stratifying at all: an airport in a plain is where a 3 km model
 * is already right, and a canyon is where it is not. One pooled RMSE over a
 * network of airfields would flatter the downscaling by never asking it to do
 * anything.
 */
function classifyTerrain(terrain, opts) {
  const t = terrain || {};
  const o = opts || {};
  const flatDeg = o.flatDeg === undefined ? 5 : o.flatDeg;
  const tpiThreshold = o.tpiM === undefined ? 5 : o.tpiM;

  if (typeof t.tpi !== "number" || typeof t.slopeDeg !== "number" ||
      Number.isNaN(t.tpi) || Number.isNaN(t.slopeDeg)) {
    return "unknown";
  }

  if (t.tpi >= tpiThreshold) return "ridge";
  if (t.tpi <= -tpiThreshold) return "valley";
  return t.slopeDeg < flatDeg ? "flat" : "slope";
}

/** The same score, cut by whatever `labelOf` says each pair is. */
function stratify(pairs, labelOf, opts) {
  const groups = new Map();
  for (const p of pairs) {
    const label = labelOf(p);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(p);
  }
  const out = {};
  for (const [label, group] of groups) out[label] = score(group, opts);
  return out;
}

module.exports = {
  DEFAULT_MIN_DIRECTION_MPS,
  DEFAULT_TOLERANCE_MS,
  angleDifferenceDeg,
  componentsOf,
  circularMeanDeg,
  quantisationFloor,
  pair,
  score,
  classifyTerrain,
  stratify
};
