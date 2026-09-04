# Changelog

Consumers pin a tag, so a release is the only thing they see. Each entry says what a
caller can now do and what it must not assume.

## Unreleased

**`server.js` — the HTTP service `v1.1.0` said was missing.** `GET /v1/field` answers a
box with an east/north wind over a lat/long grid and has no bearing in it; `/v1/line` and
`/v1/windprofile` are views cut out of the same cached field for a caller that has one.
Bounded for exposure: 2 concurrent solves, 8 queued, a 45 s timeout, an output-cell
ceiling, and engine codes mapped onto statuses. Started with `npm run serve`.

Unchanged: `profile.js`, and the fact that **nothing here has been compared with a
measured wind** — every answer carries `modelled: true` and says so. The service has no
authentication and no per-caller rate limit, and binds `127.0.0.1` for that reason.

## v1.1.0

The engine arrives. `v1.0.0` was the contract alone; this tag is the first one that can
turn a coordinate into a wind.

**`profile.js` is byte-for-byte unchanged from `v1.0.0`.** A consumer that only
validates a `windProfile` gains nothing by moving and loses nothing by staying — the
contract is still v1, and no key changed meaning.

Added, in dependency order:

- `grib2.js` — decodes the templates HRRR actually sends (Lambert conformal 3.30, simple
  packing 5.0) and refuses the rest by name. `toEarthRelativeWind` rotates grid-relative
  components onto true north; skipping it rotates the wind by up to 14° over CONUS.
- `nomads.js` — the only module that touches the network. Refuses the four ways NOMADS
  answers a bad request with HTTP 200.
- `volume.js`, `cache.js` — a general atmosphere over a bbox and a level set, cached on
  `(source, snapped bbox, level set, valid time)`. No bearing in the key.
- `cog.js`, `terrain.js` — a window range-read out of a 3DEP tile: 1.29 MB and 5 requests
  where the tile is 449 MB.
- `derive.js` — slope, aspect, curvature, roughness and Winstral sheltering, keyed on the
  ground alone so an hourly wind update is arithmetic over grids that already exist.
- `downscale.js` — the model wind bent by that terrain, graded against an independent
  NumPy implementation of Liston & Elder 2006.
- `field.js` — a coordinate in, an east/north field over real ground out.
- `slice.js` — a geodesic line cut out of a field, and `toWindProfile` to hand it over.

Not in this tag, and the reason a consumer still cannot get a live field from it:
**there is no HTTP service.** Everything above runs in process, which is the wrong side
of the boundary for a consumer — WindSolver's compute is meant to be reached over HTTP.

Known limits, unchanged by this release: nothing here has been compared with a measured
wind, HRRR coverage is CONUS only, and the vertical profile is a neutral log law with no
veer and no stability.

## v1.0.0

The `windProfile` v1 contract (`profile.js`) and the geometry helpers it needs.
