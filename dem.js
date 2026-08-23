/**
 * Terrain discovery against the USGS National Map (3DEP).
 *
 * The point of this module is that **resolution is not a setting, it is a
 * finding**. 1 metre DEM comes from quality-level-2-or-better lidar and covers
 * a subset of the country; the seamless national product is 1/3 arc-second,
 * about 10 m. So we ask what actually exists over the domain, take the finest
 * product that genuinely covers it, and report which one we got. A UI that
 * hardcodes "1 m" is lying wherever the lidar has not been flown.
 *
 * Building a request and making one are kept apart: everything here except
 * `discover` is a pure function over URLs and JSON, so the selection logic can
 * be tested without touching the network.
 *
 * Dataset tags were read from the live /datasets endpoint, not from
 * documentation — they are matched verbatim by the API and a near-miss returns
 * an empty result rather than an error.
 */

"use strict";

const geo = require("./geo");

const TNM_PRODUCTS_URL = "https://tnmaccess.nationalmap.gov/api/v1/products";

/**
 * Finest first. `resolutionM` is nominal ground sample distance: arc-second
 * products vary with latitude, and 1/3 arc-second is ~10 m in latitude and
 * wider in longitude away from the equator.
 */
const DATASETS = [
  { id: "1m", tag: "Digital Elevation Model (DEM) 1 meter", resolutionM: 1, label: "1 metre DEM" },
  { id: "one-ninth", tag: "National Elevation Dataset (NED) 1/9 arc-second", resolutionM: 3, label: "1/9 arc-second DEM" },
  { id: "ifsar-5m", tag: "Alaska IFSAR 5 meter DEM", resolutionM: 5, label: "5 metre IFSAR (Alaska)" },
  { id: "one-third", tag: "National Elevation Dataset (NED) 1/3 arc-second", resolutionM: 10, label: "1/3 arc-second DEM" }
];

function datasetById(id) {
  return DATASETS.filter(function (d) { return d.id === id; })[0] || null;
}

/** Query URL for one dataset over one box. */
function productsUrl(datasetTag, box, opts) {
  const o = opts || {};
  const params = new URLSearchParams();
  params.set("datasets", datasetTag);
  params.set("bbox", geo.bboxParam(box));
  params.set("max", String(o.max === undefined ? 50 : o.max));
  if (o.offset) params.set("offset", String(o.offset));
  if (o.prodFormats) params.set("prodFormats", o.prodFormats);
  return TNM_PRODUCTS_URL + "?" + params.toString();
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** TNM's boundingBox uses minX/maxX/minY/maxY; normalise to our named box. */
function toBox(bb) {
  if (!bb) return null;
  const west = num(bb.minX);
  const east = num(bb.maxX);
  const south = num(bb.minY);
  const north = num(bb.maxY);
  if (west === null || east === null || south === null || north === null) return null;
  return { west: west, south: south, east: east, north: north };
}

/**
 * Normalise a /products response. Items without a usable footprint are dropped
 * rather than kept with a null box — a tile we cannot place cannot be counted
 * towards coverage, and silently counting it would overstate what we have.
 */
function parseProducts(json) {
  const items = (json && json.items) || [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const box = toBox(it.boundingBox);
    if (!box) continue;
    out.push({
      title: String(it.title || ""),
      sourceId: it.sourceId || null,
      format: it.format || null,
      downloadUrl: it.downloadURL || it.urls && it.urls.TIFF || null,
      box: box,
      publicationDate: it.publicationDate || it.lastUpdated || null,
      sizeBytes: num(it.sizeInBytes)
    });
  }
  return { total: num(json && json.total) || out.length, items: out };
}

/**
 * The same ground gets re-flown, and TNM returns every vintage — the 1/3
 * arc-second query for a single point comes back with several, some under a
 * /historical/ path. Keep the newest per footprint, so coverage is not inflated
 * by counting one tile three times and so we do not download superseded terrain.
 */
function newestPerFootprint(items) {
  const byKey = new Map();
  for (const item of items) {
    const b = item.box;
    const key = [b.west, b.south, b.east, b.north].map(function (v) { return v.toFixed(4); }).join(",");
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, item);
      continue;
    }
    const a = Date.parse(item.publicationDate || "") || 0;
    const b2 = Date.parse(seen.publicationDate || "") || 0;
    if (a > b2) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

/**
 * Whole-tile download size for a selection.
 *
 * Reported because it is startling and load bearing. A 4-mile display domain
 * with a 12-mile buffer covers about 16 x 16 miles, and at 1 m that is twelve
 * 10 km tiles — measured live at roughly **3 GB** for one coordinate. The
 * droplet's 120 GB disk holds forty of those.
 *
 * So whole-tile fetching is not the plan. The tiles are GeoTIFFs on S3 and the
 * bucket answers range requests with 206, so the window a domain actually needs
 * can be read without pulling the tile. Confirm the files are internally tiled
 * (a real COG) before relying on that: a stripped TIFF technically supports
 * ranges while still forcing you to read most of the file to get a window.
 *
 * This is also the argument the design document already makes from the other
 * direction — 1 m terrain does not imply a 1 m computational mesh. Keep the
 * source resolution for display and resample to 10-20 m for the solver.
 */
function totalBytes(tiles) {
  return (tiles || []).reduce(function (sum, t) { return sum + (t.sizeBytes || 0); }, 0);
}

/**
 * Pick a dataset from what each one returned.
 *
 * Finest wins, but only if it covers enough of the domain. Partial 1 m over a
 * domain is worse than complete 1/3 arc-second: the seam between a lidar tile
 * and whatever fills the gap is a step in the terrain, and a step in the
 * terrain is a wind feature the mountain does not have.
 *
 * `availability` is [{ datasetId, items }]; returns null when nothing covers it.
 */
function selectDataset(availability, box, opts) {
  const o = opts || {};
  const minCoverage = o.minCoverage === undefined ? 0.999 : o.minCoverage;
  const considered = [];

  for (const dataset of DATASETS) {
    const entry = (availability || []).filter(function (a) { return a.datasetId === dataset.id; })[0];
    if (!entry || !entry.items || entry.items.length === 0) {
      considered.push({ datasetId: dataset.id, resolutionM: dataset.resolutionM, coverage: 0, tileCount: 0 });
      continue;
    }
    const tiles = newestPerFootprint(entry.items).filter(function (t) { return geo.intersects(t.box, box); });
    const coverage = geo.coverageFraction(box, tiles.map(function (t) { return t.box; }), o.coverageSteps);
    considered.push({
      datasetId: dataset.id,
      resolutionM: dataset.resolutionM,
      coverage: coverage,
      tileCount: tiles.length
    });
    if (coverage >= minCoverage) {
      return {
        dataset: dataset,
        tiles: tiles,
        coverage: coverage,
        downloadBytes: totalBytes(tiles),
        considered: considered
      };
    }
  }
  return { dataset: null, tiles: [], coverage: 0, downloadBytes: 0, considered: considered };
}

/**
 * Discover the best available terrain over a domain.
 *
 * `fetchJson(url)` is injected so the selection logic above stays testable with
 * no network and no mocking library. Datasets are queried finest-first and the
 * loop stops as soon as one covers the domain, so the common case does not ask
 * The National Map four times.
 */
async function discover(box, fetchJson, opts) {
  const o = opts || {};
  const availability = [];
  const minCoverage = o.minCoverage === undefined ? 0.999 : o.minCoverage;

  for (const dataset of DATASETS) {
    if (o.only && o.only.indexOf(dataset.id) === -1) continue;
    let parsed = { total: 0, items: [] };
    try {
      parsed = parseProducts(await fetchJson(productsUrl(dataset.tag, box, { max: o.max })));
    } catch (err) {
      // One dataset failing must not fail discovery: a coarser product is a
      // usable answer, and no terrain at all is not.
      availability.push({ datasetId: dataset.id, items: [], error: String(err && err.message || err) });
      continue;
    }
    availability.push({ datasetId: dataset.id, items: parsed.items });

    const tiles = newestPerFootprint(parsed.items).filter(function (t) { return geo.intersects(t.box, box); });
    if (geo.coverageFraction(box, tiles.map(function (t) { return t.box; }), o.coverageSteps) >= minCoverage) break;
  }

  return selectDataset(availability, box, o);
}

module.exports = {
  TNM_PRODUCTS_URL,
  DATASETS,
  datasetById,
  productsUrl,
  parseProducts,
  newestPerFootprint,
  totalBytes,
  selectDataset,
  discover
};
