"use strict";

// The production unit, graded the way any other configuration is.
//
// These are not style checks. Every one of them is a way the service stays up,
// answers 200, and is quietly wrong — which is the failure mode this file
// exists to catch, and the one it has already had: the unit carried
// ProtectHome=read-only and no cache directory, so the listing cache wrote
// nothing for its whole first deployment while looking exactly like one that
// was working.

const fs = require("fs");
const path = require("path");

const UNIT = path.join(__dirname, "..", "deploy", "windsolver.service");

/**
 * A systemd unit as directives, keeping duplicates.
 *
 * `Environment=` legitimately repeats, so a plain object would silently keep
 * only the last one and a test written against it would pass while reading a
 * unit it had mostly thrown away.
 */
function directives(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
  }
  return out;
}

function valuesOf(lines, key) {
  return lines.filter((l) => l.key === key).map((l) => l.value);
}

function environment(lines) {
  const env = {};
  for (const value of valuesOf(lines, "Environment")) {
    const eq = value.indexOf("=");
    if (eq > 0) env[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return env;
}

const text = fs.readFileSync(UNIT, "utf8");
const lines = directives(text);
const env = environment(lines);

describe("the production unit — the cache has somewhere to go", () => {
  test("hardening that closes the default cache path names another one", () => {
    // ProtectHome= and DynamicUser= both make ~/.cache unwritable. Either one
    // without an explicit directory is a cache that does nothing, forever, and
    // says so only in one stderr line nobody is watching for.
    const closesHome = valuesOf(lines, "ProtectHome").length > 0
      || valuesOf(lines, "DynamicUser").some((v) => /^(yes|true|1|on)$/i.test(v));
    if (!closesHome) return;
    expect(env.WINDSOLVER_CACHE_DIR).toBeDefined();
    expect(env.WINDSOLVER_CACHE_DIR.startsWith("/home/")).toBe(false);
  });

  test("the directory named is one systemd creates and owns", () => {
    // Naming a path the service user cannot create is the same bug wearing a
    // different hat: CacheDirectory= is what makes /var/cache/windsolver exist
    // with the right owner before ExecStart runs.
    if (!env.WINDSOLVER_CACHE_DIR) return;
    const managed = valuesOf(lines, "CacheDirectory").map((n) => "/var/cache/" + n)
      .concat(valuesOf(lines, "StateDirectory").map((n) => "/var/lib/" + n));
    expect(managed).toContain(env.WINDSOLVER_CACHE_DIR);
  });

  test("ProtectSystem is not so strict that /var/cache is read-only", () => {
    // full and yes both leave /var writable; strict does not, and would undo
    // CacheDirectory= above while every other line still looked right.
    for (const value of valuesOf(lines, "ProtectSystem")) {
      expect(value).not.toBe("strict");
    }
  });
});

describe("the production unit — it starts the tree the deploy unpacks", () => {
  test("ExecStart runs a file inside WorkingDirectory", () => {
    const workdir = valuesOf(lines, "WorkingDirectory")[0];
    const exec = valuesOf(lines, "ExecStart")[0];
    expect(workdir).toBeDefined();
    expect(exec).toContain(workdir + "/");
  });

  test("the entrypoint it names is one this repository ships", () => {
    // The deploy checks the tarball for tools/serve.js. This checks the unit
    // asks for the same file, so the two cannot drift apart into a clean
    // restart onto a path that does not exist.
    const exec = valuesOf(lines, "ExecStart")[0];
    const workdir = valuesOf(lines, "WorkingDirectory")[0];
    const script = exec.slice(exec.indexOf(workdir) + workdir.length + 1);
    expect(fs.existsSync(path.join(__dirname, "..", script))).toBe(true);
  });

  test("it is wanted by a target, or a reboot leaves the site down", () => {
    expect(valuesOf(lines, "WantedBy")).toContain("multi-user.target");
  });
});

describe("the production unit — what it is allowed to reach", () => {
  test("the browser origins are https and include the site itself", () => {
    const origins = (env.WINDSOLVER_ORIGINS || "").split(",").filter(Boolean);
    expect(origins).toContain("https://windsolver.com");
    for (const origin of origins) expect(origin.startsWith("https://")).toBe(true);
  });

  test("it listens on loopback, behind nginx rather than beside it", () => {
    expect(env.HOST).toBe("127.0.0.1");
  });

  test("the places kept warm parse as places", () => {
    // A typo here is not an error; prewarm skips what it cannot read and the
    // demo is cold with nothing in the log to say why.
    const prewarm = require("../prewarm.js");
    const places = prewarm.parsePlaces(env.WINDSOLVER_PREWARM || "");
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) {
      expect(Math.abs(place.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(place.lon)).toBeLessThanOrEqual(180);
    }
  });
});
