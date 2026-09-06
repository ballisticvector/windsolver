/**
 * Aerodynamic roughness: what the surface around a mast does to the wind over
 * it, and how to move a wind between two surfaces as well as between two
 * heights.
 *
 * `downscale.heightFactor` already moves a wind up or down over *one* surface,
 * and it takes a single roughness length — 0.03 m, short grass, one number for
 * the whole country. That is the assumption the measurements in
 * `docs/downscaling.md` keep running into: HRRR is roughly 70% faster than the
 * RAWS anemometers it is scored against, and a RAWS mast does not stand on a
 * mown lawn. It stands in sage, in scrub oak, in a clearing in lodgepole.
 *
 * Two separate ideas live here, and confusing them is the whole risk:
 *
 * - **A roughness length is a property of a surface**, in metres, and the
 *   published values span four orders of magnitude — 0.0002 m over water,
 *   1 m over forest. `DAVENPORT` is Wieringa's revised Davenport classification,
 *   which is the standard table for choosing one from a description of the
 *   ground. It is a *class*, not a measurement, and the class is a judgement
 *   about a photograph.
 * - **An exposure correction moves a wind between two surfaces.** If the model
 *   thinks its cell is smooth and the mast is in scrub, the model's 10 m wind
 *   is not the mast's 10 m wind, and no single-surface log law can reconcile
 *   them: both winds are 10 m winds. Wieringa's two-step method goes up to a
 *   blending height over the model's surface, where the two boundary layers are
 *   assumed to agree, and back down over the site's. That is the only mechanism
 *   in this file that can produce a factor large enough to matter — a one-step
 *   correction from 6.1 m to 10 m over any plausible surface is between 0.79 and
 *   0.92, and the bias to be explained is 1.7.
 *
 * **Nothing here is wired into the downscaling.** It exists to be scored as a
 * candidate beside the others, on the same pairs, exactly as
 * `docs/downscaling.md` demands of anything that wants to become a default.
 *
 * Sources:
 *   Wieringa, J. (1992) "Updating the Davenport roughness classification",
 *     J. Wind Eng. Ind. Aerodyn. 41, 357-368: the class table.
 *   Wieringa, J. (1986) "Roughness-dependent geographical interpolation of
 *     surface wind speed averages", Q. J. R. Meteorol. Soc. 112, 867-889: the
 *     blending-height exposure correction, and the 60 m blending height.
 *   WMO No. 8, Part I, Chapter 5, Annex 5.A: the same correction as an
 *     operational recipe for reducing an observation to standard exposure.
 */

"use strict";

/**
 * Wieringa's revised Davenport classification, in metres.
 *
 * The names are the published ones and are kept verbatim, because "rough" and
 * "very rough" are terms of art here with photographs attached and not adjectives
 * anybody should re-interpret. `open` is 0.03 m and is where the downscaler's
 * current default comes from: it is the class for open country with scattered
 * low obstacles, which is also the exposure a synoptic station is *supposed* to
 * have.
 */
const DAVENPORT = {
  sea: 0.0002,
  smooth: 0.005,
  open: 0.03,
  "roughly-open": 0.10,
  rough: 0.25,
  "very-rough": 0.5,
  closed: 1.0,
  chaotic: 2.0
};

/**
 * Where the two surfaces' boundary layers are assumed to have blended.
 *
 * 60 m is Wieringa's, and it is a convention rather than a measurement: it is
 * high enough to be above the internal boundary layer of a patch of scrub and
 * low enough to still be in the surface layer. The correction's size depends on
 * it — a lower blending height makes every exposure correction weaker — so it is
 * a parameter here rather than a constant folded into the arithmetic.
 */
const DEFAULT_BLENDING_HEIGHT_M = 60;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** A class name or a number, as a roughness length in metres. */
function roughnessOf(spec) {
  if (typeof spec === "number") {
    if (!(spec > 0)) throw fail("bad-roughness", "a roughness length is positive metres: " + spec);
    return spec;
  }
  const z0 = DAVENPORT[String(spec)];
  if (z0 === undefined) {
    throw fail("bad-roughness", "no Davenport class is named " + JSON.stringify(spec) +
      "; known: " + Object.keys(DAVENPORT).join(", "));
  }
  return z0;
}

/** The neutral log-law ratio between two heights over one surface. */
function logRatio(toHeightM, fromHeightM, z0) {
  if (!(fromHeightM > z0 && toHeightM > z0)) {
    throw fail("bad-height", "both heights must be above the roughness length " + z0 + " m");
  }
  return Math.log(toHeightM / z0) / Math.log(fromHeightM / z0);
}

/**
 * The factor between a wind reported at one height over one surface and the
 * wind at another height over another.
 *
 * With one surface this is the plain log law and is identical to
 * `downscale.heightFactor` — deliberately, so that a candidate that names only a
 * roughness is comparable with the current default and the difference between
 * the two rows is the roughness alone.
 *
 * With two it is Wieringa's two-step correction:
 *
 *   U(zb) = U(zm) · ln(zb/z0m) / ln(zm/z0m)      up, over the model's surface
 *   U(zs) = U(zb) · ln(zs/z0s) / ln(zb/z0s)      down, over the site's
 *
 * The direction of the result is worth stating because it is the opposite of
 * the intuition: **a rougher site than the model gives a factor below one**, and
 * markedly so. Over 0.03 m the model's 10 m wind is only 1.31 times its 60 m
 * wind; over 0.8 m a 6.1 m wind is 0.47 of the 60 m wind. The product is 0.61 —
 * which is the size of correction the observed bias would need, and the reason
 * this is worth scoring at all.
 *
 * Neutral stability throughout, which is the same real assumption the one-step
 * law makes and is least true on exactly the clear valley nights where the model
 * is furthest out.
 */
function exposureFactor(opts) {
  const o = opts || {};
  const from = o.fromHeightM;
  const to = o.toHeightM;
  if (!(from > 0) || !(to > 0)) {
    throw fail("bad-height", "fromHeightM and toHeightM are metres above ground");
  }
  const site = roughnessOf(o.siteRoughnessM === undefined ? DAVENPORT.open : o.siteRoughnessM);
  if (o.modelRoughnessM === undefined || o.modelRoughnessM === null) {
    return logRatio(to, from, site);
  }
  const model = roughnessOf(o.modelRoughnessM);
  const blending = o.blendingHeightM === undefined ? DEFAULT_BLENDING_HEIGHT_M : o.blendingHeightM;
  if (!(blending > from) || !(blending > to)) {
    throw fail("bad-blending-height",
      "the blending height " + blending + " m must be above both the reported and the wanted height; " +
      "below one of them the correction extrapolates a surface layer downwards through itself");
  }
  // Identical surfaces collapse to the one-step law exactly, by construction:
  // ln(zb/z0)/ln(zm/z0) · ln(zs/z0)/ln(zb/z0) = ln(zs/z0)/ln(zm/z0). Worth
  // knowing, because it means a run whose site roughness comes from the model's
  // own field is *not* testing the exposure correction at all.
  return logRatio(blending, from, model) * logRatio(to, blending, site);
}

module.exports = {
  DAVENPORT,
  DEFAULT_BLENDING_HEIGHT_M,
  roughnessOf,
  logRatio,
  exposureFactor
};
