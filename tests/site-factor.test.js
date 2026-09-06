/**
 * Scoring a correction from a summary, graded against the pairs it summarises.
 *
 * `site-factor.js` never sees a pair. It reconstructs what the score would have
 * been after subtracting a constant from every error, out of the mean and the
 * root-mean-square that `score-wind.js --out` already wrote. That identity is
 * the whole tool, and it is exactly the kind of arithmetic that is plausible
 * while being wrong by a cross term — so it is graded here against pairs whose
 * answer is computed the long way, not against itself.
 */

"use strict";

const siteFactor = require("../tools/site-factor.js");

/** Model/observed speed pairs, from which a station summary is built. */
function summarise(id, pairs, terrainClass) {
  const n = pairs.length;
  const errors = pairs.map((p) => p.model - p.observed);
  const bias = errors.reduce((a, c) => a + c, 0) / n;
  const rmse = Math.sqrt(errors.reduce((a, c) => a + c * c, 0) / n);
  const observedMean = pairs.reduce((a, c) => a + c.observed, 0) / n;
  const modelledMean = pairs.reduce((a, c) => a + c.model, 0) / n;
  return {
    id: id,
    terrain: { class: terrainClass || "valley" },
    model: {
      n: n,
      speed: {
        biasMps: bias,
        rmseMps: rmse,
        observedMeanMps: observedMean,
        modelledMeanMps: modelledMean
      }
    }
  };
}

function runDoc(stations) {
  return { schemaVersion: 4, window: { hours: stations[0].model.n }, stations: stations };
}

/** The long way: subtract the constant from every error and score it. */
function bruteForce(pairsById, offsets) {
  let n = 0;
  let sum = 0;
  for (const id of Object.keys(pairsById)) {
    if (!(id in offsets)) continue;
    for (const p of pairsById[id]) {
      const residual = p.model - p.observed - offsets[id];
      sum += residual * residual;
      n += 1;
    }
  }
  return Math.sqrt(sum / n);
}

const PAIRS = {
  RIDGE: [
    { model: 7.2, observed: 4.1 },
    { model: 5.4, observed: 3.0 },
    { model: 9.9, observed: 6.2 },
    { model: 3.1, observed: 1.4 },
    { model: 6.0, observed: 4.4 },
    { model: 8.3, observed: 5.1 }
  ],
  VALLEY: [
    { model: 2.2, observed: 3.4 },
    { model: 1.8, observed: 2.9 },
    { model: 3.3, observed: 4.0 },
    { model: 0.9, observed: 2.2 },
    { model: 2.6, observed: 3.1 },
    { model: 4.1, observed: 5.5 }
  ]
};

const RUN = runDoc([summarise("RIDGE", PAIRS.RIDGE, "ridge"), summarise("VALLEY", PAIRS.VALLEY, "valley")]);

describe("scoring a per-station offset out of a summary", () => {
  test("matches the pairs it was summarised from, for any offset", () => {
    const run = siteFactor.readRun(RUN);
    for (const offsets of [
      { RIDGE: 0, VALLEY: 0 },
      { RIDGE: 1, VALLEY: -1 },
      { RIDGE: 2.4, VALLEY: -0.85 },
      { RIDGE: -3.7, VALLEY: 5.25 }
    ]) {
      const fromSummary = siteFactor.correctedRmse(run, (id) => offsets[id]);
      expect(fromSummary.rmseMps).toBeCloseTo(bruteForce(PAIRS, offsets), 12);
      expect(fromSummary.n).toBe(12);
    }
  });

  test("a station's own mean is the offset that minimises its score", () => {
    const run = siteFactor.readRun(RUN);
    const own = run.stations.find((s) => s.id === "RIDGE").biasMps;
    const best = siteFactor.correctedRmse(run, (id) => (id === "RIDGE" ? own : null)).rmseMps;
    for (const delta of [-0.4, -0.1, 0.1, 0.4]) {
      const worse = siteFactor.correctedRmse(run, (id) => (id === "RIDGE" ? own + delta : null)).rmseMps;
      expect(worse).toBeGreaterThan(best);
    }
  });

  test("a station left out is left out of the pair count, not corrected by zero", () => {
    const run = siteFactor.readRun(RUN);
    const only = siteFactor.correctedRmse(run, (id) => (id === "RIDGE" ? 0 : null));
    expect(only.n).toBe(6);
    expect(only.stations).toBe(1);
    expect(only.rmseMps).toBeCloseTo(bruteForce({ RIDGE: PAIRS.RIDGE }, { RIDGE: 0 }), 12);
  });
});

describe("transferring one run's offsets to another", () => {
  test("the four columns are over the same pairs, and hindsight is the floor", () => {
    const shifted = runDoc([
      summarise("RIDGE", PAIRS.RIDGE.map((p) => ({ model: p.model + 0.5, observed: p.observed })), "ridge"),
      summarise("VALLEY", PAIRS.VALLEY.map((p) => ({ model: p.model + 0.5, observed: p.observed })), "valley"),
      summarise("EXTRA", PAIRS.VALLEY, "valley")
    ]);
    const fit = siteFactor.readRun(RUN);
    const evaluated = siteFactor.readRun(shifted);
    const t = siteFactor.transfer(fit, evaluated);

    expect(t.stations).toBe(2);
    expect(t.raw.n).toBe(12);
    expect(t.pooled.n).toBe(12);
    expect(t.transferred.n).toBe(12);
    expect(t.hindsight.rmseMps).toBeLessThanOrEqual(t.transferred.rmseMps);
    expect(t.hindsight.rmseMps).toBeLessThanOrEqual(t.pooled.rmseMps);
    expect(t.pooled.rmseMps).toBeLessThanOrEqual(t.raw.rmseMps);
  });

  test("an offset carried from an identical run is the hindsight one", () => {
    const run = siteFactor.readRun(RUN);
    const t = siteFactor.transfer(run, siteFactor.readRun(RUN));
    expect(t.transferred.rmseMps).toBeCloseTo(t.hindsight.rmseMps, 12);
  });

  test("a per-station offset beats one pooled offset when the stations disagree", () => {
    const run = siteFactor.readRun(RUN);
    const t = siteFactor.transfer(run, run);
    expect(t.hindsight.rmseMps).toBeLessThan(t.pooled.rmseMps - 0.5);
  });
});

describe("repeatability", () => {
  test("reports the correlation of the offsets and of the ratios apart", () => {
    const a = siteFactor.readRun(
      runDoc(["A", "B", "C", "D"].map((id, i) => summarise(id, PAIRS.RIDGE.map((p) => ({ model: p.model + i, observed: p.observed })))))
    );
    const b = siteFactor.readRun(
      runDoc(["A", "B", "C", "D"].map((id, i) => summarise(id, PAIRS.RIDGE.map((p) => ({ model: p.model + i, observed: p.observed })))))
    );
    const rep = siteFactor.repeatability(a, b);
    expect(rep.stations).toBe(4);
    expect(rep.biasR).toBeCloseTo(1, 12);
    expect(rep.ratioR).toBeCloseTo(1, 12);
  });

  test("correlate refuses to invent a number from two points, or from a flat series", () => {
    expect(siteFactor.correlate([1, 2], [1, 2])).toBeNull();
    expect(siteFactor.correlate([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(() => siteFactor.correlate([1, 2, 3], [1, 2])).toThrow(/same length/);
  });
});

describe("what it refuses", () => {
  test("a document that is not a score-wind run", () => {
    expect(() => siteFactor.readRun({ hello: true })).toThrow(/not a score-wind/);
    expect(() => siteFactor.readRun(null)).toThrow(/not a score-wind/);
  });

  test("a run where no station clears the pair threshold, rather than reporting nothing", () => {
    expect(() => siteFactor.readRun(RUN, { minSamples: 24 })).toThrow(/no station in this run/);
  });

  test("a candidate the run does not carry", () => {
    expect(() => siteFactor.readRun(RUN, { candidate: "z0Rough" })).toThrow(/no station in this run/);
  });

  test("a station scored without a speed summary", () => {
    const broken = runDoc([summarise("RIDGE", PAIRS.RIDGE)]);
    delete broken.stations[0].model.speed;
    expect(() => siteFactor.readRun(broken)).toThrow(/no speed score/);
  });

  test("fewer than two files, and an unknown option", () => {
    expect(() => siteFactor.parseArgs(["one.json"])).toThrow(/at least two/);
    expect(() => siteFactor.parseArgs(["a.json", "b.json", "--nope"])).toThrow(/unknown option/);
    expect(() => siteFactor.parseArgs(["a.json", "b.json", "--min", "0"])).toThrow(/positive number/);
  });

  test("--fit and --eval name the files in that order", () => {
    const args = siteFactor.parseArgs(["--fit", "a.json", "--eval", "b.json", "--eval", "c.json"]);
    expect(args.files).toEqual(["a.json", "b.json", "c.json"]);
  });
});

describe("the report", () => {
  test("names every station and prints the hindsight row as such", () => {
    const run = siteFactor.readRun(RUN);
    const text = siteFactor.report([run, run], ["first", "second"]);
    expect(text).toContain("RIDGE");
    expect(text).toContain("VALLEY");
    expect(text).toContain("hindsight, not a result");
  });

  test("says that a summary cannot carry the scale columns, rather than omitting them silently", () => {
    const summary = siteFactor.report([siteFactor.readRun(RUN), siteFactor.readRun(RUN)], ["a", "b"]);
    expect(summary).toContain("a summary has no sum of squared model speeds");
    expect(summary).not.toContain("scale:pooled");

    const pairsRun = siteFactor.readRun(pairsDoc(PAIRS));
    const withPairs = siteFactor.report([pairsRun, pairsRun], ["a", "b"]);
    expect(withPairs).toContain("scale:pooled");
    expect(withPairs).toContain("The scale each station needs");
  });
});

describe("the station the fit never saw", () => {
  /**
   * Six stations whose scale really is a log-linear function of their terrain
   * position, observed over a model wind that differs station to station so
   * that a scale and an offset cannot be confused.
   */
  function sited(scaleOf, ids) {
    const pairs = {};
    const terrain = {};
    ids.forEach((id, i) => {
      const x = -60 + i * 24;
      terrain[id] = { positionIndexM: x, tpi: x / 100 };
      pairs[id] = [3, 5, 8, 11, 4, 9].map((model, h) => ({
        model: model + h * 0.5,
        observed: scaleOf(x) * (model + h * 0.5)
      }));
    });
    return { doc: pairsDoc(pairs, "model", terrain), terrain: terrain };
  }

  const IDS = ["A", "B", "C", "D", "E", "F"];
  const LOGLINEAR = (x) => Math.exp(-0.6 + 0.008 * x);

  test("terrain that really does set the scale predicts a station left out of the fit", () => {
    const run = siteFactor.readRun(sited(LOGLINEAR, IDS).doc);
    const h = siteFactor.holdout(run, run, "positionIndexM");
    expect(h.stations).toBe(6);
    expect(h.predicted.rmseMps).toBeLessThan(h.pooled.rmseMps);
    expect(h.predicted.rmseMps).toBeCloseTo(h.own.rmseMps, 6);
  });

  test("a held-out station's own wind is not in its own prediction", () => {
    const clean = sited(LOGLINEAR, IDS).doc;
    const spoiled = JSON.parse(JSON.stringify(clean));
    for (const row of spoiled.pairs) {
      if (row.station === "C") row.observed.speedMps *= 9;
    }
    const evalRun = siteFactor.readRun(clean);
    const before = siteFactor.holdout(siteFactor.readRun(clean), evalRun, "tpi");
    const after = siteFactor.holdout(siteFactor.readRun(spoiled), evalRun, "tpi");
    expect(after.predictedScale.C).toBeCloseTo(before.predictedScale.C, 12);
    // The other five were trained on C among others, so they must have moved:
    // otherwise the assertion above would hold for a fit that reads nothing.
    expect(after.predictedScale.D).not.toBeCloseTo(before.predictedScale.D, 6);
  });

  test("terrain that says nothing does no better than one scale for everyone", () => {
    const { doc } = sited(() => 0.5, IDS);
    // A constant scale is exactly what a pooled correction already gets right,
    // so a predictor may not beat it, and a flat predictor cannot be fitted.
    const run = siteFactor.readRun(doc);
    const flat = siteFactor.readRun(pairsDoc(
      Object.fromEntries(IDS.map((id) => [
        id,
        [4, 6, 5, 7, 3, 8].map((model) => ({ model: model, observed: model / 2 }))
      ])),
      "model",
      Object.fromEntries(IDS.map((id) => [id, { positionIndexM: 12 }]))
    ));
    expect(siteFactor.holdout(flat, flat, "positionIndexM").stations).toBe(0);
    const h = siteFactor.holdout(run, run, "positionIndexM");
    expect(h.pooled.rmseMps).toBeCloseTo(0, 9);
  });

  test("every column of a row covers the same pairs", () => {
    const run = siteFactor.readRun(sited(LOGLINEAR, IDS).doc);
    const h = siteFactor.holdout(run, run, "tpi");
    expect(h.raw.n).toBe(h.pooled.n);
    expect(h.raw.n).toBe(h.predicted.n);
    expect(h.raw.n).toBe(h.own.n);
    expect(h.raw.stations).toBe(6);
  });

  test("a station with no terrain to read is left out rather than guessed at", () => {
    const doc = sited(LOGLINEAR, IDS).doc;
    doc.stations.find((s) => s.id === "D").terrain = { class: "ridge" };
    const run = siteFactor.readRun(doc);
    const h = siteFactor.holdout(run, run, "positionIndexM");
    expect(h.stations).toBe(5);
    expect(h.predictedScale.D).toBeUndefined();
    expect(h.raw.n).toBe(30);
  });

  test("the holdout table is printed only when it is asked for", () => {
    const run = siteFactor.readRun(sited(LOGLINEAR, IDS).doc);
    const names = ["a", "b"];
    expect(siteFactor.report([run, run], names)).not.toContain("Leave one station out");
    const asked = siteFactor.report([run, run], names, { holdout: true });
    expect(asked).toContain("Leave one station out");
    expect(asked).toContain("the ceiling, not a prediction");
    for (const predictor of siteFactor.HOLDOUT_PREDICTORS.slice(0, 2)) {
      expect(asked).toContain(predictor);
    }
  });

  test("a summary has no terrain regression in it, and none is printed", () => {
    const summary = siteFactor.readRun(RUN);
    expect(siteFactor.report([summary, summary], ["a", "b"], { holdout: true }))
      .not.toContain("Leave one station out");
  });

  test("--holdout is a flag the parser knows about", () => {
    expect(siteFactor.parseArgs(["a.json", "b.json"]).holdout).toBe(false);
    expect(siteFactor.parseArgs(["--holdout", "a.json", "b.json"]).holdout).toBe(true);
  });

  test("a line through two points is refused, because it is not a fit", () => {
    expect(siteFactor.fitLine([[0, 1], [1, 2]])).toBeNull();
    expect(siteFactor.fitLine([[0, 1], [1, 2], [2, 3]]).slope).toBeCloseTo(1, 12);
  });
});

/** A `score-wind.js --pairs` document over the same model/observed pairs. */
function pairsDoc(pairsById, candidate, terrainById) {
  const key = candidate || "model";
  const terrain = terrainById || {};
  const rows = [];
  for (const id of Object.keys(pairsById)) {
    pairsById[id].forEach((p, i) => {
      rows.push({
        station: id,
        time: "2026-09-04T0" + i + ":00:00Z",
        observed: { speedMps: p.observed, fromDeg: 270, calm: false },
        modelled: { [key]: { speedMps: p.model, fromDeg: 275 } }
      });
    });
  }
  return {
    schemaVersion: 1,
    kind: "score-wind-pairs",
    candidates: [{ key: key }],
    stations: Object.keys(pairsById).map((id) => ({
      id: id,
      terrain: Object.assign({ class: "ridge" }, terrain[id] || {})
    })),
    pairs: rows
  };
}

/** The long way, for a scale: multiply the model and score what is left. */
function bruteForceScale(pairsById, scales) {
  let n = 0;
  let sum = 0;
  for (const id of Object.keys(pairsById)) {
    if (!(id in scales)) continue;
    for (const p of pairsById[id]) {
      const residual = scales[id] * p.model - p.observed;
      sum += residual * residual;
      n += 1;
    }
  }
  return Math.sqrt(sum / n);
}

describe("reading the pairs themselves", () => {
  test("reproduces every number the summary of the same pairs carries", () => {
    const fromPairs = siteFactor.readRun(pairsDoc(PAIRS));
    const fromSummary = siteFactor.readRun(RUN);
    expect(fromPairs.pairs).toBe(true);
    for (const id of ["RIDGE", "VALLEY"]) {
      const a = fromPairs.stations.find((s) => s.id === id);
      const b = fromSummary.stations.find((s) => s.id === id);
      expect(a.n).toBe(b.n);
      expect(a.biasMps).toBeCloseTo(b.biasMps, 12);
      expect(a.rmseMps).toBeCloseTo(b.rmseMps, 12);
      expect(a.observedMeanMps).toBeCloseTo(b.observedMeanMps, 12);
      expect(a.modelledMeanMps).toBeCloseTo(b.modelledMeanMps, 12);
    }
  });

  test("a pair the candidate never modelled is skipped, not scored as a calm", () => {
    const doc = pairsDoc(PAIRS);
    doc.pairs[0].modelled.model = null;
    const run = siteFactor.readRun(doc, { minSamples: 5 });
    expect(run.stations.find((s) => s.id === "RIDGE").n).toBe(PAIRS.RIDGE.length - 1);
  });

  test("refuses a candidate the run did not score, and a document that is neither kind", () => {
    expect(() => siteFactor.readRun(pairsDoc(PAIRS), { candidate: "downscaled" }))
      .toThrow(/no candidate downscaled/);
    expect(() => siteFactor.readRun({ kind: "score-wind-pairs" })).toThrow(/not a score-wind --pairs/);
  });
});

describe("scoring a per-station scale", () => {
  test("matches the pairs it was fitted over, for any scale", () => {
    const run = siteFactor.readRun(pairsDoc(PAIRS));
    for (const scales of [
      { RIDGE: 1, VALLEY: 1 },
      { RIDGE: 0.5, VALLEY: 1.4 },
      { RIDGE: 2.25, VALLEY: 0.08 }
    ]) {
      const scored = siteFactor.scaledRmse(run, (id) => scales[id]);
      expect(scored.rmseMps).toBeCloseTo(bruteForceScale(PAIRS, scales), 12);
      expect(scored.n).toBe(12);
    }
  });

  test("the fitted scale is the one that minimises the score", () => {
    const run = siteFactor.readRun(pairsDoc(PAIRS));
    const station = run.stations.find((s) => s.id === "RIDGE");
    const best = siteFactor.fitScale(station.stats);
    const at = (k) => siteFactor.scaledRmse(run, (id) => (id === "RIDGE" ? k : null)).rmseMps;
    for (const delta of [-0.2, -0.05, 0.05, 0.2]) {
      expect(at(best + delta)).toBeGreaterThan(at(best));
    }
  });

  test("a scale carried from an identical run is the hindsight one, and beats no correction", () => {
    const run = siteFactor.readRun(pairsDoc(PAIRS));
    const t = siteFactor.transferScale(run, run);
    expect(t.transferred.rmseMps).toBeCloseTo(t.hindsight.rmseMps, 12);
    expect(t.hindsight.rmseMps).toBeLessThanOrEqual(t.pooled.rmseMps);
    expect(t.pooled.rmseMps).toBeLessThanOrEqual(t.raw.rmseMps);
  });

  test("a proportional error transfers as a scale where it does not as an offset", () => {
    // Same sites, same 1.6x model bias, twice the wind. An offset fitted on the
    // calm day is the wrong size on the windy one; the scale is the same number.
    const calm = pairsDoc(PAIRS);
    const windy = pairsDoc({
      RIDGE: PAIRS.RIDGE.map((p) => ({ model: p.model * 2, observed: p.observed * 2 })),
      VALLEY: PAIRS.VALLEY.map((p) => ({ model: p.model * 2, observed: p.observed * 2 }))
    });
    const fit = siteFactor.readRun(calm);
    const evaluated = siteFactor.readRun(windy);

    const asScale = siteFactor.transferScale(fit, evaluated);
    expect(asScale.transferred.rmseMps).toBeCloseTo(asScale.hindsight.rmseMps, 12);

    const asOffset = siteFactor.transfer(fit, evaluated);
    expect(asOffset.transferred.rmseMps).toBeGreaterThan(asScale.transferred.rmseMps);
  });

  test("a scale cannot be scored from a summary at all, and says so", () => {
    const run = siteFactor.readRun(RUN);
    expect(() => siteFactor.scaledRmse(run, () => 1)).toThrow(/only be scored from a --pairs/);
  });
});
