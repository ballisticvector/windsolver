/**
 * Reading a measured wind.
 *
 * The tests that matter here are the ones about the observations that are *not*
 * what they look like: a calm that reports 0° like a northerly, a preliminary
 * record nothing has quality-checked, and a unit string that changed. All three
 * produce an ordinary-looking number if they are taken at face value, and a
 * verification score built on them is worse than no score at all.
 *
 * The fixture is a real two-day window of Boulder Municipal Airport (KBDU)
 * observations from api.weather.gov, trimmed to the properties this reader
 * uses. Regenerate with:
 *
 *   curl -H 'User-Agent: (windsolver.com, dev)' \
 *     'https://api.weather.gov/stations/KBDU/observations?start=2026-09-01T00:00:00Z&end=2026-09-03T00:00:00Z'
 */

"use strict";

const fs = require("fs");
const path = require("path");

const observations = require("../observations.js");

const OBSERVATIONS = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "nws-kbdu-observations.json"), "utf8"));
const STATION = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "nws-kbdu-station.json"), "utf8"));

function feature(props) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-105.23, 40.03] },
    properties: Object.assign({
      stationId: "KTEST",
      timestamp: "2026-09-01T12:00:00+00:00",
      windSpeed: { unitCode: "wmoUnit:km_h-1", value: 18, qualityControl: "V" },
      windDirection: { unitCode: "wmoUnit:degree_(angle)", value: 270, qualityControl: "V" },
      windGust: { unitCode: "wmoUnit:km_h-1", value: null, qualityControl: "Z" }
    }, props)
  };
}

function collection(features) {
  return { type: "FeatureCollection", features: features };
}

describe("a station's metadata", () => {
  test("it reads the surveyed position, which is not the one on an observation", () => {
    const station = observations.parseStation(STATION);
    expect(station.id).toBe("KBDU");
    expect(station.lat).toBeCloseTo(40.0394297, 6);
    expect(station.lon).toBeCloseTo(-105.2258217, 6);
    expect(station.elevationM).toBeCloseTo(1611.78, 2);

    // The same station's observations carry coordinates rounded to 0.01°,
    // which is ~1.1 km away — a different hillside at 1 m terrain resolution,
    // and the reason a station is never located from an observation.
    const observed = OBSERVATIONS.features[0].geometry.coordinates;
    expect(Math.abs(observed[1] - station.lat)).toBeGreaterThan(0.005);
  });

  test("it refuses a feature that is not a point on Earth", () => {
    expect(() => observations.parseStation({})).toThrow(/GeoJSON Point/);
    expect(() => observations.parseStation({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-105.2, 91] },
      properties: { stationIdentifier: "KBDU" }
    })).toThrow(/position on Earth/);
  });
});

describe("the real KBDU window", () => {
  const read = observations.parseObservations(OBSERVATIONS);

  test("it keeps the quality-controlled records and drops the rest", () => {
    expect(read.stationId).toBe("KBDU");
    expect(read.counts.seen).toBe(144);
    expect(read.counts.kept).toBe(139);
    expect(read.counts.rejected).toBe(5);
    // The five dropped are the preliminary specials: nothing has checked them.
    expect(read.rejected.every((r) => r.code === "bad-quality")).toBe(true);
  });

  test("a quarter of the window is calm, and no calm carries a direction", () => {
    expect(read.counts.calm).toBe(37);
    for (const record of read.records) {
      if (record.calm) expect(record.fromDeg).toBeNull();
    }
    // 139 kept, 37 of them calm, and every remaining record had a direction.
    expect(read.counts.withDirection).toBe(102);
  });

  test("it converts km/h to m/s, and the raw METAR agrees", () => {
    const record = read.records.find((r) => /\d{5}KT/.test(r.raw || "") && !r.calm);
    const knots = Number(/(\d{3})(\d{2})KT/.exec(record.raw)[2]);
    const degrees = Number(/(\d{3})(\d{2})KT/.exec(record.raw)[1]);
    expect(record.speedMps).toBeCloseTo(knots * observations.MPS_PER_KNOT, 1);
    expect(record.fromDeg).toBe(degrees % 360);
  });

  test("it hands back one series in time order, oldest first", () => {
    for (let i = 1; i < read.records.length; i++) {
      expect(read.records[i].timeMs).toBeGreaterThanOrEqual(read.records[i - 1].timeMs);
    }
  });
});

describe("the observations that lie", () => {
  test("a calm is not a wind out of the north", () => {
    const read = observations.parseObservations(collection([feature({
      windSpeed: { unitCode: "wmoUnit:km_h-1", value: 0, qualityControl: "V" },
      windDirection: { unitCode: "wmoUnit:degree_(angle)", value: 0, qualityControl: "V" }
    })]));
    expect(read.records[0].calm).toBe(true);
    expect(read.records[0].speedMps).toBe(0);
    expect(read.records[0].fromDeg).toBeNull();
  });

  test("360° is north, written the way the rest of the engine writes it", () => {
    const read = observations.parseObservations(collection([feature({
      windDirection: { unitCode: "wmoUnit:degree_(angle)", value: 360, qualityControl: "V" }
    })]));
    expect(read.records[0].fromDeg).toBe(0);
  });

  test("a variable direction keeps its speed and loses its bearing", () => {
    const read = observations.parseObservations(collection([feature({
      windDirection: { unitCode: "wmoUnit:degree_(angle)", value: null, qualityControl: "V" }
    })]));
    expect(read.records[0].fromDeg).toBeNull();
    expect(read.records[0].calm).toBe(false);
    expect(read.records[0].speedMps).toBeGreaterThan(0);
  });

  test("an unchecked record is dropped with a reason, not scored", () => {
    const read = observations.parseObservations(collection([feature({
      windSpeed: { unitCode: "wmoUnit:km_h-1", value: 18, qualityControl: "Z" }
    })]));
    expect(read.records).toHaveLength(0);
    expect(read.rejected[0].code).toBe("bad-quality");
    expect(read.rejected[0].reason).toMatch(/Z/);
  });

  test("a unit this reader does not know throws instead of being assumed", () => {
    expect(() => observations.parseObservations(collection([feature({
      windSpeed: { unitCode: "wmoUnit:furlong_fortnight-1", value: 18, qualityControl: "V" }
    })]))).toThrow(/does not know/);
  });

  test("m/s and knots are read as themselves", () => {
    expect(observations.speedToMps({ unitCode: "wmoUnit:m_s-1", value: 5 }, "x")).toBe(5);
    expect(observations.speedToMps({ unitCode: "wmoUnit:kt", value: 10 }, "x"))
      .toBeCloseTo(5.1444, 3);
  });

  test("a hurricane at an inland airport is dropped as implausible", () => {
    const read = observations.parseObservations(collection([feature({
      windSpeed: { unitCode: "wmoUnit:km_h-1", value: 900, qualityControl: "V" }
    })]));
    expect(read.records).toHaveLength(0);
    expect(read.rejected[0].code).toBe("implausible");
  });

  test("an unreadable timestamp is dropped, not coerced", () => {
    const read = observations.parseObservations(collection([feature({ timestamp: "soon" })]));
    expect(read.records).toHaveLength(0);
    expect(read.rejected[0].code).toBe("bad-time");
  });

  test("a body that is not a feature collection is refused", () => {
    expect(() => observations.parseObservations({ ok: true })).toThrow(/features array/);
  });
});

describe("the URLs", () => {
  test("a window becomes ISO instants", () => {
    const url = observations.observationsUrl("kbdu", {
      start: "2026-09-01T00:00:00Z",
      end: new Date(Date.UTC(2026, 8, 3))
    });
    expect(url).toContain("/stations/KBDU/observations");
    expect(url).toContain("start=2026-09-01T00%3A00%3A00.000Z");
    expect(url).toContain("end=2026-09-03T00%3A00%3A00.000Z");
  });

  test("a time that is not a time is refused before the request", () => {
    expect(() => observations.observationsUrl("KBDU", { start: "last tuesday" }))
      .toThrow(/not a time/);
  });
});

describe("the network half", () => {
  test("it identifies itself, because the weather service answers 403 otherwise", async () => {
    const seen = [];
    const source = observations.createObservationSource({
      fetch: async function (url, init) {
        seen.push({ url: url, headers: init.headers });
        return { ok: true, status: 200, json: async () => STATION };
      }
    });
    const station = await source.station("KBDU");
    expect(station.id).toBe("KBDU");
    expect(seen[0].headers["user-agent"]).toMatch(/windsolver/);
  });

  test("a refusal from the weather service is an error with its status on it", async () => {
    const source = observations.createObservationSource({
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) })
    });
    await expect(source.observations("KBDU", {})).rejects.toMatchObject({
      code: "observations-unavailable",
      status: 503
    });
  });
});
