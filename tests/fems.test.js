/**
 * Reading a measured wind out of FEMS, the Forest Service's RAWS archive.
 *
 * The tests worth reading are the ones about a reply that is not what it looks
 * like: a blank row that means "no such station" and also means "the station
 * was down", a 0 mph that carries a stale vane azimuth, an hour label that is
 * up to half an hour from the observation and is different per station, and a
 * unit that exists only in a column heading.
 *
 * The fixtures are real FEMS responses, saved as they arrived. No credential is
 * involved — every one of these is a public URL. Regenerate with:
 *
 *   base=https://fems.fs2c.usda.gov/api/climatology/download-weather
 *   common="&dataFormat=csv&dataset=observation"
 *
 *   curl -o tests/fixtures/fems-weather-raws.csv \
 *     "$base?stationIds=50406,51508,53005&startDate=2026-09-03T06:00:00Z&endDate=2026-09-03T12:59:00Z$common"
 *
 *   curl -o tests/fixtures/fems-weather-flagged.csv \
 *     "$base?stationIds=53005&startDate=2020-03-26T15:00:00Z&endDate=2020-03-26T20:59:00Z$common"
 *
 *   curl -o tests/fixtures/fems-weather-gap.csv \
 *     "$base?stationIds=50406&startDate=2026-08-28T09:00:00Z&endDate=2026-08-28T13:59:00Z$common"
 *
 *   curl -o tests/fixtures/fems-weather-unknown.csv \
 *     "$base?stationIds=999999&startDate=2026-09-04T00:00:00Z&endDate=2026-09-04T01:59:00Z$common"
 *
 * `fems-stations.json` is the GraphQL metadata for the same three stations, and
 * `fems-too-large.json` is what a 100-station GET is refused with.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const fems = require("../fems.js");

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

const RAWS = fixture("fems-weather-raws.csv");
const FLAGGED = fixture("fems-weather-flagged.csv");
const GAP = fixture("fems-weather-gap.csv");
const UNKNOWN = fixture("fems-weather-unknown.csv");
const STATIONS = JSON.parse(fixture("fems-stations.json"));
const TOO_LARGE = fixture("fems-too-large.json");

/** The three stations in the weather fixtures, and the minutes they transmit at. */
const MINUTES = { "50406": 57, "51508": 58, "53005": 54 };

const HEADER = fems.parseCsv(RAWS)[0].join(",");

function csv(...rows) {
  return [HEADER].concat(rows).join("\n") + "\n";
}

/** A row of the real 22-column shape, with only what a test cares about set. */
function row(values) {
  const cells = new Array(22).fill("");
  cells[0] = "TEST";
  cells[1] = values.time === undefined ? "2026-09-03T06:00:00Z" : values.time;
  cells[2] = values.type === undefined ? "O" : values.type;
  cells[6] = values.speed === undefined ? "" : String(values.speed);
  cells[7] = values.direction === undefined ? "" : String(values.direction);
  cells[8] = values.gust === undefined ? "" : String(values.gust);
  cells[15] = values.wsFlag === undefined ? "" : String(values.wsFlag);
  cells[16] = values.waFlag === undefined ? "" : String(values.waFlag);
  cells[20] = values.id === undefined ? "53005" : String(values.id);
  return cells.join(",");
}

function read(text, opts) {
  return fems.parseWeatherCsv(text, Object.assign({ transmitMinutes: MINUTES }, opts || {}));
}

function ok(body, type) {
  return {
    ok: true,
    status: 200,
    text: async function () { return body; },
    json: async function () { return typeof body === "string" ? JSON.parse(body) : body; },
    headers: { get: function () { return type || "text/csv"; } }
  };
}

describe("the request, built without making it", () => {
  test("a window becomes the two parameters FEMS takes, to the second", () => {
    const url = new URL(fems.weatherUrl({
      stationIds: [50406, "51508"],
      start: new Date("2026-09-03T06:00:00Z"),
      end: "2026-09-03T12:59:00Z"
    }));
    expect(url.searchParams.get("stationIds")).toBe("50406,51508");
    expect(url.searchParams.get("startDate")).toBe("2026-09-03T06:00:00Z");
    expect(url.searchParams.get("endDate")).toBe("2026-09-03T12:59:00Z");
    expect(url.searchParams.get("dataFormat")).toBe("csv");
    expect(url.searchParams.get("dataset")).toBe("observation");
  });

  test("a Synoptic or WRCC id is refused rather than sent as a station number", () => {
    // FEMS keys on a number. Sending "PCPC2" returns a blank row, which is its
    // reply to a dead hour as well, so the mistake would arrive looking like a
    // station that had nothing to say.
    expect(() => fems.weatherUrl({ stationIds: ["PCPC2"], start: 0, end: 1 }))
      .toThrow(expect.objectContaining({ code: "bad-station-id" }));
    expect(() => fems.weatherUrl({ stationIds: ["CPOR"], start: 0, end: 1 })).toThrow(/station map/);
  });

  test("too many stations for one GET is refused here, not trimmed to fit", () => {
    const many = [];
    for (let i = 0; i < fems.MAX_STATIONS_PER_REQUEST + 1; i++) many.push(50400 + i);
    expect(() => fems.weatherUrl({ stationIds: many, start: 0, end: 1 }))
      .toThrow(expect.objectContaining({ code: "too-many-stations" }));
  });

  test("the batches cover every id exactly once, in order", () => {
    const ids = [];
    for (let i = 0; i < 45; i++) ids.push(String(i));
    const batched = fems.batches(ids, fems.MAX_STATIONS_PER_REQUEST);
    expect(batched.map(function (b) { return b.length; })).toEqual([20, 20, 5]);
    expect([].concat(...batched)).toEqual(ids);
  });

  test("an unreadable time is refused before a request is made", () => {
    expect(() => fems.weatherUrl({ stationIds: [53005], start: "never", end: 1 }))
      .toThrow(expect.objectContaining({ code: "bad-time" }));
  });

  test("the metadata query asks for every station, or for named ones", () => {
    const all = fems.metadataRequest({ all: true });
    expect(all.url).toBe(fems.FEMS_ROOT + "/graphql");
    expect(all.body.variables).toEqual({ returnAll: true, ids: undefined });
    const some = fems.metadataRequest({ stationIds: [53005, 50406] });
    expect(some.body.variables).toEqual({ returnAll: false, ids: "53005,50406" });
  });
});

describe("the CSV itself", () => {
  test("a quoted field keeps its commas and its doubled quotes", () => {
    const rows = fems.parseCsv("a,b\n\"one, two\",\"say \"\"hi\"\"\"\n");
    expect(rows[1]).toEqual(["one, two", "say \"hi\""]);
  });

  test("CRLF and a missing final newline both parse", () => {
    expect(fems.parseCsv("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  test("a body that ends inside a quote is refused, not silently closed", () => {
    expect(() => fems.parseCsv("a,b\n\"unterminated,2\n"))
      .toThrow(expect.objectContaining({ code: "bad-csv" }));
  });

  test("an empty body is a refusal rather than an empty series", () => {
    expect(() => read("")).toThrow(expect.objectContaining({ code: "bad-csv" }));
  });

  test("a missing column is named, not worked around", () => {
    expect(() => read("StationId,DateTime\n")).toThrow(/ObservationType/);
    expect(() => read("StationId,DateTime,ObservationType\n")).toThrow(/WindSpeed/);
    expect(() => read("StationId,DateTime,ObservationType,WindSpeed(mph)\n")).toThrow(/WindAzimuth/);
  });
});

describe("the unit, which lives only in the heading", () => {
  test("mph is converted, and it is the whole difference between right and wrong", () => {
    const one = read(csv(row({ speed: 10, direction: 90 }))).get("53005").records[0];
    expect(one.speedMps).toBeCloseTo(4.4704, 6);
  });

  test("a heading that says m/s is believed, and not converted twice", () => {
    const text = csv(row({ speed: 10 })).replace("WindSpeed(mph)", "WindSpeed(m/s)");
    expect(read(text).get("53005").records[0].speedMps).toBe(10);
  });

  test("a unit nobody has seen throws instead of being read as mph", () => {
    const text = csv(row({ speed: 10 })).replace("WindSpeed(mph)", "WindSpeed(furlongs/fortnight)");
    expect(() => read(text)).toThrow(expect.objectContaining({ code: "bad-unit" }));
  });

  test("a direction column in anything but degrees throws", () => {
    const text = csv(row({ speed: 10 })).replace("WindAzimuth(degrees)", "WindAzimuth(radians)");
    expect(() => read(text)).toThrow(/degrees/);
  });

  test("the gust is converted with its own heading's unit", () => {
    const one = read(csv(row({ speed: 4, direction: 10, gust: 20 }))).get("53005").records[0];
    expect(one.gustMps).toBeCloseTo(20 * 0.44704, 6);
  });
});

describe("what a row means", () => {
  test("the real capture reads as three stations of hourly wind", () => {
    const all = read(RAWS);
    expect([...all.keys()].sort()).toEqual(["50406", "51508", "53005"]);
    const one = all.get("53005");
    expect(one.counts.seen).toBe(one.counts.kept + one.counts.rejected);
    expect(one.records.every(function (r) { return r.speedMps >= 0 && r.speedMps < 40; })).toBe(true);
    expect(one.records.every(function (r) { return r.stationId === "53005"; })).toBe(true);
  });

  test("a direction is put in [0, 360)", () => {
    const records = read(csv(
      row({ speed: 5, direction: 360 }),
      row({ speed: 5, direction: 361, time: "2026-09-03T07:00:00Z" }),
      row({ speed: 5, direction: -10, time: "2026-09-03T08:00:00Z" })
    )).get("53005").records;
    expect(records.map(function (r) { return r.fromDeg; })).toEqual([0, 1, 350]);
  });

  test("a calm keeps no direction, because the vane is below its own threshold", () => {
    // The trap is that FEMS still prints the last azimuth on a 0 mph row, so a
    // reader that takes it at face value scores a wind direction that the
    // instrument was not measuring.
    const one = read(csv(row({ speed: 0, direction: 298 }))).get("53005").records[0];
    expect(one.calm).toBe(true);
    expect(one.speedMps).toBe(0);
    expect(one.fromDeg).toBeNull();
  });

  test("a real calm row in the archive is read the same way", () => {
    const calm = read(GAP).get("50406").records.filter(function (r) { return r.calm; });
    expect(calm.length).toBeGreaterThan(0);
    expect(calm.every(function (r) { return r.fromDeg === null; })).toBe(true);
  });

  test("a speed that is not a number, or is not weather, is rejected and counted", () => {
    const one = read(csv(
      row({ speed: "n/a" }),
      row({ speed: 200, direction: 10, time: "2026-09-03T07:00:00Z" }),
      row({ time: "2026-09-03T08:00:00Z" })
    )).get("53005");
    expect(one.records).toHaveLength(0);
    expect(one.rejected.map(function (r) { return r.code; }))
      .toEqual(["bad-observation", "implausible", "no-wind"]);
  });

  test("the record is the shape the other two readers produce", () => {
    const one = read(csv(row({ speed: 3, direction: 45 }))).get("53005").records[0];
    expect(Object.keys(one)).toEqual(expect.arrayContaining([
      "stationId", "time", "timeMs", "speedMps", "fromDeg", "calm", "gustMps", "quality", "raw"
    ]));
    expect(one.time).toBe(new Date(one.timeMs).toISOString());
  });
});

describe("the blank row, which is three different failures", () => {
  test("an unknown station is a blank row and never becomes an observation", () => {
    const one = read(UNKNOWN).get("999999");
    expect(one.records).toHaveLength(0);
    expect(one.counts.blank).toBe(one.counts.seen);
    expect(one.rejected[0].code).toBe("no-data");
  });

  test("a dead hour inside a live series is dropped, not read as calm", () => {
    // This is the one that would quietly change an answer: a blank row scored
    // as 0 m/s is a calm hour the station never reported, and it drags a mean
    // down without dropping the sample count.
    const one = read(GAP).get("50406");
    expect(one.rejected.some(function (r) { return r.code === "no-data"; })).toBe(true);
    expect(one.records.length).toBeGreaterThan(0);
    expect(one.records.every(function (r) { return r.time !== "2026-08-28T11:00:00Z"; })).toBe(true);
  });

  test("a row type that is not an observation is not one", () => {
    const one = read(csv(row({ type: "F", speed: 5, direction: 10 }))).get("53005");
    expect(one.records).toHaveLength(0);
    expect(one.rejected[0].code).toBe("not-an-observation");
  });

  test("a row that names no station is refused, because it cannot be filed", () => {
    expect(() => read(csv(row({ id: "", speed: 5 })))).toThrow(/names no station/);
  });
});

describe("the timestamp, which is the trap that survives a code review", () => {
  test("a station transmitting late in the hour is labelled the next hour", () => {
    // Measured against Synoptic over 72 hours at eleven stations: the label is
    // the *nearest* hour, so :57 belongs to the hour before the label.
    expect(fems.observationTimeMs(Date.parse("2026-09-03T13:00:00Z"), 57))
      .toBe(Date.parse("2026-09-03T12:57:00Z"));
    expect(fems.observationTimeMs(Date.parse("2026-09-03T13:00:00Z"), 35))
      .toBe(Date.parse("2026-09-03T12:35:00Z"));
  });

  test("a station transmitting early in the hour is labelled its own hour", () => {
    // The half of the rule that an "always round up" reader gets wrong by a
    // whole hour on every row, at three of the eleven stations.
    expect(fems.observationTimeMs(Date.parse("2026-09-03T13:00:00Z"), 8))
      .toBe(Date.parse("2026-09-03T13:08:00Z"));
    expect(fems.observationTimeMs(Date.parse("2026-09-03T13:00:00Z"), 24))
      .toBe(Date.parse("2026-09-03T13:24:00Z"));
  });

  test("the recovered time is at most half an hour from the label, either way", () => {
    for (let minute = 0; minute < 60; minute++) {
      const label = Date.parse("2026-09-03T13:00:00Z");
      const off = fems.observationTimeMs(label, minute) - label;
      expect(Math.abs(off)).toBeLessThanOrEqual(30 * 60 * 1000);
    }
  });

  test("a record carries both times, so a bad pairing can be traced", () => {
    const one = read(csv(row({ speed: 5, direction: 10, time: "2026-09-03T13:00:00Z" }))).get("53005");
    expect(one.records[0].hourLabel).toBe("2026-09-03T13:00:00.000Z");
    expect(one.records[0].time).toBe("2026-09-03T12:54:00.000Z");
    expect(one.records[0].transmitMinute).toBe(54);
    expect(one.records[0].timeIsHourBin).toBe(false);
  });

  test("an uncalibrated station is refused rather than scored on the hour label", () => {
    const one = fems.parseWeatherCsv(csv(row({ speed: 5, direction: 10 })), { transmitMinutes: {} })
      .get("53005");
    expect(one.records).toHaveLength(0);
    expect(one.rejected[0].code).toBe("no-transmit-minute");
    expect(one.rejected[0].reason).toMatch(/fems-stations\.js/);
  });

  test("hourBins is the opt-out, and every record it makes says so", () => {
    const one = fems.parseWeatherCsv(csv(row({ speed: 5, direction: 10 })),
      { transmitMinutes: {}, hourBins: true }).get("53005");
    expect(one.records[0].timeIsHourBin).toBe(true);
    expect(one.records[0].transmitMinute).toBeNull();
    expect(one.records[0].time).toBe("2026-09-03T06:00:00.000Z");
  });

  test("an unreadable timestamp is rejected, not turned into 1970", () => {
    const one = read(csv(row({ time: "yesterday", speed: 5 }))).get("53005");
    expect(one.records).toHaveLength(0);
    expect(one.rejected[0].code).toBe("bad-time");
  });
});

describe("the QC flags, whose meaning is not published", () => {
  test("a flagged historical row is kept, marked and counted", () => {
    // Nothing FEMS publishes says what 1 and 2 mean. Dropping them would be a
    // decision about the sample taken inside a parser; keeping them silently
    // would hide it. So: kept, labelled, and counted where a report can see it.
    const one = read(FLAGGED).get("53005");
    expect(one.counts.flagged).toBeGreaterThan(0);
    const flagged = one.records.filter(function (r) { return r.quality; });
    expect(flagged.length).toBe(one.counts.flagged);
    expect(flagged[0].quality).toMatch(/^W[SA]=/);
  });

  test("recent rows carry no flags at all, because QC is a later pass", () => {
    const one = read(RAWS).get("53005");
    expect(one.counts.flagged).toBe(0);
    expect(one.records.every(function (r) { return r.quality === null; })).toBe(true);
  });

  test("a caller that has decided what a flag means can drop those rows", () => {
    const text = csv(
      row({ speed: 5, direction: 10, wsFlag: 2 }),
      row({ speed: 6, direction: 20, wsFlag: 0, time: "2026-09-03T07:00:00Z" })
    );
    const kept = read(text).get("53005");
    expect(kept.records).toHaveLength(2);
    const dropped = read(text, { rejectFlags: ["2"] }).get("53005");
    expect(dropped.records).toHaveLength(1);
    expect(dropped.rejected[0].code).toBe("bad-quality");
  });
});

describe("the station metadata", () => {
  test("a station is placed, named and given its provenance", () => {
    const parsed = fems.parseStations(STATIONS);
    const kenosha = parsed.find(function (s) { return s.id === "53005"; });
    expect(kenosha.name).toBe("KENOSHA PASS");
    expect(kenosha.wrccId).toBe("CKEN");
    expect(kenosha.lat).toBeCloseTo(39.41083, 5);
    expect(kenosha.lon).toBeCloseTo(-105.74972, 5);
    expect(kenosha.network).toBe("RAWS");
    expect(kenosha.source).toBe("fems");
  });

  test("the unitless elevation is read as feet, and the foot is kept beside it", () => {
    // FEMS says nothing about the unit. Kenosha Pass is 10,200 ft; as metres it
    // would be higher than the troposphere, which is why this is tolerable and
    // also why the assumption is written down rather than inlined.
    const kenosha = fems.parseStations(STATIONS).find(function (s) { return s.id === "53005"; });
    expect(kenosha.elevationFt).toBe(10200);
    expect(kenosha.elevationM).toBeCloseTo(10200 * 0.3048, 6);
  });

  test("FEMS publishes no anemometer height, and none is invented", () => {
    const parsed = fems.parseStations(STATIONS);
    expect(parsed.every(function (s) { return s.sensorHeightM === null; })).toBe(true);
  });

  test("a GraphQL error is a refusal even though it arrives as an answer", () => {
    expect(() => fems.parseStations({ errors: [{ message: "no" }] }))
      .toThrow(expect.objectContaining({ code: "fems-refused" }));
    expect(() => fems.parseStations({ data: {} }))
      .toThrow(expect.objectContaining({ code: "bad-response" }));
  });

  test("a station off the planet is refused rather than placed", () => {
    expect(() => fems.parseStations({
      data: { stationMetaData: { data: [{ station_id: 1, latitude: 91, longitude: 0 }] } }
    })).toThrow(/position on Earth/);
  });
});

describe("the source, with fetch injected", () => {
  const MAP = {
    PCPC2: { femsId: "50406", wrccId: "CPOR", transmitMinute: 57, sensorHeightM: 6.1,
      sensorHeightSource: "synoptic", calibratedAgainst: { source: "synoptic", agreement: 1 } },
    STOC2: { femsId: "51508", transmitMinute: 58 },
    KSHC2: { femsId: "53005", transmitMinute: 54 }
  };
  const WINDOW = { start: "2026-09-03T06:00:00Z", end: "2026-09-03T12:00:00Z" };

  function source(handler, extra) {
    return fems.createFemsSource(Object.assign({
      fetch: handler,
      stations: MAP,
      stationIds: ["PCPC2", "STOC2", "KSHC2"]
    }, extra || {}));
  }

  test("the caller's own id survives the round trip, and the FEMS number rides along", async () => {
    const s = source(async function () { return ok(JSON.stringify(STATIONS)); });
    const station = await s.station("PCPC2");
    expect(station.id).toBe("PCPC2");
    expect(station.femsId).toBe("50406");
    expect(station.transmitMinute).toBe(57);
    expect(station.calibratedAgainst.source).toBe("synoptic");
  });

  test("the anemometer height comes from the calibration map, measured not assumed", async () => {
    // FEMS does not publish it and a missing height stops the model being moved
    // to the sensor, which is 8.5% of the wind in the direction that makes HRRR
    // look fast. `tools/fems-stations.js` carries Synoptic's survey across.
    const s = source(async function () { return ok(JSON.stringify(STATIONS)); });
    expect((await s.station("PCPC2")).sensorHeightM).toBe(6.1);
    expect((await s.station("PCPC2")).sensorHeightSource).toBe("synoptic");
    expect((await s.station("STOC2")).sensorHeightM).toBeNull();
  });

  test("a window is one request for every station, not one each", async () => {
    const urls = [];
    const s = source(async function (url, init) {
      if (init && init.method === "POST") return ok(JSON.stringify(STATIONS));
      urls.push(url);
      return ok(RAWS);
    });
    await s.observations("PCPC2", WINDOW);
    await s.observations("KSHC2", WINDOW);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("stationIds")).toBe("50406,51508,53005");
  });

  test("the asked-for window is widened by an hour, because the label is not the time", async () => {
    let asked = null;
    const s = source(async function (url) { asked = url; return ok(RAWS); });
    await s.observations("PCPC2", WINDOW);
    const params = new URL(asked).searchParams;
    expect(params.get("startDate")).toBe("2026-09-03T05:00:00Z");
    expect(params.get("endDate")).toBe("2026-09-03T13:00:00Z");
  });

  test("more stations than one GET allows are batched, and none is dropped", async () => {
    const map = {};
    const ids = [];
    for (let i = 0; i < 25; i++) {
      map["S" + i] = { femsId: String(50400 + i), transmitMinute: 30 };
      ids.push("S" + i);
    }
    const sent = [];
    const s = fems.createFemsSource({
      stations: map,
      stationIds: ids,
      fetch: async function (url) {
        sent.push(new URL(url).searchParams.get("stationIds").split(","));
        return ok(RAWS);
      }
    });
    await s.observations("S0", WINDOW).catch(function () { /* the fixture has other ids */ });
    expect(sent).toHaveLength(2);
    expect([].concat(...sent)).toHaveLength(25);
  });

  test("a 400 is a refusal carrying what FEMS said, not an empty series", async () => {
    const s = source(async function () {
      return { ok: false, status: 400, text: async function () { return TOO_LARGE; } };
    });
    await expect(s.observations("PCPC2", WINDOW)).rejects.toThrow(/Large requests/);
    await expect(s.observations("PCPC2", WINDOW)).rejects.toThrow(
      expect.objectContaining({ code: "observations-unavailable" }));
  });

  test("all-blank is a refusal, because it is also how FEMS says the station does not exist", async () => {
    const s = fems.createFemsSource({
      stations: { X: { femsId: "999999", transmitMinute: 30 } },
      stationIds: ["X"],
      fetch: async function () { return ok(UNKNOWN); }
    });
    await expect(s.observations("X", WINDOW)).rejects.toThrow(
      expect.objectContaining({ code: "no-observations" }));
  });

  test("a station FEMS does not mention at all is a different failure again", async () => {
    const s = source(async function () { return ok(GAP); });
    await expect(s.observations("KSHC2", WINDOW)).rejects.toThrow(
      expect.objectContaining({ code: "unknown-station" }));
  });

  test("the series is read once and served from memory for the same window", async () => {
    let calls = 0;
    const s = source(async function () { calls++; return ok(RAWS); });
    await s.observations("PCPC2", WINDOW);
    await s.observations("STOC2", WINDOW);
    await s.observations("KSHC2", WINDOW);
    expect(calls).toBe(1);
  });
});
