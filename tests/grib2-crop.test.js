/**
 * Keeping a station's corner of a CONUS message, and throwing the continent
 * away.
 *
 * An archive message is the whole grid: 1,799 x 1,059 is 1,905,141 points, and
 * a half-mile domain around a RAWS mast wants about a dozen of them. Holding
 * the rest — three float arrays of 1.9 million each, per parameter, per hour —
 * is what makes scoring a second date impossible rather than slow.
 *
 * The crop must therefore be a *renaming of the same grid*, not a resample:
 * every value it keeps has to be the value that was at that coordinate before,
 * and the coordinates it reports have to be the ones the full grid reported.
 * That is what is graded here, against the uncropped decode of the same real
 * message rather than against arithmetic of its own.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const grib2 = require("../grib2");

const BUFFER = fs.readFileSync(path.join(
  __dirname, "fixtures", "hrrr-20250901t12z-f01-land.grib2"));

// Boulder, and a box about 3 km on a side around it: smaller than one HRRR
// cell, which is the interesting case because a crop that rounded the wrong
// way would return nothing.
const BOX = { west: -105.30, south: 40.005, east: -105.26, north: 40.035 };

const full = grib2.decode(BUFFER)[0];

// The full grid's points, looked up by coordinate rather than by index, so a
// cropped point is matched to the source point it claims to be without either
// side doing the index arithmetic the crop is being graded on. Six decimals is
// about 10 cm; HRRR's points are 3 km apart, so a collision is not possible.
const BY_COORD = new Map();
for (let n = 0; n < full.latitudes.length; n++) {
  BY_COORD.set(full.latitudes[n].toFixed(6) + " " + full.longitudes[n].toFixed(6), n);
}

/** Where a coordinate sits in the full grid's flat arrays, or -1. */
function indexOf(lat, lon) {
  const at = BY_COORD.get(lat.toFixed(6) + " " + lon.toFixed(6));
  return at === undefined ? -1 : at;
}

describe("decoding without the coordinates", () => {
  test("the values are identical and the arrays are simply absent", () => {
    const bare = grib2.decode(BUFFER, { coordinates: false })[0];
    expect(bare.latitudes).toBeNull();
    expect(bare.longitudes).toBeNull();
    expect(bare.values.length).toBe(full.values.length);
    expect(bare.grid).toEqual(full.grid);
    for (let n = 0; n < full.values.length; n += 9973) {
      expect(bare.values[n]).toBe(full.values[n]);
    }
  });

  test("a cropped record still carries the coordinates for what it kept", () => {
    // Which is the whole arrangement: the two million pairs are never built,
    // and the few hundred that survive the crop are.
    const bare = grib2.decode(BUFFER, { coordinates: false })[0];
    const cropped = grib2.cropToBox(bare, BOX);
    expect(cropped.latitudes.length).toBe(cropped.values.length);
    expect(cropped.longitudes.length).toBe(cropped.values.length);
  });
});

describe("cropping to a box", () => {
  const cropped = grib2.cropToBox(full, BOX);

  test("it keeps a window of the grid, not the grid", () => {
    expect(cropped.grid.ni).toBeLessThan(10);
    expect(cropped.grid.nj).toBeLessThan(10);
    expect(cropped.values.length).toBe(cropped.grid.ni * cropped.grid.nj);
    expect(cropped.values.length).toBeLessThan(full.values.length / 10000);
  });

  test("the box is inside what was kept, with the padding asked for", () => {
    // A box smaller than a cell still has to come back with the cells around
    // it, or an interpolation at its centre has nothing to interpolate.
    expect(Math.min.apply(null, cropped.latitudes)).toBeLessThan(BOX.south);
    expect(Math.max.apply(null, cropped.latitudes)).toBeGreaterThan(BOX.north);
    expect(Math.min.apply(null, cropped.longitudes)).toBeLessThan(BOX.west);
    expect(Math.max.apply(null, cropped.longitudes)).toBeGreaterThan(BOX.east);
    const tight = grib2.cropToBox(full, BOX, { paddingCells: 0 });
    expect(tight.grid.ni).toBe(cropped.grid.ni - 2);
    expect(tight.grid.nj).toBe(cropped.grid.nj - 2);
  });

  test("every value it kept is the value the full grid had there", () => {
    // The one thing that makes the crop safe: it is the same field, said
    // shorter. A resample here would be invisible — every number would still
    // be a plausible land-sea mask.
    for (let n = 0; n < cropped.values.length; n++) {
      const m = indexOf(cropped.latitudes[n], cropped.longitudes[n]);
      expect(m).toBeGreaterThan(-1);
      expect(cropped.values[n]).toBe(full.values[m]);
    }
  });

  test("the projection is the source's, moved to the new first point", () => {
    expect(cropped.grid.template).toBe(full.grid.template);
    expect(cropped.grid.dxMeters).toBe(full.grid.dxMeters);
    expect(cropped.grid.dyMeters).toBe(full.grid.dyMeters);
    expect(cropped.grid.latin1Deg).toBe(full.grid.latin1Deg);
    expect(cropped.grid.latin2Deg).toBe(full.grid.latin2Deg);
    expect(cropped.grid.lovDeg).toBe(full.grid.lovDeg);
    // The first point moves, and it moves to a point the full grid had: the
    // origin is re-projected out of the grid rather than taken from the
    // corner's own latitude and longitude, which on a Lambert grid are not the
    // same thing.
    expect(cropped.grid.lat1Deg).toBeCloseTo(cropped.latitudes[0], 9);
    expect(cropped.grid.lon1Deg).toBeCloseTo(cropped.longitudes[0], 9);
    expect(indexOf(cropped.latitudes[0], cropped.longitudes[0])).toBeGreaterThan(0);
  });

  test("the record's identity survives", () => {
    expect(cropped.parameter).toBe(full.parameter);
    expect(cropped.level).toBe(full.level);
    expect(cropped.validTime.getTime()).toBe(full.validTime.getTime());
    expect(cropped.discipline).toBe(full.discipline);
    expect(cropped.number).toBe(full.number);
  });

  test("a box at the grid's edge is clamped rather than run off", () => {
    const corner = grib2.cropToBox(full, {
      west: full.grid.lon1Deg - 0.5, south: full.grid.lat1Deg - 0.5,
      east: full.grid.lon1Deg + 0.05, north: full.grid.lat1Deg + 0.05
    });
    expect(corner.grid.ni).toBeGreaterThan(0);
    expect(corner.grid.nj).toBeGreaterThan(0);
    expect(corner.values.length).toBe(corner.grid.ni * corner.grid.nj);
    expect(corner.values.every(function (v) { return v !== undefined; })).toBe(true);
  });

  test("a box off the grid is refused, not returned empty", () => {
    // An empty crop reads downstream as a domain with no data in it, which is
    // a fact about the atmosphere and not about the request.
    expect(() => grib2.cropToBox(full, {
      west: 10, south: 40, east: 11, north: 41
    })).toThrow(/does not meet this grid/);
  });

  test("a malformed box or padding is refused", () => {
    expect(() => grib2.cropToBox(full, { west: -105.3, south: 40, east: -105.2 }))
      .toThrow(/finite north/);
    expect(() => grib2.cropToBox(full, BOX, { paddingCells: -1 }))
      .toThrow(/zero or more/);
  });
});
