/**
 * Graded against a second implementation, and against geometry where the
 * answer is known without one.
 *
 * A downscaled wind field is the hardest thing in this repository to check by
 * looking at it: every value is a plausible wind, the pattern looks like
 * terrain whichever way the signs go, and a field computed with the wind
 * direction reversed is still fast on *a* hillside. So:
 *
 *   the MicroMet chain      graded cell by cell against
 *                           `tools/micromet-reference.py`, a numpy
 *                           implementation written from Liston & Elder's
 *                           equations rather than from this code
 *   sheltering              graded against topocalc's horizon angles — a
 *                           third-party implementation of Dozier & Frew — see
 *                           `tests/derive.test.js`
 *   the signs               graded against a hill: fast on the windward face
 *                           and the crest, slow in the lee, turned downslope
 *
 * The reference DEMs are committed and read by both sides, so nothing here
 * depends on two generators agreeing about where a pixel centre is.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const proj = require("../proj.js");

const FIXTURES = path.join(__dirname, "fixtures");
const REFERENCE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "micromet-reference.json"), "utf8"));

function f32(name) {
  const raw = fs.readFileSync(path.join(FIXTURES, name));
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}

/** A projected grid on the central meridian, so grid north is true north. */
function gridFrom(values, width, height, spacing) {
  const grid = {
    crs: proj.crsFromEpsg(26913),
    width: width,
    height: height,
    values: values,
    transform: {
      originX: 500000,
      originY: 4400000 + height * spacing,
      scaleX: spacing,
      scaleY: -spacing
    }
  };
  grid.bounds = cog.gridBounds(grid);
  return grid;
}

function syntheticGrid(width, height, z, spacing) {
  const step = spacing || 10;
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = z((col + 0.5) * step, (height - row - 0.5) * step);
    }
  }
  return gridFrom(values, width, height, step);
}

/** Worst disagreement over every cell, with NaN required to line up. */
function compare(mine, theirs, tolerance, circular) {
  let worst = 0;
  let worstAt = -1;
  let maskMismatches = 0;
  let compared = 0;
  for (let i = 0; i < theirs.length; i++) {
    const a = mine[i];
    const b = theirs[i];
    const aNaN = Number.isNaN(a);
    const bNaN = Number.isNaN(b);
    if (aNaN !== bNaN) { maskMismatches++; continue; }
    if (aNaN) continue;
    let d = Math.abs(a - b);
    if (circular) d = Math.min(d, 360 - d);
    if (d > worst) { worst = d; worstAt = i; }
    compared++;
  }
  expect(maskMismatches).toBe(0);
  expect({ worst: worst, at: worstAt }).toMatchObject({ worst: expect.any(Number) });
  if (worst > tolerance) {
    throw new Error("worst disagreement " + worst + " at cell " + worstAt + ", over " + tolerance);
  }
  return { worst: worst, compared: compared, maskMismatches: maskMismatches };
}

function caseNamed(name) {
  const meta = REFERENCE.cases.find(function (c) { return c.name === name; });
  if (!meta) throw new Error("no reference case called " + name);
  const grid = gridFrom(
    f32("micromet-" + name + ".dem.f32"),
    meta.width, meta.height, meta.spacingM
  );
  const weights = downscale.terrainWeights(derive.derive(grid), { curvatureLengthM: meta.curvatureLengthM });
  return {
    meta: meta,
    grid: grid,
    weights: weights,
    field: downscale.downscale(weights, { speedMps: meta.speedMps, fromDeg: meta.fromDeg })
  };
}

describe("the MicroMet chain, against a numpy implementation of the paper", () => {
  // Both sides read the same committed float32 DEM and both work in doubles,
  // so the only thing left in the difference is the reference being stored as
  // float32 — about 1e-7 relative on a number of order one.
  const TOLERANCE = { curvature: 1e-10, factor: 2e-6, fromDeg: 2e-4 };

  for (const meta of REFERENCE.cases) {
    describe(meta.name, () => {
      const c = caseNamed(meta.name);

      test("the curvature at the length scale is theirs", () => {
        const r = compare(
          c.weights.curvature,
          f32("micromet-" + meta.name + ".curvature.f32"),
          TOLERANCE.curvature
        );
        expect(r.compared).toBeGreaterThan(1000);
      });

      test("every weighting factor is theirs", () => {
        const r = compare(c.field.factor, f32("micromet-" + meta.name + ".factor.f32"), TOLERANCE.factor);
        expect(r.compared).toBeGreaterThan(1000);
      });

      test("every diverted wind direction is theirs", () => {
        compare(c.field.fromDeg, f32("micromet-" + meta.name + ".fromDeg.f32"), TOLERANCE.fromDeg, true);
      });

      test("the speed is the factor times the model wind, everywhere", () => {
        // Both are stored as float32, so the check is relative, not absolute.
        let worst = 0;
        for (let i = 0; i < c.field.speedMps.length; i++) {
          if (Number.isNaN(c.field.factor[i])) continue;
          const want = c.field.factor[i] * meta.speedMps;
          worst = Math.max(worst, Math.abs(c.field.speedMps[i] - want) / want);
        }
        expect(worst).toBeLessThan(1e-6);
      });
    });
  }
});

describe("the length scale of the curvature", () => {
  const meta = REFERENCE.cases.find(function (c) { return c.name === "ridge"; });
  const grid = gridFrom(f32("micromet-ridge.dem.f32"), meta.width, meta.height, meta.spacingM);
  const derived = derive.derive(grid);

  test("a 3 x 3 curvature over this ground measures the rocks, not the ridge", () => {
    // The DEM is a 150 m ridge with 1.5 m of metre-scale roughness on it. The
    // pixel-scale curvature is dominated by the roughness and changes sign
    // between neighbours; the 300 m one is smooth and positive along the crest.
    // This is why `downscale` computes its own rather than reusing
    // `derive.curvature`, and it is the single easiest way to ship a wind field
    // that is noisy at a scale nobody can feel.
    const pixel = derived.fields.totalCurvature;
    const scaled = downscale.terrainWeights(derived, { curvatureLengthM: 300 }).curvature;

    const crest = [];
    const row = Math.floor(meta.height / 2);
    for (let x = 30; x < 50; x++) {
      crest.push({ pixel: pixel[row * meta.width + x], scaled: scaled[row * meta.width + x] });
    }
    const signChanges = function (key) {
      let n = 0;
      for (let i = 1; i < crest.length; i++) {
        if (Math.sign(crest[i][key]) !== Math.sign(crest[i - 1][key])) n++;
      }
      return n;
    };
    expect(signChanges("pixel")).toBeGreaterThan(3);
    expect(signChanges("scaled")).toBe(0);
    expect(crest.every(function (c) { return c.scaled > 0; })).toBe(true);
  });

  test("the whole rose has to be on the grid, so the margin is the length scale", () => {
    const weights = downscale.terrainWeights(derived, { curvatureLengthM: 300 });
    const margin = Math.round(150 / meta.spacingM);
    expect(Number.isNaN(weights.curvature[0])).toBe(true);
    expect(Number.isNaN(weights.curvature[(margin - 1) * meta.width + margin - 1])).toBe(true);
    expect(Number.isNaN(weights.curvature[margin * meta.width + margin])).toBe(false);
  });
});

describe("the signs, on a hill whose answer is obvious", () => {
  // A ridge running north-south: ground rises to the middle column and falls
  // away either side, with the wind out of the west.
  const width = 61;
  const height = 61;
  const spacing = 10;
  const centre = (width * spacing) / 2;
  const grid = syntheticGrid(width, height, function (east) {
    return 100 * Math.exp(-((east - centre) ** 2) / (2 * 100 * 100));
  }, spacing);
  const derived = derive.derive(grid, { shelter: { sectors: 8, maxDistanceM: 200, stepM: 10 } });
  const weights = downscale.terrainWeights(derived, { curvatureLengthM: 120 });
  const field = downscale.downscale(weights, { speedMps: 10, fromDeg: 270 }, { shelter: false });
  // Obliquely across the ridge, because a wind blowing straight up the fall
  // line has nowhere to be diverted to: sin(2(aspect - theta)) is zero there.
  const oblique = downscale.downscale(weights, { speedMps: 10, fromDeg: 225 }, { shelter: false });

  const row = Math.floor(height / 2);
  const at = function (values, col) { return values[row * width + col]; };
  const crest = Math.floor(width / 2);

  test("faster on the windward face than in the lee, at the same slope", () => {
    // Mirror-image columns: the same steepness, one facing the wind and one
    // facing away. Nothing but the sign of cos(theta - aspect) separates them.
    const windward = at(field.factor, crest - 8);
    const lee = at(field.factor, crest + 8);
    expect(at(derived.fields.slopeDeg, crest - 8)).toBeCloseTo(at(derived.fields.slopeDeg, crest + 8), 6);
    expect(windward).toBeGreaterThan(lee);
    expect(windward).toBeGreaterThan(1);
    expect(lee).toBeLessThan(1);
  });

  test("fastest at the crest, because the curvature term is convex there", () => {
    expect(at(field.factor, crest)).toBeGreaterThan(at(field.factor, crest - 20));
    expect(at(weights.curvature, crest)).toBeGreaterThan(0);
    expect(at(weights.curvature, crest - 20)).toBeLessThan(0);
  });

  test("the factor stays inside the half to one and a half Liston & Elder bound", () => {
    expect(field.stats.minFactor).toBeGreaterThanOrEqual(0.5);
    expect(field.stats.maxFactor).toBeLessThanOrEqual(1.5);
  });

  test("the wind turns towards the downhill direction across the slope", () => {
    // Wind from due west onto ground that falls away to the west: the
    // diverting term turns it, and turns it the other way on the far face.
    expect(at(oblique.divertDeg, crest - 8)).not.toBeCloseTo(0, 3);
    expect(Math.sign(at(oblique.divertDeg, crest - 8)))
      .toBe(-Math.sign(at(oblique.divertDeg, crest + 8)));
    expect(Math.abs(at(oblique.divertDeg, crest - 8))).toBeLessThan(15);
    // Straight up the fall line there is nothing to divert.
    expect(at(field.divertDeg, crest - 8)).toBeCloseTo(0, 9);
  });

  test("components and bearing describe the same wind", () => {
    const i = row * width + crest - 8;
    const from = (field.fromDeg[i] * Math.PI) / 180;
    expect(field.east[i]).toBeCloseTo(field.speedMps[i] * Math.sin(from + Math.PI), 5);
    expect(field.north[i]).toBeCloseTo(field.speedMps[i] * Math.cos(from + Math.PI), 5);
  });
});

describe("flat ground", () => {
  const grid = syntheticGrid(41, 41, function () { return 1500; }, 10);
  const field = downscale.downscaleDerived(
    derive.derive(grid),
    { speedMps: 7, fromDeg: 45 },
    { curvatureLengthM: 100 }
  );

  test("gives back the model wind, unchanged, rather than nearly unchanged", () => {
    let checked = 0;
    for (let i = 0; i < field.factor.length; i++) {
      if (Number.isNaN(field.factor[i])) continue;
      expect(field.factor[i]).toBe(1);
      expect(field.speedMps[i]).toBe(7);
      expect(field.fromDeg[i]).toBeCloseTo(45, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("and does not divide by a zero range of curvature or slope", () => {
    expect(field.stats.meanFactor).toBe(1);
    expect(Number.isNaN(field.stats.meanFactor)).toBe(false);
  });
});

describe("sheltering as the third term", () => {
  // A wall along the north edge of the domain, with flat ground south of it.
  const width = 61;
  const height = 61;
  const spacing = 10;
  const grid = syntheticGrid(width, height, function (east, north) {
    return north > 480 && north < 520 ? 1540 : 1500;
  }, spacing);
  const derived = derive.derive(grid, { shelter: { sectors: 4, maxDistanceM: 200, stepM: 10 } });
  const weights = downscale.terrainWeights(derived, { curvatureLengthM: 100 });

  // 100 m south of the wall, inside the 200 m search: Sx is about atan(40/100).
  const behind = 20 * width + 30;

  test("a wind off the wall is slower behind it than a wind along the wall", () => {
    const off = downscale.downscale(weights, { speedMps: 10, fromDeg: 0 });
    const along = downscale.downscale(weights, { speedMps: 10, fromDeg: 90 });
    expect(off.speedMps[behind]).toBeLessThan(along.speedMps[behind]);
  });

  test("turning the term off changes the answer, so it is actually applied", () => {
    const on = downscale.downscale(weights, { speedMps: 10, fromDeg: 0 });
    const off = downscale.downscale(weights, { speedMps: 10, fromDeg: 0 }, { shelter: false });
    expect(on.factor[behind]).toBeLessThan(off.factor[behind]);
    expect(on.method.shelter).toBe(true);
    expect(off.method.shelter).toBe(false);
  });

  test("a domain derived without shelter refuses to pretend it has any", () => {
    const bare = downscale.terrainWeights(derive.derive(grid), { curvatureLengthM: 100 });
    expect(bare.shelter).toBeNull();
    expect(() => downscale.downscale(bare, { speedMps: 5, fromDeg: 0 }, { shelter: true }))
      .toThrow(/derived without shelter/);
    expect(downscale.downscale(bare, { speedMps: 5, fromDeg: 0 }).method.shelter).toBe(false);
  });

  test("the sector blend is the one derive.shelterAt uses, so they cannot drift", () => {
    const sectors = derived.shelter.sectors;
    const mid = downscale.bracketSectors(sectors, 45);
    expect(mid.lower.centreDeg).toBe(0);
    expect(mid.upper.centreDeg).toBe(90);
    expect(mid.t).toBeCloseTo(0.5, 9);
    const wrap = downscale.bracketSectors(sectors, 315);
    expect(wrap.lower.centreDeg).toBe(270);
    expect(wrap.upper.centreDeg).toBe(0);
    expect(wrap.t).toBeCloseTo(0.5, 9);
  });
});

describe("the wind that goes in", () => {
  test("a bearing is the direction it comes from, both ways round", () => {
    const west = downscale.readWind({ speedMps: 10, fromDeg: 270 });
    expect(west.east).toBeCloseTo(10, 9);
    expect(west.north).toBeCloseTo(0, 9);

    const north = downscale.readWind({ speedMps: 4, fromDeg: 0 });
    expect(north.east).toBeCloseTo(0, 9);
    expect(north.north).toBeCloseTo(-4, 9);

    expect(downscale.readWind({ east: 10, north: 0 }).fromDeg).toBeCloseTo(270, 9);
    expect(downscale.readWind({ east: 0, north: -4 }).fromDeg).toBeCloseTo(0, 9);
    expect(downscale.readWind({ east: -3, north: -4 }).speedMps).toBeCloseTo(5, 9);
  });

  test("is refused if it is neither shape", () => {
    expect(() => downscale.readWind({ speedMps: 5 })).toThrow(/speedMps, fromDeg/);
    expect(() => downscale.readWind(null)).toThrow(/required/);
    expect(() => downscale.readWind({ speedMps: -1, fromDeg: 0 })).toThrow(/negative/);
  });
});

describe("height above ground", () => {
  test("the log law thins out with height, and is one at its own height", () => {
    expect(downscale.heightFactor(10, 10, 0.03)).toBe(1);
    expect(downscale.heightFactor(10, 80, 0.03)).toBeGreaterThan(1);
    expect(downscale.heightFactor(10, 2, 0.03)).toBeLessThan(1);
    // ln(80/0.03)/ln(10/0.03) = 7.88872/5.80915
    expect(downscale.heightFactor(10, 80, 0.03)).toBeCloseTo(1.35796, 5);
  });

  test("rougher ground shears more, so the same climb buys more wind", () => {
    expect(downscale.heightFactor(10, 80, 0.5)).toBeGreaterThan(downscale.heightFactor(10, 80, 0.001));
  });

  test("refuses a height inside the roughness, where the law says nothing", () => {
    expect(() => downscale.heightFactor(10, 0.01, 0.03)).toThrow(/roughness length/);
    expect(() => downscale.heightFactor(10, 80, 0)).toThrow(/must be positive/);
  });
});

describe("sampling the field", () => {
  const width = 41;
  const height = 41;
  const grid = syntheticGrid(width, height, function (east) { return 1500 + east * 0.1; }, 10);
  const field = downscale.downscaleDerived(
    derive.derive(grid),
    { speedMps: 6, fromDeg: 350 },
    { curvatureLengthM: 100 }
  );
  const centre = { lat: (field.bounds.south + field.bounds.north) / 2, lon: (field.bounds.west + field.bounds.east) / 2 };

  test("a coordinate in the middle gets a wind, and one outside gets null", () => {
    const w = downscale.windAt(field, centre.lat, centre.lon);
    expect(w.speedMps).toBeGreaterThan(0);
    expect(w.fromDeg).toBeGreaterThan(300);
    expect(downscale.windAt(field, centre.lat + 5, centre.lon)).toBeNull();
  });

  test("a bearing near north is not averaged the long way round", () => {
    // Interpolating 350 and 10 as numbers gives 180. Interpolating the
    // components gives 0, which is the wind these two cells describe.
    const w = downscale.windAt(field, centre.lat, centre.lon);
    expect(Math.min(Math.abs(w.fromDeg - 350), Math.abs(w.fromDeg - 360 - 350))).toBeLessThan(20);
  });
});

describe("the model's ground is not the ground", () => {
  const grid = syntheticGrid(21, 21, function (east, north) { return 1500 + (east + north) * 0.2; }, 10);
  const weights = downscale.terrainWeights(derive.derive(grid), { curvatureLengthM: 60 });

  test("the offset between HRRR's terrain and the real terrain is reported, not applied", () => {
    const offset = downscale.terrainOffset(weights, 1600);
    expect(offset.meanM).toBeCloseTo(1500 + 0.2 * 210 - 1600, 6);
    expect(offset.spreadM).toBeCloseTo(0.2 * 2 * 200, 3);
    expect(offset.minM).toBeLessThan(offset.maxM);
    // Nothing in the field changed because of it.
    const field = downscale.downscale(weights, { speedMps: 5, fromDeg: 200 });
    expect(field.reference.speedMps).toBe(5);
  });

  test("refuses to guess the model elevation", () => {
    expect(() => downscale.terrainOffset(weights)).toThrow(/required/);
  });
});

describe("what it refuses", () => {
  const grid = syntheticGrid(21, 21, function (east) { return 1500 + east * 0.05; }, 10);

  test("a domain that is not a derived one", () => {
    expect(() => downscale.terrainWeights({})).toThrow(/derive.derive result/);
    expect(() => downscale.downscale({}, { speedMps: 1, fromDeg: 0 })).toThrow(/terrainWeights result/);
  });

  test("a curvature length that is not a length", () => {
    expect(() => downscale.terrainWeights(derive.derive(grid), { curvatureLengthM: 0 }))
      .toThrow(/must be positive/);
  });

  test("and says which method produced the field it did return", () => {
    const field = downscale.downscaleDerived(derive.derive(grid), { speedMps: 3, fromDeg: 10 }, { curvatureLengthM: 60 });
    expect(field.method).toMatchObject({ name: "micromet", curvatureLengthM: 60, shelter: false });
    expect(field.method.weights).toEqual(downscale.DEFAULT_WEIGHTS);
    expect(field.stats.undefinedFraction).toBeGreaterThan(0);
  });
});
