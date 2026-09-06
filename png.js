/**
 * An 8-bit greyscale PNG, written by hand.
 *
 * The service has one image to send — a hillshade — and one reason not to
 * reach for a library to send it: this repository has no runtime dependencies,
 * and adding the first one to draw a picture would put an npm supply chain
 * between windsolver.com and a raster it can produce in a hundred lines. PNG's
 * container is four chunks and a CRC, and the compression is `zlib`, which is
 * in Node.
 *
 * **Grey 0 means "no ground here", and that is written into the file rather
 * than agreed by convention.** A `tRNS` chunk declares grey 0 fully
 * transparent, so a void in the terrain is a hole in the image to any reader,
 * including the browser, and nothing downstream has to know a rule. It is the
 * same choice `gdaldem` makes — its hillshade reserves 0 for nodata and maps a
 * lit pixel onto 1..255 — and the reason `hillshade.toBytes` gives up one byte
 * of range instead of putting a fully shadowed pixel at 0. A black pixel and an
 * absent one must not be the same pixel.
 *
 * Greyscale rather than grey-plus-alpha because it halves the bytes on the
 * wire for the same picture: the alpha channel of a hillshade is one bit of
 * information per pixel, and `tRNS` says it once for the whole file.
 *
 * Graded by having GDAL read the output back — `tests/png.test.js` compares
 * every pixel of a committed PNG this writer produced against
 * `gdal_translate`'s reading of it. A PNG checked only by decoding it with the
 * same code that wrote it passes while being a file no other reader accepts.
 */

"use strict";

const zlib = require("zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GREYSCALE = 0;

/** The five filters PNG defines, tried per row and chosen by the standard heuristic. */
const FILTER = { NONE: 0, SUB: 1, UP: 2, AVERAGE: 3, PAETH: 4 };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.allocUnsafe(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}

/** Paeth's predictor: whichever of left, above and above-left the gradient is nearest. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * One scanline under one filter, into `out`.
 *
 * `bpp` is one here — 8-bit greyscale — and is a parameter so the arithmetic is
 * the specification's rather than a simplification that quietly bakes the only
 * case in use into the only case that works.
 */
function filterRow(type, row, prev, out, bpp) {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = (prev && i >= bpp) ? prev[i - bpp] : 0;
    let v;
    switch (type) {
      case FILTER.NONE: v = row[i]; break;
      case FILTER.SUB: v = row[i] - a; break;
      case FILTER.UP: v = row[i] - b; break;
      case FILTER.AVERAGE: v = row[i] - ((a + b) >> 1); break;
      default: v = row[i] - paeth(a, b, c); break;
    }
    out[i] = v & 0xff;
  }
}

/** The sum of absolute signed differences, which is how a PNG encoder picks a filter. */
function cost(out) {
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] < 128 ? out[i] : 256 - out[i];
  return sum;
}

/**
 * Every scanline filtered and concatenated, ready for `deflate`.
 *
 * The filter is chosen per row, which is what PNG is for: a hillshade is a
 * smooth field, and the differences between neighbouring pixels are small
 * numbers that deflate well, while the pixels themselves are not.
 */
function filterImage(bytes, width, height, bpp, forced) {
  const stride = width * bpp;
  const out = Buffer.allocUnsafe((stride + 1) * height);
  const candidate = Buffer.allocUnsafe(stride);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const row = bytes.subarray(y * stride, (y + 1) * stride);
    let best = FILTER.NONE;
    let bestCost = Infinity;
    if (forced !== null) {
      best = forced;
    } else {
      for (const type of [FILTER.NONE, FILTER.SUB, FILTER.UP, FILTER.AVERAGE, FILTER.PAETH]) {
        filterRow(type, row, prev, candidate, bpp);
        const c = cost(candidate);
        if (c < bestCost) {
          bestCost = c;
          best = type;
        }
      }
    }
    out[y * (stride + 1)] = best;
    filterRow(best, row, prev, out.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), bpp);
    prev = row;
  }
  return out;
}

/**
 * An 8-bit greyscale PNG of `bytes`, row-major, north row first.
 *
 * `transparentGrey` is written as a `tRNS` chunk; pass `null` for an opaque
 * image. It is 0 by default because that is what the hillshade means by it.
 *
 * `filter` forces one filter on every row instead of choosing per row. Real
 * images do not want it — the choice is most of what makes a PNG small — but a
 * suite does: the adaptive heuristic picks three of the five filters on a
 * hillshade, so the other two would ship ungraded by any reader but this one.
 */
function greyscalePng(bytes, width, height, opts) {
  const o = opts || {};
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
    throw fail("bad-size", "width and height have to be positive whole numbers");
  }
  if (bytes.length !== width * height) {
    throw fail("bad-length", "expected " + (width * height) + " bytes, got " + bytes.length);
  }
  const transparent = o.transparentGrey === undefined ? 0 : o.transparentGrey;
  if (transparent !== null && !(Number.isInteger(transparent) && transparent >= 0 && transparent <= 255)) {
    throw fail("bad-transparent", "transparentGrey has to be a byte, or null for an opaque image");
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = GREYSCALE;    // colour type
  ihdr[10] = 0;           // deflate, the only compression PNG has
  ihdr[11] = 0;           // adaptive filtering, the only filter method
  ihdr[12] = 0;           // no interlacing: this is one image, fetched whole

  const parts = [SIGNATURE, chunk("IHDR", ihdr)];
  if (transparent !== null) {
    // tRNS for greyscale is a single 16-bit sample; an 8-bit image matches on
    // the low byte.
    const trns = Buffer.allocUnsafe(2);
    trns.writeUInt16BE(transparent, 0);
    parts.push(chunk("tRNS", trns));
  }

  const forced = o.filter === undefined || o.filter === null ? null : o.filter;
  if (forced !== null && !(Number.isInteger(forced) && forced >= 0 && forced <= 4)) {
    throw fail("bad-filter", "filter has to be one of the five PNG filter types, or null to choose per row");
  }
  const filtered = filterImage(bytes, width, height, 1, forced);
  const level = o.level === undefined ? 9 : o.level;
  parts.push(chunk("IDAT", zlib.deflateSync(filtered, { level: level })));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * The chunks of a PNG, in order, for a test to look at without a decoder.
 *
 * Only what is needed to assert the container is the shape the specification
 * says; the pixels are graded against GDAL rather than against this.
 */
function chunksOf(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw fail("not-png", "no PNG signature");
  const out = [];
  let at = 8;
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    const stated = buffer.readUInt32BE(at + 8 + length);
    const actual = crc32(buffer.subarray(at + 4, at + 8 + length));
    if (stated !== actual) throw fail("bad-crc", "chunk " + type + " does not match its CRC");
    out.push({ type: type, data: data });
    at += 12 + length;
  }
  return out;
}

module.exports = {
  SIGNATURE,
  FILTER,
  crc32,
  paeth,
  greyscalePng,
  chunksOf
};
