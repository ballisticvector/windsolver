# Working on WindSolver

Notes for anyone — human or AI agent — picking up work here. `README.md` documents the
modules and the contract; this file covers the decisions that are not visible in the
code and that will otherwise be undone by accident.

## What this is

WindSolver turns a coordinate into an atmosphere over real ground: USGS 3DEP terrain,
NOAA HRRR through NOMADS, NCEI observations, terrain-aware downscaling, and live,
forecast, historical and climatology modes over the top.

**It is a product with its own users, not an engine factored out of a shooting app.**
windsolver.com serves boating, hiking, sailing, flying, fire and agriculture.
BallisticVector (ballisticvector.com) is one API consumer among them — the first one,
and the only one that exists today, which is a fact about the calendar and not about
the design.

## The line: WindSolver knows nothing about rifles

If a change needs a bullet, a barrel, a scope, a zero or a hold, it belongs in
BallisticVector. If it would be just as useful to a fire crew, a drone operator, a
sailplane pilot or an agronomist, it belongs here. Anything terrain- or
atmosphere-shaped that has quietly grown a reference to a projectile is on the wrong
side and should be moved back.

**The pressure to break this is a `forShot=` parameter the first time a shooting client
calls.** A wind solution custom to a rifle and load is a BallisticVector feature that
*consumes* the field; it is not a WindSolver tier. Sampling a field along a trajectory,
turning drift into a hold, and drawing it on a reticle all happen on the consumer's
side.

## The contract is published, not internal

`profile.js` is the `windProfile` v1 contract: a range × height grid of `u`/`v`/`w` in
the shooter's frame, with an azimuth, a source, two resolutions and a confidence. It
exists so there is **one definition of a valid field rather than two that drift**, which
is the whole reason this module is a dependency of the consumer rather than a copy in
it.

- Adding a key is cheap. Changing what an existing key *means* breaks a caller you
  cannot see — treat it the way you would treat a change to a published endpoint, and
  cut a new major tag.
- **A bad field is refused with a code and a reason, never quietly ignored and never
  partially applied.** Silence is the only outcome that reaches a user as a confident,
  wrong answer. `azimuth-mismatch` exists because a caller can be entirely
  self-consistent and still hand over a wind pointing somewhere else.
- `confidence` and the two resolution figures are the engine being honest about what it
  knows. A modelled wind presented as a measured one is the single worst thing either
  product can ship. Consumers display them; they do not swallow them for a cleaner
  screen.

## The shooter's grid is a projection, not the native shape

The general service answers over a **volume and a time**. A sailor and a fire crew have
no `azimuthDeg` to give it, so a range × height slice along a bearing must be a
documented *view* over a more general field, not the format everything else is bent
into.

**This decides the cache key, and that is the deadline.** `(bbox, level set, valid
time)` — never `(azimuth, ranges)`. Producing a slice at ingestion collapses two
dimensions early and then rebuilds them later, and once the fetch/cache layer has
picked its key, changing it is a rewrite rather than an edit. The map UI is several
steps downstream and inherits whatever this decides.

Order of work, which is deliberately not "general API first": get a real field over a
bbox and a time in memory, cache it, expose the slice the one existing consumer can
validate end to end — then the volume endpoint. A volume API with no consumer is the
same mistake as a shooter-shaped field, pointing the other way.

## Things that bite

Read the "Things that bite" section of `README.md` before touching ingestion: dataset
tags are matched verbatim, NOMADS answers a bad request with an HTML error page and
HTTP 200, the HRRR availability lag is an assumption rather than a measurement, and
coverage is sampled rather than exact.

**Request building is separated from request making** so that every bit of selection
logic, cycle arithmetic and box maths is testable with no network. Keep new code on the
same side of that line: a function that both decides what to fetch and fetches it
cannot be tested offline, and none of the interesting bugs are in the fetching.

**Measure before you size anything.** The numbers in `README.md` — 3 GB of 1 m terrain
for one coordinate, 2 KB for the atmosphere over the same box — came from live runs, and
they are why terrain is windowed rather than tile-fetched. Do not buy hardware, or
promise a latency tier, against a guess.

## Licensing, before anything is sold

If a tier ends up driven by WindNinja's momentum solver, that solver is OpenFOAM, which
is GPL-3. Running it behind a hosted API is not distribution and does not trigger the
licence; shipping a customer a container image containing it is. Settle that before an
on-prem or self-hosted offering is promised to anyone. Not legal advice.

## Conventions

```bash
npm install
npm test
npm run lint
```

- ESLint enforces `eqeqeq`, `no-var`, `prefer-const`, and no unused variables.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Branch from `main`, land through a PR, CI green before merge. Branch prefixes say who
  is holding what: `devin/…`, `claude/…`.
- Write the failing test first for anything the contract or the geometry turns on. The
  suite is what lets two agents work on the engine and its consumer at once.
- Comments explain the code, not the diff. Cite the source of a constant.
- **Say what you did not verify.** Unverified work is fine; unverified work described as
  verified poisons the next agent's assumptions, because they will build on it.
