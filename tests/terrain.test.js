/**
 * The one module here that makes requests, tested with no network.
 *
 * `fetch` is injected, and every fixture is a file on disk served through a
 * fake that behaves the way S3 does — 206 and a `Content-Range` for a `Range`
 * header, 200 and the whole file when told to ignore it. That is enough to
 * pin the two things that matter and cannot be seen from a passing download:
 * that a window really is a window, and that the reader copes with a directory
 * at the end of the file instead of assuming the front.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const dem = require("../dem.js");
const terrain = require("../terrain.js");

const FIXTURES = path.join(__dirname, "fixtures");

/**
 * An S3-shaped server over a buffer, which records what was asked of it.
 *
 * `ignoreRange` is the failure this exists to catch: a server that answers 200
 * with the whole file. A reader that does not check the status downloads 400 MB
 * and looks slow rather than broken.
 */
function server(buffer, opts) {
  const o = opts || {};
  const calls = [];
  async function fetchImpl(url, init) {
    const header = (init && init.headers && init.headers.Range) || "";
    const m = /^bytes=(\d+)-(\d+)$/.exec(header);
    calls.push({ url: url, range: header, start: m ? Number(m[1]) : null });

    if (o.ignoreRange || !m) {
      return { status: 200, arrayBuffer: async () => bufferToArrayBuffer(buffer) };
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), buffer.length - 1);
    return { status: 206, arrayBuffer: async () => bufferToArrayBuffer(buffer.subarray(start, end + 1)) };
  }
  fetchImpl.calls = calls;
  fetchImpl.bytesServed = function () {
    return calls.length;
  };
  return fetchImpl;
}

function bufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

/** The lat/long bounds of a fixture, so a test can ask for part of them. */
function boundsOf(name) {
  const buf = fixture(name);
  const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: buf }]));
  return { header: header, buffer: buf, bounds: cog.levelBounds(header, header.levels[0]) };
}

function middleOf(bounds, fraction) {
  const f = fraction === undefined ? 0.25 : fraction;
  const dx = (bounds.east - bounds.west) * f;
  const dy = (bounds.north - bounds.south) * f;
  return {
    west: bounds.west + dx, east: bounds.east - dx,
    south: bounds.south + dy, north: bounds.north - dy
  };
}

describe("rangeReaderFor", () => {
  test("asks for the bytes it wants, and gets only those", async () => {
    const buf = fixture("cog-lzw-p3.tif");
    const fetchImpl = server(buf);
    const read = terrain.rangeReaderFor("https://example.test/a.tif", { fetch: fetchImpl });

    const got = await read(100, 32);
    expect(got.length).toBe(32);
    expect(Array.from(got)).toEqual(Array.from(buf.subarray(100, 132)));
    expect(fetchImpl.calls[0].range).toBe("bytes=100-131");
    expect(read.stats()).toEqual({ bytes: 32, requests: 1 });
  });

  test("refuses a server that ignores Range and sends the whole file", async () => {
    const fetchImpl = server(fixture("cog-lzw-p3.tif"), { ignoreRange: true });
    const read = terrain.rangeReaderFor("https://example.test/a.tif", { fetch: fetchImpl });
    await expect(read(0, 16)).rejects.toMatchObject({ code: "no-range-support", status: 200 });
  });

  test("the byte budget is spent across the whole read, not per request", async () => {
    const read = terrain.rangeReaderFor("https://example.test/a.tif", {
      fetch: server(fixture("cog-lzw-p3.tif")),
      maxBytes: 100
    });
    await read(0, 60);
    await expect(read(60, 60)).rejects.toMatchObject({ code: "too-many-bytes" });
  });

  test("refuses to run with no fetch rather than reaching for a global one", () => {
    expect(() => terrain.rangeReaderFor("https://example.test/a.tif", { fetch: null }))
      .toThrow(/no fetch implementation/);
  });
});

describe("openCog", () => {
  test("a front-loaded file's directories come out of the first read", async () => {
    const fetchImpl = server(fixture("cog-lzw-p3.tif"));
    const read = terrain.rangeReaderFor("https://example.test/a.tif", { fetch: fetchImpl });
    const opened = await terrain.openCog(read);

    expect(opened.headerReads).toBe(1);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(opened.header.levels[0].width).toBe(128);
  });

  test("a trailing directory costs one more request, not a failure", async () => {
    // The layout a front-only reader silently fails on. Made by
    // tools/trailing-ifd.py, and GDAL still reads it.
    const fetchImpl = server(fixture("cog-trailing-ifd.tif"));
    const read = terrain.rangeReaderFor("https://example.test/a.tif", {
      fetch: fetchImpl,
      headerBytes: 4096
    });
    const opened = await terrain.openCog(read, { headerBytes: 4096 });

    expect(opened.headerReads).toBeGreaterThan(1);
    expect(opened.headerReads).toBeLessThanOrEqual(3);
    expect(opened.header.levels[0].width).toBe(128);
    expect(opened.header.crs.epsg).toBe(4269);
  });

  test("gives up on a file whose directories are scattered, instead of crawling it", async () => {
    let n = 0;
    async function read() {
      n++;
      // Always the front of the file, so the parser keeps asking for the tail.
      return fixture("cog-trailing-ifd.tif").subarray(0, 512);
    }
    await expect(terrain.openCog(read, { headerBytes: 512, maxRoundTrips: 3 }))
      .rejects.toMatchObject({ code: "header-scattered" });
    expect(n).toBe(3);
  });
});

describe("readWindow", () => {
  const lzw = boundsOf("cog-lzw-p3.tif");

  test("reads a window's own tiles and nothing else", async () => {
    const fetchImpl = server(lzw.buffer);
    const box = middleOf(lzw.bounds, 0.4);
    const grid = await terrain.readWindow("https://example.test/a.tif", box, {
      fetch: fetchImpl,
      level: 0,
      // The fixture is 52 KB, smaller than the 64 KB the reader speculatively
      // takes off the front of a real tile, so the header read alone would be
      // the whole file and there would be nothing to measure.
      headerBytes: 2048
    });

    expect(grid.width).toBeGreaterThan(0);
    expect(grid.bytesRead).toBeLessThan(lzw.buffer.length / 2);
    // 32 x 32 tiles over a 128 x 96 raster is twelve; the middle of it is fewer.
    expect(grid.tilesRead).toBeLessThan(12);
    expect(grid.requests).toBeGreaterThanOrEqual(2);
  });

  test("the window holds the same elevations as the whole file does there", async () => {
    const box = middleOf(lzw.bounds, 0.3);
    const grid = await terrain.readWindow("https://example.test/a.tif", box, {
      fetch: server(lzw.buffer),
      level: 0
    });

    const full = cog.assembleWindow(
      lzw.header,
      lzw.header.levels[0],
      { x0: 0, y0: 0, x1: 128, y1: 96 },
      wholeTiles(lzw)
    );

    // Every pixel, not a sample: an off-by-one in the tile paste shows up at a
    // tile seam and nowhere else, so a sparse comparison would miss it.
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        expect(grid.values[y * grid.width + x]).toBe(
          full.values[(grid.y0 + y) * full.width + (grid.x0 + x)]
        );
      }
    }
  });

  test("a coarser target resolution reads fewer bytes for the same ground", async () => {
    const box = middleOf(lzw.bounds, 0.05);
    const fine = await terrain.readWindow("https://example.test/a.tif", box, {
      fetch: server(lzw.buffer),
      targetResolutionM: 10
    });
    const coarse = await terrain.readWindow("https://example.test/a.tif", box, {
      fetch: server(lzw.buffer),
      targetResolutionM: 40
    });

    expect(coarse.width).toBeLessThan(fine.width);
    expect(coarse.bytesRead).toBeLessThan(fine.bytesRead);
    expect(coarse.resolutionM).toBeGreaterThan(fine.resolutionM);
  });

  test("a projected tile is windowed through its projection", async () => {
    const utm = boundsOf("cog-utm13-1m.tif");
    const grid = await terrain.readWindow("https://example.test/utm.tif", middleOf(utm.bounds, 0.3), {
      fetch: server(utm.buffer),
      level: 0
    });
    expect(grid.crs.epsg).toBe(26913);
    expect(grid.values.some((v) => v > 2000)).toBe(true);
  });

  test("refuses a box that does not touch the tile rather than returning empty ground", async () => {
    await expect(terrain.readWindow("https://example.test/a.tif", {
      west: 10, east: 11, south: 10, north: 11
    }, { fetch: server(lzw.buffer), level: 0 })).rejects.toMatchObject({ code: "outside-tile" });
  });

  test("refuses a box that wraps the antimeridian instead of reading it inside out", async () => {
    await expect(terrain.readWindow("https://example.test/a.tif", {
      west: 179, east: -179, south: 10, north: 11
    }, { fetch: server(lzw.buffer) })).rejects.toMatchObject({ code: "box-crosses-antimeridian" });
  });

  test("a window too big for the budget is refused before it is downloaded", async () => {
    await expect(terrain.readWindow("https://example.test/a.tif", lzw.bounds, {
      fetch: server(lzw.buffer),
      level: 0,
      maxBytes: 20000
    })).rejects.toMatchObject({ code: "too-many-bytes" });
  });
});

/** Every tile of a fixture, decoded, for comparison against a window of it. */
function wholeTiles(f) {
  const level = f.header.levels[0];
  const decoded = new Map();
  cog.tilesForWindow(level, { x0: 0, y0: 0, x1: level.width, y1: level.height }).forEach(function (tile) {
    if (tile.empty) return;
    decoded.set(
      tile.tx + "," + tile.ty,
      cog.decodeTile(f.buffer.subarray(tile.offset, tile.offset + tile.byteCount), level, f.header)
    );
  });
  return decoded;
}

describe("readTerrain", () => {
  const lzw = boundsOf("cog-lzw-p3.tif");
  const box = middleOf(lzw.bounds, 0.3);

  /** What dem.discover would have returned, without asking TNM. */
  function selection(urls) {
    return {
      dataset: { id: "one-third", resolutionM: 10, label: "1/3 arc-second DEM" },
      coverage: 1,
      downloadBytes: 400000000,
      tiles: urls.map(function (url) {
        return { downloadUrl: url, box: lzw.bounds, sizeInBytes: 400000000 };
      }),
      considered: []
    };
  }

  test("returns one grid per tile touched, rather than pretending a domain is one file", async () => {
    const out = await terrain.readTerrain(box, {
      selection: selection(["https://example.test/a.tif", "https://example.test/b.tif"]),
      fetch: server(lzw.buffer),
      level: 0
    });

    expect(out.grids).toHaveLength(2);
    expect(out.dataset.id).toBe("one-third");
    expect(out.bytesRead).toBeGreaterThan(0);
    expect(out.requests).toBeGreaterThanOrEqual(out.grids.length);
  });

  test("reports what the window cost against what the tiles weigh", async () => {
    const out = await terrain.readTerrain(box, {
      selection: selection(["https://example.test/a.tif"]),
      fetch: server(lzw.buffer),
      level: 0
    });
    // The point of the whole module: a fraction of a per cent of the tile.
    expect(out.bytesRead).toBeLessThan(out.wholeTileBytes / 1000);
  });

  test("a tile that is all hole over the box sorts behind one that is not", async () => {
    // Not hypothetical: over Boulder the newer of the two listed 1 m tiles is
    // nodata across the whole domain, and the 2013 project under it holds the
    // ground. Newest-per-footprint alone would have answered null.
    const hole = boundsOf("cog-nodata-hole.tif");
    const bothFetch = async function (url, init) {
      const buf = /hole/.test(url) ? hole.buffer : lzw.buffer;
      return server(buf)(url, init);
    };
    // A box inside the hole, so that grid is entirely void and the other is not.
    const inHole = {
      west: hole.bounds.west + (hole.bounds.east - hole.bounds.west) * 0.35,
      east: hole.bounds.west + (hole.bounds.east - hole.bounds.west) * 0.7,
      south: hole.bounds.north - (hole.bounds.north - hole.bounds.south) * 0.55,
      north: hole.bounds.north - (hole.bounds.north - hole.bounds.south) * 0.25
    };

    const out = await terrain.readTerrain(inHole, {
      selection: selection(["https://example.test/hole.tif", "https://example.test/b.tif"]),
      fetch: bothFetch,
      level: 0
    });

    expect(out.grids[0].voidFraction).toBe(0);
    expect(out.grids[1].voidFraction).toBe(1);
    expect(out.allVoid).toBe(false);
    expect(terrain.elevationAt(
      out.grids,
      (inHole.north + inHole.south) / 2,
      (inHole.west + inHole.east) / 2
    )).toBeGreaterThan(2000);
  });

  test("discovers over the injected fetch when no fetchJson is given", async () => {
    // Without a default the discovery call is made with `undefined`, every
    // dataset throws the same TypeError, and the per-dataset guard turns that
    // into "no 3DEP product covers this box" over ground that 3DEP covers.
    const listing = {
      total: 1,
      items: [{
        title: "USGS 1/3 Arc Second test",
        format: "GeoTIFF",
        downloadURL: "https://example.test/a.tif",
        publicationDate: "2022-01-01",
        boundingBox: {
          minX: lzw.bounds.west,
          maxX: lzw.bounds.east,
          minY: lzw.bounds.south,
          maxY: lzw.bounds.north
        }
      }]
    };
    const tiles = server(lzw.buffer);
    const fetchImpl = async function (url, init) {
      if (url.startsWith(dem.TNM_PRODUCTS_URL)) {
        return { ok: true, status: 200, json: async () => listing };
      }
      return tiles(url, init);
    };

    const out = await terrain.readTerrain(box, { fetch: fetchImpl, level: 0 });
    expect(out.grids).toHaveLength(1);
  });

  test("a listing request that fails says so, rather than reading as empty country", async () => {
    // "The National Map is down" and "there is no lidar here" are the same
    // answer from the caller's side unless the refusal carries the cause.
    const fetchImpl = async function () {
      return { ok: false, status: 503, text: async () => "busy" };
    };
    const err = await terrain.readTerrain(box, { fetch: fetchImpl }).catch((e) => e);
    expect(err.code).toBe("no-terrain");
    expect(err.considered.every((c) => c.error)).toBe(true);
    expect(err.message).toMatch(/503/);
    // Each dataset's reason is quoted inside this one sentence, so a product
    // search carrying its own query string puts 300 characters of URL in front
    // of a person. The listing URL belongs on the error, not in the prose.
    expect(err.message).not.toMatch(/https?:\/\//);
    expect(err.considered[0].error).not.toMatch(/https?:\/\//);
  });

  test("refuses a box no product covers, and says what it considered", async () => {
    await expect(terrain.readTerrain(box, {
      selection: { dataset: null, tiles: [], considered: [{ datasetId: "1m", coverage: 0 }] }
    })).rejects.toMatchObject({ code: "no-terrain" });
  });

  test("what it considered reads as a sentence, with the list still on the error", async () => {
    // The refusal reaches a person — it is the text a UI shows — so the message
    // is prose and the machine-readable list rides alongside it rather than
    // being stringified into the middle of it.
    const considered = [
      { datasetId: "1m", coverage: 0.12 },
      { datasetId: "1/3 arc-second", error: "The National Map answered 503" }
    ];
    const err = await terrain.readTerrain(box, {
      selection: { dataset: null, tiles: [], considered: considered }
    }).catch((e) => e);

    expect(err.message).toContain("1m 12% covered");
    expect(err.message).toContain("1/3 arc-second (The National Map answered 503)");
    expect(err.message).not.toContain("{");
    expect(err.considered).toEqual(considered);
  });
});

describe("elevationAt", () => {
  test("the first grid holding real ground at that point answers", async () => {
    const lzw = boundsOf("cog-lzw-p3.tif");
    const hole = boundsOf("cog-nodata-hole.tif");
    const centre = {
      lat: (lzw.bounds.north + lzw.bounds.south) / 2,
      lon: (lzw.bounds.west + lzw.bounds.east) / 2
    };

    const good = await terrain.readWindow("https://example.test/a.tif", middleOf(lzw.bounds, 0.2), {
      fetch: server(lzw.buffer), level: 0
    });
    const holed = await terrain.readWindow("https://example.test/h.tif", middleOf(hole.bounds, 0.2), {
      fetch: server(hole.buffer), level: 0
    });

    // The hole covers the centre of the raster, so the holed grid alone is null
    // there and the pair is not.
    expect(terrain.elevationAt([holed], centre.lat, centre.lon)).toBeNull();
    expect(terrain.elevationAt([holed, good], centre.lat, centre.lon)).toBeGreaterThan(2000);
  });

  test("a coordinate no grid covers is null, not the nearest ground", async () => {
    const lzw = boundsOf("cog-lzw-p3.tif");
    const grid = await terrain.readWindow("https://example.test/a.tif", middleOf(lzw.bounds, 0.3), {
      fetch: server(lzw.buffer), level: 0
    });
    expect(terrain.elevationAt([grid], 0, 0)).toBeNull();
  });
});
