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
 * from KBDU. What this has to be is sample-able by `downscale.windAt` and
 * `derive.fieldAt` at the station's own coordinate.
 */
function stubField(wind, ground) {
  const g = ground || {};
  const crs = proj.crsFromEpsg(26913);
  const mid = proj.fromGeographic(crs, station.lat, station.lon);
  const width = 8;
  const height = 8;
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
      elevation: new Float32Array(width * height).fill(g.elevationM === undefined ? 1610 : g.elevationM),
      fields: {
        slopeDeg: new Float32Array(width * height).fill(g.slopeDeg === undefined ? 1.2 : g.slopeDeg),
        tpi: new Float32Array(width * height).fill(g.tpi === undefined ? 0.3 : g.tpi)
      }
    })
  });
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
      return stubField({ speedMps: 4, fromDeg: 270, referenceMps: 5 }, { tpi: -14, slopeDeg: 22 });
    });
    const report = await scoreWind.buildReport({
      source: stubSource(), service: service, stations: ["KBDU"], hours: 2, endMs: END
    });

    const terrain = report.stations[0].terrain;
    expect(terrain.class).toBe("valley");
    expect(terrain.slopeDeg).toBeCloseTo(22, 6);
    expect(terrain.demElevationM).toBeCloseTo(1610, 6);
    expect(Object.keys(report.byTerrain)).toEqual(["valley"]);
    expect(report.byTerrain.valley.n).toBe(report.overall.downscaled.n);
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
