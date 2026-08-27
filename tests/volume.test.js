/**
 * The volume is the native answer shape, so these tests care about two things:
 * that it refuses to be assembled out of things that do not belong together,
 * and that a sample of it lands where the projection says it should.
 *
 * The fixture is the live 1,883-byte NOMADS response also used by the decoder
 * tests: eight messages over a 6 x 7 grid near Boulder, wind at 10 m and 80 m.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const grib2 = require("../grib2.js");
const volume = require("../volume.js");

const FIXTURE = path.join(__dirname, "fixtures", "hrrr-20260826t20z-f00-boulder.grib2");
const records = grib2.decode(fs.readFileSync(FIXTURE));

function build() {
  return volume.buildVolume(records);
}

describe("levelKey", () => {
  test("names a height level by its height and a surface level by its name", () => {
    expect(volume.levelKey({ type: 103, name: "heightAboveGround", value: 10 })).toBe("heightAboveGround:10");
    expect(volume.levelKey({ type: 1, name: "surface", value: 0 })).toBe("surface");
  });

  test("passes a string through, so a caller can name a level directly", () => {
    expect(volume.levelKey("heightAboveGround:80")).toBe("heightAboveGround:80");
  });

  test("sorts a level set into one canonical order", () => {
    expect(volume.sortLevels(["surface", "heightAboveGround:10", "surface"]))
      .toEqual(["heightAboveGround:10", "surface"]);
  });
});

describe("buildVolume", () => {
  test("collects the fixture into one instant with both wind levels", () => {
    const v = build();
    expect(v.validTime.toISOString()).toBe("2026-08-26T20:00:00.000Z");
    expect(v.windLevels).toEqual(["heightAboveGround:10", "heightAboveGround:80"]);
    expect(Object.keys(v.scalars).sort()).toEqual(["GUST", "HPBL", "PRES", "TMP"]);
    expect(v.pointCount).toBe(42);
    expect(v.bounds.west).toBeLessThan(v.bounds.east);
    expect(v.bounds.south).toBeLessThan(v.bounds.north);
  });

  test("rotates the wind out of the grid frame, and does it per point", () => {
    const v = build();
    const raw = records.find((r) => r.parameter === "UGRD" && r.level.value === 10);
    const rawV = records.find((r) => r.parameter === "VGRD" && r.level.value === 10);
    const rotated = v.wind["heightAboveGround:10"];

    // Boulder is 8 degrees west of the 97.5 reference meridian, so the
    // convergence is real and the rotated components must differ from the
    // grid-relative ones by more than rounding.
    expect(Math.abs(rotated.east[0] - raw.values[0])).toBeGreaterThan(0.05);

    // Rotation is a rotation: speed is preserved point by point.
    for (let k = 0; k < raw.values.length; k++) {
      const before = Math.hypot(raw.values[k], rawV.values[k]);
      const after = Math.hypot(rotated.east[k], rotated.north[k]);
      expect(after).toBeCloseTo(before, 9);
    }

    // The convergence depends on longitude, so a single rotation for the whole
    // grid would be wrong at the edges. The first and last columns must differ.
    const angle = (i) => Math.atan2(rotated.north[i], rotated.east[i]) - Math.atan2(rawV.values[i], raw.values[i]);
    expect(Math.abs(angle(0) - angle(5))).toBeGreaterThan(0);
  });

  test("leaves the wind alone when the grid says it is already earth-relative", () => {
    const asEarth = records.map((r) => Object.assign({}, r, {
      grid: Object.assign({}, r.grid, { windComponentsRelativeToGrid: false })
    }));
    const v = volume.buildVolume(asEarth);
    const raw = records.find((r) => r.parameter === "UGRD" && r.level.value === 10);
    expect(v.wind["heightAboveGround:10"].east[0]).toBe(raw.values[0]);
  });

  test("refuses records from two different valid times", () => {
    const mixed = records.slice(0, 3).concat([
      Object.assign({}, records[5], { validTime: new Date("2026-08-26T21:00:00Z") })
    ]);
    expect(() => volume.buildVolume(mixed)).toThrow(/one instant/);
    try {
      volume.buildVolume(mixed);
    } catch (err) {
      expect(err.code).toBe("mixed-time");
    }
  });

  test("refuses records from two different grids", () => {
    const mixed = [records[0], Object.assign({}, records[1], {
      grid: Object.assign({}, records[1].grid, { ni: 5 })
    })];
    expect(() => volume.buildVolume(mixed)).toThrow(/one grid/);
  });

  test("refuses a level that has one wind component and not the other", () => {
    const half = records.filter((r) => !(r.parameter === "VGRD" && r.level.value === 80));
    expect(() => volume.buildVolume(half)).toThrow(/half a wind vector/i);
    try {
      volume.buildVolume(half);
    } catch (err) {
      expect(err.code).toBe("half-a-wind");
    }
  });

  test("refuses to build from nothing", () => {
    expect(() => volume.buildVolume([])).toThrow(/no records/);
  });
});

describe("sampling", () => {
  test("a grid point samples back to its own value", () => {
    const v = build();
    const wind = v.wind["heightAboveGround:10"];
    for (const k of [0, 7, 20, 41]) {
      const s = volume.sampleWind(v, v.latitudes[k], v.longitudes[k], "heightAboveGround:10");
      expect(s.east).toBeCloseTo(wind.east[k], 6);
      expect(s.north).toBeCloseTo(wind.north[k], 6);
    }
  });

  test("the midpoint of a cell is the mean of its corners", () => {
    const v = build();
    const ni = v.grid.ni;
    const k = grib2.lambertConstants(v.grid);
    const origin = grib2.lambertForward(v.grid, k, v.grid.lat1Deg, v.grid.lon1Deg);
    const mid = grib2.lambertInverse(
      v.grid, k,
      origin.x + 2.5 * v.grid.dxMeters,
      origin.y + 3.5 * v.grid.dyMeters
    );
    const wind = v.wind["heightAboveGround:80"];
    const corners = [3 * ni + 2, 3 * ni + 3, 4 * ni + 2, 4 * ni + 3];
    const expected = corners.reduce((s, i) => s + wind.east[i], 0) / 4;
    const got = volume.sampleWind(v, mid.lat, mid.lon, "heightAboveGround:80");
    expect(got.east).toBeCloseTo(expected, 6);
  });

  test("a point outside the grid is refused, not clamped", () => {
    const v = build();
    expect(() => volume.sampleWind(v, 39.0, -105.5, "heightAboveGround:10")).toThrow(/outside the volume/);
    try {
      volume.sampleWind(v, 39.0, -105.5, "heightAboveGround:10");
    } catch (err) {
      expect(err.code).toBe("outside-volume");
    }
  });

  test("a hole in the data stays a hole rather than being interpolated over", () => {
    const holed = records.map((r) => {
      if (r.parameter !== "UGRD" || r.level.value !== 10) return r;
      const values = r.values.slice();
      values[0] = null;
      return Object.assign({}, r, { values: values });
    });
    const v = volume.buildVolume(holed);
    const s = volume.sampleWind(v, v.latitudes[0] + 0.001, v.longitudes[0] + 0.001, "heightAboveGround:10");
    expect(s.east).toBeNull();
    expect(s.north).toBeNull();
  });

  test("names the levels it does have when asked for one it does not", () => {
    const v = build();
    expect(() => volume.sampleWind(v, v.latitudes[0], v.longitudes[0], "heightAboveGround:250"))
      .toThrow(/heightAboveGround:10, heightAboveGround:80/);
  });

  test("scalars sample in their own units, and name themselves when absent", () => {
    const v = build();
    const t = volume.sampleScalar(v, "TMP", v.latitudes[0], v.longitudes[0], "surface");
    expect(t).toBeCloseTo(records.find((r) => r.parameter === "TMP").values[0], 6);
    expect(() => volume.sampleScalar(v, "RH", v.latitudes[0], v.longitudes[0], "surface"))
      .toThrow(/GUST, PRES, TMP, HPBL|has no RH/);
  });

  test("windProfileAt returns heights ascending, and only height levels", () => {
    const v = build();
    const profile = volume.windProfileAt(v, v.latitudes[10], v.longitudes[10]);
    expect(profile.map((p) => p.heightAglM)).toEqual([10, 80]);
    // 80 m sits above the roughness layer, so on this fixture it is the faster
    // of the two — the reason the level is fetched at all.
    expect(Math.hypot(profile[1].east, profile[1].north))
      .toBeGreaterThan(Math.hypot(profile[0].east, profile[0].north));
  });

  test("mpsToFps converts, and passes a hole through", () => {
    expect(volume.mpsToFps(10)).toBeCloseTo(32.8084, 4);
    expect(volume.mpsToFps(null)).toBeNull();
  });
});
