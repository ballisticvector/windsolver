/**
 * The view: a straight line over the ground, cut out of a general field.
 *
 * Two things here are worth testing rather than reading. The first is the
 * geodesic — walking a bearing over an ellipsoid is arithmetic whose every
 * intermediate value is a plausible latitude, so it is graded against PROJ
 * (`tools/geodesic-reference.py`) the way the decoder is graded against
 * ecCodes. The second is the sign of the cross-track component: an
 * east-north field and a track-relative one are numerically indistinguishable,
 * and a wind decomposed with the wrong sign is a hold in the wrong direction
 * that looks entirely ordinary on a screen.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const proj = require("../proj.js");
const geo = require("../geo.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const profile = require("../profile.js");
const slice = require("../slice.js");

const REFERENCE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "geodesic.reference.json"), "utf8")
);

const CENTRE = { lat: 40.0150, lon: -105.2705 };

/** A flat UTM domain around Boulder, `spacing` metres to the pixel. */
function flatField(wind, opts) {
  const o = opts || {};
  const spacing = o.spacing || 20;
  const width = o.width || 201;
  const height = o.height || 201;
  const crs = proj.crsFromEpsg(26913);
  const mid = proj.fromGeographic(crs, CENTRE.lat, CENTRE.lon);
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = o.z ? o.z(col, row) : 1600;
    }
  }
  const grid = {
    crs: crs,
    width: width,
    height: height,
    values: values,
    resolutionM: spacing,
    transform: {
      originX: mid.x - (width * spacing) / 2,
      originY: mid.y + (height * spacing) / 2,
      scaleX: spacing,
      scaleY: -spacing
    }
  };
  const derived = derive.derive(grid, { shelter: false });
  const weights = downscale.terrainWeights(derived, { curvatureLengthM: 200 });
  // `weights` rides along exactly as `field.js` returns it, because the ground
  // under a station is part of the answer and the downscaled field alone does
  // not carry it.
  return Object.assign(
    downscale.downscale(weights, wind, { heightAglM: 10, shelter: false }),
    { weights: weights }
  );
}

describe("destination", () => {
  test("walks a bearing over WGS84 the way PROJ does", () => {
    let worstM = 0;
    let worstDeg = 0;
    for (const c of REFERENCE.cases) {
      const got = slice.destination({ lat: c.lat, lon: c.lon }, c.bearingDeg, c.distanceM);
      // Compare on the ground rather than in degrees: a degree of longitude is
      // 25 m at Svalbard and 111 km at the equator, so a tolerance in degrees
      // is a different tolerance in every row of the fixture.
      const dLatM = (got.lat - c.toLat) * geo.METERS_PER_DEG_LAT;
      const dLonM = (got.lon - c.toLon) * geo.metersPerDegLon(c.toLat);
      worstM = Math.max(worstM, Math.hypot(dLatM, dLonM));
      let dAz = Math.abs(got.forwardDeg - c.forwardDeg) % 360;
      if (dAz > 180) dAz = 360 - dAz;
      worstDeg = Math.max(worstDeg, dAz);
    }
    expect(worstM).toBeLessThan(1e-6);
    expect(worstDeg).toBeLessThan(1e-9);
  });

  test("the line's own direction is not the bearing it started with", () => {
    // A geodesic is straight on the ground and curved on the graticule: due
    // east from Boulder arrives pointing south of east. Small, but it is the
    // difference between the shot's axis and the axis the wind was resolved
    // onto, so it is reported rather than assumed away.
    const near = slice.destination(CENTRE, 90, 3218.688);
    const far = slice.destination(CENTRE, 90, 100000);
    expect(near.forwardDeg - 90).toBeGreaterThan(0.01);
    expect(near.forwardDeg - 90).toBeLessThan(0.03);
    expect(far.forwardDeg - 90).toBeGreaterThan(0.5);
  });

  test("refuses a distance or a bearing it cannot walk", () => {
    expect(() => slice.destination(CENTRE, 90, -1)).toThrow(/distance/);
    expect(() => slice.destination(CENTRE, NaN, 100)).toThrow(/bearing/);
    expect(() => slice.destination({ lat: 95, lon: 0 }, 90, 100)).toThrow(/lat/);
  });
});

describe("boxFor", () => {
  test("contains every station of the line, with room to spare", () => {
    const box = slice.boxFor(CENTRE, 45, 2000, { stepM: 100 });
    for (let d = 0; d <= 2000; d += 100) {
      const at = slice.destination(CENTRE, 45, d);
      expect(geo.containsPoint(box, at.lat, at.lon)).toBe(true);
    }
    expect(geo.containsPoint(box, CENTRE.lat, CENTRE.lon)).toBe(true);
  });

  test("is the corridor the line needs, not a square around the longest leg", () => {
    // A due-north line is thin east-west, and asking for a radius instead
    // reads and derives terrain a mile either side of it for nothing.
    const north = slice.boxFor(CENTRE, 0, 3218.688, {});
    expect(geo.heightMiles(north)).toBeGreaterThan(2);
    expect(geo.widthMiles(north)).toBeLessThan(0.2);
  });

  test("a bearing that runs south-west puts the origin at the north-east corner", () => {
    const box = slice.boxFor(CENTRE, 225, 1000, {});
    expect(box.north).toBeGreaterThan(CENTRE.lat);
    expect(box.east).toBeGreaterThan(CENTRE.lon);
    expect(box.south).toBeLessThan(CENTRE.lat - 0.005);
    expect(box.west).toBeLessThan(CENTRE.lon - 0.005);
  });
});

describe("transect", () => {
  const field = flatField({ speedMps: 5, fromDeg: 180 });

  test("stations run from the origin to the length asked for", () => {
    const t = slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 1000, stepM: 250 });
    expect(t.distancesM).toEqual([0, 250, 500, 750, 1000]);
    expect(t.stations).toHaveLength(5);
    expect(t.stations[0].lat).toBeCloseTo(CENTRE.lat, 12);
    expect(t.stations[0].lon).toBeCloseTo(CENTRE.lon, 12);
    expect(t.bearingDeg).toBe(90);
  });

  test("a length that is not a whole number of steps still ends on the length", () => {
    const t = slice.transect(field, { from: CENTRE, bearingDeg: 0, lengthM: 900, stepM: 400 });
    expect(t.distancesM).toEqual([0, 400, 800, 900]);
  });

  test("a wind out of the south is a right-to-left wind on an eastward line", () => {
    // The README's diagram: shot due east, 5 m/s from the south. The air moves
    // north, which is across the line from the walker's right to their left,
    // so the cross-track component is negative and there is no along-track
    // component at all.
    const t = slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 500, stepM: 500 });
    expect(t.stations[0].alongMps).toBeCloseTo(0, 12);
    for (const s of t.stations) {
      expect(s.crossMps).toBeCloseTo(-5, 4);
      expect(s.north).toBeCloseTo(5, 6);
    }
    // Not exactly zero at the far end, and that is the geodesic rather than
    // noise: the line has turned 0.004° by 500 m, so a wind square across it
    // has a component along it. 0.3 mm/s.
    expect(Math.abs(t.stations[1].alongMps)).toBeGreaterThan(1e-5);
    expect(Math.abs(t.stations[1].alongMps)).toBeLessThan(1e-3);
  });

  test("a tailwind is positive along-track, a headwind negative", () => {
    const tail = slice.transect(flatField({ speedMps: 5, fromDeg: 270 }), {
      from: CENTRE, bearingDeg: 90, lengthM: 100, stepM: 100
    });
    const head = slice.transect(flatField({ speedMps: 5, fromDeg: 90 }), {
      from: CENTRE, bearingDeg: 90, lengthM: 100, stepM: 100
    });
    expect(tail.stations[0].alongMps).toBeCloseTo(5, 6);
    expect(head.stations[0].alongMps).toBeCloseTo(-5, 6);
    expect(tail.stations[0].crossMps).toBeCloseTo(0, 6);
  });

  test("resolves onto the line's own direction, not the bearing it started with", () => {
    // Over a long line the two differ by more than the contract's 1° azimuth
    // tolerance, and resolving the far end onto the near end's axis puts the
    // error into the cross-track component, which is the one that becomes a
    // hold.
    const t = slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 1000, stepM: 500 });
    expect(t.stations[0].forwardDeg).toBeCloseTo(90, 9);
    expect(t.stations[2].forwardDeg).toBeGreaterThan(90);
    expect(t.convergenceDeg).toBeCloseTo(t.stations[2].forwardDeg - 90, 9);
  });

  test("refuses to leave the domain rather than holding the edge value", () => {
    // The field is 201 x 20 m, so 2 km along the line is off the end of it.
    // Clamping would answer a 2,000 yard shot with the wind 1 mile short of
    // the target and no way for the caller to tell.
    const err = (() => {
      try {
        slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 4000, stepM: 500 });
      } catch (e) { return e; }
    })();
    expect(err.code).toBe("outside-domain");
    // It stops at the first station it cannot answer — 2,000 m here rather
    // than the 4,000 asked for, because the derivatives leave the outermost
    // ring of the domain undefined and the wind with them.
    expect(err.distanceM).toBe(2000);
    expect(err.message).toMatch(/leaves the field at 2000 m/);
  });

  test("refuses a step or a length that describes no line", () => {
    expect(() => slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 0, stepM: 10 }))
      .toThrow(/lengthM/);
    expect(() => slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 100, stepM: 0 }))
      .toThrow(/stepM/);
  });

  test("carries the ground and the field's own height with it", () => {
    const t = slice.transect(field, { from: CENTRE, bearingDeg: 90, lengthM: 200, stepM: 200 });
    expect(t.heightAglM).toBe(10);
    expect(t.stations[0].elevationM).toBeCloseTo(1600, 3);
  });
});

describe("plane", () => {
  const field = flatField({ speedMps: 5, fromDeg: 180 });
  const line = { from: CENTRE, bearingDeg: 90, lengthM: 500, stepM: 250 };

  test("the field's own height comes back unscaled", () => {
    const p = slice.plane(field, Object.assign({ heightsAglM: [10] }, line));
    expect(p.heightsAglM).toEqual([10]);
    expect(p.factors[0]).toBeCloseTo(1, 12);
    expect(p.crossMps[0][0]).toBeCloseTo(-5, 6);
  });

  test("other heights are the log law, and it is the only thing moving them", () => {
    const p = slice.plane(field, Object.assign({ heightsAglM: [2, 10, 40] }, line));
    const expected = downscale.heightFactor(10, 40, downscale.DEFAULT_ROUGHNESS_M);
    expect(p.factors[2]).toBeCloseTo(expected, 12);
    expect(p.crossMps[2][0]).toBeCloseTo(-5 * expected, 9);
    expect(p.crossMps[0][0]).toBeCloseTo(-5 * downscale.heightFactor(10, 2, 0.03), 9);
    // Scaling a vector by a scalar cannot turn it, so the bearing is the same
    // at every height. That is a property of the log law and a limitation:
    // real profiles veer with height, and nothing here does.
    expect(p.alongMps[0][0]).toBeCloseTo(0, 9);
  });

  test("heights must ascend, and must clear the roughness length", () => {
    expect(() => slice.plane(field, Object.assign({ heightsAglM: [10, 2] }, line)))
      .toThrow(/ascend/);
    expect(() => slice.plane(field, Object.assign({ heightsAglM: [0.01] }, line)))
      .toThrow(/roughness/);
    expect(() => slice.plane(field, Object.assign({ heightsAglM: [] }, line)))
      .toThrow(/heightsAglM/);
  });

  test("grids are [height][distance], the shape the contract indexes", () => {
    const p = slice.plane(field, Object.assign({ heightsAglM: [2, 10] }, line));
    expect(p.alongMps).toHaveLength(2);
    expect(p.alongMps[0]).toHaveLength(p.distancesM.length);
    expect(p.upMps[0].every((w) => w === 0)).toBe(true);
  });
});

describe("toWindProfile", () => {
  const field = flatField({ speedMps: 5, fromDeg: 180 });
  const plane = slice.plane(field, {
    from: CENTRE,
    bearingDeg: 90,
    lengthM: 500,
    stepM: 250,
    heightsAglM: [2, 10, 40]
  });

  test("is a valid v1 profile, in the shooter's frame and in feet", () => {
    const p = slice.toWindProfile(plane, { source: "test" });
    const check = profile.validateWindProfile(p, { shotAzimuthDeg: 90 });
    expect(check.ok).toBe(true);
    expect(p.frame).toBe("shooter");
    expect(p.heightsAglFt[1]).toBeCloseTo(10 / 0.3048, 9);
    expect(p.rangesYards[1]).toBeCloseTo(250 / 0.9144, 9);
  });

  test("a wind from the shooter's right is negative v, as the diagram says", () => {
    const p = slice.toWindProfile(plane, { source: "test" });
    const at10 = 1;
    expect(plane.heightsAglM[at10]).toBe(10);
    expect(p.vFps[at10][0]).toBeCloseTo(-5 / 0.3048, 6);
    expect(p.uFps[at10][0]).toBeCloseTo(0, 9);
    expect(p.wFps[at10][0]).toBe(0);
  });

  test("carries the provenance the consumer displays, and will not invent it", () => {
    const p = slice.toWindProfile(plane, {
      source: "HRRR 2026-08-26T20:00Z + 3DEP 1 m",
      terrainResolutionM: 1,
      windSourceResolutionM: 3000,
      confidence: 0.5
    });
    expect(p.source).toBe("HRRR 2026-08-26T20:00Z + 3DEP 1 m");
    expect(p.terrainResolutionM).toBe(1);
    expect(p.windSourceResolutionM).toBe(3000);
    expect(p.confidence).toBe(0.5);
    // Unstated provenance is null, never a plausible default: a confidence
    // nobody supplied displayed as a number is the failure the key exists for.
    // `source` is the exception the contract makes — an unattributed field is
    // refused outright, so there is nothing to default it to.
    const bare = slice.toWindProfile(plane, { source: "test" });
    expect(bare.confidence).toBeNull();
    expect(bare.terrainResolutionM).toBeNull();
    expect(() => slice.toWindProfile(plane, {})).toThrow(/source/);
  });

  test("the azimuth is the line's, so a caller cannot get a mismatch by accident", () => {
    const p = slice.toWindProfile(plane, { source: "test" });
    expect(p.azimuthDeg).toBe(90);
    expect(profile.validateWindProfile(p, { shotAzimuthDeg: 180 }).code).toBe("azimuth-mismatch");
  });
});
