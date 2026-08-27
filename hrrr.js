/**
 * Atmospheric input: NOAA HRRR, fetched through the NOMADS GRIB2 filter.
 *
 * HRRR is the boundary condition, not the answer. At roughly 3 km it knows what
 * wind arrives at the mountain and nothing about what the mountain does to it —
 * that is the terrain solver's job. What this module does is ask NOMADS for the
 * smallest possible slice: a handful of variables, at a few levels, over one
 * box, for one hour. The full national file is hundreds of megabytes; the
 * subset for a two-mile domain is kilobytes.
 *
 * URL construction only. Nothing here fetches, so cycle selection and subsetting
 * can be tested without hammering a government service that explicitly asks for
 * a pause between requests.
 */

"use strict";

const FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl";

// HRRR runs hourly. The 00/06/12/18Z cycles run out to 48 hours; the rest stop
// at 18. Asking for hour 30 off a 15Z cycle returns an error page, not data.
const EXTENDED_CYCLES = [0, 6, 12, 18];
const MAX_FORECAST_HOUR_STANDARD = 18;
const MAX_FORECAST_HOUR_EXTENDED = 48;

// Rough CONUS domain bounds. HRRR also has an Alaska domain under a different
// filter script; Hawaii and the territories have neither, and a coordinate there
// needs a different model rather than a silently empty grid.
const CONUS = { west: -134.1, south: 21.1, east: -60.9, north: 52.6 };

/**
 * How long after a cycle time its files are actually on NOMADS. Deliberately a
 * parameter with a conservative default rather than a constant: this is an
 * operational figure that varies with the cycle and with NCEP's load, and it has
 * not been measured from this codebase. If discovery starts returning 404s,
 * this is the first number to raise.
 */
const DEFAULT_AVAILABILITY_LAG_MINUTES = 75;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function inConus(lat, lon) {
  return lat >= CONUS.south && lat <= CONUS.north && lon >= CONUS.west && lon <= CONUS.east;
}

function boxInConus(box) {
  return box.west >= CONUS.west && box.east <= CONUS.east &&
    box.south >= CONUS.south && box.north <= CONUS.north;
}

function maxForecastHour(cycleHour) {
  return EXTENDED_CYCLES.indexOf(cycleHour) >= 0 ? MAX_FORECAST_HOUR_EXTENDED : MAX_FORECAST_HOUR_STANDARD;
}

/**
 * The most recent cycle whose files should be on the server at `at`.
 *
 * Takes the clock explicitly: a function that reads the current time cannot be
 * tested, and every "why did this break at midnight UTC" bug lives in code that
 * calls Date.now() somewhere deep.
 */
function latestAvailableCycle(at, lagMinutes) {
  const lag = lagMinutes === undefined ? DEFAULT_AVAILABILITY_LAG_MINUTES : lagMinutes;
  const t = new Date(at.getTime() - lag * 60000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours()
  };
}

function cycleDateString(cycle) {
  return String(cycle.year) + pad2(cycle.month) + pad2(cycle.day);
}

/** hrrr.tHHz.wrfsfcf FF .grib2 — the surface (2D) file, which is what wind at height lives in. */
function fileName(cycleHour, forecastHour) {
  return "hrrr.t" + pad2(cycleHour) + "z.wrfsfcf" + pad2(forecastHour) + ".grib2";
}

/**
 * Variables and levels for a terrain wind downscale.
 *
 * UGRD/VGRD at 10 m is the surface wind everyone quotes. The 80 m level matters
 * more than it looks: it sits above the roughness layer, so it is a better
 * estimate of what is arriving over a ridge than a 10 m value measured in a
 * valley. Temperature, surface pressure and PBL height set stability, which is
 * what decides whether air goes over a ridge or around it.
 */
const DEFAULT_VARIABLES = ["UGRD", "VGRD", "TMP", "PRES", "HPBL", "GUST"];
const DEFAULT_LEVELS = ["10_m_above_ground", "80_m_above_ground", "surface"];

/**
 * NOMADS' level names against the canonical level keys a volume is filed under.
 *
 * Two vocabularies exist because two systems named the same thing: the filter
 * wants `10_m_above_ground`, and GRIB's own tables say surface type 103 at 10.
 * The translation is a table rather than string surgery so that an unknown
 * level is refused by name — a level the filter does not recognise is not an
 * error, it is a 200 with the defaults substituted, which is far worse.
 */
const FILTER_LEVELS = {
  "surface": "surface",
  "heightAboveGround:2": "2_m_above_ground",
  "heightAboveGround:10": "10_m_above_ground",
  "heightAboveGround:80": "80_m_above_ground",
  "heightAboveGround:1000": "1000_m_above_ground"
};

const DEFAULT_LEVEL_KEYS = ["heightAboveGround:10", "heightAboveGround:80", "surface"];

/** Canonical level key -> the filter's name for it. */
function filterLevel(levelKey) {
  const name = FILTER_LEVELS[levelKey];
  if (!name) {
    throw new Error(
      "no NOMADS level is known for " + levelKey + "; the filter answers an unrecognised " +
      "level with its defaults and HTTP 200, so this is refused rather than sent. Known: " +
      Object.keys(FILTER_LEVELS).join(", ")
    );
  }
  return name;
}

/**
 * The cycle whose analysis (forecast hour 0) is valid at an instant.
 *
 * HRRR runs hourly on the hour, so this is the hour containing `validTime` —
 * and it must be exactly on the hour, because there is no analysis valid at
 * 20:30Z and rounding to one silently answers a different question.
 */
function analysisCycleFor(validTime) {
  const t = validTime instanceof Date ? validTime : new Date(validTime);
  if (!isFinite(t.getTime())) throw new Error("validTime must be a Date or an ISO string");
  if (t.getUTCMinutes() !== 0 || t.getUTCSeconds() !== 0 || t.getUTCMilliseconds() !== 0) {
    throw new Error(
      "HRRR runs on the hour; " + t.toISOString() + " is not an instant it produces. " +
      "Round deliberately rather than here"
    );
  }
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours()
  };
}

/** The instant a cycle's analysis is valid at. */
function cycleValidTime(cycle, forecastHour) {
  return new Date(Date.UTC(cycle.year, cycle.month - 1, cycle.day, cycle.hour) +
    (forecastHour || 0) * 3600 * 1000);
}

/**
 * Build a GRIB2 filter URL.
 *
 * Throws rather than returning a broken URL: NOMADS answers an invalid request
 * with an HTML error page and HTTP 200, so a bad request does not look like a
 * failure downstream — it looks like a GRIB file that will not parse.
 */
function filterUrl(opts) {
  const o = opts || {};
  const cycle = o.cycle;
  if (!cycle || !isFinite(cycle.year) || !isFinite(cycle.hour)) {
    throw new Error("cycle {year, month, day, hour} is required");
  }
  const fh = Number(o.forecastHour || 0);
  if (!isFinite(fh) || fh < 0 || fh > maxForecastHour(cycle.hour)) {
    throw new Error(
      "forecastHour " + o.forecastHour + " is out of range for the " + pad2(cycle.hour) +
      "Z cycle (max " + maxForecastHour(cycle.hour) + ")"
    );
  }
  const box = o.box;
  if (!box) throw new Error("box is required");
  if (box.west >= box.east || box.south >= box.north) throw new Error("box is empty or transposed");
  if (!boxInConus(box)) {
    throw new Error("box falls outside the HRRR CONUS domain — Alaska needs the hrrrak filter, and Hawaii has neither");
  }

  const params = new URLSearchParams();
  params.set("file", fileName(cycle.hour, fh));

  for (const level of (o.levels || DEFAULT_LEVELS)) params.set("lev_" + level, "on");
  for (const variable of (o.variables || DEFAULT_VARIABLES)) params.set("var_" + variable, "on");

  params.set("subregion", "");
  // NOMADS wants the corners as plain decimal degrees, west negative.
  params.set("leftlon", String(box.west));
  params.set("rightlon", String(box.east));
  params.set("toplat", String(box.north));
  params.set("bottomlat", String(box.south));
  params.set("dir", "/hrrr." + cycleDateString(cycle) + "/conus");

  return FILTER_URL + "?" + params.toString();
}

/**
 * A forecast run: the same cycle sampled at each hour out to `hours`.
 * Clamped to what the cycle actually produces rather than throwing, so a request
 * for 24 hours off a 15Z cycle returns the 18 that exist.
 */
function forecastSeries(opts) {
  const o = opts || {};
  const cycle = o.cycle;
  const limit = Math.min(Number(o.hours || 18), maxForecastHour(cycle.hour));
  const out = [];
  for (let fh = 0; fh <= limit; fh++) {
    out.push({ forecastHour: fh, url: filterUrl(Object.assign({}, o, { forecastHour: fh })) });
  }
  return out;
}

module.exports = {
  FILTER_URL,
  CONUS,
  DEFAULT_VARIABLES,
  DEFAULT_LEVELS,
  DEFAULT_LEVEL_KEYS,
  FILTER_LEVELS,
  DEFAULT_AVAILABILITY_LAG_MINUTES,
  filterLevel,
  analysisCycleFor,
  cycleValidTime,
  inConus,
  boxInConus,
  maxForecastHour,
  latestAvailableCycle,
  cycleDateString,
  fileName,
  filterUrl,
  forecastSeries
};
