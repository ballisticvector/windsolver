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
 *
 * **A measurement is not a model output, and the page may not blur them.** The
 * station half of this module — `stationView`, `compareStationToField` — draws
 * the only thing on the map that was measured by an instrument, and every way
 * of getting it wrong is a claim rather than a pixel: a station that reported
 * nothing drawn as calm, an hour-old reading drawn as now, an hour *label*
 * drawn as an observation time, a 6.1 m anemometer compared with a 10 m model
 * wind without saying so. Each of those is refused here rather than in `map.js`,
 * because a claim that can only be checked by looking at the screen is a claim
 * nobody checks.
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

  // Two decimals: a resampled spacing is 7.996805191693154 m in the payload,
  // and the digits past the centimetre are arithmetic rather than information.
  const resolutions = [];
  if (Number.isFinite(terrain.resolutionM)) {
    resolutions.push("terrain " + round(terrain.resolutionM, 2) + " m" +
      (terrain.dataset ? " (3DEP " + terrain.dataset + ")" : ""));
  }
  if (Number.isFinite(reference.resolutionM)) {
    resolutions.push("weather model " + round(reference.resolutionM, 2) + " m");
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

/**
 * The `/v1/hillshade` query for the same pin the field is solved over.
 *
 * Deliberately the same `lat`/`lon`/`radiusMiles` the field call uses: the two
 * pictures are drawn on top of each other, and a hillshade over a box half a
 * mile off the wind is a mis-registration nobody looking at the screen can
 * detect.
 */
function hillshadeQuery(spec) {
  const params = new URLSearchParams();
  params.set("lat", String(round(spec.lat, 6)));
  params.set("lon", String(round(spec.lon, 6)));
  params.set("radiusMiles", String(spec.radiusMiles));
  if (spec.width) params.set("width", String(Math.round(spec.width)));
  if (spec.azimuthDeg !== undefined) params.set("azimuthDeg", String(spec.azimuthDeg));
  if (spec.altitudeDeg !== undefined) params.set("altitudeDeg", String(spec.altitudeDeg));
  return "/v1/hillshade?" + params.toString();
}

/**
 * Where a hillshade PNG goes, read off the headers rather than off the request.
 *
 * The service snaps and pads the box it was asked for, so the picture covers
 * the domain it solved and not the query. Placing it on the requested box
 * shifts the terrain under the wind by the padding — a few hundred metres of
 * hillside that lines up with nothing, and looks like a plausible map.
 *
 * Returns `null` rather than a guess when the headers are missing or
 * unreadable, so a caller cannot place an image by accident.
 */
function hillshadePlacement(headers) {
  const get = function (name) {
    if (!headers) return null;
    const v = typeof headers.get === "function" ? headers.get(name) : headers[name];
    return v === undefined ? null : v;
  };

  const bounds = String(get("x-windsolver-bounds") || "").split(",").map(Number);
  if (bounds.length !== 4 || bounds.some(function (n) { return !Number.isFinite(n); })) {
    return null;
  }
  if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) return null;

  // `Number(null)` is 0, and 0 here is "none of this box has terrain under it"
  // — a caption that indicts the data because a header was absent.
  const number = function (name) {
    const raw = get(name);
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const covered = number("x-windsolver-covered");
  const resolutionM = number("x-windsolver-resolution-m");
  return {
    south: bounds[0],
    west: bounds[1],
    north: bounds[2],
    east: bounds[3],
    coveredFraction: covered,
    resolutionM: resolutionM,
    dataset: get("x-windsolver-terrain-dataset") || null
  };
}

/** The caption under the relief toggle, in the words the headers support. */
function hillshadeCaption(placement) {
  if (!placement) return "Relief unavailable.";
  const parts = ["Shaded relief"];
  if (placement.dataset) parts.push("3DEP " + placement.dataset);
  if (placement.resolutionM !== null) parts.push(round(placement.resolutionM, 1) + " m/px");
  if (placement.coveredFraction !== null && placement.coveredFraction < 1) {
    // The transparent part of the picture is ground nobody read, and it looks
    // exactly like ground that happens to be flat.
    parts.push(Math.round((1 - placement.coveredFraction) * 100) + "% no terrain");
  }
  return parts.join(" · ");
}

/**
 * The `/v1/stations` query for what is on screen.
 *
 * Not the solve box: the field is a mile across by default and RAWS are about
 * one per 1,500 square miles, so a station search over the solve box is an
 * empty map almost everywhere. What a viewer wants is the anemometers they can
 * see, so this asks about the *view* — and caps it, because a whole-country
 * view is a dataset rather than a map layer.
 */
function stationsQuery(spec) {
  const params = new URLSearchParams();
  params.set("lat", String(round(spec.lat, 6)));
  params.set("lon", String(round(spec.lon, 6)));
  params.set("radiusMiles", String(round(spec.radiusMiles, 2)));
  if (spec.limit) params.set("limit", String(Math.round(spec.limit)));
  if (spec.observed === false) params.set("observed", "false");
  return "/v1/stations?" + params.toString();
}

/** The centre and a radius in miles that covers a lat/lon box. */
function viewSpec(bounds, opts) {
  const o = opts || {};
  const maxMiles = o.maxMiles === undefined ? 250 : o.maxMiles;
  const minMiles = o.minMiles === undefined ? 5 : o.minMiles;
  const lat = (bounds.north + bounds.south) / 2;
  const lon = (bounds.east + bounds.west) / 2;
  // Half the diagonal, so the corners of the view are inside the circle the
  // box is cut from: a station in the corner of the screen is on the screen.
  const halfLatM = ((bounds.north - bounds.south) / 2) * 111132.92;
  const halfLonM = ((bounds.east - bounds.west) / 2) * 111132.92 *
    Math.cos((lat * Math.PI) / 180);
  const miles = Math.hypot(halfLatM, halfLonM) / 1609.344;
  return {
    lat: lat,
    lon: lon,
    radiusMiles: Math.min(maxMiles, Math.max(minMiles, miles)),
    capped: miles > maxMiles
  };
}

// Past this an observation is not "now" any more. A RAWS reports hourly and
// misses hours, so an hour is normal and two is a station worth doubting.
const STALE_OBSERVATION_S = 5400;

/** "42 minutes ago", for a caption. Never a bare timestamp on a marker. */
function ageText(seconds) {
  if (!Number.isFinite(seconds)) return "age unknown";
  if (seconds < 0) return "in the future";
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "just now";
  if (mins < 90) return mins + " min ago";
  const hours = Math.round(seconds / 3600);
  if (hours < 36) return hours + " h ago";
  return Math.round(seconds / 86400) + " days ago";
}

/**
 * How one station should be drawn, and what it is allowed to claim.
 *
 * Pure, and separate from Leaflet, because every mistake worth making here is
 * a claim rather than a pixel: a station with no observation drawn as calm, an
 * hour-old reading drawn as current, an hour *bin* drawn as a time. The page
 * gets its marker, its caption and its popup from this and cannot assemble a
 * different story.
 */
function stationView(station, opts) {
  const o = opts || {};
  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const obs = station && station.observation;

  const view = {
    id: station.id,
    name: station.name || station.id,
    lat: station.lat,
    lon: station.lon,
    // The measured wind, or nothing. There is no third state, and in
    // particular no zero: `reporting: false` is why the marker is hollow.
    reporting: false,
    calm: false,
    speedMps: null,
    speedMph: null,
    fromDeg: null,
    towardDeg: null,
    gustMph: null,
    color: null,
    ageS: null,
    stale: false,
    approximateTime: false,
    unchecked: false,
    lines: [],
    title: null
  };

  const place = [];
  if (Number.isFinite(station.elevationM)) place.push(Math.round(station.elevationM) + " m");
  if (station.state) place.push(station.state);
  view.lines.push((station.network || "station") + " " + station.id +
    (place.length ? " · " + place.join(" · ") : ""));

  if (!obs) {
    view.title = view.name + " — not reporting";
    view.lines.push("No observation in the window" +
      (station.observationNote ? " — " + station.observationNote : "") + ".");
    // The one thing a blank must never become. FEMS answers an unknown
    // station, a dead station and a quiet hour with the same empty row.
    view.lines.push("Not calm: nothing was measured.");
    return view;
  }

  view.reporting = true;
  view.calm = obs.calm === true;
  view.speedMps = obs.speedMps;
  view.speedMph = mph(obs.speedMps);
  view.fromDeg = obs.fromDeg;
  view.towardDeg = Number.isFinite(obs.fromDeg) ? (obs.fromDeg + 180) % 360 : null;
  view.gustMph = mph(obs.gustMps);
  view.color = speedColor(obs.speedMps);
  view.ageS = Number.isFinite(obs.ageS)
    ? obs.ageS
    : (obs.time ? Math.round((nowMs - Date.parse(obs.time)) / 1000) : null);
  view.stale = Number.isFinite(view.ageS) && view.ageS > STALE_OBSERVATION_S;
  view.approximateTime = obs.timeIsHourBin === true;
  view.unchecked = obs.qcChecked !== true;

  const speed = view.speedMph === null ? "—" : view.speedMph.toFixed(1) + " mph";
  const dir = view.calm
    ? "calm"
    : (Number.isFinite(obs.fromDeg)
      ? "from " + Math.round(obs.fromDeg) + "\u00b0 " + compassOf(obs.fromDeg)
      : "direction not reported");
  view.title = view.name + " — measured " + speed + ", " + dir;

  view.lines.push("Measured " + speed + ", " + dir +
    (view.gustMph === null ? "" : ", gusting " + view.gustMph.toFixed(1)));
  view.lines.push(ageText(view.ageS) + (obs.time ? " (" + obs.time + ")" : "") +
    // The label is the nearest whole hour for every station without a measured
    // transmit minute, so the marker's time can be half an hour out. Saying so
    // costs a line; not saying so turns a timing error into a wind error.
    (view.approximateTime ? " · hour label, ±30 min" : ""));
  if (view.unchecked) view.lines.push("Not quality-controlled yet.");
  return view;
}

/**
 * The measured wind beside the modelled wind at the same place.
 *
 * This is the reason the two layers are on one map: `docs/downscaling.md` says
 * HRRR runs 43-70% fast over this network, and a ratio printed next to the
 * arrow is that sentence in a form nobody has to take on trust.
 *
 * It refuses far more often than it answers, and every refusal is named. The
 * station has to be inside the solved box and on a covered cell; the two have
 * to be close in time; and the heights have to be comparable — a RAWS
 * anemometer is nominally 6.1 m and the field is reported at its own
 * `heightAglM`, so comparing them without saying so invents part of the
 * difference it is measuring.
 */
function compareStationToField(view, body, opts) {
  const o = opts || {};
  const maxGapS = o.maxGapS === undefined ? 3600 : o.maxGapS;
  const out = { comparable: false, reason: null, modelSpeedMph: null, ratio: null,
    directionDeltaDeg: null, heightNote: null };

  if (!view || !view.reporting) {
    out.reason = "the station reported nothing";
    return out;
  }
  if (!body || !body.ok || !body.grid) {
    out.reason = "nothing has been solved here yet";
    return out;
  }
  const grid = body.grid;
  if (view.lat > grid.lats[0] || view.lat < grid.lats[grid.rows - 1] ||
      view.lon < grid.lons[0] || view.lon > grid.lons[grid.cols - 1]) {
    out.reason = "the station is outside the solved box";
    return out;
  }

  const row = nearestIndex(grid.lats, view.lat);
  const col = nearestIndex(grid.lons, view.lon);
  const i = row * grid.cols + col;
  const modelSpeed = grid.speedMps ? grid.speedMps[i] : null;
  if (!Number.isFinite(modelSpeed)) {
    out.reason = "no terrain under the station, so nothing was solved there";
    return out;
  }

  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const gapS = body.validTime && view.ageS !== null
    ? Math.abs(Math.round((nowMs - Date.parse(body.validTime)) / 1000) - view.ageS)
    : null;
  if (gapS !== null && gapS > maxGapS) {
    out.reason = "the observation and the model hour are " + ageText(gapS).replace(" ago", "") +
      " apart";
    return out;
  }

  out.comparable = true;
  out.timeGapS = gapS;
  out.modelSpeedMph = mph(modelSpeed);
  out.ratio = view.speedMps > 0 ? modelSpeed / view.speedMps : null;
  if (Number.isFinite(view.fromDeg) && Number.isFinite(grid.fromDeg[i])) {
    out.directionDeltaDeg = signedDegrees(grid.fromDeg[i] - view.fromDeg);
  }
  // Not a caveat that can be dropped for space: the model is reported at its
  // own height and a RAWS anemometer is nominally 6.1 m, and the wind between
  // those two heights differs by more than most of the terms being argued
  // about.
  out.heightNote = "model at " +
    (Number.isFinite(body.heightAglM) ? body.heightAglM + " m" : "its own height") +
    " AGL, RAWS nominally 6.1 m — not height-matched";
  return out;
}

function nearestIndex(values, target) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < values.length; i++) {
    const d = Math.abs(values[i] - target);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** A difference of bearings in -180..180, so "17° right" survives 350 vs 7. */
function signedDegrees(delta) {
  return ((((delta % 360) + 540) % 360) - 180);
}

/** The line under the stations toggle: how many, from where, and how old. */
function stationsCaption(body) {
  if (!body || !body.ok) return "Stations unavailable.";
  const parts = [];
  const empty = body.matched === 0;
  parts.push(empty
    ? "No stations in this view"
    : body.returned + " of " + body.matched +
      (body.matched === 1 ? " station" : " stations"));
  if (body.directory && body.directory.network) {
    parts.push(body.directory.network +
      (body.directory.provider ? " via " + body.directory.provider : ""));
  }
  // "locations only" is about the observations of stations that are here; with
  // none in view it describes nothing and only reads as a fault.
  if (!body.observed && !empty) {
    parts.push("locations only — no observations read");
  }
  if (body.directory && body.directory.stale) {
    // The retained-directory case, said out loud. An old list quietly served as
    // a current one is the failure `docs/history.md` exists to refuse.
    parts.push("station list is " + ageText(body.directory.ageS) +
      " and could not be refreshed");
  }
  for (const err of body.errors || []) parts.push(err.error);
  return parts.join(" · ");
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
  fieldQuery: fieldQuery,
  hillshadeQuery: hillshadeQuery,
  hillshadePlacement: hillshadePlacement,
  hillshadeCaption: hillshadeCaption,
  STALE_OBSERVATION_S: STALE_OBSERVATION_S,
  stationsQuery: stationsQuery,
  viewSpec: viewSpec,
  ageText: ageText,
  stationView: stationView,
  compareStationToField: compareStationToField,
  signedDegrees: signedDegrees,
  stationsCaption: stationsCaption
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WindMapLib = api;
