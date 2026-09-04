# Why the terrain downscaling does not yet earn its place

A working note, not a conclusion. It records what has been measured against real
anemometers, what those measurements do and do not license anyone to say, and the
specific things that would settle the open questions. **No default and no formula has
been changed on the strength of anything in here**, and none should be until at least
the repeats in [What would settle it](#what-would-settle-it) have been run.

If you are picking this up cold: `downscale.js` is the module in question,
`tools/score-wind.js` is the harness, `tools/station-survey.js` chooses the stations and
`tools/model-terrain.js` produced the orography comparison below.

## Contents

- [The question](#the-question)
- [What the downscaling actually does](#what-the-downscaling-actually-does)
- [Measurement 1: the terms, one at a time](#measurement-1-the-terms-one-at-a-time)
- [Measurement 2: the same scores with each candidate's own bias removed](#measurement-2-the-same-scores-with-each-candidates-own-bias-removed)
- [Measurement 3: split by the ground the station stands on](#measurement-3-split-by-the-ground-the-station-stands-on)
- [Measurement 4: the ground the model thinks it is blowing over](#measurement-4-the-ground-the-model-thinks-it-is-blowing-over)
- [Measurement 5: subtracting that ground, and scoring it](#measurement-5-subtracting-that-ground-and-scoring-it)
- [The hypotheses, and how much weight each one carries](#the-hypotheses-and-how-much-weight-each-one-carries)
- [What would settle it](#what-would-settle-it)
- [Things that would poison the answer](#things-that-would-poison-the-answer)
- [Worth exploring, unranked](#worth-exploring-unranked)
- [What is not known](#what-is-not-known)

## The question

Scored against RAWS stations it was not fitted to, the terrain downscaling is **no
better than raw HRRR overall and clearly worse on ridges.** That is the opposite of what
a terrain correction is for, and it happens on precisely the ground the correction
exists to handle.

The first version of that result was reported as "the downscaling is worse". It was not
wrong, but it was close to meaningless, for reasons in the next two sections.

## What the downscaling actually does

`downscale.js` bends a model wind with four separable pieces:

```js
const f = (1 + gains.slope * os + gains.curvature * oc) * (1 - gains.shelter * ox);
```

- **slope** — speed-up along the component of the slope facing the wind, `os`;
- **curvature** — speed-up over convex ground and slow-down in concave ground, `oc`;
- **shelter** — a reduction by an upwind exposure/shelter index `Sx`, `ox`. **It is only
  derived when a caller asks for it**, so in every ordinary run this multiplies by one
  and the coefficient in the defaults is inert;
- **diversion** — a rotation of the direction, `-0.5 * os * sin(2 * (aspect - theta))`,
  which changes the bearing and not the speed.

Each is scored on its own by `tools/score-wind.js --ablate`.

## Measurement 1: the terms, one at a time

13 Colorado RAWS, 24 hours, forecast hour 6, 312 observations, one station-hour each.
Same stations, same hours, same domains, same 6.1 m sensor height for every candidate.

```
candidate          obs  spd bias  spd rmse  dir bias  dir rmse  vec rmse  gain
HRRR alone         312      1.49      2.64       9.5      70.5      3.63  x1.000
downscaled         312      1.61      2.67       9.9      70.8      3.70  x1.034
slope only         312      1.52      2.67       9.9      70.8      3.67  x1.007
curvature only     312      1.58      2.63       9.9      70.8      3.66  x1.031
no diverting       312      1.61      2.67       9.9      70.5      3.69  x1.034
diverting only     312      1.49      2.64       9.9      70.5      3.64  x1.000
shelter only       312      1.47      2.60       9.9      70.8      3.60  x0.994
no shelter         312      1.61      2.67       9.9      70.8      3.70  x1.038
```

**Read the `gain` column before the error columns.** HRRR's mean wind over these
stations is 3.63 m/s where the anemometers measure 2.15 — it runs about 70% fast — so
while an error that size dominates, every multiplicative candidate is being graded on
its *sign* and not on its physics. Every one of the five candidates with a gain above 1
scores worse than HRRR, the one with a gain below 1 scores better, and the one that
leaves the speed alone scores the same — in that order, and regardless of the ground the
station stands on. That is a ranking of gains, not a ranking of terrain models.

## Measurement 2: the same scores with each candidate's own bias removed

Same 312 pairs; each candidate's own mean observed/modelled speed ratio divided out
before scoring, direction untouched.

```
candidate          spd rmse  vec rmse
HRRR alone             1.75      2.60
downscaled             1.68      2.56
slope only             1.75      2.60
curvature only         1.69      2.56
no diverting           1.68      2.55
diverting only         1.75      2.60
shelter only           1.73      2.59
no shelter             1.69      2.56
```

- **Curvature carries the whole of the terrain correction.** Slope-only reproduces raw
  HRRR to three figures: as scored, it is doing nothing.
- **Diversion has no skill here and costs a little.** Direction RMSE is 70.5° with it off
  and 70.8° with it on in every stratum, and debiased it is the only candidate worse than
  the model.
- **Shelter is nearly inert even when a real `Sx` field is derived** — x0.994, six tenths
  of one per cent. It topped the raw table only because it is the one candidate that
  slows the wind down.

**This is an in-sample diagnostic and not validation.** The scale factor is fitted on the
same observations it is then scored against; it says which candidate has the better
*shape* once the mean is granted, which is a different and weaker claim than skill.

## Measurement 3: split by the ground the station stands on

Landform from `derive.positionIndexAt` over a 500 m disc: ridge at ≥ +15 m, valley at
≤ −15 m.

```
stratum   n    spd bias   vec rmse HRRR → downscaled
valley    96      +2.09       3.80 → 3.46
slope     72      +2.01       3.53 → 3.62
flat      48      +1.86       3.54 → 3.44
ridge     96      +0.30       3.58 → 4.05
```

**HRRR is already close to right on ridges and about 2 m/s too fast everywhere else.**
The downscaling improves valleys and flats, and on ridges — the one stratum where the
model had nothing left to give — it turns 3.58 into 4.05 by speeding an already
sufficient wind up further. That is exactly what a convex speed-up term is built to do.

## Measurement 4: the ground the model thinks it is blowing over

`tools/model-terrain.js`, HRRR surface orography for the same cycle against the 3DEP
ground under each station's published coordinate. Live run, 2026-09-04T18:00Z f06:

```
station    3DEP m  model m  model-3DEP    tpi500m   model tpi7.5km
PCPC2        2715     2774          59      -15.1            -13.2
TS578        2094     2202         108      -19.1            144.8
TS723        2252     2344          93      -17.5            108.5
TT532        2700     2722          21      -26.4            349.2
STOC2        2638     2552         -85       97.0            123.4
KSHC2        3101     3035         -66       40.5            -44.2
PKLC2        2835     2928          93       22.4             76.6
RRAC2        2810     2706        -104       33.7            160.1
LSTC2        3240     3220         -20       11.7            -20.8
DYGC2        2339     2266         -73       10.8           -184.2
SODC2        2905     3001          96      -10.0            -90.0
BMOC2        2719     2632         -87       12.8            148.4
ESPC2        2395     2415          19       -9.2           -176.6
```

By stratum:

```
stratum   n   mean model − 3DEP   mean tpi500m   mean model tpi7.5km
valley    4             +70 m           -19.5                +147.3
middle    5             -13 m             +3.2                 -64.7
ridge     4             -41 m            +48.4                 +78.9
```

That is the signature of smoothing, measured rather than assumed: **the model's ground
sits 70 m above the floor of a valley station and 41 m below the top of a ridge
station.** And the two landform indices agree in sign at only 7 of 13 stations — at the
model's scale, four of the four valley stations sit on *high* ground, because a gulch cut
into a plateau is a plateau to a 3 km grid.

**This is a disagreement, not an error on either side.** HRRR's orography is the ground
its dynamics actually ran over and is correct for that purpose; 3DEP is the ground the
anemometer stands on. The difference is the part of the landform the model could not see
— which is the only part a downscaling has any business adding.

## Measurement 5: subtracting that ground, and scoring it

The run measurement 4 asked for. `tools/score-wind.js --anomaly` derives the terrain
weights from the fine DEM **minus a smoothed regional surface** — `derive.smooth` over a
disc, `derive.anomaly` sampling it back by position — so the correction adds only the
landform the model could not resolve. Station elevation and the ridge/valley
classification still come from the unmodified DEM. Same 13 stations, same 24 hours, same
312 pairs, f06.

Ridge and valley vector RMSE, in m/s, at two smoothing radii:

```
candidate                 ridge (96)   valley (96)
HRRR alone                      3.58          3.80
downscaled                      3.97          3.59
fixed scales                    4.02          3.56
terrain anomaly, 3 km           3.93          3.62
terrain anomaly, 1 km           3.92          3.61
anomaly, fixed scales, 3 km     3.98          3.60
anomaly, fixed scales, 1 km     3.96          3.59
anomaly slope only              3.62          3.86
```

**The subtraction does not rescue the ridges.** 3.97 becomes 3.93, against 3.58 for the
raw model; halving the radius from 3 km to 1 km moves it by another 0.01. The terrain
anomaly is a strictly better-motivated input than the absolute landform, and on this
sample it buys about 1% of the ridge penalty.

The reason is a scale mismatch that measurement 4 did not expose: **the curvature term
reads a 500 m length and the slope term reads hillslope gradients, and neither of those
wavelengths is in a 1–3 km regional mean.** Removing the mean removes the part of the
landform the terms were already blind to. So the ridge penalty is not the model's own
orography being added twice through this pathway, and hypothesis 1 as written is not
supported.

Two things the run did show, neither of which is a result:

- **The slope term is the whole of the ridge penalty.** `anomaly slope only` scores 3.62
  on ridges against the model's 3.58, while every candidate carrying curvature sits near
  3.95. In measurement 2 curvature looked like the term doing the useful work; split by
  ground it is the term doing the damage, on the one stratum where the model needed no
  help.
- **A domain-relative weight hides a change in its own input.** Normalised against the
  domain's extremes, the residual and the DEM it came from each divide by their own
  largest value, so the anomaly gain (x1.040) and the absolute gain (x1.038) are almost
  the same number for visibly different terrain. The fixed-scale rows exist so the
  subtraction is graded rather than the divisor.

Artefacts: `--ablate --scales --anomaly` and the same with `--anomaly 1000
--anomaly-resolution 30`.

## The hypotheses, and how much weight each one carries

Roughly in the order the evidence supports them.

1. **The curvature term is wrong on convex ground.** Split by stratum, every candidate
   carrying curvature costs about 0.4 m/s of vector RMSE on ridges and the slope-only
   candidates cost almost nothing, on the one stratum where HRRR was already right.
   Supported by measurements 3 and 5.
2. **Double counting on ridges — tested, and not supported through this pathway.** The
   model has resolved part of the landform, measurably: 41 m of ridge at these four
   stations. Subtracting a 1–3 km regional surface before deriving the weights recovers
   0.04 of the 0.39 m/s ridge penalty (measurement 5), because the terms read 500 m and
   hillslope wavelengths that a regional mean does not contain. It stays on the list
   because the mechanism is real and only one implementation of it has been scored — a
   subtraction at the wavelength the *terms* work at, rather than at HRRR's grid scale,
   has not been.
3. **The gain is the wrong thing to tune while the bias is 70%.** Whatever the terrain
   terms do, they are multiplying a wind that is far too fast over most of this sample.
   Some of that is siting rather than model error — a RAWS tower stands in brush, not on
   the mown grass the default `z0 = 0.03 m` assumes — so the roughness the height
   correction uses is a candidate in its own right, and it is currently one constant for
   every station in the country.
4. **The slope term does nothing as scored.** `os = alongWind / (2 * maxSlope)` is
   normalised by the domain's own steepest slope, so a station on a 20° slope in a domain
   containing a 50° cliff reads as gentle ground. Fixed physical scales exist now
   (`slopeScaleRad`, `curvatureScale`, `shelterScaleDeg`) but are off by default.
5. **Diversion is unearned.** It is a plausible piece of physics with no measured support
   in this sample and a small measured cost. It should either be justified against a
   station set where it can show itself, or turned off.
6. **The shelter term is the wrong shape for wind.** `Sx` in this form comes from the
   snow-redistribution literature; a term that moves the answer by 0.6% is either
   mis-scaled, mis-signed, or measuring something that does not limit surface wind.

## What would settle it

In cost order.

- **Score a curvature term that cannot speed up a ridge**, since measurement 5 puts the
  ridge penalty on curvature rather than on the absolute-versus-anomaly landform. The
  cheap version is a candidate with the convex half of the curvature response clipped;
  the honest version is finding out why a convex speed-up is wrong here at all, because
  clipping a term to fit 96 correlated hours is curve fitting.
- **Repeat measurement 5 at the terms' own wavelength.** The subtraction was done at 1 km
  and 3 km, which is HRRR's scale and not the terms' scale. A high-pass at 300–500 m
  would change the curvature input rather than leave it alone, and that is the version of
  hypothesis 2 that has not been scored.
- **Repeat on other days.** Everything above is **one state and one day.** NOMADS keeps
  roughly two days of cycles, so repeats either happen in near-real-time or come from the
  HRRR archive on AWS Open Data (`noaa-hrrr-bdp-pds`), which is complete back to 2014 and
  supports byte-range reads through the `.idx` files. Wiring that as a second source is
  the enabler for every "does it repeat" question here.
- **Repeat on other terrain.** Colorado RAWS are a convenience sample of fire-prone
  ground with road access, in one climate. The Cascades, the Appalachians and the Great
  Basin are all different problems.
- **Score with a per-station roughness** instead of one constant, from a land-cover
  source, and see how much of the 2 m/s survives it.
- **Separate the height correction from the terrain correction in the scoring** so a
  change in one cannot be credited to the other.

## Things that would poison the answer

Written down because each one has already nearly happened here.

- **312 observations are not 312 independent samples.** They are 13 stations × 24
  consecutive hours; a station's error at 14:00 is most of its error at 15:00. Any
  significance claim has to account for that, and none in this document does.
- **Forecast hour 0 grades an analysis fit, not a forecast.** NCEP assimilates surface
  observations. Everything here is f06 for that reason.
- **A terrain read that fails is not a model error.** `DMTC2` is excluded from the set
  because its domain returns `outside-tile`; counting it as a miss would flatter or
  damage the model at random.
- **A published station coordinate can be wrong.** `station-survey.js` flags a station
  whose published elevation disagrees with the 3DEP ground beneath it by more than 50 m.
  A station scored at the wrong coordinate is filed as model error.
- **Fitting a scale factor on the observations you then score against is a diagnostic.**
  Measurement 2 is useful and is not validation.
- **The normalisation used to depend on the size of the box requested.** Terrain terms
  were divided by the extremes *within the requested domain*, so the same coordinate over
  the same ground answered differently depending on how much neighbourhood came with the
  request — 9.95 m/s over an 800 m half-width against 8.13 m/s over 3200 m. Fixed scales
  are available now; the default is still the old behaviour, so two stations scored over
  different domains are still not strictly comparable unless `--scales` is passed.

## Worth exploring, unranked

Ideas that have not been costed and may be bad.

- **Blend by scale rather than choosing.** Take the synoptic flow from HRRR and the
  fine structure from the DEM anomaly, rather than multiplying one by a function of the
  other.
- **A stability-dependent correction.** Terrain channels and decouples very differently in
  a stable nocturnal boundary layer than in a convective afternoon one, and both HPBL and
  the surface temperature are already in the fetched fields. Splitting the existing
  scores by hour of day would show whether it is worth the complexity — the data for that
  split is already on disk.
- **Score the direction and the speed against different terms.** Diversion is a direction
  term being graded inside a vector RMSE dominated by a speed bias.
- **Compare against WindNinja** on the same domains. It is the reference implementation
  of mass-consistent terrain downscaling; if its mass-conserving solution shows the same
  ridge behaviour, the problem is not this formula. **Licensing:** WindNinja's momentum
  solver is OpenFOAM/GPL-3 — fine to run for research, a decision to be made before any
  self-hosted product ships. See `AGENTS.md`.
- **Use the model's own wind at multiple levels.** HRRR carries 10 m and 80 m; the shear
  between them says more about the local boundary layer than a fixed log profile with a
  constant roughness does.
- **Check whether the ridge stations are simply at their site's local maximum.** An
  anemometer on the very top of a ridge is in the accelerated flow the model is already
  producing at that height; the error may be a sampling-height problem rather than a
  terrain one.
- **Gust as a diagnostic.** HRRR's `GUST` is already fetched and RAWS publish gusts. A
  model that is too fast in the mean but right in the gust is telling a different story
  from one that is too fast in both.

## What is not known

- Whether any of this repeats outside one state and one day. **Nothing here has been
  reproduced on a second date.**
- Whether the valley result survives more than four stations.
- How much of the remaining +1.25 m/s is siting and roughness rather than model error.
- Whether curvature's sign and normalisation are physically right, or whether it is
  currently acting as an accidental proxy for something else.
- What a defensible `confidence` number would be. It is still `null`, and on this
  evidence it should stay `null`.
