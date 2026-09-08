"use strict";

/**
 * A terrain-aware wind field over a real place, end to end.
 *
 * This is the module that joins the two halves: 3DEP terrain through
 * `terrain.js`, HRRR through `nomads.js`, and the empirical downscaling in
 * `downscale.js`. Everything it adds is composition and the two decisions that
 * fall out of composing them — how a domain that straddles two 3DEP tiles
 * becomes one grid, and how much ground beyond the requested box has to be read
 * for the derivatives inside it to be defined.
 *
 * The split follows the rest of the engine: `assemble` is pure and takes terrain
 * grids and a volume that someone else fetched, so every interesting decision is
 * testable with no network. `createFieldService` is the side that fetches.
 *
 * Nothing here knows about rifles. The answer is east/north over geographic
 * space at one height and one instant; projecting that onto a shot is the
 * consumer's job.
 */

const geo = require("./geo.js");
const cog = require("./cog.js");
const proj = require("./proj.js");
const terrainModule = require("./terrain.js");
const dem = require("./dem.js");
const derive = require("./derive.js");
const downscale = require("./downscale.js");
const volumeModule = require("./volume.js");
const cache = require("./cache.js");
const hrrr = require("./hrrr.js");

const FIELD_VERSION = 1;
const DEFAULT_RADIUS_MILES = 1;
const DEFAULT_TARGET_RESOLUTION_M = 10;
const DEFAULT_LEVEL = "heightAboveGround:10";

// HRRR's grid spacing, and the reason the atmospheric request is wider than the
// domain: a two-mile box is a little over one 3 km cell, and the filter can
// return a single column of them. Bilinear sampling needs a 2x2 around the
// point, so a domain narrower than two cells has to ask for the neighbours.
const MODEL_CELL_M = 3000;

// HRRR's own surface height on top of the usual set, because the gap between
// the model's ground and the real ground is the honest measure of how much work
// the downscaling is being asked to do. Without it `terrainOffset` has nothing
// to compare against.
const DEFAULT_VARIABLES = hrrr.DEFAULT_VARIABLES.concat(["HGT"]);

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * How far outside the requested box the terrain has to be read.
 *
 * A pixel's derivatives are a function of ground around it: 500 m of curvature
 * arm and 300 m of shelter search are both undefined within that distance of
 * the grid edge. Reading only the requested box therefore returns a field with
 * a ragged undefined border exactly where the user asked. The margin is the
 * larger of the two reaches, plus a pixel for the 3x3 neighbourhood.
 */
function paddingMetres(opts) {
  const o = opts || {};
  const curvature = o.curvatureLengthM === undefined
    ? downscale.DEFAULT_CURVATURE_LENGTH_M
    : o.curvatureLengthM;
  const shelterOpts = o.shelter === true ? {} : (o.shelter || null);
  const shelterM = shelterOpts
    ? (shelterOpts.maxDistanceM === undefined
      ? derive.DEFAULT_MAX_SHELTER_DISTANCE_M
      : shelterOpts.maxDistanceM)
    : 0;
  const resolution = o.targetResolutionM === undefined
    ? DEFAULT_TARGET_RESOLUTION_M
    : o.targetResolutionM;
  return Math.max(curvature / 2, shelterM) + resolution;
}

/** The requested box and the larger box that has to be read to fill it. */
function domainOf(spec) {
  const s = spec || {};
  const box = s.box || (
    Number.isFinite(s.lat) && Number.isFinite(s.lon)
      ? geo.boundingBox(s.lat, s.lon, s.radiusMiles === undefined ? DEFAULT_RADIUS_MILES : s.radiusMiles)
      : null
  );
  if (!box) throw fail("no-domain", "a box, or a lat/lon with a radius, is required");

  const padM = paddingMetres(s);
  return {
    box: box,
    readBox: geo.expand(box, padM / geo.METERS_PER_MILE),
    paddingM: padM,
    centre: { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 }
  };
}

/** The base grid's own pixels on their own lattice, ready to be filled from. */
function blankLike(base) {
  return {
    crs: base.crs,
    width: base.width,
    height: base.height,
    transform: base.transform,
    values: Float32Array.from(base.values)
  };
}

/**
 * The base grid's pixels on a lattice big enough to hold the whole box.
 *
 * The tile with the least void is not necessarily the tile that covers the
 * domain: over Boulder the two 1 m projects meet at 40.0200, so a two-mile box
 * centred on the town is a southern tile and a northern one, and keeping the
 * base tile's extent silently crops the domain to whichever was cleaner.
 *
 * The canvas grows in whole pixels along the base's own lattice, so the base
 * pixels are copied rather than resampled and land on the same ground they
 * came off. Everything outside the base starts as `NaN` and is filled from the
 * other tiles by the caller, which is the same path a hole inside it takes.
 *
 * It grows only as far as the other tiles reach. A canvas covering ground no
 * tile was read over would be honest — `NaN` is a hole — but it would also be
 * a grid of holes wherever the caller asked beyond what 3DEP was queried for,
 * which reads as missing terrain rather than as a box drawn too wide.
 */
function pixelRangeOf(base, box) {
  const range = { minPx: Infinity, maxPx: -Infinity, minPy: Infinity, maxPy: -Infinity };
  // Corners and edge midpoints, because a projected lattice does not keep a
  // geographic box rectangular and the widest point can be in the middle of a
  // side rather than at a corner.
  const lats = [box.south, (box.south + box.north) / 2, box.north];
  const lons = [box.west, (box.west + box.east) / 2, box.east];
  for (const lat of lats) {
    for (const lon of lons) {
      const m = proj.fromGeographic(base.crs, lat, lon);
      const at = cog.pixelOf(base, m.x, m.y);
      range.minPx = Math.min(range.minPx, Math.floor(at.px));
      range.maxPx = Math.max(range.maxPx, Math.ceil(at.px));
      range.minPy = Math.min(range.minPy, Math.floor(at.py));
      range.maxPy = Math.max(range.maxPy, Math.ceil(at.py));
    }
  }
  return range;
}

function canvasFor(base, box, others) {
  const reach = { minPx: 0, maxPx: base.width - 1, minPy: 0, maxPy: base.height - 1 };
  for (const g of (others || [])) {
    const r = pixelRangeOf(base, g.bounds || cog.gridBounds(g));
    reach.minPx = Math.min(reach.minPx, r.minPx);
    reach.maxPx = Math.max(reach.maxPx, r.maxPx);
    reach.minPy = Math.min(reach.minPy, r.minPy);
    reach.maxPy = Math.max(reach.maxPy, r.maxPy);
  }

  const want = pixelRangeOf(base, box);
  const minPx = Math.max(reach.minPx, Math.min(0, want.minPx));
  const maxPx = Math.min(reach.maxPx, Math.max(base.width - 1, want.maxPx));
  const minPy = Math.max(reach.minPy, Math.min(0, want.minPy));
  const maxPy = Math.min(reach.maxPy, Math.max(base.height - 1, want.maxPy));

  const width = maxPx - minPx + 1;
  const height = maxPy - minPy + 1;
  const values = new Float32Array(width * height).fill(NaN);
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      values[(y - minPy) * width + (x - minPx)] = base.values[y * base.width + x];
    }
  }

  return {
    crs: base.crs,
    width: width,
    height: height,
    transform: {
      originX: base.transform.originX + minPx * base.transform.scaleX,
      originY: base.transform.originY + minPy * base.transform.scaleY,
      scaleX: base.transform.scaleX,
      scaleY: base.transform.scaleY
    },
    values: values
  };
}

/**
 * One elevation grid out of the several `readTerrain` returns.
 *
 * The first grid — least void, as `readTerrain` sorts them — is the base, and
 * its pixels are never touched. Only its holes are filled, by sampling the
 * other tiles at the hole's own coordinate. That way a domain straddling a tile
 * edge is readable without resampling the ground that was already there, and
 * the answer over the bulk of the domain is bit for bit what the file holds.
 *
 * Filling is bilinear through the neighbouring tile, so a hole beside that
 * tile's own void stays a hole: `sampleElevation` refuses to interpolate across
 * nodata, and inventing ground is the failure this whole path is trying to
 * avoid.
 */
function mosaic(grids, opts) {
  const o = opts || {};
  if (!Array.isArray(grids) || !grids.length) throw fail("no-grids", "at least one elevation grid is required");
  const base = grids[0];
  const others = grids.slice(1);

  const canvas = o.box ? canvasFor(base, o.box, others) : blankLike(base);
  const filledFrom = [];
  let filled = 0;
  let voids = 0;
  const values = canvas.values;

  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i])) continue;
    voids++;
    if (!others.length) continue;
    const px = i % canvas.width;
    const py = Math.floor(i / canvas.width);
    const at = cog.pixelCentre(canvas, px, py);
    const ll = proj.toGeographic(base.crs, at.x, at.y);
    for (let g = 0; g < others.length; g++) {
      const v = cog.sampleElevation(others[g], ll.lat, ll.lon);
      if (v === null || Number.isNaN(v)) continue;
      values[i] = v;
      filled++;
      filledFrom[g] = (filledFrom[g] || 0) + 1;
      break;
    }
  }

  const out = {
    crs: base.crs,
    width: canvas.width,
    height: canvas.height,
    transform: canvas.transform,
    values: values,
    resolutionM: base.resolutionM,
    bounds: cog.gridBounds(canvas),
    sources: grids.map(function (g) { return g.url || null; }),
    voidCount: voids - filled,
    filledCount: filled,
    filledFrom: grids.slice(1).map(function (g, i) {
      return { url: g.url || null, filled: filledFrom[i] || 0 };
    })
  };
  out.voidFraction = out.voidCount / (out.width * out.height);
  if (o.maxVoidFraction !== undefined && out.voidFraction > o.maxVoidFraction) {
    throw fail(
      "too-void",
      "the terrain over this domain is " + (out.voidFraction * 100).toFixed(1) +
      "% holes after mosaicking, over the " + (o.maxVoidFraction * 100).toFixed(1) + "% allowed",
      { voidFraction: out.voidFraction }
    );
  }
  return out;
}

/** The height above ground a level key names, or null if it names something else. */
function heightOf(level) {
  const parts = String(level).split(":");
  if (parts[0] !== "heightAboveGround") return null;
  const h = Number(parts[1]);
  return Number.isFinite(h) ? h : null;
}

/**
 * How finely the model is sampled when the reference is built per cell.
 *
 * The model is sampled on a lattice and interpolated onto the terrain grid,
 * because a 10 m terrain grid is 300 pixels for every number a 3 km model
 * holds and each pixel costs an inverse projection. What that approximation
 * costs is measured rather than assumed: `tests/field.test.js` grades the
 * lattice against sampling every pixel directly, and at 32 samples per model
 * cell — 94 m for HRRR — the worst cell is out by under 0.01 m/s. Eight
 * samples is out by 0.089, which is larger than the whole terrain ablation
 * table, so this constant is not free to lower.
 */
const REFERENCE_SAMPLES_PER_CELL = 32;

/**
 * The single model wind the whole domain is downscaled from.
 *
 * One wind, sampled at the domain's centre, because a 2-mile box is about one
 * 3 km HRRR cell. `cellsAcross` says how many it really is, and `referenceGrid`
 * below is the other path: a wind per cell, for a domain wide enough that the
 * model has something to say across it.
 */
function referenceWind(volume, box, opts) {
  const o = opts || {};
  const level = o.level || DEFAULT_LEVEL;
  const centre = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
  const wind = volumeModule.sampleWind(volume, centre.lat, centre.lon, level);

  const spanM = Math.max(
    (box.north - box.south) * geo.METERS_PER_DEG_LAT,
    (box.east - box.west) * geo.metersPerDegLon(centre.lat)
  );
  const cellM = volume.grid && volume.grid.dxMeters ? volume.grid.dxMeters : null;

  return {
    east: wind.east,
    north: wind.north,
    heightAglM: heightOf(level),
    level: level,
    at: centre,
    validTime: volume.validTime,
    source: volume.source,
    cellsAcross: cellM ? spanM / cellM : null,
    perCell: false,
    spread: null
  };
}

/**
 * The model wind at every cell of the terrain grid, earth-relative.
 *
 * The alternative to one vector for the whole box. Each cell gets the model's
 * own answer where it stands, so a domain spanning several HRRR cells carries
 * the model's gradient instead of averaging it away at the centre.
 *
 * **This is not a terrain effect and must not be read as one.** The components
 * are `volume.sampleWind`'s, which are already rotated out of the grid frame by
 * `grib2.toEarthRelativeWind` when the volume is built; nothing here bends a
 * wind. What the downscaling does to it stays in `factor` and `divertDeg`,
 * which are functions of the ground and the local bearing alone — so a map that
 * varies because this varies is HRRR's structure, drawn honestly, and is
 * evidence for nothing about the terrain terms.
 *
 * The model is sampled on a lattice and interpolated onto the terrain grid,
 * because there is no more in HRRR than the lattice holds; `referenceSampleM`
 * overrides the spacing.
 */
function referenceGrid(volume, weights, opts) {
  const o = opts || {};
  const level = o.level || DEFAULT_LEVEL;
  const width = weights.width;
  const height = weights.height;
  const scaleX = Math.abs(weights.transform.scaleX);
  const scaleY = Math.abs(weights.transform.scaleY);
  const cellM = volume.grid && volume.grid.dxMeters ? volume.grid.dxMeters : MODEL_CELL_M;
  const stepM = o.referenceSampleM === undefined
    ? cellM / REFERENCE_SAMPLES_PER_CELL
    : o.referenceSampleM;
  if (!(stepM > 0)) throw fail("bad-sample", "referenceSampleM must be positive");

  const nx = Math.min(width, Math.max(2, Math.ceil((width * scaleX) / stepM) + 1));
  const ny = Math.min(height, Math.max(2, Math.ceil((height * scaleY) / stepM) + 1));
  const lastX = width > 1 ? width - 1 : 1;
  const lastY = height > 1 ? height - 1 : 1;
  const colOf = function (i) { return nx > 1 ? (i * lastX) / (nx - 1) : 0; };
  const rowOf = function (j) { return ny > 1 ? (j * lastY) / (ny - 1) : 0; };

  const latticeEast = new Float64Array(nx * ny);
  const latticeNorth = new Float64Array(nx * ny);
  let outside = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = weights.transform.originX + (colOf(i) + 0.5) * weights.transform.scaleX;
      const y = weights.transform.originY + (rowOf(j) + 0.5) * weights.transform.scaleY;
      const ll = proj.toGeographic(weights.crs, x, y);
      // The terrain grid is read wider than the box, and HRRR's subset is a
      // rectangle in Lambert space rather than in latitude and longitude, so a
      // corner of the padded grid can land off the end of the model even when
      // the fetch covered the box with a cell to spare. That corner is outside
      // the requested box by construction, so it becomes a hole — the same
      // answer as a hole in the model's own bitmap — rather than failing a
      // solve that is complete everywhere the caller asked about.
      let wind = { east: NaN, north: NaN };
      try {
        wind = volumeModule.sampleWind(volume, ll.lat, ll.lon, level);
      } catch (err) {
        if (err.code !== "outside-volume") throw err;
        outside++;
      }
      latticeEast[j * nx + i] = wind.east === null ? NaN : wind.east;
      latticeNorth[j * nx + i] = wind.north === null ? NaN : wind.north;
    }
  }

  const east = new Float32Array(width * height);
  const north = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const v = ny > 1 ? (row / lastY) * (ny - 1) : 0;
    const j0 = Math.min(ny - 2 < 0 ? 0 : ny - 2, Math.floor(v));
    const fj = v - j0;
    for (let col = 0; col < width; col++) {
      const u = nx > 1 ? (col / lastX) * (nx - 1) : 0;
      const i0 = Math.min(nx - 2 < 0 ? 0 : nx - 2, Math.floor(u));
      const fi = u - i0;
      const a = j0 * nx + i0;
      const b = a + (nx > 1 ? 1 : 0);
      const c = a + (ny > 1 ? nx : 0);
      const d = c + (nx > 1 ? 1 : 0);
      const at = row * width + col;
      east[at] = (latticeEast[a] * (1 - fi) + latticeEast[b] * fi) * (1 - fj) +
        (latticeEast[c] * (1 - fi) + latticeEast[d] * fi) * fj;
      north[at] = (latticeNorth[a] * (1 - fi) + latticeNorth[b] * fi) * (1 - fj) +
        (latticeNorth[c] * (1 - fi) + latticeNorth[d] * fi) * fj;
    }
  }

  const spanM = Math.max(width * scaleX, height * scaleY);
  const centre = proj.toGeographic(
    weights.crs,
    weights.transform.originX + (width / 2) * weights.transform.scaleX,
    weights.transform.originY + (height / 2) * weights.transform.scaleY
  );

  return {
    width: width,
    height: height,
    east: east,
    north: north,
    heightAglM: heightOf(level),
    level: level,
    at: centre,
    validTime: volume.validTime,
    source: volume.source,
    cellsAcross: spanM / cellM,
    sampledEveryM: stepM,
    samples: { x: nx, y: ny, outsideVolume: outside }
  };
}

/** The model's own surface elevation over the domain, if the volume carries it. */
function modelElevation(volume, box) {
  return modelSurface(volume, box, "HGT");
}

/** A surface scalar at the domain's centre, if the volume carries it. */
function modelSurface(volume, box, parameter) {
  if (!volume.scalars || !volume.scalars[parameter]) return null;
  const centre = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
  try {
    return volumeModule.sampleScalar(volume, parameter, centre.lat, centre.lon, "surface");
  } catch (err) {
    if (err.code === "no-such-level" || err.code === "no-such-parameter") return null;
    throw err;
  }
}

/**
 * Terrain grids plus a volume in, a downscaled field out. No network.
 *
 * Kept separate from the fetching so the composition — mosaic, derive, weight,
 * downscale, and which wind is used as the reference — is testable offline.
 */
function assemble(input) {
  const spec = input.spec || {};
  const domain = input.domain || domainOf(spec);
  const grid = input.grid || mosaic(input.grids, spec);
  const derived = input.derived || derive.derive(grid, spec);
  const weights = input.weights || downscale.terrainWeights(derived, spec);
  // One vector for the box unless a per-cell reference is asked for. It is not
  // the default: the arrows a per-cell run draws are more varied, and looking
  // more like weather is not evidence that they are more right. Nothing has
  // scored it against an anemometer yet.
  const reference = spec.perCell
    ? referenceGrid(input.volume, weights, spec)
    : referenceWind(input.volume, domain.box, spec);
  const field = downscale.downscale(weights, reference, Object.assign({}, spec, {
    heightAglM: reference.heightAglM
  }));
  // The model's spatial spread is the downscaler's to report, since it is the
  // one that knows which cells were used; the provenance is this module's.
  const referenceOut = spec.perCell
    ? {
      east: field.reference.east,
      north: field.reference.north,
      speedMps: field.reference.speedMps,
      fromDeg: field.reference.fromDeg,
      heightAglM: reference.heightAglM,
      level: reference.level,
      at: reference.at,
      validTime: reference.validTime,
      source: reference.source,
      cellsAcross: reference.cellsAcross,
      perCell: true,
      sampledEveryM: reference.sampledEveryM,
      spread: field.reference.spread
    }
    : reference;

  const modelZ = modelSurface(input.volume, domain.box, "HGT");

  return Object.assign({}, field, {
    schemaVersion: FIELD_VERSION,
    domain: domain.box,
    readBox: domain.readBox,
    paddingM: domain.paddingM,
    reference: referenceOut,
    validTime: input.volume.validTime,
    terrain: {
      dataset: input.dataset || null,
      resolutionM: grid.resolutionM,
      spacingM: derived.spacingM,
      sources: grid.sources,
      voidFraction: grid.voidFraction,
      filledCount: grid.filledCount,
      listing: terrainModule.agedListing(input.listing, input.now),
      coarserDataset: input.coarserDataset === undefined ? null : input.coarserDataset,
      filledFromCoarser: input.filledFromCoarser === undefined ? 0 : input.filledFromCoarser,
      bytesRead: input.bytesRead === undefined ? null : input.bytesRead,
      requests: input.requests === undefined ? null : input.requests
    },
    offset: modelZ === null ? null : downscale.terrainOffset(weights, modelZ),
    // HRRR's own aerodynamic roughness for the cell, when it was asked for. It
    // is not in `DEFAULT_VARIABLES` and the live path never requests it: the
    // downscaler assumes 0.03 m everywhere and this is the field that says what
    // the model assumed instead, which is a question `tools/score-wind.js` asks
    // and windsolver.com does not.
    modelRoughnessM: modelSurface(input.volume, domain.box, "SFCR"),
    weights: weights,
    derived: derived
  });
}

/** Roughly how much memory one prepared domain holds: the grid, the derivatives, the weights. */
function groundBytes(land) {
  return land.grid.width * land.grid.height * 4 +
    cache.derivedBytes(land.derived) +
    cache.weightsBytes(land.weights);
}

/**
 * A field service: terrain cached on the ground alone, atmosphere cached on
 * `(bbox, level set, valid time)`, and the arithmetic joining them per request.
 *
 * The two caches are separate because their lifetimes are: the ground under a
 * domain is the same next hour, and the wind over it is not. Keeping the static
 * half out of the hourly key is the whole reason an update is arithmetic.
 */
function createFieldService(opts) {
  const o = opts || {};
  const readTerrain = o.readTerrain || terrainModule.readTerrain;

  const atmosphere = o.atmosphere || cache.createHrrrVolumeSource(o);
  const ground = o.ground || cache.createTerrainSource(Object.assign({
    key: cache.weightsKey,
    sizeOf: groundBytes,
    load: async function (spec) {
      const read = await readTerrain(spec.box, spec);
      let grid = mosaic(read.grids, spec);
      let coarse = null;

      // A hole is not a rare event at 1 m: TNM reports the 1 m product as
      // covering Boulder in full and both projects over the north of a
      // two-mile box are nodata, because coverage is computed from tile
      // footprints and a void is a property of the pixels. A hole also costs
      // more than itself — every derivative within a curvature arm of it is
      // undefined — so any hole at all is worth one read of the coarser
      // product, which is a cache miss's cost and not a request's.
      if (grid.voidFraction > 0) {
        const only = dem.coarserThan(read.dataset ? read.dataset.id : null);
        if (only.length) {
          coarse = await readTerrain(spec.box, Object.assign({}, spec, { only: only }));
          grid = mosaic([grid].concat(coarse.grids), spec);
        }
      }

      const derived = derive.derive(grid, spec);
      return {
        dataset: read.dataset ? read.dataset.id : null,
        listing: read.listing || (coarse && coarse.listing) || null,
        coarserDataset: coarse && coarse.dataset ? coarse.dataset.id : null,
        filledFromCoarser: coarse ? grid.filledCount : 0,
        grid: grid,
        derived: derived,
        weights: downscale.terrainWeights(derived, spec),
        bytesRead: read.bytesRead + (coarse ? coarse.bytesRead : 0),
        requests: read.requests + (coarse ? coarse.requests : 0)
      };
    }
  }, o));

  /**
   * The ground alone: the same cache entry a wind solve uses, without the air.
   *
   * The two caches are separate so that the static half survives the hour, and
   * this is the half of that split that pays off — a caller who wants the
   * terrain (a hillshade, a slope map, a profile of the ridge) should not pay
   * for a NOMADS fetch to get it, and should not warm a second copy of the
   * derivatives beside the one the wind is already using. Asking for both over
   * the same box costs one terrain read between them, whichever arrives first.
   */
  async function terrain(spec) {
    const s = spec || {};
    const domain = domainOf(s);
    const resolutionM = s.targetResolutionM === undefined
      ? DEFAULT_TARGET_RESOLUTION_M
      : s.targetResolutionM;
    // Both names, because they are read by different halves: `readTerrain`
    // chooses an overview by `targetResolutionM`, and `weightsKey` files the
    // result under `resolutionM`. Setting only the first would file a 30 m
    // domain and a 1 m domain under the same key.
    const land = await ground.get(Object.assign({}, s, {
      box: domain.readBox,
      targetResolutionM: resolutionM,
      resolutionM: resolutionM,
      // The atmospheric half of the spec is dropped rather than passed
      // through: `level` here is a height above ground, and to `readWindow` it
      // is a COG overview index, so a request for the 10 m wind asks a tile
      // with five overviews for its eleventh.
      level: undefined,
      levels: undefined,
      variables: undefined,
      validTime: undefined
    }));
    return Object.assign({ domain: domain, resolutionM: resolutionM }, land);
  }

  async function get(spec) {
    const s = spec || {};
    const land = await terrain(s);
    const domain = land.domain;
    const air = Object.assign({}, s, {
      // A centre-sampled reference needs one point; a per-cell one needs the
      // model over the whole terrain grid, which is read wider than the box for
      // the derivatives. Asking for the padded box keeps the model's coverage
      // ahead of the grid's rather than leaving the margin to be holes.
      box: geo.expand(
        s.perCell ? domain.readBox : domain.box,
        (s.modelCellM === undefined ? MODEL_CELL_M : s.modelCellM) / geo.METERS_PER_MILE
      ),
      levels: s.levels || hrrr.DEFAULT_LEVEL_KEYS,
      variables: s.variables || DEFAULT_VARIABLES
    });
    const volume = s.validTime ? await atmosphere.get(air) : await atmosphere.getLatest(air);

    return assemble({
      spec: s,
      domain: domain,
      grid: land.grid,
      derived: land.derived,
      weights: land.weights,
      volume: volume,
      dataset: land.dataset,
      listing: land.listing,
      coarserDataset: land.coarserDataset,
      filledFromCoarser: land.filledFromCoarser,
      bytesRead: land.bytesRead,
      requests: land.requests
    });
  }

  return {
    get: get,
    terrain: terrain,
    ground: ground,
    atmosphere: atmosphere,
    summary: function () {
      return { ground: ground.summary(), atmosphere: atmosphere.summary() };
    }
  };
}

module.exports = {
  FIELD_VERSION,
  DEFAULT_RADIUS_MILES,
  DEFAULT_TARGET_RESOLUTION_M,
  DEFAULT_LEVEL,
  DEFAULT_VARIABLES,
  paddingMetres,
  domainOf,
  mosaic,
  heightOf,
  referenceWind,
  referenceGrid,
  modelElevation,
  modelSurface,
  groundBytes,
  assemble,
  createFieldService
};
