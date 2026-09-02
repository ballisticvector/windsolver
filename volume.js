/**
 * The general shape of an answer: wind over a box, at a set of levels, at one
 * instant.
 *
 * **This is the native format, and the shooter's range x height grid is a view
 * over it.** A volume has a bounding box, a level set and a valid time, and no
 * bearing anywhere in it — a sailor asking about a bay and a fire crew asking
 * about a ridge both want this, and neither has an azimuth to give. Producing a
 * shooter-shaped field at ingestion would collapse two dimensions early and
 * then rebuild them for every other consumer.
 *
 * Two things happen here that cannot be deferred, because deferring them means
 * every consumer has to remember to do them:
 *
 * **The wind is rotated to earth-relative once, on the way in.** HRRR's u/v are
 * relative to the Lambert grid, not to true north, and the difference is up to
 * about 14 degrees across CONUS with no sign that anything is wrong. A volume
 * therefore holds `east`/`north`, and the grid-relative numbers do not survive
 * past this module.
 *
 * **A volume is one instant.** Messages with different valid times are refused
 * rather than merged. A field that is 10 m at 20:00Z and 80 m at 21:00Z has a
 * shear in it that the atmosphere does not.
 *
 * No network and no cache: it takes decoded GRIB records. `cache.js` is what
 * turns a box and a time into one of these.
 */

"use strict";

const grib2 = require("./grib2.js");

const VOLUME_VERSION = 1;

/** SI in, SI out. The fps conversion belongs at the contract boundary. */
const MPS_PER_FPS = 0.3048;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/**
 * A level's canonical name: `heightAboveGround:10`, `surface`.
 *
 * One string per level, sorted, is what makes a level *set* comparable — and a
 * level set is a third of the cache key, so "10 m and 80 m" and "80 m and 10 m"
 * must not be two different cache entries.
 */
function levelKey(level) {
  if (!level) throw fail("bad-level", "a level is required");
  if (typeof level === "string") return level;
  const name = level.name || String(level.type);
  return level.value ? name + ":" + level.value : name;
}

function sortLevels(keys) {
  return Array.from(new Set(keys)).sort();
}

/** Grid bounds, from the corner coordinates the projection produced. */
function boundsOf(record) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (let k = 0; k < record.latitudes.length; k++) {
    const lat = record.latitudes[k];
    const lon = record.longitudes[k];
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west: west, south: south, east: east, north: north };
}

function sameGrid(a, b) {
  return a.ni === b.ni && a.nj === b.nj &&
    a.lat1Deg === b.lat1Deg && a.lon1Deg === b.lon1Deg &&
    a.dxMeters === b.dxMeters && a.dyMeters === b.dyMeters &&
    a.loVDeg === b.loVDeg && a.laDDeg === b.laDDeg;
}

/**
 * Rotate one level's grid-relative u/v into east/north.
 *
 * Point by point, because the convergence depends on longitude: a single
 * rotation for the whole grid is right in the middle and wrong at the edges.
 */
function toEarthRelative(grid, longitudes, u, v) {
  const east = new Array(u.length);
  const north = new Array(u.length);
  for (let k = 0; k < u.length; k++) {
    if (u[k] === null || v[k] === null) {
      east[k] = null;
      north[k] = null;
      continue;
    }
    if (!grid.windComponentsRelativeToGrid) {
      east[k] = u[k];
      north[k] = v[k];
      continue;
    }
    const w = grib2.toEarthRelativeWind(grid, longitudes[k], u[k], v[k]);
    east[k] = w.east;
    north[k] = w.north;
  }
  return { east: east, north: north };
}

/**
 * Assemble decoded GRIB records into one volume.
 *
 * Refuses a mixed grid, a mixed valid time, and a level that has one wind
 * component without the other — the last one because a u with no v reads as a
 * wind blowing due east, which is a plausible answer and a wrong one.
 */
function buildVolume(records, opts) {
  const o = opts || {};
  if (!Array.isArray(records) || records.length === 0) {
    throw fail("empty-volume", "no records to build a volume from");
  }

  const first = records[0];
  const validTime = first.validTime.getTime();

  const wind = new Map();
  const scalars = new Map();

  for (const record of records) {
    if (!sameGrid(record.grid, first.grid)) {
      throw fail("mixed-grid", "records come from different grids; a volume is one grid");
    }
    if (record.validTime.getTime() !== validTime) {
      throw fail(
        "mixed-time",
        "records disagree on the valid time — " + first.validTime.toISOString() + " and " +
        record.validTime.toISOString() + "; a volume is one instant, and merging two is a shear the air does not have"
      );
    }

    const key = levelKey(record.level);
    if (record.parameter === "UGRD" || record.parameter === "VGRD") {
      const slot = wind.get(key) || {};
      slot[record.parameter] = record.values;
      wind.set(key, slot);
    } else {
      const byLevel = scalars.get(record.parameter) || new Map();
      byLevel.set(key, record.values);
      scalars.set(record.parameter, byLevel);
    }
  }

  const windByLevel = {};
  for (const [key, slot] of wind) {
    if (!slot.UGRD || !slot.VGRD) {
      throw fail(
        "half-a-wind",
        "level " + key + " has " + (slot.UGRD ? "UGRD" : "VGRD") + " and not the other component; " +
        "half a wind vector decodes to a plausible direction and a wrong one"
      );
    }
    windByLevel[key] = toEarthRelative(first.grid, first.longitudes, slot.UGRD, slot.VGRD);
  }

  const scalarsOut = {};
  for (const [name, byLevel] of scalars) {
    scalarsOut[name] = Object.fromEntries(byLevel);
  }

  return {
    schemaVersion: VOLUME_VERSION,
    source: o.source || "HRRR",
    referenceTime: first.referenceTime,
    validTime: first.validTime,
    grid: first.grid,
    latitudes: first.latitudes,
    longitudes: first.longitudes,
    bounds: boundsOf(first),
    levels: sortLevels(Object.keys(windByLevel).concat(
      ...Object.values(scalarsOut).map(function (byLevel) { return Object.keys(byLevel); })
    )),
    windLevels: sortLevels(Object.keys(windByLevel)),
    wind: windByLevel,
    scalars: scalarsOut,
    pointCount: first.latitudes.length
  };
}

/**
 * Fractional grid index of a coordinate.
 *
 * Through the projection rather than by interpolating the corner latitudes: a
 * Lambert grid is evenly spaced in projected metres and not in degrees, so
 * interpolating degrees puts a point hundreds of metres from where it belongs
 * — which at 3 km spacing is a tenth of a cell of error for free.
 */
function gridIndexOf(volume, lat, lon) {
  const grid = volume.grid;
  const k = grib2.lambertConstants(grid);
  const origin = grib2.lambertForward(grid, k, grid.lat1Deg, grid.lon1Deg);
  const here = grib2.lambertForward(grid, k, lat, lon);
  return {
    i: (here.x - origin.x) / grid.dxMeters,
    j: (here.y - origin.y) / grid.dyMeters
  };
}

function bilinear(values, ni, i0, j0, fi, fj) {
  const at = function (i, j) { return values[j * ni + i]; };
  const v00 = at(i0, j0), v10 = at(i0 + 1, j0), v01 = at(i0, j0 + 1), v11 = at(i0 + 1, j0 + 1);
  // A hole in the bitmap is a hole. Interpolating across one invents a value
  // where the model declined to produce one.
  if (v00 === null || v10 === null || v01 === null || v11 === null) return null;
  return v00 * (1 - fi) * (1 - fj) + v10 * fi * (1 - fj) + v01 * (1 - fi) * fj + v11 * fi * fj;
}

/**
 * A grid point's own coordinate round-trips through the projection to within a
 * few parts in 10^9 of a cell, which is enough to land at index 5.000000001 on
 * a grid whose last index is 5. The tolerance is in cells, not degrees, so it
 * means the same thing on a 3 km grid and a 1 km one.
 */
const INDEX_TOLERANCE_CELLS = 1e-6;

function neighbourhood(volume, lat, lon) {
  const idx = gridIndexOf(volume, lat, lon);
  const ni = volume.grid.ni;
  const nj = volume.grid.nj;
  const tol = INDEX_TOLERANCE_CELLS;
  if (idx.i < 0 && idx.i > -tol) idx.i = 0;
  if (idx.j < 0 && idx.j > -tol) idx.j = 0;
  if (idx.i > ni - 1 && idx.i < ni - 1 + tol) idx.i = ni - 1;
  if (idx.j > nj - 1 && idx.j < nj - 1 + tol) idx.j = nj - 1;
  if (!(idx.i >= 0 && idx.i <= ni - 1 && idx.j >= 0 && idx.j <= nj - 1)) {
    throw fail(
      "outside-volume",
      "the point " + lat.toFixed(4) + "," + lon.toFixed(4) + " falls outside the volume " +
      volume.bounds.south.toFixed(2) + ".." + volume.bounds.north.toFixed(2) + " by " +
      volume.bounds.west.toFixed(2) + ".." + volume.bounds.east.toFixed(2),
      { bounds: volume.bounds }
    );
  }
  const i0 = Math.min(Math.floor(idx.i), ni - 2);
  const j0 = Math.min(Math.floor(idx.j), nj - 2);
  return { i0: i0, j0: j0, fi: idx.i - i0, fj: idx.j - j0 };
}

/** Wind at a coordinate and level, in m/s, east/north. */
function sampleWind(volume, lat, lon, level) {
  const key = levelKey(level);
  const field = volume.wind[key];
  if (!field) {
    throw fail("no-such-level", "this volume has no wind at " + key +
      "; it has " + (volume.windLevels.join(", ") || "none"));
  }
  const n = neighbourhood(volume, lat, lon);
  const ni = volume.grid.ni;
  return {
    east: bilinear(field.east, ni, n.i0, n.j0, n.fi, n.fj),
    north: bilinear(field.north, ni, n.i0, n.j0, n.fi, n.fj)
  };
}

/** Any non-wind field at a coordinate and level, in its GRIB units. */
function sampleScalar(volume, parameter, lat, lon, level) {
  const byLevel = volume.scalars[parameter];
  if (!byLevel) {
    throw fail("no-such-parameter", "this volume has no " + parameter +
      "; it has " + (Object.keys(volume.scalars).join(", ") || "none"));
  }
  const key = levelKey(level);
  const values = byLevel[key];
  if (!values) {
    throw fail("no-such-level", parameter + " is not present at " + key +
      "; it is at " + Object.keys(byLevel).join(", "));
  }
  const n = neighbourhood(volume, lat, lon);
  return bilinear(values, volume.grid.ni, n.i0, n.j0, n.fi, n.fj);
}

/**
 * Vertical profile of the wind at one coordinate: every height-above-ground
 * level the volume carries, ascending.
 *
 * This is the piece a downscaler and a shooter's slice both need, and neither
 * should be re-deriving "which levels are heights" from level keys.
 */
function windProfileAt(volume, lat, lon) {
  const out = [];
  for (const key of volume.windLevels) {
    const parts = key.split(":");
    if (parts[0] !== "heightAboveGround") continue;
    const wind = sampleWind(volume, lat, lon, key);
    out.push({ heightAglM: Number(parts[1]), east: wind.east, north: wind.north });
  }
  return out.sort(function (a, b) { return a.heightAglM - b.heightAglM; });
}

function mpsToFps(mps) {
  return mps === null ? null : mps / MPS_PER_FPS;
}

module.exports = {
  VOLUME_VERSION,
  MPS_PER_FPS,
  levelKey,
  sortLevels,
  boundsOf,
  buildVolume,
  gridIndexOf,
  sampleWind,
  sampleScalar,
  windProfileAt,
  mpsToFps
};
