/**
 * Reading a measured wind out of the U.S. Climate Reference Network.
 *
 * The two tests worth reading first are `a missing wind can carry a good flag`
 * and `a present wind can carry an erroneous flag`. The product's own README
 * says neither happens — Note E promises these derived fields "may be assumed
 * to always be good (unflagged) data, except when they are reported as
 * missing" — and both are in the captured file, from one Boulder station-year:
 * 24 rows of `-99.00` with `WIND_FLAG=0`, and 19 rows of an ordinary 0.9-1.9
 * m/s with `WIND_FLAG=3`. A reader that believes the flag ingests a -99 m/s
 * wind; a reader that believes the sentinel ingests nineteen winds NCEI has
 * marked erroneous. Both rules are needed and both are tested here.
 *
 * The rest are the things that would be wrong without anything throwing: a
 * timestamp that ends its five minutes rather than starting them, a catalogue
 * elevation that is in feet and does not say so, a two-decimal position that
 * truncates, a zero that is a measured calm and not an absence, and a layout
 * shift that would read a soil temperature as a wind.
 *
 * Every fixture is real: `uscrn-subhourly-boulder.txt` is sixteen lines lifted
 * unaltered out of `CRNS0101-05-2026-CO_Boulder_14_W.txt`,
 * `uscrn-stations.tsv` is the published catalogue, and
 * `uscrn-homr-94075.json` is HOMR's answer for the same WBAN with the fields
 * this reader does not use removed.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const uscrn = require("../uscrn.js");

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

const SUBHOURLY = fixture("uscrn-subhourly-boulder.txt");
const STATIONS = fixture("uscrn-stations.tsv");
const HOMR = fixture("uscrn-homr-94075.json");

function ok(body) {
  return { ok: true, status: 200, text: async function () { return body; } };
}

function missing() {
  return { ok: false, status: 404, text: async function () { return "not found"; } };
}

/** A fetch that answers each URL from a table and records what it was asked. */
function fetcher(table) {
  const asked = [];
  const fn = async function (url) {
    asked.push(url);
    const answer = table[url];
    if (answer === undefined) return missing();
    return typeof answer === "function" ? answer() : ok(answer);
  };
  fn.asked = asked;
  return fn;
}

const BOULDER_2026 = uscrn.subhourlyUrl("CO_Boulder_14_W", 2026);

describe("the station catalogue", function () {
  const stations = uscrn.parseStations(STATIONS);

  test("the whole network is in one file, closed stations included", function () {
    expect(stations.length).toBeGreaterThan(200);
    const operational = stations.filter(function (s) { return s.status === "Operational"; });
    expect(operational.length).toBeGreaterThan(100);
    expect(operational.length).toBeLessThan(stations.length);
  });

  test("every station carries the documented 1.5 m height, not a guess", function () {
    stations.forEach(function (s) {
      expect(s.sensorHeightM).toBe(1.5);
      expect(s.uscrn.sensorHeightSource).toMatch(/WIND_1_5/);
    });
  });

  test("the catalogue's elevation is feet, and is converted once", function () {
    const boulder = stations.filter(function (s) { return s.id === "94075"; })[0];
    expect(boulder.uscrn.elevationFeet).toBe(9828);
    // HOMR gives the same station 2995.6 m, which is what says these are feet.
    expect(boulder.elevationM).toBeCloseTo(2995.6, 1);
  });

  test("a two-decimal position is reported with the slack it has", function () {
    const boulder = stations.filter(function (s) { return s.id === "94075"; })[0];
    expect(boulder.lat).toBe(40.03);
    expect(boulder.lon).toBe(-105.54);
    expect(boulder.uscrn.positionSource).toBe("catalogue");
    expect(boulder.uscrn.positionResolutionDeg).toBe(0.01);
    // Half a step north and half a step east, at this latitude.
    expect(boulder.uscrn.positionUncertaintyM).toBeGreaterThan(600);
    expect(boulder.uscrn.positionUncertaintyM).toBeLessThan(800);
  });

  test("the file stem is what the data files are actually keyed by", function () {
    const boulder = stations.filter(function (s) { return s.id === "94075"; })[0];
    expect(boulder.uscrn.fileStem).toBe("CO_Boulder_14_W");
    expect(uscrn.subhourlyUrl(boulder, 2026)).toBe(
      "https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01/2026/" +
      "CRNS0101-05-2026-CO_Boulder_14_W.txt");
  });

  test("a catalogue with different columns is refused, not read by position", function () {
    const moved = STATIONS.replace("LATITUDE\tLONGITUDE", "LONGITUDE\tLATITUDE");
    expect(function () { uscrn.parseStations(moved); }).toThrow(/not the catalogue this reader knows/);
  });
});

describe("the five-minute wind", function () {
  const read = uscrn.parseSubhourly(SUBHOURLY, { wban: "94075" });

  test("the timestamp ends the averaging interval", function () {
    const first = read.records[0];
    expect(first.intervalEnd).toBe("2026-01-01T06:55:00.000Z");
    expect(first.averagingSeconds).toBe(300);
    expect(new Date(first.intervalStartMs).toISOString()).toBe("2026-01-01T06:50:00.000Z");
    // Scored at the middle of the air it averaged, like every other source here.
    expect(first.time).toBe("2026-01-01T06:52:30.000Z");
  });

  test("0000 belongs to the date on its own line, not the day before", function () {
    // The README says 0000 "designates the last 5-minute period of the previous
    // day", which describes the air rather than the label: the file's own
    // UTC_DATE has already rolled over, and moving it back would put two
    // observations on one instant.
    const midnight = read.records.filter(function (r) {
      return r.intervalEnd === "2026-01-01T07:00:00.000Z";
    });
    expect(midnight.length).toBe(1);
    const stamps = read.records.map(function (r) { return r.intervalEndMs; });
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  test("speeds are metres per second and are not converted", function () {
    expect(read.records[0].speedMps).toBe(4.25);
    expect(read.records[1].speedMps).toBe(3.95);
  });

  test("a zero is a measured calm, and carries no invented direction", function () {
    const calm = read.records.filter(function (r) { return r.calm; });
    expect(calm.length).toBe(1);
    expect(calm[0].speedMps).toBe(0);
    expect(calm[0].fromDeg).toBeNull();
  });

  test("no record claims a direction, because the product has none", function () {
    read.records.forEach(function (r) { expect(r.fromDeg).toBeNull(); });
    expect(read.counts.withDirection).toBe(0);
  });

  test("a missing wind can carry a good flag, and is still absence", function () {
    // 20260310 1005 and 1010 are -99.00 with WIND_FLAG 0. Note E says this
    // cannot happen. It is in the file.
    const blanks = read.rejected.filter(function (r) { return r.code === "no-wind"; });
    expect(blanks.length).toBe(5);
    expect(blanks[0].reason).toMatch(/-99\.00/);
    read.records.forEach(function (r) { expect(r.speedMps).toBeGreaterThanOrEqual(0); });
    expect(read.counts.blank).toBe(5);
  });

  test("a present wind can carry an erroneous flag, and is dropped", function () {
    // 20260908 1830-1840 read 1.18, 1.04 and 0.97 m/s with WIND_FLAG 3.
    const bad = read.rejected.filter(function (r) { return r.code === "flagged"; });
    expect(bad.length).toBe(3);
    expect(bad[0].reason).toMatch(/erroneous data/);
    expect(read.records.some(function (r) { return r.speedMps === 1.18; })).toBe(false);
    // The sentinel is tested before the flag, so the two rows that are both
    // missing and flagged count as absence rather than as bad data.
    expect(read.counts.flagged).toBe(3);
    expect(read.counts.blank).toBe(5);
  });

  test("a flagged row can be kept deliberately, and says so on the record", function () {
    const kept = uscrn.parseSubhourly(SUBHOURLY, { wban: "94075", keepFlagged: true });
    const flagged = kept.records.filter(function (r) { return r.quality !== "0"; });
    expect(flagged.length).toBe(3);
    expect(flagged[0].quality).toBe("3");
    // The sentinel is still absence even when the flags are being ignored.
    expect(kept.records.every(function (r) { return r.speedMps > -1; })).toBe(true);
  });

  test("a reading under the cup's starting threshold is marked as a bound", function () {
    const low = read.records.filter(function (r) { return r.belowThreshold; });
    // 0.16 m/s and the 0.00 are both under the 014A's 1.0 mph threshold;
    // 0.44 m/s is under it too, at 0.447.
    expect(low.map(function (r) { return r.speedMps; }).sort()).toEqual([0, 0.16, 0.44]);
    expect(uscrn.USCRN_INSTRUMENT.calmCeilingMps).toBeCloseTo(0.447, 3);
  });

  test("the counts add up, and nothing is silently dropped", function () {
    expect(read.counts.kept + read.counts.rejected).toBe(read.counts.seen);
    expect(read.records.length).toBe(read.counts.kept);
  });

  test("a window is filtered on the interval end, half open", function () {
    const read2 = uscrn.parseSubhourly(SUBHOURLY, {
      wban: "94075",
      startMs: Date.UTC(2026, 0, 1, 6, 55),
      endMs: Date.UTC(2026, 0, 1, 7, 5)
    });
    expect(read2.records.map(function (r) { return r.intervalEnd; })).toEqual([
      "2026-01-01T06:55:00.000Z",
      "2026-01-01T07:00:00.000Z"
    ]);
  });

  test("a line from another station is refused rather than merged", function () {
    expect(function () {
      uscrn.parseSubhourly(SUBHOURLY, { wban: "94074" });
    }).toThrow(/is station 94075, not 94074/);
  });

  test("a short line is refused rather than read at the wrong columns", function () {
    const truncated = SUBHOURLY.split("\n")[0].slice(0, 100);
    expect(function () {
      uscrn.parseSubhourly(truncated, { wban: "94075" });
    }).toThrow(/characters, not 134/);
  });

  test("a layout shift is caught by the columns disagreeing with the fields", function () {
    // One more digit in the wetness column: still 23 fields, still a plausible
    // wind at the end of the split, and the documented columns now cut the
    // wind speed in the wrong place.
    const line = SUBHOURLY.split("\n")[0];
    const shifted = line.replace(" 1824 0", " 18240 0");
    expect(shifted).not.toBe(line);
    expect(function () {
      uscrn.parseSubhourly(shifted, { wban: "94075" });
    }).toThrow(/the layout has moved/);
  });

  test("NCEI's HTML 404 with a 200 on it is refused as markup", function () {
    expect(function () {
      uscrn.parseSubhourly("<!DOCTYPE html><html><body>404</body></html>", {});
    }).toThrow(/markup rather than a record file/);
  });
});

describe("HOMR's position", function () {
  test("four decimals, and the ground elevation in metres", function () {
    const homr = uscrn.parseHomrStation(JSON.parse(HOMR));
    expect(homr.lat).toBe(40.0354);
    expect(homr.lon).toBe(-105.5409);
    expect(homr.elevationM).toBeCloseTo(2995.6, 1);
  });

  test("a station HOMR does not know is a refusal, not an empty position", function () {
    expect(function () {
      uscrn.parseHomrStation({ stationCollection: { stations: [] } });
    }).toThrow(/knows no station/);
  });
});

describe("the source", function () {
  test("a station is found by WBAN or by file stem", async function () {
    const fetch = fetcher({ [uscrn.stationsUrl()]: STATIONS });
    const source = uscrn.createUscrnSource({ fetch: fetch });
    const byWban = await source.station("94075");
    const byStem = await source.station("co_boulder_14_w");
    expect(byWban.id).toBe("94075");
    expect(byStem.id).toBe("94075");
    // One catalogue read, however many stations are asked for.
    expect(fetch.asked.length).toBe(1);
  });

  test("a search filters on state, network and operation", async function () {
    const source = uscrn.createUscrnSource({
      fetch: fetcher({ [uscrn.stationsUrl()]: STATIONS })
    });
    const live = await source.search({ state: "CO", network: "USCRN", status: "Operational" });
    expect(live.map(function (s) { return s.id; }).sort()).toEqual(
      ["03060", "03061", "03063", "94074", "94075", "94082"]);
    const closed = await source.search({ state: "CO", network: "USRCRN" });
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every(function (s) { return s.status === "Closed"; })).toBe(true);
  });

  test("observations come back for the window, from the station-year file", async function () {
    const source = uscrn.createUscrnSource({
      fetch: fetcher({
        [uscrn.stationsUrl()]: STATIONS,
        [BOULDER_2026]: SUBHOURLY
      })
    });
    const read = await source.observations("94075", {
      start: "2026-01-01T06:00:00Z",
      end: "2026-01-01T08:00:00Z"
    });
    expect(read.stationId).toBe("94075");
    expect(read.sensorHeightM).toBe(1.5);
    expect(read.records.length).toBe(4);
    expect(read.records[0].intervalEnd).toBe("2026-01-01T06:55:00.000Z");
  });

  test("a window without both ends is refused rather than reading a decade", async function () {
    const source = uscrn.createUscrnSource({
      fetch: fetcher({ [uscrn.stationsUrl()]: STATIONS })
    });
    await expect(source.observations("94075", { start: "2026-01-01T00:00:00Z" }))
      .rejects.toThrow(/needs both a start and an end/);
  });

  test("the station-year file is read once for a station, not once per day", async function () {
    const fetch = fetcher({
      [uscrn.stationsUrl()]: STATIONS,
      [BOULDER_2026]: SUBHOURLY
    });
    const source = uscrn.createUscrnSource({ fetch: fetch });
    await source.observations("94075", {
      start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z"
    });
    await source.observations("94075", {
      start: "2026-01-06T00:00:00Z", end: "2026-01-07T00:00:00Z"
    });
    expect(fetch.asked.filter(function (u) { return u === BOULDER_2026; }).length).toBe(1);
  });

  test("a station-year that does not exist is absence, not a crash", async function () {
    const source = uscrn.createUscrnSource({
      fetch: fetcher({
        [uscrn.stationsUrl()]: STATIONS,
        [BOULDER_2026]: SUBHOURLY
      })
    });
    // 2025 is a 404; 2026 answers, so the window across the new year is served
    // by the half of it that exists.
    const read = await source.observations("94075", {
      start: "2025-12-31T00:00:00Z",
      end: "2026-01-01T08:00:00Z"
    });
    expect(read.records.length).toBe(4);
    await expect(source.observations("94075", {
      start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z"
    })).rejects.toThrow(/no station-year file/);
  });

  test("refine takes HOMR's four decimals, and says which position it used", async function () {
    const source = uscrn.createUscrnSource({
      refine: true,
      fetch: fetcher({
        [uscrn.stationsUrl()]: STATIONS,
        [uscrn.homrUrl("94075")]: HOMR
      })
    });
    const station = await source.station("94075");
    expect(station.lat).toBe(40.0354);
    expect(station.lon).toBe(-105.5409);
    expect(station.uscrn.positionSource).toBe("homr");
    expect(station.uscrn.cataloguePosition).toEqual({ lat: 40.03, lon: -105.54 });
  });

  test("a HOMR position too far from the catalogue's is refused", async function () {
    const moved = JSON.parse(HOMR);
    moved.stationCollection.stations[0].location.latLonPairs[0].latitude_dec = "41.0354";
    const source = uscrn.createUscrnSource({
      refine: true,
      fetch: fetcher({
        [uscrn.stationsUrl()]: STATIONS,
        [uscrn.homrUrl("94075")]: JSON.stringify(moved)
      })
    });
    const station = await source.station("94075");
    expect(station.lat).toBe(40.03);
    expect(station.uscrn.positionSource).toBe("catalogue");
    expect(station.uscrn.homrDisagreementDeg).toBeCloseTo(1.0054, 3);
  });

  test("HOMR being down leaves the catalogue's position and records why", async function () {
    const source = uscrn.createUscrnSource({
      refine: true,
      retries: 0,
      fetch: fetcher({ [uscrn.stationsUrl()]: STATIONS })
    });
    const station = await source.station("94075");
    expect(station.lat).toBe(40.03);
    expect(station.uscrn.positionSource).toBe("catalogue");
    expect(station.uscrn.homrError).toMatch(/404/);
  });
});
