"use strict";

const prewarm = require("../prewarm.js");

describe("reading the places to keep warm", () => {
  test("a coordinate, with and without a radius", () => {
    expect(prewarm.parsePlaces("40.0150,-105.2705")).toEqual([
      { lat: 40.0150, lon: -105.2705 }
    ]);
    expect(prewarm.parsePlaces("40.0150,-105.2705,2")).toEqual([
      { lat: 40.0150, lon: -105.2705, radiusMiles: 2 }
    ]);
  });

  test("several places, whitespace and trailing separators forgiven", () => {
    expect(prewarm.parsePlaces(" 40.015, -105.27 ; 39.7392,-104.9903,1.5 ; ")).toEqual([
      { lat: 40.015, lon: -105.27 },
      { lat: 39.7392, lon: -104.9903, radiusMiles: 1.5 }
    ]);
  });

  test("nothing configured is no places, not an error", () => {
    expect(prewarm.parsePlaces(undefined)).toEqual([]);
    expect(prewarm.parsePlaces("")).toEqual([]);
  });

  // A typo that silently warms nothing is indistinguishable from a prewarm that
  // is working: every request is simply slow, which is what it was before.
  test.each([
    ["40.0150", "not lat,lon"],
    ["40.0150,-105.2705,1,2", "not lat,lon"],
    ["ninety,-105.2705", "latitude"],
    ["91,-105.2705", "latitude"],
    ["40.0150,-181", "longitude"],
    ["40.0150,-105.2705,0", "radius"],
    ["40.0150,-105.2705,soon", "radius"]
  ])("refuses %s by name", (spec, complaint) => {
    expect(() => prewarm.parsePlaces(spec)).toThrow(complaint);
  });
});

describe("the request a warm-up sends", () => {
  // If this drifts from what the page sends, the cache fills with entries
  // nobody looks up and every visitor still waits for a cold solve.
  test("is the field request a browser would make", () => {
    expect(prewarm.requestPath({ lat: 40.015, lon: -105.2705 }))
      .toBe("/v1/field?lat=40.015&lon=-105.2705");
    expect(prewarm.requestPath({ lat: 40.015, lon: -105.2705, radiusMiles: 2 }))
      .toBe("/v1/field?lat=40.015&lon=-105.2705&radiusMiles=2");
  });
});

describe("warming", () => {
  const places = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }];

  test("asks for one place at a time, never two at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await prewarm.warmOnce(places, {
      fetchPath: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 200;
      }
    });
    // The service runs two solves at once. A prewarm that fires them all at
    // start-up owns the gate, and the first visitor queues behind it.
    expect(peak).toBe(1);
  });

  test("a refusal is reported and the next place is still warmed", async () => {
    const asked = [];
    const logged = [];
    const results = await prewarm.warmOnce(places, {
      log: (e) => logged.push(e),
      fetchPath: async (path) => {
        asked.push(path);
        return asked.length === 1 ? 503 : 200;
      }
    });

    expect(asked).toHaveLength(2);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(logged[0]).toMatchObject({ level: "warn", message: "prewarm refused", status: 503 });
    expect(logged[1]).toMatchObject({ level: "info", message: "prewarmed" });
  });

  test("a fetch that throws does not stop the round either", async () => {
    const logged = [];
    let call = 0;
    const results = await prewarm.warmOnce(places, {
      log: (e) => logged.push(e),
      fetchPath: async () => {
        call++;
        if (call === 1) throw new Error("socket hang up");
        return 200;
      }
    });

    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(logged[0]).toMatchObject({ message: "prewarm failed", error: "socket hang up" });
  });

  test("a timeout is 'still running', not a refusal, and is tried again sooner", async () => {
    // The service abandons the wait at 45 s, not the work: the fetch finishes
    // and warms the cache. Waiting out the full interval would let a new HRRR
    // cycle undo a solve that had already been paid for.
    const logged = [];
    const gaps = [];
    let last = Date.now();
    let calls = 0;

    const run = prewarm.start([{ lat: 1, lon: 2 }], {
      intervalMs: 200,
      stillRunningMs: 5,
      log: (e) => logged.push(e),
      fetchPath: async () => {
        gaps.push(Date.now() - last);
        last = Date.now();
        calls++;
        return calls === 1 ? 504 : 200;
      }
    });

    await run.ran;
    expect(logged[0]).toMatchObject({ message: "prewarm still running", status: 504 });

    await new Promise((r) => setTimeout(r, 60));
    run.stop();

    expect(calls).toBeGreaterThan(1);
    // The second attempt came on the short retry, not the long interval.
    expect(gaps[1]).toBeLessThan(200);
  });

  test("it keeps warming, because a new HRRR cycle makes every field cold again", async () => {
    let rounds = 0;
    const run = prewarm.start([{ lat: 1, lon: 2 }], {
      intervalMs: 1,
      fetchPath: async () => { rounds++; return 200; }
    });
    await run.ran;
    expect(rounds).toBe(1);

    await new Promise((r) => setTimeout(r, 20));
    expect(rounds).toBeGreaterThan(1);

    run.stop();
    const settled = rounds;
    await new Promise((r) => setTimeout(r, 20));
    expect(rounds).toBe(settled);
  });
});
