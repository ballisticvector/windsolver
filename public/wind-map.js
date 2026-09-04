/**
 * The arithmetic behind the map page, kept out of the page.
 *
 * Everything here is pure: a field answer in, numbers and strings out. The map
 * itself — Leaflet, the canvas, the DOM — is in `map.js`, which is not testable
 * without a browser. The parts that can be wrong in a way nobody sees on screen
 * live here instead, and are graded by `tests/wind-map.test.js`.
 *
 * Two rules this module exists to enforce.
 *
 * **A hole is a hole.** `/v1/field` returns `null` for a cell the terrain does
 * not cover, and the tempting thing is to draw it as calm — zero is a colour, a
 * blank is not. Calm air over ground we have never read is a lie the viewer
 * cannot detect, so `cellsOf` marks the cell uncovered and the page leaves it
 * empty.
 *
 * **The provenance is not decoration.** `summarise` is the only place the page
 * gets its caption from, and it always carries the source, the two resolutions
 * and the modelled notice. A page that can render a wind without them is a page
 * that will, on the day the panel is collapsed for space.
 */

"use strict";

const MPS_TO_MPH = 2.2369362920544;

// The colour ramp, in mph, chosen against the Beaufort boundaries a sailor or a
// hiker already reads rather than against an even split: calm, light, moderate,
// fresh, strong. Stops are inclusive lower bounds.
const SPEED_STOPS = [
  { mph: 0, color: "#2c7bb6", label: "0" },
  { mph: 4, color: "#00a6ca", label: "4" },
  { mph: 8, color: "#00ccbc", label: "8" },
  { mph: 13, color: "#90eb9d", label: "13" },
  { mph: 19, color: "#f9d057", label: "19" },
  { mph: 25, color: "#f29e2e", label: "25" },
  { mph: 32, color: "#e76818", label: "32" },
  { mph: 39, color: "#d7191c", label: "39" }
];

function mph(mps) {
  return mps === null || mps === undefined || !Number.isFinite(mps)
    ? null
    : mps * MPS_TO_MPH;
}

/**
 * The colour for a speed in m/s, or `null` for a cell with no wind in it.
 *
 * `null` rather than a default colour on purpose: the caller has to decide what
 * an unknown cell looks like, and cannot do it by accident.
 */
function speedColor(mps) {
  const speed = mph(mps);
  if (speed === null) return null;
  let color = SPEED_STOPS[0].color;
  for (const stop of SPEED_STOPS) {
    if (speed >= stop.mph) color = stop.color;
  }
  return color;
}

/**
 * The grid flattened into cells, each carrying where it is and whether it is
 * covered at all.
 *
 * `stride` thins the arrows without thinning the data: a 48 x 48 grid is 2,304
 * arrows, which is a smear rather than a map. The thinning is a display choice
 * and is reported, so the page can say the arrows are every nth cell.
 */
function cellsOf(grid, opts) {
  if (!grid || !Array.isArray(grid.lats) || !Array.isArray(grid.lons)) {
    throw new Error("cellsOf needs a grid with lats and lons");
  }
  const stride = Math.max(1, Math.round((opts && opts.stride) || 1));
  const cells = [];
  for (let r = 0; r < grid.rows; r += stride) {
    for (let c = 0; c < grid.cols; c += stride) {
      const i = r * grid.cols + c;
      const speedMps = grid.speedMps ? grid.speedMps[i] : null;
      const covered = Number.isFinite(speedMps);
      cells.push({
        row: r,
        col: c,
        lat: grid.lats[r],
        lon: grid.lons[c],
        covered: covered,
        speedMps: covered ? speedMps : null,
        speedMph: covered ? mph(speedMps) : null,
        fromDeg: covered ? grid.fromDeg[i] : null,
        eastMps: covered ? grid.eastMps[i] : null,
        northMps: covered ? grid.northMps[i] : null,
        elevationM: grid.elevationM && Number.isFinite(grid.elevationM[i])
          ? grid.elevationM[i]
          : null
      });
    }
  }
  return cells;
}

/** A stride that keeps the arrow count near a target the eye can read. */
function strideFor(grid, targetArrows) {
  const target = Math.max(1, targetArrows || 400);
  const cells = (grid.rows || 0) * (grid.cols || 0);
  if (cells <= target) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(cells / target)));
}

/** The lowest and highest ground in the grid, ignoring the holes. */
function elevationRange(grid) {
  let min = null;
  let max = null;
  const values = (grid && grid.elevationM) || [];
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { minM: min, maxM: max };
}

/** The wind at the pin: the covered cell nearest the centre of the grid. */
function centreWind(grid) {
  if (!grid || !grid.rows || !grid.cols) return null;
  const midR = (grid.rows - 1) / 2;
  const midC = (grid.cols - 1) / 2;
  let best = null;
  let bestD = Infinity;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (!Number.isFinite(grid.speedMps[i])) continue;
      const d = (r - midR) * (r - midR) + (c - midC) * (c - midC);
      if (d < bestD) {
        bestD = d;
        best = {
          lat: grid.lats[r],
          lon: grid.lons[c],
          speedMps: grid.speedMps[i],
          speedMph: mph(grid.speedMps[i]),
          fromDeg: grid.fromDeg[i],
          elevationM: Number.isFinite(grid.elevationM[i]) ? grid.elevationM[i] : null
        };
      }
    }
  }
  return best;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** A bearing as a compass point, for a caption rather than for arithmetic. */
function compassOf(deg) {
  if (!Number.isFinite(deg)) return null;
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[idx];
}

/**
 * The caption under the map.
 *
 * Always includes the source, both resolutions and the modelled notice — see
 * the header. `confidence` is reported as `unstated` rather than omitted when
 * the engine has no number for it, because a missing confidence and a high one
 * look the same on a screen that leaves it out.
 */
function summarise(body) {
  if (!body || !body.ok) throw new Error("summarise needs a successful field answer");
  const terrain = body.terrain || {};
  const reference = body.reference || {};
  const grid = body.grid || {};
  const elevation = elevationRange(grid);

  const lines = [];
  lines.push(body.source || "WindSolver");
  if (body.validTime) lines.push("Valid " + body.validTime);

  const resolutions = [];
  if (Number.isFinite(terrain.resolutionM)) {
    resolutions.push("terrain " + terrain.resolutionM + " m" +
      (terrain.dataset ? " (3DEP " + terrain.dataset + ")" : ""));
  }
  if (Number.isFinite(reference.resolutionM)) {
    resolutions.push("weather model " + reference.resolutionM + " m");
  }
  if (resolutions.length) lines.push(resolutions.join(", "));

  if (elevation.minM !== null) {
    lines.push("Ground " + Math.round(elevation.minM) + " to " +
      Math.round(elevation.maxM) + " m");
  }

  const covered = Number.isFinite(grid.coveredFraction) ? grid.coveredFraction : null;
  if (covered !== null && covered < 1) {
    lines.push(Math.round((1 - covered) * 100) + "% of this box has no terrain under it");
  }

  lines.push("Confidence: " +
    (body.confidence === undefined || body.confidence === null ? "unstated" : body.confidence));

  return {
    lines: lines,
    notice: body.notice || null,
    modelled: body.modelled === true
  };
}

/**
 * What went wrong, in the service's own words.
 *
 * The engine names its refusals and those names are the most useful thing it
 * produces, so the code is kept and a sentence is added — never replaced with
 * "something went wrong", and never with an invented cause.
 */
function explain(body, status) {
  const code = body && body.code ? body.code : null;
  const said = body && body.error ? body.error : null;

  const advice = {
    "timeout": "The first solve over new ground reads real terrain and pulls a live " +
      "weather cycle. It is still running — ask again in a moment and the answer " +
      "should come from the cache.",
    "busy": "WindSolver is already solving as much as this box can at once. Try again shortly.",
    "no-terrain": "No USGS 3DEP product covers this point well enough to solve on. " +
      "That can also mean The National Map is refusing requests right now.",
    "too-void": "The terrain here is mostly holes, so the ground under the wind is not known.",
    "no-cycle": "No HRRR cycle has published for this hour yet.",
    "bad-parameter": "The request was not accepted.",
    "too-many-cells": "That box at that resolution is more grid than this service returns."
  };

  const parts = [];
  if (said) parts.push(said);
  if (code && advice[code]) parts.push(advice[code]);
  if (!parts.length) {
    parts.push(status
      ? "WindSolver answered " + status + " and said nothing this page can read."
      : "WindSolver could not be reached.");
  }

  return {
    code: code,
    retryable: code === "timeout" || code === "busy" || code === "no-cycle" ||
      (Number.isFinite(status) && status >= 500),
    text: parts.join(" ")
  };
}

/** The `/v1/field` query for a pin, with the parameters the service names. */
function fieldQuery(spec) {
  const params = new URLSearchParams();
  params.set("lat", String(round(spec.lat, 6)));
  params.set("lon", String(round(spec.lon, 6)));
  params.set("radiusMiles", String(spec.radiusMiles));
  if (spec.cols) params.set("cols", String(Math.round(spec.cols)));
  if (spec.resolutionM) params.set("resolutionM", String(spec.resolutionM));
  return "/v1/field?" + params.toString();
}

function round(value, places) {
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

const api = {
  MPS_TO_MPH: MPS_TO_MPH,
  SPEED_STOPS: SPEED_STOPS,
  mph: mph,
  speedColor: speedColor,
  cellsOf: cellsOf,
  strideFor: strideFor,
  elevationRange: elevationRange,
  centreWind: centreWind,
  compassOf: compassOf,
  summarise: summarise,
  explain: explain,
  fieldQuery: fieldQuery
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WindMapLib = api;
