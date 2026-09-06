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
});
