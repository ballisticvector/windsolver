/**
 * Reading NCEI's ASOS one-minute page 1, and pricing a pairing tolerance with it.
 *
 * The tests worth reading are the ones about a record that is not what it looks
 * like: a missing wind written as the letter `M` beside a wind that is really
 * there, a fixed-width line whose neighbouring fields move while the wind's do
 * not, a date in local standard time with only a UTC clock to carry the day
 * over, and a station-month NCEI serves as 200 and nothing.
 *
 * The fixtures are real records, saved as they arrived. No credential is
 * involved — the archive is public. Regenerate with:
 *
 *   root=https://www.ncei.noaa.gov/data/automated-surface-observing-system-one-minute-pg1/access
 *   curl -s "$root/2026/03/asos-1min-pg1-KRTN-202603.dat" > /tmp/krtn.dat
 *
 *   awk 'substr($0,14,8)=="20260315"' /tmp/krtn.dat \
 *     > tests/fixtures/asos-1min-pg1-KRTN-20260315.dat
 *
 *   { awk 'substr($0,14,12)>="202603011152" && substr($0,14,12)<="202603011158"' /tmp/krtn.dat
 *     awk 'substr($0,14,12)>="202603042350" && substr($0,14,12)<="202603042353"' /tmp/krtn.dat
 *     printf '23052KRTN RTN20260304235\n'
 *   } > tests/fixtures/asos-1min-pg1-KRTN-edge.dat
 *
 * The last line of the edge fixture is a truncated record, added by hand: NCEI
 * does not serve one, and a reader that indexes into columns that are not there
 * should say so rather than read `undefined` as a wind.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const asos1min = require("../asos1min.js");
const decorrelation = require("../tools/wind-decorrelation.js");

const FIXTURES = path.join(__dirname, "fixtures");

function read(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "latin1");
}

const DAY = read("asos-1min-pg1-KRTN-20260315.dat");
const EDGE = read("asos-1min-pg1-KRTN-edge.dat");

describe("reading a page-1 record", () => {
  test("a day of Raton is 1440 minutes, and every one of them has a wind", () => {
    const parsed = asos1min.parsePageOne(DAY);
    expect(parsed.station).toBe("KRTN");
    expect(parsed.records).toHaveLength(1440);
    expect(parsed.absent).toBe(0);
    expect(parsed.malformed).toBe(0);
  });

  test("the wind is read out of its own columns, not out of the visibility beside it", () => {
    const first = asos1min.parsePageOne(DAY).records[0];
    expect(first.dirDeg).toBe(285);
    expect(first.speedMps).toBeCloseTo(22 * asos1min.KNOT_MPS, 6);
    expect(first.peakDirDeg).toBe(282);
    expect(first.peakMps).toBeCloseTo(28 * asos1min.KNOT_MPS, 6);
  });

  test("the local date and the UTC clock together give the instant, over midnight", () => {
    // 2026-03-04 23:50 LST at Raton is 06:50Z on the 5th: the record carries the
    // 5th's clock and the 4th's date, and only the two together say which day.
    const parsed = asos1min.parsePageOne(EDGE);
    const late = parsed.records.find(function (r) { return r.speedMps > 0; });
    expect(late).toBeDefined();
    expect(asos1min.utcTime("202603042350", "0650").toISOString())
      .toBe("2026-03-05T06:50:00.000Z");
    expect(asos1min.utcTime("202603151200", "1900").toISOString())
      .toBe("2026-03-15T19:00:00.000Z");
  });

  test("a missing wind is the letter M, and it is absence rather than calm", () => {
    const parsed = asos1min.parsePageOne(EDGE);
    // Four consecutive minutes report `M` for speed and direction.
    expect(parsed.absent).toBe(4);
    for (const r of parsed.records) expect(Number.isFinite(r.speedMps)).toBe(true);
    // And none of them became a zero: the only zeroes here are reported zeroes.
    const zeroes = parsed.records.filter(function (r) { return r.speedMps === 0; });
    expect(zeroes).toHaveLength(3);
  });

  test("a reported 0 keeps its number and is marked calm, because it is a ceiling", () => {
    const parsed = asos1min.parsePageOne(EDGE);
    const zero = parsed.records.find(function (r) { return r.speedMps === 0; });
    expect(zero.calm).toBe(true);
    // The vane azimuth beside a calm is kept rather than dropped, and is not
    // evidence: 152 degrees at 0 kt is what the vane was last showing.
    expect(zero.dirDeg).toBe(152);
    expect(asos1min.CALM_CEILING_MPS).toBeCloseTo(1.0289, 4);
  });

  test("a line too short to hold a wind is malformed, not a calm minute", () => {
    const parsed = asos1min.parsePageOne(EDGE);
    expect(parsed.malformed).toBe(1);
  });

  test("a file with no wind in it at all is a refusal when the caller asks for one", () => {
    expect(function () {
      asos1min.parsePageOne("", { requireRecords: true, what: "nothing.dat" });
    }).toThrow(/no page-1 wind records/);
  });
});

describe("fetching a station-month", () => {
  test("the URL is the one NCEI publishes", () => {
    expect(asos1min.monthUrl("krtn", 2026, 3)).toBe(
      "https://www.ncei.noaa.gov/data/automated-surface-observing-system-one-minute-pg1/" +
      "access/2026/03/asos-1min-pg1-KRTN-202603.dat");
  });

  test("200 with an empty body is refused, because NCEI answers a missing month that way", async () => {
    const fetch = async function () {
      return { ok: true, status: 200, text: async function () { return ""; } };
    };
    await expect(asos1min.fetchMonth({ station: "KRTN", year: 2025, month: 9, fetch: fetch }))
      .rejects.toThrow(/empty body/);
  });

  test("200 with an HTML page is refused too", async () => {
    const fetch = async function () {
      return { ok: true, status: 200, text: async function () { return "<html>nope</html>"; } };
    };
    await expect(asos1min.fetchMonth({ station: "KRTN", year: 2026, month: 3, fetch: fetch }))
      .rejects.toThrow(/HTML/);
  });

  test("a real month comes back with its text, so a cache never has to ask twice", async () => {
    const fetch = async function () {
      return { ok: true, status: 200, text: async function () { return DAY; } };
    };
    const got = await asos1min.fetchMonth({ station: "KRTN", year: 2026, month: 3, fetch: fetch });
    expect(got.records).toHaveLength(1440);
    expect(got.text).toBe(DAY);
  });
});

describe("what the wind does while nobody is looking", () => {
  const records = asos1min.parsePageOne(DAY).records;

  test("the difference from a minute to itself is zero, and grows with the gap", () => {
    const curve = asos1min.decorrelation(records, { maxLagMin: 60 });
    expect(curve[0].speedRmsMps).toBe(0);
    expect(curve[0].dirRmsDeg).toBe(0);
    expect(curve[1].speedRmsMps).toBeGreaterThan(0);
    expect(curve[30].speedRmsMps).toBeGreaterThan(curve[10].speedRmsMps);
    expect(curve[60].speedRmsMps).toBeGreaterThan(curve[30].speedRmsMps);
    // A whole day of minutes: every lag has nearly 1440 pairs in it.
    expect(curve[30].n).toBeGreaterThan(1300);
  });

  test("a tolerance is priced over the whole window, not at its far end", () => {
    const curve = asos1min.decorrelation(records, { maxLagMin: 60 });
    const window = asos1min.overWindow(curve, 30);
    expect(window.toleranceMin).toBe(30);
    expect(window.speedRmsMps).toBeLessThan(curve[30].speedRmsMps);
    expect(window.speedRmsMps).toBeGreaterThan(curve[1].speedRmsMps);
  });

  test("the lag at which the wind moves further than the sensor's own tolerance", () => {
    const curve = asos1min.decorrelation(records, { maxLagMin: 90 });
    const lag = asos1min.crossing(curve, 2 * asos1min.KNOT_MPS);
    expect(lag).toBeGreaterThan(0);
    expect(lag).toBeLessThan(90);
    // It is a crossing of the curve, so the curve is below the level before it
    // and at or above it after.
    expect(curve[Math.floor(lag)].speedRmsMps).toBeLessThanOrEqual(2 * asos1min.KNOT_MPS);
    expect(curve[Math.ceil(lag)].speedRmsMps).toBeGreaterThanOrEqual(2 * asos1min.KNOT_MPS);
  });

  test("a calm minute is left out of the direction statistic and kept in the speed one", () => {
    const calm = [
      { time: new Date("2026-03-15T00:00:00Z"), speedMps: 0, dirDeg: 10, calm: true },
      { time: new Date("2026-03-15T00:01:00Z"), speedMps: 0, dirDeg: 200, calm: true },
      { time: new Date("2026-03-15T00:02:00Z"), speedMps: 8, dirDeg: 200, calm: false },
      { time: new Date("2026-03-15T00:03:00Z"), speedMps: 9, dirDeg: 210, calm: false }
    ];
    const curve = asos1min.decorrelation(calm, { maxLagMin: 1 });
    expect(curve[1].n).toBe(3);
    // Only the one pair where both minutes are above the calm ceiling.
    expect(curve[1].nDirection).toBe(1);
    expect(curve[1].dirRmsDeg).toBeCloseTo(10, 6);
  });

  test("averaging first makes the same wind look steadier", () => {
    const blocked = asos1min.blockMean(records, 10);
    expect(blocked.length).toBeGreaterThan(1400);
    const raw = asos1min.overWindow(asos1min.decorrelation(records, { maxLagMin: 30 }), 30);
    const smooth = asos1min.overWindow(asos1min.decorrelation(blocked, { maxLagMin: 30 }), 30);
    expect(smooth.speedRmsMps).toBeLessThan(raw.speedRmsMps);
  });

  test("a block mean is a vector mean, so two opposing minutes do not average to a wind", () => {
    const opposed = [
      { time: new Date("2026-03-15T00:00:00Z"), speedMps: 5, dirDeg: 0, calm: false },
      { time: new Date("2026-03-15T00:01:00Z"), speedMps: 5, dirDeg: 180, calm: false }
    ];
    const mean = asos1min.blockMean(opposed, 2);
    expect(mean).toHaveLength(1);
    expect(mean[0].speedMps).toBeCloseTo(0, 9);
  });

  test("interpolating between the hours either side beats taking the nearer one", () => {
    const hourly = asos1min.againstWholeHour(records);
    expect(hourly.n).toBeGreaterThan(1300);
    expect(hourly.nearest.speedRmsMps).toBeGreaterThan(0);
    expect(hourly.interpolated.speedRmsMps).toBeLessThan(hourly.nearest.speedRmsMps);
    expect(hourly.interpolated.dirRmsDeg).toBeLessThan(hourly.nearest.dirRmsDeg);
  });

  test("a whole-hour minute is exactly its own nearest hour", () => {
    const hour = [
      { time: new Date("2026-03-15T01:00:00Z"), speedMps: 4, dirDeg: 90, calm: false },
      { time: new Date("2026-03-15T02:00:00Z"), speedMps: 4, dirDeg: 90, calm: false }
    ];
    const hourly = asos1min.againstWholeHour(hour);
    expect(hourly.nearest.speedRmsMps).toBe(0);
  });

  test("the change is split by how hard the wind was blowing", () => {
    const bins = asos1min.bySpeed(records, { lagMin: 30 });
    expect(bins).toHaveLength(4);
    expect(bins[bins.length - 1].toMps).toBe(Infinity);
    const used = bins.filter(function (b) { return b.n > 50; });
    expect(used.length).toBeGreaterThan(1);
    for (const bin of used) {
      expect(bin.meanSpeedMps).toBeGreaterThanOrEqual(bin.fromMps);
      expect(bin.relative).toBeCloseTo(bin.speedRmsMps / bin.meanSpeedMps, 9);
    }
  });

  test("a bearing difference wraps the short way round", () => {
    expect(asos1min.bearingDifference(350, 10)).toBe(-20);
    expect(asos1min.bearingDifference(10, 350)).toBe(20);
    // Exactly opposed goes to the negative end rather than the positive one.
    // Squared for an RMS either way, but it should be stated rather than found.
    expect(asos1min.bearingDifference(180, 0)).toBe(-180);
  });

  test("a direction the wind is from becomes a vector pointing where it is going", () => {
    const v = asos1min.toVector({ speedMps: 5, dirDeg: 270 });
    expect(v.east).toBeCloseTo(5, 9);
    expect(v.north).toBeCloseTo(0, 9);
    const back = asos1min.fromVector(v.east, v.north);
    expect(back.speedMps).toBeCloseTo(5, 9);
    expect(back.dirDeg).toBeCloseTo(270, 9);
  });
});

describe("the tool that reports it", () => {
  test("a file is analysed without asking NCEI for anything", async () => {
    const parsed = asos1min.parsePageOne(DAY);
    const report = await decorrelation.run({
      sources: [Object.assign({ station: "KRTN" }, parsed)],
      minRecords: 0,
      maxLagMin: 60
    });
    expect(report.stations).toHaveLength(1);
    expect(report.stations[0].n).toBe(1440);
    expect(report.toleranceMin).toBe(30);
    expect(report.pooled.window.speedRmsMps).toBeGreaterThan(0);
    expect(report.pooled.window.vectorRmsMps)
      .toBeGreaterThan(report.pooled.window.speedRmsMps);
    // A 10-minute mean cannot swing as far as the minutes inside it.
    expect(report.pooled.blockCurve[30].vectorRmsMps)
      .toBeLessThan(report.pooled.curve[30].vectorRmsMps);
    const text = decorrelation.summarise(report);
    expect(text).toContain("KRTN");
    expect(text).toContain("NCEI DSI-6405");
  });

  test("a station-month too short to mean anything is skipped and said so", async () => {
    const parsed = asos1min.parsePageOne(EDGE);
    const report = await decorrelation.run({
      sources: [Object.assign({ station: "KRTN" }, parsed)],
      maxLagMin: 10
    });
    expect(report.stations).toHaveLength(0);
    expect(report.skipped).toEqual([{ station: "KRTN", n: 7, url: null, refused: null }]);
  });

  test("the offsets a run actually drew are priced, not the window it was allowed", async () => {
    const parsed = asos1min.parsePageOne(DAY);
    const report = await decorrelation.run({
      sources: [Object.assign({ station: "KRTN" }, parsed)],
      minRecords: 0,
      maxLagMin: 60
    });
    const runFile = path.join(os.tmpdir(), "asos1min-pairs-" + process.pid + ".json");
    fs.writeFileSync(runFile, JSON.stringify({
      pairs: [
        { offsetMinutes: 2 }, { offsetMinutes: -2 },
        { offsetMinutes: 4 }, { offsetMinutes: null }
      ]
    }));
    try {
      const priced = decorrelation.priceRun(report, [runFile]);
      expect(priced).toHaveLength(1);
      // A null offset is not an offset of zero, and a sign is not a distance.
      expect(priced[0].n).toBe(3);
      expect(priced[0].meanOffsetMin).toBeCloseTo(8 / 3, 9);
      expect(priced[0].maxOffsetMin).toBe(4);
      const curve = report.pooled.curve;
      expect(priced[0].speedRmsMps).toBeCloseTo(Math.sqrt(
        (curve[2].speedRmsMps ** 2 * 2 + curve[4].speedRmsMps ** 2) / 3
      ), 9);
      // Averaging first can only remove variance, never add it.
      expect(priced[0].averaged.speedRmsMps).toBeLessThan(priced[0].speedRmsMps);
      expect(priced[0].blockMin).toBe(report.blockMin);
      const text = decorrelation.summarise(Object.assign({}, report, { runs: priced }));
      expect(text).toContain("at the offsets these runs actually drew");
      expect(text).toContain("10-minute means");
    } finally {
      fs.unlinkSync(runFile);
    }
  });

  test("a cached file that is really an NCEI error page is refused by name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asos1min-cache-"));
    const name = path.basename(asos1min.monthUrl("KCAO", 2024, 9));
    fs.writeFileSync(path.join(dir, name),
      "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\n<html><title>404</title></html>\n");
    await expect(decorrelation.load({ station: "KCAO", year: 2024, month: 9, cache: dir }))
      .rejects.toThrow(/HTML rather than page-1 records/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("what NCEI sent is what the cache keeps, and it reads back the same", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asos1min-cache-"));
    const spec = { station: "KRTN", year: 2026, month: 3, cache: dir };
    const fetched = await decorrelation.load(Object.assign({
      fetch: async function () { return { ok: true, status: 200, text: async () => DAY }; }
    }, spec));
    expect(fetched.cached).toBe(false);
    expect(fetched.records).toHaveLength(1440);
    const cached = await decorrelation.load(Object.assign({
      fetch: async function () { throw new Error("the cache should have answered"); }
    }, spec));
    expect(cached.cached).toBe(true);
    expect(cached.records).toHaveLength(1440);
    expect(cached.records[0].time.toISOString()).toBe(fetched.records[0].time.toISOString());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("--month wants a year and a month", () => {
    expect(decorrelation.months("2026-03,202409")).toEqual([
      { year: 2026, month: 3 }, { year: 2024, month: 9 }
    ]);
    expect(function () { decorrelation.months("March"); }).toThrow(/YYYY-MM/);
  });
});
