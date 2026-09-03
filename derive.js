/**
 * What the ground does to the wind, computed once per domain.
 *
 * Terrain does not change between forecast hours, so everything here is static:
 * slope, aspect, curvature, roughness and directional sheltering are functions
 * of the elevation grid alone. That is the whole reason they are worth
 * computing separately — the expensive geometry moves off the request path and
 * is cached for as long as the mountain stands, and an hourly wind update is
 * then arithmetic over grids that already exist.
 *
 * Nothing here touches the network, and nothing here knows about a rifle. A
 * fire crew, a sailplane pilot and a shooter all want the same slope.
 *
 * **Metres, not degrees.** A geographic DEM's pixel is 1/3 arc-second in both
 * axes and those are not the same distance on the ground: about 10.3 m
 * north-south and 7.9 m east-west at 40°, and the ratio moves with latitude
 * across a single domain. Every derivative here divides by a metre spacing
 * computed per row for that reason. Treating a degree as a metre is not a
 * rounding error, it is a slope wrong by five orders of magnitude, and GDAL's
 * own `gdaldem -s` cannot express the anisotropy because it takes one scale for
 * both axes — see `tests/derive.test.js`, which measures the disagreement
 * rather than papering over it.
 *
 * Sources:
 *   Horn, B.K.P. (1981) "Hill shading and the reflectance map", slope/aspect.
 *   Zevenbergen & Thorne (1987) "Quantitative analysis of land surface
 *     topography", curvature.
 *   Riley et al. (1999), terrain ruggedness index; Wilson et al. (2007), TPI.
 *   Winstral & Marks (2002) "Simulating wind fields and snow redistribution",
 *     the Sx sheltering parameter.
 */

"use strict";

const cog = require("./cog");
const geo = require("./geo");
const proj = require("./proj");

/** Sectors around the compass for the sheltering parameter. 16 is Winstral's. */
const DEFAULT_SECTORS = 16;

/**
 * How far upwind sheltering looks, in metres.
 *
 * Winstral uses 300-1000 m for snow redistribution over mountain terrain. The
 * cost is linear in this and in the sector count — cells x sectors x steps — so
 * it is a parameter with a modest default rather than the largest defensible
 * number.
 */
const DEFAULT_MAX_SHELTER_DISTANCE_M = 300;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function checkGrid(grid) {
  if (!grid || !grid.values || !grid.width || !grid.height || !grid.transform || !grid.crs) {
    throw fail("bad-grid", "an elevation grid from cog.assembleWindow is required");
  }
  if (grid.width < 3 || grid.height < 3) {
    throw fail(
      "grid-too-small",
      "a 3 x 3 neighbourhood does not fit in a " + grid.width + " x " + grid.height + " grid; " +
      "read the window with a pixel or two of padding rather than deriving from what is there"
    );
  }
}

/** Latitude of the centre of a row, in the grid's own geometry. */
function rowLatitude(grid, row) {
  const t = grid.transform;
  const y = t.originY + (row + 0.5) * t.scaleY;
  const x = t.originX + (grid.width / 2) * t.scaleX;
  return proj.toGeographic(grid.crs, x, y).lat;
}

/**
 * Ground spacing of a row's pixels, in metres.
 *
 * Constant down a projected grid and latitude-dependent down a geographic one.
 * UTM's own scale factor (0.9996 on the central meridian, 1.0010 at the edge of
 * a zone) is not corrected for: it is a tenth of a percent, four orders of
 * magnitude below the difference this function exists to handle.
 */
function spacingAt(grid, row) {
  const t = grid.transform;
  if (grid.crs.kind !== "geographic") {
    return { x: Math.abs(t.scaleX), y: Math.abs(t.scaleY) };
  }
  const lat = rowLatitude(grid, row);
  return {
    x: Math.abs(t.scaleX) * geo.metersPerDegLon(lat),
    y: Math.abs(t.scaleY) * geo.METERS_PER_DEG_LAT
  };
}

/**
 * How the spacing is measured for one call.
 *
 * `opts.spacingM` overrides it with a constant, which is what a caller with a
 * grid of its own making wants, and what `tests/derive.test.js` uses to
 * reproduce GDAL's one-scale-for-both-axes model exactly and so pin the
 * disagreement on the spacing rather than on the arithmetic.
 */
function spacingFn(grid, opts) {
  const fixed = opts && opts.spacingM;
  if (fixed) {
    if (!(fixed.x > 0 && fixed.y > 0)) throw fail("bad-spacing", "spacingM needs positive x and y metres");
    return function () { return fixed; };
  }
  return function (row) { return spacingAt(grid, row); };
}

/** The 3 x 3 neighbourhood, north-up, or null if any of it is missing. */
function neighbourhood(grid, x, y, out) {
  const w = grid.width;
  const v = grid.values;
  let i = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const row = (y + dy) * w;
    for (let dx = -1; dx <= 1; dx++) {
      const z = v[row + x + dx];
      if (Number.isNaN(z)) return null;
      out[i++] = z;
    }
  }
  return out;
}

function filledField(grid) {
  return new Float32Array(grid.width * grid.height).fill(NaN);
}

/**
 * Slope and aspect by Horn's 3 x 3 weighted difference — the one GDAL, ArcGIS
 * and GRASS all use, so the answer is comparable with theirs.
 *
 * `aspectDeg` is the compass bearing the slope faces, which is the *downhill*
 * direction: 90 means the ground falls away to the east. Flat ground has no
 * aspect and gets `NaN` rather than 0, because 0 is a real bearing and a flat
 * pixel reported as "faces north" becomes a sheltering answer that is wrong in
 * a way nothing downstream can detect.
 *
 * Edge pixels are `NaN`: a 3 x 3 window does not fit, and the alternative —
 * reflecting or repeating the border — invents a gradient at exactly the place
 * a domain is stitched to its neighbour.
 */
function slopeAspect(grid, opts) {
  checkGrid(grid);
  const spacing = spacingFn(grid, opts);
  const w = grid.width;
  const h = grid.height;
  const slopeDeg = filledField(grid);
  const aspectDeg = filledField(grid);
  const dzdx = filledField(grid);
  const dzdy = filledField(grid);
  const z = new Float64Array(9);
  let flat = 0;
  let defined = 0;

  for (let y = 1; y < h - 1; y++) {
    const step = spacing(y);
    for (let x = 1; x < w - 1; x++) {
      if (!neighbourhood(grid, x, y, z)) continue;
      // z is [NW N NE / W C E / SW S SE]; rows run north to south.
      const gx = ((z[2] + 2 * z[5] + z[8]) - (z[0] + 2 * z[3] + z[6])) / (8 * step.x);
      const gy = ((z[0] + 2 * z[1] + z[2]) - (z[6] + 2 * z[7] + z[8])) / (8 * step.y);
      const at = y * w + x;
      dzdx[at] = gx;
      dzdy[at] = gy;
      slopeDeg[at] = toDeg(Math.atan(Math.hypot(gx, gy)));
      defined++;
      if (gx === 0 && gy === 0) {
        flat++;
        continue;
      }
      // Downhill bearing: the gradient points uphill, so negate both and read
      // the compass angle from north, clockwise.
      let a = toDeg(Math.atan2(-gx, -gy));
      if (a < 0) a += 360;
      aspectDeg[at] = a;
    }
  }

  return { slopeDeg: slopeDeg, aspectDeg: aspectDeg, dzdx: dzdx, dzdy: dzdy, flatCount: flat, definedCount: defined };
}

/**
 * Curvature, per Zevenbergen & Thorne, in units of 1/m.
 *
 * **Positive is convex here — all three of them.** A dome of radius R gives
 * +1/R, a bowl −1/R. That is deliberately not ESRI's sign convention for plan
 * curvature, which is inverted relative to its own profile curvature; carrying
 * two opposite meanings of "positive" through a downscaling model is a sign
 * error waiting for a quiet afternoon. `tests/derive.test.js` grades all three
 * against an analytic paraboloid, since no GDAL tool computes curvature.
 *
 * - `profile` is curvature along the slope: convex where a hillside rolls over
 *   into a steeper fall, which is where flow separates and accelerates.
 * - `plan` is curvature across the slope: convex on a spur, concave in a gully,
 *   which is what converges or diverges the flow.
 * - `total` is −(z_xx + z_yy), the shape independent of the slope direction,
 *   and is the one that is defined on flat ground where the other two are not.
 */
function curvature(grid, opts) {
  checkGrid(grid);
  const spacing = spacingFn(grid, opts);
  const w = grid.width;
  const h = grid.height;
  const profile = filledField(grid);
  const plan = filledField(grid);
  const total = filledField(grid);
  const z = new Float64Array(9);

  for (let y = 1; y < h - 1; y++) {
    const step = spacing(y);
    const dx = step.x;
    const dy = step.y;
    for (let x = 1; x < w - 1; x++) {
      if (!neighbourhood(grid, x, y, z)) continue;
      const at = y * w + x;
      // Zevenbergen & Thorne's D, E, F, G, H over the 3 x 3, with the two axes
      // kept separate because a geographic pixel is not square on the ground.
      const D = ((z[3] + z[5]) / 2 - z[4]) / (dx * dx);
      const E = ((z[1] + z[7]) / 2 - z[4]) / (dy * dy);
      const F = (-z[0] + z[2] + z[6] - z[8]) / (4 * dx * dy);
      const G = (z[5] - z[3]) / (2 * dx);
      const H = (z[1] - z[7]) / (2 * dy);

      total[at] = -2 * (D + E);
      const g2h2 = G * G + H * H;
      if (g2h2 === 0) continue;   // no slope, so no along- or across-slope direction
      profile[at] = (-2 * (D * G * G + E * H * H + F * G * H)) / g2h2;
      plan[at] = (-2 * (D * H * H + E * G * G - F * G * H)) / g2h2;
    }
  }

  return { profile: profile, plan: plan, total: total };
}

/**
 * Roughness, three ways, all in metres.
 *
 * - `relief` is max − min over the 3 x 3, GDAL's `roughness`.
 * - `tri` is Riley's terrain ruggedness index, the root of the summed squared
 *   differences from the centre — GDAL's default `TRI`.
 * - `tpi` is the topographic position index, centre minus the mean of the eight
 *   neighbours: positive on a crest, negative in a hollow.
 *
 * All three are vertical distances and none of them is divided by the pixel
 * spacing, so a value is only comparable with another at the same resolution.
 * That is GDAL's definition and there is no point in having a second one.
 */
function roughness(grid) {
  checkGrid(grid);
  const w = grid.width;
  const h = grid.height;
  const relief = filledField(grid);
  const tri = filledField(grid);
  const tpi = filledField(grid);
  const z = new Float64Array(9);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!neighbourhood(grid, x, y, z)) continue;
      const at = y * w + x;
      const centre = z[4];
      let min = Infinity;
      let max = -Infinity;
      let squares = 0;
      let sum = 0;
      for (let i = 0; i < 9; i++) {
        if (z[i] < min) min = z[i];
        if (z[i] > max) max = z[i];
        if (i === 4) continue;
        const d = z[i] - centre;
        squares += d * d;
        sum += z[i];
      }
      relief[at] = max - min;
      tri[at] = Math.sqrt(squares);
      tpi[at] = centre - sum / 8;
    }
  }

  return { relief: relief, tri: tri, tpi: tpi };
}

/** Bilinear elevation at a fractional pixel position, or NaN. */
function bilinearAt(grid, px, py) {
  if (!(px >= 0 && py >= 0 && px <= grid.width - 1 && py <= grid.height - 1)) return NaN;
  const x0 = Math.min(grid.width - 2, Math.floor(px));
  const y0 = Math.min(grid.height - 2, Math.floor(py));
  const fx = px - x0;
  const fy = py - y0;
  const w = grid.width;
  const v00 = grid.values[y0 * w + x0];
  const v10 = grid.values[y0 * w + x0 + 1];
  const v01 = grid.values[(y0 + 1) * w + x0];
  const v11 = grid.values[(y0 + 1) * w + x0 + 1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/**
 * How far the grid's "up the page" is from true north, in degrees, at its
 * centre.
 *
 * A UTM grid's columns follow the central meridian, not the local one, so north
 * on the page is up to 3° off true north within a zone. Sectors are 22.5° wide
 * so this is a fraction of one, but it is a systematic rotation of every
 * sheltering direction in the domain rather than noise, and it costs one
 * projection to remove.
 */
function gridConvergenceDeg(grid) {
  if (grid.crs.kind === "geographic") return 0;
  const t = grid.transform;
  const cx = t.originX + (grid.width / 2) * t.scaleX;
  const cy = t.originY + (grid.height / 2) * t.scaleY;
  const centre = proj.toGeographic(grid.crs, cx, cy);
  const north = proj.fromGeographic(grid.crs, centre.lat + 100 / geo.METERS_PER_DEG_LAT, centre.lon);
  // Bearing of true north as drawn on the grid, measured from grid north.
  return toDeg(Math.atan2(north.x - cx, north.y - cy));
}

function sectorCentres(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push((360 * i) / count);
  return out;
}

/**
 * Winstral's Sx: how sheltered each pixel is, looking upwind, per sector.
 *
 * For a direction, Sx is the largest angle above the horizontal to any point
 * within `maxDistanceM` along that bearing. **Positive means sheltered** — there
 * is ground upwind standing above you — and negative means exposed, with the
 * terrain falling away. It is in degrees, and it is the parameter a downscaling
 * model multiplies the model wind by, which is why it is worth precomputing:
 * it depends only on the ground, so an hourly wind update becomes a lookup by
 * sector plus arithmetic.
 *
 * Sampling is along the ray at `stepM`, bilinear, in the grid's own geometry —
 * `azimuthDeg` is a true-north compass bearing and is rotated onto the grid by
 * the convergence above. A pixel whose ray leaves the grid before it has seen
 * anything is `NaN`, not 0: "nothing upwind" and "we did not look" are
 * different answers, and only one of them means exposed. Read the window with
 * `maxDistanceM` of padding if the edges matter.
 */
function shelter(grid, opts) {
  checkGrid(grid);
  const o = opts || {};
  const sectors = o.sectors === undefined ? DEFAULT_SECTORS : o.sectors;
  const maxDistanceM = o.maxDistanceM === undefined ? DEFAULT_MAX_SHELTER_DISTANCE_M : o.maxDistanceM;
  // Ascending bearing, whatever order they were given in: `shelterAt` brackets
  // a wind direction between two neighbouring centres by walking this list.
  const centres = (Array.isArray(sectors) ? sectors.slice() : sectorCentres(sectors))
    .sort(function (a, b) { return a - b; });
  if (!centres.length) throw fail("bad-sectors", "at least one sector is required");
  if (!(maxDistanceM > 0)) throw fail("bad-distance", "maxDistanceM must be positive");

  const spacing = spacingFn(grid, o);
  const w = grid.width;
  const h = grid.height;
  const mid = spacing(Math.floor(h / 2));
  const stepM = o.stepM === undefined ? Math.min(mid.x, mid.y) : o.stepM;
  if (!(stepM > 0)) throw fail("bad-step", "stepM must be positive");
  const steps = Math.max(1, Math.floor(maxDistanceM / stepM));
  const convergence = gridConvergenceDeg(grid);

  const fields = centres.map(function (centre) {
    return { centreDeg: centre, sx: filledField(grid) };
  });

  for (let s = 0; s < centres.length; s++) {
    // On the grid, not on the compass: true north is `convergence` degrees off
    // grid north, so a bearing is measured from there.
    const a = toRad(centres[s] - convergence);
    const east = Math.sin(a);
    const north = Math.cos(a);
    const sx = fields[s].sx;

    for (let y = 1; y < h - 1; y++) {
      const step = spacing(y);
      const pxPerM = east / step.x;
      const pyPerM = -north / step.y;   // rows increase southward
      for (let x = 1; x < w - 1; x++) {
        const z0 = grid.values[y * w + x];
        if (Number.isNaN(z0)) continue;
        let best = -Infinity;
        for (let i = 1; i <= steps; i++) {
          const d = i * stepM;
          const z = bilinearAt(grid, x + pxPerM * d, y + pyPerM * d);
          if (Number.isNaN(z)) break;   // off the grid, or into a void
          const angle = Math.atan2(z - z0, d);
          if (angle > best) best = angle;
        }
        if (best !== -Infinity) sx[y * w + x] = toDeg(best);
      }
    }
  }

  return {
    sectors: fields,
    maxDistanceM: maxDistanceM,
    stepM: stepM,
    steps: steps,
    convergenceDeg: convergence
  };
}

/**
 * Everything above, over one elevation grid, with the geometry carried along so
 * a field can be sampled by coordinate later.
 *
 * `shelter` is optional and off by default: it is the only part whose cost is
 * more than a pass over the grid — cells x sectors x steps — and a caller that
 * only wants slope should not pay for sixteen ray casts per pixel.
 */
function derive(grid, opts) {
  const o = opts || {};
  checkGrid(grid);
  const sa = slopeAspect(grid, o);
  const cv = curvature(grid, o);
  const rg = roughness(grid);
  const mid = spacingFn(grid, o)(Math.floor(grid.height / 2));

  const fields = {
    slopeDeg: sa.slopeDeg,
    aspectDeg: sa.aspectDeg,
    dzdx: sa.dzdx,
    dzdy: sa.dzdy,
    profileCurvature: cv.profile,
    planCurvature: cv.plan,
    totalCurvature: cv.total,
    relief: rg.relief,
    tri: rg.tri,
    tpi: rg.tpi
  };

  const out = {
    crs: grid.crs,
    width: grid.width,
    height: grid.height,
    transform: grid.transform,
    bounds: grid.bounds || cog.gridBounds(grid),
    resolutionM: grid.resolutionM,
    spacingM: mid,
    elevation: grid.values,
    fields: fields,
    flatCount: sa.flatCount,
    definedCount: sa.definedCount,
    undefinedFraction: 1 - sa.definedCount / (grid.width * grid.height),
    shelter: null
  };

  if (o.shelter) out.shelter = shelter(grid, o.shelter === true ? o : o.shelter);
  return out;
}

/** `derive` over every grid a `readTerrain` returned, least void first. */
function deriveAll(grids, opts) {
  return grids.map(function (grid) { return derive(grid, opts); });
}

/**
 * Sample a derived field at a coordinate, bilinear, or null.
 *
 * Reuses the elevation sampler rather than writing a second one: the geometry
 * is identical, and two samplers is two chances to disagree about where a pixel
 * centre is. `aspectDeg` is refused here — see `aspectAt`.
 */
function fieldAt(derived, name, lat, lon) {
  if (name === "aspectDeg") {
    throw fail(
      "circular-field",
      "aspect is a bearing: interpolating 350 and 10 gives 180, which points the wrong way. Use aspectAt"
    );
  }
  const values = derived.fields[name];
  if (!values) throw fail("no-such-field", "there is no derived field called " + name);
  return cog.sampleElevation({
    crs: derived.crs,
    width: derived.width,
    height: derived.height,
    transform: derived.transform,
    values: values
  }, lat, lon);
}

/**
 * Downhill bearing at a coordinate, interpolated through the gradient rather
 * than through the angle, so a hillside facing due north does not average to
 * due south. Returns null off the grid, in a void, or on flat ground.
 */
function aspectAt(derived, lat, lon) {
  const gx = fieldAt(derived, "dzdx", lat, lon);
  const gy = fieldAt(derived, "dzdy", lat, lon);
  if (gx === null || gy === null) return null;
  if (gx === 0 && gy === 0) return null;
  let a = toDeg(Math.atan2(-gx, -gy));
  if (a < 0) a += 360;
  return a;
}

/**
 * Sheltering at a coordinate for a wind blowing *from* `fromAzimuthDeg`.
 *
 * Blended between the two nearest sector centres. Snapping to the nearest
 * sector instead would put a 22.5°-wide step in the answer, and a wind backing
 * slowly through the morning would cross it as a jump in the solution rather
 * than as weather.
 */
function shelterAt(derived, lat, lon, fromAzimuthDeg) {
  if (!derived.shelter) throw fail("no-shelter", "this domain was derived without shelter; pass {shelter: true}");
  const fields = derived.shelter.sectors;
  const n = fields.length;
  let a = fromAzimuthDeg % 360;
  if (a < 0) a += 360;

  // Bracket the bearing between two sector centres by searching rather than by
  // dividing, because the centres need not be the evenly spaced default.
  let lower = n - 1;
  for (let i = 0; i < n; i++) {
    if (fields[i].centreDeg <= a) lower = i;
  }
  const upper = (lower + 1) % n;
  let span = fields[upper].centreDeg - fields[lower].centreDeg;
  if (span <= 0) span += 360;
  let along = a - fields[lower].centreDeg;
  if (along < 0) along += 360;
  const t = span === 0 ? 0 : along / span;

  const geometry = {
    crs: derived.crs,
    width: derived.width,
    height: derived.height,
    transform: derived.transform
  };
  const lo = cog.sampleElevation(Object.assign({ values: fields[lower].sx }, geometry), lat, lon);
  const hi = cog.sampleElevation(Object.assign({ values: fields[upper].sx }, geometry), lat, lon);
  if (lo === null || hi === null) return null;
  return lo * (1 - t) + hi * t;
}

/**
 * The first derived domain that has a value at this coordinate, like
 * `terrain.elevationAt` — a point in the overlap between two tiles is answered
 * by whichever of them holds ground there.
 */
function valueAt(deriveds, name, lat, lon) {
  for (const derived of deriveds) {
    const v = name === "aspectDeg" ? aspectAt(derived, lat, lon) : fieldAt(derived, name, lat, lon);
    if (v !== null && !Number.isNaN(v)) return v;
  }
  return null;
}

module.exports = {
  DEFAULT_SECTORS,
  DEFAULT_MAX_SHELTER_DISTANCE_M,
  spacingAt,
  gridConvergenceDeg,
  slopeAspect,
  curvature,
  roughness,
  shelter,
  derive,
  deriveAll,
  fieldAt,
  aspectAt,
  shelterAt,
  valueAt
};
