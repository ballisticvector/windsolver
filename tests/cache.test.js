/**
 * The cache key is the decision everything downstream inherits, so most of
 * these tests are about what counts as the same request — and about the two
 * ways a cache lies: serving a box it does not fully cover, and serving a field
 * the atmosphere has moved past.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const grib2 = require("../grib2.js");
const volumeModule = require("../volume.js");
const cacheModule = require("../cache.js");

const FIXTURE = path.join(__dirname, "fixtures", "hrrr-20260826t20z-f00-boulder.grib2");
const records = grib2.decode(fs.readFileSync(FIXTURE));

const VALID = new Date("2026-08-26T20:00:00Z");
const BOX = { west: -105.32, south: 39.98, east: -105.24, north: 40.04 };
const LEVELS = ["heightAboveGround:10", "heightAboveGround:80"];

function volumeAt(validTime) {
  const shifted = records.map((r) => Object.assign({}, r, { validTime: validTime }));
  return volumeModule.buildVolume(shifted);
}

function spec(over) {
  return Object.assign({ box: BOX, levels: LEVELS, validTime: VALID }, over);
}

describe("snapBox", () => {
  test("only ever grows the box", () => {
    const snapped = cacheModule.snapBox({ west: -105.315, south: 39.983, east: -105.241, north: 40.037 });
    expect(snapped.west).toBeLessThanOrEqual(-105.315);
    expect(snapped.south).toBeLessThanOrEqual(39.983);
    expect(snapped.east).toBeGreaterThanOrEqual(-105.241);
    expect(snapped.north).toBeGreaterThanOrEqual(40.037);
  });

  test("a box already on the grid is left alone rather than inflated a cell", () => {
    expect(cacheModule.snapBox({ west: -105.32, south: 39.98, east: -105.24, north: 40.04 }))
      .toEqual({ west: -105.32, south: 39.98, east: -105.24, north: 40.04 });
  });

  test("refuses an empty or transposed box instead of snapping it into a valid-looking one", () => {
    expect(() => cacheModule.snapBox({ west: 1, south: 0, east: 1, north: 1 })).toThrow(/empty or transposed/);
    expect(() => cacheModule.snapBox({ west: 2, south: 0, east: 1, north: 1 })).toThrow(/empty or transposed/);
    expect(() => cacheModule.snapBox(null)).toThrow(/required/);
  });
});

describe("cacheKey", () => {
  test("two requests for the same hillside share a key", () => {
    const a = cacheModule.cacheKey(spec({ box: { west: -105.3155, south: 39.9812, east: -105.2413, north: 40.0388 } }));
    const b = cacheModule.cacheKey(spec({ box: { west: -105.3149, south: 39.9805, east: -105.2401, north: 40.0399 } }));
    expect(a).toBe(b);
  });

  test("level order and duplication do not make a second entry", () => {
    expect(cacheModule.cacheKey(spec({ levels: ["heightAboveGround:80", "heightAboveGround:10"] })))
      .toBe(cacheModule.cacheKey(spec({ levels: ["heightAboveGround:10", "heightAboveGround:80", "heightAboveGround:10"] })));
  });

  test("a different level set, hour or source is a different key", () => {
    const base = cacheModule.cacheKey(spec());
    expect(cacheModule.cacheKey(spec({ levels: ["heightAboveGround:10"] }))).not.toBe(base);
    expect(cacheModule.cacheKey(spec({ validTime: new Date("2026-08-26T21:00:00Z") }))).not.toBe(base);
    expect(cacheModule.cacheKey(spec({ source: "RAP" }))).not.toBe(base);
  });

  test("nothing about a shooter reaches the key", () => {
    const key = cacheModule.cacheKey(spec());
    expect(key).not.toMatch(/azimuth|yard|range|shot/i);
    expect(key).toBe("HRRR|-105.32,39.98,-105.24,40.04|heightAboveGround:10+heightAboveGround:80|2026-08-26T20:00:00.000Z");
  });

  test("accepts an ISO string as readily as a Date, and refuses nonsense", () => {
    expect(cacheModule.cacheKey(spec({ validTime: "2026-08-26T20:00:00Z" }))).toBe(cacheModule.cacheKey(spec()));
    expect(() => cacheModule.cacheKey(spec({ validTime: "whenever" }))).toThrow(/Date or an ISO string/);
    expect(() => cacheModule.cacheKey(spec({ levels: [] }))).toThrow(/level set is required/);
  });
});

describe("createCache", () => {
  let clock;
  const now = () => clock;

  beforeEach(() => {
    clock = VALID.getTime();
  });

  test("stores and returns a volume, and counts the hit", () => {
    const cache = cacheModule.createCache({ now: now });
    const v = volumeAt(VALID);
    expect(cache.set("k", v)).toBe(true);
    expect(cache.get("k")).toBe(v);
    expect(cache.summary().hits).toBe(1);
    expect(cache.summary().misses).toBe(0);
  });

  test("freshness runs from the valid time, not from when it was stored", () => {
    const cache = cacheModule.createCache({ now: now, staleAfterMs: 90 * 60 * 1000 });
    // Stored an hour late: it is already an hour old the moment it arrives.
    clock = VALID.getTime() + 60 * 60 * 1000;
    cache.set("k", volumeAt(VALID));
    expect(cache.get("k")).not.toBeNull();

    clock = VALID.getTime() + 91 * 60 * 1000;
    expect(cache.get("k")).toBeNull();
    expect(cache.summary().stale).toBe(1);
  });

  test("the default outlives the window in which nothing newer can be fetched", () => {
    // The newest field at time T is valid at T minus the availability lag, so a
    // default that expires at the hour throws away a field while its successor
    // is still not on the server — a cache miss that resolves to a 404.
    const cache = cacheModule.createCache({ now: now });
    clock = VALID.getTime() + (60 + 75) * 60 * 1000 - 1000;
    cache.set("k", volumeAt(VALID));
    expect(cache.get("k")).not.toBeNull();
  });

  test("a field that is already stale is not stored at all", () => {
    const cache = cacheModule.createCache({ now: now, staleAfterMs: 60 * 1000 });
    clock = VALID.getTime() + 10 * 60 * 1000;
    expect(cache.set("k", volumeAt(VALID))).toBe(false);
    expect(cache.keys()).toEqual([]);
  });

  test("evicts the least recently used, and a hit counts as use", () => {
    const cache = cacheModule.createCache({ now: now, maxEntries: 2 });
    cache.set("a", volumeAt(VALID));
    cache.set("b", volumeAt(VALID));
    cache.get("a");
    cache.set("c", volumeAt(VALID));
    expect(cache.keys().sort()).toEqual(["a", "c"]);
    expect(cache.summary().evictions).toBe(1);
  });

  test("prune drops everything past its hour and leaves the rest", () => {
    const cache = cacheModule.createCache({ now: now, staleAfterMs: 90 * 60 * 1000 });
    cache.set("old", volumeAt(VALID));
    cache.set("new", volumeAt(new Date(VALID.getTime() + 2 * 60 * 60 * 1000)));
    clock = VALID.getTime() + 2 * 60 * 60 * 1000;
    expect(cache.prune()).toBe(1);
    expect(cache.keys()).toEqual(["new"]);
  });

  test("reports what it is holding, in points and bytes, for sizing", () => {
    const cache = cacheModule.createCache({ now: now });
    const v = volumeAt(VALID);
    cache.set("k", v);
    const summary = cache.summary();
    expect(summary.entries).toBe(1);
    expect(summary.points).toBe(42);
    // 2 wind levels x 2 components + 4 surface scalars + 2 coordinate arrays.
    expect(summary.approximateBytes).toBe(10 * 42 * 8);
    expect(cacheModule.approximateBytes(v)).toBe(summary.approximateBytes);
  });
});

describe("createVolumeSource", () => {
  test("loads once, then serves from the cache", async () => {
    let loads = 0;
    const source = cacheModule.createVolumeSource({
      now: () => VALID.getTime(),
      load: async () => { loads++; return volumeAt(VALID); }
    });
    await source.get(spec());
    await source.get(spec({ box: { west: -105.3155, south: 39.9812, east: -105.2413, north: 40.0388 } }));
    expect(loads).toBe(1);
    expect(source.summary().hits).toBe(1);
  });

  test("ten concurrent misses on one key make one request", async () => {
    let loads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const source = cacheModule.createVolumeSource({
      now: () => VALID.getTime(),
      load: async () => { loads++; await gate; return volumeAt(VALID); }
    });

    const all = Promise.all(Array.from({ length: 10 }, () => source.get(spec())));
    expect(source.summary().inFlight).toBe(1);
    release();
    const volumes = await all;

    expect(loads).toBe(1);
    expect(source.summary().coalesced).toBe(9);
    expect(new Set(volumes).size).toBe(1);
    expect(source.summary().inFlight).toBe(0);
  });

  test("a failed load is not cached, and does not wedge the key", async () => {
    let attempt = 0;
    const source = cacheModule.createVolumeSource({
      now: () => VALID.getTime(),
      load: async () => {
        attempt++;
        if (attempt === 1) throw new Error("NOMADS said 503");
        return volumeAt(VALID);
      }
    });
    await expect(source.get(spec())).rejects.toThrow(/503/);
    await expect(source.get(spec())).resolves.toBeTruthy();
    expect(attempt).toBe(2);
  });

  test("refuses to be built without a loader", () => {
    expect(() => cacheModule.createVolumeSource({})).toThrow(/load\(spec\) is required/);
  });
});

describe("createHrrrVolumeSource", () => {
  // A stand-in for nomads.js: the network is its business and is tested there.
  // What matters here is what gets asked for, and what happens to the answer.
  function fakeNomads(answers) {
    const calls = [];
    return {
      calls: calls,
      fetchHrrrBox: async function (opts) {
        calls.push(opts);
        const answer = answers(opts);
        if (answer instanceof Error) throw answer;
        return { url: "https://nomads.example/filter", bytes: 1883, records: answer };
      }
    };
  }

  function notFound() {
    const err = new Error("HTTP 404");
    err.code = "http-error";
    err.status = 404;
    return err;
  }

  function recordsValidAt(validTime) {
    return records.map((r) => Object.assign({}, r, { validTime: validTime }));
  }

  const AT = new Date("2026-08-26T21:30:00Z");

  test("asks for the analysis valid at the hour it was given, by filter level name", async () => {
    const nomads = fakeNomads(() => recordsValidAt(VALID));
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => VALID.getTime() });
    const v = await source.get(spec());

    expect(nomads.calls[0].cycle).toEqual({ year: 2026, month: 8, day: 26, hour: 20 });
    expect(nomads.calls[0].forecastHour).toBe(0);
    expect(nomads.calls[0].levels).toEqual(["10_m_above_ground", "80_m_above_ground"]);
    // The snapped box, not the caller's: the field has to cover its own key.
    expect(nomads.calls[0].box).toEqual(cacheModule.snapBox(BOX));
    expect(v.validTime.toISOString()).toBe("2026-08-26T20:00:00.000Z");
    expect(v.bytes).toBe(1883);
  });

  test("refuses a field valid at a different instant than the one asked for", async () => {
    const nomads = fakeNomads(() => recordsValidAt(new Date("2026-08-26T19:00:00Z")));
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => VALID.getTime() });
    await expect(source.get(spec())).rejects.toThrow(/answered with 2026-08-26T19:00/);
    expect(source.cache.keys()).toEqual([]);
  });

  test("getLatest takes the newest hour that has landed", async () => {
    const nomads = fakeNomads(() => recordsValidAt(new Date("2026-08-26T20:00:00Z")));
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => AT.getTime() });
    const v = await source.getLatest({ box: BOX, levels: LEVELS, at: AT });
    // 21:30Z minus the 75-minute availability lag is the 20Z cycle.
    expect(v.validTime.toISOString()).toBe("2026-08-26T20:00:00.000Z");
    expect(v.lagMinutes).toBe(90);
  });

  test("walks back an hour when the newest file is not on the server yet", async () => {
    const nomads = fakeNomads((opts) =>
      opts.cycle.hour === 20 ? notFound() : recordsValidAt(new Date("2026-08-26T19:00:00Z")));
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => AT.getTime() });
    const v = await source.getLatest({ box: BOX, levels: LEVELS, at: AT });
    expect(v.validTime.toISOString()).toBe("2026-08-26T19:00:00.000Z");
    expect(v.lagMinutes).toBe(150);
    expect(nomads.calls.map((c) => c.cycle.hour)).toEqual([20, 19]);
  });

  test("does not walk back past a refusal that will be just as wrong an hour earlier", async () => {
    const err = new Error("Request for Old Data");
    err.code = "http-error";
    err.status = 403;
    const nomads = fakeNomads(() => err);
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => AT.getTime() });
    await expect(source.getLatest({ box: BOX, levels: LEVELS, at: AT })).rejects.toThrow(/Old Data/);
    expect(nomads.calls).toHaveLength(1);
  });

  test("gives up after the bounded walk rather than reaching back for ever", async () => {
    const nomads = fakeNomads(() => notFound());
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => AT.getTime() });
    await expect(source.getLatest({ box: BOX, levels: LEVELS, at: AT, maxCyclesBack: 2 }))
      .rejects.toThrow(/404/);
    expect(nomads.calls).toHaveLength(3);
  });

  test("the hour that answered is cached, so the next caller does not fetch", async () => {
    let fetches = 0;
    const nomads = fakeNomads(() => {
      fetches++;
      return recordsValidAt(new Date("2026-08-26T20:00:00Z"));
    });
    const source = cacheModule.createHrrrVolumeSource({ nomads: nomads, now: () => AT.getTime() });
    await source.getLatest({ box: BOX, levels: LEVELS, at: AT });
    await source.getLatest({ box: BOX, levels: LEVELS, at: new Date(AT.getTime() + 60 * 1000) });
    expect(fetches).toBe(1);
    expect(source.summary().hits).toBe(1);
  });
});
