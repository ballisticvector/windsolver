/**
 * Reading a measured wind from Synoptic, which is where RAWS lives.
 *
 * The tests that matter here are, again, the ones about a response that is not
 * what it looks like: a refusal delivered as HTTP 200, an elevation in feet
 * behind a parameter that says `metric`, a 50.96 m/s spike that only a spatial
 * check caught, and a calm reported as 0°. Every one of them produces an
 * ordinary-looking number if it is taken at face value.
 *
 * The fixtures are real Synoptic responses, untouched apart from being saved to
 * disk — the token is a query parameter and so is never in a body. Regenerate
 * with a token in `$SYNOPTIC_API_TOKEN`:
 *
 *   curl -o tests/fixtures/synoptic-metadata-raws.json \
 *     "https://api.synopticdata.com/v2/stations/metadata?stid=BLPC2,CENU1,BHRC2&token=$SYNOPTIC_API_TOKEN"
 *
 *   curl -o tests/fixtures/synoptic-timeseries-raws.json \
 *     "https://api.synopticdata.com/v2/stations/timeseries?stid=BLPC2,BHRC2&start=202609030000&end=202609030600&vars=wind_speed,wind_direction,wind_gust&obtimezone=UTC&units=metric&qc=on&qc_checks=all&qc_flags=on&qc_remove_data=off&token=$SYNOPTIC_API_TOKEN"
 *
 *   curl -o tests/fixtures/synoptic-timeseries-flagged.json \
 *     "https://api.synopticdata.com/v2/stations/timeseries?stid=CENU1&start=202608281200&end=202608290000&vars=wind_speed,wind_direction&obtimezone=UTC&units=metric&qc=on&qc_checks=all&qc_flags=on&qc_remove_data=off&token=$SYNOPTIC_API_TOKEN"
 *
 * `synoptic-invalid-token.json`, `synoptic-no-stations.json` and
 * `synoptic-history-refused.json` are the three refusals, captured the same
 * way: a deliberately wrong token, the station id `ZZZZ9`, and a window older
 * than a free account may read.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const synoptic = require("../synoptic.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name + ".json"), "utf8"));
}

const METADATA = fixture("synoptic-metadata-raws");
const TIMESERIES = fixture("synoptic-timeseries-raws");
const FLAGGED = fixture("synoptic-timeseries-flagged");
const INVALID_TOKEN = fixture("synoptic-invalid-token");
const NO_STATIONS = fixture("synoptic-no-stations");
const HISTORY_REFUSED = fixture("synoptic-history-refused");

/** A one-station timeseries with whatever this test wants to say about it. */
function series(observations, extra) {
  return Object.assign({
    SUMMARY: { RESPONSE_CODE: 1, RESPONSE_MESSAGE: "OK" },
    UNITS: { position: "m", elevation: "ft", wind_speed: "m/s", wind_direction: "Degrees" },
    STATION: [Object.assign({
      STID: "TEST1",
      NAME: "A RIDGE",
      ELEVATION: "10000.0",
      LATITUDE: "39.5",
      LONGITUDE: "-106.2",
      MNET_ID: "2",
      STATUS: "ACTIVE",
      UNITS: { position: "m", elevation: "ft" },
      OBSERVATIONS: observations
    }, extra || {})]
  });
}

function ok(json) {
  return { ok: true, status: 200, json: async function () { return json; } };
}

describe("the URLs", () => {
  test("a token is required to build one at all", () => {
    expect(() => synoptic.metadataUrl({ stids: ["BLPC2"] })).toThrow(/token/i);
  });

  test("the token never appears in an error, because an error ends up in a log", () => {
    const url = synoptic.timeseriesUrl(
      { stids: ["BLPC2"], start: "2026-09-03T00:00:00Z", end: "2026-09-03T06:00:00Z" }, "s3cret");
    expect(url).toContain("s3cret");
    expect(synoptic.redactToken(url)).not.toContain("s3cret");
    expect(synoptic.redactToken(url)).toContain("token=REDACTED");
  });

  test("times are the compact UTC stamps Synoptic takes, not ISO 8601", () => {
    const url = new URL(synoptic.timeseriesUrl(
      { stids: ["BLPC2"], start: new Date("2026-09-03T04:05:00Z"), end: "2026-09-03T06:00:00Z" }, "t"));
    expect(url.searchParams.get("start")).toBe("202609030405");
    expect(url.searchParams.get("end")).toBe("202609030600");
    expect(url.searchParams.get("obtimezone")).toBe("UTC");
  });

  test("flagged observations are kept in the response rather than removed from it", () => {
    // A reader that cannot see what was dropped cannot report how much of its
    // sample survived, and the survival rate is half of what a score means.
    const url = new URL(synoptic.timeseriesUrl({ stids: ["BLPC2"] }, "t"));
    expect(url.searchParams.get("qc")).toBe("on");
    expect(url.searchParams.get("qc_remove_data")).toBe("off");
  });

  test("a whole network in a state is one query", () => {
    const url = new URL(synoptic.metadataUrl(
      { state: "CO", network: synoptic.RAWS_NETWORK_ID, status: "active" }, "t"));
    expect(url.searchParams.get("state")).toBe("CO");
    expect(url.searchParams.get("network")).toBe("2");
  });
});

describe("a refusal that arrives as an answer", () => {
  test("an invalid token is a refusal, not an empty station list", () => {
    expect(() => synoptic.parseStations(INVALID_TOKEN)).toThrow(/Invalid token/);
    expect(() => synoptic.parseStations(INVALID_TOKEN)).toThrow(
      expect.objectContaining({ code: "synoptic-refused" }));
  });

  test("an unknown station comes back 200 with no stations, and is still a refusal", () => {
    // This is the one that quietly becomes a wrong number: RESPONSE_CODE 2
    // inside an HTTP 200, no STATION array, and a caller that reads the array
    // as empty scores nothing and reports success.
    expect(NO_STATIONS.SUMMARY.RESPONSE_CODE).toBe(2);
    expect(() => synoptic.parseStations(NO_STATIONS)).toThrow(/No stations found/);
  });

  test("a window the account may not read is refused rather than returned short", () => {
    expect(HISTORY_REFUSED.SUMMARY.RESPONSE_CODE).not.toBe(1);
    expect(() => synoptic.parseTimeseries(HISTORY_REFUSED)).toThrow(/does not have access/);
  });

  test("a body with no SUMMARY is not an answer either", () => {
    expect(() => synoptic.parseStations({ STATION: [] })).toThrow(/SUMMARY/);
  });
});

describe("station metadata", () => {
  test("the published elevation is in feet however metric the request was", () => {
    const stations = synoptic.parseStations(METADATA);
    const blue = stations.find(function (s) { return s.id === "BLPC2"; });

    // 10430 ft is 3179.5 m. Read as metres it is a station in the stratosphere,
    // and read as metres by a terrain check it rejects every real station.
    expect(blue.elevationM).toBeCloseTo(10430 * 0.3048, 3);
    expect(blue.elevationM).toBeGreaterThan(3000);
    expect(blue.elevationM).toBeLessThan(3300);
  });

  test("it carries the surveyed position, the name and the network", () => {
    const stations = synoptic.parseStations(METADATA);
    const blue = stations.find(function (s) { return s.id === "BLPC2"; });
    expect(blue.name).toBe("BLUE PARK");
    expect(blue.lat).toBeCloseTo(37.79306, 5);
    expect(blue.lon).toBeCloseTo(-106.77861, 5);
    expect(blue.network).toBe(synoptic.RAWS_NETWORK_ID);
    expect(blue.status).toBe("ACTIVE");
    expect(blue.source).toBe("synoptic");
  });

  test("Synoptic's own DEM elevation is kept, and is not the position", () => {
    // ELEV_DEM is a second opinion worth having and not a substitute for
    // sampling 3DEP: it is a different DEM at a different resolution, and it
    // agrees with the published elevation by construction on the stations
    // Synoptic has already reconciled.
    const blue = synoptic.parseStations(METADATA).find(function (s) { return s.id === "BLPC2"; });
    expect(blue.demElevationM).toBeCloseTo(10370.7 * 0.3048, 3);
    expect(Math.abs(blue.demElevationM - blue.elevationM)).toBeLessThan(30);
  });

  test("an elevation in a unit this reader does not know throws rather than passing through", () => {
    const json = {
      SUMMARY: { RESPONSE_CODE: 1 },
      STATION: [{
        STID: "TEST1", LATITUDE: "39.5", LONGITUDE: "-106.2", ELEVATION: "3000",
        UNITS: { position: "m", elevation: "cubits" }
      }]
    };
    expect(() => synoptic.parseStations(json)).toThrow(/cubits/);
  });

  test("a coordinate that is not on Earth is refused", () => {
    const json = {
      SUMMARY: { RESPONSE_CODE: 1 },
      STATION: [{ STID: "TEST1", LATITUDE: "395", LONGITUDE: "-106.2", UNITS: { elevation: "ft" } }]
    };
    expect(() => synoptic.parseStations(json)).toThrow(/position on Earth/);
  });
});

describe("a station's wind", () => {
  test("it reads the real series as m/s at UTC instants", () => {
    const read = synoptic.parseTimeseries(TIMESERIES);
    const big = read.get("BHRC2");
    expect(big.counts.seen).toBe(6);
    expect(big.counts.kept).toBe(6);
    expect(big.records[0].time).toBe("2026-09-03T00:58:00.000Z");
    expect(big.records[0].speedMps).toBeCloseTo(5.812, 3);
    expect(big.records[0].fromDeg).toBeCloseTo(213, 6);
    expect(big.records[0].gustMps).toBeCloseTo(10.729, 3);
    expect(read.get("BLPC2").records.length).toBeGreaterThan(0);
  });

  test("the records are the shape observations.js produces, so the scorer cannot tell them apart", () => {
    const record = synoptic.parseTimeseries(TIMESERIES).get("BHRC2").records[0];
    expect(Object.keys(record).sort()).toEqual(
      ["calm", "fromDeg", "gustMps", "quality", "raw", "speedMps", "stationId", "time", "timeMs"]);
  });

  test("a flagged observation is dropped with its check id, not scored", () => {
    // CENU1 reported 50.963 m/s — 114 mph — at 21:38 on 2026-08-28. It is
    // inside any plausible range check; only the spatial check, comparing it
    // with its neighbours, caught it. Scored, it is a 45 m/s model error.
    const read = synoptic.parseTimeseries(FLAGGED).get("CENU1");
    const dropped = read.rejected.filter(function (r) { return r.code === "bad-quality"; });
    expect(dropped.length).toBe(1);
    expect(dropped[0].time).toBe("2026-08-28T21:38:00.000Z");
    expect(dropped[0].reason).toContain("105");
    expect(read.records.some(function (r) { return r.speedMps > 40; })).toBe(false);
    expect(read.counts.seen).toBe(read.counts.kept + read.counts.rejected);
  });

  test("a calm has no direction, whatever the direction field says", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T00:00:00Z"],
      wind_speed_set_1: [0],
      wind_direction_set_1: [0]
    })).get("TEST1");

    expect(read.records[0].calm).toBe(true);
    expect(read.records[0].fromDeg).toBeNull();
    expect(read.counts.calm).toBe(1);
    expect(read.counts.withDirection).toBe(0);
  });

  test("a missing speed is counted, not read as a calm", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T00:00:00Z", "2026-09-03T01:00:00Z"],
      wind_speed_set_1: [null, 3],
      wind_direction_set_1: [270, 280]
    })).get("TEST1");

    expect(read.counts.kept).toBe(1);
    expect(read.rejected[0].code).toBe("no-wind");
  });

  test("a speed with no direction is still worth its speed", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T00:00:00Z"],
      wind_speed_set_1: [4.2],
      wind_direction_set_1: [null]
    })).get("TEST1");

    expect(read.records[0].speedMps).toBeCloseTo(4.2, 6);
    expect(read.records[0].fromDeg).toBeNull();
    expect(read.records[0].calm).toBe(false);
  });

  test("a direction flagged on its own does not take the speed with it", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T00:00:00Z"],
      wind_speed_set_1: [4.2],
      wind_direction_set_1: [270]
    }, { QC: { wind_direction_set_1: [[105]] } })).get("TEST1");

    expect(read.counts.kept).toBe(1);
    expect(read.records[0].speedMps).toBeCloseTo(4.2, 6);
    expect(read.records[0].fromDeg).toBeNull();
  });

  test("360° is written as 0, the way the rest of this repository writes north", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T00:00:00Z"],
      wind_speed_set_1: [4],
      wind_direction_set_1: [360]
    })).get("TEST1");
    expect(read.records[0].fromDeg).toBe(0);
  });

  test("a speed unit that is not m/s throws rather than being scaled by guesswork", () => {
    const json = series({
      date_time: ["2026-09-03T00:00:00Z"],
      wind_speed_set_1: [10],
      wind_direction_set_1: [270]
    });
    json.UNITS.wind_speed = "mph";
    expect(() => synoptic.parseTimeseries(json)).toThrow(/mph/);
  });

  test("an implausible speed is dropped with the number that was implausible", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T00:00:00Z"],
      wind_speed_set_1: [120],
      wind_direction_set_1: [270]
    })).get("TEST1");
    expect(read.counts.kept).toBe(0);
    expect(read.rejected[0].code).toBe("implausible");
  });

  test("records come back oldest first however they arrived", () => {
    const read = synoptic.parseTimeseries(series({
      date_time: ["2026-09-03T02:00:00Z", "2026-09-03T00:00:00Z", "2026-09-03T01:00:00Z"],
      wind_speed_set_1: [1, 2, 3],
      wind_direction_set_1: [10, 20, 30]
    })).get("TEST1");
    expect(read.records.map(function (r) { return r.time; })).toEqual([
      "2026-09-03T00:00:00.000Z", "2026-09-03T01:00:00.000Z", "2026-09-03T02:00:00.000Z"
    ]);
  });
});

describe("the ruler the observation was written with", () => {
  test("every metric speed in the real fixture is a whole mile per hour", () => {
    // Which is what makes the floor 1 mph rather than the three decimals
    // Synoptic prints: RAWS reports mph (NWCG PMS 426-3) and the metric value
    // is a conversion of it. Scored against a METAR's whole-knot floor, RAWS
    // would be credited with rounding this observer did not do.
    const speeds = [];
    for (const station of TIMESERIES.STATION) {
      for (const v of station.OBSERVATIONS.wind_speed_set_1) if (v !== null) speeds.push(v);
    }
    expect(speeds.length).toBeGreaterThan(10);
    for (const v of speeds) {
      const mph = v / synoptic.RAWS_QUANTISATION.speedStepMps;
      expect(Math.abs(mph - Math.round(mph))).toBeLessThan(0.002);
    }
  });

  test("directions are whole degrees, not the eight points an RWIS feed gives", () => {
    const dirs = [];
    for (const station of TIMESERIES.STATION) {
      for (const v of station.OBSERVATIONS.wind_direction_set_1) if (v !== null) dirs.push(v);
    }
    expect(dirs.some(function (d) { return d % 45 !== 0; })).toBe(true);
    expect(synoptic.RAWS_QUANTISATION.dirStepDeg).toBe(1);
  });
});

describe("the network source", () => {
  test("it reads a station and its wind through an injected fetch", async () => {
    const asked = [];
    const source = synoptic.createSynopticSource({
      token: "s3cret",
      stids: ["BHRC2", "BLPC2"],
      fetch: async function (url) {
        asked.push(url);
        return ok(url.indexOf("/metadata") >= 0 ? METADATA : TIMESERIES);
      }
    });

    const station = await source.station("bhrc2");
    expect(station.id).toBe("BHRC2");

    const read = await source.observations("BHRC2", {
      start: "2026-09-03T00:00:00Z", end: "2026-09-03T06:00:00Z"
    });
    expect(read.counts.kept).toBe(6);
  });

  test("one window is one request however many stations are scored against it", async () => {
    let timeseriesCalls = 0;
    const source = synoptic.createSynopticSource({
      token: "s3cret",
      stids: ["BHRC2", "BLPC2"],
      fetch: async function (url) {
        if (url.indexOf("/timeseries") >= 0) timeseriesCalls++;
        return ok(url.indexOf("/metadata") >= 0 ? METADATA : TIMESERIES);
      }
    });

    const window = { start: "2026-09-03T00:00:00Z", end: "2026-09-03T06:00:00Z" };
    await source.observations("BHRC2", window);
    await source.observations("BLPC2", window);
    expect(timeseriesCalls).toBe(1);
  });

  test("a station with no rows in the window reads as empty, not as an error", async () => {
    const source = synoptic.createSynopticSource({
      token: "s3cret",
      stids: ["BHRC2", "BLPC2"],
      fetch: async function () { return ok(TIMESERIES); }
    });
    const read = await source.observations("KZZZ", {
      start: "2026-09-03T00:00:00Z", end: "2026-09-03T06:00:00Z"
    });
    expect(read.counts.seen).toBe(0);
    expect(read.records).toEqual([]);
  });

  test("an HTTP failure names the request without naming the token", async () => {
    const source = synoptic.createSynopticSource({
      token: "s3cret",
      fetch: async function () {
        return { ok: false, status: 429, json: async function () { return INVALID_TOKEN; } };
      }
    });
    await expect(source.station("BLPC2")).rejects.toThrow(/429/);
    await expect(source.station("BLPC2")).rejects.not.toThrow(/s3cret/);
  });

  test("a station Synoptic does not return is named rather than silently missing", async () => {
    const source = synoptic.createSynopticSource({
      token: "s3cret",
      fetch: async function () { return ok(METADATA); }
    });
    await expect(source.station("KBDU")).rejects.toThrow(/no station KBDU/);
  });
});
