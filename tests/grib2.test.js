/**
 * The decoder is checked against ecCodes, not against itself.
 *
 * `hrrr-20260826t20z-f00-boulder.grib2` is a real 1,883-byte NOMADS response:
 * the HRRR 2D filter, 20260826 20Z, forecast hour 0, six variables over a
 * 0.2° box west of Boulder. `…eccodes.json` is what ecCodes 2.24.2 makes of the
 * same bytes, produced with:
 *
 *   for n in 1..8: grib_copy -w count=$n in.grib2 m$n.grib2
 *   grib_get_data -L "%14.8f %14.8f" -F "%.10e" \
 *     -p shortName,level,typeOfLevel,dataDate,dataTime,forecastTime,\
 *        discipline,parameterCategory,parameterNumber  m$n.grib2
 *
 * An independent implementation is the only check worth having here: every
 * intermediate quantity in a GRIB decode is plausible, so a decoder graded
 * against its own arithmetic passes while returning a wind that is off by a
 * scale factor.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const grib2 = require("../grib2");

const FIXTURE = path.join(__dirname, "fixtures", "hrrr-20260826t20z-f00-boulder.grib2");
const REFERENCE = path.join(__dirname, "fixtures", "hrrr-20260826t20z-f00-boulder.eccodes.json");

const buffer = fs.readFileSync(FIXTURE);
const reference = JSON.parse(fs.readFileSync(REFERENCE, "utf8"));

// ecCodes' own printed precision: the reference values carry ten significant
// figures and the coordinates eight decimals, so agreement closer than this
// cannot be asserted from this file.
const VALUE_TOLERANCE = 1e-6;
const DEGREE_TOLERANCE = 1e-7;

describe("decoding the live NOMADS fixture", () => {
  const records = grib2.decode(buffer);

  test("finds every message ecCodes finds, in the same order", () => {
    expect(records).toHaveLength(reference.length);
    expect(records.map((r) => r.parameter)).toEqual(
      ["GUST", "UGRD", "VGRD", "PRES", "TMP", "UGRD", "VGRD", "HPBL"]
    );
  });

  test("agrees with ecCodes on every value of every message", () => {
    let worst = 0;
    records.forEach((record, m) => {
      const points = reference[m].points;
      expect(record.values).toHaveLength(points.length);
      points.forEach((point, k) => {
        worst = Math.max(worst, Math.abs(point.value - record.values[k]));
      });
    });
    expect(worst).toBeLessThan(VALUE_TOLERANCE);
  });

  test("agrees with ecCodes on every latitude and longitude", () => {
    let worstLat = 0;
    let worstLon = 0;
    records.forEach((record, m) => {
      reference[m].points.forEach((point, k) => {
        worstLat = Math.max(worstLat, Math.abs(point.lat - record.latitudes[k]));
        // ecCodes reports longitude in 0..360; this repo is west-negative.
        worstLon = Math.max(worstLon, Math.abs(point.lon - 360 - record.longitudes[k]));
      });
    });
    expect(worstLat).toBeLessThan(DEGREE_TOLERANCE);
    expect(worstLon).toBeLessThan(DEGREE_TOLERANCE);
  });

  test("reads the level and the parameter the request asked for", () => {
    const at = (name, level) => records.find(
      (r) => r.parameter === name && r.level.value === level
    );
    expect(at("UGRD", 10).level.name).toBe("heightAboveGround");
    expect(at("UGRD", 80).level.name).toBe("heightAboveGround");
    expect(at("GUST", 0).level.name).toBe("surface");
    expect(at("UGRD", 10)).not.toBe(at("UGRD", 80));
  });

  test("resolves the valid time from the cycle and the forecast hour", () => {
    records.forEach((record) => {
      expect(record.referenceTime.toISOString()).toBe("2026-08-26T20:00:00.000Z");
      expect(record.forecastSeconds).toBe(0);
      expect(record.validTime.getTime()).toBe(record.referenceTime.getTime());
    });
  });

  test("reads the grid HRRR actually sends", () => {
    const grid = records[0].grid;
    expect(grid).toMatchObject({
      template: 30,
      ni: 6,
      nj: 7,
      dxMeters: 3000,
      dyMeters: 3000,
      loVDeg: -97.5,
      latin1Deg: 38.5,
      latin2Deg: 38.5,
      radiusMeters: 6371229.0
    });
  });

  // The octet that decides whether the wind is right. HRRR sets it, so a
  // consumer that skips the rotation is wrong by the grid convergence.
  test("reports that the components are relative to the grid", () => {
    expect(records[0].grid.windComponentsRelativeToGrid).toBe(true);
  });

  test("orders points as ecCodes does: west to east, then south to north", () => {
    const record = records[0];
    const grid = record.grid;
    expect(record.longitudes[1]).toBeGreaterThan(record.longitudes[0]);
    expect(record.latitudes[grid.ni]).toBeGreaterThan(record.latitudes[0]);
  });
});

describe("the Lambert projection", () => {
  const grid = grib2.decode(buffer)[0].grid;

  test("is tangent at 38.5°, so the cone constant is sin(38.5°)", () => {
    const k = grib2.lambertConstants(grid);
    expect(k.n).toBeCloseTo(Math.sin((38.5 * Math.PI) / 180), 12);
  });

  test("round-trips a coordinate through the projection", () => {
    const k = grib2.lambertConstants(grid);
    const xy = grib2.lambertForward(grid, k, 40.5, -105.5);
    const back = grib2.lambertInverse(grid, k, xy.x, xy.y);
    expect(back.lat).toBeCloseTo(40.5, 9);
    expect(back.lon).toBeCloseTo(-105.5, 9);
  });
});

/**
 * The rotation is checked against the geolocation rather than against a
 * remembered formula: the geolocation is the part ecCodes has already vetted,
 * so differentiating it numerically gives an independent answer for which way
 * the grid's own north points. A sign error here is a wind rotated the wrong
 * way by twice the convergence, and every value still looks like a wind.
 */
describe("grid-relative to earth-relative wind", () => {
  const grid = grib2.decode(buffer)[0].grid;
  const k = grib2.lambertConstants(grid);

  function numericBearingOfGridAxis(latDeg, lonDeg, dx, dy) {
    const origin = grib2.lambertForward(grid, k, latDeg, lonDeg);
    const a = grib2.lambertInverse(grid, k, origin.x, origin.y);
    const b = grib2.lambertInverse(grid, k, origin.x + dx, origin.y + dy);
    const north = b.lat - a.lat;
    const east = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
    return (Math.atan2(east, north) * 180) / Math.PI;
  }

  const LONGITUDES = [-120, -105.5, -97.5, -85, -70];

  test("the analytic bearing of the grid's +j axis matches the projection", () => {
    LONGITUDES.forEach((lon) => {
      const numeric = numericBearingOfGridAxis(40, lon, 0, 1);
      expect(grib2.gridNorthBearingDeg(grid, lon)).toBeCloseTo(numeric, 5);
    });
  });

  test("the +i axis is 90° clockwise from the +j axis", () => {
    LONGITUDES.forEach((lon) => {
      const numeric = numericBearingOfGridAxis(40, lon, 1, 0);
      expect(numeric).toBeCloseTo(grib2.gridNorthBearingDeg(grid, lon) + 90, 5);
    });
  });

  test("is the identity on the reference meridian", () => {
    expect(grib2.gridNorthBearingDeg(grid, -97.5)).toBe(0);
    const wind = grib2.toEarthRelativeWind(grid, -97.5, 3, 4);
    expect(wind.east).toBeCloseTo(3, 12);
    expect(wind.north).toBeCloseTo(4, 12);
  });

  test("rotates west of the reference meridian, and preserves the speed", () => {
    const wind = grib2.toEarthRelativeWind(grid, -105.5, 0, 10);
    const bearing = (Math.atan2(wind.east, wind.north) * 180) / Math.PI;
    // Grid north west of 97.5°W leans west of true north, by n·Δλ.
    expect(bearing).toBeCloseTo(-4.98, 2);
    expect(Math.hypot(wind.east, wind.north)).toBeCloseTo(10, 12);
  });
});

describe("refusals", () => {
  test("names HTML for what it is, because NOMADS serves it with HTTP 200", () => {
    const html = Buffer.from("<html><body>Fatal error: bad variable</body></html>");
    expect(() => grib2.decode(html)).toThrow(/HTML page/);
    try {
      grib2.decode(html);
    } catch (err) {
      expect(err.code).toBe("not-grib");
    }
  });

  test("rejects a buffer that is not GRIB at all", () => {
    expect(() => grib2.decode(Buffer.from([1, 2, 3, 4, 5]))).toThrow(/GRIB magic/);
  });

  test("rejects a truncated message rather than decoding what arrived", () => {
    const short = buffer.subarray(0, 120);
    expect(() => grib2.decode(short)).toThrow(/claims 220 bytes but only 120 remain/);
  });

  test("rejects a message whose 7777 terminator is missing", () => {
    const damaged = Buffer.from(buffer);
    damaged.writeUInt8(0x30, 216);
    expect(() => grib2.decode(damaged)).toThrow(/7777 terminator/);
  });

  test("names the packing template it cannot decode", () => {
    // Section 5 of the first message: turn simple packing into JPEG2000.
    const jpeg2000 = Buffer.from(buffer);
    const section5 = findSection(jpeg2000, 0, 5);
    jpeg2000.writeUInt16BE(40, section5 + 9);
    expect(() => grib2.decode(jpeg2000)).toThrow(/template 40/);
  });

  test("names a scanning mode it has not verified", () => {
    const flipped = Buffer.from(buffer);
    const section3 = findSection(flipped, 0, 3);
    flipped.writeUInt8(0x00, section3 + 64);
    expect(() => grib2.decode(flipped)).toThrow(/scanningMode/);
  });

  test("names a grid template it does not know", () => {
    const mercator = Buffer.from(buffer);
    const section3 = findSection(mercator, 0, 3);
    mercator.writeUInt16BE(10, section3 + 12);
    expect(() => grib2.decode(mercator)).toThrow(/template 10/);
  });
});

/** Byte offset of a section within the message starting at `start`. */
function findSection(buf, start, wanted) {
  let p = start + 16;
  const end = start + Number(buf.readBigUInt64BE(start + 8)) - 4;
  while (p < end) {
    const length = buf.readUInt32BE(p);
    if (buf.readUInt8(p + 4) === wanted) return p;
    p += length;
  }
  throw new Error("section " + wanted + " not found");
}
