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
 *
 * **The disagreement gets its own scale, and it is a different kind of scale.**
 * `ratioColor` colours a station by model ÷ measured rather than by speed,
 * because the thing worth seeing on this map is not that the wind is 12 mph, it
 * is that the model thinks it is 20 where the anemometer says 12 —
 * `docs/downscaling.md` measures exactly that over 68 stations and four dates.
 * The ramp diverges through white at agreement, so it cannot be confused with
 * the sequential speed ramp beside it, and it refuses to colour anything
 * `compareStationToModel` will not certify: a station with no observation, no
 * model sample, an hour that does not match, or a calm reading — which has no
 * ratio at all, because dividing by nothing is not a large number.
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

/**
 * The disagreement ramp: model speed ÷ measured speed, at the station.
 *
 * Diverging rather than sequential, and through near-white at agreement, for
 * two reasons. A reader has to be able to see "these two agree" as an absence
 * of colour rather than as a colour to be looked up, and the ramp shares no
 * hue with `SPEED_STOPS` — which is a sequential blue-green-yellow-red — so a
 * marker cannot be misread as a speed. Stops are inclusive lower bounds; the
 * band from 0.9 to 1.1 is the one that means "nothing to see here".
 */
const RATIO_STOPS = [
  { ratio: 0, color: "#00429d", label: "0.6×" },
  { ratio: 0.6, color: "#4771b2", label: "0.6" },
  { ratio: 0.8, color: "#8fa9cd", label: "0.8" },
  { ratio: 0.9, color: "#e8e8e8", label: "agree" },
  { ratio: 1.1, color: "#d99caa", label: "1.1" },
  { ratio: 1.3, color: "#c26076", label: "1.3" },
  { ratio: 1.6, color: "#a52a4c", label: "1.6" },
  { ratio: 2, color: "#93003a", label: "2×" }
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

/**
 * How long each arrow is drawn, given the speeds actually on screen.
 *
 * Until this existed every arrow was the same length and speed reached the eye
 * only as the colour wash, so the one quantity that varies usefully across a
 * two-mile box — ±15% at Boulder, ±25% at Big Thompson — was the one quantity
 * nobody could see. Length is the channel the eye reads ratios in; colour is
 * the channel it reads bands in. They now say the same thing twice.
 *
 * Three decisions worth keeping:
 *
 * **The full-length speed is a stop on the speed legend, not the field's own
 * maximum.** Normalising to the maximum would rescale every arrow on the map
 * each time the view moved over a gust, so an arrow's length would mean
 * something different from one pan to the next while looking identical. Pinned
 * to the legend it changes rarely, in visible steps, and the caption names it.
 *
 * **Below `floorMph` the length stops meaning anything.** A 0.5 mph arrow drawn
 * to scale is a dot, which reads as "no data" — and no data is a hole, which
 * this map refuses to fake. So short arrows clamp to a stub, and the caption
 * says at what speed that starts, because an unstated floor is a lie about the
 * bottom of the range.
 *
 * **A hole gets `null`, never the stub.** Same rule as `speedColor`: the caller
 * has to decide what an unknown cell looks like and cannot do it by accident.
 */
function arrowScale(cells, opts) {
  const o = opts || {};
  const maxPx = Number.isFinite(o.maxPx) ? o.maxPx : 26;
  const floorPx = Number.isFinite(o.floorPx) ? o.floorPx : Math.min(maxPx, 6);

  let peak = 0;
  for (const cell of cells || []) {
    const speed = cell && Number.isFinite(cell.speedMph) ? cell.speedMph : null;
    if (speed !== null && speed > peak) peak = speed;
  }

  // The lowest stop that covers what is on screen. Never the 0 stop: a legend
  // whose full length is nought has no scale on it at all.
  let fullMph = SPEED_STOPS[SPEED_STOPS.length - 1].mph;
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    if (peak <= SPEED_STOPS[i].mph) { fullMph = SPEED_STOPS[i].mph; break; }
  }

  const floorMph = maxPx > 0 ? (fullMph * floorPx) / maxPx : 0;

  function lengthFor(speedMph) {
    if (!Number.isFinite(speedMph)) return null;
    const px = (Math.max(0, speedMph) / fullMph) * maxPx;
    return Math.min(maxPx, Math.max(floorPx, px));
  }

  return {
    fullMph: fullMph,
    floorMph: floorMph,
    maxPx: maxPx,
    floorPx: floorPx,
    lengthFor: lengthFor,
    caption: "Arrow length is speed: a full-length arrow is " + fullMph +
      " mph. Below " + floorMph.toFixed(1) +
      " mph they are all the same stub, and length stops meaning anything."
  };
}

// A degree of latitude, in metres. Spherical: over a two-mile box the WGS84
// difference is centimetres, and this number moves a dot on a screen.
const M_PER_DEG_LAT = 111320;

/**
 * The index of the grid line nearest `value`, or `null` if the point is
 * outside the grid.
 *
 * A cell has extent, so the outermost half-cell still belongs to the edge cell
 * — "outside" starts half a cell beyond the last line, not at it.
 */
function gridIndex(values, value) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.length === 1) return values[0] === value ? 0 : null;
  const step = values[1] - values[0];
  if (step === 0) return null;
  const i = Math.round((value - values[0]) / step);
  return i < 0 || i >= values.length ? null : i;
}

/**
 * The wind at an arbitrary point in the grid, or `null` where there is none.
 *
 * Nearest cell rather than an interpolation, and that is the whole point: an
 * interpolated sample beside a hole is a wind invented out of its neighbours,
 * which is exactly what the rest of this codebase refuses to do. The particle
 * layer asks this question thousands of times a second and every `null` it
 * gets back is a trail that stops rather than a trail that guesses.
 */
function sampleField(grid, lat, lon) {
  if (!grid || !Array.isArray(grid.lats) || !Array.isArray(grid.lons)) return null;
  const r = gridIndex(grid.lats, lat);
  const c = gridIndex(grid.lons, lon);
  if (r === null || c === null) return null;
  const i = r * grid.cols + c;
  const speedMps = grid.speedMps ? grid.speedMps[i] : null;
  if (!Number.isFinite(speedMps)) return null;
  return {
    row: r,
    col: c,
    lat: grid.lats[r],
    lon: grid.lons[c],
    speedMps: speedMps,
    fromDeg: grid.fromDeg[i]
  };
}

/**
 * One particle, one step: where the air at its feet would carry it.
 *
 * Returns `null` when the particle dies, which happens for exactly two reasons
 * and both of them are refusals rather than bookkeeping. It is standing on a
 * hole, or the step would put it on one — including off the edge of the field.
 * A particle that survived either would draw a streak over ground this service
 * never read, and a moving streak reads as knowledge far more strongly than a
 * static arrow does.
 *
 * Calm is a step of zero length, not a death: a particle standing still is
 * what calm looks like, and it is true.
 *
 * `age` counts the seconds it has been advanced by rather than the number of
 * times, so a life is a distance over the ground however the drawing is paced.
 */
function stepParticle(grid, particle, seconds) {
  const here = sampleField(grid, particle.lat, particle.lon);
  if (!here) return null;

  const towardRad = (((here.fromDeg + 180) % 360) * Math.PI) / 180;
  const eastM = Math.sin(towardRad) * here.speedMps * seconds;
  const northM = Math.cos(towardRad) * here.speedMps * seconds;
  const cosLat = Math.max(1e-6, Math.cos((particle.lat * Math.PI) / 180));
  const lat = particle.lat + northM / M_PER_DEG_LAT;
  const lon = particle.lon + eastM / (M_PER_DEG_LAT * cosLat);

  if (!sampleField(grid, lat, lon)) return null;
  return {
    lat: lat,
    lon: lon,
    age: (particle.age || 0) + seconds,
    from: { lat: particle.lat, lon: particle.lon }
  };
}

/**
 * How many particles a map of this size can carry before the streaks merge.
 *
 * A fixed count is a density, and the same count that reads as separate trails
 * on a desktop covers a phone's map several times over — which is a grey haze
 * with no direction in it, not an animation. Density is the thing to hold
 * still, so the count follows the drawn area and is bounded at both ends.
 */
function particleCount(widthPx, heightPx, opts) {
  const o = opts || {};
  const perParticlePx = Number.isFinite(o.perParticlePx) && o.perParticlePx > 0
    ? o.perParticlePx
    : 900;
  const min = Number.isFinite(o.min) ? o.min : 90;
  const max = Number.isFinite(o.max) ? o.max : 1200;
  const w = Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0;
  const h = Number.isFinite(heightPx) ? Math.max(0, heightPx) : 0;
  return Math.max(min, Math.min(max, Math.round((w * h) / perParticlePx)));
}

/**
 * A cloud of particles over one solved field, and the rule for replacing them.
 *
 * Two things here are honesty rather than animation. A reseeded particle has
 * `from: null`, so the renderer has nothing to draw a line from — without it a
 * respawn paints a streak clean across the map that no wind produced. And a
 * particle has a finite `life` even if nothing kills it, because a field left
 * running collapses onto a handful of streamlines and the map stops describing
 * anywhere the streamlines do not go.
 *
 * `rand` and `seed` are injectable so this is testable as a pure thing.
 */
function particleField(grid, opts) {
  const o = opts || {};
  const rand = typeof o.rand === "function" ? o.rand : Math.random;
  const count = Number.isFinite(o.count) ? o.count : 900;
  const life = Number.isFinite(o.life) ? o.life : 90;

  // Every covered cell, as a place a particle may be born. Read off the grid
  // rather than through `cellsOf`, which would build a quarter of a million
  // objects to answer "which of these is not a hole".
  const homes = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (!Number.isFinite(grid.speedMps[r * grid.cols + c])) continue;
      homes.push({ lat: grid.lats[r], lon: grid.lons[c] });
    }
  }

  function born(index, first) {
    if (homes.length === 0) return null;
    const seeded = first && o.seed && o.seed[index];
    const home = seeded || homes[Math.floor(rand() * homes.length) % homes.length];
    return {
      lat: home.lat,
      lon: home.lon,
      age: 0,
      // Staggered, so the whole cloud does not blink out together, but never
      // shorter than a trail: a particle that dies before it has drawn one is
      // a dot, which is what reduced motion used to turn the whole map into.
      life: seeded ? life : life * (0.35 + 0.65 * rand()),
      from: null
    };
  }

  const particles = [];
  for (let i = 0; i < count; i++) {
    const p = born(i, true);
    if (p) particles.push(p);
  }

  function advance(seconds) {
    for (let i = 0; i < particles.length; i++) {
      const moved = stepParticle(grid, particles[i], seconds);
      if (moved && moved.age < particles[i].life) {
        moved.life = particles[i].life;
        particles[i] = moved;
      } else {
        const fresh = born(i, false);
        if (fresh) particles[i] = fresh;
      }
    }
    return particles;
  }

  return { particles: particles, advance: advance, homes: homes.length };
}

/**
 * How much faster than the real air the particles are drawn, and the sentence
 * that says so.
 *
 * They have to be exaggerated to be a picture at all: at 5 m/s a parcel takes
 * a quarter of an hour to cross a two-mile box, so a truthful animation is a
 * still image. Exaggeration is fine; an unstated exaggeration is not, which is
 * why this returns the factor rather than hiding it in a constant. The rest of
 * the sentence is the more important half — the field is one snapshot, so a
 * particle is tracing a static map, not air travelling from one place to
 * another over time.
 */
function motionScale(fullMph, metresPerPixel, opts) {
  const o = opts || {};
  const pxPerSecond = Number.isFinite(o.pxPerSecond) ? o.pxPerSecond : 40;
  const fullMps = fullMph / MPS_TO_MPH;
  const drawnMps = pxPerSecond * metresPerPixel;
  const speedup = fullMps > 0 && Number.isFinite(drawnMps) ? drawnMps / fullMps : null;
  const rounded = speedup === null
    ? null
    : Number(speedup.toPrecision(2)).toLocaleString("en-US");
  return {
    pxPerSecond: pxPerSecond,
    drawnMps: drawnMps,
    speedup: speedup,
    secondsPerSecond: speedup,
    caption: "Particles trace the same static field the arrows do" +
      (rounded === null ? "" : ", drawn about " + rounded + "× faster than the air") +
      ". They are a rendering of one snapshot, not air travelling over time, and " +
      "a trail stops at ground with no terrain under it rather than crossing it."
  };
}

/**
 * How long a particle lives, expressed as the distance on screen it is allowed
 * to cover, in the model seconds `advance` is given.
 *
 * A life counted in frames is a distance that changes with the drawing speed:
 * at the reduced-motion 12 px/s the old fixed 120 frames was about 24 px of
 * travel, so a particle died at roughly the length of the trail it was meant
 * to be drawing and the map became a field of dots. A distance is the thing
 * that should be held still — long enough to draw a trail, short enough that
 * the cloud does not collapse onto a few streamlines.
 */
function particleLife(scale, opts) {
  const o = opts || {};
  const travelPx = Number.isFinite(o.travelPx) && o.travelPx > 0 ? o.travelPx : 200;
  const px = scale && Number.isFinite(scale.pxPerSecond) ? scale.pxPerSecond : 0;
  const secs = scale && Number.isFinite(scale.secondsPerSecond) ? scale.secondsPerSecond : 0;
  if (px <= 0 || secs <= 0) return 0;
  return (travelPx / px) * secs;
}

/**
 * The shape of a trail: how far apart to keep the positions behind a particle,
 * and how many of them, so that a trail is a length in pixels.
 *
 * The usual way to draw one is to fade the previous frame by a fixed alpha
 * instead of clearing it, and it is wrong twice here. The length it produces
 * is the product of the drawing speed and the frame rate, and both of those
 * move — 12 px/s under reduced motion leaves a three-pixel dot, and a phone at
 * 30 fps leaves twice the trail a desktop does. And the fade is multiplicative
 * on an eight-bit alpha, so it stops making progress once the rounding does:
 * the map keeps a permanent low-alpha smear of every trail ever drawn over it,
 * which is what buried these trails in their own haze.
 *
 * Keeping the positions instead is exact, and sampling them by distance rather
 * than per frame is what makes the cost of one independent of how fast it is
 * drawn or how fast the phone can draw it.
 */
function trailPath(opts) {
  const o = opts || {};
  const trailPx = Number.isFinite(o.trailPx) && o.trailPx > 0 ? o.trailPx : 26;
  const stepPx = Number.isFinite(o.stepPx) && o.stepPx > 0 ? o.stepPx : 2;
  const max = Number.isFinite(o.max) ? o.max : 64;
  return {
    stepPx: stepPx,
    points: Math.max(2, Math.min(max, Math.round(trailPx / stepPx) + 1))
  };
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

  // Degraded terrain, said in words. The wind here is current; the list of
  // products the ground was chosen from is not, because The National Map
  // refused to refresh it. A caption that left this out would present a
  // month-old choice of DEM as today's.
  if (terrain.listing && terrain.listing.retained) {
    lines.push("Terrain product list last read " + ageText(terrain.listing.ageS) +
      " — The National Map would not answer, so the ground was chosen from the kept copy");
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
  // Opt-in, because it costs an HRRR subset over the whole view where the
  // markers alone cost a filter over a cached list.
  if (spec.model === true) params.set("model", "true");
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

/**
 * The colour for a model-to-measured ratio, or `null` when there is not one.
 *
 * `null` for anything that is not a finite positive ratio, for the same reason
 * `speedColor` returns it for an uncovered cell: the caller has to decide what
 * "no comparison" looks like and must not be able to get a colour by accident.
 */
function ratioColor(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  let color = RATIO_STOPS[0].color;
  for (const stop of RATIO_STOPS) {
    if (ratio >= stop.ratio) color = stop.color;
  }
  return color;
}

/**
 * The station against the raw model at the same coordinate.
 *
 * The sibling of `compareStationToField`, and deliberately a separate function
 * rather than a flag on it, because it compares against a different number:
 * `/v1/stations?model=true` samples HRRR as published at the station, where
 * `/v1/field` returns HRRR downscaled onto 3DEP terrain over the pin's box.
 * The first exists because the second only covers a mile of ground and the
 * stations are tens of miles apart — a map that could only compare inside the
 * solve box could almost never compare at all.
 *
 * It refuses in five named ways, and the fifth is the one that would otherwise
 * produce a spectacular wrong number: a **calm** measurement has no ratio. The
 * model saying 5 m/s over a calm anemometer is a real and interesting
 * disagreement, and it is not "infinity times too fast".
 */
function compareStationToModel(view, station, body, opts) {
  const o = opts || {};
  const maxGapS = o.maxGapS === undefined ? 3600 : o.maxGapS;
  const out = {
    comparable: false, reason: null, modelSpeedMph: null, modelFromDeg: null,
    ratio: null, directionDeltaDeg: null, measuredCalm: false, heightNote: null
  };

  const block = body && body.model;
  if (!block || block.error) {
    out.reason = block && block.error
      ? block.error
      : "the model was not asked for alongside these stations";
    return out;
  }
  const model = station && station.model;
  if (!model || !Number.isFinite(model.speedMps)) {
    out.reason = (station && station.modelNote) || "the model has no wind at this station";
    return out;
  }

  out.modelSpeedMph = mph(model.speedMps);
  out.modelFromDeg = Number.isFinite(model.fromDeg) ? model.fromDeg : null;
  // Said whether or not the comparison goes ahead: a reader who sees the two
  // numbers has already compared them, whatever this function decides.
  out.heightNote = "model at " +
    (Number.isFinite(block.heightAglM) ? block.heightAglM + " m" : "its own height") +
    " AGL, RAWS nominally 6.1 m — not height-matched" +
    (block.downscaled === false ? ", and not downscaled onto the terrain" : "");

  if (!view || !view.reporting) {
    out.reason = "the station reported nothing";
    return out;
  }

  const nowMs = o.nowMs === undefined ? Date.now() : o.nowMs;
  const gapS = block.validTime && view.ageS !== null
    ? Math.abs(Math.round((nowMs - Date.parse(block.validTime)) / 1000) - view.ageS)
    : null;
  if (gapS !== null && gapS > maxGapS) {
    out.reason = "the observation and the model hour are " +
      ageText(gapS).replace(" ago", "") + " apart";
    return out;
  }

  out.comparable = true;
  out.timeGapS = gapS;
  if (view.calm || !(view.speedMps > 0)) {
    out.measuredCalm = true;
    return out;
  }
  out.ratio = model.speedMps / view.speedMps;
  if (Number.isFinite(view.fromDeg) && Number.isFinite(model.fromDeg)) {
    out.directionDeltaDeg = signedDegrees(model.fromDeg - view.fromDeg);
  }
  return out;
}

/**
 * What the comparable stations say together, as one sentence.
 *
 * The **median** rather than the mean, because one station reporting 0.2 m/s
 * against a 4 m/s model produces a ratio of twenty and a mean that is about
 * that station. `docs/downscaling.md` measurement 11 found a single station
 * carrying an entire regression; a caption is not the place to repeat that.
 */
function modelSummary(comparisons) {
  const ratios = (comparisons || [])
    .filter(function (c) { return c && c.comparable && Number.isFinite(c.ratio); })
    .map(function (c) { return c.ratio; })
    .sort(function (a, b) { return a - b; });
  const out = { compared: ratios.length, medianRatio: null, text: null };
  if (!ratios.length) return out;
  const mid = Math.floor(ratios.length / 2);
  out.medianRatio = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  out.text = "model " + out.medianRatio.toFixed(2) + "\u00d7 measured (median of " +
    ratios.length + ")";
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

/**
 * The line under the stations toggle: how many, from where, how old — and,
 * when the model was asked for beside them, what the two disagree by.
 *
 * `summary` is passed in rather than computed here because the caller has
 * already built the per-station comparisons to draw the markers, and computing
 * them twice is how the caption and the map come to say different things.
 */
function stationsCaption(body, summary) {
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
  if (summary && summary.text) parts.push(summary.text);
  // The refusal that has no entry in `errors`: the search was wider than the
  // model is sampled over, and the stations themselves are unaffected.
  if (body.model && body.model.error &&
      !(body.errors || []).some(function (e) { return e.error === body.model.error; })) {
    parts.push(body.model.error);
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
  RATIO_STOPS: RATIO_STOPS,
  mph: mph,
  speedColor: speedColor,
  ratioColor: ratioColor,
  cellsOf: cellsOf,
  strideFor: strideFor,
  arrowScale: arrowScale,
  sampleField: sampleField,
  stepParticle: stepParticle,
  particleField: particleField,
  particleCount: particleCount,
  motionScale: motionScale,
  particleLife: particleLife,
  trailPath: trailPath,
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
  compareStationToModel: compareStationToModel,
  modelSummary: modelSummary,
  signedDegrees: signedDegrees,
  stationsCaption: stationsCaption
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.WindMapLib = api;
