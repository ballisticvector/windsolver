/**
 * Ask USGS how its DEM tiles are laid out, by reading the TIFF headers over
 * range requests.
 *
 *   node tools/cog-survey.js            # the six sample regions below
 *   node tools/cog-survey.js -105.3 40.0 -105.2 40.1
 *
 * The question this answers is whether a domain's window can be read without
 * pulling the whole tile. Two properties decide it:
 *
 *   internally tiled   a stripped TIFF answers range requests and still makes
 *                      you read most of the file to get a square window
 *   IFD near the front the directory says where the tiles are, so a directory
 *                      at the end of a 400 MB file costs a round trip to find
 *
 * Nothing here is imported by the library; it exists so the claim in README.md
 * can be re-checked rather than believed. It talks to the live TNM API and to
 * S3, so it is not part of `npm test`.
 */
const dem = require("../dem.js");

const REGIONS = [
  ["CO Boulder", { west: -105.32, south: 39.98, east: -105.24, north: 40.04 }],
  ["TX Hill Country", { west: -98.6, south: 30.1, east: -98.5, north: 30.2 }],
  ["PA Allegheny", { west: -78.9, south: 41.2, east: -78.8, north: 41.3 }],
  ["WA Cascades", { west: -121.4, south: 47.4, east: -121.3, north: 47.5 }],
  ["FL Everglades", { west: -80.9, south: 25.6, east: -80.8, north: 25.7 }],
  ["MT Bitterroot", { west: -114.1, south: 46.2, east: -114.0, north: 46.3 }]
];

const TAG_WIDTH = 256;
const TAG_HEIGHT = 257;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_HEIGHT = 323;
const TAG_COMPRESSION = 259;
const TAG_PREDICTOR = 317;
const TILES_PER_REGION = 4;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("TNM answered " + res.status);
  return res.json();
}

async function range(url, start, end) {
  const res = await fetch(url, { headers: { Range: "bytes=" + start + "-" + end } });
  if (res.status !== 206) {
    throw new Error("expected 206 for a range request, got " + res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Walk the IFD chain. Every offset in a TIFF is absolute, so a buffer read from
 * the middle of the file needs its own start subtracted before indexing.
 */
function readIfdChain(buf, firstOffset, littleEndian, bigTiff, bufferStart) {
  const u16 = (o) => (littleEndian ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (littleEndian ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(littleEndian ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));

  const entrySize = bigTiff ? 20 : 12;
  const chain = [];
  let offset = firstOffset;

  while (offset !== null) {
    const at = offset - bufferStart;
    if (at < 0 || at + 8 > buf.length || chain.length >= 12) break;

    const count = bigTiff ? u64(at) : u16(at);
    const base = at + (bigTiff ? 8 : 2);
    if (!count || count > 200 || base + count * entrySize + 8 > buf.length) break;

    const tags = {};
    for (let i = 0; i < count; i++) {
      const entry = base + i * entrySize;
      tags[u16(entry)] = bigTiff ? u64(entry + 12) : u32(entry + 8);
    }
    chain.push(tags);

    const nextAt = base + count * entrySize;
    const next = bigTiff ? u64(nextAt) : u32(nextAt);
    offset = next === 0 ? null : next;
  }

  return chain;
}

async function layoutOf(url) {
  const head = await fetch(url, { method: "HEAD" });
  const bytes = Number(head.headers.get("content-length"));
  const acceptsRanges = head.headers.get("accept-ranges");

  const front = await range(url, 0, 32767);
  const littleEndian = front.toString("ascii", 0, 2) === "II";
  const bigTiff = (littleEndian ? front.readUInt16LE(2) : front.readUInt16BE(2)) === 43;
  const firstIfd = bigTiff
    ? Number(littleEndian ? front.readBigUInt64LE(8) : front.readBigUInt64BE(8))
    : (littleEndian ? front.readUInt32LE(4) : front.readUInt32BE(4));

  // The chain may run past the first read, and on a non-COG the directory is
  // not in it at all, so fall back to a window around wherever it claims to be.
  let chain = firstIfd < front.length
    ? readIfdChain(front, firstIfd, littleEndian, bigTiff, 0)
    : [];
  if (chain.length <= 1) {
    const start = Math.max(0, Math.min(firstIfd - 1024, bytes - 1048576));
    const window = await range(url, start, Math.min(bytes - 1, start + 1048575));
    const alt = readIfdChain(window, firstIfd, littleEndian, bigTiff, start);
    if (alt.length > chain.length) chain = alt;
  }

  const top = chain[0] || {};
  return {
    bytes: bytes,
    acceptsRanges: acceptsRanges,
    firstIfd: firstIfd,
    frontLoaded: firstIfd < 4096,
    tiled: Boolean(top[TAG_TILE_WIDTH] && top[TAG_TILE_HEIGHT]),
    tile: top[TAG_TILE_WIDTH] ? top[TAG_TILE_WIDTH] + "x" + top[TAG_TILE_HEIGHT] : "stripped",
    compression: top[TAG_COMPRESSION],
    predictor: top[TAG_PREDICTOR] || 1,
    size: top[TAG_WIDTH] + "x" + top[TAG_HEIGHT],
    overviews: Math.max(0, chain.length - 1),
    bigTiff: bigTiff
  };
}

async function surveyRegion(label, box, rows) {
  for (const dataset of ["1m", "one-third"]) {
    let tiles = [];
    try {
      const found = await dem.discover(box, fetchJson, { only: [dataset] });
      // More than one vintage covers most ground, and a tile's layout is a
      // property of the project that converted it rather than of the product,
      // so taking only the newest per footprint surveys one conversion era.
      tiles = (found.tiles || []).slice(0, TILES_PER_REGION);
    } catch (err) {
      console.log(label, dataset, "discovery failed:", err.message);
      continue;
    }
    if (!tiles.length) {
      console.log(label.padEnd(16), dataset.padEnd(10), "no tiles here");
      continue;
    }
    for (const tile of tiles) {
      const url = tile.downloadUrl || tile.url;
      if (!url) continue;
      const name = url.split("/").pop();
      try {
        const l = await layoutOf(url);
        rows.push(Object.assign({ dataset: dataset, name: name }, l));
        console.log([
          label.padEnd(16),
          dataset.padEnd(10),
          ((l.bytes / 1e6).toFixed(0) + " MB").padStart(7),
          ("ifd@" + l.firstIfd).padEnd(16),
          l.frontLoaded ? "front-loaded" : "AT THE END  ",
          l.tile.padEnd(9),
          ("pred " + l.predictor).padEnd(7),
          (l.overviews + " overviews").padEnd(13),
          name
        ].join(" "));
      } catch (err) {
        console.log(label, dataset, name, "failed:", err.message);
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const regions = argv.length === 4
    ? [["argv", { west: +argv[0], south: +argv[1], east: +argv[2], north: +argv[3] }]]
    : REGIONS;

  const rows = [];
  for (const [label, box] of regions) await surveyRegion(label, box, rows);

  for (const dataset of ["1m", "one-third"]) {
    const seen = rows.filter((r) => r.dataset === dataset);
    if (!seen.length) continue;
    console.log(
      "\n" + dataset + ": " + seen.length + " tiles" +
      " | front-loaded " + seen.filter((r) => r.frontLoaded).length + "/" + seen.length +
      " | tiled " + seen.filter((r) => r.tiled).length + "/" + seen.length +
      " | tile sizes " + [...new Set(seen.map((r) => r.tile))].join(", ") +
      " | predictors " + [...new Set(seen.map((r) => r.predictor))].join(", ") +
      " | overview counts " + [...new Set(seen.map((r) => r.overviews))].join(", ")
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
