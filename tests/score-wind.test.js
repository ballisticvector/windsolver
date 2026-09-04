/**
 * The verification run itself, with both services stubbed.
 *
 * The arithmetic is graded in `tests/verify.test.js` and the reader in
 * `tests/observations.test.js`. What is left here is the part that decides what
 * gets scored: which hours are asked for, what happens to an hour that fails,
 * which wind is the baseline and which is the candidate, and whether the
 * summary a person reads says the same thing as the JSON.
 *
 * The observations are the real KBDU window, so the pairing is exercised
 * against the timestamps a station really publishes — hourly METARs with
 * specials in between — rather than against a tidy series on the hour.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const downscale = require("../downscale.js");
const proj = require("../proj.js");
const scoreWind = require("../tools/score-wind.js");
const observationsModule = require("../observations.js");

const STATION = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "nws-kbdu-station.json"), "utf8"));
const OBSERVATIONS = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "nws-kbdu-observations.json"), "utf8"));

const station = observationsModule.parseStation(STATION);
const read = observationsModule.parseObservations(OBSERVATIONS);

// An hour inside the fixture's window, on the hour, so the pairing has
// something to match. The fixture runs 2026-09-01T00Z to 2026-09-03T00Z.
const END = Date.UTC(2026, 8, 2, 12);

function stubSource(overrides) {
  return Object.assign({
    station: async function () { return station; },
    observations: async function () { return read; }
  }, overrides || {});
}

/**
 * A field-shaped object over the station: uniform wind, uniform ground.
 *
 * Not a real `field.assemble` result — the composition is graded in
 * `tests/field.test.js`, and the fixture volume there is over ground 40 miles
 * from KBDU. What this has to be is sample-able by `downscale.windAt`,
 * `derive.fieldAt` and `derive.positionIndexAt` at the station's own
 * coordinate.
 *
 * `ground.reliefM` is how far the station stands above the ground 600 m away:
 * plus for a hill, minus for a hollow. It moves the *surroundings* and leaves
 * the station's own elevation at `elevationM`, so the landform and the
 * published-elevation check stay independent of each other. The 500 m position
 * index comes out at about 0.56 of it, because the disc the index averages
 * over lies inside the slope.
 * The domain is 1,200 m across for the same reason — a 500 m disc has to fit
 * inside it, and an 8 x 8 patch of 30 m pixels is a quarter of the landform
 * the classification is about.
 */
function stubField(wind, ground) {
  const g = ground || {};
  const crs = proj.crsFromEpsg(26913);
  const mid = proj.fromGeographic(crs, station.lat, station.lon);
  const width = 40;
  const height = 40;
  const spacing = 30;
  const geometry = {
    crs: crs,
    width: width,
    height: height,
    transform: {
      originX: mid.x - (width * spacing) / 2,
      originY: mid.y + (height * spacing) / 2,
      scaleX: spacing,
      scaleY: -spacing
    }
  };

  const rad = wind.fromDeg * Math.PI / 180;
  const east = new Float32Array(width * height).fill(-wind.speedMps * Math.sin(rad));
  const north = new Float32Array(width * height).fill(-wind.speedMps * Math.cos(rad));

  return Object.assign({}, geometry, {
    east: east,
    north: north,
    reference: {
      east: -wind.referenceMps * Math.sin(rad),
      north: -wind.referenceMps * Math.cos(rad)
    },
    heightAglM: 10,
    offset: { meanM: 12.5 },
    terrain: { dataset: "3DEP 1m", resolutionM: 1 },
    derived: Object.assign({}, geometry, {
      elevation: cone(geometry, mid, g.elevationM === undefined ? 1610 : g.elevationM, g.reliefM || 0),
      fields: {
        slopeDeg: new Float32Array(width * height).fill(g.slopeDeg === undefined ? 1.2 : g.slopeDeg),
        tpi: new Float32Array(width * height).fill(g.tpi === undefined ? 0.3 : g.tpi)
      }
    })
  });
}

/** Ground falling `reliefM` over the 600 m around the station, row-major. */
function cone(geometry, apex, baseM, reliefM) {
  const out = new Float32Array(geometry.width * geometry.height);
  for (let row = 0; row < geometry.height; row++) {
    for (let col = 0; col < geometry.width; col++) {
      const x = geometry.transform.originX + (col + 0.5) * geometry.transform.scaleX;
      const y = geometry.transform.originY + (row + 0.5) * geometry.transform.scaleY;
      const r = Math.hypot(x - apex.x, y - apex.y);
      out[row * geometry.width + col] = baseM - reliefM * Math.min(1, r / 600);
    }
  }
  return out;
}

function stubService(fieldFor) {
  const asked = [];
  return {
    asked: asked,
    get: async function (spec) {
      asked.push(spec);
      const answer = fieldFor(spec);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

describe("the height the wind was measured at", () => {
  // A RAWS anemometer stands 6.1 m up — 20 ft, the NFDRS standard — and HRRR's
  // surface wind is at 10 m. Scoring one against the other without moving
  // either charges the model for a difference the log law already explains,
  // and it does it in one direction: the model always looks too fast.
  function atHeight(heightM) {
    return stubSource({
      station: async function () {
        return Object.assign({}, station, { sensorHeightM: heightM });
      }
    });
  }

  test("the model wind is brought down to the anemometer before it is scored", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 5, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: atHeight(6.1), service: service, stations: ["KBDU"], hours: 4, endMs: END
    });

    const expected = downscale.heightFactor(10, 6.1, downscale.DEFAULT_ROUGHNESS_M);
    const s = report.stations[0];
    expect(expected).toBeLessThan(1);
    expect(s.height.sensorHeightM).toBeCloseTo(6.1, 6);
    expect(s.height.fieldHeightAglM).toBe(10);
    expect(s.height.factor).toBeCloseTo(expected, 4);
    // 5 m/s of model wind at 10 m is 4.5-ish at the anemometer, so the bias
    // against the same observations moves by exactly that much.
    const flat = await scoreWind.buildReport({
      source: atHeight(10), service: stubService(function () {
        return stubField({ speedMps: 5, fromDeg: 270, referenceMps: 5 });
      }), stations: ["KBDU"], hours: 4, endMs: END
    });
    expect(s.model.speed.modelledMeanMps)
      .toBeCloseTo(flat.stations[0].model.speed.modelledMeanMps * expected, 3);
    expect(s.downscaled.speed.modelledMeanMps)
      .toBeCloseTo(flat.stations[0].downscaled.speed.modelledMeanMps * expected, 3);
  });

  test("a sensor at the model's own height changes nothing", async () => {
    const report = await scoreWind.buildReport({
      source: atHeight(10),
      service: stubService(function () {
        return stubField({ speedMps: 5, fromDeg: 270, referenceMps: 5 });
      }),
      stations: ["KBDU"], hours: 4, endMs: END
    });
    expect(report.stations[0].height.factor).toBe(1);
  });

  test("a station that does not publish a height is scored unmoved, and says so", async () => {
    // Guessing 10 m for a station that never said would hide the mismatch
    // again, and the whole point of the field is that it is visible.
    const report = await scoreWind.buildReport({
      source: stubSource(),
      service: stubService(function () {
        return stubField({ speedMps: 5, fromDeg: 270, referenceMps: 5 });
      }),
      stations: ["KBDU"], hours: 4, endMs: END
    });
    expect(report.stations[0].height.sensorHeightM).toBeNull();
    expect(report.stations[0].height.factor).toBe(1);
    expect(scoreWind.summarise(report)).toMatch(/height/i);
  });

  test("the direction is left alone, because a log law says nothing about veering", async () => {
    const report = await scoreWind.buildReport({
      source: atHeight(6.1),
      service: stubService(function () {
        return stubField({ speedMps: 5, fromDeg: 270, referenceMps: 5 });
      }),
      stations: ["KBDU"], hours: 4, endMs: END
    });
    const flat = await scoreWind.buildReport({
      source: atHeight(10),
      service: stubService(function () {
        return stubField({ speedMps: 5, fromDeg: 270, referenceMps: 5 });
      }),
      stations: ["KBDU"], hours: 4, endMs: END
    });
    expect(report.stations[0].model.direction.biasDeg)
      .toBeCloseTo(flat.stations[0].model.direction.biasDeg, 6);
  });
});

describe("what the run asks for", () => {
  test("it asks for whole hours ending where it was told, oldest first", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 3, endMs: END
    });

    expect(service.asked.map(function (s) { return s.validTime.toISOString(); })).toEqual([
      "2026-09-02T10:00:00.000Z",
      "2026-09-02T11:00:00.000Z",
      "2026-09-02T12:00:00.000Z"
    ]);
    expect(report.window.from).toBe("2026-09-02T10:00:00.000Z");
    expect(report.window.to).toBe("2026-09-02T12:00:00.000Z");
    expect(service.asked[0].lat).toBe(station.lat);
    expect(service.asked[0].forecastHour).toBe(0);
  });

  test("a lead time is passed to the field, and named in the report", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 1,
      forecastHour: 6, endMs: END
    });
    expect(service.asked[0].forecastHour).toBe(6);
    expect(report.source.independence).toMatch(/f6/);
  });

  test("the analysis is reported as having seen the stations", async () => {
    // The one sentence in the output that stops the number being oversold.
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 1, endMs: END
    });
    expect(report.source.independence).toMatch(/assimilates these stations/);
  });
});

describe("what the run scores", () => {
  test("the downscaled wind and the model it came from are scored separately", async () => {
    // Every observation in this hour is compared with a 4 m/s downscaled wind
    // and the 9 m/s HRRR wind above it, so the two candidates must not report
    // the same bias — the whole exercise is the difference between them.
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 9 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 6, endMs: END
    });

    expect(report.overall.downscaled.n).toBeGreaterThan(0);
    expect(report.overall.model.n).toBe(report.overall.downscaled.n);
    expect(report.overall.model.speed.biasMps - report.overall.downscaled.speed.biasMps)
      .toBeCloseTo(5, 6);
    // Same pairs, same observations, so the measured mean cannot differ.
    expect(report.overall.model.speed.observedMeanMps)
      .toBe(report.overall.downscaled.speed.observedMeanMps);
  });

  test("the station's own terrain is read where the station is, and classified", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 }, { reliefM: -60, slopeDeg: 22 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END
    });

    const terrain = report.stations[0].terrain;
    expect(terrain.class).toBe("valley");
    expect(terrain.positionIndexM).toBeLessThan(-15);
    expect(terrain.positionRadiusM).toBe(500);
    // The same ground read the old way: a hollow 60 m deep and 600 m across is
    // half a metre of it, which is why the 3 x 3 field cannot classify a
    // landform and why this report carries both numbers.
    expect(Math.abs(terrain.tpi)).toBeLessThan(1);
    expect(terrain.slopeDeg).toBeCloseTo(22, 6);
    // Within a couple of metres of the station's own pixel: the coordinate is
    // not on a pixel centre, so the sample is interpolated across the hollow's
    // rim rather than read off the middle of it.
    expect(terrain.demElevationM).toBeCloseTo(1610, -1);
    expect(Object.keys(report.byTerrain)).toEqual(["valley"]);
    expect(report.byTerrain.valley.downscaled.n).toBe(report.overall.downscaled.n);
  });

  test("a class carries the model it started from as well as the downscaling", async () => {
    // "6.2° on slopes" is not a claim about this engine. "6.2° where the model
    // alone was 20.1°" is, and it needs the same pairs split the same way on
    // both sides.
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 250, referenceMps: 6 }, { reliefM: 60, slopeDeg: 22 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END
    });

    expect(report.byTerrain.ridge.model.n).toBe(report.byTerrain.ridge.downscaled.n);
    expect(report.byTerrain.ridge.model.speed.biasMps)
      .not.toBeCloseTo(report.byTerrain.ridge.downscaled.speed.biasMps, 6);
  });

  test("a station whose elevation disagrees with the ground under it is dropped, and named", async () => {
    // KBDU is published at 1,611 m. Terrain 250 m below its own coordinate
    // means the coordinate is somewhere else, and the class, the pairing and
    // the score would all be about that somewhere else.
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 }, { elevationM: 1360 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END
    });

    expect(report.stations).toEqual([]);
    expect(report.overall.downscaled.n).toBe(0);
    expect(report.droppedStations.length).toBe(1);
    expect(report.droppedStations[0].code).toBe("elevation-disagrees");
    expect(report.droppedStations[0].differenceM).toBeCloseTo(251.8, 1);
    expect(scoreWind.summarise(report)).toContain("out by 251.8 m");
  });

  test("the tolerance is a choice, and a station inside it is scored with the check recorded", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 }, { elevationM: 1360 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2,
      endMs: END, elevationToleranceM: 300
    });

    expect(report.droppedStations).toEqual([]);
    expect(report.stations[0].elevation.ok).toBe(true);
    expect(report.elevationToleranceM).toBe(300);
  });

  test("the score carries its floor, so an error cannot be quoted without one", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END
    });
    expect(report.overall.downscaled.floor.speedRmseMps).toBe(0.149);
    expect(report.overall.downscaled.floor.dirRmseDeg).toBeCloseTo(2.89, 2);
  });

  test("an hour that could not be solved is counted, not silently dropped", async () => {
    // A run over a bad afternoon at The National Map would otherwise report a
    // clean score over whichever hours happened to work, with nothing on the
    // page to say how many did not.
    let call = 0;
    const service = stubService(function () {
      call++;
      if (call === 2) {
        const err = new Error("no terrain here");
        err.code = "no-terrain";
        return err;
      }
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 3, endMs: END
    });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].code).toBe("no-terrain");
    expect(report.failures[0].validTime).toBe("2026-09-02T11:00:00.000Z");
    expect(report.stations[0].samples).toBe(2);
    expect(scoreWind.summarise(report)).toMatch(/1 hour\(s\) could not be solved/);
  });

  test("a station whose field never lands scores nothing rather than zero", async () => {
    const service = stubService(function () {
      const err = new Error("nope");
      err.code = "no-terrain";
      return err;
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END
    });
    expect(report.overall.downscaled.n).toBe(0);
    expect(report.overall.downscaled.speed.rmseMps).toBeNull();
    expect(report.stations[0].terrain).toBeNull();
    expect(scoreWind.summarise(report)).toMatch(/—/);
  });

  test("observations outside the tolerance are reported as unmatched", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END,
      toleranceMs: 60 * 1000
    });
    // The fixture holds two days of observations against two model hours, so
    // almost all of them have no hour to be compared with.
    expect(report.stations[0].unmatched).toBeGreaterThan(100);
    expect(report.stations[0].paired + report.stations[0].unmatched)
      .toBe(read.records.length);
  });

  // A RAWS station transmits once an hour on a minute of its own — Keyser Ridge
  // at :27, Rampart Range at :35 — so a tolerance tuned to METAR's :53 drops the
  // whole station and the report used to show that as an empty row.
  test("a station the tolerance excluded says how far its nearest hour was", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END,
      toleranceMs: 60 * 1000
    });
    const station = report.stations[0];
    expect(station.nearestUnmatchedMinutes).toBeGreaterThan(1);
    expect(scoreWind.summarise(report))
      .toMatch(/nearest model hour [\d.]+ minutes away; --tolerance \d+ or more would score it/);
  });
});

describe("the summary a person reads", () => {
  test("it quotes the same numbers as the JSON, and names both candidates", async () => {
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 9 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 4, endMs: END
    });
    const text = scoreWind.summarise(report);

    expect(text).toMatch(/HRRR alone/);
    expect(text).toMatch(/downscaled/);
    expect(text).toContain(report.overall.downscaled.speed.rmseMps.toFixed(2));
    expect(text).toContain(report.overall.model.speed.rmseMps.toFixed(2));
    expect(text).toMatch(/KBDU flat/);
    // Nothing about a rifle reaches a general wind report.
    expect(text).not.toMatch(/azimuth|hold|bullet|shot/i);
  });

  test("it shows the model hours behind the observations, not just the count", async () => {
    // A station reporting every five minutes pairs several observations to one
    // model hour, so a row reading n = 135 over a day is 24 independent
    // samples wearing a larger number. Both are printed for that reason.
    const service = stubService(function () {
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 9 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 4, endMs: END,
      // KBDU reports every twenty minutes, so a window this wide catches more
      // than one observation per model hour — which is the case being shown.
      toleranceMs: 20 * 60 * 1000
    });
    expect(report.overall.downscaled.n)
      .toBeGreaterThan(report.overall.downscaled.distinctSamples);
    const text = scoreWind.summarise(report);
    expect(text).toMatch(/\bobs\b.*\bhrs\b/);
    expect(text).toMatch(new RegExp(
      String(report.overall.downscaled.n) + "\\s+" +
      String(report.overall.downscaled.distinctSamples) + "\\s"));
  });
});

describe("the geometry the stub relies on", () => {
  test("a uniform stub field really does sample as the wind it was given", () => {
    // If this drifts, every score above is graded against the wrong wind and
    // all of them still pass.
    const field = stubField({ speedMps: 7, fromDeg: 45, referenceMps: 7 });
    const value = cog.sampleElevation(Object.assign({}, {
      crs: field.crs, width: field.width, height: field.height, transform: field.transform
    }, { values: field.east }), station.lat, station.lon);
    expect(value).toBeCloseTo(-7 * Math.sin(45 * Math.PI / 180), 4);
  });
});
