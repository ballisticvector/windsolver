/**
 * Scoring a modelled wind against a measured one.
 *
 * Every test here is against a number worked out by hand or by an independent
 * argument, because a scorer graded against its own output is a scorer that
 * passes while being wrong by a factor — the same reason `grib2.js` is graded
 * against ecCodes and `cog.js` against GDAL.
 *
 * The ones worth keeping when this file is refactored are the three that catch
 * a score that looks fine: the wrap at north, a direction bias averaged the
 * arithmetic way, and a 180°-wrong wind scoring a perfect speed.
 */

"use strict";

const verify = require("../verify.js");

function observed(timeMs, speedMps, fromDeg, extra) {
  return Object.assign({
    time: new Date(timeMs).toISOString(),
    timeMs: timeMs,
    speedMps: speedMps,
    fromDeg: fromDeg,
    calm: speedMps === 0
  }, extra || {});
}

function sample(timeMs, speedMps, fromDeg) {
  return { timeMs: timeMs, speedMps: speedMps, fromDeg: fromDeg };
}

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 8, 1, 12);

describe("circular arithmetic", () => {
  test("350° and 10° are 20° apart, not 340°", () => {
    expect(verify.angleDifferenceDeg(10, 350)).toBe(20);
    expect(verify.angleDifferenceDeg(350, 10)).toBe(-20);
  });

  test("the difference is signed and lands in (-180, 180]", () => {
    expect(verify.angleDifferenceDeg(180, 0)).toBe(180);
    expect(verify.angleDifferenceDeg(0, 180)).toBe(180);
    expect(verify.angleDifferenceDeg(271, 90)).toBe(-179);
    expect(verify.angleDifferenceDeg(89, 270)).toBe(179);
  });

  test("a bias across north is the circular mean, not the arithmetic one", () => {
    // Errors of -20°, +20° and 0° average to 0 either way; errors that straddle
    // the wrap do not. This is the case where a mean of raw bearings reports a
    // 180° bias for a model that is right.
    expect(verify.circularMeanDeg([-20, 20, 0])).toBeCloseTo(0, 9);
    expect(verify.circularMeanDeg([170, -170])).toBeCloseTo(180, 6);
    expect(verify.circularMeanDeg([])).toBeNull();
  });

  test("the components agree with the engine's own convention", () => {
    // A wind FROM 270° blows toward the east.
    const west = verify.componentsOf(10, 270);
    expect(west.east).toBeCloseTo(10, 9);
    expect(west.north).toBeCloseTo(0, 9);
    const south = verify.componentsOf(10, 180);
    expect(south.north).toBeCloseTo(10, 9);
  });
});

describe("pairing an observation with a model time", () => {
  test("it takes the nearest sample and records the offset", () => {
    const paired = verify.pair(
      [observed(T0 + 5 * 60 * 1000, 5, 270)],
      [sample(T0, 5, 270), sample(T0 + HOUR, 9, 300)]
    );
    expect(paired.pairs).toHaveLength(1);
    expect(paired.pairs[0].offsetMs).toBe(-5 * 60 * 1000);
    expect(paired.pairs[0].sample.timeMs).toBe(T0);
  });

  test("an observation with no sample near it is dropped, not stretched", () => {
    const paired = verify.pair(
      [observed(T0 + 40 * 60 * 1000, 5, 270)],
      [sample(T0, 5, 270)]
    );
    expect(paired.pairs).toHaveLength(0);
    expect(paired.unmatched[0].code).toBe("no-sample");
    expect(paired.unmatched[0].offsetMs).toBe(40 * 60 * 1000);
  });

  test("several observations may share one hourly field, and the count says so", () => {
    const paired = verify.pair(
      [observed(T0 - 5 * 60 * 1000, 5, 270), observed(T0 + 5 * 60 * 1000, 6, 280)],
      [sample(T0, 5, 270)]
    );
    expect(paired.pairs).toHaveLength(2);
    const scored = verify.score(paired.pairs);
    expect(scored.n).toBe(2);
    expect(scored.distinctSamples).toBe(1);
  });

  test("two stations at the same hour are two samples, not one", () => {
    // Counting hours alone would report a five-station day as 24 samples and
    // make a wide comparison look like a narrow one.
    const a = verify.pair([observed(T0, 5, 270, { stationId: "KBDU" })],
      [sample(T0, 5, 270)]).pairs;
    const b = verify.pair([observed(T0, 7, 300, { stationId: "KBJC" })],
      [sample(T0, 5, 270)]).pairs;
    expect(verify.score(a.concat(b)).distinctSamples).toBe(2);
  });
});

describe("the score", () => {
  test("a perfect model scores zero everywhere", () => {
    const pairs = verify.pair(
      [observed(T0, 5, 270), observed(T0 + HOUR, 8, 180)],
      [sample(T0, 5, 270), sample(T0 + HOUR, 8, 180)]
    ).pairs;
    const s = verify.score(pairs);
    expect(s.n).toBe(2);
    expect(s.speed.biasMps).toBeCloseTo(0, 9);
    expect(s.speed.rmseMps).toBeCloseTo(0, 9);
    expect(s.direction.rmseDeg).toBeCloseTo(0, 9);
    expect(s.vectorRmseMps).toBeCloseTo(0, 9);
  });

  test("bias is signed and separate from RMSE", () => {
    // Errors of +2 and -2: no bias, 2 m/s of scatter. A model that is 2 too
    // fast everywhere would report bias 2 with the same RMSE, and wants a
    // completely different fix.
    const pairs = verify.pair(
      [observed(T0, 5, 270), observed(T0 + HOUR, 5, 270)],
      [sample(T0, 7, 270), sample(T0 + HOUR, 3, 270)]
    ).pairs;
    const s = verify.score(pairs);
    expect(s.speed.biasMps).toBeCloseTo(0, 9);
    expect(s.speed.maeMps).toBeCloseTo(2, 9);
    expect(s.speed.rmseMps).toBeCloseTo(2, 9);
  });

  test("a wind 180° wrong with the right speed does not score as perfect", () => {
    const pairs = verify.pair([observed(T0, 5, 270)], [sample(T0, 5, 90)]).pairs;
    const s = verify.score(pairs);
    expect(s.speed.rmseMps).toBeCloseTo(0, 9);
    expect(s.direction.rmseDeg).toBeCloseTo(180, 9);
    // Two 5 m/s winds pointing opposite ways differ by 10 m/s.
    expect(s.vectorRmseMps).toBeCloseTo(10, 9);
  });

  test("a direction error at the wrap is 20°, not 340°", () => {
    const pairs = verify.pair([observed(T0, 5, 350)], [sample(T0, 5, 10)]).pairs;
    const s = verify.score(pairs);
    expect(s.direction.rmseDeg).toBeCloseTo(20, 9);
    expect(s.direction.biasDeg).toBeCloseTo(20, 6);
  });

  test("a calm keeps its speed error and never invents a direction error", () => {
    // The station measured calm and reported 0°; the model says 6 m/s from
    // 090°. Taking that 0° at face value scores a 90° direction error against a
    // direction nobody measured.
    const pairs = verify.pair([observed(T0, 0, null)], [sample(T0, 6, 90)]).pairs;
    const s = verify.score(pairs);
    expect(s.speed.biasMps).toBeCloseTo(6, 9);
    expect(s.direction.n).toBe(0);
    expect(s.excluded.calm).toBe(1);
    // The vector error still carries it: 6 m/s claimed over still air.
    expect(s.vectorRmseMps).toBeCloseTo(6, 9);
  });

  test("a breath of wind is kept out of the direction statistics", () => {
    const pairs = verify.pair(
      [observed(T0, 0.5, 10), observed(T0 + HOUR, 6, 270)],
      [sample(T0, 0.5, 190), sample(T0 + HOUR, 6, 280)]
    ).pairs;
    const s = verify.score(pairs);
    expect(s.n).toBe(2);
    expect(s.direction.n).toBe(1);
    expect(s.excluded.belowDirectionThreshold).toBe(1);
    expect(s.direction.rmseDeg).toBeCloseTo(10, 9);
  });

  test("an observation with no direction is still evidence about speed", () => {
    const pairs = verify.pair([observed(T0, 6, null)], [sample(T0, 8, 270)]).pairs;
    const s = verify.score(pairs);
    expect(s.n).toBe(1);
    expect(s.speed.biasMps).toBeCloseTo(2, 9);
    expect(s.direction.n).toBe(0);
    expect(s.excluded.noDirection).toBe(1);
    expect(s.vectorRmseMps).toBeNull();
  });

  test("a sample the field could not give is counted, not treated as zero", () => {
    const pairs = verify.pair(
      [observed(T0, 6, 270), observed(T0 + HOUR, 6, 270)],
      [sample(T0, 6, 270), { timeMs: T0 + HOUR, speedMps: null, fromDeg: null }]
    ).pairs;
    const s = verify.score(pairs);
    expect(s.n).toBe(1);
    expect(s.excluded.missingSample).toBe(1);
    expect(s.speed.rmseMps).toBeCloseTo(0, 9);
  });

  test("two candidates are scored over one set of observations", () => {
    // The comparison the whole exercise exists for: downscaled against raw.
    const pairs = verify.pair(
      [observed(T0, 4, 270)],
      [{ timeMs: T0, raw: sample(T0, 7, 270), fine: sample(T0, 4.5, 270) }]
    ).pairs;
    const raw = verify.score(pairs, { read: (p) => p.sample.raw });
    const fine = verify.score(pairs, { read: (p) => p.sample.fine });
    expect(raw.speed.biasMps).toBeCloseTo(3, 9);
    expect(fine.speed.biasMps).toBeCloseTo(0.5, 9);
    expect(raw.n).toBe(fine.n);
  });

  test("an empty comparison reports nothing rather than zero", () => {
    const s = verify.score([]);
    expect(s.n).toBe(0);
    expect(s.speed.rmseMps).toBeNull();
    expect(s.direction.biasDeg).toBeNull();
    expect(s.vectorRmseMps).toBeNull();
  });
});

describe("scoring the shape of a wind rather than its size", () => {
  // A run whose model is a flat 50% too fast: the terrain terms cannot be read
  // off the raw score at all, because any multiplier below 1 improves it and
  // any multiplier above 1 makes it worse whatever the ground is doing.
  const pairs = verify.pair(
    [observed(T0, 4, 270), observed(T0 + HOUR, 8, 270), observed(T0 + 2 * HOUR, 6, 270)],
    [sample(T0, 6, 270), sample(T0 + HOUR, 12, 270), sample(T0 + 2 * HOUR, 9, 270)]
  ).pairs;

  test("the scale that removes the bias is the ratio of the means", () => {
    expect(verify.debiasScale(pairs)).toBeCloseTo(18 / 27, 9);
  });

  test("a scaled score is the same score of a rescaled wind", () => {
    const s = verify.score(pairs, { scale: verify.debiasScale(pairs) });
    expect(s.n).toBe(3);
    expect(s.speed.biasMps).toBeCloseTo(0, 9);
    expect(s.speed.modelledMeanMps).toBeCloseTo(6, 9);
    // The direction is untouched: a scale is a claim about how fast the wind
    // is, never about where it comes from.
    expect(s.direction.rmseDeg).toBeCloseTo(0, 9);
    expect(s.vectorRmseMps).toBeCloseTo(0, 9);
    expect(verify.score(pairs).vectorRmseMps).toBeGreaterThan(2);
  });

  test("scaling away the bias leaves the scatter it was hiding", () => {
    // Same mean error, different shape: one model is uniformly fast, the other
    // is fast on one hour and slow on another. Debiasing flatters the first
    // completely and the second not at all, which is the whole reason to look.
    const uniform = verify.pair(
      [observed(T0, 4, 270), observed(T0 + HOUR, 8, 270)],
      [sample(T0, 6, 270), sample(T0 + HOUR, 12, 270)]
    ).pairs;
    const scattered = verify.pair(
      [observed(T0, 4, 270), observed(T0 + HOUR, 8, 270)],
      [sample(T0, 10, 270), sample(T0 + HOUR, 8, 270)]
    ).pairs;

    expect(verify.score(uniform, { scale: verify.debiasScale(uniform) }).speed.rmseMps)
      .toBeCloseTo(0, 9);
    expect(verify.score(scattered, { scale: verify.debiasScale(scattered) }).speed.rmseMps)
      .toBeGreaterThan(1);
  });

  test("a scale is reported with the score, because it was fitted on it", () => {
    expect(verify.score(pairs, { scale: 0.5 }).scale).toBe(0.5);
    expect(verify.score(pairs).scale).toBe(1);
  });

  test("no wind to scale is no scale, not a division by zero", () => {
    expect(verify.debiasScale([])).toBeNull();
  });
});

describe("the floor under any score", () => {
  test("a whole knot and 10° cannot be beaten", () => {
    const floor = verify.quantisationFloor();
    // s/√12 for a value rounded to a step of s.
    expect(floor.speedRmseMps).toBeCloseTo(0.1485, 4);
    expect(floor.dirRmseDeg).toBeCloseTo(2.887, 3);
  });

  test("the floor rides along with every score, so it cannot be quoted without it", () => {
    const s = verify.score([]);
    expect(s.floor.dirRmseDeg).toBeCloseTo(2.887, 3);
  });
});

describe("terrain under a station", () => {
  test("position beats slope: a ridge is a ridge however gently it rises", () => {
    expect(verify.classifyTerrain({ positionIndexM: 22, slopeDeg: 2 })).toBe("ridge");
    expect(verify.classifyTerrain({ positionIndexM: -22, slopeDeg: 2 })).toBe("valley");
    expect(verify.classifyTerrain({ positionIndexM: 0.2, slopeDeg: 1 })).toBe("flat");
    expect(verify.classifyTerrain({ positionIndexM: 0.2, slopeDeg: 17 })).toBe("slope");
  });

  test("terrain nobody read is unknown, not flat", () => {
    // NaN is how a void arrives from `derive.js`, and calling it flat would put
    // every hole in the DEM into the class the model finds easiest.
    expect(verify.classifyTerrain({ positionIndexM: NaN, slopeDeg: NaN })).toBe("unknown");
    expect(verify.classifyTerrain(null)).toBe("unknown");
    // A 3 x 3 `tpi` is not a landform position and must not be read as one:
    // ten real RAWS on named ridges and gulches all sat inside ±0.4 m of it.
    expect(verify.classifyTerrain({ tpi: 9, slopeDeg: 2 })).toBe("unknown");
  });

  test("the ridge threshold is a landform-scale one, not the 3 x 3 field's", () => {
    // A station 9 m above its 500 m surroundings is on the shoulder, not the
    // crest; the old ±5 m was calibrated for an index that never reaches it.
    expect(verify.DEFAULT_POSITION_THRESHOLD_M).toBe(15);
    expect(verify.classifyTerrain({ positionIndexM: 9, slopeDeg: 12 })).toBe("slope");
    expect(verify.classifyTerrain({ positionIndexM: 9, slopeDeg: 12 }, { positionIndexM: 5 }))
      .toBe("ridge");
  });

  test("a score splits by class, and each class keeps its own count", () => {
    const pairs = verify.pair(
      [observed(T0, 4, 270), observed(T0 + HOUR, 4, 270)],
      [sample(T0, 6, 270), sample(T0 + HOUR, 4.5, 270)]
    ).pairs;
    pairs[0].terrain = "valley";
    pairs[1].terrain = "flat";
    const bands = verify.stratify(pairs, (p) => p.terrain);
    expect(bands.valley.n).toBe(1);
    expect(bands.valley.speed.biasMps).toBeCloseTo(2, 9);
    expect(bands.flat.speed.biasMps).toBeCloseTo(0.5, 9);
  });
});

describe("a station's published elevation against the ground under it", () => {
  test("agreement is within the tolerance, and the difference is reported either way", () => {
    const agree = verify.elevationCheck(3179.5, 3172.0);
    expect(agree.ok).toBe(true);
    expect(agree.differenceM).toBeCloseTo(7.5, 6);
  });

  test("a station a kilometre above its own terrain has the wrong coordinate", () => {
    // The failure this exists for: a pass station published at 3,153 m whose
    // coordinate plots in a city. Sampled there the terrain is flat, the class
    // is `flat`, and the station grades the downscaling on ground it has never
    // stood on — which is a wrong number that looks like a right one.
    const wrong = verify.elevationCheck(3153, 1609);
    expect(wrong.ok).toBe(false);
    expect(wrong.code).toBe("elevation-disagrees");
    expect(wrong.differenceM).toBeCloseTo(1544, 6);
  });

  test("no elevation on either side is not agreement", () => {
    expect(verify.elevationCheck(null, 1600).ok).toBe(false);
    expect(verify.elevationCheck(1600, NaN).code).toBe("no-elevation");
  });

  test("the tolerance is a choice, and it is stated in the result", () => {
    expect(verify.elevationCheck(3153, 3060, { toleranceM: 100 }).ok).toBe(true);
    expect(verify.elevationCheck(3153, 3060, { toleranceM: 100 }).toleranceM).toBe(100);
    expect(verify.elevationCheck(3153, 3060).ok).toBe(false);
  });
});
