/**
 * Getting a real elevation grid over a domain: the one module here that makes
 * requests.
 *
 * `dem.js` decides which product covers the domain, `cog.js` decides which
 * bytes of a tile are worth asking for, and this stitches the two together over
 * HTTP range requests. It is deliberately thin, and `fetch` is injected, so the
 * decisions stay in the modules that can be tested without a network.
 *
 * The shape of the work is: read the front of the file, parse until the parser
 * stops asking for bytes, pick an overview, work out which internal tiles the
 * window touches, fetch those runs, decode, paste. A 3 GB whole-tile download
 * becomes a few hundred kilobytes.
 */

"use strict";

const cog = require("./cog");
const dem = require("./dem");
const geo = require("./geo");

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ROUND_TRIPS = 8;
const DEFAULT_TIMEOUT_MS = 30000;

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * A ranged reader over one URL.
 *
 * A server that ignores `Range` answers 200 with the whole file, and a reader
 * that does not check the status quietly downloads 400 MB and looks slow rather
 * than broken. 206 is required, and the byte budget is enforced across the
 * whole read rather than per request.
 */
function rangeReaderFor(url, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch === undefined ? globalThis.fetch : o.fetch;
  if (typeof fetchImpl !== "function") throw fail("no-fetch", "no fetch implementation is available");
  const maxBytes = o.maxBytes === undefined ? DEFAULT_MAX_BYTES : o.maxBytes;
  const timeoutMs = o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs;
  let spent = 0;
  let requests = 0;

  async function read(start, length) {
    const end = start + length - 1;
    if (spent + length > maxBytes) {
      throw fail(
        "too-many-bytes",
        "this window would read " + (spent + length) + " bytes from " + url + ", past the " + maxBytes +
        "-byte budget; ask for a coarser overview or a smaller box rather than raising it blindly",
        { url: url, spent: spent }
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { headers: { Range: "bytes=" + start + "-" + end }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status !== 206) {
      throw fail(
        "no-range-support",
        "asked " + url + " for bytes " + start + "-" + end + " and it answered " + res.status +
        " rather than 206, which means the whole file, not the window",
        { url: url, status: res.status }
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    spent += buffer.length;
    requests++;
    return buffer;
  }

  read.stats = function () { return { bytes: spent, requests: requests }; };
  return read;
}

/**
 * Read the directories of a COG, fetching only as much of the front as they
 * turn out to need.
 *
 * The parser asks for byte ranges it has not been given, so a file whose
 * directory sits at the end — legal, and the layout a naive front-only reader
 * silently fails on — costs one more round trip instead of failing. The trip
 * count is bounded so a pathological file cannot turn into an unbounded crawl.
 */
async function openCog(read, opts) {
  const o = opts || {};
  const source = cog.byteSource();
  const maxTrips = o.maxRoundTrips === undefined ? DEFAULT_MAX_ROUND_TRIPS : o.maxRoundTrips;
  const first = o.headerBytes === undefined ? cog.DEFAULT_HEADER_BYTES : o.headerBytes;

  source.add(0, await read(0, first));

  for (let trip = 1; ; trip++) {
    try {
      return { header: cog.readHeader(source), source: source, headerReads: trip };
    } catch (err) {
      if (err.code !== "need-bytes") throw err;
      if (trip >= maxTrips) {
        throw fail(
          "header-scattered",
          "still reading directory bytes after " + trip + " requests; this file's directories are " +
          "spread through it rather than gathered, which is not a layout worth chasing one range at a time",
          { url: o.url || null }
        );
      }
      // Ask for a window around the byte wanted rather than exactly it: TIFF
      // directories are contiguous, so the next few tags are almost certainly
      // in the same neighbourhood and a tag-at-a-time crawl is all round trips.
      const want = err.missing;
      const pad = o.headerPadBytes === undefined ? 65536 : o.headerPadBytes;
      const start = Math.max(0, want.start - 1024);
      source.add(start, await read(start, Math.max(want.length + 1024, pad)));
    }
  }
}

/**
 * An elevation grid covering `box`, read out of one COG.
 *
 * `targetResolutionM` selects the overview: the coarsest level still finer than
 * that. It is a resolution rather than a pixel budget because that is what the
 * caller actually knows — a solver mesh is 10-20 m whatever the source is, and
 * reading 1 m terrain to average it down to 10 m is nine tenths of the bytes
 * thrown away.
 */
async function readWindow(url, box, opts) {
  const o = opts || {};
  if (geo.crossesAntimeridian(box)) {
    throw fail("box-crosses-antimeridian", "a box with west > east cannot be read as one window");
  }

  const read = o.read || rangeReaderFor(url, o);
  const opened = await openCog(read, Object.assign({ url: url }, o));
  const header = opened.header;
  const level = o.level !== undefined ? header.levels[o.level] : cog.chooseLevel(header, o.targetResolutionM);
  if (!level) throw fail("no-such-level", "this file has no level " + o.level);

  const window = cog.pixelWindow(header, level, box, o.padPixels);
  const tiles = cog.tilesForWindow(level, window);
  const ranges = cog.mergeRanges(tiles, o.maxGapBytes);
  const decoded = new Map();

  for (const range of ranges) {
    const bytes = await read(range.start, range.end - range.start);
    for (const tile of range.tiles) {
      const at = tile.offset - range.start;
      decoded.set(tile.tx + "," + tile.ty, cog.decodeTile(bytes.subarray(at, at + tile.byteCount), level, header));
    }
  }

  const grid = cog.assembleWindow(header, level, window, decoded);
  grid.url = url;
  grid.tilesRead = ranges.reduce(function (n, r) { return n + r.tiles.length; }, 0);
  grid.requests = read.stats ? read.stats().requests : null;
  grid.bytesRead = read.stats ? read.stats().bytes : null;
  grid.emptyTiles = tiles.filter(function (t) { return t.empty; }).length;
  grid.voidFraction = grid.noDataCount / (grid.width * grid.height);
  return grid;
}

/**
 * Discover the best product over a box and read a window of it.
 *
 * Terrain arrives as a mosaic — a domain that straddles two 3DEP tiles needs
 * both — so this returns one grid per tile touched rather than pretending a
 * domain is always one file. Merging them onto a common grid is resampling, and
 * resampling is the caller's decision, not a side effect of fetching.
 */
async function readTerrain(box, opts) {
  const o = opts || {};
  const found = o.selection || await dem.discover(box, o.fetchJson, o);
  if (!found.dataset) {
    throw fail(
      "no-terrain",
      "no 3DEP product covers this box well enough to use " +
      "(best was " + JSON.stringify(found.considered) + ")",
      { considered: found.considered }
    );
  }

  const grids = [];
  for (const tile of found.tiles) {
    if (!geo.intersects(tile.box, box)) continue;
    const url = tile.downloadUrl;
    if (!url) continue;
    grids.push(await readWindow(url, box, Object.assign({}, o, { read: undefined })));
  }

  if (!grids.length) {
    throw fail("no-terrain", "the selected product listed no downloadable tile over this box");
  }

  // Least void first, because a tile can be listed over a box and hold no
  // ground there at all: over Boulder the newer of the two 1 m tiles is
  // 181,872 nodata pixels out of 181,872, and the 2013 one under it carries
  // the terrain. `elevationAt` takes the first grid with a value, so ordering
  // is the difference between one sample and one sample per tile.
  grids.sort(function (a, b) { return a.voidFraction - b.voidFraction; });

  return {
    dataset: found.dataset,
    coverage: found.coverage,
    grids: grids,
    allVoid: grids.every(function (g) { return g.voidFraction === 1; }),
    bytesRead: grids.reduce(function (n, g) { return n + (g.bytesRead || 0); }, 0),
    requests: grids.reduce(function (n, g) { return n + (g.requests || 0); }, 0),
    wholeTileBytes: found.downloadBytes
  };
}

/**
 * Elevation at a coordinate from a set of grids, in metres, or null.
 *
 * The first grid that has a real value wins; a coordinate in the overlap
 * between two tiles is answered by whichever holds ground there, which is what
 * makes a domain straddling a tile edge readable at all.
 */
function elevationAt(grids, lat, lon) {
  for (const grid of grids) {
    const v = cog.sampleElevation(grid, lat, lon);
    if (v !== null) return v;
  }
  return null;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROUND_TRIPS,
  rangeReaderFor,
  openCog,
  readWindow,
  readTerrain,
  elevationAt
};
