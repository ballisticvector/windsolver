/**
 * The two halves joined: a 3 km model wind, bent by the ground under it.
 *
 * HRRR resolves a mountain range. It does not resolve the ridge you are
 * standing on, and it does not know the canyon exists at all — its terrain
 * under Boulder is a smooth ramp, and the wind it reports there is the wind
 * over that ramp. Downscaling is the arithmetic that turns one coarse vector
 * into a field over real ground: faster over a crest, slower in a hollow,
 * turned along a valley, killed behind a wall.
 *
 * The method is MicroMet's (Liston & Elder 2006), which is the standard
 * empirical downscaling in operational snow and fire modelling, plus Winstral's
 * sheltering as a third term. It is a diagnostic model: it weights the model
 * wind by terrain shape. It does not solve the momentum equations, so it cannot
 * produce a rotor, a hydraulic jump or a lee eddy that reverses — WindNinja's
 * momentum solver and CFD are the tiers above it. What it can do is run in
 * milliseconds over a cached domain, which is what puts a wind field on a
 * screen while someone is standing on the hill.
 *
 * **Everything that depends only on the ground is separated from everything
 * that depends on the hour.** `terrainWeights` is static, and belongs in the
 * static cache next to the derivatives it is built from; `downscale` is the
 * per-request arithmetic over grids that already exist. That split is the whole
 * reason the derivatives were computed separately in the first place.
 *
 * Nothing here touches the network, and nothing here knows about a rifle.
 *
 * Sources:
 *   Liston, G.E. & Elder, K. (2006) "A meteorological distribution system for
 *     high-resolution terrestrial modeling (MicroMet)", J. Hydrometeorology 7,
 *     equations 15-19: the slope and curvature weights and the diverting angle.
 *   Winstral, A. & Marks, D. (2002); Winstral et al. (2009): the Sx shelter
 *     parameter used here as a third multiplicative term.
 */

"use strict";

const cog = require("./cog");
const derive = require("./derive");

/**
 * Length scale of the curvature term, in metres.
 *
 * MicroMet's curvature is meant to be measured over about half the wavelength
 * of the terrain features that matter — ridge to valley, a few hundred metres
 * in mountain country. **It is emphatically not the pixel-scale curvature in
 * `derive.js`**: at 1 m or 10 m spacing a 3 x 3 curvature measures the boulder,
 * not the ridge, and weighting a wind by it produces a field that is noisy at
 * exactly the scale nobody can feel. SnowModel's own default is 500 m.
 */
const DEFAULT_CURVATURE_LENGTH_M = 500;

/**
 * Weights of the three terms.
 *
 * `slope` and `curvature` are Liston & Elder's, which sum to 1 by construction
 * so that the combined weighting factor stays inside 0.5 to 1.5. `shelter` is
 * not theirs: Winstral's Sx is folded in here as a separate multiplicative
 * term, and 0.5 is a judgement about how much a sheltered pixel should slow
 * down, **not a calibrated coefficient**. Nothing in this repository has been
 * compared against an anemometer.
 */
const DEFAULT_WEIGHTS = { slope: 0.5, curvature: 0.5, shelter: 0.5 };

/** Von Karman, and a roughness length for short grass — see `heightFactor`. */
const DEFAULT_ROUGHNESS_M = 0.03;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function filled(n) { return new Float32Array(n).fill(NaN); }

/** Bilinear elevation at a fractional pixel, NaN off the grid or in a void. */
function elevationAtPixel(weights, px, py) {
  const w = weights.width;
  const h = weights.height;
  if (!(px >= 0 && py >= 0 && px <= w - 1 && py <= h - 1)) return NaN;
  const x0 = Math.min(w - 2, Math.floor(px));
  const y0 = Math.min(h - 2, Math.floor(py));
  const fx = px - x0;
  const fy = py - y0;
  const z = weights.elevation;
  const v00 = z[y0 * w + x0];
  const v10 = z[y0 * w + x0 + 1];
  const v01 = z[(y0 + 1) * w + x0];
  const v11 = z[(y0 + 1) * w + x0 + 1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/**
 * MicroMet's curvature at a length scale, dimensionless.
 *
 * The mean, over the four axes of the compass rose, of how far the centre
 * stands above the midpoint of the two points `eta` metres away along that
 * axis, divided by twice `eta`. Positive on a crest, negative in a hollow, and
 * measuring the ridge rather than the rock because `eta` is hundreds of metres
 * rather than one pixel.
 *
 * Sampled bilinearly along the four axes in the grid's own geometry, so a
 * geographic grid's unequal x and y spacing is handled by converting metres to
 * pixels per axis rather than by pretending a pixel is square.
 */
function scaleCurvature(weights, lengthM) {
  const eta = lengthM / 2;
  const w = weights.width;
  const h = weights.height;
  const out = filled(w * h);
  const diag = eta / Math.SQRT2;

  for (let y = 0; y < h; y++) {
    const step = weights.spacingAt(y);
    // Offsets in pixels for the four axes: N-S, E-W, and the two diagonals.
    const ex = eta / step.x;
    const ey = eta / step.y;
    const dx = diag / step.x;
    const dy = diag / step.y;
    for (let x = 0; x < w; x++) {
      const z0 = weights.elevation[y * w + x];
      if (Number.isNaN(z0)) continue;
      let sum = 0;
      let ok = true;
      const pairs = [
        [0, -ey, 0, ey],
        [-ex, 0, ex, 0],
        [-dx, -dy, dx, dy],
        [dx, -dy, -dx, dy]
      ];
      for (const p of pairs) {
        const a = elevationAtPixel(weights, x + p[0], y + p[1]);
        const b = elevationAtPixel(weights, x + p[2], y + p[3]);
        if (Number.isNaN(a) || Number.isNaN(b)) { ok = false; break; }
        sum += (z0 - (a + b) / 2) / (2 * eta);
      }
      // A cell whose rose reaches off the domain is unknown, not flat: read the
      // window with `lengthM / 2` of padding if the edges matter.
      if (ok) out[y * w + x] = sum / 4;
    }
  }
  return out;
}

/** Largest finite magnitude in a field, or 0 if it has none. */
function maxAbs(values) {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (v > max && Number.isFinite(v)) max = v;
  }
  return max;
}

/**
 * Scale a field onto -0.5..+0.5 by dividing by twice its largest magnitude.
 *
 * Liston & Elder's normalisation, and the reason the weighting factor is
 * bounded to 0.5..1.5 whatever the terrain. It is a *relative* measure by
 * design: the same ridge in a domain full of bigger ridges gets a smaller
 * weight, because the model wind is already the average over the domain.
 *
 * **That only holds while the domain is fixed.** In MicroMet the domain is the
 * region being simulated; here it is whatever box a caller asked for, so the
 * divisor moves with the request and the wind at one coordinate changes when a
 * bigger box brings a bigger feature into a corner it never touches. Pass a
 * scale in the field's own units — `curvatureScale`, `slopeScaleRad`,
 * `shelterScaleDeg` — to make the answer a property of the ground instead.
 */
function normalise(values, max) {
  const out = new Float32Array(values.length);
  const d = max > 0 ? 2 * max : 0;
  for (let i = 0; i < values.length; i++) {
    out[i] = d === 0 ? (Number.isNaN(values[i]) ? NaN : 0) : values[i] / d;
  }
  return out;
}

/**
 * Everything the downscaling needs that depends only on the ground.
 *
 * Cache this beside the derivatives — same domain, same static key, no valid
 * time — and an hourly wind update is one pass of multiply and add over arrays
 * that are already in memory.
 *
 * Takes a `derive.derive` result. `shelter: true` there is optional; without it
 * the shelter term is simply absent and `terrainWeights` says so, rather than
 * silently weighting by two terms while a caller believes it got three.
 *
 * Each term is scaled by the largest magnitude in the domain unless the caller
 * names a scale for it. The scale actually used is reported next to the domain
 * extreme it replaced, because the two answer different questions and a field
 * that does not say which one it used cannot be compared with another one.
 */
function terrainWeights(derived, opts) {
  const o = opts || {};
  if (!derived || !derived.fields || !derived.elevation) {
    throw fail("bad-domain", "a derive.derive result is required");
  }
  const lengthM = o.curvatureLengthM === undefined ? DEFAULT_CURVATURE_LENGTH_M : o.curvatureLengthM;
  if (!(lengthM > 0)) throw fail("bad-length", "curvatureLengthM must be positive");
  for (const name of ["curvatureScale", "slopeScaleRad", "shelterScaleDeg"]) {
    if (o[name] !== undefined && !(o[name] > 0)) throw fail("bad-scale", name + " must be positive");
  }

  const geometry = {
    crs: derived.crs,
    width: derived.width,
    height: derived.height,
    transform: derived.transform
  };
  const grid = Object.assign({ values: derived.elevation }, geometry);
  const work = Object.assign({
    elevation: derived.elevation,
    spacingAt: o.spacingM
      ? function () { return o.spacingM; }
      : function (row) { return derive.spacingAt(grid, row); }
  }, geometry);

  const curvature = scaleCurvature(work, lengthM);
  const maxCurvature = maxAbs(curvature);
  const curvatureScale = o.curvatureScale === undefined ? maxCurvature : o.curvatureScale;
  const omegaC = normalise(curvature, curvatureScale);

  const slopeDeg = derived.fields.slopeDeg;
  const aspectDeg = derived.fields.aspectDeg;
  const maxSlopeRad = toRad(maxAbs(slopeDeg));
  const slopeScaleRad = o.slopeScaleRad === undefined ? maxSlopeRad : o.slopeScaleRad;

  let shelter = null;
  if (derived.shelter) {
    let max = 0;
    for (const sector of derived.shelter.sectors) {
      const m = maxAbs(sector.sx);
      if (m > max) max = m;
    }
    const scaleDeg = o.shelterScaleDeg === undefined ? max : o.shelterScaleDeg;
    shelter = {
      sectors: derived.shelter.sectors.map(function (sector) {
        return { centreDeg: sector.centreDeg, omega: normalise(sector.sx, scaleDeg) };
      }),
      maxSxDeg: max,
      scaleDeg: scaleDeg
    };
  }

  return Object.assign({
    schemaVersion: 1,
    bounds: derived.bounds,
    resolutionM: derived.resolutionM,
    spacingM: derived.spacingM,
    elevation: derived.elevation,
    slopeDeg: slopeDeg,
    aspectDeg: aspectDeg,
    curvature: curvature,
    omegaC: omegaC,
    maxSlopeRad: maxSlopeRad,
    maxCurvature: maxCurvature,
    slopeScaleRad: slopeScaleRad,
    curvatureScale: curvatureScale,
    curvatureLengthM: lengthM,
    shelter: shelter
  }, geometry);
}

/**
 * The two sector fields either side of a bearing, and how far between them it
 * lies — the grid-wide form of `derive.shelterAt`, which does the same thing at
 * one coordinate. Centres are ascending and need not be evenly spaced.
 */
function bracketSectors(sectors, fromAzimuthDeg) {
  const n = sectors.length;
  let a = fromAzimuthDeg % 360;
  if (a < 0) a += 360;
  let lower = n - 1;
  for (let i = 0; i < n; i++) {
    if (sectors[i].centreDeg <= a) lower = i;
  }
  const upper = (lower + 1) % n;
  let span = sectors[upper].centreDeg - sectors[lower].centreDeg;
  if (span <= 0) span += 360;
  let along = a - sectors[lower].centreDeg;
  if (along < 0) along += 360;
  return { lower: sectors[lower], upper: sectors[upper], t: span === 0 ? 0 : along / span };
}

/** East/north in m/s and the meteorological "from" bearing, from either. */
function readWind(wind) {
  if (!wind) throw fail("no-wind", "a reference wind is required");
  if (typeof wind.speedMps === "number" && typeof wind.fromDeg === "number") {
    if (!(wind.speedMps >= 0)) throw fail("bad-wind", "speedMps must not be negative");
    const towards = toRad(wind.fromDeg + 180);
    return {
      speedMps: wind.speedMps,
      fromDeg: ((wind.fromDeg % 360) + 360) % 360,
      east: wind.speedMps * Math.sin(towards),
      north: wind.speedMps * Math.cos(towards)
    };
  }
  if (typeof wind.east === "number" && typeof wind.north === "number") {
    const speed = Math.hypot(wind.east, wind.north);
    // Meteorological convention: the bearing the wind comes *from*.
    let from = toDeg(Math.atan2(-wind.east, -wind.north));
    if (from < 0) from += 360;
    return { speedMps: speed, fromDeg: from, east: wind.east, north: wind.north };
  }
  throw fail("bad-wind", "give a wind as {speedMps, fromDeg} or {east, north} in m/s");
}

/**
 * Log-law factor between two heights above ground over a surface of roughness
 * `z0`.
 *
 * Neutral stability, which is a real assumption and not a formality: on a clear
 * night in a valley the profile is nothing like this. It is here because moving
 * HRRR's 10 m wind to another height is otherwise done by whoever calls, twice,
 * differently.
 */
function heightFactor(fromHeightM, toHeightM, roughnessM) {
  const z0 = roughnessM === undefined ? DEFAULT_ROUGHNESS_M : roughnessM;
  if (!(z0 > 0)) throw fail("bad-roughness", "roughnessM must be positive");
  if (!(fromHeightM > z0 && toHeightM > z0)) {
    throw fail("bad-height", "both heights must be above the roughness length " + z0 + " m");
  }
  return Math.log(toHeightM / z0) / Math.log(fromHeightM / z0);
}

/**
 * One coarse wind, over a domain of ground, at every cell.
 *
 * `wind` is the model's answer for the domain — `{speedMps, fromDeg}` or
 * `{east, north}` in m/s — and it is treated as uniform. Over a 2 mile box that
 * is what HRRR has to say anyway: a domain that size is one grid cell of the
 * model, and pretending otherwise would be interpolating detail the model does
 * not carry. A domain big enough for the coarse field to vary across should be
 * downscaled in pieces, or this should grow a per-cell reference; it has not,
 * because nothing needs it yet.
 *
 * Each cell gets the model wind multiplied by
 *
 *     W = (1 + Ws*Os + Wc*Oc) * (1 - Wx*Ox)
 *
 * and turned by MicroMet's diverting angle, which bends the flow towards the
 * downhill direction across a slope — the term that makes a wind follow a
 * valley instead of driving through the wall of it. `{divert: false}` leaves
 * the direction alone, which is how the turning is scored on its own against
 * measured wind: it and the speed weighting are independent claims, and a
 * combined score cannot say which of them is paying.
 *
 * Cells with no derivative — the border, and anything touching a void — come
 * out `NaN`. They are not filled with the model wind: an undownscaled cell that
 * looks like a downscaled one is exactly the sort of plausible wrong answer
 * this repository refuses elsewhere.
 */
function downscale(weights, wind, opts) {
  const o = opts || {};
  if (!weights || !weights.omegaC) throw fail("bad-weights", "a terrainWeights result is required");
  const ref = readWind(wind);
  const gains = Object.assign({}, DEFAULT_WEIGHTS, o.weights);
  const useShelter = o.shelter === false ? false : Boolean(weights.shelter);
  const useDivert = o.divert !== false;
  if (o.shelter === true && !weights.shelter) {
    throw fail("no-shelter", "this domain was derived without shelter; pass {shelter: true} to derive");
  }

  const n = weights.width * weights.height;
  const east = filled(n);
  const north = filled(n);
  const speed = filled(n);
  const fromDeg = filled(n);
  const factor = filled(n);
  const divertDeg = filled(n);

  const bracket = useShelter ? bracketSectors(weights.shelter.sectors, ref.fromDeg) : null;
  const thetaRad = toRad(ref.fromDeg);
  const maxSlope = weights.slopeScaleRad === undefined ? weights.maxSlopeRad : weights.slopeScaleRad;

  let defined = 0;
  let sumFactor = 0;
  let minFactor = Infinity;
  let maxFactor = -Infinity;

  for (let i = 0; i < n; i++) {
    const slopeRad = toRad(weights.slopeDeg[i]);
    const oc = weights.omegaC[i];
    if (Number.isNaN(slopeRad) || Number.isNaN(oc)) continue;

    // Slope in the direction of the wind, scaled the same way as the curvature.
    // `aspectDeg` is the downhill bearing, so the cosine is +1 where the ground
    // rises directly into the wind and -1 on the lee face. Flat ground has no
    // aspect and no along-wind slope, which is the same answer.
    const aspectRad = toRad(weights.aspectDeg[i]);
    const alongWind = Number.isNaN(aspectRad) ? 0 : slopeRad * Math.cos(thetaRad - aspectRad);
    const os = maxSlope > 0 ? alongWind / (2 * maxSlope) : 0;

    let ox = 0;
    if (useShelter) {
      const lo = bracket.lower.omega[i];
      const hi = bracket.upper.omega[i];
      if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
      ox = lo * (1 - bracket.t) + hi * bracket.t;
    }

    const f = (1 + gains.slope * os + gains.curvature * oc) * (1 - gains.shelter * ox);
    // Bounded above zero by construction; the guard is against a caller's own
    // weights, not against the terrain.
    const bounded = f > 0 ? f : 0;

    const divert = Number.isNaN(aspectRad) || !useDivert
      ? 0
      : -0.5 * os * Math.sin(2 * (aspectRad - thetaRad));
    const from = thetaRad + divert;
    const s = bounded * ref.speedMps;

    factor[i] = bounded;
    divertDeg[i] = toDeg(divert);
    speed[i] = s;
    let fd = toDeg(from) % 360;
    if (fd < 0) fd += 360;
    fromDeg[i] = fd;
    east[i] = s * Math.sin(from + Math.PI);
    north[i] = s * Math.cos(from + Math.PI);

    defined++;
    sumFactor += bounded;
    if (bounded < minFactor) minFactor = bounded;
    if (bounded > maxFactor) maxFactor = bounded;
  }

  return {
    schemaVersion: 1,
    crs: weights.crs,
    width: weights.width,
    height: weights.height,
    transform: weights.transform,
    bounds: weights.bounds,
    resolutionM: weights.resolutionM,
    heightAglM: o.heightAglM === undefined ? (wind && wind.heightAglM) || null : o.heightAglM,
    reference: { speedMps: ref.speedMps, fromDeg: ref.fromDeg, east: ref.east, north: ref.north },
    method: {
      name: "micromet",
      weights: gains,
      shelter: useShelter,
      divert: useDivert,
      curvatureLengthM: weights.curvatureLengthM,
      slopeScaleRad: maxSlope,
      curvatureScale: weights.curvatureScale,
      shelterScaleDeg: useShelter ? weights.shelter.scaleDeg : null
    },
    east: east,
    north: north,
    speedMps: speed,
    fromDeg: fromDeg,
    factor: factor,
    divertDeg: divertDeg,
    stats: {
      definedCount: defined,
      undefinedFraction: 1 - defined / n,
      meanFactor: defined ? sumFactor / defined : NaN,
      minFactor: defined ? minFactor : NaN,
      maxFactor: defined ? maxFactor : NaN
    }
  };
}

/** `terrainWeights` then `downscale`, for a caller with one domain and one hour. */
function downscaleDerived(derived, wind, opts) {
  return downscale(terrainWeights(derived, opts), wind, opts);
}

/**
 * The downscaled wind at a coordinate, bilinear through the components.
 *
 * Through east and north rather than through speed and bearing: averaging 350°
 * and 10° gives 180°, and a wind that points backwards between two pixels is
 * the same class of bug as an averaged aspect.
 */
function windAt(field, lat, lon) {
  const geometry = {
    crs: field.crs,
    width: field.width,
    height: field.height,
    transform: field.transform
  };
  const east = cog.sampleElevation(Object.assign({ values: field.east }, geometry), lat, lon);
  const north = cog.sampleElevation(Object.assign({ values: field.north }, geometry), lat, lon);
  if (east === null || north === null || Number.isNaN(east) || Number.isNaN(north)) return null;
  const wind = readWind({ east: east, north: north });
  return { east: east, north: north, speedMps: wind.speedMps, fromDeg: wind.fromDeg };
}

/**
 * How far the model's ground is from the real ground under a domain.
 *
 * HRRR's terrain is a 3 km average: over Boulder its valley floor is hundreds
 * of metres from where the valley floor is. So the model's "10 m above ground"
 * is 10 m above a surface that does not exist, and the downscaled field
 * inherits that. This reports the difference rather than correcting it, because
 * correcting it is a choice about the vertical profile — see `heightFactor` —
 * and a silent correction is worse than a stated offset.
 */
function terrainOffset(weights, modelElevationM) {
  if (typeof modelElevationM !== "number") {
    throw fail("bad-elevation", "the model's surface elevation over the domain, in metres, is required");
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < weights.elevation.length; i++) {
    const z = weights.elevation[i];
    if (Number.isNaN(z)) continue;
    const d = z - modelElevationM;
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d;
    count++;
  }
  if (!count) return null;
  return {
    modelElevationM: modelElevationM,
    meanM: sum / count,
    minM: min,
    maxM: max,
    spreadM: max - min
  };
}

module.exports = {
  DEFAULT_CURVATURE_LENGTH_M,
  DEFAULT_WEIGHTS,
  DEFAULT_ROUGHNESS_M,
  scaleCurvature,
  normalise,
  maxAbs,
  bracketSectors,
  readWind,
  heightFactor,
  terrainWeights,
  downscale,
  downscaleDerived,
  windAt,
  terrainOffset
};
