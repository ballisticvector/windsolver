/**
 * The terrain a coarse model could not have seen.
 *
 * `smooth` is a disc mean and `anomaly` is a subtraction, so both are graded
 * against fields whose answer is known in closed form rather than against a
 * previous run of themselves:
 *
 *   a plane            a symmetric disc mean of a linear field is the value at
 *                      the centre of the disc, so smoothing a plane returns the
 *                      plane and its anomaly is zero everywhere
 *   a cone             a disc mean over a summit is below the summit and above
 *                      the ground around it, so the anomaly keeps the peak and
 *                      loses the mountain it stands on
 *   a void             a hole stays a hole: neither function invents ground,
 *                      on either side of the subtraction
 *
 * The last one is the one worth keeping. An anomaly is a difference of two
 * elevations, and a difference is where a nodata sentinel that survived as a
 * number turns into terrain that looks entirely ordinary.
 */

"use strict";

const cog = require("../cog.js");
const derive = require("../derive.js");
const proj = require("../proj.js");

/** A projected grid with a metre pixel, so a radius in metres is a radius in pixels. */
function grid(values, width, height, step) {
  const g = {
    crs: proj.crsFromEpsg(26913),
    width: width,
    height: height,
    values: values,
    transform: {
      originX: 500000,
      originY: 4400000 + height * step,
      scaleX: step,
      scaleY: -step
    },
    resolutionM: step
  };
  g.bounds = cog.gridBounds(g);
  return g;
}

function build(width, height, step, f) {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = f(col, row);
    }
  }
  return grid(values, width, height, step);
}

function at(g, col, row) {
  return g.values[row * g.width + col];
}

describe("smooth: the surface a coarse model would have", () => {
  test("a disc mean of a plane is the plane, and the edges are void rather than wrong", () => {
    // 1 m pixels, 30 m radius: the disc fits everywhere except within 30 px of
    // an edge, and a partial disc is a lopsided mean, which is a slope that is
    // not there. Those cells are NaN and not "the best we could do".
    const plane = build(101, 101, 1, function (col, row) { return 3 * col - 2 * row + 1000; });
    const smooth = derive.smooth(plane, { radiusM: 30 });

    expect(smooth.width).toBe(plane.width);
    expect(smooth.height).toBe(plane.height);
    expect(smooth.transform).toEqual(plane.transform);
    expect(at(smooth, 50, 50)).toBeCloseTo(at(plane, 50, 50), 3);
    expect(at(smooth, 35, 70)).toBeCloseTo(at(plane, 35, 70), 3);
    expect(Number.isNaN(at(smooth, 5, 50))).toBe(true);
    expect(Number.isNaN(at(smooth, 50, 100))).toBe(true);
  });

  test("a summit is flattened towards the ground around it", () => {
    const cone = build(101, 101, 1, function (col, row) {
      const r = Math.hypot(col - 50, row - 50);
      return 2000 + Math.max(0, 20 - r);
    });
    const smooth = derive.smooth(cone, { radiusM: 30 });

    expect(at(cone, 50, 50)).toBeCloseTo(2020, 3);
    // The mean of the cone over a 30 m disc: the peak survives as a few metres
    // rather than twenty, which is the whole point of subtracting it.
    expect(at(smooth, 50, 50)).toBeGreaterThan(2000);
    expect(at(smooth, 50, 50)).toBeLessThan(2006);
  });

  test("a void is not averaged over: below the coverage floor the answer is NaN", () => {
    const holed = build(81, 81, 1, function (col, row) {
      return col > 40 && row > 40 ? NaN : 1500;
    });
    const smooth = derive.smooth(holed, { radiusM: 20, minCoverage: 0.9 });

    expect(Number.isNaN(at(smooth, 45, 45))).toBe(true);
    expect(at(smooth, 20, 20)).toBeCloseTo(1500, 3);
  });

  test("a radius that is not a positive distance is refused", () => {
    const flat = build(21, 21, 1, function () { return 100; });
    expect(() => derive.smooth(flat, { radiusM: 0 })).toThrow(/positive/);
    expect(() => derive.smooth(flat, {})).toThrow(/radiusM/);
  });
});

describe("anomaly: the ground minus the ground the model already has", () => {
  test("subtracting a surface that matches leaves nothing to correct", () => {
    const plane = build(41, 41, 10, function (col, row) { return 5 * col - 3 * row + 2000; });
    const anomaly = derive.anomaly(plane, plane);

    for (let i = 0; i < anomaly.values.length; i++) {
      expect(anomaly.values[i]).toBeCloseTo(0, 3);
    }
  });

  test("a coarse reference is sampled where each fine cell is, not cell for cell", () => {
    // The reference is a quarter the resolution and twice the extent, so a
    // reader that indexed it by the fine grid's own row and column would be
    // reading the wrong ground and would still return a number.
    const fine = build(41, 41, 10, function (col, row) { return 5 * col - 3 * row + 2000; });
    const coarse = {
      crs: fine.crs,
      width: 21,
      height: 21,
      values: new Float32Array(21 * 21),
      transform: {
        originX: fine.transform.originX - 200,
        originY: fine.transform.originY + 200,
        scaleX: 40,
        scaleY: -40
      }
    };
    for (let row = 0; row < 21; row++) {
      for (let col = 0; col < 21; col++) {
        // The same plane, written on the coarse grid's own geometry.
        const x = coarse.transform.originX + (col + 0.5) * 40;
        const y = coarse.transform.originY + (row + 0.5) * -40;
        const fx = (x - fine.transform.originX) / 10 - 0.5;
        const fy = (y - fine.transform.originY) / -10 - 0.5;
        coarse.values[row * 21 + col] = 5 * fx - 3 * fy + 2000;
      }
    }
    coarse.bounds = cog.gridBounds(coarse);

    const anomaly = derive.anomaly(fine, coarse);
    expect(at(anomaly, 20, 20)).toBeCloseTo(0, 2);
    expect(at(anomaly, 5, 33)).toBeCloseTo(0, 2);
  });

  test("a hole on either side stays a hole", () => {
    const fine = build(21, 21, 10, function (col, row) {
      return col === 10 && row === 10 ? NaN : 1200;
    });
    const reference = build(21, 21, 10, function (col, row) {
      return col === 3 && row === 3 ? NaN : 1000;
    });
    const anomaly = derive.anomaly(fine, reference);

    expect(Number.isNaN(at(anomaly, 10, 10))).toBe(true);
    expect(Number.isNaN(at(anomaly, 3, 3))).toBe(true);
    expect(at(anomaly, 15, 15)).toBeCloseTo(200, 3);
  });

  test("ground the reference does not cover is void, not uncorrected", () => {
    // Off the reference entirely. Returning the fine elevation unchanged would
    // be a cell whose correction is the full landform while its neighbours'
    // is the residual, and the seam between them is a cliff that is not there.
    const fine = build(21, 21, 10, function () { return 1200; });
    const reference = build(3, 3, 10, function () { return 1000; });
    const anomaly = derive.anomaly(fine, reference);

    expect(Number.isNaN(at(anomaly, 20, 20))).toBe(true);
  });

  test("the anomaly of a hill on a slope keeps the hill and loses the slope", () => {
    // The measurable claim behind the whole experiment: what reaches the
    // downscaling is the landform a 3 km model could not resolve, and not the
    // mountainside it stands on, which the model has already.
    const step = 50;
    const width = 121;
    const hillOnSlope = build(width, width, step, function (col, row) {
      const r = Math.hypot(col - 60, row - 60) * step;
      return 2000 + 0.2 * col * step + 60 * Math.exp(-(r * r) / (2 * 300 * 300));
    });
    const smooth = derive.smooth(hillOnSlope, { radiusM: 1500 });
    const anomaly = derive.anomaly(hillOnSlope, smooth);

    const regional = derive.slopeAspect(hillOnSlope);
    const residual = derive.slopeAspect(anomaly);
    // 1,250 m from the summit and well inside the band where the disc fits.
    const off = 60 * width + 85;

    // Away from the hill the ground is a 0.2 gradient and the anomaly is flat.
    expect(regional.slopeDeg[off]).toBeCloseTo((Math.atan(0.2) * 180) / Math.PI, 1);
    expect(residual.slopeDeg[off]).toBeLessThan(1);

    // On the hill's flank, one sigma out, the anomaly still has a hill.
    const flank = 60 * width + 66;
    expect(residual.slopeDeg[flank]).toBeGreaterThan(1);
  });
});
