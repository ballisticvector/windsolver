/**
 * The network client, tested with no network.
 *
 * Every response here is either a committed NOMADS error page or the committed
 * GRIB fixture, played back through a fake `fetch`. That is deliberate: the
 * interesting behaviour of this module is entirely in what it refuses, and a
 * suite that reaches nomads.ncep.noaa.gov to find out is both slow and a way of
 * hammering a government service that asks for a pause between requests.
 *
 * The HTML fixtures are real. They were captured on 2026-08-27 by sending
 * deliberately defective requests to filter_hrrr_2d.pl, and the byte counts and
 * status codes in the table at the top of `nomads.js` are from that session.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const nomads = require("../nomads");
const grib2 = require("../grib2");

const FIXTURES = path.join(__dirname, "fixtures");
const GRIB = fs.readFileSync(path.join(FIXTURES, "hrrr-20260826t20z-f00-boulder.grib2"));
const HTML_500 = fs.readFileSync(path.join(FIXTURES, "nomads-500-invalid-parameter.html"));
const HTML_404 = fs.readFileSync(path.join(FIXTURES, "nomads-404-file-not-present.html"));
const HTML_403 = fs.readFileSync(path.join(FIXTURES, "nomads-403-old-data.html"));
const HTML_FORM = fs.readFileSync(path.join(FIXTURES, "nomads-200-form-page.truncated.html"));

// The box the committed fixture was actually requested over.
const BOX = { west: -105.6, south: 40.4, east: -105.4, north: 40.6 };
const CYCLE = { year: 2026, month: 8, day: 26, hour: 20 };

/** A minimal Response: a status, a content type, and a body served in chunks. */
function respond(status, contentType, body, opts) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const chunkSize = (opts && opts.chunkSize) || 64 * 1024;
  return {
    status: status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => buf,
    body: (opts && opts.noStream) ? null : {
      getReader() {
        let offset = 0;
        let cancelled = false;
        return {
          read: async () => {
            if (cancelled || offset >= buf.length) return { done: true, value: undefined };
            const end = Math.min(buf.length, offset + chunkSize);
            const value = new Uint8Array(buf.subarray(offset, end));
            offset = end;
            return { done: false, value: value };
          },
          cancel: async () => { cancelled = true; }
        };
      }
    }
  };
}

/** A fetch that plays a queue of responses (or throws them) and records its calls. */
function fakeFetch(responses) {
  const queue = Array.isArray(responses) ? responses.slice() : [responses];
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: url, init: init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

/** No throttle and no sleeping: the timing is tested on its own, below. */
function base(fetchImpl, extra) {
  return Object.assign({
    fetch: fetchImpl,
    throttle: null,
    sleep: async () => {},
    retries: 0
  }, extra || {});
}

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.code;
  }
}

describe("fetchGrib — what comes back is GRIB, or it is refused", () => {
  test("a good response hands back the bytes, the size and the content type", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", GRIB));
    const got = await nomads.fetchGrib("https://example.test/g", base(f));
    expect(got.bytes).toBe(GRIB.length);
    expect(got.buffer.equals(GRIB)).toBe(true);
    expect(got.contentType).toBe("application/octet-stream");
    expect(got.attempts).toBe(1);
  });

  test("an HTML page under HTTP 200 is refused, and the filter's complaint is quoted", async () => {
    // The real shape of a missing `file=`: 111 KB of the filter's own form, 200 OK.
    const f = fakeFetch(respond(200, "text/html; charset=utf-8", HTML_FORM));
    const err = await nomads.fetchGrib("https://example.test/g", base(f)).catch((e) => e);
    expect(err.code).toBe("html-response");
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/HTML page rather than GRIB/);
  });

  test("a 500 error page is reported with the parameter NOMADS objected to", async () => {
    const f = fakeFetch(respond(500, "text/html; charset=utf-8", HTML_500));
    const err = await nomads.fetchGrib("https://example.test/g", base(f)).catch((e) => e);
    expect(err.code).toBe("http-error");
    expect(err.status).toBe(500);
    // Without this the caller sees "500" and has to guess which parameter was wrong.
    expect(err.message).toMatch(/invalid parameter: var_NOTAVAR/);
  });

  test("a 404 says which file was not present", async () => {
    const f = fakeFetch(respond(404, "text/html; charset=utf-8", HTML_404));
    const err = await nomads.fetchGrib("https://example.test/g", base(f)).catch((e) => e);
    expect(err.code).toBe("http-error");
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/not present/i);
    expect(err.message).toMatch(/wrfsfcf99/);
  });

  test("a 403 for an archived cycle is reported as such", async () => {
    const f = fakeFetch(respond(403, "text/html", HTML_403));
    const err = await nomads.fetchGrib("https://example.test/g", base(f)).catch((e) => e);
    expect(err.code).toBe("http-error");
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/Request for Old Data/i);
  });

  test("200 with an empty body is not a zero-length GRIB", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", Buffer.alloc(0)));
    expect(await codeOf(nomads.fetchGrib("u", base(f)))).toBe("empty-response");
  });

  test("bytes that are neither HTML nor GRIB are refused by name", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", Buffer.from("PK\u0003\u0004not a grib")));
    const err = await nomads.fetchGrib("u", base(f)).catch((e) => e);
    expect(err.code).toBe("not-grib");
    expect(err.message).toMatch(/neither HTML nor GRIB/);
  });

  test("the content type is not trusted: octet-stream carrying HTML is still refused", async () => {
    // Believing the header is how an error page reaches the decoder.
    const f = fakeFetch(respond(200, "application/octet-stream", HTML_500));
    expect(await codeOf(nomads.fetchGrib("u", base(f)))).toBe("html-response");
  });

  test("a body over the ceiling is abandoned in flight, not buffered and then rejected", async () => {
    const big = Buffer.concat([Buffer.from("GRIB"), Buffer.alloc(200 * 1024)]);
    const f = fakeFetch(respond(200, "application/octet-stream", big, { chunkSize: 8 * 1024 }));
    const err = await nomads.fetchGrib("u", base(f, { maxBytes: 32 * 1024 })).catch((e) => e);
    expect(err.code).toBe("too-large");
    // Proof it stopped early rather than reading all 200 KB and measuring afterwards.
    expect(err.message).toMatch(/abandoned after (32|40)\d{3} bytes/);
  });

  test("the ceiling still applies when the response cannot be streamed", async () => {
    const big = Buffer.concat([Buffer.from("GRIB"), Buffer.alloc(200 * 1024)]);
    const f = fakeFetch(respond(200, "application/octet-stream", big, { noStream: true }));
    expect(await codeOf(nomads.fetchGrib("u", base(f, { maxBytes: 32 * 1024 })))).toBe("too-large");
  });

  test("the default ceiling passes a real subset and stops a CONUS field", () => {
    expect(nomads.DEFAULT_MAX_BYTES).toBeGreaterThan(GRIB.length * 100);
    // The measured full-domain responses: 13.4 MB for these variables, 20.2 MB unfiltered.
    expect(nomads.DEFAULT_MAX_BYTES).toBeLessThan(13463212);
  });
});

describe("fetchGrib — retries are for the transport, not for the verdict", () => {
  test("a transport failure is retried and then succeeds", async () => {
    const f = fakeFetch([new Error("ECONNRESET"), respond(200, "application/octet-stream", GRIB)]);
    const got = await nomads.fetchGrib("u", base(f, { retries: 2 }));
    expect(got.attempts).toBe(2);
    expect(f.calls.length).toBe(2);
  });

  test("a transport failure that never clears is reported as network, with the attempts", async () => {
    const f = fakeFetch(new Error("EAI_AGAIN"));
    const err = await nomads.fetchGrib("u", base(f, { retries: 2 })).catch((e) => e);
    expect(err.code).toBe("network");
    expect(err.message).toMatch(/3 attempt/);
    expect(f.calls.length).toBe(3);
  });

  test("503 is retried; 500 is not, because the same bad parameter will fail again", async () => {
    const flaky = fakeFetch([respond(503, "text/html", "<html>busy</html>"),
      respond(200, "application/octet-stream", GRIB)]);
    await nomads.fetchGrib("u", base(flaky, { retries: 2 }));
    expect(flaky.calls.length).toBe(2);

    const bad = fakeFetch(respond(500, "text/html", HTML_500));
    await expect(nomads.fetchGrib("u", base(bad, { retries: 2 }))).rejects.toThrow(/invalid parameter/);
    expect(bad.calls.length).toBe(1);
  });

  test("a 404 is not retried either: the file will not appear within a second", async () => {
    const f = fakeFetch(respond(404, "text/html", HTML_404));
    await expect(nomads.fetchGrib("u", base(f, { retries: 2 }))).rejects.toThrow();
    expect(f.calls.length).toBe(1);
  });

  test("an oversized body is not retried — asking again fetches the same 20 MB", async () => {
    const big = Buffer.concat([Buffer.from("GRIB"), Buffer.alloc(100 * 1024)]);
    const f = fakeFetch(respond(200, "application/octet-stream", big, { chunkSize: 4096 }));
    await expect(nomads.fetchGrib("u", base(f, { retries: 2, maxBytes: 8192 }))).rejects.toThrow(/ceiling/);
    expect(f.calls.length).toBe(1);
  });

  test("a caller's abort signal is reported as a cancellation, not as a network fault", async () => {
    const controller = new AbortController();
    const f = async () => {
      controller.abort();
      throw new Error("The operation was aborted");
    };
    const err = await nomads.fetchGrib("u", base(f, { retries: 2, signal: controller.signal }))
      .catch((e) => e);
    expect(err.code).toBe("aborted");
  });

  test("a request that never answers is a timeout, named as one", async () => {
    const f = async (url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const err = await nomads.fetchGrib("u", base(f, { timeoutMs: 5 })).catch((e) => e);
    expect(err.code).toBe("timeout");
    expect(err.message).toMatch(/within 5 ms/);
  });

  test("without a fetch implementation it says so rather than throwing a TypeError", async () => {
    expect(await codeOf(nomads.fetchGrib("u", { fetch: null, throttle: null }))).toBe("no-fetch");
  });
});

describe("summarizeHtml — the one useful sentence out of an error page", () => {
  test("the 500 page yields the parameter", () => {
    expect(nomads.summarizeHtml(HTML_500)).toMatch(/^Error — invalid parameter: var_NOTAVAR/);
  });

  test("the 404 page yields the path", () => {
    expect(nomads.summarizeHtml(HTML_404)).toMatch(/hrrr\.t12z\.wrfsfcf99\.grib2/);
  });

  test("a summary is bounded, so a 111 KB form page cannot become the error message", () => {
    expect(nomads.summarizeHtml(HTML_FORM).length).toBeLessThanOrEqual(300);
  });

  test("HTML is recognised by its opening, whatever the header says", () => {
    expect(nomads.isHtml(Buffer.from("  <!DOCTYPE html><html>"))).toBe(true);
    expect(nomads.isHtml(Buffer.from("<HTML>"))).toBe(true);
    expect(nomads.isHtml(GRIB)).toBe(false);
  });
});

describe("assertCoversBox — a valid GRIB of the wrong place is still wrong", () => {
  const records = grib2.decode(GRIB);

  test("the fixture covers the box it was requested over", () => {
    expect(() => nomads.assertCoversBox(records, BOX)).not.toThrow();
  });

  test("a whole-CONUS field returned for a two-mile box is refused", () => {
    // What NOMADS actually serves, with HTTP 200 and valid GRIB, when the
    // subregion misses the grid: 1799 x 1059 points spanning the continent.
    const conus = [{
      latitudes: [21.14, 21.14, 47.84, 47.84],
      longitudes: [-134.09, -60.91, -134.09, -60.91]
    }];
    const err = (() => {
      try { nomads.assertCoversBox(conus, BOX); } catch (e) { return e; }
    })();
    expect(err.code).toBe("subregion-ignored");
    expect(err.message).toMatch(/whole domain/);
  });

  test("one grid cell of overhang is allowed — the filter returns whole cells", () => {
    const tight = { west: -105.6, south: 40.42, east: -105.42, north: 40.58 };
    expect(() => nomads.assertCoversBox(records, tight)).not.toThrow();
  });

  test("a wide box is allowed the bulge a conic grid gives it", () => {
    // Measured live: a 60-mile box over Boulder comes back spanning 0.19 deg wider
    // on its west side. A fixed margin refuses that, and the answer is correct.
    const wide = { west: -107.02, south: 39.15, east: -104.74, north: 40.89 };
    const returned = [{
      latitudes: [39.01, 41.03, 39.01, 41.03],
      longitudes: [-107.22, -107.22, -104.58, -104.58]
    }];
    expect(() => nomads.assertCoversBox(returned, wide)).not.toThrow();
  });

  test("the continent is still refused for a box wide enough to be allowed a bulge", () => {
    const wide = { west: -107.02, south: 39.15, east: -104.74, north: 40.89 };
    const conus = [{
      latitudes: [21.14, 21.14, 47.84, 47.84],
      longitudes: [-134.09, -60.91, -134.09, -60.91]
    }];
    expect(() => nomads.assertCoversBox(conus, wide)).toThrow(/whole domain/);
  });

  test("a degree of overhang is not, and the margin is adjustable", () => {
    const wide = [{
      latitudes: [39.0, 42.0],
      longitudes: [-107.0, -104.0]
    }];
    expect(() => nomads.assertCoversBox(wide, BOX)).toThrow(/subregion/i);
    expect(() => nomads.assertCoversBox(wide, BOX, 10)).not.toThrow();
  });
});

describe("fetchHrrrBox — the request, the response and the decode as one step", () => {
  test("a good fetch returns decoded records and the URL that produced them", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", GRIB));
    const got = await nomads.fetchHrrrBox(base(f, { box: BOX, cycle: CYCLE, forecastHour: 0 }));
    expect(got.records.length).toBe(8);
    expect(got.records[0].grid.ni).toBe(6);
    expect(got.bytes).toBe(GRIB.length);
    expect(got.url).toMatch(/filter_hrrr_2d\.pl\?/);
    expect(got.url).toMatch(/hrrr\.20260826%2Fconus|hrrr\.20260826\/conus/);
    // Grid-relative, and left that way: rotating is the caller's decision.
    expect(got.records[0].grid.windComponentsRelativeToGrid).toBe(true);
  });

  test("a box outside the box that came back is caught after the decode", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", GRIB));
    const elsewhere = { west: -80.2, south: 35.0, east: -80.0, north: 35.2 };
    expect(await codeOf(nomads.fetchHrrrBox(base(f, { box: elsewhere, cycle: CYCLE }))))
      .toBe("subregion-ignored");
  });

  test("a missing box or cycle is refused before anything is fetched", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", GRIB));
    expect(await codeOf(nomads.fetchHrrrBox(base(f, { cycle: CYCLE })))).toBe("bad-request");
    expect(await codeOf(nomads.fetchHrrrBox(base(f, { box: BOX })))).toBe("bad-request");
    expect(f.calls.length).toBe(0);
  });
});

describe("fetchLatestHrrrBox — the availability lag is observed, not assumed", () => {
  const AT = new Date(Date.UTC(2026, 7, 26, 21, 30));

  test("the newest cycle answering ends the walk, and reports the lag it really had", async () => {
    const f = fakeFetch(respond(200, "application/octet-stream", GRIB));
    const got = await nomads.fetchLatestHrrrBox(base(f, { box: BOX, at: AT }));
    expect(f.calls.length).toBe(1);
    expect(got.cycle.hour).toBe(20);
    // 21:30Z against the 20Z cycle: the 75-minute default lag, measured rather than assumed.
    expect(got.lagMinutes).toBe(90);
    expect(got.attemptedCycles).toEqual([]);
  });

  test("a cycle that is not on the server yet is walked past, not surfaced as an error", async () => {
    const f = fakeFetch([
      respond(404, "text/html", HTML_404),
      respond(200, "application/octet-stream", GRIB)
    ]);
    const got = await nomads.fetchLatestHrrrBox(base(f, { box: BOX, at: AT }));
    expect(f.calls.length).toBe(2);
    expect(got.cycle.hour).toBe(19);
    expect(got.attemptedCycles.length).toBe(1);
    expect(got.attemptedCycles[0].status).toBe(404);
  });

  test("a defective request is not walked past — an hour earlier is just as wrong", async () => {
    const f = fakeFetch(respond(500, "text/html", HTML_500));
    const err = await nomads.fetchLatestHrrrBox(base(f, { box: BOX, at: AT })).catch((e) => e);
    expect(err.code).toBe("http-error");
    expect(f.calls.length).toBe(1);
  });

  test("running out of cycles reports every one that was tried", async () => {
    const f = fakeFetch(respond(404, "text/html", HTML_404));
    const err = await nomads.fetchLatestHrrrBox(base(f, { box: BOX, at: AT, maxCyclesBack: 2 }))
      .catch((e) => e);
    expect(err.code).toBe("http-error");
    expect(err.attemptedCycles.length).toBe(3);
    expect(err.attemptedCycles.map((a) => a.cycle.hour)).toEqual([20, 19, 18]);
  });
});

describe("createThrottle — one request per interval, even when ten start at once", () => {
  test("concurrent calls are spaced rather than all seeing an idle clock", async () => {
    let now = 0;
    const slept = [];
    const throttle = nomads.createThrottle(1000, async (ms) => { slept.push(ms); now += ms; });
    const clock = () => now;
    await Promise.all([throttle(clock), throttle(clock), throttle(clock)]);
    // First goes straight through; the next two wait a full interval each.
    expect(slept).toEqual([1000, 1000]);
    expect(now).toBe(2000);
  });

  test("a request after a long idle period is not delayed", async () => {
    let now = 100000;
    const slept = [];
    const throttle = nomads.createThrottle(1000, async (ms) => { slept.push(ms); now += ms; });
    await throttle(() => now);
    now += 5000;
    await throttle(() => now);
    expect(slept).toEqual([]);
  });

  test("the default interval is the courtesy NOMADS asks for", () => {
    expect(nomads.DEFAULT_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });
});
