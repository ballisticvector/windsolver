/**
 * Graded against GDAL, not against itself.
 *
 * A projection written from the book and checked by round-tripping through its
 * own inverse passes while being wrong: the two halves share the mistake. The
 * expected values below came out of `gdaltransform`, which is PROJ:
 *
 *   printf "472993.999982181 4427005.99995556\n" |
 *     gdaltransform -s_srs EPSG:26913 -t_srs EPSG:4269 -output_xy
 *
 * PROJ prints 12 significant figures, which is why the tolerances here are
 * stated in metres of ground rather than in decimal places.
 *
 * Measured agreement over the whole span of a UTM zone and a degree or two
 * either side of it: **better than 6 mm**, worst case at 4.5 degrees off the
 * central meridian. Snyder's series is truncated, so the disagreement grows
 * away from the meridian; it is millimetres where a 1 m DEM pixel is a metre,
 * and the tests below pin the size of it rather than hiding it behind a loose
 * tolerance.
 */

"use strict";

const proj = require("../proj.js");

const METRES_PER_DEG_LAT = 111320;

describe("crsFromEpsg", () => {
  test("knows the two geographic systems 3DEP ships in", () => {
    expect(proj.crsFromEpsg(4269).kind).toBe("geographic");
    expect(proj.crsFromEpsg(4269).datum).toBe("NAD83");
    expect(proj.crsFromEpsg(4326).datum).toBe("WGS84");
  });

  test("reads a UTM zone and its hemisphere out of the code", () => {
    const nad = proj.crsFromEpsg(26913);
    expect(nad.kind).toBe("utm");
    expect(nad.zone).toBe(13);
    expect(nad.northern).toBe(true);
    expect(nad.centralMeridian).toBe(-105);

    expect(proj.crsFromEpsg(32612).zone).toBe(12);
    expect(proj.crsFromEpsg(32718).northern).toBe(false);
    expect(proj.crsFromEpsg(32718).centralMeridian).toBe(-75);
  });

  test("refuses a system it does not know rather than guessing", () => {
    expect(() => proj.crsFromEpsg(6350)).toThrow(/EPSG:6350/);
    try {
      proj.crsFromEpsg(6350);
    } catch (err) {
      expect(err.code).toBe("crs-unsupported");
    }
  });
});

describe("utmInverse, against gdaltransform", () => {
  const cases = [
    [26913, 472993.999982181, 4427005.99995556, -105.316345302391, 39.9927999562437],
    [26913, 473121.999982181, 4426910.99995556, -105.314842015944, 39.9919481193643],
    [26913, 500000, 4000000, -105, 36.1447180997896],
    [26913, 200000, 4500000, -108.545227783018, 40.5964087198553],
    [26913, 780000, 4200000, -101.815369545656, 37.9044772632124],
    [32612, 500000, 4400000, -111, 39.7499075191046],
    [32612, 300000, 3000000, -113.017505655194, 27.1079795236266],
    [32718, 500000, 6000000, -75, -36.1447180988178]
  ];

  test.each(cases)("EPSG:%i %f %f", (epsg, x, y, lon, lat) => {
    const crs = proj.crsFromEpsg(epsg);
    const got = proj.utmInverse(crs, x, y);
    // Compared as ground distance, because a degree of longitude is not a
    // degree of latitude and "7 decimal places" means different things at 27N
    // and 40N. 10 mm.
    const metresPerDegLon = METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    expect(Math.abs(got.lat - lat) * METRES_PER_DEG_LAT).toBeLessThan(0.01);
    expect(Math.abs(got.lon - lon) * metresPerDegLon).toBeLessThan(0.01);
  });

  test("the central meridian at the equator is the projection's own origin", () => {
    const got = proj.utmInverse(proj.crsFromEpsg(26913), 500000, 0);
    expect(got.lon).toBeCloseTo(-105, 9);
    expect(got.lat).toBeCloseTo(0, 9);
  });
});

describe("utmForward", () => {
  test("puts back what the inverse took out, across a zone", () => {
    const crs = proj.crsFromEpsg(26913);
    for (const [x, y] of [[200000, 4500000], [500000, 4000000], [780000, 4200000]]) {
      const geo = proj.utmInverse(crs, x, y);
      const back = proj.utmForward(crs, geo.lat, geo.lon);
      // 10 mm of easting and northing, the same budget as the inverse.
      expect(Math.abs(back.x - x)).toBeLessThan(0.01);
      expect(Math.abs(back.y - y)).toBeLessThan(0.01);
    }
  });

  // gdaltransform -s_srs EPSG:4269 -t_srs EPSG:26913 -output_xy
  test.each([
    [-105.316345302391, 39.9927999562437, 472993.999982181, 4427005.99995556],
    [-108.545227783018, 40.5964087198553, 199999.999999972, 4500000],
    [-101.815369545656, 37.9044772632124, 779999.999999978, 4200000],
    [-100.5, 40, 884187.832389053, 4437465.89873247],
    [-109.5, 40, 115812.167610945, 4437465.89873247]
  ])("agrees with PROJ at %f %f, to a millimetre of easting and northing", (lon, lat, x, y) => {
    const got = proj.utmForward(proj.crsFromEpsg(26913), lat, lon);
    expect(Math.abs(got.x - x)).toBeLessThan(0.001);
    expect(Math.abs(got.y - y)).toBeLessThan(0.001);
  });

  test("a southern zone carries its false northing", () => {
    const crs = proj.crsFromEpsg(32718);
    const got = proj.utmForward(crs, -36.1447180988178, -75);
    expect(got.x).toBeCloseTo(500000, 3);
    expect(got.y).toBeCloseTo(6000000, 3);
  });
});

describe("toGeographic and fromGeographic", () => {
  test("a geographic raster's model coordinates are longitude and latitude, in that order", () => {
    const crs = proj.crsFromEpsg(4269);
    expect(proj.toGeographic(crs, -105.28, 40.02)).toEqual({ lat: 40.02, lon: -105.28 });
    expect(proj.fromGeographic(crs, 40.02, -105.28)).toEqual({ x: -105.28, y: 40.02 });
  });

  test("a projected raster goes through the projection both ways", () => {
    const crs = proj.crsFromEpsg(26913);
    const model = proj.fromGeographic(crs, 40.02, -105.28);
    expect(model.x).toBeGreaterThan(400000);
    const back = proj.toGeographic(crs, model.x, model.y);
    expect(back.lat).toBeCloseTo(40.02, 9);
    expect(back.lon).toBeCloseTo(-105.28, 9);
  });
});

describe("pixelMetres", () => {
  test("a projected raster's pixel is already in metres", () => {
    const m = proj.pixelMetres(proj.crsFromEpsg(26913), 1, -1, 40);
    expect(m).toEqual({ x: 1, y: 1 });
  });

  test("a degree is not square: 1/3 arc-second is coarser north-south than east-west at 40N", () => {
    const third = 1 / 3600 / 3;
    const m = proj.pixelMetres(proj.crsFromEpsg(4269), third, -third, 40);
    expect(m.y).toBeGreaterThan(m.x);
    expect(m.y).toBeCloseTo(10.29, 2);
    expect(m.x).toBeCloseTo(7.88, 2);
  });

  test("degrees of longitude shrink towards the pole", () => {
    const third = 1 / 3600 / 3;
    const crs = proj.crsFromEpsg(4269);
    expect(proj.pixelMetres(crs, third, -third, 65).x)
      .toBeLessThan(proj.pixelMetres(crs, third, -third, 25).x);
  });
});

test("a tile projected well outside its own zone still agrees with PROJ to a centimetre", () => {
  // Zone 13 nominally spans 108W-102W; 3DEP projects a whole lidar project into
  // one zone, so tiles do sit a degree or two outside it. That is where a
  // truncated series is at its worst, so it is the case worth pinning.
  const crs = proj.crsFromEpsg(26913);
  const got = proj.toGeographic(crs, 884187.832389053, 4437465.89873247);
  const metresPerDegLon = METRES_PER_DEG_LAT * Math.cos((40 * Math.PI) / 180);
  expect(Math.abs(got.lat - 40) * METRES_PER_DEG_LAT).toBeLessThan(0.01);
  expect(Math.abs(got.lon + 100.5) * metresPerDegLon).toBeLessThan(0.01);
});
