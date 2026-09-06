/**
 * The listing cache: the only thing here that survives a restart.
 *
 * The tests that matter are the ones about *not* caching. A cache that
 * remembers a 503 from The National Map turns a bad afternoon into a permanent
 * "there is no terrain here", and every failure mode of this module has to come
 * out as "ask again", never as an answer and never as an error the caller sees.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const listing = require("../listing.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "windsolver-listing-"));
}

describe("listing — storing an answer", () => {
  test("a stored body comes back, and a URL never asked for does not", async () => {
    const cache = listing.createListingCache({ dir: tempDir() });
    await cache.put("https://tnm/products?a=1", { items: [{ title: "t" }] });

    const hit = await cache.get("https://tnm/products?a=1");
    expect(hit.body.items[0].title).toBe("t");
    expect(await cache.get("https://tnm/products?a=2")).toBeNull();
  });

  test("two URLs differing only in the bbox are different entries", async () => {
    // The bbox is the whole question. A hash collision here would serve one
    // valley's tiles for another's, which reads as perfectly ordinary terrain.
    const cache = listing.createListingCache({ dir: tempDir() });
    await cache.put("https://tnm/products?bbox=-105.1,40.0,-105.0,40.1", { items: [1] });
    await cache.put("https://tnm/products?bbox=-105.2,40.0,-105.1,40.1", { items: [2] });
    const a = await cache.get("https://tnm/products?bbox=-105.1,40.0,-105.0,40.1");
    expect(a.body.items).toEqual([1]);
  });

  test("an entry older than the ttl is a miss, not stale terrain", async () => {
    let now = 1000;
    const cache = listing.createListingCache({ dir: tempDir(), ttlMs: 100, now: () => now });
    await cache.put("u", { items: [] });
    now = 1099;
    expect(await cache.get("u")).not.toBeNull();
    now = 1101;
    expect(await cache.get("u")).toBeNull();
    expect(cache.stats().stale).toBe(1);
  });

  test("a clock that moved backwards expires the entry rather than extending it", async () => {
    // An entry written at a time in the future is not fresh for a fortnight
    // plus the drift; it is unreadable, and the honest answer is to ask again.
    let now = 5000;
    const cache = listing.createListingCache({ dir: tempDir(), now: () => now });
    await cache.put("u", { items: [] });
    now = 4000;
    expect(await cache.get("u")).toBeNull();
  });
});

describe("listing — every failure is a miss", () => {
  test("a half-written entry reads as a miss rather than throwing", async () => {
    const dir = tempDir();
    const cache = listing.createListingCache({ dir: dir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cache.path("u"), '{"format":1,"storedAt":1,"body":{"it');
    expect(await cache.get("u")).toBeNull();
    expect(cache.stats().unreadable).toBe(1);
  });

  test("an entry from another format version is a miss", async () => {
    const dir = tempDir();
    const cache = listing.createListingCache({ dir: dir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cache.path("u"), JSON.stringify({ format: 99, storedAt: Date.now(), body: { items: [] } }));
    expect(await cache.get("u")).toBeNull();
  });

  test("a directory that cannot be written does not fail the request", async () => {
    // Read-only disk, wrong owner, full volume: the cache stops helping. It
    // does not get to stop the answer. A file standing where the directory
    // should be is the portable way to provoke that.
    const blocked = path.join(tempDir(), "not-a-directory");
    fs.writeFileSync(blocked, "");
    const cache = listing.createListingCache({ dir: path.join(blocked, "tnm"), onWriteError: null });
    expect(await cache.put("u", { items: [] })).toBe(false);
    expect(await cache.get("u")).toBeNull();
  });

  test("a directory that cannot be written says so, once, and names itself", async () => {
    // The first deployment of this module wrote nothing for two hours under a
    // unit with ProtectHome=read-only, and looked exactly like one that was
    // working. Silence is what made that expensive; the warning is the fix.
    const blocked = path.join(tempDir(), "not-a-directory");
    fs.writeFileSync(blocked, "");
    const said = [];
    const dir = path.join(blocked, "tnm");
    const cache = listing.createListingCache({ dir: dir, onWriteError: (d) => said.push(d) });

    await cache.put("u1", { items: [] });
    await cache.put("u2", { items: [] });

    expect(said).toHaveLength(1);
    expect(said[0].dir).toBe(dir);
    expect(said[0].error).toEqual(expect.any(String));
    expect(cache.stats().writeFails).toBe(2);
  });

  test("a failed write leaves no temporary file behind for a reader to find", async () => {
    // Half a listing on disk that a later reader mistakes for a whole one is
    // the failure atomic writes exist to prevent; the cleanup is the other half.
    const dir = tempDir();
    const cache = listing.createListingCache({ dir: dir });
    await cache.put("u", { items: [{ title: "t" }] });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([path.basename(cache.path("u"))]);
  });
});

describe("listing — pruning", () => {
  test("the oldest entries go once there are too many", async () => {
    let now = 1000;
    const cache = listing.createListingCache({ dir: tempDir(), maxEntries: 3, now: () => now });
    for (const url of ["a", "b", "c", "d", "e"]) {
      await cache.put(url, { items: [url] });
      now += 1000;
      // mtime has a coarse resolution on some filesystems; make the order real.
      fs.utimesSync(cache.path(url), new Date(now), new Date(now));
    }
    const left = fs.readdirSync(cache.dir).filter((n) => n.endsWith(".json"));
    expect(left).toHaveLength(3);
    expect(await cache.get("a")).toBeNull();
    expect(await cache.get("e")).not.toBeNull();
  });
});

describe("listing — an expired entry, kept for the outage", () => {
  test("expiring does not delete the file, so there is something to fall back to", async () => {
    // The whole degraded mode rests on this: the TTL is when a listing stops
    // being trusted without asking, not when it stops existing.
    let now = 1000;
    const cache = listing.createListingCache({ dir: tempDir(), ttlMs: 100, now: () => now });
    await cache.put("u", { items: [{ title: "t" }] });
    now = 5000;
    expect(await cache.get("u")).toBeNull();
    expect(fs.existsSync(cache.path("u"))).toBe(true);
  });

  test("a retained entry comes back dated and marked stale", async () => {
    let now = 1000;
    const cache = listing.createListingCache({
      dir: tempDir(), ttlMs: 100, retainMs: 10000, now: () => now
    });
    await cache.put("u", { items: [{ title: "t" }] });
    now = 4000;

    const kept = await cache.getRetained("u");
    expect(kept.body.items[0].title).toBe("t");
    expect(kept.storedAt).toBe(1000);
    expect(kept.ageMs).toBe(3000);
    expect(kept.stale).toBe(true);
    expect(cache.stats().retained).toBe(1);
  });

  test("an entry still inside the ttl is retained without being called stale", async () => {
    let now = 1000;
    const cache = listing.createListingCache({ dir: tempDir(), ttlMs: 1000, now: () => now });
    await cache.put("u", { items: [] });
    now = 1500;
    expect((await cache.getRetained("u")).stale).toBe(false);
  });

  test("past the retention window there is nothing to offer", async () => {
    // "We have nothing recent for this box" is the honest answer once a
    // listing is older than about two publishing seasons. Ground chosen from
    // a list nobody has been able to confirm since is not better than none.
    let now = 1000;
    const cache = listing.createListingCache({
      dir: tempDir(), ttlMs: 100, retainMs: 1000, now: () => now
    });
    await cache.put("u", { items: [] });
    now = 2001;
    expect(await cache.getRetained("u")).toBeNull();
  });

  test("a clock that moved backwards is not a retained entry either", async () => {
    let now = 5000;
    const cache = listing.createListingCache({ dir: tempDir(), now: () => now });
    await cache.put("u", { items: [] });
    now = 4000;
    expect(await cache.getRetained("u")).toBeNull();
  });

  test("a half-written entry is not resurrected by the fallback path", async () => {
    const cache = listing.createListingCache({ dir: tempDir() });
    await cache.put("u", { items: [] });
    fs.writeFileSync(cache.path("u"), "{\"format\":1,\"storedAt\":");
    expect(await cache.getRetained("u")).toBeNull();
    expect(await cache.get("u")).toBeNull();
  });

  test("an entry from a future format is not retained", async () => {
    const cache = listing.createListingCache({ dir: tempDir() });
    await cache.put("u", { items: [] });
    fs.writeFileSync(cache.path("u"), JSON.stringify({
      format: listing.FORMAT + 1, url: "u", storedAt: Date.now(), body: { items: [] }
    }));
    expect(await cache.getRetained("u")).toBeNull();
  });
});

describe("listing — the caching reader", () => {
  test("the second ask for the same URL does not reach The National Map", async () => {
    const asked = [];
    const read = listing.cachingJsonReader(async (url) => {
      asked.push(url);
      return { items: [{ title: url }] };
    }, listing.createListingCache({ dir: tempDir() }));

    expect((await read("u1")).items[0].title).toBe("u1");
    expect((await read("u1")).items[0].title).toBe("u1");
    expect(asked).toEqual(["u1"]);
  });

  test("a failure is passed on and never stored", async () => {
    // The whole point. A 503 cached is a permanent refusal over real terrain.
    let calls = 0;
    const cache = listing.createListingCache({ dir: tempDir() });
    const read = listing.cachingJsonReader(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("The National Map answered 503"), { code: "http-error" });
      return { items: [{ title: "now it works" }] };
    }, cache);

    await expect(read("u")).rejects.toThrow(/503/);
    expect(await cache.get("u")).toBeNull();
    expect((await read("u")).items[0].title).toBe("now it works");
  });

  test("two concurrent misses on the same URL ask once", async () => {
    // This matters most when TNM is slow, which is exactly when a second
    // request arrives during the first.
    let calls = 0;
    const read = listing.cachingJsonReader(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { items: [] };
    }, listing.createListingCache({ dir: tempDir() }));

    await Promise.all([read("u"), read("u"), read("u")]);
    expect(calls).toBe(1);
  });

  test("a fetcher that throws in flight is not left blocking the next caller", async () => {
    let calls = 0;
    const read = listing.cachingJsonReader(async () => {
      calls++;
      throw new Error("nope");
    }, listing.createListingCache({ dir: tempDir() }));

    await expect(read("u")).rejects.toThrow("nope");
    await expect(read("u")).rejects.toThrow("nope");
    expect(calls).toBe(2);
  });

  test("a refusal over ground we have seen before serves the kept listing, dated", async () => {
    let now = 1000;
    const cache = listing.createListingCache({
      dir: tempDir(), ttlMs: 100, retainMs: 100000, now: () => now
    });
    let fail = false;
    const read = listing.cachingJsonReader(async () => {
      if (fail) throw new Error("The National Map answered 503");
      return { items: [{ title: "warm" }] };
    }, cache);

    expect((await read("u")).items[0].title).toBe("warm");
    now = 4000;
    fail = true;

    expect((await read("u")).items[0].title).toBe("warm");
    const kept = read.retained();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ url: "u", storedAt: 1000, ageMs: 3000, stale: true });
    expect(kept[0].error).toMatch(/503/);
  });

  test("a refusal over ground nobody has visited is still a refusal", async () => {
    // The fallback must not become "invent terrain during an outage": a cold
    // box has nothing to be stale about.
    const read = listing.cachingJsonReader(async () => {
      throw new Error("The National Map answered 503");
    }, listing.createListingCache({ dir: tempDir() }));

    await expect(read("cold")).rejects.toThrow(/503/);
    expect(read.retained()).toBeNull();
  });

  test("a listing kept past the retention window is not served during an outage", async () => {
    let now = 1000;
    const cache = listing.createListingCache({
      dir: tempDir(), ttlMs: 100, retainMs: 1000, now: () => now
    });
    let fail = false;
    const read = listing.cachingJsonReader(async () => {
      if (fail) throw new Error("The National Map answered 503");
      return { items: [] };
    }, cache);

    await read("u");
    now = 100000;
    fail = true;
    await expect(read("u")).rejects.toThrow(/503/);
    expect(read.retained()).toBeNull();
  });

  test("a successful refresh replaces an expired entry and says nothing is retained", async () => {
    let now = 1000;
    const cache = listing.createListingCache({ dir: tempDir(), ttlMs: 100, now: () => now });
    let title = "old";
    const read = listing.cachingJsonReader(async () => ({ items: [{ title: title }] }), cache);

    await read("u");
    now = 9000;
    title = "new";
    expect((await read("u")).items[0].title).toBe("new");
    expect(read.retained()).toBeNull();
    expect((await cache.get("u")).body.items[0].title).toBe("new");
  });

  test("a reader with nothing to fall back to is refused at construction", () => {
    expect(() => listing.cachingJsonReader(null)).toThrow(/fetchJson/);
  });
});

describe("listing — where entries live", () => {
  test("the directory is configurable and never the system temp by default", () => {
    // A cache in the temp directory is emptied by the reboot or the snapshot
    // that this module exists to survive.
    const saved = process.env.WINDSOLVER_CACHE_DIR;
    process.env.WINDSOLVER_CACHE_DIR = "/var/lib/windsolver";
    expect(listing.defaultDir()).toBe(path.join("/var/lib/windsolver", "tnm"));
    delete process.env.WINDSOLVER_CACHE_DIR;
    expect(listing.defaultDir()).not.toContain(os.tmpdir());
    if (saved === undefined) delete process.env.WINDSOLVER_CACHE_DIR;
    else process.env.WINDSOLVER_CACHE_DIR = saved;
  });
});
