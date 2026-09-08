#!/usr/bin/env bash
#
# Capture the CoAgMet replies `tests/coagmet.test.js` is graded against.
#
#   tools/make-coagmet-fixtures.sh
#
# Everything here is a real response from coagmet.colostate.edu, saved
# unedited, because the point of the test is that the reader survives what the
# service actually says rather than what this repository imagines it says.
# There is no account and no key; the only cost is the request.
#
# The dates are fixed on purpose. Two of these captures exist to pin down a
# convention rather than to exercise a parser:
#
#   coagmet-5min-gun01.json    an hour of Gunnison, containing a calm run — the
#   coagmet-hourly-gun01.json  hourly mean over the same hour. `windSpeed` at
#                              21:00 is the mean of the twelve five-minute
#                              values labelled 20:05 through 21:00, which is how
#                              the test proves the timestamp labels the END of
#                              the averaging interval and not its start.
#
#   coagmet-5min-empty.json    a window before the station existed. CoAgMet
#                              answers it 200 with rows whose time is "" and
#                              whose every value is -999, which is the same
#                              reply as a dead sensor: absence that looks like
#                              data, the FEMS blank row again.
#
# Metric units are asked for on every request: CoAgMet stores m/s and degrees
# and converts to mph and feet for `units=us`, so asking for US units and
# converting back is two roundings instead of none. UTC is asked for on the
# observations so that no reading of this repository ever has to know whether
# Colorado was on daylight saving that week.

set -euo pipefail

cd "$(dirname "$0")/.."
FIX=tests/fixtures
ROOT=https://coagmet.colostate.edu/data

get() {
  # $1 url, $2 destination. `--fail-with-body` because the unknown-station
  # capture is a 400 and its body is the thing worth keeping.
  curl -sS --max-time 120 "$1" -o "$2" || true
  printf '%s\n' "$2"
}

get "$ROOT/metadata.json?units=m" "$FIX/coagmet-metadata.json"

get "$ROOT/5min/gun01.json?from=2026-08-01T20:00&to=2026-08-01T21:00&units=m&tz=utc" \
  "$FIX/coagmet-5min-gun01.json"

get "$ROOT/hourly/gun01.json?from=2026-08-01T20:00&to=2026-08-01T22:00&units=m&tz=utc" \
  "$FIX/coagmet-hourly-gun01.json"

get "$ROOT/5min/gun01.json?from=2010-01-01T00:00&to=2010-01-01T00:10&units=m&tz=utc" \
  "$FIX/coagmet-5min-empty.json"

get "$ROOT/5min/zzz99.json?from=2026-08-01T20:00&to=2026-08-01T20:10&units=m&tz=utc" \
  "$FIX/coagmet-5min-unknown.json"

get "$ROOT/5min.json?stations=gun01,alt01&from=2026-08-01T20:00&to=2026-08-01T20:15&units=m&tz=utc" \
  "$FIX/coagmet-5min-two.json"
