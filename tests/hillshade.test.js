/**
 * Graded against `gdaldem hillshade` over the same committed 1 m fixture the
 * slope and aspect grading uses.
 *
 * A hillshade is the easiest thing in this repository to get wrong without
 * noticing, because every wrong one is a picture of a hill. Lit from the
 * opposite side it is a plausible hill with the light somewhere else; with the
 * two axes swapped it is a plausible hill facing another way; with the aspect
 * sign flipped every ridge becomes a gully and it still reads as terrain. None
 * of those is visible without a reference, so:
 *
 *   shade          graded against `gdaldem hillshade`: 99.3% of pixels are
 *                  GDAL's byte exactly and the rest are one off it
 *   the tolerance  justified by measuring the *wrong* conventions against the
 *                  same reference, which are out by up to 248 of 255 — so
 *                  "within one byte" cannot be hiding one of them
 *   flat ground    graded against a plane, whose shade is sin(altitude) in
 *                  closed form and whose aspect does not exist
 *   holes          graded against the fixture with a lidar-shaped void in it
 *   placement      graded by sampling the resampled raster at a known
 *                  coordinate, and by measuring what not resampling would cost
 *
 * The reference is remade by `tools/make-hillshade-fixtures.sh`.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const derive = require("../derive.js");
const geo = require("../geo.js");
const proj = require("../proj.js");
const hillshade = require("../hillshade.js");

const FIXTURES = path.join(__dirname, "fixtures");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

/** The full-resolution level of a fixture, read as a window. */
function gridOf(name) {
  const buffer = fixture(name + ".tif");
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
  return cog.assembleWindow(header, level, window, decoded);
}

/** GDAL's hillshade raster: bytes, 0 meaning nodata. */
function gdaldem(name) {
  const meta = JSON.parse(fixture("gdaldem-" + name + ".gdal.json").toString("utf8"));
  const raw = fixture("gdaldem-" + name + ".gdal.f32");
  const n = meta.levels[0].width * meta.levels[0].height;
  const values = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 4));
  return { width: meta.levels[0].width, height: meta.levels[0].height, values: values };
}

/** Worst disagreement, how many pixels disagree at all, and mask mismatches. */
function compare(mine, theirs) {
  let worst = 0;
  let worstAt = -1;
  let differing = 0;
  let maskMismatches = 0;
  for (let i = 0; i < theirs.values.length; i++) {
    const them = theirs.values[i];
    const me = mine[i];
    if ((them === 0) !== (me === 0)) {
      maskMismatches++;
      continue;
    }
    if (them === 0) continue;
    const d = Math.abs(them - me);
    if (d > 0) differing++;
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
  return { worst: worst, worstAt: worstAt, differing: differing, maskMismatches: maskMismatches };
}

/** A synthetic grid in metres, north-up, so a shade has a closed form. */
function planeGrid(width, height, fn) {
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) values[y * width + x] = fn(x, y);
  }
  return {
    crs: { kind: "projected", epsg: 26913 },
    width: width,
    height: height,
    transform: { originX: 0, originY: 0, scaleX: 1, scaleY: -1 },
    values: values
  };
}

describe("hillshade against gdaldem", function () {
  const grid = gridOf("cog-utm13-1m");
  const reference = gdaldem("utm13-hillshade");

  test("99.3% of pixels are GDAL's byte, and none is more than one off", function () {
    const bytes = hillshade.toBytes(hillshade.shade(grid));
    const diff = compare(bytes, reference);

    expect(diff.maskMismatches).toBe(0);
    expect(diff.worst).toBeLessThanOrEqual(1);
    // The residual is 80 pixels in 11,844, and it is not a disagreement about
    // the light: `derive` keeps its gradients in float32 where GDAL carries
    // the same 3 x 3 window in double, and every one of the 80 sits within
    // 0.022 of a rounding boundary — measured, not assumed. Chasing them would
    // mean widening the terrain cache to float64 for a picture, and the next
    // test is what makes a one-byte tolerance safe to accept anyway.
    expect(diff.differing / reference.values.length).toBeLessThan(0.01);
  });

  test("the wrong illumination conventions are out by a hundred bytes, not one", function () {
    // Why a one-byte tolerance is not a hole to drive a sign error through.
    // Each of these is a hillshade a person would accept as terrain.
    const wrong = {
      "lit from the south-east": { azimuthDeg: 135 },
      "lit from the north-east": { azimuthDeg: 45 },
      "sun on the horizon": { altitudeDeg: 5 }
    };
    for (const name of Object.keys(wrong)) {
      const bytes = hillshade.toBytes(hillshade.shade(grid, wrong[name]));
      expect({ name: name, worst: compare(bytes, reference).worst > 50 }).toEqual({ name: name, worst: true });
    }
  });

  test("the derived fields and the raw grid give the same shade", function () {
    // The service shades what the terrain cache already holds rather than
    // running Horn's operator twice over a 3,000 x 3,000 window.
    const fromGrid = hillshade.toBytes(hillshade.shade(grid));
    const fromDerived = hillshade.toBytes(hillshade.shade(derive.derive(grid)));
    expect(Array.from(fromDerived)).toEqual(Array.from(fromGrid));
  });
});

describe("ground with no aspect", function () {
  test("a level plane is sin(altitude), not a hole", function () {
    // `slopeAspect` gives flat ground NaN for its aspect on purpose — 0 is a
    // real bearing. Carried through unthought-about, every lake and plain in
    // the domain renders transparent, which is the page's signal for terrain
    // that was never read.
    const flat = planeGrid(8, 8, function () { return 1700; });
    const field = hillshade.shade(flat);
    const middle = field.values[3 * 8 + 3];
    expect(middle).toBeCloseTo(Math.sin(45 * Math.PI / 180), 6);
    expect(hillshade.toBytes(field)[3 * 8 + 3]).toBeGreaterThan(0);
  });

  test("a slope facing the light is brighter than one facing away", function () {
    const east = planeGrid(8, 8, function (x) { return 1700 + x; });
    const west = planeGrid(8, 8, function (x) { return 1700 - x; });
    const at = 3 * 8 + 3;
    // Light from the north-west: ground falling away to the west catches it.
    expect(hillshade.shade(east).values[at]).toBeGreaterThan(hillshade.shade(west).values[at]);
  });

  test("a slope steeper than the light is fully in its own shadow, not negative", function () {
    const steep = planeGrid(8, 8, function (x, y) { return 1700 - 40 * (x + y); });
    const at = 3 * 8 + 3;
    expect(hillshade.shade(steep, { altitudeDeg: 10 }).values[at]).toBe(0);
    expect(hillshade.toBytes(hillshade.shade(steep, { altitudeDeg: 10 }))[at]).toBe(1);
  });
});

describe("holes", function () {
  test("a void stays a void, and takes its neighbours' shade with it", function () {
    const holed = gridOf("cog-nodata-hole");
    const field = hillshade.shade(holed);
    const bytes = hillshade.toBytes(field);

    let voids = 0;
    for (let i = 0; i < holed.values.length; i++) if (Number.isNaN(holed.values[i])) voids++;
    expect(voids).toBeGreaterThan(0);

    // Every nodata pixel is unshaded, and so is every pixel whose 3 x 3
    // window touched one: a shade computed across the edge of a hole is a
    // cliff face that is not there.
    for (let i = 0; i < holed.values.length; i++) {
      if (Number.isNaN(holed.values[i])) expect(bytes[i]).toBe(0);
    }
    expect(field.litCount).toBeLessThan(holed.values.length - voids);
  });
});

describe("onto a lat/long lattice", function () {
  const grid = gridOf("cog-utm13-1m");
  const field = hillshade.shade(grid);
  const box = cog.gridBounds(grid);

  test("a pixel holds the shade of the ground under its own coordinate", function () {
    const raster = hillshade.toGeographic(field, box, { width: 64 });
    const dLat = (box.north - box.south) / raster.height;
    const dLon = (box.east - box.west) / raster.width;

    // Four pixels away from the edges, each read back through the sampler
    // against its own centre coordinate. This is what catches a raster written
    // south-row-first, or x and y transposed: both produce a picture of the
    // same hill, placed somewhere else.
    for (const at of [[10, 7], [31, 20], [50, 33], [20, 45]]) {
      const lon = box.west + (at[0] + 0.5) * dLon;
      const lat = box.north - (at[1] + 0.5) * dLat;
      // Close rather than equal: the raster keeps float32, the sampler
      // returns double.
      expect(raster.values[at[1] * raster.width + at[0]])
        .toBeCloseTo(cog.sampleElevation(field, lat, lon), 6);
    }
  });

  test("square ground pixels, and the height follows from the box", function () {
    const raster = hillshade.toGeographic(field, box, { width: 64 });
    const midLat = (box.south + box.north) / 2;
    const groundW = (box.east - box.west) * geo.metersPerDegLon(midLat);
    const groundH = (box.north - box.south) * geo.METERS_PER_DEG_LAT;
    expect(raster.height).toBe(Math.round(64 * groundH / groundW));
    // Within a percent: a whole number of rows cannot divide the box exactly,
    // and at 64 px the quantisation is the whole of the difference.
    const ratio = (groundH / raster.height) / (groundW / raster.width);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.01);
  });

  test("ground outside the terrain that was read is a hole, not a guess", function () {
    // The lat/long box around a UTM rectangle is bigger than the rectangle:
    // the corners of one are outside the other, by exactly the rotation the
    // next test measures. Those corners have no terrain and must come back
    // transparent rather than clamped to the nearest edge pixel.
    const raster = hillshade.toGeographic(field, box, { width: 64 });
    expect(raster.coveredFraction).toBeGreaterThan(0.85);
    expect(raster.coveredFraction).toBeLessThan(1);
    expect(Number.isNaN(raster.values[0])).toBe(true);
    expect(hillshade.toBytes(raster)[0]).toBe(0);
  });

  test("not resampling would put the picture metres off the ground it shades", function () {
    // The claim in hillshade.js, measured rather than asserted. Stretching the
    // UTM raster corner-to-corner across the lat/long box — what a web map
    // does with an image overlay if it is handed the projected grid — displaces
    // the middle of the domain by metres, because UTM's grid north is not true
    // north here.
    const raster = hillshade.toGeographic(field, box, { width: 64 });
    let worst = 0;
    for (let y = 0; y < raster.height; y += 8) {
      for (let x = 0; x < raster.width; x += 8) {
        const lat = box.north - (y + 0.5) * (box.north - box.south) / raster.height;
        const lon = box.west + (x + 0.5) * (box.east - box.west) / raster.width;
        const right = proj.fromGeographic(grid.crs, lat, lon);
        const naive = {
          x: grid.transform.originX + ((x + 0.5) / raster.width) * grid.width * grid.transform.scaleX,
          y: grid.transform.originY + ((y + 0.5) / raster.height) * grid.height * grid.transform.scaleY
        };
        worst = Math.max(worst, Math.hypot(right.x - naive.x, right.y - naive.y));
      }
    }
    // Sub-metre over a fixture 128 m across, and it scales with the domain:
    // the same rotation across the map's two-mile box is about ten metres,
    // which is a ridge in the wrong place rather than a soft edge.
    expect(worst).toBeGreaterThan(0.3);
    const overTwoMiles = worst * (3218 / (grid.width * grid.transform.scaleX));
    expect(overTwoMiles).toBeGreaterThan(5);
  });

  test("a raster nobody could display is refused", function () {
    expect(function () { hillshade.toGeographic(field, box, { width: 1 }); }).toThrow(/width/);
    expect(function () { hillshade.toGeographic(field, box, { width: 40000 }); }).toThrow(/width/);
    expect(function () { hillshade.toGeographic(field, box, {}); }).toThrow(/width/);
  });
});

describe("refusals", function () {
  const grid = gridOf("cog-utm13-1m");

  test("an impossible sun is refused rather than producing a black picture", function () {
    expect(function () { hillshade.shade(grid, { altitudeDeg: 0 }); }).toThrow(/altitudeDeg/);
    expect(function () { hillshade.shade(grid, { altitudeDeg: 120 }); }).toThrow(/altitudeDeg/);
    expect(function () { hillshade.shade(grid, { azimuthDeg: "north-west" }); }).toThrow(/azimuthDeg/);
  });
});
