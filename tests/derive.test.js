/**
 * Graded against GDAL where GDAL has an answer, and against analytic geometry
 * where it does not.
 *
 * Every value in a slope raster is a plausible slope, every value in a
 * curvature raster is a plausible curvature, and a derivative computed with the
 * wrong pixel spacing, the wrong sign or a transposed axis produces a field
 * that looks exactly like terrain. So:
 *
 *   slope, aspect, roughness, TRI, TPI   graded pixel by pixel against
 *                                        `gdaldem`, on the projected fixture
 *                                        where GDAL's model and ours agree
 *   curvature                            graded against a paraboloid and a
 *                                        cylinder, whose curvature is known in
 *                                        closed form; no GDAL tool computes it
 *   sheltering                           graded against a wall at a measured
 *                                        distance, where Sx is atan(h/d)
 *   geographic spacing                   measured *against* GDAL, on purpose:
 *                                        `gdaldem -s` takes one scale for both
 *                                        axes and cannot express a pixel that
 *                                        is 10.3 m tall and 7.9 m wide
 *
 * References are made by `tools/make-cog-fixtures.sh`; `gdaldem-<raster>-<alg>`
 * is GDAL's output over the fixture named in the middle.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const derive = require("../derive.js");
const geo = require("../geo.js");
const proj = require("../proj.js");

const FIXTURES = path.join(__dirname, "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

/** The full-resolution level of a fixture, read as a window. */
function gridOf(name) {
  const buffer = fixture(name + ".tif");
  const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: buffer }]));
  const level = header.levels[0];
  const window = { x0: 0, y0: 0, x1: level.width, y1: level.height };
  const decoded = new Map();
  cog.tilesForWindow(level, window).forEach(function (tile) {
    if (tile.empty) return;
    decoded.set(
      tile.tx + "," + tile.ty,
      cog.decodeTile(buffer.subarray(tile.offset, tile.offset + tile.byteCount), level, header)
    );
  });
  return cog.assembleWindow(header, level, window, decoded);
}

/** GDAL's output raster, with its nodata brought to NaN so the two compare. */
function gdaldem(name) {
  const meta = JSON.parse(fixture("gdaldem-" + name + ".gdal.json").toString("utf8"));
  const raw = fixture("gdaldem-" + name + ".gdal.f32");
  const n = meta.levels[0].width * meta.levels[0].height;
  const values = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 4));
  const nodata = Math.fround(meta.nodata);
  for (let i = 0; i < values.length; i++) {
    if (values[i] === nodata) values[i] = NaN;
  }
  return { width: meta.levels[0].width, height: meta.levels[0].height, values: values, nodata: meta.nodata };
}

/**
 * Compare two fields pixel by pixel, NaN for NaN, and report the worst
 * disagreement rather than only the first.
 */
function compare(mine, theirs, tolerance, circular) {
  let worst = 0;
  let worstAt = -1;
  let maskMismatches = 0;
  let compared = 0;
  for (let i = 0; i < theirs.length; i++) {
    const a = mine[i];
    const b = theirs[i];
    if (Number.isNaN(a) !== Number.isNaN(b)) {
      maskMismatches++;
      continue;
    }
    if (Number.isNaN(a)) continue;
    let d = Math.abs(a - b);
    if (circular && d > 180) d = 360 - d;
    compared++;
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
  return { worst: worst, worstAt: worstAt, maskMismatches: maskMismatches, compared: compared, tolerance: tolerance };
}

function expectMatches(mine, theirs, tolerance, circular) {
  const r = compare(mine, theirs, tolerance, circular);
  expect({ maskMismatches: r.maskMismatches, over: r.worst > tolerance }).toEqual({ maskMismatches: 0, over: false });
  expect(r.compared).toBeGreaterThan(1000);
  return r;
}

/**
 * Horn's slope and aspect exactly as `gdaldem` computes them: in float32, and
 * summing four elevations before differencing them.
 *
 * This exists because grading against GDAL turned up a real disagreement — up
 * to 0.011 degrees of slope on ground 2,218 m above the datum — and a loose
 * tolerance would hide the difference between "the same formula rounded
 * differently" and "a different formula". The replay reproduces GDAL bit for
 * bit, which pins the disagreement to the arithmetic and to nothing else.
 */
function gdalHornReplay(grid, what) {
  const f = Math.fround;
  const w = grid.width;
  const h = grid.height;
  const v = grid.values;
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const z = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) z.push(v[(y + dy) * w + x + dx]);
      }
      if (z.some(Number.isNaN)) continue;
      const west = f(f(f(z[0] + z[3]) + z[3]) + z[6]);
      const east = f(f(f(z[2] + z[5]) + z[5]) + z[8]);
      const south = f(f(f(z[6] + z[7]) + z[7]) + z[8]);
      const north = f(f(f(z[0] + z[1]) + z[1]) + z[2]);
      if (what === "slope") {
        const dx = f(west - east) / grid.transform.scaleX;
        const dy = f(south - north) / grid.transform.scaleY;
        out[y * w + x] = f((Math.atan(Math.sqrt(dx * dx + dy * dy) / 8) * 180) / Math.PI);
        continue;
      }
      // GDAL's aspect divides by no resolution at all, so it is only correct on
      // square pixels — worth knowing before trusting it on a geographic DEM.
      const dx = f(east - west);
      const dy = f(south - north);
      if (dx === 0 && dy === 0) continue;
      const a = f((Math.atan2(dy, -dx) * 180) / Math.PI);
      out[y * w + x] = a > 90 ? f(450 - a) : f(90 - a);
    }
  }
  return out;
}

/** A synthetic projected grid, 1 m pixels, from an analytic surface. */
function syntheticGrid(width, height, z, spacing) {
  const step = spacing || 1;
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      // Metres east and north of the grid's south-west corner.
      values[row * width + col] = z((col + 0.5) * step, (height - row - 0.5) * step);
    }
  }
  return syntheticGridFrom(values, width, height, step);
}

/** The same grid, over elevations that came from somewhere else. */
function syntheticGridFrom(values, width, height, step, originX) {
  const grid = {
    crs: proj.crsFromEpsg(26913),
    width: width,
    height: height,
    values: values,
    // Placed on the central meridian so grid north is true north and the
    // sheltering bearings are not rotated by convergence.
    transform: {
      originX: originX === undefined ? 500000 : originX,
      originY: 4400000 + height * step,
      scaleX: step,
      scaleY: -step
    }
  };
  grid.bounds = cog.gridBounds(grid);
  return grid;
}

function at(grid, field, col, row) {
  return field[row * grid.width + col];
}

describe("slope and aspect, against gdaldem", () => {
  const grid = gridOf("cog-utm13-1m");
  const mine = derive.slopeAspect(grid);

  test("Horn's formula and the pixel spacing are GDAL's, replayed bit for bit", () => {
    // All 11,844 pixels exactly equal, in both fields: the formula, the
    // neighbourhood, the pixel spacing and the aspect convention are gdaldem's.
    // Only the precision of the arithmetic is not.
    expect(compare(gdalHornReplay(grid, "slope"), gdaldem("utm13-slope").values, 0))
      .toMatchObject({ worst: 0, maskMismatches: 0, compared: 11844 });
    expect(compare(gdalHornReplay(grid, "aspect"), gdaldem("utm13-aspect").values, 0))
      .toMatchObject({ worst: 0, maskMismatches: 0 });
  });

  test("every slope is GDAL's slope, to within GDAL's own rounding", () => {
    const want = gdaldem("utm13-slope");
    // 0.02 deg rather than 1e-4, and the difference is GDAL's: it adds four
    // elevations of 2,218 m together before subtracting them, and float32 has
    // about a millimetre of room left at that magnitude.
    const r = expectMatches(mine.slopeDeg, want.values, 0.02);
    expect(r.compared).toBe((grid.width - 2) * (grid.height - 2));
    expect(r.worst).toBeGreaterThan(1e-3);
  });

  test("every aspect is GDAL's aspect, and flat ground is refused rather than called north", () => {
    const want = gdaldem("utm13-aspect");
    // GDAL writes -9999 where there is no slope to face anywhere, which is its
    // nodata; both sides therefore have to agree on which pixels those are.
    expectMatches(mine.aspectDeg, want.values, 0.2, true);
  });

  test("and where the two differ, GDAL is the one that is wrong", () => {
    // A plane 2 km above the datum, tilted by a known amount: the answer is in
    // closed form, so this measures both implementations rather than preferring
    // one. Ground at that height is ordinary in Colorado.
    const g = 0.33;
    const plane = syntheticGrid(41, 41, function (x, y) { return 2200 + g * x + g * y; });
    const truth = (Math.atan(Math.hypot(g, g)) * 180) / Math.PI;
    const typicalError = function (field) {
      const e = [];
      for (let i = 0; i < field.length; i++) {
        if (!Number.isNaN(field[i])) e.push(Math.abs(field[i] - truth));
      }
      e.sort(function (a, b) { return a - b; });
      return e[Math.floor(e.length / 2)];
    };
    // Neither is exact: a float32 elevation of 2,200 m is only good to a
    // quarter of a millimetre, and both read the same stored grid. What GDAL
    // adds on top of that is its own — three times the error, from summing
    // four of those elevations before subtracting them.
    const ours = typicalError(derive.slopeAspect(plane).slopeDeg);
    expect(ours * 2).toBeLessThan(typicalError(gdalHornReplay(plane, "slope")));
    expect(ours).toBeLessThan(1e-3);
  });

  test("the border is undefined, not extrapolated", () => {
    for (let x = 0; x < grid.width; x++) {
      expect(at(grid, mine.slopeDeg, x, 0)).toBeNaN();
      expect(at(grid, mine.slopeDeg, x, grid.height - 1)).toBeNaN();
    }
    for (let y = 0; y < grid.height; y++) {
      expect(at(grid, mine.slopeDeg, 0, y)).toBeNaN();
      expect(at(grid, mine.slopeDeg, grid.width - 1, y)).toBeNaN();
    }
  });
});

describe("roughness, against gdaldem", () => {
  const grid = gridOf("cog-utm13-1m");
  const mine = derive.roughness(grid);

  test("relief is GDAL's roughness", () => {
    expectMatches(mine.relief, gdaldem("utm13-roughness").values, 1e-4);
  });

  test("tri is GDAL's Riley TRI", () => {
    expectMatches(mine.tri, gdaldem("utm13-TRI").values, 1e-3);
  });

  test("tpi is GDAL's TPI", () => {
    expectMatches(mine.tpi, gdaldem("utm13-TPI").values, 1e-3);
  });
});

describe("nodata", () => {
  const grid = gridOf("cog-nodata-hole");
  const spacingM = { x: Math.abs(grid.transform.scaleX) * 111120, y: Math.abs(grid.transform.scaleY) * 111120 };

  test("a hole in the elevation is a hole in the slope, exactly where GDAL puts one", () => {
    const mine = derive.slopeAspect(grid, { spacingM: spacingM });
    const want = gdaldem("hole-slope");
    let holes = 0;
    for (let i = 0; i < want.values.length; i++) {
      if (Number.isNaN(want.values[i])) holes++;
      expect(Number.isNaN(mine.slopeDeg[i])).toBe(Number.isNaN(want.values[i]));
    }
    // The border plus the punched rectangle, spread one pixel by the 3 x 3.
    expect(holes).toBeGreaterThan(2 * (grid.width + grid.height));
  });

  test("a nodata pixel does not leak into a neighbour's roughness", () => {
    const mine = derive.roughness(grid);
    for (let i = 0; i < grid.values.length; i++) {
      if (Number.isNaN(grid.values[i])) expect(Number.isNaN(mine.relief[i])).toBe(true);
    }
    expect(mine.relief.some(function (v) { return v > 1e5; })).toBe(false);
  });
});

describe("a geographic pixel is not square on the ground", () => {
  const grid = gridOf("cog-lzw-p3");
  const midLat = derive.spacingAt(grid, Math.floor(grid.height / 2));

  test("the two axes differ by the cosine of the latitude", () => {
    const lat = grid.bounds.south + (grid.bounds.north - grid.bounds.south) / 2;
    expect(midLat.y).toBeCloseTo(Math.abs(grid.transform.scaleY) * geo.METERS_PER_DEG_LAT, 6);
    expect(midLat.x / midLat.y).toBeCloseTo(Math.cos((lat * Math.PI) / 180), 3);
    // 1/3 arc-second at 40 north: about 10.3 m tall and 7.9 m wide.
    expect(midLat.y).toBeGreaterThan(10);
    expect(midLat.x).toBeLessThan(8);
  });

  test("the spacing moves down the grid, rather than being taken once", () => {
    const top = derive.spacingAt(grid, 0);
    const bottom = derive.spacingAt(grid, grid.height - 1);
    expect(top.x).not.toBe(bottom.x);
    expect(top.y).toBe(bottom.y);
  });

  test("with GDAL's one-scale model the arithmetic is identical to gdaldem's", () => {
    // Proves the disagreement below is the spacing and not the formula.
    const spacingM = { x: Math.abs(grid.transform.scaleX) * 111120, y: Math.abs(grid.transform.scaleY) * 111120 };
    const asGdal = derive.slopeAspect(grid, { spacingM: spacingM });
    expectMatches(asGdal.slopeDeg, gdaldem("geographic-slope").values, 0.02);
    expectMatches(asGdal.aspectDeg, gdaldem("geographic-aspect").values, 0.2, true);
    expect(compare(gdalHornReplay(grid, "aspect"), gdaldem("geographic-aspect").values, 0).worst).toBe(0);
  });

  test("and that model overstates the east-west spacing by 1/cos(lat)", () => {
    const spacingM = { x: Math.abs(grid.transform.scaleX) * 111120, y: Math.abs(grid.transform.scaleY) * 111120 };
    const asGdal = derive.slopeAspect(grid, { spacingM: spacingM });
    const mine = derive.slopeAspect(grid);
    const lat = grid.bounds.south + (grid.bounds.north - grid.bounds.south) / 2;
    const expected = 111120 / geo.metersPerDegLon(lat);

    // Every east-west gradient is larger by exactly that ratio, because the
    // same rise is being spread over a shorter run than GDAL believes.
    const ratios = [];
    for (let i = 0; i < mine.dzdx.length; i++) {
      if (!Number.isNaN(mine.dzdx[i]) && Math.abs(asGdal.dzdx[i]) > 1e-6) {
        ratios.push(mine.dzdx[i] / asGdal.dzdx[i]);
      }
    }
    expect(ratios.length).toBeGreaterThan(1000);
    ratios.forEach(function (r) { expect(r).toBeCloseTo(expected, 2); });
    expect(expected).toBeGreaterThan(1.3);

    // Which is a real number of degrees on real ground, not a rounding error.
    const diffs = [];
    for (let i = 0; i < mine.slopeDeg.length; i++) {
      if (!Number.isNaN(mine.slopeDeg[i])) diffs.push(mine.slopeDeg[i] - asGdal.slopeDeg[i]);
    }
    diffs.sort(function (a, b) { return a - b; });
    expect(diffs[Math.floor(diffs.length / 2)]).toBeGreaterThan(1);
  });

  test("a plane of known gradient comes back at that gradient", () => {
    // Built in degrees, described in metres: the surface rises 0.1 m per metre
    // east and 0.05 m per metre north. A reader that divides by degrees, or by
    // one scale for both axes, gets neither number back.
    const width = 40;
    const height = 30;
    const lat0 = 40;
    const lon0 = -105;
    const scale = 1 / 10800;
    const mPerLon = geo.metersPerDegLon(lat0 + (height / 2) * scale);
    const values = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const east = (col + 0.5) * scale * mPerLon;
        const north = (height - row - 0.5) * scale * geo.METERS_PER_DEG_LAT;
        values[row * width + col] = 0.1 * east + 0.05 * north;
      }
    }
    const plane = {
      crs: proj.crsFromEpsg(4269),
      width: width,
      height: height,
      values: values,
      transform: { originX: lon0, originY: lat0 + height * scale, scaleX: scale, scaleY: -scale }
    };
    plane.bounds = cog.gridBounds(plane);

    const mine = derive.slopeAspect(plane);
    const centre = Math.floor(height / 2) * width + Math.floor(width / 2);
    expect(mine.dzdx[centre]).toBeCloseTo(0.1, 3);
    expect(mine.dzdy[centre]).toBeCloseTo(0.05, 3);
    expect(mine.slopeDeg[centre]).toBeCloseTo((Math.atan(Math.hypot(0.1, 0.05)) * 180) / Math.PI, 3);
    // Rising to the east-north-east, so it falls away to the west-south-west.
    expect(mine.aspectDeg[centre]).toBeCloseTo(180 + (Math.atan2(0.1, 0.05) * 180) / Math.PI, 2);
  });
});

/**
 * Curvature is a second difference, and it is the one derivative a float32
 * elevation struggles to carry at altitude: at 2,000 m the gap between
 * neighbouring float32 values is 0.12 mm, while 1/R over a metre pixel is
 * 2 mm. These surfaces therefore sit near the datum, where the analytic answer
 * survives being stored. Real terrain has no such luxury, which is why
 * curvature is reported in 1/m and not to more figures than it has.
 */
describe("curvature, against surfaces whose curvature is known", () => {
  const R = 500;

  test("a dome of radius R is +1/R, convex, in all three measures", () => {
    const grid = syntheticGrid(61, 61, function (x, y) {
      return -((x - 305) * (x - 305) + (y - 305) * (y - 305)) / (2 * R);
    }, 10);
    const cv = derive.curvature(grid);
    // Off the summit, where there is a slope for profile and plan to be along
    // and across. A paraboloid's second derivatives are constant, so this is
    // exact rather than approximate.
    const col = 40;
    const row = 30;
    expect(at(grid, cv.total, col, row)).toBeCloseTo(2 / R, 6);
    expect(at(grid, cv.profile, col, row)).toBeCloseTo(1 / R, 6);
    expect(at(grid, cv.plan, col, row)).toBeCloseTo(1 / R, 6);
  });

  test("a bowl is the same magnitudes with the sign flipped", () => {
    const grid = syntheticGrid(61, 61, function (x, y) {
      return ((x - 305) * (x - 305) + (y - 305) * (y - 305)) / (2 * R);
    }, 10);
    const cv = derive.curvature(grid);
    expect(at(grid, cv.total, 40, 30)).toBeCloseTo(-2 / R, 6);
    expect(at(grid, cv.profile, 40, 30)).toBeCloseTo(-1 / R, 6);
    expect(at(grid, cv.plan, 40, 30)).toBeCloseTo(-1 / R, 6);
  });

  test("a ridge running north-south is convex along the slope and straight across it", () => {
    const grid = syntheticGrid(61, 61, function (x) {
      return -((x - 305) * (x - 305)) / (2 * R);
    }, 10);
    const cv = derive.curvature(grid);
    expect(at(grid, cv.profile, 40, 30)).toBeCloseTo(1 / R, 6);
    expect(at(grid, cv.plan, 40, 30)).toBeCloseTo(0, 9);
    expect(at(grid, cv.total, 40, 30)).toBeCloseTo(1 / R, 6);
  });

  test("a plane has no curvature and no along-slope direction to be curved in", () => {
    const grid = syntheticGrid(21, 21, function (x, y) { return 0.02 * x + 0.01 * y; }, 10);
    const cv = derive.curvature(grid);
    expect(at(grid, cv.total, 10, 10)).toBeCloseTo(0, 7);
    expect(at(grid, cv.profile, 10, 10)).toBeCloseTo(0, 7);
    expect(at(grid, cv.plan, 10, 10)).toBeCloseTo(0, 7);
  });

  test("flat ground has a total curvature but no profile or plan curvature", () => {
    const grid = syntheticGrid(21, 21, function () { return 1000; });
    const cv = derive.curvature(grid);
    expect(at(grid, cv.total, 10, 10)).toBeCloseTo(0, 12);
    expect(at(grid, cv.profile, 10, 10)).toBeNaN();
    expect(at(grid, cv.plan, 10, 10)).toBeNaN();
  });
});

describe("sheltering, against topocalc's horizon angles", () => {
  /**
   * The gap left open when the derivatives landed: Sx had no reference but our
   * own trigonometry. With the search distance run out to the edge of the
   * domain, Sx *is* the horizon angle — a classical quantity with third-party
   * implementations. topocalc (USDA-ARS-NWRC, CC0) computes Dozier & Frew's,
   * and `tools/horizon-reference.py` writes its answers into the fixture this
   * reads. topocalc is not installed in CI; the fixture is committed and the
   * regeneration command is in the tool's header.
   *
   * Only the four cardinal bearings: along a row or a column both methods land
   * on the pixel centres, so nothing is left in the difference but the formula.
   * topocalc reaches the diagonals by skewing and interpolating the raster,
   * which would compare one interpolation against a different one.
   */
  const meta = JSON.parse(fixture("horizon-reference.json").toString("utf8"));
  const dem = fixture("horizon-bowl.dem.f32");
  // Straddling the central meridian, where grid north *is* true north.
  // topocalc walks the raster's own rows and columns and has no notion of
  // convergence, so anywhere else the two are looking in different directions
  // — by 0.003 deg here, which is a millimetre of drift per metre travelled and
  // still enough to move the horizon on ground this smooth.
  const grid = syntheticGridFrom(
    new Float32Array(dem.buffer.slice(dem.byteOffset, dem.byteOffset + dem.length)),
    meta.width, meta.height, meta.spacingM, 500000 - (meta.width * meta.spacingM) / 2
  );
  // 900 m runs every ray off the 810 m domain, which is what makes it a
  // horizon rather than a search within a radius; 10 m steps land on the pixel
  // centres topocalc reads.
  const sx = derive.shelter(grid, {
    sectors: [0, 90, 180, 270], maxDistanceM: 900, stepM: meta.spacingM
  });

  const NAMES = { 0: "north", 90: "east", 180: "south", 270: "west" };

  test("the rays run down the rows and columns, as topocalc's do", () => {
    expect(derive.gridConvergenceDeg(grid)).toBeCloseTo(0, 9);
  });

  for (const sector of sx.sectors) {
    test("looking " + NAMES[sector.centreDeg] + ", every angle is topocalc's", () => {
      const raw = fixture("horizon-bowl." + NAMES[sector.centreDeg] + ".f32");
      const theirs = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
      let worst = 0;
      let compared = 0;
      for (let row = 1; row < meta.height - 1; row++) {
        for (let col = 1; col < meta.width - 1; col++) {
          const i = row * meta.width + col;
          // Ours reports a falling horizon as a negative angle; topocalc floors
          // it at zero, because a cell that sees nothing above it has its own
          // pixel as its horizon. Clamp before comparing rather than after.
          const mine = Math.max(0, sector.sx[i]);
          worst = Math.max(worst, Math.abs(mine - theirs[i]));
          compared++;
        }
      }
      expect(compared).toBe((meta.width - 2) * (meta.height - 2));
      // 1e-4 deg. Both march the same pixel centres; the difference is that
      // theirs works in float32 and takes an arccosine where we take an
      // arctangent.
      expect(worst).toBeLessThan(1e-4);
    });
  }

  test("and the domain really does have something to hide behind", () => {
    // A reference that is zero everywhere would agree with anything.
    const north = sx.sectors[0].sx;
    let above = 0;
    for (let i = 0; i < north.length; i++) if (north[i] > 5) above++;
    expect(above).toBeGreaterThan(500);
  });
});

describe("sheltering", () => {
  /** Flat ground with a wall `height` m tall, `distance` m to the north. */
  function walledGrid(height, distance) {
    return syntheticGrid(81, 161, function (x, y) {
      return y >= 80 + distance ? 1000 + height : 1000;
    });
  }

  test("Sx looking at a wall is the angle to the top of it", () => {
    const grid = walledGrid(20, 40);
    const sx = derive.shelter(grid, { sectors: [0, 90, 180, 270], maxDistanceM: 100, stepM: 1 });
    const north = sx.sectors[0].sx;
    const south = sx.sectors[2].sx;
    const east = sx.sectors[1].sx;
    const col = 40;
    const row = grid.height - 81;   // the cell 40 m south of the wall

    expect(at(grid, north, col, row)).toBeCloseTo((Math.atan2(20, 40) * 180) / Math.PI, 1);
    // Looking away from it there is nothing above the horizontal: exposed.
    expect(at(grid, south, col, row)).toBeLessThan(0.01);
    expect(at(grid, east, col, row)).toBeCloseTo(0, 6);
  });

  test("a closer wall shelters more, and a taller one shelters more", () => {
    const near = derive.shelter(walledGrid(20, 20), { sectors: [0], maxDistanceM: 100, stepM: 1 });
    const far = derive.shelter(walledGrid(20, 60), { sectors: [0], maxDistanceM: 100, stepM: 1 });
    const tall = derive.shelter(walledGrid(60, 60), { sectors: [0], maxDistanceM: 100, stepM: 1 });
    const grid = walledGrid(20, 20);
    const col = 40;
    const row = grid.height - 81;

    expect(at(grid, near.sectors[0].sx, col, row)).toBeGreaterThan(at(grid, far.sectors[0].sx, col, row));
    expect(at(grid, tall.sectors[0].sx, col, row)).toBeGreaterThan(at(grid, far.sectors[0].sx, col, row));
  });

  test("a wall beyond the search distance is not seen at all", () => {
    const grid = walledGrid(20, 60);
    const sx = derive.shelter(grid, { sectors: [0], maxDistanceM: 30, stepM: 1 });
    expect(at(grid, sx.sectors[0].sx, 40, grid.height - 81)).toBeCloseTo(0, 6);
  });

  test("a summit is exposed from every direction and a hollow is sheltered from every direction", () => {
    // Summit on a pixel centre, not between four of them: a dome centred half a
    // pixel off has a cell exactly as high as the summit due south of it, and
    // reports an honest Sx of zero from that one direction.
    const dome = syntheticGrid(81, 81, function (x, y) {
      return 2000 - ((x - 40.5) * (x - 40.5) + (y - 40.5) * (y - 40.5)) / 200;
    });
    const bowl = syntheticGrid(81, 81, function (x, y) {
      return 2000 + ((x - 40.5) * (x - 40.5) + (y - 40.5) * (y - 40.5)) / 200;
    });
    const opts = { sectors: 8, maxDistanceM: 20, stepM: 1 };
    derive.shelter(dome, opts).sectors.forEach(function (s) {
      expect(at(dome, s.sx, 40, 40)).toBeLessThan(0);
    });
    derive.shelter(bowl, opts).sectors.forEach(function (s) {
      expect(at(bowl, s.sx, 40, 40)).toBeGreaterThan(0);
    });
  });

  test("a pixel whose ray leaves the grid is unknown, not exposed", () => {
    const grid = syntheticGrid(21, 21, function () { return 1000; });
    const sx = derive.shelter(grid, { sectors: [0], maxDistanceM: 10, stepM: 5 });
    // The row below the top: the first sample north is already off the grid, so
    // the horizon there is unknown. Calling it zero would report open sky.
    expect(at(grid, sx.sectors[0].sx, 10, 1)).toBeNaN();
    expect(at(grid, sx.sectors[0].sx, 10, 19)).toBeCloseTo(0, 6);
  });

  test("sixteen sectors are the default and they run clockwise from north", () => {
    const grid = syntheticGrid(21, 21, function () { return 1000; });
    const sx = derive.shelter(grid, { maxDistanceM: 5, stepM: 1 });
    expect(sx.sectors.length).toBe(16);
    expect(sx.sectors.map(function (s) { return s.centreDeg; })[1]).toBe(22.5);
    expect(sx.stepM).toBe(1);
    expect(sx.steps).toBe(5);
  });

  test("bearings are true north, so a grid off the central meridian is rotated onto its own north", () => {
    const grid = syntheticGrid(41, 41, function () { return 1000; });
    grid.transform.originX = 300000;    // 200 km west of the central meridian
    grid.bounds = cog.gridBounds(grid);
    const convergence = derive.gridConvergenceDeg(grid);
    expect(Math.abs(convergence)).toBeGreaterThan(0.5);
    expect(Math.abs(convergence)).toBeLessThan(3);
    expect(derive.shelter(grid, { sectors: [0], maxDistanceM: 5, stepM: 1 }).convergenceDeg)
      .toBeCloseTo(convergence, 9);
  });

  test("a geographic grid has no convergence to remove", () => {
    expect(derive.gridConvergenceDeg(gridOf("cog-lzw-p3"))).toBe(0);
  });
});

describe("derive", () => {
  const grid = gridOf("cog-utm13-1m");

  test("carries the geometry, the fields and how much of it is undefined", () => {
    const derived = derive.derive(grid);
    expect(Object.keys(derived.fields).sort()).toEqual([
      "aspectDeg", "dzdx", "dzdy", "planCurvature", "profileCurvature",
      "relief", "slopeDeg", "totalCurvature", "tpi", "tri"
    ]);
    expect(derived.width).toBe(grid.width);
    expect(derived.spacingM.x).toBeCloseTo(1, 6);
    expect(derived.spacingM.y).toBeCloseTo(1, 6);
    expect(derived.shelter).toBeNull();
    // Only the one-pixel border is undefined in a fixture with no holes.
    const border = grid.width * grid.height - (grid.width - 2) * (grid.height - 2);
    expect(derived.undefinedFraction).toBeCloseTo(border / (grid.width * grid.height), 9);
  });

  test("computes sheltering only when asked", () => {
    const derived = derive.derive(grid, { shelter: { sectors: 4, maxDistanceM: 20 } });
    expect(derived.shelter.sectors.length).toBe(4);
    expect(derived.shelter.maxDistanceM).toBe(20);
  });

  test("refuses a grid too small for a 3 x 3 neighbourhood rather than inventing a border", () => {
    const tiny = syntheticGrid(2, 2, function () { return 1000; });
    expect(() => derive.derive(tiny)).toThrow(/3 x 3/);
    expect(() => derive.derive(tiny)).toThrow(expect.objectContaining({ code: "grid-too-small" }));
  });

  test("refuses a spacing that is not a positive number of metres", () => {
    expect(() => derive.slopeAspect(grid, { spacingM: { x: 0, y: 1 } }))
      .toThrow(expect.objectContaining({ code: "bad-spacing" }));
  });

  test("refuses a sheltering distance of nothing", () => {
    expect(() => derive.shelter(grid, { maxDistanceM: 0 }))
      .toThrow(expect.objectContaining({ code: "bad-distance" }));
    expect(() => derive.shelter(grid, { sectors: [] }))
      .toThrow(expect.objectContaining({ code: "bad-sectors" }));
  });
});

describe("sampling a derived domain", () => {
  const grid = gridOf("cog-utm13-1m");
  const derived = derive.derive(grid, { shelter: { sectors: 4, maxDistanceM: 20, stepM: 1 } });
  const centre = {
    lat: (grid.bounds.south + grid.bounds.north) / 2,
    lon: (grid.bounds.west + grid.bounds.east) / 2
  };

  test("a field is sampled by coordinate, and refused outside the domain", () => {
    const slope = derive.fieldAt(derived, "slopeDeg", centre.lat, centre.lon);
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeLessThan(90);
    expect(derive.fieldAt(derived, "slopeDeg", centre.lat + 1, centre.lon)).toBeNull();
    expect(() => derive.fieldAt(derived, "nope", centre.lat, centre.lon))
      .toThrow(expect.objectContaining({ code: "no-such-field" }));
  });

  test("aspect is refused by the ordinary sampler, because interpolating a bearing is wrong", () => {
    expect(() => derive.fieldAt(derived, "aspectDeg", centre.lat, centre.lon))
      .toThrow(expect.objectContaining({ code: "circular-field" }));
  });

  test("aspectAt goes through the gradient, so 350 and 10 average to 0 rather than 180", () => {
    // A gentle spur falling north, with a crest running down it: the ground
    // west of the crest faces 010 and the ground east of it faces 350.
    const spur = syntheticGrid(21, 21, function (x, y) {
      return 0.1 * (20 - y) + 0.0176 * Math.abs(x - 10.5);
    });
    const v = derive.derive(spur);
    expect(at(spur, v.fields.aspectDeg, 12, 10)).toBeCloseTo(350, 0);
    expect(at(spur, v.fields.aspectDeg, 8, 10)).toBeCloseTo(10, 0);
    // Averaging those two as numbers gives 180 — due south, the one direction
    // the ground certainly does not face.
    const naive = (at(spur, v.fields.aspectDeg, 12, 10) + at(spur, v.fields.aspectDeg, 8, 10)) / 2;
    expect(naive).toBeCloseTo(180, 0);

    const crest = proj.toGeographic(spur.crs,
      spur.transform.originX + 10.5 * spur.transform.scaleX,
      spur.transform.originY + 10.5 * spur.transform.scaleY);
    const b = derive.aspectAt(v, crest.lat, crest.lon);
    expect(Math.min(b, 360 - b)).toBeLessThan(1);

    const flat = derive.derive(syntheticGrid(21, 21, function () { return 1000; }));
    expect(derive.aspectAt(flat, (flat.bounds.south + flat.bounds.north) / 2,
      (flat.bounds.west + flat.bounds.east) / 2)).toBeNull();
  });

  test("shelter is blended between sectors rather than snapped to one", () => {
    const between = derive.shelterAt(derived, centre.lat, centre.lon, 45);
    const lower = derive.shelterAt(derived, centre.lat, centre.lon, 0);
    const upper = derive.shelterAt(derived, centre.lat, centre.lon, 90);
    expect(between).toBeCloseTo((lower + upper) / 2, 5);
    // No step as the wind backs through a sector boundary.
    const just = derive.shelterAt(derived, centre.lat, centre.lon, 89.999);
    expect(Math.abs(just - upper)).toBeLessThan(1e-3);
    expect(derive.shelterAt(derived, centre.lat, centre.lon, -270)).toBeCloseTo(upper, 9);
  });

  test("sectors given by hand are put in order, and blended across the uneven gaps", () => {
    // Three centres, unevenly spaced and out of order: the ones a caller picks
    // for a valley with two mouths rather than a compass rose.
    const odd = derive.derive(grid, {
      shelter: { sectors: [200, 10, 90], maxDistanceM: 20, stepM: 1 }
    });
    expect(odd.shelter.sectors.map((s) => s.centreDeg)).toEqual([10, 90, 200]);

    const sx = (deg) => derive.shelterAt(odd, centre.lat, centre.lon, deg);
    // Halfway through the 110-degree gap is the mean of its two ends, and the
    // wrap from 200 back round to 010 is a gap like any other.
    expect(sx(145)).toBeCloseTo((sx(90) + sx(200)) / 2, 5);
    expect(sx(285)).toBeCloseTo((sx(200) + sx(10)) / 2, 5);
    expect(sx(10)).toBeCloseTo(derive.fieldAt(
      Object.assign({}, odd, { fields: { sx: odd.shelter.sectors[0].sx } }), "sx", centre.lat, centre.lon), 9);
  });

  test("asking for shelter that was never computed says so", () => {
    const bare = derive.derive(grid);
    expect(() => derive.shelterAt(bare, centre.lat, centre.lon, 0))
      .toThrow(expect.objectContaining({ code: "no-shelter" }));
  });

  test("valueAt falls through to whichever domain has ground there", () => {
    const void1 = derive.derive({
      crs: grid.crs,
      width: grid.width,
      height: grid.height,
      values: new Float32Array(grid.width * grid.height).fill(NaN),
      transform: grid.transform,
      bounds: grid.bounds
    });
    expect(derive.valueAt([void1], "slopeDeg", centre.lat, centre.lon)).toBeNull();
    expect(derive.valueAt([void1, derived], "slopeDeg", centre.lat, centre.lon))
      .toBeCloseTo(derive.fieldAt(derived, "slopeDeg", centre.lat, centre.lon), 9);
    expect(derive.valueAt([void1, derived], "aspectDeg", centre.lat, centre.lon))
      .toBeCloseTo(derive.aspectAt(derived, centre.lat, centre.lon), 9);
  });

  test("deriveAll keeps the order readTerrain put the grids in", () => {
    const all = derive.deriveAll([grid, grid]);
    expect(all.length).toBe(2);
    expect(all[0].width).toBe(grid.width);
  });
});

describe("where a point sits in the landform around it", () => {
  /**
   * A 2 km ridge, 100 m from crest to floor, on a 20 m grid.
   *
   * The point of the fixture is that the crest and the floor are 500 m apart:
   * a 3 x 3 index at 20 m spacing sees a smooth surface and reads ~0 at both,
   * which is exactly the failure this function exists to fix.
   */
  function ridge(step) {
    const n = 101;
    return syntheticGrid(n, n, function (east) {
      const from = Math.abs(east - (n * step) / 2);
      return 2000 + 100 * Math.cos(Math.min(from / 500, 1) * Math.PI) / 2;
    }, step);
  }

  function atPixel(grid, col, row) {
    return proj.toGeographic(grid.crs,
      grid.transform.originX + (col + 0.5) * grid.transform.scaleX,
      grid.transform.originY + (row + 0.5) * grid.transform.scaleY);
  }

  test("a 3 x 3 index cannot see a landform, and a 500 m one can", () => {
    const grid = ridge(20);
    const derived = derive.derive(grid);
    const crest = atPixel(grid, 50, 50);
    const floor = atPixel(grid, 30, 50);

    // What the neighbourhood index reads at both: nothing worth a threshold.
    expect(Math.abs(derive.fieldAt(derived, "tpi", crest.lat, crest.lon))).toBeLessThan(0.5);
    expect(Math.abs(derive.fieldAt(derived, "tpi", floor.lat, floor.lon))).toBeLessThan(0.5);

    const onCrest = derive.positionIndexAt(derived, crest.lat, crest.lon, { radiusM: 500 });
    const inFloor = derive.positionIndexAt(derived, floor.lat, floor.lon, { radiusM: 500 });
    expect(onCrest.tpiM).toBeGreaterThan(20);
    expect(inFloor.tpiM).toBeLessThan(-20);
    expect(onCrest.radiusM).toBe(500);
  });

  test("the scale is the answer's, not the caller's memory of it", () => {
    const grid = ridge(20);
    const derived = derive.derive(grid);
    const crest = atPixel(grid, 50, 50);
    const near = derive.positionIndexAt(derived, crest.lat, crest.lon, { radiusM: 100 });
    const far = derive.positionIndexAt(derived, crest.lat, crest.lon, { radiusM: 500 });
    expect(near.tpiM).toBeLessThan(far.tpiM);
    expect(near.radiusM).toBe(100);
    expect(far.samples).toBeGreaterThan(near.samples);
  });

  test("a disc that runs off the domain is refused rather than half-measured", () => {
    // Half a disc over a hillside averages the half that is there, which reads
    // as a slope position the ground does not have.
    const grid = ridge(20);
    const derived = derive.derive(grid);
    const edge = atPixel(grid, 2, 50);
    expect(derive.positionIndexAt(derived, edge.lat, edge.lon, { radiusM: 500 })).toBeNull();
    expect(derive.positionIndexAt(derived, edge.lat + 1, edge.lon, { radiusM: 100 })).toBeNull();
  });

  test("a disc mostly in a void is refused, and a few missing pixels are not", () => {
    const grid = ridge(20);
    const holed = derive.derive(syntheticGridFrom(
      Float32Array.from(grid.values, function (z, i) {
        return i % 97 === 0 ? NaN : z;
      }), grid.width, grid.height, 20));
    const voided = derive.derive(syntheticGridFrom(
      Float32Array.from(grid.values, function (z, i) {
        return i % 3 === 0 ? z : NaN;
      }), grid.width, grid.height, 20));
    const crest = atPixel(grid, 50, 50);

    const patchy = derive.positionIndexAt(holed, crest.lat, crest.lon, { radiusM: 500 });
    expect(patchy.coverage).toBeGreaterThan(0.98);
    expect(patchy.tpiM).toBeGreaterThan(20);
    expect(derive.positionIndexAt(voided, crest.lat, crest.lon, { radiusM: 500 })).toBeNull();
  });

  test("a radius has to be a distance", () => {
    const derived = derive.derive(ridge(20));
    const crest = atPixel(ridge(20), 50, 50);
    expect(() => derive.positionIndexAt(derived, crest.lat, crest.lon, { radiusM: 0 }))
      .toThrow(expect.objectContaining({ code: "bad-radius" }));
  });
});
