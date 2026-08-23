/**
 * Geometry for turning a coordinate into a domain to fetch.
 *
 * WindSolver, not BallisticVector: nothing here knows what a rifle is. See the
 * "Two products, one engine" section of AGENTS.md.
 *
 * Everything is a plain lat/lon box in degrees, WGS84, with west/south/east/north
 * named rather than positional — a bbox as four bare numbers is the classic way
 * to get a domain silently transposed, and the ordering differs between the
 * services we call.
 */

"use strict";

const METERS_PER_MILE = 1609.344;

// Length of a degree of latitude, WGS84 mean. The real figure varies from about
// 110,574 m at the equator to 111,694 m at the pole; over a domain of a few
// miles that difference is centimetres, and the terrain grid it feeds is metres.
const METERS_PER_DEG_LAT = 111132.92;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat));
}

/**
 * Metres per degree of longitude at a given latitude. Converges on zero at the
 * poles, so it is floored: without that, a domain near the pole asks for a box
 * spanning the whole globe.
 */
function metersPerDegLon(lat) {
  const m = METERS_PER_DEG_LAT * Math.cos(toRad(clampLat(lat)));
  return Math.max(m, 1);
}

/**
 * A box of `radiusMiles` around a point. Square in metres, so it is wider in
 * degrees of longitude than of latitude everywhere but the equator.
 */
function boundingBox(lat, lon, radiusMiles) {
  if (!isFinite(lat) || !isFinite(lon)) throw new Error("lat and lon must be finite");
  if (!isFinite(radiusMiles) || radiusMiles <= 0) throw new Error("radiusMiles must be positive");

  const meters = radiusMiles * METERS_PER_MILE;
  const dLat = meters / METERS_PER_DEG_LAT;
  const dLon = meters / metersPerDegLon(lat);

  return {
    west: lon - dLon,
    south: clampLat(lat - dLat),
    east: lon + dLon,
    north: clampLat(lat + dLat)
  };
}

/** Grow a box by a margin in miles, measured at its own centre latitude. */
function expand(box, extraMiles) {
  if (!isFinite(extraMiles) || extraMiles < 0) throw new Error("extraMiles must be zero or positive");
  const midLat = (box.south + box.north) / 2;
  const meters = extraMiles * METERS_PER_MILE;
  const dLat = meters / METERS_PER_DEG_LAT;
  const dLon = meters / metersPerDegLon(midLat);
  return {
    west: box.west - dLon,
    south: clampLat(box.south - dLat),
    east: box.east + dLon,
    north: clampLat(box.north + dLat)
  };
}

/**
 * The domain to simulate for a map of `displayRadiusMiles`.
 *
 * A ridge just outside the picture still bends the wind inside it, so the solver
 * needs terrain the viewer never sees. The buffer is deliberately generous:
 * getting it wrong shows up as a wind field that is confidently wrong at the
 * upwind edge, which looks like a working feature.
 */
function simulationDomain(lat, lon, displayRadiusMiles, bufferMiles) {
  const buffer = bufferMiles === undefined ? 3 * displayRadiusMiles : bufferMiles;
  const display = boundingBox(lat, lon, displayRadiusMiles);
  return {
    display,
    simulation: expand(display, buffer),
    bufferMiles: buffer
  };
}

/** Does the box cross the antimeridian? Services take a west<east box, so this must be caught. */
function crossesAntimeridian(box) {
  return box.west > box.east;
}

function containsPoint(box, lat, lon) {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}

function intersects(a, b) {
  return !(b.west > a.east || b.east < a.west || b.south > a.north || b.north < a.south);
}

/**
 * How much of `box` the union of `tiles` covers, as 0..1.
 *
 * Sampled on a grid rather than computed as a union of rectangles: the tiles
 * overlap, and an exact union is a lot of code to answer a question whose only
 * use is "is this good enough, or fall back to a coarser product". `steps` sets
 * the resolution of the estimate, so a thin uncovered strip narrower than a
 * sample spacing can be missed — treat the number as an estimate, and do not
 * report it to a user as a coverage figure.
 */
function coverageFraction(box, tiles, steps) {
  const n = Math.max(2, Math.floor(steps || 24));
  if (!tiles || tiles.length === 0) return 0;
  let inside = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lat = box.south + ((box.north - box.south) * (i + 0.5)) / n;
    for (let j = 0; j < n; j++) {
      const lon = box.west + ((box.east - box.west) * (j + 0.5)) / n;
      total++;
      for (let t = 0; t < tiles.length; t++) {
        if (containsPoint(tiles[t], lat, lon)) {
          inside++;
          break;
        }
      }
    }
  }
  return total === 0 ? 0 : inside / total;
}

/** west,south,east,north — the order The National Map expects. */
function bboxParam(box) {
  return [box.west, box.south, box.east, box.north].map(function (v) { return v.toFixed(6); }).join(",");
}

function widthMiles(box) {
  const midLat = (box.south + box.north) / 2;
  return ((box.east - box.west) * metersPerDegLon(midLat)) / METERS_PER_MILE;
}

function heightMiles(box) {
  return ((box.north - box.south) * METERS_PER_DEG_LAT) / METERS_PER_MILE;
}

module.exports = {
  METERS_PER_MILE,
  METERS_PER_DEG_LAT,
  metersPerDegLon,
  boundingBox,
  expand,
  simulationDomain,
  crossesAntimeridian,
  containsPoint,
  intersects,
  coverageFraction,
  bboxParam,
  widthMiles,
  heightMiles
};
