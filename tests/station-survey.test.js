/**
 * Surveying the ground under a station list, with the terrain service stubbed.
 *
 * The landform arithmetic itself is graded in `tests/derive.test.js` and the
 * classification in `tests/verify.test.js`. What is left here is the part that
 * decides which stations reach a scoring run: that a station is filed under the
 * landform it stands in, that a published coordinate disagreeing with the
 * ground beneath it is called out rather than counted, and that one unreadable
 * domain does not end the survey.
 */

"use strict";

const proj = require("../proj.js");
const survey = require("../tools/station-survey.js");

const LAT = 39.5;
const LON = -105.6;

function stationAt(id, opts) {
  const o = opts || {};
  return {
    id: id,
    name: o.name || id,
    lat: o.lat === undefined ? LAT : o.lat,
    lon: o.lon === undefined ? LON : o.lon,
    elevationM: o.elevationM === undefined ? 2600 : o.elevationM,
    sensorHeightM: 6.1,
    network: 2,
    status: "ACTIVE",
    state: "CO",
    source: "synoptic"
  };
}

/**
 * Ground that rises or falls `reliefM` over the 600 m around the station.
 *
 * Plus is a hill with the station on top, minus is a hollow with the station in
 * the bottom; the station's own elevation stays at `baseM` either way, so the
 * landform and the published-elevation check move independently.
 */
function derivedGround(reliefM, baseM) {
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

  const elevation = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = transform.originX + (col + 0.5) * transform.scaleX;
      const y = transform.originY + (row + 0.5) * transform.scaleY;
      const r = Math.hypot(x - mid.x, y - mid.y);
      elevation[row * width + col] = baseM - reliefM * Math.min(1, r / 600);
    }
  }

  return {
    crs: crs,
    width: width,
    height: height,
    transform: transform,
    elevation: elevation,
    fields: {
      slopeDeg: new Float32Array(width * height).fill(3.4),
      tpi: new Float32Array(width * height).fill(0.2)
    }
  };
}

function stubService(load) {
  return {
    ground: {
      get: async function (spec) {
        const answer = load(spec);
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
  };
}

function stubSource(stations) {
  return { search: async function () { return stations; } };
}

const RIDGE = { derived: derivedGround(80, 2600), dataset: "3DEP 1m" };

describe("surveying the ground before anything is scored", () => {
  test("a station is filed under the landform it actually stands in", async () => {
    const report = await survey.survey({
      source: stubSource([stationAt("HILL"), stationAt("HOLE")]),
      service: stubService(function () { return RIDGE; })
    });

    expect(report.read).toBe(2);
    expect(report.stations[0].class).toBe("ridge");
    expect(report.stations[0].positionIndexM).toBeGreaterThan(15);
    expect(report.byClass.ridge).toBe(2);
  });

  test("a hollow comes out as valley, which is the stratum being looked for", async () => {
    const report = await survey.survey({
      source: stubSource([stationAt("HOLE")]),
      service: stubService(function () {
        return { derived: derivedGround(-80, 2600), dataset: "3DEP 1m" };
      })
    });

    expect(report.stations[0].class).toBe("valley");
    expect(report.stations[0].positionIndexM).toBeLessThan(-15);
  });

  test("a published elevation the ground disagrees with is flagged, not counted", async () => {
    const report = await survey.survey({
      // 2600 m of ground under a station that says it is at 4000 m: one of the
      // two is wrong, and a station scored at the wrong coordinate would be
      // filed as model error.
      source: stubSource([stationAt("WRONG", { elevationM: 4000 })]),
      service: stubService(function () { return RIDGE; })
    });

    const station = report.stations[0];
    expect(station.suspect).toBe(true);
    expect(station.disagreementM).toBeGreaterThan(1000);
    expect(report.byClass).toEqual({});
    expect(survey.summarise(report)).toContain("SUSPECT");
  });

  test("one unreadable domain is a line in the report, not the end of the survey", async () => {
    const err = new Error("The National Map answered 500");
    err.code = "no-terrain";
    let call = 0;
    const report = await survey.survey({
      source: stubSource([stationAt("DEAD"), stationAt("ALIVE")]),
      service: stubService(function () {
        call++;
        return call === 1 ? err : RIDGE;
      })
    });

    expect(report.read).toBe(1);
    expect(report.failures).toEqual([
      { id: "DEAD", code: "no-terrain", message: "The National Map answered 500" }
    ]);
    expect(survey.summarise(report)).toContain("1 unreadable");
  });

  test("the survey stops at the limit rather than reading a whole state", async () => {
    const many = [];
    for (let i = 0; i < 10; i++) many.push(stationAt("S" + i));
    let reads = 0;
    const report = await survey.survey({
      source: stubSource(many),
      service: stubService(function () { reads++; return RIDGE; }),
      limit: 3
    });

    expect(report.listed).toBe(10);
    expect(report.read).toBe(3);
    expect(reads).toBe(3);
  });

  test("a station with no coordinate is never asked about", async () => {
    let reads = 0;
    const report = await survey.survey({
      source: stubSource([stationAt("NOWHERE", { lat: null }), stationAt("HERE")]),
      service: stubService(function () { reads++; return RIDGE; })
    });

    expect(reads).toBe(1);
    expect(report.stations.map(function (s) { return s.id; })).toEqual(["HERE"]);
  });
});
