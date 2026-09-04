// A straight line over the ground, cut out of a general field.
//
// `field.js` answers over a box: east and north at every pixel of a domain, at
// one height, valid at one instant. A great many callers want a line through
// that box instead — a sailor's course, a fire crew's spread axis, a glider's
// final glide, a shooter's bore. This module is that view, and it is a view:
// nothing here fetches, nothing here re-solves, and the field it reads is the
// same field the map draws.
//
// Three things it does, in order of how much they can go wrong unnoticed.
//
// **It walks a geodesic**, not a rhumb line and not a flat-earth offset. Over
// two miles the difference is centimetres and over sixty it is hundreds of
// metres, and every wrong answer in between is a perfectly ordinary
// coordinate. `destination` is graded against PROJ.
//
// **It resolves the wind onto the line's own direction at each station.** A
// geodesic is straight on the ground and curved on the graticule: a line fired
// due east from Boulder is pointing 90.015° after two miles and 90.5° after
// sixty. Resolving the far end onto the near end's bearing puts that whole
// difference into the cross-track component, which is the one that becomes a
// hold.
//
// **It moves the wind between heights with the log law and nothing else.**
// That is a scalar multiplying a vector, so the wind cannot turn with height
// here; real profiles veer, and this does not know it. `heightFactor` in
// `downscale.js` carries the same warning and the same neutral-stability
// assumption.
//
// The track frame is right-handed and identical to the contract's shooter
// frame: `along` is positive downtrack, `cross` is positive to the right of the
// track, `up` is positive up, and all three are the velocity OF THE AIR. A wind
// out of the south crossing an eastward line blows toward the walker's left, so
// it is negative cross. `toWindProfile` is the same numbers in the published
// units, and it is the only function in this file that knows the word shooter.

const cog = require("./cog.js");
const geo = require("./geo.js");
const downscale = require("./downscale.js");

// WGS84, which is the datum 3DEP publishes in and the one HRRR's coordinates
// are given in. Defined constants, not measurements: NIMA TR8350.2.
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

// Vincenty's direct solution converges in a handful of iterations for anything
// short of a near-antipodal line, which the inverse problem has and this one
// does not. The cap is a guard, not a working limit.
const MAX_ITERATIONS = 100;
const CONVERGENCE = 1e-14;

const FEET_PER_M = 1 / 0.3048;
const YARDS_PER_M = 1 / 0.9144;

const DEFAULT_STEP_M = 50;
// Enough to keep a station off the edge of the box it asked for, no more; the
// derivative reach is `field.js`'s margin to add, and adding it twice reads
// terrain nobody uses.
const DEFAULT_MARGIN_M = 100;

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function wrap360(deg) {
  const v = deg % 360;
  return v < 0 ? v + 360 : v;
}

/**
 * Where a bearing and a distance land, on the WGS84 ellipsoid.
 *
 * Vincenty's direct formulae (Survey Review XXIII 176, 1975), which agree with
 * PROJ to well under a micrometre over the distances this is used for. The
 * returned `forwardDeg` is the line's direction *there*, which is not the
 * bearing it set out on.
 */
function destination(from, bearingDeg, distanceM) {
  if (!from || typeof from.lat !== "number" || typeof from.lon !== "number" ||
      !isFinite(from.lat) || !isFinite(from.lon) || Math.abs(from.lat) > 90) {
    throw fail("bad-origin", "a start point is required as {lat, lon} with lat in -90…90");
  }
  if (typeof bearingDeg !== "number" || !isFinite(bearingDeg)) {
    throw fail("bad-bearing", "a bearing in degrees clockwise from true north is required");
  }
  if (typeof distanceM !== "number" || !isFinite(distanceM) || distanceM < 0) {
    throw fail("bad-distance", "a distance in metres, not negative, is required");
  }
  if (distanceM === 0) {
    return { lat: from.lat, lon: from.lon, forwardDeg: wrap360(bearingDeg), distanceM: 0 };
  }

  const alpha1 = toRad(bearingDeg);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);

  const tanU1 = (1 - WGS84_F) * Math.tan(toRad(from.lat));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;

  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = distanceM / (WGS84_B * A);
  let sinSigma = 0;
  let cosSigma = 0;
  let cos2SigmaM = 0;
  let iterations = 0;
  let previous;
  do {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma = B * sinSigma * (cos2SigmaM + (B / 4) * (
      cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
      (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)
    ));
    previous = sigma;
    sigma = distanceM / (WGS84_B * A) + deltaSigma;
  } while (Math.abs(sigma - previous) > CONVERGENCE && ++iterations < MAX_ITERATIONS);

  if (iterations >= MAX_ITERATIONS) {
    throw fail("no-convergence", "the geodesic from " + from.lat + "," + from.lon +
      " over " + distanceM + " m did not converge");
  }

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - WGS84_F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp)
  );
  const lambda = Math.atan2(
    sinSigma * sinAlpha1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1
  );
  const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
  const L = lambda - (1 - C) * WGS84_F * sinAlpha * (
    sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM))
  );

  let lon2 = from.lon + toDeg(L);
  // Keep longitude in -180…180 rather than letting a line near the
  // antimeridian come back as 180.4, which reads as a coordinate off the map.
  lon2 = ((lon2 + 540) % 360) - 180;

  return {
    lat: toDeg(lat2),
    lon: lon2,
    forwardDeg: wrap360(toDeg(Math.atan2(sinAlpha, -tmp))),
    distanceM: distanceM
  };
}

/** The distances a line of `lengthM` is sampled at, ending on the length itself. */
function stationsAlong(lengthM, stepM) {
  if (!(lengthM > 0)) throw fail("bad-length", "lengthM must be a positive distance in metres");
  if (!(stepM > 0)) throw fail("bad-step", "stepM must be a positive distance in metres");
  const out = [];
  for (let d = 0; d < lengthM; d += stepM) out.push(d);
  // A length that is not a whole number of steps still gets its far end: the
  // target is the point the caller cares most about, and dropping it because
  // it does not fall on a step is the answer being shaped by the sampling.
  if (out[out.length - 1] !== lengthM) out.push(lengthM);
  return out;
}

/**
 * The box a line needs, ready to hand to `field.get`.
 *
 * A caller who knows a bearing and a range should not have to work out a radius
 * in miles that happens to contain them; guessing low is a field that runs out
 * half way downrange, and guessing high is terrain read and derived for ground
 * nobody asked about. `field.js` adds its own margin for the derivatives on top
 * of this, so `marginM` here only has to keep the stations off the boundary.
 */
function boxFor(from, bearingDeg, lengthM, opts) {
  const o = opts || {};
  const marginM = o.marginM === undefined ? DEFAULT_MARGIN_M : o.marginM;
  const distances = stationsAlong(lengthM, o.stepM === undefined ? DEFAULT_STEP_M : o.stepM);
  let south = from.lat;
  let north = from.lat;
  let west = from.lon;
  let east = from.lon;
  for (const d of distances) {
    const at = destination(from, bearingDeg, d);
    south = Math.min(south, at.lat);
    north = Math.max(north, at.lat);
    west = Math.min(west, at.lon);
    east = Math.max(east, at.lon);
  }
  return geo.expand(
    { south: south, west: west, north: north, east: east },
    marginM / geo.METERS_PER_MILE
  );
}

/** The ground under a station, if the field was built with the terrain that carries it. */
function elevationAt(field, lat, lon) {
  if (!field.weights || !field.weights.elevation) return null;
  const grid = {
    crs: field.crs,
    width: field.width,
    height: field.height,
    transform: field.transform,
    values: field.weights.elevation
  };
  const z = cog.sampleElevation(grid, lat, lon);
  return z === null || Number.isNaN(z) ? null : z;
}

/**
 * A line of stations through a field, each carrying the wind resolved onto the
 * line.
 *
 * A station the field does not cover is refused, not clamped. The contract
 * holds the edge value flat when a *consumer* samples past the end of a
 * profile, which is the right answer for a solver stepping a hundredth of a
 * yard beyond the last node; it is the wrong answer here, where running off the
 * domain means the caller asked about ground nobody read, and a wind repeated
 * from a mile back is indistinguishable from a wind that was looked up.
 */
function transect(field, opts) {
  const o = opts || {};
  if (!field || !field.east || !field.north) throw fail("bad-field", "a downscale field is required");
  const stepM = o.stepM === undefined ? DEFAULT_STEP_M : o.stepM;
  const distances = stationsAlong(o.lengthM, stepM);
  const bearingDeg = o.bearingDeg;
  if (typeof bearingDeg !== "number" || !isFinite(bearingDeg)) {
    throw fail("bad-bearing", "a bearing in degrees clockwise from true north is required");
  }

  const stations = [];
  for (const d of distances) {
    const at = destination(o.from, bearingDeg, d);
    const wind = downscale.windAt(field, at.lat, at.lon);
    if (!wind) {
      throw fail("outside-domain",
        "the line leaves the field at " + d + " m: " + at.lat.toFixed(5) + "," +
        at.lon.toFixed(5) + " has no wind in this domain",
        { distanceM: d, lat: at.lat, lon: at.lon });
    }
    // The track's unit vectors in east-north. Right of a bearing θ is θ+90°,
    // which is (cos θ, −sin θ) — the sign that makes a wind out of the south
    // negative on an eastward line.
    const theta = toRad(at.forwardDeg);
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    stations.push({
      distanceM: d,
      lat: at.lat,
      lon: at.lon,
      forwardDeg: at.forwardDeg,
      east: wind.east,
      north: wind.north,
      speedMps: wind.speedMps,
      fromDeg: wind.fromDeg,
      alongMps: wind.east * sinT + wind.north * cosT,
      crossMps: wind.east * cosT - wind.north * sinT,
      elevationM: elevationAt(field, at.lat, at.lon)
    });
  }

  const last = stations[stations.length - 1];
  let convergenceDeg = last.forwardDeg - bearingDeg;
  if (convergenceDeg > 180) convergenceDeg -= 360;
  if (convergenceDeg < -180) convergenceDeg += 360;

  return {
    schemaVersion: 1,
    from: { lat: o.from.lat, lon: o.from.lon },
    bearingDeg: bearingDeg,
    lengthM: o.lengthM,
    stepM: stepM,
    heightAglM: field.heightAglM === undefined ? null : field.heightAglM,
    validTime: field.validTime === undefined ? null : field.validTime,
    distancesM: distances,
    stations: stations,
    convergenceDeg: convergenceDeg
  };
}

/**
 * A transect at several heights: the vertical plane through the line.
 *
 * The field is one height above ground — HRRR's 10 m, downscaled — and every
 * other height is that one times the log law. So the plane has real horizontal
 * structure and a modelled vertical one, and the two should not be read with
 * the same confidence. `factors` is reported so the caller can see exactly what
 * was applied.
 */
function plane(field, opts) {
  const o = opts || {};
  const heights = o.heightsAglM;
  if (!Array.isArray(heights) || !heights.length) {
    throw fail("bad-heights", "heightsAglM must be a non-empty array of heights above ground, in metres");
  }
  for (let i = 1; i < heights.length; i++) {
    if (!(heights[i] > heights[i - 1])) {
      throw fail("bad-heights", "heightsAglM must ascend strictly: " + heights[i - 1] + " then " + heights[i]);
    }
  }
  const line = transect(field, o);
  const fromHeight = line.heightAglM;
  if (!(fromHeight > 0)) {
    throw fail("no-height", "this field does not say which height above ground it is for");
  }
  const roughnessM = o.roughnessM === undefined ? downscale.DEFAULT_ROUGHNESS_M : o.roughnessM;

  const factors = heights.map(function (h) {
    return downscale.heightFactor(fromHeight, h, roughnessM);
  });

  const along = [];
  const cross = [];
  const up = [];
  const speed = [];
  for (const f of factors) {
    along.push(line.stations.map(function (s) { return s.alongMps * f; }));
    cross.push(line.stations.map(function (s) { return s.crossMps * f; }));
    speed.push(line.stations.map(function (s) { return s.speedMps * f; }));
    // Zero, and stated rather than omitted. The downscaling is a horizontal
    // weighting with no vertical velocity in it; a plane that quietly had no
    // `up` would read as a field where none was looked for.
    up.push(line.stations.map(function () { return 0; }));
  }

  return Object.assign({}, line, {
    heightsAglM: heights.slice(),
    referenceHeightAglM: fromHeight,
    roughnessM: roughnessM,
    factors: factors,
    alongMps: along,
    crossMps: cross,
    upMps: up,
    speedMps: speed
  });
}

/**
 * The published `windProfile`, from a plane.
 *
 * This is the one function here that is shaped by a consumer: yards, feet and
 * feet per second, and `frame: "shooter"`. It is a re-expression of the plane
 * and nothing else — no rifle, no bullet, no hold — which is what makes the
 * shooter's grid a view over the general field rather than the field's shape.
 *
 * Provenance is passed in rather than guessed, because only the caller knows
 * what it assembled. `source` has no default at all: the contract refuses an
 * unattributed field, and inventing a name here would defeat that.
 */
function toWindProfile(planeResult, opts) {
  const o = opts || {};
  if (!planeResult || !planeResult.alongMps) throw fail("bad-plane", "a slice.plane result is required");
  if (typeof o.source !== "string" || o.source.trim() === "") {
    throw fail("no-source", "source must name where this field came from; the contract refuses one without it");
  }
  return {
    schemaVersion: 1,
    frame: "shooter",
    azimuthDeg: wrap360(planeResult.bearingDeg),
    rangesYards: planeResult.distancesM.map(function (d) { return d * YARDS_PER_M; }),
    heightsAglFt: planeResult.heightsAglM.map(function (h) { return h * FEET_PER_M; }),
    uFps: planeResult.alongMps.map(function (row) {
      return row.map(function (x) { return x * FEET_PER_M; });
    }),
    vFps: planeResult.crossMps.map(function (row) {
      return row.map(function (x) { return x * FEET_PER_M; });
    }),
    wFps: planeResult.upMps.map(function (row) { return row.slice(); }),
    source: o.source,
    terrainResolutionM: o.terrainResolutionM === undefined ? null : o.terrainResolutionM,
    windSourceResolutionM: o.windSourceResolutionM === undefined ? null : o.windSourceResolutionM,
    confidence: o.confidence === undefined ? null : o.confidence
  };
}

module.exports = {
  WGS84_A,
  WGS84_F,
  DEFAULT_STEP_M,
  DEFAULT_MARGIN_M,
  FEET_PER_M,
  YARDS_PER_M,
  destination,
  stationsAlong,
  boxFor,
  elevationAt,
  transect,
  plane,
  toWindProfile
};
