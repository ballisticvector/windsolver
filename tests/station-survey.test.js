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

  test("the same ground is a different class at a different threshold, and says which", async () => {
    // Measurement 14: over 93 Colorado RAWS the same catalogue reads 3 valleys
    // at a 500 m radius and 15 at 2 km. A class is a statement about a scale,
    // so the scale has to travel with it or two counts get compared that are
    // not about the same thing.
    const report = await survey.survey({
      source: stubSource([stationAt("HILL")]),
      service: stubService(function () { return RIDGE; }),
      positionThresholdM: 500
    });

    expect(report.stations[0].positionIndexM).toBeGreaterThan(15);
    expect(report.stations[0].class).toBe("flat");
    expect(report.stations[0].positionThresholdM).toBe(500);
    expect(report.query.positionThresholdM).toBe(500);
    expect(survey.summarise(report)).toContain("beyond 500 m");
  });

  test("the threshold defaults to the one every earlier survey used", async () => {
    const report = await survey.survey({
      source: stubSource([stationAt("HILL")]),
      service: stubService(function () { return RIDGE; })
    });

    expect(report.query.positionThresholdM).toBe(15);
    expect(report.query.positionRadiusM).toBe(500);
    expect(report.stations[0].positionRadiusM).toBe(500);
    expect(report.stations[0].class).toBe("ridge");
    expect(survey.summarise(report)).toContain("posM is the 500 m position index");
    expect(survey.parseArgs(["--threshold", "2000"]).threshold).toBe("2000");
  });

  test("the footnote quotes the radius the survey was actually run at", async () => {
    // A survey run at 2 km used to print "posM is the 500 m position index",
    // which is the exact confusion measurement 14 was about.
    const report = await survey.survey({
      source: stubSource([stationAt("HILL")]),
      service: stubService(function () { return RIDGE; }),
      positionRadiusM: 2000
    });

    expect(report.query.positionRadiusM).toBe(2000);
    expect(survey.summarise(report)).toContain("posM is the 2000 m position index");
    expect(survey.summarise(report)).not.toContain("500 m position index");
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

  test("a station in another state is not surveyed, whatever the catalogue answered", async () => {
    // FEMS' metadata endpoint takes no state: it answers with all 2,088 or with
    // the ids it is given, so a state left to the service is no filter at all.
    let reads = 0;
    const report = await survey.survey({
      source: stubSource([
        stationAt("HERE"),
        Object.assign(stationAt("AWAY"), { state: "WY" }),
        Object.assign(stationAt("UNSTATED"), { state: null })
      ]),
      service: stubService(function () { reads++; return RIDGE; }),
      states: "CO"
    });

    expect(reads).toBe(1);
    expect(report.stations.map(function (s) { return s.id; })).toEqual(["HERE"]);
    expect(report.eligible).toBe(1);
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

/**
 * Choosing the set.
 *
 * The eleven stations already scored were the ids that happened to be to hand,
 * and one of them carried the whole terrain signal. What replaces that is a set
 * chosen on the ground it stands in, so these grade the choosing rather than
 * the measuring.
 */
describe("choosing a set spread across the landform", () => {
  function landform(id, positionIndexM, opts) {
    return Object.assign(
      { id: id, positionIndexM: positionIndexM, suspect: false }, opts || {});
  }

  test("both ends of the range are in the set, not just the first N rows", () => {
    const stations = [];
    for (let i = 0; i < 40; i++) stations.push(landform("S" + i, i * 5 - 100));

    const chosen = survey.spread(stations, 5);
    expect(chosen.map(function (s) { return s.positionIndexM; }))
      .toEqual([-100, -50, 0, 45, 95]);
  });

  test("a station the ground disagrees with is not eligible to be chosen", () => {
    const chosen = survey.spread([
      landform("LOW", -80),
      landform("BAD", 200, { suspect: true }),
      landform("BLIND", null),
      landform("HIGH", 60)
    ], 2);

    expect(chosen.map(function (s) { return s.id; })).toEqual(["LOW", "HIGH"]);
  });

  test("asking for more than there are gives every station, ordered by landform", () => {
    const chosen = survey.spread([landform("B", 10), landform("A", -10)], 50);
    expect(chosen.map(function (s) { return s.id; })).toEqual(["A", "B"]);
  });

  test("the chosen set is reported as ids a calibration run can be given", async () => {
    const report = await survey.survey({
      source: stubSource([stationAt("PCPC2"), stationAt("STOC2")]),
      service: stubService(function () { return RIDGE; }),
      spread: 2
    });

    expect(report.spread).toEqual(["PCPC2", "STOC2"]);
    expect(survey.summarise(report)).toContain("PCPC2,STOC2");
  });
});

describe("the survey's command line", () => {
  test("an unrecognised flag is refused rather than quietly dropped", () => {
    // `--spred 30` parsed as an unknown key would produce a complete, plausible
    // report of the first 60 stations, which reads exactly like a spread.
    expect(() => survey.parseArgs(["--spred", "30"]))
      .toThrow("unrecognised option --spred");
    expect(survey.parseArgs(["--spread", "30"])).toEqual({ spread: "30" });
  });
});
