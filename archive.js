/**
 * HRRR out of NCEP's archive on AWS Open Data, one message at a time.
 *
 * NOMADS remembers about two days. That is fine for a live service and useless
 * for the question this repository keeps failing to answer — *does the result
 * repeat* — because by the time a candidate exists the observations it was
 * derived from have been deleted. Every scoring run in `docs/downscaling.md` so
 * far is one state on one day, and it is the archive that was missing rather
 * than the patience.
 *
 * `noaa-hrrr-bdp-pds` holds every cycle since 2014 with no key and no account.
 * What it does not hold is a subsetter: an object is the whole CONUS grid, 130
 * MB or so, and asking for 2 KB over a county is not on offer. What is on offer
 * is the `.idx` sidecar NCEP writes beside each object — one line per message,
 * with its byte offset — so a caller can look the message up and ask S3 for
 * that byte range alone. A 10 m wind field is then about 2 MB rather than 130.
 *
 *   hrrr.20250901/conus/hrrr.t12z.wrfsfcf01.grib2
 *   hrrr.20250901/conus/hrrr.t12z.wrfsfcf01.grib2.idx
 *
 * Three things about the archive differ from NOMADS in ways that cost time:
 *
 * - **The archive is not re-packed.** NOMADS' filter rewrites what it serves
 *   with simple packing; NCEP's own file is complex packing with second-order
 *   spatial differencing throughout. The identical field decoded from NOMADS
 *   and refused from the archive until `grib2.js` learned templates 5.2 and 5.3.
 * - **A range request that is ignored succeeds.** S3 answers a range it accepts
 *   with 206 and a range it does not with 200 and the entire object. That is the
 *   same shape of failure as NOMADS' unapplied subregion — valid, well-formed,
 *   and 60x the size — so the status code is checked, not just the body.
 * - **The index is a separate object from the data.** It is written by the same
 *   job, but nothing guarantees the two agree, and an offset that is stale by
 *   one message decodes into a different field with no complaint at all. Every
 *   message fetched here is checked against the index line that named it.
 *
 * The whole grid comes back, 1,799 x 1,059 = 1,905,141 points, so a record costs
 * roughly 45 MB in memory once the coordinates are built. That is the price of
 * there being no subsetter, and it is why this module is for research rather
 * than for the live path — `nomads.js` stays the way windsolver.com is served.
 */

"use strict";

const grib2 = require("./grib2.js");

const DEFAULT_BUCKET_URL = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com";

/** The two-dimensional surface file. `wrfprsf` is the pressure-level one. */
const DEFAULT_PRODUCT = "wrfsfcf";

/**
 * A ceiling on one range request. The largest single message in an HRRR surface
 * file is under 3 MB; the whole object is about 130 MB, which is what arrives
 * when a range is ignored. 16 MB is far above any real message and far below the
 * object, so the two cannot be confused.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS = [500, 502, 503, 504, 429];

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * `{ year, month, day, hour }` from either that shape or a Date.
 *
 * A Date is read in UTC and nowhere else. A cycle read in local time is a real
 * bug with a plausible answer: it fetches a different hour's weather and every
 * value in it is a valid wind.
 */
function cycleParts(cycle) {
  if (cycle instanceof Date) {
    return {
      year: cycle.getUTCFullYear(),
      month: cycle.getUTCMonth() + 1,
      day: cycle.getUTCDate(),
      hour: cycle.getUTCHours()
    };
  }
  if (!cycle || cycle.year === undefined || cycle.hour === undefined) {
    throw fail("bad-request", "cycle must be a Date or { year, month, day, hour } in UTC");
  }
  return cycle;
}

/** The S3 URL of one cycle and forecast hour. */
function objectUrl(opts) {
  const o = opts || {};
  const c = cycleParts(o.cycle);
  const hour = o.forecastHour === undefined ? 0 : o.forecastHour;
  if (!(hour >= 0 && hour <= 48 && Number.isInteger(hour))) {
    throw fail("bad-request", "forecastHour must be a whole number of hours in 0..48");
  }
  const base = (o.bucketUrl || DEFAULT_BUCKET_URL).replace(/\/+$/, "");
  const product = o.product || DEFAULT_PRODUCT;
  const region = o.region || "conus";
  return base + "/hrrr." + c.year + pad2(c.month) + pad2(c.day) + "/" + region +
    "/hrrr.t" + pad2(c.hour) + "z." + product + pad2(hour) + ".grib2";
}

function indexUrl(opts) {
  return objectUrl(opts) + ".idx";
}

/**
 * Parse an `.idx` sidecar into one entry per message.
 *
 * The format is colon-separated and positional:
 *
 *   118:57623578:d=2025090112:SFCR:surface:1 hour fcst
 *
 * Only the offset is given, never the length, so a message runs to the start of
 * the next one and the last message runs to the end of the object. `end` is
 * `null` for that last entry, which is a fact about the format and not a missing
 * value — a range with no end is legal and asks S3 for the remainder.
 */
function parseIndex(text) {
  if (typeof text !== "string") throw fail("bad-index", "the index must be text");
  const trimmed = text.trim();
  if (!trimmed) throw fail("bad-index", "the index is empty");
  if (/^<(!doctype|html|\?xml)/i.test(trimmed)) {
    throw fail("bad-index", "the index URL answered with markup rather than an index: " +
      trimmed.replace(/\s+/g, " ").slice(0, 200));
  }

  const entries = [];
  for (const line of trimmed.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    const f = raw.split(":");
    if (f.length < 6) {
      throw fail("bad-index", "index line is not in NCEP's format: " + JSON.stringify(raw.slice(0, 120)));
    }
    const message = Number(f[0]);
    const start = Number(f[1]);
    if (!Number.isInteger(message) || !Number.isInteger(start) || start < 0) {
      throw fail("bad-index", "index line has no message number or byte offset: " +
        JSON.stringify(raw.slice(0, 120)));
    }
    entries.push({
      message: message,
      start: start,
      end: null,
      reference: f[2],
      parameter: f[3],
      level: f[4],
      // The rest can itself contain a colon ("0-1 hour max fcst" does not, but
      // probability descriptions do), so it is rejoined rather than indexed.
      forecast: f.slice(5).join(":"),
      line: raw
    });
  }

  // The sidecar is written in message order, but the ends are derived from the
  // offsets, so sort by offset first: deriving a length from a line that is out
  // of order produces a negative range, and S3 answers a negative range with the
  // whole object.
  const byOffset = entries.slice().sort((a, b) => a.start - b.start);
  for (let k = 0; k < byOffset.length - 1; k++) {
    byOffset[k].end = byOffset[k + 1].start - 1;
    if (byOffset[k].end < byOffset[k].start) {
      throw fail("bad-index", "two messages share byte offset " + byOffset[k].start);
    }
  }
  return entries;
}

/**
 * The index entries matching a wanted parameter and level.
 *
 * `parameter` and `level` are matched verbatim against the sidecar's own
 * spelling — "UGRD" and "10 m above ground" — because a near-miss that matched
 * loosely would return the 250 mb wind for a request for the 10 m one, and both
 * are winds.
 */
function selectEntries(entries, wanted) {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  const found = [];
  for (const want of list) {
    const hits = entries.filter((e) =>
      e.parameter === want.parameter &&
      (want.level === undefined || e.level === want.level) &&
      (want.forecast === undefined || e.forecast === want.forecast));
    if (hits.length === 0) {
      throw fail("not-in-index", "the index has no " + want.parameter +
        (want.level === undefined ? "" : " at " + want.level) +
        "; it is matched verbatim, and NCEP's spelling is the one in the sidecar",
        { parameter: want.parameter, level: want.level });
    }
    for (const hit of hits) if (found.indexOf(hit) < 0) found.push(hit);
  }
  return found;
}

/** The HTTP Range header value for an index entry. */
function rangeHeader(entry) {
  return "bytes=" + entry.start + "-" + (entry.end === null ? "" : entry.end);
}

function resolveOptions(opts) {
  const o = opts || {};
  return {
    fetchImpl: o.fetch === undefined ? globalThis.fetch : o.fetch,
    maxBytes: o.maxBytes === undefined ? DEFAULT_MAX_BYTES : o.maxBytes,
    timeoutMs: o.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : o.timeoutMs,
    retries: o.retries === undefined ? DEFAULT_RETRIES : o.retries,
    sleep: o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    signal: o.signal
  };
}

async function request(url, headers, o) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = o.timeoutMs > 0 ? setTimeout(() => controller.abort(), o.timeoutMs) : null;
    if (timer && typeof timer.unref === "function") timer.unref();
    const onAbort = () => controller.abort();
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });
    let res;
    let buffer;
    try {
      res = await o.fetchImpl(url, { headers: headers, redirect: "follow", signal: controller.signal });
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (o.signal && o.signal.aborted) {
        throw fail("aborted", "the request was cancelled by the caller", { url: url, cause: err });
      }
      if (attempt > o.retries) {
        const timedOut = controller.signal.aborted;
        throw fail(timedOut ? "timeout" : "network",
          timedOut
            ? "the archive did not answer within " + o.timeoutMs + " ms, after " + attempt + " attempt(s)"
            : "no response from the archive after " + attempt + " attempt(s): " + err.message,
          { url: url, cause: err });
      }
      await o.sleep(500 * attempt);
      continue;
    } finally {
      if (timer) clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
    }

    if (res.status >= 400) {
      if (RETRYABLE_STATUS.indexOf(res.status) >= 0 && attempt <= o.retries) {
        await o.sleep(500 * attempt);
        continue;
      }
      // S3 explains itself in XML, and the one useful part is the code:
      // NoSuchKey for a cycle that was never written, AccessDenied for a
      // bucket name typed wrong.
      const body = buffer.toString("latin1", 0, Math.min(buffer.length, 400));
      const code = /<Code>([^<]+)<\/Code>/.exec(body);
      throw fail("http-error", "the archive answered " + res.status +
        (code ? ": " + code[1] : "") + " for " + url,
        { url: url, status: res.status, body: body });
    }
    return { status: res.status, buffer: buffer, attempts: attempt };
  }
}

/** Fetch and parse the `.idx` sidecar for one cycle and forecast hour. */
async function fetchIndex(opts) {
  const o = resolveOptions(opts);
  if (typeof o.fetchImpl !== "function") {
    throw fail("no-fetch", "no fetch implementation: pass opts.fetch on a runtime without a global one");
  }
  const url = indexUrl(opts);
  const got = await request(url, undefined, o);
  return { url: url, entries: parseIndex(got.buffer.toString("utf8")), attempts: got.attempts };
}

/**
 * Fetch the messages an index entry names, and refuse anything else.
 *
 * The checks are the point of the function. A 200 rather than a 206 means the
 * range was ignored and the whole 130 MB object is arriving; a message whose
 * parameter or level differs from the index line means the sidecar and the
 * object disagree, which decodes perfectly into the wrong field.
 */
async function fetchEntries(entries, opts) {
  const o = resolveOptions(opts);
  if (typeof o.fetchImpl !== "function") {
    throw fail("no-fetch", "no fetch implementation: pass opts.fetch on a runtime without a global one");
  }
  const url = objectUrl(opts);
  const out = [];
  let bytes = 0;

  for (const entry of entries) {
    const got = await request(url, { Range: rangeHeader(entry) }, o);
    if (got.status !== 206) {
      throw fail("range-ignored", "the archive answered " + got.status + " rather than 206 for " +
        rangeHeader(entry) + ": the range was not applied, and the body is the whole object",
        { url: url, status: got.status, bytes: got.buffer.length });
    }
    if (got.buffer.length > o.maxBytes) {
      throw fail("too-large", "the range returned " + got.buffer.length + " bytes, over the " +
        o.maxBytes + " byte ceiling", { url: url, bytes: got.buffer.length });
    }
    if (entry.end !== null && got.buffer.length !== entry.end - entry.start + 1) {
      throw fail("short-range", "the archive returned " + got.buffer.length + " bytes for the " +
        (entry.end - entry.start + 1) + " the index says the message occupies",
        { url: url, entry: entry.line });
    }
    if (got.buffer.toString("ascii", 0, 4) !== "GRIB") {
      throw fail("not-grib", "the bytes at offset " + entry.start + " are not a GRIB message; " +
        "the index and the object have drifted apart", { url: url, entry: entry.line });
    }

    const records = grib2.decode(got.buffer);
    for (const record of records) assertMatchesIndex(record, entry, url);
    for (const record of records) out.push(record);
    bytes += got.buffer.length;
  }

  return { url: url, bytes: bytes, records: out };
}

/**
 * The decoded message has to be the one the index named.
 *
 * The parameter is compared through `grib2.PARAMETERS`, so a field this module
 * has no name for is checked by its numbers rather than skipped: an unnamed
 * message that came back for a named request is exactly the drift being looked
 * for. The level is compared loosely on the number and the surface, because the
 * sidecar's phrasing ("10 m above ground") is prose and the decoder's is
 * structured.
 */
function assertMatchesIndex(record, entry, url) {
  const named = record.parameter;
  const numeric = record.discipline + "/" + record.category + "/" + record.number;
  // A message this decoder has no name for keeps its numbers as its parameter.
  // The index does have a name for it, so the two cannot be compared by name and
  // saying they agree would be an invention; the level check below still applies.
  if (named !== numeric && named !== entry.parameter) {
    throw fail("index-mismatch", "the index says " + entry.parameter + " and the message is " + named +
      "; the sidecar and the object have drifted apart",
      { url: url, entry: entry.line, parameter: named });
  }
  const number = /^(-?\d+(?:\.\d+)?)\s/.exec(entry.level);
  if (number && record.level && Math.abs(record.level.value - Number(number[1])) > 1e-9) {
    throw fail("index-mismatch", "the index says " + entry.level + " and the message is at " +
      record.level.value, { url: url, entry: entry.line });
  }
}

/**
 * Fetch a set of variables for one cycle and forecast hour from the archive.
 *
 * Two round trips: the sidecar, then one range request per message. Returns
 * `{ url, indexUrl, bytes, records, entries }`, with the records exactly as
 * `grib2.decode` produces them — grid-relative, so `toEarthRelativeWind` is
 * still the caller's job.
 */
async function fetchArchiveRecords(opts) {
  const o = opts || {};
  if (!o.cycle) throw fail("bad-request", "cycle is required");
  if (!o.wanted) throw fail("bad-request", "wanted is required: [{ parameter, level }]");
  const index = await fetchIndex(o);
  const entries = selectEntries(index.entries, o.wanted);
  const got = await fetchEntries(entries, o);
  return {
    url: got.url,
    indexUrl: index.url,
    bytes: got.bytes,
    entries: entries,
    records: got.records
  };
}

module.exports = {
  DEFAULT_BUCKET_URL,
  DEFAULT_PRODUCT,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  RETRYABLE_STATUS,
  objectUrl,
  indexUrl,
  parseIndex,
  selectEntries,
  rangeHeader,
  assertMatchesIndex,
  fetchIndex,
  fetchEntries,
  fetchArchiveRecords
};
