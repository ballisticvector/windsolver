"use strict";

// What a stored basis is an answer to, split into the part that is one place
// and the part that is all of them.
//
// The workflow this serves used to hash `locations.json mass.js basis.js
// server.js` into one key for every place at once, which had three faults and
// each of them is a test below:
//
//   - adding a place re-solved every other place, because the file changed;
//   - editing a `note` re-solved every place, because the file changed;
//   - changing `field.js` re-solved nothing, because it was not in the list —
//     and `field.coarsen` decides the grid the solve runs on, so a stale basis
//     would have been delivered as a fresh one.
//
// The third is the one that matters. The first two cost CPU; that one ships a
// wind field that is an answer to ground nobody asked about.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const key = require("../tools/basis-cache-key.js");

const ROOT = path.join(__dirname, "..");

/** A throwaway tree, so the closure walker can be tested on known files. */
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wskey-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

describe("the closure of a require graph", () => {
  test("follows local requires transitively and keeps the entry point", () => {
    const dir = tree({
      "a.js": 'const b = require("./b.js"); module.exports = b;',
      "b.js": 'const c = require("./sub/c.js"); module.exports = c;',
      "sub/c.js": "module.exports = 1;",
      "unrelated.js": "module.exports = 2;"
    });
    expect(key.closure(dir, ["a.js"])).toEqual(["a.js", "b.js", "sub/c.js"]);
  });

  test("skips builtins and node_modules, which package-lock.json covers", () => {
    const dir = tree({
      "a.js": 'require("fs"); require("node:path"); require("express"); module.exports = 1;'
    });
    expect(key.closure(dir, ["a.js"])).toEqual(["a.js"]);
  });

  // The crux. `locations.json` is required by the warming tool, and if it were
  // hashed as code then every place would share one key again and this whole
  // change would be undone by a file that is data.
  test("does not follow a required .json file", () => {
    const dir = tree({
      "a.js": 'const d = require("./data/places.json"); module.exports = d;',
      "data/places.json": '{"locations":[]}'
    });
    expect(key.closure(dir, ["a.js"])).toEqual(["a.js"]);
  });

  test("merges two entry points without listing a shared file twice", () => {
    const dir = tree({
      "a.js": 'require("./shared.js");',
      "b.js": 'require("./shared.js");',
      "shared.js": "module.exports = 1;"
    });
    expect(key.closure(dir, ["a.js", "b.js"])).toEqual(["a.js", "b.js", "shared.js"]);
  });

  test("survives a cycle", () => {
    const dir = tree({
      "a.js": 'require("./b.js");',
      "b.js": 'require("./a.js");'
    });
    expect(key.closure(dir, ["a.js"])).toEqual(["a.js", "b.js"]);
  });

  // A require this cannot read is a file this cannot hash, and a file it
  // cannot hash is a change it would miss. Refused rather than skipped: the
  // whole value of the key is that it moves when the answer moves.
  test("refuses a require whose argument is not a string literal", () => {
    const dir = tree({
      "a.js": 'const n = "b"; module.exports = require("./" + n + ".js");'
    });
    expect(() => key.closure(dir, ["a.js"])).toThrow(/not a string literal/i);
  });

  test("refuses a local require that resolves to nothing", () => {
    const dir = tree({ "a.js": 'require("./gone.js");' });
    expect(() => key.closure(dir, ["a.js"])).toThrow(/gone\.js/);
  });
});

describe("the code half of the key", () => {
  const FLAT = [];

  /** A package-lock skeleton with the entries a test cares about. */
  function lock(packages) {
    return JSON.stringify({
      lockfileVersion: 3,
      packages: Object.assign({ "": { name: "x", version: "1.0.0" } }, packages)
    });
  }

  test("covers the modules a solve actually runs through", () => {
    const files = key.hashedFiles(ROOT);
    // The solver, the file format, the terrain read and the spacing. field.js
    // is the one the old key left out; server.js is the one that reads a basis
    // back and can decide to refuse it.
    for (const name of ["mass.js", "basis.js", "field.js", "derive.js",
      "proj.js", "cog.js", "tools/warm-location.js", "server.js"]) {
      expect(files).toContain(name);
    }
  });

  test("does not cover the locations themselves", () => {
    expect(key.hashedFiles(ROOT)).not.toContain("data/locations.json");
  });

  // The precision that makes this worth doing at all. None of these can appear
  // in a file holding an elevation grid and two flux fields, and following
  // server.js into them would mean rotating an API key costs every solve.
  test("does not follow server.js into the weather and auth paths", () => {
    const files = key.hashedFiles(ROOT);
    for (const name of ["auth.js", "fems.js", "stations.js", "hillshade.js",
      "png.js", "slice.js", "profile.js"]) {
      expect(files).not.toContain(name);
    }
  });

  test("hashes a flat file without following its requires", () => {
    const dir = tree({
      "a.js": "module.exports = 1;",
      "flat.js": 'require("./never-written.js");',
      "package.json": "{}",
      "package-lock.json": "{}"
    });
    // Followed, this would throw on the missing file. Hashed, it is bytes.
    const before = key.codeHash(dir, ["a.js"], ["flat.js"]);
    fs.writeFileSync(path.join(dir, "flat.js"), 'require("./still-never.js");');
    expect(key.codeHash(dir, ["a.js"], ["flat.js"])).not.toBe(before);
  });

  test("moves when a file in the closure moves", () => {
    const dir = tree({
      "a.js": 'require("./b.js");',
      "b.js": "module.exports = 1;",
      "package.json": "{}",
      "package-lock.json": "{}"
    });
    const before = key.codeHash(dir, ["a.js"], FLAT);
    fs.writeFileSync(path.join(dir, "b.js"), "module.exports = 2;");
    expect(key.codeHash(dir, ["a.js"], FLAT)).not.toBe(before);
  });

  // A dependency can change the terrain read without a line of this repo
  // changing, so what is installed is part of the answer.
  test("moves when an installed package changes version", () => {
    const dir = tree({
      "a.js": "module.exports = 1;",
      "package.json": '{"dependencies":{"geotiff":"^2.0.0"}}',
      "package-lock.json": lock({ "node_modules/geotiff": { version: "2.0.0" } })
    });
    const before = key.codeHash(dir, ["a.js"], FLAT);
    fs.writeFileSync(path.join(dir, "package-lock.json"),
      lock({ "node_modules/geotiff": { version: "2.1.0" } }));
    expect(key.codeHash(dir, ["a.js"], FLAT)).not.toBe(before);
  });

  test("moves when a package keeps its version and changes its tarball", () => {
    const dir = tree({
      "a.js": "module.exports = 1;",
      "package.json": '{"dependencies":{"geotiff":"^2.0.0"}}',
      "package-lock.json": lock({
        "node_modules/geotiff": { version: "2.0.0", integrity: "sha512-aaa" }
      })
    });
    const before = key.codeHash(dir, ["a.js"], FLAT);
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock({
      "node_modules/geotiff": { version: "2.0.0", integrity: "sha512-bbb" }
    }));
    expect(key.codeHash(dir, ["a.js"], FLAT)).not.toBe(before);
  });

  // The reason the lockfile is not simply hashed whole. This package declares
  // no production dependencies at all, so `npm ci --omit=dev` installs nothing
  // and a jest bump has no way to reach a wind field - but it rewrites the
  // lockfile, and under a whole-file hash it would have re-solved every place.
  test("does not move when a devDependency moves", () => {
    const dir = tree({
      "a.js": "module.exports = 1;",
      "package.json": '{"devDependencies":{"jest":"^30.0.0"}}',
      "package-lock.json": lock({
        "node_modules/jest": { version: "30.4.2", dev: true }
      })
    });
    const before = key.codeHash(dir, ["a.js"], FLAT);
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock({
      "node_modules/jest": { version: "30.9.9", dev: true }
    }));
    expect(key.codeHash(dir, ["a.js"], FLAT)).toBe(before);
  });

  test("the real package declares no production dependencies", () => {
    // If this ever fails it is not a bug, it is news: something the solve runs
    // through is now installed rather than written here, and the sentence in
    // dependencyFingerprint about npm installing nothing has stopped being
    // true.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies || {}).toEqual({});
  });

  test("does not move when a file outside the closure moves", () => {
    const dir = tree({
      "a.js": "module.exports = 1;",
      "elsewhere.js": "module.exports = 1;",
      "package.json": "{}",
      "package-lock.json": "{}"
    });
    const before = key.codeHash(dir, ["a.js"], FLAT);
    fs.writeFileSync(path.join(dir, "elsewhere.js"), "module.exports = 999;");
    expect(key.codeHash(dir, ["a.js"], FLAT)).toBe(before);
  });
});

describe("the place half of the key", () => {
  const place = { id: "x", name: "X", lat: 45.3, lon: -116.3, radiusMiles: 3, resolutionM: 32 };

  test("ignores everything that is prose", () => {
    const before = key.locationHash(place);
    expect(key.locationHash(Object.assign({}, place, {
      name: "Renamed", region: "Somewhere", note: "a much longer explanation"
    }))).toBe(before);
  });

  test.each([
    ["lat", { lat: 45.4 }],
    ["lon", { lon: -116.4 }],
    ["radiusMiles", { radiusMiles: 4 }],
    ["resolutionM", { resolutionM: 64 }]
  ])("moves when %s moves", (_name, change) => {
    expect(key.locationHash(Object.assign({}, place, change)))
      .not.toBe(key.locationHash(place));
  });

  // An absent resolution means "whatever the reader picks", which is not the
  // same question as 32 m, and `basis.keyFor` writes it into the stored file
  // as `resauto`. The cache key has to make the same distinction or a file
  // solved one way is fetched for the other and then refused at load.
  test("distinguishes an absent resolution from a stated one", () => {
    const auto = Object.assign({}, place);
    delete auto.resolutionM;
    expect(key.locationHash(auto)).not.toBe(key.locationHash(place));
  });

  test("does not depend on the order the fields were written in", () => {
    const reordered = { resolutionM: 32, radiusMiles: 3, lon: -116.3, lat: 45.3, id: "x" };
    expect(key.locationHash(reordered)).toBe(key.locationHash(place));
  });
});

describe("the matrix the workflow fans out over", () => {
  const locations = require("../data/locations.json").locations;

  const mass = require("../mass.js");
  const settings = Object.keys(mass.STABILITY);

  // One row per place *and* setting. `r` is inside the operator being inverted,
  // so a stability cannot be recovered from a solved basis the way a speed or a
  // bearing can - it is a separate solve, a separate file and a separate row.
  test("is one entry per saved place per stability", () => {
    const m = key.matrix(ROOT);
    expect(m).toHaveLength(locations.length * settings.length);
    for (const l of locations) {
      const mine = m.filter((e) => e.id === l.id);
      expect(mine.map((e) => e.stability).sort()).toEqual(settings.slice().sort());
    }
    for (const entry of m) {
      expect(entry.key).toMatch(/^basis-v3-[a-z0-9-]+-[a-z]+-[0-9a-f]{16}-[0-9a-f]{16}$/);
    }
  });

  test("names the file each row will produce, neutral keeping the bare name", () => {
    for (const entry of key.matrix(ROOT)) {
      expect(entry.file).toBe(entry.stability === "neutral"
        ? entry.id + ".basis"
        : entry.id + "." + entry.stability + ".basis");
    }
  });

  // The two settings over one place are two different fields. If they shared a
  // key, warming one would satisfy the cache for the other and the service
  // would serve a neutral field to somebody who asked for stable.
  test("gives one place's two settings different keys", () => {
    const m = key.matrix(ROOT);
    for (const l of locations) {
      const keys = m.filter((e) => e.id === l.id).map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test("refuses a stability the solver does not have", () => {
    expect(() => key.keyFor(locations[0], "abc123", "unstable")).toThrow(/stability/i);
  });

  // A matrix value is handed to a shell step as an argument and becomes a
  // filename on the droplet. An id that is neither is refused at the point the
  // key is built, which is before anything has been solved.
  test.each([
    ["a traversal", "../../etc/passwd"],
    ["a command", "x; rm -rf /"],
    ["a space", "hat creek"],
    ["a capital", "HatCreek"],
    ["an empty string", ""],
    ["a leading hyphen", "-force"]
  ])("refuses %s as an id", (_name, id) => {
    expect(() => key.keyFor({ id: id, lat: 1, lon: 2, radiusMiles: 3 }, "abc"))
      .toThrow(/not lowercase/);
  });

  test("accepts the ids actually in the file", () => {
    for (const l of locations) expect(key.checkId(l.id)).toBe(l.id);
  });

  test("gives no two places the same key", () => {
    const keys = key.matrix(ROOT).map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The reason this file exists. Hat Creek cost four solves to add under the
  // old key; under this one it costs one.
  test("leaves every other place's key alone when a place is added", () => {
    const before = key.matrix(ROOT);
    const code = key.codeHash(ROOT);
    const added = locations.concat([{
      id: "somewhere-new", lat: 1, lon: 2, radiusMiles: 3, resolutionM: 32
    }]);
    const after = [];
    for (const l of added) {
      for (const stability of settings) {
        after.push({ id: l.id, stability: stability, key: key.keyFor(l, code, stability) });
      }
    }

    for (const entry of before) {
      const same = after.find((e) => e.id === entry.id && e.stability === entry.stability);
      expect(same.key).toBe(entry.key);
    }
    expect(after).toHaveLength(before.length + settings.length);
  });

  test("is JSON that GitHub Actions can fan out over", () => {
    const text = key.matrixJson(ROOT);
    expect(text).not.toContain("\n");
    const parsed = JSON.parse(text);
    expect(parsed[0]).toEqual(expect.objectContaining({
      id: expect.any(String), key: expect.any(String)
    }));
  });
});

describe("the key as a whole", () => {
  test("is a sha256 of the files, not of their names", () => {
    const dir = tree({
      "a.js": "module.exports = 1;",
      "package.json": "{}",
      "package-lock.json": "{}"
    });
    const expected = crypto.createHash("sha256");
    expected.update("a.js\n" + crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(dir, "a.js"))).digest("hex") + "\n");
    expected.update("npm:production\n" + key.dependencyFingerprint(dir) + "\n");
    expect(key.codeHash(dir, ["a.js"], [])).toBe(expected.digest("hex").slice(0, 16));
  });

  test("reads the same on Windows as on the runner", () => {
    // Paths go into the hash, so a backslash would give a developer's machine
    // a different key from CI and every cache would miss for everybody.
    for (const f of key.hashedFiles(ROOT)) expect(f).not.toContain("\\");
  });
});
