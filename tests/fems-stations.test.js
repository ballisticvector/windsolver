/**
 * The parts of the FEMS calibration tool that decide anything.
 *
 * The tool itself needs a Synoptic token and two live services, so what is
 * graded here is the arithmetic it makes its decisions with: whether two
 * stations are the same mast, and which minute a station transmits at. Both
 * produce a plausible answer when they are wrong — a station 24 km away is
 * still a station, and a mode taken over a handful of records is still a
 * number.
 */

"use strict";

const tool = require("../tools/fems-stations.js");

describe("is it the same mast", () => {
  test("a station is no distance from itself", () => {
    const a = { lat: 39.41083, lon: -105.74972 };
    expect(tool.distanceKm(a, a)).toBeCloseTo(0, 9);
  });

  test("the separations that decided the eleven-station map are reproduced", () => {
    // Kenosha Pass: Synoptic 39.41083/-105.74972 against FEMS' own coordinate.
    // 15 m is the same mast surveyed twice; the two portable incident stations
    // that were dropped were 2.8 km and 23.9 km from anything.
    const km = tool.distanceKm(
      { lat: 39.41083, lon: -105.74972 }, { lat: 39.4109, lon: -105.7499 });
    expect(km).toBeLessThan(0.05);
    expect(tool.distanceKm({ lat: 39.41083, lon: -105.74972 }, { lat: 39.4, lon: -105.5 }))
      .toBeGreaterThan(20);
  });

  test("a degree of latitude is about 111 km, which is the sanity check on the formula", () => {
    expect(tool.distanceKm({ lat: 39, lon: -105 }, { lat: 40, lon: -105 })).toBeCloseTo(111.2, 0);
  });
});

describe("which minute does it transmit at", () => {
  test("the slot is the commonest minute, not the first or the mean", () => {
    // A station that misses a transmission and reports late once must not drag
    // the slot to an average minute that it never transmits at.
    const slot = tool.mode([57, 57, 57, 12, 57]);
    expect(slot.value).toBe(57);
    expect(slot.count).toBe(4);
    expect(slot.total).toBe(5);
  });

  test("nothing to go on is reported as nothing, not as midnight", () => {
    expect(tool.mode([])).toEqual({ value: null, count: 0, total: 0 });
  });

  test("the nearest hour is the label FEMS would have written", () => {
    expect(new Date(tool.nearestHourMs(Date.parse("2026-09-03T12:57:00Z"))).toISOString())
      .toBe("2026-09-03T13:00:00.000Z");
    expect(new Date(tool.nearestHourMs(Date.parse("2026-09-03T12:08:00Z"))).toISOString())
      .toBe("2026-09-03T12:00:00.000Z");
    expect(new Date(tool.nearestHourMs(Date.parse("2026-09-03T12:30:00Z"))).toISOString())
      .toBe("2026-09-03T13:00:00.000Z");
  });
});
