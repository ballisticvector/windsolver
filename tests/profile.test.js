const {
  WIND_PROFILE_VERSION,
  WIND_PROFILE_KEYS,
  validateWindProfile
} = require("../profile");

// What the contract accepts, asked with no rifle in sight. These tests moved
// here from BallisticVector's tests/wind-profile.test.js when the products
// split: that file still asks what the *solver* does with a field, which is a
// different question and stays on the consumer's side.
//
// The rule the whole thing turns on: a field that cannot be trusted is refused
// with a reason, never quietly ignored. Silence is the only outcome that
// reaches a caller as a confident, wrong answer.

const SHOT_AZIMUTH = 90;

// Every key the v1 contract requires, at its "nothing to declare" value. A
// caller has to say it does not know a thing; it cannot leave the thing out.
function envelope(extra) {
  return Object.assign({
    schemaVersion: WIND_PROFILE_VERSION,
    frame: "shooter",
    azimuthDeg: SHOT_AZIMUTH,
    rangesYards: [0, 1000],
    heightsAglFt: [0],
    uFps: null,
    vFps: null,
    wFps: null,
    source: "test",
    terrainResolutionM: null,
    windSourceResolutionM: null,
    confidence: null
  }, extra || {});
}

const ctx = { shotAzimuthDeg: SHOT_AZIMUTH };

function reject(profile, code, context) {
  const res = validateWindProfile(profile, context || ctx);
  expect(res.ok).toBe(false);
  expect(res.code).toBe(code);
  expect(typeof res.reason).toBe("string");
  expect(res.reason.length).toBeGreaterThan(0);
  return res;
}

describe("windProfile contract — v1 envelope", () => {
  test("a complete envelope is accepted and its metadata comes back", () => {
    const res = validateWindProfile(envelope({
      source: "hrrr+3dep",
      terrainResolutionM: 10,
      windSourceResolutionM: 3000,
      confidence: 0.62
    }), ctx);
    expect(res.ok).toBe(true);
    expect(res.meta).toEqual({
      schemaVersion: WIND_PROFILE_VERSION,
      frame: "shooter",
      azimuthDeg: SHOT_AZIMUTH,
      source: "hrrr+3dep",
      terrainResolutionM: 10,
      windSourceResolutionM: 3000,
      confidence: 0.62
    });
  });

  test("every documented key is required, and the reason names the missing one", () => {
    for (const key of WIND_PROFILE_KEYS) {
      const p = envelope({});
      delete p[key];
      const res = reject(p, "missing-field");
      expect(res.reason).toContain(key);
    }
  });

  test("null is a legal way to say 'not known' — omission is not", () => {
    // The engine is allowed not to know its own confidence. It is not allowed to
    // stay quiet about it, because a missing number and an unknown one look the
    // same on a screen and only one of them is honest.
    expect(validateWindProfile(envelope({ confidence: null }), ctx).ok).toBe(true);
    const p = envelope({});
    delete p.confidence;
    reject(p, "missing-field");
  });

  test("an unknown key is refused rather than ignored", () => {
    // uMps for uFps, or azimuth for azimuthDeg: the field is dropped, the axis
    // silently reads calm, and the answer looks fine.
    const res = reject(envelope({ uMps: [[0, 0]] }), "unknown-field");
    expect(res.reason).toContain("uMps");
  });

  test("only version 1 is understood", () => {
    reject(envelope({ schemaVersion: 2 }), "unsupported-version");
    reject(envelope({ schemaVersion: "1" }), "unsupported-version");
    reject(envelope({ schemaVersion: null }), "unsupported-version");
  });

  test("something that is not an object is refused without throwing", () => {
    for (const junk of ["", "profile", 7, true, [], [1, 2]]) {
      reject(junk, "not-an-object");
    }
  });
});

describe("windProfile contract — the frame and the azimuth", () => {
  // The azimuth is the single most dangerous field in the contract. It is the
  // one place where a caller can be entirely self-consistent, pass every
  // structural check, and still hand the solver a wind pointing somewhere else.

  test("the frame must be declared, and only the shooter's frame is supported", () => {
    reject(envelope({ frame: "enu" }), "unsupported-frame");
    reject(envelope({ frame: "north" }), "unsupported-frame");
    reject(envelope({ frame: "" }), "unsupported-frame");
  });

  test("a north-referenced field is refused, not silently read as body-frame", () => {
    // u/v in an east-north frame are numerically indistinguishable from u/v
    // along the bore. Without `frame` the solver would rotate nothing and drift
    // the bullet along whatever axis the caller happened to mean.
    reject(envelope({ frame: "enu", uFps: [[10, 10]], vFps: [[0, 0]] }), "unsupported-frame");
  });

  test("the wind's own bearing in azimuthDeg is caught by the mismatch check", () => {
    // The classic misuse: azimuthDeg filled in with where the wind comes from
    // rather than where the rifle points. A 270 wind on a 90 shot is a full
    // reversal, and it must not be solvable.
    const res = reject(envelope({ azimuthDeg: 270 }), "azimuth-mismatch");
    expect(res.reason).toMatch(/270/);
    expect(res.reason).toMatch(/90/);
  });

  test("a shot with no azimuth cannot carry a field at all", () => {
    reject(envelope({}), "azimuth-missing", { shotAzimuthDeg: undefined });
    reject(envelope({}), "azimuth-missing", { shotAzimuthDeg: null });
    reject(envelope({}), "azimuth-missing", { shotAzimuthDeg: "north" });
  });

  test("a due-north shot is a real shot, not a missing azimuth", () => {
    // 0 is the value a defaulted azimuth also takes, so this is the case that
    // proves the check tests presence rather than truthiness.
    const res = validateWindProfile(envelope({ azimuthDeg: 0 }), { shotAzimuthDeg: 0 });
    expect(res.ok).toBe(true);
  });

  test("an azimuth outside a compass is refused", () => {
    reject(envelope({ azimuthDeg: -10 }), "out-of-range", { shotAzimuthDeg: -10 });
    reject(envelope({ azimuthDeg: 400 }), "out-of-range", { shotAzimuthDeg: 400 });
    reject(envelope({ azimuthDeg: Infinity }), "out-of-range", { shotAzimuthDeg: 90 });
  });
});

describe("windProfile contract — axes and grids", () => {
  test("an axis must be a non-empty, strictly ascending run of finite numbers", () => {
    reject(envelope({ rangesYards: [] }), "malformed-axis");
    reject(envelope({ rangesYards: [0, 0] }), "malformed-axis");
    reject(envelope({ rangesYards: [100, 0] }), "malformed-axis");
    reject(envelope({ rangesYards: [0, NaN] }), "malformed-axis");
    reject(envelope({ rangesYards: "0,1000" }), "malformed-axis");
    reject(envelope({ heightsAglFt: [] }), "malformed-axis");
    reject(envelope({ heightsAglFt: [200, 100] }), "malformed-axis");
  });

  test("an axis must stay inside the world", () => {
    reject(envelope({ rangesYards: [-10, 1000] }), "out-of-range");
    reject(envelope({ rangesYards: [0, 99000] }), "out-of-range");
    reject(envelope({ heightsAglFt: [0, 99000] }), "out-of-range");
  });

  test("a grid must match the axes it is indexed by", () => {
    // [heightIndex][rangeIndex]. Transpose it and a 2 x 3 field silently
    // becomes a 3 x 2 one wherever the two happen to be conformable.
    reject(envelope({ heightsAglFt: [0, 100], vFps: [[0, 0]] }), "malformed-grid");
    reject(envelope({ vFps: [[0]] }), "malformed-grid");
    reject(envelope({ vFps: [[0, "x"]] }), "malformed-grid");
    reject(envelope({ vFps: [[0, null]] }), "malformed-grid");
    reject(envelope({ vFps: [0, 0] }), "malformed-grid");
    reject(envelope({ vFps: {} }), "malformed-grid");
  });

  test("a wind nobody has ever measured is refused", () => {
    // 300 fps is 205 mph. The real purpose is unit confusion: a field built in
    // m/s and labelled fps arrives 3.3x too slow and passes, but one built in
    // knots-times-something, or in cm/s, does not.
    reject(envelope({ vFps: [[0, 400]] }), "out-of-range");
    reject(envelope({ uFps: [[-500, 0]] }), "out-of-range");
  });
});

describe("windProfile contract — the vertical component", () => {
  test("a declared updraft is refused, because the solver cannot honour it", () => {
    // The contract carries w because the field has one. The 3DOF solver has no
    // vertical wind term, so accepting a non-zero w would mean throwing away a
    // number the caller deliberately measured.
    const res = reject(envelope({ wFps: [[0, 4]] }), "unsupported-vertical-wind");
    expect(res.reason).toMatch(/vertical/i);
  });

  test("a calm vertical component is fine, spelled either way", () => {
    expect(validateWindProfile(envelope({ wFps: null }), ctx).ok).toBe(true);
    expect(validateWindProfile(envelope({ wFps: [[0, 0]] }), ctx).ok).toBe(true);
  });

  test("a malformed w is a malformed grid, not a silent zero", () => {
    reject(envelope({ wFps: [[0]] }), "malformed-grid");
  });
});

describe("windProfile contract — metadata", () => {
  test("source must actually say something", () => {
    reject(envelope({ source: "" }), "malformed-field");
    reject(envelope({ source: "   " }), "malformed-field");
    reject(envelope({ source: null }), "malformed-field");
    reject(envelope({ source: 3 }), "malformed-field");
  });

  test("confidence is a probability", () => {
    reject(envelope({ confidence: 1.5 }), "out-of-range");
    reject(envelope({ confidence: -0.1 }), "out-of-range");
    reject(envelope({ confidence: "high" }), "out-of-range");
    expect(validateWindProfile(envelope({ confidence: 0 }), ctx).ok).toBe(true);
    expect(validateWindProfile(envelope({ confidence: 1 }), ctx).ok).toBe(true);
  });

  test("a resolution is a positive length in metres", () => {
    reject(envelope({ terrainResolutionM: 0 }), "out-of-range");
    reject(envelope({ terrainResolutionM: -10 }), "out-of-range");
    reject(envelope({ windSourceResolutionM: "3km" }), "out-of-range");
  });
});
