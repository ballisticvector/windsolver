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
 * The single model wind the whole domain is downscaled from.
 *
 * One wind, sampled at the domain's centre, because a 2-mile box is smaller
 * than one 3 km HRRR cell — there is no more information in the model to spend.
 * A domain large enough to span several cells needs a per-cell reference and
 * this function is where that would go; `cellsAcross` reports when that day has
 * arrived rather than leaving it to be discovered.
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
    cellsAcross: cellM ? spanM / cellM : null
  };
}

/** The model's own surface elevation over the domain, if the volume carries it. */
function modelElevation(volume, box) {
  if (!volume.scalars || !volume.scalars.HGT) return null;
  const centre = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
  try {
    return volumeModule.sampleScalar(volume, "HGT", centre.lat, centre.lon, "surface");
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
  const reference = referenceWind(input.volume, domain.box, spec);
  const field = downscale.downscale(weights, reference, Object.assign({}, spec, {
    heightAglM: reference.heightAglM
  }));

  const modelZ = modelElevation(input.volume, domain.box);

  return Object.assign({}, field, {
    schemaVersion: FIELD_VERSION,
    domain: domain.box,
    readBox: domain.readBox,
    paddingM: domain.paddingM,
    reference: reference,
    validTime: input.volume.validTime,
    terrain: {
      dataset: input.dataset || null,
      resolutionM: grid.resolutionM,
      spacingM: derived.spacingM,
      sources: grid.sources,
      voidFraction: grid.voidFraction,
      filledCount: grid.filledCount,
      coarserDataset: input.coarserDataset === undefined ? null : input.coarserDataset,
      filledFromCoarser: input.filledFromCoarser === undefined ? 0 : input.filledFromCoarser,
      bytesRead: input.bytesRead === undefined ? null : input.bytesRead,
      requests: input.requests === undefined ? null : input.requests
    },
    offset: modelZ === null ? null : downscale.terrainOffset(weights, modelZ),
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

  async function get(spec) {
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
    const air = Object.assign({}, s, {
      box: geo.expand(domain.box, (s.modelCellM === undefined ? MODEL_CELL_M : s.modelCellM) / geo.METERS_PER_MILE),
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
      coarserDataset: land.coarserDataset,
      filledFromCoarser: land.filledFromCoarser,
      bytesRead: land.bytesRead,
      requests: land.requests
    });
  }

  return {
    get: get,
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
  modelElevation,
  groundBytes,
  assemble,
  createFieldService
};
