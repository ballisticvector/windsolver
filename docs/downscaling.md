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
- [Measurement 6: the curvature term's two halves, through the debiased table](#measurement-6-the-curvature-terms-two-halves-through-the-debiased-table)
- [Measurement 7: six runs off the archive, and what roughness does to the bias](#measurement-7-six-runs-off-the-archive-and-what-roughness-does-to-the-bias)
- [Measurement 8: the first day Synoptic would not sell](#measurement-8-the-first-day-synoptic-would-not-sell)
- [The hypotheses, and how much weight each one carries](#the-hypotheses-and-how-much-weight-each-one-carries)
- [What would settle it](#what-would-settle-it)
- [Things that would poison the answer](#things-that-would-poison-the-answer)
- [Worth exploring, unranked](#worth-exploring-unranked)
- [What is not known](#what-is-not-known)
- [Claude's review](#claudes-review) - appended, per the review convention in `AGENTS.md`

## The question

Scored against RAWS stations it was not fitted to, the terrain downscaling is **no
better than raw HRRR overall and clearly worse on ridges.** That is the opposite of what
a terrain correction is for, and it happens on precisely the ground the correction
exists to handle.

The first version of that result was reported as "the downscaling is worse". It was not
wrong, but it was close to meaningless, for reasons in the next two sections. By
[measurement 6](#measurement-6-the-curvature-terms-two-halves-through-the-debiased-table)
the "clearly worse on ridges" half of the sentence has gone the same way: it is the
model's speed bias being multiplied on the stratum with the least room for it, and it
disappears when that bias is divided out.

## What the downscaling actually does

`downscale.js` bends a model wind with four separable pieces:

```js
const f = (1 + gains.slope * os + gains.curvature * oc) * (1 - gains.shelter * ox);
```

- **slope** — speed-up along the component of the slope facing the wind, `os`;
- **curvature** — speed-up over convex ground and slow-down in concave ground, `oc`.
  Those are two claims on one coefficient, and `curvatureConvex` / `curvatureConcave`
  grade them apart; each defaults to `curvature`, so naming neither changes nothing;
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

## Measurement 6: the curvature term's two halves, through the debiased table

The run [Claude's review](#claudes-review) parked, and the one measurement 5 asked for.
`Wc*Oc` makes two claims with one coefficient — a crest speeds the wind up, a hollow
slows it down — and the sign of `omegaC` separates them for nothing.
`downscale.js` now takes `curvatureConvex` and `curvatureConcave`, each defaulting to
`curvature`, so an ordinary field is unchanged; `--ablate` scores four more rows.

**This is not the same 312 pairs as measurements 1-5.** NOMADS had expired most of that
window's cycles by the time the split existed, so this is 13 stations x 24 hours ending
2026-09-05T19:00Z, f06 — the same stations, a different day. It is a repeat as well as a
split, which is worth having and is also why nothing below should be read as the same
sample moving.

Vector RMSE, m/s. `raw` is as scored; `debiased` divides each candidate's own overall
speed bias out, one scale over every pair.

```
                        overall            ridge (96)         valley (96)
candidate            raw   debiased     raw   debiased     raw   debiased
HRRR alone          3.22       2.25    3.23       2.54    3.39       2.17
downscaled          3.22       2.19    3.46       2.54    3.16       2.03
curvature only      3.24       2.20    3.49       2.55    3.18       2.04
no convex speed-up  3.12       2.22    3.20       2.54    3.16       2.08
no concave slow-down 3.29      2.20    3.46       2.53    3.37       2.10
convex only         3.31       2.21    3.49       2.54    3.39       2.11
concave only        3.14       2.23    3.23       2.55    3.18       2.10
```

**Raw, the whole ridge penalty is the convex half, and dropping it returns the ridge
column to the model's own score**: 3.46 becomes 3.20 against HRRR's 3.23. The concave
half is inert there, which is partly arithmetic — a ridge station's own pixel is convex
by the same 500 m operator that classifies it — and the mirror holds in valleys, where
the concave half carries the whole of the gain and the convex half does nothing at all.

**Debiased, none of it survives.** Every one of the ten candidates lands between 2.53 and
2.55 on ridges, HRRR included. That is the test the debiased table was added for, and it
comes back negative: the ridge penalty was the gain — convex ground is where the term
speeds the wind up, and speeding up a wind that is already about 1.7x too fast costs
vector RMSE wherever it happens. It is not a fact about where the term puts the wind, so
**hypothesis 1 as written is not supported**, and a candidate that clips the convex
response would be fitting the bias rather than the physics.

Two things that do not follow the same way:

- **The valley gain is not the concave half either.** Debiased, the whole term scores
  2.03 in valleys and each half alone scores 2.10 and 2.11, against HRRR's 2.17. Both
  signs contribute, and neither reproduces the pair.
- **Debiased, the whole ablation spans 0.06 m/s** — 2.19 to 2.25 against an error of
  2.2 m/s. Once the bias is out, on this sample, none of the terrain terms is doing much
  of anything in either direction. That is a smaller claim than "the correction hurts"
  and a smaller one than "the correction helps".

A second run over the *original* window agrees on the part that matters, on the 156 of
312 pairs whose cycles NOMADS still had: ridge raw 3.50 model, 3.62 downscaled, 3.49 with
the convex half dropped; ridge debiased 3.32, 3.30, 3.31. Same shape, same disappearance.

*Measured. Caveats that do not shrink: a different day from measurements 1-5, so the
strata are not in the same condition — the overall speed bias is +1.29 m/s here against
+1.62, and the ridge stratum is +0.81 against +0.30. 312 observations are 13 stations x 24
consecutive hours. The debias scale is fitted on the pairs it is then scored against.
"Convex" is the sign of `omegaC` at a 500 m length scale, which is a property of that
operator and not of the landform.*

Artefacts: `--ablate` over both windows.

## Measurement 7: six runs off the archive, and what roughness does to the bias

Two things arrived together. `archive.js` reads HRRR out of the AWS Open Data bucket a
message at a time, so a cycle NOMADS has forgotten can still be scored and "does it
repeat" stops being a question about the last two days. And `roughness.js` gives the
harness Davenport roughness classes and Wieringa's two-surface exposure correction, so
the single national `z0 = 0.03 m` in `downscale.heightFactor` can be scored against
alternatives instead of argued about. **Neither changes a default**: `roughness.js` is
research-only, nothing imports it from the runtime path, and `nomads.js` is untouched.

Six runs, all `--archive --exposure --ablate`: 2026-08-31, 09-02 and 09-04, each at f00
and f06, 13 Colorado RAWS x 24 hours, 30-minute pairing tolerance. 1776 pairs. The new
candidates all keep the default downscaling and change only the surface the wind is
brought down over: `z0 0.25/1.0 m` are one-step log-law substitutions for the 0.03 m
default, `z0 = SFCR` uses **HRRR's own published surface roughness at the station**, and
the `exposure` rows go up to a 60 m blending height over HRRR's surface and back down
over an asserted site surface, which is the correction Wieringa's method is actually for.

Overall vector RMSE, m/s, and each candidate's own speed bias:

```
                 08-31 f00   08-31 f06   09-02 f00   09-02 f06   09-04 f00   09-04 f06
candidate        bias  vec   bias  vec   bias  vec   bias  vec   bias  vec   bias  vec
HRRR alone       0.94 3.12   1.43 3.92   1.08 3.03   1.42 3.47   1.30 3.24   1.47 3.62
downscaled       1.10 3.14   1.60 4.00   1.20 3.02   1.54 3.50   1.42 3.27   1.59 3.69
z0 0.25 m        0.95 3.04   1.43 3.86   1.05 2.92   1.38 3.37   1.24 3.16   1.41 3.56
z0 = SFCR        0.89 2.99   1.35 3.79   0.99 2.90   1.31 3.34   1.18 3.12   1.34 3.52
z0 1.0 m         0.70 2.90   1.14 3.65   0.80 2.78   1.10 3.17   0.95 3.00   1.10 3.37
exposure rough   1.07 3.14   1.57 4.01   1.16 2.97   1.49 3.41   1.35 3.23   1.51 3.62
exposure v.rough 0.75 2.92   1.20 3.70   0.83 2.74   1.13 3.13   1.00 2.97   1.14 3.32
exposure closed  0.33 2.70   0.71 3.34   0.40 2.50   0.65 2.80   0.52 2.68   0.65 2.98
```

Three results, in increasing order of how much they should change anyone's mind.

**The bias repeats, and forecast hour is not incidental to it.** Observed mean is
2.13-2.15 m/s on all three days; HRRR is between +0.94 and +1.47 m/s fast, so "about 70%
fast" was the top of a range that runs from about 44%. **On every date the f06 bias is
0.17-0.49 m/s larger than the f00 bias from the same day.** These stations feed the
analysis, so f00 is graded on a field that has already been pulled toward them; the gap
is the size of that pull, and the f06 column is the honest one. Every earlier number in
this note taken at f00 understates the bias by roughly that much.

**Raw, the roughest exposure candidate wins every single run** — 0.4 to 0.6 m/s off the
vector RMSE, 13-16%, on three days and two lead times without exception. It is the
largest improvement anything in this investigation has produced.

**Debiased, it buys nothing.** Divide each candidate's own overall scale out and the
whole roughness family collapses onto the plain downscaling:

```
debiased vector RMSE       08-31 f00  08-31 f06  09-02 f00  09-02 f06  09-04 f00  09-04 f06
HRRR alone                      2.63       2.97       2.41       2.54       2.42       2.60
downscaled                      2.54       2.92       2.33       2.49       2.36       2.56
z0 = SFCR                       2.55       2.92       2.36       2.51       2.39       2.59
z0 1.0 m                        2.57       2.94       2.37       2.52       2.43       2.62
exposure closed                 2.57       2.94       2.34       2.48       2.41       2.59
```

Every roughness row is within 0.03 m/s of the plain downscaling and in most runs very
slightly *worse* than it. The fitted scales say the same thing from the other side: the
sample needs about x0.60, the roughest defensible exposure correction supplies x0.77-0.87,
and what it supplies is a **constant**. A per-station correction that behaves like a
constant is not measuring the station.

That is worth testing directly rather than inferring, so: per station, pooled over all
six runs, the scale that station actually needs — its observed mean over its modelled
mean — against HRRR's surface roughness under it.

```
station  class    n   SFCR   needs   z0=SFCR factor
LSTC2    slope  144  0.633   0.208            0.821
TS578    valley 144  0.154   0.303            1.000
TT532    valley 144  0.156   0.310            1.000
ESPC2    flat   144  0.241   0.402            0.867
PKLC2    ridge  144  0.678   0.453            0.816
KSHC2    ridge  144  0.311   0.507            0.858
DYGC2    slope  144  0.173   0.587            0.878
SODC2    slope  144  0.693   0.589            0.815
PCPC2    valley 144  0.477   0.758            0.838
BMOC2    flat   144  0.175   0.834            0.878
TS723    valley  48  0.225   0.835            0.576
RRAC2    ridge  144  0.623   1.225            0.822
STOC2    ridge  144  0.251   1.676            0.866
```

**The stations do not need one bias; they need scales from x0.21 to x1.68**, and the
correlation between what a station needs and the roughness under it is **r = -0.02**.
Not weak — absent. The correction the model's own roughness field prescribes correlates
with the correction the station wants at r = -0.27, which is the wrong sign. The +0.9 to
+1.5 m/s "bias" is the mean of a distribution eight times wider than itself, containing
two stations the model is too *slow* over, and aerodynamic roughness predicts no part of
where a station sits in it.

**Hypothesis 3's roughness half is therefore not supported.** SFCR over these thirteen
runs 0.15-0.69 m against the national 0.03 m, so the default really is wrong as a
description of the ground — and correcting it does not make the wind land in a better
place. It only slows everything down, and a single tuned constant does that better.

One thing did correlate, and it is not offered as a result. Against the 500 m
topographic position index the same needed scales give **r = +0.70**: sheltered ground
needs the wind slowed hard, exposed ground barely at all, which is the sheltering signal
the inert `Sx` term is supposed to carry. Then the leave-one-out checks: **drop STOC2 and
r falls to 0.31** — one station of thirteen carries it — and predicting a held-out
station's scale from the other twelve beats predicting the sample mean by 0.363 against
0.427, a 15% improvement on a two-parameter fit. **That is a hypothesis with one leverage
point under it, not a finding**, and it is the first thing more stations would settle.

*Measured, except where noted. Caveats: the exposure candidates' site roughness is an
asserted Davenport class, not a land-cover lookup at the station — "closed" is a
statement that these towers stand in something like closed forest, which for a Colorado
RAWS is a guess made to bracket the arithmetic. Three days is not a season, thirteen
stations is not a region, and 24 consecutive hours are not 24 independent samples. f00
is not independent of the analysis at all. The debias scale is fitted on the pairs it is
scored against. Pairing tolerance is 30 minutes here against 10 in earlier runs, which
changes which observations are in the sample.*

*The archive can reach 2014. The observation account cannot: Synoptic refused history
older than about six days with `does not have access to the requested history`, which is
why three recent dates were scored rather than three seasons. Archive-backed repeats over
arbitrary history are unblocked in the code and blocked on that token.* — *no longer:
`fems.js` reads the same RAWS back to 2005 without an account, and
[measurement 8](#measurement-8-the-first-day-synoptic-would-not-sell) is the first run
through it.*

Artefacts: `--archive --exposure --ablate`, six runs, JSON kept outside the repo.

## Measurement 8: the first day Synoptic would not sell

The last line of measurement 7 is that the archive reaches 2014 and the observation
account reaches about six days. `fems.js` removes that half of the wall: USDA FEMS serves
the same RAWS back to 2005 with no account. This is the first score in this note taken
over a window Synoptic refuses.

**2026-03-14 19:00Z to 2026-03-15 18:00Z, f00, archive HRRR, eleven calibrated Colorado
RAWS, 264 pairs, `--tolerance 30`** — roughly six months before any run above, and a
different season:

```
candidate      obs   spd bias  spd rmse  vec rmse        debiased: spd rmse  vec rmse
HRRR alone     264       2.21      4.54      5.92                      3.72      4.90
downscaled     264       2.50      4.35      5.81                      3.38      4.63

valley hrrr     48       5.13      6.26      7.27                      3.98      5.04
valley down     48       4.36      5.46      6.53                      3.32      4.43
ridge hrrr      96       0.44      4.49      5.63                      4.84      5.62
ridge down      96       1.49      4.42      5.73                      4.43      5.35
```

**The bias repeats in another season, and it is multiplicative rather than additive.**
This is the most useful thing in the run, and it needed a windy day to see. The observed
mean here is 5.14 m/s against 2.13-2.15 m/s on all six September runs — a genuinely
different regime, not another sample of the same one — and the bias goes up with it:

```
                observed   bias   model / observed
September runs      2.14   0.94-1.47      1.44-1.70x
March run           5.14   2.21           1.43x
```

An additive offset fitted on September would have predicted about +1.2 m/s in March and
under-read the error by a factor of two. A multiplicative one predicts 1.4-1.7x and lands.
Seven runs over two seasons and a 2.4x range of observed wind speed now say **HRRR is
proportionally fast, not fast by a fixed amount** — which is what makes the debiased table
the right instrument rather than a convenience, and which no amount of scoring inside one
week could have shown.

**The ridge penalty is present raw and absent debiased, for the third time.** 4.49 → 5.73
raw, 5.62 → 5.35 debiased. Measurement 6 concluded that on a different sample; it holds on
a sample from a different season, which is the first thing in this note to survive that
test.

**And the valley gain is the largest yet** — 5.04 → 4.43 debiased, 0.61 m/s, against
0.06 m/s spanning the entire ablation in measurement 6. Whatever the terrain terms do,
they do it in hollows and on a windier day.

One station is worth naming rather than averaging away. **DYGC2, Dry Gulch, ran 151° from
the model for all 24 hours** — mean absolute direction error 118°, within 30° on one hour
out of 24, observed 2.8 m/s against a modelled 6.6. That is what a drainage does to a
gradient wind, and **the downscaling cannot represent it at all: it scales speed and never
veers.** It is not a reader fault — FEMS and Synoptic agree on every direction this station
reported in the five overlapping days — but it is a March day read through a September
calibration, and a vane that had been knocked round would look identical. Directional
skill in channelled terrain is untested and this is the first evidence about it.

*Caveats: one day, one state, eleven stations, 24 consecutive hours. The 30-minute
tolerance is not optional here — at the 10-minute default, five of the eleven stations
have no observation inside the window at all, because their transmit slots are :19 to :25
off the hour. The transmit minutes were measured this September and applied to March;
nothing checks that a GOES slot never moved. f00 is not independent of the analysis, and
these are RAWS, which the analysis assimilates. The debias scale is fitted on the pairs it
is scored against.*

Artefacts: `--source fems --archive --tolerance 30`, JSON kept outside the repo.

## The hypotheses, and how much weight each one carries

Roughly in the order the evidence supports them.

1. **The curvature term is wrong on convex ground — tested, and not supported.**
   Measurements 3 and 5 put about 0.4 m/s of ridge penalty on the candidates carrying
   curvature, and measurement 6 shows it is all of it on the convex half and none of it
   left once each candidate's own speed bias is divided out: ten candidates inside
   0.02 m/s on ridges. The term is not misplacing the wind on crests; it is multiplying
   a wind that is already too fast, on the stratum with the least room for it. This is
   hypothesis 3 wearing hypothesis 1's clothes.
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
   The siting half of this — a RAWS tower stands in brush, not on the mown grass the
   default `z0 = 0.03 m` assumes — was **tested in measurement 7 and is not supported**:
   the default is wrong about the ground (HRRR's own SFCR reads 0.15-0.69 m at these
   stations) and correcting it improves nothing that a single constant does not improve
   more. What the stations need runs from x0.21 to x1.68 and correlates with roughness at
   r = -0.02. The bias is real, it repeats on three days, and it is **not** one bias: it
   is a per-station offset eight times wider than its own mean that nothing measured so
   far predicts.
4. **The sheltering signal is real and the term carrying it is inert — untested.** The
   same per-station scales correlate with the 500 m topographic position index at
   r = +0.70, which is the shape `Sx` claims and 1/50th of the amplitude it applies. One
   station of thirteen carries that correlation (drop it and r = 0.31), so this is where
   the next stations should go, not where the next coefficient should.
5. **The slope term does nothing as scored.** `os = alongWind / (2 * maxSlope)` is
   normalised by the domain's own steepest slope, so a station on a 20° slope in a domain
   containing a 50° cliff reads as gentle ground. Fixed physical scales exist now
   (`slopeScaleRad`, `curvatureScale`, `shelterScaleDeg`) but are off by default.
6. **Diversion is unearned.** It is a plausible piece of physics with no measured support
   in this sample and a small measured cost. It should either be justified against a
   station set where it can show itself, or turned off.
7. **The shelter term is the wrong shape for wind.** `Sx` in this form comes from the
   snow-redistribution literature; a term that moves the answer by 0.6% is either
   mis-scaled, mis-signed, or measuring something that does not limit surface wind.

## What would settle it

In cost order.

- ~~**Score a curvature term that cannot speed up a ridge.**~~ Run: measurement 6. The
  clipped candidate wins the raw ridge column and is indistinguishable from every other
  candidate once the bias is out, which is the curve-fitting this bullet warned about,
  caught by the debiased table rather than by judgement. **The successor question is the
  bias itself**, since that is now the only thing the ridge column was measuring.
- **Repeat measurement 5 at the terms' own wavelength.** The subtraction was done at 1 km
  and 3 km, which is HRRR's scale and not the terms' scale. A high-pass at 300–500 m
  would change the curvature input rather than leave it alone, and that is the version of
  hypothesis 2 that has not been scored.
- ~~**Repeat on other days.**~~ Run: measurement 7. `archive.js` reads
  `noaa-hrrr-bdp-pds` through the `.idx` byte ranges, so the model side is unblocked back
  to 2014; three dates x two lead times agree on the bias and on the roughness result.
  **What was still blocked is the observation side** — the Synoptic token refuses history
  older than about six days. It does not need an account: `docs/observations.md` measures
  USDA FEMS serving eleven of these thirteen stations back to 2005, free, 113,892 hourly
  rows for thirteen stations x one year in a single 7-second request. Read that note's
  timestamp section before pairing anything from it.
- **Repeat on other terrain.** Colorado RAWS are a convenience sample of fire-prone
  ground with road access, in one climate. The Cascades, the Appalachians and the Great
  Basin are all different problems.
- ~~**Score with a per-station roughness** instead of one constant.~~ Run: measurement 7,
  using HRRR's own SFCR as well as fixed Davenport classes. It survives all of it: the
  correction is a constant in disguise and correlates with what the stations need at
  r = -0.02. A land-cover source would be a better roughness and there is no longer a
  reason to expect it to matter.
- **Put stations where the sheltering hypothesis can be tested.** The one thing that did
  correlate with the per-station scales is topographic position, at r = +0.70 with a
  single leverage point holding it up. Ten more stations spread across the position index
  would either promote that to a finding or kill it, and it is the only live lead. FEMS
  publishes 2,088 RAWS with coordinates, so the station set can now be chosen by
  topographic position rather than by which ids were already to hand.
- **Separate the height correction from the terrain correction in the scoring** so a
  change in one cannot be credited to the other.

## Things that would poison the answer

Written down because each one has already nearly happened here.

- **An observation timestamp is not the time of the observation.** For one RAWS report
  MADIS and Synoptic both say `12:54`; FEMS says `13:00`, having rounded up to the
  following hour and dropped the minute. The pairing tolerance here is 10-30 minutes,
  smaller than that disagreement, so a source swap made without a per-station transmit
  offset would put a diurnal-cycle error into the column being measured — and every
  candidate would carry it equally, so the table would still look consistent.
- **312 observations are not 312 independent samples.** They are 13 stations × 24
  consecutive hours; a station's error at 14:00 is most of its error at 15:00. Any
  significance claim has to account for that, and none in this document does.
- **Forecast hour 0 grades an analysis fit, not a forecast.** NCEP assimilates surface
  observations, and measurement 7 puts a size on it: the f00 speed bias is 0.17-0.49 m/s
  smaller than the f06 bias from the same cycle on the same day. An f00 run is worth
  having beside an f06 one as a measure of that pull; it is not worth quoting alone.
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
`AGENTS.md`. Same standard: each claim says whether it was measured or reasoned about.
Nothing above this line was changed except one Contents entry.

**Verdict: measurement 5 is a stronger result than it is written up as.** It reads as a
null — the subtraction did not rescue the ridges — but combined with the shape of the
curvature operator it closes hypothesis 2 rather than leaving it open, and it rules out
the follow-up the note proposes for it. It also relocates the ridge penalty away from
the terrain input and onto the base state the correction assumes.

## The curvature operator is a band-pass, and that bounds the whole anomaly experiment

`scaleCurvature` measures, per axis, `(z0 - (z(-eta) + z(+eta)) / 2) / (2 * eta)` with
`eta = curvatureLengthM / 2`. That is a linear filter, so its response to a wavelength is
closed form:

```
R(lambda) = (1 - cos(2 * pi * eta / lambda)) / (2 * eta)
```

At `curvatureLengthM = 500` m:

| wavelength | % of peak response |
| --- | --- |
| 250 m | **0.0%** — a null |
| 500 m | **100%** — the peak |
| 1 km | 50.0% |
| 2 km | 14.6% |
| 3 km | 6.7% |
| 6 km | 1.7% |
| 50 km | 0.0% |

**The term is a band-pass centred on its own length, not a high-pass.** A linear ramp
gives exactly zero by construction, and so does a 250 m ripple.

Three things follow, and the first two are the note's own results explained rather than
merely recorded:

- **Measurement 5 was bounded to be almost a no-op before it ran.** Smoothing at radius
  `Rs` removes wavelengths longer than about `2 * Rs`. At `Rs = 3` km that is everything
  beyond 6 km, where the operator passes **1.7%** of peak; at `Rs = 1` km, beyond 2 km,
  where it passes 14.6%. A subtraction can only take away what the term was reading, and
  the term was barely reading it. Hence 3.97 to 3.93, and hence 1 km moving it by another
  0.01.
- **The double-counting mechanism was never available through this term.** HRRR's
  orography carries structure down to about 3 km; the curvature term passes 6.7% of that
  wavelength. The 41 m of resolved ridge in measurement 4 is real, but it sits almost
  entirely in a band the curvature term is deaf to. So hypothesis 2 is not merely
  unsupported by the run — the mechanism cannot reach this term. It should move to the
  bottom of the list, or off it.
- **The follow-up the note proposes for hypothesis 2 would delete the term, not correct
  it.** "A subtraction at the wavelength the terms work at" means `Rs` near 250–500 m,
  which removes wavelengths beyond 500–1000 m — where the operator passes 100% and 50%
  of peak. That does not sharpen the input; it subtracts the signal. Do not run it.

*Measured: the closed form and the table, computed from `scaleCurvature`'s own
arithmetic. Reasoned: that this is why measurement 5 came out where it did — the
prediction matches the measurement, which is not the same as having isolated the cause.*

## Where that leaves the ridge penalty

If the input surface is not the problem, the remaining candidates are the gain, the
normalisation, and the base state. The note's stratified speed biases point at the third:

```
stratum   HRRR speed bias
valley          +2.09
slope           +2.01
flat            +1.86
ridge           +0.30
```

**HRRR is not terrain-blind.** It is nearly seven times better on ridges than in
valleys, which means it already produces terrain-driven speed variation — not through
resolving the 500 m landform, but because a 3 km cell containing a ridge is dominated by
exposed ground and its wind reflects that. The downscaling multiplies as though the base
state carried none of this, so on the one stratum where the model needed no help it adds
help anyway.

That is a different claim from hypothesis 1 as written. "The curvature term is wrong on
convex ground" suggests the term's shape or sign is wrong. The evidence is equally
consistent with the term being right about the terrain and wrong about what it is
multiplying — which would predict exactly the observed asymmetry, because the headroom
for a correction is +2.09 in valleys and +0.30 on ridges.

The two are distinguishable, and the run that separates them is cheap: **score the
convex and concave halves of the curvature term separately.** If the term is wrong on
convex ground, the positive-curvature half hurts and the negative half helps. If the
base state is the problem, both halves are correctly signed and the convex one merely
has nothing left to correct. `omegaC` already carries the sign.

*Measured: the biases, from measurement 3. Reasoned, not measured: everything about what
HRRR's wind already contains — nothing here interrogated the model's own terrain
response.*

## The diversion row does not say what the note reads off it

The note reads the direction column as 70.5 degrees with the turning off and 70.8 with
it on, and hypothesis 5 rests on that. The table does not say it. Against the candidate
definitions in `tools/score-wind.js`:

| candidate | divert | speed weights | dir rmse |
| --- | --- | --- | --- |
| HRRR alone | — | — | 70.5 |
| no diverting | **off** | all on | 70.5 |
| diverting only | **on** | all zero | **70.5** |
| slope only | on | slope | 70.8 |
| curvature only | on | curvature | 70.8 |
| downscaled | on | all on | 70.8 |

`divertOnly` zeroes every gain but leaves `divert` at its default of true, and the
diverting angle does not depend on the gains. So the row that isolates the turning has
the turning **on**, and it costs nothing. 70.8 appears exactly when diversion *and* a
non-zero speed weight are both active — most likely `windAt`, which interpolates
east/north bilinearly, so once neighbouring cells carry different speeds the sampled
bearing is pulled toward the faster one.

**Hypothesis 5 is not supported by these rows.** The row that isolates diversion shows
no cost at all. Judging the term needs a direction score taken at the cell rather than
through a speed-weighted interpolation.

*Measured: the candidate definitions and the gain-independence of the diverting angle,
read from the code. Reasoned: the interpolation mechanism.*

## Roughness cannot carry hypothesis 3

The log law as `downscale.heightFactor` applies it, 10 m to a 6.1 m sensor:

| z0 | surface | factor | residual bias |
| --- | --- | --- | --- |
| 0.03 m | mown grass (current default) | x0.915 | x1.54 |
| 0.50 m | tall brush, scattered trees | x0.835 | x1.41 |
| 1.00 m | open forest | x0.785 | x1.33 |
| 3.00 m | city centre / tall forest | x0.589 | x1.00 |

Closing the x1.688 bias through the height correction alone needs **z0 near 3 m**, which
is not a RAWS site in Colorado. Grass to brush buys 8 points of a 69-point gap. A
per-station roughness is worth having on its own merits and it is not the explanation.

*Measured: the log law at the heights and roughness the harness uses. The z0 labels are
conventional values, not a land-cover lookup.*

*Run — [measurement 7](#measurement-7-six-runs-off-the-archive-and-what-roughness-does-to-the-bias),
with HRRR's own SFCR as well as fixed classes, and with Wieringa's two-surface form as
well as the one-step law. This section is right and understates itself: roughness cannot
carry hypothesis 3 even when the roughness is measured rather than assumed, because what
the stations need does not correlate with it at all.*

## The missing cell now exists

Every ridge number in this note is a raw score, with a 70% gain still in it — the
condition measurement 2 established contaminates a ranking. `score-wind.js` now reports
`debiasedByTerrain`: the same split as `byTerrain`, with each candidate's overall bias
divided out, one scale fitted over every pair and never refitted inside a stratum.

Run it before drawing anything further from the ridge column. If the ridge penalty
survives the debias it is a fact about where the term puts the wind; if it does not, it
was the gain all along and hypothesis 1 is chasing an artifact.

*Run — [measurement 6](#measurement-6-the-curvature-terms-two-halves-through-the-debiased-table).
It does not survive: ten candidates inside 0.02 m/s on the ridge column once the bias is
out. It was the gain.*

## What I did not verify

- **I ran none of the scoring.** Every number quoted from measurements 1-5 is the note's.
  The new table has unit tests and has not been run against a station.
- The band-pass table is arithmetic on the operator, not a measurement of terrain. Real
  ground is not a sinusoid; the filter response is exact, its consequence for these
  thirteen domains is inference.
- Nothing here tests what HRRR's wind already contains on a ridge. The base-state
  explanation is the most plausible remaining candidate, not a measured one.
- No claim about 3DEP coverage, the shelter term, or WindNinja.
