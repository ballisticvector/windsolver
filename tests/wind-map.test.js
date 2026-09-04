"use strict";

const lib = require("../public/wind-map.js");

/** A small field answer shaped like the one `/v1/field` really returns. */
function answer(overrides) {
  const grid = {
    cols: 3,
    rows: 2,
    order: "row-major, north to south, west to east",
    lats: [40.02, 40.01],
    lons: [-105.28, -105.27, -105.26],
    eastMps: [-3, -3, -3, -3, -3, null],
    northMps: [0, 1, 2, 0, 0, null],
    speedMps: [3, 3.1622776601683795, 3.605551275463989, 3, 3, null],
    fromDeg: [90, 108, 124, 90, 90, null],
    elevationM: [1601, 1650, 1700, 1610, 1620, NaN],
    coveredFraction: 5 / 6
  };
  return Object.assign({
    ok: true,
    schemaVersion: 1,
    domain: { west: -105.28, south: 40.01, east: -105.26, north: 40.02 },
    heightAglM: 10,
    grid: grid,
    validTime: "2026-09-04T18:00:00.000Z",
    source: "WindSolver HRRR 2026-09-04T18:00:00.000Z + 3DEP 1m",
    modelled: true,
    notice: "Modelled, not measured: HRRR downscaled onto 3DEP terrain.",
    reference: { source: "HRRR", resolutionM: 3000, speedMps: 3.5 },
    terrain: { dataset: "1m", resolutionM: 8 },
    confidence: null
  }, overrides || {});
}

describe("speed in the units a person reads", () => {
  test("m/s becomes mph, and a hole stays a hole", () => {
    expect(lib.mph(10)).toBeCloseTo(22.369362920544, 9);
    expect(lib.mph(null)).toBeNull();
    expect(lib.mph(NaN)).toBeNull();
    expect(lib.mph(undefined)).toBeNull();
  });

  test("the colour ramp is monotone in speed and starts at its first stop", () => {
    // A ramp that goes backwards anywhere reads as a wind that drops where it
    // rises, which no viewer would question.
    let previous = -1;
    for (const stop of lib.SPEED_STOPS) {
      expect(stop.mph).toBeGreaterThan(previous);
      previous = stop.mph;
    }
    expect(lib.speedColor(0)).toBe(lib.SPEED_STOPS[0].color);
  });

  test("each stop's colour is the colour just above its boundary", () => {
    for (const stop of lib.SPEED_STOPS) {
      const justAbove = (stop.mph + 0.5) / lib.MPS_TO_MPH;
      expect(lib.speedColor(justAbove)).toBe(stop.color);
    }
  });

  test("a cell with no wind has no colour, rather than the colour of calm", () => {
    // The bug this forbids: an uncovered cell drawn in the 0 mph colour, which
    // is a measurement of calm air over ground nobody has read.
    expect(lib.speedColor(null)).toBeNull();
    expect(lib.speedColor(NaN)).toBeNull();
    expect(lib.speedColor(0)).not.toBeNull();
  });
});

describe("cellsOf", () => {
  test("flattens the grid onto its own coordinates", () => {
    const cells = lib.cellsOf(answer().grid);
    expect(cells).toHaveLength(6);
    expect(cells[0]).toMatchObject({ row: 0, col: 0, lat: 40.02, lon: -105.28, covered: true });
    expect(cells[0].speedMph).toBeCloseTo(6.71, 2);
    expect(cells[2]).toMatchObject({ lat: 40.02, lon: -105.26 });
  });

  test("an uncovered cell is marked uncovered, not zeroed", () => {
    const cells = lib.cellsOf(answer().grid);
    const hole = cells[5];
    expect(hole.covered).toBe(false);
    expect(hole.speedMps).toBeNull();
    expect(hole.fromDeg).toBeNull();
    expect(hole.elevationM).toBeNull();
  });

  test("stride thins the arrows without moving them", () => {
    const cells = lib.cellsOf(answer().grid, { stride: 2 });
    expect(cells.map((c) => [c.row, c.col])).toEqual([[0, 0], [0, 2]]);
    expect(cells[1].lon).toBe(-105.26);
  });

  test("refuses a grid it cannot place on the ground", () => {
    expect(() => lib.cellsOf({ rows: 2, cols: 2 })).toThrow(/lats and lons/);
  });
});

describe("strideFor", () => {
  test("draws every cell when there are few of them", () => {
    expect(lib.strideFor({ rows: 12, cols: 12 }, 400)).toBe(1);
  });

  test("thins a big grid to about the target", () => {
    const stride = lib.strideFor({ rows: 100, cols: 100 }, 400);
    expect(stride).toBe(5);
    const drawn = Math.ceil(100 / stride) * Math.ceil(100 / stride);
    expect(drawn).toBeLessThanOrEqual(400);
  });
});

describe("the ground", () => {
  test("elevationRange ignores the holes", () => {
    expect(lib.elevationRange(answer().grid)).toEqual({ minM: 1601, maxM: 1700 });
  });

  test("all-void ground has no range rather than a range of zero", () => {
    expect(lib.elevationRange({ elevationM: [NaN, null] })).toEqual({ minM: null, maxM: null });
  });
});

describe("centreWind", () => {
  test("reads the covered cell nearest the pin", () => {
    const wind = lib.centreWind(answer().grid);
    expect(wind.speedMph).toBeCloseTo(7.07, 2);
    expect(wind.fromDeg).toBe(108);
    expect(wind.elevationM).toBe(1650);
  });

  test("skips a hole at the centre instead of reporting calm", () => {
    const grid = answer().grid;
    grid.speedMps = [4, null, null, null, null, null];
    grid.fromDeg = [270, null, null, null, null, null];
    const wind = lib.centreWind(grid);
    expect(wind.fromDeg).toBe(270);
    expect(wind.lat).toBe(40.02);
  });

  test("a field with nothing in it has no centre wind", () => {
    const grid = answer().grid;
    grid.speedMps = [null, null, null, null, null, null];
    expect(lib.centreWind(grid)).toBeNull();
  });
});

describe("compassOf", () => {
  test("names the point a caption would use", () => {
    expect(lib.compassOf(0)).toBe("N");
    expect(lib.compassOf(90)).toBe("E");
    expect(lib.compassOf(191.25)).toBe("SSW");
    expect(lib.compassOf(359)).toBe("N");
    expect(lib.compassOf(-90)).toBe("W");
    expect(lib.compassOf(NaN)).toBeNull();
  });
});

describe("summarise", () => {
  test("always carries the source, both resolutions and the notice", () => {
    const s = lib.summarise(answer());
    expect(s.lines.join(" | ")).toContain("WindSolver HRRR");
    expect(s.lines.join(" | ")).toContain("terrain 8 m (3DEP 1m)");
    expect(s.lines.join(" | ")).toContain("weather model 3000 m");
    expect(s.notice).toContain("Modelled, not measured");
    expect(s.modelled).toBe(true);
  });

  test("says the ground it covers and how much of it is missing", () => {
    const joined = lib.summarise(answer()).lines.join(" | ");
    expect(joined).toContain("Ground 1601 to 1700 m");
    expect(joined).toContain("17% of this box has no terrain under it");
  });

  test("a fully covered box says nothing about coverage", () => {
    const body = answer();
    body.grid.coveredFraction = 1;
    expect(lib.summarise(body).lines.join(" | ")).not.toContain("no terrain under it");
  });

  test("a null confidence is reported as unstated, not omitted", () => {
    // Omitting it makes an unknown confidence and a high one look the same.
    expect(lib.summarise(answer()).lines).toContain("Confidence: unstated");
    expect(lib.summarise(answer({ confidence: 0.4 })).lines).toContain("Confidence: 0.4");
  });

  test("refuses to caption an answer that is not one", () => {
    expect(() => lib.summarise({ ok: false })).toThrow(/successful field answer/);
  });
});

describe("explain", () => {
  test("keeps the service's own words and adds what to do", () => {
    const e = lib.explain({
      ok: false,
      code: "timeout",
      error: "the solve did not finish within 45000 ms"
    }, 504);
    expect(e.code).toBe("timeout");
    expect(e.text).toContain("did not finish within 45000 ms");
    expect(e.text).toContain("ask again in a moment");
    expect(e.retryable).toBe(true);
  });

  test("a caller's mistake is not offered as retryable", () => {
    const e = lib.explain({ ok: false, code: "bad-parameter", error: "lat is required" }, 400);
    expect(e.retryable).toBe(false);
    expect(e.text).toContain("lat is required");
  });

  test("an unmapped failure says so rather than inventing a cause", () => {
    const e = lib.explain(null, 502);
    expect(e.text).toContain("502");
    expect(e.retryable).toBe(true);
  });

  test("no answer at all is not dressed up as one", () => {
    expect(lib.explain(null, null).text).toContain("could not be reached");
  });
});

describe("fieldQuery", () => {
  test("uses the parameter names the service actually reads", () => {
    const q = lib.fieldQuery({ lat: 40.0150, lon: -105.2705, radiusMiles: 1, cols: 48 });
    expect(q).toBe("/v1/field?lat=40.015&lon=-105.2705&radiusMiles=1&cols=48");
  });

  test("rounds the pin to a sane number of places", () => {
    const q = lib.fieldQuery({ lat: 40.01500000001, lon: -105.27049999999, radiusMiles: 2 });
    expect(q).toContain("lat=40.015");
    expect(q).toContain("lon=-105.2705");
  });
});
