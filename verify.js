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
 * **The observation has a floor, and there are two of them.** A METAR is
 * rounded to a whole knot and 10° before anybody reads it, so a *perfect* model
 * cannot score better than about 0.15 m/s and 2.9° against one;
 * `quantisationFloor` computes that. The larger floor is the instrument's own:
 * the ASOS User's Guide states ±2 kt on speed and ±5° on direction, which is
 * **1.03 m/s** — seven times the rounding, and larger than every downscaling
 * candidate ever scored here put together. `instrumentTolerance` reports it,
 * and a score that quotes an error without both invites the reader to
 * attribute the anemometer to the model.
 *
 * **A reported calm is an upper bound, not a zero.** ASOS declares calm at or
 * below its 2 kt starting threshold, so `00000KT` means somewhere in 0-1.03
 * m/s, and scoring it as 0.0 makes the model look faster than it is. The
 * arithmetic still uses the reported 0 — inventing a value would be worse — but
 * `calmCeilingMps` and `speed.biasCensoringMps` say how far that could have
 * moved the answer.
 */

"use strict";

const DEG = Math.PI / 180;

/** One knot in m/s. Every ASOS figure below is published in knots. */
const KNOT_MPS = 1852 / 3600;

/**
 * The speed at or below which ASOS reports a calm.
 *
 * 2 kt. The ASOS User's Guide (March 1998, §3.2.2.1) puts the sensor's starting
 * threshold at 2 kt and says winds measured at 2 kt or less are reported as
 * calm: a 2-minute average at or below it goes out as `00000KT`. A calm is
 * therefore a censored observation with this as its ceiling, not a measurement
 * of zero.
 */
const ASOS_CALM_CEILING_MPS = 2 * KNOT_MPS;

/**
 * What the anemometer promises, which is not what it prints: ±2 kt on speed and
 * ±5° on direction above 5 kt (ASOS User's Guide, sensor specification).
 *
 * A stated tolerance is not a distribution, so it is reported as a tolerance
 * and never turned into an RMS by assuming one.
 */
const ASOS_SPEED_TOLERANCE_MPS = 2 * KNOT_MPS;
const ASOS_DIR_TOLERANCE_DEG = 5;

/**
 * Below this speed a measured direction is not evidence about the model.
 *
 * 1 m/s, just under the 2 kt at which ASOS gives up and calls it calm, and
 * between there and about 5 kt a vane's reading is dominated by eddies rather
 * than by the mean wind.
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

/**
 * How far a landform position has to be from its surroundings, in metres, to
 * call a station a ridge or a valley rather than the slope between them.
 *
 * Weiss (2001) uses ±1 standard deviation of the position index over the
 * analysis area, which is a per-area number and so a different threshold at
 * every station; 15 m stands in for it as a fixed figure measured at the
 * 500 m radius `derive.DEFAULT_POSITION_RADIUS_M` uses. It is a convention,
 * not a measurement, and the class is only as good as it is.
 */
const DEFAULT_POSITION_THRESHOLD_M = 15;

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
  const speedStepMps = o.speedStepMps === undefined ? KNOT_MPS : o.speedStepMps;
  const dirStepDeg = o.dirStepDeg === undefined ? 10 : o.dirStepDeg;
  const twelve = Math.sqrt(12);
  return {
    speedRmseMps: speedStepMps / twelve,
    dirRmseDeg: dirStepDeg / twelve,
    note: "the RMS of rounding alone: a model that is exactly right cannot score below this"
  };
}

/**
 * The tolerance the instrument is allowed, which is not the resolution it
 * prints at.
 *
 * Defaults to the ASOS specification because that is the network the first runs
 * were scored against; a caller with another network passes its own. It is an
 * interval and not an error term: it cannot be subtracted from a score, only
 * held up beside one.
 */
function instrumentTolerance(opts) {
  const o = opts || {};
  return {
    speedToleranceMps: o.speedToleranceMps === undefined
      ? ASOS_SPEED_TOLERANCE_MPS
      : o.speedToleranceMps,
    dirToleranceDeg: o.dirToleranceDeg === undefined
      ? ASOS_DIR_TOLERANCE_DEG
      : o.dirToleranceDeg,
    note: "the sensor's stated tolerance: a difference smaller than this is not evidence about the model"
  };
}

/**
 * The single factor that would put a candidate's mean speed on the observed
 * one, or null when there is nothing to scale.
 *
 * This exists because a run can carry a bias that has nothing to do with the
 * ground — the model's own, the roughness the height correction assumed, the
 * brush a RAWS tower stands in — and while it is there, **every multiplicative
 * terrain term is graded on its sign rather than on its physics**: against a
 * model that is uniformly too fast, anything that slows the wind scores better
 * and anything that speeds it up scores worse, over any terrain at all.
 *
 * Removing it is not a correction to the engine and must never be reported as
 * one. It is a second view of the same run, in which the question is whether a
 * term puts the wind in the right *place* rather than whether it happens to
 * push the mean the right way.
 */
function debiasScale(pairs, opts) {
  const o = opts || {};
  const read = o.read || function (p) { return p.sample; };
  let observed = 0;
  let modelled = 0;
  for (const p of pairs || []) {
    const m = read(p);
    if (!m || typeof m.speedMps !== "number" || !isFinite(m.speedMps)) continue;
    observed += p.observed.speedMps;
    modelled += m.speedMps;
  }
  return modelled > 0 ? observed / modelled : null;
}

/**
 * Score one candidate wind against the measured one, over a set of pairs.
 *
 * `read` pulls the candidate out of a pair's sample, so the same pairs can be
 * scored twice — once for the raw model wind and once for the downscaled one —
 * with no chance of the two runs seeing different observations. That comparison
 * is the point: an error of 2 m/s means nothing on its own, and "2.0 m/s where
 * the model alone was 2.6" is a claim about this engine.
 *
 * `scale` multiplies the candidate's speed before it is scored and leaves its
 * direction alone. It rides back out on the result because a score taken under
 * a scale fitted to the same observations is not comparable with one that was
 * not, and a number that has quietly had its bias removed is the flattering
 * kind of wrong.
 */
function score(pairs, opts) {
  const o = opts || {};
  const read = o.read || function (p) { return p.sample; };
  const scale = o.scale === undefined || o.scale === null ? 1 : o.scale;
  const calmCeilingMps = o.calmCeilingMps === undefined
    ? ASOS_CALM_CEILING_MPS
    : o.calmCeilingMps;
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
    const raw = read(p);
    const modelled = raw && typeof raw.speedMps === "number"
      ? { speedMps: raw.speedMps * scale, fromDeg: raw.fromDeg }
      : raw;
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
      // A calm was scored as the 0.0 it was reported as, but it could have been
      // anything up to the ceiling and every one of them pushes the bias the
      // same way. This is the whole of that push, not an estimate of it.
      biasCensoringMps: speedErrors.length
        ? (calm * calmCeilingMps) / speedErrors.length
        : 0,
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
    calmCeilingMps: calmCeilingMps,
    scale: scale,
    floor: quantisationFloor(o),
    instrument: instrumentTolerance(o)
  };
}

/**
 * Terrain under a station, in the four words that change what the wind does.
 *
 * Slope and landform position come from `derive.js`, which is the same
 * arithmetic the downscaling reads, so a station is classified by the terrain
 * the model saw rather than by a label somebody typed.
 *
 * **`positionIndexM` has to be measured at the scale of a landform**, which is
 * `derive.positionIndexAt` and not the `tpi` field. The field is a 3 x 3 index:
 * at 30 m spacing it describes a 90 m patch, and across ten Colorado RAWS on
 * named ridges, gulches and passes it ran from -0.3 m to +0.4 m — so every
 * threshold worth having was unreachable and every station came back `flat` or
 * `slope`. A classification that cannot return two of its four values is not a
 * classification, and it is invisible until someone counts.
 *
 * The thresholds are conventional rather than derived: Weiss's scheme separates
 * ridge and valley from slope at ±1 standard deviation of TPI, and flat from
 * sloping at 5°. `DEFAULT_POSITION_THRESHOLD_M` stands in for that standard
 * deviation with a fixed 15 m, because a per-domain deviation computed over a
 * half-mile box would mean a different threshold at every station. Both are
 * choices, and a score stratified by them is only as meaningful as they are.
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
  const threshold = o.positionIndexM === undefined ? DEFAULT_POSITION_THRESHOLD_M : o.positionIndexM;

  if (typeof t.positionIndexM !== "number" || typeof t.slopeDeg !== "number" ||
      Number.isNaN(t.positionIndexM) || Number.isNaN(t.slopeDeg)) {
    return "unknown";
  }

  if (t.positionIndexM >= threshold) return "ridge";
  if (t.positionIndexM <= -threshold) return "valley";
  return t.slopeDeg < flatDeg ? "flat" : "slope";
}

/**
 * Whether a station's published elevation agrees with the ground under its
 * published coordinate.
 *
 * A station is a name, a coordinate and an elevation typed by three different
 * people over thirty years, and the coordinate is the one that is silently
 * wrong: Iowa State's Colorado RWIS feed publishes "Herman's Gulch" at 3,153 m
 * with a coordinate in downtown Denver. Sampled at that coordinate the terrain
 * is flat, the classification says `flat`, and the station quietly grades the
 * downscaling on ground it has never stood on.
 *
 * The DEM is the arbiter because it is the thing the model actually used. A
 * disagreement does not say which of the two is wrong — only that one of them
 * is, which is enough to keep the station out of a score and off a map.
 *
 * The default tolerance is 50 m: coarse enough to absorb a 10 m DEM under a
 * station on a slope and the difference between geoid and ellipsoid heights,
 * tight enough that a valley-floor coordinate for a pass station fails it.
 */
function elevationCheck(publishedM, demM, opts) {
  const o = opts || {};
  const toleranceM = o.toleranceM === undefined ? 50 : o.toleranceM;

  if (typeof publishedM !== "number" || !isFinite(publishedM) ||
      typeof demM !== "number" || !isFinite(demM)) {
    return { ok: false, code: "no-elevation", differenceM: null, toleranceM: toleranceM };
  }

  const difference = publishedM - demM;
  if (Math.abs(difference) > toleranceM) {
    return { ok: false, code: "elevation-disagrees", differenceM: difference, toleranceM: toleranceM };
  }
  return { ok: true, code: null, differenceM: difference, toleranceM: toleranceM };
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

/**
 * The same score with one group's pairs left out at a time.
 *
 * A single RMSE over a station set is one number standing on however many
 * stations happened to be in it, and this project has twice had a result turn
 * out to be one mast: STOC2 is the extreme of Colorado's terrain axis, of its
 * wind axis and of its error axis at once, and removing it halves the terrain
 * correlation on every date scored. That was found by hand, three measurements
 * after the claim was made. Reporting the spread makes it a column instead.
 *
 * `debias` refits the scale on the surviving pairs rather than reusing the
 * full-sample one. A scale fitted on a station that is no longer being scored
 * is that station still voting, which is the thing being measured.
 *
 * The result deliberately carries `deltaMps` per group — the score *without*
 * that group minus the score with everything — so a positive number is a group
 * whose removal makes the candidate look worse, i.e. one that was carrying it.
 */
function jackknife(pairs, groupOf, opts) {
  const o = opts || {};
  const metric = o.metric || function (s) { return s.speed.rmseMps; };
  const groups = new Map();
  for (const p of pairs || []) {
    const key = groupOf(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const scoreOf = function (subset) {
    const opt = o.debias
      ? Object.assign({}, o, { scale: debiasScale(subset, o) })
      : o;
    return score(subset, opt);
  };
  const full = pairs && pairs.length ? metric(scoreOf(pairs)) : null;
  const out = [];
  for (const [key, group] of groups) {
    // One group is not a sample of anything. With nothing left to score, the
    // row says so rather than reporting a score over zero pairs.
    const rest = (pairs || []).filter(function (p) { return groupOf(p) !== key; });
    if (!rest.length) {
      out.push({ group: key, n: group.length, nRemaining: 0, metric: null, deltaMps: null });
      continue;
    }
    const without = metric(scoreOf(rest));
    out.push({
      group: key,
      n: group.length,
      nRemaining: rest.length,
      metric: without,
      deltaMps: full === null || without === null ? null : without - full
    });
  }
  const deltas = out.map(function (r) { return r.deltaMps; })
    .filter(function (v) { return typeof v === "number" && isFinite(v); })
    .sort(function (a, b) { return a - b; });
  const carrying = out.reduce(function (worst, r) {
    if (r.deltaMps === null) return worst;
    return worst === null || r.deltaMps > worst.deltaMps ? r : worst;
  }, null);
  return {
    full: full,
    groups: out,
    n: deltas.length,
    minDeltaMps: deltas.length ? deltas[0] : null,
    medianDeltaMps: deltas.length ? deltas[(deltas.length - 1) >> 1] : null,
    maxDeltaMps: deltas.length ? deltas[deltas.length - 1] : null,
    // The one group whose removal costs the most. Named rather than counted,
    // because "which station" is the question that gets asked next.
    carrying: carrying ? carrying.group : null,
    carryingDeltaMps: carrying ? carrying.deltaMps : null
  };
}

module.exports = {
  debiasScale,
  DEFAULT_MIN_DIRECTION_MPS,
  ASOS_CALM_CEILING_MPS,
  DEFAULT_POSITION_THRESHOLD_M,
  DEFAULT_TOLERANCE_MS,
  angleDifferenceDeg,
  componentsOf,
  circularMeanDeg,
  quantisationFloor,
  instrumentTolerance,
  pair,
  score,
  classifyTerrain,
  elevationCheck,
  stratify,
  jackknife
};
