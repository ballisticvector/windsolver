/**
 * The HTTP service.
 *
 * Two classes of thing are worth testing here rather than reading, and neither
 * is the happy path.
 *
 * The first is refusal. Every module underneath this one refuses carefully —
 * `outside-domain` rather than a clamped edge value, `subregion-ignored` rather
 * than 20 MB of the wrong continent — and an HTTP layer that maps all of that
 * onto a 500 with "internal error" throws the information away at the last
 * step. So the mapping from an engine code to a status is asserted code by
 * code: a caller's mistake is a 4xx it can fix, an upstream outage is a 5xx it
 * should retry, and the code travels in the body either way.
 *
 * The second is the limits. A public endpoint in front of a solve that has been
 * measured at 53 s on a bad NOMADS minute needs a queue, a ceiling and a
 * timeout, and those are exactly the paths that never run in development.
 *
 * The service is constructed with its field service injected, so the whole
 * suite is offline: `nomads.js` is still the only module that touches the
 * network.
 */

"use strict";

const http = require("http");

const proj = require("../proj.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const profile = require("../profile.js");
const server = require("../server.js");

const CENTRE = { lat: 40.0150, lon: -105.2705 };
// A `Date`, because that is what the engine carries. The first version of this
// stub used a string, the suite passed, and the live service put
// `Thu Sep 03 2026 22:00:00 GMT+0000 (Coordinated Universal Time)` in the middle
// of its `source` line.
const VALID_TIME = new Date("2026-09-03T21:00:00.000Z");
const VALID_TIME_ISO = "2026-09-03T21:00:00.000Z";

/** A field over flat ground at Boulder, shaped exactly as `field.js` returns one. */
function fakeField(opts) {
  const o = opts || {};
  const spacing = o.spacing || 20;
  const width = o.width || 201;
  const height = o.height || 201;
  const crs = proj.crsFromEpsg(26913);
  const mid = proj.fromGeographic(crs, CENTRE.lat, CENTRE.lon);
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = o.z ? o.z(col, row) : 1600;
    }
  }
  const grid = {
    crs: crs,
    width: width,
    height: height,
    values: values,
    resolutionM: spacing,
    transform: {
      originX: mid.x - (width * spacing) / 2,
      originY: mid.y + (height * spacing) / 2,
      scaleX: spacing,
      scaleY: -spacing
    }
  };
  const derived = derive.derive(grid, { shelter: false });
  const weights = downscale.terrainWeights(derived, { curvatureLengthM: 200 });
  const wind = o.wind || { east: -3.0, north: 0.2 };
  const field = downscale.downscale(weights, wind, { heightAglM: 10, shelter: false });

  const halfLatDeg = (height * spacing) / 2 / 111320;
  const halfLonDeg = (width * spacing) / 2 / (111320 * Math.cos(CENTRE.lat * Math.PI / 180));
  return Object.assign(field, {
    weights: weights,
    domain: {
      south: CENTRE.lat - halfLatDeg,
      north: CENTRE.lat + halfLatDeg,
      west: CENTRE.lon - halfLonDeg,
      east: CENTRE.lon + halfLonDeg
    },
    validTime: VALID_TIME,
    reference: {
      east: wind.east,
      north: wind.north,
      heightAglM: 10,
      level: "heightAboveGround:10",
      validTime: VALID_TIME,
      source: "HRRR",
      cellsAcross: 1.07
    },
    terrain: {
      dataset: "1m",
      resolutionM: 1,
      spacingM: { x: spacing, y: spacing },
      voidFraction: 0,
      sources: ["USGS_1M_13_x44y443"],
      bytesRead: 4110000,
      requests: 15
    },
    offset: { modelElevationM: 1670, meanM: -70, minM: -70, maxM: 183, spreadM: 253 }
  });
}

/** A field service that answers with a canned field, or throws a canned error. */
function stubService(opts) {
  const o = opts || {};
  return {
    calls: [],
    get: async function (spec) {
      this.calls.push(spec);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.error) throw o.error;
      return o.field || fakeField();
    }
  };
}

/** Start a service on an ephemeral port and return `{ url, close }`. */
async function listen(opts) {
  const srv = server.createServer(opts);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  return {
    url: "http://127.0.0.1:" + port,
    close: function () {
      return new Promise((resolve) => srv.close(resolve));
    }
  };
}

async function get(base, path) {
  const res = await fetch(base + path);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsed: text };
  }
  return { status: res.status, headers: res.headers, body: body, text: text };
}

describe("routing", () => {
  let svc;
  let app;

  beforeAll(async () => {
    svc = stubService();
    app = await listen({ field: svc });
  });
  afterAll(async () => {
    await app.close();
  });

  test("reports its health without touching the engine", async () => {
    const before = svc.calls.length;
    const res = await get(app.url, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe(server.API_VERSION);
    expect(res.body.inFlight).toBe(0);
    expect(svc.calls.length).toBe(before);
  });

  test("refuses a route it does not have, by name", async () => {
    const res = await get(app.url, "/v1/forecast");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no-such-route");
    expect(res.body.routes).toContain("/v1/field");
  });

  test("refuses a method other than GET", async () => {
    const res = await fetch(app.url + "/v1/field", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  test("has no route with a rifle in it", async () => {
    // The line in CLAUDE.md, asserted rather than remembered: the pressure to
    // break it arrives as a `forShot=` on the one consumer that exists.
    const res = await get(app.url, "/healthz");
    for (const route of res.body.routes) {
      expect(route).not.toMatch(/shot|rifle|bullet|hold|reticle|zero/i);
    }
  });
});

describe("GET /v1/field", () => {
  test("answers a coordinate with a lat/long grid, not the native one", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=9");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const g = res.body.grid;
      expect(g.cols).toBe(9);
      expect(g.lats.length).toBe(g.rows);
      expect(g.lons.length).toBe(g.cols);
      expect(g.eastMps.length).toBe(g.rows * g.cols);

      // Ascending longitude, descending latitude: row 0 is the north edge, the
      // order every raster consumer already assumes.
      expect(g.lons[0]).toBeLessThan(g.lons[g.cols - 1]);
      expect(g.lats[0]).toBeGreaterThan(g.lats[g.rows - 1]);

      // The native field is a UTM grid; the answer is not, and says so.
      expect(res.body.native.crs).toMatch(/26913|UTM/);
      expect(res.body.native.width).toBe(201);
    } finally {
      await app.close();
    }
  });

  test("carries the provenance a consumer has to display", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=5");
      expect(res.body.validTime).toBe(VALID_TIME_ISO);
      expect(res.body.modelled).toBe(true);
      expect(res.body.notice).toMatch(/modelled/i);
      expect(res.body.terrain.dataset).toBe("1m");
      expect(res.body.reference.speedMps).toBeGreaterThan(0);
      expect(res.body.reference.source).toBe("HRRR");
      // The whole provenance line, not just a substring: a `Date` concatenated
      // into it is still "a string containing HRRR".
      expect(res.body.source).toBe("WindSolver HRRR " + VALID_TIME_ISO + " + 3DEP 1m");
    } finally {
      await app.close();
    }
  });

  test("asks the engine for the box the caller asked about", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&radiusMiles=2&resolutionM=30&cols=5");
      const spec = svc.calls[0];
      expect(spec.lat).toBeCloseTo(40.0150, 6);
      expect(spec.radiusMiles).toBe(2);
      expect(spec.targetResolutionM).toBe(30);
    } finally {
      await app.close();
    }
  });

  test("a cell the field does not cover is null, never NaN", async () => {
    // JSON has no NaN, so an undefined pixel serialised carelessly becomes
    // whatever JSON.stringify felt like. Ask for a box wider than the field.
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&radiusMiles=6&cols=11");
      expect(res.text).not.toMatch(/NaN/);
      const nulls = res.body.grid.eastMps.filter((v) => v === null).length;
      expect(nulls).toBeGreaterThan(0);
      expect(res.body.grid.coveredFraction).toBeLessThan(1);
    } finally {
      await app.close();
    }
  });

  test("refuses a grid bigger than the ceiling, and says what would fit", async () => {
    const svc = stubService();
    const app = await listen({ field: svc, maxCells: 100 });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=400");
      expect(res.status).toBe(413);
      expect(res.body.code).toBe("too-many-cells");
      expect(res.body.maxCells).toBe(100);
      expect(svc.calls.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/line", () => {
  test("resolves the wind onto the line, in metres and m/s", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url,
        "/v1/line?lat=40.0150&lon=-105.2705&bearingDeg=90&lengthM=900&stepM=300");
      expect(res.status).toBe(200);
      expect(res.body.stations.length).toBe(4);
      const first = res.body.stations[0];
      expect(first.distanceM).toBe(0);
      expect(first.alongMps).toBeLessThan(0);       // a wind from the east on an eastward line
      expect(first.elevationM).toBeCloseTo(1600, 0);
      expect(res.body.convergenceDeg).toBeLessThan(0.01);
    } finally {
      await app.close();
    }
  });

  test("adds a height stack when asked, and reports the factors", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url,
        "/v1/line?lat=40.0150&lon=-105.2705&bearingDeg=90&lengthM=600&stepM=300&heightsM=2,10");
      expect(res.body.plane.heightsAglM).toEqual([2, 10]);
      expect(res.body.plane.alongMps.length).toBe(2);
      expect(res.body.plane.alongMps[0].length).toBe(3);
      // Slower near the ground: the log law, and the reason the stack exists.
      expect(Math.abs(res.body.plane.alongMps[0][0]))
        .toBeLessThan(Math.abs(res.body.plane.alongMps[1][0]));
      expect(res.body.plane.upMps[0][0]).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("a line that leaves the field is the caller's mistake, not a 500", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url,
        "/v1/line?lat=40.0150&lon=-105.2705&bearingDeg=90&lengthM=40000&stepM=1000");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("outside-domain");
      expect(res.body.error).toMatch(/leaves the field/);
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/windprofile", () => {
  test("emits a field the published contract accepts", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url,
        "/v1/windprofile?lat=40.0150&lon=-105.2705&azimuthDeg=90&rangeM=900&stepM=300&heightsM=0.6,3");
      expect(res.status).toBe(200);
      const check = profile.validateWindProfile(res.body.windProfile, { shotAzimuthDeg: 90 });
      expect(check.ok).toBe(true);
      expect(res.body.windProfile.frame).toBe("shooter");
      expect(res.body.windProfile.source).toMatch(/WindSolver/);
      expect(res.body.windProfile.terrainResolutionM).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("refuses a bearing outside the compass before it fetches anything", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, "/v1/windprofile?lat=40.0150&lon=-105.2705&azimuthDeg=400&rangeM=900");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("bad-parameter");
      expect(res.body.parameter).toBe("azimuthDeg");
      expect(svc.calls.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("parameters", () => {
  test.each([
    ["/v1/field?lon=-105", "lat"],
    ["/v1/field?lat=40.015", "lon"],
    ["/v1/field?lat=91&lon=-105", "lat"],
    ["/v1/field?lat=40&lon=-181", "lon"],
    ["/v1/field?lat=40&lon=-105&radiusMiles=0", "radiusMiles"],
    ["/v1/field?lat=40&lon=-105&radiusMiles=abc", "radiusMiles"],
    ["/v1/line?lat=40&lon=-105&lengthM=900", "bearingDeg"],
    ["/v1/line?lat=40&lon=-105&bearingDeg=90", "lengthM"],
    ["/v1/line?lat=40&lon=-105&bearingDeg=90&lengthM=900&heightsM=10,2", "heightsM"]
  ])("refuses %s and names the parameter", async (path, parameter) => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, path);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("bad-parameter");
      expect(res.body.parameter).toBe(parameter);
      expect(svc.calls.length).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("engine failures", () => {
  function erroring(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return stubService({ error: err });
  }

  test.each([
    ["no-domain", 400],
    ["box-crosses-antimeridian", 400],
    ["outside-domain", 400],
    ["too-large", 413],
    ["no-terrain", 502],
    ["not-grib", 502],
    ["html-response", 502],
    ["subregion-ignored", 502],
    ["no-cycle", 503],
    ["http-error", 502]
  ])("maps %s onto %i", async (code, status) => {
    const svc = erroring(code, "the engine's own sentence about " + code);
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=5");
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expect(res.body.error).toBe("the engine's own sentence about " + code);
    } finally {
      await app.close();
    }
  });

  test("an unrecognised failure is a 500 that leaks nothing", async () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'secretPath')");
    const app = await listen({ field: stubService({ error: err }), log: function () {} });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=5");
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("internal");
      expect(res.text).not.toMatch(/secretPath/);
      expect(res.text).not.toMatch(/at Object|\.js:\d/);
    } finally {
      await app.close();
    }
  });
});

describe("limits", () => {
  test("a solve slower than the timeout is a 504, not a hung socket", async () => {
    const app = await listen({
      field: stubService({ delayMs: 200 }),
      timeoutMs: 40,
      log: function () {}
    });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=5");
      expect(res.status).toBe(504);
      expect(res.body.code).toBe("timeout");
      expect(res.body.timeoutMs).toBe(40);
    } finally {
      await app.close();
    }
  });

  test("only so many solves run at once; the rest wait", async () => {
    const svc = stubService({ delayMs: 60 });
    let peak = 0;
    const app = await listen({
      field: {
        get: async function (spec) {
          peak = Math.max(peak, ++app.inFlight || (app.inFlight = 1));
          try {
            return await svc.get(spec);
          } finally {
            app.inFlight--;
          }
        }
      },
      maxConcurrent: 2,
      maxQueue: 10,
      timeoutMs: 5000
    });
    app.inFlight = 0;
    try {
      const paths = [];
      for (let i = 0; i < 6; i++) paths.push("/v1/field?lat=40.0150&lon=-105.2705&cols=3");
      const all = await Promise.all(paths.map((p) => get(app.url, p)));
      for (const res of all) expect(res.status).toBe(200);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      await app.close();
    }
  });

  test("a full queue is refused with a Retry-After, not queued forever", async () => {
    const app = await listen({
      field: stubService({ delayMs: 120 }),
      maxConcurrent: 1,
      maxQueue: 1,
      timeoutMs: 5000,
      log: function () {}
    });
    try {
      const paths = [];
      for (let i = 0; i < 5; i++) paths.push("/v1/field?lat=40.0150&lon=-105.2705&cols=3");
      const all = await Promise.all(paths.map((p) => get(app.url, p)));
      const refused = all.filter((r) => r.status === 503);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused[0].body.code).toBe("busy");
      expect(refused[0].headers.get("retry-after")).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

describe("the browser calling it", () => {
  test("answers a preflight and allows a cross-origin read", async () => {
    const app = await listen({ field: stubService(), origins: ["https://ballisticvector.com"] });
    try {
      const res = await fetch(app.url + "/v1/field?lat=40&lon=-105", {
        method: "OPTIONS",
        headers: { origin: "https://ballisticvector.com" }
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://ballisticvector.com");

      const other = await fetch(app.url + "/v1/field?lat=40&lon=-105", {
        method: "OPTIONS",
        headers: { origin: "https://example.com" }
      });
      expect(other.headers.get("access-control-allow-origin")).toBe(null);
    } finally {
      await app.close();
    }
  });
});

describe("createServer", () => {
  test("is an http.Server, so it is deployed like any other node service", async () => {
    const srv = server.createServer({ field: stubService() });
    expect(srv).toBeInstanceOf(http.Server);
    srv.close();
  });
});
