"use strict";

// The warm workflow, graded where it is coupled to code that can move without
// it.
//
// A workflow is only exercised when somebody dispatches it, so a rename that
// breaks the fan-out passes lint, passes every unit suite, and then fails
// several minutes into a run that was supposed to deliver a solved place.
// These are the couplings that would fail that way.
//
// Read as text rather than parsed: the assertions below are about particular
// strings appearing in particular steps, a YAML parser would be a dependency
// added for nothing, and `unit-file.test.js` grades the systemd unit the same
// way for the same reason.

const fs = require("fs");
const path = require("path");

const key = require("../tools/basis-cache-key.js");

const WORKFLOW = path.join(__dirname, "..", ".github", "workflows", "warm-locations.yml");
const text = fs.readFileSync(WORKFLOW, "utf8");

describe("the fan-out", () => {
  test("builds its matrix from the key tool", () => {
    expect(text).toContain("node tools/basis-cache-key.js --matrix");
    expect(text).toContain("fromJSON(needs.plan.outputs.matrix)");
  });

  // The rename guard. `matrix.place.<field>` is resolved by GitHub, not by
  // Node, so nothing else in this repository would notice the day the tool
  // stopped emitting one of these.
  test("only reads fields the tool actually emits", () => {
    const used = new Set(Array.from(text.matchAll(/matrix\.place\.(\w+)/g), (m) => m[1]));
    const emitted = new Set(Object.keys(key.matrix(path.join(__dirname, ".."))[0]));

    expect(used.size).toBeGreaterThan(0);
    for (const field of used) expect(Array.from(emitted)).toContain(field);
  });

  test("keys the cache on the place, not on a hand-written file list", () => {
    expect(text).toContain("key: ${{ matrix.place.key }}");
    // The old key. If this comes back, adding a location re-solves every
    // location again and the fan-out is decoration.
    expect(text).not.toMatch(/sha256sum/);
    expect(text).not.toMatch(/cat data\/locations\.json/);
  });

  // A partial match is a basis solved for other ground or other code, which
  // `basis.load` refuses — so it would be an expensive way to deliver a place
  // that still reports itself cold.
  test("does not fall back to a near-enough cache", () => {
    // The directive, not the word: the workflow explains in a comment why it
    // is absent, and a test that cannot tell those apart would forbid the
    // explanation.
    expect(text).not.toMatch(/^\s*restore-keys:/m);
  });
});

describe("what reaches a shell", () => {
  // A matrix value is text from a JSON file. `basis-cache-key.checkId` refuses
  // an id that is not lowercase letters, digits and hyphens, and this is the
  // other half of that: the id is passed through the environment so that even
  // an id that got past the check is an argument rather than a command.
  test("passes the place id through the environment, not into the script", () => {
    expect(text).toContain('node tools/warm-location.js --location "$PLACE"');
    expect(text).not.toMatch(/--location \$\{\{/);
  });

  test("the ids in the file are ones the key tool accepts", () => {
    for (const l of require("../data/locations.json").locations) {
      expect(() => key.checkId(l.id)).not.toThrow();
    }
  });
});

describe("what it refuses", () => {
  test("refuses to run from anything but main", () => {
    expect(text).toContain("github.ref != 'refs/heads/main'");
    expect(text).toContain("exit 1");
  });

  // Delivering three of four silently is how somebody ends up wondering why
  // one saved place works and another does not.
  test("refuses to deliver a partial set", () => {
    expect(text).toContain("not every place solved");
    expect(text).toContain("MISSING");
  });

  test("uploads nothing when a solve wrote nothing", () => {
    expect(text).toContain("if-no-files-found: error");
  });
});

describe("who holds the deploy key", () => {
  // The solve jobs are CPU on a runner. Only the job that talks to the droplet
  // should be able to reach the droplet's secrets, and only it should sit
  // behind whatever approval the production environment carries.
  test("only the delivering job enters the production environment", () => {
    // Split where a two-space key sits alone on its line, which inside `jobs:`
    // is a job name and nothing else.
    //
    // `\r?` is not decoration. git checks this file out with CRLF on Windows,
    // where a pattern anchored on a bare `\n` matches nothing, finds no jobs at
    // all, and fails on `toBeDefined` — green on a Linux runner and red on a
    // developer's machine, which is the worst place for a test to disagree
    // with itself.
    const jobs = text.split(/\r?\n(?= {2}\w[\w-]*:\r?\n)/);
    const solve = jobs.find((j) => j.startsWith("  solve:"));
    const deliver = jobs.find((j) => j.startsWith("  deliver:"));

    expect(solve).toBeDefined();
    expect(deliver).toBeDefined();
    expect(solve).not.toContain("environment:");
    expect(solve).not.toContain("secrets.DEPLOY_SSH_KEY");
    expect(deliver).toContain("environment:");
    expect(deliver).toContain("secrets.DEPLOY_SSH_KEY");
  });
});

describe("what it does not do", () => {
  // Loading is lazy: a basis is read on the first request for its place, so a
  // file appearing under a running service is picked up without a restart, and
  // restarting would be a minute of downtime bought for nothing.
  test("does not restart the service", () => {
    expect(text).not.toContain("systemctl restart");
  });
});
