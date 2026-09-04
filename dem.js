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
 * The grid the listing query is snapped out onto, in degrees.
 *
 * The listing is the expensive question — 29 s measured, and 504 for minutes at
 * a time — and it is asked with a bbox, so two pins a hundred metres apart ask
 * two different questions and share nothing. Snapping the *query* onto a grid
 * makes them one question with one answer, which is what gives the disk cache
 * in `listing.js` anything to hit.
 *
 * 0.05° is about 5.5 km north-south: small enough that the answer is still a
 * handful of tiles, large enough that a neighbourhood shares an entry. Widening
 * the query cannot widen the *answer*, because coverage is still measured
 * against the box that was asked for and tiles are still filtered to it — a
 * bigger query returns a superset, never a different set.
 */
const DEFAULT_LISTING_SNAP_DEG = 0.05;

/**
 * Pages of listing fetched before a query is called truncated.
 *
 * TNM caps `max` at 100 per page. Four pages is 400 footprints over a snapped
 * box, which is far past the ~30 vintages the busiest ground returns; a query
 * still full at that point is not a listing worth paging through.
 */
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_PAGE_SIZE = 100;

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

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

/**
 * The dataset ids coarser than the one given, finest first.
 *
 * For the caller that has read the best product and found holes in it: the
 * next product down is the one with real ground where this one has none. An
 * unknown id means "try them all", since a caller with no dataset to be
 * coarser than has nothing to lose by looking.
 */
function coarserThan(id) {
  const from = datasetById(id);
  return DATASETS
    .filter(function (d) { return !from || d.resolutionM > from.resolutionM; })
    .map(function (d) { return d.id; });
}

function sameBox(a, b) {
  return a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north;
}

/**
 * The box a listing is actually asked for: `box`, snapped outward.
 *
 * `snapDeg: 0` asks for the box exactly, which is what a caller wants when it
 * is looking for what TNM says about this domain rather than this neighbourhood.
 */
function listingBox(box, snapDeg) {
  const step = snapDeg === undefined ? DEFAULT_LISTING_SNAP_DEG : snapDeg;
  if (!step) return box;
  return geo.snapBoxOut(box, step);
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
 * Whether a listed product is one the terrain reader can take a window out of.
 *
 * 3DEP is not uniformly GeoTIFF. 1/9 arc-second is published as a zipped ERDAS
 * IMG — `.zip`, 118 MB for one 15-minute cell over Boulder — and the archive
 * cannot be range-read at all: the reader gets the ZIP magic where it expected
 * a TIFF header. Measured live against KBDU, 2026-09-04.
 *
 * The extension is the test rather than `format`, because the format field is
 * the product's name for itself ("IMG", "GeoTIFF") while the URL is what will
 * actually be fetched, and the two disagree on the historical entries.
 */
function windowable(url) {
  return typeof url === "string" && /\.tiff?($|\?)/i.test(url);
}

/**
 * Normalise a /products response. Items without a usable footprint are dropped
 * rather than kept with a null box — a tile we cannot place cannot be counted
 * towards coverage, and silently counting it would overstate what we have.
 *
 * Products that cannot be windowed are dropped the same way and counted in
 * `unreadable`. Keeping them would let a dataset win on resolution and then
 * fail at the far end of a cold solve, where the only symptom is a reader
 * complaining about bytes it was handed.
 */
function parseProducts(json) {
  const items = (json && json.items) || [];
  const out = [];
  let unreadable = 0;
  // How many the page really held, which is not `out.length` once footprintless
  // items are dropped and not `total` either. It is the only number that says
  // whether the page was full, and therefore whether there is another one.
  const returned = items.length;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const box = toBox(it.boundingBox);
    if (!box) continue;
    const downloadUrl = it.downloadURL || it.urls && it.urls.TIFF || null;
    if (downloadUrl !== null && !windowable(downloadUrl)) {
      unreadable++;
      continue;
    }
    out.push({
      title: String(it.title || ""),
      sourceId: it.sourceId || null,
      format: it.format || null,
      downloadUrl: downloadUrl,
      box: box,
      publicationDate: it.publicationDate || it.lastUpdated || null,
      sizeBytes: num(it.sizeInBytes)
    });
  }
  return {
    total: num(json && json.total) || out.length,
    returned: returned,
    unreadable: unreadable,
    items: out
  };
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
 * Every footprint TNM lists for one dataset over one box, paging until the
 * pages stop coming back full.
 *
 * The old single request with `max=50` was a silent truncation: a box over
 * ground that has been flown five times returns more than fifty footprints,
 * the fifty-first onwards were never seen, and the coverage computed from the
 * rest came back *low* — reported as "1m 40% covered" and fell through to a
 * coarser product, or to no terrain at all. A wrong answer with no symptom.
 *
 * `truncated` says the last page was still full, so the list is known to be
 * incomplete and any coverage figure from it is a lower bound. It is reported
 * rather than thrown, because a lower bound that already clears the threshold
 * is a perfectly good answer.
 */
async function fetchListing(datasetTag, box, fetchJson, opts) {
  const o = opts || {};
  const pageSize = o.max === undefined ? DEFAULT_PAGE_SIZE : o.max;
  const maxPages = o.maxPages === undefined ? DEFAULT_MAX_PAGES : o.maxPages;
  const items = [];
  let pages = 0;
  let unreadable = 0;

  for (let page = 0; page < maxPages; page++) {
    const parsed = parseProducts(await fetchJson(productsUrl(datasetTag, box, {
      max: pageSize,
      offset: page * pageSize,
      prodFormats: o.prodFormats
    })));
    pages++;
    unreadable += parsed.unreadable;
    for (const item of parsed.items) items.push(item);
    if (parsed.returned < pageSize) {
      return { items: items, truncated: false, pages: pages, unreadable: unreadable };
    }
  }

  return { items: items, truncated: true, pages: pages, unreadable: unreadable };
}

/**
 * Whole-tile download size for a selection.
 *
 * Reported because it is startling and load bearing. A 4-mile display domain
 * with a 12-mile buffer covers about 16 x 16 miles, and at 1 m that is twelve
 * 10 km tiles — measured live at roughly **3 GB** for one coordinate. The
 * droplet's 120 GB disk holds forty of those.
 *
 * So whole-tile fetching is not the plan, and it does not have to be. The
 * bucket answers range requests with 206, and every tile measured so far is a
 * Cloud Optimized GeoTIFF — directory at byte 192, 512 x 512 internal tiles,
 * five overview levels, on 12 of 12 one-metre and 8 of 8 ten-metre tiles across
 * six states (`node tools/cog-survey.js`). A domain's window is one round trip.
 *
 * Layout is a property of the conversion rather than of the product, though,
 * and 3DEP is thousands of separately converted lidar projects. A directory at
 * the end of the file is legal and still windowable; it costs one extra range
 * request to find. A reader that assumes otherwise silently pulls whole tiles,
 * which is what this figure exists to make visible.
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
 * `availability` is [{ datasetId, items, error, truncated }]; returns null when
 * nothing covers it.
 */
function selectDataset(availability, box, opts) {
  const o = opts || {};
  const minCoverage = o.minCoverage === undefined ? 0.999 : o.minCoverage;
  const considered = [];

  for (const dataset of DATASETS) {
    const entry = (availability || []).filter(function (a) { return a.datasetId === dataset.id; })[0];
    if (!entry || !entry.items || entry.items.length === 0) {
      considered.push({
        datasetId: dataset.id,
        resolutionM: dataset.resolutionM,
        coverage: 0,
        tileCount: 0,
        unreadable: (entry && entry.unreadable) || 0,
        error: (entry && entry.error) || null
      });
      continue;
    }
    const tiles = newestPerFootprint(entry.items).filter(function (t) { return geo.intersects(t.box, box); });
    const coverage = geo.coverageFraction(box, tiles.map(function (t) { return t.box; }), o.coverageSteps);
    considered.push({
      datasetId: dataset.id,
      resolutionM: dataset.resolutionM,
      coverage: coverage,
      tileCount: tiles.length,
      // Products listed over this box that no reader can window. A dataset
      // reported as absent while this is non-zero is present and unusable,
      // which is a different sentence about the country.
      unreadable: entry.unreadable || 0,
      // A truncated listing makes coverage a lower bound, so falling short of
      // it is "we did not see the whole list" rather than "the tiles are not
      // there". Passing it as an error keeps those two apart in the refusal;
      // clearing it once coverage is met keeps it out of a successful answer,
      // where the unseen remainder cannot change the outcome.
      error: entry.truncated && coverage < minCoverage
        ? "the listing was longer than we read, so this figure is a lower bound"
        : null
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

  // Every dataset failing identically is swallowed by the per-dataset guard
  // below and comes back as "no 3DEP over this box", which is a sentence about
  // the country rather than about the caller. A missing fetcher fails that way.
  if (typeof fetchJson !== "function") {
    throw fail("no-fetch", "discovery needs a fetchJson(url) to ask The National Map with");
  }

  const query = listingBox(box, o.listingSnapDeg);

  for (const dataset of DATASETS) {
    if (o.only && o.only.indexOf(dataset.id) === -1) continue;
    let listing;
    try {
      listing = await fetchListing(dataset.tag, query, fetchJson, o);
      // A full last page means the widened query, not the domain, is what
      // filled it. Ask for the box itself before calling the list truncated:
      // the narrower question is the one the answer is actually needed for.
      if (listing.truncated && !sameBox(query, box)) {
        listing = await fetchListing(dataset.tag, box, fetchJson, o);
      }
    } catch (err) {
      // One dataset failing must not fail discovery: a coarser product is a
      // usable answer, and no terrain at all is not.
      availability.push({ datasetId: dataset.id, items: [], error: String(err && err.message || err) });
      continue;
    }
    availability.push({
      datasetId: dataset.id,
      items: listing.items,
      truncated: listing.truncated,
      unreadable: listing.unreadable
    });

    const tiles = newestPerFootprint(listing.items).filter(function (t) { return geo.intersects(t.box, box); });
    if (geo.coverageFraction(box, tiles.map(function (t) { return t.box; }), o.coverageSteps) >= minCoverage) break;
  }

  return selectDataset(availability, box, o);
}

module.exports = {
  TNM_PRODUCTS_URL,
  DEFAULT_LISTING_SNAP_DEG,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
  DATASETS,
  windowable,
  listingBox,
  fetchListing,
  datasetById,
  coarserThan,
  productsUrl,
  parseProducts,
  newestPerFootprint,
  totalBytes,
  selectDataset,
  discover
};
