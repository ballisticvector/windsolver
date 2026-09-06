/**
 * The FEMS-against-Synoptic reconciliation, without either service.
 *
 * The tool runs live and its result is in `docs/observations.md`. What is
 * graded here is the comparison itself, because a reconciliation that cannot
 * see a disagreement reports perfect agreement.
 */

"use strict";

const tool = require("../tools/fems-agree.js");

function record(time, speedMps, fromDeg) {
  return { time: time, speedMps: speedMps, fromDeg: fromDeg, calm: speedMps === 0 };
}

describe("how far apart two bearings are", () => {
  test("the gap goes the short way round the compass", () => {
    expect(tool.bearingGapDeg(350, 10)).toBe(20);
    expect(tool.bearingGapDeg(10, 350)).toBe(20);
    expect(tool.bearingGapDeg(0, 180)).toBe(180);
  });

  test("two calms agree; a calm against a bearing is not a small disagreement", () => {
    // One service calling it calm while the other reports 200° is a difference
    // in what the anemometer's threshold is, and averaging it in as 0° would
    // report the two as identical.
    expect(tool.bearingGapDeg(null, null)).toBe(0);
    expect(tool.bearingGapDeg(null, 200)).toBeNull();
  });
});

describe("comparing two readings of the same station", () => {
  test("identical series disagree about nothing", () => {
    const a = [record("2026-09-01T00:57:00.000Z", 3, 200), record("2026-09-01T01:57:00.000Z", 0, null)];
    const out = tool.compare(a, a.slice());
    expect(out.shared).toBe(2);
    expect(out.speedGapMps).toBe(0);
    expect(out.bearingGapDeg).toBe(0);
    expect(out.femsOnly).toEqual([]);
    expect(out.synopticOnly).toEqual([]);
  });

  test("the worst hour is reported, not the mean, because one bad hour is the signal", () => {
    const a = [record("2026-09-01T00:57:00.000Z", 3, 200), record("2026-09-01T01:57:00.000Z", 9, 200)];
    const b = [record("2026-09-01T00:57:00.000Z", 3, 200), record("2026-09-01T01:57:00.000Z", 4, 260)];
    const out = tool.compare(a, b);
    expect(out.speedGapMps).toBe(5);
    expect(out.bearingGapDeg).toBe(60);
    expect(out.worst.time).toBe("2026-09-01T01:57:00.000Z");
  });

  test("an hour only one service has is listed under that service, not scored as zero", () => {
    const a = [record("2026-09-01T00:57:00.000Z", 3, 200)];
    const b = [record("2026-09-01T01:57:00.000Z", 3, 200)];
    const out = tool.compare(a, b);
    expect(out.shared).toBe(0);
    expect(out.femsOnly).toEqual(["2026-09-01T00:57:00.000Z"]);
    expect(out.synopticOnly).toEqual(["2026-09-01T01:57:00.000Z"]);
    expect(out.speedGapMps).toBe(0);
  });

  test("a calm on one side and a wind on the other is counted, not silently maxed", () => {
    const a = [record("2026-09-01T00:57:00.000Z", 0, null)];
    const b = [record("2026-09-01T00:57:00.000Z", 0.5, 200)];
    const out = tool.compare(a, b);
    expect(out.calmDisagreements).toBe(1);
    expect(out.bearingGapDeg).toBe(180);
  });

  test("the tool refuses a flag it does not know rather than ignoring it", () => {
    expect(tool.parseArgs(["--days", "5"])).toEqual({ days: "5" });
    expect(() => tool.parseArgs(["--dayz", "5"])).toThrow(/unrecognised option/);
  });
});
