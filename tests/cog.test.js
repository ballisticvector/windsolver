/**
 * Graded against GDAL, value by value, the same way the GRIB decoder is graded
 * against ecCodes — and for the same reason. Every intermediate number in a
 * TIFF decode is plausible: an LZW table that widens one code late, a
 * floating-point predictor left half-undone, a tile index read at the wrong
 * offset, all produce arrays of numbers that look like terrain. Only a
 * comparison with an independent implementation catches them.
 *
 * The fixtures and their references are made by `tools/make-cog-fixtures.sh`,
 * which cuts small windows out of two real 3DEP tiles with `gdal_translate` and
 * dumps GDAL's own reading of the result:
 *
 *   cog-lzw-p3       128 x 96, EPSG:4269, 1/3 arc-second near Boulder
 *   cog-deflate      the same pixels, Deflate instead of LZW
 *   cog-utm13-1m     128 x 96, EPSG:26913, 1 m lidar, same area
 *   cog-nodata-hole  cog-lzw-p3 with a rectangle punched out
 *
 * `<name>.gdal.json` is the metadata and `<name>.gdal.f32` is every level's
 * pixels as little-endian float32, full resolution first. The header fixtures
 * `usgs-*.bin` are the real first 32 KB of two live 3DEP tiles, so the suite
 * also covers what USGS actually serves rather than only what GDAL writes.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const proj = require("../proj.js");

const FIXTURES = path.join(__dirname, "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function openWhole(name) {
  const buf = fixture(name + ".tif");
  return { header: cog.readHeader(cog.byteSource([{ start: 0, buffer: buf }])), buffer: buf };
}

/** GDAL's own reading of a fixture: metadata, and every level's pixels. */
function reference(name) {
  const meta = JSON.parse(fixture(name + ".gdal.json").toString("utf8"));
  const raw = fixture(name + ".gdal.f32");
  let at = 0;
  meta.levels.forEach(function (level) {
    const n = level.width * level.height;
    level.values = new Float32Array(raw.buffer.slice(raw.byteOffset + at, raw.byteOffset + at + n * 4));
    at += n * 4;
  });
  return meta;
}

/** Every pixel of one level, read the way a window read reads them. */
function readLevel(header, buffer, index) {
  const level = header.levels[index];
  const window = { x0: 0, y0: 0, x1: level.width, y1: level.height };
  const tiles = cog.tilesForWindow(level, window);
  const decoded = new Map();
  tiles.forEach(function (tile) {
    if (tile.empty) return;
    decoded.set(
      tile.tx + "," + tile.ty,
      cog.decodeTile(buffer.subarray(tile.offset, tile.offset + tile.byteCount), level, header)
    );
  });
  return cog.assembleWindow(header, level, window, decoded);
}

describe("readHeader", () => {
  test("reads the geographic fixture the way gdalinfo reads it", () => {
    const { header } = openWhole("cog-lzw-p3");
    const want = reference("cog-lzw-p3");

    expect(header.crs.epsg).toBe(want.epsg);
    expect(header.nodata).toBe(want.nodata);
    expect(header.levels.map((l) => [l.width, l.height]))
      .toEqual(want.levels.map((l) => [l.width, l.height]));
    expect([header.levels[0].tileWidth, header.levels[0].tileHeight]).toEqual(want.blockSize);

    const t = header.levels[0].transform;
    expect([t.originX, t.scaleX, 0, t.originY, 0, t.scaleY]).toEqual(want.geoTransform);
  });

  test("reads a projected fixture, and does not confuse metres for degrees", () => {
    const { header } = openWhole("cog-utm13-1m");
    const want = reference("cog-utm13-1m");

    expect(header.crs.epsg).toBe(26913);
    expect(header.crs.kind).toBe("utm");
    const t = header.levels[0].transform;
    expect([t.originX, t.scaleX, 0, t.originY, 0, t.scaleY]).toEqual(want.geoTransform);
    expect(t.originX).toBeGreaterThan(1000);
  });

  test("an overview is the same ground at a coarser step, with the same origin", () => {
    const { header } = openWhole("cog-lzw-p3");
    const full = header.levels[0];
    const half = header.levels[1];

    expect(half.transform.originX).toBe(full.transform.originX);
    expect(half.transform.originY).toBe(full.transform.originY);
    expect(half.transform.scaleX).toBeCloseTo(full.transform.scaleX * 2, 12);
    expect(cog.levelBounds(header, half)).toEqual(cog.levelBounds(header, full));
  });

  test("refuses something that is not a TIFF instead of reading noise as pixels", () => {
    const notTiff = cog.byteSource([{ start: 0, buffer: Buffer.from("<!DOCTYPE html><html>") }]);
    expect(() => cog.readHeader(notTiff)).toThrow(/not a TIFF/);
  });
});

describe("the real 3DEP headers USGS serves", () => {
  // The first 32 KB of two live tiles, saved with:
  //   curl -r 0-32767 -o tests/fixtures/usgs-13-n40w106-header.bin <url>
  // Two 1 m projects cover x47y443 and they are not converted alike, which is
  // why the tile shape, the predictor and the nodata sentinel are parameters
  // here rather than constants: a reader that hard-codes any of them reads the
  // other conversion as noise.
  const cases = [
    ["usgs-13-n40w106-header.bin", 4269, 10812, 6, 10.29, 512, 3, -999999],
    ["usgs-1m-x47y443-header.bin", 26913, 10012, 6, 1, 512, 3, -999999],
    ["usgs-1m-x47y443-2013-header.bin", 26913, 10012, 6, 1, 256, 1, -3.4028234e38]
  ];

  test.each(cases)(
    "%s parses from the front of the file alone",
    (file, epsg, width, levels, resolutionM, tileWidth, predictor, nodata) => {
      const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture(file) }]));

      expect(header.crs.epsg).toBe(epsg);
      expect(header.levels).toHaveLength(levels);
      expect(header.levels[0].width).toBe(width);
      expect(header.levels[0].tileWidth).toBe(tileWidth);
      expect(header.levels[0].compression).toBe(cog.COMPRESSION.LZW);
      expect(header.levels[0].predictor).toBe(predictor);
      expect(header.nodata).toBe(nodata);
      expect(cog.levelResolutionM(header, header.levels[0])).toBeCloseTo(resolutionM, 2);
    }
  );

  test("the same ground in two projects is two different files, not one shape", () => {
    const cogLayout = cog.readHeader(
      cog.byteSource([{ start: 0, buffer: fixture("usgs-1m-x47y443-header.bin") }])
    );
    const older = cog.readHeader(
      cog.byteSource([{ start: 0, buffer: fixture("usgs-1m-x47y443-2013-header.bin") }])
    );

    expect(older.levels[0].width).toBe(cogLayout.levels[0].width);
    expect(older.levels[0].tileWidth).not.toBe(cogLayout.levels[0].tileWidth);
    expect(older.levels[0].predictor).not.toBe(cogLayout.levels[0].predictor);
    expect(older.nodata).not.toBe(cogLayout.nodata);
  });

  test("the tile index is complete, so no part of the tile is unreachable", () => {
    const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture("usgs-13-n40w106-header.bin") }]));
    const full = header.levels[0];
    expect(full.offsets).toHaveLength(full.tilesAcross * full.tilesDown);
    expect(full.byteCounts).toHaveLength(full.tilesAcross * full.tilesDown);
    // Every tile of a 10812-pixel square at 512 to a side.
    expect(full.tilesAcross).toBe(22);
    expect(full.offsets.every((o) => o > 0)).toBe(true);
  });

  test("the coarsest overview is a thumbnail of a 1-degree tile, ~330 m to the pixel", () => {
    const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture("usgs-13-n40w106-header.bin") }]));
    const coarsest = header.levels[header.levels.length - 1];
    expect(coarsest.width).toBe(337);
    expect(cog.levelResolutionM(header, coarsest)).toBeCloseTo(330, 0);
  });
});

describe("decoding, against GDAL", () => {
  test.each([["cog-lzw-p3"], ["cog-utm13-1m"], ["cog-nodata-hole"]])(
    "%s decodes bit for bit, at every level",
    (name) => {
      const { header, buffer } = openWhole(name);
      const want = reference(name);

      for (let i = 0; i < want.levels.length; i++) {
        const grid = readLevel(header, buffer, i);
        expect([grid.width, grid.height]).toEqual([want.levels[i].width, want.levels[i].height]);
        for (let p = 0; p < grid.values.length; p++) {
          const got = grid.values[p];
          const expected = want.levels[i].values[p];
          if (expected === want.nodata) expect(got).toBeNaN();
          else expect(got).toBe(expected);
        }
      }
    }
  );

  test("Deflate and LZW copies of the same ground decode to the same elevations", () => {
    const lzw = openWhole("cog-lzw-p3");
    const deflate = openWhole("cog-deflate");
    expect(lzw.header.levels[0].compression).toBe(cog.COMPRESSION.LZW);
    expect(deflate.header.levels[0].compression).toBe(cog.COMPRESSION.DEFLATE_ADOBE);
    expect(Array.from(readLevel(deflate.header, deflate.buffer, 0).values))
      .toEqual(Array.from(readLevel(lzw.header, lzw.buffer, 0).values));
  });

  test("nodata comes back as NaN, never as zero, and is counted", () => {
    const { header, buffer } = openWhole("cog-nodata-hole");
    const grid = readLevel(header, buffer, 0);
    // The hole is 60 x 40 pixels, punched into ground that is 2,300 m up.
    expect(grid.noDataCount).toBe(2400);
    expect(grid.values.filter((v) => v === 0)).toHaveLength(0);
    expect(grid.values[30 * grid.width + 50]).toBeNaN();
    expect(grid.values[0]).toBeGreaterThan(2000);
  });

  test("a sentinel written to too few digits is still recognised as a hole", () => {
    // What the 2013 3DEP conversions carry: GDAL_NODATA is the decimal text
    // "-3.4028234e+38", and the pixel it stands for is the float32 below it.
    // Compared as written, every hole in those files reads as ground 3.4e38 m
    // deep. tests/fixtures/usgs-1m-x47y443-2013-header.bin is a real one.
    const asWritten = Number("-3.4028234e+38");
    const asStored = Math.fround(asWritten);
    expect(asStored).not.toBe(asWritten);

    const level = {
      tileWidth: 2, tileHeight: 1, samplesPerPixel: 1, bitsPerSample: 32,
      compression: 1, predictor: 1
    };
    const bytes = Buffer.alloc(8);
    bytes.writeFloatLE(asStored, 0);
    bytes.writeFloatLE(2189.5, 4);

    const tile = cog.decodeTile(bytes, level, { littleEndian: true, nodata: asWritten });
    expect(tile[0]).toBeNaN();
    expect(tile[1]).toBeCloseTo(2189.5, 3);
  });

  test("refuses a compression it has no fixture for, rather than approximating it", () => {
    const { header, buffer } = openWhole("cog-lzw-p3");
    const level = Object.assign({}, header.levels[0], { compression: 34712 });
    expect(() => cog.decodeTile(buffer.subarray(0, 100), level, header)).toThrow(/JPEG 2000/);
  });

  test("refuses a predictor it does not know", () => {
    const { header, buffer } = openWhole("cog-lzw-p3");
    const level = Object.assign({}, header.levels[0], { predictor: 7 });
    expect(() => cog.decodeTile(buffer.subarray(0, 100), level, header)).toThrow(/predictor 7/);
  });
});

describe("lzwDecode", () => {
  test("decodes the worked example from the TIFF 6.0 specification", () => {
    // 256 zero bytes: CLEAR, 0, then the run built out of the table, EOI.
    const encoded = Buffer.from([0x80, 0x00, 0x20, 0x50, 0x38, 0x24, 0x16, 0x0d, 0x07, 0x84, 0x40]);
    const out = cog.lzwDecode(encoded);
    expect(out.length).toBeGreaterThan(0);
    expect(Array.from(out).every((b) => b === 0)).toBe(true);
  });

  test("a stream that begins with an undefined code is refused, not guessed at", () => {
    // 9 bits of 0x120 = code 288, which nothing has defined yet.
    expect(() => cog.lzwDecode(Buffer.from([0x90, 0x00]))).toThrow(/before it has been defined/);
  });
});

describe("choosing a level", () => {
  test("takes the coarsest level that still meets the resolution asked for", () => {
    const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture("usgs-1m-x47y443-header.bin") }]));
    // 1, 2, 4, 8, 16, 32 m to the pixel.
    expect(cog.chooseLevel(header, 1).index).toBe(0);
    expect(cog.chooseLevel(header, 10).index).toBe(3);
    expect(cog.chooseLevel(header, 1000).index).toBe(5);
  });

  test("falls back to full resolution when nothing is coarse enough to be asked for", () => {
    const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture("usgs-1m-x47y443-header.bin") }]));
    expect(cog.chooseLevel(header, 0.5).index).toBe(0);
    expect(cog.chooseLevel(header, undefined).index).toBe(0);
  });

  test("a 16-mile domain off the coarsest overview is a few hundred pixels, not a hundred million", () => {
    const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture("usgs-1m-x47y443-header.bin") }]));
    const bounds = cog.levelBounds(header, header.levels[0]);
    const box = {
      west: bounds.west + 0.01, east: bounds.west + 0.05,
      south: bounds.south + 0.01, north: bounds.south + 0.05
    };
    const coarse = cog.pixelWindow(header, cog.chooseLevel(header, 30), box);
    const fine = cog.pixelWindow(header, header.levels[0], box);
    expect((coarse.x1 - coarse.x0) * (coarse.y1 - coarse.y0)).toBeLessThan(100000);
    expect((fine.x1 - fine.x0) * (fine.y1 - fine.y0)).toBeGreaterThan(10000000);
  });
});

describe("pixelWindow", () => {
  const { header } = openWhole("cog-lzw-p3");
  const level = header.levels[0];
  const bounds = cog.levelBounds(header, level);

  test("covers the box asked for, with a pixel of margin for interpolation", () => {
    const box = {
      west: bounds.west + 0.002, east: bounds.west + 0.004,
      south: bounds.south + 0.002, north: bounds.south + 0.004
    };
    const window = cog.pixelWindow(header, level, box);
    const nw = proj.fromGeographic(header.crs, box.north, box.west);
    const se = proj.fromGeographic(header.crs, box.south, box.east);
    const a = cog.pixelOf(level, nw.x, nw.y);
    const b = cog.pixelOf(level, se.x, se.y);

    expect(window.x0).toBeLessThan(a.px);
    expect(window.x1).toBeGreaterThan(b.px);
    expect(window.y0).toBeLessThan(a.py);
    expect(window.y1).toBeGreaterThan(b.py);
  });

  test("clips to the tile and says which edges it clipped", () => {
    const window = cog.pixelWindow(header, level, {
      west: bounds.west - 1, east: bounds.west + 0.001,
      south: bounds.south - 1, north: bounds.north
    });
    expect(window.x0).toBe(0);
    expect(window.y0).toBe(0);
    expect(window.clippedWest).toBe(true);
    expect(window.clippedSouth).toBe(true);
    expect(window.clippedEast).toBe(false);
  });

  test("refuses a box that misses the tile, rather than returning an empty grid", () => {
    expect(() => cog.pixelWindow(header, level, {
      west: bounds.west + 10, east: bounds.west + 11,
      south: bounds.south, north: bounds.north
    })).toThrow(/does not overlap/);
  });

  test("on a projected raster it uses all four corners, because the box is not a rectangle there", () => {
    // A lat/long box maps to a quadrilateral in UTM: taking two corners and
    // assuming a rectangle clips a wedge off two sides of the domain.
    const utm = openWhole("cog-utm13-1m").header;
    const utmLevel = utm.levels[0];
    const b = cog.levelBounds(utm, utmLevel);
    // Inset, so the window is decided by the box rather than by the tile edge.
    const box = {
      west: b.west + 0.0002, east: b.east - 0.0002,
      south: b.south + 0.0001, north: b.north - 0.0001
    };
    const window = cog.pixelWindow(utm, utmLevel, box, 0);
    // Every corner of the box is inside the window, which is the property that
    // a two-corner implementation loses.
    for (const [lat, lon] of [[box.south, box.west], [box.south, box.east], [box.north, box.west], [box.north, box.east]]) {
      const m = proj.fromGeographic(utm.crs, lat, lon);
      const p = cog.pixelOf(utmLevel, m.x, m.y);
      expect(p.px).toBeGreaterThanOrEqual(window.x0 - 1);
      expect(p.px).toBeLessThanOrEqual(window.x1);
      expect(p.py).toBeGreaterThanOrEqual(window.y0 - 1);
      expect(p.py).toBeLessThanOrEqual(window.y1);
    }
  });
});

describe("tilesForWindow and mergeRanges", () => {
  const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: fixture("usgs-13-n40w106-header.bin") }]));
  const level = header.levels[0];

  test("a small window touches one tile out of 484", () => {
    const tiles = cog.tilesForWindow(level, { x0: 100, y0: 100, x1: 200, y1: 200 });
    expect(tiles).toHaveLength(1);
    expect(level.tilesAcross * level.tilesDown).toBe(484);
  });

  test("a window on a tile boundary touches the four tiles it straddles", () => {
    const tiles = cog.tilesForWindow(level, { x0: 510, y0: 510, x1: 515, y1: 515 });
    expect(tiles.map((t) => t.tx + "," + t.ty).sort()).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });

  test("tiles in the same row merge into one request, and the gap is bounded", () => {
    const window = { x0: 0, y0: 0, x1: 2048, y1: 512 };
    const tiles = cog.tilesForWindow(level, window);
    expect(tiles).toHaveLength(4);
    expect(cog.mergeRanges(tiles, 1 << 20)).toHaveLength(1);
    // With no tolerance for a gap, consecutive tiles still merge only when the
    // file really does store them back to back.
    expect(cog.mergeRanges(tiles, 0).length).toBeGreaterThanOrEqual(1);
  });

  test("a merged range never straddles a bigger gap than it was allowed", () => {
    const tiles = [
      { tx: 0, ty: 0, offset: 1000, byteCount: 100, empty: false },
      { tx: 1, ty: 0, offset: 1100, byteCount: 100, empty: false },
      { tx: 2, ty: 0, offset: 9000, byteCount: 100, empty: false }
    ];
    const ranges = cog.mergeRanges(tiles, 1024);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ start: 1000, end: 1200 });
    expect(ranges[1]).toMatchObject({ start: 9000, end: 9100 });
  });

  test("an empty tile is not requested at all", () => {
    const tiles = [
      { tx: 0, ty: 0, offset: 0, byteCount: 0, empty: true },
      { tx: 1, ty: 0, offset: 500, byteCount: 100, empty: false }
    ];
    expect(cog.mergeRanges(tiles)).toHaveLength(1);
  });
});

describe("byteSource", () => {
  test("says which bytes it is missing rather than guessing at them", () => {
    const source = cog.byteSource([{ start: 0, buffer: Buffer.alloc(16) }]);
    try {
      source.read(100, 4);
      throw new Error("should have refused");
    } catch (err) {
      expect(err.code).toBe("need-bytes");
      expect(err.missing).toEqual({ start: 100, length: 4 });
    }
  });

  test("serves a read out of any chunk that wholly contains it", () => {
    const source = cog.byteSource([{ start: 100, buffer: Buffer.from([1, 2, 3, 4]) }]);
    expect(Array.from(source.read(101, 2))).toEqual([2, 3]);
    expect(() => source.read(102, 4)).toThrow(/have not been read yet/);
  });
});

describe("sampleElevation", () => {
  const { header, buffer } = openWhole("cog-lzw-p3");
  const grid = readLevel(header, buffer, 0);

  test("the centre of a pixel returns that pixel's own elevation", () => {
    const centre = cog.pixelCentre(header.levels[0], 10, 7);
    const got = cog.sampleElevation(grid, centre.y, centre.x);
    expect(got).toBeCloseTo(grid.values[7 * grid.width + 10], 4);
  });

  test("a point between two pixels lands between their elevations", () => {
    const a = cog.pixelCentre(header.levels[0], 10, 7);
    const b = cog.pixelCentre(header.levels[0], 11, 7);
    const got = cog.sampleElevation(grid, a.y, (a.x + b.x) / 2);
    const lo = Math.min(grid.values[7 * grid.width + 10], grid.values[7 * grid.width + 11]);
    const hi = Math.max(grid.values[7 * grid.width + 10], grid.values[7 * grid.width + 11]);
    expect(got).toBeGreaterThanOrEqual(lo);
    expect(got).toBeLessThanOrEqual(hi);
  });

  test("outside the grid is null, not the nearest edge", () => {
    expect(cog.sampleElevation(grid, grid.bounds.north + 1, grid.bounds.west)).toBeNull();
  });

  test("beside a hole it is null, because interpolating across one invents ground", () => {
    const holed = openWhole("cog-nodata-hole");
    const holedGrid = readLevel(holed.header, holed.buffer, 0);
    // The hole spans columns 40-99 and rows 20-59, so a point halfway between
    // column 39 and column 40 has a nodata neighbour.
    const edge = cog.pixelCentre(holed.header.levels[0], 39.5, 30);
    expect(cog.sampleElevation(holedGrid, edge.y, edge.x)).toBeNull();
    const away = cog.pixelCentre(holed.header.levels[0], 5, 5);
    expect(cog.sampleElevation(holedGrid, away.y, away.x)).toBeGreaterThan(2000);
  });

  test("a projected grid is sampled through the projection, not by treating metres as degrees", () => {
    const utm = openWhole("cog-utm13-1m");
    const utmGrid = readLevel(utm.header, utm.buffer, 0);
    const centre = cog.pixelCentre(utm.header.levels[0], 64, 48);
    const geo = proj.toGeographic(utm.header.crs, centre.x, centre.y);
    expect(cog.sampleElevation(utmGrid, geo.lat, geo.lon))
      .toBeCloseTo(utmGrid.values[48 * utmGrid.width + 64], 3);
  });
});
