#!/usr/bin/env node
/**
 * How much of the model's error belongs to the station rather than to the day?
 *
 *   node tools/site-factor.js ws-runs/*.json
 *   node tools/site-factor.js --fit a.json --eval b.json
 *   node tools/site-factor.js pairs-a.json pairs-b.json     # scale as well as offset
 *
 * Options:
 *   --fit        run whose per-station offsets are used as the correction
 *   --eval       run those offsets are scored against (repeatable)
 *   --min        smallest paired-sample count a station may have (default 6)
 *   --candidate  which candidate's scores to read (default `model`, raw HRRR)
 *   --holdout    also predict each station's scale from terrain with that
 *                station left out of the fit, which is the only column here
 *                that answers what a pin with no anemometer would get
 *
 * A weather history is only worth storing if something in it repeats. This
 * reads the run summaries `tools/score-wind.js --out` already writes and asks
 * the narrowest version of that question: **take the mean error at each station
 * on one day, apply it as a correction on a different day, and see whether the
 * score improves.** If it does, the error has a component that belongs to the
 * site and history buys a correction. If it does not, every run is its own
 * weather and there is nothing to look up.
 *
 * It fits nothing and fetches nothing. For a candidate scored over `n` pairs
 * with mean error `b` and root-mean-square error `r`, subtracting a constant
 * `c` from every error gives
 *
 *     mean((d - c)^2) = r^2 - 2*c*b + c^2
 *
 * exactly, because the cross term is `n*b` by definition. So a correction
 * fitted on one run can be scored against another from the stored summaries
 * alone, with no pairs and no re-run — which is the only reason this is
 * arithmetic over old output rather than a seventh archive run.
 *
 * **Two things a summary cannot do.** It cannot condition on anything — hour,
 * stability, wind direction — because it is already averaged over all of them,
 * and it cannot hold out part of a day, so the only honest split is whole runs.
 * `docs/history.md` is where the argument for storing pairs is made.
 *
 * **The third thing it now can do, given `score-wind.js --pairs`: score a
 * scale.** Hand this tool a pairs document instead of a summary and every
 * column gains a multiplicative twin. That matters because the two families
 * disagree about what kind of error this is — an offset says the model is wrong
 * by a fixed *amount* at a site, a scale says it is wrong by a fixed
 * *proportion* — and they only look alike within one day's wind speeds.
 * Measurement 8 says the bias is proportional; measurement 9 could not test it,
 * because `mean(model^2)` is not in a summary.
 *
 * Each family is fitted by the rule that minimises the very score it is then
 * graded on — the mean error for the offset, least squares for the scale — so
 * the comparison is family against family and not one fitting rule against
 * another. A pairs document collapses to six numbers per station on the way in
 * (`n`, and the sums of `obs`, `obs^2`, `model`, `model^2` and `obs*model`),
 * over which both fits and both scores are exact; no pair is held in memory
 * after the file is read.
 *
 * The hindsight column is each run corrected by its own offsets. It is not a
 * result: it is fitted and scored on the same numbers, and it is printed as the
 * ceiling the transferred columns are trying to reach.
 */

"use strict";

const fs = require("fs");

const DEFAULT_MIN_SAMPLES = 6;
const DEFAULT_CANDIDATE = "model";

/**
 * Pull the per-station speed summary for one candidate out of a run.
 *
 * Refuses a file that is not a `score-wind.js --out` document rather than
 * reporting zero stations, because "no station cleared the threshold" and "this
 * is the wrong JSON" are otherwise the same empty table.
 */
function readRun(doc, opts) {
  const o = opts || {};
  const candidate = o.candidate === undefined ? DEFAULT_CANDIDATE : o.candidate;
  const minSamples = o.minSamples === undefined ? DEFAULT_MIN_SAMPLES : o.minSamples;

  if (doc && doc.kind === "score-wind-pairs") return readPairs(doc, o);

  if (!doc || typeof doc !== "object" || !Array.isArray(doc.stations)) {
    throw new Error("site-factor: not a score-wind --out document (no stations array)");
  }

  const stations = [];
  for (const station of doc.stations) {
    const scored = station[candidate];
    if (!scored || !scored.n || scored.n < minSamples) continue;
    const speed = scored.speed;
    if (!speed || !Number.isFinite(speed.rmseMps) || !Number.isFinite(speed.biasMps)) {
      throw new Error(
        "site-factor: station " + station.id + " has no speed score for candidate " + candidate
      );
    }
    stations.push({
      id: station.id,
      n: scored.n,
      biasMps: speed.biasMps,
      rmseMps: speed.rmseMps,
      observedMeanMps: speed.observedMeanMps,
      modelledMeanMps: speed.modelledMeanMps,
      ratio: speed.observedMeanMps > 0 ? speed.modelledMeanMps / speed.observedMeanMps : null,
      terrainClass: station.terrain ? station.terrain.class : null
    });
  }

  if (stations.length === 0) {
    throw new Error("site-factor: no station in this run has " + minSamples + " pairs for " + candidate);
  }

  return { window: doc.window || null, candidate: candidate, stations: stations, pairs: false };
}

/**
 * The same per-station view, out of a `score-wind.js --pairs` document.
 *
 * Every field a summary run carries is reproduced here from the pairs, so the
 * offset arithmetic, the repeatability and the report do not know which kind of
 * file they were given. What is added is `stats` — the six sums a
 * multiplicative fit needs — and it is the only reason to prefer this input.
 *
 * A pair whose candidate has no modelled speed is skipped rather than counted
 * as zero: `score-wind.js` reports those as `missingSample`, and a wind of zero
 * where the model declined to answer is the flattering kind of wrong.
 */
function readPairs(doc, opts) {
  const o = opts || {};
  const candidate = o.candidate === undefined ? DEFAULT_CANDIDATE : o.candidate;
  const minSamples = o.minSamples === undefined ? DEFAULT_MIN_SAMPLES : o.minSamples;

  if (!doc || !Array.isArray(doc.pairs) || !Array.isArray(doc.stations)) {
    throw new Error("site-factor: not a score-wind --pairs document (no pairs array)");
  }
  const known = new Set(doc.candidates ? doc.candidates.map((c) => c.key) : []);
  if (known.size && !known.has(candidate)) {
    throw new Error("site-factor: this run has no candidate " + candidate +
      "; it scored " + [...known].join(", "));
  }

  const byId = new Map();
  for (const p of doc.pairs) {
    const m = p.modelled ? p.modelled[candidate] : null;
    if (!m || !Number.isFinite(m.speedMps)) continue;
    const obs = p.observed ? p.observed.speedMps : null;
    if (!Number.isFinite(obs)) continue;
    let s = byId.get(p.station);
    if (!s) {
      s = { n: 0, obs: 0, obs2: 0, model: 0, model2: 0, cross: 0 };
      byId.set(p.station, s);
    }
    s.n += 1;
    s.obs += obs;
    s.obs2 += obs * obs;
    s.model += m.speedMps;
    s.model2 += m.speedMps * m.speedMps;
    s.cross += obs * m.speedMps;
  }

  const terrainOf = new Map(doc.stations.map((s) => [s.id, s.terrain || null]));
  const stations = [];
  for (const [id, s] of byId) {
    if (s.n < minSamples) continue;
    const bias = (s.model - s.obs) / s.n;
    const sumSquares = s.model2 - 2 * s.cross + s.obs2;
    const terrain = terrainOf.get(id) || null;
    stations.push({
      id: id,
      n: s.n,
      biasMps: bias,
      rmseMps: Math.sqrt(sumSquares / s.n),
      observedMeanMps: s.obs / s.n,
      modelledMeanMps: s.model / s.n,
      ratio: s.obs > 0 ? s.model / s.obs : null,
      terrainClass: terrain ? terrain.class : null,
      terrain: terrain,
      stats: s
    });
  }

  if (stations.length === 0) {
    throw new Error("site-factor: no station in this run has " + minSamples + " pairs for " + candidate);
  }

  return { window: doc.window || null, candidate: candidate, stations: stations, pairs: true };
}

/** The scale that minimises the squared error at a station: sum(o*m)/sum(m^2). */
function fitScale(stats) {
  return stats.model2 > 0 ? stats.cross / stats.model2 : null;
}

/**
 * Pooled RMSE over a run with each station's modelled speed multiplied by a
 * per-station scale.
 *
 * `k^2*sum(m^2) - 2k*sum(o*m) + sum(o^2)` is the exact sum of squares, so this
 * is the same kind of arithmetic as `correctedRmse` and not a re-scoring of
 * anything. `scaleFor` returning `null` leaves a station out entirely, which is
 * what keeps two runs over different station sets comparable.
 */
function scaledRmse(run, scaleFor) {
  if (!run.pairs) throw new Error("site-factor: a scale can only be scored from a --pairs document");
  let n = 0;
  let sumSquares = 0;
  const used = [];
  for (const s of run.stations) {
    const k = scaleFor(s.id);
    if (k === null || k === undefined) continue;
    if (!Number.isFinite(k)) throw new Error("site-factor: scale for " + s.id + " is not a number");
    n += s.n;
    sumSquares += k * k * s.stats.model2 - 2 * k * s.stats.cross + s.stats.obs2;
    used.push(s.id);
  }
  if (n === 0) return { n: 0, stations: 0, rmseMps: null };
  return { n: n, stations: used.length, rmseMps: Math.sqrt(sumSquares / n) };
}

/** The one scale the whole run shares, fitted over the pooled sums. */
function pooledScale(run, ids) {
  let cross = 0;
  let model2 = 0;
  for (const s of run.stations) {
    if (ids && !ids.has(s.id)) continue;
    cross += s.stats.cross;
    model2 += s.stats.model2;
  }
  return model2 > 0 ? cross / model2 : null;
}

/**
 * `transfer`, in the multiplicative family.
 *
 * Reported beside the additive columns rather than instead of them: the two
 * disagree about what kind of error the model has, and the disagreement is the
 * measurement. Same stations, same pairs, same hindsight caveat.
 */
function transferScale(fitRun, evalRun) {
  const fitted = new Map(
    fitRun.stations
      .map((s) => [s.id, fitScale(s.stats)])
      .filter((entry) => entry[1] !== null)
  );
  const shared = new Set(evalRun.stations.filter((s) => fitted.has(s.id)).map((s) => s.id));
  const pooled = pooledScale(evalRun, shared);

  return {
    stations: shared.size,
    raw: scaledRmse(evalRun, (id) => (shared.has(id) ? 1 : null)),
    pooled: scaledRmse(evalRun, (id) => (shared.has(id) ? pooled : null)),
    transferred: scaledRmse(evalRun, (id) => (shared.has(id) ? fitted.get(id) : null)),
    hindsight: scaledRmse(
      evalRun,
      (id) => (shared.has(id) ? fitScale(evalRun.stations.find((s) => s.id === id).stats) : null)
    )
  };
}

/**
 * The terrain a scale could be predicted from at a coordinate with no
 * anemometer on it. Every one of these is computed from the DEM and the model's
 * own orography, so a pin has all of them and a station has no privileged
 * field. `demElevationM` is in the list as a control: height above sea level is
 * not a sheltering mechanism, so a predictor that beats it has done something.
 */
const HOLDOUT_PREDICTORS = ["positionIndexM", "tpi", "slopeDeg", "modelOffsetM", "demElevationM"];

function predictorOf(station, name) {
  const value = station.terrain ? station.terrain[name] : null;
  return Number.isFinite(value) ? value : null;
}

/** Least-squares line through `[x, y]` points, or `null` with no spread in x. */
function fitLine(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p[0] - mx) * (p[1] - my);
    sxx += (p[0] - mx) * (p[0] - mx);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope: slope, intercept: my - slope * mx };
}

/**
 * The question a station table cannot answer: **what scale does a pin get?**
 *
 * Leave one station out. Fit the terrain-to-scale line on the others, predict
 * the held-out station's scale from its terrain alone, and score that
 * prediction on the held-out station's own pairs in another run. The prediction
 * has therefore never seen the station's wind, which is the situation a user
 * dropping a pin is in.
 *
 * The line is fitted in log space because the quantity is a multiplier: a
 * prediction that is wrong by a factor should cost the same whichever side of 1
 * it lands.
 *
 * `own` is the held-out station's own fitted scale carried over from the fit
 * run. It is not a prediction and it is not available at a pin — it is the
 * ceiling the terrain prediction is trying to reach, and the gap between
 * `pooled` and `own` is all there is to win.
 */
function holdout(fitRun, evalRun, predictor) {
  const inEval = new Map(evalRun.stations.map((s) => [s.id, s]));
  const usable = fitRun.stations
    .filter((s) => inEval.has(s.id))
    .map((s) => ({ id: s.id, scale: fitScale(s.stats), x: predictorOf(s, predictor), stats: s.stats }))
    .filter((s) => s.scale !== null && s.scale > 0 && s.x !== null);

  const pooled = new Map();
  const predicted = new Map();
  const own = new Map();
  for (const held of usable) {
    const train = usable.filter((s) => s.id !== held.id);
    const line = fitLine(train.map((s) => [s.x, Math.log(s.scale)]));
    if (!line) continue;
    let cross = 0;
    let model2 = 0;
    for (const s of train) {
      cross += s.stats.cross;
      model2 += s.stats.model2;
    }
    if (model2 <= 0) continue;
    pooled.set(held.id, cross / model2);
    predicted.set(held.id, Math.exp(line.intercept + line.slope * held.x));
    own.set(held.id, held.scale);
  }

  const pick = (map) => scaledRmse(evalRun, (id) => (map.has(id) ? map.get(id) : null));
  return {
    predictor: predictor,
    stations: predicted.size,
    predictedScale: Object.fromEntries(predicted),
    raw: scaledRmse(evalRun, (id) => (predicted.has(id) ? 1 : null)),
    pooled: pick(pooled),
    predicted: pick(predicted),
    own: pick(own)
  };
}

/**
 * Pooled RMSE over a run with a per-station constant subtracted from the error.
 *
 * `offsetFor` returns the constant for a station id, or `null` to leave that
 * station out entirely — which is what keeps two runs comparable when one of
 * them is missing a station.
 */
function correctedRmse(run, offsetFor) {
  let n = 0;
  let sumSquares = 0;
  const used = [];
  for (const s of run.stations) {
    const c = offsetFor(s.id);
    if (c === null || c === undefined) continue;
    if (!Number.isFinite(c)) throw new Error("site-factor: offset for " + s.id + " is not a number");
    n += s.n;
    sumSquares += s.n * (s.rmseMps * s.rmseMps - 2 * c * s.biasMps + c * c);
    used.push(s.id);
  }
  if (n === 0) return { n: 0, stations: 0, rmseMps: null };
  return { n: n, stations: used.length, rmseMps: Math.sqrt(sumSquares / n) };
}

/** The one bias the whole run shares, weighted by pairs. */
function pooledBias(run, ids) {
  let n = 0;
  let sum = 0;
  for (const s of run.stations) {
    if (ids && !ids.has(s.id)) continue;
    n += s.n;
    sum += s.n * s.biasMps;
  }
  return n === 0 ? null : sum / n;
}

/**
 * Score `evalRun` four ways: uncorrected, with one pooled offset, with the
 * per-station offsets measured on `fitRun`, and with its own (hindsight).
 *
 * Every column is restricted to the stations both runs have, so the four
 * numbers are over identical pairs and the differences between them are the
 * correction rather than the sample.
 */
function transfer(fitRun, evalRun) {
  const fitted = new Map(fitRun.stations.map((s) => [s.id, s.biasMps]));
  const shared = new Set(evalRun.stations.filter((s) => fitted.has(s.id)).map((s) => s.id));
  const keep = (id) => (shared.has(id) ? 0 : null);
  const pooled = pooledBias(evalRun, shared);

  return {
    stations: shared.size,
    raw: correctedRmse(evalRun, keep),
    pooled: correctedRmse(evalRun, (id) => (shared.has(id) ? pooled : null)),
    transferred: correctedRmse(evalRun, (id) => (shared.has(id) ? fitted.get(id) : null)),
    hindsight: correctedRmse(
      evalRun,
      (id) => (shared.has(id) ? evalRun.stations.find((s) => s.id === id).biasMps : null)
    )
  };
}

/** Pearson correlation, or `null` when either side has no spread. */
function correlate(xs, ys) {
  const n = xs.length;
  if (n !== ys.length) throw new Error("site-factor: correlate needs two series of the same length");
  if (n < 3) return null;
  const mx = xs.reduce((a, c) => a + c, 0) / n;
  const my = ys.reduce((a, c) => a + c, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Does the per-station error keep its shape between two runs?
 *
 * The offset and the ratio are reported apart because they disagree about what
 * kind of error this is: a stable offset says the model is wrong by a fixed
 * amount at a site, a stable ratio says it is wrong by a fixed proportion.
 */
function repeatability(a, b) {
  const byId = new Map(b.stations.map((s) => [s.id, s]));
  const pairs = a.stations.filter((s) => byId.has(s.id)).map((s) => [s, byId.get(s.id)]);
  const withRatio = pairs.filter((p) => p[0].ratio !== null && p[1].ratio !== null);
  return {
    stations: pairs.length,
    biasR: correlate(pairs.map((p) => p[0].biasMps), pairs.map((p) => p[1].biasMps)),
    ratioR: correlate(withRatio.map((p) => p[0].ratio), withRatio.map((p) => p[1].ratio))
  };
}

function fixed(value, places) {
  return value === null || value === undefined ? "—" : value.toFixed(places);
}

function report(runs, names, opts) {
  const o = opts || {};
  const lines = [];

  lines.push("Per-station speed error, candidate `" + runs[0].candidate + "`");
  lines.push("");
  const header = ["station".padEnd(8)].concat(names.map((n) => n.padStart(14)));
  lines.push(header.join(" ") + "     (bias m/s, model/observed)");
  const ids = [...new Set(runs.flatMap((r) => r.stations.map((s) => s.id)))].sort();
  for (const id of ids) {
    const cells = runs.map((r) => {
      const s = r.stations.find((x) => x.id === id);
      if (!s) return "—".padStart(14);
      return (fixed(s.biasMps, 2) + "  x" + fixed(s.ratio, 2)).padStart(14);
    });
    lines.push([id.padEnd(8)].concat(cells).join(" "));
  }

  if (runs.every((r) => r.pairs)) {
    // The ratio above and this are not the same number: the ratio is a
    // mean over a mean, and this is the multiplier that actually minimises the
    // squared error. They differ whenever the error is not proportional, which
    // is the thing being tested.
    lines.push("");
    lines.push("The scale each station needs, least squares, and the ground it stands on");
    lines.push("");
    lines.push(["station".padEnd(8)].concat(names.map((n) => n.padStart(9))).join(" ") + "   terrain");
    for (const id of ids) {
      const cells = runs.map((r) => {
        const s = r.stations.find((x) => x.id === id);
        return (s ? "x" + fixed(fitScale(s.stats), 3) : "—").padStart(9);
      });
      const known = runs.map((r) => r.stations.find((x) => x.id === id)).find(Boolean);
      lines.push([id.padEnd(8)].concat(cells).join(" ") + "   " + (known.terrainClass || "—"));
    }
  }

  lines.push("");
  lines.push("Does the shape repeat?");
  lines.push("");
  lines.push("pair                                     stations   bias r  ratio r");
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const rep = repeatability(runs[i], runs[j]);
      lines.push(
        (names[i] + " vs " + names[j]).padEnd(40) +
          String(rep.stations).padStart(10) +
          fixed(rep.biasR, 2).padStart(9) +
          fixed(rep.ratioR, 2).padStart(9)
      );
    }
  }

  // The scale columns need every run to carry its sums, and a table with half
  // of them missing would read as a scale that did nothing. Either all the
  // files are pairs documents or none of the multiplicative columns appear.
  const scalable = runs.every((r) => r.pairs);

  lines.push("");
  lines.push("Pooled speed RMSE, m/s, over the stations both runs hold");
  lines.push("— every column of a row covers the same pairs, so `pairs` moves between rows");
  if (scalable) {
    lines.push("— `offset` subtracts m/s from the error, `scale` multiplies the modelled speed");
  } else {
    lines.push("— offsets only: a summary has no sum of squared model speeds to fit a scale over");
  }
  lines.push("");
  lines.push("scored on              corrected by                       pairs     raw" +
    (scalable
      ? "   offset:pooled  station    scale:pooled  station"
      : "   pooled  station"));

  const row = function (evalName, fitName, t, s, useHindsight) {
    let text = evalName.padEnd(22) + fitName.padEnd(34) +
      String(t.raw.n).padStart(6) + fixed(t.raw.rmseMps, 3).padStart(8) +
      fixed(t.pooled.rmseMps, 3).padStart(15) +
      fixed((useHindsight ? t.hindsight : t.transferred).rmseMps, 3).padStart(9);
    if (s) {
      text += fixed(s.pooled.rmseMps, 3).padStart(16) +
        fixed((useHindsight ? s.hindsight : s.transferred).rmseMps, 3).padStart(9);
    }
    return text;
  };

  for (let e = 0; e < runs.length; e++) {
    for (let f = 0; f < runs.length; f++) {
      if (f === e) continue;
      lines.push(row(names[e], names[f], transfer(runs[f], runs[e]),
        scalable ? transferScale(runs[f], runs[e]) : null, false));
    }
    lines.push(row(names[e], "itself (hindsight, not a result)", transfer(runs[e], runs[e]),
      scalable ? transferScale(runs[e], runs[e]) : null, true));
  }

  if (o.holdout && scalable) {
    lines.push("");
    lines.push("Can a station the fit never saw be given a scale? Leave one station out");
    lines.push("— the prediction reads terrain only, which is all a pin with no anemometer has");
    lines.push("— `own` is the held-out station's own fitted scale: the ceiling, not a prediction");
    lines.push("— picking the best predictor of five over this many stations is selection, not");
    lines.push("  validation; read the whole column before believing any row of it");
    lines.push("");
    lines.push("scored on         fitted on         predictor        stns   pairs" +
      "     raw  pooled  predicted     own");
    for (let e = 0; e < runs.length; e++) {
      for (let f = 0; f < runs.length; f++) {
        if (f === e) continue;
        for (const predictor of HOLDOUT_PREDICTORS) {
          const h = holdout(runs[f], runs[e], predictor);
          if (h.stations === 0) continue;
          lines.push(
            names[e].padEnd(18) + names[f].padEnd(18) + predictor.padEnd(16) +
            String(h.stations).padStart(4) + String(h.raw.n).padStart(8) +
            fixed(h.raw.rmseMps, 3).padStart(8) + fixed(h.pooled.rmseMps, 3).padStart(8) +
            fixed(h.predicted.rmseMps, 3).padStart(11) + fixed(h.own.rmseMps, 3).padStart(8)
          );
        }
      }
    }
  }

  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {
    files: [], fit: null, evals: [], holdout: false,
    minSamples: DEFAULT_MIN_SAMPLES, candidate: DEFAULT_CANDIDATE
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fit") args.fit = argv[++i];
    else if (arg === "--eval") args.evals.push(argv[++i]);
    else if (arg === "--min") args.minSamples = Number(argv[++i]);
    else if (arg === "--candidate") args.candidate = argv[++i];
    else if (arg === "--holdout") args.holdout = true;
    else if (arg.startsWith("--")) throw new Error("site-factor: unknown option " + arg);
    else args.files.push(arg);
  }
  if (args.fit) args.files = [args.fit].concat(args.evals, args.files);
  if (args.files.length < 2) throw new Error("site-factor: give at least two score-wind --out files");
  if (!Number.isFinite(args.minSamples) || args.minSamples < 1) {
    throw new Error("site-factor: --min must be a positive number of pairs");
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const runs = args.files.map((path) =>
    readRun(JSON.parse(fs.readFileSync(path, "utf8")), {
      candidate: args.candidate,
      minSamples: args.minSamples
    })
  );
  const names = args.files.map((path) => path.split("/").pop().replace(/\.json$/, ""));
  process.stdout.write(report(runs, names, { holdout: args.holdout }) + "\n");
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(String(err.message || err) + "\n");
    process.exit(1);
  }
}

module.exports = {
  readRun,
  readPairs,
  correctedRmse,
  pooledBias,
  transfer,
  fitScale,
  scaledRmse,
  pooledScale,
  transferScale,
  correlate,
  fitLine,
  holdout,
  HOLDOUT_PREDICTORS,
  repeatability,
  report,
  parseArgs,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_CANDIDATE
};
