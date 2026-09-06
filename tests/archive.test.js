/**
 * The archive reader, offline.
 *
 * `archive.js` is the second module in this repository that makes a request, and
 * like `nomads.js` it takes its `fetch` as an option so that its own suite never
 * makes one. The fixtures are real: `hrrr-20250901t12z-f01.idx` is NCEP's own
 * sidecar for that cycle, byte for byte, and the message served for a range
 * request is the LAND field cut out of the same object at the offset that
 * sidecar gives.
 *
 * Regenerate the sidecar with:
 *
 *   curl -sS https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20250901/conus/\
 *   hrrr.t12z.wrfsfcf01.grib2.idx -o tests/fixtures/hrrr-20250901t12z-f01.idx
 */

"use strict";

const fs = require("fs");
const path = require("path");
const archive = require("../archive.js");

const FIXTURES = path.join(__dirname, "fixtures");
const IDX = fs.readFileSync(path.join(FIXTURES, "hrrr-20250901t12z-f01.idx"), "utf8");
const LAND = fs.readFileSync(path.join(FIXTURES, "hrrr-20250901t12z-f01-land.grib2"));

/** The sidecar line the LAND fixture was cut from. */
const LAND_START = 142679338;

const CYCLE = { year: 2025, month: 9, day: 1, hour: 12 };

function headers(map) {
  return { get: (name) => map[name.toLowerCase()] || null };
}

function ok(body, status) {
  return {
    status: status === undefined ? 200 : status,
    headers: headers({ "content-type": "application/octet-stream" }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length)
  };
}

/**
 * An S3 that serves the sidecar and one message, and that answers a range it
 * does not recognise the way S3 really does — 200 and the whole object.
 */
function fakeS3(opts) {
  const o = opts || {};
  const calls = [];
  const object = Buffer.concat([Buffer.alloc(64, 0x41), LAND]);
  const fetchImpl = async (url, init) => {
    const range = init && init.headers && (init.headers.Range || init.headers.range);
    calls.push({ url: url, range: range || null });
    if (/\.idx$/.test(url)) {
      if (o.indexStatus) return ok(Buffer.from(o.indexBody || "", "utf8"), o.indexStatus);
      return ok(Buffer.from(o.indexBody === undefined ? IDX : o.indexBody, "utf8"));
    }
    if (o.rangeStatus === 200) return ok(object, 200);
    const m = /^bytes=(\d+)-(\d*)$/.exec(range || "");
    if (!m) return ok(object, 200);
    if (Number(m[1]) !== LAND_START) {
      return ok(Buffer.alloc(Number(m[2]) - Number(m[1]) + 1, 0x41), 206);
    }
    const body = o.truncate ? LAND.subarray(0, LAND.length - 1) : LAND;
    return ok(body, 206);
  };
  return { fetch: fetchImpl, calls: calls };
}

describe("naming an object in the archive", () => {
  test("builds the path NCEP writes", () => {
    expect(archive.objectUrl({ cycle: CYCLE, forecastHour: 1 })).toBe(
      "https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20250901/conus/hrrr.t12z.wrfsfcf01.grib2");
    expect(archive.indexUrl({ cycle: CYCLE, forecastHour: 1 })).toMatch(/\.grib2\.idx$/);
  });

  test("pads the day, the cycle and the forecast hour", () => {
    expect(archive.objectUrl({ cycle: { year: 2024, month: 3, day: 7, hour: 6 }, forecastHour: 0 }))
      .toContain("hrrr.20240307/conus/hrrr.t06z.wrfsfcf00.grib2");
  });

  test("reads a Date in UTC and never in local time", () => {
    // 2025-09-01T01:30Z is the previous day in Denver. A cycle read locally
    // fetches a different hour's weather, and every value in it is a valid wind.
    const url = archive.objectUrl({ cycle: new Date("2025-09-01T01:30:00Z"), forecastHour: 0 });
    expect(url).toContain("hrrr.20250901/conus/hrrr.t01z");
  });

  test("takes another product and another region", () => {
    expect(archive.objectUrl({ cycle: CYCLE, forecastHour: 2, product: "wrfprsf", region: "alaska" }))
      .toContain("/alaska/hrrr.t12z.wrfprsf02.grib2");
  });

  test("refuses a forecast hour that is not a whole hour in range", () => {
    expect(() => archive.objectUrl({ cycle: CYCLE, forecastHour: 1.5 })).toThrow(/whole number/);
    expect(() => archive.objectUrl({ cycle: CYCLE, forecastHour: 96 })).toThrow(/whole number/);
  });

  test("refuses a cycle that is neither a Date nor the parts of one", () => {
    expect(() => archive.objectUrl({ cycle: "2025090112" })).toThrow(/UTC/);
  });
});

describe("the .idx sidecar", () => {
  const entries = archive.parseIndex(IDX);

  test("has one entry per message", () => {
    expect(entries.length).toBe(IDX.trim().split("\n").length);
    expect(entries[0].message).toBe(1);
    expect(entries[0].start).toBe(0);
  });

  test("derives each message's last byte from the next message's offset", () => {
    expect(entries[0].end).toBe(entries[1].start - 1);
    // The format gives no length for the last message: null asks S3 for the
    // remainder of the object, which is what "bytes=N-" means.
    expect(entries[entries.length - 1].end).toBeNull();
    expect(archive.rangeHeader(entries[entries.length - 1])).toMatch(/^bytes=\d+-$/);
  });

  test("keeps the parameter and level as NCEP spells them", () => {
    const wind = entries.find((e) => e.parameter === "UGRD" && e.level === "10 m above ground");
    expect(wind.start).toBe(48667069);
    expect(wind.forecast).toBe("1 hour fcst:");
  });

  test("keeps a line whose parameter is itself colon-free prose", () => {
    // NCEP writes unnamed parameters as "var discipline=0 center=7 ... parm=201",
    // which has no name in any table and must not be dropped.
    const unnamed = entries.find((e) => /^var discipline/.test(e.parameter));
    expect(unnamed).toBeTruthy();
  });

  test("orders the derived lengths by offset, not by the order of the lines", () => {
    const shuffled = IDX.trim().split("\n").reverse().join("\n");
    const back = archive.parseIndex(shuffled);
    for (const e of back) {
      if (e.end !== null) expect(e.end).toBeGreaterThanOrEqual(e.start);
    }
  });

  test("refuses markup, which is what a missing object returns", () => {
    expect(() => archive.parseIndex("<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code></Error>"))
      .toThrow(/markup/);
  });

  test("refuses an empty or malformed sidecar rather than reporting no messages", () => {
    expect(() => archive.parseIndex("   ")).toThrow(/empty/);
    expect(() => archive.parseIndex("1:0:d=2025090112:UGRD")).toThrow(/NCEP's format/);
    expect(() => archive.parseIndex("a:b:c:d:e:f")).toThrow(/byte offset/);
  });

  test("refuses two messages that claim the same offset", () => {
    expect(() => archive.parseIndex("1:0:d=1:A:surface:fcst:\n2:0:d=1:B:surface:fcst:"))
      .toThrow(/share byte offset/);
  });
});

describe("choosing messages out of the sidecar", () => {
  const entries = archive.parseIndex(IDX);

  test("matches the parameter and the level verbatim", () => {
    const got = archive.selectEntries(entries, [
      { parameter: "UGRD", level: "10 m above ground" },
      { parameter: "SFCR", level: "surface" }
    ]);
    expect(got.map((e) => e.start)).toEqual([48667069, 57623578]);
  });

  test("does not return the wind at another level for a request for this one", () => {
    const aloft = archive.selectEntries(entries, { parameter: "UGRD", level: "1000 mb" });
    expect(aloft.every((e) => e.level === "1000 mb")).toBe(true);
    expect(aloft.some((e) => e.level === "10 m above ground")).toBe(false);
  });

  test("says which parameter is not in the index rather than returning nothing", () => {
    expect(() => archive.selectEntries(entries, { parameter: "UGRD", level: "10 m above the ground" }))
      .toThrow(/no UGRD at 10 m above the ground/);
  });

  test("returns each message once when two requests name it", () => {
    const got = archive.selectEntries(entries, [
      { parameter: "SFCR", level: "surface" },
      { parameter: "SFCR" }
    ]);
    expect(got.length).toBe(1);
  });
});

describe("fetching a message by byte range", () => {
  const wanted = { parameter: "LAND", level: "surface" };

  test("asks for the sidecar and then for that message alone", async () => {
    const s3 = fakeS3();
    const got = await archive.fetchArchiveRecords({
      cycle: CYCLE, forecastHour: 1, wanted: wanted, fetch: s3.fetch
    });
    expect(s3.calls.length).toBe(2);
    expect(s3.calls[0].url).toMatch(/\.idx$/);
    expect(s3.calls[1].range).toBe("bytes=142679338-142729813");
    expect(got.records.length).toBe(1);
    expect(got.records[0].parameter).toBe("LAND");
    expect(got.records[0].values.length).toBe(1905141);
    expect(got.bytes).toBe(LAND.length);
  });

  test("refuses a 200, which is how S3 says it ignored the range", async () => {
    // The body is then the whole object — 130 MB of valid GRIB for a request
    // that asked for 50 KB, and it decodes perfectly.
    const s3 = fakeS3({ rangeStatus: 200 });
    await expect(archive.fetchArchiveRecords({
      cycle: CYCLE, forecastHour: 1, wanted: wanted, fetch: s3.fetch
    })).rejects.toThrow(/rather than 206/);
  });

  test("refuses a range that came back shorter than the index says", async () => {
    const s3 = fakeS3({ truncate: true });
    await expect(archive.fetchArchiveRecords({
      cycle: CYCLE, forecastHour: 1, wanted: wanted, fetch: s3.fetch
    })).rejects.toThrow(/bytes for the .* the index says/);
  });

  test("refuses bytes that are not a GRIB message at all", async () => {
    const s3 = fakeS3();
    const entries = archive.parseIndex(IDX);
    const wrong = archive.selectEntries(entries, { parameter: "SFCR", level: "surface" });
    await expect(archive.fetchEntries(wrong, { cycle: CYCLE, forecastHour: 1, fetch: s3.fetch }))
      .rejects.toThrow(/not a GRIB message/);
  });

  test("refuses a message that is not the one the index named", async () => {
    const s3 = fakeS3();
    const entry = archive.parseIndex(IDX).find((e) => e.start === LAND_START);
    const lied = Object.assign({}, entry, { parameter: "SFCR" });
    await expect(archive.fetchEntries([lied], { cycle: CYCLE, forecastHour: 1, fetch: s3.fetch }))
      .rejects.toThrow(/index says SFCR and the message is LAND/);
  });

  test("refuses a message at a level the index did not name", () => {
    const record = { parameter: "UGRD", discipline: 0, category: 2, number: 2, level: { value: 80 } };
    expect(() => archive.assertMatchesIndex(record, { parameter: "UGRD", level: "10 m above ground", line: "" }, ""))
      .toThrow(/is at 80/);
  });

  test("does not claim agreement on a parameter it has no name for", () => {
    // The decoder keeps the numbers when a parameter is unmapped; the index has
    // a name for it, so the two cannot be compared and neither can be believed
    // over the other. The level still is.
    const record = { parameter: "0/16/201", discipline: 0, category: 16, number: 201, level: { value: 0 } };
    expect(() => archive.assertMatchesIndex(record,
      { parameter: "var discipline=0 center=7 local_table=1 parmcat=16 parm=201",
        level: "entire atmosphere", line: "" }, "")).not.toThrow();
  });

  test("names what S3 said when the object is not there", async () => {
    const s3 = fakeS3({ indexStatus: 404, indexBody: "<Error><Code>NoSuchKey</Code></Error>" });
    await expect(archive.fetchIndex({ cycle: CYCLE, forecastHour: 1, fetch: s3.fetch, retries: 0 }))
      .rejects.toThrow(/answered 404: NoSuchKey/);
  });

  test("retries a transport failure and then gives up saying so", async () => {
    let calls = 0;
    const flaky = async () => { calls += 1; throw new Error("socket hang up"); };
    await expect(archive.fetchIndex({
      cycle: CYCLE, forecastHour: 1, fetch: flaky, retries: 2, sleep: async () => {}
    })).rejects.toThrow(/after 3 attempt\(s\)/);
    expect(calls).toBe(3);
  });

  test("retries a 503 and succeeds on the retry", async () => {
    const s3 = fakeS3();
    let first = true;
    const flaky = async (url, init) => {
      if (first) { first = false; return ok(Buffer.alloc(0), 503); }
      return s3.fetch(url, init);
    };
    const got = await archive.fetchIndex({
      cycle: CYCLE, forecastHour: 1, fetch: flaky, sleep: async () => {}
    });
    expect(got.entries.length).toBeGreaterThan(100);
  });

  test("refuses a range larger than the ceiling", async () => {
    const s3 = fakeS3();
    await expect(archive.fetchArchiveRecords({
      cycle: CYCLE, forecastHour: 1, wanted: wanted, fetch: s3.fetch, maxBytes: 1024
    })).rejects.toThrow(/over the 1024 byte ceiling/);
  });

  test("says so when there is no fetch to use", async () => {
    await expect(archive.fetchIndex({ cycle: CYCLE, forecastHour: 1, fetch: null }))
      .rejects.toThrow(/no fetch implementation/);
    await expect(archive.fetchEntries([], { cycle: CYCLE, forecastHour: 1, fetch: null }))
      .rejects.toThrow(/no fetch implementation/);
  });

  test("requires a cycle and something to fetch", async () => {
    await expect(archive.fetchArchiveRecords({ wanted: wanted })).rejects.toThrow(/cycle is required/);
    await expect(archive.fetchArchiveRecords({ cycle: CYCLE })).rejects.toThrow(/wanted is required/);
  });
});

describe("the archive as a source the field service can use", () => {
  // `cache.createHrrrVolumeSource` takes its fetcher as `nomads`, and asks it
  // for a box, a cycle, a lead time, the filter's level names and a variable
  // list. An archive source has to answer that same call, or every module
  // downstream of the volume needs a second code path for historical data —
  // which is the point at which "score another date" stops happening.
  const BOX = { west: -105.30, south: 40.005, east: -105.26, north: 40.035 };

  function source(opts) {
    const s3 = fakeS3();
    return {
      s3: s3,
      source: archive.createArchiveSource(Object.assign({ fetch: s3.fetch }, opts || {}))
    };
  }

  async function land(made, extra) {
    return made.source.fetchHrrrBox(Object.assign({
      box: BOX, cycle: CYCLE, forecastHour: 1,
      levels: ["surface"], variables: ["LAND"]
    }, extra || {}));
  }

  test("it answers with the cropped records, not with the continent", async () => {
    const made = source();
    const got = await land(made);
    expect(got.records.length).toBe(1);
    expect(got.records[0].parameter).toBe("LAND");
    expect(got.records[0].level).toEqual({ type: 1, name: "surface", value: 0 });
    // 1,905,141 points went in. What comes out is the handful of cells the
    // domain touches, with coordinates for those and no others.
    expect(got.records[0].values.length).toBeLessThan(100);
    expect(got.records[0].latitudes.length).toBe(got.records[0].values.length);
    expect(got.url).toContain("hrrr.20250901/conus/hrrr.t12z.wrfsfcf01.grib2");
    expect(got.bytes).toBe(LAND.length);
  });

  test("the filter's level names are translated to the sidecar's spelling", async () => {
    // `heightAboveGround:10` is what the rest of the repository calls it,
    // `10 m above ground` is what NCEP writes in the .idx, and a mismatch here
    // is not an error — it is a selection that matches nothing.
    expect(archive.indexLevel("10_m_above_ground")).toBe("10 m above ground");
    expect(archive.indexLevel("surface")).toBe("surface");
    expect(() => archive.indexLevel("heightAboveGround:10")).toThrow(/no archive index level/);
  });

  test("a variable published at none of the wanted levels is named and refused", async () => {
    const made = source();
    await expect(land(made, { variables: ["LAND", "UGRD"], levels: ["surface"] }))
      .rejects.toThrow(/UGRD is published at none of surface/);
  });

  test("the sidecar is read once for a cycle, however many hours are scored", async () => {
    // Thirteen stations over twenty-four hours is 312 calls, and the sidecar
    // is a megabyte of text. Fetching it per call is the difference between a
    // run that finishes and one that does not.
    const made = source();
    await land(made);
    await land(made);
    expect(made.s3.calls.filter(function (c) { return /\.idx$/.test(c.url); }).length).toBe(1);
  });

  test("a message is fetched once and cropped again for the next box", async () => {
    const made = source();
    const first = await land(made);
    const second = await land(made, {
      box: { west: -105.6, south: 40.3, east: -105.5, north: 40.4 }
    });
    expect(made.s3.calls.filter(function (c) { return c.range; }).length).toBe(1);
    expect(second.records[0].values.length).toBeGreaterThan(0);
    expect(second.records[0].latitudes[0]).not.toBeCloseTo(first.records[0].latitudes[0], 3);
  });

  test("a box off the grid is refused rather than answered empty", async () => {
    const made = source();
    await expect(land(made, { box: { west: 10, south: 40, east: 11, north: 41 } }))
      .rejects.toThrow(/does not meet this grid/);
  });

  test("a call with no box, cycle, level or variable is refused", async () => {
    const made = source();
    await expect(made.source.fetchHrrrBox({ cycle: CYCLE })).rejects.toThrow(/box is required/);
    await expect(made.source.fetchHrrrBox({ box: BOX })).rejects.toThrow(/cycle is required/);
    await expect(made.source.fetchHrrrBox({ box: BOX, cycle: CYCLE, variables: ["LAND"] }))
      .rejects.toThrow(/levels is required/);
    await expect(made.source.fetchHrrrBox({ box: BOX, cycle: CYCLE, levels: ["surface"] }))
      .rejects.toThrow(/variables is required/);
  });
});
