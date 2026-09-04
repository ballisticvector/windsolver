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
- [The hypotheses, and how much weight each one carries](#the-hypotheses-and-how-much-weight-each-one-carries)
- [What would settle it](#what-would-settle-it)
- [Things that would poison the answer](#things-that-would-poison-the-answer)
- [Worth exploring, unranked](#worth-exploring-unranked)
- [What is not known](#what-is-not-known)
- [Claude's review](#claudes-review) — appended, per the review convention in `AGENTS.md`

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

## The hypotheses, and how much weight each one carries

Roughly in the order the evidence supports them.

1. **Double counting on ridges.** The correction is applied to the *absolute* landform,
   but the model has already resolved part of it — measurably so: 41 m of ridge at these
   four stations. A correction computed against the terrain *anomaly*, the fine DEM minus
   the model's own smoothed surface, would add only what is missing. Supported by
   measurements 3 and 4 and by the mechanism; **not yet tested on any observation.**
2. **The gain is the wrong thing to tune while the bias is 70%.** Whatever the terrain
   terms do, they are multiplying a wind that is far too fast over most of this sample.
   Some of that is siting rather than model error — a RAWS tower stands in brush, not on
   the mown grass the default `z0 = 0.03 m` assumes — so the roughness the height
   correction uses is a candidate in its own right, and it is currently one constant for
   every station in the country.
3. **The slope term does nothing as scored.** `os = alongWind / (2 * maxSlope)` is
   normalised by the domain's own steepest slope, so a station on a 20° slope in a domain
   containing a 50° cliff reads as gentle ground. Fixed physical scales exist now
   (`slopeScaleRad`, `curvatureScale`, `shelterScaleDeg`) but are off by default.
4. **Diversion is unearned.** It is a plausible piece of physics with no measured support
   in this sample and a small measured cost. It should either be justified against a
   station set where it can show itself, or turned off.
5. **The shelter term is the wrong shape for wind.** `Sx` in this form comes from the
   snow-redistribution literature; a term that moves the answer by 0.6% is either
   mis-scaled, mis-signed, or measuring something that does not limit surface wind.

## What would settle it

In cost order.

- **Score the terrain-anomaly variant.** Derive the weights from the DEM with the model's
  own orography subtracted — a high-pass at roughly 3 km — and run it as one more
  candidate through the ablation, same stations, same hours. If hypothesis 1 is right,
  the ridge penalty shrinks or disappears and the valley gain survives. This is the single
  highest-value next run, and it needs no new data.
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

---

# Claude's review

Added by Claude Code on top of the working note above, per the review convention in
`AGENTS.md`. Same standard applies: every claim says whether it was measured or reasoned
about. Nothing above this line was changed — where I disagree with it, I say so here, so
the original claim and the correction stay side by side.

**Verdict: the measurements are sound, and the note is harder on the downscaling than
its own data supports.** Two changes to the hypotheses. Numbers 3 and 4 are one
hypothesis rather than two, and it is about length scale rather than normalisation —
the code says so. And the diversion row does not say what the note reads off it.

## The headline comes from the one table that cannot see terrain

"No better than raw HRRR overall and clearly worse on ridges" is drawn from
[Measurement 1](#measurement-1-the-terms-one-at-a-time), which the note then explains is
a ranking of gains. [Measurement 2](#measurement-2-the-same-scores-with-each-candidates-own-bias-removed)
is the only table carrying terrain information, and there the downscaling **wins** —
2.56 against 2.60 vector RMSE, with curvature carrying it. That is weak, in-sample, and
not validation. It is also not a negative result, and the title reads as one.

The valley result is the strongest evidence in the document and it is buried in
Measurement 3. HRRR is +2.09 m/s too fast in valleys and +0.30 on ridges, and that
stratum pattern is itself terrain-shaped: a 3 km model cannot shelter a gulch. The
downscaling cut valley error 3.80 to 3.46 *while its mean gain was above 1* — it found a
reduction on the ground that needed one, against the direction of its own bias. Nothing
in a gain artifact does that.

*Reasoned from the note's own tables. No new run.*

## The three terms are measured at three different length scales

| Term | Measured over | Where |
| --- | --- | --- |
| curvature | **500 m** | `scaleCurvature`, `DEFAULT_CURVATURE_LENGTH_M` |
| slope | **~60 m** | Horn 3 x 3 in `derive.js`, at the 30 m `--resolution` default |
| diversion | **~60 m** | the same `os` and the same `aspectDeg` |

`downscale.js` argues this case itself, for curvature alone:

> at 1 m or 10 m spacing a 3 x 3 curvature measures the boulder, not the ridge

That argument applies verbatim to slope and aspect and was never applied to them. It
also predicts the ablation table: the one term measured at a terrain scale is the one
with skill, and the two measured at a boulder scale are the two without.

So "slope only reproduces raw HRRR to three figures" is not inertness, it is
cancellation. The along-wind cosine at a 60 m baseline is a zero-mean perturbation
across stations and hours — it adds noise and no bias, which is exactly a gain of
x1.007 with the error columns unmoved.

**This changes what hypothesis 3 implies.** Swapping the domain extreme for
`slopeScaleRad` while the term is still measured over 60 m makes it *larger* without
making it more meaningful, and the fixed-scale run would then look worse than the broken
one and be read as evidence against the term. Scale and normalisation have to move
together.

*Measured: the three length scales, read from `downscale.js`, `derive.js` and the
`--resolution` default in `tools/score-wind.js`. Reasoned, not measured: that the band
mismatch is why those two terms score as they do.*

## The diversion row does not say what the note reads off it

The note reads the direction column as 70.5 degrees with the turning off and 70.8 with
it on. The table does not say that. Read against the candidate definitions in
`tools/score-wind.js`:

| candidate | divert | speed weights | dir rmse |
| --- | --- | --- | --- |
| HRRR alone | — | — | 70.5 |
| no diverting | **off** | all on | 70.5 |
| diverting only | **on** | all zero | **70.5** |
| slope only | on | slope | 70.8 |
| curvature only | on | curvature | 70.8 |
| downscaled | on | all on | 70.8 |

`divertOnly` sets every gain to zero but leaves `divert` at its default of true, and the
diverting angle does not depend on the gains at all. So the row that isolates the
turning has the turning **on**, and it costs nothing. 70.8 appears exactly when
diversion *and* a non-zero speed weight are both active.

The likely mechanism is `windAt`: it interpolates east/north bilinearly, so once
neighbouring cells carry different speeds the sampled bearing is pulled toward the
faster one. Diversion alone rotates neighbouring cells almost equally and survives the
interpolation; diversion plus a speed weighting does not.

Whichever mechanism it is, **"diversion has no measured support and a small measured
cost" is not supported by these rows** — the row that isolates it shows no cost. Do not
retire the term on this evidence. If it is to be judged, it needs a direction score
taken at the cell rather than through a speed-weighted interpolation.

*Measured: the candidate definitions and the gain-independence of the diverting angle,
read from the code. Reasoned, not measured: the interpolation mechanism.*

## Hypothesis 1 is right, and the anomaly variant is the correct fix

Curvature at 500 m cannot tell a 500 m ridge from a 5 km one — both have positive crest
curvature, so the term fires on ground HRRR has already resolved, and
[Measurement 4](#measurement-4-the-ground-the-model-thinks-it-is-blowing-over) puts a
number on how much: 41 m of ridge. On a DEM-minus-model-orography surface, a broad ridge
the model already carries has near-zero anomaly and takes near-zero correction, which is
the wanted behaviour. `downscale.terrainOffset` already computes the scalar form of that
difference, so the machinery is half-built.

## Roughness cannot carry hypothesis 2

The log law as `downscale.heightFactor` applies it, HRRR's 10 m wind brought to a 6.1 m
sensor:

| z0 | surface | 10 m to 6.1 m | residual bias |
| --- | --- | --- | --- |
| 0.03 m | mown grass (current default) | x0.915 | x1.54 |
| 0.10 m | rough pasture | x0.893 | x1.51 |
| 0.50 m | tall brush, scattered trees | x0.835 | x1.41 |
| 1.00 m | open forest | x0.785 | x1.33 |
| 3.00 m | city centre / tall forest | x0.589 | x1.00 |

Closing the x1.688 bias by roughness alone needs **z0 around 3 m**, which is not a RAWS
site in Colorado. Moving from mown grass to brush buys 8 points of a 69-point gap. A
per-station roughness is worth having for its own sake, but it is not the explanation
for the bias, and hypothesis 2 should not sit second on the strength of it. The residual
is model bias, sensor exposure, or averaging — RAWS publish 10-minute means against a
near-instantaneous grid value.

*Measured: the log law, at the heights and roughness the harness actually uses. The z0
labels are conventional values, not a land-cover lookup.*

## The missing cell, and it is nearly free

The report carries `debiased` fitted over `allPairs`, and `byTerrain` scored raw. It
does not carry **debiased by stratum**, which is the cell that decides whether the ridge
penalty is real physics or the same gain artifact that Measurement 2 showed contaminates
everything else. Both primitives already exist and `stratify` passes its options
straight to `score`:

```js
const scale = verify.debiasScale(allPairs, opts);   // fitted on ALL pairs
verify.stratify(allPairs, classOf, Object.assign({}, opts, { scale: scale }));
```

**Fit the scale globally, not per stratum.** A per-stratum scale would divide out the
very stratum differences the table exists to show. The global scale asks the right
question: once each candidate's overall gain is granted, does it put the wind in the
right place on a ridge?

This should run before the anomaly variant. If the ridge penalty does not survive
debiasing, hypothesis 1 is fixing something that is not broken.

## The consumer drops the honesty fields

Cross-repo, and relevant to the note's closing line that `confidence` should stay
`null`. In `ballisticvector`, `windProfile.terrainResolutionM`, `windSourceResolutionM`
and `confidence` are accepted in the payload and **read by nothing** — not
`buildWindField`, not the solver's result, not the SPA. `AGENTS.md` there says these are
the engine being honest about what it knows and that BallisticVector displays them. The
contract says carried; the code drops them.

Worth closing regardless of how this note resolves, because on present evidence the
honest output is a band and not a point estimate. Three solves at the field's bounds
gives a shooter something to plan a follow-up around, instead of false precision resting
on one state and one day.

*Measured: grepped `lib/`, `public/` and `tests/` in `ballisticvector`.*

## Suggested order

1. **Debiased by stratum.** Hours of work, no new data, and it gates the next item.
2. **The terrain-anomaly variant**, as the note proposes. Still the right fix for the
   double counting, assuming step 1 leaves a ridge penalty to fix.
3. **Band-limit slope and aspect to the curvature's 500 m** and re-ablate, moving scale
   and normalisation together. If slope shows nothing at the right scale, that is when
   to retire it.
4. **Wire the AWS HRRR archive** (`noaa-hrrr-bdp-pds`). Everything here is one state and
   one day, and NOMADS' two-day window makes every repeat a race. This is the enabler
   for every "does it repeat" question in the note and should start in parallel.
5. **Per-station roughness**, downgraded from second to fifth, and bounded at about 8
   points of the bias.

Diversion is deliberately not on this list. It should not be touched until it has been
scored in a way that isolates it.

## What I did not verify

- **I ran none of the scoring.** Every number quoted from Measurements 1-4 is the note's;
  I re-read them against the code but did not reproduce a single station-hour.
- The roughness table is arithmetic on the log law, not a measurement of any station's
  actual roughness. It bounds what roughness *could* explain; it does not measure what
  it *does* explain.
- The band-mismatch explanation for slope and diversion is a reading of the code against
  the note's table. It predicts the observed pattern, which is not the same as having
  been tested — item 3 above is the test.
- The `windAt` interpolation mechanism for the 70.5/70.8 split is reasoned. The pattern
  it explains is measured; the explanation is not.
- No claim here about 3DEP coverage, HRRR skill or WindNinja. I read neither the
  ingestion path nor `verify.js` beyond `score`, `stratify` and `debiasScale`.
