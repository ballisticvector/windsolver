"use strict";

// What the warming tool writes, and where.
//
// This file exists because of a bug it would have caught in one line. The
// stability used to be an argument threaded through `warm()` separately from
// the options, and the call site quietly lost it:
//
//     await warm(loc, opts, dir, !!args.force);      // no stability
//
// So `r` came from `opts` and was correct — the solve really did run at 0.1 —
// while the filename came from an argument nobody passed and defaulted to
// neutral. A stable field was written under the neutral name. Nothing caught
// it until CI's artifact upload went looking for a file that was not there,
// twelve minutes into a solve.
//
// The refusal path had a test and passed. The happy path did not, and that is
// the whole lesson: a test that only proves bad input is rejected proves
// nothing about what good input produces.

const path = require("path");

const mass = require("../mass.js");
const warmTool = require("../tools/warm-location.js");
const cacheKey = require("../tools/basis-cache-key.js");

const ROOT = path.join(__dirname, "..");

describe("options from a command line", () => {
  test("default to neutral, and say so in the options themselves", () => {
    const o = warmTool.optionsFrom({});
    expect(o.stability).toBe("neutral");
    expect(o.r).toBe(mass.DEFAULT_R);
  });

  // The coupling that broke. `r` and the name have to come out of one object,
  // because two sources of truth is exactly how they came to disagree.
  test.each(Object.keys(mass.STABILITY))("carry %s as both an r and a name", (name) => {
    const o = warmTool.optionsFrom({ stability: name });
    expect(o.stability).toBe(name);
    expect(o.r).toBe(mass.STABILITY[name]);
  });

  test("refuse a stability the solver does not have", () => {
    expect(() => warmTool.optionsFrom({ stability: "unstable" })).toThrow(/stability/i);
  });

  test("refuse a stability and a raw r together", () => {
    expect(() => warmTool.optionsFrom({ stability: "stable", r: "0.5" }))
      .toThrow(/not both/i);
  });

  test("a bare --stability with no value is neutral, not the string true", () => {
    const o = warmTool.optionsFrom({ stability: true });
    expect(o.stability).toBe("neutral");
    expect(o.r).toBe(mass.DEFAULT_R);
  });
});

describe("the file a solve will land in", () => {
  test("neutral keeps the bare name, so places already solved stay valid", () => {
    expect(warmTool.pathFor("/d", "whittington", "neutral")).toBe(path.join("/d", "whittington.basis"));
    expect(warmTool.pathFor("/d", "whittington", undefined)).toBe(path.join("/d", "whittington.basis"));
  });

  test("anything else is named after its setting", () => {
    expect(warmTool.pathFor("/d", "whittington", "stable"))
      .toBe(path.join("/d", "whittington.stable.basis"));
  });

  // The test that would have caught the bug, stated as the coupling it is:
  // the name this tool writes must be the name the workflow goes looking for.
  // Those live in two files and are resolved by two different programs — one
  // Node, one GitHub Actions — so nothing else in this repository compares
  // them.
  test("matches the filename the warm workflow expects, for every row", () => {
    // Through `fileFor`, which is what `warm()` actually calls. An earlier
    // version of this test went through `pathFor` instead and passed against
    // the very bug it was written for, because `pathFor` was never the broken
    // part - the decision of what to hand it was.
    for (const row of cacheKey.matrix(ROOT)) {
      const loc = require("../data/locations.json").locations.find((l) => l.id === row.id);
      const opts = warmTool.optionsFrom({ stability: row.stability });
      expect(warmTool.fileFor("data/basis", loc, opts))
        .toBe(path.join("data/basis", row.file));
    }
  });

  test("takes the stability from the options, not from anywhere else", () => {
    const loc = { id: "somewhere" };
    expect(warmTool.fileFor("d", loc, { stability: "stable", r: 0.1 }))
      .toBe(path.join("d", "somewhere.stable.basis"));
    expect(warmTool.fileFor("d", loc, { stability: "neutral", r: 1 }))
      .toBe(path.join("d", "somewhere.basis"));
  });

  test("covers every stability the solver offers, not just the ones in use", () => {
    const rows = cacheKey.matrix(ROOT);
    const seen = new Set(rows.map((r) => r.stability));
    expect(Array.from(seen).sort()).toEqual(Object.keys(mass.STABILITY).sort());
  });
});

describe("which places a command line selects", () => {
  test("--all is every saved place", () => {
    expect(warmTool.chosenFrom({ all: true }).length)
      .toBe(require("../data/locations.json").locations.length);
  });

  test("--location picks exactly one", () => {
    const picked = warmTool.chosenFrom({ location: "whittington" });
    expect(picked.map((l) => l.id)).toEqual(["whittington"]);
  });

  test("an unknown location is refused, and names the ones that exist", () => {
    expect(() => warmTool.chosenFrom({ location: "nowhere" }))
      .toThrow(/no saved location nowhere; have .*whittington/);
  });

  test("neither is refused rather than defaulting to everything", () => {
    // Defaulting to --all here would turn a typo into hours of solving.
    expect(() => warmTool.chosenFrom({})).toThrow(/--location <id> or --all/);
  });
});
