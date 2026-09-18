"use strict";

// Stability, as a thing a caller can ask for by name.
//
// `r` is `(alpha_h/alpha_v)^2`: the price the solve charges for vertical
// displacement. At `r = 1` the cost is isotropic and air rides over a hill as
// readily as around it. Drive `r` down and going over gets expensive, so the
// flow is pushed around instead — which is channelling, and channelling is the
// whole reason a shooter wants terrain in the wind at all.
//
// Every saved place was solved at `DEFAULT_R = 1`, which is the setting that
// suppresses horizontal turning most, and that is what a user looking at a map
// of near-parallel arrows was actually looking at. Measured over the
// Whittington wide domain, re-solved at four values:
//
//     r = 1      sd  2.96 deg    max  19.9
//     r = 0.5    sd  3.97 deg    max  27.1
//     r = 0.2    sd  5.78 deg    max  39.7
//     r = 0.05   sd 10.21 deg    max 108.3
//
// So the tests below are not about a constant having a particular value. They
// are about the direction of that relationship holding, because if it ever
// inverts then the name on the knob is a lie.

const mass = require("../mass.js");

/** A ridge across the flow, which is the thing a stable layer goes around. */
function ridge(width, height, spacingM, amplitude) {
  const elevation = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = (i - width / 2) / (width / 6);
      elevation[j * width + i] = 1800 + amplitude * Math.exp(-x * x);
    }
  }
  return { width, height, spacingM: { x: spacingM, y: spacingM }, elevation };
}

/** How far the wind is turned from the reference, cell by cell. */
function turning(terrain, r, fromDeg) {
  const basis = mass.solveBasis(terrain, { layers: 8, stretch: 1.25, r: r, maxIterations: 60000 });
  const solved = mass.combine(basis, { speedMps: 5, fromDeg: fromDeg === undefined ? 270 : fromDeg });
  const out = [];
  for (let j = 2; j < terrain.height - 2; j++) {
    for (let i = 2; i < terrain.width - 2; i++) {
      const w = mass.sampleAt(solved, i, j, 2);
      if (!w || !Number.isFinite(w.fromDeg)) continue;
      let d = w.fromDeg - (fromDeg === undefined ? 270 : fromDeg);
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      out.push(Math.abs(d));
    }
  }
  return {
    converged: basis.east.converged && basis.north.converged,
    rms: Math.sqrt(out.reduce((a, b) => a + b * b, 0) / out.length),
    max: out.reduce((a, b) => Math.max(a, b), 0)
  };
}

describe("the named settings", () => {
  test("are ordered the way the physics is", () => {
    expect(mass.STABILITY.stable).toBeLessThan(mass.STABILITY.neutral);
  });

  test("neutral is the isotropic default, not a second opinion about it", () => {
    // Two constants that are supposed to be the same number, pinned together.
    // A `neutral` that drifted off `DEFAULT_R` would mean a caller asking for
    // nothing and a caller asking for neutral get different fields.
    expect(mass.STABILITY.neutral).toBe(mass.DEFAULT_R);
  });

  // 0.1 is not a taste. `tools/score-wind.js` scores a `massStable` candidate
  // at exactly this value against CoAgMet, and that candidate beat neutral on
  // direction RMSE - 63.8 degrees against 65.1 over 288 valley observations.
  // If this number moves, that scoring run no longer says anything about what
  // the service ships.
  test("stable is the value that was actually scored", () => {
    expect(mass.STABILITY.stable).toBe(0.1);
  });

  test("names resolve, and anything else is refused", () => {
    expect(mass.rFor("stable")).toBe(mass.STABILITY.stable);
    expect(mass.rFor("neutral")).toBe(mass.STABILITY.neutral);
    expect(mass.rFor(undefined)).toBe(mass.DEFAULT_R);

    // Refused rather than defaulted. A caller who asks for "unstable" today
    // wants flow driven over the terrain, and quietly handing back neutral
    // would be answering a question nobody asked.
    for (const bad of ["unstable", "STABLE", "", "0.1", null, 0.1]) {
      expect(() => mass.rFor(bad)).toThrow(/stability/i);
    }
  });

  test("every named setting can be asked for by name", () => {
    for (const name of Object.keys(mass.STABILITY)) {
      expect(mass.rFor(name)).toBe(mass.STABILITY[name]);
    }
  });
});

describe("what the setting does to a wind crossing a ridge", () => {
  const terrain = ridge(64, 64, 40, 160);

  // The claim the knob makes, and the reason it is worth exposing at all. If
  // this ever fails, either the solver changed or the label is wrong; both are
  // worth stopping for.
  test("a stable layer turns the wind more than a neutral one", () => {
    const neutral = turning(terrain, mass.STABILITY.neutral);
    const stable = turning(terrain, mass.STABILITY.stable);

    expect(neutral.converged).toBe(true);
    expect(stable.converged).toBe(true);
    expect(stable.rms).toBeGreaterThan(neutral.rms);
    expect(stable.max).toBeGreaterThan(neutral.max);
  });

  test("and it is a difference worth a user's attention, not a rounding error", () => {
    const neutral = turning(terrain, mass.STABILITY.neutral);
    const stable = turning(terrain, mass.STABILITY.stable);
    // Measured at roughly 3.4x over the Whittington wide domain. Asserting a
    // factor rather than a value keeps this about the effect being real and
    // large while leaving the solver free to improve.
    expect(stable.rms / neutral.rms).toBeGreaterThan(1.5);
  });

  test("flat ground is unmoved by stability, because there is nothing to go around", () => {
    const flat = {
      width: 40, height: 40, spacingM: { x: 40, y: 40 },
      elevation: new Float32Array(40 * 40).fill(1800)
    };
    expect(turning(flat, mass.STABILITY.stable).rms).toBeCloseTo(0, 3);
    expect(turning(flat, mass.STABILITY.neutral).rms).toBeCloseTo(0, 3);
  });
});
