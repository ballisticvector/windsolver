/**
 * Graded by GDAL reading back a PNG this repository wrote.
 *
 * A PNG writer checked with its own decoder is the same mistake as a GRIB
 * decoder checked against its own arithmetic: it passes while producing a file
 * that only it accepts. `tests/fixtures/hillshade-sample.png` was written by
 * `png.greyscalePng`, and `hillshade-sample.png.gdal.f32` is `gdal.Open`'s
 * reading of it — a different implementation of inflate, of the unfiltering,
 * and of `tRNS`. Comparing the two grades the CRCs, the chunk order, the
 * adaptive filter choice per row, the deflate stream and the transparency in
 * one number. Both are remade by `tools/make-hillshade-fixtures.sh`.
 *
 * The rest of the suite is the container: chunks in the order the specification
 * requires, a CRC that catches a corrupted byte, and refusals for the two
 * mistakes that would otherwise produce a file that decodes into a diagonal
 * smear.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const cog = require("../cog.js");
const hillshade = require("../hillshade.js");
const png = require("../png.js");

const FIXTURES = path.join(__dirname, "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

/** GDAL's reading of a raster: metadata, and the full-resolution pixels. */
function reference(name) {
  const meta = JSON.parse(fixture(name + ".gdal.json").toString("utf8"));
  const raw = fixture(name + ".gdal.f32");
  const n = meta.levels[0].width * meta.levels[0].height;
  meta.values = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 4));
  return meta;
}

/** The same raster the fixture was written from, rebuilt from the committed COG. */
function sampleRaster() {
  const buffer = fixture("cog-nodata-hole.tif");
  const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: buffer }]));
  const level = header.levels[0];
  const window = { x0: 0, y0: 0, x1: level.width, y1: level.height };
  const decoded = new Map();
  cog.tilesForWindow(level, window).forEach(function (tile) {
    if (tile.empty) return;
    decoded.set(
      tile.tx + "," + tile.ty,
      cog.decodeTile(buffer.subarray(tile.offset, tile.offset + tile.byteCount), level, header)
    );
  });
  const grid = cog.assembleWindow(header, level, window, decoded);
  return hillshade.toGeographic(hillshade.shade(grid), cog.gridBounds(grid), { width: 256 });
}

describe("a PNG GDAL can read", function () {
  const raster = sampleRaster();
  const bytes = hillshade.toBytes(raster);
  const gdal = reference("hillshade-sample.png");

  test("the committed fixture is still what this writer produces", function () {
    // If this fails the writer changed; regenerate the fixture and read the
    // diff in GDAL's reading of it, not in the compressed bytes.
    expect(png.greyscalePng(bytes, raster.width, raster.height).equals(fixture("hillshade-sample.png")))
      .toBe(true);
  });

  test("every pixel GDAL reads back is the pixel that went in", function () {
    expect([gdal.levels[0].width, gdal.levels[0].height]).toEqual([raster.width, raster.height]);
    expect(gdal.dataType).toBe("Byte");
    let worst = 0;
    for (let i = 0; i < bytes.length; i++) worst = Math.max(worst, Math.abs(gdal.values[i] - bytes[i]));
    expect(worst).toBe(0);
  });

  test("tRNS makes grey 0 nodata to a reader that has never heard of this service", function () {
    // The whole reason the hillshade gives up one byte of range. GDAL reports
    // the transparent grey as the band's nodata value, which is how the
    // browser will treat it too.
    expect(gdal.nodata).toBe(0);
    let holes = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) holes++;
    expect(holes).toBeGreaterThan(0);
  });

  test("the chunks are the ones the specification requires, in order", function () {
    const chunks = png.chunksOf(fixture("hillshade-sample.png"));
    expect(chunks.map(function (c) { return c.type; })).toEqual(["IHDR", "tRNS", "IDAT", "IEND"]);
    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(raster.width);
    expect(ihdr.readUInt32BE(4)).toBe(raster.height);
    expect([ihdr[8], ihdr[9], ihdr[12]]).toEqual([8, 0, 0]);
  });

  test("more than one filter is used, which is what makes it worth choosing one", function () {
    const chunks = png.chunksOf(fixture("hillshade-sample.png"));
    const idat = chunks.find(function (c) { return c.type === "IDAT"; });
    const raw = zlib.inflateSync(idat.data);
    const used = new Set();
    for (let y = 0; y < raster.height; y++) used.add(raw[y * (raster.width + 1)]);
    expect(used.size).toBeGreaterThan(1);
    for (const type of used) expect(type).toBeLessThanOrEqual(4);
  });

  test("a flipped bit is caught by the CRC rather than decoded", function () {
    const corrupt = Buffer.from(fixture("hillshade-sample.png"));
    corrupt[40] = corrupt[40] ^ 0x01;
    expect(function () { png.chunksOf(corrupt); }).toThrow(/CRC/);
    expect(function () { png.chunksOf(Buffer.alloc(64)); }).toThrow(/signature/);
  });
});

describe("refusals", function () {
  test("a size that does not match the pixels is refused, not padded", function () {
    // The failure this prevents is the classic one: a raster written with its
    // width and height the wrong way round decodes into a diagonal smear that
    // still looks like an image.
    expect(function () { png.greyscalePng(new Uint8Array(12), 4, 4); }).toThrow(/bytes/);
    expect(function () { png.greyscalePng(new Uint8Array(12), 4, 3.5); }).toThrow(/whole numbers/);
    expect(function () { png.greyscalePng(new Uint8Array(0), 0, 0); }).toThrow(/whole numbers/);
  });

  test("a transparent grey that is not a byte is refused", function () {
    const bytes = new Uint8Array(4);
    expect(function () { png.greyscalePng(bytes, 2, 2, { transparentGrey: 300 }); }).toThrow(/transparentGrey/);
    expect(function () { png.greyscalePng(bytes, 2, 2, { transparentGrey: 0.5 }); }).toThrow(/transparentGrey/);
  });

  test("an opaque image simply has no tRNS", function () {
    const buf = png.greyscalePng(new Uint8Array([1, 2, 3, 4]), 2, 2, { transparentGrey: null });
    expect(png.chunksOf(buf).map(function (c) { return c.type; })).toEqual(["IHDR", "IDAT", "IEND"]);
  });
});

describe("the filters themselves", function () {
  // The heuristic picks None, Sub and Paeth on the hillshade, so GDAL's reading
  // of that one file grades three of the five. These are the same 32x24 image
  // written five times with the choice forced, and read back by GDAL each time.
  const width = 32;
  const height = 24;
  const bytes = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bytes[y * width + x] = 1 + ((x * 7 + y * 13 + ((x * y) % 11)) % 254);
    }
  }

  for (let filter = 0; filter <= 4; filter++) {
    test("filter " + filter + " survives a round trip through GDAL", function () {
      const name = "png-filter-" + filter + ".png";
      expect(png.greyscalePng(bytes, width, height, { filter: filter }).equals(fixture(name))).toBe(true);

      const chunks = png.chunksOf(fixture(name));
      const raw = zlib.inflateSync(chunks.find(function (c) { return c.type === "IDAT"; }).data);
      for (let y = 0; y < height; y++) expect(raw[y * (width + 1)]).toBe(filter);

      const gdal = reference(name);
      for (let i = 0; i < bytes.length; i++) expect(gdal.values[i]).toBe(bytes[i]);
    });
  }

  test("a filter type that does not exist is refused", function () {
    expect(function () { png.greyscalePng(bytes, width, height, { filter: 5 }); }).toThrow(/filter/);
    expect(function () { png.greyscalePng(bytes, width, height, { filter: "paeth" }); }).toThrow(/filter/);
  });

  test("Paeth picks the neighbour the prediction is nearest", function () {
    // Four lines of arithmetic with three ways to get the tie-breaking wrong,
    // and a wrong one still round-trips through this repository's own reader.
    // Each case names the branch it takes.
    expect(png.paeth(10, 20, 20)).toBe(10);   // left
    expect(png.paeth(10, 20, 10)).toBe(20);   // above
    expect(png.paeth(10, 20, 15)).toBe(15);   // above-left
    expect(png.paeth(0, 10, 20)).toBe(0);     // left, on a negative prediction
    expect(png.paeth(10, 10, 10)).toBe(10);   // all equal: left wins the tie
  });

  test("the CRC is the one the specification names", function () {
    // "IEND" as bytes, whose CRC-32 is a constant every PNG in the world ends
    // with.
    expect(png.crc32(Buffer.from("IEND", "ascii"))).toBe(0xae426082);
  });
});
