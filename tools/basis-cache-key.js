#!/usr/bin/env node
/**
 * What a stored basis is an answer to, as a cache key per place.
 *
 *   node tools/basis-cache-key.js --matrix      one JSON line: [{id, key}, ...]
 *   node tools/basis-cache-key.js --code        the code half, on its own
 *   node tools/basis-cache-key.js --location whittington
 *
 * A basis is an answer to two questions that move independently: **which
 * ground**, which is one place, and **which code read and solved it**, which is
 * all of them. The key is therefore in two halves, and that split is the whole
 * point of this file.
 *
 * The warm workflow used to hash `locations.json mass.js basis.js server.js`
 * into a single key shared by every place. Three things were wrong with it:
 *
 *   - **Adding a place re-solved every place.** The file changed, so the key
 *     changed, so four places were solved to add one. Hat Creek cost about
 *     forty minutes of runner to add ten lines of JSON.
 *   - **Editing prose re-solved every place.** A `note` is a paragraph of
 *     explanation. It has never changed a wind field.
 *   - **`field.js` was not in the list, and it decides the grid.**
 *     `field.coarsen` chooses what resolution the terrain is actually read at;
 *     change it and every stored basis is an answer to different ground while
 *     the key sits still. That one does not cost CPU, it ships a wrong field.
 *
 * So: the place half hashes only the fields that shape a solve, and the code
 * half hashes the require-closure of the tool that does the solving — which
 * picks up `field.js` because `warm-location.js` genuinely requires it, and
 * would pick up anything else that came to matter without anyone remembering to
 * add it to a list. `server.js` is hashed alongside it without being followed,
 * and the production dependency tree is fingerprinted separately; see
 * `HASHED_NOT_FOLLOWED` and `dependencyFingerprint` for why neither of those is
 * an oversight.
 *
 * On the scan: this does not parse JavaScript. It finds `require(` and demands
 * a plain string literal after it, refusing anything else. That is safe in the
 * direction that matters — a `require` written inside a comment would hash one
 * file too many, which costs a cache miss, while a `require` it could not read
 * would hash one too few, which is the failure that ships a stale field. The
 * refusal is what keeps it in the safe direction: the day somebody writes a
 * computed require, this stops rather than quietly missing it.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const nodePath = require("path");

const mass = require("../mass.js");

const ROOT = nodePath.join(__dirname, "..");

/**
 * The solve, followed all the way down.
 *
 * `warm-location.js` pulls in the terrain read, the mesh, the solver and the
 * file format, and it holds the mesh options the solve runs with, so its
 * closure is the code that decides what a basis contains.
 *
 * It is coarser than the solve strictly needs, and worth saying so rather than
 * claiming otherwise: `field.js` requires the HRRR and GRIB2 modules at the top
 * of the file even though `groundOnly` never calls them, so a change to the
 * weather path still invalidates a terrain solve. Fixing that means splitting
 * `field.js`, not adjusting this. Over-inclusion costs a re-solve; the other
 * direction ships a stale field.
 */
const SOLVE_ENTRY_POINTS = ["tools/warm-location.js"];

/**
 * Hashed, but deliberately not followed.
 *
 * `server.js` recomputes the expected key from its own `MASS_LAYERS` and
 * `MASS_STRETCH`, so a change there can make it refuse every file on the box
 * and the key has to move with it. Its *dependencies* are another matter: they
 * are the weather clients, the hillshade renderer and the API-key check, none
 * of which can appear in a file that holds an elevation grid and two flux
 * fields. Following them would mean a key rotation in `auth.js` invalidating
 * forty minutes of solves for nothing.
 */
const HASHED_NOT_FOLLOWED = ["server.js"];

/**
 * The fields of a saved location that change the field that comes back.
 *
 * Everything else in a location - `name`, `region`, `note` - is for a human
 * reading the file, and re-solving because a sentence was rewritten is pure
 * waste. These four are exactly what `warm-location.specFor` puts into the
 * spec, which is what `basis.keyFor` then writes into the stored file.
 */
const SOLVE_FIELDS = ["lat", "lon", "radiusMiles", "resolutionM"];

const KEY_PREFIX = "basis-v3";
const HASH_CHARS = 16;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Repo-relative and posix, because the key must read the same on Windows. */
function relative(root, full) {
  return nodePath.relative(root, full).split(nodePath.sep).join("/");
}

/**
 * The local file a `require` names, or null if it names something external.
 *
 * A bare specifier is a builtin or a package: neither is hashed here, because
 * the first cannot change without the Node version and the second is covered by
 * `dependencyFingerprint` instead. A `.json` is data, not code — and it
 * is `data/locations.json` in particular, which is the file this whole split
 * exists to keep out of the code half.
 */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  if (spec.endsWith(".json")) return null;

  const base = nodePath.resolve(nodePath.dirname(fromFile), spec);
  for (const candidate of [base, base + ".js", nodePath.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error("cannot resolve require(\"" + spec + "\") from " + fromFile +
    "; the cache key would silently not cover it");
}

/** Every `require(` in a source, as its literal argument. Refuses the rest. */
function requiresIn(file, source) {
  const out = [];
  const call = /require\s*\(/g;
  let match;
  while ((match = call.exec(source)) !== null) {
    const rest = source.slice(match.index + match[0].length);
    const literal = /^\s*(["'])((?:[^"'\n\\]|\\.)*)\1\s*\)/.exec(rest);
    if (!literal) {
      const line = source.slice(0, match.index).split("\n").length;
      throw new Error(file + ":" + line + ": require() argument is not a string literal, " +
        "so this cannot tell which file it names; the cache key would be blind to it");
    }
    out.push(literal[2]);
  }
  return out;
}

/**
 * Every local file reachable from `entries`, sorted, repo-relative.
 *
 * Sorted rather than in traversal order so the hash does not depend on which
 * entry point happened to be listed first.
 */
function closure(root, entries) {
  const seen = new Set();
  const queue = (entries || SOLVE_ENTRY_POINTS).map(function (e) {
    const full = nodePath.resolve(root, e);
    if (!fs.existsSync(full)) throw new Error("no entry point " + e + " under " + root);
    return full;
  });

  while (queue.length) {
    const file = queue.shift();
    const rel = relative(root, file);
    if (seen.has(rel)) continue;
    seen.add(rel);

    const source = fs.readFileSync(file, "utf8");
    for (const spec of requiresIn(rel, source)) {
      const target = resolveLocal(file, spec);
      if (target && !seen.has(relative(root, target))) queue.push(target);
    }
  }
  return Array.from(seen).sort();
}

/**
 * The installed packages a solve could actually run through.
 *
 * A dependency can change the terrain read without a line of this repository
 * changing, so it belongs in the key — but only the *production* ones do. This
 * package declares no `dependencies` at all today and `npm ci --omit=dev` on
 * the runner installs nothing, so hashing `package-lock.json` whole would mean
 * a routine `eslint` or `jest` bump re-solving every saved place to install a
 * tree the solve never loads. The lockfile marks dev-only packages, so read
 * past them.
 *
 * `resolved` and `integrity` are in here beside the version because a version
 * that stayed still while its tarball moved is a different dependency.
 */
function dependencyFingerprint(root) {
  const at = root || ROOT;
  const read = function (name) {
    const full = nodePath.join(at, name);
    if (!fs.existsSync(full)) throw new Error("missing " + name + ", which is part of the key");
    return JSON.parse(fs.readFileSync(full, "utf8"));
  };

  const pkg = read("package.json");
  const lock = read("package-lock.json");

  const installed = [];
  for (const [where, entry] of Object.entries(lock.packages || {})) {
    if (where === "") continue;                      // the project itself
    if (entry.dev || entry.devOptional) continue;    // not installed by --omit=dev
    installed.push([where, entry.version || null, entry.resolved || null,
      entry.integrity || null]);
  }
  installed.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });

  return sha256(JSON.stringify([pkg.dependencies || {}, installed]));
}

/** Everything the code half is a hash of: the closure, plus the flat files. */
function hashedFiles(root, entries, also) {
  const followed = closure(root || ROOT, entries || SOLVE_ENTRY_POINTS);
  return Array.from(new Set(
    followed.concat(also === undefined ? HASHED_NOT_FOLLOWED : also))).sort();
}

/**
 * The code half, hashed by name and content.
 *
 * The name is in the hash as well as the content so that moving a file to a new
 * path registers as a change even when nothing inside it did.
 */
function codeHash(root, entries, also) {
  const hash = crypto.createHash("sha256");
  for (const rel of hashedFiles(root, entries, also)) {
    const full = nodePath.resolve(root || ROOT, rel);
    if (!fs.existsSync(full)) throw new Error("missing " + rel + ", which is part of the key");
    hash.update(rel + "\n" + sha256(fs.readFileSync(full)) + "\n");
  }
  hash.update("npm:production\n" + dependencyFingerprint(root) + "\n");
  return hash.digest("hex").slice(0, HASH_CHARS);
}

/**
 * The place half: the four numbers that shape a solve, in a fixed order.
 *
 * Written as an array rather than an object so the hash cannot depend on the
 * order the keys were typed in, and `null` for an absent resolution so that
 * "read it at whatever the pyramid gives" stays a different question from
 * "read it at 32 m" — which is the distinction `basis.keyFor` makes as
 * `resauto`, and which would otherwise fetch a cached file the loader then
 * refuses.
 */
function locationHash(loc) {
  const shape = SOLVE_FIELDS.map(function (f) {
    return loc[f] === undefined ? null : Number(loc[f]);
  });
  return sha256(JSON.stringify(shape)).slice(0, HASH_CHARS);
}

/**
 * An id safe to be a filename and a cache key, and refused if it is not.
 *
 * This ends up as `data/basis/<id>.basis`, as a GitHub cache key, and as a
 * matrix value that a workflow step then passes to a shell. A `..` or a space
 * or a quote in it is at best a confusing failure and at worst a command; the
 * file is only ever edited by hand, so refusing is free.
 */
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function checkId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error("location id " + JSON.stringify(id) + " is not lowercase " +
      "letters, digits and single hyphens; it becomes a filename, a cache key " +
      "and a shell argument");
  }
  return id;
}

function keyFor(loc, code, stability) {
  const name = stability === undefined ? "neutral" : stability;
  mass.rFor(name);   // refuses a name the solver does not have
  return [KEY_PREFIX, checkId(loc.id), name, locationHash(loc), code].join("-");
}

/**
 * Every place, at every stability, because each is its own solve.
 *
 * `r` sits inside the operator being inverted, so unlike speed and bearing it
 * cannot be recovered from a basis by scaling one. Two settings means two
 * solves and two files - and two rows here, so the fan-out gives each its own
 * runner and its own cache entry.
 */
/**
 * The settings a place offers, which is not always every setting there is.
 *
 * A stability is a whole extra solve, and on a big domain that is hours. The
 * re-centred Whittington box is 604 x 604 at 16 m: its neutral solve took 89
 * minutes and its stable solve was cancelled twice without ever finishing. One
 * row nobody has seen complete should not hold back five that are solved and
 * sitting in the cache, because delivery is all-or-nothing by design.
 *
 * So a place may name the settings it offers and gain the others later. Absent,
 * a place offers all of them, which keeps the small domains honest without
 * anyone having to list anything.
 */
function stabilitiesOf(loc) {
  const all = Object.keys(mass.STABILITY);
  if (!Array.isArray(loc.stabilities)) return all;
  if (!loc.stabilities.length) {
    throw new Error(loc.id + " lists no stabilities; a place with no settings " +
      "cannot be solved at all. Remove the key to offer all of them.");
  }
  for (const name of loc.stabilities) mass.rFor(name);   // refuses an unknown one
  if (loc.stabilities.indexOf("neutral") < 0) {
    throw new Error(loc.id + " does not offer neutral, which is the setting a " +
      "caller gets when it asks for nothing");
  }
  return all.filter(function (name) { return loc.stabilities.indexOf(name) >= 0; });
}

function matrix(root) {
  const at = root || ROOT;
  const locations = JSON.parse(
    fs.readFileSync(nodePath.join(at, "data", "locations.json"), "utf8")).locations;
  const code = codeHash(at);
  const out = [];
  for (const l of locations) {
    for (const stability of stabilitiesOf(l)) {
      out.push({
        id: l.id,
        stability: stability,
        file: stability === "neutral" ? l.id + ".basis" : l.id + "." + stability + ".basis",
        key: keyFor(l, code, stability)
      });
    }
  }
  return out;
}

/** One line, because it is read back by `fromJSON` in a workflow expression. */
function matrixJson(root) {
  return JSON.stringify(matrix(root));
}

function main(argv) {
  if (argv.includes("--matrix")) return matrixJson(ROOT);
  if (argv.includes("--code")) return codeHash(ROOT);

  const at = argv.indexOf("--location");
  if (at >= 0 && argv[at + 1]) {
    const id = argv[at + 1];
    const wantAt = argv.indexOf("--stability");
    const want = wantAt >= 0 && argv[wantAt + 1] ? argv[wantAt + 1] : "neutral";
    const entry = matrix(ROOT).find(function (e) {
      return e.id === id && e.stability === want;
    });
    if (!entry) throw new Error("no saved location " + id + " at " + want);
    return entry.key;
  }

  if (argv.includes("--files")) return hashedFiles(ROOT).join("\n");

  throw new Error("give --matrix, --code, --files or --location <id>");
}

if (require.main === module) {
  try {
    process.stdout.write(main(process.argv.slice(2)) + "\n");
  } catch (err) {
    process.stderr.write((err && err.message ? err.message : String(err)) + "\n");
    process.exitCode = 1;
  }
}

module.exports = {
  SOLVE_ENTRY_POINTS,
  HASHED_NOT_FOLLOWED,
  SOLVE_FIELDS,
  KEY_PREFIX,
  SAFE_ID,
  checkId,
  stabilitiesOf,
  closure,
  requiresIn,
  hashedFiles,
  dependencyFingerprint,
  codeHash,
  locationHash,
  keyFor,
  matrix,
  matrixJson
};
