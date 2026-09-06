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
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const proj = require("../proj.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const png = require("../png.js");
const profile = require("../profile.js");
const server = require("../server.js");

const CENTRE = { lat: 40.0150, lon: -105.2705 };
// A `Date`, because that is what the engine carries. The first version of this
// stub used a string, the suite passed, and the live service put
// `Thu Sep 03 2026 22:00:00 GMT+0000 (Coordinated Universal Time)` in the middle
// of its `source` line.
const VALID_TIME = new Date("2026-09-03T21:00:00.000Z");
const VALID_TIME_ISO = "2026-09-03T21:00:00.000Z";

/** The ground alone, shaped exactly as `fieldService.terrain` returns it. */
function fakeGround(opts) {
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
  const halfLatDeg = (height * spacing) / 2 / 111320;
  const halfLonDeg = (width * spacing) / 2 / (111320 * Math.cos(CENTRE.lat * Math.PI / 180));
  return {
    grid: grid,
    derived: derived,
    weights: downscale.terrainWeights(derived, { curvatureLengthM: 200 }),
    dataset: "1m",
    resolutionM: 1,
    box: {
      south: CENTRE.lat - halfLatDeg,
      north: CENTRE.lat + halfLatDeg,
      west: CENTRE.lon - halfLonDeg,
      east: CENTRE.lon + halfLonDeg
    }
  };
}

/** A field over flat ground at Boulder, shaped exactly as `field.js` returns one. */
function fakeField(opts) {
  const o = opts || {};
  const spacing = o.spacing || 20;
  const land = fakeGround(o);
  const weights = land.weights;
  const wind = o.wind || { east: -3.0, north: 0.2 };
  const field = downscale.downscale(weights, wind, { heightAglM: 10, shelter: false });

  return Object.assign(field, {
    weights: weights,
    domain: land.box,
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

/**
 * The default field, built once.
 *
 * `fakeField` runs the real `derive` and `downscale` over a 201 x 201 grid, and
 * inside jest that costs a few hundred milliseconds rather than the ~25 ms it
 * costs outside it. The concurrency test asks for six fields at once, so
 * rebuilding per call put the test within a whisker of jest's 5 s ceiling here
 * and over it on a CI runner. The service only reads a field, so one is enough.
 */
let defaultField = null;
function sharedField() {
  if (!defaultField) defaultField = fakeField();
  return defaultField;
}

let defaultGround = null;
function sharedGround() {
  if (!defaultGround) defaultGround = fakeGround();
  return defaultGround;
}

/** A field service that answers with a canned field, or throws a canned error. */
function stubService(opts) {
  const o = opts || {};
  return {
    calls: [],
    terrainCalls: [],
    get: async function (spec) {
      this.calls.push(spec);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.error) throw o.error;
      return o.field || sharedField();
    },
    terrain: async function (spec) {
      this.terrainCalls.push(spec);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.terrainError || o.error) throw o.terrainError || o.error;
      const land = o.ground || sharedGround();
      return Object.assign({ domain: { box: land.box, readBox: land.box, paddingM: 0 } }, land);
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

async function get(base, path, headers) {
  const res = await fetch(base + path, headers ? { headers: headers } : undefined);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsed: text };
  }
  return { status: res.status, headers: res.headers, body: body, text: text };
}

/**
 * A request with the path written on the wire exactly as given.
 *
 * `fetch` resolves `..` in the client before the bytes leave, so a traversal
 * test written with it proves undici's normaliser works and nothing about the
 * server. A socket does not tidy anything up.
 */
function rawGet(base, rawPath) {
  const port = Number(new URL(base).port);
  return new Promise(function (resolve, reject) {
    const socket = net.connect(port, "127.0.0.1", function () {
      socket.write("GET " + rawPath + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", function (chunk) { text += chunk; });
    socket.on("error", reject);
    socket.on("end", function () {
      const status = Number((/^HTTP\/1\.1 (\d+)/.exec(text) || [])[1]);
      resolve({ status: status, text: text });
    });
  });
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

/**
 * The greys back out of a PNG.
 *
 * Short, because `png.js` is already graded against GDAL reading its output;
 * what this suite needs is the pixels, so that "flat ground is lit" and "a hole
 * is transparent" are assertions about the picture rather than about its
 * length.
 */
function decodeGrey(buffer) {
  const chunks = png.chunksOf(buffer);
  const ihdr = chunks.find(function (c) { return c.type === "IHDR"; });
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const idat = Buffer.concat(chunks.filter(function (c) { return c.type === "IDAT"; })
    .map(function (c) { return c.data; }));
  const raw = zlib.inflateSync(idat);
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    for (let x = 0; x < width; x++) {
      const value = raw[y * (width + 1) + 1 + x];
      const a = x > 0 ? out[y * width + x - 1] : 0;
      const b = y > 0 ? out[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? out[(y - 1) * width + x - 1] : 0;
      const base = filter === 0 ? 0
        : filter === 1 ? a
          : filter === 2 ? b
            : filter === 3 ? Math.floor((a + b) / 2)
              : png.paeth(a, b, c);
      out[y * width + x] = (value + base) & 0xff;
    }
  }
  return { width: width, height: height, values: out };
}

async function getBytes(base, path, headers) {
  const res = await fetch(base + path, headers ? { headers: headers } : undefined);
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.from(await res.arrayBuffer())
  };
}

describe("GET /v1/hillshade", () => {
  test("answers with a PNG placed on the ground the field is solved over", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await getBytes(app.url, "/v1/hillshade?lat=40.0150&lon=-105.2705&width=64");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

      const image = decodeGrey(res.body);
      expect(image.width).toBe(64);
      expect(res.headers.get("x-windsolver-size")).toBe(image.width + "," + image.height);

      // The bounds the caller places the picture on are the service's domain,
      // not the box in the query: a picture placed on the requested box is off
      // by however much the domain was snapped or padded, and nothing about it
      // looks wrong.
      const bounds = res.headers.get("x-windsolver-bounds").split(",").map(Number);
      const domain = sharedGround().box;
      expect(bounds[0]).toBeCloseTo(domain.south, 6);
      expect(bounds[1]).toBeCloseTo(domain.west, 6);
      expect(bounds[2]).toBeCloseTo(domain.north, 6);
      expect(bounds[3]).toBeCloseTo(domain.east, 6);
      expect(res.headers.get("x-windsolver-sun")).toBe("315,45");
      expect(res.headers.get("x-windsolver-terrain-dataset")).toBe("1m");
    } finally {
      await app.close();
    }
  });

  test("costs no atmosphere, so a picture of the ground does not wait on NOMADS", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await getBytes(app.url, "/v1/hillshade?lat=40.0150&lon=-105.2705&width=32");
      expect(res.status).toBe(200);
      expect(svc.terrainCalls.length).toBe(1);
      // The whole point of the separate route and the separate cache: the
      // ground is answerable while the wind over it is still being fetched.
      expect(svc.calls.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("lights flat ground evenly, at the sine of the sun's altitude", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await getBytes(app.url,
        "/v1/hillshade?lat=40.0150&lon=-105.2705&width=32&altitudeDeg=30");
      const image = decodeGrey(res.body);
      const expected = Math.round(1 + 254 * Math.sin(30 * Math.PI / 180));
      for (const v of image.values) expect(Math.abs(v - expected)).toBeLessThanOrEqual(1);
      expect(res.headers.get("x-windsolver-covered")).toBe("1");
    } finally {
      await app.close();
    }
  });

  test("shades a slope differently from the flat ground beside it", async () => {
    const svc = stubService({
      ground: fakeGround({ z: function (col) { return 1600 + (col > 100 ? (col - 100) * 4 : 0); } })
    });
    const app = await listen({ field: svc });
    try {
      const res = await getBytes(app.url, "/v1/hillshade?lat=40.0150&lon=-105.2705&width=64");
      const image = decodeGrey(res.body);
      const row = Math.floor(image.height / 2);
      const flat = image.values[row * image.width + 8];
      const facing = image.values[row * image.width + image.width - 8];
      // West-facing ground under a sun in the north-west is brighter than
      // level ground; the sign of that difference is the whole point of the
      // picture, and getting it backwards is the classic hillshade bug.
      expect(facing).toBeGreaterThan(flat);

      // And the sun moves: put it in the south-east and the same slope faces
      // away. Without this the assertion above passes on a picture that
      // ignores the azimuth entirely.
      const other = decodeGrey((await getBytes(app.url,
        "/v1/hillshade?lat=40.0150&lon=-105.2705&width=64&azimuthDeg=135")).body);
      expect(other.values[row * other.width + other.width - 8])
        .toBeLessThan(other.values[row * other.width + 8]);
    } finally {
      await app.close();
    }
  });

  test("keeps a hole in the terrain transparent, and says how much it covered", async () => {
    const svc = stubService({
      ground: fakeGround({ z: function (col, row) { return row < 60 ? NaN : 1600; } })
    });
    const app = await listen({ field: svc });
    try {
      const res = await getBytes(app.url, "/v1/hillshade?lat=40.0150&lon=-105.2705&width=64");
      const image = decodeGrey(res.body);
      expect(image.values[2]).toBe(0);
      expect(image.values[image.values.length - 3]).toBeGreaterThan(0);
      // Nothing here invents ground: a void reads as transparent and the
      // header says how much of the box the picture actually covers, so a
      // caller drawing this over a basemap does not read a hole as flat.
      expect(Number(res.headers.get("x-windsolver-covered"))).toBeLessThan(1);
      expect(Number(res.headers.get("x-windsolver-covered"))).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  test("refuses more pixels than it will draw, before it reads any terrain", async () => {
    const svc = stubService();
    const app = await listen({ field: svc, maxHillshadePixels: 1000 });
    try {
      const res = await get(app.url, "/v1/hillshade?lat=40.0150&lon=-105.2705&width=512");
      expect(res.status).toBe(413);
      expect(res.body.code).toBe("too-many-pixels");
      expect(res.body.maxPixels).toBe(1000);
      expect(svc.terrainCalls.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("refuses in JSON, not in a broken image", async () => {
    const svc = stubService();
    const app = await listen({ field: svc });
    try {
      const res = await get(app.url, "/v1/hillshade?lat=40.0150&lon=-105.2705&altitudeDeg=0");
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.body.parameter).toBe("altitudeDeg");
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
    // Wall-clock headroom, not patience for a slow assertion: this test and the
    // one below wait on real sockets and real timers, and a shared CI runner
    // should fail them for being wrong rather than for being busy.
  }, 30000);

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
  }, 30000);
});

/**
 * The stations.
 *
 * A stub station service, because the interesting failures here are the route's
 * and not FEMS's: what the route says when the provider is down, and whether an
 * observation can reach a caller without the word "measured" attached to it.
 */
function stubStations(opts) {
  const o = opts || {};
  return {
    boxes: [],
    inBox: async function (box, options) {
      this.boxes.push({ box: box, options: options });
      if (o.error) throw o.error;
      const observed = options.observed !== false;
      return {
        matched: 24,
        returned: 1,
        truncated: true,
        observed: observed && !o.observationsDown,
        window: { start: "2026-09-04T11:00:00.000Z", end: "2026-09-04T17:00:00.000Z" },
        directory: {
          provider: "fems", network: "RAWS", count: 2088,
          retrievedAt: "2026-09-04T00:00:00.000Z", ageS: 61200, stale: false, error: null
        },
        errors: o.observationsDown
          ? [{ code: "observations-unavailable", error: "FEMS answered 502" }]
          : [],
        stations: [{
          id: "50604", name: "SUGARLOAF", network: "RAWS", provider: "fems",
          lat: 40.018, lon: -105.361, elevationM: 2052.2, sensorHeightM: null,
          state: "CO", agency: "USFS", distanceM: 8123.4,
          observation: observed && !o.observationsDown ? {
            time: "2026-09-04T17:00:00.000Z", timeIsHourBin: true, transmitMinute: null,
            hourLabel: "2026-09-04T17:00:00.000Z", speedMps: 1.34112, fromDeg: 110,
            calm: false, gustMps: 3.57632, qcChecked: false, qcFlags: null, ageS: 600
          } : null,
          observationNote: o.observationsDown ? "FEMS answered 502" : null,
          observationCode: o.observationsDown ? "observations-unavailable" : null
        }]
      };
    }
  };
}

describe("GET /v1/stations", () => {
  test("answers with the stations round a point, and says they are measured", async () => {
    const stations = stubStations();
    const app = await listen({ field: stubService(), stations: stations });
    try {
      const res = await get(app.url, "/v1/stations?lat=40.0150&lon=-105.2705&radiusMiles=25");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // The one field a consumer must not have to infer. Everything else on
      // this service is modelled; this route is the only measured thing in it,
      // and a client that merges the two without noticing has invented an
      // observation.
      expect(res.body.modelled).toBe(false);
      expect(res.body.notice).toMatch(/Measured, not modelled/);
      expect(res.body.units.direction).toBe("degrees the wind blows from");
      expect(res.body.matched).toBe(24);
      expect(res.body.truncated).toBe(true);

      const s = res.body.stations[0];
      expect(s.id).toBe("50604");
      expect(s.network).toBe("RAWS");
      expect(s.observation.speedMps).toBeCloseTo(1.34112, 5);
      expect(s.observation.fromDeg).toBe(110);
      // Kept out of the payload's tidiness on purpose: an hour label is up to
      // half an hour from the measurement, and a client that pairs on it
      // without knowing that gets a diurnal error that reads as a model error.
      expect(s.observation.timeIsHourBin).toBe(true);
      expect(s.observation.ageS).toBe(600);
      expect(s.sensorHeightM).toBe(null);
      expect(res.body.directory.provider).toBe("fems");
    } finally {
      await app.close();
    }
  });

  test("the box is cut from the radius asked for", async () => {
    const stations = stubStations();
    const app = await listen({ field: stubService(), stations: stations });
    try {
      await get(app.url, "/v1/stations?lat=40&lon=-105&radiusMiles=10&limit=5");
      const call = stations.boxes[0];
      expect(call.options.limit).toBe(5);
      expect(call.box.north).toBeGreaterThan(40);
      expect(call.box.south).toBeLessThan(40);
    } finally {
      await app.close();
    }
  });

  test("locations without observations when the caller says so", async () => {
    const stations = stubStations();
    const app = await listen({ field: stubService(), stations: stations });
    try {
      const res = await get(app.url, "/v1/stations?lat=40&lon=-105&observed=false");
      expect(res.status).toBe(200);
      expect(res.body.observed).toBe(false);
      expect(res.body.stations[0].observation).toBe(null);
      expect(stations.boxes[0].options.observed).toBe(false);
    } finally {
      await app.close();
    }
  });

  test("a half-answered boolean is refused rather than guessed", async () => {
    const app = await listen({ field: stubService(), stations: stubStations() });
    try {
      const res = await get(app.url, "/v1/stations?lat=40&lon=-105&observed=maybe");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("bad-parameter");
      expect(res.body.parameter).toBe("observed");
    } finally {
      await app.close();
    }
  });

  test("a radius bigger than the service will serve is refused, by number", async () => {
    const app = await listen({ field: stubService(), stations: stubStations() });
    try {
      const res = await get(app.url, "/v1/stations?lat=40&lon=-105&radiusMiles=5000");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("bad-parameter");
    } finally {
      await app.close();
    }
  });

  test("an observation outage keeps the markers and names itself", async () => {
    // The alternative is a map that empties out and looks like a calm night.
    const app = await listen({
      field: stubService(), stations: stubStations({ observationsDown: true })
    });
    try {
      const res = await get(app.url, "/v1/stations?lat=40&lon=-105");
      expect(res.status).toBe(200);
      expect(res.body.observed).toBe(false);
      expect(res.body.stations[0].observation).toBe(null);
      expect(res.body.stations[0].observationCode).toBe("observations-unavailable");
      expect(res.body.errors[0].error).toMatch(/502/);
    } finally {
      await app.close();
    }
  });

  test("a provider that is down is a bad gateway, not an empty country", async () => {
    const err = new Error("FEMS did not answer");
    err.code = "stations-unavailable";
    const app = await listen({ field: stubService(), stations: stubStations({ error: err }) });
    try {
      const res = await get(app.url, "/v1/stations?lat=40&lon=-105");
      expect(res.status).toBe(502);
      expect(res.body.code).toBe("stations-unavailable");
    } finally {
      await app.close();
    }
  });

  test("a station outage does not stop a wind solve", async () => {
    const err = new Error("FEMS did not answer");
    err.code = "stations-unavailable";
    const app = await listen({ field: stubService(), stations: stubStations({ error: err }) });
    try {
      expect((await get(app.url, "/v1/stations?lat=40&lon=-105")).status).toBe(502);
      const field = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=4");
      expect(field.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  test("the key gate covers it like every other /v1/ route", async () => {
    const KEY = "stations-key-0123456789abcdefghij";
    const app = await listen({
      field: stubService(), stations: stubStations(),
      apiKeys: "ballisticvector:" + KEY, allowPageWithoutKey: false
    });
    try {
      expect((await get(app.url, "/v1/stations?lat=40&lon=-105")).status).toBe(401);
      const ok = await get(app.url, "/v1/stations?lat=40&lon=-105",
        { authorization: "Bearer " + KEY });
      expect(ok.status).toBe(200);
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

describe("an API key on /v1/", () => {
  // Long enough to pass the minimum, and obviously not a real one.
  const KEY = "test-key-0123456789abcdefghij";
  const OTHER = "second-key-0123456789abcdefghij";

  test("with none configured, nothing changes", async () => {
    // The default has to stay open, or every checkout, the suite and a laptop
    // need a credential before the engine will answer once.
    const app = await listen({ field: stubService() });
    try {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=4");
      expect(res.status).toBe(200);
      expect(res.headers.get("www-authenticate")).toBe(null);
    } finally {
      await app.close();
    }
  });

  describe("with keys configured", () => {
    let app;
    let logged;

    beforeAll(async () => {
      logged = [];
      app = await listen({
        field: stubService(),
        apiKeys: "ballisticvector:" + KEY + ",ops:" + OTHER,
        allowPageWithoutKey: false,
        log: function (entry) { logged.push(entry); }
      });
    });

    afterAll(async () => { await app.close(); });

    test("a named key is let through, either way of sending it", async () => {
      const bearer = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=4",
        { authorization: "Bearer " + KEY });
      expect(bearer.status).toBe(200);

      const header = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=4",
        { "x-api-key": OTHER });
      expect(header.status).toBe(200);
    });

    test("no key is 401, and says how to send one", async () => {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("no-key");
      expect(res.body.error).toMatch(/Authorization: Bearer/);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    });

    test("a wrong key is 401, and is not mistaken for a missing one", async () => {
      const res = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705",
        { authorization: "Bearer " + KEY + "x" });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("bad-key");
    });

    test("an Authorization that is not a Bearer is named, not ignored", async () => {
      // Silently treating `Basic …` as "no credential" sends a caller who is
      // trying to authenticate the message for a caller who is not.
      const res = await get(app.url, "/v1/field?lat=40&lon=-105",
        { authorization: "Basic " + Buffer.from("a:b").toString("base64") });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("bad-authorization");
    });

    test("a key in the query string is not a key", async () => {
      // Accepting one would put the secret in this log, nginx's log and every
      // proxy in between.
      const res = await get(app.url, "/v1/field?lat=40&lon=-105&key=" + KEY);
      expect(res.status).toBe(401);
    });

    test("the refusal never quotes the key back, in the body or the log", async () => {
      logged.length = 0;
      const res = await get(app.url, "/v1/field?lat=40&lon=-105&api_key=" + KEY,
        { authorization: "Bearer " + KEY + "-wrong" });
      expect(res.text).not.toContain(KEY);
      expect(JSON.stringify(logged)).not.toContain(KEY);
    });

    test("a solve that is let through is logged by caller name", async () => {
      logged.length = 0;
      await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=4", { "x-api-key": OTHER });
      const info = logged.filter((e) => e.level === "info");
      expect(info.length).toBe(1);
      expect(info[0].caller).toBe("ops");
      expect(JSON.stringify(logged)).not.toContain(OTHER);
    });

    test("a key-shaped query parameter is redacted before it is logged", () => {
      // Belt and braces on the query the success line writes: a caller who
      // sends their secret in the URL has already put it somewhere it should
      // not be, and this log is one of the places.
      expect(server.redactQuery("?lat=40&api_key=" + KEY + "&cols=4"))
        .toBe("?lat=40&api_key=[redacted]&cols=4");
      expect(server.redactQuery("?token=" + KEY)).toBe("?token=[redacted]");
      expect(server.redactQuery("?lat=40&lon=-105")).toBe("?lat=40&lon=-105");
    });

    test("/healthz stays open, or the monitor stops being run", async () => {
      const res = await get(app.url, "/healthz");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test("a route that does not exist is still a 404, not a 401", async () => {
      // 401 on an unknown path turns a typo into a credentials problem and
      // tells a caller their key is wrong when their URL is.
      const res = await get(app.url, "/v1/forecast");
      expect(res.status).toBe(404);
    });

    test("with the page door shut, the page's own fetch is refused too", async () => {
      const res = await get(app.url, "/v1/field?lat=40&lon=-105",
        { "sec-fetch-site": "same-origin" });
      expect(res.status).toBe(401);
    });
  });

  test("with the page door open, the page's own fetch is served", async () => {
    // What keeps windsolver.com working. It is a browser-set header and not a
    // wall — see auth.js — and the point of this test is that the door is
    // exactly one header wide and shuts on everything else.
    const logged = [];
    const app = await listen({
      field: stubService(),
      apiKeys: "ballisticvector:" + KEY,
      log: function (entry) { logged.push(entry); }
    });
    try {
      const page = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705&cols=4",
        { "sec-fetch-site": "same-origin" });
      expect(page.status).toBe(200);
      expect(logged.filter((e) => e.level === "info")[0].caller).toBe("page");

      for (const site of ["cross-site", "same-site", "none"]) {
        const other = await get(app.url, "/v1/field?lat=40&lon=-105", { "sec-fetch-site": site });
        expect(other.status).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});

describe("the page it serves", () => {
  let root;
  let dir;
  let app;

  beforeAll(async () => {
    // The page directory sits *inside* another one holding a file it must not
    // reach, so `../secret.html` names something that really exists: a
    // traversal test whose target is missing anyway passes for the wrong
    // reason and would keep passing with the guard deleted.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-static-"));
    fs.writeFileSync(path.join(root, "secret.html"), "<!doctype html>the private thing");
    dir = path.join(root, "page");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>WindSolver</title>");
    fs.writeFileSync(path.join(dir, "map.js"), "// the page\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a page asset");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "deep.css"), "body{}");

    fs.symlinkSync(path.join(root, "secret.html"), path.join(dir, "escape.html"));

    app = await listen({ field: stubService(), staticDir: dir });
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("serves the page at the root, with its type", async () => {
    const res = await fetch(app.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("WindSolver");
  });

  test("serves a nested asset", async () => {
    const res = await fetch(app.url + "/sub/deep.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/css/);
  });

  test("answers HEAD with the length and no body", async () => {
    const res = await fetch(app.url + "/map.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  test("the API still answers, and the health route is not shadowed by a file", async () => {
    // A file called `healthz` in the page directory must not become the health
    // check: a route is a route whether or not something shares its name.
    fs.writeFileSync(path.join(dir, "healthz"), "not the health check");
    const health = await get(app.url, "/healthz");
    expect(health.status).toBe(200);
    expect(health.body.service).toBe("windsolver");

    const field = await get(app.url, "/v1/field?lat=40.0150&lon=-105.2705");
    expect(field.status).toBe(200);
    expect(field.body.ok).toBe(true);
  });

  test("a missing file is a JSON 404, not a page", async () => {
    // Whoever asked for `/v1/feild` asked in JSON and should be answered in it.
    const res = await get(app.url, "/v1/feild");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no-such-route");
  });

  test("refuses a file type the page does not have", async () => {
    const res = await get(app.url, "/notes.txt");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no-such-route");
  });

  test("will not walk out of the page directory", async () => {
    for (const attempt of [
      "/../secret.html",
      "/%2e%2e/secret.html",
      "/sub/../../secret.html",
      "/....//secret.html",
      "//etc/passwd",
      "/../../../../etc/passwd",
      // The ones that matter: a URL parser removes dot *segments*, and these
      // are not segments until they are decoded. Decoding happens here, so the
      // walk this file has to stop is the one it creates itself.
      "/..%2fsecret.html",
      "/sub%2f..%2f..%2fsecret.html",
      "/%2e%2e%2fsecret.html",
      "/%2fetc%2fpasswd",
      "/..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd"
    ]) {
      const res = await rawGet(app.url, attempt);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain("private thing");
      expect(res.text).not.toContain("root:");
    }
  });

  test("will not follow a symlink out of the page directory", async () => {
    // `path.resolve` cannot see this one: the path stays inside the root and the
    // file does not, which is why the check is repeated against the real path.
    const res = await fetch(app.url + "/escape.html");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("private thing");
  });

  test("a directory is not a page", async () => {
    const res = await get(app.url, "/sub");
    expect(res.status).toBe(404);
  });

  test("serves no page at all when none is configured", async () => {
    const bare = await listen({ field: stubService() });
    try {
      const res = await get(bare.url, "/");
      expect(res.status).toBe(200);
      expect(res.body.service).toBe("windsolver");
    } finally {
      await bare.close();
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
