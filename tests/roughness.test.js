/**
 * The surface a wind belongs to.
 *
 * Two things are graded here and they are not the same thing: the log law over
 * one surface, which `downscale.heightFactor` already does and which this file
 * has to agree with exactly, and the two-step exposure correction, which is the
 * only mechanism in the repository that can move a wind by the size of the bias
 * `docs/downscaling.md` is about.
 *
 * The numbers are computed from the published formula rather than copied from a
 * run, because a module graded against its own output is graded against
 * nothing.
 */

"use strict";

const downscale = require("../downscale.js");
const roughness = require("../roughness.js");

describe("the Davenport classes", () => {
  test("a class name is its published roughness length", () => {
    expect(roughness.roughnessOf("open")).toBe(0.03);
    expect(roughness.roughnessOf("rough")).toBe(0.25);
    expect(roughness.roughnessOf("closed")).toBe(1.0);
  });

  test("the downscaler's default is the `open` class, not a number of its own", () => {
    // If these ever disagree, one of the two has been changed without the
    // other and a candidate named "site z0 0.25 m" is being compared with
    // something that is no longer 0.03 m.
    expect(downscale.DEFAULT_ROUGHNESS_M).toBe(roughness.DAVENPORT.open);
  });

  test("a number is taken as metres, and a bad one is refused", () => {
    expect(roughness.roughnessOf(0.4)).toBe(0.4);
    expect(() => roughness.roughnessOf(0)).toThrow(/positive metres/);
    expect(() => roughness.roughnessOf(-1)).toThrow(/positive metres/);
  });

  test("an unknown class is named and refused rather than defaulted", () => {
    // A misspelling that silently became 0.03 m would produce a candidate row
    // identical to the default under a name that says it is not.
    expect(() => roughness.roughnessOf("scrub")).toThrow(/no Davenport class is named/);
    expect(() => roughness.roughnessOf("scrub")).toThrow(/roughly-open/);
  });
});

describe("one surface", () => {
  test("it is the same log law the downscaling already uses", () => {
    for (const z0 of [0.03, 0.25, 1.0]) {
      expect(roughness.exposureFactor({ fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: z0 }))
        .toBeCloseTo(downscale.heightFactor(10, 6.1, z0), 12);
    }
  });

  test("a rougher surface takes more of the wind out of the same descent", () => {
    const open = roughness.exposureFactor({ fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 0.03 });
    const rough = roughness.exposureFactor({ fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 0.25 });
    expect(open).toBeCloseTo(Math.log(6.1 / 0.03) / Math.log(10 / 0.03), 12);
    expect(rough).toBeLessThan(open);
    // The whole range of plausible surfaces is worth 13% over this descent,
    // which is the reason a one-step candidate cannot explain a 1.7 bias.
    expect(open).toBeGreaterThan(0.9);
    expect(roughness.exposureFactor({ fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 1.0 }))
      .toBeGreaterThan(0.75);
  });

  test("the same height over the same surface is exactly one", () => {
    expect(roughness.exposureFactor({ fromHeightM: 10, toHeightM: 10, siteRoughnessM: 0.5 }))
      .toBe(1);
  });

  test("a height at or below the roughness length is refused", () => {
    expect(() => roughness.exposureFactor({
      fromHeightM: 10, toHeightM: 1, siteRoughnessM: 2
    })).toThrow(/above the roughness length/);
    expect(() => roughness.exposureFactor({ fromHeightM: 0, toHeightM: 6.1 }))
      .toThrow(/metres above ground/);
  });
});

describe("two surfaces, through a blending height", () => {
  test("it is Wieringa's product, up over the model and down over the site", () => {
    const factor = roughness.exposureFactor({
      fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 0.5, modelRoughnessM: 0.05
    });
    const up = Math.log(60 / 0.05) / Math.log(10 / 0.05);
    const down = Math.log(6.1 / 0.5) / Math.log(60 / 0.5);
    expect(factor).toBeCloseTo(up * down, 12);
  });

  test("identical surfaces collapse to the one-step law exactly", () => {
    // Which is why a candidate whose site roughness comes from the model's own
    // field is not testing the exposure correction at all, and the tool says
    // so in the row's own description.
    for (const z0 of [0.03, 0.3, 0.8]) {
      expect(roughness.exposureFactor({
        fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: z0, modelRoughnessM: z0
      })).toBeCloseTo(downscale.heightFactor(10, 6.1, z0), 12);
    }
  });

  test("a site rougher than the model slows the wind, and by enough to matter", () => {
    const factor = roughness.exposureFactor({
      fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 0.8, modelRoughnessM: 0.03
    });
    expect(factor).toBeLessThan(0.7);
    // A one-step correction over the same pair of heights cannot reach here
    // whatever surface it is given, which is the point of the two-step form.
    expect(factor).toBeLessThan(downscale.heightFactor(10, 6.1, 2.0));
  });

  test("a smoother site than the model speeds the wind up", () => {
    expect(roughness.exposureFactor({
      fromHeightM: 10, toHeightM: 10, siteRoughnessM: 0.03, modelRoughnessM: 0.5
    })).toBeGreaterThan(1);
  });

  test("it corrects between two winds at the same height, which one surface cannot", () => {
    const factor = roughness.exposureFactor({
      fromHeightM: 10, toHeightM: 10, siteRoughnessM: 0.5, modelRoughnessM: 0.05
    });
    expect(factor).toBeLessThan(0.85);
    expect(roughness.exposureFactor({ fromHeightM: 10, toHeightM: 10, siteRoughnessM: 0.5 }))
      .toBe(1);
  });

  test("a lower blending height makes the correction weaker", () => {
    const spec = { fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 0.8, modelRoughnessM: 0.03 };
    const high = roughness.exposureFactor(spec);
    const low = roughness.exposureFactor(Object.assign({ blendingHeightM: 30 }, spec));
    expect(low).toBeGreaterThan(high);
    expect(roughness.DEFAULT_BLENDING_HEIGHT_M).toBe(60);
  });

  test("a blending height below either wind's own height is refused", () => {
    // Below one of them the correction extrapolates a surface layer downwards
    // through itself, and still returns a plausible number.
    expect(() => roughness.exposureFactor({
      fromHeightM: 80, toHeightM: 6.1, siteRoughnessM: 0.5, modelRoughnessM: 0.03
    })).toThrow(/must be above both/);
    expect(() => roughness.exposureFactor({
      fromHeightM: 10, toHeightM: 6.1, siteRoughnessM: 0.5, modelRoughnessM: 0.03,
      blendingHeightM: 5
    })).toThrow(/must be above both/);
  });
});
