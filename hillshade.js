/**
 * Shaded relief: the ground the wind is being solved over, made visible.
 *
 * Every other module here turns terrain into a number. This one turns it into
 * a picture, and it exists because the numbers have stopped being persuasive on
 * their own — `docs/downscaling.md` is eight measurements deep into a question
 * ("is the terrain correction doing anything?") whose answer is currently
 * legible only to someone who reads a long markdown file. A 1 m lidar hillshade
 * under the wind field puts the gulch next to the wind in the gulch.
 *
 * It is not decoration and it is not a basemap. OpenStreetMap's relief, where
 * it has any, is a global 30 m product; this is the **same pixels the
 * downscaling read**, at the resolution it read them, so what the viewer sees
 * is the ground the answer was computed on rather than a picture of roughly
 * that ground. When the two disagree, the disagreement is the point.
 *
 * Three things this module is careful about.
 *
 * **The shade is built from `derive.slopeAspect`, which is graded pixel by
 * pixel against `gdaldem`.** Reimplementing the gradient here would put a
 * second, ungraded copy of Horn's operator in the repository, and the failure
 * mode of a wrong hillshade is that it looks like a real hill lit from a
 * slightly different angle. `tests/hillshade.test.js` grades this against
 * `gdaldem hillshade` over the same fixture anyway, because "built on a graded
 * thing" is not the same as graded.
 *
 * **Flat ground has no aspect, and that is not a hole.** `slopeAspect` returns
 * `NaN` for the aspect of a pixel with no slope — deliberately, because 0 is a
 * real bearing and a flat pixel reported as facing north becomes a wrong
 * sheltering answer. Carried into a hillshade unthought-about, that `NaN`
 * turns every flat pixel transparent, and a lake or a plain renders as a hole
 * in the terrain: exactly the "no data here" signal the map page reserves for
 * ground that was never read. Flat pixels are shaded at `sin(altitude)`, which
 * is what a level surface returns.
 *
 * **A hole is still a hole.** `NaN` elevation gives `NaN` shade, which the PNG
 * writer turns into a transparent pixel and the page lets the basemap through.
 * Shading a void as black would draw a lake; shading it as white would draw
 * a snowfield.
 *
 * The illumination convention is GDAL's, which is USGS's: light from the
 * north-west (azimuth 315°) at 45° above the horizon. It is physically absurd
 * in the northern hemisphere — the sun is never in the north — and it is used
 * everywhere because relief lit from the top-left reads as raised, while the
 * same relief lit from the bottom-right reads as sunken to most people. That
 * illusion is worth more than the physics on a map whose job is to show a
 * viewer where the gulches are.
 */

"use strict";

const cog = require("./cog.js");
const derive = require("./derive.js");
const geo = require("./geo.js");

const DEFAULT_AZIMUTH_DEG = 315;
const DEFAULT_ALTITUDE_DEG = 45;

/**
 * A ceiling on the raster a request can ask for. 2048 x 2048 is 4 MP: about
 * 1.5 m per pixel over a two-mile box, which is finer than anything the map
 * shows, and a few hundred kilobytes of PNG. The ceiling is here because the
 * cost of a resample is pixels, not ground, so an unbounded `width=` is a way
 * to spend the service's CPU on an image no screen can show.
 */
const MAX_RASTER_SIDE = 2048;

/** GDAL keeps 0 for nodata and maps a lit pixel onto 1..255. */
const MIN_BYTE = 1;
const BYTE_RANGE = 254;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const RAD = Math.PI / 180;

/**
 * Lambertian shade in 0..1 for one pixel, or `NaN` where the ground is not
 * known.
 *
 * `cos(i)` between the surface normal and the light. Negative means the pixel
 * faces away from the light and is in shadow *by its own slope* — this is not
 * cast-shadow, nothing here traces a ray past its own pixel, so a peak does not
 * darken the valley behind it. `derive.shelter` is the module that casts rays,
 * and it is about wind rather than light.
 */
function shadeOf(slopeDeg, aspectDeg, sinAlt, cosAlt, azRad) {
  if (!Number.isFinite(slopeDeg)) return NaN;
  const slope = slopeDeg * RAD;
  // Flat: no aspect exists, and none is needed. cos(0) = 1, sin(0) = 0.
  if (!Number.isFinite(aspectDeg)) return sinAlt;
  const cang = sinAlt * Math.cos(slope) +
    cosAlt * Math.sin(slope) * Math.cos(azRad - aspectDeg * RAD);
  return cang < 0 ? 0 : cang;
}

/**
 * A shade field over a terrain grid.
 *
 * Takes either a grid (`{crs, width, height, transform, values}`) or the
 * `derive.derive` output for one, because the service already has the second
 * cached and recomputing Horn's operator over a 3,000 x 3,000 window to draw a
 * picture would be the expensive half of a solve done twice.
 */
function shade(source, opts) {
  const o = opts || {};
  const azimuthDeg = o.azimuthDeg === undefined ? DEFAULT_AZIMUTH_DEG : o.azimuthDeg;
  const altitudeDeg = o.altitudeDeg === undefined ? DEFAULT_ALTITUDE_DEG : o.altitudeDeg;
  if (!Number.isFinite(azimuthDeg)) throw fail("bad-azimuth", "azimuthDeg has to be a number");
  if (!Number.isFinite(altitudeDeg) || altitudeDeg <= 0 || altitudeDeg > 90) {
    throw fail("bad-altitude", "altitudeDeg has to be above 0 and at most 90");
  }

  const sa = source.fields && source.fields.slopeDeg
    ? { slopeDeg: source.fields.slopeDeg, aspectDeg: source.fields.aspectDeg }
    : derive.slopeAspect(source, o);

  const sinAlt = Math.sin(altitudeDeg * RAD);
  const cosAlt = Math.cos(altitudeDeg * RAD);
  const azRad = azimuthDeg * RAD;

  const n = source.width * source.height;
  const values = new Float32Array(n);
  let lit = 0;
  for (let i = 0; i < n; i++) {
    const v = shadeOf(sa.slopeDeg[i], sa.aspectDeg[i], sinAlt, cosAlt, azRad);
    values[i] = v;
    if (!Number.isNaN(v)) lit++;
  }

  return {
    crs: source.crs,
    width: source.width,
    height: source.height,
    transform: source.transform,
    values: values,
    litCount: lit,
    azimuthDeg: azimuthDeg,
    altitudeDeg: altitudeDeg
  };
}

/**
 * The same field as bytes, GDAL's way: `1 + 254 * shade`, rounded, and 0 kept
 * for a hole.
 *
 * `255 * shade` would be the obvious mapping and is wrong in a way that only
 * shows at the ends: it puts a fully shadowed pixel at 0, which is the value
 * this image reserves for ground nobody has read. Giving up one byte of range
 * so that "black" and "absent" stay different things is the same rule as
 * `NaN` elevation everywhere else here.
 */
function toBytes(field) {
  const out = new Uint8Array(field.width * field.height);
  for (let i = 0; i < out.length; i++) {
    const v = field.values[i];
    out[i] = Number.isNaN(v) ? 0 : Math.round(MIN_BYTE + BYTE_RANGE * v);
  }
  return out;
}

/**
 * The shade resampled onto a north-up lat/long lattice covering `box`.
 *
 * **This is not a formality, and skipping it puts the picture on the wrong
 * ground.** 3DEP's 1 m lidar is in UTM, whose grid north is not true north
 * anywhere but on the central meridian: over Boulder, 0.3° east of UTM 13's
 * meridian at 40° north, the convergence is about 0.17°. A web map places an
 * image by its corners and stretches it linearly between them, so handing it
 * the UTM raster puts every ridge in the picture about ten metres from the
 * ridge in the answer across a two-mile box — far enough to see against a
 * road, and small enough to look like nothing. `tests/hillshade.test.js`
 * measures that displacement rather than taking this paragraph's word for it.
 * `derive.gridConvergenceDeg` is the same fact measured for the wind.
 *
 * Sampling is bilinear through `cog.sampleElevation`, which refuses to
 * interpolate across a hole, so a void does not smear a grey halo over the
 * ground beside it. Outside the terrain that was read the answer is `null`,
 * which becomes `NaN` here and a transparent pixel in the PNG: the map's one
 * consistent signal for "nobody has read this ground".
 *
 * The remaining projection error is the web map's own: Mercator's y is not
 * linear in latitude, and a linear stretch across a two-mile box is out by
 * about a quarter of a metre in the middle. That is a fraction of a pixel at
 * 1 m and it is not worth a per-row correction; it is worth writing down,
 * because it grows with the box and a continental one would be visibly wrong.
 */
function toGeographic(field, box, opts) {
  const o = opts || {};
  const width = Math.round(o.width);
  if (!(width >= 2 && width <= MAX_RASTER_SIDE)) {
    throw fail("bad-width", "width has to be between 2 and " + MAX_RASTER_SIDE + " pixels");
  }
  const midLat = (box.south + box.north) / 2;
  const groundWidthM = (box.east - box.west) * geo.metersPerDegLon(midLat);
  const groundHeightM = (box.north - box.south) * geo.METERS_PER_DEG_LAT;
  // Square ground pixels unless the caller insists otherwise, so the relief is
  // not stretched in one axis — a squashed hillshade reads as a gentler hill.
  const height = Math.round(o.height || (width * groundHeightM / groundWidthM));
  if (!(height >= 2 && height <= MAX_RASTER_SIDE)) {
    throw fail("bad-height", "height has to be between 2 and " + MAX_RASTER_SIDE + " pixels");
  }

  const values = new Float32Array(width * height);
  const dLat = (box.north - box.south) / height;
  const dLon = (box.east - box.west) / width;
  const source = {
    crs: field.crs,
    width: field.width,
    height: field.height,
    transform: field.transform,
    values: field.values
  };

  let covered = 0;
  for (let y = 0; y < height; y++) {
    // Pixel centres, north row first, which is how a PNG is written and how a
    // north-up raster is read.
    const lat = box.north - (y + 0.5) * dLat;
    for (let x = 0; x < width; x++) {
      const lon = box.west + (x + 0.5) * dLon;
      const v = cog.sampleElevation(source, lat, lon);
      values[y * width + x] = v === null ? NaN : v;
      if (v !== null) covered++;
    }
  }

  return {
    width: width,
    height: height,
    box: { south: box.south, west: box.west, north: box.north, east: box.east },
    values: values,
    coveredCount: covered,
    coveredFraction: covered / (width * height),
    resolutionM: groundWidthM / width
  };
}

module.exports = {
  DEFAULT_AZIMUTH_DEG,
  DEFAULT_ALTITUDE_DEG,
  MAX_RASTER_SIDE,
  shadeOf,
  shade,
  toBytes,
  toGeographic
};
