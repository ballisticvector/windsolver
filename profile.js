// The windProfile contract — the written form of the WindSolver ⇄ BallisticVector
// boundary, and the only thing in this repo that both products have to agree on.
//
// A profile is a rectangular grid of air velocity over range and height, in the
// shooter's frame, plus the provenance a caller needs in order to decide how much
// to believe it. Nothing in here knows what a rifle is: the same payload describes
// the air a drone, a sailplane or a fire crew flies through.
//
//   u  downrange, along the axis the shot is fired on
//   v  positive to the shooter's right
//   w  positive up
//
// All three are the velocity OF THE AIR, in feet per second. Note that this is the
// opposite sense to the clock convention the app takes from the shooter, where a
// "3 o'clock wind" names where the wind comes FROM: that wind blows toward the
// shooter's left, so it is negative v.
//
// Grids are indexed [heightIndex][rangeIndex], matching `heightsAglFt` and
// `rangesYards`, both of which must be strictly ascending. Between nodes the field
// is bilinear; outside them it holds the edge value flat rather than extrapolating
// a wind nobody looked at.
//
// Two rules make this a contract rather than an argument list.
//
// **Every key must be present.** `null` is the legal way to say "not known" or
// "calm on this axis". Omission is refused. The difference matters because a
// missing confidence and an unknown confidence look identical on a screen, and
// only one of them is honest — and because a mistyped `uMps` is otherwise just an
// absent `uFps`, which reads as calm and solves cleanly.
//
// **A profile that cannot be trusted is refused with a reason and a code.** It is
// never silently ignored and never partially applied. A caller who gets the frame
// or the azimuth wrong has to receive an error; the alternative is a confident,
// wrong hold, which is worse than no answer.

const WIND_PROFILE_VERSION = 1;

// The whole of v1. Adding a key here is a version bump for anyone who validates
// strictly, so add it to the tests and the README in the same change.
const WIND_PROFILE_KEYS = [
  "schemaVersion",
  "frame",
  "azimuthDeg",
  "rangesYards",
  "heightsAglFt",
  "uFps",
  "vFps",
  "wFps",
  "source",
  "terrainResolutionM",
  "windSourceResolutionM",
  "confidence"
];

// The only frame the components may be expressed in. A field in an east-north
// frame is numerically indistinguishable from one along the bore, so it has to be
// declared and refused rather than quietly rotated by nothing.
const WIND_PROFILE_FRAME = "shooter";

// How far the profile's own axis bearing may sit from the shot's before the two
// are considered to be describing different shots.
const AZIMUTH_TOLERANCE_DEG = 1;

// 300 fps is 205 mph — past any surface wind ever recorded. The bound exists for
// unit confusion rather than for weather: a field built in cm/s or in km/h and
// labelled fps trips it.
const MAX_COMPONENT_FPS = 300;
const MAX_RANGE_YARDS = 20000;
const MIN_HEIGHT_AGL_FT = -1000;
const MAX_HEIGHT_AGL_FT = 30000;
const MAX_RESOLUTION_M = 100000;
const MAX_SOURCE_CHARS = 200;

// A vertical component is carried by the contract because the field has one. The
// 3DOF point-mass solver has no term for it, so anything above numerical noise is
// refused rather than dropped on the floor.
const VERTICAL_TOLERANCE_FPS = 1e-6;

function fail(code, reason) {
  return { ok: false, code: code, reason: reason };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDegrees(value) {
  let v = value % 360;
  if (v < 0) v += 360;
  return v;
}

function checkAxis(name, axis, min, max) {
  if (!Array.isArray(axis) || axis.length < 1) {
    return fail("malformed-axis", name + " must be a non-empty array of ascending numbers");
  }
  for (let i = 0; i < axis.length; i++) {
    const x = axis[i];
    if (typeof x !== "number" || !isFinite(x)) {
      return fail("malformed-axis", name + "[" + i + "] must be a finite number");
    }
    if (i > 0 && !(x > axis[i - 1])) {
      return fail("malformed-axis", name + " must ascend strictly: " + axis[i - 1] + " then " + x);
    }
    if (x < min || x > max) {
      return fail("out-of-range", name + "[" + i + "] = " + x + " is outside " + min + "…" + max);
    }
  }
  return null;
}

// `null` means calm on this axis and yields a zero grid; anything else must be a
// rows x cols array of finite numbers within the magnitude bound.
function checkGrid(name, grid, rows, cols) {
  if (grid === null) {
    const zeros = [];
    for (let j = 0; j < rows; j++) {
      const row = [];
      for (let i = 0; i < cols; i++) row.push(0);
      zeros.push(row);
    }
    return { grid: zeros };
  }
  const shape = name + " must be null or a [" + rows + "][" + cols + "] " +
    "[heightsAglFt][rangesYards] grid of finite numbers";
  if (!Array.isArray(grid) || grid.length !== rows) return { error: fail("malformed-grid", shape) };
  for (let j = 0; j < rows; j++) {
    const row = grid[j];
    if (!Array.isArray(row) || row.length !== cols) return { error: fail("malformed-grid", shape) };
    for (let i = 0; i < cols; i++) {
      const x = row[i];
      if (typeof x !== "number" || !isFinite(x)) {
        return { error: fail("malformed-grid", name + "[" + j + "][" + i + "] must be a finite number") };
      }
      if (Math.abs(x) > MAX_COMPONENT_FPS) {
        return {
          error: fail("out-of-range", name + "[" + j + "][" + i + "] = " + x +
            " fps exceeds " + MAX_COMPONENT_FPS + " fps; check the units")
        };
      }
    }
  }
  return { grid: grid };
}

function checkOptionalNumber(name, value, min, max) {
  if (value === null) return null;
  if (typeof value !== "number" || !isFinite(value) || value < min || value > max) {
    return fail("out-of-range", name + " must be null or a number in " + min + "…" + max);
  }
  return null;
}

// Validates a caller-supplied profile against v1 of the contract.
//
//   validateWindProfile(profile, { shotAzimuthDeg })
//     -> { ok: true,  field: { ranges, heights, u, v }, meta: {…} }
//     -> { ok: false, code, reason }
//
// `field` is the sampling-ready form; `meta` is the provenance, which the caller
// is expected to show rather than swallow.
function validateWindProfile(profile, context) {
  if (!isPlainObject(profile)) {
    return fail("not-an-object", "windProfile must be an object");
  }

  // The version is read before anything else, so that a caller writing to a
  // later contract is told the version is wrong rather than handed a list of
  // complaints about keys this one has never heard of. Absent is absent, though:
  // an unversioned payload is a caller who has not read the contract at all.
  if (!Object.prototype.hasOwnProperty.call(profile, "schemaVersion") ||
      profile.schemaVersion === undefined) {
    return fail("missing-field",
      "windProfile.schemaVersion is required by contract v" + WIND_PROFILE_VERSION);
  }
  if (profile.schemaVersion !== WIND_PROFILE_VERSION) {
    return fail("unsupported-version",
      "windProfile.schemaVersion must be " + WIND_PROFILE_VERSION +
      ", got " + JSON.stringify(profile.schemaVersion));
  }

  for (const key of WIND_PROFILE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(profile, key) || profile[key] === undefined) {
      return fail("missing-field",
        "windProfile." + key + " is required by contract v" + WIND_PROFILE_VERSION +
        "; send null to say it is not known");
    }
  }

  const unknown = Object.keys(profile).filter(k => WIND_PROFILE_KEYS.indexOf(k) === -1);
  if (unknown.length) {
    return fail("unknown-field",
      "windProfile carries unrecognised keys: " + unknown.join(", ") +
      ". A key this contract does not name would be ignored, so it is refused instead");
  }

  if (profile.frame !== WIND_PROFILE_FRAME) {
    return fail("unsupported-frame",
      "windProfile.frame must be \"" + WIND_PROFILE_FRAME + "\" — u along the bore, v to " +
      "the shooter's right — got " + JSON.stringify(profile.frame) +
      ". A field in another frame has to be rotated before it is sent");
  }

  const rangeErr = checkAxis("windProfile.rangesYards", profile.rangesYards, 0, MAX_RANGE_YARDS);
  if (rangeErr) return rangeErr;
  const heightErr = checkAxis("windProfile.heightsAglFt", profile.heightsAglFt,
    MIN_HEIGHT_AGL_FT, MAX_HEIGHT_AGL_FT);
  if (heightErr) return heightErr;

  const rows = profile.heightsAglFt.length;
  const cols = profile.rangesYards.length;

  const u = checkGrid("windProfile.uFps", profile.uFps, rows, cols);
  if (u.error) return u.error;
  const v = checkGrid("windProfile.vFps", profile.vFps, rows, cols);
  if (v.error) return v.error;
  const w = checkGrid("windProfile.wFps", profile.wFps, rows, cols);
  if (w.error) return w.error;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (Math.abs(w.grid[j][i]) > VERTICAL_TOLERANCE_FPS) {
        return fail("unsupported-vertical-wind",
          "windProfile.wFps[" + j + "][" + i + "] = " + w.grid[j][i] + " fps: this solver has no " +
          "vertical wind term, and applying the field while discarding a measured " +
          "vertical component would be worse than refusing it");
      }
    }
  }

  if (typeof profile.source !== "string" || profile.source.trim() === "" ||
      profile.source.length > MAX_SOURCE_CHARS) {
    return fail("malformed-field",
      "windProfile.source must be a non-empty string of at most " + MAX_SOURCE_CHARS +
      " characters naming where the field came from");
  }

  const terrainErr = checkOptionalNumber("windProfile.terrainResolutionM",
    profile.terrainResolutionM, Number.MIN_VALUE, MAX_RESOLUTION_M);
  if (terrainErr) return terrainErr;
  const sourceResErr = checkOptionalNumber("windProfile.windSourceResolutionM",
    profile.windSourceResolutionM, Number.MIN_VALUE, MAX_RESOLUTION_M);
  if (sourceResErr) return sourceResErr;
  const confidenceErr = checkOptionalNumber("windProfile.confidence", profile.confidence, 0, 1);
  if (confidenceErr) return confidenceErr;

  // The azimuth last, because it is the field most likely to be wrong in a way
  // that nothing else can catch. It is the true-north bearing of the DOWNRANGE
  // AXIS — where the rifle points — not where the wind comes from.
  const fieldAz = profile.azimuthDeg;
  if (typeof fieldAz !== "number" || !isFinite(fieldAz) || fieldAz < 0 || fieldAz > 360) {
    return fail("out-of-range",
      "windProfile.azimuthDeg must be a bearing in 0…360 for the downrange axis, got " +
      JSON.stringify(fieldAz));
  }
  const shotAz = context ? context.shotAzimuthDeg : undefined;
  if (typeof shotAz !== "number" || !isFinite(shotAz)) {
    return fail("azimuth-missing",
      "the shot must carry an azimuthDeg before a windProfile can be applied to it: " +
      "without one there is nothing to check the field's own bearing against");
  }
  if (shotAz < 0 || shotAz > 360) {
    return fail("out-of-range", "the shot's azimuthDeg must be a bearing in 0…360, got " + shotAz);
  }
  let delta = Math.abs(normalizeDegrees(fieldAz) - normalizeDegrees(shotAz));
  if (delta > 180) delta = 360 - delta;
  if (delta > AZIMUTH_TOLERANCE_DEG) {
    return fail("azimuth-mismatch",
      "windProfile.azimuthDeg " + normalizeDegrees(fieldAz).toFixed(1) +
      " does not match the shot azimuth " + normalizeDegrees(shotAz).toFixed(1) +
      ": the field describes a different shot, or the wind's own bearing was sent instead " +
      "of the downrange axis");
  }

  return {
    ok: true,
    field: {
      ranges: profile.rangesYards,
      heights: profile.heightsAglFt,
      u: u.grid,
      v: v.grid
    },
    meta: {
      schemaVersion: profile.schemaVersion,
      frame: profile.frame,
      azimuthDeg: profile.azimuthDeg,
      source: profile.source,
      terrainResolutionM: profile.terrainResolutionM,
      windSourceResolutionM: profile.windSourceResolutionM,
      confidence: profile.confidence
    }
  };
}

// Index of the cell containing x. Outside the grid the edge cell is returned so
// sampling holds the measured edge value flat instead of extrapolating a wind
// nobody looked at.
function cellIndex(axis, x) {
  const last = axis.length - 1;
  if (last <= 0 || x <= axis[0]) return 0;
  if (x >= axis[last]) return last - 1;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x >= axis[mid]) lo = mid; else hi = mid;
  }
  return lo;
}

function cellFraction(axis, i, x) {
  const i1 = Math.min(i + 1, axis.length - 1);
  if (i1 === i || axis[i1] <= axis[i]) return 0;
  const f = (x - axis[i]) / (axis[i1] - axis[i]);
  return f < 0 ? 0 : (f > 1 ? 1 : f);
}

// Bilinear sample written into `out`, which the integration loops reuse so a
// few thousand steps do not allocate a few thousand objects.
function sampleWindField(field, rangeYards, heightFt, out) {
  const ri = cellIndex(field.ranges, rangeYards);
  const hj = cellIndex(field.heights, heightFt);
  const ri1 = Math.min(ri + 1, field.ranges.length - 1);
  const hj1 = Math.min(hj + 1, field.heights.length - 1);
  const rf = cellFraction(field.ranges, ri, rangeYards);
  const hf = cellFraction(field.heights, hj, heightFt);
  const a = (1 - hf) * (1 - rf);
  const b = (1 - hf) * rf;
  const c = hf * (1 - rf);
  const d = hf * rf;
  out.u = a * field.u[hj][ri] + b * field.u[hj][ri1] + c * field.u[hj1][ri] + d * field.u[hj1][ri1];
  out.v = a * field.v[hj][ri] + b * field.v[hj][ri1] + c * field.v[hj1][ri] + d * field.v[hj1][ri1];
  return out;
}

module.exports = {
  WIND_PROFILE_VERSION,
  WIND_PROFILE_KEYS,
  WIND_PROFILE_FRAME,
  AZIMUTH_TOLERANCE_DEG,
  MAX_COMPONENT_FPS,
  validateWindProfile,
  sampleWindField
};
