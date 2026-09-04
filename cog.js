/**
 * Reading a window out of a Cloud Optimized GeoTIFF, without the whole tile.
 *
 * This is the pure half: TIFF directory parsing, GeoTIFF georeferencing, which
 * overview to read, which internal tiles a window touches, what byte ranges
 * those are, and how to turn the compressed bytes back into elevations. It
 * makes no requests. `terrain.js` is the one module that does, for the same
 * reason `nomads.js` is separated from `hrrr.js`: none of the interesting bugs
 * are in the fetching, and all of this is testable offline against fixtures.
 *
 * Why it exists: a 1 m 3DEP tile is 400 MB and a 16 x 16 mile domain is twelve
 * of them — about 3 GB, measured, for one coordinate. The survey behind
 * `tools/cog-survey.js` found all 20 sampled tiles internally tiled at
 * 512 x 512 with five overview levels, so the same domain is a handful of
 * ranged reads instead. That is the difference between terrain being usable and
 * not, and it is why this module exists rather than a call to a download URL.
 *
 * **A reader must not assume the directory is at the front.** It was, on all 20
 * sampled tiles, but 3DEP is thousands of separately converted lidar projects
 * and a trailing directory is legal, still windowable, and costs one extra
 * range request. That is what the `need-bytes` protocol below is for: parsing
 * asks for bytes it has not been given rather than assuming a layout.
 */

"use strict";

const zlib = require("zlib");
const proj = require("./proj");

/** TIFF tags this reader uses. Anything else in the directory is ignored. */
const TAG = {
  NEW_SUBFILE_TYPE: 254,
  IMAGE_WIDTH: 256,
  IMAGE_LENGTH: 257,
  BITS_PER_SAMPLE: 258,
  COMPRESSION: 259,
  SAMPLES_PER_PIXEL: 277,
  PLANAR_CONFIG: 284,
  PREDICTOR: 317,
  TILE_WIDTH: 322,
  TILE_LENGTH: 323,
  TILE_OFFSETS: 324,
  TILE_BYTE_COUNTS: 325,
  SAMPLE_FORMAT: 339,
  MODEL_PIXEL_SCALE: 33550,
  MODEL_TIEPOINT: 33922,
  MODEL_TRANSFORMATION: 34264,
  GEO_KEY_DIRECTORY: 34735,
  GEO_DOUBLE_PARAMS: 34736,
  GEO_ASCII_PARAMS: 34737,
  GDAL_NODATA: 42113
};

const COMPRESSION = { NONE: 1, LZW: 5, DEFLATE_ADOBE: 8, DEFLATE_OLD: 32946 };
const COMPRESSION_NAMES = {
  1: "none", 5: "LZW", 6: "old-style JPEG", 7: "JPEG", 8: "Deflate",
  32946: "Deflate (old tag)", 34712: "JPEG 2000", 34887: "LERC",
  50000: "ZSTD", 50001: "WebP"
};

const SAMPLE_FORMAT = { UINT: 1, INT: 2, FLOAT: 3 };

/** Byte width of each TIFF field type, indexed by type code. 0 means unknown. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];

const GEO_KEY = {
  MODEL_TYPE: 1024,
  RASTER_TYPE: 1025,
  GEOGRAPHIC_TYPE: 2048,
  PROJECTED_CS_TYPE: 3072
};

const MODEL_TYPE = { PROJECTED: 1, GEOGRAPHIC: 2 };
const RASTER_TYPE = { PIXEL_IS_AREA: 1, PIXEL_IS_POINT: 2 };

/** How much of the front of a file is usually enough for a COG's directories. */
const DEFAULT_HEADER_BYTES = 65536;

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * A file we only partly hold.
 *
 * Every read states the byte range it wants; a range we do not have throws a
 * `need-bytes` error naming it, and the caller fetches it and tries again. That
 * inverts the usual arrangement, where the reader decides up front how much
 * header to pull and quietly breaks on the file that does not fit the guess.
 */
function byteSource(chunks) {
  const held = [];

  function add(start, buffer) {
    if (!isFinite(start) || start < 0) throw fail("bad-chunk", "a chunk needs a byte offset, got " + start);
    if (!Buffer.isBuffer(buffer)) throw fail("bad-chunk", "a chunk needs a Buffer");
    held.push({ start: start, end: start + buffer.length, buffer: buffer });
    held.sort(function (a, b) { return a.start - b.start; });
  }

  function read(start, length) {
    for (let i = 0; i < held.length; i++) {
      const c = held[i];
      if (start >= c.start && start + length <= c.end) {
        return c.buffer.subarray(start - c.start, start - c.start + length);
      }
    }
    throw fail(
      "need-bytes",
      "bytes " + start + "-" + (start + length - 1) + " of the file have not been read yet",
      { missing: { start: start, length: length } }
    );
  }

  (chunks || []).forEach(function (c) { add(c.start, c.buffer); });
  return { add: add, read: read, chunks: held };
}

function reader(source, littleEndian) {
  return {
    u8: function (o) { return source.read(o, 1)[0]; },
    u16: function (o) {
      const b = source.read(o, 2);
      return littleEndian ? b.readUInt16LE(0) : b.readUInt16BE(0);
    },
    u32: function (o) {
      const b = source.read(o, 4);
      return littleEndian ? b.readUInt32LE(0) : b.readUInt32BE(0);
    },
    u64: function (o) {
      const b = source.read(o, 8);
      return Number(littleEndian ? b.readBigUInt64LE(0) : b.readBigUInt64BE(0));
    },
    f64: function (o) {
      const b = source.read(o, 8);
      return littleEndian ? b.readDoubleLE(0) : b.readDoubleBE(0);
    },
    bytes: function (o, n) { return source.read(o, n); }
  };
}

function readTypedValues(r, type, count, offset, littleEndian) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = offset + i * TYPE_SIZE[type];
    switch (type) {
      case 1: case 7: out.push(r.u8(at)); break;                       // BYTE, UNDEFINED
      case 2: out.push(String.fromCharCode(r.u8(at))); break;          // ASCII
      case 3: out.push(r.u16(at)); break;                              // SHORT
      case 4: out.push(r.u32(at)); break;                              // LONG
      case 5: out.push(r.u32(at) / r.u32(at + 4)); break;              // RATIONAL
      case 6: out.push(r.bytes(at, 1).readInt8(0)); break;             // SBYTE
      case 8: {                                                        // SSHORT
        const b = r.bytes(at, 2);
        out.push(littleEndian ? b.readInt16LE(0) : b.readInt16BE(0));
        break;
      }
      case 9: {                                                        // SLONG
        const b = r.bytes(at, 4);
        out.push(littleEndian ? b.readInt32LE(0) : b.readInt32BE(0));
        break;
      }
      case 11: {                                                       // FLOAT
        const b = r.bytes(at, 4);
        out.push(littleEndian ? b.readFloatLE(0) : b.readFloatBE(0));
        break;
      }
      case 12: out.push(r.f64(at)); break;                             // DOUBLE
      case 16: out.push(r.u64(at)); break;                             // LONG8
      default:
        throw fail("tiff-type", "TIFF field type " + type + " is not one this reader handles");
    }
  }
  return type === 2 ? [out.join("").replace(/\0+$/, "")] : out;
}

/**
 * One image file directory: every tag, resolved to values.
 *
 * A tag whose values do not fit in the entry holds a file offset instead, which
 * may be anywhere. Reading through the byte source means an out-of-reach tag
 * surfaces as `need-bytes` rather than as a silently truncated tile index — the
 * failure that turns into a blank stripe down the middle of a domain.
 */
function readIfd(r, offset, littleEndian, bigTiff) {
  const entrySize = bigTiff ? 20 : 12;
  const count = bigTiff ? r.u64(offset) : r.u16(offset);
  if (count === 0 || count > 512) {
    throw fail("tiff-directory", "a directory at byte " + offset + " claims " + count + " entries, which is not a directory");
  }
  const base = offset + (bigTiff ? 8 : 2);
  const tags = {};

  for (let i = 0; i < count; i++) {
    const entry = base + i * entrySize;
    const id = r.u16(entry);
    const type = r.u16(entry + 2);
    const n = bigTiff ? r.u64(entry + 4) : r.u32(entry + 4);
    const size = TYPE_SIZE[type] || 0;
    if (!size) continue;

    const inlineBytes = bigTiff ? 8 : 4;
    const valueAt = entry + (bigTiff ? 12 : 8);
    const at = n * size <= inlineBytes ? valueAt : (bigTiff ? r.u64(valueAt) : r.u32(valueAt));
    tags[id] = { type: type, count: n, values: readTypedValues(r, type, n, at, littleEndian) };
  }

  const nextAt = base + count * entrySize;
  const next = bigTiff ? r.u64(nextAt) : r.u32(nextAt);
  return { offset: offset, tags: tags, next: next === 0 ? null : next };
}

function tagValues(ifd, id) {
  const t = ifd.tags[id];
  return t ? t.values : null;
}

function tagValue(ifd, id, fallback) {
  const v = tagValues(ifd, id);
  return v && v.length ? v[0] : fallback;
}

/**
 * GeoTIFF's key directory, flattened to `{ keyId: value }`.
 *
 * Keys whose value lives in the double or ASCII parameter arrays are resolved
 * here; the only ones this reader needs are plain shorts, but resolving all of
 * them keeps a caller from reading a location index as if it were a code.
 */
function readGeoKeys(ifd) {
  const dir = tagValues(ifd, TAG.GEO_KEY_DIRECTORY);
  if (!dir || dir.length < 4) return {};
  const doubles = tagValues(ifd, TAG.GEO_DOUBLE_PARAMS) || [];
  const ascii = (tagValues(ifd, TAG.GEO_ASCII_PARAMS) || [""])[0];
  const keys = {};

  for (let i = 4; i + 3 < dir.length; i += 4) {
    const id = dir[i];
    const location = dir[i + 1];
    const count = dir[i + 2];
    const offset = dir[i + 3];
    if (location === 0) keys[id] = offset;
    else if (location === TAG.GEO_DOUBLE_PARAMS) keys[id] = doubles[offset];
    else if (location === TAG.GEO_ASCII_PARAMS) keys[id] = ascii.substr(offset, count).replace(/\|$/, "");
  }
  return keys;
}

function crsOf(geoKeys) {
  const modelType = geoKeys[GEO_KEY.MODEL_TYPE];
  if (modelType === MODEL_TYPE.PROJECTED) return proj.crsFromEpsg(geoKeys[GEO_KEY.PROJECTED_CS_TYPE]);
  if (modelType === MODEL_TYPE.GEOGRAPHIC) return proj.crsFromEpsg(geoKeys[GEO_KEY.GEOGRAPHIC_TYPE]);
  throw fail(
    "crs-unknown",
    "the file does not say whether its coordinates are projected or geographic " +
    "(GTModelTypeGeoKey = " + modelType + "), so where it sits on the earth is a guess"
  );
}

/**
 * Origin and pixel size in model coordinates.
 *
 * `ModelTiepoint` + `ModelPixelScale` is what every 3DEP tile in the survey
 * used. `ModelTransformation` is the general form and is accepted when it has
 * no rotation; a rotated raster is refused rather than read as if it were
 * north-up, because a rotated read looks like terrain and is in the wrong place.
 */
function transformOf(ifd) {
  const scale = tagValues(ifd, TAG.MODEL_PIXEL_SCALE);
  const tie = tagValues(ifd, TAG.MODEL_TIEPOINT);
  if (scale && tie && tie.length >= 6) {
    return {
      originX: tie[3] - tie[0] * scale[0],
      originY: tie[4] + tie[1] * scale[1],
      scaleX: scale[0],
      scaleY: -scale[1]
    };
  }

  const m = tagValues(ifd, TAG.MODEL_TRANSFORMATION);
  if (m && m.length >= 16) {
    if (m[1] !== 0 || m[4] !== 0) {
      throw fail("raster-rotated", "this raster is rotated, and reading it as north-up would place every elevation wrongly");
    }
    return { originX: m[3], originY: m[7], scaleX: m[0], scaleY: m[5] };
  }

  throw fail("no-georeference", "the file carries no tiepoint or transformation, so its pixels cannot be placed on the earth");
}

function nodataOf(ifd) {
  const raw = tagValue(ifd, TAG.GDAL_NODATA, null);
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

/**
 * One resolution of the image: the full raster, or an overview.
 *
 * Overviews carry no georeferencing of their own — they are the same ground at
 * a coarser step, so their pixel size is the full-resolution one scaled by the
 * width ratio and their origin is shared. That is how GDAL derives it too; it
 * is arithmetic rather than something read out of the file, and it is the one
 * piece of georeferencing here that no fixture pins directly.
 */
function levelFrom(ifd, index, base) {
  const width = tagValue(ifd, TAG.IMAGE_WIDTH, null);
  const height = tagValue(ifd, TAG.IMAGE_LENGTH, null);
  const tileWidth = tagValue(ifd, TAG.TILE_WIDTH, null);
  const tileHeight = tagValue(ifd, TAG.TILE_LENGTH, null);

  if (!width || !height) throw fail("tiff-directory", "directory " + index + " has no image size");
  if (!tileWidth || !tileHeight) {
    throw fail(
      "not-tiled",
      "directory " + index + " is stripped, not internally tiled, so a square window cannot be read " +
      "without pulling most of the file. Fetch the whole tile deliberately, or pick another product"
    );
  }

  const scaleFactor = base ? base.width / width : 1;
  const transform = base
    ? {
      originX: base.transform.originX,
      originY: base.transform.originY,
      scaleX: base.transform.scaleX * scaleFactor,
      scaleY: base.transform.scaleY * (base.height / height)
    }
    : transformOf(ifd);

  return {
    index: index,
    width: width,
    height: height,
    tileWidth: tileWidth,
    tileHeight: tileHeight,
    tilesAcross: Math.ceil(width / tileWidth),
    tilesDown: Math.ceil(height / tileHeight),
    offsets: tagValues(ifd, TAG.TILE_OFFSETS) || [],
    byteCounts: tagValues(ifd, TAG.TILE_BYTE_COUNTS) || [],
    compression: tagValue(ifd, TAG.COMPRESSION, COMPRESSION.NONE),
    predictor: tagValue(ifd, TAG.PREDICTOR, 1),
    bitsPerSample: tagValue(ifd, TAG.BITS_PER_SAMPLE, 8),
    sampleFormat: tagValue(ifd, TAG.SAMPLE_FORMAT, SAMPLE_FORMAT.UINT),
    samplesPerPixel: tagValue(ifd, TAG.SAMPLES_PER_PIXEL, 1),
    planarConfig: tagValue(ifd, TAG.PLANAR_CONFIG, 1),
    transform: transform,
    overview: index > 0
  };
}

/**
 * Read the directories, and everything about the raster that does not need the
 * pixel data. Throws `need-bytes` until the source holds enough of the file.
 */
function readHeader(source) {
  const magic = source.read(0, 4);
  const littleEndian = magic.toString("ascii", 0, 2) === "II";
  if (!littleEndian && magic.toString("ascii", 0, 2) !== "MM") {
    throw fail("not-tiff", "this is not a TIFF: it starts " + JSON.stringify(magic.toString("latin1", 0, 4)));
  }
  const version = littleEndian ? magic.readUInt16LE(2) : magic.readUInt16BE(2);
  if (version !== 42 && version !== 43) {
    throw fail("not-tiff", "TIFF version " + version + " is neither classic (42) nor BigTIFF (43)");
  }
  const bigTiff = version === 43;
  const r = reader(source, littleEndian);
  const first = bigTiff ? r.u64(8) : r.u32(4);

  const ifds = [];
  let offset = first;
  while (offset !== null && ifds.length < 32) {
    const ifd = readIfd(r, offset, littleEndian, bigTiff);
    ifds.push(ifd);
    offset = ifd.next;
  }

  const geoKeys = readGeoKeys(ifds[0]);
  const levels = [];
  for (let i = 0; i < ifds.length; i++) {
    // A mask or a page is not a coarser copy of the image, and averaging one
    // into a terrain grid would be silent nonsense.
    const subfile = tagValue(ifds[i], TAG.NEW_SUBFILE_TYPE, 0);
    if (i > 0 && (subfile & 4) !== 0) continue;
    levels.push(levelFrom(ifds[i], levels.length, levels[0] || null));
  }

  const full = levels[0];
  if (full.samplesPerPixel !== 1) {
    throw fail("not-a-dem", "this raster has " + full.samplesPerPixel + " samples per pixel; a DEM has one");
  }
  if (full.bitsPerSample !== 32 || full.sampleFormat !== SAMPLE_FORMAT.FLOAT) {
    throw fail(
      "sample-format",
      "this reader handles 32-bit float elevations, which is what 3DEP ships; this file is " +
      full.bitsPerSample + "-bit sample format " + full.sampleFormat + ". Add a fixture, then widen it"
    );
  }

  return {
    littleEndian: littleEndian,
    bigTiff: bigTiff,
    ifds: ifds,
    geoKeys: geoKeys,
    rasterType: geoKeys[GEO_KEY.RASTER_TYPE] || RASTER_TYPE.PIXEL_IS_AREA,
    crs: crsOf(geoKeys),
    nodata: nodataOf(ifds[0]),
    levels: levels
  };
}

/** Model coordinates of the centre of a pixel. */
function pixelCentre(level, px, py) {
  return {
    x: level.transform.originX + (px + 0.5) * level.transform.scaleX,
    y: level.transform.originY + (py + 0.5) * level.transform.scaleY
  };
}

/** Fractional pixel coordinates of a model point, measured from pixel centres. */
function pixelOf(level, x, y) {
  return {
    px: (x - level.transform.originX) / level.transform.scaleX - 0.5,
    py: (y - level.transform.originY) / level.transform.scaleY - 0.5
  };
}

/** The geographic bounds of a whole level, corner to corner. */
function levelBounds(header, level) {
  const t = level.transform;
  const corners = [
    [t.originX, t.originY],
    [t.originX + level.width * t.scaleX, t.originY],
    [t.originX, t.originY + level.height * t.scaleY],
    [t.originX + level.width * t.scaleX, t.originY + level.height * t.scaleY]
  ].map(function (c) { return proj.toGeographic(header.crs, c[0], c[1]); });

  return {
    west: Math.min.apply(null, corners.map(function (c) { return c.lon; })),
    east: Math.max.apply(null, corners.map(function (c) { return c.lon; })),
    south: Math.min.apply(null, corners.map(function (c) { return c.lat; })),
    north: Math.max.apply(null, corners.map(function (c) { return c.lat; }))
  };
}

/** Ground sample distance of a level in metres, at its own centre latitude. */
function levelResolutionM(header, level) {
  const mid = levelBounds(header, level);
  const m = proj.pixelMetres(
    header.crs, level.transform.scaleX, level.transform.scaleY, (mid.south + mid.north) / 2
  );
  return Math.max(m.x, m.y);
}

/**
 * The coarsest level still finer than `targetResolutionM`, or the full raster
 * if none is.
 *
 * Coarsest-that-will-do rather than finest-available: a 60-mile map domain read
 * at 1 m is a hundred million pixels nobody looks at, and the overviews exist
 * precisely so that a wide view costs a wide view's worth of bytes. A solver
 * mesh is 10-20 m whatever the source is.
 */
function chooseLevel(header, targetResolutionM) {
  if (!isFinite(targetResolutionM) || targetResolutionM <= 0) return header.levels[0];
  let chosen = header.levels[0];
  for (let i = 0; i < header.levels.length; i++) {
    const res = levelResolutionM(header, header.levels[i]);
    if (res <= targetResolutionM && res > levelResolutionM(header, chosen)) chosen = header.levels[i];
  }
  return chosen;
}

/**
 * The pixel window of a level covering a lat/long box.
 *
 * The box is projected corner by corner — for a UTM raster the four corners of
 * a lat/long box are not a rectangle in the raster's own coordinates, and using
 * two of them clips a wedge off the domain. The window is the bounding box of
 * all four, grown by `padPixels` so that bilinear sampling at the edge has a
 * neighbour to interpolate towards.
 */
function pixelWindow(header, level, box, padPixels) {
  const pad = padPixels === undefined ? 1 : padPixels;
  const corners = [
    [box.south, box.west], [box.south, box.east], [box.north, box.west], [box.north, box.east]
  ].map(function (c) {
    const m = proj.fromGeographic(header.crs, c[0], c[1]);
    return pixelOf(level, m.x, m.y);
  });

  const xs = corners.map(function (c) { return c.px; });
  const ys = corners.map(function (c) { return c.py; });
  const x0 = Math.floor(Math.min.apply(null, xs)) - pad;
  const x1 = Math.ceil(Math.max.apply(null, xs)) + pad;
  const y0 = Math.floor(Math.min.apply(null, ys)) - pad;
  const y1 = Math.ceil(Math.max.apply(null, ys)) + pad;

  const clipped = {
    x0: Math.max(0, x0),
    y0: Math.max(0, y0),
    x1: Math.min(level.width, x1 + 1),
    y1: Math.min(level.height, y1 + 1)
  };

  if (clipped.x1 <= clipped.x0 || clipped.y1 <= clipped.y0) {
    throw fail(
      "outside-tile",
      "the requested box does not overlap this tile, so there is nothing to read; " +
      "discovery picked the wrong tile, or the box is in the wrong hemisphere"
    );
  }
  clipped.clippedWest = x0 < 0;
  clipped.clippedNorth = y0 < 0;
  clipped.clippedEast = x1 + 1 > level.width;
  clipped.clippedSouth = y1 + 1 > level.height;
  return clipped;
}

function tileIndex(level, tx, ty) {
  return ty * level.tilesAcross + tx;
}

/** Which internal tiles a pixel window touches, with their byte ranges. */
function tilesForWindow(level, window) {
  const tx0 = Math.floor(window.x0 / level.tileWidth);
  const tx1 = Math.floor((window.x1 - 1) / level.tileWidth);
  const ty0 = Math.floor(window.y0 / level.tileHeight);
  const ty1 = Math.floor((window.y1 - 1) / level.tileHeight);
  const out = [];

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const i = tileIndex(level, tx, ty);
      const offset = level.offsets[i];
      const byteCount = level.byteCounts[i];
      // A zero-length tile is how a sparse GeoTIFF says "nothing here"; it is
      // not an error, and it reads as nodata rather than as zero elevation.
      out.push({ tx: tx, ty: ty, index: i, offset: offset, byteCount: byteCount, empty: !byteCount });
    }
  }
  return out;
}

/**
 * Merge tile reads that are close together in the file.
 *
 * Tiles are stored in row-major order, so a window's tiles come in runs. One
 * request for a run with a small gap in it beats several requests plus their
 * round trips; `maxGapBytes` is what we are willing to over-read to save one.
 */
function mergeRanges(tiles, maxGapBytes) {
  const gap = maxGapBytes === undefined ? 16384 : maxGapBytes;
  const wanted = tiles.filter(function (t) { return !t.empty; })
    .slice()
    .sort(function (a, b) { return a.offset - b.offset; });

  const ranges = [];
  for (const tile of wanted) {
    const last = ranges[ranges.length - 1];
    if (last && tile.offset - last.end <= gap) {
      last.end = Math.max(last.end, tile.offset + tile.byteCount);
      last.tiles.push(tile);
    } else {
      ranges.push({ start: tile.offset, end: tile.offset + tile.byteCount, tiles: [tile] });
    }
  }
  return ranges;
}

/**
 * TIFF's LZW, which is not quite anyone else's.
 *
 * Codes are packed most-significant-bit first, and the code width grows one
 * code *early* — at 511 rather than 512 — which is the documented quirk that a
 * decoder written from the GIF version gets wrong. It does not fail; it
 * produces plausible bytes that drift after the first few hundred codes.
 */
function lzwDecode(input) {
  const CLEAR = 256;
  const EOI = 257;
  const MAX_CODE = 4096;

  // The dictionary is held as (prefix code, appended byte, length) rather than
  // as strings, so an entry costs three numbers however long it grows.
  const prefix = new Int16Array(MAX_CODE);
  const suffix = new Uint8Array(MAX_CODE);
  const length = new Uint16Array(MAX_CODE);

  let out = Buffer.allocUnsafe(Math.max(1024, input.length * 3));
  let written = 0;
  let nextCode = 258;
  let width = 9;
  let bitPos = 0;
  const totalBits = input.length * 8;

  function reset() {
    for (let i = 0; i < 256; i++) {
      prefix[i] = -1;
      suffix[i] = i;
      length[i] = 1;
    }
    nextCode = 258;
    width = 9;
  }

  function nextCodeIn() {
    if (bitPos + width > totalBits) return EOI;
    let code = 0;
    for (let i = 0; i < width; i++) {
      const bit = (input[(bitPos + i) >> 3] >> (7 - ((bitPos + i) & 7))) & 1;
      code = (code << 1) | bit;
    }
    bitPos += width;
    return code;
  }

  function emit(code) {
    const n = length[code];
    if (written + n > out.length) {
      const grown = Buffer.allocUnsafe(Math.max(out.length * 2, written + n));
      out.copy(grown, 0, 0, written);
      out = grown;
    }
    let at = written + n - 1;
    let c = code;
    while (c >= 0) {
      out[at--] = suffix[c];
      c = prefix[c];
    }
    written += n;
  }

  reset();
  let previous = -1;
  for (;;) {
    const code = nextCodeIn();
    if (code === EOI) break;
    if (code === CLEAR) {
      reset();
      previous = -1;
      continue;
    }

    if (code < nextCode && (code < 256 || length[code] > 0)) {
      emit(code);
      if (previous >= 0 && nextCode < MAX_CODE) {
        // The new entry is the previous string plus the first byte of this one,
        // and the first byte of a string is the deepest suffix in its chain.
        let first = code;
        while (prefix[first] >= 0) first = prefix[first];
        prefix[nextCode] = previous;
        suffix[nextCode] = suffix[first];
        length[nextCode] = length[previous] + 1;
        nextCode++;
      }
    } else if (previous >= 0 && nextCode < MAX_CODE) {
      let first = previous;
      while (prefix[first] >= 0) first = prefix[first];
      prefix[nextCode] = previous;
      suffix[nextCode] = suffix[first];
      length[nextCode] = length[previous] + 1;
      emit(nextCode);
      nextCode++;
    } else {
      throw fail("lzw", "the compressed stream uses code " + code + " before it has been defined");
    }

    previous = code;

    // Early change: widen one code before the table is actually full.
    if (nextCode === 511) width = 10;
    else if (nextCode === 1023) width = 11;
    else if (nextCode === 2047) width = 12;
  }

  return out.subarray(0, written);
}

/**
 * Undo the floating-point predictor (TIFF Technical Note 3).
 *
 * Two steps, per row: the bytes are horizontal differences, and once
 * accumulated they are still in byte-plane order — all the high bytes of the
 * row, then all the next ones, and so on. Skipping the de-shuffle produces
 * numbers, and they are not elevations.
 */
function unpredictFloat(buf, width, height, samples, bytesPerSample) {
  const rowBytes = width * samples * bytesPerSample;
  const stride = samples;
  const tmp = Buffer.allocUnsafe(rowBytes);

  for (let row = 0; row < height; row++) {
    const base = row * rowBytes;
    for (let i = stride; i < rowBytes; i++) {
      buf[base + i] = (buf[base + i] + buf[base + i - stride]) & 0xff;
    }
    buf.copy(tmp, 0, base, base + rowBytes);
    const wc = rowBytes / bytesPerSample;
    for (let count = 0; count < wc; count++) {
      for (let byte = 0; byte < bytesPerSample; byte++) {
        buf[base + bytesPerSample * count + bytesPerSample - byte - 1] = tmp[byte * wc + count];
      }
    }
  }
  return buf;
}

/**
 * Undo horizontal differencing (TIFF predictor 2).
 *
 * The differences are between whole samples, not between bytes, so anything
 * wider than a byte has to be accumulated as a number in the file's byte order
 * and written back the same way. Doing it byte-wise decodes an 8-bit file and
 * turns every wider one into noise.
 *
 * **The sample format does not enter into it.** libtiff accumulates a 32-bit
 * sample as an unsigned integer whatever the file says it means, so a float
 * raster written with this predictor — 3DEP has them, e.g. the
 * CO_SanLuisJuanMiguel_2020_D20 project — is wrapped at 2^32 rather than added
 * as floats.
 */
function unpredictHorizontal(buf, width, height, samples, bytesPerSample, littleEndian) {
  if ([1, 4].indexOf(bytesPerSample) === -1) {
    throw fail("predictor", "horizontal differencing on " + bytesPerSample * 8 + "-bit samples is not implemented");
  }
  const rowBytes = width * samples * bytesPerSample;

  if (bytesPerSample === 1) {
    for (let row = 0; row < height; row++) {
      const base = row * rowBytes;
      for (let i = samples; i < rowBytes; i++) buf[base + i] = (buf[base + i] + buf[base + i - samples]) & 0xff;
    }
    return buf;
  }

  const read = littleEndian ? buf.readUInt32LE.bind(buf) : buf.readUInt32BE.bind(buf);
  const write = littleEndian ? buf.writeUInt32LE.bind(buf) : buf.writeUInt32BE.bind(buf);
  const rowSamples = width * samples;

  for (let row = 0; row < height; row++) {
    const base = row * rowBytes;
    for (let i = samples; i < rowSamples; i++) {
      const at = base + i * bytesPerSample;
      const previous = at - samples * bytesPerSample;
      write((read(at) + read(previous)) % 0x100000000, at);
    }
  }
  return buf;
}

function decompress(bytes, level) {
  switch (level.compression) {
    case COMPRESSION.NONE: return Buffer.from(bytes);
    case COMPRESSION.LZW: return lzwDecode(bytes);
    case COMPRESSION.DEFLATE_ADOBE:
    case COMPRESSION.DEFLATE_OLD: return zlib.inflateSync(bytes);
    default:
      throw fail(
        "compression",
        "tile compression " + (COMPRESSION_NAMES[level.compression] || level.compression) +
        " is not implemented. Decoding it approximately is not an option for elevations; add a fixture first"
      );
  }
}

/**
 * One internal tile, as elevations in metres, with nodata as NaN.
 *
 * **NaN, never zero.** Zero is sea level and a real elevation; a nodata pixel
 * left as its sentinel (-999999 in 3DEP) or flattened to zero puts a cliff in
 * the terrain, and a cliff is a wind feature the ground does not have.
 */
function decodeTile(bytes, level, header) {
  if ([1, 2, 3].indexOf(level.predictor) === -1) {
    throw fail("predictor", "predictor " + level.predictor + " is not one this reader knows");
  }
  const raw = decompress(bytes, level);
  const bytesPerSample = level.bitsPerSample / 8;
  const expected = level.tileWidth * level.tileHeight * level.samplesPerPixel * bytesPerSample;
  if (raw.length < expected) {
    throw fail("tile-short", "a tile decompressed to " + raw.length + " bytes where a full tile is " + expected);
  }

  let plain = raw;
  if (level.predictor === 3) {
    plain = unpredictFloat(raw, level.tileWidth, level.tileHeight, level.samplesPerPixel, bytesPerSample);
  } else if (level.predictor === 2) {
    plain = unpredictHorizontal(
      raw, level.tileWidth, level.tileHeight, level.samplesPerPixel, bytesPerSample, header.littleEndian
    );
  }

  const count = level.tileWidth * level.tileHeight;
  const out = new Float32Array(count);
  // GDAL_NODATA is decimal text, and it is not always written to enough digits
  // to name the float32 it stands for: the 2013 3DEP conversions say
  // "-3.4028234e+38" for a pixel that is -3.4028234663852886e+38. Comparing the
  // text against the pixel misses every hole in those files, so the sentinel is
  // brought into float32 first, where the two are the same number.
  const nodata = header.nodata === null ? null : Math.fround(header.nodata);
  for (let i = 0; i < count; i++) {
    const v = header.littleEndian ? plain.readFloatLE(i * 4) : plain.readFloatBE(i * 4);
    out[i] = nodata !== null && v === nodata ? NaN : v;
  }
  return out;
}

/**
 * Paste decoded tiles into the window.
 *
 * `tileValues` maps "tx,ty" to a decoded tile; a tile that is missing from the
 * map, or was empty in the file, leaves NaN. Rows run north to south and
 * columns west to east, which is the raster's own order for a north-up file.
 */
function assembleWindow(header, level, window, tileValues) {
  const width = window.x1 - window.x0;
  const height = window.y1 - window.y0;
  const values = new Float32Array(width * height).fill(NaN);
  let missing = 0;

  for (let y = window.y0; y < window.y1; y++) {
    const ty = Math.floor(y / level.tileHeight);
    for (let x = window.x0; x < window.x1; x++) {
      const tx = Math.floor(x / level.tileWidth);
      const tile = tileValues.get(tx + "," + ty);
      const at = (y - window.y0) * width + (x - window.x0);
      if (!tile) {
        missing++;
        continue;
      }
      const v = tile[(y % level.tileHeight) * level.tileWidth + (x % level.tileWidth)];
      values[at] = v;
      if (Number.isNaN(v)) missing++;
    }
  }

  const originX = level.transform.originX + window.x0 * level.transform.scaleX;
  const originY = level.transform.originY + window.y0 * level.transform.scaleY;
  const grid = {
    crs: header.crs,
    level: level.index,
    // Where this window sits in its level, so a value can be traced back to the
    // pixel of the source tile it came from.
    x0: window.x0,
    y0: window.y0,
    width: width,
    height: height,
    values: values,
    noDataCount: missing,
    transform: {
      originX: originX,
      originY: originY,
      scaleX: level.transform.scaleX,
      scaleY: level.transform.scaleY
    },
    resolutionM: levelResolutionM(header, level),
    clipped: {
      west: Boolean(window.clippedWest),
      east: Boolean(window.clippedEast),
      south: Boolean(window.clippedSouth),
      north: Boolean(window.clippedNorth)
    }
  };
  grid.bounds = gridBounds(grid);
  return grid;
}

function gridBounds(grid) {
  const t = grid.transform;
  const corners = [
    [t.originX, t.originY],
    [t.originX + grid.width * t.scaleX, t.originY],
    [t.originX, t.originY + grid.height * t.scaleY],
    [t.originX + grid.width * t.scaleX, t.originY + grid.height * t.scaleY]
  ].map(function (c) { return proj.toGeographic(grid.crs, c[0], c[1]); });
  return {
    west: Math.min.apply(null, corners.map(function (c) { return c.lon; })),
    east: Math.max.apply(null, corners.map(function (c) { return c.lon; })),
    south: Math.min.apply(null, corners.map(function (c) { return c.lat; })),
    north: Math.max.apply(null, corners.map(function (c) { return c.lat; }))
  };
}

/**
 * Bilinear elevation at a coordinate, in metres.
 *
 * Returns null outside the grid and null next to a nodata pixel: interpolating
 * across a hole invents ground, and invented ground is indistinguishable from
 * surveyed ground by the time it reaches a wind field. Same rule as the
 * atmospheric volume's sampler.
 */
function sampleElevation(grid, lat, lon) {
  const m = proj.fromGeographic(grid.crs, lat, lon);
  const px = (m.x - grid.transform.originX) / grid.transform.scaleX - 0.5;
  const py = (m.y - grid.transform.originY) / grid.transform.scaleY - 0.5;
  if (!(px >= -0.5 && py >= -0.5 && px <= grid.width - 0.5 && py <= grid.height - 0.5)) return null;

  const x0 = Math.max(0, Math.min(grid.width - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(py)));
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, px - x0));
  const fy = Math.max(0, Math.min(1, py - y0));

  const v00 = grid.values[y0 * grid.width + x0];
  const v10 = grid.values[y0 * grid.width + x1];
  const v01 = grid.values[y1 * grid.width + x0];
  const v11 = grid.values[y1 * grid.width + x1];
  if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) return null;

  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

module.exports = {
  TAG,
  GEO_KEY,
  COMPRESSION,
  COMPRESSION_NAMES,
  RASTER_TYPE,
  DEFAULT_HEADER_BYTES,
  byteSource,
  readHeader,
  readGeoKeys,
  pixelCentre,
  pixelOf,
  levelBounds,
  levelResolutionM,
  chooseLevel,
  pixelWindow,
  tilesForWindow,
  mergeRanges,
  lzwDecode,
  decodeTile,
  assembleWindow,
  gridBounds,
  sampleElevation
};
