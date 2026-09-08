/**
 * Reading a measured wind out of CoAgMet, Colorado's agricultural mesonet.
 *
 * The test worth reading first is `the timestamp ends the interval`. Nothing in
 * the response says whether `2026-08-01T21:00` labels the five minutes before
 * it or the five minutes after it, and the difference is half an hour on the
 * hourly product — larger than the pairing tolerance every score in
 * `docs/downscaling.md` was taken at. It is settled here by arithmetic on two
 * real captures rather than by reading the documentation, because the
 * documentation does not say.
 *
 * The rest are about a reply that is not what it looks like: -999 as a number,
 * a calm that carries a north wind it did not measure, and a full page of blank
 * rows that means "before this station existed" and also "this sensor is dead"
 * and also "you asked an hourly station for five-minute data".
 *
 * Every fixture is a real response, saved as it arrived, from a public URL with
 * no account behind it. Rebuild them with `tools/make-coagmet-fixtures.sh`.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const coagmet = require("../coagmet.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

const METADATA = fixture("coagmet-metadata.json");
const FIVE_MIN = fixture("coagmet-5min-gun01.json");
const HOURLY = fixture("coagmet-hourly-gun01.json");
const EMPTY = fixture("coagmet-5min-empty.json");
const UNKNOWN = fixture("coagmet-5min-unknown.json");
const TWO = fixture("coagmet-5min-two.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ok(body) {
  return {
    ok: true,
    status: 200,
    text: async function () { return JSON.stringify(body); }
  };
}

function bad(status, body) {
  return {
    ok: false,
    status: status,
    text: async function () { return JSON.stringify(body); }
  };
}

/** A fetch that answers each URL from a table and records what it was asked. */
function fetcher(table) {
  const asked = [];
  const doFetch = async function (url) {
    asked.push(url);
    const key = Object.keys(table).find(function (k) { return url.indexOf(k) >= 0; });
    if (!key) throw new Error("nothing in the table answers " + url);
    return table[key];
  };
  doFetch.asked = asked;
  return doFetch;
}

describe("the request, built without making it", () => {
  test("metric and UTC are asked for on every observation request", () => {
    const url = new URL(coagmet.observationsUrl({
      stationId: "gun01",
      start: new Date("2026-08-01T20:00:00Z"),
      end: new Date("2026-08-01T21:00:00Z")
    }));
    expect(url.pathname).toBe("/data/5min/gun01.json");
    expect(url.searchParams.get("from")).toBe("2026-08-01T20:00");
    expect(url.searchParams.get("to")).toBe("2026-08-01T21:00");
    // Not a preference. `units=us` is mph and feet with nothing in the numbers
    // to say so, and a JSON timestamp on the Colorado clock carries no offset.
    expect(url.searchParams.get("units")).toBe("m");
    expect(url.searchParams.get("tz")).toBe("utc");
  });

  test("several stations share one time axis in one request", () => {
    const url = new URL(coagmet.observationsUrl({
      stationIds: ["gun01", "alt01"],
      start: 0,
      end: 60000
    }));
    expect(url.pathname).toBe("/data/5min.json");
    expect(url.searchParams.get("stations")).toBe("gun01,alt01");
  });

  test("the product comes from the station's own timestep, and nothing else does", () => {
    expect(coagmet.frequencyFor(300)).toBe("5min");
    expect(coagmet.frequencyFor(3600)).toBe("hourly");
    // 28 stations report hourly only and answer `5min` with blank rows rather
    // than with an error, so a guessed product is a silently empty run.
    expect(() => coagmet.frequencyFor(900))
      .toThrow(expect.objectContaining({ code: "bad-timestep" }));
  });
});

describe("the catalogue", () => {
  test("every published station parses into the shape the other readers produce", () => {
    const stations = coagmet.parseStations(METADATA);
    expect(stations.length).toBeGreaterThan(100);
    const gun01 = stations.find(function (s) { return s.id === "gun01"; });
    expect(gun01).toMatchObject({
      id: "gun01",
      name: "Gunnison",
      source: "coagmet",
      state: "CO",
      status: "active"
    });
    expect(gun01.lat).toBeCloseTo(38.6135, 4);
    expect(gun01.lon).toBeCloseTo(-106.9015, 4);
    expect(gun01.elevationM).toBe(2406);
    expect(gun01.coagmet.timestepSeconds).toBe(300);
  });

  test("the anemometer height is metres, and it is the reason this network is here", () => {
    const stations = coagmet.parseStations(METADATA);
    const heights = stations
      .filter(function (s) { return s.status === "active" && s.sensorHeightM !== null; })
      .map(function (s) { return s.sensorHeightM; });
    expect(heights.length).toBeGreaterThan(90);
    // Below the 6.1 m of every RAWS ever scored here, which is the whole point.
    expect(Math.max.apply(null, heights)).toBeLessThanOrEqual(10);
    expect(heights.filter(function (h) { return h <= 3; }).length).toBeGreaterThan(90);
  });

  test("a published height of zero is an unrecorded height, not a mast on the ground", () => {
    const one = clone(METADATA);
    const id = Object.keys(one)[0];
    one[id].anemometerHeight = 0;
    const station = coagmet.parseStations(one).find(function (s) { return s.id === id; });
    expect(station.sensorHeightM).toBeNull();
    // The raw claim is kept so that "the catalogue said 0" stays distinguishable
    // from "the catalogue said nothing".
    expect(station.coagmet.heightPublished).toBe(0);
  });

  test("feet are refused rather than read as metres", () => {
    const feet = clone(METADATA);
    Object.keys(feet).forEach(function (id) { feet[id].units = "us"; });
    // 6.6 read as metres instead of feet is a mast three times too high and
    // still a plausible one, so nothing here converts on an assumption.
    expect(() => coagmet.parseStations(feet))
      .toThrow(expect.objectContaining({ code: "bad-unit" }));
  });
});

describe("the timestamp ends the interval, which is measured here and not documented", () => {
  test("the hourly mean is the twelve five-minute values BEFORE its label", () => {
    const five = coagmet.parseObservations(FIVE_MIN);
    const hour = coagmet.parseObservations(HOURLY);

    const byLabel = {};
    five.records.forEach(function (r) { byLabel[r.intervalEnd] = r; });
    const before = [
      "20:05", "20:10", "20:15", "20:20", "20:25", "20:30",
      "20:35", "20:40", "20:45", "20:50", "20:55", "21:00"
    ].map(function (hhmm) { return byLabel["2026-08-01T" + hhmm + ":00.000Z"].speedMps; });
    const after = five.records
      .filter(function (r) { return r.intervalEndMs < Date.parse("2026-08-01T21:00:00Z"); })
      .map(function (r) { return r.speedMps; });

    const mean = function (xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; };
    const hourly = hour.records.find(function (r) {
      return r.intervalEnd === "2026-08-01T21:00:00.000Z";
    });

    expect(before).toHaveLength(12);
    expect(after).toHaveLength(12);
    // Inside the hundredth of a metre per second the archive rounds to, which
    // is as close as two of its own published numbers are able to be.
    expect(Math.abs(mean(before) - hourly.speedMps))
      .toBeLessThan(coagmet.COAGMET_QUANTISATION.speedStepMps);
    // And the other reading of the label is wrong by a tenth of a metre per
    // second on this hour, so the two are genuinely distinguishable.
    expect(Math.abs(mean(after) - hourly.speedMps)).toBeGreaterThan(0.05);
  });

  test("a record's own time is the centre of its interval, half an hour off on hourly data", () => {
    const five = coagmet.parseObservations(FIVE_MIN);
    const hour = coagmet.parseObservations(HOURLY);

    const r = five.records[0];
    expect(r.intervalEnd).toBe("2026-08-01T20:00:00.000Z");
    expect(r.averagingSeconds).toBe(300);
    expect(r.time).toBe("2026-08-01T19:57:30.000Z");
    expect(r.intervalEndMs - r.intervalStartMs).toBe(300000);

    const h = hour.records[0];
    expect(h.averagingSeconds).toBe(3600);
    expect(h.intervalEnd).toBe("2026-08-01T20:00:00.000Z");
    // Scoring an hourly station at its label would pair it half an hour away
    // from the wind it measured, which is past every tolerance in the note.
    expect(h.time).toBe("2026-08-01T19:30:00.000Z");
  });

  test("the offset comes from the response, not from the machine running the test", () => {
    const mst = clone(FIVE_MIN);
    mst.timezone = "mst";
    mst.tzOffset = "-07:00";
    const read = coagmet.parseObservations(mst);
    // Same labels, seven hours later, because the reply said so.
    expect(read.records[0].intervalEnd).toBe("2026-08-02T03:00:00.000Z");

    const silent = clone(FIVE_MIN);
    delete silent.tzOffset;
    expect(() => coagmet.parseObservations(silent))
      .toThrow(expect.objectContaining({ code: "bad-timezone" }));
  });
});

describe("an hour of Gunnison", () => {
  const read = coagmet.parseObservations(FIVE_MIN);

  test("the wind comes through as the records the other readers produce", () => {
    expect(read.counts).toMatchObject({ seen: 13, kept: 13, rejected: 0, blank: 0 });
    expect(read.stationId).toBe("gun01");
    expect(read.which).toBe("qc");
    expect(read.frequency).toBe("5min");
    expect(read.records[0]).toMatchObject({
      stationId: "gun01",
      speedMps: 1.48,
      fromDeg: 189.1,
      calm: false,
      gustMps: 2.95,
      quality: null,
      qcChecked: true
    });
  });

  test("a calm keeps no direction, because the 0.0 the vane reports is a fill", () => {
    const calm = read.records.find(function (r) { return r.calm; });
    expect(calm.speedMps).toBe(0);
    expect(calm.fromDeg).toBeNull();
    // The tell that the 0.0 is a fill and not a north wind: the same row's gust
    // direction is 124.7, which no north wind would carry.
    expect(FIVE_MIN.gustDir[FIVE_MIN.windSpeed.indexOf(0)]).toBe(124.7);
    expect(read.counts.calm).toBe(1);
    expect(read.counts.withDirection).toBe(12);
  });

  test("the QC flag says which product answered and never that a row was checked", () => {
    const raw = clone(FIVE_MIN);
    raw.which = "raw";
    expect(coagmet.parseObservations(raw).records[0].qcChecked).toBe(false);
  });
});

describe("-999 is a number, and every field is checked against it first", () => {
  test("a missing wind speed is absence, not an implausible measurement", () => {
    const holes = clone(FIVE_MIN);
    holes.windSpeed[2] = coagmet.MISSING;
    const read = coagmet.parseObservations(holes);
    expect(read.counts).toMatchObject({ seen: 13, kept: 12, blank: 1 });
    expect(read.rejected[0].code).toBe("no-wind");
    expect(read.records.every(function (r) { return r.speedMps > -1; })).toBe(true);
  });

  test("a missing direction leaves a wind with no direction rather than a north wind", () => {
    const holes = clone(FIVE_MIN);
    holes.windDir[0] = coagmet.MISSING;
    holes.gustSpeed[0] = coagmet.MISSING;
    const first = coagmet.parseObservations(holes).records[0];
    expect(first.speedMps).toBe(1.48);
    expect(first.fromDeg).toBeNull();
    expect(first.gustMps).toBeNull();
  });

  test("a direction outside a circle is brought into one, and a broken speed is refused", () => {
    const odd = clone(FIVE_MIN);
    odd.windDir[0] = 361.5;
    odd.windDir[1] = -10;
    odd.windSpeed[2] = 400;
    const read = coagmet.parseObservations(odd);
    expect(read.records[0].fromDeg).toBeCloseTo(1.5, 6);
    expect(read.records[1].fromDeg).toBeCloseTo(350, 6);
    expect(read.rejected[0].code).toBe("implausible");
  });

  test("columns that do not line up with the time axis are refused, not zipped", () => {
    const short = clone(FIVE_MIN);
    short.windSpeed = short.windSpeed.slice(0, 5);
    expect(() => coagmet.parseObservations(short))
      .toThrow(expect.objectContaining({ code: "bad-observations" }));
  });

  test("mph are refused rather than read as metres per second", () => {
    const us = clone(FIVE_MIN);
    us.units = "us";
    expect(() => coagmet.parseObservations(us))
      .toThrow(expect.objectContaining({ code: "bad-unit" }));
  });
});

describe("absence that arrives looking like data", () => {
  test("a window before the station existed is blank rows, and it is refused", () => {
    // Real capture: 2010 at a station that started in 2015. Every time is "" and
    // every value is -999, which is also what a dead sensor sends, and also what
    // an hourly-only station sends when it is asked for five-minute data.
    expect(EMPTY.time.every(function (t) { return t === ""; })).toBe(true);
    expect(EMPTY.windSpeed.every(function (v) { return v === -999; })).toBe(true);
    expect(() => coagmet.parseObservations(EMPTY))
      .toThrow(expect.objectContaining({ code: "no-observations" }));
  });

  test("a window with some blanks in it keeps the rest", () => {
    const partial = clone(FIVE_MIN);
    partial.time[0] = "";
    partial.windSpeed[0] = -999;
    const read = coagmet.parseObservations(partial);
    expect(read.counts).toMatchObject({ seen: 13, kept: 12, blank: 1 });
  });

  test("an unknown station is the one absence this service states out loud", async () => {
    expect(UNKNOWN.error).toMatch(/Unknown station id/);
    const source = coagmet.createCoagmetSource({
      fetch: fetcher({
        "metadata.json": ok(METADATA),
        "5min/gun01.json": bad(400, UNKNOWN)
      })
    });
    await expect(source.observations("gun01", { start: 0, end: 60000 }))
      .rejects.toMatchObject({ code: "unknown-station" });
  });
});

describe("two stations on one time axis", () => {
  test("each station's columns are read against the shared axis", () => {
    const all = coagmet.parseTimeseries(TWO);
    expect(Object.keys(all).sort()).toEqual(["alt01", "gun01"]);
    expect(all.gun01.records[0].speedMps).toBe(1.48);
    expect(all.alt01.records[0].speedMps).toBe(1.66);
    expect(all.gun01.records[0].timeMs).toBe(all.alt01.records[0].timeMs);
    expect(all.gun01.records[0].stationId).toBe("gun01");
  });

  test("one station is pulled out of the shared reply by name", () => {
    const one = coagmet.parseObservations(TWO, { stationId: "alt01" });
    expect(one.stationId).toBe("alt01");
    expect(one.records).toHaveLength(4);
    expect(() => coagmet.parseObservations(TWO, { stationId: "nope01" }))
      .toThrow(expect.objectContaining({ code: "unknown-station" }));
  });
});

describe("the reader, against the fixtures", () => {
  function source(table) {
    const doFetch = fetcher(Object.assign({ "metadata.json": ok(METADATA) }, table || {}));
    return { source: coagmet.createCoagmetSource({ fetch: doFetch }), fetch: doFetch };
  }

  test("search reads the catalogue once and filters it here", async () => {
    const s = source();
    const found = await s.source.search("gunnison");
    expect(found.map(function (x) { return x.id; })).toContain("gun01");
    await s.source.search("akron");
    // One catalogue request, not two: the whole thing is 50 KB and there is no
    // search endpoint to call twice.
    expect(s.fetch.asked.filter(function (u) { return u.indexOf("metadata") >= 0; })).toHaveLength(1);
  });

  test("a station not in the catalogue is refused before a window is fetched", async () => {
    const s = source();
    await expect(s.source.station("zzz99")).rejects.toMatchObject({ code: "unknown-station" });
  });

  test("an hourly-only station is asked for hourly data, not for blanks", async () => {
    const s = source({ "hourly/akr02.json": ok(HOURLY) });
    await s.source.observations("akr02", {
      start: new Date("2026-08-01T20:00:00Z"),
      end: new Date("2026-08-01T22:00:00Z")
    });
    expect(s.fetch.asked.some(function (u) { return u.indexOf("/hourly/akr02.json") >= 0; })).toBe(true);
    expect(s.fetch.asked.some(function (u) { return u.indexOf("/5min/akr02.json") >= 0; })).toBe(false);
  });

  test("an id in the wrong case finds the station, and is asked for in the right one", async () => {
    // Every other network here writes its ids in upper case and score-wind.js
    // upper-cases what it is given, so `GUN01` is what actually arrives. The
    // service will not have it: `5min/GUN01.json` answers with the bare string
    // "Invlid request", which is not JSON and carries no error field.
    const s = source({ "5min/gun01.json": ok(FIVE_MIN) });
    const station = await s.source.station("GUN01");
    expect(station.id).toBe("gun01");
    await s.source.observations("GUN01", {
      start: new Date("2026-08-01T20:00:00Z"),
      end: new Date("2026-08-01T21:00:00Z")
    });
    expect(s.fetch.asked.some(function (u) { return u.indexOf("/5min/gun01.json") >= 0; })).toBe(true);
    expect(s.fetch.asked.some(function (u) { return u.indexOf("GUN01") >= 0; })).toBe(false);
  });

  test("the same window is fetched once", async () => {
    const s = source({ "5min/gun01.json": ok(FIVE_MIN) });
    const window = { start: new Date("2026-08-01T20:00:00Z"), end: new Date("2026-08-01T21:00:00Z") };
    const first = await s.source.observations("gun01", window);
    const again = await s.source.observations("gun01", window);
    expect(again).toBe(first);
    expect(s.fetch.asked.filter(function (u) { return u.indexOf("5min/gun01") >= 0; })).toHaveLength(1);
  });

  test("an HTTP failure that is not an unknown station keeps its status", async () => {
    const s = source({ "5min/gun01.json": bad(503, { error: "down" }) });
    await expect(s.source.observations("gun01", { start: 0, end: 60000 }))
      .rejects.toMatchObject({ code: "http-error", detail: { status: 503 } });
  });
});

describe("what the instrument is allowed", () => {
  test("the worse of the two anemometers, because the reply does not say which answered", () => {
    expect(coagmet.COAGMET_INSTRUMENT.speedToleranceMps)
      .toBe(coagmet.ANEMOMETERS["rm-young-03002"].speedToleranceMps);
    expect(coagmet.COAGMET_INSTRUMENT.dirToleranceDeg)
      .toBe(coagmet.ANEMOMETERS["rm-young-03002"].dirToleranceDeg);
    // The calm ceiling is the larger starting threshold: a reported 0.0 means
    // somewhere in 0-1.0 m/s, which is most of the range this network is for.
    expect(coagmet.COAGMET_INSTRUMENT.calmCeilingMps).toBe(1);
  });

  test("the archive's rounding is finer than the RAWS readers', and is not the floor", () => {
    expect(coagmet.COAGMET_QUANTISATION).toEqual({ speedStepMps: 0.01, dirStepDeg: 0.1 });
    expect(coagmet.COAGMET_QUANTISATION.speedStepMps)
      .toBeLessThan(coagmet.COAGMET_INSTRUMENT.speedToleranceMps);
  });
});
