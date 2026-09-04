/**
 * Comparing the model's ground with the ground, with both sources stubbed.
 *
 * The two numbers this tool exists to produce are a difference in elevation and
 * a landform index at the model's own scale, and both are easy to get subtly
 * wrong: a nearest-point search that ignores the shortening of longitude picks
 * the wrong cell in the mountains, and a landform index that averages the whole
 * grid instead of a disc reports the state's relief rather than the hill's. So
 * those two are graded here against ground whose answer is known by
 * construction, and the DEM side is stubbed because `derive` and `cog` are
 * graded in their own suites.
 */

"use strict";

const proj = require("../proj.js");
const modelTerrain = require("../tools/model-terrain.js");

const LAT = 39.5;
const LON = -105.6;

/**
 * A regular lat/long grid standing in for HRRR's Lambert one.
 *
 * The projection is not what is being tested — `grib2.js` grades that against
 * ecCodes — and a grid whose point spacing is known in kilometres is what makes
 * the disc in `modelPositionIndex` checkable by hand.
 */
function orographyGrid(opts) {
  const o = opts || {};
  const n = o.n || 21;
  const stepKm = o.stepKm || 3;
  const stepLat = stepKm / 111.32;
  const stepLon = stepKm / (111.32 * Math.cos((LAT * Math.PI) / 180));
  const latitudes = [];
  const longitudes = [];
  const values = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dj = j - (n - 1) / 2;
      const di = i - (n - 1) / 2;
      latitudes.push(LAT + dj * stepLat);
      longitudes.push(LON + di * stepLon);
      values.push(o.value ? o.value(di * stepKm, dj * stepKm) : 2600);
    }
  }
  return {
    parameter: "HGT",
    level: { type: 1, name: "surface", value: 0 },
    latitudes: latitudes,
    longitudes: longitudes,
    values: values
  };
}

function derivedGround(baseM) {
  const crs = proj.crsFromEpsg(26913);
  const mid = proj.fromGeographic(crs, LAT, LON);
  const width = 60;
  const height = 60;
  const spacing = 30;
  const transform = {
    originX: mid.x - (width * spacing) / 2,
    originY: mid.y + (height * spacing) / 2,
    scaleX: spacing,
    scaleY: -spacing
  };
  const elevation = new Float32Array(width * height).fill(baseM);
  return {
    crs: crs,
    width: width,
    height: height,
    transform: transform,
    elevation: elevation,
    fields: {
      slopeDeg: new Float32Array(width * height).fill(1),
      tpi: new Float32Array(width * height).fill(0)
    }
  };
}

function stubs(opts) {
  const o = opts || {};
  const record = o.record || orographyGrid({});
  return {
    ids: ["ONE"],
    source: {
      station: async function (id) {
        return { id: id, name: id, lat: LAT, lon: LON, elevationM: o.publishedM || 2600 };
      }
    },
    service: {
      ground: {
        get: async function () {
          return { derived: derivedGround(o.demM === undefined ? 2600 : o.demM), dataset: "3DEP 1m" };
        }
      }
    },
    fetchHrrrBox: async function () {
      return { url: "https://example.invalid/filter", records: [record], bytes: 1024 };
    },
    at: new Date("2026-09-04T18:00:00Z"),
    forecastHour: 6
  };
}

describe("the ground the model ran over, against the ground", () => {
  test("a smoothed model puts a valley station above where it stands", async () => {
    // The DEM has the station in a gulch at 2100 m; the model's cell, which
    // averages the plateau the gulch is cut into, is 2200 m. That 100 m is the
    // part of the landform the model cannot see.
    const report = await modelTerrain.compare(Object.assign(stubs({ demM: 2100 }), {}));

    expect(report.stations).toHaveLength(1);
    expect(report.stations[0].demElevationM).toBeCloseTo(2100, 0);
    expect(report.stations[0].modelElevationM).toBeCloseTo(2600, 0);
    expect(report.stations[0].modelMinusDemM).toBeCloseTo(500, 0);
    expect(report.model.validTime).toBe("2026-09-04T18:00:00.000Z");
    expect(report.model.forecastHour).toBe(6);
  });

  test("the nearest cell is the nearest one on the ground, not in degrees", () => {
    const record = orographyGrid({});
    // A point a third of a cell east and a third of a cell north of the
    // centre: nearest is still the centre. Comparing raw degrees, a longitude
    // step is 1.3x a latitude step at this latitude, so an unscaled search
    // reaches for a neighbour instead.
    const stepLat = 3 / 111.32;
    const at = modelTerrain.nearestPoint(record, LAT + stepLat * 0.3, LON + stepLat * 0.3);
    const centre = (record.values.length - 1) / 2;

    expect(at.index).toBe(centre);
    expect(at.distanceKm).toBeLessThan(3);
  });

  test("the model's landform index reads a disc, not the whole grid", () => {
    // Ground that falls away only beyond 10 km: inside a 7.5 km disc the
    // station is on level ground and the index is zero, while an index taken
    // over the whole 60 km grid would call it a summit.
    const record = orographyGrid({
      value: function (eastKm, northKm) {
        return Math.hypot(eastKm, northKm) > 10 ? 2000 : 2600;
      }
    });
    const centre = (record.values.length - 1) / 2;

    expect(modelTerrain.modelPositionIndex(record, centre, 7.5)).toBeCloseTo(0, 6);
    expect(modelTerrain.modelPositionIndex(record, centre, 30)).toBeGreaterThan(100);
  });

  test("a station in a model hollow reads negative at the model's scale", () => {
    const record = orographyGrid({
      value: function (eastKm, northKm) {
        return 2600 + Math.min(300, 40 * Math.hypot(eastKm, northKm));
      }
    });
    const centre = (record.values.length - 1) / 2;

    expect(modelTerrain.modelPositionIndex(record, centre, 7.5)).toBeLessThan(-50);
  });

  test("the box holds every station with room to spare", () => {
    const box = modelTerrain.boxAround([
      { lat: 37.5, lon: -108.9 },
      { lat: 40.8, lon: -102.4 }
    ], 0.3);

    expect(box.south).toBeCloseTo(37.2, 6);
    expect(box.north).toBeCloseTo(41.1, 6);
    expect(box.west).toBeCloseTo(-109.2, 6);
    expect(box.east).toBeCloseTo(-102.1, 6);
  });

  test("a domain that cannot be read is a failure, not an elevation of zero", async () => {
    const base = stubs({});
    base.service.ground.get = async function () {
      const err = new Error("the requested box does not overlap this tile");
      err.code = "outside-tile";
      throw err;
    };
    const report = await modelTerrain.compare(base);

    expect(report.stations).toHaveLength(0);
    expect(report.failures).toEqual([
      { id: "ONE", code: "outside-tile", message: "the requested box does not overlap this tile" }
    ]);
  });

  test("a cycle with no surface orography is refused rather than reported empty", async () => {
    const base = stubs({});
    base.fetchHrrrBox = async function () {
      return { url: "https://example.invalid/filter", records: [], bytes: 0 };
    };

    await expect(modelTerrain.compare(base)).rejects.toThrow(/no surface HGT/);
  });
});
