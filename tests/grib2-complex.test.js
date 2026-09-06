/**
 * Complex packing, graded against ecCodes on real NCEP messages.
 *
 * NOMADS' filter re-packs what it serves with simple packing, so the fixture in
 * `grib2.test.js` never exercised templates 5.2 or 5.3. NCEP's own archive on
 * AWS does not re-pack: every message in `hrrr.t12z.wrfsfcf01.grib2` is complex
 * packing with second-order spatial differencing, which is why the archive was
 * unreadable here while the identical field from NOMADS decoded cleanly.
 *
 * Three real messages are committed, chosen as the smallest in that object that
 * still exercise the format — 610 bytes to 50 KB for 1,905,141 points each:
 *
 *   land   discipline 2, 3 bits per value, 20,326 groups
 *   snod   16 bits, 45 groups, a field that is almost entirely zero
 *   cfnsf  12 bits, 570 groups, a local NCEP parameter number
 *
 * A JSON of 1.9 million values per message would be 60 MB, so ecCodes grades
 * them two ways instead: its own statistics over every point, and its value at
 * every 977th point. 977 is prime and coprime with the 1799-wide grid, so the
 * sample walks across rows rather than down a single column. Both are needed —
 * the statistics catch a scale factor the sample would share, and the sample
 * catches a field that is right on average and wrong point by point.
 *
 * `tools/make-grib-fixtures.sh` regenerates all of it, and documents the byte
 * ranges and the `.idx` sidecar they came from.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const grib2 = require("../grib2");

const dir = path.join(__dirname, "fixtures");

function load(name) {
  const stem = path.join(dir, "hrrr-20250901t12z-f01-" + name);
  return {
    buffer: fs.readFileSync(stem + ".grib2"),
    reference: JSON.parse(fs.readFileSync(stem + ".eccodes.json", "utf8"))
  };
}

const MESSAGES = ["land", "snod", "cfnsf"];

// ecCodes prints its statistics to six significant figures, so the mean of a
// field averaging 0.0070 can only be asserted to about 1e-9 in absolute terms.
function sixFigures(x) {
  return Math.max(Math.abs(x), 1) * 1e-6;
}

describe.each(MESSAGES)("the archive's %s message", (name) => {
  const { buffer, reference } = load(name);
  const records = grib2.decode(buffer);

  test("is complex packing with second-order spatial differencing", () => {
    // The fixture is worthless as a test of this path if a future regeneration
    // quietly picks up a re-packed object.
    expect(reference.packingType).toBe("grid_complex_spatial_differencing");
    expect(records).toHaveLength(1);
  });

  test("carries every point ecCodes finds", () => {
    expect(records[0].values).toHaveLength(reference.numberOfValues);
    expect(records[0].latitudes).toHaveLength(reference.numberOfValues);
  });

  test("agrees with ecCodes on the field's minimum, maximum and mean", () => {
    const values = records[0].values.filter((v) => v !== null);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    expect(min).toBeCloseTo(reference.min, 6);
    expect(max).toBeCloseTo(reference.max, 6);
    expect(Math.abs(sum / values.length - reference.average))
      .toBeLessThan(sixFigures(reference.average));
  });

  test("agrees with ecCodes value for value across the sample", () => {
    const stride = reference.sampleStride;
    let worst = 0;
    for (let k = 0; k < reference.sample.length; k++) {
      const mine = records[0].values[k * stride];
      const theirs = reference.sample[k];
      if (theirs === null) {
        expect(mine).toBeNull();
        continue;
      }
      worst = Math.max(worst, Math.abs(mine - theirs));
    }
    // Not "close enough": the packed integers are identical, so the only
    // difference possible is floating-point rounding of the same product.
    expect(worst).toBeLessThan(sixFigures(reference.max));
  });

  test("identifies the parameter by discipline as well as category", () => {
    expect(records[0].discipline).toBe(reference.discipline);
    expect(records[0].category).toBe(reference.parameterCategory);
    expect(records[0].number).toBe(reference.parameterNumber);
  });
});

describe("the discipline is part of a parameter's identity", () => {
  const { records } = { records: grib2.decode(load("land").buffer) };

  test("the land/sea mask is not read as temperature", () => {
    // 2/0/0 and 0/0/0 differ only in the discipline, which lives in section 0
    // and not in the product definition section every other field comes from.
    expect(records[0].discipline).toBe(2);
    expect(records[0].category).toBe(0);
    expect(records[0].number).toBe(0);
    expect(records[0].parameter).toBe("LAND");
    expect(grib2.PARAMETERS["0/0/0"]).toBe("TMP");
  });

  test("an unmapped parameter keeps its numbers rather than borrowing a name", () => {
    const cfnsf = grib2.decode(load("cfnsf").buffer);
    expect(cfnsf[0].parameter).toBe("0/4/199");
  });
});

describe("complex packing without spatial differencing", () => {
  // Template 5.2 is not something NCEP writes, so this one case is ecCodes
  // re-packing the simple-packed NOMADS fixture: a real encoder rather than
  // this repository's arithmetic, and small enough to keep every value.
  const buffer = fs.readFileSync(
    path.join(dir, "hrrr-20260826t20z-f00-boulder-complex.grib2"));
  const reference = JSON.parse(fs.readFileSync(
    path.join(dir, "hrrr-20260826t20z-f00-boulder-complex.eccodes.json"), "utf8"));
  const records = grib2.decode(buffer);

  test("decodes every message of the re-packed fixture", () => {
    expect(records).toHaveLength(8);
  });

  test("agrees with ecCodes on every value", () => {
    const per = reference.pointsPerMessage;
    for (let k = 0; k < reference.values.length; k++) {
      const mine = records[Math.floor(k / per)].values[k % per];
      // 6 bits per value over a wind field: the quantisation is ecCodes' own
      // and both sides read the same integers, so this is rounding only.
      expect(Math.abs(mine - reference.values[k])).toBeLessThan(1e-6);
    }
  });

  test("reads the same parameters as the simple-packed original", () => {
    const original = grib2.decode(fs.readFileSync(
      path.join(dir, "hrrr-20260826t20z-f00-boulder.grib2")));
    expect(records.map((r) => r.parameter)).toEqual(original.map((r) => r.parameter));
  });
});

describe("refusals inside complex packing", () => {
  const buffer = load("snod").buffer;

  /** Byte offset of a section within the first message. */
  function findSection(buf, wanted) {
    let p = 16;
    const end = Number(buf.readBigUInt64BE(8)) - 4;
    while (p < end) {
      const length = buf.readUInt32BE(p);
      if (buf.readUInt8(p + 4) === wanted) return p;
      p += length;
    }
    throw new Error("section " + wanted + " not found");
  }

  function patched(offsetInSection5, value) {
    const copy = Buffer.from(buffer);
    copy.writeUInt8(value, findSection(copy, 5) + offsetInSection5);
    return copy;
  }

  test("names an order of spatial differencing it has not graded", () => {
    // First order is refusable rather than implementable: ecCodes will write a
    // message declaring it, but writes no extra descriptor octets with it and
    // then reads its own output back as a field diverging to -4.9e5. There is
    // no trustworthy first-order message to grade against.
    expect(() => grib2.decode(patched(47, 1)))
      .toThrow(/orderOfSpatialDifferencing 1/);
    expect(() => grib2.decode(patched(47, 0)))
      .toThrow(/orderOfSpatialDifferencing 0/);
  });

  test("names a group splitting method it has not verified", () => {
    expect(() => grib2.decode(patched(21, 2)))
      .toThrow(/groupSplittingMethod 2/);
  });

  test("refuses substituted missing values rather than carrying a sentinel", () => {
    // The alternative is a field where 9999 means "no value" and nothing
    // downstream knows it — the same failure as filling a terrain void with 0.
    expect(() => grib2.decode(patched(22, 1)))
      .toThrow(/missingValueManagement 1/);
  });

  test("refuses a declared order with no seeds to start the recurrence", () => {
    const copy = Buffer.from(buffer);
    copy.writeUInt8(0, findSection(copy, 5) + 48);
    expect(() => grib2.decode(copy)).toThrow(/extra descriptor octets/);
  });

  test("names a section that ends before the values it promises", () => {
    const copy = Buffer.from(buffer);
    // Claim ten times as many groups as the message carries: the widths and
    // lengths then read as whatever follows, which must be refused rather than
    // decoded into a shorter but entirely plausible field.
    copy.writeUInt32BE(450, findSection(copy, 5) + 31);
    let thrown = null;
    try {
      grib2.decode(copy);
    } catch (err) {
      thrown = err;
    }
    // Not a RangeError about a Buffer offset: that reads as a bug in the
    // decoder rather than as a message that arrived incomplete.
    expect(thrown && thrown.code).toBe("truncated");
    expect(thrown.message).toMatch(/section 7 ends before/);
  });

  test("still names JPEG2000 rather than attempting it", () => {
    const copy = Buffer.from(buffer);
    copy.writeUInt16BE(40, findSection(copy, 5) + 9);
    expect(() => grib2.decode(copy)).toThrow(/template 40/);
  });
});
