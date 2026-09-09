/**
 * The sub-hourly clock experiment's arithmetic, without the network.
 *
 * The runner itself needs the HRRR archive and CoAgMet, so what is tested here
 * is the part that decides an answer: how a measured side is averaged around an
 * instant, which single record is nearest one, how the pairing offsets are
 * summarised, how far the model moves between its own instants, and — the one
 * that has produced a wrong answer twice in this project — whether a difference
 * between two arms survives each station being left out.
 */

"use strict";

const clock = require("../tools/subhourly-clock.js");

function record(minute, speedMps, fromDeg) {
  const timeMs = Date.parse("2026-09-01T12:00:00Z") + minute * 60000;
  return { stationId: "a", timeMs: timeMs, time: new Date(timeMs).toISOString(),
    speedMps: speedMps, fromDeg: fromDeg };
}

const INSTANT = Date.parse("2026-09-01T12:00:00Z");

describe("averaging the measured side around a model instant", () => {
  test("averages the vectors, not the speeds and the bearings", () => {
    // 350 degrees and 010 degrees average to north. A scalar mean of the
    // bearings is 180 — the same wind, drawn backwards.
    const got = clock.averageAround([record(-2, 4, 350), record(2, 4, 10)], INSTANT, 5 * 60000);
    expect(got.speedMps).toBeCloseTo(3.94, 2);
    expect(Math.min(got.fromDeg, 360 - got.fromDeg)).toBeLessThan(0.01);
    expect(got.averagedFrom).toBe(2);
  });

  test("takes only the records inside the window", () => {
    const records = [record(-20, 9, 90), record(0, 3, 90), record(20, 9, 90)];
    expect(clock.averageAround(records, INSTANT, 5 * 60000).speedMps).toBeCloseTo(3, 6);
  });

  test("an empty window is absent, not a calm", () => {
    expect(clock.averageAround([record(-30, 5, 180)], INSTANT, 5 * 60000)).toBeNull();
    expect(clock.averageAround([], INSTANT, 5 * 60000)).toBeNull();
  });

  test("a null direction is a calm record and contributes no vector", () => {
    // CoAgMet writes a zero speed with no direction. Treating that as a north
    // wind would turn every calm five minutes into a vote for 000.
    const got = clock.averageAround([record(0, 0, null), record(1, 4, 90)], INSTANT, 5 * 60000);
    expect(got.speedMps).toBeCloseTo(2, 6);
    expect(got.fromDeg).toBeCloseTo(90, 6);
  });
});

describe("the single record nearest an instant", () => {
  test("is the closest one in the window, before or after", () => {
    const records = [record(-4, 1, 90), record(3, 2, 90), record(6, 3, 90)];
    expect(clock.nearestTo(records, INSTANT, 5 * 60000).speedMps).toBe(2);
  });

  test("is absent when nothing is inside the window", () => {
    expect(clock.nearestTo([record(9, 1, 90)], INSTANT, 5 * 60000)).toBeNull();
  });
});

describe("the offsets the pairing actually drew", () => {
  test("reports the mean and the worst, in minutes", () => {
    const got = clock.offsetsOf([{ offsetMs: 60000 }, { offsetMs: -180000 }]);
    expect(got.n).toBe(2);
    expect(got.meanMinutes).toBeCloseTo(2, 6);
    expect(got.maxMinutes).toBeCloseTo(3, 6);
  });

  test("says nothing rather than zero when there are no pairs", () => {
    expect(clock.offsetsOf([])).toEqual({ n: 0, meanMinutes: null, maxMinutes: null });
  });
});

describe("what the model does between its own instants", () => {
  test("measures consecutive quarter hours and skips any other gap", () => {
    const at = function (minute, speedMps, fromDeg) {
      return { timeMs: INSTANT + minute * 60000, speedMps: speedMps, fromDeg: fromDeg };
    };
    const series = new Map([["a", [
      at(0, 3, 350),
      at(15, 4, 10),
      // An hour later: a real gap, and the change across it is not a
      // quarter-hourly one.
      at(75, 9, 180)
    ]]]);
    const got = clock.modelMotion(series);
    expect(got.n).toBe(1);
    expect(got.medianSpeedChangeMps).toBeCloseTo(1, 6);
    expect(got.medianDirectionChangeDeg).toBeCloseTo(20, 6);
  });

  test("reports nothing rather than zero when no two instants are adjacent", () => {
    expect(clock.modelMotion(new Map([["a", []]]))).toEqual({
      n: 0, medianSpeedChangeMps: null, medianDirectionChangeDeg: null
    });
  });
});

describe("whether a difference between arms is one station's", () => {
  /** An arm whose pairs are exactly the errors asked for, station by station. */
  function armOf(name, byStation) {
    const pairs = [];
    for (const id of Object.keys(byStation)) {
      byStation[id].forEach(function (e, i) {
        pairs.push({
          stationId: id,
          timeMs: INSTANT + i * 60000,
          observed: { speedMps: 5, fromDeg: 90, timeMs: INSTANT + i * 60000 },
          sample: { speedMps: 5 + e, fromDeg: 90, timeMs: INSTANT + i * 60000 },
          offsetMs: 0
        });
      });
    }
    return { name: name, pairs: pairs };
  }

  test("says so when one station carries the sign", () => {
    // Two stations agree that the second arm is worse and the third insists it
    // is better by more than they do. The pooled table would still rank them.
    const base = armOf("hourly", { a: [0.1, -0.1], b: [0.1, -0.1], c: [3, -3] });
    const other = armOf("quarter", { a: [0.3, -0.3], b: [0.3, -0.3], c: [0.2, -0.2] });
    const got = clock.leverage([base, other], ["a", "b", "c"]);
    expect(got.stable).toBe(false);
    expect(got.note).toMatch(/quarter against hourly changes when a station is left out/);
    expect(got.heldOut.length).toBe(3);
  });

  test("says so when the sign survives every station leaving", () => {
    const base = armOf("hourly", { a: [0.1, -0.1], b: [0.2, -0.2], c: [0.15, -0.15] });
    const other = armOf("quarter", { a: [0.5, -0.5], b: [0.6, -0.6], c: [0.55, -0.55] });
    const got = clock.leverage([base, other], ["a", "b", "c"]);
    expect(got.stable).toBe(true);
    expect(got.contrasts[0].minChangeMps).toBeGreaterThan(0);
  });

  test("judges each arm's contrast on its own", () => {
    // A worse quarter arm and a better averaged one is the result, not an
    // instability; pooling their signs would report it as one.
    const base = armOf("hourly", { a: [0.3, -0.3], b: [0.3, -0.3], c: [0.3, -0.3] });
    const worse = armOf("quarter", { a: [0.5, -0.5], b: [0.5, -0.5], c: [0.5, -0.5] });
    const better = armOf("quarter+avg", { a: [0.1, -0.1], b: [0.1, -0.1], c: [0.1, -0.1] });
    const got = clock.leverage([base, worse, better], ["a", "b", "c"]);
    expect(got.stable).toBe(true);
    expect(got.contrasts.map(function (c) { return c.arm; })).toEqual(["quarter", "quarter+avg"]);
    expect(got.contrasts[0].minChangeMps).toBeGreaterThan(0);
    expect(got.contrasts[1].maxChangeMps).toBeLessThan(0);
  });

  test("reports nothing at all below three stations", () => {
    const base = armOf("hourly", { a: [0.1], b: [0.2] });
    const other = armOf("quarter", { a: [0.3], b: [0.4] });
    expect(clock.leverage([base, other], ["a", "b"])).toBeNull();
  });
});

describe("the run's own arguments", () => {
  test("a day is read in UTC, never in local time", () => {
    expect(clock.dayMs("2026-09-01")).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(() => clock.dayMs("01/09/2026")).toThrow(/YYYY-MM-DD/);
  });

  test("the box is the stations plus a margin, not their bounding box", () => {
    const box = clock.boxOver([{ lat: 40, lon: -105 }, { lat: 40.1, lon: -104.9 }]);
    expect(box.south).toBeLessThan(40);
    expect(box.north).toBeGreaterThan(40.1);
    expect(box.west).toBeLessThan(-105);
    expect(box.east).toBeGreaterThan(-104.9);
  });

  test("a wind is reported as the direction it comes from", () => {
    // A wind blowing towards the east is a west wind, 270.
    expect(clock.windOf(3, 0).fromDeg).toBeCloseTo(270, 6);
    expect(clock.windOf(0, 0).fromDeg).toBeNull();
  });
});
