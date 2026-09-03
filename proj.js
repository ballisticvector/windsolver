/**
 * The two coordinate systems 3DEP actually ships in, and nothing else.
 *
 * The seamless 1/3 arc-second product is geographic — NAD83, degrees, so its
 * model coordinates *are* longitude and latitude. The 1 m product is projected
 * into whichever UTM zone the lidar project fell in, so a tile that covers a
 * shooting domain is addressed in metres and has to be un-projected before a
 * lat/long window means anything. Both are in the same 20-tile survey behind
 * `tools/cog-survey.js`.
 *
 * Anything else is refused by EPSG code rather than approximated. A DEM read
 * through the wrong projection produces terrain that is the right shape and in
 * the wrong place, and every elevation in it looks perfectly ordinary — the
 * same failure mode as an approximate GRIB decode, and just as invisible.
 *
 * Formulas are Snyder, *Map Projections — A Working Manual* (USGS Professional
 * Paper 1395), transverse Mercator for the ellipsoid, pp. 60-64. Graded against
 * `gdaltransform`; see `tests/proj.test.js`.
 */

"use strict";

const geo = require("./geo");

const ELLIPSOIDS = {
  // NAD83 is on GRS80, WGS84 on its own ellipsoid; they differ in flattening
  // in the 11th significant figure, which is far below anything terrain cares
  // about. They are kept separate because the datums are not the same thing.
  GRS80: { a: 6378137, invF: 298.257222101 },
  WGS84: { a: 6378137, invF: 298.257223563 }
};

const UTM_SCALE = 0.9996;
const UTM_FALSE_EASTING = 500000;
const UTM_FALSE_NORTHING_SOUTH = 10000000;

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * What an EPSG code means to us, or a refusal naming the code.
 *
 * The UTM ranges are the EPSG blocks: 269xx is NAD83 north, 326xx/327xx is
 * WGS84 north/south. NAD83 zones stop at 23 in the EPSG NAD83 block.
 */
function crsFromEpsg(epsg) {
  const code = Number(epsg);
  if (!isFinite(code)) throw fail("crs-unknown", "an EPSG code is required, got " + epsg);

  if (code === 4326) return { epsg: code, kind: "geographic", datum: "WGS84", ellipsoid: ELLIPSOIDS.WGS84 };
  if (code === 4269) return { epsg: code, kind: "geographic", datum: "NAD83", ellipsoid: ELLIPSOIDS.GRS80 };

  if (code >= 26901 && code <= 26923) {
    return utmCrs(code, code - 26900, true, "NAD83", ELLIPSOIDS.GRS80);
  }
  if (code >= 32601 && code <= 32660) {
    return utmCrs(code, code - 32600, true, "WGS84", ELLIPSOIDS.WGS84);
  }
  if (code >= 32701 && code <= 32760) {
    return utmCrs(code, code - 32700, false, "WGS84", ELLIPSOIDS.WGS84);
  }

  throw fail(
    "crs-unsupported",
    "EPSG:" + code + " is not one of the systems 3DEP has been observed to use " +
    "(4269/4326 geographic, or NAD83/WGS84 UTM). Reading it as if it were would " +
    "put the terrain somewhere else without saying so; add it deliberately, with a fixture"
  );
}

function utmCrs(epsg, zone, northern, datum, ellipsoid) {
  return {
    epsg: epsg,
    kind: "utm",
    zone: zone,
    northern: northern,
    datum: datum,
    ellipsoid: ellipsoid,
    centralMeridian: -183 + 6 * zone
  };
}

function eccentricity(ellipsoid) {
  const f = 1 / ellipsoid.invF;
  const e2 = 2 * f - f * f;
  return { e2: e2, ep2: e2 / (1 - e2) };
}

/** Meridional arc from the equator, Snyder (3-21). */
function meridianArc(a, e2, phi) {
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return a * (
    (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
    ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
    ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
    ((35 * e6) / 3072) * Math.sin(6 * phi)
  );
}

/** lat/long to easting/northing. Snyder (8-9), (8-10). */
function utmForward(crs, lat, lon) {
  const a = crs.ellipsoid.a;
  const { e2, ep2 } = eccentricity(crs.ellipsoid);
  const phi = toRad(lat);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = ep2 * cosPhi * cosPhi;
  // Wrap the longitude difference so a zone read from the far side of the
  // antimeridian does not come back 360 degrees of arc away.
  let dLon = lon - crs.centralMeridian;
  while (dLon > 180) dLon -= 360;
  while (dLon < -180) dLon += 360;
  const A = toRad(dLon) * cosPhi;
  const M = meridianArc(a, e2, phi);

  const x = UTM_SCALE * N * (
    A + ((1 - T + C) * Math.pow(A, 3)) / 6 +
    ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5)) / 120
  ) + UTM_FALSE_EASTING;

  let y = UTM_SCALE * (M + N * tanPhi * (
    (A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4)) / 24 +
    ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6)) / 720
  ));
  if (!crs.northern) y += UTM_FALSE_NORTHING_SOUTH;

  return { x: x, y: y };
}

/** easting/northing to lat/long. Snyder (3-24), (3-26), (8-17), (8-18). */
function utmInverse(crs, x, y) {
  const a = crs.ellipsoid.a;
  const { e2, ep2 } = eccentricity(crs.ellipsoid);
  const northing = crs.northern ? y : y - UTM_FALSE_NORTHING_SOUTH;
  const easting = x - UTM_FALSE_EASTING;

  const M = northing / UTM_SCALE;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * Math.pow(e2, 3)) / 256));
  const phi1 = mu +
    ((3 * e1) / 2 - (27 * Math.pow(e1, 3)) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * Math.pow(e1, 4)) / 32) * Math.sin(4 * mu) +
    ((151 * Math.pow(e1, 3)) / 96) * Math.sin(6 * mu) +
    ((1097 * Math.pow(e1, 4)) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const C1 = ep2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = easting / (N1 * UTM_SCALE);

  const lat = phi1 - ((N1 * tanPhi1) / R1) * (
    (D * D) / 2 -
    ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4)) / 24 +
    ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6)) / 720
  );
  const lon = (
    D - ((1 + 2 * T1 + C1) * Math.pow(D, 3)) / 6 +
    ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5)) / 120
  ) / cosPhi1;

  return { lat: toDeg(lat), lon: crs.centralMeridian + toDeg(lon) };
}

/**
 * Model coordinates (whatever the raster is in) to lat/long, and back.
 *
 * For a geographic CRS this is the identity with the axes named, which is worth
 * having as a function rather than a special case at every call site: the bug
 * it prevents is x/y reaching a projected raster in lat/long order.
 */
function toGeographic(crs, x, y) {
  if (crs.kind === "geographic") return { lat: y, lon: x };
  return utmInverse(crs, x, y);
}

function fromGeographic(crs, lat, lon) {
  if (crs.kind === "geographic") return { x: lon, y: lat };
  return utmForward(crs, lat, lon);
}

/**
 * Ground sample distance in metres for a pixel size given in the raster's own
 * units, at a stated latitude. Degrees shrink in longitude away from the
 * equator, so the two axes of a geographic DEM are not the same distance on the
 * ground — 1/3 arc-second is ~10.3 m north-south and ~7.9 m east-west at 40°.
 * The finer of the two is reported, because it is the one that decides whether
 * an overview level is coarse enough to matter.
 */
function pixelMetres(crs, scaleX, scaleY, lat) {
  if (crs.kind !== "geographic") {
    return { x: Math.abs(scaleX), y: Math.abs(scaleY) };
  }
  return {
    x: Math.abs(scaleX) * geo.metersPerDegLon(lat),
    y: Math.abs(scaleY) * geo.METERS_PER_DEG_LAT
  };
}

module.exports = {
  ELLIPSOIDS,
  UTM_SCALE,
  crsFromEpsg,
  utmForward,
  utmInverse,
  toGeographic,
  fromGeographic,
  pixelMetres
};
