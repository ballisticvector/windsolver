#!/usr/bin/env node
/**
 * How much of the model's error belongs to the station rather than to the day?
 *
 *   node tools/site-factor.js ws-runs/*.json
 *   node tools/site-factor.js --fit a.json --eval b.json
 *
 * Options:
 *   --fit        run whose per-station offsets are used as the correction
 *   --eval       run those offsets are scored against (repeatable)
 *   --min        smallest paired-sample count a station may have (default 6)
 *   --candidate  which candidate's scores to read (default `model`, raw HRRR)
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
 * **Three things it cannot do, all of which need the pairs themselves.** It
 * cannot score a *multiplicative* correction, which is the form
 * `docs/downscaling.md` measurement 8 says the bias actually has, because
 * `mean(model^2)` is not in the summary. It cannot condition on anything —
 * hour, stability, wind direction — because the summary is already averaged
 * over all of them. And it cannot hold out part of a day, so the only honest
 * split is whole runs. All three are arguments for storing pairs, and
 * `docs/history.md` is where that argument is made.
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

  return { window: doc.window || null, candidate: candidate, stations: stations };
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

function report(runs, names) {
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

  lines.push("");
  lines.push("Pooled speed RMSE, m/s, over the stations both runs hold");
  lines.push("— every column of a row covers the same pairs, so `pairs` moves between rows");
  lines.push("");
  lines.push("scored on              corrected by                       pairs     raw   pooled  station");
  for (let e = 0; e < runs.length; e++) {
    for (let f = 0; f < runs.length; f++) {
      if (f === e) continue;
      const t = transfer(runs[f], runs[e]);
      lines.push(
        names[e].padEnd(22) +
          names[f].padEnd(34) +
          String(t.raw.n).padStart(6) +
          fixed(t.raw.rmseMps, 3).padStart(8) +
          fixed(t.pooled.rmseMps, 3).padStart(9) +
          fixed(t.transferred.rmseMps, 3).padStart(9)
      );
    }
    const own = transfer(runs[e], runs[e]);
    lines.push(
      names[e].padEnd(22) +
        "itself (hindsight, not a result)".padEnd(34) +
        String(own.raw.n).padStart(6) +
        fixed(own.raw.rmseMps, 3).padStart(8) +
        fixed(own.pooled.rmseMps, 3).padStart(9) +
        fixed(own.hindsight.rmseMps, 3).padStart(9)
    );
  }

  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { files: [], fit: null, evals: [], minSamples: DEFAULT_MIN_SAMPLES, candidate: DEFAULT_CANDIDATE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fit") args.fit = argv[++i];
    else if (arg === "--eval") args.evals.push(argv[++i]);
    else if (arg === "--min") args.minSamples = Number(argv[++i]);
    else if (arg === "--candidate") args.candidate = argv[++i];
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
  process.stdout.write(report(runs, names) + "\n");
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
  correctedRmse,
  pooledBias,
  transfer,
  correlate,
  repeatability,
  report,
  parseArgs,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_CANDIDATE
};
