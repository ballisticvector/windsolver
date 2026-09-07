/**
 * The station service.
 *
 * Everything worth testing here is a claim rather than a computation. A
 * station list is a filter and a sort; what can go wrong is what the answer
 * says when part of it is missing — an observation window with no rows, a
 * directory the network will not refresh, an upstream that fails halfway. Each
 * of those has an honest answer and a plausible dishonest one, and the
 * dishonest one is always the shorter code:
 *
 * - a station that reported nothing, dropped from the list instead of carried
 *   with a reason, so the network looks healthier than it is;
 * - a retained directory served without its age, so an outage looks like an
 *   ordinary day;
 * - an observation outage that takes the markers with it, when where the
 *   anemometers are is a different fact from what they said.
 *
 * The source is injected throughout, so none of this touches FEMS. The FEMS
 * adapter itself is graded against a captured reply in `tests/fems.test.js`.
 */

"use strict";

const stations = require("../stations.js");

const BOULDER = { west: -105.6, south: 39.8, east: -105.0, north: 40.3 };

function station(id, lat, lon, extra) {
  return Object.assign({
    id: id, name: id, lat: lat, lon: lon, elevationM: 2000,
    sensorHeightM: null, state: "CO", agency: "USFS", network: "RAWS",
    provider: "test", wrccId: null
  }, extra || {});
}

// The box's centre is 40.05 N, 105.3 W. Listed out of distance order on
// purpose: the ordering is the service's job and not the provider's.
const DIRECTORY = [
  station("edge", 39.81, -105.59),
  station("near", 40.08, -105.34),
  station("centre", 40.05, -105.3),
  station("north", 41.0, -105.3),
  station("east", 40.0, -100.0)
];

function read(records, rejected) {
  return { records: records || [], rejected: rejected || [] };
}

function record(overrides) {
  const o = overrides || {};
  const time = o.time || "2026-09-06T16:00:00.000Z";
  return Object.assign({
    stationId: "centre",
    time: time,
    timeMs: Date.parse(time),
    speedMps: 3,
    fromDeg: 270,
    calm: false,
    gustMps: 5,
    quality: null,
    qcChecked: false,
    timeIsHourBin: true,
    transmitMinute: null,
    hourLabel: time
  }, o);
}

/** A source that answers from memory and counts its calls. */
function fakeSource(opts) {
  const o = opts || {};
  const calls = { directory: 0, latest: 0, ids: [] };
  return {
    calls: calls,
    network: "RAWS",
    provider: "test",
    directory: async function () {
      calls.directory++;
      if (o.directoryError) throw o.directoryError;
      return o.directory === undefined ? DIRECTORY : o.directory;
    },
    latest: async function (ids) {
      calls.latest++;
      calls.ids.push(ids.slice());
      if (o.latestError) throw o.latestError;
      return o.reads === undefined ? new Map() : o.reads;
    }
  };
}

describe("the stations inside a box", () => {
  test("keeps what is in the box, drops what is not, and orders by distance", () => {
    const found = stations.stationsInBox(DIRECTORY, BOULDER, { limit: null });
    expect(found.stations.map((s) => s.id)).toEqual(["centre", "near", "edge"]);
    expect(found.matched).toBe(3);
    expect(found.truncated).toBe(false);
    // Nearest to the centre of the box first, so a limit keeps the ones a
    // viewer is looking at rather than the ones the provider listed first.
    expect(found.stations[0].distanceM).toBeLessThanOrEqual(found.stations[2].distanceM);
  });

  test("a limit says it truncated, and how many there really were", () => {
    const found = stations.stationsInBox(DIRECTORY, BOULDER, { limit: 2 });
    expect(found.stations).toHaveLength(2);
    expect(found.matched).toBe(3);
    expect(found.truncated).toBe(true);
  });

  test("a station with no position is skipped rather than placed at null island", () => {
    const broken = [{ id: "nowhere", lat: null, lon: null }, station("ok", 40.0, -105.3)];
    const found = stations.stationsInBox(broken, BOULDER, { limit: null });
    expect(found.stations.map((s) => s.id)).toEqual(["ok"]);
  });
});

describe("the last observation, or the reason there is none", () => {
  test("the newest record wins, and carries the hour-bin flag out", () => {
    const latest = stations.latestOf(read([
      record({ time: "2026-09-06T15:00:00.000Z" }),
      record({ time: "2026-09-06T16:00:00.000Z", speedMps: 4 })
    ]));
    expect(latest.observation.time).toBe("2026-09-06T16:00:00.000Z");
    expect(latest.observation.speedMps).toBe(4);
    // An uncalibrated station's time is the nearest whole hour and may be half
    // an hour from the measurement. Dropping this makes the marker a lie the
    // viewer cannot see.
    expect(latest.observation.timeIsHourBin).toBe(true);
    expect(latest.observation.qcChecked).toBe(false);
  });

  test("no rows is not a calm: there is no observation and there is a reason", () => {
    const latest = stations.latestOf(read([], [
      { code: "blank-row", reason: "the station transmitted nothing for this hour" }
    ]));
    expect(latest.observation).toBeNull();
    expect(latest.reasonCode).toBe("blank-row");
    expect(latest.reason).toMatch(/transmitted nothing/);
  });

  test("a missing read at all still answers with a reason", () => {
    const latest = stations.latestOf(undefined);
    expect(latest.observation).toBeNull();
    expect(latest.reasonCode).toBe("no-observations");
  });

  test("a calm keeps its zero and loses its direction", () => {
    const latest = stations.latestOf(read([
      record({ speedMps: 0, fromDeg: null, calm: true })
    ]));
    expect(latest.observation.speedMps).toBe(0);
    expect(latest.observation.calm).toBe(true);
    expect(latest.observation.fromDeg).toBeNull();
  });
});

describe("the service", () => {
  test("returns the stations in the box with their latest wind", async () => {
    const source = fakeSource({
      reads: new Map([["centre", read([record()])]])
    });
    const svc = stations.createStationService({ source: source });
    const found = await svc.inBox(BOULDER, { observed: true });

    expect(found.returned).toBe(3);
    expect(found.observed).toBe(true);
    const centre = found.stations.find((s) => s.id === "centre");
    expect(centre.observation.speedMps).toBe(3);
    expect(centre.observation.ageS).toBeGreaterThan(0);

    // The two that said nothing are still on the map, with a reason.
    const quiet = found.stations.find((s) => s.id === "edge");
    expect(quiet.observation).toBeNull();
    expect(quiet.observationNote).toBeTruthy();
  });

  test("locations only when the caller does not ask for observations", async () => {
    const source = fakeSource();
    const svc = stations.createStationService({ source: source });
    const found = await svc.inBox(BOULDER, { observed: false });
    expect(found.observed).toBe(false);
    expect(source.calls.latest).toBe(0);
    expect(found.stations).toHaveLength(3);
  });

  test("the directory is fetched once and reused until it expires", async () => {
    let clock = 1000;
    const source = fakeSource();
    const svc = stations.createStationService({
      source: source, now: () => clock, directoryTtlMs: 100
    });
    await svc.inBox(BOULDER, { observed: false });
    await svc.inBox(BOULDER, { observed: false });
    expect(source.calls.directory).toBe(1);
    clock += 200;
    await svc.inBox(BOULDER, { observed: false });
    expect(source.calls.directory).toBe(2);
  });

  test("two callers at once share one directory fetch", async () => {
    const source = fakeSource();
    const svc = stations.createStationService({ source: source });
    await Promise.all([svc.directory(), svc.directory(), svc.directory()]);
    expect(source.calls.directory).toBe(1);
  });

  test("a directory that cannot be refreshed is served retained, aged, and said so", async () => {
    // The degraded mode `docs/history.md` argues for, in the one place it costs
    // nothing: a station list is quasi-static, so an expired copy is almost
    // certainly still true and discarding it turns a partial outage into an
    // empty map. What is not allowed is serving it silently.
    let clock = 1000;
    let fail = false;
    const source = {
      network: "RAWS",
      provider: "test",
      directory: async function () {
        if (fail) throw new Error("FEMS answered 503 for the station directory");
        return DIRECTORY;
      },
      latest: async function () { return new Map(); }
    };
    const svc = stations.createStationService({
      source: source, now: () => clock, directoryTtlMs: 100
    });

    const fresh = await svc.directory();
    expect(fresh.stale).toBe(false);

    fail = true;
    clock += 3 * 24 * 60 * 60 * 1000;
    const retained = await svc.directory();
    expect(retained.stations).toHaveLength(DIRECTORY.length);
    expect(retained.stale).toBe(true);
    expect(retained.ageS).toBe(3 * 24 * 60 * 60);
    expect(retained.error).toMatch(/503/);
  });

  test("with nothing retained, a directory failure is refused rather than answered empty", async () => {
    const svc = stations.createStationService({
      source: fakeSource({ directoryError: new Error("FEMS is unreachable") })
    });
    await expect(svc.inBox(BOULDER, {})).rejects.toThrow(/unreachable/);
  });

  test("an empty directory is a failure, not a country with no anemometers", async () => {
    const svc = stations.createStationService({ source: fakeSource({ directory: [] }) });
    await expect(svc.directory()).rejects.toMatchObject({ code: "no-stations" });
  });

  test("an observation outage keeps the markers and names itself", async () => {
    // Where the anemometers are is a different fact from what they said.
    const svc = stations.createStationService({
      source: fakeSource({ latestError: Object.assign(new Error("FEMS answered 502"),
        { code: "observations-unavailable" }) })
    });
    const found = await svc.inBox(BOULDER, { observed: true });
    expect(found.stations).toHaveLength(3);
    expect(found.observed).toBe(false);
    expect(found.errors[0].code).toBe("observations-unavailable");
  });

  test("observations are asked for only the stations that were returned", async () => {
    const source = fakeSource();
    const svc = stations.createStationService({ source: source });
    await svc.inBox(BOULDER, { observed: true, limit: 2 });
    expect(source.calls.ids[0]).toHaveLength(2);
  });
});

/**
 * A model that answers from memory, in the shape `server.js` builds around a
 * volume: earth-relative east/north components per point, and a per-point note
 * for the ones it has no wind for.
 */
function fakeModel(opts) {
  const o = opts || {};
  const calls = { windAt: 0, boxes: [], points: [] };
  return {
    calls: calls,
    windAt: async function (box, points) {
      calls.windAt++;
      calls.boxes.push(box);
      calls.points.push(points);
      if (o.error) throw o.error;
      return Object.assign({
        source: "HRRR",
        validTime: "2026-09-06T16:00:00.000Z",
        heightAglM: 10,
        winds: points.map(function () { return { east: 3, north: 0 }; }),
        notes: []
      }, o.sampled || {});
    }
  };
}

describe("the model beside the measurement", () => {
  test("is absent unless it is asked for, and costs nothing when it is not", async () => {
    const model = fakeModel();
    const svc = stations.createStationService({ source: fakeSource(), model: model });
    const found = await svc.inBox(BOULDER, { observed: false });
    expect(model.calls.windAt).toBe(0);
    expect(found.model).toBeNull();
    // The field is present and null rather than missing: a reader checking for
    // a comparison gets the same shape whether or not one was wanted.
    expect(found.stations[0].model).toBeNull();
    expect(found.stations[0].modelNote).toBeNull();
  });

  test("samples the box once for every station, not once per station", async () => {
    const model = fakeModel();
    const svc = stations.createStationService({ source: fakeSource(), model: model });
    const found = await svc.inBox(BOULDER, { observed: false, model: true });
    expect(model.calls.windAt).toBe(1);
    expect(model.calls.points[0]).toHaveLength(3);
    expect(model.calls.boxes[0]).toEqual(BOULDER);
    expect(found.stations.map((s) => Math.round(s.model.speedMps))).toEqual([3, 3, 3]);
    // Westerly: east-going wind comes from 270.
    expect(found.stations[0].model.fromDeg).toBeCloseTo(270, 6);
  });

  test("says what the number is not, on the answer rather than in the docs", async () => {
    const svc = stations.createStationService({
      source: fakeSource(), model: fakeModel()
    });
    const found = await svc.inBox(BOULDER, { observed: false, model: true });
    expect(found.model).toMatchObject({
      source: "HRRR", heightAglM: 10, downscaled: false, code: null, error: null
    });
    expect(found.model.notice).toBe(stations.MODEL_NOTICE);
    expect(found.model.notice).toMatch(/not.*downscaled/);
    expect(found.model.notice).toMatch(/6\.1 m/);
  });

  test("a model outage costs the comparison and keeps the stations", async () => {
    const svc = stations.createStationService({
      source: fakeSource({ reads: new Map([["centre", read([record()])]]) }),
      model: fakeModel({
        error: Object.assign(new Error("NOMADS answered 503"),
          { code: "model-unavailable" })
      })
    });
    const found = await svc.inBox(BOULDER, { observed: true, model: true });
    expect(found.stations).toHaveLength(3);
    expect(found.observed).toBe(true);
    expect(found.stations[0].observation.speedMps).toBe(3);
    expect(found.model).toMatchObject({
      code: "model-unavailable", source: null, notice: null
    });
    expect(found.model.error).toMatch(/503/);
    // Named where a caller already looks for the reasons, not only in a field
    // it has to know to read.
    expect(found.errors).toEqual([{
      code: "model-unavailable", error: found.model.error
    }]);
    expect(found.stations.every((s) => s.model === null)).toBe(true);
  });

  test("a station off the edge of the grid keeps the model's own reason", async () => {
    const svc = stations.createStationService({
      source: fakeSource(),
      model: fakeModel({
        sampled: {
          winds: [{ east: 3, north: 0 }, null, { east: 0, north: -2 }],
          notes: [null, "this volume covers 39.9 N to 40.2 N, not 40.08 N", null]
        }
      })
    });
    const found = await svc.inBox(BOULDER, { observed: false, model: true });
    expect(found.model.code).toBeNull();
    expect(found.stations[1].model).toBeNull();
    expect(found.stations[1].modelNote).toMatch(/39\.9 N/);
    // The other two are unaffected: one station is not an outage.
    expect(found.stations[0].model.speedMps).toBe(3);
    expect(found.stations[2].model.fromDeg).toBeCloseTo(0, 6);
  });

  test("a station the model returned nothing for is not silently uncoloured", async () => {
    const svc = stations.createStationService({
      source: fakeSource(),
      model: fakeModel({ sampled: { winds: [], notes: [] } })
    });
    const found = await svc.inBox(BOULDER, { observed: false, model: true });
    expect(found.stations.every((s) => s.model === null)).toBe(true);
    expect(found.stations[0].modelNote).toMatch(/no wind at this coordinate/);
  });

  test("asking a service with no model attached is refused, not answered with nulls", async () => {
    const svc = stations.createStationService({ source: fakeSource() });
    const found = await svc.inBox(BOULDER, { observed: false, model: true });
    expect(found.model.code).toBe("no-model");
    expect(found.errors[0].code).toBe("no-model");
    expect(found.stations).toHaveLength(3);
  });

  test("an empty box does not sample the model at all", async () => {
    const model = fakeModel();
    const svc = stations.createStationService({
      // A directory with nothing in this box, rather than an empty one: an
      // empty directory is an outage and has its own answer.
      source: fakeSource({ directory: [station("far", 41.0, -105.3)] }), model: model
    });
    const found = await svc.inBox(BOULDER, { observed: true, model: true });
    expect(found.stations).toHaveLength(0);
    expect(model.calls.windAt).toBe(0);
    expect(found.model).toBeNull();
  });
});

describe("the wind out of two components", () => {
  test("gives the meteorological bearing the wind comes from", () => {
    expect(stations.windOf(3, 0).fromDeg).toBeCloseTo(270, 6);
    expect(stations.windOf(-3, 0).fromDeg).toBeCloseTo(90, 6);
    expect(stations.windOf(0, 3).fromDeg).toBeCloseTo(180, 6);
    expect(stations.windOf(0, -3).fromDeg).toBeCloseTo(0, 6);
    expect(stations.windOf(3, 4).speedMps).toBeCloseTo(5, 6);
  });

  test("a still model has no direction, rather than a northerly", () => {
    expect(stations.windOf(0, 0)).toEqual({ speedMps: 0, fromDeg: null });
  });

  test("components that are not numbers are no wind, not a zero one", () => {
    expect(stations.windOf(null, 0)).toBeNull();
    expect(stations.windOf(NaN, NaN)).toBeNull();
  });
});

describe("the FEMS adapter", () => {
  test("asks FEMS for every station and normalises what comes back", async () => {
    const reply = {
      data: {
        stationMetaData: {
          _metadata: { total_count: 1 },
          data: [{
            station_id: "50604", wrcc_id: "CSUG", station_name: "SUGARLOAF",
            latitude: 40.01806, longitude: -105.36139, elevation: 6733,
            state: "CO", agency: "USFS", network_name: "RAWS",
            time_zone: "-7", period_record_start: "2005-01-01",
            period_record_stop: "2026-09-06", has_historic_data: true
          }]
        }
      }
    };
    const source = stations.createFemsStationSource({
      fetch: async function (url, init) {
        expect(init.method).toBe("POST");
        return { ok: true, status: 200, json: async () => reply };
      }
    });
    const list = await source.directory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "50604", name: "SUGARLOAF", state: "CO", network: "RAWS", provider: "fems"
    });
    // Feet in, metres out — and no invented sensor height: FEMS does not
    // publish one, and a RAWS is not at the 10 m a METAR is at.
    expect(list[0].elevationM).toBeCloseTo(2052.2, 1);
    expect(list[0].sensorHeightM).toBeNull();
  });

  test("an HTTP failure is named as a station outage, not as an empty network", async () => {
    const source = stations.createFemsStationSource({
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) })
    });
    await expect(source.directory()).rejects.toMatchObject({
      code: "stations-unavailable", status: 503
    });
  });
});
